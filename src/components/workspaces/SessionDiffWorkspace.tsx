import React, { useEffect, useState } from "react";
import { useTheme } from "../../hooks/useTheme";
import { proxyBridge } from "../../lib/tauriBridge";
import { getFilteredSessionsSnapshot } from "../../lib/trafficFilter";
import { useFilterStore } from "../../stores/filterStore";
import { findSessionById, useProxyStore } from "../../stores/proxyStore";
import type { SessionDetail, SessionSummary } from "../../types/proxy";

const SessionDiffView = React.lazy(() =>
  import("../SessionDiffView").then((m) => ({
    default: m.SessionDiffView,
  }))
);

export interface SessionDiffWorkspaceProps {
  isActive: boolean;
  visited: boolean;
  diffTabPairIds: [number, number] | null;
  setDiffTabPairIds: React.Dispatch<
    React.SetStateAction<[number, number] | null>
  >;
  onBackToTraffic: () => void;
  onSelectPair: (leftId: number, rightId: number) => void;
  onSwapPair: () => void;
  onAnnotateSession: (id: number) => void;
  onNotify: (msg: string) => void;
}

function resolveCurrentDiffSessionsPool(): SessionSummary[] {
  const all = useProxyStore.getState().sessions;
  const filtered = getFilteredSessionsSnapshot();
  return filtered.length >= 2 ? filtered : all;
}

const SessionDiffWorkspaceInner: React.FC<
  Omit<SessionDiffWorkspaceProps, "visited">
> = ({
  isActive,
  diffTabPairIds,
  setDiffTabPairIds,
  onBackToTraffic,
  onSelectPair,
  onSwapPair,
  onAnnotateSession,
  onNotify,
}) => {
  const { resolvedTheme } = useTheme();
  const [diffTabDetails, setDiffTabDetails] = useState<{
    left: SessionDetail | null;
    right: SessionDetail | null;
  }>({ left: null, right: null });
  const [sessionsPool, setSessionsPool] = useState<SessionSummary[]>(() =>
    resolveCurrentDiffSessionsPool()
  );

  // Only mirror `sessions` while the Diff tab is visible so background capture stays isolated to TrafficWorkspace.
  useEffect(() => {
    if (!isActive) return;
    setSessionsPool(resolveCurrentDiffSessionsPool());
    const unsubProxy = useProxyStore.subscribe((state, prevState) => {
      if (state.sessions !== prevState.sessions) {
        setSessionsPool(resolveCurrentDiffSessionsPool());
      }
    });
    const unsubFilter = useFilterStore.subscribe((state, prevState) => {
      if (
        state.filterQuery !== prevState.filterQuery ||
        state.useRegex !== prevState.useRegex ||
        state.quickCategory !== prevState.quickCategory ||
        state.matrixEnabled !== prevState.matrixEnabled ||
        state.filterRules !== prevState.filterRules ||
        state.thresholds !== prevState.thresholds ||
        state.hostListFilter !== prevState.hostListFilter
      ) {
        setSessionsPool(resolveCurrentDiffSessionsPool());
      }
    });
    return () => {
      unsubProxy();
      unsubFilter();
    };
  }, [isActive]);

  // Clear saved Session Diff pair only if either session was removed/cleared
  useEffect(() => {
    if (!diffTabPairIds) return;
    const checkPairExists = () => {
      const state = useProxyStore.getState();
      const [leftId, rightId] = diffTabPairIds;
      const hasLeft = Boolean(
        findSessionById(state.sessions, state.sessionIndexById, leftId)
      );
      const hasRight = Boolean(
        findSessionById(state.sessions, state.sessionIndexById, rightId)
      );
      if (!hasLeft || !hasRight) {
        setDiffTabPairIds(null);
        setDiffTabDetails({ left: null, right: null });
      }
    };
    checkPairExists();
    return useProxyStore.subscribe((state, prevState) => {
      if (state.sessions !== prevState.sessions) {
        checkPairExists();
      }
    });
  }, [diffTabPairIds, setDiffTabPairIds]);

  // Keep Session Diff tab details loaded even when user clicks a single session in Traffic
  useEffect(() => {
    if (!diffTabPairIds) {
      setDiffTabDetails({ left: null, right: null });
      return;
    }
    const [leftId, rightId] = diffTabPairIds;
    const storeState = useProxyStore.getState();
    if (
      storeState.diffLeftDetail?.summary.id === leftId &&
      storeState.diffRightDetail?.summary.id === rightId
    ) {
      setDiffTabDetails({
        left: storeState.diffLeftDetail,
        right: storeState.diffRightDetail,
      });
      return;
    }
    let active = true;
    void Promise.all([
      proxyBridge.getSessionDetail(leftId),
      proxyBridge.getSessionDetail(rightId),
    ])
      .then(([left, right]) => {
        if (!active) return;
        setDiffTabDetails({ left, right });
      })
      .catch(() => {
        if (!active) return;
        setDiffTabDetails({ left: null, right: null });
      });
    return () => {
      active = false;
    };
  }, [diffTabPairIds]);

  const diffLeftDetail = useProxyStore((s) =>
    diffTabPairIds && s.diffLeftDetail?.summary.id === diffTabPairIds[0]
      ? s.diffLeftDetail
      : null
  );
  const diffRightDetail = useProxyStore((s) =>
    diffTabPairIds && s.diffRightDetail?.summary.id === diffTabPairIds[1]
      ? s.diffRightDetail
      : null
  );

  const resolvedLeftDetail = diffLeftDetail ?? diffTabDetails.left;
  const resolvedRightDetail = diffRightDetail ?? diffTabDetails.right;

  return (
    <div
      hidden={!isActive}
      className={
        isActive ? "flex h-full w-full flex-col overflow-hidden" : "hidden"
      }
    >
      <React.Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center text-xs text-muted">
            Loading Session Diff...
          </div>
        }
      >
        <SessionDiffView
          leftDetail={resolvedLeftDetail}
          rightDetail={resolvedRightDetail}
          sessions={sessionsPool}
          resolvedTheme={resolvedTheme}
          defaultSideBySide
          showSectionHeader
          onBackToTraffic={onBackToTraffic}
          onSelectPair={onSelectPair}
          onSwapPair={onSwapPair}
          onAnnotateSession={onAnnotateSession}
          onNotify={onNotify}
        />
      </React.Suspense>
    </div>
  );
};

export const SessionDiffWorkspace: React.FC<SessionDiffWorkspaceProps> = ({
  visited,
  ...rest
}) => {
  if (!visited) return null;
  return <SessionDiffWorkspaceInner {...rest} />;
};
