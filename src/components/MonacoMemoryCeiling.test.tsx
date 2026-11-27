import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MONACO_RENDER_BYTES, MONACO_MODEL_PATHS } from "../lib/monacoLimits";
import type { SessionDetail } from "../types/proxy";

const { recordedEditorPaths, recordedDiffPaths } = vi.hoisted(() => ({
  recordedEditorPaths: [] as string[],
  recordedDiffPaths: [] as Array<{
    originalModelPath?: string;
    modifiedModelPath?: string;
  }>,
}));

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({
    path,
    value,
  }: {
    path?: string;
    value?: string;
  }) => {
    if (path) recordedEditorPaths.push(path);
    return (
      <div
        data-testid="monaco-editor-mock"
        data-path={path ?? ""}
        data-len={String(value?.length ?? 0)}
      />
    );
  },
  DiffEditor: ({
    originalModelPath,
    modifiedModelPath,
  }: {
    originalModelPath?: string;
    modifiedModelPath?: string;
  }) => {
    recordedDiffPaths.push({ originalModelPath, modifiedModelPath });
    return (
      <div
        data-testid="monaco-diff-editor-mock"
        data-orig-path={originalModelPath ?? ""}
        data-mod-path={modifiedModelPath ?? ""}
      />
    );
  },
}));

vi.mock("../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauriBridge")>();
  return {
    ...actual,
    isTauriRuntime: () => false,
    proxyBridge: {
      ...actual.proxyBridge,
      pickSaveFileDialog: vi.fn().mockResolvedValue(null),
      saveSessionBodyFile: vi.fn().mockResolvedValue(0),
    },
  };
});

import { SessionDiffView } from "./SessionDiffView";
import { SessionInspector } from "./SessionInspector";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  recordedEditorPaths.length = 0;
  recordedDiffPaths.length = 0;
});

function makeDetail(id: number, respText: string): SessionDetail {
  return {
    summary: {
      id,
      status: 200,
      protocol: "HTTP/1.1",
      scheme: "https",
      method: "POST",
      host: "api.fluxproxy.local",
      path: `/v1/resource/${id}`,
      url: `https://api.fluxproxy.local/v1/resource/${id}`,
      contentType: "application/json",
      bodySize: respText.length,
      durationMs: 12,
      timestamp: "2026-11-26T12:00:00Z",
      isMocked: false,
      requestSize: 64,
    },
    requestHeaders: [{ name: "Content-Type", value: "application/json" }],
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    requestBodyBase64: "eyJxIjoxfQ==",
    responseBodyBase64: "",
    requestBodyText: '{"q":1}',
    responseBodyText: respText,
    clientAddr: "127.0.0.1:4321",
    websocketFrames: [],
  };
}

describe("WebView2 / Monaco static memory ceiling [VER-03]", () => {
  it("reuses a single fixed Monaco path URI across 100 rapid session switches in SessionInspector", () => {
    const first = makeDetail(1, '{"seq":1}');
    const { rerender } = render(
      <SessionInspector
        detail={first}
        resolvedTheme="dark"
        onSendToComposer={vi.fn()}
      />
    );

    for (let id = 2; id <= 100; id++) {
      rerender(
        <SessionInspector
          detail={makeDetail(id, `{"seq":${id}}`)}
          resolvedTheme="dark"
          onSendToComposer={vi.fn()}
        />
      );
    }

    expect(recordedEditorPaths.length).toBeGreaterThanOrEqual(100);
    expect(new Set(recordedEditorPaths)).toEqual(
      new Set([MONACO_MODEL_PATHS.inspectorResponseJson])
    );
  });

  it("uses fixed originalModelPath and modifiedModelPath across SessionDiffView pair changes", () => {
    const onSwapPair = vi.fn();
    const { rerender } = render(
      <SessionDiffView
        leftDetail={makeDetail(1, '{"v":1}')}
        rightDetail={makeDetail(2, '{"v":2}')}
        resolvedTheme="dark"
        onSwapPair={onSwapPair}
      />
    );

    for (let i = 3; i <= 10; i += 2) {
      rerender(
        <SessionDiffView
          leftDetail={makeDetail(i, `{"v":${i}}`)}
          rightDetail={makeDetail(i + 1, `{"v":${i + 1}}`)}
          resolvedTheme="dark"
          onSwapPair={onSwapPair}
        />
      );
    }

    expect(recordedDiffPaths.length).toBeGreaterThanOrEqual(5);
    for (const entry of recordedDiffPaths) {
      expect(entry.originalModelPath).toBe(MONACO_MODEL_PATHS.diffOriginal);
      expect(entry.modifiedModelPath).toBe(MONACO_MODEL_PATHS.diffModified);
    }
  });

  it("blocks Monaco rendering for payloads > 2 MiB and offers HexViewer and Save to Disk", () => {
    const oversizedJson = JSON.stringify({
      blob: "A".repeat(MAX_MONACO_RENDER_BYTES + 2048),
    });
    const heavyDetail = makeDetail(500, oversizedJson);
    const onSaveBodyFile = vi.fn();

    render(
      <SessionInspector
        detail={heavyDetail}
        resolvedTheme="dark"
        onSendToComposer={vi.fn()}
        onSaveBodyFile={onSaveBodyFile}
      />
    );

    expect(screen.queryByTestId("monaco-editor-mock")).toBeNull();
    expect(screen.getByTestId("monaco-size-guard-notice")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Сохранить тело на диск/i })
    );
    expect(onSaveBodyFile).toHaveBeenCalledWith(500, true);

    fireEvent.click(
      screen.getByRole("button", { name: /Открыть в HexViewer/i })
    );
    expect(screen.queryByTestId("monaco-size-guard-notice")).toBeNull();

    // SessionDiffView must also refuse DiffEditor for > 2 MiB payloads
    render(
      <SessionDiffView
        leftDetail={heavyDetail}
        rightDetail={makeDetail(501, '{"small":true}')}
        resolvedTheme="dark"
        onSwapPair={vi.fn()}
      />
    );
    expect(screen.queryByTestId("monaco-diff-editor-mock")).toBeNull();
    expect(screen.getByTestId("monaco-size-guard-notice")).toBeTruthy();
  });
});
