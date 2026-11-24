import React, { useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  Check,
  ChevronDown,
  Columns3,
  Copy,
  Gauge,
  Globe,
  ListFilter,
  Network,
  OctagonPause,
  PanelLeft,
  Pause,
  Play,
  Plus,
  RefreshCwOff,
  Regex,
  RotateCcw,
  Search,
  Shield,
  Target,
  Terminal,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { TRAFFIC_COLUMNS } from "../hooks/useUiPreferences";
import {
  SESSION_RETENTION_PRESETS,
  THROTTLE_PRESET_DEFINITIONS,
} from "../types/proxy";
import type {
  BreakpointConfig,
  ColumnId,
  ProxyStatus,
  QuickFilterCategory,
  ThrottleConfig,
  ThrottlePreset,
  TlsInterceptMode,
  ToolbarGroupId,
} from "../types/proxy";
import type { SettingsNetworkSubTab } from "../types/settings";
import { HelpTooltip } from "./ui/HelpTooltip";

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
  markedCount: number;
  followTail: boolean;
  onToggleFollowTail: () => void;
  // Layout & View Customization
  compactToolbar?: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  toolbarGroups: Record<ToolbarGroupId, boolean>;
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
  throttleConfig: ThrottleConfig;
  onChangeThrottleConfig: (cfg: ThrottleConfig) => void;
  activeHostRemapCount: number;
  upstreamProxyEnabled?: boolean;
  activeClientCertsCount?: number;
  onOpenNetworkRouting: (subTab?: SettingsNetworkSubTab) => void;
  onOpenAppearanceSettings: () => void;
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
  markedCount,
  followTail,
  onToggleFollowTail,
  compactToolbar = false,
  sidebarCollapsed,
  onToggleSidebar,
  toolbarGroups,
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
  throttleConfig,
  onChangeThrottleConfig,
  activeHostRemapCount,
  upstreamProxyEnabled = false,
  activeClientCertsCount = 0,
  onOpenNetworkRouting,
  onOpenAppearanceSettings,
  onNotify,
}) => {
  const sysProxyPopoverId = useId();
  const mitmPopoverId = useId();
  const throttlePopoverId = useId();
  const throttleDownInputId = useId();
  const throttleUpInputId = useId();
  const throttleLatencyInputId = useId();
  const columnsPopoverId = useId();
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
  const throttleBtnRef = useRef<HTMLButtonElement>(null);
  const throttlePopoverRef = useRef<HTMLDivElement>(null);
  const columnsBtnRef = useRef<HTMLButtonElement>(null);
  const columnsPopoverRef = useRef<HTMLDivElement>(null);
  const keepBtnRef = useRef<HTMLButtonElement>(null);
  const keepMenuRef = useRef<HTMLDivElement>(null);
  const customLimitFormRef = useRef<HTMLFormElement>(null);
  const customLimitInputRef = useRef<HTMLInputElement>(null);

  const [copiedEnv, setCopiedEnv] = useState(false);
  const [quickTargetDraft, setQuickTargetDraft] = useState("");
  const [keepExpanded, setKeepExpanded] = useState(false);
  const [throttleExpanded, setThrottleExpanded] = useState(false);
  const [customDownDraft, setCustomDownDraft] = useState(() =>
    String(throttleConfig.downloadKbps || 1000)
  );
  const [customUpDraft, setCustomUpDraft] = useState(() =>
    String(throttleConfig.uploadKbps || 500)
  );
  const [customLatencyDraft, setCustomLatencyDraft] = useState(() =>
    String(throttleConfig.latencyMs || 100)
  );
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
  const activeRoutingCount =
    activeHostRemapCount +
    (upstreamProxyEnabled ? 1 : 0) +
    activeClientCertsCount;

  const closeThrottlePopover = () => {
    const panel = throttlePopoverRef.current;
    if (!panel) return;
    if ("popover" in HTMLElement.prototype) {
      if (panel.matches(":popover-open")) panel.hidePopover();
    } else {
      panel.classList.remove(":popover-open");
    }
    setThrottleExpanded(false);
  };

  useEffect(() => {
    const panel = throttlePopoverRef.current;
    const trigger = throttleBtnRef.current;
    if (!panel || !trigger) return;
    const onToggle = () => {
      const open =
        ("popover" in HTMLElement.prototype && panel.matches(":popover-open")) ||
        panel.classList.contains(":popover-open");
      setThrottleExpanded(open);
      if (open) {
        positionToolbarPopoverFallback(trigger, panel);
      }
    };
    panel.addEventListener("toggle", onToggle);
    return () => panel.removeEventListener("toggle", onToggle);
  }, []);

  useEffect(() => {
    if (throttleConfig.preset === "custom") {
      setCustomDownDraft(String(throttleConfig.downloadKbps));
      setCustomUpDraft(String(throttleConfig.uploadKbps));
      setCustomLatencyDraft(String(throttleConfig.latencyMs));
    }
  }, [throttleConfig]);

  const activeThrottleDef =
    THROTTLE_PRESET_DEFINITIONS.find((d) => d.id === throttleConfig.preset) ??
    THROTTLE_PRESET_DEFINITIONS[0];

  const handleSelectThrottlePreset = (presetId: ThrottlePreset) => {
    const def = THROTTLE_PRESET_DEFINITIONS.find((d) => d.id === presetId);
    if (!def) return;
    onChangeThrottleConfig({
      preset: def.id,
      downloadKbps: def.downloadKbps,
      uploadKbps: def.uploadKbps,
      latencyMs: def.latencyMs,
    });
    closeThrottlePopover();
  };

  const handleApplyCustomThrottle = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const down = Math.max(0, Math.round(Number(customDownDraft) || 0));
    const up = Math.max(0, Math.round(Number(customUpDraft) || 0));
    const lat = Math.max(0, Math.round(Number(customLatencyDraft) || 0));
    onChangeThrottleConfig({
      preset: "custom",
      downloadKbps: down,
      uploadKbps: up,
      latencyMs: lat,
    });
    closeThrottlePopover();
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
    <header
      className={`no-scrollbar flex shrink-0 items-center justify-between overflow-x-auto border-b border-hairline bg-surface ${
        compactToolbar
          ? "compact-toolbar h-7 gap-1 px-1.5"
          : "h-9 gap-2 px-2.5"
      }`}
    >
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
                  : `Возобновить захват трафика на ${status.bindAddr}:${status.port} (F12)`
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
                    {compactToolbar
                      ? `:${status.port}`
                      : `${status.bindAddr}:${status.port}`}
                  </span>
                </>
              ) : (
                <>
                  <Play className="h-3 w-3" />
                  {!compactToolbar && <span>Paused</span>}
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
              {!compactToolbar && <span className="hidden xl:inline">Clear</span>}
            </button>

            <button
              type="button"
              onClick={onToggleFollowTail}
              aria-pressed={followTail}
              aria-label="Follow Tail"
              title="Автопрокрутка потока к новым запросам (Stream / Follow Tail)"
              className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors ${
                followTail
                  ? "border-accent/45 bg-selected text-accent"
                  : "border-hairline bg-elevated text-muted hover:border-strong hover:text-fg"
              }`}
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />
              {!compactToolbar && <span>Tail</span>}
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
                {!compactToolbar && (
                  <span className="text-[11px] text-muted">Keep:</span>
                )}
                <span className="font-mono text-[11px] font-semibold text-fg tabular-nums">
                  {compactToolbar && sessionRetentionLimit === null
                    ? "All"
                    : formatRetentionOptionLabel(sessionRetentionLimit)}
                </span>
                <ChevronDown className="h-3 w-3 text-muted" aria-hidden="true" />
              </button>

              <div
                ref={keepMenuRef}
                id={keepMenuId}
                {...({ popover: "auto" } as Record<string, string>)}
                onPointerMove={(e) => {
                  const btn = (e.target as HTMLElement).closest("button");
                  if (
                    btn &&
                    !btn.disabled &&
                    Boolean(btn.closest('[focusgroup~="menu"]'))
                  ) {
                    btn.focus({ preventScroll: true });
                  }
                }}
                className="desktop-menu z-50 hidden min-w-52 rounded-lg border border-strong bg-surface text-fg shadow-popover"
              >
                <div className="flex items-center justify-between border-b border-hairline px-2.5 py-1.5 text-[11px] font-semibold text-fg">
                  <span>Ring Buffer (Keep)</span>
                  <HelpTooltip
                    label="Ring Buffer (Keep)"
                    content="Ограничивает число сессий в памяти. При превышении самые старые удаляются по кольцевому буферу, а настройка Drop Non-Matching сбрасывает отфильтрованный шум на этапе захвата."
                  />
                </div>
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
          {!compactToolbar && (
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
          )}
        </div>

        {/* Optional Group: OS System Proxy & Selective TLS MITM */}
        {toolbarGroups.proxyMode && (
          <div className="flex items-center gap-1 border-l border-hairline pl-1.5">
            <div className="inline-flex h-7 items-center">
              <button
                type="button"
                onClick={onToggleSystemProxy}
                aria-pressed={status.systemProxyEnabled}
                aria-label="OS System Proxy"
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
                {!compactToolbar && <span>SysProxy</span>}
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
                className="toolbar-popover z-50 hidden w-80 rounded-lg border border-strong bg-surface p-3 text-xs text-fg shadow-popover"
              >
                <div className="flex items-center justify-between border-b border-hairline pb-2 font-semibold">
                  <div className="flex items-center gap-1.5">
                    <span>OS System Proxy</span>
                    <HelpTooltip
                      label="Подробнее об OS System Proxy"
                      content="Прописывает 127.0.0.1 и порт прокси в системных настройках ОС, чтобы браузеры и настольные приложения направляли трафик через FluxProxy без ручной настройки."
                    />
                  </div>
                  <span className="font-mono text-[10px] text-muted">
                    {status.systemProxyEnabled
                      ? `127.0.0.1:${status.port}`
                      : "Port Only"}
                  </span>
                </div>
                <div className="mt-2.5 flex items-start justify-between gap-2 rounded-md border border-hairline bg-canvas p-2 hover:border-strong">
                  <label className="flex flex-1 cursor-pointer items-start gap-2">
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
                  <HelpTooltip
                    label="Act as System Proxy on startup"
                    content="Автоматически включает системный прокси при запуске захвата и аккуратно возвращает исходные настройки ОС при паузе или выходе."
                  />
                </div>
                <div className="mt-2 flex items-start justify-between gap-2 rounded-md border border-hairline bg-canvas p-2 hover:border-strong">
                  <label className="flex flex-1 cursor-pointer items-start gap-2">
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
                  <HelpTooltip
                    label="Разрешить подключения с удалённых устройств"
                    content="Переключает прослушивание с loopback 127.0.0.1 на все интерфейсы 0.0.0.0, чтобы принимать запросы от смартфонов в Wi-Fi/LAN и виртуальных машин."
                  />
                </div>
                <div className="mt-2 rounded-md border border-hairline bg-canvas p-2">
                  <div className="mb-1 flex items-center justify-between text-[10px] text-subtle">
                    <div className="flex items-center gap-1">
                      <span>CLI Env:</span>
                      <HelpTooltip
                        label="CLI Env"
                        content="Переменные окружения для curl, Python, Node.js и утилит терминала — удобно для перехвата только одной консольной сессии без SysProxy."
                      />
                    </div>
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
                aria-label="Toggle TLS MITM Mode"
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
                {!compactToolbar && (
                  <span>
                    {isTargetedOnly ? `Target (${targetHostsCount})` : "MITM All"}
                  </span>
                )}
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
                <div className="flex items-center justify-between border-b border-hairline pb-2 font-semibold">
                  <span>Selective TLS MITM</span>
                  <HelpTooltip
                    label="Selective TLS MITM"
                    content="Управляет глубиной HTTPS-перехвата: Intercept All расшифровывает всё (кроме Bypass-исключений), а Targeted Only расшифровывает только хосты из Target Allowlist."
                  />
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
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <label className="flex flex-1 cursor-pointer items-center gap-2 text-[11px] text-muted">
                      <input
                        type="checkbox"
                        checked={hideConnectTunnels}
                        onChange={onToggleHideConnectTunnels}
                        className="checkbox-native"
                      />
                      <span>Скрывать туннели CONNECT / PASSTHROUGH</span>
                    </label>
                    <HelpTooltip
                      label="Скрывать CONNECT-туннели"
                      content="Скрывает непрозрачные TCP-туннели (Bypass / Passthrough) из таблицы сессий, чтобы в списке оставались только расшифрованные HTTP/HTTPS-запросы."
                    />
                  </div>
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

        {/* Network Bandwidth Throttling Selector & Routing Indicator (always visible & labeled) */}
        <div className="flex items-center gap-1 border-l border-hairline pl-1.5">
          <button
            ref={throttleBtnRef}
            type="button"
            aria-label={`Network Throttling: ${activeThrottleDef.label}`}
            aria-expanded={throttleExpanded}
            aria-controls={throttlePopoverId}
            title={
              throttleConfig.preset === "offline"
                ? "Bandwidth Throttling: Offline (все запросы отклоняются с HTTP 503)"
                : throttleConfig.preset === "none"
                  ? "Bandwidth Throttling: No Throttling (полная скорость)"
                  : `Bandwidth Throttling: ${activeThrottleDef.label} (↓${throttleConfig.downloadKbps} Kbps / ↑${throttleConfig.uploadKbps} Kbps / ${throttleConfig.latencyMs} ms)`
            }
            onClick={(e) =>
              toggleInvokerFallback(
                e,
                throttleBtnRef.current,
                throttlePopoverRef.current
              )
            }
            {...({
              commandfor: throttlePopoverId,
              command: "toggle-popover",
            } as Record<string, string>)}
            className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors ${
              throttleConfig.preset === "offline"
                ? "border-status5xx-fg/50 bg-status5xx-bg text-status5xx-fg hover:brightness-110"
                : throttleConfig.preset !== "none"
                  ? "border-status4xx-fg/45 bg-status4xx-bg text-status4xx-fg hover:brightness-110"
                  : "border-hairline bg-elevated text-muted hover:border-strong hover:text-fg"
            }`}
          >
            {throttleConfig.preset === "offline" ? (
              <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <Gauge className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="whitespace-nowrap font-mono text-[11px] font-medium">
              {throttleConfig.preset === "none"
                ? "Throttle: Off"
                : throttleConfig.preset === "custom"
                  ? `Throttle: Custom (${throttleConfig.latencyMs}ms)`
                  : `Throttle: ${activeThrottleDef.shortLabel}`}
            </span>
            <ChevronDown className="h-3 w-3 opacity-75" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => onOpenNetworkRouting()}
            aria-label={`Network & Routing (${activeRoutingCount} active)`}
            title={`Network & Routing: HOSTS (${activeHostRemapCount}), Upstream (${upstreamProxyEnabled ? "On" : "Off"}), mTLS (${activeClientCertsCount}) — открыть в Settings`}
            className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors ${
              activeRoutingCount > 0
                ? "border-accent/45 bg-selected text-accent hover:brightness-110"
                : "border-hairline bg-elevated text-muted hover:border-strong hover:text-fg"
            }`}
          >
            <Network className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="whitespace-nowrap text-[11px] font-medium">
              Routing
            </span>
            {activeRoutingCount > 0 && (
              <span className="rounded-full bg-accent/15 px-1.5 font-mono text-[10px] font-semibold tabular-nums text-accent">
                {activeRoutingCount}
              </span>
            )}
          </button>

          <div
            ref={throttlePopoverRef}
            id={throttlePopoverId}
            {...({ popover: "auto" } as Record<string, string>)}
            className="toolbar-popover z-50 hidden w-80 rounded-lg border border-strong bg-surface p-3 text-xs text-fg shadow-popover"
          >
            <div className="flex items-center justify-between border-b border-hairline pb-2">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold">
                  Bandwidth Throttling &amp; Latency
                </span>
                <HelpTooltip
                  label="Bandwidth Throttling & Latency"
                  content="Искусственно ограничивает пропускную способность и добавляет сетевую задержку (RTT) или режим Offline для тестирования поведения клиента в плохих сетях."
                />
              </div>
              {throttleConfig.preset !== "none" && (
                <button
                  type="button"
                  onClick={() => handleSelectThrottlePreset("none")}
                  className="text-[11px] text-accent hover:underline"
                >
                  Reset to Full
                </button>
              )}
            </div>

            <div className="mt-2 space-y-1">
              {THROTTLE_PRESET_DEFINITIONS.filter((d) => d.id !== "custom").map(
                (presetDef) => {
                  const isSelected = throttleConfig.preset === presetDef.id;
                  return (
                    <button
                      key={presetDef.id}
                      type="button"
                      onClick={() => handleSelectThrottlePreset(presetDef.id)}
                      className={`flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                        isSelected
                          ? presetDef.id === "offline"
                            ? "border-status5xx-fg/50 bg-status5xx-bg text-status5xx-fg"
                            : "border-accent/50 bg-selected text-fg"
                          : "border-hairline bg-canvas text-muted hover:border-strong hover:text-fg"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {isSelected ? (
                          <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                        ) : (
                          <span className="inline-block h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="font-medium text-fg">
                          {presetDef.label}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-subtle">
                        {presetDef.summary}
                      </span>
                    </button>
                  );
                }
              )}
            </div>

            <form
              onSubmit={handleApplyCustomThrottle}
              className="mt-3 space-y-2 border-t border-hairline pt-2.5"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-fg">
                    Custom Profile
                  </span>
                  <HelpTooltip
                    label="Custom Throttling Profile"
                    content="Ручная настройка ↓ скачивания и ↑ отдачи (Kbps, 0 = без ограничения) и круговой сетевой задержки RTT (ms)."
                  />
                </div>
                {throttleConfig.preset === "custom" && (
                  <span className="rounded bg-status4xx-bg px-1.5 py-0.5 font-mono text-[10px] font-semibold text-status4xx-fg">
                    Active
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                <div className="flex flex-col gap-0.5">
                  <label
                    htmlFor={throttleDownInputId}
                    className="text-[10px] text-subtle"
                  >
                    ↓ Kbps
                  </label>
                  <input
                    id={throttleDownInputId}
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={customDownDraft}
                    onChange={(e) => setCustomDownDraft(e.target.value)}
                    className="h-7 w-full rounded border border-strong bg-canvas px-2 font-mono text-[11px] text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <label
                    htmlFor={throttleUpInputId}
                    className="text-[10px] text-subtle"
                  >
                    ↑ Kbps
                  </label>
                  <input
                    id={throttleUpInputId}
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={customUpDraft}
                    onChange={(e) => setCustomUpDraft(e.target.value)}
                    className="h-7 w-full rounded border border-strong bg-canvas px-2 font-mono text-[11px] text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <label
                    htmlFor={throttleLatencyInputId}
                    className="text-[10px] text-subtle"
                  >
                    RTT ms
                  </label>
                  <input
                    id={throttleLatencyInputId}
                    type="number"
                    min={0}
                    inputMode="numeric"
                    value={customLatencyDraft}
                    onChange={(e) => setCustomLatencyDraft(e.target.value)}
                    className="h-7 w-full rounded border border-strong bg-canvas px-2 font-mono text-[11px] text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  />
                </div>
              </div>
              <button
                type="submit"
                className="flex h-7 w-full items-center justify-center rounded border border-strong bg-elevated text-[11px] font-medium text-fg hover:bg-hover"
              >
                Apply Custom Limits
              </button>
            </form>

            <button
              type="button"
              onClick={() => {
                closeThrottlePopover();
                onOpenNetworkRouting("throttling");
              }}
              className="mt-2 flex h-7 w-full items-center justify-center rounded border border-hairline bg-elevated text-[11px] text-muted hover:text-fg"
            >
              Открыть Network &amp; Routing в Settings…
            </button>
          </div>
        </div>

        {/* Optional Group: Breakpoints (or alert pill when paused packets exist) */}
        {(toolbarGroups.breakpoints || pausedBreakpointCount > 0) &&
          (!compactToolbar ||
            pausedBreakpointCount > 0 ||
            breakpointConfig.breakBeforeRequest ||
            breakpointConfig.breakAfterResponse ||
            breakpointConfig.rules.some((r) => r.enabled)) && (
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
            className={`relative flex ${compactToolbar ? "h-6" : "h-7"} min-w-0 flex-1 items-center rounded-md border bg-canvas px-2 transition-colors ${
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
              aria-label="Filters & Presets"
              title="Открыть матрицу фильтров и пресеты (Alt+4)"
              className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors ${
                activeFilterCount > 0 || activePresetName
                  ? "border-accent/50 bg-selected text-fg"
                  : "border-hairline bg-elevated text-muted hover:border-strong hover:text-fg"
              }`}
            >
              <ListFilter className="h-3.5 w-3.5 text-accent" />
              {!compactToolbar && (
                <span className="hidden max-w-[100px] truncate md:inline">
                  {activePresetName ?? "Filters"}
                </span>
              )}
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
        <div
          className={`flex shrink-0 items-center gap-0.5 rounded-md border border-hairline bg-canvas ${
            compactToolbar ? "px-0.5 py-0" : "p-0.5"
          }`}
        >
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

      {/* Right: Optional No-Cache Utility + Layout Switches + Column Picker */}
      <div className="flex shrink-0 items-center gap-1">
        {!compactToolbar && toolbarGroups.utilities && (
          <div className="flex items-center gap-1 border-r border-hairline pr-1.5">
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
              <RefreshCwOff className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        {toolbarGroups.layout && (
          <div className="flex items-center gap-1">
            {/* Layout Control: Sidebar */}
            {!compactToolbar && (
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
              </div>
            )}

            {/* Column Picker Popover Button */}
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
              aria-label="Customize columns"
              title="Настроить видимость колонок таблицы TrafficGrid"
              {...({
                commandfor: columnsPopoverId,
                command: "toggle-popover",
              } as Record<string, string>)}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-elevated px-2 text-xs text-muted transition-colors hover:border-strong hover:text-fg"
            >
              <Columns3 className="h-3.5 w-3.5" />
              {!compactToolbar && <span className="hidden lg:inline">Columns</span>}
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
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold">Session Columns</span>
                  <HelpTooltip
                    label="Session Columns"
                    content="Включает или скрывает столбцы таблицы TrafficGrid. Настройка тем, групп тулбара и компоновки панелей вынесена в Settings → UI & Columns."
                  />
                </div>
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
              <button
                type="button"
                onClick={() => {
                  columnsPopoverRef.current?.hidePopover?.();
                  onOpenAppearanceSettings();
                }}
                className="mt-3 flex h-7 w-full items-center justify-center rounded border border-hairline bg-elevated text-[11px] text-muted hover:text-fg"
              >
                Настроить тулбар и темы в Settings…
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
};
