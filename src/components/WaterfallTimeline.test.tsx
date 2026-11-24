import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../types/proxy";
import { WaterfallTimeline } from "./WaterfallTimeline";

beforeAll(() => {
  // jsdom does not lay out elements, so provide stable client dimensions for @tanstack/react-virtual
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    value: 960,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    value: 420,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: 420,
  });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 960,
      bottom: 420,
      width: 960,
      height: 420,
      toJSON: () => ({}),
    };
  };
});

function createSessionsFixture(): SessionSummary[] {
  return [
    {
      id: 1,
      status: 200,
      protocol: "HTTPS/2",
      scheme: "https",
      method: "GET",
      host: "api.fluxproxy.dev",
      path: "/v1/bootstrap",
      url: "https://api.fluxproxy.dev/v1/bootstrap",
      contentType: "application/json",
      bodySize: 2048,
      wireBodySize: 800,
      durationMs: 120,
      timestamp: "2026-11-24T10:00:00.000Z",
      isMocked: false,
      dnsMs: 12,
      connectMs: 18,
      tlsMs: 30,
      ttfbMs: 40,
      receiveMs: 15,
      serverConnReused: false,
    },
    {
      id: 2,
      status: 404,
      protocol: "HTTPS/2",
      scheme: "https",
      method: "GET",
      host: "cdn.fluxproxy.dev",
      path: "/missing.png",
      url: "https://cdn.fluxproxy.dev/missing.png",
      contentType: "image/png",
      bodySize: 512,
      durationMs: 80,
      timestamp: "2026-11-24T10:00:00.200Z",
      isMocked: false,
      // No compact phase breakdown -> should render single fallback bar
    },
    {
      id: 3,
      status: 200,
      protocol: "HTTPS/2",
      scheme: "https",
      method: "POST",
      host: "api.fluxproxy.dev",
      path: "/v1/orders",
      url: "https://api.fluxproxy.dev/v1/orders",
      contentType: "application/json",
      bodySize: 4096,
      durationMs: 200,
      timestamp: "2026-11-24T10:00:00.500Z",
      isMocked: false,
      dnsMs: 0,
      connectMs: 0,
      tlsMs: 0,
      ttfbMs: 150,
      receiveMs: 40,
      serverConnReused: true,
    },
  ];
}

