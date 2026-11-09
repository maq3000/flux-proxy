import {
  COLUMN_MIN_WIDTHS,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_LAYOUT_PREFS,
  DEFAULT_TOOLBAR_GROUPS,
  DEFAULT_VISIBLE_COLUMNS,
  TOOLBAR_GROUP_DEFINITIONS,
  TRAFFIC_COLUMNS,
} from "../hooks/useUiPreferences";
import type { ThemePreference } from "../hooks/useTheme";
import {
  BUILT_IN_FILTER_PRESETS,
  compileHostListFilter,
  DEFAULT_BACKEND_FILTER_CONFIG,
  DEFAULT_HOST_LIST_FILTER_CONFIG,
  DEFAULT_NOISE_THRESHOLDS,
} from "./filterEngine";
import { DEFAULT_AUTORESPONDER_RULES } from "./mockTraffic";
import { proxyBridge } from "./tauriBridge";
import { DEFAULT_SESSION_RETENTION_LIMIT } from "../types/proxy";
import type {
  AutoResponderRule,
  ColumnId,
  FilterConditionRule,
  FilterField,
  FilterLogicalOp,
  FilterOperator,
  FilterPreset,
  FilterRuleAction,
  HeaderMutationDirection,
  HeaderMutationOp,
  HeaderMutationRule,
  HeaderPair,
  HostListFilterConfig,
  HostListFilterMode,
  InspectorDockPosition,
  NoiseThresholdsConfig,
  ProxyFilterBackendConfig,
  ProxyStatus,
  RuleActionType,
  RuleMatchTarget,
  TlsBypassRule,
  TlsInterceptMode,
  ToolbarGroupId,
} from "../types/proxy";
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  DEFAULT_SETTINGS_EXPORT_FILENAME,
  PROXY_STATUS_SYNCED_EVENT,
  SETTINGS_APPLIED_EVENT,
  type FluxUserSettingsProfile,
  type SettingsImportPreviewSummary,
  type SettingsProfileValidationReport,
} from "../types/settings";

export { PROXY_STATUS_SYNCED_EVENT, SETTINGS_APPLIED_EVENT };

export const SETTINGS_STORAGE_KEYS = {
  theme: "fluxproxy-color-scheme",
  uiLayout: "fluxproxy.uiLayout.v1",
  toolbarGroups: "fluxproxy.toolbarGroups.v1",
  visibleColumns: "fluxproxy.visibleColumns.v1",
  columnWidths: "fluxproxy.columnWidths.v1",
  followTail: "fluxproxy.followTail.v1",
  customPresets: "fluxproxy.customFilterPresets.v1",
  activeFilterState: "fluxproxy.activeFilterState.v1",
  backendFilterConfig: "fluxproxy.backendFilterConfig.v1",
  autoSystemProxy: "fluxproxy.autoSystemProxy.v1",
  allowRemote: "fluxproxy.allowRemote.v1",
  proxyPort: "fluxproxy.proxyPort.v1",
  autoResponder: "fluxproxy.autoResponder.v1",
  sessionRetentionLimit: "fluxproxy.sessionRetentionLimit.v1",
  dropNonMatching: "fluxproxy.dropNonMatching.v1",
} as const;

const VALID_THEMES = new Set<ThemePreference>(["dark", "light", "system"]);
const VALID_DOCK_POSITIONS = new Set<InspectorDockPosition>(["bottom", "right"]);
const VALID_TLS_MODES = new Set<TlsInterceptMode>([
  "interceptAll",
  "targetedOnly",
]);
const VALID_HOST_FILTER_MODES = new Set<HostListFilterMode>([
  "whitelist",
  "blacklist",
]);
const VALID_FILTER_ACTIONS = new Set<FilterRuleAction>(["include", "exclude"]);
const VALID_LOGICAL_OPS = new Set<FilterLogicalOp>(["AND", "OR"]);
const VALID_FILTER_FIELDS = new Set<FilterField>([
  "url",
  "host",
  "path",
  "method",
  "status",
  "contentType",
  "processName",
  "processPid",
  "clientIp",
  "protocol",
  "bodySize",
  "durationMs",
  "comment",
]);
const VALID_FILTER_OPERATORS = new Set<FilterOperator>([
  "contains",
  "notContains",
  "equals",
  "notEquals",
  "startsWith",
  "endsWith",
  "regex",
  "gt",
  "gte",
  "lt",
  "lte",
]);
const VALID_HEADER_DIRECTIONS = new Set<HeaderMutationDirection>([
  "request",
  "response",
]);
const VALID_HEADER_OPS = new Set<HeaderMutationOp>(["set", "remove", "append"]);
const VALID_RULE_TARGETS = new Set<RuleMatchTarget>([
  "urlContains",
  "urlRegex",
  "headerMatch",
]);
const VALID_RULE_ACTIONS = new Set<RuleActionType>([
  "mockResponse",
  "overrideStatus",
  "delayOnly",
]);

const RECOGNIZED_PROFILE_TOP_KEYS = new Set<string>([
  "schemaVersion",
  "exportedAt",
  "ui",
  "filters",
  "proxy",
  "autoResponder",
  // Legacy v0 keys supported by migration chain
  "version",
  "theme",
  "layout",
  "columnWidths",
  "visibleColumns",
  "toolbarGroups",
  "customPresets",
  "userPresets",
  "backendFilterConfig",
  "tlsInterceptMode",
  "autoResponderRules",
]);

type LiveSettingsSnapshotGetter = () => Partial<FluxUserSettingsProfile>;
let liveSnapshotGetter: LiveSettingsSnapshotGetter | null = null;

/**
 * Allows the root React application to register a live state reader so
 * `exportCurrentSettingsProfile()` always captures the latest in-memory hook state
 * alongside persisted `localStorage` entries.
 */
