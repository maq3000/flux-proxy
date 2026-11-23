import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Loader2,
  Plus,
  Send,
  Terminal,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import {
  isCurlCommand,
  parseCurlCommand,
  type ParsedCurlResult,
} from "../lib/curlParser";
import { formatBytes, formatDuration, tryFormatJson } from "../lib/formatters";
import { getMonacoThemeName } from "../lib/monaco";
import { proxyBridge } from "../lib/tauriBridge";
import type {
  ComposedRequest,
  HeaderPair,
  SessionDetail,
} from "../types/proxy";

interface ComposerPanelProps {
  draftRequest: ComposedRequest | null;
  resolvedTheme: "dark" | "light";
  defaultComposerTimeoutSec?: number;
  onLoadSessionIntoComposer: (sessionId: number) => void;
  onSessionCreated: (detail: SessionDetail) => void;
  onGenerateCode?: (request: ComposedRequest) => void;
  onNotify?: (msg: string) => void;
}

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

export const ComposerPanel: React.FC<ComposerPanelProps> = ({
  draftRequest,
  resolvedTheme,
  defaultComposerTimeoutSec = 120,
  onLoadSessionIntoComposer,
  onSessionCreated,
  onGenerateCode,
  onNotify,
}) => {
  const curlDialogRef = useRef<HTMLDialogElement>(null);
  const curlTextareaRef = useRef<HTMLTextAreaElement>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const curlTitleId = useId();
  const runScriptsId = useId();
  const timeoutSelectId = useId();

  const [method, setMethod] = useState("POST");
  const [url, setUrl] = useState("https://auth.internal.corp/oauth2/token");
  const [headers, setHeaders] = useState<HeaderPair[]>([
    { name: "Content-Type", value: "application/json" },
    { name: "Accept", value: "application/json" },
    { name: "X-Client", value: "FluxProxy-Composer/1.0" },
  ]);
  const [body, setBody] = useState(
    JSON.stringify(
      {
        grant_type: "client_credentials",
        scope: "api:read api:write",
      },
      null,
      2
    )
  );
  const [followRedirects, setFollowRedirects] = useState(true);
  const [runPythonScripts, setRunPythonScripts] = useState(true);
  const [timeoutOption, setTimeoutOption] = useState<
    "default" | "0" | "30" | "60" | "120" | "300" | "custom"
  >("default");
  const [customTimeoutInput, setCustomTimeoutInput] = useState("120");
  const [activeTab, setActiveTab] = useState<"headers" | "body">("body");
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastResponse, setLastResponse] = useState<SessionDetail | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const [curlModalOpen, setCurlModalOpen] = useState(false);
  const [curlInput, setCurlInput] = useState("");

  const methodOptions = useMemo(
    () => (HTTP_METHODS.includes(method) ? HTTP_METHODS : [...HTTP_METHODS, method]),
    [method]
  );

  const parsedCurlPreview = useMemo(
    () => (curlInput.trim().length > 0 ? parseCurlCommand(curlInput) : null),
    [curlInput]
  );

  useEffect(() => {
    const dialog = curlDialogRef.current;
    if (!dialog) return;

    if (curlModalOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
      window.requestAnimationFrame(() => {
        curlTextareaRef.current?.focus();
      });
    } else if (dialog.open) {
      dialog.close();
    }
  }, [curlModalOpen]);

  // Light-dismiss pointer-bounds fallback when `<dialog closedby="any">` is not natively supported
  useEffect(() => {
    const dialog = curlDialogRef.current;
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
      if (pressedOutside && isOutside(e)) {
        dialog.close();
      }
    };

    dialog.addEventListener("pointerdown", onDown);
    dialog.addEventListener("pointerup", onUp);
    return () => {
      dialog.removeEventListener("pointerdown", onDown);
      dialog.removeEventListener("pointerup", onUp);
    };
  }, []);

  useEffect(() => {
    if (!draftRequest) return;
    setMethod(draftRequest.method);
    setUrl(draftRequest.url);
    setHeaders(
      draftRequest.headers.length > 0
        ? draftRequest.headers
        : [{ name: "Accept", value: "*/*" }]
    );
    setBody(draftRequest.body);
    setFollowRedirects(draftRequest.followRedirects);
    setRunPythonScripts(!draftRequest.skipPythonScripts);
    setErrorMessage(null);
  }, [draftRequest]);

  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-fluxproxy-session-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setIsDragOver(true);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const idStr = e.dataTransfer.getData("application/x-fluxproxy-session-id");
    const parsed = Number(idStr);
    if (!Number.isNaN(parsed) && parsed > 0) {
      onLoadSessionIntoComposer(parsed);
    }
  };

  const applyParsedCurlResult = (
    parsed: ParsedCurlResult,
    sourceHint?: string
  ) => {
    setMethod(parsed.request.method);
    setUrl(parsed.request.url);
    setHeaders(parsed.request.headers);
    setBody(parsed.request.body);
    setFollowRedirects(parsed.request.followRedirects);
    setErrorMessage(null);

    if (parsed.request.body.trim().length > 0) {
      setActiveTab("body");
    } else if (parsed.request.headers.length > 0) {
      setActiveTab("headers");
    }

    const warnNote =
      parsed.warnings.length > 0
        ? ` (предупреждений: ${parsed.warnings.length})`
        : "";
    onNotify?.(
      `Импортирован cURL${sourceHint ? ` (${sourceHint})` : ""}: ${parsed.request.method} ${parsed.request.url} • заголовков: ${parsed.request.headers.length}${warnNote}`
    );
  };

  const handleUrlPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!isCurlCommand(pasted)) return;

    e.preventDefault();
    const outcome = parseCurlCommand(pasted);
    if (!outcome.ok) {
      setErrorMessage(`Не удалось разобрать cURL: ${outcome.error}`);
      return;
    }
    applyParsedCurlResult(outcome.result, "вставка в URL");
  };

  const handleImportCurlSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const outcome = parseCurlCommand(curlInput);
    if (!outcome.ok) return;
    applyParsedCurlResult(outcome.result);
    setCurlModalOpen(false);
    setCurlInput("");
  };

  const handleGenerateCodeClick = () => {
    if (!url.trim() || !onGenerateCode) return;
    onGenerateCode({
      method,
      url: url.trim(),
      headers: headers.filter((h) => h.name.trim().length > 0),
      body,
      followRedirects,
    });
  };

  const handleExecute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || sending) return;

    let resolvedTimeoutSec: number | undefined;
    if (timeoutOption === "custom") {
      const clean = customTimeoutInput.trim();
      const parsed = /^\d+$/.test(clean) ? Number(clean) : NaN;
      if (
        !Number.isInteger(parsed) ||
        (parsed !== 0 && (parsed < 1 || parsed > 3600))
      ) {
        setErrorMessage(
          "Укажите корректный Composer Timeout: 0 (Unlimited) или от 1 до 3600 секунд."
        );
        return;
      }
      resolvedTimeoutSec = parsed;
    } else if (timeoutOption !== "default") {
      resolvedTimeoutSec = Number(timeoutOption);
    }

    const requestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestIdRef.current = requestId;
    setSending(true);
    setCancelling(false);
    setErrorMessage(null);
    try {
      const detail = await proxyBridge.executeComposedRequest({
        method,
        url: url.trim(),
        headers: headers.filter((h) => h.name.trim().length > 0),
        body,
        followRedirects,
        skipPythonScripts: !runPythonScripts,
        requestId,
        timeoutSec: resolvedTimeoutSec,
      });
      setLastResponse(detail);
      onSessionCreated(detail);
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : String(err ?? "Не удалось выполнить запрос")
      );
    } finally {
      activeRequestIdRef.current = null;
      setSending(false);
      setCancelling(false);
    }
  };

  const handleCancel = async () => {
    const reqId = activeRequestIdRef.current;
    if (!reqId || !sending || cancelling) return;
    setCancelling(true);
    try {
      await proxyBridge.cancelComposedRequest(reqId);
    } catch {
      // request may have finished concurrently
    }
  };

  const monacoTheme = getMonacoThemeName(resolvedTheme);

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      className={`pane-contain relative flex h-full flex-col bg-surface transition-colors ${
        isDragOver ? "ring-2 ring-inset ring-sky-400 bg-sky-500/5" : ""
      }`}
    >
      {/* Drag-and-Drop Overlay Hint */}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-sky-400 bg-canvas/90 backdrop-blur-sm">
          <UploadCloud className="mb-2 h-8 w-8 text-sky-400" />
          <p className="text-sm font-semibold text-fg">
            Drop Session to Clone into Composer
          </p>
          <p className="text-xs text-muted">
            Populates method, URL, headers, and decrypted payload
          </p>
        </div>
      )}

      {/* Composer Header */}
      <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-hairline bg-elevated/60 px-3 py-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold text-fg">
            Request Composer
          </span>
          <span className="hidden rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-400 sm:inline">
            Drag & Drop enabled
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setCurlModalOpen(true)}
            title="Вставить или импортировать команду cURL (Bash / Windows cmd / PowerShell)"
            className="inline-flex h-6 items-center gap-1 rounded border border-hairline bg-surface px-2 text-[11px] font-medium text-fg transition-colors hover:border-strong hover:bg-hover"
          >
            <Terminal className="h-3 w-3 text-sky-400" aria-hidden="true" />
            <span>Import cURL</span>
          </button>

          {onGenerateCode && (
            <button
              type="button"
              disabled={!url.trim()}
              onClick={handleGenerateCodeClick}
              title="Сгенерировать клиентский код для текущего запроса (JS / Python / Go / Rust / cURL)"
              className="inline-flex h-6 items-center gap-1 rounded border border-hairline bg-surface px-2 text-[11px] font-medium text-fg transition-colors hover:border-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Code2 className="h-3 w-3 text-accent" aria-hidden="true" />
              <span>Generate Client Code…</span>
            </button>
          )}

          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={followRedirects}
              onChange={(e) => setFollowRedirects(e.target.checked)}
              className="rounded accent-sky-500"
            />
            <span>Follow redirects</span>
          </label>

          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <input
              id={runScriptsId}
              type="checkbox"
              checked={runPythonScripts}
              onChange={(e) => setRunPythonScripts(e.target.checked)}
              className="rounded accent-sky-500"
            />
            <label htmlFor={runScriptsId} className="cursor-pointer select-none">
              Run Python Scripts
            </label>
          </span>

          <div className="inline-flex items-center gap-1 text-xs text-muted">
            <label htmlFor={timeoutSelectId} className="select-none">
              Timeout:
            </label>
            <select
              id={timeoutSelectId}
              value={timeoutOption}
              disabled={sending}
              onChange={(e) =>
                setTimeoutOption(
                  e.target.value as
                    | "default"
                    | "0"
                    | "30"
                    | "60"
                    | "120"
                    | "300"
                    | "custom"
                )
              }
              aria-label="Composer request timeout"
              className="h-6 rounded border border-hairline bg-surface px-1.5 font-mono text-[11px] text-fg focus:border-sky-500 focus:outline-none disabled:opacity-50"
            >
              <option value="default">
                {defaultComposerTimeoutSec === 0
                  ? "Default (Unlimited)"
                  : `Default (${defaultComposerTimeoutSec}s)`}
              </option>
              <option value="0">Unlimited</option>
              <option value="30">30 s</option>
              <option value="60">60 s</option>
              <option value="120">120 s</option>
              <option value="300">300 s</option>
              <option value="custom">Custom…</option>
            </select>
            {timeoutOption === "custom" && (
              <input
                type="text"
                inputMode="numeric"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={sending}
                value={customTimeoutInput}
                onChange={(e) => setCustomTimeoutInput(e.target.value)}
                aria-label="Custom Composer timeout in seconds"
                placeholder="sec (0=∞)"
                className="h-6 w-16 rounded border border-strong bg-surface px-1.5 font-mono text-[11px] text-fg tabular-nums focus:border-sky-500 focus:outline-none"
              />
            )}
          </div>
        </div>
      </div>

      {/* URL & Method Bar */}
      <form
        onSubmit={handleExecute}
        className="flex shrink-0 items-center gap-2 border-b border-hairline p-2.5"
      >
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          aria-label="HTTP Method"
          className="h-8 rounded-md border border-strong bg-canvas px-2 font-mono text-xs font-bold text-sky-400 focus:border-sky-500 focus:outline-none"
        >
          {methodOptions.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={handleUrlPaste}
          placeholder="https://api.example.com/v1/resource (или вставьте curl ...)"
          aria-label="Target Request URL"
          className="h-8 flex-1 rounded-md border border-strong bg-canvas px-2.5 font-mono text-xs text-fg focus:border-sky-500 focus:outline-none"
        />

        <button
          type="submit"
          disabled={sending}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-sky-600 px-3.5 text-xs font-semibold text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
        >
          {sending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          <span>Execute</span>
        </button>

        {sending && (
          <button
            type="button"
            disabled={cancelling}
            onClick={() => void handleCancel()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-status5xx-fg/50 bg-status5xx-bg px-3 text-xs font-semibold text-status5xx-fg transition-colors hover:brightness-110 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{cancelling ? "Cancelling…" : "Cancel"}</span>
          </button>
        )}
      </form>

      {errorMessage && (
        <div
          role="alert"
          className="flex shrink-0 items-start justify-between gap-2 border-b border-status5xx-fg/35 bg-status5xx-bg px-3 py-2 text-xs text-status5xx-fg"
        >
          <div className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="break-words font-mono text-[11px] select-text">
              {errorMessage}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            aria-label="Скрыть ошибку"
            className="shrink-0 rounded p-0.5 hover:bg-surface/40"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Request Builder Tabs */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-hairline px-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setActiveTab("headers")}
            className={`rounded px-2.5 py-0.5 text-xs font-medium ${
              activeTab === "headers"
                ? "bg-elevated text-fg ring-1 ring-hairline"
                : "text-muted hover:text-fg"
            }`}
          >
            Headers ({headers.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("body")}
            className={`rounded px-2.5 py-0.5 text-xs font-medium ${
              activeTab === "body"
                ? "bg-elevated text-fg ring-1 ring-hairline"
                : "text-muted hover:text-fg"
            }`}
          >
            Payload Body
          </button>
        </div>

        {activeTab === "body" && (
          <button
            type="button"
            onClick={() => {
              const res = tryFormatJson(body);
              if (res.valid) setBody(res.formatted);
            }}
            className="text-[11px] text-sky-400 hover:underline"
          >
            Prettify JSON
          </button>
        )}
      </div>

      {/* Editable Request Content */}
      <div className="flex-1 overflow-hidden bg-canvas">
        {activeTab === "headers" ? (
          <div className="h-full overflow-auto p-3">
            <div className="space-y-1.5">
              {headers.map((h, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={h.name}
                    placeholder="Header-Name"
                    onChange={(e) => {
                      const next = headers.slice();
                      next[i] = { ...next[i], name: e.target.value };
                      setHeaders(next);
                    }}
                    className="h-7 w-44 rounded border border-hairline bg-surface px-2 font-mono text-xs text-sky-400 focus:border-sky-500 focus:outline-none"
                  />
                  <input
                    type="text"
                    value={h.value}
                    placeholder="Value"
                    onChange={(e) => {
                      const next = headers.slice();
                      next[i] = { ...next[i], value: e.target.value };
                      setHeaders(next);
                    }}
                    className="h-7 flex-1 rounded border border-hairline bg-surface px-2 font-mono text-xs text-fg focus:border-sky-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setHeaders(headers.filter((_, idx) => idx !== i))
                    }
                    className="rounded p-1 text-subtle hover:text-rose-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                setHeaders([...headers, { name: "", value: "" }])
              }
              className="mt-2.5 inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2.5 py-1 text-xs text-muted hover:text-fg"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Header</span>
            </button>
          </div>
        ) : (
          <Editor
            height="100%"
            language="json"
            theme={monacoTheme}
            value={body}
            onChange={(v) => setBody(v ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              wordWrap: "on",
              scrollBeyondLastLine: false,
            }}
          />
        )}
      </div>

      {/* Inline Latest Response Snapshot */}
      {lastResponse && (
        <div className="flex h-52 shrink-0 flex-col border-t border-strong bg-surface">
          <div className="flex h-7 items-center justify-between border-b border-hairline px-3 font-mono text-xs">
            <div className="flex items-center gap-2">
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                  lastResponse.summary.status >= 400
                    ? "bg-rose-500/20 text-rose-400"
                    : "bg-emerald-500/20 text-emerald-400"
                }`}
              >
                {lastResponse.summary.status}
              </span>
              {lastResponse.summary.isMocked && (
                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                  AUTORESPONDER MOCK
                </span>
              )}
              <span className="text-muted">
                Session #{lastResponse.summary.id}
              </span>
            </div>
            <span className="text-[11px] text-muted tabular-nums">
              {formatBytes(lastResponse.summary.bodySize)} •{" "}
              {formatDuration(lastResponse.summary.durationMs)}
            </span>
          </div>
          <div className="flex-1 overflow-hidden">
            <Editor
              height="100%"
              language="json"
              theme={monacoTheme}
              value={
                tryFormatJson(lastResponse.responseBodyText).formatted ||
                lastResponse.responseBodyText ||
                ""
              }
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 11,
                wordWrap: "on",
                scrollBeyondLastLine: false,
              }}
            />
          </div>
        </div>
      )}

      {/* Import cURL Dialog */}
      <dialog
        ref={curlDialogRef}
        aria-labelledby={curlTitleId}
        onClose={() => {
          if (curlDialogRef.current) {
            curlDialogRef.current.returnValue = "";
          }
          setCurlModalOpen(false);
        }}
        {...({ closedby: "any" } as Record<string, string>)}
        className="m-auto w-[92vw] max-w-2xl overflow-hidden rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:flex-col"
      >
        <div className="flex items-center justify-between border-b border-hairline bg-elevated/70 px-4 py-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-sky-400" aria-hidden="true" />
            <h2 id={curlTitleId} className="text-sm font-semibold text-fg">
              Import cURL Command
            </h2>
          </div>
          <button
            type="button"
            onClick={() => curlDialogRef.current?.close()}
            aria-label="Закрыть импорт cURL"
            className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleImportCurlSubmit} className="space-y-3 p-4 text-xs">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor={`${curlTitleId}-input`}
                className="text-[11px] font-semibold uppercase tracking-wider text-subtle"
              >
                Команда cURL (Bash, Windows cmd ^, ANSI-C $&apos;...&apos;)
              </label>
              <span className="text-[11px] text-muted">
                Ctrl+Enter — импортировать
              </span>
            </div>
            <textarea
              ref={curlTextareaRef}
              id={`${curlTitleId}-input`}
              value={curlInput}
              onChange={(e) => setCurlInput(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleImportCurlSubmit();
                }
              }}
              rows={8}
              autoFocus
              {...({ autofocus: "" } as Record<string, string>)}
              placeholder={`curl -X POST 'https://api.example.com/v1/items' \\\n  -H 'Authorization: Bearer token' \\\n  --json '{"name":"demo"}'`}
              className="w-full resize-y rounded-lg border border-strong bg-canvas p-3 font-mono text-xs text-fg placeholder:text-subtle focus:border-sky-500 focus:outline-none"
            />
          </div>

          {parsedCurlPreview && parsedCurlPreview.ok && (
            <div className="space-y-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5">
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <CheckCircle2
                  className="h-3.5 w-3.5 shrink-0 text-emerald-400"
                  aria-hidden="true"
                />
                <span className="rounded bg-sky-500/20 px-1.5 py-0.5 font-bold text-sky-300">
                  {parsedCurlPreview.result.request.method}
                </span>
                <span
                  className="truncate text-fg"
                  title={parsedCurlPreview.result.request.url}
                >
                  {parsedCurlPreview.result.request.url}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3 pl-5 font-mono text-[11px] text-muted">
                <span>
                  Headers: {parsedCurlPreview.result.request.headers.length}
                </span>
                <span>
                  Body:{" "}
                  {formatBytes(
                    new TextEncoder().encode(
                      parsedCurlPreview.result.request.body
                    ).length
                  )}
                </span>
              </div>
              {parsedCurlPreview.result.warnings.length > 0 && (
                <ul className="space-y-0.5 pl-5 text-[11px] text-amber-300">
                  {parsedCurlPreview.result.warnings.map((w, idx) => (
                    <li key={idx}>• {w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {parsedCurlPreview && !parsedCurlPreview.ok && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-status5xx-fg/35 bg-status5xx-bg p-2.5 text-[11px] text-status5xx-fg"
            >
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              />
              <span>{parsedCurlPreview.error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-hairline pt-3">
            <button
              type="button"
              onClick={() => curlDialogRef.current?.close()}
              className="rounded border border-strong bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:bg-hover"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!parsedCurlPreview || !parsedCurlPreview.ok}
              className="inline-flex items-center gap-1.5 rounded bg-sky-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Import into Composer</span>
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
};
