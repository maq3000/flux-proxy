import { create } from "zustand";
import {
  compileHostListFilter,
  DEFAULT_BACKEND_FILTER_CONFIG,
  DEFAULT_HOST_LIST_FILTER_CONFIG,
  DEFAULT_NOISE_THRESHOLDS,
} from "../lib/filterEngine";
import type {
  FilterConditionRule,
  FilterPreset,
  HostListBackendSyncConfig,
  HostListFilterConfig,
  NoiseThresholdsBackendSyncConfig,
  NoiseThresholdsConfig,
  ProxyFilterBackendConfig,
  QuickFilterCategory,
} from "../types/proxy";
import type { FluxUserSettingsProfile } from "../types/settings";

export const LS_CUSTOM_PRESETS_KEY = "fluxproxy.customFilterPresets.v1";
export const LS_ACTIVE_FILTER_STATE_KEY = "fluxproxy.activeFilterState.v1";
export const LS_BACKEND_FILTER_CFG_KEY = "fluxproxy.backendFilterConfig.v1";
export const LS_DROP_NON_MATCHING_KEY = "fluxproxy.dropNonMatching.v1";

export interface PersistedFilterState {
  matrixEnabled: boolean;
  rules: FilterConditionRule[];
  thresholds: NoiseThresholdsConfig;
  activePresetId: string | null;
  hostListFilter?: HostListFilterConfig;
}

export function loadFilterJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function buildHostListSyncPayload(
  cfg: HostListFilterConfig,
  activeCount: number
): HostListBackendSyncConfig {
  return {
    enabled: Boolean(
      cfg.enabled && cfg.applyToTlsPassthrough && activeCount > 0
    ),
    mode: cfg.mode,
    rawText: cfg.rawText,
  };
}

export function buildCaptureHostListPayload(
  cfg: HostListFilterConfig,
  activeCount: number
): HostListBackendSyncConfig {
  return {
    enabled: Boolean(cfg.enabled && activeCount > 0),
    mode: cfg.mode,
    rawText: cfg.rawText,
  };
}

export function buildNoiseThresholdsSyncPayload(
  th: NoiseThresholdsConfig
): NoiseThresholdsBackendSyncConfig {
  return {
    hide304NotModified: th.hide304NotModified,
    hideOptionsPreflight: th.hideOptionsPreflight,
    hideConnectTunnels: th.hideConnectTunnels,
    hideStaticAssets: th.hideStaticAssets,
    minBodySizeBytes: th.minBodySizeBytes,
    maxBodySizeBytes: th.maxBodySizeBytes,
    timeHeatWarningMs: th.timeHeatWarningMs,
    onlySlowRequests: th.onlySlowRequests,
  };
}

function readInitialFilterSlice(dropNonMatching: boolean) {
  const initialPersisted = loadFilterJson<PersistedFilterState>(
    LS_ACTIVE_FILTER_STATE_KEY,
    {
      matrixEnabled: true,
      rules: [],
      thresholds: { ...DEFAULT_NOISE_THRESHOLDS },
      activePresetId: null,
      hostListFilter: { ...DEFAULT_HOST_LIST_FILTER_CONFIG },
    }
  );
  const thresholds: NoiseThresholdsConfig = {
    ...DEFAULT_NOISE_THRESHOLDS,
    ...initialPersisted.thresholds,
  };
  const hostListFilter: HostListFilterConfig = {
    ...DEFAULT_HOST_LIST_FILTER_CONFIG,
    ...(initialPersisted.hostListFilter ?? {}),
  };
  const customPresets = loadFilterJson<FilterPreset[]>(
    LS_CUSTOM_PRESETS_KEY,
    []
  );
  const savedBackend = loadFilterJson<Partial<ProxyFilterBackendConfig>>(
    LS_BACKEND_FILTER_CFG_KEY,
    structuredClone(DEFAULT_BACKEND_FILTER_CONFIG)
  );
  const bootCompiled = compileHostListFilter(hostListFilter);
  const backendFilterConfig: ProxyFilterBackendConfig = {
    ...structuredClone(DEFAULT_BACKEND_FILTER_CONFIG),
    ...savedBackend,
    tlsInterceptMode: savedBackend.tlsInterceptMode ?? "interceptAll",
    tlsTargetRules: Array.isArray(savedBackend.tlsTargetRules)
      ? savedBackend.tlsTargetRules
      : [],
    stripAltSvc: savedBackend.stripAltSvc ?? true,
    hostListSync: buildHostListSyncPayload(
      hostListFilter,
      bootCompiled.activeCount
    ),
    dropNonMatchingOnCapture: dropNonMatching,
    captureHostList: buildCaptureHostListPayload(
      hostListFilter,
      bootCompiled.activeCount
    ),
    noiseThresholds: buildNoiseThresholdsSyncPayload(thresholds),
    captureMatrixEnabled: initialPersisted.matrixEnabled,
    captureFilterRules: initialPersisted.rules,
    quickCategory: "all",
    filterQuery: "",
    useRegexQuery: false,
    lanClientAllowlist: Array.isArray(savedBackend.lanClientAllowlist)
      ? savedBackend.lanClientAllowlist.filter(
          (item): item is string => typeof item === "string"
        )
      : [],
  };

  return {
    filterQuery: "",
    useRegex: false,
    quickCategory: "all" as QuickFilterCategory,
    matrixEnabled: initialPersisted.matrixEnabled,
    filterRules: initialPersisted.rules,
    thresholds,
    hostListFilter,
    activePresetId: initialPersisted.activePresetId,
    customPresets,
    backendFilterConfig,
  };
}

