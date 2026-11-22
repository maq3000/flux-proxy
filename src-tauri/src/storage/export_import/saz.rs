use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, Write};
use std::path::Path;

use base64::Engine as _;
use chrono::{DateTime, SecondsFormat, TimeDelta, Utc};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::models::{
    HeaderPair, ProxyError, SessionDetail, SessionSummary, SessionTimings, SessionTransferStats,
    SseEventRecord, WebSocketFrameRecord,
};

use super::har::{har_http_version_to_protocol, parse_authority_and_path};
use super::raw::{
    build_raw_http_request_bytes, build_raw_http_response_bytes, decode_http_body,
    find_header_value, parse_http_request_line, parse_http_status_line, split_raw_http_message,
};
use super::{
    ensure_parent_dir, MAX_IMPORT_FILE_BYTES, MAX_SAZ_ENTRY_BYTES, MAX_SAZ_TOTAL_UNCOMPRESSED_BYTES,
};

/// Initial buffer allocation cap when reading an untrusted ZIP entry whose header size could be spoofed.
pub(super) const MAX_SAZ_INITIAL_PREALLOC_BYTES: usize = 64 * 1024;


pub fn write_saz_to_writer<W: Write + Seek>(
    writer: W,
    sessions: &[SessionDetail],
) -> Result<usize, ProxyError> {
    let mut zip = ZipWriter::new(writer);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    // 1. OPC `[Content_Types].xml`
    zip.start_file("[Content_Types].xml", options)
        .map_err(|e| ProxyError::Custom(format!("SAZ zip error ([Content_Types].xml): {e}")))?;
    zip.write_all(SAZ_CONTENT_TYPES_XML.as_bytes())?;

    // 2. Fiddler Classic `_index.htm` summary table
    let pad_width = sessions.len().max(1).to_string().len().max(4);
    let index_html = build_saz_index_html(sessions, pad_width);
    zip.start_file("_index.htm", options)
        .map_err(|e| ProxyError::Custom(format!("SAZ zip error (_index.htm): {e}")))?;
    zip.write_all(index_html.as_bytes())?;

    // 3. `raw/{N}_c.txt`, `raw/{N}_s.txt`, `raw/{N}_m.xml` (and optional `raw/{N}_w.txt`)
    for (idx, detail) in sessions.iter().enumerate() {
        let seq = idx + 1;
        let prefix = format!("raw/{seq:0width$}", width = pad_width);

        let raw_client = build_raw_http_request_bytes(detail);
        zip.start_file(format!("{prefix}_c.txt"), options)
            .map_err(|e| ProxyError::Custom(format!("SAZ zip error ({prefix}_c.txt): {e}")))?;
        zip.write_all(&raw_client)?;

        let raw_server = build_raw_http_response_bytes(detail);
        zip.start_file(format!("{prefix}_s.txt"), options)
            .map_err(|e| ProxyError::Custom(format!("SAZ zip error ({prefix}_s.txt): {e}")))?;
        zip.write_all(&raw_server)?;

        let meta_xml = build_saz_metadata_xml(detail, seq);
        zip.start_file(format!("{prefix}_m.xml"), options)
            .map_err(|e| ProxyError::Custom(format!("SAZ zip error ({prefix}_m.xml): {e}")))?;
        zip.write_all(meta_xml.as_bytes())?;

        if !detail.websocket_frames.is_empty() {
            let ws_txt = build_saz_websocket_log(&detail.websocket_frames);
            zip.start_file(format!("{prefix}_w.txt"), options)
                .map_err(|e| ProxyError::Custom(format!("SAZ zip error ({prefix}_w.txt): {e}")))?;
            zip.write_all(ws_txt.as_bytes())?;
        }
    }

    zip.finish()
        .map_err(|e| ProxyError::Custom(format!("SAZ finalize error: {e}")))?;
    Ok(sessions.len())
}

/// Writes `SessionDetail` items to a `.saz` file on disk.
pub fn write_saz_file(path: &Path, sessions: &[SessionDetail]) -> Result<usize, ProxyError> {
    ensure_parent_dir(path)?;
    let file = File::create(path)?;
    let writer = BufWriter::new(file);
    write_saz_to_writer(writer, sessions)
}

/// Reads a bounded `.saz` entry using `Read::take` with a capped initial buffer allocation
/// so a malformed/ZIP-bomb archive cannot exhaust RAM or surpass size limits.
pub(super) fn read_bounded_saz_entry<R: Read>(
    entry: &mut R,
    declared_size: u64,
    remaining_total: u64,
    entry_name: &str,
) -> Result<Vec<u8>, ProxyError> {
    if declared_size > MAX_SAZ_ENTRY_BYTES {
        return Err(ProxyError::Custom(format!(
            "Запись SAZ '{entry_name}' слишком велика ({declared_size} байт > лимит {MAX_SAZ_ENTRY_BYTES} байт)"
        )));
    }
    if declared_size > remaining_total {
        return Err(ProxyError::Custom(format!(
            "Суммарный распакованный размер архива SAZ превышает лимит {MAX_SAZ_TOTAL_UNCOMPRESSED_BYTES} байт (на записи '{entry_name}')"
        )));
    }

    let read_limit = MAX_SAZ_ENTRY_BYTES.min(remaining_total);
    let initial_cap = (declared_size as usize).min(MAX_SAZ_INITIAL_PREALLOC_BYTES);
    let mut buf = Vec::with_capacity(initial_cap);

    entry
        .take(read_limit.saturating_add(1))
        .read_to_end(&mut buf)?;

    if (buf.len() as u64) > MAX_SAZ_ENTRY_BYTES {
        return Err(ProxyError::Custom(format!(
            "Распакованная запись SAZ '{entry_name}' превышает лимит {MAX_SAZ_ENTRY_BYTES} байт (подозрение на ZIP-бомбу)"
        )));
    }
    if (buf.len() as u64) > remaining_total {
        return Err(ProxyError::Custom(format!(
            "Суммарный распакованный размер архива SAZ превышает лимит {MAX_SAZ_TOTAL_UNCOMPRESSED_BYTES} байт (подозрение на ZIP-бомбу)"
        )));
    }

    Ok(buf)
}

