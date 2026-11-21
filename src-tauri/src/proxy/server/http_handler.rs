use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::Bytes;
use chrono::Utc;
use http::header::{HOST, UPGRADE};
use http::{Request, Response, StatusCode};
use http_body_util::{BodyExt, LengthLimitError, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use tokio::sync::mpsc;

use crate::models::{
    AutoResponderRule, BreakpointAction, BreakpointStage, HeaderMutationDirection, HeaderPair,
    PausedBreakpointItem, RuleActionType, SessionDetail, SessionSummary, SseEventRecord,
};
use crate::proxy::filters::is_alt_svc_header;
use crate::proxy::hosts::HostRemapRegistry;
use crate::proxy::network::normalize_client_ip;
use crate::proxy::process::ClientProcessInfo;
use crate::proxy::throttle::BandwidthPacer;
use crate::scripting::{
    apply_header_diff, ScriptRequestEdits, ScriptRequestOutcome, ScriptResponseOutcome,
};
use crate::storage::{BODY_OFFLOAD_THRESHOLD_BYTES};

use super::mobile_portal::{handle_builtin_portal_request, is_builtin_portal_target};
use super::websocket_relay::handle_websocket_intercept;
use super::{
    boxed_full, encode_inline_or_offload, extract_hyper_headers, extract_reqwest_headers,
    format_http_version, is_hop_by_hop_header, is_loopback_ip, make_breakpoint_guard,
    parse_host_and_optional_port, plain_response, record_and_return_error,
    record_and_return_error_with_opts, record_completed_session,
    record_in_flight_session_with_remap, request_targets_loopback_or_unspecified,
    resolve_protocol_label, should_use_host_mtls_for_peer, ProxyBoxBody, SharedProxyContext,
    DEFAULT_UPSTREAM_TIMEOUT_SEC, MAX_CAPTURED_BODY_BYTES, MAX_CAPTURED_REQUEST_BODY_BYTES,
    MAX_CONTENT_ENCODING_LAYERS, STREAM_TEXT_PREVIEW_MAX_BYTES,
    ZSTD_SPAWN_BLOCKING_THRESHOLD_BYTES,
};

#[derive(Debug)]
pub(super) enum RequestBodyReadError {
    PayloadTooLarge(usize),
    Transport(String),
}

pub(super) async fn collect_request_body_limited<B>(
    body: B,
    max_bytes: usize,
) -> Result<Bytes, RequestBodyReadError>
where
    B: hyper::body::Body<Data = Bytes>,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    match Limited::new(body, max_bytes).collect().await {
        Ok(collected) => Ok(collected.to_bytes()),
        Err(err) => {
            if err.is::<LengthLimitError>() {
                Err(RequestBodyReadError::PayloadTooLarge(max_bytes))
            } else {
                Err(RequestBodyReadError::Transport(err.to_string()))
            }
        }
    }
}

/// Builds the shared upstream HTTP/HTTPS `reqwest::Client` with keep-alive, pool timeouts,
/// native root CAs (`rustls-tls-native-roots`), optional mTLS `Identity`, optional custom DNS
/// resolver (`HostRemapRegistry`), and `.no_proxy()` to prevent loopback recursion.
pub fn build_upstream_client_with_options(
    follow_redirects: bool,
    identity: Option<reqwest::Identity>,
    dns_resolver: Option<Arc<HostRemapRegistry>>,
) -> Result<reqwest::Client, reqwest::Error> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let redirect_policy = if follow_redirects {
        reqwest::redirect::Policy::default()
    } else {
        reqwest::redirect::Policy::none()
    };
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(redirect_policy)
        .connect_timeout(Duration::from_secs(DEFAULT_UPSTREAM_TIMEOUT_SEC))
        .tcp_keepalive(Some(Duration::from_secs(30)))
        .http2_keep_alive_interval(Some(Duration::from_secs(20)))
        .http2_keep_alive_timeout(Duration::from_secs(10))
        .http2_keep_alive_while_idle(true)
        .pool_idle_timeout(Some(Duration::from_secs(35)));
    if let Some(id) = identity {
        builder = builder.identity(id);
    }
    if let Some(resolver) = dns_resolver {
        builder = builder.dns_resolver(resolver);
    }
    builder.build()
}

pub fn build_upstream_client_with_identity(
    follow_redirects: bool,
    identity: Option<reqwest::Identity>,
) -> Result<reqwest::Client, reqwest::Error> {
    build_upstream_client_with_options(follow_redirects, identity, None)
}

pub(crate) fn build_upstream_client_with_resolver(
    follow_redirects: bool,
    dns_resolver: Option<Arc<HostRemapRegistry>>,
) -> Result<reqwest::Client, reqwest::Error> {
    build_upstream_client_with_options(follow_redirects, None, dns_resolver)
}

/// Builds the shared upstream HTTP/HTTPS `reqwest::Client` without a client mTLS identity.
#[cfg(test)]
pub(crate) fn build_upstream_client(
    follow_redirects: bool,
) -> Result<reqwest::Client, reqwest::Error> {
    build_upstream_client_with_options(follow_redirects, None, None)
}

pub(super) struct PreparedUpstreamTarget {
    pub upstream_url: String,
    pub host_header_override: Option<String>,
    pub remapped_to: Option<String>,
}

fn default_port_for_scheme(scheme: &str) -> u16 {
    if scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("wss") {
        443
    } else {
        80
    }
}

pub(super) fn prepare_remapped_upstream_target(
    ctx: &SharedProxyContext,
    full_url: &str,
    host_header: &str,
    scheme_str: &str,
) -> PreparedUpstreamTarget {
    let Ok(mut parsed) = reqwest::Url::parse(full_url) else {
        return PreparedUpstreamTarget {
            upstream_url: full_url.to_string(),
            host_header_override: None,
            remapped_to: None,
        };
    };

    let Some(url_host_raw) = parsed.host_str().map(str::to_owned) else {
        return PreparedUpstreamTarget {
            upstream_url: full_url.to_string(),
            host_header_override: None,
            remapped_to: None,
        };
    };

    let Some(rule) = ctx.host_remap.match_host(&url_host_raw) else {
        return PreparedUpstreamTarget {
            upstream_url: full_url.to_string(),
            host_header_override: None,
            remapped_to: None,
        };
    };

    let url_port = parsed.port();
    let remapped_to = Some(HostRemapRegistry::format_remap_target(&rule, rule.target_port));
    let clean_source = url_host_raw.trim_matches(['[', ']']);
    let is_ip_source = clean_source.parse::<IpAddr>().is_ok();
    let formatted_target = HostRemapRegistry::format_host_for_authority(&rule.target_host);

    if is_ip_source {
        let _ = parsed.set_host(Some(&formatted_target));
        if let Some(tp) = rule.target_port {
            let _ = parsed.set_port(Some(tp));
        }
        let host_header_override = if rule.preserve_host_header {
            Some(host_header.to_string())
        } else {
            None
        };
        return PreparedUpstreamTarget {
            upstream_url: parsed.to_string(),
            host_header_override,
            remapped_to,
        };
    }

    // Domain source: keep original hostname in URL so reqwest::dns::Resolve & rustls TLS SNI
    // preserve the original domain name!
    let mut stripped_explicit_port = false;
    if url_port.is_some() && rule.target_port.is_some() {
        let _ = parsed.set_port(None);
        stripped_explicit_port = true;
    }

    let host_header_override = if rule.preserve_host_header {
        if stripped_explicit_port {
            Some(host_header.to_string())
        } else {
            None
        }
    } else {
        let effective_port = rule.target_port.or(url_port);
        let default_port = default_port_for_scheme(scheme_str);
        Some(match effective_port {
            Some(p) if p != default_port => format!("{formatted_target}:{p}"),
            _ => formatted_target,
        })
    };

    PreparedUpstreamTarget {
        upstream_url: parsed.to_string(),
        host_header_override,
        remapped_to,
    }
}

/// Traverses the full `std::error::Error::source()` chain and formats all causes joined with `" -> "`.
pub(crate) fn format_error_chain(err: &dyn std::error::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut current = err.source();
    while let Some(source) = current {
        let text = source.to_string();
        if !text.is_empty() && parts.last().map(|last| last != &text).unwrap_or(true) {
            parts.push(text);
        }
        current = source.source();
    }
    parts.join(" -> ")
}

#[inline]
pub(super) fn is_idempotent_retry_method(method: &reqwest::Method) -> bool {
    matches!(
        *method,
        reqwest::Method::GET | reqwest::Method::HEAD | reqwest::Method::OPTIONS
    )
}

