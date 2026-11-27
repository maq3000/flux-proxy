import { vi } from "vitest";
import {
  DEFAULT_AUTORESPONDER_RULES,
  DEFAULT_CLEAR_DB_ON_EXIT,
  DEFAULT_PYTHON_SCRIPT_CODE,
} from "../lib/appDefaults";
import { DEFAULT_BACKEND_FILTER_CONFIG } from "../lib/filterEngine";
import type {
  FileDialogFilter,
  NativeDragDropPayload,
  proxyBridge,
} from "../lib/tauriBridge";
import {
  DEFAULT_BREAKPOINT_CONFIG,
  DEFAULT_SESSION_RETENTION_LIMIT,
  DEFAULT_THROTTLE_CONFIG,
  DEFAULT_UPSTREAM_PROXY_BYPASS_LIST,
  DEFAULT_UPSTREAM_PROXY_CONFIG,
  DEFAULT_UPSTREAM_TIMEOUT_CONFIG,
  type AddClientCertificateInput,
  type AutoResponderRule,
  type BindHostMode,
  type BreakpointAction,
  type BreakpointConfig,
  type BreakpointResolution,
  type CaCertificateInfo,
  type ClientCertificateEntry,
  type CodecOperation,
  type CodecTransformResult,
  type ComposedRequest,
  type DoctorCheckResult,
  type HostRemapRule,
  type LoadedSessionBody,
  type NetworkInterfaceInfo,
  type PausedBreakpointItem,
  type ProxyFilterBackendConfig,
  type ProxyStatus,
  type PythonRunnerStatus,
  type SanitizationOptions,
  type ScriptConsoleLogEvent,
  type SessionDetail,
  type SessionSummary,
  type StorageStats,
  type ThrottleConfig,
  type UpstreamProxyConfig,
  type UpstreamTimeoutConfig,
  type WebSocketFrameRecord,
  type WsInjectDirection,
  type WsInjectOpcode,
} from "../types/proxy";

export type ProxyBridgeType = typeof proxyBridge;

export interface MockProxyState {
  status: ProxyStatus;
  sessions: SessionSummary[];
  details: Map<number, SessionDetail>;
  offloadedBodies: Map<
    number,
    { bodyBase64: string; bodyText: string | null; bodySize: number }
  >;
  stats: StorageStats;
  filterCfg: ProxyFilterBackendConfig;
  bpCfg: BreakpointConfig;
  pausedBreakpoints: PausedBreakpointItem[];
  autoRespEnabled: boolean;
  autoRespRules: AutoResponderRule[];
  clearOnExit: boolean;
  pythonStatus: PythonRunnerStatus;
  hostRemapRules: HostRemapRule[];
  throttleConfig: ThrottleConfig;
  upstreamProxyConfig: UpstreamProxyConfig;
  upstreamTimeouts: UpstreamTimeoutConfig;
  clientCerts: ClientCertificateEntry[];
}

export function createDefaultMockStatus(): ProxyStatus {
  return {
    running: true,
    bindAddr: "127.0.0.1",
    port: 8888,
    activeSessions: 0,
    systemProxyEnabled: true,
    autoSystemProxy: true,
    systemProxyError: null,
    allowRemote: false,
    bindMode: "loopback",
    specificBindIp: null,
    alsoBindLoopback: true,
    boundIps: ["127.0.0.1"],
  };
}

export function createDefaultMockStats(): StorageStats {
  return {
    ramSessions: 0,
    sqliteSizeBytes: 0,
    droppedSessionsCount: 0,
    sessionRetentionLimit: DEFAULT_SESSION_RETENTION_LIMIT,
    dropNonMatching: false,
  };
}