/// Reads a Fiddler Classic `.saz` archive from any `Read + Seek` source into `Vec<SessionDetail>`.
pub fn read_saz_from_reader<R: Read + Seek>(reader: R) -> Result<Vec<SessionDetail>, ProxyError> {
    let mut archive = ZipArchive::new(reader)
        .map_err(|e| ProxyError::Custom(format!("Не удалось открыть архив SAZ (.zip): {e}")))?;

    #[derive(Default)]
    struct RawSazParts {
        numeric_order: u64,
        client_bytes: Option<Vec<u8>>,
        server_bytes: Option<Vec<u8>>,
        meta_xml: Option<String>,
        ws_text: Option<String>,
    }

    let mut grouped: BTreeMap<(u64, String), RawSazParts> = BTreeMap::new();
    let mut total_uncompressed_bytes: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| ProxyError::Custom(format!("Ошибка чтения записи SAZ #{i}: {e}")))?;
        if entry.is_dir() {
            continue;
        }

        let normalized = entry.name().replace('\\', "/");
        let Some(rest) = normalized
            .strip_prefix("raw/")
            .or_else(|| normalized.strip_prefix("/raw/"))
        else {
            continue;
        };

        // Match `{id}_c.txt`, `{id}_s.txt`, `{id}_m.xml`, `{id}_w.txt` (case-insensitive suffix)
        let lower = rest.to_ascii_lowercase();
        let (key_str, part_kind) = if let Some(k) = lower.strip_suffix("_c.txt") {
            (&rest[..k.len()], 'c')
        } else if let Some(k) = lower.strip_suffix("_s.txt") {
            (&rest[..k.len()], 's')
        } else if let Some(k) = lower.strip_suffix("_m.xml") {
            (&rest[..k.len()], 'm')
        } else if let Some(k) = lower.strip_suffix("_w.txt") {
            (&rest[..k.len()], 'w')
        } else {
            continue;
        };

        if key_str.is_empty() || key_str.contains('/') {
            continue;
        }

        let numeric_order = key_str
            .trim_start_matches('0')
            .parse::<u64>()
            .or_else(|_| key_str.parse::<u64>())
            .unwrap_or(u64::MAX);

        let remaining_total = MAX_SAZ_TOTAL_UNCOMPRESSED_BYTES.saturating_sub(total_uncompressed_bytes);
        let declared_size = entry.size();
        let entry_name = normalized.clone();
        let buf = read_bounded_saz_entry(&mut entry, declared_size, remaining_total, &entry_name)?;
        total_uncompressed_bytes = total_uncompressed_bytes.saturating_add(buf.len() as u64);

        let slot = grouped
            .entry((numeric_order, key_str.to_string()))
            .or_insert_with(|| RawSazParts {
                numeric_order,
                ..Default::default()
            });

        match part_kind {
            'c' => slot.client_bytes = Some(buf),
            's' => slot.server_bytes = Some(buf),
            'm' => {
                slot.meta_xml = Some(decode_xml_bytes(&buf));
            }
            'w' => {
                slot.ws_text = Some(String::from_utf8_lossy(&buf).into_owned());
            }
            _ => {}
        }
    }

    let mut sessions = Vec::with_capacity(grouped.len());
    let mut total_http_decompressed_bytes: u64 = 0;
    for (idx, ((_, _), parts)) in grouped.into_iter().enumerate() {
        if parts.client_bytes.is_none() && parts.server_bytes.is_none() {
            continue;
        }
        let fallback_id = if parts.numeric_order != u64::MAX && parts.numeric_order > 0 {
            parts.numeric_order
        } else {
            (idx + 1) as u64
        };
        let detail = build_session_from_saz_parts(
            fallback_id,
            parts.client_bytes.as_deref().unwrap_or(&[]),
            parts.server_bytes.as_deref().unwrap_or(&[]),
            parts.meta_xml.as_deref(),
            parts.ws_text.as_deref(),
            &mut total_http_decompressed_bytes,
        )?;
        sessions.push(detail);
    }

    Ok(sessions)
}

/// Validates file size before opening and reads a Fiddler Classic `.saz` archive from disk.
pub fn read_saz_file(path: &Path) -> Result<Vec<SessionDetail>, ProxyError> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_IMPORT_FILE_BYTES {
        return Err(ProxyError::Custom(format!(
            "Размер файла {} ({} байт) превышает допустимый лимит импорта ({MAX_IMPORT_FILE_BYTES} байт)",
            path.display(),
            meta.len()
        )));
    }
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    read_saz_from_reader(reader)
}


pub(super) const SAZ_CONTENT_TYPES_XML: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="htm" ContentType="text/html" />
  <Default Extension="txt" ContentType="application/octet-stream" />
  <Default Extension="xml" ContentType="application/xml" />
</Types>"#;

pub(super) fn build_saz_index_html(sessions: &[SessionDetail], pad_width: usize) -> String {
    let mut rows = String::new();
    for (idx, detail) in sessions.iter().enumerate() {
        let seq = idx + 1;
        let s = &detail.summary;
        let padded = format!("{seq:0width$}", width = pad_width);
        rows.push_str(&format!(
            "<tr><td><a href=\"raw/{padded}_c.txt\">C</a>&nbsp;<a href=\"raw/{padded}_s.txt\">S</a>&nbsp;<a href=\"raw/{padded}_m.xml\">M</a></td><td>{seq}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>\r\n",
            s.status,
            xml_escape(&s.protocol),
            xml_escape(&s.host),
            xml_escape(&s.path),
            s.body_size,
            xml_escape(&s.content_type),
            xml_escape(s.process_name.as_deref().unwrap_or("")),
        ));
    }

    format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>FluxProxy SAZ Archive</title>\
        <style>body{{font-family:Segoe UI,sans-serif;font-size:12px}}table{{border-collapse:collapse;width:100%}}th,td{{border:1px solid #ccc;padding:4px 6px;text-align:left}}</style></head>\
        <body><table><thead><tr><th>Raw</th><th>#</th><th>Result</th><th>Protocol</th><th>Host</th><th>URL</th><th>Body</th><th>Content-Type</th><th>Process</th></tr></thead><tbody>\r\n{rows}</tbody></table></body></html>"
    )
}


fn format_saz_timer_timestamp(ts: Option<&str>, fallback: &str) -> String {
    if let Some(raw) = ts.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(dt) = parse_timestamp_utc(raw) {
            return dt.to_rfc3339_opts(SecondsFormat::Micros, true);
        }
        return raw.to_string();
    }
    fallback.to_string()
}

fn format_saz_cipher_flag(stats: &SessionTransferStats) -> Option<String> {
    match (
        stats.server_tls_version.as_deref().filter(|s| !s.is_empty()),
        stats.server_tls_cipher.as_deref().filter(|s| !s.is_empty()),
    ) {
        (Some(ver), Some(cipher)) => Some(format!("{ver} ({cipher})")),
        (Some(ver), None) => Some(ver.to_string()),
        (None, Some(cipher)) => Some(cipher.to_string()),
        (None, None) => None,
    }
}

