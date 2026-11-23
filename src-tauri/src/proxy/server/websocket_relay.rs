use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::Bytes;
use chrono::Utc;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use http::header::UPGRADE;
use http::{Request, Response, StatusCode};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use rustls_pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::models::{
    HeaderMutationDirection, HeaderPair, ProxyError, SessionDetail, SessionSummary, SessionTimings,
    SessionTransferStats, UpstreamProxyProtocol, WebSocketFrameRecord, WsInjectDirection,
};
use crate::proxy::filters::is_alt_svc_header;
use crate::proxy::hosts::HostRemapRegistry;
use crate::proxy::network::normalize_client_ip;
use crate::proxy::process::ClientProcessInfo;
use crate::proxy::throttle::ThrottledStream;
use crate::proxy::upstream_client::{
    default_root_store, duration_ms_f64, elapsed_ms, estimate_request_headers_bytes,
    estimate_response_headers_bytes, extract_peer_cert_subject_issuer, format_rfc3339_micros,
    format_tls_cipher, format_tls_protocol, timestamp_at_instant,
};
use crate::proxy::upstream_proxy::{connect_tunnel_via_upstream, format_via_proxy_telemetry};

use super::http_handler::format_error_chain;
use super::{
    boxed_full, extract_hyper_headers, format_mitm_tls_display, format_raw_http_version,
    is_hop_by_hop_header, parse_host_and_optional_port, plain_response, record_and_return_error,
    record_and_return_error_with_opts, record_completed_session, should_use_host_mtls_for_peer,
    ClientConnContext, ProxyBoxBody, SharedProxyContext, MAX_CAPTURED_BODY_BYTES,
};

pub const MAX_WS_INJECT_PAYLOAD_BYTES: usize = 16 * 1024 * 1024; // 16 MiB safety cap

pub struct WsInjectCommand {
    pub direction: WsInjectDirection,
    pub message: Message,
    pub ack_tx: oneshot::Sender<Result<WebSocketFrameRecord, String>>,
}

struct ActiveWsChannelGuard {
    channels: Arc<DashMap<u64, mpsc::UnboundedSender<WsInjectCommand>>>,
    session_id: u64,
}

impl Drop for ActiveWsChannelGuard {
    fn drop(&mut self) {
        self.channels.remove(&self.session_id);
    }
}

pub fn parse_hex_payload(raw: &str) -> Result<Vec<u8>, ProxyError> {
    let mut hex_chars = String::with_capacity(raw.len());
    for token in raw.split(|c: char| c.is_whitespace() || c == ':' || c == '-' || c == ',') {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            continue;
        }
        let stripped = trimmed
            .strip_prefix("0x")
            .or_else(|| trimmed.strip_prefix("0X"))
            .unwrap_or(trimmed);
        hex_chars.push_str(stripped);
    }
    if hex_chars.is_empty() {
        return Ok(Vec::new());
    }
    if hex_chars.len() % 2 != 0 {
        return Err(ProxyError::Custom(
            "Некорректный Hex payload: ожидается чётное количество hex-символов.".into(),
        ));
    }
    if hex_chars.len() / 2 > MAX_WS_INJECT_PAYLOAD_BYTES {
        return Err(ProxyError::Custom(format!(
            "Размер бинарного WebSocket-фрейма превышает лимит {MAX_WS_INJECT_PAYLOAD_BYTES} байт."
        )));
    }
    hex::decode(&hex_chars)
        .map_err(|e| ProxyError::Custom(format!("Некорректный Hex payload: {e}")))
}

struct WsServerConnTelemetry {
    server_addr: Option<String>,
    server_ip: Option<String>,
    server_port: Option<u16>,
    via_proxy_addr: Option<String>,
    dns_ms: Option<f64>,
    tcp_connect_ms: Option<f64>,
    tls_handshake_ms: Option<f64>,
    server_connected_at: Option<String>,
    server_tls_version: Option<String>,
    server_tls_cipher: Option<String>,
    server_tls_alpn: Option<String>,
    server_cert_subject: Option<String>,
    server_cert_issuer: Option<String>,
    server_mtls_cn: Option<String>,
}

struct WsTcpConnectResult {
    stream: tokio::net::TcpStream,
    peer_addr: SocketAddr,
    dns_ms: f64,
    tcp_connect_ms: f64,
}

async fn measure_ws_tcp_connect(
    connect_host: &str,
    connect_port: u16,
    timeout: Duration,
) -> Result<WsTcpConnectResult, String> {
    let deadline = Instant::now() + timeout;
    let clean_host = connect_host.trim().trim_matches(['[', ']']);
    let (addrs, dns_ms): (Vec<SocketAddr>, f64) = if let Ok(ip) = clean_host.parse::<IpAddr>() {
        (vec![SocketAddr::new(ip, connect_port)], 0.0)
    } else {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "WebSocket DNS lookup timed out for {connect_host}:{connect_port}"
            ));
        }
        let dns_start = Instant::now();
        let resolved_iter = tokio::time::timeout(
            remaining,
            tokio::net::lookup_host((clean_host, connect_port)),
        )
        .await
        .map_err(|_| {
            format!("WebSocket DNS lookup timed out for {connect_host}:{connect_port}")
        })?
        .map_err(|e| {
            format!("WebSocket DNS lookup failed for {connect_host}:{connect_port}: {e}")
        })?;
        let collected: Vec<SocketAddr> = resolved_iter.collect();
        if collected.is_empty() {
            return Err(format!(
                "WebSocket DNS lookup returned no addresses for {connect_host}:{connect_port}"
            ));
        }
        (collected, elapsed_ms(dns_start))
    };

    let tcp_start = Instant::now();
    let mut tcp_opt = None;
    let mut last_err = None;
    for addr in addrs {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            last_err = Some(format!("timed out after {}s", timeout.as_secs()));
            break;
        }
        match tokio::time::timeout(remaining, tokio::net::TcpStream::connect(addr)).await {
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                tcp_opt = Some(stream);
                break;
            }
            Ok(Err(e)) => last_err = Some(format!("{addr}: {e}")),
            Err(_) => last_err = Some(format!("{addr}: timed out")),
        }
    }

    let stream = tcp_opt.ok_or_else(|| {
        format!(
            "WebSocket TCP connect failed for {connect_host}:{connect_port}: {}",
            last_err.unwrap_or_else(|| "no reachable address".to_string())
        )
    })?;
    let tcp_connect_ms = elapsed_ms(tcp_start);
    let peer_addr = stream
        .peer_addr()
        .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], connect_port)));
    Ok(WsTcpConnectResult {
        stream,
        peer_addr,
        dns_ms,
        tcp_connect_ms,
    })
}

