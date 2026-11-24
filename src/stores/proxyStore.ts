import { create } from "zustand";
import {
  DEFAULT_CLEAR_DB_ON_EXIT,
  DEFAULT_HOST_REMAP_RULES,
  DEFAULT_PYTHON_SCRIPT_CODE,
  PREVIEW_CLEAR_DB_ON_EXIT_STORAGE_KEY,
} from "../lib/mockTraffic";
import { DEFAULT_BREAKPOINT_CONFIG } from "../lib/tauriBridge";
import {
  DEFAULT_SESSION_RETENTION_LIMIT,
  DEFAULT_THROTTLE_CONFIG,
  DEFAULT_UPSTREAM_PROXY_BYPASS_LIST,
  DEFAULT_UPSTREAM_PROXY_CONFIG,
  DEFAULT_UPSTREAM_TIMEOUT_CONFIG,
  UPSTREAM_TIMEOUT_LIMITS,
  type AutoResponderRule,
  type BindHostMode,
  type BreakpointConfig,
  type HostRemapRule,
  type PausedBreakpointItem,
  type ProxyStatus,
  type PythonRunnerStatus,
  type ScriptConsoleLogEvent,
  type SessionDetail,
  type SessionSummary,
  type StorageStats,
  type ThrottleConfig,
  type UpstreamProxyConfig,
  type UpstreamTimeoutConfig,
} from "../types/proxy";
import type { FluxUserSettingsProfile } from "../types/settings";

export const LS_AUTO_SYSPROXY_KEY = "fluxproxy.autoSystemProxy.v1";
export const LS_ALLOW_REMOTE_KEY = "fluxproxy.allowRemote.v1";
export const LS_BIND_MODE_KEY = "fluxproxy.bindMode.v1";
export const LS_SPECIFIC_BIND_IP_KEY = "fluxproxy.specificBindIp.v1";
export const LS_ALSO_BIND_LOOPBACK_KEY = "fluxproxy.alsoBindLoopback.v1";
export const LS_PROXY_PORT_KEY = "fluxproxy.proxyPort.v1";
export const LS_FOLLOW_TAIL_KEY = "fluxproxy.followTail.v1";
export const LS_BREAKPOINT_CFG_KEY = "fluxproxy.breakpointConfig.v1";
export const LS_RETENTION_LIMIT_KEY = "fluxproxy.sessionRetentionLimit.v1";
export const LS_DROP_NON_MATCHING_KEY = "fluxproxy.dropNonMatching.v1";
export const LS_CLEAR_DB_ON_EXIT_KEY = PREVIEW_CLEAR_DB_ON_EXIT_STORAGE_KEY;
export const LS_HOST_REMAP_RULES_KEY = "fluxproxy-host-remap-rules-v1";
export const LS_THROTTLE_CONFIG_KEY = "fluxproxy-throttle-config-v1";
export const LS_UPSTREAM_PROXY_CONFIG_KEY = "fluxproxy-upstream-proxy-config-v1";
export const LS_UPSTREAM_TIMEOUTS_KEY = "fluxproxy-upstream-timeouts-v1";

function sanitizeUpstreamTimeoutsForStore(
  raw: Partial<UpstreamTimeoutConfig> | null | undefined
): UpstreamTimeoutConfig {
  const c = raw?.connectTimeoutSec;
  const r = raw?.responseHeaderTimeoutSec;
  const cmp = raw?.composerTimeoutSec;
  return {
    connectTimeoutSec:
      typeof c === "number" &&
      Number.isInteger(c) &&
      c >= UPSTREAM_TIMEOUT_LIMITS.connectMin &&
      c <= UPSTREAM_TIMEOUT_LIMITS.connectMax
        ? c
        : DEFAULT_UPSTREAM_TIMEOUT_CONFIG.connectTimeoutSec,
    responseHeaderTimeoutSec:
      r === 0 ||
      (typeof r === "number" &&
        Number.isInteger(r) &&
        r >= UPSTREAM_TIMEOUT_LIMITS.responseHeaderMin &&
        r <= UPSTREAM_TIMEOUT_LIMITS.responseHeaderMax)
        ? r
        : DEFAULT_UPSTREAM_TIMEOUT_CONFIG.responseHeaderTimeoutSec,
    composerTimeoutSec:
      cmp === 0 ||
      (typeof cmp === "number" &&
        Number.isInteger(cmp) &&
        cmp >= UPSTREAM_TIMEOUT_LIMITS.composerMin &&
        cmp <= UPSTREAM_TIMEOUT_LIMITS.composerMax)
        ? cmp
        : DEFAULT_UPSTREAM_TIMEOUT_CONFIG.composerTimeoutSec,
  };
}

