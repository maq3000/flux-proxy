import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Archive,
  ArrowLeftRight,
  Copy,
  Download,
  Eraser,
  FileCode2,
  FileText,
  Flame,
  GitCompareArrows,
  Maximize2,
  MessageSquarePlus,
  RotateCcw,
  RotateCw,
  Send,
  ShieldOff,
  Smartphone,
  Sparkles,
  Target,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  TRAFFIC_COLUMNS,
  type ColumnDefinition,
} from "../hooks/useUiPreferences";
import { extractParentWildcardDomain } from "../lib/filterEngine";
import {
  formatBytes,
  formatDuration,
  getRowSemanticTone,
} from "../lib/formatters";
import { hexToRgba } from "../lib/sessionDiff";
import type {
  ColumnId,
  NoiseThresholdsConfig,
  SessionSummary,
} from "../types/proxy";

interface TrafficGridProps {
  gridRef?: React.RefObject<HTMLDivElement>;
  sessions: SessionSummary[];
  selectedId: number | null;
  selectedIds: number[];
  visibleColumns: Record<ColumnId, boolean>;
  columnWidths: Record<ColumnId, number>;
  onColumnWidthChange: (colId: ColumnId, width: number) => void;
  onToggleColumnVisibility: (colId: ColumnId) => void;
  onResetColumns: () => void;
  onSelectSession: (id: number) => void;
  onToggleSelectSession: (id: number) => void;
  onSelectSessionRange: (id: number) => void;
  onFocusInspector: () => void;
  onDeleteSessions: (ids: number[]) => void;
  onReplaySessions: (ids: number[]) => void;
  onUnmarkSessions: (ids: number[]) => void;
  onCopyUrl: (ids: number[]) => void;
  onCopyCurl: (id: number) => void;
  onCopyHeaders: (id: number, kind: "request" | "response") => void;
  onCompareWithSession: (id: number) => void;
  onSwapCompare: () => void;
  onOpenDiffModal: () => void;
  onAnnotateSessions: (ids: number[]) => void;
  onSendToComposer: (id: number) => void;
  onCreateRuleFromSession: (session: SessionSummary) => void;
  onExportSelectedSessions?: (
    ids: number[],
    format: "har" | "saz" | "raw"
  ) => void;
  onSaveSessionBody?: (id: number, isResponse: boolean) => void;
  onFilterByProcess?: (processName: string) => void;
  onFilterByClientIp?: (clientIp: string) => void;
  onAlwaysInspectHost?: (hostOrPattern: string) => void;
  onAlwaysPassthroughHost?: (hostOrPattern: string) => void;
  onAddHostToTlsBypass?: (host: string) => void;
  onDisableFollowTail?: () => void;
  onNotify?: (msg: string) => void;
  thresholds: NoiseThresholdsConfig;
  followTail: boolean;
}

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 28;

function isRemoteClientIp(ip?: string | null): ip is string {
  if (!ip) return false;
  const clean = ip.trim().toLowerCase();
  return (
    clean.length > 0 &&
    clean !== "127.0.0.1" &&
    clean !== "::1" &&
    clean !== "localhost" &&
    clean !== "0.0.0.0"
  );
}

function buildGridTemplate(
  cols: ColumnDefinition[],
  widths: Record<ColumnId, number>
): string {
  if (cols.length === 0) return "minmax(0, 1fr)";
  return `${cols.map((c) => `${widths[c.id]}px`).join(" ")} minmax(0, 1fr)`;
}

function buildTotalMinWidth(
  cols: ColumnDefinition[],
  widths: Record<ColumnId, number>
): number {
  return cols.reduce((acc, c) => acc + (widths[c.id] ?? c.defaultWidth), 0);
}

function getCellSampleText(s: SessionSummary, colId: ColumnId): string {
  switch (colId) {
    case "id":
      return String(s.id);
    case "status":
      return s.breakpointPaused ? "WAIT" : String(s.status);
    case "method":
      return s.method;
    case "protocol":
      return s.protocol;
    case "host":
      return s.host;
    case "url":
      return s.path || s.url;
    case "process":
      return s.processName
        ? `${s.processName}${s.processPid != null ? `:${s.processPid}` : ""}`
        : isRemoteClientIp(s.clientIp)
          ? s.clientIp
          : "—";
    case "size":
      return formatBytes(s.bodySize);
    case "time":
      return formatDuration(s.durationMs);
    case "comment":
      return s.comment ?? "";
  }
}

let sharedMeasureCtx: CanvasRenderingContext2D | null = null;
function getTextWidthPx(text: string, font: string): number {
  if (typeof document === "undefined") return text.length * 7.2;
  if (!sharedMeasureCtx) {
    const canvas = document.createElement("canvas");
    sharedMeasureCtx = canvas.getContext("2d");
  }
  if (!sharedMeasureCtx) return text.length * 7.2;
  sharedMeasureCtx.font = font;
  return sharedMeasureCtx.measureText(text).width;
}

function closePopoverSafe(pop: HTMLElement | null) {
  if (!pop) return;
  if ("popover" in HTMLElement.prototype) {
    try {
      if (pop.matches(":popover-open")) {
        pop.hidePopover();
      }
    } catch {
      // ignore
    }
  } else {
    pop.classList.remove(":popover-open");
  }
}

