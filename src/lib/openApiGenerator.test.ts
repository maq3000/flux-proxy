import { describe, expect, it } from "vitest";
import type { SessionDetail } from "../types/proxy";
import { encodeTextToBase64 } from "./formatters";
import { encodeBase64Text } from "./textWizard";
import {
  buildOpenApiDocument,
  generateOpenApiSpec,
  inferSchemaFromJsonValue,
  mergeJsonSchemas,
  normalizeEndpointPath,
  serializeOpenApiToYaml,
} from "./openApiGenerator";

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    summary: {
      id: 1,
      status: 200,
      protocol: "HTTP/2",
      scheme: "https",
      method: "GET",
      host: "api.example.com",
      path: "/api/v1/users",
      url: "https://api.example.com/api/v1/users",
      contentType: "application/json",
      bodySize: 64,
      durationMs: 25,
      timestamp: "2026-11-19T12:00:00.000Z",
      isMocked: false,
      ...(overrides.summary ?? {}),
    },
    requestHeaders: overrides.requestHeaders ?? [],
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

describe("openApiGenerator — path normalization & schema inference/merging", () => {
  it("normalizes numeric IDs, UUIDs, ObjectIds, multiple params, and slashes", () => {
    expect(normalizeEndpointPath("/")).toEqual({
      template: "/",
      structuralKey: "/",
      params: [],
    });

    const res = normalizeEndpointPath(
      "//api/v1/users/42/orders/550e8400-e29b-41d4-a716-446655440000/notes/507f1f77bcf86cd799439011//"
    );
    expect(res.template).toBe(
      "/api/v1/users/{id}/orders/{uuid}/notes/{param3}"
    );
    expect(res.structuralKey).toBe("/api/v1/users/{*}/orders/{*}/notes/{*}");
    expect(res.params[0]).toEqual({
      name: "id",
      schema: { type: "integer" },
      sampleValue: 42,
    });
    expect(res.params[1].schema).toEqual({ type: "string", format: "uuid" });
    expect(res.params[2].schema).toEqual({ type: "string" });
  });

  it("infers primitive formats and merges schemas across nullable, numeric, object, and oneOf", () => {
    const inferred = inferSchemaFromJsonValue({
      id: 10,
      email: "user@example.com",
      createdAt: "2026-11-19T12:00:00Z",
      birthDate: "1990-05-01",
      website: "https://example.com",
      uid: "550e8400-e29b-41d4-a716-446655440000",
      tags: ["a", "b"],
      empty: null,
    });

    expect(inferred.properties?.id).toEqual({ type: "integer" });
    expect(inferred.properties?.email).toEqual({ type: "string", format: "email" });
    expect(inferred.properties?.createdAt).toEqual({
      type: "string",
      format: "date-time",
    });
    expect(inferred.properties?.birthDate).toEqual({
      type: "string",
      format: "date",
    });
    expect(inferred.properties?.website).toEqual({ type: "string", format: "uri" });
    expect(inferred.properties?.uid).toEqual({ type: "string", format: "uuid" });
    expect(inferred.properties?.empty).toEqual({ nullable: true });

    const objA = inferSchemaFromJsonValue({ id: 1, name: "A", extraA: true });
    const objB = inferSchemaFromJsonValue({ id: 1.5, name: null, extraB: "x" });
    const merged = mergeJsonSchemas(objA, objB);
    expect(merged.required).toEqual(["id", "name"]);
    expect(merged.properties?.id).toEqual({ type: "number" });
    expect(merged.properties?.name).toEqual({ type: "string", nullable: true });

    const hetero = mergeJsonSchemas({ type: "string" }, { type: "boolean" });
    expect(hetero.oneOf).toEqual([{ type: "boolean" }, { type: "string" }]);
  });
});

