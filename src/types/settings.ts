import type { ThemePreference } from "../hooks/useTheme";
import type {
  AutoResponderRule,
  ColumnId,
  FilterConditionRule,
  FilterPreset,
  HeaderMutationRule,
  HostListFilterConfig,
  InspectorDockPosition,
  NoiseThresholdsConfig,
  TlsBypassRule,
  TlsInterceptMode,
  ToolbarGroupId,
} from "./proxy";

export const CURRENT_SETTINGS_SCHEMA_VERSION = 1;
export const DEFAULT_SETTINGS_EXPORT_FILENAME = "fluxproxy-settings-v1.json";
export const SETTINGS_APPLIED_EVENT = "fluxproxy:settings-applied";
export const PROXY_STATUS_SYNCED_EVENT = "fluxproxy:proxy-status-synced";

export interface FluxUserUiSettings {
  theme: ThemePreference;
  compactToolbar: boolean;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  inspectorPosition: InspectorDockPosition;
  followTail: boolean;
  columnWidths: Record<ColumnId, number>;
  visibleColumns: Record<ColumnId, boolean>;
  toolbarGroups: Record<ToolbarGroupId, boolean>;
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
}

export interface FluxUserAutoResponderSettings {
  enabled: boolean;
  rules: AutoResponderRule[];
}

export interface FluxUserSettingsProfile {
  schemaVersion: number;
  exportedAt: string;
  ui: FluxUserUiSettings;
  filters: FluxUserFilterSettings;
  proxy: FluxUserProxySettings;
  autoResponder: FluxUserAutoResponderSettings;
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
  inspectorPosition: InspectorDockPosition;
  proxyPort: number;
  tlsInterceptMode: TlsInterceptMode;
  warnings: string[];
}
