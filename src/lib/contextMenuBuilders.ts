import React from "react";
import {
  Archive,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUp,
  ArrowUpDown,
  BarChart2,
  Binary,
  CheckSquare,
  Clipboard,
  ClipboardCopy,
  Code2,
  Columns3,
  Copy,
  Database,
  Download,
  Eraser,
  FileCode2,
  FileJson,
  FileText,
  Filter,
  FilterX,
  FolderOpen,
  GitCompareArrows,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  Link2,
  ListFilter,
  MessageSquarePlus,
  OctagonPause,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Pause,
  Play,
  Plus,
  Radio,
  Regex,
  RotateCcw,
  RotateCw,
  Save,
  Scissors,
  Send,
  Settings,
  ShieldCheck,
  ShieldOff,
  Sliders,
  Smartphone,
  Sparkles,
  Stethoscope,
  Syringe,
  Target,
  Terminal,
  Trash2,
  Wand2,
  WrapText,
  X,
} from "lucide-react";
import type {
  ContextMenuActionItem,
  ContextMenuItem,
} from "../hooks/useContextMenu";
import type { ColumnDefinition } from "../hooks/useUiPreferences";
import { extractParentWildcardDomain } from "./filterEngine";
import { getSectionMeta } from "./sectionRegistry";
import type {
  ActiveNavSection,
  AutoResponderRule,
  BreakpointRule,
  ColumnId,
  HeaderMutationDirection,
  HeaderMutationOp,
  HeaderPair,
  InspectorDockPosition,
  ScriptConsoleLogEvent,
  SessionSummary,
  SortDirection,
  WebSocketFrameRecord,
} from "../types/proxy";
import type { TextWizardTab } from "../components/TextWizardPanel";

type IconComponent = React.ComponentType<{ className?: string }>;

function makeIcon(Comp: IconComponent, className = "h-3.5 w-3.5"): React.ReactNode {
  return React.createElement(Comp, { className });
}

