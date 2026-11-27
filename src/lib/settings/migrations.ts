import {
  COLUMN_MIN_WIDTHS,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_TOOLBAR_GROUPS,
  DEFAULT_VISIBLE_COLUMNS,
  TOOLBAR_GROUP_DEFINITIONS,
  TRAFFIC_COLUMNS,
  type InspectorSplitDirection,
} from "../../hooks/useUiPreferences";
import type { ThemePreference } from "../../hooks/useTheme";
import {
  isThemePresetId,
  normalizeHexColor,
  VALID_THEME_TOKEN_KEYS,
  type CustomColorOverrides,
  type ThemePresetId,
  type ThemeTokenKey,
} from "../themePresets";
import { DEFAULT_CLEAR_DB_ON_EXIT } from "../appDefaults";
import { DEFAULT_SESSION_RETENTION_LIMIT } from "../../types/proxy";
import type {
  BindHostMode,
  ColumnId,
  FilterConditionRule,
  FilterPreset,
  InspectorDockPosition,
  TlsInterceptMode,
  ToolbarGroupId,
} from "../../types/proxy";
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  type FluxUserSettingsProfile,
  type SettingsProfileValidationReport,
} from "../../types/settings";
import {
  BUILT_IN_FILTER_PRESETS,
  RECOGNIZED_PROFILE_TOP_KEYS,
  VALID_BIND_MODES,
  VALID_DOCK_POSITIONS,
  VALID_SPLIT_DIRECTIONS,
  VALID_THEMES,
  VALID_TLS_MODES,
  createDefaultSettingsProfile,
  isPlainObject,
  sanitizeAutoResponderRules,
  sanitizeBoolean,
  sanitizeBreakpointConfig,
  sanitizeFilterConditionRule,
  sanitizeFilterPreset,
  sanitizeHeaderMutations,
  sanitizeHostListFilter,
  sanitizeHostRemapRules,
  sanitizeLanClientAllowlist,
  sanitizeNoiseThresholds,
  sanitizePositiveInt,
  sanitizeSanitizationOptions,
  sanitizeScriptingSettings,
  sanitizeThrottleConfig,
  sanitizeTlsRuleList,
  sanitizeUpstreamProxyConfig,
  sanitizeUpstreamTimeoutConfig,
} from "./schema";

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
    if (ui.themePreset === undefined && draft.themePreset !== undefined) {
      ui.themePreset = draft.themePreset;
    }
    if (
      ui.customColorOverrides === undefined &&
      draft.customColorOverrides !== undefined
    ) {
      ui.customColorOverrides = draft.customColorOverrides;
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
    if (
      ui.inspectorSplitDirection === undefined &&
      draft.inspectorSplitDirection !== undefined
    ) {
      ui.inspectorSplitDirection = draft.inspectorSplitDirection;
    }
    if (ui.panelLayouts === undefined && draft.panelLayouts !== undefined) {
      ui.panelLayouts = draft.panelLayouts;
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
    if (proxy.bindMode === undefined && draft.bindMode !== undefined) {
      proxy.bindMode = draft.bindMode;
    }
    if (
      proxy.specificBindIp === undefined &&
      draft.specificBindIp !== undefined
    ) {
      proxy.specificBindIp = draft.specificBindIp;
    }
    if (
      proxy.alsoBindLoopback === undefined &&
      draft.alsoBindLoopback !== undefined
    ) {
      proxy.alsoBindLoopback = draft.alsoBindLoopback;
    }
    if (proxy.clearDbOnExit === undefined) {
      if (draft.clearDbOnExit !== undefined) {
        proxy.clearDbOnExit = draft.clearDbOnExit;
      } else if (ui.clearDbOnExit !== undefined) {
        proxy.clearDbOnExit = ui.clearDbOnExit;
      }
    }
    if (
      proxy.sanitizationOptions === undefined &&
      isPlainObject(draft.sanitizationOptions)
    ) {
      proxy.sanitizationOptions = draft.sanitizationOptions;
    }
    if (
      proxy.lanClientAllowlist === undefined &&
      Array.isArray(draft.lanClientAllowlist)
    ) {
      proxy.lanClientAllowlist = draft.lanClientAllowlist;
    }

    const autoResponder: Record<string, unknown> = { ...existingAutoResp };
    if (
      autoResponder.rules === undefined &&
      Array.isArray(draft.autoResponderRules)
    ) {
      autoResponder.rules = draft.autoResponderRules;
    }

    const breakpoints =
      draft.breakpoints !== undefined
        ? draft.breakpoints
        : draft.breakpointConfig !== undefined
          ? draft.breakpointConfig
          : existingProxy.breakpoints;

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
      ...(breakpoints !== undefined ? { breakpoints } : {}),
      ...(draft.scripting !== undefined ? { scripting: draft.scripting } : {}),
    };
  },
};

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
        isPlainObject(raw.autoResponder) ||
        isPlainObject(raw.breakpoints)))
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

  let themePreset: ThemePresetId =
    theme === "light" ? "default-light" : "default-dark";
  if (rawUi.themePreset !== undefined) {
    if (isThemePresetId(rawUi.themePreset)) {
      themePreset = rawUi.themePreset;
    } else {
      warnings.push(
        "Поле «ui.themePreset» некорректно — выбран пресет по умолчанию."
      );
    }
  }

  let customColorOverrides: CustomColorOverrides = {};
  if (rawUi.customColorOverrides !== undefined) {
    if (isPlainObject(rawUi.customColorOverrides)) {
      let invalidCount = 0;
      for (const [tokenKey, tokenVal] of Object.entries(
        rawUi.customColorOverrides
      )) {
        if (!VALID_THEME_TOKEN_KEYS.has(tokenKey as ThemeTokenKey)) {
          invalidCount += 1;
          continue;
        }
        const normalizedHex =
          typeof tokenVal === "string" ? normalizeHexColor(tokenVal) : null;
        if (!normalizedHex) {
          invalidCount += 1;
          continue;
        }
        customColorOverrides[tokenKey as ThemeTokenKey] = normalizedHex;
      }
      if (invalidCount > 0) {
        warnings.push(
          `В «ui.customColorOverrides» пропущено некорректных цветов: ${invalidCount}.`
        );
      }
    } else {
      warnings.push(
        "Поле «ui.customColorOverrides» повреждено — кастомные цвета сброшены."
      );
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

  let inspectorSplitDirection: InspectorSplitDirection =
    defaults.ui.inspectorSplitDirection;
  if (rawUi.inspectorSplitDirection !== undefined) {
    if (
      typeof rawUi.inspectorSplitDirection === "string" &&
      VALID_SPLIT_DIRECTIONS.has(
        rawUi.inspectorSplitDirection as InspectorSplitDirection
      )
    ) {
      inspectorSplitDirection =
        rawUi.inspectorSplitDirection as InspectorSplitDirection;
    } else {
      warnings.push(
        "Поле «ui.inspectorSplitDirection» некорректно — установлен режим auto."
      );
    }
  }

  let panelLayouts: Record<string, string> | undefined;
  if (rawUi.panelLayouts !== undefined) {
    if (isPlainObject(rawUi.panelLayouts)) {
      const sanitizedLayouts: Record<string, string> = {};
      for (const [rawKey, rawVal] of Object.entries(rawUi.panelLayouts)) {
        const cleanKey = rawKey.startsWith("react-resizable-panels:")
          ? rawKey.slice("react-resizable-panels:".length)
          : rawKey;
        if (!cleanKey.startsWith("flux-")) continue;
        if (typeof rawVal === "string") {
          try {
            const parsed = JSON.parse(rawVal) as unknown;
            if (isPlainObject(parsed)) {
              sanitizedLayouts[cleanKey] = rawVal;
            } else {
              warnings.push(
                `Сохранённая геометрия панели «${cleanKey}» повреждена и пропущена.`
              );
            }
          } catch {
            warnings.push(
              `Сохранённая геометрия панели «${cleanKey}» повреждена и пропущена.`
            );
          }
        } else if (isPlainObject(rawVal)) {
          sanitizedLayouts[cleanKey] = JSON.stringify(rawVal);
        }
      }
      panelLayouts = sanitizedLayouts;
    } else {
      warnings.push(
        "Поле «ui.panelLayouts» повреждено — размеры панелей сброшены."
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

  const legacyAllowRemote = sanitizeBoolean(
    rawProxy.allowRemote,
    defaults.proxy.allowRemote,
    "proxy.allowRemote",
    warnings
  );

  let specificBindIp: string | null = null;
  if (rawProxy.specificBindIp !== undefined && rawProxy.specificBindIp !== null) {
    if (typeof rawProxy.specificBindIp === "string") {
      const trimmed = rawProxy.specificBindIp.trim();
      specificBindIp = trimmed.length > 0 ? trimmed : null;
    } else {
      warnings.push("Поле «proxy.specificBindIp» должно быть строкой — сброшено.");
    }
  }

  const alsoBindLoopback =
    rawProxy.alsoBindLoopback !== undefined
      ? sanitizeBoolean(
          rawProxy.alsoBindLoopback,
          true,
          "proxy.alsoBindLoopback",
          warnings
        )
      : true;

  let bindMode: BindHostMode = legacyAllowRemote ? "all" : "loopback";
  if (rawProxy.bindMode !== undefined) {
    if (
      typeof rawProxy.bindMode === "string" &&
      VALID_BIND_MODES.has(rawProxy.bindMode as BindHostMode)
    ) {
      const candidate = rawProxy.bindMode as BindHostMode;
      if (candidate === "specific" && !specificBindIp) {
        warnings.push(
          "Поле «proxy.bindMode = specific» без указанного «proxy.specificBindIp» — выполнен откат."
        );
      } else {
        bindMode = candidate;
      }
    } else {
      warnings.push(
        "Поле «proxy.bindMode» некорректно — выполнена миграция из allowRemote."
      );
    }
  }

  const resolvedAllowRemote =
    bindMode === "all"
      ? true
      : bindMode === "specific" && specificBindIp
        ? specificBindIp !== "127.0.0.1" && specificBindIp !== "::1"
        : false;

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
      themePreset,
      customColorOverrides,
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
      inspectorSplitDirection,
      followTail: sanitizeBoolean(
        rawUi.followTail,
        defaults.ui.followTail,
        "ui.followTail",
        warnings
      ),
      columnWidths,
      visibleColumns,
      toolbarGroups,
      ...(panelLayouts !== undefined ? { panelLayouts } : {}),
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
      allowRemote: resolvedAllowRemote,
      bindMode,
      specificBindIp,
      alsoBindLoopback,
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
      clearDbOnExit: sanitizeBoolean(
        rawProxy.clearDbOnExit !== undefined
          ? rawProxy.clearDbOnExit
          : rawUi.clearDbOnExit,
        Boolean(defaults.proxy.clearDbOnExit ?? DEFAULT_CLEAR_DB_ON_EXIT),
        "proxy.clearDbOnExit",
        warnings
      ),
      sanitizationOptions: sanitizeSanitizationOptions(
        rawProxy.sanitizationOptions,
        warnings
      ),
      hostRemapRules: sanitizeHostRemapRules(
        rawProxy.hostRemapRules,
        defaults.proxy.hostRemapRules ?? [],
        warnings
      ),
      throttleConfig: sanitizeThrottleConfig(rawProxy.throttleConfig, warnings),
      upstreamProxy: sanitizeUpstreamProxyConfig(
        rawProxy.upstreamProxy,
        warnings
      ),
      upstreamTimeouts: sanitizeUpstreamTimeoutConfig(
        rawProxy.upstreamTimeouts,
        warnings
      ),
      lanClientAllowlist: sanitizeLanClientAllowlist(
        rawProxy.lanClientAllowlist,
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
    breakpoints: sanitizeBreakpointConfig(
      workingDraft.breakpoints !== undefined
        ? workingDraft.breakpoints
        : rawProxy.breakpoints,
      warnings
    ),
    scripting: sanitizeScriptingSettings(workingDraft.scripting, warnings),
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
