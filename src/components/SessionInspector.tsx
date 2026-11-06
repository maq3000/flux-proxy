import React, { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Copy,
  Cpu,
  GitCompareArrows,
  MessageSquarePlus,
  OctagonPause,
  PanelBottom,
  PanelRight,
  RotateCw,
  Rows3,
  Send,
  ShieldOff,
  Smartphone,
  Target,
  Wand2,
} from "lucide-react";
import {
  buildRawHttpRequest,
  buildRawHttpResponse,
  formatBytes,
  formatDuration,
  parseCookies,
  parseQueryParams,
  tryFormatJson,
} from "../lib/formatters";
import { hexToRgba } from "../lib/sessionDiff";
import {
  analyzeAuth,
  analyzeCaching,
  hasMultipartOrFormPayload,
  hasProtobufOrGrpcContentType,
  isSseSession,
} from "../lib/protocolInspectors";
import type {
  HeaderPair,
  InspectorDockPosition,
  InspectorTab,
  SessionDetail,
} from "../types/proxy";
import { HexViewer } from "./HexViewer";
import {
  AuthInspectorPanel,
  CachingInspectorPanel,
  MultipartInspectorPanel,
  ProtobufGrpcPanel,
  SseInspectorPanel,
  WebSocketFramesPanel,
} from "./InspectorProtocolPanels";
import type { TextWizardTab } from "./TextWizardModal";

interface SessionInspectorProps {
  detail: SessionDetail | null;
  resolvedTheme: "dark" | "light";
  containerRef?: React.RefObject<HTMLDivElement>;
  onReturnFocusToGrid?: () => void;
  inspectorPosition?: InspectorDockPosition;
  onChangeInspectorPosition?: (pos: InspectorDockPosition) => void;
  onCollapseInspector?: () => void;
  externalHexTrigger?: number;
  onReplaySession?: (id: number) => void;
  onSendToComposer: (id: number) => void;
  onFilterByProcess?: (processName: string) => void;
  onFilterByClientIp?: (clientIp: string) => void;
  onAlwaysInspectHost?: (host: string) => void;
  onAddHostToTlsBypass?: (host: string) => void;
  onOpenTextWizard?: (text: string, tab: TextWizardTab) => void;
  onQuickAddBpu?: (pattern: string) => void;
  onAnnotateSession?: (id: number) => void;
  onOpenDiffWithSession?: (id: number) => void;
  canResumePairDiff?: boolean;
  onResumePairDiff?: () => void;
}

const REQUEST_TABS: { id: InspectorTab; label: string }[] = [
  { id: "headers", label: "Headers" },
  { id: "params", label: "Params" },
  { id: "cookies", label: "Cookies" },
  { id: "auth", label: "Auth" },
  { id: "multipart", label: "Multipart" },
  { id: "protobuf", label: "gRPC / Proto" },
  { id: "raw", label: "Raw" },
  { id: "json", label: "JSON" },
  { id: "xml", label: "XML" },
  { id: "hex", label: "Hex" },
];

const RESPONSE_TABS: { id: InspectorTab; label: string }[] = [
  { id: "headers", label: "Headers" },
  { id: "cookies", label: "Cookies" },
  { id: "caching", label: "Caching" },
  { id: "auth", label: "Auth" },
  { id: "sse", label: "SSE" },
  { id: "ws", label: "WS" },
  { id: "protobuf", label: "gRPC / Proto" },
  { id: "raw", label: "Raw" },
  { id: "json", label: "JSON" },
  { id: "xml", label: "XML" },
  { id: "image", label: "Image" },
  { id: "hex", label: "Hex" },
];

