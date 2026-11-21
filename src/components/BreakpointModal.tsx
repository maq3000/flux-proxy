import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  Ban,
  FastForward,
  Flame,
  OctagonPause,
  Play,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { statusReasonPhrase, tryFormatJson } from "../lib/formatters";
import { getMonacoThemeName } from "../lib/monaco";
import { isTauriRuntime, proxyBridge } from "../lib/tauriBridge";
import type {
  BreakpointAction,
  BreakpointConfig,
  BreakpointResolution,
  BreakpointRule,
  BreakpointStage,
  HeaderPair,
  PausedBreakpointItem,
} from "../types/proxy";
export { BreakpointBanner, type BreakpointBannerProps } from "./BreakpointBanner";

// ============================================================================
// Live Breakpoint Monaco Interceptor & `bpu` Rules Modal
// ============================================================================
interface BreakpointInterceptorModalProps {
  open: boolean;
  initialMode: "intercept" | "rules";
  selectedBreakpointId?: string | null;
  pausedItems: PausedBreakpointItem[];
  config: BreakpointConfig;
  resolvedTheme: "dark" | "light";
  onClose: () => void;
  onUpdateConfig: (next: BreakpointConfig) => Promise<BreakpointConfig>;
  onResolve: (resolution: BreakpointResolution) => Promise<boolean>;
  onResumeAll: (action: BreakpointAction) => Promise<void>;
}

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
];

const STATUS_PRESETS = [200, 201, 400, 401, 403, 404, 429, 500, 503];

export const BreakpointInterceptorModal: React.FC<
  BreakpointInterceptorModalProps
