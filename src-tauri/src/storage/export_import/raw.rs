use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::Path;

use base64::Engine as _;
use flate2::read::{DeflateDecoder, GzDecoder, ZlibDecoder};

use crate::models::{HeaderPair, ProxyError, SessionDetail};

use super::{
    ensure_parent_dir, MAX_SAZ_CONTENT_ENCODING_LAYERS, MAX_SAZ_ENTRY_BYTES,
    MAX_SAZ_TOTAL_UNCOMPRESSED_BYTES,
};

pub fn serialize_full_raw_http(sessions: &[SessionDetail]) -> Vec<u8> {
    let mut out = Vec::new();
    for (idx, detail) in sessions.iter().enumerate() {
        if idx > 0 {
            out.extend_from_slice(
                b"\r\n------------------------------------------------------------------\r\n\r\n",
            );
        }
        let req_raw = build_raw_http_request_bytes(detail);
        out.extend_from_slice(&req_raw);
        out.extend_from_slice(b"\r\n\r\n");
        let resp_raw = build_raw_http_response_bytes(detail);
        out.extend_from_slice(&resp_raw);
        out.extend_from_slice(b"\r\n");
    }
    out
}

/// Writes raw binary or text payload bytes directly to `path`, creating parent directories if needed.
pub fn write_raw_bytes_to_file(path: &Path, bytes: &[u8]) -> Result<usize, ProxyError> {
    ensure_parent_dir(path)?;
    let mut file = BufWriter::new(File::create(path)?);
    file.write_all(bytes)?;
    file.flush()?;
    Ok(bytes.len())
}

pub fn decode_detail_body_bytes(detail: &SessionDetail, is_response: bool) -> Vec<u8> {
    let (b64, text_opt) = if is_response {
        (
            detail.response_body_base64.trim(),
            detail.response_body_text.as_deref(),
        )
    } else {
        (
            detail.request_body_base64.trim(),
            detail.request_body_text.as_deref(),
        )
    };

    if !b64.is_empty() {
        let cleaned: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(&cleaned) {
            return decoded;
        }
    }

    if let Some(txt) = text_opt {
        return txt.as_bytes().to_vec();
    }

    Vec::new()
}

// ============================================================================
// PII & Secrets Sanitization Engine (HAR / SAZ / JSON / Raw HTTP)
// ============================================================================

pub(super) fn sanitize_http_line_token(raw: &str) -> String {
    raw.chars()
        .filter(|&c| c != '\r' && c != '\n' && c != '\0')
        .collect()
}

