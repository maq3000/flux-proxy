import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BUILT_IN_FILTER_PRESETS,
  compileFilterMatrix,
  compileHostListFilter,
  DEFAULT_BACKEND_FILTER_CONFIG,
  DEFAULT_HOST_LIST_FILTER_CONFIG,
  DEFAULT_NOISE_THRESHOLDS,
  evaluateSessionAgainstFilters,
  matchHostRuleList,
  normalizeHostToken,
} from "../lib/filterEngine";
import {
  formatBytes,
  getRowSemanticTone,
  suggestSessionBodyFileName,
} from "../lib/formatters";
import {
  DEFAULT_CLEAR_DB_ON_EXIT,
  PREVIEW_CLEAR_DB_ON_EXIT_STORAGE_KEY,
} from "../lib/mockTraffic";
import {
  DEFAULT_BREAKPOINT_CONFIG,
  type FileDialogFilter,
  isTauriRuntime,
  proxyBridge,
} from "../lib/tauriBridge";
import { DEFAULT_SESSION_RETENTION_LIMIT } from "../types/proxy";
import {
  PROXY_STATUS_SYNCED_EVENT,
  SETTINGS_APPLIED_EVENT,
  type FluxUserSettingsProfile,
} from "../types/settings";
import type {
  BindHostMode,
  BreakpointAction,
  BreakpointConfig,
  BreakpointResolution,
  DetectedProcessItem,
  FilterConditionRule,
  FilterPreset,
  HostListBackendSyncConfig,
  HostListFilterConfig,
  NoiseThresholdsBackendSyncConfig,
  NoiseThresholdsConfig,
  PausedBreakpointItem,
  ProxyFilterBackendConfig,
  ProxyStatus,
  QuickFilterCategory,
  SanitizationOptions,
  SessionDetail,
  SessionSummary,
  StorageStats,
  TlsBypassRule,
  TlsInterceptMode,
} from "../types/proxy";

const LS_CUSTOM_PRESETS_KEY = "fluxproxy.customFilterPresets.v1";
const LS_ACTIVE_FILTER_STATE_KEY = "fluxproxy.activeFilterState.v1";
const LS_BACKEND_FILTER_CFG_KEY = "fluxproxy.backendFilterConfig.v1";
const LS_AUTO_SYSPROXY_KEY = "fluxproxy.autoSystemProxy.v1";
const LS_ALLOW_REMOTE_KEY = "fluxproxy.allowRemote.v1";
const LS_BIND_MODE_KEY = "fluxproxy.bindMode.v1";
const LS_SPECIFIC_BIND_IP_KEY = "fluxproxy.specificBindIp.v1";
const LS_ALSO_BIND_LOOPBACK_KEY = "fluxproxy.alsoBindLoopback.v1";
const LS_PROXY_PORT_KEY = "fluxproxy.proxyPort.v1";
const LS_FOLLOW_TAIL_KEY = "fluxproxy.followTail.v1";
const LS_BREAKPOINT_CFG_KEY = "fluxproxy.breakpointConfig.v1";
const LS_RETENTION_LIMIT_KEY = "fluxproxy.sessionRetentionLimit.v1";
const LS_DROP_NON_MATCHING_KEY = "fluxproxy.dropNonMatching.v1";
const LS_CLEAR_DB_ON_EXIT_KEY = PREVIEW_CLEAR_DB_ON_EXIT_STORAGE_KEY;

interface PersistedBindConfig {
  bindMode: BindHostMode;
  specificBindIp: string | null;
  alsoBindLoopback: boolean;
}

