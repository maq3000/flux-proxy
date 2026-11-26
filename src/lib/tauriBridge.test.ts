import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, mockListen, mockOnDragDropEvent, mockExportPreviewTextFile } =
  vi.hoisted(() => ({
    mockInvoke: vi.fn(),
    mockListen: vi.fn(async () => () => {}),
    mockOnDragDropEvent: vi.fn(async () => () => {}),
    mockExportPreviewTextFile: vi.fn(() => 0),
  }));

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

vi.mock("./previewEngine", () => ({
  DEFAULT_BREAKPOINT_CONFIG: {
    breakBeforeRequest: false,
    breakAfterResponse: false,
    timeoutSecs: 120,
    rules: [],
  },
  encodeUint8ArrayToBase64: vi.fn(() => ""),
  previewPickedFiles: new Map(),
  getPreviewEngine: () => ({
    exportPreviewTextFile: mockExportPreviewTextFile,
  }),
}));

import { proxyBridge } from "./tauriBridge";

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
});
