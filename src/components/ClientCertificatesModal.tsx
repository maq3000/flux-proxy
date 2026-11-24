import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  FileKey2,
  FolderOpen,
  KeyRound,
  Lock,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { proxyBridge } from "../lib/tauriBridge";
import type { ClientCertificateEntry } from "../types/proxy";

interface ClientCertificatesModalProps {
  open: boolean;
  onClose: () => void;
  onNotify: (msg: string) => void;
}

interface StatusFeedback {
  tone: "success" | "error";
  text: string;
}

const EXPIRING_SOON_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function detectCertificateFormat(certPath: string): "pkcs12" | "pem" {
  const lower = certPath.trim().toLowerCase();
  if (
    lower.endsWith(".pem") ||
    lower.endsWith(".crt") ||
    lower.endsWith(".cer")
  ) {
    return "pem";
  }
  return "pkcs12";
}

function validateDomainMaskInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "Укажите домен или маску (например, api.corp.local или *.corp.local).";
  }
  if (/\s/.test(trimmed)) {
    return "Маска домена не должна содержать пробелы.";
  }
  let clean = trimmed.replace(/^(https?|wss?):\/\//i, "");
  const slashIdx = clean.indexOf("/");
  if (slashIdx >= 0) {
    clean = clean.slice(0, slashIdx);
  }
  if (!clean.startsWith("[")) {
    const colonCount = (clean.match(/:/g) ?? []).length;
    if (colonCount === 1) {
      clean = clean.replace(/:\d+$/, "");
    }
  }
  clean = clean.replace(/\.+$/, "").toLowerCase();
  if (!clean || clean === "*" || clean === "*.") {
    return "Укажите конкретный домен или маску вида *.domain.com вместо '*'.";
  }
  if (clean.startsWith("*.")) {
    const suffix = clean.slice(2);
    if (
      !suffix ||
      suffix.includes("*") ||
      suffix.startsWith(".") ||
      suffix.includes("..")
    ) {
      return "Некорректная wildcard-маска. Ожидается формат *.domain.com.";
    }
  } else if (clean.includes("*")) {
    return "Wildcard '*' допускается только в начале маски (*.domain.com).";
  } else if (clean.startsWith(".") || clean.includes("..")) {
    return "Некорректное имя домена.";
  }
  return null;
}

function validateCertFileInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "Выберите файл клиентского сертификата (.p12, .pfx, .pem, .crt или .cer).";
  }
  const fileName = trimmed.split(/[\\/]/).pop() ?? trimmed;
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  if (!["p12", "pfx", "pem", "crt", "cer"].includes(ext)) {
    return `Неподдерживаемое расширение '.${ext}'. Используйте .p12, .pfx, .pem, .crt или .cer.`;
  }
  return null;
}

interface ExpiryPresentation {
  formattedDate: string;
  state: "expired" | "expiring" | "valid" | "unknown";
  badgeLabel: string;
}

function describeCertificateExpiry(expiresAt: string): ExpiryPresentation {
  const parsedMs = Date.parse(expiresAt);
  if (Number.isNaN(parsedMs)) {
    return {
      formattedDate: expiresAt || "—",
      state: "unknown",
      badgeLabel: "Срок неизвестен",
    };
  }
  const formattedDate = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(new Date(parsedMs));

  const diffMs = parsedMs - Date.now();
  if (diffMs <= 0) {
    const daysAgo = Math.max(1, Math.floor(Math.abs(diffMs) / DAY_MS));
    return {
      formattedDate,
      state: "expired",
      badgeLabel: `Истёк ${daysAgo} дн. назад`,
    };
  }
  if (diffMs <= EXPIRING_SOON_WINDOW_MS) {
    const daysLeft = Math.max(1, Math.ceil(diffMs / DAY_MS));
    return {
      formattedDate,
      state: "expiring",
      badgeLabel: `Истекает через ${daysLeft} дн.`,
    };
  }
  return {
    formattedDate,
    state: "valid",
    badgeLabel: "Действителен",
  };
}

