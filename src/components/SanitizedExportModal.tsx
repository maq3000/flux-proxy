import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Check,
  Download,
  EyeOff,
  FileArchive,
  FileCode2,
  FileJson,
  FileText,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  UserX,
  X,
} from "lucide-react";
import {
  loadPersistedSanitizationOptions,
  savePersistedSanitizationOptions,
} from "../lib/settingsManager";
import {
  BUILTIN_REDACTED_AUTH_HEADERS,
  DEFAULT_MASK_JSON_KEYS,
  DEFAULT_SANITIZATION_OPTIONS,
  DEFAULT_SANITIZATION_REPLACEMENT,
  DEFAULT_STRIP_QUERY_PARAMS,
  type ExportArchiveFormat,
  type SanitizationOptions,
  type SanitizationPresetId,
} from "../types/proxy";
import { SETTINGS_APPLIED_EVENT } from "../types/settings";

interface SanitizedExportModalProps {
  open: boolean;
  totalCount: number;
  selectedIds: number[];
  onClose: () => void;
  onExport: (
    targetIds: number[],
    format: ExportArchiveFormat,
    options: SanitizationOptions
  ) => Promise<boolean>;
}

const STRICT_CUSTOM_HEADERS = [
  "X-Forwarded-For",
  "X-Real-IP",
  "CF-Connecting-IP",
  "True-Client-IP",
  "X-Client-IP",
  "X-Device-Id",
  "X-Session-Id",
];

const STRICT_MASK_JSON_KEYS = [
  ...DEFAULT_MASK_JSON_KEYS,
  "email",
  "phone",
  "ssn",
  "client_secret",
  "private_key",
  "session_id",
  "user_id",
];

const STRICT_STRIP_QUERY_PARAMS = [
  ...DEFAULT_STRIP_QUERY_PARAMS,
  "session",
  "session_id",
  "email",
  "user",
  "state",
  "nonce",
];

export const SANITIZATION_PRESETS: Record<
  Exclude<SanitizationPresetId, "custom">,
  {
    label: string;
    subtitle: string;
    options: SanitizationOptions;
  }
> = {
  safeSharing: {
    label: "Safe Sharing",
    subtitle:
      "Удаляет токены авторизации, cookie, секреты JSON/form и query-параметры; сохраняет метаданные клиента.",
    options: structuredClone(DEFAULT_SANITIZATION_OPTIONS),
  },
  strictAnonymization: {
    label: "Strict Anonymization",
    subtitle:
      "Максимальная очистка: заголовки, прокси-IP, PII-ключи (email/phone/ssn), query и анонимизация клиента/процесса.",
    options: {
      redactAuthHeaders: true,
      customRedactedHeaders: [...STRICT_CUSTOM_HEADERS],
      maskJsonKeys: [...STRICT_MASK_JSON_KEYS],
      stripQueryParams: [...STRICT_STRIP_QUERY_PARAMS],
      anonymizeClientInfo: true,
      replacementText: DEFAULT_SANITIZATION_REPLACEMENT,
    },
  },
};

const FORMAT_CARDS: {
  id: ExportArchiveFormat;
  label: string;
  ext: string;
  hint: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "har",
    label: "HAR 1.2",
    ext: ".har",
    hint: "Chrome / Firefox / Charles",
    icon: <FileCode2 className="h-4 w-4" />,
  },
  {
    id: "saz",
    label: "Fiddler SAZ",
    ext: ".saz",
    hint: "Fiddler Classic Archive",
    icon: <FileArchive className="h-4 w-4" />,
  },
  {
    id: "json",
    label: "FluxProxy JSON",
    ext: ".json",
    hint: "Lossless Session Array",
    icon: <FileJson className="h-4 w-4" />,
  },
  {
    id: "raw",
    label: "Raw HTTP",
    ext: ".txt",
    hint: "Wire-style HTTP Dump",
    icon: <FileText className="h-4 w-4" />,
  },
];

function parseTokenList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;\n\r]+/)) {
    const clean = part.trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(clean);
    }
  }
  return out;
}

function sameTokenSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const setB = new Set(b.map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (setA.size !== setB.size) return false;
  for (const item of setA) {
    if (!setB.has(item)) return false;
  }
  return true;
}

function matchesSanitizationOptions(
  a: SanitizationOptions,
  b: SanitizationOptions
): boolean {
  return (
    a.redactAuthHeaders === b.redactAuthHeaders &&
    a.anonymizeClientInfo === b.anonymizeClientInfo &&
    (a.replacementText.trim() || DEFAULT_SANITIZATION_REPLACEMENT) ===
      (b.replacementText.trim() || DEFAULT_SANITIZATION_REPLACEMENT) &&
    sameTokenSet(a.customRedactedHeaders, b.customRedactedHeaders) &&
    sameTokenSet(a.maskJsonKeys, b.maskJsonKeys) &&
    sameTokenSet(a.stripQueryParams, b.stripQueryParams)
  );
}

