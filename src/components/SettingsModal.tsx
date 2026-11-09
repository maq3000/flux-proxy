import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Columns,
  Copy,
  Download,
  ExternalLink,
  FileJson,
  ListFilter,
  Plus,
  RotateCcw,
  Settings,
  Shield,
  Sliders,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { ThemePreference } from "../hooks/useTheme";
import {
  COLUMN_MIN_WIDTHS,
  DEFAULT_COLUMN_WIDTHS,
  TOOLBAR_GROUP_DEFINITIONS,
  TRAFFIC_COLUMNS,
} from "../hooks/useUiPreferences";
import {
  BUILT_IN_FILTER_PRESETS,
  compileHostListFilter,
} from "../lib/filterEngine";
import { collectCurrentSettingsProfile } from "../lib/settingsManager";
import { SESSION_RETENTION_PRESETS } from "../types/proxy";
import type {
  AutoResponderRule,
  ColumnId,
  FilterConditionRule,
  FilterPreset,
  HostListFilterConfig,
  HostListFilterMode,
  InspectorDockPosition,
  NoiseThresholdsConfig,
  ProxyFilterBackendConfig,
  ProxyStatus,
  TlsBypassRule,
  TlsInterceptMode,
  ToolbarGroupId,
} from "../types/proxy";
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  DEFAULT_SETTINGS_EXPORT_FILENAME,
  type SettingsImportPreviewSummary,
  type SettingsModalTab,
} from "../types/settings";

function attachDialogLightDismissFallback(
  dialog: HTMLDialogElement | null
): (() => void) | undefined {
  if (!dialog || "closedBy" in HTMLDialogElement.prototype) return undefined;
  const isOutside = (e: PointerEvent) => {
    const r = dialog.getBoundingClientRect();
    return (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    );
  };
  let pressedOutside = false;
  const onDown = (e: PointerEvent) => {
    pressedOutside = isOutside(e);
  };
  const onUp = (e: PointerEvent) => {
    if (pressedOutside && isOutside(e)) dialog.close();
  };
  dialog.addEventListener("pointerdown", onDown);
  dialog.addEventListener("pointerup", onUp);
  return () => {
    dialog.removeEventListener("pointerdown", onDown);
    dialog.removeEventListener("pointerup", onUp);
  };
}

export interface SettingsModalProps {
  open: boolean;
  initialTab?: SettingsModalTab;
  onClose: () => void;
  // UI & Theme
  themePreference: ThemePreference;
  onSetTheme: (theme: ThemePreference) => void;
  compactToolbar: boolean;
  onSetCompactToolbar: (compact: boolean) => void;
  sidebarCollapsed: boolean;
  onSetSidebarCollapsed: (collapsed: boolean) => void;
  inspectorCollapsed: boolean;
  onSetInspectorCollapsed: (collapsed: boolean) => void;
  inspectorPosition: InspectorDockPosition;
  onSetInspectorPosition: (pos: InspectorDockPosition) => void;
  followTail: boolean;
  onSetFollowTail: (follow: boolean) => void;
  toolbarGroups: Record<ToolbarGroupId, boolean>;
  onToggleToolbarGroup: (groupId: ToolbarGroupId) => void;
  onResetToolbarGroups: () => void;
  visibleColumns: Record<ColumnId, boolean>;
  onToggleColumnVisibility: (colId: ColumnId) => void;
  columnWidths: Record<ColumnId, number>;
  onSetColumnWidth: (colId: ColumnId, width: number) => void;
  onResetColumns: () => void;
  // Filters & Presets
  activePresetId: string | null;
  userPresets: FilterPreset[];
  onApplyPreset: (presetId: string | null) => void;
  onSaveCustomPreset: (name: string, description: string) => void;
  onDeleteCustomPreset: (presetId: string) => void;
  matrixEnabled: boolean;
  onSetMatrixEnabled: (enabled: boolean) => void;
  filterRules: FilterConditionRule[];
  noiseThresholds: NoiseThresholdsConfig;
  onSetNoiseThresholds: (
    updater:
      | NoiseThresholdsConfig
      | ((prev: NoiseThresholdsConfig) => NoiseThresholdsConfig)
  ) => void;
  hostFilters: HostListFilterConfig;
  onSetHostFilters: (
    updater:
      | HostListFilterConfig
      | ((prev: HostListFilterConfig) => HostListFilterConfig)
  ) => void;
  onResetAdvancedFilters: () => void;
  onOpenFilterDrawer: () => void;
  // Proxy, TLS, Header Mutations & Buffer
  status: ProxyStatus;
  onSetProxyPort: (port: number) => Promise<void>;
  onSetAutoSystemProxy: (auto: boolean) => Promise<void>;
  onSetAllowRemote: (allow: boolean) => Promise<void>;
  sessionRetentionLimit: number | null;
  onSetSessionRetentionLimit: (limit: number | null) => Promise<void> | void;
  dropNonMatching: boolean;
  onSetDropNonMatching: (drop: boolean) => Promise<void> | void;
  backendFilterConfig: ProxyFilterBackendConfig;
  onUpdateBackendFilterConfig: (next: ProxyFilterBackendConfig) => Promise<void>;
  onSetTlsInterceptMode: (mode: TlsInterceptMode) => Promise<void> | void;
  onOpenTlsDrawer: () => void;
  onOpenHeadersDrawer: () => void;
  // AutoResponder
  autoResponderEnabled: boolean;
  onSetAutoResponderEnabled: (enabled: boolean) => Promise<void>;
  autoResponderRules: AutoResponderRule[];
  onUpsertAutoResponderRule: (rule: AutoResponderRule) => Promise<void>;
  onDeleteAutoResponderRule: (id: string) => Promise<void>;
  onOpenAutoResponderStudio: () => void;
  // Profile Backup, Export, Import & Reset
  onExportProfile: () => Promise<void>;
  onImportProfileDialog: () => Promise<void>;
  onImportFromRawJsonText: (jsonText: string, sourceLabel?: string) => void;
  onResetAllToDefaults: () => Promise<void>;
  onNotify: (msg: string) => void;
}

