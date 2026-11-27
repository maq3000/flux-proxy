import { useEffect } from "react";
import { applyThemeToDocument, useUiStore } from "../stores/uiStore";
import {
  SETTINGS_APPLIED_EVENT,
  type FluxUserSettingsProfile,
} from "../types/settings";

/**
 * Registers singleton global `window` and DOM synchronization listeners once at the root shell (`App`):
 * - initial hydration of `theme` and `uiPreferences` slices from `localStorage`
 * - imperative `applyThemeToDocument` sync via `useUiStore.subscribe` (zero component re-renders)
 * - single `matchMedia("(prefers-color-scheme: dark)")` listener
 * - single cross-tab `"storage"` listener
 * - single `SETTINGS_APPLIED_EVENT` listener updating both theme and UI preferences atomically
 */
export function useStoreGlobalSync(): void {
  useEffect(() => {
    const store = useUiStore.getState();
    store.syncThemeFromLocalStorage();
    store.syncUiFromLocalStorage();

    const syncThemeDom = () => {
      const current = useUiStore.getState();
      applyThemeToDocument(
        current.preference,
        current.themePreset,
        current.customColorOverrides,
        current.systemDark
      );
    };
    syncThemeDom();

    const unsubscribeUiStore = useUiStore.subscribe((state, prev) => {
      if (
        state.preference !== prev.preference ||
        state.themePreset !== prev.themePreset ||
        state.customColorOverrides !== prev.customColorOverrides ||
        state.systemDark !== prev.systemDark
      ) {
        applyThemeToDocument(
          state.preference,
          state.themePreset,
          state.customColorOverrides,
          state.systemDark
        );
      }
    });

    const mq =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    const handleMediaChange = (e: MediaQueryListEvent) => {
      useUiStore.getState().setSystemDark(e.matches);
    };
    mq?.addEventListener?.("change", handleMediaChange);

    const handleStorage = (e: StorageEvent) => {
      useUiStore.getState().applyThemeFromStorageEvent(e);
    };

    const handleSettingsApplied = (event: Event) => {
      const detail = (event as CustomEvent<FluxUserSettingsProfile>).detail;
      if (detail) {
        const ui = useUiStore.getState();
        ui.applyThemeFromSettingsProfile(detail);
        ui.applyUiFromSettingsProfile(detail);
      }
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(SETTINGS_APPLIED_EVENT, handleSettingsApplied);

    return () => {
      unsubscribeUiStore();
      mq?.removeEventListener?.("change", handleMediaChange);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(SETTINGS_APPLIED_EVENT, handleSettingsApplied);
    };
  }, []);
}
