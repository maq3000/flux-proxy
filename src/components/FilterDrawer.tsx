import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  BookmarkPlus,
  Cpu,
  Flame,
  Gauge,
  Globe,
  ListFilter,
  Plus,
  RotateCcw,
  Shield,
  ShieldOff,
  Sparkles,
  Target,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { HostFiltersTab } from "./HostFiltersTab";
import {
  type CompiledHostListFilter,
  FILTER_FIELD_OPTIONS,
  FILTER_OPERATOR_OPTIONS,
  TLS_BYPASS_QUICK_PACKS,
  USER_AGENT_PRESETS,
} from "../lib/filterEngine";
import { formatBytes } from "../lib/formatters";
import type {
  DetectedProcessItem,
  FilterConditionRule,
  FilterDrawerTab,
  FilterField,
  FilterLogicalOp,
  FilterOperator,
  FilterPreset,
  FilterRuleAction,
  HeaderMutationDirection,
  HeaderMutationOp,
  HeaderMutationRule,
  HostListFilterConfig,
  NoiseThresholdsConfig,
  ProxyFilterBackendConfig,
  SessionSummary,
  TlsBypassRule,
} from "../types/proxy";

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
  const titleId = useId();
  const processDatalistId = useId();

  const [activeTab, setActiveTab] = useState<FilterDrawerTab>(initialTab);
  const [newPresetName, setNewPresetName] = useState("");
  const [newTargetPattern, setNewTargetPattern] = useState("");
  const [newTargetCategory, setNewTargetCategory] = useState("Target Service");
  const [newTargetDesc, setNewTargetDesc] = useState("");
  const [newBypassPattern, setNewBypassPattern] = useState("");
  const [newBypassCategory, setNewBypassCategory] = useState("Payment Gateways");
  const [newBypassDesc, setNewBypassDesc] = useState("");

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

  // Counts for tab badges
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

  // Track first active Include and first active Exclude row so we render "WHERE" vs "AND/OR" cleanly
  const firstIncludeId = rules.find((r) => r.action === "include")?.id ?? null;
  const firstExcludeId = rules.find((r) => r.action === "exclude")?.id ?? null;

  const addMatrixRule = (
    action: FilterRuleAction,
    field: FilterField = "host",
    operator: FilterOperator = "contains",
    value = ""
  ) => {
    const nextRule: FilterConditionRule = {
      id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      enabled: true,
      action,
      logicalOp: "OR",
      field,
      operator,
      value,
    };
    onMatrixEnabledChange(true);
    onRulesChange((prev) => [...prev, nextRule]);
  };

  const updateMatrixRule = (
    id: string,
    patch: Partial<FilterConditionRule>
  ) => {
    onRulesChange((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r))
    );
  };

  const removeMatrixRule = (id: string) => {
    onRulesChange((prev) => prev.filter((r) => r.id !== id));
  };

  const handleAddTlsTarget = (e: React.FormEvent) => {
    e.preventDefault();
    const pat = newTargetPattern.trim();
    if (!pat) return;
    const rule: TlsBypassRule = {
      id: `target-${Date.now()}`,
      enabled: true,
      pattern: pat,
      category: newTargetCategory,
      description:
        newTargetDesc.trim() ||
        "Целевой сервис для MITM-расшифровки (Allowlist)",
    };
    void onBackendConfigChange({
      ...backendConfig,
      tlsTargetRules: [rule, ...(backendConfig.tlsTargetRules ?? [])],
    });
    setNewTargetPattern("");
    setNewTargetDesc("");
  };

  const handleAddTlsBypass = (e: React.FormEvent) => {
    e.preventDefault();
    const pat = newBypassPattern.trim();
    if (!pat) return;
    const rule: TlsBypassRule = {
      id: `bypass-${Date.now()}`,
      enabled: true,
      pattern: pat,
      category: newBypassCategory,
      description:
        newBypassDesc.trim() || "Пользовательское правило обхода MITM (Pinning)",
    };
    void onBackendConfigChange({
      ...backendConfig,
      tlsBypassEnabled: true,
      tlsBypassRules: [rule, ...backendConfig.tlsBypassRules],
    });
    setNewBypassPattern("");
    setNewBypassDesc("");
  };

  const addHeaderMutationRule = () => {
    const nextRule: HeaderMutationRule = {
      id: `hm-${Date.now()}`,
      enabled: true,
      name: "Новое правило заголовка",
      direction: "request",
      operation: "set",
      headerName: "X-Debug-Trace",
      headerValue: "enabled",
      urlPattern: "*",
    };
    void onBackendConfigChange({
      ...backendConfig,
      headerMutationsEnabled: true,
      headerMutations: [...backendConfig.headerMutations, nextRule],
    });
  };

  const activeUaRule = backendConfig.headerMutations.find(
    (m) => m.id === "hm-ua-override"
  );
  const currentUaSelectValue =
    activeUaRule && activeUaRule.enabled ? activeUaRule.headerValue : "";

  const handleQuickUserAgentSelect = (uaValue: string) => {
    if (!uaValue) {
      const next = backendConfig.headerMutations.map((m) =>
        m.id === "hm-ua-override" ? { ...m, enabled: false } : m
      );
      void onBackendConfigChange({
        ...backendConfig,
        headerMutations: next,
      });
      return;
    }

    const exists = backendConfig.headerMutations.some(
      (m) => m.id === "hm-ua-override"
    );
    const next = exists
      ? backendConfig.headerMutations.map((m) =>
          m.id === "hm-ua-override"
            ? { ...m, enabled: true, headerValue: uaValue }
            : m
        )
      : [
          {
            id: "hm-ua-override",
            enabled: true,
            name: "Подмена User-Agent",
            direction: "request" as const,
            operation: "set" as const,
            headerName: "User-Agent",
            headerValue: uaValue,
            urlPattern: "*",
          },
          ...backendConfig.headerMutations,
        ];

    void onBackendConfigChange({
      ...backendConfig,
      headerMutationsEnabled: true,
      headerMutations: next,
    });
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="drawer-dialog m-0 ml-auto h-dvh max-h-dvh w-full max-w-4xl rounded-l-xl border-l border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:flex-col"
    >
      {/* Top Drawer Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline bg-elevated/60 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-500/15 text-sky-400 ring-1 ring-sky-500/30">
            <ListFilter className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-sm font-semibold text-fg">
              Таблицы фильтров, Hosts List &amp; TLS Bypass
            </h2>
            <p className="truncate text-[11px] text-muted">
              Массовый фильтр хостов (Whitelist/Blacklist), матрица Include/Exclude, фильтр по PID, пороги шума и SSL Passthrough
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span
            title="Количество сессий после применения всех активных фильтров"
            className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 font-mono text-[11px] font-semibold text-sky-400 tabular-nums"
          >
            {filteredCount.toLocaleString()} / {totalCount.toLocaleString()} сессий
          </span>

          <button
            type="button"
            onClick={onResetAll}
            title="Сбросить все табличные правила и пороги"
            className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2.5 py-1 text-xs text-muted transition-colors hover:border-strong hover:text-fg"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Сброс</span>
          </button>

          <form method="dialog">
            <button
              value="cancel"
              autoFocus
              {...({ autofocus: "" } as Record<string, string>)}
              aria-label="Закрыть панель фильтров"
              className="rounded-md border border-hairline bg-surface p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </form>
        </div>
      </div>

      {/* Sub-navigation Tabs */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-hairline bg-surface px-4 pt-2">
        <TabButton
          active={activeTab === "matrix"}
          onClick={() => setActiveTab("matrix")}
          icon={<ListFilter className="h-3.5 w-3.5" />}
          label="Матрица правил & Пресеты"
          badge={activeMatrixCount}
        />
        <TabButton
          active={activeTab === "hostsList"}
          onClick={() => setActiveTab("hostsList")}
          icon={<Globe className="h-3.5 w-3.5" />}
          label="Массовый фильтр хостов (Hosts List)"
          badge={activeHostListCount}
        />
        <TabButton
          active={activeTab === "thresholds"}
          onClick={() => setActiveTab("thresholds")}
          icon={<Gauge className="h-3.5 w-3.5" />}
          label="Пороги, Шум & Time Heat"
          badge={activeThresholdCount}
        />
        <TabButton
          active={activeTab === "tlsBypass"}
          onClick={() => setActiveTab("tlsBypass")}
          icon={<Target className="h-3.5 w-3.5" />}
          label={
            backendConfig.tlsInterceptMode === "targetedOnly"
              ? "MITM: Targeted Only"
              : "Selective MITM & Bypass"
          }
          badge={activeBypassCount}
          tone="teal"
        />
        <TabButton
          active={activeTab === "headers"}
          onClick={() => setActiveTab("headers")}
          icon={<Wand2 className="h-3.5 w-3.5" />}
          label="Мутация заголовков"
          badge={activeHeaderMutCount}
          tone="amber"
        />
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto bg-canvas p-4 space-y-4">
        {/* ================================================================ */}
        {/* TAB 1: FILTER RULES MATRIX, PRESETS & PROCESS FILTER             */}
        {/* ================================================================ */}
        {activeTab === "matrix" && (
          <>
            {/* Quick Callout to Bulk Hosts & URL List */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-fg">
                <Globe className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
                <span>
                  Нужно вставить 20–50 доменов или URL списком (как во вкладке Filters в Fiddler)?
                  {activeHostListCount > 0 && (
                    <span className="ml-1.5 font-mono text-[11px] font-semibold text-sky-400">
                      [Активно правил: {activeHostListCount} ({hostListFilter.mode === "whitelist" ? "Whitelist" : "Blacklist"})]
                    </span>
                  )}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab("hostsList")}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded bg-sky-600 px-2.5 text-xs font-medium text-white transition-colors hover:bg-sky-500"
              >
                <span>Открыть Hosts List</span>
              </button>
            </div>

            {/* Presets Bar */}
            <section className="rounded-lg border border-hairline bg-surface p-3 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                  <Sparkles className="h-3.5 w-3.5 text-sky-400" />
                  <span>Пресеты фильтрации (Presets)</span>
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newPresetName.trim()) return;
                    onSavePreset(newPresetName);
                    setNewPresetName("");
                  }}
                  className="flex items-center gap-1.5"
                >
                  <input
                    type="text"
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    placeholder="Имя нового пресета..."
                    aria-label="Имя нового пресета"
                    className="h-7 w-48 rounded border border-strong bg-canvas px-2 text-xs text-fg placeholder:text-subtle focus:border-sky-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!newPresetName.trim()}
                    className="inline-flex h-7 items-center gap-1 rounded bg-sky-600 px-2.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
                  >
                    <BookmarkPlus className="h-3.5 w-3.5" />
                    <span>Сохранить</span>
                  </button>
                </form>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {presets.map((p) => {
                  const isSelected = p.id === activePresetId;
                  return (
                    <div
                      key={p.id}
                      onClick={() => onApplyPreset(p.id)}
                      className={`group flex cursor-pointer items-start justify-between gap-2 rounded-md border p-2.5 text-left transition-colors ${
                        isSelected
                          ? "border-sky-500/60 bg-selected"
                          : "border-hairline bg-canvas hover:border-strong hover:bg-hover"
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-semibold text-fg">
                            {p.name}
                          </span>
                          {p.builtIn && (
                            <span className="rounded bg-elevated px-1 py-0.2 font-mono text-[9px] uppercase text-subtle">
                              Built-in
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">
                          {p.description}
                        </p>
                      </div>
                      {!p.builtIn && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeletePreset(p.id);
                          }}
                          title="Удалить пресет"
                          className="shrink-0 rounded p-1 text-subtle hover:bg-surface hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Local OS Process Quick Picker (PID / Process Name) */}
            <section className="rounded-lg border border-hairline bg-surface p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                  <Cpu className="h-3.5 w-3.5 text-violet-400" />
                  <span>Фильтр по локальному процессу (PID / Приложение)</span>
                </div>
                <span className="font-mono text-[10px] text-subtle">
                  Win32 GetExtendedTcpTable • macOS libproc • Linux /proc/net/tcp
                </span>
              </div>

              {detectedProcesses.length === 0 ? (
                <p className="text-[11px] text-muted">
                  Пока нет перехваченных локальных сокетов. Нажмите{" "}
                  <strong className="text-fg">+ Фильтр по процессу</strong> ниже, чтобы задать имя вручную (например,{" "}
                  <code className="font-mono text-sky-400">chrome.exe</code>,{" "}
                  <code className="font-mono text-sky-400">node.exe</code>,{" "}
                  <code className="font-mono text-sky-400">Postman.exe</code>).
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  {detectedProcesses.map((proc) => {
                    const isIncluded = rules.some(
                      (r) =>
                        r.enabled &&
                        r.action === "include" &&
                        r.field === "processName" &&
                        r.value.toLowerCase() === proc.name.toLowerCase()
                    );
                    const isExcluded = rules.some(
                      (r) =>
                        r.enabled &&
                        r.action === "exclude" &&
                        r.field === "processName" &&
                        r.value.toLowerCase() === proc.name.toLowerCase()
                    );

                    return (
                      <div
                        key={`${proc.name}-${proc.pid ?? "any"}`}
                        className={`inline-flex items-center rounded-md border font-mono text-[11px] ${
                          isIncluded
                            ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                            : isExcluded
                              ? "border-rose-500/50 bg-rose-500/15 text-rose-300"
                              : "border-hairline bg-canvas text-fg"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            onQuickProcessFilter(proc.name, "include")
                          }
                          title={`Показывать только трафик ${proc.name}${proc.pid ? ` (PID ${proc.pid})` : ""}`}
                          className="inline-flex items-center gap-1 px-2 py-1 hover:text-emerald-400"
                        >
                          <span className="font-semibold">{proc.name}</span>
                          {proc.pid !== null && (
                            <span className="text-[10px] text-muted">
                              :{proc.pid}
                            </span>
                          )}
                          <span className="rounded bg-elevated px-1 text-[10px] text-subtle">
                            {proc.count}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            onQuickProcessFilter(proc.name, "exclude")
                          }
                          title={`Исключить шум от процесса ${proc.name}`}
                          className="border-l border-hairline px-1.5 py-1 text-[10px] text-muted hover:bg-rose-500/20 hover:text-rose-300"
                        >
                          скрыть
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <datalist id={processDatalistId}>
                {detectedProcesses.map((p) => (
                  <option
                    key={`${p.name}-${p.pid ?? "x"}`}
                    value={p.name}
                  />
                ))}
                <option value="chrome.exe" />
                <option value="node.exe" />
                <option value="python.exe" />
                <option value="Postman.exe" />
                <option value="svchost.exe" />
              </datalist>
            </section>

            {/* Filter Rules Matrix Table */}
            <section className="rounded-lg border border-hairline bg-surface p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-fg">
                  <input
                    type="checkbox"
                    checked={matrixEnabled}
                    onChange={(e) => onMatrixEnabledChange(e.target.checked)}
                    className="checkbox-native"
                  />
                  <span>Матрица условий (Include / Exclude + группировка AND / OR)</span>
                </label>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      addMatrixRule("include", "path", "contains", "/api/")
                    }
                    className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/25"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Include условие</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      addMatrixRule("exclude", "host", "contains", "telemetry")
                    }
                    className="inline-flex items-center gap-1 rounded border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/25"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Exclude условие</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      addMatrixRule(
                        "include",
                        "processName",
                        "contains",
                        "chrome.exe"
                      )
                    }
                    className="inline-flex items-center gap-1 rounded border border-violet-500/40 bg-violet-500/15 px-2.5 py-1 text-xs font-medium text-violet-300 hover:bg-violet-500/25"
                  >
                    <Cpu className="h-3.5 w-3.5" />
                    <span>+ По процессу</span>
                  </button>
                </div>
              </div>

              {rules.length === 0 ? (
                <div className="rounded-md border border-dashed border-strong bg-canvas/60 px-4 py-6 text-center text-xs text-muted">
                  Таблица условий пуста — отображаются все перехваченные сессии. Выберите готовый пресет выше или добавьте правило{" "}
                  <strong className="text-emerald-400">Include</strong> /{" "}
                  <strong className="text-rose-400">Exclude</strong>.
                </div>
              ) : (
                <div className="filter-table-wrapper rounded-md border border-hairline">
                  <table
                    className="filter-data-table text-left text-xs"
                    style={
                      {
                        "--label-2": '"Логика"',
                        "--label-3": '"Поле"',
                        "--label-4": '"Значение"',
                      } as React.CSSProperties
                    }
                  >
                    <thead>
                      <tr className="border-b border-hairline font-mono text-[10px] uppercase tracking-wider text-subtle">
                        <th className="px-2.5 py-2">Вкл</th>
                        <th className="px-2 py-2">Связка</th>
                        <th className="px-2 py-2">Режим</th>
                        <th className="px-2 py-2">Поле (Field)</th>
                        <th className="px-2 py-2">Оператор</th>
                        <th className="px-2 py-2">Значение (Value)</th>
                        <th className="px-2 py-2 text-right">Действие</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rules.map((r, idx) => {
                        const isFirstOfAction =
                          (r.action === "include" && r.id === firstIncludeId) ||
                          (r.action === "exclude" && r.id === firstExcludeId);
                        const err = ruleErrors[r.id];

                        return (
                          <tr
                            key={r.id}
                            className={`border-b border-hairline/60 bg-canvas transition-colors hover:bg-hover/40 ${
                              !r.enabled || !matrixEnabled ? "opacity-55" : ""
                            }`}
                          >
                            <th scope="row" className="px-2.5 py-1.5 font-normal">
                              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={r.enabled}
                                  onChange={(e) =>
                                    updateMatrixRule(r.id, {
                                      enabled: e.target.checked,
                                    })
                                  }
                                  aria-label={`Включить правило ${idx + 1}`}
                                  className="checkbox-native"
                                />
                                <span className="font-mono text-[10px] text-subtle">
                                  #{idx + 1}
                                </span>
                              </label>
                            </th>

                            <td data-col="2" className="px-2 py-1.5">
                              {isFirstOfAction ? (
                                <span className="inline-block rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] font-semibold text-subtle">
                                  WHERE
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateMatrixRule(r.id, {
                                      logicalOp:
                                        r.logicalOp === "AND"
                                          ? ("OR" as FilterLogicalOp)
                                          : ("AND" as FilterLogicalOp),
                                    })
                                  }
                                  title="Переключить группировку: AND (внутри одной связки) / OR (новая альтернативная группа)"
                                  className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold transition-colors ${
                                    r.logicalOp === "AND"
                                      ? "bg-sky-500/20 text-sky-400 ring-1 ring-sky-500/40"
                                      : "bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/40"
                                  }`}
                                >
                                  {r.logicalOp}
                                </button>
                              )}
                            </td>

                            <td className="px-2 py-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  updateMatrixRule(r.id, {
                                    action:
                                      r.action === "include"
                                        ? "exclude"
                                        : "include",
                                  })
                                }
                                className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold uppercase transition-colors ${
                                  r.action === "include"
                                    ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40"
                                    : "bg-rose-500/20 text-rose-400 ring-1 ring-rose-500/40"
                                }`}
                              >
                                {r.action}
                              </button>
                            </td>

                            <td data-col="3" className="px-2 py-1.5">
                              <select
                                value={r.field}
                                onChange={(e) =>
                                  updateMatrixRule(r.id, {
                                    field: e.target.value as FilterField,
                                  })
                                }
                                aria-label="Поле фильтрации"
                                className="h-7 w-full min-w-[145px] rounded border border-strong bg-surface px-1.5 text-xs text-fg"
                              >
                                {FILTER_FIELD_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </td>

                            <td className="px-2 py-1.5">
                              <select
                                value={r.operator}
                                onChange={(e) =>
                                  updateMatrixRule(r.id, {
                                    operator: e.target.value as FilterOperator,
                                  })
                                }
                                aria-label="Оператор сравнения"
                                className="h-7 w-full min-w-[140px] rounded border border-strong bg-surface px-1.5 text-xs text-fg"
                              >
                                {FILTER_OPERATOR_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </td>

                            <td data-col="4" className="px-2 py-1.5">
                              <div className="space-y-0.5">
                                <input
                                  type="text"
                                  list={
                                    r.field === "processName"
                                      ? processDatalistId
                                      : undefined
                                  }
                                  value={r.value}
                                  onChange={(e) =>
                                    updateMatrixRule(r.id, {
                                      value: e.target.value,
                                    })
                                  }
                                  placeholder={placeholderForField(r.field)}
                                  aria-label="Значение условия"
                                  className={`h-7 w-full min-w-[170px] rounded border bg-surface px-2 font-mono text-xs text-fg placeholder:text-subtle focus:outline-none ${
                                    err
                                      ? "border-rose-500 ring-1 ring-rose-500/40"
                                      : "border-strong focus:border-sky-500"
                                  }`}
                                />
                                {err && (
                                  <span className="block font-mono text-[10px] text-rose-400">
                                    RegExp: {err}
                                  </span>
                                )}
                              </div>
                            </td>

                            <td className="px-2 py-1.5 text-right">
                              <button
                                type="button"
                                onClick={() => removeMatrixRule(r.id)}
                                title="Удалить условие"
                                className="rounded p-1 text-subtle hover:bg-surface hover:text-rose-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <p className="text-[11px] text-subtle">
                Группировка: соседние правила с оператором{" "}
                <code className="font-mono text-sky-400">AND</code> формируют единую конъюнкцию{" "}
                <code className="font-mono">(A &amp;&amp; B)</code>, а{" "}
                <code className="font-mono text-violet-300">OR</code> открывает альтернативную группу. Правила{" "}
                <code className="font-mono text-rose-400">Exclude</code> всегда имеют приоритет над{" "}
                <code className="font-mono text-emerald-400">Include</code>.
              </p>
            </section>
          </>
        )}

        {/* ================================================================ */}
        {/* TAB 1B: BULK HOSTS & URL LIST (WHITELIST / BLACKLIST + TLS SYNC) */}
        {/* ================================================================ */}
        {activeTab === "hostsList" && (
          <HostFiltersTab
            config={hostListFilter}
            compiled={compiledHostList}
            sessions={sessions}
            onChange={onHostListFilterChange}
            onNotify={onNotify}
          />
        )}

        {/* ================================================================ */}
        {/* TAB 2: NOISE CLEANUP, SIZE THRESHOLDS & TIME HEAT                */}
        {/* ================================================================ */}
        {activeTab === "thresholds" && (
          <>
            {/* Noise Cleanup Checkboxes */}
            <section className="rounded-lg border border-hairline bg-surface p-3.5 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                <Gauge className="h-4 w-4 text-sky-400" />
                <span>Автоматическая очистка протокольного и браузерного шума</span>
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <NoiseToggleCard
                  checked={thresholds.hide304NotModified}
                  onChange={(v) =>
                    onThresholdsChange((prev) => ({
                      ...prev,
                      hide304NotModified: v,
                    }))
                  }
                  title="Скрывать 304 Not Modified"
                  subtitle="Убирает условные ответы кэша браузера без тела ответа"
                />
                <NoiseToggleCard
                  checked={thresholds.hideOptionsPreflight}
                  onChange={(v) =>
                    onThresholdsChange((prev) => ({
                      ...prev,
                      hideOptionsPreflight: v,
                    }))
                  }
                  title="Скрывать CORS OPTIONS preflight"
                  subtitle="Скрывает служебные preflight-запросы перед POST/PUT/DELETE"
                />
                <NoiseToggleCard
                  checked={thresholds.hideConnectTunnels}
                  onChange={(v) =>
                    onThresholdsChange((prev) => ({
                      ...prev,
                      hideConnectTunnels: v,
                    }))
                  }
                  title="Скрывать CONNECT / TLS Bypass туннели"
                  subtitle="Оставляет только расшифрованные HTTP/HTTPS/WSS запросы"
                />
                <NoiseToggleCard
                  checked={thresholds.hideStaticAssets}
                  onChange={(v) =>
                    onThresholdsChange((prev) => ({
                      ...prev,
                      hideStaticAssets: v,
                    }))
                  }
                  title="Скрывать статику (Images / Fonts / CSS)"
                  subtitle="Скрывает картинки, шрифты .woff2, иконки и таблицы стилей"
                />
              </div>
            </section>

            {/* Payload Size Thresholds */}
            <section className="rounded-lg border border-hairline bg-surface p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-fg">
                  Пороги по объему тела ответа (Body Size)
                </span>
                <div className="flex flex-wrap items-center gap-1">
                  {[
                    { label: "Любой объем", min: null, max: null },
                    { label: "> 10 KB", min: 10 * 1024, max: null },
                    { label: "> 100 KB", min: 100 * 1024, max: null },
                    { label: "> 1 MB", min: 1024 * 1024, max: null },
                    { label: "< 50 KB", min: null, max: 50 * 1024 },
                  ].map((chip) => {
                    const active =
                      thresholds.minBodySizeBytes === chip.min &&
                      thresholds.maxBodySizeBytes === chip.max;
                    return (
                      <button
                        key={chip.label}
                        type="button"
                        onClick={() =>
                          onThresholdsChange((prev) => ({
                            ...prev,
                            minBodySizeBytes: chip.min,
                            maxBodySizeBytes: chip.max,
                          }))
                        }
                        className={`rounded px-2 py-0.5 font-mono text-[11px] transition-colors ${
                          active
                            ? "bg-sky-500/20 text-sky-400 ring-1 ring-sky-500/40"
                            : "bg-canvas text-muted hover:text-fg"
                        }`}
                      >
                        {chip.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 flex items-center justify-between text-[11px] text-muted">
                    <span>Минимальный размер (байт, 0/пусто — без лимита)</span>
                    {thresholds.minBodySizeBytes !== null && (
                      <span className="font-mono text-sky-400">
                        &ge; {formatBytes(thresholds.minBodySizeBytes)}
                      </span>
                    )}
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={1024}
                    value={thresholds.minBodySizeBytes ?? ""}
                    placeholder="Например: 1048576 (1 MB)"
                    onChange={(e) => {
                      const val = e.target.value.trim();
                      onThresholdsChange((prev) => ({
                        ...prev,
                        minBodySizeBytes:
                          val === "" ? null : Math.max(0, Number(val)),
                      }));
                    }}
                    className="h-8 w-full rounded border border-strong bg-canvas px-2.5 font-mono text-xs text-fg"
                  />
                </div>

                <div>
                  <label className="mb-1 flex items-center justify-between text-[11px] text-muted">
                    <span>Максимальный размер (байт, пусто — без лимита)</span>
                    {thresholds.maxBodySizeBytes !== null && (
                      <span className="font-mono text-sky-400">
                        &le; {formatBytes(thresholds.maxBodySizeBytes)}
                      </span>
                    )}
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={1024}
                    value={thresholds.maxBodySizeBytes ?? ""}
                    placeholder="Например: 51200 (50 KB)"
                    onChange={(e) => {
                      const val = e.target.value.trim();
                      onThresholdsChange((prev) => ({
                        ...prev,
                        maxBodySizeBytes:
                          val === "" ? null : Math.max(0, Number(val)),
                      }));
                    }}
                    className="h-8 w-full rounded border border-strong bg-canvas px-2.5 font-mono text-xs text-fg"
                  />
                </div>
              </div>
            </section>

            {/* Time Heat Coloring & Slow Request Filter */}
            <section className="rounded-lg border border-hairline bg-surface p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-fg">
                  <input
                    type="checkbox"
                    checked={thresholds.timeHeatEnabled}
                    onChange={(e) =>
                      onThresholdsChange((prev) => ({
                        ...prev,
                        timeHeatEnabled: e.target.checked,
                      }))
                    }
                    className="checkbox-native"
                  />
                  <Flame className="h-4 w-4 text-amber-400" />
                  <span>Time Heat — тепловая индикация медленных запросов</span>
                </label>

                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300">
                  <input
                    type="checkbox"
                    checked={thresholds.onlySlowRequests}
                    onChange={(e) =>
                      onThresholdsChange((prev) => ({
                        ...prev,
                        onlySlowRequests: e.target.checked,
                      }))
                    }
                    className="checkbox-native"
                  />
                  <span>
                    Только медленные (&ge; {thresholds.timeHeatWarningMs} ms)
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 flex items-center justify-between text-[11px] text-muted">
                    <span>Порог Warning (желто-оранжевая метка)</span>
                    <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-amber-300 tabular-nums">
                      {thresholds.timeHeatWarningMs} ms
                    </span>
                  </label>
                  <input
                    type="range"
                    min={50}
                    max={3000}
                    step={50}
                    value={thresholds.timeHeatWarningMs}
                    onChange={(e) => {
                      const warn = Number(e.target.value);
                      onThresholdsChange((prev) => ({
                        ...prev,
                        timeHeatWarningMs: warn,
                        timeHeatCriticalMs: Math.max(
                          prev.timeHeatCriticalMs,
                          warn + 100
                        ),
                      }));
                    }}
                    className="w-full cursor-pointer"
                  />
                </div>

                <div>
                  <label className="mb-1 flex items-center justify-between text-[11px] text-muted">
                    <span>Порог Critical (красная метка SLA)</span>
                    <span className="rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-rose-300 tabular-nums">
                      {thresholds.timeHeatCriticalMs} ms
                    </span>
                  </label>
                  <input
                    type="range"
                    min={200}
                    max={10000}
                    step={100}
                    value={thresholds.timeHeatCriticalMs}
                    onChange={(e) =>
                      onThresholdsChange((prev) => ({
                        ...prev,
                        timeHeatCriticalMs: Math.max(
                          prev.timeHeatWarningMs + 100,
                          Number(e.target.value)
                        ),
                      }))
                    }
                    className="w-full cursor-pointer"
                  />
                </div>
              </div>
            </section>
          </>
        )}

        {/* ================================================================ */}
        {/* TAB 3: SELECTIVE TLS MITM MODE (TARGETED ALLOWLIST & BYPASS)     */}
        {/* ================================================================ */}
        {activeTab === "tlsBypass" && (
          <div className="space-y-4">
            {/* Mode Switcher Cards */}
            <section className="rounded-lg border border-hairline bg-surface p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                  <Target className="h-4 w-4 text-teal-400" />
                  <span>
                    Режим работы TLS MITM («Чистый проброс» vs Полная инспекция)
                  </span>
                </div>

                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-hairline bg-canvas px-2.5 py-1 text-[11px] text-muted hover:border-strong hover:text-fg">
                  <input
                    type="checkbox"
                    checked={thresholds.hideConnectTunnels}
                    onChange={(e) =>
                      onThresholdsChange((prev) => ({
                        ...prev,
                        hideConnectTunnels: e.target.checked,
                      }))
                    }
                    className="checkbox-native"
                  />
                  <span>
                    Скрывать сквозные туннели{" "}
                    <code className="font-mono text-teal-300">PASSTHROUGH</code>{" "}
                    в таблице сессий
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() =>
                    void onBackendConfigChange({
                      ...backendConfig,
                      tlsInterceptMode: "interceptAll",
                    })
                  }
                  aria-pressed={
                    backendConfig.tlsInterceptMode !== "targetedOnly"
                  }
                  className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                    backendConfig.tlsInterceptMode !== "targetedOnly"
                      ? "border-sky-500/60 bg-sky-500/10 text-fg ring-1 ring-sky-500/30"
                      : "border-hairline bg-canvas text-muted hover:border-strong hover:text-fg"
                  }`}
                >
                  <div className="flex w-full items-center justify-between text-xs font-semibold">
                    <span className="flex items-center gap-1.5">
                      <Shield className="h-4 w-4 text-sky-400" />
                      <span>Mode: Intercept All (Except Bypass List)</span>
                    </span>
                    {backendConfig.tlsInterceptMode !== "targetedOnly" && (
                      <span className="rounded bg-sky-500/25 px-1.5 py-0.5 font-mono text-[10px] text-sky-200">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted">
                    Стандартный режим: расшифровывает весь HTTPS/WSS трафик, кроме
                    хостов из таблицы <strong className="text-fg">TLS Bypass</strong>{" "}
                    ниже.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    void onBackendConfigChange({
                      ...backendConfig,
                      tlsInterceptMode: "targetedOnly",
                    })
                  }
                  aria-pressed={
                    backendConfig.tlsInterceptMode === "targetedOnly"
                  }
                  className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                    backendConfig.tlsInterceptMode === "targetedOnly"
                      ? "border-teal-500/60 bg-teal-500/10 text-fg ring-1 ring-teal-500/30"
                      : "border-hairline bg-canvas text-muted hover:border-strong hover:text-fg"
                  }`}
                >
                  <div className="flex w-full items-center justify-between text-xs font-semibold">
                    <span className="flex items-center gap-1.5">
                      <Target className="h-4 w-4 text-teal-400" />
                      <span>Mode: Targeted Only (Allowlist)</span>
                    </span>
                    {backendConfig.tlsInterceptMode === "targetedOnly" && (
                      <span className="rounded bg-teal-500/25 px-1.5 py-0.5 font-mono text-[10px] text-teal-200">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted">
                    MITM-сертификаты генерируются{" "}
                    <strong className="text-teal-300">ТОЛЬКО</strong> для{" "}
                    <strong className="text-fg">Target Allowlist</strong>. Все
                    остальные <code className="font-mono">CONNECT</code>-запросы
                    (Telegram, Steam, банки, MS Teams, mTLS) уходят напрямую в{" "}
                    <code className="font-mono text-teal-300">
                      tokio::io::copy_bidirectional
                    </code>
                    !
                  </p>
                </button>
              </div>
            </section>

            {/* Target Allowlist Section (Primary in Targeted Only mode, also usable anytime) */}
            <section
              className={`rounded-lg border p-3.5 space-y-3 ${
                backendConfig.tlsInterceptMode === "targetedOnly"
                  ? "border-teal-500/45 bg-surface"
                  : "border-hairline bg-surface"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                  <Target className="h-4 w-4 text-teal-400" />
                  <span>
                    Target Allowlist — Целевые хосты для расшифровки (Targeted
                    Only)
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      const rule: TlsBypassRule = {
                        id: `target-local-${Date.now()}`,
                        enabled: true,
                        pattern: "localhost, 127.0.0.1, *.local",
                        category: "Local Dev",
                        description: "Локальные стенды и ASP.NET / SignalR хабы",
                      };
                      void onBackendConfigChange({
                        ...backendConfig,
                        tlsTargetRules: [
                          rule,
                          ...(backendConfig.tlsTargetRules ?? []),
                        ],
                      });
                    }}
                    className="rounded border border-hairline bg-canvas px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-teal-500/40 hover:text-teal-300"
                  >
                    + localhost / 127.0.0.1
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const rule: TlsBypassRule = {
                        id: `target-corp-${Date.now()}`,
                        enabled: true,
                        pattern: "*.mycompany.com, api.test.ru",
                        category: "Staging / Prod",
                        description: "Шаблон целевых корпоративных доменов",
                      };
                      void onBackendConfigChange({
                        ...backendConfig,
                        tlsTargetRules: [
                          rule,
                          ...(backendConfig.tlsTargetRules ?? []),
                        ],
                      });
                    }}
                    className="rounded border border-hairline bg-canvas px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-teal-500/40 hover:text-teal-300"
                  >
                    + *.mycompany.com, api.test.ru
                  </button>
                </div>
              </div>

              <p className="rounded-md border border-teal-500/25 bg-teal-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-muted">
                Поддерживаются точные домены (
                <code className="font-mono text-fg">api.test.ru</code>),
                поддомены (
                <code className="font-mono text-fg">*.mycompany.com</code>),{" "}
                <code className="font-mono text-fg">regex:...</code> и точечные
                исключения с префиксом{" "}
                <code className="font-mono text-amber-300">
                  !mtls.mycompany.com
                </code>
                . Вы также можете кликнуть правой кнопкой мыши по любой строке в
                таблице сессий →{" "}
                <strong className="text-fg">«Always inspect this host»</strong>.
              </p>

              <form
                onSubmit={handleAddTlsTarget}
                className="grid grid-cols-1 gap-2 rounded-md border border-hairline bg-canvas p-2.5 sm:grid-cols-12"
              >
                <input
                  type="text"
                  value={newTargetPattern}
                  onChange={(e) => setNewTargetPattern(e.target.value)}
                  placeholder="*.mycompany.com, api.test.ru"
                  aria-label="Целевой хост или маска для Target Allowlist"
                  className="h-8 rounded border border-strong bg-surface px-2.5 font-mono text-xs text-fg sm:col-span-5"
                />
                <select
                  value={newTargetCategory}
                  onChange={(e) => setNewTargetCategory(e.target.value)}
                  aria-label="Категория целевого хоста"
                  className="h-8 rounded border border-strong bg-surface px-2 text-xs text-fg sm:col-span-3"
                >
                  <option value="Target Service">Target Service</option>
                  <option value="SignalR / API">SignalR / API</option>
                  <option value="Local Dev">Local Dev</option>
                  <option value="Staging / Prod">Staging / Prod</option>
                </select>
                <input
                  type="text"
                  value={newTargetDesc}
                  onChange={(e) => setNewTargetDesc(e.target.value)}
                  placeholder="Заметка (необязательно)"
                  aria-label="Описание целевого правила"
                  className="h-8 rounded border border-strong bg-surface px-2.5 text-xs text-fg sm:col-span-3"
                />
                <button
                  type="submit"
                  disabled={!newTargetPattern.trim()}
                  className="inline-flex h-8 items-center justify-center gap-1 rounded bg-teal-600 px-2.5 text-xs font-semibold text-white hover:bg-teal-500 disabled:opacity-40 sm:col-span-1"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </form>

              {(backendConfig.tlsTargetRules ?? []).length === 0 ? (
                <div className="rounded-md border border-dashed border-strong bg-canvas/60 px-4 py-5 text-center text-xs text-muted">
                  Список <strong className="text-fg">Target Allowlist</strong>{" "}
                  пока пуст.{" "}
                  {backendConfig.tlsInterceptMode === "targetedOnly" ? (
                    <span className="text-amber-300">
                      Сейчас включён режим «Targeted Only» — все HTTPS/WSS
                      соединения проходят сквозным TCP-туннелем без расшифровки,
                      пока вы не добавите целевой хост выше или через ПКМ по
                      сессии!
                    </span>
                  ) : (
                    <span>
                      Добавьте целевые хосты (например{" "}
                      <code className="font-mono">*.mycompany.com</code>) и
                      переключите режим в{" "}
                      <strong className="text-teal-300">
                        Targeted Only (Allowlist)
                      </strong>
                      .
                    </span>
                  )}
                </div>
              ) : (
                <div className="filter-table-wrapper rounded-md border border-hairline">
                  <table
                    className="filter-data-table text-left text-xs"
                    style={
                      {
                        "--label-2": '"Целевой хост"',
                        "--label-3": '"Категория"',
                        "--label-4": '"Описание"',
                      } as React.CSSProperties
                    }
                  >
                    <thead>
                      <tr className="border-b border-hairline font-mono text-[10px] uppercase tracking-wider text-subtle">
                        <th className="px-2.5 py-2">Вкл</th>
                        <th className="px-2 py-2">
                          Целевой паттерн (Inspect Allowlist)
                        </th>
                        <th className="px-2 py-2">Категория</th>
                        <th className="px-2 py-2">Заметка</th>
                        <th className="px-2 py-2 text-right">Удалить</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(backendConfig.tlsTargetRules ?? []).map((item) => (
                        <tr
                          key={item.id}
                          className={`border-b border-hairline/60 bg-canvas hover:bg-hover/40 ${
                            !item.enabled ? "opacity-55" : ""
                          }`}
                        >
                          <th scope="row" className="px-2.5 py-1.5 font-normal">
                            <input
                              type="checkbox"
                              checked={item.enabled}
                              onChange={(e) => {
                                const next = (
                                  backendConfig.tlsTargetRules ?? []
                                ).map((r) =>
                                  r.id === item.id
                                    ? { ...r, enabled: e.target.checked }
                                    : r
                                );
                                void onBackendConfigChange({
                                  ...backendConfig,
                                  tlsTargetRules: next,
                                });
                              }}
                              aria-label={`Включить целевой хост ${item.pattern}`}
                              className="checkbox-native"
                            />
                          </th>
                          <td data-col="2" className="px-2 py-1.5">
                            <input
                              type="text"
                              value={item.pattern}
                              onChange={(e) => {
                                const next = (
                                  backendConfig.tlsTargetRules ?? []
                                ).map((r) =>
                                  r.id === item.id
                                    ? { ...r, pattern: e.target.value }
                                    : r
                                );
                                void onBackendConfigChange({
                                  ...backendConfig,
                                  tlsTargetRules: next,
                                });
                              }}
                              className="h-7 w-full min-w-[210px] rounded border border-strong bg-surface px-2 font-mono text-xs text-emerald-300"
                            />
                          </td>
                          <td data-col="3" className="px-2 py-1.5">
                            <span className="inline-block rounded bg-elevated px-2 py-0.5 font-mono text-[10px] text-muted">
                              {item.category}
                            </span>
                          </td>
                          <td data-col="4" className="px-2 py-1.5 text-muted">
                            {item.description}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <button
                              type="button"
                              onClick={() => {
                                const next = (
                                  backendConfig.tlsTargetRules ?? []
                                ).filter((r) => r.id !== item.id);
                                void onBackendConfigChange({
                                  ...backendConfig,
                                  tlsTargetRules: next,
                                });
                              }}
                              title="Удалить из списка Target Allowlist"
                              className="rounded p-1 text-subtle hover:bg-surface hover:text-rose-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Bypass List Section (Used in Intercept All mode) */}
            <section
              className={`rounded-lg border border-hairline bg-surface p-3.5 space-y-3 ${
                backendConfig.tlsInterceptMode === "targetedOnly"
                  ? "opacity-75"
                  : ""
              }`}
            >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-fg">
                <input
                  type="checkbox"
                  checked={backendConfig.tlsBypassEnabled}
                  onChange={(e) =>
                    void onBackendConfigChange({
                      ...backendConfig,
                      tlsBypassEnabled: e.target.checked,
                    })
                  }
                  className="checkbox-native"
                />
                <ShieldOff className="h-4 w-4 text-teal-400" />
                <span>
                  Таблица TLS / MITM Bypass (Исключения для режима «Intercept All»)
                </span>
              </label>

              <span className="rounded bg-teal-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-teal-300">
                tokio::io::copy_bidirectional
              </span>
            </div>

            <p className="rounded-md border border-teal-500/25 bg-teal-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-muted">
              Для совпадающих доменов (поддерживаются маски{" "}
              <code className="font-mono text-fg">*.apple.com</code>, списки через запятую и{" "}
              <code className="font-mono text-fg">regex:...</code>) прокси не вызывает{" "}
              <code className="font-mono text-teal-300">rcgen</code>, а пробрасывает{" "}
              <code className="font-mono text-teal-300">CONNECT</code>-туннель прозрачно байт-в-байт, предотвращая разрыв соединения клиентами с жестким пиннингом сертификатов.
            </p>

            {/* Quick Category Packs */}
            <div className="flex flex-wrap items-center gap-1.5">
              {TLS_BYPASS_QUICK_PACKS.map((pack) => (
                <button
                  key={pack.label}
                  type="button"
                  onClick={() => {
                    const rule: TlsBypassRule = {
                      id: `bypass-pack-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
                      ...pack.rule,
                    };
                    void onBackendConfigChange({
                      ...backendConfig,
                      tlsBypassEnabled: true,
                      tlsBypassRules: [rule, ...backendConfig.tlsBypassRules],
                    });
                  }}
                  className="rounded border border-hairline bg-canvas px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-teal-500/40 hover:text-teal-300"
                >
                  {pack.label}
                </button>
              ))}
            </div>

            {/* Add New TLS Bypass Rule Form */}
            <form
              onSubmit={handleAddTlsBypass}
              className="grid grid-cols-1 gap-2 rounded-md border border-hairline bg-canvas p-2.5 sm:grid-cols-12"
            >
              <input
                type="text"
                value={newBypassPattern}
                onChange={(e) => setNewBypassPattern(e.target.value)}
                placeholder="*.bank.ru, api.payments.io"
                aria-label="Домен или маска для TLS Bypass"
                className="h-8 rounded border border-strong bg-surface px-2.5 font-mono text-xs text-fg sm:col-span-5"
              />
              <select
                value={newBypassCategory}
                onChange={(e) => setNewBypassCategory(e.target.value)}
                aria-label="Категория домена"
                className="h-8 rounded border border-strong bg-surface px-2 text-xs text-fg sm:col-span-3"
              >
                <option value="Payment Gateways">Payment Gateways</option>
                <option value="OS Updaters">OS Updaters</option>
                <option value="Messengers">Messengers</option>
                <option value="Custom Pinning">Custom Pinning</option>
              </select>
              <input
                type="text"
                value={newBypassDesc}
                onChange={(e) => setNewBypassDesc(e.target.value)}
                placeholder="Описание (необязательно)"
                aria-label="Описание правила TLS Bypass"
                className="h-8 rounded border border-strong bg-surface px-2.5 text-xs text-fg sm:col-span-3"
              />
              <button
                type="submit"
                disabled={!newBypassPattern.trim()}
                className="inline-flex h-8 items-center justify-center gap-1 rounded bg-teal-600 px-2.5 text-xs font-semibold text-white hover:bg-teal-500 disabled:opacity-40 sm:col-span-1"
              >
                <Plus className="h-4 w-4" />
              </button>
            </form>

            {/* TLS Bypass Table */}
            <div className="filter-table-wrapper rounded-md border border-hairline">
              <table
                className="filter-data-table text-left text-xs"
                style={
                  {
                    "--label-2": '"Домен"',
                    "--label-3": '"Категория"',
                    "--label-4": '"Описание"',
                  } as React.CSSProperties
                }
              >
                <thead>
                  <tr className="border-b border-hairline font-mono text-[10px] uppercase tracking-wider text-subtle">
                    <th className="px-2.5 py-2">Вкл</th>
                    <th className="px-2 py-2">Паттерн домена (Host / Wildcard)</th>
                    <th className="px-2 py-2">Категория</th>
                    <th className="px-2 py-2">Заметка</th>
                    <th className="px-2 py-2 text-right">Удалить</th>
                  </tr>
                </thead>
                <tbody>
                  {backendConfig.tlsBypassRules.map((item) => (
                    <tr
                      key={item.id}
                      className={`border-b border-hairline/60 bg-canvas hover:bg-hover/40 ${
                        !item.enabled || !backendConfig.tlsBypassEnabled
                          ? "opacity-55"
                          : ""
                      }`}
                    >
                      <th scope="row" className="px-2.5 py-1.5 font-normal">
                        <input
                          type="checkbox"
                          checked={item.enabled}
                          onChange={(e) => {
                            const next = backendConfig.tlsBypassRules.map((r) =>
                              r.id === item.id
                                ? { ...r, enabled: e.target.checked }
                                : r
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              tlsBypassRules: next,
                            });
                          }}
                          aria-label={`Включить TLS Bypass для ${item.pattern}`}
                          className="checkbox-native"
                        />
                      </th>
                      <td data-col="2" className="px-2 py-1.5">
                        <input
                          type="text"
                          value={item.pattern}
                          onChange={(e) => {
                            const next = backendConfig.tlsBypassRules.map((r) =>
                              r.id === item.id
                                ? { ...r, pattern: e.target.value }
                                : r
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              tlsBypassRules: next,
                            });
                          }}
                          className="h-7 w-full min-w-[210px] rounded border border-strong bg-surface px-2 font-mono text-xs text-teal-300"
                        />
                      </td>
                      <td data-col="3" className="px-2 py-1.5">
                        <span className="inline-block rounded bg-elevated px-2 py-0.5 font-mono text-[10px] text-muted">
                          {item.category}
                        </span>
                      </td>
                      <td data-col="4" className="px-2 py-1.5 text-muted">
                        {item.description}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            const next = backendConfig.tlsBypassRules.filter(
                              (r) => r.id !== item.id
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              tlsBypassRules: next,
                            });
                          }}
                          title="Удалить из списка TLS Bypass"
                          className="rounded p-1 text-subtle hover:bg-surface hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          </div>
        )}

        {/* ================================================================ */}
        {/* TAB 4: LIGHTWEIGHT HEADER MUTATIONS                              */}
        {/* ================================================================ */}
        {activeTab === "headers" && (
          <section className="rounded-lg border border-hairline bg-surface p-3.5 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-fg">
                <input
                  type="checkbox"
                  checked={backendConfig.headerMutationsEnabled}
                  onChange={(e) =>
                    void onBackendConfigChange({
                      ...backendConfig,
                      headerMutationsEnabled: e.target.checked,
                    })
                  }
                  className="checkbox-native"
                />
                <Wand2 className="h-4 w-4 text-amber-400" />
                <span>Легкая мутация HTTP-заголовков на лету (без создания моков)</span>
              </label>

              <button
                type="button"
                onClick={addHeaderMutationRule}
                className="inline-flex items-center gap-1 rounded bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Добавить правило</span>
              </button>
            </div>

            {/* One-Click Quick Controls: Cache Bypass + User-Agent Spoofing */}
            <div className="grid grid-cols-1 gap-3 rounded-md border border-hairline bg-canvas p-3 sm:grid-cols-2">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={isForceNoCacheActive}
                  onChange={() => void onToggleForceNoCache()}
                  className="checkbox-native mt-0.5"
                />
                <div className="min-w-0">
                  <span className="block text-xs font-semibold text-fg">
                    Принудительный обход кэша (Force No-Cache)
                  </span>
                  <span className="block text-[11px] text-muted">
                    Удаляет <code className="font-mono">If-Modified-Since</code>,{" "}
                    <code className="font-mono">If-None-Match</code> из запроса и{" "}
                    <code className="font-mono">ETag</code>,{" "}
                    <code className="font-mono">Last-Modified</code> из ответа
                  </span>
                </div>
              </label>

              <div>
                <label className="mb-1 block text-xs font-semibold text-fg">
                  Быстрая подмена User-Agent
                </label>
                <select
                  value={currentUaSelectValue}
                  onChange={(e) => handleQuickUserAgentSelect(e.target.value)}
                  aria-label="Профиль подмены User-Agent"
                  className="h-8 w-full rounded border border-strong bg-surface px-2 text-xs text-fg"
                >
                  <option value="">Не подменять (оригинальный User-Agent клиента)</option>
                  {USER_AGENT_PRESETS.map((ua) => (
                    <option key={ua.label} value={ua.value}>
                      {ua.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Full Header Mutations Table */}
            <div className="filter-table-wrapper rounded-md border border-hairline">
              <table
                className="filter-data-table text-left text-xs"
                style={
                  {
                    "--label-2": '"Этап"',
                    "--label-3": '"Заголовок"',
                    "--label-4": '"Значение"',
                  } as React.CSSProperties
                }
              >
                <thead>
                  <tr className="border-b border-hairline font-mono text-[10px] uppercase tracking-wider text-subtle">
                    <th className="px-2.5 py-2">Вкл</th>
                    <th className="px-2 py-2">Этап</th>
                    <th className="px-2 py-2">Операция</th>
                    <th className="px-2 py-2">Заголовок(и)</th>
                    <th className="px-2 py-2">Новое значение</th>
                    <th className="px-2 py-2">URL Scope</th>
                    <th className="px-2 py-2 text-right">Удалить</th>
                  </tr>
                </thead>
                <tbody>
                  {backendConfig.headerMutations.map((m) => (
                    <tr
                      key={m.id}
                      className={`border-b border-hairline/60 bg-canvas hover:bg-hover/40 ${
                        !m.enabled || !backendConfig.headerMutationsEnabled
                          ? "opacity-55"
                          : ""
                      }`}
                    >
                      <th scope="row" className="px-2.5 py-1.5 font-normal">
                        <input
                          type="checkbox"
                          checked={m.enabled}
                          onChange={(e) => {
                            const next = backendConfig.headerMutations.map(
                              (item) =>
                                item.id === m.id
                                  ? { ...item, enabled: e.target.checked }
                                  : item
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          aria-label={`Включить мутацию ${m.headerName}`}
                          className="checkbox-native"
                        />
                      </th>

                      <td data-col="2" className="px-2 py-1.5">
                        <select
                          value={m.direction}
                          onChange={(e) => {
                            const next = backendConfig.headerMutations.map(
                              (item) =>
                                item.id === m.id
                                  ? {
                                      ...item,
                                      direction: e.target
                                        .value as HeaderMutationDirection,
                                    }
                                  : item
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          className="h-7 rounded border border-strong bg-surface px-1.5 text-xs text-fg"
                        >
                          <option value="request">Request</option>
                          <option value="response">Response</option>
                        </select>
                      </td>

                      <td className="px-2 py-1.5">
                        <select
                          value={m.operation}
                          onChange={(e) => {
                            const next = backendConfig.headerMutations.map(
                              (item) =>
                                item.id === m.id
                                  ? {
                                      ...item,
                                      operation: e.target
                                        .value as HeaderMutationOp,
                                    }
                                  : item
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          className="h-7 rounded border border-strong bg-surface px-1.5 font-mono text-xs text-fg"
                        >
                          <option value="remove">Remove (Удалить)</option>
                          <option value="set">Set (Заменить)</option>
                          <option value="append">Append (Добавить)</option>
                        </select>
                      </td>

                      <td data-col="3" className="px-2 py-1.5">
                        <input
                          type="text"
                          value={m.headerName}
                          onChange={(e) => {
                            const next = backendConfig.headerMutations.map(
                              (item) =>
                                item.id === m.id
                                  ? { ...item, headerName: e.target.value }
                                  : item
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          placeholder="If-Modified-Since, ETag"
                          className="h-7 w-full min-w-[155px] rounded border border-strong bg-surface px-2 font-mono text-xs text-sky-400"
                        />
                      </td>

                      <td data-col="4" className="px-2 py-1.5">
                        <input
                          type="text"
                          disabled={m.operation === "remove"}
                          value={m.headerValue}
                          onChange={(e) => {
                            const next = backendConfig.headerMutations.map(
                              (item) =>
                                item.id === m.id
                                  ? { ...item, headerValue: e.target.value }
                                  : item
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          placeholder={
                            m.operation === "remove"
                              ? "— удаляется —"
                              : "Значение заголовка..."
                          }
                          className="h-7 w-full min-w-[170px] rounded border border-strong bg-surface px-2 font-mono text-xs text-fg disabled:opacity-45"
                        />
                      </td>

                      <td className="px-2 py-1.5">
                        <input
                          type="text"
                          value={m.urlPattern}
                          onChange={(e) => {
                            const next = backendConfig.headerMutations.map(
                              (item) =>
                                item.id === m.id
                                  ? { ...item, urlPattern: e.target.value }
                                  : item
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          placeholder="* или api.host"
                          className="h-7 w-28 rounded border border-strong bg-surface px-2 font-mono text-xs text-muted"
                        />
                      </td>

                      <td className="px-2 py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            const next = backendConfig.headerMutations.filter(
                              (item) => item.id !== m.id
                            );
                            void onBackendConfigChange({
                              ...backendConfig,
                              headerMutations: next,
                            });
                          }}
                          title="Удалить правило мутации"
                          className="rounded p-1 text-subtle hover:bg-surface hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </dialog>
  );
};

function placeholderForField(field: FilterField): string {
  switch (field) {
    case "processName":
      return "chrome.exe / node.exe / Postman";
    case "processPid":
      return "14280";
    case "status":
      return "200 / 401 / 500";
    case "bodySize":
      return "1MB / 500KB / 65536";
    case "durationMs":
      return "500 / 1.5s";
    case "method":
      return "GET / POST / OPTIONS";
    case "contentType":
      return "json / xml / image";
    case "host":
      return "api.stripe.com";
    case "path":
      return "/api/v1/";
    default:
      return "Значение или шаблон...";
  }
}

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

const NoiseToggleCard: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  subtitle: string;
}> = ({ checked, onChange, title, subtitle }) => (
  <label
    className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors ${
      checked
        ? "border-sky-500/50 bg-selected"
        : "border-hairline bg-canvas hover:bg-hover"
    }`}
  >
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="checkbox-native mt-0.5"
    />
    <div className="min-w-0">
      <span className="block text-xs font-semibold text-fg">{title}</span>
      <span className="block text-[11px] text-muted">{subtitle}</span>
    </div>
  </label>
);
