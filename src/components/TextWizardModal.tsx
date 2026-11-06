import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownUp,
  Binary,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  FileArchive,
  KeyRound,
  Link2,
  Sparkles,
  Wand2,
  X,
  XCircle,
} from "lucide-react";
import { proxyBridge } from "../lib/tauriBridge";
import {
  convertTimestampInput,
  createSampleJwtToken,
  decodeBase64Text,
  encodeBase64Text,
  hexToText,
  inspectJwt,
  textToHex,
  urlDecodeText,
  urlEncodeText,
} from "../lib/textWizard";
import type { CodecOperation, CodecTransformResult } from "../types/proxy";

export type TextWizardTab =
  | "jwt"
  | "base64"
  | "url"
  | "compression"
  | "hex"
  | "timestamp";

interface TextWizardModalProps {
  open: boolean;
  initialTab?: TextWizardTab;
  initialInput?: string;
  onClose: () => void;
  onNotify?: (msg: string) => void;
}

const TABS: {
  id: TextWizardTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "jwt", label: "JWT Inspector", icon: KeyRound },
  { id: "base64", label: "Base64", icon: Sparkles },
  { id: "url", label: "URL Codec", icon: Link2 },
  { id: "compression", label: "Gzip / Brotli / Deflate", icon: FileArchive },
  { id: "hex", label: "Hex ↔ Text", icon: Binary },
  { id: "timestamp", label: "Timestamp ↔ ISO", icon: Clock },
];

