import type { ComposedRequest, HeaderPair, SessionDetail } from "../types/proxy";
import { decodeBase64ToBytes } from "./formatters";

export type CodeLanguageGroupId =
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "curl";

export type CodeGeneratorId =
  | "js-fetch"
  | "js-axios"
  | "python-requests"
  | "python-httpx"
  | "go-net-http"
  | "rust-reqwest"
  | "curl-bash"
  | "curl-powershell";

export interface CodeGenRequest {
  method: string;
  url: string;
  headers: HeaderPair[];
  body: string;
  bodyBase64?: string | null;
  isBinaryBody?: boolean;
  sourceLabel?: string;
}

export interface CodeGeneratorTarget {
  id: CodeGeneratorId;
  group: CodeLanguageGroupId;
  groupLabel: string;
  variantLabel: string;
  fullLabel: string;
  monacoLanguage:
    | "javascript"
    | "python"
    | "go"
    | "rust"
    | "shell"
    | "powershell";
  fileExtension: string;
}

export const CODE_GENERATOR_TARGETS: readonly CodeGeneratorTarget[] = [
  {
    id: "js-fetch",
    group: "javascript",
    groupLabel: "JavaScript",
    variantLabel: "fetch",
    fullLabel: "JavaScript (fetch)",
    monacoLanguage: "javascript",
    fileExtension: "js",
  },
  {
    id: "js-axios",
    group: "javascript",
    groupLabel: "JavaScript",
    variantLabel: "axios",
    fullLabel: "JavaScript (axios)",
    monacoLanguage: "javascript",
    fileExtension: "js",
  },
  {
    id: "python-requests",
    group: "python",
    groupLabel: "Python",
    variantLabel: "requests",
    fullLabel: "Python (requests)",
    monacoLanguage: "python",
    fileExtension: "py",
  },
  {
    id: "python-httpx",
    group: "python",
    groupLabel: "Python",
    variantLabel: "httpx",
    fullLabel: "Python (httpx)",
    monacoLanguage: "python",
    fileExtension: "py",
  },
  {
    id: "go-net-http",
    group: "go",
    groupLabel: "Go",
    variantLabel: "net/http",
    fullLabel: "Go (net/http)",
    monacoLanguage: "go",
    fileExtension: "go",
  },
  {
    id: "rust-reqwest",
    group: "rust",
    groupLabel: "Rust",
    variantLabel: "reqwest",
    fullLabel: "Rust (reqwest)",
    monacoLanguage: "rust",
    fileExtension: "rs",
  },
  {
    id: "curl-bash",
    group: "curl",
    groupLabel: "cURL",
    variantLabel: "Bash",
    fullLabel: "cURL (Bash)",
    monacoLanguage: "shell",
    fileExtension: "sh",
  },
  {
    id: "curl-powershell",
    group: "curl",
    groupLabel: "cURL",
    variantLabel: "PowerShell",
    fullLabel: "cURL (PowerShell)",
    monacoLanguage: "powershell",
    fileExtension: "ps1",
  },
] as const;

export const CODE_LANGUAGE_GROUPS: readonly {
  id: CodeLanguageGroupId;
  label: string;
  targets: readonly CodeGeneratorTarget[];
}[] = [
  {
    id: "javascript",
    label: "JavaScript",
    targets: CODE_GENERATOR_TARGETS.filter((t) => t.group === "javascript"),
  },
  {
    id: "python",
    label: "Python",
    targets: CODE_GENERATOR_TARGETS.filter((t) => t.group === "python"),
  },
  {
    id: "go",
    label: "Go",
    targets: CODE_GENERATOR_TARGETS.filter((t) => t.group === "go"),
  },
  {
    id: "rust",
    label: "Rust",
    targets: CODE_GENERATOR_TARGETS.filter((t) => t.group === "rust"),
  },
  {
    id: "curl",
    label: "cURL",
    targets: CODE_GENERATOR_TARGETS.filter((t) => t.group === "curl"),
  },
] as const;

const IGNORED_GENERATED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
]);

const RUST_STANDARD_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "TRACE",
  "CONNECT",
]);

