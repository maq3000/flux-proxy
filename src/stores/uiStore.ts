import { create } from "zustand";
import type { PanelGroupStorage } from "react-resizable-panels";
import { syncMonacoTheme } from "../lib/monaco";
import {
  ALL_MANAGED_CSS_VARIABLES,
  ALL_THEME_TOKEN_KEYS,
  STATUS_FG_TO_BG_MAP,
  THEME_PRESETS_BY_ID,
  isThemePresetId,
  normalizeHexColor,
  resolveEffectiveThemeTokens,
  sanitizeCustomColorOverrides,
  type CustomColorOverrides,
  type StatusBgTokenKey,
  type StatusFgTokenKey,
  type ThemePreference,
  type ThemePresetId,
  type ThemeTokenKey,
} from "../lib/themePresets";
import type {
  ActiveNavSection,
  ColumnId,
  InspectorDockPosition,
  InspectorSplitDirection,
  ToolbarGroupId,
  UiLayoutPreferences,
} from "../types/proxy";
import type { FluxUserSettingsProfile } from "../types/settings";

export type {
  CustomColorOverrides,
  InspectorSplitDirection,
  StatusFgTokenKey,
  ThemePreference,
  ThemePresetId,
  ThemeTokenKey,
};

export const THEME_PREFERENCE_STORAGE_KEY = "fluxproxy-color-scheme";
export const THEME_PRESET_STORAGE_KEY = "fluxproxy.themePreset.v1";
export const CUSTOM_COLOR_OVERRIDES_STORAGE_KEY =
  "fluxproxy.customColorOverrides.v1";

export const FLUX_PANEL_AUTOSAVE_IDS = {
  bottomOuter: "flux-layout-bottom-outer-v1",
  bottomInner: "flux-layout-bottom-inner-v1",
  right: "flux-layout-right-v1",
  inspectorSplit: "flux-inspector-split-v1",
} as const;

export const FLUX_PANEL_STORAGE_PREFIX = "react-resizable-panels:flux-";
export const FLUX_PANEL_LAYOUT_RESET_EVENT = "fluxproxy:panel-layout-reset";

export const LS_LAYOUT_KEY = "fluxproxy.uiLayout.v1";
export const LS_TOOLBAR_GROUPS_KEY = "fluxproxy.toolbarGroups.v1";
export const LS_VISIBLE_COLUMNS_KEY = "fluxproxy.visibleColumns.v1";
export const LS_COLUMN_WIDTHS_KEY = "fluxproxy.columnWidths.v1";

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
  defaultVisible?: boolean;
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
    id: "ttfb",
    label: "TTFB",
    defaultWidth: 74,
    minWidth: 56,
    maxAutoFitWidth: 120,
    align: "right",
    defaultVisible: false,
  },
  {
    id: "serverIp",
    label: "Server IP",
    defaultWidth: 128,
    minWidth: 84,
    maxAutoFitWidth: 260,
    defaultVisible: false,
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
      acc[col.id] = col.defaultVisible ?? true;
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

export function sanitizeSplitDirection(val: unknown): InspectorSplitDirection {
  return val === "horizontal" || val === "vertical" || val === "auto"
    ? val
    : "auto";
}

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

export function getSystemIsDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function readInitialPreference(): ThemePreference {
  try {
    const val = localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY);
    if (val === "dark" || val === "light" || val === "system") return val;
  } catch {
    // Ignore restricted storage
  }
  return "dark";
}

export function readInitialThemePreset(
  initialPref: ThemePreference,
  systemDark: boolean
): ThemePresetId {
  try {
    const raw = localStorage.getItem(THEME_PRESET_STORAGE_KEY);
    if (isThemePresetId(raw)) return raw;
  } catch {
    // Ignore restricted storage
  }
  if (initialPref === "light") return "default-light";
  if (initialPref === "system") {
    return systemDark ? "default-dark" : "default-light";
  }
  return "default-dark";
}