export const ClientCertificatesModal: React.FC<ClientCertificatesModalProps> = ({
  open,
  onClose,
  onNotify,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const domainInputRef = useRef<HTMLInputElement>(null);
  const certPathInputRef = useRef<HTMLInputElement>(null);

  const titleId = useId();
  const formHeadingId = useId();
  const tableCaptionId = useId();
  const domainInputId = useId();
  const domainHintId = useId();
  const domainErrorId = useId();
  const labelInputId = useId();
  const certPathInputId = useId();
  const certPathErrorId = useId();
  const keyPathInputId = useId();
  const keyPathHintId = useId();
  const passwordInputId = useId();
  const passwordHintId = useId();
  const passwordToggleWarningId = useId();
  const ephemeralCheckboxId = useId();

  const [entries, setEntries] = useState<ClientCertificateEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<StatusFeedback | null>(null);

  const [domainPattern, setDomainPattern] = useState("");
  const [domainTouched, setDomainTouched] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [certPath, setCertPath] = useState("");
  const [certPathTouched, setCertPathTouched] = useState(false);
  const [certPathError, setCertPathError] = useState<string | null>(null);

  const [keyPath, setKeyPath] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [ephemeral, setEphemeral] = useState(false);

  const supportsNativeSwitch =
    typeof HTMLInputElement !== "undefined" &&
    "switch" in HTMLInputElement.prototype;

  const detectedFormat = detectCertificateFormat(certPath);
  const isPemSelected = detectedFormat === "pem" && certPath.trim().length > 0;

  const loadCertificates = useCallback(async () => {
    setLoading(true);
    try {
      const list = await proxyBridge.listClientCertificates();
      setEntries(list);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({
        tone: "error",
        text: `Не удалось загрузить список клиентских сертификатов: ${msg}`,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      setFeedback(null);
      setDomainError(null);
      setCertPathError(null);
      setDomainTouched(false);
      setCertPathTouched(false);
      if (!dialog.open) {
        dialog.showModal();
      }
      void loadCertificates();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, loadCertificates]);

  // Light-dismiss pointer-bounds fallback when `<dialog closedby="any">` is not natively supported
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

  const handleBrowseCertFile = async () => {
    try {
      const picked = await proxyBridge.pickOpenFileDialog({
        title: "Выберите клиентский сертификат (.p12, .pfx, .pem)",
        filters: [
          {
            name: "Client Certificates",
            extensions: ["p12", "pfx", "pem", "crt", "cer"],
          },
          { name: "PKCS#12 Archive", extensions: ["p12", "pfx"] },
          { name: "PEM Certificate", extensions: ["pem", "crt", "cer"] },
        ],
      });
      if (picked) {
        setCertPath(picked);
        setCertPathError(null);
        setFeedback(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({
        tone: "error",
        text: `Не удалось открыть диалог выбора файла: ${msg}`,
      });
    }
  };

  const handleBrowseKeyFile = async () => {
    try {
      const picked = await proxyBridge.pickOpenFileDialog({
        title: "Выберите файл закрытого ключа (.key, .pem)",
        filters: [
          { name: "Private Key", extensions: ["key", "pem"] },
        ],
      });
      if (picked) {
        setKeyPath(picked);
        setFeedback(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({
        tone: "error",
        text: `Не удалось открыть диалог выбора ключа: ${msg}`,
      });
    }
  };

  const handleAddCertificate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFeedback(null);

    const domErr = validateDomainMaskInput(domainPattern);
    const fileErr = validateCertFileInput(certPath);
    setDomainTouched(true);
    setCertPathTouched(true);
    setDomainError(domErr);
    setCertPathError(fileErr);

    if (domErr) {
      domainInputRef.current?.focus();
      return;
    }
    if (fileErr) {
      certPathInputRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const created = await proxyBridge.addClientCertificate({
        domainPattern: domainPattern.trim(),
        label: label.trim() || null,
        certPath: certPath.trim(),
        keyPath: isPemSelected && keyPath.trim() ? keyPath.trim() : null,
        password: !isPemSelected && password ? password : null,
        enabled: true,
        ephemeral,
      });

      setEntries((prev) => [...prev, created]);
      setDomainPattern("");
      setDomainTouched(false);
      setDomainError(null);
      setLabel("");
      setCertPath("");
      setCertPathTouched(false);
      setCertPathError(null);
      setKeyPath("");
      setPassword("");
      setShowPassword(false);
      setEphemeral(false);

      const msg = `mTLS сертификат '${created.commonName}' привязан к '${created.domainPattern}'`;
      setFeedback({ tone: "success", text: msg });
      onNotify(msg);
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "error", text: errText });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleCertificate = async (
    entry: ClientCertificateEntry,
    nextEnabled: boolean
  ) => {
    setBusyId(entry.id);
    setFeedback(null);
    try {
      const updated = await proxyBridge.toggleClientCertificate(
        entry.id,
        nextEnabled
      );
      setEntries((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item))
      );
      onNotify(
        `mTLS для '${updated.domainPattern}' ${
          updated.enabled ? "включён" : "отключён"
        }`
      );
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "error", text: errText });
    } finally {
      setBusyId(null);
    }
  };

  const handleRemoveCertificate = async (entry: ClientCertificateEntry) => {
    setBusyId(entry.id);
    setFeedback(null);
    try {
      const remaining = await proxyBridge.removeClientCertificate(entry.id);
      setEntries(remaining);
      const msg = `Удалён mTLS сертификат для '${entry.domainPattern}'`;
      setFeedback({ tone: "success", text: msg });
      onNotify(msg);
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      setFeedback({ tone: "error", text: errText });
    } finally {
      setBusyId(null);
    }
  };

  const activeCount = entries.filter((e) => e.enabled).length;
  const expiringOrExpiredCount = entries.filter((e) => {
    const info = describeCertificateExpiry(e.expiresAt);
    return info.state === "expired" || info.state === "expiring";
  }).length;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        setPassword("");
        setShowPassword(false);
        setEphemeral(false);
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto w-full max-w-4xl rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:max-h-[90vh] open:flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <div className="flex items-center gap-2.5">
          <FileKey2
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-accent"
          />
          <div>
            <h2 id={titleId} className="text-sm font-semibold">
              Client Certificates (Upstream mTLS)
            </h2>
            <p className="text-[11px] text-muted">
              Привязка клиентских сертификатов PKCS#12 (.p12 / .pfx) и PEM к
              доменам для исходящих TLS-соединений
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Закрыть управление клиентскими сертификатами"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {/* Main Scrollable Content */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4 text-xs">
        {/* Add Client Certificate Form (separate from <form method="dialog">) */}
        <form
          onSubmit={(e) => void handleAddCertificate(e)}
          noValidate
          aria-labelledby={formHeadingId}
          className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3
              id={formHeadingId}
              className="flex items-center gap-1.5 text-xs font-semibold text-fg"
            >
              <Plus aria-hidden="true" className="h-3.5 w-3.5 text-accent" />
              <span>Добавить клиентский сертификат</span>
            </h3>
            <span className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2 py-0.5 font-mono text-[10px] text-muted">
              <KeyRound aria-hidden="true" className="h-3 w-3 text-accent" />
              <span>
                Формат: {isPemSelected ? "PEM (.pem / .crt)" : "PKCS#12 (.p12 / .pfx)"}
              </span>
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {/* Domain Pattern */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor={domainInputId}
                className="text-[11px] font-medium text-fg"
              >
                Маска домена <span aria-hidden="true" className="text-rose-400">*</span>
              </label>
              <input
                ref={domainInputRef}
                id={domainInputId}
                name="domainPattern"
                type="text"
                required
                autoFocus
                {...({ autofocus: "" } as Record<string, string>)}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="*.corp.local или api.partner.com"
                value={domainPattern}
                aria-invalid={domainError ? "true" : "false"}
                aria-describedby={
                  domainError
                    ? `${domainHintId} ${domainErrorId}`
                    : domainHintId
                }
                onChange={(e) => {
                  setDomainPattern(e.target.value);
                  if (domainError) setDomainError(null);
                }}
                onBlur={() => {
                  if (domainTouched || domainPattern.trim().length > 0) {
                    setDomainTouched(true);
                    setDomainError(validateDomainMaskInput(domainPattern));
                  }
                }}
                className={`rounded-md border bg-surface px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  domainError
                    ? "border-rose-500/70 bg-rose-500/5"
                    : "border-strong"
                }`}
              />
              <span id={domainHintId} className="text-[10px] text-subtle">
                Точный хост (<code>api.example.com</code>) или поддомены (
                <code>*.example.com</code>).
              </span>
              {domainError && (
                <span
                  id={domainErrorId}
                  role="alert"
                  className="text-[11px] font-medium text-rose-400"
                >
                  {domainError}
                </span>
              )}
            </div>

            {/* Optional Friendly Label */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor={labelInputId}
                className="text-[11px] font-medium text-fg"
              >
                Метка (необязательно)
              </label>
              <input
                id={labelInputId}
                name="label"
                type="text"
                placeholder="По умолчанию берётся Common Name (CN)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="rounded-md border border-strong bg-surface px-2.5 py-1.5 text-xs text-fg placeholder:text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
              <span className="text-[10px] text-subtle">
                Отображается в списке правил для быстрого поиска.
              </span>
            </div>

            {/* Certificate File Path */}
            <div className="flex flex-col gap-1">
              <label
                htmlFor={certPathInputId}
                className="text-[11px] font-medium text-fg"
              >
                Файл сертификата (.p12, .pfx, .pem){" "}
                <span aria-hidden="true" className="text-rose-400">*</span>
              </label>
              <div className="flex gap-1.5">
                <input
                  ref={certPathInputRef}
                  id={certPathInputId}
                  name="certPath"
                  type="text"
                  required
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="C:\certs\client.p12 или /path/to/identity.pem"
                  value={certPath}
                  aria-invalid={certPathError ? "true" : "false"}
                  aria-describedby={certPathError ? certPathErrorId : undefined}
                  onChange={(e) => {
                    setCertPath(e.target.value);
                    if (certPathError) setCertPathError(null);
                  }}
                  onBlur={() => {
                    if (certPathTouched || certPath.trim().length > 0) {
                      setCertPathTouched(true);
                      setCertPathError(validateCertFileInput(certPath));
                    }
                  }}
                  className={`min-w-0 flex-1 rounded-md border bg-surface px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    certPathError
                      ? "border-rose-500/70 bg-rose-500/5"
                      : "border-strong"
                  }`}
                />
                <button
                  type="button"
                  onClick={() => void handleBrowseCertFile()}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-strong bg-surface px-2.5 py-1.5 text-[11px] font-medium text-fg hover:bg-hover"
                >
                  <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
                  <span>Обзор…</span>
                </button>
              </div>
              {certPathError && (
                <span
                  id={certPathErrorId}
                  role="alert"
                  className="text-[11px] font-medium text-rose-400"
                >
                  {certPathError}
                </span>
              )}
            </div>

            {/* Dynamic field: Password for PKCS#12 OR Optional Key File for PEM */}
            {isPemSelected ? (
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={keyPathInputId}
                  className="text-[11px] font-medium text-fg"
                >
                  Файл закрытого ключа (.key / .pem, если отдельно)
                </label>
                <div className="flex gap-1.5">
                  <input
                    id={keyPathInputId}
                    name="keyPath"
                    type="text"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="Оставьте пустым, если ключ внутри .pem"
                    value={keyPath}
                    aria-describedby={keyPathHintId}
                    onChange={(e) => setKeyPath(e.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  />
                  <button
                    type="button"
                    onClick={() => void handleBrowseKeyFile()}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-strong bg-surface px-2.5 py-1.5 text-[11px] font-medium text-fg hover:bg-hover"
                  >
                    <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
                    <span>Ключ…</span>
                  </button>
                </div>
                <span id={keyPathHintId} className="text-[10px] text-subtle">
                  Поддерживаются незашифрованные ключи PKCS#8, PKCS#1 RSA и SEC1 EC.
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={passwordInputId}
                  className="text-[11px] font-medium text-fg"
                >
                  Пароль PKCS#12 (.p12 / .pfx)
                </label>
                <div className="flex gap-1.5">
                  <input
                    id={passwordInputId}
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="off"
                    placeholder="Пусто, если архив без пароля"
                    value={password}
                    aria-describedby={passwordHintId}
                    onChange={(e) => setPassword(e.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  />
                  <button
                    type="button"
                    aria-pressed={showPassword}
                    aria-label={
                      showPassword ? "Скрыть пароль" : "Показать пароль"
                    }
                    aria-describedby={passwordToggleWarningId}
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="inline-flex shrink-0 items-center justify-center rounded-md border border-strong bg-surface px-2.5 py-1.5 text-muted hover:bg-hover hover:text-fg"
                  >
                    {showPassword ? (
                      <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
                    ) : (
                      <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <span id={passwordToggleWarningId} className="sr-only">
                    Внимание: пароль будет показан открытым текстом на экране.
                  </span>
                </div>
                <span id={passwordHintId} className="text-[10px] text-subtle">
                  Используется только при импорте и не сохраняется в JSON-профиль.
                </span>
              </div>
            )}
          </div>

          <div className="rounded-md border border-hairline bg-surface/60 px-3 py-2">
            <label
              htmlFor={ephemeralCheckboxId}
              className="flex cursor-pointer items-start gap-2"
            >
              <input
                id={ephemeralCheckboxId}
                type="checkbox"
                checked={ephemeral}
                onChange={(e) => setEphemeral(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-strong accent-amber-500"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-[11px] font-medium text-fg">
                  Session-only (In-Memory, do not save key to disk)
                </span>
                <span className="text-[10px] text-subtle">
                  Сертификат и закрытый ключ хранятся только в оперативной памяти (RAM) до закрытия FluxProxy и не записываются на диск.
                </span>
              </span>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
              <Lock aria-hidden="true" className="h-3 w-3 text-emerald-400" />
              <span>
                {ephemeral
                  ? "Хранится только в RAM на время текущей сессии (на диск не сохраняется)"
                  : "Приватный ключ шифруется Windows DPAPI / правами 0600 в локальном хранилище"}
              </span>
            </span>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Plus aria-hidden="true" className="h-3.5 w-3.5" />
              <span>
                {submitting
                  ? "Проверка и импорт…"
                  : "Добавить клиентский сертификат"}
              </span>
            </button>
          </div>
        </form>

        {/* Feedback Banner */}
        {feedback && (
          <div
            role={feedback.tone === "error" ? "alert" : "status"}
            aria-live={feedback.tone === "error" ? "assertive" : "polite"}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
              feedback.tone === "error"
                ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            }`}
          >
            {feedback.tone === "error" ? (
              <AlertCircle
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
            ) : (
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
            )}
            <span className="break-words leading-relaxed">{feedback.text}</span>
          </div>
        )}

        {/* Certificates Summary + Responsive Table */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold text-fg">
                Установленные сертификаты ({entries.length})
              </h3>
              <span className="rounded-full border border-hairline bg-elevated px-2 py-0.5 font-mono text-[10px] text-muted">
                Активно: {activeCount}
              </span>
            </div>
            {expiringOrExpiredCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-300">
                <AlertTriangle aria-hidden="true" className="h-3 w-3" />
                <span>
                  Требуют внимания (истекают / истекли): {expiringOrExpiredCount}
                </span>
              </span>
            )}
          </div>

          {loading ? (
            <div className="rounded-lg border border-hairline bg-canvas p-6 text-center text-muted">
              Загрузка хранилища клиентских сертификатов…
            </div>
          ) : entries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-strong bg-canvas p-6 text-center text-muted">
              Клиентские сертификаты (mTLS) ещё не добавлены. Загрузите{" "}
              <code className="font-mono text-fg">.p12</code>,{" "}
              <code className="font-mono text-fg">.pfx</code> или{" "}
              <code className="font-mono text-fg">.pem</code> выше и привяжите к
              маске домена.
            </div>
          ) : (
            <div
              tabIndex={0}
              role="region"
              aria-labelledby={tableCaptionId}
              className="filter-table-wrapper max-h-72 rounded-lg border border-hairline bg-canvas"
            >
              <table
                className="filter-data-table text-left text-xs"
                style={
                  {
                    "--label-2": '"Common Name (CN)"',
                    "--label-3": '"Срок действия"',
                    "--label-4": '"Активен"',
                    "--label-5": '"Действия"',
                  } as React.CSSProperties
                }
              >
                <caption id={tableCaptionId} className="sr-only">
                  Список клиентских сертификатов mTLS и их привязка к доменам
                </caption>
                <thead>
                  <tr className="border-b border-hairline text-[11px] font-semibold uppercase tracking-wider text-subtle">
                    <th scope="col" className="px-3 py-2">
                      Домен / Метка
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Common Name (CN)
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Срок действия
                    </th>
                    <th scope="col" className="px-3 py-2 text-center">
                      Активен
                    </th>
                    <th scope="col" className="px-3 py-2 text-right">
                      Действия
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {entries.map((entry) => {
                    const expiry = describeCertificateExpiry(entry.expiresAt);
                    const isRowBusy = busyId === entry.id;
                    return (
                      <tr
                        key={entry.id}
                        className={entry.enabled ? "" : "opacity-65"}
                      >
                        <th
                          scope="row"
                          className="px-3 py-2.5 align-top font-normal"
                        >
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-xs font-semibold text-fg">
                                {entry.domainPattern}
                              </span>
                              <span className="rounded border border-hairline bg-elevated px-1.5 py-0.2 font-mono text-[10px] uppercase text-sky-400">
                                {entry.format === "pkcs12" ? "PKCS#12" : "PEM"}
                              </span>
                              {entry.ephemeral && (
                                <span
                                  title="Хранится только в RAM (не записан на диск)"
                                  className="rounded border border-amber-500/40 bg-amber-500/12 px-1.5 py-0.2 font-mono text-[10px] font-semibold uppercase text-amber-300"
                                >
                                  RAM ONLY
                                </span>
                              )}
                            </div>
                            <span
                              className="max-w-[220px] truncate text-[11px] text-muted"
                              title={entry.label}
                            >
                              {entry.label}
                            </span>
                          </div>
                        </th>

                        <td data-col="2" className="px-3 py-2.5 align-middle">
                          <span
                            className="inline-block max-w-[200px] truncate font-mono text-[11px] text-fg"
                            title={entry.commonName}
                          >
                            {entry.commonName}
                          </span>
                        </td>

                        <td data-col="3" className="px-3 py-2.5 align-middle">
                          <div className="flex flex-col gap-1">
                            <span className="font-mono text-[11px] text-muted">
                              {expiry.formattedDate}
                            </span>
                            {expiry.state === "expired" && (
                              <span className="inline-flex w-fit items-center gap-1 rounded border border-rose-500/40 bg-rose-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300">
                                <AlertTriangle
                                  aria-hidden="true"
                                  className="h-3 w-3 shrink-0"
                                />
                                <span>{expiry.badgeLabel}</span>
                              </span>
                            )}
                            {expiry.state === "expiring" && (
                              <span className="inline-flex w-fit items-center gap-1 rounded border border-amber-500/40 bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                                <AlertTriangle
                                  aria-hidden="true"
                                  className="h-3 w-3 shrink-0"
                                />
                                <span>{expiry.badgeLabel}</span>
                              </span>
                            )}
                            {expiry.state === "valid" && (
                              <span className="inline-flex w-fit items-center gap-1 text-[10px] text-emerald-400">
                                <CheckCircle2
                                  aria-hidden="true"
                                  className="h-3 w-3 shrink-0"
                                />
                                <span>{expiry.badgeLabel}</span>
                              </span>
                            )}
                          </div>
                        </td>

                        <td
                          data-col="4"
                          className="px-3 py-2.5 text-center align-middle"
                        >
                          <input
                            type="checkbox"
                            {...({ switch: "" } as Record<string, string>)}
                            {...(!supportsNativeSwitch
                              ? {
                                  role: "switch",
                                  "data-switch-fallback": "true",
                                }
                              : {})}
                            checked={entry.enabled}
                            disabled={isRowBusy}
                            aria-label={`Использовать клиентский сертификат для ${entry.domainPattern}`}
                            onChange={(e) =>
                              void handleToggleCertificate(
                                entry,
                                e.target.checked
                              )
                            }
                            className="cert-switch"
                          />
                        </td>

                        <td
                          data-col="5"
                          className="px-3 py-2.5 text-right align-middle"
                        >
                          <button
                            type="button"
                            disabled={isRowBusy}
                            aria-label={`Удалить сертификат для ${entry.domainPattern}`}
                            title="Удалить сертификат из хранилища"
                            onClick={() => void handleRemoveCertificate(entry)}
                            className="inline-flex items-center gap-1 rounded border border-rose-500/35 bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
                          >
                            <Trash2 aria-hidden="true" className="h-3 w-3" />
                            <span>Удалить</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline bg-elevated/40 px-4 py-3">
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <ShieldCheck
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-emerald-400"
          />
          <span>
            Кэш mTLS-клиентов автоматически обновляется при любых изменениях.
            Пароли не экспортируются в JSON-профиль настроек.
          </span>
        </span>
        <form method="dialog">
          <button
            value="cancel"
            className="rounded-md border border-strong bg-surface px-3 py-1.5 text-xs font-medium text-muted hover:text-fg"
          >
            Close
          </button>
        </form>
      </div>
    </dialog>
  );
};
