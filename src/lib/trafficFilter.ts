import {
  compileFilterMatrix,
  compileHostListFilter,
  evaluateSessionAgainstFilters,
} from "./filterEngine";
import { getRowSemanticTone } from "./formatters";
import { useFilterStore } from "../stores/filterStore";
import { useProxyStore } from "../stores/proxyStore";
import type {
  DetectedProcessItem,
  FilterConditionRule,
  HostListFilterConfig,
  NoiseThresholdsConfig,
  QuickFilterCategory,
  SessionSummary,
} from "../types/proxy";

export type CompiledMatrixPlan = ReturnType<typeof compileFilterMatrix>;
export type CompiledHostListFilter = ReturnType<typeof compileHostListFilter>;

export interface FilteredSessionsResult {
  filteredSessions: SessionSummary[];
  regexError: string | null;
}

export interface TrafficFilterInputs {
  filterQuery: string;
  useRegex: boolean;
  quickCategory: QuickFilterCategory;
  matrixEnabled: boolean;
  filterRules: FilterConditionRule[];
  thresholds: NoiseThresholdsConfig;
  hostListFilter: HostListFilterConfig;
}

let cachedRulesRef: FilterConditionRule[] | null = null;
let cachedCompiledMatrix: CompiledMatrixPlan | null = null;

export function getCompiledMatrixCached(
  filterRules: FilterConditionRule[]
): CompiledMatrixPlan {
  if (cachedRulesRef === filterRules && cachedCompiledMatrix) {
    return cachedCompiledMatrix;
  }
  cachedRulesRef = filterRules;
  cachedCompiledMatrix = compileFilterMatrix(filterRules);
  return cachedCompiledMatrix;
}

let cachedHostListRef: HostListFilterConfig | null = null;
let cachedCompiledHostList: CompiledHostListFilter | null = null;

export function getCompiledHostListCached(
  hostListFilter: HostListFilterConfig
): CompiledHostListFilter {
  if (cachedHostListRef === hostListFilter && cachedCompiledHostList) {
    return cachedCompiledHostList;
  }
  cachedHostListRef = hostListFilter;
  cachedCompiledHostList = compileHostListFilter(hostListFilter);
  return cachedCompiledHostList;
}

export function computeRegexError(
  filterQuery: string,
  useRegex: boolean
): string | null {
  const trimmed = filterQuery.trim();
  if (!trimmed || !useRegex) return null;
  try {
    new RegExp(trimmed, "i");
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid RegExp";
  }
}

export function computeFilteredSessions(
  sessions: SessionSummary[],
  inputs: TrafficFilterInputs,
  precompiledMatrix?: CompiledMatrixPlan,
  precompiledHostList?: CompiledHostListFilter
): FilteredSessionsResult {
  const compiledMatrix =
    precompiledMatrix ?? getCompiledMatrixCached(inputs.filterRules);
  const compiledHostList =
    precompiledHostList ?? getCompiledHostListCached(inputs.hostListFilter);

  let compiledQuickRegex: RegExp | null = null;
  const trimmed = inputs.filterQuery.trim();

  if (trimmed && inputs.useRegex) {
    try {
      compiledQuickRegex = new RegExp(trimmed, "i");
    } catch (err) {
      return {
        filteredSessions: sessions,
        regexError: err instanceof Error ? err.message : "Invalid RegExp",
      };
    }
  }

  const qLower = trimmed.toLowerCase();
  const { quickCategory, matrixEnabled, thresholds } = inputs;

  const result = sessions.filter((s) => {
    const isInFlight = s.status === 0 && !s.error && !s.tlsBypassed;
    // 1. Quick Category Bar
    if (quickCategory !== "all") {
      const tone = getRowSemanticTone(s);
      if (quickCategory === "json" && !isInFlight && tone !== "json") {
        return false;
      }
      if (quickCategory === "images" && !isInFlight && tone !== "image") {
        return false;
      }
      if (quickCategory === "errors" && !isInFlight && tone !== "error") {
        return false;
      }
      if (quickCategory === "ws" && tone !== "ws") return false;
      if (quickCategory === "sse" && !isInFlight && tone !== "sse") {
        return false;
      }
      if (quickCategory === "mocked" && !isInFlight && !s.isMocked) {
        return false;
      }
      if (quickCategory === "marked" && !s.comment && !s.markedColor) {
        return false;
      }
    }

    // 2. Bulk Hosts List + Advanced Filter Matrix + Thresholds + Noise Cleanup
    if (
      !evaluateSessionAgainstFilters(
        s,
        compiledMatrix,
        matrixEnabled,
        thresholds,
        compiledHostList
      )
    ) {
      return false;
    }

    // 3. Quick Search Bar (URL / Host / Method / Status / Content-Type / Process / Comment)
    if (!trimmed) return true;

    if (compiledQuickRegex) {
      return (
        compiledQuickRegex.test(s.url) ||
        compiledQuickRegex.test(s.method) ||
        compiledQuickRegex.test(String(s.status)) ||
        compiledQuickRegex.test(s.contentType) ||
        (s.processName ? compiledQuickRegex.test(s.processName) : false) ||
        (s.clientIp ? compiledQuickRegex.test(s.clientIp) : false) ||
        (s.comment ? compiledQuickRegex.test(s.comment) : false)
      );
    }

    return (
      s.url.toLowerCase().includes(qLower) ||
      s.host.toLowerCase().includes(qLower) ||
      s.method.toLowerCase().includes(qLower) ||
      String(s.status).includes(qLower) ||
      s.contentType.toLowerCase().includes(qLower) ||
      (s.processName ? s.processName.toLowerCase().includes(qLower) : false) ||
      (s.processPid != null ? String(s.processPid).includes(qLower) : false) ||
      (s.clientIp ? s.clientIp.toLowerCase().includes(qLower) : false) ||
      (s.comment ? s.comment.toLowerCase().includes(qLower) : false)
    );
  });

  return { filteredSessions: result, regexError: null };
}

