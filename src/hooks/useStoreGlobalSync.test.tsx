import React from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../types/proxy";
import { SETTINGS_APPLIED_EVENT } from "../types/settings";

const {
  commitCounts,
  mockBridge,
  mockListeners,
  resetMockBridge,
  syncMonacoThemeMock,
} = await vi.hoisted(async () => {
  const [{ createStatefulMockProxyBridge }, vitest] = await Promise.all([
    import("../test/mockProxyBridge"),
    import("vitest"),
  ]);
  const env = createStatefulMockProxyBridge();
  return {
    commitCounts: {
      MenuBar: 0,
      TopToolbar: 0,
      Sidebar: 0,
      StatusFooter: 0,
      TrafficWorkspace: 0,
    },
    mockBridge: env.bridge,
    mockListeners: env.listeners,
    resetMockBridge: env.reset,
    syncMonacoThemeMock: vitest.vi.fn(),
  };
});

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: syncMonacoThemeMock,
}));

vi.mock("@monaco-editor/react", () => ({
  default: () => <div data-testid="monaco-mock" />,
  DiffEditor: () => <div data-testid="monaco-diff-mock" />,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 20) }, (_, index) => ({
        index,
        key: index,
        start: index * 28,
        size: 28,
      })),
    scrollToIndex: vi.fn(),
  }),
}));

vi.mock("../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauriBridge")>();
  return {
    ...actual,
    isTauriRuntime: () => false,
    proxyBridge: mockBridge,
  };
});

vi.mock("../components/MenuBar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/MenuBar")>();
  const Inner = actual.MenuBar;
  const innerFn = (
    Inner as unknown as {
      type?: (props: React.ComponentProps<typeof Inner>) => React.ReactNode;
    }
  ).type;
  if (typeof innerFn !== "function") {
    throw new Error("Expected MenuBar to be wrapped with React.memo");
  }
  const SpyMenuBar = React.memo(
    (props: React.ComponentProps<typeof Inner>) => {
      commitCounts.MenuBar += 1;
      return innerFn(props);
    }
  );
  return { ...actual, MenuBar: SpyMenuBar };
});

vi.mock("../components/TopToolbar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/TopToolbar")>();
  const Inner = actual.TopToolbar;
  const innerFn = (
    Inner as unknown as {
      type?: (props: React.ComponentProps<typeof Inner>) => React.ReactNode;
    }
  ).type;
  if (typeof innerFn !== "function") {
    throw new Error("Expected TopToolbar to be wrapped with React.memo");
  }
  const SpyTopToolbar = React.memo(
    (props: React.ComponentProps<typeof Inner>) => {
      commitCounts.TopToolbar += 1;
      return innerFn(props);
    }
  );
  return { ...actual, TopToolbar: SpyTopToolbar };
});

vi.mock("../components/Sidebar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/Sidebar")>();
  const Inner = actual.Sidebar;
  const innerFn = (
    Inner as unknown as {
      type?: (props: React.ComponentProps<typeof Inner>) => React.ReactNode;
    }
  ).type;
  if (typeof innerFn !== "function") {
    throw new Error("Expected Sidebar to be wrapped with React.memo");
  }
  const SpySidebar = React.memo(
    (props: React.ComponentProps<typeof Inner>) => {
      commitCounts.Sidebar += 1;
      return innerFn(props);
    }
  );
  return { ...actual, Sidebar: SpySidebar };
});

vi.mock("../components/workspaces/StatusFooter", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../components/workspaces/StatusFooter")
    >();
  const Inner = actual.StatusFooter;
  const innerFn = (
    Inner as unknown as {
      type?: (props: React.ComponentProps<typeof Inner>) => React.ReactNode;
    }
  ).type;
  if (typeof innerFn !== "function") {
    throw new Error("Expected StatusFooter to be wrapped with React.memo");
  }
  const SpyFooter = React.memo(
    (props: React.ComponentProps<typeof Inner>) => {
      commitCounts.StatusFooter += 1;
      return innerFn(props);
    }
  );
  return { ...actual, StatusFooter: SpyFooter };
});

vi.mock("../components/workspaces/TrafficWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../components/workspaces/TrafficWorkspace")
    >();
  const innerFn = actual.TrafficWorkspace as unknown as (
    props: React.ComponentProps<typeof actual.TrafficWorkspace>
  ) => React.ReactNode;
  if (typeof innerFn !== "function") {
    throw new Error("Expected TrafficWorkspace to be a function component");
  }
  const SpyTrafficWorkspace = (
    props: React.ComponentProps<typeof actual.TrafficWorkspace>
  ) => {
    commitCounts.TrafficWorkspace += 1;
    return innerFn(props);
  };
  return { ...actual, TrafficWorkspace: SpyTrafficWorkspace };
});

import App from "../App";
import { useProxyStore } from "../stores/proxyStore";
import {
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_PRESET_STORAGE_KEY,
  useUiStore,
} from "../stores/uiStore";
import { useStoreGlobalSync } from "./useStoreGlobalSync";
import { useTheme } from "./useTheme";
import { useUiPreferences } from "./useUiPreferences";

function makeBatchSession(id: number): SessionSummary {
  return {
    id,
    status: 200,
    protocol: "HTTPS/1.1",
    scheme: "https",
    method: "GET",
    host: "telemetry.test",
    path: `/items/${id}`,
    url: `https://telemetry.test/items/${id}`,
    contentType: "application/json",
    bodySize: 128,
    durationMs: 14,
    timestamp: "12:00:00.000",
    isMocked: false,
  };
}

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
      this.setAttribute("open", "");
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
});