describe("openApiGenerator — buildOpenApiDocument & YAML serializer", () => {
  it("skips CONNECT/WS/passthrough, merges endpoints, extracts security, and redacts examples", () => {
    const jwt = `${encodeBase64Text('{"alg":"HS256"}', true)}.${encodeBase64Text(
      '{"sub":"1"}',
      true
    )}.c2lnbmF0dXJl`;

    const sessions: SessionDetail[] = [
      // Should be skipped
      makeSession({
        summary: { ...makeSession().summary, method: "CONNECT" },
      }),
      makeSession({
        summary: { ...makeSession().summary, tlsBypassed: true },
      }),
      makeSession({
        summary: { ...makeSession().summary, scheme: "wss", status: 101 },
      }),
      // Included GET with query params + auth + JSON response
      makeSession({
        summary: {
          ...makeSession().summary,
          id: 10,
          method: "GET",
          path: "/api/v1/users/101?include=roles&include=prefs&token=secret123",
          url: "https://api.example.com/api/v1/users/101?include=roles&include=prefs&token=secret123",
          status: 200,
        },
        requestHeaders: [
          { name: "Authorization", value: `Bearer ${jwt}` },
          { name: "Cookie", value: "theme=dark; session_id=sid-secret" },
          { name: "X-Api-Key", value: "ak_123456" },
        ],
        requestBodyText: "should-be-omitted-on-get",
        responseBodyText: JSON.stringify({
          id: 101,
          password: "my-plain-password",
          note: `Bearer ${jwt}`,
        }),
      }),
      // Same structural path with different ID and 204 response
      makeSession({
        summary: {
          ...makeSession().summary,
          id: 11,
          method: "GET",
          path: "/api/v1/users/202",
          url: "https://api.example.com/api/v1/users/202",
          status: 204,
        },
      }),
      // POST multipart upload
      makeSession({
        summary: {
          ...makeSession().summary,
          id: 12,
          method: "POST",
          path: "/api/v1/uploads",
          url: "https://api.example.com/api/v1/uploads",
          status: 201,
        },
        requestHeaders: [
          { name: "Authorization", value: "Basic dXNlcjpwYXNz" },
          {
            name: "Content-Type",
            value: "multipart/form-data; boundary=bound1",
          },
        ],
        requestBodyText: [
          "--bound1",
          'Content-Disposition: form-data; name="count"',
          "",
          "3",
          "--bound1",
          'Content-Disposition: form-data; name="file"; filename="doc.pdf"',
          "Content-Type: application/pdf",
          "",
          "%PDF-1.4",
          "--bound1--",
        ].join("\r\n"),
        responseBodyBase64: encodeTextToBase64('{"uploaded":true}'),
      }),
    ];

    const result = buildOpenApiDocument(sessions, {
      title: "Users API",
      version: "2.1.0",
      includeExamples: true,
      redactSensitiveExamples: true,
      format: "json",
    });

    expect(result.stats.includedSessions).toBe(3);
    expect(result.stats.skippedSessions).toBe(3);
    expect(result.stats.pathsCount).toBe(2);
    expect(result.stats.operationsCount).toBe(2);
    expect(result.stats.securitySchemes).toEqual([
      "apiKeyAuth",
      "basicAuth",
      "bearerAuth",
      "cookieAuth",
    ]);

    expect(result.spec.components?.securitySchemes?.cookieAuth).toEqual({
      type: "apiKey",
      in: "cookie",
      name: "session_id",
    });

    const getUserOp = result.spec.paths["/api/v1/users/{id}"]?.get;
    expect(getUserOp).toBeDefined();
    expect(getUserOp?.requestBody).toBeUndefined();
    expect(getUserOp?.responses["204"]?.content).toBeUndefined();

    const tokenParam = getUserOp?.parameters?.find((p) => p.name === "token");
    expect(tokenParam?.example).toBe("<REDACTED>");

    const respExample = getUserOp?.responses["200"]?.content?.[
      "application/json"
    ]?.example as Record<string, unknown>;
    expect(respExample.password).toBe("<REDACTED>");
    expect(respExample.note).toBe("Bearer <REDACTED>");

    const postUploadOp = result.spec.paths["/api/v1/uploads"]?.post;
    expect(
      postUploadOp?.requestBody?.content["multipart/form-data"]?.schema
        .properties?.file
    ).toEqual({ type: "string", format: "binary" });

    // Valid JSON output
    const parsedJson = JSON.parse(result.serialized) as { openapi: string };
    expect(parsedJson.openapi).toBe("3.0.3");

    // YAML output includes openapi version and quoted numeric/reserved values
    const yaml = generateOpenApiSpec(sessions, { format: "yaml" });
    expect(yaml).toContain("openapi: 3.0.3");
    expect(yaml).toContain("paths:");
  });

  it("serializes YAML scalars, reserved words, and nested structures deterministically", () => {
    const yaml = serializeOpenApiToYaml({
      flagStr: "true",
      nullStr: "null",
      portStr: "8080",
      colonVal: "http://a: b",
      empty: "",
      emptyArr: [],
      emptyObj: {},
      items: [{ name: "alpha", count: 2 }],
    });

    expect(yaml).toContain('flagStr: "true"');
    expect(yaml).toContain('nullStr: "null"');
    expect(yaml).toContain('portStr: "8080"');
    expect(yaml).toContain('colonVal: "http://a: b"');
    expect(yaml).toContain('empty: ""');
    expect(yaml).toContain("emptyArr: []");
    expect(yaml).toContain("emptyObj: {}");
    expect(yaml).toContain("  - name: alpha");
    expect(yaml).toContain("    count: 2");
  });
});
