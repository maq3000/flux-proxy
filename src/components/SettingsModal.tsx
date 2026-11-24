import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Columns,
  Database,
  Download,
  FileJson,
  ListFilter,
  Network,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Stethoscope,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { ThemePreference } from "../hooks/useTheme";
import { TRAFFIC_COLUMNS } from "../hooks/useUiPreferences";
import { compileHostListFilter } from "../lib/filterEngine";
import { proxyBridge } from "../lib/tauriBridge";
import {
  THEME_PRESETS_BY_ID,
  type CustomColorOverrides,
  type ThemePresetId,
  type ThemeTokenKey,
} from "../lib/themePresets";
import {
  THROTTLE_PRESET_DEFINITIONS,
  type AutoResponderRule,
  type BindHostMode,
  type ColumnId,
  type DetectedProcessItem,
  type FilterConditionRule,
  type FilterPreset,
  type HostListFilterConfig,
  type InspectorDockPosition,
  type InspectorSplitDirection,
  type NetworkInterfaceInfo,
  type NoiseThresholdsConfig,
  type ProxyFilterBackendConfig,
  type ProxyStatus,
  type SessionSummary,
  type StorageStats,
  type ThrottleConfig,
  type ToolbarGroupId,
  type UpstreamProxyConfig,
  type UpstreamTimeoutConfig,
} from "../types/proxy";
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  type SettingsDiagnosticsSubTab,
  type SettingsFiltersSubTab,
  type SettingsImportPreviewSummary,
  type SettingsModalSubTab,
  type SettingsModalTab,
  type SettingsNetworkSubTab,
  type SettingsTlsSubTab,
} from "../types/settings";
import type { BindConfigSectionProps } from "./settings/BindConfigSection";
import { DiagnosticsBackupSettingsTab } from "./settings/DiagnosticsBackupSettingsTab";
import { FiltersSettingsTab } from "./settings/FiltersSettingsTab";
import { GeneralSettingsTab } from "./settings/GeneralSettingsTab";
import { NetworkRoutingSettingsTab } from "./settings/NetworkRoutingSettingsTab";
import { TlsCertificatesSettingsTab } from "./settings/TlsCertificatesSettingsTab";
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

interface SettingsSearchEntry {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  tab: SettingsModalTab;
  subTab?: SettingsModalSubTab;
  sectionId?: string;
}

