import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { BreakpointBanner } from "./components/BreakpointBanner";
import type { BreakpointsPanelMode } from "./components/BreakpointsPanel";
import { MenuBar } from "./components/MenuBar";
import { Sidebar } from "./components/Sidebar";
import type { TextWizardTab } from "./components/TextWizardPanel";
import { TopToolbar } from "./components/TopToolbar";
import type { TrafficStatisticsScope } from "./components/TrafficStatisticsModal";
import { ContextMenuProvider } from "./components/ui/ContextMenu";
import { AppModals } from "./components/workspaces/AppModals";
import { CommandPaletteContainer } from "./components/workspaces/CommandPaletteContainer";
import { SecondaryWorkspaces } from "./components/workspaces/SecondaryWorkspaces";
import { SessionDiffWorkspace } from "./components/workspaces/SessionDiffWorkspace";
import { StatusFooter } from "./components/workspaces/StatusFooter";
import { TrafficWorkspace } from "./components/workspaces/TrafficWorkspace";
import { useAutomationSync } from "./hooks/useAutomationSync";
import { useContextMenu } from "./hooks/useContextMenu";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useProxySessionController } from "./hooks/useProxySessions";
import { useStoreGlobalSync } from "./hooks/useStoreGlobalSync";
import {
  requestFromComposedRequest,
  requestFromSessionDetail,
  type CodeGenRequest,
} from "./lib/codeGenerators";
import {
  buildEditableInputMenuItems,
  buildFooterContextMenu,
  buildSelectionContextMenuItems,
  captureEditableSelection,
  copyTextToClipboard,
  findEditableTextTarget,
  getActiveReadOnlySelection,
  shouldPreserveNativeContextMenu,
} from "./lib/contextMenuBuilders";
import { buildCurlCommand, buildHeadersBlock } from "./lib/formatters";
import {
  applySettingsProfile,
  buildSettingsImportPreview,
  exportCurrentSettingsProfile,
  isLikelyFluxSettingsProfile,
  loadPersistedSanitizationOptions,
  parseAndValidateSettingsJsonText,
  registerLiveSettingsSnapshotGetter,
  resetAllSettingsToDefault,
} from "./lib/settingsManager";
import { isTauriRuntime, proxyBridge } from "./lib/tauriBridge";
import { getFilteredSessionsSnapshot } from "./lib/trafficFilter";
import { findSessionById, useProxyStore } from "./stores/proxyStore";
import {
  readPersistedPanelLayouts,
  useUiStore,
} from "./stores/uiStore";
import { THROTTLE_PRESET_DEFINITIONS } from "./types/proxy";
import type {
  ActiveNavSection,
  ComposedRequest,
  HeaderMutationDirection,
  HeaderMutationOp,
  HeaderMutationRule,
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
  useStoreGlobalSync();

  const { openContextMenu, closeContextMenu } = useContextMenu();

  const compactToolbar = useUiStore((s) => s.layout.compactToolbar);
  const toggleCompactToolbar = useUiStore((s) => s.toggleCompactToolbar);
  const sidebarCollapsed = useUiStore((s) => s.layout.sidebarCollapsed);
  const inspectorCollapsed = useUiStore((s) => s.layout.inspectorCollapsed);
  const inspectorPosition = useUiStore((s) => s.layout.inspectorPosition);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setInspectorCollapsed = useUiStore((s) => s.setInspectorCollapsed);
  const toggleInspector = useUiStore((s) => s.toggleInspector);
  const setInspectorPosition = useUiStore((s) => s.setInspectorPosition);
  const resetPanelLayouts = useUiStore((s) => s.resetPanelLayouts);
  const toolbarGroups = useUiStore((s) => s.toolbarGroups);
  const toggleToolbarGroup = useUiStore((s) => s.toggleToolbarGroup);
  const setToolbarGroupVisible = useUiStore((s) => s.setToolbarGroupVisible);
  const resetToolbarGroups = useUiStore((s) => s.resetToolbarGroups);
  const visibleColumns = useUiStore((s) => s.visibleColumns);
  const toggleColumnVisibility = useUiStore((s) => s.toggleColumnVisibility);
  const resetColumns = useUiStore((s) => s.resetColumns);
  const resetAllUiPreferences = useUiStore((s) => s.resetAllUiPreferences);
  const activeSection = useUiStore((s) => s.activeSection);
  const setActiveSection = useUiStore((s) => s.setActiveSection);

  const {
    selectedId,
    setSelectedId,
    selectedIds,
    toggleSessionSelection,
    selectSessionRange,
    selectSessions,
    compareWithSession,
    setComparePairIds,
    swapCompareSessions,
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
  } = useProxySessionController();

  const {
    handleSetAutoResponderEnabled,
    handleApplyPythonScript,
    handleTogglePythonScript,
    handleRefreshPythonStatus,
    handleSelectPythonPreset,
    handleCreateRuleFromSession,
  } = useAutomationSync({ showToast, setActiveSection });

  const searchInputRef = useRef<HTMLInputElement>(null);
  const trafficGridRef = useRef<HTMLDivElement>(null);
  const inspectorContainerRef = useRef<HTMLDivElement>(null);
  const sortedSessionsRef = useRef<SessionSummary[]>([]);

  const handleSelectAllSessions = useCallback(
    (explicitIds?: number[]) => {
      const currentFiltered = getFilteredSessionsSnapshot();
      const ids =
        explicitIds ??
        (sortedSessionsRef.current.length === currentFiltered.length
          ? sortedSessionsRef.current.map((s) => s.id)
          : currentFiltered.map((s) => s.id));
      if (ids.length === 0) return;
      setActiveSection("traffic");
      selectSessions(ids);
    },
    [selectSessions, setActiveSection]
  );

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

  // Primitive/low-frequency store slices for chrome indicators only
  const setHostRemapRules = useProxyStore((s) => s.setHostRemapRules);
  const throttleConfig = useProxyStore((s) => s.throttleConfig);
  const setThrottleConfig = useProxyStore((s) => s.setThrottleConfig);
  const upstreamProxyConfig = useProxyStore((s) => s.upstreamProxyConfig);
  const setUpstreamProxyConfig = useProxyStore(
    (s) => s.setUpstreamProxyConfig
  );
  const upstreamTimeouts = useProxyStore((s) => s.upstreamTimeouts);
  const setUpstreamTimeouts = useProxyStore((s) => s.setUpstreamTimeouts);
  const activeHostRemapCount = useProxyStore((s) =>
    s.hostRemapRules.reduce((acc, r) => (r.enabled ? acc + 1 : acc), 0)
  );
  const upstreamProxyActiveLabel = useProxyStore((s) =>
    s.upstreamProxyConfig.enabled && s.upstreamProxyConfig.host.trim()
      ? `${s.upstreamProxyConfig.protocol.toUpperCase()} ${s.upstreamProxyConfig.host.trim()}:${s.upstreamProxyConfig.port}`
      : null
  );
  const activeRulesCount = useProxyStore((s) =>
    s.autoResponderEnabled
      ? s.rules.reduce((acc, r) => (r.enabled ? acc + 1 : acc), 0)
      : 0
  );
  const pythonScriptEnabled = useProxyStore((s) =>
    Boolean(
      s.scriptEnabled &&
        (s.pythonRunnerStatus?.running || s.pythonRunnerStatus?.isSimulator)
    )
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

  // Sync persisted Virtual DNS (HOSTS Remapping), Throttling, Upstream Proxy & Timeouts on boot
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
  const [confirmSqlitePurgeOpen, setConfirmSqlitePurgeOpen] = useState(false);

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

  const [annotationModalOpen, setAnnotationModalOpen] = useState(false);
  const [annotationTargetIds, setAnnotationTargetIds] = useState<number[]>([]);
  const [diffTabPairIds, setDiffTabPairIds] = useState<[number, number] | null>(
    null
  );
  const [inlineDiffDismissed, setInlineDiffDismissed] = useState(false);
  const [codeSnippetModalOpen, setCodeSnippetModalOpen] = useState(false);
  const [codeSnippetRequest, setCodeSnippetRequest] =
    useState<CodeGenRequest | null>(null);

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
    setSettingsModalOpen((prev) => {
      if (prev) return false;
      setSettingsInitialTab("general");
      setSettingsInitialSubTab(undefined);
      setSettingsNavSeq((n) => n + 1);
      return true;
    });
  }, []);

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
    (jsonText: string, fileName = "pasted-settings.json") => {
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

  const handleResetPanelLayout = useCallback(() => {
    resetPanelLayouts();
    showToast("📐 Размеры сплит-панелей сброшены к значениям по умолчанию");
  }, [resetPanelLayouts, showToast]);

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
  }, [
    importArchiveFromPath,
    openImportPreviewFromJsonText,
    setActiveSection,
    showToast,
  ]);

  const isExternalArchiveDrag = useCallback((dt: DataTransfer | null): boolean => {
    if (!dt) return false;
    const types = Array.from(dt.types);
    return (
      types.includes("Files") &&
      !types.includes("application/x-fluxproxy-session-id")
    );
  }, []);

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
      setActiveSection,
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
    if (useProxyStore.getState().selectedIds.length >= 2) {
      swapCompareSessions();
    }
  }, [swapCompareSessions]);

  const [textWizardTab, setTextWizardTab] = useState<TextWizardTab>("jwt");
  const [textWizardInput, setTextWizardInput] = useState<string | undefined>(
    undefined
  );
  const [textWizardRequestSeq, setTextWizardRequestSeq] = useState(0);

  const [bpPanelMode, setBpPanelMode] =
    useState<BreakpointsPanelMode>("intercept");
  const [selectedBpId, setSelectedBpId] = useState<string | null>(null);
  const [bpRequestSeq, setBpRequestSeq] = useState(0);
  const lastAutoOpenedBpRef = useRef<string | null>(null);

  // Imperative live settings snapshot getter (no reactive subscriptions in AppContent)
  const liveSnapshotRef = useRef<() => Partial<FluxUserSettingsProfile>>(
    () => ({})
  );
  liveSnapshotRef.current = () => {
    const ui = useUiStore.getState();
    const px = useProxyStore.getState();
    return {
      ui: {
        theme: ui.preference,
        themePreset: ui.themePreset,
        customColorOverrides: ui.customColorOverrides,
        compactToolbar: ui.layout.compactToolbar,
        sidebarCollapsed: ui.layout.sidebarCollapsed,
        inspectorCollapsed: ui.layout.inspectorCollapsed,
        inspectorPosition: ui.layout.inspectorPosition,
        inspectorSplitDirection: ui.layout.inspectorSplitDirection,
        followTail: px.followTail,
        columnWidths: ui.columnWidths,
        visibleColumns: ui.visibleColumns,
        toolbarGroups: ui.toolbarGroups,
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
        hostRemapRules: px.hostRemapRules,
        throttleConfig: px.throttleConfig,
        upstreamProxy: {
          enabled: px.upstreamProxyConfig.enabled,
          protocol: px.upstreamProxyConfig.protocol,
          host: px.upstreamProxyConfig.host,
          port: px.upstreamProxyConfig.port,
          username: px.upstreamProxyConfig.username ?? null,
          bypassList: px.upstreamProxyConfig.bypassList,
        },
        upstreamTimeouts: px.upstreamTimeouts,
        lanClientAllowlist: backendFilterConfig.lanClientAllowlist ?? [],
      },
      autoResponder: {
        enabled: px.autoResponderEnabled,
        rules: px.rules,
      },
      breakpoints: breakpointConfig,
      scripting: {
        enabled: px.scriptEnabled,
        code: px.scriptCode,
        activePresetId: px.scriptActivePresetId,
      },
    };
  };

  useEffect(() => {
    return registerLiveSettingsSnapshotGetter(() => liveSnapshotRef.current());
  }, []);

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
    if (useProxyStore.getState().sessions.length === 0) {
      showToast("⚠️ Нет захваченных сессий для экспорта");
      return;
    }
    setSanitizedExportModalOpen(true);
  }, [showToast]);

  const openOpenApiExportModal = useCallback(
    (explicitIds?: number[]) => {
      const storeState = useProxyStore.getState();
      const targetSelected =
        explicitIds && explicitIds.length > 0
          ? [...explicitIds]
          : [...effectiveSelectedIds];
      const currentFiltered = getFilteredSessionsSnapshot();
      const targetAll = (
        currentFiltered.length > 0 ? currentFiltered : storeState.sessions
      ).map((s) => s.id);
      if (targetSelected.length === 0 && targetAll.length === 0) {
        showToast("⚠️ Нет захваченных сессий для генерации OpenAPI 3.0");
        return;
      }
      setOpenApiSelectedIds(targetSelected);
      setOpenApiAllIds(targetAll);
      setOpenApiModalOpen(true);
    },
    [effectiveSelectedIds, showToast]
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
  }, [setActiveSection]);

  const handleFocusInspector = useCallback(() => {
    setActiveSection("traffic");
    const currentFiltered = getFilteredSessionsSnapshot();
    if (
      useProxyStore.getState().selectedId === null &&
      currentFiltered.length > 0
    ) {
      setSelectedId(currentFiltered[0].id);
    }
    if (inspectorCollapsed) {
      setInspectorCollapsed(false);
    }
    window.requestAnimationFrame(() => {
      inspectorContainerRef.current?.focus({ preventScroll: true });
    });
  }, [inspectorCollapsed, setActiveSection, setInspectorCollapsed, setSelectedId]);

  const handleFocusSearch = useCallback(() => {
    setActiveSection("traffic");
    if (!toolbarGroups.quickFilter) {
      setToolbarGroupVisible("quickFilter", true);
    }
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [setActiveSection, setToolbarGroupVisible, toolbarGroups.quickFilter]);

  const handleInspectInHex = useCallback(() => {
    setActiveSection("traffic");
    const currentFiltered = getFilteredSessionsSnapshot();
    if (
      useProxyStore.getState().selectedId === null &&
      currentFiltered.length > 0
    ) {
      setSelectedId(currentFiltered[0].id);
    }
    if (inspectorCollapsed) {
      setInspectorCollapsed(false);
    }
    setInlineDiffDismissed(true);
    setHexTriggerSeq((n) => n + 1);
    window.requestAnimationFrame(() => {
      inspectorContainerRef.current?.focus({ preventScroll: true });
    });
  }, [inspectorCollapsed, setActiveSection, setInspectorCollapsed, setSelectedId]);

  const handleOpenStatistics = useCallback(() => {
    setActiveSection("traffic");
    const currentFiltered = getFilteredSessionsSnapshot();
    if (
      useProxyStore.getState().selectedId === null &&
      currentFiltered.length > 0
    ) {
      setSelectedId(currentFiltered[0].id);
    }
    if (inspectorCollapsed) {
      setInspectorCollapsed(false);
    }
    setInlineDiffDismissed(true);
    setStatisticsTriggerSeq((n) => n + 1);
    window.requestAnimationFrame(() => {
      inspectorContainerRef.current?.focus({ preventScroll: true });
    });
  }, [inspectorCollapsed, setActiveSection, setInspectorCollapsed, setSelectedId]);

  const handleOpenCustomRetentionLimit = useCallback(() => {
    setActiveSection("traffic");
    setCustomRetentionTriggerSeq((n) => n + 1);
  }, [setActiveSection]);

  const copyUrlsForIds = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) {
        showToast("Нет выбранной сессии для копирования URL");
        return;
      }
      const { sessions, sessionIndexById } = useProxyStore.getState();
      const urls = ids
        .map((id) => findSessionById(sessions, sessionIndexById, id)?.url)
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
    [showToast]
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
          // Proceed with headers/URL
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
          // Proceed with headers/URL
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
    const port = useProxyStore.getState().status.port;
    const snippet = `$env:HTTP_PROXY="http://127.0.0.1:${port}"; $env:HTTPS_PROXY="http://127.0.0.1:${port}"`;
    void navigator.clipboard
      ?.writeText(snippet)
      .then(() => showToast(`Скопировано: ${snippet}`))
      .catch(() => showToast(snippet));
  }, [showToast]);

  const openDiffWithPairSmart = useCallback(
    (anchorSessionId?: number) => {
      const storeState = useProxyStore.getState();
      const allSessions = storeState.sessions;
      const currentFiltered = getFilteredSessionsSnapshot();

      if (anchorSessionId === undefined) {
        if (storeState.selectedIds.length >= 2) {
          setDiffTabPairIds([
            storeState.selectedIds[0],
            storeState.selectedIds[1],
          ]);
          setActiveSection("diff");
          return;
        }
        if (
          diffTabPairIds &&
          findSessionById(
            allSessions,
            storeState.sessionIndexById,
            diffTabPairIds[0]
          ) &&
          findSessionById(
            allSessions,
            storeState.sessionIndexById,
            diffTabPairIds[1]
          )
        ) {
          setActiveSection("diff");
          return;
        }
      }

      const pool = currentFiltered.length >= 2 ? currentFiltered : allSessions;
      const anchorId =
        anchorSessionId ??
        storeState.selectedId ??
        pool[0]?.id ??
        allSessions[0]?.id ??
        null;

      if (anchorId === null) {
        setActiveSection("diff");
        showToast("Нет доступных сессий для сравнения в Session Diff");
        return;
      }

      const anchor =
        pool.find((s) => s.id === anchorId) ??
        findSessionById(allSessions, storeState.sessionIndexById, anchorId) ??
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
    [diffTabPairIds, setActiveSection, setComparePairIds, showToast]
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
          // Keep empty body fallback
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

  const openInComposerShortcut = useCallback(
    (id: number) => {
      void loadSessionIntoComposer(id);
    },
    [loadSessionIntoComposer]
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
    getFilteredSessions: getFilteredSessionsSnapshot,
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
    openInComposer: openInComposerShortcut,
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

  const activeTargetHostsCount = useMemo(
    () =>
      (backendFilterConfig.tlsTargetRules ?? []).filter(
        (r) => r.enabled && !r.pattern.trim().startsWith("!")
      ).length,
    [backendFilterConfig.tlsTargetRules]
  );

  const enabledTlsBypassCount = useMemo(
    () =>
      (backendFilterConfig.tlsBypassRules ?? []).filter((r) => r.enabled)
        .length,
    [backendFilterConfig.tlsBypassRules]
  );

  const breakpointsArmed =
    breakpointConfig.breakBeforeRequest ||
    breakpointConfig.breakAfterResponse ||
    breakpointConfig.rules.some((r) => r.enabled);

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
  const showInlineSessionDiff =
    selectedIds.length === 2 && !inlineDiffDismissed;

  // Stable callbacks for React.memo Chrome components (`MenuBar`, `Sidebar`, `TopToolbar`, `StatusFooter`)
  const onToggleProxy = useCallback(() => void toggleProxy(), [toggleProxy]);
  const onToggleAllowRemote = useCallback(
    () => void toggleAllowRemote(),
    [toggleAllowRemote]
  );
  const onToggleSystemProxy = useCallback(
    () => void toggleSystemProxy(),
    [toggleSystemProxy]
  );
  const onToggleAutoSystemProxy = useCallback(
    () => void toggleAutoSystemProxy(),
    [toggleAutoSystemProxy]
  );
  const onSaveAllSessionsAs = useCallback(
    () => void exportAllSessionsAs(),
    [exportAllSessionsAs]
  );
  const onSaveSelectedSessionsAs = useCallback(
    () => void exportSelectedSessionsAs(),
    [exportSelectedSessionsAs]
  );
  const onOpenOpenApiExport = useCallback(
    () => openOpenApiExportModal(),
    [openOpenApiExportModal]
  );
  const onImportArchive = useCallback(
    () => void importArchiveDialog(),
    [importArchiveDialog]
  );
  const onSaveSqlite = useCallback(() => void saveToSqlite(), [saveToSqlite]);
  const onLoadSqlite = useCallback(
    () => void loadFromSqlite(),
    [loadFromSqlite]
  );
  const onPurgeSqliteArchive = useCallback(
    () => setConfirmSqlitePurgeOpen(true),
    []
  );
  const onClearSessions = useCallback(
    () => void clearAllSessions(),
    [clearAllSessions]
  );
  const onExportSettingsProfile = useCallback(
    () => void handleExportSettingsProfile(),
    [handleExportSettingsProfile]
  );
  const onImportSettingsProfile = useCallback(
    () => void handleImportSettingsProfileDialog(),
    [handleImportSettingsProfileDialog]
  );
  const onOpenPreferencesGeneral = useCallback(
    () => openPreferencesAt("general"),
    [openPreferencesAt]
  );
  const onSelectAllSessionsMenu = useCallback(
    () => handleSelectAllSessions(),
    [handleSelectAllSessions]
  );
  const onCopyUrl = useCallback(
    () => copyUrlsForIds(effectiveSelectedIds),
    [copyUrlsForIds, effectiveSelectedIds]
  );
  const onCopyCurl = useCallback(() => {
    const id = useProxyStore.getState().selectedId;
    if (id !== null) void copySessionAsCurl(id);
  }, [copySessionAsCurl]);
  const onGenerateClientCode = useCallback(() => {
    const storeState = useProxyStore.getState();
    const id = storeState.selectedId ?? storeState.selectedIds[0] ?? null;
    if (id !== null) void openCodeGeneratorForSession(id);
  }, [openCodeGeneratorForSession]);
  const onCopyRequestHeaders = useCallback(() => {
    const id = useProxyStore.getState().selectedId;
    if (id !== null) void copySessionHeaders(id, "request");
  }, [copySessionHeaders]);
  const onCopyResponseHeaders = useCallback(() => {
    const id = useProxyStore.getState().selectedId;
    if (id !== null) void copySessionHeaders(id, "response");
  }, [copySessionHeaders]);
  const onAnnotateSelected = useCallback(
    () => openAnnotationFor(effectiveSelectedIds),
    [effectiveSelectedIds, openAnnotationFor]
  );
  const onUnmarkSelected = useCallback(() => {
    if (effectiveSelectedIds.length > 0) {
      void unmarkSessions(effectiveSelectedIds);
    }
  }, [effectiveSelectedIds, unmarkSessions]);
  const onDeleteSelected = useCallback(() => {
    if (effectiveSelectedIds.length > 0) {
      void deleteSessions(effectiveSelectedIds);
    }
  }, [deleteSessions, effectiveSelectedIds]);
  const onToggleBreakBeforeRequest = useCallback(
    () => void toggleBreakBeforeRequest(),
    [toggleBreakBeforeRequest]
  );
  const onToggleBreakAfterResponse = useCallback(
    () => void toggleBreakAfterResponse(),
    [toggleBreakAfterResponse]
  );
  const onDisableAllBreakpoints = useCallback(
    () => void disableAllBreakpoints(),
    [disableAllBreakpoints]
  );
  const onOpenBreakpointsModal = useCallback(
    () =>
      openBreakpointsAt(pausedBreakpoints.length > 0 ? "intercept" : "rules"),
    [openBreakpointsAt, pausedBreakpoints.length]
  );
  const onToggleForceNoCache = useCallback(
    () => void toggleForceNoCache(),
    [toggleForceNoCache]
  );
  const onToggleHideConnectTunnels = useCallback(
    () =>
      setThresholds((prev) => ({
        ...prev,
        hideConnectTunnels: !prev.hideConnectTunnels,
      })),
    [setThresholds]
  );
  const onToggleTlsInterceptMode = useCallback(
    () => void toggleTlsInterceptMode(),
    [toggleTlsInterceptMode]
  );
  const onSelectTlsInterceptMode = useCallback(
    (mode: "interceptAll" | "targetedOnly") => void setTlsInterceptMode(mode),
    [setTlsInterceptMode]
  );
  const onQuickAddTargetHost = useCallback(
    (pattern: string) => void quickAlwaysInspectHost(pattern),
    [quickAlwaysInspectHost]
  );
  const onOpenFilterDrawer = useCallback(
    () => openPreferencesAt("filters", "matrix"),
    [openPreferencesAt]
  );
  const onOpenHostsListDrawer = useCallback(
    () => openPreferencesAt("filters", "hostsList"),
    [openPreferencesAt]
  );
  const onOpenTlsModeDrawer = useCallback(
    () => openPreferencesAt("tlsCertificates", "mitmBypass"),
    [openPreferencesAt]
  );
  const onToggleFollowTail = useCallback(
    () => setFollowTail((v) => !v),
    [setFollowTail]
  );
  const onToggleRegex = useCallback(
    () => setUseRegex((v) => !v),
    [setUseRegex]
  );
  const onOpenThemeGallery = useCallback(
    () => openPreferencesAt("uiColumns"),
    [openPreferencesAt]
  );
  const onOpenTrafficStatistics = useCallback(
    () => openTrafficStatisticsModal("filtered"),
    [openTrafficStatisticsModal]
  );
  const onReplaySelected = useCallback(() => {
    if (effectiveSelectedIds.length > 0) {
      void replaySessions(effectiveSelectedIds);
    }
  }, [effectiveSelectedIds, replaySessions]);
  const onSendSelectedToComposer = useCallback(() => {
    const storeState = useProxyStore.getState();
    const targetId =
      storeState.selectedId ?? storeState.selectedIds[0] ?? null;
    if (targetId !== null) void loadSessionIntoComposer(targetId);
  }, [loadSessionIntoComposer]);
  const onOpenSessionDiff = useCallback(
    () => openDiffWithPairSmart(),
    [openDiffWithPairSmart]
  );
  const onOpenTextWizard = useCallback(
    () => setActiveSection("wizard"),
    [setActiveSection]
  );
  const onOpenHexConverter = useCallback(
    () => openTextWizardAt("hex"),
    [openTextWizardAt]
  );
  const onOpenCompressionCodec = useCallback(
    () => openTextWizardAt("compression"),
    [openTextWizardAt]
  );
  const onOpenMobileSetup = useCallback(
    () => openPreferencesAt("tlsCertificates", "mobileSetup"),
    [openPreferencesAt]
  );
  const onOpenCertificates = useCallback(() => setCertModalOpen(true), []);
  const onOpenClientCertificates = useCallback(
    () => openPreferencesAt("tlsCertificates", "clientCerts"),
    [openPreferencesAt]
  );
  const onOpenHostRemap = useCallback(
    () => openPreferencesAt("networkRouting", "hostsRemap"),
    [openPreferencesAt]
  );
  const onOpenUpstreamProxy = useCallback(
    () => openPreferencesAt("networkRouting", "upstreamProxy"),
    [openPreferencesAt]
  );
  const onSetRetentionLimitAction = useCallback(
    (limit: number | null) => void setSessionRetentionLimit(limit),
    [setSessionRetentionLimit]
  );
  const onToggleDropNonMatching = useCallback(
    () => void toggleDropNonMatching(),
    [toggleDropNonMatching]
  );
  const onOpenCommandPalette = useCallback(() => setPaletteOpen(true), []);
  const onOpenShortcutsModal = useCallback(
    () => setShortcutsModalOpen(true),
    []
  );
  const onOpenProxyDoctor = useCallback(
    () => openPreferencesAt("diagnosticsBackup", "proxyDoctor"),
    [openPreferencesAt]
  );
  const onDropSessionToComposer = useCallback(
    (id: number) => void loadSessionIntoComposer(id),
    [loadSessionIntoComposer]
  );
  const onChangeThrottle = useCallback(
    (cfg: ThrottleConfig) => void handleChangeThrottleConfig(cfg),
    [handleChangeThrottleConfig]
  );
  const onOpenNetworkRouting = useCallback(
    (subTab?: "hostsRemap" | "throttling" | "upstreamProxy" | "timeouts") =>
      openPreferencesAt("networkRouting", subTab ?? "throttling"),
    [openPreferencesAt]
  );
  const onResetThrottling = useCallback(
    () =>
      void handleChangeThrottleConfig({
        preset: "none",
        downloadKbps: 0,
        uploadKbps: 0,
        latencyMs: 0,
      }),
    [handleChangeThrottleConfig]
  );
  const onInspectBreakpointItem = useCallback(
    (bpId: string) => openBreakpointsAt("intercept", bpId),
    [openBreakpointsAt]
  );
  const onOpenBreakpointRules = useCallback(
    () => openBreakpointsAt("rules"),
    [openBreakpointsAt]
  );
  const onQuickResolveBreakpoint = useCallback(
    (res: Parameters<typeof resolvePausedBreakpoint>[0]) =>
      void resolvePausedBreakpoint(res),
    [resolvePausedBreakpoint]
  );
  const onResumeAllBreakpoints = useCallback(
    (action?: Parameters<typeof resumeAllBreakpoints>[0]) =>
      void resumeAllBreakpoints(action),
    [resumeAllBreakpoints]
  );
  const onDismissInlineDiff = useCallback(
    () => setInlineDiffDismissed(true),
    []
  );
  const onResumePairDiff = useCallback(
    () => setInlineDiffDismissed(false),
    []
  );
  const onTriggerStatistics = useCallback(
    () => setStatisticsTriggerSeq((n) => n + 1),
    []
  );
  const onExpandDiffTab = useCallback(
    () => setActiveSection("diff"),
    [setActiveSection]
  );
  const onAnnotateSingleSession = useCallback(
    (id: number) => openAnnotationFor([id]),
    [openAnnotationFor]
  );

  // AppModals close/reset helpers
  const onCloseShortcutsModal = useCallback(
    () => setShortcutsModalOpen(false),
    []
  );
  const onCloseSettingsModal = useCallback(
    () => setSettingsModalOpen(false),
    []
  );
  const onCancelPendingImport = useCallback(
    () => setPendingImportState(null),
    []
  );
  const onCloseAnnotationModal = useCallback(
    () => setAnnotationModalOpen(false),
    []
  );
  const onCloseCertModal = useCallback(() => {
    setCertModalOpen(false);
    setCaRefreshKey((n) => n + 1);
  }, []);
  const onCloseSanitizedExportModal = useCallback(
    () => setSanitizedExportModalOpen(false),
    []
  );
  const onCloseOpenApiModal = useCallback(() => setOpenApiModalOpen(false), []);
  const onCloseCodeSnippetModal = useCallback(
    () => setCodeSnippetModalOpen(false),
    []
  );
  const onCloseTrafficStatsModal = useCallback(
    () => setTrafficStatsModalOpen(false),
    []
  );
  const onCloseConfirmSqlitePurge = useCallback(
    () => setConfirmSqlitePurgeOpen(false),
    []
  );
  const onClosePalette = useCallback(() => setPaletteOpen(false), []);

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
              {fileDropLabel ||
                "Поддерживаются форматы .har (HAR 1.2), .saz (Fiddler Classic), .json"}
            </p>
          </div>
        </div>
      )}

      {/* Compact Desktop Menu Bar (`File`, `Edit`, `Rules`, `View`, `Tools`, `Help`) */}
      <MenuBar
        status={status}
        hasSelection={effectiveSelectedIds.length > 0}
        selectedCount={effectiveSelectedIds.length}
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        onToggleProxy={onToggleProxy}
        onToggleAllowRemote={onToggleAllowRemote}
        onToggleSystemProxy={onToggleSystemProxy}
        onToggleAutoSystemProxy={onToggleAutoSystemProxy}
        onSaveAllSessionsAs={onSaveAllSessionsAs}
        onSaveSelectedSessionsAs={onSaveSelectedSessionsAs}
        onOpenSanitizedExport={openSanitizedExportModal}
        onOpenOpenApiExport={onOpenOpenApiExport}
        onImportArchive={onImportArchive}
        onSaveSqlite={onSaveSqlite}
        onLoadSqlite={onLoadSqlite}
        onPurgeSqliteArchive={onPurgeSqliteArchive}
        onClearSessions={onClearSessions}
        onExportSettingsProfile={onExportSettingsProfile}
        onImportSettingsProfile={onImportSettingsProfile}
        onOpenPreferences={onOpenPreferencesGeneral}
        onSelectAllSessions={onSelectAllSessionsMenu}
        onCopyUrl={onCopyUrl}
        onCopyCurl={onCopyCurl}
        onGenerateClientCode={onGenerateClientCode}
        onCopyRequestHeaders={onCopyRequestHeaders}
        onCopyResponseHeaders={onCopyResponseHeaders}
        onAnnotateSelected={onAnnotateSelected}
        onUnmarkSelected={onUnmarkSelected}
        onDeleteSelected={onDeleteSelected}
        onFocusSearch={handleFocusSearch}
        breakpointConfig={breakpointConfig}
        onToggleBreakBeforeRequest={onToggleBreakBeforeRequest}
        onToggleBreakAfterResponse={onToggleBreakAfterResponse}
        onDisableAllBreakpoints={onDisableAllBreakpoints}
        onOpenBreakpointsModal={onOpenBreakpointsModal}
        isForceNoCacheActive={isForceNoCacheActive}
        onToggleForceNoCache={onToggleForceNoCache}
        hideConnectTunnels={thresholds.hideConnectTunnels}
        onToggleHideConnectTunnels={onToggleHideConnectTunnels}
        tlsInterceptMode={backendFilterConfig.tlsInterceptMode}
        targetHostsCount={activeTargetHostsCount}
        onToggleTlsInterceptMode={onToggleTlsInterceptMode}
        onOpenFilterDrawer={onOpenFilterDrawer}
        onOpenHostsListDrawer={onOpenHostsListDrawer}
        onOpenTlsModeDrawer={onOpenTlsModeDrawer}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        inspectorCollapsed={inspectorCollapsed}
        onToggleInspector={toggleInspector}
        inspectorPosition={inspectorPosition}
        onSetInspectorPosition={setInspectorPosition}
        followTail={followTail}
        onToggleFollowTail={onToggleFollowTail}
        compactToolbar={compactToolbar}
        onToggleCompactToolbar={toggleCompactToolbar}
        toolbarGroups={toolbarGroups}
        onToggleToolbarGroup={toggleToolbarGroup}
        onResetToolbarGroups={resetToolbarGroups}
        visibleColumns={visibleColumns}
        onToggleColumnVisibility={toggleColumnVisibility}
        onResetColumns={resetColumns}
        onResetPanelLayout={handleResetPanelLayout}
        onOpenThemeGallery={onOpenThemeGallery}
        trafficViewMode={trafficViewMode}
        onSetTrafficViewMode={handleSetTrafficViewMode}
        onOpenTrafficStatistics={onOpenTrafficStatistics}
        onReplaySelected={onReplaySelected}
        onSendSelectedToComposer={onSendSelectedToComposer}
        onOpenSessionDiff={onOpenSessionDiff}
        onOpenTextWizard={onOpenTextWizard}
        onOpenHexConverter={onOpenHexConverter}
        onInspectInHex={handleInspectInHex}
        onOpenCompressionCodec={onOpenCompressionCodec}
        onOpenMobileSetup={onOpenMobileSetup}
        onOpenCertificates={onOpenCertificates}
        onOpenClientCertificates={onOpenClientCertificates}
        onOpenHostRemap={onOpenHostRemap}
        activeHostRemapCount={activeHostRemapCount}
        onOpenUpstreamProxy={onOpenUpstreamProxy}
        upstreamProxyActiveLabel={upstreamProxyActiveLabel}
        sessionRetentionLimit={sessionRetentionLimit}
        onSetSessionRetentionLimit={onSetRetentionLimitAction}
        onOpenCustomRetentionLimit={handleOpenCustomRetentionLimit}
        dropNonMatching={dropNonMatching}
        onToggleDropNonMatching={onToggleDropNonMatching}
        onGenerateStress10k={generateStress10k}
        onOpenCommandPalette={onOpenCommandPalette}
        onOpenShortcutsModal={onOpenShortcutsModal}
        onOpenProxyDoctor={onOpenProxyDoctor}
        onCopyCliEnv={copyCliProxyEnv}
        onResetAllUiPreferences={resetAllUiPreferences}
      />

      <div className="flex flex-1 overflow-hidden">
        {!sidebarCollapsed && (
          <Sidebar
            activeSection={activeSection}
            onSelectSection={setActiveSection}
            onDropSessionToComposer={onDropSessionToComposer}
            onOpenBreakpoints={onOpenBreakpointsModal}
            breakpointsArmed={breakpointsArmed}
            pausedBreakpointCount={pausedBreakpoints.length}
            onOpenSessionDiff={onOpenSessionDiff}
            diffActive={activeSection === "diff" || showInlineSessionDiff}
            onOpenTextWizard={onOpenTextWizard}
            activeRulesCount={activeRulesCount}
            pythonScriptEnabled={pythonScriptEnabled}
            onOpenSettings={onOpenPreferencesGeneral}
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
            onToggleRegex={onToggleRegex}
            regexError={regexError}
            quickCategory={quickCategory}
            onSelectCategory={setQuickCategory}
            activeFilterCount={activeFilterBadgeCount}
            activePresetName={activePreset?.name ?? null}
            onOpenFilterDrawer={onOpenFilterDrawer}
            onResetAdvancedFilters={resetAdvancedFilters}
            isForceNoCacheActive={isForceNoCacheActive}
            onToggleForceNoCache={onToggleForceNoCache}
            breakpointConfig={breakpointConfig}
            pausedBreakpointCount={pausedBreakpoints.length}
            onToggleBreakBeforeRequest={onToggleBreakBeforeRequest}
            onToggleBreakAfterResponse={onToggleBreakAfterResponse}
            onOpenBreakpointsModal={onOpenBreakpointsModal}
            followTail={followTail}
            onToggleFollowTail={onToggleFollowTail}
            compactToolbar={compactToolbar}
            onToggleCompactToolbar={toggleCompactToolbar}
            onResetPanelLayout={handleResetPanelLayout}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            toolbarGroups={toolbarGroups}
            visibleColumns={visibleColumns}
            onToggleColumnVisibility={toggleColumnVisibility}
            onResetColumns={resetColumns}
            onToggleProxy={onToggleProxy}
            onToggleAllowRemote={onToggleAllowRemote}
            onToggleSystemProxy={onToggleSystemProxy}
            onToggleAutoSystemProxy={onToggleAutoSystemProxy}
            tlsInterceptMode={backendFilterConfig.tlsInterceptMode}
            targetHostsCount={activeTargetHostsCount}
            hideConnectTunnels={thresholds.hideConnectTunnels}
            onSelectTlsInterceptMode={onSelectTlsInterceptMode}
            onToggleTlsInterceptMode={onToggleTlsInterceptMode}
            onQuickAddTargetHost={onQuickAddTargetHost}
            onToggleHideConnectTunnels={onToggleHideConnectTunnels}
            onOpenTlsModeDrawer={onOpenTlsModeDrawer}
            sessionRetentionLimit={sessionRetentionLimit}
            onSetSessionRetentionLimit={onSetRetentionLimitAction}
            dropNonMatching={dropNonMatching}
            onToggleDropNonMatching={onToggleDropNonMatching}
            customRetentionTriggerSeq={customRetentionTriggerSeq}
            onClearSessions={onClearSessions}
            throttleConfig={throttleConfig}
            onChangeThrottleConfig={onChangeThrottle}
            activeHostRemapCount={activeHostRemapCount}
            upstreamProxyEnabled={Boolean(upstreamProxyActiveLabel)}
            activeClientCertsCount={activeClientCertsCount}
            onOpenNetworkRouting={onOpenNetworkRouting}
            onOpenAppearanceSettings={onOpenThemeGallery}
            onNotify={showToast}
          />

          <BreakpointBanner
            config={breakpointConfig}
            pausedItems={pausedBreakpoints}
            onInspectItem={onInspectBreakpointItem}
            onOpenRules={onOpenBreakpointRules}
            onQuickResolve={onQuickResolveBreakpoint}
            onResumeAll={onResumeAllBreakpoints}
            onDisableAll={onDisableAllBreakpoints}
          />

          <main className="flex-1 overflow-hidden">
            {/* Tab 1: Traffic (sole continuous subscriber to high-frequency sessions array) */}
            <TrafficWorkspace
              isActive={activeSection === "traffic"}
              trafficViewMode={trafficViewMode}
              onSetTrafficViewMode={setTrafficViewMode}
              trafficGridRef={trafficGridRef}
              inspectorContainerRef={inspectorContainerRef}
              sortedSessionsRef={sortedSessionsRef}
              hasAnyActiveFilter={hasAnyActiveFilter}
              inlineDiffDismissed={inlineDiffDismissed}
              onDismissInlineDiff={onDismissInlineDiff}
              onResumePairDiff={onResumePairDiff}
              hexTriggerSeq={hexTriggerSeq}
              statisticsTriggerSeq={statisticsTriggerSeq}
              onTriggerStatistics={onTriggerStatistics}
              onResetPanelLayout={handleResetPanelLayout}
              setSelectedId={setSelectedId}
              toggleSessionSelection={toggleSessionSelection}
              selectSessionRange={selectSessionRange}
              selectSessions={selectSessions}
              compareWithSession={compareWithSession}
              swapCompareSessions={swapCompareSessions}
              deleteSessions={deleteSessions}
              replaySessions={replaySessions}
              unmarkSessions={unmarkSessions}
              saveSessionBodyAs={saveSessionBodyAs}
              exportSelectedSessionsAs={exportSelectedSessionsAs}
              exportAllSessionsAs={exportAllSessionsAs}
              clearAllSessions={clearAllSessions}
              importArchiveDialog={importArchiveDialog}
              toggleProxy={toggleProxy}
              applyQuickExecBpu={applyQuickExecBpu}
              quickFilterByProcess={quickFilterByProcess}
              quickFilterByClientIp={quickFilterByClientIp}
              addLanClientToAllowlist={addLanClientToAllowlist}
              quickAlwaysInspectHost={quickAlwaysInspectHost}
              quickAlwaysPassthroughHost={quickAlwaysPassthroughHost}
              quickAddTlsBypassHost={quickAddTlsBypassHost}
              showToast={showToast}
              onOpenBreakpointsAt={openBreakpointsAt}
              onOpenTrafficStatisticsModal={openTrafficStatisticsModal}
              onFocusTrafficGrid={focusTrafficGrid}
              onFocusInspector={handleFocusInspector}
              onOpenStatisticsForSession={handleOpenStatisticsForSession}
              onOpenStatistics={handleOpenStatistics}
              onCopyUrlsForIds={copyUrlsForIds}
              onCopySessionAsCurl={copySessionAsCurl}
              onOpenCodeGeneratorForSession={openCodeGeneratorForSession}
              onCopySessionHeaders={copySessionHeaders}
              onOpenDiffWithPairSmart={openDiffWithPairSmart}
              onSelectDiffTabPair={handleSelectDiffTabPair}
              onSwapDiffTabPair={handleSwapDiffTabPair}
              onExpandDiffTab={onExpandDiffTab}
              onOpenAnnotationFor={openAnnotationFor}
              onLoadSessionIntoComposer={loadSessionIntoComposer}
              onCreateRuleFromSession={handleCreateRuleFromSession}
              onOpenOpenApiModal={openOpenApiExportModal}
              onFilterByHost={handleFilterByHost}
              onFilterByStatus={handleFilterByStatus}
              onQuickFilterByQuery={handleQuickFilterByQuery}
              onAddHeaderMutationRule={handleAddHeaderMutationRule}
              onResetAllTrafficFilters={handleResetAllTrafficFilters}
              onOpenTextWizardAt={openTextWizardAt}
              onOpenTimeoutSettings={handleOpenTimeoutSettings}
            />

            {/* Tabs 2, 3, 4, 5, 7 */}
            <SecondaryWorkspaces
              activeSection={activeSection}
              visitedSections={visitedSections}
              composerDraft={composerDraft}
              bpPanelMode={bpPanelMode}
              selectedBpId={selectedBpId}
              bpRequestSeq={bpRequestSeq}
              textWizardTab={textWizardTab}
              textWizardInput={textWizardInput}
              textWizardRequestSeq={textWizardRequestSeq}
              onSetActiveSection={setActiveSection}
              onLoadSessionIntoComposer={loadSessionIntoComposer}
              onSelectSessionId={setSelectedId}
              onInspectSessionFromComposer={handleInspectSessionFromComposer}
              onOpenCodeGeneratorForComposerDraft={
                openCodeGeneratorForComposerDraft
              }
              onSetAutoResponderEnabled={handleSetAutoResponderEnabled}
              onUpdateBreakpointConfig={updateBreakpointConfig}
              onResolvePausedBreakpoint={resolvePausedBreakpoint}
              onResumeAllBreakpoints={resumeAllBreakpoints}
              onSelectPythonPreset={handleSelectPythonPreset}
              onApplyPythonScript={handleApplyPythonScript}
              onTogglePythonScript={handleTogglePythonScript}
              onRefreshPythonStatus={handleRefreshPythonStatus}
              onNotify={showToast}
            />

            {/* Tab 6: Session Diff */}
            <SessionDiffWorkspace
              isActive={activeSection === "diff"}
              visited={visitedSections.diff}
              diffTabPairIds={diffTabPairIds}
              setDiffTabPairIds={setDiffTabPairIds}
              onBackToTraffic={() => setActiveSection("traffic")}
              onSelectPair={handleSelectDiffTabPair}
              onSwapPair={handleSwapDiffTabPair}
              onAnnotateSession={onAnnotateSingleSession}
              onNotify={showToast}
            />
          </main>
        </div>
      </div>

      {/* Compact Status Footer */}
      <StatusFooter
        status={status}
        tlsInterceptMode={backendFilterConfig.tlsInterceptMode}
        activeTargetHostsCount={activeTargetHostsCount}
        activeHostRemapCount={activeHostRemapCount}
        upstreamProxyActiveLabel={upstreamProxyActiveLabel}
        throttleConfig={throttleConfig}
        activeFilterBadgeCount={activeFilterBadgeCount}
        regexError={regexError}
        toastMessage={toastMessage}
        sessionRetentionLimit={sessionRetentionLimit}
        dropNonMatching={dropNonMatching}
        clearDbOnExit={clearDbOnExit}
        onContextMenu={handleFooterContextMenu}
        onToggleSystemProxy={onToggleSystemProxy}
        onOpenProxyDoctor={onOpenProxyDoctor}
        onOpenMobileSetup={onOpenMobileSetup}
        onOpenMitmBypass={onOpenTlsModeDrawer}
        onOpenHostsRemap={onOpenHostRemap}
        onOpenUpstreamProxy={onOpenUpstreamProxy}
        onResetThrottling={onResetThrottling}
        onOpenFilterMatrix={onOpenFilterDrawer}
        onOpenCustomRetentionLimit={handleOpenCustomRetentionLimit}
        onConfirmSqlitePurge={onPurgeSqliteArchive}
        onOpenShortcuts={onOpenShortcutsModal}
      />

      <AppModals
        shortcutsModalOpen={shortcutsModalOpen}
        onCloseShortcutsModal={onCloseShortcutsModal}
        settingsModalOpen={settingsModalOpen}
        settingsInitialTab={settingsInitialTab}
        settingsInitialSubTab={settingsInitialSubTab}
        settingsNavSeq={settingsNavSeq}
        onCloseSettingsModal={onCloseSettingsModal}
        onResetPanelLayout={handleResetPanelLayout}
        followTail={followTail}
        onSetFollowTail={setFollowTail}
        activePresetId={activePresetId}
        customPresets={customPresets}
        allPresets={allPresets}
        onApplyPreset={applyPreset}
        onSaveCustomPreset={saveCustomPreset}
        onDeleteCustomPreset={deleteCustomPreset}
        matrixEnabled={matrixEnabled}
        onSetMatrixEnabled={setMatrixEnabled}
        filterRules={filterRules}
        onSetFilterRules={setFilterRules}
        ruleErrors={ruleErrors}
        onQuickProcessFilter={quickFilterByProcess}
        thresholds={thresholds}
        onSetThresholds={setThresholds}
        hostListFilter={hostListFilter}
        onSetHostListFilter={setHostListFilter}
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
        onSaveUpstreamTimeouts={handleSaveUpstreamTimeouts}
        sessionRetentionLimit={sessionRetentionLimit}
        onSetSessionRetentionLimit={setSessionRetentionLimit}
        dropNonMatching={dropNonMatching}
        onSetDropNonMatching={setDropNonMatching}
        clearDbOnExit={clearDbOnExit}
        onSetClearDbOnExit={setClearDbOnExit}
        onClearSqliteDatabase={clearSqliteDatabase}
        backendFilterConfig={backendFilterConfig}
        onUpdateBackendFilterConfig={updateBackendFilterConfig}
        onUpdateLanClientAllowlist={updateLanClientAllowlist}
        onOpenCertificateModal={onOpenCertificates}
        caRefreshKey={caRefreshKey}
        activeClientCertsCount={activeClientCertsCount}
        onClientCertsCountChange={setActiveClientCertsCount}
        onExportSettingsProfile={handleExportSettingsProfile}
        onImportSettingsProfileDialog={handleImportSettingsProfileDialog}
        onImportFromRawJsonText={openImportPreviewFromJsonText}
        onResetAllSettings={handleResetAllSettings}
        pendingImportState={pendingImportState}
        onCancelPendingImport={onCancelPendingImport}
        onConfirmImportSettingsProfile={handleConfirmImportSettingsProfile}
        annotationModalOpen={annotationModalOpen}
        annotationTargetIds={annotationTargetIds}
        onCloseAnnotationModal={onCloseAnnotationModal}
        onAnnotateSessions={annotateSessions}
        certModalOpen={certModalOpen}
        onCloseCertModal={onCloseCertModal}
        sanitizedExportModalOpen={sanitizedExportModalOpen}
        effectiveSelectedIds={effectiveSelectedIds}
        onCloseSanitizedExportModal={onCloseSanitizedExportModal}
        onExportSanitizedSessions={exportSanitizedSessions}
        openApiModalOpen={openApiModalOpen}
        openApiSelectedIds={openApiSelectedIds}
        openApiAllIds={openApiAllIds}
        onCloseOpenApiModal={onCloseOpenApiModal}
        codeSnippetModalOpen={codeSnippetModalOpen}
        codeSnippetRequest={codeSnippetRequest}
        onCloseCodeSnippetModal={onCloseCodeSnippetModal}
        trafficStatsModalOpen={trafficStatsModalOpen}
        trafficStatsInitialScope={trafficStatsInitialScope}
        onCloseTrafficStatsModal={onCloseTrafficStatsModal}
        onSetActiveSection={setActiveSection}
        onDismissInlineDiff={onDismissInlineDiff}
        onSelectSessionId={setSelectedId}
        onSetInspectorCollapsed={setInspectorCollapsed}
        onFilterByHost={handleFilterByHost}
        confirmSqlitePurgeOpen={confirmSqlitePurgeOpen}
        onCloseConfirmSqlitePurge={onCloseConfirmSqlitePurge}
        showToast={showToast}
      />

      <CommandPaletteContainer
        open={paletteOpen}
        onClose={onClosePalette}
        status={status}
        selectedId={selectedId}
        effectiveSelectedIds={effectiveSelectedIds}
        activePresetId={activePresetId}
        activeFilterBadgeCount={activeFilterBadgeCount}
        activeTargetHostsCount={activeTargetHostsCount}
        enabledTlsBypassCount={enabledTlsBypassCount}
        compiledHostListActiveCount={compiledHostList.activeCount}
        isForceNoCacheActive={isForceNoCacheActive}
        breakpointConfig={breakpointConfig}
        pausedBreakpoints={pausedBreakpoints}
        dropNonMatching={dropNonMatching}
        sessionRetentionLimit={sessionRetentionLimit}
        trafficViewMode={trafficViewMode}
        activeHostRemapCount={activeHostRemapCount}
        upstreamProxyActiveLabel={upstreamProxyActiveLabel}
        throttleConfig={throttleConfig}
        toggleProxy={toggleProxy}
        handleSelectAllSessions={onSelectAllSessionsMenu}
        replaySessions={replaySessions}
        loadSessionIntoComposer={loadSessionIntoComposer}
        deleteSessions={deleteSessions}
        clearAllSessions={clearAllSessions}
        copySessionAsCurl={copySessionAsCurl}
        openCodeGeneratorForSession={openCodeGeneratorForSession}
        openDiffWithPairSmart={openDiffWithPairSmart}
        openAnnotationFor={openAnnotationFor}
        unmarkSessions={unmarkSessions}
        setActiveSection={setActiveSection}
        setQuickCategory={setQuickCategory}
        handleInspectInHex={handleInspectInHex}
        handleOpenStatistics={handleOpenStatistics}
        openTrafficStatisticsModal={openTrafficStatisticsModal}
        handleSetTrafficViewMode={handleSetTrafficViewMode}
        handleResetPanelLayout={handleResetPanelLayout}
        setShortcutsModalOpen={setShortcutsModalOpen}
        openPreferencesAt={openPreferencesAt}
        openTextWizardAt={openTextWizardAt}
        toggleBreakBeforeRequest={toggleBreakBeforeRequest}
        toggleBreakAfterResponse={toggleBreakAfterResponse}
        openBreakpointsAt={openBreakpointsAt}
        disableAllBreakpoints={disableAllBreakpoints}
        applyQuickExecBpu={applyQuickExecBpu}
        toggleTlsInterceptMode={toggleTlsInterceptMode}
        applyPreset={applyPreset}
        toggleForceNoCache={toggleForceNoCache}
        resetAdvancedFilters={resetAdvancedFilters}
        toggleAllowRemote={toggleAllowRemote}
        toggleSystemProxy={toggleSystemProxy}
        generateStress10k={generateStress10k}
        handleTogglePythonScript={handleTogglePythonScript}
        setCertModalOpen={setCertModalOpen}
        handleChangeThrottleConfig={handleChangeThrottleConfig}
        exportAllSessionsAs={exportAllSessionsAs}
        exportSelectedSessionsAs={exportSelectedSessionsAs}
        openSanitizedExportModal={openSanitizedExportModal}
        openOpenApiExportModal={onOpenOpenApiExport}
        importArchiveDialog={importArchiveDialog}
        saveToSqlite={saveToSqlite}
        loadFromSqlite={loadFromSqlite}
        setConfirmSqlitePurgeOpen={setConfirmSqlitePurgeOpen}
        toggleDropNonMatching={toggleDropNonMatching}
        setSessionRetentionLimit={setSessionRetentionLimit}
        handleOpenCustomRetentionLimit={handleOpenCustomRetentionLimit}
        handleExportSettingsProfile={handleExportSettingsProfile}
        handleImportSettingsProfileDialog={handleImportSettingsProfileDialog}
        handleResetAllSettings={handleResetAllSettings}
        showToast={showToast}
      />
    </div>
  );
};

export const App: React.FC = () => (
  <ContextMenuProvider>
    <AppContent />
  </ContextMenuProvider>
);

export default App;