function sanitizeUpstreamConfigForStore(
  raw: Partial<UpstreamProxyConfig> | null | undefined,
  keepHasPassword = false
): UpstreamProxyConfig {
  const bypassList = Array.isArray(raw?.bypassList)
    ? raw.bypassList.filter((item): item is string => typeof item === "string")
    : [...DEFAULT_UPSTREAM_PROXY_BYPASS_LIST];
  return {
    enabled: Boolean(raw?.enabled),
    protocol:
      raw?.protocol === "https" || raw?.protocol === "socks5"
        ? raw.protocol
        : "http",
    host: typeof raw?.host === "string" ? raw.host : "",
    port:
      typeof raw?.port === "number" &&
      Number.isInteger(raw.port) &&
      raw.port >= 1 &&
      raw.port <= 65535
        ? raw.port
        : DEFAULT_UPSTREAM_PROXY_CONFIG.port,
    username: typeof raw?.username === "string" ? raw.username : null,
    hasPassword: keepHasPassword ? Boolean(raw?.hasPassword) : false,
    bypassList,
  };
}

export interface PersistedBindConfig {
  bindMode: BindHostMode;
  specificBindIp: string | null;
  alsoBindLoopback: boolean;
}

export function loadProxyJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadPersistedBindConfig(): PersistedBindConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const rawMode = window.localStorage.getItem(LS_BIND_MODE_KEY);
    const rawSpecificIp = window.localStorage.getItem(LS_SPECIFIC_BIND_IP_KEY);
    const rawAlsoLoopback = window.localStorage.getItem(
      LS_ALSO_BIND_LOOPBACK_KEY
    );
    const rawLegacyRemote = window.localStorage.getItem(LS_ALLOW_REMOTE_KEY);

    if (rawMode === null && rawLegacyRemote === null) {
      return null;
    }

    let specificBindIp: string | null = null;
    if (rawSpecificIp !== null) {
      const parsedIp = JSON.parse(rawSpecificIp);
      if (typeof parsedIp === "string" && parsedIp.trim().length > 0) {
        specificBindIp = parsedIp.trim();
      }
    }

    const alsoBindLoopback =
      rawAlsoLoopback !== null ? Boolean(JSON.parse(rawAlsoLoopback)) : true;

    let bindMode: BindHostMode = "loopback";
    if (rawMode !== null) {
      const parsedMode = JSON.parse(rawMode);
      if (
        parsedMode === "all" ||
        parsedMode === "loopback" ||
        (parsedMode === "specific" && specificBindIp)
      ) {
        bindMode = parsedMode;
      }
    } else if (rawLegacyRemote !== null) {
      bindMode = Boolean(JSON.parse(rawLegacyRemote)) ? "all" : "loopback";
    }

    return { bindMode, specificBindIp, alsoBindLoopback };
  } catch {
    return null;
  }
}

export function computeBoundIpsForState(
  bindMode: BindHostMode,
  specificBindIp: string | null,
  alsoBindLoopback: boolean
): string[] {
  if (bindMode === "all") return ["0.0.0.0"];
  if (bindMode === "specific" && specificBindIp) {
    if (alsoBindLoopback && specificBindIp !== "127.0.0.1") {
      return [specificBindIp, "127.0.0.1"];
    }
    return [specificBindIp];
  }
  return ["127.0.0.1"];
}

export function formatStatusEndpoints(statusObj: ProxyStatus): string {
  const ips =
    statusObj.boundIps && statusObj.boundIps.length > 0
      ? statusObj.boundIps
      : [statusObj.bindAddr];
  return ips.map((ip) => `${ip}:${statusObj.port}`).join(" + ");
}