export function getCodeGeneratorTarget(
  id: CodeGeneratorId
): CodeGeneratorTarget {
  return (
    CODE_GENERATOR_TARGETS.find((t) => t.id === id) ?? CODE_GENERATOR_TARGETS[0]
  );
}

/**
 * Normalizes a captured `SessionDetail` into a transport-neutral `CodeGenRequest`.
 */
export function requestFromSessionDetail(
  detail: SessionDetail
): CodeGenRequest {
  let body = detail.requestBodyText ?? "";
  let isBinaryBody = false;
  const bodyBase64 = detail.requestBodyBase64 || null;

  if (!body && bodyBase64) {
    const bytes = decodeBase64ToBytes(bodyBase64);
    if (bytes.length > 0) {
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        isBinaryBody = true;
      }
    }
  }

  return {
    method: (detail.summary.method || "GET").toUpperCase(),
    url: detail.summary.url,
    headers: detail.requestHeaders,
    body,
    bodyBase64,
    isBinaryBody,
    sourceLabel: `Session #${detail.summary.id}`,
  };
}

/**
 * Normalizes a Composer draft `ComposedRequest` into a `CodeGenRequest`.
 */
export function requestFromComposedRequest(
  draft: ComposedRequest
): CodeGenRequest {
  let body = draft.body ?? "";
  let isBinaryBody = false;
  const bodyBase64 = draft.bodyBase64 ?? null;

  if (!body && bodyBase64) {
    const bytes = decodeBase64ToBytes(bodyBase64);
    if (bytes.length > 0) {
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        isBinaryBody = true;
      }
    }
  }

  return {
    method: (draft.method || "GET").trim().toUpperCase(),
    url: (draft.url || "").trim(),
    headers: draft.headers.filter((h) => h.name.trim().length > 0),
    body,
    bodyBase64,
    isBinaryBody,
    sourceLabel: "Composer Draft",
  };
}

interface NormalizedRequest {
  method: string;
  url: string;
  headerList: HeaderPair[];
  headerMap: HeaderPair[];
  textBody: string;
  binaryBase64: string | null;
  hasBody: boolean;
  parsedJson: unknown | undefined;
}

function sanitizeHeaderSegment(raw: string): string {
  return raw.replace(/[\r\n\0]+/g, "").trim();
}

function sanitizeUrl(raw: string): string {
  return raw.replace(/[\r\n\0]+/g, "").trim();
}

function normalizeForCodeGen(req: CodeGenRequest): NormalizedRequest {
  const method = (req.method || "GET").replace(/[^a-zA-Z0-9_-]/g, "").toUpperCase() || "GET";
  const url = sanitizeUrl(req.url);

  const headerList: HeaderPair[] = [];
  const mergedIndexByLower = new Map<string, number>();
  const headerMap: HeaderPair[] = [];

  for (const rawHeader of req.headers) {
    const name = sanitizeHeaderSegment(rawHeader.name);
    if (!name || name.startsWith(":")) continue;
    const lower = name.toLowerCase();
    if (IGNORED_GENERATED_HEADERS.has(lower)) continue;

    const value = rawHeader.value.replace(/[\r\n\0]+/g, "").trim();
    headerList.push({ name, value });

    const existingIdx = mergedIndexByLower.get(lower);
    if (existingIdx !== undefined) {
      const joiner = lower === "cookie" ? "; " : ", ";
      headerMap[existingIdx] = {
        name: headerMap[existingIdx].name,
        value: headerMap[existingIdx].value
          ? `${headerMap[existingIdx].value}${joiner}${value}`
          : value,
      };
    } else {
      mergedIndexByLower.set(lower, headerMap.length);
      headerMap.push({ name, value });
    }
  }

  const allowsBody = method !== "GET" && method !== "HEAD";
  const isBinary = Boolean(allowsBody && req.isBinaryBody && req.bodyBase64);
  const textBody = allowsBody && !isBinary ? req.body ?? "" : "";
  const binaryBase64 = isBinary ? req.bodyBase64 ?? null : null;
  const hasBody = isBinary || textBody.length > 0;

  let parsedJson: unknown | undefined = undefined;
  const contentType =
    headerMap.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
  if (
    !isBinary &&
    textBody.trim().length > 0 &&
    contentType.toLowerCase().includes("json")
  ) {
    try {
      parsedJson = JSON.parse(textBody);
    } catch {
      parsedJson = undefined;
    }
  }

  return {
    method,
    url,
    headerList,
    headerMap,
    textBody,
    binaryBase64,
    hasBody,
    parsedJson,
  };
}