pub(super) fn is_stale_pool_connection_error(err: &reqwest::Error) -> bool {
    if !(err.is_request() || err.is_connect()) {
        return false;
    }

    let mut current: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(err);
    while let Some(source) = current {
        if let Some(io_err) = source.downcast_ref::<std::io::Error>() {
            if matches!(
                io_err.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::UnexpectedEof
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::NotConnected
            ) {
                return true;
            }
        }
        if let Some(hyper_err) = source.downcast_ref::<hyper::Error>() {
            if hyper_err.is_incomplete_message()
                || hyper_err.is_canceled()
                || hyper_err.is_closed()
            {
                return true;
            }
        }
        let msg = source.to_string().to_ascii_lowercase();
        if msg.contains("incompletemessage")
            || msg.contains("incomplete message")
            || msg.contains("connection closed before message completed")
            || msg.contains("connection reset")
            || msg.contains("broken pipe")
            || msg.contains("unexpected eof")
            || msg.contains("unexpectedeof")
            || msg.contains("canceled")
        {
            return true;
        }
        current = source.source();
    }

    false
}

pub(super) async fn send_upstream_with_retry<F>(
    client: &reqwest::Client,
    method: &reqwest::Method,
    build_req: F,
) -> Result<reqwest::Response, reqwest::Error>
where
    F: Fn(&reqwest::Client) -> reqwest::RequestBuilder,
{
    match build_req(client).send().await {
        Ok(resp) => Ok(resp),
        Err(err) if is_idempotent_retry_method(method) && is_stale_pool_connection_error(&err) => {
            tracing::debug!(
                "Retrying idempotent {} request once after stale pooled connection drop: {}",
                method,
                format_error_chain(&err)
            );
            build_req(client).send().await
        }
        Err(err) => Err(err),
    }
}

pub(crate) fn extract_content_encoding_tokens(headers: &[HeaderPair]) -> Vec<String> {
    let mut tokens = Vec::new();
    for h in headers {
        if h.name.trim().eq_ignore_ascii_case("content-encoding") {
            for token in h.value.split(',') {
                let trimmed = token.trim();
                if !trimmed.is_empty() {
                    tokens.push(trimmed.to_string());
                }
            }
        }
    }
    tokens
}

pub(crate) fn has_zstd_content_encoding(headers: &[HeaderPair]) -> bool {
    extract_content_encoding_tokens(headers)
        .iter()
        .any(|token| token.eq_ignore_ascii_case("zstd") || token.eq_ignore_ascii_case("x-zstd"))
}

pub(crate) const MAX_ZSTD_DECOMPRESSED_BYTES: u64 = MAX_CAPTURED_BODY_BYTES as u64;

pub(crate) fn decode_zstd_bounded(input: &[u8], max_bytes: u64) -> Result<Vec<u8>, std::io::Error> {
    use std::io::Read;

    let decoder = zstd::stream::read::Decoder::new(input)?;
    let mut out = Vec::new();
    decoder
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut out)?;
    if (out.len() as u64) > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("zstd decompressed payload exceeds limit of {max_bytes} bytes"),
        ));
    }
    Ok(out)
}

pub(super) fn decode_single_layer_bounded(
    encoding: &str,
    input: &[u8],
    max_bytes: u64,
) -> Result<Vec<u8>, std::io::Error> {
    use std::io::Read;

    let enc_lower = encoding.trim().to_ascii_lowercase();
    let mut out = Vec::new();
    match enc_lower.as_str() {
        "zstd" | "x-zstd" => return decode_zstd_bounded(input, max_bytes),
        "gzip" | "x-gzip" => {
            let decoder = flate2::read::GzDecoder::new(input);
            decoder
                .take(max_bytes.saturating_add(1))
                .read_to_end(&mut out)?;
        }
        "deflate" => {
            let zlib_res = {
                let mut tmp = Vec::new();
                flate2::read::ZlibDecoder::new(input)
                    .take(max_bytes.saturating_add(1))
                    .read_to_end(&mut tmp)
                    .map(|_| tmp)
            };
            match zlib_res {
                Ok(tmp) => out = tmp,
                Err(_) => {
                    flate2::read::DeflateDecoder::new(input)
                        .take(max_bytes.saturating_add(1))
                        .read_to_end(&mut out)?;
                }
            }
        }
        "br" => {
            let decoder = brotli::Decompressor::new(input, 4096);
            decoder
                .take(max_bytes.saturating_add(1))
                .read_to_end(&mut out)?;
        }
        other => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                format!("unsupported Content-Encoding '{other}'"),
            ));
        }
    }

    if (out.len() as u64) > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{enc_lower} decompressed payload exceeds limit of {max_bytes} bytes"),
        ));
    }
    Ok(out)
}

pub(crate) struct ContentEncodingDecodeResult {
    pub body: Bytes,
    pub decoded_any: bool,
    pub remaining_encodings: Vec<String>,
}

pub(crate) async fn maybe_decompress_content_encodings(
    headers: &[HeaderPair],
    body: Bytes,
) -> ContentEncodingDecodeResult {
    let mut remaining = extract_content_encoding_tokens(headers);
    if remaining.is_empty() {
        return ContentEncodingDecodeResult {
            body,
            decoded_any: false,
            remaining_encodings: remaining,
        };
    }

    if body.is_empty() {
        let had_supported = remaining.iter().any(|t| {
            matches!(
                t.to_ascii_lowercase().as_str(),
                "identity" | "zstd" | "x-zstd" | "gzip" | "x-gzip" | "deflate" | "br"
            )
        });
        remaining.retain(|t| {
            !matches!(
                t.to_ascii_lowercase().as_str(),
                "identity" | "zstd" | "x-zstd"
            )
        });
        return ContentEncodingDecodeResult {
            body,
            decoded_any: had_supported && remaining.is_empty(),
            remaining_encodings: remaining,
        };
    }

    let mut current = body;
    let mut decoded_any = false;
    let mut peeled_layers = 0usize;

    while let Some(outer) = remaining.last().cloned() {
        if peeled_layers >= MAX_CONTENT_ENCODING_LAYERS {
            tracing::warn!(
                "Reached max Content-Encoding decompression depth ({MAX_CONTENT_ENCODING_LAYERS}); preserving remaining encodings: {:?}",
                remaining
            );
            break;
        }
        let outer_lower = outer.to_ascii_lowercase();
        if outer_lower == "identity" {
            remaining.pop();
            continue;
        }
        if !matches!(
            outer_lower.as_str(),
            "zstd" | "x-zstd" | "gzip" | "x-gzip" | "deflate" | "br"
        ) {
            break;
        }

        let decode_res = if current.len() > ZSTD_SPAWN_BLOCKING_THRESHOLD_BYTES {
            let payload_for_task = current.clone();
            let enc_owned = outer_lower.clone();
            match tokio::task::spawn_blocking(move || {
                decode_single_layer_bounded(
                    &enc_owned,
                    payload_for_task.as_ref(),
                    MAX_ZSTD_DECOMPRESSED_BYTES,
                )
            })
            .await
            {
                Ok(res) => res,
                Err(join_err) => {
                    tracing::warn!(
                        "Content-Encoding '{outer}' spawn_blocking task failed ({} bytes): {join_err}",
                        current.len()
                    );
                    break;
                }
            }
        } else {
            decode_single_layer_bounded(
                &outer_lower,
                current.as_ref(),
                MAX_ZSTD_DECOMPRESSED_BYTES,
            )
        };

        match decode_res {
            Ok(decoded) => {
                current = Bytes::from(decoded);
                remaining.pop();
                decoded_any = true;
                peeled_layers += 1;
            }
            Err(err) => {
                tracing::warn!(
                    "Failed to decompress Content-Encoding '{outer}' ({} bytes): {err}",
                    current.len()
                );
                break;
            }
        }
    }

    ContentEncodingDecodeResult {
        body: current,
        decoded_any,
        remaining_encodings: remaining,
    }
}

#[allow(dead_code)]
pub(crate) async fn maybe_decompress_zstd(headers: &[HeaderPair], body: Bytes) -> (Bytes, bool) {
    if !has_zstd_content_encoding(headers) {
        return (body, false);
    }
    let res = maybe_decompress_content_encodings(headers, body).await;
    let all_decoded = res.remaining_encodings.is_empty();
    (res.body, res.decoded_any || all_decoded)
}