pub(super) fn build_saz_metadata_xml(detail: &SessionDetail, sid: usize) -> String {
    let s = &detail.summary;
    let timings = detail.timings.as_ref();
    let stats = detail.transfer_stats.as_ref();
    let start_dt = parse_timestamp_utc(&s.timestamp).unwrap_or_else(Utc::now);
    let delta =
        TimeDelta::try_milliseconds(s.duration_ms.min(86_400_000 * 365) as i64).unwrap_or_default();
    let end_dt = start_dt.checked_add_signed(delta).unwrap_or(start_dt);

    let start_str = start_dt.to_rfc3339_opts(SecondsFormat::Micros, true);
    let end_str = end_dt.to_rfc3339_opts(SecondsFormat::Micros, true);

    let client_connected = format_saz_timer_timestamp(
        timings.and_then(|t| t.client_connected.as_deref()),
        &start_str,
    );
    let client_begin_request = format_saz_timer_timestamp(
        timings.and_then(|t| t.client_begin_request.as_deref()),
        &start_str,
    );
    let got_request_headers = format_saz_timer_timestamp(
        timings.and_then(|t| t.got_request_headers.as_deref()),
        &start_str,
    );
    let client_done_request = format_saz_timer_timestamp(
        timings.and_then(|t| t.client_done_request.as_deref()),
        &start_str,
    );
    let server_connected = format_saz_timer_timestamp(
        timings.and_then(|t| t.server_connected.as_deref()),
        &start_str,
    );
    let fiddler_begin_request = format_saz_timer_timestamp(
        timings.and_then(|t| t.proxy_begin_request.as_deref()),
        &start_str,
    );
    let server_got_request = format_saz_timer_timestamp(
        timings.and_then(|t| t.server_got_request.as_deref()),
        &start_str,
    );
    let server_begin_response = format_saz_timer_timestamp(
        timings.and_then(|t| t.server_begin_response.as_deref()),
        &end_str,
    );
    let got_response_headers = format_saz_timer_timestamp(
        timings.and_then(|t| t.got_response_headers.as_deref()),
        &end_str,
    );
    let server_done_response = format_saz_timer_timestamp(
        timings.and_then(|t| t.server_done_response.as_deref()),
        &end_str,
    );
    let client_begin_response = format_saz_timer_timestamp(
        timings.and_then(|t| t.client_begin_response.as_deref()),
        &end_str,
    );
    let client_done_response = format_saz_timer_timestamp(
        timings.and_then(|t| t.client_done_response.as_deref()),
        &end_str,
    );

    let dns_time_ms = timings
        .and_then(|t| t.dns_ms)
        .map(|v| v.max(0.0).round() as i64)
        .unwrap_or(0);
    let tcp_connect_time_ms = timings
        .and_then(|t| t.tcp_connect_ms)
        .map(|v| v.max(0.0).round() as i64)
        .unwrap_or(0);
    let https_handshake_time_ms = timings
        .and_then(|t| t.tls_handshake_ms)
        .map(|v| v.max(0.0).round() as i64)
        .unwrap_or(0);
    let clt_reuse = stats.and_then(|st| st.client_conn_reused).unwrap_or(false);
    let srv_reuse = stats.and_then(|st| st.server_conn_reused).unwrap_or(false);

    // Fiddler SessionFlags BitFlags: 0x01 = IsHTTPS, 0x10 = ResponseGeneratedByFiddler, 0x800 = IsWebSocketTunnel
    let mut bit_flags: u32 = 0;
    if s.scheme.eq_ignore_ascii_case("https") || s.scheme.eq_ignore_ascii_case("wss") {
        bit_flags |= 0x01;
    }
    if s.is_mocked {
        bit_flags |= 0x10;
    }
    if !detail.websocket_frames.is_empty()
        || s.scheme.eq_ignore_ascii_case("ws")
        || s.scheme.eq_ignore_ascii_case("wss")
    {
        bit_flags |= 0x800;
    }

    let mut flags: Vec<(String, String)> = Vec::new();

    if let Some(proc_name) = &s.process_name {
        let proc_val = match s.process_pid {
            Some(pid) => format!("{proc_name}:{pid}"),
            None => proc_name.clone(),
        };
        flags.push(("x-processinfo".into(), proc_val));
    } else if let Some(pid) = s.process_pid {
        flags.push(("x-processinfo".into(), format!("unknown:{pid}")));
    }

    let (client_ip_extracted, client_port_extracted) = split_addr_ip_port(&detail.client_addr);
    if let Some(cip) = s.client_ip.as_deref().or(client_ip_extracted.as_deref()) {
        if !cip.is_empty() {
            flags.push(("x-clientip".into(), cip.to_string()));
        }
    }
    if let Some(cport) = client_port_extracted {
        flags.push(("x-clientport".into(), cport));
    }

    if let Some(host_ip) = stats
        .and_then(|st| st.server_ip.as_deref())
        .or(s.server_ip.as_deref())
    {
        if !host_ip.is_empty() {
            flags.push(("x-hostip".into(), host_ip.to_string()));
        }
    }

    if let Some(comment) = &s.comment {
        if !comment.is_empty() {
            flags.push(("ui-comments".into(), comment.clone()));
        }
    }
    if let Some(color) = &s.marked_color {
        if !color.is_empty() {
            flags.push(("ui-color".into(), color.clone()));
            flags.push(("ui-backcolor".into(), color.clone()));
        }
    }
    if let Some(tls) = &detail.tls_version {
        if !tls.is_empty() {
            flags.push(("x-secureprotocol".into(), tls.clone()));
        }
    }
    if let Some(cipher_flag) = stats.and_then(format_saz_cipher_flag) {
        flags.push(("https-server-cipher".into(), cipher_flag));
    }

    // Lossless FluxProxy flags
    flags.push(("x-fluxproxy-protocol".into(), s.protocol.clone()));
    flags.push(("x-fluxproxy-scheme".into(), s.scheme.clone()));
    if s.tls_bypassed {
        flags.push(("x-fluxproxy-tls-bypassed".into(), "true".into()));
    }
    if s.headers_mutated {
        flags.push(("x-fluxproxy-headers-mutated".into(), "true".into()));
    }
    if s.breakpoint_modified {
        flags.push(("x-fluxproxy-bp-modified".into(), "true".into()));
    }
    if let Some(rule_id) = &s.matched_rule_id {
        flags.push(("x-fluxproxy-rule-id".into(), rule_id.clone()));
    }
    if let Some(err) = &s.error {
        flags.push(("x-fluxproxy-error".into(), err.clone()));
    }
    if let Some(remapped) = &s.remapped_to {
        flags.push(("x-fluxproxy-remapped-to".into(), remapped.clone()));
    }
    if !detail.sse_events.is_empty() {
        if let Ok(sse_json) = serde_json::to_string(&detail.sse_events) {
            flags.push(("x-fluxproxy-sse-events".into(), sse_json));
        }
    }
    if let Some(t) = timings {
        if let Ok(t_json) = serde_json::to_string(t) {
            flags.push(("x-fluxproxy-timings".into(), t_json));
        }
    }
    if let Some(st) = stats {
        if let Ok(st_json) = serde_json::to_string(st) {
            flags.push(("x-fluxproxy-transfer-stats".into(), st_json));
        }
    }

    let mut flags_xml = String::new();
    for (k, v) in flags {
        flags_xml.push_str(&format!(
            "    <SessionFlag N=\"{}\" V=\"{}\" />\r\n",
            xml_escape(&k),
            xml_escape(&v)
        ));
    }

    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n\
        <Session SID=\"{sid}\" BitFlags=\"{bit_flags}\">\r\n\
          <SessionTimers ClientConnected=\"{client_connected}\" ClientBeginRequest=\"{client_begin_request}\" GotRequestHeaders=\"{got_request_headers}\" ClientDoneRequest=\"{client_done_request}\" GatewayTime=\"0\" DNSTime=\"{dns_time_ms}\" TCPConnectTime=\"{tcp_connect_time_ms}\" HTTPSHandshakeTime=\"{https_handshake_time_ms}\" ServerConnected=\"{server_connected}\" FiddlerBeginRequest=\"{fiddler_begin_request}\" ServerGotRequest=\"{server_got_request}\" ServerBeginResponse=\"{server_begin_response}\" GotResponseHeaders=\"{got_response_headers}\" ServerDoneResponse=\"{server_done_response}\" ClientBeginResponse=\"{client_begin_response}\" ClientDoneResponse=\"{client_done_response}\" />\r\n\
          <PipeInfo CltReuse=\"{clt_reuse}\" Reused=\"{srv_reuse}\" />\r\n\
          <SessionFlags>\r\n{flags_xml}  </SessionFlags>\r\n\
        </Session>\r\n",
        client_connected = xml_escape(&client_connected),
        client_begin_request = xml_escape(&client_begin_request),
        got_request_headers = xml_escape(&got_request_headers),
        client_done_request = xml_escape(&client_done_request),
        server_connected = xml_escape(&server_connected),
        fiddler_begin_request = xml_escape(&fiddler_begin_request),
        server_got_request = xml_escape(&server_got_request),
        server_begin_response = xml_escape(&server_begin_response),
        got_response_headers = xml_escape(&got_response_headers),
        server_done_response = xml_escape(&server_done_response),
        client_begin_response = xml_escape(&client_begin_response),
        client_done_response = xml_escape(&client_done_response),
    )
}