export function truncateMenuLabel(value: string, maxLen = 44): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(1, maxLen - 1))}…`;
}

export function isRemoteClientIp(ip?: string | null): ip is string {
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

/**
 * Preserves Monaco Editor's built-in context menu (wired in `src/lib/monaco.ts`).
 */
export function shouldPreserveNativeContextMenu(
  target: EventTarget | null
): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(".monaco-editor"));
}

const TEXT_EDITABLE_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "url",
  "email",
  "password",
  "tel",
  "number",
]);

export function findEditableTextTarget(
  target: EventTarget | null
): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (shouldPreserveNativeContextMenu(target)) return null;

  const inputOrArea = target.closest("input, textarea");
  if (inputOrArea instanceof HTMLTextAreaElement) {
    return inputOrArea;
  }
  if (inputOrArea instanceof HTMLInputElement) {
    const inputType = (inputOrArea.type || "text").toLowerCase();
    if (TEXT_EDITABLE_INPUT_TYPES.has(inputType)) {
      return inputOrArea;
    }
    return null;
  }

  const ce = target.closest("[contenteditable]");
  if (ce instanceof HTMLElement && ce.isContentEditable) {
    return ce;
  }

  return null;
}

export interface EditableSelectionSnapshot {
  start: number | null;
  end: number | null;
  selectedText: string;
  hasText: boolean;
  readOnly: boolean;
  disabled: boolean;
  isContentEditable: boolean;
}

export function captureEditableSelection(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLElement
): EditableSelectionSnapshot {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    let start: number | null = null;
    let end: number | null = null;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {
      start = null;
      end = null;
    }
    const value = el.value ?? "";
    const selectedText =
      start !== null && end !== null && end > start
        ? value.slice(start, end)
        : "";
    return {
      start,
      end,
      selectedText,
      hasText: value.length > 0,
      readOnly: el.readOnly,
      disabled: el.disabled,
      isContentEditable: false,
    };
  }

  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  const selectedText =
    sel && !sel.isCollapsed && el.contains(sel.anchorNode)
      ? sel.toString()
      : "";
  return {
    start: null,
    end: null,
    selectedText,
    hasText: (el.textContent ?? "").length > 0,
    readOnly: false,
    disabled: false,
    isContentEditable: true,
  };
}

/**
 * Updates React-controlled `<input>` / `<textarea>` values via the native
 * prototype setter so React's `onChange` handler fires immediately.
 */
export function setNativeEditableValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  nextValue: string,
  nextCursorPos?: number
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) {
    setter.call(el, nextValue);
  } else {
    el.value = nextValue;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  if (typeof nextCursorPos === "number") {
    try {
      el.setSelectionRange(nextCursorPos, nextCursorPos);
    } catch {
      // Input types such as `number` do not support setSelectionRange
    }
  }
}

export async function copyTextToClipboard(
  text: string,
  onNotify?: (msg: string) => void,
  toastMessage?: string
): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else if (typeof document !== "undefined") {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand?.("copy");
      document.body.removeChild(ta);
    }
    if (onNotify && toastMessage) {
      onNotify(toastMessage);
    }
    return true;
  } catch {
    return false;
  }
}

export function getActiveReadOnlySelection(): string {
  if (typeof window === "undefined") return "";
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return "";
  return sel.toString().trim();
}

const WIZARD_TAB_LABELS: Record<TextWizardTab, string> = {
  jwt: "JWT",
  base64: "Base64",
  url: "URL Codec",
  compression: "Compression",
  hex: "Hex",
  timestamp: "Timestamp",
};

/**
 * Heuristically chooses the best TextWizard tab for an arbitrary value
 * (header value, cookie value, query param, or highlighted text).
 */
export function detectTextWizardTab(raw: string): TextWizardTab {
  const trimmed = raw.trim();
  if (!trimmed) return "base64";

  const withoutBearer = trimmed.replace(/^Bearer\s+/i, "").trim();
  const jwtParts = withoutBearer.split(".");
  if (
    jwtParts.length === 3 &&
    jwtParts[0].length >= 8 &&
    jwtParts[1].length >= 8 &&
    /^[A-Za-z0-9_-]+$/.test(jwtParts[0]) &&
    /^[A-Za-z0-9_-]+$/.test(jwtParts[1]) &&
    jwtParts[0].startsWith("eyJ")
  ) {
    return "jwt";
  }

  if (
    /^\d{10}(\.\d+)?$/.test(trimmed) ||
    /^\d{13}$/.test(trimmed) ||
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)
  ) {
    return "timestamp";
  }

  if (
    /%[0-9a-fA-F]{2}/.test(trimmed) ||
    /^https?:\/\//i.test(trimmed) ||
    /^[^=\s&]+=[^&\s]*(&[^=\s&]+=[^&\s]*)+$/.test(trimmed)
  ) {
    return "url";
  }

  const hexPairsMatch = /^(?:0x)?[0-9a-fA-F]{2}(?:[\s:,-]+(?:0x)?[0-9a-fA-F]{2}){2,}$/.test(
    trimmed
  );
  const pureLongHex =
    trimmed.length >= 16 &&
    trimmed.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(trimmed) &&
    /[a-fA-F]/.test(trimmed) &&
    /\d/.test(trimmed);
  if (hexPairsMatch || pureLongHex) {
    return "hex";
  }

  return "base64";
}

// ============================================================================
// 1. Editable Input & Read-Only Selection Menus
// ============================================================================

export function buildEditableInputMenuItems(opts: {
  target: HTMLInputElement | HTMLTextAreaElement | HTMLElement;
  snapshot?: EditableSelectionSnapshot;
  extraItems?: ContextMenuItem[];
  onNotify?: (msg: string) => void;
}): ContextMenuItem[] {
  const { target, extraItems = [], onNotify } = opts;
  const snap = opts.snapshot ?? captureEditableSelection(target);
  const canEdit = !snap.readOnly && !snap.disabled;
  const hasSelection = snap.selectedText.length > 0;

  const isTextControl =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

  const items: ContextMenuItem[] = [
    {
      id: "edit-cut",
      label: "Cut",
      icon: makeIcon(Scissors),
      shortcut: "Ctrl+X",
      disabled: !canEdit || !hasSelection,
      onSelect: async () => {
        if (!canEdit || !hasSelection) return;
        await copyTextToClipboard(snap.selectedText);
        if (isTextControl) {
          const val = target.value;
          const start = snap.start ?? 0;
          const end = snap.end ?? val.length;
          const next = val.slice(0, start) + val.slice(end);
          target.focus();
          setNativeEditableValue(target, next, start);
        } else {
          target.focus();
          document.execCommand?.("cut");
        }
      },
    },
    {
      id: "edit-copy",
      label: "Copy",
      icon: makeIcon(Copy),
      shortcut: "Ctrl+C",
      disabled: !hasSelection,
      onSelect: async () => {
        if (!hasSelection) return;
        await copyTextToClipboard(snap.selectedText, onNotify);
      },
    },
    {
      id: "edit-paste",
      label: "Paste",
      icon: makeIcon(Clipboard),
      shortcut: "Ctrl+V",
      disabled: !canEdit,
      onSelect: async () => {
        if (!canEdit) return;
        let pasted = "";
        try {
          pasted = (await navigator.clipboard?.readText()) ?? "";
        } catch {
          onNotify?.("Нет доступа к буферу обмена (используйте Ctrl+V)");
          return;
        }
        if (isTextControl) {
          const val = target.value;
          const start = snap.start ?? val.length;
          const end = snap.end ?? val.length;
          const next = val.slice(0, start) + pasted + val.slice(end);
          target.focus();
          setNativeEditableValue(target, next, start + pasted.length);
        } else {
          target.focus();
          document.execCommand?.("insertText", false, pasted);
        }
      },
    },
    {
      id: "edit-select-all",
      label: "Select All",
      icon: makeIcon(CheckSquare),
      shortcut: "Ctrl+A",
      disabled: !snap.hasText,
      onSelect: () => {
        target.focus();
        if (isTextControl) {
          try {
            target.select();
          } catch {
            // ignore
          }
        } else if (typeof window !== "undefined") {
          const range = document.createRange();
          range.selectNodeContents(target);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      },
    },
  ];

  if (extraItems.length > 0) {
    items.push({ type: "separator", id: "edit-extra-sep" }, ...extraItems);
  }

  return items;
}

export function buildSelectionContextMenuItems(opts: {
  selectedText: string;
  onOpenTextWizard?: (text: string, tab: TextWizardTab) => void;
  onQuickFilter?: (query: string) => void;
  onNotify?: (msg: string) => void;
}): ContextMenuItem[] {
  const { selectedText, onOpenTextWizard, onQuickFilter, onNotify } = opts;
  const trimmed = selectedText.trim();
  if (!trimmed) return [];

  const detectedTab = detectTextWizardTab(trimmed);
  const wizardTitle = getSectionMeta("wizard").title;

  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "selection-header",
      label: `Выделенный текст (${trimmed.length} симв.)`,
      subtitle: truncateMenuLabel(trimmed, 42),
    },
    {
      id: "selection-copy",
      label: "Copy Selection",
      icon: makeIcon(Copy),
      shortcut: "Ctrl+C",
      onSelect: () =>
        void copyTextToClipboard(
          selectedText,
          onNotify,
          "Выделенный текст скопирован"
        ),
    },
  ];

  if (onOpenTextWizard) {
    items.push({
      type: "submenu",
      id: "selection-textwizard",
      label: `Decode Selection in ${wizardTitle}`,
      icon: makeIcon(Wand2, "h-3.5 w-3.5 text-accent"),
      items: [
        {
          id: "selection-tw-auto",
          label: `Auto-detect (${WIZARD_TAB_LABELS[detectedTab]})`,
          icon: makeIcon(Sparkles, "h-3.5 w-3.5 text-accent"),
          onSelect: () => onOpenTextWizard(trimmed, detectedTab),
        },
        { type: "separator", id: "selection-tw-sep" },
        {
          id: "selection-tw-jwt",
          label: "JWT",
          onSelect: () => onOpenTextWizard(trimmed, "jwt"),
        },
        {
          id: "selection-tw-base64",
          label: "Base64",
          onSelect: () => onOpenTextWizard(trimmed, "base64"),
        },
        {
          id: "selection-tw-url",
          label: "URL Codec",
          onSelect: () => onOpenTextWizard(trimmed, "url"),
        },
        {
          id: "selection-tw-hex",
          label: "Hex ↔ Text",
          onSelect: () => onOpenTextWizard(trimmed, "hex"),
        },
        {
          id: "selection-tw-ts",
          label: "Timestamp ↔ ISO",
          onSelect: () => onOpenTextWizard(trimmed, "timestamp"),
        },
      ],
    });
  }

  if (onQuickFilter) {
    items.push({
      id: "selection-filter",
      label: "Filter Traffic by Selection",
      icon: makeIcon(Filter),
      onSelect: () => onQuickFilter(trimmed),
    });
  }

  return items;
}

// ============================================================================
// 2. TrafficGrid Context Menus (Row, Column Header, Empty Table Area)
// ============================================================================

export interface TrafficRowMenuOptions {
  session: SessionSummary;
  targetIds: number[];
  selectedId: number | null;
  onReplaySessions: (ids: number[]) => void;
  onSendToComposer: (id: number) => void;
  onCompareWithSession: (id: number) => void;
  onOpenDiffModal: () => void;
  onOpenStatistics?: (id: number) => void;
  onCopyUrl: (ids: number[]) => void;
  onCopyCurl: (id: number) => void;
  onGenerateClientCode?: (id: number) => void;
  onCopyHeaders: (id: number, kind: "request" | "response") => void;
  onExportSelectedSessions?: (ids: number[], format: "har" | "saz" | "raw") => void;
  onExportOpenApi?: (ids: number[]) => void;
  onSaveSessionBody?: (id: number, isResponse: boolean) => void;
  onAnnotateSessions: (ids: number[]) => void;
  onUnmarkSessions: (ids: number[]) => void;
  onCreateRuleFromSession: (session: SessionSummary) => void;
  onAddBreakpoint?: (stage: "request" | "response", pattern: string) => void;
  onFilterByHost?: (host: string) => void;
  onFilterByStatus?: (status: number) => void;
  onFilterByProcess?: (processName: string) => void;
  onFilterByClientIp?: (clientIp: string) => void;
  onAddClientIpToAllowlist?: (clientIp: string) => void;
  onAlwaysInspectHost?: (hostOrPattern: string) => void;
  onAlwaysPassthroughHost?: (hostOrPattern: string) => void;
  onDeleteSessions: (ids: number[]) => void;
}

export function buildTrafficRowContextMenu(
  opts: TrafficRowMenuOptions
): ContextMenuItem[] {
  const { session, targetIds, selectedId } = opts;
  const count = targetIds.length;
  const suffix = count > 1 ? ` (${count})` : "";
  const hostClean = session.host.split(":")[0].trim();
  const wildcardDomain = hostClean ? extractParentWildcardDomain(hostClean) : null;
  const bpPattern = session.path.split("?")[0] || hostClean;
  const remoteClientIp = isRemoteClientIp(session.clientIp)
    ? session.clientIp
    : null;

  const composerMeta = getSectionMeta("composer");
  const diffMeta = getSectionMeta("diff");
  const rulesMeta = getSectionMeta("rules");
  const codeGenMeta = getSectionMeta("codeGenerator");
  const openApiMeta = getSectionMeta("openApiExport");
  const commentMeta = getSectionMeta("commentMark");

  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "row-header",
      label:
        count > 1
          ? `Выбрано сессий: ${count}`
          : `#${session.id} ${session.method} ${hostClean}`,
      subtitle: count > 1 ? `Активная: #${session.id} ${session.path}` : truncateMenuLabel(session.path || session.url, 44),
    },
    {
      id: "row-replay",
      label: `Replay запрос${suffix}`,
      icon: makeIcon(RotateCw, "h-3.5 w-3.5 text-accent"),
      shortcut: "R",
      onSelect: () => opts.onReplaySessions(targetIds),
    },
    {
      id: "row-composer",
      label: `Открыть в ${composerMeta.title}`,
      icon: makeIcon(Send),
      shortcut: "E",
      onSelect: () => opts.onSendToComposer(session.id),
    },
    {
      id: "row-diff",
      label: `Сравнить в ${diffMeta.title}`,
      icon: makeIcon(GitCompareArrows),
      shortcut: "Ctrl+D",
      onSelect: () => {
        if (selectedId !== null && selectedId !== session.id && count === 1) {
          opts.onCompareWithSession(session.id);
        } else {
          opts.onOpenDiffModal();
        }
      },
    },
  ];

  if (opts.onOpenStatistics) {
    items.push({
      id: "row-statistics",
      label: "Открыть Statistics",
      icon: makeIcon(BarChart2, "h-3.5 w-3.5 text-accent"),
      onSelect: () => opts.onOpenStatistics?.(session.id),
    });
  }

  items.push(
    { type: "separator", id: "row-sep-copy" },
    {
      id: "row-copy-url",
      label: `Copy URL${suffix}`,
      icon: makeIcon(Copy),
      shortcut: "Ctrl+C",
      onSelect: () => opts.onCopyUrl(targetIds),
    },
    {
      id: "row-copy-curl",
      label: "Copy as cURL",
      icon: makeIcon(Terminal),
      onSelect: () => opts.onCopyCurl(session.id),
    }
  );

  if (opts.onGenerateClientCode) {
    items.push({
      id: "row-generate-code",
      label: `${codeGenMeta.title}…`,
      icon: makeIcon(Code2, "h-3.5 w-3.5 text-accent"),
      onSelect: () => opts.onGenerateClientCode?.(session.id),
    });
  }

  items.push({
    type: "submenu",
    id: "row-copy-headers-sub",
    label: "Copy Headers",
    icon: makeIcon(FileCode2),
    items: [
      {
        id: "row-copy-req-headers",
        label: "Copy Request Headers",
        icon: makeIcon(FileCode2),
        onSelect: () => opts.onCopyHeaders(session.id, "request"),
      },
      {
        id: "row-copy-resp-headers",
        label: "Copy Response Headers",
        icon: makeIcon(FileCode2),
        onSelect: () => opts.onCopyHeaders(session.id, "response"),
      },
    ],
  });

  // Export & Save submenu
  const exportChildren: ContextMenuItem[] = [];
  if (opts.onExportSelectedSessions) {
    exportChildren.push(
      {
        id: "row-export-har",
        label: `Save Selected as HAR (.har)${suffix}`,
        icon: makeIcon(Archive, "h-3.5 w-3.5 text-accent"),
        onSelect: () => opts.onExportSelectedSessions?.(targetIds, "har"),
      },
      {
        id: "row-export-saz",
        label: `Save Selected as Fiddler SAZ (.saz)${suffix}`,
        icon: makeIcon(Archive, "h-3.5 w-3.5 text-status3xx-fg"),
        onSelect: () => opts.onExportSelectedSessions?.(targetIds, "saz"),
      }
    );
  }
  if (opts.onExportOpenApi) {
    exportChildren.push({
      id: "row-export-openapi",
      label: `${openApiMeta.title}…${suffix}`,
      icon: makeIcon(FileJson, "h-3.5 w-3.5 text-accent"),
      onSelect: () => opts.onExportOpenApi?.(targetIds),
    });
  }
  if (opts.onSaveSessionBody) {
    exportChildren.push(
      { type: "separator", id: "row-export-body-sep" },
      {
        id: "row-save-req-body",
        label: "Save Request Body As…",
        icon: makeIcon(Download),
        onSelect: () => opts.onSaveSessionBody?.(session.id, false),
      },
      {
        id: "row-save-resp-body",
        label: "Save Response Body As…",
        icon: makeIcon(Download, "h-3.5 w-3.5 text-status2xx-fg"),
        onSelect: () => opts.onSaveSessionBody?.(session.id, true),
      }
    );
  }
  if (opts.onExportSelectedSessions) {
    exportChildren.push({
      id: "row-export-raw",
      label: "Save Full Raw HTTP (.txt)",
      icon: makeIcon(FileText),
      onSelect: () => opts.onExportSelectedSessions?.([session.id], "raw"),
    });
  }
  if (exportChildren.length > 0) {
    items.push({
      type: "submenu",
      id: "row-export-sub",
      label: "Export & Save",
      icon: makeIcon(Save),
      items: exportChildren,
    });
  }

  items.push(
    { type: "separator", id: "row-sep-debug" },
    {
      id: "row-annotate",
      label: commentMeta.title,
      icon: makeIcon(MessageSquarePlus, "h-3.5 w-3.5 text-status4xx-fg"),
      shortcut: "M",
      onSelect: () => opts.onAnnotateSessions(targetIds),
    },
    {
      id: "row-unmark",
      label: "Снять метку (Unmark)",
      icon: makeIcon(Eraser),
      shortcut: "U",
      onSelect: () => opts.onUnmarkSessions(targetIds),
    },
    {
      id: "row-autoresponder",
      label: `Создать правило ${rulesMeta.title}`,
      icon: makeIcon(Sparkles, "h-3.5 w-3.5 text-status4xx-fg"),
      onSelect: () => opts.onCreateRuleFromSession(session),
    }
  );

  if (opts.onAddBreakpoint) {
    items.push({
      type: "submenu",
      id: "row-breakpoint-sub",
      label: "Add Breakpoint (bpu / bpafter)",
      icon: makeIcon(OctagonPause, "h-3.5 w-3.5 text-status4xx-fg"),
      items: [
        {
          id: "row-bp-request",
          label: `Break Before Request (bpu ${truncateMenuLabel(bpPattern, 26)})`,
          icon: makeIcon(OctagonPause, "h-3.5 w-3.5 text-amber-400"),
          onSelect: () => opts.onAddBreakpoint?.("request", bpPattern),
        },
        {
          id: "row-bp-response",
          label: `Break After Response (bpafter ${truncateMenuLabel(bpPattern, 24)})`,
          icon: makeIcon(OctagonPause, "h-3.5 w-3.5 text-violet-400"),
          onSelect: () => opts.onAddBreakpoint?.("response", bpPattern),
        },
      ],
    });
  }

  // Filter By submenu
  const filterChildren: ContextMenuItem[] = [];
  if (opts.onFilterByHost && hostClean) {
    filterChildren.push({
      id: "row-filter-host",
      label: `Filter by Host (${hostClean})`,
      icon: makeIcon(Globe),
      onSelect: () => opts.onFilterByHost?.(hostClean),
    });
  }
  if (opts.onFilterByProcess && session.processName) {
    filterChildren.push({
      id: "row-filter-process",
      label: `Filter by Process (${session.processName})`,
      icon: makeIcon(Filter),
      onSelect: () => opts.onFilterByProcess?.(session.processName!),
    });
  }
  if (opts.onFilterByClientIp && remoteClientIp) {
    filterChildren.push({
      id: "row-filter-client-ip",
      label: `Filter by Client IP (${remoteClientIp})`,
      icon: makeIcon(Smartphone, "h-3.5 w-3.5 text-status2xx-fg"),
      onSelect: () => opts.onFilterByClientIp?.(remoteClientIp),
    });
  }
  if (opts.onFilterByStatus && session.status > 0) {
    filterChildren.push({
      id: "row-filter-status",
      label: `Filter by Status (${session.status})`,
      icon: makeIcon(ListFilter),
      onSelect: () => opts.onFilterByStatus?.(session.status),
    });
  }
  if (filterChildren.length > 0) {
    items.push({
      type: "submenu",
      id: "row-filter-sub",
      label: "Filter by…",
      icon: makeIcon(Filter),
      items: filterChildren,
    });
  }

  // LAN Client Allowlist (direct item for mobile/LAN clients)
  if (remoteClientIp && opts.onAddClientIpToAllowlist) {
    items.push({
      id: "row-allow-lan-ip",
      label: `Allow only this device IP (${remoteClientIp})`,
      icon: makeIcon(ShieldCheck, "h-3.5 w-3.5 text-emerald-400"),
      onSelect: () => opts.onAddClientIpToAllowlist?.(remoteClientIp),
    });
  }

  // TLS / MITM rules submenu
  const tlsChildren: ContextMenuItem[] = [];
  if (opts.onAlwaysInspectHost && hostClean) {
    tlsChildren.push({
      id: "row-tls-inspect",
      label: `Always inspect (${hostClean})`,
      icon: makeIcon(Target, "h-3.5 w-3.5 text-status2xx-fg"),
      onSelect: () => opts.onAlwaysInspectHost?.(hostClean),
    });
    if (wildcardDomain && wildcardDomain !== `*.${hostClean}`) {
      tlsChildren.push({
        id: "row-tls-inspect-wildcard",
        label: `Always inspect ${wildcardDomain}`,
        icon: makeIcon(Target, "h-3.5 w-3.5 text-status2xx-fg"),
        onSelect: () => opts.onAlwaysInspectHost?.(wildcardDomain),
      });
    }
  }
  if (opts.onAlwaysPassthroughHost && hostClean) {
    tlsChildren.push({
      id: "row-tls-passthrough",
      label: `Always passthrough (${hostClean})`,
      icon: makeIcon(ShieldOff),
      onSelect: () => opts.onAlwaysPassthroughHost?.(hostClean),
    });
  }
  if (tlsChildren.length > 0) {
    items.push({
      type: "submenu",
      id: "row-tls-sub",
      label: "TLS / MITM Rules",
      icon: makeIcon(Target),
      items: tlsChildren,
    });
  }

  items.push(
    { type: "separator", id: "row-sep-delete" },
    {
      id: "row-delete",
      label: count > 1 ? `Удалить выбранные (${count})` : "Удалить сессию",
      icon: makeIcon(Trash2),
      shortcut: "Del",
      danger: true,
      onSelect: () => opts.onDeleteSessions(targetIds),
    }
  );

  return items;
}

