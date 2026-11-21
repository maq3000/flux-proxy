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
    #[serde(default)]
    pub remapped_to: Option<String>,
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
    #[serde(default)]
    pub body_offloaded: bool,
    #[serde(default)]
    pub request_body_offloaded: bool,
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

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NoiseThresholdsBackendConfig {
    #[serde(default, rename = "hide304NotModified")]
    pub hide_304_not_modified: bool,
    #[serde(default)]
    pub hide_options_preflight: bool,
    #[serde(default)]
    pub hide_connect_tunnels: bool,
    #[serde(default)]
    pub hide_static_assets: bool,
    #[serde(default)]
    pub min_body_size_bytes: Option<usize>,
    #[serde(default)]
    pub max_body_size_bytes: Option<usize>,
    #[serde(default)]
    pub time_heat_warning_ms: u64,
    #[serde(default)]
    pub only_slow_requests: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFilterRule {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub action: String, // "include" | "exclude"
    #[serde(default)]
    pub logical_op: String, // "AND" | "OR"
    pub field: String,
    pub operator: String,
    pub value: String,
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
    #[serde(default = "default_true", alias = "strip_alt_svc")]
    pub strip_alt_svc: bool,
    #[serde(default)]
    pub host_list_sync: HostListBackendSyncConfig,
    #[serde(default)]
    pub drop_non_matching_on_capture: bool,
    #[serde(default)]
    pub capture_host_list: HostListBackendSyncConfig,
    #[serde(default)]
    pub noise_thresholds: NoiseThresholdsBackendConfig,
    #[serde(default)]
    pub capture_matrix_enabled: bool,
    #[serde(default)]
    pub capture_filter_rules: Vec<CaptureFilterRule>,
    #[serde(default)]
    pub quick_category: Option<String>,
    #[serde(default)]
    pub filter_query: Option<String>,
    #[serde(default)]
    pub use_regex_query: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub ram_sessions: usize,
    pub sqlite_size_bytes: u64,
    pub dropped_sessions_count: u64,
    pub session_retention_limit: Option<usize>,
    pub drop_non_matching: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSessionBody {
    pub id: u64,
    pub is_response: bool,
    pub body_base64: String,
    pub body_text: Option<String>,
    pub body_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposedRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<HeaderPair>,
    pub body: String,
    #[serde(default)]
    pub body_base64: Option<String>,
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
    #[serde(default)]
    pub is_trusted: bool,
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
    ZstdCompress,
    ZstdDecompress,
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
pub struct DoctorCheckResult {
    pub id: String,
    pub title: String,
    pub status: String, // "ok" | "warning" | "error"
    pub summary: String,
    pub details: String,
    #[serde(alias = "can_auto_fix")]
    pub can_auto_fix: bool,
    #[serde(alias = "fix_label")]
    pub fix_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceInfo {
    pub name: String,
    pub ip: String,
    pub kind: String, // "wifi" | "ethernet" | "other"
    pub is_primary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum BindHostMode {
    #[default]
    #[serde(alias = "Loopback")]
    Loopback,
    #[serde(rename = "all", alias = "allInterfaces", alias = "AllInterfaces", alias = "All")]
    AllInterfaces,
    #[serde(alias = "Specific")]
    Specific,
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
    #[serde(default)]
    pub bind_mode: BindHostMode,
    #[serde(default)]
    pub specific_bind_ip: Option<String>,
    #[serde(default = "default_true")]
    pub also_bind_loopback: bool,
    #[serde(default)]
    pub bound_ips: Vec<String>,
}

fn default_mask_json_keys() -> Vec<String> {
    [
        "password",
        "passwd",
        "secret",
        "token",
        "access_token",
        "refresh_token",
        "api_key",
        "client_secret",
        "id_token",
        "private_key",
        "cvv",
        "pan",
        "card_number",
        "pin",
        "session_id",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn default_strip_query_params() -> Vec<String> {
    ["token", "auth", "api_key", "key", "signature", "sig", "code"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn default_replacement_text() -> String {
    "[REDACTED]".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizationOptions {
    #[serde(default = "default_true")]
    pub redact_auth_headers: bool,
    #[serde(default)]
    pub custom_redacted_headers: Vec<String>,
    #[serde(default = "default_mask_json_keys")]
    pub mask_json_keys: Vec<String>,
    #[serde(default = "default_strip_query_params")]
    pub strip_query_params: Vec<String>,
    #[serde(default)]
    pub anonymize_client_info: bool,
    #[serde(default = "default_replacement_text")]
    pub replacement_text: String,
}

impl Default for SanitizationOptions {
    fn default() -> Self {
        Self {
            redact_auth_headers: true,
            custom_redacted_headers: Vec::new(),
            mask_json_keys: default_mask_json_keys(),
            strip_query_params: default_strip_query_params(),
            anonymize_client_info: false,
            replacement_text: default_replacement_text(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonRunnerStatus {
    pub available: bool,
    pub enabled: bool,
    pub running: bool,
    pub python_executable: Option<String>,
    pub python_version: Option<String>,
    pub worker_pid: Option<u32>,
    pub has_on_request: bool,
    pub has_on_response: bool,
    pub timeout_ms: u64,
    pub last_error: Option<String>,
    pub restart_count: u64,
    pub invocations_count: u64,
    pub timeout_count: u64,
    pub is_simulator: bool,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptConsoleLogEvent {
    pub id: u64,
    pub timestamp: String,
    pub level: String,
    pub hook: Option<String>,
    pub session_id: Option<u64>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRemapRule {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub source_pattern: String,
    pub target_host: String,
    #[serde(default)]
    pub target_port: Option<u16>,
    #[serde(default = "default_true")]
    pub preserve_host_header: bool,
    #[serde(default)]
    pub comment: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ThrottlePreset {
    #[default]
    None,
    Gprs,
    Slow3g,
    Fast3g,
    Lte,
    Offline,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleConfig {
    #[serde(default)]
    pub preset: ThrottlePreset,
    #[serde(default)]
    pub download_kbps: u64,
    #[serde(default)]
    pub upload_kbps: u64,
    #[serde(default)]
    pub latency_ms: u64,
}

impl ThrottleConfig {
    pub fn from_preset(preset: ThrottlePreset) -> Self {
        match preset {
            ThrottlePreset::None => Self {
                preset,
                download_kbps: 0,
                upload_kbps: 0,
                latency_ms: 0,
            },
            ThrottlePreset::Gprs => Self {
                preset,
                download_kbps: 50,
                upload_kbps: 50,
                latency_ms: 500,
            },
            ThrottlePreset::Slow3g => Self {
                preset,
                download_kbps: 400,
                upload_kbps: 400,
                latency_ms: 400,
            },
            ThrottlePreset::Fast3g => Self {
                preset,
                download_kbps: 1600,
                upload_kbps: 1600,
                latency_ms: 150,
            },
            ThrottlePreset::Lte => Self {
                preset,
                download_kbps: 30_000,
                upload_kbps: 30_000,
                latency_ms: 40,
            },
            ThrottlePreset::Offline => Self {
                preset,
                download_kbps: 0,
                upload_kbps: 0,
                latency_ms: 0,
            },
            ThrottlePreset::Custom => Self {
                preset,
                download_kbps: 1000,
                upload_kbps: 500,
                latency_ms: 100,
            },
        }
    }

    pub fn normalized(self) -> Self {
        match self.preset {
            ThrottlePreset::Custom => self,
            preset => Self::from_preset(preset),
        }
    }

    pub fn is_offline(&self) -> bool {
        matches!(self.preset, ThrottlePreset::Offline)
    }

    pub fn is_active(&self) -> bool {
        self.is_offline()
            || self.latency_ms > 0
            || self.download_kbps > 0
            || self.upload_kbps > 0
    }

    pub fn download_bytes_per_sec(&self) -> Option<u64> {
        if self.is_offline() || self.download_kbps == 0 {
            None
        } else {
            Some((self.download_kbps.saturating_mul(1000) / 8).max(1))
        }
    }

    pub fn upload_bytes_per_sec(&self) -> Option<u64> {
        if self.is_offline() || self.upload_kbps == 0 {
            None
        } else {
            Some((self.upload_kbps.saturating_mul(1000) / 8).max(1))
        }
    }
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
