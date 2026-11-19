import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  browserPreviewCodecTransform,
  bytesToBase64,
  bytesToHex,
  convertTimestampInput,
  createSampleJwtToken,
  decodeBase64Text,
  encodeBase64Text,
  formatSecondsSpan,
  hexToBytes,
  hexToText,
  inspectJwt,
  textToHex,
  urlDecodeText,
  urlEncodeText,
} from "./textWizard";

describe("textWizard — Base64 / Base64URL & Hex codecs", () => {
  it("roundtrips UTF-8 text through standard and URL-safe Base64", () => {
    const sample = "Привет, FluxProxy! 🚀 key=a+b/c?d=1";
    const std = encodeBase64Text(sample, false);
    const urlSafe = encodeBase64Text(sample, true);

    expect(urlSafe).not.toMatch(/[+/=]/);
    expect(decodeBase64Text(std)).toEqual({
      text: sample,
      byteLength: new TextEncoder().encode(sample).length,
      isUtf8: true,
    });

    // Simulate whitespace and missing padding in URL-safe input
    const spaced = `  ${urlSafe.slice(0, 8)}\n  ${urlSafe.slice(8)}  `;
    expect(decodeBase64Text(spaced).text).toBe(sample);
  });

  it("handles empty Base64 and non-UTF-8 binary bytes cleanly", () => {
    expect(base64ToBytes("   \n\t  ")).toEqual(new Uint8Array(0));
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xab]);
    const b64 = bytesToBase64(binary);
    const decoded = decodeBase64Text(b64);

    expect(decoded.isUtf8).toBe(false);
    expect(decoded.byteLength).toBe(5);
    expect(decoded.text).toBe("FF FE 00 80 AB");
  });

  it("parses Hex with 0x prefix and delimiters, and rejects malformed Hex", () => {
    expect(hexToBytes("")).toEqual(new Uint8Array(0));
    expect(hexToBytes("0x48:65-6c, 6c;6f")).toEqual(
      new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f])
    );
    expect(bytesToHex(new Uint8Array([0x0a, 0xff]), ":")).toBe("0A:FF");
    expect(textToHex("Hi", "")).toBe("4869");
    expect(hexToText("D0 9F D1 80 D0 B8 D0 B2 D0 B5 D1 82")).toEqual({
      text: "Привет",
      byteLength: 12,
      isUtf8: true,
    });
    expect(hexToText("FF 00 FE").isUtf8).toBe(false);

    expect(() => hexToBytes("ABC")).toThrow();
    expect(() => hexToBytes("ZZZZ")).toThrow();
  });

  it("encodes and decodes URLs and extracts query parameters", () => {
    const raw = "https://example.com/search?q=hello world&tag=a&b";
    expect(urlEncodeText("a b+c&d=1", false)).toBe("a%20b%2Bc%26d%3D1");
    expect(urlEncodeText(raw, true)).toBe(
      "https://example.com/search?q=hello%20world&tag=a&b"
    );

    const decoded = urlDecodeText("https://api.test/items?q=hello+world&page=2");
    expect(decoded.decoded).toBe("https://api.test/items?q=hello world&page=2");
    expect(decoded.params).toEqual([
      { name: "q", value: "hello world" },
      { name: "page", value: "2" },
    ]);
  });

  it("formats seconds spans across seconds, minutes, hours, and days", () => {
    expect(formatSecondsSpan(0)).toMatch(/0/);
    expect(formatSecondsSpan(-45)).toMatch(/45/);
    expect(formatSecondsSpan(125)).toMatch(/2.*5/);
    expect(formatSecondsSpan(3661)).toMatch(/1.*1.*1/);
    expect(formatSecondsSpan(90060)).toMatch(/1.*1.*1/);
  });
});

