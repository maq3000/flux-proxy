use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderPair {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketFrameRecord {
    pub index: usize,
    pub direction: String, // "outbound" | "inbound"
    pub opcode: String,    // "text" | "binary" | "ping" | "pong" | "close"
    pub payload_preview: String,
    pub byte_length: usize,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SseEventRecord {
    pub index: usize,
    pub id: Option<String>,
    pub event: String,
    pub data: String,
    pub retry: Option<u64>,
    pub byte_length: usize,
    pub offset_ms: u64,
    pub timestamp: String,
}

/// Lightweight metadata pushed in real-time batches (`proxy://sessions-batch`)
/// to keep Tauri IPC overhead minimal even at 10,000+ captured sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: u64,
    pub status: u16,
    pub protocol: String,
    pub scheme: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub url: String,
    pub content_type: String,
    pub body_size: usize,
    pub duration_ms: u64,
    pub timestamp: String,
    pub is_mocked: bool,
    pub matched_rule_id: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub process_name: Option<String>,
    #[serde(default)]
    pub process_pid: Option<u32>,
    #[serde(default)]
    pub tls_bypassed: bool,
    #[serde(default)]
    pub headers_mutated: bool,
    #[serde(default)]
    pub breakpoint_paused: Option<String>,
    #[serde(default)]
    pub breakpoint_modified: bool,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub marked_color: Option<String>,
    #[serde(default)]
    pub client_ip: Option<String>,
}

/// Full session payload fetched on-demand when inspecting a row or dragging into Composer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub summary: SessionSummary,
    pub request_headers: Vec<HeaderPair>,
    pub response_headers: Vec<HeaderPair>,
    pub request_body_base64: String,
    pub response_body_base64: String,
    pub request_body_text: Option<String>,
    pub response_body_text: Option<String>,
    pub tls_version: Option<String>,
    pub client_addr: String,
    pub websocket_frames: Vec<WebSocketFrameRecord>,
    #[serde(default)]
    pub sse_events: Vec<SseEventRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleMatchTarget {
    UrlContains,
    UrlRegex,
    HeaderMatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleActionType {
    MockResponse,
    OverrideStatus,
    DelayOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoResponderRule {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    pub match_target: RuleMatchTarget,
    pub pattern: String,
    pub method_filter: Option<String>,
    pub header_name: Option<String>,
    pub action: RuleActionType,
    pub status_code: u16,
    pub latency_ms: u64,
    pub response_headers: Vec<HeaderPair>,
    pub response_body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TlsBypassRule {
    pub id: String,
    pub enabled: bool,
    pub pattern: String,
    pub category: String,
    pub description: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HeaderMutationDirection {
    Request,
    Response,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HeaderMutationOp {
    Set,
    Remove,
    Append,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderMutationRule {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    pub direction: HeaderMutationDirection,
    pub operation: HeaderMutationOp,
    pub header_name: String,
    pub header_value: String,
    pub url_pattern: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TlsInterceptMode {
    /// Mode 1 (Default): Inspect all HTTPS/WSS traffic except hosts matching `tls_bypass_rules`.
    #[default]
    InterceptAll,
    /// Mode 2 (Targeted Allowlist): Pure TCP pass-through (`copy_bidirectional`) for all hosts
    /// EXCEPT those matching `tls_target_rules`.
    TargetedOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum HostListFilterMode {
    Whitelist,
    #[default]
    Blacklist,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostListBackendSyncConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub mode: HostListFilterMode,
    #[serde(default)]
    pub raw_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyFilterBackendConfig {
    #[serde(default)]
    pub tls_intercept_mode: TlsInterceptMode,
    pub tls_bypass_enabled: bool,
    pub tls_bypass_rules: Vec<TlsBypassRule>,
    #[serde(default)]
    pub tls_target_rules: Vec<TlsBypassRule>,
    pub header_mutations_enabled: bool,
    pub header_mutations: Vec<HeaderMutationRule>,
    #[serde(default)]
    pub host_list_sync: HostListBackendSyncConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposedRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<HeaderPair>,
    pub body: String,
    pub follow_redirects: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaCertificateInfo {
    pub cert_pem_path: String,
    pub cert_cer_path: String,
    pub sha256_fingerprint: String,
    pub subject: String,
    pub valid_until: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BreakpointStage {
    Request,
    Response,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointRule {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    pub stage: BreakpointStage,
    pub url_pattern: String,
    pub method_filter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointConfig {
    pub break_before_request: bool,
    pub break_after_response: bool,
    pub timeout_secs: u64,
    pub rules: Vec<BreakpointRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PausedBreakpointItem {
    pub breakpoint_id: String,
    pub session_id: u64,
    pub stage: BreakpointStage,
    pub created_at: String,
    pub timeout_secs: u64,
    pub scheme: String,
    pub method: String,
    pub url: String,
    pub host: String,
    pub path: String,
    pub request_headers: Vec<HeaderPair>,
    pub request_body_base64: String,
    pub request_body_text: Option<String>,
    pub response_status: Option<u16>,
    pub response_headers: Vec<HeaderPair>,
    pub response_body_base64: String,
    pub response_body_text: Option<String>,
    pub process_name: Option<String>,
    pub process_pid: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BreakpointAction {
    Continue,
    Abort,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointResolution {
    pub breakpoint_id: String,
    pub action: BreakpointAction,
    pub method: Option<String>,
    pub url: Option<String>,
    pub request_headers: Option<Vec<HeaderPair>>,
    pub request_body_base64: Option<String>,
    pub request_body_text: Option<String>,
    pub status_code: Option<u16>,
    pub response_headers: Option<Vec<HeaderPair>>,
    pub response_body_base64: Option<String>,
    pub response_body_text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodecOperation {
    GzipCompress,
    GzipDecompress,
    BrotliCompress,
    BrotliDecompress,
    DeflateCompress,
    DeflateDecompress,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecTransformResult {
    pub output_base64: String,
    pub output_text: Option<String>,
    pub output_hex: String,
    pub input_bytes: usize,
    pub output_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceInfo {
    pub name: String,
    pub ip: String,
    pub kind: String, // "wifi" | "ethernet" | "other"
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub running: bool,
    pub bind_addr: String,
    pub port: u16,
    pub active_sessions: usize,
    pub system_proxy_enabled: bool,
    pub auto_system_proxy: bool,
    pub system_proxy_error: Option<String>,
    #[serde(default)]
    pub allow_remote: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Certificate generation error: {0}")]
    Rcgen(#[from] rcgen::Error),
    #[error("TLS configuration error: {0}")]
    Rustls(#[from] rustls::Error),
    #[error("SQLite storage error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("HTTP upstream error: {0}")]
    Reqwest(#[from] reqwest::Error),
    #[error("{0}")]
    Custom(String),
}

impl Serialize for ProxyError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
