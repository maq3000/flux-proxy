import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

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

export { monaco };
