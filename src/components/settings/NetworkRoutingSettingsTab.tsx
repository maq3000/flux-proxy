import React, { useEffect, useId, useState } from "react";
import {
  Check,
  Clock,
  Gauge,
  Globe,
  Network,
  RotateCcw,
  WifiOff,
} from "lucide-react";
import { HelpTooltip } from "../ui/HelpTooltip";
import { HostRemapPanel } from "./HostRemapPanel";
import { UpstreamProxyPanel } from "./UpstreamProxyPanel";
import { UpstreamTimeoutsSection } from "./UpstreamTimeoutsSection";
import {
  THROTTLE_PRESET_DEFINITIONS,
  type ProxyStatus,
  type ThrottleConfig,
  type ThrottlePreset,
  type UpstreamProxyConfig,
  type UpstreamTimeoutConfig,
} from "../../types/proxy";
import type { SettingsNetworkSubTab } from "../../types/settings";

export interface NetworkRoutingSettingsTabProps {
  baseId: string;
  activeSubTab: SettingsNetworkSubTab;
  onSubTabChange: (subTab: SettingsNetworkSubTab) => void;
  status: ProxyStatus;
  throttleConfig: ThrottleConfig;
  onChangeThrottleConfig: (cfg: ThrottleConfig) => Promise<void> | void;
  activeHostRemapCount: number;
  upstreamProxyConfig: UpstreamProxyConfig;
  onSaveUpstreamProxyConfig: (next: UpstreamProxyConfig) => Promise<void>;
  upstreamTimeouts: UpstreamTimeoutConfig;
  onSetUpstreamTimeouts: (config: UpstreamTimeoutConfig) => Promise<void>;
  onNotify: (msg: string) => void;
}

export const NetworkRoutingSettingsTab: React.FC<
  NetworkRoutingSettingsTabProps
