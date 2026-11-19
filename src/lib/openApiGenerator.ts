import {
  DEFAULT_MASK_JSON_KEYS,
  type HeaderPair,
  type SessionDetail,
} from "../types/proxy";
import { decodeBase64ToBytes, statusReasonPhrase } from "./formatters";

export type OpenApiFormat = "yaml" | "json";

export type HttpMethodLower =
  | "get"
  | "put"
  | "post"
  | "delete"
  | "options"
  | "head"
  | "patch"
  | "trace";

const OPENAPI_HTTP_METHOD_ORDER: readonly HttpMethodLower[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
] as const;

const METHODS_WITHOUT_REQUEST_BODY = new Set<HttpMethodLower>([
  "get",
  "head",
  "options",
  "trace",
]);

const MAX_SCHEMA_DEPTH = 12;
const MAX_ARRAY_SCHEMA_SAMPLE = 50;
const MAX_EXAMPLE_ARRAY_ITEMS = 2;
const MAX_EXAMPLE_STRING_LEN = 200;
const MAX_TEXT_EXAMPLE_LEN = 300;

export interface OpenApiGeneratorOptions {
  title?: string;
  version?: string;
  description?: string;
  format?: OpenApiFormat;
  includeExamples?: boolean;
  redactSensitiveExamples?: boolean;
  groupByTags?: boolean;
}

export interface JsonSchemaObject {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  format?: string;
  nullable?: boolean;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  items?: JsonSchemaObject;
  oneOf?: JsonSchemaObject[];
  example?: unknown;
}

export interface OpenApiParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  schema: JsonSchemaObject;
  example?: unknown;
}

export interface OpenApiMediaType {
  schema: JsonSchemaObject;
  example?: unknown;
}

export interface OpenApiRequestBody {
  required?: boolean;
  content: Record<string, OpenApiMediaType>;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  operationId: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
  security?: Array<Record<string, string[]>>;
}

export interface OpenApiSecurityScheme {
  type: "http" | "apiKey";
  scheme?: "bearer" | "basic";
  bearerFormat?: string;
  in?: "header" | "query" | "cookie";
  name?: string;
  description?: string;
}

export interface OpenApiDocument {
  openapi: "3.0.3";
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers: Array<{ url: string }>;
  paths: Record<string, Partial<Record<HttpMethodLower, OpenApiOperation>>>;
  components?: {
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
}

export interface OpenApiGenerationStats {
  totalSessionsInput: number;
  includedSessions: number;
  skippedSessions: number;
  serversCount: number;
  pathsCount: number;
  operationsCount: number;
  securitySchemes: string[];
}

export interface OpenApiGenerationResult {
  spec: OpenApiDocument;
  serialized: string;
  stats: OpenApiGenerationStats;
}

export interface NormalizedPathParam {
  name: string;
  schema: JsonSchemaObject;
  sampleValue: string | number;
}

export interface NormalizedEndpointPathResult {
  template: string;
  structuralKey: string;
  params: NormalizedPathParam[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNSIGNED_INT_RE = /^\d+$/;
const SIGNED_INT_RE = /^-?(0|[1-9]\d*)$/;
const SIGNED_NUM_RE = /^-?(0|[1-9]\d*)\.\d+$/;
const OBJECT_ID_HEX24_RE = /^[0-9a-f]{24}$/i;
const ISO_DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HTTP_URI_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BEARER_PREFIX_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

const SENSITIVE_KEY_TOKENS = new Set<string>([
  ...DEFAULT_MASK_JSON_KEYS.map((k) => k.toLowerCase()),
  "authorization",
  "cookie",
  "set-cookie",
  "set_cookie",
  "jwt",
  "id_token",
  "client_secret",
  "private_key",
  "session_id",
  "sessionid",
  "apikey",
  "api_key",
  "accesstoken",
  "refreshtoken",
  "secretkey",
  "csrf",
  "xsrf",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "key",
  "auth",
  "signature",
  "sig",
  "code",
]);

const PREFERRED_AUTH_COOKIE_NAMES = new Set<string>([
  "session_id",
  "sessionid",
  "sid",
  "session",
  "token",
  "auth",
  "auth_token",
  "access_token",
  "jwt",
  "jsessionid",
  "connect.sid",
  "phpsessid",
  "asp.net_sessionid",
  "_session",
]);

const EXTRA_STATUS_PHRASES: Record<number, string> = {
  202: "Accepted",
  206: "Partial Content",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  426: "Upgrade Required",
  504: "Gateway Timeout",
};

function getOpenApiStatusDescription(statusKey: string): string {
  if (statusKey === "default") return "Default response";
  const code = Number(statusKey);
  if (!Number.isInteger(code)) return "Response";
  return EXTRA_STATUS_PHRASES[code] ?? statusReasonPhrase(code);
}

function safeDecodeURIComponent(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isSensitiveFieldName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower) return false;
  if (SENSITIVE_KEY_TOKENS.has(lower)) return true;
  const normalized = lower.replace(/[-_]/g, "");
  if (
    normalized === "apikey" ||
    normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "idtoken" ||
    normalized === "clientsecret" ||
    normalized === "privatekey" ||
    normalized === "sessionid" ||
    normalized === "authtoken"
  ) {
    return true;
  }
  return (
    lower.includes("password") ||
    lower.includes("passwd") ||
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("api_key") ||
    lower.includes("api-key") ||
    lower.includes("authorization") ||
    lower.includes("cookie")
  );
}

function sanitizeStringLiteral(value: string): string {
  const trimmed = value.trim();
  if (JWT_RE.test(trimmed)) {
    return "<REDACTED>";
  }
  let sanitized = value.replace(BEARER_PREFIX_RE, "Bearer <REDACTED>");
  sanitized = sanitized.replace(
    /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    "<REDACTED>"
  );
  sanitized = sanitized.replace(
    /((?:token|api_key|apikey|secret|password|passwd|auth|access_token|refresh_token)=)([^&\s"']+)/gi,
    "$1<REDACTED>"
  );
  return sanitized;
}

function redactExampleValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth >= 8) return value;

  if (typeof value === "string") {
    const cleaned = sanitizeStringLiteral(value);
    if (cleaned.length > MAX_EXAMPLE_STRING_LEN) {
      return `${cleaned.slice(0, MAX_EXAMPLE_STRING_LEN)}...`;
    }
    return cleaned;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_EXAMPLE_ARRAY_ITEMS)
      .map((item) => redactExampleValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const v = input[key];
      if (v === undefined) continue;
      if (isSensitiveFieldName(key)) {
        out[key] = "<REDACTED>";
      } else {
        out[key] = redactExampleValue(v, depth + 1);
      }
    }
    return out;
  }