function inferPresetId(opts: SanitizationOptions): SanitizationPresetId {
  if (matchesSanitizationOptions(opts, SANITIZATION_PRESETS.safeSharing.options)) {
    return "safeSharing";
  }
  if (
    matchesSanitizationOptions(
      opts,
      SANITIZATION_PRESETS.strictAnonymization.options
    )
  ) {
    return "strictAnonymization";
  }
  return "custom";
}

export const SanitizedExportModal: React.FC<SanitizedExportModalProps> = ({
  open,
  totalCount,
  selectedIds,
  onClose,
  onExport,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const [format, setFormat] = useState<ExportArchiveFormat>("har");
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [options, setOptions] = useState<SanitizationOptions>(() =>
    loadPersistedSanitizationOptions()
  );
  const [activePreset, setActivePreset] = useState<SanitizationPresetId>(() =>
    inferPresetId(loadPersistedSanitizationOptions())
  );

  const [customHeadersDraft, setCustomHeadersDraft] = useState(() =>
    options.customRedactedHeaders.join(", ")
  );
  const [maskKeysDraft, setMaskKeysDraft] = useState(() =>
    options.maskJsonKeys.join(", ")
  );
  const [stripParamsDraft, setStripParamsDraft] = useState(() =>
    options.stripQueryParams.join(", ")
  );
  const [isExporting, setIsExporting] = useState(false);

  const syncDraftsFromOptions = (next: SanitizationOptions) => {
    setCustomHeadersDraft(next.customRedactedHeaders.join(", "));
    setMaskKeysDraft(next.maskJsonKeys.join(", "));
    setStripParamsDraft(next.stripQueryParams.join(", "));
  };

  const applyAndPersistOptions = (
    next: SanitizationOptions,
    explicitPreset?: SanitizationPresetId
  ) => {
    setOptions(next);
    setActivePreset(explicitPreset ?? inferPresetId(next));
    savePersistedSanitizationOptions(next);
  };

  useEffect(() => {
    const onSettingsApplied = () => {
      const loaded = loadPersistedSanitizationOptions();
      setOptions(loaded);
      setActivePreset(inferPresetId(loaded));
      syncDraftsFromOptions(loaded);
    };
    window.addEventListener(SETTINGS_APPLIED_EVENT, onSettingsApplied);
    return () =>
      window.removeEventListener(SETTINGS_APPLIED_EVENT, onSettingsApplied);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      const loaded = loadPersistedSanitizationOptions();
      setOptions(loaded);
      setActivePreset(inferPresetId(loaded));
      syncDraftsFromOptions(loaded);
      setScope(selectedIds.length > 0 ? "selected" : "all");
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, selectedIds.length]);

  // Light-dismiss pointer-bounds fallback when `<dialog closedby="any">` is not supported
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

  const handleSelectPreset = (presetId: SanitizationPresetId) => {
    if (presetId === "custom") {
      setActivePreset("custom");
      return;
    }
    const presetOpts = structuredClone(SANITIZATION_PRESETS[presetId].options);
    syncDraftsFromOptions(presetOpts);
    applyAndPersistOptions(presetOpts, presetId);
  };

  const effectiveReplacement = options.replacementText.trim()
    ? options.replacementText
    : DEFAULT_SANITIZATION_REPLACEMENT;

  const previewSample = useMemo(() => {
    const hasAuthHeader = options.redactAuthHeaders;
    const hasTokenQuery = options.stripQueryParams.some(
      (p) => p.toLowerCase() === "token"
    );
    const hasPasswordJson = options.maskJsonKeys.some(
      (k) => k.toLowerCase() === "password"
    );
    const hasRefreshForm = options.maskJsonKeys.some(
      (k) => k.toLowerCase() === "refresh_token"
    );

    return {
      url: hasTokenQuery
        ? `POST /oauth/login?token=${effectiveReplacement}&lang=ru`
        : "POST /oauth/login?token=eyJhbGciOi...&lang=ru",
      authHeader: hasAuthHeader
        ? `Authorization: ${effectiveReplacement}`
        : "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...",
      cookieHeader: hasAuthHeader
        ? `Cookie: ${effectiveReplacement}`
        : "Cookie: session_id=fx_98172bc01; csrf=9b81e2",
      jsonBody: hasPasswordJson
        ? `{"email":"dev@corp.io","password":"${effectiveReplacement}"}`
        : '{"email":"dev@corp.io","password":"s3cr3t!Password"}',
      formBody: hasRefreshForm
        ? `grant_type=refresh_token&refresh_token=${effectiveReplacement}`
        : "grant_type=refresh_token&refresh_token=live_77410f",
      clientMeta: options.anonymizeClientInfo
        ? "0.0.0.0:0 • redacted-process"
        : "192.168.1.42:54310 • chrome.exe (PID 9042)",
    };
  }, [
    effectiveReplacement,
    options.anonymizeClientInfo,
    options.maskJsonKeys,
    options.redactAuthHeaders,
    options.stripQueryParams,
  ]);

  const effectiveTargetIds =
    scope === "selected" && selectedIds.length > 0 ? selectedIds : [];
  const exportSessionCount =
    scope === "selected" && selectedIds.length > 0
      ? selectedIds.length
      : totalCount;

  const handleSubmitExport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isExporting || exportSessionCount === 0) return;

    const normalizedOptions: SanitizationOptions = {
      ...options,
      customRedactedHeaders: parseTokenList(customHeadersDraft),
      maskJsonKeys: parseTokenList(maskKeysDraft),
      stripQueryParams: parseTokenList(stripParamsDraft),
      replacementText: effectiveReplacement,
    };
    savePersistedSanitizationOptions(normalizedOptions);

    setIsExporting(true);
    try {
      const saved = await onExport(
        effectiveTargetIds,
        format,
        normalizedOptions
      );
      if (saved) {
        dialogRef.current?.close();
      }
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto w-full max-w-3xl rounded-xl border border-strong bg-surface p-0 text-fg shadow-popover open:flex open:max-h-[90vh] open:flex-col"
    >
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-fg">
              Export Sanitized Sessions (PII &amp; Secrets Redaction)
            </h2>
            <p className="text-[11px] text-muted">
              Очистка токенов, заголовков, ключей JSON/Form, query-параметров и
              метаданных клиента перед передачей архива
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Закрыть окно санитизированного экспорта"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form
        onSubmit={(e) => void handleSubmitExport(e)}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3.5 text-xs">
          {/* Scope & Format Selection */}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5 rounded-lg border border-hairline bg-canvas p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
                Область экспорта
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setScope("all")}
                  disabled={totalCount === 0}
                  className={`flex flex-col items-start rounded-md border px-2.5 py-2 text-left transition-colors ${
                    scope === "all"
                      ? "border-accent bg-selected text-fg"
                      : "border-hairline bg-surface text-muted hover:bg-hover hover:text-fg"
                  } disabled:opacity-45`}
                >
                  <span className="font-semibold text-fg">All Sessions</span>
                  <span className="font-mono text-[10px] text-subtle">
                    {totalCount.toLocaleString()} сессий
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setScope("selected")}
                  disabled={selectedIds.length === 0}
                  className={`flex flex-col items-start rounded-md border px-2.5 py-2 text-left transition-colors ${
                    scope === "selected"
                      ? "border-accent bg-selected text-fg"
                      : "border-hairline bg-surface text-muted hover:bg-hover hover:text-fg"
                  } disabled:opacity-45`}
                >
                  <span className="font-semibold text-fg">Selected Only</span>
                  <span className="font-mono text-[10px] text-subtle">
                    {selectedIds.length > 0
                      ? `${selectedIds.length.toLocaleString()} выбрано`
                      : "Нет выделенных"}
                  </span>
                </button>
              </div>
            </div>

            <div className="space-y-1.5 rounded-lg border border-hairline bg-canvas p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
                Формат файла
              </div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {FORMAT_CARDS.map((card) => {
                  const active = format === card.id;
                  return (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() => setFormat(card.id)}
                      title={card.hint}
                      className={`flex flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors ${
                        active
                          ? "border-accent bg-selected text-fg"
                          : "border-hairline bg-surface text-muted hover:bg-hover hover:text-fg"
                      }`}
                    >
                      <div className="flex items-center gap-1 text-accent">
                        {card.icon}
                        <span className="font-mono text-[10px] font-semibold">
                          {card.ext}
                        </span>
                      </div>
                      <span className="truncate text-[11px] font-medium text-fg">
                        {card.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Presets */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
                Профиль санитизации (Presets)
              </span>
              <span className="font-mono text-[10px] text-muted">
                Настройки сохраняются автоматически
              </span>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              <button
                type="button"
                autoFocus
                onClick={() => handleSelectPreset("safeSharing")}
                className={`flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left transition-colors ${
                  activePreset === "safeSharing"
                    ? "border-accent bg-selected"
                    : "border-hairline bg-canvas hover:bg-hover"
                }`}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-fg">
                    <ShieldCheck className="h-3.5 w-3.5 text-status2xx-fg" />
                    Safe Sharing
                  </span>
                  {activePreset === "safeSharing" && (
                    <Check className="h-3.5 w-3.5 text-accent" />
                  )}
                </div>
                <p className="text-[11px] leading-snug text-muted">
                  {SANITIZATION_PRESETS.safeSharing.subtitle}
                </p>
              </button>

              <button
                type="button"
                onClick={() => handleSelectPreset("strictAnonymization")}
                className={`flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left transition-colors ${
                  activePreset === "strictAnonymization"
                    ? "border-accent bg-selected"
                    : "border-hairline bg-canvas hover:bg-hover"
                }`}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-fg">
                    <ShieldAlert className="h-3.5 w-3.5 text-status4xx-fg" />
                    Strict Anonymization
                  </span>
                  {activePreset === "strictAnonymization" && (
                    <Check className="h-3.5 w-3.5 text-accent" />
                  )}
                </div>
                <p className="text-[11px] leading-snug text-muted">
                  {SANITIZATION_PRESETS.strictAnonymization.subtitle}
                </p>
              </button>

              <button
                type="button"
                onClick={() => handleSelectPreset("custom")}
                className={`flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left transition-colors ${
                  activePreset === "custom"
                    ? "border-accent bg-selected"
                    : "border-hairline bg-canvas hover:bg-hover"
                }`}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-fg">
                    <SlidersHorizontal className="h-3.5 w-3.5 text-accent" />
                    Custom
                  </span>
                  {activePreset === "custom" && (
                    <Check className="h-3.5 w-3.5 text-accent" />
                  )}
                </div>
                <p className="text-[11px] leading-snug text-muted">
                  Гибкая настройка заголовков, ключей JSON/Form, query-параметров
                  и текста замены.
                </p>
              </button>
            </div>
          </div>

          {/* Core Toggles & Replacement String */}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-hairline bg-canvas p-3">
              <input
                type="checkbox"
                checked={options.redactAuthHeaders}
                onChange={(e) =>
                  applyAndPersistOptions({
                    ...options,
                    redactAuthHeaders: e.target.checked,
                  })
                }
                className="checkbox-native mt-0.5"
              />
              <div className="space-y-1">
                <div className="font-semibold text-fg">
                  Редактировать заголовки авторизации и Cookies
                </div>
                <div className="flex flex-wrap gap-1">
                  {BUILTIN_REDACTED_AUTH_HEADERS.map((hdr) => (
                    <code
                      key={hdr}
                      className="rounded border border-hairline bg-surface px-1 py-0.5 font-mono text-[10px] text-muted"
                    >
                      {hdr}
                    </code>
                  ))}
                </div>
              </div>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-hairline bg-canvas p-3">
              <input
                type="checkbox"
                checked={options.anonymizeClientInfo}
                onChange={(e) =>
                  applyAndPersistOptions({
                    ...options,
                    anonymizeClientInfo: e.target.checked,
                  })
                }
                className="checkbox-native mt-0.5"
              />
              <div className="space-y-1">
                <div className="inline-flex items-center gap-1.5 font-semibold text-fg">
                  <UserX className="h-3.5 w-3.5 text-muted" />
                  Анонимизировать данные клиента и процесса
                </div>
                <div className="font-mono text-[10px] text-muted">
                  client_addr → 0.0.0.0:0 • client_ip → 0.0.0.0 • process →
                  redacted-process
                </div>
              </div>
            </label>
          </div>

          {/* Detailed Redaction Lists */}
          <div className="space-y-3 rounded-lg border border-hairline bg-canvas p-3">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label
                  htmlFor="sanitize-custom-headers"
                  className="font-semibold text-fg"
                >
                  Дополнительные заголовки (Custom Redacted Headers)
                </label>
                <span className="font-mono text-[10px] text-subtle">
                  {options.customRedactedHeaders.length} шт.
                </span>
              </div>
              <input
                id="sanitize-custom-headers"
                type="text"
                value={customHeadersDraft}
                onChange={(e) => {
                  const val = e.target.value;
                  setCustomHeadersDraft(val);
                  applyAndPersistOptions({
                    ...options,
                    customRedactedHeaders: parseTokenList(val),
                  });
                }}
                placeholder="X-Forwarded-For, X-Real-IP, X-Device-Token"
                className="w-full rounded border border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label
                  htmlFor="sanitize-json-keys"
                  className="font-semibold text-fg"
                >
                  Ключи JSON и Form-Urlencoded для маскирования
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const next = {
                      ...options,
                      maskJsonKeys: [...DEFAULT_MASK_JSON_KEYS],
                    };
                    setMaskKeysDraft(next.maskJsonKeys.join(", "));
                    applyAndPersistOptions(next);
                  }}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-hover"
                >
                  <RotateCcw className="h-3 w-3" />
                  Сбросить к дефолтам
                </button>
              </div>
              <input
                id="sanitize-json-keys"
                type="text"
                value={maskKeysDraft}
                onChange={(e) => {
                  const val = e.target.value;
                  setMaskKeysDraft(val);
                  applyAndPersistOptions({
                    ...options,
                    maskJsonKeys: parseTokenList(val),
                  });
                }}
                placeholder="password, passwd, secret, token, access_token, cvv, pan..."
                className="w-full rounded border border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
              />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label
                    htmlFor="sanitize-query-params"
                    className="font-semibold text-fg"
                  >
                    Query-параметры URL (Strip Query Params)
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const next = {
                        ...options,
                        stripQueryParams: [...DEFAULT_STRIP_QUERY_PARAMS],
                      };
                      setStripParamsDraft(next.stripQueryParams.join(", "));
                      applyAndPersistOptions(next);
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-hover"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Дефолты
                  </button>
                </div>
                <input
                  id="sanitize-query-params"
                  type="text"
                  value={stripParamsDraft}
                  onChange={(e) => {
                    const val = e.target.value;
                    setStripParamsDraft(val);
                    applyAndPersistOptions({
                      ...options,
                      stripQueryParams: parseTokenList(val),
                    });
                  }}
                  placeholder="token, auth, api_key, key, signature, sig, code"
                  className="w-full rounded border border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
                />
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label
                    htmlFor="sanitize-replacement-text"
                    className="font-semibold text-fg"
                  >
                    Текст замены (Replacement Text)
                  </label>
                  <div className="flex items-center gap-1">
                    {[DEFAULT_SANITIZATION_REPLACEMENT, "***", "<masked>"].map(
                      (presetRep) => (
                        <button
                          key={presetRep}
                          type="button"
                          onClick={() =>
                            applyAndPersistOptions({
                              ...options,
                              replacementText: presetRep,
                            })
                          }
                          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                            options.replacementText === presetRep
                              ? "border-accent bg-selected text-fg"
                              : "border-hairline bg-surface text-muted hover:bg-hover"
                          }`}
                        >
                          {presetRep}
                        </button>
                      )
                    )}
                  </div>
                </div>
                <input
                  id="sanitize-replacement-text"
                  type="text"
                  value={options.replacementText}
                  onChange={(e) =>
                    applyAndPersistOptions({
                      ...options,
                      replacementText: e.target.value,
                    })
                  }
                  placeholder="[REDACTED]"
                  className="w-full rounded border border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Live Sanitization Output Preview */}
          <div className="rounded-lg border border-hairline bg-canvas p-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">
              <EyeOff className="h-3.5 w-3.5 text-accent" />
              <span>Предпросмотр результата санитизации</span>
            </div>
            <div className="space-y-1 rounded border border-hairline bg-surface p-2.5 font-mono text-[11px] leading-relaxed text-muted">
              <div className="truncate text-fg">{previewSample.url}</div>
              <div className="truncate">{previewSample.authHeader}</div>
              <div className="truncate">{previewSample.cookieHeader}</div>
              <div className="truncate text-status2xx-fg">
                JSON: {previewSample.jsonBody}
              </div>
              <div className="truncate">Form: {previewSample.formBody}</div>
              <div className="truncate text-subtle">
                Client: {previewSample.clientMeta}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-hairline bg-canvas/60 px-4 py-2.5">
          <div className="text-[11px] text-muted">
            Будет экспортировано сессий:{" "}
            <strong className="font-semibold text-fg">
              {exportSessionCount.toLocaleString()}
            </strong>{" "}
            в формате{" "}
            <code className="rounded bg-surface px-1 py-0.5 font-mono text-fg">
              .{format === "raw" ? "txt" : format}
            </code>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isExporting}
              onClick={() => dialogRef.current?.close()}
              className="rounded border border-strong bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:bg-hover disabled:opacity-45"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={isExporting || exportSessionCount === 0}
              className="inline-flex items-center gap-1.5 rounded bg-accent px-3.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-45"
            >
              <Download className="h-3.5 w-3.5" />
              <span>
                {isExporting
                  ? "Экспорт..."
                  : "Export Sanitized Archive…"}
              </span>
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
};
