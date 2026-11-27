use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use dashmap::DashMap;
use http::Request;
use http_body_util::combinators::BoxBody;
use bytes::Bytes;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as AutoConnBuilder;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, watch, Mutex};

use crate::models::{
    BindHostMode, BreakpointAction, ProxyError, ProxyStatus, SessionSummary, StorageStats,
    UpstreamProxyConfig, WebSocketFrameRecord, WsInjectDirection, WsInjectOpcode,
};
use crate::proxy::breakpoints::BreakpointEngine;
use crate::proxy::ca::CertificateAuthority;
use crate::proxy::client_certs::ClientCertificateStore;
use crate::proxy::filters::ProxyFilterEngine;
use crate::proxy::hosts::HostRemapRegistry;
use crate::proxy::ipc_channels::{
    breakpoint_snapshot_channel, removed_ids_channel, session_event_channel,
    BreakpointSnapshotSender, RemovedIdsSender, SessionEventSender, DEFAULT_EVENT_CHANNEL_CAPACITY,
    DEFAULT_REMOVED_CHANNEL_CAPACITY,
};
use crate::proxy::process::resolve_client_process_async;
use crate::proxy::rules::RuleEngine;
use crate::proxy::sysproxy::{resolve_sysproxy_host_for_bind, SystemProxyManager};
use crate::proxy::throttle::ThrottleEngine;
use crate::proxy::upstream_client::{
    format_rfc3339_micros, shared_http1_tls_config, UpstreamHttpClient,
};
use crate::proxy::upstream_proxy::UpstreamProxyManager;
use crate::scripting::PythonScriptRunner;
use crate::storage::TrafficStore;


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
pub mod pipeline_stages;
pub mod websocket_relay;

pub use http_handler::parse_sse_events_from_bytes;
pub(super) use pipeline_stages::*;
pub type ProxyController = ProxyEngineController;

use connect_tunnel::handle_outer_proxy_request;
use websocket_relay::{
    parse_hex_payload, WsInjectCommand, MAX_WS_INJECT_PAYLOAD_BYTES,
};

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
    pub shared_http1_tls_config: Arc<rustls::ClientConfig>,
    pub client_certs: Arc<ClientCertificateStore>,
    pub script_runner: Arc<PythonScriptRunner>,
    pub active_ws_channels: Arc<DashMap<u64, mpsc::UnboundedSender<WsInjectCommand>>>,
    pub event_tx: SessionEventSender,
    pub removed_tx: RemovedIdsSender,
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
        let (event_tx, mut event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
        let (removed_tx, mut removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
        let (bp_tx, mut bp_rx) = breakpoint_snapshot_channel();
        let stats_dirty = Arc::new(AtomicBool::new(false));
        let ipc_stats_dirty = stats_dirty.clone();
        let ipc_app = app_handle.clone();

        let (stats_stop_tx, mut stats_stop_rx) = oneshot::channel::<()>();
        let stats_app = app_handle.clone();
        let stats_store = store.clone();
        let stats_filters = filters.clone();
        let stats_dirty_bg = stats_dirty.clone();

        // Dedicated background task for coalesced storage-stats computation so heavy SQLite queries
        // or VACUUM never stall the 60 FPS `summary_rx` IPC micro-batching loop (`PERF-05`).
        tauri::async_runtime::spawn(async move {
            let mut stats_ticker = tokio::time::interval(Duration::from_millis(500));
            stats_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = &mut stats_stop_rx => break,
                    _ = stats_ticker.tick() => {
                        if stats_dirty_bg.swap(false, Ordering::Relaxed) {
                            let app = stats_app.clone();
                            let store = stats_store.clone();
                            let filters = stats_filters.clone();
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

        // 60 FPS (16 ms) micro-batching IPC loop for sessions + zero-latency push for Live Breakpoints
        tauri::async_runtime::spawn(async move {
            let _stats_stop_guard = stats_stop_tx;
            let mut ticker = tokio::time::interval(Duration::from_millis(16));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut buffer: Vec<SessionSummary> = Vec::with_capacity(256);
            let mut bp_closed = false;
            let mut removed_closed = false;

            loop {
                tokio::select! {
                    maybe_bp = bp_rx.recv(), if !bp_closed => {
                        match maybe_bp {
                            Some(snapshot) => {
                                let _ = ipc_app.emit("proxy://breakpoints-changed", snapshot);
                            }
                            None => bp_closed = true,
                        }
                    }
                    maybe_removed = removed_rx.recv(), if !removed_closed => {
                        match maybe_removed {
                            Some(removed_ids) => {
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
                            None => removed_closed = true,
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
        let (event_tx, mut event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
        let (removed_tx, mut removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
        let (bp_tx, mut bp_rx) = breakpoint_snapshot_channel();

        tokio::spawn(async move {
            let mut bp_closed = false;
            let mut removed_closed = false;
            loop {
                tokio::select! {
                    maybe_bp = bp_rx.recv(), if !bp_closed => {
                        if maybe_bp.is_none() {
                            bp_closed = true;
                            if event_rx.is_closed() && removed_rx.is_closed() {
                                break;
                            }
                        }
                    }
                    maybe_removed = removed_rx.recv(), if !removed_closed => {
                        if maybe_removed.is_none() {
                            removed_closed = true;
                            if event_rx.is_closed() && bp_rx.is_closed() {
                                break;
                            }
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
        event_tx: SessionEventSender,
        removed_tx: RemovedIdsSender,
        bp_tx: BreakpointSnapshotSender,
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

        let shared_http1_tls_config = shared_http1_tls_config().map_err(ProxyError::Custom)?;

        let breakpoints = Arc::new(BreakpointEngine::new_with_store(
            Some(bp_tx),
            Some(Arc::clone(&store)),
        ));
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
            shared_http1_tls_config,
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

    pub fn save_persisted_proxy_port(&self, port: u16) {
        self.sysproxy.save_proxy_port_pref(port);
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
    let parsed = url::Url::parse(&format!("http://{bracketed}/")).ok()?;
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
    if let Ok(parsed) = url::Url::parse(full_url) {
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
mod tests;