fn build_ws_tls_config(
    ctx: &SharedProxyContext,
    target_host: &str,
    client_addr: SocketAddr,
    ws_scheme: &str,
) -> Result<(Arc<rustls::ClientConfig>, Option<String>), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|err| format!("WebSocket TLS config error: {err}"))?
        .with_root_certificates(default_root_store());

    let (mut tls_cfg, mtls_cn) = if should_use_host_mtls_for_peer(client_addr, ws_scheme) {
        match ctx.client_certs.load_rustls_client_auth_for_host(target_host) {
            Ok(Some((certs, key, entry))) => {
                let cfg = builder.with_client_auth_cert(certs, key).map_err(|err| {
                    format!("WebSocket mTLS client certificate error for '{target_host}': {err}")
                })?;
                (cfg, Some(entry.common_name))
            }
            Ok(None) => (builder.with_no_client_auth(), None),
            Err(err) => {
                return Err(format!(
                    "WebSocket mTLS client certificate error for '{target_host}': {err}"
                ));
            }
        }
    } else {
        (builder.with_no_client_auth(), None)
    };

    tls_cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok((Arc::new(tls_cfg), mtls_cn))
}

#[allow(clippy::type_complexity)]
fn extract_ws_tls_fields(
    conn: &rustls::ClientConnection,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let (cert_subject, cert_issuer) = conn
        .peer_certificates()
        .and_then(|certs| certs.first())
        .map(|leaf| extract_peer_cert_subject_issuer(leaf.as_ref()))
        .unwrap_or((None, None));
    (
        conn.protocol_version().map(format_tls_protocol),
        conn.negotiated_cipher_suite().map(format_tls_cipher),
        conn.alpn_protocol()
            .map(|b| String::from_utf8_lossy(b).into_owned()),
        cert_subject,
        cert_issuer,
    )
}

struct WsConnTimingInput {
    dns_ms: f64,
    tcp_connect_ms: f64,
    tls_handshake_ms: Option<f64>,
    server_connected_at: String,
}

fn extract_direct_ws_plain_telemetry(
    peer_addr: SocketAddr,
    timing: WsConnTimingInput,
) -> WsServerConnTelemetry {
    WsServerConnTelemetry {
        server_addr: Some(peer_addr.to_string()),
        server_ip: Some(peer_addr.ip().to_string()),
        server_port: Some(peer_addr.port()),
        via_proxy_addr: None,
        dns_ms: Some(timing.dns_ms),
        tcp_connect_ms: Some(timing.tcp_connect_ms),
        tls_handshake_ms: timing.tls_handshake_ms,
        server_connected_at: Some(timing.server_connected_at),
        server_tls_version: None,
        server_tls_cipher: None,
        server_tls_alpn: None,
        server_cert_subject: None,
        server_cert_issuer: None,
        server_mtls_cn: None,
    }
}

fn extract_direct_ws_tls_telemetry(
    peer_addr: SocketAddr,
    conn: &rustls::ClientConnection,
    timing: WsConnTimingInput,
    mtls_cn: Option<String>,
) -> WsServerConnTelemetry {
    let (tls_ver, tls_cipher, tls_alpn, cert_subject, cert_issuer) = extract_ws_tls_fields(conn);
    WsServerConnTelemetry {
        server_addr: Some(peer_addr.to_string()),
        server_ip: Some(peer_addr.ip().to_string()),
        server_port: Some(peer_addr.port()),
        via_proxy_addr: None,
        dns_ms: Some(timing.dns_ms),
        tcp_connect_ms: Some(timing.tcp_connect_ms),
        tls_handshake_ms: timing.tls_handshake_ms,
        server_connected_at: Some(timing.server_connected_at),
        server_tls_version: tls_ver,
        server_tls_cipher: tls_cipher,
        server_tls_alpn: tls_alpn,
        server_cert_subject: cert_subject,
        server_cert_issuer: cert_issuer,
        server_mtls_cn: mtls_cn,
    }
}

fn extract_proxied_ws_tls_telemetry(
    proxy_protocol: UpstreamProxyProtocol,
    proxy_addr: SocketAddr,
    conn: &rustls::ClientConnection,
    timing: WsConnTimingInput,
    mtls_cn: Option<String>,
) -> WsServerConnTelemetry {
    let (via_proxy_addr, via_server_ip) = format_via_proxy_telemetry(proxy_protocol, proxy_addr);
    let (tls_ver, tls_cipher, tls_alpn, cert_subject, cert_issuer) = extract_ws_tls_fields(conn);
    WsServerConnTelemetry {
        server_addr: None,
        server_ip: Some(via_server_ip),
        server_port: None,
        via_proxy_addr: Some(via_proxy_addr),
        dns_ms: Some(timing.dns_ms),
        tcp_connect_ms: Some(timing.tcp_connect_ms),
        tls_handshake_ms: timing.tls_handshake_ms,
        server_connected_at: Some(timing.server_connected_at),
        server_tls_version: tls_ver,
        server_tls_cipher: tls_cipher,
        server_tls_alpn: tls_alpn,
        server_cert_subject: cert_subject,
        server_cert_issuer: cert_issuer,
        server_mtls_cn: mtls_cn,
    }
}

fn extract_proxied_ws_plain_telemetry(
    proxy_protocol: UpstreamProxyProtocol,
    proxy_addr: SocketAddr,
    timing: WsConnTimingInput,
) -> WsServerConnTelemetry {
    let (via_proxy_addr, via_server_ip) = format_via_proxy_telemetry(proxy_protocol, proxy_addr);
    WsServerConnTelemetry {
        server_addr: None,
        server_ip: Some(via_server_ip),
        server_port: None,
        via_proxy_addr: Some(via_proxy_addr),
        dns_ms: Some(timing.dns_ms),
        tcp_connect_ms: Some(timing.tcp_connect_ms),
        tls_handshake_ms: timing.tls_handshake_ms,
        server_connected_at: Some(timing.server_connected_at),
        server_tls_version: None,
        server_tls_cipher: None,
        server_tls_alpn: None,
        server_cert_subject: None,
        server_cert_issuer: None,
        server_mtls_cn: None,
    }
}

