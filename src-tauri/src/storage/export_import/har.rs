use base64::Engine as _;
use chrono::{SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Deserializer, Serialize};

use crate::models::{
    HeaderPair, ProxyError, SessionDetail, SessionSummary, SessionTimings, SessionTransferStats,
    SseEventRecord, WebSocketFrameRecord,
};

use super::raw::{canonical_status_reason, decode_detail_body_bytes, find_header_value};
use super::saz::{normalize_iso8601_timestamp, parse_timestamp_utc};

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

pub(super) fn default_har_version() -> String {
    "1.2".to_string()
}

pub(super) fn default_har_creator() -> HarCreator {
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

pub(super) fn default_neg_one() -> f64 {
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

pub(super) fn default_http_version() -> String {
    "HTTP/1.1".to_string()
}

pub(super) fn default_neg_one_i64() -> i64 {
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

pub(super) fn default_mime_type() -> String {
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remapped_to: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub websocket_frames: Vec<WebSocketFrameRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sse_events: Vec<SseEventRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timings: Option<SessionTimings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer_stats: Option<SessionTransferStats>,
}

// ============================================================================
// Lenient Serde Deserializers for Third-Party HAR Compatibility
// ============================================================================

pub(super) fn de_string_or_empty<'de, D>(deserializer: D) -> Result<String, D::Error>
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

pub(super) fn de_string_or_mime<'de, D>(deserializer: D) -> Result<String, D::Error>
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

pub(super) fn de_f64_or_neg_one<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    let opt = Option::<f64>::deserialize(deserializer)?;
    Ok(opt.unwrap_or(-1.0))
}

pub(super) fn de_f64_non_neg<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    let opt = Option::<f64>::deserialize(deserializer)?;
    Ok(opt.unwrap_or(0.0).max(0.0))
}

pub(super) fn de_i64_or_neg_one<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let opt = Option::<f64>::deserialize(deserializer)?;
    Ok(opt.map(|v| v.round() as i64).unwrap_or(-1))
}

pub(super) fn de_i64_or_zero<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let opt = Option::<f64>::deserialize(deserializer)?;
    Ok(opt.map(|v| v.round() as i64).unwrap_or(0))
}

pub(super) fn de_u16_or_zero<'de, D>(deserializer: D) -> Result<u16, D::Error>
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

pub(super) fn build_har_timings(detail: &SessionDetail, total_ms: f64) -> HarTimings {
    let Some(t) = detail.timings.as_ref() else {
        return HarTimings {
            blocked: -1.0,
            dns: -1.0,
            connect: -1.0,
            send: 0.0,
            wait: total_ms,
            receive: 0.0,
            ssl: -1.0,
            comment: None,
        };
    };

    let server_reused = detail
        .transfer_stats
        .as_ref()
        .and_then(|st| st.server_conn_reused)
        .unwrap_or(false);

    let (dns, connect, ssl) = if server_reused {
        (-1.0, -1.0, -1.0)
    } else {
        let dns = t.dns_ms.filter(|v| *v >= 0.0).unwrap_or(-1.0);
        let ssl = t.tls_handshake_ms.filter(|v| *v >= 0.0).unwrap_or(-1.0);
        // HAR 1.2 spec: `connect` is total time to establish connection including `ssl` handshake.
        let connect = if t.tcp_connect_ms.is_some() || t.tls_handshake_ms.is_some() {
            t.tcp_connect_ms.unwrap_or(0.0).max(0.0) + t.tls_handshake_ms.unwrap_or(0.0).max(0.0)
        } else {
            -1.0
        };
        (dns, connect, ssl)
    };

    let blocked_candidates = [
        t.client_read_ms,
        t.breakpoint_pause_ms,
        t.script_hook_ms,
        t.autoresponder_delay_ms,
        t.proxy_overhead_ms,
    ];
    let any_blocked_present = blocked_candidates.iter().any(Option::is_some);
    let blocked_sum: f64 = blocked_candidates
        .into_iter()
        .flatten()
        .filter(|v| *v >= 0.0)
        .sum();
    let blocked = if any_blocked_present && blocked_sum > 0.0 {
        blocked_sum
    } else {
        -1.0
    };

    HarTimings {
        blocked,
        dns,
        connect,
        send: t.send_request_ms.unwrap_or(0.0).max(0.0),
        wait: t.server_wait_ms.unwrap_or(0.0).max(0.0),
        receive: t.content_download_ms.unwrap_or(0.0).max(0.0),
        ssl,
        comment: None,
    }
}