  return value;
}

function stripNonSchemaProps(schema: JsonSchemaObject): JsonSchemaObject {
  const copy: JsonSchemaObject = {};
  if (schema.type !== undefined) copy.type = schema.type;
  if (schema.format !== undefined) copy.format = schema.format;
  if (schema.nullable === true) copy.nullable = true;
  if (schema.properties !== undefined) copy.properties = schema.properties;
  if (schema.required !== undefined && schema.required.length > 0) {
    copy.required = schema.required;
  }
  if (schema.items !== undefined) copy.items = schema.items;
  if (schema.oneOf !== undefined) copy.oneOf = schema.oneOf;
  if (schema.example !== undefined) copy.example = schema.example;
  return copy;
}

function isNullOnlySchema(schema: JsonSchemaObject): boolean {
  return (
    !schema.type &&
    !schema.oneOf &&
    !schema.properties &&
    !schema.items &&
    schema.nullable === true
  );
}

function isEmptySchema(schema: JsonSchemaObject): boolean {
  return (
    !schema.type &&
    !schema.oneOf &&
    !schema.properties &&
    !schema.items &&
    schema.nullable !== true &&
    !schema.format &&
    (!schema.required || schema.required.length === 0)
  );
}

function cloneSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const copy: JsonSchemaObject = {};
  if (schema.type !== undefined) copy.type = schema.type;
  if (schema.format !== undefined) copy.format = schema.format;
  if (schema.nullable === true) copy.nullable = true;
  if (schema.properties !== undefined) {
    const props: Record<string, JsonSchemaObject> = {};
    for (const key of Object.keys(schema.properties).sort()) {
      props[key] = cloneSchema(schema.properties[key]);
    }
    copy.properties = props;
  }
  if (schema.required !== undefined && schema.required.length > 0) {
    copy.required = [...schema.required].sort();
  }
  if (schema.items !== undefined) {
    copy.items = cloneSchema(schema.items);
  }
  if (schema.oneOf !== undefined) {
    copy.oneOf = schema.oneOf.map((branch) => cloneSchema(branch));
  }
  if (schema.example !== undefined) {
    copy.example = schema.example;
  }
  return copy;
}

function areDirectlyCompatibleTypes(
  a: JsonSchemaObject,
  b: JsonSchemaObject
): boolean {
  if (!a.type || !b.type) return false;
  if (a.type === b.type) return true;
  return (
    (a.type === "integer" && b.type === "number") ||
    (a.type === "number" && b.type === "integer")
  );
}

function schemaBranchSortKey(s: JsonSchemaObject): string {
  const typeKey = s.type ?? "unknown";
  const formatKey = s.format ?? "";
  const propKeys = s.properties ? Object.keys(s.properties).sort().join(",") : "";
  return `${typeKey}:${formatKey}:${propKeys}`;
}

export function mergeJsonSchemas(
  a: JsonSchemaObject,
  b: JsonSchemaObject,
  depth = 0
): JsonSchemaObject {
  if (depth >= MAX_SCHEMA_DEPTH) {
    return cloneSchema(a.type ? a : b);
  }
  if (isEmptySchema(a)) return cloneSchema(b);
  if (isEmptySchema(b)) return cloneSchema(a);

  const aNull = isNullOnlySchema(a);
  const bNull = isNullOnlySchema(b);
  if (aNull && bNull) {
    return { nullable: true };
  }
  if (aNull) {
    const res = cloneSchema(b);
    res.nullable = true;
    return res;
  }
  if (bNull) {
    const res = cloneSchema(a);
    res.nullable = true;
    return res;
  }

  const nullable = Boolean(a.nullable || b.nullable);

  if (!a.oneOf && !b.oneOf && areDirectlyCompatibleTypes(a, b)) {
    if (a.type === "object" && b.type === "object") {
      const aProps = a.properties ?? {};
      const bProps = b.properties ?? {};
      const allKeys = Array.from(
        new Set([...Object.keys(aProps), ...Object.keys(bProps)])
      ).sort();
      const mergedProps: Record<string, JsonSchemaObject> = {};
      for (const key of allKeys) {
        const hasA = Object.prototype.hasOwnProperty.call(aProps, key);
        const hasB = Object.prototype.hasOwnProperty.call(bProps, key);
        if (hasA && hasB) {
          mergedProps[key] = mergeJsonSchemas(aProps[key], bProps[key], depth + 1);
        } else if (hasA) {
          mergedProps[key] = cloneSchema(aProps[key]);
        } else if (hasB) {
          mergedProps[key] = cloneSchema(bProps[key]);
        }
      }
      const aReq = new Set(a.required ?? []);
      const required = (b.required ?? []).filter((k) => aReq.has(k)).sort();
      const out: JsonSchemaObject = {
        type: "object",
        properties: mergedProps,
      };
      if (required.length > 0) {
        out.required = required;
      }
      if (nullable) {
        out.nullable = true;
      }
      return out;
    }

    if (a.type === "array" && b.type === "array") {
      const mergedItems = mergeJsonSchemas(
        a.items ?? {},
        b.items ?? {},
        depth + 1
      );
      const out: JsonSchemaObject = {
        type: "array",
        items: mergedItems,
      };
      if (nullable) out.nullable = true;
      return out;
    }

    if (
      (a.type === "integer" || a.type === "number") &&
      (b.type === "integer" || b.type === "number")
    ) {
      const out: JsonSchemaObject = {
        type: a.type === "number" || b.type === "number" ? "number" : "integer",
      };
      if (nullable) out.nullable = true;
      return out;
    }

    if (a.type === "string" && b.type === "string") {
      const out: JsonSchemaObject = { type: "string" };
      if (a.format && a.format === b.format) {
        out.format = a.format;
      }
      if (nullable) out.nullable = true;
      return out;
    }

    if (a.type === "boolean" && b.type === "boolean") {
      const out: JsonSchemaObject = { type: "boolean" };
      if (nullable) out.nullable = true;
      return out;
    }
  }

  let hasNullBranch = nullable;
  const rawBranches: JsonSchemaObject[] = [];
  const collectBranches = (node: JsonSchemaObject) => {
    if (node.nullable) hasNullBranch = true;
    if (node.oneOf && node.oneOf.length > 0) {
      for (const br of node.oneOf) {
        collectBranches(br);
      }
      return;
    }
    if (isNullOnlySchema(node) || isEmptySchema(node)) {
      if (isNullOnlySchema(node)) hasNullBranch = true;
      return;
    }
    const stripped = cloneSchema(node);
    delete stripped.nullable;
    rawBranches.push(stripped);
  };

  collectBranches(a);
  collectBranches(b);

  const mergedBranches: JsonSchemaObject[] = [];
  for (const branch of rawBranches) {
    const compatIdx = mergedBranches.findIndex((existing) =>
      areDirectlyCompatibleTypes(existing, branch)
    );
    if (compatIdx !== -1) {
      mergedBranches[compatIdx] = mergeJsonSchemas(
        mergedBranches[compatIdx],
        branch,
        depth + 1
      );
      delete mergedBranches[compatIdx].nullable;
    } else {
      mergedBranches.push(branch);
    }
  }

  mergedBranches.sort((x, y) =>
    schemaBranchSortKey(x).localeCompare(schemaBranchSortKey(y))
  );

  if (mergedBranches.length === 0) {
    return hasNullBranch ? { nullable: true } : {};
  }
  if (mergedBranches.length === 1) {
    const single = cloneSchema(mergedBranches[0]);
    if (hasNullBranch) single.nullable = true;
    return single;
  }

  const out: JsonSchemaObject = { oneOf: mergedBranches };
  if (hasNullBranch) out.nullable = true;
  return out;
}

