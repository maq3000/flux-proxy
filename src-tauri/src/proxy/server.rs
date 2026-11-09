use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::Bytes;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use http::header::{CONTENT_TYPE, HOST, UPGRADE};
use http::{Method, Request, Response, StatusCode, Version};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as AutoConnBuilder;
use tauri::{AppHandle, Emitter};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, Mutex};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::WebSocketStream;

use crate::models::{
    BreakpointAction, BreakpointStage, ComposedRequest, HeaderMutationDirection, HeaderPair,
    PausedBreakpointItem, ProxyError, ProxyStatus, RuleActionType, SessionDetail, SessionSummary,
    SseEventRecord, WebSocketFrameRecord,
};
use crate::proxy::breakpoints::BreakpointEngine;
use crate::proxy::ca::CertificateAuthority;
use crate::proxy::filters::{
    is_alt_svc_header, ConnectTunnelDecision, PassthroughReason, ProxyFilterEngine,
};
use crate::proxy::network::{is_host_own_ip, normalize_client_ip};
use crate::proxy::process::{resolve_client_process, ClientProcessInfo};
use crate::proxy::rules::RuleEngine;
use crate::proxy::sysproxy::SystemProxyManager;
use crate::storage::TrafficStore;

const MAX_CAPTURED_BODY_BYTES: usize = 8 * 1024 * 1024; // 8 MiB safety cap per body
type ProxyBoxBody = BoxBody<Bytes, Infallible>;

pub struct SharedProxyContext {
    pub ca: Arc<CertificateAuthority>,
    pub rules: Arc<RuleEngine>,
    pub filters: Arc<ProxyFilterEngine>,
    pub breakpoints: Arc<BreakpointEngine>,
    pub store: Arc<TrafficStore>,
    pub upstream_client: reqwest::Client,
    pub event_tx: mpsc::UnboundedSender<SessionSummary>,
    pub active_port: AtomicU16,
}

struct ControllerRuntimeState {
    bind_addr: (String, u16),
    shutdown_tx: Option<watch::Sender<bool>>,
    auto_system_proxy: bool,
    allow_remote: bool,
}

pub struct ProxyEngineController {
    pub context: Arc<SharedProxyContext>,
    pub sysproxy: Arc<SystemProxyManager>,
    op_lock: Mutex<()>,
    runtime_state: std::sync::Mutex<ControllerRuntimeState>,
}

impl ProxyEngineController {
    pub fn new(
        ca: Arc<CertificateAuthority>,
        rules: Arc<RuleEngine>,
        filters: Arc<ProxyFilterEngine>,
        store: Arc<TrafficStore>,
        sysproxy: Arc<SystemProxyManager>,
        app_handle: AppHandle,
    ) -> Result<Self, ProxyError> {
        // CRITICAL: `.no_proxy()` prevents infinite recursion when OS system proxy points to us!
        let upstream_client = reqwest::Client::builder()
            .no_proxy()
            .pool_idle_timeout(Duration::from_secs(90))
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<SessionSummary>();
        let (bp_tx, mut bp_rx) = mpsc::unbounded_channel::<Vec<PausedBreakpointItem>>();
        let breakpoints = Arc::new(BreakpointEngine::new(Some(bp_tx)));

        // 60 FPS (16 ms) micro-batching IPC loop for sessions + zero-latency push for Live Breakpoints
        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(16));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut buffer: Vec<SessionSummary> = Vec::with_capacity(256);

