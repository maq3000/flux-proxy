import React, { useMemo } from "react";
import { useTheme } from "../../hooks/useTheme";
import { useUiPreferences } from "../../hooks/useUiPreferences";
import { getSectionMeta } from "../../lib/sectionRegistry";
import { THEME_PRESETS } from "../../lib/themePresets";
import { useFilterStore } from "../../stores/filterStore";
import { useProxyStore } from "../../stores/proxyStore";
import { useTrafficTelemetryStore } from "../../stores/trafficTelemetryStore";
import {
  THROTTLE_PRESET_DEFINITIONS,
  type ActiveNavSection,
  type BreakpointConfig,
  type PausedBreakpointItem,
  type ProxyStatus,
  type QuickFilterCategory,
  type ThrottleConfig,
} from "../../types/proxy";
import type { SettingsModalSubTab, SettingsModalTab } from "../../types/settings";
import type { BreakpointsPanelMode } from "../BreakpointsPanel";
import { CommandPalette, type PaletteCommand } from "../CommandPalette";
import type { TextWizardTab } from "../TextWizardPanel";
import type { TrafficStatisticsScope } from "../TrafficStatisticsModal";

const EMPTY_COMMANDS: PaletteCommand[] = [];

export interface CommandPaletteContainerProps {
  open: boolean;
  onClose: () => void;
  status: ProxyStatus;
  selectedId: number | null;
  effectiveSelectedIds: number[];
  activePresetId: string | null;
  activeFilterBadgeCount: number;
  activeTargetHostsCount: number;
  enabledTlsBypassCount: number;
  compiledHostListActiveCount: number;
  isForceNoCacheActive: boolean;
  breakpointConfig: BreakpointConfig;
  pausedBreakpoints: PausedBreakpointItem[];
  dropNonMatching: boolean;
  sessionRetentionLimit: number | null;
  trafficViewMode: "grid" | "waterfall";
  activeHostRemapCount: number;
  upstreamProxyActiveLabel: string | null;
  throttleConfig: ThrottleConfig;
  // Actions
  toggleProxy: () => Promise<void>;
  handleSelectAllSessions: () => void;
  replaySessions: (ids: number[]) => Promise<void>;
  loadSessionIntoComposer: (sessionId: number) => Promise<void>;
  deleteSessions: (ids: number[]) => Promise<void>;
  clearAllSessions: () => Promise<void>;
  copySessionAsCurl: (sessionId: number) => Promise<void>;
  openCodeGeneratorForSession: (sessionId: number) => Promise<void>;
  openDiffWithPairSmart: (anchorSessionId?: number) => void;
  openAnnotationFor: (ids: number[]) => void;
  unmarkSessions: (ids: number[]) => Promise<void>;
  setActiveSection: (section: ActiveNavSection) => void;
  setQuickCategory: (cat: QuickFilterCategory) => void;
  handleInspectInHex: () => void;
  handleOpenStatistics: () => void;
  openTrafficStatisticsModal: (scope?: TrafficStatisticsScope) => void;
  handleSetTrafficViewMode: (mode: "grid" | "waterfall") => void;
  handleResetPanelLayout: () => void;
  setShortcutsModalOpen: (open: boolean) => void;
  openPreferencesAt: (
    tab?: SettingsModalTab,
    subTab?: SettingsModalSubTab
  ) => void;
  openTextWizardAt: (tab?: TextWizardTab, input?: string) => void;
  toggleBreakBeforeRequest: () => Promise<void>;
  toggleBreakAfterResponse: () => Promise<void>;
  openBreakpointsAt: (mode: BreakpointsPanelMode, bpId?: string) => void;
  disableAllBreakpoints: () => Promise<void>;
  applyQuickExecBpu: (
    stage: "request" | "response",
    pattern: string
  ) => Promise<void>;
  toggleTlsInterceptMode: () => Promise<void>;
  applyPreset: (presetId: string) => void;
  toggleForceNoCache: () => Promise<void>;
  resetAdvancedFilters: () => void;
  toggleAllowRemote: () => Promise<void>;
  toggleSystemProxy: () => Promise<void>;
  generateStress10k: () => Promise<void>;
  handleTogglePythonScript: (nextEnabled: boolean) => Promise<void>;
  setCertModalOpen: (open: boolean) => void;
  handleChangeThrottleConfig: (cfg: ThrottleConfig) => Promise<void>;
  exportAllSessionsAs: () => Promise<void>;
  exportSelectedSessionsAs: () => Promise<void>;
  openSanitizedExportModal: () => void;
  openOpenApiExportModal: () => void;
  importArchiveDialog: () => Promise<void>;
  saveToSqlite: () => Promise<void>;
  loadFromSqlite: () => Promise<void>;
  setConfirmSqlitePurgeOpen: (open: boolean) => void;
  toggleDropNonMatching: () => Promise<void>;
  setSessionRetentionLimit: (limit: number | null) => Promise<void>;
  handleOpenCustomRetentionLimit: () => void;
  handleExportSettingsProfile: () => Promise<void>;
  handleImportSettingsProfileDialog: () => Promise<void>;
  handleResetAllSettings: (skipConfirm?: boolean) => Promise<void>;
  showToast: (msg: string) => void;
}

