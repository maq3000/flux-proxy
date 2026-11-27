import { beforeAll, describe, expect, it } from "vitest";

let scriptSource = "";

beforeAll(async () => {
  const fsModule = "node:fs";
  const pathModule = "node:path";
  const fs = (await import(/* @vite-ignore */ fsModule)) as {
    readFileSync: (filePath: string, encoding: "utf8") => string;
  };
  const path = (await import(/* @vite-ignore */ pathModule)) as {
    resolve: (...segments: string[]) => string;
  };
  const cwd = (globalThis as unknown as { process: { cwd: () => string } })
    .process.cwd();
  scriptSource = fs.readFileSync(
    path.resolve(cwd, "public/theme-init.js"),
    "utf8"
  );
});

function runThemeInit(
  colorScheme: string | null,
  presetValue: string | null
): string | null {
  window.localStorage.clear();
  if (colorScheme !== null) {
    window.localStorage.setItem("fluxproxy-color-scheme", colorScheme);
  }
  if (presetValue !== null) {
    window.localStorage.setItem("fluxproxy.themePreset.v1", presetValue);
  }
  document.head.innerHTML = '<meta name="color-scheme" content="dark" />';
  // Execute the pre-paint script in the current jsdom window
  new Function(scriptSource)();
  return (
    document
      .querySelector('meta[name="color-scheme"]')
      ?.getAttribute("content") ?? null
  );
}

describe("public/theme-init.js pre-paint scheme synchronization", () => {
  it("uses fiddler-classic light scheme from fluxproxy.themePreset.v1 even when system/dark preference is stored", () => {
    expect(runThemeInit("system", "fiddler-classic")).toBe("light");
    expect(runThemeInit("dark", JSON.stringify("fiddler-classic"))).toBe(
      "light"
    );
  });

  it("forces dark scheme for non-default dark presets (dracula, tokyo-night, nord, github-dark, monokai-pro)", () => {
    for (const preset of [
      "dracula",
      "tokyo-night",
      "nord",
      "github-dark",
      "monokai-pro",
    ]) {
      expect(runThemeInit("light", preset)).toBe("dark");
    }
  });

  it("respects default-light / default-dark and system fallback when no custom preset overrides", () => {
    expect(runThemeInit("system", "default-dark")).toBe("light dark");
    expect(runThemeInit("dark", "default-light")).toBe("light");
    expect(runThemeInit("light", null)).toBe("light");
    expect(runThemeInit("system", null)).toBe("light dark");
    expect(runThemeInit(null, null)).toBe("dark");
  });
});
