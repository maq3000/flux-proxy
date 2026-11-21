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
    HeaderMutationDirection, HeaderPair, SessionDetail, SessionSummary, WebSocketFrameRecord,
};
use crate::proxy::filters::is_alt_svc_header;
use crate::proxy::network::normalize_client_ip;
use crate::proxy::process::ClientProcessInfo;

use super::http_handler::format_error_chain;
use super::{
    boxed_full, extract_hyper_headers, is_hop_by_hop_header, plain_response,
    record_and_return_error, record_completed_session, ProxyBoxBody, SharedProxyContext,
    MAX_CAPTURED_BODY_BYTES,
};

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

    let connect_timeout = Duration::from_secs(ctx.upstream_timeout_sec.max(1));
    let (upstream_ws, upstream_handshake_resp) = match tokio::time::timeout(
        connect_timeout,
        tokio_tungstenite::connect_async(ws_req),
    )
    .await
    {
        Ok(Ok(pair)) => pair,
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(http_resp))) => {
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
                remapped_to: None,
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
                body_offloaded: false,
                request_body_offloaded: false,
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
        remapped_to: None,
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
        body_offloaded: false,
        request_body_offloaded: false,
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

            let c2u_recorded = Arc::clone(&recorded_count);
            let c2u_bytes = Arc::clone(&total_bytes);
            let c2u_ctx = Arc::clone(&ctx);
            let client_to_upstream = async move {
                while let Some(Ok(msg)) = client_stream.next().await {
                    let new_total =
                        c2u_bytes.fetch_add(msg.len(), Ordering::Relaxed) + msg.len();
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
            let u2c_ctx = Arc::clone(&ctx);
            let upstream_to_client = async move {
                while let Some(Ok(msg)) = upstream_stream.next().await {
                    let new_total =
                        u2c_bytes.fetch_add(msg.len(), Ordering::Relaxed) + msg.len();
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

            if let Some(final_summary) = ctx.store.finalize_ws_stream(session_id) {
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
