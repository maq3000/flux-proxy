import React, { useState } from "react";
import { ExternalLink, Plus, RotateCcw, Trash2 } from "lucide-react";
import { BUILT_IN_FILTER_PRESETS, type CompiledHostListFilter } from "../../lib/filterEngine";
import type {
  FilterConditionRule,
  FilterPreset,
  HostListFilterConfig,
  HostListFilterMode,
  NoiseThresholdsConfig,
} from "../../types/proxy";

export interface FiltersSettingsTabProps {
  baseId: string;
  activePresetId: string | null;
  userPresets: FilterPreset[];
  onApplyPreset: (presetId: string | null) => void;
  onSaveCustomPreset: (name: string, description: string) => void;
  onDeleteCustomPreset: (presetId: string) => void;
  matrixEnabled: boolean;
  onSetMatrixEnabled: (enabled: boolean) => void;
  filterRules: FilterConditionRule[];
  noiseThresholds: NoiseThresholdsConfig;
  onSetNoiseThresholds: (
    updater:
      | NoiseThresholdsConfig
      | ((prev: NoiseThresholdsConfig) => NoiseThresholdsConfig)
  ) => void;
  hostFilters: HostListFilterConfig;
  compiledHosts: CompiledHostListFilter;
  onSetHostFilters: (
    updater:
      | HostListFilterConfig
      | ((prev: HostListFilterConfig) => HostListFilterConfig)
  ) => void;
  onResetAdvancedFilters: () => void;
  onOpenFilterDrawer: () => void;
  onCloseDialog: () => void;
}