> = ({
  open,
  initialMode,
  selectedBreakpointId,
  pausedItems,
  config,
  resolvedTheme,
  onClose,
  onUpdateConfig,
  onResolve,
  onResumeAll,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const monacoTheme = getMonacoThemeName(resolvedTheme);

  const [tab, setTab] = useState<"intercept" | "rules">(initialMode);
  const [activeBpId, setActiveBpId] = useState<string | null>(
    selectedBreakpointId ?? null
  );
  const [editorSubTab, setEditorSubTab] = useState<"body" | "headers">("body");

  // Editable draft fields for the currently inspected parked packet
  const [draftMethod, setDraftMethod] = useState("GET");
  const [draftUrl, setDraftUrl] = useState("");
  const [draftStatus, setDraftStatus] = useState<number>(200);
  const [draftHeaders, setDraftHeaders] = useState<HeaderPair[]>([]);
  const [draftBody, setDraftBody] = useState("");
  const [isBinaryBody, setIsBinaryBody] = useState(false);
  const [bodyModified, setBodyModified] = useState(false);

  // New `bpu` rule form
  const [newRulePattern, setNewRulePattern] = useState("");
  const [newRuleStage, setNewRuleStage] = useState<BreakpointStage>("request");
  const [newRuleMethod, setNewRuleMethod] = useState("ANY");
  const [nowMs, setNowMs] = useState(() => Date.now());

  const activeItem = useMemo(() => {
    if (pausedItems.length === 0) return null;
    if (activeBpId) {
      const found = pausedItems.find((i) => i.breakpointId === activeBpId);
      if (found) return found;
    }
    return pausedItems[0];
  }, [pausedItems, activeBpId]);

  const wasOpenRef = useRef(false);
  const pausedCountRef = useRef(pausedItems.length);
  pausedCountRef.current = pausedItems.length;

  // Open / close native modal `<dialog>` (uses default `closerequest` so outside clicks never drop live breakpoints)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!wasOpenRef.current) {
        setTab(
          initialMode === "intercept" && pausedCountRef.current === 0
            ? "rules"
            : initialMode
        );
      }
      wasOpenRef.current = true;
      if (!dialog.open) {
        dialog.showModal();
      }
    } else {
      wasOpenRef.current = false;
      if (dialog.open) {
        dialog.close();
      }
    }
  }, [open, initialMode]);

  useEffect(() => {
    if (open && selectedBreakpointId) {
      setActiveBpId(selectedBreakpointId);
    }
  }, [open, selectedBreakpointId]);

  // Populate draft editors whenever the active parked item changes
  const loadItemIntoDraft = (item: PausedBreakpointItem) => {
    setDraftMethod(item.method);
    setDraftUrl(item.url);
    setDraftStatus(item.responseStatus ?? 200);
    if (item.stage === "response") {
      setDraftHeaders(
        item.responseHeaders
          .filter((h) => h.name.toLowerCase() !== "content-length")
          .map((h) => ({ ...h }))
      );
      const itemIsBinary = Boolean(
        item.responseBodyBase64 && item.responseBodyText == null
      );
      setIsBinaryBody(itemIsBinary);
      setBodyModified(false);
      if (itemIsBinary) {
        setDraftBody(item.responseBodyBase64);
      } else {
        const rawResp = item.responseBodyText ?? "";
        const pretty = tryFormatJson(rawResp);
        setDraftBody(pretty.valid ? pretty.formatted : rawResp);
      }
    } else {
      setDraftHeaders(
        item.requestHeaders
          .filter((h) => h.name.toLowerCase() !== "content-length")
          .map((h) => ({ ...h }))
      );
      const itemIsBinary = Boolean(
        item.requestBodyBase64 && item.requestBodyText == null
      );
      setIsBinaryBody(itemIsBinary);
      setBodyModified(false);
      if (itemIsBinary) {
        setDraftBody(item.requestBodyBase64);
      } else {
        const rawReq = item.requestBodyText ?? "";
        const pretty = tryFormatJson(rawReq);
        setDraftBody(pretty.valid ? pretty.formatted : rawReq);
      }
    }
  };

  useEffect(() => {
    if (activeItem) {
      loadItemIntoDraft(activeItem);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeItem?.breakpointId]);

  useEffect(() => {
    if (!open || pausedItems.length === 0) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [open, pausedItems.length]);

  const detectedLanguage = useMemo(() => {
    if (isBinaryBody) return "plaintext";
    const ct =
      draftHeaders
        .find((h) => h.name.toLowerCase() === "content-type")
        ?.value.toLowerCase() ?? "";
    const trimmed = draftBody.trim();
    if (
      ct.includes("json") ||
      trimmed.startsWith("{") ||
      trimmed.startsWith("[")
    ) {
      return "json";
    }
    if (ct.includes("xml") || ct.includes("html") || trimmed.startsWith("<")) {
      return "xml";
    }
    return "plaintext";
  }, [draftHeaders, draftBody, isBinaryBody]);

  const handleContinueWithEdits = async () => {
    if (!activeItem) return;
    const cleanHeaders = draftHeaders.filter((h) => h.name.trim().length > 0);

    if (activeItem.stage === "response") {
      await onResolve({
        breakpointId: activeItem.breakpointId,
        action: "continue",
        statusCode: Math.max(100, Math.min(599, Number(draftStatus) || 200)),
        responseHeaders: cleanHeaders,
        ...(isBinaryBody
          ? {
              responseBodyBase64: bodyModified
                ? draftBody.trim()
                : activeItem.responseBodyBase64,
              responseBodyText: null,
            }
          : {
              responseBodyText: draftBody,
            }),
      });
    } else {
      await onResolve({
        breakpointId: activeItem.breakpointId,
        action: "continue",
        method: draftMethod,
        url: draftUrl.trim() || activeItem.url,
        requestHeaders: cleanHeaders,
        ...(isBinaryBody
          ? {
              requestBodyBase64: bodyModified
                ? draftBody.trim()
                : activeItem.requestBodyBase64,
              requestBodyText: null,
            }
          : {
              requestBodyText: draftBody,
            }),
      });
    }

    // Auto-close modal only after verifying the real paused queue is empty
    const remaining = await proxyBridge
      .listPausedBreakpoints()
      .catch(() =>
        pausedItems.filter((i) => i.breakpointId !== activeItem.breakpointId)
      );
    if (remaining.length === 0) {
      dialogRef.current?.close();
    }
  };

  const handleAbortCurrent = async () => {
    if (!activeItem) return;
    await onResolve({
      breakpointId: activeItem.breakpointId,
      action: "abort",
    });
    const remaining = await proxyBridge
      .listPausedBreakpoints()
      .catch(() =>
        pausedItems.filter((i) => i.breakpointId !== activeItem.breakpointId)
      );
    if (remaining.length === 0) {
      dialogRef.current?.close();
    }
  };

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    const pat = newRulePattern.trim();
    if (!pat) return;
    const rule: BreakpointRule = {
      id: `bp-${Date.now()}`,
      enabled: true,
      name: `${newRuleStage === "response" ? "bpafter" : "bpu"} ${pat}`,
      stage: newRuleStage,
      urlPattern: pat,
      methodFilter: newRuleMethod === "ANY" ? null : newRuleMethod,
    };
    await onUpdateConfig({
      ...config,
      rules: [rule, ...config.rules],
    });
    setNewRulePattern("");
  };

  const remainingSec = activeItem
    ? Math.max(
        0,
        activeItem.timeoutSecs -
          Math.floor((nowMs - Date.parse(activeItem.createdAt)) / 1000)
      )
    : 0;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      className="m-auto flex h-[84vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl [&:not([open])]:hidden"
    >
      {/* Top Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-hairline bg-elevated/80 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/40">
            <OctagonPause className="h-4 w-4" />
          </div>
          <div>
            <h2 id={titleId} className="text-sm font-semibold text-fg">
              Интерактивные точки останова — Live Breakpoints
            </h2>
            <p className="text-[11px] text-muted">
              F11 (Before Request) • Alt+F11 (After Response) • Shift+F11 (Снять все) • Команды `bpu` и `bpafter` в Ctrl+K
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-hairline bg-canvas p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setTab("intercept")}
              className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-medium transition-colors ${
                tab === "intercept"
                  ? "bg-selected text-fg"
                  : "text-muted hover:text-fg"
              }`}
            >
              <span>Перехват в реальном времени</span>
              {pausedItems.length > 0 && (
                <span className="rounded-full bg-rose-500 px-1.5 font-mono text-[10px] font-bold text-white">
                  {pausedItems.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setTab("rules")}
              className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-medium transition-colors ${
                tab === "rules"
                  ? "bg-selected text-fg"
                  : "text-muted hover:text-fg"
              }`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span>Правила `bpu` ({config.rules.length})</span>
            </button>
          </div>

          <form method="dialog">
            <button
              type="submit"
              value="close"
              aria-label="Свернуть окно точек останова"
              title="Свернуть редактор (пакет останется на паузе в верхней панели)"
              className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </form>
        </div>
      </div>

      {/* TAB 1: LIVE INTERCEPTOR */}
      {tab === "intercept" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {!activeItem ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-xs text-muted">
              <OctagonPause className="h-8 w-8 text-subtle" />
              <div className="max-w-md space-y-1">
                <p className="text-sm font-semibold text-fg">
                  Сейчас нет пакетов, стоящих на паузе
                </p>
                <p className="text-subtle">
                  Нажмите <kbd className="rounded bg-elevated px-1.5 py-0.5 font-mono">F11</kbd> (Break on Request),{" "}
                  <kbd className="rounded bg-elevated px-1.5 py-0.5 font-mono">Alt+F11</kbd> (Break on Response) или задайте фильтр <code>bpu /api</code> во вкладке правил.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setTab("rules")}
                  className="rounded-md border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/25"
                >
                  Настроить правила `bpu`
                </button>
                {!isTauriRuntime() && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        !config.breakBeforeRequest &&
                        !config.breakAfterResponse &&
                        !config.rules.some((r) => r.enabled)
                      ) {
                        await onUpdateConfig({
                          ...config,
                          breakBeforeRequest: true,
                        });
                      }
                      proxyBridge.triggerSimulatedTrafficHit();
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/25"
                  >
                    <Zap className="h-3.5 w-3.5" />
                    <span>Включить F11 и перехватить демо-запрос</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Queue Strip when multiple requests are parked */}
              {pausedItems.length > 1 && (
                <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-hairline bg-canvas px-4 py-1.5">
                  <span className="font-mono text-[10px] uppercase text-subtle">
                    Очередь ({pausedItems.length}):
                  </span>
                  {pausedItems.map((item) => (
                    <button
                      key={item.breakpointId}
                      type="button"
                      onClick={() => setActiveBpId(item.breakpointId)}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] ${
                        item.breakpointId === activeItem.breakpointId
                          ? "border-sky-500/60 bg-selected text-fg"
                          : "border-hairline bg-surface text-muted hover:text-fg"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          item.stage === "response"
                            ? "bg-violet-400"
                            : "bg-amber-400"
                        }`}
                      />
                      <span>#{item.sessionId}</span>
                      <span className="font-bold">{item.method}</span>
                      <span className="max-w-[140px] truncate">{item.path}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Request Line OR Response Status Bar */}
              <div className="shrink-0 space-y-2 border-b border-hairline bg-surface px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 font-mono">
                    <span
                      className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                        activeItem.stage === "response"
                          ? "bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/40"
                          : "bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40"
                      }`}
                    >
                      {activeItem.stage === "response"
                        ? "AFTER RESPONSE (До возврата в браузер)"
                        : "BEFORE REQUEST (До отправки на апстрим)"}
                    </span>
                    <span className="text-muted">
                      Session <strong className="text-fg">#{activeItem.sessionId}</strong>
                    </span>
                    {activeItem.processName && (
                      <span className="text-violet-300">
                        {activeItem.processName}
                        {activeItem.processPid != null
                          ? `:${activeItem.processPid}`
                          : ""}
                      </span>
                    )}
                  </div>

                  <span className="font-mono text-[11px] text-amber-300 tabular-nums">
                    Таймаут безопасности tokio::oneshot: {remainingSec}с
                  </span>
                </div>

                {activeItem.stage === "request" ? (
                  <div className="flex items-center gap-2">
                    <select
                      value={draftMethod}
                      onChange={(e) => setDraftMethod(e.target.value)}
                      aria-label="HTTP Method"
                      className="h-8 rounded-md border border-strong bg-canvas px-2.5 font-mono text-xs font-bold text-sky-400 focus:border-sky-500 focus:outline-none"
                    >
                      {HTTP_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={draftUrl}
                      onChange={(e) => setDraftUrl(e.target.value)}
                      aria-label="Request URL"
                      className="h-8 flex-1 rounded-md border border-strong bg-canvas px-3 font-mono text-xs text-fg focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="truncate font-mono text-xs text-muted">
                      Запрос: <strong className="text-sky-400">{activeItem.method}</strong>{" "}
                      <span className="text-fg">{activeItem.url}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="font-mono text-xs text-muted">
                        HTTP Status:
                      </label>
                      <input
                        type="number"
                        min={100}
                        max={599}
                        value={draftStatus}
                        onChange={(e) =>
                          setDraftStatus(Number(e.target.value) || 200)
                        }
                        className="h-8 w-24 rounded-md border border-strong bg-canvas px-2.5 font-mono text-xs font-bold text-emerald-400 focus:border-sky-500 focus:outline-none"
                      />
                      <span className="font-mono text-xs text-subtle">
                        {statusReasonPhrase(draftStatus)}
                      </span>

                      <div className="ml-auto flex flex-wrap items-center gap-1">
                        <span className="mr-1 text-[11px] text-subtle">
                          Быстрая подмена кода:
                        </span>
                        {STATUS_PRESETS.map((code) => (
                          <button
                            key={code}
                            type="button"
                            onClick={() => setDraftStatus(code)}
                            className={`rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold ${
                              draftStatus === code
                                ? "border-sky-500 bg-sky-500/20 text-sky-200"
                                : code >= 500
                                  ? "border-rose-500/35 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                                  : code >= 400
                                    ? "border-amber-500/35 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                                    : "border-hairline bg-elevated text-muted hover:text-fg"
                            }`}
                          >
                            {code}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => {
                            setDraftStatus(500);
                            setIsBinaryBody(false);
                            setBodyModified(true);
                            setDraftBody(
                              JSON.stringify(
                                {
                                  error: "internal_server_error",
                                  message:
                                    "Simulated 500 failure injected at FluxProxy Breakpoint",
                                  timestamp: new Date().toISOString(),
                                },
                                null,
                                2
                              )
                            );
                          }}
                          className="ml-1 inline-flex items-center gap-1 rounded border border-rose-500/45 bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold text-rose-200 hover:bg-rose-500/25"
                        >
                          <Flame className="h-3 w-3" />
                          <span>500 + JSON Error</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Sub-bar: Monaco Body vs Editable Headers */}
              <div className="flex h-8 shrink-0 items-center justify-between border-b border-hairline bg-elevated/40 px-4 text-xs">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEditorSubTab("body")}
                    className={`rounded px-2.5 py-0.5 font-medium ${
                      editorSubTab === "body"
                        ? "bg-selected text-fg ring-1 ring-hairline"
                        : "text-muted hover:text-fg"
                    }`}
                  >
                    Payload Body ({isBinaryBody ? "BASE64 / BINARY" : detectedLanguage.toUpperCase()})
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditorSubTab("headers")}
                    className={`rounded px-2.5 py-0.5 font-medium ${
                      editorSubTab === "headers"
                        ? "bg-selected text-fg ring-1 ring-hairline"
                        : "text-muted hover:text-fg"
                    }`}
                  >
                    Headers ({draftHeaders.length})
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {editorSubTab === "body" && !isBinaryBody && (
                    <button
                      type="button"
                      onClick={() => {
                        const res = tryFormatJson(draftBody);
                        if (res.valid) {
                          setDraftBody(res.formatted);
                          setBodyModified(true);
                        }
                      }}
                      className="rounded border border-hairline bg-surface px-2 py-0.5 text-[11px] text-sky-400 hover:bg-hover"
                    >
                      Форматировать JSON
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => loadItemIntoDraft(activeItem)}
                    className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2 py-0.5 text-[11px] text-muted hover:text-fg"
                  >
                    <RotateCcw className="h-3 w-3" />
                    <span>Сбросить правки</span>
                  </button>
                </div>
              </div>

              {/* Editor Workspace */}
              <div className="min-h-0 flex-1 overflow-hidden bg-canvas">
                {editorSubTab === "body" ? (
                  <Editor
                    height="100%"
                    language={detectedLanguage}
                    theme={monacoTheme}
                    value={draftBody}
                    onChange={(val) => {
                      setDraftBody(val ?? "");
                      setBodyModified(true);
                    }}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 12,
                      wordWrap: "on",
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                    }}
                  />
                ) : (
                  <div className="h-full space-y-1.5 overflow-y-auto p-3">
                    {draftHeaders.map((hdr, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={hdr.name}
                          placeholder="Header-Name"
                          onChange={(e) => {
                            const copy = draftHeaders.slice();
                            copy[idx] = { ...copy[idx], name: e.target.value };
                            setDraftHeaders(copy);
                          }}
                          className="h-7 w-56 rounded border border-hairline bg-surface px-2 font-mono text-xs text-sky-400 focus:border-sky-500 focus:outline-none"
                        />
                        <input
                          type="text"
                          value={hdr.value}
                          placeholder="Header value"
                          onChange={(e) => {
                            const copy = draftHeaders.slice();
                            copy[idx] = { ...copy[idx], value: e.target.value };
                            setDraftHeaders(copy);
                          }}
                          className="h-7 flex-1 rounded border border-hairline bg-surface px-2 font-mono text-xs text-fg focus:border-sky-500 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setDraftHeaders(
                              draftHeaders.filter((_, i) => i !== idx)
                            )
                          }
                          className="rounded p-1 text-subtle hover:bg-hover hover:text-rose-400"
                          title="Удалить заголовок"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        setDraftHeaders([
                          ...draftHeaders,
                          { name: "X-Debug-Intercepted", value: "true" },
                        ])
                      }
                      className="mt-2 inline-flex items-center gap-1 rounded border border-hairline bg-elevated px-2.5 py-1 text-xs text-sky-400 hover:bg-hover"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Добавить заголовок</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Footer Verdict Bar */}
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-hairline bg-surface px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleAbortCurrent()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/50 bg-rose-500/15 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/25"
                  >
                    <Ban className="h-3.5 w-3.5" />
                    <span>Abort (Прервать запрос)</span>
                  </button>
                  {pausedItems.length > 1 && (
                    <button
                      type="button"
                      onClick={() => void onResumeAll("continue")}
                      className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-elevated px-3 py-1.5 text-xs text-muted hover:text-fg"
                    >
                      <FastForward className="h-3.5 w-3.5" />
                      <span>Пропустить всю очередь ({pausedItems.length})</span>
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => void handleContinueWithEdits()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/60 bg-emerald-500/25 px-4 py-1.5 text-xs font-semibold text-emerald-200 shadow hover:bg-emerald-500/35"
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>
                    Continue —{" "}
                    {activeItem.stage === "response"
                      ? "Отправить изменённый ответ в клиент"
                      : "Отправить изменённый запрос на сервер"}
                  </span>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB 2: RULES & QUICKEXEC `bpu` / `bpafter` */}
      {tab === "rules" && (
        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-xs select-text">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-hairline bg-canvas p-3 hover:border-amber-500/40">
              <input
                type="checkbox"
                checked={config.breakBeforeRequest}
                onChange={(e) =>
                  void onUpdateConfig({
                    ...config,
                    breakBeforeRequest: e.target.checked,
                  })
                }
                className="checkbox-native mt-0.5"
              />
              <div>
                <div className="font-semibold text-fg">
                  Break on All Requests (F11)
                </div>
                <p className="mt-0.5 text-[11px] text-muted">
                  Глобально перехватывать каждый запрос до отправки на апстрим.
                </p>
              </div>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-hairline bg-canvas p-3 hover:border-violet-500/40">
              <input
                type="checkbox"
                checked={config.breakAfterResponse}
                onChange={(e) =>
                  void onUpdateConfig({
                    ...config,
                    breakAfterResponse: e.target.checked,
                  })
                }
                className="checkbox-native mt-0.5"
              />
              <div>
                <div className="font-semibold text-fg">
                  Break on All Responses (Alt+F11)
                </div>
                <p className="mt-0.5 text-[11px] text-muted">
                  Перехватывать ответы реального сервера для подмены JSON или кода 500.
                </p>
              </div>
            </label>

            <div className="rounded-lg border border-hairline bg-canvas p-3">
              <div className="font-semibold text-fg">
                Таймаут безопасности (сек)
              </div>
              <p className="mt-0.5 text-[11px] text-muted">
                Авто-продолжение oneshot-канала, если вкладка забыта:
              </p>
              <input
                type="number"
                min={5}
                max={600}
                value={config.timeoutSecs}
                onChange={(e) =>
                  void onUpdateConfig({
                    ...config,
                    timeoutSecs: Math.max(
                      5,
                      Math.min(600, Number(e.target.value) || 120)
                    ),
                  })
                }
                className="mt-1.5 h-7 w-28 rounded border border-strong bg-surface px-2 font-mono text-xs text-fg"
              />
            </div>
          </div>

          {/* Add Conditional bpu / bpafter Rule */}
          <form
            onSubmit={(e) => void handleAddRule(e)}
            className="rounded-lg border border-hairline bg-canvas p-3"
          >
            <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-subtle">
              Условные точки останова (аналог Fiddler `bpu &lt;url&gt;` и `bpafter &lt;url&gt;`)
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={newRuleStage}
                onChange={(e) =>
                  setNewRuleStage(e.target.value as BreakpointStage)
                }
                className="h-8 rounded-md border border-strong bg-surface px-2.5 text-xs text-fg"
              >
                <option value="request">Before Request (`bpu`)</option>
                <option value="response">After Response (`bpafter`)</option>
                <option value="both">Обе фазы (Req + Resp)</option>
              </select>

              <select
                value={newRuleMethod}
                onChange={(e) => setNewRuleMethod(e.target.value)}
                className="h-8 rounded-md border border-strong bg-surface px-2 font-mono text-xs text-fg"
              >
                <option value="ANY">ANY Method</option>
                {HTTP_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>

              <input
                type="text"
                value={newRulePattern}
                onChange={(e) => setNewRulePattern(e.target.value)}
                placeholder="Подстрока URL, wildcard (*stripe.com*) или regex:^https://api\."
                className="h-8 min-w-[220px] flex-1 rounded-md border border-strong bg-surface px-3 font-mono text-xs text-fg placeholder:text-subtle"
              />

              <button
                type="submit"
                className="inline-flex h-8 items-center gap-1 rounded-md border border-sky-500/50 bg-sky-500/15 px-3 text-xs font-semibold text-sky-300 hover:bg-sky-500/25"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Добавить правило</span>
              </button>
            </div>
          </form>

          {/* Existing Rules List */}
          <div className="space-y-1.5">
            {config.rules.length === 0 ? (
              <div className="rounded-lg border border-dashed border-hairline p-6 text-center text-subtle">
                Условные правила `bpu` не заданы. Вы также можете нажать{" "}
                <kbd className="rounded bg-elevated px-1.5 py-0.5 font-mono">
                  Ctrl+K
                </kbd>{" "}
                и ввести <code>bpu /v1/payment</code> или <code>bpafter graphql</code>.
              </div>
            ) : (
              config.rules.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-canvas px-3 py-2 font-mono text-xs"
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) =>
                        void onUpdateConfig({
                          ...config,
                          rules: config.rules.map((item) =>
                            item.id === r.id
                              ? { ...item, enabled: e.target.checked }
                              : item
                          ),
                        })
                      }
                      className="checkbox-native"
                    />
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                        r.stage === "response"
                          ? "bg-violet-500/20 text-violet-300"
                          : r.stage === "both"
                            ? "bg-sky-500/20 text-sky-300"
                            : "bg-amber-500/20 text-amber-300"
                      }`}
                    >
                      {r.stage}
                    </span>
                    {r.methodFilter && (
                      <span className="rounded bg-elevated px-1.5 py-0.5 text-[10px] text-sky-400">
                        {r.methodFilter}
                      </span>
                    )}
                    <span className="truncate font-semibold text-fg">
                      {r.urlPattern}
                    </span>
                  </label>

                  <button
                    type="button"
                    onClick={() =>
                      void onUpdateConfig({
                        ...config,
                        rules: config.rules.filter((item) => item.id !== r.id),
                      })
                    }
                    className="rounded p-1 text-subtle hover:bg-hover hover:text-rose-400"
                    title="Удалить правило"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </dialog>
  );
};
