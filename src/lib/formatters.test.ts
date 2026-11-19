import { describe, expect, it } from "vitest";
import type { SessionDetail, SessionSummary } from "../types/proxy";
import {
  buildCurlCommand,
  buildFullRawHttpMessage,
  buildHeadersBlock,
  buildRawHttpRequest,
  buildRawHttpResponse,
  decodeBase64ToBytes,
  encodeTextToBase64,
  extensionFromMimeType,
  formatBytes,
  formatDuration,
  getRowSemanticTone,
  parseCookies,
  parseQueryParams,
  statusReasonPhrase,
  suggestSessionBodyFileName,
  tryFormatJson,
} from "./formatters";

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    status: 200,
    protocol: "HTTPS/1.1",
    scheme: "https",
    method: "GET",
    host: "api.example.com",
    path: "/v1/users",
    url: "https://api.example.com/v1/users",
    contentType: "application/json",
    bodySize: 128,
    durationMs: 42,
    timestamp: "2026-11-19T10:00:00.000Z",
    isMocked: false,
    ...overrides,
  };
}

function makeDetail(
  summaryOverrides: Partial<SessionSummary> = {},
  detailOverrides: Partial<Omit<SessionDetail, "summary">> = {}
): SessionDetail {
  return {
    summary: makeSummary(summaryOverrides),
    requestHeaders: [{ name: "Accept", value: "application/json" }],
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    requestBodyBase64: "",
    responseBodyBase64: "",
    requestBodyText: null,
    responseBodyText: null,
    clientAddr: "127.0.0.1:50000",
    websocketFrames: [],
    ...detailOverrides,
  };
}

describe("formatters — Base64, byte/duration formatting & semantic tones", () => {
  it("decodeBase64ToBytes handles empty, ASCII, Unicode, binary, and invalid strings safely", () => {
    expect(decodeBase64ToBytes("")).toEqual(new Uint8Array(0));
    expect(decodeBase64ToBytes("!!!invalid-base64!!!")).toEqual(
      new Uint8Array(0)
    );

    const text = "FluxProxy Тест 🚀";
    const encoded = encodeTextToBase64(text);
    const decodedBytes = decodeBase64ToBytes(encoded);
    expect(new TextDecoder().decode(decodedBytes)).toBe(text);

    // Raw binary bytes [0x00, 0xFF, 0x7F, 0x80]
    expect(decodeBase64ToBytes("AP9/gA==")).toEqual(
      new Uint8Array([0x00, 0xff, 0x7f, 0x80])
    );
  });

  it("formats byte sizes and durations at exact boundaries", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB");

    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1000)).toBe("1.00 s");
    expect(formatDuration(1550)).toBe("1.55 s");
  });

  it("classifies session semantic row tones accurately", () => {
    expect(
      getRowSemanticTone(
        makeSummary({ status: 0, error: null, tlsBypassed: false })
      )
    ).toBe("default");
    expect(getRowSemanticTone(makeSummary({ status: 500 }))).toBe("error");
    expect(
      getRowSemanticTone(makeSummary({ status: 200, error: "TLS failure" }))
    ).toBe("error");
    expect(getRowSemanticTone(makeSummary({ status: 101 }))).toBe("ws");
    expect(getRowSemanticTone(makeSummary({ scheme: "wss" }))).toBe("ws");
    expect(
      getRowSemanticTone(makeSummary({ contentType: "text/event-stream" }))
    ).toBe("sse");
    expect(getRowSemanticTone(makeSummary({ contentType: "image/png" }))).toBe(
      "image"
    );
    expect(
      getRowSemanticTone(
        makeSummary({ contentType: "text/plain", path: "/api/items" })
      )
    ).toBe("json");
    expect(
      getRowSemanticTone(
        makeSummary({
          status: 302,
          contentType: "text/html",
          path: "/redirect",
        })
      )
    ).toBe("redirect");
    expect(
      getRowSemanticTone(
        makeSummary({
          status: 200,
          contentType: "text/html",
          path: "/index.html",
        })
      )
    ).toBe("default");
  });
});

describe("formatters — buildCurlCommand POSIX shell escaping", () => {
  it("escapes single quotes and isolates shell metacharacters across URL, headers, and body", () => {
    const detail = makeDetail(
      {
        method: "post",
        url: "https://api.example.com/v1/items?q=O'Reilly&cmd=$(whoami)",
      },
      {
        requestHeaders: [
          { name: "Host", value: "api.example.com" },
          { name: "Content-Length", value: "999" },
          { name: "X-Custom", value: "it's `id` && $HOME" },
          { name: "Authorization", value: "Bearer tok'en" },
        ],
        requestBodyText: `{"note":"'; rm -rf /; '","sub":"$(cat /etc/passwd)"}`,
      }
    );

    const cmd = buildCurlCommand(detail);
    expect(cmd).toContain("-X \\\n  'POST'");
    expect(cmd).toContain(
      "'https://api.example.com/v1/items?q=O'\\''Reilly&cmd=$(whoami)'"
    );
    expect(cmd).toContain("-H \\\n  'X-Custom: it'\\''s `id` && $HOME'");
    expect(cmd).toContain("-H \\\n  'Authorization: Bearer tok'\\''en'");
    expect(cmd).toContain(
      `--data-raw \\\n  '{"note":"'\\''; rm -rf /; '\\''","sub":"$(cat /etc/passwd)"}'`
    );
    // Host and Content-Length must be omitted
    expect(cmd).not.toContain("Host:");
    expect(cmd).not.toContain("Content-Length:");
  });

  it("omits --data-raw for GET and HEAD even if requestBodyText is present", () => {
    const getCmd = buildCurlCommand(
      makeDetail({ method: "GET" }, { requestBodyText: "ignored" })
    );
    expect(getCmd).not.toContain("--data-raw");

    const headCmd = buildCurlCommand(
      makeDetail({ method: "head" }, { requestBodyText: "ignored" })
    );
    expect(headCmd).not.toContain("--data-raw");
  });
});

