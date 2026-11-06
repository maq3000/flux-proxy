import React, { useId, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  AlertTriangle,
  Binary,
  Check,
  CheckCircle2,
  Copy,
  FileImage,
  FileText,
  HardDriveDownload,
  KeyRound,
  Layers,
  Radio,
  ShieldAlert,
  Sparkles,
  Wand2,
  XCircle,
} from "lucide-react";
import { formatBytes } from "../lib/formatters";
import {
  analyzeAuth,
  analyzeCaching,
  decodeProtobufOrGrpc,
  parseMultipartBody,
  parseSseStream,
} from "../lib/protocolInspectors";
import type {
  HeaderPair,
  SessionDetail,
  WebSocketFrameRecord,
} from "../types/proxy";
import type { TextWizardTab } from "./TextWizardModal";

// ============================================================================
// 1. SSE (Server-Sent Events / text/event-stream) Streaming Inspector
// ============================================================================
export const SseInspectorPanel: React.FC<{
  detail: SessionDetail;
  monacoTheme: "vs-dark" | "light";
}> = ({ detail, monacoTheme }) => {
  const captionId = useId();
  const [selectedIdx, setSelectedIdx] = useState<number>(1);
  const [copiedStream, setCopiedStream] = useState(false);

  const analysis = useMemo(
    () => parseSseStream(detail.responseBodyText, detail.sseEvents),
    [detail.responseBodyText, detail.sseEvents]
  );

  const selectedEvent =
    analysis.events.find((e) => e.index === selectedIdx) ??
    analysis.events[0] ??
    null;

  if (!analysis.isSse) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center text-xs text-muted">
        <Radio className="h-5 w-5 text-subtle" />
        <p className="font-medium text-fg">Поток SSE (text/event-stream) не обнаружен</p>
        <p className="max-w-sm text-[11px] text-subtle">
          Выберите ответ с заголовком <code>Content-Type: text/event-stream</code> (например, стриминг LLM <code>/v1/chat/completions</code>), чтобы исследовать чанки во времени.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas select-text">
      {/* Summary & Reconstructed LLM Output Header */}
      <div className="shrink-0 space-y-2 border-b border-hairline bg-surface p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-2 font-mono">
            <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-0.5 font-semibold text-emerald-400">
              <Radio className="h-3 w-3" />
              <span>{analysis.events.length} SSE чанков</span>
            </span>
            <span className="text-muted">
              Длительность потока: <strong className="text-fg">{analysis.totalDurationMs} ms</strong>
            </span>
            <span className="text-muted">
              Объём: <strong className="text-fg">{formatBytes(analysis.totalBytes)}</strong>
            </span>
          </div>

          {analysis.reconstructedText && (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(analysis.reconstructedText);
                setCopiedStream(true);
                window.setTimeout(() => setCopiedStream(false), 1500);
              }}
              className="inline-flex items-center gap-1 rounded border border-hairline bg-elevated px-2 py-0.5 font-mono text-[11px] text-sky-400 hover:bg-hover"
            >
              {copiedStream ? (
                <>
                  <Check className="h-3 w-3 text-emerald-400" />
                  <span>Скопировано</span>
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  <span>Copy склеенный текст</span>
                </>
              )}
            </button>
          )}
        </div>

        {analysis.isLlmStream && analysis.reconstructedText && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/[0.07] p-2">
            <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-sky-400">
              <Sparkles className="h-3 w-3" />
              <span>Реконструированный ответ LLM из дельта-чанков</span>
            </div>
            <p className="max-h-20 overflow-y-auto whitespace-pre-wrap font-sans text-xs leading-relaxed text-fg">
              {analysis.reconstructedText}
            </p>
          </div>
        )}
      </div>

      {/* Split Timeline Table + Selected Chunk JSON Viewer */}
      <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-hairline lg:grid-cols-12 lg:divide-x lg:divide-y-0">
        <div
          tabIndex={0}
          role="region"
          aria-labelledby={captionId}
          className="filter-table-wrapper lg:col-span-7"
        >
          <table
            className="filter-data-table font-mono text-xs tabular-nums"
            style={
              {
                "--label-2": '"Offset / Δ"',
                "--label-3": '"Event"',
                "--label-4": '"Size"',
                "--label-5": '"Data / Token"',
              } as React.CSSProperties
            }
          >
            <caption id={captionId} className="sr-only">
              Поток событий Server-Sent Events во времени
            </caption>
            <thead>
              <tr className="border-b border-hairline text-left text-[10px] uppercase text-subtle">
                <th className="px-2.5 py-1.5">#</th>
                <th className="px-2 py-1.5">+Offset (Δ)</th>
                <th className="px-2 py-1.5">Event</th>
                <th className="px-2 py-1.5 text-right">Size</th>
                <th className="px-2.5 py-1.5">Data / Delta</th>
              </tr>
            </thead>
            <tbody>
              {analysis.events.map((ev) => {
                const isSelected = selectedEvent?.index === ev.index;
                return (
                  <tr
                    key={ev.index}
                    onClick={() => setSelectedIdx(ev.index)}
                    className={`cursor-pointer border-b border-hairline/50 transition-colors ${
                      isSelected ? "bg-selected text-fg" : "hover:bg-hover/60"
                    }`}
                  >
                    <th className="px-2.5 py-1.5 text-left font-semibold text-subtle">
                      #{ev.index}
                    </th>
                    <td data-col="2" className="px-2 py-1.5 text-emerald-400">
                      +{ev.offsetMs}ms{" "}
                      <span className="text-[10px] text-subtle">
                        (Δ{ev.deltaMs}ms)
                      </span>
                    </td>
                    <td data-col="3" className="px-2 py-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          ev.isDoneSentinel
                            ? "bg-amber-500/20 text-amber-300"
                            : "bg-sky-500/15 text-sky-300"
                        }`}
                      >
                        {ev.isDoneSentinel ? "[DONE]" : ev.event}
                      </span>
                    </td>
                    <td
                      data-col="4"
                      className="px-2 py-1.5 text-right text-muted"
                    >
                      {ev.byteLength} B
                    </td>
                    <td
                      data-col="5"
                      className="max-w-[260px] truncate px-2.5 py-1.5 text-fg"
                    >
                      {ev.extractedToken ? (
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">
                          {JSON.stringify(ev.extractedToken)}
                        </span>
                      ) : (
                        ev.data
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex min-h-[160px] flex-col overflow-hidden lg:col-span-5">
          <div className="flex items-center justify-between border-b border-hairline bg-surface px-2.5 py-1 font-mono text-[10px] text-subtle">
            <span>
              Чанк #{selectedEvent?.index ?? 1}
              {selectedEvent?.id ? ` • id=${selectedEvent.id}` : ""}
            </span>
            <span>+{selectedEvent?.offsetMs ?? 0} ms</span>
          </div>
          <div className="flex-1 overflow-hidden">
            <Editor
              height="100%"
              language={selectedEvent?.parsedJson ? "json" : "plaintext"}
              theme={monacoTheme}
              value={
                selectedEvent
                  ? selectedEvent.parsedJson
                    ? JSON.stringify(selectedEvent.parsedJson, null, 2)
                    : selectedEvent.data
                  : ""
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
      </div>
    </div>
  );
};

// ============================================================================
// 2. WebSocket Frames Inspector
// ============================================================================
export const WebSocketFramesPanel: React.FC<{
  frames: WebSocketFrameRecord[];
}> = ({ frames }) => {
  const captionId = useId();

  if (frames.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-subtle">
        Нет перехваченных WebSocket-кадров в этой сессии.
      </div>
    );
  }

  return (
    <div
      tabIndex={0}
      role="region"
      aria-labelledby={captionId}
      className="filter-table-wrapper h-full p-2 select-text"
    >
      <table
        className="filter-data-table font-mono text-xs tabular-nums"
        style={
          {
            "--label-2": '"Направление"',
            "--label-3": '"Opcode"',
            "--label-4": '"Размер"',
            "--label-5": '"Payload"',
          } as React.CSSProperties
        }
      >
        <caption id={captionId} className="sr-only">
          Перехваченные кадры WebSocket
        </caption>
        <thead>
          <tr className="border-b border-hairline text-left text-[10px] uppercase text-subtle">
            <th className="px-2 py-1.5">#</th>
            <th className="px-2 py-1.5">Dir</th>
            <th className="px-2 py-1.5">Opcode</th>
            <th className="px-2 py-1.5 text-right">Bytes</th>
            <th className="px-2 py-1.5">Payload Preview</th>
          </tr>
        </thead>
        <tbody>
          {frames.map((f) => (
            <tr key={f.index} className="border-b border-hairline/50 hover:bg-hover/40">
              <th className="px-2 py-1.5 text-left text-subtle">#{f.index}</th>
              <td data-col="2" className="px-2 py-1.5">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                    f.direction === "outbound"
                      ? "bg-sky-500/15 text-sky-400"
                      : "bg-violet-500/15 text-violet-300"
                  }`}
                >
                  {f.direction === "outbound" ? "↑ Client" : "↓ Server"}
                </span>
              </td>
              <td data-col="3" className="px-2 py-1.5 text-muted">
                {f.opcode}
              </td>
              <td data-col="4" className="px-2 py-1.5 text-right text-muted">
                {formatBytes(f.byteLength)}
              </td>
              <td data-col="5" className="break-all px-2 py-1.5 text-fg">
                {f.payloadPreview}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ============================================================================
// 3. Multipart / Form-Data & Uploaded File Preview Inspector
// ============================================================================
export const MultipartInspectorPanel: React.FC<{
  headers: HeaderPair[];
  bodyBase64: string;
  bodyText?: string | null;
}> = ({ headers, bodyBase64, bodyText }) => {
  const captionId = useId();
  const [selectedPartIdx, setSelectedPartIdx] = useState<number>(1);

  const analysis = useMemo(
    () => parseMultipartBody(headers, bodyBase64, bodyText),
    [headers, bodyBase64, bodyText]
  );

  const activePart =
    analysis.parts.find((p) => p.index === selectedPartIdx) ??
    analysis.parts[0] ??
    null;

  if (!analysis.detected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center text-xs text-muted">
        <Layers className="h-5 w-5 text-subtle" />
        <p className="font-medium text-fg">Составная форма не обнаружена</p>
        <p className="max-w-sm text-[11px] text-subtle">
          {analysis.error ??
            "Инспектор разбирает тела multipart/form-data (включая превью загружаемых изображений) и application/x-www-form-urlencoded."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas select-text">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-hairline bg-surface px-3 py-1.5 font-mono text-[11px]">
        <div className="flex items-center gap-2">
          <span className="rounded bg-sky-500/15 px-2 py-0.5 font-semibold text-sky-400">
            {analysis.kind === "multipart"
              ? `multipart/form-data (${analysis.parts.length} частей)`
              : `form-urlencoded (${analysis.parts.length} полей)`}
          </span>
          {analysis.boundary && (
            <span className="truncate text-subtle" title={analysis.boundary}>
              boundary={analysis.boundary}
            </span>
          )}
        </div>
        <span className="text-muted">{formatBytes(analysis.totalBytes)}</span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-hairline lg:grid-cols-12 lg:divide-x lg:divide-y-0">
        <div
          tabIndex={0}
          role="region"
          aria-labelledby={captionId}
          className="filter-table-wrapper lg:col-span-7"
        >
          <table
            className="filter-data-table font-mono text-xs tabular-nums"
            style={
              {
                "--label-2": '"Поле (name)"',
                "--label-3": '"Файл / MIME"',
                "--label-4": '"Размер"',
              } as React.CSSProperties
            }
          >
            <caption id={captionId} className="sr-only">
              Части составной формы Multipart/Form-Data
            </caption>
            <thead>
              <tr className="border-b border-hairline text-left text-[10px] uppercase text-subtle">
                <th className="px-2.5 py-1.5">#</th>
                <th className="px-2 py-1.5">Field Name</th>
                <th className="px-2 py-1.5">Filename / Content-Type</th>
                <th className="px-2.5 py-1.5 text-right">Size</th>
              </tr>
            </thead>
            <tbody>
              {analysis.parts.map((part) => {
                const selected = activePart?.index === part.index;
                return (
                  <tr
                    key={part.index}
                    onClick={() => setSelectedPartIdx(part.index)}
                    className={`cursor-pointer border-b border-hairline/50 transition-colors ${
                      selected ? "bg-selected text-fg" : "hover:bg-hover/60"
                    }`}
                  >
                    <th className="px-2.5 py-1.5 text-left text-subtle">
                      #{part.index}
                    </th>
                    <td
                      data-col="2"
                      className="px-2 py-1.5 font-semibold text-sky-400"
                    >
                      {part.name}
                    </td>
                    <td data-col="3" className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        {part.imageDataUrl ? (
                          <FileImage className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 shrink-0 text-subtle" />
                        )}
                        <span className="truncate text-fg">
                          {part.filename ?? part.contentType}
                        </span>
                      </div>
                    </td>
                    <td
                      data-col="4"
                      className="px-2.5 py-1.5 text-right text-muted"
                    >
                      {formatBytes(part.byteLength)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Selected Part Preview (Image / Text / JSON / Hex) */}
        <div className="flex min-h-[150px] flex-col overflow-auto p-3 lg:col-span-5">
          {activePart && (
            <div className="space-y-2.5 text-xs">
              <div className="flex items-center justify-between border-b border-hairline pb-1.5 font-mono text-[11px]">
                <span className="font-semibold text-fg">
                  name=&quot;{activePart.name}&quot;
                  {activePart.filename ? ` • ${activePart.filename}` : ""}
                </span>
                <span className="text-subtle">{activePart.contentType}</span>
              </div>

              {activePart.imageDataUrl ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-hairline p-3 checkerboard-bg">
                  <img
                    src={activePart.imageDataUrl}
                    alt={activePart.filename ?? activePart.name}
                    className="max-h-40 max-w-full rounded border border-strong shadow"
                  />
                  <span className="rounded bg-surface/90 px-2 py-0.5 font-mono text-[10px] text-muted">
                    Превью загружаемого файла • {formatBytes(activePart.byteLength)}
                  </span>
                </div>
              ) : null}

              {!activePart.isBinary && activePart.textPreview ? (
                <pre className="max-h-48 overflow-auto rounded-lg border border-hairline bg-surface p-2.5 whitespace-pre-wrap break-all font-mono text-[11px] text-fg">
                  {activePart.textPreview}
                </pre>
              ) : (
                <div className="rounded-lg border border-hairline bg-surface p-2.5 font-mono text-[11px]">
                  <div className="mb-1 text-[10px] uppercase text-subtle">
                    Первые байты (Hex Preview):
                  </div>
                  <div className="break-all text-muted">
                    {activePart.hexPreview || "00"}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 4. Protobuf / gRPC Binary Wire-Format Inspector
// ============================================================================
export const ProtobufGrpcPanel: React.FC<{
  headers: HeaderPair[];
  bodyBase64: string;
  monacoTheme: "vs-dark" | "light";
}> = ({ headers, bodyBase64, monacoTheme }) => {
  const captionId = useId();
  const [forceDecode, setForceDecode] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "json">("table");

  const analysis = useMemo(
    () => decodeProtobufOrGrpc(headers, bodyBase64, forceDecode),
    [headers, bodyBase64, forceDecode]
  );

  if (!analysis.detected && !forceDecode) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted">
        <Binary className="h-5 w-5 text-subtle" />
        <p className="font-medium text-fg">
          Заголовок не указывает на Protobuf / gRPC
        </p>
        <p className="max-w-sm text-[11px] text-subtle">
          Ожидается <code>application/grpc</code>, <code>application/grpc+proto</code> или <code>application/x-protobuf</code>. Вы также можете принудительно декодировать текущие байты по wire-протоколу Protobuf.
        </p>
        {bodyBase64 && (
          <button
            type="button"
            onClick={() => setForceDecode(true)}
            className="mt-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-3 py-1 text-xs font-medium text-sky-300 hover:bg-sky-500/25"
          >
            Принудительно декодировать как Protobuf
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas select-text">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-hairline bg-surface px-3 py-1.5 font-mono text-[11px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-violet-500/15 px-2 py-0.5 font-semibold text-violet-300">
            {analysis.isGrpcEnvelope
              ? `gRPC Length-Prefixed (${analysis.frames.length} frame)`
              : "Raw Protobuf Wire"}
          </span>
          {analysis.grpcStatus && (
            <span
              className={`rounded px-2 py-0.5 font-semibold ${
                analysis.grpcStatus.code === 0
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-rose-500/15 text-rose-300"
              }`}
            >
              grpc-status: {analysis.grpcStatus.code} ({analysis.grpcStatus.name})
              {analysis.grpcStatus.message
                ? ` — ${analysis.grpcStatus.message}`
                : ""}
            </span>
          )}
          <span className="text-muted">{formatBytes(analysis.totalBytes)}</span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setViewMode("table")}
            className={`rounded px-2 py-0.5 text-[11px] ${
              viewMode === "table"
                ? "bg-selected text-sky-300"
                : "text-muted hover:text-fg"
            }`}
          >
            Wire Fields ({analysis.flattenedFields.length})
          </button>
          <button
            type="button"
            onClick={() => setViewMode("json")}
            className={`rounded px-2 py-0.5 text-[11px] ${
              viewMode === "json"
                ? "bg-selected text-sky-300"
                : "text-muted hover:text-fg"
            }`}
          >
            JSON Projection
          </button>
        </div>
      </div>

      {analysis.error ? (
        <div className="p-4 text-xs text-rose-300">{analysis.error}</div>
      ) : viewMode === "json" ? (
        <div className="flex-1 overflow-hidden">
          <Editor
            height="100%"
            language="json"
            theme={monacoTheme}
            value={analysis.jsonProjection}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              wordWrap: "on",
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      ) : (
        <div
          tabIndex={0}
          role="region"
          aria-labelledby={captionId}
          className="filter-table-wrapper flex-1 p-2"
        >
          <table
            className="filter-data-table font-mono text-xs tabular-nums"
            style={
              {
                "--label-2": '"Wire Type"',
                "--label-3": '"Значение"',
                "--label-4": '"Интерпретации (int64 / zigzag / float)"',
                "--label-5": '"Offset"',
              } as React.CSSProperties
            }
          >
            <caption id={captionId} className="sr-only">
              Декодированные бинарные поля Protobuf / gRPC
            </caption>
            <thead>
              <tr className="border-b border-hairline text-left text-[10px] uppercase text-subtle">
                <th className="px-2.5 py-1.5">Field #</th>
                <th className="px-2 py-1.5">Wire Type</th>
                <th className="px-2 py-1.5">Decoded Value</th>
                <th className="px-2 py-1.5">Alternate Wire Casts</th>
                <th className="px-2.5 py-1.5 text-right">@Offset (Len)</th>
              </tr>
            </thead>
            <tbody>
              {analysis.flattenedFields.map((f, idx) => (
                <tr
                  key={`${f.path}-${idx}`}
                  className="border-b border-hairline/50 hover:bg-hover/40"
                >
                  <th className="px-2.5 py-1.5 text-left font-semibold text-sky-400">
                    #{f.path}
                  </th>
                  <td data-col="2" className="px-2 py-1.5 text-violet-300">
                    {f.wireTypeName}
                  </td>
                  <td
                    data-col="3"
                    className="max-w-[260px] break-all px-2 py-1.5 font-semibold text-fg"
                  >
                    {f.valueSummary}
                  </td>
                  <td data-col="4" className="px-2 py-1.5 text-[11px] text-muted">
                    {f.alternateInterpretations}
                  </td>
                  <td
                    data-col="5"
                    className="px-2.5 py-1.5 text-right text-[11px] text-subtle"
                  >
                    +{f.byteOffset} ({f.byteLength} B)
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 5. Auth Inspector Tab (Bearer / JWT / Basic / API Key / WWW-Authenticate)
// ============================================================================
export const AuthInspectorPanel: React.FC<{
  detail: SessionDetail;
  onOpenTextWizard?: (text: string, tab: TextWizardTab) => void;
}> = ({ detail, onOpenTextWizard }) => {
  const analysis = useMemo(() => analyzeAuth(detail), [detail]);

  if (!analysis.hasAuth) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center text-xs text-muted">
        <KeyRound className="h-5 w-5 text-subtle" />
        <p className="font-medium text-fg">Заголовки авторизации не передавались</p>
        <p className="max-w-sm text-[11px] text-subtle">
          В сессии отсутствуют <code>Authorization</code>, <code>X-API-Key</code>, <code>WWW-Authenticate</code> или OAuth-токены.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full space-y-3 overflow-y-auto p-3 text-xs select-text">
      {/* Security Audit Findings */}
      {analysis.securityFindings.length > 0 && (
        <div className="space-y-1.5">
          {analysis.securityFindings.map((f, idx) => (
            <div
              key={idx}
              className={`flex items-start gap-2 rounded-lg border p-2.5 text-[11px] ${
                f.level === "error"
                  ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
                  : f.level === "warn"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                    : "border-emerald-500/35 bg-emerald-500/10 text-emerald-200"
              }`}
            >
              {f.level === "error" ? (
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
              ) : f.level === "warn" ? (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              ) : (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
              )}
              <span>{f.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Credential Cards */}
      {analysis.entries.map((entry, idx) => (
        <div
          key={`${entry.headerName}-${idx}`}
          className="rounded-lg border border-hairline bg-surface p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-2">
            <div className="flex items-center gap-2">
              <span className="rounded bg-sky-500/15 px-2 py-0.5 font-mono text-[11px] font-bold text-sky-400">
                {entry.scheme}
              </span>
              <span className="font-mono text-[11px] text-muted">
                {entry.headerName}
              </span>
            </div>

            {entry.rawTokenForWizard && onOpenTextWizard && (
              <button
                type="button"
                onClick={() =>
                  onOpenTextWizard(
                    entry.rawTokenForWizard!,
                    entry.jwt ? "jwt" : entry.scheme === "Basic" ? "base64" : "jwt"
                  )
                }
                className="inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-300 hover:bg-sky-500/20"
              >
                <Wand2 className="h-3 w-3" />
                <span>Открыть в TextWizard</span>
              </button>
            )}
          </div>

          <div className="mt-2 text-xs font-medium text-fg">{entry.summary}</div>

          {entry.parameters.length > 0 && (
            <div className="mt-2 divide-y divide-hairline/60 rounded border border-hairline/70 bg-canvas font-mono text-[11px]">
              {entry.parameters.map((p, pIdx) => (
                <div key={`${p.name}-${pIdx}`} className="flex gap-3 px-2.5 py-1.5">
                  <span className="w-40 shrink-0 font-semibold text-sky-400">
                    {p.name}
                  </span>
                  <span className="break-all text-fg">{p.value}</span>
                </div>
              ))}
            </div>
          )}

          {entry.jwt && (
            <div className="mt-2.5 grid grid-cols-1 gap-2 lg:grid-cols-2">
              <div className="rounded border border-hairline bg-canvas p-2">
                <div className="mb-1 font-mono text-[10px] uppercase text-subtle">
                  JWT Header
                </div>
                <pre className="overflow-auto font-mono text-[11px] text-fg">
                  {entry.jwt.headerJson}
                </pre>
              </div>
              <div className="rounded border border-hairline bg-canvas p-2">
                <div className="mb-1 font-mono text-[10px] uppercase text-subtle">
                  JWT Claims
                </div>
                <pre className="max-h-36 overflow-auto font-mono text-[11px] text-fg">
                  {entry.jwt.claimsJson}
                </pre>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// 6. HTTP Caching Inspector Tab (RFC 9111 Human-Readable Diagnostics)
// ============================================================================
export const CachingInspectorPanel: React.FC<{
  detail: SessionDetail;
}> = ({ detail }) => {
  const analysis = useMemo(() => analyzeCaching(detail), [detail]);

  const bannerTone =
    analysis.verdict === "cacheable-fresh" ||
    analysis.verdict === "conditional-hit"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
      : analysis.verdict === "cacheable-revalidate"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
        : "border-rose-500/35 bg-rose-500/10 text-rose-200";

  return (
    <div className="h-full space-y-3 overflow-y-auto p-3 text-xs select-text">
      {/* Primary Verdict Card */}
      <div className={`rounded-lg border p-3 ${bannerTone}`}>
        <div className="flex items-start gap-2.5">
          {analysis.verdict === "cacheable-fresh" ||
          analysis.verdict === "conditional-hit" ? (
            <HardDriveDownload className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          ) : analysis.verdict === "cacheable-revalidate" ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          )}
          <div>
            <div className="text-xs font-semibold">{analysis.verdictHeadline}</div>
            <p className="mt-1 text-[11px] leading-relaxed opacity-95">
              {analysis.verdictSummary}
            </p>
          </div>
        </div>
      </div>

      {/* Why Cached or Not — Step-by-step RFC 9111 explanation */}
      <div className="rounded-lg border border-hairline bg-surface p-3">
        <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-subtle">
          Почему ресурс кэшируется или нет (Анализ RFC 9111)
        </div>
        <ul className="list-disc space-y-1 pl-4 text-[11px] text-fg">
          {analysis.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </div>

      {/* Validators & Freshness Metrics */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <MetricPill
          label="ETag Валидатор"
          value={
            analysis.validators.etag
              ? `${analysis.validators.etag} (${analysis.validators.etagKind})`
              : "Отсутствует"
          }
        />
        <MetricPill
          label="Last-Modified"
          value={analysis.validators.lastModified ?? "Отсутствует"}
        />
        <MetricPill
          label="Vary (Ключи кэша)"
          value={analysis.validators.vary ?? "Не задан"}
        />
        <MetricPill
          label="Shared CDN / Proxy Cache"
          value={
            analysis.freshness.sharedCacheAllowed
              ? "Разрешено"
              : "Запрещено (только браузер / no-store)"
          }
        />
        <MetricPill
          label="Age / CDN Status"
          value={
            [
              analysis.freshness.ageSec !== null
                ? `Age: ${analysis.freshness.ageSec}s`
                : null,
              analysis.validators.cdnCacheStatus,
            ]
              .filter(Boolean)
              .join(" • ") || "—"
          }
        />
        <MetricPill
          label="Условный запрос клиента"
          value={
            analysis.validators.ifNoneMatch
              ? `If-None-Match: ${analysis.validators.ifNoneMatch}`
              : analysis.validators.ifModifiedSince
                ? `If-Modified-Since: ${analysis.validators.ifModifiedSince}`
                : "Безусловный запрос"
          }
        />
      </div>

      {/* Directive-by-Directive Table */}
      {analysis.directives.length > 0 && (
        <div className="rounded-lg border border-hairline bg-surface p-2.5">
          <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-subtle">
            Разбор директив Cache-Control ({analysis.directives.length})
          </div>
          <div className="divide-y divide-hairline/60 font-mono text-[11px]">
            {analysis.directives.map((d, idx) => (
              <div
                key={`${d.source}-${d.directive}-${idx}`}
                className="flex flex-wrap items-start gap-2.5 py-1.5"
              >
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                    d.source === "Request"
                      ? "bg-sky-500/15 text-sky-400"
                      : "bg-emerald-500/15 text-emerald-400"
                  }`}
                >
                  {d.source}
                </span>
                <code className="font-semibold text-fg">{d.directive}</code>
                <span className="font-sans text-muted">{d.explanation}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const MetricPill: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <div className="rounded-lg border border-hairline bg-surface px-2.5 py-2">
    <div className="font-mono text-[10px] uppercase text-subtle">{label}</div>
    <div className="mt-0.5 truncate font-mono text-[11px] font-medium text-fg" title={value}>
      {value}
    </div>
  </div>
);
