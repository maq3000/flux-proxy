import type { CodecOperation, CodecTransformResult, HeaderPair } from "../types/proxy";

// ============================================================================
// UTF-8 Safe Base64 / Base64URL & Hex Utilities
// ============================================================================
export function bytesToBase64(bytes: Uint8Array, urlSafe = false): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const std = btoa(binary);
  if (!urlSafe) return std;
  return std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64ToBytes(raw: string): Uint8Array {
  const cleaned = raw.trim().replace(/\s+/g, "");
  if (!cleaned) return new Uint8Array(0);
  const normalized = cleaned.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLen);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function encodeBase64Text(input: string, urlSafe = false): string {
  const bytes = new TextEncoder().encode(input);
  return bytesToBase64(bytes, urlSafe);
}

export function decodeBase64Text(input: string): {
  text: string;
  byteLength: number;
  isUtf8: boolean;
} {
  const bytes = base64ToBytes(input);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, byteLength: bytes.length, isUtf8: true };
  } catch {
    return {
      text: bytesToHex(bytes, " "),
      byteLength: bytes.length,
      isUtf8: false,
    };
  }
}

export function bytesToHex(bytes: Uint8Array, separator = " "): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    parts.push(bytes[i].toString(16).padStart(2, "0").toUpperCase());
  }
  return parts.join(separator);
}

export function hexToBytes(input: string): Uint8Array {
  const cleaned = input
    .trim()
    .replace(/^0x/i, "")
    .replace(/[\s,:;-]+/g, "");
  if (!cleaned) return new Uint8Array(0);
  if (cleaned.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new Error("Некорректная Hex-строка (ожидается чётное число символов 0-9, A-F)");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function textToHex(input: string, separator = " "): string {
  return bytesToHex(new TextEncoder().encode(input), separator);
}

export function hexToText(input: string): {
  text: string;
  byteLength: number;
  isUtf8: boolean;
} {
  const bytes = hexToBytes(input);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, byteLength: bytes.length, isUtf8: true };
  } catch {
    const fallback = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { text: fallback, byteLength: bytes.length, isUtf8: false };
  }
}

// ============================================================================
// URL Encode / Decode & Query Breakdown
// ============================================================================
export function urlEncodeText(input: string, fullUri = false): string {
  return fullUri ? encodeURI(input) : encodeURIComponent(input);
}

export function urlDecodeText(input: string): {
  decoded: string;
  params: HeaderPair[];
} {
  const normalized = input.replace(/\+/g, "%20");
  const decoded = decodeURIComponent(normalized);
  const params: HeaderPair[] = [];
  const qSource = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input;
  if (qSource.includes("=")) {
    try {
      const sp = new URLSearchParams(qSource);
      sp.forEach((value, name) => {
        params.push({ name, value });
      });
    } catch {
      // ignore non-query strings
    }
  }
  return { decoded, params };
}

// ============================================================================
// Human-Readable Duration Formatting (Intl.DurationFormat with Baseline Fallback)
// ============================================================================
interface DurationIntlLike {
  DurationFormat?: new (
    locales?: string | string[],
    options?: { style?: "long" | "short" | "narrow" | "digital" }
  ) => {
    format(duration: {
      days?: number;
      hours?: number;
      minutes?: number;
      seconds?: number;
    }): string;
  };
}

export function formatSecondsSpan(totalSeconds: number, locale = "ru-RU"): string {
  const abs = Math.max(0, Math.floor(Math.abs(totalSeconds)));
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const seconds = abs % 60;

  const intlObj = Intl as unknown as DurationIntlLike;
  if (typeof intlObj.DurationFormat === "function") {
    try {
      const df = new intlObj.DurationFormat(locale, { style: "short" });
      if (days > 0) return df.format({ days, hours, minutes });
      if (hours > 0) return df.format({ hours, minutes, seconds });
      if (minutes > 0) return df.format({ minutes, seconds });
      return df.format({ seconds });
    } catch {
      // fall through to concise fallback
    }
  }

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}д`);
  if (hours > 0) parts.push(`${hours}ч`);
  if (minutes > 0) parts.push(`${minutes}м`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}с`);
  return parts.slice(0, 3).join(" ");
}

