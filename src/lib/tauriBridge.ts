import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AutoResponderRule,
  BreakpointAction,
  BreakpointConfig,
  BreakpointResolution,
  BreakpointStage,
  CaCertificateInfo,
  CodecOperation,
  CodecTransformResult,
  ComposedRequest,
  LoadedSessionBody,
  NetworkInterfaceInfo,
  PausedBreakpointItem,
  ProxyFilterBackendConfig,
  ProxyStatus,
  SessionDetail,
  SessionSummary,
  StorageStats,
} from "../types/proxy";
import { DEFAULT_SESSION_RETENTION_LIMIT } from "../types/proxy";
import {
  applyHeaderMutationsInPreview,
  DEFAULT_BACKEND_FILTER_CONFIG,
  evaluateShouldStoreSessionInPreview,
  evaluateTlsConnectInPreview,
} from "./filterEngine";
import { encodeTextToBase64 } from "./formatters";
import {
  buildSimulatedSession,
  DEFAULT_AUTORESPONDER_RULES,
} from "./mockTraffic";
import { browserPreviewCodecTransform } from "./textWizard";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const DEFAULT_BREAKPOINT_CONFIG: BreakpointConfig = {
  breakBeforeRequest: false,
  breakAfterResponse: false,
  timeoutSecs: 120,
  rules: [],
};

function matchesBreakpointPattern(pattern: string, url: string): boolean {
  const pat = pattern.trim();
  if (!pat || pat === "*") return true;
  if (pat.startsWith("regex:")) {
    try {
      return new RegExp(pat.slice(6), "i").test(url);
    } catch {
      return false;
    }
  }
  if (pat.includes("*")) {
    const escaped = pat
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    try {
      return new RegExp(`^${escaped}$`, "i").test(url);
    } catch {
      return false;
    }
  }
  return url.toLowerCase().includes(pat.toLowerCase());
}

interface ParkedPreviewEntry {
  item: PausedBreakpointItem;
  resolve: (res: BreakpointResolution) => void;
  timerId: number;
}

