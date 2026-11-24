import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileJson,
  Loader2,
  ShieldCheck,
  WrapText,
  X,
} from "lucide-react";
import { formatBytes } from "../lib/formatters";
import { getMonacoThemeName } from "../lib/monaco";
import {
  buildOpenApiDocument,
  type OpenApiFormat,
} from "../lib/openApiGenerator";
import { proxyBridge, type FileDialogFilter } from "../lib/tauriBridge";
import type { SessionDetail } from "../types/proxy";
import { SectionHeader } from "./ui/SectionHeader";

interface OpenApiExportModalProps {
  open: boolean;
  selectedIds: number[];
  allSessionIds: number[];
  resolvedTheme: "dark" | "light";
  onClose: () => void;
  onNotify?: (message: string) => void;
}

const MAX_OPENAPI_SESSIONS = 500;
const FETCH_CHUNK_SIZE = 24;
const MAX_HYDRATE_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_API_TITLE = "FluxProxy Captured API";
const DEFAULT_API_VERSION = "1.0.0";

function isBinaryContentType(ct: string | null | undefined): boolean {
  if (!ct) return false;
  const clean = ct.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    clean.startsWith("image/") ||
    clean.startsWith("video/") ||
    clean.startsWith("audio/") ||
    clean === "application/octet-stream"
  );
}

function getRequestContentType(detail: SessionDetail): string | null {
  for (const h of detail.requestHeaders) {
    if (h.name.trim().toLowerCase() === "content-type") {
      return h.value;
    }
  }
  return null;
}

function getResponseContentType(detail: SessionDetail): string | null {
  for (const h of detail.responseHeaders) {
    if (h.name.trim().toLowerCase() === "content-type") {
      return h.value;
    }
  }
  return detail.summary.contentType || null;
}

function deriveDefaultTitle(details: SessionDetail[]): string {
  const hostCounts = new Map<string, number>();
  for (const detail of details) {
    const scheme = (detail.summary.scheme || "").toLowerCase();
    const method = (detail.summary.method || "").toUpperCase();
    if (
      detail.summary.tlsBypassed ||
      method === "CONNECT" ||
      scheme === "ws" ||
      scheme === "wss" ||
      detail.summary.status === 101
    ) {
      continue;
    }
    const host = detail.summary.host?.trim();
    if (!host) continue;
    hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
  }
  if (hostCounts.size === 0) return DEFAULT_API_TITLE;
  const dominantHost = Array.from(hostCounts.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )[0]?.[0];
  return dominantHost ? `${dominantHost} API` : DEFAULT_API_TITLE;
}

function buildExportFileName(title: string, format: OpenApiFormat): string {
  const slug =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "fluxproxy-api";
  const ext = format === "json" ? "json" : "yaml";
  return `${slug}-openapi.${ext}`;
}

