import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { AutoResponderPanel } from "./components/AutoResponderPanel";
import {
  BreakpointBanner,
  BreakpointInterceptorModal,
} from "./components/BreakpointModal";
import { CertificateModal } from "./components/CertificateModal";
import {
  CommandPalette,
  type PaletteCommand,
} from "./components/CommandPalette";
import { ComposerPanel } from "./components/ComposerPanel";
import { FilterDrawer } from "./components/FilterDrawer";
import { MenuBar } from "./components/MenuBar";
import { MobileSetupModal } from "./components/MobileSetupModal";
import { SessionAnnotationModal } from "./components/SessionAnnotationModal";
import {
  SessionDiffModal,
  SessionDiffView,
} from "./components/SessionDiffView";
import { SessionInspector } from "./components/SessionInspector";
import {
  SettingsImportPreviewModal,
  SettingsModal,
} from "./components/SettingsModal";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { Sidebar } from "./components/Sidebar";
import {
  TextWizardModal,
  type TextWizardTab,
} from "./components/TextWizardModal";
import { TopToolbar } from "./components/TopToolbar";
import { TrafficGrid } from "./components/TrafficGrid";
import { useProxySessions } from "./hooks/useProxySessions";
import { useTheme } from "./hooks/useTheme";
import { useUiPreferences } from "./hooks/useUiPreferences";
import { buildCurlCommand, buildHeadersBlock } from "./lib/formatters";
import {
  applySettingsProfile,
  buildSettingsImportPreview,
  exportCurrentSettingsProfile,
  isLikelyFluxSettingsProfile,
  parseAndValidateSettingsJsonText,
  registerLiveSettingsSnapshotGetter,
  resetAllSettingsToDefault,
  SETTINGS_APPLIED_EVENT,
  SETTINGS_STORAGE_KEYS,
} from "./lib/settingsManager";
import { isTauriRuntime, proxyBridge } from "./lib/tauriBridge";
import type {
  ActiveNavSection,
  AutoResponderRule,
  ComposedRequest,
  FilterDrawerTab,
  SessionSummary,
} from "./types/proxy";
import type {
  FluxUserSettingsProfile,
  SettingsImportPreviewSummary,
  SettingsModalTab,
} from "./types/settings";