export function persistBindConfigToLocalStorage(statusObj: ProxyStatus): void {
  if (typeof window === "undefined") return;
  const resolvedMode: BindHostMode =
    statusObj.bindMode ??
    (statusObj.allowRemote || statusObj.bindAddr === "0.0.0.0"
      ? "all"
      : "loopback");
  const resolvedSpecificIp = statusObj.specificBindIp ?? null;
  const resolvedAlsoLoopback = statusObj.alsoBindLoopback ?? true;
  const resolvedAllowRemote =
    resolvedMode === "all"
      ? true
      : resolvedMode === "specific" && resolvedSpecificIp
        ? resolvedSpecificIp !== "127.0.0.1" && resolvedSpecificIp !== "::1"
        : false;
  try {
    window.localStorage.setItem(LS_BIND_MODE_KEY, JSON.stringify(resolvedMode));
    window.localStorage.setItem(
      LS_SPECIFIC_BIND_IP_KEY,
      JSON.stringify(resolvedSpecificIp)
    );
    window.localStorage.setItem(
      LS_ALSO_BIND_LOOPBACK_KEY,
      JSON.stringify(resolvedAlsoLoopback)
    );
    window.localStorage.setItem(
      LS_ALLOW_REMOTE_KEY,
      JSON.stringify(resolvedAllowRemote)
    );
  } catch {
    // ignore storage quota errors
  }
}

export function loadPersistedProxyPort(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_PROXY_PORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "number" &&
      Number.isInteger(parsed) &&
      parsed >= 1 &&
      parsed <= 65535
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function loadPersistedRetentionLimit(): number | null {
  if (typeof window === "undefined") return DEFAULT_SESSION_RETENTION_LIMIT;
  try {
    const raw = window.localStorage.getItem(LS_RETENTION_LIMIT_KEY);
    if (raw === null) return DEFAULT_SESSION_RETENTION_LIMIT;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) return null;
    if (typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
    return DEFAULT_SESSION_RETENTION_LIMIT;
  } catch {
    return DEFAULT_SESSION_RETENTION_LIMIT;
  }
}

function readHasPersistedClearDbOnExit(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LS_CLEAR_DB_ON_EXIT_KEY) !== null;
  } catch {
    return false;
  }
}

function buildInitialStatusFromStorage(): ProxyStatus {
  const initialAutoSysProxy = loadProxyJson<boolean | null>(
    LS_AUTO_SYSPROXY_KEY,
    null
  );
  const initialBindConfig = loadPersistedBindConfig();
  const initialPort = loadPersistedProxyPort();

  const initialBindMode: BindHostMode =
    initialBindConfig?.bindMode ?? "loopback";
  const initialSpecificBindIp = initialBindConfig?.specificBindIp ?? null;
  const initialAlsoBindLoopback = initialBindConfig?.alsoBindLoopback ?? true;
  const initialBindAddr =
    initialBindMode === "all"
      ? "0.0.0.0"
      : initialBindMode === "specific" && initialSpecificBindIp
        ? initialSpecificBindIp
        : "127.0.0.1";
  const initialAllowRemote =
    initialBindMode === "all" ||
    (initialBindMode === "specific" &&
      Boolean(initialSpecificBindIp) &&
      initialSpecificBindIp !== "127.0.0.1");

  return {
    running: true,
    bindAddr: initialBindAddr,
    port: initialPort ?? 8888,
    activeSessions: 0,
    systemProxyEnabled: initialAutoSysProxy ?? true,
    autoSystemProxy: initialAutoSysProxy ?? true,
    systemProxyError: null,
    allowRemote: initialAllowRemote,
    bindMode: initialBindMode,
    specificBindIp: initialSpecificBindIp,
    alsoBindLoopback: initialAlsoBindLoopback,
    boundIps: computeBoundIpsForState(
      initialBindMode,
      initialSpecificBindIp,
      initialAlsoBindLoopback
    ),
  };
}