function detectStringFormat(value: string): string | undefined {
  if (!value || value.length > 512) return undefined;
  if (UUID_RE.test(value)) return "uuid";
  if (ISO_DATE_TIME_RE.test(value)) return "date-time";
  if (ISO_DATE_RE.test(value)) return "date";
  if (EMAIL_RE.test(value)) return "email";
  if (HTTP_URI_RE.test(value)) return "uri";
  return undefined;
}

function inferScalarSchemaFromString(raw: string): JsonSchemaObject {
  const trimmed = raw.trim();
  if (!trimmed) return { type: "string" };
  if (/^(true|false)$/i.test(trimmed)) {
    return { type: "boolean" };
  }
  if (SIGNED_INT_RE.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isSafeInteger(num)) {
      return { type: "integer" };
    }
  }
  if (SIGNED_NUM_RE.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return { type: "number" };
    }
  }
  const format = detectStringFormat(trimmed);
  return format ? { type: "string", format } : { type: "string" };
}

function parseScalarExampleValue(raw: string, schema: JsonSchemaObject): unknown {
  if (schema.type === "boolean") {
    return raw.trim().toLowerCase() === "true";
  }
  if (schema.type === "integer" || schema.type === "number") {
    const n = Number(raw.trim());
    if (Number.isFinite(n)) return n;
  }
  return raw.length > MAX_EXAMPLE_STRING_LEN
    ? `${raw.slice(0, MAX_EXAMPLE_STRING_LEN)}...`
    : raw;
}

export function inferSchemaFromJsonValue(
  value: unknown,
  depth = 0
): JsonSchemaObject {
  if (value === null) {
    return { nullable: true };
  }
  if (typeof value === "boolean") {
    return { type: "boolean" };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { type: "number" };
    return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
  }
  if (typeof value === "string") {
    const format = detectStringFormat(value);
    return format ? { type: "string", format } : { type: "string" };
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || depth >= MAX_SCHEMA_DEPTH) {
      return { type: "array", items: {} };
    }
    const sample = value.slice(0, MAX_ARRAY_SCHEMA_SAMPLE);
    let itemSchema = inferSchemaFromJsonValue(sample[0], depth + 1);
    for (let i = 1; i < sample.length; i++) {
      itemSchema = mergeJsonSchemas(
        itemSchema,
        inferSchemaFromJsonValue(sample[i], depth + 1),
        depth + 1
      );
    }
    return {
      type: "array",
      items: itemSchema,
    };
  }
  if (typeof value === "object") {
    if (depth >= MAX_SCHEMA_DEPTH) {
      return { type: "object" };
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const properties: Record<string, JsonSchemaObject> = {};
    const required: string[] = [];
    for (const key of keys) {
      const propVal = obj[key];
      if (propVal === undefined) continue;
      properties[key] = inferSchemaFromJsonValue(propVal, depth + 1);
      required.push(key);
    }
    const schema: JsonSchemaObject = {
      type: "object",
      properties,
    };
    if (required.length > 0) {
      schema.required = required;
    }
    return schema;
  }
  return { type: "string" };
}

export function normalizeEndpointPath(
  pathname: string
): NormalizedEndpointPathResult {
  const collapsed = (pathname || "/").replace(/\/{2,}/g, "/");
  const trimmed =
    collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed || "/";
  const rawSegments = trimmed.split("/").filter((seg) => seg.length > 0);

  if (rawSegments.length === 0) {
    return {
      template: "/",
      structuralKey: "/",
      params: [],
    };
  }

  const usedNames = new Set<string>();
  const outSegments: string[] = [];
  const structSegments: string[] = [];
  const params: NormalizedPathParam[] = [];
  let paramCount = 0;

  for (const rawSeg of rawSegments) {
    const decoded = safeDecodeURIComponent(rawSeg);
    let baseName: "id" | "uuid" | null = null;
    let schema: JsonSchemaObject | null = null;
    let sampleValue: string | number = decoded;

    if (UUID_RE.test(decoded)) {
      baseName = "uuid";
      schema = { type: "string", format: "uuid" };
    } else if (UNSIGNED_INT_RE.test(decoded)) {
      baseName = "id";
      const asNum = Number(decoded);
      if (Number.isSafeInteger(asNum)) {
        schema = { type: "integer" };
        sampleValue = asNum;
      } else {
        schema = { type: "string" };
        sampleValue = decoded;
      }
    } else if (OBJECT_ID_HEX24_RE.test(decoded)) {
      baseName = "id";
      schema = { type: "string" };
    }

    if (baseName && schema) {
      paramCount += 1;
      let paramName: string = baseName;
      if (usedNames.has(paramName)) {
        let candidateNum = paramCount;
        while (usedNames.has(`param${candidateNum}`)) {
          candidateNum += 1;
        }
        paramName = `param${candidateNum}`;
      }
      usedNames.add(paramName);
      outSegments.push(`{${paramName}}`);
      structSegments.push("{*}");
      params.push({
        name: paramName,
        schema,
        sampleValue,
      });
    } else {
      outSegments.push(rawSeg);
      structSegments.push(rawSeg);
    }
  }

  return {
    template: `/${outSegments.join("/")}`,
    structuralKey: `/${structSegments.join("/")}`,
    params,
  };
}

function buildTemplateFromStructural(
  structuralKey: string,
  paramNames: string[]
): string {
  if (structuralKey === "/") return "/";
  const parts = structuralKey.split("/").filter(Boolean);
  let pIdx = 0;
  const rendered = parts.map((part) => {
    if (part === "{*}") {
      const name = paramNames[pIdx] ?? `param${pIdx + 1}`;
      pIdx += 1;
      return `{${name}}`;
    }
    return part;
  });
  return `/${rendered.join("/")}`;
}

