import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionDetail } from "../types/proxy";
import { SessionStatisticsPanel } from "./SessionStatisticsPanel";

function createSampleDetail(): SessionDetail {
  return {
    summary: {
      id: 101,
      status: 200,
      protocol: "HTTPS/2",
      scheme: "https",
      method: "GET",
      host: "api.fluxproxy.dev",
      path: "/v1/orders",
      url: "https://api.fluxproxy.dev/v1/orders",
      contentType: "application/json",
      bodySize: 1024,
      durationMs: 120,
      timestamp: "2026-11-24T07:00:00.000Z",
      isMocked: false,
      ttfbMs: 42,
      dnsMs: 12,
      connectMs: 18,
      tlsMs: 28,
      receiveMs: 8,
      requestSize: 320,
      wireBodySize: 512,
      serverIp: "93.184.216.34",
      serverConnReused: false,
    },
    requestHeaders: [{ name: "Host", value: "api.fluxproxy.dev" }],
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    requestBodyBase64: "",
    responseBodyBase64: "",
    tlsVersion: "TLSv1.3",
    clientAddr: "127.0.0.1:52000",
    websocketFrames: [],
    timings: {
      clientConnected: "2026-11-24T07:00:00.000000Z",
      clientBeginRequest: "2026-11-24T07:00:00.001000Z",
      gotRequestHeaders: "2026-11-24T07:00:00.002000Z",
      clientDoneRequest: "2026-11-24T07:00:00.003000Z",
      proxyBeginRequest: "2026-11-24T07:00:00.004000Z",
      serverConnected: "2026-11-24T07:00:00.062000Z",
      serverGotRequest: "2026-11-24T07:00:00.064000Z",
      serverBeginResponse: "2026-11-24T07:00:00.106000Z",
      gotResponseHeaders: "2026-11-24T07:00:00.107000Z",
      serverDoneResponse: "2026-11-24T07:00:00.115000Z",
      clientBeginResponse: "2026-11-24T07:00:00.117000Z",
      clientDoneResponse: "2026-11-24T07:00:00.120000Z",
      dnsMs: 12,
      tcpConnectMs: 18,
      tlsHandshakeMs: 28,
      sendRequestMs: 2,
      serverWaitMs: 42,
      contentDownloadMs: 8,
      clientSendMs: 3,
      overallElapsedMs: 120,
      netElapsedMs: 112,
    },
    transferStats: {
      requestHeadersBytes: 180,
      requestBodyBytes: 0,
      requestWireBodyBytes: 0,
      responseHeadersBytes: 160,
      responseBodyBytes: 1024,
      responseWireBodyBytes: 512,
      serverAddr: "93.184.216.34:443",
      serverConnReused: false,
    },
  };
}

describe("SessionStatisticsPanel Timing Breakdown tooltip", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders static non-interactive Phase Legend items that never trigger the tooltip", () => {
    const { container } = render(
      <SessionStatisticsPanel detail={createSampleDetail()} />
    );

    const legendItems = Array.from(
      container.querySelectorAll<HTMLElement>("[data-phase-legend]")
    );
    expect(legendItems.length).toBeGreaterThan(2);

    for (const item of legendItems) {
      expect(item.tagName).toBe("DIV");
      fireEvent.mouseEnter(item);
      fireEvent.focus(item);
      expect(screen.queryByRole("tooltip")).toBeNull();
    }
  });

  it("shows floating overlay tooltip only when hovering/focusing timeline segments and dismisses on leave or Escape", () => {
    const { container } = render(
      <SessionStatisticsPanel detail={createSampleDetail()} />
    );

    const timelineGroup = screen.getByRole("group", {
      name: "Request lifecycle phase timing segments",
    });
    const segments = Array.from(
      timelineGroup.querySelectorAll<HTMLButtonElement>("button")
    );
    expect(segments.length).toBeGreaterThan(2);

    // Hover first timeline segment
    fireEvent.mouseEnter(segments[0]);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.className).toContain("pointer-events-none");
    expect(tooltip.className).toContain("absolute");
    expect(tooltip.className).toContain("top-full");
    expect(tooltip.className).toContain("z-20");

    // Matching legend item highlights passively without shifting layout
    const legendItems = Array.from(
      container.querySelectorAll<HTMLElement>("[data-phase-legend]")
    );
    expect(
      legendItems.some((el) => el.className.includes("ring-1"))
    ).toBe(true);

    // Leaving segment hides tooltip
    fireEvent.mouseLeave(segments[0]);
    expect(screen.queryByRole("tooltip")).toBeNull();

    // Focus opens tooltip and Escape dismisses it
    fireEvent.focus(segments[1]);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
