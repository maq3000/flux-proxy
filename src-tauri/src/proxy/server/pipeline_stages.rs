use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use http::header::CONTENT_TYPE;
use http::{Response, StatusCode, Version};
use http_body_util::{BodyExt, Full};

use crate::models::{
    AutoResponderRule, BreakpointAction, BreakpointStage, HeaderMutationDirection, HeaderPair,
    PausedBreakpointItem, RuleActionType, SessionDetail, SessionSummary, SessionTimings,
    SessionTransferStats,
};
use crate::proxy::breakpoints::PendingBreakpointGuard;
use crate::proxy::filters::is_alt_svc_header;
use crate::proxy::hosts::HostRemapRegistry;
use crate::proxy::network::normalize_client_ip;
use crate::proxy::process::ClientProcessInfo;
use crate::proxy::upstream_client::{
    duration_ms_f64, estimate_response_headers_bytes, format_rfc3339_micros, round_ms,
    timestamp_at_instant, ClaimedConnMetrics, UpstreamConnMeta,
};
use crate::scripting::{
    apply_header_diff, ScriptMockResponse, ScriptRequestEdits, ScriptResponseEdits,
};
use crate::storage::BODY_OFFLOAD_THRESHOLD_BYTES;

use super::{
    parse_sse_events_from_bytes, ClientConnContext, ProxyBoxBody, SharedProxyContext,
    FLUXPROXY_ERROR_HEADER, MAX_CAPTURED_BODY_BYTES,
};

#[inline]
pub(super) fn evaluate_should_store_session(
    ctx: &SharedProxyContext,
    summary: &SessionSummary,
) -> bool {
    ctx.filters.evaluate_should_store_session(summary)
}