const TAB_DEFINITIONS: {
  id: SettingsModalTab;
  label: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    id: "general",
    label: "General",
    subtitle: "Тема, порт, буфер",
    icon: Settings,
  },
  {
    id: "uiColumns",
    label: "UI & Columns",
    subtitle: "Тулбар и колонки",
    icon: Columns,
  },
  {
    id: "filters",
    label: "Filters",
    subtitle: "Пресеты и пороги",
    icon: ListFilter,
  },
  {
    id: "rulesProxy",
    label: "Rules & Proxy",
    subtitle: "TLS, Headers, Mocks",
    icon: Shield,
  },
  {
    id: "backupExport",
    label: "Backup & Export",
    subtitle: "JSON v1 и сброс",
    icon: FileJson,
  },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  initialTab = "general",
  onClose,
  themePreference,
  onSetTheme,
  compactToolbar,
  onSetCompactToolbar,
  sidebarCollapsed,
  onSetSidebarCollapsed,
  inspectorCollapsed,
  onSetInspectorCollapsed,
  inspectorPosition,
  onSetInspectorPosition,
  followTail,
  onSetFollowTail,
  toolbarGroups,
  onToggleToolbarGroup,
  onResetToolbarGroups,
  visibleColumns,
  onToggleColumnVisibility,
  columnWidths,
  onSetColumnWidth,
  onResetColumns,
  activePresetId,
  userPresets,
  onApplyPreset,
  onSaveCustomPreset,
  onDeleteCustomPreset,
  matrixEnabled,
  onSetMatrixEnabled,
  filterRules,
  noiseThresholds,
  onSetNoiseThresholds,
  hostFilters,
  onSetHostFilters,
  onResetAdvancedFilters,
  onOpenFilterDrawer,
  status,
  onSetProxyPort,
  onSetAutoSystemProxy,
  onSetAllowRemote,
  sessionRetentionLimit,
  onSetSessionRetentionLimit,
  dropNonMatching,
  onSetDropNonMatching,
  backendFilterConfig,
  onUpdateBackendFilterConfig,
  onSetTlsInterceptMode,
  onOpenTlsDrawer,
  onOpenHeadersDrawer,
  autoResponderEnabled,
  onSetAutoResponderEnabled,
  autoResponderRules,
  onUpsertAutoResponderRule,
  onDeleteAutoResponderRule,
  onOpenAutoResponderStudio,
  onExportProfile,
  onImportProfileDialog,
  onImportFromRawJsonText,
  onResetAllToDefaults,
  onNotify,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resetConfirmDialogRef = useRef<HTMLDialogElement>(null);
  const tabButtonRefs = useRef<Record<SettingsModalTab, HTMLButtonElement | null>>(
    {
      general: null,
      uiColumns: null,
      filters: null,
      rulesProxy: null,
      backupExport: null,
    }
  );

  const baseId = useId();
  const titleId = `${baseId}-title`;
  const resetTitleId = `${baseId}-reset-title`;

  const [activeTab, setActiveTab] = useState<SettingsModalTab>(initialTab);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);

  // Port input local draft & post-blur validation
  const [portDraft, setPortDraft] = useState<string>(() => String(status.port));
  const [portError, setPortError] = useState<string | null>(null);

  // Column width local drafts so typing doesn't jump mid-keystroke
  const [widthDrafts, setWidthDrafts] = useState<Record<ColumnId, string>>(() => {
    const init = {} as Record<ColumnId, string>;
    for (const col of TRAFFIC_COLUMNS) {
      init[col.id] = String(columnWidths[col.id] ?? col.defaultWidth);
    }
    return init;
  });

  // New Custom Filter Preset form
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [presetDescDraft, setPresetDescDraft] = useState("");
  const [presetNameError, setPresetNameError] = useState<string | null>(null);

  // Quick TLS rule addition inputs
  const [newBypassPattern, setNewBypassPattern] = useState("");
  const [newTargetPattern, setNewTargetPattern] = useState("");

  // Optional raw JSON paste area in Backup & Export
  const [rawJsonDraft, setRawJsonDraft] = useState("");
  const [copiedProfileJson, setCopiedProfileJson] = useState(false);

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
    }
  }, [open, initialTab]);

  useEffect(() => {
    setPortDraft(String(status.port));
    setPortError(null);
  }, [status.port]);

  useEffect(() => {
    const next = {} as Record<ColumnId, string>;
    for (const col of TRAFFIC_COLUMNS) {
      next[col.id] = String(columnWidths[col.id] ?? col.defaultWidth);
    }
    setWidthDrafts(next);
  }, [columnWidths]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = resetConfirmDialogRef.current;
    if (!dialog) return;
    if (confirmResetOpen) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [confirmResetOpen]);

  useEffect(() => attachDialogLightDismissFallback(dialogRef.current), []);
  useEffect(
    () => attachDialogLightDismissFallback(resetConfirmDialogRef.current),
    []
  );

  const compiledHosts = useMemo(
    () => compileHostListFilter(hostFilters),
    [hostFilters]
  );

  const isRemoteAllowed = Boolean(
    status.allowRemote || status.bindAddr === "0.0.0.0"
  );

  const validatePortString = (raw: string): number | null => {
    const clean = raw.trim();
    if (!/^\d+$/.test(clean)) return null;
    const num = Number(clean);
    if (!Number.isInteger(num) || num < 1 || num > 65535) return null;
    return num;
  };

  const handlePortSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = validatePortString(portDraft);
    if (parsed === null) {
      setPortError("Укажите корректный TCP-порт от 1 до 65535.");
      return;
    }
    setPortError(null);
    await onSetProxyPort(parsed);
  };

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    idx: number
  ) => {
    const keys = [
      "ArrowDown",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      "Home",
      "End",
    ];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    let nextIdx = idx;
    if (e.key === "Home") {
      nextIdx = 0;
    } else if (e.key === "End") {
      nextIdx = TAB_DEFINITIONS.length - 1;
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      nextIdx = (idx + 1) % TAB_DEFINITIONS.length;
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      nextIdx = (idx - 1 + TAB_DEFINITIONS.length) % TAB_DEFINITIONS.length;
    }
    const targetTab = TAB_DEFINITIONS[nextIdx];
    setActiveTab(targetTab.id);
    tabButtonRefs.current[targetTab.id]?.focus();
  };

  const commitColumnWidth = (colId: ColumnId) => {
    const min = COLUMN_MIN_WIDTHS[colId] ?? 48;
    const raw = Number(widthDrafts[colId]);
    if (!Number.isFinite(raw) || raw <= 0) {
      setWidthDrafts((prev) => ({
        ...prev,
        [colId]: String(columnWidths[colId] ?? DEFAULT_COLUMN_WIDTHS[colId]),
      }));
      return;
    }
    const clamped = Math.min(1600, Math.max(min, Math.round(raw)));
    onSetColumnWidth(colId, clamped);
    setWidthDrafts((prev) => ({ ...prev, [colId]: String(clamped) }));
  };

  const handleCreatePreset = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = presetNameDraft.trim();
    if (!cleanName) {
      setPresetNameError("Введите название пресета фильтров.");
      return;
    }
    onSaveCustomPreset(
      cleanName,
      presetDescDraft.trim() || "Пользовательский пресет фильтров"
    );
    setPresetNameDraft("");
    setPresetDescDraft("");
    setPresetNameError(null);
  };

  const handleAddTlsRule = async (
    listKind: "bypass" | "target",
    patternRaw: string
  ) => {
    const clean = patternRaw.trim();
    if (!clean) return;
    const newRule: TlsBypassRule = {
      id: `tls-${listKind}-${Date.now()}`,
      enabled: true,
      pattern: clean,
      category: "Custom",
      description:
        listKind === "bypass"
          ? "Пользовательское правило TLS Bypass"
          : "Целевой хост Selective MITM",
    };
    if (listKind === "bypass") {
      await onUpdateBackendFilterConfig({
        ...backendFilterConfig,
        tlsBypassRules: [newRule, ...backendFilterConfig.tlsBypassRules],
      });
      setNewBypassPattern("");
    } else {
      await onUpdateBackendFilterConfig({
        ...backendFilterConfig,
        tlsTargetRules: [newRule, ...backendFilterConfig.tlsTargetRules],
      });
      setNewTargetPattern("");
    }
  };

  const handleCopyCurrentProfileJson = async () => {
    try {
      const snapshot = collectCurrentSettingsProfile();
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      setCopiedProfileJson(true);
      onNotify("📋 JSON текущего профиля настроек скопирован в буфер обмена");
      window.setTimeout(() => setCopiedProfileJson(false), 2000);
    } catch {
      onNotify("⚠️ Не удалось скопировать JSON в буфер обмена");
    }
  };

  const handleConfirmReset = async () => {
    setConfirmResetOpen(false);
    await onResetAllToDefaults();
  };

  const visibleColsCount = TRAFFIC_COLUMNS.filter(
    (c) => visibleColumns[c.id]
  ).length;
  const visibleGroupsCount = TOOLBAR_GROUP_DEFINITIONS.filter(
    (g) => toolbarGroups[g.id]
  ).length;

  return (
    <>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onClose={onClose}
        {...({ closedby: "any" } as Record<string, string>)}
        className="m-auto h-[84vh] max-h-[760px] w-full max-w-4xl rounded-xl border border-strong bg-surface p-0 text-fg shadow-popover open:flex open:flex-col"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Settings className="h-4 w-4 text-accent" />
            <div>
              <h2 id={titleId} className="text-sm font-semibold text-fg">
                Preferences &amp; Settings Profile
              </h2>
              <p className="text-[11px] text-muted">
                Централизованное управление интерфейсом, фильтрами, TLS/прокси и профилем{" "}
                <code className="rounded bg-elevated px-1 py-0.5 font-mono text-[10px]">
                  schemaVersion: {CURRENT_SETTINGS_SCHEMA_VERSION}
                </code>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Закрыть окно настроек"
            className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body: Left Tablist + Right Tabpanel */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div
            role="tablist"
            aria-label="Разделы настроек FluxProxy"
            aria-orientation="vertical"
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-hairline bg-canvas p-2 md:w-52 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r"
          >
            {TAB_DEFINITIONS.map((tab, idx) => {
              const Icon = tab.icon;
              const selected = activeTab === tab.id;
              const tabId = `${baseId}-tab-${tab.id}`;
              const panelId = `${baseId}-panel-${tab.id}`;
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabButtonRefs.current[tab.id] = el;
                  }}
                  id={tabId}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={panelId}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, idx)}
                  className={`flex shrink-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                    selected
                      ? "border-accent/40 bg-selected text-fg"
                      : "border-transparent text-muted hover:bg-hover hover:text-fg"
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      selected ? "text-accent" : "text-subtle"
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold">
                      {tab.label}
                    </div>
                    <div className="hidden truncate text-[10px] text-muted md:block">
                      {tab.subtitle}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div
            id={`${baseId}-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-${activeTab}`}
            tabIndex={0}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs focus:outline-none"
          >
            {/* ==============================================================
                TAB 1: GENERAL
               ============================================================== */}
            {activeTab === "general" && (
              <>
                <fieldset className="space-y-2.5 rounded-lg border border-hairline bg-canvas p-3.5">
                  <legend className="px-1 text-xs font-semibold text-fg">
                    Цветовая схема (Theme)
                  </legend>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {(
                      [
                        {
                          value: "dark",
                          title: "Dark",
                          desc: "Тёмная палитра Zinc (по умолчанию)",
                        },
                        {
                          value: "light",
                          title: "Light",
                          desc: "Светлая высококонтрастная тема",
                        },
                        {
                          value: "system",
                          title: "System",
                          desc: "Следовать настройкам ОС",
                        },
                      ] as const
                    ).map((opt) => {
                      const radioId = `${baseId}-theme-${opt.value}`;
                      const checked = themePreference === opt.value;
                      return (
                        <label
                          key={opt.value}
                          htmlFor={radioId}
                          className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors ${
                            checked
                              ? "border-accent/50 bg-selected"
                              : "border-hairline bg-surface hover:bg-hover"
                          }`}
                        >
                          <input
                            id={radioId}
                            type="radio"
                            name={`${baseId}-theme`}
                            value={opt.value}
                            checked={checked}
                            onChange={() => onSetTheme(opt.value)}
                            className="mt-0.5 cursor-pointer accent-[var(--accent-primary)]"
                          />
                          <div>
                            <div className="font-semibold text-fg">
                              {opt.title}
                            </div>
                            <div className="text-[11px] text-muted">
                              {opt.desc}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>

                <div className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5">
                  <h3 className="text-xs font-semibold text-fg">
                    Локальный прокси-сервер и сетевые подключения
                  </h3>

                  <form
                    onSubmit={(e) => void handlePortSubmit(e)}
                    className="flex flex-wrap items-start gap-2.5"
                  >
                    <div className="flex flex-col gap-1">
                      <label
                        htmlFor={`${baseId}-proxy-port`}
                        className="text-[11px] font-medium text-muted"
                      >
                        Порт прокси-сервера (1–65535)
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          id={`${baseId}-proxy-port`}
                          type="text"
                          inputMode="numeric"
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          value={portDraft}
                          aria-invalid={portError ? "true" : undefined}
                          aria-errormessage={
                            portError ? `${baseId}-port-err` : undefined
                          }
                          onChange={(e) => {
                            setPortDraft(e.target.value);
                            if (portError) setPortError(null);
                          }}
                          onBlur={(e) => {
                            if (validatePortString(e.currentTarget.value) === null) {
                              setPortError(
                                "Укажите корректный TCP-порт от 1 до 65535."
                              );
                            }
                          }}
                          className="h-8 w-28 rounded-md border border-strong bg-surface px-2.5 font-mono text-xs text-fg tabular-nums focus:border-accent focus:outline-none"
                        />
                        <button
                          type="submit"
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent/40 bg-selected px-3 text-xs font-medium text-fg hover:brightness-110"
                        >
                          <Check className="h-3.5 w-3.5 text-accent" />
                          <span>Применить порт</span>
                        </button>
                        <span className="font-mono text-[11px] text-muted">
                          Активен: {status.bindAddr}:{status.port}
                        </span>
                      </div>
                      {portError && (
                        <span
                          id={`${baseId}-port-err`}
                          role="status"
                          aria-live="polite"
                          className="text-[11px] font-medium text-status5xx-fg"
                        >
                          {portError}
                        </span>
                      )}
                    </div>
                  </form>

                  <div className="space-y-2 border-t border-hairline pt-2.5">
                    <label
                      htmlFor={`${baseId}-auto-sysproxy`}
                      className="flex cursor-pointer items-start gap-2.5"
                    >
                      <input
                        id={`${baseId}-auto-sysproxy`}
                        type="checkbox"
                        checked={status.autoSystemProxy}
                        onChange={(e) =>
                          void onSetAutoSystemProxy(e.target.checked)
                        }
                        className="checkbox-native mt-0.5"
                      />
                      <div>
                        <div className="font-medium text-fg">
                          Автоматически включать системный прокси ОС (Act as System Proxy)
                        </div>
                        <div className="text-[11px] text-muted">
                          При запуске захвата перенаправляет системный HTTP/HTTPS трафик на{" "}
                          <code className="font-mono">127.0.0.1:{status.port}</code> и откатывает при выходе.
                        </div>
                      </div>
                    </label>

                    <label
                      htmlFor={`${baseId}-allow-remote`}
                      className="flex cursor-pointer items-start gap-2.5"
                    >
                      <input
                        id={`${baseId}-allow-remote`}
                        type="checkbox"
                        checked={isRemoteAllowed}
                        onChange={(e) => void onSetAllowRemote(e.target.checked)}
                        className="checkbox-native mt-0.5"
                      />
                      <div>
                        <div className="font-medium text-fg">
                          Разрешить подключения с удалённых устройств в LAN (0.0.0.0)
                        </div>
                        <div className="text-[11px] text-muted">
                          Открывает приём трафика для смартфонов iOS / Android и виртуальных машин в локальной сети.
                        </div>
                      </div>
                    </label>
                  </div>
                </div>

                <div className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5">
                  <h3 className="text-xs font-semibold text-fg">
                    Поток трафика и кольцевой буфер памяти
                  </h3>

                  <label
                    htmlFor={`${baseId}-follow-tail`}
                    className="flex cursor-pointer items-start gap-2.5"
                  >
                    <input
                      id={`${baseId}-follow-tail`}
                      type="checkbox"
                      checked={followTail}
                      onChange={(e) => onSetFollowTail(e.target.checked)}
                      className="checkbox-native mt-0.5"
                    />
                    <div>
                      <div className="font-medium text-fg">
                        Автопрокрутка к новым запросам (Follow Tail)
                      </div>
                      <div className="text-[11px] text-muted">
                        Автоматически удерживает нижний край таблицы при поступлении новых HTTP/WS сессий.
                      </div>
                    </div>
                  </label>

                  <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-2.5">
                    <label
                      htmlFor={`${baseId}-retention-select`}
                      className="text-[11px] font-medium text-muted"
                    >
                      Хранить сессий в RAM (Ring Buffer):
                    </label>
                    <select
                      id={`${baseId}-retention-select`}
                      value={
                        sessionRetentionLimit === null
                          ? "all"
                          : String(sessionRetentionLimit)
                      }
                      onChange={(e) => {
                        const val = e.target.value;
                        void onSetSessionRetentionLimit(
                          val === "all" ? null : Number(val)
                        );
                      }}
                      className="h-8 rounded-md border border-strong bg-surface px-2.5 font-mono text-xs text-fg"
                    >
                      <option value="all">All Sessions (Без лимита)</option>
                      {SESSION_RETENTION_PRESETS.map((preset) => (
                        <option key={preset} value={String(preset)}>
                          {preset.toLocaleString()} сессий
                        </option>
                      ))}
                      {sessionRetentionLimit !== null &&
                        !(SESSION_RETENTION_PRESETS as readonly number[]).includes(
                          sessionRetentionLimit
                        ) && (
                          <option value={String(sessionRetentionLimit)}>
                            {sessionRetentionLimit.toLocaleString()} (Custom)
                          </option>
                        )}
                    </select>
                  </div>

                  <label
                    htmlFor={`${baseId}-drop-non-matching`}
                    className="flex cursor-pointer items-start gap-2.5"
                  >
                    <input
                      id={`${baseId}-drop-non-matching`}
                      type="checkbox"
                      checked={dropNonMatching}
                      onChange={(e) =>
                        void onSetDropNonMatching(e.target.checked)
                      }
                      className="checkbox-native mt-0.5"
                    />
                    <div>
                      <div className="font-medium text-fg">
                        Отбрасывать несовпадающие с фильтром запросы при захвате (Drop Non-Matching)
                      </div>
                      <div className="text-[11px] text-muted">
                        Экономит ОЗУ на высоконагруженных стендах — отсеянные сессии не сохраняются в буфер.
                      </div>
                    </div>
                  </label>
                </div>
              </>
            )}

            {/* ==============================================================
                TAB 2: UI & COLUMNS
               ============================================================== */}
            {activeTab === "uiColumns" && (
              <>
                <div className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5">
                  <h3 className="text-xs font-semibold text-fg">
                    Компоновка рабочей области
                  </h3>

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <label
                      htmlFor={`${baseId}-compact-toolbar`}
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-hairline bg-surface p-2.5"
                    >
                      <input
                        id={`${baseId}-compact-toolbar`}
                        type="checkbox"
                        checked={compactToolbar}
                        onChange={(e) => onSetCompactToolbar(e.target.checked)}
                        className="checkbox-native"
                      />
                      <span className="font-medium text-fg">
                        Compact Toolbar
                      </span>
                    </label>

                    <label
                      htmlFor={`${baseId}-sidebar-collapsed`}
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-hairline bg-surface p-2.5"
                    >
                      <input
                        id={`${baseId}-sidebar-collapsed`}
                        type="checkbox"
                        checked={sidebarCollapsed}
                        onChange={(e) =>
                          onSetSidebarCollapsed(e.target.checked)
                        }
                        className="checkbox-native"
                      />
                      <span className="font-medium text-fg">
                        Collapse Sidebar
                      </span>
                    </label>

                    <label
                      htmlFor={`${baseId}-inspector-collapsed`}
                      className="flex cursor-pointer items-center gap-2 rounded-md border border-hairline bg-surface p-2.5"
                    >
                      <input
                        id={`${baseId}-inspector-collapsed`}
                        type="checkbox"
                        checked={inspectorCollapsed}
                        onChange={(e) =>
                          onSetInspectorCollapsed(e.target.checked)
                        }
                        className="checkbox-native"
                      />
                      <span className="font-medium text-fg">
                        Collapse Inspector
                      </span>
                    </label>
                  </div>

                  <fieldset className="space-y-2 border-t border-hairline pt-2.5">
                    <legend className="text-[11px] font-medium text-muted">
                      Позиция панели Session Inspector
                    </legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {(
                        [
                          {
                            value: "bottom",
                            label: "Снизу (Bottom Split)",
                          },
                          {
                            value: "right",
                            label: "Справа (Right Split)",
                          },
                        ] as const
                      ).map((pos) => {
                        const radioId = `${baseId}-dock-${pos.value}`;
                        const checked = inspectorPosition === pos.value;
                        return (
                          <label
                            key={pos.value}
                            htmlFor={radioId}
                            className={`flex cursor-pointer items-center gap-2 rounded-md border p-2 transition-colors ${
                              checked
                                ? "border-accent/50 bg-selected"
                                : "border-hairline bg-surface hover:bg-hover"
                            }`}
                          >
                            <input
                              id={radioId}
                              type="radio"
                              name={`${baseId}-dock-pos`}
                              value={pos.value}
                              checked={checked}
                              onChange={() => onSetInspectorPosition(pos.value)}
                              className="cursor-pointer accent-[var(--accent-primary)]"
                            />
                            <span className="font-medium text-fg">
                              {pos.label}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                </div>

                <div className="space-y-2.5 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-fg">
                        Группы верхней панели инструментов ({visibleGroupsCount}/
                        {TOOLBAR_GROUP_DEFINITIONS.length})
                      </h3>
                      <p className="text-[11px] text-muted">
                        Скрытые группы остаются доступны через меню «⋯» и сохраняются в JSON-профиль.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={onResetToolbarGroups}
                      className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-muted hover:border-strong hover:text-fg"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>Сбросить тулбар</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {TOOLBAR_GROUP_DEFINITIONS.map((grp) => {
                      const chkId = `${baseId}-tb-${grp.id}`;
                      return (
                        <label
                          key={grp.id}
                          htmlFor={chkId}
                          className="flex cursor-pointer items-start gap-2 rounded-md border border-hairline bg-surface p-2 hover:bg-hover"
                        >
                          <input
                            id={chkId}
                            type="checkbox"
                            checked={Boolean(toolbarGroups[grp.id])}
                            onChange={() => onToggleToolbarGroup(grp.id)}
                            className="checkbox-native mt-0.5"
                          />
                          <div className="min-w-0">
                            <div className="truncate font-medium text-fg">
                              {grp.label}
                            </div>
                            <div className="truncate text-[10px] text-muted">
                              {grp.description}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-2.5 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-fg">
                        Видимость и ширина колонок таблицы ({visibleColsCount}/
                        {TRAFFIC_COLUMNS.length})
                      </h3>
                      <p className="text-[11px] text-muted">
                        Настройте отображаемые столбцы и их точную ширину в пикселях.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={onResetColumns}
                      className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-muted hover:border-strong hover:text-fg"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>Сбросить колонки</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {TRAFFIC_COLUMNS.map((col) => {
                      const visId = `${baseId}-col-vis-${col.id}`;
                      const widthId = `${baseId}-col-w-${col.id}`;
                      const isVis = Boolean(visibleColumns[col.id]);
                      const disableUncheck = isVis && visibleColsCount <= 1;
                      return (
                        <div
                          key={col.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-hairline bg-surface px-2.5 py-1.5"
                        >
                          <label
                            htmlFor={visId}
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                          >
                            <input
                              id={visId}
                              type="checkbox"
                              checked={isVis}
                              disabled={disableUncheck}
                              onChange={() => onToggleColumnVisibility(col.id)}
                              className="checkbox-native"
                            />
                            <span className="truncate font-medium text-fg">
                              {col.label}
                            </span>
                            <span className="font-mono text-[10px] text-subtle">
                              ({col.id})
                            </span>
                          </label>

                          <div className="flex shrink-0 items-center gap-1">
                            <label htmlFor={widthId} className="sr-only">
                              Ширина колонки {col.label} в пикселях
                            </label>
                            <input
                              id={widthId}
                              type="number"
                              min={col.minWidth}
                              max={1600}
                              value={widthDrafts[col.id] ?? col.defaultWidth}
                              onChange={(e) =>
                                setWidthDrafts((prev) => ({
                                  ...prev,
                                  [col.id]: e.target.value,
                                }))
                              }
                              onBlur={() => commitColumnWidth(col.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitColumnWidth(col.id);
                                }
                              }}
                              className="h-6 w-16 rounded border border-strong bg-canvas px-1.5 text-right font-mono text-[11px] text-fg tabular-nums focus:border-accent focus:outline-none"
                            />
                            <span className="font-mono text-[10px] text-muted">
                              px
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            {/* ==============================================================
                TAB 3: FILTERS
               ============================================================== */}
            {activeTab === "filters" && (
              <>
                <div className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold text-fg">
                      Пресеты фильтрации ({userPresets.length} пользовательских)
                    </h3>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          dialogRef.current?.close();
                          onOpenFilterDrawer();
                        }}
                        className="inline-flex items-center gap-1 rounded border border-accent/40 bg-selected px-2.5 py-1 text-[11px] font-medium text-fg hover:brightness-110"
                      >
                        <ExternalLink className="h-3 w-3 text-accent" />
                        <span>Открыть Filter Matrix ({filterRules.length})</span>
                      </button>
                      <button
                        type="button"
                        onClick={onResetAdvancedFilters}
                        className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-muted hover:border-strong hover:text-fg"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>Сбросить фильтры</span>
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <label
                      htmlFor={`${baseId}-active-preset`}
                      className="text-[11px] font-medium text-muted"
                    >
                      Активный пресет:
                    </label>
                    <select
                      id={`${baseId}-active-preset`}
                      value={activePresetId ?? ""}
                      onChange={(e) =>
                        onApplyPreset(e.target.value ? e.target.value : null)
                      }
                      className="h-8 min-w-56 rounded-md border border-strong bg-surface px-2.5 text-xs text-fg"
                    >
                      <option value="">Без пресета (ручная настройка)</option>
                      <optgroup label="Встроенные пресеты">
                        {BUILT_IN_FILTER_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                      {userPresets.length > 0 && (
                        <optgroup label="Пользовательские пресеты">
                          {userPresets.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>

                    <label
                      htmlFor={`${baseId}-matrix-enabled`}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 py-1.5"
                    >
                      <input
                        id={`${baseId}-matrix-enabled`}
                        type="checkbox"
                        checked={matrixEnabled}
                        onChange={(e) => onSetMatrixEnabled(e.target.checked)}
                        className="checkbox-native"
                      />
                      <span className="text-[11px] font-medium text-fg">
                        Filter Matrix активна
                      </span>
                    </label>
                  </div>

                  <form
                    onSubmit={handleCreatePreset}
                    className="grid grid-cols-1 gap-2 border-t border-hairline pt-2.5 sm:grid-cols-12"
                  >
                    <div className="sm:col-span-4">
                      <label
                        htmlFor={`${baseId}-preset-name`}
                        className="mb-1 block text-[10px] font-medium text-muted"
                      >
                        Сохранить текущие фильтры как пресет
                      </label>
                      <input
                        id={`${baseId}-preset-name`}
                        type="text"
                        placeholder="Название пресета…"
                        value={presetNameDraft}
                        aria-invalid={presetNameError ? "true" : undefined}
                        onChange={(e) => {
                          setPresetNameDraft(e.target.value);
                          if (presetNameError) setPresetNameError(null);
                        }}
                        onBlur={(e) => {
                          if (
                            e.currentTarget.value.length > 0 &&
                            !e.currentTarget.value.trim()
                          ) {
                            setPresetNameError(
                              "Введите название пресета фильтров."
                            );
                          }
                        }}
                        className="h-8 w-full rounded border border-strong bg-surface px-2 text-xs text-fg"
                      />
                    </div>
                    <div className="sm:col-span-5">
                      <label
                        htmlFor={`${baseId}-preset-desc`}
                        className="mb-1 block text-[10px] font-medium text-muted"
                      >
                        Описание
                      </label>
                      <input
                        id={`${baseId}-preset-desc`}
                        type="text"
                        placeholder="Краткое описание условий…"
                        value={presetDescDraft}
                        onChange={(e) => setPresetDescDraft(e.target.value)}
                        className="h-8 w-full rounded border border-strong bg-surface px-2 text-xs text-fg"
                      />
                    </div>
                    <div className="flex items-end sm:col-span-3">
                      <button
                        type="submit"
                        className="inline-flex h-8 w-full items-center justify-center gap-1 rounded bg-sky-600 px-2.5 text-xs font-medium text-white hover:bg-sky-500"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>Сохранить</span>
                      </button>
                    </div>
                    {presetNameError && (
                      <p className="text-[11px] text-status5xx-fg sm:col-span-12">
                        {presetNameError}
                      </p>
                    )}
                  </form>

                  {userPresets.length > 0 && (
                    <div className="space-y-1 border-t border-hairline pt-2">
                      {userPresets.map((preset) => (
                        <div
                          key={preset.id}
                          className="flex items-center justify-between gap-2 rounded border border-hairline bg-surface px-2.5 py-1.5"
                        >
                          <div className="min-w-0">
                            <span className="font-medium text-fg">
                              {preset.name}
                            </span>
                            <span className="ml-2 text-[11px] text-muted">
                              ({preset.rules.length} правил) — {preset.description}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => onApplyPreset(preset.id)}
                              className="rounded border border-hairline bg-elevated px-2 py-0.5 text-[11px] text-fg hover:bg-hover"
                            >
                              Применить
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteCustomPreset(preset.id)}
                              aria-label={`Удалить пресет ${preset.name}`}
                              className="rounded p-1 text-muted hover:bg-rose-500/10 hover:text-rose-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5">
                  <h3 className="text-xs font-semibold text-fg">
                    Пороги шума и времени ответа (Noise Thresholds)
                  </h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {(
                      [
                        {
                          key: "hide304NotModified",
                          label: "Скрывать 304 Not Modified",
                        },
                        {
                          key: "hideOptionsPreflight",
                          label: "Скрывать CORS OPTIONS preflight",
                        },
                        {
                          key: "hideConnectTunnels",
                          label: "Скрывать пустые туннели CONNECT",
                        },
                        {
                          key: "hideStaticAssets",
                          label: "Скрывать статику (.css, .js, шрифты, иконки)",
                        },
                        {
                          key: "timeHeatEnabled",
                          label: "Подсветка медленных запросов (Time Heat)",
                        },
                        {
                          key: "onlySlowRequests",
                          label: "Показывать только медленные запросы",
                        },
                      ] as const
                    ).map((item) => {
                      const chkId = `${baseId}-th-${item.key}`;
                      return (
                        <label
                          key={item.key}
                          htmlFor={chkId}
                          className="flex cursor-pointer items-center gap-2 rounded border border-hairline bg-surface p-2"
                        >
                          <input
                            id={chkId}
                            type="checkbox"
                            checked={noiseThresholds[item.key]}
                            onChange={(e) =>
                              onSetNoiseThresholds((prev) => ({
                                ...prev,
                                [item.key]: e.target.checked,
                              }))
                            }
                            className="checkbox-native"
                          />
                          <span className="text-fg">{item.label}</span>
                        </label>
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 border-t border-hairline pt-2.5 sm:grid-cols-4">
                    <div>
                      <label
                        htmlFor={`${baseId}-th-warn-ms`}
                        className="mb-1 block text-[10px] text-muted"
                      >
                        Warning (ms)
                      </label>
                      <input
                        id={`${baseId}-th-warn-ms`}
                        type="number"
                        min={10}
                        max={120000}
                        value={noiseThresholds.timeHeatWarningMs}
                        onChange={(e) => {
                          const val = Math.max(
                            10,
                            Number(e.target.value) || 500
                          );
                          onSetNoiseThresholds((prev) => ({
                            ...prev,
                            timeHeatWarningMs: val,
                            timeHeatCriticalMs: Math.max(
                              prev.timeHeatCriticalMs,
                              val
                            ),
                          }));
                        }}
                        className="h-7 w-full rounded border border-strong bg-surface px-2 font-mono text-xs text-fg tabular-nums"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`${baseId}-th-crit-ms`}
                        className="mb-1 block text-[10px] text-muted"
                      >
                        Critical (ms)
                      </label>
                      <input
                        id={`${baseId}-th-crit-ms`}
                        type="number"
                        min={10}
                        max={300000}
                        value={noiseThresholds.timeHeatCriticalMs}
                        onChange={(e) => {
                          const val = Math.max(
                            noiseThresholds.timeHeatWarningMs,
                            Number(e.target.value) || 1500
                          );
                          onSetNoiseThresholds((prev) => ({
                            ...prev,
                            timeHeatCriticalMs: val,
                          }));
                        }}
                        className="h-7 w-full rounded border border-strong bg-surface px-2 font-mono text-xs text-fg tabular-nums"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`${baseId}-th-min-bytes`}
                        className="mb-1 block text-[10px] text-muted"
                      >
                        Min Body (bytes)
                      </label>
                      <input
                        id={`${baseId}-th-min-bytes`}
                        type="number"
                        min={0}
                        placeholder="Нет"
                        value={noiseThresholds.minBodySizeBytes ?? ""}
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          onSetNoiseThresholds((prev) => ({
                            ...prev,
                            minBodySizeBytes:
                              raw === ""
                                ? null
                                : Math.max(0, Math.round(Number(raw) || 0)),
                          }));
                        }}
                        className="h-7 w-full rounded border border-strong bg-surface px-2 font-mono text-xs text-fg tabular-nums"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`${baseId}-th-max-bytes`}
                        className="mb-1 block text-[10px] text-muted"
                      >
                        Max Body (bytes)
                      </label>
                      <input
                        id={`${baseId}-th-max-bytes`}
                        type="number"
                        min={0}
                        placeholder="Нет"
                        value={noiseThresholds.maxBodySizeBytes ?? ""}
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          onSetNoiseThresholds((prev) => ({
                            ...prev,
                            maxBodySizeBytes:
                              raw === ""
                                ? null
                                : Math.max(0, Math.round(Number(raw) || 0)),
                          }));
                        }}
                        className="h-7 w-full rounded border border-strong bg-surface px-2 font-mono text-xs text-fg tabular-nums"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-2.5 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label
                      htmlFor={`${baseId}-host-filter-enabled`}
                      className="inline-flex cursor-pointer items-center gap-2 font-semibold text-fg"
                    >
                      <input
                        id={`${baseId}-host-filter-enabled`}
                        type="checkbox"
                        checked={hostFilters.enabled}
                        onChange={(e) =>
                          onSetHostFilters((prev) => ({
                            ...prev,
                            enabled: e.target.checked,
                          }))
                        }
                        className="checkbox-native"
                      />
                      <span>
                        Фильтр списков доменов (Host Filters — активно токенов:{" "}
                        {compiledHosts.activeCount})
                      </span>
                    </label>

                    <label
                      htmlFor={`${baseId}-host-tls-sync`}
                      className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted"
                    >
                      <input
                        id={`${baseId}-host-tls-sync`}
                        type="checkbox"
                        checked={hostFilters.applyToTlsPassthrough}
                        onChange={(e) =>
                          onSetHostFilters((prev) => ({
                            ...prev,
                            applyToTlsPassthrough: e.target.checked,
                          }))
                        }
                        className="checkbox-native"
                      />
                      <span>Синхронизировать с TLS Passthrough</span>
                    </label>
                  </div>

                  <fieldset className="flex flex-wrap items-center gap-3">
                    <legend className="sr-only">Режим фильтрации хостов</legend>
                    {(
                      [
                        {
                          value: "whitelist",
                          label: "Whitelist (показывать только указанные)",
                        },
                        {
                          value: "blacklist",
                          label: "Blacklist (скрывать указанные)",
                        },
                      ] as { value: HostListFilterMode; label: string }[]
                    ).map((m) => {
                      const rId = `${baseId}-host-mode-${m.value}`;
                      return (
                        <label
                          key={m.value}
                          htmlFor={rId}
                          className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-fg"
                        >
                          <input
                            id={rId}
                            type="radio"
                            name={`${baseId}-host-mode`}
                            value={m.value}
                            checked={hostFilters.mode === m.value}
                            onChange={() =>
                              onSetHostFilters((prev) => ({
                                ...prev,
                                mode: m.value,
                              }))
                            }
                            className="cursor-pointer accent-[var(--accent-primary)]"
                          />
                          <span>{m.label}</span>
                        </label>
                      );
                    })}
                  </fieldset>

                  <div>
                    <label
                      htmlFor={`${baseId}-host-raw-text`}
                      className="mb-1 block text-[11px] text-muted"
                    >
                      Список доменов и масок (через перевод строки, пробел или точку с запятой, например{" "}
                      <code className="font-mono">*.api.local</code>)
                    </label>
                    <textarea
                      id={`${baseId}-host-raw-text`}
                      rows={4}
                      value={hostFilters.rawText}
                      onChange={(e) =>
                        onSetHostFilters((prev) => ({
                          ...prev,
                          rawText: e.target.value,
                        }))
                      }
                      placeholder="*.example.com&#10;api.staging.local"
                      className="w-full rounded-md border border-strong bg-surface p-2 font-mono text-xs text-fg focus:border-accent focus:outline-none"
                    />
                  </div>
                </div>
              </>
            )}

            {/* ==============================================================
                TAB 4: RULES & PROXY
               ============================================================== */}
            {activeTab === "rulesProxy" && (
              <>
                <fieldset className="space-y-2.5 rounded-lg border border-hairline bg-canvas p-3.5">
                  <legend className="px-1 text-xs font-semibold text-fg">
                    Режим расшифровки HTTPS (TLS MITM Mode)
                  </legend>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {(
                      [
                        {
                          value: "interceptAll",
                          title: "Intercept All (кроме Bypass-списка)",
                          desc: "Расшифровывает весь HTTPS трафик за исключением доменов TLS Bypass",
                        },
                        {
                          value: "targetedOnly",
                          title: "Targeted Only (Selective MITM)",
                          desc: "Расшифровывает только домены из Target Rules; остальное идёт напрямую",
                        },
                      ] as const
                    ).map((opt) => {
                      const rId = `${baseId}-tls-mode-${opt.value}`;
                      const checked =
                        backendFilterConfig.tlsInterceptMode === opt.value;
                      return (
                        <label
                          key={opt.value}
                          htmlFor={rId}
                          className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors ${
                            checked
                              ? "border-accent/50 bg-selected"
                              : "border-hairline bg-surface hover:bg-hover"
                          }`}
                        >
                          <input
                            id={rId}
                            type="radio"
                            name={`${baseId}-tls-mode`}
                            value={opt.value}
                            checked={checked}
                            onChange={() => void onSetTlsInterceptMode(opt.value)}
                            className="mt-0.5 cursor-pointer accent-[var(--accent-primary)]"
                          />
                          <div>
                            <div className="font-semibold text-fg">
                              {opt.title}
                            </div>
                            <div className="text-[11px] text-muted">
                              {opt.desc}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2.5">
                    <div className="flex flex-wrap items-center gap-3">
                      <label
                        htmlFor={`${baseId}-tls-bypass-on`}
                        className="inline-flex cursor-pointer items-center gap-1.5 text-fg"
                      >
                        <input
                          id={`${baseId}-tls-bypass-on`}
                          type="checkbox"
                          checked={backendFilterConfig.tlsBypassEnabled}
                          onChange={(e) =>
                            void onUpdateBackendFilterConfig({
                              ...backendFilterConfig,
                              tlsBypassEnabled: e.target.checked,
                            })
                          }
                          className="checkbox-native"
                        />
                        <span>TLS Bypass активен</span>
                      </label>

                      <label
                        htmlFor={`${baseId}-strip-altsvc`}
                        className="inline-flex cursor-pointer items-center gap-1.5 text-fg"
                      >
                        <input
                          id={`${baseId}-strip-altsvc`}
                          type="checkbox"
                          checked={backendFilterConfig.stripAltSvc}
                          onChange={(e) =>
                            void onUpdateBackendFilterConfig({
                              ...backendFilterConfig,
                              stripAltSvc: e.target.checked,
                            })
                          }
                          className="checkbox-native"
                        />
                        <span>Удалять Alt-Svc (блокировка ухода в QUIC/H3)</span>
                      </label>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        dialogRef.current?.close();
                        onOpenTlsDrawer();
                      }}
                      className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-fg hover:bg-hover"
                    >
                      <ExternalLink className="h-3 w-3 text-accent" />
                      <span>Полный редактор TLS…</span>
                    </button>
                  </div>
                </fieldset>

                {/* TLS Bypass & Target Rules */}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="space-y-2 rounded-lg border border-hairline bg-canvas p-3">
                    <h3 className="text-xs font-semibold text-fg">
                      TLS Bypass Rules ({backendFilterConfig.tlsBypassRules.length})
                    </h3>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleAddTlsRule("bypass", newBypassPattern);
                      }}
                      className="flex gap-1.5"
                    >
                      <label htmlFor={`${baseId}-add-bypass`} className="sr-only">
                        Добавить домен в TLS Bypass
                      </label>
                      <input
                        id={`${baseId}-add-bypass`}
                        type="text"
                        placeholder="*.apple.com"
                        value={newBypassPattern}
                        onChange={(e) => setNewBypassPattern(e.target.value)}
                        className="h-7 flex-1 rounded border border-strong bg-surface px-2 font-mono text-xs text-fg"
                      />
                      <button
                        type="submit"
                        className="inline-flex h-7 items-center gap-1 rounded bg-elevated px-2 text-[11px] font-medium text-fg hover:bg-hover"
                      >
                        <Plus className="h-3 w-3" />
                        <span>Add</span>
                      </button>
                    </form>
                    <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                      {backendFilterConfig.tlsBypassRules.map((rule) => {
                        const rChk = `${baseId}-byp-${rule.id}`;
                        return (
                          <div
                            key={rule.id}
                            className="flex items-center justify-between gap-2 rounded border border-hairline bg-surface px-2 py-1"
                          >
                            <label
                              htmlFor={rChk}
                              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5"
                            >
                              <input
                                id={rChk}
                                type="checkbox"
                                checked={rule.enabled}
                                onChange={(e) =>
                                  void onUpdateBackendFilterConfig({
                                    ...backendFilterConfig,
                                    tlsBypassRules:
                                      backendFilterConfig.tlsBypassRules.map(
                                        (x) =>
                                          x.id === rule.id
                                            ? { ...x, enabled: e.target.checked }
                                            : x
                                      ),
                                  })
                                }
                                className="checkbox-native"
                              />
                              <span className="truncate font-mono text-[11px] text-fg">
                                {rule.pattern}
                              </span>
                            </label>
                            <button
                              type="button"
                              aria-label={`Удалить правило ${rule.pattern}`}
                              onClick={() =>
                                void onUpdateBackendFilterConfig({
                                  ...backendFilterConfig,
                                  tlsBypassRules:
                                    backendFilterConfig.tlsBypassRules.filter(
                                      (x) => x.id !== rule.id
                                    ),
                                })
                              }
                              className="rounded p-0.5 text-subtle hover:text-rose-400"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-2 rounded-lg border border-hairline bg-canvas p-3">
                    <h3 className="text-xs font-semibold text-fg">
                      TLS Target Rules ({backendFilterConfig.tlsTargetRules.length})
                    </h3>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleAddTlsRule("target", newTargetPattern);
                      }}
                      className="flex gap-1.5"
                    >
                      <label htmlFor={`${baseId}-add-target`} className="sr-only">
                        Добавить целевой домен для расшифровки
                      </label>
                      <input
                        id={`${baseId}-add-target`}
                        type="text"
                        placeholder="api.myapp.dev"
                        value={newTargetPattern}
                        onChange={(e) => setNewTargetPattern(e.target.value)}
                        className="h-7 flex-1 rounded border border-strong bg-surface px-2 font-mono text-xs text-fg"
                      />
                      <button
                        type="submit"
                        className="inline-flex h-7 items-center gap-1 rounded bg-elevated px-2 text-[11px] font-medium text-fg hover:bg-hover"
                      >
                        <Plus className="h-3 w-3" />
                        <span>Add</span>
                      </button>
                    </form>
                    <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                      {backendFilterConfig.tlsTargetRules.length === 0 ? (
                        <p className="py-3 text-center text-[11px] text-subtle">
                          Список целевых MITM-хостов пуст
                        </p>
                      ) : (
                        backendFilterConfig.tlsTargetRules.map((rule) => {
                          const rChk = `${baseId}-tgt-${rule.id}`;
                          return (
                            <div
                              key={rule.id}
                              className="flex items-center justify-between gap-2 rounded border border-hairline bg-surface px-2 py-1"
                            >
                              <label
                                htmlFor={rChk}
                                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5"
                              >
                                <input
                                  id={rChk}
                                  type="checkbox"
                                  checked={rule.enabled}
                                  onChange={(e) =>
                                    void onUpdateBackendFilterConfig({
                                      ...backendFilterConfig,
                                      tlsTargetRules:
                                        backendFilterConfig.tlsTargetRules.map(
                                          (x) =>
                                            x.id === rule.id
                                              ? {
                                                  ...x,
                                                  enabled: e.target.checked,
                                                }
                                              : x
                                        ),
                                    })
                                  }
                                  className="checkbox-native"
                                />
                                <span className="truncate font-mono text-[11px] text-fg">
                                  {rule.pattern}
                                </span>
                              </label>
                              <button
                                type="button"
                                aria-label={`Удалить целевой хост ${rule.pattern}`}
                                onClick={() =>
                                  void onUpdateBackendFilterConfig({
                                    ...backendFilterConfig,
                                    tlsTargetRules:
                                      backendFilterConfig.tlsTargetRules.filter(
                                        (x) => x.id !== rule.id
                                      ),
                                  })
                                }
                                className="rounded p-0.5 text-subtle hover:text-rose-400"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>

                {/* Header Mutations */}
                <div className="space-y-2 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label
                      htmlFor={`${baseId}-hm-enabled`}
                      className="inline-flex cursor-pointer items-center gap-2 font-semibold text-fg"
                    >
                      <input
                        id={`${baseId}-hm-enabled`}
                        type="checkbox"
                        checked={backendFilterConfig.headerMutationsEnabled}
                        onChange={(e) =>
                          void onUpdateBackendFilterConfig({
                            ...backendFilterConfig,
                            headerMutationsEnabled: e.target.checked,
                          })
                        }
                        className="checkbox-native"
                      />
                      <span>
                        Header Mutations ({backendFilterConfig.headerMutations.length})
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        dialogRef.current?.close();
                        onOpenHeadersDrawer();
                      }}
                      className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-fg hover:bg-hover"
                    >
                      <ExternalLink className="h-3 w-3 text-accent" />
                      <span>Редактор мутаций заголовков…</span>
                    </button>
                  </div>

                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {backendFilterConfig.headerMutations.map((hm) => {
                      const hmChk = `${baseId}-hm-${hm.id}`;
                      return (
                        <div
                          key={hm.id}
                          className="flex items-center justify-between gap-2 rounded border border-hairline bg-surface px-2.5 py-1.5"
                        >
                          <label
                            htmlFor={hmChk}
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                          >
                            <input
                              id={hmChk}
                              type="checkbox"
                              checked={hm.enabled}
                              onChange={(e) =>
                                void onUpdateBackendFilterConfig({
                                  ...backendFilterConfig,
                                  headerMutations:
                                    backendFilterConfig.headerMutations.map(
                                      (x) =>
                                        x.id === hm.id
                                          ? { ...x, enabled: e.target.checked }
                                          : x
                                    ),
                                })
                              }
                              className="checkbox-native"
                            />
                            <span className="truncate font-medium text-fg">
                              {hm.name}
                            </span>
                            <span className="shrink-0 rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-muted">
                              {hm.direction} • {hm.operation} {hm.headerName}
                            </span>
                          </label>
                          <button
                            type="button"
                            aria-label={`Удалить мутацию ${hm.name}`}
                            onClick={() =>
                              void onUpdateBackendFilterConfig({
                                ...backendFilterConfig,
                                headerMutations:
                                  backendFilterConfig.headerMutations.filter(
                                    (x) => x.id !== hm.id
                                  ),
                              })
                            }
                            className="rounded p-0.5 text-subtle hover:text-rose-400"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* AutoResponder */}
                <div className="space-y-2 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label
                      htmlFor={`${baseId}-ar-enabled`}
                      className="inline-flex cursor-pointer items-center gap-2 font-semibold text-fg"
                    >
                      <input
                        id={`${baseId}-ar-enabled`}
                        type="checkbox"
                        checked={autoResponderEnabled}
                        onChange={(e) =>
                          void onSetAutoResponderEnabled(e.target.checked)
                        }
                        className="checkbox-native"
                      />
                      <Sliders className="h-3.5 w-3.5 text-amber-400" />
                      <span>
                        AutoResponder ({autoResponderRules.length} правил)
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        dialogRef.current?.close();
                        onOpenAutoResponderStudio();
                      }}
                      className="inline-flex items-center gap-1 rounded border border-accent/40 bg-selected px-2.5 py-1 text-[11px] font-medium text-fg hover:brightness-110"
                    >
                      <ExternalLink className="h-3 w-3 text-accent" />
                      <span>Открыть AutoResponder Studio</span>
                    </button>
                  </div>

                  <div className="max-h-36 space-y-1 overflow-y-auto">
                    {autoResponderRules.length === 0 ? (
                      <p className="py-2 text-center text-[11px] text-subtle">
                        Нет настроенных правил AutoResponder
                      </p>
                    ) : (
                      autoResponderRules.map((rule) => {
                        const arChk = `${baseId}-ar-${rule.id}`;
                        return (
                          <div
                            key={rule.id}
                            className="flex items-center justify-between gap-2 rounded border border-hairline bg-surface px-2.5 py-1.5"
                          >
                            <label
                              htmlFor={arChk}
                              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                            >
                              <input
                                id={arChk}
                                type="checkbox"
                                checked={rule.enabled}
                                onChange={(e) =>
                                  void onUpsertAutoResponderRule({
                                    ...rule,
                                    enabled: e.target.checked,
                                  })
                                }
                                className="checkbox-native"
                              />
                              <span className="truncate font-medium text-fg">
                                {rule.name}
                              </span>
                              <span className="truncate font-mono text-[10px] text-muted">
                                {rule.pattern}
                              </span>
                            </label>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-amber-400">
                                {rule.action === "delayOnly"
                                  ? `+${rule.latencyMs}ms`
                                  : `${rule.statusCode} • +${rule.latencyMs}ms`}
                              </span>
                              <button
                                type="button"
                                aria-label={`Удалить правило ${rule.name}`}
                                onClick={() =>
                                  void onDeleteAutoResponderRule(rule.id)
                                }
                                className="rounded p-0.5 text-subtle hover:text-rose-400"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </>
            )}

            {/* ==============================================================
                TAB 5: BACKUP & EXPORT
               ============================================================== */}
            {activeTab === "backupExport" && (
              <>
                <div className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-fg">
                        Экспорт и импорт единого JSON-профиля настроек
                      </h3>
                      <p className="text-[11px] text-muted">
                        Файл по умолчанию:{" "}
                        <code className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-fg">
                          {DEFAULT_SETTINGS_EXPORT_FILENAME}
                        </code>{" "}
                        • Версия схемы:{" "}
                        <code className="font-mono">
                          v{CURRENT_SETTINGS_SCHEMA_VERSION}
                        </code>
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-md border border-hairline bg-surface p-2.5">
                      <div className="text-[10px] text-muted">Колонки и UI</div>
                      <div className="mt-0.5 font-mono text-sm font-semibold text-fg tabular-nums">
                        {visibleColsCount}/{TRAFFIC_COLUMNS.length} кол.
                      </div>
                      <div className="text-[10px] text-subtle">
                        Тулбар: {visibleGroupsCount}/
                        {TOOLBAR_GROUP_DEFINITIONS.length}
                      </div>
                    </div>
                    <div className="rounded-md border border-hairline bg-surface p-2.5">
                      <div className="text-[10px] text-muted">Пресеты фильтров</div>
                      <div className="mt-0.5 font-mono text-sm font-semibold text-fg tabular-nums">
                        {userPresets.length} польз.
                      </div>
                      <div className="text-[10px] text-subtle">
                        Матрица: {filterRules.length} усл.
                      </div>
                    </div>
                    <div className="rounded-md border border-hairline bg-surface p-2.5">
                      <div className="text-[10px] text-muted">TLS &amp; Заголовки</div>
                      <div className="mt-0.5 font-mono text-sm font-semibold text-fg tabular-nums">
                        {backendFilterConfig.tlsBypassRules.length +
                          backendFilterConfig.tlsTargetRules.length}{" "}
                        TLS
                      </div>
                      <div className="text-[10px] text-subtle">
                        Headers: {backendFilterConfig.headerMutations.length}
                      </div>
                    </div>
                    <div className="rounded-md border border-hairline bg-surface p-2.5">
                      <div className="text-[10px] text-muted">AutoResponder</div>
                      <div className="mt-0.5 font-mono text-sm font-semibold text-fg tabular-nums">
                        {autoResponderRules.length} правил
                      </div>
                      <div className="text-[10px] text-subtle">
                        Статус: {autoResponderEnabled ? "Enabled" : "Disabled"}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => void onExportProfile()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-sky-600 px-3 text-xs font-semibold text-white hover:bg-sky-500"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Export Settings Profile (JSON)...</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => void onImportProfileDialog()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-strong bg-surface px-3 text-xs font-semibold text-fg hover:bg-hover"
                    >
                      <Upload className="h-3.5 w-3.5 text-accent" />
                      <span>Import Settings Profile...</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleCopyCurrentProfileJson()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-elevated px-3 text-xs text-muted hover:border-strong hover:text-fg"
                    >
                      {copiedProfileJson ? (
                        <Check className="h-3.5 w-3.5 text-status2xx-fg" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      <span>Copy JSON</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-2 rounded-lg border border-hairline bg-canvas p-3.5">
                  <label
                    htmlFor={`${baseId}-paste-json`}
                    className="block text-xs font-semibold text-fg"
                  >
                    Быстрый импорт профиля из текста JSON (с проверкой и превью)
                  </label>
                  <textarea
                    id={`${baseId}-paste-json`}
                    rows={5}
                    value={rawJsonDraft}
                    onChange={(e) => setRawJsonDraft(e.target.value)}
                    placeholder='{"schemaVersion": 1, "ui": { ... }, "filters": { ... }}'
                    className="w-full rounded-md border border-strong bg-surface p-2 font-mono text-[11px] text-fg focus:border-accent focus:outline-none"
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      disabled={!rawJsonDraft.trim()}
                      onClick={() =>
                        onImportFromRawJsonText(
                          rawJsonDraft,
                          "буфер JSON (вставленный текст)"
                        )
                      }
                      className="inline-flex h-7 items-center gap-1.5 rounded border border-accent/40 bg-selected px-3 text-xs font-medium text-fg hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <FileJson className="h-3.5 w-3.5 text-accent" />
                      <span>Проверить и открыть превью импорта…</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-2.5 rounded-lg border border-status5xx-fg/35 bg-status5xx-bg p-3.5">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status5xx-fg" />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-xs font-semibold text-fg">
                        Сброс всех настроек к заводским значениям (Reset to Defaults)
                      </h3>
                      <p className="mt-0.5 text-[11px] text-muted">
                        Восстанавливает тему, компактность и группы тулбара, ширину всех колонок,
                        пользовательские пресеты, правила фильтрации, порт прокси (8888), TLS и AutoResponder.
                      </p>
                      <button
                        type="button"
                        onClick={() => setConfirmResetOpen(true)}
                        className="mt-2.5 inline-flex h-8 items-center gap-1.5 rounded-md border border-status5xx-fg/50 bg-surface px-3 text-xs font-semibold text-status5xx-fg hover:bg-hover"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Reset to Defaults…</span>
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-hairline bg-canvas px-4 py-2.5">
          <button
            type="button"
            onClick={() => setConfirmResetOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-status5xx-fg/40 bg-surface px-2.5 text-xs font-medium text-status5xx-fg hover:bg-hover"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Reset to Defaults</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onExportProfile()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg hover:bg-hover"
            >
              <Download className="h-3.5 w-3.5 text-accent" />
              <span>Export JSON…</span>
            </button>
            <button
              type="button"
              onClick={() => void onImportProfileDialog()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg hover:bg-hover"
            >
              <Upload className="h-3.5 w-3.5 text-accent" />
              <span>Import JSON…</span>
            </button>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="inline-flex h-8 items-center rounded-md bg-accent px-3.5 text-xs font-semibold text-white hover:brightness-110"
            >
              Готово
            </button>
          </div>
        </div>
      </dialog>

      {/* Destructive Reset Confirmation Native <dialog> (autofocus on safe Cancel action) */}
      <dialog
        ref={resetConfirmDialogRef}
        aria-labelledby={resetTitleId}
        onClose={() => setConfirmResetOpen(false)}
        {...({ closedby: "any" } as Record<string, string>)}
        className="m-auto w-full max-w-md rounded-xl border border-strong bg-surface p-0 text-fg shadow-popover open:flex open:flex-col"
      >
        <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-status5xx-fg" />
          <h3 id={resetTitleId} className="text-sm font-semibold text-fg">
            Подтверждение сброса настроек
          </h3>
        </div>
        <div className="space-y-2 p-4 text-xs text-muted">
          <p className="text-fg">
            Вы действительно хотите сбросить все настройки FluxProxy к значениям по умолчанию?
          </p>
          <p>
            Пользовательские пресеты фильтров ({userPresets.length}), настроенные ширины колонок,
            конфигурация групп тулбара, правила TLS/заголовков и правила AutoResponder ({autoResponderRules.length}) будут перезаписаны заводским профилем.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-hairline bg-canvas px-4 py-2.5">
          <button
            type="button"
            autoFocus
            onClick={() => setConfirmResetOpen(false)}
            className="inline-flex h-8 items-center rounded-md border border-strong bg-surface px-3 text-xs font-semibold text-fg hover:bg-hover"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void handleConfirmReset()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-500"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Сбросить к дефолтам</span>
          </button>
        </div>
      </dialog>
    </>
  );
};

// ============================================================================
// Modal Import Preview (Presets, Rules & Columns Overwrite Summary)
// ============================================================================
export interface SettingsImportPreviewModalProps {
  preview: SettingsImportPreviewSummary | null;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}

export const SettingsImportPreviewModal: React.FC<
  SettingsImportPreviewModalProps
> = ({ preview, onCancel, onConfirm }) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (preview) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [preview]);

  useEffect(() => attachDialogLightDismissFallback(dialogRef.current), []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onCancel}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto w-full max-w-xl rounded-xl border border-strong bg-surface p-0 text-fg shadow-popover open:flex open:flex-col"
    >
      {preview && (
        <>
          <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
            <div className="flex items-center gap-2">
              <FileJson className="h-4 w-4 text-accent" />
              <div>
                <h2 id={titleId} className="text-sm font-semibold text-fg">
                  Превью импорта профиля настроек
                </h2>
                <p className="font-mono text-[11px] text-muted">
                  {preview.fileName} • schemaVersion: {preview.schemaVersion}
                  {preview.migratedFromVersion !== null
                    ? ` (мигрирован с v${preview.migratedFromVersion})`
                    : ""}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="Отменить импорт настроек"
              className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4 text-xs">
            <p className="text-muted">
              Проверьте сводку перед применением: следующие пресеты, правила фильтрации/перехвата и параметры колонок будут перезаписаны:
            </p>

            {/* Primary Overwrite Counters: Presets, Rules, Columns */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <div className="rounded-lg border border-hairline bg-canvas p-3">
                <div className="text-[11px] font-medium text-muted">
                  Пресеты фильтров
                </div>
                <div className="mt-1 font-mono text-base font-bold text-fg tabular-nums">
                  {preview.userPresetsCount} пресетов
                </div>
                <div className="mt-0.5 text-[11px] text-subtle">
                  Перезапишет текущие ({preview.currentUserPresetsCount}) • Активный:{" "}
                  <code className="font-mono">
                    {preview.activePresetId ?? "нет"}
                  </code>
                </div>
              </div>

              <div className="rounded-lg border border-hairline bg-canvas p-3">
                <div className="text-[11px] font-medium text-muted">
                  Правила прокси и моков
                </div>
                <div className="mt-1 font-mono text-base font-bold text-fg tabular-nums">
                  {preview.totalRulesCount} правил
                </div>
                <div className="mt-0.5 text-[11px] text-subtle">
                  Перезапишет текущие ({preview.currentTotalRulesCount})
                </div>
              </div>

              <div className="rounded-lg border border-hairline bg-canvas p-3">
                <div className="text-[11px] font-medium text-muted">
                  Колонки и тулбар
                </div>
                <div className="mt-1 font-mono text-base font-bold text-fg tabular-nums">
                  {preview.totalColumnsCount} колонок
                </div>
                <div className="mt-0.5 text-[11px] text-subtle">
                  Видимых: {preview.visibleColumnsCount}/{preview.totalColumnsCount} • Кастом. ширин:{" "}
                  {preview.customizedColumnWidthsCount}
                </div>
              </div>
            </div>

            {/* Detailed Breakdown */}
            <div className="space-y-1.5 rounded-lg border border-hairline bg-canvas p-3 text-[11px]">
              <div className="font-semibold text-fg">
                Детализация перезаписываемых секций:
              </div>
              <div className="grid grid-cols-1 gap-x-4 gap-y-1 text-muted sm:grid-cols-2">
                <div>
                  • Filter Matrix / Host-токены:{" "}
                  <span className="font-mono text-fg">
                    {preview.filterRulesCount} / {preview.hostFilterTokensCount}
                  </span>
                </div>
                <div>
                  • AutoResponder:{" "}
                  <span className="font-mono text-fg">
                    {preview.autoResponderRulesCount} правил (
                    {preview.autoResponderEnabled ? "On" : "Off"})
                  </span>
                </div>
                <div>
                  • TLS Bypass / Target:{" "}
                  <span className="font-mono text-fg">
                    {preview.tlsBypassRulesCount} / {preview.tlsTargetRulesCount}{" "}
                    ({preview.tlsInterceptMode})
                  </span>
                </div>
                <div>
                  • Header Mutations:{" "}
                  <span className="font-mono text-fg">
                    {preview.headerMutationsCount} правил
                  </span>
                </div>
                <div>
                  • Скрытые группы тулбара:{" "}
                  <span className="font-mono text-fg">
                    {preview.hiddenToolbarGroupsCount}
                  </span>{" "}
                  • Compact:{" "}
                  <span className="font-mono text-fg">
                    {preview.compactToolbar ? "Да" : "Нет"}
                  </span>
                </div>
                <div>
                  • Тема / Инспектор / Порт:{" "}
                  <span className="font-mono text-fg">
                    {preview.theme} / {preview.inspectorPosition} / :
                    {preview.proxyPort}
                  </span>
                </div>
              </div>
            </div>

            {preview.warnings.length > 0 && (
              <div className="space-y-1 rounded-lg border border-status4xx-fg/40 bg-status4xx-bg p-3 text-[11px] text-status4xx-fg">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    Восстановлены повреждённые поля ({preview.warnings.length}):
                  </span>
                </div>
                <ul className="list-inside list-disc space-y-0.5 text-[11px]">
                  {preview.warnings.slice(0, 6).map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                  {preview.warnings.length > 6 && (
                    <li>…и ещё {preview.warnings.length - 6} предупреждений</li>
                  )}
                </ul>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-hairline bg-canvas px-4 py-2.5">
            <button
              type="button"
              autoFocus
              onClick={onCancel}
              className="inline-flex h-8 items-center rounded-md border border-strong bg-surface px-3 text-xs font-semibold text-fg hover:bg-hover"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={() => void onConfirm()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-sky-600 px-3.5 text-xs font-semibold text-white hover:bg-sky-500"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>Импортировать и перезаписать</span>
            </button>
          </div>
        </>
      )}
    </dialog>
  );
};