function openFixedContextPopover(
  pop: HTMLElement | null,
  clientX: number,
  clientY: number,
  estWidth: number,
  estHeight: number
) {
  if (!pop) return;
  const clampedLeft = Math.max(
    8,
    Math.min(clientX, window.innerWidth - estWidth - 8)
  );
  const clampedTop = Math.max(
    8,
    Math.min(clientY, window.innerHeight - estHeight - 8)
  );
  pop.style.setProperty("--ctx-menu-left", `${Math.round(clampedLeft)}px`);
  pop.style.setProperty("--ctx-menu-top", `${Math.round(clampedTop)}px`);

  if ("popover" in HTMLElement.prototype) {
    try {
      if (pop.matches(":popover-open")) {
        pop.hidePopover();
      }
      pop.showPopover();
    } catch {
      pop.classList.add(":popover-open");
    }
  } else {
    pop.classList.add(":popover-open");
  }

  // Re-clamp using actual rendered dimensions so tall menus never clip off-screen
  const actualW = pop.offsetWidth || estWidth;
  const actualH = pop.offsetHeight || estHeight;
  const finalLeft = Math.max(
    8,
    Math.min(clientX, window.innerWidth - actualW - 8)
  );
  const finalTop = Math.max(
    8,
    Math.min(clientY, window.innerHeight - actualH - 8)
  );
  pop.style.setProperty("--ctx-menu-left", `${Math.round(finalLeft)}px`);
  pop.style.setProperty("--ctx-menu-top", `${Math.round(finalTop)}px`);
}