export const TextWizardModal: React.FC<TextWizardModalProps> = ({
  open,
  initialTab = "jwt",
  initialInput,
  onClose,
  onNotify,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const [activeTab, setActiveTab] = useState<TextWizardTab>(initialTab);
  const [input, setInput] = useState<string>(() => createSampleJwtToken(false));

  // Mode-specific controls
  const [b64Direction, setB64Direction] = useState<"decode" | "encode">("decode");
  const [b64UrlSafe, setB64UrlSafe] = useState(false);

  const [urlDirection, setUrlDirection] = useState<"decode" | "encode">("decode");
  const [urlFullUri, setUrlFullUri] = useState(false);

  const [hexDirection, setHexDirection] = useState<"toHex" | "fromHex">("toHex");
  const [hexSeparator, setHexSeparator] = useState<" " | ":" | "">(" ");

  const [codecOp, setCodecOp] = useState<CodecOperation>("gzipCompress");
  const [codecInputBase64, setCodecInputBase64] = useState(false);
  const [codecResult, setCodecResult] = useState<CodecTransformResult | null>(
    null
  );
  const [codecError, setCodecError] = useState<string | null>(null);
  const [codecBusy, setCodecBusy] = useState(false);

  const [copiedTag, setCopiedTag] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  // Sync open / close with native <dialog>.showModal()
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      setActiveTab(initialTab);
      if (initialInput !== undefined && initialInput.trim()) {
        setInput(initialInput);
      } else if (initialTab === "jwt" && !input.includes(".")) {
        setInput(createSampleJwtToken(false));
      } else if (initialTab === "timestamp" && !input.trim()) {
        setInput(String(Math.floor(Date.now() / 1000)));
      }
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTab, initialInput]);

  // Light-dismiss fallback when `<dialog closedby="any">` is not natively supported
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || "closedBy" in HTMLDialogElement.prototype) return;

    const handleBackdropClick = (event: MouseEvent) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const isDialogContent =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (isDialogContent) return;
      dialog.close();
    };

    dialog.addEventListener("click", handleBackdropClick);
    return () => {
      dialog.removeEventListener("click", handleBackdropClick);
    };
  }, []);

  // Refresh JWT exp & relative timestamps every second while modal is open
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [open]);

  // Execute native Rust / WebStream Gzip, Brotli, Deflate codec when compression tab is active
  useEffect(() => {
    if (!open || activeTab !== "compression") return;
    let active = true;
    const isDecompress =
      codecOp === "gzipDecompress" ||
      codecOp === "brotliDecompress" ||
      codecOp === "deflateDecompress";

    setCodecBusy(true);
    setCodecError(null);

    void proxyBridge
      .codecTransform(codecOp, input, isDecompress ? true : codecInputBase64)
      .then((res) => {
        if (!active) return;
        setCodecResult(res);
        setCodecBusy(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setCodecResult(null);
        setCodecError(err instanceof Error ? err.message : String(err));
        setCodecBusy(false);
      });

    return () => {
      active = false;
    };
  }, [open, activeTab, codecOp, input, codecInputBase64]);

  const copyValue = useCallback(
    async (tag: string, value: string) => {
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setCopiedTag(tag);
        onNotify?.("Скопировано в буфер обмена");
        window.setTimeout(
          () => setCopiedTag((prev) => (prev === tag ? null : prev)),
          1600
        );
      } catch {
        // ignore clipboard denial
      }
    },
    [onNotify]
  );

  // Instant computed transforms
  const jwtResult = useMemo(
    () => (activeTab === "jwt" ? inspectJwt(input, nowTick) : null),
    [activeTab, input, nowTick]
  );

  const b64Output = useMemo(() => {
    if (activeTab !== "base64") return { text: "", error: null as string | null, info: "" };
    if (!input) return { text: "", error: null, info: "0 B" };
    try {
      if (b64Direction === "encode") {
        const out = encodeBase64Text(input, b64UrlSafe);
        return {
          text: out,
          error: null,
          info: `${new TextEncoder().encode(input).length} B → ${out.length} Base64 симв.`,
        };
      }
      const dec = decodeBase64Text(input);
      return {
        text: dec.text,
        error: null,
        info: dec.isUtf8
          ? `Декодировано ${dec.byteLength} байт (UTF-8)`
          : `Бинарные данные (${dec.byteLength} байт) — показан Hex`,
      };
    } catch (err) {
      return {
        text: "",
        error: err instanceof Error ? err.message : "Невалидная строка Base64",
        info: "",
      };
    }
  }, [activeTab, input, b64Direction, b64UrlSafe]);

  const urlOutput = useMemo(() => {
    if (activeTab !== "url") {
      return { text: "", params: [] as { name: string; value: string }[], error: null as string | null };
    }
    if (!input) return { text: "", params: [], error: null };
    try {
      if (urlDirection === "encode") {
        return {
          text: urlEncodeText(input, urlFullUri),
          params: [],
          error: null,
        };
      }
      const dec = urlDecodeText(input);
      return { text: dec.decoded, params: dec.params, error: null };
    } catch (err) {
      return {
        text: "",
        params: [],
        error: err instanceof Error ? err.message : "Ошибка декодирования URI",
      };
    }
  }, [activeTab, input, urlDirection, urlFullUri]);

  const hexOutput = useMemo(() => {
    if (activeTab !== "hex") return { text: "", error: null as string | null, info: "" };
    if (!input) return { text: "", error: null, info: "0 B" };
    try {
      if (hexDirection === "toHex") {
        const bytesLen = new TextEncoder().encode(input).length;
        return {
          text: textToHex(input, hexSeparator),
          error: null,
          info: `${bytesLen} байт UTF-8`,
        };
      }
      const dec = hexToText(input);
      return {
        text: dec.text,
        error: null,
        info: `${dec.byteLength} байт (${dec.isUtf8 ? "валидный UTF-8" : "с заменой непечатных байт"})`,
      };
    } catch (err) {
      return {
        text: "",
        error: err instanceof Error ? err.message : "Ошибка разбора Hex",
        info: "",
      };
    }
  }, [activeTab, input, hexDirection, hexSeparator]);

  const tsResult = useMemo(
    () => (activeTab === "timestamp" ? convertTimestampInput(input, nowTick) : null),
    [activeTab, input, nowTick]
  );

  const handleTabSwitch = (nextTab: TextWizardTab) => {
    setActiveTab(nextTab);
    if (nextTab === "jwt" && !input.includes(".")) {
      setInput(createSampleJwtToken(false));
    } else if (nextTab === "timestamp" && (input.includes(".") && input.length > 40)) {
      setInput(String(Math.floor(Date.now() / 1000)));
    } else if (nextTab === "compression" && input.startsWith("eyJ") && input.includes(".")) {
      setCodecOp("gzipCompress");
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
      className="m-auto w-full max-w-4xl rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:flex-col"
    >
      {/* Modal Header */}
      <div className="flex items-center justify-between border-b border-hairline bg-elevated/70 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/15 text-sky-400 ring-1 ring-sky-500/30">
            <Wand2 className="h-4 w-4" />
          </div>
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-fg">
              TextWizard &amp; JWT Decoder
            </h2>
            <p className="text-[11px] text-muted">
              Мгновенное декодирование JWT (exp/nbf), Base64, URL, Gzip/Brotli/Deflate, Hex и Unix Timestamp
            </p>
          </div>
        </div>

        <form method="dialog">
          <button
            type="submit"
            value="close"
            aria-label="Закрыть TextWizard"
            className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </form>
      </div>

      {/* Mode Selector Bar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-hairline bg-surface px-4 py-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          const selected = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => handleTabSwitch(t.id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                selected
                  ? "bg-selected text-fg ring-1 ring-sky-500/50"
                  : "text-muted hover:bg-hover hover:text-fg"
              }`}
            >
              <Icon className="h-3.5 w-3.5 text-sky-400" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* Body Content */}
      <div className="max-h-[74vh] space-y-3.5 overflow-y-auto p-4 text-xs select-text">
        {/* Source Input Box */}
        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-subtle">
              Входные данные ({input.length.toLocaleString()} симв.)
            </span>

            <div className="flex flex-wrap items-center gap-1.5">
              {activeTab === "jwt" && (
                <>
                  <button
                    type="button"
                    onClick={() => setInput(createSampleJwtToken(false))}
                    className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/20"
                  >
                    Демо: активный JWT
                  </button>
                  <button
                    type="button"
                    onClick={() => setInput(createSampleJwtToken(true))}
                    className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300 hover:bg-rose-500/20"
                  >
                    Демо: истёкший JWT
                  </button>
                </>
              )}
              {activeTab === "timestamp" && (
                <>
                  <button
                    type="button"
                    onClick={() => setInput(String(Math.floor(Date.now() / 1000)))}
                    className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-300 hover:bg-sky-500/20"
                  >
                    Сейчас (Epoch сек)
                  </button>
                  <button
                    type="button"
                    onClick={() => setInput(new Date().toISOString())}
                    className="rounded border border-hairline bg-elevated px-2 py-0.5 text-[11px] text-muted hover:text-fg"
                  >
                    Сейчас (ISO 8601)
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setInput("")}
                className="rounded border border-hairline bg-elevated px-2 py-0.5 text-[11px] text-muted hover:text-fg"
              >
                Очистить
              </button>
            </div>
          </div>

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoFocus
            {...({ autofocus: "" } as Record<string, string>)}
            rows={activeTab === "timestamp" ? 2 : 4}
            placeholder={
              activeTab === "jwt"
                ? "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9... (допускается префикс Bearer)"
                : activeTab === "timestamp"
                  ? "Например: 1793356800, 1793356800123 или 2026-10-30T12:00:00Z"
                  : "Вставьте строку, токен, Base64 или Hex для мгновенного преобразования..."
            }
            className="w-full rounded-lg border border-hairline bg-canvas p-2.5 font-mono text-xs text-fg placeholder:text-subtle focus:border-sky-500/60 focus:outline-none"
          />
        </div>

        {/* 1. JWT INSPECTOR */}
        {activeTab === "jwt" && jwtResult && (
          <div className="space-y-3">
            {/* Status Banner */}
            <div
              className={`flex items-start justify-between gap-3 rounded-lg border p-3 ${
                jwtResult.status === "valid"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                  : jwtResult.status === "expired" || jwtResult.status === "invalid"
                    ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-200"
              }`}
            >
              <div className="flex items-start gap-2.5">
                {jwtResult.status === "valid" ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                ) : jwtResult.status === "expired" || jwtResult.status === "invalid" ? (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                )}
                <div>
                  <div className="font-semibold">{jwtResult.statusHeadline}</div>
                  <div className="mt-0.5 font-mono text-[11px] opacity-90">
                    {jwtResult.statusDetail}
                  </div>
                </div>
              </div>

              {jwtResult.validFormat && (
                <div className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
                  <span className="rounded bg-canvas/70 px-2 py-0.5 font-bold text-sky-300">
                    alg: {jwtResult.algorithm}
                  </span>
                  <span className="rounded bg-canvas/70 px-2 py-0.5 text-muted">
                    typ: {jwtResult.tokenType}
                  </span>
                  {jwtResult.keyId && (
                    <span className="rounded bg-canvas/70 px-2 py-0.5 text-violet-300">
                      kid: {jwtResult.keyId}
                    </span>
                  )}
                </div>
              )}
            </div>

            {jwtResult.warnings.length > 0 && (
              <div className="space-y-1 rounded-lg border border-amber-500/35 bg-amber-500/10 p-2.5 text-[11px] text-amber-200">
                {jwtResult.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            {jwtResult.validFormat && (
              <>
                {jwtResult.annotations.length > 0 && (
                  <div className="rounded-lg border border-hairline bg-canvas p-2.5">
                    <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-subtle">
                      Распознанные стандартные поля (Registered Claims)
                    </div>
                    <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                      {jwtResult.annotations.map((ann) => (
                        <div
                          key={ann.key}
                          className="flex items-start justify-between gap-2 rounded border border-hairline/70 bg-surface px-2.5 py-1.5 font-mono text-[11px]"
                        >
                          <span className="shrink-0 font-semibold text-sky-400">
                            {ann.label}
                          </span>
                          <span
                            className={`text-right break-all ${
                              ann.tone === "ok"
                                ? "text-emerald-400"
                                : ann.tone === "error"
                                  ? "font-semibold text-rose-400"
                                  : ann.tone === "warn"
                                    ? "text-amber-300"
                                    : "text-fg"
                            }`}
                          >
                            {ann.formattedValue}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <OutputCodeBox
                    title="JOSE Header (JSON)"
                    value={jwtResult.headerJson}
                    copied={copiedTag === "jwt-hdr"}
                    onCopy={() => void copyValue("jwt-hdr", jwtResult.headerJson)}
                  />
                  <OutputCodeBox
                    title="JWT Claims Payload (JSON)"
                    value={jwtResult.claimsJson}
                    copied={copiedTag === "jwt-claims"}
                    onCopy={() => void copyValue("jwt-claims", jwtResult.claimsJson)}
                  />
                </div>

                <div className="rounded-lg border border-hairline bg-canvas p-2.5 font-mono text-[11px]">
                  <div className="flex items-center justify-between text-subtle">
                    <span>
                      Signature ({jwtResult.signatureBytes} байт • Base64URL + Hex):
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void copyValue("jwt-sig", jwtResult.signatureHex)
                      }
                      className="text-sky-400 hover:underline"
                    >
                      {copiedTag === "jwt-sig" ? "Скопировано" : "Copy Hex"}
                    </button>
                  </div>
                  <div className="mt-1 truncate text-muted">
                    {jwtResult.signatureHex || "(подпись отсутствует)"}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* 2. BASE64 / BASE64URL */}
        {activeTab === "base64" && (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setB64Direction("decode")}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                    b64Direction === "decode"
                      ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                      : "border-hairline bg-elevated text-muted hover:text-fg"
                  }`}
                >
                  Base64 → UTF-8 Decode
                </button>
                <button
                  type="button"
                  onClick={() => setB64Direction("encode")}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                    b64Direction === "encode"
                      ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                      : "border-hairline bg-elevated text-muted hover:text-fg"
                  }`}
                >
                  UTF-8 → Base64 Encode
                </button>
                {b64Direction === "encode" && (
                  <label className="ml-2 inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={b64UrlSafe}
                      onChange={(e) => setB64UrlSafe(e.target.checked)}
                      className="checkbox-native"
                    />
                    <span>Base64URL (без `=`, `-` и `_`)</span>
                  </label>
                )}
              </div>

              <button
                type="button"
                disabled={!b64Output.text}
                onClick={() => {
                  setInput(b64Output.text);
                  setB64Direction((d) => (d === "encode" ? "decode" : "encode"));
                }}
                className="inline-flex items-center gap-1 rounded border border-hairline bg-elevated px-2.5 py-1 text-xs text-muted hover:text-fg disabled:opacity-40"
              >
                <ArrowDownUp className="h-3.5 w-3.5" />
                <span>Результат → Вход</span>
              </button>
            </div>

            {b64Output.error ? (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-rose-300">
                {b64Output.error}
              </div>
            ) : (
              <OutputCodeBox
                title={`Результат (${b64Output.info})`}
                value={b64Output.text}
                copied={copiedTag === "b64"}
                onCopy={() => void copyValue("b64", b64Output.text)}
              />
            )}
          </div>
        )}

        {/* 3. URL ENCODE / DECODE */}
        {activeTab === "url" && (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setUrlDirection("decode")}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                    urlDirection === "decode"
                      ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                      : "border-hairline bg-elevated text-muted hover:text-fg"
                  }`}
                >
                  URL Decode (%XX → Текст)
                </button>
                <button
                  type="button"
                  onClick={() => setUrlDirection("encode")}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                    urlDirection === "encode"
                      ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                      : "border-hairline bg-elevated text-muted hover:text-fg"
                  }`}
                >
                  URL Encode (Текст → %XX)
                </button>
                {urlDirection === "encode" && (
                  <label className="ml-2 inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={urlFullUri}
                      onChange={(e) => setUrlFullUri(e.target.checked)}
                      className="checkbox-native"
                    />
                    <span>Сохранять разделители полного URL (`encodeURI`)</span>
                  </label>
                )}
              </div>

              <button
                type="button"
                disabled={!urlOutput.text}
                onClick={() => {
                  setInput(urlOutput.text);
                  setUrlDirection((d) => (d === "encode" ? "decode" : "encode"));
                }}
                className="inline-flex items-center gap-1 rounded border border-hairline bg-elevated px-2.5 py-1 text-xs text-muted hover:text-fg disabled:opacity-40"
              >
                <ArrowDownUp className="h-3.5 w-3.5" />
                <span>Результат → Вход</span>
              </button>
            </div>

            {urlOutput.error ? (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-rose-300">
                {urlOutput.error}
              </div>
            ) : (
              <>
                <OutputCodeBox
                  title="Преобразованная строка"
                  value={urlOutput.text}
                  copied={copiedTag === "url"}
                  onCopy={() => void copyValue("url", urlOutput.text)}
                />
                {urlOutput.params.length > 0 && (
                  <div className="rounded-lg border border-hairline bg-canvas p-2.5">
                    <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-subtle">
                      Разобранные Query-параметры ({urlOutput.params.length})
                    </div>
                    <div className="space-y-1 font-mono text-[11px]">
                      {urlOutput.params.map((p, idx) => (
                        <div
                          key={`${p.name}-${idx}`}
                          className="flex gap-3 border-b border-hairline/50 py-1 last:border-none"
                        >
                          <span className="w-40 shrink-0 font-semibold text-sky-400">
                            {p.name}
                          </span>
                          <span className="break-all text-fg">{p.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* 4. COMPRESSION: GZIP / BROTLI / DEFLATE */}
        {activeTab === "compression" && (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1">
                {(
                  [
                    { id: "gzipCompress", label: "Gzip Compress" },
                    { id: "gzipDecompress", label: "Gzip Decompress" },
                    { id: "brotliCompress", label: "Brotli Compress" },
                    { id: "brotliDecompress", label: "Brotli Decompress" },
                    { id: "deflateCompress", label: "Deflate Compress" },
                    { id: "deflateDecompress", label: "Deflate Decompress" },
                  ] as { id: CodecOperation; label: string }[]
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setCodecOp(item.id)}
                    className={`rounded-md border px-2 py-1 text-[11px] font-medium ${
                      codecOp === item.id
                        ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                        : "border-hairline bg-elevated text-muted hover:text-fg"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {(codecOp === "gzipCompress" ||
                codecOp === "brotliCompress" ||
                codecOp === "deflateCompress") && (
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={codecInputBase64}
                    onChange={(e) => setCodecInputBase64(e.target.checked)}
                    className="checkbox-native"
                  />
                  <span>Вход уже в Base64 / Hex</span>
                </label>
              )}
            </div>

            {codecBusy && (
              <div className="text-[11px] text-muted">Выполняется преобразование...</div>
            )}

            {codecError && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-rose-300">
                {codecError}
              </div>
            )}

            {codecResult && !codecError && (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-canvas px-3 py-2 font-mono text-[11px]">
                  <span className="text-fg">
                    Размер:{" "}
                    <strong className="text-sky-400">
                      {codecResult.inputBytes} B
                    </strong>{" "}
                    →{" "}
                    <strong className="text-emerald-400">
                      {codecResult.outputBytes} B
                    </strong>{" "}
                    {codecResult.inputBytes > 0 && (
                      <span className="text-muted">
                        (
                        {Math.round(
                          (codecResult.outputBytes / codecResult.inputBytes) * 100
                        )}
                        %)
                      </span>
                    )}
                  </span>

                  <button
                    type="button"
                    onClick={() => {
                      if (codecOp.endsWith("Compress")) {
                        setInput(codecResult.outputBase64);
                        setCodecOp(
                          codecOp === "gzipCompress"
                            ? "gzipDecompress"
                            : codecOp === "brotliCompress"
                              ? "brotliDecompress"
                              : "deflateDecompress"
                        );
                      } else if (codecResult.outputText !== null && codecResult.outputText !== undefined) {
                        setInput(codecResult.outputText);
                        setCodecInputBase64(false);
                        setCodecOp(
                          codecOp === "gzipDecompress"
                            ? "gzipCompress"
                            : codecOp === "brotliDecompress"
                              ? "brotliCompress"
                              : "deflateCompress"
                        );
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded border border-hairline bg-elevated px-2 py-0.5 text-[11px] text-sky-300 hover:bg-hover"
                  >
                    <ArrowDownUp className="h-3 w-3" />
                    <span>
                      {codecOp.endsWith("Compress")
                        ? "Проверить распаковку (Base64 → Вход)"
                        : "Сжать обратно (Текст → Вход)"}
                    </span>
                  </button>
                </div>

                {codecResult.outputText !== null &&
                  codecResult.outputText !== undefined &&
                  codecOp.endsWith("Decompress") && (
                    <OutputCodeBox
                      title="Распакованный UTF-8 текст"
                      value={codecResult.outputText}
                      copied={copiedTag === "codec-txt"}
                      onCopy={() =>
                        void copyValue("codec-txt", codecResult.outputText ?? "")
                      }
                    />
                  )}

                <OutputCodeBox
                  title="Base64 представление потока"
                  value={codecResult.outputBase64}
                  copied={copiedTag === "codec-b64"}
                  onCopy={() =>
                    void copyValue("codec-b64", codecResult.outputBase64)
                  }
                />

                <OutputCodeBox
                  title="Hex дамп"
                  value={codecResult.outputHex}
                  copied={copiedTag === "codec-hex"}
                  onCopy={() =>
                    void copyValue("codec-hex", codecResult.outputHex)
                  }
                />
              </div>
            )}
          </div>
        )}

        {/* 5. HEX <-> TEXT */}
        {activeTab === "hex" && (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setHexDirection("toHex")}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                    hexDirection === "toHex"
                      ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                      : "border-hairline bg-elevated text-muted hover:text-fg"
                  }`}
                >
                  UTF-8 Text → Hex
                </button>
                <button
                  type="button"
                  onClick={() => setHexDirection("fromHex")}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                    hexDirection === "fromHex"
                      ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                      : "border-hairline bg-elevated text-muted hover:text-fg"
                  }`}
                >
                  Hex → UTF-8 Text
                </button>

                {hexDirection === "toHex" && (
                  <div className="ml-2 flex items-center gap-1 text-[11px] text-muted">
                    <span>Разделитель:</span>
                    {(
                      [
                        { v: " ", l: "Пробел" },
                        { v: ":", l: "Двоеточие" },
                        { v: "", l: "Слитно" },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.l}
                        type="button"
                        onClick={() => setHexSeparator(opt.v)}
                        className={`rounded px-1.5 py-0.5 ${
                          hexSeparator === opt.v
                            ? "bg-selected text-sky-300"
                            : "bg-elevated text-muted"
                        }`}
                      >
                        {opt.l}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                type="button"
                disabled={!hexOutput.text}
                onClick={() => {
                  setInput(hexOutput.text);
                  setHexDirection((d) => (d === "toHex" ? "fromHex" : "toHex"));
                }}
                className="inline-flex items-center gap-1 rounded border border-hairline bg-elevated px-2.5 py-1 text-xs text-muted hover:text-fg disabled:opacity-40"
              >
                <ArrowDownUp className="h-3.5 w-3.5" />
                <span>Результат → Вход</span>
              </button>
            </div>

            {hexOutput.error ? (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-rose-300">
                {hexOutput.error}
              </div>
            ) : (
              <OutputCodeBox
                title={`Результат (${hexOutput.info})`}
                value={hexOutput.text}
                copied={copiedTag === "hex"}
                onCopy={() => void copyValue("hex", hexOutput.text)}
              />
            )}
          </div>
        )}

        {/* 6. UNIX TIMESTAMP <-> ISO 8601 */}
        {activeTab === "timestamp" && tsResult && (
          <div>
            {!tsResult.valid ? (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-rose-300">
                {tsResult.error}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {[
                  {
                    id: "ts-unit",
                    label: "Распознанный формат",
                    val: `${tsResult.detectedUnit} • ${tsResult.relativeNow}`,
                  },
                  {
                    id: "ts-sec",
                    label: "Unix Timestamp (Seconds)",
                    val: String(tsResult.epochSeconds),
                  },
                  {
                    id: "ts-ms",
                    label: "Unix Timestamp (Milliseconds)",
                    val: String(tsResult.epochMillis),
                  },
                  {
                    id: "ts-utc",
                    label: "ISO 8601 (UTC / Z)",
                    val: tsResult.isoUtc,
                  },
                  {
                    id: "ts-local",
                    label: "ISO 8601 (Локальный часовой пояс ОС)",
                    val: tsResult.isoLocal,
                  },
                  {
                    id: "ts-http",
                    label: "HTTP-Date (RFC 9110 GMT)",
                    val: tsResult.httpRfc2822,
                  },
                ].map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-canvas px-3 py-2 font-mono text-xs"
                  >
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase text-subtle">
                        {row.label}
                      </div>
                      <div className="mt-0.5 truncate font-semibold text-fg">
                        {row.val}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyValue(row.id, row.val)}
                      className="shrink-0 rounded border border-hairline bg-surface p-1.5 text-muted hover:text-sky-400"
                      title="Скопировать значение"
                    >
                      {copiedTag === row.id ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </dialog>
  );
};

const OutputCodeBox: React.FC<{
  title: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}> = ({ title, value, copied, onCopy }) => (
  <div className="rounded-lg border border-hairline bg-canvas p-2.5">
    <div className="mb-1.5 flex items-center justify-between">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-subtle">
        {title}
      </span>
      <button
        type="button"
        onClick={onCopy}
        disabled={!value}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-sky-400 hover:bg-hover disabled:opacity-40"
      >
        {copied ? (
          <>
            <Check className="h-3 w-3 text-emerald-400" />
            <span>Copied</span>
          </>
        ) : (
          <>
            <Copy className="h-3 w-3" />
            <span>Copy</span>
          </>
        )}
      </button>
    </div>
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-fg">
      {value || "—"}
    </pre>
  </div>
);
