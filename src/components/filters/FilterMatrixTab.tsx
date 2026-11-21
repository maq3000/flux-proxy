import React, { useId, useState } from "react";
import {
  BookmarkPlus,
  Cpu,
  Globe,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  FILTER_FIELD_OPTIONS,
  FILTER_OPERATOR_OPTIONS,
} from "../../lib/filterEngine";
import type {
  DetectedProcessItem,
  FilterConditionRule,
  FilterField,
  FilterLogicalOp,
  FilterOperator,
  FilterPreset,
  FilterRuleAction,
  HostListFilterConfig,
} from "../../types/proxy";

export interface FilterMatrixTabProps {
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
  detectedProcesses: DetectedProcessItem[];
  onQuickProcessFilter: (
    processName: string,
    action: "include" | "exclude"
  ) => void;
  hostListFilter: HostListFilterConfig;
  activeHostListCount: number;
  onSwitchToHostsTab: () => void;
}

export const FilterMatrixTab: React.FC<FilterMatrixTabProps> = ({
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
  detectedProcesses,
  onQuickProcessFilter,
  hostListFilter,
  activeHostListCount,
  onSwitchToHostsTab,
}) => {
  const [newPresetName, setNewPresetName] = useState("");
  const processDatalistId = useId();

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

  return (
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
                onClick={() => onSwitchToHostsTab()}
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
