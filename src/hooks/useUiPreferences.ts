import { useCallback, useEffect, useState } from "react";
import type { PanelGroupStorage } from "react-resizable-panels";
import type {
  ColumnId,
  InspectorDockPosition,
  InspectorSplitDirection,
  ToolbarGroupId,
  UiLayoutPreferences,
} from "../types/proxy";
import {
  SETTINGS_APPLIED_EVENT,
  type FluxUserSettingsProfile,
} from "../types/settings";

export type { InspectorSplitDirection } from "../types/proxy";

export const FLUX_PANEL_AUTOSAVE_IDS = {
  bottomOuter: "flux-layout-bottom-outer-v1",
  bottomInner: "flux-layout-bottom-inner-v1",
  right: "flux-layout-right-v1",
  inspectorSplit: "flux-inspector-split-v1",
} as const;

export const FLUX_PANEL_STORAGE_PREFIX = "react-resizable-panels:flux-";
export const FLUX_PANEL_LAYOUT_RESET_EVENT = "fluxproxy:panel-layout-reset";

export const SAFE_PANEL_STORAGE: PanelGroupStorage = {
  getItem(name: string): string | null {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name: string, value: string): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(name, value);
    } catch {
      // ignore storage quota / privacy mode errors
    }
  },
};

export function resolveInspectorSplitDirection(
  splitDirection: InspectorSplitDirection,
  inspectorPosition: InspectorDockPosition
): "horizontal" | "vertical" {
  if (splitDirection === "horizontal" || splitDirection === "vertical") {
    return splitDirection;
  }
  return inspectorPosition === "bottom" ? "horizontal" : "vertical";
}

export function clearPersistedPanelLayouts(): void {
  if (typeof window === "undefined") return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(FLUX_PANEL_STORAGE_PREFIX)) {
        keysToRemove.push(k);
      }
    }
    for (const autoSaveId of Object.values(FLUX_PANEL_AUTOSAVE_IDS)) {
      const fullKey = `react-resizable-panels:${autoSaveId}`;
      if (!keysToRemove.includes(fullKey)) {
        keysToRemove.push(fullKey);
      }
    }
    for (const key of keysToRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore storage errors
  }
}

export function readPersistedPanelLayouts(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const result: Record<string, string> = {};
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(FLUX_PANEL_STORAGE_PREFIX)) continue;
      const val = window.localStorage.getItem(key);
      if (typeof val === "string") {
        const autoSaveId = key.slice("react-resizable-panels:".length);
        result[autoSaveId] = val;
      }
    }
  } catch {
    return {};
  }
  return result;
}

export function writePersistedPanelLayouts(
  layouts?: Record<string, string>
): void {
  if (typeof window === "undefined" || !layouts) return;
  clearPersistedPanelLayouts();
  try {
    for (const [rawKey, rawVal] of Object.entries(layouts)) {
      if (typeof rawVal !== "string") continue;
      const fullKey = rawKey.startsWith("react-resizable-panels:")
        ? rawKey
        : `react-resizable-panels:${rawKey}`;
      if (!fullKey.startsWith(FLUX_PANEL_STORAGE_PREFIX)) continue;
      window.localStorage.setItem(fullKey, rawVal);
    }
  } catch {
    // ignore storage quota errors
  }
}

export interface ColumnDefinition {
  id: ColumnId;
  label: string;
  defaultWidth: number;
  minWidth: number;
  maxAutoFitWidth: number;
  align?: "left" | "right";
}

export const TRAFFIC_COLUMNS: ColumnDefinition[] = [
  { id: "id", label: "#", defaultWidth: 56, minWidth: 44, maxAutoFitWidth: 110 },
  {
    id: "status",
    label: "Status",
    defaultWidth: 66,
    minWidth: 54,
    maxAutoFitWidth: 110,
  },
  {
    id: "method",
    label: "Method",
    defaultWidth: 68,
    minWidth: 54,
    maxAutoFitWidth: 110,
  },
  {
    id: "protocol",
    label: "Protocol",
    defaultWidth: 80,
    minWidth: 58,
    maxAutoFitWidth: 130,
  },
  {
    id: "host",
    label: "Host",
    defaultWidth: 164,
    minWidth: 84,
    maxAutoFitWidth: 340,
  },
  {
    id: "url",
    label: "URL",
    defaultWidth: 320,
    minWidth: 120,
    maxAutoFitWidth: 620,
  },
  {
    id: "process",
    label: "Process / IP",
    defaultWidth: 132,
    minWidth: 74,
    maxAutoFitWidth: 260,
  },
  {
    id: "size",
    label: "Size",
    defaultWidth: 78,
    minWidth: 60,
    maxAutoFitWidth: 130,
    align: "right",
  },
  {
    id: "time",
    label: "Time",
    defaultWidth: 80,
    minWidth: 60,
    maxAutoFitWidth: 140,
    align: "right",
  },
  {
    id: "comment",
    label: "Comment",
    defaultWidth: 168,
    minWidth: 80,
    maxAutoFitWidth: 380,
  },
];