const OpenCommandPaletteContent: React.FC<CommandPaletteContainerProps> = ({
  open,
  onClose,
  status,
  selectedId,
  effectiveSelectedIds,
  activePresetId,
  activeFilterBadgeCount,
  activeTargetHostsCount,
  enabledTlsBypassCount,
  compiledHostListActiveCount,
  isForceNoCacheActive,
  breakpointConfig,
  pausedBreakpoints,
  dropNonMatching,
  sessionRetentionLimit,
  trafficViewMode,
  activeHostRemapCount,
  upstreamProxyActiveLabel,
  throttleConfig,
  toggleProxy,
  handleSelectAllSessions,
  replaySessions,
  loadSessionIntoComposer,
  deleteSessions,
  clearAllSessions,
  copySessionAsCurl,
  openCodeGeneratorForSession,
  openDiffWithPairSmart,
  openAnnotationFor,
  unmarkSessions,
  setActiveSection,
  setQuickCategory,
  handleInspectInHex,
  handleOpenStatistics,
  openTrafficStatisticsModal,
  handleSetTrafficViewMode,
  handleResetPanelLayout,
  setShortcutsModalOpen,
  openPreferencesAt,
  openTextWizardAt,
  toggleBreakBeforeRequest,
  toggleBreakAfterResponse,
  openBreakpointsAt,
  disableAllBreakpoints,
  applyQuickExecBpu,
  toggleTlsInterceptMode,
  applyPreset,
  toggleForceNoCache,
  resetAdvancedFilters,
  toggleAllowRemote,
  toggleSystemProxy,
  generateStress10k,
  handleTogglePythonScript,
  setCertModalOpen,
  handleChangeThrottleConfig,
  exportAllSessionsAs,
  exportSelectedSessionsAs,
  openSanitizedExportModal,
  openOpenApiExportModal,
  importArchiveDialog,
  saveToSqlite,
  loadFromSqlite,
  setConfirmSqlitePurgeOpen,
  toggleDropNonMatching,
  setSessionRetentionLimit,
  handleOpenCustomRetentionLimit,
  handleExportSettingsProfile,
  handleImportSettingsProfileDialog,
  handleResetAllSettings,
  showToast,
}) => {
  const {
    preference,
    resolvedTheme,
    themePreset,
    setTheme,
    setThemePreset,
  } = useTheme();
  const {
    compactToolbar,
    sidebarCollapsed,
    inspectorCollapsed,
    inspectorPosition,
    toggleCompactToolbar,
    toggleSidebar,
    toggleInspector,
    setInspectorPosition,
    resetColumns,
  } = useUiPreferences();

  const filteredSessionsCount = useTrafficTelemetryStore(
    (s) => s.filteredCount
  );
  const markedSessionsCount = useProxyStore((s) => s.markedSessionsCount);
  const autoResponderEnabled = useProxyStore((s) => s.autoResponderEnabled);
  const rules = useProxyStore((s) => s.rules);
  const scriptEnabled = useProxyStore((s) => s.scriptEnabled);
  const hostListFilter = useFilterStore((s) => s.hostListFilter);
  const tlsInterceptMode = useFilterStore(
    (s) => s.backendFilterConfig.tlsInterceptMode
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
        statusBadge: `${filteredSessionsCount.toLocaleString("en-US")} сессий`,
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
          ? `${hostListFilter.mode === "whitelist" ? "Allow" : "Block"} (${compiledHostListActiveCount})`
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
          tlsInterceptMode === "targetedOnly"
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
          tlsInterceptMode === "targetedOnly"
            ? "Переключить в Mode: Intercept All (расшифровка всего, кроме Bypass)"
            : "Включить Mode: Targeted Only (Allowlist) — «Чистый проброс» всего, кроме целевых хостов",
        description: "Переключение между полной расшифровкой HTTPS и режимом целевого списка",
        statusBadge:
          tlsInterceptMode === "targetedOnly"
            ? `Targeted (${activeTargetHostsCount})`
            : "Intercept All",
        perform: () => void toggleTlsInterceptMode(),
      },
      {
        id: "preset-backend-api",
        category: "Preset",
        group: "filters",
        label: "Применить пресет: «Только API бэкенда»",
        description:
          "Оставить JSON/GraphQL/API-запросы и скрыть CSS, картинки, шрифты и JS-скрипты",
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
        label: scriptEnabled ? "Disable Scripts" : "Enable Scripts",
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
      breakpointConfig.breakAfterResponse,
      breakpointConfig.breakBeforeRequest,
      breakpointsArmed,
      clearAllSessions,
      compactToolbar,
      compiledHostListActiveCount,
      copySessionAsCurl,
      deleteSessions,
      disableAllBreakpoints,
      dropNonMatching,
      effectiveSelectedIds,
      enabledBreakpointRulesCount,
      enabledTlsBypassCount,
      exportAllSessionsAs,
      exportSelectedSessionsAs,
      filteredSessionsCount,
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
      setActiveSection,
      setCertModalOpen,
      setConfirmSqlitePurgeOpen,
      setInspectorPosition,
      setQuickCategory,
      setSessionRetentionLimit,
      setShortcutsModalOpen,
      setTheme,
      setThemePreset,
      showToast,
      sidebarCollapsed,
      status.allowRemote,
      status.autoSystemProxy,
      status.port,
      status.running,
      status.systemProxyEnabled,
      status.systemProxyError,
      themePreset,
      throttleConfig.preset,
      tlsInterceptMode,
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

  return (
    <CommandPalette
      open={open}
      onClose={onClose}
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
      onQuickOpenTrafficStatistics={() => openTrafficStatisticsModal("filtered")}
      onQuickOpenWaterfall={() => handleSetTrafficViewMode("waterfall")}
    />
  );
};

export const CommandPaletteContainer: React.FC<CommandPaletteContainerProps> = (
  props
) => {
  if (!props.open) {
    return (
      <CommandPalette
        open={false}
        onClose={props.onClose}
        commands={EMPTY_COMMANDS}
      />
    );
  }
  return <OpenCommandPaletteContent {...props} />;
};
