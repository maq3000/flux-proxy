try {
  const saved = localStorage.getItem("fluxproxy-color-scheme");
  let preset = localStorage.getItem("fluxproxy.themePreset.v1");
  if (preset) {
    try {
      const parsed = JSON.parse(preset);
      if (typeof parsed === "string") preset = parsed;
    } catch {
      preset = preset.replace(/^"|"$/g, "");
    }
  }
  const NON_DEFAULT_LIGHT_PRESETS = new Set(["fiddler-classic"]);
  const NON_DEFAULT_DARK_PRESETS = new Set([
    "dracula",
    "tokyo-night",
    "nord",
    "github-dark",
    "monokai-pro",
  ]);
  let colorScheme =
    saved === "system"
      ? "light dark"
      : saved === "light" || saved === "dark"
        ? saved
        : "dark";
  if (preset && NON_DEFAULT_LIGHT_PRESETS.has(preset)) {
    colorScheme = "light";
  } else if (preset && NON_DEFAULT_DARK_PRESETS.has(preset)) {
    colorScheme = "dark";
  } else if (preset === "default-light") {
    colorScheme = saved === "system" ? "light dark" : "light";
  } else if (preset === "default-dark") {
    colorScheme = saved === "system" ? "light dark" : "dark";
  }
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.setAttribute("content", colorScheme);
  }
} catch {
  // Ignore restricted storage access
}
