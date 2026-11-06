import type {
  HeaderPair,
  SessionDetail,
  SseEventRecord,
} from "../types/proxy";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  formatSecondsSpan,
  inspectJwt,
  type JwtInspectionResult,
} from "./textWizard";

// ============================================================================
// 1. Server-Sent Events (SSE / text/event-stream) Inspector & LLM Reconstructor
// ============================================================================
export interface EnrichedSseEvent extends SseEventRecord {
  deltaMs: number;
  isDoneSentinel: boolean;
  parsedJson: unknown | null;
  extractedToken: string;
}

export interface SseStreamAnalysis {
  isSse: boolean;
  events: EnrichedSseEvent[];
  reconstructedText: string;
  isLlmStream: boolean;
  totalBytes: number;
  totalDurationMs: number;
  eventTypeCounts: Record<string, number>;
}

export function isSseSession(detail: SessionDetail): boolean {
  const ct = detail.summary.contentType.toLowerCase();
  if (ct.includes("text/event-stream")) return true;
  if (detail.sseEvents && detail.sseEvents.length > 0) return true;
  const accept = detail.requestHeaders.find(
    (h) => h.name.toLowerCase() === "accept"
  )?.value;
  if (
    accept?.toLowerCase().includes("text/event-stream") &&
    detail.responseBodyText?.includes("data:")
  ) {
    return true;
  }
  return false;
}

export function parseSseStream(
  rawText: string | null | undefined,
  existingEvents?: SseEventRecord[]
): SseStreamAnalysis {
  let baseRecords: SseEventRecord[] = [];

  if (existingEvents && existingEvents.length > 0) {
    baseRecords = existingEvents;
  } else if (rawText && rawText.trim()) {
    baseRecords = parseRawEventStreamText(rawText);
  }

  let prevOffset = 0;
  let totalBytes = 0;
  let llmTokensDetected = 0;
  const tokenParts: string[] = [];
  const eventTypeCounts: Record<string, number> = {};

  const events: EnrichedSseEvent[] = baseRecords.map((ev, idx) => {
    const deltaMs = idx === 0 ? ev.offsetMs : Math.max(0, ev.offsetMs - prevOffset);
    prevOffset = ev.offsetMs;
    totalBytes += ev.byteLength;
    const evName = ev.event || "message";
    eventTypeCounts[evName] = (eventTypeCounts[evName] ?? 0) + 1;

    const trimmedData = ev.data.trim();
    const isDoneSentinel = trimmedData === "[DONE]";
    let parsedJson: unknown | null = null;
    let extractedToken = "";

    if (!isDoneSentinel && (trimmedData.startsWith("{") || trimmedData.startsWith("["))) {
      try {
        parsedJson = JSON.parse(trimmedData);
        extractedToken = extractStreamingLlmToken(parsedJson);
        if (extractedToken) {
          llmTokensDetected += 1;
          tokenParts.push(extractedToken);
        }
      } catch {
        parsedJson = null;
      }
    }

    return {
      ...ev,
      event: evName,
      deltaMs,
      isDoneSentinel,
      parsedJson,
      extractedToken,
    };
  });

  const isLlmStream = llmTokensDetected > 0;
  const reconstructedText = isLlmStream
    ? tokenParts.join("")
    : events
        .filter((e) => !e.isDoneSentinel && e.event !== "comment")
        .map((e) => e.data)
        .join("\n");

  const totalDurationMs =
    events.length > 0 ? events[events.length - 1].offsetMs : 0;

  return {
    isSse: events.length > 0,
    events,
    reconstructedText,
    isLlmStream,
    totalBytes,
    totalDurationMs,
    eventTypeCounts,
  };
}

function parseRawEventStreamText(rawText: string): SseEventRecord[] {
  const normalized = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n\n+/);
  const out: SseEventRecord[] = [];
  const nowIso = new Date().toISOString();
  const encoder = new TextEncoder();

  let index = 1;
  let syntheticOffsetMs = 0;

  for (const rawBlock of blocks) {
    if (!rawBlock.trim()) continue;
    let eventName = "message";
    let eventId: string | null = null;
    let retryVal: number | null = null;
    const dataLines: string[] = [];
    const commentLines: string[] = [];

    for (const line of rawBlock.split("\n")) {
      if (!line) continue;
      if (line.startsWith(":")) {
        commentLines.push(line.slice(1).trimStart());
        continue;
      }
      const colonIdx = line.indexOf(":");
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      let value = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") {
        eventName = value || "message";
      } else if (field === "data") {
        dataLines.push(value);
      } else if (field === "id") {
        eventId = value;
      } else if (field === "retry") {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isNaN(parsed)) retryVal = parsed;
      }
    }

    if (dataLines.length === 0 && commentLines.length > 0) {
      const commentBody = commentLines.join("\n");
      out.push({
        index: index++,
        id: eventId,
        event: "comment",
        data: commentBody,
        retry: retryVal,
        byteLength: encoder.encode(rawBlock).length,
        offsetMs: syntheticOffsetMs,
        timestamp: nowIso,
      });
      syntheticOffsetMs += 15;
      continue;
    }

    if (dataLines.length > 0 || eventId !== null || retryVal !== null) {
      out.push({
        index: index++,
        id: eventId,
        event: eventName,
        data: dataLines.join("\n"),
        retry: retryVal,
        byteLength: encoder.encode(rawBlock).length,
        offsetMs: syntheticOffsetMs,
        timestamp: nowIso,
      });
      syntheticOffsetMs += 38;
    }
  }

  return out;
}

function extractStreamingLlmToken(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const rec = obj as Record<string, unknown>;

  // OpenAI / vLLM / DeepSeek / OpenRouter chat.completion.chunk
  if (Array.isArray(rec.choices) && rec.choices.length > 0) {
    const first = rec.choices[0] as Record<string, unknown> | undefined;
    if (first && typeof first === "object") {
      const delta = first.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta === "object") {
        if (typeof delta.content === "string") return delta.content;
        if (typeof delta.reasoning_content === "string")
          return delta.reasoning_content;
      }
      if (typeof first.text === "string") return first.text;
    }
  }

  // Anthropic Messages API content_block_delta
  if (rec.delta && typeof rec.delta === "object") {
    const d = rec.delta as Record<string, unknown>;
    if (typeof d.text === "string") return d.text;
    if (typeof d.partial_json === "string") return d.partial_json;
  }

  // Google Gemini streamGenerateContent SSE
  if (Array.isArray(rec.candidates) && rec.candidates.length > 0) {
    const cand = rec.candidates[0] as Record<string, unknown> | undefined;
    const content = cand?.content as Record<string, unknown> | undefined;
    const parts = content?.parts;
    if (Array.isArray(parts)) {
      const texts = parts
        .map((p) =>
          p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string"
            ? ((p as Record<string, unknown>).text as string)
            : ""
        )
        .filter(Boolean);
      if (texts.length > 0) return texts.join("");
    }
  }

  // Ollama / generic token fields
  if (typeof rec.response === "string") return rec.response;
  if (typeof rec.token === "string") return rec.token;

  return "";
}

// ============================================================================
// 2. Multipart / Form-Data & URL-Encoded Form Inspector
// ============================================================================
export interface MultipartPartItem {
  index: number;
  name: string;
  filename?: string;
  contentType: string;
  headers: HeaderPair[];
  byteLength: number;
  isBinary: boolean;
  isFile: boolean;
  textPreview: string;
  hexPreview: string;
  imageDataUrl?: string;
}

export interface MultipartAnalysis {
  detected: boolean;
  kind: "multipart" | "urlencoded" | "none";
  boundary?: string;
  parts: MultipartPartItem[];
  totalBytes: number;
  error?: string;
}

