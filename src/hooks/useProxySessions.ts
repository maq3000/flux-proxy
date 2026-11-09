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
  DEFAULT_BREAKPOINT_CONFIG,
  type FileDialogFilter,
  proxyBridge,
} from "../lib/tauriBridge";
import { DEFAULT_SESSION_RETENTION_LIMIT } from "../types/proxy";
import type {
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
const LS_BREAKPOINT_CFG_KEY = "fluxproxy.breakpointConfig.v1";
const LS_RETENTION_LIMIT_KEY = "fluxproxy.sessionRetentionLimit.v1";
const LS_DROP_NON_MATCHING_KEY = "fluxproxy.dropNonMatching.v1";

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

  const [status, setStatus] = useState<ProxyStatus>({
    running: true,
    bindAddr: "127.0.0.1",
    port: 8888,
    activeSessions: 0,
    systemProxyEnabled: initialAutoSysProxy ?? true,
    autoSystemProxy: initialAutoSysProxy ?? true,
    systemProxyError: null,
    allowRemote: false,
  });
  const statusRef = useRef<ProxyStatus>(status);
  statusRef.current = status;

  // Quick Search & Regex Filter State (TopToolbar)
  const [filterQuery, setFilterQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [quickCategory, setQuickCategory] =
    useState<QuickFilterCategory>("all");
  const [followTail, setFollowTail] = useState(false);
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

  // Coalesce high-frequency Rust IPC batches to animation frames
  const pendingQueueRef = useRef<SessionSummary[]>([]);
  const rafHandleRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3200);
  }, []);

  const refreshStorageStats = useCallback(async () => {
    try {
      const nextStats = await proxyBridge.getMemoryStorageStats();
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
    } catch {
      // ignore transient IPC poll error
    }
  }, []);

  const flushPendingSessions = useCallback(() => {
    rafHandleRef.current = null;
    const incoming = pendingQueueRef.current;
    if (incoming.length === 0) return;
    pendingQueueRef.current = [];

    setSessions((prev) => {
      let next: SessionSummary[];
      if (prev.length === 0) {
        next = incoming.slice();
      } else {
        // Fast O(N) merge supporting both append of new sessions and in-place updates (e.g. WebSocket frames / TLS Bypass byte totals)
        const indexById = new Map<number, number>();
        next = prev.slice();
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
      }
      const limit = sessionRetentionLimitRef.current;
      if (limit && next.length > limit) {
        next.splice(0, next.length - limit);
      }
      return next;
    });
    void refreshStorageStats();
  }, [refreshStorageStats]);

  // Initial load + Sync backend filter config (TLS Bypass + Header Mutations + Ring Buffer + Drop Non-Matching) + Real-time Tauri IPC subscription
  useEffect(() => {
    let mounted = true;
    let unlistenFn: (() => void) | null = null;
    let unlistenBpFn: (() => void) | null = null;

    async function bootstrap() {
      // Push persisted retention limit, dropNonMatching, TLS Bypass, Header Mutation & Breakpoint rules into Rust / Preview engine on boot
      await proxyBridge.setSessionRetentionLimit(
        sessionRetentionLimitRef.current
      );
      const [syncedCfg, syncedBpCfg, initialPaused] = await Promise.all([
        proxyBridge.updateFilterBackendConfig({
          ...backendFilterConfigRef.current,
          dropNonMatchingOnCapture: dropNonMatchingRef.current,
        }),
        proxyBridge.updateBreakpointConfig(breakpointConfigRef.current),
        proxyBridge.listPausedBreakpoints(),
      ]);
      await proxyBridge.setDropNonMatching(dropNonMatchingRef.current);
      const [initialStatus, initialSessions, initialStats] = await Promise.all([
        proxyBridge.getStatus(),
        proxyBridge.getSessions(),
        proxyBridge.getMemoryStorageStats(),
      ]);
      let effectiveStatus = initialStatus;
      if (
        initialAutoSysProxy !== null &&
        initialStatus.autoSystemProxy !== initialAutoSysProxy
      ) {
        effectiveStatus = await proxyBridge.setAutoSystemProxy(
          initialAutoSysProxy
        );
        if (!initialAutoSysProxy && effectiveStatus.systemProxyEnabled) {
          effectiveStatus = await proxyBridge.setSystemProxy(false);
        }
      }
      try {
        window.localStorage.setItem(
          LS_AUTO_SYSPROXY_KEY,
          JSON.stringify(effectiveStatus.autoSystemProxy)
        );
      } catch {
        // ignore storage quota errors
      }

      if (!mounted) return;
      setBackendFilterConfig(syncedCfg);
      setBreakpointConfig(syncedBpCfg);
      setPausedBreakpoints(initialPaused);
      setStorageStats(initialStats);
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

      unlistenFn = await proxyBridge.subscribeSessionBatches((batch) => {
        if (!mounted) return;
        pendingQueueRef.current.push(...batch);
        if (rafHandleRef.current === null) {
          rafHandleRef.current = window.requestAnimationFrame(
            flushPendingSessions
          );
        }
      });

      unlistenBpFn = await proxyBridge.subscribeBreakpointsChanged((items) => {
        if (!mounted) return;
        setPausedBreakpoints(items);
      });
    }

    void bootstrap();

    return () => {
      mounted = false;
      if (unlistenFn) unlistenFn();
      if (unlistenBpFn) unlistenBpFn();
      if (rafHandleRef.current !== null) {
        window.cancelAnimationFrame(rafHandleRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushPendingSessions]);

  // Periodic storage & dropped-sessions telemetry polling (RAM sessions, SQLite bytes, Dropped count)
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refreshStorageStats();
    }, 1500);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshStorageStats]);

  // Periodic OS System Proxy status reconciliation (detects external VPN / OS proxy hijack or reset)
  useEffect(() => {
    let active = true;

    const reconcileStatus = async () => {
      try {
        const next = await proxyBridge.getStatus();
        if (!active) return;
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
          if (
            curr.running === next.running &&
            curr.bindAddr === next.bindAddr &&
            curr.port === next.port &&
            curr.activeSessions === next.activeSessions &&
            curr.systemProxyEnabled === next.systemProxyEnabled &&
            curr.autoSystemProxy === next.autoSystemProxy &&
            Boolean(curr.allowRemote) === Boolean(next.allowRemote) &&
            (curr.systemProxyError ?? null) === (next.systemProxyError ?? null)
          ) {
            return curr;
          }
          return next;
        });
      } catch {
        // ignore transient IPC poll error
      }
    };

    const intervalId = window.setInterval(() => {
      void reconcileStatus();
    }, 3500);
    const onWindowFocus = () => {
      void reconcileStatus();
    };
    window.addEventListener("focus", onWindowFocus);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [showToast]);

  const selectedSummarySignature = useMemo(() => {
    if (selectedId === null) return "";
    const found = sessions.find((s) => s.id === selectedId);
    if (!found) return "";
    return `${found.status}:${found.bodySize}:${found.durationMs}:${found.breakpointPaused ?? ""}:${found.breakpointModified ? "1" : "0"}:${found.comment ?? ""}:${found.markedColor ?? ""}`;
  }, [selectedId, sessions]);

  // Fetch full SessionDetail on-demand when selected row changes or updates in-place
  useEffect(() => {
    let active = true;
    if (selectedId === null) {
      setSelectedDetail(null);
      return;
    }
    void proxyBridge.getSessionDetail(selectedId).then((detail) => {
      if (active) setSelectedDetail(detail);
    });
    return () => {
      active = false;
    };
  }, [selectedId, sessions.length, selectedSummarySignature]);

  const diffLeftId = selectedIds.length >= 2 ? selectedIds[0] : null;
  const diffRightId = selectedIds.length >= 2 ? selectedIds[1] : null;

  const diffPairSignature = useMemo(() => {
    if (diffLeftId === null || diffRightId === null) return "";
    const l = sessions.find((s) => s.id === diffLeftId);
    const r = sessions.find((s) => s.id === diffRightId);
    const sig = (s?: SessionSummary) =>
      s
        ? `${s.status}:${s.bodySize}:${s.durationMs}:${s.comment ?? ""}:${s.markedColor ?? ""}`
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
    void Promise.all([
      proxyBridge.getSessionDetail(diffLeftId),
      proxyBridge.getSessionDetail(diffRightId),
    ]).then(([left, right]) => {
      if (!active) return;
      setDiffLeftDetail(left);
      setDiffRightDetail(right);
    });
    return () => {
      active = false;
    };
  }, [diffLeftId, diffRightId, diffPairSignature]);

  const updateBackendFilterConfig = useCallback(
    async (next: ProxyFilterBackendConfig) => {
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

  // Sync Bulk Hosts List to Rust ProxyFilterEngine when TLS Passthrough sync is active (debounced on text input)
  const lastSyncedHostListFlagsRef = useRef({
    enabled: hostListFilter.enabled,
    mode: hostListFilter.mode,
    applyToTlsPassthrough: hostListFilter.applyToTlsPassthrough,
  });

  useEffect(() => {
    const desiredSync = buildHostListSyncPayload(
      hostListFilter,
      compiledHostList.activeCount
    );
    const currentSync = backendFilterConfigRef.current.hostListSync;

    const prevFlags = lastSyncedHostListFlagsRef.current;
    const structuralChange =
      prevFlags.enabled !== hostListFilter.enabled ||
      prevFlags.mode !== hostListFilter.mode ||
      prevFlags.applyToTlsPassthrough !== hostListFilter.applyToTlsPassthrough;

    lastSyncedHostListFlagsRef.current = {
      enabled: hostListFilter.enabled,
      mode: hostListFilter.mode,
      applyToTlsPassthrough: hostListFilter.applyToTlsPassthrough,
    };

    if (!desiredSync.enabled && !currentSync?.enabled) {
      return;
    }

    if (
      currentSync &&
      currentSync.enabled === desiredSync.enabled &&
      currentSync.mode === desiredSync.mode &&
      currentSync.rawText === desiredSync.rawText
    ) {
      return;
    }

    const pushSync = () => {
      void updateBackendFilterConfig({
        ...backendFilterConfigRef.current,
        hostListSync: desiredSync,
      });
    };

    if (structuralChange || !desiredSync.enabled) {
      pushSync();
      return;
    }

    const timerId = window.setTimeout(pushSync, 250);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [hostListFilter, compiledHostList.activeCount, updateBackendFilterConfig]);

  // Sync active Capture Filters (Hosts List, Thresholds, Matrix, Quick Category & Search Query) to Rust for `evaluate_should_store_session`
  useEffect(() => {
    const desiredCaptureHl = buildCaptureHostListPayload(
      hostListFilter,
      compiledHostList.activeCount
    );
    const desiredThresholds = buildNoiseThresholdsSyncPayload(thresholds);
    const curr = backendFilterConfigRef.current;

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

    if (sameCaptureHl && sameThresholds && sameMatrix && sameQuick) {
      return;
    }

    const pushCaptureFilters = () => {
      void updateBackendFilterConfig({
        ...backendFilterConfigRef.current,
        dropNonMatchingOnCapture: dropNonMatching,
        captureHostList: desiredCaptureHl,
        noiseThresholds: desiredThresholds,
        captureMatrixEnabled: matrixEnabled,
        captureFilterRules: filterRules,
        quickCategory,
        filterQuery,
        useRegexQuery: useRegex,
      });
    };

    const timerId = window.setTimeout(pushCaptureFilters, 150);
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
      // 1. Quick Category Bar
      if (quickCategory !== "all") {
        const tone = getRowSemanticTone(s);
        if (quickCategory === "json" && tone !== "json") return false;
        if (quickCategory === "images" && tone !== "image") return false;
        if (quickCategory === "errors" && tone !== "error") return false;
        if (quickCategory === "ws" && tone !== "ws") return false;
        if (quickCategory === "sse" && tone !== "sse") return false;
        if (quickCategory === "mocked" && !s.isMocked) return false;
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
    const preferredHost =
      current.allowRemote || current.bindAddr === "0.0.0.0"
        ? "0.0.0.0"
        : "127.0.0.1";
    const nextStatus = current.running
      ? await proxyBridge.stopProxy()
      : await proxyBridge.startProxy(preferredHost, current.port);
    statusRef.current = nextStatus;
    setStatus(nextStatus);

    if (nextStatus.running) {
      if (nextStatus.systemProxyError) {
        showToast(
          `Захват запущен (${nextStatus.bindAddr}:${nextStatus.port}), но SysProxy недоступен: ${nextStatus.systemProxyError}`
        );
      } else if (nextStatus.systemProxyEnabled) {
        showToast(
          `Захват активен (${nextStatus.bindAddr}:${nextStatus.port}) • Системный прокси ОС включён`
        );
      } else {
        showToast(
          `Захват активен (${nextStatus.bindAddr}:${nextStatus.port}) • Только локальный порт (HTTP_PROXY)`
        );
      }
    } else {
      showToast(
        "Захват приостановлен (Paused) • Системный прокси ОС откачен"
      );
    }
  }, [showToast]);

  const setAllowRemote = useCallback(
    async (allow: boolean) => {
      try {
        const nextStatus = await proxyBridge.setAllowRemote(allow);
        statusRef.current = nextStatus;
        setStatus(nextStatus);
        showToast(
          nextStatus.allowRemote || nextStatus.bindAddr === "0.0.0.0"
            ? `📱 Удаленные подключения включены (${nextStatus.bindAddr}:${nextStatus.port} — LAN / Wi-Fi)`
            : `🔒 Только локальные подключения (${nextStatus.bindAddr}:${nextStatus.port})`
        );
      } catch (err) {
        showToast(
          `⚠️ Ошибка переключения интерфейса 0.0.0.0: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
    [showToast]
  );

  const toggleAllowRemote = useCallback(async () => {
    const curr = statusRef.current;
    const isRemote = Boolean(curr.allowRemote || curr.bindAddr === "0.0.0.0");
    await setAllowRemote(!isRemote);
  }, [setAllowRemote]);

  const setSystemProxyEnabled = useCallback(
    async (enabled: boolean) => {
      const nextStatus = await proxyBridge.setSystemProxy(enabled);
      statusRef.current = nextStatus;
      setStatus(nextStatus);

      if (enabled && nextStatus.systemProxyError) {
        showToast(`⚠️ ${nextStatus.systemProxyError}`);
      } else if (nextStatus.systemProxyEnabled) {
        showToast(
          nextStatus.running
            ? `Системный прокси ОС направлен на 127.0.0.1:${nextStatus.port}`
            : `Системный прокси ОС включён (127.0.0.1:${nextStatus.port}), но захват на паузе (F12)`
        );
      } else {
        showToast(
          nextStatus.running
            ? `Системный прокси ОС отключён • Открыт только порт ${nextStatus.bindAddr}:${nextStatus.port} (HTTP_PROXY)`
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
    (targetId: number) => {
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
      const anchorIdx = filteredSessions.findIndex((s) => s.id === anchor);
      const targetIdx = filteredSessions.findIndex((s) => s.id === targetId);
      if (anchorIdx === -1 || targetIdx === -1) {
        setSelectedIdState(targetId);
        setSelectedIds([anchor, targetId]);
        return;
      }
      const step = anchorIdx <= targetIdx ? 1 : -1;
      const rangeIds: number[] = [];
      for (let i = anchorIdx; step > 0 ? i <= targetIdx : i >= targetIdx; i += step) {
        rangeIds.push(filteredSessions[i].id);
      }
      setSelectedIdState(targetId);
      setSelectedIds(rangeIds);
    },
    [filteredSessions, selectedId, selectedIds]
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

      pendingQueueRef.current = pendingQueueRef.current.filter(
        (s) => !removeSet.has(s.id)
      );
      await proxyBridge.deleteSessions(ids);
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

      for (const id of ids) {
        const detail = await proxyBridge.getSessionDetail(id);
        if (!detail) continue;
        if (
          detail.summary.tlsBypassed ||
          detail.summary.method.toUpperCase() === "CONNECT"
        ) {
          continue;
        }
        lastDetail = await proxyBridge.executeComposedRequest({
          method: detail.summary.method,
          url: detail.summary.url,
          headers: detail.requestHeaders.filter(
            (h) => h.name.toLowerCase() !== "content-length"
          ),
          body: detail.requestBodyText ?? "",
          followRedirects: true,
        });
        replayedCount += 1;
      }

      if (replayedCount === 0) {
        showToast("Выбранные туннели CONNECT / Passthrough нельзя повторить как HTTP-запрос");
        return;
      }

      if (lastDetail) {
        showToast(
          replayedCount === 1
            ? `↻ Replay #${lastDetail.summary.id}: ${lastDetail.summary.method} ${lastDetail.summary.host}${lastDetail.summary.path} (${lastDetail.summary.status})`
            : `↻ Выполнено повторных запросов: ${replayedCount}`
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
      forcedFormat?: "har" | "saz" | "json" | "raw"
    ) => {
      try {
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .slice(0, 19);

        let filters: FileDialogFilter[];
        let defaultName: string;

        if (forcedFormat === "har") {
          filters = [
            { name: "HTTP Archive 1.2 (*.har)", extensions: ["har"] },
            { name: "All Files (*.*)", extensions: ["*"] },
          ];
          defaultName =
            targetSessionIds.length === 1
              ? `session_${targetSessionIds[0]}.har`
              : targetSessionIds.length > 1
                ? `fluxproxy_selected_${targetSessionIds.length}.har`
                : `fluxproxy_capture_${stamp}.har`;
        } else if (forcedFormat === "saz") {
          filters = [
            { name: "Fiddler Session Archive (*.saz)", extensions: ["saz"] },
            { name: "All Files (*.*)", extensions: ["*"] },
          ];
          defaultName =
            targetSessionIds.length === 1
              ? `session_${targetSessionIds[0]}.saz`
              : targetSessionIds.length > 1
                ? `fluxproxy_selected_${targetSessionIds.length}.saz`
                : `fluxproxy_capture_${stamp}.saz`;
        } else if (forcedFormat === "raw") {
          filters = [
            { name: "Raw HTTP Message (*.txt)", extensions: ["txt"] },
            { name: "All Files (*.*)", extensions: ["*"] },
          ];
          defaultName =
            targetSessionIds.length === 1
              ? `session_${targetSessionIds[0]}_raw.txt`
              : `sessions_raw_${targetSessionIds.length}.txt`;
        } else if (forcedFormat === "json") {
          filters = [
            { name: "JSON Sessions Archive (*.json)", extensions: ["json"] },
            { name: "All Files (*.*)", extensions: ["*"] },
          ];
          defaultName = `fluxproxy_capture_${stamp}.json`;
        } else {
          filters = [
            { name: "HTTP Archive 1.2 (*.har)", extensions: ["har"] },
            { name: "Fiddler Session Archive (*.saz)", extensions: ["saz"] },
            { name: "JSON Sessions Archive (*.json)", extensions: ["json"] },
            { name: "All Files (*.*)", extensions: ["*"] },
          ];
          defaultName =
            targetSessionIds.length > 0
              ? `fluxproxy_selected_${targetSessionIds.length}.har`
              : `fluxproxy_capture_${stamp}.har`;
        }

        const chosenPath = await proxyBridge.pickSaveFileDialog({
          title:
            targetSessionIds.length > 0
              ? `Save Selected Sessions (${targetSessionIds.length})`
              : "Save All Sessions As",
          defaultName,
          filters,
        });
        if (!chosenPath) return;

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
          chosenPath
        );
        const baseName = chosenPath.split(/[\\/]/).pop() ?? chosenPath;
        showToast(
          `💾 Сохранено сессий: ${savedCount.toLocaleString()} → ${baseName}`
        );
      } catch (err) {
        showToast(
          `⚠️ Ошибка экспорта: ${err instanceof Error ? err.message : String(err)}`
        );
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

  const generateStress10k = useCallback(() => {
    proxyBridge.generateStressTestSessions(10_000);
    void refreshStorageStats();
    showToast("Generated +10,000 sessions — test virtualized 60fps scrolling!");
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
    storageStats,
    refreshStorageStats,
    // Core Proxy Actions
    toggleProxy,
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
    importArchiveDialog,
    importArchiveFromPath,
    importArchiveFromDroppedFile,
    saveSessionBodyAs,
    generateStress10k,
  };
}
