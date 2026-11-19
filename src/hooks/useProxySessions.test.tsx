import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BreakpointConfig,
  ComposedRequest,
  PausedBreakpointItem,
  ProxyFilterBackendConfig,
  ProxyStatus,
  SessionDetail,
  SessionSummary,
  StorageStats,
} from "../types/proxy";
import { DEFAULT_BACKEND_FILTER_CONFIG } from "../lib/filterEngine";

const {
  mockDefaultBp,
  mockState,
  listeners,
  unlistenSpies,
  mockProxyBridge,
} = vi.hoisted(() => {
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
    sessions: [] as SessionSummary[],
    details: new Map<number, SessionDetail>(),
    offloadedBodies: new Map<
      number,
      { bodyBase64: string; bodyText: string | null; bodySize: number }
    >(),
    stats: {
      ramSessions: 0,
      sqliteSizeBytes: 0,
      droppedSessionsCount: 0,
      sessionRetentionLimit: 10_000,
      dropNonMatching: false,
    } as StorageStats,
    filterCfg: null as unknown as ProxyFilterBackendConfig,
    bpCfg: structuredClone(defaultBp) as BreakpointConfig,
    clearOnExit: false,
  };

  const listenerSets = {
    batches: new Set<(batch: SessionSummary[]) => void>(),
    removed: new Set<(ids: number[]) => void>(),
    breakpoints: new Set<(items: PausedBreakpointItem[]) => void>(),
    status: new Set<(status: ProxyStatus) => void>(),
    stats: new Set<(stats: StorageStats) => void>(),
  };

  const unlistenCounts = {
    batches: vi.fn(),
    removed: vi.fn(),
    breakpoints: vi.fn(),
    status: vi.fn(),
    stats: vi.fn(),
  };

  const bridge = {
    setSessionRetentionLimit: vi.fn(async (limit: number | null) => {
      state.stats = { ...state.stats, sessionRetentionLimit: limit };
    }),
    updateFilterBackendConfig: vi.fn(async (cfg: ProxyFilterBackendConfig) => {
      state.filterCfg = structuredClone(cfg);
      return structuredClone(cfg);
    }),
    updateBreakpointConfig: vi.fn(async (cfg: BreakpointConfig) => {
      state.bpCfg = structuredClone(cfg);
      return structuredClone(cfg);
    }),
    listPausedBreakpoints: vi.fn(async () => [] as PausedBreakpointItem[]),
    setDropNonMatching: vi.fn(async (enabled: boolean) => {
      state.stats = { ...state.stats, dropNonMatching: enabled };
    }),
    getClearDbOnExit: vi.fn(async () => state.clearOnExit),
    setClearDbOnExit: vi.fn(async (enabled: boolean) => {
      state.clearOnExit = enabled;
      return enabled;
    }),
    getStatus: vi.fn(async () => structuredClone(state.status)),
    getSessions: vi.fn(async () => structuredClone(state.sessions)),
    getMemoryStorageStats: vi.fn(async () => structuredClone(state.stats)),
    setAutoSystemProxy: vi.fn(async (auto: boolean) => {
      state.status = { ...state.status, autoSystemProxy: auto };
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
    subscribeSessionBatches: vi.fn(
      async (cb: (batch: SessionSummary[]) => void) => {
        listenerSets.batches.add(cb);
        return () => {
          listenerSets.batches.delete(cb);
          unlistenCounts.batches();
        };
      }
    ),
    subscribeSessionsRemoved: vi.fn(async (cb: (ids: number[]) => void) => {
      listenerSets.removed.add(cb);
      return () => {
        listenerSets.removed.delete(cb);
        unlistenCounts.removed();
      };
    }),
    subscribeBreakpointsChanged: vi.fn(
      async (cb: (items: PausedBreakpointItem[]) => void) => {
        listenerSets.breakpoints.add(cb);
        return () => {
          listenerSets.breakpoints.delete(cb);
          unlistenCounts.breakpoints();
        };
      }
    ),
    subscribeStatusChanged: vi.fn(async (cb: (s: ProxyStatus) => void) => {
      listenerSets.status.add(cb);
      return () => {
        listenerSets.status.delete(cb);
        unlistenCounts.status();
      };
    }),
    subscribeStorageStatsChanged: vi.fn(
      async (cb: (s: StorageStats) => void) => {
        listenerSets.stats.add(cb);
        return () => {
          listenerSets.stats.delete(cb);
          unlistenCounts.stats();
        };
      }
    ),
    getSessionDetail: vi.fn(async (id: number) => {
      const detail = state.details.get(id) ?? null;
      return detail ? structuredClone(detail) : null;
    }),
    loadSessionBody: vi.fn(async (id: number, isResponse: boolean) => {
      const entry = state.offloadedBodies.get(id);
      return {
        id,
        isResponse,
        bodyBase64: entry?.bodyBase64 ?? "",
        bodyText: entry?.bodyText ?? null,
        bodySize: entry?.bodySize ?? 0,
      };
    }),
    executeComposedRequest: vi.fn(
      async (req: ComposedRequest): Promise<SessionDetail> => {
        const nextId = 900 + state.sessions.length + 1;
        const urlObj = new URL(req.url);
        const created: SessionDetail = {
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
        return created;
      }
    ),
    updateSessionAnnotations: vi.fn(async () => []),
    deleteSessions: vi.fn(async (ids: number[]) => ids.length),
    clearSessions: vi.fn(async () => undefined),
    saveSessionsSqlite: vi.fn(async () => 0),
    loadSessionsSqlite: vi.fn(async () => [] as SessionSummary[]),
    clearSqliteDatabase: vi.fn(async () => structuredClone(state.stats)),
    resolveBreakpoint: vi.fn(async () => true),
    resumeAllBreakpoints: vi.fn(async () => 0),
    generateStressTestSessions: vi.fn(async () => 0),
    pickSaveFileDialog: vi.fn(async () => null),
    exportSessionsFile: vi.fn(async () => 0),
    pickOpenFileDialog: vi.fn(async () => null),
    importSessionsFile: vi.fn(async () => [] as SessionSummary[]),
    importSessionsBytes: vi.fn(async () => [] as SessionSummary[]),
    saveSessionBodyFile: vi.fn(async () => 0),
  };

  return {
    mockDefaultBp: defaultBp,
    mockState: state,
    listeners: listenerSets,
    unlistenSpies: unlistenCounts,
    mockProxyBridge: bridge,
  };
});

vi.mock("../lib/tauriBridge", () => ({
  DEFAULT_BREAKPOINT_CONFIG: mockDefaultBp,
  isTauriRuntime: () => false,
  proxyBridge: mockProxyBridge,
}));

import { useProxySessions } from "./useProxySessions";

function makeSessionSummary(
  id: number,
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    id,
    status: 200,
    protocol: "HTTPS/1.1",
    scheme: "https",
    method: "GET",
    host: "api.example.com",
    path: `/v1/item/${id}`,
    url: `https://api.example.com/v1/item/${id}`,
    contentType: "application/json",
    bodySize: 32,
    durationMs: 20,
    timestamp: "2026-11-19T12:00:00.000Z",
    isMocked: false,
    ...overrides,
  };
}

function makeSessionDetail(
  summaryOverrides: Partial<SessionSummary>,
  detailOverrides: Partial<Omit<SessionDetail, "summary">> = {}
): SessionDetail {
  const summary = makeSessionSummary(summaryOverrides.id ?? 1, summaryOverrides);
  return {
    summary,
    requestHeaders: [{ name: "Accept", value: "application/json" }],
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    requestBodyBase64: "",
    responseBodyBase64: "",
    requestBodyText: null,
    responseBodyText: '{"ok":true}',
    clientAddr: "127.0.0.1:50000",
    websocketFrames: [],
    ...detailOverrides,
  };
}

function resetHookEnv(): void {
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
  mockState.sessions = [];
  mockState.details.clear();
  mockState.offloadedBodies.clear();
  mockState.stats = {
    ramSessions: 0,
    sqliteSizeBytes: 0,
    droppedSessionsCount: 0,
    sessionRetentionLimit: 10_000,
    dropNonMatching: false,
  };
  mockState.filterCfg = structuredClone(DEFAULT_BACKEND_FILTER_CONFIG);
  mockState.bpCfg = structuredClone(mockDefaultBp);
  mockState.clearOnExit = false;

  listeners.batches.clear();
  listeners.removed.clear();
  listeners.breakpoints.clear();
  listeners.status.clear();
  listeners.stats.clear();
}

describe("useProxySessions — Port lifecycle, StrictMode & Replay", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetHookEnv();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("validates port ranges, restarts on valid port changes, and supports stopped preview port updates", async () => {
    const { result } = renderHook(() => useProxySessions());
    await waitFor(() => expect(listeners.batches.size).toBe(1));

    // Invalid ports are rejected with toast without touching proxyBridge
    for (const badPort of [0, -1, 65536, 8080.5]) {
      await act(async () => {
        await result.current.setProxyPort(badPort);
      });
      expect(result.current.toastMessage).toContain("от 1 до 65535");
      expect(mockProxyBridge.stopProxy).not.toHaveBeenCalled();
    }

    // Same port does not restart
    await act(async () => {
      await result.current.setProxyPort(8888);
    });
    expect(mockProxyBridge.stopProxy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("fluxproxy.proxyPort.v1")).toBe("8888");

    // Running port change stops & restarts proxy on new port
    await act(async () => {
      await result.current.setProxyPort(9090);
    });
    expect(mockProxyBridge.stopProxy).toHaveBeenCalledTimes(1);
    expect(mockProxyBridge.startProxy).toHaveBeenCalledWith(undefined, 9090);
    expect(result.current.status.port).toBe(9090);
    expect(window.localStorage.getItem("fluxproxy.proxyPort.v1")).toBe("9090");

    // Stopped proxy uses setPreviewPort without start/stop
    await act(async () => {
      await result.current.toggleProxy();
    });
    expect(result.current.status.running).toBe(false);
    vi.clearAllMocks();

    await act(async () => {
      await result.current.setProxyPort(9191);
    });
    expect(mockProxyBridge.setPreviewPort).toHaveBeenCalledWith(9191);
    expect(mockProxyBridge.startProxy).not.toHaveBeenCalled();
    expect(result.current.status.port).toBe(9191);
  });

  it("rolls back to previous port when new port fails to bind, and handles double failure cleanly", async () => {
    const { result } = renderHook(() => useProxySessions());
    await waitFor(() => expect(listeners.batches.size).toBe(1));

    mockProxyBridge.startProxy.mockImplementation(
      async (_host?: string, port = 8888) => {
        if (port === 9090) {
          throw new Error("EADDRINUSE");
        }
        mockState.status = { ...mockState.status, running: true, port };
        return structuredClone(mockState.status);
      }
    );

    await act(async () => {
      await result.current.setProxyPort(9090);
    });
    expect(result.current.status.running).toBe(true);
    expect(result.current.status.port).toBe(8888);
    expect(result.current.toastMessage).toContain("восстановлен на :8888");
    expect(window.localStorage.getItem("fluxproxy.proxyPort.v1")).toBe("8888");

    // Double failure: both 9092 and rollback 8888 fail
    mockProxyBridge.startProxy.mockRejectedValue(new Error("fatal bind error"));
    await act(async () => {
      await result.current.setProxyPort(9092);
    });
    expect(result.current.status.running).toBe(false);
    expect(result.current.status.port).toBe(8888);
    expect(result.current.toastMessage).toContain("откат на :8888 не удался");
  });

  it("recovers persisted startup port failure during bootstrap", async () => {
    window.localStorage.setItem("fluxproxy.proxyPort.v1", "9091");
    mockProxyBridge.startProxy.mockImplementation(
      async (_host?: string, port = 8888) => {
        if (port === 9091) {
          throw new Error("Port 9091 busy");
        }
        mockState.status = { ...mockState.status, running: true, port };
        return structuredClone(mockState.status);
      }
    );

    const { result } = renderHook(() => useProxySessions());
    await waitFor(() => expect(listeners.batches.size).toBe(1));

    expect(result.current.status.port).toBe(8888);
    expect(result.current.toastMessage).toContain("оставлен 8888");
    expect(window.localStorage.getItem("fluxproxy.proxyPort.v1")).toBe("8888");
  });

  it("handles React 18 StrictMode double-mount and async subscription unmount races without leaked listeners", async () => {
    const strictWrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.StrictMode, null, children);

    const { result, unmount } = renderHook(() => useProxySessions(), {
      wrapper: strictWrapper,
    });

    await waitFor(() => {
      expect(listeners.batches.size).toBe(1);
      expect(listeners.removed.size).toBe(1);
      expect(listeners.breakpoints.size).toBe(1);
      expect(listeners.status.size).toBe(1);
      expect(listeners.stats.size).toBe(1);
    });

    // Emitting a session batch should append exactly once (no duplicate StrictMode listeners)
    const incoming = makeSessionSummary(101, { url: "https://strict.test/ok" });
    await act(async () => {
      for (const cb of listeners.batches) {
        cb([incoming]);
      }
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].id).toBe(101);

    // Unmounting clears all 5 active IPC subscriptions
    unmount();
    expect(listeners.batches.size).toBe(0);
    expect(listeners.removed.size).toBe(0);
    expect(listeners.breakpoints.size).toBe(0);
    expect(listeners.status.size).toBe(0);
    expect(listeners.stats.size).toBe(0);
    expect(unlistenSpies.batches).toHaveBeenCalledTimes(1);
    expect(unlistenSpies.status).toHaveBeenCalledTimes(1);
  });

  it("cleans up a late-resolving subscription immediately if unmounted mid-bootstrap", async () => {
    let resolveLateSub!: (fn: () => void) => void;
    const lateUnlisten = vi.fn();

    mockProxyBridge.subscribeSessionBatches.mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          resolveLateSub = resolve;
        })
    );

    const { unmount } = renderHook(() => useProxySessions());
    await waitFor(() =>
      expect(mockProxyBridge.subscribeSessionBatches).toHaveBeenCalledTimes(1)
    );

    unmount();
    await act(async () => {
      resolveLateSub(lateUnlisten);
      await Promise.resolve();
    });

    expect(lateUnlisten).toHaveBeenCalledTimes(1);
    expect(listeners.batches.size).toBe(0);
  });

  it("replays HTTP sessions, strips Content-Length, loads offloaded bodies, and skips CONNECT/TLS-bypassed tunnels", async () => {
    const httpDetail = makeSessionDetail(
      {
        id: 1,
        method: "POST",
        url: "https://api.example.com/v1/orders",
        host: "api.example.com",
        path: "/v1/orders",
      },
      {
        requestHeaders: [
          { name: "Content-Length", value: "123" },
          { name: "content-type", value: "application/json" },
          { name: "X-Custom", value: "abc" },
        ],
        requestBodyText: '{"item":1}',
        requestBodyBase64: btoa('{"item":1}'),
      }
    );

    const offloadedDetail = makeSessionDetail(
      {
        id: 2,
        method: "PUT",
        url: "https://api.example.com/v1/upload",
        host: "api.example.com",
        path: "/v1/upload",
      },
      {
        requestHeaders: [{ name: "Content-Type", value: "text/plain" }],
        requestBodyOffloaded: true,
        requestBodyBase64: "",
        requestBodyText: null,
      }
    );

    const connectTunnel = makeSessionDetail({
      id: 3,
      method: "CONNECT",
      url: "https://pinned.example.com:443/",
    });

    const tlsBypassed = makeSessionDetail({
      id: 4,
      method: "GET",
      tlsBypassed: true,
      url: "https://apple.com/",
    });

    mockState.details.set(1, httpDetail);
    mockState.details.set(2, offloadedDetail);
    mockState.details.set(3, connectTunnel);
    mockState.details.set(4, tlsBypassed);
    mockState.offloadedBodies.set(2, {
      bodyBase64: btoa("large-body"),
      bodyText: "large-body",
      bodySize: 10,
    });

    const { result } = renderHook(() => useProxySessions());
    await waitFor(() => expect(listeners.batches.size).toBe(1));

    // Empty selection
    await act(async () => {
      await result.current.replaySessions([]);
    });
    expect(result.current.toastMessage).toContain("Сначала выберите сессию");
    expect(mockProxyBridge.executeComposedRequest).not.toHaveBeenCalled();

    // Only tunnels selected -> skipped with toast
    await act(async () => {
      await result.current.replaySessions([3, 4]);
    });
    expect(result.current.toastMessage).toContain("нельзя повторить");
    expect(mockProxyBridge.executeComposedRequest).not.toHaveBeenCalled();

    // Single HTTP session replay strips Content-Length
    await act(async () => {
      await result.current.replaySessions([1]);
    });
    expect(mockProxyBridge.executeComposedRequest).toHaveBeenCalledTimes(1);
    expect(mockProxyBridge.executeComposedRequest).toHaveBeenCalledWith({
      method: "POST",
      url: "https://api.example.com/v1/orders",
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "X-Custom", value: "abc" },
      ],
      body: '{"item":1}',
      bodyBase64: btoa('{"item":1}'),
      followRedirects: true,
    });
    expect(result.current.toastMessage).toContain("Replay #");

    // Mixed batch replays offloaded body + skips tunnels
    vi.clearAllMocks();
    await act(async () => {
      await result.current.replaySessions([2, 3]);
    });
    expect(mockProxyBridge.loadSessionBody).toHaveBeenCalledWith(2, false);
    expect(mockProxyBridge.executeComposedRequest).toHaveBeenCalledTimes(1);
    expect(mockProxyBridge.executeComposedRequest).toHaveBeenCalledWith({
      method: "PUT",
      url: "https://api.example.com/v1/upload",
      headers: [{ name: "Content-Type", value: "text/plain" }],
      body: "large-body",
      bodyBase64: btoa("large-body"),
      followRedirects: true,
    });

    // Handles executeComposedRequest errors gracefully
    mockProxyBridge.executeComposedRequest.mockRejectedValueOnce(
      new Error("upstream refused")
    );
    await act(async () => {
      await result.current.replaySessions([1]);
    });
    expect(result.current.toastMessage).toContain("upstream refused");
  });
});