pub(super) fn encode_inline_or_offload(raw: &[u8]) -> (String, Option<String>, bool) {
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

pub(super) fn record_completed_session(
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

pub(super) fn make_breakpoint_guard(
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

#[allow(clippy::too_many_arguments)]
pub(super) fn record_and_return_error(
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

pub(super) fn boxed_full(bytes: Bytes) -> ProxyBoxBody {
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

pub(super) fn split_authority(authority: &str) -> (String, u16) {
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

pub(super) fn extract_hyper_headers(map: &http::HeaderMap) -> Vec<HeaderPair> {
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

pub(super) fn format_raw_http_version(version: Version) -> &'static str {
    match version {
        Version::HTTP_09 => "HTTP/0.9",
        Version::HTTP_10 => "HTTP/1.0",
        Version::HTTP_11 => "HTTP/1.1",
        Version::HTTP_2 => "HTTP/2.0",
        Version::HTTP_3 => "HTTP/3.0",
        _ => "HTTP/1.1",
    }
}

pub(super) fn format_mitm_tls_display(
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

pub(super) fn resolve_protocol_label(scheme: &str, alpn: Option<&str>, version: Version) -> String {
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

pub(super) fn format_http_version(scheme: &str, version: http::Version) -> String {
    match (scheme, version) {
        ("https", Version::HTTP_2) => "HTTPS/2".into(),
        ("https", _) => "HTTPS/1.1".into(),
        (_, Version::HTTP_2) => "HTTP/2".into(),
        _ => "HTTP/1.1".into(),
    }
}

pub(super) fn is_hop_by_hop_header(name: &str) -> bool {
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

pub(super) struct PreparedUpstreamTarget {
    pub upstream_url: String,
    pub host_header_override: Option<String>,
    pub remapped_to: Option<String>,
}

pub(super) fn default_port_for_scheme(scheme: &str) -> u16 {
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
    let Ok(parsed) = url::Url::parse(full_url) else {
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
    let formatted_target = HostRemapRegistry::format_host_for_authority(&rule.target_host);

    // Keep original host & port in URL so InstrumentedConnector::call handles physical socket
    // remapping for both domain names and IP sources while preserving TLS SNI and `remapped_target`.
    let host_header_override = if rule.preserve_host_header {
        let url_auth_host = HostRemapRegistry::format_host_for_authority(&url_host_raw);
        let url_authority = match url_port {
            Some(p) => format!("{url_auth_host}:{p}"),
            None => url_auth_host,
        };
        let trimmed_host_hdr = host_header.trim();
        if !trimmed_host_hdr.is_empty() && !trimmed_host_hdr.eq_ignore_ascii_case(&url_authority) {
            Some(trimmed_host_hdr.to_string())
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
        upstream_url: full_url.to_string(),
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

pub(crate) fn compute_timings_summary(timings: &mut SessionTimings, overall_ms: f64) {
    let rounded_overall = round_ms(overall_ms);
    timings.overall_elapsed_ms = Some(rounded_overall);
    let pause_sum = timings.breakpoint_pause_ms.unwrap_or(0.0)
        + timings.script_hook_ms.unwrap_or(0.0)
        + timings.autoresponder_delay_ms.unwrap_or(0.0);
    let net_elapsed = (rounded_overall - pause_sum).max(0.0);
    timings.net_elapsed_ms = Some(round_ms(net_elapsed));
    let tracked_net = timings.client_read_ms.unwrap_or(0.0)
        + timings.dns_ms.unwrap_or(0.0)
        + timings.tcp_connect_ms.unwrap_or(0.0)
        + timings.tls_handshake_ms.unwrap_or(0.0)
        + timings.send_request_ms.unwrap_or(0.0)
        + timings.server_wait_ms.unwrap_or(0.0)
        + timings.content_download_ms.unwrap_or(0.0)
        + timings.client_send_ms.unwrap_or(0.0);
    let overhead = (net_elapsed - tracked_net).max(0.0);
    timings.proxy_overhead_ms = Some(round_ms(overhead));
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_error_timings_and_stats(
    start: Instant,
    start_utc: DateTime<Utc>,
    client_conn: &ClientConnContext,
    client_reused: bool,
    client_tls_ms: Option<f64>,
    client_read_ms: f64,
    client_http_ver: &str,
    req_headers_bytes: usize,
    req_body_len: usize,
    resp_len: usize,
    bp_pause_ms: f64,
    script_hook_ms: f64,
    remapped_target: Option<String>,
) -> (SessionTimings, SessionTransferStats) {
    let now = Instant::now();
    let now_at = timestamp_at_instant(start, start_utc, now);
    let req_at = format_rfc3339_micros(start_utc);
    let mut timings = SessionTimings {
        client_connected: Some(client_conn.connected_at.clone()),
        client_begin_request: Some(req_at.clone()),
        got_request_headers: Some(req_at.clone()),
        client_done_request: Some(req_at),
        client_begin_response: Some(now_at.clone()),
        client_done_response: Some(now_at),
        client_read_ms: Some(round_ms(client_read_ms)),
        client_tls_handshake_ms: client_tls_ms,
        breakpoint_pause_ms: (bp_pause_ms > 0.0).then(|| round_ms(bp_pause_ms)),
        script_hook_ms: (script_hook_ms > 0.0).then(|| round_ms(script_hook_ms)),
        ..Default::default()
    };
    compute_timings_summary(&mut timings, duration_ms_f64(now.saturating_duration_since(start)));
    let stats = SessionTransferStats {
        request_headers_bytes: Some(req_headers_bytes),
        request_body_bytes: Some(req_body_len),
        request_wire_body_bytes: Some(req_body_len),
        response_body_bytes: Some(resp_len),
        response_wire_body_bytes: Some(resp_len),
        client_conn_id: Some(client_conn.conn_id),
        client_conn_reused: Some(client_reused),
        client_http_version: Some(client_http_ver.to_string()),
        client_tls_version: client_conn.client_tls_version.clone(),
        client_tls_cipher: client_conn.client_tls_cipher.clone(),
        client_alpn: client_conn.client_alpn.clone(),
        remapped_target,
        ..Default::default()
    };
    (timings, stats)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn record_and_return_error_with_telemetry(
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
    timings: Option<SessionTimings>,
    transfer_stats: Option<SessionTransferStats>,
    err_msg: String,
) -> Response<ProxyBoxBody> {
    record_and_return_error_with_telemetry_and_code(
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
        timings,
        transfer_stats,
        err_msg,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn record_and_return_error_with_telemetry_and_code(
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
    timings: Option<SessionTimings>,
    transfer_stats: Option<SessionTransferStats>,
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
        timings,
        transfer_stats,
        &err_msg,
        proxy_error_code,
    );
    plain_response_with_proxy_error(status_code, &err_msg, proxy_error_code)
}

#[inline]
pub(super) fn apply_request_header_mutations(
    ctx: &SharedProxyContext,
    full_url: &str,
    headers: &mut Vec<HeaderPair>,
) -> bool {
    ctx.filters
        .apply_header_mutations(HeaderMutationDirection::Request, full_url, headers)
}

#[inline]
pub(super) fn apply_response_header_mutations(
    ctx: &SharedProxyContext,
    full_url: &str,
    headers: &mut Vec<HeaderPair>,
) -> bool {
    ctx.filters
        .apply_header_mutations(HeaderMutationDirection::Response, full_url, headers)
}

pub(super) fn filter_outbound_request_headers(
    req_headers: &[HeaderPair],
    strip_host: bool,
) -> Vec<HeaderPair> {
    req_headers
        .iter()
        .filter(|h| {
            let trimmed = h.name.trim();
            !trimmed.is_empty()
                && !is_hop_by_hop_header(trimmed)
                && !trimmed.eq_ignore_ascii_case("content-length")
                && !(strip_host && trimmed.eq_ignore_ascii_case("host"))
        })
        .cloned()
        .collect()
}

#[inline]
pub(super) fn should_forward_response_header(
    trimmed_name: &str,
    strip_alt_svc: bool,
    strip_content_encoding: bool,
    strip_content_length: bool,
) -> bool {
    !trimmed_name.is_empty()
        && !is_hop_by_hop_header(trimmed_name)
        && !(strip_content_encoding && trimmed_name.eq_ignore_ascii_case("content-encoding"))
        && !(strip_content_length && trimmed_name.eq_ignore_ascii_case("content-length"))
        && !(strip_alt_svc && is_alt_svc_header(trimmed_name))
}

pub(super) fn append_filtered_response_headers(
    mut builder: http::response::Builder,
    headers: &[HeaderPair],
    strip_alt_svc: bool,
    strip_content_encoding: bool,
    strip_content_length: bool,
) -> http::response::Builder {
    for h in headers {
        let trimmed = h.name.trim();
        if should_forward_response_header(
            trimmed,
            strip_alt_svc,
            strip_content_encoding,
            strip_content_length,
        ) {
            if let (Ok(hn), Ok(hv)) = (
                http::HeaderName::from_bytes(trimmed.as_bytes()),
                h.to_hyper_header_value(),
            ) {
                builder = builder.header(hn, hv);
            }
        }
    }
    builder
}

#[inline]
pub(super) fn apply_autoresponder_status_override(
    matched_rule: Option<&AutoResponderRule>,
    status: &mut u16,
    is_mocked: &mut bool,
    matched_rule_id: &mut Option<String>,
) {
    if let Some(rule) = matched_rule {
        *matched_rule_id = Some(rule.id.clone());
        if matches!(rule.action, RuleActionType::OverrideStatus) {
            *status = rule.status_code;
            *is_mocked = true;
        }
    }
}

pub(super) struct UpstreamTransferStatsInput<'a> {
    pub req_headers_bytes: usize,
    pub req_body_len: usize,
    pub resp_headers_bytes: usize,
    pub resp_body_len: Option<usize>,
    pub resp_wire_body_len: Option<usize>,
    pub raw_response_content_encoding: Option<String>,
    pub client_conn_id: Option<u64>,
    pub client_reused: bool,
    pub client_http_ver: String,
    pub client_tls_version: Option<String>,
    pub client_tls_cipher: Option<String>,
    pub client_alpn: Option<String>,
    pub server_http_ver: String,
    pub conn_meta: Option<&'a UpstreamConnMeta>,
    pub claimed: Option<&'a ClaimedConnMetrics>,
    pub mtls_cn: Option<String>,
    pub request_remapped_to: Option<String>,
}

pub(super) fn build_upstream_transfer_stats(
    input: UpstreamTransferStatsInput<'_>,
) -> SessionTransferStats {
    let is_proxied = input
        .conn_meta
        .is_some_and(|m| m.via_proxy_addr.is_some());
    SessionTransferStats {
        request_headers_bytes: Some(input.req_headers_bytes),
        request_body_bytes: Some(input.req_body_len),
        request_wire_body_bytes: Some(input.req_body_len),
        response_headers_bytes: Some(input.resp_headers_bytes),
        response_body_bytes: input.resp_body_len,
        response_wire_body_bytes: input.resp_wire_body_len,
        response_content_encoding: input.raw_response_content_encoding,
        client_conn_id: input.client_conn_id,
        client_conn_reused: Some(input.client_reused),
        client_http_version: Some(input.client_http_ver),
        client_tls_version: input.client_tls_version,
        client_tls_cipher: input.client_tls_cipher,
        client_alpn: input.client_alpn,
        server_addr: if is_proxied {
            None
        } else {
            input.conn_meta.map(|m| m.server_addr.to_string())
        },
        server_ip: input.conn_meta.map(|m| m.server_ip.clone()),
        server_port: if is_proxied {
            None
        } else {
            input.conn_meta.map(|m| m.server_port)
        },
        server_conn_id: input.conn_meta.map(|m| m.conn_id),
        server_conn_reused: input.claimed.map(|c| c.reused),
        server_http_version: Some(input.server_http_ver),
        server_tls_version: input.conn_meta.and_then(|m| m.tls_version.clone()),
        server_tls_cipher: input.conn_meta.and_then(|m| m.tls_cipher.clone()),
        server_tls_alpn: input.conn_meta.and_then(|m| m.tls_alpn.clone()),
        server_cert_subject: input.conn_meta.and_then(|m| m.cert_subject.clone()),
        server_cert_issuer: input.conn_meta.and_then(|m| m.cert_issuer.clone()),
        server_mtls_cn: input.mtls_cn,
        remapped_target: input
            .request_remapped_to
            .or_else(|| input.conn_meta.and_then(|m| m.remapped_target.clone())),
        via_proxy_addr: input.conn_meta.and_then(|m| m.via_proxy_addr.clone()),
        is_streaming: None,
    }
}

pub(super) struct ScriptResponseApplyOutcome {
    pub touched_content_encoding: bool,
    pub new_body: Option<Vec<u8>>,
}

pub(super) fn apply_script_response_edits(
    ctx: &SharedProxyContext,
    edits: ScriptResponseEdits,
    status: &mut u16,
    resp_headers: &mut Vec<HeaderPair>,
    content_type: &mut String,
    resp_mutated: &mut bool,
) -> ScriptResponseApplyOutcome {
    if let Some(next_status) = edits.status {
        if (100..=599).contains(&next_status) && next_status != *status {
            *status = next_status;
            *resp_mutated = true;
        }
    }
    let touched_content_encoding = edits
        .headers_removed
        .iter()
        .chain(edits.headers_set.iter().map(|(k, _)| k))
        .any(|k| k.trim().eq_ignore_ascii_case("content-encoding"));
    if edits.headers_changed
        && apply_header_diff(resp_headers, &edits.headers_removed, &edits.headers_set)
    {
        let _ = ctx.filters.strip_alt_svc_headers(resp_headers);
        if let Some(ct_hdr) = resp_headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("content-type"))
        {
            *content_type = ct_hdr.value.clone();
        }
        *resp_mutated = true;
    }
    if edits.body.is_some() {
        *resp_mutated = true;
    }
    ScriptResponseApplyOutcome {
        touched_content_encoding,
        new_body: edits.body,
    }
}

pub(super) struct MockTimingStatsInput<'a> {
    pub start: Instant,
    pub start_utc: DateTime<Utc>,
    pub client_connected_at: Option<&'a str>,
    pub req_begin_at: &'a str,
    pub client_done_request_at: &'a str,
    pub client_read_ms: f64,
    pub client_tls_ms: Option<f64>,
    pub total_bp_pause_ms: f64,
    pub total_script_hook_ms: f64,
    pub autoresponder_delay_ms: Option<f64>,
    pub client_http_ver: &'a str,
    pub status: u16,
    pub req_headers_bytes: usize,
    pub req_body_len: usize,
    pub resp_headers: &'a [HeaderPair],
    pub resp_body_len: usize,
    pub client_conn_id: Option<u64>,
    pub client_reused: bool,
    pub client_tls_version: Option<&'a str>,
    pub client_tls_cipher: Option<&'a str>,
    pub client_alpn: Option<&'a str>,
}

pub(super) fn apply_mock_session_telemetry(
    detail: &mut SessionDetail,
    input: MockTimingStatsInput<'_>,
) {
    let now_instant = Instant::now();
    let resp_at = timestamp_at_instant(input.start, input.start_utc, now_instant);
    let overall_ms = duration_ms_f64(now_instant.saturating_duration_since(input.start));
    let mut mock_timings = SessionTimings {
        client_connected: input.client_connected_at.map(str::to_owned),
        client_begin_request: Some(input.req_begin_at.to_owned()),
        got_request_headers: Some(input.req_begin_at.to_owned()),
        client_done_request: Some(input.client_done_request_at.to_owned()),
        client_begin_response: Some(resp_at.clone()),
        client_done_response: Some(resp_at),
        client_read_ms: Some(input.client_read_ms),
        client_tls_handshake_ms: input.client_tls_ms,
        breakpoint_pause_ms: (input.total_bp_pause_ms > 0.0)
            .then(|| round_ms(input.total_bp_pause_ms)),
        script_hook_ms: (input.total_script_hook_ms > 0.0)
            .then(|| round_ms(input.total_script_hook_ms)),
        autoresponder_delay_ms: input
            .autoresponder_delay_ms
            .filter(|&d| d > 0.0)
            .map(round_ms),
        ..Default::default()
    };
    compute_timings_summary(&mut mock_timings, overall_ms);
    let mock_stats = SessionTransferStats {
        request_headers_bytes: Some(input.req_headers_bytes),
        request_body_bytes: Some(input.req_body_len),
        request_wire_body_bytes: Some(input.req_body_len),
        response_headers_bytes: Some(estimate_response_headers_bytes(
            input.status,
            input.client_http_ver,
            input.resp_headers,
        )),
        response_body_bytes: Some(input.resp_body_len),
        response_wire_body_bytes: Some(input.resp_body_len),
        client_conn_id: input.client_conn_id,
        client_conn_reused: Some(input.client_reused),
        client_http_version: Some(input.client_http_ver.to_owned()),
        client_tls_version: input.client_tls_version.map(str::to_owned),
        client_tls_cipher: input.client_tls_cipher.map(str::to_owned),
        client_alpn: input.client_alpn.map(str::to_owned),
        ..Default::default()
    };
    detail
        .summary
        .apply_telemetry(Some(&mock_timings), Some(&mock_stats));
    detail.timings = Some(mock_timings);
    detail.transfer_stats = Some(mock_stats);
}

pub(super) struct PythonMockSessionInput<'a> {
    pub session_id: u64,
    pub mock: ScriptMockResponse,
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

pub(super) fn build_python_mock_detail(
    ctx: &SharedProxyContext,
    input: PythonMockSessionInput<'_>,
) -> (SessionDetail, Vec<HeaderPair>, Bytes) {
    let mock_status = input.mock.status;
    let mock_bytes = Bytes::from(input.mock.body);
    let mut mock_resp_headers = input.mock.headers;
    let resp_mutated =
        apply_response_header_mutations(ctx, &input.full_url, &mut mock_resp_headers);
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
        status: mock_status,
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
        matched_rule_id: Some("python-script".to_string()),
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
        timings: None,
        transfer_stats: None,
    };

    (detail, mock_resp_headers, mock_bytes)
}

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
    let Ok(parsed) = url::Url::parse(trimmed_u) else {
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
    req_headers.insert(0, HeaderPair::new("Host", host_header.clone()));
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
    let (store_req_b64, store_req_txt, _) = encode_inline_or_offload(capped_req);

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
    ctx.store.insert_with_bodies(
        SessionDetail {
            summary: paused_summary.clone(),
            request_headers: req_headers.clone(),
            response_headers: Vec::new(),
            request_body_base64: store_req_b64,
            response_body_base64: String::new(),
            request_body_text: store_req_txt,
            response_body_text: None,
            tls_version: input.tls_version,
            client_addr: input.client_addr,
            websocket_frames: Vec::new(),
            sse_events: Vec::new(),
            body_offloaded: false,
            request_body_offloaded: false,
            timings: None,
            transfer_stats: None,
        },
        Some(capped_req),
        None,
    );
    let _ = ctx.event_tx.send(paused_summary);

    let (bp_rx, timeout_secs) = ctx.breakpoints.park_with_bodies(
        PausedBreakpointItem {
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
            request_body_base64: String::new(),
            request_body_text: None,
            request_body_offloaded: false,
            request_body_size: capped_req.len(),
            response_status: None,
            response_headers: Vec::new(),
            response_body_base64: String::new(),
            response_body_text: None,
            response_body_offloaded: false,
            response_body_size: 0,
            body_offloaded: false,
            body_size: capped_req.len(),
            process_name: input.process_name,
            process_pid: input.process_pid,
        },
        Some(capped_req),
        None,
    );
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

    if input.insert_paused_summary {
        let (store_req_b64, store_req_txt, _) = encode_inline_or_offload(capped_req);
        let (store_resp_b64, store_resp_txt, _) = encode_inline_or_offload(capped_resp);
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
        ctx.store.insert_with_bodies(
            SessionDetail {
                summary: paused_summary.clone(),
                request_headers: input.req_headers.clone(),
                response_headers: resp_headers.clone(),
                request_body_base64: store_req_b64,
                response_body_base64: store_resp_b64,
                request_body_text: store_req_txt,
                response_body_text: store_resp_txt,
                tls_version: input.tls_version,
                client_addr: input.client_addr,
                websocket_frames: Vec::new(),
                sse_events: Vec::new(),
                body_offloaded: false,
                request_body_offloaded: false,
                timings: None,
                transfer_stats: None,
            },
            Some(capped_req),
            Some(capped_resp),
        );
        let _ = ctx.event_tx.send(paused_summary);
    }

    let (bp_rx, timeout_secs) = ctx.breakpoints.park_with_bodies(
        PausedBreakpointItem {
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
            request_body_base64: String::new(),
            request_body_text: None,
            request_body_offloaded: false,
            request_body_size: capped_req.len(),
            response_status: Some(*status),
            response_headers: resp_headers.clone(),
            response_body_base64: String::new(),
            response_body_text: None,
            response_body_offloaded: false,
            response_body_size: capped_resp.len(),
            body_offloaded: false,
            body_size: capped_resp.len(),
            process_name: input.process_name,
            process_pid: input.process_pid,
        },
        Some(capped_req),
        Some(capped_resp),
    );
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
    let strip_alt_svc = ctx.filters.is_strip_alt_svc_enabled();
    let is_allowed_mock_header = |name: &str| {
        should_forward_response_header(name.trim(), strip_alt_svc, true, true)
    };
    let mut mock_resp_headers: Vec<HeaderPair> = input
        .rule
        .response_headers
        .iter()
        .filter(|h| is_allowed_mock_header(&h.name))
        .cloned()
        .collect();
    let resp_mutated = apply_response_header_mutations(ctx, &input.full_url, &mut mock_resp_headers);
    mock_resp_headers.retain(|h| is_allowed_mock_header(&h.name));
    mock_resp_headers.push(HeaderPair::new(
        "Content-Length",
        mock_bytes.len().to_string(),
    ));
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
        timings: None,
        transfer_stats: None,
    };

    (detail, mock_resp_headers, mock_bytes)
}
