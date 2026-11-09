use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Cursor, Read, Seek, Write};
use std::path::Path;

use base64::Engine as _;
use chrono::{DateTime, Duration, SecondsFormat, TimeZone, Utc};
use flate2::read::{DeflateDecoder, GzDecoder, ZlibDecoder};
use serde::{Deserialize, Deserializer, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::models::{
    HeaderPair, ProxyError, SessionDetail, SessionSummary, SseEventRecord, WebSocketFrameRecord,
};

// ============================================================================
// HAR 1.2 Data Model (W3C / Jan Odvarko Spec + Chrome DevTools Extensions)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarRoot {
    pub log: HarLog,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarLog {
    #[serde(default = "default_har_version")]
    pub version: String,
    #[serde(default = "default_har_creator")]
    pub creator: HarCreator,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<HarCreator>,
    #[serde(default)]
    pub pages: Vec<HarPage>,
    #[serde(default)]
    pub entries: Vec<HarEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

fn default_har_version() -> String {
    "1.2".to_string()
}

fn default_har_creator() -> HarCreator {
    HarCreator {
        name: "FluxProxy".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        comment: None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarCreator {
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub name: String,
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarPage {
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub started_date_time: String,
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub id: String,
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub title: String,
    #[serde(default)]
    pub page_timings: HarPageTimings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarPageTimings {
    #[serde(default = "default_neg_one", deserialize_with = "de_f64_or_neg_one")]
    pub on_content_load: f64,
    #[serde(default = "default_neg_one", deserialize_with = "de_f64_or_neg_one")]
    pub on_load: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

impl Default for HarPageTimings {
    fn default() -> Self {
        Self {
            on_content_load: -1.0,
            on_load: -1.0,
            comment: None,
        }
    }
}

fn default_neg_one() -> f64 {
    -1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pageref: Option<String>,
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub started_date_time: String,
    #[serde(default, deserialize_with = "de_f64_non_neg")]
    pub time: f64,
    pub request: HarRequest,
    pub response: HarResponse,
    #[serde(default)]
    pub cache: HarCache,
    #[serde(default)]
    pub timings: HarTimings,
    #[serde(
        default,
        rename = "serverIPAddress",
        alias = "serverIpAddress",
        skip_serializing_if = "Option::is_none"
    )]
    pub server_ip_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(
        default,
        rename = "_resourceType",
        skip_serializing_if = "Option::is_none"
    )]
    pub resource_type: Option<String>,
    #[serde(
        default,
        rename = "_webSocketMessages",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub web_socket_messages: Vec<HarWebSocketMessage>,
    #[serde(
        default,
        rename = "_fluxProxy",
        skip_serializing_if = "Option::is_none"
    )]
    pub flux_proxy: Option<FluxProxyHarExt>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarRequest {
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub method: String,
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub url: String,
    #[serde(default = "default_http_version", deserialize_with = "de_string_or_empty")]
    pub http_version: String,
    #[serde(default)]
    pub cookies: Vec<HarCookie>,
    #[serde(default)]
    pub headers: Vec<HarNameValue>,
    #[serde(default)]
    pub query_string: Vec<HarNameValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_data: Option<HarPostData>,
    #[serde(default = "default_neg_one_i64", deserialize_with = "de_i64_or_neg_one")]
    pub headers_size: i64,
    #[serde(default, deserialize_with = "de_i64_or_zero")]
    pub body_size: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarResponse {
    #[serde(default, deserialize_with = "de_u16_or_zero")]
    pub status: u16,
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub status_text: String,
    #[serde(default = "default_http_version", deserialize_with = "de_string_or_empty")]
    pub http_version: String,
    #[serde(default)]
    pub cookies: Vec<HarCookie>,
    #[serde(default)]
    pub headers: Vec<HarNameValue>,
    #[serde(default)]
    pub content: HarContent,
    #[serde(
        default,
        rename = "redirectURL",
        alias = "redirectUrl",
        deserialize_with = "de_string_or_empty"
    )]
    pub redirect_url: String,
    #[serde(default = "default_neg_one_i64", deserialize_with = "de_i64_or_neg_one")]
    pub headers_size: i64,
    #[serde(default, deserialize_with = "de_i64_or_zero")]
    pub body_size: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

fn default_http_version() -> String {
    "HTTP/1.1".to_string()
}

fn default_neg_one_i64() -> i64 {
    -1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarNameValue {
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub name: String,
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarCookie {
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub name: String,
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarPostData {
    #[serde(default = "default_mime_type", deserialize_with = "de_string_or_empty")]
    pub mime_type: String,
    #[serde(default)]
    pub params: Vec<HarPostParam>,
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarPostParam {
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarContent {
    #[serde(default, deserialize_with = "de_i64_or_zero")]
    pub size: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compression: Option<i64>,
    #[serde(default = "default_mime_type", deserialize_with = "de_string_or_mime")]
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

impl Default for HarContent {
    fn default() -> Self {
        Self {
            size: 0,
            compression: None,
            mime_type: default_mime_type(),
            text: None,
            encoding: None,
            comment: None,
        }
    }
}

fn default_mime_type() -> String {
    "application/octet-stream".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarCache {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_request: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_request: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarTimings {
    #[serde(default = "default_neg_one", deserialize_with = "de_f64_or_neg_one")]
    pub blocked: f64,
    #[serde(default = "default_neg_one", deserialize_with = "de_f64_or_neg_one")]
    pub dns: f64,
    #[serde(default = "default_neg_one", deserialize_with = "de_f64_or_neg_one")]
    pub connect: f64,
    #[serde(default, deserialize_with = "de_f64_non_neg")]
    pub send: f64,
    #[serde(default, deserialize_with = "de_f64_non_neg")]
    pub wait: f64,
    #[serde(default, deserialize_with = "de_f64_non_neg")]
    pub receive: f64,
    #[serde(default = "default_neg_one", deserialize_with = "de_f64_or_neg_one")]
    pub ssl: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

impl Default for HarTimings {
    fn default() -> Self {
        Self {
            blocked: -1.0,
            dns: -1.0,
            connect: -1.0,
            send: 0.0,
            wait: 0.0,
            receive: 0.0,
            ssl: -1.0,
            comment: None,
        }
    }
}

/// Chrome DevTools `_webSocketMessages` entry schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarWebSocketMessage {
    #[serde(rename = "type", default, deserialize_with = "de_string_or_empty")]
    pub msg_type: String, // "send" | "receive"
    #[serde(default, deserialize_with = "de_f64_non_neg")]
    pub time: f64, // Epoch seconds
    #[serde(default)]
    pub opcode: u8, // 1 = text, 2 = binary, 8 = close, 9 = ping, 10 = pong
    #[serde(default, deserialize_with = "de_string_or_empty")]
    pub data: String,
}

/// Underscore-prefixed HAR 1.2 custom extension preserving FluxProxy metadata on roundtrip.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FluxProxyHarExt {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheme: Option<String>,
    #[serde(default)]
    pub is_mocked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_rule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_pid: Option<u32>,
    #[serde(default)]
    pub tls_bypassed: bool,
    #[serde(default)]
    pub headers_mutated: bool,
    #[serde(default)]
    pub breakpoint_modified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marked_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_addr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_body_base64: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub websocket_frames: Vec<WebSocketFrameRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sse_events: Vec<SseEventRecord>,
}

// ============================================================================
// Lenient Serde Deserializers for Third-Party HAR Compatibility
// ============================================================================

fn de_string_or_empty<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let opt = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match opt {
        Some(serde_json::Value::String(s)) => s,
        Some(serde_json::Value::Number(n)) => n.to_string(),
        Some(serde_json::Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    })
}

fn de_string_or_mime<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let s = de_string_or_empty(deserializer)?;
    if s.trim().is_empty() {
        Ok(default_mime_type())
    } else {
        Ok(s)
    }
}

fn de_f64_or_neg_one<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    let opt = Option::<f64>::deserialize(deserializer)?;
    Ok(opt.unwrap_or(-1.0))
}

fn de_f64_non_neg<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    let opt = Option::<f64>::deserialize(deserializer)?;
    Ok(opt.unwrap_or(0.0).max(0.0))
}

fn de_i64_or_neg_one<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let opt = Option::<f64>::deserialize(deserializer)?;
    Ok(opt.map(|v| v.round() as i64).unwrap_or(-1))
}

fn de_i64_or_zero<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let opt = Option::<f64>::deserialize(deserializer)?;
    Ok(opt.map(|v| v.round() as i64).unwrap_or(0))
}

fn de_u16_or_zero<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    let opt = Option::<i64>::deserialize(deserializer)?;
    Ok(opt
        .and_then(|v| u16::try_from(v.clamp(0, u16::MAX as i64)).ok())
        .unwrap_or(0))
}

// ============================================================================
// Public Export / Import Entry Points
// ============================================================================

/// Serializes `SessionDetail` items into a valid HAR 1.2 JSON string compatible with
/// Chrome DevTools (`Network -> Import HAR`), Firefox DevTools, Charles, and Fiddler.
pub fn serialize_har_1_2(sessions: &[SessionDetail]) -> Result<String, ProxyError> {
    let page_id = "page_1".to_string();
    let page_started = sessions
        .first()
        .map(|s| normalize_iso8601_timestamp(&s.summary.timestamp))
        .unwrap_or_else(|| Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));

    let pages = if sessions.is_empty() {
        Vec::new()
    } else {
        vec![HarPage {
            started_date_time: page_started,
            id: page_id.clone(),
            title: "FluxProxy Capture".to_string(),
            page_timings: HarPageTimings::default(),
            comment: None,
        }]
    };

    let entries: Vec<HarEntry> = sessions
        .iter()
        .map(|detail| session_to_har_entry(detail, Some(page_id.clone())))
        .collect();

    let har = HarRoot {
        log: HarLog {
            version: "1.2".to_string(),
            creator: default_har_creator(),
            browser: None,
            pages,
            entries,
            comment: None,
        },
    };

    serde_json::to_string_pretty(&har)
        .map_err(|e| ProxyError::Custom(format!("Ошибка сериализации HAR 1.2: {e}")))
}

/// Deserializes a HAR 1.2 JSON string (from FluxProxy, Chrome DevTools, Firefox, Charles, etc.)
/// into `Vec<SessionDetail>`.
pub fn deserialize_har_1_2(json_str: &str) -> Result<Vec<SessionDetail>, ProxyError> {
    let trimmed = json_str.trim_start_matches('\u{feff}').trim();
    let root: HarRoot = serde_json::from_str(trimmed)
        .map_err(|e| ProxyError::Custom(format!("Некорректный формат HAR 1.2: {e}")))?;

    let mut out = Vec::with_capacity(root.log.entries.len());
    for (idx, entry) in root.log.entries.iter().enumerate() {
        out.push(har_entry_to_session(entry, (idx + 1) as u64));
    }
    Ok(out)
}

/// Writes `SessionDetail` items into a Fiddler Classic `.saz` (Session Archive Zip) stream.
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

        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf)?;

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
        );
        sessions.push(detail);
    }

    Ok(sessions)
}

