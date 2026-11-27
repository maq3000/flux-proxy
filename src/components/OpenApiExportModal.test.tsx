import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "../types/proxy";

const { mockGetSessionDetail, mockLoadSessionBody } = vi.hoisted(() => ({
  mockGetSessionDetail: vi.fn(),
  mockLoadSessionBody: vi.fn(),
}));

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({ path }: { path?: string }) => (
    <div data-testid="monaco-openapi" data-path={path ?? ""} />
  ),
}));

vi.mock("../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauriBridge")>();
  return {
    ...actual,
    isTauriRuntime: () => false,
    proxyBridge: {
      ...actual.proxyBridge,
      getSessionDetail: mockGetSessionDetail,
      loadSessionBody: mockLoadSessionBody,
    },
  };
});

import { OpenApiExportModal } from "./OpenApiExportModal";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement
  ) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (
    this: HTMLDialogElement
  ) {
    this.removeAttribute("open");
  });
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function makeOffloadedDetail(id: number, requestSize: number): SessionDetail {
  return {
    summary: {
      id,
      status: 200,
      protocol: "HTTPS/2",
      scheme: "https",
      method: "POST",
      host: "api.example.com",
      path: `/items/${id}`,
      url: `https://api.example.com/items/${id}`,
      contentType: "application/json",
      bodySize: 64,
      durationMs: 12,
      timestamp: "2026-11-26T12:00:00Z",
      isMocked: false,
      requestSize,
    },
    requestHeaders: [{ name: "Content-Type", value: "application/json" }],
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    requestBodyBase64: "",
    responseBodyBase64: "e30=",
    requestBodyText: null,
    responseBodyText: "{}",
    requestBodyOffloaded: true,
    bodyOffloaded: false,
    clientAddr: "127.0.0.1:5000",
    websocketFrames: [],
  };
}

describe("OpenApiExportModal pre-hydration requestSize guard [BUG-09]", () => {
  it("skips loadSessionBody for offloaded requests > 5 MiB while hydrating requests <= 5 MiB", async () => {
    const oversizedReqId = 101;
    const normalReqId = 102;

    mockGetSessionDetail.mockImplementation(async (id: number) => {
      if (id === oversizedReqId) {
        return makeOffloadedDetail(oversizedReqId, 6 * 1024 * 1024);
      }
      return makeOffloadedDetail(normalReqId, 1024 * 1024);
    });

    mockLoadSessionBody.mockResolvedValue({
      id: normalReqId,
      isResponse: false,
      bodyBase64: "e30=",
      bodyText: '{"name":"flux"}',
      bodySize: 15,
    });

    render(
      <OpenApiExportModal
        open={true}
        selectedIds={[oversizedReqId, normalReqId]}
        allSessionIds={[oversizedReqId, normalReqId]}
        resolvedTheme="dark"
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(mockGetSessionDetail).toHaveBeenCalledTimes(2);
      expect(mockLoadSessionBody).toHaveBeenCalledTimes(1);
    });

    expect(mockLoadSessionBody).not.toHaveBeenCalledWith(oversizedReqId, false);
    expect(mockLoadSessionBody).toHaveBeenCalledWith(normalReqId, false);
  });
});