export const App: React.FC = () => {
  const { preference, resolvedTheme, setTheme, toggleLightDark } = useTheme();
  const {
    compactToolbar,
    setCompactToolbar,
    toggleCompactToolbar,
    sidebarCollapsed,
    setSidebarCollapsed,
    inspectorCollapsed,
    inspectorPosition,
    toggleSidebar,
    setInspectorCollapsed,
    toggleInspector,
    setInspectorPosition,
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
    toggleProxy,
    setProxyPort,
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
    importArchiveDialog,
    importArchiveFromPath,
    importArchiveFromDroppedFile,
    saveSessionBodyAs,
    generateStress10k,
  } = useProxySessions();

  const searchInputRef = useRef<HTMLInputElement>(null);
  const trafficGridRef = useRef<HTMLDivElement>(null);
  const inspectorContainerRef = useRef<HTMLDivElement>(null);

  const [activeSection, setActiveSection] =
    useState<ActiveNavSection>("traffic");
  const [dockedComposer, setDockedComposer] = useState(false);
  const [composerDraft, setComposerDraft] = useState<ComposedRequest | null>(
    null
  );
  const [autoResponderEnabled, setAutoResponderEnabled] = useState(true);
  const [rules, setRules] = useState<AutoResponderRule[]>([]);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] =
    useState<SettingsModalTab>("general");
  const [pendingImportState, setPendingImportState] = useState<{
    profile: FluxUserSettingsProfile;
    preview: SettingsImportPreviewSummary;
  } | null>(null);
  const [certModalOpen, setCertModalOpen] = useState(false);
  const [mobileModalOpen, setMobileModalOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);
  const [hexTriggerSeq, setHexTriggerSeq] = useState(0);
  const [customRetentionTriggerSeq, setCustomRetentionTriggerSeq] = useState(0);
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [filterDrawerTab, setFilterDrawerTab] =
    useState<FilterDrawerTab>("matrix");

  // Session Diff & User Annotations (Comment / Mark) Modal State
  const [annotationModalOpen, setAnnotationModalOpen] = useState(false);
  const [annotationTargetIds, setAnnotationTargetIds] = useState<number[]>([]);
  const [diffModalOpen, setDiffModalOpen] = useState(false);
  const [inlineDiffDismissed, setInlineDiffDismissed] = useState(false);

  // Drag-and-Drop Archive & Settings Profile Import (.har, .saz, .json) State
  const [fileDropActive, setFileDropActive] = useState(false);
  const [fileDropLabel, setFileDropLabel] = useState<string | null>(null);
  const htmlDragDepthRef = useRef(0);

  const openPreferencesAt = useCallback((tab: SettingsModalTab = "general") => {
    setSettingsInitialTab(tab);
    setSettingsModalOpen(true);
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

  const handleConfirmImportSettingsProfile = useCallback(async () => {
    if (!pendingImportState) return;
    const { profile, preview } = pendingImportState;
    try {
      await applySettingsProfile(profile);
      setPendingImportState(null);
      showToast(
        `✅ Профиль настроек применён: пресетов ${preview.userPresetsCount}, правил ${preview.totalRulesCount}, колонок ${preview.visibleColumnsCount}/${preview.totalColumnsCount}`
      );
    } catch (err) {
      showToast(
        `⚠️ Ошибка применения профиля настроек: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }, [pendingImportState, showToast]);

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
      const applied = await proxyBridge.setAutoResponderEnabled(nextEnabled);
      setAutoResponderEnabled(applied);
      persistAutoResponderStorage(applied, rules);
      showToast(
        applied
          ? "▶ AutoResponder включён"
          : "⏸ AutoResponder отключён глобально"
      );
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

      const [initialEnabled, initialRules] = await Promise.all([
        proxyBridge.getAutoResponderEnabled(),
        proxyBridge.listRules(),
      ]);
      if (!active) return;
      setAutoResponderEnabled(initialEnabled);
      setRules(initialRules);
      persistAutoResponderStorage(initialEnabled, initialRules);
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
  }, [persistAutoResponderStorage]);

  // Register live snapshot getter so `exportCurrentSettingsProfile()` captures live React state
  const liveSnapshotRef = useRef<() => Partial<FluxUserSettingsProfile>>(
    () => ({})
  );
  liveSnapshotRef.current = () => ({
    ui: {
      theme: preference,
      compactToolbar,
      sidebarCollapsed,
      inspectorCollapsed,
      inspectorPosition,
      followTail,
      columnWidths,
      visibleColumns,
      toolbarGroups,
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
        status.allowRemote || status.bindAddr === "0.0.0.0"
      ),
      tlsInterceptMode: backendFilterConfig.tlsInterceptMode,
      tlsBypassRules: backendFilterConfig.tlsBypassRules,
      tlsTargetRules: backendFilterConfig.tlsTargetRules,
      headerMutations: backendFilterConfig.headerMutations,
      tlsBypassEnabled: backendFilterConfig.tlsBypassEnabled,
      headerMutationsEnabled: backendFilterConfig.headerMutationsEnabled,
      stripAltSvc: backendFilterConfig.stripAltSvc,
      sessionRetentionLimit,
      dropNonMatching,
    },
    autoResponder: {
      enabled: autoResponderEnabled,
      rules,
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

  const handleOpenCustomRetentionLimit = useCallback(() => {
    setActiveSection("traffic");
    setCustomRetentionTriggerSeq((n) => n + 1);
  }, []);

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

  // Global keyboard shortcuts (never conflicting with text inputs, Monaco editors, modals, or popovers)
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return true;
      }
      if (target.isContentEditable) return true;
      if (target.closest(".monaco-editor")) return true;
      return false;
    };

    const hasOpenModal = (): boolean =>
      Boolean(document.querySelector("dialog[open]"));

    const isInsidePopover = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement && Boolean(target.closest("[popover]"));

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      const keyLower = e.key.toLowerCase();
      const ctrlOrMeta = e.ctrlKey || e.metaKey;

      // F12 -> Toggle proxy capture
      if (
        e.key === "F12" &&
        !ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        void toggleProxy();
        return;
      }

      // F11 / Alt+F11 / Shift+F11 -> Live Breakpoints
      if (e.key === "F11" && !ctrlOrMeta) {
        e.preventDefault();
        if (e.shiftKey) {
          void disableAllBreakpoints();
        } else if (e.altKey) {
          void toggleBreakAfterResponse();
        } else {
          void toggleBreakBeforeRequest();
        }
        return;
      }

      // Ctrl+K / Cmd+K -> Command Palette
      if (ctrlOrMeta && !e.altKey && !e.shiftKey && keyLower === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
        return;
      }

      // Ctrl+, / Cmd+, -> Preferences & Settings Profile Modal
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "," || e.code === "Comma")
      ) {
        e.preventDefault();
        setSettingsModalOpen((prev) => !prev);
        return;
      }

      // Ctrl+S / Cmd+S -> Save All Sessions As... (.har, .saz, .json)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "s" || e.code === "KeyS") &&
        !hasOpenModal()
      ) {
        e.preventDefault();
        void exportAllSessionsAs();
        return;
      }

      // Ctrl+O / Cmd+O -> Open / Import Archive... (.har, .saz, .json)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "o" || e.code === "KeyO") &&
        !hasOpenModal()
      ) {
        e.preventDefault();
        void importArchiveDialog();
        return;
      }

      // Ctrl+F / Cmd+F -> Focus Quick Filter bar (unless inside Monaco Editor or an open modal)
      if (ctrlOrMeta && !e.altKey && !e.shiftKey && keyLower === "f") {
        const inMonaco =
          e.target instanceof HTMLElement &&
          Boolean(e.target.closest(".monaco-editor"));
        if (!inMonaco && !hasOpenModal()) {
          e.preventDefault();
          handleFocusSearch();
        }
        return;
      }

      // Ctrl+E / Cmd+E -> TextWizard
      if (ctrlOrMeta && !e.altKey && !e.shiftKey && keyLower === "e") {
        e.preventDefault();
        setTextWizardOpen((prev) => !prev);
        return;
      }

      // Ctrl+Shift+M / Cmd+Shift+M -> Connect Mobile Device (iOS & Android Wi-Fi Proxy + QR Code)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        e.shiftKey &&
        (keyLower === "m" || e.code === "KeyM")
      ) {
        e.preventDefault();
        setMobileModalOpen((prev) => !prev);
        return;
      }

      // Ctrl+B / Cmd+B -> Toggle Sidebar
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        keyLower === "b" &&
        !isEditableTarget(e.target) &&
        !hasOpenModal()
      ) {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Ctrl+D / Cmd+D -> Session Diff
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "d" || e.code === "KeyD") &&
        !(
          e.target instanceof HTMLElement &&
          e.target.closest(".monaco-editor") &&
          !diffModalOpen
        )
      ) {
        e.preventDefault();
        if (diffModalOpen) {
          setDiffModalOpen(false);
        } else {
          openDiffWithPairSmart();
        }
        return;
      }

      // Ctrl+X / Cmd+X -> Clear all sessions (strictly outside text inputs so Cut works normally)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "x" || e.code === "KeyX") &&
        !isEditableTarget(e.target) &&
        !hasOpenModal()
      ) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) {
          return;
        }
        e.preventDefault();
        void clearAllSessions();
        return;
      }

      // Ctrl+R / Cmd+R -> Replay selected request(s) to upstream (prevent accidental WebView reload)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "r" || e.code === "KeyR")
      ) {
        e.preventDefault();
        if (
          !isEditableTarget(e.target) &&
          !hasOpenModal() &&
          effectiveSelectedIds.length > 0
        ) {
          void replaySessions(effectiveSelectedIds);
        }
        return;
      }

      // Ctrl+C / Cmd+C -> Copy selected session URL(s) when no DOM text selection is active
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "c" || e.code === "KeyC") &&
        !isEditableTarget(e.target) &&
        !hasOpenModal()
      ) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) {
          return;
        }
        if (effectiveSelectedIds.length > 0) {
          e.preventDefault();
          copyUrlsForIds(effectiveSelectedIds);
        }
        return;
      }

      // Alt+1..4 -> Primary views
      if (e.altKey && !ctrlOrMeta && !e.shiftKey) {
        if (e.key === "1") {
          e.preventDefault();
          setActiveSection("traffic");
          return;
        }
        if (e.key === "2") {
          e.preventDefault();
          setActiveSection("composer");
          return;
        }
        if (e.key === "3") {
          e.preventDefault();
          setActiveSection("rules");
          return;
        }
        if (e.key === "4") {
          e.preventDefault();
          setFilterDrawerOpen((prev) => !prev);
          return;
        }
      }

      // Single-key shortcuts (only when outside inputs, modals, and open popovers)
      if (
        !ctrlOrMeta &&
        !e.altKey &&
        !isEditableTarget(e.target) &&
        !hasOpenModal() &&
        !isInsidePopover(e.target)
      ) {
        if (e.key === "?") {
          e.preventDefault();
          setShortcutsModalOpen((prev) => !prev);
          return;
        }

        if (activeSection !== "traffic") return;

        if (keyLower === "m" || e.code === "KeyM") {
          e.preventDefault();
          openAnnotationFor(effectiveSelectedIds);
          return;
        }

        if (
          (keyLower === "u" || e.code === "KeyU") &&
          effectiveSelectedIds.length > 0
        ) {
          e.preventDefault();
          void unmarkSessions(effectiveSelectedIds);
          return;
        }

        if (
          (keyLower === "r" || e.code === "KeyR") &&
          !e.shiftKey &&
          effectiveSelectedIds.length > 0
        ) {
          e.preventDefault();
          void replaySessions(effectiveSelectedIds);
          return;
        }

        if (
          (e.key === "Delete" || e.key === "Backspace") &&
          effectiveSelectedIds.length > 0 &&
          !(e.target instanceof HTMLElement && e.target.closest("button"))
        ) {
          e.preventDefault();
          void deleteSessions(effectiveSelectedIds);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeSection,
    clearAllSessions,
    copyUrlsForIds,
    deleteSessions,
    diffModalOpen,
    disableAllBreakpoints,
    effectiveSelectedIds,
    exportAllSessionsAs,
    handleFocusSearch,
    importArchiveDialog,
    openAnnotationFor,
    openDiffWithPairSmart,
    replaySessions,
    toggleBreakAfterResponse,
    toggleBreakBeforeRequest,
    toggleProxy,
    toggleSidebar,
    unmarkSessions,
  ]);

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

  const commands: PaletteCommand[] = useMemo(
    () => [
      {
        id: "replay-selected",
        category: "Traffic",
        label: "Replay выбранной сессии напрямую в upstream",
        shortcut: "R / Ctrl+R",
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
        label: "Удалить выбранные сессии из списка",
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
        label: "Clear All Captured Traffic Sessions",
        shortcut: "Ctrl+X",
        perform: () => void clearAllSessions(),
      },
      {
        id: "copy-curl",
        category: "Traffic",
        label: "Copy Selected Session as cURL",
        perform: () => {
          if (selectedId !== null) void copySessionAsCurl(selectedId);
        },
      },
      {
        id: "open-session-diff",
        category: "Session Diff",
        label:
          "Открыть Session Diff — сравнение заголовков, кук и JSON двух сессий (Monaco DiffEditor)",
        shortcut: "Ctrl+D",
        perform: () => openDiffWithPairSmart(),
      },
      {
        id: "annotate-session",
        category: "Annotations",
        label:
          "Добавить комментарий и цветовую заливку к выбранной сессии (Comment / Mark)",
        shortcut: "M",
        perform: () => openAnnotationFor(effectiveSelectedIds),
      },
      {
        id: "unmark-session",
        category: "Annotations",
        label: "Снять цветовую метку с выбранных сессий (Unmark)",
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
        label: "Показать только помеченные сессии (Marked / Comments)",
        perform: () => {
          setActiveSection("traffic");
          setQuickCategory("marked");
        },
      },
      {
        id: "inspect-hex",
        category: "Inspector",
        label: "Открыть выбранную сессию во вкладке Hex View",
        perform: handleInspectInHex,
      },
      {
        id: "toggle-sidebar",
        category: "View",
        label: sidebarCollapsed
          ? "Показать боковую панель (Sidebar)"
          : "Скрыть боковую панель (Sidebar)",
        shortcut: "Ctrl+B",
        perform: toggleSidebar,
      },
      {
        id: "toggle-inspector",
        category: "View",
        label: inspectorCollapsed
          ? "Развернуть панель Session Inspector"
          : "Свернуть панель Session Inspector",
        shortcut: "Space",
        perform: toggleInspector,
      },
      {
        id: "dock-inspector-bottom",
        category: "View",
        label: "Расположить Session Inspector снизу (Bottom Split)",
        perform: () => setInspectorPosition("bottom"),
      },
      {
        id: "dock-inspector-right",
        category: "View",
        label: "Расположить Session Inspector справа (Right Split)",
        perform: () => setInspectorPosition("right"),
      },
      {
        id: "reset-columns",
        category: "View",
        label: "Сбросить ширину и видимость колонок таблицы",
        perform: resetColumns,
      },
      {
        id: "open-shortcuts-modal",
        category: "Help",
        label: "Показать справку по горячим клавишам (Keyboard Shortcuts)",
        shortcut: "?",
        perform: () => setShortcutsModalOpen(true),
      },
      {
        id: "open-text-wizard",
        category: "TextWizard",
        label:
          "Открыть TextWizard & JWT Decoder (Base64, URL, Gzip/Brotli, Hex, Timestamp)",
        shortcut: "Ctrl+E",
        perform: () => openTextWizardAt("jwt"),
      },
      {
        id: "open-jwt-inspector",
        category: "TextWizard",
        label: "JWT Inspector: декодировать Header / Claims и проверить exp",
        perform: () => openTextWizardAt("jwt"),
      },
      {
        id: "open-compression-codec",
        category: "TextWizard",
        label: "TextWizard: Сжатие и распаковка Gzip / Brotli / Deflate",
        perform: () => openTextWizardAt("compression"),
      },
      {
        id: "toggle-bp-request",
        category: "Breakpoints",
        label: breakpointConfig.breakBeforeRequest
          ? "Отключить Break on Request (перехват до отправки на апстрим)"
          : "Включить Break on Request — ставить запросы на паузу в Monaco",
        shortcut: "F11",
        perform: () => void toggleBreakBeforeRequest(),
      },
      {
        id: "toggle-bp-response",
        category: "Breakpoints",
        label: breakpointConfig.breakAfterResponse
          ? "Отключить Break on Response (перехват ответа сервера)"
          : "Включить Break on Response — править JSON или код 500 на лету",
        shortcut: "Alt+F11",
        perform: () => void toggleBreakAfterResponse(),
      },
      {
        id: "open-bp-rules",
        category: "Breakpoints",
        label:
          "Открыть Live Breakpoints и правила `bpu` / `bpafter` (или введите `bpu <url>` выше)",
        perform: () =>
          openBreakpointsAt(
            pausedBreakpoints.length > 0 ? "intercept" : "rules"
          ),
      },
      {
        id: "disable-all-breakpoints",
        category: "Breakpoints",
        label: "Снять все точки останова и отпустить ожидающие запросы",
        shortcut: "Shift+F11",
        perform: () => void disableAllBreakpoints(),
      },
      {
        id: "open-filters-matrix",
        category: "Filters",
        label: "Открыть Таблицу фильтров и Пресеты (Include / Exclude / PID)",
        shortcut: "Alt+4",
        perform: () => openFilterDrawerAt("matrix"),
      },
      {
        id: "open-hosts-list-filter",
        category: "Filters",
        label:
          "Открыть Массовый фильтр хостов и URL (Hosts List: Show only Whitelist / Hide Blacklist)",
        perform: () => openFilterDrawerAt("hostsList"),
      },
      {
        id: "open-tls-bypass",
        category: "TLS / CA",
        label:
          "Открыть настройки Selective TLS MITM: Target Allowlist & Bypass",
        perform: () => openFilterDrawerAt("tlsBypass"),
      },
      {
        id: "toggle-tls-mitm-mode",
        category: "TLS / CA",
        label:
          backendFilterConfig.tlsInterceptMode === "targetedOnly"
            ? "Переключить в Mode: Intercept All (расшифровка всего, кроме Bypass)"
            : "Включить Mode: Targeted Only (Allowlist) — «Чистый проброс» всего, кроме целевых хостов",
        perform: () => void toggleTlsInterceptMode(),
      },
      {
        id: "preset-backend-api",
        category: "Preset",
        label: "Применить пресет: «Только API бэкенда»",
        perform: () => applyPreset("preset-backend-api"),
      },
      {
        id: "preset-hide-noise",
        category: "Preset",
        label: "Применить пресет: «Скрыть аналитику и фоновый шум ОС»",
        perform: () => applyPreset("preset-hide-os-noise"),
      },
      {
        id: "toggle-nocache",
        category: "Filters",
        label: isForceNoCacheActive
          ? "Отключить принудительный обход кэша (If-Modified-Since / ETag)"
          : "Включить принудительный обход кэша (Удалять If-Modified-Since / ETag)",
        perform: () => void toggleForceNoCache(),
      },
      {
        id: "reset-filters",
        category: "Filters",
        label: "Сбросить все табличные фильтры и пороги шума",
        perform: resetAdvancedFilters,
      },
      {
        id: "connect-mobile-device",
        category: "Proxy",
        label:
          "Connect Mobile Device — iOS & Android Wi-Fi Proxy + QR Code (flux.proxy)",
        shortcut: "Ctrl+Shift+M",
        perform: () => setMobileModalOpen(true),
      },
      {
        id: "toggle-allow-remote",
        category: "Proxy",
        label:
          status.allowRemote || status.bindAddr === "0.0.0.0"
            ? "Отключить удаленные подключения (слушать только 127.0.0.1)"
            : "Разрешить подключения с удаленных устройств (0.0.0.0 / LAN Wi-Fi)",
        perform: () => void toggleAllowRemote(),
      },
      {
        id: "toggle-proxy",
        category: "Proxy",
        label: status.running
          ? "Pause MITM Capture & Rollback OS System Proxy"
          : status.autoSystemProxy
            ? "Start MITM Capture & Enable OS System Proxy (127.0.0.1:8888)"
            : "Start Local MITM Proxy Listener Only (127.0.0.1:8888)",
        shortcut: "F12",
        perform: () => void toggleProxy(),
      },
      {
        id: "toggle-system-proxy",
        category: "Proxy",
        label: status.systemProxyError
          ? `Переподключить системный прокси ОС (127.0.0.1:${status.port})`
          : status.systemProxyEnabled
            ? "Отключить системный прокси ОС (оставить только локальный порт HTTP_PROXY)"
            : `Включить системный прокси ОС (направить браузеры на 127.0.0.1:${status.port})`,
        perform: () => void toggleSystemProxy(),
      },
      {
        id: "stress-10k",
        category: "Benchmark",
        label: "Generate +10,000 Sessions (Test Virtualized Scrolling)",
        perform: generateStress10k,
      },
      {
        id: "view-traffic",
        category: "View",
        label: "Switch to Traffic Viewer & Session Inspector",
        shortcut: "Alt+1",
        perform: () => setActiveSection("traffic"),
      },
      {
        id: "view-composer",
        category: "View",
        label: "Switch to Request Composer",
        shortcut: "Alt+2",
        perform: () => setActiveSection("composer"),
      },
      {
        id: "toggle-docked-composer",
        category: "View",
        label: dockedComposer
          ? "Hide Docked Split Composer"
          : "Dock Composer Split Beside Traffic Viewer (Drag & Drop)",
        perform: () => {
          setActiveSection("traffic");
          setDockedComposer((v) => !v);
        },
      },
      {
        id: "view-rules",
        category: "AutoResponder",
        label: "Open AutoResponder & Latency Simulation Rules",
        shortcut: "Alt+3",
        perform: () => setActiveSection("rules"),
      },
      {
        id: "root-ca",
        category: "TLS / CA",
        label: "Inspect or Install HTTPS MITM Root CA Certificate",
        perform: () => setCertModalOpen(true),
      },
      {
        id: "save-all-archive",
        category: "Storage",
        label: "Save All Sessions As... (.har, .saz, .json)",
        shortcut: "Ctrl+S",
        perform: () => void exportAllSessionsAs(),
      },
      {
        id: "save-selected-archive",
        category: "Storage",
        label: "Save Selected Sessions... (.har, .saz, .json)",
        perform: () => void exportSelectedSessionsAs(),
      },
      {
        id: "import-archive",
        category: "Storage",
        label: "Open / Import Archive... (.har, .saz, .json)",
        shortcut: "Ctrl+O",
        perform: () => void importArchiveDialog(),
      },
      {
        id: "sqlite-save",
        category: "Storage",
        label: "Save Captured Sessions to SQLite Database",
        perform: () => void saveToSqlite(),
      },
      {
        id: "sqlite-load",
        category: "Storage",
        label: "Restore Sessions from SQLite Database",
        perform: () => void loadFromSqlite(),
      },
      {
        id: "toggle-drop-non-matching",
        category: "Storage",
        label: dropNonMatching
          ? "Disable Drop Non-Matching Traffic on Capture"
          : "Enable Drop Non-Matching Traffic on Capture (Save RAM)",
        perform: () => void toggleDropNonMatching(),
      },
      {
        id: "retention-all",
        category: "Storage",
        label: "Session Retention Limit: Keep All Sessions (Unlimited)",
        perform: () => void setSessionRetentionLimit(null),
      },
      {
        id: "retention-1000",
        category: "Storage",
        label: "Session Retention Limit: Keep 1,000 Sessions",
        perform: () => void setSessionRetentionLimit(1000),
      },
      {
        id: "retention-10000",
        category: "Storage",
        label: "Session Retention Limit: Keep 10,000 Sessions (Default)",
        perform: () => void setSessionRetentionLimit(10000),
      },
      {
        id: "retention-custom",
        category: "Storage",
        label: "Session Retention Limit: Enter Custom Limit...",
        perform: handleOpenCustomRetentionLimit,
      },
      {
        id: "theme-dark",
        category: "Theme",
        label: "Set Theme: Dark",
        perform: () => setTheme("dark"),
      },
      {
        id: "theme-light",
        category: "Theme",
        label: "Set Theme: Light",
        perform: () => setTheme("light"),
      },
      {
        id: "theme-system",
        category: "Theme",
        label: "Set Theme: Follow OS System Preference",
        perform: () => setTheme("system"),
      },
      {
        id: "open-preferences",
        category: "Settings",
        label: "Preferences... — Открыть настройки и управление профилем",
        shortcut: "Ctrl+,",
        perform: () => openPreferencesAt("general"),
      },
      {
        id: "export-settings-profile",
        category: "Settings",
        label:
          "Export Settings Profile (JSON)... — Сохранить fluxproxy-settings-v1.json",
        perform: () => void handleExportSettingsProfile(),
      },
      {
        id: "import-settings-profile",
        category: "Settings",
        label:
          "Import Settings Profile... — Загрузить профиль настроек с превью",
        perform: () => void handleImportSettingsProfileDialog(),
      },
      {
        id: "reset-all-settings-defaults",
        category: "Settings",
        label:
          "Reset All Settings to Defaults... — Сбросить все настройки к дефолтам",
        perform: () => void handleResetAllSettings(false),
      },
    ],
    [
      applyPreset,
      backendFilterConfig.tlsInterceptMode,
      breakpointConfig.breakAfterResponse,
      breakpointConfig.breakBeforeRequest,
      clearAllSessions,
      copySessionAsCurl,
      deleteSessions,
      disableAllBreakpoints,
      dockedComposer,
      dropNonMatching,
      effectiveSelectedIds,
      exportAllSessionsAs,
      exportSelectedSessionsAs,
      generateStress10k,
      handleExportSettingsProfile,
      handleImportSettingsProfileDialog,
      handleInspectInHex,
      handleOpenCustomRetentionLimit,
      handleResetAllSettings,
      importArchiveDialog,
      inspectorCollapsed,
      isForceNoCacheActive,
      loadFromSqlite,
      openAnnotationFor,
      openBreakpointsAt,
      openDiffWithPairSmart,
      openFilterDrawerAt,
      openPreferencesAt,
      openTextWizardAt,
      pausedBreakpoints.length,
      replaySessions,
      resetAdvancedFilters,
      resetColumns,
      saveToSqlite,
      selectedId,
      setInspectorPosition,
      setQuickCategory,
      setSessionRetentionLimit,
      setTheme,
      showToast,
      sidebarCollapsed,
      status.allowRemote,
      status.autoSystemProxy,
      status.bindAddr,
      status.port,
      status.running,
      status.systemProxyEnabled,
      status.systemProxyError,
      toggleAllowRemote,
      toggleBreakAfterResponse,
      toggleBreakBeforeRequest,
      toggleDropNonMatching,
      toggleForceNoCache,
      toggleInspector,
      toggleProxy,
      toggleSidebar,
      toggleSystemProxy,
      toggleTlsInterceptMode,
      unmarkSessions,
    ]
  );

  const activeTargetHostsCount = useMemo(
    () =>
      (backendFilterConfig.tlsTargetRules ?? []).filter(
        (r) => r.enabled && !r.pattern.trim().startsWith("!")
      ).length,
    [backendFilterConfig.tlsTargetRules]
  );

  const activeRulesCount = autoResponderEnabled
    ? rules.filter((r) => r.enabled).length
    : 0;
  const breakpointsArmed =
    breakpointConfig.breakBeforeRequest ||
    breakpointConfig.breakAfterResponse ||
    breakpointConfig.rules.some((r) => r.enabled);
  const showInlineSessionDiff =
    selectedIds.length === 2 && !inlineDiffDismissed;

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
      onFocusInspector={handleFocusInspector}
      onDeleteSessions={(ids) => void deleteSessions(ids)}
      onReplaySessions={(ids) => void replaySessions(ids)}
      onUnmarkSessions={(ids) => void unmarkSessions(ids)}
      onCopyUrl={copyUrlsForIds}
      onCopyCurl={(id) => void copySessionAsCurl(id)}
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
      onSaveSessionBody={(id, isResponse) =>
        void saveSessionBodyAs(id, isResponse)
      }
      onFilterByProcess={(proc) => quickFilterByProcess(proc, "include")}
      onFilterByClientIp={(ip) => quickFilterByClientIp(ip, "include")}
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
        onCloseDiff={() => setInlineDiffDismissed(true)}
      />
    ) : (
      <SessionInspector
        detail={selectedDetail}
        resolvedTheme={resolvedTheme}
        containerRef={inspectorContainerRef}
        onReturnFocusToGrid={focusTrafficGrid}
        inspectorPosition={inspectorPosition}
        onChangeInspectorPosition={setInspectorPosition}
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
        onImportArchive={() => void importArchiveDialog()}
        onSaveSqlite={() => void saveToSqlite()}
        onLoadSqlite={() => void loadFromSqlite()}
        onClearSessions={() => void clearAllSessions()}
        onExportSettingsProfile={() => void handleExportSettingsProfile()}
        onImportSettingsProfile={() => void handleImportSettingsProfileDialog()}
        onOpenPreferences={() => openPreferencesAt("general")}
        onCopyUrl={() => copyUrlsForIds(effectiveSelectedIds)}
        onCopyCurl={() => {
          if (selectedId !== null) void copySessionAsCurl(selectedId);
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
        themePreference={preference}
        onSetTheme={setTheme}
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
                key="traffic-layout-bottom"
                direction="horizontal"
                className="h-full w-full"
              >
                <Panel
                  id="traffic-bottom-stack"
                  order={1}
                  defaultSize={dockedComposer ? 74 : 100}
                  minSize={35}
                >
                  <PanelGroup direction="vertical" className="h-full w-full">
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
                        <PanelResizeHandle className="h-1 w-full bg-hairline transition-colors hover:bg-accent/60" />
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
                    <PanelResizeHandle className="w-1 bg-hairline transition-colors hover:bg-accent/60" />
                    <Panel
                      id="docked-composer-panel"
                      order={2}
                      defaultSize={26}
                      minSize={20}
                    >
                      <ComposerPanel
                        draftRequest={composerDraft}
                        resolvedTheme={resolvedTheme}
                        onLoadSessionIntoComposer={(id) =>
                          void loadSessionIntoComposer(id, false)
                        }
                        onSessionCreated={(detail) =>
                          setSelectedId(detail.summary.id)
                        }
                      />
                    </Panel>
                  </>
                )}
              </PanelGroup>
            )}

            {activeSection === "traffic" && inspectorPosition === "right" && (
              <PanelGroup
                key="traffic-layout-right"
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
                    <PanelResizeHandle className="w-1 bg-hairline transition-colors hover:bg-accent/60" />
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
                    <PanelResizeHandle className="w-1 bg-hairline transition-colors hover:bg-accent/60" />
                    <Panel
                      id="docked-composer-right"
                      order={3}
                      defaultSize={24}
                      minSize={20}
                    >
                      <ComposerPanel
                        draftRequest={composerDraft}
                        resolvedTheme={resolvedTheme}
                        onLoadSessionIntoComposer={(id) =>
                          void loadSessionIntoComposer(id, false)
                        }
                        onSessionCreated={(detail) =>
                          setSelectedId(detail.summary.id)
                        }
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
                onLoadSessionIntoComposer={(id) =>
                  void loadSessionIntoComposer(id, true)
                }
                onSessionCreated={(detail) => setSelectedId(detail.summary.id)}
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
                ? `SysProxy: 127.0.0.1:${status.port}`
                : status.running
                  ? "Port Only"
                  : "Proxy Off"}
          </button>
          <span className="hidden text-subtle md:inline">•</span>
          <button
            type="button"
            onClick={() => setMobileModalOpen(true)}
            title="Подключить мобильное устройство iOS / Android по Wi-Fi (Ctrl+Shift+M)"
            className={`hidden shrink-0 hover:underline md:inline ${
              status.allowRemote || status.bindAddr === "0.0.0.0"
                ? "text-status2xx-fg"
                : "text-muted"
            }`}
          >
            {status.allowRemote || status.bindAddr === "0.0.0.0"
              ? `LAN: 0.0.0.0:${status.port}`
              : "Mobile: Local Only"}
          </button>
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
            className="shrink-0 tabular-nums text-muted transition-colors hover:text-fg"
          >
            RAM:{" "}
            <strong className="font-semibold text-fg">
              {storageStats.ramSessions.toLocaleString("en-US")}
            </strong>{" "}
            ses | SQLite:{" "}
            <strong className="font-semibold text-fg">
              {(storageStats.sqliteSizeBytes / (1024 * 1024)).toFixed(1)} MB
            </strong>{" "}
            | Dropped:{" "}
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

      <SettingsModal
        open={settingsModalOpen}
        initialTab={settingsInitialTab}
        onClose={() => setSettingsModalOpen(false)}
        themePreference={preference}
        onSetTheme={setTheme}
        compactToolbar={compactToolbar}
        onSetCompactToolbar={setCompactToolbar}
        sidebarCollapsed={sidebarCollapsed}
        onSetSidebarCollapsed={setSidebarCollapsed}
        inspectorCollapsed={inspectorCollapsed}
        onSetInspectorCollapsed={setInspectorCollapsed}
        inspectorPosition={inspectorPosition}
        onSetInspectorPosition={setInspectorPosition}
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
        sessionRetentionLimit={sessionRetentionLimit}
        onSetSessionRetentionLimit={setSessionRetentionLimit}
        dropNonMatching={dropNonMatching}
        onSetDropNonMatching={setDropNonMatching}
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
          openImportPreviewFromJsonText(jsonText, label ?? "pasted-settings.json")
        }
        onResetAllToDefaults={() => handleResetAllSettings(true)}
        onNotify={showToast}
      />

      <SettingsImportPreviewModal
        preview={pendingImportState?.preview ?? null}
        onCancel={() => setPendingImportState(null)}
        onConfirm={handleConfirmImportSettingsProfile}
      />

      <SessionAnnotationModal
        open={annotationModalOpen}
        targetSessions={annotationTargetSessions}
        onClose={() => setAnnotationModalOpen(false)}
        onSave={(ids, comment, markedColor) => {
          void annotateSessions(ids, comment, markedColor);
        }}
      />

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

      <TextWizardModal
        open={textWizardOpen}
        initialTab={textWizardTab}
        initialInput={textWizardInput}
        onClose={() => setTextWizardOpen(false)}
        onNotify={showToast}
      />

      <CertificateModal
        open={certModalOpen}
        onClose={() => setCertModalOpen(false)}
        onNotify={showToast}
      />

      <MobileSetupModal
        open={mobileModalOpen}
        status={status}
        onSetAllowRemote={setAllowRemote}
        onToggleProxy={toggleProxy}
        onClose={() => setMobileModalOpen(false)}
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
      />
    </div>
  );
};

export default App;
