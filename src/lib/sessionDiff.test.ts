import { describe, expect, it } from "vitest";
import type { SessionDetail } from "../types/proxy";
import { encodeBase64Text } from "./textWizard";
import { buildSessionDiffBundle, hexToRgba } from "./sessionDiff";

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    summary: {
      id: 1,
      status: 200,
      protocol: "HTTP/2",
      scheme: "https",
      method: "POST",
      host: "api.example.com",
      path: "/v1/orders",
      url: "https://api.example.com/v1/orders",
      contentType: "application/json",
      bodySize: 64,
      durationMs: 30,
      timestamp: "2026-11-19T12:00:00.000Z",
      isMocked: false,
      ...(overrides.summary ?? {}),
    },
    requestHeaders: overrides.requestHeaders ?? [
      { name: "Content-Type", value: "application/json" },
    ],
    responseHeaders: overrides.responseHeaders ?? [
      { name: "Content-Type", value: "application/json" },
    ],
    requestBodyBase64: overrides.requestBodyBase64 ?? "",
    responseBodyBase64: overrides.responseBodyBase64 ?? "",
    requestBodyText: overrides.requestBodyText ?? null,
    responseBodyText: overrides.responseBodyText ?? null,
    clientAddr: "127.0.0.1:50000",
    websocketFrames: [],
  };
}

describe("sessionDiff — hexToRgba & buildSessionDiffBundle", () => {
  it("converts #RGB and #RRGGBB hex colors to rgba() and rejects invalid values", () => {
    expect(hexToRgba("#0f8", 0.25)).toBe("rgba(0, 255, 136, 0.25)");
    expect(hexToRgba("ef4444", 0.5)).toBe("rgba(239, 68, 68, 0.5)");
    expect(hexToRgba(null)).toBeNull();
    expect(hexToRgba("invalid")).toBeNull();
  });

  it("canonicalizes deep JSON keys and filters volatile headers when enabled", () => {
    const left = makeSession({
      requestHeaders: [
        { name: "X-Request-Id", value: "req-1" },
        { name: "X-Custom", value: "abc" },
        { name: "Content-Type", value: "application/json" },
      ],
      responseHeaders: [
        { name: "Date", value: "Thu, 19 Nov 2026 10:00:00 GMT" },
        { name: "ETag", value: '"111"' },
        { name: "X-Server", value: "node-a" },
      ],
      responseBodyText: JSON.stringify({
        b: 2,
        a: { z: true, x: [1, { d: 4, c: 3 }] },
      }),
    });

    const right = makeSession({
      requestHeaders: [
        { name: "Content-Type", value: "application/json" },
        { name: "X-Custom", value: "abc" },
        { name: "X-Request-Id", value: "req-2" },
      ],
      responseHeaders: [
        { name: "X-Server", value: "node-a" },
        { name: "CF-Ray", value: "abc-fra" },
      ],
      responseBodyText: JSON.stringify({
        a: { x: [1, { c: 3, d: 4 }], z: true },
        b: 2,
      }),
    });

    const normalized = buildSessionDiffBundle(left, right, {
      sortKeysAndHeaders: true,
      ignoreVolatileHeaders: true,
    });
    expect(normalized.headers.hasDiff).toBe(false);
    expect(normalized.response.language).toBe("json");
    expect(normalized.response.hasDiff).toBe(false);
    expect(normalized.full.hasDiff).toBe(false);

    const raw = buildSessionDiffBundle(left, right, {
      sortKeysAndHeaders: false,
      ignoreVolatileHeaders: false,
    });
    expect(raw.headers.hasDiff).toBe(true);
    expect(raw.response.hasDiff).toBe(true);
    expect(raw.full.hasDiff).toBe(true);
  });

  it("merges query parameters with JSON request bodies and handles cookies/JWT/binary/XML", () => {
    const jwt = `${encodeBase64Text('{"alg":"HS256","typ":"JWT"}', true)}.${encodeBase64Text(
      JSON.stringify({ sub: "usr_1" }),
      true
    )}.c2ln`;

    const left = makeSession({
      summary: {
        ...makeSession().summary,
        comment: "Baseline",
        url: "https://api.example.com/v1/orders?tag=b&tag=a&page=1",
        path: "/v1/orders?tag=b&tag=a&page=1",
        contentType: "application/xml",
      },
      requestHeaders: [
        { name: "Content-Type", value: "application/json" },
        { name: "Cookie", value: "z=2; a=1" },
        { name: "Authorization", value: `Bearer ${jwt}` },
      ],
      responseHeaders: [
        { name: "Set-Cookie", value: "sid=s1; Path=/; HttpOnly" },
        { name: "WWW-Authenticate", value: 'Bearer realm="orders"' },
      ],
      requestBodyText: '{"amount":100}',
      responseBodyText: "<orders><item>1</item></orders>",
    });

    const right = makeSession({
      summary: {
        ...makeSession().summary,
        url: "https://api.example.com/v1/orders",
        path: "/v1/orders",
        contentType: "application/octet-stream",
      },
      requestHeaders: [
        { name: "Content-Type", value: "application/x-www-form-urlencoded" },
      ],
      requestBodyText: "b=2&a=1",
      responseBodyBase64: "AP9/gA==",
    });

    const bundle = buildSessionDiffBundle(left, right, {
      sortKeysAndHeaders: true,
      ignoreVolatileHeaders: true,
    });

    const parsedLeftReq = JSON.parse(bundle.request.original) as {
      _endpoint: string;
      _queryParams: Record<string, unknown>;
      body: { amount: number };
    };
    expect(parsedLeftReq._endpoint).toBe("POST /v1/orders");
    expect(parsedLeftReq._queryParams.tag).toEqual(["b", "a"]);
    expect(parsedLeftReq.body.amount).toBe(100);
    expect(bundle.request.modified).toBe("a = 1\nb = 2");

    expect(bundle.cookies.original).toContain("a = 1");
    expect(bundle.cookies.original).toContain("sid = s1");
    expect(bundle.cookies.original).toContain("jwt.payload =");
    expect(bundle.cookies.original).toContain("WWW-Authenticate = Bearer");

    expect(bundle.response.original).toBe("<orders><item>1</item></orders>");
    expect(bundle.response.modified).toContain("[Binary payload:");
    expect(bundle.full.original).toContain("# Comment: Baseline");
  });
});
