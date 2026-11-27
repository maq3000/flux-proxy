import {
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_LAYOUT_PREFS,
  DEFAULT_TOOLBAR_GROUPS,
  DEFAULT_VISIBLE_COLUMNS,
  type InspectorSplitDirection,
} from "../../hooks/useUiPreferences";
import {
  CUSTOM_COLOR_OVERRIDES_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_PRESET_STORAGE_KEY,
  type ThemePreference,
} from "../../hooks/useTheme";
import {
  BUILT_IN_FILTER_PRESETS,
  DEFAULT_BACKEND_FILTER_CONFIG,
  DEFAULT_HOST_LIST_FILTER_CONFIG,
  DEFAULT_NOISE_THRESHOLDS,
  normalizeNoiseThresholds,
} from "../filterEngine";
import {
  DEFAULT_AUTORESPONDER_RULES,
  DEFAULT_CLEAR_DB_ON_EXIT,
  DEFAULT_HOST_REMAP_RULES,
  DEFAULT_PYTHON_SCRIPT_CODE,
  PREVIEW_CLEAR_DB_ON_EXIT_STORAGE_KEY,
  PREVIEW_PYTHON_SCRIPT_STORAGE_KEY,
  PREVIEW_SANITIZATION_OPTIONS_STORAGE_KEY,
} from "../appDefaults";
import {
  DEFAULT_BREAKPOINT_CONFIG,
  DEFAULT_MASK_JSON_KEYS,
  DEFAULT_SANITIZATION_OPTIONS,
  DEFAULT_SANITIZATION_REPLACEMENT,
  DEFAULT_SESSION_RETENTION_LIMIT,
  DEFAULT_STRIP_QUERY_PARAMS,
  DEFAULT_THROTTLE_CONFIG,
  DEFAULT_UPSTREAM_PROXY_BYPASS_LIST,
  DEFAULT_UPSTREAM_PROXY_CONFIG,
  DEFAULT_UPSTREAM_TIMEOUT_CONFIG,
  THROTTLE_PRESET_DEFINITIONS,
  UPSTREAM_TIMEOUT_LIMITS,
} from "../../types/proxy";
import type {
  AutoResponderRule,
  BindHostMode,
  BreakpointConfig,
  BreakpointRule,
  BreakpointStage,
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
  HostRemapRule,
  InspectorDockPosition,
  NoiseThresholdsConfig,
  RuleActionType,
  RuleMatchTarget,
  SanitizationOptions,
  ThrottleConfig,
  ThrottlePreset,
  TlsBypassRule,
  TlsInterceptMode,
  UpstreamProxyProtocol,
  UpstreamTimeoutConfig,
} from "../../types/proxy";
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  PROXY_STATUS_SYNCED_EVENT,
  SETTINGS_APPLIED_EVENT,
  type ApplySettingsProfileOptions,
  type FluxUserScriptingSettings,
  type FluxUserSettingsProfile,
  type FluxUserUpstreamProxySettings,
} from "../../types/settings";

export { PROXY_STATUS_SYNCED_EVENT, SETTINGS_APPLIED_EVENT };
export type { ApplySettingsProfileOptions };

export const SETTINGS_STORAGE_KEYS = {
  theme: THEME_PREFERENCE_STORAGE_KEY,
  themePreset: THEME_PRESET_STORAGE_KEY,
  customColorOverrides: CUSTOM_COLOR_OVERRIDES_STORAGE_KEY,
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
  bindMode: "fluxproxy.bindMode.v1",
  specificBindIp: "fluxproxy.specificBindIp.v1",
  alsoBindLoopback: "fluxproxy.alsoBindLoopback.v1",
  proxyPort: "fluxproxy.proxyPort.v1",
  autoResponder: "fluxproxy.autoResponder.v1",
  breakpointConfig: "fluxproxy.breakpointConfig.v1",
  sessionRetentionLimit: "fluxproxy.sessionRetentionLimit.v1",
  dropNonMatching: "fluxproxy.dropNonMatching.v1",
  clearDbOnExit: PREVIEW_CLEAR_DB_ON_EXIT_STORAGE_KEY,
  sanitizationOptions: PREVIEW_SANITIZATION_OPTIONS_STORAGE_KEY,
  pythonScript: PREVIEW_PYTHON_SCRIPT_STORAGE_KEY,
  hostRemapRules: "fluxproxy-host-remap-rules-v1",
  throttleConfig: "fluxproxy-throttle-config-v1",
  upstreamProxyConfig: "fluxproxy-upstream-proxy-config-v1",
  upstreamTimeouts: "fluxproxy-upstream-timeouts-v1",
} as const;

