import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Lock,
  Network,
  RotateCcw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { HelpTooltip } from "../ui/HelpTooltip";
import {
  DEFAULT_UPSTREAM_PROXY_BYPASS_LIST,
  type UpstreamProxyConfig,
  type UpstreamProxyProtocol,
} from "../../types/proxy";

export interface UpstreamProxyPanelProps {
  config: UpstreamProxyConfig;
  proxyPort: number;
  onSave: (nextConfig: UpstreamProxyConfig) => Promise<void> | void;
}

const PROTOCOL_OPTIONS: {
  id: UpstreamProxyProtocol;
  label: string;
  defaultPort: number;
  hint: string;
}[] = [
  {
    id: "http",
    label: "HTTP",
    defaultPort: 8080,
    hint: "HTTP CONNECT / абсолютный URI",
  },
  {
    id: "https",
    label: "HTTPS",
    defaultPort: 8443,
    hint: "TLS-туннель до прокси",
  },
  {
    id: "socks5",
    label: "SOCKS5",
    defaultPort: 1080,
    hint: "RFC 1928/1929 TCP-туннель",
  },
];

function defaultPortForProtocol(proto: UpstreamProxyProtocol): number {
  return proto === "https" ? 8443 : proto === "socks5" ? 1080 : 8080;
}

function parseBypassTextarea(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\r\n,;]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

interface FieldErrors {
  host?: string;
  port?: string;
}

