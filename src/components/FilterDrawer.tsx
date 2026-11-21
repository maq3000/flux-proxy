import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Flame,
  Globe,
  ListFilter,
  RotateCcw,
  ShieldOff,
  Wand2,
  X,
} from "lucide-react";
import type { CompiledHostListFilter } from "../lib/filterEngine";
import type {
  DetectedProcessItem,
  FilterConditionRule,
  FilterDrawerTab,
  FilterPreset,
  HostListFilterConfig,
  NoiseThresholdsConfig,
  ProxyFilterBackendConfig,
  SessionSummary,
} from "../types/proxy";
import { FilterMatrixTab } from "./filters/FilterMatrixTab";
import { HeaderMutationsTab } from "./filters/HeaderMutationsTab";
import { HostFiltersTab } from "./filters/HostFiltersTab";
import { ThresholdsTab } from "./filters/ThresholdsTab";
import { TlsBypassTab } from "./filters/TlsBypassTab";

interface FilterDrawerProps {
  open: boolean;
  initialTab?: FilterDrawerTab;
  onClose: () => void;
  totalCount: number;
  filteredCount: number;
  sessions: SessionSummary[];
  // Bulk Hosts & URL Filter (Hosts List)
  hostListFilter: HostListFilterConfig;
  compiledHostList: CompiledHostListFilter;
  onHostListFilterChange: (
    updater:
      | HostListFilterConfig
      | ((prev: HostListFilterConfig) => HostListFilterConfig)
  ) => void;
  onNotify?: (message: string) => void;
  // Matrix & Presets
  matrixEnabled: boolean;
  onMatrixEnabledChange: (enabled: boolean) => void;
  rules: FilterConditionRule[];
  onRulesChange: (
    updater:
      | FilterConditionRule[]
      | ((prev: FilterConditionRule[]) => FilterConditionRule[])
  ) => void;
  ruleErrors: Record<string, string>;
  presets: FilterPreset[];
  activePresetId: string | null;
  onApplyPreset: (presetId: string) => void;
  onSavePreset: (name: string, description?: string) => void;
  onDeletePreset: (presetId: string) => void;
  onResetAll: () => void;
  // Processes
  detectedProcesses: DetectedProcessItem[];
  onQuickProcessFilter: (
    processName: string,
    action: "include" | "exclude"
  ) => void;
  // Thresholds & Time Heat
  thresholds: NoiseThresholdsConfig;
  onThresholdsChange: (
    updater:
      | NoiseThresholdsConfig
      | ((prev: NoiseThresholdsConfig) => NoiseThresholdsConfig)
  ) => void;
  // TLS Bypass & Header Mutations (Synced to Rust)
  backendConfig: ProxyFilterBackendConfig;
  onBackendConfigChange: (next: ProxyFilterBackendConfig) => Promise<void>;
  isForceNoCacheActive: boolean;
  onToggleForceNoCache: () => Promise<void>;
}