export const OpenApiExportModal: React.FC<OpenApiExportModalProps> = ({
  open,
  selectedIds,
  allSessionIds,
  resolvedTheme,
  onClose,
  onNotify,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const titleInputId = useId();
  const versionInputId = useId();
  const copyTimerRef = useRef<number | null>(null);

  const [scope, setScope] = useState<"selected" | "all">("selected");
  const [apiTitle, setApiTitle] = useState(DEFAULT_API_TITLE);
  const [titleTouched, setTitleTouched] = useState(false);
  const [apiVersion, setApiVersion] = useState(DEFAULT_API_VERSION);
  const [format, setFormat] = useState<OpenApiFormat>("yaml");
  const [includeExamples, setIncludeExamples] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);

  const [details, setDetails] = useState<SessionDetail[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncatedCount, setTruncatedCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Sync dialog open/close state
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      setScope(selectedIds.length > 0 ? "selected" : "all");
      setCopied(false);
      setTitleTouched(false);
      setLoadError(null);
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
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const activeTargetIds = useMemo(() => {
    if (scope === "selected" && selectedIds.length > 0) {
      return selectedIds;
    }
    return allSessionIds;
  }, [allSessionIds, scope, selectedIds]);

  // Load SessionDetail[] and hydrate offloaded text/JSON payloads
  useEffect(() => {
    if (!open) {
      setDetails([]);
      return;
    }

    let cancelled = false;
    const cappedIds = activeTargetIds.slice(0, MAX_OPENAPI_SESSIONS);
    setTruncatedCount(Math.max(0, activeTargetIds.length - MAX_OPENAPI_SESSIONS));

    if (cappedIds.length === 0) {
      setDetails([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setLoadError(null);

    const loadAll = async () => {
      try {
        const collected: SessionDetail[] = [];

        for (let i = 0; i < cappedIds.length; i += FETCH_CHUNK_SIZE) {
          if (cancelled) return;
          const chunk = cappedIds.slice(i, i + FETCH_CHUNK_SIZE);
          const batch = await Promise.all(
            chunk.map(async (id) => {
              const raw = await proxyBridge.getSessionDetail(id);
              if (!raw) return null;
              let detail = raw;

              if (
                detail.requestBodyOffloaded &&
                !isBinaryContentType(getRequestContentType(detail))
              ) {
                try {
                  const loaded = await proxyBridge.loadSessionBody(id, false);
                  if (loaded.bodySize <= MAX_HYDRATE_BODY_BYTES) {
                    detail = {
                      ...detail,
                      requestBodyBase64: loaded.bodyBase64,
                      requestBodyText: loaded.bodyText,
                      requestBodyOffloaded: false,
                    };
                  }
                } catch {
                  // Ignore offloaded body hydration failures
                }
              }

              if (
                detail.bodyOffloaded &&
                detail.summary.bodySize <= MAX_HYDRATE_BODY_BYTES &&
                !isBinaryContentType(getResponseContentType(detail))
              ) {
                try {
                  const loaded = await proxyBridge.loadSessionBody(id, true);
                  if (loaded.bodySize <= MAX_HYDRATE_BODY_BYTES) {
                    detail = {
                      ...detail,
                      responseBodyBase64: loaded.bodyBase64,
                      responseBodyText: loaded.bodyText,
                      bodyOffloaded: false,
                    };
                  }
                } catch {
                  // Ignore offloaded body hydration failures
                }
              }

              return detail;
            })
          );

          for (const item of batch) {
            if (item) collected.push(item);
          }
        }

        if (cancelled) return;
        setDetails(collected);
        if (!titleTouched) {
          setApiTitle(deriveDefaultTitle(collected));
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadAll();

    return () => {
      cancelled = true;
    };
  }, [activeTargetIds, open, titleTouched]);

  const generation = useMemo(() => {
    return buildOpenApiDocument(details, {
      title: apiTitle,
      version: apiVersion,
      format,
      includeExamples,
      redactSensitiveExamples: true,
      groupByTags: true,
    });
  }, [apiTitle, apiVersion, details, format, includeExamples]);

  const { serialized, stats } = generation;

  const lineCount = useMemo(
    () => (serialized ? serialized.split("\n").length - 1 : 0),
    [serialized]
  );

  const byteSize = useMemo(
    () => new TextEncoder().encode(serialized).byteLength,
    [serialized]
  );

  const handleCopySpec = async () => {
    if (!serialized || stats.includedSessions === 0) return;
    try {
      await navigator.clipboard.writeText(serialized);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 1800);
      onNotify?.(
        `Скопирована спецификация OpenAPI 3.0.3 (${format.toUpperCase()})`
      );
    } catch {
      onNotify?.("Не удалось скопировать спецификацию в буфер обмена");
    }
  };

  const handleSaveSpec = async () => {
    if (!serialized || stats.includedSessions === 0 || isSaving) return;
    setIsSaving(true);
    try {
      const defaultName = buildExportFileName(apiTitle, format);
      const filters: FileDialogFilter[] =
        format === "json"
          ? [
              { name: "OpenAPI 3.0 JSON (*.json)", extensions: ["json"] },
              { name: "All Files (*.*)", extensions: ["*"] },
            ]
          : [
              {
                name: "OpenAPI 3.0 YAML (*.yaml, *.yml)",
                extensions: ["yaml", "yml"],
              },
              { name: "All Files (*.*)", extensions: ["*"] },
            ];

      const chosenPath = await proxyBridge.pickSaveFileDialog({
        title: `Export OpenAPI 3.0.3 Spec (${format.toUpperCase()})`,
        defaultName,
        filters,
      });
      if (!chosenPath) return;

      const mimeType =
        format === "json"
          ? "application/json;charset=utf-8"
          : "application/yaml;charset=utf-8";
      await proxyBridge.exportTextFile(chosenPath, serialized, mimeType);
      const savedName = chosenPath.split(/[\\/]/).pop() ?? defaultName;
      onNotify?.(
        `Спецификация OpenAPI 3.0.3 сохранена: ${savedName} (${stats.operationsCount} эндпоинтов)`
      );
    } catch (err) {
      onNotify?.(
        `⚠️ Не удалось сохранить OpenAPI-спецификацию: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      setIsSaving(false);
    }
  };

  const monacoTheme = getMonacoThemeName(resolvedTheme);
  const hasBothScopes = selectedIds.length > 0 && allSessionIds.length > 0;
  const canExport = !isLoading && !loadError && stats.includedSessions > 0;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) {
          dialogRef.current.returnValue = "";
        }
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="fixed inset-0 m-0 h-screen w-screen max-h-none max-w-none overflow-hidden rounded-none border-0 bg-surface p-0 text-fg open:flex open:flex-col"
    >
      <SectionHeader
        sectionId="openApiExport"
        titleId={titleId}
        headingLevel={1}
        icon={<FileJson className="h-4 w-4 text-accent" />}
        badges={
          !isLoading ? (
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
              <span className="rounded bg-canvas px-1.5 py-0.5 text-fg ring-1 ring-hairline">
                {stats.operationsCount} endpoints
              </span>
              <span className="rounded bg-canvas px-1.5 py-0.5 text-muted ring-1 ring-hairline">
                {stats.pathsCount} paths
              </span>
              <span className="rounded bg-canvas px-1.5 py-0.5 text-muted ring-1 ring-hairline">
                {stats.serversCount} servers
              </span>
              {stats.skippedSessions > 0 && (
                <span
                  title="CONNECT-туннели и WebSocket-сессии исключаются из OpenAPI 3.0"
                  className="rounded bg-status3xx-bg px-1.5 py-0.5 text-status3xx-fg ring-1 ring-hairline"
                >
                  {stats.skippedSessions} skipped
                </span>
              )}
              {stats.securitySchemes.length > 0 && (
                <span
                  title={`Токены и cookie вынесены в components.securitySchemes без реальных секретов: ${stats.securitySchemes.join(", ")}`}
                  className="inline-flex items-center gap-1 rounded bg-status2xx-bg px-1.5 py-0.5 text-status2xx-fg ring-1 ring-hairline"
                >
                  <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span>{stats.securitySchemes.length} securitySchemes</span>
                </span>
              )}
            </div>
          ) : undefined
        }
        actions={
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Закрыть OpenAPI Export"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-muted hover:border-strong hover:bg-hover hover:text-fg"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        }
      />

      {/* Config Toolbar */}
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-3 border-b border-hairline bg-surface px-4 py-2.5 text-xs">
        <div className="flex flex-wrap items-end gap-2.5">
          {hasBothScopes && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-subtle">
                Scope
              </span>
              <div
                role="group"
                aria-label="Выбор набора сессий"
                className="flex items-center gap-0.5 rounded-lg border border-hairline bg-canvas p-0.5"
              >
                <button
                  type="button"
                  aria-pressed={scope === "selected"}
                  onClick={() => setScope("selected")}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    scope === "selected"
                      ? "bg-selected text-fg ring-1 ring-accent/50"
                      : "text-muted hover:text-fg"
                  }`}
                >
                  Selected ({selectedIds.length})
                </button>
                <button
                  type="button"
                  aria-pressed={scope === "all"}
                  onClick={() => setScope("all")}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    scope === "all"
                      ? "bg-selected text-fg ring-1 ring-accent/50"
                      : "text-muted hover:text-fg"
                  }`}
                >
                  All Visible ({allSessionIds.length})
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label
              htmlFor={titleInputId}
              className="text-[10px] font-semibold uppercase tracking-wider text-subtle"
            >
              API Title
            </label>
            <input
              id={titleInputId}
              type="text"
              value={apiTitle}
              onChange={(e) => {
                setTitleTouched(true);
                setApiTitle(e.target.value);
              }}
              placeholder={DEFAULT_API_TITLE}
              className="h-8 w-52 rounded border border-strong bg-canvas px-2.5 text-xs text-fg placeholder:text-subtle focus:border-accent focus:outline-none sm:w-60"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor={versionInputId}
              className="text-[10px] font-semibold uppercase tracking-wider text-subtle"
            >
              Version
            </label>
            <input
              id={versionInputId}
              type="text"
              value={apiVersion}
              onChange={(e) => setApiVersion(e.target.value)}
              placeholder={DEFAULT_API_VERSION}
              className="h-8 w-24 rounded border border-strong bg-canvas px-2.5 font-mono text-xs text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-subtle">
              Format
            </span>
            <div
              role="tablist"
              aria-label="Формат вывода OpenAPI"
              className="flex items-center gap-0.5 rounded-lg border border-hairline bg-canvas p-0.5"
            >
              {(["yaml", "json"] as const).map((fmt) => {
                const active = format === fmt;
                return (
                  <button
                    key={fmt}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      setFormat(fmt);
                      setCopied(false);
                    }}
                    className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold uppercase transition-colors ${
                      active
                        ? "bg-elevated text-accent shadow-sm ring-1 ring-strong/70"
                        : "text-muted hover:text-fg"
                    }`}
                  >
                    {fmt}
                  </button>
                );
              })}
            </div>
          </div>

          <label
            title="Добавляет примеры запросов/ответов из трафика; токены и секретные поля автоматически маскируются"
            className="flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-hairline bg-canvas px-2.5 text-xs text-fg hover:bg-hover"
          >
            <input
              type="checkbox"
              checked={includeExamples}
              onChange={(e) => setIncludeExamples(e.target.checked)}
              className="checkbox-native"
            />
            <span>Include Examples</span>
          </label>
        </div>

        {truncatedCount > 0 && (
          <div className="inline-flex items-center gap-1.5 rounded border border-hairline bg-status3xx-bg px-2.5 py-1 text-[11px] text-status3xx-fg">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              Обработаны первые {MAX_OPENAPI_SESSIONS} сессий (пропущено ещё{" "}
              {truncatedCount})
            </span>
          </div>
        )}
      </div>

      {/* Preview Body */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-canvas">
        {isLoading ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted">
            <Loader2 className="h-5 w-5 animate-spin text-accent" aria-hidden="true" />
            <span>Анализ сессий и синтез JSON Schema…</span>
          </div>
        ) : loadError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs">
            <AlertTriangle className="h-6 w-6 text-status5xx-fg" aria-hidden="true" />
            <p className="font-semibold text-fg">
              Не удалось загрузить детали выбранных сессий
            </p>
            <p className="max-w-md font-mono text-[11px] text-muted">
              {loadError}
            </p>
          </div>
        ) : stats.includedSessions === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs">
            <AlertTriangle className="h-6 w-6 text-status3xx-fg" aria-hidden="true" />
            <p className="font-semibold text-fg">
              Нет HTTP/HTTPS REST-запросов для генерации OpenAPI 3.0.3
            </p>
            <p className="max-w-md text-[11px] text-muted">
              Выбранные сессии содержат только CONNECT-туннели (TLS Bypass) или
              WebSocket-соединения, которые не описываются в OpenAPI 3.0.
            </p>
          </div>
        ) : (
          open && (
            <Editor
              height="100%"
              language={format}
              theme={monacoTheme}
              value={serialized}
              options={{
                readOnly: true,
                domReadOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbers: "on",
                wordWrap: wordWrap ? "on" : "off",
                scrollBeyondLastLine: false,
                automaticLayout: true,
                padding: { top: 10, bottom: 10 },
              }}
            />
          )
        )}
      </div>

      {/* Footer */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-hairline bg-elevated/50 px-4 py-2.5 text-[11px] text-muted">
        <div className="flex min-w-0 flex-wrap items-center gap-2 font-mono">
          <span className="font-semibold text-fg">OpenAPI 3.0.3</span>
          <span aria-hidden="true">•</span>
          <span>{format.toUpperCase()}</span>
          <span aria-hidden="true">•</span>
          <span>{lineCount.toLocaleString("en-US")} lines</span>
          <span aria-hidden="true">•</span>
          <span>{formatBytes(byteSize)}</span>
          {stats.securitySchemes.length > 0 && (
            <>
              <span aria-hidden="true">•</span>
              <span className="truncate text-status2xx-fg">
                Security: {stats.securitySchemes.join(", ")} (secrets omitted)
              </span>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={wordWrap}
            onClick={() => setWordWrap((v) => !v)}
            className={`inline-flex h-8 items-center gap-1 rounded border px-2.5 text-[11px] transition-colors ${
              wordWrap
                ? "border-accent/50 bg-selected text-accent"
                : "border-hairline bg-surface text-muted hover:text-fg"
            }`}
          >
            <WrapText className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Word Wrap</span>
          </button>

          <button
            type="button"
            disabled={!canExport}
            onClick={() => void handleCopySpec()}
            className="inline-flex h-8 items-center gap-1.5 rounded border border-strong bg-surface px-3 text-xs font-medium text-fg transition-colors hover:bg-hover disabled:opacity-45"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-status2xx-fg" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>{copied ? "Copied!" : "Copy"}</span>
          </button>

          <button
            type="button"
            autoFocus
            {...({ autofocus: "" } as Record<string, string>)}
            disabled={!canExport || isSaving}
            onClick={() => void handleSaveSpec()}
            className="inline-flex h-8 items-center gap-1.5 rounded bg-sky-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-sky-500 disabled:opacity-45"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{isSaving ? "Saving…" : "Save Spec…"}</span>
          </button>

          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="h-8 rounded border border-strong bg-surface px-3 text-xs font-medium text-fg hover:bg-hover"
          >
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
};
