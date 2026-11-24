import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { mockExecuteComposedRequest } = vi.hoisted(() => ({
  mockExecuteComposedRequest: vi.fn(),
}));

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({ value }: { value?: string }) => (
    <pre data-testid="monaco-mock">{value}</pre>
  ),
}));

vi.mock("../lib/tauriBridge", () => ({
  isTauriRuntime: () => false,
  proxyBridge: {
    executeComposedRequest: mockExecuteComposedRequest,
    cancelComposedRequest: vi.fn(async () => true),
  },
}));

import { ComposerPanel } from "./ComposerPanel";
import type { ComposedRequest, SessionDetail } from "../types/proxy";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  if (typeof window.ResizeObserver === "undefined") {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const SAMPLE_DRAFT: ComposedRequest = {
  method: "POST",
  url: "https://api.example.com/v1/orders",
  headers: [
    { name: "Content-Type", value: "application/json" },
    { name: "X-Trace-Id", value: "abc-123" },
  ],
  body: '{"item":"flux"}',
  followRedirects: true,
  sourceSessionId: 42,
};

const SAMPLE_RESPONSE: SessionDetail = {
  summary: {
    id: 999,
    status: 201,
    protocol: "HTTPS",
    scheme: "https",
    method: "POST",
    host: "api.example.com",
    path: "/v1/orders",
    url: "https://api.example.com/v1/orders",
    contentType: "application/json",
    bodySize: 28,
    durationMs: 41,
    timestamp: "12:00:01.000",
    isMocked: false,
  },
  requestHeaders: [{ name: "Content-Type", value: "application/json" }],
  responseHeaders: [{ name: "Content-Type", value: "application/json" }],
  requestBodyBase64: "",
  responseBodyBase64: "",
  requestBodyText: '{"item":"flux"}',
  responseBodyText: '{"created":true,"id":999}',
  clientAddr: "127.0.0.1:50000",
  websocketFrames: [],
};

describe("ComposerPanel Stage 40 standalone ergonomics", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("renders Back to Traffic button, From #id badge, and flexible header columns", () => {
    const onBackToTraffic = vi.fn();

    render(
      <ComposerPanel
        draftRequest={SAMPLE_DRAFT}
        resolvedTheme="dark"
        onLoadSessionIntoComposer={vi.fn()}
        onSessionCreated={vi.fn()}
        onBackToTraffic={onBackToTraffic}
        onInspectSessionInTraffic={vi.fn()}
      />
    );

    const backBtn = screen.getByRole("button", { name: /Traffic/i });
    expect(backBtn.getAttribute("title")).toContain("Alt+1");
    fireEvent.click(backBtn);
    expect(onBackToTraffic).toHaveBeenCalledTimes(1);

    expect(screen.getByText("From #42")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Headers \(2\)/i }));
    const headerNameInput = screen.getByLabelText("Header name 1");
    expect(headerNameInput.className).not.toContain("w-44");
    expect(headerNameInput.parentElement?.className).toContain(
      "grid-cols-[minmax(180px,28%)_minmax(0,1fr)_auto]"
    );
  });

  it("renders Inspect #<id> in Traffic button inside resizable response split after execution", async () => {
    mockExecuteComposedRequest.mockResolvedValueOnce(SAMPLE_RESPONSE);
    const onSessionCreated = vi.fn();
    const onInspectSessionInTraffic = vi.fn();

    render(
      <ComposerPanel
        draftRequest={SAMPLE_DRAFT}
        resolvedTheme="dark"
        onLoadSessionIntoComposer={vi.fn()}
        onSessionCreated={onSessionCreated}
        onBackToTraffic={vi.fn()}
        onInspectSessionInTraffic={onInspectSessionInTraffic}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Execute" }));

    await waitFor(() => {
      expect(mockExecuteComposedRequest).toHaveBeenCalledTimes(1);
    });

    const sentPayload = mockExecuteComposedRequest.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect("sourceSessionId" in sentPayload).toBe(false);
    expect(onSessionCreated).toHaveBeenCalledWith(SAMPLE_RESPONSE);

    const inspectBtn = await screen.findByRole("button", {
      name: /Inspect #999 in Traffic/i,
    });
    fireEvent.click(inspectBtn);
    expect(onInspectSessionInTraffic).toHaveBeenCalledWith(999);
  });
});