pub(super) fn session_to_har_entry(detail: &SessionDetail, pageref: Option<String>) -> HarEntry {
    let s = &detail.summary;
    let stats_ref = detail.transfer_stats.as_ref();
    let started_date_time = normalize_iso8601_timestamp(&s.timestamp);
    let total_ms = detail
        .timings
        .as_ref()
        .and_then(|t| t.overall_elapsed_ms)
        .filter(|v| *v > 0.0)
        .unwrap_or(s.duration_ms as f64);
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

    let req_headers_size = stats_ref
        .and_then(|st| st.request_headers_bytes)
        .map(|b| b as i64)
        .unwrap_or_else(|| {
            estimate_http_headers_size(
                &format!("{} {} {}", s.method, s.path, http_version),
                &detail.request_headers,
            )
        });
    let status_text = canonical_status_reason(s.status).to_string();
    let resp_headers_size = stats_ref
        .and_then(|st| st.response_headers_bytes)
        .map(|b| b as i64)
        .unwrap_or_else(|| {
            estimate_http_headers_size(
                &format!("{} {} {}", http_version, s.status, status_text),
                &detail.response_headers,
            )
        });
    let req_wire_body_size = stats_ref
        .and_then(|st| st.request_wire_body_bytes)
        .map(|b| b as i64)
        .unwrap_or(req_bytes.len() as i64);
    let resp_wire_body_size = stats_ref
        .and_then(|st| st.response_wire_body_bytes)
        .or(s.wire_body_size)
        .map(|b| b as i64)
        .unwrap_or(resp_bytes.len() as i64);
    let content_compression = if resp_wire_body_size >= 0 && content_size > resp_wire_body_size {
        Some(content_size - resp_wire_body_size)
    } else {
        None
    };
    let timings = build_har_timings(detail, total_ms);
    let server_ip_address = stats_ref
        .and_then(|st| st.server_ip.clone())
        .or_else(|| s.server_ip.clone());
    let connection = stats_ref
        .and_then(|st| st.server_conn_id)
        .map(|id| id.to_string());

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
        remapped_to: s.remapped_to.clone(),
        websocket_frames: detail.websocket_frames.clone(),
        sse_events: detail.sse_events.clone(),
        timings: detail.timings.clone(),
        transfer_stats: detail.transfer_stats.clone(),
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
            body_size: req_wire_body_size,
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
                compression: content_compression,
                mime_type: resp_mime,
                text: content_text,
                encoding: content_encoding,
                comment: None,
            },
            redirect_url,
            headers_size: resp_headers_size,
            body_size: resp_wire_body_size,
            comment: None,
        },
        cache: HarCache::default(),
        timings,
        server_ip_address,
        connection,
        comment: s.comment.clone(),
        resource_type,
        web_socket_messages,
        flux_proxy: Some(flux_ext),
    }
}

