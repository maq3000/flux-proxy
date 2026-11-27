import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/monaco", () => ({
  getMonacoThemeName: vi.fn(() => "flux-dark"),
  syncMonacoTheme: vi.fn(),
}));

import type { SessionSummary } from "../types/proxy";
import { createDefaultSettingsProfile } from "../lib/settingsManager";
import { findSessionById, useProxyStore } from "./proxyStore";

function makeSummary(id: number, status = 200): SessionSummary {
  return {
    id,
    status,
    protocol: "HTTPS/2",
    scheme: "https",
    method: "GET",
    host: "api.example.com",
    path: `/v1/items/${id}`,
    url: `https://api.example.com/v1/items/${id}`,
    contentType: "application/json",
    bodySize: 128,
    durationMs: 12,
    timestamp: "2026-11-27T07:00:00Z",
    isMocked: false,
  };
}

describe("proxyStore sessionIndexById", () => {
  beforeEach(() => {
    useProxyStore.getState().setSessions([]);
  });

  it("synchronizes sessionIndexById across setSessions updates", () => {
    const first = makeSummary(10);
    const second = makeSummary(25);
    useProxyStore.getState().setSessions([first, second]);

    const state = useProxyStore.getState();
    expect(state.sessionIndexById.get(10)).toBe(0);
    expect(state.sessionIndexById.get(25)).toBe(1);
    expect(findSessionById(state.sessions, state.sessionIndexById, 25)).toEqual(
      second
    );
    expect(
      findSessionById(state.sessions, state.sessionIndexById, 999)
    ).toBeUndefined();

    useProxyStore.getState().setSessions((prev) => prev.filter((s) => s.id === 25));
    const afterFilter = useProxyStore.getState();
    expect(afterFilter.sessionIndexById.get(10)).toBeUndefined();
    expect(afterFilter.sessionIndexById.get(25)).toBe(0);
  });

  it("coalesces in-place updates, appends new IDs, and reindexes after retention eviction", () => {
    useProxyStore.getState().mergeSessionBatch([makeSummary(1, 0), makeSummary(2, 0)]);
    const indexAfterAppend = useProxyStore.getState().sessionIndexById;
    expect(indexAfterAppend.get(1)).toBe(0);
    expect(indexAfterAppend.get(2)).toBe(1);

    // Pure in-place update reuses the existing Map reference without re-cloning.
    useProxyStore.getState().mergeSessionBatch([makeSummary(1, 200)]);
    const afterInPlace = useProxyStore.getState();
    expect(afterInPlace.sessionIndexById).toBe(indexAfterAppend);
    expect(afterInPlace.sessions[0].status).toBe(200);

    // Appending past retention evicts oldest IDs and shifts remaining indices.
    useProxyStore
      .getState()
      .mergeSessionBatch([makeSummary(3, 201), makeSummary(4, 202)], 2);
    const afterEvict = useProxyStore.getState();
    expect(afterEvict.sessions.map((s) => s.id)).toEqual([3, 4]);
    expect(afterEvict.sessionIndexById.get(1)).toBeUndefined();
    expect(afterEvict.sessionIndexById.get(2)).toBeUndefined();
    expect(afterEvict.sessionIndexById.get(3)).toBe(0);
    expect(afterEvict.sessionIndexById.get(4)).toBe(1);
  });

  it("updates sessionIndexById when applySettingsProfileProxy trims retention", () => {
    useProxyStore
      .getState()
      .setSessions([makeSummary(1), makeSummary(2), makeSummary(3), makeSummary(4)]);

    const profile = createDefaultSettingsProfile();
    profile.proxy.sessionRetentionLimit = 2;
    useProxyStore.getState().applySettingsProfileProxy(profile);

    const state = useProxyStore.getState();
    expect(state.sessions.map((s) => s.id)).toEqual([3, 4]);
    expect(state.sessionIndexById.get(1)).toBeUndefined();
    expect(state.sessionIndexById.get(2)).toBeUndefined();
    expect(state.sessionIndexById.get(3)).toBe(0);
    expect(state.sessionIndexById.get(4)).toBe(1);
  });
});