pub(super) fn build_saz_websocket_log(frames: &[WebSocketFrameRecord]) -> String {
    let mut out = String::new();
    for f in frames {
        let payload_b64 = base64::engine::general_purpose::STANDARD.encode(f.payload_preview.as_bytes());
        out.push_str(&format!(
            "Frame #{}\t{}\t{}\t{}\t{}\t{}\r\n",
            f.index, f.direction, f.opcode, f.byte_length, f.timestamp, payload_b64
        ));
    }
    out
}

pub(super) fn parse_saz_websocket_log(raw: &str) -> Vec<WebSocketFrameRecord> {
    let mut frames = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Frame #") {
            let parts: Vec<&str> = rest.splitn(6, '\t').collect();
            if parts.len() == 6 {
                let index = parts[0].parse::<usize>().unwrap_or(idx + 1);
                let payload_preview = base64::engine::general_purpose::STANDARD
                    .decode(parts[5].trim())
                    .ok()
                    .and_then(|b| String::from_utf8(b).ok())
                    .unwrap_or_else(|| parts[5].to_string());
                frames.push(WebSocketFrameRecord {
                    index,
                    direction: parts[1].to_string(),
                    opcode: parts[2].to_string(),
                    byte_length: parts[3].parse::<usize>().unwrap_or(payload_preview.len()),
                    timestamp: parts[4].to_string(),
                    payload_preview,
                });
            }
        }
    }
    frames
}

#[derive(Default)]
pub(super) struct SazParsedTimers {
    pub(super) client_connected: Option<DateTime<Utc>>,
    pub(super) client_begin_request: Option<DateTime<Utc>>,
    pub(super) got_request_headers: Option<DateTime<Utc>>,
    pub(super) client_done_request: Option<DateTime<Utc>>,
    pub(super) server_connected: Option<DateTime<Utc>>,
    pub(super) fiddler_begin_request: Option<DateTime<Utc>>,
    pub(super) server_got_request: Option<DateTime<Utc>>,
    pub(super) server_begin_response: Option<DateTime<Utc>>,
    pub(super) got_response_headers: Option<DateTime<Utc>>,
    pub(super) server_done_response: Option<DateTime<Utc>>,
    pub(super) client_begin_response: Option<DateTime<Utc>>,
    pub(super) client_done_response: Option<DateTime<Utc>>,
    pub(super) dns_time_ms: Option<f64>,
    pub(super) tcp_connect_time_ms: Option<f64>,
    pub(super) https_handshake_time_ms: Option<f64>,
}

#[derive(Default)]
pub(super) struct ParsedSazMeta {
    pub(super) bit_flags: u32,
    pub(super) start_time: Option<DateTime<Utc>>,
    pub(super) end_time: Option<DateTime<Utc>>,
    pub(super) timers: SazParsedTimers,
    pub(super) clt_reuse: Option<bool>,
    pub(super) srv_reuse: Option<bool>,
    pub(super) flags: BTreeMap<String, String>,
}

fn parse_saz_timer_ms_attr(tag: &str, attr: &str) -> Option<f64> {
    extract_xml_attr(tag, attr)?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.0)
}

fn parse_xml_bool_attr(tag: &str, attr: &str) -> Option<bool> {
    let val = extract_xml_attr(tag, attr)?;
    let trimmed = val.trim();
    if trimmed.eq_ignore_ascii_case("true") {
        Some(true)
    } else if trimmed.eq_ignore_ascii_case("false") {
        Some(false)
    } else {
        None
    }
}