function readPersistedProxyConfigFromLocalStorage() {
  const sessionRetentionLimit = loadPersistedRetentionLimit();
  const dropNonMatching = loadProxyJson<boolean>(
    LS_DROP_NON_MATCHING_KEY,
    false
  );
  const clearDbOnExit = Boolean(
    loadProxyJson<boolean>(LS_CLEAR_DB_ON_EXIT_KEY, DEFAULT_CLEAR_DB_ON_EXIT)
  );
  const savedBp = loadProxyJson<BreakpointConfig>(
    LS_BREAKPOINT_CFG_KEY,
    structuredClone(DEFAULT_BREAKPOINT_CONFIG)
  );
  const breakpointConfig: BreakpointConfig = {
    ...DEFAULT_BREAKPOINT_CONFIG,
    ...savedBp,
    breakBeforeRequest: false,
    breakAfterResponse: false,
  };
  const followTail = Boolean(
    loadProxyJson<boolean>(LS_FOLLOW_TAIL_KEY, false)
  );
  const savedHostRemap = loadProxyJson<HostRemapRule[]>(
    LS_HOST_REMAP_RULES_KEY,
    DEFAULT_HOST_REMAP_RULES
  );
  const hostRemapRules = Array.isArray(savedHostRemap)
    ? savedHostRemap
    : [...DEFAULT_HOST_REMAP_RULES];
  const savedThrottle = loadProxyJson<ThrottleConfig>(
    LS_THROTTLE_CONFIG_KEY,
    DEFAULT_THROTTLE_CONFIG
  );
  const throttleConfig: ThrottleConfig =
    savedThrottle && typeof savedThrottle === "object"
      ? {
          ...DEFAULT_THROTTLE_CONFIG,
          ...savedThrottle,
        }
      : { ...DEFAULT_THROTTLE_CONFIG };
  const savedUpstreamProxy = loadProxyJson<Partial<UpstreamProxyConfig> | null>(
    LS_UPSTREAM_PROXY_CONFIG_KEY,
    null
  );
  const upstreamProxyConfig: UpstreamProxyConfig = sanitizeUpstreamConfigForStore(
    savedUpstreamProxy,
    false
  );
  const savedUpstreamTimeouts = loadProxyJson<Partial<UpstreamTimeoutConfig> | null>(
    LS_UPSTREAM_TIMEOUTS_KEY,
    null
  );
  const upstreamTimeouts: UpstreamTimeoutConfig =
    sanitizeUpstreamTimeoutsForStore(savedUpstreamTimeouts);

  return {
    status: buildInitialStatusFromStorage(),
    followTail,
    sessionRetentionLimit,
    dropNonMatching,
    clearDbOnExit,
    hasPersistedClearDbOnExit: readHasPersistedClearDbOnExit(),
    breakpointConfig,
    hostRemapRules,
    throttleConfig,
    upstreamProxyConfig,
    upstreamTimeouts,
  };
}

function readInitialProxySlice() {
  const persisted = readPersistedProxyConfigFromLocalStorage();
  return {
    sessions: [] as SessionSummary[],
    selectedId: null as number | null,
    selectedIds: [] as number[],
    selectedDetail: null as SessionDetail | null,
    diffLeftDetail: null as SessionDetail | null,
    diffRightDetail: null as SessionDetail | null,
    toastMessage: null as string | null,
    storageStats: {
      ramSessions: 0,
      sqliteSizeBytes: 0,
      droppedSessionsCount: 0,
      sessionRetentionLimit: persisted.sessionRetentionLimit,
      dropNonMatching: persisted.dropNonMatching,
    } as StorageStats,
    pausedBreakpoints: [] as PausedBreakpointItem[],
    ...persisted,
  };
}

type Updater<T> = T | ((prev: T) => T);

function resolveUpdater<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === "function"
    ? (updater as (p: T) => T)(prev)
    : updater;
}

export interface ProxyStoreState {
  sessions: SessionSummary[];
  selectedId: number | null;
  selectedIds: number[];
  selectedDetail: SessionDetail | null;
  diffLeftDetail: SessionDetail | null;
  diffRightDetail: SessionDetail | null;
  status: ProxyStatus;
  followTail: boolean;
  toastMessage: string | null;
  sessionRetentionLimit: number | null;
  dropNonMatching: boolean;
  clearDbOnExit: boolean;
  hasPersistedClearDbOnExit: boolean;
  storageStats: StorageStats;
  breakpointConfig: BreakpointConfig;
  pausedBreakpoints: PausedBreakpointItem[];
  hostRemapRules: HostRemapRule[];
  throttleConfig: ThrottleConfig;
  upstreamProxyConfig: UpstreamProxyConfig;
  upstreamTimeouts: UpstreamTimeoutConfig;

  // AutoResponder & Python Scripting state
  autoResponderEnabled: boolean;
  rules: AutoResponderRule[];
  scriptCode: string;
  scriptEnabled: boolean;
  scriptActivePresetId: string | null;
  pythonRunnerStatus: PythonRunnerStatus | null;
  scriptConsoleLogs: ScriptConsoleLogEvent[];
  isApplyingScript: boolean;