            loop {
                tokio::select! {
                    maybe_bp = bp_rx.recv() => {
                        if let Some(snapshot) = maybe_bp {
                            let _ = app_handle.emit("proxy://breakpoints-changed", snapshot);
                        }
                    }
                    maybe_item = event_rx.recv() => {
                        match maybe_item {
                            Some(item) => {
                                buffer.push(item);
                                if buffer.len() >= 250 {
                                    let batch = std::mem::take(&mut buffer);
                                    let _ = app_handle.emit("proxy://sessions-batch", batch);
                                }
                            }
                            None => break,
                        }
                    }
                    _ = ticker.tick() => {
                        if !buffer.is_empty() {
                            let batch = std::mem::take(&mut buffer);
                            let _ = app_handle.emit("proxy://sessions-batch", batch);
                        }
                    }
                }
            }
        });

        let context = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            store,
            upstream_client,
            event_tx,
            active_port: AtomicU16::new(8888),
        });

        let initial_auto = sysproxy.load_auto_system_proxy_pref();
        let initial_allow_remote = sysproxy.load_allow_remote_pref();
        if !initial_auto {
            sysproxy.rollback_if_dirty();
        }
        let initial_bind_host = if initial_allow_remote {
            "0.0.0.0".to_string()
        } else {
            "127.0.0.1".to_string()
        };

        Ok(Self {
            context,
            sysproxy,
            op_lock: Mutex::new(()),
            runtime_state: std::sync::Mutex::new(ControllerRuntimeState {
                bind_addr: (initial_bind_host, 8888),
                shutdown_tx: None,
                auto_system_proxy: initial_auto,
                allow_remote: initial_allow_remote,
            }),
        })
    }

    pub fn preferred_bind_host(&self) -> String {
        if self.lock_runtime().allow_remote {
            "0.0.0.0".to_string()
        } else {
            "127.0.0.1".to_string()
        }
    }

    fn lock_runtime(&self) -> std::sync::MutexGuard<'_, ControllerRuntimeState> {
        match self.runtime_state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn build_status(&self) -> ProxyStatus {
        let (running, bind_addr, port, auto_system_proxy, allow_remote) = {
            let guard = self.lock_runtime();
            (
                guard.shutdown_tx.is_some(),
                guard.bind_addr.0.clone(),
                guard.bind_addr.1,
                guard.auto_system_proxy,
                guard.allow_remote || guard.bind_addr.0 == "0.0.0.0" || guard.bind_addr.0 == "::",
            )
        };
        let (system_proxy_enabled, system_proxy_error) =
            self.sysproxy.status_for_listener(&bind_addr, port);

        ProxyStatus {
            running,
            bind_addr,
            port,
            active_sessions: self.context.store.len(),
            system_proxy_enabled,
            auto_system_proxy,
            system_proxy_error,
            allow_remote,
        }
    }

    pub async fn status(&self) -> ProxyStatus {
        self.build_status()
    }

    fn spawn_accept_loop(
        &self,
        listener: TcpListener,
        addr_str: String,
        actual_port: u16,
        mut rx: watch::Receiver<bool>,
    ) {
        self.context.active_port.store(actual_port, Ordering::Relaxed);
        let ctx = self.context.clone();
        tauri::async_runtime::spawn(async move {
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
                                let local_proxy_port = tcp_stream.local_addr().ok().map(|a| a.port()).or(Some(actual_port));
                                tokio::spawn(async move {
                                    // Resolve owning local OS process (PID + executable name) once per TCP socket
                                    let client_proc = resolve_client_process(client_addr, local_proxy_port);
                                    let io = TokioIo::new(tcp_stream);
                                    let service = service_fn(move |req: Request<Incoming>| {
                                        let req_ctx = conn_ctx.clone();
                                        let proc_info = client_proc.clone();
                                        async move {
                                            Ok::<_, Infallible>(
                                                handle_outer_proxy_request(req, client_addr, proc_info, req_ctx).await
                                            )
                                        }
                                    });

                                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                                        .serve_connection_with_upgrades(io, service)
                                        .await;
                                });
                            }
                            Err(err) => {
                                tracing::warn!("TCP accept error: {err}");
                            }
                        }
                    }
                }
            }
        });
    }

    pub async fn start(&self, host: String, port: u16) -> Result<ProxyStatus, ProxyError> {
        let _op = self.op_lock.lock().await;

        let (already_running, auto_system_proxy) = {
            let guard = self.lock_runtime();
            (guard.shutdown_tx.is_some(), guard.auto_system_proxy)
        };
        if already_running {
            return Ok(self.build_status());
        }

        let addr_str = format!("{host}:{port}");
        let listener = match TcpListener::bind(&addr_str).await {
            Ok(l) => l,
            Err(err) => {
                self.sysproxy.rollback_if_dirty();
                return Err(ProxyError::Io(err));
            }
        };
        let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
        let (tx, rx) = watch::channel(false);

        {
            let mut guard = self.lock_runtime();
            guard.bind_addr = (host.clone(), actual_port);
            guard.allow_remote = host == "0.0.0.0" || host == "::";
            guard.shutdown_tx = Some(tx);
        }

        self.spawn_accept_loop(listener, addr_str, actual_port, rx);

        if auto_system_proxy {
            // `enable` normalizes `0.0.0.0` / `::` to `127.0.0.1:{actual_port}` automatically
            if let Err(err) = self.sysproxy.enable(&host, actual_port) {
                tracing::warn!(
                    "FluxProxy bound {host}:{actual_port}, but OS system proxy setup failed: {err}"
                );
            }
        } else {
            self.sysproxy.rollback_if_dirty();
        }

        Ok(self.build_status())
    }

    /// Toggles «Allow remote connections / Listen on all network interfaces (`0.0.0.0`)» for
    /// intercepting iOS & Android traffic over Wi-Fi/LAN, seamlessly rebinding the active TCP listener
    /// without interrupting the local OS system proxy configuration.
    pub async fn set_allow_remote(&self, allow: bool) -> Result<ProxyStatus, ProxyError> {
        let _op = self.op_lock.lock().await;
        let desired_host = if allow {
            "0.0.0.0".to_string()
        } else {
            "127.0.0.1".to_string()
        };

        let (was_running, prev_host, port) = {
            let mut guard = self.lock_runtime();
            let running = guard.shutdown_tx.is_some();
            let prev = guard.bind_addr.0.clone();
            let p = guard.bind_addr.1;
            guard.allow_remote = allow;
            if !running {
                guard.bind_addr.0 = desired_host.clone();
            }
            (running, prev, p)
        };
        self.sysproxy.save_allow_remote_pref(allow);

        if !was_running || prev_host == desired_host {
            return Ok(self.build_status());
        }

        // Stop previous TCP listener so we can rebind the same port on the new interface
        {
            let mut guard = self.lock_runtime();
            if let Some(tx) = guard.shutdown_tx.take() {
                let _ = tx.send(true);
            }
        }

        let target_addr = format!("{desired_host}:{port}");
        let mut bind_result = None;
        for attempt in 0..5 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(30)).await;
            } else {
                tokio::task::yield_now().await;
            }
            match TcpListener::bind(&target_addr).await {
                Ok(l) => {
                    bind_result = Some(Ok(l));
                    break;
                }
                Err(e) => {
                    bind_result = Some(Err(e));
                }
            }
        }

        match bind_result.unwrap() {
            Ok(listener) => {
                let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
                let (tx, rx) = watch::channel(false);
                {
                    let mut guard = self.lock_runtime();
                    guard.bind_addr = (desired_host.clone(), actual_port);
                    guard.allow_remote = allow;
                    guard.shutdown_tx = Some(tx);
                }
                self.spawn_accept_loop(listener, target_addr, actual_port, rx);
                Ok(self.build_status())
            }
            Err(err) => {
                // Attempt best-effort recovery onto previous host so capture isn't stranded
                let fallback_addr = format!("{prev_host}:{port}");
                if let Ok(fallback_listener) = TcpListener::bind(&fallback_addr).await {
                    let (tx, rx) = watch::channel(false);
                    {
                        let mut guard = self.lock_runtime();
                        guard.bind_addr = (prev_host.clone(), port);
                        guard.allow_remote = prev_host == "0.0.0.0" || prev_host == "::";
                        guard.shutdown_tx = Some(tx);
                    }
                    self.sysproxy.save_allow_remote_pref(!allow);
                    self.spawn_accept_loop(fallback_listener, fallback_addr, port, rx);
                }
                Err(ProxyError::Io(err))
            }
        }
    }

    pub async fn stop(&self) -> ProxyStatus {
        let _op = self.op_lock.lock().await;
        self.context
            .breakpoints
            .resume_all(BreakpointAction::Continue);
        {
            let mut guard = self.lock_runtime();
            if let Some(tx) = guard.shutdown_tx.take() {
                let _ = tx.send(true);
            }
        }
        if let Err(err) = self.sysproxy.disable() {
            tracing::warn!("Could not roll back OS system proxy on stop: {err}");
        }
        self.build_status()
    }

    /// Manually enables or disables the OS system proxy independently of the local TCP listener
    /// (allowing `HTTP_PROXY=http://127.0.0.1:8888` CLI-only capture without routing OS browsers).
    pub async fn set_system_proxy(&self, enabled: bool) -> Result<ProxyStatus, ProxyError> {
        let _op = self.op_lock.lock().await;
        let (bind_host, port) = self.lock_runtime().bind_addr.clone();

        if enabled {
            if let Err(err) = self.sysproxy.enable(&bind_host, port) {
                tracing::warn!("Manual set_system_proxy(true) failed: {err}");
            }
        } else if let Err(err) = self.sysproxy.disable() {
            tracing::warn!("Manual set_system_proxy(false) failed: {err}");
        }

        Ok(self.build_status())
    }

    /// Toggles Fiddler-style «Act as System Proxy» mode when capture starts/stops.
    pub async fn set_auto_system_proxy(&self, auto: bool) -> Result<ProxyStatus, ProxyError> {
        let _op = self.op_lock.lock().await;
        let (running, bind_host, port) = {
            let mut guard = self.lock_runtime();
            guard.auto_system_proxy = auto;
            (
                guard.shutdown_tx.is_some(),
                guard.bind_addr.0.clone(),
                guard.bind_addr.1,
            )
        };
        self.sysproxy.save_auto_system_proxy_pref(auto);

        if auto && running {
            let (currently_enabled, _) = self.sysproxy.status_for_listener(&bind_host, port);
            if !currently_enabled {
                if let Err(err) = self.sysproxy.enable(&bind_host, port) {
                    tracing::warn!("Auto system proxy attach failed: {err}");
                }
            }
        }

        Ok(self.build_status())
    }

    /// Synchronous, deadlock-free shutdown + OS proxy rollback invoked on window close and app exit.
    pub fn shutdown_sync(&self) {
        self.context
            .breakpoints
            .resume_all(BreakpointAction::Continue);
        {
            let mut guard = self.lock_runtime();
            if let Some(tx) = guard.shutdown_tx.take() {
                let _ = tx.send(true);
            }
        }
        self.sysproxy.rollback_sync();
    }

    /// Executes a request crafted in the Composer tab and records it into the Traffic Viewer.
    pub async fn execute_composed(&self, composed: ComposedRequest) -> Result<SessionDetail, ProxyError> {
        let start = Instant::now();
        let timestamp = Utc::now().to_rfc3339();
        let session_id = self.context.store.allocate_id();
        let self_pid = std::process::id();

        let mut method_str = composed.method;
        let mut full_url = composed.url;
        let mut req_headers = composed.headers;
        let mut req_bytes = composed.body.into_bytes();
        let mut bp_modified = false;

        let parsed_initial = reqwest::Url::parse(&full_url)
            .map_err(|e| ProxyError::Custom(format!("Invalid URL '{full_url}': {e}")))?;
        let mut scheme = parsed_initial.scheme().to_string();
        let mut host = parsed_initial.host_str().unwrap_or("unknown").to_string();
        let mut path = match parsed_initial.query() {
            Some(q) => format!("{}?{}", parsed_initial.path(), q),
            None => parsed_initial.path().to_string(),
        };

        let req_mutated = self.context.filters.apply_header_mutations(
            HeaderMutationDirection::Request,
            &full_url,
            &mut req_headers,
        );

        // Live Breakpoint: Before Request (F11 / `bpu`)
        if self
            .context
            .breakpoints
            .should_break(BreakpointStage::Request, &method_str, &full_url)
        {
            let bp_id = format!("bp-req-{session_id}");
            let capped_req = &req_bytes[..req_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
            let req_b64 = base64::engine::general_purpose::STANDARD.encode(capped_req);
            let req_txt = std::str::from_utf8(capped_req).ok().map(str::to_owned);

            let paused_summary = SessionSummary {
                id: session_id,
                status: 0,
                protocol: if scheme == "https" { "HTTPS/2".into() } else { "HTTP/1.1".into() },
                scheme: scheme.clone(),
                method: method_str.clone(),
                host: host.clone(),
                path: path.clone(),
                url: full_url.clone(),
                content_type: "pending/breakpoint-request".into(),
                body_size: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                timestamp: timestamp.clone(),
                is_mocked: false,
                matched_rule_id: None,
                error: None,
                process_name: Some("flux-proxy (Composer)".into()),
                process_pid: Some(self_pid),
                tls_bypassed: false,
                headers_mutated: req_mutated,
                breakpoint_paused: Some("request".into()),
                breakpoint_modified: false,
                comment: None,
                marked_color: None,
                client_ip: Some("127.0.0.1".into()),
            };
            self.context.store.insert(SessionDetail {
                summary: paused_summary.clone(),
                request_headers: req_headers.clone(),
                response_headers: Vec::new(),
                request_body_base64: req_b64.clone(),
                response_body_base64: String::new(),
                request_body_text: req_txt.clone(),
                response_body_text: None,
                tls_version: None,
                client_addr: "Composer (Local)".into(),
                websocket_frames: Vec::new(),
                sse_events: Vec::new(),
            });
            let _ = self.context.event_tx.send(paused_summary);

            let (rx, timeout_secs) = self.context.breakpoints.park(PausedBreakpointItem {
                breakpoint_id: bp_id.clone(),
                session_id,
                stage: BreakpointStage::Request,
                created_at: Utc::now().to_rfc3339(),
                timeout_secs: 120,
                scheme: scheme.clone(),
                method: method_str.clone(),
                url: full_url.clone(),
                host: host.clone(),
                path: path.clone(),
                request_headers: req_headers.clone(),
                request_body_base64: req_b64,
                request_body_text: req_txt,
                response_status: None,
                response_headers: Vec::new(),
                response_body_base64: String::new(),
                response_body_text: None,
                process_name: Some("flux-proxy (Composer)".into()),
                process_pid: Some(self_pid),
            });

            match tokio::time::timeout(Duration::from_secs(timeout_secs), rx).await {
                Ok(Ok(verdict)) => {
                    if verdict.action == BreakpointAction::Abort {
                        return Err(ProxyError::Custom(
                            "Request aborted at Live Breakpoint".into(),
                        ));
                    }
                    apply_request_breakpoint_edits(
                        &verdict,
                        &mut method_str,
                        &mut full_url,
                        &mut scheme,
                        &mut host,
                        &mut path,
                        &mut req_headers,
                        &mut bp_modified,
                    );
                    if let Some(ref txt) = verdict.request_body_text {
                        let new_b = txt.as_bytes().to_vec();
                        if new_b != req_bytes {
                            req_bytes = new_b;
                            bp_modified = true;
                        }
                    } else if let Some(ref b64) = verdict.request_body_base64 {
                        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                            if decoded != req_bytes {
                                req_bytes = decoded;
                                bp_modified = true;
                            }
                        }
                    }
                }
                _ => {
                    self.context.breakpoints.remove_expired(&bp_id);
                }
            }
        }

        let parsed_url = reqwest::Url::parse(&full_url)
            .map_err(|e| ProxyError::Custom(format!("Invalid URL '{full_url}': {e}")))?;
        let method = reqwest::Method::from_bytes(method_str.as_bytes())
            .map_err(|e| ProxyError::Custom(format!("Invalid HTTP method: {e}")))?;

        // Check AutoResponder rules for composed requests too
        if let Some(rule) =
            self.context
                .rules
                .find_matching_rule(&method_str, &full_url, &req_headers)
        {
            if rule.latency_ms > 0 {
                tokio::time::sleep(Duration::from_millis(rule.latency_ms)).await;
            }
            if matches!(rule.action, RuleActionType::MockResponse) {
                let mut mock_resp_headers = rule.response_headers.clone();
                let resp_mutated = self.context.filters.apply_header_mutations(
                    HeaderMutationDirection::Response,
                    &full_url,
                    &mut mock_resp_headers,
                );
                let resp_bytes = rule.response_body.as_bytes();
                let content_type = mock_resp_headers
                    .iter()
                    .find(|h| h.name.eq_ignore_ascii_case("content-type"))
                    .map(|h| h.value.clone())
                    .unwrap_or_else(|| "application/json; charset=utf-8".to_string());

                let sse_events = if content_type.to_ascii_lowercase().starts_with("text/event-stream") {
                    parse_sse_events_from_bytes(resp_bytes, start.elapsed().as_millis() as u64)
                } else {
                    Vec::new()
                };

                let summary = SessionSummary {
                    id: session_id,
                    status: rule.status_code,
                    protocol: if scheme == "https" { "HTTPS/2".into() } else { "HTTP/1.1".into() },
                    scheme,
                    method: method_str,
                    host,
                    path,
                    url: full_url,
                    content_type,
                    body_size: resp_bytes.len(),
                    duration_ms: start.elapsed().as_millis() as u64,
                    timestamp,
                    is_mocked: true,
                    matched_rule_id: Some(rule.id.clone()),
                    error: None,
                    process_name: Some("flux-proxy (Composer)".into()),
                    process_pid: Some(self_pid),
                    tls_bypassed: false,
                    headers_mutated: req_mutated || resp_mutated,
                    breakpoint_paused: None,
                    breakpoint_modified: bp_modified,
                    comment: None,
                    marked_color: None,
                    client_ip: Some("127.0.0.1".into()),
                };

                let detail = SessionDetail {
                    summary: summary.clone(),
                    request_headers: req_headers,
                    response_headers: mock_resp_headers,
                    request_body_base64: base64::engine::general_purpose::STANDARD.encode(&req_bytes),
                    response_body_base64: base64::engine::general_purpose::STANDARD.encode(resp_bytes),
                    request_body_text: std::str::from_utf8(&req_bytes).ok().map(str::to_owned),
                    response_body_text: Some(rule.response_body),
                    tls_version: Some("AutoResponder Mock".into()),
                    client_addr: "Composer (Local)".into(),
                    websocket_frames: Vec::new(),
                    sse_events,
                };

                self.context.store.insert(detail.clone());
                let _ = self.context.event_tx.send(summary);
                return Ok(detail);
            }
        }

        let client = if composed.follow_redirects {
            reqwest::Client::builder().no_proxy().build()?
        } else {
            self.context.upstream_client.clone()
        };

        let mut builder = client.request(method, parsed_url);
        for h in &req_headers {
            if !h.name.trim().is_empty() && !h.name.eq_ignore_ascii_case("content-length") {
                builder = builder.header(&h.name, &h.value);
            }
        }
        if !req_bytes.is_empty() {
            builder = builder.body(req_bytes.clone());
        }

        let upstream_resp = builder.send().await?;
        let mut status = upstream_resp.status().as_u16();
        let version_str = format_http_version(&scheme, upstream_resp.version());
        let mut resp_headers = extract_reqwest_headers(upstream_resp.headers());
        let mut resp_mutated = self.context.filters.apply_header_mutations(
            HeaderMutationDirection::Response,
            &full_url,
            &mut resp_headers,
        );
        let mut resp_bytes = upstream_resp.bytes().await?.to_vec();

        // Live Breakpoint: After Response (Alt+F11 / `bpafter`)
        if self
            .context
            .breakpoints
            .should_break(BreakpointStage::Response, &method_str, &full_url)
        {
            let bp_id = format!("bp-resp-{session_id}");
            let capped_req = &req_bytes[..req_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
            let capped_resp = &resp_bytes[..resp_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
            let req_b64 = base64::engine::general_purpose::STANDARD.encode(capped_req);
            let resp_b64 = base64::engine::general_purpose::STANDARD.encode(capped_resp);
            let req_txt = std::str::from_utf8(capped_req).ok().map(str::to_owned);
            let resp_txt = std::str::from_utf8(capped_resp).ok().map(str::to_owned);

            let (rx, timeout_secs) = self.context.breakpoints.park(PausedBreakpointItem {
                breakpoint_id: bp_id.clone(),
                session_id,
                stage: BreakpointStage::Response,
                created_at: Utc::now().to_rfc3339(),
                timeout_secs: 120,
                scheme: scheme.clone(),
                method: method_str.clone(),
                url: full_url.clone(),
                host: host.clone(),
                path: path.clone(),
                request_headers: req_headers.clone(),
                request_body_base64: req_b64,
                request_body_text: req_txt,
                response_status: Some(status),
                response_headers: resp_headers.clone(),
                response_body_base64: resp_b64,
                response_body_text: resp_txt,
                process_name: Some("flux-proxy (Composer)".into()),
                process_pid: Some(self_pid),
            });

            match tokio::time::timeout(Duration::from_secs(timeout_secs), rx).await {
                Ok(Ok(verdict)) => {
                    if verdict.action == BreakpointAction::Abort {
                        return Err(ProxyError::Custom(
                            "Response aborted at Live Breakpoint".into(),
                        ));
                    }
                    if let Some(sc) = verdict.status_code {
                        if sc != status {
                            status = sc;
                            bp_modified = true;
                        }
                    }
                    if let Some(hdrs) = verdict.response_headers {
                        resp_headers = hdrs;
                        if self.context.filters.strip_alt_svc_headers(&mut resp_headers) {
                            resp_mutated = true;
                        }
                        bp_modified = true;
                    }
                    if let Some(txt) = verdict.response_body_text {
                        resp_bytes = txt.into_bytes();
                        bp_modified = true;
                    } else if let Some(b64) = verdict.response_body_base64 {
                        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                            resp_bytes = decoded;
                            bp_modified = true;
                        }
                    }
                }
                _ => {
                    self.context.breakpoints.remove_expired(&bp_id);
                }
            }
        }

        let content_type = resp_headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("content-type"))
            .map(|h| h.value.clone())
            .unwrap_or_else(|| "text/plain".to_string());
        let sse_events = if content_type.to_ascii_lowercase().starts_with("text/event-stream") {
            parse_sse_events_from_bytes(&resp_bytes, start.elapsed().as_millis() as u64)
        } else {
            Vec::new()
        };
        let duration_ms = start.elapsed().as_millis() as u64;

        let summary = SessionSummary {
            id: session_id,
            status,
            protocol: version_str,
            scheme: scheme.clone(),
            method: method_str,
            host,
            path,
            url: full_url,
            content_type,
            body_size: resp_bytes.len(),
            duration_ms,
            timestamp,
            is_mocked: false,
            matched_rule_id: None,
            error: None,
            process_name: Some("flux-proxy (Composer)".into()),
            process_pid: Some(self_pid),
            tls_bypassed: false,
            headers_mutated: req_mutated || resp_mutated,
            breakpoint_paused: None,
            breakpoint_modified: bp_modified,
            comment: None,
            marked_color: None,
            client_ip: Some("127.0.0.1".into()),
        };

        let capped_resp = &resp_bytes[..resp_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
        let detail = SessionDetail {
            summary: summary.clone(),
            request_headers: req_headers,
            response_headers: resp_headers,
            request_body_base64: base64::engine::general_purpose::STANDARD.encode(&req_bytes),
            response_body_base64: base64::engine::general_purpose::STANDARD.encode(capped_resp),
            request_body_text: std::str::from_utf8(&req_bytes).ok().map(str::to_owned),
            response_body_text: std::str::from_utf8(capped_resp).ok().map(str::to_owned),
            tls_version: if scheme == "https" {
                Some("TLS 1.3".into())
            } else {
                None
            },
            client_addr: "Composer (Local)".into(),
            websocket_frames: Vec::new(),
            sse_events,
        };

        self.context.store.insert(detail.clone());
        let _ = self.context.event_tx.send(summary);
        Ok(detail)
    }
}