pub(super) fn parse_saz_metadata_xml(xml: &str) -> ParsedSazMeta {
    let mut meta = ParsedSazMeta::default();
    let cleaned = xml.trim_start_matches('\u{feff}');

    if let Some(session_tag) = extract_xml_tag_fragment(cleaned, "Session") {
        if let Some(bf) = extract_xml_attr(session_tag, "BitFlags") {
            meta.bit_flags = bf
                .parse::<u32>()
                .or_else(|_| u32::from_str_radix(bf.trim_start_matches("0x"), 16))
                .unwrap_or(0);
        }
    }

    if let Some(timers_tag) = extract_xml_tag_fragment(cleaned, "SessionTimers") {
        meta.timers.client_connected =
            extract_xml_attr(timers_tag, "ClientConnected").and_then(|v| parse_fiddler_timestamp(&v));
        meta.timers.client_begin_request =
            extract_xml_attr(timers_tag, "ClientBeginRequest").and_then(|v| parse_fiddler_timestamp(&v));
        meta.timers.got_request_headers =
            extract_xml_attr(timers_tag, "GotRequestHeaders").and_then(|v| parse_fiddler_timestamp(&v));
        meta.timers.client_done_request =
            extract_xml_attr(timers_tag, "ClientDoneRequest").and_then(|v| parse_fiddler_timestamp(&v));
        meta.timers.server_connected =
            extract_xml_attr(timers_tag, "ServerConnected").and_then(|v| parse_fiddler_timestamp(&v));
        meta.timers.fiddler_begin_request =
            extract_xml_attr(timers_tag, "FiddlerBeginRequest").and_then(|v| parse_fiddler_timestamp(&v));
        meta.timers.server_got_request =
            extract_xml_attr(timers_tag, "ServerGotRequest").and_then(|v| parse_fiddler_timestamp(&v));
        meta.timers.server_begin_response =
            extract_xml_attr(timers_tag, "ServerBeginResponse").and_then(|v| parse_fiddler_timestamp(&v));
        meta.timers.got_response_headers =
            extract_xml_attr(timers_tag, "GotResponseHeaders").and_then(|v| parse_fiddler_timestamp(&v));
        meta.timers.server_done_response =
            extract_xml_attr(timers_tag, "ServerDoneResponse").and_then(|v| parse_fiddler_timestamp(&v));
        meta.timers.client_begin_response =
            extract_xml_attr(timers_tag, "ClientBeginResponse").and_then(|v| parse_fiddler_timestamp(&v));
        meta.timers.client_done_response =
            extract_xml_attr(timers_tag, "ClientDoneResponse").and_then(|v| parse_fiddler_timestamp(&v));
        meta.timers.dns_time_ms = parse_saz_timer_ms_attr(timers_tag, "DNSTime");
        meta.timers.tcp_connect_time_ms = parse_saz_timer_ms_attr(timers_tag, "TCPConnectTime");
        meta.timers.https_handshake_time_ms = parse_saz_timer_ms_attr(timers_tag, "HTTPSHandshakeTime");

        meta.start_time = meta
            .timers
            .client_begin_request
            .or(meta.timers.client_connected)
            .or(meta.timers.fiddler_begin_request)
            .or(meta.timers.server_connected);

        meta.end_time = meta
            .timers
            .client_done_response
            .or(meta.timers.server_done_response)
            .or(meta.timers.got_response_headers)
            .or(meta.timers.server_begin_response);
    }

    if let Some(pipe_tag) = extract_xml_tag_fragment(cleaned, "PipeInfo") {
        meta.clt_reuse = parse_xml_bool_attr(pipe_tag, "CltReuse");
        meta.srv_reuse = parse_xml_bool_attr(pipe_tag, "Reused");
    }

    let mut search_from = 0usize;
    while let Some((abs_start, abs_end)) =
        find_xml_tag_fragment_bounds(cleaned, search_from, "SessionFlag")
    {
        let tag_slice = &cleaned[abs_start..=abs_end];
        if let (Some(name), Some(val)) = (
            extract_xml_attr(tag_slice, "N"),
            extract_xml_attr(tag_slice, "V"),
        ) {
            meta.flags.insert(name.to_ascii_lowercase(), val);
        }
        search_from = abs_end + 1;
    }

    meta
}

fn saz_delta_ms(start: Option<DateTime<Utc>>, end: Option<DateTime<Utc>>) -> Option<f64> {
    match (start, end) {
        (Some(s), Some(e)) => e
            .signed_duration_since(s)
            .num_microseconds()
            .map(|us| ((us as f64 / 1000.0).max(0.0) * 1000.0).round() / 1000.0),
        _ => None,
    }
}

fn dt_opt_to_rfc3339(dt: Option<DateTime<Utc>>) -> Option<String> {
    dt.map(|v| v.to_rfc3339_opts(SecondsFormat::Micros, true))
}

fn reconstruct_timings_from_saz(meta: &ParsedSazMeta, scheme: &str) -> Option<SessionTimings> {
    let t = &meta.timers;
    let is_https = scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("wss");
    let reused = meta.srv_reuse == Some(true);

    let dns_ms = t
        .dns_time_ms
        .filter(|v| *v > 0.0 || t.server_connected.is_some() || reused);
    let tcp_connect_ms = t
        .tcp_connect_time_ms
        .filter(|v| *v > 0.0 || t.server_connected.is_some() || reused);
    let tls_handshake_ms = t
        .https_handshake_time_ms
        .filter(|v| *v > 0.0 || (is_https && (t.server_connected.is_some() || reused)));

    let client_read_ms = saz_delta_ms(t.client_begin_request, t.client_done_request);
    let send_request_ms = saz_delta_ms(
        t.fiddler_begin_request.or(t.client_done_request),
        t.server_got_request,
    );
    let server_wait_ms = saz_delta_ms(
        t.server_got_request,
        t.server_begin_response.or(t.got_response_headers),
    );
    let content_download_ms = saz_delta_ms(
        t.server_begin_response.or(t.got_response_headers),
        t.server_done_response,
    );
    let client_send_ms = saz_delta_ms(t.client_begin_response, t.client_done_response);
    let overall_elapsed_ms = saz_delta_ms(meta.start_time, meta.end_time);

    let net_parts = [
        dns_ms,
        tcp_connect_ms,
        tls_handshake_ms,
        send_request_ms,
        server_wait_ms,
        content_download_ms,
    ];
    let net_elapsed_ms = net_parts
        .iter()
        .any(Option::is_some)
        .then(|| ((net_parts.into_iter().flatten().sum::<f64>()) * 1000.0).round() / 1000.0);

    let has_any = t.client_connected.is_some()
        || t.client_begin_request.is_some()
        || t.server_connected.is_some()
        || t.server_got_request.is_some()
        || t.client_done_response.is_some()
        || dns_ms.is_some()
        || tcp_connect_ms.is_some()
        || tls_handshake_ms.is_some()
        || overall_elapsed_ms.is_some();

    if !has_any {
        return None;
    }

    Some(SessionTimings {
        client_connected: dt_opt_to_rfc3339(t.client_connected),
        client_begin_request: dt_opt_to_rfc3339(t.client_begin_request),
        got_request_headers: dt_opt_to_rfc3339(t.got_request_headers),
        client_done_request: dt_opt_to_rfc3339(t.client_done_request),
        proxy_begin_request: dt_opt_to_rfc3339(t.fiddler_begin_request),
        server_connected: dt_opt_to_rfc3339(t.server_connected),
        server_got_request: dt_opt_to_rfc3339(t.server_got_request),
        server_begin_response: dt_opt_to_rfc3339(t.server_begin_response),
        got_response_headers: dt_opt_to_rfc3339(t.got_response_headers),
        server_done_response: dt_opt_to_rfc3339(t.server_done_response),
        client_begin_response: dt_opt_to_rfc3339(t.client_begin_response),
        client_done_response: dt_opt_to_rfc3339(t.client_done_response),
        client_read_ms,
        dns_ms,
        tcp_connect_ms,
        tls_handshake_ms,
        send_request_ms,
        server_wait_ms,
        content_download_ms,
        client_send_ms,
        overall_elapsed_ms,
        net_elapsed_ms,
        ..Default::default()
    })
}