describe("textWizard — inspectJwt (including null payloads & edge cases)", () => {
  const fixedNowSec = 1_760_000_000;
  const fixedNowMs = fixedNowSec * 1000;

  function makeJwt(header: unknown, payload: unknown, sig = "c2ln"): string {
    const h = encodeBase64Text(JSON.stringify(header), true);
    const p = encodeBase64Text(JSON.stringify(payload), true);
    return sig ? `${h}.${p}.${sig}` : `${h}.${p}.`;
  }

  it("rejects empty, non-3-segment, and non-JSON tokens", () => {
    expect(inspectJwt("   ", fixedNowMs).validFormat).toBe(false);
    expect(inspectJwt("only-one-part", fixedNowMs).status).toBe("invalid");
    expect(inspectJwt("a.b.c.d", fixedNowMs).status).toBe("invalid");
    expect(inspectJwt("!!!.!!!.sig", fixedNowMs).validFormat).toBe(false);
  });

  it("rejects JWT where header or payload decodes to JSON null, array, or primitive", () => {
    const nullHeader = makeJwt(null, { sub: "user-1" });
    const nullHeaderRes = inspectJwt(nullHeader, fixedNowMs);
    expect(nullHeaderRes.validFormat).toBe(false);
    expect(nullHeaderRes.status).toBe("invalid");
    expect(nullHeaderRes.headerObj).toBeNull();
    expect(nullHeaderRes.claimsObj).toBeNull();

    const nullPayload = makeJwt({ alg: "RS256", typ: "JWT" }, null);
    const nullPayloadRes = inspectJwt(nullPayload, fixedNowMs);
    expect(nullPayloadRes.validFormat).toBe(false);
    expect(nullPayloadRes.status).toBe("invalid");
    expect(nullPayloadRes.claimsObj).toBeNull();
    expect(nullPayloadRes.error).toContain("JSON-объектом");

    const arrayPayload = makeJwt({ alg: "HS256" }, [1, 2, 3]);
    expect(inspectJwt(arrayPayload, fixedNowMs).validFormat).toBe(false);

    const primitiveHeader = makeJwt("HS256", { sub: "u1" });
    expect(inspectJwt(primitiveHeader, fixedNowMs).validFormat).toBe(false);
  });

  it("handles null claim field values safely without crashing", () => {
    const token = makeJwt(
      { alg: "RS256", typ: "JWT", kid: null },
      {
        iss: null,
        sub: "usr_null_claims",
        aud: null,
        iat: null,
        nbf: null,
        exp: null,
      }
    );

    const res = inspectJwt(token, fixedNowMs);
    expect(res.validFormat).toBe(true);
    expect(res.status).toBe("no_exp");
    expect(res.keyId).toBeUndefined();
    expect(res.claimsObj?.exp).toBeNull();
    expect(res.annotations.find((a) => a.key === "exp")?.formattedValue).toBe(
      "null"
    );
    expect(res.annotations.find((a) => a.key === "iss")?.formattedValue).toBe(
      "null"
    );
  });

  it("strips Authorization: Bearer prefix and evaluates valid, expired, not_yet_valid, and warnings", () => {
    const validTok = makeJwt(
      { alg: "ES256", typ: "JWT", kid: "k1" },
      {
        iss: "https://auth.test",
        sub: "u1",
        iat: fixedNowSec - 60,
        nbf: fixedNowSec - 60,
        exp: fixedNowSec + 600,
      }
    );
    const validRes = inspectJwt(`Authorization: Bearer ${validTok}`, fixedNowMs);
    expect(validRes.validFormat).toBe(true);
    expect(validRes.status).toBe("valid");
    expect(validRes.algorithm).toBe("ES256");
    expect(validRes.keyId).toBe("k1");
    expect(validRes.warnings).toHaveLength(0);

    const expiredTok = makeJwt(
      { alg: "HS256", typ: "JWT" },
      {
        sub: "u1",
        iat: fixedNowSec - 1000,
        exp: fixedNowSec - 30,
      }
    );
    const expiredRes = inspectJwt(expiredTok, fixedNowMs);
    expect(expiredRes.status).toBe("expired");
    expect(expiredRes.warnings.some((w) => w.includes("HS256"))).toBe(true);
    expect(expiredRes.warnings.some((w) => w.includes("401"))).toBe(true);

    const futureTok = makeJwt(
      { alg: "none" },
      {
        sub: "u1",
        nbf: fixedNowSec + 300,
        exp: fixedNowSec + 900,
      },
      ""
    );
    const futureRes = inspectJwt(futureTok, fixedNowMs);
    expect(futureRes.status).toBe("not_yet_valid");
    expect(
      futureRes.warnings.some((w) => w.includes('alg="none"'))
    ).toBe(true);

    const longLivedTok = makeJwt(
      { alg: "RS256" },
      {
        iat: fixedNowSec,
        exp: fixedNowSec + 45 * 86400,
      }
    );
    expect(
      inspectJwt(longLivedTok, fixedNowMs).warnings.some((w) =>
        w.includes("30 дней")
      )
    ).toBe(true);
  });

  it("generates valid and expired sample JWT tokens", () => {
    expect(inspectJwt(createSampleJwtToken(false)).status).toBe("valid");
    expect(inspectJwt(createSampleJwtToken(true)).status).toBe("expired");
  });
});