export const VALID_THEMES = new Set<ThemePreference>(["dark", "light", "system"]);
export const VALID_DOCK_POSITIONS = new Set<InspectorDockPosition>(["bottom", "right"]);
export const VALID_SPLIT_DIRECTIONS = new Set<InspectorSplitDirection>([
  "auto",
  "horizontal",
  "vertical",
]);
export const VALID_BIND_MODES = new Set<BindHostMode>(["loopback", "all", "specific"]);
export const VALID_TLS_MODES = new Set<TlsInterceptMode>([
  "interceptAll",
  "targetedOnly",
]);
export const VALID_HOST_FILTER_MODES = new Set<HostListFilterMode>([
  "whitelist",
  "blacklist",
]);
export const VALID_FILTER_ACTIONS = new Set<FilterRuleAction>(["include", "exclude"]);
export const VALID_LOGICAL_OPS = new Set<FilterLogicalOp>(["AND", "OR"]);
export const VALID_FILTER_FIELDS = new Set<FilterField>([
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
export const VALID_FILTER_OPERATORS = new Set<FilterOperator>([
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
export const VALID_HEADER_DIRECTIONS = new Set<HeaderMutationDirection>([
  "request",
  "response",
]);
export const VALID_HEADER_OPS = new Set<HeaderMutationOp>(["set", "remove", "append"]);
export const VALID_RULE_TARGETS = new Set<RuleMatchTarget>([
  "urlContains",
  "urlRegex",
  "headerMatch",
]);
export const VALID_RULE_ACTIONS = new Set<RuleActionType>([
  "mockResponse",
  "overrideStatus",
  "delayOnly",
]);
export const VALID_BREAKPOINT_STAGES = new Set<BreakpointStage>([
  "request",
  "response",
  "both",
]);

export const RECOGNIZED_PROFILE_TOP_KEYS = new Set<string>([
  "schemaVersion",
  "exportedAt",
  "ui",
  "filters",
  "proxy",
  "autoResponder",
  "breakpoints",
  "breakpointConfig",
  "scripting",
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
  "clearDbOnExit",
  "sanitizationOptions",
]);

export function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export function readLocalStorageJson<T>(key: string, fallback: T): T {
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
      themePreset: "default-dark",
      customColorOverrides: {},
      compactToolbar: DEFAULT_LAYOUT_PREFS.compactToolbar,
      sidebarCollapsed: DEFAULT_LAYOUT_PREFS.sidebarCollapsed,
      inspectorCollapsed: DEFAULT_LAYOUT_PREFS.inspectorCollapsed,
      inspectorPosition: DEFAULT_LAYOUT_PREFS.inspectorPosition,
      inspectorSplitDirection: DEFAULT_LAYOUT_PREFS.inspectorSplitDirection,
      followTail: false,
      columnWidths: { ...DEFAULT_COLUMN_WIDTHS },
      visibleColumns: { ...DEFAULT_VISIBLE_COLUMNS },
      toolbarGroups: { ...DEFAULT_TOOLBAR_GROUPS },
      panelLayouts: {},
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
      bindMode: "loopback",
      specificBindIp: null,
      alsoBindLoopback: true,
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
      clearDbOnExit: DEFAULT_CLEAR_DB_ON_EXIT,
      sanitizationOptions: structuredClone(DEFAULT_SANITIZATION_OPTIONS),
      hostRemapRules: structuredClone(DEFAULT_HOST_REMAP_RULES),
      throttleConfig: { ...DEFAULT_THROTTLE_CONFIG },
      upstreamProxy: {
        enabled: false,
        protocol: "http",
        host: "",
        port: 8080,
        username: null,
        bypassList: [...DEFAULT_UPSTREAM_PROXY_BYPASS_LIST],
      },
      upstreamTimeouts: { ...DEFAULT_UPSTREAM_TIMEOUT_CONFIG },
      lanClientAllowlist: [],
    },
    autoResponder: {
      enabled: true,
      rules: structuredClone(DEFAULT_AUTORESPONDER_RULES),
    },
    breakpoints: structuredClone(DEFAULT_BREAKPOINT_CONFIG),
    scripting: {
      enabled: false,
      code: DEFAULT_PYTHON_SCRIPT_CODE,
      activePresetId: "hmac-header-injection",
    },
  };
}

// ============================================================================
// Granular Sanitizers with Safe Defaults
// ============================================================================
export function sanitizeBoolean(
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

export function sanitizeNullablePositiveInt(
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

export function sanitizePositiveInt(
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

export function sanitizeNoiseThresholds(
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
  const hasExplicitAssetFlag =
    raw.hideCss !== undefined ||
    raw.hideImages !== undefined ||
    raw.hideFonts !== undefined ||
    raw.hideJs !== undefined;
  const legacyStaticAssets = sanitizeBoolean(
    raw.hideStaticAssets,
    false,
    `${fieldPrefix}.hideStaticAssets`,
    warnings
  );

  return normalizeNoiseThresholds({
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
    ...(hasExplicitAssetFlag
      ? {
          hideCss: sanitizeBoolean(
            raw.hideCss,
            false,
            `${fieldPrefix}.hideCss`,
            warnings
          ),
          hideImages: sanitizeBoolean(
            raw.hideImages,
            false,
            `${fieldPrefix}.hideImages`,
            warnings
          ),
          hideFonts: sanitizeBoolean(
            raw.hideFonts,
            false,
            `${fieldPrefix}.hideFonts`,
            warnings
          ),
          hideJs: sanitizeBoolean(
            raw.hideJs,
            false,
            `${fieldPrefix}.hideJs`,
            warnings
          ),
        }
      : { hideStaticAssets: legacyStaticAssets }),
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
  });
}

export function sanitizeHostListFilter(
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

export function sanitizeFilterConditionRule(
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

export function sanitizeFilterPreset(
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

export function sanitizeTlsRuleList(
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

const VALID_THROTTLE_PRESETS = new Set<ThrottlePreset>([
  "none",
  "gprs",
  "slow3g",
  "fast3g",
  "lte",
  "offline",
  "custom",
]);

function normalizeThrottlePresetValue(raw: unknown): ThrottlePreset | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase() as ThrottlePreset;
  return VALID_THROTTLE_PRESETS.has(trimmed) ? trimmed : null;
}

export function sanitizeHostRemapRules(
  raw: unknown,
  fallback: HostRemapRule[],
  warnings: string[]
): HostRemapRule[] {
  if (raw === undefined) return structuredClone(fallback);
  if (!Array.isArray(raw)) {
    warnings.push(
      "Список «proxy.hostRemapRules» повреждён — восстановлены правила по умолчанию."
    );
    return structuredClone(fallback);
  }
  const out: HostRemapRule[] = [];
  raw.forEach((item, idx) => {
    if (
      !isPlainObject(item) ||
      typeof item.sourcePattern !== "string" ||
      typeof item.targetHost !== "string"
    ) {
      warnings.push(
        `Правило HOSTS «proxy.hostRemapRules[${idx}]» пропущено (отсутствует sourcePattern/targetHost).`
      );
      return;
    }
    const sourcePattern = item.sourcePattern.trim().toLowerCase();
    const targetHost = item.targetHost.trim().toLowerCase();
    if (!sourcePattern || sourcePattern === "*" || sourcePattern === "*." || !targetHost) {
      warnings.push(
        `Правило HOSTS «proxy.hostRemapRules[${idx}]» пропущено (некорректный шаблон/цель).`
      );
      return;
    }
    let targetPort: number | null = null;
    if (item.targetPort !== undefined && item.targetPort !== null) {
      const n = Number(item.targetPort);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) {
        targetPort = n;
      } else {
        warnings.push(
          `Порт в «proxy.hostRemapRules[${idx}].targetPort» некорректен — сброшен.`
        );
      }
    }
    out.push({
      id:
        typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : `remap-${idx + 1}`,
      enabled: typeof item.enabled === "boolean" ? item.enabled : true,
      sourcePattern,
      targetHost,
      targetPort,
      preserveHostHeader:
        typeof item.preserveHostHeader === "boolean"
          ? item.preserveHostHeader
          : true,
      comment: typeof item.comment === "string" ? item.comment.trim() : "",
    });
  });
  return out;
}

export function sanitizeThrottleConfig(
  raw: unknown,
  warnings: string[]
): ThrottleConfig {
  if (raw === undefined) return { ...DEFAULT_THROTTLE_CONFIG };
  if (!isPlainObject(raw)) {
    warnings.push(
      "Секция «proxy.throttleConfig» повреждена — сброшена на No Throttling."
    );
    return { ...DEFAULT_THROTTLE_CONFIG };
  }
  const preset = normalizeThrottlePresetValue(raw.preset);
  if (!preset) {
    warnings.push(
      "Поле «proxy.throttleConfig.preset» некорректно — установлено none."
    );
    return { ...DEFAULT_THROTTLE_CONFIG };
  }
  if (preset === "custom") {
    return {
      preset: "custom",
      downloadKbps: Math.max(0, Math.round(Number(raw.downloadKbps) || 0)),
      uploadKbps: Math.max(0, Math.round(Number(raw.uploadKbps) || 0)),
      latencyMs: Math.max(0, Math.round(Number(raw.latencyMs) || 0)),
    };
  }
  const def = THROTTLE_PRESET_DEFINITIONS.find((d) => d.id === preset);
  return def
    ? {
        preset: def.id,
        downloadKbps: def.downloadKbps,
        uploadKbps: def.uploadKbps,
        latencyMs: def.latencyMs,
      }
    : { ...DEFAULT_THROTTLE_CONFIG };
}

export function sanitizeUpstreamProxyConfig(
  raw: unknown,
  warnings: string[]
): FluxUserUpstreamProxySettings {
  const defaultOut: FluxUserUpstreamProxySettings = {
    enabled: DEFAULT_UPSTREAM_PROXY_CONFIG.enabled,
    protocol: DEFAULT_UPSTREAM_PROXY_CONFIG.protocol,
    host: DEFAULT_UPSTREAM_PROXY_CONFIG.host,
    port: DEFAULT_UPSTREAM_PROXY_CONFIG.port,
    username: null,
    bypassList: [...DEFAULT_UPSTREAM_PROXY_BYPASS_LIST],
  };
  if (raw === undefined) return defaultOut;
  if (!isPlainObject(raw)) {
    warnings.push(
      "Секция «proxy.upstreamProxy» повреждена — сброшена к настройкам по умолчанию."
    );
    return defaultOut;
  }

  if (typeof raw.password === "string" && raw.password.length > 0) {
    warnings.push(
      "Поле «proxy.upstreamProxy.password» удалено: пароли вышестоящего прокси не сохраняются и не импортируются в открытом виде из соображений безопасности."
    );
  }

  const rawProto =
    typeof raw.protocol === "string" ? raw.protocol.trim().toLowerCase() : "http";
  let protocol: UpstreamProxyProtocol = "http";
  if (rawProto === "http" || rawProto === "https" || rawProto === "socks5") {
    protocol = rawProto;
  } else if (raw.protocol !== undefined) {
    warnings.push(
      `Неизвестный протокол «proxy.upstreamProxy.protocol» (${String(raw.protocol)}) — использован HTTP.`
    );
  }

  const defaultPortForProto =
    protocol === "https" ? 8443 : protocol === "socks5" ? 1080 : 8080;

  let host = typeof raw.host === "string" ? raw.host.trim() : "";
  if (raw.host !== undefined && typeof raw.host !== "string") {
    warnings.push("Поле «proxy.upstreamProxy.host» имеет некорректный тип — сброшено.");
    host = "";
  }

  let enabled = typeof raw.enabled === "boolean" ? raw.enabled : false;
  if (enabled && !host) {
    warnings.push(
      "«proxy.upstreamProxy.enabled» отключён, так как не указан хост вышестоящего прокси."
    );
    enabled = false;
  }

  let port = defaultPortForProto;
  if (raw.port !== undefined) {
    const parsedPort = Number(raw.port);
    if (
      Number.isInteger(parsedPort) &&
      parsedPort >= 1 &&
      parsedPort <= 65535
    ) {
      port = parsedPort;
    } else {
      warnings.push(
        `Некорректный порт «proxy.upstreamProxy.port» (${String(raw.port)}) — использован ${defaultPortForProto}.`
      );
    }
  }

  const username =
    typeof raw.username === "string" && raw.username.trim().length > 0
      ? raw.username.trim()
      : null;

  let bypassList: string[] = [...DEFAULT_UPSTREAM_PROXY_BYPASS_LIST];
  if (raw.bypassList !== undefined) {
    const rawTokens = Array.isArray(raw.bypassList)
      ? raw.bypassList.filter((x): x is string => typeof x === "string")
      : typeof raw.bypassList === "string"
        ? raw.bypassList.split(/[\r\n,;]+/)
        : null;
    if (rawTokens === null) {
      warnings.push(
        "Поле «proxy.upstreamProxy.bypassList» повреждено — восстановлен список по умолчанию."
      );
    } else {
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const item of rawTokens) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        const lower = trimmed.toLowerCase();
        if (!seen.has(lower)) {
          seen.add(lower);
          cleaned.push(trimmed);
        }
      }
      bypassList = cleaned;
    }
  }

  return {
    enabled,
    protocol,
    host,
    port,
    username,
    bypassList,
  };
}

export function sanitizeUpstreamTimeoutConfig(
  raw: unknown,
  warnings: string[]
): UpstreamTimeoutConfig {
  const defaultOut: UpstreamTimeoutConfig = {
    ...DEFAULT_UPSTREAM_TIMEOUT_CONFIG,
  };
  if (raw === undefined || raw === null) {
    return defaultOut;
  }
  if (!isPlainObject(raw)) {
    warnings.push(
      "Секция «proxy.upstreamTimeouts» повреждена — сброшена к настройкам по умолчанию."
    );
    return defaultOut;
  }

  let connectTimeoutSec = defaultOut.connectTimeoutSec;
  if (raw.connectTimeoutSec !== undefined) {
    const n = Number(raw.connectTimeoutSec);
    if (
      typeof raw.connectTimeoutSec === "number" &&
      Number.isInteger(n) &&
      n >= UPSTREAM_TIMEOUT_LIMITS.connectMin &&
      n <= UPSTREAM_TIMEOUT_LIMITS.connectMax
    ) {
      connectTimeoutSec = n;
    } else if (
      typeof raw.connectTimeoutSec === "number" &&
      Number.isFinite(raw.connectTimeoutSec)
    ) {
      connectTimeoutSec = Math.min(
        UPSTREAM_TIMEOUT_LIMITS.connectMax,
        Math.max(
          UPSTREAM_TIMEOUT_LIMITS.connectMin,
          Math.round(raw.connectTimeoutSec)
        )
      );
      warnings.push(
        `Поле «proxy.upstreamTimeouts.connectTimeoutSec» (${String(raw.connectTimeoutSec)}) вне диапазона ${UPSTREAM_TIMEOUT_LIMITS.connectMin}..${UPSTREAM_TIMEOUT_LIMITS.connectMax} с — скорректировано до ${connectTimeoutSec} с.`
      );
    } else {
      warnings.push(
        `Поле «proxy.upstreamTimeouts.connectTimeoutSec» некорректно — использовано ${defaultOut.connectTimeoutSec} с.`
      );
    }
  }

  let responseHeaderTimeoutSec = defaultOut.responseHeaderTimeoutSec;
  if (raw.responseHeaderTimeoutSec !== undefined) {
    const n = Number(raw.responseHeaderTimeoutSec);
    if (
      typeof raw.responseHeaderTimeoutSec === "number" &&
      (n === 0 ||
        (Number.isInteger(n) &&
          n >= UPSTREAM_TIMEOUT_LIMITS.responseHeaderMin &&
          n <= UPSTREAM_TIMEOUT_LIMITS.responseHeaderMax))
    ) {
      responseHeaderTimeoutSec = n;
    } else if (
      typeof raw.responseHeaderTimeoutSec === "number" &&
      Number.isFinite(raw.responseHeaderTimeoutSec)
    ) {
      responseHeaderTimeoutSec = Math.min(
        UPSTREAM_TIMEOUT_LIMITS.responseHeaderMax,
        Math.max(
          UPSTREAM_TIMEOUT_LIMITS.responseHeaderMin,
          Math.round(raw.responseHeaderTimeoutSec)
        )
      );
      warnings.push(
        `Поле «proxy.upstreamTimeouts.responseHeaderTimeoutSec» (${String(raw.responseHeaderTimeoutSec)}) должно быть 0 или ${UPSTREAM_TIMEOUT_LIMITS.responseHeaderMin}..${UPSTREAM_TIMEOUT_LIMITS.responseHeaderMax} с — скорректировано до ${responseHeaderTimeoutSec} с.`
      );
    } else {
      warnings.push(
        "Поле «proxy.upstreamTimeouts.responseHeaderTimeoutSec» некорректно — сброшено к Unlimited (0)."
      );
    }
  }

  let composerTimeoutSec = defaultOut.composerTimeoutSec;
  if (raw.composerTimeoutSec !== undefined) {
    const n = Number(raw.composerTimeoutSec);
    if (
      typeof raw.composerTimeoutSec === "number" &&
      (n === 0 ||
        (Number.isInteger(n) &&
          n >= UPSTREAM_TIMEOUT_LIMITS.composerMin &&
          n <= UPSTREAM_TIMEOUT_LIMITS.composerMax))
    ) {
      composerTimeoutSec = n;
    } else if (
      typeof raw.composerTimeoutSec === "number" &&
      Number.isFinite(raw.composerTimeoutSec)
    ) {
      composerTimeoutSec = Math.min(
        UPSTREAM_TIMEOUT_LIMITS.composerMax,
        Math.max(
          UPSTREAM_TIMEOUT_LIMITS.composerMin,
          Math.round(raw.composerTimeoutSec)
        )
      );
      warnings.push(
        `Поле «proxy.upstreamTimeouts.composerTimeoutSec» (${String(raw.composerTimeoutSec)}) вне диапазона 0 или ${UPSTREAM_TIMEOUT_LIMITS.composerMin}..${UPSTREAM_TIMEOUT_LIMITS.composerMax} с — скорректировано до ${composerTimeoutSec} с.`
      );
    } else {
      warnings.push(
        `Поле «proxy.upstreamTimeouts.composerTimeoutSec» некорректно — использовано ${defaultOut.composerTimeoutSec} с.`
      );
    }
  }

  return {
    connectTimeoutSec,
    responseHeaderTimeoutSec,
    composerTimeoutSec,
  };
}

export function sanitizeLanClientAllowlist(
  raw: unknown,
  warnings: string[]
): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    warnings.push(
      "Поле «proxy.lanClientAllowlist» повреждено — сброшено к пустому списку."
    );
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  let hadNonString = false;
  for (const item of raw) {
    if (typeof item !== "string") {
      hadNonString = true;
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  if (hadNonString) {
    warnings.push(
      "Некорректные нестроковые записи в «proxy.lanClientAllowlist» пропущены."
    );
  }
  return out;
}

export function sanitizeHeaderMutations(
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

export function sanitizeAutoResponderRules(
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

export function sanitizeBreakpointConfig(
  raw: unknown,
  warnings: string[]
): BreakpointConfig {
  const def = DEFAULT_BREAKPOINT_CONFIG;
  if (raw === undefined) {
    return structuredClone(def);
  }
  if (!isPlainObject(raw)) {
    warnings.push(
      "Секция «breakpoints» повреждена — восстановлены настройки точек останова по умолчанию."
    );
    return structuredClone(def);
  }

  let rules: BreakpointRule[] = [];
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) {
      warnings.push(
        "Список «breakpoints.rules» повреждён — правила точек останова сброшены."
      );
    } else {
      raw.rules.forEach((item, idx) => {
        if (!isPlainObject(item) || typeof item.urlPattern !== "string") {
          warnings.push(
            `Правило точки останова «breakpoints.rules[${idx}]» пропущено (повреждён формат).`
          );
          return;
        }
        const cleanPattern = item.urlPattern.trim();
        if (!cleanPattern) return;

        let stage: BreakpointStage = "request";
        if (item.stage !== undefined) {
          if (
            typeof item.stage === "string" &&
            VALID_BREAKPOINT_STAGES.has(item.stage as BreakpointStage)
          ) {
            stage = item.stage as BreakpointStage;
          } else {
            warnings.push(
              `Недопустимый этап «breakpoints.rules[${idx}].stage» — установлен request.`
            );
          }
        }

        const methodFilter =
          typeof item.methodFilter === "string" && item.methodFilter.trim()
            ? item.methodFilter.trim().toUpperCase()
            : null;

        rules.push({
          id:
            typeof item.id === "string" && item.id.trim()
              ? item.id.trim()
              : `bp-imported-${idx + 1}`,
          enabled: typeof item.enabled === "boolean" ? item.enabled : true,
          name:
            typeof item.name === "string" && item.name.trim()
              ? item.name.trim()
              : `${stage === "response" ? "bpafter" : "bpu"} ${cleanPattern}`,
          stage,
          urlPattern: cleanPattern,
          methodFilter,
        });
      });
    }
  }

  return {
    breakBeforeRequest: sanitizeBoolean(
      raw.breakBeforeRequest,
      def.breakBeforeRequest,
      "breakpoints.breakBeforeRequest",
      warnings
    ),
    breakAfterResponse: sanitizeBoolean(
      raw.breakAfterResponse,
      def.breakAfterResponse,
      "breakpoints.breakAfterResponse",
      warnings
    ),
    timeoutSecs: sanitizePositiveInt(
      raw.timeoutSecs,
      def.timeoutSecs,
      5,
      600,
      "breakpoints.timeoutSecs",
      warnings
    ),
    rules,
  };
}

export function sanitizeScriptingSettings(
  raw: unknown,
  warnings: string[]
): FluxUserScriptingSettings {
  const def: FluxUserScriptingSettings = {
    enabled: false,
    code: DEFAULT_PYTHON_SCRIPT_CODE,
    activePresetId: "hmac-header-injection",
  };
  if (raw === undefined) {
    return { ...def };
  }
  if (!isPlainObject(raw)) {
    warnings.push(
      "Секция «scripting» повреждена — восстановлен скрипт по умолчанию."
    );
    return { ...def };
  }
  return {
    enabled: sanitizeBoolean(
      raw.enabled,
      def.enabled,
      "scripting.enabled",
      warnings
    ),
    code:
      typeof raw.code === "string"
        ? raw.code
        : (() => {
            warnings.push(
              "Поле «scripting.code» должно быть строкой — восстановлен шаблон по умолчанию."
            );
            return def.code;
          })(),
    activePresetId:
      raw.activePresetId === null
        ? null
        : typeof raw.activePresetId === "string" && raw.activePresetId.trim()
          ? raw.activePresetId.trim()
          : def.activePresetId,
  };
}

function sanitizeStringTokenArray(
  raw: unknown,
  fallback: readonly string[],
  fieldPath: string,
  warnings: string[]
): string[] {
  if (raw === undefined) return [...fallback];
  if (!Array.isArray(raw)) {
    warnings.push(`Поле «${fieldPath}» повреждено — применены значения по умолчанию.`);
    return [...fallback];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const clean = item.trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(clean);
    }
  }
  return out;
}

export function sanitizeSanitizationOptions(
  raw: unknown,
  warnings: string[] = []
): SanitizationOptions {
  if (raw === undefined) {
    return structuredClone(DEFAULT_SANITIZATION_OPTIONS);
  }
  if (!isPlainObject(raw)) {
    warnings.push(
      "Секция «proxy.sanitizationOptions» повреждена — восстановлены настройки санитизации по умолчанию."
    );
    return structuredClone(DEFAULT_SANITIZATION_OPTIONS);
  }
  const replacementText =
    typeof raw.replacementText === "string" && raw.replacementText.trim()
      ? raw.replacementText
      : DEFAULT_SANITIZATION_REPLACEMENT;
  return {
    redactAuthHeaders: sanitizeBoolean(
      raw.redactAuthHeaders,
      DEFAULT_SANITIZATION_OPTIONS.redactAuthHeaders,
      "proxy.sanitizationOptions.redactAuthHeaders",
      warnings
    ),
    customRedactedHeaders: sanitizeStringTokenArray(
      raw.customRedactedHeaders,
      DEFAULT_SANITIZATION_OPTIONS.customRedactedHeaders,
      "proxy.sanitizationOptions.customRedactedHeaders",
      warnings
    ),
    maskJsonKeys: sanitizeStringTokenArray(
      raw.maskJsonKeys,
      DEFAULT_MASK_JSON_KEYS,
      "proxy.sanitizationOptions.maskJsonKeys",
      warnings
    ),
    stripQueryParams: sanitizeStringTokenArray(
      raw.stripQueryParams,
      DEFAULT_STRIP_QUERY_PARAMS,
      "proxy.sanitizationOptions.stripQueryParams",
      warnings
    ),
    anonymizeClientInfo: sanitizeBoolean(
      raw.anonymizeClientInfo,
      DEFAULT_SANITIZATION_OPTIONS.anonymizeClientInfo,
      "proxy.sanitizationOptions.anonymizeClientInfo",
      warnings
    ),
    replacementText,
  };
}

export function loadPersistedSanitizationOptions(): SanitizationOptions {
  const raw = readLocalStorageJson<unknown>(
    SETTINGS_STORAGE_KEYS.sanitizationOptions,
    undefined
  );
  return sanitizeSanitizationOptions(raw);
}

export function savePersistedSanitizationOptions(
  opts: SanitizationOptions
): void {
  if (typeof window === "undefined") return;
  try {
    const clean = sanitizeSanitizationOptions(opts);
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEYS.sanitizationOptions,
      JSON.stringify(clean)
    );
  } catch {
    // ignore storage quota errors
  }
}

export { BUILT_IN_FILTER_PRESETS };