/// Entry handler for outer proxy TCP connections:
/// - `Method::CONNECT`: Either relays raw encrypted bytes directly via `tokio::io::copy_bidirectional`
///   when matched by the TLS/MITM Bypass list (Certificate Pinning passthrough), or negotiates an
///   on-the-fly MITM TLS tunnel (HTTP/2 + HTTP/1.1 + WSS).
/// - Plain HTTP / WS: Directly intercepts and forwards.
async fn handle_outer_proxy_request(
    req: Request<Incoming>,
    client_addr: SocketAddr,
    client_proc: Option<ClientProcessInfo>,
    ctx: Arc<SharedProxyContext>,
) -> Response<ProxyBoxBody> {
    if req.method() == Method::CONNECT {
        let authority = match req.uri().authority() {
            Some(auth) => auth.to_string(),
            None => {
                return plain_response(
                    StatusCode::BAD_REQUEST,
                    "CONNECT request missing authority host:port",
                );
            }
        };

        let (host, port) = split_authority(&authority);

        // Selective MITM Pass-Through:
        // - Mode 1 (`InterceptAll`): passthrough if matched by `tls_bypass_rules`
        // - Mode 2 (`TargetedOnly`): pure TCP passthrough (`copy_bidirectional`) for EVERYTHING except `tls_target_rules`
        if let ConnectTunnelDecision::Passthrough(reason) =
            ctx.filters.evaluate_connect_tunnel(&host, port)
        {
            let start = Instant::now();
            let timestamp = Utc::now().to_rfc3339();
            let session_id = ctx.store.allocate_id();
            let connect_headers = extract_hyper_headers(req.headers());
            let target_url = format!("https://{authority}/");
            let tunnel_path = format!("Tunnel to {host}:{port}");

            let mut upstream_tcp = match TcpStream::connect((host.as_str(), port)).await {
                Ok(stream) => stream,
                Err(err) => {
                    return record_and_return_error(
                        &ctx,
                        session_id,
                        "https",
                        "CONNECT",
                        &host,
                        &tunnel_path,
                        &target_url,
                        connect_headers,
                        Bytes::new(),
                        start,
                        timestamp,
                        client_addr,
                        client_proc.as_ref(),
                        true,
                        false,
                        format!("TLS Passthrough TCP connect failed for {host}:{port}: {err}"),
                    );
                }
            };

            let (protocol_label, passthrough_note, mode_header_val, tls_version_label) =
                match &reason {
                    PassthroughReason::BypassRule(bypass_rule) => (
                        "TLS-BYPASS".to_string(),
                        format!(
                            "[TLS / MITM Passthrough Tunnel Active]\n\
                             Host: {host}:{port}\n\
                             Matched Bypass Rule: {} ({})\n\
                             Relay Mode: Direct TCP tunnel via tokio::io::copy_bidirectional (no certificate replacement / pinning preserved).",
                            bypass_rule.pattern, bypass_rule.description
                        ),
                        format!("Passthrough ({})", bypass_rule.pattern),
                        format!("SSL Passthrough ({})", bypass_rule.category),
                    ),
                    PassthroughReason::NotInTargetAllowlist => (
                        "PASSTHROUGH".to_string(),
                        format!(
                            "[Selective MITM Pass-Through Tunnel Active]\n\
                             Host: {host}:{port}\n\
                             Mode: Targeted Only (Inspect Allowlist Only)\n\
                             Reason: Host is outside Target Allowlist — relayed as pure encrypted TCP stream via tokio::io::copy_bidirectional (zero CA substitution, mTLS & Certificate Pinning intact)."
                        ),
                        "Passthrough (Targeted-Only Allowlist Mode)".to_string(),
                        "Pure TCP Passthrough (Targeted-Only)".to_string(),
                    ),
                    PassthroughReason::NotInHostsWhitelist => (
                        "PASSTHROUGH".to_string(),
                        format!(
                            "[Hosts List Whitelist Pass-Through Active]\n\
                             Host: {host}:{port}\n\
                             Mode: Bulk Hosts List — Show only (Whitelist) + TLS Passthrough\n\
                             Reason: Host is not matched by Hosts List Whitelist — relayed as pure encrypted TCP stream via tokio::io::copy_bidirectional."
                        ),
                        "Passthrough (Hosts List Whitelist)".to_string(),
                        "Pure TCP Passthrough (Hosts List Whitelist)".to_string(),
                    ),
                };

            let summary = SessionSummary {
                id: session_id,
                status: 200,
                protocol: protocol_label,
                scheme: "https".into(),
                method: "CONNECT".into(),
                host: host.clone(),
                path: tunnel_path,
                url: target_url,
                content_type: "tls/passthrough".into(),
                body_size: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                timestamp,
                is_mocked: false,
                matched_rule_id: None,
                error: None,
                process_name: client_proc.as_ref().map(|p| p.name.clone()),
                process_pid: client_proc.as_ref().map(|p| p.pid),
                tls_bypassed: true,
                headers_mutated: false,
                breakpoint_paused: None,
                breakpoint_modified: false,
                comment: None,
                marked_color: None,
                client_ip: Some(normalize_client_ip(client_addr)),
            };

            let detail = SessionDetail {
                summary: summary.clone(),
                request_headers: connect_headers,
                response_headers: vec![HeaderPair {
                    name: "X-FluxProxy-TLS-Mode".into(),
                    value: mode_header_val,
                }],
                request_body_base64: String::new(),
                response_body_base64: base64::engine::general_purpose::STANDARD
                    .encode(passthrough_note.as_bytes()),
                request_body_text: None,
                response_body_text: Some(passthrough_note),
                tls_version: Some(tls_version_label),
                client_addr: client_addr.to_string(),
                websocket_frames: Vec::new(),
                sse_events: Vec::new(),
            };

            ctx.store.insert(detail);
            let _ = ctx.event_tx.send(summary);

            tokio::spawn(async move {
                match hyper::upgrade::on(req).await {
                    Ok(upgraded) => {
                        let mut client_io = TokioIo::new(upgraded);
                        match tokio::io::copy_bidirectional(&mut client_io, &mut upstream_tcp).await
                        {
                            Ok((tx_bytes, rx_bytes)) => {
                                if let Some(mut existing) = ctx.store.get(session_id) {
                                    existing.summary.body_size =
                                        (tx_bytes.saturating_add(rx_bytes)) as usize;
                                    existing.summary.duration_ms =
                                        start.elapsed().as_millis() as u64;
                                    let updated_summary = existing.summary.clone();
                                    ctx.store.insert(existing);
                                    let _ = ctx.event_tx.send(updated_summary);
                                }
                            }
                            Err(err) => {
                                tracing::debug!("TLS passthrough tunnel closed for {host}: {err}");
                            }
                        }
                    }
                    Err(err) => {
                        tracing::debug!("HTTP CONNECT passthrough upgrade error: {err}");
                    }
                }
            });

            return Response::builder()
                .status(StatusCode::OK)
                .body(boxed_full(Bytes::new()))
                .unwrap();
        }

        tokio::spawn(async move {
            match hyper::upgrade::on(req).await {
                Ok(upgraded) => {
                    let server_cfg = match ctx.ca.server_config_for_host(&host) {
                        Ok(cfg) => cfg,
                        Err(err) => {
                            tracing::error!("Failed to generate MITM cert for {host}: {err}");
                            return;
                        }
                    };

                    let acceptor = TlsAcceptor::from(server_cfg);
                    let tls_stream = match acceptor.accept(TokioIo::new(upgraded)).await {
                        Ok(s) => s,
                        Err(err) => {
                            tracing::debug!("Client TLS handshake aborted for {host}: {err}");
                            return;
                        }
                    };

                    let negotiated_alpn = tls_stream
                        .get_ref()
                        .1
                        .alpn_protocol()
                        .map(|p| String::from_utf8_lossy(p).to_string())
                        .unwrap_or_else(|| "http/1.1".to_string());

                    let inner_io = TokioIo::new(tls_stream);
                    let authority_host = if port == 443 {
                        host.clone()
                    } else {
                        format!("{host}:{port}")
                    };

                    let service = service_fn(move |inner_req: Request<Incoming>| {
                        let req_ctx = ctx.clone();
                        let default_host = authority_host.clone();
                        let alpn = negotiated_alpn.clone();
                        let proc_info = client_proc.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_intercepted_request(
                                    inner_req,
                                    "https",
                                    Some(&default_host),
                                    Some(&alpn),
                                    client_addr,
                                    proc_info,
                                    req_ctx,
                                )
                                .await,
                            )
                        }
                    });

                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(inner_io, service)
                        .await;
                }
                Err(err) => {
                    tracing::debug!("HTTP CONNECT upgrade error: {err}");
                }
            }
        });

        // Acknowledge tunnel establishment so the client begins TLS ClientHello
        return Response::builder()
            .status(StatusCode::OK)
            .body(boxed_full(Bytes::new()))
            .unwrap();
    }

    handle_intercepted_request(req, "http", None, None, client_addr, client_proc, ctx).await
}

