import {
  BUILTIN_REDACTED_AUTH_HEADERS,
  type AutoResponderRule,
  type ClientCertificateEntry,
  type DoctorCheckResult,
  type HeaderPair,
  type ProxyStatus,
  type SanitizationOptions,
  type SessionDetail,
  type SseEventRecord,
} from "../types/proxy";
import { decodeBase64ToBytes, encodeTextToBase64 } from "./formatters";
import { bytesToBase64, createSampleJwtToken } from "./textWizard";

const SAMPLE_SVG_BADGE = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="160" viewBox="0 0 360 160">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0ea5e9"/>
      <stop offset="100%" stop-color="#6366f1"/>
    </linearGradient>
  </defs>
  <rect width="360" height="160" rx="16" fill="url(#g)"/>
  <circle cx="58" cy="80" r="28" fill="rgba(255,255,255,0.18)"/>
  <path d="M48 80h20M58 70v20" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  <text x="104" y="74" fill="#ffffff" font-family="monospace" font-size="18" font-weight="bold">FluxProxy Asset CDN</text>
  <text x="104" y="100" fill="#e0f2fe" font-family="sans-serif" font-size="13">200 OK • Decrypted TLS 1.3</text>
</svg>`;

const MULTIPART_BOUNDARY = "----FluxProxyBoundary7MA4YWxkTrZu0gW";
const SAMPLE_MULTIPART_BODY = [
  `--${MULTIPART_BOUNDARY}`,
  `Content-Disposition: form-data; name="metadata"`,
  `Content-Type: application/json; charset=utf-8`,
  ``,
  `{"project":"flux-proxy","environment":"staging","retentionDays":30}`,
  `--${MULTIPART_BOUNDARY}`,
  `Content-Disposition: form-data; name="visibility"`,
  ``,
  `team-internal`,
  `--${MULTIPART_BOUNDARY}`,
  `Content-Disposition: form-data; name="preview_badge"; filename="brand-banner.svg"`,
  `Content-Type: image/svg+xml`,
  ``,
  SAMPLE_SVG_BADGE,
  `--${MULTIPART_BOUNDARY}--`,
  ``,
].join("\r\n");

function buildGrpcFrameBase64(protoPayload: Uint8Array): string {
  const frame = new Uint8Array(5 + protoPayload.length);
  frame[0] = 0x00; // uncompressed gRPC flag
  const len = protoPayload.length;
  frame[1] = (len >>> 24) & 0xff;
  frame[2] = (len >>> 16) & 0xff;
  frame[3] = (len >>> 8) & 0xff;
  frame[4] = len & 0xff;
  frame.set(protoPayload, 5);
  return bytesToBase64(frame, false);
}

function encodeProtobufStringField(fieldNo: number, str: string): number[] {
  const strBytes = new TextEncoder().encode(str);
  return [(fieldNo << 3) | 2, strBytes.length, ...strBytes];
}

function encodeProtobufVarintField(fieldNo: number, val: number): number[] {
  const out = [(fieldNo << 3) | 0];
  let n = val >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

const SAMPLE_GRPC_REQ_B64 = buildGrpcFrameBase64(
  new Uint8Array([
    ...encodeProtobufStringField(1, "ord_01JBDF77K2M9"),
    ...encodeProtobufVarintField(2, 14900),
    ...encodeProtobufStringField(3, "USD"),
    0x22,
    0x0e,
    ...encodeProtobufStringField(1, "cus_denis_42"),
  ])
);

const SAMPLE_GRPC_RESP_B64 = buildGrpcFrameBase64(
  new Uint8Array([
    ...encodeProtobufVarintField(1, 1), // approved = true
    ...encodeProtobufStringField(2, "auth_99f8c2a1b4"),
    ...encodeProtobufVarintField(3, 18), // risk_score = 18
  ])
);

const SAMPLE_SSE_CHUNKS: { offsetMs: number; event: string; data: string }[] = [
  {
    offsetMs: 42,
    event: "message",
    data: '{"id":"chatcmpl-fx91","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Привет! "}}]}',
  },
  {
    offsetMs: 96,
    event: "message",
    data: '{"id":"chatcmpl-fx91","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Трафик SSE "}}]}',
  },
  {
    offsetMs: 158,
    event: "message",
    data: '{"id":"chatcmpl-fx91","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"перехвачен без буферизации "}}]}',
  },
  {
    offsetMs: 229,
    event: "message",
    data: '{"id":"chatcmpl-fx91","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"через hyper StreamBody."},"finish_reason":"stop"}]}',
  },
  {
    offsetMs: 254,
    event: "message",
    data: "[DONE]",
  },
];

interface EndpointTemplate {
  method: string;
  scheme: "https" | "http" | "wss";
  protocol: string;
  host: string;
  path: string;
  status: number;
  contentType: string;
  reqContentType?: string;
  reqBody?: string;
  reqBodyBase64?: string;
  respBody: string;
  respBodyBase64?: string;
  extraReqHeaders?: HeaderPair[];
  extraRespHeaders?: HeaderPair[];
  sseChunks?: { offsetMs: number; event: string; data: string }[];
  expiredJwt?: boolean;
  simulatedBodySize?: number;
  simulatedDurationMs?: number;
  processName: string;
  processPid: number;
  conditionalCache?: boolean;
  customCookies?: string;
  customSetCookie?: string;
  defaultComment?: string;
  defaultMarkedColor?: string;
}

const TEMPLATES: EndpointTemplate[] = [
  {
    method: "POST",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "api.openai.com",
    path: "/v1/chat/completions",
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    reqContentType: "application/json; charset=utf-8",
    processName: "cursor.exe",
    processPid: 19420,
    simulatedDurationMs: 268,
    reqBody: JSON.stringify(
      {
        model: "gpt-4.1-mini",
        stream: true,
        messages: [
          {
            role: "user",
            content: "Проверь потоковый инспектор SSE в FluxProxy",
          },
        ],
      },
      null,
      2
    ),
    extraReqHeaders: [{ name: "Accept", value: "text/event-stream" }],
    extraRespHeaders: [
      { name: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
      { name: "X-Accel-Buffering", value: "no" },
    ],
    sseChunks: SAMPLE_SSE_CHUNKS,
    respBody: SAMPLE_SSE_CHUNKS.map((c) => `data: ${c.data}\n\n`).join(""),
  },
  {
    method: "POST",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "storage.fluxproxy.dev",
    path: "/v1/uploads?bucket=artifacts",
    status: 201,
    contentType: "application/json; charset=utf-8",
    reqContentType: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
    processName: "chrome.exe",
    processPid: 14280,
    simulatedDurationMs: 112,
    reqBody: SAMPLE_MULTIPART_BODY,
    extraRespHeaders: [{ name: "Cache-Control", value: "no-store" }],
    respBody: JSON.stringify(
      {
        uploadId: "upl_01JBDFA82Z9Q",
        storedFiles: ["brand-banner.svg"],
        bytesAccepted: SAMPLE_MULTIPART_BODY.length,
      },
      null,
      2
    ),
  },
  {
    method: "POST",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "ledger.rpc.corp",
    path: "/flux.ledger.v1.PaymentService/Authorize",
    status: 200,
    contentType: "application/grpc+proto",
    reqContentType: "application/grpc+proto",
    processName: "go-ledger.exe",
    processPid: 27410,
    simulatedDurationMs: 31,
    reqBodyBase64: SAMPLE_GRPC_REQ_B64,
    respBodyBase64: SAMPLE_GRPC_RESP_B64,
    extraReqHeaders: [
      { name: "TE", value: "trailers" },
      { name: "grpc-timeout", value: "5S" },
    ],
    extraRespHeaders: [
      { name: "grpc-status", value: "0" },
      { name: "grpc-message", value: "Authorized" },
      { name: "Cache-Control", value: "no-store" },
    ],
    respBody: "",
  },
  {
    method: "GET",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "api.stripe.com",
    path: "/v1/payment_intents?limit=25&expand[]=data.customer",
    status: 200,
    contentType: "application/json; charset=utf-8",
    processName: "node.exe",
    processPid: 21904,
    extraRespHeaders: [
      { name: "Cache-Control", value: "private, no-cache, no-store" },
      { name: "Vary", value: "Authorization, Stripe-Version" },
    ],
    respBody: JSON.stringify(
      {
        object: "list",
        url: "/v1/payment_intents",
        has_more: false,
        data: [
          {
            id: "pi_3Q9xLm2eZvKYlo2C1abc",
            amount: 4900,
            currency: "usd",
            status: "succeeded",
            capture_method: "automatic",
          },
        ],
      },
      null,
      2
    ),
  },
  {
    method: "POST",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "api.linear.app",
    path: "/graphql",
    status: 200,
    contentType: "application/json; charset=utf-8",
    reqContentType: "application/json; charset=utf-8",
    processName: "chrome.exe",
    processPid: 14280,
    reqBody: JSON.stringify({
      operationName: "IssueUpdate",
      variables: { id: "ENG-482", stateId: "in_progress" },
      query:
        "mutation IssueUpdate($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }",
    }),
    respBody: JSON.stringify({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "ENG-482",
            title: "Implement Zero-Copy TLS MITM Tunnel",
            priority: 1,
          },
        },
      },
    }),
  },
  {
    method: "OPTIONS",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "api.linear.app",
    path: "/graphql",
    status: 204,
    contentType: "text/plain",
    processName: "chrome.exe",
    processPid: 14280,
    simulatedDurationMs: 12,
    respBody: "",
  },
  {
    method: "GET",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "cdn.fluxproxy.dev",
    path: "/assets/brand-banner.svg?v=4.2",
    status: 200,
    contentType: "image/svg+xml",
    processName: "chrome.exe",
    processPid: 14280,
    conditionalCache: true,
    extraRespHeaders: [
      {
        name: "Cache-Control",
        value: "public, max-age=31536000, s-maxage=86400, immutable",
      },
      { name: "Age", value: "412" },
      { name: "CF-Cache-Status", value: "HIT" },
      { name: "Vary", value: "Accept-Encoding" },
    ],
    respBody: SAMPLE_SVG_BADGE,
  },
  {
    method: "GET",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "cdn.fluxproxy.dev",
    path: "/assets/vendor-monaco.chunk.js",
    status: 304,
    contentType: "application/javascript; charset=utf-8",
    processName: "chrome.exe",
    processPid: 14280,
    conditionalCache: true,
    simulatedDurationMs: 19,
    extraRespHeaders: [
      { name: "Cache-Control", value: "public, max-age=3600, must-revalidate" },
      { name: "Vary", value: "Accept-Encoding" },
    ],
    respBody: "",
  },
  {
    method: "POST",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "auth.internal.corp",
    path: "/oauth2/token",
    status: 200,
    contentType: "application/json; charset=utf-8",
    reqContentType: "application/x-www-form-urlencoded",
    expiredJwt: false,
    processName: "Postman.exe",
    processPid: 8840,
    customCookies: "session_id=fx_98172bc01; theme=dark; csrf_token=valid_9b81e2",
    customSetCookie:
      "auth_session=live_88f12a; Path=/; Secure; HttpOnly; SameSite=Strict",
    reqBody:
      "grant_type=refresh_token&client_id=desktop-debugger&refresh_token=live_77410f",
    extraRespHeaders: [{ name: "Cache-Control", value: "no-store" }],
    respBody: JSON.stringify(
      {
        access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fresh_session",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read:traffic write:rules",
        trace_id: "req_200_ok_auth",
      },
      null,
      2
    ),
  },
  {
    method: "POST",
    scheme: "https",
    protocol: "HTTPS/1.1",
    host: "auth.internal.corp",
    path: "/oauth2/token",
    status: 401,
    contentType: "application/json; charset=utf-8",
    reqContentType: "application/x-www-form-urlencoded",
    expiredJwt: true,
    processName: "Postman.exe",
    processPid: 8840,
    customCookies: "session_id=fx_expired_001; theme=dark",
    customSetCookie:
      "auth_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict",
    reqBody:
      "grant_type=refresh_token&client_id=desktop-debugger&refresh_token=exp_99182a",
    extraRespHeaders: [
      {
        name: "WWW-Authenticate",
        value:
          'Bearer realm="fluxproxy-corp", error="invalid_token", error_description="The access token expired"',
      },
      { name: "Cache-Control", value: "no-store" },
    ],
    respBody: JSON.stringify({
      error: "invalid_grant",
      error_description:
        "Refresh token expired or revoked; re-authentication required.",
      trace_id: "req_98f1bc204e",
    }),
  },
  {
    method: "POST",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "api.stripe.com",
    path: "/v1/payment_intents",
    status: 422,
    contentType: "application/json; charset=utf-8",
    reqContentType: "application/json; charset=utf-8",
    processName: "node.exe",
    processPid: 21904,
    reqBody: JSON.stringify(
      {
        amount: -500,
        currency: "usd",
        capture_method: "automatic",
        metadata: { orderId: "ord_01JBDF_BAD" },
      },
      null,
      2
    ),
    extraRespHeaders: [{ name: "Cache-Control", value: "no-store" }],
    respBody: JSON.stringify(
      {
        error: {
          code: "parameter_invalid_integer",
          doc_url: "https://stripe.com/docs/error-codes/parameter-invalid-integer",
          message: "This value must be greater than or equal to 1.",
          param: "amount",
          type: "invalid_request_error",
        },
      },
      null,
      2
    ),
  },
  {
    method: "GET",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "storage.analytics.corp",
    path: "/api/v2/exports/transactions-snapshot.json",
    status: 200,
    contentType: "application/json; charset=utf-8",
    processName: "python.exe",
    processPid: 31012,
    simulatedBodySize: 1_420_800, // ~1.35 MB (> 1 MB threshold test)
    simulatedDurationMs: 780, // > 500ms Time Heat test
    extraRespHeaders: [
      { name: "Cache-Control", value: "private, max-age=120" },
      { name: "ETag", value: 'W/"snap-2026-10-30"' },
    ],
    respBody: JSON.stringify(
      {
        exportId: "exp_2026_10_30_bulk",
        rows: 15000,
        note: "Large 1.35 MB analytics snapshot payload (truncated preview)",
      },
      null,
      2
    ),
  },
  {
    method: "POST",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "telemetry.microsoft.com",
    path: "/OneCollector/1.0/?cors=true",
    status: 200,
    contentType: "application/x-json-stream",
    processName: "svchost.exe",
    processPid: 1120,
    simulatedDurationMs: 42,
    reqBody: '{"ver":"4.0","name":"Microsoft.Windows.Diagnostics"}',
    respBody: '{"acc":1}',
  },
  {
    method: "GET",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "p12-buy.itunes.apple.com",
    path: "/WebObjects/MZFinance.woa/wa/verifyReceipt",
    status: 200,
    contentType: "application/json",
    processName: "chrome.exe",
    processPid: 14280,
    simulatedBodySize: 18_432,
    simulatedDurationMs: 95,
    respBody: '{"status":0}',
  },
  {
    method: "GET",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "ocsp.digicert.com",
    path: "/MFEwTzBNMEswSTAJBgUrDgMCGgUABBTc3zF5G2mR7n3J",
    status: 200,
    contentType: "application/ocsp-response",
    processName: "chrome.exe",
    processPid: 14280,
    simulatedBodySize: 472,
    simulatedDurationMs: 24,
    respBody: "",
  },
  {
    method: "GET",
    scheme: "https",
    protocol: "HTTPS/1.1",
    host: "feeds.feedburner.com",
    path: "/rust-lang/blog.xml?format=xml",
    status: 200,
    contentType: "application/xml; charset=utf-8",
    processName: "python.exe",
    processPid: 31012,
    extraRespHeaders: [
      {
        name: "Cache-Control",
        value: "public, max-age=300, stale-while-revalidate=600",
      },
      { name: "ETag", value: '"rss-rust-2026-10"' },
    ],
    respBody: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Rust Systems Engineering Feed</title>
    <link>https://blog.rust-lang.org</link>
    <item>
      <title>Async Hyper 1.x &amp; Zero-Allocation HTTP/2 Proxying</title>
      <guid>rust-hyper-mitm-2026</guid>
      <pubDate>Fri, 30 Oct 2026 08:30:00 GMT</pubDate>
    </item>
  </channel>
</rss>`,
  },
  {
    method: "GET",
    scheme: "wss",
    protocol: "WSS",
    host: "realtime.github.com",
    path: "/_ws/notifications?channel=pull_requests",
    status: 101,
    contentType: "websocket/frames",
    processName: "chrome.exe",
    processPid: 14280,
    respBody: JSON.stringify(
      [
        {
          index: 1,
          direction: "outbound",
          opcode: "text",
          payload: '{"type":"subscribe","repo":"fluxproxy/core"}',
        },
        {
          index: 2,
          direction: "inbound",
          opcode: "text",
          payload: '{"type":"ack","latency_ms":11}',
        },
      ],
      null,
      2
    ),
  },
  {
    method: "DELETE",
    scheme: "https",
    protocol: "HTTPS/2",
    host: "k8s-gateway.prod.internal",
    path: "/api/v1/namespaces/staging/pods/worker-7c8d9",
    status: 503,
    contentType: "application/json",
    processName: "node.exe",
    processPid: 21904,
    simulatedDurationMs: 1620, // Critical Time Heat (> 1500ms)
    respBody: JSON.stringify({
      kind: "Status",
      apiVersion: "v1",
      status: "Failure",
      message: "etcd leader election in progress; retry after 2000ms",
      code: 503,
    }),
  },
];