/// Reads a Fiddler Classic `.saz` archive from disk.
pub fn read_saz_file(path: &Path) -> Result<Vec<SessionDetail>, ProxyError> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    read_saz_from_reader(reader)
}

/// Serializes `SessionDetail` items as a FluxProxy JSON array.
pub fn serialize_json_archive(sessions: &[SessionDetail]) -> Result<String, ProxyError> {
    serde_json::to_string_pretty(sessions)
        .map_err(|e| ProxyError::Custom(format!("Ошибка сериализации JSON архива: {e}")))
}

/// Deserializes a JSON string containing either a HAR 1.2 object (`{ "log": ... }`)
/// or a native FluxProxy `Vec<SessionDetail>` array (`[ ... ]`).
pub fn deserialize_json_or_har(json_str: &str) -> Result<Vec<SessionDetail>, ProxyError> {
    let trimmed = json_str.trim_start_matches('\u{feff}').trim();
    if trimmed.starts_with('[') {
        let list: Vec<SessionDetail> = serde_json::from_str(trimmed)
            .map_err(|e| ProxyError::Custom(format!("Некорректный JSON-архив сессий: {e}")))?;
        return Ok(list);
    }
    if let Ok(har_sessions) = deserialize_har_1_2(trimmed) {
        return Ok(har_sessions);
    }
    let single: SessionDetail = serde_json::from_str(trimmed).map_err(|e| {
        ProxyError::Custom(format!(
            "Файл не распознан ни как HAR 1.2, ни как JSON-список сессий: {e}"
        ))
    })?;
    Ok(vec![single])
}

/// Serializes one or more sessions into a human- & tool-readable Raw HTTP Message dump (`.txt`),
/// preserving binary bodies losslessly when single-session or UTF-8 safe representation.
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

