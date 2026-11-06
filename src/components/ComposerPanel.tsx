import React, { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { Loader2, Plus, Send, Trash2, UploadCloud } from "lucide-react";
import { formatBytes, formatDuration, tryFormatJson } from "../lib/formatters";
import { proxyBridge } from "../lib/tauriBridge";
import type {
  ComposedRequest,
  HeaderPair,
  SessionDetail,
} from "../types/proxy";

interface ComposerPanelProps {
  draftRequest: ComposedRequest | null;
  resolvedTheme: "dark" | "light";
  onLoadSessionIntoComposer: (sessionId: number) => void;
  onSessionCreated: (detail: SessionDetail) => void;
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
  onLoadSessionIntoComposer,
  onSessionCreated,
}) => {
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
  const [activeTab, setActiveTab] = useState<"headers" | "body">("body");
  const [sending, setSending] = useState(false);
  const [lastResponse, setLastResponse] = useState<SessionDetail | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

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

  const handleExecute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || sending) return;
    setSending(true);
    try {
      const detail = await proxyBridge.executeComposedRequest({
        method,
        url: url.trim(),
        headers: headers.filter((h) => h.name.trim().length > 0),
        body,
        followRedirects,
      });
      setLastResponse(detail);
      onSessionCreated(detail);
    } finally {
      setSending(false);
    }
  };

  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "light";

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
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-hairline bg-elevated/60 px-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold text-fg">
            Request Composer
          </span>
          <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-400">
            Drag & Drop enabled
          </span>
        </div>

        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input
            type="checkbox"
            checked={followRedirects}
            onChange={(e) => setFollowRedirects(e.target.checked)}
            className="rounded"
          />
          <span>Follow redirects</span>
        </label>
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
          {HTTP_METHODS.map((m) => (
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
          placeholder="https://api.example.com/v1/resource"
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
      </form>

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
    </div>
  );
};
