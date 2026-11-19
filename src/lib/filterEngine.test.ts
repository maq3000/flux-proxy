import { describe, expect, it } from "vitest";
import type {
  FilterConditionRule,
  ProxyFilterBackendConfig,
  SessionSummary,
  TlsBypassRule,
} from "../types/proxy";
import {
  DEFAULT_BACKEND_FILTER_CONFIG,
  DEFAULT_NOISE_THRESHOLDS,
  applyHeaderMutationsInPreview,
  compileFilterMatrix,
  compileHostListFilter,
  evaluateSessionAgainstFilters,
  evaluateShouldStoreSessionInPreview,
  evaluateTlsConnectInPreview,
  extractParentWildcardDomain,
  isBackgroundOsNoiseSession,
  matchHostRuleList,
  matchesCompiledHostList,
  normalizeHostToken,
  parseBulkTextToTlsRules,
  parseThresholdNumber,
  tlsRulesToBulkText,
  tokenizeHostListInput,
} from "./filterEngine";

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    status: 200,
    protocol: "HTTPS/1.1",
    scheme: "https",
    method: "GET",
    host: "api.example.com",
    path: "/v1/orders",
    url: "https://api.example.com/v1/orders",
    contentType: "application/json",
    bodySize: 512,
    durationMs: 85,
    timestamp: "2026-11-19T12:00:00.000Z",
    isMocked: false,
    ...overrides,
  };
}

describe("filterEngine — matrix compilation, thresholds & DNF evaluation", () => {
  it("parses human byte and duration literals", () => {
    expect(parseThresholdNumber("1.5MB", "bodySize")).toBe(1572864);
    expect(parseThresholdNumber("500KB", "bodySize")).toBe(512000);
    expect(parseThresholdNumber("1 GB", "bodySize")).toBe(1024 * 1024 * 1024);
    expect(parseThresholdNumber("2s", "durationMs")).toBe(2000);
    expect(parseThresholdNumber("500ms", "durationMs")).toBe(500);
    expect(parseThresholdNumber("404", "status")).toBe(404);
    expect(parseThresholdNumber("abc", "status")).toBeNull();
  });

  it("evaluates DNF include/exclude groups, invalid RegExp reporting, and in-flight deferral", () => {
    const rules: FilterConditionRule[] = [
      {
        id: "r1",
        enabled: true,
        action: "include",
        logicalOp: "OR",
        field: "host",
        operator: "endsWith",
        value: "example.com",
      },
      {
        id: "r2",
        enabled: true,
        action: "include",
        logicalOp: "AND",
        field: "status",
        operator: "gte",
        value: "500",
      },
      {
        id: "r3",
        enabled: true,
        action: "include",
        logicalOp: "OR",
        field: "method",
        operator: "equals",
        value: "POST",
      },
      {
        id: "r4",
        enabled: true,
        action: "exclude",
        logicalOp: "OR",
        field: "path",
        operator: "startsWith",
        value: "/health",
      },
      {
        id: "r-bad",
        enabled: true,
        action: "include",
        logicalOp: "OR",
        field: "url",
        operator: "regex",
        value: "[unclosed",
      },
    ];

    const compiled = compileFilterMatrix(rules);
    expect(compiled.ruleErrors["r-bad"]).toBeTruthy();

    // (host endsWith example.com AND status >= 500) OR (method == POST)
    expect(
      evaluateSessionAgainstFilters(
        makeSummary({ host: "api.example.com", status: 503 }),
        compiled,
        true,
        DEFAULT_NOISE_THRESHOLDS
      )
    ).toBe(true);

    expect(
      evaluateSessionAgainstFilters(
        makeSummary({ host: "api.example.com", status: 200, method: "GET" }),
        compiled,
        true,
        DEFAULT_NOISE_THRESHOLDS
      )
    ).toBe(false);

    // Exclude wins over matching POST include
    expect(
      evaluateSessionAgainstFilters(
        makeSummary({ method: "POST", path: "/health/live" }),
        compiled,
        true,
        DEFAULT_NOISE_THRESHOLDS
      )
    ).toBe(false);

    // In-flight pending session (status 0, no error) defers response-dependent checks
    expect(
      evaluateSessionAgainstFilters(
        makeSummary({ host: "api.example.com", status: 0, bodySize: 0 }),
        compiled,
        true,
        { ...DEFAULT_NOISE_THRESHOLDS, minBodySizeBytes: 100 }
      )
    ).toBe(true);
  });

  it("enforces noise thresholds for 304, OPTIONS, CONNECT, static assets, size, and slow requests", () => {
    const emptyCompiled = compileFilterMatrix([]);
    const strictTh = {
      ...DEFAULT_NOISE_THRESHOLDS,
      hide304NotModified: true,
      hideOptionsPreflight: true,
      hideConnectTunnels: true,
      hideStaticAssets: true,
      minBodySizeBytes: 100,
      maxBodySizeBytes: 1000,
      onlySlowRequests: true,
      timeHeatWarningMs: 200,
    };

    expect(
      evaluateSessionAgainstFilters(
        makeSummary({ status: 304, durationMs: 300 }),
        emptyCompiled,
        true,
        strictTh
      )
    ).toBe(false);
    expect(
      evaluateSessionAgainstFilters(
        makeSummary({ method: "OPTIONS", durationMs: 300 }),
        emptyCompiled,
        true,
        strictTh
      )
    ).toBe(false);
    expect(
      evaluateSessionAgainstFilters(
        makeSummary({ method: "CONNECT", durationMs: 300 }),
        emptyCompiled,
        true,
        strictTh
      )
    ).toBe(false);
    expect(
      evaluateSessionAgainstFilters(
        makeSummary({ path: "/app.css?v=1", durationMs: 300 }),
        emptyCompiled,
        true,
        strictTh
      )
    ).toBe(false);
    expect(
      evaluateSessionAgainstFilters(
        makeSummary({ bodySize: 50, durationMs: 300 }),
        emptyCompiled,
        true,
        strictTh
      )
    ).toBe(false);
    expect(
      evaluateSessionAgainstFilters(
        makeSummary({ bodySize: 500, durationMs: 50 }),
        emptyCompiled,
        true,
        strictTh
      )
    ).toBe(false);
    expect(
      evaluateSessionAgainstFilters(
        makeSummary({ bodySize: 500, durationMs: 250 }),
        emptyCompiled,
        true,
        strictTh
      )
    ).toBe(true);
  });
});

