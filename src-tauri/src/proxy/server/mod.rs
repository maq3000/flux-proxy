use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::Bytes;
use chrono::Utc;
use dashmap::DashMap;
use http::header::CONTENT_TYPE;
use http::{Request, Response, StatusCode, Version};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as AutoConnBuilder;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, watch, Mutex};

use crate::models::{
    BindHostMode, BreakpointAction, HeaderPair, PausedBreakpointItem, ProxyError, ProxyStatus,
    SessionDetail, SessionSummary, SessionTimings, SessionTransferStats, StorageStats,
    UpstreamProxyConfig, WebSocketFrameRecord, WsInjectDirection, WsInjectOpcode,
};
use crate::proxy::breakpoints::{BreakpointEngine, PendingBreakpointGuard};
use crate::proxy::ca::CertificateAuthority;
use crate::proxy::client_certs::ClientCertificateStore;
use crate::proxy::filters::ProxyFilterEngine;
use crate::proxy::hosts::HostRemapRegistry;
use crate::proxy::network::normalize_client_ip;
use crate::proxy::process::{resolve_client_process_async, ClientProcessInfo};
use crate::proxy::rules::RuleEngine;
use crate::proxy::sysproxy::{resolve_sysproxy_host_for_bind, SystemProxyManager};
use crate::proxy::throttle::ThrottleEngine;
use crate::proxy::upstream_client::{format_rfc3339_micros, UpstreamHttpClient};
use crate::proxy::upstream_proxy::UpstreamProxyManager;
use crate::scripting::PythonScriptRunner;
use crate::storage::{TrafficStore, BODY_OFFLOAD_THRESHOLD_BYTES};


const MAX_CAPTURED_BODY_BYTES: usize = 64 * 1024 * 1024; // 64 MiB safety cap per body (> 2 MiB offloaded to SQLite)
pub const MAX_CAPTURED_REQUEST_BODY_BYTES: usize = MAX_CAPTURED_BODY_BYTES;
pub const MAX_BUFFERED_RESPONSE_BODY_BYTES: usize = 64 * 1024 * 1024; // 64 MiB OOM cap for buffered responses
const ZSTD_SPAWN_BLOCKING_THRESHOLD_BYTES: usize = 256 * 1024; // 256 KiB
const STREAM_TEXT_PREVIEW_MAX_BYTES: usize = 64 * 1024; // 64 KiB cap for text/* or application/* large-stream previews
#[cfg(test)]
const DEFAULT_UPSTREAM_TIMEOUT_SEC: u64 = crate::models::DEFAULT_CONNECT_TIMEOUT_SEC;
pub(super) const FLUXPROXY_ERROR_HEADER: &str = "X-FluxProxy-Error";
pub(super) const FLUXPROXY_ERR_UPSTREAM_CONNECT_TIMEOUT: &str = "upstream-connect-timeout";
pub(super) const FLUXPROXY_ERR_UPSTREAM_CONNECT_ERROR: &str = "upstream-connect-error";
pub(super) const FLUXPROXY_ERR_CLIENT_CLOSED_REQUEST: &str = "client-closed-request";
pub(super) const FLUXPROXY_ERR_COMPOSER_CANCELLED: &str = "composer-cancelled";
pub(super) const FLUXPROXY_ERR_FORBIDDEN_REMOTE_TARGET: &str = "forbidden-remote-target";
const MAX_CONTENT_ENCODING_LAYERS: usize = 4;
type ProxyBoxBody = BoxBody<Bytes, Infallible>;

static NEXT_CLIENT_CONN_ID: AtomicU64 = AtomicU64::new(1);

/// Tracks client TCP / MITM-TLS connection identity, keep-alive sequence, and negotiated TLS info.
pub(super) const GRACEFUL_DRAIN_DEADLINE: Duration = Duration::from_secs(30);

/// Tracks two-tier proxy connection lifecycle (`CONC-01`, `ADR-02`):
/// - `drain_rx`: Graceful Drain deadline (stop accepting new requests, suppress TrafficStore capture,
///   send HTTP/2 GOAWAY / close keep-alive, let live tunnels/WS run up to deadline).
/// - `abort_rx`: Hard Abort `0 ms` (immediately break out of active tunnels, TLS, WS, and HTTP servers).
#[derive(Debug, Clone)]
pub(super) struct ConnectionLifecycle {
    drain_rx: watch::Receiver<Option<tokio::time::Instant>>,
    abort_rx: watch::Receiver<bool>,
    capture_suppressed: Arc<AtomicBool>,
}

#[derive(Debug)]
pub(super) struct ConnectionLifecycleHandle {
    drain_tx: watch::Sender<Option<tokio::time::Instant>>,
    abort_tx: watch::Sender<bool>,
    capture_suppressed: Arc<AtomicBool>,
    lifecycle: ConnectionLifecycle,
}

impl ConnectionLifecycleHandle {
    pub fn new() -> Self {
        let (drain_tx, drain_rx) = watch::channel(None);
        let (abort_tx, abort_rx) = watch::channel(false);
        let capture_suppressed = Arc::new(AtomicBool::new(false));
        let lifecycle = ConnectionLifecycle {
            drain_rx,
            abort_rx,
            capture_suppressed: Arc::clone(&capture_suppressed),
        };
        Self {
            drain_tx,
            abort_tx,
            capture_suppressed,
            lifecycle,
        }
    }

    pub fn lifecycle(&self) -> ConnectionLifecycle {
        self.lifecycle.clone()
    }

    pub fn begin_drain(&self, deadline: Duration) {
        self.capture_suppressed.store(true, Ordering::Release);
        let target = tokio::time::Instant::now() + deadline;
        self.drain_tx.send_if_modified(|current| {
            if current.is_none() {
                *current = Some(target);
                true
            } else {
                false
            }
        });
    }

    pub fn abort_now(&self) {
        self.capture_suppressed.store(true, Ordering::Release);
        let _ = self.abort_tx.send(true);
    }

    pub fn is_finished(&self) -> bool {
        *self.abort_tx.borrow()
            || self
                .drain_tx
                .borrow()
                .is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
    }
}