export const TrafficGrid: React.FC<TrafficGridProps> = ({
  gridRef,
  sessions,
  selectedId,
  selectedIds,
  visibleColumns,
  columnWidths,
  onColumnWidthChange,
  onToggleColumnVisibility,
  onResetColumns,
  onSelectSession,
  onToggleSelectSession,
  onSelectSessionRange,
  onFocusInspector,
  onDeleteSessions,
  onReplaySessions,
  onUnmarkSessions,
  onCopyUrl,
  onCopyCurl,
  onCopyHeaders,
  onCompareWithSession,
  onSwapCompare,
  onOpenDiffModal,
  onAnnotateSessions,
  onSendToComposer,
  onCreateRuleFromSession,
  onExportSelectedSessions,
  onSaveSessionBody,
  onFilterByProcess,
  onFilterByClientIp,
  onAlwaysInspectHost,
  onAlwaysPassthroughHost,
  onAddHostToTlsBypass,
  onDisableFollowTail,
  thresholds,
  followTail,
}) => {
  const internalGridRef = useRef<HTMLDivElement>(null);
  const resolvedGridRef = gridRef ?? internalGridRef;
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const ctxPopoverRef = useRef<HTMLDivElement>(null);
  const ctxFocusGroupRef = useRef<HTMLDivElement>(null);
  const headerColPopoverRef = useRef<HTMLDivElement>(null);

  const [ctxSession, setCtxSession] = useState<SessionSummary | null>(null);
  const [resizingCol, setResizingCol] = useState<ColumnId | null>(null);

  const effectivePassthroughHandler =
    onAlwaysPassthroughHost ?? onAddHostToTlsBypass;

  const activeColumns = useMemo(
    () => TRAFFIC_COLUMNS.filter((col) => visibleColumns[col.id]),
    [visibleColumns]
  );

  const gridTemplate = useMemo(
    () => buildGridTemplate(activeColumns, columnWidths),
    [activeColumns, columnWidths]
  );
  const totalMinWidth = useMemo(
    () => buildTotalMinWidth(activeColumns, columnWidths),
    [activeColumns, columnWidths]
  );

  // Keep CSS variables synced when state changes outside active drag
  useEffect(() => {
    const el = resolvedGridRef.current;
    if (!el || resizingCol !== null) return;
    el.style.setProperty("--traffic-grid-template", gridTemplate);
    el.style.setProperty("--traffic-min-width", `${totalMinWidth}px`);
  }, [gridTemplate, totalMinWidth, resizingCol, resolvedGridRef]);

  const closeContextMenu = useCallback(() => {
    closePopoverSafe(ctxPopoverRef.current);
  }, []);

  const closeHeaderMenu = useCallback(() => {
    closePopoverSafe(headerColPopoverRef.current);
  }, []);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const diffLeftId = selectedIds.length >= 2 ? selectedIds[0] : null;
  const diffRightId = selectedIds.length >= 2 ? selectedIds[1] : null;

  const handleRowContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, session: SessionSummary) => {
      e.preventDefault();
      closeHeaderMenu();
      if (!selectedSet.has(session.id)) {
        onSelectSession(session.id);
      }
      setCtxSession(session);

      openFixedContextPopover(
        ctxPopoverRef.current,
        e.clientX,
        e.clientY,
        288,
        396
      );

      window.requestAnimationFrame(() => {
        const firstBtn =
          ctxFocusGroupRef.current?.querySelector<HTMLButtonElement>(
            "button:not(:disabled)"
          );
        firstBtn?.focus({ preventScroll: true });
      });
    },
    [closeHeaderMenu, onSelectSession, selectedSet]
  );

  const handleHeaderContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      closeContextMenu();
      openFixedContextPopover(
        headerColPopoverRef.current,
        e.clientX,
        e.clientY,
        228,
        340
      );
    },
    [closeContextMenu]
  );

  // Progressive enhancement fallback for browsers where native `focusgroup` is not yet supported
  useEffect(() => {
    const group = ctxFocusGroupRef.current;
    if (
      !group ||
      typeof HTMLElement === "undefined" ||
      "focusGroup" in HTMLElement.prototype
    ) {
      return;
    }

    group.setAttribute("role", "menu");
    group.querySelectorAll("button:not([role])").forEach((item) => {
      item.setAttribute("role", "menuitem");
    });

    const onGroupKeyDown = (event: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = Array.from(group.querySelectorAll<HTMLButtonElement>("button"))
        .filter((item) => item.closest("[focusgroup]") === group)
        .filter(
          (item) =>
            !item.disabled && item.getAttribute("aria-disabled") !== "true"
        );
      if (items.length === 0) return;
      const current = items.indexOf(
        document.activeElement as HTMLButtonElement
      );
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : current < 0
              ? 0
              : (current +
                  (event.key === "ArrowUp" ? -1 : 1) +
                  items.length) %
                items.length;
      event.preventDefault();
      event.stopImmediatePropagation();
      items[next]?.focus({ preventScroll: true });
    };

    group.addEventListener("keydown", onGroupKeyDown, true);
    return () => {
      group.removeEventListener("keydown", onGroupKeyDown, true);
    };
  }, [ctxSession]);

  // 60 FPS Column Resize via direct CSS variable mutation on mousemove
  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, col: ColumnDefinition) => {
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startWidth = columnWidths[col.id] ?? col.defaultWidth;
      const liveWidths: Record<ColumnId, number> = { ...columnWidths };
      let latestWidth = startWidth;

      setResizingCol(col.id);
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        latestWidth = Math.max(col.minWidth, Math.round(startWidth + delta));
        liveWidths[col.id] = latestWidth;
        const rootEl = resolvedGridRef.current;
        if (rootEl) {
          rootEl.style.setProperty(
            "--traffic-grid-template",
            buildGridTemplate(activeColumns, liveWidths)
          );
          rootEl.style.setProperty(
            "--traffic-min-width",
            `${buildTotalMinWidth(activeColumns, liveWidths)}px`
          );
        }
      };

      const onMouseUp = () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        setResizingCol(null);
        onColumnWidthChange(col.id, latestWidth);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [activeColumns, columnWidths, onColumnWidthChange, resolvedGridRef]
  );

  const handleResizeDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, col: ColumnDefinition) => {
      e.preventDefault();
      e.stopPropagation();

      const headerFont =
        "600 11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      const cellFont =
        "400 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

      let maxPx = getTextWidthPx(col.label.toUpperCase(), headerFont) + 22;

      const sampleStep = Math.max(1, Math.floor(sessions.length / 250));
      for (let i = 0; i < sessions.length; i += sampleStep) {
        const s = sessions[i];
        const sample = getCellSampleText(s, col.id);
        if (!sample) continue;
        const extra =
          col.id === "url" &&
          (s.breakpointPaused || s.tlsBypassed || s.isMocked || s.headersMutated)
            ? 56
            : col.id === "status"
              ? 26
              : 22;
        const w = getTextWidthPx(sample, cellFont) + extra;
        if (w > maxPx) maxPx = w;
      }

      const clamped = Math.max(
        col.minWidth,
        Math.min(col.maxAutoFitWidth, Math.ceil(maxPx))
      );
      onColumnWidthChange(col.id, clamped);
    },
    [onColumnWidthChange, sessions]
  );

  const ctxHostClean = useMemo(
    () => (ctxSession ? ctxSession.host.split(":")[0].trim() : ""),
    [ctxSession]
  );
  const ctxWildcardDomain = useMemo(
    () => (ctxHostClean ? extractParentWildcardDomain(ctxHostClean) : null),
    [ctxHostClean]
  );

  const ctxTargetIds = useMemo(() => {
    if (!ctxSession) return [];
    if (selectedSet.has(ctxSession.id) && selectedIds.length > 0) {
      return selectedIds;
    }
    return [ctxSession.id];
  }, [ctxSession, selectedIds, selectedSet]);

  const rowVirtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    overscan: 20,
  });

  useEffect(() => {
    if (followTail && sessions.length > 0) {
      rowVirtualizer.scrollToIndex(sessions.length - 1, { align: "end" });
    }
  }, [followTail, sessions.length, rowVirtualizer]);

  const getEffectiveTargetIds = useCallback((): number[] => {
    if (selectedIds.length > 0) return selectedIds;
    if (selectedId !== null) return [selectedId];
    return [];
  }, [selectedId, selectedIds]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const targetEl = e.target as HTMLElement | null;
    if (
      targetEl &&
      targetEl.closest("input, textarea, select, [contenteditable='true']")
    ) {
      return;
    }

    if (e.key === "Escape") {
      if (selectedIds.length > 1 && selectedId !== null) {
        e.preventDefault();
        onSelectSession(selectedId);
      }
      return;
    }

    // Space / Enter -> open / focus Session Inspector (unless pressing a nested action button)
    if (
      (e.key === " " || e.key === "Enter") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      if (targetEl && targetEl.closest("button") && targetEl !== e.currentTarget) {
        return;
      }
      if (sessions.length > 0) {
        e.preventDefault();
        onFocusInspector();
      }
      return;
    }

    // Row & range navigation: ArrowUp/Down, PageUp/Down, Home/End, Shift+...
    if (
      e.key === "ArrowDown" ||
      e.key === "ArrowUp" ||
      e.key === "PageDown" ||
      e.key === "PageUp" ||
      e.key === "Home" ||
      e.key === "End"
    ) {
      if (sessions.length === 0) return;
      e.preventDefault();

      const currentIdx = sessions.findIndex((s) => s.id === selectedId);
      const viewportHeight =
        (scrollParentRef.current?.clientHeight ?? 360) - HEADER_HEIGHT;
      const pageStep = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);

      let nextIdx = 0;
      switch (e.key) {
        case "ArrowDown":
          nextIdx =
            currentIdx < 0
              ? 0
              : Math.min(sessions.length - 1, currentIdx + 1);
          break;
        case "ArrowUp":
          nextIdx =
            currentIdx < 0
              ? sessions.length - 1
              : Math.max(0, currentIdx - 1);
          break;
        case "PageDown":
          nextIdx =
            currentIdx < 0
              ? Math.min(sessions.length - 1, pageStep)
              : Math.min(sessions.length - 1, currentIdx + pageStep);
          break;
        case "PageUp":
          nextIdx =
            currentIdx < 0 ? 0 : Math.max(0, currentIdx - pageStep);
          break;
        case "Home":
          nextIdx = 0;
          break;
        case "End":
          nextIdx = sessions.length - 1;
          break;
      }

      if (
        followTail &&
        (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") &&
        nextIdx < sessions.length - 1
      ) {
        onDisableFollowTail?.();
      }

      const nextSession = sessions[nextIdx];
      if (nextSession) {
        if (e.shiftKey) {
          onSelectSessionRange(nextSession.id);
        } else {
          onSelectSession(nextSession.id);
        }
        rowVirtualizer.scrollToIndex(nextIdx, { align: "auto" });
      }
      return;
    }

    const targetIds = getEffectiveTargetIds();
    if (targetIds.length === 0) return;

    // Delete / Backspace -> remove selected sessions
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      onDeleteSessions(targetIds);
      return;
    }

    // R / Ctrl+R -> Replay selected sessions to upstream
    if (
      (e.key.toLowerCase() === "r" || e.code === "KeyR") &&
      !e.altKey &&
      (!e.shiftKey || (!e.ctrlKey && !e.metaKey))
    ) {
      e.preventDefault();
      onReplaySessions(targetIds);
      return;
    }

    // U -> Unmark color on selected sessions
    if (
      (e.key.toLowerCase() === "u" || e.code === "KeyU") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      onUnmarkSessions(targetIds);
      return;
    }

    // M -> Add/edit comment & mark on selected sessions
    if (
      (e.key.toLowerCase() === "m" || e.code === "KeyM") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      onAnnotateSessions(targetIds);
      return;
    }

    // Ctrl+C / Cmd+C -> Copy URL of selected session(s) when no DOM text is highlighted
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      (e.key.toLowerCase() === "c" || e.code === "KeyC")
    ) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        return;
      }
      e.preventDefault();
      onCopyUrl(targetIds);
    }
  };

  const visibleColCount = activeColumns.length;

  return (
    <div
      ref={resolvedGridRef}
      tabIndex={0}
      role="grid"
      onKeyDown={handleKeyDown}
      aria-label="Captured HTTP/HTTPS/WebSocket Sessions"
      style={
        {
          "--traffic-grid-template": gridTemplate,
          "--traffic-min-width": `${totalMinWidth}px`,
        } as React.CSSProperties
      }
      className="pane-contain flex h-full w-full flex-col bg-canvas focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50"
    >
      {/* Contextual Multi-Select & Session Diff Banner */}
      {selectedIds.length >= 2 && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-hairline bg-elevated px-2.5 py-1 text-xs">
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <GitCompareArrows className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="font-semibold text-fg">
              Выбрано: {selectedIds.length}
            </span>
            <span className="rounded bg-status3xx-bg px-1.5 py-0.5 text-[10px] font-semibold text-status3xx-fg">
              A #{selectedIds[0]}
            </span>
            <span className="text-muted">↔</span>
            <span className="rounded bg-statusWs-bg px-1.5 py-0.5 text-[10px] font-semibold text-statusWs-fg">
              B #{selectedIds[1]}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onSwapCompare}
              title="Поменять местами A и B"
              className="inline-flex h-6 items-center gap-1 rounded border border-hairline bg-surface px-1.5 text-[11px] text-muted hover:text-fg"
            >
              <ArrowLeftRight className="h-3 w-3" />
              <span className="hidden xl:inline">A↔B</span>
            </button>
            <button
              type="button"
              onClick={() => onAnnotateSessions(selectedIds)}
              title="Добавить комментарий или цветовую заливку выбранным строкам (M)"
              className="inline-flex h-6 items-center gap-1 rounded border border-hairline bg-surface px-2 text-[11px] text-status4xx-fg hover:border-strong"
            >
              <MessageSquarePlus className="h-3 w-3" />
              <span>Mark (M)</span>
            </button>
            <button
              type="button"
              onClick={() => onDeleteSessions(selectedIds)}
              title="Удалить выбранные сессии (Delete)"
              className="inline-flex h-6 items-center gap-1 rounded border border-hairline bg-surface px-2 text-[11px] text-status5xx-fg hover:border-strong"
            >
              <Trash2 className="h-3 w-3" />
              <span className="hidden sm:inline">Delete</span>
            </button>
            <button
              type="button"
              onClick={onOpenDiffModal}
              title="Развернуть сравнение двух сессий на весь экран (Ctrl+D)"
              className="inline-flex h-6 items-center gap-1 rounded border border-accent/40 bg-status3xx-bg px-2 text-[11px] font-semibold text-status3xx-fg hover:brightness-110"
            >
              <Maximize2 className="h-3 w-3" />
              <span>Full Diff</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (selectedId !== null) onSelectSession(selectedId);
              }}
              title="Сбросить множественное выделение (Esc)"
              className="rounded p-1 text-muted hover:bg-surface hover:text-fg"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Scrollable Viewport containing both Sticky Resizable Header & Virtualized Rows */}
      <div ref={scrollParentRef} className="flex-1 overflow-auto">
        {/* Sticky Resizable Column Header */}
        <div
          role="row"
          onContextMenu={handleHeaderContextMenu}
          title="Потяните границу колонки для изменения ширины • Двойной клик для автоподбора • Правый клик для настройки колонок"
          style={{
            gridTemplateColumns: "var(--traffic-grid-template)",
            minWidth: "max(100%, var(--traffic-min-width))",
            height: `${HEADER_HEIGHT}px`,
          }}
          className="sticky top-0 z-10 grid items-center border-b border-hairline bg-surface font-mono text-[11px] font-semibold uppercase tracking-wider text-subtle select-none"
        >
          {activeColumns.map((col) => {
            const isBeingResized = resizingCol === col.id;
            return (
              <div
                key={col.id}
                role="columnheader"
                className={`relative flex h-full min-w-0 items-center px-2 ${
                  col.align === "right" ? "justify-end" : "justify-start"
                }`}
              >
                <span className="truncate">{col.label}</span>
                {/* Interactive Resize Handle */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${col.label} column`}
                  onMouseDown={(e) => handleResizeMouseDown(e, col)}
                  onDoubleClick={(e) => handleResizeDoubleClick(e, col)}
                  className="group/handle absolute -right-1 top-0 z-20 flex h-full w-2.5 cursor-col-resize items-center justify-center"
                >
                  <span
                    className={`h-4 w-[2px] rounded-full transition-colors ${
                      isBeingResized
                        ? "h-full bg-accent"
                        : "bg-hairline group-hover/handle:h-full group-hover/handle:bg-accent/80"
                    }`}
                  />
                </div>
              </div>
            );
          })}
          {/* Trailing flexible filler track */}
          <div className="h-full" aria-hidden="true" />
        </div>

        {/* Virtualized Rows */}
        {sessions.length === 0 ? (
          <div className="flex h-[calc(100%-28px)] min-h-[160px] flex-col items-center justify-center gap-1.5 px-4 text-center text-xs text-muted">
            <span>Нет подходящих сессий для текущих фильтров.</span>
            <span className="text-[11px] text-subtle">
              Настройте фильтры (Alt+4), проверьте системный прокси 127.0.0.1:8888 (F12) или нажмите Ctrl+K для генерации тестового трафика.
            </span>
          </div>
        ) : (
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              minWidth: "max(100%, var(--traffic-min-width))",
              position: "relative",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const s = sessions[virtualRow.index];
              const isPrimarySelected = s.id === selectedId;
              const isInMultiSelection = selectedSet.has(s.id);
              const isDiffA = s.id === diffLeftId;
              const isDiffB = s.id === diffRightId;
              const tone = getRowSemanticTone(s);

              const customRowFill = hexToRgba(
                s.markedColor,
                isPrimarySelected || isInMultiSelection ? 0.26 : 0.15
              );

              // Ergonomic Zinc/Slate semantic row styling (softened contrast, zero neon glare)
              const rowToneClasses = isDiffB
                ? "traffic-row-selected bg-selected text-fg ring-1 ring-inset ring-statusWs-fg/60"
                : isPrimarySelected || isInMultiSelection
                  ? "traffic-row-selected bg-selected text-fg ring-1 ring-inset ring-accent/55"
                  : s.breakpointPaused
                    ? "bg-status4xx-bg text-status4xx-fg hover:brightness-105"
                    : s.markedColor
                      ? "text-fg hover:brightness-105"
                      : s.tlsBypassed
                        ? "text-muted hover:bg-hover/70"
                        : tone === "error"
                          ? s.status >= 500 || s.status === 502 || s.status === 504
                            ? "bg-status5xx-bg/45 text-status5xx-fg hover:bg-status5xx-bg"
                            : "text-status4xx-fg hover:bg-hover/70"
                          : tone === "sse"
                            ? "text-status2xx-fg hover:bg-hover/70"
                            : tone === "ws"
                              ? "text-statusWs-fg hover:bg-hover/70"
                              : tone === "image"
                                ? "text-muted hover:bg-hover/70 hover:text-fg"
                                : "text-fg hover:bg-hover/70";

              // Softened HTTP status badge colors:
              // 2xx muted emerald, 3xx soft sky blue, 4xx pastel amber, 5xx pastel coral, 101 soft lavender
              const statusBadgeClasses = s.breakpointPaused
                ? "animate-pulse bg-status4xx-bg text-status4xx-fg ring-1 ring-inset ring-status4xx-fg/40"
                : s.tlsBypassed
                  ? "bg-elevated text-muted ring-1 ring-inset ring-hairline"
                  : s.status >= 500
                    ? "bg-status5xx-bg text-status5xx-fg"
                    : s.status >= 400
                      ? "bg-status4xx-bg text-status4xx-fg"
                      : s.status === 101
                        ? "bg-statusWs-bg text-statusWs-fg"
                        : s.status >= 300
                          ? "bg-status3xx-bg text-status3xx-fg"
                          : "bg-status2xx-bg text-status2xx-fg";

              const isCriticalSlow =
                thresholds.timeHeatEnabled &&
                s.durationMs >= thresholds.timeHeatCriticalMs;
              const isWarningSlow =
                thresholds.timeHeatEnabled &&
                !isCriticalSlow &&
                s.durationMs >= thresholds.timeHeatWarningMs;

              return (
                <div
                  key={s.id}
                  role="row"
                  aria-selected={isPrimarySelected || isInMultiSelection}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      "application/x-fluxproxy-session-id",
                      String(s.id)
                    );
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={(e) => {
                    resolvedGridRef.current?.focus({ preventScroll: true });
                    if (e.ctrlKey || e.metaKey) {
                      onToggleSelectSession(s.id);
                    } else if (e.shiftKey) {
                      onSelectSessionRange(s.id);
                    } else {
                      onSelectSession(s.id);
                    }
                  }}
                  onDoubleClick={() => {
                    onSelectSession(s.id);
                    onFocusInspector();
                  }}
                  onContextMenu={(e) => handleRowContextMenu(e, s)}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    minWidth: "max(100%, var(--traffic-min-width))",
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                    gridTemplateColumns: "var(--traffic-grid-template)",
                    backgroundColor: customRowFill ?? undefined,
                    boxShadow: s.markedColor
                      ? `inset 3px 0 0 0 ${s.markedColor}`
                      : undefined,
                  }}
                  className={`group grid cursor-pointer items-center border-b border-hairline/55 font-mono text-xs tabular-nums transition-colors ${rowToneClasses}`}
                >
                  {activeColumns.map((col) => {
                    switch (col.id) {
                      case "id":
                        return (
                          <span
                            key="id"
                            role="gridcell"
                            className="flex min-w-0 items-center gap-1 truncate px-2 text-[11px] text-subtle"
                          >
                            {isDiffA && (
                              <span
                                title="Базовая сессия A в режиме Session Diff"
                                className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded bg-status3xx-bg text-[9px] font-bold text-status3xx-fg"
                              >
                                A
                              </span>
                            )}
                            {isDiffB && (
                              <span
                                title="Сравниваемая сессия B в режиме Session Diff"
                                className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded bg-statusWs-bg text-[9px] font-bold text-statusWs-fg"
                              >
                                B
                              </span>
                            )}
                            <span className="truncate">{s.id}</span>
                          </span>
                        );

                      case "status":
                        return (
                          <span
                            key="status"
                            role="gridcell"
                            className="min-w-0 truncate px-2"
                          >
                            <span
                              className={`inline-block rounded px-1.5 py-0.2 text-[10px] font-semibold ${statusBadgeClasses}`}
                            >
                              {s.breakpointPaused ? "WAIT" : s.status}
                            </span>
                          </span>
                        );

                      case "method":
                        return (
                          <span
                            key="method"
                            role="gridcell"
                            className="min-w-0 truncate px-2 font-semibold"
                          >
                            {s.method}
                          </span>
                        );

                      case "protocol":
                        return (
                          <span
                            key="protocol"
                            role="gridcell"
                            className="min-w-0 truncate px-2 text-[11px] text-muted"
                          >
                            {s.protocol}
                          </span>
                        );

                      case "host":
                        return (
                          <span
                            key="host"
                            role="gridcell"
                            className="min-w-0 truncate px-2"
                            title={s.host}
                          >
                            {s.host}
                          </span>
                        );

                      case "url":
                        return (
                          <span
                            key="url"
                            role="gridcell"
                            className="flex min-w-0 items-center gap-1.5 truncate px-2"
                            title={
                              s.comment ? `${s.url}\n💬 ${s.comment}` : s.url
                            }
                          >
                            {s.breakpointPaused && (
                              <span
                                title="Ожидает решения на точке останова (Live Breakpoint)"
                                className="shrink-0 animate-pulse rounded bg-status5xx-bg px-1 text-[9px] font-bold text-status5xx-fg"
                              >
                                {s.breakpointPaused === "response"
                                  ? "BP:RES"
                                  : "BP:REQ"}
                              </span>
                            )}
                            {!s.breakpointPaused && s.breakpointModified && (
                              <span
                                title="Изменено вручную на интерактивной точке останова"
                                className="shrink-0 rounded bg-status3xx-bg px-1 text-[9px] font-bold text-status3xx-fg"
                              >
                                BP-MOD
                              </span>
                            )}
                            {s.tlsBypassed && (
                              <span
                                title="Чистый TCP-проброс без MITM-расшифровки"
                                className="shrink-0 rounded bg-elevated px-1 text-[9px] font-semibold text-muted ring-1 ring-inset ring-hairline"
                              >
                                BYPASS
                              </span>
                            )}
                            {s.isMocked && (
                              <span
                                title="Intercepted by AutoResponder Rule"
                                className="shrink-0 rounded bg-status4xx-bg px-1 text-[9px] font-bold text-status4xx-fg"
                              >
                                MOCK
                              </span>
                            )}
                            {s.headersMutated && (
                              <span
                                title="Headers mutated by Filter Rule"
                                className="shrink-0 rounded bg-statusWs-bg px-1 text-[9px] font-bold text-statusWs-fg"
                              >
                                HDR
                              </span>
                            )}
                            <span className="truncate">{s.path || s.url}</span>
                            {!visibleColumns.comment && s.comment && (
                              <span
                                title={`Комментарий: ${s.comment}`}
                                className="ml-auto shrink-0 rounded bg-status4xx-bg px-1 text-[9px] font-medium text-status4xx-fg"
                              >
                                💬
                              </span>
                            )}
                          </span>
                        );

                      case "process":
                        return (
                          <span
                            key="process"
                            role="gridcell"
                            className="min-w-0 truncate px-2 text-[11px] text-muted"
                          >
                            {s.processName ? (
                              <button
                                type="button"
                                tabIndex={-1}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onFilterByProcess?.(s.processName!);
                                }}
                                title={`Фильтровать по процессу: ${s.processName}${s.processPid != null ? ` (PID ${s.processPid})` : ""}`}
                                className="max-w-full truncate rounded px-1 py-0.2 text-left hover:bg-surface hover:text-fg"
                              >
                                <span>{s.processName}</span>
                                {s.processPid != null && (
                                  <span className="text-[10px] text-subtle">
                                    :{s.processPid}
                                  </span>
                                )}
                              </button>
                            ) : isRemoteClientIp(s.clientIp) ? (
                              <button
                                type="button"
                                tabIndex={-1}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onFilterByClientIp?.(s.clientIp!);
                                }}
                                title={`Мобильное / LAN-устройство (${s.clientIp}) — нажмите, чтобы отфильтровать трафик по IP`}
                                className="inline-flex max-w-full items-center gap-1 truncate rounded bg-status2xx-bg/70 px-1.5 py-0.2 text-left text-status2xx-fg ring-1 ring-inset ring-status2xx-fg/30 hover:bg-status2xx-bg"
                              >
                                <Smartphone
                                  className="h-3 w-3 shrink-0"
                                  aria-hidden="true"
                                />
                                <span className="truncate">{s.clientIp}</span>
                              </button>
                            ) : (
                              <span className="text-subtle">—</span>
                            )}
                          </span>
                        );

                      case "size":
                        return (
                          <span
                            key="size"
                            role="gridcell"
                            className="min-w-0 truncate px-2 text-right text-[11px] text-muted"
                          >
                            {formatBytes(s.bodySize)}
                          </span>
                        );

                      case "time":
                        return (
                          <span
                            key="time"
                            role="gridcell"
                            className="flex min-w-0 items-center justify-end px-2 text-right text-[11px]"
                          >
                            {isCriticalSlow ? (
                              <span
                                title={`Critical Latency (>= ${thresholds.timeHeatCriticalMs} ms)`}
                                className="inline-flex items-center gap-0.5 rounded bg-status5xx-bg px-1.5 py-0.2 font-semibold text-status5xx-fg"
                              >
                                <Flame className="h-2.5 w-2.5 shrink-0" />
                                <span>{formatDuration(s.durationMs)}</span>
                              </span>
                            ) : isWarningSlow ? (
                              <span
                                title={`Slow Request (>= ${thresholds.timeHeatWarningMs} ms)`}
                                className="inline-flex items-center gap-0.5 rounded bg-status4xx-bg px-1.5 py-0.2 font-semibold text-status4xx-fg"
                              >
                                <Flame className="h-2.5 w-2.5 shrink-0" />
                                <span>{formatDuration(s.durationMs)}</span>
                              </span>
                            ) : (
                              <span className="truncate text-muted">
                                {formatDuration(s.durationMs)}
                              </span>
                            )}
                          </span>
                        );

                      case "comment":
                        return (
                          <span
                            key="comment"
                            role="gridcell"
                            className="flex min-w-0 items-center gap-1 truncate px-2 font-sans text-[11px]"
                          >
                            {s.comment ? (
                              <button
                                type="button"
                                tabIndex={-1}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onAnnotateSessions([s.id]);
                                }}
                                title={`Изменить комментарий (M): ${s.comment}`}
                                className="flex max-w-full items-center gap-1 truncate rounded px-1 py-0.2 text-left text-fg hover:bg-surface"
                              >
                                <span className="truncate">{s.comment}</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                tabIndex={-1}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onAnnotateSessions([s.id]);
                                }}
                                title="Добавить комментарий к сессии (M)"
                                className="truncate rounded px-1 py-0.2 text-[10px] text-subtle opacity-0 transition-opacity hover:bg-surface hover:text-fg group-hover:opacity-100"
                              >
                                + note
                              </button>
                            )}
                          </span>
                        );
                    }
                  })}
                  <span className="h-full" aria-hidden="true" />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Column Header Right-Click Column Picker Popover (plain checkbox disclosure, not role="menu") */}
      <div
        ref={headerColPopoverRef}
        {...({ popover: "auto" } as Record<string, string>)}
        className="session-context-menu z-50 hidden w-56 rounded-lg border border-strong bg-surface p-2 text-fg shadow-popover"
      >
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-[11px] font-semibold text-fg">
            Видимость колонок
          </span>
          <button
            type="button"
            onClick={() => {
              onResetColumns();
            }}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-hover hover:text-fg"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            <span>Сброс</span>
          </button>
        </div>
        <div className="grid grid-cols-1 gap-0.5">
          {TRAFFIC_COLUMNS.map((col) => {
            const checked = visibleColumns[col.id];
            const disableUncheck = checked && visibleColCount <= 1;
            return (
              <label
                key={col.id}
                className="flex cursor-pointer items-center justify-between rounded px-1.5 py-1 text-xs text-fg hover:bg-hover"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disableUncheck}
                    onChange={() => onToggleColumnVisibility(col.id)}
                    className="checkbox-native"
                  />
                  <span>{col.label}</span>
                </span>
                <span className="font-mono text-[10px] text-subtle">
                  {columnWidths[col.id]}px
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Session Row Right-Click Context Menu (`popover="auto"` + nested `focusgroup="menu nomemory"`) */}
      <div
        ref={ctxPopoverRef}
        {...({ popover: "auto" } as Record<string, string>)}
        className="session-context-menu z-50 hidden w-72 rounded-lg border border-strong bg-surface text-fg shadow-popover"
      >
        <div
          ref={ctxFocusGroupRef}
          {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
          aria-label={
            ctxSession
              ? `Действия для сессии #${ctxSession.id} (${ctxHostClean})`
              : "Действия для сессии"
          }
          onPointerMove={(e) => {
            const btn = (e.target as HTMLElement).closest("button");
            if (btn && !btn.disabled) {
              btn.focus({ preventScroll: true });
            }
          }}
        >
          {ctxSession && (
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                onReplaySessions(ctxTargetIds);
              }}
            >
              <RotateCw className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="truncate">
                Replay запрос{ctxTargetIds.length > 1 ? ` (${ctxTargetIds.length})` : ""}
              </span>
              <span className="hint font-mono text-[10px] text-subtle" aria-hidden="true">
                R
              </span>
            </button>
          )}

          {ctxSession && (
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                onSendToComposer(ctxSession.id);
              }}
            >
              <Send className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="truncate">Открыть в Composer</span>
            </button>
          )}

          {ctxSession && (
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                if (selectedId !== null && selectedId !== ctxSession.id && ctxTargetIds.length === 1) {
                  onCompareWithSession(ctxSession.id);
                } else {
                  onOpenDiffModal();
                }
              }}
            >
              <GitCompareArrows className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="truncate">Сравнить в Session Diff</span>
              <span className="hint font-mono text-[10px] text-subtle" aria-hidden="true">
                Ctrl+D
              </span>
            </button>
          )}

          <hr />

          {ctxSession && (
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                onCopyUrl(ctxTargetIds);
              }}
            >
              <Copy className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="truncate">
                Copy URL{ctxTargetIds.length > 1 ? ` (${ctxTargetIds.length})` : ""}
              </span>
              <span className="hint font-mono text-[10px] text-subtle" aria-hidden="true">
                Ctrl+C
              </span>
            </button>
          )}

          {ctxSession && (
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                onCopyCurl(ctxSession.id);
              }}
            >
              <Terminal className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="truncate">Copy as cURL</span>
            </button>
          )}

          {ctxSession && (
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                onCopyHeaders(ctxSession.id, "request");
              }}
            >
              <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="truncate">Copy Request Headers</span>
            </button>
          )}

          {ctxSession && (
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                onCopyHeaders(ctxSession.id, "response");
              }}
            >
              <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="truncate">Copy Response Headers</span>
            </button>
          )}

          {ctxSession && (onExportSelectedSessions || onSaveSessionBody) && (
            <>
              <hr />

              {onExportSelectedSessions && (
                <button
                  type="button"
                  onClick={() => {
                    closeContextMenu();
                    onExportSelectedSessions(ctxTargetIds, "har");
                  }}
                >
                  <Archive className="h-3.5 w-3.5 shrink-0 text-accent" />
                  <span className="truncate">
                    Save Selected as HAR (.har)
                    {ctxTargetIds.length > 1 ? ` (${ctxTargetIds.length})` : ""}
                  </span>
                </button>
              )}

              {onExportSelectedSessions && (
                <button
                  type="button"
                  onClick={() => {
                    closeContextMenu();
                    onExportSelectedSessions(ctxTargetIds, "saz");
                  }}
                >
                  <Archive className="h-3.5 w-3.5 shrink-0 text-status3xx-fg" />
                  <span className="truncate">
                    Save Selected as Fiddler SAZ (.saz)
                    {ctxTargetIds.length > 1 ? ` (${ctxTargetIds.length})` : ""}
                  </span>
                </button>
              )}

              {onSaveSessionBody && (
                <button
                  type="button"
                  onClick={() => {
                    closeContextMenu();
                    onSaveSessionBody(ctxSession.id, false);
                  }}
                >
                  <Download className="h-3.5 w-3.5 shrink-0 text-muted" />
                  <span className="truncate">Save Request Body As...</span>
                </button>
              )}

              {onSaveSessionBody && (
                <button
                  type="button"
                  onClick={() => {
                    closeContextMenu();
                    onSaveSessionBody(ctxSession.id, true);
                  }}
                >
                  <Download className="h-3.5 w-3.5 shrink-0 text-status2xx-fg" />
                  <span className="truncate">Save Response Body As...</span>
                </button>
              )}

              {onExportSelectedSessions && (
                <button
                  type="button"
                  onClick={() => {
                    closeContextMenu();
                    onExportSelectedSessions([ctxSession.id], "raw");
                  }}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted" />
                  <span className="truncate">
                    Save Full Raw HTTP Message (.txt)
                  </span>
                </button>
              )}
            </>
          )}

          <hr />

          {ctxSession && (
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                onAnnotateSessions(ctxTargetIds);
              }}
            >
              <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-status4xx-fg" />
              <span className="truncate">Комментарий / Маркер</span>
              <span className="hint font-mono text-[10px] text-subtle" aria-hidden="true">
                M
              </span>
            </button>
          )}

          {ctxSession && (
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                onUnmarkSessions(ctxTargetIds);
              }}
            >
              <Eraser className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="truncate">Снять цветовую метку (Unmark)</span>
              <span className="hint font-mono text-[10px] text-subtle" aria-hidden="true">
                U
              </span>
            </button>
          )}

          {ctxSession && (
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                onCreateRuleFromSession(ctxSession);
              }}
            >
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-status4xx-fg" />
              <span className="truncate">Создать правило AutoResponder</span>
            </button>
          )}

          <hr />

          {ctxSession &&
            isRemoteClientIp(ctxSession.clientIp) &&
            onFilterByClientIp && (
              <button
                type="button"
                onClick={() => {
                  closeContextMenu();
                  onFilterByClientIp(ctxSession.clientIp!);
                }}
              >
                <Smartphone
                  className="h-3.5 w-3.5 shrink-0 text-status2xx-fg"
                  aria-hidden="true"
                />
                <span className="truncate">
                  Фильтровать по IP устройства ({ctxSession.clientIp})
                </span>
              </button>
            )}

          {ctxSession && onAlwaysInspectHost && (
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                onAlwaysInspectHost(ctxHostClean);
              }}
            >
              <Target className="h-3.5 w-3.5 shrink-0 text-status2xx-fg" />
              <span className="truncate">
                Always inspect ({ctxHostClean})
              </span>
            </button>
          )}

          {ctxSession &&
            onAlwaysInspectHost &&
            ctxWildcardDomain &&
            ctxWildcardDomain !== `*.${ctxHostClean}` && (
              <button
                type="button"
                onClick={() => {
                  closeContextMenu();
                  onAlwaysInspectHost(ctxWildcardDomain);
                }}
              >
                <Target className="h-3.5 w-3.5 shrink-0 text-status2xx-fg/80" />
                <span className="truncate">
                  Always inspect {ctxWildcardDomain}
                </span>
              </button>
            )}

          {ctxSession && effectivePassthroughHandler && (
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                effectivePassthroughHandler(ctxHostClean);
              }}
            >
              <ShieldOff className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="truncate">
                Always passthrough ({ctxHostClean})
              </span>
            </button>
          )}

          {ctxSession && (
            <>
              <hr />
              <button
                type="button"
                onClick={() => {
                  closeContextMenu();
                  onDeleteSessions(ctxTargetIds);
                }}
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0 text-status5xx-fg" />
                <span className="truncate text-status5xx-fg">
                  Удалить{ctxTargetIds.length > 1 ? ` выбранные (${ctxTargetIds.length})` : " сессию"}
                </span>
                <span className="hint font-mono text-[10px] text-subtle" aria-hidden="true">
                  Del
                </span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