  setSessions: (updater: Updater<SessionSummary[]>) => void;
  setSelectedIdState: (updater: Updater<number | null>) => void;
  setSelectedIds: (updater: Updater<number[]>) => void;
  setSelectedDetail: (updater: Updater<SessionDetail | null>) => void;
  setDiffLeftDetail: (updater: Updater<SessionDetail | null>) => void;
  setDiffRightDetail: (updater: Updater<SessionDetail | null>) => void;
  setStatus: (updater: Updater<ProxyStatus>) => void;
  setFollowTail: (updater: Updater<boolean>) => void;
  setToastMessage: (updater: Updater<string | null>) => void;
  setSessionRetentionLimitState: (updater: Updater<number | null>) => void;
  setDropNonMatchingState: (updater: Updater<boolean>) => void;
  setClearDbOnExitState: (updater: Updater<boolean>) => void;
  setHasPersistedClearDbOnExit: (val: boolean) => void;
  setStorageStats: (updater: Updater<StorageStats>) => void;
  setBreakpointConfig: (updater: Updater<BreakpointConfig>) => void;
  setPausedBreakpoints: (updater: Updater<PausedBreakpointItem[]>) => void;
  setHostRemapRules: (updater: Updater<HostRemapRule[]>) => void;
  setThrottleConfig: (updater: Updater<ThrottleConfig>) => void;
  setUpstreamProxyConfig: (updater: Updater<UpstreamProxyConfig>) => void;
  setUpstreamTimeouts: (updater: Updater<UpstreamTimeoutConfig>) => void;

  setAutoResponderEnabled: (updater: Updater<boolean>) => void;
  setRules: (updater: Updater<AutoResponderRule[]>) => void;
  setScriptCode: (updater: Updater<string>) => void;
  setScriptEnabled: (updater: Updater<boolean>) => void;
  setScriptActivePresetId: (updater: Updater<string | null>) => void;
  setPythonRunnerStatus: (updater: Updater<PythonRunnerStatus | null>) => void;
  setScriptConsoleLogs: (updater: Updater<ScriptConsoleLogEvent[]>) => void;
  setIsApplyingScript: (updater: Updater<boolean>) => void;

  applySettingsProfileProxy: (detail: FluxUserSettingsProfile) => void;
  syncFromLocalStorage: () => void;
}

