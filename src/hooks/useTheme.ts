import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  SETTINGS_APPLIED_EVENT,
  type FluxUserSettingsProfile,
} from "../types/settings";

export type { ThemePreference };

export const THEME_PREFERENCE_STORAGE_KEY = "fluxproxy-color-scheme";
export const THEME_PRESET_STORAGE_KEY = "fluxproxy.themePreset.v1";
export const CUSTOM_COLOR_OVERRIDES_STORAGE_KEY =
  "fluxproxy.customColorOverrides.v1";

function readInitialPreference(): ThemePreference {
  try {
    const val = localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY);
    if (val === "dark" || val === "light" || val === "system") return val;
  } catch {
    // Ignore restricted storage
  }
  return "dark"; // Explicit dark default per product specification
}

function getSystemIsDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readInitialThemePreset(
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

function readInitialCustomColorOverrides(): CustomColorOverrides {
  try {
    const raw = localStorage.getItem(CUSTOM_COLOR_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    return sanitizeCustomColorOverrides(JSON.parse(raw) as unknown);
  } catch {
    return {};
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

function applyThemeToDocument(
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

export function useTheme() {
  const [systemDark, setSystemDark] = useState<boolean>(getSystemIsDark);
  const [preference, setPreferenceState] = useState<ThemePreference>(
    readInitialPreference
  );
  const [themePreset, setThemePresetState] = useState<ThemePresetId>(() =>
    readInitialThemePreset(readInitialPreference(), getSystemIsDark())
  );
  const [customColorOverrides, setCustomColorOverridesState] =
    useState<CustomColorOverrides>(readInitialCustomColorOverrides);

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
      // Update resolved OS state without clearing any pinned user preference
      setSystemDark(e.matches);
    };
    mq.addEventListener("change", handleChange);

    const handleStorage = (e: StorageEvent) => {
      if (e.key === THEME_PREFERENCE_STORAGE_KEY) {
        const nextPref: ThemePreference =
          e.newValue === "light" ||
          e.newValue === "dark" ||
          e.newValue === "system"
            ? e.newValue
            : "dark";
        setPreferenceState(nextPref);
      } else if (e.key === THEME_PRESET_STORAGE_KEY) {
        if (isThemePresetId(e.newValue)) {
          setThemePresetState(e.newValue);
        } else {
          setThemePresetState("default-dark");
        }
      } else if (e.key === CUSTOM_COLOR_OVERRIDES_STORAGE_KEY) {
        try {
          const parsed = e.newValue ? (JSON.parse(e.newValue) as unknown) : {};
          setCustomColorOverridesState(sanitizeCustomColorOverrides(parsed));
        } catch {
          setCustomColorOverridesState({});
        }
      }
    };

    const handleSettingsApplied = (event: Event) => {
      const detail = (event as CustomEvent<FluxUserSettingsProfile>).detail;
      if (!detail?.ui) return;

      const nextPref = detail.ui.theme;
      if (
        nextPref === "dark" ||
        nextPref === "light" ||
        nextPref === "system"
      ) {
        setPreferenceState(nextPref);
      }

      if (isThemePresetId(detail.ui.themePreset)) {
        setThemePresetState(detail.ui.themePreset);
      } else if (nextPref === "light") {
        setThemePresetState("default-light");
      } else if (nextPref === "dark") {
        setThemePresetState("default-dark");
      } else if (nextPref === "system") {
        setThemePresetState(
          getSystemIsDark() ? "default-dark" : "default-light"
        );
      }

      setCustomColorOverridesState(
        sanitizeCustomColorOverrides(detail.ui.customColorOverrides)
      );
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(SETTINGS_APPLIED_EVENT, handleSettingsApplied);

    return () => {
      mq.removeEventListener("change", handleChange);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(SETTINGS_APPLIED_EVENT, handleSettingsApplied);
    };
  }, []);

  const persistPreference = useCallback((next: ThemePreference) => {
    try {
      localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, next);
    } catch {
      // Ignore storage write errors
    }
  }, []);

  const persistThemePreset = useCallback((next: ThemePresetId) => {
    try {
      localStorage.setItem(THEME_PRESET_STORAGE_KEY, next);
    } catch {
      // Ignore storage write errors
    }
  }, []);

  const persistCustomOverrides = useCallback((next: CustomColorOverrides) => {
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
  }, []);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      setPreferenceState(next);
      persistPreference(next);

      setThemePresetState((prevPreset) => {
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
        return targetPreset;
      });
    },
    [persistPreference, persistThemePreset, systemDark]
  );

  const setThemePreset = useCallback(
    (nextPreset: ThemePresetId) => {
      const def =
        THEME_PRESETS_BY_ID[nextPreset] ?? THEME_PRESETS_BY_ID["default-dark"];
      setThemePresetState(def.id);
      persistThemePreset(def.id);
      setPreferenceState(def.baseScheme);
      persistPreference(def.baseScheme);
    },
    [persistPreference, persistThemePreset]
  );

  const setCustomColorOverride = useCallback(
    (token: ThemeTokenKey, hexValue: string) => {
      const normalized = normalizeHexColor(hexValue);
      if (!normalized) return;
      setCustomColorOverridesState((prev) => {
        const next: CustomColorOverrides = { ...prev, [token]: normalized };
        persistCustomOverrides(next);
        return next;
      });
    },
    [persistCustomOverrides]
  );

  const resetCustomColorOverride = useCallback(
    (token: ThemeTokenKey) => {
      setCustomColorOverridesState((prev) => {
        if (!(token in prev)) return prev;
        const next = { ...prev };
        delete next[token];
        persistCustomOverrides(next);
        return next;
      });
    },
    [persistCustomOverrides]
  );

  const resetCustomColorOverrides = useCallback(() => {
    setCustomColorOverridesState({});
    persistCustomOverrides({});
  }, [persistCustomOverrides]);

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

export type { StatusFgTokenKey, ThemePresetId, ThemeTokenKey };
