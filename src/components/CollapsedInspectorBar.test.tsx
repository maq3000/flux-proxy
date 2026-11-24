import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollapsedInspectorBar } from "./CollapsedInspectorBar";
import type { SessionSummary } from "../types/proxy";

const SAMPLE_SESSION: SessionSummary = {
  id: 42,
  status: 201,
  protocol: "HTTPS",
  scheme: "https",
  method: "POST",
  host: "api.example.com",
  path: "/v1/orders?dryRun=1",
  url: "https://api.example.com/v1/orders?dryRun=1",
  contentType: "application/json",
  bodySize: 512,
  durationMs: 38,
  timestamp: "12:00:00.000",
  isMocked: false,
};

describe("CollapsedInspectorBar", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders bottom horizontal restore bar with session preview and fires callbacks", () => {
    const onExpand = vi.fn();
    const onOpenStatistics = vi.fn();
    const onChangePosition = vi.fn();

    render(
      <CollapsedInspectorBar
        position="bottom"
        selectedSession={SAMPLE_SESSION}
        selectedCount={1}
        onExpand={onExpand}
        onOpenStatistics={onOpenStatistics}
        onChangePosition={onChangePosition}
      />
    );

    const toolbar = screen.getByRole("toolbar", {
      name: "Collapsed Session Inspector",
    });
    expect(toolbar.className).toContain("h-7");

    const expandBtn = screen.getByRole("button", {
      name: /Expand Session Inspector/i,
    });
    expect(expandBtn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("#42")).toBeTruthy();
    expect(screen.getByText("POST")).toBeTruthy();
    expect(screen.getByText("/v1/orders?dryRun=1")).toBeTruthy();
    expect(screen.getByText("201")).toBeTruthy();
    expect(screen.getByText("Enter")).toBeTruthy();

    fireEvent.click(expandBtn);
    expect(onExpand).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Statistics" }));
    expect(onOpenStatistics).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dock Right" }));
    expect(onChangePosition).toHaveBeenCalledWith("right");
  });

  it("shows multi-selection summary in bottom mode when more than one session is selected", () => {
    render(
      <CollapsedInspectorBar
        position="bottom"
        selectedSession={SAMPLE_SESSION}
        selectedCount={3}
        onExpand={vi.fn()}
        onOpenStatistics={vi.fn()}
        onChangePosition={vi.fn()}
      />
    );

    expect(screen.getByText("3 sessions selected")).toBeTruthy();
  });

  it("renders right vertical restore rail and fires callbacks", () => {
    const onExpand = vi.fn();
    const onOpenStatistics = vi.fn();
    const onChangePosition = vi.fn();

    render(
      <CollapsedInspectorBar
        position="right"
        selectedSession={SAMPLE_SESSION}
        selectedCount={1}
        onExpand={onExpand}
        onOpenStatistics={onOpenStatistics}
        onChangePosition={onChangePosition}
      />
    );

    const toolbar = screen.getByRole("toolbar", {
      name: "Collapsed Session Inspector",
    });
    expect(toolbar.getAttribute("aria-orientation")).toBe("vertical");
    expect(toolbar.className).toContain("w-7");
    expect(screen.getByText("Session Inspector")).toBeTruthy();

    const expandBtn = screen.getByRole("button", {
      name: "Expand Session Inspector",
    });
    expect(expandBtn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expandBtn);
    expect(onExpand).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Open Statistics" }));
    expect(onOpenStatistics).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dock Bottom" }));
    expect(onChangePosition).toHaveBeenCalledWith("bottom");
  });
});
