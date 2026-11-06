import type {
  DiffTabId,
  HeaderPair,
  SessionDetail,
} from "../types/proxy";
import {
  formatBytes,
  parseCookies,
  parseQueryParams,
  statusReasonPhrase,
} from "./formatters";
import { inspectJwt } from "./textWizard";

export interface SessionMarkPreset {
  id: string;
  color: string;
  label: string;
  shortLabel: string;
}

export const SESSION_MARK_PALETTE: SessionMarkPreset[] = [
  {
    id: "red",
    color: "#ef4444",
    label: "Красный — Ошибка / 401 / 500",
    shortLabel: "Red",
  },
  {
    id: "amber",
    color: "#f59e0b",
    label: "Янтарный — Протухший токен / Кэш",
    shortLabel: "Amber",
  },
  {
    id: "emerald",
    color: "#10b981",
    label: "Изумрудный — Эталон 200 OK",
    shortLabel: "Green",
  },
  {
    id: "sky",
    color: "#0ea5e9",
    label: "Синий — Проверка API",
    shortLabel: "Blue",
  },
  {
    id: "violet",
    color: "#8b5cf6",
    label: "Фиолетовый — Auth / Куки",
    shortLabel: "Violet",
  },
  {
    id: "fuchsia",
    color: "#d946ef",
    label: "Пурпурный — Валидация 422",
    shortLabel: "Fuchsia",
  },
  {
    id: "teal",
    color: "#14b8a6",
    label: "Бирюзовый — CDN / Passthrough",
    shortLabel: "Teal",
  },
  {
    id: "orange",
    color: "#f97316",
    label: "Оранжевый — Деградация времени",
    shortLabel: "Orange",
  },
];

export const QUICK_COMMENT_SUGGESTIONS: string[] = [
  "Кейс с протухшим токеном",
  "Эталонный успешный запрос (200 OK)",
  "Ошибка валидации пейлоада (422)",
  "Проблема с Set-Cookie / CSRF",
  "Медленный ответ апстрима",
];

/**
 * Safely converts `#RGB` or `#RRGGBB` into `rgba(r, g, b, alpha)` for custom row fills
 * that remain legible across both Dark and Light themes.
 */
export function hexToRgba(hex?: string | null, alpha = 0.2): string | null {
  if (!hex) return null;
  const clean = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return null;
}

const VOLATILE_HEADER_NAMES = new Set([
  "date",
  "x-request-id",
  "x-correlation-id",
  "x-trace-id",
  "x-amzn-trace-id",
  "cf-ray",
  "age",
  "server-timing",
  "etag",
  "last-modified",
  "if-none-match",
  "if-modified-since",
  "content-length",
]);

export interface DiffNormalizationOptions {
  sortKeysAndHeaders: boolean;
  ignoreVolatileHeaders: boolean;
}

export interface DiffSectionPayload {
  original: string;
  modified: string;
  language: string;
  hasDiff: boolean;
}

export type SessionDiffBundle = Record<DiffTabId, DiffSectionPayload>;

function sortJsonValueDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValueDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      sorted[key] = sortJsonValueDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

