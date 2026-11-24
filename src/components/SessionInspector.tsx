import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import {
  AlertTriangle,
  BarChart2,
  ChevronDown,
  ChevronRight,
  Clock,
  Columns3,
  Copy,
  Cpu,
  Database,
  Download,
  GitCompareArrows,
  Loader2,
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
} from "lucide-react";
import {
  buildRawHttpRequest,
  buildRawHttpResponse,
  decodeBase64ToBytes,
  formatBytes,
  formatDuration,
  parseCookies,
  parseQueryParams,
  tryFormatJson,
} from "../lib/formatters";

const SAFE_RASTER_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
]);
import { hexToRgba } from "../lib/sessionDiff";
import { getMonacoThemeName } from "../lib/monaco";
import {
  analyzeAuth,
  analyzeCaching,
  hasMultipartOrFormPayload,
  hasProtobufOrGrpcContentType,
  isSseSession,
} from "../lib/protocolInspectors";
import { proxyBridge } from "../lib/tauriBridge";
import {
  FLUX_PANEL_AUTOSAVE_IDS,
  FLUX_PANEL_LAYOUT_RESET_EVENT,
  SAFE_PANEL_STORAGE,
  type InspectorSplitDirection,
} from "../hooks/useUiPreferences";
import type {
  HeaderPair,
  InspectorDockPosition,
  InspectorTab,
  LoadedSessionBody,
  SessionDetail,
  SessionSummary,
  WebSocketFrameRecord,
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
import { SessionStatisticsPanel } from "./SessionStatisticsPanel";
import type { TextWizardTab } from "./TextWizardPanel";

interface SessionInspectorProps {
  detail: SessionDetail | null;
  selectedSessions?: SessionSummary[];
  onSelectSession?: (id: number) => void;
  statisticsOpenTrigger?: number;
  resolvedTheme: "dark" | "light";
  containerRef?: React.RefObject<HTMLDivElement>;
  onReturnFocusToGrid?: () => void;
  inspectorPosition?: InspectorDockPosition;
  onChangeInspectorPosition?: (pos: InspectorDockPosition) => void;
  splitDirection?: "horizontal" | "vertical";
  inspectorSplitDirection?: InspectorSplitDirection;
  onToggleSplitDirection?: () => void;
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
  onSaveBodyFile?: (sessionId: number, isResponse: boolean) => void;
  onOpenTimeoutSettings?: () => void;
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
  selectedSessions,
  onSelectSession,
  statisticsOpenTrigger = 0,
  resolvedTheme,
  containerRef,
  onReturnFocusToGrid,
  inspectorPosition = "bottom",
  onChangeInspectorPosition,
  splitDirection: splitDirectionProp,
  inspectorSplitDirection,
  onToggleSplitDirection,
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
  onSaveBodyFile,
  onOpenTimeoutSettings,
}) => {
  const [reqTab, setReqTab] = useState<InspectorTab>("headers");
  const [respTab, setRespTab] = useState<InspectorTab>("json");
  const [inspectorMode, setInspectorMode] = useState<"inspectors" | "statistics">(
    "inspectors"
  );
  const [activePane, setActivePane] = useState<"request" | "response">(
    "response"
  );

  useEffect(() => {
    if (statisticsOpenTrigger > 0) {
      setInspectorMode("statistics");
    }
  }, [statisticsOpenTrigger]);
  const internalContainerRef = useRef<HTMLDivElement>(null);
  const resolvedContainerRef = containerRef ?? internalContainerRef;
  const [localSplitDirection, setLocalSplitDirection] = useState<
    "vertical" | "horizontal"
  >(() => (inspectorPosition === "bottom" ? "horizontal" : "vertical"));
  const effectiveSplitDirection: "horizontal" | "vertical" =
    splitDirectionProp ?? localSplitDirection;

  const inspectorGroupRef = useRef<ImperativePanelGroupHandle>(null);

  const handleToggleSplitDirection = useCallback(() => {
    if (onToggleSplitDirection) {
      onToggleSplitDirection();
    } else {
      setLocalSplitDirection((d) =>
        d === "vertical" ? "horizontal" : "vertical"
      );
    }
  }, [onToggleSplitDirection]);

  const handleResetInspectorSplit = useCallback(() => {
    inspectorGroupRef.current?.setLayout([44, 56]);
  }, []);

  useEffect(() => {
    const onReset = () => {
      handleResetInspectorSplit();
    };
    window.addEventListener(FLUX_PANEL_LAYOUT_RESET_EVENT, onReset);
    return () => {
      window.removeEventListener(FLUX_PANEL_LAYOUT_RESET_EVENT, onReset);
    };
  }, [handleResetInspectorSplit]);

  // Lazy-loaded heavy payload state (> 2 MB bodies offloaded to SQLite for OOM protection)
  const [loadedRespEntry, setLoadedRespEntry] = useState<{
    sessionId: number;
    payload: LoadedSessionBody;
  } | null>(null);
  const [loadingRespState, setLoadingRespState] = useState<{
    sessionId: number;
    token: number;
  } | null>(null);
  const [respBodyErrorEntry, setRespBodyErrorEntry] = useState<{
    sessionId: number;
    message: string;
  } | null>(null);

  const [loadedReqEntry, setLoadedReqEntry] = useState<{
    sessionId: number;
    payload: LoadedSessionBody;
  } | null>(null);
  const [loadingReqState, setLoadingReqState] = useState<{
    sessionId: number;
    token: number;
  } | null>(null);
  const [extraWsFramesEntry, setExtraWsFramesEntry] = useState<{
    sessionId: number;
    frames: WebSocketFrameRecord[];
  } | null>(null);

  const [reqBodyErrorEntry, setReqBodyErrorEntry] = useState<{
    sessionId: number;
    message: string;
  } | null>(null);

  const currentSessionIdRef = useRef<number | null>(detail?.summary.id ?? null);
  currentSessionIdRef.current = detail?.summary.id ?? null;
  const respLoadTokenRef = useRef(0);
  const reqLoadTokenRef = useRef(0);

  const activeDetailId = detail?.summary.id ?? null;
  const loadingRespBody =
    activeDetailId !== null &&
    loadingRespState !== null &&
    loadingRespState.sessionId === activeDetailId;
  const respBodyError =
    activeDetailId !== null &&
    respBodyErrorEntry !== null &&
    respBodyErrorEntry.sessionId === activeDetailId
      ? respBodyErrorEntry.message
      : null;
  const loadingReqBody =
    activeDetailId !== null &&
    loadingReqState !== null &&
    loadingReqState.sessionId === activeDetailId;
  const reqBodyError =
    activeDetailId !== null &&
    reqBodyErrorEntry !== null &&
    reqBodyErrorEntry.sessionId === activeDetailId
      ? reqBodyErrorEntry.message
      : null;

  const effectiveDetail = useMemo<SessionDetail | null>(() => {
    if (!detail) return null;
    const respPayload =
      loadedRespEntry?.sessionId === detail.summary.id
        ? loadedRespEntry.payload
        : null;
    const reqPayload =
      loadedReqEntry?.sessionId === detail.summary.id
        ? loadedReqEntry.payload
        : null;
    if (!respPayload && !reqPayload) return detail;
    return {
      ...detail,
      ...(reqPayload
        ? {
            requestBodyBase64: reqPayload.bodyBase64,
            requestBodyText: reqPayload.bodyText,
            requestBodyOffloaded: false,
          }
        : {}),
      ...(respPayload
        ? {
            responseBodyBase64: respPayload.bodyBase64,
            responseBodyText: respPayload.bodyText,
            bodyOffloaded: false,
          }
        : {}),
    };
  }, [detail, loadedReqEntry, loadedRespEntry]);

  const handleLoadResponseBody = useCallback(async () => {
    const sessionId = detail?.summary.id;
    if (sessionId == null || loadingRespBody) return;
    const token = ++respLoadTokenRef.current;
    setLoadingRespState({ sessionId, token });
    setRespBodyErrorEntry((prev) =>
      prev?.sessionId === sessionId ? null : prev
    );
    try {
      const payload = await proxyBridge.loadSessionBody(sessionId, true);
      if (
        currentSessionIdRef.current === sessionId &&
        respLoadTokenRef.current === token
      ) {
        setLoadedRespEntry({ sessionId, payload });
      }
    } catch (err) {
      if (
        currentSessionIdRef.current === sessionId &&
        respLoadTokenRef.current === token
      ) {
        setRespBodyErrorEntry({
          sessionId,
          message:
            err instanceof Error
              ? err.message
              : String(err ?? "Не удалось загрузить тело ответа из SQLite"),
        });
      }
    } finally {
      setLoadingRespState((prev) =>
        prev?.sessionId === sessionId && prev?.token === token ? null : prev
      );
    }
  }, [detail?.summary.id, loadingRespBody]);

  const handleLoadRequestBody = useCallback(async () => {
    const sessionId = detail?.summary.id;
    if (sessionId == null || loadingReqBody) return;
    const token = ++reqLoadTokenRef.current;
    setLoadingReqState({ sessionId, token });
    setReqBodyErrorEntry((prev) =>
      prev?.sessionId === sessionId ? null : prev
    );
    try {
      const payload = await proxyBridge.loadSessionBody(sessionId, false);
      if (
        currentSessionIdRef.current === sessionId &&
        reqLoadTokenRef.current === token
      ) {
        setLoadedReqEntry({ sessionId, payload });
      }
    } catch (err) {
      if (
        currentSessionIdRef.current === sessionId &&
        reqLoadTokenRef.current === token
      ) {
        setReqBodyErrorEntry({
          sessionId,
          message:
            err instanceof Error
              ? err.message
              : String(err ?? "Не удалось загрузить тело запроса из SQLite"),
        });
      }
    } finally {
      setLoadingReqState((prev) =>
        prev?.sessionId === sessionId && prev?.token === token ? null : prev
      );
    }
  }, [detail?.summary.id, loadingReqBody]);

  const monacoTheme = getMonacoThemeName(resolvedTheme);

  useEffect(() => {
    if (externalHexTrigger > 0) {
      setRespTab("hex");
      if (
        !effectiveDetail?.responseBodyBase64 &&
        !effectiveDetail?.bodyOffloaded &&
        (effectiveDetail?.requestBodyBase64 ||
          effectiveDetail?.requestBodyOffloaded)
      ) {
        setReqTab("hex");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalHexTrigger]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !effectiveDetail) return;

      const ctrlOrMeta = e.ctrlKey || e.metaKey;
      if (!ctrlOrMeta || e.altKey || e.shiftKey) return;

      const digitMatch = /^Digit([1-6])$/.exec(e.code);
      const keyNum =
        e.key >= "1" && e.key <= "6"
          ? Number(e.key)
          : digitMatch
            ? Number(digitMatch[1])
            : null;
      if (keyNum === null) return;

      if (
        typeof document !== "undefined" &&
        document.querySelector("dialog[open]")
      ) {
        return;
      }

      const targetEl = (
        e.target instanceof HTMLElement ? e.target : document.activeElement
      ) as HTMLElement | null;

      if (
        targetEl &&
        (targetEl.isContentEditable ||
          targetEl.closest(
            "input, textarea, select, [contenteditable], .monaco-editor, [popover]"
          ))
      ) {
        return;
      }

      const inInspector = Boolean(
        targetEl && resolvedContainerRef.current?.contains(targetEl)
      );
      const inTrafficGrid = Boolean(targetEl?.closest('[role="grid"]'));
      const onRootFallback =
        !targetEl ||
        targetEl === document.body ||
        targetEl === document.documentElement;

      if (!inInspector && !inTrafficGrid && !onRootFallback) {
        return;
      }

      const isRequestPane = activePane === "request";
      let nextTab: InspectorTab;
      switch (keyNum) {
        case 1:
          nextTab = "headers";
          break;
        case 2: {
          if (isRequestPane) {
            const hasReqJson =
              tryFormatJson(effectiveDetail.requestBodyText).valid ||
              (Boolean(effectiveDetail.requestBodyOffloaded) &&
                effectiveDetail.requestHeaders.some(
                  (h) =>
                    h.name.toLowerCase() === "content-type" &&
                    h.value.toLowerCase().includes("json")
                ));
            nextTab = hasReqJson ? "json" : "raw";
          } else {
            const hasRespJson =
              tryFormatJson(effectiveDetail.responseBodyText).valid ||
              (Boolean(effectiveDetail.bodyOffloaded) &&
                effectiveDetail.summary.contentType
                  .toLowerCase()
                  .includes("json"));
            nextTab = hasRespJson ? "json" : "raw";
          }
          break;
        }
        case 3:
          nextTab =
            isRequestPane && reqTab === "cookies" ? "params" : "cookies";
          break;
        case 4:
          nextTab = "auth";
          break;
        case 5:
          nextTab = "raw";
          break;
        case 6:
          nextTab = "hex";
          break;
        default:
          return;
      }

      e.preventDefault();
      if (isRequestPane) {
        setReqTab(nextTab);
      } else {
        setRespTab(nextTab);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePane, effectiveDetail, reqTab, resolvedContainerRef]);

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
    () => (effectiveDetail ? parseQueryParams(effectiveDetail.summary.url) : []),
    [effectiveDetail]
  );
  const reqCookies = useMemo(
    () =>
      effectiveDetail
        ? parseCookies(effectiveDetail.requestHeaders, false)
        : [],
    [effectiveDetail]
  );
  const respCookies = useMemo(
    () =>
      effectiveDetail
        ? parseCookies(effectiveDetail.responseHeaders, true)
        : [],
    [effectiveDetail]
  );

  const authSummary = useMemo(
    () => (effectiveDetail ? analyzeAuth(effectiveDetail) : null),
    [effectiveDetail]
  );
  const cacheSummary = useMemo(
    () => (effectiveDetail ? analyzeCaching(effectiveDetail) : null),
    [effectiveDetail]
  );

  const hasReqMultipart = useMemo(
    () =>
      effectiveDetail
        ? hasMultipartOrFormPayload(
            effectiveDetail.requestHeaders,
            effectiveDetail.requestBodyBase64
          )
        : false,
    [effectiveDetail]
  );
  const hasReqProto = useMemo(
    () =>
      effectiveDetail
        ? hasProtobufOrGrpcContentType(effectiveDetail.requestHeaders)
        : false,
    [effectiveDetail]
  );
  const hasRespProto = useMemo(
    () =>
      effectiveDetail
        ? hasProtobufOrGrpcContentType(effectiveDetail.responseHeaders)
        : false,
    [effectiveDetail]
  );
  const isSse = useMemo(
    () => (effectiveDetail ? isSseSession(effectiveDetail) : false),
    [effectiveDetail]
  );
  const mergedWsFrames = useMemo<WebSocketFrameRecord[]>(() => {
    const base = effectiveDetail?.websocketFrames ?? [];
    if (
      !effectiveDetail ||
      !extraWsFramesEntry ||
      extraWsFramesEntry.sessionId !== effectiveDetail.summary.id
    ) {
      return base;
    }
    const seen = new Set(base.map((f) => f.index));
    const extras = extraWsFramesEntry.frames.filter((f) => !seen.has(f.index));
    if (extras.length === 0) return base;
    return [...base, ...extras].sort((a, b) => a.index - b.index);
  }, [effectiveDetail, extraWsFramesEntry]);

  const handleFrameInjected = useCallback(
    (frame: WebSocketFrameRecord) => {
      if (!effectiveDetail) return;
      const targetId = effectiveDetail.summary.id;
      setExtraWsFramesEntry((prev) => {
        const existing = prev && prev.sessionId === targetId ? prev.frames : [];
        if (existing.some((f) => f.index === frame.index)) return prev;
        return { sessionId: targetId, frames: [...existing, frame] };
      });
    },
    [effectiveDetail]
  );

  const wsCount = mergedWsFrames.length;

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
    } else if (
      detail.summary.wsOpen === true ||
      detail.websocketFrames.length > 0 ||
      detail.summary.scheme === "ws" ||
      detail.summary.scheme === "wss"
    ) {
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

  const multiSelectCount = selectedSessions?.length ?? 0;

  if (!detail && multiSelectCount >= 2 && inspectorMode === "statistics") {
    return (
      <div
        ref={resolvedContainerRef}
        tabIndex={-1}
        onKeyDown={handleContainerKeyDown}
        aria-label="Session Inspector Statistics"
        className="pane-contain flex h-full flex-col bg-surface focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50"
      >
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-hairline bg-elevated/60 px-2.5">
          <span className="font-mono text-xs font-semibold text-fg">
            Selected {multiSelectCount} sessions
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <div
              role="group"
              aria-label="Inspector View Mode"
              className="inline-flex rounded border border-hairline bg-surface p-0.5 text-[10px]"
            >
              <button
                type="button"
                onClick={() => setInspectorMode("inspectors")}
                aria-pressed={false}
                className="rounded px-1.5 py-0.5 text-muted hover:text-fg"
              >
                Inspectors
              </button>
              <button
                type="button"
                onClick={() => setInspectorMode("statistics")}
                aria-pressed={true}
                className="inline-flex items-center gap-1 rounded bg-elevated px-1.5 py-0.5 font-semibold text-accent"
              >
                <BarChart2 className="h-3 w-3" aria-hidden="true" />
                <span>Statistics ({multiSelectCount})</span>
              </button>
            </div>
            {onCollapseInspector && (
              <button
                type="button"
                onClick={onCollapseInspector}
                title="Collapse Session Inspector"
                className="rounded border border-hairline bg-surface p-1 text-muted hover:text-fg"
              >
                {inspectorPosition === "bottom" ? (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <SessionStatisticsPanel
            detail={null}
            selectedSessions={selectedSessions}
            onSelectSession={onSelectSession}
          />
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div
        ref={resolvedContainerRef}
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

  if (!effectiveDetail) {
    return null;
  }

  const { summary } = effectiveDetail;
  const responseMime = summary.contentType.split(";")[0].trim().toLowerCase();
  const isSafeRasterImage = SAFE_RASTER_IMAGE_MIMES.has(responseMime);
  const isSvgImage = responseMime === "image/svg+xml";
  const isImage = isSafeRasterImage || isSvgImage;
  const isReqOffloaded = Boolean(effectiveDetail.requestBodyOffloaded);
  const isRespOffloaded = Boolean(effectiveDetail.bodyOffloaded);
  const isInFlightPending =
    summary.status === 0 &&
    !summary.breakpointPaused &&
    !summary.error &&
    !summary.tlsBypassed;

  const respStatusColor = isInFlightPending
    ? "animate-pulse text-accent"
    : summary.status >= 500 || summary.status === 502 || summary.status === 504
      ? "text-status5xx-fg"
      : summary.status >= 400
        ? "text-status4xx-fg"
        : summary.status === 101
          ? "text-statusWs-fg"
          : summary.status >= 300
            ? "text-status3xx-fg"
            : "text-status2xx-fg";

  return (
    <div
      ref={resolvedContainerRef}
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
          {summary.remappedTo && (
            <span
              title={`Virtual DNS / HOSTS Remapping: трафик перенаправлен на ${summary.remappedTo}`}
              className="hidden rounded border border-accent/40 bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-accent lg:inline"
            >
              HOSTS → {summary.remappedTo}
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
          <div
            role="group"
            aria-label="Inspector View Mode"
            className="inline-flex shrink-0 rounded border border-hairline bg-surface p-0.5 text-[10px]"
          >
            <button
              type="button"
              onClick={() => setInspectorMode("inspectors")}
              aria-pressed={inspectorMode === "inspectors"}
              className={`rounded px-1.5 py-0.5 transition-colors ${
                inspectorMode === "inspectors"
                  ? "bg-elevated font-semibold text-fg"
                  : "text-muted hover:text-fg"
              }`}
            >
              Inspectors
            </button>
            <button
              type="button"
              onClick={() => setInspectorMode("statistics")}
              aria-pressed={inspectorMode === "statistics"}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors ${
                inspectorMode === "statistics"
                  ? "bg-elevated font-semibold text-accent"
                  : "text-muted hover:text-fg"
              }`}
            >
              <BarChart2 className="h-3 w-3" aria-hidden="true" />
              <span>
                Statistics
                {multiSelectCount >= 2 ? ` (${multiSelectCount})` : ""}
              </span>
            </button>
          </div>
          {isInFlightPending ? (
            <span className="hidden animate-pulse font-mono text-accent tabular-nums lg:inline">
              Pending...
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setInspectorMode("statistics")}
              title="Открыть статистику запроса и пофазные тайминги (Statistics)"
              className="hidden rounded px-1.5 py-0.5 font-mono text-muted tabular-nums transition-colors hover:bg-surface hover:text-accent lg:inline"
            >
              {`${formatBytes(summary.bodySize)} • ${formatDuration(summary.durationMs)}`}
            </button>
          )}
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
            title="Edit & Replay session in Composer (E)"
            className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-1.5 py-0.5 text-[11px] text-muted hover:border-strong hover:text-fg"
          >
            <Send className="h-3 w-3" aria-hidden="true" />
            <span className="hidden xl:inline">Composer</span>
            <kbd
              aria-hidden="true"
              className="hidden rounded border border-hairline bg-elevated px-1 font-mono text-[9px] text-subtle xl:inline"
            >
              E
            </kbd>
          </button>
          <button
            type="button"
            onClick={handleToggleSplitDirection}
            title={
              inspectorSplitDirection
                ? `Toggle Request/Response Split Orientation (${effectiveSplitDirection}, mode: ${inspectorSplitDirection})`
                : "Toggle Request/Response Split Orientation"
            }
            className="rounded border border-hairline bg-surface p-1 text-muted hover:text-fg"
          >
            {effectiveSplitDirection === "vertical" ? (
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

      {effectiveDetail.responseHeaders.some(
        (h) =>
          h.name.toLowerCase() === "x-fluxproxy-error" &&
          h.value.trim().toLowerCase() === "upstream-response-timeout"
      ) && (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-status4xx-fg/40 bg-status4xx-bg px-3 py-1.5 text-xs text-status4xx-fg"
        >
          <div className="flex min-w-0 items-start gap-2">
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <span className="font-semibold">
                Upstream Response Timeout (TTFB):
              </span>{" "}
              <span className="text-[11px]">
                Соединение установлено, но сервер не прислал заголовки ответа в
                течение настроенного лимита. Увеличьте лимит или выберите{" "}
                <code className="font-mono font-semibold">Unlimited (0)</code>,
                чтобы видеть реальные медленные ответы сервера.
              </span>
            </div>
          </div>
          {onOpenTimeoutSettings && (
            <button
              type="button"
              onClick={onOpenTimeoutSettings}
              className="inline-flex shrink-0 items-center gap-1 rounded border border-status4xx-fg/50 bg-surface/90 px-2 py-1 text-[11px] font-medium text-fg transition-colors hover:border-strong hover:bg-hover"
            >
              <Clock className="h-3 w-3 text-accent" aria-hidden="true" />
              <span>Настроить таймауты</span>
            </button>
          )}
        </div>
      )}

      {inspectorMode === "statistics" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <SessionStatisticsPanel
            detail={effectiveDetail}
            selectedSessions={selectedSessions}
            onSelectSession={onSelectSession}
          />
        </div>
      ) : (
      <PanelGroup
        ref={inspectorGroupRef}
        autoSaveId={FLUX_PANEL_AUTOSAVE_IDS.inspectorSplit}
        storage={SAFE_PANEL_STORAGE}
        direction={effectiveSplitDirection}
        className="flex-1 overflow-hidden"
      >
        {/* REQUEST PANE */}
        <Panel
          id="inspector-req-pane"
          order={1}
          defaultSize={44}
          minSize={20}
          className="overflow-hidden"
        >
          <div
            data-inspector-pane="request"
            onFocusCapture={() => setActivePane("request")}
            onPointerDownCapture={() => setActivePane("request")}
            className="flex h-full flex-col overflow-hidden"
          >
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
            <div className="flex shrink-0 items-center gap-1">
              {isReqOffloaded && (
                <button
                  type="button"
                  onClick={() => void handleLoadRequestBody()}
                  disabled={loadingReqBody}
                  title="Тело запроса (> 2 МБ) выгружено в SQLite для защиты от OOM — нажмите для подгрузки"
                  className="inline-flex items-center gap-1 rounded border border-status4xx-fg/35 bg-status4xx-bg px-1.5 py-0.5 font-mono text-[10px] text-status4xx-fg hover:brightness-110 disabled:opacity-60"
                >
                  {loadingReqBody ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <Database className="h-2.5 w-2.5" />
                  )}
                  <span>Offloaded (&gt;2 MB)</span>
                </button>
              )}
              {onSaveBodyFile && (
                <button
                  type="button"
                  onClick={() => onSaveBodyFile(summary.id, false)}
                  title="Save Request Body As..."
                  aria-label="Save Request Body As..."
                  className="shrink-0 rounded p-1 text-subtle hover:bg-elevated hover:text-fg"
                >
                  <Download className="h-3 w-3" />
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard?.writeText(
                    buildRawHttpRequest(effectiveDetail)
                  )
                }
                title="Copy Raw Request"
                className="shrink-0 rounded p-1 text-subtle hover:text-fg"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-hidden bg-canvas">
            {reqTab === "headers" && (
              <KeyValueTable
                items={effectiveDetail.requestHeaders}
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
                detail={effectiveDetail}
                onOpenTextWizard={onOpenTextWizard}
              />
            )}
            {reqTab === "multipart" &&
              (isReqOffloaded ? (
                <OffloadedBodyNotice
                  kind="request"
                  loading={loadingReqBody}
                  error={reqBodyError}
                  onLoad={() => void handleLoadRequestBody()}
                />
              ) : (
                <MultipartInspectorPanel
                  headers={effectiveDetail.requestHeaders}
                  bodyBase64={effectiveDetail.requestBodyBase64}
                  bodyText={effectiveDetail.requestBodyText}
                />
              ))}
            {reqTab === "protobuf" &&
              (isReqOffloaded ? (
                <OffloadedBodyNotice
                  kind="request"
                  loading={loadingReqBody}
                  error={reqBodyError}
                  onLoad={() => void handleLoadRequestBody()}
                />
              ) : (
                <ProtobufGrpcPanel
                  headers={effectiveDetail.requestHeaders}
                  bodyBase64={effectiveDetail.requestBodyBase64}
                  monacoTheme={monacoTheme}
                />
              ))}
            {reqTab === "raw" &&
              (isReqOffloaded ? (
                <OffloadedBodyNotice
                  kind="request"
                  loading={loadingReqBody}
                  error={reqBodyError}
                  onLoad={() => void handleLoadRequestBody()}
                />
              ) : (
                <Editor
                  height="100%"
                  language="http"
                  theme={monacoTheme}
                  loading={<EditorLoadingIndicator />}
                  value={buildRawHttpRequest(effectiveDetail)}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    fontSize: 12,
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                  }}
                />
              ))}
            {reqTab === "json" &&
              (isReqOffloaded ? (
                <OffloadedBodyNotice
                  kind="request"
                  loading={loadingReqBody}
                  error={reqBodyError}
                  onLoad={() => void handleLoadRequestBody()}
                />
              ) : (
                <Editor
                  height="100%"
                  language="json"
                  theme={monacoTheme}
                  loading={<EditorLoadingIndicator />}
                  value={
                    tryFormatJson(effectiveDetail.requestBodyText).formatted ||
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
              ))}
            {reqTab === "xml" &&
              (isReqOffloaded ? (
                <OffloadedBodyNotice
                  kind="request"
                  loading={loadingReqBody}
                  error={reqBodyError}
                  onLoad={() => void handleLoadRequestBody()}
                />
              ) : (
                <Editor
                  height="100%"
                  language="xml"
                  theme={monacoTheme}
                  loading={<EditorLoadingIndicator />}
                  value={
                    effectiveDetail.requestBodyText ||
                    "<!-- Empty request body -->"
                  }
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    fontSize: 12,
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                  }}
                />
              ))}
            {reqTab === "hex" &&
              (isReqOffloaded ? (
                <OffloadedBodyNotice
                  kind="request"
                  loading={loadingReqBody}
                  error={reqBodyError}
                  onLoad={() => void handleLoadRequestBody()}
                />
              ) : (
                <HexViewer base64Data={effectiveDetail.requestBodyBase64} />
              ))}
          </div>
          </div>
        </Panel>

        <PanelResizeHandle
          onDoubleClick={handleResetInspectorSplit}
          title="Double-click to reset Request/Response split"
          className={
            effectiveSplitDirection === "vertical"
              ? "h-1 w-full bg-hairline transition-colors hover:bg-accent/60"
              : "h-full w-1 bg-hairline transition-colors hover:bg-accent/60"
          }
        />

        {/* RESPONSE PANE */}
        <Panel
          id="inspector-resp-pane"
          order={2}
          defaultSize={56}
          minSize={20}
          className="overflow-hidden"
        >
          <div
            data-inspector-pane="response"
            onFocusCapture={() => setActivePane("response")}
            onPointerDownCapture={() => setActivePane("response")}
            className="flex h-full flex-col overflow-hidden"
          >
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-hairline bg-surface px-2">
            <div className="flex items-center gap-0.5 overflow-x-auto">
              <span
                className={`mr-1.5 shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider ${respStatusColor}`}
              >
                Response (
                {isInFlightPending ? "Pending..." : summary.status || "WAIT"})
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
                          ? ` (${effectiveDetail.sseEvents?.length || "•"})`
                          : t.id === "ws" && (wsCount > 0 || summary.wsOpen)
                            ? summary.wsOpen
                              ? wsCount > 0
                                ? ` (${wsCount} · LIVE)`
                                : " (LIVE)"
                              : ` (${wsCount})`
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
            <div className="flex shrink-0 items-center gap-1">
              {isRespOffloaded && (
                <button
                  type="button"
                  onClick={() => void handleLoadResponseBody()}
                  disabled={loadingRespBody}
                  title={`Тело ответа (${formatBytes(summary.bodySize)}) выгружено в SQLite для защиты от OOM — нажмите для ленивой подгрузки`}
                  className="inline-flex items-center gap-1 rounded border border-status4xx-fg/35 bg-status4xx-bg px-1.5 py-0.5 font-mono text-[10px] text-status4xx-fg hover:brightness-110 disabled:opacity-60"
                >
                  {loadingRespBody ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <Database className="h-2.5 w-2.5" />
                  )}
                  <span>Offloaded ({formatBytes(summary.bodySize)})</span>
                </button>
              )}
              {onSaveBodyFile && (
                <button
                  type="button"
                  onClick={() => onSaveBodyFile(summary.id, true)}
                  title="Save Response Body As..."
                  aria-label="Save Response Body As..."
                  className="shrink-0 rounded p-1 text-subtle hover:bg-elevated hover:text-fg"
                >
                  <Download className="h-3 w-3" />
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard?.writeText(
                    effectiveDetail.responseBodyText ??
                      buildRawHttpResponse(effectiveDetail)
                  )
                }
                title="Copy Response Body"
                className="shrink-0 rounded p-1 text-subtle hover:text-fg"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-hidden bg-canvas">
            {isInFlightPending ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/10 ring-1 ring-accent/30">
                  <Loader2
                    className="h-4 w-4 animate-spin text-accent"
                    aria-hidden="true"
                  />
                </div>
                <div className="max-w-xs space-y-1">
                  <div className="text-xs font-semibold text-fg">
                    Ожидание ответа от сервера (In-Flight)...
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted">
                    Запрос отправлен в upstream. Заголовки и тело ответа появятся
                    автоматически сразу после получения ответа.
                  </p>
                </div>
              </div>
            ) : (
              <>
                {respTab === "headers" && (
              <KeyValueTable
                items={effectiveDetail.responseHeaders}
                emptyLabel="No response headers"
              />
            )}
            {respTab === "cookies" && (
              <CookiesTable
                items={respCookies}
                emptyLabel="No Set-Cookie headers in response"
              />
            )}
            {respTab === "caching" && (
              <CachingInspectorPanel detail={effectiveDetail} />
            )}
            {respTab === "auth" && (
              <AuthInspectorPanel
                detail={effectiveDetail}
                onOpenTextWizard={onOpenTextWizard}
              />
            )}
            {respTab === "sse" && (
              <SseInspectorPanel
                detail={effectiveDetail}
                monacoTheme={monacoTheme}
              />
            )}
            {respTab === "ws" && (
              <WebSocketFramesPanel
                frames={mergedWsFrames}
                sessionId={effectiveDetail.summary.id}
                isWsOpen={Boolean(effectiveDetail.summary.wsOpen)}
                onFrameInjected={handleFrameInjected}
              />
            )}
            {respTab === "protobuf" &&
              (isRespOffloaded ? (
                <OffloadedBodyNotice
                  kind="response"
                  sizeBytes={summary.bodySize}
                  loading={loadingRespBody}
                  error={respBodyError}
                  onLoad={() => void handleLoadResponseBody()}
                />
              ) : (
                <ProtobufGrpcPanel
                  headers={effectiveDetail.responseHeaders}
                  bodyBase64={effectiveDetail.responseBodyBase64}
                  monacoTheme={monacoTheme}
                />
              ))}
            {respTab === "raw" &&
              (isRespOffloaded ? (
                <OffloadedBodyNotice
                  kind="response"
                  sizeBytes={summary.bodySize}
                  loading={loadingRespBody}
                  error={respBodyError}
                  onLoad={() => void handleLoadResponseBody()}
                />
              ) : (
                <Editor
                  height="100%"
                  language="http"
                  theme={monacoTheme}
                  loading={<EditorLoadingIndicator />}
                  value={buildRawHttpResponse(effectiveDetail)}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    fontSize: 12,
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                  }}
                />
              ))}
            {respTab === "json" &&
              (isRespOffloaded ? (
                <OffloadedBodyNotice
                  kind="response"
                  sizeBytes={summary.bodySize}
                  loading={loadingRespBody}
                  error={respBodyError}
                  onLoad={() => void handleLoadResponseBody()}
                />
              ) : (
                <Editor
                  height="100%"
                  language="json"
                  theme={monacoTheme}
                  loading={<EditorLoadingIndicator />}
                  value={
                    tryFormatJson(effectiveDetail.responseBodyText).formatted ||
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
              ))}
            {respTab === "xml" &&
              (isRespOffloaded ? (
                <OffloadedBodyNotice
                  kind="response"
                  sizeBytes={summary.bodySize}
                  loading={loadingRespBody}
                  error={respBodyError}
                  onLoad={() => void handleLoadResponseBody()}
                />
              ) : (
                <Editor
                  height="100%"
                  language="xml"
                  theme={monacoTheme}
                  loading={<EditorLoadingIndicator />}
                  value={
                    effectiveDetail.responseBodyText ||
                    "<!-- Empty response payload -->"
                  }
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    fontSize: 12,
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                  }}
                />
              ))}
            {respTab === "image" &&
              (isRespOffloaded ? (
                <OffloadedBodyNotice
                  kind="response"
                  sizeBytes={summary.bodySize}
                  loading={loadingRespBody}
                  error={respBodyError}
                  onLoad={() => void handleLoadResponseBody()}
                />
              ) : isSafeRasterImage && effectiveDetail.responseBodyBase64 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto p-4 checkerboard-bg">
                  <img
                    src={`data:${responseMime};base64,${effectiveDetail.responseBodyBase64}`}
                    alt={summary.path}
                    className="max-h-[75%] max-w-[90%] rounded border border-strong shadow-popover"
                  />
                  <span className="rounded bg-surface/90 px-2.5 py-1 font-mono text-[11px] text-muted ring-1 ring-hairline">
                    {summary.contentType} • {formatBytes(summary.bodySize)}
                  </span>
                </div>
              ) : isSvgImage ? (
                <div className="flex h-full flex-col overflow-hidden bg-surface">
                  <div className="flex shrink-0 items-center justify-between border-b border-hairline bg-status4xx-bg/40 px-3 py-1.5 text-[11px] text-status4xx-fg">
                    <span>
                      SVG-изображение (<code>image/svg+xml</code>) отображается как безопасный текстовый исходник во избежание активного содержимого / XSS.
                    </span>
                    <span className="font-mono text-muted">
                      {formatBytes(summary.bodySize)}
                    </span>
                  </div>
                  <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-fg select-text">
                    {effectiveDetail.responseBodyText ??
                      (effectiveDetail.responseBodyBase64
                        ? new TextDecoder().decode(
                            decodeBase64ToBytes(effectiveDetail.responseBodyBase64)
                          )
                        : "<!-- Empty SVG payload -->")}
                  </pre>
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto p-4 checkerboard-bg">
                  <span className="rounded bg-surface/90 px-3 py-1.5 text-xs text-muted ring-1 ring-hairline">
                    {isImage
                      ? `Нет бинарных данных изображения для ${summary.contentType}.`
                      : `Response Content-Type (${summary.contentType}) is not an image.`}
                  </span>
                </div>
              ))}
            {respTab === "hex" &&
              (isRespOffloaded ? (
                <OffloadedBodyNotice
                  kind="response"
                  sizeBytes={summary.bodySize}
                  loading={loadingRespBody}
                  error={respBodyError}
                  onLoad={() => void handleLoadResponseBody()}
                />
              ) : (
                <HexViewer base64Data={effectiveDetail.responseBodyBase64} />
              ))}
              </>
            )}
          </div>
          </div>
        </Panel>
      </PanelGroup>
      )}
    </div>
  );
};

const EditorLoadingIndicator: React.FC = () => (
  <div className="flex h-full w-full items-center justify-center gap-2 text-xs text-muted">
    <Loader2 className="h-4 w-4 animate-spin text-accent" />
    <span>Загрузка редактора...</span>
  </div>
);

const OffloadedBodyNotice: React.FC<{
  kind: "request" | "response";
  sizeBytes?: number;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
}> = ({ kind, sizeBytes, loading, error, onLoad }) => {
  const label = kind === "response" ? "ответа" : "запроса";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full border border-status4xx-fg/35 bg-status4xx-bg text-status4xx-fg">
        <Database className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="max-w-md space-y-1">
        <p className="text-xs font-semibold text-fg">
          Тяжёлое тело {label}
          {sizeBytes && sizeBytes > 0 ? ` (${formatBytes(sizeBytes)})` : " (> 2 МБ)"}{" "}
          выгружено в SQLite
        </p>
        <p className="text-[11px] leading-relaxed text-muted">
          Для абсолютной защиты от Out Of Memory (OOM) полезная нагрузка свыше 2 МБ
          не удерживается в оперативной памяти и подгружается лениво по требованию.
        </p>
      </div>
      {error && (
        <p className="max-w-md rounded border border-status5xx-fg/40 bg-status5xx-bg px-2.5 py-1 font-mono text-[11px] text-status5xx-fg">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onLoad}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded border border-accent/50 bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/25 disabled:cursor-wait disabled:opacity-60"
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span>
          {loading ? "Загрузка из SQLite..." : `Загрузить тело ${label}`}
        </span>
      </button>
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
