import type {
  AddClientCertificateInput,
  AutoResponderRule,
  BindHostMode,
  BreakpointAction,
  BreakpointConfig,
  BreakpointResolution,
  BreakpointStage,
  ClientCertificateEntry,
  ClientCertificateFormat,
  ComposedRequest,
  HostRemapRule,
  LoadedSessionBody,
  NetworkInterfaceInfo,
  PausedBreakpointItem,
  ProxyFilterBackendConfig,
  ProxyStatus,
  PythonRunnerStatus,
  SanitizationOptions,
  ScriptConsoleLogEvent,
  SessionDetail,
  SessionSummary,
  SessionTimings,
  SessionTransferStats,
  StorageStats,
  ThrottleConfig,
  ThrottlePreset,
  UpstreamProxyConfig,
  UpstreamProxyProtocol,
  UpstreamTimeoutConfig,
  WebSocketFrameRecord,
  WsInjectDirection,
  WsInjectOpcode,
} from "../types/proxy";
import {
  DEFAULT_SESSION_RETENTION_LIMIT,
  DEFAULT_THROTTLE_CONFIG,
  DEFAULT_UPSTREAM_PROXY_BYPASS_LIST,
  DEFAULT_UPSTREAM_PROXY_CONFIG,
  DEFAULT_UPSTREAM_TIMEOUT_CONFIG,
  THROTTLE_PRESET_DEFINITIONS,
  UPSTREAM_TIMEOUT_LIMITS,
} from "../types/proxy";
import {
  applyHeaderMutationsInPreview,
  DEFAULT_BACKEND_FILTER_CONFIG,
  DEFAULT_TLS_BYPASS_RULES,
  evaluateShouldStoreSessionInPreview,
  evaluateTlsConnectInPreview,
  matchHostRuleList,
} from "./filterEngine";
import {
  buildFullRawHttpMessage,
  decodeBase64ToBytes,
  encodeTextToBase64,
  parseQueryParams,
} from "./formatters";
import {
  buildDefaultPreviewClientCertificates,
  buildInFlightSnapshot,
  buildSimulatedSession,
  DEFAULT_AUTORESPONDER_RULES,
  DEFAULT_CLEAR_DB_ON_EXIT,
  DEFAULT_HOST_REMAP_RULES,
  DEFAULT_PYTHON_SCRIPT_CODE,
  getSimulatedTwoPhaseDelayMs,
  PREVIEW_CLEAR_DB_ON_EXIT_STORAGE_KEY,
  PREVIEW_CLIENT_CERTS_STORAGE_KEY,
  PREVIEW_HOST_REMAP_RULES_STORAGE_KEY,
  PREVIEW_PYTHON_SCRIPT_STORAGE_KEY,
  PREVIEW_SQLITE_ARCHIVE_STORAGE_KEY,
  PREVIEW_SQLITE_COUNT_STORAGE_KEY,
  PREVIEW_THROTTLE_CONFIG_STORAGE_KEY,
  PREVIEW_UPSTREAM_PROXY_CONFIG_STORAGE_KEY,
  PREVIEW_UPSTREAM_TIMEOUTS_STORAGE_KEY,
  sanitizeSessionsInPreview,
} from "./mockTraffic";

export function encodeUint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    parts.push(String.fromCharCode(...sub));
  }
  return btoa(parts.join(""));
}

export function triggerBrowserDownload(
  bytes: Uint8Array,
  fileName: string,
  mimeType = "application/octet-stream"
): void {
  if (typeof document === "undefined") return;
  const safeName = fileName.split(/[\\/]/).pop() || "download.bin";
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const previewPickedFiles = new Map<string, File>();

export const DEFAULT_BREAKPOINT_CONFIG: BreakpointConfig = {
  breakBeforeRequest: false,
  breakAfterResponse: false,
  timeoutSecs: 120,
  rules: [],
};

function matchesBreakpointPattern(pattern: string, url: string): boolean {
  const pat = pattern.trim();
  if (!pat || pat === "*") return true;
  if (pat.startsWith("regex:")) {
    try {
      return new RegExp(pat.slice(6), "i").test(url);
    } catch {
      return false;
    }
  }
  if (pat.includes("*")) {
    const escaped = pat
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    try {
      return new RegExp(`^${escaped}$`, "i").test(url);
    } catch {
      return false;
    }
  }
  return url.toLowerCase().includes(pat.toLowerCase());
}

interface ParkedPreviewEntry {
  item: PausedBreakpointItem;
  resolve: (res: BreakpointResolution) => void;
  timerId: number;
}

// ============================================================================
// Browser Preview Fallback Engine (active when running via `npm run dev` without Tauri)
// ============================================================================
// ============================================================================
// Virtual DNS (HOSTS Remapping) & Throttling helpers (Browser Preview)
// ============================================================================
function stripSchemeAndPathPreview(raw: string): string {
  const s = raw.trim().replace(/^(https?|wss?):\/\//i, "");
  const slashIdx = s.indexOf("/");
  return slashIdx >= 0 ? s.slice(0, slashIdx) : s;
}

function stripOptionalPortPreview(authority: string): string {
  const trimmed = authority.trim();
  if (trimmed.startsWith("[")) {
    const closeIdx = trimmed.indexOf("]");
    if (closeIdx >= 0) {
      return trimmed.slice(1, closeIdx);
    }
  }
  const firstColon = trimmed.indexOf(":");
  if (firstColon >= 0 && firstColon === trimmed.lastIndexOf(":")) {
    const portPart = trimmed.slice(firstColon + 1);
    if (portPart.length > 0 && /^\d+$/.test(portPart)) {
      return trimmed.slice(0, firstColon);
    }
  }
  return trimmed;
}

function normalizeHostForMatchPreview(host: string): string {
  return stripOptionalPortPreview(stripSchemeAndPathPreview(host))
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

function normalizeHostRemapRulePreview(
  rule: HostRemapRule,
  idx: number
): HostRemapRule {
  const rawSource = (rule.sourcePattern ?? "").trim();
  if (!rawSource || /[\s\u0000-\u001f]/.test(rawSource)) {
    throw new Error("Исходный домен или маска не может быть пустой.");
  }
  const source = normalizeHostForMatchPreview(rawSource);
  if (!source || source === "*" || source === "*.") {
    throw new Error(
      "Укажите конкретный домен или маску (например, *.example.com) вместо '*'."
    );
  }

  const rawTarget = (rule.targetHost ?? "").trim();
  if (
    !rawTarget ||
    /[\s\u0000-\u001f]/.test(rawTarget) ||
    /[\\/?#]/.test(rawTarget)
  ) {
    throw new Error("Целевой хост или IP содержит недопустимые символы.");
  }
  const target = rawTarget
    .replace(/^(https?|wss?):\/\//i, "")
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (!target) {
    throw new Error("Целевой хост или IP не может быть пустым.");
  }
  if (/^[^:]+:\d+$/.test(target)) {
    throw new Error(
      "Укажите порт в отдельном поле Target Port, а не в Target Host."
    );
  }

  let targetPort: number | null = null;
  if (rule.targetPort !== undefined && rule.targetPort !== null) {
    const p = Number(rule.targetPort);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(
        "Целевой порт (Target Port) должен быть в диапазоне 1..65535."
      );
    }
    targetPort = p;
  }

  return {
    id: (rule.id ?? "").trim() || `remap-${idx + 1}`,
    enabled: Boolean(rule.enabled),
    sourcePattern: source,
    targetHost: target,
    targetPort,
    preserveHostHeader:
      typeof rule.preserveHostHeader === "boolean"
        ? rule.preserveHostHeader
        : true,
    comment: (rule.comment ?? "").trim(),
  };
}

function sourcePatternMatchesHostPreview(
  pattern: string,
  host: string
): boolean {
  const normHost = normalizeHostForMatchPreview(host);
  const normPattern = pattern
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (!normHost || !normPattern) return false;
  if (!normPattern.includes("*") && !normPattern.includes("?")) {
    return normHost === normPattern;
  }
  if (normPattern.startsWith("*.")) {
    const suffix = normPattern.slice(2);
    if (suffix && !suffix.includes("*") && !suffix.includes("?")) {
      return (
        normHost.length > suffix.length + 1 &&
        normHost.endsWith(`.${suffix}`)
      );
    }
  }
  const escaped = normPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(normHost);
}

function matchHostRemapPreview(
  rules: HostRemapRule[],
  host: string
): HostRemapRule | null {
  const normHost = normalizeHostForMatchPreview(host);
  if (!normHost) return null;
  let bestRule: HostRemapRule | null = null;
  let bestTier = -1;
  let bestLen = -1;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!sourcePatternMatchesHostPreview(rule.sourcePattern, normHost)) continue;
    const normPat = rule.sourcePattern.trim().replace(/\.+$/, "");
    let tier = 0;
    let len = normPat.length;
    if (!normPat.includes("*") && !normPat.includes("?")) {
      tier = 2;
    } else if (
      normPat.startsWith("*.") &&
      !normPat.slice(2).includes("*") &&
      !normPat.slice(2).includes("?")
    ) {
      tier = 1;
      len = normPat.length - 2;
    }
    if (tier > bestTier || (tier === bestTier && len > bestLen)) {
      bestTier = tier;
      bestLen = len;
      bestRule = rule;
    }
  }
  return bestRule;
}

function formatRemapTargetPreview(rule: HostRemapRule): string {
  const cleanHost = rule.targetHost.trim().replace(/^\[|\]$/g, "");
  const formatted = cleanHost.includes(":") ? `[${cleanHost}]` : cleanHost;
  return rule.targetPort ? `${formatted}:${rule.targetPort}` : formatted;
}

function normalizeThrottleConfigPreview(cfg: ThrottleConfig): ThrottleConfig {
  const validPresets = new Set<ThrottlePreset>([
    "none",
    "gprs",
    "slow3g",
    "fast3g",
    "lte",
    "offline",
    "custom",
  ]);
  const preset: ThrottlePreset = validPresets.has(cfg.preset)
    ? cfg.preset
    : "none";
  if (preset === "custom") {
    return {
      preset: "custom",
      downloadKbps: Math.max(0, Math.round(Number(cfg.downloadKbps) || 0)),
      uploadKbps: Math.max(0, Math.round(Number(cfg.uploadKbps) || 0)),
      latencyMs: Math.max(0, Math.round(Number(cfg.latencyMs) || 0)),
    };
  }
  const def = THROTTLE_PRESET_DEFINITIONS.find((d) => d.id === preset);
  return def
    ? {
        preset: def.id,
        downloadKbps: def.downloadKbps,
        uploadKbps: def.uploadKbps,
        latencyMs: def.latencyMs,
      }
    : { ...DEFAULT_THROTTLE_CONFIG };
}

function normalizeUpstreamProxyConfigPreview(
  cfg: Partial<UpstreamProxyConfig> | null | undefined,
  validateEnabled = false,
  listenPort?: number
): UpstreamProxyConfig {
  const rawProto = typeof cfg?.protocol === "string" ? cfg.protocol.toLowerCase() : "http";
  const protocol: UpstreamProxyProtocol =
    rawProto === "https" || rawProto === "socks5" ? rawProto : "http";
  const enabled = Boolean(cfg?.enabled);
  const host = typeof cfg?.host === "string" ? cfg.host.trim() : "";
  const defaultPort = protocol === "https" ? 8443 : protocol === "socks5" ? 1080 : 8080;
  const rawPort = Number(cfg?.port);
  const port =
    Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535
      ? rawPort
      : defaultPort;
  const rawUsername =
    typeof cfg?.username === "string" ? cfg.username.trim() : "";
  const username = rawUsername.length > 0 ? rawUsername : null;
  const rawBypass = Array.isArray(cfg?.bypassList)
    ? cfg.bypassList
    : DEFAULT_UPSTREAM_PROXY_BYPASS_LIST;
  const seen = new Set<string>();
  const bypassList: string[] = [];
  for (const item of rawBypass) {
    if (typeof item !== "string") continue;
    const clean = item.trim();
    if (!clean) continue;
    const dedup = clean.toLowerCase();
    if (!seen.has(dedup)) {
      seen.add(dedup);
      bypassList.push(clean);
    }
  }

  if (validateEnabled && enabled) {
    if (!host) {
      throw new Error("Укажите хост вышестоящего прокси.");
    }
    if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
      throw new Error("Укажите корректный порт (1–65535).");
    }
    const cleanHost = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      listenPort &&
      port === listenPort &&
      (cleanHost === "localhost" || cleanHost === "127.0.0.1" || cleanHost === "::1")
    ) {
      throw new Error(
        `Обнаружена петля каскадирования: вышестоящий прокси указывает на локальный порт FluxProxy (:${listenPort}).`
      );
    }
  }

  return {
    enabled,
    protocol,
    host,
    port,
    username,
    bypassList,
  };
}

function validateUpstreamTimeoutConfigPreview(
  cfg: UpstreamTimeoutConfig
): UpstreamTimeoutConfig {
  const c = cfg.connectTimeoutSec;
  const r = cfg.responseHeaderTimeoutSec;
  const cmp = cfg.composerTimeoutSec;
  if (
    !Number.isInteger(c) ||
    c < UPSTREAM_TIMEOUT_LIMITS.connectMin ||
    c > UPSTREAM_TIMEOUT_LIMITS.connectMax
  ) {
    throw new Error(
      `connectTimeoutSec must be between ${UPSTREAM_TIMEOUT_LIMITS.connectMin} and ${UPSTREAM_TIMEOUT_LIMITS.connectMax} seconds`
    );
  }
  if (
    !Number.isInteger(r) ||
    (r !== 0 &&
      (r < UPSTREAM_TIMEOUT_LIMITS.responseHeaderMin ||
        r > UPSTREAM_TIMEOUT_LIMITS.responseHeaderMax))
  ) {
    throw new Error(
      `responseHeaderTimeoutSec must be 0 (Unlimited) or between ${UPSTREAM_TIMEOUT_LIMITS.responseHeaderMin} and ${UPSTREAM_TIMEOUT_LIMITS.responseHeaderMax} seconds`
    );
  }
  if (
    !Number.isInteger(cmp) ||
    (cmp !== 0 &&
      (cmp < UPSTREAM_TIMEOUT_LIMITS.composerMin ||
        cmp > UPSTREAM_TIMEOUT_LIMITS.composerMax))
  ) {
    throw new Error(
      `composerTimeoutSec must be 0 (Unlimited) or between ${UPSTREAM_TIMEOUT_LIMITS.composerMin} and ${UPSTREAM_TIMEOUT_LIMITS.composerMax} seconds`
    );
  }
  return {
    connectTimeoutSec: c,
    responseHeaderTimeoutSec: r,
    composerTimeoutSec: cmp,
  };
}