let cachedSnapshotKey: {
  sessions: SessionSummary[];
  filterQuery: string;
  useRegex: boolean;
  quickCategory: QuickFilterCategory;
  matrixEnabled: boolean;
  filterRules: FilterConditionRule[];
  thresholds: NoiseThresholdsConfig;
  hostListFilter: HostListFilterConfig;
} | null = null;
let cachedSnapshotResult: FilteredSessionsResult | null = null;

export function getFilteredSessionsResultSnapshot(): FilteredSessionsResult {
  const sessions = useProxyStore.getState().sessions;
  const f = useFilterStore.getState();

  if (
    cachedSnapshotKey &&
    cachedSnapshotResult &&
    cachedSnapshotKey.sessions === sessions &&
    cachedSnapshotKey.filterQuery === f.filterQuery &&
    cachedSnapshotKey.useRegex === f.useRegex &&
    cachedSnapshotKey.quickCategory === f.quickCategory &&
    cachedSnapshotKey.matrixEnabled === f.matrixEnabled &&
    cachedSnapshotKey.filterRules === f.filterRules &&
    cachedSnapshotKey.thresholds === f.thresholds &&
    cachedSnapshotKey.hostListFilter === f.hostListFilter
  ) {
    return cachedSnapshotResult;
  }

  const nextResult = computeFilteredSessions(sessions, {
    filterQuery: f.filterQuery,
    useRegex: f.useRegex,
    quickCategory: f.quickCategory,
    matrixEnabled: f.matrixEnabled,
    filterRules: f.filterRules,
    thresholds: f.thresholds,
    hostListFilter: f.hostListFilter,
  });

  cachedSnapshotKey = {
    sessions,
    filterQuery: f.filterQuery,
    useRegex: f.useRegex,
    quickCategory: f.quickCategory,
    matrixEnabled: f.matrixEnabled,
    filterRules: f.filterRules,
    thresholds: f.thresholds,
    hostListFilter: f.hostListFilter,
  };
  cachedSnapshotResult = nextResult;
  return nextResult;
}

export function getFilteredSessionsSnapshot(): SessionSummary[] {
  return getFilteredSessionsResultSnapshot().filteredSessions;
}

export function computeDetectedProcesses(
  sessions: readonly SessionSummary[]
): DetectedProcessItem[] {
  const map = new Map<string, DetectedProcessItem>();
  for (const s of sessions) {
    if (!s.processName) continue;
    const key = `${s.processName}::${s.processPid ?? ""}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(key, {
        name: s.processName,
        pid: s.processPid ?? null,
        count: 1,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}
