import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadBreakpointBody } = vi.hoisted(() => ({
  mockLoadBreakpointBody: vi.fn(),
}));

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({
    value,
    path,
  }: {
    value?: string;
    path?: string;
  }) => (
    <div data-testid="monaco-bp-editor" data-path={path ?? ""}>
      {value ?? ""}
    </div>
  ),
}));

vi.mock("../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauriBridge")>();
  return {
    ...actual,
    isTauriRuntime: () => false,
    proxyBridge: {
      ...actual.proxyBridge,
      loadBreakpointBody: mockLoadBreakpointBody,
    },
  };
});

import type {
  BreakpointConfig,
  BreakpointResolution,
  PausedBreakpointItem,
} from "../types/proxy";
import { BreakpointsPanel } from "./BreakpointsPanel";

beforeAll(() => {
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  }
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function makeOffloadedItem(
  breakpointId: string,
  sessionId: number,
  size: number
): PausedBreakpointItem {
  return {
    breakpointId,
    sessionId,
    stage: "request",
    createdAt: new Date().toISOString(),
    timeoutSecs: 120,
    scheme: "https",
    method: "POST",
    url: `https://api.example.com/upload/${sessionId}`,
    host: "api.example.com",
    path: `/upload/${sessionId}`,
    requestHeaders: [{ name: "Content-Type", value: "application/json" }],
    requestBodyBase64: "",
    requestBodyText: null,
    requestBodyOffloaded: true,
    requestBodySize: size,
    responseStatus: null,
    responseHeaders: [],
    responseBodyBase64: "",
    responseBodyText: null,
    responseBodyOffloaded: false,
    responseBodySize: 0,
    bodyOffloaded: true,
    bodySize: size,
    processName: "node.exe",
    processPid: 1000 + sessionId,
  };
}

const DEFAULT_CFG: BreakpointConfig = {
  breakBeforeRequest: true,
  breakAfterResponse: false,
  timeoutSecs: 120,
  rules: [],
};

describe("BreakpointsPanel lazy offload loading [PERF-01]", () => {
  it("loads offloaded body lazily only for the active item and preserves unmodified payload on Continue", async () => {
    const bp1 = makeOffloadedItem("bp-req-1", 1, 400_000);
    const bp2 = makeOffloadedItem("bp-req-2", 2, 420_000);

    mockLoadBreakpointBody.mockImplementation(async (bpId: string) => ({
      id: bpId === "bp-req-1" ? 1 : 2,
      isResponse: false,
      bodyBase64: "",
      bodyText: JSON.stringify({ loadedFor: bpId }),
      bodySize: 400_000,
    }));

    const onResolve = vi.fn(async (_resolution: BreakpointResolution) => true);

    render(
      <BreakpointsPanel
        isActive={true}
        requestedMode="intercept"
        pausedItems={[bp1, bp2]}
        config={DEFAULT_CFG}
        resolvedTheme="dark"
        onUpdateConfig={vi.fn(async () => DEFAULT_CFG)}
        onResolve={onResolve}
        onResumeAll={vi.fn(async () => {})}
      />
    );

    // Only bp-req-1 is fetched automatically; bp-req-2 must not be prefetched.
    await waitFor(() => {
      expect(mockLoadBreakpointBody).toHaveBeenCalledTimes(1);
      expect(mockLoadBreakpointBody).toHaveBeenCalledWith("bp-req-1", false);
    });

    await waitFor(() => {
      expect(screen.getByTestId("monaco-bp-editor").textContent).toContain(
        "bp-req-1"
      );
    });

    // Clicking Continue without modifying the body must NOT send requestBodyText/requestBodyBase64
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledTimes(1);
    });
    const resolutionArg = onResolve.mock.calls[0]?.[0];
    expect(resolutionArg?.breakpointId).toBe("bp-req-1");
    expect(resolutionArg?.action).toBe("continue");
    expect(resolutionArg?.requestBodyText).toBeUndefined();
    expect(resolutionArg?.requestBodyBase64).toBeUndefined();

    // Clicking queue item #2 triggers lazy fetch for bp-req-2
    fireEvent.click(screen.getByText("#2"));
    await waitFor(() => {
      expect(mockLoadBreakpointBody).toHaveBeenCalledWith("bp-req-2", false);
    });
  });
});