function persistActiveFilterState(state: {
  matrixEnabled: boolean;
  filterRules: FilterConditionRule[];
  thresholds: NoiseThresholdsConfig;
  activePresetId: string | null;
  hostListFilter: HostListFilterConfig;
}): void {
  if (typeof window === "undefined") return;
  try {
    const payload: PersistedFilterState = {
      matrixEnabled: state.matrixEnabled,
      rules: state.filterRules,
      thresholds: state.thresholds,
      activePresetId: state.activePresetId,
      hostListFilter: state.hostListFilter,
    };
    window.localStorage.setItem(
      LS_ACTIVE_FILTER_STATE_KEY,
      JSON.stringify(payload)
    );
  } catch {
    // ignore storage quota errors
  }
}

function persistCustomPresets(customPresets: FilterPreset[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      LS_CUSTOM_PRESETS_KEY,
      JSON.stringify(customPresets)
    );
  } catch {
    // ignore storage quota errors
  }
}

type Updater<T> = T | ((prev: T) => T);

function resolveUpdater<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === "function"
    ? (updater as (p: T) => T)(prev)
    : updater;
}

export interface FilterStoreState {
  filterQuery: string;
  useRegex: boolean;
  quickCategory: QuickFilterCategory;

  matrixEnabled: boolean;
  filterRules: FilterConditionRule[];
  thresholds: NoiseThresholdsConfig;
  hostListFilter: HostListFilterConfig;
  activePresetId: string | null;
  customPresets: FilterPreset[];
  backendFilterConfig: ProxyFilterBackendConfig;

  setFilterQuery: (updater: Updater<string>) => void;
  setUseRegex: (updater: Updater<boolean>) => void;
  setQuickCategory: (updater: Updater<QuickFilterCategory>) => void;
  setMatrixEnabled: (updater: Updater<boolean>) => void;
  setFilterRules: (updater: Updater<FilterConditionRule[]>) => void;
  setThresholds: (updater: Updater<NoiseThresholdsConfig>) => void;
  setHostListFilter: (updater: Updater<HostListFilterConfig>) => void;
  setActivePresetId: (updater: Updater<string | null>) => void;
  setCustomPresets: (updater: Updater<FilterPreset[]>) => void;
  setBackendFilterConfig: (updater: Updater<ProxyFilterBackendConfig>) => void;
  applySettingsProfileFilters: (
    detail: FluxUserSettingsProfile
  ) => ProxyFilterBackendConfig;
  syncFromLocalStorage: (dropNonMatching: boolean) => void;
}

const initialDropNonMatching = loadFilterJson<boolean>(
  LS_DROP_NON_MATCHING_KEY,
  false
);
const initialSlice = readInitialFilterSlice(initialDropNonMatching);

