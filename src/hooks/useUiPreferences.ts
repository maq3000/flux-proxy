import { useEffect } from "react";
import {
  clearPersistedPanelLayouts,
  COLUMN_MIN_WIDTHS,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_LAYOUT_PREFS,
  DEFAULT_TOOLBAR_GROUPS,
  DEFAULT_VISIBLE_COLUMNS,
  FLUX_PANEL_AUTOSAVE_IDS,
  FLUX_PANEL_LAYOUT_RESET_EVENT,
  FLUX_PANEL_STORAGE_PREFIX,
  readPersistedPanelLayouts,
  resolveInspectorSplitDirection,
  SAFE_PANEL_STORAGE,
  TOOLBAR_GROUP_DEFINITIONS,
  TRAFFIC_COLUMNS,
  useUiStore,
  writePersistedPanelLayouts,
  type ColumnDefinition,
  type InspectorSplitDirection,
  type ToolbarGroupDefinition,
} from "../stores/uiStore";
import {
  SETTINGS_APPLIED_EVENT,
  type FluxUserSettingsProfile,
} from "../types/settings";

export {
  clearPersistedPanelLayouts,
  COLUMN_MIN_WIDTHS,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_LAYOUT_PREFS,
  DEFAULT_TOOLBAR_GROUPS,
  DEFAULT_VISIBLE_COLUMNS,
  FLUX_PANEL_AUTOSAVE_IDS,
  FLUX_PANEL_LAYOUT_RESET_EVENT,
  FLUX_PANEL_STORAGE_PREFIX,
  readPersistedPanelLayouts,
  resolveInspectorSplitDirection,
  SAFE_PANEL_STORAGE,
  TOOLBAR_GROUP_DEFINITIONS,
  TRAFFIC_COLUMNS,
  writePersistedPanelLayouts,
};
export type { ColumnDefinition, InspectorSplitDirection, ToolbarGroupDefinition };

export function useUiPreferences() {
  useEffect(() => {
    useUiStore.getState().syncUiFromLocalStorage();
  }, []);

  const layout = useUiStore((s) => s.layout);
  const toolbarGroups = useUiStore((s) => s.toolbarGroups);
  const visibleColumns = useUiStore((s) => s.visibleColumns);
  const columnWidths = useUiStore((s) => s.columnWidths);

  const setCompactToolbar = useUiStore((s) => s.setCompactToolbar);
  const toggleCompactToolbar = useUiStore((s) => s.toggleCompactToolbar);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const toggleInspector = useUiStore((s) => s.toggleInspector);
  const setInspectorCollapsed = useUiStore((s) => s.setInspectorCollapsed);
  const setInspectorPosition = useUiStore((s) => s.setInspectorPosition);
  const setInspectorSplitDirection = useUiStore(
    (s) => s.setInspectorSplitDirection
  );
  const toggleInspectorSplitDirection = useUiStore(
    (s) => s.toggleInspectorSplitDirection
  );
  const resetPanelLayouts = useUiStore((s) => s.resetPanelLayouts);
  const toggleToolbarGroup = useUiStore((s) => s.toggleToolbarGroup);
  const setToolbarGroupVisible = useUiStore((s) => s.setToolbarGroupVisible);
  const resetToolbarGroups = useUiStore((s) => s.resetToolbarGroups);
  const toggleColumnVisibility = useUiStore((s) => s.toggleColumnVisibility);
  const setColumnWidth = useUiStore((s) => s.setColumnWidth);
  const setColumnWidths = useUiStore((s) => s.setColumnWidths);
  const resetColumns = useUiStore((s) => s.resetColumns);
  const resetAllUiPreferences = useUiStore((s) => s.resetAllUiPreferences);

  useEffect(() => {
    const handleSettingsApplied = (event: Event) => {
      const detail = (event as CustomEvent<FluxUserSettingsProfile>).detail;
      if (detail) {
        useUiStore.getState().applyUiFromSettingsProfile(detail);
      }
    };

    window.addEventListener(SETTINGS_APPLIED_EVENT, handleSettingsApplied);
    return () => {
      window.removeEventListener(SETTINGS_APPLIED_EVENT, handleSettingsApplied);
    };
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