export function registerLiveSettingsSnapshotGetter(
  getter: LiveSettingsSnapshotGetter | null
): () => void {
  liveSnapshotGetter = getter;
  return () => {
    if (liveSnapshotGetter === getter) {
      liveSnapshotGetter = null;
    }
  };
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function readLocalStorageJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function createDefaultSettingsProfile(): FluxUserSettingsProfile {
  return {
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    ui: {
      theme: "dark",
      compactToolbar: DEFAULT_LAYOUT_PREFS.compactToolbar,
      sidebarCollapsed: DEFAULT_LAYOUT_PREFS.sidebarCollapsed,
      inspectorCollapsed: DEFAULT_LAYOUT_PREFS.inspectorCollapsed,
      inspectorPosition: DEFAULT_LAYOUT_PREFS.inspectorPosition,
      followTail: false,
      columnWidths: { ...DEFAULT_COLUMN_WIDTHS },
      visibleColumns: { ...DEFAULT_VISIBLE_COLUMNS },
      toolbarGroups: { ...DEFAULT_TOOLBAR_GROUPS },
    },
    filters: {
      activePresetId: null,
      userPresets: [],
      noiseThresholds: { ...DEFAULT_NOISE_THRESHOLDS },
      hostFilters: { ...DEFAULT_HOST_LIST_FILTER_CONFIG },
      matrixEnabled: true,
      filterRules: [],
    },
    proxy: {
      port: 8888,
      autoSystemProxy: true,
      allowRemote: false,
      tlsInterceptMode: DEFAULT_BACKEND_FILTER_CONFIG.tlsInterceptMode,
      tlsBypassRules: structuredClone(
        DEFAULT_BACKEND_FILTER_CONFIG.tlsBypassRules
      ),
      tlsTargetRules: structuredClone(
        DEFAULT_BACKEND_FILTER_CONFIG.tlsTargetRules
      ),
      headerMutations: structuredClone(
        DEFAULT_BACKEND_FILTER_CONFIG.headerMutations
      ),
      tlsBypassEnabled: DEFAULT_BACKEND_FILTER_CONFIG.tlsBypassEnabled,
      headerMutationsEnabled:
        DEFAULT_BACKEND_FILTER_CONFIG.headerMutationsEnabled,
      stripAltSvc: DEFAULT_BACKEND_FILTER_CONFIG.stripAltSvc,
      sessionRetentionLimit: DEFAULT_SESSION_RETENTION_LIMIT,
      dropNonMatching: false,
    },
    autoResponder: {
      enabled: true,
      rules: structuredClone(DEFAULT_AUTORESPONDER_RULES),
    },
  };
}

// ============================================================================
// Schema Version Migration Pipeline (v0 -> v1, extensible to v2+)
// ============================================================================
type SchemaMigrationFn = (
  draft: Record<string, unknown>,
  warnings: string[]
) => Record<string, unknown>;

const SCHEMA_MIGRATIONS: Record<number, SchemaMigrationFn> = {
  // Migration 0 -> 1: Normalizes legacy unversioned / flat settings dumps into schemaVersion: 1
  0: (draft, warnings) => {
    const existingUi = isPlainObject(draft.ui) ? { ...draft.ui } : {};
    const existingLayout = isPlainObject(draft.layout) ? draft.layout : {};
    const existingFilters = isPlainObject(draft.filters)
      ? { ...draft.filters }
      : {};
    const existingProxy = isPlainObject(draft.proxy) ? { ...draft.proxy } : {};
    const existingBackendCfg = isPlainObject(draft.backendFilterConfig)
      ? draft.backendFilterConfig
      : {};
    const existingAutoResp = isPlainObject(draft.autoResponder)
      ? { ...draft.autoResponder }
      : {};

    const ui: Record<string, unknown> = {
      ...existingLayout,
      ...existingUi,
    };
    if (ui.theme === undefined && draft.theme !== undefined) {
      ui.theme = draft.theme;
    }
    if (ui.columnWidths === undefined && draft.columnWidths !== undefined) {
      ui.columnWidths = draft.columnWidths;
    }
    if (ui.visibleColumns === undefined && draft.visibleColumns !== undefined) {
      ui.visibleColumns = draft.visibleColumns;
    }
    if (ui.toolbarGroups === undefined && draft.toolbarGroups !== undefined) {
      ui.toolbarGroups = draft.toolbarGroups;
    }
    if (ui.followTail === undefined && draft.followTail !== undefined) {
      ui.followTail = draft.followTail;
    }

    const filters: Record<string, unknown> = { ...existingFilters };
    if (filters.userPresets === undefined) {
      if (Array.isArray(draft.userPresets)) {
        filters.userPresets = draft.userPresets;
      } else if (Array.isArray(draft.customPresets)) {
        filters.userPresets = draft.customPresets;
      }
    }
    if (
      filters.noiseThresholds === undefined &&
      isPlainObject(draft.thresholds)
    ) {
      filters.noiseThresholds = draft.thresholds;
    }
    if (
      filters.hostFilters === undefined &&
      isPlainObject(draft.hostListFilter)
    ) {
      filters.hostFilters = draft.hostListFilter;
    }

    const proxy: Record<string, unknown> = {
      ...existingBackendCfg,
      ...existingProxy,
    };
    if (proxy.port === undefined && draft.port !== undefined) {
      proxy.port = draft.port;
    }
    if (
      proxy.autoSystemProxy === undefined &&
      draft.autoSystemProxy !== undefined
    ) {
      proxy.autoSystemProxy = draft.autoSystemProxy;
    }
    if (proxy.allowRemote === undefined && draft.allowRemote !== undefined) {
      proxy.allowRemote = draft.allowRemote;
    }

    const autoResponder: Record<string, unknown> = { ...existingAutoResp };
    if (
      autoResponder.rules === undefined &&
      Array.isArray(draft.autoResponderRules)
    ) {
      autoResponder.rules = draft.autoResponderRules;
    }

    warnings.push("Профиль мигрирован со старой схемы (v0 → v1).");

    return {
      schemaVersion: 1,
      exportedAt:
        typeof draft.exportedAt === "string" && draft.exportedAt.trim()
          ? draft.exportedAt
          : new Date().toISOString(),
      ui,
      filters,
      proxy,
      autoResponder,
    };
  },
};

// ============================================================================
// Granular Sanitizers with Safe Defaults
// ============================================================================
function sanitizeBoolean(
  val: unknown,
  fallback: boolean,
  fieldPath: string,
  warnings: string[]
): boolean {
  if (val === undefined) return fallback;
  if (typeof val === "boolean") return val;
  warnings.push(`Поле «${fieldPath}» повреждено — применено значение по умолчанию.`);
  return fallback;
}

function sanitizeNullablePositiveInt(
  val: unknown,
  fallback: number | null,
  fieldPath: string,
  warnings: string[],
  max = 100_000_000
): number | null {
  if (val === undefined) return fallback;
  if (val === null) return null;
  if (
    typeof val === "number" &&
    Number.isInteger(val) &&
    val >= 0 &&
    val <= max
  ) {
    return val;
  }
  warnings.push(`Поле «${fieldPath}» некорректно — сброшено к дефолту.`);
  return fallback;
}

function sanitizePositiveInt(
  val: unknown,
  fallback: number,
  min: number,
  max: number,
  fieldPath: string,
  warnings: string[]
): number {
  if (val === undefined) return fallback;
  if (typeof val === "number" && Number.isFinite(val)) {
    const rounded = Math.round(val);
    if (rounded >= min && rounded <= max) {
      return rounded;
    }
  }
  warnings.push(
    `Значение «${fieldPath}» вне допустимого диапазона (${min}..${max}) — использовано ${fallback}.`
  );
  return fallback;
}

function sanitizeNoiseThresholds(
  raw: unknown,
  fieldPrefix: string,
  warnings: string[]
): NoiseThresholdsConfig {
  const def = DEFAULT_NOISE_THRESHOLDS;
  if (raw === undefined) return { ...def };
  if (!isPlainObject(raw)) {
    warnings.push(`Секция «${fieldPrefix}» повреждена — восстановлены пороги по умолчанию.`);
    return { ...def };
  }
  const warningMs = sanitizePositiveInt(
    raw.timeHeatWarningMs,
    def.timeHeatWarningMs,
    10,
    120_000,
    `${fieldPrefix}.timeHeatWarningMs`,
    warnings
  );
  const criticalMs = sanitizePositiveInt(
    raw.timeHeatCriticalMs,
    Math.max(def.timeHeatCriticalMs, warningMs),
    10,
    300_000,
    `${fieldPrefix}.timeHeatCriticalMs`,
    warnings
  );
  return {
    hide304NotModified: sanitizeBoolean(
      raw.hide304NotModified,
      def.hide304NotModified,
      `${fieldPrefix}.hide304NotModified`,
      warnings
    ),
    hideOptionsPreflight: sanitizeBoolean(
      raw.hideOptionsPreflight,
      def.hideOptionsPreflight,
      `${fieldPrefix}.hideOptionsPreflight`,
      warnings
    ),
    hideConnectTunnels: sanitizeBoolean(
      raw.hideConnectTunnels,
      def.hideConnectTunnels,
      `${fieldPrefix}.hideConnectTunnels`,
      warnings
    ),
    hideStaticAssets: sanitizeBoolean(
      raw.hideStaticAssets,
      def.hideStaticAssets,
      `${fieldPrefix}.hideStaticAssets`,
      warnings
    ),
    minBodySizeBytes: sanitizeNullablePositiveInt(
      raw.minBodySizeBytes,
      def.minBodySizeBytes,
      `${fieldPrefix}.minBodySizeBytes`,
      warnings
    ),
    maxBodySizeBytes: sanitizeNullablePositiveInt(
      raw.maxBodySizeBytes,
      def.maxBodySizeBytes,
      `${fieldPrefix}.maxBodySizeBytes`,
      warnings
    ),
    timeHeatEnabled: sanitizeBoolean(
      raw.timeHeatEnabled,
      def.timeHeatEnabled,
      `${fieldPrefix}.timeHeatEnabled`,
      warnings
    ),
    timeHeatWarningMs: warningMs,
    timeHeatCriticalMs: Math.max(warningMs, criticalMs),
    onlySlowRequests: sanitizeBoolean(
      raw.onlySlowRequests,
      def.onlySlowRequests,
      `${fieldPrefix}.onlySlowRequests`,
      warnings
    ),
  };
}

function sanitizeHostListFilter(
  raw: unknown,
  fieldPrefix: string,
  warnings: string[]
): HostListFilterConfig {
  const def = DEFAULT_HOST_LIST_FILTER_CONFIG;
  if (raw === undefined) return { ...def };
  if (!isPlainObject(raw)) {
    warnings.push(`Секция «${fieldPrefix}» повреждена — сброшена к дефолту.`);
    return { ...def };
  }
  let mode: HostListFilterMode = def.mode;
  if (raw.mode !== undefined) {
    if (
      typeof raw.mode === "string" &&
      VALID_HOST_FILTER_MODES.has(raw.mode as HostListFilterMode)
    ) {
      mode = raw.mode as HostListFilterMode;
    } else {
      warnings.push(`Недопустимый режим «${fieldPrefix}.mode» — установлен whitelist.`);
    }
  }
  const rawText =
    raw.rawText === undefined
      ? def.rawText
      : typeof raw.rawText === "string"
        ? raw.rawText
        : (() => {
            warnings.push(`Поле «${fieldPrefix}.rawText» должно быть строкой — очищено.`);
            return "";
          })();

  return {
    enabled: sanitizeBoolean(
      raw.enabled,
      def.enabled,
      `${fieldPrefix}.enabled`,
      warnings
    ),
    mode,
    rawText,
    applyToTlsPassthrough: sanitizeBoolean(
      raw.applyToTlsPassthrough,
      def.applyToTlsPassthrough,
      `${fieldPrefix}.applyToTlsPassthrough`,
      warnings
    ),
  };
}

function sanitizeFilterConditionRule(
  raw: unknown,
  idx: number,
  warnings: string[]
): FilterConditionRule | null {
  if (!isPlainObject(raw)) {
    warnings.push(`Правило фильтрации #${idx + 1} пропущено (не объект).`);
    return null;
  }
  const action: FilterRuleAction =
    typeof raw.action === "string" &&
    VALID_FILTER_ACTIONS.has(raw.action as FilterRuleAction)
      ? (raw.action as FilterRuleAction)
      : "include";
  const logicalOp: FilterLogicalOp =
    typeof raw.logicalOp === "string" &&
    VALID_LOGICAL_OPS.has(raw.logicalOp as FilterLogicalOp)
      ? (raw.logicalOp as FilterLogicalOp)
      : "AND";
  const field: FilterField =
    typeof raw.field === "string" &&
    VALID_FILTER_FIELDS.has(raw.field as FilterField)
      ? (raw.field as FilterField)
      : "url";
  const operator: FilterOperator =
    typeof raw.operator === "string" &&
    VALID_FILTER_OPERATORS.has(raw.operator as FilterOperator)
      ? (raw.operator as FilterOperator)
      : "contains";

  return {
    id:
      typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim()
        : `f-imported-${idx + 1}`,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    action,
    logicalOp,
    field,
    operator,
    value: typeof raw.value === "string" ? raw.value : String(raw.value ?? ""),
  };
}

function sanitizeFilterPreset(
  raw: unknown,
  idx: number,
  warnings: string[]
): FilterPreset | null {
  if (!isPlainObject(raw)) {
    warnings.push(`Пользовательский пресет #${idx + 1} пропущен (повреждён формат).`);
    return null;
  }
  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim()
      : `preset-imported-${Date.now()}-${idx + 1}`;
  const name =
    typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : `Импортированный пресет #${idx + 1}`;
  const description =
    typeof raw.description === "string"
      ? raw.description
      : "Пользовательский пресет фильтров";
  const rulesRaw = Array.isArray(raw.rules) ? raw.rules : [];
  const rules = rulesRaw
    .map((item, rIdx) => sanitizeFilterConditionRule(item, rIdx, warnings))
    .filter((r): r is FilterConditionRule => r !== null);

  return {
    id,
    name,
    description,
    builtIn: false,
    matrixEnabled:
      typeof raw.matrixEnabled === "boolean" ? raw.matrixEnabled : true,
    rules,
    thresholds: sanitizeNoiseThresholds(
      raw.thresholds,
      `filters.userPresets[${idx}].thresholds`,
      warnings
    ),
    ...(typeof raw.forceNoCache === "boolean"
      ? { forceNoCache: raw.forceNoCache }
      : {}),
    ...(raw.hostListFilter !== undefined
      ? {
          hostListFilter: sanitizeHostListFilter(
            raw.hostListFilter,
            `filters.userPresets[${idx}].hostListFilter`,
            warnings
          ),
        }
      : {}),
  };
}

function sanitizeTlsRuleList(
  raw: unknown,
  fallback: TlsBypassRule[],
  fieldPath: string,
  warnings: string[]
): TlsBypassRule[] {
  if (raw === undefined) return structuredClone(fallback);
  if (!Array.isArray(raw)) {
    warnings.push(`Список «${fieldPath}» повреждён — восстановлены правила по умолчанию.`);
    return structuredClone(fallback);
  }
  const out: TlsBypassRule[] = [];
  raw.forEach((item, idx) => {
    if (!isPlainObject(item) || typeof item.pattern !== "string") {
      warnings.push(`Правило «${fieldPath}[${idx}]» пропущено (нет строкового pattern).`);
      return;
    }
    const cleanPattern = item.pattern.trim();
    if (!cleanPattern) return;
    out.push({
      id:
        typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : `tls-rule-${idx + 1}`,
      enabled: typeof item.enabled === "boolean" ? item.enabled : true,
      pattern: cleanPattern,
      category:
        typeof item.category === "string" && item.category.trim()
          ? item.category.trim()
          : "Custom",
      description:
        typeof item.description === "string" ? item.description : cleanPattern,
    });
  });
  return out;
}

function sanitizeHeaderMutations(
  raw: unknown,
  fallback: HeaderMutationRule[],
  warnings: string[]
): HeaderMutationRule[] {
  if (raw === undefined) return structuredClone(fallback);
  if (!Array.isArray(raw)) {
    warnings.push(
      "Список «proxy.headerMutations» повреждён — восстановлены мутации по умолчанию."
    );
    return structuredClone(fallback);
  }
  const out: HeaderMutationRule[] = [];
  raw.forEach((item, idx) => {
    if (!isPlainObject(item) || typeof item.headerName !== "string") {
      warnings.push(
        `Правило заголовка «proxy.headerMutations[${idx}]» пропущено.`
      );
      return;
    }
    const cleanHeader = item.headerName.trim();
    if (!cleanHeader) return;
    const direction: HeaderMutationDirection =
      typeof item.direction === "string" &&
      VALID_HEADER_DIRECTIONS.has(item.direction as HeaderMutationDirection)
        ? (item.direction as HeaderMutationDirection)
        : "request";
    const operation: HeaderMutationOp =
      typeof item.operation === "string" &&
      VALID_HEADER_OPS.has(item.operation as HeaderMutationOp)
        ? (item.operation as HeaderMutationOp)
        : "set";

    out.push({
      id:
        typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : `hm-${idx + 1}`,
      enabled: typeof item.enabled === "boolean" ? item.enabled : false,
      name:
        typeof item.name === "string" && item.name.trim()
          ? item.name.trim()
          : `${operation.toUpperCase()} ${cleanHeader}`,
      direction,
      operation,
      headerName: cleanHeader,
      headerValue:
        typeof item.headerValue === "string" ? item.headerValue : "",
      urlPattern:
        typeof item.urlPattern === "string" && item.urlPattern.trim()
          ? item.urlPattern.trim()
          : "*",
    });
  });
  return out;
}

function sanitizeHeaderPairs(raw: unknown): HeaderPair[] {
  if (!Array.isArray(raw)) return [];
  const out: HeaderPair[] = [];
  for (const item of raw) {
    if (isPlainObject(item) && typeof item.name === "string" && item.name.trim()) {
      out.push({
        name: item.name.trim(),
        value: typeof item.value === "string" ? item.value : String(item.value ?? ""),
      });
    }
  }
  return out;
}

function sanitizeAutoResponderRules(
  raw: unknown,
  fallback: AutoResponderRule[],
  warnings: string[]
): AutoResponderRule[] {
  if (raw === undefined) return structuredClone(fallback);
  if (!Array.isArray(raw)) {
    warnings.push(
      "Список «autoResponder.rules» повреждён — восстановлены правила по умолчанию."
    );
    return structuredClone(fallback);
  }
  const out: AutoResponderRule[] = [];
  raw.forEach((item, idx) => {
    if (!isPlainObject(item) || typeof item.pattern !== "string") {
      warnings.push(`Правило AutoResponder #${idx + 1} пропущено (повреждён формат).`);
      return;
    }
    const matchTarget: RuleMatchTarget =
      typeof item.matchTarget === "string" &&
      VALID_RULE_TARGETS.has(item.matchTarget as RuleMatchTarget)
        ? (item.matchTarget as RuleMatchTarget)
        : "urlContains";
    const action: RuleActionType =
      typeof item.action === "string" &&
      VALID_RULE_ACTIONS.has(item.action as RuleActionType)
        ? (item.action as RuleActionType)
        : "mockResponse";
    const statusCode = sanitizePositiveInt(
      item.statusCode,
      200,
      100,
      599,
      `autoResponder.rules[${idx}].statusCode`,
      warnings
    );
    const latencyMs = sanitizePositiveInt(
      item.latencyMs,
      0,
      0,
      60_000,
      `autoResponder.rules[${idx}].latencyMs`,
      warnings
    );

    out.push({
      id:
        typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : `rule-imported-${idx + 1}`,
      enabled: typeof item.enabled === "boolean" ? item.enabled : false,
      name:
        typeof item.name === "string" && item.name.trim()
          ? item.name.trim()
          : `AutoResponder Rule #${idx + 1}`,
      matchTarget,
      pattern: item.pattern,
      methodFilter:
        typeof item.methodFilter === "string" && item.methodFilter.trim()
          ? item.methodFilter.trim().toUpperCase()
          : "ANY",
      headerName:
        typeof item.headerName === "string" && item.headerName.trim()
          ? item.headerName.trim()
          : null,
      action,
      statusCode,
      latencyMs,
      responseHeaders: sanitizeHeaderPairs(item.responseHeaders),
      responseBody:
        typeof item.responseBody === "string" ? item.responseBody : "",
    });
  });
  return out;
}

/**
 * Checks whether a parsed JSON payload looks like a FluxProxy settings profile
 * (useful when routing dragged-and-dropped `.json` files).
 */
export function isLikelyFluxSettingsProfile(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  if ("log" in raw && isPlainObject(raw.log) && !("schemaVersion" in raw)) {
    return false;
  }
  return (
    typeof raw.schemaVersion === "number" ||
    (isPlainObject(raw.ui) &&
      (isPlainObject(raw.filters) ||
        isPlainObject(raw.proxy) ||
        isPlainObject(raw.autoResponder)))
  );
}

/**
 * Parses a raw JSON text string, validates schema & migrates if needed,
 * returning both the normalized `FluxUserSettingsProfile` and any field recovery warnings.
 */
export function parseAndValidateSettingsJsonText(
  jsonText: string
): SettingsProfileValidationReport {
  const cleaned = jsonText.replace(/^\uFEFF/, "").trim();
  if (!cleaned) {
    throw new Error("Файл настроек пуст.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Синтаксическая ошибка JSON в файле настроек: ${detail}`);
  }
  return validateAndMigrateSettingsProfileWithReport(parsed);
}

/**
 * Validates raw input (parsed JSON object or raw JSON string), runs versioned
 * schema migrations (`v0 -> v1`), falls back to safe defaults for damaged individual
 * fields, and returns a detailed validation report.
 */
export function validateAndMigrateSettingsProfileWithReport(
  rawJson: unknown
): SettingsProfileValidationReport {
  let candidate: unknown = rawJson;
  if (typeof candidate === "string") {
    return parseAndValidateSettingsJsonText(candidate);
  }

  if (!isPlainObject(candidate)) {
    throw new Error(
      "Невалидный формат профиля настроек: корневой элемент JSON должен быть объектом."
    );
  }

  if (
    "log" in candidate &&
    isPlainObject(candidate.log) &&
    !("schemaVersion" in candidate) &&
    !("ui" in candidate)
  ) {
    throw new Error(
      "Выбран архив HTTP-сессий (.har) вместо профиля настроек FluxProxy. Используйте File → Open / Import Archive."
    );
  }

  const topKeys = Object.keys(candidate);
  if (topKeys.length === 0) {
    throw new Error(
      "JSON-объект пуст и не содержит секций профиля настроек FluxProxy."
    );
  }
  const hasAnyKnownKey = topKeys.some((k) => RECOGNIZED_PROFILE_TOP_KEYS.has(k));
  if (!hasAnyKnownKey) {
    throw new Error(
      "Файл JSON не является профилем настроек FluxProxy (отсутствуют schemaVersion, ui, filters, proxy, autoResponder)."
    );
  }

  const warnings: string[] = [];
  let migratedFromVersion: number | null = null;

  // Determine source schema version & execute migration chain
  let version: number;
  if (candidate.schemaVersion === undefined || candidate.schemaVersion === null) {
    version = 0;
    migratedFromVersion = 0;
  } else if (
    typeof candidate.schemaVersion === "number" &&
    Number.isInteger(candidate.schemaVersion)
  ) {
    if (candidate.schemaVersion > CURRENT_SETTINGS_SCHEMA_VERSION) {
      throw new Error(
        `Версия схемы профиля (v${candidate.schemaVersion}) новее поддерживаемой приложением (v${CURRENT_SETTINGS_SCHEMA_VERSION}).`
      );
    }
    if (candidate.schemaVersion < 0) {
      warnings.push(
        `Некорректный номер schemaVersion (${candidate.schemaVersion}) — выполнена миграция к v${CURRENT_SETTINGS_SCHEMA_VERSION}.`
      );
      version = 0;
      migratedFromVersion = candidate.schemaVersion;
    } else {
      version = candidate.schemaVersion;
      if (version < CURRENT_SETTINGS_SCHEMA_VERSION) {
        migratedFromVersion = version;
      }
    }
  } else {
    warnings.push(
      `Повреждённое поле schemaVersion — профиль приведён к схеме v${CURRENT_SETTINGS_SCHEMA_VERSION}.`
    );
    version = 0;
    migratedFromVersion = 0;
  }

  let workingDraft: Record<string, unknown> = { ...candidate };
  while (version < CURRENT_SETTINGS_SCHEMA_VERSION) {
    const migrate = SCHEMA_MIGRATIONS[version];
    if (!migrate) {
      throw new Error(
        `Отсутствует мигратор схемы настроек с версии v${version} до v${version + 1}.`
      );
    }
    workingDraft = migrate(workingDraft, warnings);
    version += 1;
  }

  const defaults = createDefaultSettingsProfile();

  // 1. Validate `exportedAt`
  let exportedAt = defaults.exportedAt;
  if (typeof workingDraft.exportedAt === "string" && workingDraft.exportedAt.trim()) {
    const parsedTime = Date.parse(workingDraft.exportedAt);
    if (!Number.isNaN(parsedTime)) {
      exportedAt = new Date(parsedTime).toISOString();
    } else {
      warnings.push("Поле «exportedAt» имело невалидную дату — заменено текущим временем.");
    }
  }

  // 2. Validate `ui`
  const rawUi = isPlainObject(workingDraft.ui)
    ? workingDraft.ui
    : (() => {
        if (workingDraft.ui !== undefined) {
          warnings.push("Секция «ui» повреждена — применены настройки интерфейса по умолчанию.");
        }
        return {} as Record<string, unknown>;
      })();

  let theme: ThemePreference = defaults.ui.theme;
  if (rawUi.theme !== undefined) {
    if (
      typeof rawUi.theme === "string" &&
      VALID_THEMES.has(rawUi.theme as ThemePreference)
    ) {
      theme = rawUi.theme as ThemePreference;
    } else {
      warnings.push("Поле «ui.theme» некорректно — выбрана тёмная тема (dark).");
    }
  }

  let inspectorPosition: InspectorDockPosition = defaults.ui.inspectorPosition;
  if (rawUi.inspectorPosition !== undefined) {
    if (
      typeof rawUi.inspectorPosition === "string" &&
      VALID_DOCK_POSITIONS.has(rawUi.inspectorPosition as InspectorDockPosition)
    ) {
      inspectorPosition = rawUi.inspectorPosition as InspectorDockPosition;
    } else {
      warnings.push(
        "Поле «ui.inspectorPosition» некорректно — панель инспектора закреплена снизу (bottom)."
      );
    }
  }

  const columnWidths: Record<ColumnId, number> = { ...DEFAULT_COLUMN_WIDTHS };
  if (rawUi.columnWidths !== undefined) {
    if (isPlainObject(rawUi.columnWidths)) {
      for (const col of TRAFFIC_COLUMNS) {
        const rawW = rawUi.columnWidths[col.id];
        if (rawW === undefined) continue;
        if (typeof rawW === "number" && Number.isFinite(rawW) && rawW > 0) {
          const minW = COLUMN_MIN_WIDTHS[col.id] ?? col.minWidth;
          columnWidths[col.id] = Math.min(1600, Math.max(minW, Math.round(rawW)));
        } else {
          warnings.push(
            `Ширина колонки «${col.label}» повреждена — сброшена к ${col.defaultWidth}px.`
          );
        }
      }
    } else {
      warnings.push("Поле «ui.columnWidths» повреждено — ширины колонок сброшены к дефолтам.");
    }
  }

  const visibleColumns: Record<ColumnId, boolean> = {
    ...DEFAULT_VISIBLE_COLUMNS,
  };
  if (rawUi.visibleColumns !== undefined) {
    if (isPlainObject(rawUi.visibleColumns)) {
      for (const col of TRAFFIC_COLUMNS) {
        const rawVis = rawUi.visibleColumns[col.id];
        if (rawVis === undefined) continue;
        if (typeof rawVis === "boolean") {
          visibleColumns[col.id] = rawVis;
        } else {
          warnings.push(
            `Флаг видимости колонки «${col.label}» повреждён — оставлена видимой.`
          );
        }
      }
      if (!Object.values(visibleColumns).some(Boolean)) {
        visibleColumns.id = true;
        visibleColumns.url = true;
        warnings.push(
          "Все колонки в профиле были скрыты — автоматически включены «#» и «URL»."
        );
      }
    } else {
      warnings.push("Поле «ui.visibleColumns» повреждено — видимость колонок сброшена.");
    }
  }

  const toolbarGroups: Record<ToolbarGroupId, boolean> = {
    ...DEFAULT_TOOLBAR_GROUPS,
  };
  if (rawUi.toolbarGroups !== undefined) {
    if (isPlainObject(rawUi.toolbarGroups)) {
      for (const grp of TOOLBAR_GROUP_DEFINITIONS) {
        const rawGrp = rawUi.toolbarGroups[grp.id];
        if (rawGrp === undefined) continue;
        if (typeof rawGrp === "boolean") {
          toolbarGroups[grp.id] = rawGrp;
        } else {
          warnings.push(
            `Состояние группы тулбара «${grp.label}» повреждено — применён дефолт.`
          );
        }
      }
    } else {
      warnings.push("Поле «ui.toolbarGroups» повреждено — группы тулбара сброшены.");
    }
  }

  // 3. Validate `filters`
  const rawFilters = isPlainObject(workingDraft.filters)
    ? workingDraft.filters
    : (() => {
        if (workingDraft.filters !== undefined) {
          warnings.push("Секция «filters» повреждена — применены фильтры по умолчанию.");
        }
        return {} as Record<string, unknown>;
      })();

  let userPresets: FilterPreset[] = [];
  if (rawFilters.userPresets !== undefined) {
    if (Array.isArray(rawFilters.userPresets)) {
      userPresets = rawFilters.userPresets
        .map((item, idx) => sanitizeFilterPreset(item, idx, warnings))
        .filter((p): p is FilterPreset => p !== null);
    } else {
      warnings.push(
        "Поле «filters.userPresets» повреждено — список пользовательских пресетов очищен."
      );
    }
  }

  const allValidPresetIds = new Set<string>([
    ...BUILT_IN_FILTER_PRESETS.map((p) => p.id),
    ...userPresets.map((p) => p.id),
  ]);

  let activePresetId: string | null = null;
  if (rawFilters.activePresetId !== undefined && rawFilters.activePresetId !== null) {
    if (typeof rawFilters.activePresetId === "string") {
      const trimmedId = rawFilters.activePresetId.trim();
      if (!trimmedId) {
        activePresetId = null;
      } else if (allValidPresetIds.has(trimmedId)) {
        activePresetId = trimmedId;
      } else {
        warnings.push(
          `Активный пресет «${trimmedId}» не найден в списке пресетов — сброшен.`
        );
      }
    } else {
      warnings.push("Поле «filters.activePresetId» повреждено — сброшено.");
    }
  }

  const matchedActivePreset = activePresetId
    ? [...BUILT_IN_FILTER_PRESETS, ...userPresets].find(
        (p) => p.id === activePresetId
      ) ?? null
    : null;

  let filterRules: FilterConditionRule[] = [];
  if (rawFilters.filterRules !== undefined) {
    if (Array.isArray(rawFilters.filterRules)) {
      filterRules = rawFilters.filterRules
        .map((r, idx) => sanitizeFilterConditionRule(r, idx, warnings))
        .filter((r): r is FilterConditionRule => r !== null);
    } else {
      warnings.push("Поле «filters.filterRules» повреждено — правила матрицы сброшены.");
    }
  } else if (matchedActivePreset) {
    filterRules = structuredClone(matchedActivePreset.rules);
  }

  const matrixEnabled = sanitizeBoolean(
    rawFilters.matrixEnabled,
    matchedActivePreset ? matchedActivePreset.matrixEnabled : true,
    "filters.matrixEnabled",
    warnings
  );

  const noiseThresholds = sanitizeNoiseThresholds(
    rawFilters.noiseThresholds,
    "filters.noiseThresholds",
    warnings
  );

  const hostFilters = sanitizeHostListFilter(
    rawFilters.hostFilters,
    "filters.hostFilters",
    warnings
  );

  // 4. Validate `proxy`
  const rawProxy = isPlainObject(workingDraft.proxy)
    ? workingDraft.proxy
    : (() => {
        if (workingDraft.proxy !== undefined) {
          warnings.push("Секция «proxy» повреждена — применены параметры прокси по умолчанию.");
        }
        return {} as Record<string, unknown>;
      })();

  let tlsInterceptMode: TlsInterceptMode = defaults.proxy.tlsInterceptMode;
  if (rawProxy.tlsInterceptMode !== undefined) {
    if (
      typeof rawProxy.tlsInterceptMode === "string" &&
      VALID_TLS_MODES.has(rawProxy.tlsInterceptMode as TlsInterceptMode)
    ) {
      tlsInterceptMode = rawProxy.tlsInterceptMode as TlsInterceptMode;
    } else {
      warnings.push(
        "Поле «proxy.tlsInterceptMode» некорректно — установлен режим interceptAll."
      );
    }
  }

  let sessionRetentionLimit: number | null = DEFAULT_SESSION_RETENTION_LIMIT;
  if (rawProxy.sessionRetentionLimit !== undefined) {
    if (rawProxy.sessionRetentionLimit === null) {
      sessionRetentionLimit = null;
    } else if (
      typeof rawProxy.sessionRetentionLimit === "number" &&
      Number.isInteger(rawProxy.sessionRetentionLimit) &&
      rawProxy.sessionRetentionLimit > 0 &&
      rawProxy.sessionRetentionLimit <= 5_000_000
    ) {
      sessionRetentionLimit = rawProxy.sessionRetentionLimit;
    } else {
      warnings.push(
        `Поле «proxy.sessionRetentionLimit» некорректно — установлено ${DEFAULT_SESSION_RETENTION_LIMIT}.`
      );
    }
  }

  // 5. Validate `autoResponder`
  const rawAutoResponder = isPlainObject(workingDraft.autoResponder)
    ? workingDraft.autoResponder
    : (() => {
        if (workingDraft.autoResponder !== undefined) {
          warnings.push(
            "Секция «autoResponder» повреждена — восстановлены правила AutoResponder по умолчанию."
          );
        }
        return {} as Record<string, unknown>;
      })();

  const profile: FluxUserSettingsProfile = {
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    exportedAt,
    ui: {
      theme,
      compactToolbar: sanitizeBoolean(
        rawUi.compactToolbar,
        defaults.ui.compactToolbar,
        "ui.compactToolbar",
        warnings
      ),
      sidebarCollapsed: sanitizeBoolean(
        rawUi.sidebarCollapsed,
        defaults.ui.sidebarCollapsed,
        "ui.sidebarCollapsed",
        warnings
      ),
      inspectorCollapsed: sanitizeBoolean(
        rawUi.inspectorCollapsed,
        defaults.ui.inspectorCollapsed,
        "ui.inspectorCollapsed",
        warnings
      ),
      inspectorPosition,
      followTail: sanitizeBoolean(
        rawUi.followTail,
        defaults.ui.followTail,
        "ui.followTail",
        warnings
      ),
      columnWidths,
      visibleColumns,
      toolbarGroups,
    },
    filters: {
      activePresetId,
      userPresets,
      noiseThresholds,
      hostFilters,
      matrixEnabled,
      filterRules,
    },
    proxy: {
      port: sanitizePositiveInt(
        rawProxy.port,
        defaults.proxy.port,
        1,
        65535,
        "proxy.port",
        warnings
      ),
      autoSystemProxy: sanitizeBoolean(
        rawProxy.autoSystemProxy,
        defaults.proxy.autoSystemProxy,
        "proxy.autoSystemProxy",
        warnings
      ),
      allowRemote: sanitizeBoolean(
        rawProxy.allowRemote,
        defaults.proxy.allowRemote,
        "proxy.allowRemote",
        warnings
      ),
      tlsInterceptMode,
      tlsBypassRules: sanitizeTlsRuleList(
        rawProxy.tlsBypassRules,
        defaults.proxy.tlsBypassRules,
        "proxy.tlsBypassRules",
        warnings
      ),
      tlsTargetRules: sanitizeTlsRuleList(
        rawProxy.tlsTargetRules,
        defaults.proxy.tlsTargetRules,
        "proxy.tlsTargetRules",
        warnings
      ),
      headerMutations: sanitizeHeaderMutations(
        rawProxy.headerMutations,
        defaults.proxy.headerMutations,
        warnings
      ),
      tlsBypassEnabled: sanitizeBoolean(
        rawProxy.tlsBypassEnabled,
        true,
        "proxy.tlsBypassEnabled",
        warnings
      ),
      headerMutationsEnabled: sanitizeBoolean(
        rawProxy.headerMutationsEnabled,
        true,
        "proxy.headerMutationsEnabled",
        warnings
      ),
      stripAltSvc: sanitizeBoolean(
        rawProxy.stripAltSvc,
        true,
        "proxy.stripAltSvc",
        warnings
      ),
      sessionRetentionLimit,
      dropNonMatching: sanitizeBoolean(
        rawProxy.dropNonMatching,
        false,
        "proxy.dropNonMatching",
        warnings
      ),
    },
    autoResponder: {
      enabled: sanitizeBoolean(
        rawAutoResponder.enabled,
        defaults.autoResponder.enabled,
        "autoResponder.enabled",
        warnings
      ),
      rules: sanitizeAutoResponderRules(
        rawAutoResponder.rules,
        defaults.autoResponder.rules,
        warnings
      ),
    },
  };

  return {
    profile,
    warnings,
    migratedFromVersion,
  };
}

/**
 * Validates and migrates an unknown parsed JSON payload into a valid
 * `FluxUserSettingsProfile` (`schemaVersion: 1`), falling back to defaults
 * when individual fields are damaged.
 */
export function validateAndMigrateSettingsProfile(
  rawJson: unknown
): FluxUserSettingsProfile {
  return validateAndMigrateSettingsProfileWithReport(rawJson).profile;
}

/**
 * Gathers all current settings from live React hooks (when mounted) and
 * `localStorage` into a normalized `FluxUserSettingsProfile` (`schemaVersion: 1`).
 */
export function collectCurrentSettingsProfile(): FluxUserSettingsProfile {
  const defaults = createDefaultSettingsProfile();

  const rawTheme =
    typeof window !== "undefined"
      ? window.localStorage.getItem(SETTINGS_STORAGE_KEYS.theme)
      : null;
  const storedTheme: ThemePreference =
    rawTheme === "dark" || rawTheme === "light" || rawTheme === "system"
      ? rawTheme
      : defaults.ui.theme;

  const storedLayout = readLocalStorageJson<Record<string, unknown>>(
    SETTINGS_STORAGE_KEYS.uiLayout,
    {}
  );
  const storedToolbarGroups = readLocalStorageJson<
    Partial<Record<ToolbarGroupId, boolean>>
  >(SETTINGS_STORAGE_KEYS.toolbarGroups, {});
  const storedVisibleCols = readLocalStorageJson<
    Partial<Record<ColumnId, boolean>>
  >(SETTINGS_STORAGE_KEYS.visibleColumns, {});
  const storedColWidths = readLocalStorageJson<Partial<Record<ColumnId, number>>>(
    SETTINGS_STORAGE_KEYS.columnWidths,
    {}
  );
  const storedFollowTail = readLocalStorageJson<boolean>(
    SETTINGS_STORAGE_KEYS.followTail,
    defaults.ui.followTail
  );
  const storedCustomPresets = readLocalStorageJson<FilterPreset[]>(
    SETTINGS_STORAGE_KEYS.customPresets,
    []
  );
  const storedActiveFilter = readLocalStorageJson<{
    matrixEnabled?: boolean;
    rules?: FilterConditionRule[];
    thresholds?: NoiseThresholdsConfig;
    activePresetId?: string | null;
    hostListFilter?: HostListFilterConfig;
  }>(SETTINGS_STORAGE_KEYS.activeFilterState, {});
  const storedBackendCfg = readLocalStorageJson<
    Partial<ProxyFilterBackendConfig>
  >(SETTINGS_STORAGE_KEYS.backendFilterConfig, {});
  const storedAutoSysProxy = readLocalStorageJson<boolean>(
    SETTINGS_STORAGE_KEYS.autoSystemProxy,
    defaults.proxy.autoSystemProxy
  );
  const storedAllowRemote = readLocalStorageJson<boolean>(
    SETTINGS_STORAGE_KEYS.allowRemote,
    defaults.proxy.allowRemote
  );
  const storedPort = readLocalStorageJson<number>(
    SETTINGS_STORAGE_KEYS.proxyPort,
    defaults.proxy.port
  );
  const storedRetention = readLocalStorageJson<number | null>(
    SETTINGS_STORAGE_KEYS.sessionRetentionLimit,
    DEFAULT_SESSION_RETENTION_LIMIT
  );
  const storedDropNonMatching = readLocalStorageJson<boolean>(
    SETTINGS_STORAGE_KEYS.dropNonMatching,
    false
  );
  const storedAutoResponder = readLocalStorageJson<{
    enabled?: boolean;
    rules?: AutoResponderRule[];
  }>(SETTINGS_STORAGE_KEYS.autoResponder, {
    enabled: defaults.autoResponder.enabled,
    rules: defaults.autoResponder.rules,
  });

  const live = liveSnapshotGetter ? liveSnapshotGetter() : {};

  const mergedCandidate: FluxUserSettingsProfile = {
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    ui: {
      theme: live.ui?.theme ?? storedTheme,
      compactToolbar:
        live.ui?.compactToolbar ??
        (typeof storedLayout.compactToolbar === "boolean"
          ? storedLayout.compactToolbar
          : defaults.ui.compactToolbar),
      sidebarCollapsed:
        live.ui?.sidebarCollapsed ??
        Boolean(storedLayout.sidebarCollapsed ?? defaults.ui.sidebarCollapsed),
      inspectorCollapsed:
        live.ui?.inspectorCollapsed ??
        Boolean(
          storedLayout.inspectorCollapsed ?? defaults.ui.inspectorCollapsed
        ),
      inspectorPosition:
        live.ui?.inspectorPosition ??
        (storedLayout.inspectorPosition === "right" ? "right" : "bottom"),
      followTail: live.ui?.followTail ?? Boolean(storedFollowTail),
      columnWidths: live.ui?.columnWidths ?? {
        ...DEFAULT_COLUMN_WIDTHS,
        ...storedColWidths,
      },
      visibleColumns: live.ui?.visibleColumns ?? {
        ...DEFAULT_VISIBLE_COLUMNS,
        ...storedVisibleCols,
      },
      toolbarGroups: live.ui?.toolbarGroups ?? {
        ...DEFAULT_TOOLBAR_GROUPS,
        ...storedToolbarGroups,
      },
    },
    filters: {
      activePresetId:
        live.filters !== undefined
          ? live.filters.activePresetId
          : (storedActiveFilter.activePresetId ?? null),
      userPresets: structuredClone(
        live.filters?.userPresets ?? storedCustomPresets
      ),
      noiseThresholds: {
        ...DEFAULT_NOISE_THRESHOLDS,
        ...(storedActiveFilter.thresholds ?? {}),
        ...(live.filters?.noiseThresholds ?? {}),
      },
      hostFilters: {
        ...DEFAULT_HOST_LIST_FILTER_CONFIG,
        ...(storedActiveFilter.hostListFilter ?? {}),
        ...(live.filters?.hostFilters ?? {}),
      },
      matrixEnabled:
        live.filters?.matrixEnabled ??
        storedActiveFilter.matrixEnabled ??
        true,
      filterRules: structuredClone(
        live.filters?.filterRules ?? storedActiveFilter.rules ?? []
      ),
    },
    proxy: {
      port: live.proxy?.port ?? storedPort,
      autoSystemProxy: live.proxy?.autoSystemProxy ?? storedAutoSysProxy,
      allowRemote: live.proxy?.allowRemote ?? storedAllowRemote,
      tlsInterceptMode:
        live.proxy?.tlsInterceptMode ??
        storedBackendCfg.tlsInterceptMode ??
        defaults.proxy.tlsInterceptMode,
      tlsBypassRules: structuredClone(
        live.proxy?.tlsBypassRules ??
          storedBackendCfg.tlsBypassRules ??
          defaults.proxy.tlsBypassRules
      ),
      tlsTargetRules: structuredClone(
        live.proxy?.tlsTargetRules ??
          storedBackendCfg.tlsTargetRules ??
          defaults.proxy.tlsTargetRules
      ),
      headerMutations: structuredClone(
        live.proxy?.headerMutations ??
          storedBackendCfg.headerMutations ??
          defaults.proxy.headerMutations
      ),
      tlsBypassEnabled:
        live.proxy?.tlsBypassEnabled ??
        storedBackendCfg.tlsBypassEnabled ??
        true,
      headerMutationsEnabled:
        live.proxy?.headerMutationsEnabled ??
        storedBackendCfg.headerMutationsEnabled ??
        true,
      stripAltSvc:
        live.proxy?.stripAltSvc ?? storedBackendCfg.stripAltSvc ?? true,
      sessionRetentionLimit:
        live.proxy?.sessionRetentionLimit !== undefined
          ? live.proxy.sessionRetentionLimit
          : storedRetention,
      dropNonMatching: live.proxy?.dropNonMatching ?? storedDropNonMatching,
    },
    autoResponder: {
      enabled:
        live.autoResponder?.enabled ??
        storedAutoResponder.enabled ??
        defaults.autoResponder.enabled,
      rules: structuredClone(
        live.autoResponder?.rules ??
          storedAutoResponder.rules ??
          defaults.autoResponder.rules
      ),
    },
  };

  return validateAndMigrateSettingsProfile(mergedCandidate);
}

/**
 * Collects all current user settings from React hooks & `localStorage` into a
 * single versioned JSON profile (`schemaVersion: 1`) and saves it as
 * `fluxproxy-settings-v1.json`. Returns `null` if the user cancels the file dialog.
 */
export async function exportCurrentSettingsProfile(): Promise<FluxUserSettingsProfile | null> {
  const profile: FluxUserSettingsProfile = {
    ...collectCurrentSettingsProfile(),
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
  };

  const chosenPath = await proxyBridge.pickSaveFileDialog({
    title: "Export FluxProxy Settings Profile (JSON)",
    defaultName: DEFAULT_SETTINGS_EXPORT_FILENAME,
    filters: [
      {
        name: "FluxProxy Settings Profile (*.json)",
        extensions: ["json"],
      },
      { name: "All Files (*.*)", extensions: ["*"] },
    ],
  });

  if (!chosenPath) {
    return null;
  }

  const serialized = `${JSON.stringify(profile, null, 2)}\n`;
  await proxyBridge.exportSettingsJsonFile(chosenPath, serialized);
  return profile;
}

/**
 * Builds an impact summary comparing an incoming `FluxUserSettingsProfile` against
 * the currently active profile for the modal import preview.
 */
export function buildSettingsImportPreview(
  incoming: FluxUserSettingsProfile,
  options?: {
    fileName?: string;
    warnings?: string[];
    migratedFromVersion?: number | null;
    currentProfile?: FluxUserSettingsProfile;
  }
): SettingsImportPreviewSummary {
  const current = options?.currentProfile ?? collectCurrentSettingsProfile();
  const compiledHl = compileHostListFilter(incoming.filters.hostFilters);
  const currentCompiledHl = compileHostListFilter(current.filters.hostFilters);

  const filterRulesCount = (incoming.filters.filterRules ?? []).length;
  const tlsBypassRulesCount = incoming.proxy.tlsBypassRules.length;
  const tlsTargetRulesCount = incoming.proxy.tlsTargetRules.length;
  const headerMutationsCount = incoming.proxy.headerMutations.length;
  const autoResponderRulesCount = incoming.autoResponder.rules.length;
  const totalRulesCount =
    filterRulesCount +
    compiledHl.activeCount +
    tlsBypassRulesCount +
    tlsTargetRulesCount +
    headerMutationsCount +
    autoResponderRulesCount;

  const currentTotalRulesCount =
    (current.filters.filterRules ?? []).length +
    currentCompiledHl.activeCount +
    current.proxy.tlsBypassRules.length +
    current.proxy.tlsTargetRules.length +
    current.proxy.headerMutations.length +
    current.autoResponder.rules.length;

  const visibleColumnsCount = TRAFFIC_COLUMNS.filter(
    (c) => incoming.ui.visibleColumns[c.id]
  ).length;
  const customizedColumnWidthsCount = TRAFFIC_COLUMNS.filter(
    (c) => incoming.ui.columnWidths[c.id] !== c.defaultWidth
  ).length;
  const visibleToolbarGroupsCount = TOOLBAR_GROUP_DEFINITIONS.filter(
    (g) => incoming.ui.toolbarGroups[g.id]
  ).length;
  const hiddenToolbarGroupsCount =
    TOOLBAR_GROUP_DEFINITIONS.length - visibleToolbarGroupsCount;

  return {
    fileName: options?.fileName ?? DEFAULT_SETTINGS_EXPORT_FILENAME,
    schemaVersion: incoming.schemaVersion,
    migratedFromVersion: options?.migratedFromVersion ?? null,
    exportedAt: incoming.exportedAt,
    userPresetsCount: incoming.filters.userPresets.length,
    currentUserPresetsCount: current.filters.userPresets.length,
    activePresetId: incoming.filters.activePresetId,
    filterRulesCount,
    hostFilterTokensCount: compiledHl.activeCount,
    tlsBypassRulesCount,
    tlsTargetRulesCount,
    headerMutationsCount,
    autoResponderRulesCount,
    autoResponderEnabled: incoming.autoResponder.enabled,
    totalRulesCount,
    currentTotalRulesCount,
    totalColumnsCount: TRAFFIC_COLUMNS.length,
    visibleColumnsCount,
    customizedColumnWidthsCount,
    visibleToolbarGroupsCount,
    hiddenToolbarGroupsCount,
    compactToolbar: incoming.ui.compactToolbar,
    theme: incoming.ui.theme,
    inspectorPosition: incoming.ui.inspectorPosition,
    proxyPort: incoming.proxy.port,
    tlsInterceptMode: incoming.proxy.tlsInterceptMode,
    warnings: options?.warnings ?? [],
  };
}

export function buildBackendFilterConfigFromProfile(
  profile: FluxUserSettingsProfile
): ProxyFilterBackendConfig {
  const hostFilter = profile.filters.hostFilters;
  const compiledHl = compileHostListFilter(hostFilter);
  const th = profile.filters.noiseThresholds;
  const dropNonMatching = Boolean(profile.proxy.dropNonMatching ?? false);

  return {
    tlsInterceptMode: profile.proxy.tlsInterceptMode,
    tlsBypassEnabled: profile.proxy.tlsBypassEnabled ?? true,
    tlsBypassRules: structuredClone(profile.proxy.tlsBypassRules),
    tlsTargetRules: structuredClone(profile.proxy.tlsTargetRules),
    headerMutationsEnabled: profile.proxy.headerMutationsEnabled ?? true,
    headerMutations: structuredClone(profile.proxy.headerMutations),
    stripAltSvc: profile.proxy.stripAltSvc ?? true,
    hostListSync: {
      enabled: Boolean(
        hostFilter.enabled &&
          hostFilter.applyToTlsPassthrough &&
          compiledHl.activeCount > 0
      ),
      mode: hostFilter.mode,
      rawText: hostFilter.rawText,
    },
    dropNonMatchingOnCapture: dropNonMatching,
    captureHostList: {
      enabled: Boolean(hostFilter.enabled && compiledHl.activeCount > 0),
      mode: hostFilter.mode,
      rawText: hostFilter.rawText,
    },
    noiseThresholds: {
      hide304NotModified: th.hide304NotModified,
      hideOptionsPreflight: th.hideOptionsPreflight,
      hideConnectTunnels: th.hideConnectTunnels,
      hideStaticAssets: th.hideStaticAssets,
      minBodySizeBytes: th.minBodySizeBytes,
      maxBodySizeBytes: th.maxBodySizeBytes,
      timeHeatWarningMs: th.timeHeatWarningMs,
      onlySlowRequests: th.onlySlowRequests,
    },
    captureMatrixEnabled: profile.filters.matrixEnabled ?? true,
    captureFilterRules: structuredClone(profile.filters.filterRules ?? []),
    quickCategory: "all",
    filterQuery: "",
    useRegexQuery: false,
  };
}

function atomicWriteProfileToLocalStorage(
  profile: FluxUserSettingsProfile,
  backendConfig: ProxyFilterBackendConfig
): void {
  if (typeof window === "undefined") return;

  const nextEntries: [string, string][] = [
    [SETTINGS_STORAGE_KEYS.theme, profile.ui.theme],
    [
      SETTINGS_STORAGE_KEYS.uiLayout,
      JSON.stringify({
        compactToolbar: profile.ui.compactToolbar,
        sidebarCollapsed: profile.ui.sidebarCollapsed,
        inspectorCollapsed: profile.ui.inspectorCollapsed,
        inspectorPosition: profile.ui.inspectorPosition,
      }),
    ],
    [
      SETTINGS_STORAGE_KEYS.toolbarGroups,
      JSON.stringify(profile.ui.toolbarGroups),
    ],
    [
      SETTINGS_STORAGE_KEYS.visibleColumns,
      JSON.stringify(profile.ui.visibleColumns),
    ],
    [
      SETTINGS_STORAGE_KEYS.columnWidths,
      JSON.stringify(profile.ui.columnWidths),
    ],
    [SETTINGS_STORAGE_KEYS.followTail, JSON.stringify(profile.ui.followTail)],
    [
      SETTINGS_STORAGE_KEYS.customPresets,
      JSON.stringify(profile.filters.userPresets),
    ],
    [
      SETTINGS_STORAGE_KEYS.activeFilterState,
      JSON.stringify({
        matrixEnabled: profile.filters.matrixEnabled ?? true,
        rules: profile.filters.filterRules ?? [],
        thresholds: profile.filters.noiseThresholds,
        activePresetId: profile.filters.activePresetId,
        hostListFilter: profile.filters.hostFilters,
      }),
    ],
    [SETTINGS_STORAGE_KEYS.backendFilterConfig, JSON.stringify(backendConfig)],
    [
      SETTINGS_STORAGE_KEYS.autoSystemProxy,
      JSON.stringify(profile.proxy.autoSystemProxy),
    ],
    [
      SETTINGS_STORAGE_KEYS.allowRemote,
      JSON.stringify(profile.proxy.allowRemote),
    ],
    [SETTINGS_STORAGE_KEYS.proxyPort, JSON.stringify(profile.proxy.port)],
    [
      SETTINGS_STORAGE_KEYS.autoResponder,
      JSON.stringify({
        enabled: profile.autoResponder.enabled,
        rules: profile.autoResponder.rules,
      }),
    ],
    [
      SETTINGS_STORAGE_KEYS.sessionRetentionLimit,
      JSON.stringify(
        profile.proxy.sessionRetentionLimit !== undefined
          ? profile.proxy.sessionRetentionLimit
          : DEFAULT_SESSION_RETENTION_LIMIT
      ),
    ],
    [
      SETTINGS_STORAGE_KEYS.dropNonMatching,
      JSON.stringify(Boolean(profile.proxy.dropNonMatching ?? false)),
    ],
  ];

  // Capture rollback snapshot for atomic recovery if quota is exceeded mid-batch
  const backup = new Map<string, string | null>();
  try {
    for (const [key] of nextEntries) {
      backup.set(key, window.localStorage.getItem(key));
    }
    for (const [key, value] of nextEntries) {
      window.localStorage.setItem(key, value);
    }
  } catch (err) {
    for (const [key, prevVal] of backup.entries()) {
      try {
        if (prevVal === null) {
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, prevVal);
        }
      } catch {
        // ignore rollback error
      }
    }
    throw new Error(
      `Не удалось атомарно сохранить профиль в localStorage: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Atomically persists a validated `FluxUserSettingsProfile` to `localStorage`,
 * synchronizes all active React hooks via `SETTINGS_APPLIED_EVENT`, and pushes
 * updated proxy filter, TLS, header mutation, listener, and AutoResponder rules
 * into Rust (`update_proxy_filter_config`).
 */
export async function applySettingsProfile(
  profile: FluxUserSettingsProfile
): Promise<FluxUserSettingsProfile> {
  const normalized = validateAndMigrateSettingsProfile(profile);
  const backendConfig = buildBackendFilterConfigFromProfile(normalized);

  // 1. Atomic localStorage write
  atomicWriteProfileToLocalStorage(normalized, backendConfig);

  // 2. Immediate synchronous React state broadcast across all hooks
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<FluxUserSettingsProfile>(SETTINGS_APPLIED_EVENT, {
        detail: normalized,
      })
    );
  }

  // 3. Synchronize proxy filter rules, AutoResponder, retention & listener config to Rust / Preview Engine
  const retentionLimit =
    normalized.proxy.sessionRetentionLimit !== undefined
      ? normalized.proxy.sessionRetentionLimit
      : DEFAULT_SESSION_RETENTION_LIMIT;
  const dropNonMatching = Boolean(normalized.proxy.dropNonMatching ?? false);

  await Promise.all([
    proxyBridge.updateProxyFilterConfig(backendConfig),
    proxyBridge.setAutoResponderConfig(
      normalized.autoResponder.enabled,
      normalized.autoResponder.rules
    ),
    proxyBridge.setSessionRetentionLimit(retentionLimit),
    proxyBridge.setDropNonMatching(dropNonMatching),
  ]);

  let latestStatus: ProxyStatus = await proxyBridge.getStatus();

  if (latestStatus.autoSystemProxy !== normalized.proxy.autoSystemProxy) {
    latestStatus = await proxyBridge.setAutoSystemProxy(
      normalized.proxy.autoSystemProxy
    );
    if (!normalized.proxy.autoSystemProxy && latestStatus.systemProxyEnabled) {
      latestStatus = await proxyBridge.setSystemProxy(false);
    }
  }

  const currentRemote = Boolean(
    latestStatus.allowRemote || latestStatus.bindAddr === "0.0.0.0"
  );
  if (currentRemote !== normalized.proxy.allowRemote) {
    latestStatus = await proxyBridge.setAllowRemote(
      normalized.proxy.allowRemote
    );
  }

  if (latestStatus.port !== normalized.proxy.port) {
    const desiredHost = normalized.proxy.allowRemote ? "0.0.0.0" : "127.0.0.1";
    if (latestStatus.running) {
      await proxyBridge.stopProxy();
      latestStatus = await proxyBridge.startProxy(
        desiredHost,
        normalized.proxy.port
      );
    } else {
      latestStatus = proxyBridge.setPreviewPort(normalized.proxy.port);
      latestStatus = {
        ...latestStatus,
        port: normalized.proxy.port,
      };
    }
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<ProxyStatus>(PROXY_STATUS_SYNCED_EVENT, {
        detail: latestStatus,
      })
    );
  }

  return normalized;
}

/**
 * Resets all user settings, UI layout, column widths, toolbar groups, custom presets,
 * proxy filter rules, and AutoResponder rules back to factory defaults with confirmation.
 */
export async function resetAllSettingsToDefault(options?: {
  skipConfirm?: boolean;
}): Promise<boolean> {
  if (!options?.skipConfirm && typeof window !== "undefined") {
    const confirmed = window.confirm(
      "Сбросить все настройки FluxProxy к заводским значениям по умолчанию? Пользовательские пресеты, правила фильтрации, AutoResponder и ширина колонок будут перезаписаны."
    );
    if (!confirmed) {
      return false;
    }
  }

  const defaults = createDefaultSettingsProfile();
  await applySettingsProfile(defaults);
  return true;
}