export const useFilterStore = create<FilterStoreState>((set) => ({
  ...initialSlice,

  setFilterQuery: (updater) => {
    set((state) => ({
      filterQuery: resolveUpdater(updater, state.filterQuery),
    }));
  },

  setUseRegex: (updater) => {
    set((state) => ({ useRegex: resolveUpdater(updater, state.useRegex) }));
  },

  setQuickCategory: (updater) => {
    set((state) => ({
      quickCategory: resolveUpdater(updater, state.quickCategory),
    }));
  },

  setMatrixEnabled: (updater) => {
    set((state) => {
      const matrixEnabled = resolveUpdater(updater, state.matrixEnabled);
      const next = { ...state, matrixEnabled };
      persistActiveFilterState(next);
      return { matrixEnabled };
    });
  },

  setFilterRules: (updater) => {
    set((state) => {
      const filterRules = resolveUpdater(updater, state.filterRules);
      const next = { ...state, filterRules };
      persistActiveFilterState(next);
      return { filterRules };
    });
  },

  setThresholds: (updater) => {
    set((state) => {
      const thresholds = resolveUpdater(updater, state.thresholds);
      const next = { ...state, thresholds };
      persistActiveFilterState(next);
      return { thresholds };
    });
  },

  setHostListFilter: (updater) => {
    set((state) => {
      const hostListFilter = resolveUpdater(updater, state.hostListFilter);
      const next = { ...state, hostListFilter };
      persistActiveFilterState(next);
      return { hostListFilter };
    });
  },

  setActivePresetId: (updater) => {
    set((state) => {
      const activePresetId = resolveUpdater(updater, state.activePresetId);
      const next = { ...state, activePresetId };
      persistActiveFilterState(next);
      return { activePresetId };
    });
  },

  setCustomPresets: (updater) => {
    set((state) => {
      const customPresets = resolveUpdater(updater, state.customPresets);
      persistCustomPresets(customPresets);
      return { customPresets };
    });
  },

  setBackendFilterConfig: (updater) => {
    set((state) => ({
      backendFilterConfig: resolveUpdater(updater, state.backendFilterConfig),
    }));
  },

  applySettingsProfileFilters: (detail) => {
    const customPresets = structuredClone(detail.filters.userPresets);
    const activePresetId = detail.filters.activePresetId;
    const matrixEnabled = detail.filters.matrixEnabled ?? true;
    const filterRules = structuredClone(detail.filters.filterRules ?? []);
    const thresholds = {
      ...DEFAULT_NOISE_THRESHOLDS,
      ...detail.filters.noiseThresholds,
    };
    const hostListFilter = {
      ...DEFAULT_HOST_LIST_FILTER_CONFIG,
      ...detail.filters.hostFilters,
    };
    const nextDropNonMatching = Boolean(detail.proxy.dropNonMatching ?? false);
    const compiledHl = compileHostListFilter(hostListFilter);
    const backendFilterConfig: ProxyFilterBackendConfig = {
      tlsInterceptMode: detail.proxy.tlsInterceptMode,
      tlsBypassEnabled: detail.proxy.tlsBypassEnabled ?? true,
      tlsBypassRules: structuredClone(detail.proxy.tlsBypassRules),
      tlsTargetRules: structuredClone(detail.proxy.tlsTargetRules),
      headerMutationsEnabled: detail.proxy.headerMutationsEnabled ?? true,
      headerMutations: structuredClone(detail.proxy.headerMutations),
      stripAltSvc: detail.proxy.stripAltSvc ?? true,
      hostListSync: buildHostListSyncPayload(
        hostListFilter,
        compiledHl.activeCount
      ),
      dropNonMatchingOnCapture: nextDropNonMatching,
      captureHostList: buildCaptureHostListPayload(
        hostListFilter,
        compiledHl.activeCount
      ),
      noiseThresholds: buildNoiseThresholdsSyncPayload(thresholds),
      captureMatrixEnabled: matrixEnabled,
      captureFilterRules: filterRules,
      quickCategory: "all",
      filterQuery: "",
      useRegexQuery: false,
      lanClientAllowlist: structuredClone(detail.proxy.lanClientAllowlist ?? []),
    };

    set({
      customPresets,
      activePresetId,
      matrixEnabled,
      filterRules,
      thresholds,
      hostListFilter,
      backendFilterConfig,
      filterQuery: "",
      useRegex: false,
      quickCategory: "all",
    });

    return backendFilterConfig;
  },

  syncFromLocalStorage: (dropNonMatching) => {
    set(readInitialFilterSlice(dropNonMatching));
  },
}));