describe("filterEngine — bulk host list & TLS bypass evaluation", () => {
  it("tokenizes comments, comma/semicolon lists while preserving regex quantifiers", () => {
    const tokens = tokenizeHostListInput(
      [
        "# full comment",
        "// another comment",
        "api.example.com, *.stripe.com; localhost:3000 # trailing",
        "regex:^https://v[0-9]{1,3}\\.example\\.com/api",
      ].join("\n")
    );

    expect(tokens.map((t) => t.token)).toEqual([
      "api.example.com",
      "*.stripe.com",
      "localhost:3000",
      "regex:^https://v[0-9]{1,3}\\.example\\.com/api",
    ]);
  });

  it("compiles host lists and matches exact, wildcard subdomains, ports, paths, and regex", () => {
    const compiled = compileHostListFilter({
      enabled: true,
      mode: "whitelist",
      rawText: [
        "*.example.com",
        "localhost:8080",
        "https://auth.partner.io/oauth",
        "/graphql",
        "regex:^https://edge-[0-9]+\\.cdn\\.net",
        "regex:[broken",
      ].join("\n"),
    });

    expect(compiled.errors).toHaveLength(1);
    expect(matchesCompiledHostList(makeSummary({ host: "example.com" }), compiled)).toBe(true);
    expect(matchesCompiledHostList(makeSummary({ host: "sub.example.com" }), compiled)).toBe(true);
    expect(matchesCompiledHostList(makeSummary({ host: "evil-example.com" }), compiled)).toBe(false);
    expect(
      matchesCompiledHostList(
        makeSummary({
          host: "localhost",
          url: "http://localhost:8080/ping",
          scheme: "http",
        }),
        compiled
      )
    ).toBe(true);
    expect(
      matchesCompiledHostList(
        makeSummary({
          host: "auth.partner.io",
          path: "/oauth/token",
          url: "https://auth.partner.io/oauth/token",
        }),
        compiled
      )
    ).toBe(true);
    expect(
      matchesCompiledHostList(
        makeSummary({
          host: "other.io",
          path: "/graphql?op=1",
          url: "https://other.io/graphql?op=1",
        }),
        compiled
      )
    ).toBe(true);
    expect(
      matchesCompiledHostList(
        makeSummary({
          host: "edge-12.cdn.net",
          url: "https://edge-12.cdn.net/a.js",
        }),
        compiled
      )
    ).toBe(true);
  });

  it("evaluates TLS CONNECT decisions with negative carve-outs, targetedOnly, and hostListSync", () => {
    expect(normalizeHostToken("!https://api.apple.com/v1")).toEqual({
      negated: true,
      token: "api.apple.com",
    });

    const rules: TlsBypassRule[] = [
      {
        id: "carve",
        enabled: true,
        pattern: "!api.apple.com",
        category: "Override",
        description: "Inspect api.apple.com",
      },
      {
        id: "apple",
        enabled: true,
        pattern: "*.apple.com",
        category: "OS",
        description: "Apple pinning",
      },
    ];
    expect(matchHostRuleList(rules, "api.apple.com", 443)).toBeNull();
    expect(matchHostRuleList(rules, "icloud.apple.com", 443)?.id).toBe("apple");

    const cfg: ProxyFilterBackendConfig = {
      ...structuredClone(DEFAULT_BACKEND_FILTER_CONFIG),
      tlsBypassRules: rules,
      tlsTargetRules: [
        {
          id: "t1",
          enabled: true,
          pattern: "api.target.io",
          category: "Target",
          description: "Target",
        },
      ],
    };

    expect(evaluateTlsConnectInPreview("flux.proxy", 443, cfg).mode).toBe(
      "intercept"
    );
    expect(evaluateTlsConnectInPreview("icloud.apple.com", 443, cfg)).toMatchObject(
      { mode: "passthrough", reason: "bypassRule" }
    );

    const targetedCfg: ProxyFilterBackendConfig = {
      ...cfg,
      tlsInterceptMode: "targetedOnly",
    };
    expect(evaluateTlsConnectInPreview("api.target.io", 443, targetedCfg).mode).toBe(
      "intercept"
    );
    expect(evaluateTlsConnectInPreview("other.io", 443, targetedCfg)).toEqual({
      mode: "passthrough",
      reason: "notInTargetAllowlist",
    });

    const wlCfg: ProxyFilterBackendConfig = {
      ...cfg,
      hostListSync: {
        enabled: true,
        mode: "whitelist",
        rawText: "api.target.io",
      },
    };
    expect(evaluateTlsConnectInPreview("notlisted.io", 443, wlCfg)).toEqual({
      mode: "passthrough",
      reason: "notInHostsWhitelist",
    });
    expect(evaluateTlsConnectInPreview("api.target.io", 443, wlCfg).mode).toBe(
      "intercept"
    );
  });

  it("extracts parent wildcard domains and roundtrips bulk TLS rule text", () => {
    expect(extractParentWildcardDomain("localhost")).toBeNull();
    expect(extractParentWildcardDomain("127.0.0.1:8080")).toBeNull();
    expect(extractParentWildcardDomain("[::1]:443")).toBeNull();
    expect(extractParentWildcardDomain("example.com")).toBe("*.example.com");
    expect(extractParentWildcardDomain("api.staging.example.com")).toBe(
      "*.example.com"
    );
    expect(extractParentWildcardDomain("api.shop.co.uk")).toBe("*.shop.co.uk");

    const existing: TlsBypassRule[] = [
      {
        id: "r-existing",
        enabled: true,
        pattern: "*.apple.com",
        category: "OS",
        description: "Apple",
      },
      {
        id: "r-disabled",
        enabled: false,
        pattern: "pinned.io",
        category: "Custom",
        description: "Disabled rule",
      },
    ];
    const bulk = tlsRulesToBulkText(existing);
    expect(bulk).toContain("*.apple.com # [OS] Apple");
    expect(bulk).toContain("[disabled] pinned.io # [Custom] Disabled rule");

    const parsed = parseBulkTextToTlsRules(`${bulk}\nnew.host.dev`, existing);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].id).toBe("r-existing");
    expect(parsed[1].enabled).toBe(false);
    expect(parsed[2].pattern).toBe("new.host.dev");
  });
});