export const COLUMN_MIN_WIDTHS: Record<ColumnId, number> = TRAFFIC_COLUMNS.reduce(
  (acc, col) => {
    acc[col.id] = col.minWidth;
    return acc;
  },
  {} as Record<ColumnId, number>
);

export const DEFAULT_COLUMN_WIDTHS: Record<ColumnId, number> =
  TRAFFIC_COLUMNS.reduce(
    (acc, col) => {
      acc[col.id] = col.defaultWidth;
      return acc;
    },
    {} as Record<ColumnId, number>
  );

export const DEFAULT_VISIBLE_COLUMNS: Record<ColumnId, boolean> =
  TRAFFIC_COLUMNS.reduce(
    (acc, col) => {
      acc[col.id] = true;
      return acc;
    },
    {} as Record<ColumnId, boolean>
  );

export interface ToolbarGroupDefinition {
  id: ToolbarGroupId;
  label: string;
  description: string;
}

export const TOOLBAR_GROUP_DEFINITIONS: ToolbarGroupDefinition[] = [
  {
    id: "capture",
    label: "Capture & Stream",
    description: "Capture On/Off (F12), Clear (Ctrl+X), Follow Tail",
  },
  {
    id: "quickFilter",
    label: "Quick Filter Bar",
    description: "Search (Ctrl+F), RegExp toggle, Filter Matrix",
  },
  {
    id: "layout",
    label: "Layout & Columns",
    description: "Sidebar, Inspector position/collapse, Composer, Column Picker",
  },
  {
    id: "proxyMode",
    label: "System Proxy & MITM",
    description: "OS System Proxy & Selective TLS MITM switcher",
  },
  {
    id: "breakpoints",
    label: "Breakpoints",
    description: "Break Before Request (F11) / After Response (Alt+F11)",
  },
  {
    id: "categories",
    label: "Category Filter Pills",
    description: "Quick tabs: All, JSON, SSE, 4xx/5xx, Marked",
  },
  {
    id: "utilities",
    label: "Quick Utilities",
    description: "Session Diff, Hex, TextWizard, No-Cache, SQLite Save",
  },
];

export const DEFAULT_TOOLBAR_GROUPS: Record<ToolbarGroupId, boolean> = {
  capture: true,
  quickFilter: true,
  layout: true,
  proxyMode: false,
  breakpoints: false,
  categories: false,
  utilities: false,
};

export const DEFAULT_LAYOUT_PREFS: UiLayoutPreferences = {
  compactToolbar: false,
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  inspectorPosition: "bottom",
  inspectorSplitDirection: "auto",
};

function sanitizeSplitDirection(val: unknown): InspectorSplitDirection {
  return val === "horizontal" || val === "vertical" || val === "auto"
    ? val
    : "auto";
}

const LS_LAYOUT_KEY = "fluxproxy.uiLayout.v1";
const LS_TOOLBAR_GROUPS_KEY = "fluxproxy.toolbarGroups.v1";
const LS_VISIBLE_COLUMNS_KEY = "fluxproxy.visibleColumns.v1";
const LS_COLUMN_WIDTHS_KEY = "fluxproxy.columnWidths.v1";

function loadJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function useUiPreferences() {
  const [layout, setLayout] = useState<UiLayoutPreferences>(() => {
    const saved = loadJson<Partial<UiLayoutPreferences>>(LS_LAYOUT_KEY, {});
    return {
      compactToolbar: Boolean(saved.compactToolbar ?? false),
      sidebarCollapsed: Boolean(saved.sidebarCollapsed ?? false),
      inspectorCollapsed: Boolean(saved.inspectorCollapsed ?? false),
      inspectorPosition:
        saved.inspectorPosition === "right" ? "right" : "bottom",
      inspectorSplitDirection: sanitizeSplitDirection(
        saved.inspectorSplitDirection
      ),
    };
  });

  const [toolbarGroups, setToolbarGroups] = useState<
    Record<ToolbarGroupId, boolean>
  >(() => {
    const saved = loadJson<Partial<Record<ToolbarGroupId, boolean>>>(
      LS_TOOLBAR_GROUPS_KEY,
      {}
    );
    return {
      ...DEFAULT_TOOLBAR_GROUPS,
      ...saved,
    };
  });

  const [visibleColumns, setVisibleColumns] = useState<
    Record<ColumnId, boolean>
  >(() => {
    const saved = loadJson<Partial<Record<ColumnId, boolean>>>(
      LS_VISIBLE_COLUMNS_KEY,
      {}
    );
    const merged: Record<ColumnId, boolean> = {
      ...DEFAULT_VISIBLE_COLUMNS,
      ...saved,
    };
    const anyVisible = Object.values(merged).some(Boolean);
    if (!anyVisible) {
      merged.id = true;
      merged.url = true;
    }
    return merged;
  });

  const [columnWidths, setColumnWidths] = useState<Record<ColumnId, number>>(
    () => {
      const saved = loadJson<Partial<Record<ColumnId, number>>>(
        LS_COLUMN_WIDTHS_KEY,
        {}
      );
      const merged = { ...DEFAULT_COLUMN_WIDTHS };
      for (const col of TRAFFIC_COLUMNS) {
        const val = saved[col.id];
        if (typeof val === "number" && Number.isFinite(val)) {
          merged[col.id] = Math.max(col.minWidth, Math.round(val));
        }
      }
      return merged;
    }
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(LS_LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // ignore storage quota errors
    }
  }, [layout]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LS_TOOLBAR_GROUPS_KEY,
        JSON.stringify(toolbarGroups)
      );
    } catch {
      // ignore
    }
  }, [toolbarGroups]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LS_VISIBLE_COLUMNS_KEY,
        JSON.stringify(visibleColumns)
      );
    } catch {
      // ignore
    }
  }, [visibleColumns]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LS_COLUMN_WIDTHS_KEY,
        JSON.stringify(columnWidths)
      );
    } catch {
      // ignore
    }
  }, [columnWidths]);

  useEffect(() => {
    const handleSettingsApplied = (event: Event) => {
      const detail = (event as CustomEvent<FluxUserSettingsProfile>).detail;
      if (!detail?.ui) return;
      setLayout({
        compactToolbar: Boolean(detail.ui.compactToolbar),
        sidebarCollapsed: Boolean(detail.ui.sidebarCollapsed),
        inspectorCollapsed: Boolean(detail.ui.inspectorCollapsed),
        inspectorPosition:
          detail.ui.inspectorPosition === "right" ? "right" : "bottom",
        inspectorSplitDirection: sanitizeSplitDirection(
          detail.ui.inspectorSplitDirection
        ),
      });
      setToolbarGroups({
        ...DEFAULT_TOOLBAR_GROUPS,
        ...detail.ui.toolbarGroups,
      });
      setVisibleColumns({
        ...DEFAULT_VISIBLE_COLUMNS,
        ...detail.ui.visibleColumns,
      });
      setColumnWidths({
        ...DEFAULT_COLUMN_WIDTHS,
        ...detail.ui.columnWidths,
      });
    };

    window.addEventListener(SETTINGS_APPLIED_EVENT, handleSettingsApplied);
    return () => {
      window.removeEventListener(SETTINGS_APPLIED_EVENT, handleSettingsApplied);
    };
  }, []);

  const setCompactToolbar = useCallback((compact: boolean) => {
    setLayout((prev) => ({ ...prev, compactToolbar: compact }));
  }, []);

  const toggleCompactToolbar = useCallback(() => {
    setLayout((prev) => ({
      ...prev,
      compactToolbar: !prev.compactToolbar,
    }));
  }, []);

  const toggleSidebar = useCallback(() => {
    setLayout((prev) => ({
      ...prev,
      sidebarCollapsed: !prev.sidebarCollapsed,
    }));
  }, []);

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setLayout((prev) => ({ ...prev, sidebarCollapsed: collapsed }));
  }, []);

  const toggleInspector = useCallback(() => {
    setLayout((prev) => ({
      ...prev,
      inspectorCollapsed: !prev.inspectorCollapsed,
    }));
  }, []);

  const setInspectorCollapsed = useCallback((collapsed: boolean) => {
    setLayout((prev) => ({ ...prev, inspectorCollapsed: collapsed }));
  }, []);

  const setInspectorPosition = useCallback((pos: InspectorDockPosition) => {
    setLayout((prev) => ({
      ...prev,
      inspectorPosition: pos,
      inspectorCollapsed: false,
    }));
  }, []);

  const setInspectorSplitDirection = useCallback(
    (dir: InspectorSplitDirection) => {
      setLayout((prev) => ({
        ...prev,
        inspectorSplitDirection: sanitizeSplitDirection(dir),
      }));
    },
    []
  );

  const toggleInspectorSplitDirection = useCallback(() => {
    setLayout((prev) => {
      const currentResolved = resolveInspectorSplitDirection(
        prev.inspectorSplitDirection,
        prev.inspectorPosition
      );
      const nextDir: InspectorSplitDirection =
        currentResolved === "horizontal" ? "vertical" : "horizontal";
      return {
        ...prev,
        inspectorSplitDirection: nextDir,
      };
    });
  }, []);

  const resetPanelLayouts = useCallback(() => {
    clearPersistedPanelLayouts();
    setLayout((prev) => ({
      ...prev,
      inspectorSplitDirection: "auto",
    }));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(FLUX_PANEL_LAYOUT_RESET_EVENT));
      window.setTimeout(() => {
        clearPersistedPanelLayouts();
      }, 150);
    }
  }, []);

  const toggleToolbarGroup = useCallback((groupId: ToolbarGroupId) => {
    setToolbarGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  }, []);

  const setToolbarGroupVisible = useCallback(
    (groupId: ToolbarGroupId, visible: boolean) => {
      setToolbarGroups((prev) => ({
        ...prev,
        [groupId]: visible,
      }));
    },
    []
  );

  const resetToolbarGroups = useCallback(() => {
    setToolbarGroups({ ...DEFAULT_TOOLBAR_GROUPS });
  }, []);

  const toggleColumnVisibility = useCallback((colId: ColumnId) => {
    setVisibleColumns((prev) => {
      const nextVal = !prev[colId];
      if (!nextVal) {
        const remainingCount = TRAFFIC_COLUMNS.filter(
          (c) => c.id !== colId && prev[c.id]
        ).length;
        if (remainingCount === 0) {
          return prev;
        }
      }
      return {
        ...prev,
        [colId]: nextVal,
      };
    });
  }, []);

  const setColumnWidth = useCallback((colId: ColumnId, width: number) => {
    const min = COLUMN_MIN_WIDTHS[colId] ?? 48;
    const clamped = Math.max(min, Math.round(width));
    setColumnWidths((prev) =>
      prev[colId] === clamped ? prev : { ...prev, [colId]: clamped }
    );
  }, []);

  const resetColumns = useCallback(() => {
    setVisibleColumns({ ...DEFAULT_VISIBLE_COLUMNS });
    setColumnWidths({ ...DEFAULT_COLUMN_WIDTHS });
  }, []);

  const resetAllUiPreferences = useCallback(() => {
    setLayout({ ...DEFAULT_LAYOUT_PREFS });
    setToolbarGroups({ ...DEFAULT_TOOLBAR_GROUPS });
    setVisibleColumns({ ...DEFAULT_VISIBLE_COLUMNS });
    setColumnWidths({ ...DEFAULT_COLUMN_WIDTHS });
    clearPersistedPanelLayouts();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(FLUX_PANEL_LAYOUT_RESET_EVENT));
      window.setTimeout(() => {
        clearPersistedPanelLayouts();
      }, 150);
    }
  }, []);

  const resolvedInspectorSplitDirection = resolveInspectorSplitDirection(
    layout.inspectorSplitDirection,
    layout.inspectorPosition
  );

  return {
    layout,
    compactToolbar: layout.compactToolbar,
    setCompactToolbar,
    toggleCompactToolbar,
    sidebarCollapsed: layout.sidebarCollapsed,
    inspectorCollapsed: layout.inspectorCollapsed,
    inspectorPosition: layout.inspectorPosition,
    inspectorSplitDirection: layout.inspectorSplitDirection,
    resolvedInspectorSplitDirection,
    toggleSidebar,
    setSidebarCollapsed,
    toggleInspector,
    setInspectorCollapsed,
    setInspectorPosition,
    setInspectorSplitDirection,
    toggleInspectorSplitDirection,
    resetPanelLayouts,
    toolbarGroups,
    toggleToolbarGroup,
    setToolbarGroupVisible,
    resetToolbarGroups,
    visibleColumns,
    toggleColumnVisibility,
    columnWidths,
    setColumnWidth,
    setColumnWidths,
    resetColumns,
    resetAllUiPreferences,
  };
}