describe("WaterfallTimeline", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders multi-phase bars (DNS/TCP/TLS/TTFB/Download) and fallback single bars for legacy sessions", () => {
    const sessions = createSessionsFixture();
    const { container } = render(
      <WaterfallTimeline
        sessions={sessions}
        selectedId={1}
        onSelectSession={vi.fn()}
      />
    );

    // Session #1 has full 5-phase breakdown
    const bar1 = container.querySelector<HTMLButtonElement>(
      '[data-waterfall-bar="1"]'
    );
    expect(bar1).toBeTruthy();
    expect(bar1?.dataset.fallback).toBe("false");
    expect(bar1?.querySelector('[data-phase="dns"]')).toBeTruthy();
    expect(bar1?.querySelector('[data-phase="connect"]')).toBeTruthy();
    expect(bar1?.querySelector('[data-phase="tls"]')).toBeTruthy();
    expect(bar1?.querySelector('[data-phase="ttfb"]')).toBeTruthy();
    expect(bar1?.querySelector('[data-phase="receive"]')).toBeTruthy();

    // Session #2 lacks phase fields -> single fallback bar
    const bar2 = container.querySelector<HTMLButtonElement>(
      '[data-waterfall-bar="2"]'
    );
    expect(bar2).toBeTruthy();
    expect(bar2?.dataset.fallback).toBe("true");
    expect(bar2?.querySelector('[data-phase="fallback"]')).toBeTruthy();
    expect(bar2?.querySelector('[data-phase="dns"]')).toBeNull();

    // Session #3 is reused (only TTFB + Download > 0)
    const bar3 = container.querySelector<HTMLButtonElement>(
      '[data-waterfall-bar="3"]'
    );
    expect(bar3).toBeTruthy();
    expect(bar3?.dataset.fallback).toBe("false");
    expect(bar3?.querySelector('[data-phase="dns"]')).toBeNull();
    expect(bar3?.querySelector('[data-phase="ttfb"]')).toBeTruthy();
    expect(bar3?.querySelector('[data-phase="receive"]')).toBeTruthy();

    // Verify relative offset ordering: bar3 left > bar2 left > bar1 left
    const left1 = parseFloat(bar1!.style.left);
    const left2 = parseFloat(bar2!.style.left);
    const left3 = parseFloat(bar3!.style.left);
    expect(left1).toBe(0);
    expect(left2).toBeGreaterThan(left1);
    expect(left3).toBeGreaterThan(left2);
  });

  it("supports Zoom In, Zoom Out, and Fit All controls", () => {
    const sessions = createSessionsFixture();
    render(
      <WaterfallTimeline
        sessions={sessions}
        selectedId={null}
        onSelectSession={vi.fn()}
      />
    );

    expect(screen.getByText("100%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
    expect(screen.getByText("150%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
    expect(screen.getByText("225%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Zoom Out" }));
    expect(screen.getByText("150%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Fit All" }));
    expect(screen.getByText("100%")).toBeTruthy();
  });

  it("shows floating tooltip with exact start, duration, and phase breakdown on hover/focus and dismisses on leave or Escape", () => {
    const sessions = createSessionsFixture();
    const { container } = render(
      <WaterfallTimeline
        sessions={sessions}
        selectedId={null}
        onSelectSession={vi.fn()}
      />
    );

    const bar1 = container.querySelector<HTMLButtonElement>(
      '[data-waterfall-bar="1"]'
    )!;
    fireEvent.mouseEnter(bar1, { clientX: 200, clientY: 120 });

    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("#1");
    expect(tip.textContent).toContain("DNS Lookup");
    expect(tip.textContent).toContain("TCP Connect");
    expect(tip.textContent).toContain("TLS Handshake");
    expect(tip.textContent).toContain("Wait (TTFB)");
    expect(tip.textContent).toContain("Download");
    expect(tip.textContent).toContain("120.00 ms");

    fireEvent.mouseLeave(bar1);
    expect(screen.queryByRole("tooltip")).toBeNull();

    // Focus opens tooltip and Escape dismisses it (WCAG 1.4.13)
    const bar2 = container.querySelector<HTMLButtonElement>(
      '[data-waterfall-bar="2"]'
    )!;
    fireEvent.focus(bar2);
    const tip2 = screen.getByRole("tooltip");
    expect(tip2.textContent).toContain("404 Client Error");
    expect(tip2.textContent).toContain("+200.00 ms");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("synchronizes selectedId with SessionInspector on click and keyboard navigation", () => {
    const onSelectSession = vi.fn();
    const onFocusInspector = vi.fn();
    const sessions = createSessionsFixture();
    const { container } = render(
      <WaterfallTimeline
        sessions={sessions}
        selectedId={1}
        onSelectSession={onSelectSession}
        onFocusInspector={onFocusInspector}
      />
    );

    const bar3 = container.querySelector<HTMLButtonElement>(
      '[data-waterfall-bar="3"]'
    )!;
    fireEvent.click(bar3);
    expect(onSelectSession).toHaveBeenCalledWith(3);

    const root = screen.getByLabelText("Waterfall Timeline");
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(onSelectSession).toHaveBeenCalledWith(2);

    fireEvent.keyDown(root, { key: "Enter" });
    expect(onFocusInspector).toHaveBeenCalledTimes(1);
  });

  it("virtualizes 10,000+ sessions rendering only a bounded viewport slice", () => {
    const baseMs = Date.parse("2026-11-24T10:00:00.000Z");
    const bigSample: SessionSummary[] = Array.from({ length: 10_000 }, (_, i) => ({
      id: i + 1,
      status: i % 10 === 0 ? 500 : 200,
      protocol: "HTTPS/2",
      scheme: "https",
      method: "GET",
      host: `svc-${i % 10}.fluxproxy.dev`,
      path: `/api/item/${i}`,
      url: `https://svc-${i % 10}.fluxproxy.dev/api/item/${i}`,
      contentType: "application/json",
      bodySize: 512 + (i % 4096),
      durationMs: 15 + (i % 250),
      timestamp: new Date(baseMs + i * 5).toISOString(),
      isMocked: false,
      ttfbMs: 10 + (i % 120),
      receiveMs: 5,
    }));

    const { container } = render(
      <WaterfallTimeline
        sessions={bigSample}
        selectedId={1}
        onSelectSession={vi.fn()}
      />
    );

    expect(screen.getByText("10,000")).toBeTruthy();
    const renderedRows = container.querySelectorAll("[data-waterfall-row]");
    expect(renderedRows.length).toBeGreaterThan(5);
    expect(renderedRows.length).toBeLessThan(80);
  });
});