function parseSessionUrl(detail: SessionDetail): URL | null {
  const rawUrl = detail.summary.url?.trim();
  if (rawUrl) {
    try {
      return new URL(rawUrl);
    } catch {
      // fall through to reconstructed URL
    }
  }
  const scheme = (detail.summary.scheme || "https").toLowerCase();
  const host = detail.summary.host || "localhost";
  const path = detail.summary.path?.startsWith("/")
    ? detail.summary.path
    : `/${detail.summary.path || ""}`;
  try {
    return new URL(`${scheme}://${host}${path}`);
  } catch {
    return null;
  }
}

function isIncludedSession(detail: SessionDetail): HttpMethodLower | null {
  if (detail.summary.tlsBypassed) return null;
  const scheme = (detail.summary.scheme || "").toLowerCase();
  if (scheme === "ws" || scheme === "wss") return null;
  if (detail.summary.status === 101) return null;
  const methodLower = (detail.summary.method || "").trim().toLowerCase();
  if (methodLower === "connect") return null;
  if (
    (OPENAPI_HTTP_METHOD_ORDER as readonly string[]).includes(methodLower)
  ) {
    return methodLower as HttpMethodLower;
  }
  return null;
}

function findHeaderValue(
  headers: HeaderPair[],
  targetLower: string
): string | null {
  for (const h of headers) {
    if (h.name.trim().toLowerCase() === targetLower) {
      return h.value;
    }
  }
  return null;
}

function normalizeMediaType(rawContentType: string | null | undefined): string {
  if (!rawContentType) return "application/octet-stream";
  const base = rawContentType.split(";")[0]?.trim().toLowerCase();
  return base || "application/octet-stream";
}

function extractMultipartBoundary(rawContentType: string): string | null {
  const match = rawContentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = match?.[1] ?? match?.[2] ?? "";
  return boundary.trim() || null;
}

function isBinaryMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("image/") ||
    mediaType.startsWith("audio/") ||
    mediaType.startsWith("video/") ||
    mediaType.startsWith("font/") ||
    mediaType.startsWith("application/grpc") ||
    mediaType.includes("protobuf") ||
    mediaType === "application/octet-stream" ||
    mediaType === "application/pdf" ||
    mediaType === "application/zip" ||
    mediaType === "application/gzip"
  );
}

function isJsonMediaType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function resolveBodyPayload(
  text: string | null | undefined,
  base64: string | null | undefined,
  mediaType: string
): {
  hasBody: boolean;
  text: string | null;
  isBinary: boolean;
} {
  if (text !== null && text !== undefined && text.length > 0) {
    return {
      hasBody: true,
      text,
      isBinary: isBinaryMediaType(mediaType),
    };
  }
  if (!base64) {
    return { hasBody: false, text: null, isBinary: false };
  }
  const bytes = decodeBase64ToBytes(base64);
  if (bytes.length === 0) {
    return { hasBody: false, text: null, isBinary: false };
  }
  if (isBinaryMediaType(mediaType)) {
    return { hasBody: true, text: null, isBinary: true };
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { hasBody: true, text: decoded, isBinary: false };
  } catch {
    return { hasBody: true, text: null, isBinary: true };
  }
}

interface ParsedBodyInfo {
  mediaType: string;
  schema: JsonSchemaObject;
  example?: unknown;
}

function parseMultipartBody(
  rawBody: string,
  boundary: string
): { schema: JsonSchemaObject; example: Record<string, unknown> } | null {
  const delimiter = `--${boundary}`;
  const rawParts = rawBody.split(delimiter);
  if (rawParts.length < 2) return null;

  const properties: Record<string, JsonSchemaObject> = {};
  const required: string[] = [];
  const exampleObj: Record<string, unknown> = {};

  for (const part of rawParts) {
    const trimmed = part.replace(/^\r?\n/, "");
    if (!trimmed || trimmed.startsWith("--")) continue;

    let sepIdx = trimmed.indexOf("\r\n\r\n");
    let sepLen = 4;
    if (sepIdx === -1) {
      sepIdx = trimmed.indexOf("\n\n");
      sepLen = 2;
    }
    if (sepIdx === -1) continue;

    const headersSection = trimmed.slice(0, sepIdx);
    const bodySection = trimmed
      .slice(sepIdx + sepLen)
      .replace(/\r?\n$/, "");

    const dispMatch = headersSection.match(
      /content-disposition\s*:[^\r\n]*\bname="([^"]+)"/i
    );
    const fieldName = dispMatch?.[1]?.trim();
    if (!fieldName) continue;

    const hasFilename = /\bfilename="[^"]*"/i.test(headersSection);
    const partCtMatch = headersSection.match(/content-type\s*:\s*([^\r\n;]+)/i);
    const partCt = partCtMatch?.[1]?.trim().toLowerCase() ?? "";

    if (hasFilename) {
      properties[fieldName] = { type: "string", format: "binary" };
      exampleObj[fieldName] = "<binary>";
    } else if (isJsonMediaType(partCt)) {
      try {
        const parsed = JSON.parse(bodySection) as unknown;
        properties[fieldName] = inferSchemaFromJsonValue(parsed);
        exampleObj[fieldName] = parsed;
      } catch {
        properties[fieldName] = inferScalarSchemaFromString(bodySection);
        exampleObj[fieldName] = bodySection;
      }
    } else {
      const scalar = inferScalarSchemaFromString(bodySection);
      properties[fieldName] = scalar;
      exampleObj[fieldName] = parseScalarExampleValue(bodySection, scalar);
    }

    if (!required.includes(fieldName)) {
      required.push(fieldName);
    }
  }

  const sortedProps: Record<string, JsonSchemaObject> = {};
  for (const key of Object.keys(properties).sort()) {
    sortedProps[key] = properties[key];
  }
  required.sort();

  const schema: JsonSchemaObject = {
    type: "object",
    properties: sortedProps,
  };
  if (required.length > 0) {
    schema.required = required;
  }
  return { schema, example: exampleObj };
}

