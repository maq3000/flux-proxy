import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PausedBreakpointItem,
  SessionDetail,
  SessionSummary,
  StorageStats,
} from "../types/proxy";
import { DEFAULT_BACKEND_FILTER_CONFIG } from "../lib/filterEngine";
import {
  LS_FOLLOW_TAIL_KEY,
  LS_RETENTION_LIMIT_KEY,
  useProxyStore,
} from "../stores/proxyStore";
import { useFilterStore } from "../stores/filterStore";

const {
  mockDefaultBp,
  mockState,
  listeners,
  unlistenSpies,
  mockProxyBridge,
  resetMockBridgeState,
} = await vi.hoisted(async () => {
  const { DEFAULT_BREAKPOINT_CONFIG } = await import("../types/proxy");
  const { createStatefulMockProxyBridge } = await import(
    "../test/mockProxyBridge"
  );
  const env = createStatefulMockProxyBridge();
  return {
    mockDefaultBp: structuredClone(DEFAULT_BREAKPOINT_CONFIG),
    mockState: env.state,
    listeners: env.listeners,
    unlistenSpies: env.unlistenSpies,
    mockProxyBridge: env.bridge,
    resetMockBridgeState: env.reset,
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
  resetMockBridgeState();
  mockState.filterCfg = structuredClone(DEFAULT_BACKEND_FILTER_CONFIG);
  mockState.bpCfg = structuredClone(mockDefaultBp);

  useProxyStore.setState({
    sessions: [],
    selectedId: null,
    selectedIds: [],
    selectedDetail: null,
    diffLeftDetail: null,
    diffRightDetail: null,
    pausedBreakpoints: [],
    toastMessage: null,
    followTail: true,
    sessionRetentionLimit: 10_000,
    dropNonMatching: false,
    clearDbOnExit: false,
    hasPersistedClearDbOnExit: false,
    status: structuredClone(mockState.status),
    storageStats: {
      ramSessions: 0,
      sqliteSizeBytes: 0,
      droppedSessionsCount: 0,
      sessionRetentionLimit: 10_000,
      dropNonMatching: false,
    },
  });
  useFilterStore.setState({
    filterQuery: "",
    useRegex: false,
    quickCategory: "all",
  });
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

  it("deduplicates duplicate session IDs even when flushed into an initially empty sessions list (BUG-02)", async () => {
    const { result } = renderHook(() => useProxySessions());
    await waitFor(() => expect(listeners.batches.size).toBe(1));
    expect(result.current.sessions).toHaveLength(0);

    const inFlight = makeSessionSummary(1, { status: 0 });
    const completed = makeSessionSummary(1, { status: 200, durationMs: 45 });
    const second = makeSessionSummary(2, { status: 201 });

    await act(async () => {
      for (const cb of listeners.batches) {
        cb([inFlight, completed, second]);
      }
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions[0].id).toBe(1);
    expect(result.current.sessions[0].status).toBe(200);
    expect(result.current.sessions[0].durationMs).toBe(45);
    expect(result.current.sessions[1].id).toBe(2);
    expect(result.current.sessions[1].status).toBe(201);
  });

  it("does not refetch selected SessionDetail when unrelated sessions are appended, but refetches when selected session updates (PERF-01)", async () => {
    mockState.details.set(1, makeSessionDetail({ id: 1, status: 0 }));
    mockState.sessions = [makeSessionSummary(1, { status: 0 })];

    const { result } = renderHook(() => useProxySessions());
    await waitFor(() => expect(listeners.batches.size).toBe(1));
    await waitFor(() => expect(result.current.selectedId).toBe(1));
    await waitFor(() =>
      expect(mockProxyBridge.getSessionDetail).toHaveBeenCalledWith(1)
    );
    expect(mockProxyBridge.getSessionDetail).toHaveBeenCalledTimes(1);

    // Appending unrelated sessions (#2, #3, #4) must not trigger getSessionDetail(1) again
    await act(async () => {
      for (const cb of listeners.batches) {
        cb([
          makeSessionSummary(2, { status: 200 }),
          makeSessionSummary(3, { status: 200 }),
          makeSessionSummary(4, { status: 200 }),
        ]);
      }
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(result.current.sessions).toHaveLength(4);
    expect(mockProxyBridge.getSessionDetail).toHaveBeenCalledTimes(1);

    // Updating the selected session (#1) in-place must refetch its detail
    mockState.details.set(1, makeSessionDetail({ id: 1, status: 200 }));
    await act(async () => {
      for (const cb of listeners.batches) {
        cb([makeSessionSummary(1, { status: 200 })]);
      }
      await new Promise((r) => setTimeout(r, 40));
    });

    await waitFor(() =>
      expect(mockProxyBridge.getSessionDetail).toHaveBeenCalledTimes(2)
    );
    expect(result.current.selectedDetail?.summary.status).toBe(200);
  });

  it("falls back to 127.0.0.1 and still registers all IPC subscriptions when startup IPC calls fail (BUG-08)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    window.localStorage.setItem("fluxproxy.bindMode.v1", JSON.stringify("specific"));
    window.localStorage.setItem(
      "fluxproxy.specificBindIp.v1",
      JSON.stringify("192.168.99.99")
    );
    window.localStorage.setItem("fluxproxy.alsoBindLoopback.v1", JSON.stringify(true));

    mockProxyBridge.setSessionRetentionLimit.mockRejectedValueOnce(
      new Error("retention IPC failed")
    );
    mockProxyBridge.updateFilterBackendConfig.mockRejectedValueOnce(
      new Error("filter IPC failed")
    );
    mockProxyBridge.updateBreakpointConfig.mockRejectedValueOnce(
      new Error("breakpoint IPC failed")
    );
    mockProxyBridge.setDropNonMatching.mockRejectedValueOnce(
      new Error("dropNonMatching IPC failed")
    );
    mockProxyBridge.setBindConfiguration.mockRejectedValueOnce(
      new Error("bind 192.168.99.99 unavailable")
    );

    const { result } = renderHook(() => useProxySessions());

    await waitFor(() => {
      expect(listeners.batches.size).toBe(1);
      expect(listeners.removed.size).toBe(1);
      expect(listeners.breakpoints.size).toBe(1);
      expect(listeners.status.size).toBe(1);
      expect(listeners.stats.size).toBe(1);
    });

    expect(mockProxyBridge.setBindConfiguration).toHaveBeenNthCalledWith(
      1,
      "specific",
      "192.168.99.99",
      true
    );
    expect(mockProxyBridge.setBindConfiguration).toHaveBeenNthCalledWith(
      2,
      "loopback",
      null,
      true
    );
    expect(result.current.status.bindMode).toBe("loopback");
    expect(result.current.status.bindAddr).toBe("127.0.0.1");
    expect(JSON.parse(window.localStorage.getItem("fluxproxy.bindMode.v1") ?? "null")).toBe(
      "loopback"
    );
    expect(result.current.toastMessage).toContain("127.0.0.1");
    warnSpy.mockRestore();
  });

  it("syncFromLocalStorage updates persisted config without wiping runtime sessions or selection ([CONC-01])", () => {
    const sampleSession: SessionSummary = {
      id: 42,
      status: 200,
      protocol: "HTTP/1.1",
      scheme: "https",
      method: "GET",
      host: "example.com",
      path: "/api",
      url: "https://example.com/api",
      contentType: "application/json",
      bodySize: 256,
      durationMs: 18,
      timestamp: "2026-01-01T00:00:00Z",
      isMocked: false,
      clientIp: "127.0.0.1",
      serverIp: "93.184.216.34",
    };
    const sampleDetail: SessionDetail = {
      summary: sampleSession,
      requestHeaders: [],
      responseHeaders: [],
      requestBodyBase64: "",
      responseBodyBase64: "e30=",
      requestBodyText: null,
      responseBodyText: "{}",
      clientAddr: "127.0.0.1:54321",
      websocketFrames: [],
    };
    const sampleBreakpoint: PausedBreakpointItem = {
      breakpointId: "bp-42",
      sessionId: 42,
      stage: "request",
      createdAt: "2026-01-01T00:00:00Z",
      timeoutSecs: 120,
      scheme: "https",
      method: "GET",
      url: "https://example.com/api",
      host: "example.com",
      path: "/api",
      requestHeaders: [],
      requestBodyBase64: "",
      requestBodyText: null,
      responseStatus: null,
      responseHeaders: [],
      responseBodyBase64: "",
      responseBodyText: null,
    };
    const customStats: StorageStats = {
      ramSessions: 1,
      sqliteSizeBytes: 4096,
      droppedSessionsCount: 3,
      sessionRetentionLimit: 25_000,
      dropNonMatching: true,
    };

    useProxyStore.setState({
      sessions: [sampleSession],
      selectedId: 42,
      selectedIds: [42],
      selectedDetail: sampleDetail,
      diffLeftDetail: sampleDetail,
      diffRightDetail: sampleDetail,
      pausedBreakpoints: [sampleBreakpoint],
      storageStats: customStats,
      toastMessage: "keep-me",
    });

    window.localStorage.setItem(LS_FOLLOW_TAIL_KEY, "false");
    window.localStorage.setItem(LS_RETENTION_LIMIT_KEY, "25000");

    useProxyStore.getState().syncFromLocalStorage();

    const next = useProxyStore.getState();
    expect(next.followTail).toBe(false);
    expect(next.sessionRetentionLimit).toBe(25_000);
    expect(next.sessions).toEqual([sampleSession]);
    expect(next.selectedId).toBe(42);
    expect(next.selectedIds).toEqual([42]);
    expect(next.selectedDetail).toEqual(sampleDetail);
    expect(next.diffLeftDetail).toEqual(sampleDetail);
    expect(next.diffRightDetail).toEqual(sampleDetail);
    expect(next.pausedBreakpoints).toEqual([sampleBreakpoint]);
    expect(next.storageStats).toEqual(customStats);
    expect(next.toastMessage).toBe("keep-me");
  });

  it("defaults clearDbOnExit to false on SETTINGS_APPLIED_EVENT and forwards includeEvictedSqlite in exportSanitizedSessions", async () => {
    const { SETTINGS_APPLIED_EVENT } = await import("../types/settings");
    const { DEFAULT_SANITIZATION_OPTIONS } = await import("../types/proxy");
    mockProxyBridge.pickSaveFileDialog.mockResolvedValue("C:\\Exports\\all.har");
    mockProxyBridge.exportSessionsFile.mockResolvedValue(42);
    mockState.sessions = [makeSessionSummary(1)];
    mockState.stats = {
      ramSessions: 1,
      archivedSessions: 41,
      sqliteSizeBytes: 8192,
      droppedSessionsCount: 0,
      sessionRetentionLimit: 10_000,
      dropNonMatching: false,
    };
    useProxyStore.setState({
      sessions: [makeSessionSummary(1)],
      clearDbOnExit: false,
      storageStats: structuredClone(mockState.stats),
    });
    const filterState = useFilterStore.getState();

    const { result } = renderHook(() => useProxySessions());

    await waitFor(() => {
      expect(result.current.sessions.length).toBe(1);
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(SETTINGS_APPLIED_EVENT, {
          detail: {
            proxy: {
              port: 8888,
              autoSystemProxy: true,
              allowRemote: false,
              tlsInterceptMode: "all",
              tlsBypassRules: [],
              tlsTargetRules: [],
              headerMutations: [],
              sessionRetentionLimit: 10_000,
              dropNonMatching: false,
              clearDbOnExit: undefined,
              breakpoints: mockDefaultBp,
            },
            ui: { followTail: true },
            filters: {
              activePresetId: filterState.activePresetId,
              userPresets: [],
              noiseThresholds: filterState.thresholds,
              hostFilters: filterState.hostListFilter,
              matrixEnabled: false,
              filterRules: [],
            },
          },
        })
      );
    });

    expect(result.current.clearDbOnExit).toBe(false);

    let ok = false;
    await act(async () => {
      ok = await result.current.exportSanitizedSessions(
        [],
        "har",
        DEFAULT_SANITIZATION_OPTIONS,
        true
      );
    });

    expect(ok).toBe(true);
    expect(mockProxyBridge.exportSessionsFile).toHaveBeenCalledWith(
      [],
      "har",
      "C:\\Exports\\all.har",
      DEFAULT_SANITIZATION_OPTIONS,
      true
    );
  });
});
