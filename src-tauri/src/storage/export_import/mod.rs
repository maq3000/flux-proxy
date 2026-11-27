pub mod har;
pub mod raw;
pub mod sanitize;
pub mod saz;

use std::fs::File;
use std::io::{BufWriter, Cursor, Read};
use std::path::Path;

use crate::models::{ProxyError, SessionDetail};

pub use har::{
    deserialize_har_1_2, deserialize_json_or_har, serialize_har_1_2, serialize_json_archive,
    FluxProxyHarExt, HarCache, HarContent, HarCookie, HarCreator, HarEntry, HarLog, HarNameValue,
    HarPage, HarPageTimings, HarPostData, HarPostParam, HarRequest, HarResponse, HarRoot,
    HarStreamWriter, HarTimings, HarWebSocketMessage, JsonStreamWriter,
};
pub use raw::{
    decode_detail_body_bytes, serialize_full_raw_http, write_raw_bytes_to_file, RawHttpStreamWriter,
};
pub use sanitize::{sanitize_sessions, CompiledSanitizationOptions};
pub use saz::{
    read_saz_file, read_saz_from_reader, write_saz_file, write_saz_to_writer, SazStreamWriter,
};

/// Maximum allowed archive/JSON import file size on disk or in memory (256 MiB).
pub const MAX_IMPORT_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// Maximum number of ZIP directory entries permitted inside an imported `.saz` archive.
pub const MAX_SAZ_ARCHIVE_ENTRIES: usize = 50_000;

/// Maximum uncompressed size allowed for a single `.saz` ZIP entry or decompressed wire payload (64 MiB).
pub const MAX_SAZ_ENTRY_BYTES: u64 = 64 * 1024 * 1024;

/// Maximum cumulative uncompressed bytes across all entries in a `.saz` ZIP archive (512 MiB).
pub const MAX_SAZ_TOTAL_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;

/// Maximum number of stacked `Content-Encoding` layers decoded per HTTP message during `.saz` import.
pub const MAX_SAZ_CONTENT_ENCODING_LAYERS: usize = 2;

/// Streaming exporter writing one hydrated/sanitized `SessionDetail` at a time to disk.
pub enum StreamingSessionExporter {
    Saz(Box<SazStreamWriter<BufWriter<File>>>),
    Har(HarStreamWriter<BufWriter<File>>),
    Json(JsonStreamWriter<BufWriter<File>>),
    Raw(RawHttpStreamWriter<BufWriter<File>>),
}

impl StreamingSessionExporter {
    pub fn create(path: &Path, format: &str, estimated_count: usize) -> Result<Self, ProxyError> {
        let fmt = normalize_export_format(format, path);
        match fmt.as_str() {
            "saz" => {
                ensure_parent_dir(path)?;
                let file = BufWriter::new(File::create(path)?);
                Ok(Self::Saz(Box::new(SazStreamWriter::new(
                    file,
                    estimated_count,
                )?)))
            }
            "har" => {
                ensure_parent_dir(path)?;
                let file = BufWriter::new(File::create(path)?);
                Ok(Self::Har(HarStreamWriter::new(file)))
            }
            "json" => {
                ensure_parent_dir(path)?;
                let file = BufWriter::new(File::create(path)?);
                Ok(Self::Json(JsonStreamWriter::new(file)?))
            }
            "raw" | "txt" => {
                ensure_parent_dir(path)?;
                let file = BufWriter::new(File::create(path)?);
                Ok(Self::Raw(RawHttpStreamWriter::new(file)))
            }
            other => Err(ProxyError::Custom(format!(
                "Неподдерживаемый формат экспорта: '{other}' (ожидается har, saz, json или txt)"
            ))),
        }
    }

    pub fn write_session(&mut self, detail: &SessionDetail) -> Result<(), ProxyError> {
        match self {
            Self::Saz(w) => w.write_session(detail),
            Self::Har(w) => w.write_session(detail),
            Self::Json(w) => w.write_session(detail),
            Self::Raw(w) => w.write_session(detail),
        }
    }

    pub fn finish(self) -> Result<usize, ProxyError> {
        match self {
            Self::Saz(w) => (*w).finish(),
            Self::Har(w) => w.finish(),
            Self::Json(w) => w.finish(),
            Self::Raw(w) => w.finish(),
        }
    }
}

/// Unified exporter supporting `"har"`, `"saz"`, `"json"`, and `"raw"` / `"txt"` formats.
pub fn export_sessions_to_path(
    sessions: &[SessionDetail],
    format: &str,
    path: &Path,
) -> Result<usize, ProxyError> {
    let mut exporter = StreamingSessionExporter::create(path, format, sessions.len())?;
    for detail in sessions {
        exporter.write_session(detail)?;
    }
    exporter.finish()
}

/// Reads up to `max_bytes` from `path` after verifying file metadata length to avoid unbounded allocation.
pub(crate) fn read_bounded_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, ProxyError> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > max_bytes {
        return Err(ProxyError::Custom(format!(
            "Размер файла {} ({} байт) превышает лимит импорта ({max_bytes} байт)",
            path.display(),
            meta.len()
        )));
    }
    let file = File::open(path)?;
    let initial_cap = (meta.len() as usize).min(1024 * 1024);
    let mut bytes = Vec::with_capacity(initial_cap);
    file.take(max_bytes.saturating_add(1)).read_to_end(&mut bytes)?;
    if (bytes.len() as u64) > max_bytes {
        return Err(ProxyError::Custom(format!(
            "Размер файла {} превышает лимит импорта ({max_bytes} байт)",
            path.display()
        )));
    }
    Ok(bytes)
}

/// Unified importer reading `.saz`, `.har`, or `.json` from disk (auto-detecting ZIP magic & JSON shape).
pub fn import_sessions_from_path(path: &Path) -> Result<Vec<SessionDetail>, ProxyError> {
    if !path.exists() {
        return Err(ProxyError::Custom(format!(
            "Файл не найден: {}",
            path.display()
        )));
    }
    let bytes = read_bounded_file(path, MAX_IMPORT_FILE_BYTES)?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    import_sessions_from_bytes(file_name, &bytes)
}

/// Unified importer reading `.saz`, `.har`, or `.json` from in-memory bytes.
pub fn import_sessions_from_bytes(
    file_name: &str,
    bytes: &[u8],
) -> Result<Vec<SessionDetail>, ProxyError> {
    if bytes.is_empty() {
        return Err(ProxyError::Custom("Импортируемый файл пуст".into()));
    }
    if (bytes.len() as u64) > MAX_IMPORT_FILE_BYTES {
        return Err(ProxyError::Custom(format!(
            "Размер файла ({} байт) превышает допустимый лимит импорта ({MAX_IMPORT_FILE_BYTES} байт)",
            bytes.len()
        )));
    }

    let lower_name = file_name.to_ascii_lowercase();
    let is_zip_magic = bytes.len() >= 4 && &bytes[0..4] == b"PK\x03\x04";

    if is_zip_magic || lower_name.ends_with(".saz") || lower_name.ends_with(".zip") {
        return read_saz_from_reader(Cursor::new(bytes));
    }

    let text = std::str::from_utf8(bytes).map_err(|e| {
        ProxyError::Custom(format!(
            "Ожидался UTF-8 текст (.har/.json) или ZIP-архив Fiddler (.saz): {e}"
        ))
    })?;
    deserialize_json_or_har(text)
}


fn normalize_export_format(format: &str, path: &Path) -> String {
    let cleaned = format.trim().trim_start_matches('.').to_ascii_lowercase();
    if matches!(cleaned.as_str(), "har" | "saz" | "json" | "raw" | "txt") {
        return cleaned;
    }
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext_lower = ext.to_ascii_lowercase();
        if matches!(ext_lower.as_str(), "har" | "saz" | "json" | "txt") {
            return ext_lower;
        }
    }
    cleaned
}

fn ensure_parent_dir(path: &Path) -> Result<(), ProxyError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)?;
        }
    }
    Ok(())
}


