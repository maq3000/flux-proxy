use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use http::header::{HOST, UPGRADE};
use http::{Request, Response, StatusCode};
use http_body_util::{BodyExt, LengthLimitError, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use tokio::sync::mpsc;

use crate::models::{
    BreakpointStage, HeaderPair, RuleActionType, SessionDetail, SessionSummary, SessionTimings,
    SessionTransferStats, SseEventRecord,
};
use crate::proxy::filters::{ConnectTunnelDecision, PassthroughReason};
use crate::proxy::network::normalize_client_ip;
use crate::proxy::process::ClientProcessInfo;
use crate::proxy::throttle::BandwidthPacer;
use crate::proxy::upstream_client::{
    duration_ms_f64, elapsed_ms, estimate_request_headers_bytes, estimate_response_headers_bytes,
    format_rfc3339_micros, round_ms, timestamp_at_instant, TrackedResponseBody,
};
use crate::scripting::{ScriptRequestOutcome, ScriptResponseOutcome};
use crate::storage::BODY_OFFLOAD_THRESHOLD_BYTES;

use super::mobile_portal::{handle_builtin_portal_request, is_builtin_portal_target};
use super::pipeline_stages::*;
use super::websocket_relay::handle_websocket_intercept;
use super::{
    boxed_full, encode_inline_or_offload, extract_hyper_headers, format_http_version,
    format_mitm_tls_display, format_raw_http_version, is_loopback_ip,
    is_loopback_or_unspecified_host, parse_host_and_optional_port, plain_response,
    record_completed_session, record_in_flight_session_with_remap,
    request_targets_loopback_or_unspecified, resolve_protocol_label,
    should_use_host_mtls_for_peer, ClientConnContext, ProxyBoxBody, SharedProxyContext,
    MAX_BUFFERED_RESPONSE_BODY_BYTES, MAX_CAPTURED_BODY_BYTES,
    MAX_CAPTURED_REQUEST_BODY_BYTES, MAX_CONTENT_ENCODING_LAYERS, STREAM_TEXT_PREVIEW_MAX_BYTES,
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

#[derive(Debug)]
pub(super) enum ResponseBodyReadError {
    PayloadTooLarge { limit: usize, bytes_read: usize },
    Throttle { message: String, bytes_read: usize },
    Transport { message: String, bytes_read: usize },
}

pub(super) enum ResponseBodyCollectOutcome<B> {
    Complete(Bytes),
    Spilled {
        prefix: Vec<Bytes>,
        remaining: B,
    },
}

pub(super) async fn collect_response_body_or_spill<B>(
    mut body: B,
    throttle: &crate::proxy::throttle::ThrottleEngine,
    max_bytes: usize,
    spill_threshold: Option<usize>,
) -> Result<ResponseBodyCollectOutcome<B>, ResponseBodyReadError>
where
    B: hyper::body::Body<Data = Bytes> + Unpin,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    let use_throttle = throttle.get_config().download_bytes_per_sec().is_some()
        || throttle.is_offline();
    if spill_threshold.is_none() && !use_throttle {
        return match Limited::new(body, max_bytes).collect().await {
            Ok(collected) => Ok(ResponseBodyCollectOutcome::Complete(collected.to_bytes())),
            Err(err) => {
                if err.is::<LengthLimitError>() {
                    Err(ResponseBodyReadError::PayloadTooLarge {
                        limit: max_bytes,
                        bytes_read: max_bytes,
                    })
                } else {
                    Err(ResponseBodyReadError::Transport {
                        message: format_error_chain(err.as_ref()),
                        bytes_read: 0,
                    })
                }
            }
        };
    }

    let mut collected: Vec<u8> = Vec::new();
    let mut prefix_chunks: Vec<Bytes> = Vec::new();
    let mut bytes_read: usize = 0;
    let mut pacer = BandwidthPacer::new();

    loop {
        match body.frame().await {
            Some(Ok(frame)) => {
                let Some(chunk) = frame.into_data().ok().filter(|c| !c.is_empty()) else {
                    continue;
                };
                if spill_threshold.is_none() && bytes_read.saturating_add(chunk.len()) > max_bytes {
                    return Err(ResponseBodyReadError::PayloadTooLarge {
                        limit: max_bytes,
                        bytes_read,
                    });
                }
                if use_throttle {
                    if let Err(err) = pacer.pace(throttle, chunk.len(), true).await {
                        return Err(ResponseBodyReadError::Throttle {
                            message: err.to_string(),
                            bytes_read,
                        });
                    }
                }
                bytes_read = bytes_read.saturating_add(chunk.len());
                if let Some(threshold) = spill_threshold {
                    prefix_chunks.push(chunk);
                    if bytes_read > threshold {
                        return Ok(ResponseBodyCollectOutcome::Spilled {
                            prefix: prefix_chunks,
                            remaining: body,
                        });
                    }
                } else {
                    collected.extend_from_slice(&chunk);
                }
            }
            None => {
                if spill_threshold.is_some() {
                    if prefix_chunks.len() == 1 {
                        return Ok(ResponseBodyCollectOutcome::Complete(
                            prefix_chunks.into_iter().next().unwrap_or_default(),
                        ));
                    }
                    let mut flat = Vec::with_capacity(bytes_read);
                    for c in prefix_chunks {
                        flat.extend_from_slice(&c);
                    }
                    return Ok(ResponseBodyCollectOutcome::Complete(Bytes::from(flat)));
                }
                return Ok(ResponseBodyCollectOutcome::Complete(Bytes::from(collected)));
            }
            Some(Err(err)) => {
                return Err(ResponseBodyReadError::Transport {
                    message: format_error_chain(&err),
                    bytes_read,
                });
            }
        }
    }
}

pub(super) async fn collect_response_body_limited<B>(
    body: B,
    throttle: &crate::proxy::throttle::ThrottleEngine,
    max_bytes: usize,
) -> Result<Bytes, ResponseBodyReadError>
where
    B: hyper::body::Body<Data = Bytes> + Unpin,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    match collect_response_body_or_spill(body, throttle, max_bytes, None).await? {
        ResponseBodyCollectOutcome::Complete(bytes) => Ok(bytes),
        ResponseBodyCollectOutcome::Spilled { .. } => unreachable!(),
    }
}

pub(super) struct BoundedSseSink {
    pub(super) buf: Vec<u8>,
    pub(super) total_written: usize,
    pub(super) max_total: usize,
}

impl BoundedSseSink {
    pub(super) fn new(max_total: usize) -> Self {
        Self {
            buf: Vec::new(),
            total_written: 0,
            max_total,
        }
    }

    pub(super) fn take_bytes(&mut self) -> Vec<u8> {
        self.total_written = 0;
        std::mem::take(&mut self.buf)
    }
}

impl std::io::Write for BoundedSseSink {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.total_written.saturating_add(data.len()) > self.max_total {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "SSE decompressed output exceeds limit of {} bytes",
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

fn read_prefix_best_effort<R: std::io::Read>(mut reader: R, max_bytes: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut chunk = [0u8; 4096];
    while out.len() < max_bytes {
        let need = (max_bytes - out.len()).min(chunk.len());
        match reader.read(&mut chunk[..need]) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&chunk[..n]),
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    out
}

pub(super) fn decode_stream_preview_best_effort(
    encodings: &[String],
    raw_prefix: &[u8],
    max_bytes: usize,
) -> Vec<u8> {
    if raw_prefix.is_empty() || encodings.is_empty() || max_bytes == 0 {
        return raw_prefix.to_vec();
    }
    let mut current = raw_prefix.to_vec();
    let mut decoded_any = false;
    let mut peeled_layers = 0usize;

    for enc in encodings.iter().rev() {
        if peeled_layers >= MAX_CONTENT_ENCODING_LAYERS {
            break;
        }
        let enc_lower = enc.trim().to_ascii_lowercase();
        if enc_lower.is_empty() || enc_lower == "identity" {
            continue;
        }
        let next = match enc_lower.as_str() {
            "zstd" | "x-zstd" => match zstd::stream::read::Decoder::new(current.as_slice()) {
                Ok(dec) => read_prefix_best_effort(dec, max_bytes),
                Err(_) => break,
            },
            "gzip" | "x-gzip" => read_prefix_best_effort(
                flate2::read::GzDecoder::new(current.as_slice()),
                max_bytes,
            ),
            "deflate" => {
                let zlib = read_prefix_best_effort(
                    flate2::read::ZlibDecoder::new(current.as_slice()),
                    max_bytes,
                );
                if zlib.is_empty() {
                    read_prefix_best_effort(
                        flate2::read::DeflateDecoder::new(current.as_slice()),
                        max_bytes,
                    )
                } else {
                    zlib
                }
            }
            "br" => read_prefix_best_effort(
                brotli::Decompressor::new(current.as_slice(), 4096),
                max_bytes,
            ),
            _ => break,
        };
        if next.is_empty() {
            break;
        }
        current = next;
        decoded_any = true;
        peeled_layers += 1;
    }

    if decoded_any {
        current
    } else {
        raw_prefix.to_vec()
    }
}

pub(super) fn utf8_prefix_lossless(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => Some(s.to_owned()),
        Err(err) => {
            let valid_up_to = err.valid_up_to();
            if valid_up_to > 0 && err.error_len().is_none() {
                std::str::from_utf8(&bytes[..valid_up_to])
                    .ok()
                    .map(str::to_owned)
            } else {
                None
            }
        }
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

#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_intercepted_request(
    req: Request<Incoming>,
    scheme: &str,
    default_authority: Option<&str>,
    alpn: Option<&str>,
    client_addr: SocketAddr,
    client_proc: Option<ClientProcessInfo>,
    client_conn: ClientConnContext,
    ctx: Arc<SharedProxyContext>,
) -> Response<ProxyBoxBody> {
    if !ctx.filters.is_lan_client_allowed(client_addr.ip()) {
        return plain_response(
            StatusCode::FORBIDDEN,
            "Forbidden: client IP is not in the LAN Client Allowlist",
        );
    }

    if client_conn.is_draining_or_aborted() {
        return plain_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Service Unavailable: FluxProxy is stopping",
        );
    }