function formatBodyForDiff(
  bodyText: string | null | undefined,
  bodyBase64: string,
  contentType: string,
  sortKeys: boolean
): { text: string; isJson: boolean; isXml: boolean } {
  const ctLower = contentType.toLowerCase();

  if (!bodyText || !bodyText.trim()) {
    if (bodyBase64) {
      const approxBytes = Math.floor((bodyBase64.length * 3) / 4);
      return {
        text: `[Binary payload: ${formatBytes(approxBytes)} • Base64 prefix: ${bodyBase64.slice(0, 96)}${bodyBase64.length > 96 ? "..." : ""}]`,
        isJson: false,
        isXml: false,
      };
    }
    return { text: "", isJson: false, isXml: false };
  }

  // Pretty-print JSON payloads (and optionally canonicalize key order)
  const trimmed = bodyText.trim();
  if (
    ctLower.includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const normalized = sortKeys ? sortJsonValueDeep(parsed) : parsed;
      return {
        text: JSON.stringify(normalized, null, 2),
        isJson: true,
        isXml: false,
      };
    } catch {
      // fall through if malformed JSON
    }
  }

  // Format URL-encoded form bodies one field per line for crisp line-by-line diffs
  if (
    ctLower.includes("application/x-www-form-urlencoded") ||
    (!trimmed.includes("\n") &&
      trimmed.includes("=") &&
      trimmed.includes("&") &&
      !trimmed.startsWith("<"))
  ) {
    try {
      const params = new URLSearchParams(trimmed);
      const entries: [string, string][] = [];
      params.forEach((v, k) => entries.push([k, v]));
      if (entries.length > 0) {
        if (sortKeys) {
          entries.sort((a, b) => a[0].localeCompare(b[0]));
        }
        return {
          text: entries.map(([k, v]) => `${k} = ${v}`).join("\n"),
          isJson: false,
          isXml: false,
        };
      }
    } catch {
      // fall through
    }
  }

  return {
    text: bodyText,
    isJson: false,
    isXml: ctLower.includes("xml") || trimmed.startsWith("<?xml"),
  };
}

function normalizeHeadersForDiff(
  headers: HeaderPair[],
  opts: DiffNormalizationOptions
): HeaderPair[] {
  let list = headers.filter((h) => {
    if (!opts.ignoreVolatileHeaders) return true;
    return !VOLATILE_HEADER_NAMES.has(h.name.trim().toLowerCase());
  });

  if (opts.sortKeysAndHeaders) {
    list = [...list].sort((a, b) => {
      const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      return byName !== 0 ? byName : a.value.localeCompare(b.value);
    });
  }
  return list;
}

function buildHeadersSectionText(
  detail: SessionDetail,
  opts: DiffNormalizationOptions
): string {
  const { summary } = detail;
  const httpVer = summary.protocol.includes("2") ? "HTTP/2" : "HTTP/1.1";
  const reqHeaders = normalizeHeadersForDiff(detail.requestHeaders, opts);
  const respHeaders = normalizeHeadersForDiff(detail.responseHeaders, opts);

  const lines: string[] = [
    `${summary.method} ${summary.path || "/"} ${httpVer}`,
    `Host: ${summary.host}`,
  ];
  for (const h of reqHeaders) {
    if (h.name.toLowerCase() === "host") continue;
    lines.push(`${h.name}: ${h.value}`);
  }

  lines.push("");
  lines.push(
    `${httpVer} ${summary.status} ${statusReasonPhrase(summary.status)}`
  );
  for (const h of respHeaders) {
    lines.push(`${h.name}: ${h.value}`);
  }
  return lines.join("\n");
}

