import { describe, expect, it } from "vitest";
import type { SessionDetail } from "../types/proxy";
import { encodeTextToBase64 } from "./formatters";
import { bytesToBase64, encodeBase64Text } from "./textWizard";
import {
  analyzeAuth,
  analyzeCaching,
  decodeProtobufOrGrpc,
  hasMultipartOrFormPayload,
  hasProtobufOrGrpcContentType,
  isSseSession,
  parseMultipartBody,
  parseSseStream,
} from "./protocolInspectors";

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    summary: {
      id: 1,
      status: 200,
      protocol: "HTTPS/1.1",
      scheme: "https",
      method: "GET",
      host: "api.example.com",
      path: "/v1/resource",
      url: "https://api.example.com/v1/resource",
      contentType: "application/json",
      bodySize: 0,
      durationMs: 25,
      timestamp: "2026-11-19T12:00:00.000Z",
      isMocked: false,
      ...(overrides.summary ?? {}),
    },
    requestHeaders: overrides.requestHeaders ?? [],
    responseHeaders: overrides.responseHeaders ?? [],
    requestBodyBase64: overrides.requestBodyBase64 ?? "",
    responseBodyBase64: overrides.responseBodyBase64 ?? "",
    requestBodyText: overrides.requestBodyText ?? null,
    responseBodyText: overrides.responseBodyText ?? null,
    clientAddr: overrides.clientAddr ?? "127.0.0.1:50000",
    websocketFrames: overrides.websocketFrames ?? [],
    sseEvents: overrides.sseEvents,
  };
}

describe("protocolInspectors — SSE stream parsing & LLM reconstruction", () => {
  it("detects SSE sessions by contentType, sseEvents, or Accept + data:", () => {
    expect(
      isSseSession(
        makeSession({
          summary: {
            ...makeSession().summary,
            contentType: "text/event-stream; charset=utf-8",
          },
        })
      )
    ).toBe(true);

    expect(
      isSseSession(
        makeSession({
          summary: { ...makeSession().summary, contentType: "text/plain" },
          requestHeaders: [{ name: "Accept", value: "text/event-stream" }],
          responseBodyText: "data: hello\n\n",
        })
      )
    ).toBe(true);

    expect(isSseSession(makeSession())).toBe(false);
  });

  it("parses raw SSE blocks with CRLF, comments, retry/id, and reconstructs OpenAI/Anthropic/Gemini/Ollama tokens", () => {
    const rawOpenAi = [
      ": keep-alive",
      "",
      "id: evt-1",
      "retry: 3000",
      "event: chunk",
      'data: {"choices":[{"delta":{"reasoning_content":"Think: "}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      "",
      'data: {"delta":{"text":" world"}}',
      "",
      'data: {"candidates":[{"content":{"parts":[{"text":"!"}]}}]}',
      "",
      'data: {"response":" (ollama)"}',
      "",
      "data: [DONE]",
      "",
    ].join("\r\n");

    const analysis = parseSseStream(rawOpenAi);
    expect(analysis.isSse).toBe(true);
    expect(analysis.isLlmStream).toBe(true);
    expect(analysis.reconstructedText).toBe("Think: Hello world! (ollama)");
    expect(analysis.events[0].event).toBe("comment");
    expect(analysis.events[1].id).toBe("evt-1");
    expect(analysis.events[1].retry).toBe(3000);
    expect(analysis.events[analysis.events.length - 1].isDoneSentinel).toBe(
      true
    );
  });

  it("computes deltaMs from existing SseEventRecord items and joins non-LLM events", () => {
    const analysis = parseSseStream(null, [
      {
        index: 1,
        event: "ping",
        data: "line-1",
        byteLength: 10,
        offsetMs: 100,
        timestamp: "2026-11-19T12:00:00.000Z",
      },
      {
        index: 2,
        event: "message",
        data: "line-2",
        byteLength: 12,
        offsetMs: 175,
        timestamp: "2026-11-19T12:00:00.075Z",
      },
    ]);

    expect(analysis.isLlmStream).toBe(false);
    expect(analysis.reconstructedText).toBe("line-1\nline-2");
    expect(analysis.events[0].deltaMs).toBe(100);
    expect(analysis.events[1].deltaMs).toBe(75);
    expect(analysis.totalDurationMs).toBe(175);
    expect(analysis.totalBytes).toBe(22);
    expect(analysis.eventTypeCounts).toEqual({ ping: 1, message: 1 });
  });
});