export function readInitialCustomColorOverrides(): CustomColorOverrides {
  try {
    const raw = localStorage.getItem(CUSTOM_COLOR_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    return sanitizeCustomColorOverrides(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

function readInitialLayout(): UiLayoutPreferences {
  const saved = loadJson<Partial<UiLayoutPreferences>>(LS_LAYOUT_KEY, {});
  return {
    compactToolbar: Boolean(saved.compactToolbar ?? false),
    sidebarCollapsed: Boolean(saved.sidebarCollapsed ?? false),
    inspectorCollapsed: Boolean(saved.inspectorCollapsed ?? false),
    inspectorPosition: saved.inspectorPosition === "right" ? "right" : "bottom",
    inspectorSplitDirection: sanitizeSplitDirection(
      saved.inspectorSplitDirection
    ),
  };
}

function readInitialToolbarGroups(): Record<ToolbarGroupId, boolean> {
  const saved = loadJson<Partial<Record<ToolbarGroupId, boolean>>>(
    LS_TOOLBAR_GROUPS_KEY,
    {}
  );
  return {
    ...DEFAULT_TOOLBAR_GROUPS,
    ...saved,
  };
}

function readInitialVisibleColumns(): Record<ColumnId, boolean> {
  const saved = loadJson<Partial<Record<ColumnId, boolean>>>(
    LS_VISIBLE_COLUMNS_KEY,
    {}
  );
  const merged: Record<ColumnId, boolean> = {
    ...DEFAULT_VISIBLE_COLUMNS,
    ...saved,
  };
  if (!Object.values(merged).some(Boolean)) {
    merged.id = true;
    merged.url = true;
  }
  return merged;
}

function readInitialColumnWidths(): Record<ColumnId, number> {
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

function persistJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage quota errors
  }
}

function persistPreference(next: ThemePreference): void {
  try {
    localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, next);
  } catch {
    // Ignore storage write errors
  }
}

function persistThemePreset(next: ThemePresetId): void {
  try {
    localStorage.setItem(THEME_PRESET_STORAGE_KEY, next);
  } catch {
    // Ignore storage write errors
  }
}

function persistCustomOverrides(next: CustomColorOverrides): void {
  try {
    if (Object.keys(next).length === 0) {
      localStorage.removeItem(CUSTOM_COLOR_OVERRIDES_STORAGE_KEY);
    } else {
      localStorage.setItem(
        CUSTOM_COLOR_OVERRIDES_STORAGE_KEY,
        JSON.stringify(next)
      );
    }
  } catch {
    // Ignore storage write errors
  }
}

function syncMetaColorScheme(content: "dark" | "light" | "light dark") {
  if (typeof document === "undefined") return;
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="color-scheme"]'
  );
  if (meta) {
    meta.content = content;
  }
}

export function applyThemeToDocument(
  preference: ThemePreference,
  themePreset: ThemePresetId,
  overrides: CustomColorOverrides,
  systemDark: boolean
) {
  const resolved = resolveEffectiveThemeTokens(
    themePreset,
    overrides,
    systemDark,
    preference
  );

  if (typeof document !== "undefined") {
    const rootStyle = document.documentElement.style;
    if (resolved.isDefaultBaseline) {
      for (const cssVar of ALL_MANAGED_CSS_VARIABLES) {
        rootStyle.removeProperty(cssVar);
      }
      syncMetaColorScheme(
        preference === "system" ? "light dark" : resolved.baseScheme
      );
    } else {
      syncMetaColorScheme(resolved.baseScheme);
      for (const key of ALL_THEME_TOKEN_KEYS) {
        rootStyle.setProperty(key, resolved.tokens[key]);
      }
      for (const bgKey of Object.values(
        STATUS_FG_TO_BG_MAP
      ) as StatusBgTokenKey[]) {
        rootStyle.setProperty(bgKey, resolved.statusBgTokens[bgKey]);
      }
    }
  }

  syncMonacoTheme(resolved.baseScheme, resolved.tokens);
  return resolved;
}

type Updater<T> = T | ((prev: T) => T);

function resolveUpdater<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === "function"
    ? (updater as (p: T) => T)(prev)
    : updater;
}

export interface UiStoreState {
  // Theme state
  systemDark: boolean;
  preference: ThemePreference;
  themePreset: ThemePresetId;
  customColorOverrides: CustomColorOverrides;

  // Layout & Table state
  layout: UiLayoutPreferences;
  toolbarGroups: Record<ToolbarGroupId, boolean>;
  visibleColumns: Record<ColumnId, boolean>;
  columnWidths: Record<ColumnId, number>;

  // App shell view state
  activeSection: ActiveNavSection;
  dockedComposer: boolean;

