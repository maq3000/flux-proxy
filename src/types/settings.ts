import type { ThemePreference } from "../hooks/useTheme";
import type {
  CustomColorOverrides,
  ThemePresetId,
  ThemeTokenKey,
} from "../lib/themePresets";
import type {
  AutoResponderRule,
  BindHostMode,
  BreakpointConfig,
  ColumnId,
  FilterConditionRule,
  FilterPreset,
  HeaderMutationRule,
  HostListFilterConfig,
  HostRemapRule,
  InspectorDockPosition,
  InspectorSplitDirection,
  NoiseThresholdsConfig,
  SanitizationOptions,
  ThrottleConfig,
  ThrottlePreset,
  TlsBypassRule,
  TlsInterceptMode,
  ToolbarGroupId,
  UpstreamProxyConfig,
  UpstreamTimeoutConfig,
} from "./proxy";

export type { CustomColorOverrides, ThemePresetId, ThemeTokenKey };

export const CURRENT_SETTINGS_SCHEMA_VERSION = 1;
export const DEFAULT_SETTINGS_EXPORT_FILENAME = "fluxproxy-settings-v1.json";
export const SETTINGS_APPLIED_EVENT = "fluxproxy:settings-applied";
export const PROXY_STATUS_SYNCED_EVENT = "fluxproxy:proxy-status-synced";

export interface FluxUserUiSettings {
  theme: ThemePreference;
  themePreset?: ThemePresetId;
  customColorOverrides?: CustomColorOverrides;
  compactToolbar: boolean;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  inspectorPosition: InspectorDockPosition;
  inspectorSplitDirection: InspectorSplitDirection;
  followTail: boolean;
  columnWidths: Record<ColumnId, number>;
  visibleColumns: Record<ColumnId, boolean>;
  toolbarGroups: Record<ToolbarGroupId, boolean>;
  /** Persisted `react-resizable-panels` geometries keyed by `flux-*` autoSaveId */
  panelLayouts?: Record<string, string>;
  /** Optional alias accepted during profile import/migration; canonically stored in `proxy.clearDbOnExit` */
  clearDbOnExit?: boolean;
}

export interface FluxUserFilterSettings {
  activePresetId: string | null;
  userPresets: FilterPreset[];
  noiseThresholds: NoiseThresholdsConfig;
  hostFilters: HostListFilterConfig;
  /** Preserves active ad-hoc Filter Matrix toggle across profile exports/imports */
  matrixEnabled?: boolean;
  /** Preserves active Filter Matrix condition rows across profile exports/imports */
  filterRules?: FilterConditionRule[];
}

export interface FluxUserProxySettings {
  port: number;
  autoSystemProxy: boolean;
  allowRemote: boolean;
  bindMode?: BindHostMode;
  specificBindIp?: string | null;
  alsoBindLoopback?: boolean;
  tlsInterceptMode: TlsInterceptMode;
  tlsBypassRules: TlsBypassRule[];
  tlsTargetRules: TlsBypassRule[];
  headerMutations: HeaderMutationRule[];
  /** Optional master flags & capture buffer settings preserved on round-trip */
  tlsBypassEnabled?: boolean;
  headerMutationsEnabled?: boolean;
  stripAltSvc?: boolean;
  sessionRetentionLimit?: number | null;
  dropNonMatching?: boolean;
  /** Автоматически очищать и сжимать (VACUUM) SQLite-архив при выходе из приложения */
  clearDbOnExit?: boolean;
  /** Настройки санитизации и маскирования секретов/PII при экспорте сессий */
  sanitizationOptions?: SanitizationOptions;
  /** Optional breakpoints alias accepted during profile import/migration; canonically stored at top-level `breakpoints` */
  breakpoints?: BreakpointConfig;
  /** Virtual DNS (HOSTS Remapping) rules */
  hostRemapRules?: HostRemapRule[];
  /** Bandwidth Throttling profile & custom limits */
  throttleConfig?: ThrottleConfig;
  /** Upstream Proxy Chaining configuration (password is NEVER exported or stored in profiles) */
  upstreamProxy?: FluxUserUpstreamProxySettings;
  /** Split upstream timeout configuration (Connect / TTFB / Composer) */
  upstreamTimeouts?: UpstreamTimeoutConfig;
}

/** Security: Upstream proxy password is omitted by type and never exported in settings profiles. */
export type FluxUserUpstreamProxySettings = Omit<
  UpstreamProxyConfig,
  "password" | "hasPassword"
>;

export interface FluxUserAutoResponderSettings {
  enabled: boolean;
  rules: AutoResponderRule[];
}

export interface FluxUserScriptingSettings {
  enabled: boolean;
  code: string;
  activePresetId?: string | null;
}

export interface FluxUserSettingsProfile {
  schemaVersion: number;
  exportedAt: string;
  ui: FluxUserUiSettings;
  filters: FluxUserFilterSettings;
  proxy: FluxUserProxySettings;
  autoResponder: FluxUserAutoResponderSettings;
  breakpoints?: BreakpointConfig;
  scripting?: FluxUserScriptingSettings;
}

export type SettingsModalTab =
  | "general"
  | "uiColumns"
  | "filters"
  | "rulesProxy"
  | "backupExport";

export interface SettingsProfileValidationReport {
  profile: FluxUserSettingsProfile;
  warnings: string[];
  migratedFromVersion: number | null;
}

export interface ApplySettingsProfileOptions {
  trustImportedPythonScript?: boolean;
}

export interface SettingsImportPreviewSummary {
  fileName: string;
  schemaVersion: number;
  migratedFromVersion: number | null;
  exportedAt: string;
  userPresetsCount: number;
  currentUserPresetsCount: number;
  activePresetId: string | null;
  filterRulesCount: number;
  hostFilterTokensCount: number;
  tlsBypassRulesCount: number;
  tlsTargetRulesCount: number;
  headerMutationsCount: number;
  autoResponderRulesCount: number;
  hostRemapCount?: number;
  throttlePreset?: ThrottlePreset;
  upstreamProxySummary?: string | null;
  upstreamTimeoutsSummary?: string;
  autoResponderEnabled: boolean;
  totalRulesCount: number;
  currentTotalRulesCount: number;
  totalColumnsCount: number;
  visibleColumnsCount: number;
  customizedColumnWidthsCount: number;
  visibleToolbarGroupsCount: number;
  hiddenToolbarGroupsCount: number;
  compactToolbar: boolean;
  theme: ThemePreference;
  themePreset?: ThemePresetId;
  customColorOverridesCount?: number;
  inspectorPosition: InspectorDockPosition;
  inspectorSplitDirection: InspectorSplitDirection;
  proxyPort: number;
  tlsInterceptMode: TlsInterceptMode;
  hasPythonScript: boolean;
  pythonScriptEnabledInProfile: boolean;
  pythonScriptLineCount: number;
  warnings: string[];
}
