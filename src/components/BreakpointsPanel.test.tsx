import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadBreakpointBody, mockProxyBridge } = await vi.hoisted(
  async () => {
    const { createStatefulMockProxyBridge } = await import(
      "../test/mockProxyBridge"
    );
    const env = createStatefulMockProxyBridge();
    return {
      mockLoadBreakpointBody: env.bridge.loadBreakpointBody,
      mockProxyBridge: env.bridge,
    };
  }
);

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({
    value,
    path,
    onChange,
  }: {
    value?: string;
    path?: string;
    onChange?: (next: string) => void;
  }) => (
    <textarea
      data-testid="monaco-bp-editor"
      data-path={path ?? ""}
      value={value ?? ""}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

vi.mock("../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauriBridge")>();
  return {
    ...actual,
    isTauriRuntime: () => false,
    proxyBridge: mockProxyBridge,
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
      expect(
        (screen.getByTestId("monaco-bp-editor") as HTMLTextAreaElement).value
      ).toContain("bp-req-1");
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

describe("BreakpointsPanel — Rules CRUD, header/body edits & verdict actions", () => {
  it("toggles global Break Before Request / After Response switches and creates, toggles, and deletes conditional bpu rules", async () => {
    const initialCfg: BreakpointConfig = {
      breakBeforeRequest: false,
      breakAfterResponse: false,
      timeoutSecs: 120,
      rules: [
        {
          id: "bp-rule-existing",
          enabled: true,
          name: "bpu /auth",
          stage: "request",
          urlPattern: "/auth",
          methodFilter: "POST",
        },
      ],
    };

    const onUpdateConfig = vi.fn(async (next: BreakpointConfig) => next);

    render(
      <BreakpointsPanel
        isActive={true}
        requestedMode="rules"
        pausedItems={[]}
        config={initialCfg}
        resolvedTheme="dark"
        onUpdateConfig={onUpdateConfig}
        onResolve={vi.fn(async () => true)}
        onResumeAll={vi.fn(async () => {})}
      />
    );

    fireEvent.click(screen.getByLabelText(/Break Before Request/i));
    await waitFor(() => {
      expect(onUpdateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ breakBeforeRequest: true })
      );
    });

    fireEvent.change(screen.getByLabelText("Фаза точки останова"), {
      target: { value: "response" },
    });
    fireEvent.change(screen.getByLabelText("Фильтр HTTP метода"), {
      target: { value: "GET" },
    });
    fireEvent.change(screen.getByLabelText("Шаблон URL правила точки останова"), {
      target: { value: "/v1/profile" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Добавить правило/i }));

    await waitFor(() => {
      const lastCall = onUpdateConfig.mock.calls.at(-1)?.[0];
      expect(lastCall?.rules).toHaveLength(2);
      expect(lastCall?.rules[0]).toMatchObject({
        enabled: true,
        stage: "response",
        methodFilter: "GET",
        urlPattern: "/v1/profile",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Удалить правило /auth" }));
    await waitFor(() => {
      const lastCall = onUpdateConfig.mock.calls.at(-1)?.[0];
      expect(lastCall?.rules).toHaveLength(0);
    });
  });

  it("edits intercepted headers/body, forwards Continue overrides, and supports Abort and Resume All", async () => {
    const inlineItem: PausedBreakpointItem = {
      ...makeOffloadedItem("bp-inline-1", 55, 18),
      requestBodyOffloaded: false,
      bodyOffloaded: false,
      requestBodyText: '{"amount":100}',
    };
    const inlineItem2: PausedBreakpointItem = {
      ...makeOffloadedItem("bp-inline-2", 56, 10),
      requestBodyOffloaded: false,
      bodyOffloaded: false,
      requestBodyText: '{"amount":200}',
    };

    const onResolve = vi.fn(async (_res: BreakpointResolution) => true);
    const onResumeAll = vi.fn(async () => {});

    render(
      <BreakpointsPanel
        isActive={true}
        requestedMode="intercept"
        pausedItems={[inlineItem, inlineItem2]}
        config={DEFAULT_CFG}
        resolvedTheme="dark"
        onUpdateConfig={vi.fn(async () => DEFAULT_CFG)}
        onResolve={onResolve}
        onResumeAll={onResumeAll}
      />
    );

    // Modify body in Monaco editor mock
    fireEvent.change(screen.getByTestId("monaco-bp-editor"), {
      target: { value: '{"amount":999}' },
    });

    // Switch to Headers tab and append a custom header
    fireEvent.click(screen.getByRole("button", { name: /Headers/i }));
    fireEvent.click(screen.getByRole("button", { name: /Добавить заголовок/i }));

    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledTimes(1);
    });
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({
      breakpointId: "bp-inline-1",
      action: "continue",
      requestBodyText: '{"amount":999}',
      requestHeaders: expect.arrayContaining([
        { name: "X-Debug-Intercepted", value: "true" },
      ]),
    });

    fireEvent.click(screen.getByRole("button", { name: /Abort/i }));
    await waitFor(() => {
      expect(onResolve).toHaveBeenLastCalledWith({
        breakpointId: "bp-inline-1",
        action: "abort",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /Пропустить всю очередь/i }));
    await waitFor(() => {
      expect(onResumeAll).toHaveBeenCalledWith("continue");
    });
  });
});