    let start = Instant::now();
    let start_utc = Utc::now();
    let timestamp = start_utc.to_rfc3339();
    let req_begin_at = format_rfc3339_micros(start_utc);
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
            &client_conn,
            &ctx,
        );
    }

    // 0a. Bandwidth Throttling: Offline mode blocks outbound HTTP/HTTPS/WS traffic immediately
    if ctx.throttle.is_offline() {
        let msg = "Network Offline (Bandwidth Throttling: Offline)".to_string();
        if client_conn.is_capture_suppressed() {
            return plain_response(StatusCode::SERVICE_UNAVAILABLE, &msg);
        }
        let (client_reused, client_tls_ms) = client_conn.claim_request_seq();
        let client_http_ver = format_raw_http_version(req.version()).to_string();
        let method_preview = req.method().as_str().to_string();
        let req_headers = extract_hyper_headers(req.headers());
        let req_headers_bytes = estimate_request_headers_bytes(
            &method_preview,
            &path_and_query,
            &client_http_ver,
            &req_headers,
        );
        let (err_timings, err_stats) = build_error_timings_and_stats(
            start,
            start_utc,
            &client_conn,
            client_reused,
            client_tls_ms,
            0.0,
            &client_http_ver,
            req_headers_bytes,
            0,
            msg.len(),
            0.0,
            0.0,
            None,
        );
        return record_and_return_error_with_telemetry(
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
            Some(err_timings),
            Some(err_stats),
            msg,
        );
    }

    // 0b. Enforce TLS policy against inner Host / HTTP/2 :authority in ALL MITM modes (InterceptAll & TargetedOnly)
    if let Some(tunnel_auth) = default_authority {
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

        let mut mismatched_targets: Vec<(String, u16)> = Vec::new();
        let host_norm = normalize_auth(host_hdr_raw);
        if host_norm != tunnel_norm {
            mismatched_targets.push(host_norm);
        }
        if let Some(ua) = uri_auth_raw {
            let uri_norm = normalize_auth(ua);
            if uri_norm != tunnel_norm && !mismatched_targets.contains(&uri_norm) {
                mismatched_targets.push(uri_norm);
            }
        }

        for (cand_host, cand_port) in mismatched_targets {
            if let ConnectTunnelDecision::Passthrough(reason) =
                ctx.filters.evaluate_connect_tunnel(&cand_host, cand_port)
            {
                return match reason {
                    PassthroughReason::NotInTargetAllowlist => plain_response(
                        StatusCode::FORBIDDEN,
                        "Forbidden: Host header or :authority differs from CONNECT authority and is outside TargetedOnly TLS allowlist",
                    ),
                    PassthroughReason::BypassRule(_) | PassthroughReason::NotInHostsWhitelist => {
                        plain_response(
                            StatusCode::MISDIRECTED_REQUEST,
                            "Misdirected Request: Host header or :authority differs from CONNECT authority and requires TLS Passthrough",
                        )
                    }
                };
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
            client_conn,
            ctx,
        )
        .await;
    }

    let (client_reused, client_tls_ms) = client_conn.claim_request_seq();
    let mut method_str = req.method().as_str().to_string();
    let req_version = req.version();
    let client_http_ver = format_raw_http_version(req_version).to_string();
    let mut req_headers = extract_hyper_headers(req.headers());
    let initial_req_host_hdr = req_headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("host"))
        .map(|h| h.value.clone());
    let mut req_mutated = apply_request_header_mutations(&ctx, &full_url, &mut req_headers);
    let mut req_headers_bytes =
        estimate_request_headers_bytes(&method_str, &path_and_query, &client_http_ver, &req_headers);

    let req_body_read_start = Instant::now();
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
            if client_conn.is_capture_suppressed() {
                return plain_response(StatusCode::PAYLOAD_TOO_LARGE, &msg);
            }
            let client_done_req_instant = Instant::now();
            let client_read_ms = duration_ms_f64(
                client_done_req_instant.saturating_duration_since(req_body_read_start),
            );
            let protocol = resolve_protocol_label(&scheme_str, alpn, req_version);
            let resp_headers = vec![HeaderPair::new("Content-Type", "text/plain; charset=utf-8")];
            let (mut err_timings, mut err_stats) = build_error_timings_and_stats(
                start,
                start_utc,
                &client_conn,
                client_reused,
                client_tls_ms,
                client_read_ms,
                &client_http_ver,
                req_headers_bytes,
                0,
                msg.len(),
                0.0,
                0.0,
                None,
            );
            err_stats.response_headers_bytes = Some(estimate_response_headers_bytes(
                StatusCode::PAYLOAD_TOO_LARGE.as_u16(),
                &client_http_ver,
                &resp_headers,
            ));
            err_timings.client_done_request =
                Some(timestamp_at_instant(start, start_utc, client_done_req_instant));
            let mut summary = SessionSummary {
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
            summary.apply_telemetry(Some(&err_timings), Some(&err_stats));
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
                timings: Some(err_timings),
                transfer_stats: Some(err_stats),
            };
            record_completed_session(&ctx, detail, None, Some(msg.as_bytes()));
            return plain_response(StatusCode::PAYLOAD_TOO_LARGE, &msg);
        }
        Err(RequestBodyReadError::Transport(err)) => {
            let msg = format!("Failed reading client request body: {err}");
            if client_conn.is_capture_suppressed() {
                return plain_response(StatusCode::BAD_GATEWAY, &msg);
            }
            let client_read_ms = elapsed_ms(req_body_read_start);
            let (err_timings, err_stats) = build_error_timings_and_stats(
                start,
                start_utc,
                &client_conn,
                client_reused,
                client_tls_ms,
                client_read_ms,
                &client_http_ver,
                req_headers_bytes,
                0,
                msg.len(),
                0.0,
                0.0,
                None,
            );
            return record_and_return_error_with_telemetry(
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
                StatusCode::BAD_GATEWAY,
                None,
                Some(err_timings),
                Some(err_stats),
                msg,
            );
        }
    };
    let client_done_req_instant = Instant::now();
    let client_done_request_at = timestamp_at_instant(start, start_utc, client_done_req_instant);
    let client_read_ms = duration_ms_f64(
        client_done_req_instant.saturating_duration_since(req_body_read_start),
    );

    let mut bp_modified = false;
    let mut total_bp_pause_ms = 0.0_f64;
    let mut total_script_hook_ms = 0.0_f64;
    let mut autoresponder_delay_ms = 0.0_f64;

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
            tls_version: format_mitm_tls_display(
                &scheme_str,
                client_conn.client_tls_version.as_deref(),
                Some("Paused"),
                None,
            ),
            summary_body_size: req_vec.len(),
            req_mutated,
        };
        let bp_start = Instant::now();
        let bp_res = run_request_breakpoint_stage(
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
        .await;
        total_bp_pause_ms += elapsed_ms(bp_start);
        if bp_res.is_err() {
            let msg = "Aborted at Live Breakpoint (Before Request)".to_string();
            if client_conn.is_capture_suppressed() {
                return plain_response(StatusCode::BAD_GATEWAY, &msg);
            }
            let (err_timings, err_stats) = build_error_timings_and_stats(
                start,
                start_utc,
                &client_conn,
                client_reused,
                client_tls_ms,
                client_read_ms,
                &client_http_ver,
                req_headers_bytes,
                req_vec.len(),
                msg.len(),
                total_bp_pause_ms,
                total_script_hook_ms,
                None,
            );
            return record_and_return_error_with_telemetry(
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
                StatusCode::BAD_GATEWAY,
                None,
                Some(err_timings),
                Some(err_stats),
                msg,
            );
        }
        body_bytes = Bytes::from(req_vec);
        req_headers_bytes =
            estimate_request_headers_bytes(&method_str, &path_and_query, &client_http_ver, &req_headers);
    }

    // 1c. Python Scripting Engine: on_request(request)
    if ctx.script_runner.should_run_request() {
        let py_req_start = Instant::now();
        let outcome = ctx
            .script_runner
            .run_on_request(session_id, &method_str, &full_url, &req_headers, &body_bytes)
            .await;
        total_script_hook_ms += elapsed_ms(py_req_start);
        match outcome {
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
                req_headers_bytes = estimate_request_headers_bytes(
                    &method_str,
                    &path_and_query,
                    &client_http_ver,
                    &req_headers,
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
                req_headers_bytes = estimate_request_headers_bytes(
                    &method_str,
                    &path_and_query,
                    &client_http_ver,
                    &req_headers,
                );

                let mock_status = mock.status;
                let (mut detail, mock_resp_headers, mock_bytes) = build_python_mock_detail(
                    &ctx,
                    PythonMockSessionInput {
                        session_id,
                        mock,
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
                        tls_version: format_mitm_tls_display(
                            &scheme_str,
                            client_conn.client_tls_version.as_deref(),
                            Some("Python Mock"),
                            None,
                        ),
                    },
                );
                apply_mock_session_telemetry(
                    &mut detail,
                    MockTimingStatsInput {
                        start,
                        start_utc,
                        client_connected_at: Some(client_conn.connected_at.as_str()),
                        req_begin_at: &req_begin_at,
                        client_done_request_at: &client_done_request_at,
                        client_read_ms,
                        client_tls_ms,
                        total_bp_pause_ms,
                        total_script_hook_ms,
                        autoresponder_delay_ms: None,
                        client_http_ver: &client_http_ver,
                        status: mock_status,
                        req_headers_bytes,
                        req_body_len: body_bytes.len(),
                        resp_headers: &mock_resp_headers,
                        resp_body_len: mock_bytes.len(),
                        client_conn_id: Some(client_conn.conn_id),
                        client_reused,
                        client_tls_version: client_conn.client_tls_version.as_deref(),
                        client_tls_cipher: client_conn.client_tls_cipher.as_deref(),
                        client_alpn: client_conn.client_alpn.as_deref(),
                    },
                );

                let capped_req = &body_bytes[..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
                let capped_mock = &mock_bytes[..mock_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
                if !client_conn.is_capture_suppressed() {
                    record_completed_session(&ctx, detail, Some(capped_req), Some(capped_mock));
                }

                let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();
                let resp_builder = append_filtered_response_headers(
                    Response::builder()
                        .status(StatusCode::from_u16(mock_status).unwrap_or(StatusCode::OK)),
                    &mock_resp_headers,
                    strip_alt_svc,
                    false,
                    true,
                );
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
            let delay_start = Instant::now();
            tokio::time::sleep(Duration::from_millis(rule.latency_ms)).await;
            autoresponder_delay_ms = elapsed_ms(delay_start);
        }

        if matches!(rule.action, RuleActionType::MockResponse) {
            let (mut mock_detail, mock_resp_headers, mock_bytes) = build_autoresponder_mock_detail(
                &ctx,
                AutoResponderMockInput {
                    session_id,
                    rule,
                    protocol: resolve_protocol_label(&scheme_str, alpn, req_version),
                    scheme: scheme_str.clone(),
                    method: method_str,
                    host: host_header,
                    path: path_and_query.clone(),
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
                    tls_version: format_mitm_tls_display(
                        &scheme_str,
                        client_conn.client_tls_version.as_deref(),
                        Some("Mock"),
                        None,
                    ),
                },
            );
            apply_mock_session_telemetry(
                &mut mock_detail,
                MockTimingStatsInput {
                    start,
                    start_utc,
                    client_connected_at: Some(client_conn.connected_at.as_str()),
                    req_begin_at: &req_begin_at,
                    client_done_request_at: &client_done_request_at,
                    client_read_ms,
                    client_tls_ms,
                    total_bp_pause_ms,
                    total_script_hook_ms,
                    autoresponder_delay_ms: Some(autoresponder_delay_ms),
                    client_http_ver: &client_http_ver,
                    status: rule.status_code,
                    req_headers_bytes,
                    req_body_len: body_bytes.len(),
                    resp_headers: &mock_resp_headers,
                    resp_body_len: mock_bytes.len(),
                    client_conn_id: Some(client_conn.conn_id),
                    client_reused,
                    client_tls_version: client_conn.client_tls_version.as_deref(),
                    client_tls_cipher: client_conn.client_tls_cipher.as_deref(),
                    client_alpn: client_conn.client_alpn.as_deref(),
                },
            );

            let capped_req = &body_bytes[..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
            let capped_mock = &mock_bytes[..mock_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
            if !client_conn.is_capture_suppressed() {
                record_completed_session(&ctx, mock_detail, Some(capped_req), Some(capped_mock));
            }

            let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();
            let mock_body_bytes = Bytes::from(mock_bytes);
            let mock_cl = mock_body_bytes.len().to_string();
            let resp_builder = append_filtered_response_headers(
                Response::builder()
                    .status(StatusCode::from_u16(rule.status_code).unwrap_or(StatusCode::OK)),
                &mock_resp_headers,
                strip_alt_svc,
                true,
                true,
            )
            .header(http::header::CONTENT_LENGTH, mock_cl);
            return resp_builder
                .body(boxed_full(mock_body_bytes))
                .unwrap_or_else(|_| {
                    plain_response(StatusCode::INTERNAL_SERVER_ERROR, "Mock build error")
                });
        }
    }

    // 3. Forward Request Upstream
    let http_method = match http::Method::from_bytes(method_str.as_bytes()) {
        Ok(m) => m,
        Err(err) => {
            return plain_response(StatusCode::BAD_REQUEST, &format!("Invalid method: {err}"));
        }
    };

    let target_host = url::Url::parse(&full_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| host_header.clone());
    if is_remote_peer
        && ctx
            .host_remap
            .match_host(&target_host)
            .is_some_and(|rule| is_loopback_or_unspecified_host(&rule.target_host))
    {
        return plain_response(
            StatusCode::FORBIDDEN,
            "Forbidden: remote LAN clients cannot use HOSTS Remapping targeting loopback or unspecified hosts",
        );
    }
    let current_req_host_hdr = req_headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("host"))
        .map(|h| h.value.clone());
    let host_explicitly_modified = current_req_host_hdr.is_some()
        && current_req_host_hdr != initial_req_host_hdr;
    let host_for_remap = current_req_host_hdr
        .as_deref()
        .unwrap_or(host_header.as_str());
    let upstream_target =
        prepare_remapped_upstream_target(&ctx, &full_url, host_for_remap, &scheme_str);
    let effective_host_override = if host_explicitly_modified {
        current_req_host_hdr.clone()
    } else {
        upstream_target.host_header_override.clone()
    };

    let (upstream_client, mtls_cn) = if should_use_host_mtls_for_peer(client_addr, &scheme_str) {
        match ctx
            .client_certs
            .get_or_build_upstream_client(
                &target_host,
                Some(ctx.host_remap.clone()),
                Some(ctx.upstream_proxy.clone()),
                Arc::clone(&ctx.connect_timeout_sec),
            )
        {
            Ok(Some((mtls_client, entry))) => (mtls_client, Some(entry.common_name)),
            Ok(None) => (ctx.upstream_http_client_for_peer(is_remote_peer), None),
            Err(err) => {
                let msg = format!("Client certificate (mTLS) error for '{target_host}': {err}");
                tracing::warn!("{msg}");
                if client_conn.is_capture_suppressed() {
                    return plain_response(StatusCode::BAD_GATEWAY, &msg);
                }
                let (err_timings, err_stats) = build_error_timings_and_stats(
                    start,
                    start_utc,
                    &client_conn,
                    client_reused,
                    client_tls_ms,
                    client_read_ms,
                    &client_http_ver,
                    req_headers_bytes,
                    body_bytes.len(),
                    msg.len(),
                    total_bp_pause_ms,
                    total_script_hook_ms,
                    upstream_target.remapped_to.clone(),
                );
                return record_and_return_error_with_telemetry(
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
                    Some(err_timings),
                    Some(err_stats),
                    msg,
                );
            }
        }
    } else {
        (ctx.upstream_http_client_for_peer(is_remote_peer), None)
    };

    if !client_conn.is_capture_suppressed() {
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
            format_mitm_tls_display(
                &scheme_str,
                client_conn.client_tls_version.as_deref(),
                None,
                mtls_cn.as_deref(),
            ),
            req_headers.clone(),
            &body_bytes,
            upstream_target.remapped_to.clone(),
        );
    }
    let mut in_flight_guard = super::InFlightSessionGuard::new_with_lifecycle(
        Arc::clone(&ctx),
        session_id,
        start,
        client_conn.lifecycle.clone(),
    );

    // Apply Bandwidth Throttling RTT latency & upload bandwidth pacing before upstream send
    if let Err(err) = ctx.throttle.apply_latency().await {
        in_flight_guard.disarm();
        let msg = err.to_string();
        if client_conn.is_capture_suppressed() {
            return plain_response(StatusCode::SERVICE_UNAVAILABLE, &msg);
        }
        let (err_timings, err_stats) = build_error_timings_and_stats(
            start,
            start_utc,
            &client_conn,
            client_reused,
            client_tls_ms,
            client_read_ms,
            &client_http_ver,
            req_headers_bytes,
            body_bytes.len(),
            msg.len(),
            total_bp_pause_ms,
            total_script_hook_ms,
            upstream_target.remapped_to.clone(),
        );
        return record_and_return_error_with_telemetry(
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
            Some(err_timings),
            Some(err_stats),
            msg,
        );
    }
    if !body_bytes.is_empty() {
        if let Err(err) = ctx.throttle.throttle_bytes(body_bytes.len(), false).await {
            in_flight_guard.disarm();
            let msg = err.to_string();
            if client_conn.is_capture_suppressed() {
                return plain_response(StatusCode::SERVICE_UNAVAILABLE, &msg);
            }
            let (err_timings, err_stats) = build_error_timings_and_stats(
                start,
                start_utc,
                &client_conn,
                client_reused,
                client_tls_ms,
                client_read_ms,
                &client_http_ver,
                req_headers_bytes,
                body_bytes.len(),
                msg.len(),
                total_bp_pause_ms,
                total_script_hook_ms,
                upstream_target.remapped_to.clone(),
            );
            return record_and_return_error_with_telemetry(
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
                Some(err_timings),
                Some(err_stats),
                msg,
            );
        }
    }

    let outbound_headers =
        filter_outbound_request_headers(&req_headers, effective_host_override.is_some());
    let response_timeout = ctx.response_header_timeout();

    let exchange = match upstream_client
        .send_with_idempotent_retry(
            http_method,
            &upstream_target.upstream_url,
            &outbound_headers,
            effective_host_override.as_deref(),
            body_bytes.clone(),
            response_timeout,
        )
        .await
    {
        Ok(ex) => ex,
        Err(err) => {
            in_flight_guard.disarm();
            let chain = format_error_chain(&err);
            let proxy_err_code = err.proxy_error_code();
            tracing::warn!(
                "Upstream error for {} {} [{}]: {}",
                method_str,
                full_url,
                proxy_err_code,
                chain
            );
            let msg = match &err {
                crate::proxy::upstream_client::UpstreamClientError::Timeout(_) => {
                    format!("Upstream response timeout: {chain}")
                }
                crate::proxy::upstream_client::UpstreamClientError::Forbidden(reason) => {
                    reason.clone()
                }
                _ => format!("Upstream connection error: {chain}"),
            };
            if client_conn.is_capture_suppressed() {
                return plain_response(err.status_hint(), &msg);
            }
            let (err_timings, err_stats) = build_error_timings_and_stats(
                start,
                start_utc,
                &client_conn,
                client_reused,
                client_tls_ms,
                client_read_ms,
                &client_http_ver,
                req_headers_bytes,
                body_bytes.len(),
                msg.len(),
                total_bp_pause_ms,
                total_script_hook_ms,
                upstream_target.remapped_to.clone(),
            );
            return record_and_return_error_with_telemetry_and_code(
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
                err.status_hint(),
                upstream_target.remapped_to.clone(),
                Some(err_timings),
                Some(err_stats),
                msg,
                Some(proxy_err_code),
            );
        }
    };

    let conn_meta = exchange.conn_meta.clone();
    let claimed = exchange.claimed.clone();
    let proxy_begin_request_at = exchange.proxy_begin_request_at.clone();
    let server_got_request_at = exchange.server_got_request_at.clone();
    let got_response_headers_at = exchange.got_response_headers_at.clone();
    let got_response_headers_instant = exchange.got_response_headers_instant;
    let send_request_ms = exchange.send_request_ms;
    let server_wait_ms = exchange.server_wait_ms;
    let upstream_resp = exchange.response;

    let mut final_status = upstream_resp.status().as_u16();
    let mut is_mocked = false;
    let mut matched_rule_id = None;
    apply_autoresponder_status_override(
        matched_rule.as_ref(),
        &mut final_status,
        &mut is_mocked,
        &mut matched_rule_id,
    );

    let upstream_version = upstream_resp.version();
    let server_http_ver = format_raw_http_version(upstream_version).to_string();
    let mut resp_headers = extract_hyper_headers(upstream_resp.headers());
    let raw_response_content_encoding = resp_headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("content-encoding"))
        .map(|h| h.value.clone());
    let resp_headers_bytes =
        estimate_response_headers_bytes(final_status, &server_http_ver, &resp_headers);
    let mut resp_mutated = apply_response_header_mutations(&ctx, &full_url, &mut resp_headers);
    let mut content_type = resp_headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("content-type"))
        .map(|h| h.value.clone())
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let protocol_label = if alpn.is_some() {
        resolve_protocol_label(&scheme_str, alpn, req_version)
    } else {
        format_http_version(&scheme_str, upstream_version)
    };

    let mut base_timings = SessionTimings {
        client_connected: Some(client_conn.connected_at.clone()),
        client_begin_request: Some(req_begin_at.clone()),
        got_request_headers: Some(req_begin_at.clone()),
        client_done_request: Some(client_done_request_at.clone()),
        proxy_begin_request: Some(proxy_begin_request_at),
        server_connected: claimed.as_ref().and_then(|c| c.server_connected_at.clone()),
        server_got_request: Some(server_got_request_at),
        server_begin_response: Some(got_response_headers_at.clone()),
        got_response_headers: Some(got_response_headers_at.clone()),
        client_read_ms: Some(client_read_ms),
        client_tls_handshake_ms: client_tls_ms,
        dns_ms: Some(claimed.as_ref().map_or(0.0, |c| c.dns_ms)),
        tcp_connect_ms: Some(claimed.as_ref().map_or(0.0, |c| c.tcp_connect_ms)),
        tls_handshake_ms: claimed.as_ref().and_then(|c| c.tls_handshake_ms),
        send_request_ms: Some(send_request_ms),
        server_wait_ms: Some(server_wait_ms),
        breakpoint_pause_ms: (total_bp_pause_ms > 0.0).then(|| round_ms(total_bp_pause_ms)),
        script_hook_ms: (total_script_hook_ms > 0.0).then(|| round_ms(total_script_hook_ms)),
        autoresponder_delay_ms: (autoresponder_delay_ms > 0.0)
            .then(|| round_ms(autoresponder_delay_ms)),
        ..Default::default()
    };
    let mut base_stats = build_upstream_transfer_stats(UpstreamTransferStatsInput {
        req_headers_bytes,
        req_body_len: body_bytes.len(),
        resp_headers_bytes,
        resp_body_len: None,
        resp_wire_body_len: None,
        raw_response_content_encoding,
        client_conn_id: Some(client_conn.conn_id),
        client_reused,
        client_http_ver: client_http_ver.clone(),
        client_tls_version: client_conn.client_tls_version.clone(),
        client_tls_cipher: client_conn.client_tls_cipher.clone(),
        client_alpn: client_conn.client_alpn.clone(),
        server_http_ver,
        conn_meta: conn_meta.as_deref(),
        claimed: claimed.as_ref(),
        mtls_cn: mtls_cn.clone(),
        request_remapped_to: upstream_target.remapped_to.clone(),
    });

    let mut upstream_resp_body = upstream_resp.into_body();

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
        let outer_sse_encoding = sse_remaining_encodings
            .last()
            .map(|t| t.trim().to_ascii_lowercase())
            .filter(|t| {
                matches!(
                    t.as_str(),
                    "zstd" | "x-zstd" | "gzip" | "x-gzip" | "deflate" | "br"
                )
            });
        if outer_sse_encoding.is_some() {
            sse_remaining_encodings.pop();
            while sse_remaining_encodings
                .last()
                .is_some_and(|t| t.eq_ignore_ascii_case("identity"))
            {
                sse_remaining_encodings.pop();
            }
        }
        base_stats.is_streaming = Some(true);
        base_stats.response_body_bytes = Some(0);
        base_stats.response_wire_body_bytes = Some(0);
        base_timings.client_begin_response = Some(got_response_headers_at.clone());
        compute_timings_summary(&mut base_timings, elapsed_ms(start));

        let capped_req = &body_bytes[..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
        let mut initial_summary = SessionSummary {
            id: session_id,
            status: final_status,
            protocol: protocol_label,
            scheme: scheme_str.clone(),
            method: method_str,
            host: host_header.clone(),
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
        initial_summary.apply_telemetry(Some(&base_timings), Some(&base_stats));

        let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
        let initial_detail = SessionDetail {
            summary: initial_summary,
            request_headers: req_headers,
            response_headers: resp_headers.clone(),
            request_body_base64: req_b64,
            response_body_base64: String::new(),
            request_body_text: req_txt,
            response_body_text: Some(String::new()),
            tls_version: format_mitm_tls_display(
                &scheme_str,
                client_conn.client_tls_version.as_deref(),
                Some("SSE"),
                mtls_cn.as_deref(),
            ),
            client_addr: client_addr.to_string(),
            websocket_frames: Vec::new(),
            sse_events: Vec::new(),
            body_offloaded: false,
            request_body_offloaded: req_offloaded,
            timings: Some(base_timings),
            transfer_stats: Some(base_stats),
        };

        in_flight_guard.disarm();
        if !client_conn.is_capture_suppressed() {
            record_completed_session(&ctx, initial_detail, Some(capped_req), None);
        }

        let (chunk_tx, chunk_rx) = mpsc::channel::<Result<Frame<Bytes>, Infallible>>(64);
        let sse_ctx = ctx.clone();
        let sse_lifecycle = client_conn.lifecycle.clone();
        let (sse_host, sse_opt_port) = parse_host_and_optional_port(&host_header);
        let sse_port = sse_opt_port.unwrap_or_else(|| default_port_for_scheme(&scheme_str));
        let sse_is_https = scheme_str.eq_ignore_ascii_case("https");

        tokio::spawn(async move {
            enum SseStreamDecoder {
                Zstd(zstd::stream::write::Decoder<'static, BoundedSseSink>),
                Gzip(flate2::write::GzDecoder<BoundedSseSink>),
                Deflate(flate2::write::ZlibDecoder<BoundedSseSink>),
                Brotli(Box<brotli::DecompressorWriter<BoundedSseSink>>),
            }

            impl SseStreamDecoder {
                fn write_and_take(&mut self, input: &[u8]) -> Result<Vec<u8>, String> {
                    use std::io::Write;
                    match self {
                        Self::Zstd(d) => {
                            d.write_all(input)
                                .and_then(|()| d.flush())
                                .map_err(|e| e.to_string())?;
                            Ok(d.get_mut().take_bytes())
                        }
                        Self::Gzip(d) => {
                            d.write_all(input)
                                .and_then(|()| d.flush())
                                .map_err(|e| e.to_string())?;
                            Ok(d.get_mut().take_bytes())
                        }
                        Self::Deflate(d) => {
                            d.write_all(input)
                                .and_then(|()| d.flush())
                                .map_err(|e| e.to_string())?;
                            Ok(d.get_mut().take_bytes())
                        }
                        Self::Brotli(d) => {
                            d.write_all(input)
                                .and_then(|()| d.flush())
                                .map_err(|e| e.to_string())?;
                            Ok(d.get_mut().take_bytes())
                        }
                    }
                }

                fn flush_tail(mut self) -> Vec<u8> {
                    use std::io::Write;
                    match &mut self {
                        Self::Zstd(d) => {
                            let _ = d.flush();
                            d.get_mut().take_bytes()
                        }
                        Self::Gzip(d) => {
                            let _ = d.flush();
                            d.get_mut().take_bytes()
                        }
                        Self::Deflate(d) => {
                            let _ = d.flush();
                            d.get_mut().take_bytes()
                        }
                        Self::Brotli(d) => {
                            let _ = d.flush();
                            d.get_mut().take_bytes()
                        }
                    }
                }
            }

            let make_sink = || BoundedSseSink::new(MAX_CAPTURED_BODY_BYTES);

            let mut decoder = match outer_sse_encoding.as_deref() {
                Some("zstd" | "x-zstd") => {
                    match zstd::stream::write::Decoder::new(make_sink()) {
                        Ok(dec) => Some(SseStreamDecoder::Zstd(dec)),
                        Err(err) => {
                            tracing::warn!("Failed to initialize SSE zstd stream decoder: {err}");
                            return;
                        }
                    }
                }
                Some("gzip" | "x-gzip") => {
                    Some(SseStreamDecoder::Gzip(flate2::write::GzDecoder::new(make_sink())))
                }
                Some("deflate") => {
                    Some(SseStreamDecoder::Deflate(flate2::write::ZlibDecoder::new(make_sink())))
                }
                Some("br") => Some(SseStreamDecoder::Brotli(Box::new(
                    brotli::DecompressorWriter::new(make_sink(), 4096),
                ))),
                _ => None,
            };

            const MAX_SSE_EVENTS: usize = 1024;
            let mut pending_parse_buf: Vec<u8> = Vec::new();
            let mut total_parsed_events = 0usize;
            let mut total_bytes = 0usize;
            let mut total_wire_bytes = 0usize;
            let mut last_sse_emit: Option<Instant> = None;
            let mut download_pacer = BandwidthPacer::new();
            let mut abort_sig = sse_lifecycle.clone();
            let mut drain_expire_sig = sse_lifecycle.clone();
            let mut config_rx = sse_ctx.filters.subscribe_config_updates();
            let mut config_closed = false;

            loop {
                let maybe_frame = tokio::select! {
                    biased;
                    _ = abort_sig.wait_abort() => break,
                    _ = drain_expire_sig.wait_drain_expired() => break,
                    changed = config_rx.changed(), if !config_closed => {
                        if changed.is_err() {
                            config_closed = true;
                            continue;
                        }
                        if !sse_ctx.filters.is_lan_client_allowed(client_addr.ip())
                            || (sse_is_https
                                && matches!(
                                    sse_ctx.filters.evaluate_connect_tunnel(&sse_host, sse_port),
                                    ConnectTunnelDecision::Passthrough(_)
                                ))
                        {
                            break;
                        }
                        continue;
                    }
                    res = upstream_resp_body.frame() => res,
                };
                let Some(Ok(frame)) = maybe_frame else {
                    break;
                };
                let Some(chunk) = frame.into_data().ok().filter(|c| !c.is_empty()) else {
                    continue;
                };
                total_wire_bytes = total_wire_bytes.saturating_add(chunk.len());
                if download_pacer.pace(&sse_ctx.throttle, chunk.len(), true).await.is_err() {
                    break;
                }
                let effective_chunk = if let Some(dec) = decoder.as_mut() {
                    match dec.write_and_take(&chunk) {
                        Ok(decoded) if decoded.is_empty() => continue,
                        Ok(decoded) => Bytes::from(decoded),
                        Err(err) => {
                            tracing::warn!("SSE stream decode error: {err}");
                            break;
                        }
                    }
                } else {
                    chunk
                };

                let chunk_offset_ms = start.elapsed().as_millis() as u64;
                total_bytes = total_bytes.saturating_add(effective_chunk.len());
                if !sse_lifecycle.is_capture_suppressed() {
                    record_sse_chunk(
                        &sse_ctx,
                        session_id,
                        &effective_chunk,
                        &mut pending_parse_buf,
                        &mut total_parsed_events,
                        total_bytes,
                        chunk_offset_ms,
                        MAX_SSE_EVENTS,
                        &mut last_sse_emit,
                    );
                }

                if chunk_tx.send(Ok(Frame::data(effective_chunk))).await.is_err() {
                    break;
                }
            }

            if let Some(dec) = decoder {
                let tail_decoded = dec.flush_tail();
                if !tail_decoded.is_empty() {
                    let chunk_offset_ms = start.elapsed().as_millis() as u64;
                    total_bytes = total_bytes.saturating_add(tail_decoded.len());
                    if !sse_lifecycle.is_capture_suppressed() {
                        record_sse_chunk(
                            &sse_ctx,
                            session_id,
                            &tail_decoded,
                            &mut pending_parse_buf,
                            &mut total_parsed_events,
                            total_bytes,
                            chunk_offset_ms,
                            MAX_SSE_EVENTS,
                            &mut last_sse_emit,
                        );
                    }
                    let _ = chunk_tx.send(Ok(Frame::data(Bytes::from(tail_decoded)))).await;
                }
            }

            if !sse_lifecycle.is_capture_suppressed() {
                // Flush any trailing partial SSE block and finalize Base64/text/SQLite offload once
                let end_ms = start.elapsed().as_millis() as u64;
                let trailing_event =
                    if !pending_parse_buf.is_empty() && total_parsed_events < MAX_SSE_EVENTS {
                        parse_single_sse_block(&pending_parse_buf, total_parsed_events + 1, end_ms)
                    } else {
                        None
                    };
                let _ = sse_ctx.store.finalize_sse_stream(
                    session_id,
                    end_ms,
                    trailing_event,
                    MAX_SSE_EVENTS,
                );
                let done_instant = Instant::now();
                let done_at = timestamp_at_instant(start, start_utc, done_instant);
                let download_ms = duration_ms_f64(
                    done_instant.saturating_duration_since(got_response_headers_instant),
                );
                let overall_ms = duration_ms_f64(done_instant.saturating_duration_since(start));
                if let Some(updated_summary) =
                    sse_ctx.store.update_session_telemetry(session_id, |detail| {
                        let timings = detail.timings.get_or_insert_with(Default::default);
                        timings.server_done_response = Some(done_at.clone());
                        timings.client_done_response = Some(done_at);
                        timings.content_download_ms = Some(download_ms);
                        compute_timings_summary(timings, overall_ms);

                        let stats = detail.transfer_stats.get_or_insert_with(Default::default);
                        stats.response_body_bytes = Some(total_bytes);
                        stats.response_wire_body_bytes = Some(total_wire_bytes);

                        let t_clone = detail.timings.clone();
                        let s_clone = detail.transfer_stats.clone();
                        detail
                            .summary
                            .apply_telemetry(t_clone.as_ref(), s_clone.as_ref());
                    })
                {
                    let _ = sse_ctx.event_tx.send(updated_summary);
                }
            }
        });

        let stream = futures_util::stream::unfold(chunk_rx, |mut rx| async move {
            rx.recv().await.map(|frame| (frame, rx))
        });
        let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();
        let mut builder = append_filtered_response_headers(
            Response::builder().status(StatusCode::from_u16(final_status).unwrap_or(StatusCode::OK)),
            &resp_headers,
            strip_alt_svc,
            true,
            true,
        );
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
    let capture_text_preview = !is_media_or_partial
        && (ct_lower.starts_with("text/") || ct_lower.starts_with("application/"));

    if !is_head_request
        && !should_break_resp
        && !is_sse_stream
        && !resp_has_zstd
        && (is_media_or_partial || is_large_stream_body)
    {
        in_flight_guard.disarm();
        return build_and_spawn_raw_stream_response(RawBodyStreamParams {
            ctx,
            session_id,
            final_status,
            protocol_label,
            scheme_str,
            method_str,
            host_header,
            path_and_query,
            full_url,
            content_type,
            timestamp,
            start,
            start_utc,
            got_response_headers_at,
            got_response_headers_instant,
            client_addr,
            client_proc,
            client_conn,
            mtls_cn,
            req_headers,
            req_body_bytes: body_bytes,
            req_mutated,
            resp_mutated,
            bp_modified,
            is_mocked,
            matched_rule_id,
            remapped_to: upstream_target.remapped_to,
            base_timings,
            base_stats,
            resp_headers,
            capture_text_preview,
            prefix_chunks: Vec::new(),
            upstream_resp_body,
        });
    }

    // 4c. Standard Buffered Upstream Response (+ Seamless Stream Spill at >2 MiB for Chunked + Live Breakpoint After Response)
    let is_streaming_response = is_sse_stream
        || final_status == 206
        || ct_lower.starts_with("video/")
        || ct_lower.starts_with("audio/");
    let has_response_script = !is_streaming_response && ctx.script_runner.should_run_response();
    let has_override_status = matched_rule
        .as_ref()
        .is_some_and(|r| matches!(r.action, RuleActionType::OverrideStatus));
    let can_spill_to_stream = !is_head_request
        && !should_break_resp
        && !has_response_script
        && !has_override_status
        && resp_content_length.is_none();
    let spill_threshold = can_spill_to_stream.then_some(BODY_OFFLOAD_THRESHOLD_BYTES);

    let raw_resp_bytes = match collect_response_body_or_spill(
        upstream_resp_body,
        &ctx.throttle,
        MAX_BUFFERED_RESPONSE_BODY_BYTES,
        spill_threshold,
    )
    .await
    {
        Ok(ResponseBodyCollectOutcome::Complete(bytes)) => bytes,
        Ok(ResponseBodyCollectOutcome::Spilled {
            prefix, remaining, ..
        }) => {
            in_flight_guard.disarm();
            return build_and_spawn_raw_stream_response(RawBodyStreamParams {
                ctx,
                session_id,
                final_status,
                protocol_label,
                scheme_str,
                method_str,
                host_header,
                path_and_query,
                full_url,
                content_type,
                timestamp,
                start,
                start_utc,
                got_response_headers_at,
                got_response_headers_instant,
                client_addr,
                client_proc,
                client_conn,
                mtls_cn,
                req_headers,
                req_body_bytes: body_bytes,
                req_mutated,
                resp_mutated,
                bp_modified,
                is_mocked,
                matched_rule_id,
                remapped_to: upstream_target.remapped_to,
                base_timings,
                base_stats,
                resp_headers,
                capture_text_preview,
                prefix_chunks: prefix,
                upstream_resp_body: remaining,
            });
        }
        Err(err) => {
            let (err_status, bytes_read, err_msg) = match err {
                ResponseBodyReadError::PayloadTooLarge { limit, bytes_read } => (
                    StatusCode::BAD_GATEWAY,
                    bytes_read,
                    format!("Upstream response body exceeds maximum buffered limit ({limit} bytes)"),
                ),
                ResponseBodyReadError::Throttle {
                    message,
                    bytes_read,
                } => (StatusCode::SERVICE_UNAVAILABLE, bytes_read, message),
                ResponseBodyReadError::Transport {
                    message,
                    bytes_read,
                } => (
                    StatusCode::BAD_GATEWAY,
                    bytes_read,
                    format!("Failed reading upstream response body: {message}"),
                ),
            };
            in_flight_guard.disarm();
            if client_conn.is_capture_suppressed() {
                return plain_response(err_status, &err_msg);
            }
            let now = Instant::now();
            let now_at = timestamp_at_instant(start, start_utc, now);
            base_timings.server_done_response = Some(now_at.clone());
            base_timings.client_begin_response = Some(now_at.clone());
            base_timings.client_done_response = Some(now_at);
            base_timings.content_download_ms = Some(duration_ms_f64(
                now.saturating_duration_since(got_response_headers_instant),
            ));
            compute_timings_summary(
                &mut base_timings,
                duration_ms_f64(now.saturating_duration_since(start)),
            );
            base_stats.response_wire_body_bytes = Some(bytes_read);
            base_stats.response_body_bytes = Some(err_msg.len());
            return record_and_return_error_with_telemetry(
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
                Some(base_timings),
                Some(base_stats),
                err_msg,
            );
        }
    };

    let server_done_instant = Instant::now();
    let server_done_at = timestamp_at_instant(start, start_utc, server_done_instant);
    let content_download_ms = duration_ms_f64(
        server_done_instant.saturating_duration_since(got_response_headers_instant),
    );
    let response_wire_len = raw_resp_bytes.len();
    base_timings.server_done_response = Some(server_done_at);
    base_timings.content_download_ms = Some(content_download_ms);
    base_stats.response_wire_body_bytes = Some(response_wire_len);

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
    if has_response_script {
        let py_resp_start = Instant::now();
        let outcome = ctx
            .script_runner
            .run_on_response(
                session_id,
                &method_str,
                &full_url,
                final_status,
                &resp_headers,
                &resp_bytes,
            )
            .await;
        total_script_hook_ms += elapsed_ms(py_resp_start);
        if let ScriptResponseOutcome::Modified(edits) = outcome {
            let applied = apply_script_response_edits(
                &ctx,
                edits,
                &mut final_status,
                &mut resp_headers,
                &mut content_type,
                &mut resp_mutated,
            );
            if applied.touched_content_encoding && !resp_body_modified {
                remaining_content_encodings = extract_content_encoding_tokens(&resp_headers);
            }
            if let Some(next_body) = applied.new_body {
                resp_bytes = Bytes::from(next_body);
                remaining_content_encodings.clear();
                resp_body_modified = true;
            }
        }
    }

    // 4c. Live Breakpoint: After Response (Alt+F11 / `bpafter`)
    if should_break_resp {
        let mut resp_vec = resp_bytes.to_vec();
        let bp_resp_start = Instant::now();
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
                tls_version: format_mitm_tls_display(
                    &scheme_str,
                    client_conn.client_tls_version.as_deref(),
                    Some("Paused"),
                    mtls_cn.as_deref(),
                ),
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
        total_bp_pause_ms += elapsed_ms(bp_resp_start);
        if bp_outcome.aborted {
            let msg = "Aborted at Live Breakpoint (After Response)".to_string();
            in_flight_guard.disarm();
            if client_conn.is_capture_suppressed() {
                return plain_response(StatusCode::BAD_GATEWAY, &msg);
            }
            base_timings.breakpoint_pause_ms =
                (total_bp_pause_ms > 0.0).then(|| round_ms(total_bp_pause_ms));
            base_timings.script_hook_ms =
                (total_script_hook_ms > 0.0).then(|| round_ms(total_script_hook_ms));
            let now = Instant::now();
            let now_at = timestamp_at_instant(start, start_utc, now);
            base_timings.client_begin_response = Some(now_at.clone());
            base_timings.client_done_response = Some(now_at);
            compute_timings_summary(
                &mut base_timings,
                duration_ms_f64(now.saturating_duration_since(start)),
            );
            base_stats.response_body_bytes = Some(msg.len());
            return record_and_return_error_with_telemetry(
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
                Some(base_timings),
                Some(base_stats),
                msg,
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

    let client_begin_resp_instant = Instant::now();
    let client_begin_resp_at = timestamp_at_instant(start, start_utc, client_begin_resp_instant);
    let initial_overall_ms =
        duration_ms_f64(client_begin_resp_instant.saturating_duration_since(start));
    let duration_ms = initial_overall_ms.round() as u64;
    let sse_events = if content_type
        .to_ascii_lowercase()
        .starts_with("text/event-stream")
    {
        parse_sse_events_from_bytes(&resp_bytes, duration_ms)
    } else {
        Vec::new()
    };

    base_timings.breakpoint_pause_ms =
        (total_bp_pause_ms > 0.0).then(|| round_ms(total_bp_pause_ms));
    base_timings.script_hook_ms =
        (total_script_hook_ms > 0.0).then(|| round_ms(total_script_hook_ms));
    base_timings.client_begin_response = Some(client_begin_resp_at.clone());
    base_timings.client_done_response = Some(client_begin_resp_at);
    base_timings.client_send_ms = Some(0.0);
    compute_timings_summary(&mut base_timings, initial_overall_ms);
    base_stats.response_body_bytes = Some(resp_bytes.len());

    let mut summary = SessionSummary {
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
    summary.apply_telemetry(Some(&base_timings), Some(&base_stats));

    let capped_req = &body_bytes[..body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
    let capped_resp = &resp_bytes[..resp_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
    let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
    let (resp_b64, resp_txt, resp_offloaded) = encode_inline_or_offload(capped_resp);

    let detail = SessionDetail {
        summary,
        request_headers: req_headers,
        response_headers: resp_headers.clone(),
        request_body_base64: req_b64,
        response_body_base64: resp_b64,
        request_body_text: req_txt,
        response_body_text: resp_txt,
        tls_version: format_mitm_tls_display(
            &scheme_str,
            client_conn.client_tls_version.as_deref(),
            None,
            mtls_cn.as_deref(),
        ),
        client_addr: client_addr.to_string(),
        websocket_frames: Vec::new(),
        sse_events,
        body_offloaded: resp_offloaded,
        request_body_offloaded: req_offloaded,
        timings: Some(base_timings),
        transfer_stats: Some(base_stats),
    };

    in_flight_guard.disarm();
    if !client_conn.is_capture_suppressed() {
        record_completed_session(&ctx, detail, Some(capped_req), Some(capped_resp));
    }

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
        let trimmed = h.name.trim();
        // `maybe_decompress_content_encodings` peels supported encodings (`zstd`, `br`, `gzip`, `deflate`).
        // Re-emit only encodings that were not decoded, and preserve upstream `Content-Length` for
        // empty `HEAD` responses (and unmodified undecoded responses).
        // Also strip HTTP/3 QUIC discovery headers (`alt-svc`, `alternate-protocol`) when enabled.
        let keep_cl = trimmed.eq_ignore_ascii_case("content-length")
            && (preserve_head_content_length
                || (preserve_original_content_length
                    && h.value.trim().parse::<usize>().ok() == Some(resp_bytes.len())));
        if should_forward_response_header(trimmed, strip_alt_svc, true, !keep_cl) {
            if let (Ok(hn), Ok(hv)) = (
                http::HeaderName::from_bytes(trimmed.as_bytes()),
                h.to_hyper_header_value(),
            ) {
                builder = builder.header(hn, hv);
            }
        }
    }
    if !remaining_content_encodings.is_empty() {
        builder = builder.header("Content-Encoding", remaining_content_encodings.join(", "));
    }

    let ctx_for_send = Arc::clone(&ctx);
    let send_lifecycle = client_conn.lifecycle.clone();
    let tracked_body = TrackedResponseBody::new(boxed_full(resp_bytes), move |_bytes_sent, done_instant| {
        if send_lifecycle.is_capture_suppressed() {
            return;
        }
        let done_at = timestamp_at_instant(start, start_utc, done_instant);
        let client_send_ms = duration_ms_f64(
            done_instant.saturating_duration_since(client_begin_resp_instant),
        );
        let overall_ms = duration_ms_f64(done_instant.saturating_duration_since(start));
        if let Some((updated_summary, duration_changed)) =
            ctx_for_send.store.update_client_send_timing(
                session_id,
                done_at,
                client_send_ms,
                overall_ms,
            )
        {
            if duration_changed {
                let _ = ctx_for_send.event_tx.send(updated_summary);
            }
        }
    });

    builder
        .body(http_body_util::BodyExt::boxed(tracked_body))
        .unwrap_or_else(|_| plain_response(StatusCode::BAD_GATEWAY, "Failed building proxy response"))
}

struct RawBodyStreamParams {
    ctx: Arc<SharedProxyContext>,
    session_id: u64,
    final_status: u16,
    protocol_label: String,
    scheme_str: String,
    method_str: String,
    host_header: String,
    path_and_query: String,
    full_url: String,
    content_type: String,
    timestamp: String,
    start: Instant,
    start_utc: DateTime<Utc>,
    got_response_headers_at: String,
    got_response_headers_instant: Instant,
    client_addr: SocketAddr,
    client_proc: Option<ClientProcessInfo>,
    client_conn: ClientConnContext,
    mtls_cn: Option<String>,
    req_headers: Vec<HeaderPair>,
    req_body_bytes: Bytes,
    req_mutated: bool,
    resp_mutated: bool,
    bp_modified: bool,
    is_mocked: bool,
    matched_rule_id: Option<String>,
    remapped_to: Option<String>,
    base_timings: SessionTimings,
    base_stats: SessionTransferStats,
    resp_headers: Vec<HeaderPair>,
    capture_text_preview: bool,
    prefix_chunks: Vec<Bytes>,
    upstream_resp_body: Incoming,
}

fn build_and_spawn_raw_stream_response(params: RawBodyStreamParams) -> Response<ProxyBoxBody> {
    let RawBodyStreamParams {
        ctx,
        session_id,
        final_status,
        protocol_label,
        scheme_str,
        method_str,
        host_header,
        path_and_query,
        full_url,
        content_type,
        timestamp,
        start,
        start_utc,
        got_response_headers_at,
        got_response_headers_instant,
        client_addr,
        client_proc,
        client_conn,
        mtls_cn,
        req_headers,
        req_body_bytes,
        req_mutated,
        resp_mutated,
        bp_modified,
        is_mocked,
        matched_rule_id,
        remapped_to,
        mut base_timings,
        mut base_stats,
        resp_headers,
        capture_text_preview,
        prefix_chunks,
        mut upstream_resp_body,
    } = params;

    base_stats.is_streaming = Some(true);
    base_stats.response_body_bytes = Some(0);
    base_stats.response_wire_body_bytes = Some(0);
    base_timings.client_begin_response = Some(got_response_headers_at);
    compute_timings_summary(&mut base_timings, elapsed_ms(start));

    let capped_req = &req_body_bytes[..req_body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
    let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
    let mut initial_summary = SessionSummary {
        id: session_id,
        status: final_status,
        protocol: protocol_label,
        scheme: scheme_str.clone(),
        method: method_str,
        host: host_header.clone(),
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
    initial_summary.apply_telemetry(Some(&base_timings), Some(&base_stats));

    let initial_detail = SessionDetail {
        summary: initial_summary,
        request_headers: req_headers,
        response_headers: resp_headers.clone(),
        request_body_base64: req_b64,
        response_body_base64: String::new(),
        request_body_text: req_txt,
        response_body_text: None,
        tls_version: format_mitm_tls_display(
            &scheme_str,
            client_conn.client_tls_version.as_deref(),
            Some("Stream"),
            mtls_cn.as_deref(),
        ),
        client_addr: client_addr.to_string(),
        websocket_frames: Vec::new(),
        sse_events: Vec::new(),
        body_offloaded: false,
        request_body_offloaded: req_offloaded,
        timings: Some(base_timings),
        transfer_stats: Some(base_stats),
    };

    let initial_recorded = if !client_conn.is_capture_suppressed() {
        record_completed_session(&ctx, initial_detail.clone(), Some(capped_req), None)
    } else {
        false
    };
    let req_body_for_deferred_end = if initial_recorded {
        None
    } else {
        Some(req_body_bytes.slice(..req_body_bytes.len().min(MAX_CAPTURED_BODY_BYTES)))
    };

    let stream_content_encodings = extract_content_encoding_tokens(&resp_headers);
    let stream_lifecycle = client_conn.lifecycle.clone();
    let (stream_host, stream_opt_port) = parse_host_and_optional_port(&host_header);
    let stream_port = stream_opt_port.unwrap_or_else(|| default_port_for_scheme(&scheme_str));
    let stream_is_https = scheme_str.eq_ignore_ascii_case("https");
    let (chunk_tx, chunk_rx) = mpsc::channel::<Result<Frame<Bytes>, Infallible>>(32);
    let stream_ctx = ctx.clone();

    tokio::spawn(async move {
        let mut total_bytes: usize = 0;
        let mut preview_accum: Vec<u8> = Vec::new();
        let mut stream_error: Option<String> = None;
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let mut download_pacer = BandwidthPacer::new();
        let mut abort_sig = stream_lifecycle.clone();
        let mut drain_expire_sig = stream_lifecycle.clone();
        let mut config_rx = stream_ctx.filters.subscribe_config_updates();
        let mut config_closed = false;
        let mut aborted_early = false;

        for chunk in prefix_chunks {
            if abort_sig.is_aborted() {
                aborted_early = true;
                break;
            }
            total_bytes = total_bytes.saturating_add(chunk.len());
            if capture_text_preview && preview_accum.len() < STREAM_TEXT_PREVIEW_MAX_BYTES {
                let room = STREAM_TEXT_PREVIEW_MAX_BYTES - preview_accum.len();
                preview_accum.extend_from_slice(&chunk[..chunk.len().min(room)]);
            }
            tokio::select! {
                biased;
                _ = abort_sig.wait_abort() => {
                    aborted_early = true;
                    break;
                }
                _ = drain_expire_sig.wait_drain_expired() => {
                    aborted_early = true;
                    break;
                }
                res = chunk_tx.send(Ok(Frame::data(chunk))) => {
                    if res.is_err() {
                        aborted_early = true;
                        break;
                    }
                }
            }
        }

        if !aborted_early {
            loop {
                let next_frame = tokio::select! {
                    biased;
                    _ = abort_sig.wait_abort() => break,
                    _ = drain_expire_sig.wait_drain_expired() => break,
                    changed = config_rx.changed(), if !config_closed => {
                        if changed.is_err() {
                            config_closed = true;
                            continue;
                        }
                        if !stream_ctx.filters.is_lan_client_allowed(client_addr.ip())
                            || (stream_is_https
                                && matches!(
                                    stream_ctx.filters.evaluate_connect_tunnel(&stream_host, stream_port),
                                    ConnectTunnelDecision::Passthrough(_)
                                ))
                        {
                            break;
                        }
                        continue;
                    }
                    res = upstream_resp_body.frame() => res,
                };
                match next_frame {
                    Some(Ok(frame)) => {
                        let Some(chunk) = frame.into_data().ok().filter(|c| !c.is_empty()) else {
                            continue;
                        };
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

                        if !stream_lifecycle.is_capture_suppressed()
                            && last_emit.elapsed() >= Duration::from_millis(150)
                        {
                            last_emit = Instant::now();
                            let cur_elapsed = start.elapsed().as_millis() as u64;
                            if let Some(updated_summary) =
                                stream_ctx.store.update_streaming_progress(
                                    session_id,
                                    total_bytes,
                                    cur_elapsed,
                                )
                            {
                                let _ = stream_ctx.event_tx.send(updated_summary);
                            }
                        }
                    }
                    None => break,
                    Some(Err(err)) => {
                        let chain = format_error_chain(&err);
                        tracing::warn!(
                            "Upstream stream chunk error for session #{session_id} after {total_bytes} bytes: {chain}"
                        );
                        stream_error = Some(format!("Upstream response stream error: {chain}"));
                        break;
                    }
                }
            }
        }

        drop(chunk_tx);

        if stream_lifecycle.is_capture_suppressed() {
            return;
        }

        let done_instant = Instant::now();
        let done_at = timestamp_at_instant(start, start_utc, done_instant);
        let final_duration_ms = start.elapsed().as_millis() as u64;
        let download_ms = duration_ms_f64(
            done_instant.saturating_duration_since(got_response_headers_instant),
        );
        let overall_ms = duration_ms_f64(done_instant.saturating_duration_since(start));

        let mut final_detail = stream_ctx.store.get(session_id).unwrap_or(initial_detail);
        final_detail.summary.body_size = total_bytes;
        final_detail.summary.duration_ms = final_duration_ms;
        if let Some(ref err_msg) = stream_error {
            final_detail.summary.error = Some(err_msg.clone());
        }
        if capture_text_preview && !preview_accum.is_empty() {
            let preview_bytes = decode_stream_preview_best_effort(
                &stream_content_encodings,
                &preview_accum,
                STREAM_TEXT_PREVIEW_MAX_BYTES,
            );
            final_detail.response_body_base64 =
                base64::engine::general_purpose::STANDARD.encode(&preview_bytes);
            final_detail.response_body_text = utf8_prefix_lossless(&preview_bytes);
        } else {
            final_detail.response_body_base64.clear();
            final_detail.response_body_text = None;
        }
        {
            let timings = final_detail.timings.get_or_insert_with(Default::default);
            timings.server_done_response = Some(done_at.clone());
            timings.client_done_response = Some(done_at);
            timings.content_download_ms = Some(download_ms);
            compute_timings_summary(timings, overall_ms);

            let stats = final_detail
                .transfer_stats
                .get_or_insert_with(Default::default);
            stats.response_body_bytes = Some(total_bytes);
            stats.response_wire_body_bytes = Some(total_bytes);

            let t_clone = final_detail.timings.clone();
            let s_clone = final_detail.transfer_stats.clone();
            final_detail
                .summary
                .apply_telemetry(t_clone.as_ref(), s_clone.as_ref());
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
    let builder = append_filtered_response_headers(
        Response::builder().status(StatusCode::from_u16(final_status).unwrap_or(StatusCode::OK)),
        &resp_headers,
        strip_alt_svc,
        false,
        false,
    );
    builder
        .body(http_body_util::BodyExt::boxed(StreamBody::new(stream)))
        .unwrap_or_else(|_| {
            plain_response(StatusCode::BAD_GATEWAY, "Failed building streamed response")
        })
}

#[allow(clippy::too_many_arguments)]
const SSE_IPC_THROTTLE_MS: u64 = 75;

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
    last_emit: &mut Option<Instant>,
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
        let should_emit = last_emit
            .map_or(true, |prev| prev.elapsed() >= Duration::from_millis(SSE_IPC_THROTTLE_MS));
        if should_emit {
            *last_emit = Some(Instant::now());
            let _ = sse_ctx.event_tx.send(updated_summary);
        }
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


