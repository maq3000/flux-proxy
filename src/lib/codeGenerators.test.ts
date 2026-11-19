import { describe, expect, it } from "vitest";
import type { ComposedRequest, SessionDetail } from "../types/proxy";
import { encodeTextToBase64 } from "./formatters";
import {
  CODE_GENERATOR_TARGETS,
  CODE_LANGUAGE_GROUPS,
  generateCodeSnippet,
  getCodeGeneratorTarget,
  requestFromComposedRequest,
  requestFromSessionDetail,
  type CodeGenRequest,
  type CodeGeneratorId,
} from "./codeGenerators";

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    summary: {
      id: 7,
      status: 200,
      protocol: "HTTP/2",
      scheme: "https",
      method: "POST",
      host: "api.example.com",
      path: "/v1/orders",
      url: "https://api.example.com/v1/orders",
      contentType: "application/json",
      bodySize: 64,
      durationMs: 35,
      timestamp: "2026-11-19T10:00:00.000Z",
      isMocked: false,
    },
    requestHeaders: [
      { name: ":authority", value: "api.example.com" },
      { name: "Host", value: "api.example.com" },
      { name: "Content-Length", value: "42" },
      { name: "Connection", value: "keep-alive" },
      { name: "Content-Type", value: "application/json" },
      { name: "Cookie", value: "a=1" },
      { name: "Cookie", value: "b=2" },
      { name: "X-Multi", value: "one" },
      { name: "X-Multi", value: "two" },
    ],
    responseHeaders: [],
    requestBodyBase64: "",
    responseBodyBase64: "",
    requestBodyText: '{"ok":true,"count":2,"note":null,"nested":{"flag":false}}',
    responseBodyText: null,
    clientAddr: "127.0.0.1:50000",
    websocketFrames: [],
    ...overrides,
  };
}

describe("codeGenerators — request normalization & target metadata", () => {
  it("exposes 8 generator targets across 5 language groups", () => {
    expect(CODE_GENERATOR_TARGETS).toHaveLength(8);
    expect(CODE_LANGUAGE_GROUPS).toHaveLength(5);
    expect(getCodeGeneratorTarget("rust-reqwest").monacoLanguage).toBe("rust");
  });

  it("normalizes SessionDetail with UTF-8 base64 vs binary base64 payloads", () => {
    const utf8Session = makeSession({
      requestBodyText: null,
      requestBodyBase64: encodeTextToBase64('{"hello":"мир"}'),
    });
    const utf8Req = requestFromSessionDetail(utf8Session);
    expect(utf8Req.isBinaryBody).toBe(false);
    expect(utf8Req.body).toBe('{"hello":"мир"}');

    const binSession = makeSession({
      requestBodyText: null,
      requestBodyBase64: "AP9/gA==",
    });
    const binReq = requestFromSessionDetail(binSession);
    expect(binReq.isBinaryBody).toBe(true);
    expect(binReq.bodyBase64).toBe("AP9/gA==");
  });

  it("normalizes ComposedRequest and filters empty header names", () => {
    const draft: ComposedRequest = {
      method: " post ",
      url: " https://api.test/submit ",
      headers: [
        { name: "  ", value: "ignored" },
        { name: "X-Test", value: "1" },
      ],
      body: "raw-body",
      followRedirects: true,
    };
    const req = requestFromComposedRequest(draft);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.test/submit");
    expect(req.headers).toEqual([{ name: "X-Test", value: "1" }]);
  });
});