export function hasMultipartOrFormPayload(
  headers: HeaderPair[],
  bodyBase64: string
): boolean {
  if (!bodyBase64) return false;
  const ct =
    headers
      .find((h) => h.name.toLowerCase() === "content-type")
      ?.value.toLowerCase() ?? "";
  return (
    ct.includes("multipart/") ||
    ct.includes("application/x-www-form-urlencoded")
  );
}

export function parseMultipartBody(
  headers: HeaderPair[],
  bodyBase64: string,
  bodyText?: string | null
): MultipartAnalysis {
  const rawCt =
    headers.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
  const ctLower = rawCt.toLowerCase();

  if (ctLower.includes("application/x-www-form-urlencoded")) {
    const src =
      bodyText ??
      new TextDecoder("utf-8", { fatal: false }).decode(base64ToBytes(bodyBase64));
    const params = new URLSearchParams(src);
    const parts: MultipartPartItem[] = [];
    let idx = 1;
    let totalBytes = 0;
    const enc = new TextEncoder();
    params.forEach((value, name) => {
      const valBytes = enc.encode(value);
      totalBytes += valBytes.length;
      parts.push({
        index: idx++,
        name,
        contentType: "text/plain (urlencoded)",
        headers: [],
        byteLength: valBytes.length,
        isBinary: false,
        isFile: false,
        textPreview: value,
        hexPreview: bytesToHex(valBytes.subarray(0, 48), " "),
      });
    });
    return {
      detected: parts.length > 0,
      kind: "urlencoded",
      parts,
      totalBytes,
    };
  }

  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(rawCt);
  const bytes = bodyBase64
    ? base64ToBytes(bodyBase64)
    : bodyText
      ? new TextEncoder().encode(bodyText)
      : new Uint8Array(0);

  let boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? "";

  // Auto-detect boundary from first `--...` line if Content-Type omitted/rewritten
  if (!boundary && bytes.length > 4 && bytes[0] === 0x2d && bytes[1] === 0x2d) {
    let lineEnd = 2;
    while (lineEnd < Math.min(bytes.length, 160) && bytes[lineEnd] !== 0x0d && bytes[lineEnd] !== 0x0a) {
      lineEnd++;
    }
    const candidate = new TextDecoder().decode(bytes.subarray(2, lineEnd)).trim();
    if (candidate.length >= 4) {
      boundary = candidate;
    }
  }

  if (!boundary) {
    return {
      detected: false,
      kind: "none",
      parts: [],
      totalBytes: bytes.length,
      error: "Тело не содержит multipart/form-data boundary или application/x-www-form-urlencoded полей.",
    };
  }

  const delimiterBytes = new TextEncoder().encode(`--${boundary}`);
  const positions = findAllByteSubsequences(bytes, delimiterBytes);
  if (positions.length === 0) {
    return {
      detected: false,
      kind: "multipart",
      boundary,
      parts: [],
      totalBytes: bytes.length,
      error: `Разделитель --${boundary} не найден в байтовом потоке тела (${bytes.length} B).`,
    };
  }

  const parts: MultipartPartItem[] = [];
  for (let p = 0; p < positions.length; p++) {
    let cursor = positions[p] + delimiterBytes.length;
    // Final `--boundary--` marker
    if (cursor + 1 < bytes.length && bytes[cursor] === 0x2d && bytes[cursor + 1] === 0x2d) {
      break;
    }
    // Skip CRLF or LF after boundary line
    if (bytes[cursor] === 0x0d && bytes[cursor + 1] === 0x0a) {
      cursor += 2;
    } else if (bytes[cursor] === 0x0a) {
      cursor += 1;
    }

    const nextBoundaryPos =
      p + 1 < positions.length ? positions[p + 1] : bytes.length;
    if (nextBoundaryPos <= cursor) continue;

    // Trim trailing CRLF or LF right before next `--boundary`
    let partEnd = nextBoundaryPos;
    if (
      partEnd >= cursor + 2 &&
      bytes[partEnd - 2] === 0x0d &&
      bytes[partEnd - 1] === 0x0a
    ) {
      partEnd -= 2;
    } else if (partEnd >= cursor + 1 && bytes[partEnd - 1] === 0x0a) {
      partEnd -= 1;
    }

    const partSlice = bytes.subarray(cursor, partEnd);
    const { headerBytes, contentBytes } = splitHeaderAndBodyBytes(partSlice);
    const partHeaders = parseMimeHeaderBlock(headerBytes);

    const disp =
      partHeaders.find((h) => h.name.toLowerCase() === "content-disposition")
        ?.value ?? "";
    const nameMatch = /\bname=(?:"([^"]*)"|([^;\s]+))/i.exec(disp);
    const fileStarMatch = /\bfilename\*=UTF-8''([^;\s]+)/i.exec(disp);
    const fileMatch = /\bfilename=(?:"([^"]*)"|([^;\s]+))/i.exec(disp);

    const fieldName =
      nameMatch?.[1] ?? nameMatch?.[2] ?? `part_${parts.length + 1}`;
    const filename = fileStarMatch?.[1]
      ? decodeURIComponentSafe(fileStarMatch[1])
      : fileMatch?.[1] ?? fileMatch?.[2];

    const declaredCt =
      partHeaders.find((h) => h.name.toLowerCase() === "content-type")?.value ??
      (filename ? "application/octet-stream" : "text/plain");
    const sniffedMime = sniffImageOrDocMime(contentBytes, declaredCt);

    let isBinary = false;
    let textPreview = "";
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        contentBytes.subarray(0, Math.min(contentBytes.length, 16384))
      );
      if (hasControlBinaryChars(decoded)) {
        isBinary = true;
      } else {
        textPreview = prettyIfJson(decoded);
      }
    } catch {
      isBinary = true;
    }

    let imageDataUrl: string | undefined;
    if (sniffedMime.startsWith("image/") && contentBytes.length > 0 && contentBytes.length <= 4 * 1024 * 1024) {
      imageDataUrl = `data:${sniffedMime.split(";")[0]};base64,${bytesToBase64(contentBytes, false)}`;
    }

    parts.push({
      index: parts.length + 1,
      name: fieldName,
      filename,
      contentType: sniffedMime,
      headers: partHeaders,
      byteLength: contentBytes.length,
      isBinary,
      isFile: Boolean(filename) || sniffedMime.startsWith("image/"),
      textPreview,
      hexPreview: bytesToHex(
        contentBytes.subarray(0, Math.min(contentBytes.length, 64)),
        " "
      ),
      imageDataUrl,
    });
  }

  return {
    detected: parts.length > 0,
    kind: "multipart",
    boundary,
    parts,
    totalBytes: bytes.length,
  };
}

function findAllByteSubsequences(
  haystack: Uint8Array,
  needle: Uint8Array
): number[] {
  const out: number[] = [];
  if (needle.length === 0 || haystack.length < needle.length) return out;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (haystack[i] !== needle[0]) continue;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    out.push(i);
    i += needle.length - 1;
  }
  return out;
}

function splitHeaderAndBodyBytes(part: Uint8Array): {
  headerBytes: Uint8Array;
  contentBytes: Uint8Array;
} {
  for (let i = 0; i + 3 < part.length; i++) {
    if (
      part[i] === 0x0d &&
      part[i + 1] === 0x0a &&
      part[i + 2] === 0x0d &&
      part[i + 3] === 0x0a
    ) {
      return {
        headerBytes: part.subarray(0, i),
        contentBytes: part.subarray(i + 4),
      };
    }
  }
  for (let i = 0; i + 1 < part.length; i++) {
    if (part[i] === 0x0a && part[i + 1] === 0x0a) {
      return {
        headerBytes: part.subarray(0, i),
        contentBytes: part.subarray(i + 2),
      };
    }
  }
  return { headerBytes: new Uint8Array(0), contentBytes: part };
}