function normalizeUpstreamTimeoutConfigPreview(
  cfg: Partial<UpstreamTimeoutConfig> | null | undefined
): UpstreamTimeoutConfig {
  const rawC = cfg?.connectTimeoutSec;
  const rawR = cfg?.responseHeaderTimeoutSec;
  const rawCmp = cfg?.composerTimeoutSec;
  return {
    connectTimeoutSec:
      typeof rawC === "number" && Number.isInteger(rawC)
        ? Math.min(
            UPSTREAM_TIMEOUT_LIMITS.connectMax,
            Math.max(UPSTREAM_TIMEOUT_LIMITS.connectMin, rawC)
          )
        : DEFAULT_UPSTREAM_TIMEOUT_CONFIG.connectTimeoutSec,
    responseHeaderTimeoutSec:
      rawR === 0
        ? 0
        : typeof rawR === "number" && Number.isInteger(rawR)
          ? Math.min(
              UPSTREAM_TIMEOUT_LIMITS.responseHeaderMax,
              Math.max(UPSTREAM_TIMEOUT_LIMITS.responseHeaderMin, rawR)
            )
          : DEFAULT_UPSTREAM_TIMEOUT_CONFIG.responseHeaderTimeoutSec,
    composerTimeoutSec:
      rawCmp === 0
        ? 0
        : typeof rawCmp === "number" && Number.isInteger(rawCmp)
          ? Math.min(
              UPSTREAM_TIMEOUT_LIMITS.composerMax,
              Math.max(UPSTREAM_TIMEOUT_LIMITS.composerMin, rawCmp)
            )
          : DEFAULT_UPSTREAM_TIMEOUT_CONFIG.composerTimeoutSec,
  };
}