export function createStatefulMockProxyBridge(
  initialOverrides: Partial<MockProxyState> = {}
) {
  const state: MockProxyState = {
    status: createDefaultMockStatus(),
    sessions: [],
    details: new Map(),
    offloadedBodies: new Map(),
    stats: createDefaultMockStats(),
    filterCfg: structuredClone(DEFAULT_BACKEND_FILTER_CONFIG),
    bpCfg: structuredClone(DEFAULT_BREAKPOINT_CONFIG),
    pausedBreakpoints: [],
    autoRespEnabled: true,
    autoRespRules: structuredClone(DEFAULT_AUTORESPONDER_RULES),
    clearOnExit: DEFAULT_CLEAR_DB_ON_EXIT,
    pythonStatus: {
      available: false,
      enabled: false,
      running: false,
      pythonExecutable: null,
      pythonVersion: null,
      workerPid: null,
      hasOnRequest: false,
      hasOnResponse: false,
      timeoutMs: 1500,
      lastError: null,
      restartCount: 0,
      invocationsCount: 0,
      timeoutCount: 0,
      isSimulator: true,
      code: DEFAULT_PYTHON_SCRIPT_CODE,
    },
    hostRemapRules: [],
    throttleConfig: structuredClone(DEFAULT_THROTTLE_CONFIG),
    upstreamProxyConfig: {
      ...structuredClone(DEFAULT_UPSTREAM_PROXY_CONFIG),
      bypassList: [...DEFAULT_UPSTREAM_PROXY_BYPASS_LIST],
    },
    upstreamTimeouts: structuredClone(DEFAULT_UPSTREAM_TIMEOUT_CONFIG),
    clientCerts: [],
    ...initialOverrides,
  };

  const listeners = {
    batches: new Set<(batch: SessionSummary[]) => void>(),
    removed: new Set<(ids: number[]) => void>(),
    breakpoints: new Set<(items: PausedBreakpointItem[]) => void>(),
    status: new Set<(status: ProxyStatus) => void>(),
    stats: new Set<(stats: StorageStats) => void>(),
    scriptLogs: new Set<(entry: ScriptConsoleLogEvent) => void>(),
    fileDrop: new Set<(payload: NativeDragDropPayload) => void>(),
  };

  const unlistenSpies = {
    batches: vi.fn(),
    removed: vi.fn(),
    breakpoints: vi.fn(),
    status: vi.fn(),
    stats: vi.fn(),
    scriptLogs: vi.fn(),
    fileDrop: vi.fn(),
  };

  const baseBridge = {
    getStatus: vi.fn(async (): Promise<ProxyStatus> =>
      structuredClone(state.status)
    ),
    startProxy: vi.fn(
      async (_host?: string, port = 8888): Promise<ProxyStatus> => {
        state.status = {
          ...state.status,
          running: true,
          port,
          systemProxyEnabled: state.status.autoSystemProxy,
        };
        return structuredClone(state.status);
      }
    ),
    stopProxy: vi.fn(async (): Promise<ProxyStatus> => {
      state.status = {
        ...state.status,
        running: false,
        systemProxyEnabled: false,
      };
      return structuredClone(state.status);
    }),
    setAllowRemote: vi.fn(async (allow: boolean): Promise<ProxyStatus> => {
      state.status = {
        ...state.status,
        allowRemote: allow,
        bindMode: allow ? "all" : "loopback",
        bindAddr: allow ? "0.0.0.0" : "127.0.0.1",
      };
      return structuredClone(state.status);
    }),
    setBindConfiguration: vi.fn(
      async (
        bindMode: BindHostMode,
        specificBindIp?: string | null,
        alsoBindLoopback = true
      ): Promise<ProxyStatus> => {
        state.status = {
          ...state.status,
          bindMode,
          specificBindIp: specificBindIp ?? null,
          alsoBindLoopback,
          allowRemote: bindMode === "all",
          bindAddr:
            bindMode === "all"
              ? "0.0.0.0"
              : bindMode === "specific" && specificBindIp
                ? specificBindIp
                : "127.0.0.1",
        };
        return structuredClone(state.status);
      }
    ),
    getNetworkInterfaces: vi.fn(
      async (_includeVirtual = false): Promise<NetworkInterfaceInfo[]> => []
    ),
    setSystemProxy: vi.fn(async (enabled: boolean): Promise<ProxyStatus> => {
      state.status = { ...state.status, systemProxyEnabled: enabled };
      return structuredClone(state.status);
    }),
    setAutoSystemProxy: vi.fn(async (auto: boolean): Promise<ProxyStatus> => {
      state.status = {
        ...state.status,
        autoSystemProxy: auto,
        systemProxyEnabled: auto
          ? state.status.running
          : state.status.systemProxyEnabled,
      };
      return structuredClone(state.status);
    }),
    runProxyDoctor: vi.fn(async (): Promise<DoctorCheckResult[]> => []),
    fixDoctorIssue: vi.fn(
      async (_issueId: string): Promise<DoctorCheckResult[]> => []
    ),
    setPreviewPort: vi.fn(async (port: number): Promise<ProxyStatus> => {
      state.status = { ...state.status, port };
      return structuredClone(state.status);
    }),
    getSessions: vi.fn(async (): Promise<SessionSummary[]> =>
      structuredClone(state.sessions)
    ),
    getSessionDetail: vi.fn(async (id: number): Promise<SessionDetail | null> => {
      const detail = state.details.get(id) ?? null;
      return detail ? structuredClone(detail) : null;
    }),
    setSessionRetentionLimit: vi.fn(async (limit: number | null) => {
      state.stats = { ...state.stats, sessionRetentionLimit: limit };
    }),
    setDropNonMatching: vi.fn(async (enabled: boolean) => {
      state.stats = { ...state.stats, dropNonMatching: enabled };
    }),
    getMemoryStorageStats: vi.fn(async (): Promise<StorageStats> =>
      structuredClone(state.stats)
    ),
    clearSqliteDatabase: vi.fn(async (): Promise<StorageStats> =>
      structuredClone(state.stats)
    ),
    getClearDbOnExit: vi.fn(async (): Promise<boolean> => state.clearOnExit),
    setClearDbOnExit: vi.fn(async (enabled: boolean): Promise<boolean> => {
      state.clearOnExit = enabled;
      return enabled;
    }),
    loadSessionBody: vi.fn(
      async (id: number, isResponse: boolean): Promise<LoadedSessionBody> => {
        const entry = state.offloadedBodies.get(id);
        return {
          id,
          isResponse,
          bodyBase64: entry?.bodyBase64 ?? "",
          bodyText: entry?.bodyText ?? null,
          bodySize: entry?.bodySize ?? 0,
        };
      }
    ),
    clearSessions: vi.fn(async () => {
      state.sessions = [];
      state.details.clear();
    }),
    deleteSessions: vi.fn(async (ids: number[]): Promise<number> => {
      const idSet = new Set(ids);
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((s) => !idSet.has(s.id));
      for (const id of ids) state.details.delete(id);
      return before - state.sessions.length || ids.length;
    }),
    saveSessionsSqlite: vi.fn(async (): Promise<number> => 0),
    loadSessionsSqlite: vi.fn(async (): Promise<SessionSummary[]> => []),
    updateSessionAnnotations: vi.fn(
      async (
        _ids: number[],
        _comment: string | null,
        _markedColor: string | null
      ): Promise<SessionSummary[]> => []
    ),
    getCaInfo: vi.fn(
      async (): Promise<CaCertificateInfo> => ({
        certPemPath: "/tmp/fluxproxy-ca.pem",
        certCerPath: "/tmp/fluxproxy-ca.cer",
        sha256Fingerprint: "AA:BB:CC:DD",
        subject: "FluxProxy Root CA",
        validUntil: "2030-01-01",
        isTrusted: true,
        manualInstallCommand: null,
        trustStoreBackend: null,
      })
    ),
    installRootCa: vi.fn(async (): Promise<string> => "Installed"),
    uninstallRootCa: vi.fn(async (): Promise<string> => "Uninstalled"),
    listClientCertificates: vi.fn(
      async (): Promise<ClientCertificateEntry[]> =>
        structuredClone(state.clientCerts)
    ),
    addClientCertificate: vi.fn(
      async (
        req: AddClientCertificateInput
      ): Promise<ClientCertificateEntry> => {
        const entry: ClientCertificateEntry = {
          id: `cert-${Date.now()}`,
          domainPattern: req.domainPattern,
          label: req.label || req.domainPattern,
          format: req.keyPath ? "pem" : "pkcs12",
          storedCertPath: req.certPath,
          commonName: req.label || req.domainPattern,
          expiresAt: "2030-01-01",
          enabled: req.enabled ?? true,
          ephemeral: Boolean(req.ephemeral),
        };
        state.clientCerts.push(entry);
        return structuredClone(entry);
      }
    ),
    toggleClientCertificate: vi.fn(
      async (id: string, enabled: boolean): Promise<ClientCertificateEntry> => {
        const found = state.clientCerts.find((c) => c.id === id);
        if (!found) {
          throw new Error(`Client certificate ${id} not found`);
        }
        found.enabled = enabled;
        return structuredClone(found);
      }
    ),
    removeClientCertificate: vi.fn(
      async (id: string): Promise<ClientCertificateEntry[]> => {
        state.clientCerts = state.clientCerts.filter((c) => c.id !== id);
        return structuredClone(state.clientCerts);
      }
    ),
    listRules: vi.fn(async (): Promise<AutoResponderRule[]> =>
      structuredClone(state.autoRespRules)
    ),
    getAutoResponderEnabled: vi.fn(
      async (): Promise<boolean> => state.autoRespEnabled
    ),
    setAutoResponderEnabled: vi.fn(async (enabled: boolean): Promise<boolean> => {
      state.autoRespEnabled = enabled;
      return enabled;
    }),
    setAutoResponderConfig: vi.fn(
      async (
        enabled: boolean,
        rules: AutoResponderRule[]
      ): Promise<AutoResponderRule[]> => {
        state.autoRespEnabled = enabled;
        state.autoRespRules = structuredClone(rules);
        return structuredClone(rules);
      }
    ),
    upsertRule: vi.fn(
      async (rule: AutoResponderRule): Promise<AutoResponderRule[]> => {
        const idx = state.autoRespRules.findIndex((r) => r.id === rule.id);
        if (idx >= 0) {
          state.autoRespRules[idx] = structuredClone(rule);
        } else {
          state.autoRespRules.push(structuredClone(rule));
        }
        return structuredClone(state.autoRespRules);
      }
    ),
    deleteRule: vi.fn(async (id: string): Promise<AutoResponderRule[]> => {
      state.autoRespRules = state.autoRespRules.filter((r) => r.id !== id);
      return structuredClone(state.autoRespRules);
    }),
    getFilterBackendConfig: vi.fn(async (): Promise<ProxyFilterBackendConfig> =>
      structuredClone(state.filterCfg)
    ),
    updateFilterBackendConfig: vi.fn(
      async (
        config: ProxyFilterBackendConfig
      ): Promise<ProxyFilterBackendConfig> => {
        state.filterCfg = structuredClone(config);
        return structuredClone(config);
      }
    ),
    updateProxyFilterConfig: vi.fn(
      async (
        config: ProxyFilterBackendConfig
      ): Promise<ProxyFilterBackendConfig> => {
        state.filterCfg = structuredClone(config);
        return structuredClone(config);
      }
    ),
    getTlsRuleHitCounts: vi.fn(
      async (): Promise<Record<string, number>> => ({})
    ),
    resetTlsBypassRulesToRecommended: vi.fn(
      async (): Promise<ProxyFilterBackendConfig> =>
        structuredClone(state.filterCfg)
    ),
    getBreakpointConfig: vi.fn(async (): Promise<BreakpointConfig> =>
      structuredClone(state.bpCfg)
    ),
    updateBreakpointConfig: vi.fn(
      async (config: BreakpointConfig): Promise<BreakpointConfig> => {
        state.bpCfg = structuredClone(config);
        return structuredClone(config);
      }
    ),
    listPausedBreakpoints: vi.fn(async (): Promise<PausedBreakpointItem[]> =>
      structuredClone(state.pausedBreakpoints)
    ),
    resolveBreakpoint: vi.fn(
      async (_resolution: BreakpointResolution): Promise<boolean> => true
    ),
    resumeAllBreakpoints: vi.fn(
      async (_action: BreakpointAction = "continue"): Promise<number> => 0
    ),
    loadBreakpointBody: vi.fn(
      async (
        _breakpointId: string,
        _isResponse: boolean
      ): Promise<LoadedSessionBody | null> => null
    ),
    subscribeBreakpointsChanged: vi.fn(
      async (cb: (items: PausedBreakpointItem[]) => void) => {
        listeners.breakpoints.add(cb);
        return () => {
          listeners.breakpoints.delete(cb);
          unlistenSpies.breakpoints();
        };
      }
    ),
    codecTransform: vi.fn(
      async (
        _operation: CodecOperation,
        _input: string,
        _inputIsBase64 = false
      ): Promise<CodecTransformResult> => ({
        outputBase64: "",
        outputText: "",
        outputHex: "",
        inputBytes: 0,
        outputBytes: 0,
      })
    ),
    executeComposedRequest: vi.fn(
      async (req: ComposedRequest): Promise<SessionDetail> => {
        const nextId = 900 + state.sessions.length + 1;
        const urlObj = new URL(req.url);
        return {
          summary: {
            id: nextId,
            status: 200,
            protocol: "HTTPS/1.1",
            scheme: urlObj.protocol.replace(":", ""),
            method: req.method,
            host: urlObj.host,
            path: `${urlObj.pathname}${urlObj.search}`,
            url: req.url,
            contentType: "application/json",
            bodySize: 15,
            durationMs: 12,
            timestamp: "2026-11-19T12:00:00.000Z",
            isMocked: false,
          },
          requestHeaders: req.headers,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }],
          requestBodyBase64: req.bodyBase64 ?? "",
          responseBodyBase64: btoa('{"ok":true}'),
          requestBodyText: req.body,
          responseBodyText: '{"ok":true}',
          clientAddr: "127.0.0.1:50000",
          websocketFrames: [],
        };
      }
    ),
    subscribeSessionBatches: vi.fn(
      async (cb: (batch: SessionSummary[]) => void) => {
        listeners.batches.add(cb);
        return () => {
          listeners.batches.delete(cb);
          unlistenSpies.batches();
        };
      }
    ),
    subscribeSessionsRemoved: vi.fn(async (cb: (ids: number[]) => void) => {
      listeners.removed.add(cb);
      return () => {
        listeners.removed.delete(cb);
        unlistenSpies.removed();
      };
    }),
    subscribeStatusChanged: vi.fn(async (cb: (status: ProxyStatus) => void) => {
      listeners.status.add(cb);
      return () => {
        listeners.status.delete(cb);
        unlistenSpies.status();
      };
    }),
    subscribeStorageStatsChanged: vi.fn(
      async (cb: (stats: StorageStats) => void) => {
        listeners.stats.add(cb);
        return () => {
          listeners.stats.delete(cb);
          unlistenSpies.stats();
        };
      }
    ),
    pickSaveFileDialog: vi.fn(
      async (_options: {
        title?: string;
        defaultName?: string;
        filters: FileDialogFilter[];
      }): Promise<string | null> => null
    ),
    pickOpenFileDialog: vi.fn(
      async (_options: {
        title?: string;
        filters: FileDialogFilter[];
      }): Promise<string | null> => null
    ),
    exportSessionsFile: vi.fn(
      async (
        _sessionIds: number[],
        _format: string,
        _filePath: string,
        _sanitization?: SanitizationOptions | null,
        _includeEvictedSqlite = false
      ): Promise<number> => 0
    ),
    importSessionsFile: vi.fn(
      async (_filePath: string): Promise<SessionSummary[]> => []
    ),
    importSessionsBytes: vi.fn(
      async (
        _fileName: string,
        _bytes: Uint8Array
      ): Promise<SessionSummary[]> => []
    ),
    saveSessionBodyFile: vi.fn(
      async (
        _sessionId: number,
        _isResponse: boolean,
        _filePath: string
      ): Promise<number> => 0
    ),
    exportSettingsJsonFile: vi.fn(
      async (_filePath: string, _jsonContent: string): Promise<void> =>
        undefined
    ),
    exportTextFile: vi.fn(
      async (
        _filePath: string,
        _contents: string,
        _mimeType?: string
      ): Promise<void> => undefined
    ),
    readSettingsJsonFile: vi.fn(async (_filePath: string): Promise<string> => "{}"),
    subscribeNativeFileDrop: vi.fn(
      async (cb: (payload: NativeDragDropPayload) => void) => {
        listeners.fileDrop.add(cb);
        return () => {
          listeners.fileDrop.delete(cb);
          unlistenSpies.fileDrop();
        };
      }
    ),
    setPythonScript: vi.fn(
      async (code: string, enabled: boolean): Promise<PythonRunnerStatus> => {
        state.pythonStatus = { ...state.pythonStatus, code, enabled };
        return structuredClone(state.pythonStatus);
      }
    ),
    getPythonRunnerStatus: vi.fn(
      async (): Promise<PythonRunnerStatus> =>
        structuredClone(state.pythonStatus)
    ),
    subscribeScriptConsoleLogs: vi.fn(
      async (cb: (entry: ScriptConsoleLogEvent) => void) => {
        listeners.scriptLogs.add(cb);
        return () => {
          listeners.scriptLogs.delete(cb);
          unlistenSpies.scriptLogs();
        };
      }
    ),
    generateStressTestSessions: vi.fn(
      async (_count = 10_000): Promise<number> => 0
    ),
    getHostRemapRules: vi.fn(async (): Promise<HostRemapRule[]> =>
      structuredClone(state.hostRemapRules)
    ),
    updateHostRemapRules: vi.fn(
      async (rules: HostRemapRule[]): Promise<HostRemapRule[]> => {
        state.hostRemapRules = structuredClone(rules);
        return structuredClone(rules);
      }
    ),
    getThrottleConfig: vi.fn(async (): Promise<ThrottleConfig> =>
      structuredClone(state.throttleConfig)
    ),
    setThrottleConfig: vi.fn(
      async (config: ThrottleConfig): Promise<ThrottleConfig> => {
        state.throttleConfig = structuredClone(config);
        return structuredClone(config);
      }
    ),
    getUpstreamProxyConfig: vi.fn(async (): Promise<UpstreamProxyConfig> =>
      structuredClone(state.upstreamProxyConfig)
    ),
    setUpstreamProxyConfig: vi.fn(
      async (config: UpstreamProxyConfig): Promise<UpstreamProxyConfig> => {
        const next: UpstreamProxyConfig = {
          enabled: config.enabled,
          protocol: config.protocol,
          host: config.host,
          port: config.port,
          username: config.username ?? null,
          hasPassword:
            config.password === "" || config.password === null
              ? false
              : typeof config.password === "string" && config.password.length > 0
                ? true
                : Boolean(state.upstreamProxyConfig.hasPassword),
          bypassList: [...(config.bypassList ?? [])],
        };
        state.upstreamProxyConfig = structuredClone(next);
        return structuredClone(next);
      }
    ),
    getUpstreamTimeouts: vi.fn(async (): Promise<UpstreamTimeoutConfig> =>
      structuredClone(state.upstreamTimeouts)
    ),
    setUpstreamTimeouts: vi.fn(
      async (config: UpstreamTimeoutConfig): Promise<UpstreamTimeoutConfig> => {
        state.upstreamTimeouts = structuredClone(config);
        return structuredClone(config);
      }
    ),
    cancelComposedRequest: vi.fn(
      async (_requestId: string): Promise<boolean> => true
    ),
    injectWebSocketFrame: vi.fn(
      async (
        _sessionId: number,
        direction: WsInjectDirection,
        opcode: WsInjectOpcode,
        payload: string
      ): Promise<WebSocketFrameRecord> => ({
        index: 1,
        direction: direction === "client" ? "outbound" : "inbound",
        opcode,
        payloadPreview: payload,
        byteLength: payload.length,
        timestamp: "2026-11-19T12:00:00.000Z",
        injected: true,
      })
    ),
    triggerSimulatedTrafficHit: vi.fn((): void => undefined),
  } satisfies ProxyBridgeType;

  const reset = (nextOverrides: Partial<MockProxyState> = {}) => {
    state.status = createDefaultMockStatus();
    state.sessions = [];
    state.details.clear();
    state.offloadedBodies.clear();
    state.stats = createDefaultMockStats();
    state.filterCfg = structuredClone(DEFAULT_BACKEND_FILTER_CONFIG);
    state.bpCfg = structuredClone(DEFAULT_BREAKPOINT_CONFIG);
    state.pausedBreakpoints = [];
    state.autoRespEnabled = true;
    state.autoRespRules = structuredClone(DEFAULT_AUTORESPONDER_RULES);
    state.clearOnExit = DEFAULT_CLEAR_DB_ON_EXIT;
    state.pythonStatus = {
      available: false,
      enabled: false,
      running: false,
      pythonExecutable: null,
      pythonVersion: null,
      workerPid: null,
      hasOnRequest: false,
      hasOnResponse: false,
      timeoutMs: 1500,
      lastError: null,
      restartCount: 0,
      invocationsCount: 0,
      timeoutCount: 0,
      isSimulator: true,
      code: DEFAULT_PYTHON_SCRIPT_CODE,
    };
    state.hostRemapRules = [];
    state.throttleConfig = structuredClone(DEFAULT_THROTTLE_CONFIG);
    state.upstreamProxyConfig = {
      ...structuredClone(DEFAULT_UPSTREAM_PROXY_CONFIG),
      bypassList: [...DEFAULT_UPSTREAM_PROXY_BYPASS_LIST],
    };
    state.upstreamTimeouts = structuredClone(DEFAULT_UPSTREAM_TIMEOUT_CONFIG);
    state.clientCerts = [];
    Object.assign(state, nextOverrides);

    listeners.batches.clear();
    listeners.removed.clear();
    listeners.breakpoints.clear();
    listeners.status.clear();
    listeners.stats.clear();
    listeners.scriptLogs.clear();
    listeners.fileDrop.clear();
  };

  return {
    bridge: baseBridge,
    state,
    listeners,
    unlistenSpies,
    reset,
  };
}

export function createMockProxyBridge(
  overrides: Partial<ProxyBridgeType> = {},
  initialStateOverrides: Partial<MockProxyState> = {}
) {
  const { bridge } = createStatefulMockProxyBridge(initialStateOverrides);
  const merged = {
    ...bridge,
    ...overrides,
  } satisfies ProxyBridgeType;
  return merged;
}

export type StatefulMockProxyBridge = ReturnType<
  typeof createStatefulMockProxyBridge
>;