export const FilterDrawer: React.FC<FilterDrawerProps> = ({
  open,
  initialTab = "matrix",
  onClose,
  totalCount,
  filteredCount,
  sessions,
  hostListFilter,
  compiledHostList,
  onHostListFilterChange,
  onNotify,
  matrixEnabled,
  onMatrixEnabledChange,
  rules,
  onRulesChange,
  ruleErrors,
  presets,
  activePresetId,
  onApplyPreset,
  onSavePreset,
  onDeletePreset,
  onResetAll,
  detectedProcesses,
  onQuickProcessFilter,
  thresholds,
  onThresholdsChange,
  backendConfig,
  onBackendConfigChange,
  isForceNoCacheActive,
  onToggleForceNoCache,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const flushPendingBulkRef = useRef<(() => void) | null>(null);
  const titleId = useId();

  const [activeTab, setActiveTab] = useState<FilterDrawerTab>(initialTab);

  useEffect(() => {
    if (open && initialTab) {
      setActiveTab(initialTab);
    }
  }, [open, initialTab]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Light-dismiss pointer-bounds fallback when `<dialog closedby="any">` is missing
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || "closedBy" in HTMLDialogElement.prototype) return;

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
  }, []);

  const activeMatrixCount = useMemo(
    () =>
      matrixEnabled
        ? rules.filter((r) => r.enabled && r.value.trim()).length
        : 0,
    [matrixEnabled, rules]
  );

  const activeHostListCount = hostListFilter.enabled
    ? compiledHostList.activeCount
    : 0;

  const activeThresholdCount = useMemo(() => {
    let n = 0;
    if (thresholds.hide304NotModified) n++;
    if (thresholds.hideOptionsPreflight) n++;
    if (thresholds.hideConnectTunnels) n++;
    if (thresholds.hideStaticAssets) n++;
    if (thresholds.minBodySizeBytes !== null) n++;
    if (thresholds.maxBodySizeBytes !== null) n++;
    if (thresholds.onlySlowRequests) n++;
    return n;
  }, [thresholds]);

  const activeBypassCount = useMemo(
    () =>
      backendConfig.tlsInterceptMode === "targetedOnly"
        ? (backendConfig.tlsTargetRules ?? []).filter((r) => r.enabled).length
        : backendConfig.tlsBypassEnabled
          ? backendConfig.tlsBypassRules.filter((r) => r.enabled).length
          : 0,
    [backendConfig]
  );

  const activeHeaderMutCount = useMemo(
    () =>
      backendConfig.headerMutationsEnabled
        ? backendConfig.headerMutations.filter((m) => m.enabled).length
        : 0,
    [backendConfig]
  );

  const handleSwitchTab = (tab: FilterDrawerTab) => {
    if (activeTab === "tlsBypass" && tab !== "tlsBypass") {
      flushPendingBulkRef.current?.();
    }
    setActiveTab(tab);
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        if (activeTab === "tlsBypass") {
          flushPendingBulkRef.current?.();
        }
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto h-[84vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-strong bg-surface p-0 text-fg shadow-2xl open:flex"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-hairline bg-elevated px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-sky-500/15 text-sky-400">
            <ListFilter className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-fg">
              Rules &amp; Filter Matrix
            </h2>
            <p className="text-[11px] text-muted">
              Отображается{" "}
              <span className="font-semibold text-fg tabular-nums">
                {filteredCount}
              </span>{" "}
              из{" "}
              <span className="font-semibold text-fg tabular-nums">
                {totalCount}
              </span>{" "}
              сессий
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onResetAll}
            className="inline-flex items-center gap-1 rounded border border-strong bg-canvas px-2.5 py-1 text-[11px] font-medium text-muted hover:bg-hover hover:text-fg"
            title="Сбросить все правила фильтрации и пороги к заводским значениям"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Reset Filters</span>
          </button>
          <form method="dialog">
            <button
              value="cancel"
              aria-label="Закрыть правила фильтрации"
              className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </form>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-hairline bg-canvas px-4">
        <TabButton
          active={activeTab === "matrix"}
          onClick={() => handleSwitchTab("matrix")}
          icon={<ListFilter className="h-3.5 w-3.5" aria-hidden="true" />}
          label="Rules & Matrix"
          badge={activeMatrixCount}
        />
        <TabButton
          active={activeTab === "hostsList"}
          onClick={() => handleSwitchTab("hostsList")}
          icon={<Globe className="h-3.5 w-3.5" aria-hidden="true" />}
          label="Hosts List"
          badge={activeHostListCount}
        />
        <TabButton
          active={activeTab === "thresholds"}
          onClick={() => handleSwitchTab("thresholds")}
          icon={<Flame className="h-3.5 w-3.5" aria-hidden="true" />}
          label="Noise & Thresholds"
          badge={activeThresholdCount}
        />
        <TabButton
          active={activeTab === "tlsBypass"}
          onClick={() => handleSwitchTab("tlsBypass")}
          icon={<ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />}
          label={
            backendConfig.tlsInterceptMode === "targetedOnly"
              ? "TLS Selective MITM"
              : "TLS Pass-Through"
          }
          badge={activeBypassCount}
          tone="teal"
        />
        <TabButton
          active={activeTab === "headers"}
          onClick={() => handleSwitchTab("headers")}
          icon={<Wand2 className="h-3.5 w-3.5" aria-hidden="true" />}
          label="Header Mutations"
          badge={activeHeaderMutCount}
          tone="amber"
        />
      </div>

      {/* Scrollable Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
        {activeTab === "matrix" && (
          <FilterMatrixTab
            matrixEnabled={matrixEnabled}
            onMatrixEnabledChange={onMatrixEnabledChange}
            rules={rules}
            onRulesChange={onRulesChange}
            ruleErrors={ruleErrors}
            presets={presets}
            activePresetId={activePresetId}
            onApplyPreset={onApplyPreset}
            onSavePreset={onSavePreset}
            onDeletePreset={onDeletePreset}
            detectedProcesses={detectedProcesses}
            onQuickProcessFilter={onQuickProcessFilter}
            hostListFilter={hostListFilter}
            activeHostListCount={activeHostListCount}
            onSwitchToHostsTab={() => handleSwitchTab("hostsList")}
          />
        )}

        {activeTab === "hostsList" && (
          <HostFiltersTab
            config={hostListFilter}
            compiled={compiledHostList}
            sessions={sessions}
            onChange={onHostListFilterChange}
            onNotify={onNotify}
          />
        )}

        {activeTab === "thresholds" && (
          <ThresholdsTab
            thresholds={thresholds}
            onThresholdsChange={onThresholdsChange}
          />
        )}

        {activeTab === "tlsBypass" && (
          <TlsBypassTab
            isActive={open && activeTab === "tlsBypass"}
            sessions={sessions}
            thresholds={thresholds}
            onThresholdsChange={onThresholdsChange}
            backendConfig={backendConfig}
            onBackendConfigChange={onBackendConfigChange}
            onNotify={onNotify}
            flushPendingBulkRef={flushPendingBulkRef}
          />
        )}

        {activeTab === "headers" && (
          <HeaderMutationsTab
            backendConfig={backendConfig}
            onBackendConfigChange={onBackendConfigChange}
            isForceNoCacheActive={isForceNoCacheActive}
            onToggleForceNoCache={onToggleForceNoCache}
          />
        )}
      </div>
    </dialog>
  );
};

const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge: number;
  tone?: "sky" | "teal" | "amber";
}> = ({ active, onClick, icon, label, badge, tone = "sky" }) => {
  const badgeClasses =
    tone === "teal"
      ? "bg-teal-500/20 text-teal-300"
      : tone === "amber"
        ? "bg-amber-500/20 text-amber-300"
        : "bg-sky-500/20 text-sky-400";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
        active
          ? "border-sky-400 text-fg"
          : "border-transparent text-muted hover:text-fg"
      }`}
    >
      {icon}
      <span>{label}</span>
      {badge > 0 && (
        <span
          className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] font-bold tabular-nums ${badgeClasses}`}
        >
          {badge}
        </span>
      )}
    </button>
  );
};