describe("codeGenerators — output across all 8 language targets", () => {
  const allTargets: CodeGeneratorId[] = [
    "js-fetch",
    "js-axios",
    "python-requests",
    "python-httpx",
    "go-net-http",
    "rust-reqwest",
    "curl-bash",
    "curl-powershell",
  ];

  it("generates structured JSON snippets, strips ignored headers, and merges duplicate headers", () => {
    const req = requestFromSessionDetail(makeSession());

    const jsFetch = generateCodeSnippet(req, "js-fetch");
    expect(jsFetch).toContain('await fetch("https://api.example.com/v1/orders"');
    expect(jsFetch).toContain('"Cookie": "a=1; b=2"');
    expect(jsFetch).toContain('"X-Multi": "one, two"');
    expect(jsFetch).toContain("body: JSON.stringify(payload)");
    expect(jsFetch).not.toContain(":authority");
    expect(jsFetch).not.toContain("Content-Length");

    const jsAxios = generateCodeSnippet(req, "js-axios");
    expect(jsAxios).toContain("axios.request({");
    expect(jsAxios).toContain("data: payload");

    const pyReq = generateCodeSnippet(req, "python-requests");
    expect(pyReq).toContain('"ok": True');
    expect(pyReq).toContain('"note": None');
    expect(pyReq).toContain('"flag": False');
    expect(pyReq).toContain("json=payload");

    const pyHttpx = generateCodeSnippet(req, "python-httpx");
    expect(pyHttpx).toContain("with httpx.Client(");
    expect(pyHttpx).toContain("json=payload");

    const goCode = generateCodeSnippet(req, "go-net-http");
    expect(goCode).toContain('req.Header.Add("Cookie", "a=1")');
    expect(goCode).toContain('req.Header.Add("Cookie", "b=2")');
    expect(goCode).toContain("strings.NewReader(payload)");

    const rustCode = generateCodeSnippet(req, "rust-reqwest");
    expect(rustCode).toContain("reqwest::Method::POST");
    expect(rustCode).toContain('.header("Cookie", "a=1")');
    expect(rustCode).toContain(".body(");

    const bashCode = generateCodeSnippet(req, "curl-bash");
    expect(bashCode).toContain("curl \\\n  -X \\\n  'POST'");
    expect(bashCode).toContain("--data-raw \\\n  '{\"ok\":true");

    const psCode = generateCodeSnippet(req, "curl-powershell");
    expect(psCode).toContain("curl.exe `\n  -X `\n  'POST'");
    expect(psCode).toContain("--data-raw `\n  '{\"ok\":true");
  });

  it("handles binary payloads (small inline vs large file), custom methods, and injection-safe escaping", () => {
    const smallBinReq: CodeGenRequest = {
      method: "PURGE",
      url: "https://api.test/bin?q=O'Reilly",
      headers: [
        { name: "X-Inject\r\nEvil", value: 'val"$(whoami)`id`\nnext' },
      ],
      body: "",
      bodyBase64: "AP9/gA==",
      isBinaryBody: true,
    };

    for (const target of allTargets) {
      const code = generateCodeSnippet(smallBinReq, target);
      expect(code.length).toBeGreaterThan(20);
      // CRLF injection stripped from headers
      expect(code).not.toContain("X-Inject\r\n");
    }

    const rustSmall = generateCodeSnippet(smallBinReq, "rust-reqwest");
    expect(rustSmall).toContain('reqwest::Method::from_bytes("PURGE".as_bytes())?');
    expect(rustSmall).toContain("vec![0x00, 0xff, 0x7f, 0x80]");

    const largeBytes = new Uint8Array(300).fill(0xab);
    let binStr = "";
    largeBytes.forEach((b) => {
      binStr += String.fromCharCode(b);
    });
    const largeBinReq: CodeGenRequest = {
      ...smallBinReq,
      bodyBase64: btoa(binStr),
    };
    const rustLarge = generateCodeSnippet(largeBinReq, "rust-reqwest");
    expect(rustLarge).toContain('std::fs::read("payload.bin")?');

    const bashControl: CodeGenRequest = {
      method: "POST",
      url: "https://api.test/ctrl",
      headers: [],
      body: "line1\nline2\t'quoted'",
    };
    expect(generateCodeSnippet(bashControl, "curl-bash")).toContain(
      "$'line1\\nline2\\t\\'quoted\\''"
    );
    expect(generateCodeSnippet(bashControl, "curl-powershell")).toContain(
      '"line1`nline2`t\'quoted\'"'
    );
  });

  it("omits request body for GET and HEAD methods", () => {
    const getReq: CodeGenRequest = {
      method: "GET",
      url: "https://api.test/items",
      headers: [{ name: "Content-Type", value: "application/json" }],
      body: '{"ignored":true}',
    };

    expect(generateCodeSnippet(getReq, "js-fetch")).not.toContain("body:");
    expect(generateCodeSnippet(getReq, "python-requests")).not.toContain(
      "json=payload"
    );
    expect(generateCodeSnippet(getReq, "go-net-http")).toContain(", nil)");
    expect(generateCodeSnippet(getReq, "curl-bash")).not.toContain("--data-raw");
  });
});