function inferBodyMediaEntry(
  rawContentType: string | null | undefined,
  bodyText: string | null | undefined,
  bodyBase64: string | null | undefined
): ParsedBodyInfo | null {
  let mediaType = normalizeMediaType(rawContentType);
  const payload = resolveBodyPayload(bodyText, bodyBase64, mediaType);
  if (!payload.hasBody) return null;

  if (payload.isBinary || payload.text === null) {
    return {
      mediaType,
      schema: { type: "string", format: "binary" },
    };
  }

  const text = payload.text;
  const trimmed = text.trim();

  if (
    mediaType === "application/octet-stream" &&
    (trimmed.startsWith("{") || trimmed.startsWith("["))
  ) {
    try {
      JSON.parse(trimmed);
      mediaType = "application/json";
    } catch {
      // keep octet-stream
    }
  }

  if (
    isJsonMediaType(mediaType) ||
    (mediaType === "text/plain" &&
      (trimmed.startsWith("{") || trimmed.startsWith("[")))
  ) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return {
        mediaType: isJsonMediaType(mediaType) ? mediaType : "application/json",
        schema: inferSchemaFromJsonValue(parsed),
        example: parsed,
      };
    } catch {
      return {
        mediaType,
        schema: { type: "string" },
        example:
          trimmed.length > MAX_TEXT_EXAMPLE_LEN
            ? `${trimmed.slice(0, MAX_TEXT_EXAMPLE_LEN)}...`
            : trimmed,
      };
    }
  }

  if (mediaType === "application/x-www-form-urlencoded") {
    const search = new URLSearchParams(trimmed);
    const keyValues = new Map<string, string[]>();
    search.forEach((val, key) => {
      const arr = keyValues.get(key) ?? [];
      arr.push(val);
      keyValues.set(key, arr);
    });
    const sortedKeys = Array.from(keyValues.keys()).sort();
    const properties: Record<string, JsonSchemaObject> = {};
    const exampleObj: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const vals = keyValues.get(key) ?? [];
      if (vals.length > 1) {
        let itemSchema = inferScalarSchemaFromString(vals[0]);
        for (let i = 1; i < vals.length; i++) {
          itemSchema = mergeJsonSchemas(
            itemSchema,
            inferScalarSchemaFromString(vals[i])
          );
        }
        properties[key] = { type: "array", items: itemSchema };
        exampleObj[key] = vals
          .slice(0, MAX_EXAMPLE_ARRAY_ITEMS)
          .map((v) => parseScalarExampleValue(v, itemSchema));
      } else {
        const val = vals[0] ?? "";
        const scalar = inferScalarSchemaFromString(val);
        properties[key] = scalar;
        exampleObj[key] = parseScalarExampleValue(val, scalar);
      }
    }
    const schema: JsonSchemaObject = {
      type: "object",
      properties,
    };
    if (sortedKeys.length > 0) {
      schema.required = sortedKeys;
    }
    return {
      mediaType,
      schema,
      example: exampleObj,
    };
  }

  if (mediaType === "multipart/form-data") {
    const boundary = rawContentType
      ? extractMultipartBoundary(rawContentType)
      : null;
    if (boundary) {
      const parsed = parseMultipartBody(text, boundary);
      if (parsed) {
        return {
          mediaType,
          schema: parsed.schema,
          example: parsed.example,
        };
      }
    }
    return {
      mediaType,
      schema: { type: "object" },
    };
  }

  const clipped =
    trimmed.length > MAX_TEXT_EXAMPLE_LEN
      ? `${trimmed.slice(0, MAX_TEXT_EXAMPLE_LEN)}...`
      : trimmed;

  return {
    mediaType,
    schema: { type: "string" },
    example: clipped,
  };
}

function extractCookieNameForScheme(cookieHeaderValue: string): string {
  const parts = cookieHeaderValue.split(";");
  const names: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    const rawName = (eq === -1 ? part : part.slice(0, eq)).trim();
    if (rawName) names.push(rawName);
  }
  for (const candidate of names) {
    if (PREFERRED_AUTH_COOKIE_NAMES.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return names[0] || "session";
}

function toCamelSchemeId(headerName: string): string {
  const parts = headerName
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) return "headerAuth";
  const camel = parts
    .map((p, idx) => (idx === 0 ? p : `${p[0].toUpperCase()}${p.slice(1)}`))
    .join("");
  return camel.endsWith("Auth") ? camel : `${camel}Auth`;
}

function extractSecurityFromHeaders(
  headers: HeaderPair[],
  registry: Map<string, OpenApiSecurityScheme>
): string[] {
  const matchedSchemes = new Set<string>();

  for (const h of headers) {
    const nameLower = h.name.trim().toLowerCase();
    const valTrimmed = h.value.trim();

    if (nameLower === "authorization") {
      const bearerMatch = valTrimmed.match(/^bearer\s+(.+)$/i);
      if (bearerMatch) {
        const token = bearerMatch[1].trim();
        const isJwt = JWT_RE.test(token);
        const existing = registry.get("bearerAuth");
        registry.set("bearerAuth", {
          type: "http",
          scheme: "bearer",
          ...(isJwt || existing?.bearerFormat === "JWT"
            ? { bearerFormat: "JWT" }
            : {}),
        });
        matchedSchemes.add("bearerAuth");
      } else if (/^basic\s+/i.test(valTrimmed)) {
        if (!registry.has("basicAuth")) {
          registry.set("basicAuth", {
            type: "http",
            scheme: "basic",
          });
        }
        matchedSchemes.add("basicAuth");
      } else {
        if (!registry.has("authorizationHeader")) {
          registry.set("authorizationHeader", {
            type: "apiKey",
            in: "header",
            name: "Authorization",
          });
        }
        matchedSchemes.add("authorizationHeader");
      }
      continue;
    }

    if (nameLower === "cookie") {
      const cookieName = extractCookieNameForScheme(h.value);
      if (!registry.has("cookieAuth")) {
        registry.set("cookieAuth", {
          type: "apiKey",
          in: "cookie",
          name: cookieName,
        });
      }
      matchedSchemes.add("cookieAuth");
      continue;
    }

    if (nameLower === "x-api-key") {
      if (!registry.has("apiKeyAuth")) {
        registry.set("apiKeyAuth", {
          type: "apiKey",
          in: "header",
          name: "X-Api-Key",
        });
      }
      matchedSchemes.add("apiKeyAuth");
      continue;
    }

    if (
      nameLower === "x-auth-token" ||
      nameLower === "api-key" ||
      nameLower === "x-access-token" ||
      nameLower === "proxy-authorization"
    ) {
      const schemeKey = toCamelSchemeId(h.name);
      if (!registry.has(schemeKey)) {
        registry.set(schemeKey, {
          type: "apiKey",
          in: "header",
          name: h.name.trim(),
        });
      }
      matchedSchemes.add(schemeKey);
    }
  }

  return Array.from(matchedSchemes).sort();
}

function buildOperationTag(templatePath: string, host: string): string {
  const segs = templatePath.split("/").filter(Boolean);
  for (const seg of segs) {
    if (seg.startsWith("{") && seg.endsWith("}")) continue;
    const lower = seg.toLowerCase();
    if (lower === "api" || /^v\d+(\.\d+)?$/i.test(lower)) continue;
    return seg;
  }
  return host || "default";
}

function toPascalToken(raw: string): string {
  const parts = raw.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return parts
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
}

function buildBaseOperationId(
  method: HttpMethodLower,
  templatePath: string
): string {
  const segs = templatePath.split("/").filter(Boolean);
  if (segs.length === 0) return `${method}Root`;

  const tokens: string[] = [];
  for (const seg of segs) {
    if (seg.startsWith("{") && seg.endsWith("}")) {
      const inner = seg.slice(1, -1);
      tokens.push(`By${toPascalToken(inner) || "Param"}`);
    } else {
      const clean = toPascalToken(seg);
      if (clean) tokens.push(clean);
    }
  }
  const suffix = tokens.join("") || "Endpoint";
  return `${method}${suffix}`;
}

