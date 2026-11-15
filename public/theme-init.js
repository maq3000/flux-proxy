try {
  const saved = localStorage.getItem("fluxproxy-color-scheme");
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.setAttribute(
      "content",
      saved === "system"
        ? "light dark"
        : saved === "light" || saved === "dark"
          ? saved
          : "dark"
    );
  }
} catch {
  // Ignore restricted storage access
}
