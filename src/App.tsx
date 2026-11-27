import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, BarChart3, BarChartHorizontal, Database, Gauge, Globe, Network, Stethoscope, Table2, Trash2, Upload, WifiOff, X } from "lucide-react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import { AutoResponderPanel } from "./components/AutoResponderPanel";
import { BreakpointBanner } from "./components/BreakpointBanner";
import type { BreakpointsPanelMode } from "./components/BreakpointsPanel";
import { CertificateModal } from "./components/CertificateModal";
import { CodeSnippetModal } from "./components/CodeSnippetModal";
import { CollapsedInspectorBar } from "./components/CollapsedInspectorBar";
import {
  CommandPalette,
  type PaletteCommand,
} from "./components/CommandPalette";
import { ComposerPanel } from "./components/ComposerPanel";
import { MenuBar } from "./components/MenuBar";
import { SessionAnnotationModal } from "./components/SessionAnnotationModal";
import { SessionInspector } from "./components/SessionInspector";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { Sidebar } from "./components/Sidebar";
import type { TextWizardTab } from "./components/TextWizardPanel";
import { TopToolbar } from "./components/TopToolbar";
import { TrafficGrid } from "./components/TrafficGrid";
import {
  TrafficStatisticsModal,
  type TrafficStatisticsScope,
} from "./components/TrafficStatisticsModal";
import { WaterfallTimeline } from "./components/WaterfallTimeline";
import { ContextMenuProvider } from "./components/ui/ContextMenu";
import { SectionHeader } from "./components/ui/SectionHeader";
import { useContextMenu, type ContextMenuEventLike } from "./hooks/useContextMenu";
import {
  buildEditableInputMenuItems,
  buildFooterContextMenu,
  buildInspectorChromeContextMenu,
  buildSelectionContextMenuItems,
  buildTrafficEmptyContextMenu,
  buildTrafficRowContextMenu,
  captureEditableSelection,
  copyTextToClipboard,
  findEditableTextTarget,
  getActiveReadOnlySelection,
  shouldPreserveNativeContextMenu,
} from "./lib/contextMenuBuilders";

const BreakpointsPanel = React.lazy(() =>
  import("./components/BreakpointsPanel").then((m) => ({
    default: m.BreakpointsPanel,
  }))
);
const OpenApiExportModal = React.lazy(() =>
  import("./components/OpenApiExportModal").then((m) => ({
    default: m.OpenApiExportModal,
  }))
);
const SanitizedExportModal = React.lazy(() =>
  import("./components/SanitizedExportModal").then((m) => ({
    default: m.SanitizedExportModal,
  }))
);
const ScriptingPanel = React.lazy(() =>
  import("./components/ScriptingPanel").then((m) => ({
    default: m.ScriptingPanel,
  }))
);
const SessionDiffView = React.lazy(() =>
  import("./components/SessionDiffView").then((m) => ({
    default: m.SessionDiffView,
  }))
);
const SettingsImportPreviewModal = React.lazy(() =>
  import("./components/SettingsModal").then((m) => ({
    default: m.SettingsImportPreviewModal,
  }))
);
const SettingsModal = React.lazy(() =>
  import("./components/SettingsModal").then((m) => ({
    default: m.SettingsModal,
  }))
);
const TextWizardPanel = React.lazy(() =>
  import("./components/TextWizardPanel").then((m) => ({
    default: m.TextWizardPanel,
  }))
);
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useProxySessions } from "./hooks/useProxySessions";
import { useTheme } from "./hooks/useTheme";
import {
  FLUX_PANEL_AUTOSAVE_IDS,
  FLUX_PANEL_LAYOUT_RESET_EVENT,
  SAFE_PANEL_STORAGE,
  readPersistedPanelLayouts,
  useUiPreferences,
} from "./hooks/useUiPreferences";
import {
  requestFromComposedRequest,
  requestFromSessionDetail,
  type CodeGenRequest,
} from "./lib/codeGenerators";
import { buildCurlCommand, buildHeadersBlock } from "./lib/formatters";
import { DEFAULT_PYTHON_SCRIPT_CODE } from "./lib/mockTraffic";
import {
  applySettingsProfile,
  buildSettingsImportPreview,
  exportCurrentSettingsProfile,
  isLikelyFluxSettingsProfile,
  loadPersistedSanitizationOptions,
  parseAndValidateSettingsJsonText,
  registerLiveSettingsSnapshotGetter,
  resetAllSettingsToDefault,
  SETTINGS_APPLIED_EVENT,
  SETTINGS_STORAGE_KEYS,
} from "./lib/settingsManager";
import { getSectionMeta } from "./lib/sectionRegistry";
import { isTauriRuntime, proxyBridge } from "./lib/tauriBridge";
import { useProxyStore } from "./stores/proxyStore";
import { useUiStore } from "./stores/uiStore";
import { THEME_PRESETS } from "./lib/themePresets";
import { THROTTLE_PRESET_DEFINITIONS } from "./types/proxy";
import type {
  ActiveNavSection,
  AutoResponderRule,
  ComposedRequest,
  HeaderMutationDirection,
  HeaderMutationOp,
  HeaderMutationRule,
  PythonScriptPreset,
  SessionDetail,
  SessionSummary,
  ThrottleConfig,
  UpstreamProxyConfig,
  UpstreamTimeoutConfig,
} from "./types/proxy";
import type {
  FluxUserSettingsProfile,
  SettingsImportPreviewSummary,
  SettingsModalSubTab,
  SettingsModalTab,
} from "./types/settings";

