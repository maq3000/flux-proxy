import React, { useCallback, useEffect, useId, useState } from "react";
import {
  Copy,
  FileKey2,
  ShieldCheck,
  ShieldOff,
  Smartphone,
} from "lucide-react";
import { proxyBridge } from "../../lib/tauriBridge";
import type {
  CaCertificateInfo,
  NoiseThresholdsConfig,
  ProxyFilterBackendConfig,
  ProxyStatus,
  SessionSummary,
} from "../../types/proxy";
import type { SettingsTlsSubTab } from "../../types/settings";
import { TlsBypassTab } from "../filters/TlsBypassTab";
import { HelpTooltip } from "../ui/HelpTooltip";
import { ClientCertificatesPanel } from "./ClientCertificatesPanel";
import { MobileSetupPanel } from "./MobileSetupPanel";

export interface TlsCertificatesSettingsTabProps {
  isActive: boolean;
  activeSubTab: SettingsTlsSubTab;
  onSubTabChange: (subTab: SettingsTlsSubTab) => void;
  sessions: SessionSummary[];
  thresholds: NoiseThresholdsConfig;
  onThresholdsChange: (
    updater:
      | NoiseThresholdsConfig
      | ((prev: NoiseThresholdsConfig) => NoiseThresholdsConfig)
  ) => void;
  backendFilterConfig: ProxyFilterBackendConfig;
  onUpdateBackendFilterConfig: (next: ProxyFilterBackendConfig) => Promise<void>;
  flushPendingBulkRef: React.MutableRefObject<(() => void) | null>;
  onOpenCertificateModal: () => void;
  caRefreshKey?: number;
  activeClientCertsCount: number;
  onClientCertsCountChange: (count: number) => void;
  status: ProxyStatus;
  lanClientAllowlist: string[];
  onUpdateLanClientAllowlist: (next: string[]) => Promise<void>;
  onSetAllowRemote: (allow: boolean) => Promise<void>;
  onToggleProxy: () => Promise<void>;
  onNotify: (msg: string) => void;
}

export const TlsCertificatesSettingsTab: React.FC<
  TlsCertificatesSettingsTabProps