  // Theme actions
  syncThemeFromLocalStorage: () => void;
  setSystemDark: (systemDark: boolean) => void;
  setTheme: (next: ThemePreference) => void;
  setThemePreset: (nextPreset: ThemePresetId) => void;
  setCustomColorOverride: (token: ThemeTokenKey, hexValue: string) => void;
  resetCustomColorOverride: (token: ThemeTokenKey) => void;
  resetCustomColorOverrides: () => void;
  applyThemeFromStorageEvent: (e: StorageEvent) => void;
  applyThemeFromSettingsProfile: (profile: FluxUserSettingsProfile) => void;

  // UI preference actions
  syncUiFromLocalStorage: () => void;
  setLayout: (updater: Updater<UiLayoutPreferences>) => void;
  setToolbarGroups: (updater: Updater<Record<ToolbarGroupId, boolean>>) => void;
  setVisibleColumns: (updater: Updater<Record<ColumnId, boolean>>) => void;
  setColumnWidthsState: (updater: Updater<Record<ColumnId, number>>) => void;
  applyUiFromSettingsProfile: (profile: FluxUserSettingsProfile) => void;
  setCompactToolbar: (compact: boolean) => void;
  toggleCompactToolbar: () => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleInspector: () => void;
  setInspectorCollapsed: (collapsed: boolean) => void;
  setInspectorPosition: (pos: InspectorDockPosition) => void;
  setInspectorSplitDirection: (dir: InspectorSplitDirection) => void;
  toggleInspectorSplitDirection: () => void;
  resetPanelLayouts: () => void;
  toggleToolbarGroup: (groupId: ToolbarGroupId) => void;
  setToolbarGroupVisible: (groupId: ToolbarGroupId, visible: boolean) => void;
  resetToolbarGroups: () => void;
  toggleColumnVisibility: (colId: ColumnId) => void;
  setColumnWidth: (colId: ColumnId, width: number) => void;
  setColumnWidths: (widths: Updater<Record<ColumnId, number>>) => void;
  resetColumns: () => void;
  resetAllUiPreferences: () => void;

  // Shell actions
  setActiveSection: (updater: Updater<ActiveNavSection>) => void;
  setDockedComposer: (updater: Updater<boolean>) => void;
}

const initialSystemDark = getSystemIsDark();
const initialPreference = readInitialPreference();

