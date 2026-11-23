import { describe, expect, it } from "vitest";
import {
  aggregateSessionsStatistics,
  buildFiddlerTimestampRows,
  computePercentile,
  computeTransferMetrics,
  estimateWorldwidePerformance,
  formatFiddlerClock,
  formatFiddlerStatisticsText,
  formatStatisticsMarkdown,
  formatTimeCellTooltip,
  normalizeTimingPhases,
} from "./requestStatistics";
import type { SessionDetail, SessionSummary } from "../types/proxy";

function makeSampleDetail(overrides?: {
  reused?: boolean;
  compressed?: boolean;
  withTimings?: boolean;
}): SessionDetail {
  const reused = overrides?.reused ?? false;
  const compressed = overrides?.compressed ?? true;
  const withTimings = overrides?.withTimings ?? true;

  const summary: SessionSummary = {
    id: 42,
    status: 200,
    protocol: "HTTPS/2",
    scheme: "https",
    method: "POST",
    host: "api.fluxproxy.dev",
    path: "/v2/orders?limit=20",
    url: "https://api.fluxproxy.dev/v2/orders?limit=20",
    contentType: "application/json; charset=utf-8",
    bodySize: 1200,
    durationMs: reused ? 34 : 112,
    timestamp: "2026-11-22T12:00:00.100Z",
    isMocked: false,
    ttfbMs: 24.5,
    dnsMs: reused ? 0 : 12.4,
    connectMs: reused ? 0 : 18.6,
    tlsMs: reused ? 0 : 41.2,
    receiveMs: 6.3,
    requestSize: 540,
    wireBodySize: compressed ? 360 : 1200,
    serverIp: "93.184.216.34",
    serverConnReused: reused,
  };

  return {
    summary,
    requestHeaders: [
      { name: "Host", value: "api.fluxproxy.dev" },
      { name: "Content-Type", value: "application/json" },
    ],
    responseHeaders: [
      { name: "Content-Type", value: "application/json; charset=utf-8" },
      ...(compressed ? [{ name: "Content-Encoding", value: "gzip" }] : []),
    ],
    requestBodyBase64: "",
    responseBodyBase64: "",
    requestBodyText: '{"sku":"fx-1"}',
    responseBodyText: "x".repeat(1200),
    tlsVersion: "TLSv1.3",
    clientAddr: "127.0.0.1:51234",
    websocketFrames: [],
    timings: withTimings
      ? {
          clientConnected: "2026-11-22T12:00:00.095000Z",
          clientBeginRequest: "2026-11-22T12:00:00.100000Z",
          gotRequestHeaders: "2026-11-22T12:00:00.101200Z",
          clientDoneRequest: "2026-11-22T12:00:00.102500Z",
          proxyBeginRequest: "2026-11-22T12:00:00.103000Z",
          serverConnected: "2026-11-22T12:00:00.175200Z",
          serverGotRequest: "2026-11-22T12:00:00.177200Z",
          serverBeginResponse: "2026-11-22T12:00:00.201700Z",
          gotResponseHeaders: "2026-11-22T12:00:00.202000Z",
          serverDoneResponse: "2026-11-22T12:00:00.208000Z",
          clientBeginResponse: "2026-11-22T12:00:00.209500Z",
          clientDoneResponse: "2026-11-22T12:00:00.212000Z",
          clientReadMs: 2.5,
          clientTlsHandshakeMs: reused ? 0 : 4.2,
          dnsMs: reused ? 0 : 12.4,
          tcpConnectMs: reused ? 0 : 18.6,
          tlsHandshakeMs: reused ? 0 : 41.2,
          sendRequestMs: 2.0,
          serverWaitMs: 24.5,
          contentDownloadMs: 6.3,
          clientSendMs: 2.5,
          proxyOverheadMs: 2.0,
          overallElapsedMs: reused ? 34.0 : 112.0,
          netElapsedMs: reused ? 32.8 : 105.0,
        }
      : null,
    transferStats: withTimings
      ? {
          requestHeadersBytes: 210,
          requestBodyBytes: 14,
          requestWireBodyBytes: 14,
          responseHeadersBytes: 185,
          responseBodyBytes: 1200,
          responseWireBodyBytes: compressed ? 360 : 1200,
          responseContentEncoding: compressed ? "gzip" : null,
          clientConnId: 7,
          clientConnReused: reused,
          clientHttpVersion: "HTTP/1.1",
          clientTlsVersion: "TLSv1.3",
          clientTlsCipher: "TLS13_AES_256_GCM_SHA384",
          clientAlpn: "http/1.1",
          serverAddr: "93.184.216.34:443",
          serverIp: "93.184.216.34",
          serverPort: 443,
          serverConnId: 11,
          serverConnReused: reused,
          serverHttpVersion: "HTTP/2.0",
          serverTlsVersion: "TLSv1.3",
          serverTlsCipher: "TLS13_AES_128_GCM_SHA256",
          serverTlsAlpn: "h2",
          serverCertSubject: "CN=api.fluxproxy.dev",
          serverCertIssuer: "CN=Let's Encrypt E5",
        }
      : null,
  };
}