> = ({
  baseId,
  activeSubTab,
  onSubTabChange,
  status,
  throttleConfig,
  onChangeThrottleConfig,
  activeHostRemapCount,
  upstreamProxyConfig,
  onSaveUpstreamProxyConfig,
  upstreamTimeouts,
  onSetUpstreamTimeouts,
  onNotify,
}) => {
  const downInputId = useId();
  const upInputId = useId();
  const latencyInputId = useId();

  const [customDownDraft, setCustomDownDraft] = useState(() =>
    String(throttleConfig.downloadKbps || 1000)
  );
  const [customUpDraft, setCustomUpDraft] = useState(() =>
    String(throttleConfig.uploadKbps || 500)
  );
  const [customLatencyDraft, setCustomLatencyDraft] = useState(() =>
    String(throttleConfig.latencyMs || 100)
  );

  useEffect(() => {
    if (throttleConfig.preset === "custom") {
      setCustomDownDraft(String(throttleConfig.downloadKbps));
      setCustomUpDraft(String(throttleConfig.uploadKbps));
      setCustomLatencyDraft(String(throttleConfig.latencyMs));
    }
  }, [throttleConfig]);

  const activeThrottleDef =
    THROTTLE_PRESET_DEFINITIONS.find((d) => d.id === throttleConfig.preset) ??
    THROTTLE_PRESET_DEFINITIONS[0];

  const handleSelectThrottlePreset = async (presetId: ThrottlePreset) => {
    const def = THROTTLE_PRESET_DEFINITIONS.find((d) => d.id === presetId);
    if (!def) return;
    await onChangeThrottleConfig({
      preset: def.id,
      downloadKbps: def.downloadKbps,
      uploadKbps: def.uploadKbps,
      latencyMs: def.latencyMs,
    });
  };

  const handleApplyCustomThrottle = async (
    e: React.FormEvent<HTMLFormElement>
  ) => {
    e.preventDefault();
    const down = Math.max(0, Math.round(Number(customDownDraft) || 0));
    const up = Math.max(0, Math.round(Number(customUpDraft) || 0));
    const lat = Math.max(0, Math.round(Number(customLatencyDraft) || 0));
    await onChangeThrottleConfig({
      preset: "custom",
      downloadKbps: down,
      uploadKbps: up,
      latencyMs: lat,
    });
  };

  const subTabs: {
    id: SettingsNetworkSubTab;
    label: string;
    badge?: string;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [
    {
      id: "throttling",
      label: "Bandwidth Throttling",
      badge:
        throttleConfig.preset === "none"
          ? "Off"
          : throttleConfig.preset === "custom"
            ? `${throttleConfig.latencyMs}ms`
            : activeThrottleDef.shortLabel,
      icon: throttleConfig.preset === "offline" ? WifiOff : Gauge,
    },
    {
      id: "hostsRemap",
      label: "HOSTS Remapping",
      badge: activeHostRemapCount > 0 ? String(activeHostRemapCount) : undefined,
      icon: Globe,
    },
    {
      id: "upstreamProxy",
      label: "Upstream Proxy",
      badge: upstreamProxyConfig.enabled
        ? upstreamProxyConfig.protocol.toUpperCase()
        : undefined,
      icon: Network,
    },
    {
      id: "timeouts",
      label: "Upstream Timeouts",
      badge:
        upstreamTimeouts.responseHeaderTimeoutSec === 0
          ? "Unlimited"
          : `${upstreamTimeouts.responseHeaderTimeoutSec}s`,
      icon: Clock,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Sub-navigation bar */}
      <div
        role="tablist"
        aria-label="Подразделы Network & Routing"
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
              {st.badge && (
                <span className="rounded-full bg-elevated px-1.5 py-0.5 font-mono text-[10px] font-semibold text-fg">
                  {st.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Sub-tab 1: Bandwidth Throttling */}
      {activeSubTab === "throttling" && (
        <section
          id="throttling-section"
          className="space-y-4 rounded-lg border border-hairline bg-canvas p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {throttleConfig.preset === "offline" ? (
                <WifiOff className="h-4 w-4 text-status5xx-fg" />
              ) : (
                <Gauge className="h-4 w-4 text-accent" />
              )}
              <div>
                <div className="flex items-center gap-1.5">
                  <h3 className="text-xs font-semibold text-fg">
                    Bandwidth Throttling &amp; Latency
                  </h3>
                  <HelpTooltip
                    label="Подробнее о Bandwidth Throttling"
                    title="Имитация медленной сети и задержек"
                    content="Ограничивает скорость скачивания (↓ Kbps) и отдачи (↑ Kbps) на уровне TCP/HTTP/WebSocket-потоков и добавляет искусственную задержку RTT к каждому новому соединению/запросу."
                    example="Fast 3G: ↓1600 / ↑1600 Kbps, RTT 150 ms"
                  />
                </div>
                <p className="text-[11px] text-muted">
                  Выберите сетевой профиль или задайте точные лимиты канала и RTT
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
                  throttleConfig.preset === "offline"
                    ? "bg-status5xx-bg text-status5xx-fg"
                    : throttleConfig.preset !== "none"
                      ? "bg-status4xx-bg text-status4xx-fg"
                      : "bg-elevated text-muted"
                }`}
              >
                {throttleConfig.preset === "none"
                  ? "Полная скорость (Off)"
                  : throttleConfig.preset === "offline"
                    ? "OFFLINE (HTTP 503)"
                    : `↓${throttleConfig.downloadKbps} / ↑${throttleConfig.uploadKbps} Kbps · ${throttleConfig.latencyMs}ms`}
              </span>
              {throttleConfig.preset !== "none" && (
                <button
                  type="button"
                  onClick={() => void handleSelectThrottlePreset("none")}
                  className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] font-medium text-fg hover:border-strong hover:bg-hover"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Reset to Full Speed</span>
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {THROTTLE_PRESET_DEFINITIONS.filter((d) => d.id !== "custom").map(
              (presetDef) => {
                const isSelected = throttleConfig.preset === presetDef.id;
                const isOffline = presetDef.id === "offline";
                return (
                  <button
                    key={presetDef.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => void handleSelectThrottlePreset(presetDef.id)}
                    className={`flex flex-col justify-between rounded-lg border p-3 text-left transition-colors ${
                      isSelected
                        ? isOffline
                          ? "border-status5xx-fg/60 bg-status5xx-bg text-status5xx-fg"
                          : "border-accent bg-selected text-fg ring-1 ring-accent/35"
                        : "border-hairline bg-surface text-muted hover:border-strong hover:text-fg"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-fg">
                        {presetDef.label}
                      </span>
                      {isSelected && <Check className="h-3.5 w-3.5 text-accent" />}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-accent">
                      {presetDef.summary}
                    </div>
                    <div className="mt-1 text-[10px] text-subtle">
                      {presetDef.id === "none"
                        ? "Без искусственных ограничений скорости и RTT"
                        : isOffline
                          ? "Отклоняет все запросы синтетическим HTTP 503"
                          : `↓ ${presetDef.downloadKbps} Kbps · ↑ ${presetDef.uploadKbps} Kbps · RTT ${presetDef.latencyMs} ms`}
                    </div>
                  </button>
                );
              }
            )}
          </div>

          <form
            onSubmit={(e) => void handleApplyCustomThrottle(e)}
            className="space-y-3 rounded-lg border border-hairline bg-surface p-3.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-fg">
                  Custom Bandwidth Profile
                </span>
                <HelpTooltip
                  label="Подробнее о Custom Bandwidth Profile"
                  title="Ручные лимиты скорости и RTT"
                  content="Значение 0 для скорости (Kbps) означает отсутствие ограничения по направлению; значение 0 для RTT отключает добавочную задержку."
                  example="↓ 750 Kbps, ↑ 250 Kbps, RTT 180 ms"
                />
              </div>
              {throttleConfig.preset === "custom" && (
                <span className="rounded bg-status4xx-bg px-2 py-0.5 font-mono text-[10px] font-semibold text-status4xx-fg">
                  Custom Active
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={downInputId}
                  className="text-[11px] font-medium text-muted"
                >
                  ↓ Download (Kbps, 0 = unlimited)
                </label>
                <input
                  id={downInputId}
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={customDownDraft}
                  onChange={(e) => setCustomDownDraft(e.target.value)}
                  className="h-8 rounded-md border border-strong bg-canvas px-2.5 font-mono text-xs text-fg tabular-nums focus:border-accent focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor={upInputId}
                  className="text-[11px] font-medium text-muted"
                >
                  ↑ Upload (Kbps, 0 = unlimited)
                </label>
                <input
                  id={upInputId}
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={customUpDraft}
                  onChange={(e) => setCustomUpDraft(e.target.value)}
                  className="h-8 rounded-md border border-strong bg-canvas px-2.5 font-mono text-xs text-fg tabular-nums focus:border-accent focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor={latencyInputId}
                  className="text-[11px] font-medium text-muted"
                >
                  RTT Latency (ms)
                </label>
                <input
                  id={latencyInputId}
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={customLatencyDraft}
                  onChange={(e) => setCustomLatencyDraft(e.target.value)}
                  className="h-8 rounded-md border border-strong bg-canvas px-2.5 font-mono text-xs text-fg tabular-nums focus:border-accent focus:outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3.5 text-xs font-semibold text-white hover:brightness-110"
              >
                <Check className="h-3.5 w-3.5" />
                <span>Apply Custom Limits</span>
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Sub-tab 2: HOSTS Remapping */}
      {activeSubTab === "hostsRemap" && <HostRemapPanel onNotify={onNotify} />}

      {/* Sub-tab 3: Upstream Proxy */}
      {activeSubTab === "upstreamProxy" && (
        <UpstreamProxyPanel
          config={upstreamProxyConfig}
          proxyPort={status.port}
          onSave={onSaveUpstreamProxyConfig}
        />
      )}

      {/* Sub-tab 4: Upstream Timeouts */}
      {activeSubTab === "timeouts" && (
        <UpstreamTimeoutsSection
          baseId={baseId}
          upstreamTimeouts={upstreamTimeouts}
          onSetUpstreamTimeouts={onSetUpstreamTimeouts}
        />
      )}
    </div>
  );
};
