use std::sync::OnceLock;

use base64::Engine as _;
use regex::Regex;

use crate::models::{HeaderPair, SanitizationOptions, SessionDetail, SseEventRecord};

use super::har::url_decode_component;
use super::raw::{decode_detail_body_bytes, find_header_value};

pub(super) const BUILTIN_REDACTED_AUTH_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
];

pub(super) fn normalize_sensitive_key(raw: &str) -> String {
    raw.trim()
        .chars()
        .filter(|&c| c != '_' && c != '-')
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

pub(super) fn normalize_sanitization_tokens(items: &[String]) -> Vec<String> {
    items
        .iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

pub(super) fn normalize_sanitization_keys(items: &[String]) -> Vec<String> {
    items
        .iter()
        .map(|s| normalize_sensitive_key(s))
        .filter(|s| !s.is_empty())
        .collect()
}

pub(super) fn bearer_token_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9\-._~+/]+=*")
            .expect("valid bearer regex")
    })
}

pub(super) fn jwt_token_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*")
            .expect("valid jwt regex")
    })
}

pub(super) fn redact_bearer_and_jwt_in_text(text: &str, replacement: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    let after_bearer = bearer_token_regex()
        .replace_all(text, format!("Bearer {replacement}").as_str())
        .into_owned();
    let after_jwt = jwt_token_regex()
        .replace_all(&after_bearer, replacement)
        .into_owned();
    if after_jwt != text {
        Some(after_jwt)
    } else {
        None
    }
}

pub(super) fn sanitize_url_component_replacement(replacement: &str) -> String {
    let mut out = String::with_capacity(replacement.len());
    for ch in replacement.chars() {
        match ch {
            '\r' | '\n' | '\0' => {}
            '%' => out.push_str("%25"),
            '&' => out.push_str("%26"),
            '=' => out.push_str("%3D"),
            '#' => out.push_str("%23"),
            '+' => out.push_str("%2B"),
            _ => out.push(ch),
        }
    }
    out
}

pub(super) fn redact_headers_in_place(
    headers: &mut [HeaderPair],
    redact_auth_headers: bool,
    custom_headers_lower: &[String],
    replacement: &str,
) {
    for h in headers.iter_mut() {
        let lower_name = h.name.trim().to_ascii_lowercase();
        let is_builtin = redact_auth_headers
            && BUILTIN_REDACTED_AUTH_HEADERS
                .iter()
                .any(|&builtin| builtin == lower_name);
        let is_custom = custom_headers_lower.iter().any(|c| c == &lower_name);
        if is_builtin || is_custom {
            h.value = replacement.to_string();
        }
    }
}

pub(super) fn mask_sensitive_json_value(
    value: &mut serde_json::Value,
    mask_keys_normalized: &[String],
    replacement: &str,
    redact_string_tokens: bool,
) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            let mut modified = false;
            for (k, v) in map.iter_mut() {
                let k_norm = normalize_sensitive_key(k);
                if mask_keys_normalized.iter().any(|mk| mk == &k_norm) {
                    *v = serde_json::Value::String(replacement.to_string());
                    modified = true;
                } else if mask_sensitive_json_value(
                    v,
                    mask_keys_normalized,
                    replacement,
                    redact_string_tokens,
                ) {
                    modified = true;
                }
            }
            modified
        }
        serde_json::Value::Array(arr) => {
            let mut modified = false;
            for item in arr.iter_mut() {
                if mask_sensitive_json_value(
                    item,
                    mask_keys_normalized,
                    replacement,
                    redact_string_tokens,
                ) {
                    modified = true;
                }
            }
            modified
        }
        serde_json::Value::String(s) if redact_string_tokens => {
            if let Some(updated) = redact_bearer_and_jwt_in_text(s, replacement) {
                *s = updated;
                true
            } else {
                false
            }
        }
        _ => false,
    }
}

pub(super) fn sanitize_json_text(
    text: &str,
    mask_keys_normalized: &[String],
    replacement: &str,
    redact_string_tokens: bool,
) -> Option<String> {
    let mut parsed: serde_json::Value = serde_json::from_str(text).ok()?;
    if !mask_sensitive_json_value(
        &mut parsed,
        mask_keys_normalized,
        replacement,
        redact_string_tokens,
    ) {
        return None;
    }
    if text.contains('\n') {
        serde_json::to_string_pretty(&parsed).ok()
    } else {
        serde_json::to_string(&parsed).ok()
    }
}

