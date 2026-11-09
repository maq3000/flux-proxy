export interface HeaderPair {
  name: string;
  value: string;
}

export interface WebSocketFrameRecord {
  index: number;
  direction: "outbound" | "inbound";
  opcode: string;
  payloadPreview: string;
  byteLength: number;
  timestamp: string;
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
}

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

export interface ProxyFilterBackendConfig {
  tlsInterceptMode: TlsInterceptMode;
  tlsBypassEnabled: boolean;
  tlsBypassRules: TlsBypassRule[];
  tlsTargetRules: TlsBypassRule[];
  headerMutationsEnabled: boolean;
  headerMutations: HeaderMutationRule[];
  stripAltSvc: boolean;
  hostListSync?: HostListBackendSyncConfig;
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
  followRedirects: boolean;
}

export interface CaCertificateInfo {
  certPemPath: string;
  certCerPath: string;
  sha256Fingerprint: string;
  subject: string;
  validUntil: string;
  isTrusted?: boolean;
}

export interface NetworkInterfaceInfo {
  name: string;
  ip: string;
  kind: string; // "wifi" | "ethernet" | "other"
  isPrimary: boolean;
}

export interface ProxyStatus {
  running: boolean;
  bindAddr: string;
  port: number;
  activeSessions: number;
  systemProxyEnabled: boolean;
  autoSystemProxy: boolean;
  systemProxyError?: string | null;
  allowRemote?: boolean;
}

export type ActiveNavSection = "traffic" | "composer" | "rules";

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
  responseStatus?: number | null;
  responseHeaders: HeaderPair[];
  responseBodyBase64: string;
  responseBodyText?: string | null;
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
  | "deflateDecompress";

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
  | "comment";

export type ToolbarGroupId =
  | "capture"
  | "proxyMode"
  | "breakpoints"
  | "quickFilter"
  | "categories"
  | "utilities"
  | "layout";

export type InspectorDockPosition = "bottom" | "right";

export interface UiLayoutPreferences {
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  inspectorPosition: InspectorDockPosition;
}