interface QueryParamAccumulator {
  name: string;
  schema: JsonSchemaObject;
  example?: unknown;
}

interface MediaAccumulator {
  schema: JsonSchemaObject;
  example?: unknown;
}

interface OperationAccumulator {
  method: HttpMethodLower;
  pathParams: Array<{ schema: JsonSchemaObject; sampleValue?: unknown }>;
  queryParams: Map<string, QueryParamAccumulator>;
  requestSessionCount: number;
  sessionsWithRequestBody: number;
  requestMedia: Map<string, MediaAccumulator>;
  responses: Map<
    string,
    {
      description: string;
      media: Map<string, MediaAccumulator>;
    }
  >;
  securitySchemes: Set<string>;
  hosts: Map<string, number>;
}

interface PathGroupAccumulator {
  structuralKey: string;
  paramNames: string[];
  operations: Map<HttpMethodLower, OperationAccumulator>;
}

function sortStatusKeys(keys: Iterable<string>): string[] {
  return Array.from(keys).sort((a, b) => {
    if (a === "default" && b === "default") return 0;
    if (a === "default") return 1;
    if (b === "default") return -1;
    return Number(a) - Number(b);
  });
}

function formatExampleForOutput(
  example: unknown,
  redactSensitive: boolean
): unknown {
  if (!redactSensitive) return example;
  return redactExampleValue(example);
}