/// Core MITM request pipeline supporting HTTP/1.1, HTTP/2, WebSocket frame capture,
/// SSE (`text/event-stream`) real-time streaming capture, Live Breakpoints (`oneshot::channel`),
/// lightweight Header Mutations, and AutoResponder rule mocking / latency simulation.
async fn handle_intercepted_request(
    req: Request<Incoming>,
    scheme: &str,
    default_authority: Option<&str>,
    alpn: Option<&str>,
    client_addr: SocketAddr,
    client_proc: Option<ClientProcessInfo>,
    ctx: Arc<SharedProxyContext>,
) -> Response<ProxyBoxBody> {
    let start = Instant::now();
    let timestamp = Utc::now().to_rfc3339();
    let session_id = ctx.store.allocate_id();

    let mut scheme_str = scheme.to_string();
    let mut host_header = req
        .headers()
        .get(HOST)
        .and_then(|v| v.to_str().ok())
        .or(default_authority)
        .unwrap_or("localhost")
        .to_string();

    let mut path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());

    let is_direct_origin_http = scheme == "http" && req.uri().scheme().is_none();

    let mut full_url = if req.uri().scheme().is_some() {
        req.uri().to_string()
    } else {
        format!("{scheme_str}://{host_header}{path_and_query}")
    };

    // 0. Built-in Mobile Onboarding Portal & Root CA Certificate Endpoints
    // Triggered on `http(s)://flux.proxy/*` OR direct HTTP browser connections to `<proxy-ip>:<port>/*`
    if is_builtin_portal_target(
        &host_header,
        is_direct_origin_http,
        ctx.active_port.load(Ordering::Relaxed),
    ) {
        return handle_builtin_portal_request(
            req,
            session_id,
            &scheme_str,
            &host_header,
            &path_and_query,
            &full_url,
            alpn,
            start,
            timestamp,
            client_addr,
            client_proc.as_ref(),
            &ctx,
        );
    }

    // 1. Check for WebSocket Upgrade (`ws://` or decrypted `wss://`)
    let is_ws_upgrade = req
        .headers()
        .get(UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);

    if is_ws_upgrade {
        return handle_websocket_intercept(
            req,
            session_id,
            &scheme_str,
            host_header,
            path_and_query,
            full_url,
            timestamp,
            client_addr,
            client_proc,
            ctx,
        )
        .await;
    }

    let mut method_str = req.method().as_str().to_string();
    let req_version = req.version();
    let mut req_headers = extract_hyper_headers(req.headers());
    let req_mutated = ctx.filters.apply_header_mutations(
        HeaderMutationDirection::Request,
        &full_url,
        &mut req_headers,
    );

    let mut body_bytes = match req.into_body().collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(err) => {
            return record_and_return_error(
                &ctx,
                session_id,
                &scheme_str,
                &method_str,
                &host_header,
                &path_and_query,
                &full_url,
                req_headers,
                Bytes::new(),
                start,
                timestamp,
                client_addr,
                client_proc.as_ref(),
                false,
                false,
                format!("Failed reading client request body: {err}"),
            );
        }
    };

    let mut bp_modified = false;

    // 1b. Live Breakpoint: Before Request (F11 / `bpu`)
    if ctx
        .breakpoints
        .should_break(BreakpointStage::Request, &method_str, &full_url)
    {
        let bp_id = format!("bp-req-{session_id}");
        let capped_req = &body_bytes[..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
        let req_b64 = base64::engine::general_purpose::STANDARD.encode(capped_req);
        let req_txt = std::str::from_utf8(capped_req).ok().map(str::to_owned);
        let proto_preview = resolve_protocol_label(&scheme_str, alpn, req_version);

        let paused_summary = SessionSummary {
            id: session_id,
            status: 0,
            protocol: proto_preview,
            scheme: scheme_str.clone(),
            method: method_str.clone(),
            host: host_header.clone(),
            path: path_and_query.clone(),
            url: full_url.clone(),
            content_type: "pending/breakpoint-request".into(),
            body_size: body_bytes.len(),
            duration_ms: start.elapsed().as_millis() as u64,
            timestamp: timestamp.clone(),
            is_mocked: false,
            matched_rule_id: None,
            error: None,
            process_name: client_proc.as_ref().map(|p| p.name.clone()),
            process_pid: client_proc.as_ref().map(|p| p.pid),
            tls_bypassed: false,
            headers_mutated: req_mutated,
            breakpoint_paused: Some("request".into()),
            breakpoint_modified: false,
            comment: None,
            marked_color: None,
            client_ip: Some(normalize_client_ip(client_addr)),
        };
        ctx.store.insert(SessionDetail {
            summary: paused_summary.clone(),
            request_headers: req_headers.clone(),
            response_headers: Vec::new(),
            request_body_base64: req_b64.clone(),
            response_body_base64: String::new(),
            request_body_text: req_txt.clone(),
            response_body_text: None,
            tls_version: if scheme_str == "https" {
                Some("TLS 1.3 (MITM Paused)".into())
            } else {
                None
            },
            client_addr: client_addr.to_string(),
            websocket_frames: Vec::new(),
            sse_events: Vec::new(),
        });
        let _ = ctx.event_tx.send(paused_summary);

        let (bp_rx, timeout_secs) = ctx.breakpoints.park(PausedBreakpointItem {
            breakpoint_id: bp_id.clone(),
            session_id,
            stage: BreakpointStage::Request,
            created_at: Utc::now().to_rfc3339(),
            timeout_secs: 120,
            scheme: scheme_str.clone(),
            method: method_str.clone(),
            url: full_url.clone(),
            host: host_header.clone(),
            path: path_and_query.clone(),
            request_headers: req_headers.clone(),
            request_body_base64: req_b64,
            request_body_text: req_txt,
            response_status: None,
            response_headers: Vec::new(),
            response_body_base64: String::new(),
            response_body_text: None,
            process_name: client_proc.as_ref().map(|p| p.name.clone()),
            process_pid: client_proc.as_ref().map(|p| p.pid),
        });

        match tokio::time::timeout(Duration::from_secs(timeout_secs), bp_rx).await {
            Ok(Ok(verdict)) => {
                if verdict.action == BreakpointAction::Abort {
                    return record_and_return_error(
                        &ctx,
                        session_id,
                        &scheme_str,
                        &method_str,
                        &host_header,
                        &path_and_query,
                        &full_url,
                        req_headers,
                        body_bytes,
                        start,
                        timestamp,
                        client_addr,
                        client_proc.as_ref(),
                        false,
                        true,
                        "Aborted at Live Breakpoint (Before Request)".to_string(),
                    );
                }

                apply_request_breakpoint_edits(
                    &verdict,
                    &mut method_str,
                    &mut full_url,
                    &mut scheme_str,
                    &mut host_header,
                    &mut path_and_query,
                    &mut req_headers,
                    &mut bp_modified,
                );

                if let Some(txt) = verdict.request_body_text {
                    let next_bytes = Bytes::from(txt.into_bytes());
                    if next_bytes != body_bytes {
                        body_bytes = next_bytes;
                        bp_modified = true;
                    }
                } else if let Some(b64) = verdict.request_body_base64 {
                    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(b64.trim())
                    {
                        let next_bytes = Bytes::from(decoded);
                        if next_bytes != body_bytes {
                            body_bytes = next_bytes;
                            bp_modified = true;
                        }
                    }
                }
            }
            _ => {
                ctx.breakpoints.remove_expired(&bp_id);
            }
        }
    }

    // 2. Evaluate AutoResponder Rules (Latency simulation, Mock response, Status override)
    let matched_rule = ctx
        .rules
        .find_matching_rule(&method_str, &full_url, &req_headers);

    if let Some(ref rule) = matched_rule {
        if rule.latency_ms > 0 {
            tokio::time::sleep(Duration::from_millis(rule.latency_ms)).await;
        }

        if matches!(rule.action, RuleActionType::MockResponse) {
            let mock_bytes = Bytes::from(rule.response_body.clone().into_bytes());
            let mut mock_resp_headers = rule.response_headers.clone();
            let resp_mutated = ctx.filters.apply_header_mutations(
                HeaderMutationDirection::Response,
                &full_url,
                &mut mock_resp_headers,
            );
            let content_type = mock_resp_headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case("content-type"))
                .map(|h| h.value.clone())
                .unwrap_or_else(|| "application/json; charset=utf-8".to_string());

            let sse_events = if content_type.to_ascii_lowercase().starts_with("text/event-stream") {
                parse_sse_events_from_bytes(&mock_bytes, start.elapsed().as_millis() as u64)
            } else {
                Vec::new()
            };

            let protocol_label = resolve_protocol_label(&scheme_str, alpn, req_version);
            let duration_ms = start.elapsed().as_millis() as u64;

            let summary = SessionSummary {
                id: session_id,
                status: rule.status_code,
                protocol: protocol_label,
                scheme: scheme_str.clone(),
                method: method_str,
                host: host_header,
                path: path_and_query,
                url: full_url,
                content_type,
                body_size: mock_bytes.len(),
                duration_ms,
                timestamp,
                is_mocked: true,
                matched_rule_id: Some(rule.id.clone()),
                error: None,
                process_name: client_proc.as_ref().map(|p| p.name.clone()),
                process_pid: client_proc.as_ref().map(|p| p.pid),
                tls_bypassed: false,
                headers_mutated: req_mutated || resp_mutated,
                breakpoint_paused: None,
                breakpoint_modified: bp_modified,
                comment: None,
                marked_color: None,
                client_ip: Some(normalize_client_ip(client_addr)),
            };

            let capped_req = &body_bytes[..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
            let detail = SessionDetail {
                summary: summary.clone(),
                request_headers: req_headers,
                response_headers: mock_resp_headers.clone(),
                request_body_base64: base64::engine::general_purpose::STANDARD.encode(capped_req),
                response_body_base64: base64::engine::general_purpose::STANDARD.encode(&mock_bytes),
                request_body_text: std::str::from_utf8(capped_req).ok().map(str::to_owned),
                response_body_text: Some(rule.response_body.clone()),
                tls_version: if scheme_str == "https" {
                    Some("TLS 1.3 (MITM Mock)".into())
                } else {
                    None
                },
                client_addr: client_addr.to_string(),
                websocket_frames: Vec::new(),
                sse_events,
            };

            ctx.store.insert(detail);
            let _ = ctx.event_tx.send(summary);

            let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();
            let mut resp_builder = Response::builder().status(
                StatusCode::from_u16(rule.status_code).unwrap_or(StatusCode::OK),
            );
            for h in &mock_resp_headers {
                if !h.name.trim().is_empty() && !(strip_alt_svc && is_alt_svc_header(&h.name)) {
                    resp_builder = resp_builder.header(&h.name, &h.value);
                }
            }
            return resp_builder
                .body(boxed_full(mock_bytes))
                .unwrap_or_else(|_| {
                    plain_response(StatusCode::INTERNAL_SERVER_ERROR, "Mock build error")
                });
        }
    }

    // 3. Forward Request Upstream
    let reqwest_method = match reqwest::Method::from_bytes(method_str.as_bytes()) {
        Ok(m) => m,
        Err(err) => {
            return plain_response(StatusCode::BAD_REQUEST, &format!("Invalid method: {err}"));
        }
    };

    let mut upstream_req = ctx.upstream_client.request(reqwest_method, &full_url);
    for h in &req_headers {
        if !is_hop_by_hop_header(&h.name)
            && !h.name.eq_ignore_ascii_case("host")
            && !h.name.eq_ignore_ascii_case("content-length")
        {
            upstream_req = upstream_req.header(&h.name, &h.value);
        }
    }
    if !body_bytes.is_empty() {
        upstream_req = upstream_req.body(body_bytes.to_vec());
    }

    let mut upstream_resp = match upstream_req.send().await {
        Ok(r) => r,
        Err(err) => {
            return record_and_return_error(
                &ctx,
                session_id,
                &scheme_str,
                &method_str,
                &host_header,
                &path_and_query,
                &full_url,
                req_headers,
                body_bytes,
                start,
                timestamp,
                client_addr,
                client_proc.as_ref(),
                false,
                bp_modified,
                format!("Upstream connection error: {err}"),
            );
        }
    };

    let mut final_status = upstream_resp.status().as_u16();
    let mut is_mocked = false;
    let mut matched_rule_id = None;

    if let Some(ref rule) = matched_rule {
        matched_rule_id = Some(rule.id.clone());
        if matches!(rule.action, RuleActionType::OverrideStatus) {
            final_status = rule.status_code;
            is_mocked = true;
        }
    }

    let mut resp_headers = extract_reqwest_headers(upstream_resp.headers());
    let mut resp_mutated = ctx.filters.apply_header_mutations(
        HeaderMutationDirection::Response,
        &full_url,
        &mut resp_headers,
    );
    let mut content_type = resp_headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("content-type"))
        .map(|h| h.value.clone())
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let upstream_version = upstream_resp.version();
    let protocol_label = if alpn.is_some() {
        resolve_protocol_label(&scheme_str, alpn, req_version)
    } else {
        format_http_version(&scheme_str, upstream_version)
    };

    let is_sse_stream = content_type
        .to_ascii_lowercase()
        .starts_with("text/event-stream");
    let should_break_resp =
        ctx.breakpoints
            .should_break(BreakpointStage::Response, &method_str, &full_url);

    // 4a. Real-time Server-Sent Events (`text/event-stream`) zero-buffering pass-through & chunk capture
    if is_sse_stream && !should_break_resp {
        let capped_req = &body_bytes[..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
        let initial_summary = SessionSummary {
            id: session_id,
            status: final_status,
            protocol: protocol_label,
            scheme: scheme_str.clone(),
            method: method_str,
            host: host_header,
            path: path_and_query,
            url: full_url,
            content_type: content_type.clone(),
            body_size: 0,
            duration_ms: start.elapsed().as_millis() as u64,
            timestamp,
            is_mocked,
            matched_rule_id,
            error: None,
            process_name: client_proc.as_ref().map(|p| p.name.clone()),
            process_pid: client_proc.as_ref().map(|p| p.pid),
            tls_bypassed: false,
            headers_mutated: req_mutated || resp_mutated,
            breakpoint_paused: None,
            breakpoint_modified: bp_modified,
            comment: None,
            marked_color: None,
            client_ip: Some(normalize_client_ip(client_addr)),
        };

        let initial_detail = SessionDetail {
            summary: initial_summary.clone(),
            request_headers: req_headers,
            response_headers: resp_headers.clone(),
            request_body_base64: base64::engine::general_purpose::STANDARD.encode(capped_req),
            response_body_base64: String::new(),
            request_body_text: std::str::from_utf8(capped_req).ok().map(str::to_owned),
            response_body_text: Some(String::new()),
            tls_version: if scheme_str == "https" {
                Some("TLS 1.3 (MITM SSE)".into())
            } else {
                None
            },
            client_addr: client_addr.to_string(),
            websocket_frames: Vec::new(),
            sse_events: Vec::new(),
        };

        ctx.store.insert(initial_detail);
        let _ = ctx.event_tx.send(initial_summary);

        let (chunk_tx, chunk_rx) = mpsc::channel::<Result<Frame<Bytes>, Infallible>>(64);
        let sse_ctx = ctx.clone();

        tokio::spawn(async move {
            let mut raw_accum: Vec<u8> = Vec::new();
            let mut parse_cursor = 0usize;
            let mut recorded_events: Vec<SseEventRecord> = Vec::new();
            let mut total_bytes = 0usize;

            while let Ok(Some(chunk)) = upstream_resp.chunk().await {
                let chunk_offset_ms = start.elapsed().as_millis() as u64;
                total_bytes += chunk.len();

                if raw_accum.len() < MAX_CAPTURED_BODY_BYTES {
                    let room = MAX_CAPTURED_BODY_BYTES - raw_accum.len();
                    raw_accum.extend_from_slice(&chunk[..chunk.len().min(room)]);
                }

                // Extract complete SSE blocks (`\n\n` or `\r\n\r\n`) arrived so far
                drain_complete_sse_events(
                    &raw_accum,
                    &mut parse_cursor,
                    chunk_offset_ms,
                    &mut recorded_events,
                );

                if let Some(mut detail) = sse_ctx.store.get(session_id) {
                    detail.summary.body_size = total_bytes;
                    detail.summary.duration_ms = chunk_offset_ms;
                    detail.response_body_base64 =
                        base64::engine::general_purpose::STANDARD.encode(&raw_accum);
                    detail.response_body_text =
                        Some(String::from_utf8_lossy(&raw_accum).into_owned());
                    detail.sse_events = recorded_events.clone();
                    let updated_summary = detail.summary.clone();
                    sse_ctx.store.insert(detail);
                    let _ = sse_ctx.event_tx.send(updated_summary);
                }

                if chunk_tx.send(Ok(Frame::data(chunk))).await.is_err() {
                    break;
                }
            }

            // Flush any trailing partial SSE block when the stream closes
            if parse_cursor < raw_accum.len() {
                let tail = &raw_accum[parse_cursor..];
                if let Some(ev) =
                    parse_single_sse_block(tail, recorded_events.len() + 1, start.elapsed().as_millis() as u64)
                {
                    recorded_events.push(ev);
                    if let Some(mut detail) = sse_ctx.store.get(session_id) {
                        detail.summary.duration_ms = start.elapsed().as_millis() as u64;
                        detail.sse_events = recorded_events;
                        let updated_summary = detail.summary.clone();
                        sse_ctx.store.insert(detail);
                        let _ = sse_ctx.event_tx.send(updated_summary);
                    }
                }
            }
        });

        let stream = futures_util::stream::unfold(chunk_rx, |mut rx| async move {
            rx.recv().await.map(|frame| (frame, rx))
        });
        let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();
        let mut builder =
            Response::builder().status(StatusCode::from_u16(final_status).unwrap_or(StatusCode::OK));
        for h in &resp_headers {
            if !is_hop_by_hop_header(&h.name)
                && !h.name.eq_ignore_ascii_case("content-encoding")
                && !h.name.eq_ignore_ascii_case("content-length")
                && !(strip_alt_svc && is_alt_svc_header(&h.name))
            {
                builder = builder.header(&h.name, &h.value);
            }
        }
        return builder
            .body(http_body_util::BodyExt::boxed(StreamBody::new(stream)))
            .unwrap_or_else(|_| {
                plain_response(StatusCode::BAD_GATEWAY, "Failed building SSE response")
            });
    }

    // 4b. Standard Buffered Upstream Response (+ Optional Live Breakpoint After Response)
    let mut resp_bytes = match upstream_resp.bytes().await {
        Ok(b) => b,
        Err(err) => {
            return record_and_return_error(
                &ctx,
                session_id,
                &scheme_str,
                &method_str,
                &host_header,
                &path_and_query,
                &full_url,
                req_headers,
                body_bytes,
                start,
                timestamp,
                client_addr,
                client_proc.as_ref(),
                false,
                bp_modified,
                format!("Failed reading upstream response body: {err}"),
            );
        }
    };

    // 4c. Live Breakpoint: After Response (Alt+F11 / `bpafter`)
    if should_break_resp {
        let bp_id = format!("bp-resp-{session_id}");
        let capped_req = &body_bytes[..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
        let capped_resp = &resp_bytes[..resp_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
        let req_b64 = base64::engine::general_purpose::STANDARD.encode(capped_req);
        let resp_b64 = base64::engine::general_purpose::STANDARD.encode(capped_resp);
        let req_txt = std::str::from_utf8(capped_req).ok().map(str::to_owned);
        let resp_txt = std::str::from_utf8(capped_resp).ok().map(str::to_owned);

        let paused_summary = SessionSummary {
            id: session_id,
            status: final_status,
            protocol: protocol_label.clone(),
            scheme: scheme_str.clone(),
            method: method_str.clone(),
            host: host_header.clone(),
            path: path_and_query.clone(),
            url: full_url.clone(),
            content_type: content_type.clone(),
            body_size: resp_bytes.len(),
            duration_ms: start.elapsed().as_millis() as u64,
            timestamp: timestamp.clone(),
            is_mocked,
            matched_rule_id: matched_rule_id.clone(),
            error: None,
            process_name: client_proc.as_ref().map(|p| p.name.clone()),
            process_pid: client_proc.as_ref().map(|p| p.pid),
            tls_bypassed: false,
            headers_mutated: req_mutated || resp_mutated,
            breakpoint_paused: Some("response".into()),
            breakpoint_modified: bp_modified,
            comment: None,
            marked_color: None,
            client_ip: Some(normalize_client_ip(client_addr)),
        };
        ctx.store.insert(SessionDetail {
            summary: paused_summary.clone(),
            request_headers: req_headers.clone(),
            response_headers: resp_headers.clone(),
            request_body_base64: req_b64.clone(),
            response_body_base64: resp_b64.clone(),
            request_body_text: req_txt.clone(),
            response_body_text: resp_txt.clone(),
            tls_version: if scheme_str == "https" {
                Some("TLS 1.3 (MITM Paused)".into())
            } else {
                None
            },
            client_addr: client_addr.to_string(),
            websocket_frames: Vec::new(),
            sse_events: Vec::new(),
        });
        let _ = ctx.event_tx.send(paused_summary);

        let (bp_rx, timeout_secs) = ctx.breakpoints.park(PausedBreakpointItem {
            breakpoint_id: bp_id.clone(),
            session_id,
            stage: BreakpointStage::Response,
            created_at: Utc::now().to_rfc3339(),
            timeout_secs: 120,
            scheme: scheme_str.clone(),
            method: method_str.clone(),
            url: full_url.clone(),
            host: host_header.clone(),
            path: path_and_query.clone(),
            request_headers: req_headers.clone(),
            request_body_base64: req_b64,
            request_body_text: req_txt,
            response_status: Some(final_status),
            response_headers: resp_headers.clone(),
            response_body_base64: resp_b64,
            response_body_text: resp_txt,
            process_name: client_proc.as_ref().map(|p| p.name.clone()),
            process_pid: client_proc.as_ref().map(|p| p.pid),
        });

        match tokio::time::timeout(Duration::from_secs(timeout_secs), bp_rx).await {
            Ok(Ok(verdict)) => {
                if verdict.action == BreakpointAction::Abort {
                    return record_and_return_error(
                        &ctx,
                        session_id,
                        &scheme_str,
                        &method_str,
                        &host_header,
                        &path_and_query,
                        &full_url,
                        req_headers,
                        body_bytes,
                        start,
                        timestamp,
                        client_addr,
                        client_proc.as_ref(),
                        false,
                        true,
                        "Aborted at Live Breakpoint (After Response)".to_string(),
                    );
                }

                if let Some(sc) = verdict.status_code {
                    if sc != final_status {
                        final_status = sc;
                        bp_modified = true;
                    }
                }
                if let Some(hdrs) = verdict.response_headers {
                    resp_headers = hdrs;
                    if ctx.filters.strip_alt_svc_headers(&mut resp_headers) {
                        resp_mutated = true;
                    }
                    if let Some(ct_hdr) = resp_headers
                        .iter()
                        .find(|h| h.name.eq_ignore_ascii_case("content-type"))
                    {
                        content_type = ct_hdr.value.clone();
                    }
                    bp_modified = true;
                }
                if let Some(txt) = verdict.response_body_text {
                    let next_b = Bytes::from(txt.into_bytes());
                    if next_b != resp_bytes {
                        resp_bytes = next_b;
                        bp_modified = true;
                    }
                } else if let Some(b64) = verdict.response_body_base64 {
                    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(b64.trim())
                    {
                        let next_b = Bytes::from(decoded);
                        if next_b != resp_bytes {
                            resp_bytes = next_b;
                            bp_modified = true;
                        }
                    }
                }
            }
            _ => {
                ctx.breakpoints.remove_expired(&bp_id);
            }
        }
    }

    let duration_ms = start.elapsed().as_millis() as u64;
    let sse_events = if content_type
        .to_ascii_lowercase()
        .starts_with("text/event-stream")
    {
        parse_sse_events_from_bytes(&resp_bytes, duration_ms)
    } else {
        Vec::new()
    };

    let summary = SessionSummary {
        id: session_id,
        status: final_status,
        protocol: protocol_label,
        scheme: scheme_str.clone(),
        method: method_str,
        host: host_header,
        path: path_and_query,
        url: full_url,
        content_type,
        body_size: resp_bytes.len(),
        duration_ms,
        timestamp,
        is_mocked,
        matched_rule_id,
        error: None,
        process_name: client_proc.as_ref().map(|p| p.name.clone()),
        process_pid: client_proc.as_ref().map(|p| p.pid),
        tls_bypassed: false,
        headers_mutated: req_mutated || resp_mutated,
        breakpoint_paused: None,
        breakpoint_modified: bp_modified,
        comment: None,
        marked_color: None,
        client_ip: Some(normalize_client_ip(client_addr)),
    };

    let capped_req = &body_bytes[..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
    let capped_resp = &resp_bytes[..resp_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];

    let detail = SessionDetail {
        summary: summary.clone(),
        request_headers: req_headers,
        response_headers: resp_headers.clone(),
        request_body_base64: base64::engine::general_purpose::STANDARD.encode(capped_req),
        response_body_base64: base64::engine::general_purpose::STANDARD.encode(capped_resp),
        request_body_text: std::str::from_utf8(capped_req).ok().map(str::to_owned),
        response_body_text: std::str::from_utf8(capped_resp).ok().map(str::to_owned),
        tls_version: if scheme_str == "https" {
            Some("TLS 1.3 (MITM)".into())
        } else {
            None
        },
        client_addr: client_addr.to_string(),
        websocket_frames: Vec::new(),
        sse_events,
    };

    ctx.store.insert(detail);
    let _ = ctx.event_tx.send(summary);

    let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();
    let mut builder =
        Response::builder().status(StatusCode::from_u16(final_status).unwrap_or(StatusCode::OK));
    for h in &resp_headers {
        // Reqwest transparently decompresses bodies when gzip/brotli features are enabled,
        // so strip content-encoding & content-length before re-framing via Hyper Full<Bytes>.
        // Also strip HTTP/3 QUIC discovery headers (`alt-svc`, `alternate-protocol`) when enabled.
        if !is_hop_by_hop_header(&h.name)
            && !h.name.eq_ignore_ascii_case("content-encoding")
            && !h.name.eq_ignore_ascii_case("content-length")
            && !(strip_alt_svc && is_alt_svc_header(&h.name))
        {
            builder = builder.header(&h.name, &h.value);
        }
    }

    builder
        .body(boxed_full(resp_bytes))
        .unwrap_or_else(|_| plain_response(StatusCode::BAD_GATEWAY, "Failed building proxy response"))
}

/// Intercepts `ws://` and decrypted `wss://` WebSocket connections, relaying frames
/// bidirectionally while recording frame metadata in `TrafficStore`.
/// Preserves client authentication/application headers (`Authorization`, `Cookie`,
/// `Sec-WebSocket-Protocol`, non-deflate `Sec-WebSocket-Extensions`, `User-Agent`, `Origin`, `X-*`)
/// required by ASP.NET Core SignalR and forwards upstream `101` handshake headers (`Sec-WebSocket-Protocol`,
/// `Set-Cookie`, `X-*`) back to the client.
#[allow(clippy::too_many_arguments)]
async fn handle_websocket_intercept(
    req: Request<Incoming>,
    session_id: u64,
    scheme: &str,
    host_header: String,
    path_and_query: String,
    full_url: String,
    timestamp: String,
    client_addr: SocketAddr,
    client_proc: Option<ClientProcessInfo>,
    ctx: Arc<SharedProxyContext>,
) -> Response<ProxyBoxBody> {
    let start = Instant::now();
    let ws_scheme = if scheme == "https" { "wss" } else { "ws" };
    let ws_url = format!("{ws_scheme}://{host_header}{path_and_query}");

    let sec_ws_key = match req.headers().get("sec-websocket-key") {
        Some(k) => k.to_str().unwrap_or_default().to_string(),
        None => return plain_response(StatusCode::BAD_REQUEST, "Missing Sec-WebSocket-Key"),
    };
    let accept_key = derive_accept_key(sec_ws_key.as_bytes());

    let mut req_headers = extract_hyper_headers(req.headers());
    let req_mutated = ctx.filters.apply_header_mutations(
        HeaderMutationDirection::Request,
        &full_url,
        &mut req_headers,
    );

    let ws_req = match build_upstream_websocket_request(&ws_url, &req_headers) {
        Ok(request) => request,
        Err(err) => {
            return record_and_return_error(
                &ctx,
                session_id,
                ws_scheme,
                "GET",
                &host_header,
                &path_and_query,
                &full_url,
                req_headers,
                Bytes::new(),
                start,
                timestamp,
                client_addr,
                client_proc.as_ref(),
                false,
                req_mutated,
                err,
            );
        }
    };

    let (upstream_ws, upstream_handshake_resp) = match tokio_tungstenite::connect_async(ws_req).await
    {
        Ok(pair) => pair,
        Err(tokio_tungstenite::tungstenite::Error::Http(http_resp)) => {
            let status = http_resp.status();
            let mut resp_headers = extract_hyper_headers(http_resp.headers());
            let resp_mutated = ctx.filters.apply_header_mutations(
                HeaderMutationDirection::Response,
                &full_url,
                &mut resp_headers,
            );
            let resp_bytes = Bytes::from(http_resp.into_body().unwrap_or_default());
            let content_type = resp_headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case("content-type"))
                .map(|h| h.value.clone())
                .unwrap_or_else(|| "text/plain".to_string());

            let summary = SessionSummary {
                id: session_id,
                status: status.as_u16(),
                protocol: ws_scheme.to_ascii_uppercase(),
                scheme: ws_scheme.to_string(),
                method: "GET".to_string(),
                host: host_header,
                path: path_and_query,
                url: full_url,
                content_type,
                body_size: resp_bytes.len(),
                duration_ms: start.elapsed().as_millis() as u64,
                timestamp,
                is_mocked: false,
                matched_rule_id: None,
                error: None,
                process_name: client_proc.as_ref().map(|p| p.name.clone()),
                process_pid: client_proc.as_ref().map(|p| p.pid),
                tls_bypassed: false,
                headers_mutated: req_mutated || resp_mutated,
                breakpoint_paused: None,
                breakpoint_modified: false,
                comment: None,
                marked_color: None,
                client_ip: Some(normalize_client_ip(client_addr)),
            };

            let capped = &resp_bytes[..resp_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
            let detail = SessionDetail {
                summary: summary.clone(),
                request_headers: req_headers,
                response_headers: resp_headers.clone(),
                request_body_base64: String::new(),
                response_body_base64: base64::engine::general_purpose::STANDARD.encode(capped),
                request_body_text: None,
                response_body_text: std::str::from_utf8(capped).ok().map(str::to_owned),
                tls_version: if ws_scheme == "wss" {
                    Some("TLS 1.3 (WSS MITM)".into())
                } else {
                    None
                },
                client_addr: client_addr.to_string(),
                websocket_frames: Vec::new(),
                sse_events: Vec::new(),
            };

            ctx.store.insert(detail);
            let _ = ctx.event_tx.send(summary);

            let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();
            let mut rej_resp = Response::builder()
                .status(status)
                .body(boxed_full(resp_bytes))
                .unwrap_or_else(|_| plain_response(status, "WebSocket handshake rejected"));
            for h in &resp_headers {
                if !is_hop_by_hop_header(&h.name)
                    && !h.name.eq_ignore_ascii_case("content-length")
                    && !(strip_alt_svc && is_alt_svc_header(&h.name))
                {
                    if let (Ok(hn), Ok(hv)) = (
                        http::header::HeaderName::from_bytes(h.name.trim().as_bytes()),
                        http::header::HeaderValue::from_str(&h.value),
                    ) {
                        rej_resp.headers_mut().append(hn, hv);
                    }
                }
            }
            return rej_resp;
        }
        Err(err) => {
            return record_and_return_error(
                &ctx,
                session_id,
                ws_scheme,
                "GET",
                &host_header,
                &path_and_query,
                &full_url,
                req_headers,
                Bytes::new(),
                start,
                timestamp,
                client_addr,
                client_proc.as_ref(),
                false,
                req_mutated,
                format!("WebSocket upstream connect failed: {err}"),
            );
        }
    };

    let mut resp_headers = extract_hyper_headers(upstream_handshake_resp.headers());
    let resp_mutated = ctx.filters.apply_header_mutations(
        HeaderMutationDirection::Response,
        &full_url,
        &mut resp_headers,
    );

    let summary = SessionSummary {
        id: session_id,
        status: 101,
        protocol: ws_scheme.to_ascii_uppercase(),
        scheme: ws_scheme.to_string(),
        method: "GET".to_string(),
        host: host_header,
        path: path_and_query,
        url: full_url,
        content_type: "websocket/frames".to_string(),
        body_size: 0,
        duration_ms: start.elapsed().as_millis() as u64,
        timestamp,
        is_mocked: false,
        matched_rule_id: None,
        error: None,
        process_name: client_proc.as_ref().map(|p| p.name.clone()),
        process_pid: client_proc.as_ref().map(|p| p.pid),
        tls_bypassed: false,
        headers_mutated: req_mutated || resp_mutated,
        breakpoint_paused: None,
        breakpoint_modified: false,
        comment: None,
        marked_color: None,
        client_ip: Some(normalize_client_ip(client_addr)),
    };

    let initial_detail = SessionDetail {
        summary: summary.clone(),
        request_headers: req_headers,
        response_headers: resp_headers.clone(),
        request_body_base64: String::new(),
        response_body_base64: String::new(),
        request_body_text: None,
        response_body_text: Some("[WebSocket Tunnel Established — Inspect Frames]".into()),
        tls_version: if ws_scheme == "wss" {
            Some("TLS 1.3 (WSS MITM)".into())
        } else {
            None
        },
        client_addr: client_addr.to_string(),
        websocket_frames: Vec::new(),
        sse_events: Vec::new(),
    };

    ctx.store.insert(initial_detail.clone());
    let _ = ctx.event_tx.send(summary);
    let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();

    tokio::spawn(async move {
        if let Ok(upgraded) = hyper::upgrade::on(req).await {
            let client_ws =
                WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, None).await;

            let (mut client_sink, mut client_stream) = client_ws.split();
            let (mut upstream_sink, mut upstream_stream) = upstream_ws.split();

            let mut recorded_frames: Vec<WebSocketFrameRecord> = Vec::new();
            let mut total_bytes = 0usize;

            loop {
                tokio::select! {
                    client_msg = client_stream.next() => {
                        match client_msg {
                            Some(Ok(msg)) => {
                                total_bytes += msg.len();
                                if recorded_frames.len() < 256 {
                                    recorded_frames.push(record_ws_frame(recorded_frames.len() + 1, "outbound", &msg));
                                    update_ws_session(&ctx, session_id, total_bytes, &recorded_frames);
                                }
                                if upstream_sink.send(msg).await.is_err() {
                                    break;
                                }
                            }
                            _ => break,
                        }
                    }
                    upstream_msg = upstream_stream.next() => {
                        match upstream_msg {
                            Some(Ok(msg)) => {
                                total_bytes += msg.len();
                                if recorded_frames.len() < 256 {
                                    recorded_frames.push(record_ws_frame(recorded_frames.len() + 1, "inbound", &msg));
                                    update_ws_session(&ctx, session_id, total_bytes, &recorded_frames);
                                }
                                if client_sink.send(msg).await.is_err() {
                                    break;
                                }
                            }
                            _ => break,
                        }
                    }
                }
            }
        }
    });

    let mut client_resp = Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(http::header::CONNECTION, "Upgrade")
        .header(UPGRADE, "websocket")
        .header("Sec-WebSocket-Accept", accept_key)
        .body(boxed_full(Bytes::new()))
        .unwrap();

    // Forward upstream handshake headers (`Sec-WebSocket-Protocol`, multiple `Set-Cookie`, `X-*`, etc.)
    // while excluding hop-by-hop headers, `Alt-Svc`/`Alternate-Protocol` (when enabled), and upstream's `Sec-WebSocket-Accept`.
    for h in &resp_headers {
        let lower = h.name.trim().to_ascii_lowercase();
        if is_ws_excluded_response_header(&lower)
            || (strip_alt_svc && is_alt_svc_header(&lower))
        {
            continue;
        }
        if let (Ok(hn), Ok(hv)) = (
            http::header::HeaderName::from_bytes(h.name.trim().as_bytes()),
            http::header::HeaderValue::from_str(&h.value),
        ) {
            client_resp.headers_mut().append(hn, hv);
        }
    }

    client_resp
}

/// Builds an upstream `http::Request<()>` via `IntoClientRequest` (which populates a fresh
/// `Sec-WebSocket-Key`, `Sec-WebSocket-Version: 13`, `Upgrade: websocket`, `Connection: Upgrade`,
/// and `Host`), then copies client headers (`Authorization`, `Cookie`, `Sec-WebSocket-Protocol`,
/// non-deflate `Sec-WebSocket-Extensions`, `User-Agent`, `Origin`, `X-*`, etc.) while excluding
/// regenerated hop-by-hop handshake headers.
fn build_upstream_websocket_request(
    ws_url: &str,
    client_headers: &[HeaderPair],
) -> Result<http::Request<()>, String> {
    let mut ws_req: http::Request<()> = ws_url
        .into_client_request()
        .map_err(|err| format!("Invalid upstream WebSocket URL '{ws_url}': {err}"))?;

    let mut cookie_parts: Vec<&str> = Vec::new();
    let mut subprotocol_parts: Vec<&str> = Vec::new();
    let mut extension_parts: Vec<String> = Vec::new();

    for h in client_headers {
        let raw_name = h.name.trim();
        if raw_name.is_empty() {
            continue;
        }
        let lower = raw_name.to_ascii_lowercase();
        if is_ws_excluded_request_header(&lower) {
            continue;
        }

        if lower == "cookie" {
            let trimmed = h.value.trim();
            if !trimmed.is_empty() {
                cookie_parts.push(trimmed);
            }
            continue;
        }

        if lower == "sec-websocket-protocol" {
            let trimmed = h.value.trim();
            if !trimmed.is_empty() {
                subprotocol_parts.push(trimmed);
            }
            continue;
        }

        if lower == "sec-websocket-extensions" {
            if let Some(filtered) = filter_supported_ws_extensions(&h.value) {
                extension_parts.push(filtered);
            }
            continue;
        }

        if let (Ok(hn), Ok(hv)) = (
            http::header::HeaderName::from_bytes(raw_name.as_bytes()),
            http::header::HeaderValue::from_str(&h.value),
        ) {
            if hv.to_str().is_ok() {
                ws_req.headers_mut().append(hn, hv);
            }
        }
    }

    if !cookie_parts.is_empty() {
        let joined = cookie_parts.join("; ");
        if let Ok(hv) = http::header::HeaderValue::from_str(&joined) {
            if hv.to_str().is_ok() {
                ws_req
                    .headers_mut()
                    .insert(http::header::COOKIE, hv);
            }
        }
    }

    if !subprotocol_parts.is_empty() {
        let joined = subprotocol_parts.join(", ");
        if let Ok(hv) = http::header::HeaderValue::from_str(&joined) {
            if hv.to_str().is_ok() {
                ws_req
                    .headers_mut()
                    .insert("sec-websocket-protocol", hv);
            }
        }
    }

    if !extension_parts.is_empty() {
        let joined = extension_parts.join(", ");
        if let Ok(hv) = http::header::HeaderValue::from_str(&joined) {
            if hv.to_str().is_ok() {
                ws_req
                    .headers_mut()
                    .insert("sec-websocket-extensions", hv);
            }
        }
    }

    Ok(ws_req)
}

/// Strips `permessage-deflate` / `x-webkit-deflate-frame` extension offers because
/// `tungstenite-0.26` validates `RSV1 == 0` on uncompressed `WebSocketStream` relays,
/// while preserving any other `Sec-WebSocket-Extensions` offers verbatim.
fn filter_supported_ws_extensions(raw_value: &str) -> Option<String> {
    let kept: Vec<&str> = raw_value
        .split(',')
        .map(str::trim)
        .filter(|offer| {
            if offer.is_empty() {
                return false;
            }
            let ext_name = offer.split(';').next().unwrap_or("").trim();
            !ext_name.eq_ignore_ascii_case("permessage-deflate")
                && !ext_name.eq_ignore_ascii_case("x-webkit-deflate-frame")
        })
        .collect();

    if kept.is_empty() {
        None
    } else {
        Some(kept.join(", "))
    }
}

fn is_ws_excluded_request_header(lower_name: &str) -> bool {
    matches!(
        lower_name,
        "host"
            | "connection"
            | "upgrade"
            | "sec-websocket-key"
            | "sec-websocket-version"
            | "sec-websocket-accept"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "content-length"
    )
}

fn is_ws_excluded_response_header(lower_name: &str) -> bool {
    matches!(
        lower_name,
        "connection"
            | "upgrade"
            | "sec-websocket-accept"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "content-length"
    )
}

fn record_ws_frame(
    index: usize,
    direction: &str,
    msg: &tokio_tungstenite::tungstenite::Message,
) -> WebSocketFrameRecord {
    use tokio_tungstenite::tungstenite::Message;
    let (opcode, preview) = match msg {
        Message::Text(t) => ("text", t.chars().take(512).collect::<String>()),
        Message::Binary(b) => (
            "binary",
            format!("<{} bytes: {}>", b.len(), hex::encode(&b[..b.len().min(24)])),
        ),
        Message::Ping(_) => ("ping", "PING".into()),
        Message::Pong(_) => ("pong", "PONG".into()),
        Message::Close(_) => ("close", "CLOSE".into()),
        Message::Frame(_) => ("frame", "RAW_FRAME".into()),
    };
    WebSocketFrameRecord {
        index,
        direction: direction.to_string(),
        opcode: opcode.to_string(),
        payload_preview: preview,
        byte_length: msg.len(),
        timestamp: Utc::now().to_rfc3339(),
    }
}

fn update_ws_session(
    ctx: &SharedProxyContext,
    session_id: u64,
    total_bytes: usize,
    frames: &[WebSocketFrameRecord],
) {
    if let Some(mut detail) = ctx.store.get(session_id) {
        detail.summary.body_size = total_bytes;
        detail.websocket_frames = frames.to_vec();
        detail.response_body_text = serde_json::to_string_pretty(frames).ok();
        let summary = detail.summary.clone();
        ctx.store.insert(detail);
        let _ = ctx.event_tx.send(summary);
    }
}

#[allow(clippy::too_many_arguments)]
fn apply_request_breakpoint_edits(
    verdict: &crate::models::BreakpointResolution,
    method_str: &mut String,
    full_url: &mut String,
    scheme_str: &mut String,
    host_header: &mut String,
    path_and_query: &mut String,
    req_headers: &mut Vec<HeaderPair>,
    bp_modified: &mut bool,
) {
    if let Some(ref m) = verdict.method {
        let trimmed = m.trim().to_ascii_uppercase();
        if !trimmed.is_empty() && trimmed != *method_str {
            *method_str = trimmed;
            *bp_modified = true;
        }
    }

    if let Some(ref next_headers) = verdict.request_headers {
        *req_headers = next_headers.clone();
        *bp_modified = true;
    }

    if let Some(ref u) = verdict.url {
        let trimmed_u = u.trim();
        if !trimmed_u.is_empty() && trimmed_u != full_url.as_str() {
            if let Ok(parsed) = reqwest::Url::parse(trimmed_u) {
                *scheme_str = parsed.scheme().to_string();
                let host_part = parsed.host_str().unwrap_or("localhost");
                *host_header = match parsed.port() {
                    Some(p) => format!("{host_part}:{p}"),
                    None => host_part.to_string(),
                };
                *path_and_query = match parsed.query() {
                    Some(q) => format!("{}?{}", parsed.path(), q),
                    None => parsed.path().to_string(),
                };
                *full_url = parsed.to_string();
                // Keep Host header synchronized with the rewritten URL
                req_headers.retain(|h| !h.name.eq_ignore_ascii_case("host"));
                req_headers.insert(
                    0,
                    HeaderPair {
                        name: "Host".into(),
                        value: host_header.clone(),
                    },
                );
                *bp_modified = true;
            }
        }
    }
}

fn drain_complete_sse_events(
    buf: &[u8],
    cursor: &mut usize,
    offset_ms: u64,
    out: &mut Vec<SseEventRecord>,
) {
    while *cursor < buf.len() {
        let slice = &buf[*cursor..];
        let delim = find_sse_delimiter(slice);
        let Some((rel_end, delim_len)) = delim else {
            break;
        };
        let block = &slice[..rel_end];
        *cursor += rel_end + delim_len;
        if out.len() < 1024 {
            if let Some(ev) = parse_single_sse_block(block, out.len() + 1, offset_ms) {
                out.push(ev);
            }
        }
    }
}

fn find_sse_delimiter(slice: &[u8]) -> Option<(usize, usize)> {
    for i in 0..slice.len() {
        if i + 3 < slice.len() && &slice[i..i + 4] == b"\r\n\r\n" {
            return Some((i, 4));
        }
        if i + 1 < slice.len() && &slice[i..i + 2] == b"\n\n" {
            return Some((i, 2));
        }
    }
    None
}

fn parse_sse_events_from_bytes(buf: &[u8], total_duration_ms: u64) -> Vec<SseEventRecord> {
    let mut cursor = 0usize;
    let mut out = Vec::new();
    drain_complete_sse_events(buf, &mut cursor, total_duration_ms, &mut out);
    if cursor < buf.len() {
        if let Some(ev) = parse_single_sse_block(&buf[cursor..], out.len() + 1, total_duration_ms) {
            out.push(ev);
        }
    }
    out
}

fn parse_single_sse_block(
    block: &[u8],
    index: usize,
    offset_ms: u64,
) -> Option<SseEventRecord> {
    let text = String::from_utf8_lossy(block);
    if text.trim().is_empty() {
        return None;
    }

    let mut id: Option<String> = None;
    let mut event_name: Option<String> = None;
    let mut retry: Option<u64> = None;
    let mut data_lines: Vec<String> = Vec::new();
    let mut comment_lines: Vec<String> = Vec::new();

    for raw_line in text.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if let Some(comment) = line.strip_prefix(':') {
            comment_lines.push(comment.trim_start().to_string());
            continue;
        }
        let (field, val) = match line.split_once(':') {
            Some((f, v)) => (f.trim(), v.strip_prefix(' ').unwrap_or(v)),
            None => (line.trim(), ""),
        };
        match field {
            "id" => id = Some(val.to_string()),
            "event" => event_name = Some(val.to_string()),
            "data" => data_lines.push(val.to_string()),
            "retry" => retry = val.trim().parse::<u64>().ok(),
            _ => {}
        }
    }

    let (resolved_event, resolved_data) = if !data_lines.is_empty() {
        (
            event_name.unwrap_or_else(|| "message".to_string()),
            data_lines.join("\n"),
        )
    } else if !comment_lines.is_empty() {
        (":comment".to_string(), comment_lines.join("\n"))
    } else {
        (
            event_name.unwrap_or_else(|| "message".to_string()),
            String::new(),
        )
    };

    Some(SseEventRecord {
        index,
        id,
        event: resolved_event,
        data: resolved_data,
        retry,
        byte_length: block.len(),
        offset_ms,
        timestamp: Utc::now().to_rfc3339(),
    })
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
    let summary = SessionSummary {
        id: session_id,
        status: 502,
        protocol: if tls_bypassed {
            "TLS-BYPASS".into()
        } else {
            scheme.to_ascii_uppercase()
        },
        scheme: scheme.to_string(),
        method: method.to_string(),
        host: host.to_string(),
        path: path.to_string(),
        url: url.to_string(),
        content_type: "text/plain; charset=utf-8".to_string(),
        body_size: err_msg.len(),
        duration_ms: start.elapsed().as_millis() as u64,
        timestamp,
        is_mocked: false,
        matched_rule_id: None,
        error: Some(err_msg.clone()),
        process_name: client_proc.map(|p| p.name.clone()),
        process_pid: client_proc.map(|p| p.pid),
        tls_bypassed,
        headers_mutated: false,
        breakpoint_paused: None,
        breakpoint_modified,
        comment: None,
        marked_color: None,
        client_ip: Some(normalize_client_ip(client_addr)),
    };

    let detail = SessionDetail {
        summary: summary.clone(),
        request_headers: req_headers,
        response_headers: vec![HeaderPair {
            name: "Content-Type".into(),
            value: "text/plain; charset=utf-8".into(),
        }],
        request_body_base64: base64::engine::general_purpose::STANDARD.encode(&req_body),
        response_body_base64: base64::engine::general_purpose::STANDARD.encode(err_msg.as_bytes()),
        request_body_text: std::str::from_utf8(&req_body).ok().map(str::to_owned),
        response_body_text: Some(err_msg.clone()),
        tls_version: None,
        client_addr: client_addr.to_string(),
        websocket_frames: Vec::new(),
        sse_events: Vec::new(),
    };

    ctx.store.insert(detail);
    let _ = ctx.event_tx.send(summary);
    plain_response(StatusCode::BAD_GATEWAY, &err_msg)
}

fn boxed_full(bytes: Bytes) -> ProxyBoxBody {
    Full::new(bytes).boxed()
}

fn plain_response(status: StatusCode, msg: &str) -> Response<ProxyBoxBody> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(boxed_full(Bytes::from(msg.to_owned())))
        .unwrap()
}

