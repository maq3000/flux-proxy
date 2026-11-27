/**
 * WebView2 / Monaco memory ceiling helpers (`VER-03`).
 *
 * 1. Fixed virtual model URIs prevent `@monaco-editor/react` from allocating a fresh
 *    `ITextModel` on every selected session (`↑`/`↓` navigation or diff switch).
 * 2. Hard 2 MiB byte ceiling blocks WebView2/Monaco tokenization & DOM spikes on
 *    massive bodies, offering HexViewer / save-to-disk fallback instead.
 */

export const MAX_MONACO_RENDER_BYTES = 2 * 1024 * 1024;

export const MONACO_MODEL_PATHS = {
  inspectorRequestRaw: "inmemory://fluxproxy/inspector/request/raw.http",
  inspectorRequestJson: "inmemory://fluxproxy/inspector/request/body.json",
  inspectorRequestXml: "inmemory://fluxproxy/inspector/request/body.xml",
  inspectorResponseRaw: "inmemory://fluxproxy/inspector/response/raw.http",
  inspectorResponseJson: "inmemory://fluxproxy/inspector/response/body.json",
  inspectorResponseXml: "inmemory://fluxproxy/inspector/response/body.xml",
  inspectorSseEvent: "inmemory://fluxproxy/inspector/sse/event.json",
  inspectorProtobufJson: "inmemory://fluxproxy/inspector/protobuf/projection.json",
  diffOriginal: "inmemory://fluxproxy/diff/original",
  diffModified: "inmemory://fluxproxy/diff/modified",
  breakpointBody: "inmemory://fluxproxy/breakpoints/active-body",
  openApiSpec: "inmemory://fluxproxy/openapi/spec",
} as const;

const utf8Encoder = new TextEncoder();

export function getUtf8ByteLength(text: string | null | undefined): number {
  if (!text) return 0;
  // Fast conservative bound for short strings well below 2 MiB (max 3 UTF-8 bytes per UTF-16 code unit).
  if (text.length * 3 <= MAX_MONACO_RENDER_BYTES) {
    return text.length;
  }
  return utf8Encoder.encode(text).length;
}

export function estimateBase64ByteLength(base64: string | null | undefined): number {
  if (!base64) return 0;
  const len = base64.trim().length;
  if (len === 0) return 0;
  return Math.floor((len * 3) / 4);
}

export function exceedsMonacoRenderLimit(
  text: string | null | undefined,
  declaredSizeBytes?: number | null
): boolean {
  if (
    typeof declaredSizeBytes === "number" &&
    Number.isFinite(declaredSizeBytes) &&
    declaredSizeBytes > MAX_MONACO_RENDER_BYTES
  ) {
    return true;
  }
  return getUtf8ByteLength(text) > MAX_MONACO_RENDER_BYTES;
}