function parseMimeHeaderBlock(headerBytes: Uint8Array): HeaderPair[] {
  if (headerBytes.length === 0) return [];
  const text = new TextDecoder("utf-8", { fatal: false }).decode(headerBytes);
  const out: HeaderPair[] = [];
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    out.push({
      name: line.slice(0, idx).trim(),
      value: line.slice(idx + 1).trim(),
    });
  }
  return out;
}

function sniffImageOrDocMime(bytes: Uint8Array, declared: string): string {
  const lower = declared.toLowerCase();
  if (lower && !lower.includes("octet-stream")) return declared;
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  const headAscii = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 96)))
    .trimStart();
  if (headAscii.startsWith("<svg") || headAscii.includes("<svg ")) {
    return "image/svg+xml";
  }
  return declared || "application/octet-stream";
}

function hasControlBinaryChars(s: string): boolean {
  for (let i = 0; i < Math.min(s.length, 512); i++) {
    const code = s.charCodeAt(i);
    if (code === 0 || (code < 9 && code !== 0) || (code > 13 && code < 32)) {
      return true;
    }
  }
  return false;
}

function prettyIfJson(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}

function decodeURIComponentSafe(val: string): string {
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

// ============================================================================
// 3. Protobuf & gRPC Wire-Format Decoder (Schema-less Recursive Wire Parser)
// ============================================================================
export interface ProtobufFieldNode {
  path: string;
  fieldNumber: number;
  wireType: number;
  wireTypeName: string;
  valueSummary: string;
  alternateInterpretations: string;
  byteOffset: number;
  byteLength: number;
  children?: ProtobufFieldNode[];
}

export interface GrpcFrameRecord {
  frameIndex: number;
  compressed: boolean;
  isTrailerFrame: boolean;
  declaredLength: number;
  fields: ProtobufFieldNode[];
  trailerText?: string;
}

export interface ProtobufGrpcAnalysis {
  detected: boolean;
  isGrpcEnvelope: boolean;
  grpcStatus?: {
    code: number;
    name: string;
    message?: string;
  };
  grpcEncoding?: string;
  totalBytes: number;
  frames: GrpcFrameRecord[];
  flattenedFields: ProtobufFieldNode[];
  jsonProjection: string;
  error?: string;
}

const GRPC_STATUS_NAMES: Record<number, string> = {
  0: "OK",
  1: "CANCELLED",
  2: "UNKNOWN",
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  6: "ALREADY_EXISTS",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  12: "UNIMPLEMENTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
  15: "DATA_LOSS",
  16: "UNAUTHENTICATED",
};

export function hasProtobufOrGrpcContentType(headers: HeaderPair[]): boolean {
  const ct =
    headers
      .find((h) => h.name.toLowerCase() === "content-type")
      ?.value.toLowerCase() ?? "";
  return (
    ct.includes("application/grpc") ||
    ct.includes("protobuf") ||
    ct.includes("application/x-proto") ||
    ct.includes("application/vnd.google.protobuf")
  );
}

export function decodeProtobufOrGrpc(
  headers: HeaderPair[],
  bodyBase64: string,
  forceDecode = false
): ProtobufGrpcAnalysis {
  const ct =
    headers
      .find((h) => h.name.toLowerCase() === "content-type")
      ?.value.toLowerCase() ?? "";
  const isGrpcCt = ct.includes("application/grpc");
  const isProtoCt = hasProtobufOrGrpcContentType(headers);

  const bytes = base64ToBytes(bodyBase64);
  const grpcStatusHdr = headers.find(
    (h) => h.name.toLowerCase() === "grpc-status"
  )?.value;
  const grpcMessageHdr = headers.find(
    (h) => h.name.toLowerCase() === "grpc-message"
  )?.value;
  const grpcEncoding = headers.find(
    (h) => h.name.toLowerCase() === "grpc-encoding"
  )?.value;

  const grpcStatus =
    grpcStatusHdr !== undefined
      ? {
          code: Number.parseInt(grpcStatusHdr, 10) || 0,
          name:
            GRPC_STATUS_NAMES[Number.parseInt(grpcStatusHdr, 10) || 0] ??
            "CUSTOM",
          message: grpcMessageHdr
            ? decodeURIComponentSafe(grpcMessageHdr)
            : undefined,
        }
      : undefined;

  if (bytes.length === 0) {
    return {
      detected: isProtoCt || grpcStatus !== undefined,
      isGrpcEnvelope: isGrpcCt,
      grpcStatus,
      grpcEncoding,
      totalBytes: 0,
      frames: [],
      flattenedFields: [],
      jsonProjection: "{}",
      error:
        grpcStatus !== undefined
          ? undefined
          : "Пустое тело сообщения (0 байт).",
    };
  }

  if (!isProtoCt && !forceDecode) {
    return {
      detected: false,
      isGrpcEnvelope: false,
      totalBytes: bytes.length,
      frames: [],
      flattenedFields: [],
      jsonProjection: "{}",
      error: `Content-Type (${ct || "не указан"}) не является application/grpc или protobuf.`,
    };
  }

  // Check if payload matches 5-byte gRPC Length-Prefixed-Message framing
  const grpcFrames = tryParseGrpcEnvelopeFrames(bytes, isGrpcCt);
  if (grpcFrames) {
    const flattenedFields: ProtobufFieldNode[] = [];
    const projectionObj: Record<string, unknown> = {};

    for (const frame of grpcFrames) {
      collectFlatFields(frame.fields, flattenedFields);
      projectionObj[`frame_${frame.frameIndex}`] = frame.isTrailerFrame
        ? { trailer: frame.trailerText }
        : fieldsToProjectionObject(frame.fields);
    }

    return {
      detected: true,
      isGrpcEnvelope: true,
      grpcStatus,
      grpcEncoding,
      totalBytes: bytes.length,
      frames: grpcFrames,
      flattenedFields,
      jsonProjection: JSON.stringify(
        grpcFrames.length === 1 && !grpcFrames[0].isTrailerFrame
          ? fieldsToProjectionObject(grpcFrames[0].fields)
          : projectionObj,
        null,
        2
      ),
    };
  }

  // Raw Protobuf message without 5-byte gRPC envelope
  const decoded = decodeProtobufMessageSlice(bytes, 0, "", 0);
  if (!decoded.ok || decoded.fields.length === 0) {
    return {
      detected: isProtoCt,
      isGrpcEnvelope: false,
      grpcStatus,
      grpcEncoding,
      totalBytes: bytes.length,
      frames: [],
      flattenedFields: [],
      jsonProjection: "{}",
      error:
        decoded.error ??
        "Не удалось разобрать байты как валидный бинарный Protobuf wire-поток.",
    };
  }

  const flattenedFields: ProtobufFieldNode[] = [];
  collectFlatFields(decoded.fields, flattenedFields);

  return {
    detected: true,
    isGrpcEnvelope: false,
    grpcStatus,
    grpcEncoding,
    totalBytes: bytes.length,
    frames: [
      {
        frameIndex: 1,
        compressed: false,
        isTrailerFrame: false,
        declaredLength: bytes.length,
        fields: decoded.fields,
      },
    ],
    flattenedFields,
    jsonProjection: JSON.stringify(
      fieldsToProjectionObject(decoded.fields),
      null,
      2
    ),
  };
}

function tryParseGrpcEnvelopeFrames(
  bytes: Uint8Array,
  declaredGrpc: boolean
): GrpcFrameRecord[] | null {
  if (bytes.length < 5) return null;
  const frames: GrpcFrameRecord[] = [];
  let cursor = 0;
  let frameIndex = 1;

  while (cursor < bytes.length) {
    if (cursor + 5 > bytes.length) return null;
    const flag = bytes[cursor];
    if (flag !== 0x00 && flag !== 0x01 && flag !== 0x80 && flag !== 0x81) {
      return null;
    }
    const msgLen =
      ((bytes[cursor + 1] << 24) >>> 0) +
      ((bytes[cursor + 2] << 16) >>> 0) +
      ((bytes[cursor + 3] << 8) >>> 0) +
      bytes[cursor + 4];

    if (cursor + 5 + msgLen > bytes.length) {
      return null;
    }

    const slice = bytes.subarray(cursor + 5, cursor + 5 + msgLen);
    const isTrailerFrame = (flag & 0x80) !== 0;
    const compressed = (flag & 0x01) !== 0;

    if (isTrailerFrame) {
      frames.push({
        frameIndex: frameIndex++,
        compressed,
        isTrailerFrame: true,
        declaredLength: msgLen,
        fields: [],
        trailerText: new TextDecoder("utf-8", { fatal: false }).decode(slice),
      });
    } else if (compressed) {
      frames.push({
        frameIndex: frameIndex++,
        compressed: true,
        isTrailerFrame: false,
        declaredLength: msgLen,
        fields: [
          {
            path: `frame[${frameIndex - 1}]`,
            fieldNumber: 0,
            wireType: 2,
            wireTypeName: "Compressed gRPC Payload",
            valueSummary: `${msgLen} B (compressed flag=1 — распакуйте через TextWizard Gzip/Brotli)`,
            alternateInterpretations: bytesToHex(
              slice.subarray(0, Math.min(slice.length, 32)),
              " "
            ),
            byteOffset: cursor + 5,
            byteLength: msgLen,
          },
        ],
      });
    } else {
      const parsed =
        msgLen === 0
          ? { ok: true, fields: [] as ProtobufFieldNode[] }
          : decodeProtobufMessageSlice(slice, cursor + 5, "", 0);
      if (!parsed.ok && !declaredGrpc) {
        return null;
      }
      frames.push({
        frameIndex: frameIndex++,
        compressed: false,
        isTrailerFrame: false,
        declaredLength: msgLen,
        fields: parsed.fields,
      });
    }

    cursor += 5 + msgLen;
  }

  return frames.length > 0 ? frames : null;
}

function decodeProtobufMessageSlice(
  bytes: Uint8Array,
  baseOffset: number,
  parentPath: string,
  depth: number
): { ok: boolean; fields: ProtobufFieldNode[]; error?: string } {
  if (depth > 6) {
    return { ok: false, fields: [], error: "Max nesting depth reached" };
  }

  const fields: ProtobufFieldNode[] = [];
  let pos = 0;

  while (pos < bytes.length) {
    const fieldStart = pos;
    const tagRes = readVarint(bytes, pos);
    if (!tagRes) {
      return {
        ok: false,
        fields,
        error: `Незавершённый varint тега на смещении +${baseOffset + pos}`,
      };
    }
    pos = tagRes.nextPos;
    const tag = tagRes.value;
    const wireType = Number(tag & 0x07n);
    const fieldNumber = Number(tag >> 3n);

    if (fieldNumber <= 0 || fieldNumber > 536_870_911) {
      return {
        ok: false,
        fields,
        error: `Некорректный номер поля Protobuf (${fieldNumber}) на смещении +${baseOffset + fieldStart}`,
      };
    }

    const path = parentPath ? `${parentPath}.${fieldNumber}` : `${fieldNumber}`;

    if (wireType === 0) {
      // Varint
      const valRes = readVarint(bytes, pos);
      if (!valRes) {
        return {
          ok: false,
          fields,
          error: `Обрезанный varint поля #${fieldNumber}`,
        };
      }
      pos = valRes.nextPos;
      const u = valRes.value;
      const signed64 = BigInt.asIntN(64, u);
      const zigZag = (u >> 1n) ^ -(u & 1n);
      const boolHint = u === 0n ? "false" : u === 1n ? "true" : null;

      fields.push({
        path,
        fieldNumber,
        wireType,
        wireTypeName: "Varint (0)",
        valueSummary: u.toString(),
        alternateInterpretations: [
          `int64: ${signed64.toString()}`,
          `sint64 (zigzag): ${zigZag.toString()}`,
          boolHint ? `bool: ${boolHint}` : null,
        ]
          .filter(Boolean)
          .join(" • "),
        byteOffset: baseOffset + fieldStart,
        byteLength: pos - fieldStart,
      });
    } else if (wireType === 1) {
      // 64-bit (I64)
      if (pos + 8 > bytes.length) {
        return { ok: false, fields, error: "Truncated fixed64 field" };
      }
      const dv = new DataView(bytes.buffer, bytes.byteOffset + pos, 8);
      const u64 = dv.getBigUint64(0, true);
      const i64 = dv.getBigInt64(0, true);
      const f64 = dv.getFloat64(0, true);
      pos += 8;

      fields.push({
        path,
        fieldNumber,
        wireType,
        wireTypeName: "64-bit / I64 (1)",
        valueSummary: Number.isFinite(f64) && Math.abs(f64) > 1e-9 && Math.abs(f64) < 1e15
          ? `${f64} (double)`
          : u64.toString(),
        alternateInterpretations: `fixed64: ${u64.toString()} • sfixed64: ${i64.toString()} • double: ${f64}`,
        byteOffset: baseOffset + fieldStart,
        byteLength: pos - fieldStart,
      });
    } else if (wireType === 2) {
      // Length-delimited (string, bytes, embedded message, packed repeated)
      const lenRes = readVarint(bytes, pos);
      if (!lenRes) {
        return { ok: false, fields, error: "Truncated length-delimited size" };
      }
      const len = Number(lenRes.value);
      const payloadStart = lenRes.nextPos;
      if (len < 0 || payloadStart + len > bytes.length) {
        return {
          ok: false,
          fields,
          error: `Поле #${fieldNumber} выходит за пределы буфера (${len} B)`,
        };
      }
      const subSlice = bytes.subarray(payloadStart, payloadStart + len);
      pos = payloadStart + len;

      const utf8Candidate = tryDecodePrintableUtf8(subSlice);
      const nestedCandidate =
        len >= 2 && (!utf8Candidate || looksMoreLikeSubmessage(subSlice, utf8Candidate))
          ? decodeProtobufMessageSlice(
              subSlice,
              baseOffset + payloadStart,
              path,
              depth + 1
            )
          : null;

      if (nestedCandidate && nestedCandidate.ok && nestedCandidate.fields.length > 0) {
        fields.push({
          path,
          fieldNumber,
          wireType,
          wireTypeName: "Embedded Message (2)",
          valueSummary: `{ ${nestedCandidate.fields.length} полей, ${len} B }`,
          alternateInterpretations: utf8Candidate
            ? `str: "${truncateStr(utf8Candidate, 48)}"`
            : `hex: ${bytesToHex(subSlice.subarray(0, Math.min(len, 16)), " ")}`,
          byteOffset: baseOffset + fieldStart,
          byteLength: pos - fieldStart,
          children: nestedCandidate.fields,
        });
      } else if (utf8Candidate !== null) {
        fields.push({
          path,
          fieldNumber,
          wireType,
          wireTypeName: "String / LEN (2)",
          valueSummary: `"${utf8Candidate}"`,
          alternateInterpretations: `${len} B UTF-8`,
          byteOffset: baseOffset + fieldStart,
          byteLength: pos - fieldStart,
        });
      } else {
        fields.push({
          path,
          fieldNumber,
          wireType,
          wireTypeName: "Bytes / LEN (2)",
          valueSummary: `0x${bytesToHex(subSlice.subarray(0, Math.min(len, 24)), "")}${len > 24 ? "…" : ""}`,
          alternateInterpretations: `${len} raw bytes`,
          byteOffset: baseOffset + fieldStart,
          byteLength: pos - fieldStart,
        });
      }
    } else if (wireType === 5) {
      // 32-bit (I32)
      if (pos + 4 > bytes.length) {
        return { ok: false, fields, error: "Truncated fixed32 field" };
      }
      const dv = new DataView(bytes.buffer, bytes.byteOffset + pos, 4);
      const u32 = dv.getUint32(0, true);
      const i32 = dv.getInt32(0, true);
      const f32 = dv.getFloat32(0, true);
      pos += 4;

      fields.push({
        path,
        fieldNumber,
        wireType,
        wireTypeName: "32-bit / I32 (5)",
        valueSummary: u32.toString(),
        alternateInterpretations: `sfixed32: ${i32} • float: ${Number(f32.toPrecision(6))}`,
        byteOffset: baseOffset + fieldStart,
        byteLength: pos - fieldStart,
      });
    } else {
      // Deprecated start/end group (3/4) or invalid wire type (6/7)
      return {
        ok: false,
        fields,
        error: `Неподдерживаемый wire_type=${wireType} на смещении +${baseOffset + fieldStart}`,
      };
    }
  }

  return { ok: true, fields };
}

function readVarint(
  bytes: Uint8Array,
  startPos: number
): { value: bigint; nextPos: number } | null {
  let result = 0n;
  let shift = 0n;
  let pos = startPos;
  while (pos < bytes.length && shift < 70n) {
    const b = bytes[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value: result, nextPos: pos };
    }
    shift += 7n;
  }
  return null;
}