fn split_authority(authority: &str) -> (String, u16) {
    if let Ok(sock) = authority.parse::<SocketAddr>() {
        return (sock.ip().to_string(), sock.port());
    }
    if let Some((h, p)) = authority.rsplit_once(':') {
        if let Ok(port) = p.parse::<u16>() {
            return (h.trim_matches(['[', ']']).to_string(), port);
        }
    }
    (authority.to_string(), 443)
}

fn extract_hyper_headers(map: &http::HeaderMap) -> Vec<HeaderPair> {
    map.iter()
        .map(|(k, v)| HeaderPair {
            name: k.as_str().to_string(),
            value: v.to_str().unwrap_or("<binary>").to_string(),
        })
        .collect()
}

fn extract_reqwest_headers(map: &reqwest::header::HeaderMap) -> Vec<HeaderPair> {
    map.iter()
        .map(|(k, v)| HeaderPair {
            name: k.as_str().to_string(),
            value: v.to_str().unwrap_or("<binary>").to_string(),
        })
        .collect()
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

fn format_http_version(scheme: &str, version: reqwest::Version) -> String {
    match (scheme, version) {
        ("https", reqwest::Version::HTTP_2) => "HTTPS/2".into(),
        ("https", _) => "HTTPS/1.1".into(),
        (_, reqwest::Version::HTTP_2) => "HTTP/2".into(),
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
    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some((ipv6, tail)) = rest.split_once(']') {
            let port = tail.strip_prefix(':').and_then(|p| p.parse::<u16>().ok());
            return (ipv6.to_ascii_lowercase(), port);
        }
    }
    if let Some((h, p)) = trimmed.rsplit_once(':') {
        if !h.contains(':') {
            if let Ok(port) = p.parse::<u16>() {
                return (h.to_ascii_lowercase(), Some(port));
            }
        }
    }
    (trimmed.to_ascii_lowercase(), None)
}

fn is_builtin_portal_target(
    host_header: &str,
    is_direct_origin_http: bool,
    active_listener_port: u16,
) -> bool {
    if is_direct_origin_http {
        return true;
    }
    let (host_only, maybe_port) = parse_host_and_optional_port(host_header);
    if matches!(
        host_only.as_str(),
        "flux.proxy" | "cert.flux.proxy" | "fluxproxy.local"
    ) {
        return true;
    }
    if active_listener_port > 0 && maybe_port == Some(active_listener_port) {
        if host_only == "localhost" {
            return true;
        }
        if let Ok(ip) = host_only.parse::<IpAddr>() {
            if ip.is_loopback() || ip.is_unspecified() || is_host_own_ip(ip) {
                return true;
            }
        }
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PortalAssetKind {
    HtmlLanding,
    AppleMobileConfig,
    X509CrtPem,
    PemFile,
    DerBinary,
}

fn select_portal_asset(path: &str, query: &str, user_agent: &str) -> PortalAssetKind {
    let clean_path = path.trim_end_matches('/').to_ascii_lowercase();
    let q_lower = query.to_ascii_lowercase();

    if q_lower.contains("format=mobileconfig") || q_lower.contains("os=ios") {
        return PortalAssetKind::AppleMobileConfig;
    }
    if q_lower.contains("format=der") {
        return PortalAssetKind::DerBinary;
    }
    if q_lower.contains("format=pem") {
        return PortalAssetKind::PemFile;
    }
    if q_lower.contains("format=crt") {
        return PortalAssetKind::X509CrtPem;
    }

    match clean_path.as_str() {
        "/ca.mobileconfig"
        | "/cert.mobileconfig"
        | "/fluxproxy.mobileconfig"
        | "/fluxproxy-root-ca.mobileconfig"
        | "/ios"
        | "/profile" => PortalAssetKind::AppleMobileConfig,
        "/ca.crt" | "/cert.crt" | "/fluxproxy-root-ca.crt" | "/android" => {
            PortalAssetKind::X509CrtPem
        }
        "/ca.pem" | "/cert.pem" | "/fluxproxy-root-ca.pem" => PortalAssetKind::PemFile,
        "/ca.der" | "/ca.cer" | "/cert.der" | "/cert.cer" | "/fluxproxy-root-ca.der"
        | "/fluxproxy-root-ca.cer" => PortalAssetKind::DerBinary,
        "/cert" => {
            let ua = user_agent.to_ascii_lowercase();
            let is_ios = ua.contains("iphone")
                || ua.contains("ipad")
                || ua.contains("ipod")
                || (ua.contains("macintosh") && ua.contains("mobile"));
            if is_ios {
                PortalAssetKind::AppleMobileConfig
            } else {
                PortalAssetKind::X509CrtPem
            }
        }
        _ => PortalAssetKind::HtmlLanding,
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_builtin_portal_request(
    req: Request<Incoming>,
    session_id: u64,
    scheme_str: &str,
    host_header: &str,
    path_and_query: &str,
    full_url: &str,
    alpn: Option<&str>,
    start: Instant,
    timestamp: String,
    client_addr: SocketAddr,
    client_proc: Option<&ClientProcessInfo>,
    ctx: &SharedProxyContext,
) -> Response<ProxyBoxBody> {
    let raw_path = req.uri().path();
    if raw_path.eq_ignore_ascii_case("/favicon.ico") {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(boxed_full(Bytes::new()))
            .unwrap();
    }

    let query = req.uri().query().unwrap_or("");
    let user_agent = req
        .headers()
        .get(http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let method_str = req.method().as_str().to_string();
    let req_version = req.version();
    let req_headers = extract_hyper_headers(req.headers());
    let client_ip_str = normalize_client_ip(client_addr);

    let asset = select_portal_asset(raw_path, query, user_agent);
    let (content_type, disposition, resp_bytes): (&str, Option<&str>, Bytes) = match asset {
        PortalAssetKind::AppleMobileConfig => (
            "application/x-apple-aspen-config",
            Some("attachment; filename=\"fluxproxy-root-ca.mobileconfig\""),
            Bytes::from(ctx.ca.root_ca_mobileconfig().into_bytes()),
        ),
        PortalAssetKind::X509CrtPem => (
            "application/x-x509-ca-cert",
            Some("attachment; filename=\"fluxproxy-root-ca.crt\""),
            Bytes::from(ctx.ca.root_ca_pem().as_bytes().to_vec()),
        ),
        PortalAssetKind::PemFile => (
            "application/x-pem-file",
            Some("attachment; filename=\"fluxproxy-root-ca.pem\""),
            Bytes::from(ctx.ca.root_ca_pem().as_bytes().to_vec()),
        ),
        PortalAssetKind::DerBinary => (
            "application/x-x509-ca-cert",
            Some("attachment; filename=\"fluxproxy-root-ca.der\""),
            Bytes::from(ctx.ca.root_ca_der().to_vec()),
        ),
        PortalAssetKind::HtmlLanding => {
            let info = ctx.ca.info();
            let html = render_mobile_portal_html(&client_ip_str, host_header, &info.sha256_fingerprint, user_agent);
            ("text/html; charset=utf-8", None, Bytes::from(html.into_bytes()))
        }
    };

    let mut resp_headers = vec![
        HeaderPair {
            name: "Content-Type".into(),
            value: content_type.into(),
        },
        HeaderPair {
            name: "Cache-Control".into(),
            value: "no-store, no-cache, must-revalidate".into(),
        },
        HeaderPair {
            name: "X-Content-Type-Options".into(),
            value: "nosniff".into(),
        },
    ];
    if let Some(disp) = disposition {
        resp_headers.push(HeaderPair {
            name: "Content-Disposition".into(),
            value: disp.into(),
        });
    }

    let protocol_label = resolve_protocol_label(scheme_str, alpn, req_version);
    let summary = SessionSummary {
        id: session_id,
        status: 200,
        protocol: protocol_label,
        scheme: scheme_str.to_string(),
        method: method_str,
        host: host_header.to_string(),
        path: path_and_query.to_string(),
        url: full_url.to_string(),
        content_type: content_type.to_string(),
        body_size: resp_bytes.len(),
        duration_ms: start.elapsed().as_millis() as u64,
        timestamp,
        is_mocked: false,
        matched_rule_id: None,
        error: None,
        process_name: client_proc.map(|p| p.name.clone()),
        process_pid: client_proc.map(|p| p.pid),
        tls_bypassed: false,
        headers_mutated: false,
        breakpoint_paused: None,
        breakpoint_modified: false,
        comment: None,
        marked_color: None,
        client_ip: Some(client_ip_str),
    };

    let detail = SessionDetail {
        summary: summary.clone(),
        request_headers: req_headers,
        response_headers: resp_headers.clone(),
        request_body_base64: String::new(),
        response_body_base64: base64::engine::general_purpose::STANDARD.encode(&resp_bytes),
        request_body_text: None,
        response_body_text: std::str::from_utf8(&resp_bytes).ok().map(str::to_owned),
        tls_version: if scheme_str == "https" {
            Some("TLS 1.3 (FluxProxy Portal)".into())
        } else {
            None
        },
        client_addr: client_addr.to_string(),
        websocket_frames: Vec::new(),
        sse_events: Vec::new(),
    };

    ctx.store.insert(detail);
    let _ = ctx.event_tx.send(summary);

    let mut builder = Response::builder().status(StatusCode::OK);
    for h in &resp_headers {
        builder = builder.header(&h.name, &h.value);
    }
    builder
        .body(boxed_full(resp_bytes))
        .unwrap_or_else(|_| plain_response(StatusCode::INTERNAL_SERVER_ERROR, "Portal build error"))
}

fn render_mobile_portal_html(
    client_ip: &str,
    host_header: &str,
    fingerprint: &str,
    user_agent: &str,
) -> String {
    let ua = user_agent.to_ascii_lowercase();
    let is_ios = ua.contains("iphone")
        || ua.contains("ipad")
        || ua.contains("ipod")
        || (ua.contains("macintosh") && ua.contains("mobile"));
    let is_android = ua.contains("android");

    let detected_badge = if is_ios {
        "Определено устройство: iOS / iPadOS"
    } else if is_android {
        "Определено устройство: Android"
    } else {
        "Подключение к FluxProxy активно"
    };

    let ios_btn_class = if is_ios || !is_android { "btn btn-primary" } else { "btn btn-secondary" };
    let android_btn_class = if is_android { "btn btn-primary" } else { "btn btn-secondary" };

    format!(
        r#"<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FluxProxy — Установка Root CA сертификата</title>
  <style>
    :root {{
      color-scheme: dark light;
      --bg: #0b0f17;
      --card: #131a26;
      --border: #253247;
      --fg: #f1f5f9;
      --muted: #94a3b8;
      --accent: #3b82f6;
      --accent-fg: #ffffff;
      --ok-bg: rgba(16, 185, 129, 0.14);
      --ok-fg: #34d399;
    }}
    @media (prefers-color-scheme: light) {{
      :root {{
        --bg: #f8fafc;
        --card: #ffffff;
        --border: #e2e8f0;
        --fg: #0f172a;
        --muted: #475569;
        --accent: #2563eb;
        --ok-bg: rgba(16, 185, 129, 0.12);
        --ok-fg: #059669;
      }}
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      padding: 20px 16px 40px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.5;
    }}
    .wrap {{ max-width: 540px; margin: 0 auto; }}
    .card {{
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 22px 20px;
      margin-bottom: 16px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
    }}
    .pill {{
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: var(--ok-bg);
      color: var(--ok-fg);
      margin-bottom: 10px;
    }}
    h1 {{ margin: 0 0 6px; font-size: 22px; letter-spacing: -0.02em; }}
    h2 {{ margin: 0 0 10px; font-size: 15px; }}
    p {{ margin: 0 0 14px; font-size: 14px; color: var(--muted); }}
    .meta {{
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      color: var(--muted);
      margin-bottom: 16px;
      word-break: break-all;
    }}
    .actions {{ display: flex; flex-direction: column; gap: 10px; }}
    .btn {{
      display: block;
      text-align: center;
      text-decoration: none;
      padding: 13px 16px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 15px;
      transition: opacity 0.15s;
    }}
    .btn:active {{ opacity: 0.8; }}
    .btn-primary {{
      background: var(--accent);
      color: var(--accent-fg);
    }}
    .btn-secondary {{
      border: 1px solid var(--border);
      color: var(--fg);
      background: transparent;
    }}
    .alt-links {{
      margin-top: 12px;
      display: flex;
      gap: 14px;
      justify-content: center;
      font-size: 13px;
    }}
    .alt-links a {{ color: var(--accent); text-decoration: none; font-weight: 500; }}
    ol {{ margin: 0; padding-left: 20px; font-size: 13.5px; color: var(--muted); }}
    li {{ margin-bottom: 8px; }}
    strong {{ color: var(--fg); }}
    code {{
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      padding: 1px 5px;
      border-radius: 4px;
      border: 1px solid var(--border);
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="pill">● {detected_badge}</div>
      <h1>FluxProxy Root CA</h1>
      <p>Установите корневой сертификат для расшифровки HTTPS и WSS трафика с вашего устройства.</p>
      <div class="meta">Client IP: <strong>{client_ip}</strong> • Proxy: <strong>{host_header}</strong></div>
      <div class="actions">
        <a class="{ios_btn_class}" href="/ca.mobileconfig">Установить профиль iOS / iPadOS (.mobileconfig)</a>
        <a class="{android_btn_class}" href="/ca.crt">Скачать сертификат Android / Desktop (.crt)</a>
      </div>
      <div class="alt-links">
        <a href="/cert">Авто (/cert)</a>
        <a href="/ca.der">DER (.der)</a>
        <a href="/ca.pem">PEM (.pem)</a>
      </div>
    </div>

    <div class="card">
      <h2>iOS / iPadOS (Safari)</h2>
      <ol>
        <li>Нажмите <strong>Установить профиль iOS (.mobileconfig)</strong> выше и подтвердите <strong>Разрешить</strong> в Safari.</li>
        <li>Откройте <strong>Настройки → Профиль загружен</strong> и нажмите <strong>Установить</strong>.</li>
        <li>Перейдите в <strong>Настройки → Основные → Об этом устройстве → Доверие сертификатам</strong> и включите тумблер для <strong>FluxProxy Local Debugging Root CA</strong>.</li>
      </ol>
    </div>

    <div class="card">
      <h2>Android</h2>
      <ol>
        <li>Нажмите <strong>Скачать сертификат Android (.crt)</strong>.</li>
        <li>Откройте <strong>Настройки → Безопасность → Шифрование и учетные данные → Установить сертификат → Сертификат CA</strong> (нажмите «Все равно установить») и выберите скачанный файл.</li>
        <li>Для отладки собственных приложений на Android 7+ добавьте <code>&lt;certificates src="user" /&gt;</code> в <code>res/xml/network_security_config.xml</code>.</li>
      </ol>
      <div class="meta" style="margin-top:12px;margin-bottom:0">SHA-256: {fingerprint}</div>
    </div>
  </div>
</body>
</html>
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        BreakpointConfig, BreakpointResolution, ProxyFilterBackendConfig, TlsBypassRule,
        TlsInterceptMode,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
        });
        let store = Arc::new(TrafficStore::new(tmp_dir.join("test.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            store: store.clone(),
            upstream_client: reqwest::Client::builder().no_proxy().build().unwrap(),
            event_tx,
            active_port: AtomicU16::new(0),
        });

        // 3. Bind outer proxy listener and issue CONNECT tunnel
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let proxy_ctx = ctx.clone();

        tokio::spawn(async move {
            if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let proc_info = resolve_client_process(client_addr, Some(proxy_addr.port()));
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let c = proxy_ctx.clone();
                    let p = proc_info.clone();
                    async move {
                        Ok::<_, Infallible>(handle_outer_proxy_request(req, client_addr, p, c).await)
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
        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints: breakpoints.clone(),
            store: store.clone(),
            upstream_client: reqwest::Client::builder().no_proxy().build().unwrap(),
            event_tx,
            active_port: AtomicU16::new(0),
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
                            handle_outer_proxy_request(req, client_addr, None, c).await,
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
        let ctx = Arc::new(SharedProxyContext {
            ca,
            rules,
            filters,
            breakpoints,
            store: store.clone(),
            upstream_client: reqwest::Client::builder().no_proxy().build().unwrap(),
            event_tx,
            active_port: AtomicU16::new(0),
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
                            handle_outer_proxy_request(req, client_addr, None, c).await,
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
        });

        let store = Arc::new(TrafficStore::new(tmp_dir.join("targeted.sqlite")).unwrap());
        let (event_tx, _event_rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(SharedProxyContext {
            ca: ca.clone(),
            rules: rules.clone(),
            filters,
            breakpoints,
            store: store.clone(),
            upstream_client: reqwest::Client::builder().no_proxy().build().unwrap(),
            event_tx,
            active_port: AtomicU16::new(0),
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
            response_headers: vec![HeaderPair {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }],
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
                                    handle_outer_proxy_request(req, client_addr, None, inner_c)
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

        // Bind on 0.0.0.0:0 ("Allow remote connections / Listen on all network interfaces")
        let proxy_listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
        let bound_port = proxy_listener.local_addr().unwrap().port();

        let ctx = Arc::new(SharedProxyContext {
            ca: ca.clone(),
            rules,
            filters,
            breakpoints,
            store: store.clone(),
            upstream_client: reqwest::Client::builder().no_proxy().build().unwrap(),
            event_tx,
            active_port: AtomicU16::new(bound_port),
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
                                handle_outer_proxy_request(req, client_addr, None, inner_c).await,
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
                HeaderPair {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                },
                HeaderPair {
                    name: "alt-svc".into(),
                    value: "h3=\":443\"; ma=2592000".into(),
                },
                HeaderPair {
                    name: "alternate-protocol".into(),
                    value: "443:quic".into(),
                },
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
            store: store.clone(),
            upstream_client: reqwest::Client::builder().no_proxy().build().unwrap(),
            event_tx,
            active_port: AtomicU16::new(proxy_addr.port()),
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
                                handle_outer_proxy_request(req, client_addr, None, inner_c).await,
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
}