// ============================================================================
// Browser Preview Fallback Engine (active when running via `npm run dev` without Tauri)
// ============================================================================
class BrowserPreviewEngine {
  private running = true;
  private bindAddr = "127.0.0.1";
  private allowRemote = false;
  private port = 8888;
  private systemProxyEnabled = true;
  private autoSystemProxy = true;
  private systemProxyError: string | null = null;
  private nextId = 1;
  private nextBpSeq = 1;
  private store = new Map<number, SessionDetail>();
  private sessionRetentionLimit: number | null =
    DEFAULT_SESSION_RETENTION_LIMIT;
  private droppedSessionsCount = 0;
  private evictedSqliteBytes = 0;
  private offloadedBodies = new Map<
    string,
    { bodyBase64: string; bodyText: string | null; bodySize: number }
  >();
  private rules: AutoResponderRule[] = [...DEFAULT_AUTORESPONDER_RULES];
  private filterConfig: ProxyFilterBackendConfig = structuredClone(
    DEFAULT_BACKEND_FILTER_CONFIG
  );
  private breakpointConfig: BreakpointConfig = structuredClone(
    DEFAULT_BREAKPOINT_CONFIG
  );
  private pausedBreakpoints = new Map<string, ParkedPreviewEntry>();
  private listeners = new Set<(batch: SessionSummary[]) => void>();
  private bpListeners = new Set<(items: PausedBreakpointItem[]) => void>();
  private timer: number | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      try {
        const rawAuto = window.localStorage.getItem(
          "fluxproxy.autoSystemProxy.v1"
        );
        if (rawAuto !== null) {
          this.autoSystemProxy = Boolean(JSON.parse(rawAuto));
          this.systemProxyEnabled = this.running && this.autoSystemProxy;
        }
        const rawRemote = window.localStorage.getItem(
          "fluxproxy.allowRemote.v1"
        );
        if (rawRemote !== null) {
          this.allowRemote = Boolean(JSON.parse(rawRemote));
          this.bindAddr = this.allowRemote ? "0.0.0.0" : "127.0.0.1";
        }
        const rawLimit = window.localStorage.getItem(
          "fluxproxy.sessionRetentionLimit.v1"
        );
        if (rawLimit !== null) {
          const parsedLimit = JSON.parse(rawLimit) as number | null;
          if (
            parsedLimit === null ||
            (typeof parsedLimit === "number" &&
              Number.isInteger(parsedLimit) &&
              parsedLimit > 0)
          ) {
            this.sessionRetentionLimit = parsedLimit;
          }
        }
        const rawDrop = window.localStorage.getItem(
          "fluxproxy.dropNonMatching.v1"
        );
        if (rawDrop !== null) {
          this.filterConfig.dropNonMatchingOnCapture = Boolean(
            JSON.parse(rawDrop)
          );
        }
      } catch {
        // ignore storage errors in preview
      }
    }

    // Seed initial realistic sessions immediately
    for (let i = 0; i < 18; i++) {
      const detail = this.applyPipelineToDetail(
        buildSimulatedSession(this.nextId++)
      );
      if (evaluateShouldStoreSessionInPreview(detail.summary, this.filterConfig)) {
        this.insertIntoStoreWithRingBuffer(detail);
      } else {
        this.droppedSessionsCount += 1;
      }
    }
    this.startTicker();
  }

  private insertIntoStoreWithRingBuffer(rawDetail: SessionDetail): SessionDetail {
    const threshold = 2 * 1024 * 1024;
    let detail = rawDetail;

    if (detail.summary.bodySize > threshold && detail.responseBodyBase64) {
      this.offloadedBodies.set(`${detail.summary.id}:resp`, {
        bodyBase64: detail.responseBodyBase64,
        bodyText: detail.responseBodyText ?? null,
        bodySize: detail.summary.bodySize,
      });
      detail = {
        ...detail,
        responseBodyBase64: "",
        responseBodyText: null,
        bodyOffloaded: true,
      };
    }

    this.store.set(detail.summary.id, detail);
    this.enforceRetentionLimit();
    return detail;
  }

  private enforceRetentionLimit() {
    if (
      this.sessionRetentionLimit === null ||
      this.store.size <= this.sessionRetentionLimit
    ) {
      return;
    }
    const sortedIds = Array.from(this.store.keys()).sort((a, b) => a - b);
    const excess = sortedIds.length - this.sessionRetentionLimit;
    for (let i = 0; i < excess; i++) {
      const evicted = this.store.get(sortedIds[i]);
      if (evicted) {
        this.evictedSqliteBytes += Math.max(512, evicted.summary.bodySize);
        this.store.delete(sortedIds[i]);
      }
    }
  }

  private commitCompletedSession(detail: SessionDetail): SessionDetail {
    if (!evaluateShouldStoreSessionInPreview(detail.summary, this.filterConfig)) {
      this.store.delete(detail.summary.id);
      this.droppedSessionsCount += 1;
      return detail;
    }
    const stored = this.insertIntoStoreWithRingBuffer(detail);
    this.emitBatch([stored.summary]);
    return stored;
  }

  private shouldBreak(
    stage: "request" | "response",
    method: string,
    url: string
  ): boolean {
    if (stage === "request" && this.breakpointConfig.breakBeforeRequest) {
      return true;
    }
    if (stage === "response" && this.breakpointConfig.breakAfterResponse) {
      return true;
    }
    for (const rule of this.breakpointConfig.rules) {
      if (!rule.enabled) continue;
      if (rule.stage !== "both" && rule.stage !== stage) continue;
      if (
        rule.methodFilter &&
        rule.methodFilter.trim() &&
        rule.methodFilter.toUpperCase() !== "ANY" &&
        rule.methodFilter.toUpperCase() !== method.toUpperCase()
      ) {
        continue;
      }
      if (matchesBreakpointPattern(rule.urlPattern, url)) {
        return true;
      }
    }
    return false;
  }

  private emitBreakpointsSnapshot() {
    const items = this.listPausedBreakpoints();
    for (const cb of this.bpListeners) {
      cb(items);
    }
  }

  private parkOnBreakpoint(
    draft: Omit<PausedBreakpointItem, "breakpointId" | "createdAt" | "timeoutSecs">
  ): Promise<BreakpointResolution> {
    const breakpointId = `bp-${this.nextBpSeq++}`;
    const timeoutSecs = Math.max(
      5,
      Math.min(600, this.breakpointConfig.timeoutSecs || 120)
    );
    const item: PausedBreakpointItem = {
      ...draft,
      breakpointId,
      createdAt: new Date().toISOString(),
      timeoutSecs,
    };

    return new Promise<BreakpointResolution>((resolve) => {
      const timerId =
        typeof window !== "undefined"
          ? window.setTimeout(() => {
              if (this.pausedBreakpoints.delete(breakpointId)) {
                this.emitBreakpointsSnapshot();
                resolve({
                  breakpointId,
                  action: "continue",
                });
              }
            }, timeoutSecs * 1000)
          : 0;

      this.pausedBreakpoints.set(breakpointId, {
        item,
        resolve,
        timerId,
      });
      this.emitBreakpointsSnapshot();
    });
  }

  private applyPipelineToDetail(rawDetail: SessionDetail): SessionDetail {
    // 1. Check Selective TLS / MITM Pass-Through (`interceptAll` Bypass list vs `targetedOnly` Allowlist)
    if (rawDetail.summary.scheme === "https" || rawDetail.summary.scheme === "wss") {
      const decision = evaluateTlsConnectInPreview(
        rawDetail.summary.host,
        443,
        this.filterConfig
      );
      if (decision.mode === "passthrough") {
        let protocolLabel = "TLS-BYPASS";
        let note: string;
        let modeHeaderValue: string;
        let tlsVersionLabel: string;

        if (decision.reason === "notInTargetAllowlist") {
          protocolLabel = "PASSTHROUGH";
          note = [
            "[Selective MITM Pass-Through Tunnel Active]",
            `Host: ${rawDetail.summary.host}:443`,
            "Mode: Targeted Only (Inspect Allowlist Only)",
            "Reason: Host is outside Target Allowlist — relayed as pure encrypted TCP stream via tokio::io::copy_bidirectional (zero CA substitution, mTLS & Certificate Pinning intact).",
          ].join("\n");
          modeHeaderValue = "Passthrough (Targeted-Only Allowlist Mode)";
          tlsVersionLabel = "Pure TCP Passthrough (Targeted-Only)";
        } else if (decision.reason === "notInHostsWhitelist") {
          protocolLabel = "PASSTHROUGH";
          note = [
            "[Hosts List Whitelist Pass-Through Active]",
            `Host: ${rawDetail.summary.host}:443`,
            "Mode: Bulk Hosts List — Show only (Whitelist) + TLS Passthrough",
            "Reason: Host is not matched by Hosts List Whitelist — relayed as pure encrypted TCP stream via tokio::io::copy_bidirectional.",
          ].join("\n");
          modeHeaderValue = "Passthrough (Hosts List Whitelist)";
          tlsVersionLabel = "Pure TCP Passthrough (Hosts List Whitelist)";
        } else {
          note = [
            "[TLS / MITM Passthrough Tunnel Active]",
            `Host: ${rawDetail.summary.host}:443`,
            `Matched Bypass Rule: ${decision.rule.pattern} (${decision.rule.description})`,
            "Relay Mode: Direct TCP tunnel via tokio::io::copy_bidirectional (no certificate replacement / pinning preserved).",
          ].join("\n");
          modeHeaderValue = `Passthrough (${decision.rule.pattern})`;
          tlsVersionLabel = `SSL Passthrough (${decision.rule.category})`;
        }

        return {
          ...rawDetail,
          summary: {
            ...rawDetail.summary,
            status: 200,
            protocol: protocolLabel,
            method: "CONNECT",
            path: `Tunnel to ${rawDetail.summary.host}:443`,
            url: `https://${rawDetail.summary.host}:443/`,
            contentType: "tls/passthrough",
            tlsBypassed: true,
            isMocked: false,
          },
          requestHeaders: [
            { name: "Host", value: `${rawDetail.summary.host}:443` },
            { name: "Proxy-Connection", value: "keep-alive" },
          ],
          responseHeaders: [
            {
              name: "X-FluxProxy-TLS-Mode",
              value: modeHeaderValue,
            },
          ],
          requestBodyBase64: "",
          requestBodyText: null,
          responseBodyBase64: encodeTextToBase64(note),
          responseBodyText: note,
          tlsVersion: tlsVersionLabel,
        };
      }
    }

    // 2. Apply Lightweight Request Header Mutations
    const reqMut = applyHeaderMutationsInPreview(
      "request",
      rawDetail.summary.url,
      rawDetail.requestHeaders,
      this.filterConfig
    );

    let detail: SessionDetail = {
      ...rawDetail,
      requestHeaders: reqMut.headers,
      summary: {
        ...rawDetail.summary,
        headersMutated: reqMut.mutated,
        clientIp:
          rawDetail.summary.clientIp ??
          (this.allowRemote && rawDetail.summary.id % 4 === 0
            ? "192.168.1.58"
            : "127.0.0.1"),
        processName:
          this.allowRemote && rawDetail.summary.id % 4 === 0
            ? null
            : rawDetail.summary.processName,
        processPid:
          this.allowRemote && rawDetail.summary.id % 4 === 0
            ? null
            : rawDetail.summary.processPid,
      },
    };

    // If conditional request headers (If-Modified-Since / If-None-Match) were stripped on a 304, simulate fresh 200 OK
    const strippedConditional =
      rawDetail.summary.status === 304 &&
      !reqMut.headers.some((h) => {
        const n = h.name.toLowerCase();
        return n === "if-modified-since" || n === "if-none-match";
      });
    if (strippedConditional) {
      const freshBody =
        "// Fresh uncached JS bundle (cache-bypass mutation active)\nexport const bundleVersion = '2026.10';\n";
      detail = {
        ...detail,
        summary: {
          ...detail.summary,
          status: 200,
          bodySize: freshBody.length,
        },
        responseBodyText: freshBody,
        responseBodyBase64: encodeTextToBase64(freshBody),
      };
    }

    // 3. Evaluate AutoResponder Rules
    const matched = this.findMatchingRule(
      detail.summary.method,
      detail.summary.url,
      detail.requestHeaders
    );

    if (matched) {
      detail = {
        ...detail,
        summary: {
          ...detail.summary,
          durationMs: detail.summary.durationMs + matched.latencyMs,
          matchedRuleId: matched.id,
        },
      };

      if (matched.action === "mockResponse") {
        const bytesLen = new TextEncoder().encode(matched.responseBody).length;
        detail.summary = {
          ...detail.summary,
          status: matched.statusCode,
          isMocked: true,
          error: null,
          bodySize: bytesLen,
          contentType:
            matched.responseHeaders.find(
              (h) => h.name.toLowerCase() === "content-type"
            )?.value ?? "application/json; charset=utf-8",
        };
        detail.responseHeaders = [...matched.responseHeaders];
        detail.responseBodyText = matched.responseBody;
        detail.responseBodyBase64 = encodeTextToBase64(matched.responseBody);
      } else if (matched.action === "overrideStatus") {
        detail.summary = {
          ...detail.summary,
          status: matched.statusCode,
          isMocked: true,
        };
      }
    }

    // 4. Apply Lightweight Response Header Mutations
    const respMut = applyHeaderMutationsInPreview(
      "response",
      detail.summary.url,
      detail.responseHeaders,
      this.filterConfig
    );
    detail.responseHeaders = respMut.headers;
    detail.summary.headersMutated = reqMut.mutated || respMut.mutated;

    return detail;
  }

  async simulateLiveSessionFlow(): Promise<SessionDetail> {
    let detail = this.applyPipelineToDetail(
      buildSimulatedSession(this.nextId++)
    );
    const id = detail.summary.id;
    let bpModified = false;

    if (
      !detail.summary.tlsBypassed &&
      detail.summary.scheme !== "wss" &&
      this.shouldBreak("request", detail.summary.method, detail.summary.url)
    ) {
      const pendingReq: SessionDetail = {
        ...detail,
        summary: {
          ...detail.summary,
          status: 0,
          breakpointPaused: "request",
        },
      };
      this.store.set(id, pendingReq);
      this.emitBatch([pendingReq.summary]);

      const verdict = await this.parkOnBreakpoint({
        sessionId: id,
        stage: "request" as BreakpointStage,
        scheme: detail.summary.scheme,
        method: detail.summary.method,
        url: detail.summary.url,
        host: detail.summary.host,
        path: detail.summary.path,
        requestHeaders: detail.requestHeaders,
        requestBodyBase64: detail.requestBodyBase64,
        requestBodyText: detail.requestBodyText,
        responseStatus: null,
        responseHeaders: [],
        responseBodyBase64: "",
        responseBodyText: null,
        processName: detail.summary.processName,
        processPid: detail.summary.processPid,
      });

      if (verdict.action === "abort") {
        const abortedBody =
          '{"error":"Aborted at Live Breakpoint (Before Request)"}';
        const abortedDetail: SessionDetail = {
          ...detail,
          summary: {
            ...detail.summary,
            status: 502,
            error: "Aborted at Breakpoint (Before Request)",
            breakpointPaused: null,
            breakpointModified: true,
            bodySize: abortedBody.length,
          },
          responseBodyText: abortedBody,
          responseBodyBase64: encodeTextToBase64(abortedBody),
        };
        return this.commitCompletedSession(abortedDetail);
      }

      if (verdict.method && verdict.method.trim()) {
        detail.summary.method = verdict.method.trim().toUpperCase();
        bpModified = true;
      }
      if (verdict.url && verdict.url.trim() && verdict.url !== detail.summary.url) {
        try {
          const u = new URL(verdict.url.trim());
          detail.summary.url = u.toString();
          detail.summary.host = u.host;
          detail.summary.path = `${u.pathname}${u.search}`;
          bpModified = true;
        } catch {
          detail.summary.url = verdict.url.trim();
          bpModified = true;
        }
      }
      if (verdict.requestHeaders) {
        detail.requestHeaders = verdict.requestHeaders;
        bpModified = true;
      }
      if (typeof verdict.requestBodyText === "string") {
        detail.requestBodyText = verdict.requestBodyText;
        detail.requestBodyBase64 = verdict.requestBodyText
          ? encodeTextToBase64(verdict.requestBodyText)
          : "";
        bpModified = true;
      } else if (typeof verdict.requestBodyBase64 === "string") {
        detail.requestBodyBase64 = verdict.requestBodyBase64;
        bpModified = true;
      }
    }

    if (
      !detail.summary.tlsBypassed &&
      detail.summary.scheme !== "wss" &&
      this.shouldBreak("response", detail.summary.method, detail.summary.url)
    ) {
      const pendingResp: SessionDetail = {
        ...detail,
        summary: {
          ...detail.summary,
          breakpointPaused: "response",
          breakpointModified: bpModified,
        },
      };
      this.store.set(id, pendingResp);
      this.emitBatch([pendingResp.summary]);

      const verdict = await this.parkOnBreakpoint({
        sessionId: id,
        stage: "response" as BreakpointStage,
        scheme: detail.summary.scheme,
        method: detail.summary.method,
        url: detail.summary.url,
        host: detail.summary.host,
        path: detail.summary.path,
        requestHeaders: detail.requestHeaders,
        requestBodyBase64: detail.requestBodyBase64,
        requestBodyText: detail.requestBodyText,
        responseStatus: detail.summary.status,
        responseHeaders: detail.responseHeaders,
        responseBodyBase64: detail.responseBodyBase64,
        responseBodyText: detail.responseBodyText,
        processName: detail.summary.processName,
        processPid: detail.summary.processPid,
      });

      if (verdict.action === "abort") {
        const abortedBody =
          '{"error":"Aborted at Live Breakpoint (After Response)"}';
        const abortedDetail: SessionDetail = {
          ...detail,
          summary: {
            ...detail.summary,
            status: 504,
            error: "Aborted at Breakpoint (After Response)",
            breakpointPaused: null,
            breakpointModified: true,
            bodySize: abortedBody.length,
          },
          responseBodyText: abortedBody,
          responseBodyBase64: encodeTextToBase64(abortedBody),
        };
        return this.commitCompletedSession(abortedDetail);
      }

      if (typeof verdict.statusCode === "number" && verdict.statusCode >= 100) {
        detail.summary.status = verdict.statusCode;
        detail.summary.error =
          verdict.statusCode >= 500
            ? `Overridden to HTTP ${verdict.statusCode} at Breakpoint`
            : null;
        bpModified = true;
      }
      if (verdict.responseHeaders) {
        detail.responseHeaders = verdict.responseHeaders;
        const ct = verdict.responseHeaders.find(
          (h) => h.name.toLowerCase() === "content-type"
        )?.value;
        if (ct) detail.summary.contentType = ct;
        bpModified = true;
      }
      if (typeof verdict.responseBodyText === "string") {
        detail.responseBodyText = verdict.responseBodyText;
        detail.responseBodyBase64 = encodeTextToBase64(verdict.responseBodyText);
        detail.summary.bodySize = new TextEncoder().encode(
          verdict.responseBodyText
        ).length;
        bpModified = true;
      } else if (typeof verdict.responseBodyBase64 === "string") {
        detail.responseBodyBase64 = verdict.responseBodyBase64;
        bpModified = true;
      }
    }

    detail.summary.breakpointPaused = null;
    detail.summary.breakpointModified = bpModified;
    return this.commitCompletedSession(detail);
  }

  private findMatchingRule(
    method: string,
    url: string,
    headers: { name: string; value: string }[]
  ): AutoResponderRule | undefined {
    return this.rules.find((r) => {
      if (!r.enabled) return false;
      if (
        r.methodFilter &&
        r.methodFilter !== "ANY" &&
        r.methodFilter.toUpperCase() !== method.toUpperCase()
      ) {
        return false;
      }
      if (r.matchTarget === "urlContains") {
        return url.toLowerCase().includes(r.pattern.toLowerCase());
      }
      if (r.matchTarget === "urlRegex") {
        try {
          return new RegExp(r.pattern, "i").test(url);
        } catch {
          return false;
        }
      }
      const targetHeader = (r.headerName ?? "").toLowerCase();
      return headers.some(
        (h) =>
          (!targetHeader || h.name.toLowerCase() === targetHeader) &&
          h.value.toLowerCase().includes(r.pattern.toLowerCase())
      );
    });
  }

  private startTicker() {
    if (this.timer !== null || typeof window === "undefined") return;
    this.timer = window.setInterval(() => {
      if (!this.running || this.listeners.size === 0) return;
      // Avoid flooding paused breakpoint queue during background simulation
      if (this.pausedBreakpoints.size >= 3) return;
      void this.simulateLiveSessionFlow();
    }, 1800);
  }

  private emitBatch(batch: SessionSummary[]) {
    for (const cb of this.listeners) {
      cb(batch);
    }
  }

  subscribe(cb: (batch: SessionSummary[]) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  subscribeBreakpoints(cb: (items: PausedBreakpointItem[]) => void): () => void {
    this.bpListeners.add(cb);
    return () => {
      this.bpListeners.delete(cb);
    };
  }

  getBreakpointConfig(): BreakpointConfig {
    return structuredClone(this.breakpointConfig);
  }

  updateBreakpointConfig(config: BreakpointConfig): BreakpointConfig {
    this.breakpointConfig = structuredClone(config);
    return structuredClone(this.breakpointConfig);
  }

  listPausedBreakpoints(): PausedBreakpointItem[] {
    return Array.from(this.pausedBreakpoints.values())
      .map((e) => e.item)
      .sort((a, b) => a.sessionId - b.sessionId);
  }

  resolveBreakpoint(resolution: BreakpointResolution): boolean {
    const entry = this.pausedBreakpoints.get(resolution.breakpointId);
    if (!entry) return false;
    this.pausedBreakpoints.delete(resolution.breakpointId);
    if (entry.timerId) window.clearTimeout(entry.timerId);
    this.emitBreakpointsSnapshot();
    entry.resolve(resolution);
    return true;
  }

  resumeAllBreakpoints(action: BreakpointAction = "continue"): number {
    const entries = Array.from(this.pausedBreakpoints.entries());
    this.pausedBreakpoints.clear();
    this.emitBreakpointsSnapshot();
    for (const [breakpointId, entry] of entries) {
      if (entry.timerId) window.clearTimeout(entry.timerId);
      entry.resolve({ breakpointId, action });
    }
    return entries.length;
  }

  getStatus(): ProxyStatus {
    return {
      running: this.running,
      bindAddr: this.bindAddr,
      port: this.port,
      activeSessions: this.store.size,
      systemProxyEnabled: this.systemProxyEnabled,
      autoSystemProxy: this.autoSystemProxy,
      systemProxyError: this.systemProxyError,
      allowRemote: this.allowRemote || this.bindAddr === "0.0.0.0",
    };
  }

  setRunning(running: boolean, host?: string, port?: number): ProxyStatus {
    this.running = running;
    if (host) {
      this.bindAddr = host;
      this.allowRemote = host === "0.0.0.0" || host === "::";
    } else {
      this.bindAddr = this.allowRemote ? "0.0.0.0" : "127.0.0.1";
    }
    if (port) this.port = port;
    if (running) {
      if (this.autoSystemProxy) {
        this.systemProxyEnabled = true;
        this.systemProxyError = null;
      }
    } else {
      this.systemProxyEnabled = false;
      this.systemProxyError = null;
      this.resumeAllBreakpoints("continue");
    }
    return this.getStatus();
  }

  setAllowRemote(allow: boolean): ProxyStatus {
    this.allowRemote = allow;
    this.bindAddr = allow ? "0.0.0.0" : "127.0.0.1";
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          "fluxproxy.allowRemote.v1",
          JSON.stringify(allow)
        );
      } catch {
        // ignore storage errors
      }
    }
    return this.getStatus();
  }

  setSystemProxy(enabled: boolean): ProxyStatus {
    this.systemProxyEnabled = enabled;
    this.systemProxyError = null;
    return this.getStatus();
  }

  setAutoSystemProxy(auto: boolean): ProxyStatus {
    this.autoSystemProxy = auto;
    if (auto && this.running && !this.systemProxyEnabled) {
      this.systemProxyEnabled = true;
      this.systemProxyError = null;
    }
    return this.getStatus();
  }

  getSummaries(): SessionSummary[] {
    return Array.from(this.store.values()).map((d) => d.summary);
  }

  getDetail(id: number): SessionDetail | null {
    return this.store.get(id) ?? null;
  }

  updateAnnotations(
    ids: number[],
    comment: string | null,
    markedColor: string | null
  ): SessionSummary[] {
    const cleanComment = comment?.trim() ? comment.trim() : null;
    const cleanColor = markedColor?.trim() ? markedColor.trim() : null;
    const updated: SessionSummary[] = [];

    for (const id of ids) {
      const existing = this.store.get(id);
      if (!existing) continue;
      const next: SessionDetail = {
        ...existing,
        summary: {
          ...existing.summary,
          comment: cleanComment,
          markedColor: cleanColor,
        },
      };
      this.store.set(id, next);
      updated.push(next.summary);
    }

    if (updated.length > 0) {
      this.emitBatch(updated);
      this.syncArchivedPreviewAnnotations(updated);
    }
    return updated;
  }

  private syncArchivedPreviewAnnotations(updated: SessionSummary[]) {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(
        "fluxproxy.sqliteArchivePreview.v1"
      );
      if (!raw) return;
      const archived = JSON.parse(raw) as SessionDetail[];
      if (!Array.isArray(archived)) return;
      const byId = new Map(updated.map((s) => [s.id, s]));
      let changed = false;
      for (const item of archived) {
        const match = byId.get(item.summary.id);
        if (match) {
          item.summary.comment = match.comment ?? null;
          item.summary.markedColor = match.markedColor ?? null;
          changed = true;
        }
      }
      if (changed) {
        window.localStorage.setItem(
          "fluxproxy.sqliteArchivePreview.v1",
          JSON.stringify(archived)
        );
      }
    } catch {
      // ignore storage quota errors in preview
    }
  }

  saveArchiveToPreviewStorage(): number {
    const allDetails = Array.from(this.store.values()).sort(
      (a, b) => a.summary.id - b.summary.id
    );
    if (typeof window !== "undefined") {
      try {
        // Persist annotated sessions + up to 250 most recent sessions to stay within localStorage limits
        const annotated = allDetails.filter(
          (d) => d.summary.comment || d.summary.markedColor
        );
        const tail = allDetails.slice(-250);
        const mergedMap = new Map<number, SessionDetail>();
        for (const d of [...annotated, ...tail]) {
          mergedMap.set(d.summary.id, d);
        }
        const payload = Array.from(mergedMap.values()).sort(
          (a, b) => a.summary.id - b.summary.id
        );
        window.localStorage.setItem(
          "fluxproxy.sqliteArchivePreview.v1",
          JSON.stringify(payload)
        );
        window.localStorage.setItem(
          "fluxproxy-sqlite-preview-count",
          String(allDetails.length)
        );
      } catch {
        // ignore storage quota errors
      }
    }
    return allDetails.length;
  }

  loadArchiveFromPreviewStorage(): SessionSummary[] {
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(
          "fluxproxy.sqliteArchivePreview.v1"
        );
        if (raw) {
          const parsed = JSON.parse(raw) as SessionDetail[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            for (const detail of parsed) {
              this.insertIntoStoreWithRingBuffer(detail);
              if (detail.summary.id >= this.nextId) {
                this.nextId = detail.summary.id + 1;
              }
            }
          }
        }
      } catch {
        // ignore storage errors
      }
    }
    return this.getSummaries();
  }

  clear() {
    this.store.clear();
    this.offloadedBodies.clear();
    this.droppedSessionsCount = 0;
  }

  deleteMany(ids: number[]): number {
    let removed = 0;
    for (const id of ids) {
      if (this.store.delete(id)) {
        this.offloadedBodies.delete(`${id}:req`);
        this.offloadedBodies.delete(`${id}:resp`);
        removed += 1;
      }
    }
    return removed;
  }

  setSessionRetentionLimit(limit: number | null) {
    if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
      throw new Error("Session retention limit must be greater than 0");
    }
    this.sessionRetentionLimit = limit;
    this.enforceRetentionLimit();
  }

  setDropNonMatching(enabled: boolean) {
    this.filterConfig = {
      ...this.filterConfig,
      dropNonMatchingOnCapture: enabled,
    };
  }

  getMemoryStorageStats(): StorageStats {
    let persistedBytes = this.evictedSqliteBytes;
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(
          "fluxproxy.sqliteArchivePreview.v1"
        );
        if (raw) persistedBytes += raw.length;
      } catch {
        // ignore
      }
    }
    for (const item of this.offloadedBodies.values()) {
      persistedBytes += item.bodySize;
    }
    return {
      ramSessions: this.store.size,
      sqliteSizeBytes: persistedBytes,
      droppedSessionsCount: this.droppedSessionsCount,
      sessionRetentionLimit: this.sessionRetentionLimit,
      dropNonMatching: Boolean(this.filterConfig.dropNonMatchingOnCapture),
    };
  }

  loadSessionBody(id: number, isResponse: boolean): LoadedSessionBody {
    const key = `${id}:${isResponse ? "resp" : "req"}`;
    const offloaded = this.offloadedBodies.get(key);
    if (offloaded) {
      return {
        id,
        isResponse,
        bodyBase64: offloaded.bodyBase64,
        bodyText: offloaded.bodyText,
        bodySize: offloaded.bodySize,
      };
    }
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Session #${id} body not found`);
    }
    const bodyBase64 = isResponse
      ? existing.responseBodyBase64
      : existing.requestBodyBase64;
    const bodyText = isResponse
      ? existing.responseBodyText ?? null
      : existing.requestBodyText ?? null;
    return {
      id,
      isResponse,
      bodyBase64,
      bodyText,
      bodySize: isResponse
        ? existing.summary.bodySize
        : existing.requestBodyText?.length ?? 0,
    };
  }

  generateBulkStressSessions(count: number): SessionSummary[] {
    const batch: SessionSummary[] = [];
    for (let i = 0; i < count; i++) {
      const detail = this.applyPipelineToDetail(
        buildSimulatedSession(this.nextId++)
      );
      if (
        !evaluateShouldStoreSessionInPreview(detail.summary, this.filterConfig)
      ) {
        this.droppedSessionsCount += 1;
        continue;
      }
      const stored = this.insertIntoStoreWithRingBuffer(detail);
      batch.push(stored.summary);
    }
    const cappedBatch =
      this.sessionRetentionLimit && batch.length > this.sessionRetentionLimit
        ? batch.slice(batch.length - this.sessionRetentionLimit)
        : batch;
    if (cappedBatch.length > 0) {
      this.emitBatch(cappedBatch);
    }
    return cappedBatch;
  }

  listRules(): AutoResponderRule[] {
    return [...this.rules];
  }

  upsertRule(rule: AutoResponderRule): AutoResponderRule[] {
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) {
      this.rules[idx] = rule;
    } else {
      this.rules.push(rule);
    }
    return [...this.rules];
  }

  deleteRule(id: string): AutoResponderRule[] {
    this.rules = this.rules.filter((r) => r.id !== id);
    return [...this.rules];
  }

  getFilterBackendConfig(): ProxyFilterBackendConfig {
    return structuredClone(this.filterConfig);
  }

  updateFilterBackendConfig(
    config: ProxyFilterBackendConfig
  ): ProxyFilterBackendConfig {
    this.filterConfig = structuredClone(config);
    return structuredClone(this.filterConfig);
  }

  async executeComposed(req: ComposedRequest): Promise<SessionDetail> {
    const start = performance.now();
    const id = this.nextId++;
    let effectiveMethod = req.method;
    let effectiveUrl = req.url;
    let effectiveBody = req.body;
    let bpModified = false;

    const reqMut = applyHeaderMutationsInPreview(
      "request",
      effectiveUrl,
      req.headers,
      this.filterConfig
    );
    let effectiveReqHeaders = reqMut.headers;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(effectiveUrl);
    } catch {
      parsedUrl = new URL("https://example.com/");
    }

    // Live Breakpoint: Before Request
    if (this.shouldBreak("request", effectiveMethod, effectiveUrl)) {
      const verdict = await this.parkOnBreakpoint({
        sessionId: id,
        stage: "request",
        scheme: parsedUrl.protocol.replace(":", ""),
        method: effectiveMethod,
        url: effectiveUrl,
        host: parsedUrl.host,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        requestHeaders: effectiveReqHeaders,
        requestBodyBase64: effectiveBody ? encodeTextToBase64(effectiveBody) : "",
        requestBodyText: effectiveBody || null,
        responseStatus: null,
        responseHeaders: [],
        responseBodyBase64: "",
        responseBodyText: null,
        processName: "flux-proxy (Composer)",
        processPid: 9001,
      });

      if (verdict.action === "abort") {
        const abortedText = '{"error":"Aborted at Live Breakpoint (Before Request)"}';
        const aborted: SessionDetail = {
          summary: {
            id,
            status: 502,
            protocol: parsedUrl.protocol === "https:" ? "HTTPS/2" : "HTTP/1.1",
            scheme: parsedUrl.protocol.replace(":", ""),
            method: effectiveMethod,
            host: parsedUrl.host,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            url: effectiveUrl,
            contentType: "application/json",
            bodySize: abortedText.length,
            durationMs: Math.round(performance.now() - start),
            timestamp: new Date().toISOString(),
            isMocked: false,
            error: "Aborted at Breakpoint (Before Request)",
            processName: "flux-proxy (Composer)",
            processPid: 9001,
            breakpointPaused: null,
            breakpointModified: true,
          },
          requestHeaders: effectiveReqHeaders,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }],
          requestBodyBase64: effectiveBody ? encodeTextToBase64(effectiveBody) : "",
          responseBodyBase64: encodeTextToBase64(abortedText),
          requestBodyText: effectiveBody || null,
          responseBodyText: abortedText,
          tlsVersion: null,
          clientAddr: "Composer (Local)",
          websocketFrames: [],
        };
        this.store.set(id, aborted);
        this.emitBatch([aborted.summary]);
        return aborted;
      }

      if (verdict.method) {
        effectiveMethod = verdict.method.toUpperCase();
        bpModified = true;
      }
      if (verdict.url && verdict.url !== effectiveUrl) {
        effectiveUrl = verdict.url;
        try {
          parsedUrl = new URL(effectiveUrl);
        } catch {
          // keep previous parsedUrl
        }
        bpModified = true;
      }
      if (verdict.requestHeaders) {
        effectiveReqHeaders = verdict.requestHeaders;
        bpModified = true;
      }
      if (typeof verdict.requestBodyText === "string") {
        effectiveBody = verdict.requestBodyText;
        bpModified = true;
      }
    }

    const matched = this.findMatchingRule(
      effectiveMethod,
      effectiveUrl,
      effectiveReqHeaders
    );
    if (matched && matched.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, matched.latencyMs));
    }

    let finalDetail: SessionDetail;

    if (matched && matched.action === "mockResponse") {
      const respMut = applyHeaderMutationsInPreview(
        "response",
        effectiveUrl,
        matched.responseHeaders,
        this.filterConfig
      );
      const respBytes = new TextEncoder().encode(matched.responseBody);
      finalDetail = {
        summary: {
          id,
          status: matched.statusCode,
          protocol: parsedUrl.protocol === "https:" ? "HTTPS/2" : "HTTP/1.1",
          scheme: parsedUrl.protocol.replace(":", ""),
          method: effectiveMethod,
          host: parsedUrl.host,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          url: effectiveUrl,
          contentType:
            respMut.headers.find(
              (h) => h.name.toLowerCase() === "content-type"
            )?.value ?? "application/json; charset=utf-8",
          bodySize: respBytes.length,
          durationMs: Math.round(performance.now() - start),
          timestamp: new Date().toISOString(),
          isMocked: true,
          matchedRuleId: matched.id,
          error: null,
          processName: "flux-proxy (Composer)",
          processPid: 9001,
          tlsBypassed: false,
          headersMutated: reqMut.mutated || respMut.mutated,
          breakpointPaused: null,
          breakpointModified: bpModified,
        },
        requestHeaders: effectiveReqHeaders,
        responseHeaders: respMut.headers,
        requestBodyBase64: effectiveBody ? encodeTextToBase64(effectiveBody) : "",
        responseBodyBase64: encodeTextToBase64(matched.responseBody),
        requestBodyText: effectiveBody || null,
        responseBodyText: matched.responseBody,
        tlsVersion: "AutoResponder Mock (Preview)",
        clientAddr: "Composer (Local)",
        websocketFrames: [],
      };
    } else {
      // Attempt browser CORS fetch; gracefully fall back to synthetic echoed response if CORS blocks
      try {
        const headersInit: Record<string, string> = {};
        for (const h of effectiveReqHeaders) {
          if (h.name.trim()) headersInit[h.name] = h.value;
        }
        const resp = await fetch(effectiveUrl, {
          method: effectiveMethod,
          headers: headersInit,
          body:
            effectiveMethod !== "GET" &&
            effectiveMethod !== "HEAD" &&
            effectiveBody
              ? effectiveBody
              : undefined,
        });
        const text = await resp.text();
        const rawRespHeaders: { name: string; value: string }[] = [];
        resp.headers.forEach((value, name) =>
          rawRespHeaders.push({ name, value })
        );
        const respMut = applyHeaderMutationsInPreview(
          "response",
          effectiveUrl,
          rawRespHeaders,
          this.filterConfig
        );
        const ct =
          respMut.headers.find((h) => h.name.toLowerCase() === "content-type")
            ?.value ??
          resp.headers.get("content-type") ??
          "text/plain";
        const status =
          matched?.action === "overrideStatus" ? matched.statusCode : resp.status;

        finalDetail = {
          summary: {
            id,
            status,
            protocol: parsedUrl.protocol === "https:" ? "HTTPS/2" : "HTTP/1.1",
            scheme: parsedUrl.protocol.replace(":", ""),
            method: effectiveMethod,
            host: parsedUrl.host,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            url: effectiveUrl,
            contentType: ct,
            bodySize: new TextEncoder().encode(text).length,
            durationMs: Math.round(performance.now() - start),
            timestamp: new Date().toISOString(),
            isMocked: matched?.action === "overrideStatus",
            matchedRuleId: matched?.id ?? null,
            error: null,
            processName: "flux-proxy (Composer)",
            processPid: 9001,
            tlsBypassed: false,
            headersMutated: reqMut.mutated || respMut.mutated,
            breakpointPaused: null,
            breakpointModified: bpModified,
          },
          requestHeaders: effectiveReqHeaders,
          responseHeaders: respMut.headers,
          requestBodyBase64: effectiveBody
            ? encodeTextToBase64(effectiveBody)
            : "",
          responseBodyBase64: encodeTextToBase64(text),
          requestBodyText: effectiveBody || null,
          responseBodyText: text,
          tlsVersion: parsedUrl.protocol === "https:" ? "TLS 1.3" : null,
          clientAddr: "Composer (Browser Fetch)",
          websocketFrames: [],
        };
      } catch {
        const fallbackBody = JSON.stringify(
          {
            ok: true,
            note: "Executed in Browser Preview Mode (run via `cargo tauri dev` for raw CORS-free Rust sockets)",
            echo: {
              method: effectiveMethod,
              url: effectiveUrl,
              headersCount: effectiveReqHeaders.length,
              bodyLength: effectiveBody.length,
            },
          },
          null,
          2
        );
        const respMut = applyHeaderMutationsInPreview(
          "response",
          effectiveUrl,
          [
            { name: "Content-Type", value: "application/json; charset=utf-8" },
            { name: "X-FluxProxy-Engine", value: "Browser-Preview-Simulator" },
          ],
          this.filterConfig
        );
        finalDetail = {
          summary: {
            id,
            status:
              matched?.action === "overrideStatus" ? matched.statusCode : 200,
            protocol: parsedUrl.protocol === "https:" ? "HTTPS/2" : "HTTP/1.1",
            scheme: parsedUrl.protocol.replace(":", ""),
            method: effectiveMethod,
            host: parsedUrl.host,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            url: effectiveUrl,
            contentType: "application/json; charset=utf-8",
            bodySize: fallbackBody.length,
            durationMs: Math.max(12, Math.round(performance.now() - start)),
            timestamp: new Date().toISOString(),
            isMocked: Boolean(matched),
            matchedRuleId: matched?.id ?? null,
            error: null,
            processName: "flux-proxy (Composer)",
            processPid: 9001,
            tlsBypassed: false,
            headersMutated: reqMut.mutated || respMut.mutated,
            breakpointPaused: null,
            breakpointModified: bpModified,
          },
          requestHeaders: effectiveReqHeaders,
          responseHeaders: respMut.headers,
          requestBodyBase64: effectiveBody
            ? encodeTextToBase64(effectiveBody)
            : "",
          responseBodyBase64: encodeTextToBase64(fallbackBody),
          requestBodyText: effectiveBody || null,
          responseBodyText: fallbackBody,
          tlsVersion: "TLS 1.3 (Simulated)",
          clientAddr: "Composer (Local)",
          websocketFrames: [],
        };
      }
    }

    // Live Breakpoint: After Response
    if (this.shouldBreak("response", effectiveMethod, effectiveUrl)) {
      const verdict = await this.parkOnBreakpoint({
        sessionId: id,
        stage: "response",
        scheme: finalDetail.summary.scheme,
        method: finalDetail.summary.method,
        url: finalDetail.summary.url,
        host: finalDetail.summary.host,
        path: finalDetail.summary.path,
        requestHeaders: finalDetail.requestHeaders,
        requestBodyBase64: finalDetail.requestBodyBase64,
        requestBodyText: finalDetail.requestBodyText,
        responseStatus: finalDetail.summary.status,
        responseHeaders: finalDetail.responseHeaders,
        responseBodyBase64: finalDetail.responseBodyBase64,
        responseBodyText: finalDetail.responseBodyText,
        processName: "flux-proxy (Composer)",
        processPid: 9001,
      });

      if (verdict.action === "abort") {
        finalDetail.summary.status = 504;
        finalDetail.summary.error = "Aborted at Breakpoint (After Response)";
        finalDetail.summary.breakpointModified = true;
      } else {
        if (typeof verdict.statusCode === "number" && verdict.statusCode >= 100) {
          finalDetail.summary.status = verdict.statusCode;
          bpModified = true;
        }
        if (verdict.responseHeaders) {
          finalDetail.responseHeaders = verdict.responseHeaders;
          bpModified = true;
        }
        if (typeof verdict.responseBodyText === "string") {
          finalDetail.responseBodyText = verdict.responseBodyText;
          finalDetail.responseBodyBase64 = encodeTextToBase64(
            verdict.responseBodyText
          );
          finalDetail.summary.bodySize = new TextEncoder().encode(
            verdict.responseBodyText
          ).length;
          bpModified = true;
        }
        finalDetail.summary.breakpointModified = bpModified;
      }
    }

    const storedFinal = this.insertIntoStoreWithRingBuffer(finalDetail);
    this.emitBatch([storedFinal.summary]);
    return storedFinal;
  }
}