pub(super) async fn handle_intercepted_request(
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

    let is_remote_peer = !is_loopback_ip(client_addr.ip());
    if is_remote_peer
        && (req.headers().get(HOST).is_some() || !is_direct_origin_http)
        && request_targets_loopback_or_unspecified(&host_header, &full_url)
    {
        return plain_response(
            StatusCode::FORBIDDEN,
            "Forbidden: remote LAN clients cannot access loopback or unspecified hosts",
        );
    }

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

    // 0a. Bandwidth Throttling: Offline mode blocks outbound HTTP/HTTPS/WS traffic immediately
    if ctx.throttle.is_offline() {
        let method_preview = req.method().as_str().to_string();
        let req_headers = extract_hyper_headers(req.headers());
        return record_and_return_error_with_opts(
            &ctx,
            session_id,
            &scheme_str,
            &method_preview,
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
            StatusCode::SERVICE_UNAVAILABLE,
            None,
            "Network Offline (Bandwidth Throttling: Offline)".to_string(),
        );
    }

    // 0b. Enforce TargetedOnly allowlist against inner Host / HTTP/2 :authority when inside CONNECT MITM
    if let Some(tunnel_auth) = default_authority {
        if ctx.filters.is_targeted_only_mode() {
            let normalize_auth = |raw: &str| -> (String, u16) {
                let (h, maybe_p) = parse_host_and_optional_port(raw);
                (h.trim_end_matches('.').to_string(), maybe_p.unwrap_or(443))
            };
            let tunnel_norm = normalize_auth(tunnel_auth);
            let host_hdr_raw = req
                .headers()
                .get(HOST)
                .and_then(|v| v.to_str().ok())
                .unwrap_or(tunnel_auth);
            let uri_auth_raw = req.uri().authority().map(|a| a.as_str());

            let differs_from_tunnel = normalize_auth(host_hdr_raw) != tunnel_norm
                || uri_auth_raw.is_some_and(|ua| normalize_auth(ua) != tunnel_norm);

            if differs_from_tunnel {
                let host_allowed = ctx.filters.should_intercept_tls(host_hdr_raw);
                let uri_allowed = uri_auth_raw
                    .map(|ua| ctx.filters.should_intercept_tls(ua))
                    .unwrap_or(true);
                if !host_allowed || !uri_allowed {
                    return plain_response(
                        StatusCode::FORBIDDEN,
                        "Forbidden: Host header differs from CONNECT authority and is outside TargetedOnly TLS allowlist",
                    );
                }
            }
        }
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
    let mut req_mutated = ctx.filters.apply_header_mutations(
        HeaderMutationDirection::Request,
        &full_url,
        &mut req_headers,
    );

    let mut body_bytes = match collect_request_body_limited(
        req.into_body(),
        MAX_CAPTURED_REQUEST_BODY_BYTES,
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(RequestBodyReadError::PayloadTooLarge(limit)) => {
            let msg = format!(
                "Request body exceeds maximum captured payload limit ({limit} bytes)"
            );
            let protocol = resolve_protocol_label(&scheme_str, alpn, req_version);
            let resp_headers = vec![HeaderPair {
                name: "Content-Type".into(),
                value: "text/plain; charset=utf-8".into(),
            }];
            let summary = SessionSummary {
                id: session_id,
                status: StatusCode::PAYLOAD_TOO_LARGE.as_u16(),
                protocol,
                scheme: scheme_str.clone(),
                method: method_str.clone(),
                host: host_header.clone(),
                path: path_and_query.clone(),
                url: full_url.clone(),
                content_type: "text/plain; charset=utf-8".into(),
                body_size: msg.len(),
                duration_ms: start.elapsed().as_millis() as u64,
                timestamp,
                is_mocked: false,
                matched_rule_id: None,
                error: Some(msg.clone()),
                process_name: client_proc.as_ref().map(|p| p.name.clone()),
                process_pid: client_proc.as_ref().map(|p| p.pid),
                tls_bypassed: false,
                headers_mutated: req_mutated,
                breakpoint_paused: None,
                breakpoint_modified: false,
                comment: None,
                marked_color: None,
                client_ip: Some(normalize_client_ip(client_addr)),
                remapped_to: None,
            };
            let detail = SessionDetail {
                summary,
                request_headers: req_headers,
                response_headers: resp_headers,
                request_body_base64: String::new(),
                response_body_base64: base64::engine::general_purpose::STANDARD
                    .encode(msg.as_bytes()),
                request_body_text: None,
                response_body_text: Some(msg.clone()),
                tls_version: None,
                client_addr: client_addr.to_string(),
                websocket_frames: Vec::new(),
                sse_events: Vec::new(),
                body_offloaded: false,
                request_body_offloaded: false,
            };
            record_completed_session(&ctx, detail, None, Some(msg.as_bytes()));
            return plain_response(StatusCode::PAYLOAD_TOO_LARGE, &msg);
        }
        Err(RequestBodyReadError::Transport(err)) => {
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
        let mut req_vec = body_bytes.to_vec();
        let bp_input = RequestBreakpointStageInput {
            session_id,
            protocol: resolve_protocol_label(&scheme_str, alpn, req_version),
            timestamp: timestamp.clone(),
            start,
            process_name: client_proc.as_ref().map(|p| p.name.clone()),
            process_pid: client_proc.as_ref().map(|p| p.pid),
            client_ip: Some(normalize_client_ip(client_addr)),
            client_addr: client_addr.to_string(),
            tls_version: if scheme_str == "https" {
                Some("TLS 1.3 (MITM Paused)".into())
            } else {
                None
            },
            summary_body_size: req_vec.len(),
            req_mutated,
        };
        if run_request_breakpoint_stage(
            &ctx,
            bp_input,
            &mut method_str,
            &mut full_url,
            &mut scheme_str,
            &mut host_header,
            &mut path_and_query,
            &mut req_headers,
            &mut req_vec,
            &mut bp_modified,
        )
        .await
        .is_err()
        {
            return record_and_return_error(
                &ctx,
                session_id,
                &scheme_str,
                &method_str,
                &host_header,
                &path_and_query,
                &full_url,
                req_headers,
                Bytes::from(req_vec),
                start,
                timestamp,
                client_addr,
                client_proc.as_ref(),
                false,
                true,
                "Aborted at Live Breakpoint (Before Request)".to_string(),
            );
        }
        body_bytes = Bytes::from(req_vec);
    }

    // 1c. Python Scripting Engine: on_request(request)
    if ctx.script_runner.should_run_request() {
        match ctx
            .script_runner
            .run_on_request(session_id, &method_str, &full_url, &req_headers, &body_bytes)
            .await
        {
            ScriptRequestOutcome::Unchanged => {}
            ScriptRequestOutcome::Modified(edits) => {
                apply_script_request_edits(
                    edits,
                    &mut method_str,
                    &mut full_url,
                    &mut scheme_str,
                    &mut host_header,
                    &mut path_and_query,
                    &mut req_headers,
                    &mut body_bytes,
                    &mut req_mutated,
                );
            }
            ScriptRequestOutcome::MockResponse { edits, mock } => {
                apply_script_request_edits(
                    edits,
                    &mut method_str,
                    &mut full_url,
                    &mut scheme_str,
                    &mut host_header,
                    &mut path_and_query,
                    &mut req_headers,
                    &mut body_bytes,
                    &mut req_mutated,
                );

                let mock_bytes = Bytes::from(mock.body);
                let mut mock_resp_headers = mock.headers;
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
                let sse_events =
                    if content_type.to_ascii_lowercase().starts_with("text/event-stream") {
                        parse_sse_events_from_bytes(&mock_bytes, start.elapsed().as_millis() as u64)
                    } else {
                        Vec::new()
                    };

                let protocol_label = resolve_protocol_label(&scheme_str, alpn, req_version);
                let duration_ms = start.elapsed().as_millis() as u64;
                let summary = SessionSummary {
                    id: session_id,
                    status: mock.status,
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
                    matched_rule_id: Some("python-script".to_string()),
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
                    remapped_to: None,
                };

                let capped_req = &body_bytes[..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
                let capped_mock = &mock_bytes[..mock_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
                let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
                let (resp_b64, resp_txt, resp_offloaded) = encode_inline_or_offload(capped_mock);
                let detail = SessionDetail {
                    summary,
                    request_headers: req_headers,
                    response_headers: mock_resp_headers.clone(),
                    request_body_base64: req_b64,
                    response_body_base64: resp_b64,
                    request_body_text: req_txt,
                    response_body_text: resp_txt,
                    tls_version: if scheme_str == "https" {
                        Some("TLS 1.3 (MITM Python Mock)".into())
                    } else {
                        None
                    },
                    client_addr: client_addr.to_string(),
                    websocket_frames: Vec::new(),
                    sse_events,
                    body_offloaded: resp_offloaded,
                    request_body_offloaded: req_offloaded,
                };

                record_completed_session(&ctx, detail, Some(capped_req), Some(capped_mock));

                let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();
                let mut resp_builder = Response::builder()
                    .status(StatusCode::from_u16(mock.status).unwrap_or(StatusCode::OK));
                for h in &mock_resp_headers {
                    if !h.name.trim().is_empty()
                        && !is_hop_by_hop_header(&h.name)
                        && !h.name.eq_ignore_ascii_case("content-length")
                        && !(strip_alt_svc && is_alt_svc_header(&h.name))
                    {
                        if let (Ok(hn), Ok(hv)) = (
                            http::HeaderName::from_bytes(h.name.trim().as_bytes()),
                            http::HeaderValue::from_str(&h.value),
                        ) {
                            resp_builder = resp_builder.header(hn, hv);
                        }
                    }
                }
                return resp_builder
                    .body(boxed_full(mock_bytes))
                    .unwrap_or_else(|_| {
                        plain_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "Python script mock build error",
                        )
                    });
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
            let mock_out = build_autoresponder_mock_detail(
                &ctx,
                AutoResponderMockInput {
                    session_id,
                    rule,
                    protocol: resolve_protocol_label(&scheme_str, alpn, req_version),
                    scheme: scheme_str.clone(),
                    method: method_str,
                    host: host_header,
                    path: path_and_query,
                    full_url,
                    req_headers,
                    req_bytes: &body_bytes,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    timestamp,
                    process_name: client_proc.as_ref().map(|p| p.name.clone()),
                    process_pid: client_proc.as_ref().map(|p| p.pid),
                    req_mutated,
                    bp_modified,
                    client_ip: Some(normalize_client_ip(client_addr)),
                    client_addr: client_addr.to_string(),
                    tls_version: if scheme_str == "https" {
                        Some("TLS 1.3 (MITM Mock)".into())
                    } else {
                        None
                    },
                },
            );
            let capped_req = &body_bytes[..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
            let capped_mock = &mock_out.2[..mock_out.2.len().min(MAX_CAPTURED_BODY_BYTES)];
            record_completed_session(&ctx, mock_out.0, Some(capped_req), Some(capped_mock));

            let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();
            let mut resp_builder = Response::builder().status(
                StatusCode::from_u16(rule.status_code).unwrap_or(StatusCode::OK),
            );
            for h in &mock_out.1 {
                if !h.name.trim().is_empty() && !(strip_alt_svc && is_alt_svc_header(&h.name)) {
                    resp_builder = resp_builder.header(&h.name, &h.value);
                }
            }
            return resp_builder
                .body(boxed_full(Bytes::from(mock_out.2)))
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

    let target_host = reqwest::Url::parse(&full_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| host_header.clone());
    let upstream_target = prepare_remapped_upstream_target(&ctx, &full_url, &host_header, &scheme_str);

    let (upstream_client, mtls_cn) = if should_use_host_mtls_for_peer(client_addr, &scheme_str) {
        match ctx.client_certs.get_or_build_client_with_resolver(
            &target_host,
            false,
            Some(ctx.host_remap.clone()),
        ) {
            Ok(Some((mtls_client, entry))) => (mtls_client, Some(entry.common_name)),
            Ok(None) => (ctx.upstream_client(), None),
            Err(err) => {
                let msg = format!("Client certificate (mTLS) error for '{target_host}': {err}");
                tracing::warn!("{msg}");
                return record_and_return_error_with_opts(
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
                    StatusCode::BAD_GATEWAY,
                    upstream_target.remapped_to.clone(),
                    msg,
                );
            }
        }
    } else {
        (ctx.upstream_client(), None)
    };

    record_in_flight_session_with_remap(
        &ctx,
        session_id,
        timestamp.clone(),
        resolve_protocol_label(&scheme_str, alpn, req_version),
        scheme_str.clone(),
        method_str.clone(),
        host_header.clone(),
        path_and_query.clone(),
        full_url.clone(),
        client_proc.as_ref().map(|p| p.name.clone()),
        client_proc.as_ref().map(|p| p.pid),
        req_mutated,
        bp_modified,
        Some(normalize_client_ip(client_addr)),
        client_addr.to_string(),
        if scheme_str == "https" {
            Some(match &mtls_cn {
                Some(cn) => format!("TLS 1.3 (MITM · mTLS: {cn})"),
                None => "TLS 1.3 (MITM)".into(),
            })
        } else {
            None
        },
        req_headers.clone(),
        &body_bytes,
        upstream_target.remapped_to.clone(),
    );

    // Apply Bandwidth Throttling RTT latency & upload bandwidth pacing before upstream send
    if let Err(err) = ctx.throttle.apply_latency().await {
        return record_and_return_error_with_opts(
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
            StatusCode::SERVICE_UNAVAILABLE,
            upstream_target.remapped_to.clone(),
            err.to_string(),
        );
    }
    if !body_bytes.is_empty() {
        if let Err(err) = ctx.throttle.throttle_bytes(body_bytes.len(), false).await {
            return record_and_return_error_with_opts(
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
                StatusCode::SERVICE_UNAVAILABLE,
                upstream_target.remapped_to.clone(),
                err.to_string(),
            );
        }
    }

    let mut upstream_resp = match send_upstream_with_retry(&upstream_client, &reqwest_method, |client| {
        let mut upstream_req = client.request(reqwest_method.clone(), &upstream_target.upstream_url);
        for h in &req_headers {
            if !is_hop_by_hop_header(&h.name)
                && !h.name.eq_ignore_ascii_case("host")
                && !h.name.eq_ignore_ascii_case("content-length")
            {
                upstream_req = upstream_req.header(&h.name, &h.value);
            }
        }
        if let Some(ref host_override) = upstream_target.host_header_override {
            upstream_req = upstream_req.header(reqwest::header::HOST, host_override);
        }
        if !body_bytes.is_empty() {
            upstream_req = upstream_req.body(body_bytes.clone());
        }
        upstream_req
    })
    .await
    {
        Ok(r) => r,
        Err(err) => {
            let chain = format_error_chain(&err);
            tracing::warn!(
                "Upstream connection error for {} {}: {}",
                method_str,
                full_url,
                chain
            );
            return record_and_return_error_with_opts(
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
                StatusCode::BAD_GATEWAY,
                upstream_target.remapped_to.clone(),
                format!("Upstream connection error: {chain}"),
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

    let is_head_request = method_str.eq_ignore_ascii_case("HEAD");
    let is_sse_stream = content_type
        .to_ascii_lowercase()
        .starts_with("text/event-stream");
    let should_break_resp =
        ctx.breakpoints
            .should_break(BreakpointStage::Response, &method_str, &full_url);

    // 4a. Real-time Server-Sent Events (`text/event-stream`) zero-buffering pass-through & chunk capture
    if is_sse_stream && !should_break_resp && !is_head_request {
        let mut sse_remaining_encodings = extract_content_encoding_tokens(&resp_headers);
        let sse_has_zstd = sse_remaining_encodings
            .last()
            .is_some_and(|t| t.eq_ignore_ascii_case("zstd") || t.eq_ignore_ascii_case("x-zstd"));
        if sse_has_zstd {
            sse_remaining_encodings.pop();
            while sse_remaining_encodings
                .last()
                .is_some_and(|t| t.eq_ignore_ascii_case("identity"))
            {
                sse_remaining_encodings.pop();
            }
        }
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
            remapped_to: upstream_target.remapped_to.clone(),
        };

        let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
        let initial_detail = SessionDetail {
            summary: initial_summary.clone(),
            request_headers: req_headers,
            response_headers: resp_headers.clone(),
            request_body_base64: req_b64,
            response_body_base64: String::new(),
            request_body_text: req_txt,
            response_body_text: Some(String::new()),
            tls_version: if scheme_str == "https" {
                Some(match &mtls_cn {
                    Some(cn) => format!("TLS 1.3 (MITM SSE · mTLS: {cn})"),
                    None => "TLS 1.3 (MITM SSE)".into(),
                })
            } else {
                None
            },
            client_addr: client_addr.to_string(),
            websocket_frames: Vec::new(),
            sse_events: Vec::new(),
            body_offloaded: false,
            request_body_offloaded: req_offloaded,
        };

        record_completed_session(&ctx, initial_detail, Some(capped_req), None);

        let (chunk_tx, chunk_rx) = mpsc::channel::<Result<Frame<Bytes>, Infallible>>(64);
        let sse_ctx = ctx.clone();

        tokio::spawn(async move {
            use std::io::Write;

            struct BoundedSseZstdSink {
                buf: Vec<u8>,
                total_written: usize,
                max_total: usize,
            }

            impl Write for BoundedSseZstdSink {
                fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                    if self.total_written.saturating_add(data.len()) > self.max_total {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            format!(
                                "SSE zstd decompressed output exceeds limit of {} bytes",
                                self.max_total
                            ),
                        ));
                    }
                    self.total_written = self.total_written.saturating_add(data.len());
                    self.buf.extend_from_slice(data);
                    Ok(data.len())
                }

                fn flush(&mut self) -> std::io::Result<()> {
                    Ok(())
                }
            }

            const MAX_SSE_EVENTS: usize = 1024;
            let mut pending_parse_buf: Vec<u8> = Vec::new();
            let mut total_parsed_events = 0usize;
            let mut total_bytes = 0usize;
            let mut download_pacer = BandwidthPacer::new();
            let mut zstd_decoder = if sse_has_zstd {
                match zstd::stream::write::Decoder::new(BoundedSseZstdSink {
                    buf: Vec::new(),
                    total_written: 0,
                    max_total: MAX_CAPTURED_BODY_BYTES,
                }) {
                    Ok(dec) => Some(dec),
                    Err(err) => {
                        tracing::warn!("Failed to initialize SSE zstd stream decoder: {err}");
                        return;
                    }
                }
            } else {
                None
            };

            while let Ok(Some(chunk)) = upstream_resp.chunk().await {
                if download_pacer.pace(&sse_ctx.throttle, chunk.len(), true).await.is_err() {
                    break;
                }
                let effective_chunk = if let Some(dec) = zstd_decoder.as_mut() {
                    if let Err(err) = dec.write_all(&chunk).and_then(|()| dec.flush()) {
                        tracing::warn!("SSE zstd stream decode error: {err}");
                        break;
                    }
                    let decoded = std::mem::take(&mut dec.get_mut().buf);
                    if decoded.is_empty() {
                        continue;
                    }
                    Bytes::from(decoded)
                } else {
                    chunk
                };

                let chunk_offset_ms = start.elapsed().as_millis() as u64;
                total_bytes += effective_chunk.len();
                record_sse_chunk(
                    &sse_ctx,
                    session_id,
                    &effective_chunk,
                    &mut pending_parse_buf,
                    &mut total_parsed_events,
                    total_bytes,
                    chunk_offset_ms,
                    MAX_SSE_EVENTS,
                );

                if chunk_tx.send(Ok(Frame::data(effective_chunk))).await.is_err() {
                    break;
                }
            }

            if let Some(mut dec) = zstd_decoder {
                let _ = dec.flush();
                let tail_decoded = std::mem::take(&mut dec.get_mut().buf);
                if !tail_decoded.is_empty() {
                    let chunk_offset_ms = start.elapsed().as_millis() as u64;
                    total_bytes += tail_decoded.len();
                    record_sse_chunk(
                        &sse_ctx,
                        session_id,
                        &tail_decoded,
                        &mut pending_parse_buf,
                        &mut total_parsed_events,
                        total_bytes,
                        chunk_offset_ms,
                        MAX_SSE_EVENTS,
                    );
                    let _ = chunk_tx.send(Ok(Frame::data(Bytes::from(tail_decoded)))).await;
                }
            }

            // Flush any trailing partial SSE block and finalize Base64/text/SQLite offload once
            let end_ms = start.elapsed().as_millis() as u64;
            let trailing_event = if !pending_parse_buf.is_empty() && total_parsed_events < MAX_SSE_EVENTS {
                parse_single_sse_block(&pending_parse_buf, total_parsed_events + 1, end_ms)
            } else {
                None
            };
            if let Some(updated_summary) =
                sse_ctx
                    .store
                    .finalize_sse_stream(session_id, end_ms, trailing_event, MAX_SSE_EVENTS)
            {
                let _ = sse_ctx.event_tx.send(updated_summary);
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
        if !sse_remaining_encodings.is_empty() {
            builder = builder.header("Content-Encoding", sse_remaining_encodings.join(", "));
        }
        return builder
            .body(http_body_util::BodyExt::boxed(StreamBody::new(stream)))
            .unwrap_or_else(|_| {
                plain_response(StatusCode::BAD_GATEWAY, "Failed building SSE response")
            });
    }

    // 4b. Zero-buffering Streaming for Media (`video/*`, `audio/*`), `206 Partial Content`,
    // and large responses (> 2 MiB) when neither Breakpoint After Response nor Zstd buffering is required
    let resp_has_zstd = has_zstd_content_encoding(&resp_headers);
    let ct_lower = content_type.to_ascii_lowercase();
    let is_media_or_partial =
        final_status == 206 || ct_lower.starts_with("video/") || ct_lower.starts_with("audio/");
    let resp_content_length = resp_headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("content-length"))
        .and_then(|h| h.value.trim().parse::<usize>().ok());
    let is_large_stream_body = resp_content_length
        .map(|len| len > BODY_OFFLOAD_THRESHOLD_BYTES)
        .unwrap_or(false);

    if !is_head_request
        && !should_break_resp
        && !is_sse_stream
        && !resp_has_zstd
        && (is_media_or_partial || is_large_stream_body)
    {
        let has_reqwest_decoded_encoding = resp_headers.iter().any(|h| {
            h.name.trim().eq_ignore_ascii_case("content-encoding")
                && h.value.split(',').any(|token| {
                    let t = token.trim();
                    t.eq_ignore_ascii_case("gzip")
                        || t.eq_ignore_ascii_case("x-gzip")
                        || t.eq_ignore_ascii_case("br")
                        || t.eq_ignore_ascii_case("deflate")
                })
        });
        let capture_text_preview = !is_media_or_partial
            && (ct_lower.starts_with("text/") || ct_lower.starts_with("application/"));

        let capped_req = &body_bytes[..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
        let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
        let initial_summary = SessionSummary {
            id: session_id,
            status: final_status,
            protocol: protocol_label,
            scheme: scheme_str.clone(),
            method: method_str,
            host: host_header,
            path: path_and_query,
            url: full_url,
            content_type,
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
            remapped_to: upstream_target.remapped_to.clone(),
        };

        let initial_detail = SessionDetail {
            summary: initial_summary,
            request_headers: req_headers,
            response_headers: resp_headers.clone(),
            request_body_base64: req_b64,
            response_body_base64: String::new(),
            request_body_text: req_txt,
            response_body_text: None,
            tls_version: if scheme_str == "https" {
                Some(match &mtls_cn {
                    Some(cn) => format!("TLS 1.3 (MITM Stream · mTLS: {cn})"),
                    None => "TLS 1.3 (MITM Stream)".into(),
                })
            } else {
                None
            },
            client_addr: client_addr.to_string(),
            websocket_frames: Vec::new(),
            sse_events: Vec::new(),
            body_offloaded: false,
            request_body_offloaded: req_offloaded,
        };

        // Stage 21 Phase 1: publish final response headers & status immediately before streaming chunks
        let initial_recorded =
            record_completed_session(&ctx, initial_detail.clone(), Some(capped_req), None);
        let req_body_for_deferred_end = if initial_recorded {
            None
        } else {
            Some(body_bytes.slice(..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)))
        };

        let (chunk_tx, chunk_rx) = mpsc::channel::<Result<Frame<Bytes>, Infallible>>(32);
        let stream_ctx = ctx.clone();

        tokio::spawn(async move {
            let mut total_bytes: usize = 0;
            let mut preview_accum: Vec<u8> = Vec::new();
            let mut stream_error: Option<String> = None;
            let mut last_emit = Instant::now() - Duration::from_secs(1);
            let mut download_pacer = BandwidthPacer::new();

            loop {
                match upstream_resp.chunk().await {
                    Ok(Some(chunk)) => {
                        if let Err(err) = download_pacer.pace(&stream_ctx.throttle, chunk.len(), true).await {
                            stream_error = Some(err.to_string());
                            break;
                        }
                        total_bytes = total_bytes.saturating_add(chunk.len());

                        if capture_text_preview
                            && preview_accum.len() < STREAM_TEXT_PREVIEW_MAX_BYTES
                        {
                            let room = STREAM_TEXT_PREVIEW_MAX_BYTES - preview_accum.len();
                            preview_accum.extend_from_slice(&chunk[..chunk.len().min(room)]);
                        }

                        if chunk_tx.send(Ok(Frame::data(chunk))).await.is_err() {
                            break;
                        }

                        if last_emit.elapsed() >= Duration::from_millis(150) {
                            last_emit = Instant::now();
                            let elapsed_ms = start.elapsed().as_millis() as u64;
                            if let Some(mut detail) = stream_ctx.store.get(session_id) {
                                detail.summary.body_size = total_bytes;
                                detail.summary.duration_ms = elapsed_ms;
                                let updated_summary = detail.summary.clone();
                                stream_ctx.store.insert(detail);
                                let _ = stream_ctx.event_tx.send(updated_summary);
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(err) => {
                        let chain = format_error_chain(&err);
                        tracing::warn!(
                            "Upstream stream chunk error for session #{session_id} after {total_bytes} bytes: {chain}"
                        );
                        stream_error = Some(format!("Upstream response stream error: {chain}"));
                        break;
                    }
                }
            }

            drop(chunk_tx);

            let final_duration_ms = start.elapsed().as_millis() as u64;
            let mut final_detail = stream_ctx.store.get(session_id).unwrap_or(initial_detail);
            final_detail.summary.body_size = total_bytes;
            final_detail.summary.duration_ms = final_duration_ms;
            if let Some(ref err_msg) = stream_error {
                final_detail.summary.error = Some(err_msg.clone());
            }
            if capture_text_preview && !preview_accum.is_empty() {
                final_detail.response_body_base64 =
                    base64::engine::general_purpose::STANDARD.encode(&preview_accum);
                final_detail.response_body_text =
                    std::str::from_utf8(&preview_accum).ok().map(str::to_owned);
            } else {
                final_detail.response_body_base64.clear();
                final_detail.response_body_text = None;
            }

            if initial_recorded || stream_error.is_some() || total_bytes > 0 {
                let _ = record_completed_session(
                    &stream_ctx,
                    final_detail,
                    req_body_for_deferred_end.as_deref(),
                    None,
                );
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
                && !(has_reqwest_decoded_encoding
                    && (h.name.eq_ignore_ascii_case("content-encoding")
                        || h.name.eq_ignore_ascii_case("content-length")))
                && !(strip_alt_svc && is_alt_svc_header(&h.name))
            {
                builder = builder.header(&h.name, &h.value);
            }
        }
        return builder
            .body(http_body_util::BodyExt::boxed(StreamBody::new(stream)))
            .unwrap_or_else(|_| {
                plain_response(StatusCode::BAD_GATEWAY, "Failed building streamed response")
            });
    }

    // 4c. Standard Buffered Upstream Response (+ Optional Live Breakpoint After Response)
    let raw_resp_bytes = if ctx.throttle.get_config().download_bytes_per_sec().is_some()
        || ctx.throttle.is_offline()
    {
        let mut collected = Vec::new();
        let mut download_pacer = BandwidthPacer::new();
        let mut stream_err: Option<(StatusCode, String)> = None;
        loop {
            match upstream_resp.chunk().await {
                Ok(Some(chunk)) => {
                    if let Err(err) = download_pacer.pace(&ctx.throttle, chunk.len(), true).await {
                        stream_err = Some((StatusCode::SERVICE_UNAVAILABLE, err.to_string()));
                        break;
                    }
                    collected.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(err) => {
                    let chain = format_error_chain(&err);
                    stream_err = Some((
                        StatusCode::BAD_GATEWAY,
                        format!("Failed reading upstream response body: {chain}"),
                    ));
                    break;
                }
            }
        }
        if let Some((err_status, err_msg)) = stream_err {
            return record_and_return_error_with_opts(
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
                err_status,
                upstream_target.remapped_to.clone(),
                err_msg,
            );
        }
        Bytes::from(collected)
    } else {
        match upstream_resp.bytes().await {
            Ok(b) => b,
            Err(err) => {
                let chain = format_error_chain(&err);
                return record_and_return_error_with_opts(
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
                    StatusCode::BAD_GATEWAY,
                    upstream_target.remapped_to.clone(),
                    format!("Failed reading upstream response body: {chain}"),
                );
            }
        }
    };

    let (mut resp_bytes, decoded_any_encoding, mut remaining_content_encodings) =
        if is_head_request {
            (
                raw_resp_bytes,
                false,
                extract_content_encoding_tokens(&resp_headers),
            )
        } else {
            let decoded = maybe_decompress_content_encodings(&resp_headers, raw_resp_bytes).await;
            (
                decoded.body,
                decoded.decoded_any,
                decoded.remaining_encodings,
            )
        };
    let mut resp_body_modified = false;
    let mut resp_headers_replaced_by_bp = false;

    // 4c-script. Python Scripting Engine: on_response(response)
    // Explicitly skipped for SSE (`text/event-stream`), media (`video/*`, `audio/*`),
    // and `206 Partial Content` streams so zero-buffering paths remain untouched.
    let is_streaming_response = is_sse_stream
        || final_status == 206
        || ct_lower.starts_with("video/")
        || ct_lower.starts_with("audio/");
    if !is_streaming_response && ctx.script_runner.should_run_response() {
        if let ScriptResponseOutcome::Modified(edits) = ctx
            .script_runner
            .run_on_response(
                session_id,
                &method_str,
                &full_url,
                final_status,
                &resp_headers,
                &resp_bytes,
            )
            .await
        {
            if let Some(next_status) = edits.status {
                if (100..=599).contains(&next_status) && next_status != final_status {
                    final_status = next_status;
                    resp_mutated = true;
                }
            }
            let script_touched_ce = edits
                .headers_removed
                .iter()
                .chain(edits.headers_set.iter().map(|(k, _)| k))
                .any(|k| k.trim().eq_ignore_ascii_case("content-encoding"));
            if edits.headers_changed
                && apply_header_diff(&mut resp_headers, &edits.headers_removed, &edits.headers_set)
            {
                let _ = ctx.filters.strip_alt_svc_headers(&mut resp_headers);
                if let Some(ct_hdr) = resp_headers
                    .iter()
                    .find(|h| h.name.eq_ignore_ascii_case("content-type"))
                {
                    content_type = ct_hdr.value.clone();
                }
                if script_touched_ce && !resp_body_modified {
                    remaining_content_encodings = extract_content_encoding_tokens(&resp_headers);
                }
                resp_mutated = true;
            }
            if let Some(next_body) = edits.body {
                resp_bytes = Bytes::from(next_body);
                remaining_content_encodings.clear();
                resp_body_modified = true;
                resp_mutated = true;
            }
        }
    }

    // 4c. Live Breakpoint: After Response (Alt+F11 / `bpafter`)
    if should_break_resp {
        let mut resp_vec = resp_bytes.to_vec();
        let bp_outcome = run_response_breakpoint_stage(
            &ctx,
            ResponseBreakpointStageInput {
                session_id,
                protocol: protocol_label.clone(),
                scheme: scheme_str.clone(),
                method: method_str.clone(),
                host: host_header.clone(),
                path: path_and_query.clone(),
                url: full_url.clone(),
                content_type: content_type.clone(),
                timestamp: timestamp.clone(),
                start,
                process_name: client_proc.as_ref().map(|p| p.name.clone()),
                process_pid: client_proc.as_ref().map(|p| p.pid),
                client_ip: Some(normalize_client_ip(client_addr)),
                client_addr: client_addr.to_string(),
                tls_version: if scheme_str == "https" {
                    Some("TLS 1.3 (MITM Paused)".into())
                } else {
                    None
                },
                is_mocked,
                matched_rule_id: matched_rule_id.clone(),
                req_headers: req_headers.clone(),
                req_bytes: body_bytes.to_vec(),
                req_mutated,
                insert_paused_summary: true,
            },
            &mut final_status,
            &mut resp_headers,
            &mut resp_vec,
            &mut resp_mutated,
            &mut bp_modified,
        )
        .await;
        if bp_outcome.aborted {
            return record_and_return_error_with_opts(
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
                StatusCode::BAD_GATEWAY,
                upstream_target.remapped_to.clone(),
                "Aborted at Live Breakpoint (After Response)".to_string(),
            );
        }
        if bp_outcome.headers_changed {
            if let Some(ct_hdr) = resp_headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case("content-type"))
            {
                content_type = ct_hdr.value.clone();
            }
            if !decoded_any_encoding && !resp_body_modified {
                remaining_content_encodings = extract_content_encoding_tokens(&resp_headers);
            } else {
                remaining_content_encodings.clear();
            }
            resp_headers_replaced_by_bp = true;
        }
        if bp_outcome.body_changed {
            resp_bytes = Bytes::from(resp_vec);
            remaining_content_encodings.clear();
            resp_body_modified = true;
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
        remapped_to: upstream_target.remapped_to.clone(),
    };

    let capped_req = &body_bytes[..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
    let capped_resp = &resp_bytes[..resp_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
    let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
    let (resp_b64, resp_txt, resp_offloaded) = encode_inline_or_offload(capped_resp);

    let detail = SessionDetail {
        summary: summary.clone(),
        request_headers: req_headers,
        response_headers: resp_headers.clone(),
        request_body_base64: req_b64,
        response_body_base64: resp_b64,
        request_body_text: req_txt,
        response_body_text: resp_txt,
        tls_version: if scheme_str == "https" {
            Some(match &mtls_cn {
                Some(cn) => format!("TLS 1.3 (MITM · mTLS: {cn})"),
                None => "TLS 1.3 (MITM)".into(),
            })
        } else {
            None
        },
        client_addr: client_addr.to_string(),
        websocket_frames: Vec::new(),
        sse_events,
        body_offloaded: resp_offloaded,
        request_body_offloaded: req_offloaded,
    };

    record_completed_session(&ctx, detail, Some(capped_req), Some(capped_resp));

    let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();
    let preserve_head_content_length =
        is_head_request && resp_bytes.is_empty() && !resp_body_modified;
    let preserve_original_content_length = preserve_head_content_length
        || (!decoded_any_encoding
            && !remaining_content_encodings.is_empty()
            && !resp_body_modified
            && !resp_headers_replaced_by_bp);
    let mut builder =
        Response::builder().status(StatusCode::from_u16(final_status).unwrap_or(StatusCode::OK));
    for h in &resp_headers {
        // Reqwest transparently decompresses single-token gzip/brotli/deflate bodies and
        // `maybe_decompress_content_encodings` peels supported outer layers (e.g. `zstd`, `br, zstd`).
        // Re-emit only encodings that were not decoded, and preserve upstream `Content-Length` for
        // empty `HEAD` responses (and unmodified undecoded responses).
        // Also strip HTTP/3 QUIC discovery headers (`alt-svc`, `alternate-protocol`) when enabled.
        let keep_cl = h.name.eq_ignore_ascii_case("content-length")
            && (preserve_head_content_length
                || (preserve_original_content_length
                    && h.value.trim().parse::<usize>().ok() == Some(resp_bytes.len())));
        if !is_hop_by_hop_header(&h.name)
            && !h.name.eq_ignore_ascii_case("content-encoding")
            && (!h.name.eq_ignore_ascii_case("content-length") || keep_cl)
            && !(strip_alt_svc && is_alt_svc_header(&h.name))
        {
            builder = builder.header(&h.name, &h.value);
        }
    }
    if !remaining_content_encodings.is_empty() {
        builder = builder.header("Content-Encoding", remaining_content_encodings.join(", "));
    }

    builder
        .body(boxed_full(resp_bytes))
        .unwrap_or_else(|_| plain_response(StatusCode::BAD_GATEWAY, "Failed building proxy response"))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn rewrite_request_url_fields(
    next_url: &str,
    full_url: &mut String,
    scheme_str: &mut String,
    host_header: &mut String,
    path_and_query: &mut String,
    req_headers: &mut Vec<HeaderPair>,
) -> bool {
    let trimmed_u = next_url.trim();
    if trimmed_u.is_empty() || trimmed_u == full_url.as_str() {
        return false;
    }
    let Ok(parsed) = reqwest::Url::parse(trimmed_u) else {
        return false;
    };
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
    true
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_request_breakpoint_edits(
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
        if rewrite_request_url_fields(
            u,
            full_url,
            scheme_str,
            host_header,
            path_and_query,
            req_headers,
        ) {
            *bp_modified = true;
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_script_request_edits(
    edits: ScriptRequestEdits,
    method_str: &mut String,
    full_url: &mut String,
    scheme_str: &mut String,
    host_header: &mut String,
    path_and_query: &mut String,
    req_headers: &mut Vec<HeaderPair>,
    body_bytes: &mut Bytes,
    req_mutated: &mut bool,
) {
    if let Some(ref m) = edits.method {
        let trimmed = m.trim().to_ascii_uppercase();
        if !trimmed.is_empty() && trimmed != *method_str {
            *method_str = trimmed;
            *req_mutated = true;
        }
    }

    if edits.headers_changed
        && apply_header_diff(req_headers, &edits.headers_removed, &edits.headers_set)
    {
        *req_mutated = true;
    }

    if let Some(ref u) = edits.url {
        if rewrite_request_url_fields(
            u,
            full_url,
            scheme_str,
            host_header,
            path_and_query,
            req_headers,
        ) {
            *req_mutated = true;
        }
    }

    if let Some(next_body) = edits.body {
        *body_bytes = Bytes::from(next_body);
        *req_mutated = true;
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn record_sse_chunk(
    sse_ctx: &SharedProxyContext,
    session_id: u64,
    chunk_slice: &[u8],
    pending_parse_buf: &mut Vec<u8>,
    total_parsed_events: &mut usize,
    total_bytes: usize,
    chunk_offset_ms: u64,
    max_events: usize,
) {
    if *total_parsed_events < max_events && pending_parse_buf.len() < MAX_CAPTURED_BODY_BYTES {
        let room = MAX_CAPTURED_BODY_BYTES - pending_parse_buf.len();
        let take = chunk_slice.len().min(room);
        pending_parse_buf.extend_from_slice(&chunk_slice[..take]);
    }
    let new_events = drain_complete_sse_events_incremental(
        pending_parse_buf,
        total_parsed_events,
        chunk_offset_ms,
        max_events,
    );
    if let Some(updated_summary) = sse_ctx.store.append_sse_chunk(
        session_id,
        crate::storage::SseChunkUpdate {
            chunk_slice,
            new_events,
            total_bytes,
            duration_ms: chunk_offset_ms,
            max_capture_bytes: MAX_CAPTURED_BODY_BYTES,
            max_events,
        },
    ) {
        let _ = sse_ctx.event_tx.send(updated_summary);
    }
}

pub(super) fn drain_complete_sse_events_incremental(
    pending_buf: &mut Vec<u8>,
    total_parsed_events: &mut usize,
    offset_ms: u64,
    max_events: usize,
) -> Vec<SseEventRecord> {
    if *total_parsed_events >= max_events {
        pending_buf.clear();
        return Vec::new();
    }
    let mut cursor = 0usize;
    let mut new_events = Vec::new();
    while cursor < pending_buf.len() && *total_parsed_events < max_events {
        let slice = &pending_buf[cursor..];
        let Some((rel_end, delim_len)) = find_sse_delimiter(slice) else {
            break;
        };
        let block = &slice[..rel_end];
        cursor += rel_end + delim_len;
        if let Some(ev) = parse_single_sse_block(block, *total_parsed_events + 1, offset_ms) {
            *total_parsed_events += 1;
            new_events.push(ev);
        }
    }
    if *total_parsed_events >= max_events {
        pending_buf.clear();
    } else if cursor > 0 {
        pending_buf.drain(..cursor);
    }
    new_events
}

pub(super) fn drain_complete_sse_events(
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

pub(super) fn find_sse_delimiter(slice: &[u8]) -> Option<(usize, usize)> {
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

pub fn parse_sse_events_from_bytes(
    buf: &[u8],
    total_duration_ms: u64,
) -> Vec<SseEventRecord> {
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

pub(super) fn parse_single_sse_block(
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

pub(super) struct RequestBreakpointStageInput {
    pub session_id: u64,
    pub protocol: String,
    pub timestamp: String,
    pub start: Instant,
    pub process_name: Option<String>,
    pub process_pid: Option<u32>,
    pub client_ip: Option<String>,
    pub client_addr: String,
    pub tls_version: Option<String>,
    pub summary_body_size: usize,
    pub req_mutated: bool,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_request_breakpoint_stage(
    ctx: &Arc<SharedProxyContext>,
    input: RequestBreakpointStageInput,
    method_str: &mut String,
    full_url: &mut String,
    scheme_str: &mut String,
    host_header: &mut String,
    path_and_query: &mut String,
    req_headers: &mut Vec<HeaderPair>,
    req_body: &mut Vec<u8>,
    bp_modified: &mut bool,
) -> Result<(), ()> {
    let bp_id = format!("bp-req-{}", input.session_id);
    let capped_req = &req_body[..req_body.len().min(MAX_CAPTURED_BODY_BYTES)];
    let req_b64 = base64::engine::general_purpose::STANDARD.encode(capped_req);
    let req_txt = std::str::from_utf8(capped_req).ok().map(str::to_owned);

    let paused_summary = SessionSummary {
        id: input.session_id,
        status: 0,
        protocol: input.protocol,
        scheme: scheme_str.clone(),
        method: method_str.clone(),
        host: host_header.clone(),
        path: path_and_query.clone(),
        url: full_url.clone(),
        content_type: "pending/breakpoint-request".into(),
        body_size: input.summary_body_size,
        duration_ms: input.start.elapsed().as_millis() as u64,
        timestamp: input.timestamp,
        is_mocked: false,
        matched_rule_id: None,
        error: None,
        process_name: input.process_name.clone(),
        process_pid: input.process_pid,
        tls_bypassed: false,
        headers_mutated: input.req_mutated,
        breakpoint_paused: Some("request".into()),
        breakpoint_modified: false,
        comment: None,
        marked_color: None,
        client_ip: input.client_ip,
        remapped_to: None,
    };
    ctx.store.insert(SessionDetail {
        summary: paused_summary.clone(),
        request_headers: req_headers.clone(),
        response_headers: Vec::new(),
        request_body_base64: req_b64.clone(),
        response_body_base64: String::new(),
        request_body_text: req_txt.clone(),
        response_body_text: None,
        tls_version: input.tls_version,
        client_addr: input.client_addr,
        websocket_frames: Vec::new(),
        sse_events: Vec::new(),
        body_offloaded: false,
        request_body_offloaded: false,
    });
    let _ = ctx.event_tx.send(paused_summary);

    let (bp_rx, timeout_secs) = ctx.breakpoints.park(PausedBreakpointItem {
        breakpoint_id: bp_id.clone(),
        session_id: input.session_id,
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
        process_name: input.process_name,
        process_pid: input.process_pid,
    });
    let mut bp_guard = make_breakpoint_guard(ctx, bp_id.clone(), input.session_id, input.start);

    let wait_res = tokio::time::timeout(Duration::from_secs(timeout_secs), bp_rx).await;
    bp_guard.disarm();

    match wait_res {
        Ok(Ok(verdict)) => {
            if verdict.action == BreakpointAction::Abort {
                return Err(());
            }

            apply_request_breakpoint_edits(
                &verdict,
                method_str,
                full_url,
                scheme_str,
                host_header,
                path_and_query,
                req_headers,
                bp_modified,
            );

            if let Some(txt) = verdict.request_body_text {
                let next_bytes = txt.into_bytes();
                if next_bytes != *req_body {
                    *req_body = next_bytes;
                    *bp_modified = true;
                }
            } else if let Some(b64) = verdict.request_body_base64 {
                if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                    if decoded != *req_body {
                        *req_body = decoded;
                        *bp_modified = true;
                    }
                }
            }
        }
        _ => {
            ctx.breakpoints.remove_expired(&bp_id);
        }
    }
    Ok(())
}

pub(super) struct ResponseBreakpointStageInput {
    pub session_id: u64,
    pub protocol: String,
    pub scheme: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub url: String,
    pub content_type: String,
    pub timestamp: String,
    pub start: Instant,
    pub process_name: Option<String>,
    pub process_pid: Option<u32>,
    pub client_ip: Option<String>,
    pub client_addr: String,
    pub tls_version: Option<String>,
    pub is_mocked: bool,
    pub matched_rule_id: Option<String>,
    pub req_headers: Vec<HeaderPair>,
    pub req_bytes: Vec<u8>,
    pub req_mutated: bool,
    pub insert_paused_summary: bool,
}

pub(super) struct ResponseBreakpointOutcome {
    pub aborted: bool,
    pub headers_changed: bool,
    pub body_changed: bool,
}

pub(super) async fn run_response_breakpoint_stage(
    ctx: &Arc<SharedProxyContext>,
    input: ResponseBreakpointStageInput,
    status: &mut u16,
    resp_headers: &mut Vec<HeaderPair>,
    resp_bytes: &mut Vec<u8>,
    resp_mutated: &mut bool,
    bp_modified: &mut bool,
) -> ResponseBreakpointOutcome {
    let bp_id = format!("bp-resp-{}", input.session_id);
    let capped_req = &input.req_bytes[..input.req_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
    let capped_resp = &resp_bytes[..resp_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
    let req_b64 = base64::engine::general_purpose::STANDARD.encode(capped_req);
    let resp_b64 = base64::engine::general_purpose::STANDARD.encode(capped_resp);
    let req_txt = std::str::from_utf8(capped_req).ok().map(str::to_owned);
    let resp_txt = std::str::from_utf8(capped_resp).ok().map(str::to_owned);

    if input.insert_paused_summary {
        let paused_summary = SessionSummary {
            id: input.session_id,
            status: *status,
            protocol: input.protocol.clone(),
            scheme: input.scheme.clone(),
            method: input.method.clone(),
            host: input.host.clone(),
            path: input.path.clone(),
            url: input.url.clone(),
            content_type: input.content_type,
            body_size: resp_bytes.len(),
            duration_ms: input.start.elapsed().as_millis() as u64,
            timestamp: input.timestamp,
            is_mocked: input.is_mocked,
            matched_rule_id: input.matched_rule_id,
            error: None,
            process_name: input.process_name.clone(),
            process_pid: input.process_pid,
            tls_bypassed: false,
            headers_mutated: input.req_mutated || *resp_mutated,
            breakpoint_paused: Some("response".into()),
            breakpoint_modified: *bp_modified,
            comment: None,
            marked_color: None,
            client_ip: input.client_ip,
            remapped_to: None,
        };
        ctx.store.insert(SessionDetail {
            summary: paused_summary.clone(),
            request_headers: input.req_headers.clone(),
            response_headers: resp_headers.clone(),
            request_body_base64: req_b64.clone(),
            response_body_base64: resp_b64.clone(),
            request_body_text: req_txt.clone(),
            response_body_text: resp_txt.clone(),
            tls_version: input.tls_version,
            client_addr: input.client_addr,
            websocket_frames: Vec::new(),
            sse_events: Vec::new(),
            body_offloaded: false,
            request_body_offloaded: false,
        });
        let _ = ctx.event_tx.send(paused_summary);
    }

    let (bp_rx, timeout_secs) = ctx.breakpoints.park(PausedBreakpointItem {
        breakpoint_id: bp_id.clone(),
        session_id: input.session_id,
        stage: BreakpointStage::Response,
        created_at: Utc::now().to_rfc3339(),
        timeout_secs: 120,
        scheme: input.scheme,
        method: input.method,
        url: input.url,
        host: input.host,
        path: input.path,
        request_headers: input.req_headers,
        request_body_base64: req_b64,
        request_body_text: req_txt,
        response_status: Some(*status),
        response_headers: resp_headers.clone(),
        response_body_base64: resp_b64,
        response_body_text: resp_txt,
        process_name: input.process_name,
        process_pid: input.process_pid,
    });
    let mut bp_guard = make_breakpoint_guard(ctx, bp_id.clone(), input.session_id, input.start);

    let wait_res = tokio::time::timeout(Duration::from_secs(timeout_secs), bp_rx).await;
    bp_guard.disarm();

    let mut headers_changed = false;
    let mut body_changed = false;

    match wait_res {
        Ok(Ok(verdict)) => {
            if verdict.action == BreakpointAction::Abort {
                return ResponseBreakpointOutcome {
                    aborted: true,
                    headers_changed: false,
                    body_changed: false,
                };
            }
            if let Some(sc) = verdict.status_code {
                if sc != *status {
                    *status = sc;
                    *bp_modified = true;
                }
            }
            if let Some(hdrs) = verdict.response_headers {
                *resp_headers = hdrs;
                if ctx.filters.strip_alt_svc_headers(resp_headers) {
                    *resp_mutated = true;
                }
                headers_changed = true;
                *bp_modified = true;
            }
            if let Some(txt) = verdict.response_body_text {
                let next_b = txt.into_bytes();
                if next_b != *resp_bytes {
                    *resp_bytes = next_b;
                    body_changed = true;
                    *bp_modified = true;
                }
            } else if let Some(b64) = verdict.response_body_base64 {
                if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                    if decoded != *resp_bytes {
                        *resp_bytes = decoded;
                        body_changed = true;
                        *bp_modified = true;
                    }
                }
            }
        }
        _ => {
            ctx.breakpoints.remove_expired(&bp_id);
        }
    }

    ResponseBreakpointOutcome {
        aborted: false,
        headers_changed,
        body_changed,
    }
}

pub(super) struct AutoResponderMockInput<'a> {
    pub session_id: u64,
    pub rule: &'a AutoResponderRule,
    pub protocol: String,
    pub scheme: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub full_url: String,
    pub req_headers: Vec<HeaderPair>,
    pub req_bytes: &'a [u8],
    pub elapsed_ms: u64,
    pub timestamp: String,
    pub process_name: Option<String>,
    pub process_pid: Option<u32>,
    pub req_mutated: bool,
    pub bp_modified: bool,
    pub client_ip: Option<String>,
    pub client_addr: String,
    pub tls_version: Option<String>,
}

pub(super) fn build_autoresponder_mock_detail(
    ctx: &SharedProxyContext,
    input: AutoResponderMockInput<'_>,
) -> (SessionDetail, Vec<HeaderPair>, Vec<u8>) {
    let mock_bytes = input.rule.response_body.clone().into_bytes();
    let mut mock_resp_headers = input.rule.response_headers.clone();
    let resp_mutated = ctx.filters.apply_header_mutations(
        HeaderMutationDirection::Response,
        &input.full_url,
        &mut mock_resp_headers,
    );
    let content_type = mock_resp_headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("content-type"))
        .map(|h| h.value.clone())
        .unwrap_or_else(|| "application/json; charset=utf-8".to_string());

    let sse_events = if content_type.to_ascii_lowercase().starts_with("text/event-stream") {
        parse_sse_events_from_bytes(&mock_bytes, input.elapsed_ms)
    } else {
        Vec::new()
    };

    let summary = SessionSummary {
        id: input.session_id,
        status: input.rule.status_code,
        protocol: input.protocol,
        scheme: input.scheme,
        method: input.method,
        host: input.host,
        path: input.path,
        url: input.full_url,
        content_type,
        body_size: mock_bytes.len(),
        duration_ms: input.elapsed_ms,
        timestamp: input.timestamp,
        is_mocked: true,
        matched_rule_id: Some(input.rule.id.clone()),
        error: None,
        process_name: input.process_name,
        process_pid: input.process_pid,
        tls_bypassed: false,
        headers_mutated: input.req_mutated || resp_mutated,
        breakpoint_paused: None,
        breakpoint_modified: input.bp_modified,
        comment: None,
        marked_color: None,
        client_ip: input.client_ip,
        remapped_to: None,
    };

    let capped_req = &input.req_bytes[..input.req_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
    let capped_mock = &mock_bytes[..mock_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
    let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
    let (resp_b64, resp_txt, resp_offloaded) = encode_inline_or_offload(capped_mock);

    let detail = SessionDetail {
        summary,
        request_headers: input.req_headers,
        response_headers: mock_resp_headers.clone(),
        request_body_base64: req_b64,
        response_body_base64: resp_b64,
        request_body_text: req_txt,
        response_body_text: resp_txt,
        tls_version: input.tls_version,
        client_addr: input.client_addr,
        websocket_frames: Vec::new(),
        sse_events,
        body_offloaded: resp_offloaded,
        request_body_offloaded: req_offloaded,
    };

    (detail, mock_resp_headers, mock_bytes)
}
