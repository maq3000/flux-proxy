import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

import {
  clearPersistedPanelLayouts,
  FLUX_PANEL_AUTOSAVE_IDS,
  SAFE_PANEL_STORAGE,
  sanitizeInspectorPanelStorageJson,
  TOOLBAR_GROUP_DEFINITIONS,
  useUiStore,
} from "./uiStore";

describe("Stage 40 uiStore cleanup and inspector panel storage safety", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("removes dockedComposer and setDockedComposer from uiStore", () => {
    const state = useUiStore.getState() as unknown as Record<string, unknown>;
    expect("dockedComposer" in state).toBe(false);
    expect("setDockedComposer" in state).toBe(false);
    expect("bottomOuter" in FLUX_PANEL_AUTOSAVE_IDS).toBe(false);
    expect(FLUX_PANEL_AUTOSAVE_IDS.composerSplit).toBe("flux-composer-split-v1");

    const layoutGroup = TOOLBAR_GROUP_DEFINITIONS.find(
      (g) => g.id === "layout"
    );
    expect(layoutGroup?.description).not.toContain("Split Composer");
  });

  it("repairs collapsed [100, 0] inspector layout in SAFE_PANEL_STORAGE using expandToSizes or default", () => {
    const bottomKey = `react-resizable-panels:${FLUX_PANEL_AUTOSAVE_IDS.bottomInner}`;
    const rawCollapsedWithPrev = JSON.stringify({
      "session-inspector-bottom,traffic-grid-top": {
        expandToSizes: { "session-inspector-bottom": 38 },
        layout: [100, 0],
      },
    });

    SAFE_PANEL_STORAGE.setItem(bottomKey, rawCollapsedWithPrev);
    const storedAfterSet = JSON.parse(
      window.localStorage.getItem(bottomKey) ?? "{}"
    ) as Record<string, { layout: number[] }>;
    expect(
      storedAfterSet["session-inspector-bottom,traffic-grid-top"].layout
    ).toEqual([62, 38]);

    // Also protects against legacy [100, 0] values already present in localStorage on getItem
    const rightKey = `react-resizable-panels:${FLUX_PANEL_AUTOSAVE_IDS.right}`;
    window.localStorage.setItem(
      rightKey,
      JSON.stringify({
        "session-inspector-right,traffic-grid-left": {
          expandToSizes: {},
          layout: [100, 0],
        },
      })
    );
    const loadedRight = JSON.parse(
      SAFE_PANEL_STORAGE.getItem(rightKey) ?? "{}"
    ) as Record<string, { layout: number[] }>;
    expect(
      loadedRight["session-inspector-right,traffic-grid-left"].layout
    ).toEqual([56, 44]);

    // Non-inspector groups (e.g. composerSplit) are left untouched
    const composerRaw = JSON.stringify({
      "composer-request-pane,composer-response-pane": {
        expandToSizes: {},
        layout: [100, 0],
      },
    });
    expect(
      sanitizeInspectorPanelStorageJson(
        `react-resizable-panels:${FLUX_PANEL_AUTOSAVE_IDS.composerSplit}`,
        composerRaw
      )
    ).toBe(composerRaw);
  });

  it("clearPersistedPanelLayouts cleans legacy bottomOuter and composerSplit keys", () => {
    const legacyBottomOuter = "react-resizable-panels:flux-layout-bottom-outer-v1";
    const composerKey = `react-resizable-panels:${FLUX_PANEL_AUTOSAVE_IDS.composerSplit}`;
    window.localStorage.setItem(legacyBottomOuter, "{}");
    window.localStorage.setItem(composerKey, "{}");

    clearPersistedPanelLayouts();

    expect(window.localStorage.getItem(legacyBottomOuter)).toBeNull();
    expect(window.localStorage.getItem(composerKey)).toBeNull();
  });
});