fn parse_saz_cipher_flag(raw: &str) -> (Option<String>, Option<String>) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return (None, None);
    }
    if let Some((ver, rest)) = trimmed.split_once(" (") {
        if let Some(cipher) = rest.strip_suffix(')') {
            let v = ver.trim();
            let c = cipher.trim();
            return (
                (!v.is_empty()).then(|| v.to_string()),
                (!c.is_empty()).then(|| c.to_string()),
            );
        }
    }
    if trimmed.to_ascii_uppercase().starts_with("TLS") && !trimmed.contains('_') {
        (Some(trimmed.to_string()), None)
    } else {
        (None, Some(trimmed.to_string()))
    }
}

#[allow(clippy::too_many_arguments)]
fn reconstruct_transfer_stats_from_saz(
    meta: &ParsedSazMeta,
    client_bytes_len: usize,
    server_bytes_len: usize,
    raw_req_body_len: usize,
    decoded_req_body_len: usize,
    raw_resp_body_len: usize,
    decoded_resp_body_len: usize,
    response_headers: &[HeaderPair],
    req_http_ver: &str,
    resp_http_ver: &str,
) -> Option<SessionTransferStats> {
    let server_ip = meta
        .flags
        .get("x-hostip")
        .map(|s| s.trim_start_matches("::ffff:").trim().to_string())
        .filter(|s| !s.is_empty());

    let (parsed_tls_ver, parsed_tls_cipher) = meta
        .flags
        .get("https-server-cipher")
        .map(|raw| parse_saz_cipher_flag(raw))
        .unwrap_or((None, None));
    let server_tls_version = parsed_tls_ver.or_else(|| {
        meta.flags
            .get("x-secureprotocol")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    });

    let response_content_encoding = find_header_value(response_headers, "content-encoding")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let request_headers_bytes =
        (client_bytes_len > 0).then(|| client_bytes_len.saturating_sub(raw_req_body_len));
    let response_headers_bytes =
        (server_bytes_len > 0).then(|| server_bytes_len.saturating_sub(raw_resp_body_len));
    let request_wire_body_bytes = (client_bytes_len > 0).then_some(raw_req_body_len);
    let request_body_bytes = (client_bytes_len > 0).then_some(decoded_req_body_len);
    let response_wire_body_bytes = (server_bytes_len > 0).then_some(raw_resp_body_len);
    let response_body_bytes = (server_bytes_len > 0).then_some(decoded_resp_body_len);

    let client_http_version = (!req_http_ver.trim().is_empty()).then(|| req_http_ver.trim().to_string());
    let server_http_version = (!resp_http_ver.trim().is_empty()).then(|| resp_http_ver.trim().to_string());

    let has_any = server_ip.is_some()
        || server_tls_version.is_some()
        || parsed_tls_cipher.is_some()
        || meta.clt_reuse.is_some()
        || meta.srv_reuse.is_some()
        || request_headers_bytes.is_some()
        || response_headers_bytes.is_some()
        || response_content_encoding.is_some();

    if !has_any {
        return None;
    }

    Some(SessionTransferStats {
        request_headers_bytes,
        request_body_bytes,
        request_wire_body_bytes,
        response_headers_bytes,
        response_body_bytes,
        response_wire_body_bytes,
        response_content_encoding,
        client_conn_reused: meta.clt_reuse,
        client_http_version,
        server_ip,
        server_conn_reused: meta.srv_reuse,
        server_http_version,
        server_tls_version,
        server_tls_cipher: parsed_tls_cipher,
        ..Default::default()
    })
}

