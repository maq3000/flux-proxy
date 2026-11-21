import React from "react";
import { Flame, Gauge } from "lucide-react";
import { formatBytes } from "../../lib/formatters";
import type { NoiseThresholdsConfig } from "../../types/proxy";

export interface ThresholdsTabProps {
  thresholds: NoiseThresholdsConfig;
  onThresholdsChange: (
    updater:
      | NoiseThresholdsConfig
      | ((prev: NoiseThresholdsConfig) => NoiseThresholdsConfig)
  ) => void;
}

export const ThresholdsTab: React.FC<ThresholdsTabProps> = ({
  thresholds,
  onThresholdsChange,
}) => {
  return (
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