export interface TrafficHeaderMenuOptions {
  clickedColumn: ColumnDefinition | null;
  allColumns: readonly ColumnDefinition[];
  visibleColumns: Record<ColumnId, boolean>;
  columnWidths: Record<ColumnId, number>;
  sortColumn: ColumnId | null;
  sortDirection: SortDirection;
  onSort: (colId: ColumnId, dir: SortDirection) => void;
  onClearSort: () => void;
  onAutoFitColumn: (col: ColumnDefinition) => void;
  onAutoFitAllVisible: () => void;
  onToggleColumnVisibility: (colId: ColumnId) => void;
  onResetColumns: () => void;
}

export function buildTrafficHeaderContextMenu(
  opts: TrafficHeaderMenuOptions
): ContextMenuItem[] {
  const targetCol =
    opts.clickedColumn ??
    opts.allColumns.find((c) => c.id === opts.sortColumn) ??
    opts.allColumns[0];

  const isAsc =
    opts.sortColumn === targetCol.id && opts.sortDirection === "asc";
  const isDesc =
    opts.sortColumn === targetCol.id && opts.sortDirection === "desc";

  const visibleCount = opts.allColumns.filter(
    (c) => opts.visibleColumns[c.id]
  ).length;

  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "col-header-sort",
      label: `Сортировка: ${targetCol.label}`,
    },
    {
      id: "col-sort-asc",
      label: "Sort Ascending (ASC)",
      checked: isAsc,
      checkVariant: "radio",
      onSelect: () => opts.onSort(targetCol.id, "asc"),
    },
    {
      id: "col-sort-desc",
      label: "Sort Descending (DESC)",
      checked: isDesc,
      checkVariant: "radio",
      onSelect: () => opts.onSort(targetCol.id, "desc"),
    },
    {
      id: "col-sort-clear",
      label: "Clear Sort",
      icon: makeIcon(RotateCcw),
      disabled: opts.sortColumn === null,
      onSelect: opts.onClearSort,
    },
    { type: "separator", id: "col-sep-autofit" },
  ];

  if (opts.clickedColumn) {
    const col = opts.clickedColumn;
    items.push({
      id: "col-autofit-one",
      label: `Auto-fit "${col.label}"`,
      icon: makeIcon(Columns3),
      onSelect: () => opts.onAutoFitColumn(col),
    });
  }

  items.push(
    {
      id: "col-autofit-all",
      label: "Auto-fit All Visible Columns",
      icon: makeIcon(ArrowUpDown),
      onSelect: opts.onAutoFitAllVisible,
    },
    { type: "separator", id: "col-sep-visibility" },
    {
      type: "header",
      id: "col-header-visibility",
      label: `Видимость колонок (${visibleCount}/${opts.allColumns.length})`,
    }
  );

  for (const col of opts.allColumns) {
    const checked = Boolean(opts.visibleColumns[col.id]);
    const disableUncheck = checked && visibleCount <= 1;
    items.push({
      id: `col-vis-${col.id}`,
      label: col.label,
      shortcut: `${opts.columnWidths[col.id] ?? col.defaultWidth}px`,
      checked,
      disabled: disableUncheck,
      keepOpen: true,
      onSelect: () => opts.onToggleColumnVisibility(col.id),
    });
  }

  items.push(
    { type: "separator", id: "col-sep-reset" },
    {
      id: "col-reset",
      label: "Reset Columns",
      icon: makeIcon(RotateCcw),
      onSelect: opts.onResetColumns,
    }
  );

  return items;
}