function loadPersistedBindConfig(): PersistedBindConfig | null {
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

function computeBoundIpsForState(
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

function formatStatusEndpoints(statusObj: ProxyStatus): string {
  const ips =
    statusObj.boundIps && statusObj.boundIps.length > 0
      ? statusObj.boundIps
      : [statusObj.bindAddr];
  return ips.map((ip) => `${ip}:${statusObj.port}`).join(" + ");
}

function persistBindConfigToLocalStorage(statusObj: ProxyStatus): void {
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

function loadPersistedProxyPort(): number | null {
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

function loadPersistedRetentionLimit(): number | null {
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

function buildNoiseThresholdsSyncPayload(
  th: NoiseThresholdsConfig
): NoiseThresholdsBackendSyncConfig {
  return {
    hide304NotModified: th.hide304NotModified,
    hideOptionsPreflight: th.hideOptionsPreflight,
    hideConnectTunnels: th.hideConnectTunnels,
    hideStaticAssets: th.hideStaticAssets,
    minBodySizeBytes: th.minBodySizeBytes,
    maxBodySizeBytes: th.maxBodySizeBytes,
    timeHeatWarningMs: th.timeHeatWarningMs,
    onlySlowRequests: th.onlySlowRequests,
  };
}

function buildCaptureHostListPayload(
  cfg: HostListFilterConfig,
  activeCount: number
): HostListBackendSyncConfig {
  return {
    enabled: Boolean(cfg.enabled && activeCount > 0),
    mode: cfg.mode,
    rawText: cfg.rawText,
  };
}

interface PersistedFilterState {
  matrixEnabled: boolean;
  rules: FilterConditionRule[];
  thresholds: NoiseThresholdsConfig;
  activePresetId: string | null;
  hostListFilter?: HostListFilterConfig;
}

function buildHostListSyncPayload(
  cfg: HostListFilterConfig,
  activeCount: number
): HostListBackendSyncConfig {
  return {
    enabled: Boolean(
      cfg.enabled && cfg.applyToTlsPassthrough && activeCount > 0
    ),
    mode: cfg.mode,
    rawText: cfg.rawText,
  };
}

function loadPersistedState<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function useProxySessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedIdState] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const selectionAnchorIdRef = useRef<number | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<SessionDetail | null>(
    null
  );
  const [diffLeftDetail, setDiffLeftDetail] = useState<SessionDetail | null>(
    null
  );
  const [diffRightDetail, setDiffRightDetail] = useState<SessionDetail | null>(
    null
  );

  const setSelectedId = useCallback((id: number | null) => {
    selectionAnchorIdRef.current = id;
    setSelectedIdState(id);
    setSelectedIds(id !== null ? [id] : []);
  }, []);

  const initialAutoSysProxy = useMemo(
    () => loadPersistedState<boolean | null>(LS_AUTO_SYSPROXY_KEY, null),
    []
  );
  const initialBindConfig = useMemo(() => loadPersistedBindConfig(), []);
  const initialPort = useMemo(() => loadPersistedProxyPort(), []);

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

  const [status, setStatus] = useState<ProxyStatus>({
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
  });
  const statusRef = useRef<ProxyStatus>(status);
  statusRef.current = status;

  // Quick Search & Regex Filter State (TopToolbar)
  const [filterQuery, setFilterQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [quickCategory, setQuickCategory] =
    useState<QuickFilterCategory>("all");
  const [followTail, setFollowTail] = useState<boolean>(() =>
    Boolean(loadPersistedState<boolean>(LS_FOLLOW_TAIL_KEY, false))
  );
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Advanced Filter Matrix, Presets, Thresholds & Backend Config
  const initialPersisted = useMemo(
    () =>
      loadPersistedState<PersistedFilterState>(LS_ACTIVE_FILTER_STATE_KEY, {
        matrixEnabled: true,
        rules: [],
        thresholds: { ...DEFAULT_NOISE_THRESHOLDS },
        activePresetId: null,
        hostListFilter: { ...DEFAULT_HOST_LIST_FILTER_CONFIG },
      }),
    []
  );

  const [matrixEnabled, setMatrixEnabled] = useState<boolean>(
    initialPersisted.matrixEnabled
  );
  const [filterRules, setFilterRules] = useState<FilterConditionRule[]>(
    initialPersisted.rules
  );
  const [thresholds, setThresholds] = useState<NoiseThresholdsConfig>({
    ...DEFAULT_NOISE_THRESHOLDS,
    ...initialPersisted.thresholds,
  });
  const [hostListFilter, setHostListFilterState] =
    useState<HostListFilterConfig>(() => ({
      ...DEFAULT_HOST_LIST_FILTER_CONFIG,
      ...(initialPersisted.hostListFilter ?? {}),
    }));
  const [activePresetId, setActivePresetId] = useState<string | null>(
    initialPersisted.activePresetId
  );
  const [customPresets, setCustomPresets] = useState<FilterPreset[]>(() =>
    loadPersistedState<FilterPreset[]>(LS_CUSTOM_PRESETS_KEY, [])
  );

  // Ring Buffer Session Retention Limit (null = All Sessions; default = 10,000) & Drop Non-Matching on Capture
  const [sessionRetentionLimit, setSessionRetentionLimitState] = useState<
    number | null
  >(() => loadPersistedRetentionLimit());
  const sessionRetentionLimitRef = useRef<number | null>(sessionRetentionLimit);
  sessionRetentionLimitRef.current = sessionRetentionLimit;

  const [dropNonMatching, setDropNonMatchingState] = useState<boolean>(() =>
    loadPersistedState<boolean>(LS_DROP_NON_MATCHING_KEY, false)
  );
  const dropNonMatchingRef = useRef<boolean>(dropNonMatching);
  dropNonMatchingRef.current = dropNonMatching;

  const hasPersistedClearDbOnExitRef = useRef<boolean>(
    typeof window !== "undefined" &&
      (() => {
        try {
          return window.localStorage.getItem(LS_CLEAR_DB_ON_EXIT_KEY) !== null;
        } catch {
          return false;
        }
      })()
  );
  const [clearDbOnExit, setClearDbOnExitState] = useState<boolean>(() =>
    Boolean(
      loadPersistedState<boolean>(
        LS_CLEAR_DB_ON_EXIT_KEY,
        DEFAULT_CLEAR_DB_ON_EXIT
      )
    )
  );
  const clearDbOnExitRef = useRef<boolean>(clearDbOnExit);
  clearDbOnExitRef.current = clearDbOnExit;

  const [storageStats, setStorageStats] = useState<StorageStats>(() => ({
    ramSessions: 0,
    sqliteSizeBytes: 0,
    droppedSessionsCount: 0,
    sessionRetentionLimit,
    dropNonMatching,
  }));

  const [backendFilterConfig, setBackendFilterConfig] =
    useState<ProxyFilterBackendConfig>(() => {
      const saved = loadPersistedState<Partial<ProxyFilterBackendConfig>>(
        LS_BACKEND_FILTER_CFG_KEY,
        structuredClone(DEFAULT_BACKEND_FILTER_CONFIG)
      );
      const bootHostList: HostListFilterConfig = {
        ...DEFAULT_HOST_LIST_FILTER_CONFIG,
        ...(initialPersisted.hostListFilter ?? {}),
      };
      const bootThresholds: NoiseThresholdsConfig = {
        ...DEFAULT_NOISE_THRESHOLDS,
        ...initialPersisted.thresholds,
      };
      const bootCompiled = compileHostListFilter(bootHostList);
      return {
        ...structuredClone(DEFAULT_BACKEND_FILTER_CONFIG),
        ...saved,
        tlsInterceptMode: saved.tlsInterceptMode ?? "interceptAll",
        tlsTargetRules: Array.isArray(saved.tlsTargetRules)
          ? saved.tlsTargetRules
          : [],
        stripAltSvc: saved.stripAltSvc ?? true,
        hostListSync: buildHostListSyncPayload(
          bootHostList,
          bootCompiled.activeCount
        ),
        dropNonMatchingOnCapture: dropNonMatchingRef.current,
        captureHostList: buildCaptureHostListPayload(
          bootHostList,
          bootCompiled.activeCount
        ),
        noiseThresholds: buildNoiseThresholdsSyncPayload(bootThresholds),
        captureMatrixEnabled: initialPersisted.matrixEnabled,
        captureFilterRules: initialPersisted.rules,
        quickCategory: "all",
        filterQuery: "",
        useRegexQuery: false,
      };
    });
  const backendFilterConfigRef =
    useRef<ProxyFilterBackendConfig>(backendFilterConfig);
  backendFilterConfigRef.current = backendFilterConfig;

  // Live Breakpoints Config & Parked Requests Queue
  const [breakpointConfig, setBreakpointConfig] = useState<BreakpointConfig>(
    () => {
      const saved = loadPersistedState<BreakpointConfig>(
        LS_BREAKPOINT_CFG_KEY,
        structuredClone(DEFAULT_BREAKPOINT_CONFIG)
      );
      return {
        ...DEFAULT_BREAKPOINT_CONFIG,
        ...saved,
        // Never stall traffic silently on cold boot via global flags
        breakBeforeRequest: false,
        breakAfterResponse: false,
      };
    }
  );
  const breakpointConfigRef = useRef<BreakpointConfig>(breakpointConfig);
  breakpointConfigRef.current = breakpointConfig;

  const [pausedBreakpoints, setPausedBreakpoints] = useState<
    PausedBreakpointItem[]
  >([]);

  // Persist UI filter state to localStorage
  useEffect(() => {
    try {
      const payload: PersistedFilterState = {
        matrixEnabled,
        rules: filterRules,
        thresholds,
        activePresetId,
        hostListFilter,
      };
      window.localStorage.setItem(
        LS_ACTIVE_FILTER_STATE_KEY,
        JSON.stringify(payload)
      );
    } catch {
      // ignore storage quota errors
    }
  }, [matrixEnabled, filterRules, thresholds, activePresetId, hostListFilter]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LS_CUSTOM_PRESETS_KEY,
        JSON.stringify(customPresets)
      );
    } catch {
      // ignore storage quota errors
    }
  }, [customPresets]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LS_FOLLOW_TAIL_KEY,
        JSON.stringify(followTail)
      );
    } catch {
      // ignore storage quota errors
    }
  }, [followTail]);

  // Synchronize React hook state when a settings profile is imported or reset
  useEffect(() => {
    const handleSettingsApplied = (event: Event) => {
      const detail = (event as CustomEvent<FluxUserSettingsProfile>).detail;
      if (!detail) return;

      setFollowTail(Boolean(detail.ui.followTail));
      setCustomPresets(structuredClone(detail.filters.userPresets));
      setActivePresetId(detail.filters.activePresetId);
      const nextMatrixEnabled = detail.filters.matrixEnabled ?? true;
      const nextFilterRules = structuredClone(detail.filters.filterRules ?? []);
      const nextThresholds = {
        ...DEFAULT_NOISE_THRESHOLDS,
        ...detail.filters.noiseThresholds,
      };
      const nextHostList = {
        ...DEFAULT_HOST_LIST_FILTER_CONFIG,
        ...detail.filters.hostFilters,
      };
      setMatrixEnabled(nextMatrixEnabled);
      setFilterRules(nextFilterRules);
      setThresholds(nextThresholds);
      setHostListFilterState(nextHostList);

      const nextRetention =
        detail.proxy.sessionRetentionLimit !== undefined
          ? detail.proxy.sessionRetentionLimit
          : DEFAULT_SESSION_RETENTION_LIMIT;
      sessionRetentionLimitRef.current = nextRetention;
      setSessionRetentionLimitState(nextRetention);
      setSessions((prev) => {
        if (!nextRetention || prev.length <= nextRetention) return prev;
        const copy = prev.slice();
        copy.splice(0, copy.length - nextRetention);
        return copy;
      });

      const nextDropNonMatching = Boolean(
        detail.proxy.dropNonMatching ?? false
      );
      dropNonMatchingRef.current = nextDropNonMatching;
      setDropNonMatchingState(nextDropNonMatching);

      const nextClearDbOnExit = Boolean(
        detail.proxy.clearDbOnExit ?? DEFAULT_CLEAR_DB_ON_EXIT
      );
      clearDbOnExitRef.current = nextClearDbOnExit;
      setClearDbOnExitState(nextClearDbOnExit);

      const compiledHl = compileHostListFilter(nextHostList);
      const nextBackendCfg: ProxyFilterBackendConfig = {
        tlsInterceptMode: detail.proxy.tlsInterceptMode,
        tlsBypassEnabled: detail.proxy.tlsBypassEnabled ?? true,
        tlsBypassRules: structuredClone(detail.proxy.tlsBypassRules),
        tlsTargetRules: structuredClone(detail.proxy.tlsTargetRules),
        headerMutationsEnabled: detail.proxy.headerMutationsEnabled ?? true,
        headerMutations: structuredClone(detail.proxy.headerMutations),
        stripAltSvc: detail.proxy.stripAltSvc ?? true,
        hostListSync: buildHostListSyncPayload(
          nextHostList,
          compiledHl.activeCount
        ),
        dropNonMatchingOnCapture: nextDropNonMatching,
        captureHostList: buildCaptureHostListPayload(
          nextHostList,
          compiledHl.activeCount
        ),
        noiseThresholds: buildNoiseThresholdsSyncPayload(nextThresholds),
        captureMatrixEnabled: nextMatrixEnabled,
        captureFilterRules: nextFilterRules,
        quickCategory: "all",
        filterQuery: "",
        useRegexQuery: false,
      };
      backendFilterConfigRef.current = nextBackendCfg;
      setBackendFilterConfig(nextBackendCfg);
      setFilterQuery("");
      setUseRegex(false);
      setQuickCategory("all");

      const detailBindMode: BindHostMode =
        detail.proxy.bindMode ??
        (detail.proxy.allowRemote ? "all" : "loopback");
      const detailSpecificIp = detail.proxy.specificBindIp ?? null;
      const detailAlsoLoopback = detail.proxy.alsoBindLoopback ?? true;
      const detailBindAddr =
        detailBindMode === "all"
          ? "0.0.0.0"
          : detailBindMode === "specific" && detailSpecificIp
            ? detailSpecificIp
            : "127.0.0.1";

      const nextStatusOptimistic: ProxyStatus = {
        ...statusRef.current,
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
      statusRef.current = nextStatusOptimistic;
      setStatus(nextStatusOptimistic);

      if (detail.breakpoints) {
        const nextBp: BreakpointConfig = {
          ...DEFAULT_BREAKPOINT_CONFIG,
          ...detail.breakpoints,
          rules: structuredClone(detail.breakpoints.rules ?? []),
        };
        breakpointConfigRef.current = nextBp;
        setBreakpointConfig(nextBp);
      }
    };

    const handleProxyStatusSynced = (event: Event) => {
      const nextStatus = (event as CustomEvent<ProxyStatus>).detail;
      if (!nextStatus) return;
      statusRef.current = nextStatus;
      setStatus(nextStatus);
    };

    window.addEventListener(SETTINGS_APPLIED_EVENT, handleSettingsApplied);
    window.addEventListener(
      PROXY_STATUS_SYNCED_EVENT,
      handleProxyStatusSynced
    );
    return () => {
      window.removeEventListener(SETTINGS_APPLIED_EVENT, handleSettingsApplied);
      window.removeEventListener(
        PROXY_STATUS_SYNCED_EVENT,
        handleProxyStatusSynced
      );
    };
  }, []);

  // Coalesce high-frequency Rust IPC batches to animation frames
  const pendingQueueRef = useRef<SessionSummary[]>([]);
  const rafHandleRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3200);
  }, []);

  const lastStorageStatsSyncRef = useRef<number>(0);

  const applyStorageStats = useCallback((nextStats: StorageStats) => {
    lastStorageStatsSyncRef.current = Date.now();
    setStorageStats((prev) => {
      if (
        prev.ramSessions === nextStats.ramSessions &&
        prev.sqliteSizeBytes === nextStats.sqliteSizeBytes &&
        prev.droppedSessionsCount === nextStats.droppedSessionsCount &&
        prev.sessionRetentionLimit === nextStats.sessionRetentionLimit &&
        prev.dropNonMatching === nextStats.dropNonMatching
      ) {
        return prev;
      }
      return nextStats;
    });
  }, []);

  const refreshStorageStats = useCallback(async () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }
    try {
      const nextStats = await proxyBridge.getMemoryStorageStats();
      applyStorageStats(nextStats);
    } catch {
      // ignore transient IPC poll error
    }
  }, [applyStorageStats]);

  const applyProxyStatusUpdate = useCallback(
    (next: ProxyStatus) => {
      const prev = statusRef.current;

      if (
        next.systemProxyError &&
        next.systemProxyError !== prev.systemProxyError
      ) {
        showToast(`⚠️ ${next.systemProxyError}`);
      } else if (
        prev.systemProxyEnabled &&
        !next.systemProxyEnabled &&
        prev.running &&
        next.running &&
        next.autoSystemProxy
      ) {
        showToast("⚠️ Системный прокси ОС был сброшен внешней программой");
      }

      statusRef.current = next;
      setStatus((curr) => {
        const sameBoundIps =
          (curr.boundIps?.length ?? 0) === (next.boundIps?.length ?? 0) &&
          (curr.boundIps ?? []).every((ip, idx) => ip === next.boundIps?.[idx]);
        if (
          curr.running === next.running &&
          curr.bindAddr === next.bindAddr &&
          curr.port === next.port &&
          curr.activeSessions === next.activeSessions &&
          curr.systemProxyEnabled === next.systemProxyEnabled &&
          curr.autoSystemProxy === next.autoSystemProxy &&
          Boolean(curr.allowRemote) === Boolean(next.allowRemote) &&
          curr.bindMode === next.bindMode &&
          (curr.specificBindIp ?? null) === (next.specificBindIp ?? null) &&
          Boolean(curr.alsoBindLoopback ?? true) ===
            Boolean(next.alsoBindLoopback ?? true) &&
          sameBoundIps &&
          (curr.systemProxyError ?? null) === (next.systemProxyError ?? null)
        ) {
          return curr;
        }
        return next;
      });
    },
    [showToast]
  );

  const flushPendingSessions = useCallback(() => {
    rafHandleRef.current = null;
    const incoming = pendingQueueRef.current;
    if (incoming.length === 0) return;
    pendingQueueRef.current = [];

    setSessions((prev) => {
      // Fast O(N) merge supporting both append of new sessions and in-place updates (e.g. WebSocket frames / TLS Bypass byte totals),
      // including deduplication when multiple events for the same ID arrive in the very first batch.
      const indexById = new Map<number, number>();
      const next = prev.slice();
      for (let i = 0; i < next.length; i++) {
        indexById.set(next[i].id, i);
      }
      for (const item of incoming) {
        const existingIdx = indexById.get(item.id);
        if (existingIdx !== undefined) {
          next[existingIdx] = item;
        } else {
          indexById.set(item.id, next.length);
          next.push(item);
        }
      }
      const limit = sessionRetentionLimitRef.current;
      if (limit && next.length > limit) {
        next.splice(0, next.length - limit);
      }
      return next;
    });
    if (
      (typeof document === "undefined" ||
        document.visibilityState !== "hidden") &&
      Date.now() - lastStorageStatsSyncRef.current >= 1000
    ) {
      void refreshStorageStats();
    }
  }, [refreshStorageStats]);

  // Initial load + Sync backend filter config (TLS Bypass + Header Mutations + Ring Buffer + Drop Non-Matching) + Real-time Tauri IPC subscription
  useEffect(() => {
    let mounted = true;
    let unlistenFn: (() => void) | null = null;
    let unlistenRemovedFn: (() => void) | null = null;
    let unlistenBpFn: (() => void) | null = null;
    let unlistenStatusFn: (() => void) | null = null;
    let unlistenStatsFn: (() => void) | null = null;

    async function safeIpc<T>(
      label: string,
      fn: () => Promise<T>,
      fallback: T
    ): Promise<T> {
      try {
        return await fn();
      } catch (err) {
        console.warn(`bootstrap: ${label} failed`, err);
        return fallback;
      }
    }

    async function bootstrap() {
      // Push persisted retention limit, dropNonMatching, TLS Bypass, Header Mutation & Breakpoint rules into Rust / Preview engine on boot
      await safeIpc(
        "setSessionRetentionLimit",
        () =>
          proxyBridge.setSessionRetentionLimit(
            sessionRetentionLimitRef.current
          ),
        undefined
      );
      const [syncedCfg, syncedBpCfg, initialPaused] = await Promise.all([
        safeIpc(
          "updateFilterBackendConfig",
          () =>
            proxyBridge.updateFilterBackendConfig({
              ...backendFilterConfigRef.current,
              dropNonMatchingOnCapture: dropNonMatchingRef.current,
            }),
          backendFilterConfigRef.current
        ),
        safeIpc(
          "updateBreakpointConfig",
          () => proxyBridge.updateBreakpointConfig(breakpointConfigRef.current),
          breakpointConfigRef.current
        ),
        safeIpc(
          "listPausedBreakpoints",
          () => proxyBridge.listPausedBreakpoints(),
          [] as PausedBreakpointItem[]
        ),
      ]);
      await safeIpc(
        "setDropNonMatching",
        () => proxyBridge.setDropNonMatching(dropNonMatchingRef.current),
        undefined
      );
      if (hasPersistedClearDbOnExitRef.current) {
        await safeIpc(
          "setClearDbOnExit",
          () => proxyBridge.setClearDbOnExit(clearDbOnExitRef.current),
          clearDbOnExitRef.current
        );
      } else {
        try {
          const backendClearOnExit = await proxyBridge.getClearDbOnExit();
          const resolvedClearOnExit = await safeIpc(
            "setClearDbOnExit",
            () => proxyBridge.setClearDbOnExit(backendClearOnExit),
            backendClearOnExit
          );
          clearDbOnExitRef.current = resolvedClearOnExit;
          setClearDbOnExitState(resolvedClearOnExit);
          try {
            window.localStorage.setItem(
              LS_CLEAR_DB_ON_EXIT_KEY,
              JSON.stringify(resolvedClearOnExit)
            );
          } catch {
            // ignore storage quota errors
          }
        } catch (err) {
          console.warn("bootstrap: getClearDbOnExit failed", err);
        }
      }
      const [initialStatus, initialSessions, initialStats] = await Promise.all([
        safeIpc("getStatus", () => proxyBridge.getStatus(), statusRef.current),
        safeIpc(
          "getSessions",
          () => proxyBridge.getSessions(),
          [] as SessionSummary[]
        ),
        safeIpc(
          "getMemoryStorageStats",
          () => proxyBridge.getMemoryStorageStats(),
          null as StorageStats | null
        ),
      ]);
      let effectiveStatus = initialStatus;
      if (
        initialAutoSysProxy !== null &&
        initialStatus.autoSystemProxy !== initialAutoSysProxy
      ) {
        try {
          effectiveStatus = await proxyBridge.setAutoSystemProxy(
            initialAutoSysProxy
          );
          if (!initialAutoSysProxy && effectiveStatus.systemProxyEnabled) {
            try {
              effectiveStatus = await proxyBridge.setSystemProxy(false);
            } catch (err) {
              console.warn("bootstrap: setSystemProxy(false) failed", err);
            }
          }
        } catch (err) {
          console.warn("bootstrap: setAutoSystemProxy failed", err);
        }
      }
      if (initialBindConfig !== null) {
        const effMode: BindHostMode =
          effectiveStatus.bindMode ??
          (effectiveStatus.allowRemote ||
          effectiveStatus.bindAddr === "0.0.0.0"
            ? "all"
            : "loopback");
        const effSpecificIp = effectiveStatus.specificBindIp ?? null;
        const effAlsoLoopback = effectiveStatus.alsoBindLoopback ?? true;
        if (
          effMode !== initialBindConfig.bindMode ||
          (initialBindConfig.bindMode === "specific" &&
            effSpecificIp !== initialBindConfig.specificBindIp) ||
          effAlsoLoopback !== initialBindConfig.alsoBindLoopback
        ) {
          try {
            effectiveStatus = await proxyBridge.setBindConfiguration(
              initialBindConfig.bindMode,
              initialBindConfig.specificBindIp,
              initialBindConfig.alsoBindLoopback
            );
          } catch (err) {
            console.warn("bootstrap: setBindConfiguration failed", err);
            if (initialBindConfig.bindMode === "specific") {
              try {
                effectiveStatus = await proxyBridge.setBindConfiguration(
                  "loopback",
                  null,
                  true
                );
              } catch (fallbackErr) {
                console.warn(
                  "bootstrap: fallback setBindConfiguration(loopback) failed",
                  fallbackErr
                );
                effectiveStatus = {
                  ...effectiveStatus,
                  bindAddr: "127.0.0.1",
                  bindMode: "loopback",
                  specificBindIp: null,
                  alsoBindLoopback: true,
                  allowRemote: false,
                  boundIps: ["127.0.0.1"],
                };
              }
              if (mounted) {
                showToast(
                  `⚠️ Не удалось привязать адрес ${
                    initialBindConfig.specificBindIp ?? "specific"
                  } — выполнен откат к 127.0.0.1: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                );
              }
            } else if (mounted) {
              showToast(
                `⚠️ Не удалось применить конфигурацию сети (${
                  initialBindConfig.bindMode
                }): ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        }
      }
      if (initialPort !== null && effectiveStatus.port !== initialPort) {
        const backendPort = effectiveStatus.port;
        if (effectiveStatus.running) {
          try {
            await proxyBridge.stopProxy();
            effectiveStatus = await proxyBridge.startProxy(
              undefined,
              initialPort
            );
          } catch (err) {
            try {
              effectiveStatus = await proxyBridge.startProxy(
                undefined,
                backendPort
              );
            } catch {
              // keep best-known status if fallback restart also fails
            }
            if (mounted) {
              showToast(
                `⚠️ Не удалось занять стартовый порт ${initialPort}, оставлен ${effectiveStatus.port}: ${
                  err instanceof Error ? err.message : String(err)
                }`
              );
            }
          }
        } else {
          try {
            effectiveStatus = await proxyBridge.setPreviewPort(initialPort);
          } catch (err) {
            if (mounted) {
              showToast(
                `⚠️ Не удалось установить стартовый порт ${initialPort}: ${
                  err instanceof Error ? err.message : String(err)
                }`
              );
            }
          }
        }
      }
      try {
        window.localStorage.setItem(
          LS_AUTO_SYSPROXY_KEY,
          JSON.stringify(effectiveStatus.autoSystemProxy)
        );
        persistBindConfigToLocalStorage(effectiveStatus);
        window.localStorage.setItem(
          LS_PROXY_PORT_KEY,
          JSON.stringify(effectiveStatus.port)
        );
      } catch {
        // ignore storage quota errors
      }

      if (!mounted) return;
      setBackendFilterConfig(syncedCfg);
      setBreakpointConfig(syncedBpCfg);
      setPausedBreakpoints(initialPaused);
      if (initialStats !== null) {
        applyStorageStats(initialStats);
      }
      statusRef.current = effectiveStatus;
      setStatus(effectiveStatus);
      if (effectiveStatus.systemProxyError) {
        showToast(`⚠️ ${effectiveStatus.systemProxyError}`);
      }
      const limit = sessionRetentionLimitRef.current;
      const cappedInitial = initialSessions.slice();
      if (limit && cappedInitial.length > limit) {
        cappedInitial.splice(0, cappedInitial.length - limit);
      }
      setSessions(cappedInitial);
      if (cappedInitial.length > 0) {
        setSelectedId(cappedInitial[0].id);
      }

      try {
        const unlistenBatches = await proxyBridge.subscribeSessionBatches(
          (batch) => {
            if (!mounted) return;
            pendingQueueRef.current.push(...batch);
            if (rafHandleRef.current === null) {
              rafHandleRef.current = window.requestAnimationFrame(
                flushPendingSessions
              );
            }
          }
        );
        if (!mounted) {
          unlistenBatches();
          return;
        }
        unlistenFn = unlistenBatches;
      } catch (err) {
        console.warn("bootstrap: subscribeSessionBatches failed", err);
      }

      try {
        const unlistenRemoved = await proxyBridge.subscribeSessionsRemoved(
          (removedIds) => {
            if (!mounted || removedIds.length === 0) return;
            const removedSet = new Set(removedIds);
            if (pendingQueueRef.current.length > 0) {
              pendingQueueRef.current = pendingQueueRef.current.filter(
                (item) => !removedSet.has(item.id)
              );
            }
            setSessions((prev) => {
              const next = prev.filter((item) => !removedSet.has(item.id));
              return next.length === prev.length ? prev : next;
            });
            setSelectedIds((prev) => {
              const next = prev.filter((id) => !removedSet.has(id));
              return next.length === prev.length ? prev : next;
            });
            if (
              selectionAnchorIdRef.current !== null &&
              removedSet.has(selectionAnchorIdRef.current)
            ) {
              selectionAnchorIdRef.current = null;
            }
            setSelectedIdState((prev) =>
              prev !== null && removedSet.has(prev) ? null : prev
            );
          }
        );
        if (!mounted) {
          unlistenRemoved();
          return;
        }
        unlistenRemovedFn = unlistenRemoved;
      } catch (err) {
        console.warn("bootstrap: subscribeSessionsRemoved failed", err);
      }

      try {
        const unlistenBp = await proxyBridge.subscribeBreakpointsChanged(
          (items) => {
            if (!mounted) return;
            setPausedBreakpoints(items);
          }
        );
        if (!mounted) {
          unlistenBp();
          return;
        }
        unlistenBpFn = unlistenBp;
      } catch (err) {
        console.warn("bootstrap: subscribeBreakpointsChanged failed", err);
      }

      try {
        const unlistenStatus = await proxyBridge.subscribeStatusChanged(
          (nextStatus) => {
            if (!mounted) return;
            applyProxyStatusUpdate(nextStatus);
          }
        );
        if (!mounted) {
          unlistenStatus();
          return;
        }
        unlistenStatusFn = unlistenStatus;
      } catch (err) {
        console.warn("bootstrap: subscribeStatusChanged failed", err);
      }

      try {
        const unlistenStats = await proxyBridge.subscribeStorageStatsChanged(
          (nextStats) => {
            if (!mounted) return;
            applyStorageStats(nextStats);
          }
        );
        if (!mounted) {
          unlistenStats();
          return;
        }
        unlistenStatsFn = unlistenStats;
      } catch (err) {
        console.warn("bootstrap: subscribeStorageStatsChanged failed", err);
      }
    }

    void bootstrap();

    return () => {
      mounted = false;
      if (unlistenFn) unlistenFn();
      if (unlistenRemovedFn) unlistenRemovedFn();
      if (unlistenBpFn) unlistenBpFn();
      if (unlistenStatusFn) unlistenStatusFn();
      if (unlistenStatsFn) unlistenStatsFn();
      if (rafHandleRef.current !== null) {
        window.cancelAnimationFrame(rafHandleRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushPendingSessions]);

  // Low-frequency fallback reconciliation when tab is visible (primary updates arrive via push events)
  useEffect(() => {
    let active = true;

    const reconcileStatus = async () => {
      try {
        const next = await proxyBridge.getStatus();
        if (!active) return;
        applyProxyStatusUpdate(next);
      } catch {
        // ignore transient IPC poll error
      }
    };

    const reconcileAll = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      void refreshStorageStats();
      void reconcileStatus();
    };

    const intervalId = window.setInterval(reconcileAll, 15_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        reconcileAll();
      }
    };
    const onWindowFocus = () => {
      reconcileAll();
    };
    window.addEventListener("focus", onWindowFocus);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onWindowFocus);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [applyProxyStatusUpdate, refreshStorageStats]);

  const selectedSummarySignature = useMemo(() => {
    if (selectedId === null) return "";
    const found = sessions.find((s) => s.id === selectedId);
    if (!found) return "";
    return `${found.status}:${found.bodySize}:${found.durationMs}:${found.contentType}:${found.error ?? ""}:${found.breakpointPaused ?? ""}:${found.breakpointModified ? "1" : "0"}:${found.comment ?? ""}:${found.markedColor ?? ""}`;
  }, [selectedId, sessions]);

  const selectedIdRef = useRef<number | null>(selectedId);
  selectedIdRef.current = selectedId;

  // Fetch full SessionDetail on-demand when selected row changes or updates in-place
  useEffect(() => {
    let active = true;
    const targetId = selectedId;
    if (targetId === null) {
      setSelectedDetail(null);
      return;
    }
    setSelectedDetail((prev) =>
      prev && prev.summary.id === targetId ? prev : null
    );
    void proxyBridge
      .getSessionDetail(targetId)
      .then((detail) => {
        if (!active || selectedIdRef.current !== targetId) return;
        setSelectedDetail(detail);
      })
      .catch((err) => {
        if (!active || selectedIdRef.current !== targetId) return;
        setSelectedDetail(null);
        showToast(
          `⚠️ Ошибка загрузки деталей сессии #${targetId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    return () => {
      active = false;
    };
  }, [selectedId, selectedSummarySignature, showToast]);

  const diffLeftId = selectedIds.length >= 2 ? selectedIds[0] : null;
  const diffRightId = selectedIds.length >= 2 ? selectedIds[1] : null;

  const diffPairSignature = useMemo(() => {
    if (diffLeftId === null || diffRightId === null) return "";
    const l = sessions.find((s) => s.id === diffLeftId);
    const r = sessions.find((s) => s.id === diffRightId);
    const sig = (s?: SessionSummary) =>
      s
        ? `${s.status}:${s.bodySize}:${s.durationMs}:${s.contentType}:${s.error ?? ""}:${s.comment ?? ""}:${s.markedColor ?? ""}`
        : "none";
    return `${diffLeftId}(${sig(l)})|${diffRightId}(${sig(r)})`;
  }, [diffLeftId, diffRightId, sessions]);

  // Fetch full SessionDetails for both compared sessions when 2+ rows are selected
  useEffect(() => {
    let active = true;
    if (diffLeftId === null || diffRightId === null) {
      setDiffLeftDetail(null);
      setDiffRightDetail(null);
      return;
    }
    const targetLeft = diffLeftId;
    const targetRight = diffRightId;
    setDiffLeftDetail((prev) =>
      prev && prev.summary.id === targetLeft ? prev : null
    );
    setDiffRightDetail((prev) =>
      prev && prev.summary.id === targetRight ? prev : null
    );
    void Promise.all([
      proxyBridge.getSessionDetail(targetLeft),
      proxyBridge.getSessionDetail(targetRight),
    ])
      .then(([left, right]) => {
        if (!active) return;
        setDiffLeftDetail(left);
        setDiffRightDetail(right);
      })
      .catch((err) => {
        if (!active) return;
        setDiffLeftDetail(null);
        setDiffRightDetail(null);
        showToast(
          `⚠️ Ошибка загрузки сессий для сравнения: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    return () => {
      active = false;
    };
  }, [diffLeftId, diffRightId, diffPairSignature, showToast]);

  const updateBackendFilterConfig = useCallback(
    async (next: ProxyFilterBackendConfig) => {
      backendFilterConfigRef.current = next;
      setBackendFilterConfig(next);
      try {
        window.localStorage.setItem(
          LS_BACKEND_FILTER_CFG_KEY,
          JSON.stringify(next)
        );
      } catch {
        // ignore
      }
      const saved = await proxyBridge.updateFilterBackendConfig(next);
      backendFilterConfigRef.current = saved;
      setBackendFilterConfig(saved);
    },
    []
  );

  const allPresets = useMemo(
    () => [...BUILT_IN_FILTER_PRESETS, ...customPresets],
    [customPresets]
  );

  const activePreset = useMemo(
    () => allPresets.find((p) => p.id === activePresetId) ?? null,
    [allPresets, activePresetId]
  );

  const compiledMatrix = useMemo(
    () => compileFilterMatrix(filterRules),
    [filterRules]
  );

  const compiledHostList = useMemo(
    () => compileHostListFilter(hostListFilter),
    [hostListFilter]
  );

  // Unified sync of Bulk Hosts List (TLS Passthrough) + Capture Filters (Hosts List, Thresholds, Matrix, Quick Category & Search Query) to Rust ProxyFilterEngine
  const lastSyncedHostListFlagsRef = useRef({
    enabled: hostListFilter.enabled,
    mode: hostListFilter.mode,
    applyToTlsPassthrough: hostListFilter.applyToTlsPassthrough,
  });

  useEffect(() => {
    const desiredHostListSync = buildHostListSyncPayload(
      hostListFilter,
      compiledHostList.activeCount
    );
    const desiredCaptureHl = buildCaptureHostListPayload(
      hostListFilter,
      compiledHostList.activeCount
    );
    const desiredThresholds = buildNoiseThresholdsSyncPayload(thresholds);
    const curr = backendFilterConfigRef.current;

    const prevFlags = lastSyncedHostListFlagsRef.current;
    const structuralHostListChange =
      prevFlags.enabled !== hostListFilter.enabled ||
      prevFlags.mode !== hostListFilter.mode ||
      prevFlags.applyToTlsPassthrough !== hostListFilter.applyToTlsPassthrough;

    lastSyncedHostListFlagsRef.current = {
      enabled: hostListFilter.enabled,
      mode: hostListFilter.mode,
      applyToTlsPassthrough: hostListFilter.applyToTlsPassthrough,
    };

    const sameHostListSync =
      (!desiredHostListSync.enabled && !curr.hostListSync?.enabled) ||
      Boolean(
        curr.hostListSync &&
          curr.hostListSync.enabled === desiredHostListSync.enabled &&
          curr.hostListSync.mode === desiredHostListSync.mode &&
          curr.hostListSync.rawText === desiredHostListSync.rawText
      );
    const sameCaptureHl =
      curr.captureHostList?.enabled === desiredCaptureHl.enabled &&
      curr.captureHostList?.mode === desiredCaptureHl.mode &&
      curr.captureHostList?.rawText === desiredCaptureHl.rawText;
    const sameThresholds =
      JSON.stringify(curr.noiseThresholds) ===
      JSON.stringify(desiredThresholds);
    const sameMatrix =
      curr.captureMatrixEnabled === matrixEnabled &&
      JSON.stringify(curr.captureFilterRules ?? []) ===
        JSON.stringify(filterRules);
    const sameQuick =
      (curr.quickCategory ?? "all") === quickCategory &&
      (curr.filterQuery ?? "") === filterQuery &&
      Boolean(curr.useRegexQuery) === useRegex &&
      Boolean(curr.dropNonMatchingOnCapture) === dropNonMatching;

    if (
      sameHostListSync &&
      sameCaptureHl &&
      sameThresholds &&
      sameMatrix &&
      sameQuick
    ) {
      return;
    }

    const pushUnifiedFilterConfig = () => {
      void updateBackendFilterConfig({
        ...backendFilterConfigRef.current,
        hostListSync: desiredHostListSync,
        dropNonMatchingOnCapture: dropNonMatching,
        captureHostList: desiredCaptureHl,
        noiseThresholds: desiredThresholds,
        captureMatrixEnabled: matrixEnabled,
        captureFilterRules: filterRules,
        quickCategory,
        filterQuery,
        useRegexQuery: useRegex,
      }).catch((err) => {
        showToast(
          `⚠️ Ошибка синхронизации фильтров с движком: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    };

    if (
      !sameHostListSync &&
      (structuralHostListChange || !desiredHostListSync.enabled)
    ) {
      pushUnifiedFilterConfig();
      return;
    }

    const timerId = window.setTimeout(pushUnifiedFilterConfig, 150);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [
    dropNonMatching,
    hostListFilter,
    compiledHostList.activeCount,
    thresholds,
    matrixEnabled,
    filterRules,
    quickCategory,
    filterQuery,
    useRegex,
    updateBackendFilterConfig,
    showToast,
  ]);

  const setSessionRetentionLimit = useCallback(
    async (limit: number | null) => {
      if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
        showToast("⚠️ Лимит сессий должен быть целым числом больше 0");
        return;
      }
      sessionRetentionLimitRef.current = limit;
      setSessionRetentionLimitState(limit);
      try {
        window.localStorage.setItem(
          LS_RETENTION_LIMIT_KEY,
          JSON.stringify(limit)
        );
      } catch {
        // ignore storage quota errors
      }

      // Immediately truncate in-memory sessions grid to `limit` (FIFO)
      setSessions((prev) => {
        if (!limit || prev.length <= limit) return prev;
        const next = prev.slice();
        next.splice(0, next.length - limit);
        return next;
      });

      await proxyBridge.setSessionRetentionLimit(limit);
      await refreshStorageStats();
      showToast(
        limit === null
          ? "♾️ Keep: All Sessions (кольцевой лимит снят)"
          : `🔄 Keep: ${limit.toLocaleString()} сессий (FIFO кольцевой буфер)`
      );
    },
    [refreshStorageStats, showToast]
  );

  const setDropNonMatching = useCallback(
    async (enabled: boolean) => {
      dropNonMatchingRef.current = enabled;
      setDropNonMatchingState(enabled);
      try {
        window.localStorage.setItem(
          LS_DROP_NON_MATCHING_KEY,
          JSON.stringify(enabled)
        );
      } catch {
        // ignore storage quota errors
      }

      const nextCfg: ProxyFilterBackendConfig = {
        ...backendFilterConfigRef.current,
        dropNonMatchingOnCapture: enabled,
        captureHostList: buildCaptureHostListPayload(
          hostListFilter,
          compiledHostList.activeCount
        ),
        noiseThresholds: buildNoiseThresholdsSyncPayload(thresholds),
        captureMatrixEnabled: matrixEnabled,
        captureFilterRules: filterRules,
        quickCategory,
        filterQuery,
        useRegexQuery: useRegex,
      };
      await Promise.all([
        proxyBridge.setDropNonMatching(enabled),
        updateBackendFilterConfig(nextCfg),
      ]);
      await refreshStorageStats();
      showToast(
        enabled
          ? "🛡️ Drop Non-Matching ВКЛЮЧЁН — отсеянный трафик и системный шум не попадают в RAM"
          : "Drop Non-Matching отключён — прокси сохраняет все перехваченные сессии"
      );
    },
    [
      hostListFilter,
      compiledHostList.activeCount,
      thresholds,
      matrixEnabled,
      filterRules,
      quickCategory,
      filterQuery,
      useRegex,
      updateBackendFilterConfig,
      refreshStorageStats,
      showToast,
    ]
  );

  const toggleDropNonMatching = useCallback(async () => {
    await setDropNonMatching(!dropNonMatchingRef.current);
  }, [setDropNonMatching]);

  const setClearDbOnExit = useCallback(
    async (enabled: boolean) => {
      const next = Boolean(enabled);
      clearDbOnExitRef.current = next;
      setClearDbOnExitState(next);
      try {
        window.localStorage.setItem(
          LS_CLEAR_DB_ON_EXIT_KEY,
          JSON.stringify(next)
        );
      } catch {
        // ignore storage quota errors
      }
      const confirmed = await proxyBridge.setClearDbOnExit(next);
      clearDbOnExitRef.current = confirmed;
      setClearDbOnExitState(confirmed);
      showToast(
        confirmed
          ? "🧹 Автоочистка SQLite при выходе (Clear DB on App Exit) включена"
          : "Автоочистка SQLite при выходе отключена"
      );
      return confirmed;
    },
    [showToast]
  );

  const clearSqliteDatabase = useCallback(async (): Promise<StorageStats> => {
    try {
      const stats = await proxyBridge.clearSqliteDatabase();
      setStorageStats(stats);
      showToast(
        `🗜️ Архив SQLite очищен и сжат (VACUUM) • Размер на диске: ${(
          stats.sqliteSizeBytes /
          (1024 * 1024)
        ).toFixed(2)} MB`
      );
      return stats;
    } catch (err) {
      showToast(
        `⚠️ Ошибка очистки SQLite: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      throw err;
    }
  }, [showToast]);

  const detectedProcesses = useMemo<DetectedProcessItem[]>(() => {
    const map = new Map<string, DetectedProcessItem>();
    for (const s of sessions) {
      if (!s.processName) continue;
      const key = `${s.processName}::${s.processPid ?? ""}`;
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(key, {
          name: s.processName,
          pid: s.processPid ?? null,
          count: 1,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [sessions]);

  const isForceNoCacheActive = useMemo(() => {
    if (!backendFilterConfig.headerMutationsEnabled) return false;
    const reqRule = backendFilterConfig.headerMutations.find(
      (r) => r.id === "hm-nocache-req"
    );
    const respRule = backendFilterConfig.headerMutations.find(
      (r) => r.id === "hm-nocache-resp"
    );
    return Boolean(reqRule?.enabled && respRule?.enabled);
  }, [backendFilterConfig]);

  const activeFilterBadgeCount = useMemo(() => {
    let count = 0;
    if (matrixEnabled) {
      count += filterRules.filter((r) => r.enabled && r.value.trim()).length;
    }
    if (hostListFilter.enabled && compiledHostList.activeCount > 0) {
      count += compiledHostList.activeCount;
    }
    if (thresholds.hide304NotModified) count += 1;
    if (thresholds.hideOptionsPreflight) count += 1;
    if (thresholds.hideConnectTunnels) count += 1;
    if (thresholds.hideStaticAssets) count += 1;
    if (thresholds.minBodySizeBytes !== null) count += 1;
    if (thresholds.maxBodySizeBytes !== null) count += 1;
    if (thresholds.onlySlowRequests) count += 1;
    if (backendFilterConfig.tlsInterceptMode === "targetedOnly") count += 1;
    if (backendFilterConfig.headerMutationsEnabled) {
      count += backendFilterConfig.headerMutations.filter(
        (m) => m.enabled
      ).length;
    }
    return count;
  }, [
    matrixEnabled,
    filterRules,
    hostListFilter.enabled,
    compiledHostList.activeCount,
    thresholds,
    backendFilterConfig,
  ]);

  const { filteredSessions, regexError } = useMemo(() => {
    let compiledQuickRegex: RegExp | null = null;
    const trimmed = filterQuery.trim();

    if (trimmed && useRegex) {
      try {
        compiledQuickRegex = new RegExp(trimmed, "i");
      } catch (err) {
        return {
          filteredSessions: sessions,
          regexError: err instanceof Error ? err.message : "Invalid RegExp",
        };
      }
    }

    const qLower = trimmed.toLowerCase();

    const result = sessions.filter((s) => {
      const isInFlight = s.status === 0 && !s.error && !s.tlsBypassed;
      // 1. Quick Category Bar
      if (quickCategory !== "all") {
        const tone = getRowSemanticTone(s);
        if (quickCategory === "json" && !isInFlight && tone !== "json") {
          return false;
        }
        if (quickCategory === "images" && !isInFlight && tone !== "image") {
          return false;
        }
        if (quickCategory === "errors" && !isInFlight && tone !== "error") {
          return false;
        }
        if (quickCategory === "ws" && tone !== "ws") return false;
        if (quickCategory === "sse" && !isInFlight && tone !== "sse") {
          return false;
        }
        if (quickCategory === "mocked" && !isInFlight && !s.isMocked) {
          return false;
        }
        if (quickCategory === "marked" && !s.comment && !s.markedColor) {
          return false;
        }
      }

      // 2. Bulk Hosts List + Advanced Filter Matrix + Thresholds + Noise Cleanup
      if (
        !evaluateSessionAgainstFilters(
          s,
          compiledMatrix,
          matrixEnabled,
          thresholds,
          compiledHostList
        )
      ) {
        return false;
      }

      // 3. Quick Search Bar (URL / Host / Method / Status / Content-Type / Process / Comment)
      if (!trimmed) return true;

      if (compiledQuickRegex) {
        return (
          compiledQuickRegex.test(s.url) ||
          compiledQuickRegex.test(s.method) ||
          compiledQuickRegex.test(String(s.status)) ||
          compiledQuickRegex.test(s.contentType) ||
          (s.processName ? compiledQuickRegex.test(s.processName) : false) ||
          (s.clientIp ? compiledQuickRegex.test(s.clientIp) : false) ||
          (s.comment ? compiledQuickRegex.test(s.comment) : false)
        );
      }

      return (
        s.url.toLowerCase().includes(qLower) ||
        s.host.toLowerCase().includes(qLower) ||
        s.method.toLowerCase().includes(qLower) ||
        String(s.status).includes(qLower) ||
        s.contentType.toLowerCase().includes(qLower) ||
        (s.processName ? s.processName.toLowerCase().includes(qLower) : false) ||
        (s.processPid != null ? String(s.processPid).includes(qLower) : false) ||
        (s.clientIp ? s.clientIp.toLowerCase().includes(qLower) : false) ||
        (s.comment ? s.comment.toLowerCase().includes(qLower) : false)
      );
    });

    return { filteredSessions: result, regexError: null };
  }, [
    sessions,
    filterQuery,
    useRegex,
    quickCategory,
    compiledMatrix,
    matrixEnabled,
    thresholds,
    compiledHostList,
  ]);

  const applyPreset = useCallback(
    (presetId: string) => {
      const target = allPresets.find((p) => p.id === presetId);
      if (!target) return;
      setMatrixEnabled(target.matrixEnabled);
      setFilterRules(structuredClone(target.rules));
      setThresholds({ ...DEFAULT_NOISE_THRESHOLDS, ...target.thresholds });
      if (target.hostListFilter) {
        setHostListFilterState({
          ...DEFAULT_HOST_LIST_FILTER_CONFIG,
          ...target.hostListFilter,
        });
      } else if (target.builtIn) {
        setHostListFilterState((prev) => ({ ...prev, enabled: false }));
      }
      setActivePresetId(target.id);
      showToast(`Применен пресет фильтров: «${target.name}»`);
    },
    [allPresets, showToast]
  );

  const saveCustomPreset = useCallback(
    (name: string, description = "Пользовательский пресет фильтров") => {
      const cleanName = name.trim();
      if (!cleanName) return;
      const newPreset: FilterPreset = {
        id: `preset-custom-${Date.now()}`,
        name: cleanName,
        description,
        builtIn: false,
        matrixEnabled,
        rules: structuredClone(filterRules),
        thresholds: { ...thresholds },
        hostListFilter: { ...hostListFilter },
        forceNoCache: isForceNoCacheActive,
      };
      setCustomPresets((prev) => [...prev, newPreset]);
      setActivePresetId(newPreset.id);
      showToast(`Сохранен пресет: «${cleanName}»`);
    },
    [
      matrixEnabled,
      filterRules,
      thresholds,
      hostListFilter,
      isForceNoCacheActive,
      showToast,
    ]
  );

  const deleteCustomPreset = useCallback(
    (presetId: string) => {
      setCustomPresets((prev) => prev.filter((p) => p.id !== presetId));
      setActivePresetId((prev) => (prev === presetId ? null : prev));
      showToast("Пользовательский пресет удален");
    },
    [showToast]
  );

  const resetAdvancedFilters = useCallback(() => {
    setMatrixEnabled(true);
    setFilterRules([]);
    setThresholds({ ...DEFAULT_NOISE_THRESHOLDS });
    setHostListFilterState({ ...DEFAULT_HOST_LIST_FILTER_CONFIG });
    setActivePresetId(null);
    showToast("Все табличные фильтры, список хостов и пороги сброшены");
  }, [showToast]);

  const quickFilterByProcess = useCallback(
    (processName: string, action: "include" | "exclude" = "include") => {
      const clean = processName.trim();
      if (!clean) return;
      setMatrixEnabled(true);
      setActivePresetId(null);
      setFilterRules((prev) => {
        const exists = prev.some(
          (r) =>
            r.enabled &&
            r.action === action &&
            r.field === "processName" &&
            r.operator === "equals" &&
            r.value.toLowerCase() === clean.toLowerCase()
        );
        if (exists) {
          return prev.filter(
            (r) =>
              !(
                r.action === action &&
                r.field === "processName" &&
                r.value.toLowerCase() === clean.toLowerCase()
              )
          );
        }
        return [
          ...prev,
          {
            id: `f-proc-${Date.now()}`,
            enabled: true,
            action,
            logicalOp: "OR",
            field: "processName",
            operator: "equals",
            value: clean,
          },
        ];
      });
      showToast(
        action === "include"
          ? `Фильтр процесса: показывать ${clean}`
          : `Фильтр процесса: скрыть ${clean}`
      );
    },
    [showToast]
  );

  const quickFilterByClientIp = useCallback(
    (clientIp: string, action: "include" | "exclude" = "include") => {
      const clean = clientIp.trim();
      if (!clean) return;
      setMatrixEnabled(true);
      setActivePresetId(null);
      setFilterRules((prev) => {
        const exists = prev.some(
          (r) =>
            r.enabled &&
            r.action === action &&
            r.field === "clientIp" &&
            r.operator === "equals" &&
            r.value.toLowerCase() === clean.toLowerCase()
        );
        if (exists) {
          return prev.filter(
            (r) =>
              !(
                r.action === action &&
                r.field === "clientIp" &&
                r.value.toLowerCase() === clean.toLowerCase()
              )
          );
        }
        return [
          ...prev,
          {
            id: `f-ip-${Date.now()}`,
            enabled: true,
            action,
            logicalOp: "OR",
            field: "clientIp",
            operator: "equals",
            value: clean,
          },
        ];
      });
      showToast(
        action === "include"
          ? `📱 Фильтр устройства: показывать трафик с ${clean}`
          : `Фильтр устройства: скрыть ${clean}`
      );
    },
    [showToast]
  );

  const setTlsInterceptMode = useCallback(
    async (mode: TlsInterceptMode) => {
      if (backendFilterConfig.tlsInterceptMode === mode) return;
      const next: ProxyFilterBackendConfig = {
        ...backendFilterConfig,
        tlsInterceptMode: mode,
      };
      await updateBackendFilterConfig(next);
      showToast(
        mode === "targetedOnly"
          ? "🎯 Mode: Targeted Only (Allowlist) — расшифровываются только целевые хосты, остальное уходит в чистый TCP-туннель"
          : "🌐 Mode: Intercept All — расшифровка всего трафика, кроме списка исключений (Bypass)"
      );
    },
    [backendFilterConfig, updateBackendFilterConfig, showToast]
  );

  const toggleTlsInterceptMode = useCallback(async () => {
    const nextMode: TlsInterceptMode =
      backendFilterConfig.tlsInterceptMode === "targetedOnly"
        ? "interceptAll"
        : "targetedOnly";
    await setTlsInterceptMode(nextMode);
  }, [backendFilterConfig.tlsInterceptMode, setTlsInterceptMode]);

  const quickAlwaysInspectHost = useCallback(
    async (hostOrPattern: string) => {
      const parsed = normalizeHostToken(hostOrPattern);
      if (!parsed) return;
      const cleanTarget = parsed.token.includes("*")
        ? parsed.token
        : parsed.token.split(":")[0];
      if (!cleanTarget) return;

      // 1. Remove any `!cleanTarget` exclusion from `tlsTargetRules`, and ensure `cleanTarget` is enabled in `tlsTargetRules`
      let nextTargetRules: TlsBypassRule[] = (
        backendFilterConfig.tlsTargetRules ?? []
      )
        .map((r) => {
          const remaining = r.pattern
            .split(",")
            .map((t) => t.trim())
            .filter(
              (t) => t && t.toLowerCase() !== `!${cleanTarget}`
            );
          return { ...r, pattern: remaining.join(", ") };
        })
        .filter((r) => r.pattern.length > 0);

      const existingTargetIdx = nextTargetRules.findIndex((r) =>
        r.pattern
          .split(",")
          .some((t) => normalizeHostToken(t)?.token === cleanTarget && !t.trim().startsWith("!"))
      );
      if (existingTargetIdx >= 0) {
        nextTargetRules[existingTargetIdx] = {
          ...nextTargetRules[existingTargetIdx],
          enabled: true,
        };
      } else {
        nextTargetRules = [
          {
            id: `target-${Date.now()}`,
            enabled: true,
            pattern: cleanTarget,
            category: cleanTarget.includes("*") ? "Wildcard Target" : "Target Host",
            description: `Always inspect (${cleanTarget})`,
          },
          ...nextTargetRules,
        ];
      }

      // 2. Remove exact `cleanTarget` from `tlsBypassRules`, and add `!cleanTarget` carve-out if a wildcard bypass rule still matches it
      let nextBypassRules: TlsBypassRule[] = backendFilterConfig.tlsBypassRules
        .map((r) => {
          const remaining = r.pattern
            .split(",")
            .map((t) => t.trim())
            .filter((t) => {
              const p = normalizeHostToken(t);
              return !(p && !p.negated && p.token === cleanTarget);
            });
          return { ...r, pattern: remaining.join(", ") };
        })
        .filter((r) => r.pattern.length > 0);

      if (
        !cleanTarget.includes("*") &&
        matchHostRuleList(nextBypassRules, cleanTarget, 443)
      ) {
        nextBypassRules = [
          {
            id: `carve-inspect-${Date.now()}`,
            enabled: true,
            pattern: `!${cleanTarget}`,
            category: "Inspect Override",
            description: `Исключение из TLS Bypass: всегда расшифровывать ${cleanTarget}`,
          },
          ...nextBypassRules,
        ];
      }

      await updateBackendFilterConfig({
        ...backendFilterConfig,
        tlsTargetRules: nextTargetRules,
        tlsBypassRules: nextBypassRules,
      });
      showToast(
        backendFilterConfig.tlsInterceptMode === "targetedOnly"
          ? `🔍 Always inspect: ${cleanTarget} добавлен в Target Allowlist (MITM включён)`
          : `🔍 Always inspect: ${cleanTarget} добавлен в Target Allowlist и исключён из Bypass`
      );
    },
    [backendFilterConfig, updateBackendFilterConfig, showToast]
  );

  const quickAlwaysPassthroughHost = useCallback(
    async (hostOrPattern: string) => {
      const parsed = normalizeHostToken(hostOrPattern);
      if (!parsed) return;
      const cleanHost = parsed.token.includes("*")
        ? parsed.token
        : parsed.token.split(":")[0];
      if (!cleanHost) return;

      // 1. Remove any `!cleanHost` exclusion from `tlsBypassRules`, and ensure `cleanHost` is enabled in `tlsBypassRules`
      let nextBypassRules: TlsBypassRule[] = backendFilterConfig.tlsBypassRules
        .map((r) => {
          const remaining = r.pattern
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t && t.toLowerCase() !== `!${cleanHost}`);
          return { ...r, pattern: remaining.join(", ") };
        })
        .filter((r) => r.pattern.length > 0);

      const existingBypassIdx = nextBypassRules.findIndex((r) =>
        r.pattern
          .split(",")
          .some((t) => normalizeHostToken(t)?.token === cleanHost && !t.trim().startsWith("!"))
      );
      if (existingBypassIdx >= 0) {
        nextBypassRules[existingBypassIdx] = {
          ...nextBypassRules[existingBypassIdx],
          enabled: true,
        };
      } else {
        nextBypassRules = [
          {
            id: `bypass-${Date.now()}`,
            enabled: true,
            pattern: cleanHost,
            category: cleanHost.includes("*") ? "Wildcard Pinning" : "Custom Pinning",
            description: `Always passthrough (${cleanHost})`,
          },
          ...nextBypassRules,
        ];
      }

      // 2. Remove exact `cleanHost` from `tlsTargetRules`, and add `!cleanHost` carve-out if a wildcard target rule (e.g. `*.mycompany.com`) still matches it
      let nextTargetRules: TlsBypassRule[] = (
        backendFilterConfig.tlsTargetRules ?? []
      )
        .map((r) => {
          const remaining = r.pattern
            .split(",")
            .map((t) => t.trim())
            .filter((t) => {
              const p = normalizeHostToken(t);
              return !(p && !p.negated && p.token === cleanHost);
            });
          return { ...r, pattern: remaining.join(", ") };
        })
        .filter((r) => r.pattern.length > 0);

      if (
        !cleanHost.includes("*") &&
        matchHostRuleList(nextTargetRules, cleanHost, 443)
      ) {
        nextTargetRules = [
          {
            id: `carve-passthrough-${Date.now()}`,
            enabled: true,
            pattern: `!${cleanHost}`,
            category: "Passthrough Override",
            description: `Исключение из Target Allowlist: чистый TCP-проброс для ${cleanHost}`,
          },
          ...nextTargetRules,
        ];
      }

      await updateBackendFilterConfig({
        ...backendFilterConfig,
        tlsBypassEnabled: true,
        tlsBypassRules: nextBypassRules,
        tlsTargetRules: nextTargetRules,
      });
      showToast(
        `🛡️ Always passthrough: ${cleanHost} переведён в чистый TCP-проброс (без MITM)`
      );
    },
    [backendFilterConfig, updateBackendFilterConfig, showToast]
  );

  const quickAddTlsBypassHost = quickAlwaysPassthroughHost;

  const toggleForceNoCache = useCallback(async () => {
    const targetState = !isForceNoCacheActive;
    const nextMutations = backendFilterConfig.headerMutations.map((m) =>
      m.id === "hm-nocache-req" || m.id === "hm-nocache-resp"
        ? { ...m, enabled: targetState }
        : m
    );
    const hasReq = nextMutations.some((m) => m.id === "hm-nocache-req");
    const hasResp = nextMutations.some((m) => m.id === "hm-nocache-resp");
    if (!hasReq) {
      nextMutations.unshift({
        id: "hm-nocache-req",
        enabled: targetState,
        name: "Обход кэша: удалять If-Modified-Since / If-None-Match",
        direction: "request",
        operation: "remove",
        headerName: "If-Modified-Since, If-None-Match",
        headerValue: "",
        urlPattern: "*",
      });
    }
    if (!hasResp) {
      nextMutations.unshift({
        id: "hm-nocache-resp",
        enabled: targetState,
        name: "Обход кэша: удалять ETag / Last-Modified в ответе",
        direction: "response",
        operation: "remove",
        headerName: "ETag, Last-Modified",
        headerValue: "",
        urlPattern: "*",
      });
    }

    await updateBackendFilterConfig({
      ...backendFilterConfig,
      headerMutationsEnabled: true,
      headerMutations: nextMutations,
    });
    showToast(
      targetState
        ? "Включен обход кэша (удаление If-Modified-Since / ETag)"
        : "Принудительный обход кэша отключен"
    );
  }, [backendFilterConfig, isForceNoCacheActive, updateBackendFilterConfig, showToast]);

  const toggleProxy = useCallback(async () => {
    const current = statusRef.current;
    const nextStatus = current.running
      ? await proxyBridge.stopProxy()
      : await proxyBridge.startProxy(undefined, current.port);
    statusRef.current = nextStatus;
    setStatus(nextStatus);

    const endpoints = formatStatusEndpoints(nextStatus);
    if (nextStatus.running) {
      if (nextStatus.systemProxyError) {
        showToast(
          `Захват запущен (${endpoints}), но SysProxy недоступен: ${nextStatus.systemProxyError}`
        );
      } else if (nextStatus.systemProxyEnabled) {
        showToast(
          `Захват активен (${endpoints}) • Системный прокси ОС включён`
        );
      } else {
        showToast(
          `Захват активен (${endpoints}) • Только локальный порт (HTTP_PROXY)`
        );
      }
    } else {
      showToast(
        "Захват приостановлен (Paused) • Системный прокси ОС откачен"
      );
    }
  }, [showToast]);

  const setBindConfiguration = useCallback(
    async (
      bindMode: BindHostMode,
      specificBindIp?: string | null,
      alsoBindLoopback = true
    ) => {
      try {
        const nextStatus = await proxyBridge.setBindConfiguration(
          bindMode,
          specificBindIp ?? null,
          alsoBindLoopback
        );
        persistBindConfigToLocalStorage(nextStatus);
        statusRef.current = nextStatus;
        setStatus(nextStatus);
        const endpoints = formatStatusEndpoints(nextStatus);
        if (nextStatus.bindMode === "all") {
          showToast(
            `📱 Все интерфейсы активны (${endpoints} — LAN / Wi-Fi)`
          );
        } else if (nextStatus.bindMode === "specific") {
          showToast(`🎯 Выбранный интерфейс активен (${endpoints})`);
        } else {
          showToast(`🔒 Только локальные подключения (${endpoints})`);
        }
      } catch (err) {
        showToast(
          `⚠️ Ошибка переключения сетевого интерфейса: ${err instanceof Error ? err.message : String(err)}`
        );
        throw err;
      }
    },
    [showToast]
  );

  const setAllowRemote = useCallback(
    async (allow: boolean) => {
      try {
        await setBindConfiguration(
          allow ? "all" : "loopback",
          statusRef.current.specificBindIp ?? null,
          statusRef.current.alsoBindLoopback ?? true
        );
      } catch {
        // toast notification already emitted inside setBindConfiguration
      }
    },
    [setBindConfiguration]
  );

  const setProxyPort = useCallback(
    async (nextPort: number) => {
      if (
        typeof nextPort !== "number" ||
        !Number.isInteger(nextPort) ||
        nextPort < 1 ||
        nextPort > 65535
      ) {
        showToast("⚠️ Порт прокси должен быть целым числом от 1 до 65535");
        return;
      }

      const curr = statusRef.current;
      const previousPort = curr.port;
      const wasRunning = curr.running;

      if (previousPort === nextPort) {
        try {
          window.localStorage.setItem(
            LS_PROXY_PORT_KEY,
            JSON.stringify(nextPort)
          );
        } catch {
          // ignore storage quota errors
        }
        showToast(`Порт прокси уже установлен на ${nextPort}`);
        return;
      }

      try {
        let nextStatus: ProxyStatus;
        if (wasRunning) {
          await proxyBridge.stopProxy();
          nextStatus = await proxyBridge.startProxy(undefined, nextPort);
        } else {
          nextStatus = await proxyBridge.setPreviewPort(nextPort);
          nextStatus = { ...nextStatus, port: nextPort };
        }

        try {
          window.localStorage.setItem(
            LS_PROXY_PORT_KEY,
            JSON.stringify(nextStatus.port)
          );
        } catch {
          // ignore storage quota errors
        }

        statusRef.current = nextStatus;
        setStatus(nextStatus);
        showToast(
          nextStatus.running
            ? `🔌 Прокси перезапущен на ${formatStatusEndpoints(nextStatus)}`
            : `🔌 Порт прокси изменён на ${nextStatus.port} (вступит в силу при захвате)`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (wasRunning) {
          try {
            const recoveredStatus = await proxyBridge.startProxy(
              undefined,
              previousPort
            );
            statusRef.current = recoveredStatus;
            setStatus(recoveredStatus);
            try {
              window.localStorage.setItem(
                LS_PROXY_PORT_KEY,
                JSON.stringify(recoveredStatus.port)
              );
            } catch {
              // ignore storage quota errors
            }
            showToast(
              `⚠️ Не удалось занять порт ${nextPort} (${errMsg}). Прокси восстановлен на :${recoveredStatus.port}`
            );
            return;
          } catch (rollbackErr) {
            const rbMsg =
              rollbackErr instanceof Error
                ? rollbackErr.message
                : String(rollbackErr);
            const fallbackStatus: ProxyStatus = {
              ...statusRef.current,
              running: false,
              port: previousPort,
            };
            statusRef.current = fallbackStatus;
            setStatus(fallbackStatus);
            showToast(
              `⚠️ Не удалось занять порт ${nextPort} (${errMsg}), откат на :${previousPort} не удался: ${rbMsg}`
            );
            return;
          }
        }

        try {
          window.localStorage.setItem(
            LS_PROXY_PORT_KEY,
            JSON.stringify(previousPort)
          );
        } catch {
          // ignore storage quota errors
        }
        showToast(`⚠️ Не удалось занять порт ${nextPort}: ${errMsg}`);
      }
    },
    [showToast]
  );

  const toggleAllowRemote = useCallback(async () => {
    const curr = statusRef.current;
    const isRemote = Boolean(
      curr.allowRemote ||
        curr.bindMode === "all" ||
        (curr.bindMode === "specific" &&
          curr.specificBindIp &&
          curr.specificBindIp !== "127.0.0.1") ||
        curr.bindAddr === "0.0.0.0"
    );
    await setAllowRemote(!isRemote);
  }, [setAllowRemote]);

  const setSystemProxyEnabled = useCallback(
    async (enabled: boolean) => {
      const nextStatus = await proxyBridge.setSystemProxy(enabled);
      statusRef.current = nextStatus;
      setStatus(nextStatus);

      const sysProxyHost =
        nextStatus.bindMode === "specific" &&
        nextStatus.specificBindIp &&
        nextStatus.alsoBindLoopback === false
          ? nextStatus.specificBindIp
          : "127.0.0.1";

      if (enabled && nextStatus.systemProxyError) {
        showToast(`⚠️ ${nextStatus.systemProxyError}`);
      } else if (nextStatus.systemProxyEnabled) {
        showToast(
          nextStatus.running
            ? `Системный прокси ОС направлен на ${sysProxyHost}:${nextStatus.port}`
            : `Системный прокси ОС включён (${sysProxyHost}:${nextStatus.port}), но захват на паузе (F12)`
        );
      } else {
        showToast(
          nextStatus.running
            ? `Системный прокси ОС отключён • Открыт только порт ${formatStatusEndpoints(nextStatus)} (HTTP_PROXY)`
            : "Системный прокси ОС отключён"
        );
      }
    },
    [showToast]
  );

  const toggleSystemProxy = useCallback(async () => {
    const current = statusRef.current;
    const target = current.systemProxyError
      ? true
      : !current.systemProxyEnabled;
    await setSystemProxyEnabled(target);
  }, [setSystemProxyEnabled]);

  const setAutoSystemProxy = useCallback(
    async (auto: boolean) => {
      try {
        window.localStorage.setItem(LS_AUTO_SYSPROXY_KEY, JSON.stringify(auto));
      } catch {
        // ignore storage quota errors
      }
      const nextStatus = await proxyBridge.setAutoSystemProxy(auto);
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      showToast(
        auto
          ? "Act as System Proxy: автопривязка при старте и захвате включена"
          : "Act as System Proxy отключён: захват работает без автоподмены прокси браузеров"
      );
    },
    [showToast]
  );

  const toggleAutoSystemProxy = useCallback(async () => {
    await setAutoSystemProxy(!statusRef.current.autoSystemProxy);
  }, [setAutoSystemProxy]);

  const toggleSessionSelection = useCallback(
    (id: number) => {
      selectionAnchorIdRef.current = id;
      setSelectedIds((prev) => {
        const base =
          prev.length === 0 && selectedId !== null ? [selectedId] : prev;
        if (base.includes(id)) {
          const next = base.filter((item) => item !== id);
          const nextPrimary = next.length > 0 ? next[next.length - 1] : null;
          selectionAnchorIdRef.current = nextPrimary;
          setSelectedIdState(nextPrimary);
          return next;
        }
        const next = [...base, id];
        setSelectedIdState(id);
        return next;
      });
    },
    [selectedId]
  );

  const selectSessionRange = useCallback(
    (targetId: number, orderedSessions?: SessionSummary[]) => {
      const pool = orderedSessions ?? filteredSessions;
      const anchor =
        selectionAnchorIdRef.current ?? selectedIds[0] ?? selectedId;
      if (anchor === null) {
        selectionAnchorIdRef.current = targetId;
        setSelectedIdState(targetId);
        setSelectedIds([targetId]);
        return;
      }
      selectionAnchorIdRef.current = anchor;
      if (anchor === targetId) {
        setSelectedIdState(targetId);
        setSelectedIds([targetId]);
        return;
      }
      const anchorIdx = pool.findIndex((s) => s.id === anchor);
      const targetIdx = pool.findIndex((s) => s.id === targetId);
      if (anchorIdx === -1 || targetIdx === -1) {
        setSelectedIdState(targetId);
        setSelectedIds([anchor, targetId]);
        return;
      }
      const step = anchorIdx <= targetIdx ? 1 : -1;
      const rangeIds: number[] = [];
      for (let i = anchorIdx; step > 0 ? i <= targetIdx : i >= targetIdx; i += step) {
        rangeIds.push(pool[i].id);
      }
      setSelectedIdState(targetId);
      setSelectedIds(rangeIds);
    },
    [filteredSessions, selectedId, selectedIds]
  );

  const selectSessions = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) {
        selectionAnchorIdRef.current = null;
        setSelectedIdState(null);
        setSelectedIds([]);
        return;
      }
      const uniqueIds = Array.from(new Set(ids));
      const nextPrimary =
        selectedId !== null && uniqueIds.includes(selectedId)
          ? selectedId
          : uniqueIds[0];
      selectionAnchorIdRef.current = nextPrimary;
      setSelectedIdState(nextPrimary);
      setSelectedIds(uniqueIds);
    },
    [selectedId]
  );

  const compareWithSession = useCallback(
    (targetId: number) => {
      const baseId = selectedIds[0] ?? selectedId;
      if (baseId === null || baseId === targetId) {
        setSelectedIdState(targetId);
        setSelectedIds([targetId]);
        return;
      }
      setSelectedIdState(targetId);
      setSelectedIds([baseId, targetId]);
    },
    [selectedId, selectedIds]
  );

  const setComparePairIds = useCallback((leftId: number, rightId: number) => {
    if (leftId === rightId) {
      setSelectedIdState(leftId);
      setSelectedIds([leftId]);
      return;
    }
    setSelectedIdState(rightId);
    setSelectedIds([leftId, rightId]);
  }, []);

  const swapCompareSessions = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.length < 2) return prev;
      const next = [prev[1], prev[0], ...prev.slice(2)];
      setSelectedIdState(next[1]);
      return next;
    });
  }, []);

  const markedSessionsCount = useMemo(
    () => sessions.filter((s) => Boolean(s.comment || s.markedColor)).length,
    [sessions]
  );

  const annotateSessions = useCallback(
    async (
      ids: number[],
      comment: string | null,
      markedColor: string | null
    ) => {
      if (ids.length === 0) return;
      const updated = await proxyBridge.updateSessionAnnotations(
        ids,
        comment,
        markedColor
      );
      if (updated.length > 0) {
        const byId = new Map(updated.map((u) => [u.id, u]));
        setSessions((prev) =>
          prev.map((s) => byId.get(s.id) ?? s)
        );
      }
      const hasAnnotation = Boolean(comment?.trim() || markedColor?.trim());
      if (hasAnnotation) {
        showToast(
          ids.length === 1
            ? `Аннотация сохранена для сессии #${ids[0]}`
            : `Аннотация применена к сессиям: ${ids.length}`
        );
      } else {
        showToast(
          ids.length === 1
            ? `Метка и комментарий сессии #${ids[0]} очищены`
            : `Метки очищены (${ids.length} сессий)`
        );
      }
    },
    [showToast]
  );

  const unmarkSessions = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) {
        showToast("Сначала выберите сессию в таблице трафика");
        return;
      }
      const idSet = new Set(ids);
      const targets = sessions.filter((s) => idSet.has(s.id));
      const markedTargets = targets.filter((s) => Boolean(s.markedColor));
      if (markedTargets.length === 0) {
        showToast("У выбранных сессий нет цветовой метки");
        return;
      }

      // Group by existing comment so unmarking clears markedColor while keeping each session's comment intact
      const byComment = new Map<string, number[]>();
      for (const s of markedTargets) {
        const key = s.comment ?? "";
        const bucket = byComment.get(key);
        if (bucket) {
          bucket.push(s.id);
        } else {
          byComment.set(key, [s.id]);
        }
      }

      const allUpdated: SessionSummary[] = [];
      for (const [existingComment, bucketIds] of byComment.entries()) {
        const res = await proxyBridge.updateSessionAnnotations(
          bucketIds,
          existingComment || null,
          null
        );
        allUpdated.push(...res);
      }

      if (allUpdated.length > 0) {
        const byId = new Map(allUpdated.map((u) => [u.id, u]));
        setSessions((prev) => prev.map((s) => byId.get(s.id) ?? s));
      }

      showToast(
        markedTargets.length === 1
          ? `Цветовая метка сессии #${markedTargets[0].id} снята`
          : `Цветовые метки сняты (${markedTargets.length} сессий)`
      );
    },
    [sessions, showToast]
  );

  const deleteSessions = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) return;
      const removeSet = new Set(ids);

      // Compute nearest surviving row in filteredSessions so keyboard navigation stays continuous
      let nextSelected: number | null = null;
      const firstRemovedIdx = filteredSessions.findIndex((s) =>
        removeSet.has(s.id)
      );
      if (firstRemovedIdx !== -1) {
        for (let i = firstRemovedIdx + 1; i < filteredSessions.length; i++) {
          if (!removeSet.has(filteredSessions[i].id)) {
            nextSelected = filteredSessions[i].id;
            break;
          }
        }
        if (nextSelected === null) {
          for (let i = firstRemovedIdx - 1; i >= 0; i--) {
            if (!removeSet.has(filteredSessions[i].id)) {
              nextSelected = filteredSessions[i].id;
              break;
            }
          }
        }
      } else if (selectedId !== null && !removeSet.has(selectedId)) {
        nextSelected = selectedId;
      }

      try {
        await proxyBridge.deleteSessions(ids);
        pendingQueueRef.current = pendingQueueRef.current.filter(
          (s) => !removeSet.has(s.id)
        );
        setSessions((prev) => prev.filter((s) => !removeSet.has(s.id)));
        selectionAnchorIdRef.current = nextSelected;
        setSelectedIdState(nextSelected);
        setSelectedIds(nextSelected !== null ? [nextSelected] : []);
        if (nextSelected === null) {
          setSelectedDetail(null);
        }
        setDiffLeftDetail(null);
        setDiffRightDetail(null);
        void refreshStorageStats();

        showToast(
          ids.length === 1
            ? `Сессия #${ids[0]} удалена`
            : `Удалено сессий: ${ids.length}`
        );
      } catch (err) {
        showToast(
          `⚠️ Не удалось удалить сессии: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    },
    [filteredSessions, refreshStorageStats, selectedId, showToast]
  );

  const replaySessions = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) {
        showToast("Сначала выберите сессию для повтора (Replay)");
        return;
      }
      let replayedCount = 0;
      let lastDetail: SessionDetail | null = null;

      try {
        for (const id of ids) {
          const detail = await proxyBridge.getSessionDetail(id);
          if (!detail) continue;
          if (
            detail.summary.tlsBypassed ||
            detail.summary.method.toUpperCase() === "CONNECT"
          ) {
            continue;
          }

          let requestBodyBase64 = detail.requestBodyBase64 ?? "";
          let requestBodyText = detail.requestBodyText ?? "";
          if (
            (detail.requestBodyOffloaded ||
              (detail.bodyOffloaded &&
                !requestBodyBase64 &&
                !requestBodyText)) &&
            !requestBodyBase64
          ) {
            const loaded = await proxyBridge.loadSessionBody(id, false);
            requestBodyBase64 = loaded.bodyBase64 ?? "";
            requestBodyText = loaded.bodyText ?? "";
          }

          lastDetail = await proxyBridge.executeComposedRequest({
            method: detail.summary.method,
            url: detail.summary.url,
            headers: detail.requestHeaders.filter(
              (h) => h.name.toLowerCase() !== "content-length"
            ),
            body: requestBodyText,
            ...(requestBodyBase64 ? { bodyBase64: requestBodyBase64 } : {}),
            followRedirects: true,
          });
          replayedCount += 1;
        }

        if (replayedCount === 0) {
          showToast(
            "Выбранные туннели CONNECT / Passthrough нельзя повторить как HTTP-запрос"
          );
          return;
        }

        if (lastDetail) {
          showToast(
            replayedCount === 1
              ? `↻ Replay #${lastDetail.summary.id}: ${lastDetail.summary.method} ${lastDetail.summary.host}${lastDetail.summary.path} (${lastDetail.summary.status})`
              : `↻ Выполнено повторных запросов: ${replayedCount}`
          );
        }
      } catch (err) {
        showToast(
          `⚠️ Ошибка повторной отправки (Replay): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    },
    [showToast]
  );

  const clearAllSessions = useCallback(async () => {
    await proxyBridge.clearSessions();
    pendingQueueRef.current = [];
    setSessions([]);
    selectionAnchorIdRef.current = null;
    setSelectedIdState(null);
    setSelectedIds([]);
    setSelectedDetail(null);
    setDiffLeftDetail(null);
    setDiffRightDetail(null);
    await refreshStorageStats();
    showToast("Cleared all captured sessions");
  }, [refreshStorageStats, showToast]);

  const saveToSqlite = useCallback(async () => {
    const count = await proxyBridge.saveSessionsSqlite();
    await refreshStorageStats();
    showToast(`Persisted ${count.toLocaleString()} sessions to SQLite archive`);
  }, [refreshStorageStats, showToast]);

  const loadFromSqlite = useCallback(async () => {
    const loaded = await proxyBridge.loadSessionsSqlite();
    const limit = sessionRetentionLimitRef.current;
    const next = loaded.slice();
    if (limit && next.length > limit) {
      next.splice(0, next.length - limit);
    }
    setSessions(next);
    if (next.length > 0 && selectedId === null) {
      setSelectedId(next[0].id);
    }
    await refreshStorageStats();
    showToast(`Loaded ${next.length.toLocaleString()} sessions from SQLite`);
  }, [refreshStorageStats, selectedId, setSelectedId, showToast]);

  const mergeImportedSummaries = useCallback(
    (imported: SessionSummary[]) => {
      if (imported.length === 0) return;
      setSessions((prev) => {
        const indexById = new Map<number, number>();
        const next = prev.slice();
        for (let i = 0; i < next.length; i++) {
          indexById.set(next[i].id, i);
        }
        for (const item of imported) {
          const idx = indexById.get(item.id);
          if (idx !== undefined) {
            next[idx] = item;
          } else {
            indexById.set(item.id, next.length);
            next.push(item);
          }
        }
        const limit = sessionRetentionLimitRef.current;
        if (limit && next.length > limit) {
          next.splice(0, next.length - limit);
        }
        return next;
      });
      setSelectedId(imported[0].id);
    },
    [setSelectedId]
  );

  const exportSessionsWithDialog = useCallback(
    async (
      targetSessionIds: number[],
      forcedFormat?: "har" | "saz" | "json" | "raw",
      sanitization?: SanitizationOptions | null
    ): Promise<boolean> => {
      try {
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .slice(0, 19);
        const suffix = sanitization ? "_sanitized" : "";

        let filters: FileDialogFilter[];
        let defaultName: string;

        if (forcedFormat === "har") {
          filters = [
            { name: "HTTP Archive 1.2 (*.har)", extensions: ["har"] },
            { name: "All Files (*.*)", extensions: ["*"] },
          ];
          defaultName =
            targetSessionIds.length === 1
              ? `session_${targetSessionIds[0]}${suffix}.har`
              : targetSessionIds.length > 1
                ? `fluxproxy_selected_${targetSessionIds.length}${suffix}.har`
                : `fluxproxy_capture_${stamp}${suffix}.har`;
        } else if (forcedFormat === "saz") {
          filters = [
            { name: "Fiddler Session Archive (*.saz)", extensions: ["saz"] },
            { name: "All Files (*.*)", extensions: ["*"] },
          ];
          defaultName =
            targetSessionIds.length === 1
              ? `session_${targetSessionIds[0]}${suffix}.saz`
              : targetSessionIds.length > 1
                ? `fluxproxy_selected_${targetSessionIds.length}${suffix}.saz`
                : `fluxproxy_capture_${stamp}${suffix}.saz`;
        } else if (forcedFormat === "raw") {
          filters = [
            { name: "Raw HTTP Message (*.txt)", extensions: ["txt"] },
            { name: "All Files (*.*)", extensions: ["*"] },
          ];
          defaultName =
            targetSessionIds.length === 1
              ? `session_${targetSessionIds[0]}_raw${suffix}.txt`
              : `sessions_raw_${targetSessionIds.length || "all"}${suffix}.txt`;
        } else if (forcedFormat === "json") {
          filters = [
            { name: "JSON Sessions Archive (*.json)", extensions: ["json"] },
            { name: "All Files (*.*)", extensions: ["*"] },
          ];
          defaultName = `fluxproxy_capture_${stamp}${suffix}.json`;
        } else {
          filters = [
            { name: "HTTP Archive 1.2 (*.har)", extensions: ["har"] },
            { name: "Fiddler Session Archive (*.saz)", extensions: ["saz"] },
            { name: "JSON Sessions Archive (*.json)", extensions: ["json"] },
            { name: "All Files (*.*)", extensions: ["*"] },
          ];
          defaultName =
            targetSessionIds.length > 0
              ? `fluxproxy_selected_${targetSessionIds.length}${suffix}.har`
              : `fluxproxy_capture_${stamp}${suffix}.har`;
        }

        const titlePrefix = sanitization ? "Export Sanitized" : "Save";
        const chosenPath = await proxyBridge.pickSaveFileDialog({
          title:
            targetSessionIds.length > 0
              ? `${titlePrefix} Selected Sessions (${targetSessionIds.length})`
              : `${titlePrefix} All Sessions As`,
          defaultName,
          filters,
        });
        if (!chosenPath) return false;

        const lowerPath = chosenPath.toLowerCase();
        const resolvedFormat =
          forcedFormat ??
          (lowerPath.endsWith(".saz")
            ? "saz"
            : lowerPath.endsWith(".json")
              ? "json"
              : lowerPath.endsWith(".txt")
                ? "raw"
                : "har");

        const savedCount = await proxyBridge.exportSessionsFile(
          targetSessionIds,
          resolvedFormat,
          chosenPath,
          sanitization
        );
        const baseName = chosenPath.split(/[\\/]/).pop() ?? chosenPath;
        showToast(
          sanitization
            ? `🛡️ Санитизированный экспорт: ${savedCount.toLocaleString()} → ${baseName}`
            : `💾 Сохранено сессий: ${savedCount.toLocaleString()} → ${baseName}`
        );
        return true;
      } catch (err) {
        showToast(
          `⚠️ Ошибка экспорта: ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
      }
    },
    [showToast]
  );

  const exportAllSessionsAs = useCallback(
    async (forcedFormat?: "har" | "saz" | "json") => {
      if (sessions.length === 0) {
        showToast("⚠️ Нет захваченных сессий для сохранения");
        return;
      }
      await exportSessionsWithDialog([], forcedFormat);
    },
    [exportSessionsWithDialog, sessions.length, showToast]
  );

  const exportSelectedSessionsAs = useCallback(
    async (
      explicitIds?: number[],
      forcedFormat?: "har" | "saz" | "json" | "raw"
    ) => {
      const ids =
        explicitIds && explicitIds.length > 0
          ? explicitIds
          : selectedIds.length > 0
            ? selectedIds
            : selectedId !== null
              ? [selectedId]
              : [];
      if (ids.length === 0) {
        showToast("⚠️ Выделите хотя бы одну сессию для экспорта");
        return;
      }
      await exportSessionsWithDialog(ids, forcedFormat);
    },
    [exportSessionsWithDialog, selectedId, selectedIds, showToast]
  );

  const exportSanitizedSessions = useCallback(
    async (
      targetSessionIds: number[],
      format: "har" | "saz" | "json" | "raw",
      sanitization: SanitizationOptions
    ): Promise<boolean> => {
      if (sessions.length === 0) {
        showToast("⚠️ Нет захваченных сессий для экспорта");
        return false;
      }
      return exportSessionsWithDialog(targetSessionIds, format, sanitization);
    },
    [exportSessionsWithDialog, sessions.length, showToast]
  );

  const importArchiveFromPath = useCallback(
    async (filePath: string) => {
      try {
        const imported = await proxyBridge.importSessionsFile(filePath);
        mergeImportedSummaries(imported);
        await refreshStorageStats();
        const baseName = filePath.split(/[\\/]/).pop() ?? filePath;
        showToast(
          imported.length > 0
            ? `📂 Импортировано сессий: ${imported.length.toLocaleString()} из ${baseName}`
            : `ℹ️ В архиве ${baseName} не найдено сессий`
        );
      } catch (err) {
        showToast(
          `⚠️ Ошибка импорта архива: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
    [mergeImportedSummaries, refreshStorageStats, showToast]
  );

  const importArchiveFromDroppedFile = useCallback(
    async (file: File) => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const imported = await proxyBridge.importSessionsBytes(file.name, bytes);
        mergeImportedSummaries(imported);
        await refreshStorageStats();
        showToast(
          imported.length > 0
            ? `📂 Импортировано сессий: ${imported.length.toLocaleString()} из ${file.name}`
            : `ℹ️ В файле ${file.name} не найдено сессий`
        );
      } catch (err) {
        showToast(
          `⚠️ Ошибка импорта ${file.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
    [mergeImportedSummaries, refreshStorageStats, showToast]
  );

  const importArchiveDialog = useCallback(async () => {
    try {
      const chosenPath = await proxyBridge.pickOpenFileDialog({
        title: "Open / Import Traffic Archive (.har, .saz, .json)",
        filters: [
          {
            name: "Traffic Archives (*.har, *.saz, *.json)",
            extensions: ["har", "saz", "json"],
          },
          { name: "HTTP Archive 1.2 (*.har)", extensions: ["har"] },
          { name: "Fiddler Session Archive (*.saz)", extensions: ["saz"] },
          { name: "JSON Sessions (*.json)", extensions: ["json"] },
          { name: "All Files (*.*)", extensions: ["*"] },
        ],
      });
      if (!chosenPath) return;
      await importArchiveFromPath(chosenPath);
    } catch (err) {
      showToast(
        `⚠️ Ошибка открытия диалога: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, [importArchiveFromPath, showToast]);

  const saveSessionBodyAs = useCallback(
    async (sessionId: number, isResponse: boolean) => {
      try {
        let detail =
          selectedDetail && selectedDetail.summary.id === sessionId
            ? selectedDetail
            : null;
        if (!detail) {
          detail = await proxyBridge.getSessionDetail(sessionId);
        }

        let mimeType: string | null = null;
        if (detail) {
          if (isResponse) {
            mimeType =
              detail.summary.contentType ||
              detail.responseHeaders.find(
                (h) => h.name.toLowerCase() === "content-type"
              )?.value ||
              null;
          } else {
            mimeType =
              detail.requestHeaders.find(
                (h) => h.name.toLowerCase() === "content-type"
              )?.value ?? null;
          }
        } else if (isResponse) {
          const summary = sessions.find((s) => s.id === sessionId);
          mimeType = summary?.contentType ?? null;
        }

        const { fileName, ext } = suggestSessionBodyFileName(
          sessionId,
          isResponse,
          mimeType
        );
        const chosenPath = await proxyBridge.pickSaveFileDialog({
          title: isResponse
            ? `Save Response Body (#${sessionId})`
            : `Save Request Body (#${sessionId})`,
          defaultName: fileName,
          filters: [
            {
              name: `${ext.toUpperCase()} Payload (*.${ext})`,
              extensions: [ext],
            },
            { name: "All Files (*.*)", extensions: ["*"] },
          ],
        });
        if (!chosenPath) return;

        const writtenBytes = await proxyBridge.saveSessionBodyFile(
          sessionId,
          isResponse,
          chosenPath
        );
        const baseName = chosenPath.split(/[\\/]/).pop() ?? chosenPath;
        showToast(
          `💾 Сохранено тело ${isResponse ? "ответа" : "запроса"} #${sessionId}: ${baseName} (${formatBytes(writtenBytes)})`
        );
      } catch (err) {
        showToast(
          `⚠️ Не удалось сохранить тело сессии: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
    [selectedDetail, sessions, showToast]
  );

  const generateStress10k = useCallback(async () => {
    try {
      const generatedCount = await proxyBridge.generateStressTestSessions(
        10_000
      );
      await refreshStorageStats();
      const modeLabel = isTauriRuntime()
        ? "Tauri Rust TrafficStore"
        : "Preview Simulator";
      showToast(
        `⚡ [${modeLabel}] Сгенерировано ${generatedCount.toLocaleString()} сессий — проверьте плавность 60fps скролла`
      );
    } catch (err) {
      showToast(
        `⚠️ Ошибка генерации стресс-сессий: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }, [refreshStorageStats, showToast]);

  const updateBreakpointConfig = useCallback(
    async (next: BreakpointConfig) => {
      breakpointConfigRef.current = next;
      setBreakpointConfig(next);
      try {
        window.localStorage.setItem(
          LS_BREAKPOINT_CFG_KEY,
          JSON.stringify({
            ...next,
            breakBeforeRequest: false,
            breakAfterResponse: false,
          })
        );
      } catch {
        // ignore storage errors
      }
      const saved = await proxyBridge.updateBreakpointConfig(next);
      breakpointConfigRef.current = saved;
      setBreakpointConfig(saved);
      return saved;
    },
    []
  );

  const toggleBreakBeforeRequest = useCallback(async () => {
    const curr = breakpointConfigRef.current;
    const nextVal = !curr.breakBeforeRequest;
    await updateBreakpointConfig({
      ...curr,
      breakBeforeRequest: nextVal,
    });
    showToast(
      nextVal
        ? "⏸ Break on Request АКТИВЕН (F11) — входящие запросы ставятся на паузу до отправки на сервер"
        : "▶ Break on Request отключён (F11)"
    );
  }, [updateBreakpointConfig, showToast]);

  const toggleBreakAfterResponse = useCallback(async () => {
    const curr = breakpointConfigRef.current;
    const nextVal = !curr.breakAfterResponse;
    await updateBreakpointConfig({
      ...curr,
      breakAfterResponse: nextVal,
    });
    showToast(
      nextVal
        ? "⏸ Break on Response АКТИВЕН (Alt+F11) — ответы сервера перехватываются до возврата в браузер"
        : "▶ Break on Response отключён (Alt+F11)"
    );
  }, [updateBreakpointConfig, showToast]);

  const disableAllBreakpoints = useCallback(async () => {
    const curr = breakpointConfigRef.current;
    await updateBreakpointConfig({
      ...curr,
      breakBeforeRequest: false,
      breakAfterResponse: false,
      rules: curr.rules.map((r) => ({ ...r, enabled: false })),
    });
    const resumed = await proxyBridge.resumeAllBreakpoints("continue");
    showToast(
      resumed > 0
        ? `Все точки останова сняты (Shift+F11) • Продолжено запросов: ${resumed}`
        : "Все глобальные и условные точки останова отключены (Shift+F11)"
    );
  }, [updateBreakpointConfig, showToast]);

  const applyQuickExecBpu = useCallback(
    async (stage: "request" | "response", rawPattern: string) => {
      const clean = rawPattern.trim();
      const curr = breakpointConfigRef.current;
      const cmdName = stage === "request" ? "bpu" : "bpafter";

      if (!clean) {
        const remaining = curr.rules.filter(
          (r) => r.stage !== stage && r.stage !== "both"
        );
        await updateBreakpointConfig({
          ...curr,
          breakBeforeRequest:
            stage === "request" ? false : curr.breakBeforeRequest,
          breakAfterResponse:
            stage === "response" ? false : curr.breakAfterResponse,
          rules: remaining,
        });
        showToast(
          `Команда ${cmdName}: все условные точки останова (${stage === "request" ? "Before Request" : "After Response"}) очищены`
        );
        return;
      }

      const existingIdx = curr.rules.findIndex(
        (r) =>
          r.stage === stage &&
          r.urlPattern.toLowerCase() === clean.toLowerCase()
      );
      const nextRules = curr.rules.slice();
      if (existingIdx >= 0) {
        nextRules[existingIdx] = { ...nextRules[existingIdx], enabled: true };
      } else {
        nextRules.unshift({
          id: `bp-rule-${Date.now()}`,
          enabled: true,
          name: `${cmdName} ${clean}`,
          stage,
          urlPattern: clean,
          methodFilter: null,
        });
      }

      await updateBreakpointConfig({
        ...curr,
        rules: nextRules,
      });
      showToast(
        `⏸ Установлена точка останова ${cmdName} «${clean}» (${stage === "request" ? "Before Request" : "After Response"})`
      );
    },
    [updateBreakpointConfig, showToast]
  );

  const resolvePausedBreakpoint = useCallback(
    async (resolution: BreakpointResolution) => {
      const ok = await proxyBridge.resolveBreakpoint(resolution);
      const updated = await proxyBridge.listPausedBreakpoints();
      setPausedBreakpoints(updated);
      if (ok) {
        showToast(
          resolution.action === "abort"
            ? "⛔ Запрос прерван на точке останова (Aborted)"
            : "▶ Пакет отправлен дальше с вашими правками (Continue)"
        );
      }
      return ok;
    },
    [showToast]
  );

  const resumeAllBreakpoints = useCallback(
    async (action: BreakpointAction = "continue") => {
      const count = await proxyBridge.resumeAllBreakpoints(action);
      setPausedBreakpoints([]);
      if (count > 0) {
        showToast(
          action === "abort"
            ? `⛔ Прервано ожидающих пакетов: ${count}`
            : `▶ Продолжено ожидающих пакетов: ${count}`
        );
      }
    },
    [showToast]
  );

  return {
    sessions,
    filteredSessions,
    selectedId,
    setSelectedId,
    selectedIds,
    toggleSessionSelection,
    selectSessionRange,
    selectSessions,
    compareWithSession,
    setComparePairIds,
    swapCompareSessions,
    selectedDetail,
    diffLeftDetail,
    diffRightDetail,
    markedSessionsCount,
    annotateSessions,
    unmarkSessions,
    deleteSessions,
    replaySessions,
    status,
    filterQuery,
    setFilterQuery,
    useRegex,
    setUseRegex,
    regexError,
    quickCategory,
    setQuickCategory,
    followTail,
    setFollowTail,
    toastMessage,
    showToast,
    // Advanced Filter System
    matrixEnabled,
    setMatrixEnabled: (v: boolean) => {
      setMatrixEnabled(v);
    },
    filterRules,
    setFilterRules: (
      updater:
        | FilterConditionRule[]
        | ((prev: FilterConditionRule[]) => FilterConditionRule[])
    ) => {
      setActivePresetId(null);
      setFilterRules(updater);
    },
    ruleErrors: compiledMatrix.ruleErrors,
    thresholds,
    setThresholds: (
      updater:
        | NoiseThresholdsConfig
        | ((prev: NoiseThresholdsConfig) => NoiseThresholdsConfig)
    ) => {
      setActivePresetId(null);
      setThresholds(updater);
    },
    hostListFilter,
    setHostListFilter: (
      updater:
        | HostListFilterConfig
        | ((prev: HostListFilterConfig) => HostListFilterConfig)
    ) => {
      setActivePresetId(null);
      setHostListFilterState(updater);
    },
    compiledHostList,
    customPresets,
    allPresets,
    activePreset,
    activePresetId,
    applyPreset,
    saveCustomPreset,
    deleteCustomPreset,
    resetAdvancedFilters,
    backendFilterConfig,
    updateBackendFilterConfig,
    detectedProcesses,
    quickFilterByProcess,
    quickFilterByClientIp,
    setTlsInterceptMode,
    toggleTlsInterceptMode,
    quickAlwaysInspectHost,
    quickAlwaysPassthroughHost,
    quickAddTlsBypassHost,
    isForceNoCacheActive,
    toggleForceNoCache,
    activeFilterBadgeCount,
    // Live Breakpoints (Before Request / After Response)
    breakpointConfig,
    pausedBreakpoints,
    updateBreakpointConfig,
    toggleBreakBeforeRequest,
    toggleBreakAfterResponse,
    disableAllBreakpoints,
    applyQuickExecBpu,
    resolvePausedBreakpoint,
    resumeAllBreakpoints,
    // Ring Buffer Retention & Drop Non-Matching on Capture
    sessionRetentionLimit,
    setSessionRetentionLimit,
    dropNonMatching,
    setDropNonMatching,
    toggleDropNonMatching,
    clearDbOnExit,
    setClearDbOnExit,
    clearSqliteDatabase,
    storageStats,
    refreshStorageStats,
    // Core Proxy Actions
    toggleProxy,
    setProxyPort,
    setBindConfiguration,
    setAllowRemote,
    toggleAllowRemote,
    setSystemProxyEnabled,
    toggleSystemProxy,
    setAutoSystemProxy,
    toggleAutoSystemProxy,
    clearAllSessions,
    saveToSqlite,
    loadFromSqlite,
    exportAllSessionsAs,
    exportSelectedSessionsAs,
    exportSanitizedSessions,
    importArchiveDialog,
    importArchiveFromPath,
    importArchiveFromDroppedFile,
    saveSessionBodyAs,
    generateStress10k,
  };
}