export const FiltersSettingsTab: React.FC<FiltersSettingsTabProps> = ({
  baseId,
  activePresetId,
  userPresets,
  onApplyPreset,
  onSaveCustomPreset,
  onDeleteCustomPreset,
  matrixEnabled,
  onSetMatrixEnabled,
  filterRules,
  noiseThresholds,
  onSetNoiseThresholds,
  hostFilters,
  compiledHosts,
  onSetHostFilters,
  onResetAdvancedFilters,
  onOpenFilterDrawer,
  onCloseDialog,
}) => {
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [presetDescDraft, setPresetDescDraft] = useState("");
  const [presetNameError, setPresetNameError] = useState<string | null>(null);

  const handleCreatePreset = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = presetNameDraft.trim();
    if (!cleanName) {
      setPresetNameError("Введите название пресета фильтров.");
      return;
    }
    onSaveCustomPreset(
      cleanName,
      presetDescDraft.trim() || "Пользовательский пресет фильтров"
    );
    setPresetNameDraft("");
    setPresetDescDraft("");
    setPresetNameError(null);
  };

  return (
              <>
                <div className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold text-fg">
                      Пресеты фильтрации ({userPresets.length} пользовательских)
                    </h3>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          onCloseDialog();
                          onOpenFilterDrawer();
                        }}
                        className="inline-flex items-center gap-1 rounded border border-accent/40 bg-selected px-2.5 py-1 text-[11px] font-medium text-fg hover:brightness-110"
                      >
                        <ExternalLink className="h-3 w-3 text-accent" />
                        <span>Открыть Filter Matrix ({filterRules.length})</span>
                      </button>
                      <button
                        type="button"
                        onClick={onResetAdvancedFilters}
                        className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-muted hover:border-strong hover:text-fg"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>Сбросить фильтры</span>
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <label
                      htmlFor={`${baseId}-active-preset`}
                      className="text-[11px] font-medium text-muted"
                    >
                      Активный пресет:
                    </label>
                    <select
                      id={`${baseId}-active-preset`}
                      value={activePresetId ?? ""}
                      onChange={(e) =>
                        onApplyPreset(e.target.value ? e.target.value : null)
                      }
                      className="h-8 min-w-56 rounded-md border border-strong bg-surface px-2.5 text-xs text-fg"
                    >
                      <option value="">Без пресета (ручная настройка)</option>
                      <optgroup label="Встроенные пресеты">
                        {BUILT_IN_FILTER_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                      {userPresets.length > 0 && (
                        <optgroup label="Пользовательские пресеты">
                          {userPresets.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>

                    <label
                      htmlFor={`${baseId}-matrix-enabled`}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 py-1.5"
                    >
                      <input
                        id={`${baseId}-matrix-enabled`}
                        type="checkbox"
                        checked={matrixEnabled}
                        onChange={(e) => onSetMatrixEnabled(e.target.checked)}
                        className="checkbox-native"
                      />
                      <span className="text-[11px] font-medium text-fg">
                        Filter Matrix активна
                      </span>
                    </label>
                  </div>

                  <form
                    onSubmit={handleCreatePreset}
                    className="grid grid-cols-1 gap-2 border-t border-hairline pt-2.5 sm:grid-cols-12"
                  >
                    <div className="sm:col-span-4">
                      <label
                        htmlFor={`${baseId}-preset-name`}
                        className="mb-1 block text-[10px] font-medium text-muted"
                      >
                        Сохранить текущие фильтры как пресет
                      </label>
                      <input
                        id={`${baseId}-preset-name`}
                        type="text"
                        placeholder="Название пресета…"
                        value={presetNameDraft}
                        aria-invalid={presetNameError ? "true" : undefined}
                        onChange={(e) => {
                          setPresetNameDraft(e.target.value);
                          if (presetNameError) setPresetNameError(null);
                        }}
                        onBlur={(e) => {
                          if (
                            e.currentTarget.value.length > 0 &&
                            !e.currentTarget.value.trim()
                          ) {
                            setPresetNameError(
                              "Введите название пресета фильтров."
                            );
                          }
                        }}
                        className="h-8 w-full rounded border border-strong bg-surface px-2 text-xs text-fg"
                      />
                    </div>
                    <div className="sm:col-span-5">
                      <label
                        htmlFor={`${baseId}-preset-desc`}
                        className="mb-1 block text-[10px] font-medium text-muted"
                      >
                        Описание
                      </label>
                      <input
                        id={`${baseId}-preset-desc`}
                        type="text"
                        placeholder="Краткое описание условий…"
                        value={presetDescDraft}
                        onChange={(e) => setPresetDescDraft(e.target.value)}
                        className="h-8 w-full rounded border border-strong bg-surface px-2 text-xs text-fg"
                      />
                    </div>
                    <div className="flex items-end sm:col-span-3">
                      <button
                        type="submit"
                        className="inline-flex h-8 w-full items-center justify-center gap-1 rounded bg-sky-600 px-2.5 text-xs font-medium text-white hover:bg-sky-500"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>Сохранить</span>
                      </button>
                    </div>
                    {presetNameError && (
                      <p className="text-[11px] text-status5xx-fg sm:col-span-12">
                        {presetNameError}
                      </p>
                    )}
                  </form>

                  {userPresets.length > 0 && (
                    <div className="space-y-1 border-t border-hairline pt-2">
                      {userPresets.map((preset) => (
                        <div
                          key={preset.id}
                          className="flex items-center justify-between gap-2 rounded border border-hairline bg-surface px-2.5 py-1.5"
                        >
                          <div className="min-w-0">
                            <span className="font-medium text-fg">
                              {preset.name}
                            </span>
                            <span className="ml-2 text-[11px] text-muted">
                              ({preset.rules.length} правил) — {preset.description}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => onApplyPreset(preset.id)}
                              className="rounded border border-hairline bg-elevated px-2 py-0.5 text-[11px] text-fg hover:bg-hover"
                            >
                              Применить
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteCustomPreset(preset.id)}
                              aria-label={`Удалить пресет ${preset.name}`}
                              className="rounded p-1 text-muted hover:bg-rose-500/10 hover:text-rose-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5">
                  <h3 className="text-xs font-semibold text-fg">
                    Пороги шума и времени ответа (Noise Thresholds)
                  </h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {(
                      [
                        {
                          key: "hide304NotModified",
                          label: "Скрывать 304 Not Modified",
                        },
                        {
                          key: "hideOptionsPreflight",
                          label: "Скрывать CORS OPTIONS preflight",
                        },
                        {
                          key: "hideConnectTunnels",
                          label: "Скрывать пустые туннели CONNECT",
                        },
                        {
                          key: "hideStaticAssets",
                          label: "Скрывать статику (.css, .js, шрифты, иконки)",
                        },
                        {
                          key: "timeHeatEnabled",
                          label: "Подсветка медленных запросов (Time Heat)",
                        },
                        {
                          key: "onlySlowRequests",
                          label: "Показывать только медленные запросы",
                        },
                      ] as const
                    ).map((item) => {
                      const chkId = `${baseId}-th-${item.key}`;
                      return (
                        <label
                          key={item.key}
                          htmlFor={chkId}
                          className="flex cursor-pointer items-center gap-2 rounded border border-hairline bg-surface p-2"
                        >
                          <input
                            id={chkId}
                            type="checkbox"
                            checked={noiseThresholds[item.key]}
                            onChange={(e) =>
                              onSetNoiseThresholds((prev) => ({
                                ...prev,
                                [item.key]: e.target.checked,
                              }))
                            }
                            className="checkbox-native"
                          />
                          <span className="text-fg">{item.label}</span>
                        </label>
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 border-t border-hairline pt-2.5 sm:grid-cols-4">
                    <div>
                      <label
                        htmlFor={`${baseId}-th-warn-ms`}
                        className="mb-1 block text-[10px] text-muted"
                      >
                        Warning (ms)
                      </label>
                      <input
                        id={`${baseId}-th-warn-ms`}
                        type="number"
                        min={10}
                        max={120000}
                        value={noiseThresholds.timeHeatWarningMs}
                        onChange={(e) => {
                          const val = Math.max(
                            10,
                            Number(e.target.value) || 500
                          );
                          onSetNoiseThresholds((prev) => ({
                            ...prev,
                            timeHeatWarningMs: val,
                            timeHeatCriticalMs: Math.max(
                              prev.timeHeatCriticalMs,
                              val
                            ),
                          }));
                        }}
                        className="h-7 w-full rounded border border-strong bg-surface px-2 font-mono text-xs text-fg tabular-nums"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`${baseId}-th-crit-ms`}
                        className="mb-1 block text-[10px] text-muted"
                      >
                        Critical (ms)
                      </label>
                      <input
                        id={`${baseId}-th-crit-ms`}
                        type="number"
                        min={10}
                        max={300000}
                        value={noiseThresholds.timeHeatCriticalMs}
                        onChange={(e) => {
                          const val = Math.max(
                            noiseThresholds.timeHeatWarningMs,
                            Number(e.target.value) || 1500
                          );
                          onSetNoiseThresholds((prev) => ({
                            ...prev,
                            timeHeatCriticalMs: val,
                          }));
                        }}
                        className="h-7 w-full rounded border border-strong bg-surface px-2 font-mono text-xs text-fg tabular-nums"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`${baseId}-th-min-bytes`}
                        className="mb-1 block text-[10px] text-muted"
                      >
                        Min Body (bytes)
                      </label>
                      <input
                        id={`${baseId}-th-min-bytes`}
                        type="number"
                        min={0}
                        placeholder="Нет"
                        value={noiseThresholds.minBodySizeBytes ?? ""}
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          onSetNoiseThresholds((prev) => ({
                            ...prev,
                            minBodySizeBytes:
                              raw === ""
                                ? null
                                : Math.max(0, Math.round(Number(raw) || 0)),
                          }));
                        }}
                        className="h-7 w-full rounded border border-strong bg-surface px-2 font-mono text-xs text-fg tabular-nums"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`${baseId}-th-max-bytes`}
                        className="mb-1 block text-[10px] text-muted"
                      >
                        Max Body (bytes)
                      </label>
                      <input
                        id={`${baseId}-th-max-bytes`}
                        type="number"
                        min={0}
                        placeholder="Нет"
                        value={noiseThresholds.maxBodySizeBytes ?? ""}
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          onSetNoiseThresholds((prev) => ({
                            ...prev,
                            maxBodySizeBytes:
                              raw === ""
                                ? null
                                : Math.max(0, Math.round(Number(raw) || 0)),
                          }));
                        }}
                        className="h-7 w-full rounded border border-strong bg-surface px-2 font-mono text-xs text-fg tabular-nums"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-2.5 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label
                      htmlFor={`${baseId}-host-filter-enabled`}
                      className="inline-flex cursor-pointer items-center gap-2 font-semibold text-fg"
                    >
                      <input
                        id={`${baseId}-host-filter-enabled`}
                        type="checkbox"
                        checked={hostFilters.enabled}
                        onChange={(e) =>
                          onSetHostFilters((prev) => ({
                            ...prev,
                            enabled: e.target.checked,
                          }))
                        }
                        className="checkbox-native"
                      />
                      <span>
                        Фильтр списков доменов (Host Filters — активно токенов:{" "}
                        {compiledHosts.activeCount})
                      </span>
                    </label>

                    <label
                      htmlFor={`${baseId}-host-tls-sync`}
                      className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted"
                    >
                      <input
                        id={`${baseId}-host-tls-sync`}
                        type="checkbox"
                        checked={hostFilters.applyToTlsPassthrough}
                        onChange={(e) =>
                          onSetHostFilters((prev) => ({
                            ...prev,
                            applyToTlsPassthrough: e.target.checked,
                          }))
                        }
                        className="checkbox-native"
                      />
                      <span>Синхронизировать с TLS Passthrough</span>
                    </label>
                  </div>

                  <fieldset className="flex flex-wrap items-center gap-3">
                    <legend className="sr-only">Режим фильтрации хостов</legend>
                    {(
                      [
                        {
                          value: "whitelist",
                          label: "Whitelist (показывать только указанные)",
                        },
                        {
                          value: "blacklist",
                          label: "Blacklist (скрывать указанные)",
                        },
                      ] as { value: HostListFilterMode; label: string }[]
                    ).map((m) => {
                      const rId = `${baseId}-host-mode-${m.value}`;
                      return (
                        <label
                          key={m.value}
                          htmlFor={rId}
                          className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-fg"
                        >
                          <input
                            id={rId}
                            type="radio"
                            name={`${baseId}-host-mode`}
                            value={m.value}
                            checked={hostFilters.mode === m.value}
                            onChange={() =>
                              onSetHostFilters((prev) => ({
                                ...prev,
                                mode: m.value,
                              }))
                            }
                            className="cursor-pointer accent-[var(--accent-primary)]"
                          />
                          <span>{m.label}</span>
                        </label>
                      );
                    })}
                  </fieldset>

                  <div>
                    <label
                      htmlFor={`${baseId}-host-raw-text`}
                      className="mb-1 block text-[11px] text-muted"
                    >
                      Список доменов и масок (через перевод строки, пробел или точку с запятой, например{" "}
                      <code className="font-mono">*.api.local</code>)
                    </label>
                    <textarea
                      id={`${baseId}-host-raw-text`}
                      rows={4}
                      value={hostFilters.rawText}
                      onChange={(e) =>
                        onSetHostFilters((prev) => ({
                          ...prev,
                          rawText: e.target.value,
                        }))
                      }
                      placeholder="*.example.com&#10;api.staging.local"
                      className="w-full rounded-md border border-strong bg-surface p-2 font-mono text-xs text-fg focus:border-accent focus:outline-none"
                    />
                  </div>
                </div>
              </>
  );
};
