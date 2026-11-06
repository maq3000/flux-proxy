import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Network,
  QrCode,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Terminal,
  Wifi,
  X,
} from "lucide-react";
import { proxyBridge } from "../lib/tauriBridge";
import type { NetworkInterfaceInfo, ProxyStatus } from "../types/proxy";

interface MobileSetupModalProps {
  open: boolean;
  status: ProxyStatus;
  onSetAllowRemote: (allow: boolean) => Promise<void>;
  onToggleProxy: () => Promise<void>;
  onClose: () => void;
  onNotify: (msg: string) => void;
}

type GuidePlatformTab = "ios" | "android";
type QrMode = "cert" | "wifi";
type CertQrFormat = "crt" | "mobileconfig" | "auto";

const ANDROID_NETWORK_SECURITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- res/xml/network_security_config.xml -->
<network-security-config>
    <debug-overrides>
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </debug-overrides>
</network-security-config>`;

const ANDROID_MANIFEST_SNIPPET = `<application
    android:networkSecurityConfig="@xml/network_security_config"
    ... >`;

function escapeWifiQrField(raw: string): string {
  return raw.replace(/([\\;,"':])/g, "\\$1");
}

export const MobileSetupModal: React.FC<MobileSetupModalProps> = ({
  open,
  status,
  onSetAllowRemote,
  onToggleProxy,
  onClose,
  onNotify,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [interfaces, setInterfaces] = useState<NetworkInterfaceInfo[]>([]);
  const [selectedIp, setSelectedIp] = useState<string>("");
  const [customIp, setCustomIp] = useState<string>("");
  const [loadingIfaces, setLoadingIfaces] = useState<boolean>(false);
  const [switchingRemote, setSwitchingRemote] = useState<boolean>(false);

  const [guideTab, setGuideTab] = useState<GuidePlatformTab>("ios");
  const [qrMode, setQrMode] = useState<QrMode>("cert");
  const [certFormat, setCertFormat] = useState<CertQrFormat>("crt");

  // Optional Wi-Fi QR helper fields (kept strictly in local UI memory)
  const [wifiSsid, setWifiSsid] = useState<string>("");
  const [wifiPassword, setWifiPassword] = useState<string>("");
  const [wifiSecurity, setWifiSecurity] = useState<"WPA" | "WEP" | "nopass">(
    "WPA"
  );

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const refreshInterfaces = useCallback(async () => {
    setLoadingIfaces(true);
    try {
      const list = await proxyBridge.getNetworkInterfaces();
      setInterfaces(list);
      setSelectedIp((prev) => {
        if (prev && list.some((item) => item.ip === prev)) {
          return prev;
        }
        const primary = list.find((item) => item.isPrimary) ?? list[0];
        return primary ? primary.ip : "";
      });
    } catch (err) {
      onNotify(
        `Не удалось получить список сетевых адаптеров: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      setLoadingIfaces(false);
    }
  }, [onNotify]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open) {
      if (!el.open) {
        el.showModal();
      }
      void refreshInterfaces();
    } else if (el.open) {
      el.close();
    }
  }, [open, refreshInterfaces]);

  const handleDialogClose = () => {
    const el = dialogRef.current;
    if (el) {
      el.returnValue = "";
    }
    onClose();
  };

  const handleBackdropPointerDown = (
    e: React.PointerEvent<HTMLDialogElement>
  ) => {
    const el = dialogRef.current;
    if (!el || "closedBy" in HTMLDialogElement.prototype) return;
    if (e.target === el) {
      const rect = el.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (!inside) {
        el.close();
      }
    }
  };

  const isRemoteAllowed = Boolean(
    status.allowRemote || status.bindAddr === "0.0.0.0" || status.bindAddr === "::"
  );

  const activeIp = useMemo(() => {
    const trimmedCustom = customIp.trim();
    if (trimmedCustom) return trimmedCustom;
    if (selectedIp) return selectedIp;
    return "192.168.1.45";
  }, [customIp, selectedIp]);

  const proxyEndpoint = `${activeIp}:${status.port}`;

  const certDownloadUrl = useMemo(() => {
    if (certFormat === "mobileconfig") {
      return `http://${activeIp}:${status.port}/ca.mobileconfig`;
    }
    if (certFormat === "auto") {
      return `http://${activeIp}:${status.port}/cert`;
    }
    return `http://${activeIp}:${status.port}/ca.crt`;
  }, [activeIp, status.port, certFormat]);

  const portalUrl = `http://${activeIp}:${status.port}`;
  const magicCertUrl = "http://flux.proxy/cert";

  const androidWifiQrPayload = useMemo(() => {
    const ssid = escapeWifiQrField(wifiSsid.trim() || "MyWiFiNetwork");
    const pass = escapeWifiQrField(wifiPassword);
    // Include standard ZXing Wi-Fi schema fields + explicit proxy host/port parameters
    const authSegment =
      wifiSecurity === "nopass"
        ? "T:nopass;"
        : `T:${wifiSecurity};P:${pass};`;
    return `WIFI:${authSegment}S:${ssid};H:false;PROXY_HOST:${activeIp};PROXY_PORT:${status.port};;`;
  }, [wifiSsid, wifiPassword, wifiSecurity, activeIp, status.port]);

  const qrValue = qrMode === "cert" ? certDownloadUrl : androidWifiQrPayload;

  const copyText = async (key: string, value: string, toastLabel: string) => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopiedKey(key);
      onNotify(`Скопировано: ${toastLabel}`);
      window.setTimeout(() => {
        setCopiedKey((curr) => (curr === key ? null : curr));
      }, 1800);
    } catch {
      onNotify("Не удалось скопировать в буфер обмена");
    }
  };

  const handleToggleRemoteCheckbox = async (nextChecked: boolean) => {
    setSwitchingRemote(true);
    try {
      await onSetAllowRemote(nextChecked);
    } finally {
      setSwitchingRemote(false);
    }
  };

  const handlePlatformTabKeyDown = (
    e: React.KeyboardEvent<HTMLDivElement>
  ) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next: GuidePlatformTab = guideTab === "ios" ? "android" : "ios";
      setGuideTab(next);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="mobile-setup-modal-title"
      onClose={handleDialogClose}
      onPointerDown={handleBackdropPointerDown}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto max-h-[90vh] w-[min(880px,95vw)] overflow-hidden rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/65 backdrop:backdrop-blur-[1px] open:flex open:flex-col"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-hairline bg-elevated/70 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/30 bg-accent/15 text-accent">
            <Smartphone className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <h2
              id="mobile-setup-modal-title"
              className="text-sm font-semibold text-fg"
            >
              Connect Mobile Device
            </h2>
            <p className="text-[11px] text-muted">
              Перехват HTTP / HTTPS / WSS трафика с iOS и Android в одной локальной сети Wi-Fi / LAN
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Закрыть окно настройки мобильного устройства"
          className="rounded p-1 text-muted hover:bg-surface hover:text-fg"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4 text-xs">
        {/* 1. Remote Connections Setting (`0.0.0.0`) + Proxy Running Banner */}
        <div
          className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 transition-colors ${
            isRemoteAllowed && status.running
              ? "border-status2xx-fg/35 bg-status2xx-bg/60"
              : "border-status4xx-fg/40 bg-status4xx-bg/70"
          }`}
        >
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={isRemoteAllowed}
              disabled={switchingRemote}
              onChange={(e) => void handleToggleRemoteCheckbox(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-strong accent-accent"
            />
            <div>
              <div className="flex flex-wrap items-center gap-2 font-medium text-fg">
                <span>Разрешить подключения с удаленных устройств (0.0.0.0)</span>
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                    isRemoteAllowed && status.running
                      ? "bg-status2xx-bg text-status2xx-fg ring-1 ring-status2xx-fg/30"
                      : "bg-surface text-status4xx-fg ring-1 ring-status4xx-fg/30"
                  }`}
                >
                  {status.running
                    ? `${status.bindAddr}:${status.port}`
                    : "Listener Paused"}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-muted">
                {isRemoteAllowed
                  ? "Прокси слушает все сетевые интерфейсы (Wi-Fi / Ethernet). Убедитесь, что смартфон подключен к той же сети Wi-Fi и брандмауэр ОС разрешает входящий порт."
                  : "Сейчас прокси принимает соединения только локально (127.0.0.1). Включите эту опцию, чтобы iPhone или Android в вашей Wi-Fi сети мог подключиться."}
              </p>
            </div>
          </label>

          <div className="flex shrink-0 items-center gap-2">
            {!status.running && (
              <button
                type="button"
                onClick={() => void onToggleProxy()}
                className="inline-flex items-center gap-1.5 rounded-md bg-status2xx-fg px-2.5 py-1.5 text-[11px] font-semibold text-canvas hover:opacity-90"
              >
                Включить захват (F12)
              </button>
            )}
            {!isRemoteAllowed && (
              <button
                type="button"
                disabled={switchingRemote}
                onClick={() => void handleToggleRemoteCheckbox(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Включить 0.0.0.0</span>
              </button>
            )}
          </div>
        </div>

        {/* 2. Top Grid: Local IP & Proxy Endpoint + QR Code Generator */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          {/* Left Column (7 cols): Network Adapter & Connection Endpoints */}
          <div className="flex flex-col justify-between space-y-3 rounded-lg border border-hairline bg-canvas p-3.5 md:col-span-7">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="mobile-lan-interface-select"
                  className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted"
                >
                  <Network className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  <span>Локальный сетевой интерфейс (IPv4)</span>
                </label>
                <button
                  type="button"
                  onClick={() => void refreshInterfaces()}
                  disabled={loadingIfaces}
                  title="Обновить список активных Wi-Fi / Ethernet адаптеров"
                  className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2 py-0.5 text-[11px] text-muted hover:border-strong hover:text-fg disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3 w-3 ${loadingIfaces ? "animate-spin" : ""}`}
                    aria-hidden="true"
                  />
                  <span>Обновить</span>
                </button>
              </div>

              {interfaces.length > 0 ? (
                <select
                  id="mobile-lan-interface-select"
                  value={selectedIp}
                  onChange={(e) => {
                    setSelectedIp(e.target.value);
                    setCustomIp("");
                  }}
                  className="w-full rounded-md border border-hairline bg-surface px-2.5 py-1.5 font-mono text-xs text-fg focus:border-accent focus:outline-none"
                >
                  {interfaces.map((iface) => (
                    <option key={`${iface.name}-${iface.ip}`} value={iface.ip}>
                      {iface.ip} — {iface.name} (
                      {iface.kind === "wifi"
                        ? "Wi-Fi"
                        : iface.kind === "ethernet"
                          ? "Ethernet"
                          : "LAN"}
                      {iface.isPrimary ? " • Primary" : ""})
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex items-center gap-2 rounded-md border border-status4xx-fg/30 bg-status4xx-bg px-2.5 py-2 text-[11px] text-status4xx-fg">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    Активные Wi-Fi / Ethernet IPv4-адреса не обнаружены. Проверьте подключение к сети или укажите IP вручную ниже.
                  </span>
                </div>
              )}

              {/* Prominent Server IP & Port Copy Cards */}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-md border border-hairline bg-surface p-2.5 sm:col-span-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-subtle">
                    Proxy Server / Host (IP)
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <code className="truncate font-mono text-sm font-bold text-fg select-all">
                      {activeIp}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyText("ip", activeIp, activeIp)}
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-hairline bg-elevated px-2 py-1 text-[11px] text-muted hover:border-strong hover:text-fg"
                    >
                      {copiedKey === "ip" ? (
                        <Check className="h-3 w-3 text-status2xx-fg" aria-hidden="true" />
                      ) : (
                        <Copy className="h-3 w-3" aria-hidden="true" />
                      )}
                      <span>Copy</span>
                    </button>
                  </div>
                </div>

                <div className="rounded-md border border-hairline bg-surface p-2.5">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-subtle">
                    Port (Порт)
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <code className="font-mono text-sm font-bold text-accent select-all">
                      {status.port}
                    </code>
                    <button
                      type="button"
                      onClick={() =>
                        void copyText(
                          "port",
                          String(status.port),
                          String(status.port)
                        )
                      }
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-hairline bg-elevated px-2 py-1 text-[11px] text-muted hover:border-strong hover:text-fg"
                    >
                      {copiedKey === "port" ? (
                        <Check className="h-3 w-3 text-status2xx-fg" aria-hidden="true" />
                      ) : (
                        <Copy className="h-3 w-3" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Optional manual IP override for custom bridge / hotspot subnets */}
              <div className="flex items-center gap-2">
                <label
                  htmlFor="mobile-custom-ip-input"
                  className="shrink-0 text-[11px] text-subtle"
                >
                  Ручной IP (опц.):
                </label>
                <input
                  id="mobile-custom-ip-input"
                  type="text"
                  value={customIp}
                  onChange={(e) => setCustomIp(e.target.value)}
                  placeholder={selectedIp || "например, 192.168.1.45"}
                  className="min-w-0 flex-1 rounded border border-hairline bg-surface px-2 py-1 font-mono text-[11px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() =>
                    void copyText("endpoint", proxyEndpoint, proxyEndpoint)
                  }
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-hairline bg-surface px-2 py-1 font-mono text-[11px] text-muted hover:border-strong hover:text-fg"
                >
                  {copiedKey === "endpoint" ? (
                    <Check className="h-3 w-3 text-status2xx-fg" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3 w-3" aria-hidden="true" />
                  )}
                  <span>{proxyEndpoint}</span>
                </button>
              </div>
            </div>

            {/* Built-in Certificate Portal URLs */}
            <div className="space-y-1.5 rounded-md border border-hairline bg-surface/80 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                  Встроенные эндпоинты сертификата Root CA
                </span>
                <span className="font-mono text-[10px] text-status2xx-fg">
                  HTTP Portal Active
                </span>
              </div>
              <div className="grid grid-cols-1 gap-1.5 text-[11px] sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() =>
                    void copyText("magic-url", magicCertUrl, magicCertUrl)
                  }
                  title="Короткая ссылка в браузере смартфона (когда прокси уже прописан в Wi-Fi)"
                  className="flex items-center justify-between gap-1.5 rounded border border-hairline bg-canvas px-2 py-1 font-mono text-fg hover:border-accent"
                >
                  <span className="truncate">{magicCertUrl}</span>
                  <Copy className="h-3 w-3 shrink-0 text-muted" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void copyText(
                      "direct-crt",
                      `http://${activeIp}:${status.port}/ca.crt`,
                      `http://${activeIp}:${status.port}/ca.crt`
                    )
                  }
                  title="Прямая ссылка скачивания сертификата по IP (работает даже до настройки прокси)"
                  className="flex items-center justify-between gap-1.5 rounded border border-hairline bg-canvas px-2 py-1 font-mono text-fg hover:border-accent"
                >
                  <span className="truncate">
                    http://{activeIp}:{status.port}/ca.crt
                  </span>
                  <Copy className="h-3 w-3 shrink-0 text-muted" aria-hidden="true" />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-[10px] text-subtle">
                <span>
                  Веб-портал: <code className="text-fg">{portalUrl}</code>
                </span>
                <span>•</span>
                <span>
                  iOS профиль:{" "}
                  <code className="text-fg">/ca.mobileconfig</code>
                </span>
                <span>•</span>
                <span>
                  Форматы: <code className="text-fg">.crt / .pem / .der</code>
                </span>
              </div>
            </div>
          </div>

          {/* Right Column (5 cols): QR Code Card (Cert Download QR & Android Wi-Fi Proxy QR) */}
          <div className="flex flex-col items-center justify-between rounded-lg border border-hairline bg-canvas p-3.5 md:col-span-5">
            {/* QR Mode Switcher */}
            <div className="grid w-full grid-cols-2 gap-1 rounded-md border border-hairline bg-surface p-0.5">
              <button
                type="button"
                onClick={() => setQrMode("cert")}
                className={`inline-flex items-center justify-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                  qrMode === "cert"
                    ? "bg-accent text-white"
                    : "text-muted hover:text-fg"
                }`}
              >
                <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
                <span>QR сертификата</span>
              </button>
              <button
                type="button"
                onClick={() => setQrMode("wifi")}
                className={`inline-flex items-center justify-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                  qrMode === "wifi"
                    ? "bg-accent text-white"
                    : "text-muted hover:text-fg"
                }`}
              >
                <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Wi-Fi Proxy QR</span>
              </button>
            </div>

            {/* White high-contrast QR container so mobile cameras always scan reliably in Dark Mode */}
            <div className="my-3 rounded-xl border border-hairline bg-white p-3 shadow-sm">
              <QRCodeSVG
                value={qrValue}
                size={156}
                level="M"
                bgColor="#ffffff"
                fgColor="#0f172a"
                role="img"
                title={
                  qrMode === "cert"
                    ? `QR-код для скачивания сертификата FluxProxy: ${certDownloadUrl}`
                    : `QR-код параметров Wi-Fi и прокси ${proxyEndpoint} для Android`
                }
              />
            </div>

            {qrMode === "cert" ? (
              <div className="w-full space-y-2 text-center">
                {/* Certificate Format Selector for QR */}
                <div className="flex items-center justify-center gap-1">
                  {(
                    [
                      { id: "crt", label: ".crt (Android / Все)" },
                      { id: "mobileconfig", label: "iOS .mobileconfig" },
                      { id: "auto", label: "Auto (/cert)" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setCertFormat(opt.id)}
                      className={`rounded border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        certFormat === opt.id
                          ? "border-accent bg-accent/15 text-accent"
                          : "border-hairline bg-surface text-muted hover:text-fg"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="truncate rounded border border-hairline bg-surface px-2 py-1 font-mono text-[10px] text-fg select-all">
                  {certDownloadUrl}
                </div>
                <p className="text-[10px] text-subtle">
                  {certFormat === "mobileconfig"
                    ? "Наведите камеру iPhone → откроется Safari и предложит установить профиль в 1 клик."
                    : "Отсканируйте камерой смартфона для мгновенного скачивания Root CA сертификата."}
                </p>
              </div>
            ) : (
              <div className="w-full space-y-1.5">
                <div className="grid grid-cols-2 gap-1.5">
                  <div>
                    <label
                      htmlFor="android-wifi-ssid"
                      className="block text-[10px] text-subtle"
                    >
                      Имя сети (SSID)
                    </label>
                    <input
                      id="android-wifi-ssid"
                      type="text"
                      value={wifiSsid}
                      onChange={(e) => setWifiSsid(e.target.value)}
                      placeholder="Office-WiFi"
                      className="mt-0.5 w-full rounded border border-hairline bg-surface px-2 py-1 text-[11px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="android-wifi-security"
                      className="block text-[10px] text-subtle"
                    >
                      Защита
                    </label>
                    <select
                      id="android-wifi-security"
                      value={wifiSecurity}
                      onChange={(e) =>
                        setWifiSecurity(
                          e.target.value as "WPA" | "WEP" | "nopass"
                        )
                      }
                      className="mt-0.5 w-full rounded border border-hairline bg-surface px-2 py-1 text-[11px] text-fg focus:border-accent focus:outline-none"
                    >
                      <option value="WPA">WPA / WPA2 / WPA3</option>
                      <option value="WEP">WEP</option>
                      <option value="nopass">Открытая сеть</option>
                    </select>
                  </div>
                </div>
                {wifiSecurity !== "nopass" && (
                  <div>
                    <label
                      htmlFor="android-wifi-password"
                      className="block text-[10px] text-subtle"
                    >
                      Пароль Wi-Fi (локально, никуда не передается)
                    </label>
                    <input
                      id="android-wifi-password"
                      type="password"
                      value={wifiPassword}
                      onChange={(e) => setWifiPassword(e.target.value)}
                      placeholder="••••••••"
                      className="mt-0.5 w-full rounded border border-hairline bg-surface px-2 py-1 text-[11px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
                    />
                  </div>
                )}
                <p className="text-center text-[10px] text-subtle">
                  Прокси в QR: <code className="text-fg">{proxyEndpoint}</code>
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 3. Interactive Step-by-Step Platform Guides (iOS Guide / Android Guide) */}
        <div className="rounded-lg border border-hairline bg-canvas">
          <div
            role="tablist"
            aria-label="Инструкции по настройке мобильных ОС"
            onKeyDown={handlePlatformTabKeyDown}
            className="flex border-b border-hairline bg-elevated/50 px-2 pt-1.5"
          >
            <button
              id="tab-mobile-ios"
              type="button"
              role="tab"
              aria-selected={guideTab === "ios"}
              aria-controls="panel-mobile-ios"
              tabIndex={guideTab === "ios" ? 0 : -1}
              onClick={() => {
                setGuideTab("ios");
                if (qrMode === "cert" && certFormat === "crt") {
                  setCertFormat("mobileconfig");
                }
              }}
              className={`inline-flex items-center gap-2 border-b-2 px-3.5 py-2 text-xs font-semibold transition-colors ${
                guideTab === "ios"
                  ? "border-accent text-fg"
                  : "border-transparent text-muted hover:text-fg"
              }`}
            >
              <span>iOS / iPadOS Guide</span>
              <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted">
                Safari + .mobileconfig
              </span>
            </button>

            <button
              id="tab-mobile-android"
              type="button"
              role="tab"
              aria-selected={guideTab === "android"}
              aria-controls="panel-mobile-android"
              tabIndex={guideTab === "android" ? 0 : -1}
              onClick={() => {
                setGuideTab("android");
                if (qrMode === "cert" && certFormat === "mobileconfig") {
                  setCertFormat("crt");
                }
              }}
              className={`inline-flex items-center gap-2 border-b-2 px-3.5 py-2 text-xs font-semibold transition-colors ${
                guideTab === "android"
                  ? "border-accent text-fg"
                  : "border-transparent text-muted hover:text-fg"
              }`}
            >
              <span>Android Guide</span>
              <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted">
                CA Store + API 24+
              </span>
            </button>
          </div>

          {/* iOS Guide Tab Panel */}
          {guideTab === "ios" && (
            <div
              id="panel-mobile-ios"
              role="tabpanel"
              aria-labelledby="tab-mobile-ios"
              className="space-y-3 p-4"
            >
              <ol className="space-y-2.5">
                <li className="flex gap-3 rounded-md border border-hairline bg-surface p-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-[11px] font-bold text-accent">
                    1
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-fg">
                      Настройте HTTP-прокси в параметрах Wi-Fi
                    </div>
                    <p className="mt-0.5 leading-relaxed text-muted">
                      Откройте <strong>Настройки → Wi-Fi</strong> → нажмите{" "}
                      <strong>(i)</strong> рядом с вашей текущей сетью →
                      прокрутите вниз до <strong>Настройка прокси</strong> →{" "}
                      <strong>Вручную</strong> и укажите Сервер{" "}
                      <code className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-fg">
                        {activeIp}
                      </code>{" "}
                      и Порт{" "}
                      <code className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-accent">
                        {status.port}
                      </code>{" "}
                      → нажмите <strong>Сохранить</strong>.
                    </p>
                  </div>
                </li>

                <li className="flex gap-3 rounded-md border border-hairline bg-surface p-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-[11px] font-bold text-accent">
                    2
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-fg">
                      Установите профиль конфигурации через Safari
                    </div>
                    <p className="mt-0.5 leading-relaxed text-muted">
                      Откройте браузер <strong>Safari</strong> (важно: именно
                      Safari, не Chrome) и перейдите по адресу{" "}
                      <code className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-fg">
                        http://flux.proxy/cert
                      </code>{" "}
                      (либо отсканируйте QR-код выше в режиме{" "}
                      <button
                        type="button"
                        onClick={() => {
                          setQrMode("cert");
                          setCertFormat("mobileconfig");
                        }}
                        className="font-medium text-accent underline hover:opacity-80"
                      >
                        iOS .mobileconfig
                      </button>
                      ). Нажмите <strong>Разрешить</strong>, затем откройте{" "}
                      <strong>Настройки → Профиль загружен</strong> вверху
                      экрана и нажмите <strong>Установить</strong>.
                    </p>
                  </div>
                </li>

                <li className="flex gap-3 rounded-md border border-status2xx-fg/30 bg-status2xx-bg/40 p-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-status2xx-fg/20 font-mono text-[11px] font-bold text-status2xx-fg">
                    3
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 font-semibold text-fg">
                      <CheckCircle2
                        className="h-3.5 w-3.5 text-status2xx-fg"
                        aria-hidden="true"
                      />
                      <span>
                        Включите полное доверие корневому сертификату (Обязательный шаг!)
                      </span>
                    </div>
                    <p className="mt-0.5 leading-relaxed text-muted">
                      Перейдите в{" "}
                      <strong>
                        Настройки → Основные → Об этом устройстве → Доверие
                        сертификатам
                      </strong>{" "}
                      (в самом низу страницы) и переведите переключатель{" "}
                      <strong>FluxProxy Local Debugging Root CA</strong> в
                      положение <strong>Вкл.</strong> После этого весь HTTPS и
                      WSS трафик с iPhone/iPad сразу появится в таблице сессий с
                      IP вашего устройства.
                    </p>
                  </div>
                </li>
              </ol>
            </div>
          )}

          {/* Android Guide Tab Panel */}
          {guideTab === "android" && (
            <div
              id="panel-mobile-android"
              role="tabpanel"
              aria-labelledby="tab-mobile-android"
              className="space-y-3 p-4"
            >
              <ol className="space-y-2.5">
                <li className="flex gap-3 rounded-md border border-hairline bg-surface p-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-[11px] font-bold text-accent">
                    1
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-fg">
                        Настройте прокси в параметрах Wi-Fi (или через ADB)
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          void copyText(
                            "adb-proxy",
                            `adb shell settings put global http_proxy ${activeIp}:${status.port}`,
                            `adb shell settings put global http_proxy ${activeIp}:${status.port}`
                          )
                        }
                        title="Скопировать ADB-команду включения прокси по USB"
                        className="inline-flex items-center gap-1 rounded border border-hairline bg-canvas px-2 py-0.5 font-mono text-[10px] text-muted hover:border-strong hover:text-fg"
                      >
                        <Terminal className="h-3 w-3" aria-hidden="true" />
                        <span>
                          adb shell settings put global http_proxy{" "}
                          {proxyEndpoint}
                        </span>
                      </button>
                    </div>
                    <p className="mt-1 leading-relaxed text-muted">
                      Откройте <strong>Настройки → Сеть и интернет → Wi-Fi</strong>{" "}
                      → нажмите значок шестеренки / карандаша у текущей сети →{" "}
                      <strong>Расширенные настройки → Прокси → Вручную</strong>.
                      Укажите Имя хоста прокси{" "}
                      <code className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-fg">
                        {activeIp}
                      </code>{" "}
                      и Порт прокси{" "}
                      <code className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-accent">
                        {status.port}
                      </code>{" "}
                      → <strong>Сохранить</strong>.
                    </p>
                  </div>
                </li>

                <li className="flex gap-3 rounded-md border border-hairline bg-surface p-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-[11px] font-bold text-accent">
                    2
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-fg">
                      Скачайте и установите CA-сертификат в хранилище безопасности
                    </div>
                    <p className="mt-0.5 leading-relaxed text-muted">
                      Отсканируйте QR-код{" "}
                      <code className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-fg">
                        http://{activeIp}:{status.port}/ca.crt
                      </code>{" "}
                      или откройте{" "}
                      <code className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-fg">
                        http://flux.proxy/cert
                      </code>{" "}
                      в браузере. Затем перейдите в{" "}
                      <strong>
                        Настройки → Безопасность и конфиденциальность → Другие
                        настройки безопасности → Шифрование и учетные данные →
                        Установить сертификат → Сертификат CA
                      </strong>{" "}
                      → нажмите <strong>«Все равно установить»</strong> и
                      выберите скачанный файл{" "}
                      <code className="font-mono text-fg">
                        fluxproxy-root-ca.crt
                      </code>
                      .
                    </p>
                  </div>
                </li>

                <li className="flex gap-3 rounded-md border border-status4xx-fg/35 bg-status4xx-bg/50 p-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-status4xx-fg/20 font-mono text-[11px] font-bold text-status4xx-fg">
                    3
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-center gap-1.5 font-semibold text-fg">
                      <ShieldAlert
                        className="h-3.5 w-3.5 text-status4xx-fg"
                        aria-hidden="true"
                      />
                      <span>
                        Памятка по ограничению Android 7+ (Network Security Config)
                      </span>
                    </div>
                    <p className="leading-relaxed text-muted">
                      Начиная с <strong>Android 7.0 (API 24+)</strong> браузер
                      Chrome доверяет пользовательскому CA, но сторонние
                      приложения по умолчанию игнорируют хранилище{" "}
                      <code className="font-mono text-fg">user</code>. Для
                      отладки собственного Android-приложения добавьте файл{" "}
                      <code className="font-mono text-fg">
                        res/xml/network_security_config.xml
                      </code>{" "}
                      и сошлитесь на него в{" "}
                      <code className="font-mono text-fg">
                        AndroidManifest.xml
                      </code>
                      :
                    </p>

                    <div className="grid grid-cols-1 gap-2 lg:grid-cols-12">
                      <div className="rounded border border-hairline bg-canvas p-2 lg:col-span-8">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="font-mono text-[10px] text-subtle">
                            res/xml/network_security_config.xml
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              void copyText(
                                "nsc-xml",
                                ANDROID_NETWORK_SECURITY_XML,
                                "network_security_config.xml"
                              )
                            }
                            className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-1.5 py-0.5 text-[10px] text-muted hover:text-fg"
                          >
                            {copiedKey === "nsc-xml" ? (
                              <Check
                                className="h-3 w-3 text-status2xx-fg"
                                aria-hidden="true"
                              />
                            ) : (
                              <Copy className="h-3 w-3" aria-hidden="true" />
                            )}
                            <span>Copy XML</span>
                          </button>
                        </div>
                        <pre className="overflow-x-auto font-mono text-[10.5px] leading-relaxed text-fg select-all">
                          {ANDROID_NETWORK_SECURITY_XML}
                        </pre>
                      </div>

                      <div className="flex flex-col justify-between rounded border border-hairline bg-canvas p-2 lg:col-span-4">
                        <div>
                          <div className="mb-1 flex items-center justify-between">
                            <span className="font-mono text-[10px] text-subtle">
                              AndroidManifest.xml
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                void copyText(
                                  "manifest-xml",
                                  ANDROID_MANIFEST_SNIPPET,
                                  "AndroidManifest атрибут"
                                )
                              }
                              className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-1.5 py-0.5 text-[10px] text-muted hover:text-fg"
                            >
                              {copiedKey === "manifest-xml" ? (
                                <Check
                                  className="h-3 w-3 text-status2xx-fg"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Copy className="h-3 w-3" aria-hidden="true" />
                              )}
                              <span>Copy</span>
                            </button>
                          </div>
                          <pre className="overflow-x-auto font-mono text-[10.5px] leading-relaxed text-fg select-all">
                            {ANDROID_MANIFEST_SNIPPET}
                          </pre>
                        </div>
                        <p className="mt-2 text-[10px] text-subtle">
                          Блок <code>&lt;debug-overrides&gt;</code> активен
                          только в debug-сборках (<code>android:debuggable="true"</code>) и не ослабляет продакшен-APK.
                        </p>
                      </div>
                    </div>
                  </div>
                </li>
              </ol>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-hairline bg-elevated/50 px-4 py-2.5 text-[11px] text-muted">
        <div className="flex items-center gap-2">
          <ExternalLink className="h-3.5 w-3.5 text-subtle" aria-hidden="true" />
          <span>
            Совет: после завершения отладки не забудьте переключить прокси на смартфоне обратно в режим <strong>Выкл.</strong>
          </span>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          className="rounded-md border border-hairline bg-surface px-3 py-1 font-medium text-fg hover:border-strong"
        >
          Готово
        </button>
      </div>
    </dialog>
  );
};