export function buildOpenApiDocument(
  sessions: SessionDetail[],
  options: OpenApiGeneratorOptions = {}
): OpenApiGenerationResult {
  const title = (options.title ?? "").trim() || "FluxProxy Captured API";
  const version = (options.version ?? "").trim() || "1.0.0";
  const description = options.description?.trim();
  const format: OpenApiFormat = options.format ?? "yaml";
  const includeExamples = options.includeExamples ?? false;
  const redactSensitiveExamples = options.redactSensitiveExamples ?? true;
  const groupByTags = options.groupByTags ?? true;

  const serverCounts = new Map<string, number>();
  const pathGroups = new Map<string, PathGroupAccumulator>();
  const securityRegistry = new Map<string, OpenApiSecurityScheme>();

  let includedSessions = 0;
  let skippedSessions = 0;

  for (const detail of sessions) {
    const method = isIncludedSession(detail);
    if (!method) {
      skippedSessions += 1;
      continue;
    }

    const parsedUrl = parseSessionUrl(detail);
    if (!parsedUrl) {
      skippedSessions += 1;
      continue;
    }

    includedSessions += 1;
    const serverOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;
    serverCounts.set(serverOrigin, (serverCounts.get(serverOrigin) ?? 0) + 1);

    const normalizedPath = normalizeEndpointPath(parsedUrl.pathname);

    let pathGroup = pathGroups.get(normalizedPath.structuralKey);
    if (!pathGroup) {
      pathGroup = {
        structuralKey: normalizedPath.structuralKey,
        paramNames: normalizedPath.params.map((p) => p.name),
        operations: new Map(),
      };
      pathGroups.set(normalizedPath.structuralKey, pathGroup);
    } else {
      // Prefer {id} over {uuid} at the same structural slot when merging across sessions
      for (let i = 0; i < normalizedPath.params.length; i++) {
        const existingName = pathGroup.paramNames[i];
        const incomingName = normalizedPath.params[i].name;
        if (
          existingName === "uuid" &&
          incomingName === "id" &&
          !pathGroup.paramNames.includes("id")
        ) {
          pathGroup.paramNames[i] = "id";
        }
      }
    }

    let opAcc = pathGroup.operations.get(method);
    if (!opAcc) {
      opAcc = {
        method,
        pathParams: normalizedPath.params.map((p) => ({
          schema: cloneSchema(p.schema),
          sampleValue: p.sampleValue,
        })),
        queryParams: new Map(),
        requestSessionCount: 0,
        sessionsWithRequestBody: 0,
        requestMedia: new Map(),
        responses: new Map(),
        securitySchemes: new Set(),
        hosts: new Map(),
      };
      pathGroup.operations.set(method, opAcc);
    } else {
      for (let i = 0; i < normalizedPath.params.length; i++) {
        const existingSlot = opAcc.pathParams[i];
        const incoming = normalizedPath.params[i];
        if (existingSlot) {
          existingSlot.schema = mergeJsonSchemas(
            existingSlot.schema,
            incoming.schema
          );
          if (existingSlot.sampleValue === undefined) {
            existingSlot.sampleValue = incoming.sampleValue;
          }
        } else {
          opAcc.pathParams[i] = {
            schema: cloneSchema(incoming.schema),
            sampleValue: incoming.sampleValue,
          };
        }
      }
    }

    opAcc.requestSessionCount += 1;
    opAcc.hosts.set(
      parsedUrl.host,
      (opAcc.hosts.get(parsedUrl.host) ?? 0) + 1
    );

    // 1. Security schemes from request headers (never storing token/cookie values)
    const sessionSchemes = extractSecurityFromHeaders(
      detail.requestHeaders ?? [],
      securityRegistry
    );
    for (const schemeId of sessionSchemes) {
      opAcc.securitySchemes.add(schemeId);
    }

    // 2. Query parameters
    const groupedQueryValues = new Map<string, string[]>();
    parsedUrl.searchParams.forEach((val, key) => {
      const list = groupedQueryValues.get(key) ?? [];
      list.push(val);
      groupedQueryValues.set(key, list);
    });

    for (const [qName, vals] of groupedQueryValues.entries()) {
      let qSchema: JsonSchemaObject;
      let qExample: unknown;

      if (vals.length > 1) {
        let itemSchema = inferScalarSchemaFromString(vals[0]);
        for (let i = 1; i < vals.length; i++) {
          itemSchema = mergeJsonSchemas(
            itemSchema,
            inferScalarSchemaFromString(vals[i])
          );
        }
        qSchema = { type: "array", items: itemSchema };
        if (includeExamples) {
          qExample =
            redactSensitiveExamples && isSensitiveFieldName(qName)
              ? ["<REDACTED>"]
              : vals
                  .slice(0, MAX_EXAMPLE_ARRAY_ITEMS)
                  .map((v) => parseScalarExampleValue(v, itemSchema));
        }
      } else {
        const rawVal = vals[0] ?? "";
        qSchema = inferScalarSchemaFromString(rawVal);
        if (includeExamples) {
          qExample =
            redactSensitiveExamples && isSensitiveFieldName(qName)
              ? "<REDACTED>"
              : parseScalarExampleValue(rawVal, qSchema);
        }
      }

      const existingQuery = opAcc.queryParams.get(qName);
      if (!existingQuery) {
        opAcc.queryParams.set(qName, {
          name: qName,
          schema: qSchema,
          example: qExample,
        });
      } else {
        existingQuery.schema = mergeJsonSchemas(existingQuery.schema, qSchema);
        if (existingQuery.example === undefined && qExample !== undefined) {
          existingQuery.example = qExample;
        }
      }
    }

    // 3. Request Body (strictly omitted for GET/HEAD/OPTIONS/TRACE)
    if (!METHODS_WITHOUT_REQUEST_BODY.has(method)) {
      const reqContentType = findHeaderValue(
        detail.requestHeaders ?? [],
        "content-type"
      );
      const reqBodyInfo = inferBodyMediaEntry(
        reqContentType,
        detail.requestBodyText,
        detail.requestBodyBase64
      );
      if (reqBodyInfo) {
        opAcc.sessionsWithRequestBody += 1;
        const existingMedia = opAcc.requestMedia.get(reqBodyInfo.mediaType);
        if (!existingMedia) {
          opAcc.requestMedia.set(reqBodyInfo.mediaType, {
            schema: reqBodyInfo.schema,
            example: reqBodyInfo.example,
          });
        } else {
          existingMedia.schema = mergeJsonSchemas(
            existingMedia.schema,
            reqBodyInfo.schema
          );
          if (
            existingMedia.example === undefined &&
            reqBodyInfo.example !== undefined
          ) {
            existingMedia.example = reqBodyInfo.example;
          }
        }
      }
    }

    // 4. Response status & body
    const rawStatus = detail.summary.status;
    const statusKey =
      Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
        ? String(rawStatus)
        : "default";

    let respAcc = opAcc.responses.get(statusKey);
    if (!respAcc) {
      respAcc = {
        description: getOpenApiStatusDescription(statusKey),
        media: new Map(),
      };
      opAcc.responses.set(statusKey, respAcc);
    }

    const omitContentForStatus = statusKey === "204" || statusKey === "304";
    if (!omitContentForStatus) {
      const respContentType =
        findHeaderValue(detail.responseHeaders ?? [], "content-type") ??
        detail.summary.contentType;
      const respBodyInfo = inferBodyMediaEntry(
        respContentType,
        detail.responseBodyText,
        detail.responseBodyBase64
      );
      if (respBodyInfo) {
        const existingMedia = respAcc.media.get(respBodyInfo.mediaType);
        if (!existingMedia) {
          respAcc.media.set(respBodyInfo.mediaType, {
            schema: respBodyInfo.schema,
            example: respBodyInfo.example,
          });
        } else {
          existingMedia.schema = mergeJsonSchemas(
            existingMedia.schema,
            respBodyInfo.schema
          );
          if (
            existingMedia.example === undefined &&
            respBodyInfo.example !== undefined
          ) {
            existingMedia.example = respBodyInfo.example;
          }
        }
      }
    }
  }

  // Deterministic servers: frequency descending, then lexicographically
  const servers: Array<{ url: string }> =
    serverCounts.size > 0
      ? Array.from(serverCounts.entries())
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([url]) => ({ url }))
      : [{ url: "/" }];

  // Finalize canonical paths and sort deterministically
  const materializedPaths: Array<{
    path: string;
    group: PathGroupAccumulator;
  }> = Array.from(pathGroups.values())
    .map((group) => ({
      path: buildTemplateFromStructural(group.structuralKey, group.paramNames),
      group,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const paths: OpenApiDocument["paths"] = {};
  const usedOperationIds = new Set<string>();
  let operationsCount = 0;

  for (const { path, group } of materializedPaths) {
    const pathItem: Partial<Record<HttpMethodLower, OpenApiOperation>> = {};

    for (const method of OPENAPI_HTTP_METHOD_ORDER) {
      const opAcc = group.operations.get(method);
      if (!opAcc) continue;
      operationsCount += 1;

      const baseOpId = buildBaseOperationId(method, path);
      let operationId = baseOpId;
      let opSuffix = 2;
      while (usedOperationIds.has(operationId)) {
        operationId = `${baseOpId}_${opSuffix}`;
        opSuffix += 1;
      }
      usedOperationIds.add(operationId);

      // Parameters: path params in template order, then query params sorted alphabetically
      const parameters: OpenApiParameter[] = [];
      for (let i = 0; i < group.paramNames.length; i++) {
        const paramName = group.paramNames[i];
        const slot = opAcc.pathParams[i] ?? { schema: { type: "string" } };
        const param: OpenApiParameter = {
          name: paramName,
          in: "path",
          required: true,
          schema: stripNonSchemaProps(slot.schema),
        };
        if (includeExamples && slot.sampleValue !== undefined) {
          param.example = formatExampleForOutput(
            slot.sampleValue,
            redactSensitiveExamples
          );
        }
        parameters.push(param);
      }

      const sortedQueryNames = Array.from(opAcc.queryParams.keys()).sort();
      for (const qName of sortedQueryNames) {
        const qAcc = opAcc.queryParams.get(qName)!;
        const param: OpenApiParameter = {
          name: qAcc.name,
          in: "query",
          schema: stripNonSchemaProps(qAcc.schema),
        };
        if (includeExamples && qAcc.example !== undefined) {
          param.example = qAcc.example;
        }
        parameters.push(param);
      }

      // Request body
      let requestBody: OpenApiRequestBody | undefined;
      if (opAcc.requestMedia.size > 0) {
        const content: Record<string, OpenApiMediaType> = {};
        for (const mt of Array.from(opAcc.requestMedia.keys()).sort()) {
          const media = opAcc.requestMedia.get(mt)!;
          const entry: OpenApiMediaType = {
            schema: stripNonSchemaProps(media.schema),
          };
          if (includeExamples && media.example !== undefined) {
            entry.example = formatExampleForOutput(
              media.example,
              redactSensitiveExamples
            );
          }
          content[mt] = entry;
        }
        requestBody = {
          ...(opAcc.sessionsWithRequestBody === opAcc.requestSessionCount
            ? { required: true }
            : {}),
          content,
        };
      }

      // Responses
      const responses: Record<string, OpenApiResponse> = {};
      for (const statusKey of sortStatusKeys(opAcc.responses.keys())) {
        const rAcc = opAcc.responses.get(statusKey)!;
        const respObj: OpenApiResponse = {
          description: rAcc.description,
        };
        if (rAcc.media.size > 0) {
          const content: Record<string, OpenApiMediaType> = {};
          for (const mt of Array.from(rAcc.media.keys()).sort()) {
            const media = rAcc.media.get(mt)!;
            const entry: OpenApiMediaType = {
              schema: stripNonSchemaProps(media.schema),
            };
            if (includeExamples && media.example !== undefined) {
              entry.example = formatExampleForOutput(
                media.example,
                redactSensitiveExamples
              );
            }
            content[mt] = entry;
          }
          respObj.content = content;
        }
        responses[statusKey] = respObj;
      }

      // Dominant host for fallback tag
      const dominantHost =
        Array.from(opAcc.hosts.entries()).sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
        )[0]?.[0] ?? "default";

      const operation: OpenApiOperation = {
        ...(groupByTags
          ? { tags: [buildOperationTag(path, dominantHost)] }
          : {}),
        summary: `${method.toUpperCase()} ${path}`,
        operationId,
        ...(parameters.length > 0 ? { parameters } : {}),
        ...(requestBody ? { requestBody } : {}),
        responses,
        ...(opAcc.securitySchemes.size > 0
          ? {
              security: Array.from(opAcc.securitySchemes)
                .sort()
                .map((schemeId) => ({ [schemeId]: [] })),
            }
          : {}),
      };

      pathItem[method] = operation;
    }

    paths[path] = pathItem;
  }

  const securitySchemeNames = Array.from(securityRegistry.keys()).sort();
  const spec: OpenApiDocument = {
    openapi: "3.0.3",
    info: {
      title,
      version,
      ...(description ? { description } : {}),
    },
    servers,
    paths,
  };

  if (securitySchemeNames.length > 0) {
    const securitySchemes: Record<string, OpenApiSecurityScheme> = {};
    for (const key of securitySchemeNames) {
      securitySchemes[key] = securityRegistry.get(key)!;
    }
    spec.components = { securitySchemes };
  }

  const serialized =
    format === "json"
      ? `${JSON.stringify(spec, null, 2)}\n`
      : serializeOpenApiToYaml(spec);

  return {
    spec,
    serialized,
    stats: {
      totalSessionsInput: sessions.length,
      includedSessions,
      skippedSessions,
      serversCount: serverCounts.size,
      pathsCount: materializedPaths.length,
      operationsCount,
      securitySchemes: securitySchemeNames,
    },
  };
}

export function generateOpenApiSpec(
  sessions: SessionDetail[],
  options: OpenApiGeneratorOptions = {}
): string {
  return buildOpenApiDocument(sessions, options).serialized;
}

// ============================================================================
// Deterministic Compact YAML 1.2 Serializer (Zero External Dependencies)
// ============================================================================

const YAML_RESERVED_KEYWORD_RE =
  /^(?:true|false|yes|no|on|off|y|n|null|~|\.nan|[+-]?\.inf)$/i;
const YAML_NUMBER_DECIMAL_RE =
  /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const YAML_NUMBER_LEADING_DOT_RE = /^[+-]?\.\d+(?:[eE][+-]?\d+)?$/;
const YAML_NUMBER_BASE_RE = /^0[xXoObB][0-9a-fA-F_]+$/;
const YAML_CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;
const YAML_INDICATOR_START_RE = /^[-?:,\[\]{}#&*!|>'"%@`]/;

function needsYamlQuoting(str: string, isKey = false): boolean {
  if (str.length === 0) return true;
  if (/^\s|\s$/.test(str)) return true;
  if (YAML_CONTROL_CHAR_RE.test(str)) return true;
  if (YAML_RESERVED_KEYWORD_RE.test(str)) return true;
  if (
    YAML_NUMBER_DECIMAL_RE.test(str) ||
    YAML_NUMBER_LEADING_DOT_RE.test(str) ||
    YAML_NUMBER_BASE_RE.test(str)
  ) {
    return true;
  }
  if (YAML_INDICATOR_START_RE.test(str)) return true;
  if (str.includes(": ") || str.includes(" #") || str.endsWith(":")) {
    return true;
  }
  if (/[\[\]{},]/.test(str)) return true;
  if (isKey && /[:\s#]/.test(str)) return true;
  return false;
}

function formatYamlKey(key: string): string {
  return needsYamlQuoting(key, true) ? JSON.stringify(key) : key;
}

function formatYamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (typeof value === "string") {
    return needsYamlQuoting(value, false) ? JSON.stringify(value) : value;
  }
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function getDefinedObjectEntries(
  obj: Record<string, unknown>
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val !== undefined) {
      entries.push([key, val]);
    }
  }
  return entries;
}

function isInlineYamlValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return getDefinedObjectEntries(value).length === 0;
  return true;
}

function formatInlineYamlValue(value: unknown): string {
  if (Array.isArray(value) && value.length === 0) return "[]";
  if (isPlainObject(value) && getDefinedObjectEntries(value).length === 0) {
    return "{}";
  }
  return formatYamlScalar(value);
}

function serializeYamlLines(
  value: unknown,
  spaces: number,
  out: string[]
): void {
  const pad = " ".repeat(spaces);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${pad}[]`);
      return;
    }
    for (const item of value) {
      if (isInlineYamlValue(item)) {
        out.push(`${pad}- ${formatInlineYamlValue(item)}`);
      } else if (isPlainObject(item)) {
        const entries = getDefinedObjectEntries(item);
        const [firstKey, firstVal] = entries[0];
        if (isInlineYamlValue(firstVal)) {
          out.push(
            `${pad}- ${formatYamlKey(firstKey)}: ${formatInlineYamlValue(firstVal)}`
          );
        } else {
          out.push(`${pad}- ${formatYamlKey(firstKey)}:`);
          serializeYamlLines(firstVal, spaces + 4, out);
        }
        const restPad = " ".repeat(spaces + 2);
        for (let i = 1; i < entries.length; i++) {
          const [k, v] = entries[i];
          if (isInlineYamlValue(v)) {
            out.push(
              `${restPad}${formatYamlKey(k)}: ${formatInlineYamlValue(v)}`
            );
          } else {
            out.push(`${restPad}${formatYamlKey(k)}:`);
            serializeYamlLines(v, spaces + 4, out);
          }
        }
      } else {
        out.push(`${pad}-`);
        serializeYamlLines(item, spaces + 2, out);
      }
    }
    return;
  }

  if (isPlainObject(value)) {
    const entries = getDefinedObjectEntries(value);
    if (entries.length === 0) {
      out.push(`${pad}{}`);
      return;
    }
    for (const [k, v] of entries) {
      if (isInlineYamlValue(v)) {
        out.push(`${pad}${formatYamlKey(k)}: ${formatInlineYamlValue(v)}`);
      } else {
        out.push(`${pad}${formatYamlKey(k)}:`);
        serializeYamlLines(v, spaces + 2, out);
      }
    }
    return;
  }

  out.push(`${pad}${formatYamlScalar(value)}`);
}

export function serializeOpenApiToYaml(value: unknown): string {
  if (isInlineYamlValue(value)) {
    return `${formatInlineYamlValue(value)}\n`;
  }
  const lines: string[] = [];
  serializeYamlLines(value, 0, lines);
  return `${lines.join("\n")}\n`;
}