function buildCookiesAndAuthText(
  detail: SessionDetail,
  opts: DiffNormalizationOptions
): string {
  const reqCookies = parseCookies(detail.requestHeaders, false);
  const respCookies = parseCookies(detail.responseHeaders, true);

  if (opts.sortKeysAndHeaders) {
    reqCookies.sort((a, b) => a.name.localeCompare(b.name));
    respCookies.sort((a, b) => a.name.localeCompare(b.name));
  }

  const lines: string[] = ["[Request Cookies]"];
  if (reqCookies.length === 0) {
    lines.push("; (none)");
  } else {
    for (const c of reqCookies) {
      lines.push(`${c.name} = ${c.value}`);
    }
  }

  lines.push("");
  lines.push("[Response Set-Cookie]");
  if (respCookies.length === 0) {
    lines.push("; (none)");
  } else {
    for (const c of respCookies) {
      lines.push(`${c.name} = ${c.value}  ; ${c.attributes}`);
    }
  }

  // Extract Auth & WWW-Authenticate headers + decoded JWT claims for 401/403 debugging
  const authHeaders = detail.requestHeaders.filter((h) => {
    const n = h.name.toLowerCase();
    return (
      n === "authorization" ||
      n === "proxy-authorization" ||
      n === "x-api-key" ||
      n === "x-csrf-token"
    );
  });
  const challengeHeaders = detail.responseHeaders.filter(
    (h) => h.name.toLowerCase() === "www-authenticate"
  );

  lines.push("");
  lines.push("[Authorization & Token Claims]");
  if (authHeaders.length === 0 && challengeHeaders.length === 0) {
    lines.push("; (no Authorization or WWW-Authenticate headers)");
  } else {
    for (const h of authHeaders) {
      lines.push(`${h.name} = ${h.value}`);
      if (h.value.toLowerCase().startsWith("bearer ")) {
        const rawToken = h.value.slice(7).trim();
        const jwt = inspectJwt(rawToken);
        if (jwt.validFormat) {
          lines.push(
            `jwt.status = ${jwt.status.toUpperCase()} (${jwt.statusHeadline})`
          );
          if (jwt.headerJson) {
            lines.push("jwt.header = " + jwt.headerJson.replace(/\n/g, "\n  "));
          }
          if (jwt.claimsJson) {
            lines.push(
              "jwt.payload = " + jwt.claimsJson.replace(/\n/g, "\n  ")
            );
          }
        }
      }
    }
    for (const h of challengeHeaders) {
      lines.push(`${h.name} = ${h.value}`);
    }
  }

  return lines.join("\n");
}

function buildRequestPayloadSection(
  detail: SessionDetail,
  opts: DiffNormalizationOptions
): { text: string; isJson: boolean; isXml: boolean } {
  const reqCt =
    detail.requestHeaders.find((h) => h.name.toLowerCase() === "content-type")
      ?.value ?? "";
  const queryParams = parseQueryParams(detail.summary.url);
  if (opts.sortKeysAndHeaders) {
    queryParams.sort((a, b) => a.name.localeCompare(b.name));
  }

  const formattedBody = formatBodyForDiff(
    detail.requestBodyText,
    detail.requestBodyBase64,
    reqCt,
    opts.sortKeysAndHeaders
  );

  // If pure JSON body and no query parameters, keep pure valid JSON for Monaco JSON grammar
  if (formattedBody.isJson && queryParams.length === 0) {
    return formattedBody;
  }

  if (formattedBody.isJson && queryParams.length > 0) {
    // Embed query params + body in a single valid JSON envelope for clean syntax-highlighted diffing
    try {
      const queryObj: Record<string, string | string[]> = {};
      for (const qp of queryParams) {
        if (qp.name in queryObj) {
          const prev = queryObj[qp.name];
          queryObj[qp.name] = Array.isArray(prev)
            ? [...prev, qp.value]
            : [prev, qp.value];
        } else {
          queryObj[qp.name] = qp.value;
        }
      }
      const parsedBody: unknown = JSON.parse(formattedBody.text);
      return {
        text: JSON.stringify(
          {
            _endpoint: `${detail.summary.method} ${detail.summary.path.split("?")[0]}`,
            _queryParams: queryObj,
            body: parsedBody,
          },
          null,
          2
        ),
        isJson: true,
        isXml: false,
      };
    } catch {
      // fall through
    }
  }

  const parts: string[] = [];
  if (queryParams.length > 0) {
    parts.push("[Query Parameters]");
    for (const qp of queryParams) {
      parts.push(`${qp.name} = ${qp.value}`);
    }
  }

  if (formattedBody.text) {
    if (parts.length > 0) parts.push("", "[Request Body]");
    parts.push(formattedBody.text);
  } else if (parts.length === 0) {
    parts.push(
      `// Empty request payload (${detail.summary.method} ${detail.summary.path})`
    );
  }

  return {
    text: parts.join("\n"),
    isJson: false,
    isXml: formattedBody.isXml,
  };
}

function buildResponsePayloadSection(
  detail: SessionDetail,
  opts: DiffNormalizationOptions
): { text: string; isJson: boolean; isXml: boolean } {
  const formatted = formatBodyForDiff(
    detail.responseBodyText,
    detail.responseBodyBase64,
    detail.summary.contentType,
    opts.sortKeysAndHeaders
  );

  if (!formatted.text) {
    return {
      text: `// Empty response body (HTTP ${detail.summary.status} ${statusReasonPhrase(detail.summary.status)})`,
      isJson: false,
      isXml: false,
    };
  }

  return formatted;
}

