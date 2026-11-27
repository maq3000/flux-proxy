import { create } from "zustand";
import { getFilteredSessionsResultSnapshot } from "../lib/trafficFilter";
import { useFilterStore } from "./filterStore";
import { useProxyStore } from "./proxyStore";

export interface TrafficTelemetryState {
  totalCount: number;
  filteredCount: number;
  hasSessions: boolean;
  hasFilteredSessions: boolean;
  syncTrafficTelemetry: () => void;
}

function readInitialTelemetry(): Omit<TrafficTelemetryState, "syncTrafficTelemetry"> {
  const totalCount = useProxyStore.getState().sessions.length;
  const filteredCount = getFilteredSessionsResultSnapshot().filteredSessions.length;
  return {
    totalCount,
    filteredCount,
    hasSessions: totalCount > 0,
    hasFilteredSessions: filteredCount > 0,
  };
}

export const useTrafficTelemetryStore = create<TrafficTelemetryState>((set) => ({
  ...readInitialTelemetry(),
  syncTrafficTelemetry: () => {
    const totalCount = useProxyStore.getState().sessions.length;
    const filteredCount =
      getFilteredSessionsResultSnapshot().filteredSessions.length;
    const hasSessions = totalCount > 0;
    const hasFilteredSessions = filteredCount > 0;
    set((state) => {
      if (
        state.totalCount === totalCount &&
        state.filteredCount === filteredCount &&
        state.hasSessions === hasSessions &&
        state.hasFilteredSessions === hasFilteredSessions
      ) {
        return state;
      }
      return {
        totalCount,
        filteredCount,
        hasSessions,
        hasFilteredSessions,
      };
    });
  },
}));

export function syncTrafficTelemetry(): void {
  useTrafficTelemetryStore.getState().syncTrafficTelemetry();
}

useProxyStore.subscribe((state, prevState) => {
  if (state.sessions !== prevState.sessions) {
    syncTrafficTelemetry();
  }
});

useFilterStore.subscribe((state, prevState) => {
  if (
    state.filterQuery !== prevState.filterQuery ||
    state.useRegex !== prevState.useRegex ||
    state.quickCategory !== prevState.quickCategory ||
    state.matrixEnabled !== prevState.matrixEnabled ||
    state.filterRules !== prevState.filterRules ||
    state.thresholds !== prevState.thresholds ||
    state.hostListFilter !== prevState.hostListFilter
  ) {
    syncTrafficTelemetry();
  }
});
