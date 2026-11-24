import { describe, expect, it } from "vitest";
import {
  formatSectionTooltip,
  getSectionMeta,
  SECTION_LIST,
  SECTION_REGISTRY,
  type SectionId,
} from "./sectionRegistry";
import { ALL_NAV_SECTIONS } from "../types/proxy";

const EXPECTED_CANONICAL_TITLES: Record<SectionId, string> = {
  // Tabs
  traffic: "Traffic",
  composer: "Composer",
  rules: "AutoResponder",
  breakpoints: "Breakpoints",
  scripts: "Scripts",
  diff: "Session Diff",
  wizard: "TextWizard",
  // Settings tabs
  "settings.general": "General",
  "settings.networkRouting": "Network & Routing",
  "settings.tlsCertificates": "TLS & Mobile",
  "settings.filters": "Filters",
  "settings.uiColumns": "Appearance & Layout",
  "settings.diagnosticsBackup": "Diagnostics & Backup",
  // Screens & dialogs
  settings: "Settings",
  rootCa: "Root CA",
  openApiExport: "OpenAPI Export",
  sanitizedExport: "Sanitized Export",
  codeGenerator: "Code Generator",
  shortcuts: "Shortcuts",
  commentMark: "Comment & Mark",
  importCurl: "Import cURL",
};

const FORBIDDEN_INTERNAL_LIBS = [
  "monaco",
  "diffeditor",
  "rcgen",
  "rustls",
  "tokio",
  "oneshot",
];

describe("SECTION_REGISTRY contract", () => {
  it("contains exact canonical titles for all 21 tabs, settings tabs, screens, and dialogs", () => {
    const expectedIds = Object.keys(EXPECTED_CANONICAL_TITLES) as SectionId[];
    const registryIds = Object.keys(SECTION_REGISTRY) as SectionId[];

    expect(registryIds.sort()).toEqual(expectedIds.sort());
    expect(SECTION_LIST).toHaveLength(expectedIds.length);

    for (const id of expectedIds) {
      const meta = getSectionMeta(id);
      expect(meta.id).toBe(id);
      expect(meta.title).toBe(EXPECTED_CANONICAL_TITLES[id]);
    }
  });

  it("registers every ActiveNavSection as a workspace tab with a shortcut", () => {
    expect(ALL_NAV_SECTIONS).toEqual([
      "traffic",
      "composer",
      "rules",
      "breakpoints",
      "scripts",
      "diff",
      "wizard",
    ]);

    for (const section of ALL_NAV_SECTIONS) {
      const meta = getSectionMeta(section);
      expect(meta.kind).toBe("tab");
      expect(meta.shortcut).toBeTruthy();
    }
  });

  it("enforces concise single-language titles without ellipses, parentheses, bilingual duplicates, or internal library names", () => {
    for (const meta of SECTION_LIST) {
      expect(meta.title.trim()).toBe(meta.title);
      expect(meta.title.length).toBeGreaterThan(0);
      expect(meta.title.length).toBeLessThanOrEqual(24);

      // No ellipses, parentheses, em/en dashes, slashes, or Cyrillic bilingual duplicates in canonical titles
      expect(meta.title).not.toContain("...");
      expect(meta.title).not.toContain("…");
      expect(meta.title).not.toMatch(/[()—–/]/);
      expect(meta.title).not.toMatch(/[А-Яа-яЁё]/);

      // Single-line summary & non-empty details
      expect(meta.summary.trim().length).toBeGreaterThan(8);
      expect(meta.summary).not.toContain("\n");
      expect(meta.details.trim().length).toBeGreaterThan(20);

      // No internal implementation library names in titles or summaries
      const combined = `${meta.title} ${meta.summary} ${meta.details}`.toLowerCase();
      for (const lib of FORBIDDEN_INTERNAL_LIBS) {
        expect(combined).not.toContain(lib);
      }
    }
  });

  it("formats tooltips consistently with and without keyboard shortcuts", () => {
    expect(formatSectionTooltip("traffic")).toBe("Traffic (Alt+1)");
    expect(formatSectionTooltip("breakpoints")).toBe("Breakpoints (Alt+6)");
    expect(formatSectionTooltip("diff")).toBe("Session Diff (Ctrl+D)");
    expect(formatSectionTooltip("wizard")).toBe("TextWizard (Ctrl+E)");
    expect(formatSectionTooltip("settings")).toBe("Settings (Ctrl+,)");
    expect(formatSectionTooltip("rootCa")).toBe("Root CA");
    expect(formatSectionTooltip("openApiExport")).toBe("OpenAPI Export");
  });
});
