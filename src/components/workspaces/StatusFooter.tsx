import React from "react";
import { Gauge, Globe, Network, Stethoscope, WifiOff } from "lucide-react";
import { isTauriRuntime } from "../../lib/tauriBridge";
import {
  THROTTLE_PRESET_DEFINITIONS,
  type ProxyStatus,
  type ThrottleConfig,
  type TlsInterceptMode,
} from "../../types/proxy";
import {
  FooterStorageStatsBadge,
  SessionCountsBadge,
} from "./TrafficCountBadges";

export interface StatusFooterProps {
  status: ProxyStatus;
  tlsInterceptMode: TlsInterceptMode;
  activeTargetHostsCount: number;
  activeHostRemapCount: number;
  upstreamProxyActiveLabel: string | null;
  throttleConfig: ThrottleConfig;
  activeFilterBadgeCount: number;
  regexError: string | null;
  toastMessage: string | null;
  sessionRetentionLimit: number | null;
  dropNonMatching: boolean;
  clearDbOnExit: boolean;
  onContextMenu: (e: React.MouseEvent<HTMLElement>) => void;
  onToggleSystemProxy: () => void;
  onOpenProxyDoctor: () => void;
  onOpenMobileSetup: () => void;
  onOpenMitmBypass: () => void;
  onOpenHostsRemap: () => void;
  onOpenUpstreamProxy: () => void;
  onResetThrottling: () => void;
  onOpenFilterMatrix: () => void;
  onOpenCustomRetentionLimit: () => void;
  onConfirmSqlitePurge: () => void;
  onOpenShortcuts: () => void;
}