describe("filterEngine — header mutations, OS noise & capture storage", () => {
  it("strips Alt-Svc by default and applies set/remove/append mutations by URL scope", () => {
    const cfg: ProxyFilterBackendConfig = {
      ...structuredClone(DEFAULT_BACKEND_FILTER_CONFIG),
      headerMutationsEnabled: false,
      stripAltSvc: true,
      headerMutations: [
        {
          id: "m1",
          enabled: true,
          name: "Remove cache",
          direction: "request",
          operation: "remove",
          headerName: "If-None-Match, If-Modified-Since",
          headerValue: "",
          urlPattern: "*.example.com/*",
        },
        {
          id: "m2",
          enabled: true,
          name: "Set custom",
          direction: "request",
          operation: "set",
          headerName: "X-Env",
          headerValue: "staging",
          urlPattern: "regex:/v1/",
        },
        {
          id: "m3",
          enabled: true,
          name: "Append trace",
          direction: "response",
          operation: "append",
          headerName: "X-Trace",
          headerValue: "hop-2",
          urlPattern: "*",
        },
      ],
    };

    const strippedResp = applyHeaderMutationsInPreview(
      "response",
      "https://api.example.com/v1/items",
      [
        { name: "Alt-Svc", value: 'h3=":443"' },
        { name: "Content-Type", value: "application/json" },
      ],
      cfg
    );
    expect(strippedResp.mutated).toBe(true);
    expect(strippedResp.headers).toEqual([
      { name: "Content-Type", value: "application/json" },
    ]);

    const enabledCfg = { ...cfg, headerMutationsEnabled: true, stripAltSvc: false };
    const reqRes = applyHeaderMutationsInPreview(
      "request",
      "https://api.example.com/v1/items",
      [
        { name: "If-None-Match", value: '"1"' },
        { name: "X-Env", value: "prod" },
      ],
      enabledCfg
    );
    expect(reqRes.mutated).toBe(true);
    expect(reqRes.headers).toEqual([{ name: "X-Env", value: "staging" }]);

    const respRes = applyHeaderMutationsInPreview(
      "response",
      "https://api.example.com/v1/items",
      [
        { name: "Alt-Svc", value: 'h3=":443"' },
        { name: "X-Trace", value: "hop-1" },
      ],
      enabledCfg
    );
    expect(respRes.headers).toHaveLength(3);
  });

  it("drops OS background noise during capture unless explicitly whitelisted or included", () => {
    const svchost = makeSummary({
      host: "settings-win.data.microsoft.com",
      processName: "svchost.exe",
    });
    expect(isBackgroundOsNoiseSession(svchost)).toBe(true);

    const dropCfg: ProxyFilterBackendConfig = {
      ...structuredClone(DEFAULT_BACKEND_FILTER_CONFIG),
      dropNonMatchingOnCapture: true,
    };
    expect(evaluateShouldStoreSessionInPreview(svchost, dropCfg)).toBe(false);
    expect(
      evaluateShouldStoreSessionInPreview(
        makeSummary({ host: "flux.proxy" }),
        dropCfg
      )
    ).toBe(true);

    const whitelistedCfg: ProxyFilterBackendConfig = {
      ...dropCfg,
      captureHostList: {
        enabled: true,
        mode: "whitelist",
        rawText: "settings-win.data.microsoft.com",
      },
    };
    expect(evaluateShouldStoreSessionInPreview(svchost, whitelistedCfg)).toBe(
      true
    );

    const jsonCatCfg: ProxyFilterBackendConfig = {
      ...dropCfg,
      quickCategory: "json",
      filterQuery: "orders",
    };
    expect(
      evaluateShouldStoreSessionInPreview(
        makeSummary({ contentType: "application/json", url: "https://api.test/orders" }),
        jsonCatCfg
      )
    ).toBe(true);
    expect(
      evaluateShouldStoreSessionInPreview(
        makeSummary({ contentType: "text/html", path: "/home", url: "https://api.test/home" }),
        jsonCatCfg
      )
    ).toBe(false);
  });
});