describe("useStoreGlobalSync & PERF-04 render isolation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetMockBridge();
    vi.clearAllMocks();
    commitCounts.MenuBar = 0;
    commitCounts.TopToolbar = 0;
    commitCounts.Sidebar = 0;
    commitCounts.StatusFooter = 0;
    commitCounts.TrafficWorkspace = 0;
    useProxyStore.setState({
      sessions: [],
      sessionIndexById: new Map(),
      markedSessionsCount: 0,
      selectedId: null,
      selectedIds: [],
      selectedDetail: null,
      diffLeftDetail: null,
      diffRightDetail: null,
      pausedBreakpoints: [],
      toastMessage: null,
    });
    useUiStore.getState().setTheme("dark");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("registers global storage, SETTINGS_APPLIED_EVENT, and matchMedia listeners exactly once across multiple hook consumers and cleans up on unmount", () => {
    const addWinSpy = vi.spyOn(window, "addEventListener");
    const removeWinSpy = vi.spyOn(window, "removeEventListener");

    const mediaAddSpy = vi.fn();
    const mediaRemoveSpy = vi.fn();
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: mediaAddSpy,
      removeEventListener: mediaRemoveSpy,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const Consumer: React.FC = () => {
      const { resolvedTheme } = useTheme();
      const { compactToolbar } = useUiPreferences();
      return (
        <span data-testid="consumer">
          {resolvedTheme}:{String(compactToolbar)}
        </span>
      );
    };

    const Root: React.FC = () => {
      useStoreGlobalSync();
      return (
        <>
          <Consumer />
          <Consumer />
          <Consumer />
        </>
      );
    };

    const colorSchemeMeta = document.createElement("meta");
    colorSchemeMeta.name = "color-scheme";
    colorSchemeMeta.content = "dark";
    document.head.appendChild(colorSchemeMeta);

    try {
      const { unmount } = render(<Root />);

      const storageAddCalls = addWinSpy.mock.calls.filter(
        ([ev]) => ev === "storage"
      );
      const settingsAppliedAddCalls = addWinSpy.mock.calls.filter(
        ([ev]) => ev === SETTINGS_APPLIED_EVENT
      );
      expect(storageAddCalls).toHaveLength(1);
      expect(settingsAppliedAddCalls).toHaveLength(1);
      expect(mediaAddSpy).toHaveBeenCalledTimes(1);

      expect(colorSchemeMeta.content).toBe("dark");
      expect(syncMonacoThemeMock).toHaveBeenLastCalledWith(
        "dark",
        expect.any(Object)
      );

      act(() => {
        useUiStore.getState().setTheme("light");
      });
      expect(colorSchemeMeta.content).toBe("light");
      expect(syncMonacoThemeMock).toHaveBeenLastCalledWith(
        "light",
        expect.any(Object)
      );

      // Simulate cross-tab storage change syncing theme preference & preset back to dark
      act(() => {
        window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, "dark");
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: THEME_PREFERENCE_STORAGE_KEY,
            newValue: "dark",
          })
        );
        window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, "default-dark");
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: THEME_PRESET_STORAGE_KEY,
            newValue: "default-dark",
          })
        );
      });
      expect(colorSchemeMeta.content).toBe("dark");
      expect(syncMonacoThemeMock).toHaveBeenLastCalledWith(
        "dark",
        expect.any(Object)
      );

      unmount();

      expect(
        removeWinSpy.mock.calls.filter(([ev]) => ev === "storage")
      ).toHaveLength(1);
      expect(
        removeWinSpy.mock.calls.filter(([ev]) => ev === SETTINGS_APPLIED_EVENT)
      ).toHaveLength(1);
      expect(mediaRemoveSpy).toHaveBeenCalledTimes(1);
    } finally {
      colorSchemeMeta.remove();
      window.matchMedia = originalMatchMedia;
    }
  });

  it("[PERF-04] isolates high-frequency mergeSessionBatch updates to TrafficWorkspace without re-rendering MenuBar, TopToolbar, Sidebar, or StatusFooter", async () => {
    render(<App />);

    await waitFor(() => {
      expect(mockListeners.batches.size).toBe(1);
    });
    // Allow initial async boot effects (network/client certs/settings) to settle
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const baseline = {
      MenuBar: commitCounts.MenuBar,
      TopToolbar: commitCounts.TopToolbar,
      Sidebar: commitCounts.Sidebar,
      StatusFooter: commitCounts.StatusFooter,
      TrafficWorkspace: commitCounts.TrafficWorkspace,
    };

    act(() => {
      useProxyStore
        .getState()
        .mergeSessionBatch([makeBatchSession(1), makeBatchSession(2)], 10_000);
    });
    act(() => {
      useProxyStore
        .getState()
        .mergeSessionBatch([makeBatchSession(3), makeBatchSession(4)], 10_000);
    });
    act(() => {
      useProxyStore.getState().mergeSessionBatch([makeBatchSession(5)], 10_000);
    });

    // Only TrafficWorkspace (and leaf SessionCountsBadge) updates with the 5 sessions
    expect(screen.getAllByText(/5\s*\/\s*5/).length).toBeGreaterThanOrEqual(2);
    expect(commitCounts.TrafficWorkspace).toBeGreaterThan(
      baseline.TrafficWorkspace
    );

    expect(commitCounts.MenuBar).toBe(baseline.MenuBar);
    expect(commitCounts.TopToolbar).toBe(baseline.TopToolbar);
    expect(commitCounts.Sidebar).toBe(baseline.Sidebar);
    expect(commitCounts.StatusFooter).toBe(baseline.StatusFooter);
  });
});
