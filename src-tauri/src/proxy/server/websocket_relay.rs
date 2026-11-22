use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::Bytes;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use http::header::UPGRADE;
use http::{Request, Response, StatusCode};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::WebSocketStream;

use crate::models::{
    HeaderMutationDirection, HeaderPair, SessionDetail, SessionSummary, SessionTimings,
    SessionTransferStats, WebSocketFrameRecord,
};
use crate::proxy::filters::is_alt_svc_header;
use crate::proxy::network::normalize_client_ip;
use crate::proxy::process::ClientProcessInfo;
use crate::proxy::upstream_client::{
    duration_ms_f64, elapsed_ms, estimate_request_headers_bytes, estimate_response_headers_bytes,
    extract_peer_cert_subject_issuer, format_rfc3339_micros, format_tls_cipher,
    format_tls_protocol, timestamp_at_instant,
};

use super::http_handler::format_error_chain;
use super::{
    boxed_full, extract_hyper_headers, format_mitm_tls_display, format_raw_http_version,
    is_hop_by_hop_header, plain_response, record_and_return_error, record_completed_session,
    ClientConnContext, ProxyBoxBody, SharedProxyContext, MAX_CAPTURED_BODY_BYTES,
};

struct WsServerConnTelemetry {
    server_addr: Option<String>,
    server_ip: Option<String>,
    server_port: Option<u16>,
    server_tls_version: Option<String>,
    server_tls_cipher: Option<String>,
    server_tls_alpn: Option<String>,
    server_cert_subject: Option<String>,
    server_cert_issuer: Option<String>,
}

fn extract_ws_server_telemetry(
    stream: &tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
) -> WsServerConnTelemetry {
    match stream {
        tokio_tungstenite::MaybeTlsStream::Plain(tcp) => {
            let peer = tcp.peer_addr().ok();
            WsServerConnTelemetry {
                server_addr: peer.map(|a| a.to_string()),
                server_ip: peer.map(|a| a.ip().to_string()),
                server_port: peer.map(|a| a.port()),
                server_tls_version: None,
                server_tls_cipher: None,
                server_tls_alpn: None,
                server_cert_subject: None,
                server_cert_issuer: None,
            }
        }
        tokio_tungstenite::MaybeTlsStream::Rustls(tls) => {
            let (tcp, conn) = tls.get_ref();
            let peer = tcp.peer_addr().ok();
            let (cert_subject, cert_issuer) = conn
                .peer_certificates()
                .and_then(|certs| certs.first())
                .map(|leaf| extract_peer_cert_subject_issuer(leaf.as_ref()))
                .unwrap_or((None, None));
            WsServerConnTelemetry {
                server_addr: peer.map(|a| a.to_string()),
                server_ip: peer.map(|a| a.ip().to_string()),
                server_port: peer.map(|a| a.port()),
                server_tls_version: conn.protocol_version().map(format_tls_protocol),
                server_tls_cipher: conn.negotiated_cipher_suite().map(format_tls_cipher),
                server_tls_alpn: conn
                    .alpn_protocol()
                    .map(|b| String::from_utf8_lossy(b).into_owned()),
                server_cert_subject: cert_subject,
                server_cert_issuer: cert_issuer,
            }
        }
        _ => WsServerConnTelemetry {
            server_addr: None,
            server_ip: None,
            server_port: None,
            server_tls_version: None,
            server_tls_cipher: None,
            server_tls_alpn: None,
            server_cert_subject: None,
            server_cert_issuer: None,
        },
    }
}