export interface TrafficEmptyMenuOptions {
  visibleCount: number;
  totalCount: number;
  proxyRunning: boolean;
  followTail: boolean;
  hasActiveFilters: boolean;
  onSelectAllVisible?: () => void;
  onToggleCapture?: () => void;
  onToggleFollowTail?: () => void;
  onImportArchive?: () => void;
  onSaveAllSessions?: () => void;
  onResetFilters?: () => void;
  onResetColumns: () => void;
  onClearAllSessions?: () => void;
}

export function buildTrafficEmptyContextMenu(
  opts: TrafficEmptyMenuOptions
): ContextMenuItem[] {
  const trafficMeta = getSectionMeta("traffic");
  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "empty-header",
      label: `${trafficMeta.title} (${opts.visibleCount}/${opts.totalCount})`,
    },
  ];

  if (opts.onSelectAllVisible) {
    items.push({
      id: "empty-select-all",
      label: "Select All Visible Sessions",
      icon: makeIcon(CheckSquare),
      shortcut: "Ctrl+A",
      disabled: opts.visibleCount === 0,
      onSelect: opts.onSelectAllVisible,
    });
  }

  if (opts.onToggleCapture) {
    items.push({
      id: "empty-toggle-capture",
      label: opts.proxyRunning ? "Pause Capture" : "Resume Capture",
      icon: makeIcon(opts.proxyRunning ? Pause : Play),
      shortcut: "F12",
      onSelect: opts.onToggleCapture,
    });
  }

  if (opts.onToggleFollowTail) {
    items.push({
      id: "empty-follow-tail",
      label: "Follow Tail (Auto-Scroll)",
      checked: opts.followTail,
      onSelect: opts.onToggleFollowTail,
    });
  }

  items.push({ type: "separator", id: "empty-sep-io" });

  if (opts.onImportArchive) {
    items.push({
      id: "empty-import",
      label: "Import Archive…",
      icon: makeIcon(FolderOpen),
      shortcut: "Ctrl+O",
      onSelect: opts.onImportArchive,
    });
  }

  if (opts.onSaveAllSessions) {
    items.push({
      id: "empty-save-all",
      label: "Save All Sessions…",
      icon: makeIcon(Save),
      shortcut: "Ctrl+S",
      disabled: opts.totalCount === 0,
      onSelect: opts.onSaveAllSessions,
    });
  }

  items.push({ type: "separator", id: "empty-sep-reset" });

  if (opts.onResetFilters) {
    items.push({
      id: "empty-reset-filters",
      label: "Reset Active Filters",
      icon: makeIcon(FilterX),
      disabled: !opts.hasActiveFilters,
      onSelect: opts.onResetFilters,
    });
  }

  items.push({
    id: "empty-reset-columns",
    label: "Reset Columns",
    icon: makeIcon(RotateCcw),
    onSelect: opts.onResetColumns,
  });

  if (opts.onClearAllSessions) {
    items.push(
      { type: "separator", id: "empty-sep-clear" },
      {
        id: "empty-clear-all",
        label: "Clear All Sessions",
        icon: makeIcon(Trash2),
        shortcut: "Ctrl+X",
        danger: true,
        disabled: opts.totalCount === 0,
        onSelect: opts.onClearAllSessions,
      }
    );
  }

  return items;
}

// ============================================================================
// 3. SessionInspector, Protocol Panels, HexViewer & Statistics Menus
// ============================================================================

export interface InspectorSummaryMenuOptions {
  summary: SessionSummary;
  inspectorPosition: InspectorDockPosition;
  onCopyUrl: () => void;
  onCopyHost: () => void;
  onCopyPath: () => void;
  onCopyCurl: () => void;
  onReplay?: () => void;
  onEditInComposer: () => void;
  onAddBpu?: () => void;
  onCreateAutoResponderRule?: () => void;
  onFilterByHost?: () => void;
  onDecodeUrlInTextWizard?: () => void;
  onToggleDock?: () => void;
  onCollapseInspector?: () => void;
}

export function buildInspectorSummaryContextMenu(
  opts: InspectorSummaryMenuOptions
): ContextMenuItem[] {
  const { summary, inspectorPosition } = opts;
  const composerMeta = getSectionMeta("composer");
  const rulesMeta = getSectionMeta("rules");
  const wizardMeta = getSectionMeta("wizard");

  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "insp-sum-header",
      label: `#${summary.id} ${summary.method} ${summary.host}`,
      subtitle: truncateMenuLabel(summary.path || summary.url, 44),
    },
    {
      id: "insp-copy-url",
      label: "Copy Full URL",
      icon: makeIcon(Copy),
      onSelect: opts.onCopyUrl,
    },
    {
      id: "insp-copy-host",
      label: "Copy Host",
      icon: makeIcon(Globe),
      onSelect: opts.onCopyHost,
    },
    {
      id: "insp-copy-path",
      label: "Copy Path & Query",
      icon: makeIcon(Link2),
      onSelect: opts.onCopyPath,
    },
    {
      id: "insp-copy-curl",
      label: "Copy as cURL",
      icon: makeIcon(Terminal),
      onSelect: opts.onCopyCurl,
    },
    { type: "separator", id: "insp-sep-actions" },
  ];

  if (opts.onReplay) {
    items.push({
      id: "insp-replay",
      label: "Replay",
      icon: makeIcon(RotateCw, "h-3.5 w-3.5 text-accent"),
      shortcut: "R",
      onSelect: opts.onReplay,
    });
  }

  items.push({
    id: "insp-composer",
    label: `Edit in ${composerMeta.title}`,
    icon: makeIcon(Send),
    shortcut: "E",
    onSelect: opts.onEditInComposer,
  });

  if (opts.onAddBpu) {
    items.push({
      id: "insp-bpu",
      label: "Add bpu Breakpoint",
      icon: makeIcon(OctagonPause, "h-3.5 w-3.5 text-amber-400"),
      onSelect: opts.onAddBpu,
    });
  }

  if (opts.onCreateAutoResponderRule) {
    items.push({
      id: "insp-autoresponder",
      label: `Create ${rulesMeta.title} Rule`,
      icon: makeIcon(Sparkles, "h-3.5 w-3.5 text-status4xx-fg"),
      onSelect: opts.onCreateAutoResponderRule,
    });
  }

  if (opts.onFilterByHost) {
    items.push({
      id: "insp-filter-host",
      label: `Filter by Host (${summary.host})`,
      icon: makeIcon(Filter),
      onSelect: opts.onFilterByHost,
    });
  }

  if (opts.onDecodeUrlInTextWizard) {
    items.push({
      id: "insp-decode-url",
      label: `Decode URL in ${wizardMeta.title}`,
      icon: makeIcon(Wand2, "h-3.5 w-3.5 text-accent"),
      onSelect: opts.onDecodeUrlInTextWizard,
    });
  }

  if (opts.onToggleDock || opts.onCollapseInspector) {
    items.push({ type: "separator", id: "insp-sep-layout" });
  }

  if (opts.onToggleDock) {
    items.push({
      id: "insp-dock",
      label:
        inspectorPosition === "bottom"
          ? "Dock Inspector at Right"
          : "Dock Inspector at Bottom",
      icon: makeIcon(inspectorPosition === "bottom" ? PanelRight : PanelBottom),
      onSelect: opts.onToggleDock,
    });
  }

  if (opts.onCollapseInspector) {
    items.push({
      id: "insp-collapse",
      label: "Collapse Inspector",
      icon: makeIcon(X),
      onSelect: opts.onCollapseInspector,
    });
  }

  return items;
}