const StatusFooterInner: React.FC<StatusFooterProps> = ({
  status,
  tlsInterceptMode,
  activeTargetHostsCount,
  activeHostRemapCount,
  upstreamProxyActiveLabel,
  throttleConfig,
  activeFilterBadgeCount,
  regexError,
  toastMessage,
  sessionRetentionLimit,
  dropNonMatching,
  clearDbOnExit,
  onContextMenu,
  onToggleSystemProxy,
  onOpenProxyDoctor,
  onOpenMobileSetup,
  onOpenMitmBypass,
  onOpenHostsRemap,
  onOpenUpstreamProxy,
  onResetThrottling,
  onOpenFilterMatrix,
  onOpenCustomRetentionLimit,
  onConfirmSqlitePurge,
  onOpenShortcuts,
}) => {
  const boundIpsList =
    status.boundIps && status.boundIps.length > 0
      ? status.boundIps
      : [status.bindAddr];
  const boundEndpoints = boundIpsList
    .map((ip) => `${ip}:${status.port}`)
    .join(" + ");
  const effectiveMode =
    status.bindMode ??
    (status.allowRemote || status.bindAddr === "0.0.0.0" ? "all" : "loopback");
  const isRemoteActive = Boolean(
    effectiveMode === "all" ||
      (effectiveMode === "specific" &&
        status.specificBindIp !== "127.0.0.1" &&
        status.bindAddr !== "127.0.0.1") ||
      status.allowRemote
  );
  const prefix =
    effectiveMode === "all"
      ? "LAN"
      : effectiveMode === "specific"
        ? "Bind"
        : "Local";

  const throttleDef = THROTTLE_PRESET_DEFINITIONS.find(
    (d) => d.id === throttleConfig.preset
  );
  const isOffline = throttleConfig.preset === "offline";
  const throttleLabel = isOffline
    ? "OFFLINE (503)"
    : `${throttleDef ? throttleDef.shortLabel : throttleConfig.preset}: ↓${throttleConfig.downloadKbps} Kbps · ${throttleConfig.latencyMs}ms`;

  return (
    <footer
      onContextMenu={onContextMenu}
      className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-hairline bg-surface px-3 font-mono text-[11px] text-muted"
    >
      <div className="flex min-w-0 items-center gap-2.5 truncate">
        <span className="truncate">
          Engine:{" "}
          <strong className="font-semibold text-fg">
            {isTauriRuntime() ? "Tauri Rust MITM" : "Preview Simulator"}
          </strong>
        </span>
        <span className="text-subtle">•</span>
        <button
          type="button"
          onClick={onToggleSystemProxy}
          title="Переключить системный прокси ОС"
          className={`shrink-0 hover:underline ${
            status.systemProxyError
              ? "text-status4xx-fg"
              : status.systemProxyEnabled
                ? "text-status2xx-fg"
                : "text-muted"
          }`}
        >
          {status.systemProxyError
            ? "SysProxy: Warn"
            : status.systemProxyEnabled
              ? `SysProxy: ${
                  status.bindMode === "specific" &&
                  status.specificBindIp &&
                  status.alsoBindLoopback === false
                    ? status.specificBindIp
                    : "127.0.0.1"
                }:${status.port}`
              : status.running
                ? "Port Only"
                : "Proxy Off"}
        </button>
        {(status.systemProxyError || !status.running) && (
          <>
            <span className="text-subtle">•</span>
            <button
              type="button"
              onClick={onOpenProxyDoctor}
              title={
                status.systemProxyError
                  ? `Ошибка системного прокси: ${status.systemProxyError} — нажмите для диагностики Proxy Doctor (Ctrl+Shift+D)`
                  : "Прокси-движок остановлен — нажмите для диагностики Proxy Doctor (Ctrl+Shift+D)"
              }
              className="inline-flex shrink-0 items-center gap-1 rounded border border-rose-500/40 bg-rose-500/12 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-status5xx-fg transition-colors hover:bg-rose-500/20"
            >
              <Stethoscope aria-hidden="true" className="h-3 w-3" />
              <span>Fix with Proxy Doctor</span>
            </button>
          </>
        )}
        <span className="hidden text-subtle md:inline">•</span>
        <button
          type="button"
          onClick={onOpenMobileSetup}
          title={`Активные интерфейсы: ${boundEndpoints}. Нажмите для настройки мобильного подключения (Ctrl+Shift+M)`}
          className={`hidden shrink-0 font-mono hover:underline md:inline ${
            isRemoteActive ? "text-status2xx-fg" : "text-muted"
          }`}
        >
          {`${prefix}: ${boundEndpoints}`}
        </button>
        <span className="hidden text-subtle md:inline">•</span>
        <button
          type="button"
          onClick={onOpenMitmBypass}
          title="Настроить режим перехвата TLS MITM (Intercept All / Targeted Only Allowlist)"
          className={`hidden shrink-0 hover:underline md:inline ${
            tlsInterceptMode === "targetedOnly"
              ? "text-status2xx-fg"
              : "text-muted"
          }`}
        >
          {tlsInterceptMode === "targetedOnly"
            ? `MITM: Targeted (${activeTargetHostsCount})`
            : "MITM: All"}
        </button>
        {activeHostRemapCount > 0 && (
          <>
            <span className="hidden text-subtle md:inline">•</span>
            <button
              type="button"
              onClick={onOpenHostsRemap}
              title={`Активных правил HOSTS Remapping: ${activeHostRemapCount}. Нажмите для управления (Ctrl+Shift+H)`}
              className="inline-flex shrink-0 items-center gap-1 text-accent hover:underline"
            >
              <Globe className="h-3 w-3" aria-hidden="true" />
              <span>HOSTS: {activeHostRemapCount}</span>
            </button>
          </>
        )}
        {upstreamProxyActiveLabel && (
          <>
            <span className="hidden text-subtle md:inline">•</span>
            <button
              type="button"
              onClick={onOpenUpstreamProxy}
              title={`Каскадирование через Upstream Proxy (${upstreamProxyActiveLabel}). Нажмите для настройки (Ctrl+Shift+U)`}
              className="inline-flex shrink-0 items-center gap-1 text-accent hover:underline"
            >
              <Network className="h-3 w-3" aria-hidden="true" />
              <span>UPSTREAM: {upstreamProxyActiveLabel}</span>
            </button>
          </>
        )}
        {throttleConfig.preset !== "none" && (
          <>
            <span className="text-subtle">•</span>
            <button
              type="button"
              onClick={onResetThrottling}
              title={`Активен Bandwidth Throttling (${throttleLabel}). Нажмите, чтобы сбросить на No Throttling (полная скорость).`}
              className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold transition-colors hover:brightness-110 ${
                isOffline
                  ? "bg-status5xx-bg text-status5xx-fg"
                  : "bg-status4xx-bg text-status4xx-fg"
              }`}
            >
              {isOffline ? (
                <WifiOff className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Gauge className="h-3 w-3" aria-hidden="true" />
              )}
              <span>{throttleLabel}</span>
            </button>
          </>
        )}
        {activeFilterBadgeCount > 0 && (
          <>
            <span className="text-subtle">•</span>
            <button
              type="button"
              onClick={onOpenFilterMatrix}
              className="shrink-0 text-accent hover:underline"
            >
              Filters: {activeFilterBadgeCount} (
              <SessionCountsBadge format="filterButton" />)
            </button>
          </>
        )}
        {regexError && (
          <span className="truncate text-status5xx-fg">
            RegExp: {regexError}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {toastMessage && (
          <span className="max-w-[300px] truncate text-accent">
            {toastMessage}
          </span>
        )}
        <FooterStorageStatsBadge
          sessionRetentionLimit={sessionRetentionLimit}
          dropNonMatching={dropNonMatching}
          clearDbOnExit={clearDbOnExit}
          onOpenCustomRetentionLimit={onOpenCustomRetentionLimit}
          onConfirmSqlitePurge={onConfirmSqlitePurge}
        />
        <span className="hidden text-subtle 2xl:inline">•</span>
        <button
          type="button"
          onClick={onOpenShortcuts}
          title="Открыть полный справочник горячих клавиш (?)"
          className="hidden text-subtle hover:text-fg 2xl:inline"
        >
          F12 Capture • Space Inspect • R Replay • M Mark • U Unmark • Del • Ctrl+F • ?
        </button>
      </div>
    </footer>
  );
};

export const StatusFooter = React.memo(StatusFooterInner);
StatusFooter.displayName = "StatusFooter";
