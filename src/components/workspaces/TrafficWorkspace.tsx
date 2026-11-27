import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Activity, BarChart3, BarChartHorizontal, Table2 } from "lucide-react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import { useContextMenu, type ContextMenuEventLike } from "../../hooks/useContextMenu";
import {
  useFilteredSessions,
  useSessionDetailSync,
} from "../../hooks/useProxySessions";
import { useTheme } from "../../hooks/useTheme";
import {
  FLUX_PANEL_AUTOSAVE_IDS,
  FLUX_PANEL_LAYOUT_RESET_EVENT,
  SAFE_PANEL_STORAGE,
  useUiPreferences,
} from "../../hooks/useUiPreferences";
import {
  buildInspectorChromeContextMenu,
  buildTrafficEmptyContextMenu,
  buildTrafficRowContextMenu,
} from "../../lib/contextMenuBuilders";
import { useFilterStore } from "../../stores/filterStore";
import { findSessionById, useProxyStore } from "../../stores/proxyStore";
import type {
  HeaderMutationDirection,
  HeaderMutationOp,
  SessionSummary,
} from "../../types/proxy";
import type { BreakpointsPanelMode } from "../BreakpointsPanel";
import { CollapsedInspectorBar } from "../CollapsedInspectorBar";
import { SessionInspector } from "../SessionInspector";
import type { TextWizardTab } from "../TextWizardPanel";
import { TrafficGrid } from "../TrafficGrid";
import type { TrafficStatisticsScope } from "../TrafficStatisticsModal";
import { WaterfallTimeline } from "../WaterfallTimeline";
import { SectionHeader } from "../ui/SectionHeader";

const SessionDiffView = React.lazy(() =>
  import("../SessionDiffView").then((m) => ({
    default: m.SessionDiffView,
  }))
);

export interface TrafficWorkspaceProps {
  isActive: boolean;
  trafficViewMode: "grid" | "waterfall";
  onSetTrafficViewMode: (mode: "grid" | "waterfall") => void;
  trafficGridRef: React.RefObject<HTMLDivElement>;
  inspectorContainerRef: React.RefObject<HTMLDivElement>;
  sortedSessionsRef: React.MutableRefObject<SessionSummary[]>;
  hasAnyActiveFilter: boolean;
  inlineDiffDismissed: boolean;
  onDismissInlineDiff: () => void;
  onResumePairDiff: () => void;
  hexTriggerSeq: number;
  statisticsTriggerSeq: number;
  onTriggerStatistics: () => void;
  onResetPanelLayout: () => void;
  // Controller & App callbacks
  setSelectedId: (id: number | null) => void;
  toggleSessionSelection: (id: number) => void;
  selectSessionRange: (targetId: number, ordered?: SessionSummary[]) => void;
  selectSessions: (ids: number[]) => void;
  compareWithSession: (targetId: number) => void;
  swapCompareSessions: () => void;
  deleteSessions: (ids: number[]) => Promise<void>;
  replaySessions: (ids: number[]) => Promise<void>;
  unmarkSessions: (ids: number[]) => Promise<void>;
  saveSessionBodyAs: (sessionId: number, isResponse: boolean) => Promise<void>;
  exportSelectedSessionsAs: (
    explicitIds?: number[],
    forcedFormat?: "har" | "saz" | "json" | "raw"
  ) => Promise<void>;
  exportAllSessionsAs: (forcedFormat?: "har" | "saz" | "json") => Promise<void>;
  clearAllSessions: () => Promise<void>;
  importArchiveDialog: () => Promise<void>;
  toggleProxy: () => Promise<void>;
  applyQuickExecBpu: (
    stage: "request" | "response",
    pattern: string
  ) => Promise<void>;
  quickFilterByProcess: (
    processName: string,
    action?: "include" | "exclude"
  ) => void;
  quickFilterByClientIp: (
    clientIp: string,
    action?: "include" | "exclude"
  ) => void;
  addLanClientToAllowlist: (clientIp: string) => Promise<void>;
  quickAlwaysInspectHost: (hostOrPattern: string) => Promise<void>;
  quickAlwaysPassthroughHost: (hostOrPattern: string) => Promise<void>;
  quickAddTlsBypassHost: (hostOrPattern: string) => Promise<void>;
  showToast: (msg: string) => void;
  onOpenBreakpointsAt: (mode: BreakpointsPanelMode, bpId?: string) => void;
  onOpenTrafficStatisticsModal: (scope?: TrafficStatisticsScope) => void;
  onFocusTrafficGrid: () => void;
  onFocusInspector: () => void;
  onOpenStatisticsForSession: (sessionId: number) => void;
  onOpenStatistics: () => void;
  onCopyUrlsForIds: (ids: number[]) => void;
  onCopySessionAsCurl: (sessionId: number) => Promise<void>;
  onOpenCodeGeneratorForSession: (sessionId: number) => Promise<void>;
  onCopySessionHeaders: (
    sessionId: number,
    kind: "request" | "response"
  ) => Promise<void>;
  onOpenDiffWithPairSmart: (anchorSessionId?: number) => void;
  onSelectDiffTabPair: (leftId: number, rightId: number) => void;
  onSwapDiffTabPair: () => void;
  onExpandDiffTab: () => void;
  onOpenAnnotationFor: (ids: number[]) => void;
  onLoadSessionIntoComposer: (sessionId: number) => Promise<void>;
  onCreateRuleFromSession: (session: SessionSummary) => Promise<void>;
  onOpenOpenApiModal: (explicitIds?: number[]) => void;
  onFilterByHost: (host: string) => void;
  onFilterByStatus: (statusCode: number) => void;
  onQuickFilterByQuery: (query: string) => void;
  onAddHeaderMutationRule: (
    direction: HeaderMutationDirection,
    operation: HeaderMutationOp,
    headerName: string,
    headerValue: string,
    host?: string
  ) => Promise<void>;
  onResetAllTrafficFilters: () => void;
  onOpenTextWizardAt: (tab: TextWizardTab, input?: string) => void;
  onOpenTimeoutSettings: () => void;
}

