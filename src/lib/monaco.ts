import * as monaco from "monaco-editor/editor/editor.api.js";
import type * as Monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

// Core editor & diff editor contributions (replaces barrel `monaco-editor` entry
// while omitting `languages/features/typescript/register.js` and its 7 MB ts.worker)
import "monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js";
import "monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js";
import "monaco-editor/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js";
import "monaco-editor/editor/contrib/caretOperations/browser/transpose.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js";
import "monaco-editor/editor/contrib/colorPicker/browser/colorPickerContribution.js";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/editor/contrib/dnd/browser/dnd.js";
import "monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols.js";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js";
import "monaco-editor/editor/contrib/format/browser/formatActions.js";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError.js";
import "monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js";
import "monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js";
import "monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js";
import "monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/links/browser/links.js";
import "monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js";
import "monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js";
import "monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders.js";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/tokenization/browser/tokenization.js";
import "monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js";
import "monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js";
import "monaco-editor/editor/common/standaloneStrings.js";

// Language syntax definitions needed by Traffic Inspector, Code Snippets, Scripting & Diff
import "monaco-editor/languages/definitions/csharp/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/dart/register.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/graphql/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/ini/register.js";
import "monaco-editor/languages/definitions/java/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/kotlin/register.js";
import "monaco-editor/languages/definitions/less/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/php/register.js";
import "monaco-editor/languages/definitions/powershell/register.js";
import "monaco-editor/languages/definitions/protobuf/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/ruby/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/scss/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/languages/definitions/swift/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/xml/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";

// Rich language workers (CSS, HTML, JSON) — JS/TS falls back to editorWorker without ts.worker
import "monaco-editor/languages/features/css/register.js";
import "monaco-editor/languages/features/html/register.js";
import "monaco-editor/languages/features/json/register.js";

import {
  THEME_PRESETS_BY_ID,
  type ThemeBaseScheme,
  type ThemeTokenKey,
} from "./themePresets";

import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";

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
loader.config({ monaco: monaco as unknown as typeof Monaco });

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
