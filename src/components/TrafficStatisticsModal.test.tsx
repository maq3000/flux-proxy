import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../types/proxy";
import { TrafficStatisticsModal } from "./TrafficStatisticsModal";

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
});

function createSampleSessions(): SessionSummary[] {
  return [
    {
      id: 10,
      status: 200,
      protocol: "HTTPS/2",
      scheme: "https",
      method: "GET",
      host: "api.fluxproxy.dev",
      path: "/v1/feed",
      url: "https://api.fluxproxy.dev/v1/feed",
      contentType: "application/json; charset=utf-8",
      bodySize: 10_240,
      wireBodySize: 3_072,
      requestSize: 240,
      durationMs: 120,
      ttfbMs: 75,
      serverConnReused: true,
      timestamp: "2026-11-24T12:00:00.000Z",
      isMocked: false,
    },
    {
      id: 11,
      status: 304,
      protocol: "HTTPS/2",
      scheme: "https",
      method: "GET",
      host: "cdn.fluxproxy.dev",
      path: "/assets/app.js",
      url: "https://cdn.fluxproxy.dev/assets/app.js",
      contentType: "application/javascript",
      bodySize: 40_960,
      wireBodySize: 12_288,
      requestSize: 180,
      durationMs: 45,
      ttfbMs: 25,
      serverConnReused: true,
      timestamp: "2026-11-24T12:00:00.150Z",
      isMocked: false,
    },
    {
      id: 12,
      status: 404,
      protocol: "HTTPS/2",
      scheme: "https",
      method: "GET",
      host: "api.fluxproxy.dev",
      path: "/v1/unknown",
      url: "https://api.fluxproxy.dev/v1/unknown",
      contentType: "application/json",
      bodySize: 512,
      wireBodySize: 512,
      requestSize: 210,
      durationMs: 310,
      ttfbMs: 280,
      serverConnReused: false,
      timestamp: "2026-11-24T12:00:00.400Z",
      isMocked: false,
    },
    {
      id: 13,
      status: 503,
      protocol: "HTTPS/2",
      scheme: "https",
      method: "POST",
      host: "payments.fluxproxy.dev",
      path: "/v2/charge",
      url: "https://payments.fluxproxy.dev/v2/charge",
      contentType: "text/html",
      bodySize: 1024,
      wireBodySize: 1024,
      requestSize: 640,
      durationMs: 850,
      ttfbMs: 810,
      serverConnReused: false,
      error: "Upstream Service Unavailable",
      timestamp: "2026-11-24T12:00:00.800Z",
      isMocked: false,
    },
    {
      id: 14,
      status: 0,
      protocol: "HTTPS/2",
      scheme: "https",
      method: "GET",
      host: "stream.fluxproxy.dev",
      path: "/v1/events",
      url: "https://stream.fluxproxy.dev/v1/events",
      contentType: "text/event-stream",
      bodySize: 0,
      wireBodySize: 0,
      requestSize: 190,
      durationMs: 15,
      timestamp: "2026-11-24T12:00:01.000Z",
      isMocked: false,
    },
  ];
}

describe("TrafficStatisticsModal", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders native modal <dialog> with status buckets (2xx-5xx/Pending), MIME, hosts, and top-5 tables", () => {
    const sessions = createSampleSessions();
    const onSelectSession = vi.fn();
    const onClose = vi.fn();

    const { container } = render(
      <TrafficStatisticsModal
        open={true}
        onClose={onClose}
        filteredSessions={sessions}
        selectedSessions={sessions.slice(0, 2)}
        totalCapturedCount={10}
        filterQuery="fluxproxy.dev"
        onSelectSession={onSelectSession}
      />
    );

    const dialog = container.querySelector("dialog[open]");
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute("role")).toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBeNull();
    expect(dialog?.getAttribute("closedby")).toBe("any");
    expect(
      screen.getByRole("heading", { level: 1, name: "Traffic Statistics" })
    ).toBeTruthy();

    // Status distribution includes all 5 canonical groups: 2xx, 3xx, 4xx, 5xx, Pending
    for (const grp of ["2xx", "3xx", "4xx", "5xx", "Pending"]) {
      const bucketEl = container.querySelector(`[data-status-bucket="${grp}"]`);
      expect(bucketEl).toBeTruthy();
      expect(bucketEl?.textContent).toContain("1 (20.0%)");
    }

    // Host and Content-Type summaries
    expect(screen.getAllByText("api.fluxproxy.dev").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("payments.fluxproxy.dev").length
    ).toBeGreaterThan(0);
    expect(screen.getByText("application/json")).toBeTruthy();
    expect(screen.getByText("javascript")).toBeTruthy();

    // Clicking slowest URL selects session and closes modal
    const slowestSection = screen.getByRole("region", {
      name: "Top 5 Slowest URLs",
    });
    const heaviestSection = screen.getByRole("region", {
      name: "Top 5 Heaviest URLs",
    });
    expect(within(heaviestSection).getByText("40.0 KB")).toBeTruthy();

    const slowBtn = within(slowestSection).getByTitle(
      "Select session #13: https://payments.fluxproxy.dev/v2/charge"
    );
    fireEvent.click(slowBtn);
    expect(onSelectSession).toHaveBeenCalledWith(13);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("switches between Filtered and Selected sample scopes", () => {
    const sessions = createSampleSessions();
    render(
      <TrafficStatisticsModal
        open={true}
        onClose={vi.fn()}
        filteredSessions={sessions}
        selectedSessions={sessions.slice(0, 2)}
        totalCapturedCount={5}
      />
    );

    const filteredBtn = screen.getByRole("button", { name: "Filtered (5)" });
    const selectedBtn = screen.getByRole("button", { name: "Selected (2)" });
    expect(filteredBtn.getAttribute("aria-pressed")).toBe("true");
    expect(selectedBtn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(selectedBtn);
    expect(selectedBtn.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("2 / 5 sessions")).toBeTruthy();
  });

  it("copies full Markdown report to clipboard on Copy Markdown Report click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const onNotify = vi.fn();
    render(
      <TrafficStatisticsModal
        open={true}
        onClose={vi.fn()}
        filteredSessions={createSampleSessions()}
        totalCapturedCount={5}
        onNotify={onNotify}
      />
    );

    const copyBtn = screen.getByRole("button", {
      name: /Copy Markdown Report/i,
    });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });

    const md = writeText.mock.calls[0][0] as string;
    expect(md).toContain("# FluxProxy Traffic Statistics Report");
    expect(md).toContain("## Status Code Distribution");
    expect(md).toContain("| Pending |");
    expect(md).toContain("## Breakdown by Content-Type");
    expect(md).toContain("## Breakdown by Host");
    expect(md).toContain("## Top 5 Slowest URLs");
    expect(md).toContain("## Top 5 Heaviest URLs");
    expect(onNotify).toHaveBeenCalled();
  });
});