export const TrafficWorkspace: React.FC<TrafficWorkspaceProps> = ({
  isActive,
  trafficViewMode,
  onSetTrafficViewMode,
  trafficGridRef,
  inspectorContainerRef,
  sortedSessionsRef,
  hasAnyActiveFilter,
  inlineDiffDismissed,
  onDismissInlineDiff,
  onResumePairDiff,
  hexTriggerSeq,
  statisticsTriggerSeq,
  onTriggerStatistics,
  onResetPanelLayout,
  setSelectedId,
  toggleSessionSelection,
  selectSessionRange,
  selectSessions,
  compareWithSession,
  swapCompareSessions,
  deleteSessions,
  replaySessions,
  unmarkSessions,
  saveSessionBodyAs,
  exportSelectedSessionsAs,
  exportAllSessionsAs,
  clearAllSessions,
  importArchiveDialog,
  toggleProxy,
  applyQuickExecBpu,
  quickFilterByProcess,
  quickFilterByClientIp,
  addLanClientToAllowlist,
  quickAlwaysInspectHost,
  quickAlwaysPassthroughHost,
  quickAddTlsBypassHost,
  showToast,
  onOpenBreakpointsAt,
  onOpenTrafficStatisticsModal,
  onFocusTrafficGrid,
  onFocusInspector,
  onOpenStatisticsForSession,
  onOpenStatistics,
  onCopyUrlsForIds,
  onCopySessionAsCurl,
  onOpenCodeGeneratorForSession,
  onCopySessionHeaders,
  onOpenDiffWithPairSmart,
  onSelectDiffTabPair,
  onSwapDiffTabPair,
  onExpandDiffTab,
  onOpenAnnotationFor,
  onLoadSessionIntoComposer,
  onCreateRuleFromSession,
  onOpenOpenApiModal,
  onFilterByHost,
  onFilterByStatus,
  onQuickFilterByQuery,
  onAddHeaderMutationRule,
  onResetAllTrafficFilters,
  onOpenTextWizardAt,
  onOpenTimeoutSettings,
}) => {
  useSessionDetailSync();
  const { openContextMenu } = useContextMenu();
  const { resolvedTheme } = useTheme();
  const {
    inspectorCollapsed,
    inspectorPosition,
    inspectorSplitDirection,
    resolvedInspectorSplitDirection,
    visibleColumns,
    columnWidths,
    setInspectorCollapsed,
    toggleInspector,
    setInspectorPosition,
    toggleInspectorSplitDirection,
    toggleColumnVisibility,
    setColumnWidth,
    resetColumns,
  } = useUiPreferences();

  const sessions = useProxyStore((s) => s.sessions);
  const sessionIndexById = useProxyStore((s) => s.sessionIndexById);
  const selectedId = useProxyStore((s) => s.selectedId);
  const selectedIds = useProxyStore((s) => s.selectedIds);
  const selectedDetail = useProxyStore((s) => s.selectedDetail);
  const diffLeftDetail = useProxyStore((s) => s.diffLeftDetail);
  const diffRightDetail = useProxyStore((s) => s.diffRightDetail);
  const followTail = useProxyStore((s) => s.followTail);
  const setFollowTail = useProxyStore((s) => s.setFollowTail);
  const proxyRunning = useProxyStore((s) => s.status.running);
  const pausedBreakpoints = useProxyStore((s) => s.pausedBreakpoints);
  const thresholds = useFilterStore((s) => s.thresholds);

  const { filteredSessions, totalSessionsCount } = useFilteredSessions();

  const bottomInnerGroupRef = useRef<ImperativePanelGroupHandle>(null);
  const rightGroupRef = useRef<ImperativePanelGroupHandle>(null);

  const handleResetBottomInnerGroup = useCallback(() => {
    bottomInnerGroupRef.current?.setLayout(
      inspectorCollapsed ? [100] : [54, 46]
    );
  }, [inspectorCollapsed]);

  const handleResetRightGroup = useCallback(() => {
    rightGroupRef.current?.setLayout(inspectorCollapsed ? [100] : [56, 44]);
  }, [inspectorCollapsed]);

  useEffect(() => {
    const onResetPanels = () => {
      handleResetBottomInnerGroup();
      handleResetRightGroup();
    };
    window.addEventListener(FLUX_PANEL_LAYOUT_RESET_EVENT, onResetPanels);
    return () => {
      window.removeEventListener(FLUX_PANEL_LAYOUT_RESET_EVENT, onResetPanels);
    };
  }, [handleResetBottomInnerGroup, handleResetRightGroup]);

  const handleResizeHandleContextMenu = useCallback(
    (e: ContextMenuEventLike) => {
      openContextMenu(
        e,
        buildInspectorChromeContextMenu({
          inspectorCollapsed,
          inspectorPosition,
          onExpandOrCollapse: toggleInspector,
          onSetPosition: setInspectorPosition,
          onToggleSplitDirection: toggleInspectorSplitDirection,
          onResetPanelLayout,
        }),
        { ariaLabel: "Panel Layout Context Menu" }
      );
    },
    [
      inspectorCollapsed,
      inspectorPosition,
      onResetPanelLayout,
      openContextMenu,
      setInspectorPosition,
      toggleInspector,
      toggleInspectorSplitDirection,
    ]
  );

  const effectiveSelectedIds = useMemo(
    () =>
      selectedIds.length > 0
        ? selectedIds
        : selectedId !== null
          ? [selectedId]
          : [],
    [selectedId, selectedIds]
  );

  const showInlineSessionDiff =
    selectedIds.length === 2 && !inlineDiffDismissed;

  const selectedSessions = useMemo(() => {
    if (selectedIds.length === 0) return [];
    const out: SessionSummary[] = [];
    for (let i = 0; i < selectedIds.length; i += 1) {
      const match = findSessionById(sessions, sessionIndexById, selectedIds[i]);
      if (match) out.push(match);
    }
    return out;
  }, [sessionIndexById, sessions, selectedIds]);

  const selectedSummary = useMemo(
    () =>
      selectedDetail?.summary ??
      (selectedId !== null
        ? findSessionById(sessions, sessionIndexById, selectedId) ?? null
        : null),
    [selectedDetail, selectedId, sessionIndexById, sessions]
  );

  const handleWaterfallRowContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, session: SessionSummary) => {
      const isAlreadySelected = selectedIds.includes(session.id);
      if (!isAlreadySelected) {
        setSelectedId(session.id);
      }
      const targetIds =
        isAlreadySelected && selectedIds.length > 0 ? selectedIds : [session.id];

      const items = buildTrafficRowContextMenu({
        session,
        targetIds,
        selectedId,
        onReplaySessions: (ids) => void replaySessions(ids),
        onSendToComposer: (id) => void onLoadSessionIntoComposer(id),
        onCompareWithSession: (id) => {
          onResumePairDiff();
          compareWithSession(id);
        },
        onOpenDiffModal: () => onOpenDiffWithPairSmart(),
        onOpenStatistics: onOpenStatisticsForSession,
        onOpenTrafficStatistics: onOpenTrafficStatisticsModal,
        onCopyUrl: onCopyUrlsForIds,
        onCopyCurl: (id) => void onCopySessionAsCurl(id),
        onGenerateClientCode: (id) => void onOpenCodeGeneratorForSession(id),
        onCopyHeaders: (id, kind) => void onCopySessionHeaders(id, kind),
        onExportSelectedSessions: (ids, fmt) =>
          void exportSelectedSessionsAs(ids, fmt),
        onExportOpenApi: (ids) => onOpenOpenApiModal(ids),
        onSaveSessionBody: (id, isResponse) =>
          void saveSessionBodyAs(id, isResponse),
        onAnnotateSessions: onOpenAnnotationFor,
        onUnmarkSessions: (ids) => void unmarkSessions(ids),
        onCreateRuleFromSession: (s) => void onCreateRuleFromSession(s),
        onAddBreakpoint: (stage, pattern) =>
          void applyQuickExecBpu(stage, pattern),
        onFilterByHost,
        onFilterByStatus,
        onFilterByProcess: (proc) => quickFilterByProcess(proc, "include"),
        onFilterByClientIp: (ip) => quickFilterByClientIp(ip, "include"),
        onAddClientIpToAllowlist: (ip) => void addLanClientToAllowlist(ip),
        onAlwaysInspectHost: (host) => void quickAlwaysInspectHost(host),
        onAlwaysPassthroughHost: (host) =>
          void quickAlwaysPassthroughHost(host),
        onDeleteSessions: (ids) => void deleteSessions(ids),
      });

      openContextMenu(e, items, {
        ariaLabel: `Действия для сессии #${session.id}`,
        minWidth: 240,
      });
    },
    [
      addLanClientToAllowlist,
      applyQuickExecBpu,
      compareWithSession,
      deleteSessions,
      exportSelectedSessionsAs,
      onCopySessionAsCurl,
      onCopySessionHeaders,
      onCopyUrlsForIds,
      onCreateRuleFromSession,
      onFilterByHost,
      onFilterByStatus,
      onLoadSessionIntoComposer,
      onOpenAnnotationFor,
      onOpenCodeGeneratorForSession,
      onOpenDiffWithPairSmart,
      onOpenOpenApiModal,
      onOpenStatisticsForSession,
      onOpenTrafficStatisticsModal,
      onResumePairDiff,
      openContextMenu,
      quickAlwaysInspectHost,
      quickAlwaysPassthroughHost,
      quickFilterByClientIp,
      quickFilterByProcess,
      replaySessions,
      saveSessionBodyAs,
      selectedId,
      selectedIds,
      setSelectedId,
      unmarkSessions,
    ]
  );

  const handleWaterfallEmptyContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.defaultPrevented) return;
      const items = buildTrafficEmptyContextMenu({
        visibleCount: filteredSessions.length,
        totalCount: sessions.length,
        proxyRunning,
        followTail,
        hasActiveFilters: hasAnyActiveFilter,
        isWaterfallView: true,
        onSelectAllVisible: () =>
          selectSessions(filteredSessions.map((s) => s.id)),
        onOpenTrafficStatistics: () => onOpenTrafficStatisticsModal("filtered"),
        onToggleWaterfallView: () => onSetTrafficViewMode("grid"),
        onToggleCapture: () => void toggleProxy(),
        onToggleFollowTail: () => setFollowTail((v) => !v),
        onImportArchive: () => void importArchiveDialog(),
        onSaveAllSessions: () => void exportAllSessionsAs(),
        onResetFilters: onResetAllTrafficFilters,
        onResetColumns: resetColumns,
        onClearAllSessions: () => void clearAllSessions(),
      });

      openContextMenu(e, items, {
        ariaLabel: "Действия Waterfall Timeline",
        minWidth: 232,
      });
    },
    [
      clearAllSessions,
      exportAllSessionsAs,
      filteredSessions,
      followTail,
      hasAnyActiveFilter,
      importArchiveDialog,
      onOpenTrafficStatisticsModal,
      onResetAllTrafficFilters,
      onSetTrafficViewMode,
      openContextMenu,
      proxyRunning,
      resetColumns,
      selectSessions,
      sessions.length,
      setFollowTail,
      toggleProxy,
    ]
  );

  const renderTrafficGrid = () =>
    trafficViewMode === "waterfall" ? (
      <WaterfallTimeline
        sessions={filteredSessions}
        totalSessionsCount={sessions.length}
        selectedId={selectedId}
        selectedIds={selectedIds}
        onSelectSession={(id) => {
          setSelectedId(id);
          const paused = pausedBreakpoints.find((p) => p.sessionId === id);
          if (paused) {
            onOpenBreakpointsAt("intercept", paused.breakpointId);
          }
        }}
        onToggleSelectSession={toggleSessionSelection}
        onFocusInspector={onFocusInspector}
        onOpenTrafficStatistics={() => onOpenTrafficStatisticsModal("filtered")}
        onSwitchToGrid={() => onSetTrafficViewMode("grid")}
        onRowContextMenu={handleWaterfallRowContextMenu}
        onEmptyAreaContextMenu={handleWaterfallEmptyContextMenu}
        followTail={followTail}
        onDisableFollowTail={() => setFollowTail(false)}
      />
    ) : (
      <TrafficGrid
        gridRef={trafficGridRef}
        sessions={filteredSessions}
        totalSessionsCount={sessions.length}
        proxyRunning={proxyRunning}
        hasActiveFilters={hasAnyActiveFilter}
        selectedId={selectedId}
        selectedIds={selectedIds}
        visibleColumns={visibleColumns}
        columnWidths={columnWidths}
        onColumnWidthChange={setColumnWidth}
        onToggleColumnVisibility={toggleColumnVisibility}
        onResetColumns={resetColumns}
        onSelectSession={(id) => {
          setSelectedId(id);
          const paused = pausedBreakpoints.find((p) => p.sessionId === id);
          if (paused) {
            onOpenBreakpointsAt("intercept", paused.breakpointId);
          }
        }}
        onToggleSelectSession={toggleSessionSelection}
        onSelectSessionRange={selectSessionRange}
        onSelectAllSessions={selectSessions}
        onSortedSessionsChange={(list) => {
          sortedSessionsRef.current = list;
        }}
        onFocusInspector={onFocusInspector}
        onOpenStatistics={onOpenStatisticsForSession}
        onOpenTrafficStatistics={onOpenTrafficStatisticsModal}
        onToggleWaterfallView={() => onSetTrafficViewMode("waterfall")}
        onDeleteSessions={(ids) => void deleteSessions(ids)}
        onReplaySessions={(ids) => void replaySessions(ids)}
        onUnmarkSessions={(ids) => void unmarkSessions(ids)}
        onCopyUrl={onCopyUrlsForIds}
        onCopyCurl={(id) => void onCopySessionAsCurl(id)}
        onGenerateClientCode={(id) => void onOpenCodeGeneratorForSession(id)}
        onCopyHeaders={(id, kind) => void onCopySessionHeaders(id, kind)}
        onCompareWithSession={(id) => {
          onResumePairDiff();
          compareWithSession(id);
        }}
        onSwapCompare={swapCompareSessions}
        onOpenDiffModal={() => onOpenDiffWithPairSmart()}
        onAnnotateSessions={onOpenAnnotationFor}
        onSendToComposer={(id) => void onLoadSessionIntoComposer(id)}
        onCreateRuleFromSession={(s) => void onCreateRuleFromSession(s)}
        onAddBreakpoint={(stage, pattern) =>
          void applyQuickExecBpu(stage, pattern)
        }
        onExportSelectedSessions={(ids, fmt) =>
          void exportSelectedSessionsAs(ids, fmt)
        }
        onExportOpenApi={(ids) => onOpenOpenApiModal(ids)}
        onSaveSessionBody={(id, isResponse) =>
          void saveSessionBodyAs(id, isResponse)
        }
        onFilterByHost={onFilterByHost}
        onFilterByStatus={onFilterByStatus}
        onFilterByProcess={(proc) => quickFilterByProcess(proc, "include")}
        onFilterByClientIp={(ip) => quickFilterByClientIp(ip, "include")}
        onAddClientIpToAllowlist={(ip) => void addLanClientToAllowlist(ip)}
        onAlwaysInspectHost={(host) => void quickAlwaysInspectHost(host)}
        onAlwaysPassthroughHost={(host) =>
          void quickAlwaysPassthroughHost(host)
        }
        onAddHostToTlsBypass={(host) => void quickAddTlsBypassHost(host)}
        onDisableFollowTail={() => setFollowTail(false)}
        onToggleCapture={() => void toggleProxy()}
        onToggleFollowTail={() => setFollowTail((v) => !v)}
        onClearAllSessions={() => void clearAllSessions()}
        onImportArchive={() => void importArchiveDialog()}
        onSaveAllSessions={() => void exportAllSessionsAs()}
        onResetFilters={onResetAllTrafficFilters}
        onNotify={showToast}
        thresholds={thresholds}
        followTail={followTail}
      />
    );

  const renderInspectorOrDiff = () =>
    showInlineSessionDiff ? (
      <React.Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center text-xs text-muted">
            Loading Session Diff...
          </div>
        }
      >
        <SessionDiffView
          leftDetail={diffLeftDetail}
          rightDetail={diffRightDetail}
          sessions={filteredSessions.length >= 2 ? filteredSessions : sessions}
          resolvedTheme={resolvedTheme}
          defaultSideBySide
          onSelectPair={onSelectDiffTabPair}
          onSwapPair={onSwapDiffTabPair}
          onAnnotateSession={(id) => onOpenAnnotationFor([id])}
          onExpandTab={onExpandDiffTab}
          onOpenStatistics={() => {
            onDismissInlineDiff();
            onTriggerStatistics();
          }}
          onCloseDiff={onDismissInlineDiff}
          onNotify={showToast}
        />
      </React.Suspense>
    ) : (
      <SessionInspector
        detail={selectedDetail}
        selectedSessions={selectedSessions}
        onSelectSession={(id) => {
          onDismissInlineDiff();
          setSelectedId(id);
        }}
        statisticsOpenTrigger={statisticsTriggerSeq}
        resolvedTheme={resolvedTheme}
        containerRef={inspectorContainerRef}
        onReturnFocusToGrid={onFocusTrafficGrid}
        inspectorPosition={inspectorPosition}
        onChangeInspectorPosition={setInspectorPosition}
        splitDirection={resolvedInspectorSplitDirection}
        inspectorSplitDirection={inspectorSplitDirection}
        onToggleSplitDirection={toggleInspectorSplitDirection}
        onCollapseInspector={() => {
          setInspectorCollapsed(true);
          onFocusTrafficGrid();
        }}
        externalHexTrigger={hexTriggerSeq}
        onReplaySession={(id) => void replaySessions([id])}
        onSendToComposer={(id) => void onLoadSessionIntoComposer(id)}
        onCopyCurl={(id) => void onCopySessionAsCurl(id)}
        onCreateRuleFromSession={(s) => void onCreateRuleFromSession(s)}
        onFilterByHost={onFilterByHost}
        onQuickFilterByValue={onQuickFilterByQuery}
        onAddHeaderMutationRule={(dir, op, name, val, host) =>
          void onAddHeaderMutationRule(dir, op, name, val, host)
        }
        onFilterByProcess={(proc) => quickFilterByProcess(proc, "include")}
        onFilterByClientIp={(ip) => quickFilterByClientIp(ip, "include")}
        onAlwaysInspectHost={(host) => void quickAlwaysInspectHost(host)}
        onAddHostToTlsBypass={(host) => void quickAddTlsBypassHost(host)}
        onOpenTextWizard={(text, tab) => onOpenTextWizardAt(tab, text)}
        onQuickAddBpu={(pattern) => void applyQuickExecBpu("request", pattern)}
        onAnnotateSession={(id) => onOpenAnnotationFor([id])}
        onOpenDiffWithSession={(id) => onOpenDiffWithPairSmart(id)}
        canResumePairDiff={selectedIds.length === 2 && inlineDiffDismissed}
        onResumePairDiff={onResumePairDiff}
        onSaveBodyFile={(id, isResponse) =>
          void saveSessionBodyAs(id, isResponse)
        }
        onOpenTimeoutSettings={onOpenTimeoutSettings}
        onResetPanelLayout={onResetPanelLayout}
        onNotify={showToast}
      />
    );

  return (
    <div
      hidden={!isActive}
      className={
        isActive ? "flex h-full w-full flex-col overflow-hidden" : "hidden"
      }
    >
      <SectionHeader
        sectionId="traffic"
        compact
        icon={<Activity className="h-3.5 w-3.5 text-accent" />}
        badges={
          <span className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-muted ring-1 ring-hairline tabular-nums">
            {filteredSessions.length.toLocaleString()} /{" "}
            {totalSessionsCount.toLocaleString()}
          </span>
        }
        actions={
          <div className="flex items-center gap-1.5">
            <div
              role="group"
              aria-label="Traffic view mode"
              className="inline-flex items-center rounded border border-hairline bg-canvas p-0.5 text-[11px]"
            >
              <button
                type="button"
                aria-pressed={trafficViewMode === "grid"}
                onClick={() => onSetTrafficViewMode("grid")}
                title="Table Grid View"
                className={`inline-flex h-5 items-center gap-1 rounded px-1.5 font-medium transition-colors ${
                  trafficViewMode === "grid"
                    ? "bg-selected text-fg"
                    : "text-muted hover:text-fg"
                }`}
              >
                <Table2 className="h-3 w-3" aria-hidden="true" />
                <span>Grid</span>
              </button>
              <button
                type="button"
                aria-pressed={trafficViewMode === "waterfall"}
                onClick={() => onSetTrafficViewMode("waterfall")}
                title="Waterfall Timeline View"
                className={`inline-flex h-5 items-center gap-1 rounded px-1.5 font-medium transition-colors ${
                  trafficViewMode === "waterfall"
                    ? "bg-selected text-fg"
                    : "text-muted hover:text-fg"
                }`}
              >
                <BarChartHorizontal className="h-3 w-3" aria-hidden="true" />
                <span>Waterfall</span>
              </button>
            </div>
            <button
              type="button"
              disabled={filteredSessions.length === 0}
              onClick={() => onOpenTrafficStatisticsModal("filtered")}
              title="Открыть сводную статистику трафика и Markdown-отчёт"
              className="inline-flex h-6 items-center gap-1 rounded border border-hairline bg-elevated px-2 text-[11px] font-medium text-fg transition-colors hover:border-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              <BarChart3 className="h-3 w-3 text-accent" aria-hidden="true" />
              <span>Statistics</span>
            </button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        {inspectorPosition === "bottom" && (
          <div className="flex h-full w-full flex-col overflow-hidden">
            <PanelGroup
              ref={bottomInnerGroupRef}
              key="traffic-layout-bottom"
              autoSaveId={FLUX_PANEL_AUTOSAVE_IDS.bottomInner}
              storage={SAFE_PANEL_STORAGE}
              direction="vertical"
              className="min-h-0 w-full flex-1"
            >
              <Panel
                id="traffic-grid-top"
                order={1}
                defaultSize={inspectorCollapsed ? 100 : 54}
                minSize={22}
              >
                {renderTrafficGrid()}
              </Panel>
              {!inspectorCollapsed && (
                <>
                  <PanelResizeHandle
                    onDoubleClick={handleResetBottomInnerGroup}
                    onContextMenu={handleResizeHandleContextMenu}
                    title="Double-click to reset Traffic / Inspector split"
                    className="h-1 w-full bg-hairline transition-colors hover:bg-accent/60"
                  />
                  <Panel
                    id="session-inspector-bottom"
                    order={2}
                    defaultSize={46}
                    minSize={20}
                    collapsible
                    collapsedSize={0}
                    onCollapse={() => setInspectorCollapsed(true)}
                  >
                    {renderInspectorOrDiff()}
                  </Panel>
                </>
              )}
            </PanelGroup>

            {inspectorCollapsed && (
              <CollapsedInspectorBar
                position="bottom"
                selectedSession={selectedSummary}
                selectedCount={effectiveSelectedIds.length}
                onExpand={onFocusInspector}
                onOpenStatistics={onOpenStatistics}
                onChangePosition={setInspectorPosition}
                onToggleSplitDirection={toggleInspectorSplitDirection}
                onResetPanelLayout={onResetPanelLayout}
              />
            )}
          </div>
        )}

        {inspectorPosition === "right" && (
          <div className="flex h-full w-full flex-row overflow-hidden">
            <PanelGroup
              ref={rightGroupRef}
              key="traffic-layout-right"
              autoSaveId={FLUX_PANEL_AUTOSAVE_IDS.right}
              storage={SAFE_PANEL_STORAGE}
              direction="horizontal"
              className="h-full min-w-0 flex-1"
            >
              <Panel
                id="traffic-grid-left"
                order={1}
                defaultSize={inspectorCollapsed ? 100 : 56}
                minSize={26}
              >
                {renderTrafficGrid()}
              </Panel>

              {!inspectorCollapsed && (
                <>
                  <PanelResizeHandle
                    onDoubleClick={handleResetRightGroup}
                    onContextMenu={handleResizeHandleContextMenu}
                    title="Double-click to reset workspace panel split"
                    className="w-1 bg-hairline transition-colors hover:bg-accent/60"
                  />
                  <Panel
                    id="session-inspector-right"
                    order={2}
                    defaultSize={44}
                    minSize={22}
                    collapsible
                    collapsedSize={0}
                    onCollapse={() => setInspectorCollapsed(true)}
                  >
                    {renderInspectorOrDiff()}
                  </Panel>
                </>
              )}
            </PanelGroup>

            {inspectorCollapsed && (
              <CollapsedInspectorBar
                position="right"
                selectedSession={selectedSummary}
                selectedCount={effectiveSelectedIds.length}
                onExpand={onFocusInspector}
                onOpenStatistics={onOpenStatistics}
                onChangePosition={setInspectorPosition}
                onToggleSplitDirection={toggleInspectorSplitDirection}
                onResetPanelLayout={onResetPanelLayout}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
