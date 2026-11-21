import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Columns,
  Database,
  Download,
  FileJson,
  ListFilter,
  RotateCcw,
  Settings,
  Shield,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { ThemePreference } from "../hooks/useTheme";
import {
  type CustomColorOverrides,
  type ThemePresetId,
  type ThemeTokenKey,
} from "../lib/themePresets";
import { compileHostListFilter } from "../lib/filterEngine";
import { proxyBridge } from "../lib/tauriBridge";
import type {
  AutoResponderRule,
  BindHostMode,
  ColumnId,
  FilterConditionRule,
  FilterPreset,
  HostListFilterConfig,
  InspectorDockPosition,
  InspectorSplitDirection,
  NetworkInterfaceInfo,
  NoiseThresholdsConfig,
  ProxyFilterBackendConfig,
  ProxyStatus,
  StorageStats,
  TlsInterceptMode,
  ToolbarGroupId,
} from "../types/proxy";
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  type SettingsImportPreviewSummary,
  type SettingsModalTab,
} from "../types/settings";
import { BackupExportSettingsTab } from "./settings/BackupExportSettingsTab";
import type { BindConfigSectionProps } from "./settings/BindConfigSection";
import { FiltersSettingsTab } from "./settings/FiltersSettingsTab";
import { GeneralSettingsTab } from "./settings/GeneralSettingsTab";
import { RulesProxySettingsTab } from "./settings/RulesProxySettingsTab";
import { UiColumnsSettingsTab } from "./settings/UiColumnsSettingsTab";

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
  themePreset?: ThemePresetId;
  customColorOverrides?: CustomColorOverrides;
  effectiveThemeTokens?: Record<ThemeTokenKey, string>;
  onSetThemePreset?: (presetId: ThemePresetId) => void;
  onSetCustomColorOverride?: (token: ThemeTokenKey, hexColor: string) => void;
  onResetCustomColorOverride?: (token: ThemeTokenKey) => void;
  onResetCustomColorOverrides?: () => void;
  compactToolbar: boolean;
  onSetCompactToolbar: (compact: boolean) => void;
  sidebarCollapsed: boolean;
  onSetSidebarCollapsed: (collapsed: boolean) => void;
  inspectorCollapsed: boolean;
  onSetInspectorCollapsed: (collapsed: boolean) => void;
  inspectorPosition: InspectorDockPosition;
  onSetInspectorPosition: (pos: InspectorDockPosition) => void;
  inspectorSplitDirection: InspectorSplitDirection;
  onSetInspectorSplitDirection: (dir: InspectorSplitDirection) => void;
  onResetPanelLayout: () => void;
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
  onSetAllowRemote?: (allow: boolean) => Promise<void>;
  onSetBindConfiguration: (
    bindMode: BindHostMode,
    specificBindIp?: string | null,
    alsoBindLoopback?: boolean
  ) => Promise<void>;
  sessionRetentionLimit: number | null;
  onSetSessionRetentionLimit: (limit: number | null) => Promise<void> | void;
  dropNonMatching: boolean;
  onSetDropNonMatching: (drop: boolean) => Promise<void> | void;
  storageStats: StorageStats;
  clearDbOnExit: boolean;
  onSetClearDbOnExit: (enabled: boolean) => Promise<boolean | void> | void;
  onClearSqliteDatabase: () => Promise<StorageStats | void> | void;
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
    label: "UI, Theme & Columns",
    subtitle: "Темы, тулбар, колонки",
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
  themePreset: themePresetProp,
  customColorOverrides: customColorOverridesProp,
  effectiveThemeTokens: effectiveThemeTokensProp,
  onSetThemePreset,
  onSetCustomColorOverride,
  onResetCustomColorOverride,
  onResetCustomColorOverrides,
  compactToolbar,
  onSetCompactToolbar,
  sidebarCollapsed,
  onSetSidebarCollapsed,
  inspectorCollapsed,
  onSetInspectorCollapsed,
  inspectorPosition,
  onSetInspectorPosition,
  inspectorSplitDirection,
  onSetInspectorSplitDirection,
  onResetPanelLayout,
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
  onSetAllowRemote: _onSetAllowRemote,
  onSetBindConfiguration,
  sessionRetentionLimit,
  onSetSessionRetentionLimit,
  dropNonMatching,
  onSetDropNonMatching,
  storageStats,
  clearDbOnExit,
  onSetClearDbOnExit,
  onClearSqliteDatabase,
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
  const purgeConfirmDialogRef = useRef<HTMLDialogElement>(null);
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
  const purgeTitleId = `${baseId}-purge-title`;

  const [activeTab, setActiveTab] = useState<SettingsModalTab>(initialTab);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [confirmPurgeSqliteOpen, setConfirmPurgeSqliteOpen] = useState(false);
  const [isPurgingSqlite, setIsPurgingSqlite] = useState(false);

  // Network interface binding selector (Loopback / AllInterfaces / Specific)
  const [networkInterfaces, setNetworkInterfaces] = useState<
    NetworkInterfaceInfo[]
  >([]);
  const [isLoadingInterfaces, setIsLoadingInterfaces] = useState(false);
  const [isApplyingBind, setIsApplyingBind] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);
  const [selectedSpecificIpDraft, setSelectedSpecificIpDraft] =
    useState<string>(() => status.specificBindIp ?? "");
  const [pendingSpecificSelect, setPendingSpecificSelect] = useState(false);

  const loadNetworkInterfaces = async () => {
    setIsLoadingInterfaces(true);
    try {
      const list = await proxyBridge.getNetworkInterfaces();
      setNetworkInterfaces(list);
      if (!selectedSpecificIpDraft) {
        const primary = list.find((iface) => iface.isPrimary) ?? list[0];
        if (primary) {
          setSelectedSpecificIpDraft(primary.ip);
        }
      }
    } catch (err) {
      console.warn("SettingsModal: getNetworkInterfaces failed", err);
    } finally {
      setIsLoadingInterfaces(false);
    }
  };

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
      setBindError(null);
      setPendingSpecificSelect(false);
      void loadNetworkInterfaces();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTab]);

  useEffect(() => {
    if (status.specificBindIp) {
      setSelectedSpecificIpDraft(status.specificBindIp);
    }
    if (status.bindMode === "specific") {
      setPendingSpecificSelect(false);
    }
  }, [status.specificBindIp, status.bindMode]);

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

  useEffect(() => {
    const dialog = purgeConfirmDialogRef.current;
    if (!dialog) return;
    if (confirmPurgeSqliteOpen) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [confirmPurgeSqliteOpen]);

  useEffect(() => attachDialogLightDismissFallback(dialogRef.current), []);
  useEffect(
    () => attachDialogLightDismissFallback(resetConfirmDialogRef.current),
    []
  );
  useEffect(
    () => attachDialogLightDismissFallback(purgeConfirmDialogRef.current),
    []
  );

  const handleConfirmPurgeSqlite = async () => {
    if (isPurgingSqlite) return;
    setIsPurgingSqlite(true);
    try {
      await onClearSqliteDatabase();
      setConfirmPurgeSqliteOpen(false);
    } finally {
      setIsPurgingSqlite(false);
    }
  };

  const compiledHosts = useMemo(
    () => compileHostListFilter(hostFilters),
    [hostFilters]
  );

  const effectiveBindMode: BindHostMode = pendingSpecificSelect
    ? "specific"
    : status.bindMode ??
      (status.allowRemote || status.bindAddr === "0.0.0.0"
        ? "all"
        : "loopback");

  const activeBoundIps = useMemo(
    () =>
      status.boundIps && status.boundIps.length > 0
        ? status.boundIps
        : [status.bindAddr],
    [status.boundIps, status.bindAddr]
  );

  const activeEndpointsSummary = useMemo(
    () => activeBoundIps.map((ip) => `${ip}:${status.port}`).join(" + "),
    [activeBoundIps, status.port]
  );

  const resolvedSpecificIpCandidate =
    selectedSpecificIpDraft ||
    status.specificBindIp ||
    networkInterfaces.find((iface) => iface.isPrimary)?.ip ||
    networkInterfaces[0]?.ip ||
    "";

  const sysProxyTargetHost =
    effectiveBindMode === "specific" &&
    resolvedSpecificIpCandidate &&
    status.alsoBindLoopback === false
      ? resolvedSpecificIpCandidate
      : "127.0.0.1";

  const handleBindModeChange = async (nextMode: BindHostMode) => {
    setBindError(null);
    if (nextMode === "specific") {
      setPendingSpecificSelect(true);
      const candidateIp =
        selectedSpecificIpDraft ||
        status.specificBindIp ||
        networkInterfaces.find((iface) => iface.isPrimary)?.ip ||
        networkInterfaces[0]?.ip;

      if (!candidateIp) {
        if (networkInterfaces.length === 0) {
          await loadNetworkInterfaces();
        }
        return;
      }

      setSelectedSpecificIpDraft(candidateIp);
      setIsApplyingBind(true);
      try {
        await onSetBindConfiguration(
          "specific",
          candidateIp,
          status.alsoBindLoopback ?? true
        );
        setPendingSpecificSelect(false);
      } catch (err) {
        setBindError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsApplyingBind(false);
      }
      return;
    }

    setPendingSpecificSelect(false);
    setIsApplyingBind(true);
    try {
      await onSetBindConfiguration(
        nextMode,
        status.specificBindIp ?? null,
        status.alsoBindLoopback ?? true
      );
    } catch (err) {
      setBindError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsApplyingBind(false);
    }
  };

  const handleSpecificIpChange = async (nextIp: string) => {
    setSelectedSpecificIpDraft(nextIp);
    setBindError(null);
    if (!nextIp) return;
    setIsApplyingBind(true);
    try {
      await onSetBindConfiguration(
        "specific",
        nextIp,
        status.alsoBindLoopback ?? true
      );
      setPendingSpecificSelect(false);
    } catch (err) {
      setBindError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsApplyingBind(false);
    }
  };

  const handleAlsoBindLoopbackChange = async (checked: boolean) => {
    const targetIp =
      selectedSpecificIpDraft ||
      status.specificBindIp ||
      networkInterfaces.find((iface) => iface.isPrimary)?.ip ||
      networkInterfaces[0]?.ip ||
      "";
    if (!targetIp) {
      setBindError("Сначала выберите IP-адрес интерфейса.");
      return;
    }
    setBindError(null);
    setIsApplyingBind(true);
    try {
      await onSetBindConfiguration("specific", targetIp, checked);
    } catch (err) {
      setBindError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsApplyingBind(false);
    }
  };

  const bindConfigProps: Omit<BindConfigSectionProps, "sectionKey"> = {
    baseId,
    status,
    effectiveBindMode,
    activeBoundIps,
    resolvedSpecificIpCandidate,
    networkInterfaces,
    isLoadingInterfaces,
    isApplyingBind,
    bindError,
    onBindModeChange: handleBindModeChange,
    onSpecificIpChange: handleSpecificIpChange,
    onAlsoBindLoopbackChange: handleAlsoBindLoopbackChange,
    onReloadInterfaces: loadNetworkInterfaces,
  };

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    idx: number
  ) => {
    const keys = [
      "ArrowDown",
      "ArrowUp",
      "ArrowLeft",
      "ArrowRight",
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

  const handleConfirmReset = async () => {
    setConfirmResetOpen(false);
    await onResetAllToDefaults();
  };

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
              <GeneralSettingsTab
                baseId={baseId}
                themePreference={themePreference}
                onSetTheme={onSetTheme}
                followTail={followTail}
                onSetFollowTail={onSetFollowTail}
                status={status}
                activeEndpointsSummary={activeEndpointsSummary}
                sysProxyTargetHost={sysProxyTargetHost}
                onSetProxyPort={onSetProxyPort}
                onSetAutoSystemProxy={onSetAutoSystemProxy}
                sessionRetentionLimit={sessionRetentionLimit}
                onSetSessionRetentionLimit={onSetSessionRetentionLimit}
                dropNonMatching={dropNonMatching}
                onSetDropNonMatching={onSetDropNonMatching}
                clearDbOnExit={clearDbOnExit}
                onSetClearDbOnExit={onSetClearDbOnExit}
                storageStats={storageStats}
                isPurgingSqlite={isPurgingSqlite}
                setConfirmPurgeSqliteOpen={setConfirmPurgeSqliteOpen}
                bindConfigProps={bindConfigProps}
              />
            )}

            {activeTab === "uiColumns" && (
              <UiColumnsSettingsTab
                baseId={baseId}
                themePreference={themePreference}
                onSetTheme={onSetTheme}
                themePreset={themePresetProp}
                customColorOverrides={customColorOverridesProp}
                effectiveThemeTokens={effectiveThemeTokensProp}
                onSetThemePreset={onSetThemePreset}
                onSetCustomColorOverride={onSetCustomColorOverride}
                onResetCustomColorOverride={onResetCustomColorOverride}
                onResetCustomColorOverrides={onResetCustomColorOverrides}
                compactToolbar={compactToolbar}
                onSetCompactToolbar={onSetCompactToolbar}
                sidebarCollapsed={sidebarCollapsed}
                onSetSidebarCollapsed={onSetSidebarCollapsed}
                inspectorCollapsed={inspectorCollapsed}
                onSetInspectorCollapsed={onSetInspectorCollapsed}
                inspectorPosition={inspectorPosition}
                onSetInspectorPosition={onSetInspectorPosition}
                inspectorSplitDirection={inspectorSplitDirection}
                onSetInspectorSplitDirection={onSetInspectorSplitDirection}
                onResetPanelLayout={onResetPanelLayout}
                toolbarGroups={toolbarGroups}
                onToggleToolbarGroup={onToggleToolbarGroup}
                onResetToolbarGroups={onResetToolbarGroups}
                visibleColumns={visibleColumns}
                onToggleColumnVisibility={onToggleColumnVisibility}
                columnWidths={columnWidths}
                onSetColumnWidth={onSetColumnWidth}
                onResetColumns={onResetColumns}
              />
            )}

            {activeTab === "filters" && (
              <FiltersSettingsTab
                baseId={baseId}
                activePresetId={activePresetId}
                userPresets={userPresets}
                onApplyPreset={onApplyPreset}
                onSaveCustomPreset={onSaveCustomPreset}
                onDeleteCustomPreset={onDeleteCustomPreset}
                matrixEnabled={matrixEnabled}
                onSetMatrixEnabled={onSetMatrixEnabled}
                filterRules={filterRules}
                noiseThresholds={noiseThresholds}
                onSetNoiseThresholds={onSetNoiseThresholds}
                hostFilters={hostFilters}
                compiledHosts={compiledHosts}
                onSetHostFilters={onSetHostFilters}
                onResetAdvancedFilters={onResetAdvancedFilters}
                onOpenFilterDrawer={onOpenFilterDrawer}
                onCloseDialog={() => dialogRef.current?.close()}
              />
            )}

            {activeTab === "rulesProxy" && (
              <RulesProxySettingsTab
                bindConfigProps={bindConfigProps}
                backendFilterConfig={backendFilterConfig}
                onUpdateBackendFilterConfig={onUpdateBackendFilterConfig}
                onSetTlsInterceptMode={onSetTlsInterceptMode}
                onOpenTlsDrawer={onOpenTlsDrawer}
                onOpenHeadersDrawer={onOpenHeadersDrawer}
                autoResponderEnabled={autoResponderEnabled}
                onSetAutoResponderEnabled={onSetAutoResponderEnabled}
                autoResponderRules={autoResponderRules}
                onUpsertAutoResponderRule={onUpsertAutoResponderRule}
                onDeleteAutoResponderRule={onDeleteAutoResponderRule}
                onOpenAutoResponderStudio={onOpenAutoResponderStudio}
                onCloseDialog={() => dialogRef.current?.close()}
              />
            )}

            {activeTab === "backupExport" && (
              <BackupExportSettingsTab
                baseId={baseId}
                visibleColumns={visibleColumns}
                toolbarGroups={toolbarGroups}
                userPresets={userPresets}
                filterRules={filterRules}
                autoResponderEnabled={autoResponderEnabled}
                autoResponderRules={autoResponderRules}
                backendFilterConfig={backendFilterConfig}
                onExportProfile={onExportProfile}
                onImportProfileDialog={onImportProfileDialog}
                onImportFromRawJsonText={onImportFromRawJsonText}
                onRequestResetAll={() => setConfirmResetOpen(true)}
                onNotify={onNotify}
              />
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

      {/* SQLite Purge & VACUUM Confirmation Native <dialog> (autofocus on safe Cancel action) */}
      <dialog
        ref={purgeConfirmDialogRef}
        aria-labelledby={purgeTitleId}
        onClose={() => {
          if (!isPurgingSqlite) setConfirmPurgeSqliteOpen(false);
        }}
        {...({ closedby: "any" } as Record<string, string>)}
        className="m-auto w-full max-w-md rounded-xl border border-strong bg-surface p-0 text-fg shadow-popover open:flex open:flex-col"
      >
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-status5xx-fg" />
            <h2 id={purgeTitleId} className="text-sm font-semibold text-fg">
              Очистить и сжать архив SQLite?
            </h2>
          </div>
          <button
            type="button"
            disabled={isPurgingSqlite}
            onClick={() => setConfirmPurgeSqliteOpen(false)}
            className="rounded p-1 text-muted hover:bg-hover hover:text-fg disabled:opacity-45"
            aria-label="Закрыть подтверждение очистки SQLite"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-2 px-4 py-3 text-xs text-fg">
          <p>
            Все сохранённые на диске сессии и выгруженные тела запросов/ответов в{" "}
            <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[11px]">
              sessions.sqlite
            </code>{" "}
            будут безвозвратно удалены, после чего выполнится{" "}
            <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[11px]">
              VACUUM
            </code>{" "}
            и усечение WAL-журнала.
          </p>
          <p className="text-[11px] text-muted">
            Текущий размер на диске:{" "}
            <strong className="font-semibold text-fg">
              {(storageStats.sqliteSizeBytes / (1024 * 1024)).toFixed(2)} MB
            </strong>{" "}
            ({storageStats.sqliteSizeBytes.toLocaleString("en-US")} байт). Сессии в
            текущей таблице ОЗУ ({storageStats.ramSessions.toLocaleString("en-US")}{" "}
            шт.) затронуты не будут.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-hairline bg-canvas/50 px-4 py-2.5">
          <button
            type="button"
            autoFocus
            disabled={isPurgingSqlite}
            onClick={() => setConfirmPurgeSqliteOpen(false)}
            className="rounded border border-strong bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:bg-hover disabled:opacity-45"
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={isPurgingSqlite}
            onClick={() => void handleConfirmPurgeSqlite()}
            className="inline-flex items-center gap-1.5 rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>
              {isPurgingSqlite ? "Очистка и VACUUM..." : "Очистить и сжать (VACUUM)"}
            </span>
          </button>
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
  onConfirm: (options?: {
    trustImportedPythonScript?: boolean;
  }) => Promise<void> | void;
}

export const SettingsImportPreviewModal: React.FC<
  SettingsImportPreviewModalProps
> = ({ preview, onCancel, onConfirm }) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const trustCheckboxId = useId();
  const [trustPythonScript, setTrustPythonScript] = useState(false);

  useEffect(() => {
    setTrustPythonScript(false);
  }, [preview]);

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
                    {preview.themePreset ?? preview.theme}
                    {preview.customColorOverridesCount
                      ? ` (+${preview.customColorOverridesCount} цв.)`
                      : ""}{" "}
                    / {preview.inspectorPosition} (
                    {preview.inspectorSplitDirection}) / :{preview.proxyPort}
                  </span>
                </div>
              </div>
            </div>

            {preview.hasPythonScript && (
              <div
                className={
                  preview.pythonScriptEnabledInProfile
                    ? "space-y-2 rounded-lg border border-status5xx-fg/50 bg-status5xx-bg p-3 text-[11px] text-status5xx-fg"
                    : "space-y-1.5 rounded-lg border border-status4xx-fg/40 bg-status4xx-bg p-3 text-[11px] text-status4xx-fg"
                }
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="font-semibold">
                      {preview.pythonScriptEnabledInProfile
                        ? `Профиль содержит активный Python-скрипт (${preview.pythonScriptLineCount} строк)`
                        : `Профиль содержит Python-скрипт (${preview.pythonScriptLineCount} строк, выключен)`}
                    </div>
                    <p className="leading-relaxed opacity-90">
                      {preview.pythonScriptEnabledInProfile
                        ? "Python-скрипты выполняются локально с правами текущего пользователя ОС. Для защиты от скрытого RCE скрипт будет загружен в редактор в выключенном состоянии (enabled = false)."
                        : "Проверьте код в редакторе Scripting перед его ручным включением."}
                    </p>
                    {preview.pythonScriptEnabledInProfile && (
                      <label
                        htmlFor={trustCheckboxId}
                        className="flex cursor-pointer items-start gap-2 pt-1 font-medium text-fg select-none"
                      >
                        <input
                          id={trustCheckboxId}
                          type="checkbox"
                          checked={trustPythonScript}
                          onChange={(e) =>
                            setTrustPythonScript(e.target.checked)
                          }
                          className="checkbox-native mt-0.5"
                        />
                        <span>
                          Я проверил код и доверяю источнику профиля — сразу
                          включить Python-скрипт после импорта
                        </span>
                      </label>
                    )}
                  </div>
                </div>
              </div>
            )}

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
              onClick={() =>
                void onConfirm({
                  trustImportedPythonScript: Boolean(
                    preview.pythonScriptEnabledInProfile && trustPythonScript
                  ),
                })
              }
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