export interface KeyValueRowMenuOptions {
  kind: "requestHeaders" | "responseHeaders" | "params";
  item: HeaderPair;
  allItems: HeaderPair[];
  onCopyValue: () => void;
  onCopyPair: () => void;
  onCopyName: () => void;
  onCopyAll: () => void;
  onDecodeInTextWizard?: (value: string, tab: TextWizardTab) => void;
  onFilterByValue?: (value: string) => void;
  onAddHeaderMutationRule?: (
    direction: HeaderMutationDirection,
    operation: HeaderMutationOp,
    headerName: string,
    headerValue: string
  ) => void;
}

export function buildKeyValueRowContextMenu(
  opts: KeyValueRowMenuOptions
): ContextMenuItem[] {
  const { kind, item, allItems } = opts;
  const isHeader = kind === "requestHeaders" || kind === "responseHeaders";
  const direction: HeaderMutationDirection =
    kind === "responseHeaders" ? "response" : "request";
  const kindLabel =
    kind === "requestHeaders"
      ? "Request Header"
      : kind === "responseHeaders"
        ? "Response Header"
        : "Query Param";
  const allLabel = isHeader ? "Copy All Headers" : "Copy All Params";
  const pairLabel = isHeader ? 'Copy "Name: Value"' : 'Copy "Name=Value"';
  const detectedTab = detectTextWizardTab(item.value);
  const wizardMeta = getSectionMeta("wizard");

  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "kv-header",
      label: `${kindLabel}: ${truncateMenuLabel(item.name, 34)}`,
      subtitle: truncateMenuLabel(item.value, 42),
    },
    {
      id: "kv-copy-value",
      label: "Copy Value",
      icon: makeIcon(Copy),
      disabled: !item.value,
      onSelect: opts.onCopyValue,
    },
    {
      id: "kv-copy-pair",
      label: pairLabel,
      icon: makeIcon(ClipboardCopy),
      onSelect: opts.onCopyPair,
    },
    {
      id: "kv-copy-name",
      label: "Copy Name",
      icon: makeIcon(FileText),
      onSelect: opts.onCopyName,
    },
    {
      id: "kv-copy-all",
      label: `${allLabel} (${allItems.length})`,
      icon: makeIcon(FileCode2),
      disabled: allItems.length === 0,
      onSelect: opts.onCopyAll,
    },
    { type: "separator", id: "kv-sep-tools" },
  ];

  if (opts.onDecodeInTextWizard) {
    items.push({
      id: "kv-decode-wizard",
      label: `Decode Value in ${wizardMeta.title} (${WIZARD_TAB_LABELS[detectedTab]})`,
      icon: makeIcon(Wand2, "h-3.5 w-3.5 text-accent"),
      disabled: !item.value.trim(),
      onSelect: () => opts.onDecodeInTextWizard?.(item.value, detectedTab),
    });
  }

  if (opts.onFilterByValue) {
    items.push({
      id: "kv-filter-value",
      label: "Filter by Value",
      icon: makeIcon(Filter),
      disabled: !item.value.trim(),
      onSelect: () => opts.onFilterByValue?.(item.value),
    });
  }

  if (isHeader && opts.onAddHeaderMutationRule) {
    items.push(
      { type: "separator", id: "kv-sep-mutation" },
      {
        type: "submenu",
        id: "kv-add-mutation-sub",
        label: "Add Header Mutation Rule",
        icon: makeIcon(Sliders, "h-3.5 w-3.5 text-amber-400"),
        items: [
          {
            id: "kv-mutation-set",
            label: `Set / Override "${truncateMenuLabel(item.name, 26)}"…`,
            icon: makeIcon(Plus, "h-3.5 w-3.5 text-accent"),
            onSelect: () =>
              opts.onAddHeaderMutationRule?.(
                direction,
                "set",
                item.name,
                item.value
              ),
          },
          {
            id: "kv-mutation-remove",
            label: `Remove "${truncateMenuLabel(item.name, 28)}"…`,
            icon: makeIcon(Trash2),
            danger: true,
            onSelect: () =>
              opts.onAddHeaderMutationRule?.(direction, "remove", item.name, ""),
          },
        ],
      }
    );
  }

  return items;
}

export interface CookieRowMenuOptions {
  cookie: { name: string; value: string; attributes: string };
  allCookies: { name: string; value: string; attributes: string }[];
  onCopyValue: () => void;
  onCopyPair: () => void;
  onCopyName: () => void;
  onCopyAll: () => void;
  onDecodeInTextWizard?: (value: string, tab: TextWizardTab) => void;
  onFilterByValue?: (value: string) => void;
}

export function buildCookieRowContextMenu(
  opts: CookieRowMenuOptions
): ContextMenuItem[] {
  const { cookie, allCookies } = opts;
  const detectedTab = detectTextWizardTab(cookie.value);
  const wizardMeta = getSectionMeta("wizard");

  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "cookie-header",
      label: `Cookie: ${truncateMenuLabel(cookie.name, 34)}`,
      subtitle: truncateMenuLabel(cookie.value || "(empty)", 42),
    },
    {
      id: "cookie-copy-value",
      label: "Copy Value",
      icon: makeIcon(Copy),
      disabled: !cookie.value,
      onSelect: opts.onCopyValue,
    },
    {
      id: "cookie-copy-pair",
      label: 'Copy "Name=Value"',
      icon: makeIcon(ClipboardCopy),
      onSelect: opts.onCopyPair,
    },
    {
      id: "cookie-copy-name",
      label: "Copy Name",
      icon: makeIcon(FileText),
      onSelect: opts.onCopyName,
    },
    {
      id: "cookie-copy-all",
      label: `Copy All Cookies (${allCookies.length})`,
      icon: makeIcon(FileCode2),
      disabled: allCookies.length === 0,
      onSelect: opts.onCopyAll,
    },
    { type: "separator", id: "cookie-sep-tools" },
  ];

  if (opts.onDecodeInTextWizard) {
    items.push({
      id: "cookie-decode-wizard",
      label: `Decode Value in ${wizardMeta.title} (${WIZARD_TAB_LABELS[detectedTab]})`,
      icon: makeIcon(Wand2, "h-3.5 w-3.5 text-accent"),
      disabled: !cookie.value.trim(),
      onSelect: () => opts.onDecodeInTextWizard?.(cookie.value, detectedTab),
    });
  }

  if (opts.onFilterByValue) {
    items.push({
      id: "cookie-filter-value",
      label: "Filter by Value",
      icon: makeIcon(Filter),
      disabled: !cookie.value.trim(),
      onSelect: () => opts.onFilterByValue?.(cookie.value),
    });
  }

  return items;
}

export function buildWsFrameContextMenu(opts: {
  frame: WebSocketFrameRecord;
  canReuseInInject: boolean;
  isJsonPayload: boolean;
  onCopyPayload: () => void;
  onCopyPrettyJson: () => void;
  onCopyHex: () => void;
  onReuseInInject: () => void;
  onDecodeInTextWizard?: () => void;
}): ContextMenuItem[] {
  const { frame } = opts;
  const wizardMeta = getSectionMeta("wizard");

  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "ws-header",
      label: `WS Frame #${frame.index} (${frame.opcode})`,
      subtitle: `${frame.direction === "outbound" ? "↑ Client" : "↓ Server"} · ${frame.byteLength} B`,
    },
    {
      id: "ws-copy-payload",
      label: "Copy Frame Payload",
      icon: makeIcon(Copy),
      disabled: !frame.payloadPreview,
      onSelect: opts.onCopyPayload,
    },
    {
      id: "ws-copy-json",
      label: "Copy Pretty JSON",
      icon: makeIcon(FileJson),
      disabled: !opts.isJsonPayload,
      onSelect: opts.onCopyPrettyJson,
    },
    {
      id: "ws-copy-hex",
      label: "Copy Hex",
      icon: makeIcon(Binary),
      disabled: !frame.payloadPreview,
      onSelect: opts.onCopyHex,
    },
    { type: "separator", id: "ws-sep-actions" },
    {
      id: "ws-reuse-inject",
      label: "Reuse Payload in Inject Form",
      icon: makeIcon(Syringe, "h-3.5 w-3.5 text-accent"),
      disabled: !opts.canReuseInInject || !frame.payloadPreview,
      onSelect: opts.onReuseInInject,
    },
  ];

  if (opts.onDecodeInTextWizard) {
    items.push({
      id: "ws-decode-wizard",
      label: `Decode in ${wizardMeta.title}`,
      icon: makeIcon(Wand2, "h-3.5 w-3.5 text-accent"),
      disabled: !frame.payloadPreview,
      onSelect: opts.onDecodeInTextWizard,
    });
  }

  return items;
}

