import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "../types/proxy";
import { ContextMenuProvider } from "./ui/ContextMenu";

const { mockBridge } = await vi.hoisted(async () => {
  const { createStatefulMockProxyBridge } = await import(
    "../test/mockProxyBridge"
  );
  const env = createStatefulMockProxyBridge();
  return { mockBridge: env.bridge };
});

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({
    value,
    language,
    path,
  }: {
    value?: string;
    language?: string;
    path?: string;
  }) => (
    <pre
      data-testid="monaco-inspector-mock"
      data-language={language ?? ""}
      data-path={path ?? ""}
    >
      {value ?? ""}
    </pre>
  ),
}));

vi.mock("../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauriBridge")>();
  return {
    ...actual,
    isTauriRuntime: () => false,
    proxyBridge: mockBridge,
  };
});

import { SessionInspector } from "./SessionInspector";

function makeDetail(
  overrides: Partial<SessionDetail> = {},
  summaryOverrides: Partial<SessionDetail["summary"]> = {}
): SessionDetail {
  return {
    summary: {
      id: 10,
      status: 200,
      protocol: "HTTPS/1.1",
      scheme: "https",
      method: "POST",
      host: "api.example.com",
      path: "/v1/orders?page=2&sort=desc",
      url: "https://api.example.com/v1/orders?page=2&sort=desc",
      contentType: "application/json",
      bodySize: 28,
      durationMs: 42,
      ttfbMs: 18,
      timestamp: "12:00:00.000",
      isMocked: false,
      ...summaryOverrides,
    },
    requestHeaders: [
      { name: "Host", value: "api.example.com" },
      { name: "Cookie", value: "session_id=abc123; theme=dark" },
      { name: "Content-Type", value: "application/json" },
    ],
    responseHeaders: [
      { name: "Content-Type", value: "application/json" },
      { name: "Set-Cookie", value: "csrf=xyz999; HttpOnly" },
    ],
    requestBodyBase64: btoa('{"query":"hello"}'),
    responseBodyBase64: btoa('{"ok":true,"count":3}'),
    requestBodyText: '{"query":"hello"}',
    responseBodyText: '{"ok":true,"count":3}',
    clientAddr: "127.0.0.1:51000",
    websocketFrames: [],
    ...overrides,
  };
}

function renderInspector(
  overrides: Partial<React.ComponentProps<typeof SessionInspector>> = {}
) {
  const props: React.ComponentProps<typeof SessionInspector> = {
    detail: makeDetail(),
    resolvedTheme: "dark",
    onReplaySession: vi.fn(),
    onSendToComposer: vi.fn(),
    onChangeInspectorPosition: vi.fn(),
    onNotify: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...render(
      <ContextMenuProvider>
        <SessionInspector {...props} />
      </ContextMenuProvider>
    ),
  };
}

describe("SessionInspector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders empty guidance state when no session is selected", () => {
    renderInspector({ detail: null });
    expect(screen.getByText("Session Inspector")).toBeTruthy();
    expect(
      screen.getByText(
        /Выберите любую HTTP, HTTPS, SSE, gRPC или WebSocket сессию/i
      )
    ).toBeTruthy();
  });

  it("switches Request/Response tabs (Headers, Params, Cookies, Raw, Hex) and Inspector/Statistics view mode", () => {
    renderInspector();

    // Default Headers tab shows request & response headers
    expect(screen.getAllByText("api.example.com").length).toBeGreaterThan(0);

    // Params tab parses URL query string
    fireEvent.click(screen.getByRole("button", { name: /^Params/i }));
    expect(screen.getByText("page")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("sort")).toBeTruthy();

    // Cookies tab shows parsed request cookies
    fireEvent.click(screen.getAllByRole("button", { name: /^Cookies/i })[0]);
    expect(screen.getByText("session_id")).toBeTruthy();
    expect(screen.getByText("abc123")).toBeTruthy();

    // Switch to Statistics mode inside inspector
    fireEvent.click(screen.getByRole("button", { name: /^Statistics/i }));
    expect(
      screen
        .getByRole("button", { name: /^Statistics/i })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getByText(/#10 · POST api\.example\.com/i)).toBeTruthy();

    // Return to Inspectors mode
    fireEvent.click(screen.getByRole("button", { name: /^Inspectors/i }));
    expect(
      screen.getAllByRole("button", { name: /^Raw$/i }).length
    ).toBeGreaterThanOrEqual(2);
  });

  it("renders safe SVG source text instead of active <img> and triggers lazy offloaded body fetch", async () => {
    const svgDetail = makeDetail(
      {
        responseBodyText: "<svg><circle r='5'/></svg>",
        responseBodyBase64: btoa("<svg><circle r='5'/></svg>"),
      },
      { contentType: "image/svg+xml" }
    );
    const { rerender, container } = renderInspector({ detail: svgDetail });

    fireEvent.click(screen.getByRole("button", { name: /^Image/i }));
    expect(
      screen.getByText(/SVG-изображение/i)
    ).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<svg><circle r='5'/></svg>")).toBeTruthy();

    // Offloaded response body fetches lazily on button click
    const offloadedDetail = makeDetail(
      {
        bodyOffloaded: true,
        responseBodyBase64: "",
        responseBodyText: null,
      },
      { id: 77, bodySize: 512_000 }
    );
    mockBridge.loadSessionBody.mockResolvedValueOnce({
      id: 77,
      isResponse: true,
      bodyBase64: btoa('{"lazy":true}'),
      bodyText: '{"lazy":true}',
      bodySize: 13,
    });

    rerender(
      <ContextMenuProvider>
        <SessionInspector
          detail={offloadedDetail}
          resolvedTheme="dark"
          onSendToComposer={vi.fn()}
          onReplaySession={vi.fn()}
        />
      </ContextMenuProvider>
    );

    fireEvent.click(screen.getAllByRole("button", { name: /^JSON$/i })[1]);
    fireEvent.click(
      screen.getByRole("button", { name: /Загрузить тело ответа/i })
    );

    await waitFor(() => {
      expect(mockBridge.loadSessionBody).toHaveBeenCalledWith(77, true);
    });
    await waitFor(() => {
      expect(
        screen.getAllByTestId("monaco-inspector-mock").some((el) =>
          el.textContent?.includes('"lazy": true')
        )
      ).toBe(true);
    });
  });

  it("invokes Replay, Send to Composer, and Dock position actions from summary toolbar", () => {
    const { props } = renderInspector({ inspectorPosition: "bottom" });

    fireEvent.click(screen.getByRole("button", { name: /Replay/i }));
    expect(props.onReplaySession).toHaveBeenCalledWith(10);

    fireEvent.click(screen.getByRole("button", { name: /Composer/i }));
    expect(props.onSendToComposer).toHaveBeenCalledWith(10);

    fireEvent.click(screen.getByTitle("Dock Inspector to Right"));
    expect(props.onChangeInspectorPosition).toHaveBeenCalledWith("right");
  });
});