const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  {
    id: "proxy-port",
    title: "Порт прокси-сервера и SysProxy",
    description: "TCP-порт слушателя (8888) и автопривязка системного прокси ОС",
    keywords: ["port", "порт", "8888", "sysproxy", "system proxy", "прокси"],
    tab: "general",
    sectionId: "general-proxy-section",
  },
  {
    id: "bind-interfaces",
    title: "Привязка к сетевым интерфейсам (Bind Host / Dual Listener)",
    description: "Loopback 127.0.0.1, All Interfaces 0.0.0.0, Specific Adapter (Wi-Fi/VPN/WSL)",
    keywords: ["bind", "interface", "интерфейс", "0.0.0.0", "127.0.0.1", "dual", "wifi", "wsl"],
    tab: "general",
    sectionId: "bind-config-section",
  },
  {
    id: "ring-buffer",
    title: "Follow Tail, Ring Buffer (Keep) и Drop Non-Matching",
    description: "Лимит сессий в ОЗУ (FIFO), автопрокрутка и отсев при захвате",
    keywords: ["tail", "ring", "buffer", "keep", "drop", "буфер", "озу", "память"],
    tab: "general",
    sectionId: "general-storage-section",
  },
  {
    id: "sqlite-archive",
    title: "Архив SQLite (VACUUM / Clear DB on Exit)",
    description: "Размер sessions.sqlite, сжатие базы и автоочистка при выходе",
    keywords: ["sqlite", "vacuum", "wal", "database", "архив", "очистка", "диск"],
    tab: "general",
    sectionId: "general-storage-section",
  },
  {
    id: "throttling",
    title: "Bandwidth Throttling & Latency",
    description: "Пресеты GPRS / Slow 3G / Fast 3G / LTE / Offline 503 и Custom Kbps/RTT",
    keywords: ["throttle", "throttling", "3g", "4g", "lte", "gprs", "offline", "rtt", "kbps", "скорость", "троттлинг"],
    tab: "networkRouting",
    subTab: "throttling",
    sectionId: "throttling-section",
  },
  {
    id: "hosts-remap",
    title: "Virtual DNS & HOSTS Remapping",
    description: "Перенаправление доменов на локальный IP/порт с сохранением TLS SNI",
    keywords: ["hosts", "dns", "remap", "sni", "preserve host", "перенаправление", "домен"],
    tab: "networkRouting",
    subTab: "hostsRemap",
    sectionId: "hosts-remap-section",
  },
  {
    id: "upstream-proxy",
    title: "Upstream Proxy Chaining (HTTP / HTTPS / SOCKS5)",
    description: "Каскадирование трафика через внешний прокси, аутентификация и Bypass List",
    keywords: ["upstream", "socks5", "chain", "bypass", "rfc1918", "каскад", "корпоративный"],
    tab: "networkRouting",
    subTab: "upstreamProxy",
    sectionId: "upstream-proxy-section",
  },
  {
    id: "upstream-timeouts",
    title: "Upstream Timeouts (Connect / TTFB / Composer)",
    description: "Раздельные таймауты DNS/TCP/TLS, ожидания ответа (Unlimited) и Composer",
    keywords: ["timeout", "ttfb", "connect", "composer", "504", "499", "таймаут", "unlimited"],
    tab: "networkRouting",
    subTab: "timeouts",
    sectionId: "upstream-timeouts-section",
  },
  {
    id: "root-ca",
    title: "HTTPS MITM Root CA Certificate",
    description: "Статус доверия ОС, отпечаток SHA-256 и управление корневым сертификатом",
    keywords: ["root ca", "ca", "certificate", "trust", "sha-256", "сертификат", "доверие"],
    tab: "tlsCertificates",
    subTab: "mitmBypass",
    sectionId: "root-ca-status-card",
  },
  {
    id: "tls-bypass",
    title: "Selective TLS MITM & Bypass 2.0 (11 Quick-Packs, Bulk Editor)",
    description: "Intercept All vs Targeted Only, удаление Alt-Svc (HTTP/3/QUIC), счётчики попаданий",
    keywords: ["tls", "mitm", "bypass", "targeted", "allowlist", "quic", "alt-svc", "http3", "pinning"],
    tab: "tlsCertificates",
    subTab: "mitmBypass",
    sectionId: "tls-bypass-section",
  },
  {
    id: "client-certs",
    title: "Client Certificates (mTLS — PKCS#12 / PEM / DPAPI / In-Memory)",
    description: "Хранилище клиентских сертификатов с защитой DPAPI и режимом RAM ONLY",
    keywords: ["mtls", "client cert", "p12", "pfx", "pem", "dpapi", "ephemeral", "ram only"],
    tab: "tlsCertificates",
    subTab: "clientCerts",
    sectionId: "client-certs-section",
  },
  {
    id: "mobile-setup",
    title: "Mobile Device Setup (iOS & Android Wi-Fi Proxy, QR, LAN Allowlist)",
    description: "QR-коды, портал http://flux.proxy, .mobileconfig, network_security_config.xml",
    keywords: ["mobile", "ios", "android", "qr", "wifi", "allowlist", "flux.proxy", "смартфон", "телефон"],
    tab: "tlsCertificates",
    subTab: "mobileSetup",
    sectionId: "mobile-setup-section",
  },
  {
    id: "filter-matrix",
    title: "Filter Matrix & Filter Presets",
    description: "Табличные правила Include / Exclude, процессы (PID) и пресеты фильтров",
    keywords: ["filter", "matrix", "preset", "include", "exclude", "pid", "фильтры", "матрица"],
    tab: "filters",
    subTab: "matrix",
    sectionId: "filters-subtab-content",
  },
  {
    id: "hosts-list",
    title: "Hosts List (Bulk Whitelist / Blacklist)",
    description: "Массовая фильтрация доменов, масок * и regex: по списку",
    keywords: ["hosts list", "whitelist", "blacklist", "regex", "домены", "список хостов"],
    tab: "filters",
    subTab: "hostsList",
    sectionId: "filters-subtab-content",
  },
  {
    id: "noise-thresholds",
    title: "Noise & Thresholds (304, OPTIONS, Static, Time Heat)",
    description: "Скрытие шума, фильтры по размеру тела и пороги подсветки медленных запросов",
    keywords: ["noise", "threshold", "304", "options", "static", "time heat", "warning", "critical", "шум"],
    tab: "filters",
    subTab: "thresholds",
    sectionId: "filters-subtab-content",
  },
  {
    id: "header-mutations",
    title: "Header Mutations & Force No-Cache",
    description: "Правила модификации HTTP-заголовков, подмена User-Agent и отключение кэша",
    keywords: ["header", "mutation", "user-agent", "no-cache", "etag", "заголовки", "мутации"],
    tab: "filters",
    subTab: "headers",
    sectionId: "filters-subtab-content",
  },
  {
    id: "themes-palette",
    title: "Theme Presets & Custom Palette Editor",
    description: "8 тем (Dracula, Tokyo Night, Nord, Fiddler Classic, GitHub Dark, Monokai), Dark/Light/System",
    keywords: ["theme", "preset", "palette", "color", "dracula", "tokyo", "nord", "fiddler", "тема", "палитра", "цвета"],
    tab: "uiColumns",
    sectionId: "ui-theme-gallery-section",
  },
  {
    id: "layout-panels",
    title: "Workspace Layout & Inspector Split",
    description: "Compact Toolbar, позиция Session Inspector (Bottom/Right) и направление сплита",
    keywords: ["layout", "compact", "sidebar", "inspector", "split", "компоновка", "панели"],
    tab: "uiColumns",
    sectionId: "ui-layout-section",
  },
  {
    id: "toolbar-columns",
    title: "Toolbar Groups & TrafficGrid Columns",
    description: "Видимость групп тулбара и настройка колонок таблицы (TTFB, Server IP и ширина)",
    keywords: ["toolbar", "columns", "ttfb", "server ip", "width", "колонки", "тулбар"],
    tab: "uiColumns",
    sectionId: "ui-columns-section",
  },
  {
    id: "proxy-doctor",
    title: "Proxy Doctor (Самодиагностика среды)",
    description: "6 проверок (порт, Root CA, SysProxy, VPN/TUN, Firewall, loopback) и Fix All",
    keywords: ["doctor", "health", "firewall", "vpn", "diag", "диагностика", "проверка", "исправить"],
    tab: "diagnosticsBackup",
    subTab: "proxyDoctor",
    sectionId: "proxy-doctor-section",
  },
  {
    id: "settings-profile",
    title: "Settings Profile (JSON v1) & Reset to Defaults",
    description: "Экспорт, импорт с превью, копирование JSON и сброс настроек к заводским",
    keywords: ["backup", "export", "import", "json", "profile", "reset", "профиль", "сброс"],
    tab: "diagnosticsBackup",
    subTab: "profileBackup",
    sectionId: "settings-profile-section",
  },
];