pub(super) fn reconstruct_timings_from_har(
    entry: &HarEntry,
    timestamp_iso: &str,
) -> Option<SessionTimings> {
    let t = &entry.timings;
    let has_any = t.dns >= 0.0
        || t.connect >= 0.0
        || t.ssl >= 0.0
        || t.blocked >= 0.0
        || t.send > 0.0
        || t.wait > 0.0
        || t.receive > 0.0
        || entry.time > 0.0;
    if !has_any {
        return None;
    }

    let start_dt = parse_timestamp_utc(timestamp_iso);
    let client_begin_request = start_dt
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Micros, true))
        .or_else(|| Some(timestamp_iso.to_string()));

    let dns_ms = (t.dns >= 0.0).then_some(t.dns);
    let tls_handshake_ms = (t.ssl >= 0.0).then_some(t.ssl);
    let tcp_connect_ms =
        (t.connect >= 0.0).then_some((t.connect - tls_handshake_ms.unwrap_or(0.0)).max(0.0));
    let send_request_ms = (t.send >= 0.0).then_some(t.send);
    let server_wait_ms = (t.wait >= 0.0).then_some(t.wait);
    let content_download_ms = (t.receive >= 0.0).then_some(t.receive);
    let proxy_overhead_ms = (t.blocked >= 0.0).then_some(t.blocked);

    let net_components = [
        dns_ms,
        tcp_connect_ms,
        tls_handshake_ms,
        send_request_ms,
        server_wait_ms,
        content_download_ms,
    ];
    let net_sum: f64 = net_components.into_iter().flatten().sum();
    let net_elapsed_ms = net_components.iter().any(Option::is_some).then_some(net_sum);

    let overall_elapsed_ms = if entry.time > 0.0 {
        Some(entry.time)
    } else {
        let total = net_sum + proxy_overhead_ms.unwrap_or(0.0);
        (total > 0.0).then_some(total)
    };

    let client_done_response = match (start_dt, overall_elapsed_ms) {
        (Some(dt), Some(elapsed))
            if elapsed.is_finite() && (0.0..=315_360_000_000.0).contains(&elapsed) =>
        {
            let delta = chrono::TimeDelta::microseconds((elapsed * 1000.0).round() as i64);
            dt.checked_add_signed(delta)
                .map(|end| end.to_rfc3339_opts(SecondsFormat::Micros, true))
        }
        _ => None,
    };

    Some(SessionTimings {
        client_begin_request,
        client_done_response,
        dns_ms,
        tcp_connect_ms,
        tls_handshake_ms,
        send_request_ms,
        server_wait_ms,
        content_download_ms,
        proxy_overhead_ms,
        overall_elapsed_ms,
        net_elapsed_ms,
        ..Default::default()
    })
}

pub(super) fn reconstruct_transfer_stats_from_har(
    entry: &HarEntry,
    req_bytes_len: usize,
    resp_bytes_len: usize,
    response_headers: &[HeaderPair],
) -> Option<SessionTransferStats> {
    let request_headers_bytes =
        (entry.request.headers_size >= 0).then_some(entry.request.headers_size as usize);
    let response_headers_bytes =
        (entry.response.headers_size >= 0).then_some(entry.response.headers_size as usize);
    let request_wire_body_bytes =
        (entry.request.body_size >= 0).then_some(entry.request.body_size as usize);
    let response_wire_body_bytes = if entry.response.body_size >= 0 {
        Some(entry.response.body_size as usize)
    } else if let Some(comp) = entry.response.content.compression {
        if comp >= 0 && (resp_bytes_len as i64) >= comp {
            Some((resp_bytes_len as i64 - comp) as usize)
        } else {
            None
        }
    } else {
        None
    };

    let response_content_encoding = find_header_value(response_headers, "content-encoding")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let server_ip = entry
        .server_ip_address
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let server_conn_id = entry
        .connection
        .as_deref()
        .and_then(|c| c.trim().parse::<u64>().ok());

    let server_conn_reused = if entry.timings.connect < 0.0
        && entry.timings.dns < 0.0
        && entry.timings.ssl < 0.0
        && (server_conn_id.is_some()
            || server_ip.is_some()
            || entry.connection.as_deref().is_some_and(|c| !c.trim().is_empty()))
    {
        Some(true)
    } else if entry.timings.connect >= 0.0 || entry.timings.dns >= 0.0 {
        Some(false)
    } else {
        None
    };

    let client_http_version = (!entry.request.http_version.trim().is_empty())
        .then(|| entry.request.http_version.trim().to_string());
    let server_http_version = (!entry.response.http_version.trim().is_empty())
        .then(|| entry.response.http_version.trim().to_string());

    let has_any = request_headers_bytes.is_some()
        || response_headers_bytes.is_some()
        || request_wire_body_bytes.is_some()
        || response_wire_body_bytes.is_some()
        || response_content_encoding.is_some()
        || server_ip.is_some()
        || server_conn_id.is_some()
        || server_conn_reused.is_some()
        || client_http_version.is_some()
        || server_http_version.is_some();

    if !has_any {
        return None;
    }

    let req_body = if req_bytes_len > 0 || entry.request.body_size >= 0 {
        Some(req_bytes_len)
    } else {
        None
    };
    let resp_body = if resp_bytes_len > 0 {
        Some(resp_bytes_len)
    } else if entry.response.content.size >= 0 {
        Some(entry.response.content.size as usize)
    } else {
        None
    };

    Some(SessionTransferStats {
        request_headers_bytes,
        request_body_bytes: req_body,
        request_wire_body_bytes,
        response_headers_bytes,
        response_body_bytes: resp_body,
        response_wire_body_bytes,
        response_content_encoding,
        client_http_version,
        server_ip,
        server_conn_id,
        server_conn_reused,
        server_http_version,
        ..Default::default()
    })
}

