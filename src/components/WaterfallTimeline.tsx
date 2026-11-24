import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BarChart3,
  Clock,
  Maximize2,
  Table2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { formatBytes, formatDuration } from "../lib/formatters";
import {
  WATERFALL_PHASE_DEFS,
  buildSessionWaterfallPhases,
  buildWaterfallTimelineData,
  computeTimeRulerTicks,
  formatFiddlerClock,
  formatMsPrecise,
  formatRulerOffset,
  isSessionPending,
  type SessionWaterfallBreakdown,
  type WaterfallRowTiming,
} from "../lib/requestStatistics";
import type { SessionSummary } from "../types/proxy";

export interface WaterfallTimelineProps {
  sessions: SessionSummary[];
  totalSessionsCount?: number;
  selectedId: number | null;
  selectedIds?: number[];
  onSelectSession: (id: number) => void;
  onToggleSelectSession?: (id: number) => void;
  onFocusInspector?: () => void;
  onOpenTrafficStatistics?: () => void;
  onSwitchToGrid?: () => void;
  onRowContextMenu?: (
    e: React.MouseEvent<HTMLDivElement>,
    session: SessionSummary
  ) => void;
  onEmptyAreaContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  followTail?: boolean;
  onDisableFollowTail?: () => void;
}

interface TooltipAnchorState {
  row: WaterfallRowTiming;
  breakdown: SessionWaterfallBreakdown;
  x: number;
  y: number;
}

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 28;
const INFO_COL_WIDTH = 300;
const MIN_TRACK_WIDTH = 360;
const MIN_BAR_WIDTH_PX = 4;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 32;
const ZOOM_STEP_FACTOR = 1.5;

function getStatusPillClass(session: SessionSummary): string {
  if (session.breakpointPaused) {
    return "bg-status4xx-bg text-status4xx-fg";
  }
  if (isSessionPending(session)) {
    return "bg-accent/15 text-accent";
  }
  if (session.error || session.status >= 500) {
    return "bg-status5xx-bg text-status5xx-fg";
  }
  if (session.status >= 400) {
    return "bg-status4xx-bg text-status4xx-fg";
  }
  if (session.status === 101) {
    return "bg-statusWs-bg text-statusWs-fg";
  }
  if (session.status >= 300) {
    return "bg-status3xx-bg text-status3xx-fg";
  }
  if (session.status >= 200) {
    return "bg-status2xx-bg text-status2xx-fg";
  }
  return "bg-elevated text-muted";
}

function getStatusDisplayText(session: SessionSummary): string {
  if (session.breakpointPaused) return "WAIT";
  if (isSessionPending(session)) return "…";
  if (session.tlsBypassed && session.status === 0) return "TLS";
  return session.status > 0 ? String(session.status) : "ERR";
}

function clampTooltipPosition(
  anchorX: number,
  anchorY: number
): { left: number; top: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth || 1200 : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight || 800 : 800;
  const tipWidth = 340;
  const tipHeight = 250;

  let left = anchorX + 14;
  if (left + tipWidth > vw - 12) {
    left = Math.max(12, anchorX - tipWidth - 14);
  }
  let top = anchorY + 14;
  if (top + tipHeight > vh - 12) {
    top = Math.max(12, anchorY - tipHeight - 14);
  }
  return { left: Math.round(left), top: Math.round(top) };
}