export const UpstreamProxyPanel: React.FC<UpstreamProxyPanelProps> = ({
  config,
  proxyPort,
  onSave,
}) => {
  const hostInputRef = useRef<HTMLInputElement | null>(null);
  const portInputRef = useRef<HTMLInputElement | null>(null);

  const enabledId = useId();
  const protocolGroupName = useId();
  const hostId = useId();
  const hostErrId = useId();
  const portId = useId();
  const portErrId = useId();
  const userId = useId();
  const passId = useId();
  const bypassId = useId();

  const [enabled, setEnabled] = useState(config.enabled);
  const [protocol, setProtocol] = useState<UpstreamProxyProtocol>(
    config.protocol
  );
  const [host, setHost] = useState(config.host);
  const [portText, setPortText] = useState(String(config.port || 8080));
  const [username, setUsername] = useState(config.username ?? "");
  const [passwordInput, setPasswordInput] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [bypassText, setBypassText] = useState(
    (config.bypassList.length > 0
      ? config.bypassList
      : DEFAULT_UPSTREAM_PROXY_BYPASS_LIST
    ).join("\n")
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEnabled(config.enabled);
    setProtocol(config.protocol);
    setHost(config.host);
    setPortText(
      String(
        config.port > 0 ? config.port : defaultPortForProtocol(config.protocol)
      )
    );
    setUsername(config.username ?? "");
    setPasswordInput("");
    setClearPassword(false);
    setShowPassword(false);
    setBypassText((config.bypassList ?? []).join("\n"));
    setErrors({});
    setSubmitError(null);
  }, [config]);

  const validateHost = useCallback(
    (rawHost: string, isEnabled: boolean): string | undefined => {
      const trimmed = rawHost.trim();
      if (!trimmed) {
        return isEnabled ? "Укажите хост или IP вышестоящего прокси." : undefined;
      }
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
        return "Указывайте только хост/IP без схемы (http://, socks5://).";
      }
      if (/\s/.test(trimmed)) {
        return "Хост не должен содержать пробелы.";
      }
      return undefined;
    },
    []
  );

  const validatePort = useCallback(
    (rawPort: string, isEnabled: boolean): string | undefined => {
      const trimmed = rawPort.trim();
      if (!trimmed) {
        return isEnabled ? "Укажите TCP-порт (1–65535)." : undefined;
      }
      if (!/^\d+$/.test(trimmed)) {
        return "Порт должен содержать только цифры.";
      }
      const num = Number.parseInt(trimmed, 10);
      if (!Number.isInteger(num) || num < 1 || num > 65535) {
        return "Порт должен быть в диапазоне от 1 до 65535.";
      }
      const cleanHost = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
      if (
        isEnabled &&
        num === proxyPort &&
        (cleanHost === "localhost" ||
          cleanHost === "127.0.0.1" ||
          cleanHost === "::1")
      ) {
        return `Обнаружена петля: порт :${proxyPort} совпадает с локальным FluxProxy.`;
      }
      return undefined;
    },
    [host, proxyPort]
  );

  const handleProtocolChange = (nextProto: UpstreamProxyProtocol) => {
    const prevDefault = defaultPortForProtocol(protocol);
    const nextDefault = defaultPortForProtocol(nextProto);
    setProtocol(nextProto);
    setPortText((prev) => {
      const trimmed = prev.trim();
      if (!trimmed || Number(trimmed) === prevDefault) {
        return String(nextDefault);
      }
      return prev;
    });
    setSubmitError(null);
    setSaveSuccess(null);
  };

  const handleAppendLanBypass = () => {
    const existing = parseBypassTextarea(bypassText);
    const seen = new Set(existing.map((x) => x.toLowerCase()));
    const additions = [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "fc00::/7",
    ];
    const merged = [...existing];
    for (const item of additions) {
      if (!seen.has(item)) {
        seen.add(item);
        merged.push(item);
      }
    }
    setBypassText(merged.join("\n"));
    setSaveSuccess(null);
  };

  const handleResetBypassDefaults = () => {
    setBypassText(DEFAULT_UPSTREAM_PROXY_BYPASS_LIST.join("\n"));
    setSaveSuccess(null);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitError(null);
    setSaveSuccess(null);

    const nextErrors: FieldErrors = {
      host: validateHost(host, enabled),
      port: validatePort(portText, enabled),
    };
    setErrors(nextErrors);

    if (nextErrors.host) {
      hostInputRef.current?.focus();
      return;
    }
    if (nextErrors.port) {
      portInputRef.current?.focus();
      return;
    }

    const parsedPort = portText.trim()
      ? Number.parseInt(portText.trim(), 10)
      : defaultPortForProtocol(protocol);
    const cleanUser = username.trim();

    let nextPassword: string | undefined;
    if (clearPassword) {
      nextPassword = "";
    } else if (passwordInput.length > 0) {
      nextPassword = passwordInput;
    } else {
      nextPassword = undefined;
    }

    const nextConfig: UpstreamProxyConfig = {
      enabled,
      protocol,
      host: host.trim(),
      port: parsedPort,
      username: cleanUser.length > 0 ? cleanUser : null,
      ...(nextPassword !== undefined ? { password: nextPassword } : {}),
      bypassList: parseBypassTextarea(bypassText),
    };

    setSaving(true);
    try {
      await onSave(nextConfig);
      setSaveSuccess(
        nextConfig.enabled
          ? `Настройки Upstream Proxy (${nextConfig.protocol.toUpperCase()} ${nextConfig.host}:${nextConfig.port}) применены.`
          : "Маршрутизация через Upstream Proxy отключена (Direct)."
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSubmitError(msg);
    } finally {
      setSaving(false);
    }
  };

  const hasSavedRamPassword = Boolean(config.hasPassword) && !clearPassword;

  return (
    <div id="upstream-proxy-section" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Network aria-hidden="true" className="h-4 w-4 text-accent" />
          <div>
            <div className="flex items-center gap-1.5">
              <h3 className="text-xs font-semibold text-fg">
                Upstream Proxy Chaining (HTTP / HTTPS / SOCKS5)
              </h3>
              <HelpTooltip
                label="Подробнее об Upstream Proxy Chaining"
                title="Каскадирование через корпоративный или локальный шлюз"
                content="Направляет весь исходящий трафик FluxProxy (HTTP, HTTPS, mTLS, WebSocket и Request Composer) через корпоративный HTTP/HTTPS-прокси или SOCKS5-туннель (SSH -D, VPN, Tor)."
                example="SOCKS5 127.0.0.1:1080"
              />
            </div>
            <p className="text-[11px] text-muted">
              Каскадирование HTTP, HTTPS (CONNECT), mTLS и WebSocket через
              вышестоящий прокси
            </p>
          </div>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold uppercase ${
            enabled
              ? "bg-status2xx-bg text-status2xx-fg"
              : "bg-elevated text-subtle"
          }`}
        >
          {enabled ? "ENABLED" : "DIRECT"}
        </span>
      </div>

      <form
        noValidate
        onSubmit={(e) => void handleSubmit(e)}
        className="space-y-4 rounded-lg border border-hairline bg-canvas p-3.5"
      >
        {/* Enable toggle */}
        <div className="flex items-center justify-between rounded-lg border border-hairline bg-surface px-3.5 py-2.5">
          <div className="flex items-center gap-2.5">
            <input
              id={enabledId}
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                const next = e.target.checked;
                setEnabled(next);
                if (!next) {
                  setErrors({});
                }
                setSubmitError(null);
                setSaveSuccess(null);
              }}
              className="checkbox-native"
            />
            <label
              htmlFor={enabledId}
              className="cursor-pointer font-medium text-fg select-none"
            >
              Включить маршрутизацию через вышестоящий прокси
            </label>
          </div>
          <span className="font-mono text-[10px] text-muted">
            {enabled ? `${protocol.toUpperCase()} Chain` : "Прямое подключение"}
          </span>
        </div>

        {/* Protocol */}
        <fieldset className="space-y-1.5">
          <legend className="text-[11px] font-semibold text-muted">
            Протокол вышестоящего прокси
          </legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {PROTOCOL_OPTIONS.map((opt) => {
              const radioId = `${protocolGroupName}-${opt.id}`;
              const active = protocol === opt.id;
              return (
                <label
                  key={opt.id}
                  htmlFor={radioId}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 transition-colors ${
                    active
                      ? "border-accent bg-accent/10 text-fg"
                      : "border-hairline bg-surface text-muted hover:border-strong hover:text-fg"
                  }`}
                >
                  <input
                    id={radioId}
                    type="radio"
                    name={protocolGroupName}
                    value={opt.id}
                    checked={active}
                    onChange={() => handleProtocolChange(opt.id)}
                    className="mt-0.5 accent-accent"
                  />
                  <span className="min-w-0">
                    <span className="block font-mono text-xs font-bold">
                      {opt.label}
                    </span>
                    <span className="block text-[10px] text-subtle">
                      {opt.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* Host + Port */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label
              htmlFor={hostId}
              className="mb-1 block text-[11px] font-medium text-muted"
            >
              Хост или IP-адрес прокси
            </label>
            <input
              ref={hostInputRef}
              id={hostId}
              type="text"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="127.0.0.1 или corp-proxy.internal"
              value={host}
              aria-invalid={Boolean(errors.host)}
              aria-describedby={errors.host ? hostErrId : undefined}
              onChange={(e) => {
                setHost(e.target.value);
                if (errors.host) {
                  setErrors((prev) => ({ ...prev, host: undefined }));
                }
                setSubmitError(null);
                setSaveSuccess(null);
              }}
              onBlur={() =>
                setErrors((prev) => ({
                  ...prev,
                  host: validateHost(host, enabled),
                }))
              }
              className={`w-full rounded-md border bg-surface px-2.5 py-1.5 font-mono text-xs text-fg outline-none transition-colors focus:border-accent ${
                errors.host ? "border-status5xx-fg" : "border-strong"
              }`}
            />
            {errors.host && (
              <p id={hostErrId} className="mt-1 text-[11px] text-status5xx-fg">
                {errors.host}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor={portId}
              className="mb-1 block text-[11px] font-medium text-muted"
            >
              Порт
            </label>
            <input
              ref={portInputRef}
              id={portId}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              placeholder={String(defaultPortForProtocol(protocol))}
              value={portText}
              aria-invalid={Boolean(errors.port)}
              aria-describedby={errors.port ? portErrId : undefined}
              onChange={(e) => {
                setPortText(e.target.value);
                if (errors.port) {
                  setErrors((prev) => ({ ...prev, port: undefined }));
                }
                setSubmitError(null);
                setSaveSuccess(null);
              }}
              onBlur={() =>
                setErrors((prev) => ({
                  ...prev,
                  port: validatePort(portText, enabled),
                }))
              }
              className={`w-full rounded-md border bg-surface px-2.5 py-1.5 font-mono text-xs text-fg outline-none transition-colors focus:border-accent ${
                errors.port ? "border-status5xx-fg" : "border-strong"
              }`}
            />
            {errors.port && (
              <p id={portErrId} className="mt-1 text-[11px] text-status5xx-fg">
                {errors.port}
              </p>
            )}
          </div>
        </div>

        {/* Credentials */}
        <div className="space-y-2 rounded-lg border border-hairline bg-surface/70 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
              <Lock className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
              <span>
                Аутентификация (
                {protocol === "socks5" ? "RFC 1929" : "Proxy-Authorization Basic"}
                )
              </span>
              <HelpTooltip
                label="Подробнее о безопасности пароля Upstream Proxy"
                title="Пароль хранится только в RAM"
                content="В целях безопасности пароль от корпоративного прокси передаётся в память Rust-ядра текущего сеанса и никогда не сохраняется в localStorage и не попадает в экспорт JSON-профиля."
              />
            </div>
            {hasSavedRamPassword && passwordInput.length === 0 && (
              <span className="rounded bg-status2xx-bg px-1.5 py-0.5 font-mono text-[10px] font-medium text-status2xx-fg">
                Пароль задан в RAM
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor={userId}
                className="mb-1 block text-[11px] font-medium text-muted"
              >
                Логин
              </label>
              <input
                id={userId}
                type="text"
                autoComplete="username"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Необязательно"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setSaveSuccess(null);
                }}
                className="w-full rounded-md border border-strong bg-canvas px-2.5 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
              />
            </div>

            <div>
              <label
                htmlFor={passId}
                className="mb-1 block text-[11px] font-medium text-muted"
              >
                Пароль
              </label>
              <div className="flex items-center gap-1.5">
                <div className="relative flex-1">
                  <input
                    id={passId}
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder={
                      hasSavedRamPassword
                        ? "•••••••• (оставьте пустым чтобы сохранить)"
                        : "Необязательно"
                    }
                    value={passwordInput}
                    onChange={(e) => {
                      setPasswordInput(e.target.value);
                      if (clearPassword) setClearPassword(false);
                      setSaveSuccess(null);
                    }}
                    className="w-full rounded-md border border-strong bg-canvas py-1.5 pl-2.5 pr-8 font-mono text-xs text-fg outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={
                      showPassword ? "Скрыть пароль" : "Показать пароль"
                    }
                    aria-pressed={showPassword}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-subtle hover:text-fg"
                  >
                    {showPassword ? (
                      <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                  </button>
                </div>
                {(hasSavedRamPassword || passwordInput.length > 0) && (
                  <button
                    type="button"
                    onClick={() => {
                      setPasswordInput("");
                      setClearPassword(true);
                      setSaveSuccess(null);
                    }}
                    title="Удалить сохранённый пароль прокси"
                    aria-label="Очистить пароль"
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[11px] text-muted hover:border-strong hover:text-status5xx-fg"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                    <span>Очистить</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-subtle">
            Пароль хранится только в оперативной памяти (RAM) текущего сеанса и
            никогда не записывается в <code>localStorage</code> и не экспортируется
            в профиль <code>FluxUserSettingsProfile</code>.
          </p>
        </div>

        {/* Bypass List */}
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <label
                htmlFor={bypassId}
                className="text-[11px] font-semibold text-muted"
              >
                Bypass List (исключения для прямого подключения)
              </label>
              <HelpTooltip
                label="Подробнее о Bypass List"
                title="Исключения маршрутизации (Direct)"
                content="Хосты из этого списка подключаются напрямую, минуя вышестоящий прокси. Токен <local> соответствует однокомпонентным именам без точки (например, intranet)."
                example="*.corp.local, 10.0.0.0/8, <local>"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleAppendLanBypass}
                className="rounded border border-hairline bg-surface px-2 py-0.5 text-[10px] font-medium text-muted hover:border-strong hover:text-fg"
              >
                + RFC1918 LAN
              </button>
              <button
                type="button"
                onClick={handleResetBypassDefaults}
                className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2 py-0.5 text-[10px] font-medium text-muted hover:border-strong hover:text-fg"
              >
                <RotateCcw className="h-2.5 w-2.5" aria-hidden="true" />
                <span>По умолчанию</span>
              </button>
            </div>
          </div>

          <textarea
            id={bypassId}
            rows={4}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            value={bypassText}
            onChange={(e) => {
              setBypassText(e.target.value);
              setSaveSuccess(null);
            }}
            placeholder={
              "localhost\n127.0.0.1\n::1\n<local>\n*.corp.local\n10.0.0.0/8"
            }
            className="w-full resize-y rounded-md border border-strong bg-surface p-2.5 font-mono text-[11px] leading-relaxed text-fg outline-none focus:border-accent"
          />
          <p className="text-[11px] text-subtle">
            По одному правилу на строку (или через запятую):{" "}
            <code>localhost</code>, <code>&lt;local&gt;</code>,{" "}
            <code>*.corp.local</code>, <code>.internal</code>, CIDR (
            <code>10.0.0.0/8</code>, <code>fd00::/8</code>),{" "}
            <code>host:port</code>.
          </p>
        </div>

        {submitError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-status5xx-fg/40 bg-status5xx-bg px-3 py-2 text-xs text-status5xx-fg"
          >
            <ShieldAlert
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <span>{submitError}</span>
          </div>
        )}

        {saveSuccess && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-start gap-2 rounded-lg border border-status2xx-fg/40 bg-status2xx-bg px-3 py-2 text-xs text-status2xx-fg"
          >
            <CheckCircle2
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <span>{saveSuccess}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-accent px-4 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {saving ? "Сохранение…" : "Применить Upstream Proxy"}
          </button>
        </div>
      </form>
    </div>
  );
};
