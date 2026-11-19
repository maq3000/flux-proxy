import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AutoResponderRule,
  BreakpointConfig,
  ProxyFilterBackendConfig,
  ProxyStatus,
  PythonRunnerStatus,
  StorageStats,
} from "../types/proxy";
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  PROXY_STATUS_SYNCED_EVENT,
  SETTINGS_APPLIED_EVENT,
  type FluxUserSettingsProfile,
} from "../types/settings";
import { DEFAULT_BACKEND_FILTER_CONFIG } from "./filterEngine";
import { DEFAULT_AUTORESPONDER_RULES, DEFAULT_PYTHON_SCRIPT_CODE } from "./mockTraffic";

const { mockState, mockProxyBridge, mockDefaultBpConfig } = vi.hoisted(() => {
  const defaultBp: BreakpointConfig = {
    breakBeforeRequest: false,
    breakAfterResponse: false,
    timeoutSecs: 120,
    rules: [],
  };

  const state = {
    status: {
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
    } as ProxyStatus,
    filterCfg: null as unknown as ProxyFilterBackendConfig,
    bpCfg: structuredClone(defaultBp) as BreakpointConfig,
    autoRespEnabled: true,
    autoRespRules: [] as AutoResponderRule[],
    stats: {
      ramSessions: 10,
      sqliteSizeBytes: 1024,
      droppedSessionsCount: 0,
      sessionRetentionLimit: 10_000,
      dropNonMatching: false,
    } as StorageStats,
    clearOnExit: false,
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
      code: "",
    } as PythonRunnerStatus,
  };

  const bridge = {
    getStatus: vi.fn(async () => structuredClone(state.status)),
    getFilterBackendConfig: vi.fn(async () => structuredClone(state.filterCfg)),
    getBreakpointConfig: vi.fn(async () => structuredClone(state.bpCfg)),
    getAutoResponderEnabled: vi.fn(async () => state.autoRespEnabled),
    listRules: vi.fn(async () => structuredClone(state.autoRespRules)),
    getMemoryStorageStats: vi.fn(async () => structuredClone(state.stats)),
    getClearDbOnExit: vi.fn(async () => state.clearOnExit),
    getPythonRunnerStatus: vi.fn(async () => structuredClone(state.pythonStatus)),
    updateProxyFilterConfig: vi.fn(async (cfg: ProxyFilterBackendConfig) => {
      state.filterCfg = structuredClone(cfg);
      return structuredClone(cfg);
    }),
    updateBreakpointConfig: vi.fn(async (cfg: BreakpointConfig) => {
      state.bpCfg = structuredClone(cfg);
      return structuredClone(cfg);
    }),
    setAutoResponderConfig: vi.fn(
      async (enabled: boolean, rules: AutoResponderRule[]) => {
        state.autoRespEnabled = enabled;
        state.autoRespRules = structuredClone(rules);
        return structuredClone(rules);
      }
    ),
    setSessionRetentionLimit: vi.fn(async (limit: number | null) => {
      state.stats = { ...state.stats, sessionRetentionLimit: limit };
    }),
    setDropNonMatching: vi.fn(async (enabled: boolean) => {
      state.stats = { ...state.stats, dropNonMatching: enabled };
    }),
    setClearDbOnExit: vi.fn(async (enabled: boolean) => {
      state.clearOnExit = enabled;
      return enabled;
    }),
    setPythonScript: vi.fn(async (code: string, enabled: boolean) => {
      state.pythonStatus = { ...state.pythonStatus, code, enabled };
      return structuredClone(state.pythonStatus);
    }),
    setAutoSystemProxy: vi.fn(async (auto: boolean) => {
      state.status = {
        ...state.status,
        autoSystemProxy: auto,
        systemProxyEnabled: auto ? state.status.running : state.status.systemProxyEnabled,
      };
      return structuredClone(state.status);
    }),
    setSystemProxy: vi.fn(async (enabled: boolean) => {
      state.status = { ...state.status, systemProxyEnabled: enabled };
      return structuredClone(state.status);
    }),
    setBindConfiguration: vi.fn(
      async (
        bindMode: ProxyStatus["bindMode"],
        specificBindIp?: string | null,
        alsoBindLoopback = true
      ) => {
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
    stopProxy: vi.fn(async () => {
      state.status = { ...state.status, running: false, systemProxyEnabled: false };
      return structuredClone(state.status);
    }),
    startProxy: vi.fn(async (_host?: string, port = 8888) => {
      state.status = {
        ...state.status,
        running: true,
        port,
        systemProxyEnabled: state.status.autoSystemProxy,
      };
      return structuredClone(state.status);
    }),
    setPreviewPort: vi.fn(async (port: number) => {
      state.status = { ...state.status, port };
      return structuredClone(state.status);
    }),
    pickSaveFileDialog: vi.fn(async () => null),
    exportSettingsJsonFile: vi.fn(async () => undefined),
  };

  return {
    mockState: state,
    mockProxyBridge: bridge,
    mockDefaultBpConfig: defaultBp,
  };
});

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

vi.mock("./tauriBridge", () => ({
  DEFAULT_BREAKPOINT_CONFIG: mockDefaultBpConfig,
  proxyBridge: mockProxyBridge,
}));

import {
  SETTINGS_STORAGE_KEYS,
  applySettingsProfile,
  buildBackendFilterConfigFromProfile,
  buildSettingsImportPreview,
  collectCurrentSettingsProfile,
  createDefaultSettingsProfile,
  isLikelyFluxSettingsProfile,
  parseAndValidateSettingsJsonText,
  registerLiveSettingsSnapshotGetter,
  resetAllSettingsToDefault,
  validateAndMigrateSettingsProfileWithReport,
} from "./settingsManager";

function resetMockState(): void {
  mockState.status = {
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
  mockState.filterCfg = structuredClone(DEFAULT_BACKEND_FILTER_CONFIG);
  mockState.bpCfg = structuredClone(mockDefaultBpConfig);
  mockState.autoRespEnabled = true;
  mockState.autoRespRules = structuredClone(DEFAULT_AUTORESPONDER_RULES);
  mockState.stats = {
    ramSessions: 10,
    sqliteSizeBytes: 1024,
    droppedSessionsCount: 0,
    sessionRetentionLimit: 10_000,
    dropNonMatching: false,
  };
  mockState.clearOnExit = false;
  mockState.pythonStatus = {
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
}

describe("settingsManager — schema validation, migration & BreakpointConfig", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetMockState();
    vi.clearAllMocks();
  });

  afterEach(() => {
    registerLiveSettingsSnapshotGetter(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("identifies FluxProxy settings profiles vs HAR archives and rejects invalid inputs", () => {
    expect(isLikelyFluxSettingsProfile(createDefaultSettingsProfile())).toBe(true);
    expect(isLikelyFluxSettingsProfile({ ui: {}, breakpoints: {} })).toBe(true);
    expect(isLikelyFluxSettingsProfile({ log: { entries: [] } })).toBe(false);
    expect(isLikelyFluxSettingsProfile({})).toBe(false);

    expect(() => parseAndValidateSettingsJsonText("   ")).toThrow();
    expect(() => parseAndValidateSettingsJsonText("{bad json")).toThrow();
    expect(() =>
      validateAndMigrateSettingsProfileWithReport({ log: { version: "1.2" } })
    ).toThrow(/har/i);
    expect(() =>
      validateAndMigrateSettingsProfileWithReport({ schemaVersion: 99 })
    ).toThrow(/новее/i);
    expect(() =>
      validateAndMigrateSettingsProfileWithReport({ unrelated: true })
    ).toThrow();
  });

  it("migrates legacy v0 profiles (including breakpointConfig, BOM, allowRemote, and clearDbOnExit)", () => {
    const legacyJson =
      "\uFEFF" +
      JSON.stringify({
        theme: "light",
        port: 9090,
        allowRemote: true,
        clearDbOnExit: true,
        customPresets: [],
        breakpointConfig: {
          breakBeforeRequest: true,
          breakAfterResponse: false,
          timeoutSecs: 45,
          rules: [
            {
              id: "bp-legacy",
              enabled: true,
              stage: "both",
              urlPattern: "*/v1/checkout*",
              methodFilter: "post",
            },
          ],
        },
        autoResponderRules: [],
      });

    const report = parseAndValidateSettingsJsonText(legacyJson);
    expect(report.migratedFromVersion).toBe(0);
    expect(report.profile.schemaVersion).toBe(CURRENT_SETTINGS_SCHEMA_VERSION);
    expect(report.profile.ui.theme).toBe("light");
    expect(report.profile.proxy.port).toBe(9090);
    expect(report.profile.proxy.bindMode).toBe("all");
    expect(report.profile.proxy.allowRemote).toBe(true);
    expect(report.profile.proxy.clearDbOnExit).toBe(true);
    expect(report.profile.breakpoints).toEqual({
      breakBeforeRequest: true,
      breakAfterResponse: false,
      timeoutSecs: 45,
      rules: [
        {
          id: "bp-legacy",
          enabled: true,
          name: "bpu */v1/checkout*",
          stage: "both",
          urlPattern: "*/v1/checkout*",
          methodFilter: "POST",
        },
      ],
    });
    expect(report.warnings.some((w) => w.includes("v0 → v1"))).toBe(true);
  });

  it("recovers damaged fields and validates BreakpointConfig rules and bounds", () => {
    const report = validateAndMigrateSettingsProfileWithReport({
      schemaVersion: 1,
      ui: {
        theme: "neon-pink",
        themePreset: "invalid-preset",
        customColorOverrides: {
          "--accent-primary": "#AbC",
          "--bg-canvas": "bad-hex",
          "--unknown": "#111111",
        },
        visibleColumns: {
          id: false,
          status: false,
          method: false,
          protocol: false,
          host: false,
          url: false,
          process: false,
          size: false,
          time: false,
          comment: false,
        },
      },
      filters: {
        noiseThresholds: {
          timeHeatWarningMs: 1000,
          timeHeatCriticalMs: 200,
        },
      },
      proxy: {
        port: 99999,
        bindMode: "specific",
        specificBindIp: null,
        breakpoints: {
          breakBeforeRequest: "yes",
          breakAfterResponse: true,
          timeoutSecs: 9999,
          rules: [
            null,
            { urlPattern: "   " },
            {
              urlPattern: "api.test/pay",
              stage: "invalid-stage",
              methodFilter: "put",
            },
          ],
        },
      },
    });

    expect(report.profile.ui.theme).toBe("dark");
    expect(report.profile.ui.customColorOverrides).toEqual({
      "--accent-primary": "#aabbcc",
    });
    expect(report.profile.ui.visibleColumns.id).toBe(true);
    expect(report.profile.ui.visibleColumns.url).toBe(true);
    expect(report.profile.filters.noiseThresholds.timeHeatCriticalMs).toBe(1000);
    expect(report.profile.proxy.port).toBe(8888);
    expect(report.profile.proxy.bindMode).toBe("loopback");
    expect(report.profile.breakpoints).toEqual({
      breakBeforeRequest: false,
      breakAfterResponse: true,
      timeoutSecs: 120,
      rules: [
        {
          id: "bp-imported-3",
          enabled: true,
          name: "bpu api.test/pay",
          stage: "request",
          urlPattern: "api.test/pay",
          methodFilter: "PUT",
        },
      ],
    });
    expect(report.warnings.length).toBeGreaterThanOrEqual(6);
  });

  it("collects live snapshot, builds import preview, and builds backend filter config", () => {
    const unregister = registerLiveSettingsSnapshotGetter(() => ({
      proxy: {
        port: 7777,
        autoSystemProxy: false,
        allowRemote: false,
        tlsInterceptMode: "targetedOnly",
        tlsBypassRules: [],
        tlsTargetRules: [],
        headerMutations: [],
      },
      breakpoints: {
        breakBeforeRequest: true,
        breakAfterResponse: false,
        timeoutSecs: 60,
        rules: [
          {
            id: "bp-live",
            enabled: true,
            name: "live",
            stage: "request",
            urlPattern: "live.test",
            methodFilter: null,
          },
        ],
      },
    }));

    const collected = collectCurrentSettingsProfile();
    unregister();

    expect(collected.proxy.port).toBe(7777);
    expect(collected.breakpoints?.rules[0].id).toBe("bp-live");

    const preview = buildSettingsImportPreview(collected, {
      fileName: "team.json",
    });
    expect(preview.fileName).toBe("team.json");
    expect(preview.proxyPort).toBe(7777);
    expect(preview.tlsInterceptMode).toBe("targetedOnly");

    const backendCfg = buildBackendFilterConfigFromProfile(collected);
    expect(backendCfg.tlsInterceptMode).toBe("targetedOnly");
  });
});

describe("settingsManager — applySettingsProfile & transactional rollback", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetMockState();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("applies full profile including BreakpointConfig, persists localStorage, and broadcasts events", async () => {
    vi.useFakeTimers();

    const appliedEvents: FluxUserSettingsProfile[] = [];
    const statusEvents: ProxyStatus[] = [];
    const onApplied = (e: Event) => {
      appliedEvents.push((e as CustomEvent<FluxUserSettingsProfile>).detail);
    };
    const onStatus = (e: Event) => {
      statusEvents.push((e as CustomEvent<ProxyStatus>).detail);
    };
    window.addEventListener(SETTINGS_APPLIED_EVENT, onApplied);
    window.addEventListener(PROXY_STATUS_SYNCED_EVENT, onStatus);

    try {
      const nextProfile = createDefaultSettingsProfile();
      nextProfile.proxy.port = 9091;
      nextProfile.proxy.autoSystemProxy = false;
      nextProfile.proxy.bindMode = "all";
      nextProfile.proxy.allowRemote = true;
      nextProfile.breakpoints = {
        breakBeforeRequest: true,
        breakAfterResponse: true,
        timeoutSecs: 90,
        rules: [
          {
            id: "bp-1",
            enabled: true,
            name: "bpu /pay",
            stage: "request",
            urlPattern: "/pay",
            methodFilter: "POST",
          },
        ],
      };

      const applied = await applySettingsProfile(nextProfile);
      vi.runOnlyPendingTimers();

      expect(applied.proxy.port).toBe(9091);
      expect(mockProxyBridge.updateBreakpointConfig).toHaveBeenCalledWith(
        nextProfile.breakpoints
      );
      expect(mockProxyBridge.setBindConfiguration).toHaveBeenCalledWith(
        "all",
        null,
        true
      );
      expect(mockProxyBridge.stopProxy).toHaveBeenCalledTimes(1);
      expect(mockProxyBridge.startProxy).toHaveBeenCalledWith(undefined, 9091);

      expect(
        JSON.parse(
          window.localStorage.getItem(SETTINGS_STORAGE_KEYS.breakpointConfig) ??
            "null"
        )
      ).toEqual(nextProfile.breakpoints);
      expect(
        JSON.parse(
          window.localStorage.getItem(SETTINGS_STORAGE_KEYS.proxyPort) ?? "0"
        )
      ).toBe(9091);

      expect(appliedEvents).toHaveLength(1);
      expect(appliedEvents[0].breakpoints?.timeoutSecs).toBe(90);
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0].port).toBe(9091);
    } finally {
      window.removeEventListener(SETTINGS_APPLIED_EVENT, onApplied);
      window.removeEventListener(PROXY_STATUS_SYNCED_EVENT, onStatus);
    }
  });

  it("rolls back all backend IPC changes without touching localStorage when startProxy fails", async () => {
    const initialBp: BreakpointConfig = {
      breakBeforeRequest: false,
      breakAfterResponse: true,
      timeoutSecs: 75,
      rules: [
        {
          id: "bp-prev",
          enabled: true,
          name: "prev",
          stage: "response",
          urlPattern: "prev.test",
          methodFilter: "GET",
        },
      ],
    };
    mockState.bpCfg = structuredClone(initialBp);
    window.localStorage.setItem(SETTINGS_STORAGE_KEYS.proxyPort, "8888");
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEYS.breakpointConfig,
      JSON.stringify(initialBp)
    );

    const appliedEvents: Event[] = [];
    const statusEvents: ProxyStatus[] = [];
    const onApplied = (e: Event) => appliedEvents.push(e);
    const onStatus = (e: Event) =>
      statusEvents.push((e as CustomEvent<ProxyStatus>).detail);
    window.addEventListener(SETTINGS_APPLIED_EVENT, onApplied);
    window.addEventListener(PROXY_STATUS_SYNCED_EVENT, onStatus);

    // Fail only the new port start, succeed on rollback start(undefined, 8888)
    mockProxyBridge.startProxy.mockImplementation(
      async (_host?: string, port = 8888) => {
        if (port === 9999) {
          throw new Error("EADDRINUSE :9999");
        }
        mockState.status = {
          ...mockState.status,
          running: true,
          port,
          systemProxyEnabled: mockState.status.autoSystemProxy,
        };
        return structuredClone(mockState.status);
      }
    );

    try {
      const next = createDefaultSettingsProfile();
      next.proxy.port = 9999;
      next.proxy.autoSystemProxy = false;
      next.proxy.bindMode = "all";
      next.proxy.allowRemote = true;
      next.breakpoints = {
        breakBeforeRequest: true,
        breakAfterResponse: false,
        timeoutSecs: 30,
        rules: [],
      };

      await expect(applySettingsProfile(next)).rejects.toThrow(
        /EADDRINUSE :9999.*выполнен полный откат параметров бэкенда/
      );

      expect(mockState.bpCfg).toEqual(initialBp);
      expect(mockState.status.port).toBe(8888);
      expect(mockState.status.running).toBe(true);
      expect(mockState.status.bindMode).toBe("loopback");
      expect(mockState.status.autoSystemProxy).toBe(true);
      expect(mockState.status.systemProxyEnabled).toBe(true);

      // localStorage must remain untouched and SETTINGS_APPLIED_EVENT must not fire
      expect(
        window.localStorage.getItem(SETTINGS_STORAGE_KEYS.proxyPort)
      ).toBe("8888");
      expect(appliedEvents).toHaveLength(0);
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0].port).toBe(8888);
    } finally {
      window.removeEventListener(SETTINGS_APPLIED_EVENT, onApplied);
      window.removeEventListener(PROXY_STATUS_SYNCED_EVENT, onStatus);
    }
  });

  it("rolls back both localStorage and backend state if localStorage throws mid-write", async () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEYS.proxyPort, "8888");
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEYS.breakpointConfig,
      JSON.stringify(mockDefaultBpConfig)
    );

    const origSetItem = Storage.prototype.setItem;
    let writes = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      writes += 1;
      if (writes === 5) {
        throw new Error("QuotaExceededError");
      }
      return origSetItem.call(this, key, value);
    });

    const next = createDefaultSettingsProfile();
    next.ui.theme = "light";
    next.proxy.port = 9191;
    next.breakpoints = {
      breakBeforeRequest: true,
      breakAfterResponse: false,
      timeoutSecs: 55,
      rules: [],
    };

    await expect(applySettingsProfile(next)).rejects.toThrow(
      /QuotaExceededError.*выполнен полный откат/
    );

    expect(
      window.localStorage.getItem(SETTINGS_STORAGE_KEYS.theme)
    ).toBeNull();
    expect(
      window.localStorage.getItem(SETTINGS_STORAGE_KEYS.proxyPort)
    ).toBe("8888");
    expect(mockState.bpCfg).toEqual(mockDefaultBpConfig);
    expect(mockState.status.port).toBe(8888);
  });

  it("reports partial rollback errors clearly when rollback IPC fails", async () => {
    mockProxyBridge.updateBreakpointConfig
      .mockResolvedValueOnce(structuredClone(mockDefaultBpConfig))
      .mockRejectedValueOnce(new Error("bp rollback failed"));
    mockProxyBridge.setPreviewPort.mockRejectedValueOnce(
      new Error("port failed")
    );
    mockState.status.running = false;

    const next = createDefaultSettingsProfile();
    next.proxy.port = 9443;

    await expect(applySettingsProfile(next)).rejects.toThrow(
      /при откате возникли ошибки.*точки останова: bp rollback failed/
    );
  });

  it("handles resetAllSettingsToDefault confirmation cancellation and skipConfirm", async () => {
    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    expect(await resetAllSettingsToDefault()).toBe(false);
    expect(mockProxyBridge.updateBreakpointConfig).not.toHaveBeenCalled();

    vi.useFakeTimers();
    expect(await resetAllSettingsToDefault({ skipConfirm: true })).toBe(true);
    vi.runOnlyPendingTimers();
    expect(mockProxyBridge.updateBreakpointConfig).toHaveBeenCalledTimes(1);
  });
});
