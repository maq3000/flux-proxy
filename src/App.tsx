import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Database, Gauge, Globe, Network, Stethoscope, Trash2, Upload, WifiOff, X } from "lucide-react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import { AutoResponderPanel } from "./components/AutoResponderPanel";
import { BreakpointBanner } from "./components/BreakpointBanner";
import { CertificateModal } from "./components/CertificateModal";
import { ClientCertificatesModal } from "./components/ClientCertificatesModal";
import { HostRemapModal } from "./components/HostRemapModal";
import { CodeSnippetModal } from "./components/CodeSnippetModal";
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
import type { TextWizardTab } from "./components/TextWizardModal";
import { TopToolbar } from "./components/TopToolbar";
import { TrafficGrid } from "./components/TrafficGrid";

const BreakpointInterceptorModal = React.lazy(() =>
  import("./components/BreakpointModal").then((m) => ({
    default: m.BreakpointInterceptorModal,
  }))
);
const FilterDrawer = React.lazy(() =>
  import("./components/FilterDrawer").then((m) => ({
    default: m.FilterDrawer,
  }))
);
const MobileSetupModal = React.lazy(() =>
  import("./components/MobileSetupModal").then((m) => ({
    default: m.MobileSetupModal,
  }))
);
const OpenApiExportModal = React.lazy(() =>
  import("./components/OpenApiExportModal").then((m) => ({
    default: m.OpenApiExportModal,
  }))
);
const ProxyDoctorModal = React.lazy(() =>
  import("./components/ProxyDoctorModal").then((m) => ({
    default: m.ProxyDoctorModal,
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
const SessionDiffModal = React.lazy(() =>
  import("./components/SessionDiffView").then((m) => ({
    default: m.SessionDiffModal,
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
const TextWizardModal = React.lazy(() =>
  import("./components/TextWizardModal").then((m) => ({
    default: m.TextWizardModal,
  }))
);
const UpstreamProxyModal = React.lazy(() =>
  import("./components/UpstreamProxyModal").then((m) => ({
    default: m.UpstreamProxyModal,
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
import { isTauriRuntime, proxyBridge } from "./lib/tauriBridge";
import { useProxyStore } from "./stores/proxyStore";
import { useUiStore } from "./stores/uiStore";
import { THEME_PRESETS } from "./lib/themePresets";
import { THROTTLE_PRESET_DEFINITIONS } from "./types/proxy";
import type {
  AutoResponderRule,
  ComposedRequest,
  FilterDrawerTab,
  PythonScriptPreset,
  SessionSummary,
  ThrottleConfig,
  UpstreamProxyConfig,
  UpstreamTimeoutConfig,
} from "./types/proxy";
import type {
  FluxUserSettingsProfile,
  SettingsImportPreviewSummary,
  SettingsModalTab,
} from "./types/settings";

export const App: React.FC = () => {
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
    toggleLightDark,
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
  const bottomOuterGroupRef = useRef<ImperativePanelGroupHandle>(null);
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
  const dockedComposer = useUiStore((s) => s.dockedComposer);
  const setDockedComposer = useUiStore((s) => s.setDockedComposer);
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
  const [pendingImportState, setPendingImportState] = useState<{
    profile: FluxUserSettingsProfile;
    preview: SettingsImportPreviewSummary;
  } | null>(null);
  const [certModalOpen, setCertModalOpen] = useState(false);
  const [clientCertsModalOpen, setClientCertsModalOpen] = useState(false);
  const [hostRemapModalOpen, setHostRemapModalOpen] = useState(false);
  const [upstreamProxyModalOpen, setUpstreamProxyModalOpen] = useState(false);

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
  const [mobileModalOpen, setMobileModalOpen] = useState(false);
  const [proxyDoctorModalOpen, setProxyDoctorModalOpen] = useState(false);
  const [sanitizedExportModalOpen, setSanitizedExportModalOpen] =
    useState(false);
  const [openApiModalOpen, setOpenApiModalOpen] = useState(false);
  const [openApiSelectedIds, setOpenApiSelectedIds] = useState<number[]>([]);
  const [openApiAllIds, setOpenApiAllIds] = useState<number[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);
  const [hexTriggerSeq, setHexTriggerSeq] = useState(0);
  const [statisticsTriggerSeq, setStatisticsTriggerSeq] = useState(0);
  const [customRetentionTriggerSeq, setCustomRetentionTriggerSeq] = useState(0);
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [filterDrawerTab, setFilterDrawerTab] =
    useState<FilterDrawerTab>("matrix");

  // Session Diff & User Annotations (Comment / Mark) Modal State
  const [annotationModalOpen, setAnnotationModalOpen] = useState(false);
  const [annotationTargetIds, setAnnotationTargetIds] = useState<number[]>([]);
  const [diffModalOpen, setDiffModalOpen] = useState(false);
  const [inlineDiffDismissed, setInlineDiffDismissed] = useState(false);
  const [codeSnippetModalOpen, setCodeSnippetModalOpen] = useState(false);
  const [codeSnippetRequest, setCodeSnippetRequest] =
    useState<CodeGenRequest | null>(null);

  // Drag-and-Drop Archive & Settings Profile Import (.har, .saz, .json) State
  const [fileDropActive, setFileDropActive] = useState(false);
  const [fileDropLabel, setFileDropLabel] = useState<string | null>(null);
  const htmlDragDepthRef = useRef(0);

  const openPreferencesAt = useCallback((tab: SettingsModalTab = "general") => {
    setSettingsInitialTab(tab);
    setSettingsModalOpen(true);
  }, []);

  const handleOpenTimeoutSettings = useCallback(() => {
    setSettingsInitialTab("general");
    setSettingsModalOpen(true);
    window.requestAnimationFrame(() => {
      document
        .getElementById("upstream-timeouts-section")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

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

  const handleResetBottomOuterGroup = useCallback(() => {
    bottomOuterGroupRef.current?.setLayout(dockedComposer ? [74, 26] : [100]);
  }, [dockedComposer]);

  const handleResetBottomInnerGroup = useCallback(() => {
    bottomInnerGroupRef.current?.setLayout(
      inspectorCollapsed ? [100] : [54, 46]
    );
  }, [inspectorCollapsed]);

  const handleResetRightGroup = useCallback(() => {
    rightGroupRef.current?.setLayout(
      !inspectorCollapsed
        ? dockedComposer
          ? [44, 32, 24]
          : [56, 44]
        : dockedComposer
          ? [74, 26]
          : [100]
    );
  }, [dockedComposer, inspectorCollapsed]);

  const handleResetPanelLayout = useCallback(() => {
    resetPanelLayouts();
    showToast("📐 Размеры сплит-панелей сброшены к значениям по умолчанию");
  }, [resetPanelLayouts, showToast]);

  useEffect(() => {
    const onResetPanels = () => {
      handleResetBottomOuterGroup();
      handleResetBottomInnerGroup();
      handleResetRightGroup();
    };
    window.addEventListener(FLUX_PANEL_LAYOUT_RESET_EVENT, onResetPanels);
    return () => {
      window.removeEventListener(FLUX_PANEL_LAYOUT_RESET_EVENT, onResetPanels);
    };
  }, [
    handleResetBottomInnerGroup,
    handleResetBottomOuterGroup,
    handleResetRightGroup,
  ]);

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
    }
  }, [selectedPairKey]);

  const annotationTargetSessions = useMemo(() => {
    if (annotationTargetIds.length === 0) return [];
    const idSet = new Set(annotationTargetIds);
    return sessions.filter((s) => idSet.has(s.id));
  }, [annotationTargetIds, sessions]);

  // TextWizard & JWT Decoder Modal State
  const [textWizardOpen, setTextWizardOpen] = useState(false);
  const [textWizardTab, setTextWizardTab] = useState<TextWizardTab>("jwt");
  const [textWizardInput, setTextWizardInput] = useState<string | undefined>(
    undefined
  );

  // Live Breakpoint Interceptor Modal State
  const [bpModalOpen, setBpModalOpen] = useState(false);
  const [bpModalMode, setBpModalMode] = useState<"intercept" | "rules">(
    "intercept"
  );
  const [selectedBpId, setSelectedBpId] = useState<string | null>(null);
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

  // Automatically surface the Monaco Breakpoint Interceptor when a new live packet is parked
  useEffect(() => {
    if (pausedBreakpoints.length === 0) {
      lastAutoOpenedBpRef.current = null;
      return;
    }
    const firstId = pausedBreakpoints[0].breakpointId;
    if (lastAutoOpenedBpRef.current !== firstId) {
      lastAutoOpenedBpRef.current = firstId;
      setSelectedBpId(firstId);
      setBpModalMode("intercept");
      setBpModalOpen(true);
    }
  }, [pausedBreakpoints]);

  const openFilterDrawerAt = useCallback((tab: FilterDrawerTab = "matrix") => {
    setFilterDrawerTab(tab);
    setFilterDrawerOpen(true);
  }, []);

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
      setTextWizardOpen(true);
    },
    []
  );

  const openBreakpointsAt = useCallback(
    (mode: "intercept" | "rules", bpId?: string) => {
      setBpModalMode(mode);
      if (bpId) setSelectedBpId(bpId);
      setBpModalOpen(true);
    },
    []
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
      if (anchorSessionId === undefined && selectedIds.length >= 2) {
        setDiffModalOpen(true);
        return;
      }

      const pool = filteredSessions.length >= 2 ? filteredSessions : sessions;
      const anchorId =
        anchorSessionId ?? selectedId ?? pool[0]?.id ?? sessions[0]?.id ?? null;

      if (anchorId === null) {
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
        showToast("Для сравнения требуется минимум 2 захваченные сессии");
        return;
      }

      if (anchor && anchor.status >= 400 && partner.status < 400) {
        setComparePairIds(partner.id, anchorId);
      } else {
        setComparePairIds(anchorId, partner.id);
      }
      setDiffModalOpen(true);
    },
    [
      filteredSessions,
      selectedId,
      selectedIds.length,
      sessions,
      setComparePairIds,
      showToast,
    ]
  );

  useGlobalShortcuts({
    activeSection,
    setActiveSection,
    clientCertsModalOpen,
    setClientCertsModalOpen,
    diffModalOpen,
    setDiffModalOpen,
    hostRemapModalOpen,
    setHostRemapModalOpen,
    sanitizedExportModalOpen,
    setSanitizedExportModalOpen,
    upstreamProxyModalOpen,
    setUpstreamProxyModalOpen,
    setFilterDrawerOpen,
    setMobileModalOpen,
    setPaletteOpen,
    setProxyDoctorModalOpen,
    setSettingsModalOpen,
    setShortcutsModalOpen,
    setTextWizardOpen,
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

  const loadSessionIntoComposer = useCallback(
    async (sessionId: number, openStandalone = false) => {
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
      });
      if (openStandalone) {
        setActiveSection("composer");
      } else if (!dockedComposer && activeSection === "traffic") {
        setDockedComposer(true);
      }
      showToast(`Loaded Session #${sessionId} into Composer`);
    },
    [activeSection, dockedComposer, showToast]
  );

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
        label: "Generate Client Code… (JavaScript, Python, Go, Rust, cURL)",
        description: "Сгенерировать код HTTP-клиента по выбранной сессии в Monaco",
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
        label:
          "Открыть Session Diff — сравнение заголовков, кук и JSON двух сессий (Monaco DiffEditor)",
        description: "Сравнение двух запросов/ответов с подсветкой различий заголовков и тела",
        shortcut: "Ctrl+D",
        perform: () => openDiffWithPairSmart(),
      },
      {
        id: "annotate-session",
        category: "Annotations",
        group: "capture",
        label:
          "Добавить комментарий и цветовую заливку к выбранной сессии (Comment / Mark)",
        description: "Установить цветную метку и заметку для выбранных сессий",
        shortcut: "M",
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
        label: "Показать справку по горячим клавишам (Keyboard Shortcuts)",
        description: "Полный список клавиатурных комбинаций таблицы, инспектора и фильтров",
        shortcut: "?",
        perform: () => setShortcutsModalOpen(true),
      },
      {
        id: "run-proxy-doctor",
        category: "Diagnostics",
        group: "tools",
        label:
          "Run Proxy Doctor… (Диагностика порта, Root CA, SysProxy, VPN, Firewall и loopback)",
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
        perform: () => setProxyDoctorModalOpen(true),
      },
      {
        id: "open-text-wizard",
        category: "TextWizard",
        group: "tools",
        label:
          "Открыть TextWizard & JWT Decoder (Base64, URL, Gzip/Brotli/Zstd, Hex, Timestamp)",
        description: "Инструмент кодирования, декодирования, разбора JWT и сжатия текста",
        shortcut: "Ctrl+E",
        perform: () => openTextWizardAt("jwt"),
      },
      {
        id: "open-jwt-inspector",
        category: "TextWizard",
        group: "tools",
        label: "JWT Inspector: декодировать Header / Claims и проверить exp",
        description: "Быстрый разбор структуры JSON Web Token и валидности подписи/срока",
        perform: () => openTextWizardAt("jwt"),
      },
      {
        id: "open-compression-codec",
        category: "TextWizard",
        group: "tools",
        label: "TextWizard: Сжатие и распаковка Gzip / Brotli / Deflate / Zstd",
        description: "Конвертер сжатых payload и проверка размера до/после компрессии",
        perform: () => openTextWizardAt("compression"),
      },
      {
        id: "toggle-bp-request",
        category: "Breakpoints",
        group: "filters",
        label: breakpointConfig.breakBeforeRequest
          ? "Отключить Break on Request (перехват до отправки на апстрим)"
          : "Включить Break on Request — ставить запросы на паузу в Monaco",
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
          ? "Отключить Break on Response (перехват ответа сервера)"
          : "Включить Break on Response — править JSON или код 500 на лету",
        description: "Глобальная пауза всех ответов перед возвратом в браузер или приложение",
        statusBadge: breakpointConfig.breakAfterResponse ? "ON" : "OFF",
        shortcut: "Alt+F11",
        perform: () => void toggleBreakAfterResponse(),
      },
      {
        id: "open-bp-rules",
        category: "Breakpoints",
        group: "filters",
        label:
          "Открыть Live Breakpoints и правила `bpu` / `bpafter` (или введите `bpu <url>` выше)",
        description: "Очередь перехваченных пакетов в Monaco и настройка условных правил",
        statusBadge:
          pausedBreakpoints.length > 0
            ? `Пауза: ${pausedBreakpoints.length} · Правил: ${enabledBreakpointRulesCount}`
            : enabledBreakpointRulesCount > 0
              ? `Правил: ${enabledBreakpointRulesCount}`
              : "0 правил",
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
        label: "Открыть Таблицу фильтров и Пресеты (Include / Exclude / PID)",
        description: "Многострочные правила фильтрации трафика, процессы и пресеты",
        statusBadge:
          activeFilterBadgeCount > 0
            ? `Активно: ${activeFilterBadgeCount}`
            : "Выкл",
        shortcut: "Alt+4",
        perform: () => openFilterDrawerAt("matrix"),
      },
      {
        id: "open-hosts-list-filter",
        category: "Filters",
        group: "filters",
        label:
          "Открыть Массовый фильтр хостов и URL (Hosts List: Show only Whitelist / Hide Blacklist)",
        description: "Фильтрация трафика по списку доменов, маскам * и регулярным выражениям",
        statusBadge: hostListFilter.enabled
          ? `${hostListFilter.mode === "whitelist" ? "Allow" : "Block"} (${compiledHostList.activeCount})`
          : "OFF",
        perform: () => openFilterDrawerAt("hostsList"),
      },
      {
        id: "open-tls-bypass",
        category: "TLS / CA",
        group: "filters",
        label:
          "Открыть настройки Selective TLS MITM: Target Allowlist & Bypass",
        description: "Настройка целевых доменов расшифровки, Quick-Packs и Bulk Editor",
        statusBadge:
          backendFilterConfig.tlsInterceptMode === "targetedOnly"
            ? `Targeted (${activeTargetHostsCount})`
            : `Bypass (${enabledTlsBypassCount})`,
        perform: () => openFilterDrawerAt("tlsBypass"),
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
        label:
          "Connect Mobile Device — iOS & Android Wi-Fi Proxy + QR Code (flux.proxy)",
        description: "LAN IP, QR-код установки Root CA и шаблон Android network_security_config",
        statusBadge:
          status.allowRemote || status.bindAddr === "0.0.0.0"
            ? `LAN :${status.port}`
            : `Local :${status.port}`,
        shortcut: "Ctrl+Shift+M",
        perform: () => setMobileModalOpen(true),
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
        label: "Switch to Traffic Viewer & Session Inspector",
        description: "Переключиться на основную таблицу перехваченного трафика",
        shortcut: "Alt+1",
        perform: () => setActiveSection("traffic"),
      },
      {
        id: "view-composer",
        category: "View",
        group: "tools",
        label: "Switch to Request Composer",
        description: "Открыть конструктор HTTP-запросов с импортом cURL и генератором кода",
        shortcut: "Alt+2",
        keywords: ["composer", "curl", "import", "paste", "request", "http"],
        perform: () => setActiveSection("composer"),
      },
      {
        id: "toggle-docked-composer",
        category: "View",
        group: "settings",
        label: dockedComposer
          ? "Hide Docked Split Composer"
          : "Dock Composer Split Beside Traffic Viewer (Drag & Drop)",
        description: "Показать или скрыть боковую панель Composer рядом с таблицей трафика",
        statusBadge: dockedComposer ? "Открыт" : "OFF",
        perform: () => {
          setActiveSection("traffic");
          setDockedComposer((v) => !v);
        },
      },
      {
        id: "view-rules",
        category: "AutoResponder",
        group: "tools",
        label: "Open AutoResponder & Latency Simulation Rules",
        description: "Правила локальных моков ответов, подмены статусов и искусственной задержки",
        statusBadge: autoResponderEnabled
          ? `ON (${activeRulesCount}/${rules.length})`
          : `OFF (${rules.length})`,
        shortcut: "Alt+3",
        perform: () => setActiveSection("rules"),
      },
      {
        id: "view-scripts",
        category: "Scripting",
        group: "tools",
        label: "Open Python Scripting Engine (on_request / on_response)",
        description: "Редактор Python-хуков с живой консолью stdout/stderr и пресетами",
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
          ? "Disable Python Scripting Engine"
          : "Enable Python Scripting Engine",
        description: "Включить или выключить выполнение Python-хуков на проходящем трафике",
        statusBadge: scriptEnabled ? "ON" : "OFF",
        perform: () => void handleTogglePythonScript(!scriptEnabled),
      },
      {
        id: "root-ca",
        category: "TLS / CA",
        group: "filters",
        label: "Inspect or Install HTTPS MITM Root CA Certificate",
        description: "Проверить статус доверия ОС, отпечаток SHA-256 и установить Root CA",
        perform: () => setCertModalOpen(true),
      },
      {
        id: "client-certificates",
        category: "TLS / mTLS",
        group: "filters",
        label: "Client Certificates… (mTLS — .p12 / .pfx / .pem)",
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
        perform: () => setClientCertsModalOpen(true),
      },
      {
        id: "host-remap",
        category: "DNS / Routing",
        group: "network",
        label: "HOSTS Remapping… (Virtual DNS перенаправление доменов)",
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
        perform: () => setHostRemapModalOpen(true),
      },
      {
        id: "upstream-proxy-chaining",
        category: "Tools",
        group: "network",
        label: "Upstream Proxy Chaining… (HTTP / HTTPS / SOCKS5)",
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
        perform: () => setUpstreamProxyModalOpen(true),
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
        label:
          "Export Sanitized Sessions… (PII & Secrets Redaction for HAR / SAZ / JSON / Raw)",
        description: "Безопасный экспорт с маскированием токенов, Cookie, PII и секретов",
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
        label: "Export as OpenAPI 3.0 Spec… (YAML / JSON)",
        description: "Автогенерация схемы OpenAPI 3.0.3 по выбранным API-запросам",
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
        label: "Theme Gallery & Custom Palette… (8 тем-пресетов и редактор цветов)",
        description: "Выбор цветовой темы и точная настройка токенов палитры с Monaco",
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
        label: "Preferences... — Открыть настройки и управление профилем",
        description: "Порт прокси, таймауты, интерфейсы, колонки, фильтры и профиль JSON",
        shortcut: "Ctrl+,",
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
      dockedComposer,
      dropNonMatching,
      effectiveSelectedIds,
      enabledBreakpointRulesCount,
      enabledTlsBypassCount,
      exportAllSessionsAs,
      exportSelectedSessionsAs,
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
      handleTogglePythonScript,
      hostListFilter.enabled,
      hostListFilter.mode,
      importArchiveDialog,
      inspectorCollapsed,
      inspectorPosition,
      isForceNoCacheActive,
      loadFromSqlite,
      markedSessionsCount,
      openAnnotationFor,
      openBreakpointsAt,
      openCodeGeneratorForSession,
      openDiffWithPairSmart,
      openFilterDrawerAt,
      openOpenApiExportModal,
      openPreferencesAt,
      openSanitizedExportModal,
      openTextWizardAt,
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

  const renderTrafficGrid = () => (
    <TrafficGrid
      gridRef={trafficGridRef}
      sessions={filteredSessions}
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
      onSendToComposer={(id) => void loadSessionIntoComposer(id, false)}
      onCreateRuleFromSession={(s) => void handleCreateRuleFromSession(s)}
      onExportSelectedSessions={(ids, fmt) =>
        void exportSelectedSessionsAs(ids, fmt)
      }
      onExportOpenApi={(ids) => openOpenApiExportModal(ids)}
      onSaveSessionBody={(id, isResponse) =>
        void saveSessionBodyAs(id, isResponse)
      }
      onFilterByProcess={(proc) => quickFilterByProcess(proc, "include")}
      onFilterByClientIp={(ip) => quickFilterByClientIp(ip, "include")}
      onAddClientIpToAllowlist={(ip) => void addLanClientToAllowlist(ip)}
      onAlwaysInspectHost={(host) => void quickAlwaysInspectHost(host)}
      onAlwaysPassthroughHost={(host) => void quickAlwaysPassthroughHost(host)}
      onAddHostToTlsBypass={(host) => void quickAddTlsBypassHost(host)}
      onDisableFollowTail={() => setFollowTail(false)}
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
          onSelectPair={setComparePairIds}
          onSwapPair={swapCompareSessions}
          onAnnotateSession={(id) => openAnnotationFor([id])}
          onExpandModal={() => setDiffModalOpen(true)}
          onOpenStatistics={() => {
            setInlineDiffDismissed(true);
            setStatisticsTriggerSeq((n) => n + 1);
          }}
          onCloseDiff={() => setInlineDiffDismissed(true)}
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
        onSendToComposer={(id) => void loadSessionIntoComposer(id, false)}
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
      />
    );

  return (
    <div
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
        onOpenFilterDrawer={() => openFilterDrawerAt("matrix")}
        onOpenHostsListDrawer={() => openFilterDrawerAt("hostsList")}
        onOpenTlsModeDrawer={() => openFilterDrawerAt("tlsBypass")}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        inspectorCollapsed={inspectorCollapsed}
        onToggleInspector={toggleInspector}
        inspectorPosition={inspectorPosition}
        onSetInspectorPosition={setInspectorPosition}
        dockedComposer={dockedComposer}
        onToggleDockedComposer={() => {
          setActiveSection("traffic");
          setDockedComposer((v) => !v);
        }}
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
        themePreference={preference}
        onSetTheme={setTheme}
        onOpenThemeGallery={() => openPreferencesAt("uiColumns")}
        onReplaySelected={() => {
          if (effectiveSelectedIds.length > 0) {
            void replaySessions(effectiveSelectedIds);
          }
        }}
        onSendSelectedToComposer={() => {
          if (selectedId !== null) void loadSessionIntoComposer(selectedId, false);
        }}
        onOpenSessionDiff={() => openDiffWithPairSmart()}
        onOpenTextWizard={() => openTextWizardAt("jwt")}
        onOpenHexConverter={() => openTextWizardAt("hex")}
        onInspectInHex={handleInspectInHex}
        onOpenCompressionCodec={() => openTextWizardAt("compression")}
        onOpenMobileSetup={() => setMobileModalOpen(true)}
        onOpenCertificates={() => setCertModalOpen(true)}
        onOpenClientCertificates={() => setClientCertsModalOpen(true)}
        onOpenHostRemap={() => setHostRemapModalOpen(true)}
        activeHostRemapCount={activeHostRemapCount}
        onOpenUpstreamProxy={() => setUpstreamProxyModalOpen(true)}
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
        onOpenProxyDoctor={() => setProxyDoctorModalOpen(true)}
        onCopyCliEnv={copyCliProxyEnv}
        onResetAllUiPreferences={resetAllUiPreferences}
      />

      <div className="flex flex-1 overflow-hidden">
        {!sidebarCollapsed && (
          <Sidebar
            activeSection={activeSection}
            onSelectSection={setActiveSection}
            onDropSessionToComposer={(id) =>
              void loadSessionIntoComposer(id, true)
            }
            onOpenFilterDrawer={() => setFilterDrawerOpen((v) => !v)}
            filterDrawerOpen={filterDrawerOpen}
            activeFilterCount={activeFilterBadgeCount}
            onOpenBreakpoints={() =>
              openBreakpointsAt(
                pausedBreakpoints.length > 0 ? "intercept" : "rules"
              )
            }
            breakpointsArmed={breakpointsArmed}
            pausedBreakpointCount={pausedBreakpoints.length}
            onOpenSessionDiff={() => openDiffWithPairSmart()}
            diffActive={diffModalOpen || showInlineSessionDiff}
            onOpenTextWizard={() => openTextWizardAt("jwt")}
            onOpenMobileSetup={() => setMobileModalOpen(true)}
            allowRemote={Boolean(
              status.allowRemote || status.bindAddr === "0.0.0.0"
            )}
            onOpenCertificates={() => setCertModalOpen(true)}
            onOpenCommandPalette={() => setPaletteOpen(true)}
            resolvedTheme={resolvedTheme}
            onToggleTheme={toggleLightDark}
            activeRulesCount={activeRulesCount}
            pythonScriptEnabled={Boolean(
              scriptEnabled &&
                (pythonRunnerStatus?.running || pythonRunnerStatus?.isSimulator)
            )}
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
            onOpenFilterDrawer={() => openFilterDrawerAt("matrix")}
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
            onOpenTextWizard={() => openTextWizardAt("jwt")}
            onOpenHexConverter={() => openTextWizardAt("hex")}
            onInspectInHex={handleInspectInHex}
            hasSelection={effectiveSelectedIds.length > 0}
            markedCount={markedSessionsCount}
            onOpenSessionDiff={() => openDiffWithPairSmart()}
            followTail={followTail}
            onToggleFollowTail={() => setFollowTail((v) => !v)}
            compactToolbar={compactToolbar}
            onToggleCompactToolbar={toggleCompactToolbar}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            inspectorCollapsed={inspectorCollapsed}
            onToggleInspector={toggleInspector}
            inspectorPosition={inspectorPosition}
            onSetInspectorPosition={setInspectorPosition}
            dockedComposer={dockedComposer}
            onToggleDockedComposer={() => {
              setActiveSection("traffic");
              setDockedComposer((v) => !v);
            }}
            toolbarGroups={toolbarGroups}
            onToggleToolbarGroup={toggleToolbarGroup}
            onResetToolbarGroups={resetToolbarGroups}
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
            onOpenTlsModeDrawer={() => openFilterDrawerAt("tlsBypass")}
            sessionRetentionLimit={sessionRetentionLimit}
            onSetSessionRetentionLimit={(limit) =>
              void setSessionRetentionLimit(limit)
            }
            dropNonMatching={dropNonMatching}
            onToggleDropNonMatching={() => void toggleDropNonMatching()}
            droppedSessionsCount={storageStats.droppedSessionsCount}
            customRetentionTriggerSeq={customRetentionTriggerSeq}
            onClearSessions={() => void clearAllSessions()}
            onSaveSqlite={() => void saveToSqlite()}
            onLoadSqlite={() => void loadFromSqlite()}
            onOpenCertificates={() => setCertModalOpen(true)}
            onOpenMobileSetup={() => setMobileModalOpen(true)}
            throttleConfig={throttleConfig}
            onChangeThrottleConfig={(cfg) => void handleChangeThrottleConfig(cfg)}
            onOpenHostRemap={() => setHostRemapModalOpen(true)}
            activeHostRemapCount={activeHostRemapCount}
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
            {activeSection === "traffic" && inspectorPosition === "bottom" && (
              <PanelGroup
                ref={bottomOuterGroupRef}
                key="traffic-layout-bottom"
                autoSaveId={FLUX_PANEL_AUTOSAVE_IDS.bottomOuter}
                storage={SAFE_PANEL_STORAGE}
                direction="horizontal"
                className="h-full w-full"
              >
                <Panel
                  id="traffic-bottom-stack"
                  order={1}
                  defaultSize={dockedComposer ? 74 : 100}
                  minSize={35}
                >
                  <PanelGroup
                    ref={bottomInnerGroupRef}
                    autoSaveId={FLUX_PANEL_AUTOSAVE_IDS.bottomInner}
                    storage={SAFE_PANEL_STORAGE}
                    direction="vertical"
                    className="h-full w-full"
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
                          title="Double-click to reset Traffic / Inspector split"
                          className="h-1 w-full bg-hairline transition-colors hover:bg-accent/60"
                        />
                        <Panel
                          id="session-inspector-bottom"
                          order={2}
                          defaultSize={46}
                          minSize={20}
                        >
                          {renderInspectorOrDiff()}
                        </Panel>
                      </>
                    )}
                  </PanelGroup>
                </Panel>

                {dockedComposer && (
                  <>
                    <PanelResizeHandle
                      onDoubleClick={handleResetBottomOuterGroup}
                      title="Double-click to reset Traffic / Composer split"
                      className="w-1 bg-hairline transition-colors hover:bg-accent/60"
                    />
                    <Panel
                      id="docked-composer-panel"
                      order={2}
                      defaultSize={26}
                      minSize={20}
                    >
                      <ComposerPanel
                        draftRequest={composerDraft}
                        resolvedTheme={resolvedTheme}
                        defaultComposerTimeoutSec={
                          upstreamTimeouts.composerTimeoutSec
                        }
                        onLoadSessionIntoComposer={(id) =>
                          void loadSessionIntoComposer(id, false)
                        }
                        onSessionCreated={(detail) =>
                          setSelectedId(detail.summary.id)
                        }
                        onGenerateCode={openCodeGeneratorForComposerDraft}
                        onNotify={showToast}
                      />
                    </Panel>
                  </>
                )}
              </PanelGroup>
            )}

            {activeSection === "traffic" && inspectorPosition === "right" && (
              <PanelGroup
                ref={rightGroupRef}
                key="traffic-layout-right"
                autoSaveId={FLUX_PANEL_AUTOSAVE_IDS.right}
                storage={SAFE_PANEL_STORAGE}
                direction="horizontal"
                className="h-full w-full"
              >
                <Panel
                  id="traffic-grid-left"
                  order={1}
                  defaultSize={
                    inspectorCollapsed
                      ? dockedComposer
                        ? 74
                        : 100
                      : dockedComposer
                        ? 44
                        : 56
                  }
                  minSize={26}
                >
                  {renderTrafficGrid()}
                </Panel>

                {!inspectorCollapsed && (
                  <>
                    <PanelResizeHandle
                      onDoubleClick={handleResetRightGroup}
                      title="Double-click to reset workspace panel split"
                      className="w-1 bg-hairline transition-colors hover:bg-accent/60"
                    />
                    <Panel
                      id="session-inspector-right"
                      order={2}
                      defaultSize={dockedComposer ? 32 : 44}
                      minSize={22}
                    >
                      {renderInspectorOrDiff()}
                    </Panel>
                  </>
                )}

                {dockedComposer && (
                  <>
                    <PanelResizeHandle
                      onDoubleClick={handleResetRightGroup}
                      title="Double-click to reset workspace panel split"
                      className="w-1 bg-hairline transition-colors hover:bg-accent/60"
                    />
                    <Panel
                      id="docked-composer-right"
                      order={3}
                      defaultSize={24}
                      minSize={20}
                    >
                      <ComposerPanel
                        draftRequest={composerDraft}
                        resolvedTheme={resolvedTheme}
                        defaultComposerTimeoutSec={
                          upstreamTimeouts.composerTimeoutSec
                        }
                        onLoadSessionIntoComposer={(id) =>
                          void loadSessionIntoComposer(id, false)
                        }
                        onSessionCreated={(detail) =>
                          setSelectedId(detail.summary.id)
                        }
                        onGenerateCode={openCodeGeneratorForComposerDraft}
                        onNotify={showToast}
                      />
                    </Panel>
                  </>
                )}
              </PanelGroup>
            )}

            {activeSection === "composer" && (
              <ComposerPanel
                draftRequest={composerDraft}
                resolvedTheme={resolvedTheme}
                defaultComposerTimeoutSec={upstreamTimeouts.composerTimeoutSec}
                onLoadSessionIntoComposer={(id) =>
                  void loadSessionIntoComposer(id, true)
                }
                onSessionCreated={(detail) => setSelectedId(detail.summary.id)}
                onGenerateCode={openCodeGeneratorForComposerDraft}
                onNotify={showToast}
              />
            )}

            {activeSection === "rules" && (
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
              />
            )}

            {activeSection === "scripts" && (
              <React.Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-xs text-muted">
                    Loading Python Scripting IDE...
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
                />
              </React.Suspense>
            )}
          </main>
        </div>
      </div>

      {/* Compact Status Footer */}
      <footer className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-hairline bg-surface px-3 font-mono text-[11px] text-muted">
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
                onClick={() => setProxyDoctorModalOpen(true)}
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
                onClick={() => setMobileModalOpen(true)}
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
            onClick={() => openFilterDrawerAt("tlsBypass")}
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
                onClick={() => setHostRemapModalOpen(true)}
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
                onClick={() => setUpstreamProxyModalOpen(true)}
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
                onClick={() => openFilterDrawerAt("matrix")}
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
            activePresetId={activePresetId}
            userPresets={customPresets}
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
            noiseThresholds={thresholds}
            onSetNoiseThresholds={setThresholds}
            hostFilters={hostListFilter}
            onSetHostFilters={setHostListFilter}
            onResetAdvancedFilters={resetAdvancedFilters}
            onOpenFilterDrawer={() => openFilterDrawerAt("matrix")}
            status={status}
            onSetProxyPort={setProxyPort}
            onSetAutoSystemProxy={setAutoSystemProxy}
            onSetAllowRemote={setAllowRemote}
            onSetBindConfiguration={setBindConfiguration}
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
            onSetTlsInterceptMode={setTlsInterceptMode}
            onOpenTlsDrawer={() => openFilterDrawerAt("tlsBypass")}
            onOpenHeadersDrawer={() => openFilterDrawerAt("headers")}
            autoResponderEnabled={autoResponderEnabled}
            onSetAutoResponderEnabled={handleSetAutoResponderEnabled}
            autoResponderRules={rules}
            onUpsertAutoResponderRule={async (rule) => {
              const next = await proxyBridge.upsertRule(rule);
              setRules(next);
              persistAutoResponderStorage(autoResponderEnabled, next);
              showToast(`Saved rule "${rule.name}"`);
            }}
            onDeleteAutoResponderRule={async (id) => {
              const next = await proxyBridge.deleteRule(id);
              setRules(next);
              persistAutoResponderStorage(autoResponderEnabled, next);
              showToast("Deleted AutoResponder rule");
            }}
            onOpenAutoResponderStudio={() => setActiveSection("rules")}
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

      {diffModalOpen && (
        <React.Suspense fallback={null}>
          <SessionDiffModal
            open={diffModalOpen}
            leftDetail={diffLeftDetail}
            rightDetail={diffRightDetail}
            sessions={filteredSessions.length >= 2 ? filteredSessions : sessions}
            resolvedTheme={resolvedTheme}
            onSelectPair={setComparePairIds}
            onSwapPair={swapCompareSessions}
            onAnnotateSession={(id) => openAnnotationFor([id])}
            onClose={() => setDiffModalOpen(false)}
          />
        </React.Suspense>
      )}

      {filterDrawerOpen && (
        <React.Suspense fallback={null}>
          <FilterDrawer
            open={filterDrawerOpen}
            initialTab={filterDrawerTab}
            onClose={() => setFilterDrawerOpen(false)}
            totalCount={sessions.length}
            filteredCount={filteredSessions.length}
            sessions={sessions}
            hostListFilter={hostListFilter}
            compiledHostList={compiledHostList}
            onHostListFilterChange={setHostListFilter}
            onNotify={showToast}
            matrixEnabled={matrixEnabled}
            onMatrixEnabledChange={setMatrixEnabled}
            rules={filterRules}
            onRulesChange={setFilterRules}
            ruleErrors={ruleErrors}
            presets={allPresets}
            activePresetId={activePresetId}
            onApplyPreset={applyPreset}
            onSavePreset={saveCustomPreset}
            onDeletePreset={deleteCustomPreset}
            onResetAll={resetAdvancedFilters}
            detectedProcesses={detectedProcesses}
            onQuickProcessFilter={quickFilterByProcess}
            thresholds={thresholds}
            onThresholdsChange={setThresholds}
            backendConfig={backendFilterConfig}
            onBackendConfigChange={updateBackendFilterConfig}
            isForceNoCacheActive={isForceNoCacheActive}
            onToggleForceNoCache={toggleForceNoCache}
          />
        </React.Suspense>
      )}

      {bpModalOpen && (
        <React.Suspense fallback={null}>
          <BreakpointInterceptorModal
            open={bpModalOpen}
            initialMode={bpModalMode}
            selectedBreakpointId={selectedBpId}
            pausedItems={pausedBreakpoints}
            config={breakpointConfig}
            resolvedTheme={resolvedTheme}
            onClose={() => setBpModalOpen(false)}
            onUpdateConfig={updateBreakpointConfig}
            onResolve={resolvePausedBreakpoint}
            onResumeAll={resumeAllBreakpoints}
          />
        </React.Suspense>
      )}

      {textWizardOpen && (
        <React.Suspense fallback={null}>
          <TextWizardModal
            open={textWizardOpen}
            initialTab={textWizardTab}
            initialInput={textWizardInput}
            onClose={() => setTextWizardOpen(false)}
            onNotify={showToast}
          />
        </React.Suspense>
      )}

      <CertificateModal
        open={certModalOpen}
        onClose={() => setCertModalOpen(false)}
        onNotify={showToast}
      />

      <ClientCertificatesModal
        open={clientCertsModalOpen}
        onClose={() => setClientCertsModalOpen(false)}
        onNotify={showToast}
      />

      <HostRemapModal
        open={hostRemapModalOpen}
        onClose={() => setHostRemapModalOpen(false)}
        onNotify={showToast}
      />

      {upstreamProxyModalOpen && (
        <React.Suspense fallback={null}>
          <UpstreamProxyModal
            open={upstreamProxyModalOpen}
            config={upstreamProxyConfig}
            proxyPort={status.port}
            onClose={() => setUpstreamProxyModalOpen(false)}
            onSave={handleSaveUpstreamProxyConfig}
          />
        </React.Suspense>
      )}

      {mobileModalOpen && (
        <React.Suspense fallback={null}>
          <MobileSetupModal
            open={mobileModalOpen}
            status={status}
            lanClientAllowlist={backendFilterConfig.lanClientAllowlist ?? []}
            onUpdateLanClientAllowlist={updateLanClientAllowlist}
            onSetAllowRemote={setAllowRemote}
            onToggleProxy={toggleProxy}
            onClose={() => setMobileModalOpen(false)}
            onNotify={showToast}
          />
        </React.Suspense>
      )}

      {proxyDoctorModalOpen && (
        <React.Suspense fallback={null}>
          <ProxyDoctorModal
            open={proxyDoctorModalOpen}
            onClose={() => setProxyDoctorModalOpen(false)}
            onNotify={showToast}
          />
        </React.Suspense>
      )}

      {sanitizedExportModalOpen && (
        <React.Suspense fallback={null}>
          <SanitizedExportModal
            open={sanitizedExportModalOpen}
            totalCount={sessions.length}
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

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        onQuickExecBpu={(stage, pattern) =>
          void applyQuickExecBpu(stage, pattern)
        }
        onQuickOpenJwt={(token) => openTextWizardAt("jwt", token)}
        onQuickOpenSanitizedExport={openSanitizedExportModal}
        onQuickOpenProxyDoctor={() => setProxyDoctorModalOpen(true)}
        onQuickOpenClientCerts={() => setClientCertsModalOpen(true)}
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

export default App;
