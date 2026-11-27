import { useCallback, useMemo } from "react";
import {
  resolveEffectiveThemeTokens,
  type CustomColorOverrides,
  type StatusFgTokenKey,
  type ThemePreference,
  type ThemePresetId,
  type ThemeTokenKey,
} from "../lib/themePresets";
import {
  CUSTOM_COLOR_OVERRIDES_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_PRESET_STORAGE_KEY,
  useUiStore,
} from "../stores/uiStore";

export {
  CUSTOM_COLOR_OVERRIDES_STORAGE_KEY,
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_PRESET_STORAGE_KEY,
};
export type { StatusFgTokenKey, ThemePreference, ThemePresetId, ThemeTokenKey };

export function useTheme() {
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
