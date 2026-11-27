export interface HeaderPair {
  name: string;
  value: string;
  rawBytesB64?: string;
}

export interface WebSocketFrameRecord {
  index: number;
  direction: "outbound" | "inbound";
  opcode: string;
  payloadPreview: string;
  byteLength: number;
  timestamp: string;
  injected?: boolean;
}

export interface SseEventRecord {
  index: number;
  id?: string | null;
  event: string;
  data: string;
  retry?: number | null;
  byteLength: number;
  offsetMs: number;
  timestamp: string;
}

export interface SessionTimings {
  clientConnected?: string | null;
  clientBeginRequest?: string | null;
  gotRequestHeaders?: string | null;
  clientDoneRequest?: string | null;
  proxyBeginRequest?: string | null;
  serverConnected?: string | null;
  serverGotRequest?: string | null;
  serverBeginResponse?: string | null;
  gotResponseHeaders?: string | null;
  serverDoneResponse?: string | null;
  clientBeginResponse?: string | null;
  clientDoneResponse?: string | null;

  clientReadMs?: number | null;
  clientTlsHandshakeMs?: number | null;
  dnsMs?: number | null;
  tcpConnectMs?: number | null;
  tlsHandshakeMs?: number | null;
  sendRequestMs?: number | null;
  serverWaitMs?: number | null;
  contentDownloadMs?: number | null;
  clientSendMs?: number | null;
  breakpointPauseMs?: number | null;
  scriptHookMs?: number | null;
  autoresponderDelayMs?: number | null;
  proxyOverheadMs?: number | null;
  overallElapsedMs?: number | null;
  netElapsedMs?: number | null;
}

export interface SessionTransferStats {
  requestHeadersBytes?: number | null;
  requestBodyBytes?: number | null;
  requestWireBodyBytes?: number | null;
  responseHeadersBytes?: number | null;
  responseBodyBytes?: number | null;
  responseWireBodyBytes?: number | null;
  responseContentEncoding?: string | null;

  clientConnId?: number | null;
  clientConnReused?: boolean | null;
  clientHttpVersion?: string | null;
  clientTlsVersion?: string | null;
  clientTlsCipher?: string | null;
  clientAlpn?: string | null;

  serverAddr?: string | null;
  serverIp?: string | null;
  serverPort?: number | null;
  serverConnId?: number | null;
  serverConnReused?: boolean | null;
  serverHttpVersion?: string | null;
  serverTlsVersion?: string | null;
  serverTlsCipher?: string | null;
  serverTlsAlpn?: string | null;
  serverCertSubject?: string | null;
  serverCertIssuer?: string | null;
  serverMtlsCn?: string | null;
  remappedTarget?: string | null;
  viaProxyAddr?: string | null;
  isStreaming?: boolean | null;
}

export interface SessionSummary {
  id: number;
  status: number;
  protocol: string;
  scheme: string;
  method: string;
  host: string;
  path: string;
  url: string;
  contentType: string;
  bodySize: number;
  durationMs: number;
  timestamp: string;
  isMocked: boolean;
  matchedRuleId?: string | null;
  error?: string | null;
  processName?: string | null;
  processPid?: number | null;
  tlsBypassed?: boolean;
  headersMutated?: boolean;
  breakpointPaused?: "request" | "response" | null;
  breakpointModified?: boolean;
  comment?: string | null;
  markedColor?: string | null;
  clientIp?: string | null;
  remappedTo?: string | null;
  ttfbMs?: number | null;
  dnsMs?: number | null;
  connectMs?: number | null;
  tlsMs?: number | null;
  receiveMs?: number | null;
  requestSize?: number | null;
  wireBodySize?: number | null;
  serverIp?: string | null;
  serverConnReused?: boolean | null;
  wsOpen?: boolean | null;
}

export interface SessionDetail {
  summary: SessionSummary;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  requestBodyBase64: string;
  responseBodyBase64: string;
  requestBodyText?: string | null;
  responseBodyText?: string | null;
  tlsVersion?: string | null;
  clientAddr: string;
  websocketFrames: WebSocketFrameRecord[];
  sseEvents?: SseEventRecord[];
  bodyOffloaded?: boolean;
  requestBodyOffloaded?: boolean;
  timings?: SessionTimings | null;
  transferStats?: SessionTransferStats | null;
}

export interface StorageStats {
  ramSessions: number;
  archivedSessions?: number;
  sqliteSizeBytes: number;
  droppedSessionsCount: number;
  sessionRetentionLimit: number | null;
  dropNonMatching: boolean;
}

export interface LoadedSessionBody {
  id: number;
  isResponse: boolean;
  bodyBase64: string;
  bodyText?: string | null;
  bodySize: number;
}