export function buildSseEventContextMenu(opts: {
  eventIndex: number;
  eventName: string;
  eventData: string;
  hasFullStream: boolean;
  onCopyEventData: () => void;
  onCopyFullStream: () => void;
  onDecodeInTextWizard?: () => void;
}): ContextMenuItem[] {
  const wizardMeta = getSectionMeta("wizard");
  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "sse-header",
      label: `SSE Chunk #${opts.eventIndex} (${opts.eventName})`,
      subtitle: truncateMenuLabel(opts.eventData, 42),
    },
    {
      id: "sse-copy-data",
      label: "Copy Event Data",
      icon: makeIcon(Copy),
      disabled: !opts.eventData,
      onSelect: opts.onCopyEventData,
    },
    {
      id: "sse-copy-stream",
      label: "Copy Full SSE Stream",
      icon: makeIcon(Radio),
      disabled: !opts.hasFullStream,
      onSelect: opts.onCopyFullStream,
    },
  ];

  if (opts.onDecodeInTextWizard) {
    items.push(
      { type: "separator", id: "sse-sep-wizard" },
      {
        id: "sse-decode-wizard",
        label: `Decode Data in ${wizardMeta.title}`,
        icon: makeIcon(Wand2, "h-3.5 w-3.5 text-accent"),
        disabled: !opts.eventData.trim(),
        onSelect: opts.onDecodeInTextWizard,
      }
    );
  }

  return items;
}

export function buildHexViewerContextMenu(opts: {
  rowOffset: number | null;
  totalBytes: number;
  hasRow: boolean;
  onCopyRowHex: () => void;
  onCopyRowAscii: () => void;
  onCopyAllHex: () => void;
  onCopyAllBase64: () => void;
  onOpenInTextWizard?: () => void;
  onSaveBodyAs?: () => void;
}): ContextMenuItem[] {
  const wizardMeta = getSectionMeta("wizard");
  const offsetHex =
    opts.rowOffset !== null
      ? `0x${opts.rowOffset.toString(16).padStart(8, "0").toUpperCase()}`
      : null;

  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "hex-header",
      label: offsetHex ? `Hex Row ${offsetHex}` : `Hex Viewer (${opts.totalBytes} B)`,
    },
    {
      id: "hex-copy-row-hex",
      label: "Copy Row Hex",
      icon: makeIcon(Binary),
      disabled: !opts.hasRow,
      onSelect: opts.onCopyRowHex,
    },
    {
      id: "hex-copy-row-ascii",
      label: "Copy Row ASCII",
      icon: makeIcon(FileText),
      disabled: !opts.hasRow,
      onSelect: opts.onCopyRowAscii,
    },
    { type: "separator", id: "hex-sep-all" },
    {
      id: "hex-copy-all-hex",
      label: "Copy All as Hex",
      icon: makeIcon(Copy),
      disabled: opts.totalBytes === 0,
      onSelect: opts.onCopyAllHex,
    },
    {
      id: "hex-copy-all-b64",
      label: "Copy All as Base64",
      icon: makeIcon(ClipboardCopy),
      disabled: opts.totalBytes === 0,
      onSelect: opts.onCopyAllBase64,
    },
  ];

  if (opts.onOpenInTextWizard || opts.onSaveBodyAs) {
    items.push({ type: "separator", id: "hex-sep-tools" });
  }

  if (opts.onOpenInTextWizard) {
    items.push({
      id: "hex-open-wizard",
      label: `Open in ${wizardMeta.title} (Hex)`,
      icon: makeIcon(Wand2, "h-3.5 w-3.5 text-accent"),
      disabled: opts.totalBytes === 0,
      onSelect: opts.onOpenInTextWizard,
    });
  }

  if (opts.onSaveBodyAs) {
    items.push({
      id: "hex-save-body",
      label: "Save Body As…",
      icon: makeIcon(Download),
      onSelect: opts.onSaveBodyAs,
    });
  }

  return items;
}

export function buildImagePreviewContextMenu(opts: {
  contentType: string;
  isSvg: boolean;
  onSaveAs?: () => void;
  onCopyUrl: () => void;
  onCopyPayload: () => void;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "img-header",
      label: opts.isSvg ? "SVG Source" : "Image Preview",
      subtitle: opts.contentType,
    },
  ];

  if (opts.onSaveAs) {
    items.push({
      id: "img-save-as",
      label: opts.isSvg ? "Save SVG As…" : "Save Image As…",
      icon: makeIcon(Download),
      onSelect: opts.onSaveAs,
    });
  }

  items.push(
    {
      id: "img-copy-url",
      label: "Copy Image URL",
      icon: makeIcon(Link2),
      onSelect: opts.onCopyUrl,
    },
    {
      id: "img-copy-source",
      label: opts.isSvg ? "Copy SVG Source" : "Copy Base64 Data URI",
      icon: makeIcon(opts.isSvg ? Code2 : ImageIcon),
      onSelect: opts.onCopyPayload,
    }
  );

  return items;
}

export function buildStatisticsContextMenu(opts: {
  title: string;
  serverIp?: string | null;
  onCopyMarkdown: () => void;
  onCopyText: () => void;
  onCopyServerIp?: () => void;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "stats-header",
      label: opts.title,
    },
    {
      id: "stats-copy-md",
      label: "Copy Timing Summary (Markdown)",
      icon: makeIcon(FileText, "h-3.5 w-3.5 text-accent"),
      onSelect: opts.onCopyMarkdown,
    },
    {
      id: "stats-copy-text",
      label: "Copy Timing Summary (Text)",
      icon: makeIcon(Copy),
      onSelect: opts.onCopyText,
    },
  ];

  if (opts.serverIp && opts.onCopyServerIp) {
    items.push(
      { type: "separator", id: "stats-sep-ip" },
      {
        id: "stats-copy-ip",
        label: `Copy Server IP (${opts.serverIp})`,
        icon: makeIcon(Globe),
        onSelect: opts.onCopyServerIp,
      }
    );
  }

  return items;
}

// ============================================================================
// 4. Composer, AutoResponder & Scripting Menus
// ============================================================================

export function buildComposerUrlContextMenu(opts: {
  input: HTMLInputElement;
  snapshot?: EditableSelectionSnapshot;
  hasUrl: boolean;
  onPasteAndImportCurl: () => void;
  onCopyAsCurl: () => void;
  onClearUrl: () => void;
  onNotify?: (msg: string) => void;
}): ContextMenuItem[] {
  const extraItems: ContextMenuItem[] = [
    {
      id: "composer-paste-curl",
      label: "Paste & Import cURL",
      icon: makeIcon(Terminal, "h-3.5 w-3.5 text-accent"),
      onSelect: opts.onPasteAndImportCurl,
    },
    {
      id: "composer-copy-curl",
      label: "Copy as cURL",
      icon: makeIcon(Copy),
      disabled: !opts.hasUrl,
      onSelect: opts.onCopyAsCurl,
    },
    {
      id: "composer-clear-url",
      label: "Clear URL",
      icon: makeIcon(X),
      disabled: !opts.hasUrl,
      onSelect: opts.onClearUrl,
    },
  ];

  return buildEditableInputMenuItems({
    target: opts.input,
    snapshot: opts.snapshot,
    extraItems,
    onNotify: opts.onNotify,
  });
}

export function buildComposerHeaderRowContextMenu(opts: {
  header: HeaderPair;
  index: number;
  totalCount: number;
  inputTarget?: HTMLInputElement | null;
  snapshot?: EditableSelectionSnapshot;
  onCopyHeader: () => void;
  onDuplicateHeader: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAddHeader: () => void;
  onRemoveHeader: () => void;
  onNotify?: (msg: string) => void;
}): ContextMenuItem[] {
  const rowItems: ContextMenuItem[] = [
    {
      type: "header",
      id: "cmp-hdr-title",
      label: `Header: ${opts.header.name.trim() || `#${opts.index + 1}`}`,
    },
    {
      id: "cmp-hdr-copy",
      label: 'Copy "Name: Value"',
      icon: makeIcon(Copy),
      disabled: !opts.header.name.trim() && !opts.header.value.trim(),
      onSelect: opts.onCopyHeader,
    },
    {
      id: "cmp-hdr-duplicate",
      label: "Duplicate Header",
      icon: makeIcon(ClipboardCopy),
      onSelect: opts.onDuplicateHeader,
    },
    {
      id: "cmp-hdr-move-up",
      label: "Move Up",
      icon: makeIcon(ArrowUp),
      disabled: opts.index <= 0,
      onSelect: opts.onMoveUp,
    },
    {
      id: "cmp-hdr-move-down",
      label: "Move Down",
      icon: makeIcon(ArrowDown),
      disabled: opts.index >= opts.totalCount - 1,
      onSelect: opts.onMoveDown,
    },
    {
      id: "cmp-hdr-add",
      label: "Add New Header",
      icon: makeIcon(Plus),
      onSelect: opts.onAddHeader,
    },
    { type: "separator", id: "cmp-hdr-sep-del" },
    {
      id: "cmp-hdr-remove",
      label: "Remove Header",
      icon: makeIcon(Trash2),
      danger: true,
      onSelect: opts.onRemoveHeader,
    },
  ];

  if (opts.inputTarget) {
    return buildEditableInputMenuItems({
      target: opts.inputTarget,
      snapshot: opts.snapshot,
      extraItems: rowItems,
      onNotify: opts.onNotify,
    });
  }

  return rowItems;
}