impl ConnectionLifecycle {
    pub fn detached() -> Self {
        let (_drain_tx, drain_rx) = watch::channel(None);
        let (_abort_tx, abort_rx) = watch::channel(false);
        Self {
            drain_rx,
            abort_rx,
            capture_suppressed: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_aborted(&self) -> bool {
        *self.abort_rx.borrow()
    }

    pub fn drain_deadline(&self) -> Option<tokio::time::Instant> {
        *self.drain_rx.borrow()
    }

    pub fn is_draining_or_aborted(&self) -> bool {
        self.is_aborted() || self.drain_deadline().is_some()
    }

    pub fn is_capture_suppressed(&self) -> bool {
        self.capture_suppressed.load(Ordering::Acquire) || self.is_aborted()
    }

    pub async fn wait_abort(&mut self) {
        loop {
            if *self.abort_rx.borrow_and_update() {
                return;
            }
            if self.abort_rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }

    pub async fn wait_drain_started(&mut self) -> tokio::time::Instant {
        loop {
            if let Some(deadline) = *self.drain_rx.borrow_and_update() {
                return deadline;
            }
            if self.drain_rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }

    pub async fn wait_drain_expired(&mut self) {
        let deadline = self.wait_drain_started().await;
        tokio::time::sleep_until(deadline).await;
    }
}

/// Tracks client TCP / MITM-TLS connection identity, keep-alive sequence, and negotiated TLS info.
#[derive(Debug, Clone)]
pub(super) struct ClientConnContext {
    pub conn_id: u64,
    pub connected_at: String,
    pub connected_instant: Instant,
    pub request_seq: Arc<AtomicU64>,
    pub client_tls_handshake_ms: Option<f64>,
    pub client_tls_version: Option<String>,
    pub client_tls_cipher: Option<String>,
    pub client_alpn: Option<String>,
    pub lifecycle: ConnectionLifecycle,
}

impl ClientConnContext {
    #[cfg(test)]
    pub fn new() -> Self {
        Self::new_with_lifecycle(ConnectionLifecycle::detached())
    }

    pub fn new_with_lifecycle(lifecycle: ConnectionLifecycle) -> Self {
        let connected_instant = Instant::now();
        let connected_at = format_rfc3339_micros(Utc::now());
        Self {
            conn_id: NEXT_CLIENT_CONN_ID.fetch_add(1, Ordering::Relaxed),
            connected_at,
            connected_instant,
            request_seq: Arc::new(AtomicU64::new(0)),
            client_tls_handshake_ms: None,
            client_tls_version: None,
            client_tls_cipher: None,
            client_alpn: None,
            lifecycle,
        }
    }

    pub fn is_draining_or_aborted(&self) -> bool {
        self.lifecycle.is_draining_or_aborted()
    }

    pub fn is_capture_suppressed(&self) -> bool {
        self.lifecycle.is_capture_suppressed()
    }

    pub fn with_mitm_tls(
        &self,
        handshake_ms: f64,
        tls_version: Option<String>,
        tls_cipher: Option<String>,
        alpn: Option<String>,
    ) -> Self {
        Self {
            conn_id: self.conn_id,
            connected_at: self.connected_at.clone(),
            connected_instant: self.connected_instant,
            request_seq: Arc::new(AtomicU64::new(0)),
            client_tls_handshake_ms: Some(handshake_ms),
            client_tls_version: tls_version,
            client_tls_cipher: tls_cipher,
            client_alpn: alpn,
            lifecycle: self.lifecycle.clone(),
        }
    }

    pub fn claim_request_seq(&self) -> (bool, Option<f64>) {
        let seq = self.request_seq.fetch_add(1, Ordering::AcqRel);
        let reused = seq > 0;
        let tls_ms = self
            .client_tls_handshake_ms
            .map(|ms| if reused { 0.0 } else { ms });
        (reused, tls_ms)
    }
}


pub mod composer_exec;
pub mod connect_tunnel;
pub mod http_handler;
pub mod mobile_portal;
pub mod websocket_relay;

pub use http_handler::parse_sse_events_from_bytes;
pub type ProxyController = ProxyEngineController;

use connect_tunnel::handle_outer_proxy_request;
use websocket_relay::{
    parse_hex_payload, WsInjectCommand, MAX_WS_INJECT_PAYLOAD_BYTES,
};

#[inline]
fn evaluate_should_store_session(ctx: &SharedProxyContext, summary: &SessionSummary) -> bool {
    ctx.filters.evaluate_should_store_session(summary)
}

fn encode_inline_or_offload(raw: &[u8]) -> (String, Option<String>, bool) {
    if raw.len() > BODY_OFFLOAD_THRESHOLD_BYTES {
        (String::new(), None, true)
    } else {
        (
            base64::engine::general_purpose::STANDARD.encode(raw),
            std::str::from_utf8(raw).ok().map(str::to_owned),
            false,
        )
    }
}

fn record_completed_session(
    ctx: &SharedProxyContext,
    mut detail: SessionDetail,
    raw_req_body: Option<&[u8]>,
    raw_resp_body: Option<&[u8]>,
) -> bool {
    let existing = ctx.store.get_in_ram(detail.summary.id);
    if let Some(ref existing_detail) = existing {
        if detail.summary.comment.is_none() {
            detail.summary.comment = existing_detail.summary.comment.clone();
        }
        if detail.summary.marked_color.is_none() {
            detail.summary.marked_color = existing_detail.summary.marked_color.clone();
        }
    }

    if !evaluate_should_store_session(ctx, &detail.summary) {
        if existing.is_some() {
            ctx.store.remove_many(&[detail.summary.id]);
            let _ = ctx.removed_tx.send(vec![detail.summary.id]);
        }
        ctx.store.increment_dropped_sessions();
        ctx.stats_dirty.store(true, Ordering::Relaxed);
        return false;
    }

    let summary = detail.summary.clone();
    ctx.store
        .insert_with_bodies(detail, raw_req_body, raw_resp_body);
    let _ = ctx.event_tx.send(summary);
    true
}

#[allow(clippy::too_many_arguments)]
pub(super) fn record_in_flight_session_with_remap(
    ctx: &SharedProxyContext,
    session_id: u64,
    timestamp: String,
    protocol: String,
    scheme: String,
    method: String,
    host: String,
    path: String,
    url: String,
    process_name: Option<String>,
    process_pid: Option<u32>,
    headers_mutated: bool,
    breakpoint_modified: bool,
    client_ip: Option<String>,
    client_addr: String,
    tls_version: Option<String>,
    request_headers: Vec<HeaderPair>,
    req_body_bytes: &[u8],
    remapped_to: Option<String>,
) -> bool {
    let existing = ctx.store.get_in_ram(session_id);
    let comment = existing.as_ref().and_then(|d| d.summary.comment.clone());
    let marked_color = existing
        .as_ref()
        .and_then(|d| d.summary.marked_color.clone());

    let summary = SessionSummary {
        id: session_id,
        status: 0,
        protocol,
        scheme,
        method,
        host,
        path,
        url,
        content_type: String::new(),
        body_size: 0,
        duration_ms: 0,
        timestamp,
        is_mocked: false,
        matched_rule_id: None,
        error: None,
        process_name,
        process_pid,
        tls_bypassed: false,
        headers_mutated,
        breakpoint_paused: None,
        breakpoint_modified,
        comment,
        marked_color,
        client_ip,
        remapped_to,
        ttfb_ms: None,
        dns_ms: None,
        connect_ms: None,
        tls_ms: None,
        receive_ms: None,
        request_size: None,
        wire_body_size: None,
        server_ip: None,
        server_conn_reused: None,
        ws_open: None,
    };

    if !evaluate_should_store_session(ctx, &summary) {
        if existing.is_some() {
            ctx.store.remove_many(&[session_id]);
            let _ = ctx.removed_tx.send(vec![session_id]);
        }
        return false;
    }

    let capped_req = &req_body_bytes[..req_body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
    let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
    let detail = SessionDetail {
        summary: summary.clone(),
        request_headers,
        response_headers: Vec::new(),
        request_body_base64: req_b64,
        response_body_base64: String::new(),
        request_body_text: req_txt,
        response_body_text: None,
        tls_version,
        client_addr,
        websocket_frames: Vec::new(),
        sse_events: Vec::new(),
        body_offloaded: false,
        request_body_offloaded: req_offloaded,
        timings: None,
        transfer_stats: None,
    };

    ctx.store.insert_with_bodies(detail, Some(capped_req), None);
    let _ = ctx.event_tx.send(summary);
    true
}

#[allow(clippy::too_many_arguments)]
pub(super) fn record_error_session_with_telemetry(
    ctx: &SharedProxyContext,
    session_id: u64,
    protocol: String,
    scheme: &str,
    method: &str,
    host: &str,
    path: &str,
    url: &str,
    req_headers: Vec<HeaderPair>,
    req_body: &[u8],
    duration_ms: u64,
    timestamp: String,
    process_name: Option<String>,
    process_pid: Option<u32>,
    tls_bypassed: bool,
    headers_mutated: bool,
    breakpoint_modified: bool,
    client_ip: Option<String>,
    client_addr: String,
    status_code: u16,
    remapped_to: Option<String>,
    timings: Option<SessionTimings>,
    transfer_stats: Option<SessionTransferStats>,
    err_msg: &str,
) {
    record_error_session_with_telemetry_and_code(
        ctx,
        session_id,
        protocol,
        scheme,
        method,
        host,
        path,
        url,
        req_headers,
        req_body,
        duration_ms,
        timestamp,
        process_name,
        process_pid,
        tls_bypassed,
        headers_mutated,
        breakpoint_modified,
        client_ip,
        client_addr,
        status_code,
        remapped_to,
        timings,
        transfer_stats,
        err_msg,
        None,
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn record_error_session_with_telemetry_and_code(
    ctx: &SharedProxyContext,
    session_id: u64,
    protocol: String,
    scheme: &str,
    method: &str,
    host: &str,
    path: &str,
    url: &str,
    req_headers: Vec<HeaderPair>,
    req_body: &[u8],
    duration_ms: u64,
    timestamp: String,
    process_name: Option<String>,
    process_pid: Option<u32>,
    tls_bypassed: bool,
    headers_mutated: bool,
    breakpoint_modified: bool,
    client_ip: Option<String>,
    client_addr: String,
    status_code: u16,
    remapped_to: Option<String>,
    timings: Option<SessionTimings>,
    transfer_stats: Option<SessionTransferStats>,
    err_msg: &str,
    proxy_error_code: Option<&str>,
) {
    let mut summary = SessionSummary {
        id: session_id,
        status: status_code,
        protocol,
        scheme: scheme.to_string(),
        method: method.to_string(),
        host: host.to_string(),
        path: path.to_string(),
        url: url.to_string(),
        content_type: "text/plain; charset=utf-8".to_string(),
        body_size: err_msg.len(),
        duration_ms,
        timestamp,
        is_mocked: false,
        matched_rule_id: None,
        error: Some(err_msg.to_string()),
        process_name,
        process_pid,
        tls_bypassed,
        headers_mutated,
        breakpoint_paused: None,
        breakpoint_modified,
        comment: None,
        marked_color: None,
        client_ip,
        remapped_to,
        ttfb_ms: None,
        dns_ms: None,
        connect_ms: None,
        tls_ms: None,
        receive_ms: None,
        request_size: None,
        wire_body_size: None,
        server_ip: None,
        server_conn_reused: None,
        ws_open: None,
    };
    summary.apply_telemetry(timings.as_ref(), transfer_stats.as_ref());

    let capped_req = &req_body[..req_body.len().min(MAX_CAPTURED_BODY_BYTES)];
    let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
    let mut response_headers = vec![HeaderPair::new("Content-Type", "text/plain; charset=utf-8")];
    if let Some(code) = proxy_error_code {
        response_headers.push(HeaderPair::new(FLUXPROXY_ERROR_HEADER, code));
    }
    let detail = SessionDetail {
        summary,
        request_headers: req_headers,
        response_headers,
        request_body_base64: req_b64,
        response_body_base64: base64::engine::general_purpose::STANDARD.encode(err_msg.as_bytes()),
        request_body_text: req_txt,
        response_body_text: Some(err_msg.to_string()),
        tls_version: None,
        client_addr,
        websocket_frames: Vec::new(),
        sse_events: Vec::new(),
        body_offloaded: false,
        request_body_offloaded: req_offloaded,
        timings,
        transfer_stats,
    };

    record_completed_session(ctx, detail, Some(capped_req), None);
}

pub struct SharedProxyContext {
    pub ca: Arc<CertificateAuthority>,
    pub rules: Arc<RuleEngine>,
    pub filters: Arc<ProxyFilterEngine>,
    pub breakpoints: Arc<BreakpointEngine>,
    pub host_remap: Arc<HostRemapRegistry>,
    pub upstream_proxy: Arc<UpstreamProxyManager>,
    pub throttle: Arc<ThrottleEngine>,
    pub store: Arc<TrafficStore>,
    pub upstream_http_client: std::sync::RwLock<Arc<UpstreamHttpClient>>,
    pub remote_upstream_http_client: std::sync::RwLock<Arc<UpstreamHttpClient>>,
    pub client_certs: Arc<ClientCertificateStore>,
    pub script_runner: Arc<PythonScriptRunner>,
    pub active_ws_channels: Arc<DashMap<u64, mpsc::UnboundedSender<WsInjectCommand>>>,
    pub event_tx: mpsc::UnboundedSender<SessionSummary>,
    pub removed_tx: mpsc::UnboundedSender<Vec<u64>>,
    pub active_port: AtomicU16,
    pub connect_timeout_sec: Arc<std::sync::atomic::AtomicU64>,
    pub response_header_timeout_sec: Arc<std::sync::atomic::AtomicU64>,
    pub composer_timeout_sec: Arc<std::sync::atomic::AtomicU64>,
    pub app_handle: Option<AppHandle>,
    pub stats_dirty: Arc<AtomicBool>,
}

pub(super) struct InFlightSessionGuard {
    ctx: Arc<SharedProxyContext>,
    session_id: u64,
    start: Instant,
    armed: bool,
    error_message: &'static str,
    proxy_error_code: &'static str,
    lifecycle: ConnectionLifecycle,
}

impl InFlightSessionGuard {
    pub(super) fn new_with_lifecycle(
        ctx: Arc<SharedProxyContext>,
        session_id: u64,
        start: Instant,
        lifecycle: ConnectionLifecycle,
    ) -> Self {
        Self {
            ctx,
            session_id,
            start,
            armed: true,
            error_message: "Client closed connection while waiting for upstream response",
            proxy_error_code: FLUXPROXY_ERR_CLIENT_CLOSED_REQUEST,
            lifecycle,
        }
    }

    pub(super) fn new_composer(
        ctx: Arc<SharedProxyContext>,
        session_id: u64,
        start: Instant,
    ) -> Self {
        Self {
            ctx,
            session_id,
            start,
            armed: true,
            error_message: "Composer request aborted before completion",
            proxy_error_code: FLUXPROXY_ERR_COMPOSER_CANCELLED,
            lifecycle: ConnectionLifecycle::detached(),
        }
    }

    pub(super) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for InFlightSessionGuard {
    fn drop(&mut self) {
        if !self.armed || self.lifecycle.is_capture_suppressed() {
            return;
        }
        let duration_ms = self.start.elapsed().as_millis() as u64;
        if let Some(updated_summary) = self.ctx.store.finalize_abandoned_in_flight(
            self.session_id,
            499,
            duration_ms,
            self.error_message,
            Some(self.proxy_error_code),
        ) {
            if evaluate_should_store_session(&self.ctx, &updated_summary) {
                let _ = self.ctx.event_tx.send(updated_summary);
            } else {
                self.ctx.store.remove_many(&[self.session_id]);
                let _ = self.ctx.removed_tx.send(vec![self.session_id]);
            }
        }
    }
}

fn make_breakpoint_guard(
    ctx: &Arc<SharedProxyContext>,
    bp_id: String,
    session_id: u64,
    start: Instant,
) -> PendingBreakpointGuard {
    let ctx_for_drop = Arc::clone(ctx);
    PendingBreakpointGuard::new(
        Arc::clone(&ctx.breakpoints),
        bp_id,
        session_id,
        Some(Box::new(move |sid| {
            let duration_ms = start.elapsed().as_millis() as u64;
            if let Some(updated_summary) = ctx_for_drop.store.cancel_paused_breakpoint(
                sid,
                499,
                "Client Closed Request during Breakpoint",
                duration_ms,
            ) {
                if evaluate_should_store_session(&ctx_for_drop, &updated_summary) {
                    let _ = ctx_for_drop.event_tx.send(updated_summary);
                } else {
                    ctx_for_drop.store.remove_many(&[sid]);
                    let _ = ctx_for_drop.removed_tx.send(vec![sid]);
                }
            }
        })),
    )
}

impl SharedProxyContext {
    pub fn connect_timeout(&self) -> Duration {
        let secs = self
            .connect_timeout_sec
            .load(Ordering::Relaxed)
            .clamp(
                crate::models::MIN_CONNECT_TIMEOUT_SEC,
                crate::models::MAX_CONNECT_TIMEOUT_SEC,
            );
        Duration::from_secs(secs)
    }

    pub fn response_header_timeout(&self) -> Option<Duration> {
        let secs = self.response_header_timeout_sec.load(Ordering::Relaxed);
        if secs == 0 {
            None
        } else {
            Some(Duration::from_secs(secs))
        }
    }

    pub fn composer_timeout(&self, override_sec: Option<u64>) -> Option<Duration> {
        let secs = override_sec.unwrap_or_else(|| self.composer_timeout_sec.load(Ordering::Relaxed));
        if secs == 0 {
            None
        } else {
            Some(Duration::from_secs(secs))
        }
    }

    pub fn upstream_timeout_config(&self) -> crate::models::UpstreamTimeoutConfig {
        crate::models::UpstreamTimeoutConfig {
            connect_timeout_sec: self.connect_timeout_sec.load(Ordering::Relaxed),
            response_header_timeout_sec: self.response_header_timeout_sec.load(Ordering::Relaxed),
            composer_timeout_sec: self.composer_timeout_sec.load(Ordering::Relaxed),
        }
        .normalized()
    }

    pub fn upstream_http_client(&self) -> Arc<UpstreamHttpClient> {
        self.upstream_http_client
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn remote_upstream_http_client(&self) -> Arc<UpstreamHttpClient> {
        self.remote_upstream_http_client
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn upstream_http_client_for_peer(&self, peer_is_remote: bool) -> Arc<UpstreamHttpClient> {
        if peer_is_remote {
            self.remote_upstream_http_client()
        } else {
            self.upstream_http_client()
        }
    }

    pub fn rebuild_upstream_clients(&self) {
        let resolver = Arc::clone(&self.host_remap);
        let upstream_proxy = Arc::clone(&self.upstream_proxy);
        match UpstreamHttpClient::build(
            Some(Arc::clone(&resolver)),
            Some(Arc::clone(&upstream_proxy)),
            None,
            Arc::clone(&self.connect_timeout_sec),
            false,
        ) {
            Ok(client) => {
                *self
                    .upstream_http_client
                    .write()
                    .unwrap_or_else(|e| e.into_inner()) = Arc::new(client);
            }
            Err(err) => {
                tracing::warn!("Failed rebuilding upstream_http_client: {err}");
            }
        }
        match UpstreamHttpClient::build(
            Some(resolver),
            Some(upstream_proxy),
            None,
            Arc::clone(&self.connect_timeout_sec),
            true,
        ) {
            Ok(remote_client) => {
                *self
                    .remote_upstream_http_client
                    .write()
                    .unwrap_or_else(|e| e.into_inner()) = Arc::new(remote_client);
            }
            Err(err) => {
                tracing::warn!("Failed rebuilding remote_upstream_http_client: {err}");
            }
        }
        self.client_certs.invalidate_client_cache();
    }

    pub async fn inject_websocket_frame(
        &self,
        session_id: u64,
        direction: WsInjectDirection,
        opcode: WsInjectOpcode,
        payload: String,
    ) -> Result<WebSocketFrameRecord, ProxyError> {
        let message = match opcode {
            WsInjectOpcode::Text => {
                if payload.len() > MAX_WS_INJECT_PAYLOAD_BYTES {
                    return Err(ProxyError::Custom(format!(
                        "Размер текстового WebSocket-фрейма превышает лимит {MAX_WS_INJECT_PAYLOAD_BYTES} байт."
                    )));
                }
                tokio_tungstenite::tungstenite::Message::Text(payload.into())
            }
            WsInjectOpcode::Binary => {
                let bytes = parse_hex_payload(&payload)?;
                tokio_tungstenite::tungstenite::Message::Binary(bytes.into())
            }
        };

        let sender = self
            .active_ws_channels
            .get(&session_id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| {
                ProxyError::Custom(format!(
                    "WebSocket-соединение для сессии #{session_id} уже закрыто или не найдено."
                ))
            })?;

        let (ack_tx, ack_rx) = oneshot::channel();
        sender
            .send(WsInjectCommand {
                direction,
                message,
                ack_tx,
            })
            .map_err(|_| {
                ProxyError::Custom(format!(
                    "Канал WebSocket-соединения для сессии #{session_id} уже закрыт."
                ))
            })?;

        match tokio::time::timeout(Duration::from_secs(5), ack_rx).await {
            Ok(Ok(Ok(record))) => Ok(record),
            Ok(Ok(Err(err))) => Err(ProxyError::Custom(err)),
            Ok(Err(_)) => Err(ProxyError::Custom(format!(
                "WebSocket-соединение для сессии #{session_id} закрылось во время отправки фрейма."
            ))),
            Err(_) => Err(ProxyError::Custom(format!(
                "Таймаут отправки WebSocket-фрейма в сессию #{session_id}."
            ))),
        }
    }

    pub fn current_storage_stats(&self) -> StorageStats {
        let drop_enabled = self.filters.is_drop_non_matching_enabled();
        self.store.storage_stats(drop_enabled)
    }

    pub fn emit_storage_stats_changed(&self) {
        self.stats_dirty.store(false, Ordering::Relaxed);
        let Some(ref app) = self.app_handle else {
            return;
        };
        let app = app.clone();
        let store = self.store.clone();
        let filters = self.filters.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let stats = store.storage_stats(filters.is_drop_non_matching_enabled());
            let _ = app.emit("proxy://storage-stats-changed", stats);
        });
    }
}

struct ControllerRuntimeState {
    bind_addr: (String, u16),
    bind_mode: BindHostMode,
    specific_bind_ip: Option<String>,
    also_bind_loopback: bool,
    bound_ips: Vec<String>,
    shutdown_tx: Option<watch::Sender<bool>>,
    listener_handles: Vec<tokio::task::JoinHandle<()>>,
    active_lifecycle: Option<ConnectionLifecycleHandle>,
    draining_lifecycles: Vec<ConnectionLifecycleHandle>,
    drain_deadline: Duration,
    auto_system_proxy: bool,
    allow_remote: bool,
}

pub(crate) fn format_bind_sock_addr(ip: &str, port: u16) -> String {
    if ip.contains(':') && !ip.starts_with('[') {
        format!("[{ip}]:{port}")
    } else {
        format!("{ip}:{port}")
    }
}

pub(crate) type ResolvedBindPlan = (BindHostMode, String, Option<String>, Vec<String>, bool);

pub(crate) fn resolve_bind_plan(
    bind_mode: BindHostMode,
    specific_bind_ip: Option<&str>,
    also_bind_loopback: bool,
) -> Result<ResolvedBindPlan, ProxyError> {
    match bind_mode {
        BindHostMode::Loopback => Ok((
            BindHostMode::Loopback,
            "127.0.0.1".to_string(),
            None,
            vec!["127.0.0.1".to_string()],
            false,
        )),
        BindHostMode::AllInterfaces => Ok((
            BindHostMode::AllInterfaces,
            "0.0.0.0".to_string(),
            None,
            vec!["0.0.0.0".to_string()],
            true,
        )),
        BindHostMode::Specific => {
            let trimmed = specific_bind_ip.map(str::trim).unwrap_or("");
            if trimmed.is_empty() {
                return Err(ProxyError::Custom(
                    "Для режима Specific необходимо указать IP-адрес сетевого интерфейса"
                        .to_string(),
                ));
            }
            let parsed = trimmed.parse::<IpAddr>().map_err(|_| {
                ProxyError::Custom(format!(
                    "Некорректный IP-адрес интерфейса: '{trimmed}'"
                ))
            })?;
            let ip_str = parsed.to_string();

            if parsed.is_unspecified() {
                return Ok((
                    BindHostMode::AllInterfaces,
                    "0.0.0.0".to_string(),
                    None,
                    vec!["0.0.0.0".to_string()],
                    true,
                ));
            }

            if ip_str == "127.0.0.1" || ip_str == "::1" {
                return Ok((
                    BindHostMode::Specific,
                    ip_str.clone(),
                    Some(ip_str.clone()),
                    vec![ip_str],
                    false,
                ));
            }

            let mut bound_ips = vec![ip_str.clone()];
            if also_bind_loopback {
                bound_ips.push("127.0.0.1".to_string());
            }
            Ok((
                BindHostMode::Specific,
                ip_str.clone(),
                Some(ip_str),
                bound_ips,
                true,
            ))
        }
    }
}

async fn bind_single_listener_with_retry(
    ip: &str,
    port: u16,
    retry_attempts: usize,
) -> Result<TcpListener, std::io::Error> {
    let addr = format_bind_sock_addr(ip, port);
    let attempts = retry_attempts.max(1);
    let mut last_err = None;
    for attempt in 0..attempts {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        match TcpListener::bind(&addr).await {
            Ok(listener) => return Ok(listener),
            Err(err) => {
                let retryable = err.kind() == std::io::ErrorKind::AddrInUse;
                last_err = Some(err);
                if !retryable {
                    break;
                }
            }
        }
    }
    Err(last_err.expect("bind attempt should produce listener or error"))
}

pub(crate) async fn bind_listeners_with_cleanup(
    target_ips: &[String],
    port: u16,
    retry_attempts: usize,
) -> Result<(Vec<(TcpListener, String)>, u16), ProxyError> {
    let Some(primary_ip) = target_ips.first() else {
        return Err(ProxyError::Custom(
            "Список адресов для прослушивания пуст".to_string(),
        ));
    };

    let primary_listener =
        match bind_single_listener_with_retry(primary_ip, port, retry_attempts).await {
            Ok(l) => l,
            Err(err) => {
                let addr = format_bind_sock_addr(primary_ip, port);
                if err.kind() == std::io::ErrorKind::AddrInUse {
                    return Err(ProxyError::Custom(format!(
                        "Адрес {addr} уже занят другим процессом (AddrInUse): {err}"
                    )));
                }
                return Err(ProxyError::Custom(format!(
                    "Не удалось привязать сокет {addr}: {err}"
                )));
            }
        };

    let actual_port = primary_listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(port);
    let mut listeners = Vec::with_capacity(target_ips.len());
    listeners.push((primary_listener, primary_ip.clone()));

    for extra_ip in &target_ips[1..] {
        match bind_single_listener_with_retry(extra_ip, actual_port, retry_attempts).await {
            Ok(extra_listener) => {
                listeners.push((extra_listener, extra_ip.clone()));
            }
            Err(err) => {
                let extra_addr = format_bind_sock_addr(extra_ip, actual_port);
                let primary_addr = format_bind_sock_addr(primary_ip, actual_port);
                // Explicitly drop already-bound listeners so the primary port is immediately released
                drop(listeners);
                let reason = if err.kind() == std::io::ErrorKind::AddrInUse {
                    "AddrInUse — порт уже занят"
                } else {
                    "ошибка привязки сокета"
                };
                return Err(ProxyError::Custom(format!(
                    "Не удалось привязать дополнительный локальный сокет {extra_addr} ({reason}): {err}. Основной сокет {primary_addr} был остановлен."
                )));
            }
        }
    }

    Ok((listeners, actual_port))
}

fn collect_local_host_ips() -> Vec<IpAddr> {
    let mut ips = Vec::new();
    for info in crate::proxy::network::list_network_interfaces_with_options(true) {
        if let Ok(parsed) = info.ip.trim().parse::<IpAddr>() {
            if !ips.contains(&parsed) {
                ips.push(parsed);
            }
        }
    }
    ips
}

fn host_matches_local_self_loop(host: &str, bound_ips: &[String], local_host_ips: &[IpAddr]) -> bool {
    let clean = host
        .trim()
        .trim_matches(['[', ']'])
        .trim_end_matches('.');
    let clean_no_zone = clean.split('%').next().unwrap_or(clean).to_ascii_lowercase();
    if clean_no_zone.is_empty() {
        return false;
    }
    if clean_no_zone == "localhost" {
        return true;
    }
    if bound_ips.iter().any(|ip| ip.eq_ignore_ascii_case(&clean_no_zone)) {
        return true;
    }
    if let Ok(parsed) = clean_no_zone.parse::<IpAddr>() {
        let canonical = match parsed {
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => IpAddr::V4(v4),
                None => IpAddr::V6(v6),
            },
            other => other,
        };
        if canonical.is_loopback() || canonical.is_unspecified() {
            return true;
        }
        if bound_ips.iter().any(|b| {
            b.parse::<IpAddr>().is_ok_and(|bp| match bp {
                IpAddr::V6(v6) => v6
                    .to_ipv4_mapped()
                    .map_or(IpAddr::V6(v6) == canonical, |v4| IpAddr::V4(v4) == canonical),
                other => other == canonical,
            })
        }) {
            return true;
        }
        if local_host_ips.iter().any(|local| match local {
            IpAddr::V6(v6) => v6
                .to_ipv4_mapped()
                .map_or(IpAddr::V6(*v6) == canonical, |v4| IpAddr::V4(v4) == canonical),
            other => *other == canonical,
        }) {
            return true;
        }
    }
    false
}

fn validate_no_upstream_proxy_self_loop(
    config: &UpstreamProxyConfig,
    proxy_port: u16,
    bound_ips: &[String],
) -> Result<(), ProxyError> {
    if !config.enabled || proxy_port == 0 {
        return Ok(());
    }
    let local_host_ips = collect_local_host_ips();
    if config.port == proxy_port
        && host_matches_local_self_loop(&config.host, bound_ips, &local_host_ips)
    {
        let clean_host = config
            .host
            .trim()
            .trim_matches(['[', ']'])
            .trim_end_matches('.')
            .to_ascii_lowercase();
        return Err(ProxyError::Custom(format!(
            "Защита от петли трафика: вышестоящий прокси не может указывать на собственный порт FluxProxy ({clean_host}:{proxy_port})."
        )));
    }
    Ok(())
}

fn is_bind_narrowing(
    prev_mode: BindHostMode,
    prev_bound_ips: &[String],
    next_mode: BindHostMode,
    next_bound_ips: &[String],
) -> bool {
    if next_mode == BindHostMode::AllInterfaces {
        return false;
    }
    if prev_mode == BindHostMode::AllInterfaces {
        return true;
    }
    prev_bound_ips
        .iter()
        .any(|old_ip| !next_bound_ips.iter().any(|new_ip| new_ip == old_ip))
}

async fn serve_connection(
    tcp_stream: tokio::net::TcpStream,
    client_addr: SocketAddr,
    local_proxy_port: Option<u16>,
    lifecycle: ConnectionLifecycle,
    ctx: Arc<SharedProxyContext>,
) {
    if lifecycle.is_aborted() || !ctx.filters.is_lan_client_allowed(client_addr.ip()) {
        return;
    }
    let mut abort_sig = lifecycle.clone();
    let mut proc_drain_sig = lifecycle.clone();
    let client_proc = tokio::select! {
        biased;
        _ = abort_sig.wait_abort() => return,
        _ = proc_drain_sig.wait_drain_expired() => return,
        proc_info = resolve_client_process_async(client_addr, local_proxy_port) => proc_info,
    };
    if abort_sig.is_aborted() || !ctx.filters.is_lan_client_allowed(client_addr.ip()) {
        return;
    }

    let mut drain_sig = lifecycle.clone();
    let mut drain_notified = false;
    let mut drain_deadline: Option<tokio::time::Instant> = None;
    let mut config_rx = ctx.filters.subscribe_config_updates();
    let mut config_closed = false;

    let client_conn = ClientConnContext::new_with_lifecycle(lifecycle);
    let conn_ctx = Arc::clone(&ctx);
    let io = TokioIo::new(tcp_stream);
    let service = service_fn(move |req: Request<Incoming>| {
        let req_ctx = conn_ctx.clone();
        let proc_info = client_proc.clone();
        let conn_info = client_conn.clone();
        async move {
            Ok::<_, Infallible>(
                handle_outer_proxy_request(req, client_addr, proc_info, conn_info, req_ctx).await,
            )
        }
    });

    let auto_builder = AutoConnBuilder::new(TokioExecutor::new());
    let conn = auto_builder.serve_connection_with_upgrades(io, service);
    tokio::pin!(conn);

    loop {
        tokio::select! {
            biased;
            _ = abort_sig.wait_abort() => {
                break;
            }
            res = conn.as_mut() => {
                let _ = res;
                break;
            }
            deadline = drain_sig.wait_drain_started(), if !drain_notified => {
                drain_notified = true;
                drain_deadline = Some(deadline);
                conn.as_mut().graceful_shutdown();
            }
            _ = async {
                match drain_deadline {
                    Some(d) => tokio::time::sleep_until(d).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                break;
            }
            changed = config_rx.changed(), if !config_closed => {
                if changed.is_err() {
                    config_closed = true;
                } else if !ctx.filters.is_lan_client_allowed(client_addr.ip()) {
                    tracing::info!(
                        "Hard-aborting active client connection from {} after LAN Client Allowlist update",
                        client_addr.ip()
                    );
                    break;
                }
            }
        }
    }
}

async fn shutdown_listeners(
    shutdown_tx: Option<watch::Sender<bool>>,
    handles: Vec<tokio::task::JoinHandle<()>>,
) {
    if let Some(tx) = shutdown_tx {
        let _ = tx.send(true);
    }
    for mut handle in handles {
        if tokio::time::timeout(Duration::from_secs(2), &mut handle)
            .await
            .is_err()
        {
            handle.abort();
            let _ = handle.await;
        }
    }
}

pub(crate) fn push_or_replace_summary(buffer: &mut Vec<SessionSummary>, item: SessionSummary) {
    if let Some(existing) = buffer.iter_mut().find(|s| s.id == item.id) {
        *existing = item;
    } else {
        buffer.push(item);
    }
}

pub struct ProxyEngineController {
    pub context: Arc<SharedProxyContext>,
    pub sysproxy: Arc<SystemProxyManager>,
    pub(super) active_composer_requests:
        Arc<DashMap<String, tokio::sync::oneshot::Sender<()>>>,
    op_lock: Mutex<()>,
    runtime_state: std::sync::Mutex<ControllerRuntimeState>,
}

impl ProxyEngineController {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ca: Arc<CertificateAuthority>,
        rules: Arc<RuleEngine>,
        filters: Arc<ProxyFilterEngine>,
        store: Arc<TrafficStore>,
        sysproxy: Arc<SystemProxyManager>,
        client_certs: Arc<ClientCertificateStore>,
        app_handle: AppHandle,
    ) -> Result<Self, ProxyError> {
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<SessionSummary>();
        let (removed_tx, mut removed_rx) = mpsc::unbounded_channel::<Vec<u64>>();
        let (bp_tx, mut bp_rx) = mpsc::unbounded_channel::<Vec<PausedBreakpointItem>>();
        let stats_dirty = Arc::new(AtomicBool::new(false));
        let ipc_stats_dirty = stats_dirty.clone();
        let ipc_app = app_handle.clone();
        let ipc_store = store.clone();
        let ipc_filters = filters.clone();

        // 60 FPS (16 ms) micro-batching IPC loop for sessions + zero-latency push for Live Breakpoints
        // + coalesced storage-stats push notifications every 500ms when stats changed
        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(16));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut stats_ticker = tokio::time::interval(Duration::from_millis(500));
            stats_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut buffer: Vec<SessionSummary> = Vec::with_capacity(256);

            loop {
                tokio::select! {
                    maybe_bp = bp_rx.recv() => {
                        if let Some(snapshot) = maybe_bp {
                            let _ = ipc_app.emit("proxy://breakpoints-changed", snapshot);
                        }
                    }
                    maybe_removed = removed_rx.recv() => {
                        if let Some(removed_ids) = maybe_removed {
                            if !removed_ids.is_empty() {
                                // Drain any buffered/queued Phase 1 events sent before removal so a
                                // removed session can never be flushed to the UI after `sessions-removed`.
                                while let Ok(item) = event_rx.try_recv() {
                                    push_or_replace_summary(&mut buffer, item);
                                }
                                buffer.retain(|s| !removed_ids.contains(&s.id));
                                let _ = ipc_app.emit("proxy://sessions-removed", removed_ids);
                                ipc_stats_dirty.store(true, Ordering::Relaxed);
                            }
                        }
                    }
                    maybe_item = event_rx.recv() => {
                        match maybe_item {
                            Some(item) => {
                                push_or_replace_summary(&mut buffer, item);
                                if buffer.len() >= 250 {
                                    let batch = std::mem::take(&mut buffer);
                                    let _ = ipc_app.emit("proxy://sessions-batch", batch);
                                    ipc_stats_dirty.store(true, Ordering::Relaxed);
                                }
                            }
                            None => break,
                        }
                    }
                    _ = ticker.tick() => {
                        if !buffer.is_empty() {
                            let batch = std::mem::take(&mut buffer);
                            let _ = ipc_app.emit("proxy://sessions-batch", batch);
                            ipc_stats_dirty.store(true, Ordering::Relaxed);
                        }
                    }
                    _ = stats_ticker.tick() => {
                        if ipc_stats_dirty.swap(false, Ordering::Relaxed) {
                            let app = ipc_app.clone();
                            let store = ipc_store.clone();
                            let filters = ipc_filters.clone();
                            let _ = tokio::task::spawn_blocking(move || {
                                let stats = store.storage_stats(filters.is_drop_non_matching_enabled());
                                let _ = app.emit("proxy://storage-stats-changed", stats);
                            })
                            .await;
                        }
                    }
                }
            }
        });

        Self::new_with_channels(
            ca,
            rules,
            filters,
            store,
            sysproxy,
            client_certs,
            event_tx,
            removed_tx,
            bp_tx,
            Some(app_handle),
            stats_dirty,
        )
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(
        ca: Arc<CertificateAuthority>,
        rules: Arc<RuleEngine>,
        filters: Arc<ProxyFilterEngine>,
        store: Arc<TrafficStore>,
        sysproxy: Arc<SystemProxyManager>,
    ) -> Result<Self, ProxyError> {
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<SessionSummary>();
        let (removed_tx, mut removed_rx) = mpsc::unbounded_channel::<Vec<u64>>();
        let (bp_tx, mut bp_rx) = mpsc::unbounded_channel::<Vec<PausedBreakpointItem>>();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    maybe_bp = bp_rx.recv() => {
                        if maybe_bp.is_none() && event_rx.is_closed() && removed_rx.is_closed() {
                            break;
                        }
                    }
                    maybe_removed = removed_rx.recv() => {
                        if maybe_removed.is_none() && event_rx.is_closed() && bp_rx.is_closed() {
                            break;
                        }
                    }
                    maybe_item = event_rx.recv() => {
                        if maybe_item.is_none() {
                            break;
                        }
                    }
                }
            }
        });

        Self::new_with_channels(
            ca,
            rules,
            filters,
            store,
            sysproxy,
            Arc::new(ClientCertificateStore::in_memory()),
            event_tx,
            removed_tx,
            bp_tx,
            None,
            Arc::new(AtomicBool::new(false)),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn new_with_channels(
        ca: Arc<CertificateAuthority>,
        rules: Arc<RuleEngine>,
        filters: Arc<ProxyFilterEngine>,
        store: Arc<TrafficStore>,
        sysproxy: Arc<SystemProxyManager>,
        client_certs: Arc<ClientCertificateStore>,
        event_tx: mpsc::UnboundedSender<SessionSummary>,
        removed_tx: mpsc::UnboundedSender<Vec<u64>>,
        bp_tx: mpsc::UnboundedSender<Vec<PausedBreakpointItem>>,
        app_handle: Option<AppHandle>,
        stats_dirty: Arc<AtomicBool>,
    ) -> Result<Self, ProxyError> {
        let host_remap = Arc::new(HostRemapRegistry::new());
        let upstream_proxy = Arc::new(UpstreamProxyManager::new());
        let throttle = Arc::new(ThrottleEngine::new());
        let timeouts_pref = sysproxy.load_upstream_timeouts_pref().normalized();
        let connect_timeout_sec = Arc::new(std::sync::atomic::AtomicU64::new(
            timeouts_pref.connect_timeout_sec,
        ));
        let response_header_timeout_sec = Arc::new(std::sync::atomic::AtomicU64::new(
            timeouts_pref.response_header_timeout_sec,
        ));
        let composer_timeout_sec = Arc::new(std::sync::atomic::AtomicU64::new(
            timeouts_pref.composer_timeout_sec,
        ));
        let dns_resolver = Arc::clone(&host_remap);
        let upstream_http_client = Arc::new(
            UpstreamHttpClient::build(
                Some(Arc::clone(&dns_resolver)),
                Some(Arc::clone(&upstream_proxy)),
                None,
                Arc::clone(&connect_timeout_sec),
                false,
            )
            .map_err(ProxyError::Custom)?,
        );
        let remote_upstream_http_client = Arc::new(
            UpstreamHttpClient::build(
                Some(dns_resolver),
                Some(Arc::clone(&upstream_proxy)),
                None,
                Arc::clone(&connect_timeout_sec),
                true,
            )
            .map_err(ProxyError::Custom)?,
        );

        let breakpoints = Arc::new(BreakpointEngine::new(Some(bp_tx)));
        let script_runner = Arc::new(PythonScriptRunner::new(app_handle.clone()));
        let active_ws_channels = Arc::new(DashMap::new());

        let initial_port = sysproxy.load_proxy_port_pref();
        let context = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap,
            upstream_proxy,
            throttle,
            store,
            upstream_http_client: std::sync::RwLock::new(upstream_http_client),
            remote_upstream_http_client: std::sync::RwLock::new(remote_upstream_http_client),
            client_certs,
            script_runner,
            active_ws_channels,
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(initial_port),
            connect_timeout_sec,
            response_header_timeout_sec,
            composer_timeout_sec,
            app_handle,
            stats_dirty,
        });

        let initial_auto = sysproxy.load_auto_system_proxy_pref();
        let bind_pref = sysproxy.load_bind_config_pref();
        if !initial_auto {
            sysproxy.rollback_if_dirty();
        }
        let (initial_mode, initial_bind_host, initial_specific_ip, initial_bound_ips, initial_allow_remote) =
            resolve_bind_plan(
                bind_pref.bind_mode,
                bind_pref.specific_bind_ip.as_deref(),
                bind_pref.also_bind_loopback,
            )
            .unwrap_or_else(|_| {
                (
                    BindHostMode::Loopback,
                    "127.0.0.1".to_string(),
                    None,
                    vec!["127.0.0.1".to_string()],
                    false,
                )
            });

        Ok(Self {
            context,
            sysproxy,
            active_composer_requests: Arc::new(DashMap::new()),
            op_lock: Mutex::new(()),
            runtime_state: std::sync::Mutex::new(ControllerRuntimeState {
                bind_addr: (initial_bind_host, initial_port),
                bind_mode: initial_mode,
                specific_bind_ip: initial_specific_ip,
                also_bind_loopback: bind_pref.also_bind_loopback,
                bound_ips: initial_bound_ips,
                shutdown_tx: None,
                listener_handles: Vec::new(),
                active_lifecycle: None,
                draining_lifecycles: Vec::new(),
                drain_deadline: GRACEFUL_DRAIN_DEADLINE,
                auto_system_proxy: initial_auto,
                allow_remote: initial_allow_remote,
            }),
        })
    }

    pub fn preferred_bind_host(&self) -> String {
        self.lock_runtime().bind_addr.0.clone()
    }

    pub fn preferred_port(&self) -> u16 {
        self.lock_runtime().bind_addr.1
    }

    #[cfg(test)]
    pub(crate) fn set_drain_deadline_for_test(&self, deadline: Duration) {
        self.lock_runtime().drain_deadline = deadline;
    }

    fn lock_runtime(&self) -> std::sync::MutexGuard<'_, ControllerRuntimeState> {
        match self.runtime_state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn build_status(&self) -> ProxyStatus {
        let (
            running,
            bind_addr,
            port,
            auto_system_proxy,
            allow_remote,
            bind_mode,
            specific_bind_ip,
            also_bind_loopback,
            bound_ips,
        ) = {
            let guard = self.lock_runtime();
            (
                guard.shutdown_tx.is_some(),
                guard.bind_addr.0.clone(),
                guard.bind_addr.1,
                guard.auto_system_proxy,
                guard.allow_remote || guard.bind_addr.0 == "0.0.0.0" || guard.bind_addr.0 == "::",
                guard.bind_mode,
                guard.specific_bind_ip.clone(),
                guard.also_bind_loopback,
                guard.bound_ips.clone(),
            )
        };
        let sysproxy_host =
            resolve_sysproxy_host_for_bind(bind_mode, specific_bind_ip.as_deref(), also_bind_loopback);
        let (system_proxy_enabled, system_proxy_error) =
            self.sysproxy.status_for_listener(&sysproxy_host, port);

        ProxyStatus {
            running,
            bind_addr,
            port,
            active_sessions: self.context.store.len(),
            system_proxy_enabled,
            auto_system_proxy,
            system_proxy_error,
            allow_remote,
            bind_mode,
            specific_bind_ip,
            also_bind_loopback,
            bound_ips,
        }
    }

    pub async fn status(&self) -> ProxyStatus {
        self.build_status()
    }

    pub fn emit_status_changed(&self, status: &ProxyStatus) {
        if let Some(ref app) = self.context.app_handle {
            let _ = app.emit("proxy://status-changed", status.clone());
        }
    }

    fn spawn_accept_loop(
        &self,
        listener: TcpListener,
        addr_str: String,
        actual_port: u16,
        mut rx: watch::Receiver<bool>,
        lifecycle: ConnectionLifecycle,
    ) -> tokio::task::JoinHandle<()> {
        self.context.active_port.store(actual_port, Ordering::Relaxed);
        let ctx = self.context.clone();
        tokio::spawn(async move {
            tracing::info!("FluxProxy MITM engine listening on http://{addr_str}");
            loop {
                tokio::select! {
                    changed = rx.changed() => {
                        if changed.is_err() || *rx.borrow() {
                            tracing::info!("FluxProxy listener shutting down ({addr_str}).");
                            break;
                        }
                    }
                    accept_res = listener.accept() => {
                        match accept_res {
                            Ok((tcp_stream, client_addr)) => {
                                let conn_ctx = ctx.clone();
                                let conn_lifecycle = lifecycle.clone();
                                let local_proxy_port = tcp_stream.local_addr().ok().map(|a| a.port()).or(Some(actual_port));
                                tokio::spawn(serve_connection(
                                    tcp_stream,
                                    client_addr,
                                    local_proxy_port,
                                    conn_lifecycle,
                                    conn_ctx,
                                ));
                            }
                            Err(err) => {
                                tracing::warn!("TCP accept error on {addr_str}: {err}");
                            }
                        }
                    }
                }
            }
        })
    }

    fn spawn_listeners_for_bind(
        &self,
        listeners: Vec<(TcpListener, String)>,
        actual_port: u16,
    ) -> (
        watch::Sender<bool>,
        Vec<tokio::task::JoinHandle<()>>,
        ConnectionLifecycleHandle,
    ) {
        let (tx, rx) = watch::channel(false);
        let lifecycle_handle = ConnectionLifecycleHandle::new();
        let mut handles = Vec::with_capacity(listeners.len());
        for (listener, ip) in listeners {
            let addr_str = format_bind_sock_addr(&ip, actual_port);
            let handle = self.spawn_accept_loop(
                listener,
                addr_str,
                actual_port,
                rx.clone(),
                lifecycle_handle.lifecycle(),
            );
            handles.push(handle);
        }
        (tx, handles, lifecycle_handle)
    }

    pub async fn start_with_config(&self, port: u16) -> Result<ProxyStatus, ProxyError> {
        let (bind_mode, specific_bind_ip, also_bind_loopback) = {
            let guard = self.lock_runtime();
            (
                guard.bind_mode,
                guard.specific_bind_ip.clone(),
                guard.also_bind_loopback,
            )
        };
        self.start_internal(bind_mode, specific_bind_ip, also_bind_loopback, port)
            .await
    }

    pub async fn start(&self, host: String, port: u16) -> Result<ProxyStatus, ProxyError> {
        let trimmed = host.trim().to_string();
        let also_bind_loopback = self.lock_runtime().also_bind_loopback;
        let (bind_mode, specific_bind_ip) = if trimmed == "0.0.0.0" || trimmed == "::" {
            (BindHostMode::AllInterfaces, None)
        } else if trimmed.is_empty()
            || trimmed == "127.0.0.1"
            || trimmed.eq_ignore_ascii_case("localhost")
        {
            (BindHostMode::Loopback, None)
        } else {
            (BindHostMode::Specific, Some(trimmed))
        };
        self.start_internal(bind_mode, specific_bind_ip, also_bind_loopback, port)
            .await
    }

    async fn start_internal(
        &self,
        bind_mode: BindHostMode,
        specific_bind_ip: Option<String>,
        also_bind_loopback: bool,
        port: u16,
    ) -> Result<ProxyStatus, ProxyError> {
        let _op = self.op_lock.lock().await;

        let (already_running, auto_system_proxy) = {
            let guard = self.lock_runtime();
            (guard.shutdown_tx.is_some(), guard.auto_system_proxy)
        };
        if already_running {
            return Ok(self.build_status());
        }

        let (eff_mode, primary_host, norm_specific_ip, target_ips, allow_remote) =
            resolve_bind_plan(bind_mode, specific_bind_ip.as_deref(), also_bind_loopback)?;

        let upstream_cfg = self.context.upstream_proxy.get_public_config();
        if port > 0 {
            validate_no_upstream_proxy_self_loop(&upstream_cfg, port, &target_ips)?;
        }

        let (listeners, actual_port) =
            match bind_listeners_with_cleanup(&target_ips, port, 1).await {
                Ok(bound) => bound,
                Err(err) => {
                    self.sysproxy.rollback_if_dirty();
                    return Err(err);
                }
            };

        if port == 0 {
            if let Err(err) =
                validate_no_upstream_proxy_self_loop(&upstream_cfg, actual_port, &target_ips)
            {
                drop(listeners);
                self.sysproxy.rollback_if_dirty();
                return Err(err);
            }
        }

        if port > 0 {
            self.sysproxy.save_proxy_port_pref(actual_port);
        }

        let (tx, handles, lifecycle_handle) = self.spawn_listeners_for_bind(listeners, actual_port);

        {
            let mut guard = self.lock_runtime();
            guard.bind_addr = (primary_host, actual_port);
            guard.bind_mode = eff_mode;
            guard.specific_bind_ip = norm_specific_ip.clone();
            guard.also_bind_loopback = also_bind_loopback;
            guard.bound_ips = target_ips;
            guard.allow_remote = allow_remote;
            guard.shutdown_tx = Some(tx);
            guard.listener_handles = handles;
            guard.active_lifecycle = Some(lifecycle_handle);
        }

        let sysproxy_host = resolve_sysproxy_host_for_bind(
            eff_mode,
            norm_specific_ip.as_deref(),
            also_bind_loopback,
        );
        if auto_system_proxy {
            if let Err(err) = self.sysproxy.enable(&sysproxy_host, actual_port) {
                tracing::warn!(
                    "FluxProxy bound port {actual_port}, but OS system proxy setup failed for {sysproxy_host}:{actual_port}: {err}"
                );
            }
        } else {
            self.sysproxy.rollback_if_dirty();
        }

        let status = self.build_status();
        self.emit_status_changed(&status);
        Ok(status)
    }

    /// Configures network interface binding (`Loopback`, `AllInterfaces`, or `Specific` IP with optional
    /// secondary `127.0.0.1` Dual Listener for OS system proxy), seamlessly rebinding active sockets
    /// and updating OS system proxy if enabled.
    pub async fn set_bind_configuration(
        &self,
        bind_mode: BindHostMode,
        specific_bind_ip: Option<String>,
        also_bind_loopback: bool,
    ) -> Result<ProxyStatus, ProxyError> {
        let _op = self.op_lock.lock().await;

        let (eff_mode, primary_host, norm_specific_ip, target_ips, allow_remote) =
            resolve_bind_plan(bind_mode, specific_bind_ip.as_deref(), also_bind_loopback)?;

        let check_port = {
            let guard = self.lock_runtime();
            if guard.shutdown_tx.is_some() {
                guard.bind_addr.1
            } else {
                let ap = self.context.active_port.load(Ordering::Relaxed);
                if ap > 0 {
                    ap
                } else {
                    guard.bind_addr.1
                }
            }
        };
        validate_no_upstream_proxy_self_loop(
            &self.context.upstream_proxy.get_public_config(),
            check_port,
            &target_ips,
        )?;

        let (
            was_running,
            port,
            auto_system_proxy,
            prev_mode,
            prev_primary,
            prev_specific_ip,
            prev_also_loopback,
            prev_bound_ips,
            prev_allow_remote,
            already_same_config,
            old_tx,
            old_handles,
        ) = {
            let mut guard = self.lock_runtime();
            let running = guard.shutdown_tx.is_some();
            let same = guard.bind_mode == eff_mode
                && guard.specific_bind_ip == norm_specific_ip
                && guard.also_bind_loopback == also_bind_loopback
                && guard.bound_ips == target_ips;
            let p_mode = guard.bind_mode;
            let p_primary = guard.bind_addr.0.clone();
            let p_port = guard.bind_addr.1;
            let p_spec = guard.specific_bind_ip.clone();
            let p_loop = guard.also_bind_loopback;
            let p_bound = guard.bound_ips.clone();
            let p_allow = guard.allow_remote;
            let auto_sys = guard.auto_system_proxy;
            let tx = if running && !same {
                guard.shutdown_tx.take()
            } else {
                None
            };
            let handles = if running && !same {
                std::mem::take(&mut guard.listener_handles)
            } else {
                Vec::new()
            };
            if running && !same {
                let narrowing = is_bind_narrowing(p_mode, &p_bound, eff_mode, &target_ips);
                let drain_deadline = guard.drain_deadline;
                if let Some(old_lc) = guard.active_lifecycle.take() {
                    if narrowing {
                        old_lc.abort_now();
                    } else {
                        old_lc.begin_drain(drain_deadline);
                        guard.draining_lifecycles.push(old_lc);
                    }
                }
                if narrowing {
                    for lc in std::mem::take(&mut guard.draining_lifecycles) {
                        lc.abort_now();
                    }
                } else {
                    guard.draining_lifecycles.retain(|h| !h.is_finished());
                }
            }
            if !running {
                guard.bind_addr.0 = primary_host.clone();
                guard.bind_mode = eff_mode;
                guard.specific_bind_ip = norm_specific_ip.clone();
                guard.also_bind_loopback = also_bind_loopback;
                guard.bound_ips = target_ips.clone();
                guard.allow_remote = allow_remote;
            }
            (
                running,
                p_port,
                auto_sys,
                p_mode,
                p_primary,
                p_spec,
                p_loop,
                p_bound,
                p_allow,
                same,
                tx,
                handles,
            )
        };

        self.sysproxy.save_bind_config_pref(
            eff_mode,
            norm_specific_ip.clone(),
            also_bind_loopback,
        );

        if !was_running || already_same_config {
            let status = self.build_status();
            if !already_same_config {
                self.emit_status_changed(&status);
            }
            return Ok(status);
        }

        // Stop previous TCP listener(s) synchronously before rebinding the same port on the new interface(s)
        shutdown_listeners(old_tx, old_handles).await;

        match bind_listeners_with_cleanup(&target_ips, port, 8).await {
            Ok((listeners, actual_port)) => {
                let (tx, handles, lifecycle_handle) =
                    self.spawn_listeners_for_bind(listeners, actual_port);
                {
                    let mut guard = self.lock_runtime();
                    guard.bind_addr = (primary_host, actual_port);
                    guard.bind_mode = eff_mode;
                    guard.specific_bind_ip = norm_specific_ip.clone();
                    guard.also_bind_loopback = also_bind_loopback;
                    guard.bound_ips = target_ips;
                    guard.allow_remote = allow_remote;
                    guard.shutdown_tx = Some(tx);
                    guard.listener_handles = handles;
                    guard.active_lifecycle = Some(lifecycle_handle);
                }

                let sysproxy_enabled_before = self.sysproxy.is_desired_enabled();
                if auto_system_proxy || sysproxy_enabled_before {
                    let sysproxy_host = resolve_sysproxy_host_for_bind(
                        eff_mode,
                        norm_specific_ip.as_deref(),
                        also_bind_loopback,
                    );
                    if let Err(err) = self.sysproxy.enable(&sysproxy_host, actual_port) {
                        tracing::warn!(
                            "Failed to update OS system proxy target to {sysproxy_host}:{actual_port}: {err}"
                        );
                    }
                }

                let status = self.build_status();
                self.emit_status_changed(&status);
                Ok(status)
            }
            Err(err) => {
                // Attempt best-effort recovery onto previous bind configuration so capture isn't stranded
                self.sysproxy.save_bind_config_pref(
                    prev_mode,
                    prev_specific_ip.clone(),
                    prev_also_loopback,
                );
                if let Ok((fallback_listeners, actual_port)) =
                    bind_listeners_with_cleanup(&prev_bound_ips, port, 3).await
                {
                    let (tx, handles, lifecycle_handle) =
                        self.spawn_listeners_for_bind(fallback_listeners, actual_port);
                    let mut guard = self.lock_runtime();
                    guard.bind_addr = (prev_primary, actual_port);
                    guard.bind_mode = prev_mode;
                    guard.specific_bind_ip = prev_specific_ip;
                    guard.also_bind_loopback = prev_also_loopback;
                    guard.bound_ips = prev_bound_ips;
                    guard.allow_remote = prev_allow_remote;
                    guard.shutdown_tx = Some(tx);
                    guard.listener_handles = handles;
                    guard.active_lifecycle = Some(lifecycle_handle);
                } else {
                    {
                        let mut guard = self.lock_runtime();
                        guard.bind_mode = prev_mode;
                        guard.bind_addr = (prev_primary, port);
                        guard.specific_bind_ip = prev_specific_ip;
                        guard.also_bind_loopback = prev_also_loopback;
                        guard.bound_ips = prev_bound_ips;
                        guard.allow_remote = prev_allow_remote;
                    }
                    self.sysproxy.rollback_if_dirty();
                }
                let rollback_status = self.build_status();
                self.emit_status_changed(&rollback_status);
                Err(err)
            }
        }
    }

    /// Toggles «Allow remote connections / Listen on all network interfaces (`0.0.0.0`)» for
    /// backward compatibility, mapping to `Loopback` vs `AllInterfaces`.
    pub async fn set_allow_remote(&self, allow: bool) -> Result<ProxyStatus, ProxyError> {
        let also_bind_loopback = self.lock_runtime().also_bind_loopback;
        let mode = if allow {
            BindHostMode::AllInterfaces
        } else {
            BindHostMode::Loopback
        };
        self.set_bind_configuration(mode, None, also_bind_loopback)
            .await
    }

    /// Updates the proxy listener port. When the proxy is stopped, persists the new port
    /// preference immediately; when running, atomically rebinds active listeners with rollback
    /// to the previous port on failure.
    pub async fn set_port(&self, port: u16) -> Result<ProxyStatus, ProxyError> {
        if port == 0 {
            return Err(ProxyError::Custom(
                "Порт прокси должен быть целым числом от 1 до 65535".to_string(),
            ));
        }

        let _op = self.op_lock.lock().await;
        let bound_ips_for_check = self.lock_runtime().bound_ips.clone();
        validate_no_upstream_proxy_self_loop(
            &self.context.upstream_proxy.get_public_config(),
            port,
            &bound_ips_for_check,
        )?;

        let (
            was_running,
            prev_port,
            auto_system_proxy,
            eff_mode,
            norm_specific_ip,
            also_bind_loopback,
            bound_ips,
            old_tx,
            old_handles,
        ) = {
            let mut guard = self.lock_runtime();
            let running = guard.shutdown_tx.is_some();
            let current_port = guard.bind_addr.1;
            if current_port == port {
                let _ = running;
                drop(guard);
                self.sysproxy.save_proxy_port_pref(port);
                return Ok(self.build_status());
            }
            if !running {
                guard.bind_addr.1 = port;
                drop(guard);
                self.context.active_port.store(port, Ordering::Relaxed);
                self.sysproxy.save_proxy_port_pref(port);
                let status = self.build_status();
                self.emit_status_changed(&status);
                return Ok(status);
            }
            if let Some(old_lc) = guard.active_lifecycle.take() {
                old_lc.abort_now();
            }
            for lc in std::mem::take(&mut guard.draining_lifecycles) {
                lc.abort_now();
            }
            (
                running,
                current_port,
                guard.auto_system_proxy,
                guard.bind_mode,
                guard.specific_bind_ip.clone(),
                guard.also_bind_loopback,
                guard.bound_ips.clone(),
                guard.shutdown_tx.take(),
                std::mem::take(&mut guard.listener_handles),
            )
        };

        let _ = was_running;
        shutdown_listeners(old_tx, old_handles).await;

        match bind_listeners_with_cleanup(&bound_ips, port, 8).await {
            Ok((listeners, actual_port)) => {
                let (tx, handles, lifecycle_handle) =
                    self.spawn_listeners_for_bind(listeners, actual_port);
                {
                    let mut guard = self.lock_runtime();
                    guard.bind_addr.1 = actual_port;
                    guard.shutdown_tx = Some(tx);
                    guard.listener_handles = handles;
                    guard.active_lifecycle = Some(lifecycle_handle);
                }
                self.sysproxy.save_proxy_port_pref(actual_port);

                let sysproxy_enabled_before = self.sysproxy.is_desired_enabled();
                if auto_system_proxy || sysproxy_enabled_before {
                    let sysproxy_host = resolve_sysproxy_host_for_bind(
                        eff_mode,
                        norm_specific_ip.as_deref(),
                        also_bind_loopback,
                    );
                    if let Err(err) = self.sysproxy.enable(&sysproxy_host, actual_port) {
                        tracing::warn!(
                            "Failed to update OS system proxy target to {sysproxy_host}:{actual_port}: {err}"
                        );
                    }
                }

                let status = self.build_status();
                self.emit_status_changed(&status);
                Ok(status)
            }
            Err(err) => {
                if let Ok((fallback_listeners, fallback_port)) =
                    bind_listeners_with_cleanup(&bound_ips, prev_port, 3).await
                {
                    let (tx, handles, lifecycle_handle) =
                        self.spawn_listeners_for_bind(fallback_listeners, fallback_port);
                    {
                        let mut guard = self.lock_runtime();
                        guard.bind_addr.1 = fallback_port;
                        guard.shutdown_tx = Some(tx);
                        guard.listener_handles = handles;
                        guard.active_lifecycle = Some(lifecycle_handle);
                    }
                    let sysproxy_enabled_before = self.sysproxy.is_desired_enabled();
                    if auto_system_proxy || sysproxy_enabled_before {
                        let sysproxy_host = resolve_sysproxy_host_for_bind(
                            eff_mode,
                            norm_specific_ip.as_deref(),
                            also_bind_loopback,
                        );
                        let _ = self.sysproxy.enable(&sysproxy_host, fallback_port);
                    }
                } else {
                    {
                        let mut guard = self.lock_runtime();
                        guard.bind_addr.1 = prev_port;
                    }
                    self.context.active_port.store(prev_port, Ordering::Relaxed);
                    self.sysproxy.rollback_if_dirty();
                }

                let rollback_status = self.build_status();
                self.emit_status_changed(&rollback_status);
                Err(err)
            }
        }
    }

    pub async fn stop(&self) -> ProxyStatus {
        let _op = self.op_lock.lock().await;
        self.context
            .breakpoints
            .resume_all(BreakpointAction::Continue);
        let (tx, handles) = {
            let mut guard = self.lock_runtime();
            let drain_deadline = guard.drain_deadline;
            guard.draining_lifecycles.retain(|h| !h.is_finished());
            if let Some(old_lc) = guard.active_lifecycle.take() {
                old_lc.begin_drain(drain_deadline);
                guard.draining_lifecycles.push(old_lc);
            }
            (
                guard.shutdown_tx.take(),
                std::mem::take(&mut guard.listener_handles),
            )
        };
        shutdown_listeners(tx, handles).await;
        if let Err(err) = self.sysproxy.disable() {
            tracing::warn!("Could not roll back OS system proxy on stop: {err}");
        }
        let status = self.build_status();
        self.emit_status_changed(&status);
        status
    }

    /// Manually enables or disables the OS system proxy independently of the local TCP listener
    /// (allowing `HTTP_PROXY=http://127.0.0.1:8888` CLI-only capture without routing OS browsers).
    pub async fn set_system_proxy(&self, enabled: bool) -> Result<ProxyStatus, ProxyError> {
        let _op = self.op_lock.lock().await;
        let (sysproxy_host, port) = {
            let guard = self.lock_runtime();
            (
                resolve_sysproxy_host_for_bind(
                    guard.bind_mode,
                    guard.specific_bind_ip.as_deref(),
                    guard.also_bind_loopback,
                ),
                guard.bind_addr.1,
            )
        };

        if enabled {
            if let Err(err) = self.sysproxy.enable(&sysproxy_host, port) {
                tracing::warn!("Manual set_system_proxy(true) failed: {err}");
            }
        } else if let Err(err) = self.sysproxy.disable() {
            tracing::warn!("Manual set_system_proxy(false) failed: {err}");
        }

        let status = self.build_status();
        self.emit_status_changed(&status);
        Ok(status)
    }

    /// Toggles Fiddler-style «Act as System Proxy» mode when capture starts/stops.
    pub async fn set_auto_system_proxy(&self, auto: bool) -> Result<ProxyStatus, ProxyError> {
        let _op = self.op_lock.lock().await;
        let (running, sysproxy_host, port) = {
            let mut guard = self.lock_runtime();
            guard.auto_system_proxy = auto;
            (
                guard.shutdown_tx.is_some(),
                resolve_sysproxy_host_for_bind(
                    guard.bind_mode,
                    guard.specific_bind_ip.as_deref(),
                    guard.also_bind_loopback,
                ),
                guard.bind_addr.1,
            )
        };
        self.sysproxy.save_auto_system_proxy_pref(auto);

        if auto && running {
            let (currently_enabled, _) = self.sysproxy.status_for_listener(&sysproxy_host, port);
            if !currently_enabled {
                if let Err(err) = self.sysproxy.enable(&sysproxy_host, port) {
                    tracing::warn!("Auto system proxy attach failed: {err}");
                }
            }
        }

        let status = self.build_status();
        self.emit_status_changed(&status);
        Ok(status)
    }

    /// Synchronous, deadlock-free shutdown + OS proxy rollback invoked on window close and app exit.
    pub fn shutdown_sync(&self) {
        self.context
            .breakpoints
            .resume_all(BreakpointAction::Continue);
        let pending_composer_ids: Vec<String> = self
            .active_composer_requests
            .iter()
            .map(|entry| entry.key().clone())
            .collect();
        for req_id in pending_composer_ids {
            if let Some((_, tx)) = self.active_composer_requests.remove(&req_id) {
                let _ = tx.send(());
            }
        }
        self.context.script_runner.shutdown_sync();
        {
            let mut guard = self.lock_runtime();
            if let Some(lc) = guard.active_lifecycle.take() {
                lc.abort_now();
            }
            for lc in std::mem::take(&mut guard.draining_lifecycles) {
                lc.abort_now();
            }
            if let Some(tx) = guard.shutdown_tx.take() {
                let _ = tx.send(true);
            }
            guard.listener_handles.clear();
        }
        self.sysproxy.rollback_sync();
    }

    pub fn get_upstream_timeouts(&self) -> crate::models::UpstreamTimeoutConfig {
        self.context.upstream_timeout_config()
    }

    pub fn set_upstream_timeouts(
        &self,
        config: crate::models::UpstreamTimeoutConfig,
    ) -> Result<crate::models::UpstreamTimeoutConfig, ProxyError> {
        config.validate()?;
        let normalized = config.normalized();
        self.context
            .connect_timeout_sec
            .store(normalized.connect_timeout_sec, Ordering::Relaxed);
        self.context
            .response_header_timeout_sec
            .store(normalized.response_header_timeout_sec, Ordering::Relaxed);
        self.context
            .composer_timeout_sec
            .store(normalized.composer_timeout_sec, Ordering::Relaxed);
        self.sysproxy.save_upstream_timeouts_pref(&normalized)?;
        Ok(normalized)
    }

    pub fn cancel_composed_request(&self, request_id: &str) -> bool {
        if let Some((_, tx)) = self.active_composer_requests.remove(request_id) {
            let _ = tx.send(());
            true
        } else {
            false
        }
    }

    pub fn get_upstream_proxy_config(&self) -> UpstreamProxyConfig {
        self.context.upstream_proxy.get_public_config()
    }

    pub fn set_upstream_proxy_config(
        &self,
        config: UpstreamProxyConfig,
    ) -> Result<UpstreamProxyConfig, ProxyError> {
        if config.enabled {
            let (effective_port, bound_ips) = {
                let guard = self.lock_runtime();
                let port = self.context.active_port.load(Ordering::Relaxed);
                let effective_port = if port > 0 { port } else { guard.bind_addr.1 };
                (effective_port, guard.bound_ips.clone())
            };
            validate_no_upstream_proxy_self_loop(&config, effective_port, &bound_ips)?;
        }

        let saved = self.context.upstream_proxy.set_config(config)?;
        self.context.rebuild_upstream_clients();
        Ok(saved)
    }
}

#[allow(clippy::too_many_arguments)]
fn record_and_return_error(
    ctx: &SharedProxyContext,
    session_id: u64,
    scheme: &str,
    method: &str,
    host: &str,
    path: &str,
    url: &str,
    req_headers: Vec<HeaderPair>,
    req_body: Bytes,
    start: Instant,
    timestamp: String,
    client_addr: SocketAddr,
    client_proc: Option<&ClientProcessInfo>,
    tls_bypassed: bool,
    breakpoint_modified: bool,
    err_msg: String,
) -> Response<ProxyBoxBody> {
    record_and_return_error_with_opts(
        ctx,
        session_id,
        scheme,
        method,
        host,
        path,
        url,
        req_headers,
        req_body,
        start,
        timestamp,
        client_addr,
        client_proc,
        tls_bypassed,
        breakpoint_modified,
        StatusCode::BAD_GATEWAY,
        None,
        err_msg,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn record_and_return_error_with_opts(
    ctx: &SharedProxyContext,
    session_id: u64,
    scheme: &str,
    method: &str,
    host: &str,
    path: &str,
    url: &str,
    req_headers: Vec<HeaderPair>,
    req_body: Bytes,
    start: Instant,
    timestamp: String,
    client_addr: SocketAddr,
    client_proc: Option<&ClientProcessInfo>,
    tls_bypassed: bool,
    breakpoint_modified: bool,
    status_code: StatusCode,
    remapped_to: Option<String>,
    err_msg: String,
) -> Response<ProxyBoxBody> {
    record_and_return_error_with_opts_and_code(
        ctx,
        session_id,
        scheme,
        method,
        host,
        path,
        url,
        req_headers,
        req_body,
        start,
        timestamp,
        client_addr,
        client_proc,
        tls_bypassed,
        breakpoint_modified,
        status_code,
        remapped_to,
        err_msg,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn record_and_return_error_with_opts_and_code(
    ctx: &SharedProxyContext,
    session_id: u64,
    scheme: &str,
    method: &str,
    host: &str,
    path: &str,
    url: &str,
    req_headers: Vec<HeaderPair>,
    req_body: Bytes,
    start: Instant,
    timestamp: String,
    client_addr: SocketAddr,
    client_proc: Option<&ClientProcessInfo>,
    tls_bypassed: bool,
    breakpoint_modified: bool,
    status_code: StatusCode,
    remapped_to: Option<String>,
    err_msg: String,
    proxy_error_code: Option<&str>,
) -> Response<ProxyBoxBody> {
    let protocol = if tls_bypassed {
        "TLS-BYPASS".into()
    } else {
        scheme.to_ascii_uppercase()
    };
    record_error_session_with_telemetry_and_code(
        ctx,
        session_id,
        protocol,
        scheme,
        method,
        host,
        path,
        url,
        req_headers,
        &req_body,
        start.elapsed().as_millis() as u64,
        timestamp,
        client_proc.map(|p| p.name.clone()),
        client_proc.map(|p| p.pid),
        tls_bypassed,
        false,
        breakpoint_modified,
        Some(normalize_client_ip(client_addr)),
        client_addr.to_string(),
        status_code.as_u16(),
        remapped_to,
        None,
        None,
        &err_msg,
        proxy_error_code,
    );
    plain_response_with_proxy_error(status_code, &err_msg, proxy_error_code)
}

fn boxed_full(bytes: Bytes) -> ProxyBoxBody {
    Full::new(bytes).boxed()
}

pub(super) fn plain_response(status: StatusCode, msg: &str) -> Response<ProxyBoxBody> {
    plain_response_with_proxy_error(status, msg, None)
}

pub(super) fn plain_response_with_proxy_error(
    status: StatusCode,
    msg: &str,
    proxy_error_code: Option<&str>,
) -> Response<ProxyBoxBody> {
    let mut builder = Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8");
    if let Some(code) = proxy_error_code {
        builder = builder.header(FLUXPROXY_ERROR_HEADER, code);
    }
    builder.body(boxed_full(Bytes::from(msg.to_owned()))).unwrap()
}

fn split_authority(authority: &str) -> (String, u16) {
    let trimmed = authority.trim();
    if let Ok(sock) = trimmed.parse::<SocketAddr>() {
        return (sock.ip().to_string(), sock.port());
    }
    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some((ipv6, tail)) = rest.split_once(']') {
            let port = tail
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(443);
            return (ipv6.trim().to_string(), port);
        }
    }
    if trimmed.parse::<IpAddr>().is_ok() {
        return (trimmed.to_string(), 443);
    }
    if let Some((h, p)) = trimmed.rsplit_once(':') {
        if !h.contains(':') {
            if let Ok(port) = p.parse::<u16>() {
                return (h.to_string(), port);
            }
        }
    }
    (trimmed.trim_matches(['[', ']']).to_string(), 443)
}

fn extract_hyper_headers(map: &http::HeaderMap) -> Vec<HeaderPair> {
    map.iter()
        .map(|(k, v)| match v.to_str() {
            Ok(s) => HeaderPair::new(k.as_str(), s),
            Err(_) => {
                let raw = v.as_bytes();
                HeaderPair {
                    name: k.as_str().to_string(),
                    value: HeaderPair::display_value_for_raw_bytes(raw),
                    raw_bytes_b64: Some(base64::engine::general_purpose::STANDARD.encode(raw)),
                }
            }
        })
        .collect()
}

fn format_raw_http_version(version: Version) -> &'static str {
    match version {
        Version::HTTP_09 => "HTTP/0.9",
        Version::HTTP_10 => "HTTP/1.0",
        Version::HTTP_11 => "HTTP/1.1",
        Version::HTTP_2 => "HTTP/2.0",
        Version::HTTP_3 => "HTTP/3.0",
        _ => "HTTP/1.1",
    }
}

fn format_mitm_tls_display(
    scheme: &str,
    client_tls_version: Option<&str>,
    suffix: Option<&str>,
    mtls_cn: Option<&str>,
) -> Option<String> {
    if !scheme.eq_ignore_ascii_case("https") && !scheme.eq_ignore_ascii_case("wss") {
        return None;
    }
    let proto = client_tls_version
        .filter(|s| !s.is_empty())
        .unwrap_or("TLS");
    let mode = match suffix {
        Some(s) if !s.is_empty() => format!("MITM {s}"),
        _ => "MITM".to_string(),
    };
    let base = format!("{proto} ({mode})");
    Some(match mtls_cn {
        Some(cn) if !cn.is_empty() => format!("{base} · mTLS: {cn}"),
        _ => base,
    })
}

fn resolve_protocol_label(scheme: &str, alpn: Option<&str>, version: Version) -> String {
    if scheme == "https" {
        if matches!(alpn, Some("h2")) || version == Version::HTTP_2 {
            return "HTTPS/2".to_string();
        }
        return "HTTPS/1.1".to_string();
    }
    if version == Version::HTTP_2 {
        "HTTP/2".to_string()
    } else {
        "HTTP/1.1".to_string()
    }
}

fn format_http_version(scheme: &str, version: http::Version) -> String {
    match (scheme, version) {
        ("https", Version::HTTP_2) => "HTTPS/2".into(),
        ("https", _) => "HTTPS/1.1".into(),
        (_, Version::HTTP_2) => "HTTP/2".into(),
        _ => "HTTP/1.1".into(),
    }
}

fn is_hop_by_hop_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "proxy-connection"
    )
}

fn parse_host_and_optional_port(raw_host: &str) -> (String, Option<u16>) {
    let trimmed = raw_host.trim();
    if let Ok(sock) = trimmed.parse::<SocketAddr>() {
        return (sock.ip().to_string(), Some(sock.port()));
    }
    if trimmed.parse::<IpAddr>().is_ok() {
        return (trimmed.to_ascii_lowercase(), None);
    }
    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some((ipv6, tail)) = rest.split_once(']') {
            let port = tail.strip_prefix(':').and_then(|p| p.parse::<u16>().ok());
            return (ipv6.to_ascii_lowercase(), port);
        }
    }
    if let Some((h, p)) = trimmed.rsplit_once(':') {
        if !h.contains(':') || h.parse::<IpAddr>().is_ok() {
            if let Ok(port) = p.parse::<u16>() {
                return (h.to_ascii_lowercase(), Some(port));
            }
        }
    }
    (trimmed.to_ascii_lowercase(), None)
}

