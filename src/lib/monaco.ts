import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import {
  THEME_PRESETS_BY_ID,
  type ThemeBaseScheme,
  type ThemeTokenKey,
} from "./themePresets";

import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

// Configure web workers for Monaco in Vite without external CDN dependency
self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") {
      return new jsonWorker();
    }
    if (label === "css" || label === "scss" || label === "less") {
      return new cssWorker();
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new htmlWorker();
    }
    if (label === "typescript" || label === "javascript") {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

// Register HTTP language if not already registered
if (!monaco.languages.getLanguages().some((lang) => lang.id === "http")) {
  monaco.languages.register({ id: "http" });
  monaco.languages.setMonarchTokensProvider("http", {
    tokenizer: {
      root: [
        // HTTP request line (GET, POST, etc.)
        [
          /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\b/,
          "keyword",
        ],
        // HTTP response status line (HTTP/1.1 200 OK)
        [/^(HTTP\/[0-9.]+)\s+(\d{3})\b(.*)$/, ["keyword", "number", "string"]],
        // Headers: Header-Name: Value
        [/^([a-zA-Z0-9_-]+)(:)(.*)$/, ["type", "delimiter", "string"]],
      ],
    },
  });
}

// Tell @monaco-editor/react to use local bundled monaco instance instead of fetching from CDN
loader.config({ monaco });

export const FLUX_MONACO_THEME = "fluxproxy-active";

export function getMonacoThemeName(_resolvedTheme?: ThemeBaseScheme): string {
  return FLUX_MONACO_THEME;
}

function stripHash(hex: string): string {
  return hex.replace(/^#/, "");
}

export function syncMonacoTheme(
  baseScheme: ThemeBaseScheme,
  tokens: Record<ThemeTokenKey, string>
): void {
  monaco.editor.defineTheme(FLUX_MONACO_THEME, {
    base: baseScheme === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: stripHash(tokens["--accent-primary"]) },
      { token: "type", foreground: stripHash(tokens["--status-3xx-fg"]) },
      { token: "string", foreground: stripHash(tokens["--status-2xx-fg"]) },
      { token: "number", foreground: stripHash(tokens["--status-4xx-fg"]) },
      { token: "delimiter", foreground: stripHash(tokens["--text-muted"]) },
      { token: "comment", foreground: stripHash(tokens["--text-muted"]) },
    ],
    colors: {
      "editor.background": tokens["--bg-canvas"],
      "editor.foreground": tokens["--text-primary"],
      "editor.lineHighlightBackground": tokens["--bg-surface"],
      "editor.selectionBackground": tokens["--bg-selected"],
      "editor.inactiveSelectionBackground": tokens["--bg-hover"],
      "editorCursor.foreground": tokens["--accent-primary"],
      "editorWidget.background": tokens["--bg-elevated"],
      "editorWidget.border": tokens["--border-strong"],
      "editorGutter.background": tokens["--bg-canvas"],
      "editorLineNumber.foreground": tokens["--text-muted"],
      "editorLineNumber.activeForeground": tokens["--text-secondary"],
    },
  });
  monaco.editor.setTheme(FLUX_MONACO_THEME);
}

// Register default active theme immediately before any Monaco editor mounts
syncMonacoTheme("dark", THEME_PRESETS_BY_ID["default-dark"].tokens);

export { monaco };