describe("textWizard — convertTimestampInput & browserPreviewCodecTransform", () => {
  it("converts Unix seconds, ms, us, ns, ISO 8601, and RFC 2822 dates", () => {
    const nowMs = 1_700_000_000_000;

    const secRes = convertTimestampInput("1700000000", nowMs);
    expect(secRes.valid).toBe(true);
    expect(secRes.detectedUnit).toContain("Seconds");
    expect(secRes.epochMillis).toBe(1_700_000_000_000);
    expect(secRes.isoUtc).toBe("2023-11-14T22:13:20.000Z");

    expect(convertTimestampInput("1700000000000", nowMs).detectedUnit).toContain(
      "Milliseconds"
    );
    expect(
      convertTimestampInput("1700000000000000", nowMs).detectedUnit
    ).toContain("Microseconds");
    expect(
      convertTimestampInput("1700000000000000000", nowMs).detectedUnit
    ).toContain("Nanoseconds");

    const isoRes = convertTimestampInput("2023-11-14T22:13:20.000Z", nowMs);
    expect(isoRes.valid).toBe(true);
    expect(isoRes.epochSeconds).toBe(1_700_000_000);
    expect(isoRes.detectedUnit).toContain("ISO 8601");

    const gmtRes = convertTimestampInput(
      "Tue, 14 Nov 2023 22:13:20 GMT",
      nowMs
    );
    expect(gmtRes.valid).toBe(true);
    expect(gmtRes.detectedUnit).toContain("HTTP-Date");

    expect(convertTimestampInput("", nowMs).valid).toBe(false);
    expect(convertTimestampInput("not-a-timestamp", nowMs).valid).toBe(false);
  });

  it("roundtrips Brotli and Zstandard fallback codecs and validates invalid streams", async () => {
    const sample = '{"service":"FluxProxy","unicode":"Тест 🚀"}';

    const brComp = await browserPreviewCodecTransform("brotliCompress", sample);
    const brDecomp = await browserPreviewCodecTransform(
      "brotliDecompress",
      brComp.outputBase64
    );
    expect(brDecomp.outputText).toBe(sample);

    const brEmptyComp = await browserPreviewCodecTransform("brotliCompress", "");
    const brEmptyDecomp = await browserPreviewCodecTransform(
      "brotliDecompress",
      brEmptyComp.outputBase64
    );
    expect(brEmptyDecomp.outputBytes).toBe(0);

    const zstdComp = await browserPreviewCodecTransform("zstdCompress", sample);
    const zstdDecomp = await browserPreviewCodecTransform(
      "zstdDecompress",
      zstdComp.outputBase64
    );
    expect(zstdDecomp.outputText).toBe(sample);

    const zstdEmpty = await browserPreviewCodecTransform("zstdCompress", "");
    const zstdEmptyDecomp = await browserPreviewCodecTransform(
      "zstdDecompress",
      zstdEmpty.outputBase64
    );
    expect(zstdEmptyDecomp.outputBytes).toBe(0);

    await expect(
      browserPreviewCodecTransform("zstdDecompress", encodeBase64Text("bad"))
    ).rejects.toThrow();

    if (typeof CompressionStream !== "undefined") {
      const gzComp = await browserPreviewCodecTransform("gzipCompress", sample);
      const gzDecomp = await browserPreviewCodecTransform(
        "gzipDecompress",
        gzComp.outputBase64
      );
      expect(gzDecomp.outputText).toBe(sample);

      const dfComp = await browserPreviewCodecTransform("deflateCompress", sample);
      const dfDecomp = await browserPreviewCodecTransform(
        "deflateDecompress",
        dfComp.outputBase64
      );
      expect(dfDecomp.outputText).toBe(sample);
    }
  });
});
