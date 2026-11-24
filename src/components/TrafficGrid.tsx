import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Archive,
  ArrowLeftRight,
  Code2,
  Copy,
  Download,
  Eraser,
  FileCode2,
  FileJson,
  FileText,
  Flame,
  GitCompareArrows,
  Maximize2,
  MessageSquarePlus,
  RotateCcw,
  RotateCw,
  Send,
  ShieldCheck,
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
import {
  formatMsPrecise,
  formatTimeCellTooltip,
} from "../lib/requestStatistics";
import { hexToRgba } from "../lib/sessionDiff";
import type {
  ColumnId,
  NoiseThresholdsConfig,
  SessionSummary,
  SortDirection,
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
  onSelectSessionRange: (id: number, orderedSessions?: SessionSummary[]) => void;
  onSelectAllSessions?: (ids: number[]) => void;
  onSortedSessionsChange?: (sessions: SessionSummary[]) => void;
  onFocusInspector: () => void;
  onDeleteSessions: (ids: number[]) => void;
  onReplaySessions: (ids: number[]) => void;
  onUnmarkSessions: (ids: number[]) => void;
  onCopyUrl: (ids: number[]) => void;
  onCopyCurl: (id: number) => void;
  onGenerateClientCode?: (id: number) => void;
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
  onExportOpenApi?: (ids: number[]) => void;
  onSaveSessionBody?: (id: number, isResponse: boolean) => void;
  onFilterByProcess?: (processName: string) => void;
  onFilterByClientIp?: (clientIp: string) => void;
  onAddClientIpToAllowlist?: (clientIp: string) => void;
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
const STRING_SORT_LOCALE_OPTS: Intl.CollatorOptions = {
  numeric: false,
  sensitivity: "base",
};

function compareSessions(
  a: SessionSummary,
  b: SessionSummary,
  colId: ColumnId
): number {
  switch (colId) {
    case "id":
      return a.id - b.id;
    case "status":
      return a.status - b.status;
    case "size":
      return a.bodySize - b.bodySize;
    case "time":
      return a.durationMs - b.durationMs;
    case "ttfb":
      return (a.ttfbMs ?? -1) - (b.ttfbMs ?? -1);
    case "serverIp":
      return (a.serverIp || "").localeCompare(
        b.serverIp || "",
        undefined,
        STRING_SORT_LOCALE_OPTS
      );
    case "method":
      return (a.method || "").localeCompare(
        b.method || "",
        undefined,
        STRING_SORT_LOCALE_OPTS
      );
    case "protocol":
      return (a.protocol || "").localeCompare(
        b.protocol || "",
        undefined,
        STRING_SORT_LOCALE_OPTS
      );
    case "host":
      return (a.host || "").localeCompare(
        b.host || "",
        undefined,
        STRING_SORT_LOCALE_OPTS
      );
    case "url":
      return (a.path || a.url || "").localeCompare(
        b.path || b.url || "",
        undefined,
        STRING_SORT_LOCALE_OPTS
      );
    case "process":
      return (a.processName || a.clientIp || "").localeCompare(
        b.processName || b.clientIp || "",
        undefined,
        STRING_SORT_LOCALE_OPTS
      );
    case "comment":
      return (a.comment || "").localeCompare(
        b.comment || "",
        undefined,
        STRING_SORT_LOCALE_OPTS
      );
  }
}

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
      return s.breakpointPaused
        ? "WAIT"
        : s.status === 0 && !s.tlsBypassed && !s.error
          ? "..."
          : String(s.status);
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
      return s.status === 0 && !s.breakpointPaused && !s.tlsBypassed && !s.error
        ? "--"
        : formatBytes(s.bodySize);
    case "time":
      return s.status === 0 && !s.breakpointPaused && !s.tlsBypassed && !s.error
        ? "..."
        : formatDuration(s.durationMs);
    case "ttfb":
      return s.ttfbMs != null && Number.isFinite(s.ttfbMs)
        ? formatMsPrecise(s.ttfbMs)
        : "—";
    case "serverIp":
      return s.serverIp || "—";
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

export function computeAutoFitWidth(
  col: ColumnDefinition,
  sessions: SessionSummary[]
): number {
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

  return Math.max(
    col.minWidth,
    Math.min(col.maxAutoFitWidth, Math.ceil(maxPx))
  );
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
    } finally {
      pop.classList.remove(":popover-open");
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
    let openedViaFallback = false;
    try {
      if (pop.matches(":popover-open")) {
        pop.hidePopover();
      }
      pop.showPopover();
    } catch {
      pop.classList.add(":popover-open");
      openedViaFallback = true;
    } finally {
      if (!openedViaFallback) {
        pop.classList.remove(":popover-open");
      }
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
  onSelectAllSessions,
  onSortedSessionsChange,
  onFocusInspector,
  onDeleteSessions,
  onReplaySessions,
  onUnmarkSessions,
  onCopyUrl,
  onCopyCurl,
  onGenerateClientCode,
  onCopyHeaders,
  onCompareWithSession,
  onSwapCompare,
  onOpenDiffModal,
  onAnnotateSessions,
  onSendToComposer,
  onCreateRuleFromSession,
  onExportSelectedSessions,
  onExportOpenApi,
  onSaveSessionBody,
  onFilterByProcess,
  onFilterByClientIp,
  onAddClientIpToAllowlist,
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
  const [sortColumn, setSortColumn] = useState<ColumnId | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [ctxHeaderCol, setCtxHeaderCol] = useState<ColumnId | null>(null);
  const [sortAnnouncement, setSortAnnouncement] = useState<string>("");
  const suppressNextHeaderClickRef = useRef<boolean>(false);
  const hasMountedSortRef = useRef<boolean>(false);

  const sortedSessions = useMemo(() => {
    if (!sortColumn) return sessions;
    const factor = sortDirection === "asc" ? 1 : -1;
    const copy = sessions.slice();
    copy.sort((a, b) => {
      const cmp = compareSessions(a, b, sortColumn);
      if (cmp !== 0) return cmp * factor;
      return (a.id - b.id) * factor;
    });
    return copy;
  }, [sessions, sortColumn, sortDirection]);

  useEffect(() => {
    onSortedSessionsChange?.(sortedSessions);
  }, [sortedSessions, onSortedSessionsChange]);

  useEffect(() => {
    if (!hasMountedSortRef.current) {
      hasMountedSortRef.current = true;
      return;
    }
    if (!sortColumn) {
      setSortAnnouncement("Сортировка сброшена (порядок по умолчанию)");
      return;
    }
    const colLabel =
      TRAFFIC_COLUMNS.find((c) => c.id === sortColumn)?.label ?? sortColumn;
    setSortAnnouncement(
      `Сортировка: ${colLabel}, ${sortDirection === "asc" ? "по возрастанию" : "по убыванию"}`
    );
  }, [sortColumn, sortDirection]);

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
      const colEl = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        "[data-col-id]"
      );
      setCtxHeaderCol((colEl?.dataset.colId as ColumnId | undefined) ?? null);
      openFixedContextPopover(
        headerColPopoverRef.current,
        e.clientX,
        e.clientY,
        240,
        500
      );
    },
    [closeContextMenu]
  );

  const handleHeaderClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, colId: ColumnId) => {
      if (suppressNextHeaderClickRef.current) {
        suppressNextHeaderClickRef.current = false;
        return;
      }
      if ((e.target as HTMLElement | null)?.closest('[role="separator"]')) {
        return;
      }
      if (sortColumn !== colId) {
        setSortColumn(colId);
        setSortDirection("asc");
      } else if (sortDirection === "asc") {
        setSortDirection("desc");
      } else {
        setSortColumn(null);
        setSortDirection("asc");
      }
    },
    [sortColumn, sortDirection]
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

  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
  }, []);

  // 60 FPS Column Resize via direct CSS variable mutation on mousemove
  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, col: ColumnDefinition) => {
      e.preventDefault();
      e.stopPropagation();

      resizeCleanupRef.current?.();

      const startX = e.clientX;
      const startWidth = columnWidths[col.id] ?? col.defaultWidth;
      const liveWidths: Record<ColumnId, number> = { ...columnWidths };
      let latestWidth = startWidth;

      setResizingCol(col.id);
      suppressNextHeaderClickRef.current = true;
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

      const cleanup = () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        resizeCleanupRef.current = null;
      };

      const onMouseUp = () => {
        cleanup();
        setResizingCol(null);
        onColumnWidthChange(col.id, latestWidth);
        window.setTimeout(() => {
          suppressNextHeaderClickRef.current = false;
        }, 0);
      };

      resizeCleanupRef.current = cleanup;
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [activeColumns, columnWidths, onColumnWidthChange, resolvedGridRef]
  );

  const handleResizeDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, col: ColumnDefinition) => {
      e.preventDefault();
      e.stopPropagation();
      suppressNextHeaderClickRef.current = true;
      window.setTimeout(() => {
        suppressNextHeaderClickRef.current = false;
      }, 0);

      onColumnWidthChange(col.id, computeAutoFitWidth(col, sortedSessions));
    },
    [onColumnWidthChange, sortedSessions]
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
    count: sortedSessions.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    overscan: 20,
  });

  const lastSessionId =
    sessions.length > 0 ? sessions[sessions.length - 1].id : null;
  const sortedTailMarker =
    sortedSessions.length > 0
      ? `${sortedSessions[0].id}:${sortedSessions[sortedSessions.length - 1].id}:${sortedSessions.length}`
      : "0";

  useEffect(() => {
    if (!followTail || sortedSessions.length === 0) return;
    if (sortColumn === null || (sortColumn === "id" && sortDirection === "asc")) {
      rowVirtualizer.scrollToIndex(sortedSessions.length - 1, { align: "end" });
    } else if (sortColumn === "id" && sortDirection === "desc") {
      rowVirtualizer.scrollToIndex(0, { align: "start" });
    }
  }, [
    followTail,
    lastSessionId,
    sortedTailMarker,
    sortColumn,
    sortDirection,
    rowVirtualizer,
    sortedSessions.length,
  ]);

  const getEffectiveTargetIds = useCallback((): number[] => {
    if (selectedIds.length > 0) return selectedIds;
    if (selectedId !== null) return [selectedId];
    return [];
  }, [selectedId, selectedIds]);

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

    // Ctrl+A / Cmd+A -> Select all visible sessions
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      (e.key.toLowerCase() === "a" || e.code === "KeyA")
    ) {
      if (
        typeof document !== "undefined" &&
        document.querySelector("dialog[open]")
      ) {
        return;
      }
      e.preventDefault();
      if (sortedSessions.length > 0) {
        onSelectAllSessions?.(sortedSessions.map((s) => s.id));
      }
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
      if (sortedSessions.length > 0) {
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
      if (sortedSessions.length === 0) return;
      e.preventDefault();

      const currentIdx = sortedSessions.findIndex((s) => s.id === selectedId);
      const viewportHeight =
        (scrollParentRef.current?.clientHeight ?? 360) - HEADER_HEIGHT;
      const pageStep = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);

      let nextIdx = 0;
      switch (e.key) {
        case "ArrowDown":
          nextIdx =
            currentIdx < 0
              ? 0
              : Math.min(sortedSessions.length - 1, currentIdx + 1);
          break;
        case "ArrowUp":
          nextIdx =
            currentIdx < 0
              ? sortedSessions.length - 1
              : Math.max(0, currentIdx - 1);
          break;
        case "PageDown":
          nextIdx =
            currentIdx < 0
              ? Math.min(sortedSessions.length - 1, pageStep)
              : Math.min(sortedSessions.length - 1, currentIdx + pageStep);
          break;
        case "PageUp":
          nextIdx =
            currentIdx < 0 ? 0 : Math.max(0, currentIdx - pageStep);
          break;
        case "Home":
          nextIdx = 0;
          break;
        case "End":
          nextIdx = sortedSessions.length - 1;
          break;
      }

      if (followTail) {
        if (
          sortColumn === "id" &&
          sortDirection === "desc" &&
          (e.key === "ArrowDown" || e.key === "PageDown" || e.key === "End") &&
          nextIdx > 0
        ) {
          onDisableFollowTail?.();
        } else if (
          (sortColumn === null ||
            (sortColumn === "id" && sortDirection === "asc")) &&
          (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") &&
          nextIdx < sortedSessions.length - 1
        ) {
          onDisableFollowTail?.();
        }
      }

      const nextSession = sortedSessions[nextIdx];
      if (nextSession) {
        if (e.shiftKey) {
          onSelectSessionRange(nextSession.id, sortedSessions);
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
      <p role="status" className="sr-only">
        {sortAnnouncement}
      </p>
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
          title="Клик по заголовку для сортировки • Потяните границу колонки для ширины • Двойной клик для автоподбора • Правый клик для настройки"
          style={{
            gridTemplateColumns: "var(--traffic-grid-template)",
            minWidth: "max(100%, var(--traffic-min-width))",
            height: `${HEADER_HEIGHT}px`,
          }}
          className="sticky top-0 z-10 grid items-center border-b border-hairline bg-surface font-mono text-[11px] font-semibold uppercase tracking-wider text-subtle select-none"
        >
          {activeColumns.map((col) => {
            const isBeingResized = resizingCol === col.id;
            const isSorted = sortColumn === col.id;
            return (
              <div
                key={col.id}
                role="columnheader"
                data-col-id={col.id}
                aria-sort={
                  isSorted
                    ? sortDirection === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
                onClick={(e) => handleHeaderClick(e, col.id)}
                className={`relative flex h-full min-w-0 cursor-pointer items-center px-2 transition-colors hover:bg-hover/60 hover:text-fg ${
                  col.align === "right" ? "justify-end" : "justify-start"
                } ${isSorted ? "text-fg" : ""}`}
              >
                <span className="truncate">{col.label}</span>
                {isSorted && (
                  <span
                    aria-hidden="true"
                    className="ml-1 shrink-0 text-[9px] leading-none text-accent"
                  >
                    {sortDirection === "asc" ? "▲" : "▼"}
                  </span>
                )}
                {/* Interactive Resize Handle */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${col.label} column`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
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
        {sortedSessions.length === 0 ? (
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
              const s = sortedSessions[virtualRow.index];
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

              const isInFlightPending =
                s.status === 0 &&
                !s.breakpointPaused &&
                !s.tlsBypassed &&
                !s.error;

              // Softened HTTP status badge colors:
              // 2xx muted emerald, 3xx soft sky blue, 4xx pastel amber, 5xx pastel coral, 101 soft lavender,
              // 0 (In-Flight Pending) pulsing accent badge
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
                          : isInFlightPending
                            ? "animate-pulse bg-elevated text-accent ring-1 ring-inset ring-accent/35"
                            : "bg-status2xx-bg text-status2xx-fg";

              const isCriticalSlow =
                !isInFlightPending &&
                thresholds.timeHeatEnabled &&
                s.durationMs >= thresholds.timeHeatCriticalMs;
              const isWarningSlow =
                !isInFlightPending &&
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
                      onSelectSessionRange(s.id, sortedSessions);
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
                              title={
                                s.breakpointPaused
                                  ? "Запрос/ответ поставлен на Live Breakpoint"
                                  : isInFlightPending
                                    ? "Pending (In-Flight) — ожидание ответа от upstream сервера"
                                    : undefined
                              }
                              className={`inline-block rounded px-1.5 py-0.2 text-[10px] font-semibold ${statusBadgeClasses}`}
                            >
                              {s.breakpointPaused
                                ? "WAIT"
                                : isInFlightPending
                                  ? "..."
                                  : s.status}
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
                                title="TUNNEL — Чистый TCP-проброс без MITM-расшифровки (tokio::io::copy_bidirectional)"
                                className="shrink-0 rounded bg-teal-500/15 px-1.5 py-0.2 text-[9px] font-bold tracking-wider text-teal-300 ring-1 ring-inset ring-teal-500/35"
                              >
                                TUNNEL
                              </span>
                            )}
                            {s.isMocked && (
                              <span
                                title="Mocked response (AutoResponder / Python Script)"
                                className="shrink-0 rounded bg-status4xx-bg px-1 text-[9px] font-bold text-status4xx-fg"
                              >
                                MOCK
                              </span>
                            )}
                            {s.headersMutated && (
                              <span
                                title="Modified by Filter Rule / Python Script"
                                className="shrink-0 rounded bg-statusWs-bg px-1 text-[9px] font-bold text-statusWs-fg"
                              >
                                HDR
                              </span>
                            )}
                            {s.remappedTo && (
                              <span
                                title={`HOSTS Remapped → ${s.remappedTo}`}
                                className="shrink-0 rounded bg-accent/20 px-1 text-[9px] font-bold text-accent"
                              >
                                REMAP
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
                            {isInFlightPending ? (
                              <span
                                className="text-subtle"
                                title="Ожидание ответа..."
                              >
                                --
                              </span>
                            ) : (
                              formatBytes(s.bodySize)
                            )}
                          </span>
                        );

                      case "time":
                        return (
                          <span
                            key="time"
                            role="gridcell"
                            className="flex min-w-0 items-center justify-end px-2 text-right text-[11px]"
                          >
                            {isInFlightPending ? (
                              <span
                                className="animate-pulse text-muted"
                                title="Запрос выполняется (In-Flight)..."
                              >
                                ...
                              </span>
                            ) : isCriticalSlow ? (
                              <span
                                title={formatTimeCellTooltip(
                                  s,
                                  `Critical Latency (>= ${thresholds.timeHeatCriticalMs} ms)`
                                )}
                                className="inline-flex items-center gap-0.5 rounded bg-status5xx-bg px-1.5 py-0.2 font-semibold text-status5xx-fg"
                              >
                                <Flame
                                  className="h-2.5 w-2.5 shrink-0"
                                  aria-hidden="true"
                                />
                                <span>{formatDuration(s.durationMs)}</span>
                              </span>
                            ) : isWarningSlow ? (
                              <span
                                title={formatTimeCellTooltip(
                                  s,
                                  `Slow Request (>= ${thresholds.timeHeatWarningMs} ms)`
                                )}
                                className="inline-flex items-center gap-0.5 rounded bg-status4xx-bg px-1.5 py-0.2 font-semibold text-status4xx-fg"
                              >
                                <Flame
                                  className="h-2.5 w-2.5 shrink-0"
                                  aria-hidden="true"
                                />
                                <span>{formatDuration(s.durationMs)}</span>
                              </span>
                            ) : (
                              <span
                                title={formatTimeCellTooltip(s)}
                                className="truncate text-muted"
                              >
                                {formatDuration(s.durationMs)}
                              </span>
                            )}
                          </span>
                        );

                      case "ttfb":
                        return (
                          <span
                            key="ttfb"
                            role="gridcell"
                            title={
                              s.ttfbMs != null && Number.isFinite(s.ttfbMs)
                                ? `Time To First Byte (Server Wait): ${formatMsPrecise(s.ttfbMs)}`
                                : "TTFB не измерен"
                            }
                            className="min-w-0 truncate px-2 text-right text-[11px] tabular-nums text-muted"
                          >
                            {isInFlightPending
                              ? "..."
                              : s.ttfbMs != null && Number.isFinite(s.ttfbMs)
                                ? formatMsPrecise(s.ttfbMs)
                                : "—"}
                          </span>
                        );

                      case "serverIp":
                        return (
                          <span
                            key="serverIp"
                            role="gridcell"
                            title={
                              s.serverIp
                                ? `${s.serverIp}${
                                    s.serverConnReused === true
                                      ? " (Pooled / Reused)"
                                      : s.serverConnReused === false
                                        ? " (Cold Connect)"
                                        : ""
                                  }`
                                : "Server IP недоступен"
                            }
                            className="min-w-0 truncate px-2 text-[11px] text-muted"
                          >
                            {s.serverIp ? s.serverIp : <span className="text-subtle">—</span>}
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

      {/* Column Header Right-Click Column Picker & Sort Popover (plain disclosure, not role="menu") */}
      <div
        ref={headerColPopoverRef}
        {...({ popover: "auto" } as Record<string, string>)}
        className="session-context-menu z-50 hidden w-60 rounded-lg border border-strong bg-surface p-2 text-fg shadow-popover"
      >
        {(() => {
          const targetCol =
            TRAFFIC_COLUMNS.find(
              (c) => c.id === (ctxHeaderCol ?? sortColumn)
            ) ?? TRAFFIC_COLUMNS[0];
          const isAsc =
            sortColumn === targetCol.id && sortDirection === "asc";
          const isDesc =
            sortColumn === targetCol.id && sortDirection === "desc";
          return (
            <>
              <div className="mb-1 flex items-center justify-between px-1">
                <span className="truncate text-[11px] font-semibold text-fg">
                  Сортировка: {targetCol.label}
                </span>
                <button
                  type="button"
                  disabled={sortColumn === null}
                  onClick={() => {
                    setSortColumn(null);
                    setSortDirection("asc");
                    closeHeaderMenu();
                  }}
                  className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RotateCcw className="h-2.5 w-2.5" />
                  <span>Сбросить</span>
                </button>
              </div>
              <div className="mb-1.5 grid grid-cols-1 gap-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setSortColumn(targetCol.id);
                    setSortDirection("asc");
                    closeHeaderMenu();
                  }}
                  className={`flex items-center justify-between rounded px-1.5 py-1 text-left text-xs hover:bg-hover ${
                    isAsc ? "bg-selected font-semibold text-accent" : "text-fg"
                  }`}
                >
                  <span>▲ По возрастанию (ASC)</span>
                  {isAsc && (
                    <span className="text-[10px]" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSortColumn(targetCol.id);
                    setSortDirection("desc");
                    closeHeaderMenu();
                  }}
                  className={`flex items-center justify-between rounded px-1.5 py-1 text-left text-xs hover:bg-hover ${
                    isDesc ? "bg-selected font-semibold text-accent" : "text-fg"
                  }`}
                >
                  <span>▼ По убыванию (DESC)</span>
                  {isDesc && (
                    <span className="text-[10px]" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              </div>
              <hr className="my-1.5 border-hairline" />
            </>
          );
        })()}
        {(() => {
          const clickedCol = ctxHeaderCol
            ? (TRAFFIC_COLUMNS.find((c) => c.id === ctxHeaderCol) ?? null)
            : null;
          return (
            <div className="mb-1.5 grid grid-cols-1 gap-0.5">
              {clickedCol && (
                <button
                  type="button"
                  onClick={() => {
                    onColumnWidthChange(
                      clickedCol.id,
                      computeAutoFitWidth(clickedCol, sortedSessions)
                    );
                    closeHeaderMenu();
                  }}
                  className="flex items-center justify-between rounded px-1.5 py-1 text-left text-xs text-fg hover:bg-hover"
                >
                  <span className="truncate">
                    {`Auto-fit "${clickedCol.label}"`}
                  </span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  for (const col of activeColumns) {
                    onColumnWidthChange(
                      col.id,
                      computeAutoFitWidth(col, sortedSessions)
                    );
                  }
                  closeHeaderMenu();
                }}
                className="flex items-center justify-between rounded px-1.5 py-1 text-left text-xs text-fg hover:bg-hover"
              >
                <span className="truncate">Auto-fit All Visible Columns</span>
              </button>
            </div>
          );
        })()}
        <hr className="my-1.5 border-hairline" />
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-[11px] font-semibold text-fg">
            Видимость колонок
          </span>
          <button
            type="button"
            onClick={() => {
              onResetColumns();
              closeHeaderMenu();
            }}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-hover hover:text-fg"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            <span>Reset</span>
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

          {ctxSession && onGenerateClientCode && (
            <button
              type="button"
              onClick={() => {
                closeContextMenu();
                onGenerateClientCode(ctxSession.id);
              }}
            >
              <Code2 className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="truncate">Generate Client Code…</span>
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

          {ctxSession && (onExportSelectedSessions || onExportOpenApi || onSaveSessionBody) && (
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

              {onExportOpenApi && (
                <button
                  type="button"
                  onClick={() => {
                    closeContextMenu();
                    onExportOpenApi(ctxTargetIds);
                  }}
                >
                  <FileJson className="h-3.5 w-3.5 shrink-0 text-accent" />
                  <span className="truncate">
                    Export as OpenAPI 3.0 Spec…
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

          {ctxSession &&
            isRemoteClientIp(ctxSession.clientIp) &&
            onAddClientIpToAllowlist && (
              <button
                type="button"
                onClick={() => {
                  closeContextMenu();
                  onAddClientIpToAllowlist(ctxSession.clientIp!);
                }}
              >
                <ShieldCheck
                  className="h-3.5 w-3.5 shrink-0 text-emerald-400"
                  aria-hidden="true"
                />
                <span className="truncate">
                  Разрешить IP в LAN Allowlist ({ctxSession.clientIp})
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