/// Intercepts `ws://` and decrypted `wss://` WebSocket connections, relaying frames
/// bidirectionally while recording frame metadata in `TrafficStore`.
/// Preserves client authentication/application headers (`Authorization`, `Cookie`,
/// `Sec-WebSocket-Protocol`, non-deflate `Sec-WebSocket-Extensions`, `User-Agent`, `Origin`, `X-*`)
/// required by ASP.NET Core SignalR and forwards upstream `101` handshake headers (`Sec-WebSocket-Protocol`,
/// `Set-Cookie`, `X-*`) back to the client.
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

    let connect_timeout = Duration::from_secs(ctx.upstream_timeout_sec.max(1));
    let ws_connect_start = Instant::now();
    let proxy_begin_at = timestamp_at_instant(start, start_utc, ws_connect_start);
    let (upstream_ws, upstream_handshake_resp) = match tokio::time::timeout(
        connect_timeout,
        tokio_tungstenite::connect_async(ws_req),
    )
    .await
    {
        Ok(Ok(pair)) => pair,
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(http_resp))) => {
            let status = http_resp.status();
            let got_resp_instant = Instant::now();
            let got_resp_at = timestamp_at_instant(start, start_utc, got_resp_instant);
            let handshake_ms = duration_ms_f64(got_resp_instant.saturating_duration_since(ws_connect_start));
            let overall_ms = elapsed_ms(start);
            let mut resp_headers = extract_hyper_headers(http_resp.headers());
            let resp_mutated = ctx.filters.apply_header_mutations(
                HeaderMutationDirection::Response,
                &full_url,
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
                client_connected: Some(client_conn.connected_at.clone()),
                client_begin_request: Some(req_begin_at.clone()),
                got_request_headers: Some(req_begin_at.clone()),
                client_done_request: Some(req_begin_at),
                proxy_begin_request: Some(proxy_begin_at),
                got_response_headers: Some(got_resp_at.clone()),
                server_done_response: Some(got_resp_at.clone()),
                client_begin_response: Some(got_resp_at.clone()),
                client_done_response: Some(got_resp_at),
                client_read_ms: Some(0.0),
                client_tls_handshake_ms: client_tls_ms,
                server_wait_ms: Some(handshake_ms),
                overall_elapsed_ms: Some(overall_ms),
                net_elapsed_ms: Some(overall_ms),
                ..Default::default()
            };
            let transfer_stats = SessionTransferStats {
                request_headers_bytes: Some(req_headers_bytes),
                request_body_bytes: Some(0),
                request_wire_body_bytes: Some(0),
                response_headers_bytes: Some(resp_headers_bytes),
                response_body_bytes: Some(resp_bytes.len()),
                response_wire_body_bytes: Some(resp_bytes.len()),
                client_conn_id: Some(client_conn.conn_id),
                client_conn_reused: Some(client_reused),
                client_http_version: Some(client_http_ver),
                client_tls_version: client_conn.client_tls_version.clone(),
                client_tls_cipher: client_conn.client_tls_cipher.clone(),
                client_alpn: client_conn.client_alpn.clone(),
                server_http_version: Some("HTTP/1.1".to_string()),
                server_conn_reused: Some(false),
                ..Default::default()
            };

            let mut summary = SessionSummary {
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
            };
            summary.apply_telemetry(Some(&timings), Some(&transfer_stats));

            let capped = &resp_bytes[..resp_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
            let detail = SessionDetail {
                summary: summary.clone(),
                request_headers: req_headers,
                response_headers: resp_headers.clone(),
                request_body_base64: String::new(),
                response_body_base64: base64::engine::general_purpose::STANDARD.encode(capped),
                request_body_text: None,
                response_body_text: std::str::from_utf8(capped).ok().map(str::to_owned),
                tls_version: format_mitm_tls_display(
                    ws_scheme,
                    client_conn.client_tls_version.as_deref(),
                    Some("WSS"),
                    None,
                ),
                client_addr: client_addr.to_string(),
                websocket_frames: Vec::new(),
                sse_events: Vec::new(),
                body_offloaded: false,
                request_body_offloaded: false,
                timings: Some(timings),
                transfer_stats: Some(transfer_stats),
            };

            record_completed_session(&ctx, detail, None, None);

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

    let got_resp_instant = Instant::now();
    let got_resp_at = timestamp_at_instant(start, start_utc, got_resp_instant);
    let handshake_ms =
        duration_ms_f64(got_resp_instant.saturating_duration_since(ws_connect_start));
    let overall_init_ms = elapsed_ms(start);
    let server_tel = extract_ws_server_telemetry(upstream_ws.get_ref());

    let mut resp_headers = extract_hyper_headers(upstream_handshake_resp.headers());
    let resp_mutated = ctx.filters.apply_header_mutations(
        HeaderMutationDirection::Response,
        &full_url,
        &mut resp_headers,
    );
    let resp_headers_bytes = estimate_response_headers_bytes(101, "HTTP/1.1", &resp_headers);

    let initial_timings = SessionTimings {
        client_connected: Some(client_conn.connected_at.clone()),
        client_begin_request: Some(req_begin_at.clone()),
        got_request_headers: Some(req_begin_at.clone()),
        client_done_request: Some(req_begin_at),
        proxy_begin_request: Some(proxy_begin_at),
        got_response_headers: Some(got_resp_at.clone()),
        client_begin_response: Some(got_resp_at),
        client_read_ms: Some(0.0),
        client_tls_handshake_ms: client_tls_ms,
        server_wait_ms: Some(handshake_ms),
        overall_elapsed_ms: Some(overall_init_ms),
        net_elapsed_ms: Some(overall_init_ms),
        ..Default::default()
    };
    let initial_stats = SessionTransferStats {
        request_headers_bytes: Some(req_headers_bytes),
        request_body_bytes: Some(0),
        request_wire_body_bytes: Some(0),
        response_headers_bytes: Some(resp_headers_bytes),
        response_body_bytes: Some(0),
        response_wire_body_bytes: Some(0),
        client_conn_id: Some(client_conn.conn_id),
        client_conn_reused: Some(client_reused),
        client_http_version: Some(client_http_ver),
        client_tls_version: client_conn.client_tls_version.clone(),
        client_tls_cipher: client_conn.client_tls_cipher.clone(),
        client_alpn: client_conn.client_alpn.clone(),
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
        is_streaming: Some(true),
        ..Default::default()
    };

    let mut summary = SessionSummary {
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
    };
    summary.apply_telemetry(Some(&initial_timings), Some(&initial_stats));

    let initial_detail = SessionDetail {
        summary: summary.clone(),
        request_headers: req_headers,
        response_headers: resp_headers.clone(),
        request_body_base64: String::new(),
        response_body_base64: String::new(),
        request_body_text: None,
        response_body_text: Some("[WebSocket Tunnel Established — Inspect Frames]".into()),
        tls_version: format_mitm_tls_display(
            ws_scheme,
            client_conn.client_tls_version.as_deref(),
            Some("WSS"),
            None,
        ),
        client_addr: client_addr.to_string(),
        websocket_frames: Vec::new(),
        sse_events: Vec::new(),
        body_offloaded: false,
        request_body_offloaded: false,
        timings: Some(initial_timings),
        transfer_stats: Some(initial_stats),
    };

    record_completed_session(&ctx, initial_detail, None, None);
    let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();

    tokio::spawn(async move {
        if let Ok(upgraded) = hyper::upgrade::on(req).await {
            let client_ws =
                WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, None).await;

            let (mut client_sink, mut client_stream) = client_ws.split();
            let (mut upstream_sink, mut upstream_stream) = upstream_ws.split();

            const MAX_WS_FRAMES: usize = 256;
            fn try_claim_ws_frame_index(counter: &AtomicUsize, limit: usize) -> Option<usize> {
                let mut curr = counter.load(Ordering::Relaxed);
                while curr < limit {
                    match counter.compare_exchange_weak(
                        curr,
                        curr + 1,
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                    ) {
                        Ok(prev) => return Some(prev),
                        Err(actual) => curr = actual,
                    }
                }
                None
            }
            let recorded_count = Arc::new(AtomicUsize::new(0));
            let total_bytes = Arc::new(AtomicUsize::new(0));
            let tx_bytes = Arc::new(AtomicUsize::new(0));
            let rx_bytes = Arc::new(AtomicUsize::new(0));

            let c2u_recorded = Arc::clone(&recorded_count);
            let c2u_bytes = Arc::clone(&total_bytes);
            let c2u_tx = Arc::clone(&tx_bytes);
            let c2u_ctx = Arc::clone(&ctx);
            let client_to_upstream = async move {
                while let Some(Ok(msg)) = client_stream.next().await {
                    let msg_len = msg.len();
                    c2u_tx.fetch_add(msg_len, Ordering::Relaxed);
                    let new_total = c2u_bytes.fetch_add(msg_len, Ordering::Relaxed) + msg_len;
                    let frame = try_claim_ws_frame_index(&c2u_recorded, MAX_WS_FRAMES)
                        .map(|prev| record_ws_frame(prev + 1, "outbound", &msg));
                    if let Some(updated_summary) =
                        c2u_ctx
                            .store
                            .append_ws_frame(session_id, frame, new_total, MAX_WS_FRAMES)
                    {
                        let _ = c2u_ctx.event_tx.send(updated_summary);
                    }
                    if upstream_sink.send(msg).await.is_err() {
                        break;
                    }
                }
                let _ = tokio::time::timeout(
                    Duration::from_millis(250),
                    upstream_sink.close(),
                )
                .await;
            };

            let u2c_recorded = Arc::clone(&recorded_count);
            let u2c_bytes = Arc::clone(&total_bytes);
            let u2c_rx = Arc::clone(&rx_bytes);
            let u2c_ctx = Arc::clone(&ctx);
            let upstream_to_client = async move {
                while let Some(Ok(msg)) = upstream_stream.next().await {
                    let msg_len = msg.len();
                    u2c_rx.fetch_add(msg_len, Ordering::Relaxed);
                    let new_total = u2c_bytes.fetch_add(msg_len, Ordering::Relaxed) + msg_len;
                    let frame = try_claim_ws_frame_index(&u2c_recorded, MAX_WS_FRAMES)
                        .map(|prev| record_ws_frame(prev + 1, "inbound", &msg));
                    if let Some(updated_summary) =
                        u2c_ctx
                            .store
                            .append_ws_frame(session_id, frame, new_total, MAX_WS_FRAMES)
                    {
                        let _ = u2c_ctx.event_tx.send(updated_summary);
                    }
                    if client_sink.send(msg).await.is_err() {
                        break;
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
            }

            let _ = ctx.store.finalize_ws_stream(session_id);
            let end_instant = Instant::now();
            let done_at = timestamp_at_instant(start, start_utc, end_instant);
            let overall_ms = elapsed_ms(start);
            let relay_ms = duration_ms_f64(end_instant.saturating_duration_since(got_resp_instant));
            let final_tx = tx_bytes.load(Ordering::Relaxed);
            let final_rx = rx_bytes.load(Ordering::Relaxed);

            if let Some(final_summary) = ctx.store.update_session_telemetry(session_id, |detail| {
                detail.summary.duration_ms = start.elapsed().as_millis() as u64;
                let timings = detail.timings.get_or_insert_with(Default::default);
                timings.server_done_response = Some(done_at.clone());
                timings.client_done_response = Some(done_at);
                timings.content_download_ms = Some(relay_ms);
                timings.overall_elapsed_ms = Some(overall_ms);
                timings.net_elapsed_ms = Some(overall_ms);

                let stats = detail.transfer_stats.get_or_insert_with(Default::default);
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
                let _ = ctx.event_tx.send(final_summary);
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
