import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { BindHostMode, NetworkInterfaceInfo, ProxyStatus } from "../../types/proxy";

export interface BindConfigSectionProps {
  sectionKey: "general" | "rules";
  baseId: string;
  status: ProxyStatus;
  effectiveBindMode: BindHostMode;
  activeBoundIps: string[];
  resolvedSpecificIpCandidate: string;
  networkInterfaces: NetworkInterfaceInfo[];
  isLoadingInterfaces: boolean;
  isApplyingBind: boolean;
  bindError: string | null;
  onBindModeChange: (nextMode: BindHostMode) => Promise<void>;
  onSpecificIpChange: (nextIp: string) => Promise<void>;
  onAlsoBindLoopbackChange: (checked: boolean) => Promise<void>;
  onReloadInterfaces: () => Promise<void>;
}

export const BindConfigSection: React.FC<BindConfigSectionProps> = ({
  sectionKey,
  baseId,
  status,
  effectiveBindMode,
  activeBoundIps,
  resolvedSpecificIpCandidate,
  networkInterfaces,
  isLoadingInterfaces,
  isApplyingBind,
  bindError,
  onBindModeChange,
  onSpecificIpChange,
  onAlsoBindLoopbackChange,
  onReloadInterfaces,
}) => {
    const radioName = `${baseId}-${sectionKey}-bind-mode`;
    const isSpecific = effectiveBindMode === "specific";
    const activeSpecificValue = resolvedSpecificIpCandidate;
    const hasCurrentSpecificInList = Boolean(
      activeSpecificValue &&
        networkInterfaces.some((iface) => iface.ip === activeSpecificValue)
    );
    const alsoLoopbackChecked = status.alsoBindLoopback ?? true;

    const options: {
      value: BindHostMode;
      title: string;
      desc: string;
    }[] = [
      {
        value: "loopback",
        title: "Loopback (127.0.0.1)",
        desc: "Принимать подключения только локально с этого ПК (изолированный безопасный режим).",
      },
      {
        value: "all",
        title: "All Interfaces (0.0.0.0)",
        desc: "Слушать все сетевые интерфейсы: Wi-Fi, LAN, смартфоны iOS / Android, VPN и WSL.",
      },
      {
        value: "specific",
        title: "Specific Interface",
        desc: "Выбрать конкретный сетевой адаптер (Wi-Fi, Ethernet, WSL, Docker, Hyper-V, VPN).",
      },
    ];

    const body = (
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold text-fg">
            Привязка к сетевому интерфейсу (Bind Host)
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {activeBoundIps.map((ip) => (
              <span
                key={`${sectionKey}-${ip}`}
                className="rounded border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[10px] text-fg tabular-nums"
              >
                {ip}:{status.port}
              </span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {options.map((opt) => {
            const rId = `${baseId}-${sectionKey}-bind-${opt.value}`;
            const checked = effectiveBindMode === opt.value;
            return (
              <label
                key={opt.value}
                htmlFor={rId}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 transition-colors ${
                  checked
                    ? "border-accent/50 bg-selected"
                    : "border-hairline bg-surface hover:bg-hover"
                } ${isApplyingBind ? "opacity-75" : ""}`}
              >
                <input
                  id={rId}
                  type="radio"
                  name={radioName}
                  value={opt.value}
                  checked={checked}
                  disabled={isApplyingBind}
                  onChange={() => void onBindModeChange(opt.value)}
                  className="mt-0.5 cursor-pointer accent-[var(--accent-primary)]"
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-fg">
                    {opt.title}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-snug text-muted">
                    {opt.desc}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        {isSpecific && (
          <div className="space-y-2 rounded-md border border-hairline bg-surface p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <label
                htmlFor={`${baseId}-${sectionKey}-iface-select`}
                className="text-[11px] font-medium text-muted"
              >
                Интерфейс:
              </label>
              <select
                id={`${baseId}-${sectionKey}-iface-select`}
                value={activeSpecificValue}
                disabled={
                  isApplyingBind ||
                  isLoadingInterfaces ||
                  (networkInterfaces.length === 0 && !hasCurrentSpecificInList)
                }
                onChange={(e) => void onSpecificIpChange(e.target.value)}
                className="h-8 min-w-[240px] flex-1 rounded-md border border-strong bg-canvas px-2 font-mono text-xs text-fg focus:border-accent focus:outline-none"
              >
                {networkInterfaces.length === 0 && !hasCurrentSpecificInList && (
                  <option value="">Нет доступных интерфейсов</option>
                )}
                {!hasCurrentSpecificInList && activeSpecificValue && (
                  <option value={activeSpecificValue}>
                    {activeSpecificValue} (Сохранённый / Offline)
                  </option>
                )}
                {networkInterfaces.map((iface) => (
                  <option key={`${iface.ip}-${iface.name}`} value={iface.ip}>
                    {iface.name} — {iface.ip} ({iface.kind.toUpperCase()}
                    {iface.isPrimary ? ", Primary" : ""})
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={isLoadingInterfaces || isApplyingBind}
                onClick={() => void onReloadInterfaces()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-strong bg-canvas px-2.5 text-[11px] font-medium text-fg hover:bg-hover disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${isLoadingInterfaces ? "animate-spin" : ""}`}
                />
                <span>Обновить</span>
              </button>
            </div>

            <label
              htmlFor={`${baseId}-${sectionKey}-also-loopback`}
              className="flex cursor-pointer items-start gap-2 pt-0.5"
            >
              <input
                id={`${baseId}-${sectionKey}-also-loopback`}
                type="checkbox"
                checked={alsoLoopbackChecked}
                disabled={isApplyingBind || activeSpecificValue === "127.0.0.1"}
                onChange={(e) =>
                  void onAlsoBindLoopbackChange(e.target.checked)
                }
                className="checkbox-native mt-0.5"
              />
              <div>
                <div className="text-xs font-medium text-fg">
                  Также слушать 127.0.0.1 для системного прокси ОС
                </div>
                <div className="text-[11px] text-muted">
                  {alsoLoopbackChecked && activeSpecificValue !== "127.0.0.1"
                    ? `Dual Listener: прокси принимает подключения и на ${activeSpecificValue}:${status.port}, и на 127.0.0.1:${status.port} (системный прокси ОС указывает на 127.0.0.1).`
                    : `Один сокет: прокси и системный прокси ОС используют ${activeSpecificValue || "выбранный IP"}:${status.port}.`}
                </div>
              </div>
            </label>
          </div>
        )}

        {bindError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-status5xx-fg/40 bg-status5xx-bg/60 px-2.5 py-2 text-[11px] text-status5xx-fg"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{bindError}</span>
          </div>
        )}
      </div>
    );

    if (sectionKey === "rules") {
      return (
        <fieldset className="space-y-2.5 rounded-lg border border-hairline bg-canvas p-3.5">
          <legend className="px-1 text-xs font-semibold text-fg">
            Сетевой интерфейс прокси (Bind Host)
          </legend>
          {body}
        </fieldset>
      );
    }

    return (
      <div className="border-t border-hairline pt-2.5">
        {body}
      </div>
    );
  };