export function buildAutoResponderRuleContextMenu(opts: {
  rule: AutoResponderRule;
  onToggleEnabled: () => void;
  onDuplicate: () => void;
  onCopyPattern: () => void;
  onDelete: () => void;
}): ContextMenuItem[] {
  const { rule } = opts;
  return [
    {
      type: "header",
      id: "ar-rule-header",
      label: truncateMenuLabel(rule.name, 36),
      subtitle: truncateMenuLabel(rule.pattern, 40),
    },
    {
      id: "ar-rule-toggle",
      label: rule.enabled ? "Disable Rule" : "Enable Rule",
      checked: rule.enabled,
      onSelect: opts.onToggleEnabled,
    },
    {
      id: "ar-rule-duplicate",
      label: "Duplicate Rule",
      icon: makeIcon(ClipboardCopy),
      onSelect: opts.onDuplicate,
    },
    {
      id: "ar-rule-copy-pattern",
      label: "Copy Match Pattern",
      icon: makeIcon(Copy),
      disabled: !rule.pattern,
      onSelect: opts.onCopyPattern,
    },
    { type: "separator", id: "ar-rule-sep-del" },
    {
      id: "ar-rule-delete",
      label: "Delete Rule",
      icon: makeIcon(Trash2),
      danger: true,
      onSelect: opts.onDelete,
    },
  ];
}

export function buildAutoResponderEmptyContextMenu(opts: {
  enabled: boolean;
  onAddRule: () => void;
  onToggleGlobal?: () => void;
}): ContextMenuItem[] {
  const rulesMeta = getSectionMeta("rules");
  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "ar-empty-header",
      label: rulesMeta.title,
    },
    {
      id: "ar-empty-add",
      label: "Add New Rule",
      icon: makeIcon(Plus, "h-3.5 w-3.5 text-accent"),
      onSelect: opts.onAddRule,
    },
  ];

  if (opts.onToggleGlobal) {
    items.push({
      id: "ar-empty-toggle",
      label: opts.enabled
        ? `Disable ${rulesMeta.title} Globally`
        : `Enable ${rulesMeta.title} Globally`,
      checked: opts.enabled,
      onSelect: opts.onToggleGlobal,
    });
  }

  return items;
}

export type ScriptLogFilterKind = "all" | "stdout" | "errors";

export function formatScriptConsoleLogLine(entry: ScriptConsoleLogEvent): string {
  const scope =
    entry.hook || entry.sessionId !== null
      ? ` [${entry.hook ?? "script"}${entry.sessionId !== null ? ` #${entry.sessionId}` : ""}]`
      : "";
  return `[${entry.timestamp}] [${entry.level.toUpperCase()}]${scope} ${entry.message}`;
}

export function buildScriptConsoleContextMenu(opts: {
  entry?: ScriptConsoleLogEvent | null;
  visibleCount: number;
  totalCount: number;
  logFilter: ScriptLogFilterKind;
  autoScroll: boolean;
  onCopyLine?: () => void;
  onCopyAllVisible: () => void;
  onChangeFilter: (next: ScriptLogFilterKind) => void;
  onToggleAutoScroll: () => void;
  onClearConsole: () => void;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "script-log-header",
      label: opts.entry
        ? `Console Log (${opts.entry.level.toUpperCase()})`
        : `Console Output (${opts.visibleCount})`,
    },
  ];

  if (opts.entry && opts.onCopyLine) {
    items.push({
      id: "script-log-copy-line",
      label: "Copy Log Line",
      icon: makeIcon(Copy),
      onSelect: opts.onCopyLine,
    });
  }

  items.push(
    {
      id: "script-log-copy-all",
      label: `Copy All Visible Logs (${opts.visibleCount})`,
      icon: makeIcon(ClipboardCopy),
      disabled: opts.visibleCount === 0,
      onSelect: opts.onCopyAllVisible,
    },
    { type: "separator", id: "script-log-sep-filter" },
    {
      id: "script-log-filter-all",
      label: "Filter: All",
      checked: opts.logFilter === "all",
      checkVariant: "radio",
      onSelect: () => opts.onChangeFilter("all"),
    },
    {
      id: "script-log-filter-stdout",
      label: "Filter: stdout",
      checked: opts.logFilter === "stdout",
      checkVariant: "radio",
      onSelect: () => opts.onChangeFilter("stdout"),
    },
    {
      id: "script-log-filter-errors",
      label: "Filter: stderr / errors",
      checked: opts.logFilter === "errors",
      checkVariant: "radio",
      onSelect: () => opts.onChangeFilter("errors"),
    },
    { type: "separator", id: "script-log-sep-ctrl" },
    {
      id: "script-log-autoscroll",
      label: "Auto-Scroll",
      checked: opts.autoScroll,
      onSelect: opts.onToggleAutoScroll,
    },
    {
      id: "script-log-clear",
      label: "Clear Console",
      icon: makeIcon(Trash2),
      danger: true,
      disabled: opts.totalCount === 0,
      onSelect: opts.onClearConsole,
    }
  );

  return items;
}

// ============================================================================
// 5. App Shell, Breakpoints, Session Diff & TextWizard Menus
// ============================================================================

export function buildQuickFilterInputContextMenu(opts: {
  input: HTMLInputElement;
  snapshot?: EditableSelectionSnapshot;
  hasQuery: boolean;
  useRegex: boolean;
  onClearFilter: () => void;
  onToggleRegex: () => void;
  onNotify?: (msg: string) => void;
}): ContextMenuItem[] {
  const extraItems: ContextMenuItem[] = [
    {
      id: "qf-clear",
      label: "Clear Filter",
      icon: makeIcon(X),
      disabled: !opts.hasQuery,
      onSelect: opts.onClearFilter,
    },
    {
      id: "qf-regex",
      label: "Toggle RegExp",
      icon: makeIcon(Regex),
      checked: opts.useRegex,
      onSelect: opts.onToggleRegex,
    },
  ];
  return buildEditableInputMenuItems({
    target: opts.input,
    snapshot: opts.snapshot,
    extraItems,
    onNotify: opts.onNotify,
  });
}

export function buildTopToolbarContextMenu(opts: {
  compactToolbar: boolean;
  sidebarCollapsed: boolean;
  onToggleCompactToolbar?: () => void;
  onToggleSidebar: () => void;
  onResetPanelLayout?: () => void;
  onOpenAppearanceSettings: () => void;
}): ContextMenuItem[] {
  const uiColumnsMeta = getSectionMeta("settings.uiColumns");
  const settingsMeta = getSectionMeta("settings");

  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "tb-header",
      label: "Toolbar & Workspace",
    },
  ];

  if (opts.onToggleCompactToolbar) {
    items.push({
      id: "tb-slim",
      label: "Slim Toolbar",
      checked: opts.compactToolbar,
      shortcut: "Ctrl+Shift+T",
      onSelect: opts.onToggleCompactToolbar,
    });
  }

  items.push({
    id: "tb-sidebar",
    label: "Toggle Sidebar",
    icon: makeIcon(PanelLeft),
    checked: !opts.sidebarCollapsed,
    shortcut: "Ctrl+B",
    onSelect: opts.onToggleSidebar,
  });

  if (opts.onResetPanelLayout) {
    items.push(
      { type: "separator", id: "tb-sep-layout" },
      {
        id: "tb-reset-layout",
        label: "Reset Panel Layout",
        icon: makeIcon(LayoutGrid),
        onSelect: opts.onResetPanelLayout,
      }
    );
  }

  items.push({
    id: "tb-customize-ui",
    label: `Customize ${uiColumnsMeta.title}…`,
    icon: makeIcon(Settings),
    shortcut: settingsMeta.shortcut,
    onSelect: opts.onOpenAppearanceSettings,
  });

  return items;
}

export function buildSidebarContextMenu(opts: {
  targetSection?: ActiveNavSection | null;
  activeSection: ActiveNavSection;
  onOpenSection: (section: ActiveNavSection) => void;
  onOpenSettings: () => void;
  onCollapseSidebar?: () => void;
}): ContextMenuItem[] {
  const settingsMeta = getSectionMeta("settings");
  const items: ContextMenuItem[] = [];

  if (opts.targetSection) {
    const meta = getSectionMeta(opts.targetSection);
    items.push(
      {
        type: "header",
        id: "sb-target-header",
        label: meta.title,
        subtitle: truncateMenuLabel(meta.summary, 42),
      },
      {
        id: `sb-open-${opts.targetSection}`,
        label: `Open ${meta.title}`,
        shortcut: meta.shortcut,
        checked: opts.activeSection === opts.targetSection ? true : undefined,
        onSelect: () => opts.onOpenSection(opts.targetSection!),
      },
      { type: "separator", id: "sb-sep-nav" }
    );
  } else {
    const allSections: ActiveNavSection[] = [
      "traffic",
      "composer",
      "rules",
      "breakpoints",
      "scripts",
      "diff",
      "wizard",
    ];
    items.push({
      type: "header",
      id: "sb-header",
      label: "Navigation",
    });
    const sectionItems: ContextMenuActionItem[] = allSections.map((sec) => {
      const meta = getSectionMeta(sec);
      return {
        id: `sb-jump-${sec}`,
        label: meta.title,
        shortcut: meta.shortcut,
        checked: opts.activeSection === sec,
        checkVariant: "radio",
        onSelect: () => opts.onOpenSection(sec),
      };
    });
    items.push(
      ...sectionItems,
      { type: "separator", id: "sb-sep-global" }
    );
  }

  items.push({
    id: "sb-settings",
    label: `Open ${settingsMeta.title}`,
    icon: makeIcon(Settings),
    shortcut: settingsMeta.shortcut,
    onSelect: opts.onOpenSettings,
  });

  if (opts.onCollapseSidebar) {
    items.push({
      id: "sb-collapse",
      label: "Collapse Sidebar",
      icon: makeIcon(PanelLeft),
      shortcut: "Ctrl+B",
      onSelect: opts.onCollapseSidebar,
    });
  }

  return items;
}