describe("formatters — query, cookies, raw HTTP messages & MIME extensions", () => {
  it("parses query parameters from full URLs and fallback relative URLs", () => {
    expect(
      parseQueryParams("https://api.test/search?q=hello+world&tag=a&tag=b")
    ).toEqual([
      { name: "q", value: "hello world" },
      { name: "tag", value: "a" },
      { name: "tag", value: "b" },
    ]);
    expect(parseQueryParams("/relative/path?foo=bar&empty")).toEqual([
      { name: "foo", value: "bar" },
      { name: "empty", value: "" },
    ]);
    expect(parseQueryParams("/no-query")).toEqual([]);
  });

  it("parses request Cookie and response Set-Cookie headers", () => {
    expect(
      parseCookies(
        [{ name: "Cookie", value: "sid=abc=123; theme=dark; flagOnly" }],
        false
      )
    ).toEqual([
      { name: "sid", value: "abc=123", attributes: "Request Cookie" },
      { name: "theme", value: "dark", attributes: "Request Cookie" },
      { name: "flagOnly", value: "", attributes: "Request Cookie" },
    ]);

    expect(
      parseCookies(
        [
          {
            name: "Set-Cookie",
            value: "session=xyz; Path=/; HttpOnly; Secure",
          },
          { name: "Set-Cookie", value: "bare=1" },
        ],
        true
      )
    ).toEqual([
      { name: "session", value: "xyz", attributes: "Path=/; HttpOnly; Secure" },
      { name: "bare", value: "1", attributes: "Path=/" },
    ]);
  });

  it("formats JSON and builds raw HTTP/1.1 & HTTP/2 request/response blocks", () => {
    expect(tryFormatJson('{"b":2,"a":1}')).toEqual({
      formatted: '{\n  "b": 2,\n  "a": 1\n}',
      valid: true,
    });
    expect(tryFormatJson("{bad")).toEqual({ formatted: "{bad", valid: false });
    expect(tryFormatJson("   ")).toEqual({ formatted: "", valid: false });

    const inFlight = makeDetail({ status: 0, error: null, tlsBypassed: false });
    expect(buildRawHttpResponse(inFlight)).toContain(
      "Waiting for upstream response"
    );

    const h2Detail = makeDetail(
      {
        protocol: "HTTP/2",
        method: "POST",
        status: 201,
        path: "/v1/orders",
      },
      {
        requestHeaders: [
          { name: "Host", value: "api.example.com" },
          { name: "Content-Type", value: "application/json" },
        ],
        requestBodyBase64: "AP9/gA==", // invalid UTF-8 binary
        responseBodyBase64: encodeTextToBase64('{"id":7}'),
      }
    );

    const rawReq = buildRawHttpRequest(h2Detail);
    expect(rawReq).toContain("POST /v1/orders HTTP/2\r\n");
    expect(rawReq.match(/^Host:/gm)).toHaveLength(1);
    expect(rawReq).toContain("[Binary payload (4 B) — view in Hex tab]");

    const rawResp = buildRawHttpResponse(h2Detail);
    expect(rawResp).toContain("HTTP/2 201 Created\r\n");
    expect(rawResp).toContain('{"id":7}');

    expect(buildHeadersBlock(h2Detail, "request")).toContain(
      "POST /v1/orders HTTP/2\nHost: api.example.com"
    );
    expect(buildHeadersBlock(h2Detail, "response")).toContain(
      "HTTP/2 201 Created"
    );
    expect(buildFullRawHttpMessage(h2Detail)).toContain("\r\n\r\nHTTP/2 201");
    expect(statusReasonPhrase(418)).toBe("Response");
  });

  it("maps MIME types to file extensions and suggests body filenames", () => {
    expect(extensionFromMimeType("application/problem+json; charset=utf-8")).toBe(
      "json"
    );
    expect(extensionFromMimeType("image/svg+xml")).toBe("svg");
    expect(extensionFromMimeType("application/atom+xml")).toBe("xml");
    expect(extensionFromMimeType("text/event-stream")).toBe("txt");
    expect(extensionFromMimeType("application/unknown", "dat")).toBe("dat");

    expect(suggestSessionBodyFileName(42, true, "image/webp")).toEqual({
      fileName: "response_42.webp",
      ext: "webp",
    });
    expect(suggestSessionBodyFileName(42, false, null)).toEqual({
      fileName: "request_42.bin",
      ext: "bin",
    });
  });
});