export const SESSION_RETENTION_PRESETS = [
  100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

export const DEFAULT_SESSION_RETENTION_LIMIT = 10_000;

export type RuleMatchTarget = "urlContains" | "urlRegex" | "headerMatch";
export type RuleActionType = "mockResponse" | "overrideStatus" | "delayOnly";

export interface AutoResponderRule {
  id: string;
  enabled: boolean;
  name: string;
  matchTarget: RuleMatchTarget;
  pattern: string;
  methodFilter?: string | null;
  headerName?: string | null;
  action: RuleActionType;
  statusCode: number;
  latencyMs: number;
  responseHeaders: HeaderPair[];
  responseBody: string;
}

// ============================================================================
// Filter Rules Matrix, Presets, Thresholds, TLS Bypass & Header Mutations
// ============================================================================
export type FilterRuleAction = "include" | "exclude";
export type FilterLogicalOp = "AND" | "OR";

export type FilterField =
  | "url"
  | "host"
  | "path"
  | "method"
  | "status"
  | "contentType"
  | "processName"
  | "processPid"
  | "clientIp"
  | "protocol"
  | "bodySize"
  | "durationMs"
  | "comment";

export type FilterOperator =
  | "contains"
  | "notContains"
  | "equals"
  | "notEquals"
  | "startsWith"
  | "endsWith"
  | "regex"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export interface FilterConditionRule {
  id: string;
  enabled: boolean;
  action: FilterRuleAction;
  logicalOp: FilterLogicalOp;
  field: FilterField;
  operator: FilterOperator;
  value: string;
}

export interface NoiseThresholdsConfig {
  hide304NotModified: boolean;
  hideOptionsPreflight: boolean;
  hideConnectTunnels: boolean;
  hideStaticAssets: boolean;
  minBodySizeBytes: number | null;
  maxBodySizeBytes: number | null;
  timeHeatEnabled: boolean;
  timeHeatWarningMs: number;
  timeHeatCriticalMs: number;
  onlySlowRequests: boolean;
}

export interface TlsBypassRule {
  id: string;
  enabled: boolean;
  pattern: string;
  category: string;
  description: string;
}

export type HeaderMutationDirection = "request" | "response";
export type HeaderMutationOp = "set" | "remove" | "append";

export interface HeaderMutationRule {
  id: string;
  enabled: boolean;
  name: string;
  direction: HeaderMutationDirection;
  operation: HeaderMutationOp;
  headerName: string;
  headerValue: string;
  urlPattern: string;
}

export type TlsInterceptMode = "interceptAll" | "targetedOnly";

export type HostListFilterMode = "whitelist" | "blacklist";

export interface HostListFilterConfig {
  enabled: boolean;
  mode: HostListFilterMode;
  rawText: string;
  applyToTlsPassthrough: boolean;
}

export interface HostListBackendSyncConfig {
  enabled: boolean;
  mode: HostListFilterMode;
  rawText: string;
}

export interface NoiseThresholdsBackendSyncConfig {
  hide304NotModified: boolean;
  hideOptionsPreflight: boolean;
  hideConnectTunnels: boolean;
  hideStaticAssets: boolean;
  minBodySizeBytes: number | null;
  maxBodySizeBytes: number | null;
  timeHeatWarningMs: number;
  onlySlowRequests: boolean;
}

export interface ProxyFilterBackendConfig {
  tlsInterceptMode: TlsInterceptMode;
  tlsBypassEnabled: boolean;
  tlsBypassRules: TlsBypassRule[];
  tlsTargetRules: TlsBypassRule[];
  headerMutationsEnabled: boolean;
  headerMutations: HeaderMutationRule[];
  stripAltSvc: boolean;
  hostListSync?: HostListBackendSyncConfig;
  dropNonMatchingOnCapture?: boolean;
  captureHostList?: HostListBackendSyncConfig;
  noiseThresholds?: NoiseThresholdsBackendSyncConfig;
  captureMatrixEnabled?: boolean;
  captureFilterRules?: FilterConditionRule[];
  quickCategory?: string | null;
  filterQuery?: string | null;
  useRegexQuery?: boolean | null;
  lanClientAllowlist?: string[];
}

export interface FilterPreset {
  id: string;
  name: string;
  description: string;
  builtIn?: boolean;
  matrixEnabled: boolean;
  rules: FilterConditionRule[];
  thresholds: NoiseThresholdsConfig;
  forceNoCache?: boolean;
  hostListFilter?: HostListFilterConfig;
}

export type FilterDrawerTab =
  | "hostsList"
  | "matrix"
  | "thresholds"
  | "tlsBypass"
  | "headers";

export interface DetectedProcessItem {
  name: string;
  pid: number | null;
  count: number;
}

export interface ComposedRequest {
  method: string;
  url: string;
  headers: HeaderPair[];
  body: string;
  bodyBase64?: string | null;
  followRedirects: boolean;
  skipPythonScripts?: boolean;
  requestId?: string;
  timeoutSec?: number;
  /** Optional frontend-only metadata indicating the source Traffic session ID */
  sourceSessionId?: number;
}

export interface CaCertificateInfo {
  certPemPath: string;
  certCerPath: string;
  sha256Fingerprint: string;
  subject: string;
  validUntil: string;
  isTrusted?: boolean;
  manualInstallCommand?: string | null;
  trustStoreBackend?: string | null;
}

export type ClientCertificateFormat = "pkcs12" | "pem";

export interface ClientCertificateEntry {
  id: string;
  domainPattern: string;
  label: string;
  format: ClientCertificateFormat;
  storedCertPath: string;
  commonName: string;
  expiresAt: string;
  enabled: boolean;
  ephemeral?: boolean;
}

export interface AddClientCertificateInput {
  domainPattern: string;
  label?: string | null;
  certPath: string;
  keyPath?: string | null;
  password?: string | null;
  enabled?: boolean;
  ephemeral?: boolean;
}

export type DoctorCheckStatus = "ok" | "warning" | "error";

export interface DoctorCheckResult {
  id: string;
  title: string;
  status: DoctorCheckStatus;
  summary: string;
  details: string;
  canAutoFix: boolean;
  fixLabel?: string | null;
  suggestedCommand?: string | null;
}

export interface NetworkInterfaceInfo {
  name: string;
  ip: string;
  kind: string; // "wifi" | "ethernet" | "vpn" | "virtual" | "other"
  isPrimary: boolean;
}

export type BindHostMode = "loopback" | "all" | "specific";

export interface ProxyStatus {
  running: boolean;
  bindAddr: string;
  port: number;
  activeSessions: number;
  systemProxyEnabled: boolean;
  autoSystemProxy: boolean;
  systemProxyError?: string | null;
  allowRemote?: boolean;
  bindMode?: BindHostMode;
  specificBindIp?: string | null;
  alsoBindLoopback?: boolean;
  boundIps?: string[];
}

export type ActiveNavSection =
  | "traffic"
  | "composer"
  | "rules"
  | "breakpoints"
  | "scripts"
  | "diff"
  | "wizard";

export const ALL_NAV_SECTIONS: readonly ActiveNavSection[] = [
  "traffic",
  "composer",
  "rules",
  "breakpoints",
  "scripts",
  "diff",
  "wizard",
] as const;

export type ScriptConsoleLogLevel =
  | "stdout"
  | "stderr"
  | "info"
  | "warn"
  | "error";

export interface PythonRunnerStatus {
  available: boolean;
  enabled: boolean;
  running: boolean;
  pythonExecutable: string | null;
  pythonVersion: string | null;
  workerPid: number | null;
  hasOnRequest: boolean;
  hasOnResponse: boolean;
  timeoutMs: number;
  lastError: string | null;
  restartCount: number;
  invocationsCount: number;
  timeoutCount: number;
  isSimulator: boolean;
  code: string;
}

export interface ScriptConsoleLogEvent {
  id: number;
  timestamp: string;
  level: ScriptConsoleLogLevel;
  hook: string | null;
  sessionId: number | null;
  message: string;
}

export interface PythonScriptPreset {
  id: string;
  name: string;
  badge: string;
  description: string;
  hooks: ("on_request" | "on_response")[];
  code: string;
}

export interface PythonScriptConfig {
  enabled: boolean;
  code: string;
  activePresetId?: string | null;
}

export type QuickFilterCategory =
  | "all"
  | "json"
  | "images"
  | "errors"
  | "ws"
  | "sse"
  | "mocked"
  | "marked";

export type DiffTabId =
  | "full"
  | "headers"
  | "cookies"
  | "request"
  | "response";

export type InspectorTab =
  | "headers"
  | "params"
  | "cookies"
  | "auth"
  | "caching"
  | "sse"
  | "ws"
  | "multipart"
  | "protobuf"
  | "raw"
  | "json"
  | "xml"
  | "image"
  | "hex";

// ============================================================================
// Live Breakpoints (Before Request / After Response — F11 / Alt+F11 / `bpu`)
// ============================================================================
export type BreakpointStage = "request" | "response" | "both";

export interface BreakpointRule {
  id: string;
  enabled: boolean;
  name: string;
  stage: BreakpointStage;
  urlPattern: string;
  methodFilter?: string | null;
}

export interface BreakpointConfig {
  breakBeforeRequest: boolean;
  breakAfterResponse: boolean;
  timeoutSecs: number;
  rules: BreakpointRule[];
}

export interface PausedBreakpointItem {
  breakpointId: string;
  sessionId: number;
  stage: BreakpointStage;
  createdAt: string;
  timeoutSecs: number;
  scheme: string;
  method: string;
  url: string;
  host: string;
  path: string;
  requestHeaders: HeaderPair[];
  requestBodyBase64: string;
  requestBodyText?: string | null;
  requestBodyOffloaded?: boolean;
  requestBodySize?: number;
  responseStatus?: number | null;
  responseHeaders: HeaderPair[];
  responseBodyBase64: string;
  responseBodyText?: string | null;
  responseBodyOffloaded?: boolean;
  responseBodySize?: number;
  bodyOffloaded?: boolean;
  bodySize?: number;
  processName?: string | null;
  processPid?: number | null;
}

export type BreakpointAction = "continue" | "abort";

export interface BreakpointResolution {
  breakpointId: string;
  action: BreakpointAction;
  method?: string | null;
  url?: string | null;
  requestHeaders?: HeaderPair[] | null;
  requestBodyBase64?: string | null;
  requestBodyText?: string | null;
  statusCode?: number | null;
  responseHeaders?: HeaderPair[] | null;
  responseBodyBase64?: string | null;
  responseBodyText?: string | null;
}

// ============================================================================
// TextWizard Compression & Binary Codec Operations
// ============================================================================
export type CodecOperation =
  | "gzipCompress"
  | "gzipDecompress"
  | "brotliCompress"
  | "brotliDecompress"
  | "deflateCompress"
  | "deflateDecompress"
  | "zstdCompress"
  | "zstdDecompress";

export interface CodecTransformResult {
  outputBase64: string;
  outputText?: string | null;
  outputHex: string;
  inputBytes: number;
  outputBytes: number;
}

// ============================================================================
// UI Layout, Toolbar Groups & Resizable TrafficGrid Columns
// ============================================================================
export type ColumnId =
  | "id"
  | "status"
  | "method"
  | "protocol"
  | "host"
  | "url"
  | "process"
  | "size"
  | "time"
  | "ttfb"
  | "serverIp"
  | "comment";

export type SortDirection = "asc" | "desc";

export type ToolbarGroupId =
  | "capture"
  | "proxyMode"
  | "breakpoints"
  | "quickFilter"
  | "categories"
  | "utilities"
  | "layout";

export type InspectorDockPosition = "bottom" | "right";

export type InspectorSplitDirection = "auto" | "horizontal" | "vertical";

export interface UiLayoutPreferences {
  compactToolbar: boolean;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  inspectorPosition: InspectorDockPosition;
  inspectorSplitDirection: InspectorSplitDirection;
}

// ============================================================================
// PII & Secrets Redaction / Sanitized Session Export
// ============================================================================
export type ExportArchiveFormat = "har" | "saz" | "json" | "raw";

export type SanitizationPresetId =
  | "safeSharing"
  | "strictAnonymization"
  | "custom";

export interface SanitizationOptions {
  redactAuthHeaders: boolean;
  customRedactedHeaders: string[];
  maskJsonKeys: string[];
  stripQueryParams: string[];
  anonymizeClientInfo: boolean;
  replacementText: string;
}

export const BUILTIN_REDACTED_AUTH_HEADERS: readonly string[] = [
  "Authorization",
  "Proxy-Authorization",
  "Cookie",
  "Set-Cookie",
  "X-Api-Key",
  "X-Auth-Token",
] as const;

export const DEFAULT_MASK_JSON_KEYS: readonly string[] = [
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
] as const;

export const DEFAULT_STRIP_QUERY_PARAMS: readonly string[] = [
  "token",
  "auth",
  "api_key",
  "key",
  "signature",
  "sig",
  "code",
] as const;

export const DEFAULT_SANITIZATION_REPLACEMENT = "[REDACTED]";

export const DEFAULT_SANITIZATION_OPTIONS: SanitizationOptions = {
  redactAuthHeaders: true,
  customRedactedHeaders: [],
  maskJsonKeys: [...DEFAULT_MASK_JSON_KEYS],
  stripQueryParams: [...DEFAULT_STRIP_QUERY_PARAMS],
  anonymizeClientInfo: false,
  replacementText: DEFAULT_SANITIZATION_REPLACEMENT,
};

// ============================================================================
// Virtual DNS (HOSTS Remapping) & Bandwidth Throttling
// ============================================================================
export interface HostRemapRule {
  id: string;
  enabled: boolean;
  sourcePattern: string;
  targetHost: string;
  targetPort?: number | null;
  preserveHostHeader: boolean;
  comment: string;
}

export type ThrottlePreset =
  | "none"
  | "gprs"
  | "slow3g"
  | "fast3g"
  | "lte"
  | "offline"
  | "custom";

export interface ThrottleConfig {
  preset: ThrottlePreset;
  downloadKbps: number;
  uploadKbps: number;
  latencyMs: number;
}

export const DEFAULT_THROTTLE_CONFIG: ThrottleConfig = {
  preset: "none",
  downloadKbps: 0,
  uploadKbps: 0,
  latencyMs: 0,
};

export interface ThrottlePresetDefinition {
  id: ThrottlePreset;
  label: string;
  shortLabel: string;
  summary: string;
  downloadKbps: number;
  uploadKbps: number;
  latencyMs: number;
}

export const THROTTLE_PRESET_DEFINITIONS: readonly ThrottlePresetDefinition[] = [
  {
    id: "none",
    label: "No Throttling",
    shortLabel: "No Throttle",
    summary: "Full speed",
    downloadKbps: 0,
    uploadKbps: 0,
    latencyMs: 0,
  },
  {
    id: "gprs",
    label: "GPRS",
    shortLabel: "GPRS",
    summary: "50 Kbps · 500 ms",
    downloadKbps: 50,
    uploadKbps: 50,
    latencyMs: 500,
  },
  {
    id: "slow3g",
    label: "Slow 3G",
    shortLabel: "Slow 3G",
    summary: "400 Kbps · 400 ms",
    downloadKbps: 400,
    uploadKbps: 400,
    latencyMs: 400,
  },
  {
    id: "fast3g",
    label: "Fast 3G",
    shortLabel: "Fast 3G",
    summary: "1.6 Mbps · 150 ms",
    downloadKbps: 1600,
    uploadKbps: 1600,
    latencyMs: 150,
  },
  {
    id: "lte",
    label: "LTE / 4G",
    shortLabel: "LTE",
    summary: "30 Mbps · 40 ms",
    downloadKbps: 30000,
    uploadKbps: 30000,
    latencyMs: 40,
  },
  {
    id: "offline",
    label: "Offline",
    shortLabel: "Offline",
    summary: "HTTP 503",
    downloadKbps: 0,
    uploadKbps: 0,
    latencyMs: 0,
  },
  {
    id: "custom",
    label: "Custom…",
    shortLabel: "Custom",
    summary: "Manual limits",
    downloadKbps: 1000,
    uploadKbps: 500,
    latencyMs: 100,
  },
] as const;

export type UpstreamProxyProtocol = "http" | "https" | "socks5";

export interface UpstreamProxyConfig {
  enabled: boolean;
  protocol: UpstreamProxyProtocol;
  host: string;
  port: number;
  username?: string | null;
  /** Optional write-only password sent to backend RAM on save; never returned by backend or persisted in profiles. */
  password?: string | null;
  /** Read-only indicator returned by backend / preview simulator showing whether a password is held in RAM. */
  hasPassword?: boolean;
  bypassList: string[];
}

export const DEFAULT_UPSTREAM_PROXY_BYPASS_LIST: string[] = [
  "localhost",
  "127.0.0.1",
  "::1",
  "<local>",
];

export const DEFAULT_UPSTREAM_PROXY_CONFIG: UpstreamProxyConfig = {
  enabled: false,
  protocol: "http",
  host: "",
  port: 8080,
  username: null,
  hasPassword: false,
  bypassList: [...DEFAULT_UPSTREAM_PROXY_BYPASS_LIST],
};

export interface UpstreamTimeoutConfig {
  connectTimeoutSec: number;
  /** `0` = Unlimited (wait transparently for slow server response headers / TTFB). */
  responseHeaderTimeoutSec: number;
  /** `0` = Unlimited. */
  composerTimeoutSec: number;
}

export const DEFAULT_UPSTREAM_TIMEOUT_CONFIG: UpstreamTimeoutConfig = {
  connectTimeoutSec: 15,
  responseHeaderTimeoutSec: 0,
  composerTimeoutSec: 120,
};

export const UPSTREAM_TIMEOUT_LIMITS = {
  connectMin: 1,
  connectMax: 300,
  responseHeaderMin: 5,
  responseHeaderMax: 3600,
  composerMin: 1,
  composerMax: 3600,
} as const;

export type WsInjectDirection = "server" | "client";
export type WsInjectOpcode = "text" | "binary";