const previewEngine = new BrowserPreviewEngine();
let previewCaTrusted = false;

// ============================================================================
// Unified Tauri IPC API Bridge
// ============================================================================
export const proxyBridge = {
  async getStatus(): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("get_proxy_status");
    }
    return previewEngine.getStatus();
  },

  async startProxy(host?: string, port = 8888): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("start_proxy", {
        host: host ?? null,
        port,
      });
    }
    return previewEngine.setRunning(true, host, port);
  },

  async stopProxy(): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("stop_proxy");
    }
    return previewEngine.setRunning(false);
  },

  async setAllowRemote(allow: boolean): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("set_allow_remote", { allow });
    }
    return previewEngine.setAllowRemote(allow);
  },

  async getNetworkInterfaces(): Promise<NetworkInterfaceInfo[]> {
    if (isTauriRuntime()) {
      return invoke<NetworkInterfaceInfo[]>("get_network_interfaces");
    }
    return [
      {
        name: "Wi-Fi",
        ip: "192.168.1.45",
        kind: "wifi",
        isPrimary: true,
      },
      {
        name: "Ethernet",
        ip: "10.0.0.24",
        kind: "ethernet",
        isPrimary: false,
      },
    ];
  },

  async setSystemProxy(enabled: boolean): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("set_system_proxy", { enabled });
    }
    return previewEngine.setSystemProxy(enabled);
  },

  async setAutoSystemProxy(auto: boolean): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("set_auto_system_proxy", { auto });
    }
    return previewEngine.setAutoSystemProxy(auto);
  },

  async getSessions(): Promise<SessionSummary[]> {
    if (isTauriRuntime()) {
      return invoke<SessionSummary[]>("get_sessions");
    }
    return previewEngine.getSummaries();
  },

  async getSessionDetail(id: number): Promise<SessionDetail | null> {
    if (isTauriRuntime()) {
      return invoke<SessionDetail | null>("get_session_detail", { id });
    }
    return previewEngine.getDetail(id);
  },

  async setSessionRetentionLimit(limit: number | null): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("set_session_retention_limit", { limit });
      return;
    }
    previewEngine.setSessionRetentionLimit(limit);
  },

  async setDropNonMatching(enabled: boolean): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("set_drop_non_matching", { enabled });
      return;
    }
    previewEngine.setDropNonMatching(enabled);
  },

  async getMemoryStorageStats(): Promise<StorageStats> {
    if (isTauriRuntime()) {
      return invoke<StorageStats>("get_memory_storage_stats");
    }
    return previewEngine.getMemoryStorageStats();
  },

  async loadSessionBody(
    id: number,
    isResponse: boolean
  ): Promise<LoadedSessionBody> {
    if (isTauriRuntime()) {
      return invoke<LoadedSessionBody>("load_session_body", {
        id,
        isResponse,
      });
    }
    return previewEngine.loadSessionBody(id, isResponse);
  },

  async clearSessions(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("clear_sessions");
      return;
    }
    previewEngine.clear();
  },

  async deleteSessions(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    if (isTauriRuntime()) {
      try {
        return await invoke<number>("delete_sessions", { ids });
      } catch {
        return ids.length;
      }
    }
    return previewEngine.deleteMany(ids);
  },

  async saveSessionsSqlite(): Promise<number> {
    if (isTauriRuntime()) {
      return invoke<number>("save_sessions_sqlite");
    }
    return previewEngine.saveArchiveToPreviewStorage();
  },

  async loadSessionsSqlite(): Promise<SessionSummary[]> {
    if (isTauriRuntime()) {
      return invoke<SessionSummary[]>("load_sessions_sqlite");
    }
    return previewEngine.loadArchiveFromPreviewStorage();
  },

  async updateSessionAnnotations(
    ids: number[],
    comment: string | null,
    markedColor: string | null
  ): Promise<SessionSummary[]> {
    if (isTauriRuntime()) {
      return invoke<SessionSummary[]>("update_session_annotations", {
        ids,
        comment,
        markedColor,
      });
    }
    return previewEngine.updateAnnotations(ids, comment, markedColor);
  },

  async getCaInfo(): Promise<CaCertificateInfo> {
    if (isTauriRuntime()) {
      return invoke<CaCertificateInfo>("get_ca_info");
    }
    return {
      certPemPath: "%APPDATA%\\dev.fluxproxy.desktop\\ca\\fluxproxy-root-ca.pem",
      certCerPath: "%APPDATA%\\dev.fluxproxy.desktop\\ca\\fluxproxy-root-ca.cer",
      sha256Fingerprint:
        "8F:4B:1C:92:A7:03:E1:55:9D:C4:11:7A:6E:20:B8:3C:44:F9:02:D1:77:8A:91:0E:5B:2D:6C:3F:19:A4:E8:10",
      subject:
        "CN=FluxProxy Local Debugging Root CA, O=FluxProxy Web Debugger",
      validUntil: "2036-10-30 (ECDSA P-256 Root CA)",
      isTrusted: previewCaTrusted,
    };
  },

  async installRootCa(): Promise<string> {
    if (isTauriRuntime()) {
      return invoke<string>("install_root_ca");
    }
    previewCaTrusted = true;
    return "Preview Mode: Run inside Tauri (`cargo tauri dev`) to invoke native OS certificate trust (`certutil -user -addstore Root` / Keychain).";
  },

  async uninstallRootCa(): Promise<string> {
    if (isTauriRuntime()) {
      return invoke<string>("uninstall_root_ca");
    }
    previewCaTrusted = false;
    return "Preview Mode: Run inside Tauri (`cargo tauri dev`) to remove the Root CA from the OS trust store (`certutil -user -delstore Root` / Keychain).";
  },

  async listRules(): Promise<AutoResponderRule[]> {
    if (isTauriRuntime()) {
      return invoke<AutoResponderRule[]>("list_rules");
    }
    return previewEngine.listRules();
  },

  async upsertRule(rule: AutoResponderRule): Promise<AutoResponderRule[]> {
    if (isTauriRuntime()) {
      return invoke<AutoResponderRule[]>("upsert_rule", { rule });
    }
    return previewEngine.upsertRule(rule);
  },

  async deleteRule(id: string): Promise<AutoResponderRule[]> {
    if (isTauriRuntime()) {
      return invoke<AutoResponderRule[]>("delete_rule", { id });
    }
    return previewEngine.deleteRule(id);
  },

  async getFilterBackendConfig(): Promise<ProxyFilterBackendConfig> {
    if (isTauriRuntime()) {
      return invoke<ProxyFilterBackendConfig>("get_filter_backend_config");
    }
    return previewEngine.getFilterBackendConfig();
  },

  async updateFilterBackendConfig(
    config: ProxyFilterBackendConfig
  ): Promise<ProxyFilterBackendConfig> {
    if (isTauriRuntime()) {
      return invoke<ProxyFilterBackendConfig>("update_filter_backend_config", {
        config,
      });
    }
    return previewEngine.updateFilterBackendConfig(config);
  },

  async getBreakpointConfig(): Promise<BreakpointConfig> {
    if (isTauriRuntime()) {
      return invoke<BreakpointConfig>("get_breakpoint_config");
    }
    return previewEngine.getBreakpointConfig();
  },

  async updateBreakpointConfig(
    config: BreakpointConfig
  ): Promise<BreakpointConfig> {
    if (isTauriRuntime()) {
      return invoke<BreakpointConfig>("update_breakpoint_config", { config });
    }
    return previewEngine.updateBreakpointConfig(config);
  },

  async listPausedBreakpoints(): Promise<PausedBreakpointItem[]> {
    if (isTauriRuntime()) {
      return invoke<PausedBreakpointItem[]>("list_paused_breakpoints");
    }
    return previewEngine.listPausedBreakpoints();
  },

  async resolveBreakpoint(resolution: BreakpointResolution): Promise<boolean> {
    if (isTauriRuntime()) {
      return invoke<boolean>("resolve_breakpoint", { resolution });
    }
    return previewEngine.resolveBreakpoint(resolution);
  },

  async resumeAllBreakpoints(
    action: BreakpointAction = "continue"
  ): Promise<number> {
    if (isTauriRuntime()) {
      return invoke<number>("resume_all_breakpoints", { action });
    }
    return previewEngine.resumeAllBreakpoints(action);
  },

  async subscribeBreakpointsChanged(
    onChanged: (items: PausedBreakpointItem[]) => void
  ): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<PausedBreakpointItem[]>(
        "proxy://breakpoints-changed",
        (event) => {
          if (Array.isArray(event.payload)) {
            onChanged(event.payload);
          }
        }
      );
    }
    return previewEngine.subscribeBreakpoints(onChanged);
  },

  async codecTransform(
    operation: CodecOperation,
    input: string,
    inputIsBase64 = false
  ): Promise<CodecTransformResult> {
    if (isTauriRuntime()) {
      return invoke<CodecTransformResult>("codec_transform", {
        operation,
        input,
        inputIsBase64,
      });
    }
    return browserPreviewCodecTransform(operation, input, inputIsBase64);
  },

  async executeComposedRequest(req: ComposedRequest): Promise<SessionDetail> {
    if (isTauriRuntime()) {
      return invoke<SessionDetail>("execute_composed_request", {
        request: req,
      });
    }
    return previewEngine.executeComposed(req);
  },

  async subscribeSessionBatches(
    onBatch: (batch: SessionSummary[]) => void
  ): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<SessionSummary[]>("proxy://sessions-batch", (event) => {
        if (Array.isArray(event.payload) && event.payload.length > 0) {
          onBatch(event.payload);
        }
      });
    }
    return previewEngine.subscribe(onBatch);
  },

  generateStressTestSessions(count = 10_000): SessionSummary[] {
    return previewEngine.generateBulkStressSessions(count);
  },

  triggerSimulatedTrafficHit(): void {
    if (!isTauriRuntime()) {
      void previewEngine.simulateLiveSessionFlow();
    }
  },
};
