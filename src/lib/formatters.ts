import type { HeaderPair, SessionDetail, SessionSummary } from "../types/proxy";

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export type RowSemanticTone =
  | "error"
  | "json"
  | "image"
  | "ws"
  | "sse"
  | "redirect"
  | "default";

/**
 * Maps a session summary to Fiddler-inspired semantic color categories:
 * - Errors (4xx/5xx or transport failure) -> Red
 * - Images (image/*) -> Muted Gray
 * - JSON / GraphQL / gRPC API -> Blue
 * - WebSockets (101 / ws / wss) -> Violet
 * - SSE (text/event-stream) -> Cyan / Emerald stream
 * - Redirects (3xx) -> Amber
 */
export function getRowSemanticTone(session: SessionSummary): RowSemanticTone {
  if (session.error || session.status >= 400) return "error";
  if (
    session.status === 101 ||
    session.scheme === "ws" ||
    session.scheme === "wss"
  ) {
    return "ws";
  }
  const ct = session.contentType.toLowerCase();
  if (ct.includes("text/event-stream")) return "sse";
  if (ct.startsWith("image/")) return "image";
  if (
    ct.includes("json") ||
    ct.includes("graphql") ||
    ct.includes("grpc") ||
    ct.includes("protobuf") ||
    session.path.startsWith("/api/") ||
    session.path.startsWith("/v1/")
  ) {
    return "json";
  }
  if (session.status >= 300 && session.status < 400) return "redirect";
  return "default";
}

export function parseQueryParams(urlStr: string): HeaderPair[] {
  try {
    const parsed = new URL(urlStr);
    const out: HeaderPair[] = [];
    parsed.searchParams.forEach((value, name) => {
      out.push({ name, value });
    });
    return out;
  } catch {
    const qIdx = urlStr.indexOf("?");
    if (qIdx === -1) return [];
    const search = new URLSearchParams(urlStr.slice(qIdx + 1));
    const out: HeaderPair[] = [];
    search.forEach((value, name) => {
      out.push({ name, value });
    });
    return out;
  }
}

export interface ParsedCookieItem {
  name: string;
  value: string;
  attributes: string;
}

export function parseCookies(
  headers: HeaderPair[],
  isResponse: boolean
): ParsedCookieItem[] {
  const result: ParsedCookieItem[] = [];
  if (!isResponse) {
    for (const h of headers) {
      if (h.name.toLowerCase() === "cookie") {
        const parts = h.value.split(";");
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          const eq = trimmed.indexOf("=");
          if (eq === -1) {
            result.push({ name: trimmed, value: "", attributes: "Request Cookie" });
          } else {
            result.push({
              name: trimmed.slice(0, eq).trim(),
              value: trimmed.slice(eq + 1).trim(),
              attributes: "Request Cookie",
            });
          }
        }
      }
    }
  } else {
    for (const h of headers) {
      if (h.name.toLowerCase() === "set-cookie") {
        const segments = h.value.split(";").map((s) => s.trim());
        const [first, ...attrs] = segments;
        if (!first) continue;
        const eq = first.indexOf("=");
        const name = eq === -1 ? first : first.slice(0, eq);
        const value = eq === -1 ? "" : first.slice(eq + 1);
        result.push({
          name,
          value,
          attributes: attrs.join("; ") || "Path=/",
        });
      }
    }
  }
  return result;
}

export function buildRawHttpRequest(detail: SessionDetail): string {
  const { summary, requestHeaders, requestBodyText } = detail;
  const httpVer = summary.protocol.includes("2") ? "HTTP/2" : "HTTP/1.1";
  const headerLines = requestHeaders
    .map((h) => `${h.name}: ${h.value}`)
    .join("\r\n");
  const body = requestBodyText ?? "";
  return `${summary.method} ${summary.path || "/"} ${httpVer}\r\nHost: ${summary.host}\r\n${headerLines}\r\n\r\n${body}`;
}

export function buildRawHttpResponse(detail: SessionDetail): string {
  const { summary, responseHeaders, responseBodyText } = detail;
  const httpVer = summary.protocol.includes("2") ? "HTTP/2" : "HTTP/1.1";
  const statusText = statusReasonPhrase(summary.status);
  const headerLines = responseHeaders
    .map((h) => `${h.name}: ${h.value}`)
    .join("\r\n");
  const body = responseBodyText ?? "";
  return `${httpVer} ${summary.status} ${statusText}\r\n${headerLines}\r\n\r\n${body}`;
}