pub(super) fn build_session_from_saz_parts(
    id: u64,
    client_bytes: &[u8],
    server_bytes: &[u8],
    meta_xml: Option<&str>,
    ws_text: Option<&str>,
    cumulative_http_bytes: &mut u64,
) -> Result<SessionDetail, ProxyError> {
    let meta = meta_xml.map(parse_saz_metadata_xml).unwrap_or_default();

    let (req_start_line, request_headers, raw_req_body) = split_raw_http_message(client_bytes);
    let (resp_status_line, response_headers, raw_resp_body) = split_raw_http_message(server_bytes);

    let decoded_req_body =
        decode_http_body(raw_req_body, &request_headers, cumulative_http_bytes)?;
    let decoded_resp_body =
        decode_http_body(raw_resp_body, &response_headers, cumulative_http_bytes)?;

    let (method, raw_target, req_http_ver) = parse_http_request_line(&req_start_line);
    let (resp_http_ver, status) = parse_http_status_line(&resp_status_line);

    let is_https_flag = (meta.bit_flags & 0x01) != 0;
    let is_ws_flag = (meta.bit_flags & 0x800) != 0
        || find_header_value(&request_headers, "upgrade")
            .is_some_and(|u| u.eq_ignore_ascii_case("websocket"));

    let default_scheme = if let Some(s) = meta.flags.get("x-fluxproxy-scheme") {
        s.clone()
    } else if is_ws_flag {
        if is_https_flag {
            "wss".to_string()
        } else {
            "ws".to_string()
        }
    } else if is_https_flag || method.eq_ignore_ascii_case("CONNECT") {
        "https".to_string()
    } else {
        "http".to_string()
    };

    let (scheme, host, path, url) =
        reconstruct_saz_url(&method, &raw_target, &default_scheme, &request_headers);

    let protocol = meta
        .flags
        .get("x-fluxproxy-protocol")
        .cloned()
        .unwrap_or_else(|| {
            let ver = if !resp_http_ver.is_empty() {
                &resp_http_ver
            } else {
                &req_http_ver
            };
            har_http_version_to_protocol(ver, &scheme, is_ws_flag)
        });

    let content_type = find_header_value(&response_headers, "content-type")
        .unwrap_or("")
        .to_string();

    let start_dt = meta.start_time.unwrap_or_else(Utc::now);
    let duration_ms = match (meta.start_time, meta.end_time) {
        (Some(st), Some(et)) => (et - st).num_milliseconds().max(0) as u64,
        _ => 0,
    };
    let timestamp = start_dt.to_rfc3339_opts(SecondsFormat::Millis, true);

    let (process_name, process_pid) = meta
        .flags
        .get("x-processinfo")
        .map(|v| parse_fiddler_process_info(v))
        .unwrap_or((None, None));

    let client_ip = meta
        .flags
        .get("x-clientip")
        .map(|ip| ip.trim_start_matches("::ffff:").to_string())
        .filter(|ip| !ip.is_empty());

    let client_addr = match (
        client_ip.as_deref(),
        meta.flags.get("x-clientport").map(String::as_str),
    ) {
        (Some(ip), Some(port)) if !port.is_empty() => format!("{ip}:{port}"),
        (Some(ip), _) => ip.to_string(),
        _ => "saz-import".to_string(),
    };

    let comment = meta
        .flags
        .get("ui-comments")
        .cloned()
        .filter(|s| !s.trim().is_empty());

    let marked_color = meta
        .flags
        .get("ui-color")
        .or_else(|| meta.flags.get("ui-backcolor"))
        .map(|c| normalize_fiddler_color(c))
        .filter(|s| !s.is_empty());

    let tls_version = meta
        .flags
        .get("x-secureprotocol")
        .or_else(|| meta.flags.get("https-server-cipher"))
        .cloned()
        .filter(|s| !s.is_empty());

    let is_mocked = (meta.bit_flags & 0x10) != 0
        || meta
            .flags
            .get("x-fluxproxy-mocked")
            .is_some_and(|v| v == "true");

    let request_body_base64 = if decoded_req_body.is_empty() {
        String::new()
    } else {
        base64::engine::general_purpose::STANDARD.encode(&decoded_req_body)
    };
    let request_body_text = if decoded_req_body.is_empty() {
        None
    } else {
        std::str::from_utf8(&decoded_req_body)
            .ok()
            .map(str::to_owned)
    };

    let response_body_base64 = if decoded_resp_body.is_empty() {
        String::new()
    } else {
        base64::engine::general_purpose::STANDARD.encode(&decoded_resp_body)
    };
    let response_body_text = if decoded_resp_body.is_empty() {
        None
    } else {
        std::str::from_utf8(&decoded_resp_body)
            .ok()
            .map(str::to_owned)
    };

    let websocket_frames = ws_text.map(parse_saz_websocket_log).unwrap_or_default();
    let sse_events = meta
        .flags
        .get("x-fluxproxy-sse-events")
        .and_then(|raw| serde_json::from_str::<Vec<SseEventRecord>>(raw).ok())
        .filter(|events| !events.is_empty())
        .unwrap_or_else(|| {
            if content_type
                .to_ascii_lowercase()
                .contains("text/event-stream")
                && !decoded_resp_body.is_empty()
            {
                crate::proxy::server::parse_sse_events_from_bytes(&decoded_resp_body, duration_ms)
            } else {
                Vec::new()
            }
        });

    let timings = meta
        .flags
        .get("x-fluxproxy-timings")
        .and_then(|raw| serde_json::from_str::<SessionTimings>(raw).ok())
        .or_else(|| reconstruct_timings_from_saz(&meta, &scheme));
    let transfer_stats = meta
        .flags
        .get("x-fluxproxy-transfer-stats")
        .and_then(|raw| serde_json::from_str::<SessionTransferStats>(raw).ok())
        .or_else(|| {
            reconstruct_transfer_stats_from_saz(
                &meta,
                client_bytes.len(),
                server_bytes.len(),
                raw_req_body.len(),
                decoded_req_body.len(),
                raw_resp_body.len(),
                decoded_resp_body.len(),
                &response_headers,
                &req_http_ver,
                &resp_http_ver,
            )
        });

    let mut summary = SessionSummary {
        id,
        status,
        protocol,
        scheme,
        method,
        host,
        path,
        url,
        content_type,
        body_size: decoded_resp_body.len(),
        duration_ms,
        timestamp,
        is_mocked,
        matched_rule_id: meta.flags.get("x-fluxproxy-rule-id").cloned(),
        error: meta.flags.get("x-fluxproxy-error").cloned(),
        process_name,
        process_pid,
        tls_bypassed: meta
            .flags
            .get("x-fluxproxy-tls-bypassed")
            .is_some_and(|v| v == "true"),
        headers_mutated: meta
            .flags
            .get("x-fluxproxy-headers-mutated")
            .is_some_and(|v| v == "true"),
        breakpoint_paused: None,
        breakpoint_modified: meta
            .flags
            .get("x-fluxproxy-bp-modified")
            .is_some_and(|v| v == "true"),
        comment,
        marked_color,
        client_ip,
        remapped_to: meta.flags.get("x-fluxproxy-remapped-to").cloned(),
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
    summary.apply_telemetry(timings.as_ref(), transfer_stats.as_ref());

    Ok(SessionDetail {
        summary,
        request_headers,
        response_headers,
        request_body_base64,
        response_body_base64,
        request_body_text,
        response_body_text,
        tls_version,
        client_addr,
        websocket_frames,
        sse_events,
        body_offloaded: false,
        request_body_offloaded: false,
        timings,
        transfer_stats,
    })
}

// ============================================================================
// HTTP Wire Parsing, Dechunking & Decompression Utilities
// ============================================================================

pub(super) fn reconstruct_saz_url(
    method: &str,
    raw_target: &str,
    default_scheme: &str,
    headers: &[HeaderPair],
) -> (String, String, String, String) {
    let host_hdr = find_header_value(headers, "host").unwrap_or("").trim();

    if method.eq_ignore_ascii_case("CONNECT") {
        let host = if !raw_target.is_empty() {
            raw_target.to_string()
        } else {
            host_hdr.to_string()
        };
        return (
            "https".to_string(),
            host.clone(),
            "/".to_string(),
            format!("https://{host}/"),
        );
    }

    if let Some((sch, rest)) = raw_target.split_once("://") {
        let scheme = sch.to_ascii_lowercase();
        let (host, path) = parse_authority_and_path(rest);
        let final_host = if !host.is_empty() {
            host
        } else {
            host_hdr.to_string()
        };
        let url = format!("{scheme}://{final_host}{path}");
        return (scheme, final_host, path, url);
    }

    let scheme = default_scheme.to_ascii_lowercase();
    let path = if raw_target.starts_with('/') {
        raw_target.to_string()
    } else if raw_target.is_empty() {
        "/".to_string()
    } else {
        format!("/{raw_target}")
    };
    let host = if !host_hdr.is_empty() {
        host_hdr.to_string()
    } else {
        "localhost".to_string()
    };
    let url = format!("{scheme}://{host}{path}");
    (scheme, host, path, url)
}

// ============================================================================
// XML, Timestamp, Cookie & URL Helper Functions
// ============================================================================

pub(super) fn decode_xml_bytes(buf: &[u8]) -> String {
    if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&buf[3..]).into_owned()
    } else if buf.starts_with(&[0xFF, 0xFE]) {
        let u16s: Vec<u16> = buf[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else if buf.starts_with(&[0xFE, 0xFF]) {
        let u16s: Vec<u16> = buf[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(buf).into_owned()
    }
}

pub(super) fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

pub(super) fn xml_unescape(input: &str) -> String {
    input
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#xD;", "\r")
        .replace("&#xA;", "\n")
        .replace("&#13;", "\r")
        .replace("&#10;", "\n")
        .replace("&amp;", "&")
}

pub(super) fn is_xml_tag_name_delimiter(b: u8) -> bool {
    b.is_ascii_whitespace() || b == b'/' || b == b'>'
}

pub(super) fn find_xml_tag_end_respecting_quotes(s: &str) -> Option<usize> {
    let mut in_quote: Option<char> = None;
    for (idx, ch) in s.char_indices() {
        match in_quote {
            Some(q) if ch == q => in_quote = None,
            Some(_) => {}
            None if ch == '"' || ch == '\'' => in_quote = Some(ch),
            None if ch == '>' => return Some(idx),
            None => {}
        }
    }
    None
}

pub(super) fn find_xml_tag_fragment_bounds(
    xml: &str,
    mut search_from: usize,
    tag_name: &str,
) -> Option<(usize, usize)> {
    let needle = format!("<{tag_name}");
    while search_from < xml.len() {
        let rel_start = xml[search_from..].find(&needle)?;
        let abs_start = search_from + rel_start;
        let after_name = abs_start + needle.len();
        if let Some(&delim) = xml.as_bytes().get(after_name) {
            if is_xml_tag_name_delimiter(delim) {
                let rel_end = find_xml_tag_end_respecting_quotes(&xml[abs_start..])?;
                return Some((abs_start, abs_start + rel_end));
            }
        }
        search_from = after_name;
    }
    None
}

pub(super) fn extract_xml_tag_fragment<'a>(xml: &'a str, tag_name: &str) -> Option<&'a str> {
    let (start, end) = find_xml_tag_fragment_bounds(xml, 0, tag_name)?;
    Some(&xml[start..=end])
}