describe("protocolInspectors — Multipart / URL-Encoded Form inspector", () => {
  it("parses application/x-www-form-urlencoded bodies", () => {
    const headers = [
      { name: "Content-Type", value: "application/x-www-form-urlencoded" },
    ];
    const b64 = encodeTextToBase64("user=alice&role=admin+user");
    expect(hasMultipartOrFormPayload(headers, b64)).toBe(true);

    const parsed = parseMultipartBody(headers, b64);
    expect(parsed.detected).toBe(true);
    expect(parsed.kind).toBe("urlencoded");
    expect(parsed.parts.map((p) => [p.name, p.textPreview])).toEqual([
      ["user", "alice"],
      ["role", "admin user"],
    ]);
  });

  it("parses multipart/form-data with JSON field pretty-printing and PNG magic-byte sniffing", () => {
    const boundary = "----FluxBoundary123";
    const enc = new TextEncoder();
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);

    const part1 = enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n{"a":1,"b":true}\r\n`
    );
    const part2Head = enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename*=UTF-8''%D1%84%D0%BE%D1%82%D0%BE.png\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const part2Tail = enc.encode(`\r\n--${boundary}--\r\n`);

    const full = new Uint8Array(
      part1.length + part2Head.length + pngBytes.length + part2Tail.length
    );
    let offset = 0;
    full.set(part1, offset);
    offset += part1.length;
    full.set(part2Head, offset);
    offset += part2Head.length;
    full.set(pngBytes, offset);
    offset += pngBytes.length;
    full.set(part2Tail, offset);

    const b64 = bytesToBase64(full);
    const headers = [
      {
        name: "Content-Type",
        value: `multipart/form-data; boundary="${boundary}"`,
      },
    ];

    const parsed = parseMultipartBody(headers, b64);
    expect(parsed.detected).toBe(true);
    expect(parsed.kind).toBe("multipart");
    expect(parsed.boundary).toBe(boundary);
    expect(parsed.parts).toHaveLength(2);

    expect(parsed.parts[0].name).toBe("meta");
    expect(parsed.parts[0].textPreview).toBe('{\n  "a": 1,\n  "b": true\n}');

    expect(parsed.parts[1].name).toBe("avatar");
    expect(parsed.parts[1].filename).toBe("фото.png");
    expect(parsed.parts[1].contentType).toBe("image/png");
    expect(parsed.parts[1].isBinary).toBe(true);
    expect(parsed.parts[1].isFile).toBe(true);
    expect(parsed.parts[1].imageDataUrl).toMatch(/^data:image\/png;base64,/);

    // Auto-detects boundary from body even if header omits Content-Type
    const autoDetected = parseMultipartBody([], b64);
    expect(autoDetected.detected).toBe(true);
    expect(autoDetected.boundary).toBe(boundary);

    // Non-multipart fallback returns error
    const missing = parseMultipartBody([], encodeTextToBase64("plain text"));
    expect(missing.detected).toBe(false);
    expect(missing.error).toBeTruthy();
  });
});

describe("protocolInspectors — Protobuf & gRPC wire decoder", () => {
  function buildSampleProtobufBytes(): Uint8Array {
    const out: number[] = [];
    // Field 1: varint 150 (0x08, 0x96, 0x01)
    out.push(0x08, 0x96, 0x01);
    // Field 2: string "hi" (0x12, 0x02, 'h', 'i')
    out.push(0x12, 0x02, 0x68, 0x69);
    // Field 3: fixed64 double 3.5
    out.push(0x19);
    const buf64 = new ArrayBuffer(8);
    new DataView(buf64).setFloat64(0, 3.5, true);
    out.push(...new Uint8Array(buf64));
    // Field 4: fixed32 uint32 42
    out.push(0x25);
    const buf32 = new ArrayBuffer(4);
    new DataView(buf32).setUint32(0, 42, true);
    out.push(...new Uint8Array(buf32));
    // Field 5: embedded submessage { 1: 1, 2: 42 } (control bytes ensure submessage decoding)
    out.push(0x2a, 0x04, 0x08, 0x01, 0x10, 0x2a);
    // Repeated field 2: "yo"
    out.push(0x12, 0x02, 0x79, 0x6f);
    return new Uint8Array(out);
  }

  it("decodes raw Protobuf wire messages including nested submessages and repeated fields", () => {
    const headers = [{ name: "Content-Type", value: "application/x-protobuf" }];
    expect(hasProtobufOrGrpcContentType(headers)).toBe(true);

    const pbBytes = buildSampleProtobufBytes();
    const res = decodeProtobufOrGrpc(headers, bytesToBase64(pbBytes));

    expect(res.detected).toBe(true);
    expect(res.isGrpcEnvelope).toBe(false);
    expect(res.error).toBeUndefined();
    expect(res.frames).toHaveLength(1);

    const fields = res.frames[0].fields;
    expect(fields[0].fieldNumber).toBe(1);
    expect(fields[0].valueSummary).toBe("150");
    expect(fields[1].valueSummary).toBe('"hi"');
    expect(fields[2].valueSummary).toContain("3.5");
    expect(fields[3].valueSummary).toBe("42");
    expect(fields[4].children).toHaveLength(2);
    expect(fields[4].children?.[0].path).toBe("5.1");

    const projected = JSON.parse(res.jsonProjection) as Record<string, unknown>;
    expect(projected.field_1).toBe(150);
    expect(projected.field_2).toEqual(["hi", "yo"]);
    expect(projected.field_5).toEqual({ field_1: 1, field_2: 42 });
  });

  it("decodes 5-byte gRPC envelopes (uncompressed, compressed, trailer) and grpc-status headers", () => {
    const pbBytes = buildSampleProtobufBytes();
    const trailerText = "grpc-status: 0\r\ngrpc-message: OK";
    const trailerBytes = new TextEncoder().encode(trailerText);
    const compPayload = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);

    const makeFrame = (flag: number, payload: Uint8Array): Uint8Array => {
      const f = new Uint8Array(5 + payload.length);
      f[0] = flag;
      new DataView(f.buffer).setUint32(1, payload.length, false);
      f.set(payload, 5);
      return f;
    };

    const f1 = makeFrame(0x00, pbBytes);
    const f2 = makeFrame(0x01, compPayload);
    const f3 = makeFrame(0x80, trailerBytes);
    const combined = new Uint8Array(f1.length + f2.length + f3.length);
    combined.set(f1, 0);
    combined.set(f2, f1.length);
    combined.set(f3, f1.length + f2.length);

    const headers = [
      { name: "Content-Type", value: "application/grpc-web+proto" },
      { name: "grpc-status", value: "3" },
      { name: "grpc-message", value: "Bad%20Field" },
      { name: "grpc-encoding", value: "gzip" },
    ];

    const grpcRes = decodeProtobufOrGrpc(headers, bytesToBase64(combined));
    expect(grpcRes.detected).toBe(true);
    expect(grpcRes.isGrpcEnvelope).toBe(true);
    expect(grpcRes.grpcStatus).toEqual({
      code: 3,
      name: "INVALID_ARGUMENT",
      message: "Bad Field",
    });
    expect(grpcRes.grpcEncoding).toBe("gzip");
    expect(grpcRes.frames).toHaveLength(3);
    expect(grpcRes.frames[1].compressed).toBe(true);
    expect(grpcRes.frames[2].isTrailerFrame).toBe(true);
    expect(grpcRes.frames[2].trailerText).toBe(trailerText);

    // Empty body with grpc-status returns ok without error
    const emptyStatusRes = decodeProtobufOrGrpc(
      [{ name: "grpc-status", value: "0" }],
      ""
    );
    expect(emptyStatusRes.detected).toBe(true);
    expect(emptyStatusRes.error).toBeUndefined();

    // Unsupported wire type (6) returns error
    const badWire = decodeProtobufOrGrpc([], bytesToBase64(new Uint8Array([0x0e])), true);
    expect(badWire.error).toContain("wire_type=6");
  });
});

describe("protocolInspectors — Auth & HTTP Caching analyzers", () => {
  it("inspects Bearer JWT, Basic, API-Key, query secrets, WWW-Authenticate, and OAuth responses", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const expiredJwt = `${encodeBase64Text('{"alg":"none","typ":"JWT"}', true)}.${encodeBase64Text(
      JSON.stringify({ sub: "u1", exp: nowSec - 120 }),
      true
    )}.`;

    const detail = makeSession({
      summary: {
        ...makeSession().summary,
        scheme: "http",
        status: 401,
        url: "http://api.example.com/v1/oauth/token?api_key=super-secret-query-key",
        contentType: "application/json",
      },
      requestHeaders: [
        { name: "Authorization", value: `Bearer ${expiredJwt}` },
        { name: "Proxy-Authorization", value: `Basic ${btoa("alice:s3cr3t")}` },
        { name: "X-Api-Key", value: "ak_live_1234567890abcdef" },
      ],
      responseHeaders: [
        {
          name: "WWW-Authenticate",
          value: 'Bearer realm="api", error="invalid_token"',
        },
      ],
      responseBodyText: JSON.stringify({
        access_token: "opaque_tok_123",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read write",
      }),
    });

    const auth = analyzeAuth(detail);
    expect(auth.hasAuth).toBe(true);
    expect(auth.entries.some((e) => e.scheme.includes("JWT"))).toBe(true);
    expect(auth.entries.some((e) => e.scheme === "Basic")).toBe(true);
    expect(auth.entries.some((e) => e.scheme === "API Key")).toBe(true);
    expect(auth.entries.some((e) => e.source === "query-param")).toBe(true);
    expect(auth.entries.some((e) => e.source === "response-challenge")).toBe(
      true
    );
    expect(auth.entries.some((e) => e.source === "oauth-body")).toBe(true);

    expect(
      auth.securityFindings.some(
        (f) => f.level === "error" && f.message.includes("HTTP")
      )
    ).toBe(true);
    expect(
      auth.securityFindings.some(
        (f) => f.level === "error" && f.message.includes("просрочен")
      )
    ).toBe(true);
    expect(
      auth.securityFindings.some(
        (f) => f.level === "warn" && f.message.includes("URL")
      )
    ).toBe(true);
  });

  it("evaluates RFC 9111 caching verdicts across 304, no-store, Vary: *, revalidate, and fresh TTL", () => {
    const hit304 = analyzeCaching(
      makeSession({
        summary: { ...makeSession().summary, status: 304 },
        requestHeaders: [{ name: "If-None-Match", value: '"v1"' }],
      })
    );
    expect(hit304.verdict).toBe("conditional-hit");

    const postReq = analyzeCaching(
      makeSession({
        summary: { ...makeSession().summary, method: "POST" },
      })
    );
    expect(postReq.verdict).toBe("non-cacheable");

    const noStore = analyzeCaching(
      makeSession({
        responseHeaders: [{ name: "Cache-Control", value: "no-store" }],
      })
    );
    expect(noStore.verdict).toBe("non-cacheable");
    expect(noStore.freshness.sharedCacheAllowed).toBe(false);

    const varyStar = analyzeCaching(
      makeSession({
        responseHeaders: [{ name: "Vary", value: "*" }],
      })
    );
    expect(varyStar.verdict).toBe("non-cacheable");

    const revalidate = analyzeCaching(
      makeSession({
        responseHeaders: [
          { name: "Cache-Control", value: "no-cache" },
          { name: "ETag", value: 'W/"abc"' },
        ],
      })
    );
    expect(revalidate.verdict).toBe("cacheable-revalidate");
    expect(revalidate.validators.etagKind).toBe("Weak");

    const noValidators = analyzeCaching(
      makeSession({
        responseHeaders: [{ name: "Cache-Control", value: "max-age=0" }],
      })
    );
    expect(noValidators.verdict).toBe("non-cacheable");

    const fresh = analyzeCaching(
      makeSession({
        requestHeaders: [{ name: "Authorization", value: "Bearer tok" }],
        responseHeaders: [
          {
            name: "Cache-Control",
            value: "public, max-age=3600, immutable",
          },
          { name: "Age", value: "100" },
        ],
      })
    );
    expect(fresh.verdict).toBe("cacheable-fresh");
    expect(fresh.freshness.maxAgeSec).toBe(3600);
    expect(fresh.freshness.ageSec).toBe(100);
    expect(fresh.freshness.remainingSec).toBe(3500);
    expect(fresh.freshness.sharedCacheAllowed).toBe(true);
  });
});