pub(super) fn har_entry_to_session(entry: &HarEntry, fallback_id: u64) -> SessionDetail {
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
                    injected: false,
                }
            })
            .collect()
    };

    let sse_events = ext.map(|x| x.sse_events.clone()).unwrap_or_default();
    let timings = ext
        .and_then(|x| x.timings.clone())
        .or_else(|| reconstruct_timings_from_har(entry, &timestamp));
    let transfer_stats = ext
        .and_then(|x| x.transfer_stats.clone())
        .or_else(|| {
            reconstruct_transfer_stats_from_har(
                entry,
                req_bytes.len(),
                body_size,
                &response_headers,
            )
        });

    let mut summary = SessionSummary {
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
        remapped_to: ext.and_then(|x| x.remapped_to.clone()),
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

    SessionDetail {
        summary,
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
        timings,
        transfer_stats,
    }
}

// ============================================================================
// Fiddler Classic SAZ (.saz) Builder & Reader Implementation
// ============================================================================

pub(super) fn protocol_to_har_http_version(protocol: &str) -> String {
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

pub(super) fn har_http_version_to_protocol(http_version: &str, scheme: &str, is_ws: bool) -> String {
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

pub(super) fn ensure_valid_har_url(url: &str, scheme: &str, host: &str, path: &str) -> String {
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

pub(super) fn parse_authority_and_path(rest: &str) -> (String, String) {
    let (authority, path) = match rest.find(['/', '?']) {
        Some(idx) => {
            let p = &rest[idx..];
            let normalized_path = if p.starts_with('?') {
                format!("/{p}")
            } else {
                p.to_string()
            };
            (&rest[..idx], normalized_path)
        }
        None => (rest, "/".to_string()),
    };
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host_part)| host_part)
        .to_string();
    (host, path)
}

pub(super) fn split_url_components(url: &str, headers: &[HeaderPair]) -> (String, String, String) {
    if let Some((sch, rest)) = url.split_once("://") {
        let scheme = sch.to_ascii_lowercase();
        let (host, path) = parse_authority_and_path(rest);
        return (scheme, host, path);
    }

    let host = find_header_value(headers, "host")
        .unwrap_or("localhost")
        .to_string();
    let path = if url.starts_with('/') {
        url.to_string()
    } else if url.starts_with('?') {
        format!("/{url}")
    } else if url.is_empty() {
        "/".to_string()
    } else {
        format!("/{url}")
    };
    ("https".to_string(), host, path)
}

pub(super) fn parse_query_params_from_url(url: &str) -> Vec<HarNameValue> {
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

pub(super) fn parse_urlencoded_pairs(query: &str) -> Vec<(String, String)> {
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

pub(super) fn url_decode_component(input: &str) -> String {
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

pub(super) fn url_encode_component(input: &str) -> String {
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

pub(super) fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

pub(super) fn parse_request_cookies(headers: &[HeaderPair]) -> Vec<HarCookie> {
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

pub(super) fn parse_response_set_cookies(headers: &[HeaderPair]) -> Vec<HarCookie> {
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

pub(super) fn estimate_http_headers_size(first_line: &str, headers: &[HeaderPair]) -> i64 {
    let mut total = first_line.len() + 2; // `\r\n`
    for h in headers {
        total += h.name.len() + 2 + h.value.len() + 2;
    }
    total += 2; // trailing `\r\n`
    total as i64
}

pub(super) fn is_likely_binary_mime(mime: &str) -> bool {
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

pub(super) fn infer_devtools_resource_type(protocol: &str, scheme: &str, mime: &str) -> String {
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