pub(super) fn is_likely_urlencoded_form(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('{')
        || trimmed.starts_with('[')
        || trimmed.starts_with('<')
        || trimmed.contains('\n')
        || trimmed.contains('\r')
        || !trimmed.contains('=')
    {
        return false;
    }
    trimmed.split('&').all(|seg| {
        if seg.is_empty() {
            return true;
        }
        match seg.split_once('=') {
            Some((k, v)) => {
                !k.trim().is_empty()
                    && !k.chars().any(char::is_whitespace)
                    && !v.chars().any(char::is_whitespace)
            }
            None => !seg.chars().any(char::is_whitespace),
        }
    })
}

pub(super) fn sanitize_urlencoded_text(
    text: &str,
    mask_keys_normalized: &[String],
    replacement: &str,
) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    let safe_rep = sanitize_url_component_replacement(replacement);
    let mut modified = false;
    let mut parts: Vec<String> = Vec::new();
    for seg in text.split('&') {
        if let Some((raw_k, _raw_v)) = seg.split_once('=') {
            let decoded_norm = normalize_sensitive_key(&url_decode_component(raw_k));
            if mask_keys_normalized.iter().any(|mk| mk == &decoded_norm) {
                parts.push(format!("{raw_k}={safe_rep}"));
                modified = true;
                continue;
            }
        }
        parts.push(seg.to_string());
    }
    if modified {
        Some(parts.join("&"))
    } else {
        None
    }
}

pub(super) fn sanitize_body_payload(
    text: &str,
    content_type_hint: Option<&str>,
    mask_keys_normalized: &[String],
    replacement: &str,
    redact_string_tokens: bool,
) -> Option<String> {
    if (mask_keys_normalized.is_empty() && !redact_string_tokens) || text.trim().is_empty() {
        return None;
    }
    let trimmed = text.trim_start();
    let ct_lower = content_type_hint.unwrap_or("").to_ascii_lowercase();
    let is_json_hint =
        ct_lower.contains("json") || trimmed.starts_with('{') || trimmed.starts_with('[');

    if is_json_hint {
        if let Some(updated) = sanitize_json_text(
            text,
            mask_keys_normalized,
            replacement,
            redact_string_tokens,
        ) {
            return Some(updated);
        }
    }

    let is_form_hint = ct_lower.contains("application/x-www-form-urlencoded")
        || is_likely_urlencoded_form(text);
    if is_form_hint && !mask_keys_normalized.is_empty() {
        return sanitize_urlencoded_text(text, mask_keys_normalized, replacement);
    }

    None
}

pub(super) fn split_socketio_prefix(payload: &str) -> Option<(&str, &str)> {
    let json_start = payload.find(['[', '{'])?;
    if json_start == 0 {
        return None;
    }
    let prefix = &payload[..json_start];
    let bytes = prefix.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let mut rest = &prefix[i..];
    if rest.starts_with('/') {
        let comma_idx = rest.find(',')?;
        let ns = &rest[..comma_idx];
        if ns.chars().any(char::is_whitespace) {
            return None;
        }
        rest = &rest[comma_idx + 1..];
    }
    if !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((prefix, &payload[json_start..]))
}

pub(super) fn sanitize_single_ws_record(
    record: &str,
    mask_keys_normalized: &[String],
    replacement: &str,
    redact_tokens: bool,
) -> Option<String> {
    if record.is_empty() {
        return None;
    }
    if let Some((prefix, json_part)) = split_socketio_prefix(record) {
        if let Some(sanitized_json) = sanitize_json_text(
            json_part,
            mask_keys_normalized,
            replacement,
            redact_tokens,
        ) {
            return Some(format!("{prefix}{sanitized_json}"));
        }
    }
    if let Some(sanitized_json) = sanitize_json_text(
        record,
        mask_keys_normalized,
        replacement,
        redact_tokens,
    ) {
        return Some(sanitized_json);
    }
    if redact_tokens {
        return redact_bearer_and_jwt_in_text(record, replacement);
    }
    None
}

