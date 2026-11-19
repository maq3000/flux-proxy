import { describe, expect, it } from "vitest";
import {
  ALL_THEME_TOKEN_KEYS,
  THEME_PRESETS,
  THEME_PRESETS_BY_ID,
  THEME_TOKEN_GROUPS,
  deriveSelectedBgHex,
  hexToRgbaString,
  isThemePresetId,
  normalizeHexColor,
  resolveEffectiveThemeTokens,
  sanitizeCustomColorOverrides,
} from "./themePresets";

describe("themePresets — catalog integrity & color utilities", () => {
  it("defines 8 complete theme presets covering every CSS token and 5 swatches", () => {
    expect(THEME_PRESETS).toHaveLength(8);
    for (const preset of THEME_PRESETS) {
      expect(THEME_PRESETS_BY_ID[preset.id]).toBe(preset);
      expect(preset.swatches).toHaveLength(5);
      for (const swatch of preset.swatches) {
        expect(normalizeHexColor(swatch)).not.toBeNull();
      }
      for (const key of ALL_THEME_TOKEN_KEYS) {
        expect(normalizeHexColor(preset.tokens[key])).not.toBeNull();
      }
    }

    const groupedKeys = THEME_TOKEN_GROUPS.flatMap((g) =>
      g.fields.map((f) => f.key)
    );
    expect(new Set(groupedKeys).size).toBe(ALL_THEME_TOKEN_KEYS.length);
  });

  it("validates preset IDs and normalizes 3/6-digit hex colors", () => {
    expect(isThemePresetId("tokyo-night")).toBe(true);
    expect(isThemePresetId("unknown-theme")).toBe(false);
    expect(isThemePresetId(null)).toBe(false);

    expect(normalizeHexColor(" #ABC ")).toBe("#aabbcc");
    expect(normalizeHexColor("1A2B3C")).toBe("#1a2b3c");
    expect(normalizeHexColor("#12345")).toBeNull();
    expect(normalizeHexColor("rgb(0,0,0)")).toBeNull();
  });

  it("converts hex colors to CSS rgb(R G B / alpha) strings with clamped alpha", () => {
    expect(hexToRgbaString("#ff8000", 0.25)).toBe("rgb(255 128 0 / 0.25)");
    expect(hexToRgbaString("#000", -0.5)).toBe("rgb(0 0 0 / 0)");
    expect(hexToRgbaString("#fff", 2)).toBe("rgb(255 255 255 / 1)");
    expect(hexToRgbaString("#fff", Number.NaN)).toBe("rgb(255 255 255 / 1)");
    expect(hexToRgbaString("invalid", 0.5)).toBe("rgb(128 128 128 / 0.5)");
  });

  it("derives --bg-selected by blending accent into canvas according to dark/light scheme", () => {
    const darkBlend = deriveSelectedBgHex("#ffffff", "#000000", "dark");
    const lightBlend = deriveSelectedBgHex("#ffffff", "#000000", "light");
    expect(darkBlend).toBe("#333333"); // 0.2 * 255 = 51 = 0x33
    expect(lightBlend).toBe("#292929"); // 0.16 * 255 = 40.8 -> 41 = 0x29
  });

  it("sanitizes custom color overrides and strips invalid keys/values", () => {
    expect(sanitizeCustomColorOverrides(null)).toEqual({});
    expect(sanitizeCustomColorOverrides(["#fff"])).toEqual({});
    expect(
      sanitizeCustomColorOverrides({
        "--accent-primary": " #F0A ",
        "--bg-canvas": "not-a-color",
        "--not-a-token": "#112233",
        "--text-primary": 123,
      })
    ).toEqual({
      "--accent-primary": "#ff00aa",
    });
  });

  it("resolves effective tokens for system mode, pinned presets, overrides, and baseline flag", () => {
    const sysLight = resolveEffectiveThemeTokens("default-dark", {}, false, "system");
    expect(sysLight.effectivePresetId).toBe("default-light");
    expect(sysLight.baseScheme).toBe("light");
    expect(sysLight.isDefaultBaseline).toBe(true);
    expect(sysLight.statusBgTokens["--status-2xx-bg"]).toContain("/ 0.11)");

    const sysDracula = resolveEffectiveThemeTokens("dracula", {}, false, "system");
    expect(sysDracula.effectivePresetId).toBe("dracula");
    expect(sysDracula.baseScheme).toBe("dark");
    expect(sysDracula.isDefaultBaseline).toBe(false);
    expect(sysDracula.statusBgTokens["--status-5xx-bg"]).toContain("/ 0.15)");

    const autoSelected = resolveEffectiveThemeTokens("default-dark", {
      "--accent-primary": "#ff0000",
    });
    expect(autoSelected.isDefaultBaseline).toBe(false);
    expect(autoSelected.tokens["--accent-primary"]).toBe("#ff0000");
    expect(autoSelected.tokens["--bg-selected"]).toBe(
      deriveSelectedBgHex(
        "#ff0000",
        THEME_PRESETS_BY_ID["default-dark"].tokens["--bg-canvas"],
        "dark"
      )
    );

    const explicitSelected = resolveEffectiveThemeTokens("default-dark", {
      "--accent-primary": "#ff0000",
      "--bg-selected": "#112233",
    });
    expect(explicitSelected.tokens["--bg-selected"]).toBe("#112233");
  });
});