describe("requestStatistics", () => {
  it("normalizes cold vs reused phases and handles legacy sessions without timings", () => {
    const cold = normalizeTimingPhases(makeSampleDetail({ reused: false }));
    expect(cold.isFallback).toBe(false);
    expect(cold.overallElapsedMs).toBe(112);
    const totalPct = cold.phases.reduce((acc, p) => acc + p.percent, 0);
    expect(totalPct).toBeCloseTo(100, 3);
    expect(cold.phases.find((p) => p.key === "tlsHandshake")?.durationMs).toBe(
      41.2
    );

    const legacy = normalizeTimingPhases(
      makeSampleDetail({ withTimings: false })
    );
    expect(legacy.isFallback).toBe(true);
    expect(legacy.phases).toHaveLength(1);
    expect(legacy.phases[0].key).toBe("total");
    expect(legacy.phases[0].durationMs).toBe(112);
  });

  it("formats Fiddler timestamps with microsecond clock and delta ms", () => {
    expect(formatFiddlerClock("2026-11-22T12:00:00.1012Z")).toBe(
      "12:00:00.101200"
    );
    const rows = buildFiddlerTimestampRows(makeSampleDetail());
    expect(rows.length).toBe(12);
    expect(rows[0].label).toBe("ClientConnected");
    expect(rows[0].deltaMs).toBe(0);
    expect(rows[1].label).toBe("ClientBeginRequest");
    expect(rows[1].deltaMs).toBeCloseTo(5.0, 2);
    expect(rows[rows.length - 1].label).toBe("ClientDoneResponse");
    expect(rows[rows.length - 1].offsetMs).toBeCloseTo(117.0, 2);
  });

  it("computes compression savings, wire totals, and transfer throughput", () => {
    const compressed = computeTransferMetrics(
      makeSampleDetail({ compressed: true })
    );
    expect(compressed.isCompressed).toBe(true);
    expect(compressed.encoding).toBe("gzip");
    expect(compressed.responseBodyBytes).toBe(1200);
    expect(compressed.responseWireBodyBytes).toBe(360);
    expect(compressed.savedBytes).toBe(840);
    expect(compressed.savingsPercent).toBeCloseTo(70, 3);
    expect(compressed.requestTotalWireBytes).toBe(224);
    expect(compressed.responseTotalWireBytes).toBe(545);
    expect(compressed.totalWireBytes).toBe(769);
    expect(compressed.throughputBytesPerSec).toBeGreaterThan(6000);

    const plain = computeTransferMetrics(
      makeSampleDetail({ compressed: false })
    );
    expect(plain.isCompressed).toBe(false);
    expect(plain.savedBytes).toBe(0);
    expect(plain.savingsPercent).toBe(0);
  });

  it("estimates lower Worldwide Performance latency when connection is reused", () => {
    const coldEst = estimateWorldwidePerformance(
      makeSampleDetail({ reused: false })
    );
    const reusedEst = estimateWorldwidePerformance(
      makeSampleDetail({ reused: true })
    );

    expect(coldEst).toHaveLength(6);
    expect(coldEst[0].reusedConnection).toBe(false);
    expect(reusedEst[0].reusedConnection).toBe(true);
    expect(reusedEst[5].estimatedTotalMs).toBeGreaterThan(
      coldEst[0].estimatedTotalMs
    );
    for (let i = 0; i < coldEst.length; i += 1) {
      expect(reusedEst[i].estimatedTotalMs).toBeLessThan(
        coldEst[i].estimatedTotalMs
      );
    }
  });

  it("computes interpolated percentiles and aggregates multi-session KPIs", () => {
    expect(computePercentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(computePercentile([10, 20, 30, 40, 50], 95)).toBeCloseTo(48, 3);

    const sessions: SessionSummary[] = [
      {
        id: 1,
        status: 200,
        protocol: "HTTPS/2",
        scheme: "https",
        method: "GET",
        host: "api.test",
        path: "/a",
        url: "https://api.test/a",
        contentType: "application/json",
        bodySize: 1000,
        wireBodySize: 400,
        requestSize: 200,
        durationMs: 100,
        ttfbMs: 40,
        serverConnReused: false,
        timestamp: "2026-11-22T12:00:00.000Z",
        isMocked: false,
      },
      {
        id: 2,
        status: 404,
        protocol: "HTTPS/2",
        scheme: "https",
        method: "GET",
        host: "api.test",
        path: "/missing",
        url: "https://api.test/missing",
        contentType: "text/html",
        bodySize: 300,
        wireBodySize: 300,
        requestSize: 180,
        durationMs: 250,
        ttfbMs: 210,
        serverConnReused: true,
        timestamp: "2026-11-22T12:00:00.500Z",
        isMocked: false,
      },
      {
        id: 3,
        status: 200,
        protocol: "HTTPS/2",
        scheme: "https",
        method: "POST",
        host: "api.test",
        path: "/b",
        url: "https://api.test/b",
        contentType: "application/json",
        bodySize: 2000,
        wireBodySize: 900,
        requestSize: 500,
        durationMs: 40,
        ttfbMs: 20,
        serverConnReused: true,
        timestamp: "2026-11-22T12:00:01.000Z",
        isMocked: false,
      },
    ];

    const agg = aggregateSessionsStatistics(sessions);
    expect(agg.requestCount).toBe(3);
    expect(agg.errorCount).toBe(1);
    expect(agg.reusedCount).toBe(2);
    expect(agg.coldCount).toBe(1);
    expect(agg.reuseRatePercent).toBeCloseTo(66.667, 1);
    expect(agg.bytesSent).toBe(880);
    expect(agg.bytesReceivedDecoded).toBe(3300);
    expect(agg.bytesReceivedWire).toBe(1600);
    expect(agg.compressionSavedBytes).toBe(1700);
    expect(agg.overallWallElapsedMs).toBe(1040);
    expect(agg.p50LatencyMs).toBe(100);
    expect(agg.maxLatencyMs).toBe(250);
    expect(agg.topSlowest[0].id).toBe(2);
    expect(agg.topLargest[0].id).toBe(3);
    expect(agg.statusBuckets.map((b) => b.group)).toEqual(["2xx", "4xx"]);
    expect(agg.mimeBuckets[0].mimeGroup).toBe("application/json");
  });

  it("formats Fiddler Text, Markdown, and TrafficGrid Time cell tooltips", () => {
    const detail = makeSampleDetail();
    const fiddlerTxt = formatFiddlerStatisticsText(detail);
    expect(fiddlerTxt).toContain("ACTUAL PERFORMANCE:");
    expect(fiddlerTxt).toContain("ClientConnected");
    expect(fiddlerTxt).toContain("TLS13_AES_128_GCM_SHA256");

    const md = formatStatisticsMarkdown(detail);
    expect(md).toContain("## Session #42");
    expect(md).toContain("| Server Wait (TTFB) |");

    const multiTxt = formatFiddlerStatisticsText(null, [
      detail.summary,
      { ...detail.summary, id: 43, durationMs: 20 },
    ]);
    expect(multiTxt).toContain("Request Count:   2");
    expect(multiTxt).toContain("STATUS BREAKDOWN:");

    const tip = formatTimeCellTooltip(detail.summary, "Slow");
    expect(tip).toContain("Slow");
    expect(tip).toContain("DNS 12.40 ms");
    expect(tip).toContain("TTFB 24.50 ms");
    expect(tip).toContain("Server IP: 93.184.216.34");

    const proxiedDetail = makeSampleDetail();
    proxiedDetail.summary.serverIp = "via 10.0.0.2:8080";
    if (proxiedDetail.transferStats) {
      proxiedDetail.transferStats.serverAddr = null;
      proxiedDetail.transferStats.serverIp = "via 10.0.0.2:8080";
      proxiedDetail.transferStats.viaProxyAddr = "HTTP 10.0.0.2:8080";
    }
    const proxiedTxt = formatFiddlerStatisticsText(proxiedDetail);
    expect(proxiedTxt).toContain("via 10.0.0.2:8080");
    expect(proxiedTxt).toContain("Upstream Proxy:       HTTP 10.0.0.2:8080");
  });
});