export const useUiStore = create<UiStoreState>((set, get) => ({
  systemDark: initialSystemDark,
  preference: initialPreference,
  themePreset: readInitialThemePreset(initialPreference, initialSystemDark),
  customColorOverrides: readInitialCustomColorOverrides(),

  layout: readInitialLayout(),
  toolbarGroups: readInitialToolbarGroups(),
  visibleColumns: readInitialVisibleColumns(),
  columnWidths: readInitialColumnWidths(),

  activeSection: "traffic",
  dockedComposer: false,

  syncThemeFromLocalStorage: () => {
    const sysDark = getSystemIsDark();
    const pref = readInitialPreference();
    const preset = readInitialThemePreset(pref, sysDark);
    const overrides = readInitialCustomColorOverrides();
    set({
      systemDark: sysDark,
      preference: pref,
      themePreset: preset,
      customColorOverrides: overrides,
    });
  },

  setSystemDark: (systemDark) => set({ systemDark }),

  setTheme: (next) => {
    const { themePreset: prevPreset, systemDark } = get();
    persistPreference(next);
    const currentDef = THEME_PRESETS_BY_ID[prevPreset];
    let targetPreset = prevPreset;
    if (next === "dark" && currentDef.baseScheme !== "dark") {
      targetPreset = "default-dark";
    } else if (next === "light" && currentDef.baseScheme !== "light") {
      targetPreset = "default-light";
    } else if (
      next === "system" &&
      prevPreset !== "default-dark" &&
      prevPreset !== "default-light"
    ) {
      targetPreset = systemDark ? "default-dark" : "default-light";
    }
    if (targetPreset !== prevPreset) {
      persistThemePreset(targetPreset);
    }
    set({ preference: next, themePreset: targetPreset });
  },

  setThemePreset: (nextPreset) => {
    const def =
      THEME_PRESETS_BY_ID[nextPreset] ?? THEME_PRESETS_BY_ID["default-dark"];
    persistThemePreset(def.id);
    persistPreference(def.baseScheme);
    set({ themePreset: def.id, preference: def.baseScheme });
  },

  setCustomColorOverride: (token, hexValue) => {
    const normalized = normalizeHexColor(hexValue);
    if (!normalized) return;
    set((state) => {
      const next: CustomColorOverrides = {
        ...state.customColorOverrides,
        [token]: normalized,
      };
      persistCustomOverrides(next);
      return { customColorOverrides: next };
    });
  },

  resetCustomColorOverride: (token) => {
    set((state) => {
      if (!(token in state.customColorOverrides)) return state;
      const next = { ...state.customColorOverrides };
      delete next[token];
      persistCustomOverrides(next);
      return { customColorOverrides: next };
    });
  },

  resetCustomColorOverrides: () => {
    persistCustomOverrides({});
    set({ customColorOverrides: {} });
  },

  applyThemeFromStorageEvent: (e) => {
    if (e.key === THEME_PREFERENCE_STORAGE_KEY) {
      const nextPref: ThemePreference =
        e.newValue === "light" ||
        e.newValue === "dark" ||
        e.newValue === "system"
          ? e.newValue
          : "dark";
      set({ preference: nextPref });
    } else if (e.key === THEME_PRESET_STORAGE_KEY) {
      set({
        themePreset: isThemePresetId(e.newValue) ? e.newValue : "default-dark",
      });
    } else if (e.key === CUSTOM_COLOR_OVERRIDES_STORAGE_KEY) {
      try {
        const parsed = e.newValue ? (JSON.parse(e.newValue) as unknown) : {};
        set({ customColorOverrides: sanitizeCustomColorOverrides(parsed) });
      } catch {
        set({ customColorOverrides: {} });
      }
    }
  },

  applyThemeFromSettingsProfile: (detail) => {
    if (!detail?.ui) return;
    const nextPref = detail.ui.theme;
    const updates: Partial<UiStoreState> = {
      customColorOverrides: sanitizeCustomColorOverrides(
        detail.ui.customColorOverrides
      ),
    };
    if (
      nextPref === "dark" ||
      nextPref === "light" ||
      nextPref === "system"
    ) {
      updates.preference = nextPref;
    }
    if (isThemePresetId(detail.ui.themePreset)) {
      updates.themePreset = detail.ui.themePreset;
    } else if (nextPref === "light") {
      updates.themePreset = "default-light";
    } else if (nextPref === "dark") {
      updates.themePreset = "default-dark";
    } else if (nextPref === "system") {
      updates.themePreset = getSystemIsDark()
        ? "default-dark"
        : "default-light";
    }
    set(updates);
  },

  syncUiFromLocalStorage: () => {
    set({
      layout: readInitialLayout(),
      toolbarGroups: readInitialToolbarGroups(),
      visibleColumns: readInitialVisibleColumns(),
      columnWidths: readInitialColumnWidths(),
    });
  },

  setLayout: (updater) => {
    set((state) => {
      const next = resolveUpdater(updater, state.layout);
      persistJson(LS_LAYOUT_KEY, next);
      return { layout: next };
    });
  },

  setToolbarGroups: (updater) => {
    set((state) => {
      const next = resolveUpdater(updater, state.toolbarGroups);
      persistJson(LS_TOOLBAR_GROUPS_KEY, next);
      return { toolbarGroups: next };
    });
  },

  setVisibleColumns: (updater) => {
    set((state) => {
      const next = resolveUpdater(updater, state.visibleColumns);
      persistJson(LS_VISIBLE_COLUMNS_KEY, next);
      return { visibleColumns: next };
    });
  },

  setColumnWidthsState: (updater) => {
    set((state) => {
      const next = resolveUpdater(updater, state.columnWidths);
      persistJson(LS_COLUMN_WIDTHS_KEY, next);
      return { columnWidths: next };
    });
  },

  applyUiFromSettingsProfile: (detail) => {
    if (!detail?.ui) return;
    const nextLayout: UiLayoutPreferences = {
      compactToolbar: Boolean(detail.ui.compactToolbar),
      sidebarCollapsed: Boolean(detail.ui.sidebarCollapsed),
      inspectorCollapsed: Boolean(detail.ui.inspectorCollapsed),
      inspectorPosition:
        detail.ui.inspectorPosition === "right" ? "right" : "bottom",
      inspectorSplitDirection: sanitizeSplitDirection(
        detail.ui.inspectorSplitDirection
      ),
    };
    const nextToolbarGroups: Record<ToolbarGroupId, boolean> = {
      ...DEFAULT_TOOLBAR_GROUPS,
      ...detail.ui.toolbarGroups,
    };
    const nextVisibleColumns: Record<ColumnId, boolean> = {
      ...DEFAULT_VISIBLE_COLUMNS,
      ...detail.ui.visibleColumns,
    };
    const nextColumnWidths: Record<ColumnId, number> = {
      ...DEFAULT_COLUMN_WIDTHS,
      ...detail.ui.columnWidths,
    };
    set({
      layout: nextLayout,
      toolbarGroups: nextToolbarGroups,
      visibleColumns: nextVisibleColumns,
      columnWidths: nextColumnWidths,
    });
  },

  setCompactToolbar: (compact) => {
    get().setLayout((prev) => ({ ...prev, compactToolbar: compact }));
  },

  toggleCompactToolbar: () => {
    get().setLayout((prev) => ({
      ...prev,
      compactToolbar: !prev.compactToolbar,
    }));
  },

  toggleSidebar: () => {
    get().setLayout((prev) => ({
      ...prev,
      sidebarCollapsed: !prev.sidebarCollapsed,
    }));
  },

  setSidebarCollapsed: (collapsed) => {
    get().setLayout((prev) => ({ ...prev, sidebarCollapsed: collapsed }));
  },

  toggleInspector: () => {
    get().setLayout((prev) => ({
      ...prev,
      inspectorCollapsed: !prev.inspectorCollapsed,
    }));
  },

  setInspectorCollapsed: (collapsed) => {
    get().setLayout((prev) => ({ ...prev, inspectorCollapsed: collapsed }));
  },

  setInspectorPosition: (pos) => {
    get().setLayout((prev) => ({
      ...prev,
      inspectorPosition: pos,
      inspectorCollapsed: false,
    }));
  },

  setInspectorSplitDirection: (dir) => {
    get().setLayout((prev) => ({
      ...prev,
      inspectorSplitDirection: sanitizeSplitDirection(dir),
    }));
  },

  toggleInspectorSplitDirection: () => {
    get().setLayout((prev) => {
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
  },

  resetPanelLayouts: () => {
    clearPersistedPanelLayouts();
    get().setLayout((prev) => ({
      ...prev,
      inspectorSplitDirection: "auto",
    }));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(FLUX_PANEL_LAYOUT_RESET_EVENT));
      window.setTimeout(() => {
        clearPersistedPanelLayouts();
      }, 150);
    }
  },

  toggleToolbarGroup: (groupId) => {
    get().setToolbarGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  },

  setToolbarGroupVisible: (groupId, visible) => {
    get().setToolbarGroups((prev) => ({
      ...prev,
      [groupId]: visible,
    }));
  },

  resetToolbarGroups: () => {
    get().setToolbarGroups({ ...DEFAULT_TOOLBAR_GROUPS });
  },

  toggleColumnVisibility: (colId) => {
    get().setVisibleColumns((prev) => {
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
  },

  setColumnWidth: (colId, width) => {
    const min = COLUMN_MIN_WIDTHS[colId] ?? 48;
    const clamped = Math.max(min, Math.round(width));
    get().setColumnWidthsState((prev) =>
      prev[colId] === clamped ? prev : { ...prev, [colId]: clamped }
    );
  },

  setColumnWidths: (widths) => {
    get().setColumnWidthsState(widths);
  },

  resetColumns: () => {
    get().setVisibleColumns({ ...DEFAULT_VISIBLE_COLUMNS });
    get().setColumnWidthsState({ ...DEFAULT_COLUMN_WIDTHS });
  },

  resetAllUiPreferences: () => {
    get().setLayout({ ...DEFAULT_LAYOUT_PREFS });
    get().setToolbarGroups({ ...DEFAULT_TOOLBAR_GROUPS });
    get().setVisibleColumns({ ...DEFAULT_VISIBLE_COLUMNS });
    get().setColumnWidthsState({ ...DEFAULT_COLUMN_WIDTHS });
    clearPersistedPanelLayouts();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(FLUX_PANEL_LAYOUT_RESET_EVENT));
      window.setTimeout(() => {
        clearPersistedPanelLayouts();
      }, 150);
    }
  },

  setActiveSection: (updater) => {
    set((state) => ({
      activeSection: resolveUpdater(updater, state.activeSection),
    }));
  },

  setDockedComposer: (updater) => {
    set((state) => ({
      dockedComposer: resolveUpdater(updater, state.dockedComposer),
    }));
  },
}));