fn extract_mapped_ipv4(v6: std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    if let Some(v4) = v6.to_ipv4_mapped() {
        return Some(v4);
    }
    let segs = v6.segments();
    if segs[0..6] == [0; 6] && !v6.is_loopback() && !v6.is_unspecified() {
        return Some(std::net::Ipv4Addr::new(
            (segs[6] >> 8) as u8,
            segs[6] as u8,
            (segs[7] >> 8) as u8,
            segs[7] as u8,
        ));
    }
    None
}

pub(crate) fn is_loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || extract_mapped_ipv4(v6).is_some_and(|v4| v4.is_loopback())
        }
    }
}

pub(crate) fn is_unspecified_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_unspecified(),
        IpAddr::V6(v6) => {
            v6.is_unspecified() || extract_mapped_ipv4(v6).is_some_and(|v4| v4.is_unspecified())
        }
    }
}

pub(crate) fn is_forbidden_remote_target_ip(ip: IpAddr) -> bool {
    is_loopback_ip(ip) || is_unspecified_ip(ip)
}

pub(crate) fn validate_resolved_addrs_for_peer(
    addrs: &[SocketAddr],
    peer_is_remote: bool,
    target_label: &str,
) -> Result<(), String> {
    if !peer_is_remote {
        return Ok(());
    }
    if let Some(blocked) = addrs
        .iter()
        .find(|addr| is_forbidden_remote_target_ip(addr.ip()))
    {
        return Err(format!(
            "Forbidden: remote LAN clients cannot connect to loopback or unspecified IP {} (resolved from {target_label})",
            blocked.ip()
        ));
    }
    Ok(())
}


fn parse_ip_including_mapped_and_shorthand(host_clean: &str) -> Option<IpAddr> {
    if let Ok(ip) = host_clean.parse::<IpAddr>() {
        return Some(ip);
    }
    let bracketed = if host_clean.contains(':') && !host_clean.starts_with('[') {
        format!("[{host_clean}]")
    } else {
        host_clean.to_string()
    };
    let parsed = reqwest::Url::parse(&format!("http://{bracketed}/")).ok()?;
    let h = parsed.host_str()?.trim_matches(['[', ']']);
    h.parse::<IpAddr>().ok()
}

pub(crate) fn is_loopback_or_unspecified_host(raw_host: &str) -> bool {
    let (host_only, _) = parse_host_and_optional_port(raw_host);
    let clean = host_only.trim_end_matches('.');
    if clean.is_empty() {
        return false;
    }
    if clean == "localhost"
        || clean.ends_with(".localhost")
        || clean == "ip6-localhost"
        || clean == "ip6-loopback"
    {
        return true;
    }
    if let Some(ip) = parse_ip_including_mapped_and_shorthand(clean) {
        return is_loopback_ip(ip) || is_unspecified_ip(ip);
    }
    false
}

fn request_targets_loopback_or_unspecified(host_header: &str, full_url: &str) -> bool {
    if is_loopback_or_unspecified_host(host_header) {
        return true;
    }
    if let Ok(parsed) = reqwest::Url::parse(full_url) {
        if let Some(url_host) = parsed.host_str() {
            if is_loopback_or_unspecified_host(url_host) {
                return true;
            }
        }
    }
    false
}

fn should_use_host_mtls_for_peer(peer_addr: SocketAddr, scheme: &str) -> bool {
    (scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("wss"))
        && is_loopback_ip(peer_addr.ip())
}