export interface SettingsModalProps {
  open: boolean;
  initialTab?: SettingsModalTab;
  initialSubTab?: SettingsModalSubTab;
  navigationSeq?: number;
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
  sessions: SessionSummary[];
  totalCount: number;
  filteredCount: number;
  activePresetId: string | null;
  userPresets: FilterPreset[];
  allPresets: FilterPreset[];
  onApplyPreset: (presetId: string) => void;
  onSaveCustomPreset: (name: string, description?: string) => void;
  onDeleteCustomPreset: (presetId: string) => void;
  matrixEnabled: boolean;
  onSetMatrixEnabled: (enabled: boolean) => void;
  filterRules: FilterConditionRule[];
  onSetFilterRules: (
    updater:
      | FilterConditionRule[]
      | ((prev: FilterConditionRule[]) => FilterConditionRule[])
  ) => void;
  ruleErrors: Record<string, string>;
  detectedProcesses: DetectedProcessItem[];
  onQuickProcessFilter: (
    processName: string,
    action: "include" | "exclude"
  ) => void;
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
  isForceNoCacheActive: boolean;
  onToggleForceNoCache: () => Promise<void>;
  // Proxy, Network, Routing, TLS, Certificates & Storage
  status: ProxyStatus;
  onToggleProxy: () => Promise<void>;
  onSetProxyPort: (port: number) => Promise<void>;
  onSetAutoSystemProxy: (auto: boolean) => Promise<void>;
  onSetAllowRemote: (allow: boolean) => Promise<void>;
  onSetBindConfiguration: (
    bindMode: BindHostMode,
    specificBindIp?: string | null,
    alsoBindLoopback?: boolean
  ) => Promise<void>;
  throttleConfig: ThrottleConfig;
  onChangeThrottleConfig: (cfg: ThrottleConfig) => Promise<void>;
  activeHostRemapCount: number;
  upstreamProxyConfig: UpstreamProxyConfig;
  onSaveUpstreamProxyConfig: (next: UpstreamProxyConfig) => Promise<void>;
  upstreamTimeouts: UpstreamTimeoutConfig;
  onSetUpstreamTimeouts: (config: UpstreamTimeoutConfig) => Promise<void>;
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
  onUpdateLanClientAllowlist: (next: string[]) => Promise<void>;
  onOpenCertificateModal: () => void;
  caRefreshKey?: number;
  activeClientCertsCount: number;
  onClientCertsCountChange: (count: number) => void;
  // AutoResponder summary for profile backup tab
  autoResponderEnabled: boolean;
  autoResponderRules: AutoResponderRule[];
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
    subtitle: "Порт, интерфейсы, буфер",
    icon: Settings,
  },
  {
    id: "networkRouting",
    label: "Network & Routing",
    subtitle: "Throttling, HOSTS, Upstream",
    icon: Network,
  },
  {
    id: "tlsCertificates",
    label: "TLS & Mobile",
    subtitle: "MITM, Root CA, mTLS, QR",
    icon: ShieldCheck,
  },
  {
    id: "filters",
    label: "Filters",
    subtitle: "Matrix, Hosts, Thresholds",
    icon: ListFilter,
  },
  {
    id: "uiColumns",
    label: "Appearance & Layout",
    subtitle: "Темы, тулбар, колонки",
    icon: Columns,
  },
  {
    id: "diagnosticsBackup",
    label: "Diagnostics & Backup",
    subtitle: "Proxy Doctor и JSON v1",
    icon: Stethoscope,
  },
];