export const WaterfallTimeline: React.FC<WaterfallTimelineProps> = ({
  sessions,
  totalSessionsCount,
  selectedId,
  selectedIds = [],
  onSelectSession,
  onToggleSelectSession,
  onFocusInspector,
  onOpenTrafficStatistics,
  onSwitchToGrid,
  onRowContextMenu,
  onEmptyAreaContextMenu,
  followTail = false,
  onDisableFollowTail,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();

  const [zoom, setZoom] = useState<number>(1);
  const [viewportWidth, setViewportWidth] = useState<number>(960);
  const [tooltip, setTooltip] = useState<TooltipAnchorState | null>(null);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const timelineData = useMemo(
    () => buildWaterfallTimelineData(sessions),
    [sessions]
  );

  // Measure horizontal scroll container width for accurate Fit All & ruler ticks
  useEffect(() => {
    const el = scrollParentRef.current;
    if (!el) return;

    const updateWidth = () => {
      const measured = el.clientWidth;
      if (measured > 0) {
        setViewportWidth(measured);
      }
    };
    updateWidth();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const baseTrackWidth = useMemo(
    () => Math.max(MIN_TRACK_WIDTH, viewportWidth - INFO_COL_WIDTH - 16),
    [viewportWidth]
  );

  const trackWidth = useMemo(
    () => Math.max(MIN_TRACK_WIDTH, Math.round(baseTrackWidth * zoom)),
    [baseTrackWidth, zoom]
  );

  const totalCanvasWidth = INFO_COL_WIDTH + trackWidth;

  const rulerTicks = useMemo(
    () => computeTimeRulerTicks(timelineData.totalSpanMs, trackWidth),
    [timelineData.totalSpanMs, trackWidth]
  );

  const rowVirtualizer = useVirtualizer({
    count: timelineData.rows.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    overscan: 18,
  });

  // Follow tail when streaming live traffic
  const lastSessionId =
    sessions.length > 0 ? sessions[sessions.length - 1].id : null;
  useEffect(() => {
    if (!followTail || timelineData.rows.length === 0) return;
    rowVirtualizer.scrollToIndex(timelineData.rows.length - 1, {
      align: "end",
    });
  }, [followTail, lastSessionId, timelineData.rows.length, rowVirtualizer]);

  // Dismiss tooltip on Escape (WCAG 1.4.13)
  useEffect(() => {
    if (!tooltip) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setTooltip(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tooltip]);

  const applyZoom = useCallback(
    (nextZoomRaw: number, resetScroll = false) => {
      const clamped = Math.max(
        ZOOM_MIN,
        Math.min(ZOOM_MAX, Number(nextZoomRaw.toFixed(2)))
      );
      const scroller = scrollParentRef.current;
      if (!scroller || resetScroll) {
        setZoom(clamped);
        if (scroller && resetScroll) {
          scroller.scrollLeft = 0;
        }
        return;
      }

      const prevTrackWidth = Math.max(
        MIN_TRACK_WIDTH,
        Math.round(baseTrackWidth * zoom)
      );
      const nextTrackWidth = Math.max(
        MIN_TRACK_WIDTH,
        Math.round(baseTrackWidth * clamped)
      );
      const visibleTrack = Math.max(1, scroller.clientWidth - INFO_COL_WIDTH);
      const centerRatio =
        (scroller.scrollLeft + visibleTrack / 2) / prevTrackWidth;

      setZoom(clamped);
      window.requestAnimationFrame(() => {
        if (!scrollParentRef.current) return;
        const targetScrollLeft =
          centerRatio * nextTrackWidth - visibleTrack / 2;
        scrollParentRef.current.scrollLeft = Math.max(
          0,
          Math.round(targetScrollLeft)
        );
      });
    },
    [baseTrackWidth, zoom]
  );

  const handleZoomIn = useCallback(() => {
    applyZoom(zoom * ZOOM_STEP_FACTOR);
  }, [applyZoom, zoom]);

  const handleZoomOut = useCallback(() => {
    applyZoom(zoom / ZOOM_STEP_FACTOR);
  }, [applyZoom, zoom]);

  const handleFitAll = useCallback(() => {
    applyZoom(1, true);
  }, [applyZoom]);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY < 0) {
        applyZoom(zoom * 1.25);
      } else if (e.deltaY > 0) {
        applyZoom(zoom / 1.25);
      }
    },
    [applyZoom, zoom]
  );

  const showRowTooltip = useCallback(
    (
      row: WaterfallRowTiming,
      breakdown: SessionWaterfallBreakdown,
      x: number,
      y: number
    ) => {
      setTooltip({ row, breakdown, x, y });
    },
    []
  );

  const handleLeaveToTooltipSafe = useCallback(
    (e: React.MouseEvent<HTMLElement>, sessionId: number) => {
      const related = e.relatedTarget;
      if (
        related instanceof Node &&
        tooltipRef.current &&
        tooltipRef.current.contains(related)
      ) {
        return;
      }
      setTooltip((cur) => (cur?.row.session.id === sessionId ? null : cur));
    },
    []
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const targetEl = e.target as HTMLElement | null;
    if (
      targetEl &&
      (targetEl.isContentEditable ||
        targetEl.closest(
          "input, textarea, select, [contenteditable], .monaco-editor"
        ))
    ) {
      return;
    }

    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      handleZoomIn();
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      handleZoomOut();
      return;
    }
    if (e.key === "0" && !e.altKey) {
      e.preventDefault();
      handleFitAll();
      return;
    }

    if (
      (e.key === "Enter" || e.key === " ") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      if (targetEl && targetEl.closest("button") && targetEl !== e.currentTarget) {
        return;
      }
      if (timelineData.rows.length > 0) {
        e.preventDefault();
        onFocusInspector?.();
      }
      return;
    }

    if (
      e.key === "ArrowDown" ||
      e.key === "ArrowUp" ||
      e.key === "PageDown" ||
      e.key === "PageUp" ||
      e.key === "Home" ||
      e.key === "End"
    ) {
      const total = timelineData.rows.length;
      if (total === 0) return;
      e.preventDefault();

      const currentIdx = timelineData.rows.findIndex(
        (r) => r.session.id === selectedId
      );
      const viewportH =
        (scrollParentRef.current?.clientHeight ?? 360) - HEADER_HEIGHT;
      const pageStep = Math.max(1, Math.floor(viewportH / ROW_HEIGHT) - 1);

      let nextIdx = 0;
      switch (e.key) {
        case "ArrowDown":
          nextIdx = currentIdx < 0 ? 0 : Math.min(total - 1, currentIdx + 1);
          break;
        case "ArrowUp":
          nextIdx =
            currentIdx < 0 ? total - 1 : Math.max(0, currentIdx - 1);
          break;
        case "PageDown":
          nextIdx =
            currentIdx < 0
              ? Math.min(total - 1, pageStep)
              : Math.min(total - 1, currentIdx + pageStep);
          break;
        case "PageUp":
          nextIdx = currentIdx < 0 ? 0 : Math.max(0, currentIdx - pageStep);
          break;
        case "Home":
          nextIdx = 0;
          break;
        case "End":
          nextIdx = total - 1;
          break;
      }

      if (followTail && nextIdx < total - 1) {
        onDisableFollowTail?.();
      }

      const nextRow = timelineData.rows[nextIdx];
      if (nextRow) {
        onSelectSession(nextRow.session.id);
        rowVirtualizer.scrollToIndex(nextIdx, { align: "auto" });
      }
    }
  };

  const tooltipCoords = tooltip
    ? clampTooltipPosition(tooltip.x, tooltip.y)
    : null;
  const zoomPercentLabel = `${Math.round(zoom * 100)}%`;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Waterfall Timeline"
      className="pane-contain flex h-full w-full flex-col bg-canvas text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50"
    >
      {/* Top Waterfall Controls & Phase Legend */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-hairline bg-surface px-3 py-1.5 text-[11px]">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 font-mono text-muted tabular-nums">
            <Clock className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            <span>
              <strong className="font-semibold text-fg">
                {sessions.length.toLocaleString("en-US")}
              </strong>
              {typeof totalSessionsCount === "number" &&
              totalSessionsCount !== sessions.length
                ? ` / ${totalSessionsCount.toLocaleString("en-US")}`
                : ""}{" "}
              sessions
            </span>
            <span className="text-subtle">·</span>
            <span>
              Span:{" "}
              <strong className="font-semibold text-fg">
                {sessions.length > 0
                  ? formatRulerOffset(timelineData.totalSpanMs)
                  : "0 ms"}
              </strong>
            </span>
          </div>

          {/* Multi-phase legend */}
          <div
            className="hidden flex-wrap items-center gap-2.5 md:flex"
            aria-label="Timing phases legend"
          >
            {WATERFALL_PHASE_DEFS.map((phase) => (
              <span
                key={phase.key}
                className="inline-flex items-center gap-1 text-[10px] text-muted"
              >
                <span
                  className="inline-block h-2 w-2 rounded-[2px]"
                  style={{ backgroundColor: phase.color }}
                  aria-hidden="true"
                />
                <span>{phase.shortLabel}</span>
              </span>
            ))}
          </div>
        </div>

        {/* Right: Zoom Controls + Quick Actions */}
        <div className="flex items-center gap-1.5">
          <div
            role="group"
            aria-label="Timeline zoom controls"
            className="inline-flex items-center rounded border border-hairline bg-canvas p-0.5"
          >
            <button
              type="button"
              onClick={handleZoomOut}
              disabled={zoom <= ZOOM_MIN}
              title="Zoom Out (-)"
              aria-label="Zoom Out"
              className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-muted transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={handleFitAll}
              title="Reset Zoom to Fit All (0)"
              className="min-w-[44px] rounded px-1.5 py-0.5 text-center font-mono text-[10px] font-semibold tabular-nums text-fg hover:bg-hover"
            >
              {zoomPercentLabel}
            </button>
            <button
              type="button"
              onClick={handleZoomIn}
              disabled={zoom >= ZOOM_MAX}
              title="Zoom In (+)"
              aria-label="Zoom In"
              className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-muted transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          <button
            type="button"
            onClick={handleFitAll}
            title="Fit all requests into viewport (0)"
            className="inline-flex h-7 items-center gap-1 rounded border border-hairline bg-elevated px-2 text-[11px] font-medium text-fg transition-colors hover:border-strong hover:bg-hover"
          >
            <Maximize2 className="h-3 w-3 text-muted" aria-hidden="true" />
            <span>Fit All</span>
          </button>

          {onOpenTrafficStatistics && (
            <button
              type="button"
              onClick={onOpenTrafficStatistics}
              disabled={sessions.length === 0}
              title="Open Traffic Statistics Report for current sample"
              className="inline-flex h-7 items-center gap-1 rounded border border-hairline bg-elevated px-2 text-[11px] font-medium text-fg transition-colors hover:border-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              <BarChart3 className="h-3 w-3 text-accent" aria-hidden="true" />
              <span className="hidden sm:inline">Statistics</span>
            </button>
          )}

          {onSwitchToGrid && (
            <button
              type="button"
              onClick={onSwitchToGrid}
              title="Switch back to Traffic Grid"
              className="inline-flex h-7 items-center gap-1 rounded border border-hairline bg-canvas px-2 text-[11px] font-medium text-muted transition-colors hover:border-strong hover:bg-hover hover:text-fg"
            >
              <Table2 className="h-3 w-3" aria-hidden="true" />
              <span className="hidden lg:inline">Grid</span>
            </button>
          )}
        </div>
      </div>

      {/* Virtualized Scroll Area */}
      <div
        ref={scrollParentRef}
        onWheel={handleWheel}
        onContextMenu={(e) => {
          if (e.defaultPrevented) return;
          onEmptyAreaContextMenu?.(e);
        }}
        className="relative min-h-0 flex-1 overflow-auto bg-canvas"
      >
        {timelineData.rows.length === 0 ? (
          <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted">
            <Clock className="h-7 w-7 text-subtle" aria-hidden="true" />
            <p className="font-medium text-fg">
              Нет сессий для отображения на Waterfall Timeline
            </p>
            <p className="max-w-md text-[11px] text-subtle">
              Запустите захват трафика, импортируйте HAR/SAZ или измените
              активные фильтры, чтобы увидеть многофазную каскадную диаграмму.
            </p>
          </div>
        ) : (
          <div
            style={{ width: `${totalCanvasWidth}px` }}
            className="relative min-w-full"
          >
            {/* Sticky Header + Time Ruler */}
            <div
              style={{ height: `${HEADER_HEIGHT}px` }}
              className="sticky top-0 z-20 flex border-b border-hairline bg-surface font-mono text-[10px] font-semibold uppercase tracking-wider text-subtle"
            >
              <div
                style={{ width: `${INFO_COL_WIDTH}px` }}
                className="sticky left-0 z-30 flex shrink-0 items-center justify-between border-r border-hairline bg-surface px-2.5"
              >
                <span># · Status · Request</span>
                <span>Duration</span>
              </div>
              <div
                style={{ width: `${trackWidth}px` }}
                aria-label="Timeline millisecond ruler"
                className="relative shrink-0 overflow-hidden bg-surface"
              >
                {rulerTicks.map((tick) => (
                  <div
                    key={tick.offsetMs}
                    style={{ left: `${tick.positionPercent}%` }}
                    className="pointer-events-none absolute bottom-0 top-0 flex flex-col justify-end border-l border-hairline/80 pl-1 pb-1"
                  >
                    <span className="whitespace-nowrap font-mono text-[10px] font-medium normal-case tracking-normal tabular-nums text-muted">
                      {tick.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Virtualized Rows Container */}
            <div
              role="listbox"
              aria-label="Captured sessions waterfall timeline"
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                width: `${totalCanvasWidth}px`,
                position: "relative",
              }}
            >
              {/* Background Vertical Gridlines aligned to Ruler Ticks */}
              <div
                style={{
                  left: `${INFO_COL_WIDTH}px`,
                  width: `${trackWidth}px`,
                }}
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 top-0 overflow-hidden"
              >
                {rulerTicks.map((tick) => (
                  <div
                    key={`grid-${tick.offsetMs}`}
                    style={{ left: `${tick.positionPercent}%` }}
                    className="absolute bottom-0 top-0 border-l border-hairline/40"
                  />
                ))}
              </div>

              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = timelineData.rows[virtualRow.index];
                if (!row) return null;
                const { session, offsetMs, durationMs } = row;
                const breakdown = buildSessionWaterfallPhases(session);
                const isSelected =
                  selectedId === session.id || selectedSet.has(session.id);
                const isPrimarySelected = selectedId === session.id;
                const isTooltipActive =
                  tooltip?.row.session.id === session.id;

                const rawLeftPx =
                  (offsetMs / timelineData.totalSpanMs) * trackWidth;
                const rawWidthPx =
                  (durationMs / timelineData.totalSpanMs) * trackWidth;
                const barWidthPx = Math.max(MIN_BAR_WIDTH_PX, rawWidthPx);
                const leftPx = Math.min(
                  Math.max(0, rawLeftPx),
                  Math.max(0, trackWidth - MIN_BAR_WIDTH_PX)
                );
                const clampedBarWidthPx = Math.min(
                  barWidthPx,
                  Math.max(MIN_BAR_WIDTH_PX, trackWidth - leftPx)
                );
                const showDurationOnRight =
                  leftPx + clampedBarWidthPx + 66 <= trackWidth;

                const rowBgClass = isSelected
                  ? "bg-selected"
                  : virtualRow.index % 2 === 1
                    ? "bg-surface/40 hover:bg-hover/65"
                    : "bg-canvas hover:bg-hover/65";

                const stickyBgClass = isSelected
                  ? "bg-selected"
                  : virtualRow.index % 2 === 1
                    ? "bg-surface"
                    : "bg-canvas";

                return (
                  <div
                    key={session.id}
                    role="option"
                    aria-selected={isSelected}
                    data-waterfall-row={session.id}
                    onClick={(e) => {
                      if (
                        (e.ctrlKey || e.metaKey) &&
                        onToggleSelectSession
                      ) {
                        onToggleSelectSession(session.id);
                      } else {
                        onSelectSession(session.id);
                      }
                    }}
                    onDoubleClick={() => {
                      onSelectSession(session.id);
                      onFocusInspector?.();
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onRowContextMenu?.(e, session);
                    }}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: `${totalCanvasWidth}px`,
                      height: `${ROW_HEIGHT}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    className={`group flex cursor-pointer items-center border-b border-hairline/45 transition-colors ${rowBgClass} ${
                      isPrimarySelected ? "traffic-row-selected" : ""
                    }`}
                  >
                    {/* Sticky Left Request Label Column */}
                    <div
                      style={{ width: `${INFO_COL_WIDTH}px` }}
                      className={`sticky left-0 z-10 flex h-full shrink-0 items-center gap-1.5 border-r border-hairline px-2 font-mono text-[11px] group-hover:bg-hover ${stickyBgClass} ${
                        isPrimarySelected
                          ? "border-l-2 border-l-accent pl-1.5"
                          : ""
                      }`}
                    >
                      <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-subtle">
                        #{session.id}
                      </span>
                      <span
                        className={`w-10 shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-semibold tabular-nums ${getStatusPillClass(
                          session
                        )}`}
                      >
                        {getStatusDisplayText(session)}
                      </span>
                      <span className="w-10 shrink-0 truncate text-[10px] font-semibold text-muted">
                        {session.method}
                      </span>
                      <span
                        title={`${session.host}${session.path}`}
                        className="min-w-0 flex-1 truncate text-[11px] text-fg"
                      >
                        <span className="text-muted">{session.host}</span>
                        <span>{session.path}</span>
                      </span>
                      <span className="shrink-0 pl-1 text-[10px] tabular-nums text-subtle">
                        {isSessionPending(session)
                          ? "…"
                          : formatDuration(durationMs)}
                      </span>
                    </div>

                    {/* Timeline Track & Multi-Phase Bar */}
                    <div
                      style={{ width: `${trackWidth}px` }}
                      className="relative h-full shrink-0"
                    >
                      <button
                        type="button"
                        data-waterfall-bar={session.id}
                        data-fallback={breakdown.isFallback ? "true" : "false"}
                        aria-label={`Session #${session.id} ${session.method} ${session.host}${session.path}, starts at +${formatRulerOffset(offsetMs)}, duration ${formatMsPrecise(durationMs)}`}
                        aria-describedby={
                          isTooltipActive ? tooltipId : undefined
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (
                            (e.ctrlKey || e.metaKey) &&
                            onToggleSelectSession
                          ) {
                            onToggleSelectSession(session.id);
                          } else {
                            onSelectSession(session.id);
                          }
                        }}
                        onMouseEnter={(e) => {
                          showRowTooltip(
                            row,
                            breakdown,
                            e.clientX,
                            e.clientY
                          );
                        }}
                        onMouseMove={(e) => {
                          showRowTooltip(
                            row,
                            breakdown,
                            e.clientX,
                            e.clientY
                          );
                        }}
                        onMouseLeave={(e) =>
                          handleLeaveToTooltipSafe(e, session.id)
                        }
                        onFocus={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          showRowTooltip(
                            row,
                            breakdown,
                            rect.left + rect.width / 2,
                            rect.bottom
                          );
                        }}
                        onBlur={() =>
                          setTooltip((cur) =>
                            cur?.row.session.id === session.id ? null : cur
                          )
                        }
                        style={{
                          left: `${leftPx}px`,
                          width: `${clampedBarWidthPx}px`,
                        }}
                        className={`absolute top-1/2 flex h-3.5 -translate-y-1/2 items-stretch overflow-hidden rounded-[3px] border border-black/15 transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                          isPrimarySelected
                            ? "ring-1 ring-accent shadow-sm"
                            : "hover:brightness-110"
                        } ${
                          breakdown.isFallback
                            ? ""
                            : "bg-slate-400/30 dark:bg-slate-500/35"
                        }`}
                      >
                        {breakdown.isFallback ? (
                          <span
                            data-phase="fallback"
                            style={{
                              width: "100%",
                              backgroundColor: breakdown.fallbackColor,
                            }}
                            className="block h-full"
                          />
                        ) : (
                          breakdown.segments.map((seg) => (
                            <span
                              key={seg.key}
                              data-phase={seg.key}
                              style={{
                                width: `${seg.widthPercent}%`,
                                backgroundColor: seg.color,
                              }}
                              className="block h-full shrink-0"
                            />
                          ))
                        )}
                      </button>

                      {/* Inline Duration Label next to the bar */}
                      <span
                        aria-hidden="true"
                        style={
                          showDurationOnRight
                            ? { left: `${leftPx + clampedBarWidthPx + 6}px` }
                            : {
                                left: `${Math.max(4, leftPx - 58)}px`,
                                width: "52px",
                                textAlign: "right",
                              }
                        }
                        className="pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[10px] tabular-nums text-subtle"
                      >
                        {isSessionPending(session)
                          ? "Pending"
                          : formatDuration(durationMs)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Floating WCAG 1.4.13 Accessible Multi-Phase Timing Tooltip */}
      {tooltip && tooltipCoords && (
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          onMouseLeave={() => setTooltip(null)}
          style={{
            left: `${tooltipCoords.left}px`,
            top: `${tooltipCoords.top}px`,
          }}
          className="fixed z-[95] w-[340px] max-w-[calc(100vw-24px)] rounded-lg border border-strong bg-surface p-2.5 text-[11px] text-fg shadow-popover"
        >
          <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-hairline pb-1.5">
            <div className="flex min-w-0 items-center gap-1.5 font-mono">
              <span className="shrink-0 font-semibold text-accent">
                #{tooltip.row.session.id}
              </span>
              <span
                className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${getStatusPillClass(
                  tooltip.row.session
                )}`}
              >
                {getStatusDisplayText(tooltip.row.session)}
              </span>
              <span className="truncate font-semibold text-fg">
                {tooltip.row.session.method} {tooltip.row.session.host}
              </span>
            </div>
            {tooltip.row.session.serverConnReused === true && (
              <span className="shrink-0 rounded bg-status2xx-bg px-1 py-0.5 font-mono text-[9px] font-semibold text-status2xx-fg">
                Reused
              </span>
            )}
            {tooltip.row.session.serverConnReused === false && (
              <span className="shrink-0 rounded bg-accent/15 px-1 py-0.5 font-mono text-[9px] font-semibold text-accent">
                Cold
              </span>
            )}
          </div>

          <div className="mb-2 truncate font-mono text-[10px] text-muted">
            {tooltip.row.session.path || tooltip.row.session.url}
          </div>

          <div className="mb-2 grid grid-cols-3 gap-1.5 rounded border border-hairline bg-canvas/70 px-2 py-1.5 font-mono text-[10px] tabular-nums">
            <div>
              <div className="text-[9px] uppercase text-subtle">Start</div>
              <div className="font-semibold text-fg">
                +{formatMsPrecise(tooltip.row.offsetMs)}
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase text-subtle">Duration</div>
              <div className="font-semibold text-accent">
                {formatMsPrecise(tooltip.row.durationMs)}
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase text-subtle">End</div>
              <div className="font-semibold text-fg">
                +{formatMsPrecise(tooltip.row.endOffsetMs)}
              </div>
            </div>
          </div>

          <div className="mb-2 flex items-center justify-between font-mono text-[10px] text-muted tabular-nums">
            <span>
              Clock:{" "}
              <span className="text-fg">
                {formatFiddlerClock(tooltip.row.session.timestamp)}
              </span>
            </span>
            <span>
              Size:{" "}
              <span className="text-fg">
                {formatBytes(tooltip.row.session.bodySize)}
              </span>
            </span>
          </div>

          {tooltip.breakdown.isFallback ? (
            <div className="flex items-center justify-between gap-2 rounded border border-hairline bg-elevated/50 px-2 py-1.5 text-[10px]">
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-[2px]"
                  style={{ backgroundColor: tooltip.breakdown.fallbackColor }}
                  aria-hidden="true"
                />
                <span className="text-muted">
                  Total ({tooltip.breakdown.fallbackLabel})
                </span>
              </div>
              <span className="font-mono font-semibold tabular-nums text-fg">
                {formatMsPrecise(tooltip.row.durationMs)}
              </span>
            </div>
          ) : (
            <div className="space-y-1 border-t border-hairline pt-1.5">
              {tooltip.breakdown.segments.map((seg) => (
                <div
                  key={seg.key}
                  className="flex items-center justify-between gap-2 text-[10px]"
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 rounded-[2px]"
                      style={{ backgroundColor: seg.color }}
                      aria-hidden="true"
                    />
                    <span className="text-fg">{seg.label}</span>
                  </div>
                  <span className="font-mono tabular-nums text-muted">
                    <strong className="font-semibold text-fg">
                      {formatMsPrecise(seg.durationMs)}
                    </strong>{" "}
                    ({seg.sharePercent.toFixed(0)}%)
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