> = ({
  isActive,
  activeSubTab,
  onSubTabChange,
  sessions,
  thresholds,
  onThresholdsChange,
  backendFilterConfig,
  onUpdateBackendFilterConfig,
  flushPendingBulkRef,
  onOpenCertificateModal,
  caRefreshKey = 0,
  activeClientCertsCount,
  onClientCertsCountChange,
  status,
  lanClientAllowlist,
  onUpdateLanClientAllowlist,
  onSetAllowRemote,
  onToggleProxy,
  onNotify,
}) => {
  const stripAltSvcId = useId();
  const [caInfo, setCaInfo] = useState<CaCertificateInfo | null>(null);

  const loadCaInfo = useCallback(async () => {
    try {
      const info = await proxyBridge.getCaInfo();
      setCaInfo(info);
    } catch {
      // keep previous snapshot if bridge call fails
    }
  }, []);

  useEffect(() => {
    void loadCaInfo();
  }, [loadCaInfo, caRefreshKey]);

  const activeTlsRulesCount =
    backendFilterConfig.tlsInterceptMode === "targetedOnly"
      ? (backendFilterConfig.tlsTargetRules ?? []).filter((r) => r.enabled)
          .length
      : backendFilterConfig.tlsBypassEnabled
        ? backendFilterConfig.tlsBypassRules.filter((r) => r.enabled).length
        : 0;

  const isRemoteAllowed = Boolean(
    status.bindMode === "all" ||
      (status.bindMode === "specific" &&
        status.specificBindIp !== "127.0.0.1" &&
        status.bindAddr !== "127.0.0.1") ||
      status.allowRemote ||
      status.bindAddr === "0.0.0.0"
  );

  const handleSwitchSubTab = (next: SettingsTlsSubTab) => {
    if (activeSubTab === "mitmBypass" && next !== "mitmBypass") {
      flushPendingBulkRef.current?.();
    }
    onSubTabChange(next);
  };

  const subTabs: {
    id: SettingsTlsSubTab;
    label: string;
    badge?: string;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [
    {
      id: "mitmBypass",
      label: "TLS Bypass",
      badge:
        backendFilterConfig.tlsInterceptMode === "targetedOnly"
          ? `Targeted (${activeTlsRulesCount})`
          : `Bypass (${activeTlsRulesCount})`,
      icon: ShieldOff,
    },
    {
      id: "clientCerts",
      label: "Client Certificates",
      badge:
        activeClientCertsCount > 0 ? String(activeClientCertsCount) : undefined,
      icon: FileKey2,
    },
    {
      id: "mobileSetup",
      label: "Mobile Setup",
      badge: isRemoteAllowed ? "LAN" : "Local",
      icon: Smartphone,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Compact Root CA Status Card linking to CertificateModal.tsx */}
      <section
        id="root-ca-status-card"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-canvas p-3.5"
      >
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          {caInfo?.isTrusted ? (
            <ShieldCheck
              className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400"
              aria-hidden="true"
            />
          ) : (
            <ShieldOff
              className="mt-0.5 h-5 w-5 shrink-0 text-amber-400"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-fg">
                Root CA
              </span>
              <HelpTooltip
                label="Подробнее о Root CA сертификате"
                title="Локальный корневой сертификат (ECDSA P-256)"
                content="FluxProxy подписывает временные сертификаты доменов на лету с помощью локального Root CA. Для расшифровки HTTPS/WSS в браузерах на этом ПК установите Root CA в доверенное хранилище ОС."
              />
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  caInfo?.isTrusted
                    ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400"
                    : "border-amber-500/35 bg-amber-500/10 text-amber-400"
                }`}
              >
                {caInfo?.isTrusted
                  ? "Установлен (доверен ОС)"
                  : "Не установлен в доверенные ОС"}
              </span>
            </div>
            {caInfo && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted">
                <span className="truncate">{caInfo.subject}</span>
                <span className="text-subtle">•</span>
                <span className="inline-flex items-center gap-1 truncate text-emerald-400">
                  <span>SHA-256: {caInfo.sha256Fingerprint.slice(0, 23)}…</span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(
                        caInfo.sha256Fingerprint
                      );
                      onNotify("Отпечаток SHA-256 Root CA скопирован");
                    }}
                    title="Скопировать полный SHA-256 отпечаток"
                    aria-label="Скопировать SHA-256 отпечаток Root CA"
                    className="rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
                  >
                    <Copy className="h-3 w-3" aria-hidden="true" />
                  </button>
                </span>
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenCertificateModal}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-accent/40 bg-selected px-3 text-xs font-medium text-fg hover:brightness-110"
        >
          <ShieldCheck className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
          <span>Управлять Root CA…</span>
        </button>
      </section>

      {/* Sub-navigation bar */}
      <div
        role="tablist"
        aria-label="Подразделы TLS, сертификатов и мобильной отладки"
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
              onClick={() => handleSwitchSubTab(st.id)}
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

      {/* Sub-tab 1: Strip Alt-Svc + Full TlsBypassTab */}
      {activeSubTab === "mitmBypass" && (
        <div id="tls-bypass-section" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-canvas px-3 py-2">
            <label
              htmlFor={stripAltSvcId}
              className="flex cursor-pointer items-center gap-2 text-xs text-fg"
            >
              <input
                id={stripAltSvcId}
                type="checkbox"
                checked={backendFilterConfig.stripAltSvc}
                onChange={(e) =>
                  void onUpdateBackendFilterConfig({
                    ...backendFilterConfig,
                    stripAltSvc: e.target.checked,
                  })
                }
                className="checkbox-native"
              />
              <span className="font-medium">
                Удалять заголовок <code>Alt-Svc</code> (блокировка ухода в
                HTTP/3 / QUIC)
              </span>
            </label>
            <HelpTooltip
              label="Подробнее о Strip Alt-Svc"
              title="Подавление перехода браузера на HTTP/3 (QUIC)"
              content="Браузеры используют заголовок Alt-Svc для переключения на UDP/QUIC в обход HTTP-прокси. Удаление Alt-Svc принудительно удерживает трафик на HTTPS/1.1 и HTTPS/2 для корректного перехвата."
            />
          </div>

          <TlsBypassTab
            isActive={isActive && activeSubTab === "mitmBypass"}
            sessions={sessions}
            thresholds={thresholds}
            onThresholdsChange={onThresholdsChange}
            backendConfig={backendFilterConfig}
            onBackendConfigChange={onUpdateBackendFilterConfig}
            onNotify={onNotify}
            flushPendingBulkRef={flushPendingBulkRef}
          />
        </div>
      )}

      {/* Sub-tab 2: Client Certificates (mTLS) */}
      {activeSubTab === "clientCerts" && (
        <ClientCertificatesPanel
          onNotify={onNotify}
          onActiveCountChange={onClientCertsCountChange}
        />
      )}

      {/* Sub-tab 3: Mobile Device Setup */}
      {activeSubTab === "mobileSetup" && (
        <MobileSetupPanel
          status={status}
          lanClientAllowlist={lanClientAllowlist}
          onUpdateLanClientAllowlist={onUpdateLanClientAllowlist}
          onSetAllowRemote={onSetAllowRemote}
          onToggleProxy={onToggleProxy}
          onNotify={onNotify}
        />
      )}
    </div>
  );
};
