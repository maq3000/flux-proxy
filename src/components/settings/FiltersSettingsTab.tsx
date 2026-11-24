import React, { useMemo } from "react";
import { Flame, Globe, ListFilter, RotateCcw, Wand2 } from "lucide-react";
import type { CompiledHostListFilter } from "../../lib/filterEngine";
import type {
  DetectedProcessItem,
  FilterConditionRule,
  FilterPreset,
  HostListFilterConfig,
  NoiseThresholdsConfig,
  ProxyFilterBackendConfig,
  SessionSummary,
} from "../../types/proxy";
import type { SettingsFiltersSubTab } from "../../types/settings";
import { FilterMatrixTab } from "../filters/FilterMatrixTab";
import { HeaderMutationsTab } from "../filters/HeaderMutationsTab";
import { HostFiltersTab } from "../filters/HostFiltersTab";
import { ThresholdsTab } from "../filters/ThresholdsTab";
import { HelpTooltip } from "../ui/HelpTooltip";

export interface FiltersSettingsTabProps {
  activeSubTab: SettingsFiltersSubTab;
  onSubTabChange: (subTab: SettingsFiltersSubTab) => void;
  totalCount: number;
  filteredCount: number;
  sessions: SessionSummary[];
  // Matrix & Presets
  matrixEnabled: boolean;
  onSetMatrixEnabled: (enabled: boolean) => void;
  filterRules: FilterConditionRule[];
  onSetFilterRules: (
    updater:
      | FilterConditionRule[]
      | ((prev: FilterConditionRule[]) => FilterConditionRule[])
  ) => void;
  ruleErrors: Record<string, string>;
  allPresets: FilterPreset[];
  activePresetId: string | null;
  onApplyPreset: (presetId: string) => void;
  onSaveCustomPreset: (name: string, description?: string) => void;
  onDeleteCustomPreset: (presetId: string) => void;
  detectedProcesses: DetectedProcessItem[];
  onQuickProcessFilter: (
    processName: string,
    action: "include" | "exclude"
  ) => void;
  // Hosts List
  hostFilters: HostListFilterConfig;
  compiledHosts: CompiledHostListFilter;
  onSetHostFilters: (
    updater:
      | HostListFilterConfig
      | ((prev: HostListFilterConfig) => HostListFilterConfig)
  ) => void;
  // Thresholds
  noiseThresholds: NoiseThresholdsConfig;
  onSetNoiseThresholds: (
    updater:
      | NoiseThresholdsConfig
      | ((prev: NoiseThresholdsConfig) => NoiseThresholdsConfig)
  ) => void;
  // Header Mutations
  backendFilterConfig: ProxyFilterBackendConfig;
  onUpdateBackendFilterConfig: (next: ProxyFilterBackendConfig) => Promise<void>;
  isForceNoCacheActive: boolean;
  onToggleForceNoCache: () => Promise<void>;
  onResetAdvancedFilters: () => void;
  onNotify: (msg: string) => void;
}