pub(super) fn extract_xml_attr(tag: &str, attr_name: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let mut i = 0usize;
    let mut in_quote: Option<u8> = None;

    // Skip tag name after leading `<tagName`
    while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
        i += 1;
    }

    while i < bytes.len() {
        let b = bytes[i];
        if let Some(q) = in_quote {
            if b == q {
                in_quote = None;
            }
            i += 1;
            continue;
        }
        if b == b'"' || b == b'\'' {
            in_quote = Some(b);
            i += 1;
            continue;
        }
        if b.is_ascii_whitespace() || b == b'/' || b == b'>' {
            i += 1;
            continue;
        }

        // Scan attribute name
        let name_start = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && bytes[i] != b'='
            && bytes[i] != b'>'
            && bytes[i] != b'/'
        {
            i += 1;
        }
        let name = &tag[name_start..i];
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let q = bytes[i];
                let val_start = i + 1;
                let rel_end = tag.as_bytes()[val_start..].iter().position(|&c| c == q)?;
                let val_end = val_start + rel_end;
                if name == attr_name {
                    return Some(xml_unescape(&tag[val_start..val_end]));
                }
                i = val_end + 1;
                continue;
            }
        }
    }
    None
}

pub(super) fn parse_fiddler_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with("0001-01-01") {
        return None;
    }
    parse_timestamp_utc(trimmed)
}

pub(super) fn parse_timestamp_utc(raw: &str) -> Option<DateTime<Utc>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.with_timezone(&Utc));
    }
    if let Ok(dt) = DateTime::parse_from_rfc2822(trimmed) {
        return Some(dt.with_timezone(&Utc));
    }
    None
}

pub(super) fn normalize_iso8601_timestamp(raw: &str) -> String {
    if let Some(dt) = parse_timestamp_utc(raw) {
        return dt.to_rfc3339_opts(SecondsFormat::Millis, true);
    }
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(super) fn parse_fiddler_process_info(raw: &str) -> (Option<String>, Option<u32>) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return (None, None);
    }
    if let Some((name, pid_str)) = trimmed.rsplit_once(':') {
        let clean_name = name.trim();
        let pid = pid_str.trim().parse::<u32>().ok();
        return (
            if clean_name.is_empty() {
                None
            } else {
                Some(clean_name.to_string())
            },
            pid,
        );
    }
    (Some(trimmed.to_string()), None)
}

pub(super) fn normalize_fiddler_color(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    match lower.as_str() {
        "red" | "yellow" | "green" | "blue" | "purple" | "orange" => lower,
        s if s.contains("red") || s.contains("crimson") || s.contains("pink") => "red".into(),
        s if s.contains("green") || s.contains("lime") => "green".into(),
        s if s.contains("yellow") || s.contains("gold") => "yellow".into(),
        s if s.contains("blue") || s.contains("cyan") || s.contains("aqua") => "blue".into(),
        s if s.contains("purple") || s.contains("violet") || s.contains("magenta") => {
            "purple".into()
        }
        s if s.contains("orange") || s.contains("amber") => "orange".into(),
        _ => raw.trim().to_string(),
    }
}

pub(super) fn split_addr_ip_port(addr: &str) -> (Option<String>, Option<String>) {
    let trimmed = addr.trim();
    if trimmed.is_empty() {
        return (None, None);
    }
    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some((ipv6, port_part)) = rest.split_once(']') {
            let port = port_part.strip_prefix(':').map(str::to_string);
            return (Some(ipv6.to_string()), port);
        }
    }
    if let Some((ip, port)) = trimmed.rsplit_once(':') {
        if !ip.contains(':') && port.chars().all(|c| c.is_ascii_digit()) {
            return (Some(ip.to_string()), Some(port.to_string()));
        }
    }
    (None, None)
}