pub(super) fn sanitize_ws_frame_payload(
    payload: &str,
    mask_keys_normalized: &[String],
    replacement: &str,
    redact_tokens: bool,
) -> Option<String> {
    if payload.is_empty() || (mask_keys_normalized.is_empty() && !redact_tokens) {
        return None;
    }
    if payload.contains('\x1e') {
        let mut modified = false;
        let parts: Vec<String> = payload
            .split('\x1e')
            .map(|segment| {
                if let Some(updated) = sanitize_single_ws_record(
                    segment,
                    mask_keys_normalized,
                    replacement,
                    redact_tokens,
                ) {
                    modified = true;
                    updated
                } else {
                    segment.to_string()
                }
            })
            .collect();
        if modified {
            return Some(parts.join("\x1e"));
        }
        return None;
    }

    sanitize_single_ws_record(payload, mask_keys_normalized, replacement, redact_tokens)
}

pub(super) fn rebuild_sse_response_body(events: &[SseEventRecord]) -> String {
    let mut out = String::new();
    for ev in events {
        if ev.event == ":comment" {
            for line in ev.data.lines() {
                out.push_str(": ");
                out.push_str(line);
                out.push('\n');
            }
            out.push('\n');
            continue;
        }
        if let Some(ref id) = ev.id {
            out.push_str("id: ");
            out.push_str(id);
            out.push('\n');
        }
        if !ev.event.is_empty() && ev.event != "message" {
            out.push_str("event: ");
            out.push_str(&ev.event);
            out.push('\n');
        }
        if let Some(retry) = ev.retry {
            out.push_str(&format!("retry: {retry}\n"));
        }
        if ev.data.is_empty() {
            out.push_str("data:\n");
        } else {
            for line in ev.data.split('\n') {
                out.push_str("data: ");
                out.push_str(line);
                out.push('\n');
            }
        }
        out.push('\n');
    }
    out
}

pub(super) fn update_content_length_header(headers: &mut [HeaderPair], byte_len: usize) {
    let len_str = byte_len.to_string();
    for h in headers.iter_mut() {
        if h.name.trim().eq_ignore_ascii_case("content-length") {
            h.value = len_str.clone();
        }
    }
}

pub(super) fn sanitize_url_query(
    input: &str,
    strip_params_normalized: &[String],
    replacement: &str,
) -> String {
    if input.trim().is_empty() {
        return input.to_string();
    }

    let safe_rep = sanitize_url_component_replacement(replacement);
    let mut modified = false;

    // 1. Strip `username[:password]@` from authority when input carries `scheme://` or `//`
    let (prefix_and_host, remainder) = if let Some(scheme_pos) = input.find("://") {
        let after_scheme_idx = scheme_pos + 3;
        let rest = &input[after_scheme_idx..];
        let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let authority = &rest[..auth_end];
        let cleaned_auth = if let Some((_, host_port)) = authority.rsplit_once('@') {
            modified = true;
            host_port
        } else {
            authority
        };
        (
            format!("{}{}", &input[..after_scheme_idx], cleaned_auth),
            &rest[auth_end..],
        )
    } else if let Some(rest) = input.strip_prefix("//") {
        let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let authority = &rest[..auth_end];
        let cleaned_auth = if let Some((_, host_port)) = authority.rsplit_once('@') {
            modified = true;
            host_port
        } else {
            authority
        };
        (format!("//{cleaned_auth}"), &rest[auth_end..])
    } else {
        (String::new(), input)
    };

    // 2. Split fragment `#...` and redact non-empty fragment payloads
    let (before_fragment, sanitized_fragment) = match remainder.split_once('#') {
        Some((before, frag)) => {
            if !frag.is_empty() {
                if frag != safe_rep {
                    modified = true;
                }
                (before, Some(safe_rep.clone()))
            } else {
                (before, Some(String::new()))
            }
        }
        None => (remainder, None),
    };

    // 3. Redact matching query parameters
    let sanitized_base_and_query = if let Some((base, query)) = before_fragment.split_once('?') {
        if query.is_empty() || strip_params_normalized.is_empty() {
            before_fragment.to_string()
        } else {
            let mut rebuilt = Vec::new();
            for seg in query.split('&') {
                if seg.is_empty() {
                    rebuilt.push(String::new());
                    continue;
                }
                if let Some((raw_k, _raw_v)) = seg.split_once('=') {
                    let decoded_norm = normalize_sensitive_key(&url_decode_component(raw_k));
                    if strip_params_normalized.iter().any(|p| p == &decoded_norm) {
                        rebuilt.push(format!("{raw_k}={safe_rep}"));
                        modified = true;
                        continue;
                    }
                }
                rebuilt.push(seg.to_string());
            }
            format!("{base}?{}", rebuilt.join("&"))
        }
    } else {
        before_fragment.to_string()
    };

    if !modified {
        return input.to_string();
    }

    let mut out = format!("{prefix_and_host}{sanitized_base_and_query}");
    if let Some(frag) = sanitized_fragment {
        out.push('#');
        out.push_str(&frag);
    }
    out
}