function isNetworkSubTab(val: unknown): val is SettingsNetworkSubTab {
  return (
    val === "throttling" ||
    val === "hostsRemap" ||
    val === "upstreamProxy" ||
    val === "timeouts"
  );
}

function isTlsSubTab(val: unknown): val is SettingsTlsSubTab {
  return (
    val === "mitmBypass" || val === "clientCerts" || val === "mobileSetup"
  );
}

function isFiltersSubTab(val: unknown): val is SettingsFiltersSubTab {
  return (
    val === "matrix" ||
    val === "hostsList" ||
    val === "thresholds" ||
    val === "headers"
  );
}

function isDiagnosticsSubTab(val: unknown): val is SettingsDiagnosticsSubTab {
  return val === "proxyDoctor" || val === "profileBackup";
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  initialTab = "general",
  initialSubTab,
  navigationSeq = 0,
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
  sessions,
  totalCount,
  filteredCount,
  activePresetId,
  userPresets,
  allPresets,
  onApplyPreset,
  onSaveCustomPreset,
  onDeleteCustomPreset,
  matrixEnabled,
  onSetMatrixEnabled,
  filterRules,
  onSetFilterRules,
  ruleErrors,
  detectedProcesses,
  onQuickProcessFilter,
  noiseThresholds,
  onSetNoiseThresholds,
  hostFilters,
  onSetHostFilters,
  onResetAdvancedFilters,
  isForceNoCacheActive,
  onToggleForceNoCache,
  status,
  onToggleProxy,
  onSetProxyPort,
  onSetAutoSystemProxy,
  onSetAllowRemote,
  onSetBindConfiguration,
  throttleConfig,
  onChangeThrottleConfig,
  activeHostRemapCount,
  upstreamProxyConfig,
  onSaveUpstreamProxyConfig,
  upstreamTimeouts,
  onSetUpstreamTimeouts,
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
  onUpdateLanClientAllowlist,
  onOpenCertificateModal,
  caRefreshKey = 0,
  activeClientCertsCount,
  onClientCertsCountChange,
  autoResponderEnabled,
  autoResponderRules,
  onExportProfile,
  onImportProfileDialog,
  onImportFromRawJsonText,
  onResetAllToDefaults,
  onNotify,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resetConfirmDialogRef = useRef<HTMLDialogElement>(null);
  const purgeConfirmDialogRef = useRef<HTMLDialogElement>(null);
  const flushPendingBulkRef = useRef<(() => void) | null>(null);
  const panelScrollRef = useRef<HTMLDivElement>(null);

  const tabButtonRefs = useRef<Record<SettingsModalTab, HTMLButtonElement | null>>(
    {
      general: null,
      networkRouting: null,
      tlsCertificates: null,
      filters: null,
      uiColumns: null,
      diagnosticsBackup: null,
    }
  );

  const baseId = useId();
  const titleId = `${baseId}-title`;
  const searchInputId = `${baseId}-search`;
  const resetTitleId = `${baseId}-reset-title`;
  const purgeTitleId = `${baseId}-purge-title`;

  const [activeTab, setActiveTab] = useState<SettingsModalTab>(initialTab);
  const [networkSubTab, setNetworkSubTab] = useState<SettingsNetworkSubTab>(
    isNetworkSubTab(initialSubTab) ? initialSubTab : "throttling"
  );
  const [tlsSubTab, setTlsSubTab] = useState<SettingsTlsSubTab>(
    isTlsSubTab(initialSubTab) ? initialSubTab : "mitmBypass"
  );
  const [filtersSubTab, setFiltersSubTab] = useState<SettingsFiltersSubTab>(
    isFiltersSubTab(initialSubTab) ? initialSubTab : "matrix"
  );
  const [diagnosticsSubTab, setDiagnosticsSubTab] =
    useState<SettingsDiagnosticsSubTab>(
      isDiagnosticsSubTab(initialSubTab) ? initialSubTab : "proxyDoctor"
    );
  const [searchQuery, setSearchQuery] = useState("");

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
      if (initialTab === "networkRouting" && isNetworkSubTab(initialSubTab)) {
        setNetworkSubTab(initialSubTab);
      } else if (
        initialTab === "tlsCertificates" &&
        isTlsSubTab(initialSubTab)
      ) {
        setTlsSubTab(initialSubTab);
      } else if (initialTab === "filters" && isFiltersSubTab(initialSubTab)) {
        setFiltersSubTab(initialSubTab);
      } else if (
        initialTab === "diagnosticsBackup" &&
        isDiagnosticsSubTab(initialSubTab)
      ) {
        setDiagnosticsSubTab(initialSubTab);
      }
      setBindError(null);
      setPendingSpecificSelect(false);
      void loadNetworkInterfaces();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTab, initialSubTab, navigationSeq]);

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

  const navigateToTab = (
    tab: SettingsModalTab,
    subTab?: SettingsModalSubTab,
    sectionId?: string
  ) => {
    if (activeTab === "tlsCertificates" && tab !== "tlsCertificates") {
      flushPendingBulkRef.current?.();
    }
    setActiveTab(tab);
    if (tab === "networkRouting" && isNetworkSubTab(subTab)) {
      setNetworkSubTab(subTab);
    } else if (tab === "tlsCertificates" && isTlsSubTab(subTab)) {
      setTlsSubTab(subTab);
    } else if (tab === "filters" && isFiltersSubTab(subTab)) {
      setFiltersSubTab(subTab);
    } else if (tab === "diagnosticsBackup" && isDiagnosticsSubTab(subTab)) {
      setDiagnosticsSubTab(subTab);
    }
    if (sectionId) {
      window.requestAnimationFrame(() => {
        document
          .getElementById(sectionId)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } else {
      panelScrollRef.current?.scrollTo({ top: 0 });
    }
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
    navigateToTab(targetTab.id);
    tabButtonRefs.current[targetTab.id]?.focus();
  };

  const handleConfirmReset = async () => {
    setConfirmResetOpen(false);
    await onResetAllToDefaults();
  };

  const searchResults = useMemo(() => {
    const trimmed = searchQuery.trim().toLowerCase();
    if (!trimmed) return [];
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    return SETTINGS_SEARCH_INDEX.filter((entry) => {
      const haystack = `${entry.title} ${entry.description} ${entry.keywords.join(" ")}`.toLowerCase();
      return tokens.every((tok) => haystack.includes(tok));
    });
  }, [searchQuery]);

  const searchMatchesByTab = useMemo(() => {
    const counts: Partial<Record<SettingsModalTab, number>> = {};
    for (const r of searchResults) {
      counts[r.tab] = (counts[r.tab] ?? 0) + 1;
    }
    return counts;
  }, [searchResults]);

  const tabStatusBadges = useMemo(() => {
    const activeThrottleDef =
      THROTTLE_PRESET_DEFINITIONS.find((d) => d.id === throttleConfig.preset) ??
      THROTTLE_PRESET_DEFINITIONS[0];
    const networkCount =
      activeHostRemapCount +
      (upstreamProxyConfig.enabled ? 1 : 0) +
      (throttleConfig.preset !== "none" ? 1 : 0);

    const tlsRuleCount =
      backendFilterConfig.tlsInterceptMode === "targetedOnly"
        ? (backendFilterConfig.tlsTargetRules ?? []).filter((r) => r.enabled)
            .length
        : backendFilterConfig.tlsBypassEnabled
          ? backendFilterConfig.tlsBypassRules.filter((r) => r.enabled).length
          : 0;

    let filterActiveCount = 0;
    if (matrixEnabled) {
      filterActiveCount += filterRules.filter(
        (r) => r.enabled && r.value.trim()
      ).length;
    }
    if (hostFilters.enabled) {
      filterActiveCount += compiledHosts.activeCount;
    }
    if (noiseThresholds.hide304NotModified) filterActiveCount++;
    if (noiseThresholds.hideOptionsPreflight) filterActiveCount++;
    if (noiseThresholds.hideConnectTunnels) filterActiveCount++;
    if (noiseThresholds.hideStaticAssets) filterActiveCount++;
    if (noiseThresholds.onlySlowRequests) filterActiveCount++;
    if (backendFilterConfig.headerMutationsEnabled) {
      filterActiveCount += backendFilterConfig.headerMutations.filter(
        (m) => m.enabled
      ).length;
    }

    const visibleColsCount = TRAFFIC_COLUMNS.filter(
      (c) => visibleColumns[c.id]
    ).length;

    const activePresetName = themePresetProp
      ? THEME_PRESETS_BY_ID[themePresetProp]?.name
      : undefined;

    return {
      general: `:${status.port}`,
      networkRouting:
        throttleConfig.preset !== "none"
          ? activeThrottleDef.shortLabel
          : networkCount > 0
            ? String(networkCount)
            : undefined,
      tlsCertificates:
        activeClientCertsCount > 0
          ? `${tlsRuleCount} · mTLS ${activeClientCertsCount}`
          : String(tlsRuleCount),
      filters: filterActiveCount > 0 ? String(filterActiveCount) : undefined,
      uiColumns:
        activePresetName ?? `${visibleColsCount}/${TRAFFIC_COLUMNS.length}`,
      diagnosticsBackup: `v${CURRENT_SETTINGS_SCHEMA_VERSION}`,
    } satisfies Record<SettingsModalTab, string | undefined>;
  }, [
    status.port,
    throttleConfig.preset,
    activeHostRemapCount,
    upstreamProxyConfig.enabled,
    backendFilterConfig,
    activeClientCertsCount,
    matrixEnabled,
    filterRules,
    hostFilters.enabled,
    compiledHosts.activeCount,
    noiseThresholds,
    visibleColumns,
    themePresetProp,
  ]);

  return (
    <>
      <dialog
        ref={dialogRef}
        data-settings-hub-dialog="true"
        aria-labelledby={titleId}
        onClose={(e) => {
          if (e.target !== dialogRef.current) return;
          flushPendingBulkRef.current?.();
          if (dialogRef.current) dialogRef.current.returnValue = "";
          onClose();
        }}
        {...({ closedby: "any" } as Record<string, string>)}
        className="fixed inset-0 m-0 h-screen w-screen max-h-none max-w-none rounded-none border-0 bg-surface p-0 text-fg open:flex open:flex-col"
      >
        {/* Fullscreen Hub Header with Search */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-hairline bg-surface px-5 py-3">
          <div className="flex items-center gap-2.5">
            <Settings className="h-4 w-4 text-accent" aria-hidden="true" />
            <div>
              <h1 id={titleId} className="text-sm font-semibold text-fg">
                Settings Hub
              </h1>
              <p className="text-[11px] text-muted">
                Единый центр настроек прокси, маршрутизации, TLS/mTLS, фильтров,
                темы и диагностики{" "}
                <code className="rounded bg-elevated px-1 py-0.5 font-mono text-[10px]">
                  schemaVersion: {CURRENT_SETTINGS_SCHEMA_VERSION}
                </code>
              </p>
            </div>
          </div>

          <div className="flex flex-1 items-center justify-end gap-3">
            {/* Settings Search */}
            <div className="relative w-full max-w-md">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle"
              />
              <input
                id={searchInputId}
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && searchQuery) {
                    e.preventDefault();
                    e.stopPropagation();
                    setSearchQuery("");
                  }
                }}
                placeholder="Поиск по настройкам (port, throttling, hosts, mtls, theme, doctor…)"
                aria-label="Поиск по настройкам"
                className="h-8 w-full rounded-md border border-strong bg-canvas pl-8 pr-7 text-xs text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="Очистить поиск по настройкам"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-subtle hover:bg-hover hover:text-fg"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="Закрыть центр настроек"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-muted hover:border-strong hover:bg-hover hover:text-fg"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Body: Left Tablist + Right Fullscreen Workspace */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div
            role="tablist"
            aria-label="Разделы настроек FluxProxy"
            aria-orientation="vertical"
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-hairline bg-canvas p-2.5 md:w-64 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r"
          >
            {TAB_DEFINITIONS.map((tab, idx) => {
              const Icon = tab.icon;
              const selected = activeTab === tab.id;
              const tabId = `${baseId}-tab-${tab.id}`;
              const panelId = `${baseId}-panel-${tab.id}`;
              const matchCount = searchMatchesByTab[tab.id];
              const statusBadge = tabStatusBadges[tab.id];

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
                  onClick={() => navigateToTab(tab.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, idx)}
                  className={`flex shrink-0 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected
                      ? "border-accent/45 bg-selected text-fg"
                      : "border-transparent text-muted hover:bg-hover hover:text-fg"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
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
                  </div>
                  {matchCount ? (
                    <span className="shrink-0 rounded-full bg-accent/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-accent tabular-nums">
                      {matchCount}
                    </span>
                  ) : statusBadge ? (
                    <span className="hidden shrink-0 rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-muted md:inline">
                      {statusBadge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div
            ref={panelScrollRef}
            id={`${baseId}-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-${activeTab}`}
            tabIndex={0}
            className="min-h-0 flex-1 overflow-y-auto p-5 text-xs focus:outline-none"
          >
            <div className="mx-auto max-w-6xl space-y-4">
              {/* Settings Search Results */}
              {searchQuery.trim() && (
                <section
                  aria-label="Результаты поиска по настройкам"
                  className="space-y-2 rounded-lg border border-accent/40 bg-canvas p-3.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-fg">
                      Результаты поиска ({searchResults.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => setSearchQuery("")}
                      className="text-[11px] text-accent hover:underline"
                    >
                      Скрыть результаты
                    </button>
                  </div>
                  {searchResults.length === 0 ? (
                    <p className="text-[11px] text-muted">
                      По запросу «{searchQuery.trim()}» настройки не найдены.
                      Попробуйте другие ключевые слова (например: port,
                      throttling, hosts, mtls, theme, doctor).
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {searchResults.map((item) => {
                        const tabLabel =
                          TAB_DEFINITIONS.find((t) => t.id === item.tab)
                            ?.label ?? item.tab;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                              setSearchQuery("");
                              navigateToTab(
                                item.tab,
                                item.subTab,
                                item.sectionId
                              );
                            }}
                            className="flex flex-col items-start gap-1 rounded-md border border-hairline bg-surface p-2.5 text-left transition-colors hover:border-accent/60 hover:bg-hover"
                          >
                            <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-accent">
                              {tabLabel}
                            </span>
                            <span className="font-semibold text-fg">
                              {item.title}
                            </span>
                            <span className="text-[11px] leading-snug text-muted">
                              {item.description}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}

              {/* TAB 1: GENERAL */}
              {activeTab === "general" && (
                <GeneralSettingsTab
                  baseId={baseId}
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

              {/* TAB 2: NETWORK & ROUTING */}
              {activeTab === "networkRouting" && (
                <NetworkRoutingSettingsTab
                  baseId={baseId}
                  activeSubTab={networkSubTab}
                  onSubTabChange={setNetworkSubTab}
                  status={status}
                  throttleConfig={throttleConfig}
                  onChangeThrottleConfig={onChangeThrottleConfig}
                  activeHostRemapCount={activeHostRemapCount}
                  upstreamProxyConfig={upstreamProxyConfig}
                  onSaveUpstreamProxyConfig={onSaveUpstreamProxyConfig}
                  upstreamTimeouts={upstreamTimeouts}
                  onSetUpstreamTimeouts={onSetUpstreamTimeouts}
                  onNotify={onNotify}
                />
              )}

              {/* TAB 3: TLS, CERTIFICATES & MOBILE */}
              {activeTab === "tlsCertificates" && (
                <TlsCertificatesSettingsTab
                  isActive={open && activeTab === "tlsCertificates"}
                  activeSubTab={tlsSubTab}
                  onSubTabChange={setTlsSubTab}
                  sessions={sessions}
                  thresholds={noiseThresholds}
                  onThresholdsChange={onSetNoiseThresholds}
                  backendFilterConfig={backendFilterConfig}
                  onUpdateBackendFilterConfig={onUpdateBackendFilterConfig}
                  flushPendingBulkRef={flushPendingBulkRef}
                  onOpenCertificateModal={onOpenCertificateModal}
                  caRefreshKey={caRefreshKey}
                  activeClientCertsCount={activeClientCertsCount}
                  onClientCertsCountChange={onClientCertsCountChange}
                  status={status}
                  lanClientAllowlist={
                    backendFilterConfig.lanClientAllowlist ?? []
                  }
                  onUpdateLanClientAllowlist={onUpdateLanClientAllowlist}
                  onSetAllowRemote={onSetAllowRemote}
                  onToggleProxy={onToggleProxy}
                  onNotify={onNotify}
                />
              )}

              {/* TAB 4: FILTERS */}
              {activeTab === "filters" && (
                <FiltersSettingsTab
                  activeSubTab={filtersSubTab}
                  onSubTabChange={setFiltersSubTab}
                  totalCount={totalCount}
                  filteredCount={filteredCount}
                  sessions={sessions}
                  matrixEnabled={matrixEnabled}
                  onSetMatrixEnabled={onSetMatrixEnabled}
                  filterRules={filterRules}
                  onSetFilterRules={onSetFilterRules}
                  ruleErrors={ruleErrors}
                  allPresets={allPresets}
                  activePresetId={activePresetId}
                  onApplyPreset={onApplyPreset}
                  onSaveCustomPreset={onSaveCustomPreset}
                  onDeleteCustomPreset={onDeleteCustomPreset}
                  detectedProcesses={detectedProcesses}
                  onQuickProcessFilter={onQuickProcessFilter}
                  hostFilters={hostFilters}
                  compiledHosts={compiledHosts}
                  onSetHostFilters={onSetHostFilters}
                  noiseThresholds={noiseThresholds}
                  onSetNoiseThresholds={onSetNoiseThresholds}
                  backendFilterConfig={backendFilterConfig}
                  onUpdateBackendFilterConfig={onUpdateBackendFilterConfig}
                  isForceNoCacheActive={isForceNoCacheActive}
                  onToggleForceNoCache={onToggleForceNoCache}
                  onResetAdvancedFilters={onResetAdvancedFilters}
                  onNotify={onNotify}
                />
              )}

              {/* TAB 5: APPEARANCE & LAYOUT */}
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

              {/* TAB 6: DIAGNOSTICS & BACKUP */}
              {activeTab === "diagnosticsBackup" && (
                <DiagnosticsBackupSettingsTab
                  baseId={baseId}
                  activeSubTab={diagnosticsSubTab}
                  onSubTabChange={setDiagnosticsSubTab}
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
        </div>

        {/* Footer */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-hairline bg-canvas px-5 py-2.5">
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
            Все сохранённые на диске сессии и выгруженные тела запросов/ответов
            в{" "}
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
            ({storageStats.sqliteSizeBytes.toLocaleString("en-US")} байт). Сессии
            в текущей таблице ОЗУ (
            {storageStats.ramSessions.toLocaleString("en-US")} шт.) затронуты не
            будут.
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
              {isPurgingSqlite
                ? "Очистка и VACUUM..."
                : "Очистить и сжать (VACUUM)"}
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
            Вы действительно хотите сбросить все настройки FluxProxy к значениям
            по умолчанию?
          </p>
          <p>
            Пользовательские пресеты фильтров ({userPresets.length}),
            настроенные ширины колонок, конфигурация групп тулбара, правила
            TLS/заголовков, AutoResponder ({autoResponderRules.length}), HOSTS
            Remapping, Bandwidth Throttling и Upstream Proxy будут перезаписаны
            заводским профилем.
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
              Проверьте сводку перед применением: следующие пресеты, правила
              фильтрации/перехвата и параметры колонок будут перезаписаны:
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
                  Перезапишет текущие ({preview.currentUserPresetsCount}) •
                  Активный:{" "}
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
                  Видимых: {preview.visibleColumnsCount}/
                  {preview.totalColumnsCount} • Кастом. ширин:{" "}
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
                    {preview.tlsBypassRulesCount} /{" "}
                    {preview.tlsTargetRulesCount} ({preview.tlsInterceptMode})
                  </span>
                </div>
                <div>
                  • Header Mutations:{" "}
                  <span className="font-mono text-fg">
                    {preview.headerMutationsCount} правил
                  </span>
                </div>
                <div>
                  • HOSTS Remapping / Throttling:{" "}
                  <span className="font-mono text-fg">
                    {preview.hostRemapCount ?? 0} правил /{" "}
                    {preview.throttlePreset ?? "none"}
                  </span>
                </div>
                <div>
                  • Upstream Proxy:{" "}
                  <span className="font-mono text-fg">
                    {preview.upstreamProxySummary ??
                      "Выкл (пароль не хранится в профиле)"}
                  </span>
                </div>
                {preview.upstreamTimeoutsSummary && (
                  <div>
                    • Upstream Timeouts:{" "}
                    <span className="font-mono text-fg">
                      {preview.upstreamTimeoutsSummary}
                    </span>
                  </div>
                )}
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
