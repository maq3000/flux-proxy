import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SANITIZATION_OPTIONS,
  type BreakpointConfig,
  type BreakpointResolution,
  type ComposedRequest,
  type ProxyFilterBackendConfig,
  type ProxyStatus,
  type SanitizationOptions,
  type SessionDetail,
  type SessionSummary,
  type StorageStats,
} from "../types/proxy";

const {
  mockInvoke,
  mockListen,
  mockOnDragDropEvent,
  mockExportPreviewTextFile,
  mockPreviewEngine,
} = vi.hoisted(() => {
  const exportPreviewTextFile = vi.fn(() => 0);
  const previewEngine = {
    exportPreviewTextFile,
    getStatus: vi.fn(async () => ({
      running: true,
      bindAddr: "127.0.0.1",
      port: 8888,
      activeSessions: 0,
      systemProxyEnabled: false,
      autoSystemProxy: true,
      systemProxyError: null,
      allowRemote: false,
      bindMode: "loopback",
      specificBindIp: null,
      alsoBindLoopback: true,
      boundIps: ["127.0.0.1"],
    })),
    setRunning: vi.fn(async (running: boolean, _host?: string, port = 8888) => ({
      running,
      bindAddr: "127.0.0.1",
      port,
      activeSessions: 0,
      systemProxyEnabled: false,
      autoSystemProxy: true,
      systemProxyError: null,
      allowRemote: false,
      bindMode: "loopback",
      specificBindIp: null,
      alsoBindLoopback: true,
      boundIps: ["127.0.0.1"],
    })),
    getSummaries: vi.fn(() => [] as SessionSummary[]),
    executeComposed: vi.fn(
      async (req: ComposedRequest): Promise<SessionDetail> => ({
        summary: {
          id: 501,
          status: 200,
          protocol: "HTTPS/1.1",
          scheme: "https",
          method: req.method,
          host: "preview.example.com",
          path: "/ok",
          url: req.url,
          contentType: "application/json",
          bodySize: 2,
          durationMs: 5,
          timestamp: "2026-11-27T10:00:00.000Z",
          isMocked: false,
        },
        requestHeaders: req.headers,
        responseHeaders: [],
        requestBodyBase64: "",
        responseBodyBase64: "e30=",
        requestBodyText: req.body,
        responseBodyText: "{}",
        clientAddr: "127.0.0.1:1234",
        websocketFrames: [],
      })
    ),
  };

  return {
    mockInvoke: vi.fn(),
    mockListen: vi.fn<
      (
        eventName: string,
        handler: (event: { payload: unknown }) => void
      ) => Promise<() => void>
    >(async () => () => {}),
    mockOnDragDropEvent: vi.fn<
      (
        cb: (ev: { payload: { type: string; paths?: string[] } }) => void
      ) => Promise<() => void>
    >(async () => () => {}),
    mockExportPreviewTextFile: exportPreviewTextFile,
    mockPreviewEngine: previewEngine,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: mockOnDragDropEvent,
  }),
}));

const mockGetPreviewEngine = vi.fn(() => mockPreviewEngine);

vi.mock("./previewEngine", () => ({
  getPreviewEngine: mockGetPreviewEngine,
}));

import { DEFAULT_BACKEND_FILTER_CONFIG } from "./filterEngine";
import { isTauriRuntime, proxyBridge } from "./tauriBridge";