// ============================================================================
// Safe Language-Specific String & Literal Escapers
// ============================================================================

function escapeJsString(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function formatJsJsonValue(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapePythonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const code = ch.charCodeAt(0);
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === '"') {
      out += '\\"';
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (ch === "\0") {
      out += "\\x00";
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

function toPythonLiteral(value: unknown, indent = 0): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "None";
  }
  if (typeof value === "string") {
    return escapePythonString(value);
  }
  const pad = " ".repeat(indent);
  const childPad = " ".repeat(indent + 2);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value
      .map((item) => `${childPad}${toPythonLiteral(item, indent + 2)}`)
      .join(",\n");
    return `[\n${items}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const lines = entries
      .map(
        ([k, v]) =>
          `${childPad}${escapePythonString(k)}: ${toPythonLiteral(v, indent + 2)}`
      )
      .join(",\n");
    return `{\n${lines}\n${pad}}`;
  }
  return "None";
}

function escapeGoString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const code = ch.charCodeAt(0);
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === '"') {
      out += '\\"';
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

function escapeRustString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const code = ch.charCodeAt(0);
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === '"') {
      out += '\\"';
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (ch === "\0") {
      out += "\\0";
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

function escapeBashArg(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    let out = "$'";
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      const code = ch.charCodeAt(0);
      if (ch === "\\") {
        out += "\\\\";
      } else if (ch === "'") {
        out += "\\'";
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else if (code < 0x20 || code === 0x7f) {
        out += `\\x${code.toString(16).padStart(2, "0")}`;
      } else {
        out += ch;
      }
    }
    return `${out}'`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapePowerShellArg(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    let out = '"';
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      const code = ch.charCodeAt(0);
      if (ch === "`") {
        out += "``";
      } else if (ch === '"') {
        out += '`"';
      } else if (ch === "$") {
        out += "`$";
      } else if (ch === "\n") {
        out += "`n";
      } else if (ch === "\r") {
        out += "`r";
      } else if (ch === "\t") {
        out += "`t";
      } else if (ch === "\0") {
        out += "`0";
      } else if (code < 0x20 || code === 0x7f) {
        out += `$([char]0x${code.toString(16).padStart(2, "0")})`;
      } else {
        out += ch;
      }
    }
    return `${out}"`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

// ============================================================================
// Target Code Generators (5 Languages / 8 Library Targets)
// ============================================================================

function generateJsFetch(req: NormalizedRequest): string {
  const lines: string[] = [];

  if (req.binaryBase64) {
    lines.push(
      `const payload = Uint8Array.from(atob(${escapeJsString(req.binaryBase64)}), (c) => c.charCodeAt(0));`
    );
    lines.push("");
  } else if (req.parsedJson !== undefined) {
    lines.push(`const payload = ${formatJsJsonValue(req.parsedJson)};`);
    lines.push("");
  }

  lines.push(`const response = await fetch(${escapeJsString(req.url)}, {`);
  lines.push(`  method: ${escapeJsString(req.method)},`);

  if (req.headerMap.length > 0) {
    lines.push("  headers: {");
    for (const h of req.headerMap) {
      lines.push(`    ${escapeJsString(h.name)}: ${escapeJsString(h.value)},`);
    }
    lines.push("  },");
  }

  if (req.binaryBase64) {
    lines.push("  body: payload,");
  } else if (req.parsedJson !== undefined) {
    lines.push("  body: JSON.stringify(payload),");
  } else if (req.hasBody) {
    lines.push(`  body: ${escapeJsString(req.textBody)},`);
  }

  lines.push("});");
  lines.push("");
  lines.push("if (!response.ok) {");
  lines.push(
    "  throw new Error(`HTTP ${response.status} ${response.statusText}`);"
  );
  lines.push("}");
  lines.push("");
  lines.push("const responseText = await response.text();");
  lines.push("console.log(response.status, responseText);");

  return lines.join("\n");
}

function generateJsAxios(req: NormalizedRequest): string {
  const lines: string[] = ['import axios from "axios";', ""];

  if (req.binaryBase64) {
    lines.push(
      `const payload = Uint8Array.from(atob(${escapeJsString(req.binaryBase64)}), (c) => c.charCodeAt(0));`
    );
    lines.push("");
  } else if (req.parsedJson !== undefined) {
    lines.push(`const payload = ${formatJsJsonValue(req.parsedJson)};`);
    lines.push("");
  }

  lines.push("const response = await axios.request({");
  lines.push(`  method: ${escapeJsString(req.method)},`);
  lines.push(`  url: ${escapeJsString(req.url)},`);

  if (req.headerMap.length > 0) {
    lines.push("  headers: {");
    for (const h of req.headerMap) {
      lines.push(`    ${escapeJsString(h.name)}: ${escapeJsString(h.value)},`);
    }
    lines.push("  },");
  }

  if (req.binaryBase64 || req.parsedJson !== undefined) {
    lines.push("  data: payload,");
  } else if (req.hasBody) {
    lines.push(`  data: ${escapeJsString(req.textBody)},`);
  }

  lines.push("});");
  lines.push("");
  lines.push("console.log(response.status, response.data);");

  return lines.join("\n");
}

function generatePythonRequests(req: NormalizedRequest): string {
  const lines: string[] = [];
  if (req.binaryBase64) {
    lines.push("import base64");
  }
  lines.push("import requests");
  lines.push("");
  lines.push(`url = ${escapePythonString(req.url)}`);

  if (req.headerMap.length > 0) {
    lines.push("headers = {");
    for (const h of req.headerMap) {
      lines.push(
        `    ${escapePythonString(h.name)}: ${escapePythonString(h.value)},`
      );
    }
    lines.push("}");
  }

  if (req.binaryBase64) {
    lines.push(
      `payload = base64.b64decode(${escapePythonString(req.binaryBase64)})`
    );
  } else if (req.parsedJson !== undefined) {
    lines.push(`payload = ${toPythonLiteral(req.parsedJson, 0)}`);
  } else if (req.hasBody) {
    lines.push(`payload = ${escapePythonString(req.textBody)}`);
  }

  lines.push("");
  const args: string[] = [
    `    ${escapePythonString(req.method)}`,
    "    url",
  ];
  if (req.headerMap.length > 0) {
    args.push("    headers=headers");
  }
  if (req.binaryBase64) {
    args.push("    data=payload");
  } else if (req.parsedJson !== undefined) {
    args.push("    json=payload");
  } else if (req.hasBody) {
    args.push('    data=payload.encode("utf-8")');
  }
  args.push("    timeout=30");

  lines.push("response = requests.request(");
  lines.push(`${args.join(",\n")},`);
  lines.push(")");
  lines.push("response.raise_for_status()");
  lines.push("print(response.status_code, response.text)");

  return lines.join("\n");
}

function generatePythonHttpx(req: NormalizedRequest): string {
  const lines: string[] = [];
  if (req.binaryBase64) {
    lines.push("import base64");
  }
  lines.push("import httpx");
  lines.push("");
  lines.push(`url = ${escapePythonString(req.url)}`);

  if (req.headerMap.length > 0) {
    lines.push("headers = {");
    for (const h of req.headerMap) {
      lines.push(
        `    ${escapePythonString(h.name)}: ${escapePythonString(h.value)},`
      );
    }
    lines.push("}");
  }

  if (req.binaryBase64) {
    lines.push(
      `payload = base64.b64decode(${escapePythonString(req.binaryBase64)})`
    );
  } else if (req.parsedJson !== undefined) {
    lines.push(`payload = ${toPythonLiteral(req.parsedJson, 0)}`);
  } else if (req.hasBody) {
    lines.push(`payload = ${escapePythonString(req.textBody)}`);
  }

  lines.push("");
  lines.push(
    "with httpx.Client(timeout=30.0, follow_redirects=True) as client:"
  );

  const args: string[] = [
    `        ${escapePythonString(req.method)}`,
    "        url",
  ];
  if (req.headerMap.length > 0) {
    args.push("        headers=headers");
  }
  if (req.binaryBase64) {
    args.push("        content=payload");
  } else if (req.parsedJson !== undefined) {
    args.push("        json=payload");
  } else if (req.hasBody) {
    args.push('        content=payload.encode("utf-8")');
  }

  lines.push("    response = client.request(");
  lines.push(`${args.join(",\n")},`);
  lines.push("    )");
  lines.push("    response.raise_for_status()");
  lines.push("    print(response.status_code, response.text)");

  return lines.join("\n");
}

function generateGoNetHttp(req: NormalizedRequest): string {
  const imports: string[] = [];
  if (req.binaryBase64) {
    imports.push("bytes", "encoding/base64");
  }
  imports.push("fmt", "io", "net/http");
  if (!req.binaryBase64 && req.hasBody) {
    imports.push("strings");
  }
  imports.push("time");
  imports.sort();

  const lines: string[] = ["package main", "", "import ("];
  for (const imp of imports) {
    lines.push(`\t${escapeGoString(imp)}`);
  }
  lines.push(")", "", "func main() {");

  if (req.binaryBase64) {
    lines.push(
      `\tpayloadBytes, err := base64.StdEncoding.DecodeString(${escapeGoString(req.binaryBase64)})`
    );
    lines.push("\tif err != nil {");
    lines.push("\t\tpanic(err)");
    lines.push("\t}");
    lines.push("\tbodyReader := bytes.NewReader(payloadBytes)");
    lines.push("");
    lines.push(
      `\treq, err := http.NewRequest(${escapeGoString(req.method)}, ${escapeGoString(req.url)}, bodyReader)`
    );
  } else if (req.hasBody) {
    lines.push(`\tpayload := ${escapeGoString(req.textBody)}`);
    lines.push(
      `\treq, err := http.NewRequest(${escapeGoString(req.method)}, ${escapeGoString(req.url)}, strings.NewReader(payload))`
    );
  } else {
    lines.push(
      `\treq, err := http.NewRequest(${escapeGoString(req.method)}, ${escapeGoString(req.url)}, nil)`
    );
  }

  lines.push("\tif err != nil {");
  lines.push("\t\tpanic(err)");
  lines.push("\t}");

  if (req.headerList.length > 0) {
    lines.push("");
    for (const h of req.headerList) {
      lines.push(
        `\treq.Header.Add(${escapeGoString(h.name)}, ${escapeGoString(h.value)})`
      );
    }
  }

  lines.push("");
  lines.push("\tclient := &http.Client{Timeout: 30 * time.Second}");
  lines.push("\tresp, err := client.Do(req)");
  lines.push("\tif err != nil {");
  lines.push("\t\tpanic(err)");
  lines.push("\t}");
  lines.push("\tdefer resp.Body.Close()");
  lines.push("");
  lines.push("\trespBody, err := io.ReadAll(resp.Body)");
  lines.push("\tif err != nil {");
  lines.push("\t\tpanic(err)");
  lines.push("\t}");
  lines.push('\tfmt.Printf("%d %s\\n", resp.StatusCode, string(respBody))');
  lines.push("}");

  return lines.join("\n");
}

function generateRustReqwest(req: NormalizedRequest): string {
  const lines: string[] = [
    "use std::error::Error;",
    "use std::time::Duration;",
    "",
    "#[tokio::main]",
    "async fn main() -> Result<(), Box<dyn Error>> {",
    "    let client = reqwest::Client::builder()",
    "        .timeout(Duration::from_secs(30))",
    "        .build()?;",
    "",
  ];

  const methodExpr = RUST_STANDARD_METHODS.has(req.method)
    ? `reqwest::Method::${req.method}`
    : `reqwest::Method::from_bytes(${escapeRustString(req.method)}.as_bytes())?`;

  if (req.binaryBase64) {
    const bytes = decodeBase64ToBytes(req.binaryBase64);
    if (bytes.length <= 256) {
      const byteLiterals = Array.from(bytes)
        .map((b) => `0x${b.toString(16).padStart(2, "0")}`)
        .join(", ");
      lines.push(`    let payload: Vec<u8> = vec![${byteLiterals}];`);
    } else {
      lines.push(
        `    // Бинарное тело (${bytes.length} байт, base64: ${req.binaryBase64.slice(0, 48)}...)`
      );
      lines.push(
        '    let payload = std::fs::read("payload.bin")?;'
      );
    }
    lines.push("");
  }

  lines.push(
    `    let mut request = client.request(${methodExpr}, ${escapeRustString(req.url)});`
  );

  for (const h of req.headerList) {
    lines.push(
      `    request = request.header(${escapeRustString(h.name)}, ${escapeRustString(h.value)});`
    );
  }

  if (req.binaryBase64) {
    lines.push("    request = request.body(payload);");
  } else if (req.hasBody) {
    lines.push(`    request = request.body(${escapeRustString(req.textBody)});`);
  }

  lines.push("");
  lines.push("    let response = request.send().await?;");
  lines.push("    let status = response.status();");
  lines.push("    let body = response.text().await?;");
  lines.push('    println!("{status} {body}");');
  lines.push("");
  lines.push("    Ok(())");
  lines.push("}");

  return lines.join("\n");
}

function generateCurlBash(req: NormalizedRequest): string {
  const parts: string[] = [
    "curl",
    "-X",
    escapeBashArg(req.method),
    escapeBashArg(req.url),
  ];

  for (const h of req.headerList) {
    parts.push("-H", escapeBashArg(`${h.name}: ${h.value}`));
  }

  if (req.binaryBase64) {
    parts.push("--data-binary", "@payload.bin");
    return [
      `# Сохраните бинарное тело: echo ${escapeBashArg(req.binaryBase64)} | base64 -d > payload.bin`,
      parts.join(" \\\n  "),
    ].join("\n");
  }

  if (req.hasBody) {
    parts.push("--data-raw", escapeBashArg(req.textBody));
  }

  return parts.join(" \\\n  ");
}

function generateCurlPowerShell(req: NormalizedRequest): string {
  const parts: string[] = [
    "curl.exe",
    "-X",
    escapePowerShellArg(req.method),
    escapePowerShellArg(req.url),
  ];

  for (const h of req.headerList) {
    parts.push("-H", escapePowerShellArg(`${h.name}: ${h.value}`));
  }

  if (req.binaryBase64) {
    parts.push("--data-binary", "'@payload.bin'");
    return [
      `# [IO.File]::WriteAllBytes("payload.bin", [Convert]::FromBase64String(${escapePowerShellArg(req.binaryBase64)}))`,
      parts.join(" `\n  "),
    ].join("\n");
  }

  if (req.hasBody) {
    parts.push("--data-raw", escapePowerShellArg(req.textBody));
  }

  return parts.join(" `\n  ");
}

/**
 * Generates idiomatic, injection-safe client code for the given request & target.
 */
export function generateCodeSnippet(
  request: CodeGenRequest,
  targetId: CodeGeneratorId
): string {
  const normalized = normalizeForCodeGen(request);
  switch (targetId) {
    case "js-fetch":
      return generateJsFetch(normalized);
    case "js-axios":
      return generateJsAxios(normalized);
    case "python-requests":
      return generatePythonRequests(normalized);
    case "python-httpx":
      return generatePythonHttpx(normalized);
    case "go-net-http":
      return generateGoNetHttp(normalized);
    case "rust-reqwest":
      return generateRustReqwest(normalized);
    case "curl-bash":
      return generateCurlBash(normalized);
    case "curl-powershell":
      return generateCurlPowerShell(normalized);
  }
}