export function buildSimulatedSession(id: number): SessionDetail {
  const tpl = TEMPLATES[(id - 1) % TEMPLATES.length];
  const durationMs =
    tpl.simulatedDurationMs ??
    (tpl.status >= 500
      ? 540 + (id % 290)
      : tpl.scheme === "wss"
        ? 14
        : 18 + ((id * 17) % 165));
  const url = `${tpl.scheme === "wss" ? "wss" : tpl.scheme}://${tpl.host}${tpl.path}`;
  const reqText = tpl.reqBody ?? "";
  const respText = tpl.respBody;
  const reqB64 =
    tpl.reqBodyBase64 ?? (reqText ? encodeTextToBase64(reqText) : "");
  const respB64 =
    tpl.respBodyBase64 ?? (respText ? encodeTextToBase64(respText) : "");
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const jwtToken = createSampleJwtToken(Boolean(tpl.expiredJwt));

  const requestHeaders: HeaderPair[] = [
    {
      name: "User-Agent",
      value:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FluxClient/1.0",
    },
    ...(tpl.reqContentType
      ? [{ name: "Content-Type", value: tpl.reqContentType }]
      : []),
    { name: "Accept", value: tpl.contentType.split(";")[0] || "*/*" },
    { name: "Accept-Encoding", value: "gzip, deflate, br" },
    {
      name: "Authorization",
      value: `Bearer ${jwtToken}`,
    },
    {
      name: "Cookie",
      value:
        tpl.customCookies ??
        "session_id=fx_98172bc01; theme=dark; csrf_token=9b81e2",
    },
    ...(tpl.extraReqHeaders ?? []),
  ];

  const responseHeaders: HeaderPair[] = [
    { name: "Content-Type", value: tpl.contentType },
    { name: "Server", value: "cloudflare-nginx" },
    { name: "Date", value: new Date(nowMs).toUTCString() },
    {
      name: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    },
    {
      name: "X-Request-Id",
      value: `req_${id.toString(16).padStart(8, "0")}`,
    },
    {
      name: "Set-Cookie",
      value:
        tpl.customSetCookie ??
        `edge_trace=tr_${id}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    },
    ...(tpl.extraRespHeaders ?? []),
  ];

  if (tpl.conditionalCache) {
    requestHeaders.push(
      { name: "If-Modified-Since", value: "Thu, 29 Oct 2026 18:00:00 GMT" },
      { name: "If-None-Match", value: `"etag-fx-${tpl.path.length}"` }
    );
    responseHeaders.push(
      { name: "ETag", value: `"etag-fx-${tpl.path.length}"` },
      { name: "Last-Modified", value: "Thu, 29 Oct 2026 18:00:00 GMT" }
    );
  }

  const sseEvents: SseEventRecord[] = tpl.sseChunks
    ? tpl.sseChunks.map((chunk, idx) => ({
        index: idx + 1,
        id: `ev_${id}_${idx + 1}`,
        event: chunk.event,
        data: chunk.data,
        retry: null,
        byteLength: new TextEncoder().encode(chunk.data).length,
        offsetMs: chunk.offsetMs,
        timestamp: new Date(nowMs + chunk.offsetMs).toISOString(),
      }))
    : [];

  return {
    summary: {
      id,
      status: tpl.status,
      protocol: tpl.protocol,
      scheme: tpl.scheme,
      method: tpl.method,
      host: tpl.host,
      path: tpl.path,
      url,
      contentType: tpl.contentType,
      bodySize:
        tpl.status === 304 || tpl.status === 204
          ? 0
          : tpl.simulatedBodySize ??
            (tpl.respBodyBase64
              ? Math.floor((tpl.respBodyBase64.length * 3) / 4)
              : new TextEncoder().encode(respText).length),
      durationMs,
      timestamp: nowIso,
      isMocked: false,
      matchedRuleId: null,
      error: tpl.status === 503 ? "Upstream Service Unavailable" : null,
      processName: tpl.processName,
      processPid: tpl.processPid,
      tlsBypassed: false,
      headersMutated: false,
      breakpointPaused: null,
      breakpointModified: false,
      comment: tpl.defaultComment ?? null,
      markedColor: tpl.defaultMarkedColor ?? null,
    },
    requestHeaders,
    responseHeaders,
    requestBodyBase64: reqB64,
    responseBodyBase64: respB64,
    requestBodyText: tpl.reqBodyBase64 ? null : reqText || null,
    responseBodyText: tpl.respBodyBase64 ? null : respText || null,
    tlsVersion: tpl.scheme === "http" ? null : "TLS 1.3 (ECDSA-P256 MITM)",
    clientAddr: `127.0.0.1:${51200 + (tpl.processPid % 4000)}`,
    websocketFrames:
      tpl.scheme === "wss"
        ? [
            {
              index: 1,
              direction: "outbound",
              opcode: "text",
              payloadPreview: '{"type":"subscribe","repo":"fluxproxy/core"}',
              byteLength: 45,
              timestamp: nowIso,
            },
            {
              index: 2,
              direction: "inbound",
              opcode: "text",
              payloadPreview: '{"type":"ack","latency_ms":11}',
              byteLength: 30,
              timestamp: nowIso,
            },
          ]
        : [],
    sseEvents,
  };
}

/**
 * Constructs the Phase 1 (In-Flight) snapshot sent immediately before upstream latency completes.
 */
export function buildInFlightSnapshot(detail: SessionDetail): SessionDetail {
  return {
    ...detail,
    summary: {
      ...detail.summary,
      status: 0,
      contentType: "",
      bodySize: 0,
      durationMs: 0,
      isMocked: false,
      matchedRuleId: null,
      error: null,
      breakpointPaused: null,
    },
    responseHeaders: [],
    responseBodyBase64: "",
    responseBodyText: null,
    sseEvents: [],
    websocketFrames: [],
    bodyOffloaded: false,
  };
}

/**
 * Returns a realistic UI-observable simulated upstream delay (ms) between Phase 1 and Phase 2 in Browser Preview.
 */
export function getSimulatedTwoPhaseDelayMs(detail: SessionDetail): number {
  const target = detail.summary.durationMs;
  if (target > 0) {
    return Math.min(Math.max(target, 260), 1400);
  }
  return 320;
}

export const DEFAULT_AUTORESPONDER_RULES: AutoResponderRule[] = [
  {
    id: "rule-mock-auth",
    enabled: false,
    name: "Mock OAuth2 Token Refresh (200 OK)",
    matchTarget: "urlContains",
    pattern: "/oauth2/token",
    methodFilter: "POST",
    headerName: null,
    action: "mockResponse",
    statusCode: 200,
    latencyMs: 65,
    responseHeaders: [
      { name: "Content-Type", value: "application/json; charset=utf-8" },
      { name: "X-AutoResponder", value: "FluxProxy-Rule-Engine" },
    ],
    responseBody: JSON.stringify(
      {
        access_token: createSampleJwtToken(false),
        token_type: "Bearer",
        expires_in: 3600,
        mocked_by: "FluxProxy AutoResponder",
      },
      null,
      2
    ),
  },
  {
    id: "rule-throttle-stripe",
    enabled: false,
    name: "Simulate 650ms Slow 3G Latency on /v1/payment_intents",
    matchTarget: "urlRegex",
    pattern: "stripe\\.com/v1/payment_intents",
    methodFilter: "GET",
    headerName: null,
    action: "delayOnly",
    statusCode: 200,
    latencyMs: 650,
    responseHeaders: [],
    responseBody: "",
  },
];

export const DEFAULT_CLEAR_DB_ON_EXIT = false;

export const PREVIEW_SQLITE_ARCHIVE_STORAGE_KEY =
  "fluxproxy.sqliteArchivePreview.v1";
export const PREVIEW_SQLITE_COUNT_STORAGE_KEY =
  "fluxproxy-sqlite-preview-count";
export const PREVIEW_CLEAR_DB_ON_EXIT_STORAGE_KEY =
  "fluxproxy.clearDbOnExit.v1";
export const PREVIEW_SANITIZATION_OPTIONS_STORAGE_KEY =
  "fluxproxy.sanitizationOptions.v1";
export const PREVIEW_CLIENT_CERTS_STORAGE_KEY =
  "fluxproxy.previewClientCerts.v1";

export function buildDefaultPreviewClientCertificates(): ClientCertificateEntry[] {
  const now = Date.now();
  const daysFromNowIso = (days: number) =>
    new Date(now + days * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  return [
    {
      id: "preview-mcert-1",
      domainPattern: "*.internal.corp",
      label: "Corp Internal mTLS Gateway",
      format: "pkcs12",
      storedCertPath: "%APPDATA%\\dev.fluxproxy.desktop\\client_certs\\preview-mcert-1.p12",
      commonName: "flux-dev-operator.internal.corp",
      expiresAt: daysFromNowIso(240),
      enabled: true,
    },
    {
      id: "preview-mcert-2",
      domainPattern: "payments.staging.corp",
      label: "Staging Payments Sandbox",
      format: "pem",
      storedCertPath: "%APPDATA%\\dev.fluxproxy.desktop\\client_certs\\preview-mcert-2.pem",
      commonName: "sandbox-client@payments.staging.corp",
      expiresAt: daysFromNowIso(12),
      enabled: true,
    },
    {
      id: "preview-mcert-3",
      domainPattern: "legacy-vault.corp",
      label: "Legacy Vault (Expired)",
      format: "pkcs12",
      storedCertPath: "%APPDATA%\\dev.fluxproxy.desktop\\client_certs\\preview-mcert-3.pfx",
      commonName: "legacy-vault-client",
      expiresAt: daysFromNowIso(-15),
      enabled: false,
    },
  ];
}

const BUILTIN_REDACTED_AUTH_HEADERS_SET = new Set(
  BUILTIN_REDACTED_AUTH_HEADERS.map((h) => h.toLowerCase())
);

function normalizeSanitizationTokensPreview(items: string[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    const clean = item.trim().toLowerCase();
    if (clean) out.add(clean);
  }
  return out;
}

function safeDecodeUrlComponentPreview(input: string): string {
  try {
    return decodeURIComponent(input.replace(/\+/g, " "));
  } catch {
    return input;
  }
}

function sanitizeUrlComponentReplacementPreview(replacement: string): string {
  return replacement
    .replace(/[\r\n\0]/g, "")
    .replace(/%/g, "%25")
    .replace(/&/g, "%26")
    .replace(/=/g, "%3D")
    .replace(/#/g, "%23")
    .replace(/\+/g, "%2B");
}

function redactHeadersPreview(
  headers: HeaderPair[],
  redactAuthHeaders: boolean,
  customHeadersLower: Set<string>,
  replacement: string
): HeaderPair[] {
  return headers.map((h) => {
    const lowerName = h.name.trim().toLowerCase();
    const isBuiltin =
      redactAuthHeaders && BUILTIN_REDACTED_AUTH_HEADERS_SET.has(lowerName);
    const isCustom = customHeadersLower.has(lowerName);
    if (isBuiltin || isCustom) {
      return { ...h, value: replacement };
    }
    return { ...h };
  });
}

function sanitizeJsonValueInPlacePreview(
  value: unknown,
  maskKeysLower: Set<string>,
  replacement: string
): boolean {
  if (Array.isArray(value)) {
    let modified = false;
    for (let i = 0; i < value.length; i++) {
      if (sanitizeJsonValueInPlacePreview(value[i], maskKeysLower, replacement)) {
        modified = true;
      }
    }
    return modified;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    let modified = false;
    for (const key of Object.keys(obj)) {
      if (maskKeysLower.has(key.trim().toLowerCase())) {
        obj[key] = replacement;
        modified = true;
      } else if (
        sanitizeJsonValueInPlacePreview(obj[key], maskKeysLower, replacement)
      ) {
        modified = true;
      }
    }
    return modified;
  }
  return false;
}

function sanitizeJsonTextPreview(
  text: string,
  maskKeysLower: Set<string>,
  replacement: string
): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!sanitizeJsonValueInPlacePreview(parsed, maskKeysLower, replacement)) {
      return null;
    }
    return text.includes("\n")
      ? JSON.stringify(parsed, null, 2)
      : JSON.stringify(parsed);
  } catch {
    return null;
  }
}

function isLikelyUrlencodedFormPreview(text: string): boolean {
  const trimmed = text.trim();
  if (
    !trimmed ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("<") ||
    trimmed.includes("\n") ||
    trimmed.includes("\r") ||
    !trimmed.includes("=")
  ) {
    return false;
  }
  return trimmed.split("&").every((seg) => {
    if (!seg) return true;
    const eq = seg.indexOf("=");
    if (eq === -1) return !/\s/.test(seg);
    const k = seg.slice(0, eq);
    const v = seg.slice(eq + 1);
    return k.trim().length > 0 && !/\s/.test(k) && !/\s/.test(v);
  });
}

function sanitizeUrlencodedTextPreview(
  text: string,
  maskKeysLower: Set<string>,
  replacement: string
): string | null {
  if (!text) return null;
  const safeRep = sanitizeUrlComponentReplacementPreview(replacement);
  let modified = false;
  const rebuilt = text.split("&").map((seg) => {
    const eq = seg.indexOf("=");
    if (eq !== -1) {
      const rawK = seg.slice(0, eq);
      const decodedK = safeDecodeUrlComponentPreview(rawK).trim().toLowerCase();
      if (maskKeysLower.has(decodedK)) {
        modified = true;
        return `${rawK}=${safeRep}`;
      }
    }
    return seg;
  });
  return modified ? rebuilt.join("&") : null;
}

function resolveUtf8BodyTextPreview(
  bodyText: string | null | undefined,
  bodyBase64: string | null | undefined
): string | null {
  if (typeof bodyText === "string") {
    return bodyText;
  }
  if (!bodyBase64) return null;
  try {
    const bytes = decodeBase64ToBytes(bodyBase64);
    if (bytes.length === 0) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function sanitizeBodyPayloadPreview(
  text: string,
  contentTypeHint: string | undefined,
  maskKeysLower: Set<string>,
  replacement: string
): string | null {
  if (maskKeysLower.size === 0 || !text.trim()) return null;
  const trimmed = text.trimStart();
  const ctLower = (contentTypeHint ?? "").toLowerCase();
  const isJsonHint =
    ctLower.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (isJsonHint) {
    const updated = sanitizeJsonTextPreview(text, maskKeysLower, replacement);
    if (updated !== null) return updated;
  }
  if (
    ctLower.includes("application/x-www-form-urlencoded") ||
    isLikelyUrlencodedFormPreview(text)
  ) {
    return sanitizeUrlencodedTextPreview(text, maskKeysLower, replacement);
  }
  return null;
}

function updateContentLengthHeaderPreview(
  headers: HeaderPair[],
  byteLen: number
): HeaderPair[] {
  const lenStr = String(byteLen);
  return headers.map((h) =>
    h.name.trim().toLowerCase() === "content-length"
      ? { ...h, value: lenStr }
      : h
  );
}

function sanitizeQueryStringInUrlOrPathPreview(
  input: string,
  stripParamsLower: Set<string>,
  replacement: string
): string {
  if (stripParamsLower.size === 0 || !input.includes("?")) {
    return input;
  }
  const hashIdx = input.indexOf("#");
  const baseAndQuery = hashIdx === -1 ? input : input.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? null : input.slice(hashIdx + 1);
  const qIdx = baseAndQuery.indexOf("?");
  if (qIdx === -1) return input;
  const base = baseAndQuery.slice(0, qIdx);
  const query = baseAndQuery.slice(qIdx + 1);
  if (!query) return input;

  const safeRep = sanitizeUrlComponentReplacementPreview(replacement);
  let modified = false;
  const rebuilt = query.split("&").map((seg) => {
    if (!seg) return "";
    const eq = seg.indexOf("=");
    if (eq !== -1) {
      const rawK = seg.slice(0, eq);
      const decodedK = safeDecodeUrlComponentPreview(rawK).trim().toLowerCase();
      if (stripParamsLower.has(decodedK)) {
        modified = true;
        return `${rawK}=${safeRep}`;
      }
    }
    return seg;
  });

  if (!modified) return input;
  const joined = `${base}?${rebuilt.join("&")}`;
  return fragment !== null ? `${joined}#${fragment}` : joined;
}

export function sanitizeSessionsInPreview(
  sessions: SessionDetail[],
  opts: SanitizationOptions
): SessionDetail[] {
  const replacement = opts.replacementText.trim()
    ? opts.replacementText
    : "[REDACTED]";
  const customHeadersLower = normalizeSanitizationTokensPreview(
    opts.customRedactedHeaders
  );
  const maskKeysLower = normalizeSanitizationTokensPreview(opts.maskJsonKeys);
  const stripParamsLower = normalizeSanitizationTokensPreview(
    opts.stripQueryParams
  );
  const encoder = new TextEncoder();

  return sessions.map((orig) => {
    const detail = structuredClone(orig);

    // 1. Redact headers
    if (opts.redactAuthHeaders || customHeadersLower.size > 0) {
      detail.requestHeaders = redactHeadersPreview(
        detail.requestHeaders,
        opts.redactAuthHeaders,
        customHeadersLower,
        replacement
      );
      detail.responseHeaders = redactHeadersPreview(
        detail.responseHeaders,
        opts.redactAuthHeaders,
        customHeadersLower,
        replacement
      );
    }

    // 2. Mask JSON / form-urlencoded bodies
    if (maskKeysLower.size > 0) {
      const reqText = resolveUtf8BodyTextPreview(
        detail.requestBodyText,
        detail.requestBodyBase64
      );
      if (reqText !== null) {
        const reqCt = detail.requestHeaders.find(
          (h) => h.name.trim().toLowerCase() === "content-type"
        )?.value;
        const sanitizedReq = sanitizeBodyPayloadPreview(
          reqText,
          reqCt,
          maskKeysLower,
          replacement
        );
        if (sanitizedReq !== null) {
          const byteLen = encoder.encode(sanitizedReq).length;
          detail.requestBodyText = sanitizedReq;
          detail.requestBodyBase64 = encodeTextToBase64(sanitizedReq);
          detail.requestHeaders = updateContentLengthHeaderPreview(
            detail.requestHeaders,
            byteLen
          );
        }
      }

      const respText = resolveUtf8BodyTextPreview(
        detail.responseBodyText,
        detail.responseBodyBase64
      );
      if (respText !== null) {
        const respCt =
          detail.summary.contentType ||
          detail.responseHeaders.find(
            (h) => h.name.trim().toLowerCase() === "content-type"
          )?.value;
        const sanitizedResp = sanitizeBodyPayloadPreview(
          respText,
          respCt,
          maskKeysLower,
          replacement
        );
        if (sanitizedResp !== null) {
          const byteLen = encoder.encode(sanitizedResp).length;
          detail.responseBodyText = sanitizedResp;
          detail.responseBodyBase64 = encodeTextToBase64(sanitizedResp);
          detail.summary.bodySize = byteLen;
          detail.responseHeaders = updateContentLengthHeaderPreview(
            detail.responseHeaders,
            byteLen
          );
        }
      }

      if (Array.isArray(detail.sseEvents) && detail.sseEvents.length > 0) {
        detail.sseEvents = detail.sseEvents.map((ev) => {
          const updated = sanitizeJsonTextPreview(
            ev.data,
            maskKeysLower,
            replacement
          );
          if (updated === null) return ev;
          return {
            ...ev,
            data: updated,
            byteLength: encoder.encode(updated).length,
          };
        });
      }

      if (
        Array.isArray(detail.websocketFrames) &&
        detail.websocketFrames.length > 0
      ) {
        detail.websocketFrames = detail.websocketFrames.map((frame) => {
          const updated = sanitizeJsonTextPreview(
            frame.payloadPreview,
            maskKeysLower,
            replacement
          );
          if (updated === null) return frame;
          return {
            ...frame,
            payloadPreview: updated,
            byteLength: encoder.encode(updated).length,
          };
        });
      }
    }

    // 3. Strip query parameters in `summary.url` and `summary.path`
    if (stripParamsLower.size > 0) {
      detail.summary.url = sanitizeQueryStringInUrlOrPathPreview(
        detail.summary.url,
        stripParamsLower,
        replacement
      );
      detail.summary.path = sanitizeQueryStringInUrlOrPathPreview(
        detail.summary.path,
        stripParamsLower,
        replacement
      );
    }

    // 4. Anonymize client info
    if (opts.anonymizeClientInfo) {
      detail.clientAddr = "0.0.0.0:0";
      detail.summary.clientIp = "0.0.0.0";
      detail.summary.processName = "redacted-process";
      detail.summary.processPid = null;
    }

    return detail;
  });
}

export function buildPreviewDoctorChecks(params: {
  status: ProxyStatus;
  caTrusted: boolean;
}): DoctorCheckResult[] {
  const { status, caTrusted } = params;
  const boundList =
    status.boundIps && status.boundIps.length > 0
      ? status.boundIps
      : [status.bindAddr];
  const endpoints = boundList.map((ip) => `${ip}:${status.port}`).join(" + ");
  const expectedSysproxyHost =
    status.bindMode === "specific" &&
    status.specificBindIp &&
    status.alsoBindLoopback === false
      ? status.specificBindIp
      : "127.0.0.1";
  const expectedSysproxyEndpoint = `${expectedSysproxyHost}:${status.port}`;
  const lanExposed = Boolean(
    status.allowRemote ||
      status.bindMode === "all" ||
      (status.bindMode === "specific" &&
        status.specificBindIp &&
        status.specificBindIp !== "127.0.0.1" &&
        status.specificBindIp !== "::1")
  );

  return [
    {
      id: "port_binding",
      title: "Привязка порта и сокетов прокси",
      status: status.running ? "ok" : "warning",
      summary: status.running
        ? `Прокси-листенер активен на ${endpoints}`
        : `Прокси остановлен, но порт ${status.port} свободен (${endpoints})`,
      details: status.running
        ? `Browser Preview: движок активен на [${boundList.join(", ")}], порт ${status.port}.`
        : "Пробная проверка сокета прошла успешно. Запустите прокси-листенер в 1 клик.",
      canAutoFix: !status.running,
      fixLabel: status.running ? null : "Запустить листенер прокси",
    },
    {
      id: "root_ca_trust",
      title: "Доверие к HTTPS Root CA",
      status: caTrusted ? "ok" : "error",
      summary: caTrusted
        ? "FluxProxy Root CA установлен в доверенном хранилище ОС"
        : "Root CA не установлен в доверенные корневые центры ОС",
      details: caTrusted
        ? "Subject: CN=FluxProxy Local Debugging Root CA, O=FluxProxy Web Debugger\nSHA-256: 8F:4B:1C:92:A7:03:E1:55..."
        : "Без установки Root CA в хранилище ОС браузеры отклоняют HTTPS MITM-соединения.",
      canAutoFix: !caTrusted,
      fixLabel: caTrusted ? null : "Установить Root CA в ОС",
    },
    {
      id: "system_proxy_sync",
      title: "Синхронизация системного прокси ОС",
      status: status.systemProxyError
        ? "error"
        : status.running && status.systemProxyEnabled
          ? "ok"
          : !status.running && status.systemProxyEnabled
            ? "error"
            : "warning",
      summary: status.systemProxyError
        ? `Системный прокси не синхронизирован с ${expectedSysproxyEndpoint}`
        : status.running && status.systemProxyEnabled
          ? `Системный прокси ОС активен и указывает на ${expectedSysproxyEndpoint}`
          : "Системный прокси ОС отключён (режим Port Only)",
      details: status.systemProxyError
        ? `${status.systemProxyError}. Нажмите «Восстановить системный прокси» для переподключения.`
        : `Ожидаемый адрес системного прокси: ${expectedSysproxyEndpoint} (autoSystemProxy: ${
            status.autoSystemProxy ? "вкл" : "выкл"
          }).`,
      canAutoFix: !(status.running && status.systemProxyEnabled && !status.systemProxyError),
      fixLabel:
        status.running && status.systemProxyEnabled && !status.systemProxyError
          ? null
          : status.systemProxyError
            ? "Восстановить системный прокси"
            : "Включить системный прокси ОС",
    },
    {
      id: "vpn_interface_check",
      title: "Конфликты VPN / TUN / CGNAT маршрутизации",
      status: "warning",
      summary: "Preview: обнаружен виртуальный интерфейс Tailscale (100.101.102.4, CGNAT/VPN)",
      details:
        "VPN-клиенты в режиме TUN могут перехватывать системный прокси или сбрасывать WinINet ProxyServer. В нативном Tauri-режиме проверяются реальные адаптеры ОС.",
      canAutoFix: false,
      fixLabel: null,
    },
    {
      id: "firewall_check",
      title: "Брандмауэр и доступность порта",
      status: lanExposed ? "warning" : "ok",
      summary: lanExposed
        ? `LAN-режим активен (порт ${status.port}); проверьте входящее правило брандмауэра`
        : `Loopback-режим (127.0.0.1:${status.port}) защищён от внешней блокировки`,
      details: lanExposed
        ? `При необходимости выполните: netsh advfirewall firewall add rule name="FluxProxy" dir=in action=allow protocol=TCP localport=${status.port}`
        : "Локальный трафик 127.0.0.1 не блокируется внешним брандмауэром.",
      canAutoFix: false,
      fixLabel: null,
    },
    {
      id: "loopback_e2e",
      title: "End-to-End loopback-маршрутизация (/health)",
      status: status.running ? "ok" : "error",
      summary: status.running
        ? "GET http://flux.proxy/health → HTTP 200 (1 мс)"
        : `Прокси остановлен — сокет ${expectedSysproxyEndpoint} не прослушивается`,
      details: status.running
        ? 'Ответ {"status":"ok"} подтверждён (симуляция Browser Preview; без записи в TrafficStore).'
        : "Запустите прокси-листенер, чтобы проверить прохождение трафика через локальный сокет.",
      canAutoFix: !status.running,
      fixLabel: status.running ? null : "Запустить листенер прокси",
    },
  ];
}