/// Pure transformation that clones `sessions` and masks sensitive headers, JSON/form bodies,
/// query parameters, URL credentials/fragments, SSE/WebSocket payloads, and client/process metadata
/// according to `SanitizationOptions`.
pub fn sanitize_sessions(
    sessions: &[SessionDetail],
    opts: &SanitizationOptions,
) -> Vec<SessionDetail> {
    let replacement = if opts.replacement_text.trim().is_empty() {
        "[REDACTED]"
    } else {
        opts.replacement_text.as_str()
    };
    let custom_headers_lower = normalize_sanitization_tokens(&opts.custom_redacted_headers);
    let mask_keys_normalized = normalize_sanitization_keys(&opts.mask_json_keys);
    let strip_params_normalized = normalize_sanitization_keys(&opts.strip_query_params);
    let redact_string_tokens = opts.redact_auth_headers || !mask_keys_normalized.is_empty();

    sessions
        .iter()
        .map(|orig| {
            let mut detail = orig.clone();

            // 1. Redact sensitive request & response headers
            if opts.redact_auth_headers || !custom_headers_lower.is_empty() {
                redact_headers_in_place(
                    &mut detail.request_headers,
                    opts.redact_auth_headers,
                    &custom_headers_lower,
                    replacement,
                );
                redact_headers_in_place(
                    &mut detail.response_headers,
                    opts.redact_auth_headers,
                    &custom_headers_lower,
                    replacement,
                );
            }

            // 2. Mask sensitive keys & embedded tokens in request/response bodies, SSE events, and WS frames
            if redact_string_tokens {
                let req_bytes = decode_detail_body_bytes(&detail, false);
                if let Ok(req_text) = std::str::from_utf8(&req_bytes) {
                    let req_ct = find_header_value(&detail.request_headers, "content-type")
                        .map(str::to_string);
                    if let Some(sanitized_req) = sanitize_body_payload(
                        req_text,
                        req_ct.as_deref(),
                        &mask_keys_normalized,
                        replacement,
                        redact_string_tokens,
                    ) {
                        let new_len = sanitized_req.len();
                        detail.request_body_base64 =
                            base64::engine::general_purpose::STANDARD.encode(sanitized_req.as_bytes());
                        detail.request_body_text = Some(sanitized_req);
                        if detail.summary.request_size.is_some() {
                            detail.summary.request_size = Some(new_len);
                        }
                        if let Some(ref mut stats) = detail.transfer_stats {
                            stats.request_body_bytes = Some(new_len);
                        }
                        update_content_length_header(&mut detail.request_headers, new_len);
                    }
                }

                let resp_bytes = decode_detail_body_bytes(&detail, true);
                let resp_ct = if !detail.summary.content_type.trim().is_empty() {
                    Some(detail.summary.content_type.clone())
                } else {
                    find_header_value(&detail.response_headers, "content-type").map(str::to_string)
                };
                if let Ok(resp_text) = std::str::from_utf8(&resp_bytes) {
                    if let Some(sanitized_resp) = sanitize_body_payload(
                        resp_text,
                        resp_ct.as_deref(),
                        &mask_keys_normalized,
                        replacement,
                        redact_string_tokens,
                    ) {
                        let new_len = sanitized_resp.len();
                        detail.response_body_base64 =
                            base64::engine::general_purpose::STANDARD.encode(sanitized_resp.as_bytes());
                        detail.response_body_text = Some(sanitized_resp);
                        detail.summary.body_size = new_len;
                        if let Some(ref mut stats) = detail.transfer_stats {
                            stats.response_body_bytes = Some(new_len);
                        }
                        update_content_length_header(&mut detail.response_headers, new_len);
                    }
                }

                let mut sse_modified = false;
                for ev in detail.sse_events.iter_mut() {
                    let sanitized_ev = sanitize_json_text(
                        &ev.data,
                        &mask_keys_normalized,
                        replacement,
                        redact_string_tokens,
                    )
                    .or_else(|| redact_bearer_and_jwt_in_text(&ev.data, replacement));
                    if let Some(sanitized_data) = sanitized_ev {
                        ev.byte_length = sanitized_data.len();
                        ev.data = sanitized_data;
                        sse_modified = true;
                    }
                }

                let is_sse_response = resp_ct
                    .as_deref()
                    .is_some_and(|ct| ct.to_ascii_lowercase().contains("text/event-stream"));
                if !detail.sse_events.is_empty() && (sse_modified || is_sse_response) {
                    let rebuilt_sse = rebuild_sse_response_body(&detail.sse_events);
                    let new_len = rebuilt_sse.len();
                    detail.response_body_base64 =
                        base64::engine::general_purpose::STANDARD.encode(rebuilt_sse.as_bytes());
                    detail.response_body_text = Some(rebuilt_sse);
                    detail.summary.body_size = new_len;
                    if let Some(ref mut stats) = detail.transfer_stats {
                        stats.response_body_bytes = Some(new_len);
                    }
                    update_content_length_header(&mut detail.response_headers, new_len);
                }

                let mut ws_modified = false;
                for frame in detail.websocket_frames.iter_mut() {
                    if let Some(sanitized_payload) = sanitize_ws_frame_payload(
                        &frame.payload_preview,
                        &mask_keys_normalized,
                        replacement,
                        redact_string_tokens,
                    ) {
                        frame.byte_length = sanitized_payload.len();
                        frame.payload_preview = sanitized_payload;
                        ws_modified = true;
                    }
                }

                let is_ws_session = detail.summary.status == 101
                    || detail.summary.scheme.eq_ignore_ascii_case("ws")
                    || detail.summary.scheme.eq_ignore_ascii_case("wss")
                    || detail.summary.protocol.to_ascii_uppercase().contains("WS");
                if !detail.websocket_frames.is_empty() && (ws_modified || is_ws_session) {
                    if let Ok(rebuilt_ws) = serde_json::to_string_pretty(&detail.websocket_frames) {
                        let new_len = rebuilt_ws.len();
                        detail.response_body_base64 =
                            base64::engine::general_purpose::STANDARD.encode(rebuilt_ws.as_bytes());
                        detail.response_body_text = Some(rebuilt_ws);
                        detail.summary.body_size = new_len;
                        if let Some(ref mut stats) = detail.transfer_stats {
                            stats.response_body_bytes = Some(new_len);
                        }
                        update_content_length_header(&mut detail.response_headers, new_len);
                    }
                }
            }

            // 3. Redact userinfo, sensitive query parameters, and fragments in URL, path, Location & Referer
            if opts.redact_auth_headers || !strip_params_normalized.is_empty() {
                detail.summary.url = sanitize_url_query(
                    &detail.summary.url,
                    &strip_params_normalized,
                    replacement,
                );
                detail.summary.path = sanitize_url_query(
                    &detail.summary.path,
                    &strip_params_normalized,
                    replacement,
                );
                for hdr in detail
                    .request_headers
                    .iter_mut()
                    .chain(detail.response_headers.iter_mut())
                {
                    if hdr.name.trim().eq_ignore_ascii_case("location")
                        || hdr.name.trim().eq_ignore_ascii_case("referer")
                    {
                        hdr.value =
                            sanitize_url_query(&hdr.value, &strip_params_normalized, replacement);
                    }
                }
            }

            // 4. Anonymize client address, IP, and local process info
            if opts.anonymize_client_info {
                detail.client_addr = "0.0.0.0:0".to_string();
                detail.summary.client_ip = Some("0.0.0.0".to_string());
                detail.summary.process_name = Some("redacted-process".to_string());
                detail.summary.process_pid = None;
                if let Some(ref mut stats) = detail.transfer_stats {
                    stats.client_conn_id = None;
                }
            }

            detail
        })
        .collect()
}

// ============================================================================
// HAR 1.2 Conversion Helpers
// ============================================================================