describe("proxyBridge file export IPC [SEC-04]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("invokes export_text_file in Tauri runtime for .md/.txt/.yaml/.json without browser download fallback", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mockInvoke.mockResolvedValueOnce(14);

    await proxyBridge.exportTextFile(
      "C:\\Exports\\report.md",
      "# Stats Report",
      "text/markdown;charset=utf-8"
    );

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("export_text_file", {
      filePath: "C:\\Exports\\report.md",
      contents: "# Stats Report",
    });
    expect(mockExportPreviewTextFile).not.toHaveBeenCalled();
  });

  it("propagates native IPC errors from export_text_file and export_settings_file in Tauri runtime", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mockInvoke.mockRejectedValueOnce(new Error("Dialog token required"));

    await expect(
      proxyBridge.exportTextFile("C:\\Exports\\unauth.txt", "hello")
    ).rejects.toThrow("Dialog token required");
    expect(mockExportPreviewTextFile).not.toHaveBeenCalled();

    mockInvoke.mockRejectedValueOnce(new Error("Unauthorized settings path"));
    await expect(
      proxyBridge.exportSettingsJsonFile("C:\\Exports\\settings.json", "{}")
    ).rejects.toThrow("Unauthorized settings path");
    expect(mockExportPreviewTextFile).not.toHaveBeenCalled();
  });

  it("delegates exportTextFile and exportSettingsJsonFile to BrowserPreviewEngine outside Tauri", async () => {
    await proxyBridge.exportTextFile(
      "openapi.yaml",
      "openapi: 3.0.3\n",
      "application/yaml;charset=utf-8"
    );
    await proxyBridge.exportSettingsJsonFile("settings.json", "{\"v\":1}");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockExportPreviewTextFile).toHaveBeenNthCalledWith(
      1,
      "openapi.yaml",
      "openapi: 3.0.3\n",
      "application/yaml;charset=utf-8"
    );
    expect(mockExportPreviewTextFile).toHaveBeenNthCalledWith(
      2,
      "settings.json",
      "{\"v\":1}",
      "application/json;charset=utf-8"
    );
  });

  it("never initializes previewEngine in Tauri runtime and consolidates updateProxyFilterConfig onto update_filter_backend_config", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mockInvoke.mockResolvedValueOnce({
      running: true,
      bindAddr: "127.0.0.1",
      port: 8888,
      activeSessions: 0,
      systemProxyEnabled: false,
      autoSystemProxy: true,
      systemProxyError: null,
      allowRemote: false,
      bindMode: "loopback",
      specificBindIp: null,
      alsoBindLoopback: true,
      boundIps: ["127.0.0.1"],
    });

    await proxyBridge.getStatus();
    expect(mockGetPreviewEngine).not.toHaveBeenCalled();

    const filterCfg: ProxyFilterBackendConfig = {
      ...structuredClone(DEFAULT_BACKEND_FILTER_CONFIG),
      stripAltSvc: true,
    };
    mockInvoke.mockResolvedValueOnce(filterCfg);

    await proxyBridge.updateProxyFilterConfig(filterCfg);
    expect(mockInvoke).toHaveBeenLastCalledWith("update_filter_backend_config", {
      config: filterCfg,
    });
    expect(mockGetPreviewEngine).not.toHaveBeenCalled();
  });
});