#[cfg(test)]
mod tests {
    use super::http_handler::*;
    use super::mobile_portal::*;
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use http_body_util::StreamBody;
    use hyper::body::Frame;
    use tokio::net::TcpStream;
    use tokio_tungstenite::tungstenite::protocol::Role;
    use tokio_tungstenite::WebSocketStream;
    use crate::models::{BreakpointStage, ComposedRequest, RuleActionType};
    use crate::models::{
        BreakpointConfig, BreakpointResolution, ProxyFilterBackendConfig, TlsBypassRule,
        TlsInterceptMode,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn test_upstream_http_client(
        host_remap: Option<Arc<HostRemapRegistry>>,
    ) -> std::sync::RwLock<Arc<UpstreamHttpClient>> {
        std::sync::RwLock::new(Arc::new(
            UpstreamHttpClient::build(
                host_remap,
                None,
                None,
                Arc::new(std::sync::atomic::AtomicU64::new(
                    crate::models::DEFAULT_CONNECT_TIMEOUT_SEC,
                )),
                false,
            )
            .unwrap(),
        ))
    }

    fn test_remote_upstream_http_client(
        host_remap: Option<Arc<HostRemapRegistry>>,
    ) -> std::sync::RwLock<Arc<UpstreamHttpClient>> {
        std::sync::RwLock::new(Arc::new(
            UpstreamHttpClient::build(
                host_remap,
                None,
                None,
                Arc::new(std::sync::atomic::AtomicU64::new(
                    crate::models::DEFAULT_CONNECT_TIMEOUT_SEC,
                )),
                true,
            )
            .unwrap(),
        ))
    }

    #[tokio::test]
    async fn connect_tls_bypass_relays_raw_bytes_via_copy_bidirectional() {
        // 1. Start mock upstream "pinned TLS" raw TCP echo endpoint
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();

        tokio::spawn(async move {
            if let Ok((mut sock, _)) = upstream_listener.accept().await {
                let mut buf = [0u8; 64];
                if let Ok(n) = sock.read(&mut buf).await {
                    let _ = sock.write_all(&buf[..n]).await;
                }
                let _ = sock.shutdown().await;
            }
        });

        // 2. Initialize SharedProxyContext with 127.0.0.1 in TLS Bypass list
        let tmp_dir =
            std::env::temp_dir().join(format!("fluxproxy-test-bypass-{}", std::process::id()));
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        filters.update_config(ProxyFilterBackendConfig {
            tls_intercept_mode: TlsInterceptMode::InterceptAll,
            tls_bypass_enabled: true,
            tls_bypass_rules: vec![TlsBypassRule {
                id: "test-loopback-pin".into(),
                enabled: true,
                pattern: "127.0.0.1".into(),
                category: "Test".into(),
                description: "Loopback pinned endpoint".into(),
            }],
            tls_target_rules: Vec::new(),
            header_mutations_enabled: true,
            header_mutations: Vec::new(),
            strip_alt_svc: true,
            host_list_sync: Default::default(),
            ..crate::proxy::filters::default_backend_config()
        });
        let store = Arc::new(TrafficStore::new(tmp_dir.join("test.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        // 3. Bind outer proxy listener and issue CONNECT tunnel
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let proc_info = resolve_client_process_async(client_addr, Some(proxy_addr.port())).await;
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let c = proxy_ctx.clone();
                    let p = proc_info.clone();
                    async move {
                        Ok::<_, Infallible>(handle_outer_proxy_request(req, client_addr, p, ClientConnContext::new(), c).await)
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            }
        });

        let mut client = TcpStream::connect(proxy_addr).await.unwrap();
        let connect_req = format!(
            "CONNECT 127.0.0.1:{} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
            upstream_addr.port(),
            upstream_addr.port()
        );
        client.write_all(connect_req.as_bytes()).await.unwrap();

        let mut resp_buf = [0u8; 256];
        let n = client.read(&mut resp_buf).await.unwrap();
        let resp_str = String::from_utf8_lossy(&resp_buf[..n]);
        assert!(resp_str.starts_with("HTTP/1.1 200"));

        // Send raw "encrypted" payload through the passthrough tunnel without TLS MITM
        let payload = b"RAW_PINNED_CLIENT_HELLO";
        client.write_all(payload).await.unwrap();
        let mut echoed = vec![0u8; payload.len()];
        client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, payload);
        drop(client);

        tokio::time::sleep(Duration::from_millis(40)).await;
        let summaries = store.list_summaries();
        assert_eq!(summaries.len(), 1);
        assert!(summaries[0].tls_bypassed);
        assert_eq!(summaries[0].protocol, "TLS-BYPASS");
        assert_eq!(summaries[0].process_pid, Some(std::process::id()));
        assert_eq!(summaries[0].body_size, payload.len() * 2);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn live_breakpoints_intercept_request_and_response_on_oneshot_channel() {
        // 1. Mock HTTP upstream server echoing received request body inside JSON response
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();

        tokio::spawn(async move {
            if let Ok((tcp_stream, _)) = upstream_listener.accept().await {
                let io = TokioIo::new(tcp_stream);
                let svc = service_fn(|req: Request<Incoming>| async move {
                    let req_bytes = req.into_body().collect().await.unwrap().to_bytes();
                    let body_str = String::from_utf8_lossy(&req_bytes);
                    let json = format!("{{\"upstreamSaw\":{body_str},\"ok\":true}}");
                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(CONTENT_TYPE, "application/json")
                            .body(Full::new(Bytes::from(json)))
                            .unwrap(),
                    )
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, svc)
                    .await;
            }
        });

        // 2. Enable BOTH Break Before Request (F11) and Break After Response (Alt+F11)
        let tmp_dir =
            std::env::temp_dir().join(format!("fluxproxy-test-bp-{}", std::process::id()));
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let (bp_tx, mut bp_rx) = mpsc::unbounded_channel();
        let breakpoints = Arc::new(BreakpointEngine::new(Some(bp_tx)));
        breakpoints.update_config(BreakpointConfig {
            break_before_request: true,
            break_after_response: true,
            timeout_secs: 15,
            rules: Vec::new(),
        });
        let store = Arc::new(TrafficStore::new(tmp_dir.join("bp.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints: breakpoints.clone(),
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let c = proxy_ctx.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), c).await,
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            }
        });

        // 3. Spawn simulated UI controller resolving Request Breakpoint -> then Response Breakpoint (mutating status to 500)
        let ui_bp = breakpoints.clone();
        tokio::spawn(async move {
            while let Some(snapshot) = bp_rx.recv().await {
                if let Some(paused) = snapshot.first() {
                    match paused.stage {
                        BreakpointStage::Request => {
                            ui_bp.resolve(BreakpointResolution {
                                breakpoint_id: paused.breakpoint_id.clone(),
                                action: BreakpointAction::Continue,
                                method: None,
                                url: None,
                                request_headers: None,
                                request_body_base64: None,
                                request_body_text: Some("{\"amount\":9999}".into()),
                                status_code: None,
                                response_headers: None,
                                response_body_base64: None,
                                response_body_text: None,
                            });
                        }
                        BreakpointStage::Response => {
                            let orig = paused.response_body_text.clone().unwrap_or_default();
                            assert!(orig.contains("9999"));
                            ui_bp.resolve(BreakpointResolution {
                                breakpoint_id: paused.breakpoint_id.clone(),
                                action: BreakpointAction::Continue,
                                method: None,
                                url: None,
                                request_headers: None,
                                request_body_base64: None,
                                request_body_text: None,
                                status_code: Some(500),
                                response_headers: None,
                                response_body_base64: None,
                                response_body_text: Some(
                                    "{\"error\":\"Injected 500 at Breakpoint\"}".into(),
                                ),
                            });
                            break;
                        }
                        BreakpointStage::Both => {}
                    }
                }
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();

        let resp = client
            .post(format!("http://127.0.0.1:{}/v1/pay", upstream_addr.port()))
            .body("{\"amount\":100}")
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status().as_u16(), 500);
        let text = resp.text().await.unwrap();
        assert_eq!(text, "{\"error\":\"Injected 500 at Breakpoint\"}");

        let detail = store.get(1).unwrap();
        assert!(detail.summary.breakpoint_modified);
        assert!(detail.summary.breakpoint_paused.is_none());

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn parses_sse_event_stream_chunks() {
        let raw = b"id: evt_1\nevent: content_block_delta\ndata: {\"delta\":\"Hello\"}\n\ndata: {\"delta\":\" world\"}\n\ndata: [DONE]\n\n";
        let events = parse_sse_events_from_bytes(raw, 85);
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].id.as_deref(), Some("evt_1"));
        assert_eq!(events[0].event, "content_block_delta");
        assert_eq!(events[0].data, "{\"delta\":\"Hello\"}");
        assert_eq!(events[1].event, "message");
        assert_eq!(events[2].data, "[DONE]");
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)]
    async fn websocket_signalr_forwards_auth_cookies_subprotocol_and_response_headers() {
        use tokio_tungstenite::tungstenite::handshake::server::{Request as WsReq, Response as WsResp};
        use tokio_tungstenite::tungstenite::Message;

        let client_original_ws_key = "dGhlIHNhbXBsZSBub25jZQ==";

        // 1. Mock ASP.NET Core SignalR Hub WebSocket endpoint
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();

        tokio::spawn(async move {
            if let Ok((sock, _)) = upstream_listener.accept().await {
                let mut auth_valid = false;
                let ws_stream = tokio_tungstenite::accept_hdr_async(
                    sock,
                    |req: &WsReq, mut resp: WsResp| {
                        let hdrs = req.headers();
                        let auth = hdrs
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        let cookie = hdrs
                            .get("cookie")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        let subproto = hdrs
                            .get("sec-websocket-protocol")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        let ua = hdrs
                            .get("user-agent")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        let x_signalr = hdrs
                            .get("x-signalr-user-agent")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        let x_req_with = hdrs
                            .get("x-requested-with")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        let ext = hdrs
                            .get("sec-websocket-extensions")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        let upstream_key = hdrs
                            .get("sec-websocket-key")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");

                        // Hop-by-hop Sec-WebSocket-Key must be freshly generated, never duplicated
                        assert_eq!(hdrs.get_all("sec-websocket-key").iter().count(), 1);
                        assert_ne!(upstream_key, client_original_ws_key);

                        // permessage-deflate must be stripped while custom extensions pass through
                        assert!(!ext.contains("permessage-deflate"));
                        assert_eq!(ext, "x-flux-trace; v=1");

                        auth_valid = auth == "Bearer signalr-jwt-token-2026"
                            && cookie.contains(".AspNetCore.Cookies=auth_chunk_1")
                            && cookie.contains("XSRF-TOKEN=csrf_42")
                            && subproto == "json"
                            && ua == "Microsoft.AspNetCore.Http.Connections.Client/8.0.0"
                            && x_signalr == "Microsoft SignalR/8.0"
                            && x_req_with == "XMLHttpRequest";

                        if subproto == "json" {
                            resp.headers_mut().insert(
                                "Sec-WebSocket-Protocol",
                                http::header::HeaderValue::from_static("json"),
                            );
                        }
                        resp.headers_mut().append(
                            http::header::SET_COOKIE,
                            http::header::HeaderValue::from_static("AWSALB=sticky1; Path=/"),
                        );
                        resp.headers_mut().append(
                            http::header::SET_COOKIE,
                            http::header::HeaderValue::from_static(
                                "SRVID=node2; Path=/; HttpOnly",
                            ),
                        );
                        resp.headers_mut().insert(
                            "X-SignalR-Hub",
                            http::header::HeaderValue::from_static("NotificationsHub"),
                        );
                        Ok(resp)
                    },
                )
                .await
                .unwrap();

                let (mut sink, mut stream) = ws_stream.split();
                if let Some(Ok(Message::Text(handshake_frame))) = stream.next().await {
                    assert!(handshake_frame.contains("\"protocol\":\"json\""));
                    if auth_valid {
                        // SignalR empty JSON handshake ack + authorized hub message
                        sink.send(Message::Text("{}\u{001e}".into())).await.unwrap();
                        sink.send(Message::Text(
                            "{\"type\":1,\"target\":\"Connected\",\"arguments\":[\"ok\"]}\u{001e}"
                                .into(),
                        ))
                        .await
                        .unwrap();
                    } else {
                        // Exact SignalR failure when Authorization/Cookie headers are lost
                        sink.send(Message::Text(
                            "{\"type\":7,\"error\":\"Connection closed with an error. HiddenStackTraceException: Authorization required\"}\u{001e}"
                                .into(),
                        ))
                        .await
                        .unwrap();
                    }
                }
            }
        });

        // 2. Start FluxProxy listener
        let tmp_dir =
            std::env::temp_dir().join(format!("fluxproxy-test-signalr-{}", std::process::id()));
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("signalr.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let c = proxy_ctx.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), c).await,
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            }
        });

        // 3. Connect SignalR client through FluxProxy with JWT, Cookies, Subprotocol & X-* headers
        let mut client_tcp = TcpStream::connect(proxy_addr).await.unwrap();
        let raw_upgrade = format!(
            "GET http://127.0.0.1:{port}/hubs/notifications?id=conn_abc HTTP/1.1\r\n\
             Host: 127.0.0.1:{port}\r\n\
             Connection: Upgrade\r\n\
             Upgrade: websocket\r\n\
             Sec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Key: {key}\r\n\
             Sec-WebSocket-Protocol: json\r\n\
             Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits, x-flux-trace; v=1\r\n\
             Authorization: Bearer signalr-jwt-token-2026\r\n\
             Cookie: .AspNetCore.Cookies=auth_chunk_1\r\n\
             Cookie: XSRF-TOKEN=csrf_42\r\n\
             User-Agent: Microsoft.AspNetCore.Http.Connections.Client/8.0.0\r\n\
             X-SignalR-User-Agent: Microsoft SignalR/8.0\r\n\
             X-Requested-With: XMLHttpRequest\r\n\r\n",
            port = upstream_addr.port(),
            key = client_original_ws_key,
        );
        client_tcp.write_all(raw_upgrade.as_bytes()).await.unwrap();

        let mut resp_buf = Vec::with_capacity(1024);
        let mut byte = [0u8; 1];
        while !resp_buf.ends_with(b"\r\n\r\n") {
            client_tcp.read_exact(&mut byte).await.unwrap();
            resp_buf.push(byte[0]);
        }
        let handshake_headers_str = String::from_utf8_lossy(&resp_buf);
        let lower_resp = handshake_headers_str.to_ascii_lowercase();
        assert!(handshake_headers_str.starts_with("HTTP/1.1 101"));
        assert!(lower_resp.contains("sec-websocket-protocol: json\r\n"));
        assert!(handshake_headers_str.contains("AWSALB=sticky1; Path=/"));
        assert!(handshake_headers_str.contains("SRVID=node2; Path=/; HttpOnly"));
        assert!(lower_resp.contains("x-signalr-hub: notificationshub\r\n"));

        let mut client_ws = WebSocketStream::from_raw_socket(client_tcp, Role::Client, None).await;
        client_ws
            .send(Message::Text(
                "{\"protocol\":\"json\",\"version\":1}\u{001e}".into(),
            ))
            .await
            .unwrap();

        let ack = client_ws.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(ack.as_str(), "{}\u{001e}");

        let hub_msg = client_ws.next().await.unwrap().unwrap().into_text().unwrap();
        assert!(!hub_msg.contains("Authorization required"));
        assert!(hub_msg.contains("\"target\":\"Connected\""));

        let _ = client_ws.close(None).await;
        tokio::time::sleep(Duration::from_millis(40)).await;

        let detail = store.get(1).unwrap();
        assert_eq!(detail.summary.status, 101);
        assert_eq!(detail.websocket_frames.len(), 3);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn targeted_only_mode_tunnels_unlisted_hosts_as_passthrough_and_decrypts_allowlisted_host()
    {
        // 1. Start mock raw TCP echo server representing a 3rd-party pinned app (e.g. Telegram/Steam/Teams)
        let pinned_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pinned_addr = pinned_listener.local_addr().unwrap();

        tokio::spawn(async move {
            if let Ok((mut sock, _)) = pinned_listener.accept().await {
                let mut buf = [0u8; 64];
                if let Ok(n) = sock.read(&mut buf).await {
                    let _ = sock.write_all(&buf[..n]).await;
                }
                let _ = sock.shutdown().await;
            }
        });

        // 2. Configure FluxProxy in Mode 2 (`TargetedOnly`) with ONLY `*.mycompany.com, localhost` in Target Allowlist
        let tmp_dir =
            std::env::temp_dir().join(format!("fluxproxy-test-targeted-{}", std::process::id()));
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        filters.update_config(ProxyFilterBackendConfig {
            tls_intercept_mode: TlsInterceptMode::TargetedOnly,
            tls_bypass_enabled: true,
            tls_bypass_rules: Vec::new(),
            tls_target_rules: vec![TlsBypassRule {
                id: "target-allowlist".into(),
                enabled: true,
                pattern: "*.mycompany.com, localhost".into(),
                category: "Target Allowlist".into(),
                description: "Only decrypt target services".into(),
            }],
            header_mutations_enabled: false,
            header_mutations: Vec::new(),
            strip_alt_svc: true,
            host_list_sync: Default::default(),
            ..crate::proxy::filters::default_backend_config()
        });

        let store = Arc::new(TrafficStore::new(tmp_dir.join("targeted.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(SharedProxyContext {
            ca: ca.clone(),
            rules: rules.clone(),
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        // Register a mock AutoResponder rule on allowlisted `https://localhost/...` so we can verify full MITM decryption
        rules.upsert_rule(crate::models::AutoResponderRule {
            id: "mock-target".into(),
            enabled: true,
            name: "Target Service Mock".into(),
            match_target: crate::models::RuleMatchTarget::UrlContains,
            pattern: "localhost".into(),
            method_filter: None,
            header_name: None,
            action: RuleActionType::MockResponse,
            status_code: 200,
            latency_ms: 0,
            response_headers: vec![HeaderPair::new("Content-Type", "application/json")],
            response_body: "{\"decrypted\":true}".into(),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            for _ in 0..2 {
                if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                    let io = TokioIo::new(tcp_stream);
                    let c = proxy_ctx.clone();
                    tokio::spawn(async move {
                        let service = service_fn(move |req: Request<Incoming>| {
                            let inner_c = c.clone();
                            async move {
                                Ok::<_, Infallible>(
                                    handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_c)
                                        .await,
                                )
                            }
                        });
                        let _ = AutoConnBuilder::new(TokioExecutor::new())
                            .serve_connection_with_upgrades(io, service)
                            .await;
                    });
                }
            }
        });

        // 3A. Unlisted host (`127.0.0.1`) -> MUST be pure TCP tunnel (`PASSTHROUGH`), zero MITM TLS!
        let mut raw_client = TcpStream::connect(proxy_addr).await.unwrap();
        let connect_unlisted = format!(
            "CONNECT 127.0.0.1:{p} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n\r\n",
            p = pinned_addr.port()
        );
        raw_client
            .write_all(connect_unlisted.as_bytes())
            .await
            .unwrap();
        let mut ok_buf = [0u8; 128];
        let n = raw_client.read(&mut ok_buf).await.unwrap();
        assert!(String::from_utf8_lossy(&ok_buf[..n]).starts_with("HTTP/1.1 200"));

        let opaque_mtls_bytes = b"OPAQUE_MTLS_OR_TELEGRAM_STREAM";
        raw_client.write_all(opaque_mtls_bytes).await.unwrap();
        let mut echoed = vec![0u8; opaque_mtls_bytes.len()];
        raw_client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, opaque_mtls_bytes);
        drop(raw_client);

        // 3B. Allowlisted host (`localhost`) -> MUST be decrypted via MITM Root CA!
        let root_pem = std::fs::read(ca.info().cert_pem_path).unwrap();
        let reqwest_ca = reqwest::Certificate::from_pem(&root_pem).unwrap();
        let https_client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::https(format!("http://{proxy_addr}")).unwrap())
            .add_root_certificate(reqwest_ca)
            .build()
            .unwrap();

        let decrypted_resp = https_client
            .get("https://localhost:8443/api/health")
            .send()
            .await
            .unwrap();
        assert_eq!(decrypted_resp.status().as_u16(), 200);
        assert_eq!(decrypted_resp.text().await.unwrap(), "{\"decrypted\":true}");

        tokio::time::sleep(Duration::from_millis(40)).await;
        let summaries = store.list_summaries();
        let passthrough_row = summaries
            .iter()
            .find(|s| s.host == "127.0.0.1")
            .expect("missing passthrough row");
        assert!(passthrough_row.tls_bypassed);
        assert_eq!(passthrough_row.protocol, "PASSTHROUGH");

        let inspected_row = summaries
            .iter()
            .find(|s| s.host.starts_with("localhost"))
            .expect("missing decrypted target row");
        assert!(!inspected_row.tls_bypassed);
        assert_eq!(inspected_row.status, 200);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn mobile_portal_serves_html_crt_der_pem_and_ios_mobileconfig_on_all_interfaces() {
        let tmp_dir =
            std::env::temp_dir().join(format!("fluxproxy-test-mobile-{}", std::process::id()));
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("mobile.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        // Bind on 0.0.0.0:0 ("Allow remote connections / Listen on all network interfaces")
        let proxy_listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
        let bound_port = proxy_listener.local_addr().unwrap().port();

        let ctx = Arc::new(SharedProxyContext {
            ca: ca.clone(),
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(bound_port),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_ctx = ctx.clone();
        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                    break;
                };
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_c).await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let direct_client = reqwest::Client::builder().no_proxy().build().unwrap();
        let proxied_client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{bound_port}")).unwrap())
            .build()
            .unwrap();

        // 1. Direct browser visit `http://127.0.0.1:<port>/` -> HTML onboarding portal
        let html_resp = direct_client
            .get(format!("http://127.0.0.1:{bound_port}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(html_resp.status().as_u16(), 200);
        assert!(html_resp
            .headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/html"));
        let html_body = html_resp.text().await.unwrap();
        assert!(html_body.contains("/ca.mobileconfig"));
        assert!(html_body.contains("/ca.crt"));

        // 2. Direct QR scan `http://<ip>:<port>/ca.crt` -> PEM X.509 certificate
        let crt_resp = direct_client
            .get(format!("http://127.0.0.1:{bound_port}/ca.crt"))
            .send()
            .await
            .unwrap();
        assert_eq!(crt_resp.status().as_u16(), 200);
        assert_eq!(
            crt_resp.headers().get("content-type").unwrap().to_str().unwrap(),
            "application/x-x509-ca-cert"
        );
        assert_eq!(crt_resp.text().await.unwrap(), ca.root_ca_pem());

        // 3. Direct `/ca.der` -> exact DER bytes
        let der_resp = direct_client
            .get(format!("http://127.0.0.1:{bound_port}/ca.der"))
            .send()
            .await
            .unwrap();
        assert_eq!(der_resp.status().as_u16(), 200);
        assert_eq!(der_resp.bytes().await.unwrap().as_ref(), ca.root_ca_der());

        // 4. Proxied iOS Safari visit `http://flux.proxy/cert` -> `.mobileconfig` (`application/x-apple-aspen-config`)
        let ios_resp = proxied_client
            .get("http://flux.proxy/cert")
            .header(
                "User-Agent",
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
            )
            .send()
            .await
            .unwrap();
        assert_eq!(ios_resp.status().as_u16(), 200);
        assert_eq!(
            ios_resp.headers().get("content-type").unwrap().to_str().unwrap(),
            "application/x-apple-aspen-config"
        );
        let profile_xml = ios_resp.text().await.unwrap();
        assert!(profile_xml.contains("com.apple.security.root"));

        // 5. Proxied Android Chrome visit `http://flux.proxy/cert` -> `.crt` (`application/x-x509-ca-cert`)
        let android_resp = proxied_client
            .get("http://flux.proxy/cert")
            .header(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36",
            )
            .send()
            .await
            .unwrap();
        assert_eq!(android_resp.status().as_u16(), 200);
        assert_eq!(
            android_resp.headers().get("content-type").unwrap().to_str().unwrap(),
            "application/x-x509-ca-cert"
        );

        let summaries = store.list_summaries();
        assert!(!summaries.is_empty());
        assert_eq!(summaries[0].client_ip.as_deref(), Some("127.0.0.1"));

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn strips_alt_svc_and_alternate_protocol_across_http1_and_http2_responses() {
        // 1. Upstream HTTP server returning Alt-Svc and Alternate-Protocol headers
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();

        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, _)) = upstream_listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let svc = service_fn(|_req: Request<Incoming>| async move {
                        Ok::<_, Infallible>(
                            Response::builder()
                                .status(StatusCode::OK)
                                .header(CONTENT_TYPE, "application/json")
                                .header("Alt-Svc", "h3=\":443\"; ma=86400")
                                .header("Alternate-Protocol", "443:quic")
                                .header("X-Upstream", "ok")
                                .body(Full::new(Bytes::from_static(b"{\"quic\":false}")))
                                .unwrap(),
                        )
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, svc)
                        .await;
                });
            }
        });

        // 2. Start FluxProxy MITM listener with default `strip_alt_svc == true`
        let tmp_dir =
            std::env::temp_dir().join(format!("fluxproxy-test-altsvc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("altsvc.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        // Mock rule for HTTPS/2 `https://localhost:9443/...` carrying Alt-Svc & Alternate-Protocol
        rules.upsert_rule(crate::models::AutoResponderRule {
            id: "mock-h2-altsvc".into(),
            enabled: true,
            name: "HTTPS/2 Alt-Svc Mock".into(),
            match_target: crate::models::RuleMatchTarget::UrlContains,
            pattern: "https://localhost:9443/".into(),
            method_filter: None,
            header_name: None,
            action: RuleActionType::MockResponse,
            status_code: 200,
            latency_ms: 0,
            response_headers: vec![
                HeaderPair::new("Content-Type", "application/json"),
                HeaderPair::new("alt-svc", "h3=\":443\"; ma=2592000"),
                HeaderPair::new("alternate-protocol", "443:quic"),
            ],
            response_body: "{\"protocol\":\"h2\"}".into(),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let ctx = Arc::new(SharedProxyContext {
            ca: ca.clone(),
            rules,
            filters: filters.clone(),
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(proxy_addr.port()),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_ctx = ctx.clone();
        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                    break;
                };
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_c).await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let root_pem = std::fs::read(ca.info().cert_pem_path).unwrap();
        let reqwest_ca = reqwest::Certificate::from_pem(&root_pem).unwrap();
        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://{proxy_addr}")).unwrap())
            .add_root_certificate(reqwest_ca)
            .build()
            .unwrap();

        // 3A. HTTP/1.1 upstream response -> Alt-Svc & Alternate-Protocol stripped by default
        let h1_resp = client
            .get(format!("http://127.0.0.1:{}/h1-test", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(h1_resp.version(), reqwest::Version::HTTP_11);
        assert!(h1_resp.headers().get("alt-svc").is_none());
        assert!(h1_resp.headers().get("alternate-protocol").is_none());
        assert_eq!(h1_resp.headers().get("x-upstream").unwrap(), "ok");

        // 3B. HTTPS/2 (`h2` via MITM ALPN) response -> Alt-Svc & Alternate-Protocol stripped by default
        let h2_resp = client
            .get("https://localhost:9443/h2-test")
            .send()
            .await
            .unwrap();
        assert_eq!(h2_resp.version(), reqwest::Version::HTTP_2);
        assert!(h2_resp.headers().get("alt-svc").is_none());
        assert!(h2_resp.headers().get("alternate-protocol").is_none());

        // 3C. Disable `strip_alt_svc` -> headers are preserved for both HTTP/1.1 and HTTPS/2
        let mut cfg = filters.get_config();
        cfg.strip_alt_svc = false;
        filters.update_config(cfg);

        let h1_preserved = client
            .get(format!("http://127.0.0.1:{}/h1-keep", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(
            h1_preserved.headers().get("alt-svc").unwrap(),
            "h3=\":443\"; ma=86400"
        );
        assert_eq!(
            h1_preserved.headers().get("alternate-protocol").unwrap(),
            "443:quic"
        );

        let h2_preserved = client
            .get("https://localhost:9443/h2-keep")
            .send()
            .await
            .unwrap();
        assert_eq!(h2_preserved.version(), reqwest::Version::HTTP_2);
        assert_eq!(
            h2_preserved.headers().get("alt-svc").unwrap(),
            "h3=\":443\"; ma=2592000"
        );
        assert_eq!(
            h2_preserved.headers().get("alternate-protocol").unwrap(),
            "443:quic"
        );

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn streaming_capture_drop_skips_store_and_ipc_and_increments_dropped_counter() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();

        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, _)) = upstream_listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let svc = service_fn(|req: Request<Incoming>| async move {
                        let status = if req.uri().path() == "/cached" {
                            StatusCode::NOT_MODIFIED
                        } else {
                            StatusCode::OK
                        };
                        Ok::<_, Infallible>(
                            Response::builder()
                                .status(status)
                                .header(CONTENT_TYPE, "application/json")
                                .body(Full::new(Bytes::from_static(b"{\"ok\":true}")))
                                .unwrap(),
                        )
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, svc)
                        .await;
                });
            }
        });

        let tmp_dir =
            std::env::temp_dir().join(format!("fluxproxy-test-capdrop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("capdrop.sqlite")).unwrap());
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        // Enable `drop_non_matching_on_capture` + hide 304 Not Modified + path filter `/api/*`
        let mut cfg = filters.get_config();
        cfg.drop_non_matching_on_capture = true;
        cfg.noise_thresholds.hide_304_not_modified = true;
        cfg.capture_host_list = crate::models::HostListBackendSyncConfig {
            enabled: true,
            mode: crate::models::HostListFilterMode::Whitelist,
            raw_text: "/api/*".into(),
        };
        filters.update_config(cfg);

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(proxy_addr.port()),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        // Also register an AutoResponder mock for telemetry.microsoft.com to test svchost/telemetry drop
        ctx.rules.upsert_rule(crate::models::AutoResponderRule {
            id: "mock-telemetry".into(),
            enabled: true,
            name: "Telemetry Mock".into(),
            match_target: crate::models::RuleMatchTarget::UrlContains,
            pattern: "telemetry.microsoft.com".into(),
            method_filter: None,
            header_name: None,
            action: RuleActionType::MockResponse,
            status_code: 200,
            latency_ms: 0,
            response_headers: vec![HeaderPair::new("Content-Type", "application/json")],
            response_body: "{\"acc\":1}".into(),
        });

        let proxy_ctx = ctx.clone();
        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                    break;
                };
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        // Simulate svchost.exe when hitting telemetry.microsoft.com
                        let proc_info = if req
                            .uri()
                            .host()
                            .unwrap_or("")
                            .contains("telemetry.microsoft.com")
                        {
                            Some(ClientProcessInfo {
                                pid: 1120,
                                name: "svchost.exe".into(),
                            })
                        } else {
                            Some(ClientProcessInfo {
                                pid: 4200,
                                name: "node.exe".into(),
                            })
                        };
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, proc_info, ClientConnContext::new(), inner_c)
                                    .await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();

        // 1. Non-matching path `/noise` -> client gets 200 OK, but NOT stored in RAM or emitted on IPC
        let r1 = client
            .get(format!("http://127.0.0.1:{}/noise", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(r1.status(), StatusCode::OK);

        // 2. 304 Not Modified on `/cached` -> dropped
        let r2 = client
            .get(format!("http://127.0.0.1:{}/cached", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(r2.status(), StatusCode::NOT_MODIFIED);

        // 3. Background svchost telemetry -> dropped
        let r3 = client
            .post("http://telemetry.microsoft.com/OneCollector/1.0/")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(r3.status(), StatusCode::OK);

        // 4. Matching `/api/orders` -> stored in RAM AND emitted once over IPC
        let r4 = client
            .get(format!(
                "http://127.0.0.1:{}/api/orders",
                upstream_addr.port()
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(r4.status(), StatusCode::OK);

        assert_eq!(store.len(), 1);
        assert_eq!(store.dropped_sessions_count(), 3);

        let emitted_phase1 = event_rx.try_recv().expect("phase 1 in-flight session emitted");
        assert_eq!(emitted_phase1.path, "/api/orders");
        assert_eq!(emitted_phase1.status, 0);
        let emitted_phase2 = event_rx.try_recv().expect("phase 2 completed session emitted");
        assert_eq!(emitted_phase2.id, emitted_phase1.id);
        assert_eq!(emitted_phase2.path, "/api/orders");
        assert_eq!(emitted_phase2.status, 200);
        while let Ok(extra) = event_rx.try_recv() {
            assert_eq!(
                extra.id, emitted_phase1.id,
                "no dropped session may be emitted (unexpected session {} path={})",
                extra.id, extra.path
            );
            assert_eq!(extra.path, "/api/orders");
        }

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn two_phase_capture_emits_in_flight_and_updates_or_removes_on_response() {
        use tokio::sync::Notify;

        // 1. Upstream server with controllable response delay via Notify
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        let entered_notify = Arc::new(Notify::new());
        let release_notify = Arc::new(Notify::new());

        let upstream_entered = entered_notify.clone();
        let upstream_release = release_notify.clone();
        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, _)) = upstream_listener.accept().await else {
                    break;
                };
                let entered = upstream_entered.clone();
                let release = upstream_release.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let svc = service_fn(move |req: Request<Incoming>| {
                        let entered = entered.clone();
                        let release = release.clone();
                        async move {
                            let path = req.uri().path().to_string();
                            let _ = req.into_body().collect().await;
                            entered.notify_one();
                            release.notified().await;
                            if path == "/api/cached-304" {
                                Ok::<_, Infallible>(
                                    Response::builder()
                                        .status(StatusCode::NOT_MODIFIED)
                                        .body(Full::new(Bytes::new()))
                                        .unwrap(),
                                )
                            } else {
                                Ok::<_, Infallible>(
                                    Response::builder()
                                        .status(StatusCode::OK)
                                        .header(CONTENT_TYPE, "application/json")
                                        .body(Full::new(Bytes::from_static(b"{\"phase\":2}")))
                                        .unwrap(),
                                )
                            }
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, svc)
                        .await;
                });
            }
        });

        let tmp_dir =
            std::env::temp_dir().join(format!("fluxproxy-test-twophase-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("twophase.sqlite")).unwrap());
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let (removed_tx, mut removed_rx) = mpsc::unbounded_channel();

        // Enable `drop_non_matching_on_capture` + `hide_304_not_modified` + matrix include `status == 200`
        let mut cfg = filters.get_config();
        cfg.drop_non_matching_on_capture = true;
        cfg.noise_thresholds.hide_304_not_modified = true;
        cfg.capture_matrix_enabled = true;
        cfg.capture_filter_rules = vec![crate::models::CaptureFilterRule {
            id: "inc-200".into(),
            enabled: true,
            action: "include".into(),
            logical_op: "AND".into(),
            field: "status".into(),
            operator: "equals".into(),
            value: "200".into(),
        }];
        filters.update_config(cfg);

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(proxy_addr.port()),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_ctx = ctx.clone();
        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                    break;
                };
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        let proc_info = Some(ClientProcessInfo {
                            pid: 4242,
                            name: "node.exe".into(),
                        });
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, proc_info, ClientConnContext::new(), inner_c)
                                    .await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();

        // Part A: Slow upstream POST -> verify Phase 1 (`status: 0` + request body), annotate, then verify Phase 2 update
        let url_ok = format!("http://127.0.0.1:{}/api/slow-submit", upstream_addr.port());
        let client_ok = client.clone();
        let req_task = tokio::spawn(async move {
            client_ok
                .post(url_ok)
                .header("X-Trace-Id", "two-phase-1")
                .body("{\"action\":\"create\"}")
                .send()
                .await
                .unwrap()
        });

        tokio::time::timeout(Duration::from_secs(5), entered_notify.notified())
            .await
            .expect("upstream received request headers");

        let phase1 = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
            .await
            .expect("phase 1 event arrives immediately")
            .expect("phase 1 summary");
        assert_eq!(phase1.status, 0);
        assert_eq!(phase1.duration_ms, 0);
        assert_eq!(phase1.body_size, 0);
        assert_eq!(phase1.content_type, "");

        let stored_p1 = store.get(phase1.id).expect("in-flight session stored");
        assert_eq!(stored_p1.summary.status, 0);
        assert!(stored_p1
            .request_headers
            .iter()
            .any(|h| h.name.eq_ignore_ascii_case("x-trace-id") && h.value == "two-phase-1"));
        assert_eq!(
            stored_p1.request_body_text.as_deref(),
            Some("{\"action\":\"create\"}")
        );
        assert!(stored_p1.response_headers.is_empty());

        // Annotate while request is still in-flight
        store
            .annotate_session(
                phase1.id,
                Some("waiting on upstream".into()),
                Some("amber".into()),
            )
            .unwrap();

        // Allow upstream to respond
        release_notify.notify_one();
        let resp_ok = req_task.await.unwrap();
        assert_eq!(resp_ok.status(), StatusCode::OK);

        let phase2 = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
            .await
            .expect("phase 2 event arrives")
            .expect("phase 2 summary");
        assert_eq!(phase2.id, phase1.id);
        assert_eq!(phase2.status, 200);
        assert!(phase2.body_size > 0);
        assert_eq!(phase2.comment.as_deref(), Some("waiting on upstream"));
        assert_eq!(phase2.marked_color.as_deref(), Some("amber"));

        let stored_p2 = store.get(phase1.id).expect("completed session updated in place");
        assert_eq!(stored_p2.summary.status, 200);
        assert_eq!(
            stored_p2.response_body_text.as_deref(),
            Some("{\"phase\":2}")
        );
        assert_eq!(
            stored_p2.summary.comment.as_deref(),
            Some("waiting on upstream")
        );
        assert_eq!(stored_p2.summary.marked_color.as_deref(), Some("amber"));
        assert!(removed_rx.try_recv().is_err());

        // Part B: Request that passes Phase 1 (`status: 0`) but gets dropped in Phase 2 (`304 Not Modified`)
        let url_304 = format!("http://127.0.0.1:{}/api/cached-304", upstream_addr.port());
        let client_304 = client.clone();
        let req_304_task = tokio::spawn(async move { client_304.get(url_304).send().await.unwrap() });

        tokio::time::timeout(Duration::from_secs(5), entered_notify.notified())
            .await
            .expect("upstream received 304 request");

        let p1_304 = loop {
            let ev = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
                .await
                .expect("phase 1 for 304 arrives before response")
                .expect("summary");
            if ev.id == phase1.id {
                assert_eq!(ev.status, 200);
                continue;
            }
            break ev;
        };
        assert_eq!(p1_304.status, 0);
        assert!(store.get(p1_304.id).is_some());

        release_notify.notify_one();
        let resp_304 = req_304_task.await.unwrap();
        assert_eq!(resp_304.status(), StatusCode::NOT_MODIFIED);

        let removed = tokio::time::timeout(Duration::from_secs(2), removed_rx.recv())
            .await
            .expect("removed event arrives")
            .expect("removed ids");
        assert_eq!(removed, vec![p1_304.id]);
        assert!(store.get(p1_304.id).is_none());

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn mobile_portal_html_escapes_dynamic_fields_against_xss() {
        let html = render_mobile_portal_html(
            "10.0.0.1<script>alert(1)</script>",
            "evil.com\" onmouseover=\"alert(2)",
            "AB:CD'<img src=x onerror=alert(3)>",
            "Mozilla/5.0 iPhone <svg onload=alert(4)>",
        );

        assert!(!html.contains("<script>alert(1)</script>"));
        assert!(!html.contains("<img src=x onerror=alert(3)>"));
        assert!(!html.contains("<svg onload=alert(4)>"));
        assert!(!html.contains("\" onmouseover=\"alert(2)"));
        assert!(html.contains("10.0.0.1&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(html.contains("evil.com&quot; onmouseover=&quot;alert(2)"));
        assert!(html.contains("AB:CD&#39;&lt;img src=x onerror=alert(3)&gt;"));
        assert!(html.contains("Определено устройство: iOS / iPadOS"));
    }

    #[tokio::test]
    async fn transparently_decompresses_zstd_upstream_responses_for_client_and_traffic_store() {
        let json_plain = r#"{"service":"FluxProxy","codec":"zstd","ok":true}"#;
        let html_plain = "<!DOCTYPE html><html><body><h1>Zstd OK</h1></body></html>";
        let large_plain = "FluxProxyZstdLargePayload-".repeat(12_000); // > 256 KiB
        assert!(large_plain.len() > ZSTD_SPAWN_BLOCKING_THRESHOLD_BYTES);
        let sse_plain = "id: z1\nevent: delta\ndata: {\"ok\":true}\n\ndata: [DONE]\n\n";
        let corrupt_payload = b"NOT_A_VALID_ZSTD_FRAME";

        let json_zstd = zstd::encode_all(json_plain.as_bytes(), 3).unwrap();
        let html_br = {
            use std::io::Write;
            let mut buf = Vec::new();
            let mut compressor = brotli::CompressorWriter::new(&mut buf, 4096, 4, 22);
            compressor.write_all(html_plain.as_bytes()).unwrap();
            drop(compressor);
            buf
        };
        let html_zstd = zstd::encode_all(html_br.as_slice(), 3).unwrap();
        let large_zstd = zstd::encode_all(large_plain.as_bytes(), 3).unwrap();
        let sse_zstd = zstd::encode_all(sse_plain.as_bytes(), 3).unwrap();

        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();

        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, _)) = upstream_listener.accept().await else {
                    break;
                };
                let json_zstd = json_zstd.clone();
                let html_zstd = html_zstd.clone();
                let large_zstd = large_zstd.clone();
                let sse_zstd = sse_zstd.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let svc = service_fn(move |req: Request<Incoming>| {
                        let json_zstd = json_zstd.clone();
                        let html_zstd = html_zstd.clone();
                        let large_zstd = large_zstd.clone();
                        let sse_zstd = sse_zstd.clone();
                        async move {
                            let resp = match req.uri().path() {
                                "/zstd-json" => Response::builder()
                                    .status(StatusCode::OK)
                                    .header(CONTENT_TYPE, "application/json; charset=utf-8")
                                    .header("Content-Encoding", "zstd")
                                    .body(Full::new(Bytes::from(json_zstd)))
                                    .unwrap(),
                                "/zstd-html" => Response::builder()
                                    .status(StatusCode::OK)
                                    .header(CONTENT_TYPE, "text/html; charset=utf-8")
                                    .header("Content-Encoding", "br, ZSTD")
                                    .body(Full::new(Bytes::from(html_zstd)))
                                    .unwrap(),
                                "/zstd-large" => Response::builder()
                                    .status(StatusCode::OK)
                                    .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                                    .header("Content-Encoding", "zstd")
                                    .body(Full::new(Bytes::from(large_zstd)))
                                    .unwrap(),
                                "/zstd-sse" => Response::builder()
                                    .status(StatusCode::OK)
                                    .header(CONTENT_TYPE, "text/event-stream; charset=utf-8")
                                    .header("Content-Encoding", "zstd")
                                    .body(Full::new(Bytes::from(sse_zstd)))
                                    .unwrap(),
                                "/zstd-corrupt" => Response::builder()
                                    .status(StatusCode::OK)
                                    .header(CONTENT_TYPE, "application/octet-stream")
                                    .header("Content-Encoding", "zstd")
                                    .body(Full::new(Bytes::from_static(corrupt_payload)))
                                    .unwrap(),
                                _ => Response::builder()
                                    .status(StatusCode::NOT_FOUND)
                                    .body(Full::new(Bytes::new()))
                                    .unwrap(),
                            };
                            Ok::<_, Infallible>(resp)
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, svc)
                        .await;
                });
            }
        });

        let tmp_dir =
            std::env::temp_dir().join(format!("fluxproxy-test-zstd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("zstd.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(proxy_addr.port()),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_ctx = ctx.clone();
        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                    break;
                };
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_c).await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();

        // 1. JSON with `Content-Encoding: zstd`
        let json_resp = client
            .get(format!("http://127.0.0.1:{}/zstd-json", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(json_resp.status(), StatusCode::OK);
        assert!(json_resp.headers().get("content-encoding").is_none());
        assert_eq!(json_resp.text().await.unwrap(), json_plain);

        // 2. HTML with `Content-Encoding: br, ZSTD`
        let html_resp = client
            .get(format!("http://127.0.0.1:{}/zstd-html", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(html_resp.status(), StatusCode::OK);
        assert!(html_resp.headers().get("content-encoding").is_none());
        assert_eq!(html_resp.text().await.unwrap(), html_plain);

        // 3. Large (> 256 KB) payload via `spawn_blocking`
        let large_resp = client
            .get(format!("http://127.0.0.1:{}/zstd-large", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(large_resp.status(), StatusCode::OK);
        assert!(large_resp.headers().get("content-encoding").is_none());
        assert_eq!(large_resp.text().await.unwrap(), large_plain);

        // 4. SSE stream with `Content-Encoding: zstd`
        let sse_resp = client
            .get(format!("http://127.0.0.1:{}/zstd-sse", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(sse_resp.status(), StatusCode::OK);
        assert!(sse_resp.headers().get("content-encoding").is_none());
        assert_eq!(sse_resp.text().await.unwrap(), sse_plain);

        // 5. Corrupt zstd frame preserves `Content-Encoding: zstd` and returns original bytes
        let corrupt_resp = client
            .get(format!("http://127.0.0.1:{}/zstd-corrupt", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(corrupt_resp.status(), StatusCode::OK);
        assert_eq!(
            corrupt_resp
                .headers()
                .get("content-encoding")
                .and_then(|v| v.to_str().ok()),
            Some("zstd")
        );
        assert_eq!(corrupt_resp.bytes().await.unwrap().as_ref(), corrupt_payload);

        tokio::time::sleep(Duration::from_millis(40)).await;
        let summaries = store.list_summaries();
        let json_summary = summaries
            .iter()
            .find(|s| s.path == "/zstd-json")
            .expect("missing /zstd-json session");
        let json_detail = store.get(json_summary.id).unwrap();
        assert_eq!(json_detail.response_body_text.as_deref(), Some(json_plain));
        assert_eq!(json_detail.summary.body_size, json_plain.len());

        let html_summary = summaries
            .iter()
            .find(|s| s.path == "/zstd-html")
            .expect("missing /zstd-html session");
        let html_detail = store.get(html_summary.id).unwrap();
        assert_eq!(html_detail.response_body_text.as_deref(), Some(html_plain));
        assert_eq!(html_detail.summary.body_size, html_plain.len());

        let large_summary = summaries
            .iter()
            .find(|s| s.path == "/zstd-large")
            .expect("missing /zstd-large session");
        let large_detail = store.get(large_summary.id).unwrap();
        assert_eq!(large_detail.response_body_text.as_deref(), Some(large_plain.as_str()));
        assert_eq!(large_detail.summary.body_size, large_plain.len());

        let sse_summary = summaries
            .iter()
            .find(|s| s.path == "/zstd-sse")
            .expect("missing /zstd-sse session");
        let sse_detail = store.get(sse_summary.id).unwrap();
        assert_eq!(sse_detail.response_body_text.as_deref(), Some(sse_plain));
        assert_eq!(sse_detail.sse_events.len(), 2);
        assert_eq!(sse_detail.sse_events[0].event, "delta");
        assert_eq!(sse_detail.sse_events[1].data, "[DONE]");

        let corrupt_summary = summaries
            .iter()
            .find(|s| s.path == "/zstd-corrupt")
            .expect("missing /zstd-corrupt session");
        let corrupt_detail = store.get(corrupt_summary.id).unwrap();
        assert_eq!(corrupt_detail.summary.body_size, corrupt_payload.len());

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    struct RecordingOsProxyBackend {
        applied_targets: std::sync::Mutex<Vec<(String, u16)>>,
        active: std::sync::Mutex<Option<(String, u16)>>,
    }

    impl RecordingOsProxyBackend {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                applied_targets: std::sync::Mutex::new(Vec::new()),
                active: std::sync::Mutex::new(None),
            })
        }

        fn last_target(&self) -> Option<(String, u16)> {
            self.applied_targets.lock().unwrap().last().cloned()
        }
    }

    impl crate::proxy::sysproxy::OsProxyBackend for RecordingOsProxyBackend {
        fn capture_snapshot(
            &self,
        ) -> Result<crate::proxy::sysproxy::PlatformProxySnapshot, ProxyError> {
            Ok(crate::proxy::sysproxy::PlatformProxySnapshot::Windows(
                crate::proxy::sysproxy::WindowsProxySnapshot {
                    proxy_enable: Some(0),
                    proxy_server: None,
                    proxy_override: None,
                    auto_config_url: None,
                },
            ))
        }

        fn apply_system_proxy(
            &self,
            host: &str,
            port: u16,
            _baseline: &crate::proxy::sysproxy::PlatformProxySnapshot,
        ) -> Result<(), ProxyError> {
            self.applied_targets
                .lock()
                .unwrap()
                .push((host.to_string(), port));
            *self.active.lock().unwrap() = Some((host.to_string(), port));
            Ok(())
        }

        fn restore_snapshot(
            &self,
            _snapshot: &crate::proxy::sysproxy::PlatformProxySnapshot,
        ) -> Result<(), ProxyError> {
            *self.active.lock().unwrap() = None;
            Ok(())
        }

        fn inspect_active_state(
            &self,
            expected_host: &str,
            expected_port: u16,
        ) -> Result<crate::proxy::sysproxy::OsActiveProxyState, ProxyError> {
            let cur = self.active.lock().unwrap().clone();
            match cur {
                Some((h, p)) => Ok(crate::proxy::sysproxy::OsActiveProxyState {
                    matches_flux: h == expected_host && p == expected_port,
                    any_proxy_enabled: true,
                    current_target_summary: format!("{h}:{p}"),
                }),
                None => Ok(crate::proxy::sysproxy::OsActiveProxyState {
                    matches_flux: false,
                    any_proxy_enabled: false,
                    current_target_summary: "disabled".to_string(),
                }),
            }
        }
    }

    async fn pick_distinct_bindable_ip_for_test() -> Option<String> {
        if let Ok(l) = TcpListener::bind("127.0.0.2:0").await {
            drop(l);
            return Some("127.0.0.2".to_string());
        }
        for iface in crate::proxy::network::list_network_interfaces_with_options(false) {
            if iface.ip != "127.0.0.1" {
                let addr = format!("{}:0", iface.ip);
                if let Ok(l) = TcpListener::bind(&addr).await {
                    drop(l);
                    return Some(iface.ip);
                }
            }
        }
        None
    }

    #[tokio::test]
    async fn multi_bind_dual_listener_stops_all_tasks_and_rolls_back_addr_in_use() {
        let Some(specific_ip) = pick_distinct_bindable_ip_for_test().await else {
            // Skip cleanly on restricted hosts with only 127.0.0.1 available
            return;
        };

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-multibind-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let store = Arc::new(TrafficStore::new(tmp_dir.join("multibind.sqlite")).unwrap());
        let os_backend = RecordingOsProxyBackend::new();
        let sysproxy = Arc::new(SystemProxyManager::with_backend(
            &tmp_dir,
            os_backend.clone(),
        ));

        let controller = ProxyEngineController::new_for_test(
            ca,
            rules,
            filters,
            store,
            sysproxy,
        )
        .unwrap();

        // Allocate an ephemeral port that is free right now, then start in Loopback mode
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let test_port = probe.local_addr().unwrap().port();
        drop(probe);

        let started = controller
            .start("127.0.0.1".to_string(), test_port)
            .await
            .expect("start loopback on ephemeral port");
        assert!(started.running);
        assert_eq!(started.bind_mode, BindHostMode::Loopback);
        assert_eq!(started.bound_ips, vec!["127.0.0.1".to_string()]);
        assert_eq!(os_backend.last_target(), Some(("127.0.0.1".to_string(), test_port)));

        // Rebind to Specific + also_bind_loopback = true (Dual Listener)
        let dual_status = controller
            .set_bind_configuration(BindHostMode::Specific, Some(specific_ip.clone()), true)
            .await
            .expect("rebind to dual listener");
        assert!(dual_status.running);
        assert_eq!(dual_status.bind_mode, BindHostMode::Specific);
        assert_eq!(dual_status.specific_bind_ip.as_deref(), Some(specific_ip.as_str()));
        assert!(dual_status.also_bind_loopback);
        assert_eq!(
            dual_status.bound_ips,
            vec![specific_ip.clone(), "127.0.0.1".to_string()]
        );
        // OS system proxy stays on 127.0.0.1 when also_bind_loopback == true
        assert_eq!(os_backend.last_target(), Some(("127.0.0.1".to_string(), test_port)));

        // Verify TCP connections succeed on BOTH listeners
        TcpStream::connect(format!("{specific_ip}:{test_port}"))
            .await
            .expect("connect to primary specific IP listener");
        TcpStream::connect(format!("127.0.0.1:{test_port}"))
            .await
            .expect("connect to secondary loopback listener");

        // Switch also_bind_loopback -> false: single socket on specific_ip, system proxy updated to specific_ip
        let single_specific = controller
            .set_bind_configuration(BindHostMode::Specific, Some(specific_ip.clone()), false)
            .await
            .expect("rebind to specific without loopback");
        assert_eq!(single_specific.bound_ips, vec![specific_ip.clone()]);
        assert!(!single_specific.also_bind_loopback);
        assert_eq!(os_backend.last_target(), Some((specific_ip.clone(), test_port)));
        assert!(
            TcpListener::bind(format!("127.0.0.1:{test_port}")).await.is_ok(),
            "loopback socket must be released when also_bind_loopback is disabled"
        );

        // Re-enable dual listener, then test stop() synchronously shuts down all listener tasks
        let dual_again = controller
            .set_bind_configuration(BindHostMode::Specific, Some(specific_ip.clone()), true)
            .await
            .expect("rebind back to dual listener");
        assert_eq!(
            dual_again.bound_ips,
            vec![specific_ip.clone(), "127.0.0.1".to_string()]
        );

        let stopped = controller.stop().await;
        assert!(!stopped.running);

        // Both sockets must be released synchronously right after stop() returns
        let rebind_primary = TcpListener::bind(format!("{specific_ip}:{test_port}"))
            .await
            .expect("primary specific socket must be free after stop");
        drop(rebind_primary);
        let rebind_loopback = TcpListener::bind(format!("127.0.0.1:{test_port}"))
            .await
            .expect("secondary loopback socket must be free after stop");
        drop(rebind_loopback);

        // Test AddrInUse cleanup: occupy 127.0.0.1:conflict_port, then attempt dual bind
        // on [specific_ip, "127.0.0.1"]. First socket must be closed immediately when second fails.
        let occupied_loopback = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let conflict_port = occupied_loopback.local_addr().unwrap().port();
        let err = bind_listeners_with_cleanup(
            &[specific_ip.clone(), "127.0.0.1".to_string()],
            conflict_port,
            1,
        )
        .await
        .expect_err("second socket AddrInUse should fail dual bind");
        assert!(
            err.to_string().contains("AddrInUse"),
            "error should explain AddrInUse: {err}"
        );
        // Primary specific_ip:conflict_port MUST have been closed by cleanup
        let verify_primary_closed = TcpListener::bind(format!("{specific_ip}:{conflict_port}"))
            .await
            .expect("primary socket must be rolled back after second socket fails with AddrInUse");
        drop(verify_primary_closed);
        drop(occupied_loopback);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn formats_full_reqwest_error_source_chain() {
        #[derive(Debug)]
        struct LeafCause(&'static str);
        impl std::fmt::Display for LeafCause {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.0)
            }
        }
        impl std::error::Error for LeafCause {}

        #[derive(Debug)]
        struct MiddleCause {
            msg: &'static str,
            src: Box<dyn std::error::Error + Send + Sync>,
        }
        impl std::fmt::Display for MiddleCause {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.msg)
            }
        }
        impl std::error::Error for MiddleCause {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&*self.src)
            }
        }

        let nested = MiddleCause {
            msg: "error sending request for url",
            src: Box::new(MiddleCause {
                msg: "client error (Connect)",
                src: Box::new(MiddleCause {
                    msg: "client error (Connect)",
                    src: Box::new(LeafCause("ConnectionReset")),
                }),
            }),
        };
        assert_eq!(
            format_error_chain(&nested),
            "error sending request for url -> client error (Connect) -> ConnectionReset"
        );

        // Verify real reqwest error source traversal
        let dead_probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead_port = dead_probe.local_addr().unwrap().port();
        drop(dead_probe);

        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("reqwest test client should build");
        let req_err = client
            .get(format!("http://127.0.0.1:{dead_port}/unreachable"))
            .send()
            .await
            .expect_err("connecting to closed port must fail");
        let formatted_real = format_error_chain(&req_err);
        assert!(
            formatted_real.contains(" -> "),
            "expected reqwest error chain with ` -> `, got: {formatted_real}"
        );
    }

    #[tokio::test]
    async fn streams_video_partial_content_without_full_buffering() {
        let release_second_chunk = Arc::new(tokio::sync::Notify::new());
        let release_clone = release_second_chunk.clone();

        // 1. Mock upstream video server (request 1: 206 Partial Content chunked across a barrier;
        // request 2: truncated 206 video stream to verify mid-stream error recording).
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();

        tokio::spawn(async move {
            // Request 1: zero-buffering 206 Partial Content
            if let Ok((mut sock, _)) = upstream_listener.accept().await {
                let mut req_buf = [0u8; 2048];
                let _ = sock.read(&mut req_buf).await;
                let headers = b"HTTP/1.1 206 Partial Content\r\n\
                                Content-Type: video/mp4\r\n\
                                Content-Range: bytes 0-32767/1048576\r\n\
                                Content-Length: 32768\r\n\
                                Connection: close\r\n\r\n";
                sock.write_all(headers).await.unwrap();
                sock.write_all(&vec![b'A'; 16_384]).await.unwrap();
                sock.flush().await.unwrap();

                release_clone.notified().await;

                sock.write_all(&vec![b'B'; 16_384]).await.unwrap();
                sock.flush().await.unwrap();
                let _ = sock.shutdown().await;
            }

            // Request 2: mid-stream abrupt EOF before declared Content-Length (65536)
            if let Ok((mut sock, _)) = upstream_listener.accept().await {
                let mut req_buf = [0u8; 2048];
                let _ = sock.read(&mut req_buf).await;
                let headers = b"HTTP/1.1 206 Partial Content\r\n\
                                Content-Type: video/mp4\r\n\
                                Content-Range: bytes 0-65535/1048576\r\n\
                                Content-Length: 65536\r\n\
                                Connection: close\r\n\r\n";
                sock.write_all(headers).await.unwrap();
                sock.write_all(&vec![b'C'; 4_096]).await.unwrap();
                sock.flush().await.unwrap();
                drop(sock);
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-video-stream-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("video-stream.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                    break;
                };
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_c).await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();

        // Start request #1: client MUST receive 206 + first chunk BEFORE chunk #2 is released!
        let mut resp = tokio::time::timeout(
            Duration::from_secs(3),
            client
                .get(format!("http://{upstream_addr}/video.mp4"))
                .header("Range", "bytes=0-32767")
                .send(),
        )
        .await
        .expect("proxied 206 headers must arrive without buffering full video")
        .unwrap();

        assert_eq!(resp.status().as_u16(), 206);
        assert_eq!(
            resp.headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some("video/mp4")
        );
        assert_eq!(
            resp.headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok()),
            Some("bytes 0-32767/1048576")
        );
        assert_eq!(
            resp.headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok()),
            Some("32768")
        );

        let mut received = Vec::new();
        while received.len() < 16_384 {
            let chunk = tokio::time::timeout(Duration::from_secs(3), resp.chunk())
                .await
                .expect("first chunk must arrive while upstream still holds second chunk")
                .unwrap()
                .expect("expected first chunk bytes");
            received.extend_from_slice(&chunk);
        }
        assert!(received[..16_384].iter().all(|&b| b == b'A'));

        // Two-phase check mid-stream: TrafficStore already has status 206 while stream is open
        let mid_detail = store.get(1).expect("session 1 should be committed in phase 1");
        assert_eq!(mid_detail.summary.status, 206);
        assert!(mid_detail.response_body_base64.is_empty());

        // Release second chunk and read to EOF
        release_second_chunk.notify_one();
        while let Some(chunk) = resp.chunk().await.unwrap() {
            received.extend_from_slice(&chunk);
        }
        assert_eq!(received.len(), 32_768);
        assert!(received[16_384..].iter().all(|&b| b == b'B'));

        // Poll until stream task finishes updating final byte count & check binary video was NOT buffered
        let mut final_detail = None;
        for _ in 0..40 {
            if let Some(d) = store.get(1) {
                if d.summary.body_size == 32_768 {
                    final_detail = Some(d);
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let final_detail = final_detail.expect("TrafficStore should record 32768 streamed bytes");
        assert_eq!(final_detail.summary.status, 206);
        assert!(final_detail.summary.error.is_none());
        assert!(
            final_detail.response_body_base64.is_empty(),
            "binary video/206 response must not be accumulated into response_body_base64"
        );
        assert!(final_detail.response_body_text.is_none());
        assert!(!final_detail.body_offloaded);

        // Request #2: verify mid-stream truncation error is recorded on session #2
        let mut err_resp = client
            .get(format!("http://{upstream_addr}/broken-video.mp4"))
            .header("Range", "bytes=0-65535")
            .send()
            .await
            .unwrap();
        assert_eq!(err_resp.status().as_u16(), 206);
        while let Ok(Some(_)) = err_resp.chunk().await {}

        let mut broken_detail = None;
        for _ in 0..40 {
            if let Some(d) = store.get(2) {
                if d.summary.error.is_some() {
                    broken_detail = Some(d);
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let broken_detail = broken_detail.expect("session 2 should record mid-stream error");
        assert!(
            broken_detail
                .summary
                .error
                .as_deref()
                .unwrap_or("")
                .contains("Upstream response stream error"),
            "unexpected stream error text: {:?}",
            broken_detail.summary.error
        );

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn collect_request_body_limited_enforces_limit_and_returns_payload_too_large() {
        let within = collect_request_body_limited(Full::new(Bytes::from_static(b"hello")), 5)
            .await
            .expect("body equal to limit must succeed");
        assert_eq!(within.as_ref(), b"hello");

        let exceeded = collect_request_body_limited(Full::new(Bytes::from_static(b"hello!")), 5).await;
        match exceeded {
            Err(RequestBodyReadError::PayloadTooLarge(limit)) => assert_eq!(limit, 5),
            other => panic!("expected PayloadTooLarge(5), got {other:?}"),
        }

        // Also test via multi-frame chunked StreamBody crossing the limit
        let chunks = futures_util::stream::iter(vec![
            Ok::<_, Infallible>(Frame::data(Bytes::from_static(b"abc"))),
            Ok::<_, Infallible>(Frame::data(Bytes::from_static(b"def"))),
            Ok::<_, Infallible>(Frame::data(Bytes::from_static(b"ghi"))),
        ]);
        let streamed_exceeded = collect_request_body_limited(StreamBody::new(chunks), 8).await;
        match streamed_exceeded {
            Err(RequestBodyReadError::PayloadTooLarge(limit)) => assert_eq!(limit, 8),
            other => panic!("expected PayloadTooLarge(8) on streamed body, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn set_port_updates_stopped_and_running_with_rollback_on_addr_in_use() {
        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-setport-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let store = Arc::new(TrafficStore::new(tmp_dir.join("setport.sqlite")).unwrap());
        let os_backend = RecordingOsProxyBackend::new();
        let sysproxy = Arc::new(SystemProxyManager::with_backend(
            &tmp_dir,
            os_backend.clone(),
        ));

        let controller = ProxyEngineController::new_for_test(
            ca,
            rules,
            filters,
            store,
            sysproxy.clone(),
        )
        .unwrap();

        let p1_probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let p1 = p1_probe.local_addr().unwrap().port();
        drop(p1_probe);

        // 1. Update port while stopped -> persists pref and updates preferred_port
        let stopped_status = controller.set_port(p1).await.expect("set_port while stopped");
        assert!(!stopped_status.running);
        assert_eq!(stopped_status.port, p1);
        assert_eq!(controller.preferred_port(), p1);
        assert_eq!(sysproxy.load_proxy_port_pref(), p1);

        // 2. Start using preferred_port
        let started = controller
            .start_with_config(controller.preferred_port())
            .await
            .expect("start on preferred_port");
        assert!(started.running);
        assert_eq!(started.port, p1);

        // 3. Rebind to another free port p2 while running
        let p2_probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let p2 = p2_probe.local_addr().unwrap().port();
        drop(p2_probe);

        let moved = controller.set_port(p2).await.expect("set_port to p2 while running");
        assert!(moved.running);
        assert_eq!(moved.port, p2);
        assert_eq!(sysproxy.load_proxy_port_pref(), p2);
        TcpStream::connect(format!("127.0.0.1:{p2}"))
            .await
            .expect("connect to new port p2");

        // 4. Attempt switching to an already occupied port -> must fail AND roll back listener to p2
        let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let occupied_port = occupied.local_addr().unwrap().port();
        let err = controller
            .set_port(occupied_port)
            .await
            .expect_err("occupied port should fail");
        assert!(err.to_string().contains("AddrInUse"));

        let after_rollback = controller.status().await;
        assert!(after_rollback.running);
        assert_eq!(after_rollback.port, p2);
        assert_eq!(sysproxy.load_proxy_port_pref(), p2);
        TcpStream::connect(format!("127.0.0.1:{p2}"))
            .await
            .expect("listener restored on p2 after rollback");

        controller.stop().await;
        drop(occupied);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn python_script_hooks_run_after_zstd_and_skip_sse_and_video_streams() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();

        let zstd_json = zstd::encode_all(br#"{"msg":"hello-zstd"}"#.as_slice(), 1).unwrap();
        let received_req_header = Arc::new(std::sync::Mutex::new(None::<String>));
        let received_req_header_clone = received_req_header.clone();

        tokio::spawn(async move {
            for _ in 0..3 {
                let Ok((mut sock, _)) = upstream_listener.accept().await else {
                    break;
                };
                let mut buf = [0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&buf[..n]).to_string();
                let lower = req_str.to_ascii_lowercase();

                if req_str.contains("/zstd-api") {
                    for line in req_str.lines() {
                        if line.to_ascii_lowercase().starts_with("x-from-pyreq:") {
                            if let Ok(mut g) = received_req_header_clone.lock() {
                                *g = Some(line.split_once(':').map(|x| x.1.trim().to_string()).unwrap_or_default());
                            }
                        }
                    }
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: zstd\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        zstd_json.len()
                    );
                    sock.write_all(head.as_bytes()).await.unwrap();
                    sock.write_all(&zstd_json).await.unwrap();
                } else if req_str.contains("/sse-stream") {
                    let body = b"data: {\"ping\":1}\n\n";
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    sock.write_all(head.as_bytes()).await.unwrap();
                    sock.write_all(body).await.unwrap();
                } else if lower.contains("/clip.mp4") {
                    let body = vec![b'V'; 1024];
                    let head = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Range: bytes 0-1023/4096\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    sock.write_all(head.as_bytes()).await.unwrap();
                    sock.write_all(&body).await.unwrap();
                }
                let _ = sock.shutdown().await;
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-py-hooks-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("py-hooks.sqlite")).unwrap());
        let script_runner = Arc::new(PythonScriptRunner::new(None));
        if !script_runner.get_status().await.available {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return;
        }

        let py_code = r#"
import json

def on_request(request):
    request["headers"]["X-From-PyReq"] = "signed-v1"

def on_response(response, request):
    response["headers"]["X-From-PyResp"] = "decompressed"
    data = json.loads(response["body"])
    data["via_python"] = True
    response["body"] = json.dumps(data)
"#;
        let status = script_runner.set_script(py_code.to_string(), true).await.unwrap();
        assert!(status.enabled && status.has_on_request && status.has_on_response);

        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: script_runner.clone(),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                    break;
                };
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_c).await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();

        // 1. Standard zstd response -> on_request + on_response (after zstd decompression) must run
        let resp_zstd = client
            .get(format!("http://{upstream_addr}/zstd-api"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp_zstd.status().as_u16(), 200);
        assert_eq!(
            resp_zstd.headers().get("x-from-pyresp").and_then(|v| v.to_str().ok()),
            Some("decompressed")
        );
        let zstd_body_text = resp_zstd.text().await.unwrap();
        assert!(zstd_body_text.contains("\"msg\": \"hello-zstd\""));
        assert!(zstd_body_text.contains("\"via_python\": true"));
        assert_eq!(
            received_req_header.lock().unwrap().as_deref(),
            Some("signed-v1")
        );

        // 2. SSE response -> on_request runs (1 more invocation), on_response MUST be skipped
        let resp_sse = client
            .get(format!("http://{upstream_addr}/sse-stream"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp_sse.status().as_u16(), 200);
        assert!(resp_sse.headers().get("x-from-pyresp").is_none());
        let sse_body = resp_sse.text().await.unwrap();
        assert!(sse_body.contains("data: {\"ping\":1}"));

        // 3. 206 video/mp4 response -> on_request runs (1 more invocation), on_response MUST be skipped
        let resp_video = client
            .get(format!("http://{upstream_addr}/clip.mp4"))
            .header("Range", "bytes=0-1023")
            .send()
            .await
            .unwrap();
        assert_eq!(resp_video.status().as_u16(), 206);
        assert!(resp_video.headers().get("x-from-pyresp").is_none());
        let video_bytes = resp_video.bytes().await.unwrap();
        assert_eq!(video_bytes.len(), 1024);

        // Invocations: #1 (on_req + on_resp = 2), #2 SSE (on_req only = 1), #3 206 video (on_req only = 1) => 4 total
        let final_status = script_runner.get_status().await;
        assert_eq!(final_status.invocations_count, 4);

        script_runner.shutdown_sync();
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn sec03_portal_target_loopback_unspecified_and_mtls_peer_guards() {
        // Portal target detects IPv6-mapped loopback & unspecified addresses on active port
        assert!(is_builtin_portal_target("[::ffff:127.0.0.1]:8888", false, 8888));
        assert!(is_builtin_portal_target("::ffff:127.0.0.1:8888", false, 8888));
        assert!(is_builtin_portal_target("[::1]:8888", false, 8888));
        assert!(is_builtin_portal_target("0.0.0.0:8888", false, 8888));
        assert!(is_builtin_portal_target("flux.proxy", false, 8888));
        assert!(!is_builtin_portal_target("[::ffff:127.0.0.1]:9999", false, 8888));

        // Loopback & unspecified host checks for LAN SSRF protection
        for blocked in [
            "localhost",
            "api.localhost:8080",
            "127.0.0.1",
            "127.42.0.1:9000",
            "::1",
            "[::1]:443",
            "::ffff:127.0.0.1",
            "[::ffff:127.5.6.7]:8443",
            "0.0.0.0:80",
            "::",
            "[::ffff:0.0.0.0]:80",
            "127.1",
            "2130706433",
        ] {
            assert!(
                is_loopback_or_unspecified_host(blocked),
                "expected loopback/unspecified host to be blocked: {blocked}"
            );
        }

        for allowed in ["api.example.com", "192.168.1.50:8443", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(
                !is_loopback_or_unspecified_host(allowed),
                "expected external host to be allowed: {allowed}"
            );
        }

        assert!(request_targets_loopback_or_unspecified(
            "example.com",
            "http://127.0.0.1:8080/admin"
        ));
        assert!(request_targets_loopback_or_unspecified(
            "127.0.0.1:8080",
            "http://example.com/"
        ));
        assert!(!request_targets_loopback_or_unspecified(
            "example.com",
            "https://example.com/api"
        ));

        // mTLS client cert lookup must be disabled for external LAN peers
        assert!(!should_use_host_mtls_for_peer(
            "192.168.1.50:55555".parse().unwrap(),
            "https"
        ));
        assert!(!should_use_host_mtls_for_peer(
            "[::ffff:192.168.1.50]:55555".parse().unwrap(),
            "https"
        ));
        assert!(should_use_host_mtls_for_peer(
            "127.0.0.1:55555".parse().unwrap(),
            "https"
        ));
        assert!(should_use_host_mtls_for_peer(
            "[::1]:55555".parse().unwrap(),
            "https"
        ));
        assert!(should_use_host_mtls_for_peer(
            "[::ffff:127.0.0.1]:55555".parse().unwrap(),
            "https"
        ));
        assert!(!should_use_host_mtls_for_peer(
            "127.0.0.1:55555".parse().unwrap(),
            "http"
        ));
    }

    #[tokio::test]
    async fn sec03_blocks_self_connect_and_targeted_only_host_header_bypass() {
        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-sec03-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        filters.update_config(ProxyFilterBackendConfig {
            tls_intercept_mode: TlsInterceptMode::TargetedOnly,
            tls_bypass_enabled: true,
            tls_bypass_rules: Vec::new(),
            tls_target_rules: vec![TlsBypassRule {
                id: "only-allowed".into(),
                enabled: true,
                pattern: "allowed.test".into(),
                category: "Target".into(),
                description: "Allow only allowed.test".into(),
            }],
            header_mutations_enabled: false,
            header_mutations: Vec::new(),
            strip_alt_svc: true,
            host_list_sync: Default::default(),
            ..crate::proxy::filters::default_backend_config()
        });

        let store = Arc::new(TrafficStore::new(tmp_dir.join("sec03.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();

        let ctx = Arc::new(SharedProxyContext {
            ca: ca.clone(),
            rules,
            filters,
            breakpoints: Arc::new(BreakpointEngine::new(None)),
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store,
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(proxy_addr.port()),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_ctx = ctx.clone();
        tokio::spawn(async move {
            for _ in 0..4 {
                if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                    let io = TokioIo::new(tcp_stream);
                    let c = proxy_ctx.clone();
                    tokio::spawn(async move {
                        let service = service_fn(move |req: Request<Incoming>| {
                            let inner_c = c.clone();
                            async move {
                                Ok::<_, Infallible>(
                                    handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_c)
                                        .await,
                                )
                            }
                        });
                        let _ = AutoConnBuilder::new(TokioExecutor::new())
                            .serve_connection_with_upgrades(io, service)
                            .await;
                    });
                }
            }
        });

        // 1. Self-CONNECT in TargetedOnly mode (including IPv6-mapped ::ffff:127.0.0.1) must be 403 Forbidden
        for self_auth in [
            format!("127.0.0.1:{}", proxy_addr.port()),
            format!("[::ffff:127.0.0.1]:{}", proxy_addr.port()),
        ] {
            let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
            let req = format!("CONNECT {self_auth} HTTP/1.1\r\nHost: {self_auth}\r\n\r\n");
            sock.write_all(req.as_bytes()).await.unwrap();
            let mut buf = [0u8; 512];
            let n = sock.read(&mut buf).await.unwrap();
            let resp = String::from_utf8_lossy(&buf[..n]);
            assert!(
                resp.starts_with("HTTP/1.1 403"),
                "expected 403 for self-CONNECT {self_auth}, got: {resp}"
            );
        }

        // 2. Spoofed Host inside TargetedOnly CONNECT MITM tunnel must be rejected with 403 Forbidden
        let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
        sock.write_all(b"CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n")
            .await
            .unwrap();
        let mut connect_buf = [0u8; 256];
        let n = sock.read(&mut connect_buf).await.unwrap();
        assert!(String::from_utf8_lossy(&connect_buf[..n]).starts_with("HTTP/1.1 200"));

        let mut root_store = rustls::RootCertStore::empty();
        root_store
            .add(rustls::pki_types::CertificateDer::from(
                ca.root_ca_der().to_vec(),
            ))
            .unwrap();
        let tls_cfg = Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth(),
        );
        let connector = tokio_rustls::TlsConnector::from(tls_cfg);
        let server_name = rustls::pki_types::ServerName::try_from("allowed.test").unwrap();
        let mut tls_stream = connector.connect(server_name, sock).await.unwrap();

        tls_stream
            .write_all(
                b"GET /secret HTTP/1.1\r\nHost: non-allowlisted.example.com\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        let mut resp_bytes = Vec::new();
        let _ = tls_stream.read_to_end(&mut resp_bytes).await;
        let inner_resp = String::from_utf8_lossy(&resp_bytes);
        assert!(
            inner_resp.starts_with("HTTP/1.1 403"),
            "expected 403 for spoofed Host inside TargetedOnly tunnel, got: {inner_resp}"
        );

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn sec05_decode_zstd_bounded_enforces_limit_and_decodes_within_limit() {
        let plain = vec![b'A'; 4096];
        let compressed = zstd::encode_all(plain.as_slice(), 1).unwrap();

        let ok = decode_zstd_bounded(&compressed, 4096).expect("within exact limit");
        assert_eq!(ok.len(), 4096);

        let err = decode_zstd_bounded(&compressed, 2048).expect_err("must reject oversized output");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn split_authority_parses_ipv6_and_host_port_variants() {
        assert_eq!(split_authority("[::1]"), ("::1".to_string(), 443));
        assert_eq!(split_authority("[::1]:8443"), ("::1".to_string(), 8443));
        assert_eq!(split_authority("::1"), ("::1".to_string(), 443));
        assert_eq!(
            split_authority("[2001:db8::1]:9443"),
            ("2001:db8::1".to_string(), 9443)
        );
        assert_eq!(
            split_authority("2001:db8::8080"),
            ("2001:db8::8080".to_string(), 443)
        );
        assert_eq!(
            split_authority("api.example.com:8443"),
            ("api.example.com".to_string(), 8443)
        );
        assert_eq!(
            split_authority("api.example.com"),
            ("api.example.com".to_string(), 443)
        );
        assert_eq!(
            split_authority("127.0.0.1:8080"),
            ("127.0.0.1".to_string(), 8080)
        );
    }

    #[tokio::test]
    async fn breakpoint_raii_guard_cleans_up_pending_on_client_disconnect_and_composer_abort_records_502() {
        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-bp-guard-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let (bp_tx, mut bp_rx) = mpsc::unbounded_channel();
        let breakpoints = Arc::new(BreakpointEngine::new(Some(bp_tx)));
        breakpoints.update_config(BreakpointConfig {
            break_before_request: true,
            break_after_response: false,
            timeout_secs: 60,
            rules: Vec::new(),
        });
        let store = Arc::new(TrafficStore::new(tmp_dir.join("bp-guard.sqlite")).unwrap());
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let os_backend = RecordingOsProxyBackend::new();
        let sysproxy = Arc::new(SystemProxyManager::with_backend(&tmp_dir, os_backend));

        let ctx = Arc::new(SharedProxyContext {
            ca: ca.clone(),
            rules: rules.clone(),
            filters: filters.clone(),
            breakpoints: breakpoints.clone(),
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let c = proxy_ctx.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), c).await,
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            }
        });

        // 1. Client opens HTTP request via proxy, pauses at Before Request breakpoint, then drops TCP socket
        let mut client_sock = TcpStream::connect(proxy_addr).await.unwrap();
        client_sock
            .write_all(b"GET http://example.invalid/disconnect-bp HTTP/1.1\r\nHost: example.invalid\r\n\r\n")
            .await
            .unwrap();

        let paused_snap = tokio::time::timeout(Duration::from_secs(3), bp_rx.recv())
            .await
            .expect("expected breakpoint snapshot")
            .expect("snapshot channel open");
        assert_eq!(paused_snap.len(), 1);
        let paused_sid = paused_snap[0].session_id;
        assert_eq!(breakpoints.list_paused().len(), 1);

        // Simulate client abort/disconnect while paused at breakpoint
        drop(client_sock);

        let cleared_snap = tokio::time::timeout(Duration::from_secs(3), bp_rx.recv())
            .await
            .expect("expected cleared breakpoint snapshot on disconnect")
            .expect("snapshot channel open");
        assert!(
            cleared_snap.is_empty(),
            "breakpoint pending snapshot must be cleared on client disconnect"
        );
        assert!(breakpoints.list_paused().is_empty());

        let updated_detail = store.get(paused_sid).expect("session must exist in TrafficStore");
        assert_eq!(updated_detail.summary.status, 499);
        assert!(updated_detail.summary.breakpoint_paused.is_none());
        let mut saw_499_event = false;
        while let Ok(ev) = event_rx.try_recv() {
            if ev.id == paused_sid && ev.status == 499 && ev.breakpoint_paused.is_none() {
                saw_499_event = true;
            }
        }
        assert!(saw_499_event, "TrafficStore update event with status 499 must be emitted");

        // 2. Composer Abort at Request Breakpoint must update session to 502 with breakpoint_paused = None
        let (comp_bp_tx, mut comp_bp_rx) = mpsc::unbounded_channel();
        let (comp_event_tx, _comp_event_rx) = mpsc::unbounded_channel();
        let (comp_removed_tx, _comp_removed_rx) = mpsc::unbounded_channel();
        let controller = ProxyEngineController::new_with_channels(
            ca,
            rules,
            filters,
            store.clone(),
            sysproxy,
            Arc::new(ClientCertificateStore::in_memory()),
            comp_event_tx,
            comp_removed_tx,
            comp_bp_tx,
            None,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        controller.context.breakpoints.update_config(BreakpointConfig {
            break_before_request: true,
            break_after_response: false,
            timeout_secs: 60,
            rules: Vec::new(),
        });
        let comp_bp = controller.context.breakpoints.clone();
        tokio::spawn(async move {
            if let Some(snapshot) = comp_bp_rx.recv().await {
                if let Some(item) = snapshot.first() {
                    comp_bp.resolve(BreakpointResolution {
                        breakpoint_id: item.breakpoint_id.clone(),
                        action: BreakpointAction::Abort,
                        method: None,
                        url: None,
                        request_headers: None,
                        request_body_base64: None,
                        request_body_text: None,
                        status_code: None,
                        response_headers: None,
                        response_body_base64: None,
                        response_body_text: None,
                    });
                }
            }
        });

        let composed_res = controller
            .execute_composed(ComposedRequest {
                method: "POST".into(),
                url: "http://example.invalid/composer-abort".into(),
                headers: Vec::new(),
                body: "payload".into(),
                body_base64: None,
                follow_redirects: false,
                skip_python_scripts: None,
                request_id: None,
                timeout_sec: None,
            })
            .await;
        assert!(composed_res.is_err());

        let composer_summary = store
            .list_summaries()
            .into_iter()
            .find(|s| s.path == "/composer-abort")
            .expect("aborted composed session must be recorded in TrafficStore");
        assert_eq!(composer_summary.status, 502);
        assert!(composer_summary.breakpoint_paused.is_none());

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn websocket_connect_timeout_and_bidirectional_large_frame_blast_without_deadlock() {
        use tokio_tungstenite::tungstenite::Message;

        // 1. Stalled TCP listener (accepts socket, never sends HTTP 101) to test connect_async timeout
        let stalled_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stalled_addr = stalled_listener.local_addr().unwrap();
        let stalled_task = tokio::spawn(async move {
            if let Ok((sock, _)) = stalled_listener.accept().await {
                tokio::time::sleep(Duration::from_secs(10)).await;
                drop(sock);
            }
        });

        // 2. Blast WS upstream: after 1 trigger frame, immediately writes 32 * 64 KiB = 2 MiB
        // BEFORE reading client's 32 * 64 KiB frames (would deadlock single-loop select!)
        let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_addr = ws_listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((sock, _)) = ws_listener.accept().await {
                let ws_stream = tokio_tungstenite::accept_async(sock).await.unwrap();
                let (mut sink, mut stream) = ws_stream.split();
                let trigger = stream.next().await.unwrap().unwrap();
                assert_eq!(trigger.into_text().unwrap().as_str(), "start-blast");

                let server_payload = "S".repeat(64 * 1024);
                for _ in 0..32 {
                    sink.send(Message::Text(server_payload.clone().into()))
                        .await
                        .unwrap();
                }

                let mut client_frames = 0usize;
                while client_frames < 32 {
                    let msg = stream.next().await.unwrap().unwrap();
                    assert_eq!(msg.len(), 64 * 1024);
                    client_frames += 1;
                }
                let _ = sink.close().await;
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-ws-deadlock-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("ws-deadlock.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(1)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            for _ in 0..2 {
                if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                    let c = proxy_ctx.clone();
                    tokio::spawn(async move {
                        let io = TokioIo::new(tcp_stream);
                        let service = service_fn(move |req: Request<Incoming>| {
                            let inner_c = c.clone();
                            async move {
                                Ok::<_, Infallible>(
                                    handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_c)
                                        .await,
                                )
                            }
                        });
                        let _ = AutoConnBuilder::new(TokioExecutor::new())
                            .serve_connection_with_upgrades(io, service)
                            .await;
                    });
                }
            }
        });

        // Verify connect_async timeout returns 502 promptly
        let mut stalled_client = TcpStream::connect(proxy_addr).await.unwrap();
        let stalled_req = format!(
            "GET http://{stalled_addr}/ws-hang HTTP/1.1\r\n\
             Host: {stalled_addr}\r\n\
             Connection: Upgrade\r\n\
             Upgrade: websocket\r\n\
             Sec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        );
        stalled_client.write_all(stalled_req.as_bytes()).await.unwrap();
        let mut stalled_resp_buf = vec![0u8; 1024];
        let n = tokio::time::timeout(Duration::from_secs(4), stalled_client.read(&mut stalled_resp_buf))
            .await
            .expect("WS connect timeout must fire promptly within 4s")
            .unwrap();
        let stalled_resp_str = String::from_utf8_lossy(&stalled_resp_buf[..n]);
        assert!(stalled_resp_str.starts_with("HTTP/1.1 502"));
        assert!(stalled_resp_str.contains("timed out"));
        stalled_task.abort();

        // Verify bidirectional 2 MiB * 2 simultaneous large frame blast completes without deadlock
        let mut blast_client_tcp = TcpStream::connect(proxy_addr).await.unwrap();
        let blast_req = format!(
            "GET http://{ws_addr}/ws-blast HTTP/1.1\r\n\
             Host: {ws_addr}\r\n\
             Connection: Upgrade\r\n\
             Upgrade: websocket\r\n\
             Sec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        );
        blast_client_tcp.write_all(blast_req.as_bytes()).await.unwrap();
        let mut hs_buf = Vec::new();
        let mut b = [0u8; 1];
        while !hs_buf.ends_with(b"\r\n\r\n") {
            blast_client_tcp.read_exact(&mut b).await.unwrap();
            hs_buf.push(b[0]);
        }
        assert!(String::from_utf8_lossy(&hs_buf).starts_with("HTTP/1.1 101"));

        let blast_ws = WebSocketStream::from_raw_socket(blast_client_tcp, Role::Client, None).await;
        let (mut c_sink, mut c_stream) = blast_ws.split();
        c_sink
            .send(Message::Text("start-blast".into()))
            .await
            .unwrap();

        let send_fut = async move {
            let client_payload = "C".repeat(64 * 1024);
            for _ in 0..32 {
                c_sink
                    .send(Message::Text(client_payload.clone().into()))
                    .await
                    .unwrap();
            }
            c_sink
        };
        let recv_fut = async move {
            let mut server_frames = 0usize;
            while server_frames < 32 {
                let msg = c_stream.next().await.unwrap().unwrap();
                assert_eq!(msg.len(), 64 * 1024);
                server_frames += 1;
            }
        };

        let (mut c_sink, ()) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(send_fut, recv_fut)
        })
        .await
        .expect("bidirectional large WS frame relay must not deadlock");
        let _ = c_sink.close().await;

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn head_preserves_content_length_and_layered_or_unknown_content_encoding_preserved() {
        use std::io::Write;

        let plain_layered = "MultiLayerEncodedBody-1234567890";
        let gzipped = {
            let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(plain_layered.as_bytes()).unwrap();
            enc.finish().unwrap()
        };
        let gzip_then_zstd = zstd::encode_all(gzipped.as_slice(), 3).unwrap();
        let unknown_inner = b"OPAQUE_CUSTOM_STREAM";
        let custom_then_zstd = zstd::encode_all(unknown_inner.as_slice(), 3).unwrap();
        let raw_custom = b"RAW_UNKNOWN_ENCODING_BYTES";

        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();

        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = upstream_listener.accept().await else {
                    break;
                };
                let gzip_then_zstd = gzip_then_zstd.clone();
                let custom_then_zstd = custom_then_zstd.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req_str = String::from_utf8_lossy(&buf[..n]);
                    if req_str.starts_with("HEAD ") {
                        let head = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 4096\r\nConnection: close\r\n\r\n";
                        sock.write_all(head.as_bytes()).await.unwrap();
                    } else if req_str.contains("/multi-gzip-zstd") {
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Encoding: gzip, zstd\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            gzip_then_zstd.len()
                        );
                        sock.write_all(head.as_bytes()).await.unwrap();
                        sock.write_all(&gzip_then_zstd).await.unwrap();
                    } else if req_str.contains("/partial-custom-zstd") {
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Encoding: x-custom, zstd\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            custom_then_zstd.len()
                        );
                        sock.write_all(head.as_bytes()).await.unwrap();
                        sock.write_all(&custom_then_zstd).await.unwrap();
                    } else if req_str.contains("/unknown-enc") {
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Encoding: x-custom-enc\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            raw_custom.len()
                        );
                        sock.write_all(head.as_bytes()).await.unwrap();
                        sock.write_all(raw_custom).await.unwrap();
                    }
                    let _ = sock.shutdown().await;
                });
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-head-ce-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("head-ce.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store,
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                    break;
                };
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_c).await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();

        // 1. HEAD preserves original Content-Length: 4096
        let head_resp = client
            .head(format!("http://{upstream_addr}/file.bin"))
            .send()
            .await
            .unwrap();
        assert_eq!(head_resp.status(), StatusCode::OK);
        assert_eq!(
            head_resp
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok()),
            Some("4096")
        );

        // 2. Multi-layer gzip, zstd -> both layers decoded, Content-Encoding removed
        let multi_resp = client
            .get(format!("http://{upstream_addr}/multi-gzip-zstd"))
            .send()
            .await
            .unwrap();
        assert!(multi_resp.headers().get("content-encoding").is_none());
        assert_eq!(multi_resp.text().await.unwrap(), plain_layered);

        // 3. Partial x-custom, zstd -> zstd peeled, x-custom preserved
        let partial_resp = client
            .get(format!("http://{upstream_addr}/partial-custom-zstd"))
            .send()
            .await
            .unwrap();
        assert_eq!(
            partial_resp
                .headers()
                .get("content-encoding")
                .and_then(|v| v.to_str().ok()),
            Some("x-custom")
        );
        assert_eq!(partial_resp.bytes().await.unwrap().as_ref(), unknown_inner);

        // 4. Unknown Content-Encoding preserved verbatim with original bytes
        let unknown_resp = client
            .get(format!("http://{upstream_addr}/unknown-enc"))
            .send()
            .await
            .unwrap();
        assert_eq!(
            unknown_resp
                .headers()
                .get("content-encoding")
                .and_then(|v| v.to_str().ok()),
            Some("x-custom-enc")
        );
        assert_eq!(unknown_resp.bytes().await.unwrap().as_ref(), raw_custom);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn set_bind_configuration_rolls_back_sysproxy_on_double_bind_failure() {
        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-bind-rollback-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let store = Arc::new(TrafficStore::new(tmp_dir.join("bind-rollback.sqlite")).unwrap());
        let os_backend = RecordingOsProxyBackend::new();
        let sysproxy = Arc::new(SystemProxyManager::with_backend(
            &tmp_dir,
            os_backend.clone(),
        ));

        let controller = ProxyEngineController::new_for_test(
            ca,
            rules,
            filters,
            store,
            sysproxy,
        )
        .unwrap();

        let started = controller
            .start("127.0.0.1".to_string(), 0)
            .await
            .expect("start loopback proxy");
        assert!(started.running);
        assert!(started.system_proxy_enabled);

        // Simulate previous bound interface becoming unavailable (e.g. Wi-Fi disconnected)
        {
            let mut guard = controller.lock_runtime();
            guard.bind_mode = BindHostMode::Specific;
            guard.specific_bind_ip = Some("203.0.113.1".to_string());
            guard.also_bind_loopback = false;
            guard.bound_ips = vec!["203.0.113.1".to_string()];
        }

        // Switching to another unbindable IP causes primary + fallback binds to fail
        let err = controller
            .set_bind_configuration(
                BindHostMode::Specific,
                Some("203.0.113.2".to_string()),
                false,
            )
            .await
            .expect_err("double bind failure must return error");
        let _ = err;

        let post_status = controller.status().await;
        assert!(!post_status.running);
        assert!(
            !post_status.system_proxy_enabled,
            "OS system proxy must be rolled back on double bind failure"
        );
        assert!(os_backend.active.lock().unwrap().is_none());

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn hosts_remap_redirects_http_request_to_local_test_server_and_marks_session() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();

        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, _)) = upstream_listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let svc = service_fn(|req: Request<Incoming>| async move {
                        let host_hdr = req
                            .headers()
                            .get(http::header::HOST)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        let path = req
                            .uri()
                            .path_and_query()
                            .map(|pq| pq.as_str())
                            .unwrap_or("/")
                            .to_string();
                        let body = format!("host={host_hdr};path={path}");
                        Ok::<_, Infallible>(
                            Response::builder()
                                .status(StatusCode::OK)
                                .header("Content-Type", "text/plain")
                                .body(Full::new(Bytes::from(body)))
                                .unwrap(),
                        )
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-hosts-http-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let host_remap = Arc::new(HostRemapRegistry::new());
        let throttle = Arc::new(ThrottleEngine::new());
        let store = Arc::new(TrafficStore::new(tmp_dir.join("hosts-http.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        host_remap
            .set_rules(vec![crate::models::HostRemapRule {
                id: "http-remap".into(),
                enabled: true,
                source_pattern: "api.virtual-prod.invalid".into(),
                target_host: "127.0.0.1".into(),
                target_port: Some(upstream_addr.port()),
                preserve_host_header: true,
                comment: "redirect prod API to local upstream".into(),
            }])
            .unwrap();

        let resolver = Arc::clone(&host_remap);

        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: host_remap.clone(),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle,
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(Some(resolver)),
            remote_upstream_http_client: test_remote_upstream_http_client(Some(Arc::clone(&host_remap))),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                    break;
                };
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_ctx = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_ctx).await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();

        // 1. preserve_host_header = true -> upstream receives virtual Host header
        let resp1 = client
            .get("http://api.virtual-prod.invalid/v1/items?page=1")
            .send()
            .await
            .unwrap();
        assert_eq!(resp1.status(), StatusCode::OK);
        let body1 = resp1.text().await.unwrap();
        assert_eq!(body1, "host=api.virtual-prod.invalid;path=/v1/items?page=1");

        // 2. preserve_host_header = false -> upstream receives target host:port as Host header
        host_remap
            .set_rules(vec![crate::models::HostRemapRule {
                id: "http-remap".into(),
                enabled: true,
                source_pattern: "api.virtual-prod.invalid".into(),
                target_host: "127.0.0.1".into(),
                target_port: Some(upstream_addr.port()),
                preserve_host_header: false,
                comment: "rewrite Host header".into(),
            }])
            .unwrap();
        ctx.rebuild_upstream_clients();

        let resp2 = client
            .get("http://api.virtual-prod.invalid/v1/override")
            .send()
            .await
            .unwrap();
        assert_eq!(resp2.status(), StatusCode::OK);
        let body2 = resp2.text().await.unwrap();
        assert_eq!(
            body2,
            format!("host=127.0.0.1:{};path=/v1/override", upstream_addr.port())
        );

        tokio::time::sleep(Duration::from_millis(40)).await;
        let summaries = store.list_summaries();
        assert_eq!(summaries.len(), 2);
        let expected_remap = Some(format!("127.0.0.1:{}", upstream_addr.port()));
        for s in &summaries {
            assert_eq!(s.remapped_to, expected_remap);
            let detail = store.get(s.id).unwrap();
            assert_eq!(detail.summary.remapped_to, expected_remap);
        }

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn hosts_remap_preserves_tls_sni_for_https_upstream() {
        let tls_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tls_addr = tls_listener.local_addr().unwrap();
        let (sni_tx, sni_rx) = tokio::sync::oneshot::channel::<Option<String>>();

        tokio::spawn(async move {
            if let Ok((stream, _)) = tls_listener.accept().await {
                let acceptor =
                    tokio_rustls::LazyConfigAcceptor::new(rustls::server::Acceptor::default(), stream);
                tokio::pin!(acceptor);
                let sni = match acceptor.as_mut().await {
                    Ok(start) => start.client_hello().server_name().map(str::to_owned),
                    Err(_) => None,
                };
                let _ = sni_tx.send(sni);
            }
        });

        let host_remap = Arc::new(HostRemapRegistry::new());
        host_remap
            .set_rules(vec![crate::models::HostRemapRule {
                id: "sni-test".into(),
                enabled: true,
                source_pattern: "sni-check.virtual-prod.invalid".into(),
                target_host: "127.0.0.1".into(),
                target_port: Some(tls_addr.port()),
                preserve_host_header: true,
                comment: "SNI verification".into(),
            }])
            .unwrap();

        let resolver = Arc::clone(&host_remap);
        let client = UpstreamHttpClient::build(
            Some(resolver),
            None,
            None,
            Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            false,
        )
        .unwrap();

        let _ = client
            .send_request(
                hyper::Method::GET,
                "https://sni-check.virtual-prod.invalid/ping",
                &[],
                None,
                bytes::Bytes::new(),
                Some(Duration::from_secs(3)),
            )
            .await;

        let captured_sni = tokio::time::timeout(Duration::from_secs(3), sni_rx)
            .await
            .expect("TLS listener should accept ClientHello within timeout")
            .expect("SNI sender should not drop before sending");

        assert_eq!(
            captured_sni.as_deref(),
            Some("sni-check.virtual-prod.invalid"),
            "HTTPS upstream TLS handshake must keep original domain as SNI even when remapped to 127.0.0.1"
        );
    }

    #[tokio::test]
    async fn hosts_remap_redirects_connect_passthrough_and_offline_throttle_blocks() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();

        tokio::spawn(async move {
            if let Ok((mut sock, _)) = upstream_listener.accept().await {
                let mut buf = [0u8; 64];
                if let Ok(n) = sock.read(&mut buf).await {
                    let _ = sock.write_all(&buf[..n]).await;
                }
                let _ = sock.shutdown().await;
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-remap-connect-offline-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let host_remap = Arc::new(HostRemapRegistry::new());
        let throttle = Arc::new(ThrottleEngine::new());
        let store = Arc::new(
            TrafficStore::new(tmp_dir.join("remap-connect-offline.sqlite")).unwrap(),
        );
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        filters.update_config(ProxyFilterBackendConfig {
            tls_intercept_mode: TlsInterceptMode::InterceptAll,
            tls_bypass_enabled: true,
            tls_bypass_rules: vec![TlsBypassRule {
                id: "bypass-pinned-remap".into(),
                enabled: true,
                pattern: "pinned.virtual-prod.invalid".into(),
                category: "Test".into(),
                description: "Pinned virtual host".into(),
            }],
            tls_target_rules: Vec::new(),
            header_mutations_enabled: true,
            header_mutations: Vec::new(),
            strip_alt_svc: true,
            host_list_sync: Default::default(),
            ..crate::proxy::filters::default_backend_config()
        });

        host_remap
            .set_rules(vec![crate::models::HostRemapRule {
                id: "connect-remap".into(),
                enabled: true,
                source_pattern: "pinned.virtual-prod.invalid".into(),
                target_host: "127.0.0.1".into(),
                target_port: Some(upstream_addr.port()),
                preserve_host_header: true,
                comment: "redirect CONNECT passthrough".into(),
            }])
            .unwrap();

        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap,
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: throttle.clone(),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                    break;
                };
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_ctx = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_ctx).await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        // 1. CONNECT passthrough redirects to local echo server on upstream_addr.port()
        let mut client = TcpStream::connect(proxy_addr).await.unwrap();
        let connect_req = "CONNECT pinned.virtual-prod.invalid:443 HTTP/1.1\r\nHost: pinned.virtual-prod.invalid:443\r\n\r\n";
        client.write_all(connect_req.as_bytes()).await.unwrap();

        let mut resp_buf = [0u8; 256];
        let n = client.read(&mut resp_buf).await.unwrap();
        let resp_str = String::from_utf8_lossy(&resp_buf[..n]);
        assert!(resp_str.starts_with("HTTP/1.1 200"));

        let payload = b"PING_REMAP_CONNECT";
        client.write_all(payload).await.unwrap();
        let mut echoed = vec![0u8; payload.len()];
        client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, payload);
        drop(client);

        tokio::time::sleep(Duration::from_millis(40)).await;
        let expected_target = format!("127.0.0.1:{}", upstream_addr.port());
        let first_detail = store.get(1).unwrap();
        assert_eq!(first_detail.summary.remapped_to, Some(expected_target.clone()));
        assert!(first_detail
            .response_headers
            .iter()
            .any(|h| h.name == "X-FluxProxy-Host-Remap" && h.value == expected_target));

        // 2. Switch throttle preset to Offline -> CONNECT and HTTP both return 503
        throttle.set_config(crate::models::ThrottleConfig::from_preset(
            crate::models::ThrottlePreset::Offline,
        ));

        let mut offline_connect = TcpStream::connect(proxy_addr).await.unwrap();
        offline_connect
            .write_all(connect_req.as_bytes())
            .await
            .unwrap();
        let mut offline_buf = [0u8; 256];
        let n_off = offline_connect.read(&mut offline_buf).await.unwrap();
        let off_str = String::from_utf8_lossy(&offline_buf[..n_off]);
        assert!(
            off_str.starts_with("HTTP/1.1 503"),
            "expected CONNECT under Offline throttle to return 503, got: {off_str}"
        );

        let http_client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();
        let http_off_resp = http_client
            .get("http://127.0.0.1/offline-check")
            .send()
            .await
            .unwrap();
        assert_eq!(http_off_resp.status(), StatusCode::SERVICE_UNAVAILABLE);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn captures_cold_vs_reused_upstream_connection_timings_and_transfer_stats() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (mut sock, _) = upstream_listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            // Request 1 on keep-alive connection
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: keep-alive\r\n\r\nfirst")
                .await;
            let _ = sock.flush().await;
            // Request 2 reused on same upstream TCP socket
            let _ = sock.read(&mut buf).await;
            tokio::time::sleep(Duration::from_millis(8)).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 6\r\nConnection: keep-alive\r\n\r\nsecond")
                .await;
            let _ = sock.flush().await;
            let _ = sock.read(&mut buf).await;
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-pool-timings-{}",
            std::process::id()
        ));
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("pool.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                    break;
                };
                let c = proxy_ctx.clone();
                let conn_ctx = ClientConnContext::new();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_ctx = c.clone();
                        let req_conn = conn_ctx.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, None, req_conn, inner_ctx)
                                    .await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();

        let r1 = client
            .get(format!("http://127.0.0.1:{}/one", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(r1.text().await.unwrap(), "first");

        let r2 = client
            .get(format!("http://127.0.0.1:{}/two", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(r2.text().await.unwrap(), "second");

        tokio::time::sleep(Duration::from_millis(40)).await;

        let d1 = store.get(1).expect("first session stored");
        let d2 = store.get(2).expect("second session stored");

        let t1 = d1.timings.as_ref().expect("session 1 timings");
        let s1 = d1.transfer_stats.as_ref().expect("session 1 stats");
        assert_eq!(s1.server_conn_reused, Some(false));
        assert_eq!(s1.server_ip.as_deref(), Some("127.0.0.1"));
        assert!(s1.server_conn_id.is_some());
        assert!(t1.tcp_connect_ms.is_some());
        assert!(t1.server_wait_ms.is_some());
        assert_eq!(s1.response_body_bytes, Some(5));
        assert_eq!(s1.response_wire_body_bytes, Some(5));
        assert!(s1.request_headers_bytes.is_some());
        assert!(s1.response_headers_bytes.is_some());

        let t2 = d2.timings.as_ref().expect("session 2 timings");
        let s2 = d2.transfer_stats.as_ref().expect("session 2 stats");
        assert_eq!(s2.server_conn_reused, Some(true));
        assert_eq!(s2.server_conn_id, s1.server_conn_id);
        assert_eq!(t2.dns_ms, Some(0.0));
        assert_eq!(t2.tcp_connect_ms, Some(0.0));
        assert_eq!(d2.summary.server_conn_reused, Some(true));
        assert!(d2.summary.ttfb_ms.is_some());
        assert!(t2.server_wait_ms.unwrap_or(0.0) >= 5.0);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn captures_gzip_and_zstd_wire_vs_decoded_bytes() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write as _;

        let plain_json = serde_json::json!({
            "items": vec!["fluxproxy-compression-benchmark-payload-item"; 24],
            "ok": true
        })
        .to_string();
        let plain_bytes = plain_json.as_bytes().to_vec();

        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(&plain_bytes).unwrap();
        let gz_bytes = gz.finish().unwrap();
        let zstd_bytes = zstd::encode_all(plain_bytes.as_slice(), 3).unwrap();
        assert!(gz_bytes.len() < plain_bytes.len());
        assert!(zstd_bytes.len() < plain_bytes.len());

        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        let gz_clone = gz_bytes.clone();
        let zstd_clone = zstd_bytes.clone();

        tokio::spawn(async move {
            for (enc, body) in [("gzip", gz_clone), ("zstd", zstd_clone)] {
                let (mut sock, _) = upstream_listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: {enc}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&body).await;
                let _ = sock.shutdown().await;
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-wire-compression-{}",
            std::process::id()
        ));
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let store = Arc::new(TrafficStore::new(tmp_dir.join("comp.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules: Arc::new(RuleEngine::new()),
            filters: Arc::new(ProxyFilterEngine::new()),
            breakpoints: Arc::new(BreakpointEngine::new(None)),
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                    break;
                };
                let c = proxy_ctx.clone();
                let conn_ctx = ClientConnContext::new();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_ctx = c.clone();
                        let req_conn = conn_ctx.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, None, req_conn, inner_ctx)
                                    .await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();

        let r_gz = client
            .get(format!("http://127.0.0.1:{}/gz", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(r_gz.status(), StatusCode::OK);
        let _ = r_gz.bytes().await.unwrap();

        let r_zstd = client
            .get(format!("http://127.0.0.1:{}/zstd", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(r_zstd.status(), StatusCode::OK);
        let _ = r_zstd.bytes().await.unwrap();

        tokio::time::sleep(Duration::from_millis(40)).await;

        let d_gz = store.get(1).expect("gzip session stored");
        let st_gz = d_gz.transfer_stats.as_ref().expect("gzip stats");
        assert_eq!(st_gz.response_content_encoding.as_deref(), Some("gzip"));
        assert_eq!(st_gz.response_wire_body_bytes, Some(gz_bytes.len()));
        assert_eq!(st_gz.response_body_bytes, Some(plain_bytes.len()));
        assert!(st_gz.response_wire_body_bytes.unwrap() < st_gz.response_body_bytes.unwrap());
        assert_eq!(d_gz.summary.wire_body_size, Some(gz_bytes.len()));
        assert_eq!(d_gz.response_body_text.as_deref(), Some(plain_json.as_str()));

        let d_zstd = store.get(2).expect("zstd session stored");
        let st_zstd = d_zstd.transfer_stats.as_ref().expect("zstd stats");
        assert_eq!(st_zstd.response_content_encoding.as_deref(), Some("zstd"));
        assert_eq!(st_zstd.response_wire_body_bytes, Some(zstd_bytes.len()));
        assert_eq!(st_zstd.response_body_bytes, Some(plain_bytes.len()));
        assert!(st_zstd.response_wire_body_bytes.unwrap() < st_zstd.response_body_bytes.unwrap());
        assert_eq!(d_zstd.summary.wire_body_size, Some(zstd_bytes.len()));
        assert_eq!(d_zstd.response_body_text.as_deref(), Some(plain_json.as_str()));

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn captures_autoresponder_delay_and_breakpoint_pause_timings() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = upstream_listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let _ = sock
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                    .await;
                let _ = sock.shutdown().await;
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-bp-mock-timings-{}",
            std::process::id()
        ));
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let (bp_tx, mut bp_rx) = mpsc::unbounded_channel();
        let breakpoints = Arc::new(BreakpointEngine::new(Some(bp_tx)));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("bpmock.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        rules.upsert_rule(crate::models::AutoResponderRule {
            id: "mock-delayed".into(),
            enabled: true,
            name: "Delayed Mock".into(),
            match_target: crate::models::RuleMatchTarget::UrlContains,
            pattern: "/mock-delay".into(),
            method_filter: None,
            header_name: None,
            action: RuleActionType::MockResponse,
            status_code: 200,
            latency_ms: 40,
            response_headers: vec![HeaderPair::new("Content-Type", "application/json")],
            response_body: "{\"mock\":true}".into(),
        });

        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules: rules.clone(),
            filters,
            breakpoints: breakpoints.clone(),
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            loop {
                let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                    break;
                };
                let c = proxy_ctx.clone();
                let conn_ctx = ClientConnContext::new();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_ctx = c.clone();
                        let req_conn = conn_ctx.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, None, req_conn, inner_ctx)
                                    .await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();

        // 1. AutoResponder delayed mock
        let mock_resp = client
            .get(format!("http://127.0.0.1:{}/mock-delay", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(mock_resp.text().await.unwrap(), "{\"mock\":true}");

        tokio::time::sleep(Duration::from_millis(25)).await;
        let mock_detail = store.get(1).expect("mock session stored");
        assert!(mock_detail.summary.is_mocked);
        let mock_timings = mock_detail.timings.as_ref().expect("mock timings");
        assert!(
            mock_timings.autoresponder_delay_ms.unwrap_or(0.0) >= 20.0,
            "expected autoresponder_delay_ms >= 20, got {:?}",
            mock_timings.autoresponder_delay_ms
        );

        // 2. Live request breakpoint pause
        breakpoints.update_config(BreakpointConfig {
            break_before_request: true,
            break_after_response: false,
            timeout_secs: 60,
            rules: Vec::new(),
        });

        let bp_clone = breakpoints.clone();
        tokio::spawn(async move {
            if let Some(items) = bp_rx.recv().await {
                if let Some(first) = items.first() {
                    tokio::time::sleep(Duration::from_millis(45)).await;
                    bp_clone.resolve(BreakpointResolution {
                        breakpoint_id: first.breakpoint_id.clone(),
                        action: BreakpointAction::Continue,
                        method: None,
                        url: None,
                        request_headers: None,
                        request_body_base64: None,
                        request_body_text: None,
                        status_code: None,
                        response_headers: None,
                        response_body_base64: None,
                        response_body_text: None,
                    });
                }
            }
        });

        let bp_resp = client
            .get(format!("http://127.0.0.1:{}/pause-bp", upstream_addr.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(bp_resp.text().await.unwrap(), "ok");

        tokio::time::sleep(Duration::from_millis(25)).await;
        let bp_detail = store.get(2).expect("breakpoint session stored");
        let bp_timings = bp_detail.timings.as_ref().expect("bp timings");
        let pause_ms = bp_timings.breakpoint_pause_ms.unwrap_or(0.0);
        assert!(
            pause_ms >= 20.0,
            "expected breakpoint_pause_ms >= 20, got {:?}",
            pause_ms
        );
        assert!(
            bp_timings.net_elapsed_ms.unwrap_or(f64::MAX)
                < bp_timings.overall_elapsed_ms.unwrap_or(0.0),
            "net_elapsed_ms ({:?}) should exclude breakpoint pause from overall_elapsed_ms ({:?})",
            bp_timings.net_elapsed_ms,
            bp_timings.overall_elapsed_ms
        );

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn websocket_manual_frame_injection_to_server_and_client_and_channel_cleanup() {
        use tokio_tungstenite::tungstenite::Message;

        let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_addr = ws_listener.local_addr().unwrap();
        let (server_rx_tx, mut server_rx_rx) = mpsc::unbounded_channel::<Message>();

        tokio::spawn(async move {
            if let Ok((sock, _)) = ws_listener.accept().await {
                let ws_stream = tokio_tungstenite::accept_async(sock).await.unwrap();
                let (_sink, mut stream) = ws_stream.split();
                while let Some(Ok(msg)) = stream.next().await {
                    let is_close = matches!(msg, Message::Close(_));
                    let _ = server_rx_tx.send(msg);
                    if is_close {
                        break;
                    }
                }
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-ws-inject-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("ws-inject.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let c = proxy_ctx.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(
                                req,
                                client_addr,
                                None,
                                ClientConnContext::new(),
                                c,
                            )
                            .await,
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            }
        });

        let mut client_tcp = TcpStream::connect(proxy_addr).await.unwrap();
        let raw_upgrade = format!(
            "GET http://{ws_addr}/ws-inject HTTP/1.1\r\n\
             Host: {ws_addr}\r\n\
             Connection: Upgrade\r\n\
             Upgrade: websocket\r\n\
             Sec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        );
        client_tcp.write_all(raw_upgrade.as_bytes()).await.unwrap();

        let mut hs_buf = Vec::new();
        let mut b = [0u8; 1];
        while !hs_buf.ends_with(b"\r\n\r\n") {
            client_tcp.read_exact(&mut b).await.unwrap();
            hs_buf.push(b[0]);
        }
        assert!(String::from_utf8_lossy(&hs_buf).starts_with("HTTP/1.1 101"));

        let mut client_ws = WebSocketStream::from_raw_socket(client_tcp, Role::Client, None).await;
        tokio::time::sleep(Duration::from_millis(25)).await;

        assert!(ctx.active_ws_channels.contains_key(&1));
        assert_eq!(store.get(1).unwrap().summary.ws_open, Some(true));

        // 1. Inject Text frame toward Server
        let srv_rec = ctx
            .inject_websocket_frame(
                1,
                WsInjectDirection::Server,
                WsInjectOpcode::Text,
                r#"{"cmd":"ping"}"#.into(),
            )
            .await
            .expect("inject text frame to server");
        assert!(srv_rec.injected);
        assert_eq!(srv_rec.direction, "outbound");
        assert_eq!(srv_rec.opcode, "text");
        assert_eq!(srv_rec.payload_preview, r#"{"cmd":"ping"}"#);

        let server_got = tokio::time::timeout(Duration::from_secs(3), server_rx_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(server_got.into_text().unwrap().as_str(), r#"{"cmd":"ping"}"#);

        // 2. Inject Binary Hex frame toward Client
        let cli_rec = ctx
            .inject_websocket_frame(
                1,
                WsInjectDirection::Client,
                WsInjectOpcode::Binary,
                "de ad be ef".into(),
            )
            .await
            .expect("inject binary frame to client");
        assert!(cli_rec.injected);
        assert_eq!(cli_rec.direction, "inbound");
        assert_eq!(cli_rec.opcode, "binary");
        assert_eq!(cli_rec.byte_length, 4);

        let client_got = tokio::time::timeout(Duration::from_secs(3), client_ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(client_got.into_data().as_ref(), &[0xde, 0xad, 0xbe, 0xef]);

        // 3. Close connection and verify active_ws_channels cleanup + ws_open == false
        let _ = client_ws.close(None).await;
        drop(client_ws);

        let mut cleaned = false;
        for _ in 0..40 {
            let ch_gone = !ctx.active_ws_channels.contains_key(&1);
            let marked_closed = store
                .get(1)
                .and_then(|d| d.summary.ws_open)
                == Some(false);
            if ch_gone && marked_closed {
                cleaned = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(cleaned, "active_ws_channels entry must be removed and ws_open marked false on close");
        assert!(ctx.active_ws_channels.is_empty());

        let detail = store.get(1).unwrap();
        assert_eq!(detail.summary.ws_open, Some(false));
        let injected_frames: Vec<_> = detail
            .websocket_frames
            .iter()
            .filter(|f| f.injected)
            .collect();
        assert_eq!(injected_frames.len(), 2);
        assert!(detail
            .websocket_frames
            .iter()
            .filter(|f| !f.injected)
            .all(|f| f.opcode == "close"));

        let post_close_err = ctx
            .inject_websocket_frame(
                1,
                WsInjectDirection::Server,
                WsInjectOpcode::Text,
                "after-close".into(),
            )
            .await;
        assert!(post_close_err.is_err());

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn upstream_proxy_chaining_routes_http_connect_ws_and_respects_bypass_list() {
        use crate::models::UpstreamProxyProtocol;
        use std::sync::atomic::AtomicUsize;
        use tokio_tungstenite::tungstenite::Message;

        // 1. Target HTTP + WS server (handles GET /hello and WS /ws)
        let target_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_addr = target_listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = target_listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut req_buf = Vec::new();
                    let mut b = [0u8; 1];
                    while !req_buf.ends_with(b"\r\n\r\n") {
                        if sock.read_exact(&mut b).await.is_err() {
                            return;
                        }
                        req_buf.push(b[0]);
                    }
                    let req_text = String::from_utf8_lossy(&req_buf);
                    if let Some(key_line) = req_text
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("sec-websocket-key:"))
                    {
                        let key = key_line.split(':').nth(1).unwrap_or("").trim();
                        let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(
                            key.as_bytes(),
                        );
                        let resp = format!(
                            "HTTP/1.1 101 Switching Protocols\r\n\
                             Upgrade: websocket\r\n\
                             Connection: Upgrade\r\n\
                             Sec-WebSocket-Accept: {accept}\r\n\r\n"
                        );
                        sock.write_all(resp.as_bytes()).await.unwrap();
                        let mut ws =
                            WebSocketStream::from_raw_socket(sock, Role::Server, None).await;
                        if let Some(Ok(Message::Text(txt))) = ws.next().await {
                            let _ = ws.send(Message::Text(format!("echo:{txt}").into())).await;
                        }
                        let _ = ws.close(None).await;
                    } else {
                        let body = "target-http-ok";
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = sock.write_all(resp.as_bytes()).await;
                    }
                });
            }
        });

        // 2. Bypassed HTTP server (must be hit directly without upstream proxy)
        let bypassed_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let bypassed_addr = bypassed_listener.local_addr().unwrap();
        let bypassed_hits = Arc::new(AtomicUsize::new(0));
        let bypassed_hits_srv = Arc::clone(&bypassed_hits);
        tokio::spawn(async move {
            while let Ok((sock, _)) = bypassed_listener.accept().await {
                let hits = Arc::clone(&bypassed_hits_srv);
                tokio::spawn(async move {
                    let io = TokioIo::new(sock);
                    let svc = service_fn(move |_req: Request<Incoming>| {
                        hits.fetch_add(1, Ordering::SeqCst);
                        async {
                            Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(
                                b"bypass-direct-ok",
                            ))))
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        // 3. Raw TCP echo server for CONNECT Passthrough through upstream proxy
        let raw_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let raw_addr = raw_listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = raw_listener.accept().await {
                let mut buf = [0u8; 64];
                if let Ok(n) = sock.read(&mut buf).await {
                    let _ = sock.write_all(&buf[..n]).await;
                }
            }
        });

        // 4. Mock Upstream HTTP Proxy requiring `Proxy-Authorization: Basic user:secret`
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        let upstream_http_hits = Arc::new(AtomicUsize::new(0));
        let upstream_connect_hits = Arc::new(AtomicUsize::new(0));
        let expected_auth = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("user:secret")
        );

        let up_http_cnt = Arc::clone(&upstream_http_hits);
        let up_conn_cnt = Arc::clone(&upstream_connect_hits);
        tokio::spawn(async move {
            while let Ok((sock, _)) = upstream_listener.accept().await {
                let http_cnt = Arc::clone(&up_http_cnt);
                let conn_cnt = Arc::clone(&up_conn_cnt);
                let exp_auth = expected_auth.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(sock);
                    let svc = service_fn(move |req: Request<Incoming>| {
                        let http_cnt = Arc::clone(&http_cnt);
                        let conn_cnt = Arc::clone(&conn_cnt);
                        let exp_auth = exp_auth.clone();
                        async move {
                            let auth_ok = req
                                .headers()
                                .get("proxy-authorization")
                                .and_then(|v| v.to_str().ok())
                                == Some(exp_auth.as_str());
                            if !auth_ok {
                                return Ok::<_, Infallible>(
                                    Response::builder()
                                        .status(StatusCode::PROXY_AUTHENTICATION_REQUIRED)
                                        .body(boxed_full(Bytes::from_static(b"407 Auth Required")))
                                        .unwrap(),
                                );
                            }

                            if req.method() == http::Method::CONNECT {
                                conn_cnt.fetch_add(1, Ordering::SeqCst);
                                let authority = req.uri().authority().unwrap().to_string();
                                let mut target_tcp = TcpStream::connect(&authority).await.unwrap();
                                tokio::spawn(async move {
                                    if let Ok(upgraded) = hyper::upgrade::on(req).await {
                                        let mut client_io = TokioIo::new(upgraded);
                                        let _ = tokio::io::copy_bidirectional(
                                            &mut client_io,
                                            &mut target_tcp,
                                        )
                                        .await;
                                    }
                                });
                                return Ok(Response::builder()
                                    .status(StatusCode::OK)
                                    .body(boxed_full(Bytes::new()))
                                    .unwrap());
                            }

                            http_cnt.fetch_add(1, Ordering::SeqCst);
                            let authority = req
                                .uri()
                                .authority()
                                .map(|a| a.to_string())
                                .unwrap_or_else(|| {
                                    req.headers()
                                        .get(http::header::HOST)
                                        .and_then(|v| v.to_str().ok())
                                        .unwrap_or("")
                                        .to_string()
                                });
                            let path = req
                                .uri()
                                .path_and_query()
                                .map(|p| p.as_str())
                                .unwrap_or("/");
                            let mut target_tcp = TcpStream::connect(&authority).await.unwrap();
                            let raw_req = format!(
                                "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                                req.method(),
                                path,
                                authority
                            );
                            target_tcp.write_all(raw_req.as_bytes()).await.unwrap();
                            let mut raw_resp = Vec::new();
                            let _ = target_tcp.read_to_end(&mut raw_resp).await;
                            let body_bytes = raw_resp
                                .windows(4)
                                .position(|w| w == b"\r\n\r\n")
                                .map(|pos| raw_resp[pos + 4..].to_vec())
                                .unwrap_or_default();
                            Ok(Response::builder()
                                .status(StatusCode::OK)
                                .body(boxed_full(Bytes::from(body_bytes)))
                                .unwrap())
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, svc)
                        .await;
                });
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-upstream-chain-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        filters.update_config(ProxyFilterBackendConfig {
            tls_intercept_mode: TlsInterceptMode::InterceptAll,
            tls_bypass_enabled: true,
            tls_bypass_rules: vec![TlsBypassRule {
                id: "bypass-raw-connect".into(),
                enabled: true,
                pattern: "127.0.0.1".into(),
                category: "Test".into(),
                description: "Test passthrough CONNECT".into(),
            }],
            ..crate::proxy::filters::default_backend_config()
        });
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("upstream-chain.sqlite")).unwrap());
        let upstream_proxy = Arc::new(UpstreamProxyManager::new());
        upstream_proxy
            .set_config(UpstreamProxyConfig {
                enabled: true,
                protocol: UpstreamProxyProtocol::Http,
                host: "127.0.0.1".into(),
                port: upstream_addr.port(),
                username: Some("user".into()),
                password: Some("secret".into()),
                has_password: true,
                bypass_list: vec![format!("127.0.0.1:{}", bypassed_addr.port())],
            })
            .unwrap();

        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy,
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });
        ctx.rebuild_upstream_clients();

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            while let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(
                                    req,
                                    client_addr,
                                    None,
                                    ClientConnContext::new(),
                                    inner_c,
                                )
                                .await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();

        // A. Non-bypassed HTTP request -> routed through upstream HTTP proxy
        let resp_http = client
            .get(format!("http://{target_addr}/hello"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp_http.status(), StatusCode::OK);
        assert_eq!(resp_http.text().await.unwrap(), "target-http-ok");
        assert_eq!(upstream_http_hits.load(Ordering::SeqCst), 1);

        // B. Bypassed HTTP request -> goes directly to bypassed_addr
        let resp_bypass = client
            .get(format!("http://{bypassed_addr}/bypass"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp_bypass.status(), StatusCode::OK);
        assert_eq!(resp_bypass.text().await.unwrap(), "bypass-direct-ok");
        assert_eq!(upstream_http_hits.load(Ordering::SeqCst), 1);
        assert_eq!(bypassed_hits.load(Ordering::SeqCst), 1);

        // C. CONNECT Passthrough tunnel -> routed via upstream proxy CONNECT
        let mut connect_tcp = TcpStream::connect(proxy_addr).await.unwrap();
        let connect_req = format!("CONNECT {raw_addr} HTTP/1.1\r\nHost: {raw_addr}\r\n\r\n");
        connect_tcp.write_all(connect_req.as_bytes()).await.unwrap();
        let mut connect_resp = Vec::new();
        let mut b = [0u8; 1];
        while !connect_resp.ends_with(b"\r\n\r\n") {
            connect_tcp.read_exact(&mut b).await.unwrap();
            connect_resp.push(b[0]);
        }
        assert!(String::from_utf8_lossy(&connect_resp).starts_with("HTTP/1.1 200"));
        connect_tcp.write_all(b"TUNNEL_OK").await.unwrap();
        let mut echo = [0u8; 9];
        connect_tcp.read_exact(&mut echo).await.unwrap();
        assert_eq!(&echo, b"TUNNEL_OK");
        assert_eq!(upstream_connect_hits.load(Ordering::SeqCst), 1);

        // D. WebSocket ws:// -> routed via upstream proxy CONNECT
        let mut ws_tcp = TcpStream::connect(proxy_addr).await.unwrap();
        let ws_upgrade = format!(
            "GET http://{target_addr}/ws HTTP/1.1\r\n\
             Host: {target_addr}\r\n\
             Connection: Upgrade\r\n\
             Upgrade: websocket\r\n\
             Sec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        );
        ws_tcp.write_all(ws_upgrade.as_bytes()).await.unwrap();
        let mut ws_hs = Vec::new();
        while !ws_hs.ends_with(b"\r\n\r\n") {
            ws_tcp.read_exact(&mut b).await.unwrap();
            ws_hs.push(b[0]);
        }
        assert!(String::from_utf8_lossy(&ws_hs).starts_with("HTTP/1.1 101"));
        assert_eq!(upstream_connect_hits.load(Ordering::SeqCst), 2);

        let mut ws_client = WebSocketStream::from_raw_socket(ws_tcp, Role::Client, None).await;
        ws_client
            .send(Message::Text("ws-via-proxy".into()))
            .await
            .unwrap();
        let ws_reply = ws_client.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(ws_reply.as_str(), "echo:ws-via-proxy");
        let _ = ws_client.close(None).await;

        tokio::time::sleep(Duration::from_millis(60)).await;
        let expected_via_ip = format!("via {upstream_addr}");
        let expected_via_proxy = format!("HTTP {upstream_addr}");
        let summaries = store.list_summaries();
        assert_eq!(summaries.len(), 4);

        let http_proxied = summaries
            .iter()
            .find(|s| s.path == "/hello")
            .expect("proxied HTTP summary");
        assert_eq!(
            http_proxied.server_ip.as_deref(),
            Some(expected_via_ip.as_str())
        );
        assert_eq!(
            store
                .get(http_proxied.id)
                .unwrap()
                .transfer_stats
                .as_ref()
                .and_then(|st| st.via_proxy_addr.as_deref()),
            Some(expected_via_proxy.as_str())
        );

        let http_bypassed = summaries
            .iter()
            .find(|s| s.path == "/bypass")
            .expect("bypassed HTTP summary");
        assert_eq!(http_bypassed.server_ip.as_deref(), Some("127.0.0.1"));
        assert_eq!(
            store
                .get(http_bypassed.id)
                .unwrap()
                .transfer_stats
                .as_ref()
                .and_then(|st| st.via_proxy_addr.as_deref()),
            None
        );

        let connect_proxied = summaries
            .iter()
            .find(|s| s.method == "CONNECT")
            .expect("proxied CONNECT summary");
        assert_eq!(
            connect_proxied.server_ip.as_deref(),
            Some(expected_via_ip.as_str())
        );
        assert_eq!(
            store
                .get(connect_proxied.id)
                .unwrap()
                .transfer_stats
                .as_ref()
                .and_then(|st| st.via_proxy_addr.as_deref()),
            Some(expected_via_proxy.as_str())
        );

        let ws_proxied = summaries
            .iter()
            .find(|s| s.path == "/ws")
            .expect("proxied WS summary");
        assert_eq!(
            ws_proxied.server_ip.as_deref(),
            Some(expected_via_ip.as_str())
        );
        assert_eq!(
            store
                .get(ws_proxied.id)
                .unwrap()
                .transfer_stats
                .as_ref()
                .and_then(|st| st.via_proxy_addr.as_deref()),
            Some(expected_via_proxy.as_str())
        );

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn push_or_replace_summary_coalesces_duplicate_session_ids_in_place() {
        let make_sum = |id: u64, status: u16, body_size: usize| SessionSummary {
            id,
            status,
            protocol: "HTTP/1.1".into(),
            scheme: "http".into(),
            method: "GET".into(),
            host: "example.test".into(),
            path: format!("/s/{id}"),
            url: format!("http://example.test/s/{id}"),
            content_type: "text/plain".into(),
            body_size,
            duration_ms: 1,
            timestamp: "2026-11-23T00:00:00Z".into(),
            is_mocked: false,
            matched_rule_id: None,
            error: None,
            process_name: None,
            process_pid: None,
            tls_bypassed: false,
            headers_mutated: false,
            breakpoint_paused: None,
            breakpoint_modified: false,
            comment: None,
            marked_color: None,
            client_ip: None,
            remapped_to: None,
            ttfb_ms: None,
            dns_ms: None,
            connect_ms: None,
            tls_ms: None,
            receive_ms: None,
            request_size: None,
            wire_body_size: None,
            server_ip: None,
            server_conn_reused: None,
            ws_open: None,
        };

        let mut buf = Vec::new();
        push_or_replace_summary(&mut buf, make_sum(1, 0, 0));
        push_or_replace_summary(&mut buf, make_sum(2, 200, 10));
        push_or_replace_summary(&mut buf, make_sum(1, 200, 50));
        push_or_replace_summary(&mut buf, make_sum(1, 200, 120));

        assert_eq!(buf.len(), 2);
        assert_eq!(buf[0].id, 1);
        assert_eq!(buf[0].status, 200);
        assert_eq!(buf[0].body_size, 120);
        assert_eq!(buf[1].id, 2);
    }

    #[tokio::test]
    async fn direct_websocket_with_hosts_remap_and_interleaved_injection_preserves_frames() {
        use tokio_tungstenite::tungstenite::Message;

        // 1. Local WS server capturing incoming Host header and controlling inbound server frames
        let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_addr = ws_listener.local_addr().unwrap();
        let (server_send_tx, mut server_send_rx) = mpsc::unbounded_channel::<String>();
        let (server_got_tx, mut server_got_rx) = mpsc::unbounded_channel::<String>();
        let (ws_host_tx, ws_host_rx) = oneshot::channel::<Option<String>>();

        tokio::spawn(async move {
            if let Ok((mut sock, _)) = ws_listener.accept().await {
                let mut req_buf = Vec::new();
                let mut b = [0u8; 1];
                while !req_buf.ends_with(b"\r\n\r\n") {
                    if sock.read_exact(&mut b).await.is_err() {
                        return;
                    }
                    req_buf.push(b[0]);
                }
                let req_str = String::from_utf8_lossy(&req_buf);
                let host_hdr = req_str
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("host:"))
                    .map(|l| l.split_once(':').map(|x| x.1.trim().to_string()).unwrap_or_default());
                let _ = ws_host_tx.send(host_hdr);

                let key = req_str
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("sec-websocket-key:"))
                    .and_then(|l| l.split_once(':').map(|x| x.1.trim().to_string()))
                    .unwrap_or_default();
                let accept =
                    tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
                let resp = format!(
                    "HTTP/1.1 101 Switching Protocols\r\n\
                     Upgrade: websocket\r\n\
                     Connection: Upgrade\r\n\
                     Sec-WebSocket-Accept: {accept}\r\n\r\n"
                );
                sock.write_all(resp.as_bytes()).await.unwrap();
                let ws_stream = WebSocketStream::from_raw_socket(sock, Role::Server, None).await;
                let (mut sink, mut stream) = ws_stream.split();

                tokio::spawn(async move {
                    while let Some(msg) = server_send_rx.recv().await {
                        if sink.send(Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                });

                while let Some(Ok(msg)) = stream.next().await {
                    match msg {
                        Message::Text(t) => {
                            let _ = server_got_tx.send(t.to_string());
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            }
        });

        // 2. Local TLS listener capturing SNI from direct wss:// connection via HostRemapRegistry
        let wss_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let wss_addr = wss_listener.local_addr().unwrap();
        let (wss_sni_tx, wss_sni_rx) = oneshot::channel::<Option<String>>();
        tokio::spawn(async move {
            if let Ok((stream, _)) = wss_listener.accept().await {
                let acceptor = tokio_rustls::LazyConfigAcceptor::new(
                    rustls::server::Acceptor::default(),
                    stream,
                );
                tokio::pin!(acceptor);
                let sni = match acceptor.as_mut().await {
                    Ok(start) => start.client_hello().server_name().map(str::to_owned),
                    Err(_) => None,
                };
                let _ = wss_sni_tx.send(sni);
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-ws-remap-inject-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let host_remap = Arc::new(HostRemapRegistry::new());
        host_remap
            .set_rules(vec![
                crate::models::HostRemapRule {
                    id: "ws-remap".into(),
                    enabled: true,
                    source_pattern: "api.virtual-ws.invalid".into(),
                    target_host: "127.0.0.1".into(),
                    target_port: Some(ws_addr.port()),
                    preserve_host_header: true,
                    comment: "WS remap".into(),
                },
                crate::models::HostRemapRule {
                    id: "wss-remap".into(),
                    enabled: true,
                    source_pattern: "wss-remap.virtual.invalid".into(),
                    target_host: "127.0.0.1".into(),
                    target_port: Some(wss_addr.port()),
                    preserve_host_header: true,
                    comment: "WSS SNI remap".into(),
                },
            ])
            .unwrap();
        let store = Arc::new(TrafficStore::new(tmp_dir.join("ws-remap.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        let ctx = Arc::new(SharedProxyContext {
            ca: ca.clone(),
            rules,
            filters,
            breakpoints,
            host_remap: Arc::clone(&host_remap),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(Some(Arc::clone(&host_remap))),
            remote_upstream_http_client: test_remote_upstream_http_client(Some(host_remap)),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(3)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            while let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(
                                    req,
                                    client_addr,
                                    None,
                                    ClientConnContext::new(),
                                    inner_c,
                                )
                                .await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        // A. Direct ws:// to non-existent virtual domain remapped to local server
        let mut client_tcp = TcpStream::connect(proxy_addr).await.unwrap();
        let raw_upgrade = "GET http://api.virtual-ws.invalid/live HTTP/1.1\r\n\
             Host: api.virtual-ws.invalid\r\n\
             Connection: Upgrade\r\n\
             Upgrade: websocket\r\n\
             Sec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
        client_tcp.write_all(raw_upgrade.as_bytes()).await.unwrap();
        let mut hs_buf = Vec::new();
        let mut b = [0u8; 1];
        while !hs_buf.ends_with(b"\r\n\r\n") {
            client_tcp.read_exact(&mut b).await.unwrap();
            hs_buf.push(b[0]);
        }
        assert!(String::from_utf8_lossy(&hs_buf).starts_with("HTTP/1.1 101"));
        assert_eq!(
            ws_host_rx.await.unwrap().as_deref(),
            Some("api.virtual-ws.invalid")
        );

        let mut client_ws = WebSocketStream::from_raw_socket(client_tcp, Role::Client, None).await;
        tokio::time::sleep(Duration::from_millis(25)).await;

        // 1) Normal inbound frame before injection
        server_send_tx.send("srv-before".into()).unwrap();
        let f1 = tokio::time::timeout(Duration::from_secs(2), client_ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(f1.into_text().unwrap().as_str(), "srv-before");

        // 2) Manual injected outbound frame + manual injected inbound frame
        let inj_srv = ctx
            .inject_websocket_frame(
                1,
                WsInjectDirection::Server,
                WsInjectOpcode::Text,
                "injected-to-srv".into(),
            )
            .await
            .unwrap();
        assert!(inj_srv.injected);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), server_got_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            "injected-to-srv"
        );

        let inj_cli = ctx
            .inject_websocket_frame(
                1,
                WsInjectDirection::Client,
                WsInjectOpcode::Text,
                "injected-to-cli".into(),
            )
            .await
            .unwrap();
        assert!(inj_cli.injected);
        let f_inj = tokio::time::timeout(Duration::from_secs(2), client_ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(f_inj.into_text().unwrap().as_str(), "injected-to-cli");

        // 3) New normal inbound frames AFTER injection must NOT overwrite injected frames!
        server_send_tx.send("srv-after-1".into()).unwrap();
        server_send_tx.send("srv-after-2".into()).unwrap();
        let f_after1 = tokio::time::timeout(Duration::from_secs(2), client_ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let f_after2 = tokio::time::timeout(Duration::from_secs(2), client_ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(f_after1.into_text().unwrap().as_str(), "srv-after-1");
        assert_eq!(f_after2.into_text().unwrap().as_str(), "srv-after-2");

        let _ = client_ws.close(None).await;
        drop(client_ws);
        tokio::time::sleep(Duration::from_millis(60)).await;

        let ws_detail = store.get(1).expect("remapped WS session stored");
        assert_eq!(
            ws_detail.summary.remapped_to.as_deref(),
            Some(format!("127.0.0.1:{}", ws_addr.port()).as_str())
        );
        assert_eq!(ws_detail.summary.server_ip.as_deref(), Some("127.0.0.1"));
        let payloads: Vec<&str> = ws_detail
            .websocket_frames
            .iter()
            .map(|f| f.payload_preview.as_str())
            .collect();
        assert!(payloads.contains(&"srv-before"));
        assert!(payloads.contains(&"injected-to-srv"));
        assert!(payloads.contains(&"injected-to-cli"));
        assert!(payloads.contains(&"srv-after-1"));
        assert!(payloads.contains(&"srv-after-2"));
        for (pos, rec) in ws_detail.websocket_frames.iter().enumerate() {
            assert_eq!(rec.index, pos + 1, "frame indices must be strictly 1..=N");
        }

        // B. Direct wss:// via HostRemapRegistry preserves original TLS SNI
        let mut wss_tcp = TcpStream::connect(proxy_addr).await.unwrap();
        wss_tcp
            .write_all(
                b"CONNECT wss-remap.virtual.invalid:443 HTTP/1.1\r\nHost: wss-remap.virtual.invalid:443\r\n\r\n",
            )
            .await
            .unwrap();
        let mut conn_buf = [0u8; 256];
        let n = wss_tcp.read(&mut conn_buf).await.unwrap();
        assert!(String::from_utf8_lossy(&conn_buf[..n]).starts_with("HTTP/1.1 200"));

        let mut root_store = rustls::RootCertStore::empty();
        root_store
            .add(rustls::pki_types::CertificateDer::from(
                ca.root_ca_der().to_vec(),
            ))
            .unwrap();
        let mut tls_cfg = rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();
        tls_cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_cfg));
        let server_name =
            rustls::pki_types::ServerName::try_from("wss-remap.virtual.invalid").unwrap();
        let mut mitm_tls = connector.connect(server_name, wss_tcp).await.unwrap();
        mitm_tls
            .write_all(
                b"GET /sni-ws HTTP/1.1\r\n\
                  Host: wss-remap.virtual.invalid\r\n\
                  Connection: Upgrade\r\n\
                  Upgrade: websocket\r\n\
                  Sec-WebSocket-Version: 13\r\n\
                  Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            )
            .await
            .unwrap();
        let mut _drain = [0u8; 256];
        let _ = tokio::time::timeout(Duration::from_secs(2), mitm_tls.read(&mut _drain)).await;

        let captured_sni = tokio::time::timeout(Duration::from_secs(2), wss_sni_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(captured_sni.as_deref(), Some("wss-remap.virtual.invalid"));

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn execute_composed_runs_override_status_hop_by_hop_filter_and_python_hooks() {
        use crate::models::{AutoResponderRule, RuleMatchTarget};

        type ObservedHeaders = Arc<std::sync::Mutex<Vec<(Option<String>, bool)>>>;
        let received_headers: ObservedHeaders = Arc::new(std::sync::Mutex::new(Vec::new()));
        let rec_srv = Arc::clone(&received_headers);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let rec = Arc::clone(&rec_srv);
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req: Request<Incoming>| {
                        let rec = Arc::clone(&rec);
                        async move {
                            let py_hdr = req
                                .headers()
                                .get("x-from-composer-py")
                                .and_then(|v| v.to_str().ok())
                                .map(str::to_owned);
                            let has_hop_by_hop = req.headers().contains_key("keep-alive")
                                || req.headers().contains_key("proxy-connection");
                            rec.lock().unwrap().push((py_hdr, has_hop_by_hop));
                            Ok::<_, Infallible>(
                                Response::builder()
                                    .status(StatusCode::OK)
                                    .header(CONTENT_TYPE, "application/json")
                                    .body(Full::new(Bytes::from_static(br#"{"upstream":true}"#)))
                                    .unwrap(),
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-composer-parity-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        rules.set_rules(vec![AutoResponderRule {
            id: "override-201".into(),
            enabled: true,
            name: "Override Status 201".into(),
            match_target: RuleMatchTarget::UrlContains,
            pattern: "/composer-parity".into(),
            method_filter: None,
            header_name: None,
            action: RuleActionType::OverrideStatus,
            status_code: 201,
            latency_ms: 0,
            response_headers: Vec::new(),
            response_body: String::new(),
        }]);
        let filters = Arc::new(ProxyFilterEngine::new());
        let store = Arc::new(TrafficStore::new(tmp_dir.join("composer-parity.sqlite")).unwrap());
        let sysproxy = Arc::new(SystemProxyManager::with_backend(
            &tmp_dir,
            RecordingOsProxyBackend::new(),
        ));
        let controller =
            ProxyEngineController::new_for_test(ca, rules, filters, store, sysproxy).unwrap();

        let py_available = controller
            .context
            .script_runner
            .get_status()
            .await
            .available;
        if py_available {
            let py_code = r#"
import json

def on_request(request):
    request["headers"]["X-From-Composer-Py"] = "hmac-ok"

def on_response(response, request):
    response["headers"]["X-Py-Resp"] = "hooked"
    data = json.loads(response["body"])
    data["py_hooked"] = True
    response["body"] = json.dumps(data)
"#;
            controller
                .context
                .script_runner
                .set_script(py_code.to_string(), true)
                .await
                .unwrap();
        }

        // 1. Default run (skip_python_scripts = None -> Python runs when available + OverrideStatus + hop-by-hop stripped)
        let detail1 = controller
            .execute_composed(ComposedRequest {
                method: "GET".into(),
                url: format!("http://{addr}/composer-parity"),
                headers: vec![
                    HeaderPair::new("Keep-Alive", "timeout=5"),
                    HeaderPair::new("Proxy-Connection", "keep-alive"),
                    HeaderPair::new("X-Custom", "1"),
                ],
                body: String::new(),
                body_base64: None,
                follow_redirects: false,
                skip_python_scripts: None,
                request_id: None,
                timeout_sec: None,
            })
            .await
            .unwrap();

        assert_eq!(detail1.summary.status, 201);
        assert!(detail1.summary.is_mocked);
        assert_eq!(
            detail1.summary.matched_rule_id.as_deref(),
            Some("override-201")
        );

        // 2. Explicit skip_python_scripts = Some(true) bypasses hooks while keeping OverrideStatus & hop-by-hop filter
        let detail2 = controller
            .execute_composed(ComposedRequest {
                method: "GET".into(),
                url: format!("http://{addr}/composer-parity"),
                headers: vec![HeaderPair::new("Proxy-Connection", "keep-alive")],
                body: String::new(),
                body_base64: None,
                follow_redirects: false,
                skip_python_scripts: Some(true),
                request_id: None,
                timeout_sec: None,
            })
            .await
            .unwrap();

        assert_eq!(detail2.summary.status, 201);
        assert!(detail2.summary.is_mocked);

        let recorded = received_headers.lock().unwrap();
        assert_eq!(recorded.len(), 2);
        assert!(!recorded[0].1, "hop-by-hop headers must be stripped");
        assert!(!recorded[1].1, "hop-by-hop headers must be stripped");

        if py_available {
            assert_eq!(recorded[0].0.as_deref(), Some("hmac-ok"));
            assert_eq!(recorded[1].0, None);
            assert!(detail1
                .response_headers
                .iter()
                .any(|h| h.name.eq_ignore_ascii_case("x-py-resp") && h.value == "hooked"));
            assert!(detail1
                .response_body_text
                .as_deref()
                .unwrap_or("")
                .contains("\"py_hooked\": true"));
            assert!(detail1.timings.as_ref().and_then(|t| t.script_hook_ms).is_some());
            assert!(!detail2
                .response_headers
                .iter()
                .any(|h| h.name.eq_ignore_ascii_case("x-py-resp")));
            controller.context.script_runner.shutdown_sync();
        }

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn collect_response_body_limited_and_http_handler_enforce_64mib_cap() {
        use crate::models::{ThrottleConfig, ThrottlePreset};
        use super::http_handler::{collect_response_body_limited, ResponseBodyReadError};

        // 1. Unit check on collect_response_body_limited (both unthrottled and throttled paths)
        let make_chunks = || {
            vec![
                Ok::<_, Infallible>(Frame::data(Bytes::from(vec![b'A'; 600]))),
                Ok(Frame::data(Bytes::from(vec![b'B'; 600]))),
            ]
        };
        let throttle = ThrottleEngine::new();
        let body_unthrottled = StreamBody::new(futures_util::stream::iter(make_chunks()));
        let err1 = collect_response_body_limited(body_unthrottled, &throttle, 1024)
            .await
            .unwrap_err();
        assert!(matches!(
            err1,
            ResponseBodyReadError::PayloadTooLarge { limit: 1024, .. }
        ));

        throttle.set_config(ThrottleConfig {
            preset: ThrottlePreset::Custom,
            download_kbps: 1_000_000,
            upload_kbps: 1_000_000,
            latency_ms: 0,
        });
        let body_throttled = StreamBody::new(futures_util::stream::iter(make_chunks()));
        let err2 = collect_response_body_limited(body_throttled, &throttle, 1024)
            .await
            .unwrap_err();
        assert!(matches!(
            err2,
            ResponseBodyReadError::PayloadTooLarge { limit: 1024, .. }
        ));

        // 2. Full proxy HTTP chunked response exceeding MAX_BUFFERED_RESPONSE_BODY_BYTES (64 MiB) returns 502 cleanly
        static CHUNK_64K: [u8; 64 * 1024] = [b'Z'; 64 * 1024];
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((stream, _)) = upstream_listener.accept().await {
                let io = TokioIo::new(stream);
                let svc = service_fn(|_req: Request<Incoming>| async move {
                    let s = futures_util::stream::iter((0..1026).map(|_| {
                        Ok::<_, Infallible>(Frame::data(Bytes::from_static(&CHUNK_64K)))
                    }));
                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(CONTENT_TYPE, "application/json")
                            .body(StreamBody::new(s))
                            .unwrap(),
                    )
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection(io, svc)
                    .await;
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-oom-cap-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        // Stage 44 BUG-05 spills unhooked chunked responses >2 MiB to streaming; attach an
        // OverrideStatus rule so this test exercises the 64 MiB buffered OOM cap path.
        rules.set_rules(vec![crate::models::AutoResponderRule {
            id: "oom-cap-buffered".into(),
            enabled: true,
            name: "Require Buffered Mode for 64 MiB Cap".into(),
            match_target: crate::models::RuleMatchTarget::UrlContains,
            pattern: "/huge-chunked".into(),
            method_filter: None,
            header_name: None,
            action: RuleActionType::OverrideStatus,
            status_code: 201,
            latency_ms: 0,
            response_headers: Vec::new(),
            response_body: String::new(),
        }]);
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("oom-cap.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();
        tokio::spawn(async move {
            if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_c = proxy_ctx.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(
                                req,
                                client_addr,
                                None,
                                ClientConnContext::new(),
                                inner_c,
                            )
                            .await,
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();
        let resp = client
            .get(format!("http://{upstream_addr}/huge-chunked"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
        let err_body = resp.text().await.unwrap();
        assert!(err_body.contains("exceeds maximum buffered limit"));

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn ip_source_hosts_remap_preserves_host_and_remapped_target_telemetry() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = upstream_listener.accept().await {
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(|req: Request<Incoming>| async move {
                        let host = req
                            .headers()
                            .get(http::header::HOST)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from(format!(
                            "host={host};path={}",
                            req.uri().path()
                        )))))
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-ip-remap-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let host_remap = Arc::new(HostRemapRegistry::new());
        host_remap
            .set_rules(vec![crate::models::HostRemapRule {
                id: "ip-remap".into(),
                enabled: true,
                source_pattern: "198.51.100.42".into(),
                target_host: "127.0.0.1".into(),
                target_port: Some(upstream_addr.port()),
                preserve_host_header: true,
                comment: "IP source remap".into(),
            }])
            .unwrap();
        let store = Arc::new(TrafficStore::new(tmp_dir.join("ip-remap.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::clone(&host_remap),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(Some(Arc::clone(&host_remap))),
            remote_upstream_http_client: test_remote_upstream_http_client(Some(host_remap)),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();
        tokio::spawn(async move {
            if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_c = proxy_ctx.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(
                                req,
                                client_addr,
                                None,
                                ClientConnContext::new(),
                                inner_c,
                            )
                            .await,
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();
        let resp = client
            .get("http://198.51.100.42:8080/ip-remap")
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.text().await.unwrap(),
            "host=198.51.100.42:8080;path=/ip-remap"
        );

        let detail = store.get(1).expect("IP remap session recorded");
        assert_eq!(
            detail.transfer_stats.as_ref().and_then(|s| s.remapped_target.as_deref()),
            Some(format!("127.0.0.1:{}", upstream_addr.port()).as_str())
        );

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn stage39_slow_upstream_500_transparent_at_unlimited_and_504_at_finite_ttfb() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();

        tokio::spawn(async move {
            while let Ok((stream, _)) = upstream_listener.accept().await {
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(|req: Request<Incoming>| async move {
                        let delay_ms = if req.uri().path().contains("very-slow") {
                            1500
                        } else {
                            350
                        };
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        let resp = Response::builder()
                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                            .body(Full::new(Bytes::from("backend-real-500")))
                            .unwrap();
                        Ok::<_, Infallible>(resp)
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-stage39-ttfb-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("ttfb.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(5)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(120)),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();
        tokio::spawn(async move {
            while let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(
                                    req,
                                    client_addr,
                                    None,
                                    ClientConnContext::new(),
                                    inner_c,
                                )
                                .await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
            .build()
            .unwrap();

        // 1. Unlimited TTFB (0) waits and forwards authentic backend 500
        let ok_slow = client
            .get(format!("http://{upstream_addr}/slow-500"))
            .send()
            .await
            .unwrap();
        assert_eq!(ok_slow.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(ok_slow.headers().get("x-fluxproxy-error").is_none());
        assert_eq!(ok_slow.text().await.unwrap(), "backend-real-500");

        // 2. Finite TTFB (1s) returns synthetic 504 + X-FluxProxy-Error: upstream-response-timeout
        ctx.response_header_timeout_sec.store(1, Ordering::Relaxed);
        let timed_out = client
            .get(format!("http://{upstream_addr}/very-slow"))
            .send()
            .await
            .unwrap();
        assert_eq!(timed_out.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(
            timed_out
                .headers()
                .get("x-fluxproxy-error")
                .and_then(|v| v.to_str().ok()),
            Some("upstream-response-timeout")
        );

        let recorded_timeout = store.get(2).expect("timeout session recorded");
        assert_eq!(recorded_timeout.summary.status, 504);
        assert!(recorded_timeout.response_headers.iter().any(|h| {
            h.name.eq_ignore_ascii_case("x-fluxproxy-error")
                && h.value == "upstream-response-timeout"
        }));

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn stage39_in_flight_session_guard_finalizes_499_on_client_disconnect() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        let release = Arc::new(tokio::sync::Notify::new());
        let release_srv = Arc::clone(&release);

        tokio::spawn(async move {
            if let Ok((_stream, _)) = upstream_listener.accept().await {
                release_srv.notified().await;
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-stage39-499-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("499.sqlite")).unwrap());
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();

        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(0),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(5)),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(120)),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();
        tokio::spawn(async move {
            if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_c = proxy_ctx.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(
                                req,
                                client_addr,
                                None,
                                ClientConnContext::new(),
                                inner_c,
                            )
                            .await,
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            }
        });

        let mut client_tcp = TcpStream::connect(proxy_addr).await.unwrap();
        let raw_req = format!(
            "GET http://{upstream_addr}/hang HTTP/1.1\r\nHost: {upstream_addr}\r\nConnection: close\r\n\r\n"
        );
        client_tcp.write_all(raw_req.as_bytes()).await.unwrap();

        let in_flight = tokio::time::timeout(Duration::from_secs(3), event_rx.recv())
            .await
            .expect("should emit in-flight session")
            .unwrap();
        assert_eq!(in_flight.status, 0);

        // Client aborts TCP connection while proxy is awaiting slow/hanging upstream
        drop(client_tcp);

        let closed_evt = tokio::time::timeout(Duration::from_secs(3), event_rx.recv())
            .await
            .expect("InFlightSessionGuard should emit 499 update on drop")
            .unwrap();
        assert_eq!(closed_evt.status, 499);
        assert!(closed_evt
            .error
            .as_deref()
            .unwrap_or("")
            .contains("Client closed connection"));

        let stored = store.get(in_flight.id).unwrap();
        assert_eq!(stored.summary.status, 499);
        assert!(stored.response_headers.iter().any(|h| {
            h.name.eq_ignore_ascii_case("x-fluxproxy-error") && h.value == "client-closed-request"
        }));

        release.notify_one();
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn stage39_connect_timeout_bounds_stalled_connect_tunnel_and_persists_prefs() {
        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-stage39-connect-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let store = Arc::new(TrafficStore::new(tmp_dir.join("connect.sqlite")).unwrap());
        let sysproxy = Arc::new(SystemProxyManager::new(&tmp_dir));
        let client_certs = Arc::new(ClientCertificateStore::in_memory());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let (bp_tx, _bp_rx) = mpsc::unbounded_channel();

        let controller = ProxyEngineController::new_with_channels(
            ca,
            rules,
            filters,
            store.clone(),
            sysproxy.clone(),
            client_certs,
            event_tx,
            removed_tx,
            bp_tx,
            None,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();

        // 1. Default prefs & persistence check
        assert_eq!(
            controller.get_upstream_timeouts(),
            crate::models::UpstreamTimeoutConfig::default()
        );
        assert!(controller
            .set_upstream_timeouts(crate::models::UpstreamTimeoutConfig {
                connect_timeout_sec: 1,
                response_header_timeout_sec: 3,
                composer_timeout_sec: 60,
            })
            .is_err());

        let saved = controller
            .set_upstream_timeouts(crate::models::UpstreamTimeoutConfig {
                connect_timeout_sec: 1,
                response_header_timeout_sec: 0,
                composer_timeout_sec: 45,
            })
            .unwrap();
        assert_eq!(saved.connect_timeout_sec, 1);
        assert_eq!(saved.response_header_timeout_sec, 0);
        assert_eq!(saved.composer_timeout_sec, 45);
        assert_eq!(sysproxy.load_upstream_timeouts_pref(), saved);

        // 2. Stalled upstream proxy CONNECT tunnel times out according to connectTimeoutSec=1
        let stalled_proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stalled_proxy_addr = stalled_proxy_listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((_sock, _)) = stalled_proxy_listener.accept().await {
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });

        controller
            .context
            .upstream_proxy
            .set_config(crate::models::UpstreamProxyConfig {
                enabled: true,
                protocol: crate::models::UpstreamProxyProtocol::Http,
                host: stalled_proxy_addr.ip().to_string(),
                port: stalled_proxy_addr.port(),
                username: None,
                password: None,
                has_password: false,
                bypass_list: Vec::new(),
            })
            .unwrap();

        // Bypass MITM on this domain so CONNECT tunnel passthrough executes
        let mut fcfg = controller.context.filters.get_config();
        fcfg.tls_bypass_enabled = true;
        fcfg.tls_bypass_rules.push(crate::models::TlsBypassRule {
            id: "stalled-connect".into(),
            enabled: true,
            pattern: "stalled-connect.example".into(),
            category: "custom".into(),
            description: "Stage 39 connect timeout test".into(),
        });
        controller.context.filters.update_config(fcfg);

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = Arc::clone(&controller.context);
        tokio::spawn(async move {
            if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_c = proxy_ctx.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(
                                req,
                                client_addr,
                                None,
                                ClientConnContext::new(),
                                inner_c,
                            )
                            .await,
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            }
        });

        let started = Instant::now();
        let mut client_tcp = TcpStream::connect(proxy_addr).await.unwrap();
        client_tcp
            .write_all(b"CONNECT stalled-connect.example:443 HTTP/1.1\r\nHost: stalled-connect.example:443\r\n\r\n")
            .await
            .unwrap();
        let mut buf = vec![0u8; 2048];
        let n = tokio::time::timeout(Duration::from_secs(4), client_tcp.read(&mut buf))
            .await
            .expect("CONNECT tunnel timeout should fire cleanly near 1s")
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(4));
        let resp_str = String::from_utf8_lossy(&buf[..n]);
        assert!(resp_str.starts_with("HTTP/1.1 502"));
        assert!(resp_str.to_ascii_lowercase().contains("x-fluxproxy-error: upstream-connect-timeout"));

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn stage39_composer_cancel_records_499() {
        let stalled_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stalled_addr = stalled_listener.local_addr().unwrap();
        let release = Arc::new(tokio::sync::Notify::new());
        let release_srv = Arc::clone(&release);
        tokio::spawn(async move {
            if let Ok((_sock, _)) = stalled_listener.accept().await {
                release_srv.notified().await;
            }
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-stage39-composer-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let store = Arc::new(TrafficStore::new(tmp_dir.join("composer-cancel.sqlite")).unwrap());
        let sysproxy = Arc::new(SystemProxyManager::new(&tmp_dir));
        let client_certs = Arc::new(ClientCertificateStore::in_memory());
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let (bp_tx, _bp_rx) = mpsc::unbounded_channel();

        let controller = Arc::new(
            ProxyEngineController::new_with_channels(
                ca,
                rules,
                filters,
                store.clone(),
                sysproxy,
                client_certs,
                event_tx,
                removed_tx,
                bp_tx,
                None,
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap(),
        );

        let ctrl_spawn = Arc::clone(&controller);
        let url = format!("http://{stalled_addr}/slow-composer");
        let task = tokio::spawn(async move {
            ctrl_spawn
                .execute_composed(ComposedRequest {
                    method: "GET".into(),
                    url,
                    headers: Vec::new(),
                    body: String::new(),
                    body_base64: None,
                    follow_redirects: false,
                    skip_python_scripts: Some(true),
                    request_id: Some("cmp-req-cancel-1".into()),
                    timeout_sec: Some(0),
                })
                .await
        });

        let in_flight = tokio::time::timeout(Duration::from_secs(3), event_rx.recv())
            .await
            .expect("Composer should emit in-flight session")
            .unwrap();
        assert_eq!(in_flight.status, 0);

        assert!(controller.cancel_composed_request("cmp-req-cancel-1"));
        assert!(!controller.cancel_composed_request("cmp-req-cancel-1"));

        let res = task.await.unwrap();
        assert!(res.is_err());

        let cancelled_evt = tokio::time::timeout(Duration::from_secs(3), event_rx.recv())
            .await
            .expect("Composer cancel should emit 499 session summary")
            .unwrap();
        assert_eq!(cancelled_evt.status, 499);
        let detail = store.get(in_flight.id).unwrap();
        assert_eq!(detail.summary.status, 499);
        assert!(detail.response_headers.iter().any(|h| {
            h.name.eq_ignore_ascii_case("x-fluxproxy-error") && h.value == "composer-cancelled"
        }));

        release.notify_one();
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn lan_client_allowlist_blocks_disallowed_lan_peers_with_403_without_recording() {
        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-lan-allowlist-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let mut cfg = crate::proxy::filters::default_backend_config();
        cfg.lan_client_allowlist = vec!["192.168.1.50".into(), "10.8.0.0/24".into()];
        filters.update_config(cfg);

        let breakpoints = Arc::new(BreakpointEngine::new(None));
        let store = Arc::new(TrafficStore::new(tmp_dir.join("lan-allowlist.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();

        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store: store.clone(),
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(proxy_addr.port()),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                DEFAULT_UPSTREAM_TIMEOUT_SEC,
            )),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let scripted_peers: Vec<SocketAddr> = vec![
            "192.168.1.99:54321".parse().unwrap(),
            "192.168.1.99:54322".parse().unwrap(),
            "192.168.1.50:54323".parse().unwrap(),
            "127.0.0.1:54324".parse().unwrap(),
        ];
        let proxy_ctx = ctx.clone();
        tokio::spawn(async move {
            for peer_addr in scripted_peers {
                if let Ok((tcp_stream, _)) = proxy_listener.accept().await {
                    let io = TokioIo::new(tcp_stream);
                    let c = proxy_ctx.clone();
                    tokio::spawn(async move {
                        let service = service_fn(move |req: Request<Incoming>| {
                            let inner_c = c.clone();
                            async move {
                                Ok::<_, Infallible>(
                                    handle_outer_proxy_request(
                                        req,
                                        peer_addr,
                                        None,
                                        ClientConnContext::new(),
                                        inner_c,
                                    )
                                    .await,
                                )
                            }
                        });
                        let _ = AutoConnBuilder::new(TokioExecutor::new())
                            .serve_connection_with_upgrades(io, service)
                            .await;
                    });
                }
            }
        });

        // 1. Disallowed LAN peer -> plain HTTP rejected with 403 without creating TrafficStore entry
        {
            let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
            sock.write_all(
                b"GET http://flux.proxy/health HTTP/1.1\r\nHost: flux.proxy\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
            let mut buf = Vec::new();
            let _ = sock.read_to_end(&mut buf).await;
            let resp = String::from_utf8_lossy(&buf);
            assert!(
                resp.starts_with("HTTP/1.1 403"),
                "expected 403 for disallowed HTTP peer, got: {resp}"
            );
            assert!(
                store.list_summaries().is_empty(),
                "disallowed HTTP request must not create TrafficStore session"
            );
        }

        // 2. Disallowed LAN peer -> CONNECT tunnel rejected with 403 without creating TrafficStore entry
        {
            let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
            sock.write_all(
                b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
            )
            .await
            .unwrap();
            let mut buf = [0u8; 512];
            let n = sock.read(&mut buf).await.unwrap();
            let resp = String::from_utf8_lossy(&buf[..n]);
            assert!(
                resp.starts_with("HTTP/1.1 403"),
                "expected 403 for disallowed CONNECT peer, got: {resp}"
            );
            assert!(
                store.list_summaries().is_empty(),
                "disallowed CONNECT request must not create TrafficStore session"
            );
        }

        // 3. Allowlisted LAN peer -> succeeds (200 OK)
        {
            let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
            sock.write_all(
                b"GET http://flux.proxy/health HTTP/1.1\r\nHost: flux.proxy\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
            let mut buf = Vec::new();
            let _ = sock.read_to_end(&mut buf).await;
            let resp = String::from_utf8_lossy(&buf);
            assert!(
                resp.starts_with("HTTP/1.1 200"),
                "expected 200 for allowlisted peer, got: {resp}"
            );
        }

        // 4. Loopback peer -> always succeeds (200 OK)
        {
            let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
            sock.write_all(
                b"GET http://flux.proxy/health HTTP/1.1\r\nHost: flux.proxy\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
            let mut buf = Vec::new();
            let _ = sock.read_to_end(&mut buf).await;
            let resp = String::from_utf8_lossy(&buf);
            assert!(
                resp.starts_with("HTTP/1.1 200"),
                "expected 200 for loopback peer, got: {resp}"
            );
        }

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn sec01_validates_resolved_ips_isolates_pools_and_blocks_remote_hosts_remap() {
        assert!(validate_resolved_addrs_for_peer(
            &["127.0.0.1:8080".parse().unwrap()],
            true,
            "evil.nip.io:8080"
        )
        .is_err());
        assert!(validate_resolved_addrs_for_peer(
            &["[::1]:8080".parse().unwrap()],
            true,
            "evil.nip.io:8080"
        )
        .is_err());
        assert!(validate_resolved_addrs_for_peer(
            &["[::ffff:127.0.0.1]:8080".parse().unwrap()],
            true,
            "evil.nip.io:8080"
        )
        .is_err());
        assert!(validate_resolved_addrs_for_peer(
            &["0.0.0.0:80".parse().unwrap()],
            true,
            "evil.zero.test:80"
        )
        .is_err());
        assert!(validate_resolved_addrs_for_peer(
            &["[::]:80".parse().unwrap()],
            true,
            "evil.zero.test:80"
        )
        .is_err());
        assert!(validate_resolved_addrs_for_peer(
            &["[::ffff:0.0.0.0]:80".parse().unwrap()],
            true,
            "evil.zero.test:80"
        )
        .is_err());
        assert!(validate_resolved_addrs_for_peer(
            &[
                "93.184.216.34:443".parse().unwrap(),
                "127.0.0.1:443".parse().unwrap(),
            ],
            true,
            "rebind.example:443"
        )
        .is_err());
        assert!(validate_resolved_addrs_for_peer(
            &["93.184.216.34:443".parse().unwrap()],
            true,
            "example.com:443"
        )
        .is_ok());
        assert!(validate_resolved_addrs_for_peer(
            &["127.0.0.1:8080".parse().unwrap()],
            false,
            "localhost:8080"
        )
        .is_ok());

        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-sec01-pools-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        let upstream_hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let upstream_hits_srv = Arc::clone(&upstream_hits);
        tokio::spawn(async move {
            while let Ok((stream, _)) = upstream_listener.accept().await {
                upstream_hits_srv.fetch_add(1, Ordering::Relaxed);
                let io = TokioIo::new(stream);
                tokio::spawn(async move {
                    let svc = service_fn(|_req: Request<Incoming>| async move {
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(
                            b"loopback-only-ok",
                        ))))
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let mut cfg = crate::proxy::filters::default_backend_config();
        cfg.tls_bypass_enabled = true;
        cfg.tls_bypass_rules = vec![TlsBypassRule {
            id: "bypass-remapped".into(),
            enabled: true,
            pattern: "remapped-internal.test".into(),
            category: "Test".into(),
            description: "Passthrough test".into(),
        }];
        filters.update_config(cfg);

        let host_remap = Arc::new(HostRemapRegistry::new());
        host_remap
            .set_rules(vec![crate::models::HostRemapRule {
                id: "remap-to-loopback".into(),
                enabled: true,
                source_pattern: "remapped-internal.test".into(),
                target_host: "127.0.0.1".into(),
                target_port: Some(upstream_addr.port()),
                preserve_host_header: true,
                comment: String::new(),
            }])
            .unwrap();

        let store = Arc::new(TrafficStore::new(tmp_dir.join("sec01.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();

        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints: Arc::new(BreakpointEngine::new(None)),
            host_remap: Arc::clone(&host_remap),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store,
            upstream_http_client: test_upstream_http_client(Some(Arc::clone(&host_remap))),
            remote_upstream_http_client: test_remote_upstream_http_client(Some(host_remap)),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(proxy_addr.port()),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                DEFAULT_UPSTREAM_TIMEOUT_SEC,
            )),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let local_before = ctx.upstream_http_client_for_peer(false);
        let remote_before = ctx.upstream_http_client_for_peer(true);
        assert!(!Arc::ptr_eq(&local_before, &remote_before));
        assert!(!local_before.peer_is_remote());
        assert!(remote_before.peer_is_remote());

        ctx.rebuild_upstream_clients();
        let local_after = ctx.upstream_http_client_for_peer(false);
        let remote_after = ctx.upstream_http_client_for_peer(true);
        assert!(!Arc::ptr_eq(&local_before, &local_after));
        assert!(!Arc::ptr_eq(&remote_before, &remote_after));
        assert!(!Arc::ptr_eq(&local_after, &remote_after));
        assert!(!local_after.peer_is_remote());
        assert!(remote_after.peer_is_remote());

        let scripted_peers: Vec<SocketAddr> = vec![
            "192.168.1.50:55001".parse().unwrap(),
            "192.168.1.50:55002".parse().unwrap(),
            "127.0.0.1:55003".parse().unwrap(),
        ];
        let proxy_ctx = ctx.clone();
        tokio::spawn(async move {
            for peer_addr in scripted_peers {
                if let Ok((tcp_stream, _)) = proxy_listener.accept().await {
                    let io = TokioIo::new(tcp_stream);
                    let c = proxy_ctx.clone();
                    tokio::spawn(async move {
                        let service = service_fn(move |req: Request<Incoming>| {
                            let inner_c = c.clone();
                            async move {
                                Ok::<_, Infallible>(
                                    handle_outer_proxy_request(
                                        req,
                                        peer_addr,
                                        None,
                                        ClientConnContext::new(),
                                        inner_c,
                                    )
                                    .await,
                                )
                            }
                        });
                        let _ = AutoConnBuilder::new(TokioExecutor::new())
                            .serve_connection_with_upgrades(io, service)
                            .await;
                    });
                }
            }
        });

        // Remote LAN peer -> plain HTTP via HOSTS Remapping to 127.0.0.1 must fail with 403
        {
            let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
            sock.write_all(
                b"GET http://remapped-internal.test/api HTTP/1.1\r\nHost: remapped-internal.test\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
            let mut buf = Vec::new();
            let _ = sock.read_to_end(&mut buf).await;
            let resp = String::from_utf8_lossy(&buf);
            assert!(resp.starts_with("HTTP/1.1 403"), "got: {resp}");
        }

        // Remote LAN peer -> CONNECT passthrough via HOSTS Remapping to 127.0.0.1 must fail with 403
        {
            let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
            sock.write_all(
                b"CONNECT remapped-internal.test:443 HTTP/1.1\r\nHost: remapped-internal.test:443\r\n\r\n",
            )
            .await
            .unwrap();
            let mut buf = [0u8; 512];
            let n = sock.read(&mut buf).await.unwrap();
            let resp = String::from_utf8_lossy(&buf[..n]);
            assert!(resp.starts_with("HTTP/1.1 403"), "got: {resp}");
        }
        assert_eq!(upstream_hits.load(Ordering::Relaxed), 0);

        // Local loopback peer -> plain HTTP via HOSTS Remapping succeeds with 200
        {
            let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
            sock.write_all(
                b"GET http://remapped-internal.test/api HTTP/1.1\r\nHost: remapped-internal.test\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
            let mut buf = Vec::new();
            let _ = sock.read_to_end(&mut buf).await;
            let resp = String::from_utf8_lossy(&buf);
            assert!(resp.starts_with("HTTP/1.1 200"), "got: {resp}");
            assert!(resp.contains("loopback-only-ok"), "got: {resp}");
        }
        assert_eq!(upstream_hits.load(Ordering::Relaxed), 1);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn sec03_blocks_domain_fronting_and_h2_authority_coalescing_in_intercept_all() {
        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-test-sec03-intercept-all-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        filters.update_config(ProxyFilterBackendConfig {
            tls_intercept_mode: TlsInterceptMode::InterceptAll,
            tls_bypass_enabled: true,
            tls_bypass_rules: vec![TlsBypassRule {
                id: "bypass-pinned-bank".into(),
                enabled: true,
                pattern: "pinned-bank.test".into(),
                category: "Banking".into(),
                description: "Bypass pinned-bank.test".into(),
            }],
            tls_target_rules: Vec::new(),
            ..crate::proxy::filters::default_backend_config()
        });

        let store = Arc::new(TrafficStore::new(tmp_dir.join("sec03_ia.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let (removed_tx, _removed_rx) = mpsc::unbounded_channel();
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();

        let ctx = Arc::new(SharedProxyContext {
            ca: ca.clone(),
            rules,
            filters,
            breakpoints: Arc::new(BreakpointEngine::new(None)),
            host_remap: Arc::new(HostRemapRegistry::new()),
            upstream_proxy: Arc::new(UpstreamProxyManager::new()),
            throttle: Arc::new(ThrottleEngine::new()),
            store,
            upstream_http_client: test_upstream_http_client(None),
            remote_upstream_http_client: test_remote_upstream_http_client(None),
            client_certs: Arc::new(ClientCertificateStore::in_memory()),
            script_runner: Arc::new(PythonScriptRunner::new(None)),
            active_ws_channels: Arc::new(DashMap::new()),
            event_tx,
            removed_tx,
            active_port: AtomicU16::new(proxy_addr.port()),
            connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                DEFAULT_UPSTREAM_TIMEOUT_SEC,
            )),
            response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
            )),
            composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
            )),
            app_handle: None,
            stats_dirty: Arc::new(AtomicBool::new(false)),
        });

        let proxy_ctx = ctx.clone();
        tokio::spawn(async move {
            for _ in 0..2 {
                if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                    let io = TokioIo::new(tcp_stream);
                    let c = proxy_ctx.clone();
                    tokio::spawn(async move {
                        let service = service_fn(move |req: Request<Incoming>| {
                            let inner_c = c.clone();
                            async move {
                                Ok::<_, Infallible>(
                                    handle_outer_proxy_request(
                                        req,
                                        client_addr,
                                        None,
                                        ClientConnContext::new(),
                                        inner_c,
                                    )
                                    .await,
                                )
                            }
                        });
                        let _ = AutoConnBuilder::new(TokioExecutor::new())
                            .serve_connection_with_upgrades(io, service)
                            .await;
                    });
                }
            }
        });

        let mut root_store = rustls::RootCertStore::empty();
        root_store
            .add(rustls::pki_types::CertificateDer::from(
                ca.root_ca_der().to_vec(),
            ))
            .unwrap();

        // 1. HTTP/1.1 Host mismatch to bypassed domain inside InterceptAll CONNECT tunnel -> 421 Misdirected Request
        {
            let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
            sock.write_all(b"CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n")
                .await
                .unwrap();
            let mut connect_buf = [0u8; 256];
            let n = sock.read(&mut connect_buf).await.unwrap();
            assert!(String::from_utf8_lossy(&connect_buf[..n]).starts_with("HTTP/1.1 200"));

            let tls_cfg = Arc::new(
                rustls::ClientConfig::builder()
                    .with_root_certificates(root_store.clone())
                    .with_no_client_auth(),
            );
            let connector = tokio_rustls::TlsConnector::from(tls_cfg);
            let server_name = rustls::pki_types::ServerName::try_from("allowed.test").unwrap();
            let mut tls_stream = connector.connect(server_name, sock).await.unwrap();

            tls_stream
                .write_all(
                    b"GET /secret HTTP/1.1\r\nHost: pinned-bank.test\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            let mut resp_bytes = Vec::new();
            let _ = tls_stream.read_to_end(&mut resp_bytes).await;
            let inner_resp = String::from_utf8_lossy(&resp_bytes);
            assert!(
                inner_resp.starts_with("HTTP/1.1 421"),
                "expected 421 Misdirected Request for HTTP/1.1 Host mismatch in InterceptAll, got: {inner_resp}"
            );
        }

        // 2. HTTP/2 :authority mismatch to bypassed domain inside InterceptAll CONNECT tunnel -> 421 Misdirected Request
        {
            let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
            sock.write_all(b"CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n")
                .await
                .unwrap();
            let mut connect_buf = [0u8; 256];
            let n = sock.read(&mut connect_buf).await.unwrap();
            assert!(String::from_utf8_lossy(&connect_buf[..n]).starts_with("HTTP/1.1 200"));

            let mut tls_cfg = rustls::ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth();
            tls_cfg.alpn_protocols = vec![b"h2".to_vec()];
            let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_cfg));
            let server_name = rustls::pki_types::ServerName::try_from("allowed.test").unwrap();
            let tls_stream = connector.connect(server_name, sock).await.unwrap();

            let (mut sender, conn) = hyper::client::conn::http2::Builder::new(TokioExecutor::new())
                .handshake::<_, http_body_util::Empty<Bytes>>(TokioIo::new(tls_stream))
                .await
                .unwrap();
            tokio::spawn(async move {
                let _ = conn.await;
            });

            let h2_req = Request::builder()
                .method(hyper::Method::GET)
                .uri("https://pinned-bank.test/secret")
                .body(http_body_util::Empty::<Bytes>::new())
                .unwrap();
            let h2_resp = sender.send_request(h2_req).await.unwrap();
            assert_eq!(
                h2_resp.status(),
                StatusCode::MISDIRECTED_REQUEST,
                "expected 421 Misdirected Request for HTTP/2 :authority mismatch in InterceptAll"
            );
        }

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    async fn read_raw_http_head_and_body(stream: &mut TcpStream) -> (Vec<u8>, Vec<u8>) {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        let split_pos = loop {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break pos;
            }
            let n = stream.read(&mut tmp).await.unwrap();
            assert!(n > 0, "unexpected EOF while reading HTTP response headers");
            buf.extend_from_slice(&tmp[..n]);
        };
        let head = buf[..split_pos].to_vec();
        let mut body = buf[split_pos + 4..].to_vec();
        let head_str = String::from_utf8_lossy(&head);
        let content_len = head_str
            .lines()
            .skip(1)
            .find_map(|line| {
                let (k, v) = line.split_once(':')?;
                if k.trim().eq_ignore_ascii_case("content-length") {
                    v.trim().parse::<usize>().ok()
                } else {
                    None
                }
            });
        if let Some(cl) = content_len {
            while body.len() < cl {
                let n = stream.read(&mut tmp).await.unwrap();
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&tmp[..n]);
            }
            body.truncate(cl);
        } else {
            let _ = stream.read_to_end(&mut body).await;
        }
        (head, body)
    }

    async fn open_proxied_ws(
        proxy_port: u16,
        ws_url: &str,
    ) -> WebSocketStream<TcpStream> {
        let mut tcp = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
        let rest = ws_url
            .strip_prefix("ws://")
            .expect("open_proxied_ws expects ws:// URL");
        let (host_port, path_q) = match rest.find('/') {
            Some(idx) => (&rest[..idx], &rest[idx..]),
            None => (rest, "/"),
        };
        let req = format!(
            "GET http://{host_port}{path_q} HTTP/1.1\r\n\
             Host: {host_port}\r\n\
             Connection: Upgrade\r\n\
             Upgrade: websocket\r\n\
             Sec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        );
        tcp.write_all(req.as_bytes()).await.unwrap();
        let mut resp_buf = Vec::with_capacity(512);
        let mut byte = [0u8; 1];
        while !resp_buf.ends_with(b"\r\n\r\n") {
            let n = tcp.read(&mut byte).await.unwrap();
            assert!(n > 0, "unexpected EOF waiting for WS 101 response");
            resp_buf.push(byte[0]);
        }
        let resp_str = String::from_utf8_lossy(&resp_buf);
        assert!(
            resp_str.starts_with("HTTP/1.1 101"),
            "expected 101 Switching Protocols, got: {resp_str}"
        );
        WebSocketStream::from_raw_socket(
            tcp,
            tokio_tungstenite::tungstenite::protocol::Role::Client,
            None,
        )
        .await
    }

    fn make_stage44_controller(
        label: &str,
    ) -> (
        ProxyEngineController,
        Arc<RuleEngine>,
        Arc<ProxyFilterEngine>,
        Arc<TrafficStore>,
        std::path::PathBuf,
    ) {
        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy_stage44_{}_{}_{}",
            label,
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = std::fs::create_dir_all(&tmp_dir);
        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let store = Arc::new(TrafficStore::new(tmp_dir.join("sessions.sqlite")).unwrap());
        let os_backend = RecordingOsProxyBackend::new();
        let sysproxy = Arc::new(SystemProxyManager::with_backend(&tmp_dir, os_backend));
        let controller = ProxyEngineController::new_for_test(
            ca,
            rules.clone(),
            filters.clone(),
            store.clone(),
            sysproxy,
        )
        .unwrap();
        (controller, rules, filters, store, tmp_dir)
    }

    #[tokio::test]
    async fn bug01_preserves_raw_utf8_and_obs_text_headers_end_to_end_and_on_edit() {
        let raw_utf8 = b"attachment; filename=\"\xd0\xbe\xd1\x82\xd1\x87\xd0\xb5\xd1\x82.pdf\"";
        let raw_obs = b"val\xff!";
        let mut hmap = http::HeaderMap::new();
        hmap.insert(
            http::HeaderName::from_static("content-disposition"),
            http::HeaderValue::from_bytes(raw_utf8).unwrap(),
        );
        hmap.insert(
            http::HeaderName::from_static("x-raw-obs"),
            http::HeaderValue::from_bytes(raw_obs).unwrap(),
        );

        let extracted = extract_hyper_headers(&hmap);
        let cd = extracted
            .iter()
            .find(|h| h.name == "content-disposition")
            .unwrap();
        assert!(cd.raw_bytes_b64.is_some());
        assert_eq!(cd.to_hyper_header_value().unwrap().as_bytes(), raw_utf8);

        let obs = extracted.iter().find(|h| h.name == "x-raw-obs").unwrap();
        assert!(obs.raw_bytes_b64.is_some());
        assert_eq!(obs.to_hyper_header_value().unwrap().as_bytes(), raw_obs);

        let mut edited = obs.clone();
        edited.value = "edited-ascii".into();
        assert_eq!(
            edited.to_hyper_header_value().unwrap().as_bytes(),
            b"edited-ascii"
        );

        // End-to-end raw TCP proxy verification
        let upstream_seen_req = Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        let upstream_seen_srv = Arc::clone(&upstream_seen_req);
        let up_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_addr = up_listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = up_listener.accept().await {
                let mut raw = Vec::new();
                let mut chunk = [0u8; 4096];
                while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = sock.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&chunk[..n]);
                }
                *upstream_seen_srv.lock().unwrap() = raw;
                let mut resp = Vec::new();
                resp.extend_from_slice(b"HTTP/1.1 200 OK\r\nContent-Disposition: ");
                resp.extend_from_slice(b"attachment; filename=\"\xd0\xbe\xd1\x82\xd1\x87\xd0\xb5\xd1\x82.pdf\"");
                resp.extend_from_slice(b"\r\nX-Raw-Obs: ");
                resp.extend_from_slice(b"val\xff!");
                resp.extend_from_slice(b"\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
                sock.write_all(&resp).await.unwrap();
            }
        });

        let (controller, _rules, _filters, store, tmp_dir) = make_stage44_controller("bug01");
        let status = controller.start("127.0.0.1".into(), 0).await.unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", status.port))
            .await
            .unwrap();
        let client_raw_hdr = b"\xd0\xbf\xd1\x80\xd0\xb8";
        let mut req_wire = format!(
            "GET http://{up_addr}/raw-hdr HTTP/1.1\r\nHost: {up_addr}\r\nX-Client-Raw: "
        )
        .into_bytes();
        req_wire.extend_from_slice(client_raw_hdr);
        req_wire.extend_from_slice(b"\r\nConnection: close\r\n\r\n");
        client.write_all(&req_wire).await.unwrap();

        let (resp_head, resp_body) = read_raw_http_head_and_body(&mut client).await;
        assert_eq!(resp_body, b"ok");
        assert!(resp_head.windows(raw_utf8.len()).any(|w| w == raw_utf8));
        assert!(resp_head.windows(raw_obs.len()).any(|w| w == raw_obs));

        let upstream_wire = upstream_seen_req.lock().unwrap().clone();
        assert!(
            upstream_wire
                .windows(client_raw_hdr.len())
                .any(|w| w == client_raw_hdr),
            "upstream did not receive raw non-ASCII client header"
        );

        let sessions = store.list_summaries();
        let detail = store.get(sessions[0].id).unwrap();
        assert!(detail
            .response_headers
            .iter()
            .any(|h| h.name.eq_ignore_ascii_case("x-raw-obs") && h.raw_bytes_b64.is_some()));

        controller.stop().await;
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn bug02_autoresponder_mock_strips_stale_headers_and_sets_exact_cl() {
        use crate::models::{AutoResponderRule, RuleMatchTarget};

        let (controller, rules, _filters, _store, tmp_dir) = make_stage44_controller("bug02");
        rules.set_rules(vec![AutoResponderRule {
            id: "mock-clean".into(),
            enabled: true,
            name: "Mock Clean".into(),
            match_target: RuleMatchTarget::UrlContains,
            pattern: "/mock-cl".into(),
            method_filter: None,
            header_name: None,
            action: RuleActionType::MockResponse,
            status_code: 200,
            latency_ms: 0,
            response_headers: vec![
                HeaderPair::new("Content-Type", "application/json"),
                HeaderPair::new("Content-Length", "99999"),
                HeaderPair::new("Content-Encoding", "gzip"),
                HeaderPair::new("Transfer-Encoding", "chunked"),
                HeaderPair::new("Connection", "keep-alive"),
                HeaderPair::new("Keep-Alive", "timeout=9"),
                HeaderPair::new("Proxy-Connection", "keep-alive"),
            ],
            response_body: "{\"ok\":1}".into(),
        }]);
        let status = controller.start("127.0.0.1".into(), 0).await.unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", status.port))
            .await
            .unwrap();
        client
            .write_all(b"GET http://mock.example/mock-cl HTTP/1.1\r\nHost: mock.example\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let (head, body) = read_raw_http_head_and_body(&mut client).await;
        assert_eq!(body, br#"{"ok":1}"#);
        let head_lower = String::from_utf8_lossy(&head).to_ascii_lowercase();
        assert!(head_lower.contains("content-length: 8"), "head={head_lower}");
        assert!(!head_lower.contains("content-encoding"), "head={head_lower}");
        assert!(!head_lower.contains("transfer-encoding"), "head={head_lower}");
        assert!(!head_lower.contains("proxy-connection"), "head={head_lower}");
        assert!(!head_lower.contains("keep-alive:"), "head={head_lower}");

        let comp = controller
            .execute_composed(ComposedRequest {
                method: "GET".into(),
                url: "http://mock.example/mock-cl".into(),
                headers: vec![],
                body: String::new(),
                body_base64: None,
                follow_redirects: false,
                skip_python_scripts: Some(true),
                request_id: None,
                timeout_sec: None,
            })
            .await
            .unwrap();
        assert!(comp
            .response_headers
            .iter()
            .any(|h| h.name.eq_ignore_ascii_case("content-length") && h.value == "8"));
        assert!(!comp.response_headers.iter().any(|h| {
            h.name.eq_ignore_ascii_case("content-encoding")
                || h.name.eq_ignore_ascii_case("transfer-encoding")
                || h.name.eq_ignore_ascii_case("proxy-connection")
        }));

        controller.stop().await;
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn bug03_custom_host_header_after_mutation_bpu_and_ws_reaches_upstream() {
        use crate::models::{
            BreakpointRule, HeaderMutationDirection, HeaderMutationOp, HeaderMutationRule,
        };

        let recorded_http_hosts = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let recorded_ws_hosts = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let http_hosts_srv = Arc::clone(&recorded_http_hosts);
        let ws_hosts_srv = Arc::clone(&recorded_ws_hosts);

        let up_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_addr = up_listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = up_listener.accept().await {
                let http_hosts = Arc::clone(&http_hosts_srv);
                let ws_hosts = Arc::clone(&ws_hosts_srv);
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req: Request<Incoming>| {
                        let http_hosts = Arc::clone(&http_hosts);
                        let ws_hosts = Arc::clone(&ws_hosts);
                        async move {
                            let host_val = req
                                .headers()
                                .get(http::header::HOST)
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("")
                                .to_string();
                            let is_ws = req
                                .headers()
                                .get(http::header::UPGRADE)
                                .and_then(|v| v.to_str().ok())
                                .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
                            if is_ws {
                                ws_hosts.lock().unwrap().push(host_val);
                                let key = req
                                    .headers()
                                    .get("sec-websocket-key")
                                    .and_then(|v| v.to_str().ok())
                                    .unwrap_or("");
                                let accept =
                                    tokio_tungstenite::tungstenite::handshake::derive_accept_key(
                                        key.as_bytes(),
                                    );
                                tokio::spawn(async move {
                                    if let Ok(up) = hyper::upgrade::on(req).await {
                                        let mut ws = WebSocketStream::from_raw_socket(
                                            TokioIo::new(up),
                                            Role::Server,
                                            None,
                                        )
                                        .await;
                                        let _ = ws.close(None).await;
                                    }
                                });
                                return Ok::<_, Infallible>(
                                    Response::builder()
                                        .status(StatusCode::SWITCHING_PROTOCOLS)
                                        .header(http::header::CONNECTION, "Upgrade")
                                        .header(http::header::UPGRADE, "websocket")
                                        .header("Sec-WebSocket-Accept", accept)
                                        .body(Full::new(Bytes::new()))
                                        .unwrap(),
                                );
                            }
                            http_hosts.lock().unwrap().push(host_val);
                            Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"ok"))))
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, svc)
                        .await;
                });
            }
        });

        let (controller, _rules, filters, _store, tmp_dir) = make_stage44_controller("bug03");
        filters.update_config(ProxyFilterBackendConfig {
            header_mutations_enabled: true,
            header_mutations: vec![
                HeaderMutationRule {
                    id: "mut-http-host".into(),
                    enabled: true,
                    name: "Mutate HTTP Host".into(),
                    direction: HeaderMutationDirection::Request,
                    operation: HeaderMutationOp::Set,
                    header_name: "Host".into(),
                    header_value: "mutated-http.example".into(),
                    url_pattern: "/mut-host".into(),
                },
                HeaderMutationRule {
                    id: "mut-ws-host".into(),
                    enabled: true,
                    name: "Mutate WS Host".into(),
                    direction: HeaderMutationDirection::Request,
                    operation: HeaderMutationOp::Set,
                    header_name: "Host".into(),
                    header_value: "ws-mutated.example".into(),
                    url_pattern: "/ws-host".into(),
                },
            ],
            ..crate::proxy::filters::default_backend_config()
        });
        let status = controller.start("127.0.0.1".into(), 0).await.unwrap();

        // 1. Header Mutation custom Host
        let mut c1 = TcpStream::connect(("127.0.0.1", status.port))
            .await
            .unwrap();
        c1.write_all(
            format!("GET http://{up_addr}/mut-host HTTP/1.1\r\nHost: {up_addr}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
        let _ = read_raw_http_head_and_body(&mut c1).await;

        // 2. Breakpoint (bpu) custom Host
        controller.context.breakpoints.update_config(BreakpointConfig {
            break_before_request: false,
            break_after_response: false,
            timeout_secs: 5,
            rules: vec![BreakpointRule {
                id: "bp-host".into(),
                enabled: true,
                name: "BPU Host".into(),
                stage: BreakpointStage::Request,
                url_pattern: "/bpu-host".into(),
                method_filter: None,
            }],
        });
        let bp_ctx = controller.context.clone();
        let bp_task = tokio::spawn(async move {
            for _ in 0..100 {
                let paused = bp_ctx.breakpoints.list_paused();
                if let Some(item) = paused.into_iter().next() {
                    let resolved = bp_ctx.breakpoints.resolve(BreakpointResolution {
                        breakpoint_id: item.breakpoint_id,
                        action: BreakpointAction::Continue,
                        method: None,
                        url: None,
                        request_headers: Some(vec![HeaderPair::new("Host", "bpu-host.example")]),
                        request_body_base64: None,
                        request_body_text: None,
                        status_code: None,
                        response_headers: None,
                        response_body_base64: None,
                        response_body_text: None,
                    });
                    assert!(resolved);
                    return;
                }
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
            panic!("breakpoint never paused");
        });
        let mut c2 = TcpStream::connect(("127.0.0.1", status.port))
            .await
            .unwrap();
        c2.write_all(
            format!("GET http://{up_addr}/bpu-host HTTP/1.1\r\nHost: {up_addr}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
        let _ = read_raw_http_head_and_body(&mut c2).await;
        bp_task.await.unwrap();

        // 3. WebSocket custom Host
        let _ws = open_proxied_ws(status.port, &format!("ws://{up_addr}/ws-host")).await;

        assert_eq!(
            recorded_http_hosts.lock().unwrap().as_slice(),
            &[
                "mutated-http.example".to_string(),
                "bpu-host.example".to_string()
            ]
        );
        assert_eq!(
            recorded_ws_hosts.lock().unwrap().as_slice(),
            &["ws-mutated.example".to_string()]
        );

        controller.stop().await;
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn bug04_empty_post_put_patch_emits_explicit_content_length_zero() {
        let raw_heads = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let heads_srv = Arc::clone(&raw_heads);
        let up_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_addr = up_listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = up_listener.accept().await {
                let heads = Arc::clone(&heads_srv);
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 2048];
                    while let Ok(n) = sock.read(&mut tmp).await {
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head_str = String::from_utf8_lossy(&buf[..pos + 4]).to_string();
                            heads.lock().unwrap().push(head_str);
                            let _ = sock
                                .write_all(
                                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                                )
                                .await;
                            break;
                        }
                    }
                });
            }
        });

        let (controller, _rules, _filters, _store, tmp_dir) = make_stage44_controller("bug04");
        let status = controller.start("127.0.0.1".into(), 0).await.unwrap();

        for method in ["POST", "PUT", "PATCH"] {
            let mut client = TcpStream::connect(("127.0.0.1", status.port))
                .await
                .unwrap();
            client
                .write_all(
                    format!(
                        "{method} http://{up_addr}/empty HTTP/1.1\r\nHost: {up_addr}\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let (_h, body) = read_raw_http_head_and_body(&mut client).await;
            assert_eq!(body, b"ok");
        }

        let captured = raw_heads.lock().unwrap();
        assert_eq!(captured.len(), 3);
        for head in captured.iter() {
            let lower = head.to_ascii_lowercase();
            assert!(
                lower.contains("\r\ncontent-length: 0\r\n"),
                "missing explicit Content-Length: 0 in raw request head:\n{head}"
            );
            assert!(
                !lower.contains("transfer-encoding: chunked"),
                "unexpected Transfer-Encoding: chunked in:\n{head}"
            );
        }

        controller.stop().await;
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn bug05_sse_sink_reset_4b_gzip_preview_and_4c_chunked_spill() {
        use std::io::Write;

        // 4a. BoundedSseSink resets total_written inside take_bytes()
        let mut sink = BoundedSseSink::new(1024);
        sink.write_all(&vec![b'a'; 900]).unwrap();
        assert_eq!(sink.take_bytes().len(), 900);
        sink.write_all(&vec![b'b'; 900]).unwrap();
        assert_eq!(sink.take_bytes().len(), 900);
        assert!(sink.write_all(&vec![b'c'; 1025]).is_err());

        // Prepare >2 MiB valid gzip JSON payload (compressible 4KiB prefix + incompressible ASCII tail)
        let mut plain_payload = Vec::with_capacity(4_020_000);
        plain_payload.extend_from_slice(br#"{"preview":"fluxproxy-gzip-ok","pad":"#);
        plain_payload.extend(std::iter::repeat_n(b'A', 4096));
        plain_payload.extend_from_slice(br#"","noise":""#);
        let mut rng: u64 = 0x1234_5678_9abc_def0;
        for _ in 0..4_000_000 {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            let ch = b'a' + ((rng >> 32) as u8 % 26);
            plain_payload.push(ch);
        }
        plain_payload.extend_from_slice(br#""}"#);

        let mut gz_encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz_encoder.write_all(&plain_payload).unwrap();
        let gz_bytes = Arc::new(gz_encoder.finish().unwrap());
        assert!(
            gz_bytes.len() > BODY_OFFLOAD_THRESHOLD_BYTES,
            "compressed payload must exceed 2 MiB to trigger branch 4b"
        );

        let chunked_piece = Arc::new(vec![b'J'; 65_536]);
        let gz_srv = Arc::clone(&gz_bytes);
        let chunk_srv = Arc::clone(&chunked_piece);
        let up_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_addr = up_listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = up_listener.accept().await {
                let gz = Arc::clone(&gz_srv);
                let cp = Arc::clone(&chunk_srv);
                tokio::spawn(async move {
                    let mut req_buf = Vec::new();
                    let mut tmp = [0u8; 2048];
                    while let Ok(n) = sock.read(&mut tmp).await {
                        if n == 0 {
                            break;
                        }
                        req_buf.extend_from_slice(&tmp[..n]);
                        if req_buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let req_head = String::from_utf8_lossy(&req_buf);
                    if req_head.contains("/gzip-4b") {
                        let hdr = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            gz.len()
                        );
                        let _ = sock.write_all(hdr.as_bytes()).await;
                        let _ = sock.write_all(&gz).await;
                    } else {
                        let _ = sock
                            .write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                            )
                            .await;
                        let chunk_hdr = format!("{:x}\r\n", cp.len());
                        for _ in 0..40 {
                            if sock.write_all(chunk_hdr.as_bytes()).await.is_err()
                                || sock.write_all(&cp).await.is_err()
                                || sock.write_all(b"\r\n").await.is_err()
                            {
                                return;
                            }
                        }
                        let _ = sock.write_all(b"0\r\n\r\n").await;
                    }
                });
            }
        });

        let (controller, _rules, _filters, store, tmp_dir) = make_stage44_controller("bug05");
        let status = controller.start("127.0.0.1".into(), 0).await.unwrap();

        // 4b. Gzipped >2 MiB response decodes 64 KiB preview into TrafficStore
        {
            let tcp = TcpStream::connect(("127.0.0.1", status.port))
                .await
                .unwrap();
            let (mut sender, conn) =
                hyper::client::conn::http1::handshake(TokioIo::new(tcp))
                    .await
                    .unwrap();
            tokio::spawn(async move {
                let _ = conn.await;
            });
            let req = Request::builder()
                .method(hyper::Method::GET)
                .uri(format!("http://{up_addr}/gzip-4b"))
                .header(http::header::HOST, up_addr.to_string())
                .body(http_body_util::Empty::<Bytes>::new())
                .unwrap();
            let resp = sender.send_request(req).await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            let received = resp.into_body().collect().await.unwrap().to_bytes();
            assert_eq!(received.len(), gz_bytes.len());

            tokio::time::sleep(Duration::from_millis(80)).await;
            let s4b = store
                .list_summaries()
                .into_iter()
                .find(|s| s.path.contains("/gzip-4b"))
                .unwrap();
            let d4b = store.get(s4b.id).unwrap();
            let preview_txt = d4b.response_body_text.expect("expected decoded 4b text preview");
            assert!(
                preview_txt.contains("fluxproxy-gzip-ok"),
                "decoded preview missing marker: {}",
                &preview_txt[..preview_txt.len().min(120)]
            );
        }

        // 4c. Chunked >2 MiB response spills to streaming seamlessly instead of 502 / 499
        {
            let tcp = TcpStream::connect(("127.0.0.1", status.port))
                .await
                .unwrap();
            let (mut sender, conn) =
                hyper::client::conn::http1::handshake(TokioIo::new(tcp))
                    .await
                    .unwrap();
            tokio::spawn(async move {
                let _ = conn.await;
            });
            let req = Request::builder()
                .method(hyper::Method::GET)
                .uri(format!("http://{up_addr}/chunked-4c"))
                .header(http::header::HOST, up_addr.to_string())
                .body(http_body_util::Empty::<Bytes>::new())
                .unwrap();
            let resp = sender.send_request(req).await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            let received = resp.into_body().collect().await.unwrap().to_bytes();
            assert_eq!(received.len(), 40 * chunked_piece.len());

            tokio::time::sleep(Duration::from_millis(80)).await;
            let s4c = store
                .list_summaries()
                .into_iter()
                .find(|s| s.path.contains("/chunked-4c"))
                .unwrap();
            assert_eq!(s4c.status, 200);
            let d4c = store.get(s4c.id).unwrap();
            assert_eq!(
                d4c.transfer_stats.as_ref().and_then(|st| st.is_streaming),
                Some(true)
            );
        }

        controller.stop().await;
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn bug06_self_loop_rejects_loopback_ranges_v6_and_local_interfaces() {
        use crate::models::UpstreamProxyProtocol;

        let (controller, _rules, _filters, _store, tmp_dir) = make_stage44_controller("bug06");
        let status = controller.start("127.0.0.1".into(), 0).await.unwrap();
        let active_port = status.port;

        let make_cfg = |host: &str, port: u16| UpstreamProxyConfig {
            enabled: true,
            protocol: UpstreamProxyProtocol::Http,
            host: host.into(),
            port,
            username: None,
            password: None,
            has_password: false,
            bypass_list: Vec::new(),
        };

        for loopback_host in [
            "127.0.0.2",
            "localhost",
            "::1",
            "::ffff:127.0.0.1",
            "0.0.0.0",
        ] {
            let err = controller
                .set_upstream_proxy_config(make_cfg(loopback_host, active_port))
                .unwrap_err();
            assert!(
                err.to_string().contains("Защита от петли трафика"),
                "expected self-loop error for {loopback_host}:{active_port}, got {err}"
            );
        }

        let local_ifs = crate::proxy::network::list_network_interfaces_with_options(true);
        if let Some(iface) = local_ifs.first() {
            let err = controller
                .set_upstream_proxy_config(make_cfg(&iface.ip, active_port))
                .unwrap_err();
            assert!(err.to_string().contains("Защита от петли трафика"));
        }

        // Bind a spare port to guarantee Q != active_port and Q is free
        let probe_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let alt_port = probe_listener.local_addr().unwrap().port();
        drop(probe_listener);

        // Verify set_bind_configuration also enforces self-loop protection against active port
        controller
            .context
            .upstream_proxy
            .set_config(make_cfg("127.0.0.2", active_port))
            .unwrap();
        let bind_loop_err = controller
            .set_bind_configuration(BindHostMode::AllInterfaces, None, false)
            .await
            .unwrap_err();
        assert!(bind_loop_err.to_string().contains("Защита от петли трафика"));

        controller
            .set_upstream_proxy_config(make_cfg("127.0.0.2", alt_port))
            .expect("different port must be accepted");

        let set_port_err = controller.set_port(alt_port).await.unwrap_err();
        assert!(set_port_err.to_string().contains("Защита от петли трафика"));
        assert_eq!(controller.status().await.port, active_port);

        controller.stop().await;
        controller.set_port(alt_port).await.unwrap_err();
        let start_err = controller.start("0.0.0.0".into(), alt_port).await.unwrap_err();
        assert!(start_err.to_string().contains("Защита от петли трафика"));

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn bug07_composer_cancel_latency_and_bpu_redirect_url_and_mock_filter() {
        use crate::models::{
            AutoResponderRule, BreakpointRule, HostListBackendSyncConfig, HostListFilterMode,
            RuleMatchTarget,
        };

        let (controller, rules, filters, store, tmp_dir) = make_stage44_controller("bug07");

        // Redirect + Target servers
        let dest_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dest_addr = dest_listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = dest_listener.accept().await {
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(|_req: Request<Incoming>| async move {
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"landed"))))
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });
        let redir_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let redir_addr = redir_listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = redir_listener.accept().await {
                let target_url = format!("http://localhost:{}/landed?foo=bar", dest_addr.port());
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |_req: Request<Incoming>| {
                        let loc = target_url.clone();
                        async move {
                            Ok::<_, Infallible>(
                                Response::builder()
                                    .status(StatusCode::FOUND)
                                    .header(http::header::LOCATION, loc)
                                    .body(Full::new(Bytes::new()))
                                    .unwrap(),
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        // 1. Follow redirects updates final summary url/host/path
        let redir_detail = controller
            .execute_composed(ComposedRequest {
                method: "GET".into(),
                url: format!("http://{redir_addr}/bounce"),
                headers: vec![],
                body: String::new(),
                body_base64: None,
                follow_redirects: true,
                skip_python_scripts: Some(true),
                request_id: None,
                timeout_sec: None,
            })
            .await
            .unwrap();
        assert_eq!(redir_detail.summary.status, 200);
        assert_eq!(redir_detail.summary.host, "localhost");
        assert_eq!(redir_detail.summary.path, "/landed?foo=bar");
        assert_eq!(
            redir_detail.summary.url,
            format!("http://localhost:{}/landed?foo=bar", dest_addr.port())
        );

        // 2. Cancel during DelayOnly latency simulation
        rules.set_rules(vec![
            AutoResponderRule {
                id: "slow-rule".into(),
                enabled: true,
                name: "Slow Latency".into(),
                match_target: RuleMatchTarget::UrlContains,
                pattern: "/slow-cancel".into(),
                method_filter: None,
                header_name: None,
                action: RuleActionType::DelayOnly,
                status_code: 200,
                latency_ms: 5_000,
                response_headers: vec![],
                response_body: String::new(),
            },
            AutoResponderRule {
                id: "mock-dropped".into(),
                enabled: true,
                name: "Mock Dropped".into(),
                match_target: RuleMatchTarget::UrlContains,
                pattern: "/dropped-mock".into(),
                method_filter: None,
                header_name: None,
                action: RuleActionType::MockResponse,
                status_code: 200,
                latency_ms: 0,
                response_headers: vec![HeaderPair::new("Content-Type", "application/json")],
                response_body: "{\"m\":1}".into(),
            },
        ]);

        let c_lat = Arc::new(controller);
        let c_lat_exec = Arc::clone(&c_lat);
        let lat_start = Instant::now();
        let lat_handle = tokio::spawn(async move {
            c_lat_exec
                .execute_composed(ComposedRequest {
                    method: "GET".into(),
                    url: "http://example.invalid/slow-cancel".into(),
                    headers: vec![],
                    body: String::new(),
                    body_base64: None,
                    follow_redirects: false,
                    skip_python_scripts: Some(true),
                    request_id: Some("cancel-lat-1".into()),
                    timeout_sec: Some(10),
                })
                .await
        });
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(c_lat.cancel_composed_request("cancel-lat-1"));
        let lat_res = lat_handle.await.unwrap();
        assert!(lat_res.is_err());
        assert!(lat_start.elapsed() < Duration::from_millis(500));

        // 3. Cancel during bpu cleans up paused breakpoint
        c_lat.context.breakpoints.update_config(BreakpointConfig {
            break_before_request: false,
            break_after_response: false,
            timeout_secs: 10,
            rules: vec![BreakpointRule {
                id: "bp-comp-cancel".into(),
                enabled: true,
                name: "Composer BPU Cancel".into(),
                stage: BreakpointStage::Request,
                url_pattern: "/comp-bpu-cancel".into(),
                method_filter: None,
            }],
        });
        let c_bpu_exec = Arc::clone(&c_lat);
        let bpu_handle = tokio::spawn(async move {
            c_bpu_exec
                .execute_composed(ComposedRequest {
                    method: "GET".into(),
                    url: "http://example.invalid/comp-bpu-cancel".into(),
                    headers: vec![],
                    body: String::new(),
                    body_base64: None,
                    follow_redirects: false,
                    skip_python_scripts: Some(true),
                    request_id: Some("cancel-bpu-1".into()),
                    timeout_sec: Some(10),
                })
                .await
        });
        let mut paused_seen = false;
        for _ in 0..100 {
            if !c_lat.context.breakpoints.list_paused().is_empty() {
                paused_seen = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(paused_seen, "Composer bpu should have paused");
        assert!(c_lat.cancel_composed_request("cancel-bpu-1"));
        assert!(bpu_handle.await.unwrap().is_err());
        assert!(
            c_lat.context.breakpoints.list_paused().is_empty(),
            "paused breakpoint must be cleaned up on Composer cancel"
        );

        // 4. MockResponse respects drop_non_matching_on_capture
        filters.update_config(ProxyFilterBackendConfig {
            drop_non_matching_on_capture: true,
            capture_host_list: HostListBackendSyncConfig {
                enabled: true,
                mode: HostListFilterMode::Whitelist,
                raw_text: "only-keep.invalid".into(),
            },
            ..crate::proxy::filters::default_backend_config()
        });
        let dropped_before = store.storage_stats(true).dropped_sessions_count;
        let mock_res = c_lat
            .execute_composed(ComposedRequest {
                method: "GET".into(),
                url: "http://dropped-host.invalid/dropped-mock".into(),
                headers: vec![],
                body: String::new(),
                body_base64: None,
                follow_redirects: false,
                skip_python_scripts: Some(true),
                request_id: None,
                timeout_sec: None,
            })
            .await
            .unwrap();
        assert!(store.get(mock_res.summary.id).is_none());
        assert!(store.storage_stats(true).dropped_sessions_count > dropped_before);

        c_lat.stop().await;
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn conc01_conc02_graceful_drain_hard_abort_and_live_policy_reactivity() {
        use std::sync::atomic::AtomicUsize;

        // Upstream HTTP + WebSocket echo server
        let up_http_ws = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_addr = up_http_ws.local_addr().unwrap();
        let up_hits = Arc::new(AtomicUsize::new(0));
        let up_hits_srv = Arc::clone(&up_hits);
        tokio::spawn(async move {
            while let Ok((stream, _)) = up_http_ws.accept().await {
                let hits = Arc::clone(&up_hits_srv);
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req: Request<Incoming>| {
                        let hits = Arc::clone(&hits);
                        async move {
                            let is_ws = req
                                .headers()
                                .get(http::header::UPGRADE)
                                .and_then(|v| v.to_str().ok())
                                .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
                            if is_ws {
                                let key = req
                                    .headers()
                                    .get("sec-websocket-key")
                                    .and_then(|v| v.to_str().ok())
                                    .unwrap_or("");
                                let accept =
                                    tokio_tungstenite::tungstenite::handshake::derive_accept_key(
                                        key.as_bytes(),
                                    );
                                tokio::spawn(async move {
                                    if let Ok(up) = hyper::upgrade::on(req).await {
                                        let mut ws = WebSocketStream::from_raw_socket(
                                            TokioIo::new(up),
                                            Role::Server,
                                            None,
                                        )
                                        .await;
                                        while let Some(Ok(msg)) = ws.next().await {
                                            if msg.is_close() {
                                                break;
                                            }
                                            if ws.send(msg).await.is_err() {
                                                break;
                                            }
                                        }
                                    }
                                });
                                return Ok::<_, Infallible>(
                                    Response::builder()
                                        .status(StatusCode::SWITCHING_PROTOCOLS)
                                        .header(http::header::CONNECTION, "Upgrade")
                                        .header(http::header::UPGRADE, "websocket")
                                        .header("Sec-WebSocket-Accept", accept)
                                        .body(Full::new(Bytes::new()))
                                        .unwrap(),
                                );
                            }
                            hits.fetch_add(1, Ordering::Relaxed);
                            Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"ok"))))
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, svc)
                        .await;
                });
            }
        });

        let (controller, _rules, filters, store, tmp_dir) = make_stage44_controller("conc01");
        controller.set_drain_deadline_for_test(Duration::from_millis(450));

        // 1. CONC-01 Graceful Drain via stop()
        let status = controller.start("127.0.0.1".into(), 0).await.unwrap();
        let port1 = status.port;

        let mut ws = open_proxied_ws(port1, &format!("ws://{up_addr}/ws-drain")).await;
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            "before-drain".into(),
        ))
        .await
        .unwrap();
        let reply1 = ws.next().await.unwrap().unwrap();
        assert_eq!(reply1.to_text().unwrap(), "before-drain");
        tokio::time::sleep(Duration::from_millis(40)).await;
        let ws_session_id = store
            .list_summaries()
            .into_iter()
            .find(|s| s.path.contains("/ws-drain"))
            .unwrap()
            .id;
        let frames_before_drain = store.get(ws_session_id).unwrap().websocket_frames.len();
        assert!(frames_before_drain >= 2);

        // Open HTTP/1.1 keep-alive connection and finish one request before stop()
        let mut keepalive_sock = TcpStream::connect(("127.0.0.1", port1)).await.unwrap();
        keepalive_sock
            .write_all(
                format!("GET http://{up_addr}/ka1 HTTP/1.1\r\nHost: {up_addr}\r\n\r\n").as_bytes(),
            )
            .await
            .unwrap();
        let (_h1, b1) = read_raw_http_head_and_body(&mut keepalive_sock).await;
        assert_eq!(b1, b"ok");
        let hits_before_stop = up_hits.load(Ordering::Relaxed);

        controller.stop().await;

        // Listener socket must be released immediately after stop() (avoids Windows ~2s connect SYN-retry eating the 450ms drain window)
        let probe_listener = TcpListener::bind(("127.0.0.1", port1))
            .await
            .expect("listener must be closed after stop()");
        drop(probe_listener);

        // Keep-alive follow-up request during drain receives 503 (or closes) and never reaches upstream
        if keepalive_sock
            .write_all(
                format!("GET http://{up_addr}/ka2 HTTP/1.1\r\nHost: {up_addr}\r\n\r\n").as_bytes(),
            )
            .await
            .is_ok()
        {
            let mut ka2_buf = [0u8; 512];
            if let Ok(n_ka2) = keepalive_sock.read(&mut ka2_buf).await {
                if n_ka2 > 0 {
                    let ka2_str = String::from_utf8_lossy(&ka2_buf[..n_ka2]);
                    assert!(
                        ka2_str.starts_with("HTTP/1.1 503"),
                        "expected 503 during drain, got: {ka2_str}"
                    );
                }
            }
        }
        assert_eq!(up_hits.load(Ordering::Relaxed), hits_before_stop);

        // Live WebSocket keeps relaying frames during drain window WITHOUT recording into TrafficStore
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            "during-drain".into(),
        ))
        .await
        .unwrap();
        let reply2 = ws.next().await.unwrap().unwrap();
        assert_eq!(reply2.to_text().unwrap(), "during-drain");
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            store.get(ws_session_id).unwrap().websocket_frames.len(),
            frames_before_drain,
            "TrafficStore capture must be suppressed during graceful drain"
        );

        // Wait for 450 ms drain deadline -> WS must close
        let ws_closed_on_deadline = tokio::time::timeout(Duration::from_millis(1000), async {
            loop {
                match ws.next().await {
                    None | Some(Err(_)) => break,
                    Some(Ok(_)) => continue,
                }
            }
        })
        .await;
        assert!(
            ws_closed_on_deadline.is_ok(),
            "live WebSocket should close after drain deadline expires"
        );

        // 2. CONC-01 Hard Abort (0 ms) on narrowing AllInterfaces -> Loopback, set_port, shutdown_sync
        let st_all = controller.start("0.0.0.0".into(), 0).await.unwrap();
        let mut ws_narrow = open_proxied_ws(st_all.port, &format!("ws://{up_addr}/ws-narrow")).await;
        let t_narrow = Instant::now();
        controller
            .set_bind_configuration(BindHostMode::Loopback, None, false)
            .await
            .unwrap();
        let closed_narrow = tokio::time::timeout(Duration::from_millis(250), async {
            while let Some(Ok(_)) = ws_narrow.next().await {}
        })
        .await;
        assert!(
            closed_narrow.is_ok() && t_narrow.elapsed() < Duration::from_millis(250),
            "narrowing bind change must hard-abort live WS in <250ms"
        );

        let spare_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let next_port = spare_listener.local_addr().unwrap().port();
        drop(spare_listener);

        let mut ws_setport = open_proxied_ws(st_all.port, &format!("ws://{up_addr}/ws-setport")).await;
        let t_setport = Instant::now();
        controller.set_port(next_port).await.unwrap();
        let closed_setport = tokio::time::timeout(Duration::from_millis(250), async {
            while let Some(Ok(_)) = ws_setport.next().await {}
        })
        .await;
        assert!(
            closed_setport.is_ok() && t_setport.elapsed() < Duration::from_millis(250),
            "set_port must hard-abort live WS in <250ms"
        );

        let mut ws_shutdown =
            open_proxied_ws(next_port, &format!("ws://{up_addr}/ws-shutdown")).await;
        let t_shutdown = Instant::now();
        controller.shutdown_sync();
        let closed_shutdown = tokio::time::timeout(Duration::from_millis(250), async {
            while let Some(Ok(_)) = ws_shutdown.next().await {}
        })
        .await;
        assert!(
            closed_shutdown.is_ok() && t_shutdown.elapsed() < Duration::from_millis(250),
            "shutdown_sync must hard-abort live WS in <250ms"
        );

        // 3. CONC-02 Live Policy Switch: Passthrough <-> MITM & LAN Client Allowlist removal (<250 ms)
        // 3a. Active Passthrough CONNECT tunnel aborts in <250 ms when filter flips TargetedOnly -> InterceptAll
        let echo_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_addr = echo_listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = echo_listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 512];
                    while let Ok(n) = s.read(&mut buf).await {
                        if n == 0 || s.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });

        filters.update_config(ProxyFilterBackendConfig {
            tls_intercept_mode: TlsInterceptMode::TargetedOnly,
            tls_target_rules: Vec::new(),
            ..crate::proxy::filters::default_backend_config()
        });
        let st_pt = controller.start("127.0.0.1".into(), 0).await.unwrap();
        let mut pt_sock = TcpStream::connect(("127.0.0.1", st_pt.port))
            .await
            .unwrap();
        pt_sock
            .write_all(
                format!("CONNECT {echo_addr} HTTP/1.1\r\nHost: {echo_addr}\r\n\r\n").as_bytes(),
            )
            .await
            .unwrap();
        let mut conn_ack = [0u8; 256];
        let n_ack = pt_sock.read(&mut conn_ack).await.unwrap();
        assert!(String::from_utf8_lossy(&conn_ack[..n_ack]).starts_with("HTTP/1.1 200"));
        pt_sock.write_all(b"ping").await.unwrap();
        let mut ping_buf = [0u8; 16];
        assert_eq!(pt_sock.read(&mut ping_buf).await.unwrap(), 4);

        let t_pt_flip = Instant::now();
        filters.update_config(ProxyFilterBackendConfig {
            tls_intercept_mode: TlsInterceptMode::InterceptAll,
            tls_bypass_enabled: false,
            tls_bypass_rules: Vec::new(),
            ..crate::proxy::filters::default_backend_config()
        });
        let closed_pt = tokio::time::timeout(Duration::from_millis(250), async {
            let mut sink = [0u8; 64];
            loop {
                match pt_sock.read(&mut sink).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => continue,
                }
            }
        })
        .await;
        assert!(
            closed_pt.is_ok() && t_pt_flip.elapsed() < Duration::from_millis(250),
            "active passthrough tunnel must abort <250ms when switching to InterceptAll"
        );

        // 3b. Active MITM TLS tunnel aborts in <250 ms when filter flips InterceptAll -> Passthrough
        let mut mitm_sock = TcpStream::connect(("127.0.0.1", st_pt.port))
            .await
            .unwrap();
        mitm_sock
            .write_all(b"CONNECT mitm-flip.test:443 HTTP/1.1\r\nHost: mitm-flip.test:443\r\n\r\n")
            .await
            .unwrap();
        let n_m_ack = mitm_sock.read(&mut conn_ack).await.unwrap();
        assert!(String::from_utf8_lossy(&conn_ack[..n_m_ack]).starts_with("HTTP/1.1 200"));
        let mut root_store = rustls::RootCertStore::empty();
        root_store
            .add(rustls::pki_types::CertificateDer::from(
                controller.context.ca.root_ca_der().to_vec(),
            ))
            .unwrap();
        let client_tls_cfg = Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth(),
        );
        let tls_conn = tokio_rustls::TlsConnector::from(client_tls_cfg);
        let mut mitm_tls = tls_conn
            .connect(
                rustls::pki_types::ServerName::try_from("mitm-flip.test").unwrap(),
                mitm_sock,
            )
            .await
            .unwrap();
        let t_mitm_flip = Instant::now();
        filters.update_config(ProxyFilterBackendConfig {
            tls_intercept_mode: TlsInterceptMode::InterceptAll,
            tls_bypass_enabled: true,
            tls_bypass_rules: vec![TlsBypassRule {
                id: "bypass-mitm-flip".into(),
                enabled: true,
                pattern: "mitm-flip.test".into(),
                category: "Test".into(),
                description: "Flip to Passthrough".into(),
            }],
            ..crate::proxy::filters::default_backend_config()
        });
        let closed_mitm = tokio::time::timeout(Duration::from_millis(250), async {
            let mut sink = [0u8; 64];
            loop {
                match mitm_tls.read(&mut sink).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => continue,
                }
            }
        })
        .await;
        assert!(
            closed_mitm.is_ok() && t_mitm_flip.elapsed() < Duration::from_millis(250),
            "active MITM TLS connection must abort <250ms when switching to Passthrough"
        );

        // 3c. LAN Client Allowlist removal aborts active non-loopback connection in <250 ms
        let remote_peer: SocketAddr = "192.168.50.77:55555".parse().unwrap();
        filters.update_config(ProxyFilterBackendConfig {
            lan_client_allowlist: vec!["192.168.50.77".into()],
            ..crate::proxy::filters::default_backend_config()
        });
        let srv_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let srv_addr = srv_listener.local_addr().unwrap();
        let sc_ctx = controller.context.clone();
        let lc_handle = ConnectionLifecycleHandle::new();
        let lc_child = lc_handle.lifecycle();
        tokio::spawn(async move {
            if let Ok((stream, _)) = srv_listener.accept().await {
                serve_connection(stream, remote_peer, Some(srv_addr.port()), lc_child, sc_ctx).await;
            }
        });
        let mut remote_client = TcpStream::connect(srv_addr).await.unwrap();
        let t_allow = Instant::now();
        filters.update_config(ProxyFilterBackendConfig {
            lan_client_allowlist: vec!["192.168.50.99".into()],
            ..crate::proxy::filters::default_backend_config()
        });
        let closed_allow = tokio::time::timeout(Duration::from_millis(250), async {
            let mut sink = [0u8; 64];
            loop {
                match remote_client.read(&mut sink).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => continue,
                }
            }
        })
        .await;
        assert!(
            closed_allow.is_ok() && t_allow.elapsed() < Duration::from_millis(250),
            "removing peer IP from lan_client_allowlist must hard-abort connection <250ms"
        );

        controller.shutdown_sync();
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}