pub(super) fn build_raw_http_request_bytes(detail: &SessionDetail) -> Vec<u8> {
    let s = &detail.summary;
    let body = decode_detail_body_bytes(detail, false);
    let http_version = wire_http_version(&s.protocol);
    let clean_host = sanitize_http_line_token(&s.host);
    let raw_target = if s.method.eq_ignore_ascii_case("CONNECT") {
        if clean_host.contains(':') {
            clean_host.clone()
        } else {
            format!("{clean_host}:443")
        }
    } else if !s.url.is_empty() && s.url.contains("://") {
        s.url.clone()
    } else if !s.path.is_empty() {
        s.path.clone()
    } else {
        "/".to_string()
    };
    let target = sanitize_http_line_token(&raw_target);

    let clean_method = sanitize_http_line_token(&s.method);
    let method = if clean_method.is_empty() {
        "GET"
    } else {
        clean_method.as_str()
    };
    let mut head = format!("{method} {target} {http_version}\r\n");

    let mut has_host = false;
    let mut has_content_len = false;
    for h in &detail.request_headers {
        let clean_name = sanitize_http_line_token(&h.name);
        if clean_name.is_empty() {
            continue;
        }
        let clean_value = sanitize_http_line_token(&h.value);
        let lower = clean_name.to_ascii_lowercase();
        if lower == "host" {
            has_host = true;
        }
        // Decoded body bytes are written directly; omit stale chunked/compressed framing headers
        if lower == "transfer-encoding" {
            continue;
        }
        if lower == "content-encoding" && !is_matching_compressed_magic(&clean_value, &body) {
            continue;
        }
        if lower == "content-length" {
            has_content_len = true;
            head.push_str(&format!("{clean_name}: {}\r\n", body.len()));
            continue;
        }
        head.push_str(&format!("{clean_name}: {clean_value}\r\n"));
    }

    if !has_host && !clean_host.is_empty() {
        head.push_str(&format!("Host: {clean_host}\r\n"));
    }
    if !has_content_len && !body.is_empty() {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");

    let mut out = head.into_bytes();
    out.extend_from_slice(&body);
    out
}

pub(super) fn build_raw_http_response_bytes(detail: &SessionDetail) -> Vec<u8> {
    let s = &detail.summary;
    let body = decode_detail_body_bytes(detail, true);
    if s.status == 0 && detail.response_headers.is_empty() && body.is_empty() {
        return Vec::new();
    }

    let http_version = wire_http_version(&s.protocol);
    let status = s.status;
    let reason = canonical_status_reason(status);
    let mut head = format!("{http_version} {status} {reason}\r\n");

    let mut has_content_len = false;
    let mut has_content_type = false;

    for h in &detail.response_headers {
        let clean_name = sanitize_http_line_token(&h.name);
        if clean_name.is_empty() {
            continue;
        }
        let clean_value = sanitize_http_line_token(&h.value);
        let lower = clean_name.to_ascii_lowercase();
        if lower == "transfer-encoding" {
            continue;
        }
        if lower == "content-encoding" && !is_matching_compressed_magic(&clean_value, &body) {
            continue;
        }
        if lower == "content-length" {
            has_content_len = true;
            head.push_str(&format!("{clean_name}: {}\r\n", body.len()));
            continue;
        }
        if lower == "content-type" {
            has_content_type = true;
        }
        head.push_str(&format!("{clean_name}: {clean_value}\r\n"));
    }

    let clean_content_type = sanitize_http_line_token(&s.content_type);
    if !has_content_type && !clean_content_type.trim().is_empty() {
        head.push_str(&format!("Content-Type: {clean_content_type}\r\n"));
    }
    if !has_content_len {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");

    let mut out = head.into_bytes();
    out.extend_from_slice(&body);
    out
}


pub(super) fn split_raw_http_message(raw: &[u8]) -> (String, Vec<HeaderPair>, &[u8]) {
    if raw.is_empty() {
        return (String::new(), Vec::new(), &[]);
    }

    let (head_bytes, body_bytes) = if let Some(pos) = find_subslice(raw, b"\r\n\r\n") {
        (&raw[..pos], &raw[pos + 4..])
    } else if let Some(pos) = find_subslice(raw, b"\n\n") {
        (&raw[..pos], &raw[pos + 2..])
    } else {
        (raw, &[][..])
    };

    let head_str = String::from_utf8_lossy(head_bytes);
    let mut lines = head_str.lines();
    let start_line = lines.next().unwrap_or("").trim().to_string();

    let mut headers = Vec::new();
    for line in lines {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.is_empty() {
            continue;
        }
        if let Some((name, val)) = trimmed.split_once(':') {
            headers.push(HeaderPair {
                name: name.trim().to_string(),
                value: val.trim().to_string(),
            });
        }
    }

    (start_line, headers, body_bytes)
}

pub(super) enum BoundedDecodeResult {
    Ok(Vec<u8>),
    LimitExceeded,
    InvalidFormat,
}

pub(super) fn has_zstd_magic(input: &[u8]) -> bool {
    if input.len() < 4 {
        return false;
    }
    input[0..4] == [0x28, 0xB5, 0x2F, 0xFD]
        || ((input[0] & 0xF0) == 0x50 && input[1..4] == [0x2A, 0x4D, 0x18])
}

pub(super) fn decode_http_body(
    raw_body: &[u8],
    headers: &[HeaderPair],
    cumulative_http_bytes: &mut u64,
) -> Result<Vec<u8>, ProxyError> {
    decode_http_body_with_limit(
        raw_body,
        headers,
        cumulative_http_bytes,
        MAX_SAZ_TOTAL_UNCOMPRESSED_BYTES,
    )
}

pub(super) fn decode_http_body_with_limit(
    raw_body: &[u8],
    headers: &[HeaderPair],
    cumulative_http_bytes: &mut u64,
    total_limit: u64,
) -> Result<Vec<u8>, ProxyError> {
    if raw_body.is_empty() {
        return Ok(Vec::new());
    }

    let is_chunked = headers.iter().any(|h| {
        h.name.eq_ignore_ascii_case("transfer-encoding")
            && h.value.to_ascii_lowercase().contains("chunked")
    });

    let unchunked = if is_chunked {
        decode_chunked(raw_body).unwrap_or_else(|| raw_body.to_vec())
    } else {
        raw_body.to_vec()
    };

    // HTTP `Content-Encoding` lists transformations in the order applied (`inner, ..., outer`),
    // so decoding must unwrap from right to left (LIFO stack).
    let encodings: Vec<String> = headers
        .iter()
        .filter(|h| h.name.eq_ignore_ascii_case("content-encoding"))
        .flat_map(|h| h.value.split(','))
        .map(|tok| tok.trim().to_ascii_lowercase())
        .filter(|tok| !tok.is_empty() && tok != "identity")
        .collect();

    if encodings.is_empty() {
        return Ok(unchunked);
    }

    if encodings.len() > MAX_SAZ_CONTENT_ENCODING_LAYERS {
        return Err(ProxyError::Custom(format!(
            "Слишком много слоёв Content-Encoding в HTTP-сообщении ({} > лимит {MAX_SAZ_CONTENT_ENCODING_LAYERS})",
            encodings.len()
        )));
    }

    let mut current = unchunked.clone();
    for enc in encodings.iter().rev() {
        let remaining = total_limit.saturating_sub(*cumulative_http_bytes);
        let layer_limit = MAX_SAZ_ENTRY_BYTES.min(remaining);
        match decode_single_content_encoding(&current, enc, layer_limit) {
            BoundedDecodeResult::Ok(next) => {
                let next_len = next.len() as u64;
                let new_total = cumulative_http_bytes.saturating_add(next_len);
                if new_total > total_limit {
                    return Err(ProxyError::Custom(format!(
                        "Суммарный распакованный размер HTTP-тел в SAZ превышает лимит {total_limit} байт"
                    )));
                }
                *cumulative_http_bytes = new_total;
                current = next;
            }
            BoundedDecodeResult::LimitExceeded => {
                return Err(ProxyError::Custom(format!(
                    "Распакованное HTTP-тело ({enc}) превышает допустимый лимит ({layer_limit} байт / общий лимит {total_limit} байт)"
                )));
            }
            BoundedDecodeResult::InvalidFormat => {
                return Ok(unchunked);
            }
        }
    }

    Ok(current)
}

pub(super) fn read_bounded_decoder_output<R: Read>(decoder: R, max_bytes: u64) -> BoundedDecodeResult {
    let mut out = Vec::new();
    if decoder
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut out)
        .is_err()
    {
        return BoundedDecodeResult::InvalidFormat;
    }
    if (out.len() as u64) > max_bytes {
        return BoundedDecodeResult::LimitExceeded;
    }
    BoundedDecodeResult::Ok(out)
}

pub(super) fn decode_single_content_encoding(
    input: &[u8],
    encoding: &str,
    max_bytes: u64,
) -> BoundedDecodeResult {
    match encoding {
        "gzip" | "x-gzip" => {
            if input.len() >= 2 && input[0] == 0x1f && input[1] == 0x8b {
                read_bounded_decoder_output(GzDecoder::new(input), max_bytes)
            } else {
                BoundedDecodeResult::InvalidFormat
            }
        }
        "br" | "brotli" => {
            read_bounded_decoder_output(brotli::Decompressor::new(input, 4096), max_bytes)
        }
        "deflate" | "x-deflate" => {
            match read_bounded_decoder_output(ZlibDecoder::new(input), max_bytes) {
                BoundedDecodeResult::InvalidFormat => {
                    read_bounded_decoder_output(DeflateDecoder::new(input), max_bytes)
                }
                other => other,
            }
        }
        "zstd" | "x-zstd" => {
            if !has_zstd_magic(input) {
                return BoundedDecodeResult::InvalidFormat;
            }
            match zstd::stream::read::Decoder::new(input) {
                Ok(dec) => read_bounded_decoder_output(dec, max_bytes),
                Err(_) => BoundedDecodeResult::InvalidFormat,
            }
        }
        _ => BoundedDecodeResult::InvalidFormat,
    }
}

pub(super) fn decode_chunked(input: &[u8]) -> Option<Vec<u8>> {
    let mut pos = 0usize;
    let mut out = Vec::new();
    let mut parsed_any_chunk = false;

    while pos < input.len() {
        let line_end = find_subslice(&input[pos..], b"\r\n")?;
        let line_slice_end = pos.checked_add(line_end)?;
        let size_line = std::str::from_utf8(&input[pos..line_slice_end]).ok()?;
        let hex_part = size_line.split(';').next()?.trim();
        if hex_part.is_empty() {
            return None;
        }
        let chunk_size = usize::from_str_radix(hex_part, 16).ok()?;
        pos = line_slice_end.checked_add(2)?;

        if chunk_size == 0 {
            return Some(out);
        }

        let chunk_end = pos.checked_add(chunk_size)?;
        if chunk_end > input.len() {
            return None;
        }
        out.extend_from_slice(&input[pos..chunk_end]);
        pos = chunk_end;
        parsed_any_chunk = true;

        let after_crlf = pos.checked_add(2)?;
        if after_crlf <= input.len() && &input[pos..after_crlf] == b"\r\n" {
            pos = after_crlf;
        } else {
            return None;
        }
    }

    if parsed_any_chunk {
        Some(out)
    } else {
        None
    }
}

pub(super) fn has_valid_zlib_header(body: &[u8]) -> bool {
    if body.len() < 2 {
        return false;
    }
    let cmf = body[0];
    let flg = body[1];
    (cmf & 0x0f) == 8 && (cmf >> 4) <= 7 && ((u16::from(cmf) << 8) | u16::from(flg)) % 31 == 0
}

pub(super) fn is_matching_compressed_magic(encoding_val: &str, body: &[u8]) -> bool {
    if body.is_empty() {
        return false;
    }
    let outer = encoding_val
        .rsplit(',')
        .next()
        .unwrap_or(encoding_val)
        .trim()
        .to_ascii_lowercase();
    match outer.as_str() {
        "gzip" | "x-gzip" => body.len() >= 2 && body[0] == 0x1f && body[1] == 0x8b,
        "deflate" | "x-deflate" => {
            if has_valid_zlib_header(body)
                && matches!(
                    read_bounded_decoder_output(ZlibDecoder::new(body), MAX_SAZ_ENTRY_BYTES),
                    BoundedDecodeResult::Ok(_)
                )
            {
                return true;
            }
            matches!(
                read_bounded_decoder_output(DeflateDecoder::new(body), MAX_SAZ_ENTRY_BYTES),
                BoundedDecodeResult::Ok(_)
            )
        }
        "br" | "brotli" => matches!(
            read_bounded_decoder_output(brotli::Decompressor::new(body, 4096), MAX_SAZ_ENTRY_BYTES),
            BoundedDecodeResult::Ok(_)
        ),
        "zstd" | "x-zstd" => {
            has_zstd_magic(body)
                && zstd::stream::read::Decoder::new(body)
                    .ok()
                    .is_some_and(|dec| {
                        matches!(
                            read_bounded_decoder_output(dec, MAX_SAZ_ENTRY_BYTES),
                            BoundedDecodeResult::Ok(_)
                        )
                    })
        }
        _ => false,
    }
}

pub(super) fn parse_http_request_line(line: &str) -> (String, String, String) {
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_uppercase();
    let target = parts.next().unwrap_or("/").to_string();
    let version = parts.next().unwrap_or("HTTP/1.1").to_string();
    (method, target, version)
}

pub(super) fn parse_http_status_line(line: &str) -> (String, u16) {
    if line.is_empty() {
        return (String::new(), 0);
    }
    let mut parts = line.split_whitespace();
    let version = parts.next().unwrap_or("HTTP/1.1").to_string();
    let status = parts
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    (version, status)
}

pub(super) fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

pub(super) fn find_header_value<'a>(headers: &'a [HeaderPair], target_name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case(target_name))
        .map(|h| h.value.as_str())
}

pub(super) fn wire_http_version(protocol: &str) -> &'static str {
    let upper = protocol.trim().to_ascii_uppercase();
    if upper.contains("/2") || upper == "H2" {
        "HTTP/2.0"
    } else if upper.contains("1.0") {
        "HTTP/1.0"
    } else {
        "HTTP/1.1"
    }
}

pub(super) fn canonical_status_reason(status: u16) -> &'static str {
    match status {
        0 => "No Response",
        100 => "Continue",
        101 => "Switching Protocols",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        206 => "Partial Content",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "OK",
    }
}

