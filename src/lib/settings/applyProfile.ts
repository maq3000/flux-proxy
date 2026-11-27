import {
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_TOOLBAR_GROUPS,
  DEFAULT_VISIBLE_COLUMNS,
  FLUX_PANEL_LAYOUT_RESET_EVENT,
  TOOLBAR_GROUP_DEFINITIONS,
  TRAFFIC_COLUMNS,
  clearPersistedPanelLayouts,
  readPersistedPanelLayouts,
  writePersistedPanelLayouts,
  type InspectorSplitDirection,
} from "../../hooks/useUiPreferences";
import type { ThemePreference } from "../../hooks/useTheme";
import {
  isThemePresetId,
  sanitizeCustomColorOverrides,
  type ThemePresetId,
} from "../themePresets";
import {
  compileHostListFilter,
  DEFAULT_HOST_LIST_FILTER_CONFIG,
  normalizeNoiseThresholds,
} from "../filterEngine";
import {
  DEFAULT_CLEAR_DB_ON_EXIT,
  DEFAULT_HOST_REMAP_RULES,
  DEFAULT_PYTHON_SCRIPT_CODE,
} from "../appDefaults";
import { proxyBridge } from "../tauriBridge";
import {
  DEFAULT_BREAKPOINT_CONFIG,
  DEFAULT_SANITIZATION_OPTIONS,
  DEFAULT_SESSION_RETENTION_LIMIT,
  DEFAULT_THROTTLE_CONFIG,
  DEFAULT_UPSTREAM_PROXY_BYPASS_LIST,
  DEFAULT_UPSTREAM_PROXY_CONFIG,
  DEFAULT_UPSTREAM_TIMEOUT_CONFIG,
} from "../../types/proxy";
import type {
  AutoResponderRule,
  BindHostMode,
  BreakpointConfig,
  ColumnId,
  FilterConditionRule,
  FilterPreset,
  HostListFilterConfig,
  HostRemapRule,
  NoiseThresholdsConfig,
  ProxyFilterBackendConfig,
  ProxyStatus,
  ThrottleConfig,
  ToolbarGroupId,
  UpstreamProxyConfig,
  UpstreamTimeoutConfig,
} from "../../types/proxy";
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  DEFAULT_SETTINGS_EXPORT_FILENAME,
  PROXY_STATUS_SYNCED_EVENT,
  SETTINGS_APPLIED_EVENT,
  type ApplySettingsProfileOptions,
  type FluxUserScriptingSettings,
  type FluxUserSettingsProfile,
  type FluxUserUpstreamProxySettings,
  type SettingsImportPreviewSummary,
} from "../../types/settings";
import {
  SETTINGS_STORAGE_KEYS,
  VALID_BIND_MODES,
  VALID_SPLIT_DIRECTIONS,
  createDefaultSettingsProfile,
  loadPersistedSanitizationOptions,
  readLocalStorageJson,
  sanitizeLanClientAllowlist,
  sanitizeUpstreamTimeoutConfig,
} from "./schema";
import { validateAndMigrateSettingsProfile } from "./migrations";

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

  const rawThemePreset =
    typeof window !== "undefined"
      ? window.localStorage.getItem(SETTINGS_STORAGE_KEYS.themePreset)
      : null;
  const storedThemePreset: ThemePresetId = isThemePresetId(rawThemePreset)
    ? rawThemePreset
    : storedTheme === "light"
      ? "default-light"
      : "default-dark";

  const storedCustomColorOverrides = sanitizeCustomColorOverrides(
    readLocalStorageJson<unknown>(SETTINGS_STORAGE_KEYS.customColorOverrides, {})
  );

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
  const hasStoredBindMode =
    typeof window !== "undefined" &&
    window.localStorage.getItem(SETTINGS_STORAGE_KEYS.bindMode) !== null;
  const storedBindMode = readLocalStorageJson<BindHostMode | null>(
    SETTINGS_STORAGE_KEYS.bindMode,
    null
  );
  const storedSpecificBindIp = readLocalStorageJson<string | null>(
    SETTINGS_STORAGE_KEYS.specificBindIp,
    null
  );
  const storedAlsoBindLoopback = readLocalStorageJson<boolean>(
    SETTINGS_STORAGE_KEYS.alsoBindLoopback,
    true
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
  const storedClearDbOnExit = readLocalStorageJson<boolean>(
    SETTINGS_STORAGE_KEYS.clearDbOnExit,
    Boolean(defaults.proxy.clearDbOnExit ?? DEFAULT_CLEAR_DB_ON_EXIT)
  );
  const storedSanitizationOptions = loadPersistedSanitizationOptions();
  const storedAutoResponder = readLocalStorageJson<{
    enabled?: boolean;
    rules?: AutoResponderRule[];
  }>(SETTINGS_STORAGE_KEYS.autoResponder, {
    enabled: defaults.autoResponder.enabled,
    rules: defaults.autoResponder.rules,
  });
  const storedBreakpoints = readLocalStorageJson<Partial<BreakpointConfig>>(
    SETTINGS_STORAGE_KEYS.breakpointConfig,
    structuredClone(DEFAULT_BREAKPOINT_CONFIG)
  );
  const storedHostRemapRules = readLocalStorageJson<HostRemapRule[]>(
    SETTINGS_STORAGE_KEYS.hostRemapRules,
    structuredClone(DEFAULT_HOST_REMAP_RULES)
  );
  const storedThrottleConfig = readLocalStorageJson<ThrottleConfig>(
    SETTINGS_STORAGE_KEYS.throttleConfig,
    { ...DEFAULT_THROTTLE_CONFIG }
  );
  const storedUpstreamProxyRaw = readLocalStorageJson<unknown>(
    SETTINGS_STORAGE_KEYS.upstreamProxyConfig,
    defaults.proxy.upstreamProxy
  );
  const storedUpstreamTimeoutsRaw = readLocalStorageJson<unknown>(
    SETTINGS_STORAGE_KEYS.upstreamTimeouts,
    defaults.proxy.upstreamTimeouts
  );
  const storedScripting = readLocalStorageJson<Partial<FluxUserScriptingSettings>>(
    SETTINGS_STORAGE_KEYS.pythonScript,
    defaults.scripting ?? {
      enabled: false,
      code: DEFAULT_PYTHON_SCRIPT_CODE,
      activePresetId: "hmac-header-injection",
    }
  );

  const live = liveSnapshotGetter ? liveSnapshotGetter() : {};

  const effectiveAllowRemote = live.proxy?.allowRemote ?? storedAllowRemote;
  const rawSpecificBindIp =
    live.proxy?.specificBindIp !== undefined
      ? live.proxy.specificBindIp
      : storedSpecificBindIp;
  const resolvedSpecificBindIp =
    typeof rawSpecificBindIp === "string" && rawSpecificBindIp.trim().length > 0
      ? rawSpecificBindIp.trim()
      : null;
  const candidateBindMode: BindHostMode =
    live.proxy?.bindMode ??
    (hasStoredBindMode && storedBindMode && VALID_BIND_MODES.has(storedBindMode)
      ? storedBindMode
      : effectiveAllowRemote
        ? "all"
        : "loopback");
  const resolvedBindMode: BindHostMode =
    candidateBindMode === "specific" && !resolvedSpecificBindIp
      ? effectiveAllowRemote
        ? "all"
        : "loopback"
      : candidateBindMode;
  const resolvedAlsoBindLoopback =
    live.proxy?.alsoBindLoopback ?? storedAlsoBindLoopback;
  const resolvedAllowRemote =
    resolvedBindMode === "all"
      ? true
      : resolvedBindMode === "specific" && resolvedSpecificBindIp
        ? resolvedSpecificBindIp !== "127.0.0.1" &&
          resolvedSpecificBindIp !== "::1"
        : false;

  const mergedCandidate: FluxUserSettingsProfile = {
    schemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    ui: {
      theme: live.ui?.theme ?? storedTheme,
      themePreset: live.ui?.themePreset ?? storedThemePreset,
      customColorOverrides:
        live.ui?.customColorOverrides ?? storedCustomColorOverrides,
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
      inspectorSplitDirection:
        live.ui?.inspectorSplitDirection ??
        (typeof storedLayout.inspectorSplitDirection === "string" &&
        VALID_SPLIT_DIRECTIONS.has(
          storedLayout.inspectorSplitDirection as InspectorSplitDirection
        )
          ? (storedLayout.inspectorSplitDirection as InspectorSplitDirection)
          : defaults.ui.inspectorSplitDirection),
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
      panelLayouts: live.ui?.panelLayouts ?? readPersistedPanelLayouts(),
    },
    filters: {
      activePresetId:
        live.filters !== undefined
          ? live.filters.activePresetId
          : (storedActiveFilter.activePresetId ?? null),
      userPresets: structuredClone(
        live.filters?.userPresets ?? storedCustomPresets
      ),
      noiseThresholds: live.filters?.noiseThresholds
        ? normalizeNoiseThresholds(live.filters.noiseThresholds)
        : normalizeNoiseThresholds(storedActiveFilter.thresholds),
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
      allowRemote: resolvedAllowRemote,
      bindMode: resolvedBindMode,
      specificBindIp: resolvedSpecificBindIp,
      alsoBindLoopback: resolvedAlsoBindLoopback,
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
      clearDbOnExit:
        live.proxy?.clearDbOnExit ??
        live.ui?.clearDbOnExit ??
        storedClearDbOnExit,
      sanitizationOptions: structuredClone(
        live.proxy?.sanitizationOptions ?? storedSanitizationOptions
      ),
      hostRemapRules: structuredClone(
        live.proxy?.hostRemapRules ?? storedHostRemapRules
      ),
      throttleConfig: structuredClone(
        live.proxy?.throttleConfig ?? storedThrottleConfig
      ),
      upstreamProxy: (() => {
        const candidate = (live.proxy?.upstreamProxy ??
          storedUpstreamProxyRaw) as Partial<UpstreamProxyConfig> | undefined;
        if (!candidate || typeof candidate !== "object") {
          return structuredClone(defaults.proxy.upstreamProxy);
        }
        // Security: never propagate password / hasPassword into exported profile JSON.
        return {
          enabled: Boolean(candidate.enabled),
          protocol:
            candidate.protocol === "https" || candidate.protocol === "socks5"
              ? candidate.protocol
              : "http",
          host: typeof candidate.host === "string" ? candidate.host : "",
          port:
            typeof candidate.port === "number"
              ? candidate.port
              : DEFAULT_UPSTREAM_PROXY_CONFIG.port,
          username:
            typeof candidate.username === "string" ? candidate.username : null,
          bypassList: Array.isArray(candidate.bypassList)
            ? candidate.bypassList.filter(
                (item): item is string => typeof item === "string"
              )
            : [...DEFAULT_UPSTREAM_PROXY_BYPASS_LIST],
        };
      })(),
      upstreamTimeouts: sanitizeUpstreamTimeoutConfig(
        live.proxy?.upstreamTimeouts ?? storedUpstreamTimeoutsRaw,
        []
      ),
      lanClientAllowlist: sanitizeLanClientAllowlist(
        live.proxy?.lanClientAllowlist ?? storedBackendCfg.lanClientAllowlist,
        []
      ),
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
    breakpoints: structuredClone({
      ...DEFAULT_BREAKPOINT_CONFIG,
      ...storedBreakpoints,
      ...(live.breakpoints ?? {}),
    }),
    scripting: {
      enabled:
        live.scripting?.enabled ??
        Boolean(storedScripting.enabled ?? defaults.scripting?.enabled),
      code:
        typeof live.scripting?.code === "string"
          ? live.scripting.code
          : typeof storedScripting.code === "string"
            ? storedScripting.code
            : DEFAULT_PYTHON_SCRIPT_CODE,
      activePresetId:
        live.scripting?.activePresetId !== undefined
          ? live.scripting.activePresetId
          : (storedScripting.activePresetId ?? "hmac-header-injection"),
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

  const rawScriptCode = incoming.scripting?.code ?? "";
  const hasPythonScript = rawScriptCode.trim().length > 0;
  const pythonScriptEnabledInProfile = Boolean(
    incoming.scripting?.enabled ?? false
  );
  const pythonScriptLineCount = hasPythonScript
    ? rawScriptCode.replace(/(?:\r?\n)+$/, "").split(/\r?\n/).length
    : 0;

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
    hostRemapCount: incoming.proxy.hostRemapRules?.length ?? 0,
    throttlePreset: incoming.proxy.throttleConfig?.preset ?? "none",
    upstreamProxySummary:
      incoming.proxy.upstreamProxy?.enabled && incoming.proxy.upstreamProxy.host
        ? `${incoming.proxy.upstreamProxy.protocol.toUpperCase()} ${incoming.proxy.upstreamProxy.host}:${incoming.proxy.upstreamProxy.port}`
        : null,
    upstreamTimeoutsSummary: (() => {
      const t =
        incoming.proxy.upstreamTimeouts ?? DEFAULT_UPSTREAM_TIMEOUT_CONFIG;
      const ttfb =
        t.responseHeaderTimeoutSec === 0
          ? "Unlimited"
          : `${t.responseHeaderTimeoutSec}s`;
      const cmp =
        t.composerTimeoutSec === 0 ? "Unlimited" : `${t.composerTimeoutSec}s`;
      return `Connect ${t.connectTimeoutSec}s / TTFB ${ttfb} / Composer ${cmp}`;
    })(),
    lanClientAllowlistCount: (incoming.proxy.lanClientAllowlist ?? []).length,
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
    themePreset: incoming.ui.themePreset,
    customColorOverridesCount: Object.keys(
      incoming.ui.customColorOverrides ?? {}
    ).length,
    inspectorPosition: incoming.ui.inspectorPosition,
    inspectorSplitDirection: incoming.ui.inspectorSplitDirection,
    proxyPort: incoming.proxy.port,
    tlsInterceptMode: incoming.proxy.tlsInterceptMode,
    hasPythonScript,
    pythonScriptEnabledInProfile,
    pythonScriptLineCount,
    warnings: options?.warnings ?? [],
  };
}

export function buildBackendFilterConfigFromProfile(
  profile: FluxUserSettingsProfile
): ProxyFilterBackendConfig {
  const hostFilter = profile.filters.hostFilters;
  const compiledHl = compileHostListFilter(hostFilter);
  const th = normalizeNoiseThresholds(profile.filters.noiseThresholds);
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
      hideCss: th.hideCss,
      hideImages: th.hideImages,
      hideFonts: th.hideFonts,
      hideJs: th.hideJs,
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
    lanClientAllowlist: structuredClone(
      profile.proxy.lanClientAllowlist ?? []
    ),
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
      SETTINGS_STORAGE_KEYS.themePreset,
      profile.ui.themePreset ??
        (profile.ui.theme === "light" ? "default-light" : "default-dark"),
    ],
    [
      SETTINGS_STORAGE_KEYS.customColorOverrides,
      JSON.stringify(profile.ui.customColorOverrides ?? {}),
    ],
    [
      SETTINGS_STORAGE_KEYS.uiLayout,
      JSON.stringify({
        compactToolbar: profile.ui.compactToolbar,
        sidebarCollapsed: profile.ui.sidebarCollapsed,
        inspectorCollapsed: profile.ui.inspectorCollapsed,
        inspectorPosition: profile.ui.inspectorPosition,
        inspectorSplitDirection: profile.ui.inspectorSplitDirection,
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
    [
      SETTINGS_STORAGE_KEYS.bindMode,
      JSON.stringify(
        profile.proxy.bindMode ??
          (profile.proxy.allowRemote ? "all" : "loopback")
      ),
    ],
    [
      SETTINGS_STORAGE_KEYS.specificBindIp,
      JSON.stringify(profile.proxy.specificBindIp ?? null),
    ],
    [
      SETTINGS_STORAGE_KEYS.alsoBindLoopback,
      JSON.stringify(profile.proxy.alsoBindLoopback ?? true),
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
      SETTINGS_STORAGE_KEYS.breakpointConfig,
      JSON.stringify(
        profile.breakpoints ?? structuredClone(DEFAULT_BREAKPOINT_CONFIG)
      ),
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
    [
      SETTINGS_STORAGE_KEYS.clearDbOnExit,
      JSON.stringify(Boolean(profile.proxy.clearDbOnExit ?? false)),
    ],
    [
      SETTINGS_STORAGE_KEYS.sanitizationOptions,
      JSON.stringify(
        profile.proxy.sanitizationOptions ?? DEFAULT_SANITIZATION_OPTIONS
      ),
    ],
    [
      SETTINGS_STORAGE_KEYS.pythonScript,
      JSON.stringify(
        profile.scripting ?? {
          enabled: false,
          code: DEFAULT_PYTHON_SCRIPT_CODE,
          activePresetId: "hmac-header-injection",
        }
      ),
    ],
    [
      SETTINGS_STORAGE_KEYS.hostRemapRules,
      JSON.stringify(profile.proxy.hostRemapRules ?? DEFAULT_HOST_REMAP_RULES),
    ],
    [
      SETTINGS_STORAGE_KEYS.throttleConfig,
      JSON.stringify(profile.proxy.throttleConfig ?? DEFAULT_THROTTLE_CONFIG),
    ],
    [
      SETTINGS_STORAGE_KEYS.upstreamProxyConfig,
      JSON.stringify(
        profile.proxy.upstreamProxy
          ? {
              enabled: profile.proxy.upstreamProxy.enabled,
              protocol: profile.proxy.upstreamProxy.protocol,
              host: profile.proxy.upstreamProxy.host,
              port: profile.proxy.upstreamProxy.port,
              username: profile.proxy.upstreamProxy.username ?? null,
              bypassList: profile.proxy.upstreamProxy.bypassList,
            }
          : {
              enabled: false,
              protocol: "http",
              host: "",
              port: 8080,
              username: null,
              bypassList: [...DEFAULT_UPSTREAM_PROXY_BYPASS_LIST],
            }
      ),
    ],
    [
      SETTINGS_STORAGE_KEYS.upstreamTimeouts,
      JSON.stringify(
        profile.proxy.upstreamTimeouts ?? DEFAULT_UPSTREAM_TIMEOUT_CONFIG
      ),
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
    writePersistedPanelLayouts(profile.ui.panelLayouts);
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
 * Validates a `FluxUserSettingsProfile`, applies all backend IPC updates transactionally
 * (rolling back any partial backend changes on failure BEFORE touching `localStorage`
 * or dispatching `SETTINGS_APPLIED_EVENT`), atomically writes `localStorage`, and broadcasts
 * synchronized React hook state.
 */
export async function applySettingsProfile(
  profile: FluxUserSettingsProfile,
  options?: ApplySettingsProfileOptions
): Promise<FluxUserSettingsProfile> {
  const normalized = validateAndMigrateSettingsProfile(profile);
  const backendConfig = buildBackendFilterConfigFromProfile(normalized);
  const nextBreakpoints: BreakpointConfig = structuredClone(
    normalized.breakpoints ?? DEFAULT_BREAKPOINT_CONFIG
  );
  const trustImportedPythonScript = Boolean(
    options?.trustImportedPythonScript
  );
  const effectiveScriptEnabled = trustImportedPythonScript
    ? Boolean(normalized.scripting?.enabled ?? false)
    : false;
  const nextScripting: FluxUserScriptingSettings = {
    enabled: effectiveScriptEnabled,
    code: normalized.scripting?.code ?? DEFAULT_PYTHON_SCRIPT_CODE,
    activePresetId:
      normalized.scripting?.activePresetId !== undefined
        ? normalized.scripting.activePresetId
        : "hmac-header-injection",
  };
  const normalizedWithBreakpoints: FluxUserSettingsProfile = {
    ...normalized,
    breakpoints: nextBreakpoints,
    scripting: nextScripting,
  };

  const retentionLimit =
    normalizedWithBreakpoints.proxy.sessionRetentionLimit !== undefined
      ? normalizedWithBreakpoints.proxy.sessionRetentionLimit
      : DEFAULT_SESSION_RETENTION_LIMIT;
  const dropNonMatching = Boolean(
    normalizedWithBreakpoints.proxy.dropNonMatching ?? false
  );
  const clearDbOnExit = Boolean(
    normalizedWithBreakpoints.proxy.clearDbOnExit ?? false
  );
  const nextHostRemapRules: HostRemapRule[] = structuredClone(
    normalizedWithBreakpoints.proxy.hostRemapRules ?? DEFAULT_HOST_REMAP_RULES
  );
  const nextThrottleConfig: ThrottleConfig = {
    ...(normalizedWithBreakpoints.proxy.throttleConfig ?? DEFAULT_THROTTLE_CONFIG),
  };
  const nextUpstreamBase: FluxUserUpstreamProxySettings = normalizedWithBreakpoints
    .proxy.upstreamProxy ?? {
    enabled: false,
    protocol: "http",
    host: "",
    port: 8080,
    username: null,
    bypassList: [...DEFAULT_UPSTREAM_PROXY_BYPASS_LIST],
  };
  const nextUpstreamTimeouts: UpstreamTimeoutConfig =
    sanitizeUpstreamTimeoutConfig(
      normalizedWithBreakpoints.proxy.upstreamTimeouts,
      []
    );

  // 1. Capture current backend state snapshot for transactional rollback
  const [
    prevStatus,
    prevFilterCfg,
    prevBpCfg,
    prevAutoRespEnabled,
    prevAutoRespRules,
    prevStats,
    prevClearOnExit,
    prevPythonScript,
    prevHostRemapRules,
    prevThrottleConfig,
    prevUpstreamProxy,
    prevUpstreamTimeouts,
  ] = await Promise.all([
    proxyBridge.getStatus(),
    proxyBridge.getFilterBackendConfig(),
    proxyBridge.getBreakpointConfig(),
    proxyBridge.getAutoResponderEnabled(),
    proxyBridge.listRules(),
    proxyBridge.getMemoryStorageStats(),
    proxyBridge.getClearDbOnExit(),
    proxyBridge.getPythonRunnerStatus(),
    proxyBridge.getHostRemapRules(),
    proxyBridge.getThrottleConfig(),
    proxyBridge.getUpstreamProxyConfig(),
    proxyBridge.getUpstreamTimeouts(),
  ]);

  const sameUpstreamTarget =
    nextUpstreamBase.enabled &&
    prevUpstreamProxy.enabled &&
    nextUpstreamBase.protocol === prevUpstreamProxy.protocol &&
    nextUpstreamBase.host.trim().toLowerCase() ===
      prevUpstreamProxy.host.trim().toLowerCase() &&
    nextUpstreamBase.port === prevUpstreamProxy.port &&
    (nextUpstreamBase.username ?? null) ===
      (prevUpstreamProxy.username ?? null);

  const nextUpstreamPayload: UpstreamProxyConfig = {
    enabled: nextUpstreamBase.enabled,
    protocol: nextUpstreamBase.protocol,
    host: nextUpstreamBase.host,
    port: nextUpstreamBase.port,
    username: nextUpstreamBase.username ?? null,
    // Preserve live RAM password only when endpoint & username match; otherwise clear stale secret.
    password: sameUpstreamTarget ? undefined : "",
    bypassList: [...nextUpstreamBase.bypassList],
  };

  let latestStatus: ProxyStatus = prevStatus;
  let autoSysProxyChanged = false;
  let sysProxyChanged = false;
  let bindChanged = false;
  let portChanged = false;

  try {
    // 2. Apply all IPC updates BEFORE persisting to localStorage or broadcasting SETTINGS_APPLIED_EVENT
    await Promise.all([
      proxyBridge.updateFilterBackendConfig(backendConfig),
      proxyBridge.updateBreakpointConfig(nextBreakpoints),
      proxyBridge.setAutoResponderConfig(
        normalizedWithBreakpoints.autoResponder.enabled,
        normalizedWithBreakpoints.autoResponder.rules
      ),
      proxyBridge.setSessionRetentionLimit(retentionLimit),
      proxyBridge.setDropNonMatching(dropNonMatching),
      proxyBridge.setClearDbOnExit(clearDbOnExit),
      proxyBridge.setPythonScript(nextScripting.code, nextScripting.enabled),
      proxyBridge.updateHostRemapRules(nextHostRemapRules),
      proxyBridge.setThrottleConfig(nextThrottleConfig),
      proxyBridge.setUpstreamProxyConfig(nextUpstreamPayload),
      proxyBridge.setUpstreamTimeouts(nextUpstreamTimeouts),
    ]);

    if (
      latestStatus.autoSystemProxy !==
      normalizedWithBreakpoints.proxy.autoSystemProxy
    ) {
      latestStatus = await proxyBridge.setAutoSystemProxy(
        normalizedWithBreakpoints.proxy.autoSystemProxy
      );
      autoSysProxyChanged = true;
      if (
        !normalizedWithBreakpoints.proxy.autoSystemProxy &&
        latestStatus.systemProxyEnabled
      ) {
        latestStatus = await proxyBridge.setSystemProxy(false);
        sysProxyChanged = true;
      }
    }

    const currentMode: BindHostMode =
      latestStatus.bindMode ??
      (latestStatus.allowRemote || latestStatus.bindAddr === "0.0.0.0"
        ? "all"
        : "loopback");
    const currentSpecificIp = latestStatus.specificBindIp ?? null;
    const currentAlsoLoopback = latestStatus.alsoBindLoopback ?? true;

    const targetMode: BindHostMode =
      normalizedWithBreakpoints.proxy.bindMode ??
      (normalizedWithBreakpoints.proxy.allowRemote ? "all" : "loopback");
    const targetSpecificIp =
      normalizedWithBreakpoints.proxy.specificBindIp ?? null;
    const targetAlsoLoopback =
      normalizedWithBreakpoints.proxy.alsoBindLoopback ?? true;

    if (
      currentMode !== targetMode ||
      (targetMode === "specific" && currentSpecificIp !== targetSpecificIp) ||
      currentAlsoLoopback !== targetAlsoLoopback
    ) {
      latestStatus = await proxyBridge.setBindConfiguration(
        targetMode,
        targetSpecificIp,
        targetAlsoLoopback
      );
      bindChanged = true;
    }

    if (latestStatus.port !== normalizedWithBreakpoints.proxy.port) {
      portChanged = true;
      if (latestStatus.running) {
        await proxyBridge.stopProxy();
        latestStatus = await proxyBridge.startProxy(
          undefined,
          normalizedWithBreakpoints.proxy.port
        );
      } else {
        latestStatus = await proxyBridge.setPreviewPort(
          normalizedWithBreakpoints.proxy.port
        );
        latestStatus = {
          ...latestStatus,
          port: normalizedWithBreakpoints.proxy.port,
        };
      }
    }

    // 3. Atomic localStorage write ONLY after all IPC operations succeed
    atomicWriteProfileToLocalStorage(normalizedWithBreakpoints, backendConfig);
  } catch (applyErr) {
    const rollbackErrors: string[] = [];

    const configRollback = await Promise.allSettled([
      proxyBridge.updateFilterBackendConfig(prevFilterCfg),
      proxyBridge.updateBreakpointConfig(prevBpCfg),
      proxyBridge.setAutoResponderConfig(
        prevAutoRespEnabled,
        prevAutoRespRules
      ),
      proxyBridge.setSessionRetentionLimit(prevStats.sessionRetentionLimit),
      proxyBridge.setDropNonMatching(prevStats.dropNonMatching),
      proxyBridge.setClearDbOnExit(prevClearOnExit),
      proxyBridge.setPythonScript(
        prevPythonScript.code,
        prevPythonScript.enabled
      ),
      proxyBridge.updateHostRemapRules(prevHostRemapRules),
      proxyBridge.setThrottleConfig(prevThrottleConfig),
      proxyBridge.setUpstreamProxyConfig({
        ...prevUpstreamProxy,
        password: undefined,
      }),
      proxyBridge.setUpstreamTimeouts(prevUpstreamTimeouts),
    ]);
    const configLabels = [
      "фильтры прокси",
      "точки останова",
      "AutoResponder",
      "лимит хранения сессий",
      "dropNonMatching",
      "clearDbOnExit",
      "Python Scripting",
      "HOSTS Remapping",
      "Bandwidth Throttling",
      "Upstream Proxy",
      "Upstream Timeouts",
    ];
    configRollback.forEach((res, idx) => {
      if (res.status === "rejected") {
        rollbackErrors.push(
          `${configLabels[idx]}: ${
            res.reason instanceof Error
              ? res.reason.message
              : String(res.reason)
          }`
        );
      }
    });

    if (bindChanged) {
      const prevMode: BindHostMode =
        prevStatus.bindMode ??
        (prevStatus.allowRemote || prevStatus.bindAddr === "0.0.0.0"
          ? "all"
          : "loopback");
      try {
        await proxyBridge.setBindConfiguration(
          prevMode,
          prevStatus.specificBindIp ?? null,
          prevStatus.alsoBindLoopback ?? true
        );
      } catch (rbErr) {
        rollbackErrors.push(
          `интерфейс прослушивания: ${
            rbErr instanceof Error ? rbErr.message : String(rbErr)
          }`
        );
      }
    }

    if (portChanged) {
      try {
        if (prevStatus.running) {
          const afterErrStatus = await proxyBridge
            .getStatus()
            .catch(() => null);
          if (
            afterErrStatus?.running &&
            afterErrStatus.port !== prevStatus.port
          ) {
            await proxyBridge.stopProxy();
          }
          if (
            !afterErrStatus?.running ||
            afterErrStatus.port !== prevStatus.port
          ) {
            await proxyBridge.startProxy(undefined, prevStatus.port);
          }
        } else {
          await proxyBridge.setPreviewPort(prevStatus.port);
        }
      } catch (rbErr) {
        rollbackErrors.push(
          `порт :${prevStatus.port}: ${
            rbErr instanceof Error ? rbErr.message : String(rbErr)
          }`
        );
      }
    }

    if (autoSysProxyChanged) {
      try {
        await proxyBridge.setAutoSystemProxy(prevStatus.autoSystemProxy);
      } catch (rbErr) {
        rollbackErrors.push(
          `autoSystemProxy: ${
            rbErr instanceof Error ? rbErr.message : String(rbErr)
          }`
        );
      }
    }

    if (
      sysProxyChanged ||
      (autoSysProxyChanged && prevStatus.systemProxyEnabled)
    ) {
      try {
        await proxyBridge.setSystemProxy(prevStatus.systemProxyEnabled);
      } catch (rbErr) {
        rollbackErrors.push(
          `systemProxy: ${
            rbErr instanceof Error ? rbErr.message : String(rbErr)
          }`
        );
      }
    }

    try {
      const rolledBackStatus = await proxyBridge.getStatus();
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent<ProxyStatus>(PROXY_STATUS_SYNCED_EVENT, {
            detail: rolledBackStatus,
          })
        );
      }
    } catch {
      // best-effort status sync
    }

    const primaryMessage =
      applyErr instanceof Error ? applyErr.message : String(applyErr);
    const rollbackSummary =
      rollbackErrors.length === 0
        ? "выполнен полный откат параметров бэкенда"
        : `при откате возникли ошибки (${rollbackErrors.join("; ")})`;
    throw new Error(
      `Сбой применения настроек (${primaryMessage}); ${rollbackSummary}.`
    );
  }

  // 4. Broadcast React hook state & panel layout reset ONLY after IPC + localStorage succeed
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<FluxUserSettingsProfile>(SETTINGS_APPLIED_EVENT, {
        detail: normalizedWithBreakpoints,
      })
    );
    if (
      normalizedWithBreakpoints.ui.panelLayouts !== undefined &&
      Object.keys(normalizedWithBreakpoints.ui.panelLayouts).length === 0
    ) {
      clearPersistedPanelLayouts();
      window.dispatchEvent(new CustomEvent(FLUX_PANEL_LAYOUT_RESET_EVENT));
      window.setTimeout(() => {
        clearPersistedPanelLayouts();
      }, 150);
    }
    window.dispatchEvent(
      new CustomEvent<ProxyStatus>(PROXY_STATUS_SYNCED_EVENT, {
        detail: latestStatus,
      })
    );
  }

  return normalizedWithBreakpoints;
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