function parseHexPayloadPreview(raw: string): Uint8Array {
  const cleanedParts: string[] = [];
  for (const tok of raw.split(/[\s:\-,]+/)) {
    if (!tok) continue;
    const stripped =
      tok.startsWith("0x") || tok.startsWith("0X") ? tok.slice(2) : tok;
    cleanedParts.push(stripped);
  }
  const hexChars = cleanedParts.join("");
  if (hexChars.length === 0) return new Uint8Array(0);
  if (hexChars.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hexChars)) {
    throw new Error(
      "Некорректный Hex payload: ожидается чётное количество шестнадцатеричных символов (0-9, a-f)."
    );
  }
  const out = new Uint8Array(hexChars.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hexChars.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export class BrowserPreviewEngine {
  private running = true;
  private bindMode: BindHostMode = "loopback";
  private specificBindIp: string | null = null;
  private alsoBindLoopback = true;
  private bindAddr = "127.0.0.1";
  private allowRemote = false;
  private port = 8888;
  private systemProxyEnabled = true;
  private autoSystemProxy = true;
  private systemProxyError: string | null = null;
  private nextId = 1;
  private nextBpSeq = 1;
  private store = new Map<number, SessionDetail>();
  private sessionRetentionLimit: number | null =
    DEFAULT_SESSION_RETENTION_LIMIT;
  private droppedSessionsCount = 0;
  private evictedSqliteBytes = 0;
  private clearDbOnExit = DEFAULT_CLEAR_DB_ON_EXIT;
  private offloadedBodies = new Map<
    string,
    { bodyBase64: string; bodyText: string | null; bodySize: number }
  >();
  private autoResponderEnabled = true;
  private rules: AutoResponderRule[] = [...DEFAULT_AUTORESPONDER_RULES];
  private filterConfig: ProxyFilterBackendConfig = structuredClone(
    DEFAULT_BACKEND_FILTER_CONFIG
  );
  private tlsRuleHitCounts = new Map<string, number>();
  private breakpointConfig: BreakpointConfig = structuredClone(
    DEFAULT_BREAKPOINT_CONFIG
  );
  private pausedBreakpoints = new Map<string, ParkedPreviewEntry>();
  private clientCertificates: ClientCertificateEntry[] =
    buildDefaultPreviewClientCertificates();
  private hostRemapRules: HostRemapRule[] = [...DEFAULT_HOST_REMAP_RULES];
  private throttleConfig: ThrottleConfig = { ...DEFAULT_THROTTLE_CONFIG };
  private upstreamProxyConfig: UpstreamProxyConfig = {
    ...DEFAULT_UPSTREAM_PROXY_CONFIG,
    bypassList: [...DEFAULT_UPSTREAM_PROXY_BYPASS_LIST],
  };
  private upstreamProxyPassword: string | null = null;
  private upstreamTimeouts: UpstreamTimeoutConfig = {
    ...DEFAULT_UPSTREAM_TIMEOUT_CONFIG,
  };
  private activeComposerControllers = new Map<string, AbortController>();
  private listeners = new Set<(batch: SessionSummary[]) => void>();
  private removedListeners = new Set<(ids: number[]) => void>();
  private bpListeners = new Set<(items: PausedBreakpointItem[]) => void>();
  private statusListeners = new Set<(status: ProxyStatus) => void>();
  private storageStatsListeners = new Set<(stats: StorageStats) => void>();
  private scriptLogListeners = new Set<(entry: ScriptConsoleLogEvent) => void>();
  private scriptEnabled = false;
  private scriptCode = DEFAULT_PYTHON_SCRIPT_CODE;
  private scriptInvocationsCount = 0;
  private nextScriptLogId = 1;
  private timer: number | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      try {
        const rawAuto = window.localStorage.getItem(
          "fluxproxy.autoSystemProxy.v1"
        );
        if (rawAuto !== null) {
          this.autoSystemProxy = Boolean(JSON.parse(rawAuto));
          this.systemProxyEnabled = this.running && this.autoSystemProxy;
        }
        const rawBindMode = window.localStorage.getItem(
          "fluxproxy.bindMode.v1"
        );
        const rawSpecificIp = window.localStorage.getItem(
          "fluxproxy.specificBindIp.v1"
        );
        const rawAlsoLoopback = window.localStorage.getItem(
          "fluxproxy.alsoBindLoopback.v1"
        );
        if (rawSpecificIp !== null) {
          const parsedIp = JSON.parse(rawSpecificIp);
          this.specificBindIp =
            typeof parsedIp === "string" && parsedIp.trim().length > 0
              ? parsedIp.trim()
              : null;
        }
        if (rawAlsoLoopback !== null) {
          this.alsoBindLoopback = Boolean(JSON.parse(rawAlsoLoopback));
        }
        if (rawBindMode !== null) {
          const parsedMode = JSON.parse(rawBindMode);
          if (
            parsedMode === "loopback" ||
            parsedMode === "all" ||
            parsedMode === "specific"
          ) {
            if (parsedMode === "specific" && !this.specificBindIp) {
              this.bindMode = "loopback";
            } else {
              this.bindMode = parsedMode;
            }
          }
        } else {
          const rawRemote = window.localStorage.getItem(
            "fluxproxy.allowRemote.v1"
          );
          if (rawRemote !== null) {
            this.bindMode = Boolean(JSON.parse(rawRemote)) ? "all" : "loopback";
          }
        }
        this.syncDerivedBindState();
        const rawLimit = window.localStorage.getItem(
          "fluxproxy.sessionRetentionLimit.v1"
        );
        if (rawLimit !== null) {
          const parsedLimit = JSON.parse(rawLimit) as number | null;
          if (
            parsedLimit === null ||
            (typeof parsedLimit === "number" &&
              Number.isInteger(parsedLimit) &&
              parsedLimit > 0)
          ) {
            this.sessionRetentionLimit = parsedLimit;
          }
        }
        const rawDrop = window.localStorage.getItem(
          "fluxproxy.dropNonMatching.v1"
        );
        if (rawDrop !== null) {
          this.filterConfig.dropNonMatchingOnCapture = Boolean(
            JSON.parse(rawDrop)
          );
        }
        const rawClearDbOnExit = window.localStorage.getItem(
          PREVIEW_CLEAR_DB_ON_EXIT_STORAGE_KEY
        );
        if (rawClearDbOnExit !== null) {
          this.clearDbOnExit = Boolean(JSON.parse(rawClearDbOnExit));
        }
        const rawPort = window.localStorage.getItem("fluxproxy.proxyPort.v1");
        if (rawPort !== null) {
          const parsedPort = Number(JSON.parse(rawPort));
          if (
            Number.isInteger(parsedPort) &&
            parsedPort >= 1 &&
            parsedPort <= 65535
          ) {
            this.port = parsedPort;
          }
        }
        const rawAutoResp = window.localStorage.getItem(
          "fluxproxy.autoResponder.v1"
        );
        if (rawAutoResp !== null) {
          const parsedAutoResp = JSON.parse(rawAutoResp) as {
            enabled?: unknown;
            rules?: unknown;
          };
          if (parsedAutoResp && typeof parsedAutoResp === "object") {
            if (typeof parsedAutoResp.enabled === "boolean") {
              this.autoResponderEnabled = parsedAutoResp.enabled;
            }
            if (Array.isArray(parsedAutoResp.rules)) {
              this.rules = parsedAutoResp.rules as AutoResponderRule[];
            }
          }
        }
        const rawClientCerts = window.localStorage.getItem(
          PREVIEW_CLIENT_CERTS_STORAGE_KEY
        );
        if (rawClientCerts !== null) {
          const parsedCerts = JSON.parse(rawClientCerts);
          if (Array.isArray(parsedCerts)) {
            this.clientCertificates = parsedCerts as ClientCertificateEntry[];
          }
        }
        const rawScript = window.localStorage.getItem(
          PREVIEW_PYTHON_SCRIPT_STORAGE_KEY
        );
        if (rawScript !== null) {
          const parsedScript = JSON.parse(rawScript) as {
            enabled?: unknown;
            code?: unknown;
          };
          if (parsedScript && typeof parsedScript === "object") {
            if (typeof parsedScript.enabled === "boolean") {
              this.scriptEnabled = parsedScript.enabled;
            }
            if (typeof parsedScript.code === "string") {
              this.scriptCode = parsedScript.code;
            }
          }
        }
        const rawHostRemap = window.localStorage.getItem(
          PREVIEW_HOST_REMAP_RULES_STORAGE_KEY
        );
        if (rawHostRemap !== null) {
          const parsedRemap = JSON.parse(rawHostRemap);
          if (Array.isArray(parsedRemap)) {
            this.hostRemapRules = (parsedRemap as HostRemapRule[]).map(
              (r, idx) => normalizeHostRemapRulePreview(r, idx)
            );
          }
        }
        const rawThrottle = window.localStorage.getItem(
          PREVIEW_THROTTLE_CONFIG_STORAGE_KEY
        );
        if (rawThrottle !== null) {
          const parsedThrottle = JSON.parse(rawThrottle);
          if (parsedThrottle && typeof parsedThrottle === "object") {
            this.throttleConfig = normalizeThrottleConfigPreview(
              parsedThrottle as ThrottleConfig
            );
          }
        }
        const rawUpstream = window.localStorage.getItem(
          PREVIEW_UPSTREAM_PROXY_CONFIG_STORAGE_KEY
        );
        if (rawUpstream !== null) {
          const parsedUpstream = JSON.parse(rawUpstream);
          if (parsedUpstream && typeof parsedUpstream === "object") {
            this.upstreamProxyConfig = normalizeUpstreamProxyConfigPreview(
              parsedUpstream as Partial<UpstreamProxyConfig>
            );
          }
        }
        const rawTimeouts = window.localStorage.getItem(
          PREVIEW_UPSTREAM_TIMEOUTS_STORAGE_KEY
        );
        if (rawTimeouts !== null) {
          const parsedTimeouts = JSON.parse(rawTimeouts);
          if (parsedTimeouts && typeof parsedTimeouts === "object") {
            this.upstreamTimeouts = normalizeUpstreamTimeoutConfigPreview(
              parsedTimeouts as Partial<UpstreamTimeoutConfig>
            );
          }
        }
      } catch {
        // ignore storage errors in preview
      }
    }

    // Seed initial realistic sessions immediately
    for (let i = 0; i < 18; i++) {
      const detail = this.applyPipelineToDetail(
        buildSimulatedSession(this.nextId++)
      );
      if (evaluateShouldStoreSessionInPreview(detail.summary, this.filterConfig)) {
        this.insertIntoStoreWithRingBuffer(detail);
      } else {
        this.droppedSessionsCount += 1;
      }
    }
    this.startTicker();
  }

  private insertIntoStoreWithRingBuffer(rawDetail: SessionDetail): SessionDetail {
    const threshold = 2 * 1024 * 1024;
    let detail = rawDetail;

    if (detail.summary.bodySize > threshold && detail.responseBodyBase64) {
      this.offloadedBodies.set(`${detail.summary.id}:resp`, {
        bodyBase64: detail.responseBodyBase64,
        bodyText: detail.responseBodyText ?? null,
        bodySize: detail.summary.bodySize,
      });
      detail = {
        ...detail,
        responseBodyBase64: "",
        responseBodyText: null,
        bodyOffloaded: true,
      };
    }

    this.store.set(detail.summary.id, detail);
    this.enforceRetentionLimit();
    return detail;
  }

  private enforceRetentionLimit() {
    if (
      this.sessionRetentionLimit === null ||
      this.store.size <= this.sessionRetentionLimit
    ) {
      return;
    }
    const sortedIds = Array.from(this.store.keys()).sort((a, b) => a - b);
    const excess = sortedIds.length - this.sessionRetentionLimit;
    for (let i = 0; i < excess; i++) {
      const evicted = this.store.get(sortedIds[i]);
      if (evicted) {
        this.evictedSqliteBytes += Math.max(512, evicted.summary.bodySize);
        this.store.delete(sortedIds[i]);
      }
    }
  }

  private mergePreservedAnnotations(detail: SessionDetail): SessionDetail {
    const existing = this.store.get(detail.summary.id);
    if (!existing) return detail;
    return {
      ...detail,
      summary: {
        ...detail.summary,
        comment: detail.summary.comment ?? existing.summary.comment ?? null,
        markedColor:
          detail.summary.markedColor ?? existing.summary.markedColor ?? null,
      },
    };
  }

  private commitInFlightSession(detail: SessionDetail): boolean {
    const merged = this.mergePreservedAnnotations(detail);
    const hadExisting = this.store.has(merged.summary.id);
    if (!evaluateShouldStoreSessionInPreview(merged.summary, this.filterConfig)) {
      if (hadExisting) {
        this.store.delete(merged.summary.id);
        this.emitRemoved([merged.summary.id]);
      }
      return false;
    }
    const stored = this.insertIntoStoreWithRingBuffer(merged);
    this.emitBatch([stored.summary]);
    return true;
  }

  private commitCompletedSession(detail: SessionDetail): SessionDetail {
    const merged = this.mergePreservedAnnotations(detail);
    const hadExisting = this.store.has(merged.summary.id);
    if (!evaluateShouldStoreSessionInPreview(merged.summary, this.filterConfig)) {
      if (hadExisting) {
        this.store.delete(merged.summary.id);
        this.emitRemoved([merged.summary.id]);
      }
      this.droppedSessionsCount += 1;
      return merged;
    }
    const stored = this.insertIntoStoreWithRingBuffer(merged);
    this.emitBatch([stored.summary]);
    return stored;
  }

  private shouldBreak(
    stage: "request" | "response",
    method: string,
    url: string
  ): boolean {
    if (stage === "request" && this.breakpointConfig.breakBeforeRequest) {
      return true;
    }
    if (stage === "response" && this.breakpointConfig.breakAfterResponse) {
      return true;
    }
    for (const rule of this.breakpointConfig.rules) {
      if (!rule.enabled) continue;
      if (rule.stage !== "both" && rule.stage !== stage) continue;
      if (
        rule.methodFilter &&
        rule.methodFilter.trim() &&
        rule.methodFilter.toUpperCase() !== "ANY" &&
        rule.methodFilter.toUpperCase() !== method.toUpperCase()
      ) {
        continue;
      }
      if (matchesBreakpointPattern(rule.urlPattern, url)) {
        return true;
      }
    }
    return false;
  }

  private emitBreakpointsSnapshot() {
    const items = this.listPausedBreakpoints();
    for (const cb of this.bpListeners) {
      cb(items);
    }
  }

  private parkOnBreakpoint(
    draft: Omit<PausedBreakpointItem, "breakpointId" | "createdAt" | "timeoutSecs">
  ): Promise<BreakpointResolution> {
    const breakpointId = `bp-${this.nextBpSeq++}`;
    const timeoutSecs = Math.max(
      5,
      Math.min(600, this.breakpointConfig.timeoutSecs || 120)
    );
    const item: PausedBreakpointItem = {
      ...draft,
      breakpointId,
      createdAt: new Date().toISOString(),
      timeoutSecs,
    };

    return new Promise<BreakpointResolution>((resolve) => {
      const timerId =
        typeof window !== "undefined"
          ? window.setTimeout(() => {
              if (this.pausedBreakpoints.delete(breakpointId)) {
                this.emitBreakpointsSnapshot();
                resolve({
                  breakpointId,
                  action: "continue",
                });
              }
            }, timeoutSecs * 1000)
          : 0;

      this.pausedBreakpoints.set(breakpointId, {
        item,
        resolve,
        timerId,
      });
      this.emitBreakpointsSnapshot();
    });
  }

  private recordTlsRuleHit(ruleId: string): void {
    this.tlsRuleHitCounts.set(
      ruleId,
      (this.tlsRuleHitCounts.get(ruleId) ?? 0) + 1
    );
  }

  private applyPipelineToDetail(rawDetail: SessionDetail): SessionDetail {
    const remapRule = matchHostRemapPreview(
      this.hostRemapRules,
      rawDetail.summary.host
    );
    const remappedTo = remapRule ? formatRemapTargetPreview(remapRule) : null;
    const throttleCfg = this.throttleConfig;

    if (throttleCfg.preset === "offline") {
      const offlineMsg = "Network Offline (Bandwidth Throttling: Offline)";
      return {
        ...rawDetail,
        summary: {
          ...rawDetail.summary,
          status: 503,
          contentType: "text/plain; charset=utf-8",
          bodySize: offlineMsg.length,
          isMocked: false,
          error: offlineMsg,
          remappedTo,
        },
        responseHeaders: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
        responseBodyBase64: encodeTextToBase64(offlineMsg),
        responseBodyText: offlineMsg,
      };
    }

    // 1. Check Selective TLS / MITM Pass-Through (`interceptAll` Bypass list vs `targetedOnly` Allowlist)
    if (rawDetail.summary.scheme === "https" || rawDetail.summary.scheme === "wss") {
      const decision = evaluateTlsConnectInPreview(
        rawDetail.summary.host,
        443,
        this.filterConfig
      );
      if (decision.mode === "passthrough") {
        let protocolLabel = "TLS-BYPASS";
        let note: string;
        let modeHeaderValue: string;
        let tlsVersionLabel: string;

        if (decision.reason === "notInTargetAllowlist") {
          protocolLabel = "PASSTHROUGH";
          note = [
            "[Selective MITM Pass-Through Tunnel Active]",
            `Host: ${rawDetail.summary.host}:443`,
            "Mode: Targeted Only (Inspect Allowlist Only)",
            "Reason: Host is outside Target Allowlist — relayed as pure encrypted TCP stream via tokio::io::copy_bidirectional (zero CA substitution, mTLS & Certificate Pinning intact).",
          ].join("\n");
          modeHeaderValue = "Passthrough (Targeted-Only Allowlist Mode)";
          tlsVersionLabel = "Pure TCP Passthrough (Targeted-Only)";
        } else if (decision.reason === "notInHostsWhitelist") {
          protocolLabel = "PASSTHROUGH";
          note = [
            "[Hosts List Whitelist Pass-Through Active]",
            `Host: ${rawDetail.summary.host}:443`,
            "Mode: Bulk Hosts List — Show only (Whitelist) + TLS Passthrough",
            "Reason: Host is not matched by Hosts List Whitelist — relayed as pure encrypted TCP stream via tokio::io::copy_bidirectional.",
          ].join("\n");
          modeHeaderValue = "Passthrough (Hosts List Whitelist)";
          tlsVersionLabel = "Pure TCP Passthrough (Hosts List Whitelist)";
        } else {
          this.recordTlsRuleHit(decision.rule.id);
          note = [
            "[TLS / MITM Passthrough Tunnel Active]",
            `Host: ${rawDetail.summary.host}:443`,
            `Matched Bypass Rule: ${decision.rule.pattern} (${decision.rule.description})`,
            "Relay Mode: Direct TCP tunnel via tokio::io::copy_bidirectional (no certificate replacement / pinning preserved).",
          ].join("\n");
          modeHeaderValue = `Passthrough (${decision.rule.pattern})`;
          tlsVersionLabel = `SSL Passthrough (${decision.rule.category})`;
        }

        const passthroughHeaders = [
          {
            name: "X-FluxProxy-TLS-Mode",
            value: modeHeaderValue,
          },
          ...(remappedTo
            ? [{ name: "X-FluxProxy-Host-Remap", value: remappedTo }]
            : []),
        ];
        const finalNote = remappedTo
          ? `${note}\nHOSTS Remapped Target: ${remappedTo}`
          : note;

        return {
          ...rawDetail,
          summary: {
            ...rawDetail.summary,
            status: 200,
            protocol: protocolLabel,
            method: "CONNECT",
            path: `Tunnel to ${rawDetail.summary.host}:443`,
            url: `https://${rawDetail.summary.host}:443/`,
            contentType: "tls/passthrough",
            durationMs:
              rawDetail.summary.durationMs + (throttleCfg.latencyMs || 0),
            tlsBypassed: true,
            isMocked: false,
            remappedTo,
          },
          requestHeaders: [
            { name: "Host", value: `${rawDetail.summary.host}:443` },
            { name: "Proxy-Connection", value: "keep-alive" },
          ],
          responseHeaders: passthroughHeaders,
          requestBodyBase64: "",
          requestBodyText: null,
          responseBodyBase64: encodeTextToBase64(finalNote),
          responseBodyText: finalNote,
          tlsVersion: tlsVersionLabel,
        };
      }
      if (this.filterConfig.tlsInterceptMode === "targetedOnly") {
        const matchedTarget = matchHostRuleList(
          this.filterConfig.tlsTargetRules ?? [],
          rawDetail.summary.host,
          443
        );
        if (matchedTarget) {
          this.recordTlsRuleHit(matchedTarget.id);
        }
      }
    }

    // 2. Apply Lightweight Request Header Mutations
    const reqMut = applyHeaderMutationsInPreview(
      "request",
      rawDetail.summary.url,
      rawDetail.requestHeaders,
      this.filterConfig
    );

    let detail: SessionDetail = {
      ...rawDetail,
      requestHeaders: reqMut.headers,
      summary: {
        ...rawDetail.summary,
        headersMutated: reqMut.mutated,
        clientIp:
          rawDetail.summary.clientIp ??
          (this.allowRemote && rawDetail.summary.id % 4 === 0
            ? "192.168.1.58"
            : "127.0.0.1"),
        processName:
          this.allowRemote && rawDetail.summary.id % 4 === 0
            ? null
            : rawDetail.summary.processName,
        processPid:
          this.allowRemote && rawDetail.summary.id % 4 === 0
            ? null
            : rawDetail.summary.processPid,
      },
    };

    // If conditional request headers (If-Modified-Since / If-None-Match) were stripped on a 304, simulate fresh 200 OK
    const strippedConditional =
      rawDetail.summary.status === 304 &&
      !reqMut.headers.some((h) => {
        const n = h.name.toLowerCase();
        return n === "if-modified-since" || n === "if-none-match";
      });
    if (strippedConditional) {
      const freshBody =
        "// Fresh uncached JS bundle (cache-bypass mutation active)\nexport const bundleVersion = '2026.10';\n";
      detail = {
        ...detail,
        summary: {
          ...detail.summary,
          status: 200,
          bodySize: freshBody.length,
        },
        responseBodyText: freshBody,
        responseBodyBase64: encodeTextToBase64(freshBody),
      };
    }

    // 3. Evaluate AutoResponder Rules
    const matched = this.findMatchingRule(
      detail.summary.method,
      detail.summary.url,
      detail.requestHeaders
    );

    if (matched) {
      detail = {
        ...detail,
        summary: {
          ...detail.summary,
          durationMs: detail.summary.durationMs + matched.latencyMs,
          matchedRuleId: matched.id,
        },
      };

      if (matched.action === "mockResponse") {
        const bytesLen = new TextEncoder().encode(matched.responseBody).length;
        detail.summary = {
          ...detail.summary,
          status: matched.statusCode,
          isMocked: true,
          error: null,
          bodySize: bytesLen,
          contentType:
            matched.responseHeaders.find(
              (h) => h.name.toLowerCase() === "content-type"
            )?.value ?? "application/json; charset=utf-8",
        };
        detail.responseHeaders = [...matched.responseHeaders];
        detail.responseBodyText = matched.responseBody;
        detail.responseBodyBase64 = encodeTextToBase64(matched.responseBody);
      } else if (matched.action === "overrideStatus") {
        detail.summary = {
          ...detail.summary,
          status: matched.statusCode,
          isMocked: true,
        };
      }
    }

    // 4. Apply Lightweight Response Header Mutations
    const respMut = applyHeaderMutationsInPreview(
      "response",
      detail.summary.url,
      detail.responseHeaders,
      this.filterConfig
    );
    detail.responseHeaders = respMut.headers;
    detail.summary.headersMutated = reqMut.mutated || respMut.mutated;
    detail.summary.remappedTo = remappedTo;
    if (throttleCfg.latencyMs > 0) {
      detail.summary.durationMs += throttleCfg.latencyMs;
    }

    return detail;
  }

  async simulateLiveSessionFlow(): Promise<SessionDetail> {
    let detail = this.applyPipelineToDetail(
      buildSimulatedSession(this.nextId++)
    );
    const id = detail.summary.id;
    let bpModified = false;

    if (
      this.scriptEnabled &&
      !detail.summary.tlsBypassed &&
      detail.summary.scheme !== "wss"
    ) {
      const hooks = this.detectScriptHooks(this.scriptCode);
      if (hooks.hasOnRequest) {
        this.scriptInvocationsCount += 1;
        this.emitScriptLog(
          "info",
          "on_request",
          id,
          `[Simulator] on_request(${detail.summary.method} ${detail.summary.url}) — в Browser Preview Python-раннер не запускается; используйте \`cargo tauri dev\`.`
        );
      }
    }

    if (
      !detail.summary.tlsBypassed &&
      detail.summary.scheme !== "wss" &&
      this.shouldBreak("request", detail.summary.method, detail.summary.url)
    ) {
      const pendingReq: SessionDetail = {
        ...detail,
        summary: {
          ...detail.summary,
          status: 0,
          breakpointPaused: "request",
        },
      };
      this.store.set(id, pendingReq);
      this.emitBatch([pendingReq.summary]);

      const verdict = await this.parkOnBreakpoint({
        sessionId: id,
        stage: "request" as BreakpointStage,
        scheme: detail.summary.scheme,
        method: detail.summary.method,
        url: detail.summary.url,
        host: detail.summary.host,
        path: detail.summary.path,
        requestHeaders: detail.requestHeaders,
        requestBodyBase64: detail.requestBodyBase64,
        requestBodyText: detail.requestBodyText,
        responseStatus: null,
        responseHeaders: [],
        responseBodyBase64: "",
        responseBodyText: null,
        processName: detail.summary.processName,
        processPid: detail.summary.processPid,
      });

      if (verdict.action === "abort") {
        const abortedBody =
          '{"error":"Aborted at Live Breakpoint (Before Request)"}';
        const abortedDetail: SessionDetail = {
          ...detail,
          summary: {
            ...detail.summary,
            status: 502,
            error: "Aborted at Breakpoint (Before Request)",
            breakpointPaused: null,
            breakpointModified: true,
            bodySize: abortedBody.length,
          },
          responseBodyText: abortedBody,
          responseBodyBase64: encodeTextToBase64(abortedBody),
        };
        return this.commitCompletedSession(abortedDetail);
      }

      if (verdict.method && verdict.method.trim()) {
        detail.summary.method = verdict.method.trim().toUpperCase();
        bpModified = true;
      }
      if (verdict.url && verdict.url.trim() && verdict.url !== detail.summary.url) {
        try {
          const u = new URL(verdict.url.trim());
          detail.summary.url = u.toString();
          detail.summary.host = u.host;
          detail.summary.path = `${u.pathname}${u.search}`;
          bpModified = true;
        } catch {
          detail.summary.url = verdict.url.trim();
          bpModified = true;
        }
      }
      if (verdict.requestHeaders) {
        detail.requestHeaders = verdict.requestHeaders;
        bpModified = true;
      }
      if (typeof verdict.requestBodyText === "string") {
        detail.requestBodyText = verdict.requestBodyText;
        detail.requestBodyBase64 = verdict.requestBodyText
          ? encodeTextToBase64(verdict.requestBodyText)
          : "";
        bpModified = true;
      } else if (typeof verdict.requestBodyBase64 === "string") {
        detail.requestBodyBase64 = verdict.requestBodyBase64;
        bpModified = true;
      }
    }

    // Two-Phase Capture Phase 1: emit In-Flight session (status: 0) before simulated upstream response arrives
    if (!detail.summary.tlsBypassed && !detail.summary.isMocked) {
      const inFlight = buildInFlightSnapshot(detail);
      inFlight.summary.breakpointModified = bpModified;
      this.commitInFlightSession(inFlight);
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, getSimulatedTwoPhaseDelayMs(detail))
      );
    }

    if (
      !detail.summary.tlsBypassed &&
      detail.summary.scheme !== "wss" &&
      this.shouldBreak("response", detail.summary.method, detail.summary.url)
    ) {
      const pendingResp: SessionDetail = {
        ...detail,
        summary: {
          ...detail.summary,
          breakpointPaused: "response",
          breakpointModified: bpModified,
        },
      };
      this.store.set(id, pendingResp);
      this.emitBatch([pendingResp.summary]);

      const verdict = await this.parkOnBreakpoint({
        sessionId: id,
        stage: "response" as BreakpointStage,
        scheme: detail.summary.scheme,
        method: detail.summary.method,
        url: detail.summary.url,
        host: detail.summary.host,
        path: detail.summary.path,
        requestHeaders: detail.requestHeaders,
        requestBodyBase64: detail.requestBodyBase64,
        requestBodyText: detail.requestBodyText,
        responseStatus: detail.summary.status,
        responseHeaders: detail.responseHeaders,
        responseBodyBase64: detail.responseBodyBase64,
        responseBodyText: detail.responseBodyText,
        processName: detail.summary.processName,
        processPid: detail.summary.processPid,
      });

      if (verdict.action === "abort") {
        const abortedBody =
          '{"error":"Aborted at Live Breakpoint (After Response)"}';
        const abortedDetail: SessionDetail = {
          ...detail,
          summary: {
            ...detail.summary,
            status: 504,
            error: "Aborted at Breakpoint (After Response)",
            breakpointPaused: null,
            breakpointModified: true,
            bodySize: abortedBody.length,
          },
          responseBodyText: abortedBody,
          responseBodyBase64: encodeTextToBase64(abortedBody),
        };
        return this.commitCompletedSession(abortedDetail);
      }

      if (typeof verdict.statusCode === "number" && verdict.statusCode >= 100) {
        detail.summary.status = verdict.statusCode;
        detail.summary.error =
          verdict.statusCode >= 500
            ? `Overridden to HTTP ${verdict.statusCode} at Breakpoint`
            : null;
        bpModified = true;
      }
      if (verdict.responseHeaders) {
        detail.responseHeaders = verdict.responseHeaders;
        const ct = verdict.responseHeaders.find(
          (h) => h.name.toLowerCase() === "content-type"
        )?.value;
        if (ct) detail.summary.contentType = ct;
        bpModified = true;
      }
      if (typeof verdict.responseBodyText === "string") {
        detail.responseBodyText = verdict.responseBodyText;
        detail.responseBodyBase64 = encodeTextToBase64(verdict.responseBodyText);
        detail.summary.bodySize = new TextEncoder().encode(
          verdict.responseBodyText
        ).length;
        bpModified = true;
      } else if (typeof verdict.responseBodyBase64 === "string") {
        detail.responseBodyBase64 = verdict.responseBodyBase64;
        bpModified = true;
      }
    }

    detail.summary.breakpointPaused = null;
    detail.summary.breakpointModified = bpModified;
    return this.commitCompletedSession(detail);
  }

  private findMatchingRule(
    method: string,
    url: string,
    headers: { name: string; value: string }[]
  ): AutoResponderRule | undefined {
    if (!this.autoResponderEnabled) return undefined;
    return this.rules.find((r) => {
      if (!r.enabled) return false;
      if (
        r.methodFilter &&
        r.methodFilter !== "ANY" &&
        r.methodFilter.toUpperCase() !== method.toUpperCase()
      ) {
        return false;
      }
      if (r.matchTarget === "urlContains") {
        return url.toLowerCase().includes(r.pattern.toLowerCase());
      }
      if (r.matchTarget === "urlRegex") {
        try {
          return new RegExp(r.pattern, "i").test(url);
        } catch {
          return false;
        }
      }
      const targetHeader = (r.headerName ?? "").toLowerCase();
      return headers.some(
        (h) =>
          (!targetHeader || h.name.toLowerCase() === targetHeader) &&
          h.value.toLowerCase().includes(r.pattern.toLowerCase())
      );
    });
  }

  private startTicker() {
    if (this.timer !== null || typeof window === "undefined") return;
    this.timer = window.setInterval(() => {
      if (!this.running || this.listeners.size === 0) return;
      // Avoid flooding paused breakpoint queue during background simulation
      if (this.pausedBreakpoints.size >= 3) return;
      void this.simulateLiveSessionFlow();
    }, 1800);
  }

  private emitBatch(batch: SessionSummary[]) {
    for (const cb of this.listeners) {
      cb(batch);
    }
    this.emitStorageStatsChanged();
  }

  private emitRemoved(ids: number[]) {
    if (ids.length === 0) return;
    for (const cb of this.removedListeners) {
      cb(ids);
    }
    this.emitStorageStatsChanged();
  }

  private emitStatusChanged() {
    if (this.statusListeners.size === 0) return;
    const snapshot = this.getStatus();
    for (const cb of this.statusListeners) {
      cb(snapshot);
    }
  }

  private emitStorageStatsChanged() {
    if (this.storageStatsListeners.size === 0) return;
    const stats = this.getMemoryStorageStats();
    for (const cb of this.storageStatsListeners) {
      cb(stats);
    }
  }

  subscribe(cb: (batch: SessionSummary[]) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  subscribeRemoved(cb: (ids: number[]) => void): () => void {
    this.removedListeners.add(cb);
    return () => {
      this.removedListeners.delete(cb);
    };
  }

  subscribeBreakpoints(cb: (items: PausedBreakpointItem[]) => void): () => void {
    this.bpListeners.add(cb);
    return () => {
      this.bpListeners.delete(cb);
    };
  }

  subscribeStatus(cb: (status: ProxyStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  subscribeStorageStats(cb: (stats: StorageStats) => void): () => void {
    this.storageStatsListeners.add(cb);
    return () => {
      this.storageStatsListeners.delete(cb);
    };
  }

  getBreakpointConfig(): BreakpointConfig {
    return structuredClone(this.breakpointConfig);
  }

  updateBreakpointConfig(config: BreakpointConfig): BreakpointConfig {
    this.breakpointConfig = structuredClone(config);
    return structuredClone(this.breakpointConfig);
  }

  listPausedBreakpoints(): PausedBreakpointItem[] {
    return Array.from(this.pausedBreakpoints.values())
      .map((e) => e.item)
      .sort((a, b) => a.sessionId - b.sessionId);
  }

  resolveBreakpoint(resolution: BreakpointResolution): boolean {
    const entry = this.pausedBreakpoints.get(resolution.breakpointId);
    if (!entry) return false;
    this.pausedBreakpoints.delete(resolution.breakpointId);
    if (entry.timerId) window.clearTimeout(entry.timerId);
    this.emitBreakpointsSnapshot();
    entry.resolve(resolution);
    return true;
  }

  resumeAllBreakpoints(action: BreakpointAction = "continue"): number {
    const entries = Array.from(this.pausedBreakpoints.entries());
    this.pausedBreakpoints.clear();
    this.emitBreakpointsSnapshot();
    for (const [breakpointId, entry] of entries) {
      if (entry.timerId) window.clearTimeout(entry.timerId);
      entry.resolve({ breakpointId, action });
    }
    return entries.length;
  }

  private getBoundIps(): string[] {
    if (this.bindMode === "all") {
      return ["0.0.0.0"];
    }
    if (this.bindMode === "specific" && this.specificBindIp) {
      if (this.alsoBindLoopback && this.specificBindIp !== "127.0.0.1") {
        return [this.specificBindIp, "127.0.0.1"];
      }
      return [this.specificBindIp];
    }
    return ["127.0.0.1"];
  }

  private syncDerivedBindState(): void {
    if (this.bindMode === "all") {
      this.bindAddr = "0.0.0.0";
      this.allowRemote = true;
    } else if (this.bindMode === "specific" && this.specificBindIp) {
      this.bindAddr = this.specificBindIp;
      this.allowRemote = this.specificBindIp !== "127.0.0.1";
    } else {
      this.bindMode = "loopback";
      this.bindAddr = "127.0.0.1";
      this.allowRemote = false;
    }
  }

  private persistBindConfig(): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "fluxproxy.bindMode.v1",
        JSON.stringify(this.bindMode)
      );
      window.localStorage.setItem(
        "fluxproxy.specificBindIp.v1",
        JSON.stringify(this.specificBindIp)
      );
      window.localStorage.setItem(
        "fluxproxy.alsoBindLoopback.v1",
        JSON.stringify(this.alsoBindLoopback)
      );
      window.localStorage.setItem(
        "fluxproxy.allowRemote.v1",
        JSON.stringify(this.allowRemote)
      );
    } catch {
      // ignore storage errors
    }
  }

  getStatus(): ProxyStatus {
    return {
      running: this.running,
      bindAddr: this.bindAddr,
      port: this.port,
      activeSessions: this.store.size,
      systemProxyEnabled: this.systemProxyEnabled,
      autoSystemProxy: this.autoSystemProxy,
      systemProxyError: this.systemProxyError,
      allowRemote: this.allowRemote,
      bindMode: this.bindMode,
      specificBindIp: this.specificBindIp,
      alsoBindLoopback: this.alsoBindLoopback,
      boundIps: this.getBoundIps(),
    };
  }

  setRunning(running: boolean, host?: string, port?: number): ProxyStatus {
    this.running = running;
    if (host) {
      const trimmed = host.trim();
      if (trimmed === "0.0.0.0" || trimmed === "::") {
        this.bindMode = "all";
      } else if (trimmed === "127.0.0.1" || trimmed === "::1") {
        this.bindMode = "loopback";
      } else if (trimmed.length > 0) {
        this.bindMode = "specific";
        this.specificBindIp = trimmed;
      }
      this.persistBindConfig();
    }
    this.syncDerivedBindState();
    if (port) this.port = port;
    if (running) {
      if (this.autoSystemProxy) {
        this.systemProxyEnabled = true;
        this.systemProxyError = null;
      }
    } else {
      this.systemProxyEnabled = false;
      this.systemProxyError = null;
      this.resumeAllBreakpoints("continue");
    }
    this.emitStatusChanged();
    return this.getStatus();
  }

  setBindConfiguration(
    bindMode: BindHostMode,
    specificBindIp?: string | null,
    alsoBindLoopback = true
  ): ProxyStatus {
    const cleanIp =
      specificBindIp && specificBindIp.trim().length > 0
        ? specificBindIp.trim()
        : null;
    if (bindMode === "specific" && !cleanIp) {
      throw new Error(
        "Specific interface mode requires selecting a network interface IP."
      );
    }
    this.bindMode = bindMode;
    this.specificBindIp = cleanIp ?? this.specificBindIp;
    this.alsoBindLoopback = Boolean(alsoBindLoopback);
    this.syncDerivedBindState();
    this.persistBindConfig();
    this.emitStatusChanged();
    return this.getStatus();
  }

  setAllowRemote(allow: boolean): ProxyStatus {
    return this.setBindConfiguration(
      allow ? "all" : "loopback",
      this.specificBindIp,
      this.alsoBindLoopback
    );
  }

  setSystemProxy(enabled: boolean): ProxyStatus {
    this.systemProxyEnabled = enabled;
    this.systemProxyError = null;
    this.emitStatusChanged();
    return this.getStatus();
  }

  setAutoSystemProxy(auto: boolean): ProxyStatus {
    this.autoSystemProxy = auto;
    if (auto && this.running && !this.systemProxyEnabled) {
      this.systemProxyEnabled = true;
      this.systemProxyError = null;
    }
    this.emitStatusChanged();
    return this.getStatus();
  }

  setPort(port: number): ProxyStatus {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Порт прокси должен быть целым числом от 1 до 65535");
    }
    this.port = port;
    this.emitStatusChanged();
    return this.getStatus();
  }

  getSummaries(): SessionSummary[] {
    return Array.from(this.store.values()).map((d) => d.summary);
  }

  getDetail(id: number): SessionDetail | null {
    return this.store.get(id) ?? null;
  }

  updateAnnotations(
    ids: number[],
    comment: string | null,
    markedColor: string | null
  ): SessionSummary[] {
    const cleanComment = comment?.trim() ? comment.trim() : null;
    const cleanColor = markedColor?.trim() ? markedColor.trim() : null;
    const updated: SessionSummary[] = [];

    for (const id of ids) {
      const existing = this.store.get(id);
      if (!existing) continue;
      const next: SessionDetail = {
        ...existing,
        summary: {
          ...existing.summary,
          comment: cleanComment,
          markedColor: cleanColor,
        },
      };
      this.store.set(id, next);
      updated.push(next.summary);
    }

    if (updated.length > 0) {
      this.emitBatch(updated);
      this.syncArchivedPreviewAnnotations(updated);
    }
    return updated;
  }

  private syncArchivedPreviewAnnotations(updated: SessionSummary[]) {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(
        "fluxproxy.sqliteArchivePreview.v1"
      );
      if (!raw) return;
      const archived = JSON.parse(raw) as SessionDetail[];
      if (!Array.isArray(archived)) return;
      const byId = new Map(updated.map((s) => [s.id, s]));
      let changed = false;
      for (const item of archived) {
        const match = byId.get(item.summary.id);
        if (match) {
          item.summary.comment = match.comment ?? null;
          item.summary.markedColor = match.markedColor ?? null;
          changed = true;
        }
      }
      if (changed) {
        window.localStorage.setItem(
          "fluxproxy.sqliteArchivePreview.v1",
          JSON.stringify(archived)
        );
      }
    } catch {
      // ignore storage quota errors in preview
    }
  }

  saveArchiveToPreviewStorage(): number {
    const allDetails = Array.from(this.store.values()).sort(
      (a, b) => a.summary.id - b.summary.id
    );
    if (typeof window !== "undefined") {
      try {
        // Persist annotated sessions + up to 250 most recent sessions to stay within localStorage limits
        const annotated = allDetails.filter(
          (d) => d.summary.comment || d.summary.markedColor
        );
        const tail = allDetails.slice(-250);
        const mergedMap = new Map<number, SessionDetail>();
        for (const d of [...annotated, ...tail]) {
          mergedMap.set(d.summary.id, d);
        }
        const payload = Array.from(mergedMap.values()).sort(
          (a, b) => a.summary.id - b.summary.id
        );
        window.localStorage.setItem(
          "fluxproxy.sqliteArchivePreview.v1",
          JSON.stringify(payload)
        );
        window.localStorage.setItem(
          "fluxproxy-sqlite-preview-count",
          String(allDetails.length)
        );
      } catch {
        // ignore storage quota errors
      }
    }
    return allDetails.length;
  }

  loadArchiveFromPreviewStorage(): SessionSummary[] {
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(
          "fluxproxy.sqliteArchivePreview.v1"
        );
        if (raw) {
          const parsed = JSON.parse(raw) as SessionDetail[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            for (const detail of parsed) {
              this.insertIntoStoreWithRingBuffer(detail);
              if (detail.summary.id >= this.nextId) {
                this.nextId = detail.summary.id + 1;
              }
            }
          }
        }
      } catch {
        // ignore storage errors
      }
    }
    this.emitStorageStatsChanged();
    return this.getSummaries();
  }

  clear() {
    this.store.clear();
    this.offloadedBodies.clear();
    this.droppedSessionsCount = 0;
    this.emitStorageStatsChanged();
  }

  deleteMany(ids: number[]): number {
    let removed = 0;
    for (const id of ids) {
      if (this.store.delete(id)) {
        this.offloadedBodies.delete(`${id}:req`);
        this.offloadedBodies.delete(`${id}:resp`);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.emitStorageStatsChanged();
    }
    return removed;
  }

  setSessionRetentionLimit(limit: number | null) {
    if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error("Session retention limit must be greater than 0");
    }
    this.sessionRetentionLimit = limit;
    this.enforceRetentionLimit();
    this.emitStorageStatsChanged();
  }

  setDropNonMatching(enabled: boolean) {
    this.filterConfig = {
      ...this.filterConfig,
      dropNonMatchingOnCapture: enabled,
    };
    this.emitStorageStatsChanged();
  }

  getMemoryStorageStats(): StorageStats {
    let persistedBytes = this.evictedSqliteBytes;
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(
          PREVIEW_SQLITE_ARCHIVE_STORAGE_KEY
        );
        if (raw) persistedBytes += raw.length;
      } catch {
        // ignore
      }
    }
    for (const item of this.offloadedBodies.values()) {
      persistedBytes += item.bodySize;
    }
    return {
      ramSessions: this.store.size,
      sqliteSizeBytes: persistedBytes,
      droppedSessionsCount: this.droppedSessionsCount,
      sessionRetentionLimit: this.sessionRetentionLimit,
      dropNonMatching: Boolean(this.filterConfig.dropNonMatchingOnCapture),
    };
  }

  clearSqliteDatabase(): StorageStats {
    this.evictedSqliteBytes = 0;
    this.offloadedBodies.clear();
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(PREVIEW_SQLITE_ARCHIVE_STORAGE_KEY);
        window.localStorage.removeItem(PREVIEW_SQLITE_COUNT_STORAGE_KEY);
      } catch {
        // ignore storage errors
      }
    }
    const stats = this.getMemoryStorageStats();
    this.emitStorageStatsChanged();
    return stats;
  }

  getClearDbOnExit(): boolean {
    return this.clearDbOnExit;
  }

  setClearDbOnExit(enabled: boolean): boolean {
    this.clearDbOnExit = Boolean(enabled);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          PREVIEW_CLEAR_DB_ON_EXIT_STORAGE_KEY,
          JSON.stringify(this.clearDbOnExit)
        );
      } catch {
        // ignore storage errors
      }
    }
    return this.clearDbOnExit;
  }

  loadSessionBody(id: number, isResponse: boolean): LoadedSessionBody {
    const key = `${id}:${isResponse ? "resp" : "req"}`;
    const offloaded = this.offloadedBodies.get(key);
    if (offloaded) {
      return {
        id,
        isResponse,
        bodyBase64: offloaded.bodyBase64,
        bodyText: offloaded.bodyText,
        bodySize: offloaded.bodySize,
      };
    }
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Session #${id} body not found`);
    }
    const bodyBase64 = isResponse
      ? existing.responseBodyBase64
      : existing.requestBodyBase64;
    const bodyText = isResponse
      ? existing.responseBodyText ?? null
      : existing.requestBodyText ?? null;
    return {
      id,
      isResponse,
      bodyBase64,
      bodyText,
      bodySize: isResponse
        ? existing.summary.bodySize
        : existing.requestBodyText?.length ?? 0,
    };
  }

  generateBulkStressSessions(count: number): SessionSummary[] {
    const batch: SessionSummary[] = [];
    for (let i = 0; i < count; i++) {
      const detail = this.applyPipelineToDetail(
        buildSimulatedSession(this.nextId++)
      );
      if (
        !evaluateShouldStoreSessionInPreview(detail.summary, this.filterConfig)
      ) {
        this.droppedSessionsCount += 1;
        continue;
      }
      const stored = this.insertIntoStoreWithRingBuffer(detail);
      batch.push(stored.summary);
    }
    const cappedBatch =
      this.sessionRetentionLimit && batch.length > this.sessionRetentionLimit
        ? batch.slice(batch.length - this.sessionRetentionLimit)
        : batch;
    if (cappedBatch.length > 0) {
      this.emitBatch(cappedBatch);
    }
    return cappedBatch;
  }

  private persistAutoResponderStorage() {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "fluxproxy.autoResponder.v1",
        JSON.stringify({
          enabled: this.autoResponderEnabled,
          rules: this.rules,
        })
      );
    } catch {
      // ignore storage quota errors
    }
  }

  isAutoResponderEnabled(): boolean {
    return this.autoResponderEnabled;
  }

  setAutoResponderEnabled(enabled: boolean): boolean {
    this.autoResponderEnabled = enabled;
    this.persistAutoResponderStorage();
    return this.autoResponderEnabled;
  }

  setAutoResponderConfig(
    enabled: boolean,
    rules: AutoResponderRule[]
  ): AutoResponderRule[] {
    this.autoResponderEnabled = enabled;
    this.rules = structuredClone(rules);
    this.persistAutoResponderStorage();
    return [...this.rules];
  }

  listRules(): AutoResponderRule[] {
    return [...this.rules];
  }

  upsertRule(rule: AutoResponderRule): AutoResponderRule[] {
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) {
      this.rules[idx] = rule;
    } else {
      this.rules.push(rule);
    }
    this.persistAutoResponderStorage();
    return [...this.rules];
  }

  deleteRule(id: string): AutoResponderRule[] {
    this.rules = this.rules.filter((r) => r.id !== id);
    this.persistAutoResponderStorage();
    return [...this.rules];
  }

  getFilterBackendConfig(): ProxyFilterBackendConfig {
    return structuredClone(this.filterConfig);
  }

  updateFilterBackendConfig(
    config: ProxyFilterBackendConfig
  ): ProxyFilterBackendConfig {
    this.filterConfig = structuredClone(config);
    return structuredClone(this.filterConfig);
  }

  getTlsRuleHitCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, count] of this.tlsRuleHitCounts.entries()) {
      out[id] = count;
    }
    return out;
  }

  resetTlsBypassRulesToRecommended(): ProxyFilterBackendConfig {
    this.filterConfig = {
      ...this.filterConfig,
      tlsBypassEnabled: true,
      tlsBypassRules: structuredClone(DEFAULT_TLS_BYPASS_RULES),
    };
    return structuredClone(this.filterConfig);
  }

  async executeComposed(req: ComposedRequest): Promise<SessionDetail> {
    if (
      req.timeoutSec !== undefined &&
      (!Number.isInteger(req.timeoutSec) ||
        (req.timeoutSec !== 0 &&
          (req.timeoutSec < UPSTREAM_TIMEOUT_LIMITS.composerMin ||
            req.timeoutSec > UPSTREAM_TIMEOUT_LIMITS.composerMax)))
    ) {
      throw new Error(
        `composerTimeoutSec must be 0 (Unlimited) or between ${UPSTREAM_TIMEOUT_LIMITS.composerMin} and ${UPSTREAM_TIMEOUT_LIMITS.composerMax} seconds`
      );
    }
    const cleanRequestId =
      typeof req.requestId === "string" && req.requestId.trim().length > 0
        ? req.requestId.trim()
        : null;
    const composerController = new AbortController();
    if (cleanRequestId) {
      this.activeComposerControllers.set(cleanRequestId, composerController);
    }
    const effectiveTimeoutSec =
      req.timeoutSec ?? this.upstreamTimeouts.composerTimeoutSec;
    const timeoutTimer =
      effectiveTimeoutSec > 0
        ? window.setTimeout(
            () => composerController.abort("composer-timeout"),
            effectiveTimeoutSec * 1000
          )
        : null;

    try {
      return await this.executeComposedInner(req, composerController.signal);
    } finally {
      if (timeoutTimer !== null) {
        window.clearTimeout(timeoutTimer);
      }
      if (
        cleanRequestId &&
        this.activeComposerControllers.get(cleanRequestId) === composerController
      ) {
        this.activeComposerControllers.delete(cleanRequestId);
      }
    }
  }

  private async executeComposedInner(
    req: ComposedRequest,
    abortSignal: AbortSignal
  ): Promise<SessionDetail> {
    const start = performance.now();
    const id = this.nextId++;
    let effectiveMethod = req.method;
    let effectiveUrl = req.url;
    const initialBodyBytes =
      req.bodyBase64 && req.bodyBase64.trim().length > 0
        ? decodeBase64ToBytes(req.bodyBase64)
        : req.body
          ? new TextEncoder().encode(req.body)
          : new Uint8Array(0);
    let effectiveBodyBytes: Uint8Array | null =
      initialBodyBytes.length > 0 ? initialBodyBytes : null;
    let effectiveBodyBase64 =
      initialBodyBytes.length > 0
        ? encodeUint8ArrayToBase64(initialBodyBytes)
        : "";
    let effectiveBody =
      req.body ||
      (initialBodyBytes.length > 0
        ? new TextDecoder().decode(initialBodyBytes)
        : "");
    let bpModified = false;

    const reqMut = applyHeaderMutationsInPreview(
      "request",
      effectiveUrl,
      req.headers,
      this.filterConfig
    );
    let effectiveReqHeaders = reqMut.headers;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(effectiveUrl);
    } catch {
      parsedUrl = new URL("https://example.com/");
    }

    // Live Breakpoint: Before Request
    if (this.shouldBreak("request", effectiveMethod, effectiveUrl)) {
      const verdict = await this.parkOnBreakpoint({
        sessionId: id,
        stage: "request",
        scheme: parsedUrl.protocol.replace(":", ""),
        method: effectiveMethod,
        url: effectiveUrl,
        host: parsedUrl.host,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        requestHeaders: effectiveReqHeaders,
        requestBodyBase64: effectiveBodyBase64,
        requestBodyText: effectiveBody || null,
        responseStatus: null,
        responseHeaders: [],
        responseBodyBase64: "",
        responseBodyText: null,
        processName: "flux-proxy (Composer)",
        processPid: 9001,
      });

      if (verdict.action === "abort") {
        const abortedText = '{"error":"Aborted at Live Breakpoint (Before Request)"}';
        const aborted: SessionDetail = {
          summary: {
            id,
            status: 502,
            protocol: parsedUrl.protocol === "https:" ? "HTTPS/2" : "HTTP/1.1",
            scheme: parsedUrl.protocol.replace(":", ""),
            method: effectiveMethod,
            host: parsedUrl.host,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            url: effectiveUrl,
            contentType: "application/json",
            bodySize: abortedText.length,
            durationMs: Math.round(performance.now() - start),
            timestamp: new Date().toISOString(),
            isMocked: false,
            error: "Aborted at Breakpoint (Before Request)",
            processName: "flux-proxy (Composer)",
            processPid: 9001,
            breakpointPaused: null,
            breakpointModified: true,
          },
          requestHeaders: effectiveReqHeaders,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }],
          requestBodyBase64: effectiveBodyBase64,
          responseBodyBase64: encodeTextToBase64(abortedText),
          requestBodyText: effectiveBody || null,
          responseBodyText: abortedText,
          tlsVersion: null,
          clientAddr: "Composer (Local)",
          websocketFrames: [],
        };
        this.store.set(id, aborted);
        this.emitBatch([aborted.summary]);
        return aborted;
      }

      if (verdict.method) {
        effectiveMethod = verdict.method.toUpperCase();
        bpModified = true;
      }
      if (verdict.url && verdict.url !== effectiveUrl) {
        effectiveUrl = verdict.url;
        try {
          parsedUrl = new URL(effectiveUrl);
        } catch {
          // keep previous parsedUrl
        }
        bpModified = true;
      }
      if (verdict.requestHeaders) {
        effectiveReqHeaders = verdict.requestHeaders;
        bpModified = true;
      }
      if (typeof verdict.requestBodyText === "string") {
        effectiveBody = verdict.requestBodyText;
        effectiveBodyBytes = effectiveBody
          ? new TextEncoder().encode(effectiveBody)
          : null;
        effectiveBodyBase64 = effectiveBody
          ? encodeTextToBase64(effectiveBody)
          : "";
        bpModified = true;
      } else if (typeof verdict.requestBodyBase64 === "string") {
        effectiveBodyBase64 = verdict.requestBodyBase64;
        effectiveBodyBytes = effectiveBodyBase64
          ? decodeBase64ToBytes(effectiveBodyBase64)
          : null;
        effectiveBody = effectiveBodyBytes
          ? new TextDecoder().decode(effectiveBodyBytes)
          : "";
        bpModified = true;
      }
    }

    const matched = this.findMatchingRule(
      effectiveMethod,
      effectiveUrl,
      effectiveReqHeaders
    );
    if (matched && matched.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, matched.latencyMs));
    }

    let finalDetail: SessionDetail;

    if (matched && matched.action === "mockResponse") {
      const respMut = applyHeaderMutationsInPreview(
        "response",
        effectiveUrl,
        matched.responseHeaders,
        this.filterConfig
      );
      const respBytes = new TextEncoder().encode(matched.responseBody);
      finalDetail = {
        summary: {
          id,
          status: matched.statusCode,
          protocol: parsedUrl.protocol === "https:" ? "HTTPS/2" : "HTTP/1.1",
          scheme: parsedUrl.protocol.replace(":", ""),
          method: effectiveMethod,
          host: parsedUrl.host,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          url: effectiveUrl,
          contentType:
            respMut.headers.find(
              (h) => h.name.toLowerCase() === "content-type"
            )?.value ?? "application/json; charset=utf-8",
          bodySize: respBytes.length,
          durationMs: Math.round(performance.now() - start),
          timestamp: new Date().toISOString(),
          isMocked: true,
          matchedRuleId: matched.id,
          error: null,
          processName: "flux-proxy (Composer)",
          processPid: 9001,
          tlsBypassed: false,
          headersMutated: reqMut.mutated || respMut.mutated,
          breakpointPaused: null,
          breakpointModified: bpModified,
        },
        requestHeaders: effectiveReqHeaders,
        responseHeaders: respMut.headers,
        requestBodyBase64: effectiveBodyBase64,
        responseBodyBase64: encodeTextToBase64(matched.responseBody),
        requestBodyText: effectiveBody || null,
        responseBodyText: matched.responseBody,
        tlsVersion: "AutoResponder Mock (Preview)",
        clientAddr: "Composer (Local)",
        websocketFrames: [],
      };
    } else {
      const composerRemap = matchHostRemapPreview(
        this.hostRemapRules,
        parsedUrl.hostname
      );
      const composerRemappedTo = composerRemap
        ? formatRemapTargetPreview(composerRemap)
        : null;
      if (this.throttleConfig.preset === "offline") {
        const offMsg = "Network Offline (Bandwidth Throttling: Offline)";
        const offlineDetail: SessionDetail = {
          summary: {
            id,
            status: 503,
            protocol: parsedUrl.protocol === "https:" ? "HTTPS/2" : "HTTP/1.1",
            scheme: parsedUrl.protocol.replace(":", ""),
            method: effectiveMethod,
            host: parsedUrl.host,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            url: effectiveUrl,
            contentType: "text/plain; charset=utf-8",
            bodySize: offMsg.length,
            durationMs: Math.round(performance.now() - start),
            timestamp: new Date().toISOString(),
            isMocked: false,
            matchedRuleId: null,
            error: offMsg,
            processName: "flux-proxy (Composer)",
            processPid: 9001,
            tlsBypassed: false,
            headersMutated: reqMut.mutated,
            breakpointPaused: null,
            breakpointModified: bpModified,
            remappedTo: composerRemappedTo,
          },
          requestHeaders: effectiveReqHeaders,
          responseHeaders: [
            { name: "Content-Type", value: "text/plain; charset=utf-8" },
          ],
          requestBodyBase64: effectiveBodyBase64,
          responseBodyBase64: encodeTextToBase64(offMsg),
          requestBodyText: effectiveBody || null,
          responseBodyText: offMsg,
          tlsVersion: null,
          clientAddr: "Composer (Local)",
          websocketFrames: [],
        };
        return this.commitCompletedSession(offlineDetail) ?? offlineDetail;
      }

      if (this.throttleConfig.latencyMs > 0) {
        await new Promise((r) =>
          window.setTimeout(r, Math.min(this.throttleConfig.latencyMs, 600))
        );
      }

      this.commitInFlightSession({
        summary: {
          id,
          status: 0,
          protocol: parsedUrl.protocol === "https:" ? "HTTPS/2" : "HTTP/1.1",
          scheme: parsedUrl.protocol.replace(":", ""),
          method: effectiveMethod,
          host: parsedUrl.host,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          url: effectiveUrl,
          contentType: "",
          bodySize: 0,
          durationMs: 0,
          timestamp: new Date().toISOString(),
          isMocked: false,
          matchedRuleId: null,
          error: null,
          processName: "flux-proxy (Composer)",
          processPid: 9001,
          tlsBypassed: false,
          headersMutated: reqMut.mutated,
          breakpointPaused: null,
          breakpointModified: bpModified,
          remappedTo: composerRemappedTo,
        },
        requestHeaders: effectiveReqHeaders,
        responseHeaders: [],
        requestBodyBase64: effectiveBodyBase64,
        responseBodyBase64: "",
        requestBodyText: effectiveBody || null,
        responseBodyText: null,
        tlsVersion: parsedUrl.protocol === "https:" ? "TLS 1.3 (Pending)" : "Plaintext",
        clientAddr: "Composer (Local)",
        websocketFrames: [],
      });
      await new Promise<void>((resolve, reject) => {
        if (abortSignal.aborted) {
          reject(new Error(String(abortSignal.reason ?? "composer-cancelled")));
          return;
        }
        const onAbort = () => {
          window.clearTimeout(t);
          reject(new Error(String(abortSignal.reason ?? "composer-cancelled")));
        };
        const t = window.setTimeout(() => {
          abortSignal.removeEventListener("abort", onAbort);
          resolve();
        }, 260);
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }).catch((abortErr) => {
        const isTimeout = abortSignal.reason === "composer-timeout";
        const errMsg = isTimeout
          ? `Upstream response headers (TTFB) timed out after ${req.timeoutSec ?? this.upstreamTimeouts.composerTimeoutSec} s`
          : "Composer request cancelled by user";
        const cancelledDetail: SessionDetail = {
          summary: {
            id,
            status: isTimeout ? 504 : 499,
            protocol: parsedUrl.protocol === "https:" ? "HTTPS/2" : "HTTP/1.1",
            scheme: parsedUrl.protocol.replace(":", ""),
            method: effectiveMethod,
            host: parsedUrl.host,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            url: effectiveUrl,
            contentType: "text/plain; charset=utf-8",
            bodySize: errMsg.length,
            durationMs: Math.round(performance.now() - start),
            timestamp: new Date().toISOString(),
            isMocked: false,
            matchedRuleId: null,
            error: errMsg,
            processName: "flux-proxy (Composer)",
            processPid: 9001,
            tlsBypassed: false,
            headersMutated: reqMut.mutated,
            breakpointPaused: null,
            breakpointModified: bpModified,
          },
          requestHeaders: effectiveReqHeaders,
          responseHeaders: [
            { name: "Content-Type", value: "text/plain; charset=utf-8" },
            {
              name: "X-FluxProxy-Error",
              value: isTimeout
                ? "upstream-response-timeout"
                : "composer-cancelled",
            },
          ],
          requestBodyBase64: effectiveBodyBase64,
          responseBodyBase64: encodeTextToBase64(errMsg),
          requestBodyText: effectiveBody || null,
          responseBodyText: errMsg,
          tlsVersion: null,
          clientAddr: "Composer (Local)",
          websocketFrames: [],
        };
        this.commitCompletedSession(cancelledDetail);
        throw abortErr instanceof Error ? abortErr : new Error(errMsg);
      });
      // Attempt browser CORS fetch; gracefully fall back to synthetic echoed response if CORS blocks
      try {
        const headersInit: Record<string, string> = {};
        for (const h of effectiveReqHeaders) {
          if (h.name.trim()) headersInit[h.name] = h.value;
        }
        const resp = await fetch(effectiveUrl, {
          method: effectiveMethod,
          headers: headersInit,
          signal: abortSignal,
          body:
            effectiveMethod !== "GET" &&
            effectiveMethod !== "HEAD" &&
            effectiveBodyBytes &&
            effectiveBodyBytes.length > 0
              ? new Uint8Array(effectiveBodyBytes)
              : undefined,
        });
        const text = await resp.text();
        const rawRespHeaders: { name: string; value: string }[] = [];
        resp.headers.forEach((value, name) =>
          rawRespHeaders.push({ name, value })
        );
        const respMut = applyHeaderMutationsInPreview(
          "response",
          effectiveUrl,
          rawRespHeaders,
          this.filterConfig
        );
        const ct =
          respMut.headers.find((h) => h.name.toLowerCase() === "content-type")
            ?.value ??
          resp.headers.get("content-type") ??
          "text/plain";
        const status =
          matched?.action === "overrideStatus" ? matched.statusCode : resp.status;

        finalDetail = {
          summary: {
            id,
            status,
            protocol: parsedUrl.protocol === "https:" ? "HTTPS/2" : "HTTP/1.1",
            scheme: parsedUrl.protocol.replace(":", ""),
            method: effectiveMethod,
            host: parsedUrl.host,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            url: effectiveUrl,
            contentType: ct,
            bodySize: new TextEncoder().encode(text).length,
            durationMs: Math.round(performance.now() - start),
            timestamp: new Date().toISOString(),
            isMocked: matched?.action === "overrideStatus",
            matchedRuleId: matched?.id ?? null,
            error: null,
            processName: "flux-proxy (Composer)",
            processPid: 9001,
            tlsBypassed: false,
            headersMutated: reqMut.mutated || respMut.mutated,
            breakpointPaused: null,
            breakpointModified: bpModified,
          },
          requestHeaders: effectiveReqHeaders,
          responseHeaders: respMut.headers,
          requestBodyBase64: effectiveBodyBase64,
          responseBodyBase64: encodeTextToBase64(text),
          requestBodyText: effectiveBody || null,
          responseBodyText: text,
          tlsVersion: parsedUrl.protocol === "https:" ? "TLS 1.3" : null,
          clientAddr: "Composer (Browser Fetch)",
          websocketFrames: [],
        };
      } catch (fetchErr) {
        if (abortSignal.aborted) {
          const isTimeout = abortSignal.reason === "composer-timeout";
          const errMsg = isTimeout
            ? "Upstream response headers (TTFB) timed out"
            : "Composer request cancelled by user";
          const errDetail: SessionDetail = {
            summary: {
              id,
              status: isTimeout ? 504 : 499,
              protocol: parsedUrl.protocol === "https:" ? "HTTPS/2" : "HTTP/1.1",
              scheme: parsedUrl.protocol.replace(":", ""),
              method: effectiveMethod,
              host: parsedUrl.host,
              path: `${parsedUrl.pathname}${parsedUrl.search}`,
              url: effectiveUrl,
              contentType: "text/plain; charset=utf-8",
              bodySize: errMsg.length,
              durationMs: Math.round(performance.now() - start),
              timestamp: new Date().toISOString(),
              isMocked: false,
              matchedRuleId: null,
              error: errMsg,
              processName: "flux-proxy (Composer)",
              processPid: 9001,
              tlsBypassed: false,
              headersMutated: reqMut.mutated,
              breakpointPaused: null,
              breakpointModified: bpModified,
            },
            requestHeaders: effectiveReqHeaders,
            responseHeaders: [
              { name: "Content-Type", value: "text/plain; charset=utf-8" },
              {
                name: "X-FluxProxy-Error",
                value: isTimeout
                  ? "upstream-response-timeout"
                  : "composer-cancelled",
              },
            ],
            requestBodyBase64: effectiveBodyBase64,
            responseBodyBase64: encodeTextToBase64(errMsg),
            requestBodyText: effectiveBody || null,
            responseBodyText: errMsg,
            tlsVersion: null,
            clientAddr: "Composer (Local)",
            websocketFrames: [],
          };
          this.commitCompletedSession(errDetail);
          throw fetchErr instanceof Error ? fetchErr : new Error(errMsg);
        }
        const fallbackBody = JSON.stringify(
          {
            ok: true,
            note: "Executed in Browser Preview Mode (run via `cargo tauri dev` for raw CORS-free Rust sockets)",
            echo: {
              method: effectiveMethod,
              url: effectiveUrl,
              headersCount: effectiveReqHeaders.length,
              bodyLength: effectiveBodyBytes ? effectiveBodyBytes.length : 0,
            },
          },
          null,
          2
        );
        const respMut = applyHeaderMutationsInPreview(
          "response",
          effectiveUrl,
          [
            { name: "Content-Type", value: "application/json; charset=utf-8" },
            { name: "X-FluxProxy-Engine", value: "Browser-Preview-Simulator" },
          ],
          this.filterConfig
        );
        finalDetail = {
          summary: {
            id,
            status:
              matched?.action === "overrideStatus" ? matched.statusCode : 200,
            protocol: parsedUrl.protocol === "https:" ? "HTTPS/2" : "HTTP/1.1",
            scheme: parsedUrl.protocol.replace(":", ""),
            method: effectiveMethod,
            host: parsedUrl.host,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            url: effectiveUrl,
            contentType: "application/json; charset=utf-8",
            bodySize: fallbackBody.length,
            durationMs: Math.max(12, Math.round(performance.now() - start)),
            timestamp: new Date().toISOString(),
            isMocked: Boolean(matched),
            matchedRuleId: matched?.id ?? null,
            error: null,
            processName: "flux-proxy (Composer)",
            processPid: 9001,
            tlsBypassed: false,
            headersMutated: reqMut.mutated || respMut.mutated,
            breakpointPaused: null,
            breakpointModified: bpModified,
          },
          requestHeaders: effectiveReqHeaders,
          responseHeaders: respMut.headers,
          requestBodyBase64: effectiveBodyBase64,
          responseBodyBase64: encodeTextToBase64(fallbackBody),
          requestBodyText: effectiveBody || null,
          responseBodyText: fallbackBody,
          tlsVersion: "TLS 1.3 (Simulated)",
          clientAddr: "Composer (Local)",
          websocketFrames: [],
        };
      }
    }

    const composerRemapFinal = matchHostRemapPreview(
      this.hostRemapRules,
      parsedUrl.hostname
    );
    if (composerRemapFinal && !finalDetail.summary.remappedTo) {
      finalDetail.summary.remappedTo =
        formatRemapTargetPreview(composerRemapFinal);
    }

    // Live Breakpoint: After Response
    if (this.shouldBreak("response", effectiveMethod, effectiveUrl)) {
      const verdict = await this.parkOnBreakpoint({
        sessionId: id,
        stage: "response",
        scheme: finalDetail.summary.scheme,
        method: finalDetail.summary.method,
        url: finalDetail.summary.url,
        host: finalDetail.summary.host,
        path: finalDetail.summary.path,
        requestHeaders: finalDetail.requestHeaders,
        requestBodyBase64: finalDetail.requestBodyBase64,
        requestBodyText: finalDetail.requestBodyText,
        responseStatus: finalDetail.summary.status,
        responseHeaders: finalDetail.responseHeaders,
        responseBodyBase64: finalDetail.responseBodyBase64,
        responseBodyText: finalDetail.responseBodyText,
        processName: "flux-proxy (Composer)",
        processPid: 9001,
      });

      if (verdict.action === "abort") {
        finalDetail.summary.status = 504;
        finalDetail.summary.error = "Aborted at Breakpoint (After Response)";
        finalDetail.summary.breakpointModified = true;
      } else {
        if (typeof verdict.statusCode === "number" && verdict.statusCode >= 100) {
          finalDetail.summary.status = verdict.statusCode;
          bpModified = true;
        }
        if (verdict.responseHeaders) {
          finalDetail.responseHeaders = verdict.responseHeaders;
          bpModified = true;
        }
        if (typeof verdict.responseBodyText === "string") {
          finalDetail.responseBodyText = verdict.responseBodyText;
          finalDetail.responseBodyBase64 = encodeTextToBase64(
            verdict.responseBodyText
          );
          finalDetail.summary.bodySize = new TextEncoder().encode(
            verdict.responseBodyText
          ).length;
          bpModified = true;
        }
        finalDetail.summary.breakpointModified = bpModified;
      }
    }

    const storedFinal = this.commitCompletedSession(finalDetail);
    return storedFinal ?? finalDetail;
  }

  exportPreviewSessions(
    sessionIds: number[],
    format: string,
    filePath: string,
    sanitization?: SanitizationOptions | null
  ): number {
    const targetIds =
      sessionIds.length > 0
        ? sessionIds
        : Array.from(this.store.keys()).sort((a, b) => a - b);
    const list: SessionDetail[] = [];
    for (const id of targetIds) {
      const detail = this.getDetail(id);
      if (!detail) continue;
      const hydrated = structuredClone(detail);
      if (hydrated.requestBodyOffloaded) {
        const off = this.offloadedBodies.get(`${id}:req`);
        if (off) {
          hydrated.requestBodyBase64 = off.bodyBase64;
          hydrated.requestBodyText = off.bodyText;
          hydrated.requestBodyOffloaded = false;
        }
      }
      if (hydrated.bodyOffloaded) {
        const off = this.offloadedBodies.get(`${id}:resp`);
        if (off) {
          hydrated.responseBodyBase64 = off.bodyBase64;
          hydrated.responseBodyText = off.bodyText;
          hydrated.bodyOffloaded = false;
        }
      }
      list.push(hydrated);
    }

    const effectiveList = sanitization
      ? sanitizeSessionsInPreview(list, sanitization)
      : list;

    const fmt = format.replace(/^\./, "").toLowerCase();
    if (fmt === "raw" || fmt === "txt") {
      const text = effectiveList
        .map((d) => buildFullRawHttpMessage(d))
        .join(
          "\r\n------------------------------------------------------------------\r\n\r\n"
        );
      triggerBrowserDownload(
        new TextEncoder().encode(text),
        filePath,
        "text/plain;charset=utf-8"
      );
      return effectiveList.length;
    }

    if (fmt === "json") {
      const json = JSON.stringify(effectiveList, null, 2);
      triggerBrowserDownload(
        new TextEncoder().encode(json),
        filePath,
        "application/json"
      );
      return effectiveList.length;
    }

    // Default HAR 1.2 serialization in Browser Preview
    const har = {
      log: {
        version: "1.2",
        creator: { name: "FluxProxy", version: "0.6.0" },
        pages: effectiveList.length
          ? [
              {
                startedDateTime: effectiveList[0].summary.timestamp,
                id: "page_1",
                title: "FluxProxy Capture",
                pageTimings: { onContentLoad: -1, onLoad: -1 },
              },
            ]
          : [],
        entries: effectiveList.map((d) => {
          const st = d.transferStats;
          const t = d.timings;
          const reused = Boolean(st?.serverConnReused ?? d.summary.serverConnReused);
          const sslMs =
            reused || t?.tlsHandshakeMs == null ? -1 : Math.max(0, t.tlsHandshakeMs);
          const connectMs = reused
            ? -1
            : t?.tcpConnectMs != null || t?.tlsHandshakeMs != null
              ? Math.max(0, t?.tcpConnectMs ?? 0) + Math.max(0, t?.tlsHandshakeMs ?? 0)
              : -1;
          const dnsMs =
            reused || t?.dnsMs == null ? -1 : Math.max(0, t.dnsMs);
          const blockedParts = [
            t?.clientReadMs,
            t?.breakpointPauseMs,
            t?.scriptHookMs,
            t?.autoresponderDelayMs,
            t?.proxyOverheadMs,
          ].filter((v): v is number => typeof v === "number" && v >= 0);
          const blockedSum = blockedParts.reduce((a, b) => a + b, 0);
          const blockedMs =
            blockedParts.length > 0 && blockedSum > 0 ? blockedSum : -1;

          const reqWireBody =
            st?.requestWireBodyBytes ??
            (d.requestBodyText ? d.requestBodyText.length : 0);
          const respWireBody =
            st?.responseWireBodyBytes ?? d.summary.wireBodySize ?? d.summary.bodySize;
          const contentSize = st?.responseBodyBytes ?? d.summary.bodySize;
          const compression =
            contentSize > respWireBody ? contentSize - respWireBody : undefined;

          return {
            pageref: "page_1",
            startedDateTime: d.summary.timestamp,
            time: t?.overallElapsedMs ?? d.summary.durationMs,
            request: {
              method: d.summary.method,
              url: d.summary.url,
              httpVersion: d.summary.protocol.includes("2")
                ? "HTTP/2.0"
                : "HTTP/1.1",
              cookies: [],
              headers: d.requestHeaders,
              queryString: parseQueryParams(d.summary.url),
              ...(d.requestBodyText
                ? {
                    postData: {
                      mimeType:
                        d.requestHeaders.find(
                          (h) => h.name.toLowerCase() === "content-type"
                        )?.value ?? "application/octet-stream",
                      params: [],
                      text: d.requestBodyText,
                    },
                  }
                : {}),
              headersSize: st?.requestHeadersBytes ?? -1,
              bodySize: reqWireBody,
            },
            response: {
              status: d.summary.status,
              statusText: "OK",
              httpVersion: d.summary.protocol.includes("2")
                ? "HTTP/2.0"
                : "HTTP/1.1",
              cookies: [],
              headers: d.responseHeaders,
              content: {
                size: contentSize,
                ...(compression !== undefined ? { compression } : {}),
                mimeType: d.summary.contentType || "application/octet-stream",
                ...(d.responseBodyText !== null
                  ? { text: d.responseBodyText }
                  : d.responseBodyBase64
                    ? { text: d.responseBodyBase64, encoding: "base64" }
                    : {}),
              },
              redirectURL: "",
              headersSize: st?.responseHeadersBytes ?? -1,
              bodySize: respWireBody,
            },
            cache: {},
            timings: {
              blocked: blockedMs,
              dns: dnsMs,
              connect: connectMs,
              send: t?.sendRequestMs ?? 0,
              wait: t ? (t.serverWaitMs ?? 0) : d.summary.durationMs,
              receive: t?.contentDownloadMs ?? 0,
              ssl: sslMs,
            },
            serverIPAddress: st?.serverIp ?? d.summary.serverIp ?? undefined,
            connection:
              st?.serverConnId != null ? String(st.serverConnId) : undefined,
            comment: d.summary.comment ?? undefined,
            _fluxProxy: {
              protocol: d.summary.protocol,
              scheme: d.summary.scheme,
              markedColor: d.summary.markedColor,
              processName: d.summary.processName,
              processPid: d.summary.processPid,
              clientIp: d.summary.clientIp ?? null,
              clientAddr: d.clientAddr,
              remappedTo: d.summary.remappedTo ?? null,
              timings: d.timings ?? undefined,
              transferStats: d.transferStats ?? undefined,
            },
          };
        }),
      },
    };
    const outName =
      fmt === "saz" ? filePath.replace(/\.saz$/i, ".har") : filePath;
    triggerBrowserDownload(
      new TextEncoder().encode(JSON.stringify(har, null, 2)),
      outName,
      "application/json"
    );
    return effectiveList.length;
  }

  importPreviewText(text: string): SessionSummary[] {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
    const importedSummaries: SessionSummary[] = [];

    if (Array.isArray(parsed)) {
      for (const item of parsed as SessionDetail[]) {
        if (!item || typeof item !== "object" || !item.summary) continue;
        const id = this.nextId++;
        const next: SessionDetail = {
          ...item,
          summary: { ...item.summary, id },
        };
        const stored = this.insertIntoStoreWithRingBuffer(next);
        importedSummaries.push(stored.summary);
      }
    } else if (
      parsed &&
      typeof parsed === "object" &&
      "log" in parsed &&
      parsed.log &&
      typeof parsed.log === "object" &&
      "entries" in parsed.log &&
      Array.isArray((parsed.log as { entries: unknown[] }).entries)
    ) {
      const entries = (parsed.log as { entries: Record<string, unknown>[] })
        .entries;
      for (const entry of entries) {
        const id = this.nextId++;
        const req = (entry.request ?? {}) as Record<string, unknown>;
        const resp = (entry.response ?? {}) as Record<string, unknown>;
        const content = (resp.content ?? {}) as Record<string, unknown>;
        const urlStr = String(req.url ?? "https://localhost/");
        let scheme = "https";
        let host = "localhost";
        let path = "/";
        try {
          const u = new URL(urlStr);
          scheme = u.protocol.replace(":", "") || "https";
          host = u.host;
          path = `${u.pathname}${u.search}`;
        } catch {
          // keep fallback
        }
        const postData = req.postData as Record<string, unknown> | undefined;
        const reqText =
          postData && typeof postData.text === "string" ? postData.text : null;
        const respText =
          typeof content.text === "string" && content.encoding !== "base64"
            ? content.text
            : null;
        const respB64 =
          typeof content.text === "string"
            ? content.encoding === "base64"
              ? content.text
              : encodeTextToBase64(content.text)
            : "";

        const reqHeadersList = Array.isArray(req.headers)
          ? (req.headers as { name: string; value: string }[])
          : [];
        const respHeadersList = Array.isArray(resp.headers)
          ? (resp.headers as { name: string; value: string }[])
          : [];
        const ext = (
          entry._fluxProxy && typeof entry._fluxProxy === "object"
            ? entry._fluxProxy
            : null
        ) as Record<string, unknown> | null;
        const rawHarTimings = (
          entry.timings && typeof entry.timings === "object"
            ? entry.timings
            : null
        ) as Record<string, unknown> | null;

        let importedTimings: SessionTimings | null =
          ext?.timings && typeof ext.timings === "object"
            ? (ext.timings as SessionTimings)
            : null;
        if (!importedTimings && rawHarTimings) {
          const dns = Number(rawHarTimings.dns ?? -1);
          const connect = Number(rawHarTimings.connect ?? -1);
          const ssl = Number(rawHarTimings.ssl ?? -1);
          const send = Number(rawHarTimings.send ?? 0);
          const wait = Number(rawHarTimings.wait ?? 0);
          const receive = Number(rawHarTimings.receive ?? 0);
          const blocked = Number(rawHarTimings.blocked ?? -1);
          const overall = Number(entry.time ?? 0);
          if (
            dns >= 0 ||
            connect >= 0 ||
            ssl >= 0 ||
            blocked >= 0 ||
            send > 0 ||
            wait > 0 ||
            receive > 0 ||
            overall > 0
          ) {
            const tcpMs =
              connect >= 0 ? Math.max(0, connect - Math.max(0, ssl)) : null;
            importedTimings = {
              clientBeginRequest: String(
                entry.startedDateTime ?? new Date().toISOString()
              ),
              dnsMs: dns >= 0 ? dns : null,
              tcpConnectMs: tcpMs,
              tlsHandshakeMs: ssl >= 0 ? ssl : null,
              sendRequestMs: send >= 0 ? send : null,
              serverWaitMs: wait >= 0 ? wait : null,
              contentDownloadMs: receive >= 0 ? receive : null,
              proxyOverheadMs: blocked >= 0 ? blocked : null,
              overallElapsedMs: overall > 0 ? overall : null,
            };
          }
        }

        let importedTransferStats: SessionTransferStats | null =
          ext?.transferStats && typeof ext.transferStats === "object"
            ? (ext.transferStats as SessionTransferStats)
            : null;
        if (!importedTransferStats) {
          const serverIpRaw =
            typeof entry.serverIPAddress === "string"
              ? entry.serverIPAddress.trim()
              : "";
          const connNum =
            typeof entry.connection === "string" &&
            /^\d+$/.test(entry.connection.trim())
              ? Number(entry.connection.trim())
              : null;
          const reqHdrSz = Number(req.headersSize ?? -1);
          const respHdrSz = Number(resp.headersSize ?? -1);
          const reqBodySz = Number(req.bodySize ?? -1);
          const respBodySz = Number(resp.bodySize ?? -1);
          const encodingHdr =
            respHeadersList.find(
              (h) => h.name.toLowerCase() === "content-encoding"
            )?.value ?? null;
          if (
            serverIpRaw ||
            connNum !== null ||
            reqHdrSz >= 0 ||
            respHdrSz >= 0 ||
            respBodySz >= 0 ||
            encodingHdr
          ) {
            const harDns = Number(rawHarTimings?.dns ?? -1);
            const harConn = Number(rawHarTimings?.connect ?? -1);
            const harSsl = Number(rawHarTimings?.ssl ?? -1);
            const serverConnReused =
              harConn < 0 &&
              harDns < 0 &&
              harSsl < 0 &&
              (connNum !== null || Boolean(serverIpRaw))
                ? true
                : harConn >= 0 || harDns >= 0
                  ? false
                  : null;
            importedTransferStats = {
              requestHeadersBytes: reqHdrSz >= 0 ? reqHdrSz : null,
              requestWireBodyBytes: reqBodySz >= 0 ? reqBodySz : null,
              requestBodyBytes: reqText ? new TextEncoder().encode(reqText).length : null,
              responseHeadersBytes: respHdrSz >= 0 ? respHdrSz : null,
              responseWireBodyBytes: respBodySz >= 0 ? respBodySz : null,
              responseBodyBytes: Number(content.size ?? 0),
              responseContentEncoding: encodingHdr,
              serverIp: serverIpRaw || null,
              serverConnId: connNum,
              serverConnReused,
            };
          }
        }

        const reqTotalBytes =
          importedTransferStats?.requestHeadersBytes != null ||
          importedTransferStats?.requestWireBodyBytes != null
            ? (importedTransferStats?.requestHeadersBytes ?? 0) +
              (importedTransferStats?.requestWireBodyBytes ??
                importedTransferStats?.requestBodyBytes ??
                0)
            : null;

        const detail: SessionDetail = {
          summary: {
            id,
            status: Number(resp.status ?? 200),
            protocol:
              typeof ext?.protocol === "string"
                ? ext.protocol
                : String(req.httpVersion ?? "HTTP/1.1").includes("2")
                  ? `${scheme.toUpperCase()}/2`
                  : `${scheme.toUpperCase()}/1.1`,
            scheme: typeof ext?.scheme === "string" ? ext.scheme : scheme,
            method: String(req.method ?? "GET").toUpperCase(),
            host,
            path,
            url: urlStr,
            contentType: String(content.mimeType ?? "application/octet-stream"),
            bodySize: Number(content.size ?? 0),
            durationMs: Math.max(0, Math.round(Number(entry.time ?? 0))),
            timestamp: String(
              entry.startedDateTime ?? new Date().toISOString()
            ),
            isMocked: false,
            matchedRuleId: null,
            error: null,
            processName:
              typeof ext?.processName === "string" ? ext.processName : null,
            processPid:
              typeof ext?.processPid === "number" ? ext.processPid : null,
            comment: typeof entry.comment === "string" ? entry.comment : null,
            markedColor:
              typeof ext?.markedColor === "string" ? ext.markedColor : null,
            clientIp: typeof ext?.clientIp === "string" ? ext.clientIp : null,
            remappedTo:
              typeof ext?.remappedTo === "string" ? ext.remappedTo : null,
            ttfbMs: importedTimings?.serverWaitMs ?? null,
            dnsMs: importedTimings?.dnsMs ?? null,
            connectMs: importedTimings?.tcpConnectMs ?? null,
            tlsMs: importedTimings?.tlsHandshakeMs ?? null,
            receiveMs: importedTimings?.contentDownloadMs ?? null,
            requestSize: reqTotalBytes,
            wireBodySize:
              importedTransferStats?.responseWireBodyBytes ?? null,
            serverIp: importedTransferStats?.serverIp ?? null,
            serverConnReused:
              importedTransferStats?.serverConnReused ?? null,
          },
          requestHeaders: reqHeadersList,
          responseHeaders: respHeadersList,
          requestBodyBase64: reqText ? encodeTextToBase64(reqText) : "",
          responseBodyBase64: respB64,
          requestBodyText: reqText,
          responseBodyText: respText,
          tlsVersion: scheme === "https" ? "TLS 1.3" : null,
          clientAddr:
            typeof ext?.clientAddr === "string" ? ext.clientAddr : "har-import",
          websocketFrames: [],
          timings: importedTimings,
          transferStats: importedTransferStats,
        };
        const stored = this.insertIntoStoreWithRingBuffer(detail);
        importedSummaries.push(stored.summary);
      }
    }

    if (importedSummaries.length > 0) {
      this.emitBatch(importedSummaries);
    }
    return importedSummaries;
  }

  async savePreviewBody(
    sessionId: number,
    isResponse: boolean,
    filePath: string
  ): Promise<number> {
    const loaded = await this.loadSessionBody(sessionId, isResponse);
    const bytes = loaded.bodyBase64
      ? decodeBase64ToBytes(loaded.bodyBase64)
      : loaded.bodyText
        ? new TextEncoder().encode(loaded.bodyText)
        : new Uint8Array(0);
    triggerBrowserDownload(bytes, filePath);
    return bytes.byteLength;
  }

  private persistClientCertificates(): void {
    if (typeof window === "undefined") return;
    try {
      const persistent = this.clientCertificates.filter((c) => !c.ephemeral);
      window.localStorage.setItem(
        PREVIEW_CLIENT_CERTS_STORAGE_KEY,
        JSON.stringify(persistent)
      );
    } catch {
      // ignore storage errors in preview
    }
  }

  listClientCertificates(): ClientCertificateEntry[] {
    return this.clientCertificates.map((c) => ({ ...c }));
  }

  addClientCertificate(
    req: AddClientCertificateInput
  ): ClientCertificateEntry {
    const rawPattern = req.domainPattern.trim();
    if (!rawPattern || /\s/.test(rawPattern)) {
      throw new Error("Укажите корректную маску домена без пробелов.");
    }
    let clean = rawPattern.replace(/^(https?|wss?):\/\//i, "");
    const slashIdx = clean.indexOf("/");
    if (slashIdx >= 0) clean = clean.slice(0, slashIdx);
    if (!clean.startsWith("[")) {
      const colonCount = (clean.match(/:/g) ?? []).length;
      if (colonCount === 1) {
        clean = clean.replace(/:\d+$/, "");
      }
    }
    clean = clean.replace(/\.+$/, "").toLowerCase();
    if (!clean || clean === "*" || clean === "*.") {
      throw new Error(
        "Укажите конкретный домен или wildcard-маску вида *.domain.com."
      );
    }
    if (clean.startsWith("*.")) {
      const suffix = clean.slice(2);
      if (
        !suffix ||
        suffix.includes("*") ||
        suffix.startsWith(".") ||
        suffix.includes("..")
      ) {
        throw new Error(
          `Некорректная wildcard-маска '${req.domainPattern}'. Ожидается *.domain.com.`
        );
      }
    } else if (clean.includes("*")) {
      throw new Error("Wildcard '*' допускается только в начале маски (*.domain.com).");
    }

    const certPath = req.certPath.trim();
    if (!certPath) {
      throw new Error("Не указан путь к файлу сертификата.");
    }
    const cleanName = certPath.split(/[\\/]/).pop() ?? certPath;
    const ext = (cleanName.split(".").pop() ?? "").toLowerCase();
    if (!["p12", "pfx", "pem", "crt", "cer"].includes(ext)) {
      throw new Error(
        `Неподдерживаемое расширение '.${ext}'. Используйте .p12, .pfx, .pem, .crt или .cer.`
      );
    }
    previewPickedFiles.delete(certPath);
    if (req.keyPath) {
      previewPickedFiles.delete(req.keyPath);
    }

    const format: ClientCertificateFormat =
      ext === "p12" || ext === "pfx" ? "pkcs12" : "pem";
    const id = `preview-mcert-${Date.now()}`;
    const commonName = clean.startsWith("*.")
      ? `client.${clean.slice(2)}`
      : `client@${clean}`;
    const label = req.label?.trim() || commonName;
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");

    const isEphemeral = Boolean(req.ephemeral);
    const entry: ClientCertificateEntry = {
      id,
      domainPattern: clean,
      label,
      format,
      storedCertPath: isEphemeral
        ? "in-memory"
        : `%APPDATA%\\dev.fluxproxy.desktop\\client_certs\\${id}.${
            format === "pkcs12" ? ext : "pem"
          }`,
      commonName,
      expiresAt,
      enabled: req.enabled ?? true,
      ephemeral: isEphemeral,
    };

    this.clientCertificates = [...this.clientCertificates, entry];
    if (!isEphemeral) {
      this.persistClientCertificates();
    }
    return { ...entry };
  }

  toggleClientCertificate(
    id: string,
    enabled: boolean
  ): ClientCertificateEntry {
    const idx = this.clientCertificates.findIndex((c) => c.id === id);
    if (idx < 0) {
      throw new Error(`Клиентский сертификат '${id}' не найден.`);
    }
    const updated: ClientCertificateEntry = {
      ...this.clientCertificates[idx],
      enabled,
    };
    this.clientCertificates = this.clientCertificates.map((c, i) =>
      i === idx ? updated : c
    );
    this.persistClientCertificates();
    return { ...updated };
  }

  removeClientCertificate(id: string): ClientCertificateEntry[] {
    this.clientCertificates = this.clientCertificates.filter(
      (c) => c.id !== id
    );
    this.persistClientCertificates();
    return this.listClientCertificates();
  }

  private detectScriptHooks(code: string): {
    hasOnRequest: boolean;
    hasOnResponse: boolean;
  } {
    return {
      hasOnRequest: /(?:^|\n)\s*def\s+on_request\s*\(/m.test(code),
      hasOnResponse: /(?:^|\n)\s*def\s+on_response\s*\(/m.test(code),
    };
  }

  private emitScriptLog(
    level: ScriptConsoleLogEvent["level"],
    hook: string | null,
    sessionId: number | null,
    message: string
  ): void {
    const entry: ScriptConsoleLogEvent = {
      id: this.nextScriptLogId++,
      timestamp: new Date().toISOString(),
      level,
      hook,
      sessionId,
      message,
    };
    for (const cb of this.scriptLogListeners) {
      cb(entry);
    }
  }

  getPythonRunnerStatus(): PythonRunnerStatus {
    const hooks = this.detectScriptHooks(this.scriptCode);
    return {
      available: false,
      enabled: this.scriptEnabled,
      running: this.scriptEnabled,
      pythonExecutable: null,
      pythonVersion: "Browser Preview Simulator",
      workerPid: null,
      hasOnRequest: this.scriptEnabled && hooks.hasOnRequest,
      hasOnResponse: this.scriptEnabled && hooks.hasOnResponse,
      timeoutMs: 1500,
      lastError: null,
      restartCount: 0,
      invocationsCount: this.scriptInvocationsCount,
      timeoutCount: 0,
      isSimulator: true,
      code: this.scriptCode,
    };
  }

  setPythonScript(code: string, enabled: boolean): PythonRunnerStatus {
    this.scriptCode = code;
    this.scriptEnabled = enabled;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          PREVIEW_PYTHON_SCRIPT_STORAGE_KEY,
          JSON.stringify({ enabled, code })
        );
      } catch {
        // ignore storage quota errors
      }
    }
    const status = this.getPythonRunnerStatus();
    this.emitScriptLog(
      "info",
      "load",
      null,
      enabled
        ? `[Simulator] Скрипт сохранён и включён (on_request: ${status.hasOnRequest}, on_response: ${status.hasOnResponse}). Реальный Python-процесс работает в Tauri desktop (\`cargo tauri dev\`).`
        : "[Simulator] Скрипт сохранён (выполнение отключено)."
    );
    return status;
  }

  subscribeScriptLogs(
    cb: (entry: ScriptConsoleLogEvent) => void
  ): () => void {
    this.scriptLogListeners.add(cb);
    return () => {
      this.scriptLogListeners.delete(cb);
    };
  }

  getHostRemapRules(): HostRemapRule[] {
    return this.hostRemapRules.map((r) => ({ ...r }));
  }

  updateHostRemapRules(rules: HostRemapRule[]): HostRemapRule[] {
    const normalized = rules.map((r, idx) =>
      normalizeHostRemapRulePreview(r, idx)
    );
    this.hostRemapRules = normalized;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          PREVIEW_HOST_REMAP_RULES_STORAGE_KEY,
          JSON.stringify(normalized)
        );
      } catch {
        // ignore storage quota errors
      }
    }
    return this.getHostRemapRules();
  }

  getThrottleConfig(): ThrottleConfig {
    return { ...this.throttleConfig };
  }

  setThrottleConfig(config: ThrottleConfig): ThrottleConfig {
    const normalized = normalizeThrottleConfigPreview(config);
    this.throttleConfig = normalized;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          PREVIEW_THROTTLE_CONFIG_STORAGE_KEY,
          JSON.stringify(normalized)
        );
      } catch {
        // ignore storage quota errors
      }
    }
    return { ...normalized };
  }

  getUpstreamProxyConfig(): UpstreamProxyConfig {
    return {
      ...this.upstreamProxyConfig,
      bypassList: [...this.upstreamProxyConfig.bypassList],
      hasPassword: Boolean(this.upstreamProxyPassword),
    };
  }

  setUpstreamProxyConfig(config: UpstreamProxyConfig): UpstreamProxyConfig {
    const normalized = normalizeUpstreamProxyConfigPreview(
      config,
      true,
      this.port
    );
    if (config.password === "" || config.password === null) {
      this.upstreamProxyPassword = null;
    } else if (typeof config.password === "string" && config.password.length > 0) {
      this.upstreamProxyPassword = config.password;
    }
    this.upstreamProxyConfig = normalized;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          PREVIEW_UPSTREAM_PROXY_CONFIG_STORAGE_KEY,
          JSON.stringify(normalized)
        );
      } catch {
        // ignore storage quota errors
      }
    }
    return this.getUpstreamProxyConfig();
  }

  getUpstreamTimeouts(): UpstreamTimeoutConfig {
    return { ...this.upstreamTimeouts };
  }

  setUpstreamTimeouts(config: UpstreamTimeoutConfig): UpstreamTimeoutConfig {
    const validated = validateUpstreamTimeoutConfigPreview(config);
    this.upstreamTimeouts = validated;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          PREVIEW_UPSTREAM_TIMEOUTS_STORAGE_KEY,
          JSON.stringify(validated)
        );
      } catch {
        // ignore storage quota errors
      }
    }
    return { ...validated };
  }

  cancelComposedRequest(requestId: string): boolean {
    const clean = requestId.trim();
    const ctrl = this.activeComposerControllers.get(clean);
    if (!ctrl) return false;
    this.activeComposerControllers.delete(clean);
    ctrl.abort("composer-cancelled");
    return true;
  }

  injectWebSocketFrame(
    sessionId: number,
    direction: WsInjectDirection,
    opcode: WsInjectOpcode,
    payload: string
  ): WebSocketFrameRecord {
    const detail = this.store.get(sessionId);
    if (!detail || !detail.summary.wsOpen) {
      throw new Error(
        `Активное WebSocket-соединение для сессии #${sessionId} не найдено или уже закрыто.`
      );
    }

    let byteLength = 0;
    let payloadPreview = "";
    if (opcode === "binary") {
      const bytes = parseHexPayloadPreview(payload);
      byteLength = bytes.length;
      const hexHead = Array.from(bytes.slice(0, 24))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      payloadPreview = `<${bytes.length} bytes: ${hexHead}>`;
    } else {
      byteLength = new TextEncoder().encode(payload).length;
      payloadPreview = Array.from(payload).slice(0, 512).join("");
    }

    const prevFrames = detail.websocketFrames ?? [];
    const nextIndex =
      (prevFrames.length > 0 ? prevFrames[prevFrames.length - 1].index : 0) + 1;
    const frame: WebSocketFrameRecord = {
      index: nextIndex,
      direction: direction === "server" ? "outbound" : "inbound",
      opcode,
      payloadPreview,
      byteLength,
      timestamp: new Date().toISOString(),
      injected: true,
    };

    const nextSummary: SessionSummary = {
      ...detail.summary,
      bodySize: detail.summary.bodySize + byteLength,
    };
    const nextDetail: SessionDetail = {
      ...detail,
      summary: nextSummary,
      websocketFrames: [...prevFrames, frame],
    };
    this.store.set(sessionId, nextDetail);
    this.emitBatch([nextSummary]);
    return frame;
  }

  getNetworkInterfaces(includeVirtual = false): NetworkInterfaceInfo[] {
    const baseInterfaces: NetworkInterfaceInfo[] = [
      {
        name: "Wi-Fi",
        ip: "192.168.1.45",
        kind: "wifi",
        isPrimary: true,
      },
      {
        name: "Ethernet",
        ip: "10.0.0.24",
        kind: "ethernet",
        isPrimary: false,
      },
    ];
    if (!includeVirtual) {
      return baseInterfaces;
    }
    return [
      ...baseInterfaces,
      {
        name: "vEthernet (WSL)",
        ip: "172.24.16.1",
        kind: "virtual",
        isPrimary: false,
      },
      {
        name: "docker0 [Docker]",
        ip: "172.17.0.1",
        kind: "virtual",
        isPrimary: false,
      },
      {
        name: "Tailscale [Tailscale VPN]",
        ip: "100.101.102.4",
        kind: "vpn",
        isPrimary: false,
      },
    ];
  }
}

let previewEngineInstance: BrowserPreviewEngine | null = null;

export function getPreviewEngine(): BrowserPreviewEngine {
  if (!previewEngineInstance) {
    previewEngineInstance = new BrowserPreviewEngine();
  }
  return previewEngineInstance;
}