export function buildHeadersBlock(
  detail: SessionDetail,
  kind: "request" | "response" = "request"
): string {
  const { summary, requestHeaders, responseHeaders } = detail;
  const httpVer = summary.protocol.includes("2") ? "HTTP/2" : "HTTP/1.1";
  if (kind === "request") {
    const lines = requestHeaders.map((h) => `${h.name}: ${h.value}`).join("\n");
    return `${summary.method} ${summary.path || "/"} ${httpVer}\nHost: ${summary.host}${lines ? `\n${lines}` : ""}`;
  }
  const statusText = statusReasonPhrase(summary.status);
  const lines = responseHeaders.map((h) => `${h.name}: ${h.value}`).join("\n");
  return `${httpVer} ${summary.status} ${statusText}${lines ? `\n${lines}` : ""}`;
}

function escapePosixSingleQuotes(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildCurlCommand(detail: SessionDetail): string {
  const { summary, requestHeaders, requestBodyText } = detail;
  const parts: string[] = [
    "curl",
    "-i",
    "-X",
    summary.method.toUpperCase(),
    escapePosixSingleQuotes(summary.url),
  ];

  for (const h of requestHeaders) {
    const lower = h.name.toLowerCase();
    if (lower === "content-length" || lower === "host") continue;
    parts.push("-H", escapePosixSingleQuotes(`${h.name}: ${h.value}`));
  }

  if (
    requestBodyText &&
    summary.method.toUpperCase() !== "GET" &&
    summary.method.toUpperCase() !== "HEAD"
  ) {
    parts.push("--data-raw", escapePosixSingleQuotes(requestBodyText));
  }

  return parts.join(" \\\n  ");
}

export function tryFormatJson(raw?: string | null): {
  formatted: string;
  valid: boolean;
} {
  if (!raw || !raw.trim()) {
    return { formatted: "", valid: false };
  }
  try {
    const parsed = JSON.parse(raw);
    return { formatted: JSON.stringify(parsed, null, 2), valid: true };
  } catch {
    return { formatted: raw, valid: false };
  }
}

export function decodeBase64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new TextEncoder().encode(b64);
  }
}

export function encodeTextToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function statusReasonPhrase(status: number): string {
  const map: Record<number, string> = {
    101: "Switching Protocols",
    200: "OK",
    201: "Created",
    204: "No Content",
    301: "Moved Permanently",
    302: "Found",
    304: "Not Modified",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
  };
  return map[status] ?? "Response";
}

export function buildFullRawHttpMessage(detail: SessionDetail): string {
  return `${buildRawHttpRequest(detail)}\r\n\r\n${buildRawHttpResponse(detail)}\r\n`;
}

export function extensionFromMimeType(
  mimeType: string | null | undefined,
  fallback = "bin"
): string {
  if (!mimeType) return fallback;
  const clean = mimeType.split(";")[0].trim().toLowerCase();
  if (!clean) return fallback;

  if (clean === "application/json" || clean.endsWith("+json")) return "json";
  if (clean === "text/html" || clean === "application/xhtml+xml") return "html";
  if (clean === "image/svg+xml") return "svg";
  if (
    clean === "text/xml" ||
    clean === "application/xml" ||
    clean.endsWith("+xml")
  ) {
    return "xml";
  }
  if (clean === "image/png") return "png";
  if (clean === "image/jpeg" || clean === "image/jpg") return "jpg";
  if (clean === "image/gif") return "gif";
  if (clean === "image/webp") return "webp";
  if (clean === "image/avif") return "avif";
  if (clean === "image/x-icon" || clean === "image/vnd.microsoft.icon") {
    return "ico";
  }
  if (clean === "text/css") return "css";
  if (
    clean === "text/javascript" ||
    clean === "application/javascript" ||
    clean === "application/x-javascript"
  ) {
    return "js";
  }
  if (clean === "text/csv") return "csv";
  if (
    clean === "text/plain" ||
    clean === "text/event-stream" ||
    clean === "application/x-www-form-urlencoded"
  ) {
    return "txt";
  }
  if (clean === "application/pdf") return "pdf";
  if (clean === "application/zip") return "zip";
  if (clean === "application/gzip") return "gz";
  if (clean === "application/wasm") return "wasm";
  if (clean === "audio/mpeg") return "mp3";
  if (clean === "audio/wav") return "wav";
  if (clean === "audio/ogg") return "ogg";
  if (clean === "video/mp4") return "mp4";
  if (clean === "video/webm") return "webm";
  if (clean === "font/woff2") return "woff2";
  if (clean === "font/woff") return "woff";
  if (clean === "font/ttf") return "ttf";

  return fallback;
}

export function suggestSessionBodyFileName(
  sessionId: number,
  isResponse: boolean,
  mimeType?: string | null
): { fileName: string; ext: string } {
  const ext = extensionFromMimeType(mimeType, "bin");
  const prefix = isResponse ? "response" : "request";
  return {
    fileName: `${prefix}_${sessionId}.${ext}`,
    ext,
  };
}
