import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "dark" | "light" | "system";

const STORAGE_KEY = "fluxproxy-color-scheme";

function readInitialPreference(): ThemePreference {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
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

function syncMetaColorScheme(pref: ThemePreference) {
  if (typeof document === "undefined") return;
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="color-scheme"]'
  );
  if (meta) {
    meta.content = pref === "system" ? "light dark" : pref;
  }
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    readInitialPreference
  );
  const [systemDark, setSystemDark] = useState<boolean>(getSystemIsDark);

  const resolvedTheme: "dark" | "light" =
    preference === "system" ? (systemDark ? "dark" : "light") : preference;

  useEffect(() => {
    syncMetaColorScheme(preference);
  }, [preference]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      // Update resolved OS state without clearing any pinned user preference
      setSystemDark(e.matches);
    };
    mq.addEventListener("change", handleChange);

    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        const next =
          e.newValue === "light" ||
          e.newValue === "dark" ||
          e.newValue === "system"
            ? e.newValue
            : "dark";
        setPreferenceState(next);
        syncMetaColorScheme(next);
      }
    };
    window.addEventListener("storage", handleStorage);

    return () => {
      mq.removeEventListener("change", handleChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const setTheme = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    syncMetaColorScheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage write errors
    }
  }, []);

  const toggleLightDark = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  return {
    preference,
    resolvedTheme,
    systemDark,
    setTheme,
    toggleLightDark,
  };
}
