import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenuProvider } from "./ui/ContextMenu";
import {
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_VISIBLE_COLUMNS,
} from "../hooks/useUiPreferences";
import { DEFAULT_NOISE_THRESHOLDS } from "../lib/filterEngine";
import type { SessionSummary } from "../types/proxy";

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 28,
        size: 28,
      })),
    scrollToIndex: vi.fn(),
  }),
}));

import { TrafficGrid } from "./TrafficGrid";

function makeSession(
  id: number,
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    id,
    status: 200,
    protocol: "HTTPS/1.1",
    scheme: "https",
    method: "GET",
    host: "api.example.com",
    path: `/v1/resource/${id}`,
    url: `https://api.example.com/v1/resource/${id}`,
    contentType: "application/json",
    bodySize: 512,
    durationMs: 24,
    timestamp: "12:00:00.000",
    isMocked: false,
    ...overrides,
  };
}

function renderTrafficGrid(
  overrides: Partial<React.ComponentProps<typeof TrafficGrid>> = {}
) {
  const props: React.ComponentProps<typeof TrafficGrid> = {
    sessions: [
      makeSession(1, { method: "GET", status: 200, host: "zeta.test", path: "/first" }),
      makeSession(2, {
        method: "POST",
        status: 500,
        host: "alpha.test",
        path: "/fail",
        isMocked: true,
        comment: "investigate 500",
      }),
      makeSession(3, { method: "DELETE", status: 204, host: "beta.test", path: "/item" }),
    ],
    totalSessionsCount: 3,
    proxyRunning: true,
    hasActiveFilters: false,
    selectedId: 1,
    selectedIds: [1],
    visibleColumns: { ...DEFAULT_VISIBLE_COLUMNS },
    columnWidths: { ...DEFAULT_COLUMN_WIDTHS },
    onColumnWidthChange: vi.fn(),
    onToggleColumnVisibility: vi.fn(),
    onResetColumns: vi.fn(),
    onSelectSession: vi.fn(),
    onToggleSelectSession: vi.fn(),
    onSelectSessionRange: vi.fn(),
    onSelectAllSessions: vi.fn(),
    onSortedSessionsChange: vi.fn(),
    onFocusInspector: vi.fn(),
    onDeleteSessions: vi.fn(),
    onReplaySessions: vi.fn(),
    onUnmarkSessions: vi.fn(),
    onCopyUrl: vi.fn(),
    onCopyCurl: vi.fn(),
    onCopyHeaders: vi.fn(),
    onCompareWithSession: vi.fn(),
    onSwapCompare: vi.fn(),
    onOpenDiffModal: vi.fn(),
    onAnnotateSessions: vi.fn(),
    onSendToComposer: vi.fn(),
    onCreateRuleFromSession: vi.fn(),
    thresholds: { ...DEFAULT_NOISE_THRESHOLDS },
    followTail: false,
    ...overrides,
  };

  return {
    props,
    ...render(
      <ContextMenuProvider>
        <TrafficGrid {...props} />
      </ContextMenuProvider>
    ),
  };
}

describe("TrafficGrid", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders empty state when no sessions match", () => {
    renderTrafficGrid({ sessions: [], selectedId: null, selectedIds: [] });
    expect(
      screen.getByText(/Нет подходящих сессий для текущих фильтров/i)
    ).toBeTruthy();
  });

  it("renders session rows, comments, mocked indicator, and handles click/Ctrl+Click/Shift+Click selection", () => {
    const { props } = renderTrafficGrid();

    expect(screen.getByText("/first")).toBeTruthy();
    expect(screen.getByText("/fail")).toBeTruthy();
    expect(screen.getByText("investigate 500")).toBeTruthy();
    expect(screen.getByText("POST")).toBeTruthy();
    expect(screen.getByText("500")).toBeTruthy();

    const rows = screen.getAllByRole("row");
    // rows[0] is the sticky header row; rows[1..3] are data rows
    const secondDataRow = rows[2];
    const thirdDataRow = rows[3];

    fireEvent.click(secondDataRow);
    expect(props.onSelectSession).toHaveBeenCalledWith(2);

    fireEvent.click(secondDataRow, { ctrlKey: true });
    expect(props.onToggleSelectSession).toHaveBeenCalledWith(2);

    fireEvent.click(thirdDataRow, { shiftKey: true });
    expect(props.onSelectSessionRange).toHaveBeenCalledWith(
      3,
      expect.any(Array)
    );
  });

  it("shows multi-select comparison banner with A/B swap, Diff, Mark, and Delete actions", () => {
    const { props } = renderTrafficGrid({
      selectedId: 2,
      selectedIds: [1, 2],
    });

    expect(screen.getByText("Выбрано: 2")).toBeTruthy();
    expect(screen.getByText("A #1")).toBeTruthy();
    expect(screen.getByText("B #2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /A↔B/i }));
    expect(props.onSwapCompare).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Full Diff/i }));
    expect(props.onOpenDiffModal).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Mark \(M\)/i }));
    expect(props.onAnnotateSessions).toHaveBeenCalledWith([1, 2]);
  });

  it("sorts rows on column header clicks and cycles asc -> desc -> default", () => {
    const onSortedSessionsChange = vi.fn();
    renderTrafficGrid({ onSortedSessionsChange });

    const hostHeader = screen
      .getAllByRole("columnheader")
      .find((el) => el.getAttribute("data-col-id") === "host");
    expect(hostHeader).toBeTruthy();

    fireEvent.click(hostHeader!);
    expect(hostHeader?.getAttribute("aria-sort")).toBe("ascending");
    const lastAsc = onSortedSessionsChange.mock.calls.at(-1)?.[0] as SessionSummary[];
    expect(lastAsc.map((s) => s.host)).toEqual([
      "alpha.test",
      "beta.test",
      "zeta.test",
    ]);

    fireEvent.click(hostHeader!);
    expect(hostHeader?.getAttribute("aria-sort")).toBe("descending");
    const lastDesc = onSortedSessionsChange.mock.calls.at(-1)?.[0] as SessionSummary[];
    expect(lastDesc.map((s) => s.host)).toEqual([
      "zeta.test",
      "beta.test",
      "alpha.test",
    ]);

    fireEvent.click(hostHeader!);
    expect(hostHeader?.getAttribute("aria-sort")).toBeNull();
  });

  it("handles keyboard navigation and action shortcuts on the grid", () => {
    const { props } = renderTrafficGrid({ selectedId: 1, selectedIds: [1] });
    const grid = screen.getByRole("grid");

    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(props.onSelectSession).toHaveBeenCalledWith(2);

    fireEvent.keyDown(grid, { key: " " });
    expect(props.onFocusInspector).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(grid, { key: "r" });
    expect(props.onReplaySessions).toHaveBeenCalledWith([1]);

    fireEvent.keyDown(grid, { key: "m" });
    expect(props.onAnnotateSessions).toHaveBeenCalledWith([1]);

    fireEvent.keyDown(grid, { key: "u" });
    expect(props.onUnmarkSessions).toHaveBeenCalledWith([1]);

    fireEvent.keyDown(grid, { key: "Delete" });
    expect(props.onDeleteSessions).toHaveBeenCalledWith([1]);

    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    expect(props.onSelectAllSessions).toHaveBeenCalledWith([1, 2, 3]);
  });
});