// ============================================================================
// JWT Inspector (Header, Claims, exp / nbf / iat Verification & Security Hints)
// ============================================================================
export type JwtValidityStatus =
  | "valid"
  | "expired"
  | "not_yet_valid"
  | "no_exp"
  | "invalid";

export interface JwtClaimAnnotation {
  key: string;
  label: string;
  rawValue: string;
  formattedValue: string;
  tone?: "ok" | "warn" | "error" | "info";
}

export interface JwtInspectionResult {
  validFormat: boolean;
  status: JwtValidityStatus;
  statusHeadline: string;
  statusDetail: string;
  algorithm: string;
  tokenType: string;
  keyId?: string;
  headerJson: string;
  claimsJson: string;
  headerObj: Record<string, unknown> | null;
  claimsObj: Record<string, unknown> | null;
  signatureBase64Url: string;
  signatureHex: string;
  signatureBytes: number;
  annotations: JwtClaimAnnotation[];
  warnings: string[];
  error?: string;
}

export function inspectJwt(
  rawInput: string,
  nowMs: number = Date.now()
): JwtInspectionResult {
  const stripped = rawInput
    .trim()
    .replace(/^Authorization:\s*/i, "")
    .replace(/^Bearer\s+/i, "")
    .trim();

  if (!stripped) {
    return emptyInvalidJwt("Вставьте JWT-токен (или заголовок Authorization: Bearer eyJ...)");
  }

  const parts = stripped.split(".");
  if (parts.length < 2 || parts.length > 3) {
    return emptyInvalidJwt(
      `Ожидается компактный JWS из 3 сегментов (header.payload.signature), получено сегментов: ${parts.length}`
    );
  }

  let headerObj: Record<string, unknown>;
  let claimsObj: Record<string, unknown>;
  try {
    const hdrBytes = base64ToBytes(parts[0]);
    headerObj = JSON.parse(new TextDecoder().decode(hdrBytes)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    return emptyInvalidJwt(
      `Не удалось декодировать JSON заголовка JWT (сегмент 1): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  try {
    const payloadBytes = base64ToBytes(parts[1]);
    claimsObj = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    return emptyInvalidJwt(
      `Не удалось декодировать JSON claims JWT (сегмент 2): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const sigSegment = parts[2] ?? "";
  let sigBytes: Uint8Array = new Uint8Array(0);
  try {
    sigBytes = sigSegment ? base64ToBytes(sigSegment) : new Uint8Array(0);
  } catch {
    sigBytes = new TextEncoder().encode(sigSegment);
  }

  const algorithm = String(headerObj.alg ?? "unknown");
  const tokenType = String(headerObj.typ ?? "JWT");
  const keyId =
    typeof headerObj.kid === "string" ? headerObj.kid : undefined;

  const nowSec = Math.floor(nowMs / 1000);
  const expSec = numericEpochSeconds(claimsObj.exp);
  const nbfSec = numericEpochSeconds(claimsObj.nbf);
  const iatSec = numericEpochSeconds(claimsObj.iat);

  const warnings: string[] = [];
  if (algorithm.toLowerCase() === "none" || !sigSegment) {
    warnings.push(
      "КРИТИЧНО: Алгоритм alg=\"none\" или отсутствует криптографическая подпись — токен не защищён от подделки."
    );
  }
  if (algorithm === "HS256") {
    warnings.push(
      "Симметричная подпись HMAC-SHA256 (HS256): убедитесь, что секрет имеет длину не менее 256 бит и не передаётся на клиент."
    );
  }

  let status: JwtValidityStatus = "no_exp";
  let statusHeadline = "Срок действия (exp) не указан";
  let statusDetail = "В токене отсутствует стандартное поле exp — токен бессрочный, если сервер не хранит сессию.";

  if (nbfSec !== null && nowSec < nbfSec) {
    const waitSpan = formatSecondsSpan(nbfSec - nowSec);
    status = "not_yet_valid";
    statusHeadline = `Ещё не активен (nbf через ${waitSpan})`;
    statusDetail = `Поле nbf (${new Date(nbfSec * 1000).toISOString()}) находится в будущем.`;
  } else if (expSec !== null) {
    const delta = expSec - nowSec;
    if (delta <= 0) {
      const ago = formatSecondsSpan(-delta);
      status = "expired";
      statusHeadline = `ТОКЕН ИСТЁК (${ago} назад)`;
      statusDetail = `exp = ${new Date(expSec * 1000).toISOString()} (${expSec})`;
      warnings.push(`Токен просрочен на ${ago} — апстрим должен вернуть 401 Unauthorized.`);
    } else {
      const rem = formatSecondsSpan(delta);
      status = "valid";
      statusHeadline = `АКТИВЕН (осталось ${rem})`;
      statusDetail = `Истекает ${new Date(expSec * 1000).toISOString()} (${expSec})`;
      if (iatSec !== null && expSec - iatSec > 30 * 86400) {
        warnings.push(
          `Длительный TTL access-токена (${formatSecondsSpan(expSec - iatSec)} > 30 дней).`
        );
      }
    }
  }

  const annotations: JwtClaimAnnotation[] = [];
  const pushClaim = (
    key: string,
    label: string,
    formatter?: (v: unknown) => { text: string; tone?: JwtClaimAnnotation["tone"] }
  ) => {
    if (!(key in claimsObj)) return;
    const raw = claimsObj[key];
    const rawStr =
      typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    const fmt = formatter ? formatter(raw) : { text: rawStr, tone: "info" as const };
    annotations.push({
      key,
      label,
      rawValue: rawStr,
      formattedValue: fmt.text,
      tone: fmt.tone,
    });
  };

  pushClaim("iss", "Issuer (iss)");
  pushClaim("sub", "Subject / User (sub)");
  pushClaim("aud", "Audience (aud)");
  pushClaim("scope", "OAuth Scopes");
  pushClaim("iat", "Issued At (iat)", (v) => {
    const s = numericEpochSeconds(v);
    if (s === null) return { text: String(v) };
    const diff = nowSec - s;
    const rel = diff >= 0 ? `${formatSecondsSpan(diff)} назад` : `через ${formatSecondsSpan(-diff)}`;
    return { text: `${new Date(s * 1000).toISOString()} (${rel})`, tone: "info" };
  });
  pushClaim("nbf", "Not Before (nbf)", (v) => {
    const s = numericEpochSeconds(v);
    if (s === null) return { text: String(v) };
    return {
      text: new Date(s * 1000).toISOString(),
      tone: nowSec < s ? "warn" : "ok",
    };
  });
  pushClaim("exp", "Expiration (exp)", (v) => {
    const s = numericEpochSeconds(v);
    if (s === null) return { text: String(v) };
    const rem = s - nowSec;
    return {
      text:
        rem > 0
          ? `${new Date(s * 1000).toISOString()} (осталось ${formatSecondsSpan(rem)})`
          : `${new Date(s * 1000).toISOString()} (истёк ${formatSecondsSpan(-rem)} назад)`,
      tone: rem > 0 ? "ok" : "error",
    };
  });
  pushClaim("jti", "JWT ID (jti)");

  return {
    validFormat: true,
    status,
    statusHeadline,
    statusDetail,
    algorithm,
    tokenType,
    keyId,
    headerJson: JSON.stringify(headerObj, null, 2),
    claimsJson: JSON.stringify(claimsObj, null, 2),
    headerObj,
    claimsObj,
    signatureBase64Url: sigSegment,
    signatureHex: bytesToHex(sigBytes, " "),
    signatureBytes: sigBytes.length,
    annotations,
    warnings,
  };
}

function numericEpochSeconds(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) {
    return val > 1e12 ? Math.floor(val / 1000) : Math.floor(val);
  }
  if (typeof val === "string" && /^\d+$/.test(val.trim())) {
    const parsed = Number(val.trim());
    if (Number.isFinite(parsed)) {
      return parsed > 1e12 ? Math.floor(parsed / 1000) : Math.floor(parsed);
    }
  }
  return null;
}

function emptyInvalidJwt(error: string): JwtInspectionResult {
  return {
    validFormat: false,
    status: "invalid",
    statusHeadline: "Невалидный формат JWT",
    statusDetail: error,
    algorithm: "—",
    tokenType: "—",
    headerJson: "",
    claimsJson: "",
    headerObj: null,
    claimsObj: null,
    signatureBase64Url: "",
    signatureHex: "",
    signatureBytes: 0,
    annotations: [],
    warnings: [],
    error,
  };
}

// ============================================================================
// Unix Timestamp <-> ISO 8601 Bi-directional Converter
// ============================================================================
export interface TimestampConversionResult {
  valid: boolean;
  detectedUnit: string;
  epochSeconds: number;
  epochMillis: number;
  isoUtc: string;
  isoLocal: string;
  httpRfc2822: string;
  relativeNow: string;
  error?: string;
}

export function convertTimestampInput(
  rawInput: string,
  nowMs: number = Date.now()
): TimestampConversionResult {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return invalidTs("Введите Unix Timestamp (сек / мс / мкс / нс) или дату ISO 8601 / HTTP GMT");
  }

  let ms: number;
  let detectedUnit: string;

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    const abs = Math.abs(num);
    if (abs >= 1e17) {
      ms = Math.round(num / 1e6);
      detectedUnit = "Unix Nanoseconds (19 цифр)";
    } else if (abs >= 1e14) {
      ms = Math.round(num / 1e3);
      detectedUnit = "Unix Microseconds (16 цифр)";
    } else if (abs >= 1e11) {
      ms = Math.round(num);
      detectedUnit = "Unix Milliseconds (13 цифр)";
    } else {
      ms = Math.round(num * 1000);
      detectedUnit = "Unix Seconds (10 цифр)";
    }
  } else {
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      return invalidTs(
        `Не удалось распознать дату или timestamp: «${trimmed}»`
      );
    }
    ms = parsed;
    detectedUnit = trimmed.includes("GMT")
      ? "HTTP-Date (RFC 9110 / RFC 2822)"
      : "ISO 8601 Date-Time";
  }

  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    return invalidTs("Значение выходит за допустимый диапазон дат ECMAScript");
  }

  const tzOffsetMin = -d.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? "+" : "-";
  const absOff = Math.abs(tzOffsetMin);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const isoLocal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate()
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
    d.getMilliseconds(),
    3
  )}${sign}${pad(Math.floor(absOff / 60))}:${pad(absOff % 60)}`;

  const deltaSec = Math.round((ms - nowMs) / 1000);
  const relativeNow =
    deltaSec === 0
      ? "Прямо сейчас (0с)"
      : deltaSec > 0
        ? `Через ${formatSecondsSpan(deltaSec)}`
        : `${formatSecondsSpan(-deltaSec)} назад`;

  return {
    valid: true,
    detectedUnit,
    epochSeconds: Math.floor(ms / 1000),
    epochMillis: ms,
    isoUtc: d.toISOString(),
    isoLocal,
    httpRfc2822: d.toUTCString(),
    relativeNow,
  };
}

function invalidTs(error: string): TimestampConversionResult {
  return {
    valid: false,
    detectedUnit: "—",
    epochSeconds: 0,
    epochMillis: 0,
    isoUtc: "",
    isoLocal: "",
    httpRfc2822: "",
    relativeNow: "",
    error,
  };
}

// ============================================================================
// Browser Preview Fallback for CompressionStream / DecompressionStream
// (Used only when running outside Tauri; Tauri invokes native Rust flate2 + brotli)
// ============================================================================
export async function browserPreviewCodecTransform(
  operation: CodecOperation,
  input: string,
  inputIsBase64 = false
): Promise<CodecTransformResult> {
  const isCompress =
    operation === "gzipCompress" ||
    operation === "brotliCompress" ||
    operation === "deflateCompress";

  const rawBytes = isCompress
    ? inputIsBase64
      ? decodeBase64OrHexBytes(input)
      : new TextEncoder().encode(input)
    : decodeBase64OrHexBytes(input);

  let outBytes: Uint8Array;

  if (operation === "gzipCompress") {
    outBytes = await runWebStreamCodec(rawBytes, "gzip", "compress");
  } else if (operation === "gzipDecompress") {
    outBytes = await runWebStreamCodec(rawBytes, "gzip", "decompress");
  } else if (operation === "deflateCompress") {
    outBytes = await runWebStreamCodec(rawBytes, "deflate", "compress");
  } else if (operation === "deflateDecompress") {
    try {
      outBytes = await runWebStreamCodec(rawBytes, "deflate", "decompress");
    } catch {
      outBytes = await runWebStreamCodec(rawBytes, "deflate-raw", "decompress");
    }
  } else if (operation === "brotliCompress") {
    outBytes = await brotliCompressFallback(rawBytes);
  } else {
    outBytes = await brotliDecompressFallback(rawBytes);
  }

  let outputText: string | null = null;
  try {
    outputText = new TextDecoder("utf-8", { fatal: true }).decode(outBytes);
  } catch {
    outputText = null;
  }

  return {
    outputBase64: bytesToBase64(outBytes, false),
    outputText,
    outputHex: bytesToHex(outBytes, ""),
    inputBytes: rawBytes.length,
    outputBytes: outBytes.length,
  };
}

function decodeBase64OrHexBytes(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (!trimmed) return new Uint8Array(0);
  const hexCandidate = trimmed.replace(/^0x/i, "").replace(/[\s:]+/g, "");
  if (
    hexCandidate.length >= 4 &&
    hexCandidate.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(hexCandidate) &&
    !trimmed.includes("=") &&
    !trimmed.includes("+") &&
    !trimmed.includes("/")
  ) {
    return hexToBytes(hexCandidate);
  }
  return base64ToBytes(trimmed);
}

async function runWebStreamCodec(
  input: Uint8Array,
  format: string,
  mode: "compress" | "decompress"
): Promise<Uint8Array> {
  const stream =
    mode === "compress"
      ? new CompressionStream(format as CompressionFormat)
      : new DecompressionStream(format as CompressionFormat);

  const writer = stream.writable.getWriter();
  const safeCopy = new Uint8Array(input.byteLength);
  safeCopy.set(input);
  void writer.write(safeCopy);
  void writer.close();

  const resp = new Response(stream.readable);
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

async function brotliCompressFallback(input: Uint8Array): Promise<Uint8Array> {
  for (const fmt of ["brotli", "br"]) {
    try {
      return await runWebStreamCodec(input, fmt, "compress");
    } catch {
      // try next or RFC 7932 uncompressed meta-block framing
    }
  }
  // Valid RFC 7932 Brotli stream using uncompressed meta-blocks (up to 64 KiB each)
  if (input.length === 0) {
    return new Uint8Array([0x06]);
  }
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let first = true;
  while (offset < input.length) {
    const slice = input.subarray(offset, Math.min(input.length, offset + 65536));
    offset += slice.length;
    const lenMinus1 = slice.length - 1;
    if (first) {
      first = false;
      // WBITS=16 (bit 0 = 0), ISLAST=0 (bit 1 = 0), MNIBBLES=00 (bits 2..3), MLEN-1 (bits 4..19), ISUNCOMPRESSED=1 (bit 20)
      const hdr = new Uint8Array([
        (lenMinus1 & 0x0f) << 4,
        (lenMinus1 >> 4) & 0xff,
        ((lenMinus1 >> 12) & 0x0f) | 0x10,
      ]);
      chunks.push(hdr, slice);
    } else {
      // Subsequent meta-block (no WBITS): ISLAST=0 (bit 0), MNIBBLES=00 (bits 1..2), MLEN-1 (bits 3..18), ISUNCOMPRESSED=1 (bit 19)
      const hdr = new Uint8Array([
        (lenMinus1 & 0x1f) << 3,
        (lenMinus1 >> 5) & 0xff,
        ((lenMinus1 >> 13) & 0x07) | 0x08,
      ]);
      chunks.push(hdr, slice);
    }
  }
  // Final empty last meta-block: ISLAST=1, ISLASTEMPTY=1 -> 0x03
  chunks.push(new Uint8Array([0x03]));
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

async function brotliDecompressFallback(input: Uint8Array): Promise<Uint8Array> {
  for (const fmt of ["brotli", "br"]) {
    try {
      return await runWebStreamCodec(input, fmt, "decompress");
    } catch {
      // check RFC 7932 uncompressed stream fallback below
    }
  }
  if (input.length === 1 && input[0] === 0x06) {
    return new Uint8Array(0);
  }
  // Decode RFC 7932 uncompressed meta-block streams in Browser Preview
  if (input.length >= 4 && (input[0] & 0x0f) === 0 && (input[2] & 0xf0) === 0x10) {
    const outParts: Uint8Array[] = [];
    let pos = 0;
    let first = true;
    while (pos < input.length) {
      if (!first && input[pos] === 0x03 && pos === input.length - 1) {
        break;
      }
      if (pos + 3 > input.length) break;
      let lenMinus1: number;
      if (first) {
        first = false;
        lenMinus1 =
          ((input[pos] >> 4) & 0x0f) |
          (input[pos + 1] << 4) |
          ((input[pos + 2] & 0x0f) << 12);
      } else {
        lenMinus1 =
          ((input[pos] >> 3) & 0x1f) |
          (input[pos + 1] << 5) |
          ((input[pos + 2] & 0x07) << 13);
      }
      const blockLen = lenMinus1 + 1;
      pos += 3;
      if (pos + blockLen > input.length) {
        throw new Error("Truncated Brotli meta-block");
      }
      outParts.push(input.subarray(pos, pos + blockLen));
      pos += blockLen;
    }
    const total = outParts.reduce((a, b) => a + b.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const p of outParts) {
      merged.set(p, offset);
      offset += p.length;
    }
    return merged;
  }
  throw new Error(
    "Словарный поток Brotli требует запуска в Tauri Rust runtime (`cargo tauri dev`), где подключён нативный крейт brotli."
  );
}

// ============================================================================
// Sample Demo Payloads for 1-Click Testing in TextWizard
// ============================================================================
export function createSampleJwtToken(expired = false): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = {
    alg: "ES256",
    typ: "JWT",
    kid: "fx-prod-ecdsa-2026-10",
  };
  const payload = {
    iss: "https://auth.fluxproxy.dev",
    sub: "usr_948102_denis",
    aud: ["https://api.fluxproxy.dev", "https://billing.fluxproxy.dev"],
    scope: "proxy:admin sessions:write rules:manage",
    roles: ["staff_engineer", "security_auditor"],
    iat: nowSec - 1800,
    nbf: nowSec - 1800,
    exp: expired ? nowSec - 1260 : nowSec + 2700,
    jti: "jwt_01JBDF9X82M4Q7K",
  };
  const h = encodeBase64Text(JSON.stringify(header), true);
  const p = encodeBase64Text(JSON.stringify(payload), true);
  const sig = bytesToBase64(
    new Uint8Array([
      0x30, 0x44, 0x02, 0x20, 0x7a, 0x91, 0xc4, 0x18, 0xe2, 0x55, 0x09, 0xbf,
      0x11, 0x8d, 0x4c, 0xa0, 0x63, 0xf2, 0x19, 0x77, 0x4e, 0xb8, 0x05, 0xd1,
      0x99, 0x3a, 0x2c, 0x81,
    ]),
    true
  );
  return `${h}.${p}.${sig}`;
}