function buildFullExchangeText(
  detail: SessionDetail,
  opts: DiffNormalizationOptions
): string {
  const { summary } = detail;
  const httpVer = summary.protocol.includes("2") ? "HTTP/2" : "HTTP/1.1";
  const reqHeaders = normalizeHeadersForDiff(detail.requestHeaders, opts);
  const respHeaders = normalizeHeadersForDiff(detail.responseHeaders, opts);
  const reqCt =
    detail.requestHeaders.find((h) => h.name.toLowerCase() === "content-type")
      ?.value ?? "";
  const reqBody = formatBodyForDiff(
    detail.requestBodyText,
    detail.requestBodyBase64,
    reqCt,
    opts.sortKeysAndHeaders
  );
  const respBody = formatBodyForDiff(
    detail.responseBodyText,
    detail.responseBodyBase64,
    summary.contentType,
    opts.sortKeysAndHeaders
  );

  const lines: string[] = [];
  if (summary.comment) {
    lines.push(`# Comment: ${summary.comment}`);
  }
  lines.push(`${summary.method} ${summary.path || "/"} ${httpVer}`);
  lines.push(`Host: ${summary.host}`);
  for (const h of reqHeaders) {
    if (h.name.toLowerCase() === "host") continue;
    lines.push(`${h.name}: ${h.value}`);
  }
  lines.push("");
  lines.push(reqBody.text || "(empty request body)");
  lines.push("");
  lines.push(
    "================================================================================"
  );
  lines.push(
    `${httpVer} ${summary.status} ${statusReasonPhrase(summary.status)}`
  );
  for (const h of respHeaders) {
    lines.push(`${h.name}: ${h.value}`);
  }
  lines.push("");
  lines.push(respBody.text || "(empty response body)");

  return lines.join("\n");
}

export function buildSessionDiffBundle(
  left: SessionDetail,
  right: SessionDetail,
  opts: DiffNormalizationOptions
): SessionDiffBundle {
  const fullLeft = buildFullExchangeText(left, opts);
  const fullRight = buildFullExchangeText(right, opts);

  const hdrLeft = buildHeadersSectionText(left, opts);
  const hdrRight = buildHeadersSectionText(right, opts);

  const cookieLeft = buildCookiesAndAuthText(left, opts);
  const cookieRight = buildCookiesAndAuthText(right, opts);

  const reqLeft = buildRequestPayloadSection(left, opts);
  const reqRight = buildRequestPayloadSection(right, opts);
  const reqLang =
    reqLeft.isJson && reqRight.isJson
      ? "json"
      : reqLeft.isXml && reqRight.isXml
        ? "xml"
        : "ini";

  const respLeft = buildResponsePayloadSection(left, opts);
  const respRight = buildResponsePayloadSection(right, opts);
  const respLang =
    respLeft.isJson && respRight.isJson
      ? "json"
      : respLeft.isXml && respRight.isXml
        ? "xml"
        : "plaintext";

  return {
    full: {
      original: fullLeft,
      modified: fullRight,
      language: "http",
      hasDiff: fullLeft !== fullRight,
    },
    headers: {
      original: hdrLeft,
      modified: hdrRight,
      language: "http",
      hasDiff: hdrLeft !== hdrRight,
    },
    cookies: {
      original: cookieLeft,
      modified: cookieRight,
      language: "ini",
      hasDiff: cookieLeft !== cookieRight,
    },
    request: {
      original: reqLeft.text,
      modified: reqRight.text,
      language: reqLang,
      hasDiff: reqLeft.text !== reqRight.text,
    },
    response: {
      original: respLeft.text,
      modified: respRight.text,
      language: respLang,
      hasDiff: respLeft.text !== respRight.text,
    },
  };
}