describe("proxyBridge IPC & Browser Preview routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("detects Tauri vs Browser Preview runtime cleanly", () => {
    expect(isTauriRuntime()).toBe(false);
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    expect(isTauriRuntime()).toBe(true);
  });

  it("serializes core lifecycle, session, breakpoint, and composer commands to Tauri invoke", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    mockInvoke.mockResolvedValue({ running: true, port: 9090 } as ProxyStatus);
    await proxyBridge.startProxy(undefined, 9090);
    expect(mockInvoke).toHaveBeenCalledWith("start_proxy", {
      host: null,
      port: 9090,
    });

    await proxyBridge.stopProxy();
    expect(mockInvoke).toHaveBeenCalledWith("stop_proxy");

    await proxyBridge.setBindConfiguration("specific", "192.168.1.10", false);
    expect(mockInvoke).toHaveBeenCalledWith("set_bind_configuration", {
      bindMode: "specific",
      specificBindIp: "192.168.1.10",
      alsoBindLoopback: false,
    });

    // Empty deleteSessions short-circuits before IPC invoke
    expect(await proxyBridge.deleteSessions([])).toBe(0);
    expect(mockInvoke).not.toHaveBeenCalledWith("delete_sessions", expect.anything());

    mockInvoke.mockResolvedValueOnce(2);
    expect(await proxyBridge.deleteSessions([10, 11])).toBe(2);
    expect(mockInvoke).toHaveBeenLastCalledWith("delete_sessions", {
      ids: [10, 11],
    });

    mockInvoke.mockResolvedValueOnce(null);
    await proxyBridge.getSessionDetail(42);
    expect(mockInvoke).toHaveBeenLastCalledWith("get_session_detail", {
      id: 42,
    });

    mockInvoke.mockResolvedValueOnce({
      id: 42,
      isResponse: true,
      bodyBase64: "",
      bodyText: "body",
      bodySize: 4,
    });
    await proxyBridge.loadSessionBody(42, true);
    expect(mockInvoke).toHaveBeenLastCalledWith("load_session_body", {
      id: 42,
      isResponse: true,
    });

    const req: ComposedRequest = {
      method: "POST",
      url: "https://api.example.com/v1/test",
      headers: [{ name: "Content-Type", value: "application/json" }],
      body: '{"ok":true}',
      followRedirects: true,
    };
    mockInvoke.mockResolvedValueOnce({ summary: { id: 1 } });
    await proxyBridge.executeComposedRequest(req);
    expect(mockInvoke).toHaveBeenLastCalledWith("execute_composed_request", {
      request: req,
    });

    mockInvoke.mockResolvedValueOnce(true);
    await proxyBridge.cancelComposedRequest("req-uuid-1");
    expect(mockInvoke).toHaveBeenLastCalledWith("cancel_composed_request", {
      requestId: "req-uuid-1",
    });

    const bpCfg: BreakpointConfig = {
      breakBeforeRequest: true,
      breakAfterResponse: false,
      timeoutSecs: 60,
      rules: [],
    };
    mockInvoke.mockResolvedValueOnce(bpCfg);
    await proxyBridge.updateBreakpointConfig(bpCfg);
    expect(mockInvoke).toHaveBeenLastCalledWith("update_breakpoint_config", {
      config: bpCfg,
    });

    const resolution: BreakpointResolution = {
      breakpointId: "bp-1",
      action: "continue",
      method: "POST",
    };
    mockInvoke.mockResolvedValueOnce(true);
    await proxyBridge.resolveBreakpoint(resolution);
    expect(mockInvoke).toHaveBeenLastCalledWith("resolve_breakpoint", {
      resolution,
    });

    const sanitization: SanitizationOptions = {
      ...DEFAULT_SANITIZATION_OPTIONS,
    };
    mockInvoke.mockResolvedValueOnce(5);
    await proxyBridge.exportSessionsFile(
      [1, 2],
      "har",
      "C:\\out.har",
      sanitization,
      true
    );
    expect(mockInvoke).toHaveBeenLastCalledWith("export_sessions_file", {
      sessionIds: [1, 2],
      format: "har",
      filePath: "C:\\out.har",
      sanitization,
      includeEvictedSqlite: true,
    });
  });

  it("subscribes to Tauri events, filters empty batch payloads, and maps drag-drop events", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    const unlistenMock = vi.fn();
    mockListen.mockImplementation(async (eventName, handler) => {
      handlers.set(eventName, handler);
      return unlistenMock;
    });

    const batchSpy = vi.fn();
    const unsubBatch = await proxyBridge.subscribeSessionBatches(batchSpy);
    expect(mockListen).toHaveBeenCalledWith(
      "proxy://sessions-batch",
      expect.any(Function)
    );
    handlers.get("proxy://sessions-batch")?.({ payload: [] });
    expect(batchSpy).not.toHaveBeenCalled();
    handlers.get("proxy://sessions-batch")?.({
      payload: [{ id: 1, url: "https://a.test" }],
    });
    expect(batchSpy).toHaveBeenCalledTimes(1);
    unsubBatch();
    expect(unlistenMock).toHaveBeenCalledTimes(1);

    const statsSpy = vi.fn();
    await proxyBridge.subscribeStorageStatsChanged(statsSpy);
    handlers.get("proxy://storage-stats-changed")?.({
      payload: { ramSessions: 3 } as StorageStats,
    });
    expect(statsSpy).toHaveBeenCalledWith({ ramSessions: 3 });

    const dropHandlers: Array<
      (ev: { payload: { type: string; paths?: string[] } }) => void
    > = [];
    mockOnDragDropEvent.mockImplementationOnce(async (cb) => {
      dropHandlers.push(cb);
      return () => {};
    });
    const receivedDrops: unknown[] = [];
    await proxyBridge.subscribeNativeFileDrop((p) => receivedDrops.push(p));
    const emitDrop = dropHandlers[0];
    expect(emitDrop).toBeTypeOf("function");
    emitDrop({ payload: { type: "enter", paths: ["a.har"] } });
    emitDrop({ payload: { type: "over" } });
    emitDrop({ payload: { type: "drop", paths: ["b.saz"] } });
    emitDrop({ payload: { type: "leave" } });
    expect(receivedDrops).toEqual([
      { type: "enter", paths: ["a.har"] },
      { type: "over" },
      { type: "drop", paths: ["b.saz"] },
      { type: "leave" },
    ]);
  });

  it("falls back to BrowserPreviewEngine and browser file defaults outside Tauri runtime", async () => {
    const status = await proxyBridge.startProxy(undefined, 8888);
    expect(status.running).toBe(true);
    expect(mockPreviewEngine.setRunning).toHaveBeenCalledWith(
      true,
      undefined,
      8888
    );

    const sessions = await proxyBridge.getSessions();
    expect(sessions).toEqual([]);
    expect(mockPreviewEngine.getSummaries).toHaveBeenCalledTimes(1);

    const savePath = await proxyBridge.pickSaveFileDialog({
      filters: [{ name: "HAR", extensions: ["har"] }],
    });
    expect(savePath).toBe("fluxproxy-capture.har");

    const unlistenDrop = await proxyBridge.subscribeNativeFileDrop(vi.fn());
    expect(typeof unlistenDrop).toBe("function");
    unlistenDrop();
    expect(mockOnDragDropEvent).not.toHaveBeenCalled();
  });
});
