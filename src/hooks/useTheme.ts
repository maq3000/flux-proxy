import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  resolveEffectiveThemeTokens,
  type CustomColorOverrides,
  type StatusFgTokenKey,
  type ThemePreference,
  type ThemePresetId,
  type ThemeTokenKey,
} from "../lib/themePresets";
import {
  applyThemeToDocument,
  CUSTOM_COLOR_OVERRIDES_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_PRESET_STORAGE_KEY,
  useUiStore,
} from "../stores/uiStore";
import {
  SETTINGS_APPLIED_EVENT,
  type FluxUserSettingsProfile,
} from "../types/settings";

export {
  CUSTOM_COLOR_OVERRIDES_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_PRESET_STORAGE_KEY,
};
export type { StatusFgTokenKey, ThemePreference, ThemePresetId, ThemeTokenKey };

export function useTheme() {
  const didSyncRef = useRef(false);
  if (!didSyncRef.current) {
    didSyncRef.current = true;
    useUiStore.getState().syncThemeFromLocalStorage();
  }

  const systemDark = useUiStore((s) => s.systemDark);
  const preference = useUiStore((s) => s.preference);
  const themePreset = useUiStore((s) => s.themePreset);
  const customColorOverrides: CustomColorOverrides = useUiStore(
    (s) => s.customColorOverrides
  );
  const setTheme = useUiStore((s) => s.setTheme);
  const setThemePreset = useUiStore((s) => s.setThemePreset);
  const setCustomColorOverride = useUiStore((s) => s.setCustomColorOverride);
  const resetCustomColorOverride = useUiStore(
    (s) => s.resetCustomColorOverride
  );
  const resetCustomColorOverrides = useUiStore(
    (s) => s.resetCustomColorOverrides
  );

  const resolvedPalette = useMemo(
    () =>
      resolveEffectiveThemeTokens(
        themePreset,
        customColorOverrides,
        systemDark,
        preference
      ),
    [themePreset, customColorOverrides, systemDark, preference]
  );

  const resolvedTheme: "dark" | "light" = resolvedPalette.baseScheme;

  useEffect(() => {
    applyThemeToDocument(
      preference,
      themePreset,
      customColorOverrides,
      systemDark
    );
  }, [preference, themePreset, customColorOverrides, systemDark]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      useUiStore.getState().setSystemDark(e.matches);
    };
    mq.addEventListener("change", handleChange);

    const handleStorage = (e: StorageEvent) => {
      useUiStore.getState().applyThemeFromStorageEvent(e);
    };

    const handleSettingsApplied = (event: Event) => {
      const detail = (event as CustomEvent<FluxUserSettingsProfile>).detail;
      if (detail) {
        useUiStore.getState().applyThemeFromSettingsProfile(detail);
      }
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(SETTINGS_APPLIED_EVENT, handleSettingsApplied);

    return () => {
      mq.removeEventListener("change", handleChange);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(SETTINGS_APPLIED_EVENT, handleSettingsApplied);
    };
  }, []);

  const toggleLightDark = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  return {
    preference,
    resolvedTheme,
    systemDark,
    themePreset: resolvedPalette.effectivePresetId,
    customColorOverrides,
    effectiveTokens: resolvedPalette.tokens,
    effectiveStatusBgTokens: resolvedPalette.statusBgTokens,
    setTheme,
    setThemePreset,
    setCustomColorOverride,
    resetCustomColorOverride,
    resetCustomColorOverrides,
    toggleLightDark,
  };
}