const AppContent: React.FC = () => {
  const { openContextMenu, closeContextMenu } = useContextMenu();
  const {
    preference,
    resolvedTheme,
    themePreset,
    customColorOverrides,
    effectiveTokens,
    setTheme,
    setThemePreset,
    setCustomColorOverride,
    resetCustomColorOverride,
    resetCustomColorOverrides,
  } = useTheme();
  const {
    compactToolbar,
    setCompactToolbar,
    toggleCompactToolbar,
    sidebarCollapsed,
    setSidebarCollapsed,
    inspectorCollapsed,
    inspectorPosition,
    inspectorSplitDirection,
    resolvedInspectorSplitDirection,
    toggleSidebar,
    setInspectorCollapsed,
    toggleInspector,
    setInspectorPosition,
    setInspectorSplitDirection,
    toggleInspectorSplitDirection,
    resetPanelLayouts,
    toolbarGroups,
    toggleToolbarGroup,
    setToolbarGroupVisible,
    resetToolbarGroups,
    visibleColumns,
    toggleColumnVisibility,
    columnWidths,
    setColumnWidth,
    resetColumns,
    resetAllUiPreferences,
  } = useUiPreferences();

  const {
    sessions,
    filteredSessions,
    selectedId,
    setSelectedId,
    selectedIds,
    toggleSessionSelection,
    selectSessionRange,
    selectSessions,
    compareWithSession,
    setComparePairIds,
    swapCompareSessions,
    selectedDetail,
    diffLeftDetail,
    diffRightDetail,
    markedSessionsCount,
    annotateSessions,
    unmarkSessions,
    deleteSessions,
    replaySessions,
    status,
    filterQuery,
    setFilterQuery,
    useRegex,
    setUseRegex,
    regexError,
    quickCategory,
    setQuickCategory,
    followTail,
    setFollowTail,
    toastMessage,
    showToast,
    matrixEnabled,
    setMatrixEnabled,
    filterRules,
    setFilterRules,
    ruleErrors,
    thresholds,
    setThresholds,
    hostListFilter,
    setHostListFilter,
    compiledHostList,
    customPresets,
    allPresets,
    activePreset,
    activePresetId,
    applyPreset,
    saveCustomPreset,
    deleteCustomPreset,
    resetAdvancedFilters,
    backendFilterConfig,
    updateBackendFilterConfig,
    detectedProcesses,
    quickFilterByProcess,
    quickFilterByClientIp,
    setTlsInterceptMode,
    toggleTlsInterceptMode,
    quickAlwaysInspectHost,
    quickAlwaysPassthroughHost,
    quickAddTlsBypassHost,
    updateLanClientAllowlist,
    addLanClientToAllowlist,
    isForceNoCacheActive,
    toggleForceNoCache,
    activeFilterBadgeCount,
    breakpointConfig,
    pausedBreakpoints,
    updateBreakpointConfig,
    toggleBreakBeforeRequest,
    toggleBreakAfterResponse,
    disableAllBreakpoints,
    applyQuickExecBpu,
    resolvePausedBreakpoint,
    resumeAllBreakpoints,
    sessionRetentionLimit,
    setSessionRetentionLimit,
    dropNonMatching,
    setDropNonMatching,
    toggleDropNonMatching,
    storageStats,
    clearDbOnExit,
    setClearDbOnExit,
    clearSqliteDatabase,
    toggleProxy,
    setProxyPort,
    setBindConfiguration,
    setAllowRemote,
    toggleAllowRemote,
    toggleSystemProxy,
    setAutoSystemProxy,
    toggleAutoSystemProxy,
    clearAllSessions,
    saveToSqlite,
    loadFromSqlite,
    exportAllSessionsAs,
    exportSelectedSessionsAs,
    exportSanitizedSessions,
    importArchiveDialog,
    importArchiveFromPath,
    importArchiveFromDroppedFile,
    saveSessionBodyAs,
    generateStress10k,
  } = useProxySessions();

  const searchInputRef = useRef<HTMLInputElement>(null);
  const trafficGridRef = useRef<HTMLDivElement>(null);
  const inspectorContainerRef = useRef<HTMLDivElement>(null);
  const sortedSessionsRef = useRef<SessionSummary[]>(filteredSessions);
  const bottomInnerGroupRef = useRef<ImperativePanelGroupHandle>(null);
  const rightGroupRef = useRef<ImperativePanelGroupHandle>(null);

  const handleSelectAllSessions = useCallback(
    (explicitIds?: number[]) => {
      const ids =
        explicitIds ??
        (sortedSessionsRef.current.length === filteredSessions.length
          ? sortedSessionsRef.current.map((s) => s.id)
          : filteredSessions.map((s) => s.id));
      if (ids.length === 0) return;
      setActiveSection("traffic");
      selectSessions(ids);
    },
    [filteredSessions, selectSessions]
  );

  const activeSection = useUiStore((s) => s.activeSection);
  const setActiveSection = useUiStore((s) => s.setActiveSection);
  const [visitedSections, setVisitedSections] = useState<
    Record<ActiveNavSection, boolean>
  >({
    traffic: true,
    composer: false,
    rules: false,
    breakpoints: false,
    scripts: false,
    diff: false,
    wizard: false,
  });

  useEffect(() => {
    setVisitedSections((prev) =>
      prev[activeSection] ? prev : { ...prev, [activeSection]: true }
    );
  }, [activeSection]);
  const [composerDraft, setComposerDraft] = useState<ComposedRequest | null>(
    null
  );
  const autoResponderEnabled = useProxyStore((s) => s.autoResponderEnabled);
  const setAutoResponderEnabled = useProxyStore(
    (s) => s.setAutoResponderEnabled
  );
  const rules = useProxyStore((s) => s.rules);
  const setRules = useProxyStore((s) => s.setRules);
  const scriptCode = useProxyStore((s) => s.scriptCode);
  const setScriptCode = useProxyStore((s) => s.setScriptCode);
  const scriptEnabled = useProxyStore((s) => s.scriptEnabled);
  const setScriptEnabled = useProxyStore((s) => s.setScriptEnabled);
  const scriptActivePresetId = useProxyStore((s) => s.scriptActivePresetId);
  const setScriptActivePresetId = useProxyStore(
    (s) => s.setScriptActivePresetId
  );
  const pythonRunnerStatus = useProxyStore((s) => s.pythonRunnerStatus);
  const setPythonRunnerStatus = useProxyStore((s) => s.setPythonRunnerStatus);
  const scriptConsoleLogs = useProxyStore((s) => s.scriptConsoleLogs);
  const setScriptConsoleLogs = useProxyStore((s) => s.setScriptConsoleLogs);
  const isApplyingScript = useProxyStore((s) => s.isApplyingScript);
  const setIsApplyingScript = useProxyStore((s) => s.setIsApplyingScript);
  const hostRemapRules = useProxyStore((s) => s.hostRemapRules);
  const setHostRemapRules = useProxyStore((s) => s.setHostRemapRules);
  const throttleConfig = useProxyStore((s) => s.throttleConfig);
  const setThrottleConfig = useProxyStore((s) => s.setThrottleConfig);
  const upstreamProxyConfig = useProxyStore((s) => s.upstreamProxyConfig);
  const setUpstreamProxyConfig = useProxyStore(
    (s) => s.setUpstreamProxyConfig
  );
  const upstreamTimeouts = useProxyStore((s) => s.upstreamTimeouts);
  const setUpstreamTimeouts = useProxyStore((s) => s.setUpstreamTimeouts);
  const activeHostRemapCount = useMemo(
    () => hostRemapRules.filter((r) => r.enabled).length,
    [hostRemapRules]
  );
  const upstreamProxyActiveLabel = useMemo(
    () =>
      upstreamProxyConfig.enabled && upstreamProxyConfig.host.trim()
        ? `${upstreamProxyConfig.protocol.toUpperCase()} ${upstreamProxyConfig.host.trim()}:${upstreamProxyConfig.port}`
        : null,
    [upstreamProxyConfig]
  );
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] =
    useState<SettingsModalTab>("general");
  const [settingsInitialSubTab, setSettingsInitialSubTab] =
    useState<SettingsModalSubTab | undefined>(undefined);
  const [settingsNavSeq, setSettingsNavSeq] = useState(0);
  const [caRefreshKey, setCaRefreshKey] = useState(0);
  const [activeClientCertsCount, setActiveClientCertsCount] = useState(0);
  const [pendingImportState, setPendingImportState] = useState<{
    profile: FluxUserSettingsProfile;
    preview: SettingsImportPreviewSummary;
  } | null>(null);
  const [certModalOpen, setCertModalOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void proxyBridge
      .listClientCertificates()
      .then((list) => {
        if (active) {
          setActiveClientCertsCount(list.filter((c) => c.enabled).length);
        }
      })
      .catch(() => {
        // ignore if runtime does not provide client certificate store
      });
    return () => {
      active = false;
    };
  }, []);

  const handleSaveUpstreamProxyConfig = useCallback(
    async (nextCfg: UpstreamProxyConfig) => {
      const saved = await proxyBridge.setUpstreamProxyConfig(nextCfg);
      setUpstreamProxyConfig(saved);
      if (saved.enabled && saved.host.trim()) {
        showToast(
          `🌐 Upstream Proxy: ${saved.protocol.toUpperCase()} ${saved.host}:${saved.port}`
        );
      } else {
        showToast("🔌 Upstream Proxy отключён (прямое подключение)");
      }
    },
    [setUpstreamProxyConfig, showToast]
  );

  const handleSaveUpstreamTimeouts = useCallback(
    async (nextTimeouts: UpstreamTimeoutConfig) => {
      const saved = await proxyBridge.setUpstreamTimeouts(nextTimeouts);
      setUpstreamTimeouts(saved);
      const ttfbText =
        saved.responseHeaderTimeoutSec === 0
          ? "Unlimited"
          : `${saved.responseHeaderTimeoutSec}s`;
      const composerText =
        saved.composerTimeoutSec === 0
          ? "Unlimited"
          : `${saved.composerTimeoutSec}s`;
      showToast(
        `⏱️ Таймауты обновлены: Connect ${saved.connectTimeoutSec}s • TTFB ${ttfbText} • Composer ${composerText}`
      );
    },
    [setUpstreamTimeouts, showToast]
  );

  const handleChangeThrottleConfig = useCallback(
    async (nextCfg: ThrottleConfig) => {
      try {
        const saved = await proxyBridge.setThrottleConfig(nextCfg);
        setThrottleConfig(saved);
        if (saved.preset === "offline") {
          showToast("⛔ Сеть переведена в режим Offline (HTTP 503)");
        } else if (saved.preset === "none") {
          showToast("⚡ Bandwidth Throttling отключён (полная скорость)");
        } else {
          const def = THROTTLE_PRESET_DEFINITIONS.find(
            (d) => d.id === saved.preset
          );
          const label = def ? def.label : saved.preset;
          showToast(
            `🐢 Профиль сети: ${label} (↓${saved.downloadKbps} / ↑${saved.uploadKbps} Kbps · ${saved.latencyMs} ms)`
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast(`⚠️ Не удалось применить Bandwidth Throttling: ${msg}`);
      }
    },
    [setThrottleConfig, showToast]
  );

  // Sync persisted Virtual DNS (HOSTS Remapping) & Bandwidth Throttling to backend on boot
  useEffect(() => {
    let active = true;
    const syncNetworkSimulationOnBoot = async () => {
      try {
        const currentRules = useProxyStore.getState().hostRemapRules;
        if (currentRules.length > 0) {
          const savedRules = await proxyBridge.updateHostRemapRules(
            currentRules
          );
          if (active) setHostRemapRules(savedRules);
        } else {
          const backendRules = await proxyBridge.getHostRemapRules();
          if (active && backendRules.length > 0) {
            setHostRemapRules(backendRules);
          }
        }
      } catch {
        // best-effort sync on boot
      }
      try {
        const currentThrottle = useProxyStore.getState().throttleConfig;
        if (currentThrottle.preset !== "none") {
          const savedCfg = await proxyBridge.setThrottleConfig(currentThrottle);
          if (active) setThrottleConfig(savedCfg);
        } else {
          const backendCfg = await proxyBridge.getThrottleConfig();
          if (active && backendCfg.preset !== "none") {
            setThrottleConfig(backendCfg);
          }
        }
      } catch {
        // best-effort sync on boot
      }
      try {
        const currentUpstream = useProxyStore.getState().upstreamProxyConfig;
        if (currentUpstream.enabled && currentUpstream.host.trim()) {
          const savedUpstream = await proxyBridge.setUpstreamProxyConfig({
            ...currentUpstream,
            password: undefined,
          });
          if (active) setUpstreamProxyConfig(savedUpstream);
        } else {
          const backendUpstream = await proxyBridge.getUpstreamProxyConfig();
          if (
            active &&
            ((backendUpstream.enabled && backendUpstream.host.trim()) ||
              backendUpstream.hasPassword)
          ) {
            setUpstreamProxyConfig(backendUpstream);
          }
        }
      } catch {
        // best-effort sync on boot
      }
      try {
        const backendTimeouts = await proxyBridge.getUpstreamTimeouts();
        if (active) setUpstreamTimeouts(backendTimeouts);
      } catch {
        // best-effort sync on boot
      }
    };
    void syncNetworkSimulationOnBoot();
    return () => {
      active = false;
    };
  }, [
    setHostRemapRules,
    setThrottleConfig,
    setUpstreamProxyConfig,
    setUpstreamTimeouts,
  ]);
  const [sanitizedExportModalOpen, setSanitizedExportModalOpen] =
    useState(false);
  const [openApiModalOpen, setOpenApiModalOpen] = useState(false);
  const [openApiSelectedIds, setOpenApiSelectedIds] = useState<number[]>([]);
  const [openApiAllIds, setOpenApiAllIds] = useState<number[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);
  const [trafficViewMode, setTrafficViewMode] = useState<"grid" | "waterfall">(
    "grid"
  );
  const [trafficStatsModalOpen, setTrafficStatsModalOpen] = useState(false);
  const [trafficStatsInitialScope, setTrafficStatsInitialScope] =
    useState<TrafficStatisticsScope>("filtered");
  const [hexTriggerSeq, setHexTriggerSeq] = useState(0);
  const [statisticsTriggerSeq, setStatisticsTriggerSeq] = useState(0);
  const [customRetentionTriggerSeq, setCustomRetentionTriggerSeq] = useState(0);

  const openTrafficStatisticsModal = useCallback(
    (scope: TrafficStatisticsScope = "filtered") => {
      setTrafficStatsInitialScope(scope);
      setTrafficStatsModalOpen(true);
    },
    []
  );

  const handleSetTrafficViewMode = useCallback(
    (mode: "grid" | "waterfall") => {
      setActiveSection("traffic");
      setTrafficViewMode(mode);
    },
    [setActiveSection]
  );

  // Session Diff & User Annotations (Comment / Mark) State
  const [annotationModalOpen, setAnnotationModalOpen] = useState(false);
  const [annotationTargetIds, setAnnotationTargetIds] = useState<number[]>([]);
  const [diffTabPairIds, setDiffTabPairIds] = useState<[number, number] | null>(
    null
  );
  const [diffTabDetails, setDiffTabDetails] = useState<{
    left: SessionDetail | null;
    right: SessionDetail | null;
  }>({ left: null, right: null });
  const [inlineDiffDismissed, setInlineDiffDismissed] = useState(false);
  const [codeSnippetModalOpen, setCodeSnippetModalOpen] = useState(false);
  const [codeSnippetRequest, setCodeSnippetRequest] =
    useState<CodeGenRequest | null>(null);

  // Drag-and-Drop Archive & Settings Profile Import (.har, .saz, .json) State
  const [fileDropActive, setFileDropActive] = useState(false);
  const [fileDropLabel, setFileDropLabel] = useState<string | null>(null);
  const htmlDragDepthRef = useRef(0);

  const openPreferencesAt = useCallback(
    (tab: SettingsModalTab = "general", subTab?: SettingsModalSubTab) => {
      setSettingsInitialTab(tab);
      setSettingsInitialSubTab(subTab);
      setSettingsNavSeq((n) => n + 1);
      setSettingsModalOpen(true);
    },
    []
  );

  const togglePreferencesMain = useCallback(() => {
    if (settingsModalOpen) {
      setSettingsModalOpen(false);
      return;
    }
    openPreferencesAt("general");
  }, [openPreferencesAt, settingsModalOpen]);

  const togglePreferencesAt = useCallback(
    (tab: SettingsModalTab, subTab?: SettingsModalSubTab) => {
      if (
        settingsModalOpen &&
        settingsInitialTab === tab &&
        (subTab === undefined || settingsInitialSubTab === subTab)
      ) {
        setSettingsModalOpen(false);
        return;
      }
      openPreferencesAt(tab, subTab);
    },
    [
      openPreferencesAt,
      settingsInitialSubTab,
      settingsInitialTab,
      settingsModalOpen,
    ]
  );

  const handleOpenTimeoutSettings = useCallback(() => {
    openPreferencesAt("networkRouting", "timeouts");
  }, [openPreferencesAt]);

  const openImportPreviewFromJsonText = useCallback(
    (jsonText: string, fileName: string) => {
      try {
        const report = parseAndValidateSettingsJsonText(jsonText);
        const preview = buildSettingsImportPreview(report.profile, {
          fileName,
          warnings: report.warnings,
          migratedFromVersion: report.migratedFromVersion,
        });
        setPendingImportState({
          profile: report.profile,
          preview,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(`⚠️ Ошибка профиля настроек (${fileName}): ${message}`);
      }
    },
    [showToast]
  );

  const handleExportSettingsProfile = useCallback(async () => {
    try {
      const exported = await exportCurrentSettingsProfile();
      if (exported) {
        showToast(
          `💾 Профиль настроек сохранён (schemaVersion: ${exported.schemaVersion})`
        );
      }
    } catch (err) {
      showToast(
        `⚠️ Не удалось экспортировать настройки: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }, [showToast]);

  const handleImportSettingsProfileDialog = useCallback(async () => {
    try {
      const chosenPath = await proxyBridge.pickOpenFileDialog({
        title: "Import FluxProxy Settings Profile (.json)",
        filters: [
          {
            name: "FluxProxy Settings Profile (*.json)",
            extensions: ["json"],
          },
          { name: "All Files (*.*)", extensions: ["*"] },
        ],
      });
      if (!chosenPath) return;
      const baseName = chosenPath.split(/[\\/]/).pop() ?? chosenPath;
      const jsonText = await proxyBridge.readSettingsJsonFile(chosenPath);
      openImportPreviewFromJsonText(jsonText, baseName);
    } catch (err) {
      showToast(
        `⚠️ Ошибка чтения файла настроек: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }, [openImportPreviewFromJsonText, showToast]);

  const handleConfirmImportSettingsProfile = useCallback(
    async (options?: { trustImportedPythonScript?: boolean }) => {
      if (!pendingImportState) return;
      const { profile, preview } = pendingImportState;
      const trustScript = Boolean(options?.trustImportedPythonScript);
      try {
        await applySettingsProfile(profile, {
          trustImportedPythonScript: trustScript,
        });
        setPendingImportState(null);
        const scriptNotice =
          preview.hasPythonScript &&
          preview.pythonScriptEnabledInProfile &&
          !trustScript
            ? " (Python-скрипт загружен выключенным в целях безопасности)"
            : "";
        showToast(
          `✅ Профиль настроек применён: пресетов ${preview.userPresetsCount}, правил ${preview.totalRulesCount}, колонок ${preview.visibleColumnsCount}/${preview.totalColumnsCount}${scriptNotice}`
        );
      } catch (err) {
        showToast(
          `⚠️ Ошибка применения профиля настроек: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    },
    [pendingImportState, showToast]
  );

  const handleResetAllSettings = useCallback(
    async (skipConfirm = true) => {
      try {
        const didReset = await resetAllSettingsToDefault({ skipConfirm });
        if (didReset) {
          showToast(
            "🔄 Все настройки FluxProxy сброшены к значениям по умолчанию"
          );
        }
      } catch (err) {
        showToast(
          `⚠️ Не удалось сбросить настройки: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    },
    [showToast]
  );

  const handleResetBottomInnerGroup = useCallback(() => {
    bottomInnerGroupRef.current?.setLayout(
      inspectorCollapsed ? [100] : [54, 46]
    );
  }, [inspectorCollapsed]);

  const handleResetRightGroup = useCallback(() => {
    rightGroupRef.current?.setLayout(inspectorCollapsed ? [100] : [56, 44]);
  }, [inspectorCollapsed]);

  const handleResetPanelLayout = useCallback(() => {
    resetPanelLayouts();
    showToast("📐 Размеры сплит-панелей сброшены к значениям по умолчанию");
  }, [resetPanelLayouts, showToast]);

  useEffect(() => {
    const onResetPanels = () => {
      handleResetBottomInnerGroup();
      handleResetRightGroup();
    };
    window.addEventListener(FLUX_PANEL_LAYOUT_RESET_EVENT, onResetPanels);
    return () => {
      window.removeEventListener(FLUX_PANEL_LAYOUT_RESET_EVENT, onResetPanels);
    };
  }, [handleResetBottomInnerGroup, handleResetRightGroup]);

  useEffect(() => {
    let mounted = true;
    let unlistenDrop: (() => void) | null = null;

    void proxyBridge
      .subscribeNativeFileDrop((payload) => {
        if (!mounted) return;
        if (payload.type === "enter") {
          const supported = payload.paths.filter((p) =>
            /\.(har|saz|json)$/i.test(p)
          );
          if (supported.length > 0 || payload.paths.length > 0) {
            const names = (supported.length > 0 ? supported : payload.paths)
              .map((p) => p.split(/[\\/]/).pop() ?? p)
              .join(", ");
            setFileDropLabel(names);
            setFileDropActive(true);
          }
        } else if (payload.type === "leave") {
          setFileDropActive(false);
          setFileDropLabel(null);
        } else if (payload.type === "drop") {
          setFileDropActive(false);
          setFileDropLabel(null);
          const supported = payload.paths.filter((p) =>
            /\.(har|saz|json)$/i.test(p)
          );
          if (supported.length === 0) {
            showToast(
              "⚠️ Перетащите архив .har, .saz (Fiddler Classic) или профиль .json"
            );
            return;
          }
          void (async () => {
            for (const filePath of supported) {
              const baseName = filePath.split(/[\\/]/).pop() ?? filePath;
              if (/\.json$/i.test(filePath)) {
                try {
                  const text = await proxyBridge.readSettingsJsonFile(filePath);
                  if (/fluxproxy[-_]?settings/i.test(baseName)) {
                    openImportPreviewFromJsonText(text, baseName);
                    continue;
                  }
                  const parsed = JSON.parse(text) as unknown;
                  if (isLikelyFluxSettingsProfile(parsed)) {
                    openImportPreviewFromJsonText(text, baseName);
                    continue;
                  }
                } catch {
                  if (/fluxproxy[-_]?settings/i.test(baseName)) {
                    showToast(
                      `⚠️ Невалидный JSON в файле настроек ${baseName}`
                    );
                    continue;
                  }
                }
              }
              setActiveSection("traffic");
              await importArchiveFromPath(filePath);
            }
          })();
        }
      })
      .then((fn) => {
        if (mounted) {
          unlistenDrop = fn;
        } else {
          fn();
        }
      });

    return () => {
      mounted = false;
      if (unlistenDrop) unlistenDrop();
    };
  }, [importArchiveFromPath, openImportPreviewFromJsonText, showToast]);

  const isExternalArchiveDrag = useCallback(
    (dt: DataTransfer | null): boolean => {
      if (!dt) return false;
      const types = Array.from(dt.types);
      return (
        types.includes("Files") &&
        !types.includes("application/x-fluxproxy-session-id")
      );
    },
    []
  );

  const handleRootDragEnter = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!isExternalArchiveDrag(e.dataTransfer)) return;
      e.preventDefault();
      if (!isTauriRuntime()) {
        htmlDragDepthRef.current += 1;
        setFileDropActive(true);
      }
    },
    [isExternalArchiveDrag]
  );

  const handleRootDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!isExternalArchiveDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [isExternalArchiveDrag]
  );

  const handleRootDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!isExternalArchiveDrag(e.dataTransfer)) return;
      if (!isTauriRuntime()) {
        htmlDragDepthRef.current = Math.max(0, htmlDragDepthRef.current - 1);
        if (htmlDragDepthRef.current === 0) {
          setFileDropActive(false);
          setFileDropLabel(null);
        }
      }
    },
    [isExternalArchiveDrag]
  );

  const handleRootDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!isExternalArchiveDrag(e.dataTransfer)) return;
      e.preventDefault();
      htmlDragDepthRef.current = 0;
      setFileDropActive(false);
      setFileDropLabel(null);

      // In Tauri desktop runtime, `onDragDropEvent` handles OS file paths directly from disk
      if (isTauriRuntime()) return;

      const files = Array.from(e.dataTransfer.files);
      const supported = files.filter((f) => /\.(har|saz|json)$/i.test(f.name));
      if (supported.length === 0) {
        showToast(
          "⚠️ Перетащите архив .har, .saz (Fiddler Classic) или профиль .json"
        );
        return;
      }
      void (async () => {
        for (const file of supported) {
          if (/\.json$/i.test(file.name)) {
            try {
              const text = await file.text();
              if (/fluxproxy[-_]?settings/i.test(file.name)) {
                openImportPreviewFromJsonText(text, file.name);
                continue;
              }
              const parsed = JSON.parse(text) as unknown;
              if (isLikelyFluxSettingsProfile(parsed)) {
                openImportPreviewFromJsonText(text, file.name);
                continue;
              }
            } catch {
              if (/fluxproxy[-_]?settings/i.test(file.name)) {
                showToast(`⚠️ Невалидный JSON в файле настроек ${file.name}`);
                continue;
              }
            }
          }
          setActiveSection("traffic");
          await importArchiveFromDroppedFile(file);
        }
      })();
    },
    [
      importArchiveFromDroppedFile,
      isExternalArchiveDrag,
      openImportPreviewFromJsonText,
      showToast,
    ]
  );

  const effectiveSelectedIds = useMemo(
    () =>
      selectedIds.length > 0
        ? selectedIds
        : selectedId !== null
          ? [selectedId]
          : [],
    [selectedId, selectedIds]
  );

  const selectedPairKey =
    selectedIds.length === 2 ? `${selectedIds[0]}:${selectedIds[1]}` : "";
  useEffect(() => {
    if (selectedPairKey) {
      setInlineDiffDismissed(false);
      setDiffTabPairIds([selectedIds[0], selectedIds[1]]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPairKey]);

  // Clear saved Session Diff pair only if either session was removed/cleared
  useEffect(() => {
    if (!diffTabPairIds) return;
    const [leftId, rightId] = diffTabPairIds;
    const hasLeft = sessions.some((s) => s.id === leftId);
    const hasRight = sessions.some((s) => s.id === rightId);
    if (!hasLeft || !hasRight) {
      setDiffTabPairIds(null);
      setDiffTabDetails({ left: null, right: null });
    }
  }, [diffTabPairIds, sessions]);

  // Keep Session Diff tab details loaded even when user clicks a single session in Traffic
  useEffect(() => {
    if (!diffTabPairIds) {
      setDiffTabDetails({ left: null, right: null });
      return;
    }
    const [leftId, rightId] = diffTabPairIds;
    if (
      diffLeftDetail?.summary.id === leftId &&
      diffRightDetail?.summary.id === rightId
    ) {
      setDiffTabDetails({ left: diffLeftDetail, right: diffRightDetail });
      return;
    }
    let active = true;
    void Promise.all([
      proxyBridge.getSessionDetail(leftId),
      proxyBridge.getSessionDetail(rightId),
    ])
      .then(([left, right]) => {
        if (!active) return;
        setDiffTabDetails({ left, right });
      })
      .catch(() => {
        if (!active) return;
        setDiffTabDetails({ left: null, right: null });
      });
    return () => {
      active = false;
    };
  }, [diffLeftDetail, diffRightDetail, diffTabPairIds]);

  const resolvedDiffTabLeftDetail =
    diffTabPairIds && diffLeftDetail?.summary.id === diffTabPairIds[0]
      ? diffLeftDetail
      : diffTabDetails.left;
  const resolvedDiffTabRightDetail =
    diffTabPairIds && diffRightDetail?.summary.id === diffTabPairIds[1]
      ? diffRightDetail
      : diffTabDetails.right;

  const handleSelectDiffTabPair = useCallback(
    (leftId: number, rightId: number) => {
      if (leftId === rightId) return;
      setDiffTabPairIds([leftId, rightId]);
      setComparePairIds(leftId, rightId);
    },
    [setComparePairIds]
  );

  const handleSwapDiffTabPair = useCallback(() => {
    setDiffTabPairIds((prev) => (prev ? [prev[1], prev[0]] : prev));
    if (selectedIds.length >= 2) {
      swapCompareSessions();
    }
  }, [selectedIds.length, swapCompareSessions]);

  const annotationTargetSessions = useMemo(() => {
    if (annotationTargetIds.length === 0) return [];
    const idSet = new Set(annotationTargetIds);
    return sessions.filter((s) => idSet.has(s.id));
  }, [annotationTargetIds, sessions]);

  // TextWizard Panel State (tab-scoped, preserved across switches)
  const [textWizardTab, setTextWizardTab] = useState<TextWizardTab>("jwt");
  const [textWizardInput, setTextWizardInput] = useState<string | undefined>(
    undefined
  );
  const [textWizardRequestSeq, setTextWizardRequestSeq] = useState(0);

  // Live Breakpoints Panel State (tab-scoped, non-blocking)
  const [bpPanelMode, setBpPanelMode] =
    useState<BreakpointsPanelMode>("intercept");
  const [selectedBpId, setSelectedBpId] = useState<string | null>(null);
  const [bpRequestSeq, setBpRequestSeq] = useState(0);
  const lastAutoOpenedBpRef = useRef<string | null>(null);

  const persistAutoResponderStorage = useCallback(
    (enabledVal: boolean, rulesVal: AutoResponderRule[]) => {
      try {
        window.localStorage.setItem(
          SETTINGS_STORAGE_KEYS.autoResponder,
          JSON.stringify({ enabled: enabledVal, rules: rulesVal })
        );
      } catch {
        // ignore storage quota errors
      }
    },
    []
  );

  const handleSetAutoResponderEnabled = useCallback(
    async (nextEnabled: boolean) => {
      try {
        const applied = await proxyBridge.setAutoResponderEnabled(nextEnabled);
        setAutoResponderEnabled(applied);
        persistAutoResponderStorage(applied, rules);
        showToast(
          applied
            ? "▶ AutoResponder включён"
            : "⏸ AutoResponder отключён глобально"
        );
      } catch (err) {
        showToast(
          `⚠️ Не удалось переключить AutoResponder: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    },
    [persistAutoResponderStorage, rules, showToast]
  );

  useEffect(() => {
    let active = true;

    const initAutoResponder = async () => {
      try {
        const rawStored = window.localStorage.getItem(
          SETTINGS_STORAGE_KEYS.autoResponder
        );
        if (rawStored) {
          const parsed = JSON.parse(rawStored) as {
            enabled?: boolean;
            rules?: AutoResponderRule[];
          };
          if (parsed && Array.isArray(parsed.rules)) {
            const enabledFlag =
              typeof parsed.enabled === "boolean" ? parsed.enabled : true;
            const syncedRules = await proxyBridge.setAutoResponderConfig(
              enabledFlag,
              parsed.rules
            );
            if (!active) return;
            setAutoResponderEnabled(enabledFlag);
            setRules(syncedRules);
            return;
          }
        }
      } catch {
        // fallback to backend defaults
      }

      try {
        const [initialEnabled, initialRules] = await Promise.all([
          proxyBridge.getAutoResponderEnabled(),
          proxyBridge.listRules(),
        ]);
        if (!active) return;
        setAutoResponderEnabled(initialEnabled);
        setRules(initialRules);
        persistAutoResponderStorage(initialEnabled, initialRules);
      } catch (err) {
        if (!active) return;
        showToast(
          `⚠️ Не удалось загрузить состояние AutoResponder: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    };

    void initAutoResponder();

    const onSettingsApplied = (event: Event) => {
      const detail = (event as CustomEvent<FluxUserSettingsProfile>).detail;
      if (!detail?.autoResponder) return;
      setAutoResponderEnabled(Boolean(detail.autoResponder.enabled));
      setRules(structuredClone(detail.autoResponder.rules));
    };

    window.addEventListener(SETTINGS_APPLIED_EVENT, onSettingsApplied);
    return () => {
      active = false;
      window.removeEventListener(SETTINGS_APPLIED_EVENT, onSettingsApplied);
    };
  }, [persistAutoResponderStorage, showToast]);

  const persistPythonScriptStorage = useCallback(
    (enabledVal: boolean, codeVal: string, presetIdVal: string | null) => {
      try {
        window.localStorage.setItem(
          SETTINGS_STORAGE_KEYS.pythonScript,
          JSON.stringify({
            enabled: enabledVal,
            code: codeVal,
            activePresetId: presetIdVal,
          })
        );
      } catch {
        // ignore storage quota errors
      }
    },
    []
  );

  const handleApplyPythonScript = useCallback(
    async (nextCode: string, nextEnabled: boolean) => {
      setIsApplyingScript(true);
      try {
        const nextStatus = await proxyBridge.setPythonScript(
          nextCode,
          nextEnabled
        );
        setPythonRunnerStatus(nextStatus);
        const appliedEnabled = nextStatus.isSimulator
          ? nextEnabled
          : nextStatus.enabled;
        setScriptCode(nextCode);
        setScriptEnabled(appliedEnabled);
        persistPythonScriptStorage(
          appliedEnabled,
          nextCode,
          scriptActivePresetId
        );
        if (nextStatus.lastError) {
          showToast("⚠️ Ошибка в Python-скрипте — см. консоль скрипта");
        } else if (nextStatus.isSimulator) {
          showToast(
            appliedEnabled
              ? "🐍 Скрипт сохранён (Browser Preview Simulator)"
              : "⏸ Python-скрипт отключён (Simulator)"
          );
        } else {
          showToast(
            appliedEnabled
              ? "✅ Python-скрипт применён к MITM-прокси"
              : "⏸ Python-скрипт отключён"
          );
        }
      } catch (err) {
        showToast(
          `⚠️ Не удалось применить Python-скрипт: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } finally {
        setIsApplyingScript(false);
      }
    },
    [persistPythonScriptStorage, scriptActivePresetId, showToast]
  );

  const handleTogglePythonScript = useCallback(
    async (nextEnabled: boolean) => {
      await handleApplyPythonScript(scriptCode, nextEnabled);
    },
    [handleApplyPythonScript, scriptCode]
  );

  const handleRefreshPythonStatus = useCallback(async () => {
    try {
      const nextStatus = await proxyBridge.getPythonRunnerStatus();
      setPythonRunnerStatus(nextStatus);
    } catch (err) {
      showToast(
        `⚠️ Не удалось проверить Python: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }, [showToast]);

  const handleSelectPythonPreset = useCallback(
    (preset: PythonScriptPreset) => {
      setScriptCode(preset.code);
      setScriptActivePresetId(preset.id);
      persistPythonScriptStorage(scriptEnabled, preset.code, preset.id);
      showToast(`Загружен шаблон «${preset.name}» — нажмите Apply Script`);
    },
    [persistPythonScriptStorage, scriptEnabled, showToast]
  );

  useEffect(() => {
    let active = true;
    let unlistenLogs: (() => void) | null = null;

    const initScripting = async () => {
      let initialCode = DEFAULT_PYTHON_SCRIPT_CODE;
      let initialEnabled = false;
      let initialPresetId: string | null = "hmac-header-injection";
      try {
        const rawStored = window.localStorage.getItem(
          SETTINGS_STORAGE_KEYS.pythonScript
        );
        if (rawStored) {
          const parsed = JSON.parse(rawStored) as {
            enabled?: unknown;
            code?: unknown;
            activePresetId?: unknown;
          };
          if (parsed && typeof parsed === "object") {
            if (typeof parsed.code === "string") {
              initialCode = parsed.code;
            }
            if (typeof parsed.enabled === "boolean") {
              initialEnabled = parsed.enabled;
            }
            if (
              parsed.activePresetId === null ||
              typeof parsed.activePresetId === "string"
            ) {
              initialPresetId = parsed.activePresetId;
            }
          }
        }
      } catch {
        // fallback to default script
      }

      if (!active) return;
      setScriptCode(initialCode);
      setScriptEnabled(initialEnabled);
      setScriptActivePresetId(initialPresetId);

      try {
        const nextStatus = await proxyBridge.setPythonScript(
          initialCode,
          initialEnabled
        );
        if (!active) return;
        setPythonRunnerStatus(nextStatus);
        if (!nextStatus.isSimulator) {
          setScriptEnabled(nextStatus.enabled);
        }
      } catch {
        try {
          const fallbackStatus = await proxyBridge.getPythonRunnerStatus();
          if (active) setPythonRunnerStatus(fallbackStatus);
        } catch {
          // ignore status fallback error on boot
        }
      }
    };

    void proxyBridge
      .subscribeScriptConsoleLogs((entry) => {
        if (!active) return;
        setScriptConsoleLogs((prev) => {
          const next = [...prev, entry];
          return next.length > 500 ? next.slice(next.length - 500) : next;
        });
      })
      .then((fn) => {
        if (active) {
          unlistenLogs = fn;
        } else {
          fn();
        }
      });

    void initScripting();

    const onSettingsApplied = (event: Event) => {
      const detail = (event as CustomEvent<FluxUserSettingsProfile>).detail;
      if (!detail?.scripting) return;
      setScriptEnabled(Boolean(detail.scripting.enabled));
      setScriptCode(detail.scripting.code);
      setScriptActivePresetId(detail.scripting.activePresetId ?? null);
      void proxyBridge
        .getPythonRunnerStatus()
        .then((st) => {
          if (active) setPythonRunnerStatus(st);
        })
        .catch(() => undefined);
    };

    window.addEventListener(SETTINGS_APPLIED_EVENT, onSettingsApplied);
    return () => {
      active = false;
      if (unlistenLogs) unlistenLogs();
      window.removeEventListener(SETTINGS_APPLIED_EVENT, onSettingsApplied);
    };
  }, []);

  // Register live snapshot getter so `exportCurrentSettingsProfile()` captures live React state
  const liveSnapshotRef = useRef<() => Partial<FluxUserSettingsProfile>>(
    () => ({})
  );
  liveSnapshotRef.current = () => ({
    ui: {
      theme: preference,
      themePreset,
      customColorOverrides,
      compactToolbar,
      sidebarCollapsed,
      inspectorCollapsed,
      inspectorPosition,
      inspectorSplitDirection,
      followTail,
      columnWidths,
      visibleColumns,
      toolbarGroups,
      panelLayouts: readPersistedPanelLayouts(),
    },
    filters: {
      activePresetId,
      userPresets: customPresets,
      noiseThresholds: thresholds,
      hostFilters: hostListFilter,
      matrixEnabled,
      filterRules,
    },
    proxy: {
      port: status.port,
      autoSystemProxy: status.autoSystemProxy,
      allowRemote: Boolean(
        status.allowRemote ||
          status.bindMode === "all" ||
          (status.bindMode === "specific" &&
            status.specificBindIp &&
            status.specificBindIp !== "127.0.0.1") ||
          status.bindAddr === "0.0.0.0"
      ),
      bindMode: status.bindMode,
      specificBindIp: status.specificBindIp ?? null,
      alsoBindLoopback: status.alsoBindLoopback ?? true,
      tlsInterceptMode: backendFilterConfig.tlsInterceptMode,
      tlsBypassRules: backendFilterConfig.tlsBypassRules,
      tlsTargetRules: backendFilterConfig.tlsTargetRules,
      headerMutations: backendFilterConfig.headerMutations,
      tlsBypassEnabled: backendFilterConfig.tlsBypassEnabled,
      headerMutationsEnabled: backendFilterConfig.headerMutationsEnabled,
      stripAltSvc: backendFilterConfig.stripAltSvc,
      sessionRetentionLimit,
      dropNonMatching,
      clearDbOnExit,
      sanitizationOptions: loadPersistedSanitizationOptions(),
      hostRemapRules,
      throttleConfig,
      upstreamProxy: {
        enabled: upstreamProxyConfig.enabled,
        protocol: upstreamProxyConfig.protocol,
        host: upstreamProxyConfig.host,
        port: upstreamProxyConfig.port,
        username: upstreamProxyConfig.username ?? null,
        bypassList: upstreamProxyConfig.bypassList,
      },
      upstreamTimeouts,
      lanClientAllowlist: backendFilterConfig.lanClientAllowlist ?? [],
    },
    autoResponder: {
      enabled: autoResponderEnabled,
      rules,
    },
    breakpoints: breakpointConfig,
    scripting: {
      enabled: scriptEnabled,
      code: scriptCode,
      activePresetId: scriptActivePresetId,
    },
  });

  useEffect(() => {
    return registerLiveSettingsSnapshotGetter(() => liveSnapshotRef.current());
  }, []);

  // Automatically focus the non-blocking Breakpoints tab once per newly parked packet
  // so the user stays free to switch back to Traffic or TextWizard while paused
  useEffect(() => {
    if (pausedBreakpoints.length === 0) {
      lastAutoOpenedBpRef.current = null;
      return;
    }
    const firstId = pausedBreakpoints[0].breakpointId;
    if (lastAutoOpenedBpRef.current !== firstId) {
      lastAutoOpenedBpRef.current = firstId;
      setSelectedBpId(firstId);
      setBpPanelMode("intercept");
      setBpRequestSeq((n) => n + 1);
      setActiveSection("breakpoints");
    }
  }, [pausedBreakpoints, setActiveSection]);

  const openSanitizedExportModal = useCallback(() => {
    if (sessions.length === 0) {
      showToast("⚠️ Нет захваченных сессий для экспорта");
      return;
    }
    setSanitizedExportModalOpen(true);
  }, [sessions.length, showToast]);

  const openOpenApiExportModal = useCallback(
    (explicitIds?: number[]) => {
      const targetSelected =
        explicitIds && explicitIds.length > 0
          ? [...explicitIds]
          : [...effectiveSelectedIds];
      const targetAll = (
        filteredSessions.length > 0 ? filteredSessions : sessions
      ).map((s) => s.id);
      if (targetSelected.length === 0 && targetAll.length === 0) {
        showToast("⚠️ Нет захваченных сессий для генерации OpenAPI 3.0");
        return;
      }
      setOpenApiSelectedIds(targetSelected);
      setOpenApiAllIds(targetAll);
      setOpenApiModalOpen(true);
    },
    [effectiveSelectedIds, filteredSessions, sessions, showToast]
  );

  const openTextWizardAt = useCallback(
    (tab: TextWizardTab = "jwt", input?: string) => {
      setTextWizardTab(tab);
      setTextWizardInput(input);
      setTextWizardRequestSeq((n) => n + 1);
      setActiveSection("wizard");
    },
    [setActiveSection]
  );

  const openBreakpointsAt = useCallback(
    (mode: BreakpointsPanelMode, bpId?: string) => {
      setBpPanelMode(mode);
      if (bpId) setSelectedBpId(bpId);
      setBpRequestSeq((n) => n + 1);
      setActiveSection("breakpoints");
    },
    [setActiveSection]
  );

  const openAnnotationFor = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) {
        showToast("Сначала выберите сессию в таблице трафика");
        return;
      }
      setAnnotationTargetIds(ids);
      setAnnotationModalOpen(true);
    },
    [showToast]
  );

  const focusTrafficGrid = useCallback(() => {
    setActiveSection("traffic");
    window.requestAnimationFrame(() => {
      trafficGridRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const handleFocusInspector = useCallback(() => {
    setActiveSection("traffic");
    if (selectedId === null && filteredSessions.length > 0) {
      setSelectedId(filteredSessions[0].id);
    }
    if (inspectorCollapsed) {
      setInspectorCollapsed(false);
    }
    window.requestAnimationFrame(() => {
      inspectorContainerRef.current?.focus({ preventScroll: true });
    });
  }, [
    filteredSessions,
    inspectorCollapsed,
    selectedId,
    setInspectorCollapsed,
    setSelectedId,
  ]);

  const handleFocusSearch = useCallback(() => {
    setActiveSection("traffic");
    if (!toolbarGroups.quickFilter) {
      setToolbarGroupVisible("quickFilter", true);
    }
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [setToolbarGroupVisible, toolbarGroups.quickFilter]);

  const handleInspectInHex = useCallback(() => {
    setActiveSection("traffic");
    if (selectedId === null && filteredSessions.length > 0) {
      setSelectedId(filteredSessions[0].id);
    }
    if (inspectorCollapsed) {
      setInspectorCollapsed(false);
    }
    setInlineDiffDismissed(true);
    setHexTriggerSeq((n) => n + 1);
    window.requestAnimationFrame(() => {
      inspectorContainerRef.current?.focus({ preventScroll: true });
    });
  }, [
    filteredSessions,
    inspectorCollapsed,
    selectedId,
    setInspectorCollapsed,
    setSelectedId,
  ]);

  const handleOpenStatistics = useCallback(() => {
    setActiveSection("traffic");
    if (selectedId === null && filteredSessions.length > 0) {
      setSelectedId(filteredSessions[0].id);
    }
    if (inspectorCollapsed) {
      setInspectorCollapsed(false);
    }
    setInlineDiffDismissed(true);
    setStatisticsTriggerSeq((n) => n + 1);
    window.requestAnimationFrame(() => {
      inspectorContainerRef.current?.focus({ preventScroll: true });
    });
  }, [
    filteredSessions,
    inspectorCollapsed,
    selectedId,
    setInspectorCollapsed,
    setSelectedId,
  ]);

  const handleOpenCustomRetentionLimit = useCallback(() => {
    setActiveSection("traffic");
    setCustomRetentionTriggerSeq((n) => n + 1);
  }, []);

  const sqlitePurgeDialogRef = useRef<HTMLDialogElement>(null);
  const [confirmSqlitePurgeOpen, setConfirmSqlitePurgeOpen] = useState(false);
  const [isPurgingSqlite, setIsPurgingSqlite] = useState(false);

  useEffect(() => {
    const dialog = sqlitePurgeDialogRef.current;
    if (!dialog) return;
    if (confirmSqlitePurgeOpen) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [confirmSqlitePurgeOpen]);

  const handleConfirmSqlitePurge = useCallback(async () => {
    if (isPurgingSqlite) return;
    setIsPurgingSqlite(true);
    try {
      await clearSqliteDatabase();
      setConfirmSqlitePurgeOpen(false);
    } finally {
      setIsPurgingSqlite(false);
    }
  }, [clearSqliteDatabase, isPurgingSqlite]);

  const copyUrlsForIds = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) {
        showToast("Нет выбранной сессии для копирования URL");
        return;
      }
      const byId = new Map(sessions.map((s) => [s.id, s]));
      const urls = ids
        .map((id) => byId.get(id)?.url)
        .filter((u): u is string => Boolean(u));
      if (urls.length === 0) return;
      const text = urls.join("\n");
      void navigator.clipboard
        ?.writeText(text)
        .then(() =>
          showToast(
            urls.length === 1
              ? `URL скопирован: ${urls[0]}`
              : `Скопировано URL: ${urls.length}`
          )
        )
        .catch(() => showToast(urls[0]));
    },
    [sessions, showToast]
  );

  const copySessionAsCurl = useCallback(
    async (sessionId: number) => {
      let detail = await proxyBridge.getSessionDetail(sessionId);
      if (!detail) return;
      if (detail.requestBodyOffloaded) {
        try {
          const loaded = await proxyBridge.loadSessionBody(sessionId, false);
          detail = {
            ...detail,
            requestBodyBase64: loaded.bodyBase64,
            requestBodyText: loaded.bodyText,
            requestBodyOffloaded: false,
          };
        } catch {
          // Proceed with headers/URL if offloaded body cannot be read
        }
      }
      const curl = buildCurlCommand(detail);
      await navigator.clipboard?.writeText(curl).catch(() => undefined);
      showToast(`Скопирована команда cURL для сессии #${sessionId}`);
    },
    [showToast]
  );

  const openCodeGeneratorForSession = useCallback(
    async (sessionId: number) => {
      let detail = await proxyBridge.getSessionDetail(sessionId);
      if (!detail) {
        showToast(`Не удалось загрузить данные сессии #${sessionId}`);
        return;
      }
      if (detail.requestBodyOffloaded) {
        try {
          const loaded = await proxyBridge.loadSessionBody(sessionId, false);
          detail = {
            ...detail,
            requestBodyBase64: loaded.bodyBase64,
            requestBodyText: loaded.bodyText,
            requestBodyOffloaded: false,
          };
        } catch {
          // Proceed with headers/URL if offloaded body cannot be retrieved
        }
      }
      setCodeSnippetRequest(requestFromSessionDetail(detail));
      setCodeSnippetModalOpen(true);
    },
    [showToast]
  );

  const openCodeGeneratorForComposerDraft = useCallback(
    (draft: ComposedRequest) => {
      if (!draft.url.trim()) {
        showToast("Укажите URL запроса для генерации клиентского кода");
        return;
      }
      setCodeSnippetRequest(requestFromComposedRequest(draft));
      setCodeSnippetModalOpen(true);
    },
    [showToast]
  );

  const copySessionHeaders = useCallback(
    async (sessionId: number, kind: "request" | "response") => {
      const detail = await proxyBridge.getSessionDetail(sessionId);
      if (!detail) return;
      const block = buildHeadersBlock(detail, kind);
      await navigator.clipboard?.writeText(block).catch(() => undefined);
      showToast(
        kind === "request"
          ? `Скопированы заголовки запроса #${sessionId}`
          : `Скопированы заголовки ответа #${sessionId}`
      );
    },
    [showToast]
  );

  const copyCliProxyEnv = useCallback(() => {
    const snippet = `$env:HTTP_PROXY="http://127.0.0.1:${status.port}"; $env:HTTPS_PROXY="http://127.0.0.1:${status.port}"`;
    void navigator.clipboard
      ?.writeText(snippet)
      .then(() => showToast(`Скопировано: ${snippet}`))
      .catch(() => showToast(snippet));
  }, [showToast, status.port]);

  const openDiffWithPairSmart = useCallback(
    (anchorSessionId?: number) => {
      if (anchorSessionId === undefined) {
        if (selectedIds.length >= 2) {
          setDiffTabPairIds([selectedIds[0], selectedIds[1]]);
          setActiveSection("diff");
          return;
        }
        if (
          diffTabPairIds &&
          sessions.some((s) => s.id === diffTabPairIds[0]) &&
          sessions.some((s) => s.id === diffTabPairIds[1])
        ) {
          setActiveSection("diff");
          return;
        }
      }

      const pool = filteredSessions.length >= 2 ? filteredSessions : sessions;
      const anchorId =
        anchorSessionId ?? selectedId ?? pool[0]?.id ?? sessions[0]?.id ?? null;

      if (anchorId === null) {
        setActiveSection("diff");
        showToast("Нет доступных сессий для сравнения в Session Diff");
        return;
      }

      const anchor =
        pool.find((s) => s.id === anchorId) ??
        sessions.find((s) => s.id === anchorId) ??
        null;
      const anchorBasePath = anchor ? anchor.path.split("?")[0] : "";

      const candidates = pool.filter((s) => s.id !== anchorId);
      const partner =
        (anchor
          ? candidates.find(
              (s) =>
                s.host === anchor.host &&
                s.path.split("?")[0] === anchorBasePath &&
                s.status !== anchor.status
            ) ??
            candidates.find(
              (s) =>
                s.host === anchor.host &&
                s.path.split("?")[0] === anchorBasePath
            ) ??
            candidates.find((s) => s.host === anchor.host)
          : undefined) ?? candidates[0];

      if (!partner) {
        setActiveSection("diff");
        showToast("Для сравнения требуется минимум 2 захваченные сессии");
        return;
      }

      if (anchor && anchor.status >= 400 && partner.status < 400) {
        setDiffTabPairIds([partner.id, anchorId]);
        setComparePairIds(partner.id, anchorId);
      } else {
        setDiffTabPairIds([anchorId, partner.id]);
        setComparePairIds(anchorId, partner.id);
      }
      setActiveSection("diff");
    },
    [
      diffTabPairIds,
      filteredSessions,
      selectedId,
      selectedIds,
      sessions,
      setActiveSection,
      setComparePairIds,
      showToast,
    ]
  );

  const loadSessionIntoComposer = useCallback(
    async (sessionId: number) => {
      const detail = await proxyBridge.getSessionDetail(sessionId);
      if (!detail) return;
      let requestBody = detail.requestBodyText ?? "";
      if (detail.requestBodyOffloaded) {
        try {
          const loaded = await proxyBridge.loadSessionBody(sessionId, false);
          requestBody = loaded.bodyText ?? "";
        } catch {
          // Keep empty body fallback if offloaded payload cannot be retrieved
        }
      }
      setComposerDraft({
        method: detail.summary.method,
        url: detail.summary.url,
        headers: detail.requestHeaders.filter(
          (h) => h.name.toLowerCase() !== "content-length"
        ),
        body: requestBody,
        followRedirects: true,
        sourceSessionId: sessionId,
      });
      setActiveSection("composer");
      showToast(`Loaded Session #${sessionId} into Composer`);
    },
    [setActiveSection, showToast]
  );

  const handleInspectSessionFromComposer = useCallback(
    (sessionId: number) => {
      setSelectedId(sessionId);
      setInlineDiffDismissed(true);
      setInspectorCollapsed(false);
      setActiveSection("traffic");
    },
    [setActiveSection, setInspectorCollapsed, setSelectedId]
  );

  useGlobalShortcuts({
    activeSection,
    setActiveSection,
    sanitizedExportModalOpen,
    setSanitizedExportModalOpen,
    settingsModalOpen,
    onToggleSettingsMain: togglePreferencesMain,
    onToggleSettingsAt: togglePreferencesAt,
    setPaletteOpen,
    setShortcutsModalOpen,
    selectedId,
    effectiveSelectedIds,
    filteredSessions,
    sortedSessionsRef,
    clearAllSessions,
    copyUrlsForIds,
    deleteSessions,
    disableAllBreakpoints,
    exportAllSessionsAs,
    handleFocusSearch,
    importArchiveDialog,
    openAnnotationFor,
    openDiffWithPairSmart,
    openInComposer: (id) => void loadSessionIntoComposer(id),
    openSanitizedExportModal,
    replaySessions,
    selectSessions,
    toggleBreakAfterResponse,
    toggleBreakBeforeRequest,
    toggleCompactToolbar,
    toggleProxy,
    toggleSidebar,
    unmarkSessions,
  });

  const handleCreateRuleFromSession = useCallback(
    async (session: SessionSummary) => {
      const detail = await proxyBridge.getSessionDetail(session.id);
      const newRule: AutoResponderRule = {
        id: `rule-${Date.now()}`,
        enabled: true,
        name: `Mock ${session.method} ${session.path.split("?")[0]}`,
        matchTarget: "urlContains",
        pattern: session.path.split("?")[0] || session.host,
        methodFilter: session.method,
        headerName: null,
        action: "mockResponse",
        statusCode: session.status,
        latencyMs: 50,
        responseHeaders: detail?.responseHeaders ?? [
          { name: "Content-Type", value: session.contentType },
        ],
        responseBody:
          detail?.responseBodyText ??
          JSON.stringify({ mockedFromSession: session.id }, null, 2),
      };
      const updated = await proxyBridge.upsertRule(newRule);
      setRules(updated);
      persistAutoResponderStorage(autoResponderEnabled, updated);
      setActiveSection("rules");
      showToast(`Created AutoResponder rule from Session #${session.id}`);
    },
    [autoResponderEnabled, persistAutoResponderStorage, showToast]
  );

  const activeTargetHostsCount = useMemo(
    () =>
      (backendFilterConfig.tlsTargetRules ?? []).filter(
        (r) => r.enabled && !r.pattern.trim().startsWith("!")
      ).length,
    [backendFilterConfig.tlsTargetRules]
  );

  const enabledTlsBypassCount = useMemo(
    () =>
      (backendFilterConfig.tlsBypassRules ?? []).filter((r) => r.enabled).length,
    [backendFilterConfig.tlsBypassRules]
  );

  const activeRulesCount = autoResponderEnabled
    ? rules.filter((r) => r.enabled).length
    : 0;
  const enabledBreakpointRulesCount = breakpointConfig.rules.filter(
    (r) => r.enabled
  ).length;
  const breakpointsArmed =
    breakpointConfig.breakBeforeRequest ||
    breakpointConfig.breakAfterResponse ||
    enabledBreakpointRulesCount > 0;
  const activeThemePresetName = useMemo(
    () => THEME_PRESETS.find((p) => p.id === themePreset)?.name ?? themePreset,
    [themePreset]
  );

  const commands: PaletteCommand[] = useMemo(
    () => [
      {
        id: "toggle-proxy",
        category: "Proxy",
        group: "capture",
        label: status.running
          ? "Pause MITM Capture & Rollback OS System Proxy"
          : status.autoSystemProxy
            ? `Start MITM Capture & Enable OS System Proxy (127.0.0.1:${status.port})`
            : `Start Local MITM Proxy Listener Only (127.0.0.1:${status.port})`,
        description: status.running
          ? `Остановить прослушивание порта :${status.port} и откатить системный прокси`
          : `Запустить захват HTTP/HTTPS/WS трафика на порту :${status.port}`,
        statusBadge: status.running
          ? `ON :${status.port}`
          : `OFF :${status.port}`,
        shortcut: "F12",
        keywords: ["proxy", "start", "stop", "capture", "listen", "прокси", "захват"],
        perform: () => void toggleProxy(),
      },
      {
        id: "select-all-sessions",
        category: "Traffic",
        group: "capture",
        label: "Select All Visible Sessions in Traffic Grid",
        description: "Выделить все отфильтрованные строки в таблице трафика",
        shortcut: "Ctrl+A",
        keywords: ["select", "all", "выделить"],
        perform: () => handleSelectAllSessions(),
      },
      {
        id: "replay-selected",
        category: "Traffic",
        group: "capture",
        label: "Replay выбранной сессии напрямую в upstream",
        description: "Повторно отправить выбранные запросы с текущими правилами и скриптами",
        shortcut: "R / Ctrl+R",
        keywords: ["replay", "resend", "повтор"],
        perform: () => {
          if (effectiveSelectedIds.length > 0) {
            void replaySessions(effectiveSelectedIds);
          } else {
            showToast("Сначала выберите сессию в таблице");
          }
        },
      },
      {
        id: "edit-in-composer",
        category: "Traffic",
        group: "tools",
        label: `Edit in ${getSectionMeta("composer").title}`,
        description: "Загрузить выбранный запрос во вкладку Composer для редактирования и отправки",
        shortcut: "E",
        keywords: ["composer", "edit", "modify", "replay", "resend", "редактировать"],
        perform: () => {
          const targetId = selectedId ?? effectiveSelectedIds[0] ?? null;
          if (targetId !== null) {
            void loadSessionIntoComposer(targetId);
          } else {
            showToast("Сначала выберите сессию в таблице");
          }
        },
      },
      {
        id: "delete-selected",
        category: "Traffic",
        group: "capture",
        label: "Удалить выбранные сессии из списка",
        description: "Удалить выделенные запросы из буфера памяти таблицы",
        shortcut: "Del",
        perform: () => {
          if (effectiveSelectedIds.length > 0) {
            void deleteSessions(effectiveSelectedIds);
          }
        },
      },
      {
        id: "clear-all",
        category: "Traffic",
        group: "capture",
        label: "Clear All Captured Traffic Sessions",
        description: "Очистить все захваченные сессии из оперативной памяти",
        shortcut: "Ctrl+X",
        perform: () => void clearAllSessions(),
      },
      {
        id: "copy-curl",
        category: "Traffic",
        group: "tools",
        label: "Copy Selected Session as cURL",
        description: "Скопировать выбранный запрос в буфер обмена как команду curl",
        keywords: ["curl", "copy", "cli"],
        perform: () => {
          if (selectedId !== null) void copySessionAsCurl(selectedId);
        },
      },
      {
        id: "generate-client-code",
        category: "Traffic",
        group: "tools",
        label: getSectionMeta("codeGenerator").title,
        description: getSectionMeta("codeGenerator").summary,
        keywords: [
          "code",
          "snippet",
          "fetch",
          "axios",
          "python",
          "requests",
          "httpx",
          "go",
          "rust",
          "reqwest",
          "curl",
          "генератор",
        ],
        perform: () => {
          const targetId = selectedId ?? effectiveSelectedIds[0] ?? null;
          if (targetId !== null) {
            void openCodeGeneratorForSession(targetId);
          } else {
            showToast("Сначала выберите сессию в таблице");
          }
        },
      },
      {
        id: "open-session-diff",
        category: "Session Diff",
        group: "tools",
        label: getSectionMeta("diff").title,
        description: getSectionMeta("diff").summary,
        shortcut: "Ctrl+D",
        keywords: ["diff", "compare", "сравнение", "headers", "json"],
        perform: () => openDiffWithPairSmart(),
      },
      {
        id: "annotate-session",
        category: "Annotations",
        group: "capture",
        label: getSectionMeta("commentMark").title,
        description: getSectionMeta("commentMark").summary,
        shortcut: "M",
        keywords: ["comment", "mark", "note", "комментарий", "метка"],
        perform: () => openAnnotationFor(effectiveSelectedIds),
      },
      {
        id: "unmark-session",
        category: "Annotations",
        group: "capture",
        label: "Снять цветовую метку с выбранных сессий (Unmark)",
        description: "Убрать пользовательский маркер и комментарий с выделенных строк",
        shortcut: "U",
        perform: () => {
          if (effectiveSelectedIds.length > 0) {
            void unmarkSessions(effectiveSelectedIds);
          }
        },
      },
      {
        id: "filter-marked-sessions",
        category: "Annotations",
        group: "capture",
        label: "Показать только помеченные сессии (Marked / Comments)",
        description: "Отфильтровать таблицу по сессиям с комментариями или цветовыми метками",
        statusBadge:
          markedSessionsCount > 0 ? `Помечено: ${markedSessionsCount}` : "0",
        perform: () => {
          setActiveSection("traffic");
          setQuickCategory("marked");
        },
      },
      {
        id: "inspect-hex",
        category: "Inspector",
        group: "capture",
        label: "Открыть выбранную сессию во вкладке Hex View",
        description: "Побайтовый шестнадцатеричный дамп и Decoded ASCII в инспекторе",
        perform: handleInspectInHex,
      },
      {
        id: "open-session-statistics",
        category: "Inspector",
        group: "capture",
        label:
          "Открыть Statistics — пофазные тайминги (DNS/TCP/TLS/TTFB) и сводка выделенных сессий",
        description: "Шкала фаз соединения, метрики сжатия, TLS и оценка задержек по регионам",
        keywords: [
          "statistics",
          "timings",
          "ttfb",
          "dns",
          "tls",
          "performance",
          "fiddler",
          "статистика",
          "тайминги",
        ],
        perform: handleOpenStatistics,
      },
      {
        id: "open-traffic-statistics",
        category: "Traffic",
        group: "tools",
        label: "Traffic Statistics — сводная статистика и Markdown-отчёт по выборке",
        description:
          "Доли 2xx–5xx/Pending, объём wire/decoded, Avg/Median/P95 Latency и TTFB, MIME, хосты и топ-5 URL",
        statusBadge: `${filteredSessions.length.toLocaleString("en-US")} сессий`,
        keywords: [
          "statistics",
          "stats",
          "summary",
          "report",
          "markdown",
          "p95",
          "median",
          "ttfb",
          "mime",
          "hosts",
          "статистика",
          "отчёт",
          "отчет",
          "выборка",
        ],
        perform: () => openTrafficStatisticsModal("filtered"),
      },
      {
        id: "toggle-waterfall-timeline",
        category: "View",
        group: "tools",
        label:
          trafficViewMode === "waterfall"
            ? "Переключить Traffic в режим таблицы (Table Grid)"
            : "Открыть Waterfall Timeline — многофазная каскадная диаграмма",
        description:
          "Виртуализированная временная шкала с фазами DNS / TCP / TLS / TTFB / Download и масштабированием",
        statusBadge: trafficViewMode === "waterfall" ? "Waterfall" : "Grid",
        keywords: [
          "waterfall",
          "timeline",
          "gantt",
          "cascade",
          "dns",
          "tcp",
          "tls",
          "ttfb",
          "zoom",
          "таймлайн",
          "водопад",
          "каскад",
        ],
        perform: () =>
          handleSetTrafficViewMode(
            trafficViewMode === "waterfall" ? "grid" : "waterfall"
          ),
      },
      {
        id: "toggle-compact-toolbar",
        category: "View",
        group: "settings",
        label: compactToolbar
          ? "Выключить Slim / Compact Toolbar"
          : "Включить Slim / Compact Toolbar",
        description: "Переключить компактный однострочный режим верхней панели инструментов",
        statusBadge: compactToolbar ? "ON" : "OFF",
        shortcut: "Ctrl+Shift+T",
        perform: toggleCompactToolbar,
      },
      {
        id: "toggle-sidebar",
        category: "View",
        group: "settings",
        label: sidebarCollapsed
          ? "Показать боковую панель (Sidebar)"
          : "Скрыть боковую панель (Sidebar)",
        description: "Свернуть или развернуть левую навигационную панель вкладок",
        statusBadge: sidebarCollapsed ? "Свёрнут" : "Открыт",
        shortcut: "Ctrl+B",
        perform: toggleSidebar,
      },
      {
        id: "toggle-inspector",
        category: "View",
        group: "settings",
        label: inspectorCollapsed
          ? "Развернуть панель Session Inspector"
          : "Свернуть панель Session Inspector",
        description: "Показать или скрыть панель детального разбора выбранной сессии",
        statusBadge: inspectorCollapsed ? "Свёрнут" : "Открыт",
        shortcut: "Space",
        perform: toggleInspector,
      },
      {
        id: "dock-inspector-bottom",
        category: "View",
        group: "settings",
        label: "Расположить Session Inspector снизу (Bottom Split)",
        description: "Горизонтальное разделение: таблица сверху, инспектор снизу",
        statusBadge: inspectorPosition === "bottom" ? "Активно" : undefined,
        perform: () => setInspectorPosition("bottom"),
      },
      {
        id: "dock-inspector-right",
        category: "View",
        group: "settings",
        label: "Расположить Session Inspector справа (Right Split)",
        description: "Вертикальное разделение: таблица слева, инспектор справа",
        statusBadge: inspectorPosition === "right" ? "Активно" : undefined,
        perform: () => setInspectorPosition("right"),
      },
      {
        id: "reset-columns",
        category: "View",
        group: "settings",
        label: "Сбросить ширину и видимость колонок таблицы",
        description: "Восстановить стандартный набор и ширину колонок Traffic Grid",
        perform: resetColumns,
      },
      {
        id: "reset-panel-layout",
        category: "View",
        group: "settings",
        label: "Reset Panel Layout to Default",
        description: "Сбросить сохранённые пропорции разделителей сплит-панелей",
        keywords: [
          "split",
          "panels",
          "geometry",
          "autosave",
          "сбросить панели",
          "размеры",
        ],
        perform: handleResetPanelLayout,
      },
      {
        id: "open-shortcuts-modal",
        category: "Help",
        group: "settings",
        label: getSectionMeta("shortcuts").title,
        description: getSectionMeta("shortcuts").summary,
        shortcut: "?",
        keywords: ["shortcuts", "keys", "hotkeys", "клавиши", "справка"],
        perform: () => setShortcutsModalOpen(true),
      },
      {
        id: "run-proxy-doctor",
        category: "Diagnostics",
        group: "tools",
        label: "Proxy Doctor",
        description: "Автоматическая проверка 6 компонентов среды и исправление проблем в 1 клик",
        shortcut: "Ctrl+Shift+D",
        keywords: [
          "doctor",
          "diagnose",
          "health",
          "vpn",
          "firewall",
          "ca",
          "sysproxy",
          "loopback",
          "диагностика",
          "проблемы",
        ],
        perform: () => openPreferencesAt("diagnosticsBackup", "proxyDoctor"),
      },
      {
        id: "open-text-wizard",
        category: "TextWizard",
        group: "tools",
        label: getSectionMeta("wizard").title,
        description: getSectionMeta("wizard").summary,
        shortcut: "Ctrl+E",
        keywords: ["wizard", "jwt", "base64", "url", "gzip", "brotli", "zstd", "hex", "timestamp"],
        perform: () => setActiveSection("wizard"),
      },
      {
        id: "open-jwt-inspector",
        category: "TextWizard",
        group: "tools",
        label: "TextWizard: JWT",
        description: "Быстрый разбор структуры JSON Web Token и валидности срока действия",
        keywords: ["jwt", "token", "claims", "exp"],
        perform: () => openTextWizardAt("jwt"),
      },
      {
        id: "open-compression-codec",
        category: "TextWizard",
        group: "tools",
        label: "TextWizard: Compression Codec",
        description: "Сжатие и распаковка Gzip, Brotli, Deflate и Zstd",
        keywords: ["gzip", "brotli", "deflate", "zstd", "codec", "сжатие"],
        perform: () => openTextWizardAt("compression"),
      },
      {
        id: "toggle-bp-request",
        category: "Breakpoints",
        group: "filters",
        label: breakpointConfig.breakBeforeRequest
          ? "Отключить Break Before Request"
          : "Включить Break Before Request",
        description: "Глобальная пауза всех исходящих запросов для ручного редактирования",
        statusBadge: breakpointConfig.breakBeforeRequest ? "ON" : "OFF",
        shortcut: "F11",
        perform: () => void toggleBreakBeforeRequest(),
      },
      {
        id: "toggle-bp-response",
        category: "Breakpoints",
        group: "filters",
        label: breakpointConfig.breakAfterResponse
          ? "Отключить Break After Response"
          : "Включить Break After Response",
        description: "Глобальная пауза всех ответов перед возвратом в браузер или приложение",
        statusBadge: breakpointConfig.breakAfterResponse ? "ON" : "OFF",
        shortcut: "Alt+F11",
        perform: () => void toggleBreakAfterResponse(),
      },
      {
        id: "open-bp-rules",
        category: "Breakpoints",
        group: "filters",
        label: getSectionMeta("breakpoints").title,
        description: getSectionMeta("breakpoints").summary,
        shortcut: "Alt+6",
        statusBadge:
          pausedBreakpoints.length > 0
            ? `Пауза: ${pausedBreakpoints.length} · Правил: ${enabledBreakpointRulesCount}`
            : enabledBreakpointRulesCount > 0
              ? `Правил: ${enabledBreakpointRulesCount}`
              : "0 правил",
        keywords: ["breakpoints", "bpu", "bpafter", "pause", "intercept", "точки останова"],
        perform: () =>
          openBreakpointsAt(
            pausedBreakpoints.length > 0 ? "intercept" : "rules"
          ),
      },
      {
        id: "disable-all-breakpoints",
        category: "Breakpoints",
        group: "filters",
        label: "Снять все точки останова и отпустить ожидающие запросы",
        description: "Выключить глобальные и условные брейкпоинты и продолжить все паузы",
        statusBadge:
          pausedBreakpoints.length > 0
            ? `В очереди: ${pausedBreakpoints.length}`
            : breakpointsArmed
              ? "Активно"
              : "OFF",
        shortcut: "Shift+F11",
        perform: () => void disableAllBreakpoints(),
      },
      {
        id: "open-filters-matrix",
        category: "Filters",
        group: "filters",
        label: getSectionMeta("settings.filters").title,
        description: getSectionMeta("settings.filters").summary,
        statusBadge:
          activeFilterBadgeCount > 0
            ? `Активно: ${activeFilterBadgeCount}`
            : "Выкл",
        shortcut: "Alt+4",
        keywords: ["filters", "matrix", "presets", "pid", "фильтры", "пресеты"],
        perform: () => openPreferencesAt("filters", "matrix"),
      },
      {
        id: "open-hosts-list-filter",
        category: "Filters",
        group: "filters",
        label: "Hosts List",
        description: "Фильтрация трафика по списку доменов, маскам * и регулярным выражениям",
        statusBadge: hostListFilter.enabled
          ? `${hostListFilter.mode === "whitelist" ? "Allow" : "Block"} (${compiledHostList.activeCount})`
          : "OFF",
        keywords: ["hosts", "whitelist", "blacklist", "домены", "список"],
        perform: () => openPreferencesAt("filters", "hostsList"),
      },
      {
        id: "open-tls-bypass",
        category: "TLS / CA",
        group: "filters",
        label: "TLS Bypass",
        description: "Настройка целевых доменов расшифровки, Quick-Packs и пакетного редактора",
        statusBadge:
          backendFilterConfig.tlsInterceptMode === "targetedOnly"
            ? `Targeted (${activeTargetHostsCount})`
            : `Bypass (${enabledTlsBypassCount})`,
        keywords: ["tls", "mitm", "bypass", "allowlist", "passthrough"],
        perform: () => openPreferencesAt("tlsCertificates", "mitmBypass"),
      },
      {
        id: "toggle-tls-mitm-mode",
        category: "TLS / CA",
        group: "filters",
        label:
          backendFilterConfig.tlsInterceptMode === "targetedOnly"
            ? "Переключить в Mode: Intercept All (расшифровка всего, кроме Bypass)"
            : "Включить Mode: Targeted Only (Allowlist) — «Чистый проброс» всего, кроме целевых хостов",
        description: "Переключение между полной расшифровкой HTTPS и режимом целевого списка",
        statusBadge:
          backendFilterConfig.tlsInterceptMode === "targetedOnly"
            ? `Targeted (${activeTargetHostsCount})`
            : "Intercept All",
        perform: () => void toggleTlsInterceptMode(),
      },
      {
        id: "preset-backend-api",
        category: "Preset",
        group: "filters",
        label: "Применить пресет: «Только API бэкенда»",
        description: "Оставить JSON/GraphQL/API-запросы и скрыть статику со шрифтами",
        statusBadge:
          activePresetId === "preset-backend-api" ? "Активно" : undefined,
        perform: () => applyPreset("preset-backend-api"),
      },
      {
        id: "preset-hide-noise",
        category: "Preset",
        group: "filters",
        label: "Применить пресет: «Скрыть аналитику и фоновый шум ОС»",
        description: "Скрыть телеметрию, трекеры и служебные фоновые запросы",
        statusBadge:
          activePresetId === "preset-hide-os-noise" ? "Активно" : undefined,
        perform: () => applyPreset("preset-hide-os-noise"),
      },
      {
        id: "toggle-nocache",
        category: "Filters",
        group: "filters",
        label: isForceNoCacheActive
          ? "Отключить принудительный обход кэша (If-Modified-Since / ETag)"
          : "Включить принудительный обход кэша (Удалять If-Modified-Since / ETag)",
        description: "Удаляет заголовки условного кэширования для получения свежих ответов 200",
        statusBadge: isForceNoCacheActive ? "ON" : "OFF",
        perform: () => void toggleForceNoCache(),
      },
      {
        id: "reset-filters",
        category: "Filters",
        group: "filters",
        label: "Сбросить все табличные фильтры и пороги шума",
        description: "Очистить матрицу фильтров, список хостов и пороговые значения",
        perform: resetAdvancedFilters,
      },
      {
        id: "connect-mobile-device",
        category: "Proxy",
        group: "network",
        label: "Mobile Setup",
        description: "LAN IP, QR-код установки Root CA и шаблон Android network_security_config",
        statusBadge:
          status.allowRemote || status.bindAddr === "0.0.0.0"
            ? `LAN :${status.port}`
            : `Local :${status.port}`,
        shortcut: "Ctrl+Shift+M",
        keywords: ["mobile", "ios", "android", "qr", "wifi", "flux.proxy"],
        perform: () => openPreferencesAt("tlsCertificates", "mobileSetup"),
      },
      {
        id: "toggle-allow-remote",
        category: "Proxy",
        group: "network",
        label:
          status.allowRemote || status.bindAddr === "0.0.0.0"
            ? "Отключить удаленные подключения (слушать только 127.0.0.1)"
            : "Разрешить подключения с удаленных устройств (0.0.0.0 / LAN Wi-Fi)",
        description: "Переключить привязку прокси между локальной петлёй и сетевыми интерфейсами",
        statusBadge:
          status.allowRemote || status.bindAddr === "0.0.0.0"
            ? "LAN (0.0.0.0)"
            : "127.0.0.1",
        perform: () => void toggleAllowRemote(),
      },
      {
        id: "toggle-system-proxy",
        category: "Proxy",
        group: "network",
        label: status.systemProxyError
          ? `Переподключить системный прокси ОС (127.0.0.1:${status.port})`
          : status.systemProxyEnabled
            ? "Отключить системный прокси ОС (оставить только локальный порт HTTP_PROXY)"
            : `Включить системный прокси ОС (направить браузеры на 127.0.0.1:${status.port})`,
        description: "Регистрация FluxProxy в качестве системного HTTP/HTTPS прокси ОС",
        statusBadge: status.systemProxyError
          ? "Ошибка"
          : status.systemProxyEnabled
            ? "ON"
            : "OFF",
        perform: () => void toggleSystemProxy(),
      },
      {
        id: "stress-10k",
        category: "Benchmark",
        group: "tools",
        label: "Generate +10,000 Sessions (Test Virtualized Scrolling)",
        description: "Сгенерировать 10 000 тестовых сессий для проверки производительности таблицы",
        perform: generateStress10k,
      },
      {
        id: "view-traffic",
        category: "View",
        group: "settings",
        label: getSectionMeta("traffic").title,
        description: getSectionMeta("traffic").summary,
        shortcut: "Alt+1",
        keywords: ["traffic", "stream", "grid", "inspector", "трафик"],
        perform: () => setActiveSection("traffic"),
      },
      {
        id: "view-composer",
        category: "View",
        group: "tools",
        label: getSectionMeta("composer").title,
        description: getSectionMeta("composer").summary,
        shortcut: "Alt+2",
        keywords: ["composer", "curl", "import", "paste", "request", "http"],
        perform: () => setActiveSection("composer"),
      },
      {
        id: "view-rules",
        category: "AutoResponder",
        group: "tools",
        label: getSectionMeta("rules").title,
        description: getSectionMeta("rules").summary,
        statusBadge: autoResponderEnabled
          ? `ON (${activeRulesCount}/${rules.length})`
          : `OFF (${rules.length})`,
        shortcut: "Alt+3",
        keywords: ["autoresponder", "mock", "latency", "rules", "правила"],
        perform: () => setActiveSection("rules"),
      },
      {
        id: "view-scripts",
        category: "Scripting",
        group: "tools",
        label: getSectionMeta("scripts").title,
        description: getSectionMeta("scripts").summary,
        statusBadge: scriptEnabled ? "ON" : "OFF",
        shortcut: "Alt+5",
        keywords: ["python", "script", "hmac", "mock", "on_request", "on_response"],
        perform: () => setActiveSection("scripts"),
      },
      {
        id: "toggle-python-script",
        category: "Scripting",
        group: "tools",
        label: scriptEnabled
          ? "Disable Scripts"
          : "Enable Scripts",
        description: "Включить или выключить выполнение Python-хуков на проходящем трафике",
        statusBadge: scriptEnabled ? "ON" : "OFF",
        keywords: ["python", "scripts", "toggle"],
        perform: () => void handleTogglePythonScript(!scriptEnabled),
      },
      {
        id: "root-ca",
        category: "TLS / CA",
        group: "filters",
        label: getSectionMeta("rootCa").title,
        description: getSectionMeta("rootCa").summary,
        keywords: ["ca", "root", "certificate", "mitm", "trust", "сертификат"],
        perform: () => setCertModalOpen(true),
      },
      {
        id: "client-certificates",
        category: "TLS / mTLS",
        group: "filters",
        label: "Client Certificates",
        description: "Хранилище клиентских сертификатов с поддержкой DPAPI и режима In-Memory",
        shortcut: "Ctrl+Shift+C",
        keywords: [
          "mtls",
          "client",
          "cert",
          "certificate",
          "p12",
          "pfx",
          "pem",
          "pkcs12",
          "сертификат",
          "клиентский",
        ],
        perform: () => openPreferencesAt("tlsCertificates", "clientCerts"),
      },
      {
        id: "host-remap",
        category: "DNS / Routing",
        group: "network",
        label: "HOSTS Remapping",
        description: "Виртуальный DNS для маршрутизации доменов на локальные или стендовые IP",
        statusBadge:
          activeHostRemapCount > 0
            ? `Правил: ${activeHostRemapCount}`
            : "0 правил",
        shortcut: "Ctrl+Shift+H",
        keywords: [
          "hosts",
          "dns",
          "remap",
          "virtual",
          "redirect",
          "sni",
          "перенаправление",
          "хост",
        ],
        perform: () => openPreferencesAt("networkRouting", "hostsRemap"),
      },
      {
        id: "upstream-proxy-chaining",
        category: "Tools",
        group: "network",
        label: "Upstream Proxy",
        description: "Цепочка вышестоящего прокси с аутентификацией и списком обхода bypass",
        statusBadge: upstreamProxyActiveLabel ?? "OFF",
        shortcut: "Ctrl+Shift+U",
        keywords: [
          "upstream",
          "proxy",
          "chain",
          "socks",
          "socks5",
          "bypass",
          "каскад",
          "прокси",
        ],
        perform: () => openPreferencesAt("networkRouting", "upstreamProxy"),
      },
      ...THROTTLE_PRESET_DEFINITIONS.filter((d) => d.id !== "custom").map(
        (presetDef) => ({
          id: `throttle-preset-${presetDef.id}`,
          category: "Throttling",
          group: "network" as const,
          label: `Network Throttling: ${presetDef.label} (${presetDef.summary})`,
          description:
            presetDef.id === "none"
              ? "Отключить ограничение скорости и задержку RTT"
              : presetDef.id === "offline"
                ? "Имитировать отсутствие сети с ответом HTTP 503"
                : `Ограничить канал ↓${presetDef.downloadKbps} / ↑${presetDef.uploadKbps} Kbps и RTT ${presetDef.latencyMs} ms`,
          statusBadge:
            throttleConfig.preset === presetDef.id ? "Активно" : undefined,
          keywords: [
            "throttle",
            "bandwidth",
            "network",
            "speed",
            "latency",
            "slow",
            presetDef.id,
            presetDef.shortLabel.toLowerCase(),
            "скорость",
            "троттлинг",
          ],
          perform: () =>
            void handleChangeThrottleConfig({
              preset: presetDef.id,
              downloadKbps: presetDef.downloadKbps,
              uploadKbps: presetDef.uploadKbps,
              latencyMs: presetDef.latencyMs,
            }),
        })
      ),
      {
        id: "save-all-archive",
        category: "Storage",
        group: "tools",
        label: "Save All Sessions As... (.har, .saz, .json)",
        description: "Экспортировать все захваченные сессии в стандартный архив",
        shortcut: "Ctrl+S",
        perform: () => void exportAllSessionsAs(),
      },
      {
        id: "save-selected-archive",
        category: "Storage",
        group: "tools",
        label: "Save Selected Sessions... (.har, .saz, .json)",
        description: "Экспортировать только выделенные в таблице сессии",
        perform: () => void exportSelectedSessionsAs(),
      },
      {
        id: "export-sanitized-sessions",
        category: "Security",
        group: "tools",
        label: getSectionMeta("sanitizedExport").title,
        description: getSectionMeta("sanitizedExport").summary,
        shortcut: "Ctrl+Shift+S",
        keywords: [
          "sanitize",
          "redact",
          "pii",
          "secrets",
          "mask",
          "anonymize",
          "har",
          "saz",
          "export",
          "санитизация",
          "маскирование",
        ],
        perform: openSanitizedExportModal,
      },
      {
        id: "export-openapi-spec",
        category: "Traffic",
        group: "tools",
        label: getSectionMeta("openApiExport").title,
        description: getSectionMeta("openApiExport").summary,
        keywords: ["openapi", "swagger", "spec", "yaml", "json", "schema", "api"],
        perform: () => openOpenApiExportModal(),
      },
      {
        id: "import-archive",
        category: "Storage",
        group: "tools",
        label: "Open / Import Archive... (.har, .saz, .json)",
        description: "Загрузить сохранённый трафик из HAR 1.2, Fiddler SAZ или JSON",
        shortcut: "Ctrl+O",
        perform: () => void importArchiveDialog(),
      },
      {
        id: "sqlite-save",
        category: "Storage",
        group: "capture",
        label: "Save Captured Sessions to SQLite Database",
        description: "Сохранить текущие сессии из оперативной памяти в sessions.sqlite",
        perform: () => void saveToSqlite(),
      },
      {
        id: "sqlite-load",
        category: "Storage",
        group: "capture",
        label: "Restore Sessions from SQLite Database",
        description: "Восстановить сохранённую историю сессий из базы SQLite",
        perform: () => void loadFromSqlite(),
      },
      {
        id: "clear-sqlite-db",
        category: "Storage",
        group: "capture",
        label: "Purge & Compact SQLite Archive (VACUUM / Free Disk)...",
        description: "Удалить архивные записи из SQLite и освободить место на диске",
        perform: () => setConfirmSqlitePurgeOpen(true),
      },
      {
        id: "toggle-drop-non-matching",
        category: "Storage",
        group: "capture",
        label: dropNonMatching
          ? "Disable Drop Non-Matching Traffic on Capture"
          : "Enable Drop Non-Matching Traffic on Capture (Save RAM)",
        description: "Отбрасывать не попадающий под фильтры трафик на лету для экономии ОЗУ",
        statusBadge: dropNonMatching ? "ON" : "OFF",
        perform: () => void toggleDropNonMatching(),
      },
      {
        id: "retention-all",
        category: "Storage",
        group: "capture",
        label: "Session Retention Limit: Keep All Sessions (Unlimited)",
        description: "Отключить ограничение кольцевого буфера (хранить все сессии в RAM)",
        statusBadge: sessionRetentionLimit === null ? "Активно" : undefined,
        perform: () => void setSessionRetentionLimit(null),
      },
      {
        id: "retention-1000",
        category: "Storage",
        group: "capture",
        label: "Session Retention Limit: Keep 1,000 Sessions",
        description: "Хранить в оперативной памяти последние 1 000 сессий (FIFO)",
        statusBadge: sessionRetentionLimit === 1000 ? "Активно" : undefined,
        perform: () => void setSessionRetentionLimit(1000),
      },
      {
        id: "retention-10000",
        category: "Storage",
        group: "capture",
        label: "Session Retention Limit: Keep 10,000 Sessions (Default)",
        description: "Стандартный лимит кольцевого буфера: 10 000 последних сессий",
        statusBadge: sessionRetentionLimit === 10000 ? "Активно" : undefined,
        perform: () => void setSessionRetentionLimit(10000),
      },
      {
        id: "retention-custom",
        category: "Storage",
        group: "capture",
        label: "Session Retention Limit: Enter Custom Limit...",
        description: "Задать произвольное количество сессий для кольцевого буфера",
        statusBadge:
          sessionRetentionLimit !== null &&
          sessionRetentionLimit !== 1000 &&
          sessionRetentionLimit !== 10000
            ? String(sessionRetentionLimit)
            : undefined,
        perform: handleOpenCustomRetentionLimit,
      },
      {
        id: "theme-dark",
        category: "Theme",
        group: "settings",
        label: "Set Theme: Dark",
        description: "Принудительно включить тёмную цветовую схему интерфейса",
        statusBadge: preference === "dark" ? "Активно" : undefined,
        perform: () => setTheme("dark"),
      },
      {
        id: "theme-light",
        category: "Theme",
        group: "settings",
        label: "Set Theme: Light",
        description: "Принудительно включить светлую цветовую схему интерфейса",
        statusBadge: preference === "light" ? "Активно" : undefined,
        perform: () => setTheme("light"),
      },
      {
        id: "theme-system",
        category: "Theme",
        group: "settings",
        label: "Set Theme: Follow OS System Preference",
        description: "Автоматически синхронизировать светлую/тёмную схему с темой ОС",
        statusBadge:
          preference === "system" ? `Система (${resolvedTheme})` : undefined,
        perform: () => setTheme("system"),
      },
      {
        id: "open-theme-gallery",
        category: "Theme",
        group: "settings",
        label: getSectionMeta("settings.uiColumns").title,
        description: getSectionMeta("settings.uiColumns").summary,
        statusBadge: activeThemePresetName,
        keywords: [
          "theme",
          "preset",
          "palette",
          "colors",
          "dracula",
          "tokyo",
          "nord",
          "fiddler",
          "github",
          "monokai",
          "тема",
          "палитра",
        ],
        perform: () => openPreferencesAt("uiColumns"),
      },
      ...THEME_PRESETS.map((preset) => ({
        id: `theme-preset-${preset.id}`,
        category: "Theme",
        group: "settings" as const,
        label: `Set Theme Preset: ${preset.name} (${preset.baseScheme === "dark" ? "Dark" : "Light"})`,
        description: preset.description,
        statusBadge: themePreset === preset.id ? "Активно" : undefined,
        keywords: [
          "theme",
          "preset",
          preset.id,
          preset.name.toLowerCase(),
          preset.baseScheme,
        ],
        perform: () => setThemePreset(preset.id),
      })),
      {
        id: "open-preferences",
        category: "Settings",
        group: "settings",
        label: getSectionMeta("settings").title,
        description: getSectionMeta("settings").summary,
        shortcut: "Ctrl+,",
        keywords: ["settings", "preferences", "настройки", "профиль"],
        perform: () => openPreferencesAt("general"),
      },
      {
        id: "export-settings-profile",
        category: "Settings",
        group: "settings",
        label:
          "Export Settings Profile (JSON)... — Сохранить fluxproxy-settings-v1.json",
        description: "Выгрузить переносимый профиль настроек FluxProxy (schemaVersion: 1)",
        perform: () => void handleExportSettingsProfile(),
      },
      {
        id: "import-settings-profile",
        category: "Settings",
        group: "settings",
        label:
          "Import Settings Profile... — Загрузить профиль настроек с превью",
        description: "Импортировать профиль настроек JSON с предварительным просмотром изменений",
        perform: () => void handleImportSettingsProfileDialog(),
      },
      {
        id: "reset-all-settings-defaults",
        category: "Settings",
        group: "settings",
        label:
          "Reset All Settings to Defaults... — Сбросить все настройки к дефолтам",
        description: "Восстановить все параметры приложения и правил к заводским значениям",
        perform: () => void handleResetAllSettings(false),
      },
    ],
    [
      activeFilterBadgeCount,
      activeHostRemapCount,
      activePresetId,
      activeRulesCount,
      activeTargetHostsCount,
      activeThemePresetName,
      applyPreset,
      autoResponderEnabled,
      backendFilterConfig.tlsInterceptMode,
      breakpointConfig.breakAfterResponse,
      breakpointConfig.breakBeforeRequest,
      breakpointsArmed,
      clearAllSessions,
      compactToolbar,
      compiledHostList.activeCount,
      copySessionAsCurl,
      deleteSessions,
      disableAllBreakpoints,
      dropNonMatching,
      effectiveSelectedIds,
      enabledBreakpointRulesCount,
      enabledTlsBypassCount,
      exportAllSessionsAs,
      exportSelectedSessionsAs,
      filteredSessions.length,
      generateStress10k,
      handleChangeThrottleConfig,
      handleExportSettingsProfile,
      handleImportSettingsProfileDialog,
      handleInspectInHex,
      handleOpenCustomRetentionLimit,
      handleOpenStatistics,
      handleResetAllSettings,
      handleResetPanelLayout,
      handleSelectAllSessions,
      handleSetTrafficViewMode,
      handleTogglePythonScript,
      hostListFilter.enabled,
      hostListFilter.mode,
      importArchiveDialog,
      inspectorCollapsed,
      inspectorPosition,
      isForceNoCacheActive,
      loadFromSqlite,
      loadSessionIntoComposer,
      markedSessionsCount,
      openAnnotationFor,
      openBreakpointsAt,
      openCodeGeneratorForSession,
      openDiffWithPairSmart,
      openOpenApiExportModal,
      openPreferencesAt,
      openSanitizedExportModal,
      openTextWizardAt,
      openTrafficStatisticsModal,
      pausedBreakpoints.length,
      preference,
      replaySessions,
      resetAdvancedFilters,
      resetColumns,
      resolvedTheme,
      rules.length,
      saveToSqlite,
      scriptEnabled,
      selectedId,
      sessionRetentionLimit,
      setInspectorPosition,
      setQuickCategory,
      setSessionRetentionLimit,
      setTheme,
      setThemePreset,
      showToast,
      sidebarCollapsed,
      status.allowRemote,
      status.autoSystemProxy,
      status.bindAddr,
      status.port,
      status.running,
      status.systemProxyEnabled,
      status.systemProxyError,
      themePreset,
      throttleConfig.preset,
      toggleAllowRemote,
      toggleBreakAfterResponse,
      toggleBreakBeforeRequest,
      toggleCompactToolbar,
      toggleDropNonMatching,
      toggleForceNoCache,
      toggleInspector,
      toggleProxy,
      toggleSidebar,
      toggleSystemProxy,
      toggleTlsInterceptMode,
      trafficViewMode,
      unmarkSessions,
      upstreamProxyActiveLabel,
    ]
  );
  const showInlineSessionDiff =
    selectedIds.length === 2 && !inlineDiffDismissed;
  const selectedSessions = useMemo(() => {
    if (selectedIds.length === 0) return [];
    if (selectedIds.length <= 2) {
      const out: SessionSummary[] = [];
      for (const id of selectedIds) {
        const match = sessions.find((s) => s.id === id);
        if (match) out.push(match);
      }
      return out;
    }
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return selectedIds
      .map((id) => byId.get(id))
      .filter((s): s is SessionSummary => Boolean(s));
  }, [sessions, selectedIds]);

  const selectedSummary = useMemo(
    () =>
      selectedDetail?.summary ??
      (selectedId !== null
        ? sessions.find((s) => s.id === selectedId) ?? null
        : null),
    [selectedDetail, selectedId, sessions]
  );

  const handleQuickFilterByQuery = useCallback(
    (query: string) => {
      const clean = query.trim();
      if (!clean) return;
      setUseRegex(false);
      setFilterQuery(clean);
      setActiveSection("traffic");
      showToast(`Фильтр трафика: "${clean.slice(0, 48)}"`);
    },
    [setActiveSection, setFilterQuery, setUseRegex, showToast]
  );

  const handleFilterByHost = useCallback(
    (host: string) => {
      const clean = host.split(":")[0].trim();
      if (!clean) return;
      setMatrixEnabled(true);
      setFilterRules((prev) => {
        const exists = prev.some(
          (r) =>
            r.enabled &&
            r.action === "include" &&
            r.field === "host" &&
            r.operator === "contains" &&
            r.value.toLowerCase() === clean.toLowerCase()
        );
        if (exists) return prev;
        return [
          ...prev,
          {
            id: `f-host-${Date.now()}`,
            enabled: true,
            action: "include",
            logicalOp: "OR",
            field: "host",
            operator: "contains",
            value: clean,
          },
        ];
      });
      setActiveSection("traffic");
      showToast(`Фильтр по хосту: ${clean}`);
    },
    [setActiveSection, setFilterRules, setMatrixEnabled, showToast]
  );

  const handleFilterByStatus = useCallback(
    (statusCode: number) => {
      if (!Number.isFinite(statusCode) || statusCode <= 0) return;
      const val = String(statusCode);
      setMatrixEnabled(true);
      setFilterRules((prev) => {
        const exists = prev.some(
          (r) =>
            r.enabled &&
            r.action === "include" &&
            r.field === "status" &&
            r.operator === "equals" &&
            r.value === val
        );
        if (exists) return prev;
        return [
          ...prev,
          {
            id: `f-status-${Date.now()}`,
            enabled: true,
            action: "include",
            logicalOp: "OR",
            field: "status",
            operator: "equals",
            value: val,
          },
        ];
      });
      setActiveSection("traffic");
      showToast(`Фильтр по статусу: ${statusCode}`);
    },
    [setActiveSection, setFilterRules, setMatrixEnabled, showToast]
  );

  const handleResetAllTrafficFilters = useCallback(() => {
    setFilterQuery("");
    setUseRegex(false);
    setQuickCategory("all");
    resetAdvancedFilters();
  }, [resetAdvancedFilters, setFilterQuery, setQuickCategory, setUseRegex]);

  const handleAddHeaderMutationRule = useCallback(
    async (
      direction: HeaderMutationDirection,
      operation: HeaderMutationOp,
      headerName: string,
      headerValue: string,
      host?: string
    ) => {
      const cleanName = headerName.trim();
      if (!cleanName) return;
      const urlPattern = host?.split(":")[0].trim() || "*";
      const nextRule: HeaderMutationRule = {
        id: `hm-${Date.now()}`,
        enabled: true,
        name:
          operation === "remove"
            ? `Remove ${cleanName} (${direction})`
            : `Set ${cleanName} (${direction})`,
        direction,
        operation,
        headerName: cleanName,
        headerValue: operation === "remove" ? "" : headerValue,
        urlPattern,
      };
      await updateBackendFilterConfig({
        ...backendFilterConfig,
        headerMutationsEnabled: true,
        headerMutations: [nextRule, ...backendFilterConfig.headerMutations],
      });
      showToast(
        operation === "remove"
          ? `Добавлено правило Header Mutation: Remove ${cleanName}`
          : `Добавлено правило Header Mutation: Set ${cleanName}`
      );
      openPreferencesAt("filters", "headers");
    },
    [
      backendFilterConfig,
      openPreferencesAt,
      showToast,
      updateBackendFilterConfig,
    ]
  );

  const handleOpenStatisticsForSession = useCallback(
    (sessionId: number) => {
      setInlineDiffDismissed(true);
      setSelectedId(sessionId);
      setInspectorCollapsed(false);
      setStatisticsTriggerSeq((n) => n + 1);
    },
    [setInspectorCollapsed, setSelectedId]
  );

  const primaryProxyAddress = useMemo(() => {
    const host =
      status.bindMode === "specific" &&
      status.specificBindIp &&
      status.alsoBindLoopback === false
        ? status.specificBindIp
        : "127.0.0.1";
    return `${host}:${status.port}`;
  }, [
    status.alsoBindLoopback,
    status.bindMode,
    status.port,
    status.specificBindIp,
  ]);

  const handleCopyProxyAddress = useCallback(() => {
    void copyTextToClipboard(
      primaryProxyAddress,
      showToast,
      `Скопирован адрес прокси: ${primaryProxyAddress}`
    );
  }, [primaryProxyAddress, showToast]);

  const handleRootContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.defaultPrevented) return;
      if (shouldPreserveNativeContextMenu(e.target)) {
        return;
      }

      const editable = findEditableTextTarget(e.target);
      if (editable) {
        const snapshot = captureEditableSelection(editable);
        openContextMenu(
          e,
          buildEditableInputMenuItems({
            target: editable,
            snapshot,
            onNotify: showToast,
          }),
          { ariaLabel: "Text Editing Context Menu", restoreFocusTo: editable }
        );
        return;
      }

      const selectedText = getActiveReadOnlySelection();
      if (selectedText.length > 0) {
        openContextMenu(
          e,
          buildSelectionContextMenuItems({
            selectedText,
            onOpenTextWizard: (text, tab) => openTextWizardAt(tab, text),
            onQuickFilter: handleQuickFilterByQuery,
            onNotify: showToast,
          }),
          { ariaLabel: "Selection Context Menu" }
        );
        return;
      }

      // Suppress raw WebView2 browser menu (Back / Reload / Print / Inspect)
      e.preventDefault();
      closeContextMenu({ restoreFocus: false });
    },
    [
      closeContextMenu,
      handleQuickFilterByQuery,
      openContextMenu,
      openTextWizardAt,
      showToast,
    ]
  );

  const handleResizeHandleContextMenu = useCallback(
    (e: ContextMenuEventLike) => {
      openContextMenu(
        e,
        buildInspectorChromeContextMenu({
          inspectorCollapsed,
          inspectorPosition,
          onExpandOrCollapse: toggleInspector,
          onSetPosition: setInspectorPosition,
          onToggleSplitDirection: toggleInspectorSplitDirection,
          onResetPanelLayout: handleResetPanelLayout,
        }),
        { ariaLabel: "Panel Layout Context Menu" }
      );
    },
    [
      handleResetPanelLayout,
      inspectorCollapsed,
      inspectorPosition,
      openContextMenu,
      setInspectorPosition,
      toggleInspector,
      toggleInspectorSplitDirection,
    ]
  );

  const handleFooterContextMenu = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      openContextMenu(
        e,
        buildFooterContextMenu({
          proxyAddress: primaryProxyAddress,
          proxyRunning: status.running,
          systemProxyEnabled: status.systemProxyEnabled,
          onToggleCapture: () => void toggleProxy(),
          onToggleSystemProxy: () => void toggleSystemProxy(),
          onCopyProxyAddress: handleCopyProxyAddress,
          onCopyCliEnv: copyCliProxyEnv,
          onRunProxyDoctor: () =>
            openPreferencesAt("diagnosticsBackup", "proxyDoctor"),
          onPurgeSqlite: () => setConfirmSqlitePurgeOpen(true),
        }),
        { ariaLabel: "Status Footer Context Menu" }
      );
    },
    [
      copyCliProxyEnv,
      handleCopyProxyAddress,
      openContextMenu,
      openPreferencesAt,
      primaryProxyAddress,
      status.running,
      status.systemProxyEnabled,
      toggleProxy,
      toggleSystemProxy,
    ]
  );

  const hasAnyActiveFilter = Boolean(
    filterQuery.trim() || quickCategory !== "all" || activeFilterBadgeCount > 0
  );

  const handleWaterfallRowContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, session: SessionSummary) => {
      const isAlreadySelected = selectedIds.includes(session.id);
      if (!isAlreadySelected) {
        setSelectedId(session.id);
      }
      const targetIds =
        isAlreadySelected && selectedIds.length > 0 ? selectedIds : [session.id];

      const items = buildTrafficRowContextMenu({
        session,
        targetIds,
        selectedId,
        onReplaySessions: (ids) => void replaySessions(ids),
        onSendToComposer: (id) => void loadSessionIntoComposer(id),
        onCompareWithSession: (id) => {
          setInlineDiffDismissed(false);
          compareWithSession(id);
        },
        onOpenDiffModal: () => openDiffWithPairSmart(),
        onOpenStatistics: handleOpenStatisticsForSession,
        onOpenTrafficStatistics: openTrafficStatisticsModal,
        onCopyUrl: copyUrlsForIds,
        onCopyCurl: (id) => void copySessionAsCurl(id),
        onGenerateClientCode: (id) => void openCodeGeneratorForSession(id),
        onCopyHeaders: (id, kind) => void copySessionHeaders(id, kind),
        onExportSelectedSessions: (ids, fmt) =>
          void exportSelectedSessionsAs(ids, fmt),
        onExportOpenApi: (ids) => openOpenApiExportModal(ids),
        onSaveSessionBody: (id, isResponse) =>
          void saveSessionBodyAs(id, isResponse),
        onAnnotateSessions: openAnnotationFor,
        onUnmarkSessions: (ids) => void unmarkSessions(ids),
        onCreateRuleFromSession: (s) => void handleCreateRuleFromSession(s),
        onAddBreakpoint: (stage, pattern) =>
          void applyQuickExecBpu(stage, pattern),
        onFilterByHost: handleFilterByHost,
        onFilterByStatus: handleFilterByStatus,
        onFilterByProcess: (proc) => quickFilterByProcess(proc, "include"),
        onFilterByClientIp: (ip) => quickFilterByClientIp(ip, "include"),
        onAddClientIpToAllowlist: (ip) => void addLanClientToAllowlist(ip),
        onAlwaysInspectHost: (host) => void quickAlwaysInspectHost(host),
        onAlwaysPassthroughHost: (host) =>
          void quickAlwaysPassthroughHost(host),
        onDeleteSessions: (ids) => void deleteSessions(ids),
      });

      openContextMenu(e, items, {
        ariaLabel: `Действия для сессии #${session.id}`,
        minWidth: 240,
      });
    },
    [
      addLanClientToAllowlist,
      applyQuickExecBpu,
      compareWithSession,
      copySessionAsCurl,
      copySessionHeaders,
      copyUrlsForIds,
      deleteSessions,
      exportSelectedSessionsAs,
      handleCreateRuleFromSession,
      handleFilterByHost,
      handleFilterByStatus,
      handleOpenStatisticsForSession,
      loadSessionIntoComposer,
      openAnnotationFor,
      openCodeGeneratorForSession,
      openContextMenu,
      openDiffWithPairSmart,
      openOpenApiExportModal,
      openTrafficStatisticsModal,
      quickAlwaysInspectHost,
      quickAlwaysPassthroughHost,
      quickFilterByClientIp,
      quickFilterByProcess,
      replaySessions,
      saveSessionBodyAs,
      selectedId,
      selectedIds,
      setSelectedId,
      unmarkSessions,
    ]
  );

  const handleWaterfallEmptyContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.defaultPrevented) return;
      const items = buildTrafficEmptyContextMenu({
        visibleCount: filteredSessions.length,
        totalCount: sessions.length,
        proxyRunning: status.running,
        followTail,
        hasActiveFilters: hasAnyActiveFilter,
        isWaterfallView: true,
        onSelectAllVisible: () =>
          selectSessions(filteredSessions.map((s) => s.id)),
        onOpenTrafficStatistics: () => openTrafficStatisticsModal("filtered"),
        onToggleWaterfallView: () => setTrafficViewMode("grid"),
        onToggleCapture: () => void toggleProxy(),
        onToggleFollowTail: () => setFollowTail((v) => !v),
        onImportArchive: () => void importArchiveDialog(),
        onSaveAllSessions: () => void exportAllSessionsAs(),
        onResetFilters: handleResetAllTrafficFilters,
        onResetColumns: resetColumns,
        onClearAllSessions: () => void clearAllSessions(),
      });

      openContextMenu(e, items, {
        ariaLabel: "Действия Waterfall Timeline",
        minWidth: 232,
      });
    },
    [
      clearAllSessions,
      exportAllSessionsAs,
      filteredSessions,
      followTail,
      handleResetAllTrafficFilters,
      hasAnyActiveFilter,
      importArchiveDialog,
      openContextMenu,
      openTrafficStatisticsModal,
      resetColumns,
      selectSessions,
      sessions.length,
      setFollowTail,
      status.running,
      toggleProxy,
    ]
  );

  const renderTrafficGrid = () =>
    trafficViewMode === "waterfall" ? (
      <WaterfallTimeline
        sessions={filteredSessions}
        totalSessionsCount={sessions.length}
        selectedId={selectedId}
        selectedIds={selectedIds}
        onSelectSession={(id) => {
          setSelectedId(id);
          const paused = pausedBreakpoints.find((p) => p.sessionId === id);
          if (paused) {
            openBreakpointsAt("intercept", paused.breakpointId);
          }
        }}
        onToggleSelectSession={toggleSessionSelection}
        onFocusInspector={handleFocusInspector}
        onOpenTrafficStatistics={() => openTrafficStatisticsModal("filtered")}
        onSwitchToGrid={() => setTrafficViewMode("grid")}
        onRowContextMenu={handleWaterfallRowContextMenu}
        onEmptyAreaContextMenu={handleWaterfallEmptyContextMenu}
        followTail={followTail}
        onDisableFollowTail={() => setFollowTail(false)}
      />
    ) : (
      <TrafficGrid
        gridRef={trafficGridRef}
        sessions={filteredSessions}
        totalSessionsCount={sessions.length}
        proxyRunning={status.running}
        hasActiveFilters={hasAnyActiveFilter}
        selectedId={selectedId}
        selectedIds={selectedIds}
        visibleColumns={visibleColumns}
        columnWidths={columnWidths}
        onColumnWidthChange={setColumnWidth}
        onToggleColumnVisibility={toggleColumnVisibility}
        onResetColumns={resetColumns}
        onSelectSession={(id) => {
          setSelectedId(id);
          const paused = pausedBreakpoints.find((p) => p.sessionId === id);
          if (paused) {
            openBreakpointsAt("intercept", paused.breakpointId);
          }
        }}
        onToggleSelectSession={toggleSessionSelection}
        onSelectSessionRange={selectSessionRange}
        onSelectAllSessions={selectSessions}
        onSortedSessionsChange={(list) => {
          sortedSessionsRef.current = list;
        }}
        onFocusInspector={handleFocusInspector}
        onOpenStatistics={handleOpenStatisticsForSession}
        onOpenTrafficStatistics={openTrafficStatisticsModal}
        onToggleWaterfallView={() => setTrafficViewMode("waterfall")}
        onDeleteSessions={(ids) => void deleteSessions(ids)}
        onReplaySessions={(ids) => void replaySessions(ids)}
        onUnmarkSessions={(ids) => void unmarkSessions(ids)}
        onCopyUrl={copyUrlsForIds}
        onCopyCurl={(id) => void copySessionAsCurl(id)}
        onGenerateClientCode={(id) => void openCodeGeneratorForSession(id)}
        onCopyHeaders={(id, kind) => void copySessionHeaders(id, kind)}
        onCompareWithSession={(id) => {
          setInlineDiffDismissed(false);
          compareWithSession(id);
        }}
        onSwapCompare={swapCompareSessions}
        onOpenDiffModal={() => openDiffWithPairSmart()}
        onAnnotateSessions={openAnnotationFor}
        onSendToComposer={(id) => void loadSessionIntoComposer(id)}
        onCreateRuleFromSession={(s) => void handleCreateRuleFromSession(s)}
        onAddBreakpoint={(stage, pattern) =>
          void applyQuickExecBpu(stage, pattern)
        }
        onExportSelectedSessions={(ids, fmt) =>
          void exportSelectedSessionsAs(ids, fmt)
        }
        onExportOpenApi={(ids) => openOpenApiExportModal(ids)}
        onSaveSessionBody={(id, isResponse) =>
          void saveSessionBodyAs(id, isResponse)
        }
        onFilterByHost={handleFilterByHost}
        onFilterByStatus={handleFilterByStatus}
        onFilterByProcess={(proc) => quickFilterByProcess(proc, "include")}
        onFilterByClientIp={(ip) => quickFilterByClientIp(ip, "include")}
        onAddClientIpToAllowlist={(ip) => void addLanClientToAllowlist(ip)}
        onAlwaysInspectHost={(host) => void quickAlwaysInspectHost(host)}
        onAlwaysPassthroughHost={(host) =>
          void quickAlwaysPassthroughHost(host)
        }
        onAddHostToTlsBypass={(host) => void quickAddTlsBypassHost(host)}
        onDisableFollowTail={() => setFollowTail(false)}
        onToggleCapture={() => void toggleProxy()}
        onToggleFollowTail={() => setFollowTail((v) => !v)}
        onClearAllSessions={() => void clearAllSessions()}
        onImportArchive={() => void importArchiveDialog()}
        onSaveAllSessions={() => void exportAllSessionsAs()}
        onResetFilters={handleResetAllTrafficFilters}
        onNotify={showToast}
        thresholds={thresholds}
        followTail={followTail}
      />
    );

  const renderInspectorOrDiff = () =>
    showInlineSessionDiff ? (
      <React.Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center text-xs text-muted">
            Loading Session Diff...
          </div>
        }
      >
        <SessionDiffView
          leftDetail={diffLeftDetail}
          rightDetail={diffRightDetail}
          sessions={filteredSessions.length >= 2 ? filteredSessions : sessions}
          resolvedTheme={resolvedTheme}
          defaultSideBySide
          onSelectPair={handleSelectDiffTabPair}
          onSwapPair={handleSwapDiffTabPair}
          onAnnotateSession={(id) => openAnnotationFor([id])}
          onExpandTab={() => setActiveSection("diff")}
          onOpenStatistics={() => {
            setInlineDiffDismissed(true);
            setStatisticsTriggerSeq((n) => n + 1);
          }}
          onCloseDiff={() => setInlineDiffDismissed(true)}
          onNotify={showToast}
        />
      </React.Suspense>
    ) : (
      <SessionInspector
        detail={selectedDetail}
        selectedSessions={selectedSessions}
        onSelectSession={(id) => {
          setInlineDiffDismissed(true);
          setSelectedId(id);
        }}
        statisticsOpenTrigger={statisticsTriggerSeq}
        resolvedTheme={resolvedTheme}
        containerRef={inspectorContainerRef}
        onReturnFocusToGrid={focusTrafficGrid}
        inspectorPosition={inspectorPosition}
        onChangeInspectorPosition={setInspectorPosition}
        splitDirection={resolvedInspectorSplitDirection}
        inspectorSplitDirection={inspectorSplitDirection}
        onToggleSplitDirection={toggleInspectorSplitDirection}
        onCollapseInspector={() => {
          setInspectorCollapsed(true);
          focusTrafficGrid();
        }}
        externalHexTrigger={hexTriggerSeq}
        onReplaySession={(id) => void replaySessions([id])}
        onSendToComposer={(id) => void loadSessionIntoComposer(id)}
        onCopyCurl={(id) => void copySessionAsCurl(id)}
        onCreateRuleFromSession={(s) => void handleCreateRuleFromSession(s)}
        onFilterByHost={handleFilterByHost}
        onQuickFilterByValue={handleQuickFilterByQuery}
        onAddHeaderMutationRule={(dir, op, name, val, host) =>
          void handleAddHeaderMutationRule(dir, op, name, val, host)
        }
        onFilterByProcess={(proc) => quickFilterByProcess(proc, "include")}
        onFilterByClientIp={(ip) => quickFilterByClientIp(ip, "include")}
        onAlwaysInspectHost={(host) => void quickAlwaysInspectHost(host)}
        onAddHostToTlsBypass={(host) => void quickAddTlsBypassHost(host)}
        onOpenTextWizard={(text, tab) => openTextWizardAt(tab, text)}
        onQuickAddBpu={(pattern) => void applyQuickExecBpu("request", pattern)}
        onAnnotateSession={(id) => openAnnotationFor([id])}
        onOpenDiffWithSession={(id) => openDiffWithPairSmart(id)}
        canResumePairDiff={selectedIds.length === 2 && inlineDiffDismissed}
        onResumePairDiff={() => setInlineDiffDismissed(false)}
        onSaveBodyFile={(id, isResponse) =>
          void saveSessionBodyAs(id, isResponse)
        }
        onOpenTimeoutSettings={handleOpenTimeoutSettings}
        onResetPanelLayout={handleResetPanelLayout}
        onNotify={showToast}
      />
    );

  return (
    <div
      onContextMenu={handleRootContextMenu}
      onDragEnter={handleRootDragEnter}
      onDragOver={handleRootDragOver}
      onDragLeave={handleRootDragLeave}
      onDrop={handleRootDrop}
      className="relative flex h-screen w-screen flex-col overflow-hidden bg-canvas text-fg"
    >
      {fileDropActive && (
        <div
          aria-live="polite"
          className="pointer-events-none fixed inset-0 z-[120] flex items-center justify-center bg-canvas/75 backdrop-blur-xs"
        >
          <div className="flex flex-col items-center gap-2.5 rounded-xl border-2 border-dashed border-accent bg-surface/95 px-8 py-6 text-center shadow-popover">
            <Upload className="h-8 w-8 text-accent" />
            <p className="text-sm font-semibold text-fg">
              Отпустите файл для импорта сессий во FluxProxy
            </p>
            <p className="font-mono text-xs text-muted">
              {fileDropLabel || "Поддерживаются форматы .har (HAR 1.2), .saz (Fiddler Classic), .json"}
            </p>
          </div>
        </div>
      )}

      {/* Compact Desktop Menu Bar (`File`, `Edit`, `Rules`, `View`, `Tools`, `Help`) */}
      <MenuBar
        status={status}
        totalCount={sessions.length}
        filteredCount={filteredSessions.length}
        hasSelection={effectiveSelectedIds.length > 0}
        selectedCount={effectiveSelectedIds.length}
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        onToggleProxy={() => void toggleProxy()}
        onToggleAllowRemote={() => void toggleAllowRemote()}
        onToggleSystemProxy={() => void toggleSystemProxy()}
        onToggleAutoSystemProxy={() => void toggleAutoSystemProxy()}
        onSaveAllSessionsAs={() => void exportAllSessionsAs()}
        onSaveSelectedSessionsAs={() => void exportSelectedSessionsAs()}
        onOpenSanitizedExport={openSanitizedExportModal}
        onOpenOpenApiExport={() => openOpenApiExportModal()}
        onImportArchive={() => void importArchiveDialog()}
        onSaveSqlite={() => void saveToSqlite()}
        onLoadSqlite={() => void loadFromSqlite()}
        onPurgeSqliteArchive={() => setConfirmSqlitePurgeOpen(true)}
        onClearSessions={() => void clearAllSessions()}
        onExportSettingsProfile={() => void handleExportSettingsProfile()}
        onImportSettingsProfile={() => void handleImportSettingsProfileDialog()}
        onOpenPreferences={() => openPreferencesAt("general")}
        onSelectAllSessions={() => handleSelectAllSessions()}
        onCopyUrl={() => copyUrlsForIds(effectiveSelectedIds)}
        onCopyCurl={() => {
          if (selectedId !== null) void copySessionAsCurl(selectedId);
        }}
        onGenerateClientCode={() => {
          const id = selectedId ?? effectiveSelectedIds[0] ?? null;
          if (id !== null) void openCodeGeneratorForSession(id);
        }}
        onCopyRequestHeaders={() => {
          if (selectedId !== null) void copySessionHeaders(selectedId, "request");
        }}
        onCopyResponseHeaders={() => {
          if (selectedId !== null)
            void copySessionHeaders(selectedId, "response");
        }}
        onAnnotateSelected={() => openAnnotationFor(effectiveSelectedIds)}
        onUnmarkSelected={() => {
          if (effectiveSelectedIds.length > 0) {
            void unmarkSessions(effectiveSelectedIds);
          }
        }}
        onDeleteSelected={() => {
          if (effectiveSelectedIds.length > 0) {
            void deleteSessions(effectiveSelectedIds);
          }
        }}
        onFocusSearch={handleFocusSearch}
        breakpointConfig={breakpointConfig}
        onToggleBreakBeforeRequest={() => void toggleBreakBeforeRequest()}
        onToggleBreakAfterResponse={() => void toggleBreakAfterResponse()}
        onDisableAllBreakpoints={() => void disableAllBreakpoints()}
        onOpenBreakpointsModal={() =>
          openBreakpointsAt(
            pausedBreakpoints.length > 0 ? "intercept" : "rules"
          )
        }
        isForceNoCacheActive={isForceNoCacheActive}
        onToggleForceNoCache={() => void toggleForceNoCache()}
        hideConnectTunnels={thresholds.hideConnectTunnels}
        onToggleHideConnectTunnels={() =>
          setThresholds((prev) => ({
            ...prev,
            hideConnectTunnels: !prev.hideConnectTunnels,
          }))
        }
        tlsInterceptMode={backendFilterConfig.tlsInterceptMode}
        targetHostsCount={activeTargetHostsCount}
        onToggleTlsInterceptMode={() => void toggleTlsInterceptMode()}
        onOpenFilterDrawer={() => openPreferencesAt("filters", "matrix")}
        onOpenHostsListDrawer={() => openPreferencesAt("filters", "hostsList")}
        onOpenTlsModeDrawer={() => openPreferencesAt("tlsCertificates", "mitmBypass")}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        inspectorCollapsed={inspectorCollapsed}
        onToggleInspector={toggleInspector}
        inspectorPosition={inspectorPosition}
        onSetInspectorPosition={setInspectorPosition}
        followTail={followTail}
        onToggleFollowTail={() => setFollowTail((v) => !v)}
        compactToolbar={compactToolbar}
        onToggleCompactToolbar={toggleCompactToolbar}
        toolbarGroups={toolbarGroups}
        onToggleToolbarGroup={toggleToolbarGroup}
        onResetToolbarGroups={resetToolbarGroups}
        visibleColumns={visibleColumns}
        onToggleColumnVisibility={toggleColumnVisibility}
        onResetColumns={resetColumns}
        onResetPanelLayout={handleResetPanelLayout}
        onOpenThemeGallery={() => openPreferencesAt("uiColumns")}
        trafficViewMode={trafficViewMode}
        onSetTrafficViewMode={handleSetTrafficViewMode}
        onOpenTrafficStatistics={() => openTrafficStatisticsModal("filtered")}
        onReplaySelected={() => {
          if (effectiveSelectedIds.length > 0) {
            void replaySessions(effectiveSelectedIds);
          }
        }}
        onSendSelectedToComposer={() => {
          const targetId = selectedId ?? effectiveSelectedIds[0] ?? null;
          if (targetId !== null) void loadSessionIntoComposer(targetId);
        }}
        onOpenSessionDiff={() => openDiffWithPairSmart()}
        onOpenTextWizard={() => setActiveSection("wizard")}
        onOpenHexConverter={() => openTextWizardAt("hex")}
        onInspectInHex={handleInspectInHex}
        onOpenCompressionCodec={() => openTextWizardAt("compression")}
        onOpenMobileSetup={() => openPreferencesAt("tlsCertificates", "mobileSetup")}
        onOpenCertificates={() => setCertModalOpen(true)}
        onOpenClientCertificates={() =>
          openPreferencesAt("tlsCertificates", "clientCerts")
        }
        onOpenHostRemap={() => openPreferencesAt("networkRouting", "hostsRemap")}
        activeHostRemapCount={activeHostRemapCount}
        onOpenUpstreamProxy={() =>
          openPreferencesAt("networkRouting", "upstreamProxy")
        }
        upstreamProxyActiveLabel={upstreamProxyActiveLabel}
        sessionRetentionLimit={sessionRetentionLimit}
        onSetSessionRetentionLimit={(limit) =>
          void setSessionRetentionLimit(limit)
        }
        onOpenCustomRetentionLimit={handleOpenCustomRetentionLimit}
        dropNonMatching={dropNonMatching}
        onToggleDropNonMatching={() => void toggleDropNonMatching()}
        onGenerateStress10k={generateStress10k}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onOpenShortcutsModal={() => setShortcutsModalOpen(true)}
        onOpenProxyDoctor={() =>
          openPreferencesAt("diagnosticsBackup", "proxyDoctor")
        }
        onCopyCliEnv={copyCliProxyEnv}
        onResetAllUiPreferences={resetAllUiPreferences}
      />

      <div className="flex flex-1 overflow-hidden">
        {!sidebarCollapsed && (
          <Sidebar
            activeSection={activeSection}
            onSelectSection={setActiveSection}
            onDropSessionToComposer={(id) => void loadSessionIntoComposer(id)}
            onOpenBreakpoints={() =>
              openBreakpointsAt(
                pausedBreakpoints.length > 0 ? "intercept" : "rules"
              )
            }
            breakpointsArmed={breakpointsArmed}
            pausedBreakpointCount={pausedBreakpoints.length}
            onOpenSessionDiff={() => openDiffWithPairSmart()}
            diffActive={activeSection === "diff" || showInlineSessionDiff}
            onOpenTextWizard={() => setActiveSection("wizard")}
            activeRulesCount={activeRulesCount}
            pythonScriptEnabled={Boolean(
              scriptEnabled &&
                (pythonRunnerStatus?.running || pythonRunnerStatus?.isSimulator)
            )}
            onOpenSettings={() => openPreferencesAt("general")}
            settingsOpen={settingsModalOpen}
            onCollapseSidebar={toggleSidebar}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <TopToolbar
            status={status}
            searchInputRef={searchInputRef}
            onFocusTrafficGrid={focusTrafficGrid}
            filterQuery={filterQuery}
            onFilterQueryChange={setFilterQuery}
            useRegex={useRegex}
            onToggleRegex={() => setUseRegex((v) => !v)}
            regexError={regexError}
            quickCategory={quickCategory}
            onSelectCategory={setQuickCategory}
            activeFilterCount={activeFilterBadgeCount}
            activePresetName={activePreset?.name ?? null}
            onOpenFilterDrawer={() => openPreferencesAt("filters", "matrix")}
            onResetAdvancedFilters={resetAdvancedFilters}
            isForceNoCacheActive={isForceNoCacheActive}
            onToggleForceNoCache={() => void toggleForceNoCache()}
            breakpointConfig={breakpointConfig}
            pausedBreakpointCount={pausedBreakpoints.length}
            onToggleBreakBeforeRequest={() => void toggleBreakBeforeRequest()}
            onToggleBreakAfterResponse={() => void toggleBreakAfterResponse()}
            onOpenBreakpointsModal={() =>
              openBreakpointsAt(
                pausedBreakpoints.length > 0 ? "intercept" : "rules"
              )
            }
            markedCount={markedSessionsCount}
            followTail={followTail}
            onToggleFollowTail={() => setFollowTail((v) => !v)}
            compactToolbar={compactToolbar}
            onToggleCompactToolbar={toggleCompactToolbar}
            onResetPanelLayout={handleResetPanelLayout}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            toolbarGroups={toolbarGroups}
            visibleColumns={visibleColumns}
            onToggleColumnVisibility={toggleColumnVisibility}
            onResetColumns={resetColumns}
            onToggleProxy={() => void toggleProxy()}
            onToggleAllowRemote={() => void toggleAllowRemote()}
            onToggleSystemProxy={() => void toggleSystemProxy()}
            onToggleAutoSystemProxy={() => void toggleAutoSystemProxy()}
            tlsInterceptMode={backendFilterConfig.tlsInterceptMode}
            targetHostsCount={activeTargetHostsCount}
            hideConnectTunnels={thresholds.hideConnectTunnels}
            onSelectTlsInterceptMode={(mode) => void setTlsInterceptMode(mode)}
            onToggleTlsInterceptMode={() => void toggleTlsInterceptMode()}
            onQuickAddTargetHost={(pattern) =>
              void quickAlwaysInspectHost(pattern)
            }
            onToggleHideConnectTunnels={() =>
              setThresholds((prev) => ({
                ...prev,
                hideConnectTunnels: !prev.hideConnectTunnels,
              }))
            }
            onOpenTlsModeDrawer={() =>
              openPreferencesAt("tlsCertificates", "mitmBypass")
            }
            sessionRetentionLimit={sessionRetentionLimit}
            onSetSessionRetentionLimit={(limit) =>
              void setSessionRetentionLimit(limit)
            }
            dropNonMatching={dropNonMatching}
            onToggleDropNonMatching={() => void toggleDropNonMatching()}
            droppedSessionsCount={storageStats.droppedSessionsCount}
            customRetentionTriggerSeq={customRetentionTriggerSeq}
            onClearSessions={() => void clearAllSessions()}
            throttleConfig={throttleConfig}
            onChangeThrottleConfig={(cfg) => void handleChangeThrottleConfig(cfg)}
            activeHostRemapCount={activeHostRemapCount}
            upstreamProxyEnabled={Boolean(upstreamProxyActiveLabel)}
            activeClientCertsCount={activeClientCertsCount}
            onOpenNetworkRouting={(subTab) =>
              openPreferencesAt("networkRouting", subTab ?? "throttling")
            }
            onOpenAppearanceSettings={() => openPreferencesAt("uiColumns")}
            onNotify={showToast}
          />

          <BreakpointBanner
            config={breakpointConfig}
            pausedItems={pausedBreakpoints}
            onInspectItem={(bpId) => openBreakpointsAt("intercept", bpId)}
            onOpenRules={() => openBreakpointsAt("rules")}
            onQuickResolve={(res) => void resolvePausedBreakpoint(res)}
            onResumeAll={(action) => void resumeAllBreakpoints(action)}
            onDisableAll={() => void disableAllBreakpoints()}
          />

          <main className="flex-1 overflow-hidden">
            {/* Tab 1: Traffic */}
            <div
              hidden={activeSection !== "traffic"}
              className={
                activeSection === "traffic"
                  ? "flex h-full w-full flex-col overflow-hidden"
                  : "hidden"
              }
            >
              <SectionHeader
                sectionId="traffic"
                compact
                icon={<Activity className="h-3.5 w-3.5 text-accent" />}
                badges={
                  <span className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-muted ring-1 ring-hairline tabular-nums">
                    {filteredSessions.length.toLocaleString()} /{" "}
                    {sessions.length.toLocaleString()}
                  </span>
                }
                actions={
                  <div className="flex items-center gap-1.5">
                    <div
                      role="group"
                      aria-label="Traffic view mode"
                      className="inline-flex items-center rounded border border-hairline bg-canvas p-0.5 text-[11px]"
                    >
                      <button
                        type="button"
                        aria-pressed={trafficViewMode === "grid"}
                        onClick={() => setTrafficViewMode("grid")}
                        title="Table Grid View"
                        className={`inline-flex h-5 items-center gap-1 rounded px-1.5 font-medium transition-colors ${
                          trafficViewMode === "grid"
                            ? "bg-selected text-fg"
                            : "text-muted hover:text-fg"
                        }`}
                      >
                        <Table2 className="h-3 w-3" aria-hidden="true" />
                        <span>Grid</span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={trafficViewMode === "waterfall"}
                        onClick={() => setTrafficViewMode("waterfall")}
                        title="Waterfall Timeline View"
                        className={`inline-flex h-5 items-center gap-1 rounded px-1.5 font-medium transition-colors ${
                          trafficViewMode === "waterfall"
                            ? "bg-selected text-fg"
                            : "text-muted hover:text-fg"
                        }`}
                      >
                        <BarChartHorizontal
                          className="h-3 w-3"
                          aria-hidden="true"
                        />
                        <span>Waterfall</span>
                      </button>
                    </div>
                    <button
                      type="button"
                      disabled={filteredSessions.length === 0}
                      onClick={() => openTrafficStatisticsModal("filtered")}
                      title="Открыть сводную статистику трафика и Markdown-отчёт"
                      className="inline-flex h-6 items-center gap-1 rounded border border-hairline bg-elevated px-2 text-[11px] font-medium text-fg transition-colors hover:border-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <BarChart3
                        className="h-3 w-3 text-accent"
                        aria-hidden="true"
                      />
                      <span>Statistics</span>
                    </button>
                  </div>
                }
              />

              <div className="min-h-0 flex-1 overflow-hidden">
                {inspectorPosition === "bottom" && (
                  <div className="flex h-full w-full flex-col overflow-hidden">
                    <PanelGroup
                      ref={bottomInnerGroupRef}
                      key="traffic-layout-bottom"
                      autoSaveId={FLUX_PANEL_AUTOSAVE_IDS.bottomInner}
                      storage={SAFE_PANEL_STORAGE}
                      direction="vertical"
                      className="min-h-0 w-full flex-1"
                    >
                      <Panel
                        id="traffic-grid-top"
                        order={1}
                        defaultSize={inspectorCollapsed ? 100 : 54}
                        minSize={22}
                      >
                        {renderTrafficGrid()}
                      </Panel>
                      {!inspectorCollapsed && (
                        <>
                          <PanelResizeHandle
                            onDoubleClick={handleResetBottomInnerGroup}
                            onContextMenu={handleResizeHandleContextMenu}
                            title="Double-click to reset Traffic / Inspector split"
                            className="h-1 w-full bg-hairline transition-colors hover:bg-accent/60"
                          />
                          <Panel
                            id="session-inspector-bottom"
                            order={2}
                            defaultSize={46}
                            minSize={20}
                            collapsible
                            collapsedSize={0}
                            onCollapse={() => setInspectorCollapsed(true)}
                          >
                            {renderInspectorOrDiff()}
                          </Panel>
                        </>
                      )}
                    </PanelGroup>

                    {inspectorCollapsed && (
                      <CollapsedInspectorBar
                        position="bottom"
                        selectedSession={selectedSummary}
                        selectedCount={effectiveSelectedIds.length}
                        onExpand={handleFocusInspector}
                        onOpenStatistics={handleOpenStatistics}
                        onChangePosition={setInspectorPosition}
                        onToggleSplitDirection={toggleInspectorSplitDirection}
                        onResetPanelLayout={handleResetPanelLayout}
                      />
                    )}
                  </div>
                )}

                {inspectorPosition === "right" && (
                  <div className="flex h-full w-full flex-row overflow-hidden">
                    <PanelGroup
                      ref={rightGroupRef}
                      key="traffic-layout-right"
                      autoSaveId={FLUX_PANEL_AUTOSAVE_IDS.right}
                      storage={SAFE_PANEL_STORAGE}
                      direction="horizontal"
                      className="h-full min-w-0 flex-1"
                    >
                      <Panel
                        id="traffic-grid-left"
                        order={1}
                        defaultSize={inspectorCollapsed ? 100 : 56}
                        minSize={26}
                      >
                        {renderTrafficGrid()}
                      </Panel>

                      {!inspectorCollapsed && (
                        <>
                          <PanelResizeHandle
                            onDoubleClick={handleResetRightGroup}
                            onContextMenu={handleResizeHandleContextMenu}
                            title="Double-click to reset workspace panel split"
                            className="w-1 bg-hairline transition-colors hover:bg-accent/60"
                          />
                          <Panel
                            id="session-inspector-right"
                            order={2}
                            defaultSize={44}
                            minSize={22}
                            collapsible
                            collapsedSize={0}
                            onCollapse={() => setInspectorCollapsed(true)}
                          >
                            {renderInspectorOrDiff()}
                          </Panel>
                        </>
                      )}
                    </PanelGroup>

                    {inspectorCollapsed && (
                      <CollapsedInspectorBar
                        position="right"
                        selectedSession={selectedSummary}
                        selectedCount={effectiveSelectedIds.length}
                        onExpand={handleFocusInspector}
                        onOpenStatistics={handleOpenStatistics}
                        onChangePosition={setInspectorPosition}
                        onToggleSplitDirection={toggleInspectorSplitDirection}
                        onResetPanelLayout={handleResetPanelLayout}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Tab 2: Composer (kept mounted once visited to preserve unsent request draft) */}
            {visitedSections.composer && (
              <div
                hidden={activeSection !== "composer"}
                className={
                  activeSection === "composer"
                    ? "h-full w-full overflow-hidden"
                    : "hidden"
                }
              >
                <ComposerPanel
                  draftRequest={composerDraft}
                  resolvedTheme={resolvedTheme}
                  defaultComposerTimeoutSec={upstreamTimeouts.composerTimeoutSec}
                  onLoadSessionIntoComposer={(id) =>
                    void loadSessionIntoComposer(id)
                  }
                  onSessionCreated={(detail) => setSelectedId(detail.summary.id)}
                  onBackToTraffic={() => setActiveSection("traffic")}
                  onInspectSessionInTraffic={handleInspectSessionFromComposer}
                  onGenerateCode={openCodeGeneratorForComposerDraft}
                  onNotify={showToast}
                />
              </div>
            )}

            {/* Tab 3: AutoResponder */}
            {visitedSections.rules && (
              <div
                hidden={activeSection !== "rules"}
                className={
                  activeSection === "rules"
                    ? "h-full w-full overflow-hidden"
                    : "hidden"
                }
              >
                <AutoResponderPanel
                  enabled={autoResponderEnabled}
                  onToggleEnabled={handleSetAutoResponderEnabled}
                  rules={rules}
                  resolvedTheme={resolvedTheme}
                  onUpsertRule={async (rule) => {
                    const next = await proxyBridge.upsertRule(rule);
                    setRules(next);
                    persistAutoResponderStorage(autoResponderEnabled, next);
                    showToast(`Saved rule "${rule.name}"`);
                  }}
                  onDeleteRule={async (id) => {
                    const next = await proxyBridge.deleteRule(id);
                    setRules(next);
                    persistAutoResponderStorage(autoResponderEnabled, next);
                    showToast("Deleted AutoResponder rule");
                  }}
                  onNotify={showToast}
                />
              </div>
            )}

            {/* Tab 4: Breakpoints (non-blocking, preserves edits and rules draft) */}
            {visitedSections.breakpoints && (
              <div
                hidden={activeSection !== "breakpoints"}
                className={
                  activeSection === "breakpoints"
                    ? "flex h-full w-full flex-col overflow-hidden"
                    : "hidden"
                }
              >
                <React.Suspense
                  fallback={
                    <div className="flex flex-1 items-center justify-center text-xs text-muted">
                      Loading Breakpoints...
                    </div>
                  }
                >
                  <BreakpointsPanel
                    isActive={activeSection === "breakpoints"}
                    requestedMode={bpPanelMode}
                    selectedBreakpointId={selectedBpId}
                    requestSeq={bpRequestSeq}
                    pausedItems={pausedBreakpoints}
                    config={breakpointConfig}
                    resolvedTheme={resolvedTheme}
                    onBackToTraffic={() => setActiveSection("traffic")}
                    onUpdateConfig={updateBreakpointConfig}
                    onResolve={resolvePausedBreakpoint}
                    onResumeAll={resumeAllBreakpoints}
                    onNotify={showToast}
                  />
                </React.Suspense>
              </div>
            )}

            {/* Tab 5: Scripts */}
            {visitedSections.scripts && (
              <div
                hidden={activeSection !== "scripts"}
                className={
                  activeSection === "scripts"
                    ? "flex h-full w-full flex-col overflow-hidden"
                    : "hidden"
                }
              >
                <React.Suspense
                  fallback={
                    <div className="flex flex-1 items-center justify-center text-xs text-muted">
                      Loading Scripts...
                    </div>
                  }
                >
                  <ScriptingPanel
                    code={scriptCode}
                    enabled={scriptEnabled}
                    activePresetId={scriptActivePresetId}
                    status={pythonRunnerStatus}
                    logs={scriptConsoleLogs}
                    resolvedTheme={resolvedTheme}
                    isApplying={isApplyingScript}
                    onChangeCode={(nextCode) => {
                      setScriptCode(nextCode);
                      persistPythonScriptStorage(
                        scriptEnabled,
                        nextCode,
                        scriptActivePresetId
                      );
                    }}
                    onSelectPreset={handleSelectPythonPreset}
                    onApplyScript={handleApplyPythonScript}
                    onToggleEnabled={handleTogglePythonScript}
                    onRefreshStatus={handleRefreshPythonStatus}
                    onClearLogs={() => setScriptConsoleLogs([])}
                    onNotify={showToast}
                  />
                </React.Suspense>
              </div>
            )}

            {/* Tab 6: Session Diff (preserves selected A/B pair and diff options) */}
            {visitedSections.diff && (
              <div
                hidden={activeSection !== "diff"}
                className={
                  activeSection === "diff"
                    ? "flex h-full w-full flex-col overflow-hidden"
                    : "hidden"
                }
              >
                <React.Suspense
                  fallback={
                    <div className="flex flex-1 items-center justify-center text-xs text-muted">
                      Loading Session Diff...
                    </div>
                  }
                >
                  <SessionDiffView
                    leftDetail={resolvedDiffTabLeftDetail}
                    rightDetail={resolvedDiffTabRightDetail}
                    sessions={
                      filteredSessions.length >= 2 ? filteredSessions : sessions
                    }
                    resolvedTheme={resolvedTheme}
                    defaultSideBySide
                    showSectionHeader
                    onBackToTraffic={() => setActiveSection("traffic")}
                    onSelectPair={handleSelectDiffTabPair}
                    onSwapPair={handleSwapDiffTabPair}
                    onAnnotateSession={(id) => openAnnotationFor([id])}
                    onNotify={showToast}
                  />
                </React.Suspense>
              </div>
            )}

            {/* Tab 7: TextWizard (preserves input and tool state across switches) */}
            {visitedSections.wizard && (
              <div
                hidden={activeSection !== "wizard"}
                className={
                  activeSection === "wizard"
                    ? "flex h-full w-full flex-col overflow-hidden"
                    : "hidden"
                }
              >
                <React.Suspense
                  fallback={
                    <div className="flex flex-1 items-center justify-center text-xs text-muted">
                      Loading TextWizard...
                    </div>
                  }
                >
                  <TextWizardPanel
                    isActive={activeSection === "wizard"}
                    requestedTab={textWizardTab}
                    requestedInput={textWizardInput}
                    requestSeq={textWizardRequestSeq}
                    onBackToTraffic={() => setActiveSection("traffic")}
                    onNotify={showToast}
                  />
                </React.Suspense>
              </div>
            )}
          </main>
        </div>
      </div>

      {/* Compact Status Footer */}
      <footer
        onContextMenu={handleFooterContextMenu}
        className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-hairline bg-surface px-3 font-mono text-[11px] text-muted"
      >
        <div className="flex min-w-0 items-center gap-2.5 truncate">
          <span className="truncate">
            Engine:{" "}
            <strong className="font-semibold text-fg">
              {isTauriRuntime() ? "Tauri Rust MITM" : "Preview Simulator"}
            </strong>
          </span>
          <span className="text-subtle">•</span>
          <button
            type="button"
            onClick={() => void toggleSystemProxy()}
            title="Переключить системный прокси ОС"
            className={`shrink-0 hover:underline ${
              status.systemProxyError
                ? "text-status4xx-fg"
                : status.systemProxyEnabled
                  ? "text-status2xx-fg"
                  : "text-muted"
            }`}
          >
            {status.systemProxyError
              ? "SysProxy: Warn"
              : status.systemProxyEnabled
                ? `SysProxy: ${
                    status.bindMode === "specific" &&
                    status.specificBindIp &&
                    status.alsoBindLoopback === false
                      ? status.specificBindIp
                      : "127.0.0.1"
                  }:${status.port}`
                : status.running
                  ? "Port Only"
                  : "Proxy Off"}
          </button>
          {(status.systemProxyError || !status.running) && (
            <>
              <span className="text-subtle">•</span>
              <button
                type="button"
                onClick={() =>
                  openPreferencesAt("diagnosticsBackup", "proxyDoctor")
                }
                title={
                  status.systemProxyError
                    ? `Ошибка системного прокси: ${status.systemProxyError} — нажмите для диагностики Proxy Doctor (Ctrl+Shift+D)`
                    : "Прокси-движок остановлен — нажмите для диагностики Proxy Doctor (Ctrl+Shift+D)"
                }
                className="inline-flex shrink-0 items-center gap-1 rounded border border-rose-500/40 bg-rose-500/12 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-status5xx-fg transition-colors hover:bg-rose-500/20"
              >
                <Stethoscope aria-hidden="true" className="h-3 w-3" />
                <span>Fix with Proxy Doctor</span>
              </button>
            </>
          )}
          <span className="hidden text-subtle md:inline">•</span>
          {(() => {
            const boundIpsList =
              status.boundIps && status.boundIps.length > 0
                ? status.boundIps
                : [status.bindAddr];
            const boundEndpoints = boundIpsList
              .map((ip) => `${ip}:${status.port}`)
              .join(" + ");
            const effectiveMode =
              status.bindMode ??
              (status.allowRemote || status.bindAddr === "0.0.0.0"
                ? "all"
                : "loopback");
            const isRemoteActive = Boolean(
              effectiveMode === "all" ||
                (effectiveMode === "specific" &&
                  status.specificBindIp !== "127.0.0.1" &&
                  status.bindAddr !== "127.0.0.1") ||
                status.allowRemote
            );
            const prefix =
              effectiveMode === "all"
                ? "LAN"
                : effectiveMode === "specific"
                  ? "Bind"
                  : "Local";
            return (
              <button
                type="button"
                onClick={() =>
                  openPreferencesAt("tlsCertificates", "mobileSetup")
                }
                title={`Активные интерфейсы: ${boundEndpoints}. Нажмите для настройки мобильного подключения (Ctrl+Shift+M)`}
                className={`hidden shrink-0 font-mono hover:underline md:inline ${
                  isRemoteActive ? "text-status2xx-fg" : "text-muted"
                }`}
              >
                {`${prefix}: ${boundEndpoints}`}
              </button>
            );
          })()}
          <span className="hidden text-subtle md:inline">•</span>
          <button
            type="button"
            onClick={() => openPreferencesAt("tlsCertificates", "mitmBypass")}
            title="Настроить режим перехвата TLS MITM (Intercept All / Targeted Only Allowlist)"
            className={`hidden shrink-0 hover:underline md:inline ${
              backendFilterConfig.tlsInterceptMode === "targetedOnly"
                ? "text-status2xx-fg"
                : "text-muted"
            }`}
          >
            {backendFilterConfig.tlsInterceptMode === "targetedOnly"
              ? `MITM: Targeted (${activeTargetHostsCount})`
              : "MITM: All"}
          </button>
          {activeHostRemapCount > 0 && (
            <>
              <span className="hidden text-subtle md:inline">•</span>
              <button
                type="button"
                onClick={() =>
                  openPreferencesAt("networkRouting", "hostsRemap")
                }
                title={`Активных правил HOSTS Remapping: ${activeHostRemapCount}. Нажмите для управления (Ctrl+Shift+H)`}
                className="inline-flex shrink-0 items-center gap-1 text-accent hover:underline"
              >
                <Globe className="h-3 w-3" aria-hidden="true" />
                <span>HOSTS: {activeHostRemapCount}</span>
              </button>
            </>
          )}
          {upstreamProxyActiveLabel && (
            <>
              <span className="hidden text-subtle md:inline">•</span>
              <button
                type="button"
                onClick={() =>
                  openPreferencesAt("networkRouting", "upstreamProxy")
                }
                title={`Каскадирование через Upstream Proxy (${upstreamProxyActiveLabel}). Нажмите для настройки (Ctrl+Shift+U)`}
                className="inline-flex shrink-0 items-center gap-1 text-accent hover:underline"
              >
                <Network className="h-3 w-3" aria-hidden="true" />
                <span>UPSTREAM: {upstreamProxyActiveLabel}</span>
              </button>
            </>
          )}
          {throttleConfig.preset !== "none" && (
            <>
              <span className="text-subtle">•</span>
              {(() => {
                const def = THROTTLE_PRESET_DEFINITIONS.find(
                  (d) => d.id === throttleConfig.preset
                );
                const isOffline = throttleConfig.preset === "offline";
                const label = isOffline
                  ? "OFFLINE (503)"
                  : `${def ? def.shortLabel : throttleConfig.preset}: ↓${throttleConfig.downloadKbps} Kbps · ${throttleConfig.latencyMs}ms`;
                return (
                  <button
                    type="button"
                    onClick={() =>
                      void handleChangeThrottleConfig({
                        preset: "none",
                        downloadKbps: 0,
                        uploadKbps: 0,
                        latencyMs: 0,
                      })
                    }
                    title={`Активен Bandwidth Throttling (${label}). Нажмите, чтобы сбросить на No Throttling (полная скорость).`}
                    className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold transition-colors hover:brightness-110 ${
                      isOffline
                        ? "bg-status5xx-bg text-status5xx-fg"
                        : "bg-status4xx-bg text-status4xx-fg"
                    }`}
                  >
                    {isOffline ? (
                      <WifiOff className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <Gauge className="h-3 w-3" aria-hidden="true" />
                    )}
                    <span>{label}</span>
                  </button>
                );
              })()}
            </>
          )}
          {activeFilterBadgeCount > 0 && (
            <>
              <span className="text-subtle">•</span>
              <button
                type="button"
                onClick={() => openPreferencesAt("filters", "matrix")}
                className="shrink-0 text-accent hover:underline"
              >
                Filters: {activeFilterBadgeCount} (
                {filteredSessions.length.toLocaleString()}/
                {sessions.length.toLocaleString()})
              </button>
            </>
          )}
          {regexError && (
            <span className="truncate text-status5xx-fg">
              RegExp: {regexError}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {toastMessage && (
            <span className="max-w-[300px] truncate text-accent">
              {toastMessage}
            </span>
          )}
          <div className="flex shrink-0 items-center gap-1.5 tabular-nums text-muted">
            <button
              type="button"
              onClick={handleOpenCustomRetentionLimit}
              title={`Кольцевой буфер (Ring Buffer): ${
                sessionRetentionLimit === null
                  ? "All Sessions (без ограничений)"
                  : `Keep ${sessionRetentionLimit.toLocaleString("en-US")} сессий`
              } • Drop Non-Matching: ${
                dropNonMatching ? "ON" : "OFF"
              } — нажмите для настройки лимита`}
              className="transition-colors hover:text-fg"
            >
              RAM:{" "}
              <strong className="font-semibold text-fg">
                {storageStats.ramSessions.toLocaleString("en-US")}
              </strong>{" "}
              ses
            </button>
            <span aria-hidden="true">|</span>
            <button
              type="button"
              onClick={() => setConfirmSqlitePurgeOpen(true)}
              title={`Размер архива SQLite (sessions.sqlite + WAL): ${(
                storageStats.sqliteSizeBytes /
                (1024 * 1024)
              ).toFixed(2)} MB • Очистка при выходе: ${
                clearDbOnExit ? "ON" : "OFF"
              } — нажмите для очистки и VACUUM`}
              className="transition-colors hover:text-fg"
            >
              SQLite:{" "}
              <strong className="font-semibold text-fg">
                {(storageStats.sqliteSizeBytes / (1024 * 1024)).toFixed(1)} MB
              </strong>
            </button>
            <span aria-hidden="true">|</span>
            <button
              type="button"
              onClick={handleOpenCustomRetentionLimit}
              title={`Отброшено сессий фильтром (Drop Non-Matching): ${storageStats.droppedSessionsCount.toLocaleString(
                "en-US"
              )} — нажмите для настройки буфера`}
              className="transition-colors hover:text-fg"
            >
              Dropped:{" "}
              <strong
                className={`font-semibold ${
                  storageStats.droppedSessionsCount > 0
                    ? "text-status4xx-fg"
                    : "text-fg"
                }`}
              >
                {storageStats.droppedSessionsCount.toLocaleString("en-US")}
              </strong>
            </button>
          </div>
          <span className="hidden text-subtle 2xl:inline">•</span>
          <button
            type="button"
            onClick={() => setShortcutsModalOpen(true)}
            title="Открыть полный справочник горячих клавиш (?)"
            className="hidden text-subtle hover:text-fg 2xl:inline"
          >
            F12 Capture • Space Inspect • R Replay • M Mark • U Unmark • Del • Ctrl+F • ?
          </button>
        </div>
      </footer>

      <ShortcutsModal
        open={shortcutsModalOpen}
        onClose={() => setShortcutsModalOpen(false)}
      />

      {settingsModalOpen && (
        <React.Suspense fallback={null}>
          <SettingsModal
            open={settingsModalOpen}
            initialTab={settingsInitialTab}
            initialSubTab={settingsInitialSubTab}
            navigationSeq={settingsNavSeq}
            onClose={() => setSettingsModalOpen(false)}
            themePreference={preference}
            onSetTheme={setTheme}
            themePreset={themePreset}
            customColorOverrides={customColorOverrides}
            effectiveThemeTokens={effectiveTokens}
            onSetThemePreset={setThemePreset}
            onSetCustomColorOverride={setCustomColorOverride}
            onResetCustomColorOverride={resetCustomColorOverride}
            onResetCustomColorOverrides={resetCustomColorOverrides}
            compactToolbar={compactToolbar}
            onSetCompactToolbar={setCompactToolbar}
            sidebarCollapsed={sidebarCollapsed}
            onSetSidebarCollapsed={setSidebarCollapsed}
            inspectorCollapsed={inspectorCollapsed}
            onSetInspectorCollapsed={setInspectorCollapsed}
            inspectorPosition={inspectorPosition}
            onSetInspectorPosition={setInspectorPosition}
            inspectorSplitDirection={inspectorSplitDirection}
            onSetInspectorSplitDirection={setInspectorSplitDirection}
            onResetPanelLayout={handleResetPanelLayout}
            followTail={followTail}
            onSetFollowTail={setFollowTail}
            toolbarGroups={toolbarGroups}
            onToggleToolbarGroup={toggleToolbarGroup}
            onResetToolbarGroups={resetToolbarGroups}
            visibleColumns={visibleColumns}
            onToggleColumnVisibility={toggleColumnVisibility}
            columnWidths={columnWidths}
            onSetColumnWidth={setColumnWidth}
            onResetColumns={resetColumns}
            sessions={sessions}
            totalCount={sessions.length}
            filteredCount={filteredSessions.length}
            activePresetId={activePresetId}
            userPresets={customPresets}
            allPresets={allPresets}
            onApplyPreset={(presetId) => {
              if (presetId) {
                applyPreset(presetId);
              } else {
                resetAdvancedFilters();
              }
            }}
            onSaveCustomPreset={saveCustomPreset}
            onDeleteCustomPreset={deleteCustomPreset}
            matrixEnabled={matrixEnabled}
            onSetMatrixEnabled={setMatrixEnabled}
            filterRules={filterRules}
            onSetFilterRules={setFilterRules}
            ruleErrors={ruleErrors}
            detectedProcesses={detectedProcesses}
            onQuickProcessFilter={quickFilterByProcess}
            noiseThresholds={thresholds}
            onSetNoiseThresholds={setThresholds}
            hostFilters={hostListFilter}
            onSetHostFilters={setHostListFilter}
            onResetAdvancedFilters={resetAdvancedFilters}
            isForceNoCacheActive={isForceNoCacheActive}
            onToggleForceNoCache={toggleForceNoCache}
            status={status}
            onToggleProxy={toggleProxy}
            onSetProxyPort={setProxyPort}
            onSetAutoSystemProxy={setAutoSystemProxy}
            onSetAllowRemote={setAllowRemote}
            onSetBindConfiguration={setBindConfiguration}
            throttleConfig={throttleConfig}
            onChangeThrottleConfig={handleChangeThrottleConfig}
            activeHostRemapCount={activeHostRemapCount}
            upstreamProxyConfig={upstreamProxyConfig}
            onSaveUpstreamProxyConfig={handleSaveUpstreamProxyConfig}
            upstreamTimeouts={upstreamTimeouts}
            onSetUpstreamTimeouts={handleSaveUpstreamTimeouts}
            sessionRetentionLimit={sessionRetentionLimit}
            onSetSessionRetentionLimit={setSessionRetentionLimit}
            dropNonMatching={dropNonMatching}
            onSetDropNonMatching={setDropNonMatching}
            storageStats={storageStats}
            clearDbOnExit={clearDbOnExit}
            onSetClearDbOnExit={setClearDbOnExit}
            onClearSqliteDatabase={clearSqliteDatabase}
            backendFilterConfig={backendFilterConfig}
            onUpdateBackendFilterConfig={updateBackendFilterConfig}
            onUpdateLanClientAllowlist={updateLanClientAllowlist}
            onOpenCertificateModal={() => setCertModalOpen(true)}
            caRefreshKey={caRefreshKey}
            activeClientCertsCount={activeClientCertsCount}
            onClientCertsCountChange={setActiveClientCertsCount}
            autoResponderEnabled={autoResponderEnabled}
            autoResponderRules={rules}
            onExportProfile={handleExportSettingsProfile}
            onImportProfileDialog={handleImportSettingsProfileDialog}
            onImportFromRawJsonText={(jsonText, label) =>
              openImportPreviewFromJsonText(
                jsonText,
                label ?? "pasted-settings.json"
              )
            }
            onResetAllToDefaults={() => handleResetAllSettings(true)}
            onNotify={showToast}
          />
        </React.Suspense>
      )}

      {pendingImportState && (
        <React.Suspense fallback={null}>
          <SettingsImportPreviewModal
            preview={pendingImportState.preview}
            onCancel={() => setPendingImportState(null)}
            onConfirm={handleConfirmImportSettingsProfile}
          />
        </React.Suspense>
      )}

      <SessionAnnotationModal
        open={annotationModalOpen}
        targetSessions={annotationTargetSessions}
        onClose={() => setAnnotationModalOpen(false)}
        onSave={(ids, comment, markedColor) => {
          void annotateSessions(ids, comment, markedColor);
        }}
      />

      <CertificateModal
        open={certModalOpen}
        onClose={() => {
          setCertModalOpen(false);
          setCaRefreshKey((n) => n + 1);
        }}
        onNotify={showToast}
      />

      {sanitizedExportModalOpen && (
        <React.Suspense fallback={null}>
          <SanitizedExportModal
            open={sanitizedExportModalOpen}
            totalCount={sessions.length}
            archivedCount={storageStats.archivedSessions ?? 0}
            selectedIds={effectiveSelectedIds}
            onClose={() => setSanitizedExportModalOpen(false)}
            onExport={exportSanitizedSessions}
          />
        </React.Suspense>
      )}

      {openApiModalOpen && (
        <React.Suspense fallback={null}>
          <OpenApiExportModal
            open={openApiModalOpen}
            selectedIds={openApiSelectedIds}
            allSessionIds={openApiAllIds}
            resolvedTheme={resolvedTheme}
            onClose={() => setOpenApiModalOpen(false)}
            onNotify={showToast}
          />
        </React.Suspense>
      )}

      <CodeSnippetModal
        open={codeSnippetModalOpen}
        request={codeSnippetRequest}
        resolvedTheme={resolvedTheme}
        onClose={() => setCodeSnippetModalOpen(false)}
        onNotify={showToast}
      />

      <TrafficStatisticsModal
        open={trafficStatsModalOpen}
        onClose={() => setTrafficStatsModalOpen(false)}
        filteredSessions={filteredSessions}
        selectedSessions={selectedSessions}
        totalCapturedCount={sessions.length}
        filterQuery={filterQuery}
        initialScope={trafficStatsInitialScope}
        onSelectSession={(id) => {
          setActiveSection("traffic");
          setInlineDiffDismissed(true);
          setSelectedId(id);
          setInspectorCollapsed(false);
        }}
        onFilterByHost={handleFilterByHost}
        onNotify={showToast}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        onQuickExecBpu={(stage, pattern) =>
          void applyQuickExecBpu(stage, pattern)
        }
        onQuickOpenJwt={(token) => openTextWizardAt("jwt", token)}
        onQuickOpenSanitizedExport={openSanitizedExportModal}
        onQuickOpenProxyDoctor={() =>
          openPreferencesAt("diagnosticsBackup", "proxyDoctor")
        }
        onQuickOpenClientCerts={() =>
          openPreferencesAt("tlsCertificates", "clientCerts")
        }
        onQuickOpenTrafficStatistics={() =>
          openTrafficStatisticsModal("filtered")
        }
        onQuickOpenWaterfall={() => handleSetTrafficViewMode("waterfall")}
      />

      <dialog
        ref={sqlitePurgeDialogRef}
        aria-labelledby="sqlite-purge-confirm-title"
        onCancel={(e) => {
          if (isPurgingSqlite) e.preventDefault();
        }}
        onClose={() => {
          if (!isPurgingSqlite) setConfirmSqlitePurgeOpen(false);
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !isPurgingSqlite) {
            setConfirmSqlitePurgeOpen(false);
          }
        }}
        {...({ closedby: "any" } as Record<string, string>)}
        className="m-auto w-full max-w-md rounded-xl border border-strong bg-surface p-0 text-fg shadow-popover open:flex open:flex-col"
      >
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-status5xx-fg" />
            <h2
              id="sqlite-purge-confirm-title"
              className="text-sm font-semibold text-fg"
            >
              Очистка и сжатие архива SQLite (VACUUM)
            </h2>
          </div>
          <button
            type="button"
            disabled={isPurgingSqlite}
            onClick={() => setConfirmSqlitePurgeOpen(false)}
            className="rounded p-1 text-muted hover:bg-hover hover:text-fg disabled:opacity-45"
            aria-label="Закрыть диалог очистки SQLite"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-3 text-xs text-fg">
          <p>
            Полностью удаляет сохранённые сессии и выгруженные тела из{" "}
            <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[11px]">
              sessions.sqlite
            </code>
            , усекает WAL-журнал и выполняет{" "}
            <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[11px]">
              VACUUM
            </code>{" "}
            для освобождения места на диске.
          </p>
          <div className="rounded border border-hairline bg-canvas/60 px-3 py-2 text-[11px] text-muted">
            Текущий размер SQLite:{" "}
            <strong className="font-semibold text-fg">
              {(storageStats.sqliteSizeBytes / (1024 * 1024)).toFixed(2)} MB
            </strong>{" "}
            ({storageStats.sqliteSizeBytes.toLocaleString("en-US")} байт) • В ОЗУ:{" "}
            <strong className="font-semibold text-fg">
              {storageStats.ramSessions.toLocaleString("en-US")}
            </strong>{" "}
            сессий (остаются в таблице).
          </div>
          <label className="flex cursor-pointer items-start gap-2 rounded border border-hairline bg-canvas/40 px-2.5 py-2 text-xs">
            <input
              type="checkbox"
              checked={clearDbOnExit}
              onChange={(e) => void setClearDbOnExit(e.target.checked)}
              className="checkbox-native mt-0.5"
            />
            <div>
              <div className="font-medium text-fg">
                Очищать базу SQLite при выходе (Clear DB on App Exit)
              </div>
              <div className="text-[11px] text-muted">
                Автоматически очищать и сжимать архив при каждом закрытии FluxProxy.
              </div>
            </div>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-hairline bg-canvas/50 px-4 py-2.5">
          <button
            type="button"
            autoFocus
            disabled={isPurgingSqlite}
            onClick={() => setConfirmSqlitePurgeOpen(false)}
            className="rounded border border-strong bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:bg-hover disabled:opacity-45"
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={isPurgingSqlite}
            onClick={() => void handleConfirmSqlitePurge()}
            className="inline-flex items-center gap-1.5 rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>
              {isPurgingSqlite
                ? "Очистка и VACUUM..."
                : "Очистить архив и выполнить VACUUM"}
            </span>
          </button>
        </div>
      </dialog>
    </div>
  );
};

export const App: React.FC = () => (
  <ContextMenuProvider>
    <AppContent />
  </ContextMenuProvider>
);

export default App;