export const SessionInspector: React.FC<SessionInspectorProps> = ({
  detail,
  resolvedTheme,
  containerRef,
  onReturnFocusToGrid,
  inspectorPosition = "bottom",
  onChangeInspectorPosition,
  onCollapseInspector,
  externalHexTrigger = 0,
  onReplaySession,
  onSendToComposer,
  onFilterByProcess,
  onFilterByClientIp,
  onAlwaysInspectHost,
  onAddHostToTlsBypass,
  onOpenTextWizard,
  onQuickAddBpu,
  onAnnotateSession,
  onOpenDiffWithSession,
  canResumePairDiff,
  onResumePairDiff,
}) => {
  const [reqTab, setReqTab] = useState<InspectorTab>("headers");
  const [respTab, setRespTab] = useState<InspectorTab>("json");
  const [splitDirection, setSplitDirection] = useState<
    "vertical" | "horizontal"
  >(() => (inspectorPosition === "bottom" ? "horizontal" : "vertical"));

  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "light";

  useEffect(() => {
    if (externalHexTrigger > 0) {
      setRespTab("hex");
      if (!detail?.responseBodyBase64 && detail?.requestBodyBase64) {
        setReqTab("hex");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalHexTrigger]);

  const handleContainerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    const inEditor = Boolean(target.closest(".monaco-editor"));
    if (e.key === "Escape" && !inEditor) {
      e.preventDefault();
      onReturnFocusToGrid?.();
      return;
    }
    if (
      (e.key === " " || e.key === "Enter") &&
      e.target === e.currentTarget
    ) {
      e.preventDefault();
      onReturnFocusToGrid?.();
    }
  };

  const queryParams = useMemo(
    () => (detail ? parseQueryParams(detail.summary.url) : []),
    [detail]
  );
  const reqCookies = useMemo(
    () => (detail ? parseCookies(detail.requestHeaders, false) : []),
    [detail]
  );
  const respCookies = useMemo(
    () => (detail ? parseCookies(detail.responseHeaders, true) : []),
    [detail]
  );

  const authSummary = useMemo(
    () => (detail ? analyzeAuth(detail) : null),
    [detail]
  );
  const cacheSummary = useMemo(
    () => (detail ? analyzeCaching(detail) : null),
    [detail]
  );

  const hasReqMultipart = useMemo(
    () =>
      detail
        ? hasMultipartOrFormPayload(
            detail.requestHeaders,
            detail.requestBodyBase64
          )
        : false,
    [detail]
  );
  const hasReqProto = useMemo(
    () => (detail ? hasProtobufOrGrpcContentType(detail.requestHeaders) : false),
    [detail]
  );
  const hasRespProto = useMemo(
    () =>
      detail ? hasProtobufOrGrpcContentType(detail.responseHeaders) : false,
    [detail]
  );
  const isSse = useMemo(
    () => (detail ? isSseSession(detail) : false),
    [detail]
  );
  const wsCount = detail?.websocketFrames.length ?? 0;

  // Smart default tab selection when switching to specialized protocol sessions (SSE, WS, gRPC, Multipart, Image)
  useEffect(() => {
    if (!detail) return;
    const ct = detail.summary.contentType.toLowerCase();

    if (
      detail.requestHeaders.some((h) =>
        h.name.toLowerCase() === "content-type" &&
        h.value.toLowerCase().includes("multipart/")
      )
    ) {
      setReqTab("multipart");
    } else if (hasProtobufOrGrpcContentType(detail.requestHeaders)) {
      setReqTab("protobuf");
    } else if (reqTab === "multipart" || reqTab === "protobuf") {
      setReqTab("headers");
    }

    if (isSseSession(detail)) {
      setRespTab("sse");
    } else if (detail.websocketFrames.length > 0 || detail.summary.scheme === "wss") {
      setRespTab("ws");
    } else if (hasProtobufOrGrpcContentType(detail.responseHeaders)) {
      setRespTab("protobuf");
    } else if (ct.startsWith("image/")) {
      setRespTab("image");
    } else if (ct.includes("xml")) {
      setRespTab("xml");
    } else if (detail.summary.status === 304) {
      setRespTab("caching");
    } else if (
      respTab === "sse" ||
      respTab === "ws" ||
      respTab === "protobuf" ||
      respTab === "image"
    ) {
      setRespTab(ct.includes("json") ? "json" : "raw");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.summary.id]);

  if (!detail) {
    return (
      <div
        ref={containerRef}
        tabIndex={-1}
        onKeyDown={handleContainerKeyDown}
        aria-label="Session Inspector"
        className="pane-contain relative flex h-full flex-col items-center justify-center bg-surface p-6 text-center text-xs text-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50"
      >
        {(onChangeInspectorPosition || onCollapseInspector) && (
          <div className="absolute right-2 top-2 flex items-center gap-1">
            {onChangeInspectorPosition && (
              <button
                type="button"
                onClick={() =>
                  onChangeInspectorPosition(
                    inspectorPosition === "bottom" ? "right" : "bottom"
                  )
                }
                title={
                  inspectorPosition === "bottom"
                    ? "Dock Inspector to Right"
                    : "Dock Inspector to Bottom"
                }
                className="rounded border border-hairline bg-elevated/70 p-1 text-muted hover:text-fg"
              >
                {inspectorPosition === "bottom" ? (
                  <PanelRight className="h-3.5 w-3.5" />
                ) : (
                  <PanelBottom className="h-3.5 w-3.5" />
                )}
              </button>
            )}
            {onCollapseInspector && (
              <button
                type="button"
                onClick={onCollapseInspector}
                title="Hide Session Inspector"
                className="rounded border border-hairline bg-elevated/70 p-1 text-muted hover:text-fg"
              >
                {inspectorPosition === "bottom" ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
            )}
          </div>
        )}
        <p className="font-medium text-fg">Session Inspector</p>
        <p className="mt-1 max-w-xs text-subtle">
          Выберите любую HTTP, HTTPS, SSE, gRPC или WebSocket сессию в таблице трафика (или нажмите Space / Enter) для просмотра заголовков, Auth/JWT, правил кэширования и тела запроса/ответа.
        </p>
      </div>
    );
  }

  const { summary } = detail;
  const isImage = summary.contentType.toLowerCase().startsWith("image/");
  const respStatusColor =
    summary.status >= 500 || summary.status === 502 || summary.status === 504
      ? "text-status5xx-fg"
      : summary.status >= 400
        ? "text-status4xx-fg"
        : summary.status === 101
          ? "text-statusWs-fg"
          : summary.status >= 300
            ? "text-status3xx-fg"
            : "text-status2xx-fg";

  const handleSendSessionToWizard = () => {
    if (!onOpenTextWizard) return;
    const authHdr = detail.requestHeaders.find(
      (h) => h.name.toLowerCase() === "authorization"
    );
    if (authHdr && authHdr.value.toLowerCase().startsWith("bearer ")) {
      onOpenTextWizard(authHdr.value.slice(7).trim(), "jwt");
      return;
    }
    if (detail.responseBodyText) {
      onOpenTextWizard(detail.responseBodyText, "base64");
      return;
    }
    onOpenTextWizard(summary.url, "url");
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleContainerKeyDown}
      aria-label={`Session Inspector #${summary.id}`}
      className="pane-contain flex h-full flex-col bg-surface focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50"
    >
      {/* Compact Session Summary Bar */}
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-hairline bg-elevated/60 px-2.5">
        <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
          <span className="rounded bg-status3xx-bg px-1.5 py-0.5 font-semibold text-status3xx-fg">
            {summary.method}
          </span>
          <span className="truncate text-fg select-text" title={summary.url}>
            {summary.url}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1 text-[11px] text-muted">
          {summary.clientIp &&
            summary.clientIp !== "127.0.0.1" &&
            summary.clientIp !== "::1" &&
            summary.clientIp !== "localhost" && (
              <button
                type="button"
                onClick={() => onFilterByClientIp?.(summary.clientIp!)}
                title={`Устройство в локальной сети (${detail.clientAddr || summary.clientIp}) — нажмите, чтобы отфильтровать трафик этого устройства`}
                className="inline-flex items-center gap-1 rounded border border-status2xx-fg/35 bg-status2xx-bg px-1.5 py-0.5 font-mono text-[10px] text-status2xx-fg hover:brightness-110"
              >
                <Smartphone className="h-3 w-3" aria-hidden="true" />
                <span>{summary.clientIp}</span>
              </button>
            )}
          {summary.processName && (
            <button
              type="button"
              onClick={() => onFilterByProcess?.(summary.processName!)}
              title="Нажмите, чтобы отфильтровать трафик этого процесса"
              className="hidden items-center gap-1 rounded border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[10px] text-statusWs-fg hover:border-strong lg:inline-flex"
            >
              <Cpu className="h-3 w-3" />
              <span>
                {summary.processName}
                {summary.processPid != null ? `:${summary.processPid}` : ""}
              </span>
            </button>
          )}
          {detail.tlsVersion && (
            <span
              className={`hidden rounded border px-1.5 py-0.5 font-mono text-[10px] xl:inline ${
                summary.tlsBypassed
                  ? "border-hairline bg-surface text-muted"
                  : "border-hairline bg-status2xx-bg text-status2xx-fg"
              }`}
            >
              {detail.tlsVersion}
            </span>
          )}
          {onAnnotateSession && (
            <button
              type="button"
              onClick={() => onAnnotateSession(summary.id)}
              title="Добавить комментарий или цветовую заливку строки (клавиша M)"
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                summary.comment || summary.markedColor
                  ? "border-status4xx-fg/40 bg-status4xx-bg text-status4xx-fg"
                  : "border-hairline bg-surface text-muted hover:border-strong hover:text-fg"
              }`}
            >
              <MessageSquarePlus className="h-3 w-3" />
              <span className="hidden xl:inline">Mark</span>
            </button>
          )}
          {(onOpenDiffWithSession || (canResumePairDiff && onResumePairDiff)) && (
            <button
              type="button"
              onClick={() => {
                if (canResumePairDiff && onResumePairDiff) {
                  onResumePairDiff();
                } else {
                  onOpenDiffWithSession?.(summary.id);
                }
              }}
              title={
                canResumePairDiff
                  ? "Вернуться к встроенному сравнению двух выбранных сессий (Session Diff)"
                  : "Сравнить эту сессию в Monaco DiffEditor (Ctrl+D)"
              }
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                canResumePairDiff
                  ? "border-accent/50 bg-status3xx-bg text-status3xx-fg"
                  : "border-hairline bg-surface text-muted hover:border-strong hover:text-fg"
              }`}
            >
              <GitCompareArrows className="h-3 w-3" />
              <span className="hidden xl:inline">
                {canResumePairDiff ? "Back to Diff" : "Diff"}
              </span>
            </button>
          )}
          {onQuickAddBpu && (
            <button
              type="button"
              onClick={() =>
                onQuickAddBpu(summary.path.split("?")[0] || summary.host)
              }
              title={`Поставить точку останова bpu на ${summary.path.split("?")[0] || summary.host}`}
              className="hidden items-center gap-1 rounded border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted hover:border-strong hover:text-fg xl:inline-flex"
            >
              <OctagonPause className="h-3 w-3" />
              <span>bpu</span>
            </button>
          )}
          {onOpenTextWizard && (
            <button
              type="button"
              onClick={handleSendSessionToWizard}
              title="Открыть токен или тело сессии в TextWizard / JWT Decoder (Ctrl+E)"
              className="hidden items-center gap-1 rounded border border-hairline bg-surface px-1.5 py-0.5 text-[10px] text-muted hover:border-strong hover:text-fg 2xl:inline-flex"
            >
              <Wand2 className="h-3 w-3" />
              <span>Wizard</span>
            </button>
          )}
          {onAlwaysInspectHost && summary.tlsBypassed && (
            <button
              type="button"
              onClick={() => onAlwaysInspectHost(summary.host)}
              title={`Always inspect this host (${summary.host}) — добавить в Target Allowlist и включить MITM-расшифровку`}
              className="inline-flex items-center gap-1 rounded border border-status2xx-fg/35 bg-status2xx-bg px-1.5 py-0.5 text-[10px] font-medium text-status2xx-fg"
            >
              <Target className="h-3 w-3" />
              <span className="hidden 2xl:inline">Inspect</span>
            </button>
          )}
          {onAddHostToTlsBypass &&
            (summary.scheme === "https" || summary.scheme === "wss") &&
            !summary.tlsBypassed && (
              <button
                type="button"
                onClick={() => onAddHostToTlsBypass(summary.host)}
                title={`Always passthrough this host (${summary.host}) — чистый TCP-проброс без MITM`}
                className="hidden items-center gap-1 rounded border border-hairline bg-surface px-1.5 py-0.5 text-[10px] text-muted hover:border-strong hover:text-fg 2xl:inline-flex"
              >
                <ShieldOff className="h-3 w-3" />
                <span>Passthrough</span>
              </button>
            )}
          <span className="hidden font-mono tabular-nums lg:inline">
            {formatBytes(summary.bodySize)} • {formatDuration(summary.durationMs)}
          </span>
          {onReplaySession && (
            <button
              type="button"
              onClick={() => onReplaySession(summary.id)}
              title="Replay request directly to upstream (R)"
              className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-1.5 py-0.5 text-[11px] text-fg hover:border-strong hover:text-accent"
            >
              <RotateCw className="h-3 w-3" />
              <span className="hidden sm:inline">Replay</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onSendToComposer(summary.id)}
            title="Edit & Replay session in Composer"
            className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-1.5 py-0.5 text-[11px] text-muted hover:border-strong hover:text-fg"
          >
            <Send className="h-3 w-3" />
            <span className="hidden xl:inline">Composer</span>
          </button>
          <button
            type="button"
            onClick={() =>
              setSplitDirection((d) =>
                d === "vertical" ? "horizontal" : "vertical"
              )
            }
            title="Toggle Request/Response Split Orientation"
            className="rounded border border-hairline bg-surface p-1 text-muted hover:text-fg"
          >
            {splitDirection === "vertical" ? (
              <Columns3 className="h-3.5 w-3.5" />
            ) : (
              <Rows3 className="h-3.5 w-3.5" />
            )}
          </button>
          {onChangeInspectorPosition && (
            <button
              type="button"
              onClick={() =>
                onChangeInspectorPosition(
                  inspectorPosition === "bottom" ? "right" : "bottom"
                )
              }
              title={
                inspectorPosition === "bottom"
                  ? "Dock Inspector to Right"
                  : "Dock Inspector to Bottom"
              }
              className="rounded border border-hairline bg-surface p-1 text-muted hover:text-fg"
            >
              {inspectorPosition === "bottom" ? (
                <PanelRight className="h-3.5 w-3.5" />
              ) : (
                <PanelBottom className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {onCollapseInspector && (
            <button
              type="button"
              onClick={onCollapseInspector}
              title="Collapse Session Inspector"
              className="rounded border border-hairline bg-surface p-1 text-muted hover:text-fg"
            >
              {inspectorPosition === "bottom" ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* User Annotation Bar (Comment / Custom Row Color) */}
      {(summary.comment || summary.markedColor) && (
        <div
          style={
            summary.markedColor
              ? {
                  backgroundColor:
                    hexToRgba(summary.markedColor, 0.14) ?? undefined,
                  boxShadow: `inset 3px 0 0 0 ${summary.markedColor}`,
                }
              : undefined
          }
          className={`flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-3 py-1.5 text-xs ${
            summary.markedColor ? "" : "bg-status4xx-bg"
          }`}
        >
          <div className="flex min-w-0 items-center gap-2">
            {summary.markedColor ? (
              <span
                aria-hidden="true"
                style={{ backgroundColor: summary.markedColor }}
                className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/25"
              />
            ) : (
              <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-status4xx-fg" />
            )}
            <span className="truncate font-medium text-fg select-text">
              {summary.comment ||
                `Строка помечена цветом (${summary.markedColor})`}
            </span>
          </div>

          {onAnnotateSession && (
            <button
              type="button"
              onClick={() => onAnnotateSession(summary.id)}
              className="shrink-0 rounded border border-hairline bg-surface/80 px-2 py-0.5 font-mono text-[10px] text-muted hover:border-strong hover:text-fg"
            >
              Изменить (M)
            </button>
          )}
        </div>
      )}

      {/* Split Request (Top/Left) & Response (Bottom/Right) */}
      <PanelGroup direction={splitDirection} className="flex-1 overflow-hidden">
        {/* REQUEST PANE */}
        <Panel defaultSize={44} minSize={20} className="flex flex-col overflow-hidden">
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-hairline bg-surface px-2">
            <div className="flex items-center gap-0.5 overflow-x-auto">
              <span className="mr-1.5 shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider text-accent">
                Request
              </span>
              {REQUEST_TABS.map((t) => {
                const badge =
                  t.id === "params" && queryParams.length > 0
                    ? ` (${queryParams.length})`
                    : t.id === "cookies" && reqCookies.length > 0
                      ? ` (${reqCookies.length})`
                      : t.id === "auth" && authSummary?.hasAuth
                        ? " •"
                        : t.id === "multipart" && hasReqMultipart
                          ? " •"
                          : t.id === "protobuf" && hasReqProto
                            ? " •"
                            : "";
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setReqTab(t.id)}
                    className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                      reqTab === t.id
                        ? "bg-elevated text-fg ring-1 ring-hairline"
                        : badge
                          ? "text-accent hover:text-fg"
                          : "text-muted hover:text-fg"
                    }`}
                  >
                    {t.label}
                    {badge}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard?.writeText(buildRawHttpRequest(detail))
              }
              title="Copy Raw Request"
              className="shrink-0 rounded p-1 text-subtle hover:text-fg"
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>

          <div className="flex-1 overflow-hidden bg-canvas">
            {reqTab === "headers" && (
              <KeyValueTable
                items={detail.requestHeaders}
                emptyLabel="No request headers"
              />
            )}
            {reqTab === "params" && (
              <KeyValueTable
                items={queryParams}
                emptyLabel="No URL query parameters present"
              />
            )}
            {reqTab === "cookies" && (
              <CookiesTable items={reqCookies} emptyLabel="No request cookies" />
            )}
            {reqTab === "auth" && (
              <AuthInspectorPanel
                detail={detail}
                onOpenTextWizard={onOpenTextWizard}
              />
            )}
            {reqTab === "multipart" && (
              <MultipartInspectorPanel
                headers={detail.requestHeaders}
                bodyBase64={detail.requestBodyBase64}
                bodyText={detail.requestBodyText}
              />
            )}
            {reqTab === "protobuf" && (
              <ProtobufGrpcPanel
                headers={detail.requestHeaders}
                bodyBase64={detail.requestBodyBase64}
                monacoTheme={monacoTheme}
              />
            )}
            {reqTab === "raw" && (
              <Editor
                height="100%"
                language="http"
                theme={monacoTheme}
                value={buildRawHttpRequest(detail)}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                }}
              />
            )}
            {reqTab === "json" && (
              <Editor
                height="100%"
                language="json"
                theme={monacoTheme}
                value={
                  tryFormatJson(detail.requestBodyText).formatted ||
                  "// Empty or non-JSON request body"
                }
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                }}
              />
            )}
            {reqTab === "xml" && (
              <Editor
                height="100%"
                language="xml"
                theme={monacoTheme}
                value={detail.requestBodyText || "<!-- Empty request body -->"}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                }}
              />
            )}
            {reqTab === "hex" && (
              <HexViewer base64Data={detail.requestBodyBase64} />
            )}
          </div>
        </Panel>

        <PanelResizeHandle
          className={
            splitDirection === "vertical"
              ? "h-1 w-full bg-hairline transition-colors hover:bg-accent/60"
              : "h-full w-1 bg-hairline transition-colors hover:bg-accent/60"
          }
        />

        {/* RESPONSE PANE */}
        <Panel defaultSize={56} minSize={20} className="flex flex-col overflow-hidden">
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-hairline bg-surface px-2">
            <div className="flex items-center gap-0.5 overflow-x-auto">
              <span
                className={`mr-1.5 shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider ${respStatusColor}`}
              >
                Response ({summary.status || "WAIT"})
              </span>
              {RESPONSE_TABS.map((t) => {
                const badge =
                  t.id === "cookies" && respCookies.length > 0
                    ? ` (${respCookies.length})`
                    : t.id === "caching" && cacheSummary?.hasCacheSignals
                      ? " •"
                      : t.id === "auth" && authSummary?.hasAuth
                        ? " •"
                        : t.id === "sse" && isSse
                          ? ` (${detail.sseEvents?.length || "•"})`
                          : t.id === "ws" && wsCount > 0
                            ? ` (${wsCount})`
                            : t.id === "protobuf" && hasRespProto
                              ? " •"
                              : t.id === "image" && isImage
                                ? " •"
                                : "";
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setRespTab(t.id)}
                    className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                      respTab === t.id
                        ? "bg-elevated text-fg ring-1 ring-hairline"
                        : badge
                          ? "text-status2xx-fg hover:text-fg"
                          : "text-muted hover:text-fg"
                    }`}
                  >
                    {t.label}
                    {badge}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard?.writeText(
                  detail.responseBodyText ?? buildRawHttpResponse(detail)
                )
              }
              title="Copy Response Body"
              className="shrink-0 rounded p-1 text-subtle hover:text-fg"
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>

          <div className="flex-1 overflow-hidden bg-canvas">
            {respTab === "headers" && (
              <KeyValueTable
                items={detail.responseHeaders}
                emptyLabel="No response headers"
              />
            )}
            {respTab === "cookies" && (
              <CookiesTable
                items={respCookies}
                emptyLabel="No Set-Cookie headers in response"
              />
            )}
            {respTab === "caching" && <CachingInspectorPanel detail={detail} />}
            {respTab === "auth" && (
              <AuthInspectorPanel
                detail={detail}
                onOpenTextWizard={onOpenTextWizard}
              />
            )}
            {respTab === "sse" && (
              <SseInspectorPanel detail={detail} monacoTheme={monacoTheme} />
            )}
            {respTab === "ws" && (
              <WebSocketFramesPanel frames={detail.websocketFrames} />
            )}
            {respTab === "protobuf" && (
              <ProtobufGrpcPanel
                headers={detail.responseHeaders}
                bodyBase64={detail.responseBodyBase64}
                monacoTheme={monacoTheme}
              />
            )}
            {respTab === "raw" && (
              <Editor
                height="100%"
                language="http"
                theme={monacoTheme}
                value={buildRawHttpResponse(detail)}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                }}
              />
            )}
            {respTab === "json" && (
              <Editor
                height="100%"
                language="json"
                theme={monacoTheme}
                value={
                  tryFormatJson(detail.responseBodyText).formatted ||
                  "// Empty response payload"
                }
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                }}
              />
            )}
            {respTab === "xml" && (
              <Editor
                height="100%"
                language="xml"
                theme={monacoTheme}
                value={detail.responseBodyText || "<!-- Empty response payload -->"}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                }}
              />
            )}
            {respTab === "image" && (
              <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto p-4 checkerboard-bg">
                {isImage && detail.responseBodyBase64 ? (
                  <>
                    <img
                      src={`data:${summary.contentType.split(";")[0]};base64,${detail.responseBodyBase64}`}
                      alt={summary.path}
                      className="max-h-[75%] max-w-[90%] rounded border border-strong shadow-popover"
                    />
                    <span className="rounded bg-surface/90 px-2.5 py-1 font-mono text-[11px] text-muted ring-1 ring-hairline">
                      {summary.contentType} • {formatBytes(summary.bodySize)}
                    </span>
                  </>
                ) : (
                  <span className="rounded bg-surface/90 px-3 py-1.5 text-xs text-muted ring-1 ring-hairline">
                    Response Content-Type ({summary.contentType}) is not an image.
                  </span>
                )}
              </div>
            )}
            {respTab === "hex" && (
              <HexViewer base64Data={detail.responseBodyBase64} />
            )}
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
};

const KeyValueTable: React.FC<{ items: HeaderPair[]; emptyLabel: string }> = ({
  items,
  emptyLabel,
}) => {
  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-subtle">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto p-2 select-text">
      <table className="w-full border-collapse font-mono text-xs">
        <tbody>
          {items.map((item, idx) => (
            <tr
              key={`${item.name}-${idx}`}
              className="border-b border-hairline/60 hover:bg-hover/40"
            >
              <td className="w-48 py-1.5 pr-3 align-top font-semibold text-accent">
                {item.name}
              </td>
              <td className="break-all py-1.5 text-fg">{item.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const CookiesTable: React.FC<{
  items: { name: string; value: string; attributes: string }[];
  emptyLabel: string;
}> = ({ items, emptyLabel }) => {
  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-subtle">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto p-2 select-text">
      <table className="w-full border-collapse font-mono text-xs">
        <thead>
          <tr className="border-b border-hairline text-left text-[10px] uppercase text-subtle">
            <th className="py-1 pr-3">Name</th>
            <th className="py-1 pr-3">Value</th>
            <th className="py-1">Attributes</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c, idx) => (
            <tr key={`${c.name}-${idx}`} className="border-b border-hairline/60">
              <td className="py-1.5 pr-3 font-semibold text-status4xx-fg">
                {c.name}
              </td>
              <td className="break-all py-1.5 pr-3 text-fg">{c.value}</td>
              <td className="py-1.5 text-muted">{c.attributes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