function tryDecodePrintableUtf8(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return "";
  try {
    const str = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f) {
        return null;
      }
    }
    return str;
  } catch {
    return null;
  }
}

function looksMoreLikeSubmessage(bytes: Uint8Array, decodedStr: string): boolean {
  // If every char is standard printable text (letters, digits, spaces, punctuation), keep it as a String!
  if (/^[\p{L}\p{N}\s.,:;/_+\-@#$%&*()[\]{}'"!?=<>\\|~`^]+$/u.test(decodedStr)) {
    return false;
  }
  return bytes[0] > 0 && (bytes[0] & 0x07) <= 5 && (bytes[0] >> 3) <= 64;
}

function collectFlatFields(
  nodes: ProtobufFieldNode[],
  out: ProtobufFieldNode[]
): void {
  for (const n of nodes) {
    out.push(n);
    if (n.children) {
      collectFlatFields(n.children, out);
    }
  }
}

function fieldsToProjectionObject(
  nodes: ProtobufFieldNode[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const n of nodes) {
    const key = `field_${n.fieldNumber}`;
    const val: unknown = n.children
      ? fieldsToProjectionObject(n.children)
      : n.valueSummary.startsWith('"') && n.valueSummary.endsWith('"')
        ? n.valueSummary.slice(1, -1)
        : /^-?\d+$/.test(n.valueSummary)
          ? Number.isSafeInteger(Number(n.valueSummary))
            ? Number(n.valueSummary)
            : n.valueSummary
          : n.valueSummary;

    if (key in out) {
      const existing = out[key];
      if (Array.isArray(existing)) {
        existing.push(val);
      } else {
        out[key] = [existing, val];
      }
    } else {
      out[key] = val;
    }
  }
  return out;
}

function truncateStr(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

// ============================================================================
// 4. Auth Inspector (Bearer / JWT, Basic, Digest, AWS SigV4, API Keys, WWW-Authenticate)
// ============================================================================
export interface AuthCredentialEntry {
  source: "request-header" | "query-param" | "response-challenge" | "oauth-body";
  scheme: string;
  headerName: string;
  rawPreview: string;
  rawTokenForWizard?: string;
  summary: string;
  parameters: HeaderPair[];
  jwt?: JwtInspectionResult;
}

export interface AuthAnalysis {
  hasAuth: boolean;
  entries: AuthCredentialEntry[];
  securityFindings: { level: "ok" | "warn" | "error"; message: string }[];
}

const API_KEY_HEADER_NAMES = new Set([
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "x-Goog-api-key".toLowerCase(),
  "anthropic-api-key",
  "openai-organization",
]);

export function analyzeAuth(detail: SessionDetail): AuthAnalysis {
  const entries: AuthCredentialEntry[] = [];
  const securityFindings: { level: "ok" | "warn" | "error"; message: string }[] = [];
  const isCleartextHttp = detail.summary.scheme === "http";

  // 1. Inspect Authorization & Proxy-Authorization & API-Key request headers
  for (const h of detail.requestHeaders) {
    const lower = h.name.toLowerCase();
    if (lower === "authorization" || lower === "proxy-authorization") {
      const parsed = parseAuthorizationHeaderValue(h.name, h.value);
      entries.push(parsed);

      if (isCleartextHttp) {
        securityFindings.push({
          level: "error",
          message: `Учётные данные в заголовке ${h.name} передаются по незашифрованному HTTP (без TLS)!`,
        });
      }
      if (parsed.jwt) {
        if (parsed.jwt.status === "expired") {
          securityFindings.push({
            level: "error",
            message: `JWT в заголовке ${h.name} просрочен (${parsed.jwt.statusHeadline}).`,
          });
        } else if (parsed.jwt.status === "valid") {
          securityFindings.push({
            level: "ok",
            message: `Подпись JWT (${parsed.jwt.algorithm}): срок действия актуален — ${parsed.jwt.statusHeadline}.`,
          });
        }
        for (const w of parsed.jwt.warnings) {
          securityFindings.push({ level: "warn", message: w });
        }
      }
    } else if (API_KEY_HEADER_NAMES.has(lower)) {
      entries.push({
        source: "request-header",
        scheme: "API Key",
        headerName: h.name,
        rawPreview: maskSecretMiddle(h.value),
        rawTokenForWizard: h.value,
        summary: `Ключ API в заголовке ${h.name} (${h.value.length} симв.)`,
        parameters: [
          { name: "Header", value: h.name },
          { name: "Length", value: `${h.value.length} символов` },
          { name: "Value", value: h.value },
        ],
      });
      if (isCleartextHttp) {
        securityFindings.push({
          level: "error",
          message: `API-ключ (${h.name}) передаётся открытым текстом по HTTP.`,
        });
      }
    }
  }

  // 2. Check query string for leaked tokens / API keys
  try {
    const u = new URL(detail.summary.url);
    u.searchParams.forEach((value, key) => {
      if (/^(api[_-]?key|access[_-]?token|token|auth|jwt|secret|sig)$/i.test(key)) {
        const maybeJwt = value.split(".").length === 3 ? inspectJwt(value) : undefined;
        entries.push({
          source: "query-param",
          scheme: maybeJwt?.validFormat ? "Query JWT" : "Query Secret",
          headerName: `?${key}=`,
          rawPreview: maskSecretMiddle(value),
          rawTokenForWizard: value,
          summary: `Секрет в URL query-параметре «${key}»`,
          parameters: [
            { name: "Query Param", value: key },
            { name: "Value", value },
          ],
          jwt: maybeJwt?.validFormat ? maybeJwt : undefined,
        });
        securityFindings.push({
          level: "warn",
          message: `Токен/ключ «${key}» передаётся в URL-строке — он может осесть в access-логах прокси, CDN и Referer.`,
        });
      }
    });
  } catch {
    // ignore malformed URLs
  }

  // 3. Inspect WWW-Authenticate / Proxy-Authenticate response challenges
  for (const h of detail.responseHeaders) {
    const lower = h.name.toLowerCase();
    if (lower === "www-authenticate" || lower === "proxy-authenticate") {
      const challengeParams = parseAuthKeyValuePairs(h.value);
      const schemeWord = h.value.trim().split(/\s+/)[0] || "Challenge";
      entries.push({
        source: "response-challenge",
        scheme: `${schemeWord} Challenge`,
        headerName: h.name,
        rawPreview: h.value,
        summary: `Сервер запросил аутентификацию (${detail.summary.status})`,
        parameters:
          challengeParams.length > 0
            ? challengeParams
            : [{ name: "Challenge", value: h.value }],
      });
    }
  }

  // 4. Inspect OAuth2 / OIDC JSON token responses
  if (
    detail.responseBodyText &&
    detail.summary.contentType.toLowerCase().includes("json") &&
    (detail.responseBodyText.includes("access_token") ||
      detail.responseBodyText.includes("id_token") ||
      detail.responseBodyText.includes("invalid_grant"))
  ) {
    try {
      const parsed = JSON.parse(detail.responseBodyText) as Record<
        string,
        unknown
      >;
      if (typeof parsed.access_token === "string") {
        const tok = parsed.access_token;
        const jwtCandidate =
          tok.split(".").length === 3 ? inspectJwt(tok) : undefined;
        const params: HeaderPair[] = [
          { name: "token_type", value: String(parsed.token_type ?? "Bearer") },
        ];
        if (parsed.expires_in !== undefined) {
          params.push({
            name: "expires_in",
            value: `${parsed.expires_in} сек (${formatSecondsSpan(Number(parsed.expires_in) || 0)})`,
          });
        }
        if (typeof parsed.scope === "string") {
          params.push({ name: "scope", value: parsed.scope });
        }
        params.push({ name: "access_token", value: tok });

        entries.push({
          source: "oauth-body",
          scheme: "OAuth 2.0 Token Response",
          headerName: "JSON Body (access_token)",
          rawPreview: maskSecretMiddle(tok),
          rawTokenForWizard: tok,
          summary: jwtCandidate?.validFormat
            ? `Выдан JWT access_token (${jwtCandidate.algorithm})`
            : "Выдан OAuth 2.0 access_token в теле ответа",
          parameters: params,
          jwt: jwtCandidate?.validFormat ? jwtCandidate : undefined,
        });
      } else if (typeof parsed.error === "string") {
        entries.push({
          source: "oauth-body",
          scheme: "OAuth 2.0 Error",
          headerName: "JSON Body (error)",
          rawPreview: parsed.error,
          summary: String(parsed.error_description ?? parsed.error),
          parameters: [
            { name: "error", value: parsed.error },
            ...(typeof parsed.error_description === "string"
              ? [{ name: "error_description", value: parsed.error_description }]
              : []),
          ],
        });
        securityFindings.push({
          level: "error",
          message: `Ошибка OAuth 2.0: ${parsed.error} — ${String(parsed.error_description ?? "")}`,
        });
      }
    } catch {
      // ignore non-object JSON
    }
  }

  if (entries.length > 0 && !isCleartextHttp && securityFindings.length === 0) {
    securityFindings.push({
      level: "ok",
      message: "Транспорт защищён TLS; явных утечек секретов не обнаружено.",
    });
  }

  return {
    hasAuth: entries.length > 0,
    entries,
    securityFindings,
  };
}

function parseAuthorizationHeaderValue(
  headerName: string,
  rawValue: string
): AuthCredentialEntry {
  const trimmed = rawValue.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const scheme = spaceIdx === -1 ? "Token" : trimmed.slice(0, spaceIdx);
  const credential = spaceIdx === -1 ? trimmed : trimmed.slice(spaceIdx + 1).trim();
  const schemeLower = scheme.toLowerCase();

  if (schemeLower === "bearer") {
    const jwt = credential.split(".").length === 3 ? inspectJwt(credential) : undefined;
    if (jwt && jwt.validFormat) {
      return {
        source: "request-header",
        scheme: `Bearer (JWT • ${jwt.algorithm})`,
        headerName,
        rawPreview: maskSecretMiddle(credential),
        rawTokenForWizard: credential,
        summary: jwt.statusHeadline,
        parameters: jwt.annotations.map((a) => ({
          name: a.label,
          value: a.formattedValue,
        })),
        jwt,
      };
    }
    return {
      source: "request-header",
      scheme: "Bearer (Opaque Token)",
      headerName,
      rawPreview: maskSecretMiddle(credential),
      rawTokenForWizard: credential,
      summary: `Непрозрачный Bearer-токен (${credential.length} символов)`,
      parameters: [
        { name: "Scheme", value: "Bearer" },
        { name: "Length", value: `${credential.length} символов` },
        { name: "Token", value: credential },
      ],
    };
  }

  if (schemeLower === "basic") {
    let username = "";
    let password = "";
    let decodedNote = "Не удалось декодировать Base64";
    try {
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(
        base64ToBytes(credential)
      );
      const colonIdx = decoded.indexOf(":");
      username = colonIdx === -1 ? decoded : decoded.slice(0, colonIdx);
      password = colonIdx === -1 ? "" : decoded.slice(colonIdx + 1);
      decodedNote = `Пользователь «${username}» (RFC 7617 Basic Auth)`;
    } catch {
      // keep fallback note
    }
    return {
      source: "request-header",
      scheme: "Basic",
      headerName,
      rawPreview: credential,
      rawTokenForWizard: credential,
      summary: decodedNote,
      parameters: [
        { name: "Username", value: username || "—" },
        { name: "Password", value: password || "(пусто)" },
        { name: "Base64", value: credential },
      ],
    };
  }

  if (schemeLower === "digest" || schemeLower.startsWith("aws4-hmac")) {
    const kv = parseAuthKeyValuePairs(credential);
    return {
      source: "request-header",
      scheme,
      headerName,
      rawPreview: truncateStr(credential, 72),
      rawTokenForWizard: trimmed,
      summary: `${scheme} (${kv.length} параметров подписи)`,
      parameters: kv,
    };
  }

  return {
    source: "request-header",
    scheme,
    headerName,
    rawPreview: maskSecretMiddle(trimmed),
    rawTokenForWizard: trimmed,
    summary: `Схема авторизации ${scheme}`,
    parameters: [{ name: headerName, value: trimmed }],
  };
}

function parseAuthKeyValuePairs(raw: string): HeaderPair[] {
  const out: HeaderPair[] = [];
  const regex = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    out.push({
      name: match[1],
      value: match[2] ?? match[3] ?? "",
    });
  }
  return out;
}

function maskSecretMiddle(secret: string): string {
  if (secret.length <= 20) return secret;
  return `${secret.slice(0, 12)}…${secret.slice(-8)}`;
}

// ============================================================================
// 5. HTTP Caching Inspector (RFC 9111 Human-Readable Verdict & Explanations)
// ============================================================================
export type CacheVerdictKind =
  | "conditional-hit"
  | "cacheable-fresh"
  | "cacheable-revalidate"
  | "non-cacheable";

export interface CachingDirectiveNote {
  source: "Request" | "Response";
  directive: string;
  explanation: string;
  tone: "ok" | "warn" | "error" | "info";
}

export interface CachingAnalysis {
  hasCacheSignals: boolean;
  verdict: CacheVerdictKind;
  verdictHeadline: string;
  verdictSummary: string;
  reasons: string[];
  directives: CachingDirectiveNote[];
  validators: {
    etag?: string;
    etagKind?: "Strong" | "Weak";
    lastModified?: string;
    ifNoneMatch?: string;
    ifModifiedSince?: string;
    vary?: string;
    cdnCacheStatus?: string;
  };
  freshness: {
    maxAgeSec: number | null;
    sMaxAgeSec: number | null;
    ageSec: number | null;
    remainingSec: number | null;
    expiresRaw?: string;
    sharedCacheAllowed: boolean;
  };
}

const CACHEABLE_BY_DEFAULT_STATUSES = new Set([
  200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501,
]);

export function analyzeCaching(detail: SessionDetail): CachingAnalysis {
  const { summary, requestHeaders, responseHeaders } = detail;
  const method = summary.method.toUpperCase();
  const status = summary.status;

  const findReq = (name: string) =>
    requestHeaders.find((h) => h.name.toLowerCase() === name.toLowerCase())
      ?.value;
  const findResp = (name: string) =>
    responseHeaders.find((h) => h.name.toLowerCase() === name.toLowerCase())
      ?.value;

  const reqCcRaw = findReq("cache-control") ?? "";
  const reqPragma = findReq("pragma") ?? "";
  const ifNoneMatch = findReq("if-none-match");
  const ifModifiedSince = findReq("if-modified-since");
  const hasAuthHeader = Boolean(findReq("authorization"));

  const respCcRaw = findResp("cache-control") ?? "";
  const respPragma = findResp("pragma") ?? "";
  const etag = findResp("etag");
  const lastModified = findResp("last-modified");
  const expiresRaw = findResp("expires");
  const dateRaw = findResp("date");
  const ageRaw = findResp("age");
  const vary = findResp("vary");
  const cdnCacheStatus =
    findResp("cf-cache-status") ??
    findResp("x-cache") ??
    findResp("x-vercel-cache");

  const reqDirectives = parseCacheControlMap(reqCcRaw);
  const respDirectives = parseCacheControlMap(respCcRaw);

  const directives: CachingDirectiveNote[] = [];
  const reasons: string[] = [];

  for (const [k, v] of reqDirectives.entries()) {
    directives.push(describeDirective("Request", k, v));
  }
  if (!reqCcRaw && reqPragma.toLowerCase().includes("no-cache")) {
    directives.push({
      source: "Request",
      directive: `Pragma: ${reqPragma}`,
      explanation: "Устаревший HTTP/1.0 заголовок принудительной ревалидации запроса.",
      tone: "warn",
    });
  }
  for (const [k, v] of respDirectives.entries()) {
    directives.push(describeDirective("Response", k, v));
  }
  if (!respCcRaw && respPragma.toLowerCase().includes("no-cache")) {
    directives.push({
      source: "Response",
      directive: `Pragma: ${respPragma}`,
      explanation: "Устаревший HTTP/1.0 сигнал ревалидации.",
      tone: "warn",
    });
  }

  const maxAgeSec = parseDirectiveSeconds(respDirectives.get("max-age"));
  const sMaxAgeSec = parseDirectiveSeconds(respDirectives.get("s-maxage"));
  const ageSec =
    ageRaw !== undefined && /^\d+$/.test(ageRaw.trim())
      ? Number.parseInt(ageRaw.trim(), 10)
      : null;

  let expiresLifetimeSec: number | null = null;
  if (expiresRaw) {
    const expMs = Date.parse(expiresRaw);
    const baseMs = dateRaw ? Date.parse(dateRaw) : Date.now();
    if (!Number.isNaN(expMs) && !Number.isNaN(baseMs)) {
      expiresLifetimeSec = Math.floor((expMs - baseMs) / 1000);
    } else if (expiresRaw.trim() === "0" || expiresRaw.trim() === "-1") {
      expiresLifetimeSec = 0;
    }
  }

  const effectiveLifetimeSec = maxAgeSec ?? sMaxAgeSec ?? expiresLifetimeSec;
  const remainingSec =
    effectiveLifetimeSec !== null
      ? effectiveLifetimeSec - (ageSec ?? 0)
      : null;

  const hasNoStore =
    respDirectives.has("no-store") || reqDirectives.has("no-store");
  const hasNoCache = respDirectives.has("no-cache");
  const isPrivate = respDirectives.has("private");
  const isPublic = respDirectives.has("public");

  const sharedCacheAllowed =
    !hasNoStore &&
    !isPrivate &&
    (!hasAuthHeader ||
      isPublic ||
      sMaxAgeSec !== null ||
      respDirectives.has("must-revalidate"));

  let verdict: CacheVerdictKind;
  let verdictHeadline: string;
  let verdictSummary: string;

  // Step-by-step RFC 9111 decision tree
  if (status === 304) {
    verdict = "conditional-hit";
    verdictHeadline = "304 Not Modified — Использована копия из кэша";
    verdictSummary =
      "Клиент отправил условный запрос ревалидации, и сервер подтвердил актуальность локального кэша без повторной передачи тела (0 байт по сети).";
    if (ifNoneMatch) {
      reasons.push(`Клиент проверил валидатор If-None-Match: ${ifNoneMatch}.`);
    }
    if (ifModifiedSince) {
      reasons.push(`Клиент проверил дату If-Modified-Since: ${ifModifiedSince}.`);
    }
  } else if (method !== "GET" && method !== "HEAD") {
    verdict = "non-cacheable";
    verdictHeadline = `Не кэшируется (метод ${method})`;
    verdictSummary = `По RFC 9111 стандартные HTTP-кэши сохраняют ответы только на безопасные методы GET и HEAD (текущий метод: ${method}).`;
    reasons.push(`HTTP-метод ${method} изменяет состояние или не кэшируется по умолчанию.`);
  } else if (hasNoStore) {
    verdict = "non-cacheable";
    verdictHeadline = "Запрещено к сохранению (Cache-Control: no-store)";
    verdictSummary =
      "Директива no-store строго запрещает браузерам и CDN записывать ответ на диск или в память.";
    reasons.push(
      respDirectives.has("no-store")
        ? "Сервер вернул Cache-Control: no-store."
        : "Клиент отправил Cache-Control: no-store."
    );
  } else if (vary?.trim() === "*") {
    verdict = "non-cacheable";
    verdictHeadline = "Не кэшируется (Vary: *)";
    verdictSummary =
      "Заголовок Vary: * означает, что ответ зависит от неперечислимых факторов и не может переиспользоваться из кэша.";
    reasons.push("Vary: * блокирует повторное использование кэша.");
  } else if (hasNoCache || maxAgeSec === 0) {
    verdict = etag || lastModified ? "cacheable-revalidate" : "non-cacheable";
    verdictHeadline =
      etag || lastModified
        ? "Кэшируется с обязательной ревалидацией (0с TTL)"
        : "Не кэшируется (TTL = 0 и нет ETag / Last-Modified)";
    verdictSummary =
      etag || lastModified
        ? "Ответ можно сохранить в кэше, но перед каждым использованием браузер обязан сделать условный запрос (If-None-Match / If-Modified-Since) и получить 304."
        : "Директива no-cache / max-age=0 требует проверки на сервере, однако сервер не передал ни ETag, ни Last-Modified.";
    if (hasNoCache) reasons.push("Cache-Control: no-cache требует ревалидации перед выдачей.");
    if (maxAgeSec === 0) reasons.push("max-age=0 помечает ответ устаревшим сразу после получения.");
    if (etag) reasons.push(`Присутствует валидатор ETag (${etag}) для дешёвых 304-проверок.`);
  } else if (effectiveLifetimeSec !== null && effectiveLifetimeSec > 0) {
    verdict = "cacheable-fresh";
    const ttlHuman = formatSecondsSpan(effectiveLifetimeSec);
    verdictHeadline = `Кэшируется (${isPrivate ? "только браузер" : "браузер + CDN"} • TTL ${ttlHuman})`;
    verdictSummary =
      remainingSec !== null && remainingSec <= 0
        ? `Базовый TTL (${ttlHuman}) уже истёк с учётом Age=${ageSec ?? 0}с — следующий запрос вызовет ревалидацию.`
        : `Ресурс считается свежим в течение ${ttlHuman}${respDirectives.has("immutable") ? " и помечен как immutable (не перезапрашивается при перезагрузке вкладки)" : ""}.`;
    if (maxAgeSec !== null) {
      reasons.push(`Явный срок свежести max-age=${maxAgeSec} (${formatSecondsSpan(maxAgeSec)}).`);
    }
    if (sMaxAgeSec !== null) {
      reasons.push(`Для общих CDN/прокси задан s-maxage=${sMaxAgeSec} (${formatSecondsSpan(sMaxAgeSec)}).`);
    }
    if (maxAgeSec === null && expiresRaw) {
      reasons.push(`Свежесть вычислена по заголовку Expires (${expiresRaw}).`);
    }
  } else if ((etag || lastModified) && CACHEABLE_BY_DEFAULT_STATUSES.has(status)) {
    verdict = "cacheable-revalidate";
    verdictHeadline = "Эвристическое кэширование / условная ревалидация";
    verdictSummary =
      "Явный max-age не задан, но статус ответа допускает эвристическое кэширование браузером и последующую проверку через ETag / Last-Modified.";
    reasons.push("Отсутствует явный Cache-Control: max-age, но имеются валидаторы кэша.");
    if (etag) reasons.push(`ETag: ${etag}`);
    if (lastModified) reasons.push(`Last-Modified: ${lastModified}`);
  } else if (!CACHEABLE_BY_DEFAULT_STATUSES.has(status)) {
    verdict = "non-cacheable";
    verdictHeadline = `Не кэшируется (HTTP ${status} без явного TTL)`;
    verdictSummary = `Ответы со статусом ${status} не кэшируются по умолчанию без явных директив max-age / public.`;
    reasons.push(`Код ответа ${status} не входит в список кэшируемых по умолчанию (RFC 9111 §3).`);
  } else {
    verdict = "non-cacheable";
    verdictHeadline = "Заголовки кэширования отсутствуют";
    verdictSummary =
      "Сервер не передал Cache-Control, Expires, ETag или Last-Modified — повторные запросы будут загружать ресурс заново.";
    reasons.push("Нет явных директив свежести (Cache-Control / Expires) и валидаторов (ETag / Last-Modified).");
  }

  if (hasAuthHeader) {
    reasons.push(
      sharedCacheAllowed
        ? "Присутствует заголовок Authorization, но ответ явно разрешён для общих кэшей (public / s-maxage / must-revalidate)."
        : "Запрос содержит Authorization — общие CDN/прокси-кэши не сохраняют ответ (только приватный кэш браузера)."
    );
  }
  if (vary && vary.trim() !== "*") {
    reasons.push(
      `Ключ кэширования разделяется по заголовкам Vary: ${vary} (разные значения создают отдельные записи в кэше).`
    );
  }

  const hasCacheSignals = Boolean(
    reqCcRaw ||
      respCcRaw ||
      etag ||
      lastModified ||
      expiresRaw ||
      ifNoneMatch ||
      ifModifiedSince ||
      vary ||
      status === 304
  );

  return {
    hasCacheSignals,
    verdict,
    verdictHeadline,
    verdictSummary,
    reasons,
    directives,
    validators: {
      etag,
      etagKind: etag
        ? etag.trim().startsWith("W/")
          ? "Weak"
          : "Strong"
        : undefined,
      lastModified,
      ifNoneMatch,
      ifModifiedSince,
      vary,
      cdnCacheStatus,
    },
    freshness: {
      maxAgeSec,
      sMaxAgeSec,
      ageSec,
      remainingSec,
      expiresRaw,
      sharedCacheAllowed,
    },
  };
}

function parseCacheControlMap(raw: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!raw.trim()) return out;
  const regex = /([a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|([^,\s]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const key = match[1].toLowerCase();
    const val = match[2] ?? match[3] ?? null;
    out.set(key, val);
  }
  return out;
}

function parseDirectiveSeconds(val: string | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  if (!/^\d+$/.test(val.trim())) return null;
  return Number.parseInt(val.trim(), 10);
}

function describeDirective(
  source: "Request" | "Response",
  key: string,
  val: string | null
): CachingDirectiveNote {
  const formatted = val !== null ? `${key}=${val}` : key;
  switch (key) {
    case "no-store":
      return {
        source,
        directive: formatted,
        explanation: "Полный запрет записи запроса/ответа в любой кэш (браузер и CDN).",
        tone: "error",
      };
    case "no-cache":
      return {
        source,
        directive: formatted,
        explanation:
          "Разрешает хранение, но запрещает отдавать из кэша без предварительной проверки (304) на источнике.",
        tone: "warn",
      };
    case "private":
      return {
        source,
        directive: formatted,
        explanation:
          "Кэшировать разрешено только конечному браузеру пользователя; общим CDN/прокси запрещено.",
        tone: "info",
      };
    case "public":
      return {
        source,
        directive: formatted,
        explanation:
          "Ответ разрешено сохранять в общих кэшах (CDN, reverse-proxy) даже при наличии Authorization.",
        tone: "ok",
      };
    case "max-age": {
      const s = parseDirectiveSeconds(val);
      return {
        source,
        directive: formatted,
        explanation:
          s !== null
            ? s === 0
              ? "Ответ устаревает мгновенно (0 сек) — требуется ревалидация."
              : `Ресурс остаётся свежим ${formatSecondsSpan(s)} (${s} сек).`
            : "Время свежести в секундах.",
        tone: s && s > 0 ? "ok" : "warn",
      };
    }
    case "s-maxage": {
      const s = parseDirectiveSeconds(val);
      return {
        source,
        directive: formatted,
        explanation:
          s !== null
            ? `Переопределяет TTL специально для общих CDN/прокси: ${formatSecondsSpan(s)}.`
            : "TTL для общих кэшей.",
        tone: "ok",
      };
    }
    case "immutable":
      return {
        source,
        directive: formatted,
        explanation:
          "Контент по этому URL никогда не изменится (versioned asset) — браузер не шлёт 304 даже при Reload.",
        tone: "ok",
      };
    case "must-revalidate":
      return {
        source,
        directive: formatted,
        explanation:
          "После истечения max-age запрещено отдавать протухшую (stale) копию без успешной проверки на сервере.",
        tone: "info",
      };
    case "stale-while-revalidate": {
      const s = parseDirectiveSeconds(val);
      return {
        source,
        directive: formatted,
        explanation:
          s !== null
            ? `Позволяет мгновенно отдать слегка устаревший ответ и фоново обновить кэш в окне ${formatSecondsSpan(s)}.`
            : "Фоновое обновление кэша.",
        tone: "ok",
      };
    }
    default:
      return {
        source,
        directive: formatted,
        explanation: "Директива управления HTTP-кэшированием.",
        tone: "info",
      };
  }
}