export const FiltersSettingsTab: React.FC<FiltersSettingsTabProps> = ({
  activeSubTab,
  onSubTabChange,
  totalCount,
  filteredCount,
  sessions,
  matrixEnabled,
  onSetMatrixEnabled,
  filterRules,
  onSetFilterRules,
  ruleErrors,
  allPresets,
  activePresetId,
  onApplyPreset,
  onSaveCustomPreset,
  onDeleteCustomPreset,
  detectedProcesses,
  onQuickProcessFilter,
  hostFilters,
  compiledHosts,
  onSetHostFilters,
  noiseThresholds,
  onSetNoiseThresholds,
  backendFilterConfig,
  onUpdateBackendFilterConfig,
  isForceNoCacheActive,
  onToggleForceNoCache,
  onResetAdvancedFilters,
  onNotify,
}) => {
  const activeMatrixCount = useMemo(
    () =>
      matrixEnabled
        ? filterRules.filter((r) => r.enabled && r.value.trim()).length
        : 0,
    [matrixEnabled, filterRules]
  );

  const activeHostListCount = hostFilters.enabled
    ? compiledHosts.activeCount
    : 0;

  const activeThresholdCount = useMemo(() => {
    let n = 0;
    if (noiseThresholds.hide304NotModified) n++;
    if (noiseThresholds.hideOptionsPreflight) n++;
    if (noiseThresholds.hideConnectTunnels) n++;
    if (noiseThresholds.hideStaticAssets) n++;
    if (noiseThresholds.minBodySizeBytes !== null) n++;
    if (noiseThresholds.maxBodySizeBytes !== null) n++;
    if (noiseThresholds.onlySlowRequests) n++;
    return n;
  }, [noiseThresholds]);

  const activeHeaderMutCount = useMemo(
    () =>
      backendFilterConfig.headerMutationsEnabled
        ? backendFilterConfig.headerMutations.filter((m) => m.enabled).length
        : 0,
    [backendFilterConfig]
  );

  const subTabs: {
    id: SettingsFiltersSubTab;
    label: string;
    badge: number;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [
    {
      id: "matrix",
      label: "Filter Matrix",
      badge: activeMatrixCount,
      icon: ListFilter,
    },
    {
      id: "hostsList",
      label: "Hosts List",
      badge: activeHostListCount,
      icon: Globe,
    },
    {
      id: "thresholds",
      label: "Noise & Thresholds",
      badge: activeThresholdCount,
      icon: Flame,
    },
    {
      id: "headers",
      label: "Header Mutations",
      badge: activeHeaderMutCount,
      icon: Wand2,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Top Filter Summary Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-canvas px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <ListFilter className="h-4 w-4 text-accent" aria-hidden="true" />
          <span className="text-xs font-semibold text-fg">
            Отображается{" "}
            <span className="font-mono text-accent tabular-nums">
              {filteredCount}
            </span>{" "}
            из{" "}
            <span className="font-mono text-fg tabular-nums">
              {totalCount}
            </span>{" "}
            сессий
          </span>
          <HelpTooltip
            label="Подробнее о фильтрах и модификации заголовков"
            title="Видимость в таблице vs модификация в ядре"
            content="Filter Matrix, Hosts List и Thresholds управляют видимостью захваченных сессий (а при включённом Drop Non-Matching — отсеивают лишний трафик до записи). Header Mutations меняют реальные HTTP-заголовки запросов и ответов в прокси-ядре."
          />
        </div>

        <button
          type="button"
          onClick={onResetAdvancedFilters}
          className="inline-flex items-center gap-1 rounded border border-strong bg-surface px-2.5 py-1 text-[11px] font-medium text-muted hover:bg-hover hover:text-fg"
          title="Сбросить все правила фильтрации и пороги к заводским значениям"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Reset Filters</span>
        </button>
      </div>

      {/* Sub-navigation bar */}
      <div
        role="tablist"
        aria-label="Подразделы фильтрации и заголовков"
        className="flex flex-wrap items-center gap-1.5 border-b border-hairline pb-2.5"
      >
        {subTabs.map((st) => {
          const Icon = st.icon;
          const selected = activeSubTab === st.id;
          return (
            <button
              key={st.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onSubTabChange(st.id)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                selected
                  ? "border-accent/60 bg-selected text-fg"
                  : "border-hairline bg-canvas text-muted hover:border-strong hover:text-fg"
              }`}
            >
              <Icon className="h-3.5 w-3.5 text-accent" />
              <span>{st.label}</span>
              {st.badge > 0 && (
                <span className="rounded-full bg-elevated px-1.5 py-0.5 font-mono text-[10px] font-semibold text-fg tabular-nums">
                  {st.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Full Embedded Sub-Tabs */}
      <div id="filters-subtab-content">
        {activeSubTab === "matrix" && (
          <FilterMatrixTab
            matrixEnabled={matrixEnabled}
            onMatrixEnabledChange={onSetMatrixEnabled}
            rules={filterRules}
            onRulesChange={onSetFilterRules}
            ruleErrors={ruleErrors}
            presets={allPresets}
            activePresetId={activePresetId}
            onApplyPreset={onApplyPreset}
            onSavePreset={onSaveCustomPreset}
            onDeletePreset={onDeleteCustomPreset}
            detectedProcesses={detectedProcesses}
            onQuickProcessFilter={onQuickProcessFilter}
            hostListFilter={hostFilters}
            activeHostListCount={activeHostListCount}
            onSwitchToHostsTab={() => onSubTabChange("hostsList")}
          />
        )}

        {activeSubTab === "hostsList" && (
          <HostFiltersTab
            config={hostFilters}
            compiled={compiledHosts}
            sessions={sessions}
            onChange={onSetHostFilters}
            onNotify={onNotify}
          />
        )}

        {activeSubTab === "thresholds" && (
          <ThresholdsTab
            thresholds={noiseThresholds}
            onThresholdsChange={onSetNoiseThresholds}
          />
        )}

        {activeSubTab === "headers" && (
          <HeaderMutationsTab
            backendConfig={backendFilterConfig}
            onBackendConfigChange={onUpdateBackendFilterConfig}
            isForceNoCacheActive={isForceNoCacheActive}
            onToggleForceNoCache={onToggleForceNoCache}
          />
        )}
      </div>
    </div>
  );
};