export const useProxyStore = create<ProxyStoreState>((set) => ({
  ...readInitialProxySlice(),

  autoResponderEnabled: true,
  rules: [],
  scriptCode: DEFAULT_PYTHON_SCRIPT_CODE,
  scriptEnabled: false,
  scriptActivePresetId: "hmac-header-injection",
  pythonRunnerStatus: null,
  scriptConsoleLogs: [],
  isApplyingScript: false,

  setSessions: (updater) => {
    set((state) => ({ sessions: resolveUpdater(updater, state.sessions) }));
  },

  setSelectedIdState: (updater) => {
    set((state) => ({ selectedId: resolveUpdater(updater, state.selectedId) }));
  },

  setSelectedIds: (updater) => {
    set((state) => ({
      selectedIds: resolveUpdater(updater, state.selectedIds),
    }));
  },

  setSelectedDetail: (updater) => {
    set((state) => ({
      selectedDetail: resolveUpdater(updater, state.selectedDetail),
    }));
  },

  setDiffLeftDetail: (updater) => {
    set((state) => ({
      diffLeftDetail: resolveUpdater(updater, state.diffLeftDetail),
    }));
  },

  setDiffRightDetail: (updater) => {
    set((state) => ({
      diffRightDetail: resolveUpdater(updater, state.diffRightDetail),
    }));
  },

  setStatus: (updater) => {
    set((state) => ({ status: resolveUpdater(updater, state.status) }));
  },

  setFollowTail: (updater) => {
    set((state) => {
      const followTail = resolveUpdater(updater, state.followTail);
      try {
        window.localStorage.setItem(
          LS_FOLLOW_TAIL_KEY,
          JSON.stringify(followTail)
        );
      } catch {
        // ignore storage quota errors
      }
      return { followTail };
    });
  },

  setToastMessage: (updater) => {
    set((state) => ({
      toastMessage: resolveUpdater(updater, state.toastMessage),
    }));
  },

  setSessionRetentionLimitState: (updater) => {
    set((state) => ({
      sessionRetentionLimit: resolveUpdater(updater, state.sessionRetentionLimit),
    }));
  },

  setDropNonMatchingState: (updater) => {
    set((state) => ({
      dropNonMatching: resolveUpdater(updater, state.dropNonMatching),
    }));
  },

  setClearDbOnExitState: (updater) => {
    set((state) => ({
      clearDbOnExit: resolveUpdater(updater, state.clearDbOnExit),
    }));
  },

  setHasPersistedClearDbOnExit: (hasPersistedClearDbOnExit) => {
    set({ hasPersistedClearDbOnExit });
  },

  setStorageStats: (updater) => {
    set((state) => ({
      storageStats: resolveUpdater(updater, state.storageStats),
    }));
  },

  setBreakpointConfig: (updater) => {
    set((state) => ({
      breakpointConfig: resolveUpdater(updater, state.breakpointConfig),
    }));
  },

  setPausedBreakpoints: (updater) => {
    set((state) => ({
      pausedBreakpoints: resolveUpdater(updater, state.pausedBreakpoints),
    }));
  },

  setAutoResponderEnabled: (updater) => {
    set((state) => ({
      autoResponderEnabled: resolveUpdater(updater, state.autoResponderEnabled),
    }));
  },

  setRules: (updater) => {
    set((state) => ({ rules: resolveUpdater(updater, state.rules) }));
  },

  setHostRemapRules: (updater) => {
    set((state) => {
      const hostRemapRules = resolveUpdater(updater, state.hostRemapRules);
      try {
        window.localStorage.setItem(
          LS_HOST_REMAP_RULES_KEY,
          JSON.stringify(hostRemapRules)
        );
      } catch {
        // ignore storage quota errors
      }
      return { hostRemapRules };
    });
  },

  setThrottleConfig: (updater) => {
    set((state) => {
      const throttleConfig = resolveUpdater(updater, state.throttleConfig);
      try {
        window.localStorage.setItem(
          LS_THROTTLE_CONFIG_KEY,
          JSON.stringify(throttleConfig)
        );
      } catch {
        // ignore storage quota errors
      }
      return { throttleConfig };
    });
  },

  setUpstreamProxyConfig: (updater) => {
    set((state) => {
      const nextRaw = resolveUpdater(updater, state.upstreamProxyConfig);
      const upstreamProxyConfig = sanitizeUpstreamConfigForStore(nextRaw, true);
      try {
        const persisted = {
          enabled: upstreamProxyConfig.enabled,
          protocol: upstreamProxyConfig.protocol,
          host: upstreamProxyConfig.host,
          port: upstreamProxyConfig.port,
          username: upstreamProxyConfig.username ?? null,
          bypassList: upstreamProxyConfig.bypassList,
        };
        window.localStorage.setItem(
          LS_UPSTREAM_PROXY_CONFIG_KEY,
          JSON.stringify(persisted)
        );
      } catch {
        // ignore storage quota errors
      }
      return { upstreamProxyConfig };
    });
  },

  setUpstreamTimeouts: (updater) => {
    set((state) => {
      const nextRaw = resolveUpdater(updater, state.upstreamTimeouts);
      const upstreamTimeouts = sanitizeUpstreamTimeoutsForStore(nextRaw);
      try {
        window.localStorage.setItem(
          LS_UPSTREAM_TIMEOUTS_KEY,
          JSON.stringify(upstreamTimeouts)
        );
      } catch {
        // ignore storage quota errors
      }
      return { upstreamTimeouts };
    });
  },

  setScriptCode: (updater) => {
    set((state) => ({ scriptCode: resolveUpdater(updater, state.scriptCode) }));
  },

  setScriptEnabled: (updater) => {
    set((state) => ({
      scriptEnabled: resolveUpdater(updater, state.scriptEnabled),
    }));
  },

  setScriptActivePresetId: (updater) => {
    set((state) => ({
      scriptActivePresetId: resolveUpdater(
        updater,
        state.scriptActivePresetId
      ),
    }));
  },

  setPythonRunnerStatus: (updater) => {
    set((state) => ({
      pythonRunnerStatus: resolveUpdater(updater, state.pythonRunnerStatus),
    }));
  },

  setScriptConsoleLogs: (updater) => {
    set((state) => ({
      scriptConsoleLogs: resolveUpdater(updater, state.scriptConsoleLogs),
    }));
  },

  setIsApplyingScript: (updater) => {
    set((state) => ({
      isApplyingScript: resolveUpdater(updater, state.isApplyingScript),
    }));
  },

  applySettingsProfileProxy: (detail) => {
    const nextFollowTail = Boolean(detail.ui.followTail);
    const nextRetention =
      detail.proxy.sessionRetentionLimit !== undefined
        ? detail.proxy.sessionRetentionLimit
        : DEFAULT_SESSION_RETENTION_LIMIT;
    const nextDropNonMatching = Boolean(detail.proxy.dropNonMatching ?? false);
    const nextClearDbOnExit = Boolean(
      detail.proxy.clearDbOnExit ?? DEFAULT_CLEAR_DB_ON_EXIT
    );

    const detailBindMode: BindHostMode =
      detail.proxy.bindMode ?? (detail.proxy.allowRemote ? "all" : "loopback");
    const detailSpecificIp = detail.proxy.specificBindIp ?? null;
    const detailAlsoLoopback = detail.proxy.alsoBindLoopback ?? true;
    const detailBindAddr =
      detailBindMode === "all"
        ? "0.0.0.0"
        : detailBindMode === "specific" && detailSpecificIp
          ? detailSpecificIp
          : "127.0.0.1";

    set((state) => {
      const nextSessions =
        nextRetention && state.sessions.length > nextRetention
          ? state.sessions.slice(state.sessions.length - nextRetention)
          : state.sessions;

      const nextStatusOptimistic: ProxyStatus = {
        ...state.status,
        port: detail.proxy.port,
        autoSystemProxy: detail.proxy.autoSystemProxy,
        allowRemote: detail.proxy.allowRemote,
        bindAddr: detailBindAddr,
        bindMode: detailBindMode,
        specificBindIp: detailSpecificIp,
        alsoBindLoopback: detailAlsoLoopback,
        boundIps: computeBoundIpsForState(
          detailBindMode,
          detailSpecificIp,
          detailAlsoLoopback
        ),
      };

      const nextBp: BreakpointConfig = detail.breakpoints
        ? {
            ...DEFAULT_BREAKPOINT_CONFIG,
            ...detail.breakpoints,
            rules: structuredClone(detail.breakpoints.rules ?? []),
          }
        : state.breakpointConfig;

      const nextHostRemapRules: HostRemapRule[] = Array.isArray(
        detail.proxy.hostRemapRules
      )
        ? structuredClone(detail.proxy.hostRemapRules)
        : state.hostRemapRules;
      const nextThrottleConfig: ThrottleConfig = detail.proxy.throttleConfig
        ? { ...DEFAULT_THROTTLE_CONFIG, ...detail.proxy.throttleConfig }
        : { ...DEFAULT_THROTTLE_CONFIG };
      const incomingUp = detail.proxy.upstreamProxy;
      const sameUpstreamIdentity =
        incomingUp &&
        incomingUp.enabled &&
        state.upstreamProxyConfig.enabled &&
        incomingUp.protocol === state.upstreamProxyConfig.protocol &&
        incomingUp.host.trim().toLowerCase() ===
          state.upstreamProxyConfig.host.trim().toLowerCase() &&
        incomingUp.port === state.upstreamProxyConfig.port &&
        (incomingUp.username ?? null) ===
          (state.upstreamProxyConfig.username ?? null);
      const nextUpstreamProxyConfig: UpstreamProxyConfig = incomingUp
        ? sanitizeUpstreamConfigForStore(
            {
              ...incomingUp,
              hasPassword: sameUpstreamIdentity
                ? Boolean(state.upstreamProxyConfig.hasPassword)
                : false,
            },
            true
          )
        : {
            ...DEFAULT_UPSTREAM_PROXY_CONFIG,
            bypassList: [...DEFAULT_UPSTREAM_PROXY_BYPASS_LIST],
          };
      const nextUpstreamTimeouts = sanitizeUpstreamTimeoutsForStore(
        detail.proxy.upstreamTimeouts
      );

      return {
        followTail: nextFollowTail,
        sessionRetentionLimit: nextRetention,
        sessions: nextSessions,
        dropNonMatching: nextDropNonMatching,
        clearDbOnExit: nextClearDbOnExit,
        status: nextStatusOptimistic,
        breakpointConfig: nextBp,
        hostRemapRules: nextHostRemapRules,
        throttleConfig: nextThrottleConfig,
        upstreamProxyConfig: nextUpstreamProxyConfig,
        upstreamTimeouts: nextUpstreamTimeouts,
      };
    });
  },

  syncFromLocalStorage: () => {
    set(readPersistedProxyConfigFromLocalStorage());
  },
}));