// ============================================================================
// Unit Tests (HAR 1.2 Roundtrip, Fiddler Classic SAZ Roundtrip & Wire Decode)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::har::split_url_components;
    use super::raw::{
        build_raw_http_request_bytes, build_raw_http_response_bytes, decode_chunked,
        decode_http_body, decode_http_body_with_limit, find_header_value,
        is_matching_compressed_magic,
    };
    use super::saz::{
        decode_xml_bytes, extract_xml_attr, extract_xml_tag_fragment, parse_saz_metadata_xml,
        read_bounded_saz_entry, reconstruct_saz_url,
    };
    use super::*;
    use base64::Engine as _;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipArchive, ZipWriter};
    use crate::models::{
        HeaderPair, SanitizationOptions, SessionSummary, SessionTimings, SessionTransferStats,
        SseEventRecord, WebSocketFrameRecord,
    };

    fn unique_temp_path(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "fluxproxy_exp_imp_{}_{nanos}_{name}",
            std::process::id()
        ))
    }

    fn sample_sessions() -> Vec<SessionDetail> {
        let req_json = br#"{"email":"engineer@fluxproxy.dev","otp":"481516"}"#;
        let resp_json = br#"{"token":"jwt-xyz","roles":["admin","debugger"]}"#;
        // 8-byte PNG signature + IHDR stub (non-UTF8 binary)
        let png_bytes: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF];

        vec![
            SessionDetail {
                summary: SessionSummary {
                    id: 101,
                    status: 200,
                    protocol: "HTTPS/2".into(),
                    scheme: "https".into(),
                    method: "POST".into(),
                    host: "auth.fluxproxy.dev".into(),
                    path: "/v1/login?redirect=%2Fdashboard&lang=ru".into(),
                    url: "https://auth.fluxproxy.dev/v1/login?redirect=%2Fdashboard&lang=ru"
                        .into(),
                    content_type: "application/json; charset=utf-8".into(),
                    body_size: resp_json.len(),
                    duration_ms: 84,
                    timestamp: "2026-11-09T09:15:30.250Z".into(),
                    is_mocked: false,
                    matched_rule_id: None,
                    error: None,
                    process_name: Some("chrome.exe".into()),
                    process_pid: Some(9042),
                    tls_bypassed: false,
                    headers_mutated: true,
                    breakpoint_paused: None,
                    breakpoint_modified: false,
                    comment: Some("Auth login checkpoint".into()),
                    marked_color: Some("green".into()),
                    client_ip: Some("127.0.0.1".into()),
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
                },
                request_headers: vec![
                    HeaderPair::new("Host", "auth.fluxproxy.dev"),
                    HeaderPair::new("Content-Type", "application/json"),
                    HeaderPair::new("Cookie", "device_id=dev-77; theme=dark"),
                ],
                response_headers: vec![
                    HeaderPair::new("Content-Type", "application/json; charset=utf-8"),
                    HeaderPair::new(
                        "Set-Cookie",
                        "sid=abc123; Path=/; Domain=fluxproxy.dev; Secure; HttpOnly",
                    ),
                ],
                request_body_base64: base64::engine::general_purpose::STANDARD.encode(req_json),
                response_body_base64: base64::engine::general_purpose::STANDARD.encode(resp_json),
                request_body_text: Some(String::from_utf8_lossy(req_json).into_owned()),
                response_body_text: Some(String::from_utf8_lossy(resp_json).into_owned()),
                tls_version: Some("TLSv1.3".into()),
                client_addr: "127.0.0.1:54321".into(),
                websocket_frames: Vec::new(),
                sse_events: Vec::new(),
                body_offloaded: false,
                request_body_offloaded: false,
                timings: None,
                transfer_stats: None,
            },
            SessionDetail {
                summary: SessionSummary {
                    id: 102,
                    status: 200,
                    protocol: "HTTPS/1.1".into(),
                    scheme: "https".into(),
                    method: "GET".into(),
                    host: "cdn.fluxproxy.dev".into(),
                    path: "/assets/logo.png".into(),
                    url: "https://cdn.fluxproxy.dev/assets/logo.png".into(),
                    content_type: "image/png".into(),
                    body_size: png_bytes.len(),
                    duration_ms: 19,
                    timestamp: "2026-11-09T09:15:31.000Z".into(),
                    is_mocked: true,
                    matched_rule_id: Some("rule-logo".into()),
                    error: None,
                    process_name: Some("msedge.exe".into()),
                    process_pid: Some(3310),
                    tls_bypassed: false,
                    headers_mutated: false,
                    breakpoint_paused: None,
                    breakpoint_modified: false,
                    comment: None,
                    marked_color: Some("blue".into()),
                    client_ip: Some("127.0.0.1".into()),
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
                },
                request_headers: vec![HeaderPair::new("Host", "cdn.fluxproxy.dev")],
                response_headers: vec![HeaderPair::new("Content-Type", "image/png")],
                request_body_base64: String::new(),
                response_body_base64: base64::engine::general_purpose::STANDARD.encode(png_bytes),
                request_body_text: None,
                response_body_text: None,
                tls_version: Some("TLSv1.3".into()),
                client_addr: "127.0.0.1:54322".into(),
                websocket_frames: vec![WebSocketFrameRecord {
                    index: 1,
                    direction: "outbound".into(),
                    opcode: "text".into(),
                    payload_preview: "{\"ping\":1}".into(),
                    byte_length: 10,
                    timestamp: "2026-11-09T09:15:31.010Z".into(),
                    injected: false,
                }],
                sse_events: Vec::new(),
                body_offloaded: false,
                request_body_offloaded: false,
                timings: None,
                transfer_stats: None,
            },
        ]
    }

    #[test]
    fn har_1_2_roundtrip_and_chrome_devtools_schema_compliance() {
        let originals = sample_sessions();
        let har_json = serialize_har_1_2(&originals).expect("serialize HAR 1.2");

        // Verify exact Chrome DevTools HAR 1.2 required keys & casing
        let raw_val: serde_json::Value = serde_json::from_str(&har_json).expect("valid JSON");
        assert_eq!(raw_val["log"]["version"], "1.2");
        assert_eq!(raw_val["log"]["creator"]["name"], "FluxProxy");
        assert_eq!(raw_val["log"]["pages"][0]["id"], "page_1");

        let e0 = &raw_val["log"]["entries"][0];
        assert_eq!(e0["pageref"], "page_1");
        assert_eq!(e0["startedDateTime"], "2026-11-09T09:15:30.250Z");
        assert_eq!(e0["time"], 84.0);
        assert_eq!(e0["request"]["httpVersion"], "HTTP/2.0");
        assert_eq!(e0["request"]["queryString"][0]["name"], "redirect");
        assert_eq!(e0["request"]["queryString"][0]["value"], "/dashboard");
        assert_eq!(e0["request"]["cookies"][0]["name"], "device_id");
        assert_eq!(e0["response"]["cookies"][0]["name"], "sid");
        assert_eq!(e0["response"]["cookies"][0]["httpOnly"], true);
        assert!(e0["response"]["redirectURL"].is_string());
        assert!(e0["timings"]["wait"].as_f64().unwrap() >= 0.0);

        // Binary PNG entry must carry `"encoding": "base64"` for Chrome DevTools
        let e1 = &raw_val["log"]["entries"][1];
        assert_eq!(e1["response"]["content"]["encoding"], "base64");
        assert_eq!(e1["_webSocketMessages"][0]["type"], "send");

        // Roundtrip back into Vec<SessionDetail>
        let restored = deserialize_har_1_2(&har_json).expect("deserialize HAR 1.2");
        assert_eq!(restored.len(), 2);

        assert_eq!(restored[0].summary.method, "POST");
        assert_eq!(restored[0].summary.status, 200);
        assert_eq!(restored[0].summary.protocol, "HTTPS/2");
        assert_eq!(restored[0].summary.duration_ms, 84);
        assert_eq!(
            restored[0].request_body_text.as_deref(),
            originals[0].request_body_text.as_deref()
        );
        assert_eq!(
            restored[0].response_body_text.as_deref(),
            originals[0].response_body_text.as_deref()
        );
        assert_eq!(
            restored[0].summary.comment.as_deref(),
            Some("Auth login checkpoint")
        );
        assert_eq!(restored[0].summary.marked_color.as_deref(), Some("green"));
        assert_eq!(
            restored[0].summary.process_name.as_deref(),
            Some("chrome.exe")
        );
        assert_eq!(restored[0].summary.process_pid, Some(9042));

        // Verify binary PNG bytes survived HAR Base64 roundtrip bit-for-bit
        assert_eq!(
            decode_detail_body_bytes(&restored[1], true),
            decode_detail_body_bytes(&originals[1], true)
        );
        assert_eq!(restored[1].websocket_frames.len(), 1);
    }

    #[test]
    fn saz_roundtrip_preserves_requests_responses_binary_bodies_and_metadata() {
        let originals = sample_sessions();
        let mut cursor = Cursor::new(Vec::new());
        let count = write_saz_to_writer(&mut cursor, &originals).expect("write SAZ");
        assert_eq!(count, 2);

        cursor.set_position(0);
        let restored = read_saz_from_reader(cursor).expect("read SAZ");
        assert_eq!(restored.len(), 2);

        assert_eq!(restored[0].summary.method, "POST");
        assert_eq!(restored[0].summary.host, "auth.fluxproxy.dev");
        assert_eq!(
            restored[0].summary.path,
            "/v1/login?redirect=%2Fdashboard&lang=ru"
        );
        assert_eq!(restored[0].summary.duration_ms, 84);
        assert_eq!(
            restored[0].request_body_text.as_deref(),
            originals[0].request_body_text.as_deref()
        );
        assert_eq!(
            restored[0].response_body_text.as_deref(),
            originals[0].response_body_text.as_deref()
        );
        assert_eq!(
            restored[0].summary.comment.as_deref(),
            Some("Auth login checkpoint")
        );
        assert_eq!(restored[0].summary.marked_color.as_deref(), Some("green"));
        assert_eq!(
            restored[0].summary.process_name.as_deref(),
            Some("chrome.exe")
        );
        assert_eq!(restored[0].summary.process_pid, Some(9042));

        assert_eq!(
            decode_detail_body_bytes(&restored[1], true),
            decode_detail_body_bytes(&originals[1], true)
        );
        assert!(restored[1].summary.is_mocked);
        assert_eq!(restored[1].websocket_frames.len(), 1);
    }

    #[test]
    fn reads_authentic_fiddler_classic_saz_with_bom_chunked_and_gzip_wire_body() {
        // Build an authentic Fiddler Classic .saz in memory:
        // - UTF-8 BOM on `raw/001_m.xml`
        // - `Transfer-Encoding: chunked` + `Content-Encoding: gzip` wire-encoded `raw/001_s.txt`
        let plain_json = br#"{"fiddlerClassic":true,"items":[1,2,3],"message":"hello from saz"}"#;
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(plain_json).unwrap();
        let gzipped = gz.finish().unwrap();

        // Split into 2 HTTP/1.1 chunks
        let split_at = gzipped.len() / 2;
        let part1 = &gzipped[..split_at];
        let part2 = &gzipped[split_at..];
        let mut chunked_wire = Vec::new();
        chunked_wire.extend_from_slice(format!("{:x}\r\n", part1.len()).as_bytes());
        chunked_wire.extend_from_slice(part1);
        chunked_wire.extend_from_slice(b"\r\n");
        chunked_wire.extend_from_slice(format!("{:x}\r\n", part2.len()).as_bytes());
        chunked_wire.extend_from_slice(part2);
        chunked_wire.extend_from_slice(b"\r\n0\r\n\r\n");

        let client_raw = b"GET https://api.contoso.com/v2/orders?limit=10 HTTP/1.1\r\nHost: api.contoso.com\r\nUser-Agent: FiddlerTest/1.0\r\n\r\n";

        let mut server_raw = Vec::new();
        server_raw.extend_from_slice(
            b"HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nContent-Encoding: gzip\r\n\r\n",
        );
        server_raw.extend_from_slice(&chunked_wire);

        let mut meta_with_bom = vec![0xEF, 0xBB, 0xBF];
        meta_with_bom.extend_from_slice(
            br#"<?xml version="1.0" encoding="utf-8"?>
<Session SID="1" BitFlags="1">
  <SessionTimers ClientConnected="2026-11-09T08:00:00.0000000+00:00" ClientBeginRequest="2026-11-09T08:00:00.1000000+00:00" ClientDoneResponse="2026-11-09T08:00:00.3450000+00:00" />
  <SessionFlags>
    <SessionFlag N="x-processinfo" V="firefox:7788" />
    <SessionFlag N="x-clientip" V="::ffff:127.0.0.1" />
    <SessionFlag N="x-clientport" V="60123" />
    <SessionFlag N="ui-comments" V="Captured in Fiddler Classic &amp; verified" />
    <SessionFlag N="ui-backcolor" V="LightYellow" />
  </SessionFlags>
</Session>"#,
        );

        let mut zip_buf = Cursor::new(Vec::new());
        {
            let mut zw = ZipWriter::new(&mut zip_buf);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            zw.start_file("raw/001_c.txt", opts).unwrap();
            zw.write_all(client_raw).unwrap();
            zw.start_file("raw/001_s.txt", opts).unwrap();
            zw.write_all(&server_raw).unwrap();
            zw.start_file("raw/001_m.xml", opts).unwrap();
            zw.write_all(&meta_with_bom).unwrap();
            zw.finish().unwrap();
        }

        let imported =
            import_sessions_from_bytes("capture.saz", zip_buf.get_ref()).expect("import SAZ");
        assert_eq!(imported.len(), 1);
        let s = &imported[0];
        assert_eq!(s.summary.status, 201);
        assert_eq!(s.summary.scheme, "https");
        assert_eq!(s.summary.host, "api.contoso.com");
        assert_eq!(s.summary.path, "/v2/orders?limit=10");
        assert_eq!(s.summary.duration_ms, 245);
        assert_eq!(s.summary.process_name.as_deref(), Some("firefox"));
        assert_eq!(s.summary.process_pid, Some(7788));
        assert_eq!(s.summary.client_ip.as_deref(), Some("127.0.0.1"));
        assert_eq!(
            s.summary.comment.as_deref(),
            Some("Captured in Fiddler Classic & verified")
        );
        assert_eq!(s.summary.marked_color.as_deref(), Some("yellow"));
        assert_eq!(
            s.response_body_text.as_deref(),
            Some(std::str::from_utf8(plain_json).unwrap())
        );
    }

    #[test]
    fn exports_and_imports_files_on_disk_and_saves_raw_bodies() {
        let originals = sample_sessions();
        let har_path = unique_temp_path("roundtrip.har");
        let saz_path = unique_temp_path("roundtrip.saz");
        let raw_body_path = unique_temp_path("logo.png");
        let full_raw_path = unique_temp_path("session_101_raw.txt");

        assert_eq!(
            export_sessions_to_path(&originals, "har", &har_path).unwrap(),
            2
        );
        assert_eq!(
            export_sessions_to_path(&originals, "saz", &saz_path).unwrap(),
            2
        );
        assert_eq!(
            export_sessions_to_path(&originals[..1], "raw", &full_raw_path).unwrap(),
            1
        );

        let png_bytes = decode_detail_body_bytes(&originals[1], true);
        let written = write_raw_bytes_to_file(&raw_body_path, &png_bytes).unwrap();
        assert_eq!(written, png_bytes.len());
        assert_eq!(std::fs::read(&raw_body_path).unwrap(), png_bytes);

        let from_har = import_sessions_from_path(&har_path).unwrap();
        let from_saz = import_sessions_from_path(&saz_path).unwrap();
        assert_eq!(from_har.len(), 2);
        assert_eq!(from_saz.len(), 2);

        let full_txt = std::fs::read_to_string(&full_raw_path).unwrap();
        assert!(full_txt.contains("POST https://auth.fluxproxy.dev/v1/login"));
        assert!(full_txt.contains("\"token\":\"jwt-xyz\""));

        let _ = std::fs::remove_file(&har_path);
        let _ = std::fs::remove_file(&saz_path);
        let _ = std::fs::remove_file(&raw_body_path);
        let _ = std::fs::remove_file(&full_raw_path);
    }

    #[test]
    fn raw_http_builders_strip_crlf_and_nul_header_injections() {
        let mut detail = sample_sessions().into_iter().next().unwrap();
        detail.summary.method = "POST\r\nX-Injected: evil\0".into();
        detail.summary.url = "https://example.com/test\r\nInjected-Req: 1\0".into();
        detail.summary.host = "example.com\r\nX-Host-Injected: yes\0".into();
        detail.summary.content_type = "application/json\r\nSet-Cookie: pwn=1\0".into();
        detail.request_headers = vec![crate::models::HeaderPair::new(
            "X-Custom\r\nEvil",
            "val\r\nX-Smuggled: 1\0",
        )];
        detail.response_headers = vec![crate::models::HeaderPair::new(
            "X-Resp\nName",
            "ok\r\nSet-Cookie: bad=2\0",
        )];

        let req_raw = String::from_utf8(build_raw_http_request_bytes(&detail)).unwrap();
        let req_head = req_raw.split("\r\n\r\n").next().unwrap();
        assert!(!req_head.contains('\0'));
        assert!(!req_head.contains("\r\nX-Injected:"));
        assert!(!req_head.contains("\r\nInjected-Req:"));
        assert!(!req_head.contains("\r\nX-Smuggled:"));
        assert!(!req_head.contains("\r\nX-Host-Injected:"));

        let resp_raw = String::from_utf8(build_raw_http_response_bytes(&detail)).unwrap();
        let resp_head = resp_raw.split("\r\n\r\n").next().unwrap();
        assert!(!resp_head.contains('\0'));
        assert!(!resp_head.contains("\r\nSet-Cookie:"));
    }

    #[test]
    fn rejects_saz_zip_bomb_entry_and_oversized_limits() {
        // 1. Spoofed declared_size > MAX_SAZ_ENTRY_BYTES rejected before full allocation
        let tiny_data = b"hello";
        let mut cursor = Cursor::new(tiny_data);
        let err = read_bounded_saz_entry(
            &mut cursor,
            MAX_SAZ_ENTRY_BYTES + 1,
            MAX_SAZ_TOTAL_UNCOMPRESSED_BYTES,
            "raw/0001_s.txt",
        )
        .expect_err("must reject oversized entry");
        assert!(err.to_string().contains("слишком велика"));

        // 2. Spoofed small declared_size (0), actual uncompressed stream exceeds remaining_total
        let actual_data = vec![b'A'; 1024];
        let mut cursor2 = Cursor::new(&actual_data);
        let err2 = read_bounded_saz_entry(&mut cursor2, 0, 512, "raw/0002_s.txt")
            .expect_err("must reject uncompressed zip-bomb stream exceeding total cap");
        assert!(err2.to_string().contains("ZIP-бомбу"));

        // 3. Within limits succeeds cleanly
        let mut cursor3 = Cursor::new(&actual_data);
        let ok = read_bounded_saz_entry(
            &mut cursor3,
            actual_data.len() as u64,
            MAX_SAZ_TOTAL_UNCOMPRESSED_BYTES,
            "raw/0003_s.txt",
        )
        .expect("within limits");
        assert_eq!(ok.len(), 1024);
    }

    #[test]
    fn decode_chunked_uses_checked_arithmetic_and_rejects_overflow() {
        let huge_hex = format!("{:x}\r\nabc\r\n0\r\n\r\n", usize::MAX);
        assert!(decode_chunked(huge_hex.as_bytes()).is_none());

        let near_max = format!("{:x}\r\nabc\r\n0\r\n\r\n", usize::MAX - 2);
        assert!(decode_chunked(near_max.as_bytes()).is_none());

        let valid = b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(valid).as_deref(), Some(b"hello world".as_slice()));
    }

    #[test]
    fn decodes_utf16be_xml_and_handles_tag_delimiters_and_quoted_gt() {
        let xml = r#"<?xml version="1.0" encoding="utf-16"?><Root><SessionTimers ClientConnected="2026-11-09T08:00:00Z" /><Session SID="1" BitFlags="1" Note="a > b"><SessionFlags><SessionFlag N="ui-comments" V="x > y &amp; N='fake'" /></SessionFlags></Session></Root>"#;
        let mut utf16be = vec![0xFEu8, 0xFFu8];
        for code_unit in xml.encode_utf16() {
            utf16be.extend_from_slice(&code_unit.to_be_bytes());
        }
        let decoded = decode_xml_bytes(&utf16be);
        assert_eq!(decoded, xml);

        // Must match `<Session ...>`, not `<SessionTimers ...>`
        let session_frag = extract_xml_tag_fragment(&decoded, "Session").unwrap();
        assert!(session_frag.starts_with("<Session "));
        assert!(session_frag.ends_with("Note=\"a > b\">"));
        assert_eq!(extract_xml_attr(session_frag, "BitFlags").as_deref(), Some("1"));

        let meta = parse_saz_metadata_xml(&decoded);
        assert_eq!(meta.bit_flags, 1);
        assert_eq!(
            meta.flags.get("ui-comments").map(String::as_str),
            Some("x > y & N='fake'")
        );
    }

    #[test]
    fn unifies_url_parsing_with_query_without_slash_and_at_signs() {
        let headers = vec![HeaderPair::new("Host", "fallback.local")];

        let (sch1, host1, path1) =
            split_url_components("http://user:p@ss@api.example.com:8080?a=1&b=2", &headers);
        assert_eq!(sch1, "http");
        assert_eq!(host1, "api.example.com:8080");
        assert_eq!(path1, "/?a=1&b=2");

        let (sch2, host2, path2, url2) = reconstruct_saz_url(
            "GET",
            "http://user:p@ss@api.example.com:8080?a=1&b=2",
            "http",
            &headers,
        );
        assert_eq!((sch2, host2, path2), (sch1, host1, path1));
        assert_eq!(url2, "http://api.example.com:8080/?a=1&b=2");

        // Ensure `@` inside path does not strip host as userinfo
        let (_, host3, path3) =
            split_url_components("https://api.example.com/users/@alice?tab=1", &headers);
        assert_eq!(host3, "api.example.com");
        assert_eq!(path3, "/users/@alice?tab=1");
    }

    #[test]
    fn decodes_stacked_content_encoding_right_to_left_and_matches_br_deflate_magic() {
        let plain = br#"{"stacked":true,"message":"gzip inside brotli"}"#;

        // Inner layer: gzip
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(plain).unwrap();
        let gzipped = gz.finish().unwrap();

        // Outer layer: brotli
        let mut br_out = Vec::new();
        {
            let mut br_enc = brotli::CompressorWriter::new(&mut br_out, 4096, 5, 22);
            br_enc.write_all(&gzipped).unwrap();
        }

        let headers = vec![HeaderPair::new("Content-Encoding", "gzip, br")];
        let mut cumulative = 0u64;
        let decoded = decode_http_body(&br_out, &headers, &mut cumulative).unwrap();
        assert_eq!(decoded, plain);
        assert_eq!(cumulative, (gzipped.len() + plain.len()) as u64);

        // `is_matching_compressed_magic` must detect genuine brotli and deflate, and reject plain text
        assert!(is_matching_compressed_magic("br", &br_out));
        assert!(!is_matching_compressed_magic("br", plain));

        let mut deflate_enc = flate2::write::ZlibEncoder::new(Vec::new(), Compression::default());
        deflate_enc.write_all(plain).unwrap();
        let deflated = deflate_enc.finish().unwrap();
        assert!(is_matching_compressed_magic("deflate", &deflated));
        assert!(!is_matching_compressed_magic("deflate", plain));
    }

    #[test]
    fn preserves_status_zero_and_sse_events_across_saz_roundtrip() {
        let mut sessions = sample_sessions();
        sessions[0].summary.status = 0;
        sessions[0].sse_events = vec![SseEventRecord {
            index: 1,
            id: Some("evt-1".into()),
            event: "token".into(),
            data: "{\"delta\":\"hi\"}".into(),
            retry: None,
            byte_length: 14,
            offset_ms: 12,
            timestamp: "2026-11-09T09:15:30.262Z".into(),
        }];

        let mut cursor = Cursor::new(Vec::new());
        write_saz_to_writer(&mut cursor, &sessions).expect("write SAZ");
        cursor.set_position(0);
        let imported = read_saz_from_reader(cursor).expect("read SAZ");

        assert_eq!(imported[0].summary.status, 0);
        assert_eq!(imported[0].sse_events.len(), 1);
        assert_eq!(imported[0].sse_events[0].id.as_deref(), Some("evt-1"));
        assert_eq!(imported[0].sse_events[0].event, "token");
    }

    #[test]
    fn sanitizes_har_and_saz_exports_without_corrupting_structure() {
        let mut sessions = sample_sessions();

        // Session 0: JSON request/response + Auth headers + sensitive query params + client PII
        let json_req = br#"{"user":"alice","Password":"secret-json-pass","nested":[{"access_token":"tok-nested-999","cvv":"882"}]}"#;
        let json_resp = br#"{"ok":true,"token":"resp-jwt-secret-123","refresh_token":"ref-secret-456","profile":{"api_key":"live-key-789"}}"#;
        sessions[0].summary.path = "/v1/login?token=url-secret-tok&lang=ru&sig=hmac-secret-sig".into();
        sessions[0].summary.url =
            "https://auth.fluxproxy.dev/v1/login?token=url-secret-tok&lang=ru&sig=hmac-secret-sig"
                .into();
        sessions[0].summary.client_ip = Some("192.168.10.44".into());
        sessions[0].client_addr = "192.168.10.44:59123".into();
        sessions[0].summary.process_name = Some("secret-app.exe".into());
        sessions[0].summary.process_pid = Some(4242);
        sessions[0].request_headers = vec![
            HeaderPair::new("Host", "auth.fluxproxy.dev"),
            HeaderPair::new("Content-Type", "application/json"),
            HeaderPair::new("Authorization", "Bearer header-jwt-secret"),
            HeaderPair::new("Proxy-Authorization", "Basic cHJveHk6c2VjcmV0"),
            HeaderPair::new("Cookie", "sid=cookie-secret-val; theme=dark"),
            HeaderPair::new("X-Api-Key", "x-api-key-secret"),
            HeaderPair::new("X-Auth-Token", "x-auth-tok-secret"),
            HeaderPair::new("X-Custom-Session", "custom-hdr-secret"),
        ];
        sessions[0].response_headers = vec![
            HeaderPair::new("Content-Type", "application/json; charset=utf-8"),
            HeaderPair::new("Set-Cookie", "session=set-cookie-secret; HttpOnly; Secure"),
        ];
        sessions[0].request_body_base64 =
            base64::engine::general_purpose::STANDARD.encode(json_req);
        sessions[0].request_body_text = Some(String::from_utf8(json_req.to_vec()).unwrap());
        sessions[0].response_body_base64 =
            base64::engine::general_purpose::STANDARD.encode(json_resp);
        sessions[0].response_body_text = Some(String::from_utf8(json_resp.to_vec()).unwrap());
        sessions[0].summary.body_size = json_resp.len();

        // Session 1: Form-urlencoded request + binary PNG response (must stay intact)
        let form_req = b"grant_type=refresh_token&client_id=flux-web&refresh_token=form-refresh-secret&Password=form-pass-secret";
        sessions[1].summary.method = "POST".into();
        sessions[1].summary.path = "/oauth/token?api_key=query-api-key-secret&mode=refresh".into();
        sessions[1].summary.url =
            "https://cdn.fluxproxy.dev/oauth/token?api_key=query-api-key-secret&mode=refresh"
                .into();
        sessions[1].request_headers = vec![
            HeaderPair::new("Host", "cdn.fluxproxy.dev"),
            HeaderPair::new("Content-Type", "application/x-www-form-urlencoded"),
        ];
        sessions[1].request_body_base64 =
            base64::engine::general_purpose::STANDARD.encode(form_req);
        sessions[1].request_body_text = Some(String::from_utf8(form_req.to_vec()).unwrap());

        let original_png = decode_detail_body_bytes(&sessions[1], true);

        let opts = SanitizationOptions {
            custom_redacted_headers: vec!["x-custom-session".into()],
            anonymize_client_info: true,
            ..SanitizationOptions::default()
        };

        let sanitized = sanitize_sessions(&sessions, &opts);
        assert_eq!(sanitized.len(), 2);

        // Verify JSON & Raw HTTP exports contain no raw secrets
        let json_dump = serialize_json_archive(&sanitized).expect("serialize JSON");
        let raw_dump = String::from_utf8_lossy(&serialize_full_raw_http(&sanitized)).into_owned();
        let har_json = serialize_har_1_2(&sanitized).expect("serialize HAR 1.2");

        let secrets = [
            "secret-json-pass",
            "tok-nested-999",
            "882",
            "resp-jwt-secret-123",
            "ref-secret-456",
            "live-key-789",
            "url-secret-tok",
            "hmac-secret-sig",
            "header-jwt-secret",
            "cHJveHk6c2VjcmV0",
            "cookie-secret-val",
            "x-api-key-secret",
            "x-auth-tok-secret",
            "custom-hdr-secret",
            "set-cookie-secret",
            "form-refresh-secret",
            "form-pass-secret",
            "query-api-key-secret",
            "192.168.10.44",
            "secret-app.exe",
        ];

        for secret in secrets {
            assert!(!har_json.contains(secret), "HAR leaked secret: {secret}");
            assert!(!json_dump.contains(secret), "JSON leaked secret: {secret}");
            assert!(!raw_dump.contains(secret), "Raw HTTP leaked secret: {secret}");
        }

        // Verify HAR 1.2 deserializes cleanly and retains structure
        let har_val: serde_json::Value = serde_json::from_str(&har_json).expect("valid HAR JSON");
        assert_eq!(har_val["log"]["version"], "1.2");
        assert_eq!(har_val["log"]["entries"][0]["request"]["queryString"][0]["value"], "[REDACTED]");
        assert_eq!(har_val["log"]["entries"][0]["request"]["queryString"][1]["name"], "lang");
        assert_eq!(har_val["log"]["entries"][0]["request"]["queryString"][1]["value"], "ru");

        let har_roundtrip = deserialize_har_1_2(&har_json).expect("deserialize sanitized HAR");
        assert_eq!(har_roundtrip.len(), 2);
        assert_eq!(har_roundtrip[0].client_addr, "0.0.0.0:0");
        assert_eq!(har_roundtrip[0].summary.client_ip.as_deref(), Some("0.0.0.0"));
        assert_eq!(
            har_roundtrip[0].summary.process_name.as_deref(),
            Some("redacted-process")
        );
        assert_eq!(har_roundtrip[0].summary.process_pid, None);
        assert_eq!(
            decode_detail_body_bytes(&har_roundtrip[1], true),
            original_png
        );

        let form_body = har_roundtrip[1].request_body_text.as_deref().unwrap();
        assert!(form_body.contains("grant_type=refresh_token"));
        assert!(form_body.contains("refresh_token=[REDACTED]"));
        assert!(form_body.contains("Password=[REDACTED]"));

        // Verify SAZ archive builds cleanly, strips secrets from ZIP entries, and roundtrips
        let mut saz_cursor = Cursor::new(Vec::new());
        let written_count = write_saz_to_writer(&mut saz_cursor, &sanitized).expect("write SAZ");
        assert_eq!(written_count, 2);

        saz_cursor.set_position(0);
        {
            let mut archive = ZipArchive::new(&mut saz_cursor).expect("open SAZ zip");
            for i in 0..archive.len() {
                let mut entry = archive.by_index(i).unwrap();
                let mut buf = Vec::new();
                entry.read_to_end(&mut buf).unwrap();
                let text = String::from_utf8_lossy(&buf);
                for secret in secrets {
                    assert!(
                        !text.contains(secret),
                        "SAZ entry '{}' leaked secret: {secret}",
                        entry.name().unwrap()
                    );
                }
            }
        }

        saz_cursor.set_position(0);
        let saz_roundtrip = read_saz_from_reader(saz_cursor).expect("read sanitized SAZ");
        assert_eq!(saz_roundtrip.len(), 2);
        assert_eq!(saz_roundtrip[0].client_addr, "0.0.0.0:0");
        assert_eq!(saz_roundtrip[0].summary.client_ip.as_deref(), Some("0.0.0.0"));
        assert_eq!(
            saz_roundtrip[0].summary.process_name.as_deref(),
            Some("redacted-process")
        );
        assert_eq!(saz_roundtrip[0].summary.process_pid, None);
        assert_eq!(
            decode_detail_body_bytes(&saz_roundtrip[1], true),
            original_png
        );
        let saz_req_json: serde_json::Value =
            serde_json::from_str(saz_roundtrip[0].request_body_text.as_deref().unwrap()).unwrap();
        assert_eq!(saz_req_json["user"], "alice");
        assert_eq!(saz_req_json["Password"], "[REDACTED]");
        assert_eq!(saz_req_json["nested"][0]["access_token"], "[REDACTED]");
        assert_eq!(saz_req_json["nested"][0]["cvv"], "[REDACTED]");
    }

    #[test]
    fn sec04_sanitizes_camelcase_keys_sse_and_ws_bodies_signalr_socketio_jwt_and_url_headers() {
        let mut sessions = sample_sessions();
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEifQ.sigpart123";

        // Session 0: camelCase JSON secrets + credentials/fragment in URL, Location, Referer + SSE stream
        let camel_req = serde_json::json!({
            "accessToken": "camel-access-secret",
            "refreshToken": "camel-refresh-secret",
            "apiKey": "camel-apikey-secret",
            "clientSecret": "camel-client-secret",
            "idToken": "camel-idtoken-secret",
            "privateKey": "camel-privkey-secret",
            "cardNumber": "4111222233334444",
            "sessionId": "camel-sessid-secret",
            "note": format!("Bearer header-inline-secret {jwt}")
        })
        .to_string();
        let raw_sse_body = format!(
            "id: 1\nevent: auth\ndata: {{\"accessToken\":\"sse-access-secret\",\"jwt\":\"{jwt}\"}}\n\n"
        );
        sessions[0].summary.content_type = "text/event-stream; charset=utf-8".into();
        sessions[0].summary.url =
            "https://alice:topsecretpass@auth.fluxproxy.dev/users/@alice?apiKey=qtok-secret&lang=en#id_token=frag-secret"
                .into();
        sessions[0].summary.path = "/users/@alice?apiKey=qtok-secret&lang=en#id_token=frag-secret".into();
        sessions[0].request_headers = vec![
            HeaderPair::new("Host", "auth.fluxproxy.dev"),
            HeaderPair::new("Content-Type", "application/json"),
            HeaderPair::new(
                "Referer",
                "https://bob:refpass@portal.fluxproxy.dev/cb?apiKey=ref-apikey#access_token=ref-frag",
            ),
        ];
        sessions[0].response_headers = vec![
            HeaderPair::new("Content-Type", "text/event-stream; charset=utf-8"),
            HeaderPair::new(
                "Location",
                "https://carol:locpass@app.fluxproxy.dev/done?token=loc-tok#state=loc-frag",
            ),
        ];
        sessions[0].request_body_base64 =
            base64::engine::general_purpose::STANDARD.encode(camel_req.as_bytes());
        sessions[0].request_body_text = Some(camel_req);
        sessions[0].response_body_base64 =
            base64::engine::general_purpose::STANDARD.encode(raw_sse_body.as_bytes());
        sessions[0].response_body_text = Some(raw_sse_body);
        sessions[0].sse_events = vec![SseEventRecord {
            index: 1,
            id: Some("1".into()),
            event: "auth".into(),
            data: format!("{{\"accessToken\":\"sse-access-secret\",\"jwt\":\"{jwt}\"}}"),
            retry: None,
            byte_length: 80,
            offset_ms: 5,
            timestamp: "2026-11-09T09:15:30.300Z".into(),
        }];

        // Session 1: WebSocket session with SignalR (\x1e), Socket.IO, and plain Bearer/JWT frames
        sessions[1].summary.status = 101;
        sessions[1].summary.protocol = "WSS".into();
        sessions[1].summary.scheme = "wss".into();
        sessions[1].summary.content_type = "application/json".into();
        sessions[1].websocket_frames = vec![
            WebSocketFrameRecord {
                index: 1,
                direction: "outbound".into(),
                opcode: "text".into(),
                payload_preview: "{\"type\":1,\"arguments\":[{\"accessToken\":\"signalr-secret\",\"bearer\":\"Bearer signalr-bearer\"}]}\x1e".to_string(),
                byte_length: 100,
                timestamp: "2026-11-09T09:15:31.010Z".into(),
                injected: false,
            },
            WebSocketFrameRecord {
                index: 2,
                direction: "outbound".into(),
                opcode: "text".into(),
                payload_preview: "42/chat,[\"auth\",{\"apiKey\":\"socketio-apikey\",\"clientSecret\":\"socketio-csecret\"}]".into(),
                byte_length: 82,
                timestamp: "2026-11-09T09:15:31.020Z".into(),
                injected: false,
            },
            WebSocketFrameRecord {
                index: 3,
                direction: "inbound".into(),
                opcode: "text".into(),
                payload_preview: format!("AUTH Bearer plain-ws-bearer TOKEN {jwt}"),
                byte_length: 90,
                timestamp: "2026-11-09T09:15:31.030Z".into(),
                injected: false,
            },
        ];
        let stale_ws_body = serde_json::to_string_pretty(&sessions[1].websocket_frames).unwrap();
        sessions[1].response_body_text = Some(stale_ws_body.clone());
        sessions[1].response_body_base64 =
            base64::engine::general_purpose::STANDARD.encode(stale_ws_body.as_bytes());

        let sanitized = sanitize_sessions(&sessions, &SanitizationOptions::default());
        let json_dump = serialize_json_archive(&sanitized).unwrap();
        let har_dump = serialize_har_1_2(&sanitized).unwrap();
        let raw_dump = String::from_utf8_lossy(&serialize_full_raw_http(&sanitized)).into_owned();

        let forbidden = [
            "camel-access-secret",
            "camel-refresh-secret",
            "camel-apikey-secret",
            "camel-client-secret",
            "camel-idtoken-secret",
            "camel-privkey-secret",
            "4111222233334444",
            "camel-sessid-secret",
            "header-inline-secret",
            jwt,
            "sse-access-secret",
            "topsecretpass",
            "qtok-secret",
            "frag-secret",
            "refpass",
            "ref-apikey",
            "ref-frag",
            "locpass",
            "loc-tok",
            "loc-frag",
            "signalr-secret",
            "signalr-bearer",
            "socketio-apikey",
            "socketio-csecret",
            "plain-ws-bearer",
        ];
        for secret in forbidden {
            assert!(!json_dump.contains(secret), "JSON leaked secret: {secret}");
            assert!(!har_dump.contains(secret), "HAR leaked secret: {secret}");
            assert!(!raw_dump.contains(secret), "Raw HTTP leaked secret: {secret}");
        }

        // Verify SSE and WS bodies were rebuilt rather than keeping stale pre-sanitization bytes
        let sse_rebuilt = sanitized[0].response_body_text.as_deref().unwrap();
        assert!(sse_rebuilt.contains("[REDACTED]"));
        assert_eq!(
            decode_detail_body_bytes(&sanitized[0], true),
            sse_rebuilt.as_bytes()
        );
        assert!(sanitized[1].websocket_frames[0].payload_preview.ends_with('\x1e'));
        assert!(sanitized[1].websocket_frames[1].payload_preview.starts_with("42/chat,["));

        // Verify `@alice` path preserved while userinfo and fragment redacted
        assert!(sanitized[0].summary.url.starts_with("https://auth.fluxproxy.dev/users/@alice?"));
        assert!(sanitized[0].summary.url.ends_with("#[REDACTED]"));
        assert_eq!(
            find_header_value(&sanitized[0].response_headers, "location").unwrap(),
            "https://app.fluxproxy.dev/done?token=[REDACTED]#[REDACTED]"
        );
        assert_eq!(
            find_header_value(&sanitized[0].request_headers, "referer").unwrap(),
            "https://portal.fluxproxy.dev/cb?apiKey=[REDACTED]#[REDACTED]"
        );
    }

    #[test]
    fn sec05_and_bug12_saz_zstd_layer_limits_cumulative_http_cap_and_safe_duration() {
        let plain = br#"{"codec":"zstd-in-saz","ok":true}"#;
        let zstd_payload = zstd::encode_all(plain.as_slice(), 1).unwrap();

        // 1. Single-layer zstd and 2-layer gzip+zstd succeed
        let mut cumulative = 0u64;
        let zstd_headers = vec![HeaderPair::new("Content-Encoding", "zstd")];
        assert_eq!(
            decode_http_body(&zstd_payload, &zstd_headers, &mut cumulative).unwrap(),
            plain
        );

        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(plain).unwrap();
        let gzipped = gz.finish().unwrap();
        let zstd_over_gzip = zstd::encode_all(gzipped.as_slice(), 1).unwrap();
        let two_layer_headers = vec![HeaderPair::new("Content-Encoding", "gzip, zstd")];
        let mut cumulative2 = 0u64;
        assert_eq!(
            decode_http_body(&zstd_over_gzip, &two_layer_headers, &mut cumulative2).unwrap(),
            plain
        );
        assert_eq!(cumulative2, (gzipped.len() + plain.len()) as u64);

        // 2. More than 2 Content-Encoding layers are rejected
        let three_layer_headers = vec![HeaderPair::new("Content-Encoding", "gzip, br, zstd")];
        let mut cumulative3 = 0u64;
        assert!(decode_http_body(&zstd_over_gzip, &three_layer_headers, &mut cumulative3).is_err());

        // 3. Cumulative HTTP decompression budget across calls rejects when exceeding limit
        let mut small_budget = 0u64;
        let big_plain = vec![b'Z'; 1024];
        let big_zstd = zstd::encode_all(big_plain.as_slice(), 1).unwrap();
        assert!(
            decode_http_body_with_limit(&big_zstd, &zstd_headers, &mut small_budget, 512).is_err()
        );

        // 4. SAZ roundtrip handles raw HTTP response encoded with Content-Encoding: zstd
        let mut server_raw = Vec::new();
        server_raw.extend_from_slice(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: zstd\r\nContent-Length: {}\r\n\r\n",
                zstd_payload.len()
            )
            .as_bytes(),
        );
        server_raw.extend_from_slice(&zstd_payload);
        let mut zip_buf = Cursor::new(Vec::new());
        {
            let mut zw = ZipWriter::new(&mut zip_buf);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            zw.start_file("raw/001_c.txt", opts).unwrap();
            zw.write_all(b"GET https://example.com/z HTTP/1.1\r\nHost: example.com\r\n\r\n")
                .unwrap();
            zw.start_file("raw/001_s.txt", opts).unwrap();
            zw.write_all(&server_raw).unwrap();
            zw.finish().unwrap();
        }
        let imported = import_sessions_from_bytes("zstd.saz", zip_buf.get_ref()).unwrap();
        assert_eq!(
            imported[0].response_body_text.as_deref(),
            Some(std::str::from_utf8(plain).unwrap())
        );

        // 5. BUG-12: extreme duration_ms (u64::MAX) in export_saz must never panic
        let mut extreme = sample_sessions();
        extreme[0].summary.duration_ms = u64::MAX;
        let mut saz_out = Cursor::new(Vec::new());
        assert_eq!(write_saz_to_writer(&mut saz_out, &extreme).unwrap(), 2);
    }

    fn make_telemetried_sample(reused: bool) -> SessionDetail {
        let mut detail = sample_sessions().into_iter().next().unwrap();
        let body_bytes = vec![b'A'; 1000];
        let body_text = String::from_utf8(body_bytes.clone()).unwrap();
        detail.response_headers = vec![
            HeaderPair::new("Content-Type", "application/json; charset=utf-8"),
            HeaderPair::new("Content-Encoding", "gzip"),
        ];
        detail.response_body_base64 = base64::engine::general_purpose::STANDARD.encode(&body_bytes);
        detail.response_body_text = Some(body_text);
        detail.summary.body_size = 1000;
        detail.summary.duration_ms = if reused { 46 } else { 94 };

        let timings = SessionTimings {
            client_connected: Some("2026-11-22T09:15:30.245000Z".into()),
            client_begin_request: Some("2026-11-22T09:15:30.250000Z".into()),
            got_request_headers: Some("2026-11-22T09:15:30.250800Z".into()),
            client_done_request: Some("2026-11-22T09:15:30.251500Z".into()),
            proxy_begin_request: Some("2026-11-22T09:15:30.252000Z".into()),
            server_connected: Some("2026-11-22T09:15:30.300000Z".into()),
            server_got_request: Some("2026-11-22T09:15:30.301200Z".into()),
            server_begin_response: Some("2026-11-22T09:15:30.339600Z".into()),
            got_response_headers: Some("2026-11-22T09:15:30.340000Z".into()),
            server_done_response: Some("2026-11-22T09:15:30.345700Z".into()),
            client_begin_response: Some("2026-11-22T09:15:30.346000Z".into()),
            client_done_response: Some("2026-11-22T09:15:30.347000Z".into()),
            client_read_ms: Some(1.5),
            client_tls_handshake_ms: Some(if reused { 0.0 } else { 3.5 }),
            dns_ms: Some(if reused { 0.0 } else { 5.5 }),
            tcp_connect_ms: Some(if reused { 0.0 } else { 12.5 }),
            tls_handshake_ms: Some(if reused { 0.0 } else { 30.0 }),
            send_request_ms: Some(1.2),
            server_wait_ms: Some(38.4),
            content_download_ms: Some(6.1),
            client_send_ms: Some(1.0),
            proxy_overhead_ms: Some(1.1),
            overall_elapsed_ms: Some(if reused { 46.0 } else { 94.0 }),
            net_elapsed_ms: Some(if reused { 45.7 } else { 93.7 }),
            ..Default::default()
        };

        let stats = SessionTransferStats {
            request_headers_bytes: Some(140),
            request_body_bytes: Some(42),
            request_wire_body_bytes: Some(42),
            response_headers_bytes: Some(190),
            response_body_bytes: Some(1000),
            response_wire_body_bytes: Some(380),
            response_content_encoding: Some("gzip".into()),
            client_conn_id: Some(99),
            client_conn_reused: Some(reused),
            client_http_version: Some("HTTP/1.1".into()),
            client_tls_version: Some("TLSv1.3".into()),
            client_tls_cipher: Some("TLS13_AES_256_GCM_SHA384".into()),
            client_alpn: Some("http/1.1".into()),
            server_addr: Some("93.184.216.34:443".into()),
            server_ip: Some("93.184.216.34".into()),
            server_port: Some(443),
            server_conn_id: Some(101),
            server_conn_reused: Some(reused),
            server_http_version: Some("HTTP/2.0".into()),
            server_tls_version: Some("TLSv1.3".into()),
            server_tls_cipher: Some("TLS13_AES_128_GCM_SHA256".into()),
            server_tls_alpn: Some("h2".into()),
            server_cert_subject: Some("CN=auth.fluxproxy.dev".into()),
            server_cert_issuer: Some("CN=Test CA".into()),
            ..Default::default()
        };

        detail.summary.apply_telemetry(Some(&timings), Some(&stats));
        detail.timings = Some(timings);
        detail.transfer_stats = Some(stats);
        detail
    }

    #[test]
    fn har_1_2_telemetry_roundtrip_and_third_party_fallback() {
        let cold = make_telemetried_sample(false);
        let warm = make_telemetried_sample(true);
        let har_json = serialize_har_1_2(&[cold.clone(), warm]).expect("serialize HAR");
        let raw_val: serde_json::Value = serde_json::from_str(&har_json).unwrap();

        let e0 = &raw_val["log"]["entries"][0];
        assert_eq!(e0["serverIPAddress"], "93.184.216.34");
        assert_eq!(e0["connection"], "101");
        assert_eq!(e0["timings"]["dns"], 5.5);
        assert_eq!(e0["timings"]["ssl"], 30.0);
        // HAR 1.2 connect = tcp + ssl
        assert_eq!(e0["timings"]["connect"], 42.5);
        assert_eq!(e0["timings"]["send"], 1.2);
        assert_eq!(e0["timings"]["wait"], 38.4);
        assert_eq!(e0["timings"]["receive"], 6.1);
        assert_eq!(e0["response"]["content"]["size"], 1000);
        assert_eq!(e0["response"]["content"]["compression"], 620);
        assert_eq!(e0["response"]["bodySize"], 380);

        let e1 = &raw_val["log"]["entries"][1];
        assert_eq!(e1["timings"]["dns"], -1.0);
        assert_eq!(e1["timings"]["connect"], -1.0);
        assert_eq!(e1["timings"]["ssl"], -1.0);
        assert_eq!(e1["connection"], "101");

        let restored = deserialize_har_1_2(&har_json).expect("roundtrip HAR");
        assert_eq!(restored[0].timings, cold.timings);
        assert_eq!(restored[0].transfer_stats, cold.transfer_stats);
        assert_eq!(restored[0].summary.ttfb_ms, Some(38.4));
        assert_eq!(restored[0].summary.server_ip.as_deref(), Some("93.184.216.34"));
        assert_eq!(restored[0].summary.wire_body_size, Some(380));

        // Third-party Chrome DevTools HAR without `_fluxProxy`
        let chrome_har = r#"{
          "log": {
            "version": "1.2",
            "creator": { "name": "Chrome", "version": "131" },
            "entries": [{
              "startedDateTime": "2026-11-22T10:00:00.000Z",
              "time": 91.0,
              "serverIPAddress": "1.1.1.1",
              "connection": "77",
              "request": {
                "method": "GET",
                "url": "https://cdn.example.org/app.js",
                "httpVersion": "HTTP/2.0",
                "headers": [],
                "queryString": [],
                "cookies": [],
                "headersSize": 180,
                "bodySize": 0
              },
              "response": {
                "status": 200,
                "statusText": "OK",
                "httpVersion": "HTTP/2.0",
                "headers": [{ "name": "Content-Encoding", "value": "br" }],
                "cookies": [],
                "content": { "size": 1000, "compression": 600, "mimeType": "application/javascript", "text": "console.log(1);" },
                "redirectURL": "",
                "headersSize": 220,
                "bodySize": 400
              },
              "cache": {},
              "timings": { "blocked": 2.0, "dns": 4.5, "connect": 32.0, "ssl": 20.0, "send": 1.5, "wait": 45.0, "receive": 8.0 }
            }]
          }
        }"#;
        let ext_imported = deserialize_har_1_2(chrome_har).expect("third-party HAR import");
        let ext_t = ext_imported[0].timings.as_ref().expect("reconstructed timings");
        assert_eq!(ext_t.dns_ms, Some(4.5));
        assert_eq!(ext_t.tcp_connect_ms, Some(12.0));
        assert_eq!(ext_t.tls_handshake_ms, Some(20.0));
        assert_eq!(ext_t.server_wait_ms, Some(45.0));
        assert_eq!(ext_t.content_download_ms, Some(8.0));
        let ext_s = ext_imported[0]
            .transfer_stats
            .as_ref()
            .expect("reconstructed stats");
        assert_eq!(ext_s.server_ip.as_deref(), Some("1.1.1.1"));
        assert_eq!(ext_s.server_conn_id, Some(77));
        assert_eq!(ext_s.server_conn_reused, Some(false));
        assert_eq!(ext_s.response_wire_body_bytes, Some(400));
        assert_eq!(ext_imported[0].summary.ttfb_ms, Some(45.0));
        assert_eq!(ext_imported[0].summary.connect_ms, Some(12.0));
    }

    #[test]
    fn saz_telemetry_roundtrip_and_authentic_fiddler_timers_import() {
        let cold = make_telemetried_sample(false);
        let mut saz_buf = Cursor::new(Vec::new());
        assert_eq!(write_saz_to_writer(&mut saz_buf, std::slice::from_ref(&cold)).unwrap(), 1);

        saz_buf.set_position(0);
        {
            let mut archive = ZipArchive::new(&mut saz_buf).unwrap();
            let mut m_xml = String::new();
            archive.by_name("raw/0001_m.xml").unwrap().read_to_string(&mut m_xml).unwrap();
            assert!(m_xml.contains("DNSTime=\"6\""));
            assert!(m_xml.contains("TCPConnectTime=\"13\""));
            assert!(m_xml.contains("HTTPSHandshakeTime=\"30\""));
            assert!(m_xml.contains("<PipeInfo CltReuse=\"false\" Reused=\"false\" />"));
            assert!(m_xml.contains("N=\"x-hostip\" V=\"93.184.216.34\""));
            assert!(m_xml.contains("N=\"https-server-cipher\" V=\"TLSv1.3 (TLS13_AES_128_GCM_SHA256)\""));
        }

        saz_buf.set_position(0);
        let saz_restored = read_saz_from_reader(saz_buf).expect("roundtrip SAZ");
        assert_eq!(saz_restored[0].timings, cold.timings);
        assert_eq!(saz_restored[0].transfer_stats, cold.transfer_stats);

        // Authentic Fiddler Classic `.saz` with sentinel timestamps and no x-fluxproxy-* flags
        let fiddler_m_xml = r#"<?xml version="1.0" encoding="utf-8"?>
<Session SID="1" BitFlags="1">
  <SessionTimers ClientConnected="2026-11-22T10:00:00.000000Z" ClientBeginRequest="2026-11-22T10:00:00.000000Z" GotRequestHeaders="0001-01-01T00:00:00" ClientDoneRequest="2026-11-22T10:00:00.002000Z" GatewayTime="0" DNSTime="7" TCPConnectTime="15" HTTPSHandshakeTime="28" ServerConnected="2026-11-22T10:00:00.052000Z" FiddlerBeginRequest="2026-11-22T10:00:00.002000Z" ServerGotRequest="2026-11-22T10:00:00.054000Z" ServerBeginResponse="2026-11-22T10:00:00.094000Z" GotResponseHeaders="2026-11-22T10:00:00.095000Z" ServerDoneResponse="2026-11-22T10:00:00.104000Z" ClientBeginResponse="2026-11-22T10:00:00.105000Z" ClientDoneResponse="2026-11-22T10:00:00.107000Z" />
  <PipeInfo CltReuse="true" Reused="false" />
  <SessionFlags>
    <SessionFlag N="x-hostip" V="104.16.10.20" />
    <SessionFlag N="https-server-cipher" V="TLSv1.3 (TLS_AES_256_GCM_SHA384)" />
  </SessionFlags>
</Session>"#;
        let mut fiddler_zip = Cursor::new(Vec::new());
        {
            let mut zw = ZipWriter::new(&mut fiddler_zip);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            zw.start_file("raw/0001_c.txt", opts).unwrap();
            zw.write_all(b"GET https://edge.test/data HTTP/1.1\r\nHost: edge.test\r\n\r\n")
                .unwrap();
            zw.start_file("raw/0001_s.txt", opts).unwrap();
            zw.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 9\r\n\r\n{\"ok\":1}\n")
                .unwrap();
            zw.start_file("raw/0001_m.xml", opts).unwrap();
            zw.write_all(fiddler_m_xml.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        let imported = import_sessions_from_bytes("classic.saz", fiddler_zip.get_ref()).unwrap();
        let it = imported[0].timings.as_ref().expect("imported timings");
        assert!(it.got_request_headers.is_none());
        assert_eq!(it.dns_ms, Some(7.0));
        assert_eq!(it.tcp_connect_ms, Some(15.0));
        assert_eq!(it.tls_handshake_ms, Some(28.0));
        assert_eq!(it.server_wait_ms, Some(40.0));
        assert_eq!(it.content_download_ms, Some(10.0));
        let is = imported[0].transfer_stats.as_ref().expect("imported stats");
        assert_eq!(is.client_conn_reused, Some(true));
        assert_eq!(is.server_conn_reused, Some(false));
        assert_eq!(is.server_ip.as_deref(), Some("104.16.10.20"));
        assert_eq!(is.server_tls_version.as_deref(), Some("TLSv1.3"));
        assert_eq!(
            is.server_tls_cipher.as_deref(),
            Some("TLS_AES_256_GCM_SHA384")
        );
        assert_eq!(imported[0].summary.server_ip.as_deref(), Some("104.16.10.20"));
    }

    #[test]
    fn sanitization_anonymizes_transfer_stats_client_conn_id_and_preserves_server_telemetry() {
        let session = make_telemetried_sample(false);
        let sanitized = sanitize_sessions(
            &[session],
            &SanitizationOptions {
                redact_auth_headers: false,
                custom_redacted_headers: Vec::new(),
                mask_json_keys: Vec::new(),
                strip_query_params: Vec::new(),
                anonymize_client_info: true,
                replacement_text: "[REDACTED]".into(),
            },
        );
        assert_eq!(sanitized.len(), 1);
        assert_eq!(sanitized[0].client_addr, "0.0.0.0:0");
        assert_eq!(sanitized[0].summary.client_ip.as_deref(), Some("0.0.0.0"));
        let stats = sanitized[0].transfer_stats.as_ref().unwrap();
        assert_eq!(stats.client_conn_id, None);
        assert_eq!(stats.server_ip.as_deref(), Some("93.184.216.34"));
        assert!(sanitized[0].timings.is_some());
    }

    #[test]
    fn sanitize_multipart_form_data_masks_fields_nested_json_and_preserves_binary() {
        let png_bytes: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE];
        let mut raw_body = Vec::new();
        raw_body.extend_from_slice(
            b"--B123\r\nContent-Disposition: form-data; name=\"password\"\r\n\r\nmy-secret-pw\r\n",
        );
        raw_body.extend_from_slice(
            b"--B123\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{\"api_key\":\"k_live_999\",\"public\":\"ok\"}\r\n",
        );
        raw_body.extend_from_slice(
            b"--B123\r\nContent-Disposition: form-data; name=\"avatar\"; filename=\"pic.png\"\r\nContent-Type: image/png\r\n\r\n",
        );
        raw_body.extend_from_slice(png_bytes);
        raw_body.extend_from_slice(b"\r\n--B123--\r\n");

        let mut detail = sample_sessions().remove(0);
        detail.request_headers = vec![
            HeaderPair {
                name: "Content-Type".into(),
                value: "multipart/form-data; boundary=B123".into(),
                raw_bytes_b64: None,
            },
            HeaderPair {
                name: "Content-Length".into(),
                value: raw_body.len().to_string(),
                raw_bytes_b64: None,
            },
        ];
        detail.request_body_base64 = base64::engine::general_purpose::STANDARD.encode(&raw_body);
        detail.request_body_text = None;

        let sanitized = sanitize_sessions(
            &[detail],
            &SanitizationOptions {
                redact_auth_headers: true,
                custom_redacted_headers: Vec::new(),
                mask_json_keys: vec!["password".into(), "api_key".into()],
                strip_query_params: Vec::new(),
                anonymize_client_info: false,
                replacement_text: "[MASKED]".into(),
            },
        );
        let out_bytes = base64::engine::general_purpose::STANDARD
            .decode(&sanitized[0].request_body_base64)
            .unwrap();
        let needle_pw = b"my-secret-pw";
        assert!(!out_bytes.windows(needle_pw.len()).any(|w| w == needle_pw));
        assert!(!out_bytes.windows(b"k_live_999".len()).any(|w| w == b"k_live_999"));
        assert!(out_bytes.windows(b"[MASKED]".len()).any(|w| w == b"[MASKED]"));
        assert!(out_bytes.windows(b"public".len()).any(|w| w == b"public"));
        assert!(
            out_bytes.windows(png_bytes.len()).any(|w| w == png_bytes),
            "binary attachment bytes must stay untouched"
        );
    }

    #[test]
    fn sanitize_urlencoded_handles_crlf_line_endings() {
        let masked = sanitize::sanitize_body_payload(
            "user=alice&password=secret123\r\n",
            Some("application/x-www-form-urlencoded"),
            &["password".into()],
            "[REDACTED]",
            true,
        )
        .expect("should mask password with CRLF");
        assert_eq!(masked, "user=alice&password=[REDACTED]\r\n");

        let auto_detected = sanitize::sanitize_body_payload(
            "foo=bar&\r\npassword=top_secret",
            None,
            &["password".into()],
            "[REDACTED]",
            true,
        )
        .expect("is_likely_urlencoded_form must accept CRLF");
        assert_eq!(auto_detected, "foo=bar&\r\npassword=[REDACTED]");
    }

    #[test]
    fn read_saz_rejects_archive_over_50000_entries() {
        let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
        {
            let mut zw = ZipWriter::new(&mut cursor);
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            for i in 0..=MAX_SAZ_ARCHIVE_ENTRIES {
                zw.start_file(format!("raw/e{i}.txt"), opts).unwrap();
            }
            zw.finish().unwrap();
        }
        cursor.set_position(0);
        let err = read_saz_from_reader(cursor).expect_err("must reject > 50_000 SAZ entries");
        let msg = err.to_string();
        assert!(
            msg.contains("50000") || msg.contains("слишком много"),
            "unexpected error: {msg}"
        );
    }

    #[test]
    fn streaming_exporter_roundtrips_har_saz_json_and_raw() {
        let sessions = sample_sessions();
        for ext in ["har", "saz", "json", "txt"] {
            let path = unique_temp_path(&format!("stream_roundtrip.{ext}"));
            let _ = std::fs::remove_file(&path);
            let count = export_sessions_to_path(&sessions, ext, &path).expect("export");
            assert_eq!(count, sessions.len());
            if ext != "txt" {
                let reimported = import_sessions_from_path(&path).expect("reimport");
                assert_eq!(reimported.len(), sessions.len());
            } else {
                let raw = std::fs::read(&path).unwrap();
                let txt = String::from_utf8_lossy(&raw);
                assert!(txt.contains("auth.fluxproxy.dev"));
            }
            let _ = std::fs::remove_file(&path);
        }
    }
}