/// Unified exporter supporting `"har"`, `"saz"`, `"json"`, and `"raw"` / `"txt"` formats.
pub fn export_sessions_to_path(
    sessions: &[SessionDetail],
    format: &str,
    path: &Path,
) -> Result<usize, ProxyError> {
    let fmt = normalize_export_format(format, path);
    match fmt.as_str() {
        "saz" => write_saz_file(path, sessions),
        "har" => {
            let har_json = serialize_har_1_2(sessions)?;
            write_raw_bytes_to_file(path, har_json.as_bytes())?;
            Ok(sessions.len())
        }
        "json" => {
            let raw_json = serialize_json_archive(sessions)?;
            write_raw_bytes_to_file(path, raw_json.as_bytes())?;
            Ok(sessions.len())
        }
        "raw" | "txt" => {
            let raw_http = serialize_full_raw_http(sessions);
            write_raw_bytes_to_file(path, &raw_http)?;
            Ok(sessions.len())
        }
        other => Err(ProxyError::Custom(format!(
            "Неподдерживаемый формат экспорта: '{other}' (ожидается har, saz, json или txt)"
        ))),
    }
}

/// Unified importer reading `.saz`, `.har`, or `.json` from disk (auto-detecting ZIP magic & JSON shape).
pub fn import_sessions_from_path(path: &Path) -> Result<Vec<SessionDetail>, ProxyError> {
    if !path.exists() {
        return Err(ProxyError::Custom(format!(
            "Файл не найден: {}",
            path.display()
        )));
    }
    let bytes = std::fs::read(path)?;
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

/// Extracts raw decoded bytes from a `SessionDetail`'s request or response fields.
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
// HAR 1.2 Conversion Helpers
// ============================================================================

fn session_to_har_entry(detail: &SessionDetail, pageref: Option<String>) -> HarEntry {
    let s = &detail.summary;
    let started_date_time = normalize_iso8601_timestamp(&s.timestamp);
    let total_ms = s.duration_ms as f64;
    let http_version = protocol_to_har_http_version(&s.protocol);

    let full_url = ensure_valid_har_url(&s.url, &s.scheme, &s.host, &s.path);
    let query_string = parse_query_params_from_url(&full_url);
    let req_cookies = parse_request_cookies(&detail.request_headers);
    let resp_cookies = parse_response_set_cookies(&detail.response_headers);

    let req_bytes = decode_detail_body_bytes(detail, false);
    let resp_bytes = decode_detail_body_bytes(detail, true);

    let req_mime = find_header_value(&detail.request_headers, "content-type")
        .map(str::to_string)
        .unwrap_or_else(default_mime_type);

    let post_data = if !req_bytes.is_empty() {
        let (text, comment) = match std::str::from_utf8(&req_bytes) {
            Ok(utf8) => (utf8.to_string(), None),
            Err(_) => (
                base64::engine::general_purpose::STANDARD.encode(&req_bytes),
                Some("base64".to_string()),
            ),
        };
        let params = if req_mime
            .to_ascii_lowercase()
            .starts_with("application/x-www-form-urlencoded")
        {
            parse_urlencoded_pairs(&text)
                .into_iter()
                .map(|(name, value)| HarPostParam {
                    name,
                    value: Some(value),
                    file_name: None,
                    content_type: None,
                    comment: None,
                })
                .collect()
        } else {
            Vec::new()
        };
        Some(HarPostData {
            mime_type: req_mime,
            params,
            text,
            comment,
        })
    } else {
        None
    };

    let resp_mime = if !s.content_type.trim().is_empty() {
        s.content_type.clone()
    } else {
        find_header_value(&detail.response_headers, "content-type")
            .map(str::to_string)
            .unwrap_or_else(default_mime_type)
    };

    let (content_text, content_encoding) = if resp_bytes.is_empty() {
        (None, None)
    } else if !is_likely_binary_mime(&resp_mime) {
        match std::str::from_utf8(&resp_bytes) {
            Ok(utf8) => (Some(utf8.to_string()), None),
            Err(_) => (
                Some(base64::engine::general_purpose::STANDARD.encode(&resp_bytes)),
                Some("base64".to_string()),
            ),
        }
    } else {
        (
            Some(base64::engine::general_purpose::STANDARD.encode(&resp_bytes)),
            Some("base64".to_string()),
        )
    };

    let content_size = if !resp_bytes.is_empty() {
        resp_bytes.len() as i64
    } else {
        s.body_size as i64
    };

    let redirect_url = find_header_value(&detail.response_headers, "location")
        .unwrap_or("")
        .to_string();

    let req_headers_size = estimate_http_headers_size(
        &format!("{} {} {}", s.method, s.path, http_version),
        &detail.request_headers,
    );
    let status_text = canonical_status_reason(s.status).to_string();
    let resp_headers_size = estimate_http_headers_size(
        &format!("{} {} {}", http_version, s.status, status_text),
        &detail.response_headers,
    );

    let start_epoch_sec = chrono::DateTime::parse_from_rfc3339(&started_date_time)
        .map(|dt| dt.timestamp_millis() as f64 / 1000.0)
        .unwrap_or(0.0);

    let web_socket_messages: Vec<HarWebSocketMessage> = detail
        .websocket_frames
        .iter()
        .map(|frame| {
            let frame_time = chrono::DateTime::parse_from_rfc3339(&frame.timestamp)
                .map(|dt| dt.timestamp_millis() as f64 / 1000.0)
                .unwrap_or(start_epoch_sec);
            HarWebSocketMessage {
                msg_type: if frame.direction == "outbound" {
                    "send".to_string()
                } else {
                    "receive".to_string()
                },
                time: frame_time.max(0.0),
                opcode: match frame.opcode.as_str() {
                    "text" => 1,
                    "binary" => 2,
                    "close" => 8,
                    "ping" => 9,
                    "pong" => 10,
                    _ => 1,
                },
                data: frame.payload_preview.clone(),
            }
        })
        .collect();

    let resource_type = Some(infer_devtools_resource_type(
        &s.protocol,
        &s.scheme,
        &resp_mime,
    ));

    let flux_ext = FluxProxyHarExt {
        original_id: Some(s.id),
        protocol: Some(s.protocol.clone()),
        scheme: Some(s.scheme.clone()),
        is_mocked: s.is_mocked,
        matched_rule_id: s.matched_rule_id.clone(),
        error: s.error.clone(),
        process_name: s.process_name.clone(),
        process_pid: s.process_pid,
        tls_bypassed: s.tls_bypassed,
        headers_mutated: s.headers_mutated,
        breakpoint_modified: s.breakpoint_modified,
        marked_color: s.marked_color.clone(),
        client_ip: s.client_ip.clone(),
        client_addr: if detail.client_addr.is_empty() {
            None
        } else {
            Some(detail.client_addr.clone())
        },
        tls_version: detail.tls_version.clone(),
        request_body_base64: if req_bytes.is_empty() {
            None
        } else {
            Some(base64::engine::general_purpose::STANDARD.encode(&req_bytes))
        },
        websocket_frames: detail.websocket_frames.clone(),
        sse_events: detail.sse_events.clone(),
    };

    HarEntry {
        pageref,
        started_date_time,
        time: total_ms,
        request: HarRequest {
            method: if s.method.is_empty() {
                "GET".to_string()
            } else {
                s.method.clone()
            },
            url: full_url,
            http_version: http_version.clone(),
            cookies: req_cookies,
            headers: detail
                .request_headers
                .iter()
                .map(|h| HarNameValue {
                    name: h.name.clone(),
                    value: h.value.clone(),
                    comment: None,
                })
                .collect(),
            query_string,
            post_data,
            headers_size: req_headers_size,
            body_size: req_bytes.len() as i64,
            comment: None,
        },
        response: HarResponse {
            status: s.status,
            status_text,
            http_version,
            cookies: resp_cookies,
            headers: detail
                .response_headers
                .iter()
                .map(|h| HarNameValue {
                    name: h.name.clone(),
                    value: h.value.clone(),
                    comment: None,
                })
                .collect(),
            content: HarContent {
                size: content_size,
                compression: None,
                mime_type: resp_mime,
                text: content_text,
                encoding: content_encoding,
                comment: None,
            },
            redirect_url,
            headers_size: resp_headers_size,
            body_size: resp_bytes.len() as i64,
            comment: None,
        },
        cache: HarCache::default(),
        timings: HarTimings {
            blocked: -1.0,
            dns: -1.0,
            connect: -1.0,
            send: 0.0,
            wait: total_ms,
            receive: 0.0,
            ssl: -1.0,
            comment: None,
        },
        server_ip_address: None,
        connection: None,
        comment: s.comment.clone(),
        resource_type,
        web_socket_messages,
        flux_proxy: Some(flux_ext),
    }
}

fn har_entry_to_session(entry: &HarEntry, fallback_id: u64) -> SessionDetail {
    let ext = entry.flux_proxy.as_ref();

    let request_headers: Vec<HeaderPair> = entry
        .request
        .headers
        .iter()
        .map(|h| HeaderPair {
            name: h.name.clone(),
            value: h.value.clone(),
        })
        .collect();

    let response_headers: Vec<HeaderPair> = entry
        .response
        .headers
        .iter()
        .map(|h| HeaderPair {
            name: h.name.clone(),
            value: h.value.clone(),
        })
        .collect();

    let (parsed_scheme, parsed_host, parsed_path) =
        split_url_components(&entry.request.url, &request_headers);

    let scheme = ext
        .and_then(|x| x.scheme.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or(parsed_scheme);

    let protocol = ext
        .and_then(|x| x.protocol.clone())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| {
            har_http_version_to_protocol(
                &entry.request.http_version,
                &scheme,
                !entry.web_socket_messages.is_empty(),
            )
        });

    let url = if entry.request.url.contains("://") {
        entry.request.url.clone()
    } else if !parsed_host.is_empty() {
        format!("{scheme}://{parsed_host}{parsed_path}")
    } else {
        entry.request.url.clone()
    };

    // Reconstruct Request Body
    let req_bytes: Vec<u8> = if let Some(b64) = ext
        .and_then(|x| x.request_body_base64.as_deref())
        .filter(|s| !s.is_empty())
    {
        base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .unwrap_or_default()
    } else if let Some(pd) = &entry.request.post_data {
        if pd.comment.as_deref() == Some("base64") {
            base64::engine::general_purpose::STANDARD
                .decode(pd.text.trim())
                .unwrap_or_else(|_| pd.text.as_bytes().to_vec())
        } else if !pd.text.is_empty() {
            pd.text.as_bytes().to_vec()
        } else if !pd.params.is_empty() {
            pd.params
                .iter()
                .map(|p| {
                    format!(
                        "{}={}",
                        url_encode_component(&p.name),
                        url_encode_component(p.value.as_deref().unwrap_or(""))
                    )
                })
                .collect::<Vec<_>>()
                .join("&")
                .into_bytes()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    let request_body_base64 = if req_bytes.is_empty() {
        String::new()
    } else {
        base64::engine::general_purpose::STANDARD.encode(&req_bytes)
    };
    let request_body_text = if req_bytes.is_empty() {
        None
    } else {
        std::str::from_utf8(&req_bytes).ok().map(str::to_owned)
    };

    // Reconstruct Response Body
    let resp_bytes: Vec<u8> = match &entry.response.content.text {
        Some(txt) if !txt.is_empty() => {
            let is_b64 = entry
                .response
                .content
                .encoding
                .as_deref()
                .is_some_and(|enc| enc.eq_ignore_ascii_case("base64"));
            if is_b64 {
                let cleaned: String = txt.chars().filter(|c| !c.is_whitespace()).collect();
                base64::engine::general_purpose::STANDARD
                    .decode(&cleaned)
                    .unwrap_or_else(|_| txt.as_bytes().to_vec())
            } else {
                txt.as_bytes().to_vec()
            }
        }
        _ => Vec::new(),
    };

    let response_body_base64 = if resp_bytes.is_empty() {
        String::new()
    } else {
        base64::engine::general_purpose::STANDARD.encode(&resp_bytes)
    };
    let response_body_text = if resp_bytes.is_empty() {
        None
    } else {
        std::str::from_utf8(&resp_bytes).ok().map(str::to_owned)
    };

    let body_size = if !resp_bytes.is_empty() {
        resp_bytes.len()
    } else if entry.response.content.size > 0 {
        entry.response.content.size as usize
    } else if entry.response.body_size > 0 {
        entry.response.body_size as usize
    } else {
        0
    };

    let content_type = if !entry.response.content.mime_type.trim().is_empty()
        && entry.response.content.mime_type != "application/octet-stream"
    {
        entry.response.content.mime_type.clone()
    } else {
        find_header_value(&response_headers, "content-type")
            .unwrap_or(&entry.response.content.mime_type)
            .to_string()
    };

    let duration_ms = if entry.time > 0.0 {
        entry.time.round() as u64
    } else {
        let sum = [
            entry.timings.blocked,
            entry.timings.dns,
            entry.timings.connect,
            entry.timings.send,
            entry.timings.wait,
            entry.timings.receive,
        ]
        .into_iter()
        .filter(|v| *v > 0.0)
        .sum::<f64>();
        sum.max(0.0).round() as u64
    };

    let timestamp = normalize_iso8601_timestamp(&entry.started_date_time);

    let websocket_frames = if let Some(frames) = ext
        .map(|x| &x.websocket_frames)
        .filter(|f| !f.is_empty())
    {
        frames.clone()
    } else {
        entry
            .web_socket_messages
            .iter()
            .enumerate()
            .map(|(idx, msg)| {
                let ts = if msg.time > 0.0 {
                    let millis = (msg.time * 1000.0).round() as i64;
                    Utc.timestamp_millis_opt(millis)
                        .single()
                        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
                        .unwrap_or_else(|| timestamp.clone())
                } else {
                    timestamp.clone()
                };
                WebSocketFrameRecord {
                    index: idx + 1,
                    direction: if msg.msg_type.eq_ignore_ascii_case("send") {
                        "outbound".to_string()
                    } else {
                        "inbound".to_string()
                    },
                    opcode: match msg.opcode {
                        2 => "binary".to_string(),
                        8 => "close".to_string(),
                        9 => "ping".to_string(),
                        10 => "pong".to_string(),
                        _ => "text".to_string(),
                    },
                    byte_length: msg.data.len(),
                    payload_preview: msg.data.clone(),
                    timestamp: ts,
                }
            })
            .collect()
    };

    let sse_events = ext.map(|x| x.sse_events.clone()).unwrap_or_default();

    SessionDetail {
        summary: SessionSummary {
            id: ext.and_then(|x| x.original_id).unwrap_or(fallback_id),
            status: entry.response.status,
            protocol,
            scheme,
            method: if entry.request.method.trim().is_empty() {
                "GET".to_string()
            } else {
                entry.request.method.trim().to_uppercase()
            },
            host: parsed_host,
            path: parsed_path,
            url,
            content_type,
            body_size,
            duration_ms,
            timestamp,
            is_mocked: ext.is_some_and(|x| x.is_mocked),
            matched_rule_id: ext.and_then(|x| x.matched_rule_id.clone()),
            error: ext.and_then(|x| x.error.clone()),
            process_name: ext.and_then(|x| x.process_name.clone()),
            process_pid: ext.and_then(|x| x.process_pid),
            tls_bypassed: ext.is_some_and(|x| x.tls_bypassed),
            headers_mutated: ext.is_some_and(|x| x.headers_mutated),
            breakpoint_paused: None,
            breakpoint_modified: ext.is_some_and(|x| x.breakpoint_modified),
            comment: entry.comment.clone(),
            marked_color: ext.and_then(|x| x.marked_color.clone()),
            client_ip: ext.and_then(|x| x.client_ip.clone()),
        },
        request_headers,
        response_headers,
        request_body_base64,
        response_body_base64,
        request_body_text,
        response_body_text,
        tls_version: ext.and_then(|x| x.tls_version.clone()),
        client_addr: ext
            .and_then(|x| x.client_addr.clone())
            .unwrap_or_else(|| "imported".to_string()),
        websocket_frames,
        sse_events,
        body_offloaded: false,
        request_body_offloaded: false,
    }
}

// ============================================================================
// Fiddler Classic SAZ (.saz) Builder & Reader Implementation
// ============================================================================

const SAZ_CONTENT_TYPES_XML: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="htm" ContentType="text/html" />
  <Default Extension="txt" ContentType="application/octet-stream" />
  <Default Extension="xml" ContentType="application/xml" />
</Types>"#;

fn build_saz_index_html(sessions: &[SessionDetail], pad_width: usize) -> String {
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

fn build_raw_http_request_bytes(detail: &SessionDetail) -> Vec<u8> {
    let s = &detail.summary;
    let body = decode_detail_body_bytes(detail, false);
    let http_version = wire_http_version(&s.protocol);
    let target = if s.method.eq_ignore_ascii_case("CONNECT") {
        if s.host.contains(':') {
            s.host.clone()
        } else {
            format!("{}:443", s.host)
        }
    } else if !s.url.is_empty() && s.url.contains("://") {
        s.url.clone()
    } else if !s.path.is_empty() {
        s.path.clone()
    } else {
        "/".to_string()
    };

    let method = if s.method.is_empty() { "GET" } else { &s.method };
    let mut head = format!("{method} {target} {http_version}\r\n");

    let mut has_host = false;
    let mut has_content_len = false;
    for h in &detail.request_headers {
        let lower = h.name.to_ascii_lowercase();
        if lower == "host" {
            has_host = true;
        }
        // Decoded body bytes are written directly; omit stale chunked/compressed framing headers
        if lower == "transfer-encoding" {
            continue;
        }
        if lower == "content-encoding" && !is_matching_compressed_magic(&h.value, &body) {
            continue;
        }
        if lower == "content-length" {
            has_content_len = true;
            head.push_str(&format!("{}: {}\r\n", h.name, body.len()));
            continue;
        }
        head.push_str(&format!("{}: {}\r\n", h.name, h.value));
    }

    if !has_host && !s.host.is_empty() {
        head.push_str(&format!("Host: {}\r\n", s.host));
    }
    if !has_content_len && !body.is_empty() {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");

    let mut out = head.into_bytes();
    out.extend_from_slice(&body);
    out
}

fn build_raw_http_response_bytes(detail: &SessionDetail) -> Vec<u8> {
    let s = &detail.summary;
    let body = decode_detail_body_bytes(detail, true);
    if s.status == 0 && detail.response_headers.is_empty() && body.is_empty() {
        return Vec::new();
    }

    let http_version = wire_http_version(&s.protocol);
    let status = if s.status == 0 { 200 } else { s.status };
    let reason = canonical_status_reason(status);
    let mut head = format!("{http_version} {status} {reason}\r\n");

    let mut has_content_len = false;
    let mut has_content_type = false;

    for h in &detail.response_headers {
        let lower = h.name.to_ascii_lowercase();
        if lower == "transfer-encoding" {
            continue;
        }
        if lower == "content-encoding" && !is_matching_compressed_magic(&h.value, &body) {
            continue;
        }
        if lower == "content-length" {
            has_content_len = true;
            head.push_str(&format!("{}: {}\r\n", h.name, body.len()));
            continue;
        }
        if lower == "content-type" {
            has_content_type = true;
        }
        head.push_str(&format!("{}: {}\r\n", h.name, h.value));
    }

    if !has_content_type && !s.content_type.trim().is_empty() {
        head.push_str(&format!("Content-Type: {}\r\n", s.content_type));
    }
    if !has_content_len {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");

    let mut out = head.into_bytes();
    out.extend_from_slice(&body);
    out
}

fn build_saz_metadata_xml(detail: &SessionDetail, sid: usize) -> String {
    let s = &detail.summary;
    let start_dt = parse_timestamp_utc(&s.timestamp).unwrap_or_else(Utc::now);
    let end_dt = start_dt + Duration::milliseconds(s.duration_ms as i64);

    let start_str = start_dt.to_rfc3339_opts(SecondsFormat::Micros, true);
    let end_str = end_dt.to_rfc3339_opts(SecondsFormat::Micros, true);

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
          <SessionTimers ClientConnected=\"{start_str}\" ClientBeginRequest=\"{start_str}\" GotRequestHeaders=\"{start_str}\" ClientDoneRequest=\"{start_str}\" GatewayTime=\"0\" DNSTime=\"0\" TCPConnectTime=\"0\" HTTPSHandshakeTime=\"0\" ServerConnected=\"{start_str}\" FiddlerBeginRequest=\"{start_str}\" ServerGotRequest=\"{start_str}\" ServerBeginResponse=\"{end_str}\" GotResponseHeaders=\"{end_str}\" ServerDoneResponse=\"{end_str}\" ClientBeginResponse=\"{end_str}\" ClientDoneResponse=\"{end_str}\" />\r\n\
          <PipeInfo CltReuse=\"false\" Reused=\"false\" />\r\n\
          <SessionFlags>\r\n{flags_xml}  </SessionFlags>\r\n\
        </Session>\r\n"
    )
}

fn build_saz_websocket_log(frames: &[WebSocketFrameRecord]) -> String {
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

fn parse_saz_websocket_log(raw: &str) -> Vec<WebSocketFrameRecord> {
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
struct ParsedSazMeta {
    bit_flags: u32,
    start_time: Option<DateTime<Utc>>,
    end_time: Option<DateTime<Utc>>,
    flags: BTreeMap<String, String>,
}

fn parse_saz_metadata_xml(xml: &str) -> ParsedSazMeta {
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
        meta.start_time = ["ClientBeginRequest", "ClientConnected", "FiddlerBeginRequest", "ServerConnected"]
            .into_iter()
            .find_map(|attr| extract_xml_attr(timers_tag, attr))
            .and_then(|v| parse_fiddler_timestamp(&v));

        meta.end_time = ["ClientDoneResponse", "ServerDoneResponse", "GotResponseHeaders", "ServerBeginResponse"]
            .into_iter()
            .find_map(|attr| extract_xml_attr(timers_tag, attr))
            .and_then(|v| parse_fiddler_timestamp(&v));
    }

    let mut search_from = 0usize;
    while let Some(rel_pos) = cleaned[search_from..].find("<SessionFlag") {
        let abs_start = search_from + rel_pos;
        let Some(rel_end) = cleaned[abs_start..].find('>') else {
            break;
        };
        let tag_slice = &cleaned[abs_start..=abs_start + rel_end];
        if let (Some(name), Some(val)) = (
            extract_xml_attr(tag_slice, "N"),
            extract_xml_attr(tag_slice, "V"),
        ) {
            meta.flags.insert(name.to_ascii_lowercase(), val);
        }
        search_from = abs_start + rel_end + 1;
    }

    meta
}

fn build_session_from_saz_parts(
    id: u64,
    client_bytes: &[u8],
    server_bytes: &[u8],
    meta_xml: Option<&str>,
    ws_text: Option<&str>,
) -> SessionDetail {
    let meta = meta_xml.map(parse_saz_metadata_xml).unwrap_or_default();

    let (req_start_line, request_headers, raw_req_body) = split_raw_http_message(client_bytes);
    let (resp_status_line, response_headers, raw_resp_body) = split_raw_http_message(server_bytes);

    let decoded_req_body = decode_http_wire_body(raw_req_body, &request_headers);
    let decoded_resp_body = decode_http_wire_body(raw_resp_body, &response_headers);

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

    SessionDetail {
        summary: SessionSummary {
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
        },
        request_headers,
        response_headers,
        request_body_base64,
        response_body_base64,
        request_body_text,
        response_body_text,
        tls_version,
        client_addr,
        websocket_frames,
        sse_events: Vec::new(),
        body_offloaded: false,
        request_body_offloaded: false,
    }
}

// ============================================================================
// HTTP Wire Parsing, Dechunking & Decompression Utilities
// ============================================================================

fn split_raw_http_message(raw: &[u8]) -> (String, Vec<HeaderPair>, &[u8]) {
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

fn decode_http_wire_body(raw_body: &[u8], headers: &[HeaderPair]) -> Vec<u8> {
    if raw_body.is_empty() {
        return Vec::new();
    }

    let is_chunked = find_header_value(headers, "transfer-encoding")
        .is_some_and(|te| te.to_ascii_lowercase().contains("chunked"));

    let unchunked = if is_chunked {
        try_decode_chunked_body(raw_body).unwrap_or_else(|| raw_body.to_vec())
    } else {
        raw_body.to_vec()
    };

    let Some(encoding) = find_header_value(headers, "content-encoding") else {
        return unchunked;
    };

    let enc_lower = encoding.trim().to_ascii_lowercase();
    if enc_lower.contains("gzip") {
        if unchunked.len() >= 2 && unchunked[0] == 0x1f && unchunked[1] == 0x8b {
            let mut out = Vec::new();
            if GzDecoder::new(unchunked.as_slice())
                .read_to_end(&mut out)
                .is_ok()
            {
                return out;
            }
        }
    } else if enc_lower == "br" || enc_lower.contains("brotli") {
        let mut out = Vec::new();
        if brotli::Decompressor::new(unchunked.as_slice(), 4096)
            .read_to_end(&mut out)
            .is_ok()
        {
            return out;
        }
    } else if enc_lower.contains("deflate") {
        let mut out = Vec::new();
        if ZlibDecoder::new(unchunked.as_slice())
            .read_to_end(&mut out)
            .is_ok()
        {
            return out;
        }
        out.clear();
        if DeflateDecoder::new(unchunked.as_slice())
            .read_to_end(&mut out)
            .is_ok()
        {
            return out;
        }
    }

    unchunked
}

fn try_decode_chunked_body(input: &[u8]) -> Option<Vec<u8>> {
    let mut pos = 0usize;
    let mut out = Vec::new();
    let mut parsed_any_chunk = false;

    while pos < input.len() {
        let line_end = find_subslice(&input[pos..], b"\r\n")?;
        let size_line = std::str::from_utf8(&input[pos..pos + line_end]).ok()?;
        let hex_part = size_line.split(';').next()?.trim();
        if hex_part.is_empty() {
            return None;
        }
        let chunk_size = usize::from_str_radix(hex_part, 16).ok()?;
        pos += line_end + 2;

        if chunk_size == 0 {
            return Some(out);
        }

        if pos + chunk_size > input.len() {
            return None;
        }
        out.extend_from_slice(&input[pos..pos + chunk_size]);
        pos += chunk_size;
        parsed_any_chunk = true;

        if pos + 2 <= input.len() && &input[pos..pos + 2] == b"\r\n" {
            pos += 2;
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

fn is_matching_compressed_magic(encoding_val: &str, body: &[u8]) -> bool {
    let lower = encoding_val.to_ascii_lowercase();
    if lower.contains("gzip") {
        return body.len() >= 2 && body[0] == 0x1f && body[1] == 0x8b;
    }
    false
}

fn parse_http_request_line(line: &str) -> (String, String, String) {
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_uppercase();
    let target = parts.next().unwrap_or("/").to_string();
    let version = parts.next().unwrap_or("HTTP/1.1").to_string();
    (method, target, version)
}

fn parse_http_status_line(line: &str) -> (String, u16) {
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

fn reconstruct_saz_url(
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
        let (host, path) = match rest.find('/') {
            Some(idx) => (rest[..idx].to_string(), rest[idx..].to_string()),
            None => (rest.to_string(), "/".to_string()),
        };
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

fn decode_xml_bytes(buf: &[u8]) -> String {
    if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&buf[3..]).into_owned()
    } else if buf.len() >= 2 && buf[0] == 0xFF && buf[1] == 0xFE {
        let u16s: Vec<u16> = buf[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(buf).into_owned()
    }
}

fn xml_escape(input: &str) -> String {
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

fn xml_unescape(input: &str) -> String {
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

fn extract_xml_tag_fragment<'a>(xml: &'a str, tag_name: &str) -> Option<&'a str> {
    let needle = format!("<{tag_name}");
    let start = xml.find(&needle)?;
    let end = xml[start..].find('>')?;
    Some(&xml[start..=start + end])
}

fn extract_xml_attr(tag: &str, attr_name: &str) -> Option<String> {
    let double_pat = format!("{attr_name}=\"");
    if let Some(idx) = tag.find(&double_pat) {
        let val_start = idx + double_pat.len();
        let val_end = tag[val_start..].find('"')?;
        return Some(xml_unescape(&tag[val_start..val_start + val_end]));
    }
    let single_pat = format!("{attr_name}='");
    if let Some(idx) = tag.find(&single_pat) {
        let val_start = idx + single_pat.len();
        let val_end = tag[val_start..].find('\'')?;
        return Some(xml_unescape(&tag[val_start..val_start + val_end]));
    }
    None
}

fn parse_fiddler_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with("0001-01-01") {
        return None;
    }
    parse_timestamp_utc(trimmed)
}

fn parse_timestamp_utc(raw: &str) -> Option<DateTime<Utc>> {
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

fn normalize_iso8601_timestamp(raw: &str) -> String {
    if let Some(dt) = parse_timestamp_utc(raw) {
        return dt.to_rfc3339_opts(SecondsFormat::Millis, true);
    }
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_fiddler_process_info(raw: &str) -> (Option<String>, Option<u32>) {
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

fn normalize_fiddler_color(raw: &str) -> String {
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

fn split_addr_ip_port(addr: &str) -> (Option<String>, Option<String>) {
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

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn find_header_value<'a>(headers: &'a [HeaderPair], target_name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case(target_name))
        .map(|h| h.value.as_str())
}

fn protocol_to_har_http_version(protocol: &str) -> String {
    let upper = protocol.trim().to_ascii_uppercase();
    if upper.contains("/2") || upper == "H2" {
        "HTTP/2.0".to_string()
    } else if upper.contains("/3") || upper == "H3" {
        "HTTP/3.0".to_string()
    } else if upper.contains("1.0") {
        "HTTP/1.0".to_string()
    } else {
        "HTTP/1.1".to_string()
    }
}

fn wire_http_version(protocol: &str) -> &'static str {
    let upper = protocol.trim().to_ascii_uppercase();
    if upper.contains("/2") || upper == "H2" {
        "HTTP/2.0"
    } else if upper.contains("1.0") {
        "HTTP/1.0"
    } else {
        "HTTP/1.1"
    }
}

fn har_http_version_to_protocol(http_version: &str, scheme: &str, is_ws: bool) -> String {
    if is_ws || scheme.eq_ignore_ascii_case("ws") || scheme.eq_ignore_ascii_case("wss") {
        return if scheme.eq_ignore_ascii_case("wss") {
            "WSS".to_string()
        } else {
            "WS".to_string()
        };
    }
    let upper = http_version.trim().to_ascii_uppercase();
    let is_tls = scheme.eq_ignore_ascii_case("https");
    if upper.contains('2') {
        if is_tls {
            "HTTPS/2".to_string()
        } else {
            "HTTP/2".to_string()
        }
    } else if upper.contains("1.0") {
        if is_tls {
            "HTTPS/1.0".to_string()
        } else {
            "HTTP/1.0".to_string()
        }
    } else if is_tls {
        "HTTPS/1.1".to_string()
    } else {
        "HTTP/1.1".to_string()
    }
}

fn ensure_valid_har_url(url: &str, scheme: &str, host: &str, path: &str) -> String {
    if url.contains("://") {
        return url.to_string();
    }
    let sch = if scheme.is_empty() { "https" } else { scheme };
    let h = if host.is_empty() { "localhost" } else { host };
    let p = if path.starts_with('/') {
        path.to_string()
    } else if path.is_empty() {
        "/".to_string()
    } else {
        format!("/{path}")
    };
    format!("{sch}://{h}{p}")
}

fn split_url_components(url: &str, headers: &[HeaderPair]) -> (String, String, String) {
    if let Some((sch, rest)) = url.split_once("://") {
        let scheme = sch.to_ascii_lowercase();
        let after_auth = rest.rsplit_once('@').map_or(rest, |(_, host_part)| host_part);
        let (host, path) = match after_auth.find(['/', '?']) {
            Some(idx) => {
                let p = &after_auth[idx..];
                let normalized_path = if p.starts_with('?') {
                    format!("/{p}")
                } else {
                    p.to_string()
                };
                (after_auth[..idx].to_string(), normalized_path)
            }
            None => (after_auth.to_string(), "/".to_string()),
        };
        return (scheme, host, path);
    }

    let host = find_header_value(headers, "host")
        .unwrap_or("localhost")
        .to_string();
    let path = if url.starts_with('/') {
        url.to_string()
    } else if url.is_empty() {
        "/".to_string()
    } else {
        format!("/{url}")
    };
    ("https".to_string(), host, path)
}

fn parse_query_params_from_url(url: &str) -> Vec<HarNameValue> {
    let without_hash = url.split('#').next().unwrap_or(url);
    let Some((_, query)) = without_hash.split_once('?') else {
        return Vec::new();
    };
    parse_urlencoded_pairs(query)
        .into_iter()
        .map(|(name, value)| HarNameValue {
            name,
            value,
            comment: None,
        })
        .collect()
}

fn parse_urlencoded_pairs(query: &str) -> Vec<(String, String)> {
    if query.is_empty() {
        return Vec::new();
    }
    query
        .split('&')
        .filter(|seg| !seg.is_empty())
        .map(|seg| match seg.split_once('=') {
            Some((k, v)) => (url_decode_component(k), url_decode_component(v)),
            None => (url_decode_component(seg), String::new()),
        })
        .collect()
}

fn url_decode_component(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                    out.push((hi << 4) | lo);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn url_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn parse_request_cookies(headers: &[HeaderPair]) -> Vec<HarCookie> {
    let mut cookies = Vec::new();
    for h in headers {
        if !h.name.eq_ignore_ascii_case("cookie") {
            continue;
        }
        for part in h.value.split(';') {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            let (name, value) = match trimmed.split_once('=') {
                Some((n, v)) => (n.trim().to_string(), v.trim().to_string()),
                None => (trimmed.to_string(), String::new()),
            };
            if !name.is_empty() {
                cookies.push(HarCookie {
                    name,
                    value,
                    path: None,
                    domain: None,
                    expires: None,
                    http_only: None,
                    secure: None,
                    comment: None,
                });
            }
        }
    }
    cookies
}

fn parse_response_set_cookies(headers: &[HeaderPair]) -> Vec<HarCookie> {
    let mut cookies = Vec::new();
    for h in headers {
        if !h.name.eq_ignore_ascii_case("set-cookie") {
            continue;
        }
        let mut segments = h.value.split(';');
        let Some(first) = segments.next() else {
            continue;
        };
        let Some((raw_name, raw_val)) = first.split_once('=') else {
            continue;
        };
        let name = raw_name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let mut cookie = HarCookie {
            name,
            value: raw_val.trim().to_string(),
            path: None,
            domain: None,
            expires: None,
            http_only: None,
            secure: None,
            comment: None,
        };

        for attr in segments {
            let attr_trimmed = attr.trim();
            if attr_trimmed.eq_ignore_ascii_case("httponly") {
                cookie.http_only = Some(true);
            } else if attr_trimmed.eq_ignore_ascii_case("secure") {
                cookie.secure = Some(true);
            } else if let Some((ak, av)) = attr_trimmed.split_once('=') {
                let ak_lower = ak.trim().to_ascii_lowercase();
                let av_clean = av.trim();
                match ak_lower.as_str() {
                    "path" => cookie.path = Some(av_clean.to_string()),
                    "domain" => cookie.domain = Some(av_clean.to_string()),
                    "expires" => {
                        if let Some(dt) = parse_timestamp_utc(av_clean) {
                            cookie.expires = Some(dt.to_rfc3339_opts(SecondsFormat::Millis, true));
                        }
                    }
                    _ => {}
                }
            }
        }
        cookies.push(cookie);
    }
    cookies
}

fn estimate_http_headers_size(first_line: &str, headers: &[HeaderPair]) -> i64 {
    let mut total = first_line.len() + 2; // `\r\n`
    for h in headers {
        total += h.name.len() + 2 + h.value.len() + 2;
    }
    total += 2; // trailing `\r\n`
    total as i64
}

fn is_likely_binary_mime(mime: &str) -> bool {
    let lower = mime
        .split(';')
        .next()
        .unwrap_or(mime)
        .trim()
        .to_ascii_lowercase();
    if lower.starts_with("image/") && !lower.contains("svg") {
        return true;
    }
    if lower.starts_with("audio/") || lower.starts_with("video/") || lower.starts_with("font/") {
        return true;
    }
    matches!(
        lower.as_str(),
        "application/octet-stream"
            | "application/pdf"
            | "application/zip"
            | "application/gzip"
            | "application/wasm"
            | "application/protobuf"
            | "application/x-protobuf"
            | "application/grpc"
    )
}

fn infer_devtools_resource_type(protocol: &str, scheme: &str, mime: &str) -> String {
    if scheme.eq_ignore_ascii_case("ws")
        || scheme.eq_ignore_ascii_case("wss")
        || protocol.eq_ignore_ascii_case("WS")
        || protocol.eq_ignore_ascii_case("WSS")
    {
        return "websocket".to_string();
    }
    let lower = mime.to_ascii_lowercase();
    if lower.contains("text/event-stream") {
        "eventsource".to_string()
    } else if lower.contains("text/html") {
        "document".to_string()
    } else if lower.contains("text/css") {
        "stylesheet".to_string()
    } else if lower.contains("javascript") || lower.contains("ecmascript") {
        "script".to_string()
    } else if lower.starts_with("image/") {
        "image".to_string()
    } else if lower.starts_with("font/") || lower.contains("woff") {
        "font".to_string()
    } else if lower.contains("json") || lower.contains("xml") {
        "fetch".to_string()
    } else {
        "other".to_string()
    }
}

fn canonical_status_reason(status: u16) -> &'static str {
    match status {
        0 => "",
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

// ============================================================================
// Unit Tests (HAR 1.2 Roundtrip, Fiddler Classic SAZ Roundtrip & Wire Decode)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::time::{SystemTime, UNIX_EPOCH};

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
                },
                request_headers: vec![
                    HeaderPair {
                        name: "Host".into(),
                        value: "auth.fluxproxy.dev".into(),
                    },
                    HeaderPair {
                        name: "Content-Type".into(),
                        value: "application/json".into(),
                    },
                    HeaderPair {
                        name: "Cookie".into(),
                        value: "device_id=dev-77; theme=dark".into(),
                    },
                ],
                response_headers: vec![
                    HeaderPair {
                        name: "Content-Type".into(),
                        value: "application/json; charset=utf-8".into(),
                    },
                    HeaderPair {
                        name: "Set-Cookie".into(),
                        value: "sid=abc123; Path=/; Domain=fluxproxy.dev; Secure; HttpOnly".into(),
                    },
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
                },
                request_headers: vec![HeaderPair {
                    name: "Host".into(),
                    value: "cdn.fluxproxy.dev".into(),
                }],
                response_headers: vec![HeaderPair {
                    name: "Content-Type".into(),
                    value: "image/png".into(),
                }],
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
                }],
                sse_events: Vec::new(),
                body_offloaded: false,
                request_body_offloaded: false,
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
}
