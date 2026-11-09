import React, { useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  Binary,
  Check,
  ChevronDown,
  Columns,
  Columns3,
  Copy,
  Database,
  GitCompareArrows,
  Globe,
  ListFilter,
  MoreHorizontal,
  OctagonPause,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Pause,
  Play,
  Plus,
  RefreshCwOff,
  Regex,
  RotateCcw,
  Search,
  Shield,
  Smartphone,
  Target,
  Terminal,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import {
  TOOLBAR_GROUP_DEFINITIONS,
  TRAFFIC_COLUMNS,
} from "../hooks/useUiPreferences";
import { SESSION_RETENTION_PRESETS } from "../types/proxy";
import type {
  BreakpointConfig,
  ColumnId,
  InspectorDockPosition,
  ProxyStatus,
  QuickFilterCategory,
  TlsInterceptMode,
  ToolbarGroupId,
} from "../types/proxy";

function formatRetentionOptionLabel(limit: number | null): string {
  if (limit === null) return "All Sessions";
  return limit.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

interface TopToolbarProps {
  status: ProxyStatus;
  searchInputRef: React.RefObject<HTMLInputElement>;
  onFocusTrafficGrid: () => void;
  filterQuery: string;
  onFilterQueryChange: (q: string) => void;
  useRegex: boolean;
  onToggleRegex: () => void;
  regexError: string | null;
  quickCategory: QuickFilterCategory;
  onSelectCategory: (cat: QuickFilterCategory) => void;
  activeFilterCount: number;
  activePresetName?: string | null;
  onOpenFilterDrawer: () => void;
  onResetAdvancedFilters: () => void;
  isForceNoCacheActive: boolean;
  onToggleForceNoCache: () => void;
  breakpointConfig: BreakpointConfig;
  pausedBreakpointCount: number;
  onToggleBreakBeforeRequest: () => void;
  onToggleBreakAfterResponse: () => void;
  onOpenBreakpointsModal: () => void;
  onOpenTextWizard: () => void;
  onOpenHexConverter: () => void;
  onInspectInHex: () => void;
  hasSelection: boolean;
  markedCount: number;
  onOpenSessionDiff: () => void;
  followTail: boolean;
  onToggleFollowTail: () => void;
  // Layout & View Customization
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  inspectorCollapsed: boolean;
  onToggleInspector: () => void;
  inspectorPosition: InspectorDockPosition;
  onSetInspectorPosition: (pos: InspectorDockPosition) => void;
  dockedComposer: boolean;
  onToggleDockedComposer: () => void;
  toolbarGroups: Record<ToolbarGroupId, boolean>;
  onToggleToolbarGroup: (groupId: ToolbarGroupId) => void;
  onResetToolbarGroups: () => void;
  visibleColumns: Record<ColumnId, boolean>;
  onToggleColumnVisibility: (colId: ColumnId) => void;
  onResetColumns: () => void;
  // Ring Buffer Retention & Capture-Stage Drop
  sessionRetentionLimit: number | null;
  onSetSessionRetentionLimit: (limit: number | null) => void;
  dropNonMatching: boolean;
  onToggleDropNonMatching: () => void;
  droppedSessionsCount: number;
  customRetentionTriggerSeq?: number;
  // Proxy & Storage
  onToggleProxy: () => void;
  onToggleAllowRemote: () => void;
  onToggleSystemProxy: () => void;
  onToggleAutoSystemProxy: () => void;
  tlsInterceptMode: TlsInterceptMode;
  targetHostsCount: number;
  hideConnectTunnels: boolean;
  onSelectTlsInterceptMode: (mode: TlsInterceptMode) => void;
  onToggleTlsInterceptMode: () => void;
  onQuickAddTargetHost: (pattern: string) => void;
  onToggleHideConnectTunnels: () => void;
  onOpenTlsModeDrawer: () => void;
  onClearSessions: () => void;
  onSaveSqlite: () => void;
  onLoadSqlite: () => void;
  onOpenCertificates: () => void;
  onOpenMobileSetup: () => void;
  onNotify?: (msg: string) => void;
}

const CATEGORIES: { id: QuickFilterCategory; label: string }[] = [
  { id: "all", label: "All" },
  { id: "json", label: "JSON" },
  { id: "sse", label: "SSE" },
  { id: "images", label: "Img" },
  { id: "errors", label: "4xx/5xx" },
  { id: "ws", label: "WS" },
  { id: "mocked", label: "Mock" },
  { id: "marked", label: "Marked" },
];

function positionToolbarPopoverFallback(
  trigger: HTMLElement | null,
  panel: HTMLElement | null,
  alignEnd = false
) {
  if (!trigger || !panel || CSS.supports("position-area", "block-end")) return;
  const rect = trigger.getBoundingClientRect();
  const panelWidth = panel.offsetWidth || 288;
  const panelHeight = panel.offsetHeight || 320;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = alignEnd ? rect.right - panelWidth : rect.left;
  left = Math.max(8, Math.min(left, vw - panelWidth - 8));
  let top = rect.bottom + 5;
  if (top + panelHeight > vh - 8 && rect.top > panelHeight + 8) {
    top = rect.top - panelHeight - 5;
  }

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

function toggleInvokerFallback(
  e: React.MouseEvent<HTMLButtonElement>,
  trigger: HTMLElement | null,
  panel: HTMLElement | null,
  alignEnd = false
) {
  if (!trigger || !panel) return;
  positionToolbarPopoverFallback(trigger, panel, alignEnd);

  if (
    typeof HTMLButtonElement !== "undefined" &&
    !("commandForElement" in HTMLButtonElement.prototype)
  ) {
    e.preventDefault();
    if ("popover" in HTMLElement.prototype) {
      if (panel.matches(":popover-open")) {
        panel.hidePopover();
      } else {
        try {
          (
            panel as HTMLElement & {
              showPopover: (opts?: { source?: HTMLElement }) => void;
            }
          ).showPopover({ source: trigger });
        } catch {
          panel.showPopover();
        }
        window.requestAnimationFrame(() =>
          positionToolbarPopoverFallback(trigger, panel, alignEnd)
        );
      }
    } else {
      panel.classList.toggle(":popover-open");
    }
  }
}

export const TopToolbar: React.FC<TopToolbarProps> = ({
  status,
  searchInputRef,
  onFocusTrafficGrid,
  filterQuery,
  onFilterQueryChange,
  useRegex,
  onToggleRegex,
  regexError,
  quickCategory,
  onSelectCategory,
  activeFilterCount,
  activePresetName,
  onOpenFilterDrawer,
  onResetAdvancedFilters,
  isForceNoCacheActive,
  onToggleForceNoCache,
  breakpointConfig,
  pausedBreakpointCount,
  onToggleBreakBeforeRequest,
  onToggleBreakAfterResponse,
  onOpenBreakpointsModal,
  onOpenTextWizard,
  onOpenHexConverter,
  onInspectInHex,
  hasSelection,
  markedCount,
  onOpenSessionDiff,
  followTail,
  onToggleFollowTail,
  sidebarCollapsed,
  onToggleSidebar,
  inspectorCollapsed,
  onToggleInspector,
  inspectorPosition,
  onSetInspectorPosition,
  dockedComposer,
  onToggleDockedComposer,
  toolbarGroups,
  onToggleToolbarGroup,
  onResetToolbarGroups,
  visibleColumns,
  onToggleColumnVisibility,
  onResetColumns,
  sessionRetentionLimit,
  onSetSessionRetentionLimit,
  dropNonMatching,
  onToggleDropNonMatching,
  droppedSessionsCount,
  customRetentionTriggerSeq = 0,
  onToggleProxy,
  onToggleAllowRemote,
  onToggleSystemProxy,
  onToggleAutoSystemProxy,
  tlsInterceptMode,
  targetHostsCount,
  hideConnectTunnels,
  onSelectTlsInterceptMode,
  onToggleTlsInterceptMode,
  onQuickAddTargetHost,
  onToggleHideConnectTunnels,
  onOpenTlsModeDrawer,
  onClearSessions,
  onSaveSqlite,
  onLoadSqlite,
  onOpenCertificates,
  onOpenMobileSetup,
  onNotify,
}) => {
  const sysProxyPopoverId = useId();
  const mitmPopoverId = useId();
  const columnsPopoverId = useId();
  const overflowTriggerId = useId();
  const overflowMenuId = useId();
  const keepTriggerId = useId();
  const keepMenuId = useId();
  const customLimitInputId = useId();
  const customLimitHintId = useId();
  const customLimitErrorId = useId();
  const dropNonMatchingCheckboxId = useId();

  const sysChevronRef = useRef<HTMLButtonElement>(null);
  const sysPopoverRef = useRef<HTMLDivElement>(null);
  const mitmChevronRef = useRef<HTMLButtonElement>(null);
  const mitmPopoverRef = useRef<HTMLDivElement>(null);
  const columnsBtnRef = useRef<HTMLButtonElement>(null);
  const columnsPopoverRef = useRef<HTMLDivElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const keepBtnRef = useRef<HTMLButtonElement>(null);
  const keepMenuRef = useRef<HTMLDivElement>(null);
  const customLimitFormRef = useRef<HTMLFormElement>(null);
  const customLimitInputRef = useRef<HTMLInputElement>(null);

  const [copiedEnv, setCopiedEnv] = useState(false);
  const [quickTargetDraft, setQuickTargetDraft] = useState("");
  const [overflowExpanded, setOverflowExpanded] = useState(false);
  const [keepExpanded, setKeepExpanded] = useState(false);
  const [customInlineOpen, setCustomInlineOpen] = useState(false);
  const [customLimitDraft, setCustomLimitDraft] = useState(() =>
    String(sessionRetentionLimit ?? 1000)
  );
  const [customLimitError, setCustomLimitError] = useState<string | null>(null);

  const isCustomRetentionValue =
    sessionRetentionLimit !== null &&
    !(SESSION_RETENTION_PRESETS as readonly number[]).includes(
      sessionRetentionLimit
    );

  const openCustomInlineInput = () => {
    setCustomLimitDraft(String(sessionRetentionLimit ?? 1000));
    setCustomLimitError(null);
    setCustomInlineOpen(true);
    window.requestAnimationFrame(() => {
      customLimitInputRef.current?.focus();
      customLimitInputRef.current?.select();
    });
  };

  useEffect(() => {
    if (customRetentionTriggerSeq > 0) {
      openCustomInlineInput();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customRetentionTriggerSeq]);

  const hasSysProxyWarning = Boolean(status.systemProxyError);
  const isRemoteAllowed = Boolean(
    status.allowRemote || status.bindAddr === "0.0.0.0"
  );
  const cliProxyUrl = `http://127.0.0.1:${status.port}`;
  const cliEnvSnippet = `HTTP_PROXY=${cliProxyUrl} HTTPS_PROXY=${cliProxyUrl}`;
  const isTargetedOnly = tlsInterceptMode === "targetedOnly";

  // Progressive enhancement fallback for overflow focusgroup="menu nomemory"
  useEffect(() => {
    const menu = overflowMenuRef.current;
    const trigger = overflowBtnRef.current;
    if (!menu || !trigger) return;

    const cleanups: (() => void)[] = [];

    const onToggle = () => {
      const open =
        ("popover" in HTMLElement.prototype && menu.matches(":popover-open")) ||
        menu.classList.contains(":popover-open");
      setOverflowExpanded(open);
      if (open) {
        positionToolbarPopoverFallback(trigger, menu, true);
      }
    };
    menu.addEventListener("toggle", onToggle);
    cleanups.push(() => menu.removeEventListener("toggle", onToggle));

    const group = menu.querySelector<HTMLElement>('[focusgroup~="menu"]');
    if (
      group &&
      typeof HTMLElement !== "undefined" &&
      !("focusGroup" in HTMLElement.prototype)
    ) {
      group.setAttribute("role", "menu");
      group
        .querySelectorAll<HTMLButtonElement>("button:not([role])")
        .forEach((btn) => btn.setAttribute("role", "menuitem"));

      const onKeyDown = (event: KeyboardEvent) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          return;
        }
        const items = Array.from(
          group.querySelectorAll<HTMLButtonElement>("button")
        ).filter((b) => !b.disabled);
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
      group.addEventListener("keydown", onKeyDown, true);
      cleanups.push(() => group.removeEventListener("keydown", onKeyDown, true));
    }

    return () => cleanups.forEach((fn) => fn());
  }, []);

  const closeOverflow = () => {
    const menu = overflowMenuRef.current;
    if (!menu) return;
    if ("popover" in HTMLElement.prototype) {
      if (menu.matches(":popover-open")) menu.hidePopover();
    } else {
      menu.classList.remove(":popover-open");
    }
    setOverflowExpanded(false);
  };

  const closeKeepMenu = () => {
    const menu = keepMenuRef.current;
    if (!menu) return;
    if ("popover" in HTMLElement.prototype) {
      if (menu.matches(":popover-open")) menu.hidePopover();
    } else {
      menu.classList.remove(":popover-open");
    }
    setKeepExpanded(false);
  };

  useEffect(() => {
    const menu = keepMenuRef.current;
    const trigger = keepBtnRef.current;
    if (!menu || !trigger) return;

    const cleanups: (() => void)[] = [];

    const onToggle = () => {
      const open =
        ("popover" in HTMLElement.prototype && menu.matches(":popover-open")) ||
        menu.classList.contains(":popover-open");
      setKeepExpanded(open);
      if (open) {
        positionToolbarPopoverFallback(trigger, menu, false);
      }
    };
    menu.addEventListener("toggle", onToggle);
    cleanups.push(() => menu.removeEventListener("toggle", onToggle));

    const group = menu.querySelector<HTMLElement>('[focusgroup~="menu"]');
    if (
      group &&
      typeof HTMLElement !== "undefined" &&
      !("focusGroup" in HTMLElement.prototype)
    ) {
      group.setAttribute("role", "menu");
      group
        .querySelectorAll<HTMLButtonElement>("button:not([role])")
        .forEach((btn) => btn.setAttribute("role", "menuitem"));

      const onKeyDown = (event: KeyboardEvent) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          return;
        }
        const items = Array.from(
          group.querySelectorAll<HTMLButtonElement>("button")
        ).filter((b) => !b.disabled);
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
      group.addEventListener("keydown", onKeyDown, true);
      cleanups.push(() => group.removeEventListener("keydown", onKeyDown, true));
    }

    return () => cleanups.forEach((fn) => fn());
  }, [customInlineOpen]);

  const validateCustomLimitValue = (raw: string): number | null => {
    const clean = raw.replace(/\s+/g, "").trim();
    if (!/^[1-9]\d*$/.test(clean)) return null;
    const num = Number(clean);
    if (!Number.isSafeInteger(num) || num <= 0 || num > 5_000_000) return null;
    return num;
  };

  const handleCustomLimitSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = validateCustomLimitValue(customLimitDraft);
    if (parsed === null) {
      setCustomLimitError("Введите целое число > 0");
      customLimitInputRef.current?.classList.add("user-invalid-fallback");
      customLimitInputRef.current?.focus();
      return;
    }
    customLimitInputRef.current?.classList.remove("user-invalid-fallback");
    setCustomLimitError(null);
    setCustomInlineOpen(false);
    onSetSessionRetentionLimit(parsed);
  };

  const handleCopyCliEnv = async () => {
    try {
      await navigator.clipboard.writeText(cliEnvSnippet);
      setCopiedEnv(true);
      onNotify?.(`Скопировано: ${cliEnvSnippet}`);
      window.setTimeout(() => setCopiedEnv(false), 1800);
    } catch {
      onNotify?.(cliEnvSnippet);
    }
  };

  const visibleColumnsCount = TRAFFIC_COLUMNS.filter(
    (c) => visibleColumns[c.id]
  ).length;

  return (
    <header className="no-scrollbar flex h-9 shrink-0 items-center justify-between gap-2 overflow-x-auto border-b border-hairline bg-surface px-2.5">
      {/* Left: Primary Capture / Clear / Stream Controls (+ Optional Proxy & Breakpoints Groups) */}
      <div className="flex shrink-0 items-center gap-1.5">
        {toolbarGroups.capture && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onToggleProxy}
              aria-pressed={status.running}
              title={
                status.running
                  ? "Приостановить захват трафика (F12)"
                  : "Возобновить захват трафика на 127.0.0.1:8888 (F12)"
              }
              className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors ${
                status.running
                  ? "border-status2xx-fg/35 bg-status2xx-bg text-status2xx-fg hover:brightness-110"
                  : "border-strong bg-elevated text-muted hover:text-fg"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  status.running ? "bg-status2xx-fg" : "bg-subtle"
                }`}
              />
              {status.running ? (
                <>
                  <Pause className="h-3 w-3" />
                  <span className="font-mono text-[11px]">
                    {status.bindAddr}:{status.port}
                  </span>
                </>
              ) : (
                <>
                  <Play className="h-3 w-3" />
                  <span>Paused</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onClearSessions}
              title="Очистить все сессии (Ctrl+X)"
              aria-label="Clear all sessions"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-elevated px-2 text-xs text-muted transition-colors hover:border-strong hover:text-status5xx-fg"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">Clear</span>
            </button>

            <button
              type="button"
              onClick={onToggleFollowTail}
              aria-pressed={followTail}
              title="Автопрокрутка потока к новым запросам (Stream / Follow Tail)"
              className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors ${
                followTail
                  ? "border-accent/45 bg-selected text-accent"
                  : "border-hairline bg-elevated text-muted hover:border-strong hover:text-fg"
              }`}
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />
              <span>Tail</span>
            </button>
          </div>
        )}

        {/* Fiddler-style Ring Buffer Keep Selector + Inline Custom Input + Drop Non-Matching */}
        <div className="flex items-center gap-1 border-l border-hairline pl-1.5">
          {customInlineOpen ? (
            <form
              ref={customLimitFormRef}
              onSubmit={handleCustomLimitSubmit}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-strong bg-canvas px-1.5"
            >
              <label
                htmlFor={customLimitInputId}
                className="text-[11px] font-medium text-muted"
              >
                Keep:
              </label>
              <span id={customLimitHintId} className="sr-only">
                Целое число сессий больше 0 (например, 777)
              </span>
              <input
                ref={customLimitInputRef}
                id={customLimitInputId}
                name="sessionRetentionLimit"
                type="text"
                inputMode="numeric"
                enterKeyHint="done"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                required
                pattern="[1-9][0-9]*"
                value={customLimitDraft}
                aria-describedby={customLimitHintId}
                aria-errormessage={
                  customLimitError ? customLimitErrorId : undefined
                }
                aria-invalid={customLimitError ? "true" : undefined}
                onChange={(e) => {
                  setCustomLimitDraft(e.target.value);
                  if (customLimitError) {
                    setCustomLimitError(null);
                  }
                  e.currentTarget.classList.remove("user-invalid-fallback");
                  e.currentTarget.setCustomValidity("");
                }}
                onBlur={(e) => {
                  if (
                    e.relatedTarget instanceof Node &&
                    customLimitFormRef.current?.contains(e.relatedTarget)
                  ) {
                    return;
                  }
                  const parsed = validateCustomLimitValue(e.currentTarget.value);
                  if (parsed === null) {
                    setCustomLimitError("> 0");
                    e.currentTarget.classList.add("user-invalid-fallback");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.nativeEvent.isComposing) {
                    e.preventDefault();
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setCustomLimitError(null);
                    setCustomInlineOpen(false);
                  }
                }}
                placeholder="> 0"
                className="retention-custom-input h-5 w-16 rounded border border-hairline bg-elevated px-1.5 font-mono text-[11px] text-fg tabular-nums focus:border-accent focus:outline-none"
              />
              {customLimitError && (
                <span
                  id={customLimitErrorId}
                  role="status"
                  aria-live="polite"
                  className="font-mono text-[10px] font-semibold text-status5xx-fg"
                >
                  ⚠ {customLimitError}
                </span>
              )}
              <button
                type="submit"
                title="Применить ручной лимит сессий (Enter)"
                aria-label="Apply custom session limit"
                className="inline-flex h-5 w-5 items-center justify-center rounded bg-accent/15 text-accent hover:bg-accent/25"
              >
                <Check className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setCustomLimitError(null);
                  setCustomInlineOpen(false);
                }}
                title="Отмена ручного ввода (Esc)"
                aria-label="Cancel custom session limit"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-subtle hover:bg-hover hover:text-fg"
              >
                <X className="h-3 w-3" />
              </button>
            </form>
          ) : (
            <>
              <button
                ref={keepBtnRef}
                id={keepTriggerId}
                type="button"
                aria-haspopup="menu"
                aria-expanded={keepExpanded}
                title="Лимит кольцевого буфера сессий в памяти (FIFO Ring Buffer)"
                onClick={(e) =>
                  toggleInvokerFallback(
                    e,
                    keepBtnRef.current,
                    keepMenuRef.current,
                    false
                  )
                }
                {...({
                  commandfor: keepMenuId,
                  command: "toggle-popover",
                } as Record<string, string>)}
                className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors ${
                  keepExpanded || isCustomRetentionValue
                    ? "border-accent/45 bg-selected text-fg"
                    : "border-hairline bg-elevated text-muted hover:border-strong hover:text-fg"
                }`}
              >
                <span className="text-[11px] text-muted">Keep:</span>
                <span className="font-mono text-[11px] font-semibold text-fg tabular-nums">
                  {formatRetentionOptionLabel(sessionRetentionLimit)}
                </span>
                <ChevronDown className="h-3 w-3 text-muted" aria-hidden="true" />
              </button>

              <div
                ref={keepMenuRef}
                id={keepMenuId}
                {...({ popover: "auto" } as Record<string, string>)}
                onPointerMove={(e) => {
                  const btn = (e.target as HTMLElement).closest("button");
                  if (btn && !btn.disabled) {
                    btn.focus({ preventScroll: true });
                  }
                }}
                className="desktop-menu z-50 hidden min-w-48 rounded-lg border border-strong bg-surface text-fg shadow-popover"
              >
                <div
                  {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
                  aria-labelledby={keepTriggerId}
                >
                  <div role="group" aria-label="Session Retention Limit">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={sessionRetentionLimit === null}
                      onClick={() => {
                        closeKeepMenu();
                        onSetSessionRetentionLimit(null);
                      }}
                    >
                      <span>All Sessions</span>
                    </button>
                    {SESSION_RETENTION_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        role="menuitemradio"
                        aria-checked={sessionRetentionLimit === preset}
                        onClick={() => {
                          closeKeepMenu();
                          onSetSessionRetentionLimit(preset);
                        }}
                      >
                        <span className="font-mono tabular-nums">
                          {formatRetentionOptionLabel(preset)}
                        </span>
                      </button>
                    ))}
                  </div>
                  <hr />
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isCustomRetentionValue}
                    onClick={() => {
                      closeKeepMenu();
                      openCustomInlineInput();
                    }}
                  >
                    <span>Custom...</span>
                    {isCustomRetentionValue && (
                      <span className="hint" aria-hidden="true">
                        {formatRetentionOptionLabel(sessionRetentionLimit)}
                      </span>
                    )}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Drop Non-Matching Checkbox / Badge-Button */}
          <label
            htmlFor={dropNonMatchingCheckboxId}
            title="Не сохранять в память запросы, отсеянные фильтром"
            className={`inline-flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-md border px-2 text-xs transition-colors ${
              dropNonMatching
                ? "border-status4xx-fg/45 bg-status4xx-bg text-status4xx-fg hover:brightness-110"
                : "border-hairline bg-elevated text-muted hover:border-strong hover:text-fg"
            }`}
          >
            <input
              id={dropNonMatchingCheckboxId}
              type="checkbox"
              checked={dropNonMatching}
              onChange={onToggleDropNonMatching}
              className="checkbox-native"
            />
            <span className="whitespace-nowrap text-[11px] font-medium">
              Drop Non-Matching
            </span>
            {droppedSessionsCount > 0 && (
              <span className="rounded-full bg-canvas/80 px-1.5 font-mono text-[10px] font-semibold tabular-nums text-fg">
                {droppedSessionsCount.toLocaleString()}
              </span>
            )}
          </label>
        </div>

        {/* Optional Group: OS System Proxy & Selective TLS MITM */}
        {toolbarGroups.proxyMode && (
          <div className="flex items-center gap-1 border-l border-hairline pl-1.5">
            <div className="inline-flex h-7 items-center">
              <button
                type="button"
                onClick={onToggleSystemProxy}
                aria-pressed={status.systemProxyEnabled}
                title="Переключить системный прокси ОС"
                className={`inline-flex h-7 items-center gap-1 rounded-l-md border border-r-0 px-2 text-xs transition-colors ${
                  hasSysProxyWarning
                    ? "border-status4xx-fg/40 bg-status4xx-bg text-status4xx-fg"
                    : status.systemProxyEnabled
                      ? "border-accent/40 bg-selected text-fg"
                      : "border-hairline bg-elevated text-muted hover:text-fg"
                }`}
              >
                {hasSysProxyWarning ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-status4xx-fg" />
                ) : status.systemProxyEnabled ? (
                  <Globe className="h-3.5 w-3.5 text-accent" />
                ) : (
                  <Terminal className="h-3.5 w-3.5 text-subtle" />
                )}
                <span>SysProxy</span>
              </button>
              <button
                ref={sysChevronRef}
                type="button"
                aria-label="Настройки системного прокси ОС"
                onClick={(e) =>
                  toggleInvokerFallback(e, sysChevronRef.current, sysPopoverRef.current)
                }
                {...({
                  commandfor: sysProxyPopoverId,
                  command: "toggle-popover",
                } as Record<string, string>)}
                className="inline-flex h-7 items-center justify-center rounded-r-md border border-hairline bg-elevated px-1 text-muted hover:text-fg"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
              <div
                ref={sysPopoverRef}
                id={sysProxyPopoverId}
                {...({ popover: "auto" } as Record<string, string>)}
                className="toolbar-popover z-50 hidden w-76 rounded-lg border border-strong bg-surface p-3 text-xs text-fg shadow-popover"
              >
                <div className="flex items-center justify-between border-b border-hairline pb-2 font-semibold">
                  <span>OS System Proxy</span>
                  <span className="font-mono text-[10px] text-muted">
                    {status.systemProxyEnabled
                      ? `127.0.0.1:${status.port}`
                      : "Port Only"}
                  </span>
                </div>
                <label className="mt-2.5 flex cursor-pointer items-start gap-2 rounded-md border border-hairline bg-canvas p-2 hover:border-strong">
                  <input
                    type="checkbox"
                    checked={status.autoSystemProxy}
                    onChange={onToggleAutoSystemProxy}
                    className="checkbox-native mt-0.5"
                  />
                  <span className="text-[11px] leading-snug text-muted">
                    <strong className="block text-fg">
                      Act as System Proxy on startup
                    </strong>
                    Автоматически привязывать при старте и откатывать при паузе.
                  </span>
                </label>
                <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md border border-hairline bg-canvas p-2 hover:border-strong">
                  <input
                    type="checkbox"
                    checked={isRemoteAllowed}
                    onChange={onToggleAllowRemote}
                    className="checkbox-native mt-0.5"
                  />
                  <span className="text-[11px] leading-snug text-muted">
                    <strong className="block text-fg">
                      Разрешить подключения с удаленных устройств (0.0.0.0)
                    </strong>
                    Принимать трафик смартфонов iOS / Android в локальной сети Wi-Fi/LAN.
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    sysPopoverRef.current?.hidePopover?.();
                    onOpenMobileSetup();
                  }}
                  className="mt-2 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-hairline bg-elevated px-2 text-[11px] font-medium text-fg hover:border-strong hover:bg-hover"
                >
                  <Smartphone className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  <span>Connect Mobile Device (QR / iOS &amp; Android)…</span>
                </button>
                <div className="mt-2 rounded-md border border-hairline bg-canvas p-2">
                  <div className="mb-1 flex items-center justify-between text-[10px] text-subtle">
                    <span>CLI Env:</span>
                    <button
                      type="button"
                      onClick={() => void handleCopyCliEnv()}
                      className="inline-flex items-center gap-1 text-accent hover:underline"
                    >
                      {copiedEnv ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      <span>{copiedEnv ? "Copied" : "Copy"}</span>
                    </button>
                  </div>
                  <code className="block truncate font-mono text-[10px] text-muted">
                    {cliEnvSnippet}
                  </code>
                </div>
              </div>
            </div>

            <div className="inline-flex h-7 items-center">
              <button
                type="button"
                onClick={onToggleTlsInterceptMode}
                aria-pressed={isTargetedOnly}
                title="Переключить режим TLS MITM: Intercept All / Targeted Only"
                className={`inline-flex h-7 items-center gap-1 rounded-l-md border border-r-0 px-2 text-xs transition-colors ${
                  isTargetedOnly
                    ? "border-status2xx-fg/40 bg-status2xx-bg text-status2xx-fg"
                    : "border-hairline bg-elevated text-muted hover:text-fg"
                }`}
              >
                {isTargetedOnly ? (
                  <Target className="h-3.5 w-3.5" />
                ) : (
                  <Shield className="h-3.5 w-3.5 text-accent" />
                )}
                <span>{isTargetedOnly ? `Target (${targetHostsCount})` : "MITM All"}</span>
              </button>
              <button
                ref={mitmChevronRef}
                type="button"
                aria-label="Настройки Selective TLS MITM"
                onClick={(e) =>
                  toggleInvokerFallback(
                    e,
                    mitmChevronRef.current,
                    mitmPopoverRef.current
                  )
                }
                {...({
                  commandfor: mitmPopoverId,
                  command: "toggle-popover",
                } as Record<string, string>)}
                className="inline-flex h-7 items-center justify-center rounded-r-md border border-hairline bg-elevated px-1 text-muted hover:text-fg"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
              <div
                ref={mitmPopoverRef}
                id={mitmPopoverId}
                {...({ popover: "auto" } as Record<string, string>)}
                className="toolbar-popover z-50 hidden w-80 rounded-lg border border-strong bg-surface p-3 text-xs text-fg shadow-popover"
              >
                <div className="border-b border-hairline pb-2 font-semibold">
                  Selective TLS MITM
                </div>
                <div className="mt-2 space-y-1.5">
                  <button
                    type="button"
                    onClick={() => onSelectTlsInterceptMode("interceptAll")}
                    className={`w-full rounded-md border p-2 text-left ${
                      !isTargetedOnly
                        ? "border-accent/50 bg-selected text-fg"
                        : "border-hairline bg-canvas text-muted hover:text-fg"
                    }`}
                  >
                    <div className="font-medium">Intercept All</div>
                    <div className="text-[11px] text-subtle">
                      Расшифровка всего HTTPS, кроме списка исключений (Bypass).
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectTlsInterceptMode("targetedOnly")}
                    className={`w-full rounded-md border p-2 text-left ${
                      isTargetedOnly
                        ? "border-status2xx-fg/50 bg-status2xx-bg text-fg"
                        : "border-hairline bg-canvas text-muted hover:text-fg"
                    }`}
                  >
                    <div className="font-medium">
                      Targeted Only ({targetHostsCount})
                    </div>
                    <div className="text-[11px] text-subtle">
                      Расшифровка только целевых хостов; остальное уходит в TCP-туннель.
                    </div>
                  </button>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const pat = quickTargetDraft.trim();
                      if (!pat) return;
                      onQuickAddTargetHost(pat);
                      setQuickTargetDraft("");
                    }}
                    className="flex items-center gap-1 pt-1"
                  >
                    <input
                      type="text"
                      value={quickTargetDraft}
                      onChange={(e) => setQuickTargetDraft(e.target.value)}
                      placeholder="*.mycompany.com"
                      aria-label="Добавить целевой хост"
                      className="h-7 flex-1 rounded border border-strong bg-canvas px-2 font-mono text-[11px] text-fg placeholder:text-subtle"
                    />
                    <button
                      type="submit"
                      disabled={!quickTargetDraft.trim()}
                      className="inline-flex h-7 items-center gap-1 rounded border border-strong bg-elevated px-2 text-[11px] font-medium text-fg hover:bg-hover disabled:opacity-40"
                    >
                      <Plus className="h-3 w-3" />
                      <span>Add</span>
                    </button>
                  </form>
                  <label className="flex cursor-pointer items-center gap-2 pt-1 text-[11px] text-muted">
                    <input
                      type="checkbox"
                      checked={hideConnectTunnels}
                      onChange={onToggleHideConnectTunnels}
                      className="checkbox-native"
                    />
                    <span>Скрывать туннели CONNECT / PASSTHROUGH</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      mitmPopoverRef.current?.hidePopover?.();
                      onOpenTlsModeDrawer();
                    }}
                    className="mt-1 flex h-7 w-full items-center justify-center rounded border border-hairline bg-elevated text-[11px] text-muted hover:text-fg"
                  >
                    Настроить списки Allowlist &amp; Bypass…
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Optional Group: Breakpoints (or alert pill when paused packets exist) */}
        {(toolbarGroups.breakpoints || pausedBreakpointCount > 0) && (
          <div className="inline-flex h-7 items-center border-l border-hairline pl-1.5">
            {toolbarGroups.breakpoints && (
              <>
                <button
                  type="button"
                  onClick={onToggleBreakBeforeRequest}
                  aria-pressed={breakpointConfig.breakBeforeRequest}
                  title="Break Before Request (F11)"
                  className={`inline-flex h-7 items-center gap-1 rounded-l-md border border-r-0 px-2 font-mono text-[11px] transition-colors ${
                    breakpointConfig.breakBeforeRequest
                      ? "border-status4xx-fg/50 bg-status4xx-bg text-status4xx-fg"
                      : "border-hairline bg-elevated text-muted hover:text-fg"
                  }`}
                >
                  <OctagonPause className="h-3 w-3" />
                  <span>Req</span>
                </button>
                <button
                  type="button"
                  onClick={onToggleBreakAfterResponse}
                  aria-pressed={breakpointConfig.breakAfterResponse}
                  title="Break After Response (Alt+F11)"
                  className={`inline-flex h-7 items-center border border-r-0 px-2 font-mono text-[11px] transition-colors ${
                    breakpointConfig.breakAfterResponse
                      ? "border-statusWs-fg/50 bg-statusWs-bg text-statusWs-fg"
                      : "border-hairline bg-elevated text-muted hover:text-fg"
                  }`}
                >
                  <span>Res</span>
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onOpenBreakpointsModal}
              title="Точки останова и правила bpu / bpafter"
              className={`inline-flex h-7 items-center gap-1 border px-2 font-mono text-[10px] font-semibold transition-colors ${
                toolbarGroups.breakpoints ? "rounded-r-md" : "rounded-md"
              } ${
                pausedBreakpointCount > 0
                  ? "border-status5xx-fg/60 bg-status5xx-bg text-status5xx-fg"
                  : breakpointConfig.rules.some((r) => r.enabled)
                    ? "border-accent/45 bg-selected text-accent"
                    : "border-hairline bg-elevated text-subtle hover:text-fg"
              }`}
            >
              <span>
                {pausedBreakpointCount > 0
                  ? `Paused: ${pausedBreakpointCount}`
                  : "bpu"}
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Center: Quick Filter Bar (+ Optional Category Pills) */}
      {toolbarGroups.quickFilter ? (
        <div className="flex min-w-[190px] max-w-2xl flex-1 items-center gap-1.5">
          <div
            className={`relative flex h-7 min-w-0 flex-1 items-center rounded-md border bg-canvas px-2 transition-colors ${
              regexError
                ? "border-status5xx-fg/70"
                : "border-hairline focus-within:border-accent/70"
            }`}
          >
            <Search className="mr-1.5 h-3.5 w-3.5 shrink-0 text-subtle" />
            <input
              ref={searchInputRef}
              type="text"
              value={filterQuery}
              onChange={(e) => onFilterQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  if (filterQuery) {
                    onFilterQueryChange("");
                  } else {
                    onFocusTrafficGrid();
                  }
                } else if (e.key === "ArrowDown" || e.key === "Enter") {
                  e.preventDefault();
                  onFocusTrafficGrid();
                }
              }}
              placeholder={
                useRegex
                  ? "RegExp filter (e.g. ^https://api\\..*|(401|503)$)"
                  : "Quick filter URL, host, method, status, comment… (Ctrl+F)"
              }
              aria-label="Quick filter captured sessions"
              className="h-full min-w-0 flex-1 bg-transparent font-mono text-xs text-fg placeholder:text-subtle focus:outline-none"
            />
            {filterQuery && (
              <button
                type="button"
                onClick={() => onFilterQueryChange("")}
                title="Очистить быстрый поиск"
                aria-label="Clear quick filter"
                className="mr-1 rounded p-0.5 text-subtle hover:text-fg"
              >
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              onClick={onToggleRegex}
              aria-pressed={useRegex}
              title="Режим регулярного выражения (RegExp)"
              className={`inline-flex h-5 shrink-0 items-center gap-0.5 rounded px-1 font-mono text-[10px] font-semibold transition-colors ${
                useRegex
                  ? "bg-selected text-accent ring-1 ring-accent/40"
                  : "text-subtle hover:bg-hover hover:text-fg"
              }`}
            >
              <Regex className="h-3 w-3" />
              <span>.*</span>
            </button>
          </div>

          {/* Advanced Filter Matrix Trigger */}
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={onOpenFilterDrawer}
              title="Открыть матрицу фильтров и пресеты (Alt+4)"
              className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors ${
                activeFilterCount > 0 || activePresetName
                  ? "border-accent/50 bg-selected text-fg"
                  : "border-hairline bg-elevated text-muted hover:border-strong hover:text-fg"
              }`}
            >
              <ListFilter className="h-3.5 w-3.5 text-accent" />
              <span className="hidden max-w-[100px] truncate md:inline">
                {activePresetName ?? "Filters"}
              </span>
              {activeFilterCount > 0 && (
                <span className="rounded-full bg-accent/20 px-1.5 font-mono text-[10px] font-semibold text-accent tabular-nums">
                  {activeFilterCount}
                </span>
              )}
            </button>
            {(activeFilterCount > 0 || activePresetName) && (
              <button
                type="button"
                onClick={onResetAdvancedFilters}
                title="Сбросить фильтры"
                aria-label="Reset advanced filters"
                className="ml-0.5 rounded p-1 text-subtle hover:bg-hover hover:text-status5xx-fg"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {/* Optional Group: Quick Category Filter Pills */}
      {toolbarGroups.categories && (
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-hairline bg-canvas p-0.5">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => onSelectCategory(cat.id)}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                quickCategory === cat.id
                  ? "bg-elevated text-fg"
                  : "text-muted hover:text-fg"
              }`}
            >
              <span>{cat.label}</span>
              {cat.id === "marked" && markedCount > 0 && (
                <span className="rounded-full bg-status4xx-bg px-1 font-mono text-[9px] font-semibold text-status4xx-fg tabular-nums">
                  {markedCount}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Right: Optional Quick Utilities + Mobile Setup + Layout Switches + Column Picker + Overflow ••• */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onOpenMobileSetup}
          title="Connect Mobile Device — iOS & Android Wi-Fi Proxy + QR Code (Ctrl+Shift+M)"
          aria-label="Connect Mobile Device"
          className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors ${
            isRemoteAllowed
              ? "border-status2xx-fg/40 bg-status2xx-bg text-status2xx-fg hover:brightness-110"
              : "border-hairline bg-elevated text-muted hover:border-strong hover:text-fg"
          }`}
        >
          <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
          {isRemoteAllowed && (
            <span className="hidden font-mono text-[10px] font-semibold xl:inline">
              LAN
            </span>
          )}
        </button>

        {toolbarGroups.utilities && (
          <div className="flex items-center gap-1 border-r border-hairline pr-1.5">
            <button
              type="button"
              onClick={onOpenSessionDiff}
              title="Session Diff (Ctrl+D)"
              aria-label="Session Diff"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-elevated px-2 text-xs text-muted hover:border-strong hover:text-fg"
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onOpenHexConverter}
              title="Hex ↔ Text Converter"
              aria-label="Hex Converter"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-elevated px-2 text-xs text-muted hover:border-strong hover:text-fg"
            >
              <Binary className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onOpenTextWizard}
              title="Text Wizard & JWT Decoder (Ctrl+E)"
              aria-label="Text Wizard"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-elevated px-2 text-xs text-muted hover:border-strong hover:text-fg"
            >
              <Wand2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onToggleForceNoCache}
              aria-pressed={isForceNoCacheActive}
              title="Disable Caching (No-Cache)"
              aria-label="Disable Caching"
              className={`inline-flex h-7 items-center rounded-md border px-2 text-xs ${
                isForceNoCacheActive
                  ? "border-status4xx-fg/45 bg-status4xx-bg text-status4xx-fg"
                  : "border-hairline bg-elevated text-muted hover:text-fg"
              }`}
            >
              <RefreshCwOff className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onSaveSqlite}
              title="Save Sessions to SQLite"
              aria-label="Save to SQLite"
              className="inline-flex h-7 items-center rounded-md border border-hairline bg-elevated px-2 text-xs text-muted hover:text-fg"
            >
              <Database className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {toolbarGroups.layout && (
          <div className="flex items-center gap-1">
            {/* Layout Segmented Control: Sidebar, Bottom Inspector, Right Inspector, Split Composer */}
            <div
              role="group"
              aria-label="Workspace layout controls"
              className="inline-flex h-7 items-center rounded-md border border-hairline bg-elevated p-0.5"
            >
              <button
                type="button"
                onClick={onToggleSidebar}
                aria-pressed={!sidebarCollapsed}
                aria-label="Toggle navigation sidebar"
                title={
                  sidebarCollapsed
                    ? "Показать боковую панель (Ctrl+B)"
                    : "Свернуть боковую панель (Ctrl+B)"
                }
                className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors ${
                  !sidebarCollapsed
                    ? "bg-selected text-accent"
                    : "text-muted hover:bg-hover hover:text-fg"
                }`}
              >
                <PanelLeft className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                onClick={() => {
                  if (!inspectorCollapsed && inspectorPosition === "bottom") {
                    onToggleInspector();
                  } else {
                    onSetInspectorPosition("bottom");
                  }
                }}
                aria-pressed={!inspectorCollapsed && inspectorPosition === "bottom"}
                aria-label="Dock Session Inspector at bottom or collapse"
                title={
                  !inspectorCollapsed && inspectorPosition === "bottom"
                    ? "Свернуть нижнюю панель Session Inspector"
                    : "Расположить Session Inspector снизу"
                }
                className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors ${
                  !inspectorCollapsed && inspectorPosition === "bottom"
                    ? "bg-selected text-accent"
                    : "text-muted hover:bg-hover hover:text-fg"
                }`}
              >
                <PanelBottom className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                onClick={() => {
                  if (!inspectorCollapsed && inspectorPosition === "right") {
                    onToggleInspector();
                  } else {
                    onSetInspectorPosition("right");
                  }
                }}
                aria-pressed={!inspectorCollapsed && inspectorPosition === "right"}
                aria-label="Dock Session Inspector on right or collapse"
                title={
                  !inspectorCollapsed && inspectorPosition === "right"
                    ? "Свернуть правую панель Session Inspector"
                    : "Расположить Session Inspector справа"
                }
                className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors ${
                  !inspectorCollapsed && inspectorPosition === "right"
                    ? "bg-selected text-accent"
                    : "text-muted hover:bg-hover hover:text-fg"
                }`}
              >
                <PanelRight className="h-3.5 w-3.5" />
              </button>

              <button
                type="button"
                onClick={onToggleDockedComposer}
                aria-pressed={dockedComposer}
                aria-label="Toggle split Request Composer"
                title="Открыть / скрыть Split Composer рядом с таблицей"
                className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors ${
                  dockedComposer
                    ? "bg-selected text-accent"
                    : "text-muted hover:bg-hover hover:text-fg"
                }`}
              >
                <Columns className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Column Picker & Customize Toolbar Popover Button */}
            <button
              ref={columnsBtnRef}
              type="button"
              onClick={(e) =>
                toggleInvokerFallback(
                  e,
                  columnsBtnRef.current,
                  columnsPopoverRef.current,
                  true
                )
              }
              title="Настроить видимость колонок таблицы и групп тулбара"
              {...({
                commandfor: columnsPopoverId,
                command: "toggle-popover",
              } as Record<string, string>)}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-elevated px-2 text-xs text-muted transition-colors hover:border-strong hover:text-fg"
            >
              <Columns3 className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">Columns</span>
              {visibleColumnsCount < TRAFFIC_COLUMNS.length && (
                <span className="font-mono text-[10px] text-accent tabular-nums">
                  {visibleColumnsCount}/{TRAFFIC_COLUMNS.length}
                </span>
              )}
            </button>

            <div
              ref={columnsPopoverRef}
              id={columnsPopoverId}
              {...({ popover: "auto" } as Record<string, string>)}
              className="toolbar-popover z-50 hidden w-72 rounded-lg border border-strong bg-surface p-3 text-xs text-fg shadow-popover"
            >
              <div className="flex items-center justify-between border-b border-hairline pb-2">
                <span className="font-semibold">Session Columns</span>
                <button
                  type="button"
                  onClick={onResetColumns}
                  title="Сбросить видимость и ширину колонок"
                  className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-fg"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Reset</span>
                </button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {TRAFFIC_COLUMNS.map((col) => (
                  <label
                    key={col.id}
                    className="flex cursor-pointer items-center gap-2 rounded border border-hairline bg-canvas px-2 py-1.5 text-[11px] text-fg hover:border-strong"
                  >
                    <input
                      type="checkbox"
                      checked={visibleColumns[col.id]}
                      onChange={() => onToggleColumnVisibility(col.id)}
                      className="checkbox-native"
                    />
                    <span className="truncate">{col.label}</span>
                  </label>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between border-b border-hairline pb-1.5">
                <span className="font-semibold">Customize Toolbar</span>
                <button
                  type="button"
                  onClick={onResetToolbarGroups}
                  className="text-[11px] text-muted hover:text-fg"
                >
                  Defaults
                </button>
              </div>
              <div className="mt-2 space-y-1">
                {TOOLBAR_GROUP_DEFINITIONS.map((grp) => (
                  <label
                    key={grp.id}
                    className="flex cursor-pointer items-center justify-between gap-2 rounded px-1.5 py-1 text-[11px] text-muted hover:bg-hover hover:text-fg"
                  >
                    <span className="truncate">{grp.label}</span>
                    <input
                      type="checkbox"
                      checked={toolbarGroups[grp.id]}
                      onChange={() => onToggleToolbarGroup(grp.id)}
                      className="checkbox-native"
                    />
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Secondary Utilities Overflow Menu (•••) */}
        <button
          ref={overflowBtnRef}
          id={overflowTriggerId}
          type="button"
          aria-label="More tools and utilities"
          aria-haspopup="menu"
          aria-expanded={overflowExpanded}
          title="Утилиты: Session Diff, Hex, Text Wizard, SQLite…"
          onClick={(e) =>
            toggleInvokerFallback(
              e,
              overflowBtnRef.current,
              overflowMenuRef.current,
              true
            )
          }
          {...({
            commandfor: overflowMenuId,
            command: "toggle-popover",
          } as Record<string, string>)}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
            overflowExpanded
              ? "border-strong bg-hover text-fg"
              : "border-hairline bg-elevated text-muted hover:border-strong hover:text-fg"
          }`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>

        <div
          ref={overflowMenuRef}
          id={overflowMenuId}
          {...({ popover: "auto" } as Record<string, string>)}
          onPointerMove={(e) => {
            const btn = (e.target as HTMLElement).closest("button");
            if (btn && !btn.disabled) {
              btn.focus({ preventScroll: true });
            }
          }}
          className="desktop-menu z-50 hidden min-w-60 rounded-lg border border-strong bg-surface text-fg shadow-popover"
        >
          <div
            {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
            aria-labelledby={overflowTriggerId}
          >
            <button
              type="button"
              onClick={() => {
                closeOverflow();
                onOpenSessionDiff();
              }}
            >
              <span>Session Diff…</span>
              <span className="hint" aria-hidden="true">
                Ctrl+D
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                closeOverflow();
                onOpenTextWizard();
              }}
            >
              <span>Text Wizard &amp; JWT…</span>
              <span className="hint" aria-hidden="true">
                Ctrl+E
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                closeOverflow();
                onOpenHexConverter();
              }}
            >
              <span>Hex ↔ Text Converter…</span>
            </button>
            <button
              type="button"
              disabled={!hasSelection}
              onClick={() => {
                closeOverflow();
                onInspectInHex();
              }}
            >
              <span>Inspect Session in Hex View</span>
            </button>
            <hr />
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={isForceNoCacheActive}
              onClick={() => {
                onToggleForceNoCache();
                closeOverflow();
              }}
            >
              <span>Disable Caching (No-Cache)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                closeOverflow();
                onSaveSqlite();
              }}
            >
              <span>Save Sessions to SQLite</span>
            </button>
            <button
              type="button"
              onClick={() => {
                closeOverflow();
                onLoadSqlite();
              }}
            >
              <span>Restore Sessions from SQLite</span>
            </button>
            <hr />
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={isRemoteAllowed}
              onClick={() => {
                onToggleAllowRemote();
                closeOverflow();
              }}
            >
              <span>Разрешить подключения с удаленных устройств (0.0.0.0)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                closeOverflow();
                onOpenMobileSetup();
              }}
            >
              <span>Connect Mobile Device (iOS / Android)…</span>
              <span className="hint" aria-hidden="true">
                Ctrl+Shift+M
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                closeOverflow();
                onOpenCertificates();
              }}
            >
              <span>HTTPS Root CA Certificate…</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