struct WsHandshakeContext {
    session_id: u64,
    ws_scheme: &'static str,
    host_header: String,
    path_and_query: String,
    full_url: String,
    timestamp: String,
    start: Instant,
    start_utc: chrono::DateTime<Utc>,
    req_begin_at: String,
    proxy_begin_at: String,
    ws_connect_start: Instant,
    client_addr: SocketAddr,
    client_proc: Option<ClientProcessInfo>,
    client_conn: ClientConnContext,
    client_reused: bool,
    client_tls_ms: Option<f64>,
    client_http_ver: String,
    req_headers: Vec<HeaderPair>,
    req_headers_bytes: usize,
    req_mutated: bool,
    accept_key: String,
    remapped_to: Option<String>,
}

#[allow(clippy::result_large_err)]
fn handle_ws_handshake_http_rejection(
    ctx: &Arc<SharedProxyContext>,
    hs: WsHandshakeContext,
    http_resp: tokio_tungstenite::tungstenite::handshake::client::Response,
) -> Response<ProxyBoxBody> {
    let status = http_resp.status();
    let got_resp_instant = Instant::now();
    let got_resp_at = timestamp_at_instant(hs.start, hs.start_utc, got_resp_instant);
    let handshake_ms =
        duration_ms_f64(got_resp_instant.saturating_duration_since(hs.ws_connect_start));
    let overall_ms = elapsed_ms(hs.start);
    let mut resp_headers = extract_hyper_headers(http_resp.headers());
    let resp_mutated = ctx.filters.apply_header_mutations(
        HeaderMutationDirection::Response,
        &hs.full_url,
        &mut resp_headers,
    );
    let resp_bytes = Bytes::from(http_resp.into_body().unwrap_or_default());
    let resp_headers_bytes =
        estimate_response_headers_bytes(status.as_u16(), "HTTP/1.1", &resp_headers);
    let content_type = resp_headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("content-type"))
        .map(|h| h.value.clone())
        .unwrap_or_else(|| "text/plain".to_string());

    let timings = SessionTimings {
        client_connected: Some(hs.client_conn.connected_at.clone()),
        client_begin_request: Some(hs.req_begin_at.clone()),
        got_request_headers: Some(hs.req_begin_at.clone()),
        client_done_request: Some(hs.req_begin_at),
        proxy_begin_request: Some(hs.proxy_begin_at),
        got_response_headers: Some(got_resp_at.clone()),
        server_done_response: Some(got_resp_at.clone()),
        client_begin_response: Some(got_resp_at.clone()),
        client_done_response: Some(got_resp_at),
        client_read_ms: Some(0.0),
        client_tls_handshake_ms: hs.client_tls_ms,
        server_wait_ms: Some(handshake_ms),
        overall_elapsed_ms: Some(overall_ms),
        net_elapsed_ms: Some(overall_ms),
        ..Default::default()
    };
    let transfer_stats = SessionTransferStats {
        request_headers_bytes: Some(hs.req_headers_bytes),
        request_body_bytes: Some(0),
        request_wire_body_bytes: Some(0),
        response_headers_bytes: Some(resp_headers_bytes),
        response_body_bytes: Some(resp_bytes.len()),
        response_wire_body_bytes: Some(resp_bytes.len()),
        client_conn_id: Some(hs.client_conn.conn_id),
        client_conn_reused: Some(hs.client_reused),
        client_http_version: Some(hs.client_http_ver),
        client_tls_version: hs.client_conn.client_tls_version.clone(),
        client_tls_cipher: hs.client_conn.client_tls_cipher.clone(),
        client_alpn: hs.client_conn.client_alpn.clone(),
        server_http_version: Some("HTTP/1.1".to_string()),
        server_conn_reused: Some(false),
        remapped_target: hs.remapped_to.clone(),
        ..Default::default()
    };

    let mut summary = SessionSummary {
        id: hs.session_id,
        status: status.as_u16(),
        protocol: hs.ws_scheme.to_ascii_uppercase(),
        scheme: hs.ws_scheme.to_string(),
        method: "GET".to_string(),
        host: hs.host_header,
        path: hs.path_and_query,
        url: hs.full_url,
        content_type,
        body_size: resp_bytes.len(),
        duration_ms: hs.start.elapsed().as_millis() as u64,
        timestamp: hs.timestamp,
        is_mocked: false,
        matched_rule_id: None,
        error: None,
        process_name: hs.client_proc.as_ref().map(|p| p.name.clone()),
        process_pid: hs.client_proc.as_ref().map(|p| p.pid),
        tls_bypassed: false,
        headers_mutated: hs.req_mutated || resp_mutated,
        breakpoint_paused: None,
        breakpoint_modified: false,
        comment: None,
        marked_color: None,
        client_ip: Some(normalize_client_ip(hs.client_addr)),
        remapped_to: hs.remapped_to,
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
    summary.apply_telemetry(Some(&timings), Some(&transfer_stats));

    let capped = &resp_bytes[..resp_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
    let detail = SessionDetail {
        summary,
        request_headers: hs.req_headers,
        response_headers: resp_headers.clone(),
        request_body_base64: String::new(),
        response_body_base64: base64::engine::general_purpose::STANDARD.encode(capped),
        request_body_text: None,
        response_body_text: std::str::from_utf8(capped).ok().map(str::to_owned),
        tls_version: format_mitm_tls_display(
            hs.ws_scheme,
            hs.client_conn.client_tls_version.as_deref(),
            Some("WSS"),
            None,
        ),
        client_addr: hs.client_addr.to_string(),
        websocket_frames: Vec::new(),
        sse_events: Vec::new(),
        body_offloaded: false,
        request_body_offloaded: false,
        timings: Some(timings),
        transfer_stats: Some(transfer_stats),
    };

    record_completed_session(ctx, detail, None, None);

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
    rej_resp
}

async fn recv_inject_or_pending(
    rx: &mut Option<mpsc::UnboundedReceiver<WsInjectCommand>>,
) -> WsInjectCommand {
    match rx.as_mut() {
        Some(inner) => match inner.recv().await {
            Some(cmd) => cmd,
            None => {
                *rx = None;
                std::future::pending().await
            }
        },
        None => std::future::pending().await,
    }
}

fn finish_ws_handshake_and_spawn<S>(
    req: Request<Incoming>,
    upstream_ws: WebSocketStream<S>,
    upstream_handshake_resp: tokio_tungstenite::tungstenite::handshake::client::Response,
    server_tel: WsServerConnTelemetry,
    hs: WsHandshakeContext,
    ctx: Arc<SharedProxyContext>,
) -> Response<ProxyBoxBody>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let session_id = hs.session_id;
    let got_resp_instant = Instant::now();
    let got_resp_at = timestamp_at_instant(hs.start, hs.start_utc, got_resp_instant);
    let handshake_ms =
        duration_ms_f64(got_resp_instant.saturating_duration_since(hs.ws_connect_start));
    let overall_init_ms = elapsed_ms(hs.start);

    let mut resp_headers = extract_hyper_headers(upstream_handshake_resp.headers());
    let resp_mutated = ctx.filters.apply_header_mutations(
        HeaderMutationDirection::Response,
        &hs.full_url,
        &mut resp_headers,
    );
    let resp_headers_bytes = estimate_response_headers_bytes(101, "HTTP/1.1", &resp_headers);

    let initial_timings = SessionTimings {
        client_connected: Some(hs.client_conn.connected_at.clone()),
        client_begin_request: Some(hs.req_begin_at.clone()),
        got_request_headers: Some(hs.req_begin_at.clone()),
        client_done_request: Some(hs.req_begin_at),
        proxy_begin_request: Some(hs.proxy_begin_at),
        server_connected: server_tel.server_connected_at,
        got_response_headers: Some(got_resp_at.clone()),
        client_begin_response: Some(got_resp_at),
        client_read_ms: Some(0.0),
        client_tls_handshake_ms: hs.client_tls_ms,
        dns_ms: server_tel.dns_ms,
        tcp_connect_ms: server_tel.tcp_connect_ms,
        tls_handshake_ms: server_tel.tls_handshake_ms,
        server_wait_ms: Some(handshake_ms),
        overall_elapsed_ms: Some(overall_init_ms),
        net_elapsed_ms: Some(overall_init_ms),
        ..Default::default()
    };
    let initial_stats = SessionTransferStats {
        request_headers_bytes: Some(hs.req_headers_bytes),
        request_body_bytes: Some(0),
        request_wire_body_bytes: Some(0),
        response_headers_bytes: Some(resp_headers_bytes),
        response_body_bytes: Some(0),
        response_wire_body_bytes: Some(0),
        client_conn_id: Some(hs.client_conn.conn_id),
        client_conn_reused: Some(hs.client_reused),
        client_http_version: Some(hs.client_http_ver),
        client_tls_version: hs.client_conn.client_tls_version.clone(),
        client_tls_cipher: hs.client_conn.client_tls_cipher.clone(),
        client_alpn: hs.client_conn.client_alpn.clone(),
        server_addr: server_tel.server_addr,
        server_ip: server_tel.server_ip,
        server_port: server_tel.server_port,
        server_conn_reused: Some(false),
        server_http_version: Some("HTTP/1.1".to_string()),
        server_tls_version: server_tel.server_tls_version,
        server_tls_cipher: server_tel.server_tls_cipher,
        server_tls_alpn: server_tel.server_tls_alpn,
        server_cert_subject: server_tel.server_cert_subject,
        server_cert_issuer: server_tel.server_cert_issuer,
        server_mtls_cn: server_tel.server_mtls_cn.clone(),
        remapped_target: hs.remapped_to.clone(),
        via_proxy_addr: server_tel.via_proxy_addr,
        is_streaming: Some(true),
        ..Default::default()
    };

    let mut summary = SessionSummary {
        id: session_id,
        status: 101,
        protocol: hs.ws_scheme.to_ascii_uppercase(),
        scheme: hs.ws_scheme.to_string(),
        method: "GET".to_string(),
        host: hs.host_header,
        path: hs.path_and_query,
        url: hs.full_url,
        content_type: "websocket/frames".to_string(),
        body_size: 0,
        duration_ms: hs.start.elapsed().as_millis() as u64,
        timestamp: hs.timestamp,
        is_mocked: false,
        matched_rule_id: None,
        error: None,
        process_name: hs.client_proc.as_ref().map(|p| p.name.clone()),
        process_pid: hs.client_proc.as_ref().map(|p| p.pid),
        tls_bypassed: false,
        headers_mutated: hs.req_mutated || resp_mutated,
        breakpoint_paused: None,
        breakpoint_modified: false,
        comment: None,
        marked_color: None,
        client_ip: Some(normalize_client_ip(hs.client_addr)),
        remapped_to: hs.remapped_to,
        ttfb_ms: None,
        dns_ms: None,
        connect_ms: None,
        tls_ms: None,
        receive_ms: None,
        request_size: None,
        wire_body_size: None,
        server_ip: None,
        server_conn_reused: None,
        ws_open: Some(true),
    };
    summary.apply_telemetry(Some(&initial_timings), Some(&initial_stats));

    let initial_detail = SessionDetail {
        summary,
        request_headers: hs.req_headers,
        response_headers: resp_headers.clone(),
        request_body_base64: String::new(),
        response_body_base64: String::new(),
        request_body_text: None,
        response_body_text: Some("[WebSocket Tunnel Established — Inspect Frames]".into()),
        tls_version: format_mitm_tls_display(
            hs.ws_scheme,
            hs.client_conn.client_tls_version.as_deref(),
            Some("WSS"),
            server_tel.server_mtls_cn.as_deref(),
        ),
        client_addr: hs.client_addr.to_string(),
        websocket_frames: Vec::new(),
        sse_events: Vec::new(),
        body_offloaded: false,
        request_body_offloaded: false,
        timings: Some(initial_timings),
        transfer_stats: Some(initial_stats),
    };

    record_completed_session(&ctx, initial_detail, None, None);
    let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();

    // Register channel BEFORE returning `101 Switching Protocols` so immediate injection after 101 works.
    let (inject_tx, mut inject_rx) = mpsc::unbounded_channel::<WsInjectCommand>();
    ctx.active_ws_channels.insert(session_id, inject_tx);
    let ws_guard = ActiveWsChannelGuard {
        channels: Arc::clone(&ctx.active_ws_channels),
        session_id,
    };

    let start = hs.start;
    let start_utc = hs.start_utc;
    let relay_ctx = Arc::clone(&ctx);

    tokio::spawn(async move {
        let _ws_guard = ws_guard;
        let total_bytes = Arc::new(AtomicUsize::new(0));
        let tx_bytes = Arc::new(AtomicUsize::new(0));
        let rx_bytes = Arc::new(AtomicUsize::new(0));
        let last_ipc_emit = Arc::new(std::sync::Mutex::new(None::<Instant>));

        if let Ok(upgraded) = hyper::upgrade::on(req).await {
            let client_ws =
                WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, None).await;

            let (mut client_sink, mut client_stream) = client_ws.split();
            let (mut upstream_sink, mut upstream_stream) = upstream_ws.split();

            const MAX_WS_FRAMES: usize = 500;
            const WS_IPC_THROTTLE_MS: u64 = 75;
            fn should_emit_ws_ipc(
                last_emit: &std::sync::Mutex<Option<Instant>>,
                force: bool,
            ) -> bool {
                let mut guard = match last_emit.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                let now = Instant::now();
                if force
                    || guard.map_or(true, |prev| {
                        now.saturating_duration_since(prev)
                            >= Duration::from_millis(WS_IPC_THROTTLE_MS)
                    })
                {
                    *guard = Some(now);
                    true
                } else {
                    false
                }
            }

            let (to_server_tx, to_server_rx) = mpsc::unbounded_channel::<WsInjectCommand>();
            let (to_client_tx, to_client_rx) = mpsc::unbounded_channel::<WsInjectCommand>();
            let mut to_server_rx_opt = Some(to_server_rx);
            let mut to_client_rx_opt = Some(to_client_rx);

            let inject_router = async move {
                while let Some(cmd) = inject_rx.recv().await {
                    let target = match cmd.direction {
                        WsInjectDirection::Server => &to_server_tx,
                        WsInjectDirection::Client => &to_client_tx,
                    };
                    if let Err(send_err) = target.send(cmd) {
                        let failed = send_err.0;
                        let _ = failed
                            .ack_tx
                            .send(Err("WebSocket relay channel is closing".to_string()));
                    }
                }
                std::future::pending::<()>().await;
            };

            let c2u_bytes = Arc::clone(&total_bytes);
            let c2u_tx = Arc::clone(&tx_bytes);
            let c2u_ctx = Arc::clone(&relay_ctx);
            let c2u_last_emit = Arc::clone(&last_ipc_emit);
            let client_to_upstream = async move {
                loop {
                    tokio::select! {
                        biased;
                        cmd = recv_inject_or_pending(&mut to_server_rx_opt) => {
                            let msg_len = cmd.message.len();
                            let mut frame = record_ws_frame(0, "outbound", &cmd.message, true);
                            if let Err(err) = upstream_sink.send(cmd.message).await {
                                let _ = cmd.ack_tx.send(Err(format!(
                                    "Failed sending injected frame to server: {err}"
                                )));
                                break;
                            }
                            c2u_tx.fetch_add(msg_len, Ordering::Relaxed);
                            let new_total = c2u_bytes.fetch_add(msg_len, Ordering::Relaxed) + msg_len;
                            if let Some((updated_summary, assigned_idx)) =
                                c2u_ctx.store.append_ws_frame_with_index(
                                    session_id,
                                    Some(frame.clone()),
                                    new_total,
                                    MAX_WS_FRAMES,
                                )
                            {
                                if let Some(idx) = assigned_idx {
                                    frame.index = idx;
                                }
                                if should_emit_ws_ipc(&c2u_last_emit, true) {
                                    let _ = c2u_ctx.event_tx.send(updated_summary);
                                }
                            }
                            let _ = cmd.ack_tx.send(Ok(frame));
                        }
                        maybe_msg = client_stream.next() => {
                            let Some(Ok(msg)) = maybe_msg else {
                                break;
                            };
                            let msg_len = msg.len();
                            c2u_tx.fetch_add(msg_len, Ordering::Relaxed);
                            let new_total = c2u_bytes.fetch_add(msg_len, Ordering::Relaxed) + msg_len;
                            let frame = record_ws_frame(0, "outbound", &msg, false);
                            if let Some((updated_summary, _)) =
                                c2u_ctx.store.append_ws_frame_with_index(
                                    session_id,
                                    Some(frame),
                                    new_total,
                                    MAX_WS_FRAMES,
                                )
                            {
                                if should_emit_ws_ipc(&c2u_last_emit, false) {
                                    let _ = c2u_ctx.event_tx.send(updated_summary);
                                }
                            }
                            if upstream_sink.send(msg).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                let _ = tokio::time::timeout(
                    Duration::from_millis(250),
                    upstream_sink.close(),
                )
                .await;
            };

            let u2c_bytes = Arc::clone(&total_bytes);
            let u2c_rx = Arc::clone(&rx_bytes);
            let u2c_ctx = Arc::clone(&relay_ctx);
            let u2c_last_emit = Arc::clone(&last_ipc_emit);
            let upstream_to_client = async move {
                loop {
                    tokio::select! {
                        biased;
                        cmd = recv_inject_or_pending(&mut to_client_rx_opt) => {
                            let msg_len = cmd.message.len();
                            let mut frame = record_ws_frame(0, "inbound", &cmd.message, true);
                            if let Err(err) = client_sink.send(cmd.message).await {
                                let _ = cmd.ack_tx.send(Err(format!(
                                    "Failed sending injected frame to client: {err}"
                                )));
                                break;
                            }
                            u2c_rx.fetch_add(msg_len, Ordering::Relaxed);
                            let new_total = u2c_bytes.fetch_add(msg_len, Ordering::Relaxed) + msg_len;
                            if let Some((updated_summary, assigned_idx)) =
                                u2c_ctx.store.append_ws_frame_with_index(
                                    session_id,
                                    Some(frame.clone()),
                                    new_total,
                                    MAX_WS_FRAMES,
                                )
                            {
                                if let Some(idx) = assigned_idx {
                                    frame.index = idx;
                                }
                                if should_emit_ws_ipc(&u2c_last_emit, true) {
                                    let _ = u2c_ctx.event_tx.send(updated_summary);
                                }
                            }
                            let _ = cmd.ack_tx.send(Ok(frame));
                        }
                        maybe_msg = upstream_stream.next() => {
                            let Some(Ok(msg)) = maybe_msg else {
                                break;
                            };
                            let msg_len = msg.len();
                            u2c_rx.fetch_add(msg_len, Ordering::Relaxed);
                            let new_total = u2c_bytes.fetch_add(msg_len, Ordering::Relaxed) + msg_len;
                            let frame = record_ws_frame(0, "inbound", &msg, false);
                            if let Some((updated_summary, _)) =
                                u2c_ctx.store.append_ws_frame_with_index(
                                    session_id,
                                    Some(frame),
                                    new_total,
                                    MAX_WS_FRAMES,
                                )
                            {
                                if should_emit_ws_ipc(&u2c_last_emit, false) {
                                    let _ = u2c_ctx.event_tx.send(updated_summary);
                                }
                            }
                            if client_sink.send(msg).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                let _ = tokio::time::timeout(
                    Duration::from_millis(250),
                    client_sink.close(),
                )
                .await;
            };

            tokio::select! {
                _ = client_to_upstream => {}
                _ = upstream_to_client => {}
                _ = inject_router => {}
            }
        }

        // Guarantee channel removal BEFORE emitting closed state so UI/API never sees a stale open handle.
        drop(_ws_guard);

        let _ = relay_ctx.store.finalize_ws_stream(session_id);
        let end_instant = Instant::now();
        let done_at = timestamp_at_instant(start, start_utc, end_instant);
        let overall_ms = elapsed_ms(start);
        let relay_ms = duration_ms_f64(end_instant.saturating_duration_since(got_resp_instant));
        let final_tx = tx_bytes.load(Ordering::Relaxed);
        let final_rx = rx_bytes.load(Ordering::Relaxed);

        if let Some(final_summary) = relay_ctx.store.update_session_telemetry(session_id, |detail| {
            detail.summary.ws_open = Some(false);
            detail.summary.duration_ms = start.elapsed().as_millis() as u64;
            let timings = detail.timings.get_or_insert_with(Default::default);
            timings.server_done_response = Some(done_at.clone());
            timings.client_done_response = Some(done_at);
            timings.content_download_ms = Some(relay_ms);
            timings.overall_elapsed_ms = Some(overall_ms);
            timings.net_elapsed_ms = Some(overall_ms);

            let stats = detail.transfer_stats.get_or_insert_with(Default::default);
            stats.is_streaming = Some(false);
            stats.request_wire_body_bytes = Some(final_tx);
            stats.request_body_bytes = Some(final_tx);
            stats.response_wire_body_bytes = Some(final_rx);
            stats.response_body_bytes = Some(final_rx);
            let timings_clone = detail.timings.clone();
            let stats_clone = detail.transfer_stats.clone();
            detail
                .summary
                .apply_telemetry(timings_clone.as_ref(), stats_clone.as_ref());
        }) {
            let _ = relay_ctx.event_tx.send(final_summary);
        }
    });

    let mut client_resp = Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(http::header::CONNECTION, "Upgrade")
        .header(UPGRADE, "websocket")
        .header("Sec-WebSocket-Accept", hs.accept_key)
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

/// Intercepts `ws://` and decrypted `wss://` WebSocket connections, relaying frames
/// bidirectionally while recording frame metadata in `TrafficStore`, routing through
/// `upstream_proxy` (unless matched by `bypass_list`), and supporting live frame injection.
#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_websocket_intercept(
    req: Request<Incoming>,
    session_id: u64,
    scheme: &str,
    host_header: String,
    path_and_query: String,
    full_url: String,
    timestamp: String,
    client_addr: SocketAddr,
    client_proc: Option<ClientProcessInfo>,
    client_conn: ClientConnContext,
    ctx: Arc<SharedProxyContext>,
) -> Response<ProxyBoxBody> {
    let start = Instant::now();
    let start_utc = Utc::now();
    let req_begin_at = format_rfc3339_micros(start_utc);
    let client_http_ver = format_raw_http_version(req.version()).to_string();
    let (client_reused, client_tls_ms) = client_conn.claim_request_seq();
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
    let req_headers_bytes =
        estimate_request_headers_bytes("GET", &path_and_query, &client_http_ver, &req_headers);

    let mut ws_req = match build_upstream_websocket_request(&ws_url, &req_headers) {
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

    let (target_host, opt_port) = parse_host_and_optional_port(&host_header);
    let target_port = opt_port.unwrap_or(if ws_scheme == "wss" { 443 } else { 80 });
    let remapped = ctx
        .host_remap
        .resolve_connect_target(&target_host, target_port);
    let (connect_host, connect_port, remapped_to) = match &remapped {
        Some((h, p, rule)) => {
            if !rule.preserve_host_header {
                let default_ws_port = if ws_scheme == "wss" { 443 } else { 80 };
                let h_fmt = HostRemapRegistry::format_host_for_authority(h);
                let new_host_val = if *p != default_ws_port {
                    format!("{h_fmt}:{p}")
                } else {
                    h_fmt
                };
                if let Ok(hv) = http::header::HeaderValue::from_str(&new_host_val) {
                    ws_req.headers_mut().insert(http::header::HOST, hv);
                }
            }
            (
                h.clone(),
                *p,
                Some(HostRemapRegistry::format_remap_target(
                    rule,
                    rule.target_port,
                )),
            )
        }
        None => (target_host.clone(), target_port, None),
    };

    if let Err(err) = ctx.throttle.apply_latency().await {
        return record_and_return_error_with_opts(
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
            StatusCode::SERVICE_UNAVAILABLE,
            remapped_to,
            err.to_string(),
        );
    }

    let active_upstream_proxy = ctx.upstream_proxy.resolve_for_target(
        &target_host,
        target_port,
        remapped.as_ref().map(|_| connect_host.as_str()),
        remapped.as_ref().map(|_| connect_port),
    );

    let connect_timeout = ctx.connect_timeout();
    let ws_connect_start = Instant::now();
    let proxy_begin_at = timestamp_at_instant(start, start_utc, ws_connect_start);

    let hs = WsHandshakeContext {
        session_id,
        ws_scheme,
        host_header: host_header.clone(),
        path_and_query: path_and_query.clone(),
        full_url: full_url.clone(),
        timestamp: timestamp.clone(),
        start,
        start_utc,
        req_begin_at,
        proxy_begin_at,
        ws_connect_start,
        client_addr,
        client_proc: client_proc.clone(),
        client_conn,
        client_reused,
        client_tls_ms,
        client_http_ver,
        req_headers: req_headers.clone(),
        req_headers_bytes,
        req_mutated,
        accept_key,
        remapped_to,
    };

    if let Some(proxy_cfg) = active_upstream_proxy {
        let deadline = Instant::now() + connect_timeout;
        let tunnel_res = match connect_tunnel_via_upstream(
            &proxy_cfg,
            &connect_host,
            connect_port,
            connect_timeout,
        )
        .await
        {
            Ok(res) => res,
            Err(err_msg) => {
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
                    format!("WebSocket upstream proxy connect failed: {err_msg}"),
                );
            }
        };

        let throttled_tunnel =
            ThrottledStream::new_without_initial_delay(tunnel_res.stream, Arc::clone(&ctx.throttle));

        if ws_scheme == "wss" {
            let (tls_cfg, mtls_cn) =
                match build_ws_tls_config(&ctx, &target_host, client_addr, ws_scheme) {
                    Ok(pair) => pair,
                    Err(err_msg) => {
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
                            err_msg,
                        );
                    }
                };

            let sni_clean = target_host.trim_matches(['[', ']']).to_string();
            let server_name = match ServerName::try_from(sni_clean.clone()) {
                Ok(sn) => sn,
                Err(_) => {
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
                        format!("Invalid TLS ServerName '{sni_clean}' for WSS"),
                    );
                }
            };

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
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
                    format!(
                        "WebSocket TLS handshake timed out after {}s",
                        connect_timeout.as_secs()
                    ),
                );
            }

            let tls_start = Instant::now();
            let tls_stream = match tokio::time::timeout(
                remaining,
                TlsConnector::from(tls_cfg).connect(server_name, throttled_tunnel),
            )
            .await
            {
                Ok(Ok(s)) => s,
                Ok(Err(err)) => {
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
                        format!("WebSocket upstream TLS handshake failed: {err}"),
                    );
                }
                Err(_) => {
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
                        format!(
                            "WebSocket upstream TLS handshake timed out after {}s",
                            connect_timeout.as_secs()
                        ),
                    );
                }
            };
            let tls_handshake_ms = elapsed_ms(tls_start);
            let server_connected_at = timestamp_at_instant(start, start_utc, Instant::now());

            let server_tel = extract_proxied_ws_tls_telemetry(
                proxy_cfg.protocol,
                tunnel_res.proxy_addr,
                tls_stream.get_ref().1,
                WsConnTimingInput {
                    dns_ms: tunnel_res.dns_ms,
                    tcp_connect_ms: tunnel_res.tcp_connect_ms,
                    tls_handshake_ms: Some(tls_handshake_ms),
                    server_connected_at,
                },
                mtls_cn,
            );
            let remaining_ws = deadline.saturating_duration_since(Instant::now());
            if remaining_ws.is_zero() {
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
                    format!(
                        "WebSocket upstream connect timed out after {}s",
                        connect_timeout.as_secs()
                    ),
                );
            }

            let (upstream_ws, upstream_handshake_resp) = match tokio::time::timeout(
                remaining_ws,
                tokio_tungstenite::client_async(ws_req, tls_stream),
            )
            .await
            {
                Ok(Ok(pair)) => pair,
                Ok(Err(tokio_tungstenite::tungstenite::Error::Http(http_resp))) => {
                    return handle_ws_handshake_http_rejection(&ctx, hs, http_resp);
                }
                Ok(Err(err)) => {
                    let chain = format_error_chain(&err);
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
                        format!("WebSocket upstream connect failed: {chain}"),
                    );
                }
                Err(_) => {
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
                        format!(
                            "WebSocket upstream connect timed out after {}s",
                            connect_timeout.as_secs()
                        ),
                    );
                }
            };

            return finish_ws_handshake_and_spawn(
                req,
                upstream_ws,
                upstream_handshake_resp,
                server_tel,
                hs,
                ctx,
            );
        }

        let server_connected_at = timestamp_at_instant(start, start_utc, Instant::now());
        let server_tel = extract_proxied_ws_plain_telemetry(
            proxy_cfg.protocol,
            tunnel_res.proxy_addr,
            WsConnTimingInput {
                dns_ms: tunnel_res.dns_ms,
                tcp_connect_ms: tunnel_res.tcp_connect_ms,
                tls_handshake_ms: None,
                server_connected_at,
            },
        );
        let remaining_ws = deadline.saturating_duration_since(Instant::now());
        if remaining_ws.is_zero() {
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
                format!(
                    "WebSocket upstream connect timed out after {}s",
                    connect_timeout.as_secs()
                ),
            );
        }

        let (upstream_ws, upstream_handshake_resp) = match tokio::time::timeout(
            remaining_ws,
            tokio_tungstenite::client_async(ws_req, throttled_tunnel),
        )
        .await
        {
            Ok(Ok(pair)) => pair,
            Ok(Err(tokio_tungstenite::tungstenite::Error::Http(http_resp))) => {
                return handle_ws_handshake_http_rejection(&ctx, hs, http_resp);
            }
            Ok(Err(err)) => {
                let chain = format_error_chain(&err);
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
                    format!("WebSocket upstream connect failed: {chain}"),
                );
            }
            Err(_) => {
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
                    format!(
                        "WebSocket upstream connect timed out after {}s",
                        connect_timeout.as_secs()
                    ),
                );
            }
        };

        return finish_ws_handshake_and_spawn(
            req,
            upstream_ws,
            upstream_handshake_resp,
            server_tel,
            hs,
            ctx,
        );
    }

    // Direct WebSocket connection (honoring HOSTS Remapping, Bandwidth Throttling, and mTLS)
    let deadline = Instant::now() + connect_timeout;
    let tcp_res = match measure_ws_tcp_connect(&connect_host, connect_port, connect_timeout).await {
        Ok(res) => res,
        Err(err_msg) => {
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
                err_msg,
            );
        }
    };
    let throttled_tcp =
        ThrottledStream::new_without_initial_delay(tcp_res.stream, Arc::clone(&ctx.throttle));

    if ws_scheme == "wss" {
        let (tls_cfg, mtls_cn) =
            match build_ws_tls_config(&ctx, &target_host, client_addr, ws_scheme) {
                Ok(pair) => pair,
                Err(err_msg) => {
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
                        err_msg,
                    );
                }
            };

        let sni_clean = target_host.trim_matches(['[', ']']).to_string();
        let server_name = match ServerName::try_from(sni_clean.clone()) {
            Ok(sn) => sn,
            Err(_) => {
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
                    format!("Invalid TLS ServerName '{sni_clean}' for WSS"),
                );
            }
        };

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
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
                format!(
                    "WebSocket TLS handshake timed out after {}s",
                    connect_timeout.as_secs()
                ),
            );
        }

        let tls_start = Instant::now();
        let tls_stream = match tokio::time::timeout(
            remaining,
            TlsConnector::from(tls_cfg).connect(server_name, throttled_tcp),
        )
        .await
        {
            Ok(Ok(s)) => s,
            Ok(Err(err)) => {
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
                    format!("WebSocket upstream TLS handshake failed: {err}"),
                );
            }
            Err(_) => {
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
                    format!(
                        "WebSocket upstream TLS handshake timed out after {}s",
                        connect_timeout.as_secs()
                    ),
                );
            }
        };
        let tls_handshake_ms = elapsed_ms(tls_start);
        let server_connected_at = timestamp_at_instant(start, start_utc, Instant::now());
        let server_tel = extract_direct_ws_tls_telemetry(
            tcp_res.peer_addr,
            tls_stream.get_ref().1,
            WsConnTimingInput {
                dns_ms: tcp_res.dns_ms,
                tcp_connect_ms: tcp_res.tcp_connect_ms,
                tls_handshake_ms: Some(tls_handshake_ms),
                server_connected_at,
            },
            mtls_cn,
        );

        let remaining_ws = deadline.saturating_duration_since(Instant::now());
        if remaining_ws.is_zero() {
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
                format!(
                    "WebSocket upstream connect timed out after {}s",
                    connect_timeout.as_secs()
                ),
            );
        }

        let (upstream_ws, upstream_handshake_resp) = match tokio::time::timeout(
            remaining_ws,
            tokio_tungstenite::client_async(ws_req, tls_stream),
        )
        .await
        {
            Ok(Ok(pair)) => pair,
            Ok(Err(tokio_tungstenite::tungstenite::Error::Http(http_resp))) => {
                return handle_ws_handshake_http_rejection(&ctx, hs, http_resp);
            }
            Ok(Err(err)) => {
                let chain = format_error_chain(&err);
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
                    format!("WebSocket upstream connect failed: {chain}"),
                );
            }
            Err(_) => {
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
                    format!(
                        "WebSocket upstream connect timed out after {}s",
                        connect_timeout.as_secs()
                    ),
                );
            }
        };

        return finish_ws_handshake_and_spawn(
            req,
            upstream_ws,
            upstream_handshake_resp,
            server_tel,
            hs,
            ctx,
        );
    }

    let server_connected_at = timestamp_at_instant(start, start_utc, Instant::now());
    let server_tel = extract_direct_ws_plain_telemetry(
        tcp_res.peer_addr,
        WsConnTimingInput {
            dns_ms: tcp_res.dns_ms,
            tcp_connect_ms: tcp_res.tcp_connect_ms,
            tls_handshake_ms: None,
            server_connected_at,
        },
    );
    let remaining_ws = deadline.saturating_duration_since(Instant::now());
    if remaining_ws.is_zero() {
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
            format!(
                "WebSocket upstream connect timed out after {}s",
                connect_timeout.as_secs()
            ),
        );
    }

    let (upstream_ws, upstream_handshake_resp) = match tokio::time::timeout(
        remaining_ws,
        tokio_tungstenite::client_async(ws_req, throttled_tcp),
    )
    .await
    {
        Ok(Ok(pair)) => pair,
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(http_resp))) => {
            return handle_ws_handshake_http_rejection(&ctx, hs, http_resp);
        }
        Ok(Err(err)) => {
            let chain = format_error_chain(&err);
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
                format!("WebSocket upstream connect failed: {chain}"),
            );
        }
        Err(_) => {
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
                format!(
                    "WebSocket upstream connect timed out after {}s",
                    connect_timeout.as_secs()
                ),
            );
        }
    };

    finish_ws_handshake_and_spawn(
        req,
        upstream_ws,
        upstream_handshake_resp,
        server_tel,
        hs,
        ctx,
    )
}

/// Builds an upstream `http::Request<()>` via `IntoClientRequest` (which populates a fresh
/// `Sec-WebSocket-Key`, `Sec-WebSocket-Version: 13`, `Upgrade: websocket`, `Connection: Upgrade`,
/// and `Host`), then copies client headers (`Authorization`, `Cookie`, `Sec-WebSocket-Protocol`,
/// non-deflate `Sec-WebSocket-Extensions`, `User-Agent`, `Origin`, `X-*`, etc.) while excluding
/// regenerated hop-by-hop handshake headers.
pub(super) fn build_upstream_websocket_request(
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
pub(super) fn filter_supported_ws_extensions(raw_value: &str) -> Option<String> {
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

pub(super) fn is_ws_excluded_request_header(lower_name: &str) -> bool {
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

pub(super) fn is_ws_excluded_response_header(lower_name: &str) -> bool {
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

pub(super) fn record_ws_frame(
    index: usize,
    direction: &str,
    msg: &Message,
    injected: bool,
) -> WebSocketFrameRecord {
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
        injected,
    }
}