export function buildInspectorChromeContextMenu(opts: {
  inspectorCollapsed: boolean;
  inspectorPosition: InspectorDockPosition;
  onExpandOrCollapse: () => void;
  onSetPosition: (pos: InspectorDockPosition) => void;
  onToggleSplitDirection?: () => void;
  onResetPanelLayout?: () => void;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "insp-chrome-header",
      label: "Session Inspector",
    },
    {
      id: "insp-chrome-toggle",
      label: opts.inspectorCollapsed
        ? "Expand Session Inspector"
        : "Collapse Session Inspector",
      icon: makeIcon(ArrowDownToLine),
      onSelect: opts.onExpandOrCollapse,
    },
    { type: "separator", id: "insp-chrome-sep-dock" },
    {
      id: "insp-chrome-dock-bottom",
      label: "Dock Inspector at Bottom",
      checked: opts.inspectorPosition === "bottom",
      checkVariant: "radio",
      onSelect: () => opts.onSetPosition("bottom"),
    },
    {
      id: "insp-chrome-dock-right",
      label: "Dock Inspector at Right",
      checked: opts.inspectorPosition === "right",
      checkVariant: "radio",
      onSelect: () => opts.onSetPosition("right"),
    },
  ];

  if (opts.onToggleSplitDirection) {
    items.push({
      id: "insp-chrome-split",
      label: "Toggle Request/Response Split",
      icon: makeIcon(Columns3),
      onSelect: opts.onToggleSplitDirection,
    });
  }

  if (opts.onResetPanelLayout) {
    items.push(
      { type: "separator", id: "insp-chrome-sep-reset" },
      {
        id: "insp-chrome-reset",
        label: "Reset Panel Layout",
        icon: makeIcon(LayoutGrid),
        onSelect: opts.onResetPanelLayout,
      }
    );
  }

  return items;
}

export function buildFooterContextMenu(opts: {
  proxyAddress: string;
  proxyRunning: boolean;
  systemProxyEnabled: boolean;
  onToggleCapture: () => void;
  onToggleSystemProxy: () => void;
  onCopyProxyAddress: () => void;
  onCopyCliEnv: () => void;
  onRunProxyDoctor: () => void;
  onPurgeSqlite: () => void;
}): ContextMenuItem[] {
  return [
    {
      type: "header",
      id: "footer-header",
      label: `FluxProxy · ${opts.proxyAddress}`,
    },
    {
      id: "footer-toggle-capture",
      label: opts.proxyRunning ? "Pause Capture" : "Resume Capture",
      checked: opts.proxyRunning,
      shortcut: "F12",
      onSelect: opts.onToggleCapture,
    },
    {
      id: "footer-toggle-sysproxy",
      label: "Toggle System Proxy",
      checked: opts.systemProxyEnabled,
      onSelect: opts.onToggleSystemProxy,
    },
    { type: "separator", id: "footer-sep-copy" },
    {
      id: "footer-copy-addr",
      label: `Copy Proxy Address (${opts.proxyAddress})`,
      icon: makeIcon(Copy),
      onSelect: opts.onCopyProxyAddress,
    },
    {
      id: "footer-copy-cli",
      label: "Copy CLI Proxy Env (HTTP_PROXY / HTTPS_PROXY)",
      icon: makeIcon(Terminal),
      onSelect: opts.onCopyCliEnv,
    },
    { type: "separator", id: "footer-sep-diag" },
    {
      id: "footer-doctor",
      label: "Run Proxy Doctor",
      icon: makeIcon(Stethoscope, "h-3.5 w-3.5 text-accent"),
      shortcut: "Ctrl+Shift+D",
      onSelect: opts.onRunProxyDoctor,
    },
    {
      id: "footer-purge-sqlite",
      label: "Purge SQLite Archive…",
      icon: makeIcon(Database),
      danger: true,
      onSelect: opts.onPurgeSqlite,
    },
  ];
}

export function buildBreakpointRuleContextMenu(opts: {
  rule: BreakpointRule;
  onToggleEnabled: () => void;
  onCopyPattern: () => void;
  onDelete: () => void;
}): ContextMenuItem[] {
  const { rule } = opts;
  return [
    {
      type: "header",
      id: "bp-rule-header",
      label: `${rule.stage.toUpperCase()} · ${truncateMenuLabel(rule.urlPattern, 32)}`,
    },
    {
      id: "bp-rule-toggle",
      label: rule.enabled ? "Disable Rule" : "Enable Rule",
      checked: rule.enabled,
      onSelect: opts.onToggleEnabled,
    },
    {
      id: "bp-rule-copy",
      label: "Copy Pattern",
      icon: makeIcon(Copy),
      disabled: !rule.urlPattern,
      onSelect: opts.onCopyPattern,
    },
    { type: "separator", id: "bp-rule-sep-del" },
    {
      id: "bp-rule-delete",
      label: "Delete Rule",
      icon: makeIcon(Trash2),
      danger: true,
      onSelect: opts.onDelete,
    },
  ];
}

export function buildSessionDiffHeaderContextMenu(opts: {
  leftSummary: SessionSummary;
  rightSummary: SessionSummary;
  sortKeys: boolean;
  ignoreNoise: boolean;
  sideBySide: boolean;
  wordWrap: boolean;
  onSwapPair: () => void;
  onCopyDiffHeader: () => void;
  onCopyLeft: () => void;
  onCopyRight: () => void;
  onToggleSortKeys: () => void;
  onToggleIgnoreNoise: () => void;
  onToggleSideBySide: () => void;
  onToggleWordWrap: () => void;
}): ContextMenuItem[] {
  const diffMeta = getSectionMeta("diff");
  return [
    {
      type: "header",
      id: "diff-header",
      label: `${diffMeta.title}: #${opts.leftSummary.id} ↔ #${opts.rightSummary.id}`,
    },
    {
      id: "diff-swap",
      label: "Swap A ↔ B",
      icon: makeIcon(ArrowLeftRight),
      onSelect: opts.onSwapPair,
    },
    {
      id: "diff-copy-header",
      label: "Copy Diff Header",
      icon: makeIcon(Copy),
      onSelect: opts.onCopyDiffHeader,
    },
    { type: "separator", id: "diff-sep-copy" },
    {
      id: "diff-copy-left",
      label: `Copy Session A (#${opts.leftSummary.id})`,
      icon: makeIcon(ClipboardCopy),
      onSelect: opts.onCopyLeft,
    },
    {
      id: "diff-copy-right",
      label: `Copy Session B (#${opts.rightSummary.id})`,
      icon: makeIcon(ClipboardCopy),
      onSelect: opts.onCopyRight,
    },
    { type: "separator", id: "diff-sep-opts" },
    {
      id: "diff-sort-keys",
      label: "Sort Keys",
      checked: opts.sortKeys,
      onSelect: opts.onToggleSortKeys,
    },
    {
      id: "diff-no-noise",
      label: "No-Noise",
      checked: opts.ignoreNoise,
      onSelect: opts.onToggleIgnoreNoise,
    },
    {
      id: "diff-side-by-side",
      label: "Side-by-Side Split",
      checked: opts.sideBySide,
      onSelect: opts.onToggleSideBySide,
    },
    {
      id: "diff-word-wrap",
      label: "Word Wrap",
      icon: makeIcon(WrapText),
      checked: opts.wordWrap,
      onSelect: opts.onToggleWordWrap,
    },
  ];
}

export function buildTextWizardOutputContextMenu(opts: {
  title: string;
  value: string;
  hasInput: boolean;
  onCopyOutput: () => void;
  onUseAsInput?: () => void;
  onClearInput: () => void;
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      type: "header",
      id: "tw-out-header",
      label: opts.title,
    },
    {
      id: "tw-out-copy",
      label: "Copy Output",
      icon: makeIcon(Copy),
      disabled: !opts.value,
      onSelect: opts.onCopyOutput,
    },
  ];

  if (opts.onUseAsInput) {
    items.push({
      id: "tw-out-use-input",
      label: "Use Output as Input",
      icon: makeIcon(ArrowUpDown),
      disabled: !opts.value,
      onSelect: opts.onUseAsInput,
    });
  }

  items.push(
    { type: "separator", id: "tw-out-sep-clear" },
    {
      id: "tw-out-clear-input",
      label: "Clear Input",
      icon: makeIcon(Trash2),
      danger: true,
      disabled: !opts.hasInput,
      onSelect: opts.onClearInput,
    }
  );

  return items;
}
