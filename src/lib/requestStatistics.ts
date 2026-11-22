import { formatBytes, formatDuration } from "./formatters";
import type { SessionDetail, SessionSummary } from "../types/proxy";

export type TimingPhaseKey =
  | "clientRead"
  | "clientTls"
  | "dns"
  | "tcpConnect"
  | "tlsHandshake"
  | "sendRequest"
  | "serverWait"
  | "contentDownload"
  | "clientSend"
  | "breakpointPause"
  | "scriptHook"
  | "autoresponder"
  | "proxyOverhead"
  | "total";

export type TimingPhaseCategory =
  | "client"
  | "connect"
  | "transfer"
  | "proxy"
  | "fallback";

export interface NormalizedTimingPhase {
  key: TimingPhaseKey;
  label: string;
  shortLabel: string;
  category: TimingPhaseCategory;
  durationMs: number;
  percent: number;
  color: string;
  description: string;
}

export interface NormalizedTimingSummary {
  phases: NormalizedTimingPhase[];
  totalMs: number;
  netElapsedMs: number | null;
  overallElapsedMs: number;
  isFallback: boolean;
}

export interface FiddlerTimestampRow {
  key: string;
  label: string;
  isoTimestamp: string;
  formattedTime: string;
  epochMs: number;
  deltaMs: number | null;
  offsetMs: number | null;
}

export interface TransferMetrics {
  requestHeadersBytes: number;
  requestBodyBytes: number;
  requestWireBodyBytes: number;
  requestTotalWireBytes: number;
  responseHeadersBytes: number;
  responseBodyBytes: number;
  responseWireBodyBytes: number;
  responseTotalWireBytes: number;
  totalWireBytes: number;
  encoding: string | null;
  isCompressed: boolean;
  savedBytes: number;
  savingsPercent: number;
  durationSeconds: number;
  throughputBytesPerSec: number | null;
  downloadBandwidthBytesPerSec: number | null;
  isEstimatedHeaders: boolean;
}

export interface WorldwideRegionProfile {
  id: string;
  name: string;
  regionLabel: string;
  rttMs: number;
  downloadMbps: number;
  uploadMbps: number;
}

export interface WorldwidePerformanceEstimate {
  profile: WorldwideRegionProfile;
  estimatedTotalMs: number;
  networkRttMs: number;
  transferMs: number;
  serverProcessingMs: number;
  rttCount: number;
  reusedConnection: boolean;
}

export interface StatusBucket {
  group: "2xx" | "3xx" | "4xx" | "5xx" | "Other";
  label: string;
  count: number;
  percent: number;
  bytes: number;
  color: string;
}

export interface MimeBucket {
  mimeGroup: string;
  count: number;
  bytes: number;
  wireBytes: number;
  percentOfBytes: number;
  color: string;
}

export interface MultiSessionStatistics {
  requestCount: number;
  completedCount: number;
  errorCount: number;
  reusedCount: number;
  coldCount: number;
  unknownReuseCount: number;
  reuseRatePercent: number | null;
  bytesSent: number;
  bytesReceivedDecoded: number;
  bytesReceivedWire: number;
  totalWireBytes: number;
  compressionSavedBytes: number;
  compressionSavingsPercent: number;
  overallWallElapsedMs: number;
  cumulativeDurationMs: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgTtfbMs: number | null;
  p50TtfbMs: number | null;
  p95TtfbMs: number | null;
  p99TtfbMs: number | null;
  statusBuckets: StatusBucket[];
  mimeBuckets: MimeBucket[];
  topSlowest: SessionSummary[];
  topLargest: SessionSummary[];
}

export const WORLDWIDE_REGION_PROFILES: WorldwideRegionProfile[] = [
  {
    id: "us-east",
    name: "US East (Virginia Fiber)",
    regionLabel: "North America",
    rttMs: 22,
    downloadMbps: 250,
    uploadMbps: 100,
  },
  {
    id: "eu-west",
    name: "EU West (Frankfurt Broadband)",
    regionLabel: "Europe",
    rttMs: 38,
    downloadMbps: 120,
    uploadMbps: 40,
  },
  {
    id: "us-west",
    name: "US West (San Jose Cable)",
    regionLabel: "North America",
    rttMs: 65,
    downloadMbps: 80,
    uploadMbps: 20,
  },
  {
    id: "apac-tokyo",
    name: "APAC (Tokyo Optical)",
    regionLabel: "Asia-Pacific",
    rttMs: 135,
    downloadMbps: 100,
    uploadMbps: 30,
  },
  {
    id: "mobile-lte",
    name: "Mobile 4G LTE",
    regionLabel: "Cellular",
    rttMs: 75,
    downloadMbps: 25,
    uploadMbps: 8,
  },
  {
    id: "mobile-3g",
    name: "Mobile 3G Slow",
    regionLabel: "Constrained",
    rttMs: 240,
    downloadMbps: 1.6,
    uploadMbps: 0.75,
  },
];

const TIMING_PHASE_DEFS: {
  key: Exclude<TimingPhaseKey, "total">;
  field: keyof NonNullable<SessionDetail["timings"]>;
  label: string;
  shortLabel: string;
  category: TimingPhaseCategory;
  color: string;
  description: string;
}[] = [
  {
    key: "clientTls",
    field: "clientTlsHandshakeMs",
    label: "Client TLS Handshake",
    shortLabel: "Clt TLS",
    category: "client",
    color: "#38bdf8",
    description: "MITM TLS handshake between client and FluxProxy.",
  },
  {
    key: "clientRead",
    field: "clientReadMs",
    label: "Client Request Read",
    shortLabel: "Clt Read",
    category: "client",
    color: "#60a5fa",
    description: "Time spent reading request headers and body from client.",
  },
  {
    key: "breakpointPause",
    field: "breakpointPauseMs",
    label: "Breakpoint Pause",
    shortLabel: "Breakpoint",
    category: "proxy",
    color: "#f43f5e",
    description: "Interactive operator pause at request/response breakpoint.",
  },
  {
    key: "scriptHook",
    field: "scriptHookMs",
    label: "Python Script Hook",
    shortLabel: "Script",
    category: "proxy",
    color: "#c084fc",
    description: "Execution duration of Python on_request / on_response hooks.",
  },
  {
    key: "autoresponder",
    field: "autoresponderDelayMs",
    label: "AutoResponder Delay",
    shortLabel: "Mock Delay",
    category: "proxy",
    color: "#f97316",
    description: "Artificial rule latency applied by AutoResponder.",
  },
  {
    key: "dns",
    field: "dnsMs",
    label: "DNS Lookup",
    shortLabel: "DNS",
    category: "connect",
    color: "#2dd4bf",
    description: "Upstream hostname DNS resolution (0 ms if pooled/reused).",
  },
  {
    key: "tcpConnect",
    field: "tcpConnectMs",
    label: "TCP Connect",
    shortLabel: "TCP",
    category: "connect",
    color: "#14b8a6",
    description: "TCP three-way handshake to upstream server.",
  },
  {
    key: "tlsHandshake",
    field: "tlsHandshakeMs",
    label: "Upstream TLS Handshake",
    shortLabel: "TLS",
    category: "connect",
    color: "#a855f7",
    description: "TLS negotiation and certificate verification with upstream.",
  },
  {
    key: "sendRequest",
    field: "sendRequestMs",
    label: "Send Request",
    shortLabel: "Send",
    category: "transfer",
    color: "#3b82f6",
    description: "Sending HTTP request headers and body to upstream server.",
  },
  {
    key: "serverWait",
    field: "serverWaitMs",
    label: "Server Wait (TTFB)",
    shortLabel: "TTFB",
    category: "transfer",
    color: "#10b981",
    description: "Time waiting for first response byte after sending request.",
  },
  {
    key: "contentDownload",
    field: "contentDownloadMs",
    label: "Content Download",
    shortLabel: "Receive",
    category: "transfer",
    color: "#22c55e",
    description: "Reading full response body from upstream server.",
  },
  {
    key: "clientSend",
    field: "clientSendMs",
    label: "Client Response Send",
    shortLabel: "Clt Send",
    category: "client",
    color: "#0ea5e9",
    description: "Flushing response bytes back to the downstream client.",
  },
  {
    key: "proxyOverhead",
    field: "proxyOverheadMs",
    label: "Proxy Overhead",
    shortLabel: "Overhead",
    category: "proxy",
    color: "#94a3b8",
    description: "Remaining internal proxy scheduling and buffering overhead.",
  },
];

const FIDDLER_TIMESTAMP_DEFS: {
  key: keyof NonNullable<SessionDetail["timings"]>;
  label: string;
}[] = [
  { key: "clientConnected", label: "ClientConnected" },
  { key: "clientBeginRequest", label: "ClientBeginRequest" },
  { key: "gotRequestHeaders", label: "GotRequestHeaders" },
  { key: "clientDoneRequest", label: "ClientDoneRequest" },
  { key: "proxyBeginRequest", label: "FiddlerBeginRequest" },
  { key: "serverConnected", label: "ServerConnected" },
  { key: "serverGotRequest", label: "ServerGotRequest" },
  { key: "serverBeginResponse", label: "ServerBeginResponse" },
  { key: "gotResponseHeaders", label: "GotResponseHeaders" },
  { key: "serverDoneResponse", label: "ServerDoneResponse" },
  { key: "clientBeginResponse", label: "ClientBeginResponse" },
  { key: "clientDoneResponse", label: "ClientDoneResponse" },
];

const MIME_COLORS = [
  "#3b82f6",
  "#10b981",
  "#a855f7",
  "#f59e0b",
  "#ec4899",
  "#14b8a6",
  "#64748b",
];

function isFiniteNonNeg(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val) && val >= 0;
}

export function formatMsPrecise(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms === 0) return "0.00 ms";
  if (ms < 1) return `${ms.toFixed(3)} ms`;
  return `${ms.toFixed(2)} ms`;
}

/**
 * Formats an ISO-8601 / RFC-3339 timestamp string into Fiddler's `HH:mm:ss.SSSSSS` clock format.
 */
export function formatFiddlerClock(iso: string): string {
  const trimmed = iso.trim();
  const timeMatch = trimmed.match(/T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?/i);
  if (timeMatch) {
    const hms = timeMatch[1];
    const frac = (timeMatch[2] ?? "").padEnd(6, "0").slice(0, 6);
    return `${hms}.${frac}`;
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return trimmed;
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  const us = `${String(d.getUTCMilliseconds()).padStart(3, "0")}000`;
  return `${hh}:${mm}:${ss}.${us}`;
}

function parseIsoEpochMsPrecise(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return NaN;
  const fracMatch = iso.match(/\.(\d+)/);
  if (!fracMatch) return ms;
  const padded = fracMatch[1].padEnd(6, "0").slice(0, 6);
  const microsRemainder = Number(padded.slice(3, 6));
  return Number.isFinite(microsRemainder) ? ms + microsRemainder / 1000 : ms;
}

function estimateRawHeadersBytes(
  firstLine: string,
  headers: { name: string; value: string }[]
): number {
  let bytes = firstLine.length + 2;
  for (const h of headers) {
    bytes += h.name.length + 2 + h.value.length + 2;
  }
  bytes += 2;
  return bytes;
}

function estimateDecodedBodyLen(
  text?: string | null,
  b64?: string | null
): number {
  if (text && text.length > 0) {
    return new TextEncoder().encode(text).length;
  }
  if (b64 && b64.length > 0) {
    const trimmed = b64.trim();
    const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
  }
  return 0;
}

/**
 * Normalizes captured per-phase timings into ordered visual waterfall segments.
 * Falls back to a single `Total` segment when legacy sessions lack `timings`.
 */
export function normalizeTimingPhases(
  detail: SessionDetail
): NormalizedTimingSummary {
  const timings = detail.timings;
  const summaryMs = Math.max(0, detail.summary.durationMs);

  if (!timings) {
    const fallbackTotal = summaryMs;
    return {
      phases: [
        {
          key: "total",
          label: "Total Duration",
          shortLabel: "Total",
          category: "fallback",
          durationMs: fallbackTotal,
          percent: fallbackTotal > 0 ? 100 : 0,
          color: "#3b82f6",
          description:
            "Per-phase breakdown unavailable for this legacy/imported session.",
        },
      ],
      totalMs: fallbackTotal,
      netElapsedMs: null,
      overallElapsedMs: fallbackTotal,
      isFallback: true,
    };
  }

  const activePhases: Omit<NormalizedTimingPhase, "percent">[] = [];
  for (const def of TIMING_PHASE_DEFS) {
    const val = timings[def.field];
    if (isFiniteNonNeg(val)) {
      activePhases.push({
        key: def.key,
        label: def.label,
        shortLabel: def.shortLabel,
        category: def.category,
        durationMs: val,
        color: def.color,
        description: def.description,
      });
    }
  }

  const sumPhases = activePhases.reduce((acc, p) => acc + p.durationMs, 0);
  const overallElapsedMs = isFiniteNonNeg(timings.overallElapsedMs)
    ? timings.overallElapsedMs
    : Math.max(sumPhases, summaryMs);
  const netElapsedMs = isFiniteNonNeg(timings.netElapsedMs)
    ? timings.netElapsedMs
    : null;

  if (activePhases.length === 0) {
    const fallbackTotal = overallElapsedMs;
    return {
      phases: [
        {
          key: "total",
          label: "Total Duration",
          shortLabel: "Total",
          category: "fallback",
          durationMs: fallbackTotal,
          percent: fallbackTotal > 0 ? 100 : 0,
          color: "#3b82f6",
          description: "No individual timing phases recorded.",
        },
      ],
      totalMs: fallbackTotal,
      netElapsedMs,
      overallElapsedMs,
      isFallback: true,
    };
  }

  const denom = sumPhases > 0 ? sumPhases : overallElapsedMs;
  const phases: NormalizedTimingPhase[] = activePhases.map((p) => ({
    ...p,
    percent: denom > 0 ? (p.durationMs / denom) * 100 : 0,
  }));

  return {
    phases,
    totalMs: sumPhases > 0 ? sumPhases : overallElapsedMs,
    netElapsedMs,
    overallElapsedMs,
    isFallback: false,
  };
}

/**
 * Extracts ordered Fiddler `ACTUAL PERFORMANCE` timestamps with inter-step `+Δ ms` and offset.
 */
export function buildFiddlerTimestampRows(
  detail: SessionDetail
): FiddlerTimestampRow[] {
  const timings = detail.timings;
  if (!timings) {
    if (!detail.summary.timestamp) return [];
    const epochMs = parseIsoEpochMsPrecise(detail.summary.timestamp);
    return [
      {
        key: "clientBeginRequest",
        label: "ClientBeginRequest",
        isoTimestamp: detail.summary.timestamp,
        formattedTime: formatFiddlerClock(detail.summary.timestamp),
        epochMs,
        deltaMs: 0,
        offsetMs: 0,
      },
    ];
  }

  const rows: FiddlerTimestampRow[] = [];
  let firstEpoch: number | null = null;
  let prevEpoch: number | null = null;

  for (const def of FIDDLER_TIMESTAMP_DEFS) {
    const raw = timings[def.key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const epochMs = parseIsoEpochMsPrecise(raw);
    const validEpoch = Number.isFinite(epochMs);
    if (validEpoch && firstEpoch === null) {
      firstEpoch = epochMs;
    }
    const deltaMs =
      validEpoch && prevEpoch !== null
        ? Math.max(0, epochMs - prevEpoch)
        : validEpoch
          ? 0
          : null;
    const offsetMs =
      validEpoch && firstEpoch !== null ? Math.max(0, epochMs - firstEpoch) : null;
    if (validEpoch) {
      prevEpoch = epochMs;
    }
    rows.push({
      key: String(def.key),
      label: def.label,
      isoTimestamp: raw,
      formattedTime: formatFiddlerClock(raw),
      epochMs,
      deltaMs,
      offsetMs,
    });
  }

  return rows;
}

/**
 * Computes wire vs decoded transfer counters, compression savings, and throughput.
 */
export function computeTransferMetrics(detail: SessionDetail): TransferMetrics {
  const stats = detail.transferStats;
  const s = detail.summary;

  const hasExactHeaders =
    isFiniteNonNeg(stats?.requestHeadersBytes) &&
    isFiniteNonNeg(stats?.responseHeadersBytes);

  const reqStartLine = `${s.method} ${s.path || "/"} ${stats?.clientHttpVersion || "HTTP/1.1"}`;
  const respStartLine = `${stats?.serverHttpVersion || "HTTP/1.1"} ${s.status} OK`;

  const requestHeadersBytes = isFiniteNonNeg(stats?.requestHeadersBytes)
    ? stats.requestHeadersBytes
    : estimateRawHeadersBytes(reqStartLine, detail.requestHeaders);

  const responseHeadersBytes = isFiniteNonNeg(stats?.responseHeadersBytes)
    ? stats.responseHeadersBytes
    : estimateRawHeadersBytes(respStartLine, detail.responseHeaders);

  const inferredReqBody = estimateDecodedBodyLen(
    detail.requestBodyText,
    detail.requestBodyBase64
  );
  const requestBodyBytes = isFiniteNonNeg(stats?.requestBodyBytes)
    ? stats.requestBodyBytes
    : inferredReqBody;
  const requestWireBodyBytes = isFiniteNonNeg(stats?.requestWireBodyBytes)
    ? stats.requestWireBodyBytes
    : requestBodyBytes;

  const responseBodyBytes = isFiniteNonNeg(stats?.responseBodyBytes)
    ? stats.responseBodyBytes
    : Math.max(0, s.bodySize);
  const responseWireBodyBytes = isFiniteNonNeg(stats?.responseWireBodyBytes)
    ? stats.responseWireBodyBytes
    : isFiniteNonNeg(s.wireBodySize)
      ? s.wireBodySize
      : responseBodyBytes;

  const requestTotalWireBytes = requestHeadersBytes + requestWireBodyBytes;
  const responseTotalWireBytes = responseHeadersBytes + responseWireBodyBytes;
  const totalWireBytes = requestTotalWireBytes + responseTotalWireBytes;

  const encodingFromHeaders =
    detail.responseHeaders.find(
      (h) => h.name.toLowerCase() === "content-encoding"
    )?.value ?? null;
  const encoding =
    stats?.responseContentEncoding?.trim() ||
    encodingFromHeaders?.trim() ||
    null;

  const savedBytes = Math.max(0, responseBodyBytes - responseWireBodyBytes);
  const isCompressed =
    Boolean(encoding && encoding.toLowerCase() !== "identity") ||
    savedBytes > 0;
  const savingsPercent =
    responseBodyBytes > 0 && savedBytes > 0
      ? (savedBytes / responseBodyBytes) * 100
      : 0;

  const overallMs = isFiniteNonNeg(detail.timings?.overallElapsedMs)
    ? detail.timings.overallElapsedMs
    : Math.max(0, s.durationMs);
  const durationSeconds = overallMs / 1000;
  const throughputBytesPerSec =
    durationSeconds > 0 ? totalWireBytes / durationSeconds : null;

  const dlMs = detail.timings?.contentDownloadMs;
  const downloadBandwidthBytesPerSec = isFiniteNonNeg(dlMs) && dlMs > 0
    ? responseWireBodyBytes / (dlMs / 1000)
    : throughputBytesPerSec;

  return {
    requestHeadersBytes,
    requestBodyBytes,
    requestWireBodyBytes,
    requestTotalWireBytes,
    responseHeadersBytes,
    responseBodyBytes,
    responseWireBodyBytes,
    responseTotalWireBytes,
    totalWireBytes,
    encoding,
    isCompressed,
    savedBytes,
    savingsPercent,
    durationSeconds,
    throughputBytesPerSec,
    downloadBandwidthBytesPerSec,
    isEstimatedHeaders: !hasExactHeaders,
  };
}

/**
 * Estimates Fiddler-style Worldwide Performance across global network profiles.
 */
export function estimateWorldwidePerformance(
  detail: SessionDetail
): WorldwidePerformanceEstimate[] {
  const transfer = computeTransferMetrics(detail);
  const reused = Boolean(
    detail.transferStats?.serverConnReused ?? detail.summary.serverConnReused
  );
  const scheme = detail.summary.scheme.toLowerCase();
  const isHttps =
    scheme === "https" ||
    scheme === "wss" ||
    Boolean(detail.transferStats?.serverTlsVersion || detail.tlsVersion);

  const dnsMeasured = isFiniteNonNeg(detail.timings?.dnsMs) && (detail.timings?.dnsMs ?? 0) > 0;
  const serverWait = isFiniteNonNeg(detail.timings?.serverWaitMs)
    ? detail.timings.serverWaitMs
    : Math.max(0, detail.summary.durationMs * 0.45);

  return WORLDWIDE_REGION_PROFILES.map((profile) => {
    const dnsRtts = reused ? 0 : dnsMeasured ? 1 : 0.5;
    const tcpRtts = reused ? 0 : 1;
    const tlsRtts = reused ? 0 : isHttps ? 1.5 : 0;
    const httpRtts = 1;
    const rttCount = dnsRtts + tcpRtts + tlsRtts + httpRtts;

    const networkRttMs = rttCount * profile.rttMs;
    const uploadMs =
      profile.uploadMbps > 0
        ? transfer.requestTotalWireBytes / (profile.uploadMbps * 125)
        : 0;
    const downloadMs =
      profile.downloadMbps > 0
        ? transfer.responseTotalWireBytes / (profile.downloadMbps * 125)
        : 0;
    const transferMs = uploadMs + downloadMs;

    return {
      profile,
      estimatedTotalMs: networkRttMs + transferMs + serverWait,
      networkRttMs,
      transferMs,
      serverProcessingMs: serverWait,
      rttCount,
      reusedConnection: reused,
    };
  });
}

/**
 * Computes interpolated percentile `p` (0..100) from an ascending sorted numeric array.
 */
export function computePercentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const clampedP = Math.max(0, Math.min(100, p));
  const rank = (clampedP / 100) * (sortedValues.length - 1);
  const lowerIdx = Math.floor(rank);
  const upperIdx = Math.ceil(rank);
  if (lowerIdx === upperIdx) return sortedValues[lowerIdx];
  const weight = rank - lowerIdx;
  return (
    sortedValues[lowerIdx] * (1 - weight) + sortedValues[upperIdx] * weight
  );
}

function classifyMimeGroup(contentType: string): string {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  if (!ct) return "other / empty";
  if (ct.includes("json")) return "application/json";
  if (ct.includes("javascript") || ct.includes("ecmascript")) return "javascript";
  if (ct.includes("text/html")) return "text/html";
  if (ct.includes("text/css")) return "text/css";
  if (ct.startsWith("image/")) return "image/*";
  if (ct.includes("text/event-stream")) return "text/event-stream";
  if (ct.includes("protobuf") || ct.includes("grpc")) return "grpc / protobuf";
  if (ct.includes("xml")) return "xml";
  if (ct.startsWith("font/") || ct.includes("woff")) return "font/*";
  if (ct.startsWith("video/") || ct.startsWith("audio/")) return "media/*";
  return ct;
}

/**
 * Aggregates Fiddler-style multi-selection KPIs, percentile latency/TTFB, status & MIME breakdowns.
 */
export function aggregateSessionsStatistics(
  sessions: SessionSummary[]
): MultiSessionStatistics {
  const requestCount = sessions.length;
  let completedCount = 0;
  let errorCount = 0;
  let reusedCount = 0;
  let coldCount = 0;
  let unknownReuseCount = 0;
  let bytesSent = 0;
  let bytesReceivedDecoded = 0;
  let bytesReceivedWire = 0;
  let cumulativeDurationMs = 0;

  const latencies: number[] = [];
  const ttfbs: number[] = [];

  let minStartMs = Number.POSITIVE_INFINITY;
  let maxEndMs = Number.NEGATIVE_INFINITY;

  const statusAcc: Record<
    StatusBucket["group"],
    { count: number; bytes: number; label: string; color: string }
  > = {
    "2xx": { count: 0, bytes: 0, label: "2xx Success", color: "#10b981" },
    "3xx": { count: 0, bytes: 0, label: "3xx Redirect", color: "#f59e0b" },
    "4xx": { count: 0, bytes: 0, label: "4xx Client Err", color: "#f97316" },
    "5xx": { count: 0, bytes: 0, label: "5xx Server Err", color: "#ef4444" },
    Other: { count: 0, bytes: 0, label: "Other / WS / Tunnel", color: "#8b5cf6" },
  };

  const mimeAcc = new Map<
    string,
    { count: number; bytes: number; wireBytes: number }
  >();

  for (const s of sessions) {
    const dur = Math.max(0, s.durationMs);
    latencies.push(dur);
    cumulativeDurationMs += dur;

    if (isFiniteNonNeg(s.ttfbMs)) {
      ttfbs.push(s.ttfbMs);
    }

    if (s.status > 0) completedCount += 1;
    if (s.error || s.status >= 400) errorCount += 1;

    if (s.serverConnReused === true) reusedCount += 1;
    else if (s.serverConnReused === false) coldCount += 1;
    else unknownReuseCount += 1;

    const reqBytes = isFiniteNonNeg(s.requestSize) ? s.requestSize : 0;
    const decBytes = Math.max(0, s.bodySize);
    const wireBytes = isFiniteNonNeg(s.wireBodySize)
      ? s.wireBodySize
      : decBytes;

    bytesSent += reqBytes;
    bytesReceivedDecoded += decBytes;
    bytesReceivedWire += wireBytes;

    const parsedStart = Date.parse(s.timestamp);
    if (Number.isFinite(parsedStart)) {
      if (parsedStart < minStartMs) minStartMs = parsedStart;
      if (parsedStart + dur > maxEndMs) maxEndMs = parsedStart + dur;
    }

    const bucketKey: StatusBucket["group"] =
      s.status >= 200 && s.status < 300
        ? "2xx"
        : s.status >= 300 && s.status < 400
          ? "3xx"
          : s.status >= 400 && s.status < 500
            ? "4xx"
            : s.status >= 500
              ? "5xx"
              : "Other";
    statusAcc[bucketKey].count += 1;
    statusAcc[bucketKey].bytes += wireBytes;

    const mimeGroup = classifyMimeGroup(s.contentType);
    const existing = mimeAcc.get(mimeGroup) ?? { count: 0, bytes: 0, wireBytes: 0 };
    existing.count += 1;
    existing.bytes += decBytes;
    existing.wireBytes += wireBytes;
    mimeAcc.set(mimeGroup, existing);
  }

  latencies.sort((a, b) => a - b);
  ttfbs.sort((a, b) => a - b);

  const avgLatencyMs =
    latencies.length > 0 ? cumulativeDurationMs / latencies.length : 0;
  const minLatencyMs = latencies.length > 0 ? latencies[0] : 0;
  const maxLatencyMs =
    latencies.length > 0 ? latencies[latencies.length - 1] : 0;

  const avgTtfbMs =
    ttfbs.length > 0
      ? ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length
      : null;

  const overallWallElapsedMs =
    Number.isFinite(minStartMs) && Number.isFinite(maxEndMs) && maxEndMs >= minStartMs
      ? maxEndMs - minStartMs
      : cumulativeDurationMs;

  const compressionSavedBytes = Math.max(
    0,
    bytesReceivedDecoded - bytesReceivedWire
  );
  const compressionSavingsPercent =
    bytesReceivedDecoded > 0 && compressionSavedBytes > 0
      ? (compressionSavedBytes / bytesReceivedDecoded) * 100
      : 0;

  const knownReuseTotal = reusedCount + coldCount;
  const reuseRatePercent =
    knownReuseTotal > 0 ? (reusedCount / knownReuseTotal) * 100 : null;

  const statusBuckets: StatusBucket[] = (
    Object.keys(statusAcc) as StatusBucket["group"][]
  )
    .filter((k) => statusAcc[k].count > 0)
    .map((group) => ({
      group,
      label: statusAcc[group].label,
      count: statusAcc[group].count,
      percent: requestCount > 0 ? (statusAcc[group].count / requestCount) * 100 : 0,
      bytes: statusAcc[group].bytes,
      color: statusAcc[group].color,
    }));

  const mimeTotalBytes = Array.from(mimeAcc.values()).reduce(
    (acc, v) => acc + v.wireBytes,
    0
  );
  const mimeBuckets: MimeBucket[] = Array.from(mimeAcc.entries())
    .sort((a, b) => b[1].wireBytes - a[1].wireBytes || b[1].count - a[1].count)
    .map(([mimeGroup, val], idx) => ({
      mimeGroup,
      count: val.count,
      bytes: val.bytes,
      wireBytes: val.wireBytes,
      percentOfBytes:
        mimeTotalBytes > 0 ? (val.wireBytes / mimeTotalBytes) * 100 : 0,
      color: MIME_COLORS[idx % MIME_COLORS.length],
    }));

  const topSlowest = [...sessions]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5);
  const topLargest = [...sessions]
    .sort((a, b) => b.bodySize - a.bodySize)
    .slice(0, 5);

  return {
    requestCount,
    completedCount,
    errorCount,
    reusedCount,
    coldCount,
    unknownReuseCount,
    reuseRatePercent,
    bytesSent,
    bytesReceivedDecoded,
    bytesReceivedWire,
    totalWireBytes: bytesSent + bytesReceivedWire,
    compressionSavedBytes,
    compressionSavingsPercent,
    overallWallElapsedMs,
    cumulativeDurationMs,
    avgLatencyMs,
    minLatencyMs,
    maxLatencyMs,
    p50LatencyMs: computePercentile(latencies, 50),
    p95LatencyMs: computePercentile(latencies, 95),
    p99LatencyMs: computePercentile(latencies, 99),
    avgTtfbMs,
    p50TtfbMs: ttfbs.length > 0 ? computePercentile(ttfbs, 50) : null,
    p95TtfbMs: ttfbs.length > 0 ? computePercentile(ttfbs, 95) : null,
    p99TtfbMs: ttfbs.length > 0 ? computePercentile(ttfbs, 99) : null,
    statusBuckets,
    mimeBuckets,
    topSlowest,
    topLargest,
  };
}

/**
 * Generates Fiddler Classic plain-text `Statistics` report for single or multi-selection.
 */
export function formatFiddlerStatisticsText(
  detail: SessionDetail | null,
  selectedSessions?: SessionSummary[]
): string {
  if (selectedSessions && selectedSessions.length >= 2) {
    const agg = aggregateSessionsStatistics(selectedSessions);
    const lines: string[] = [
      `Request Count:   ${agg.requestCount}`,
      `Bytes Sent:      ${agg.bytesSent.toLocaleString("en-US")} (${formatBytes(agg.bytesSent)})`,
      `Bytes Received:  ${agg.bytesReceivedWire.toLocaleString("en-US")} wire / ${agg.bytesReceivedDecoded.toLocaleString("en-US")} decoded (${formatBytes(agg.bytesReceivedWire)})`,
      `Overall Elapsed: ${formatDuration(Math.round(agg.overallWallElapsedMs))}`,
      `Latency (Avg / P50 / P95 / P99): ${agg.avgLatencyMs.toFixed(1)} ms / ${agg.p50LatencyMs.toFixed(1)} ms / ${agg.p95LatencyMs.toFixed(1)} ms / ${agg.p99LatencyMs.toFixed(1)} ms`,
    ];
    if (agg.avgTtfbMs !== null) {
      lines.push(
        `TTFB (Avg / P50 / P95 / P99):    ${agg.avgTtfbMs.toFixed(1)} ms / ${agg.p50TtfbMs?.toFixed(1)} ms / ${agg.p95TtfbMs?.toFixed(1)} ms / ${agg.p99TtfbMs?.toFixed(1)} ms`
      );
    }
    if (agg.reuseRatePercent !== null) {
      lines.push(
        `Connection Reuse: ${agg.reusedCount}/${agg.reusedCount + agg.coldCount} (${agg.reuseRatePercent.toFixed(1)}%)`
      );
    }
    lines.push("", "STATUS BREAKDOWN:");
    for (const b of agg.statusBuckets) {
      lines.push(
        `  ${b.label.padEnd(20)} ${String(b.count).padStart(4)} (${b.percent.toFixed(1)}%) - ${formatBytes(b.bytes)}`
      );
    }
    lines.push("", "BYTES BY CONTENT-TYPE:");
    for (const m of agg.mimeBuckets) {
      lines.push(
        `  ${m.mimeGroup.padEnd(24)} ${String(m.count).padStart(4)} reqs - ${m.wireBytes.toLocaleString("en-US")} B (${m.percentOfBytes.toFixed(1)}%)`
      );
    }
    return lines.join("\n");
  }

  if (!detail) return "No session selected.";
  const s = detail.summary;
  const xfer = computeTransferMetrics(detail);
  const timingSummary = normalizeTimingPhases(detail);
  const tsRows = buildFiddlerTimestampRows(detail);
  const stats = detail.transferStats;

  const lines: string[] = [
    `Request:         #${s.id} ${s.method} ${s.url}`,
    `Status:          ${s.status} (${s.protocol})`,
    `Request Count:   1`,
    `Bytes Sent:      ${xfer.requestTotalWireBytes.toLocaleString("en-US")} (headers:${xfer.requestHeadersBytes}; body:${xfer.requestWireBodyBytes})`,
    `Bytes Received:  ${xfer.responseTotalWireBytes.toLocaleString("en-US")} (headers:${xfer.responseHeadersBytes}; wire:${xfer.responseWireBodyBytes}; decoded:${xfer.responseBodyBytes})`,
    "",
    "ACTUAL PERFORMANCE:",
  ];

  for (const row of tsRows) {
    const deltaText =
      row.deltaMs !== null ? ` (+${row.deltaMs.toFixed(2)} ms)` : "";
    lines.push(`  ${row.label.padEnd(21)} ${row.formattedTime}${deltaText}`);
  }

  lines.push(
    `  Elapsed (Overall):    ${formatMsPrecise(timingSummary.overallElapsedMs)}`
  );
  if (timingSummary.netElapsedMs !== null) {
    lines.push(
      `  Elapsed (Network):    ${formatMsPrecise(timingSummary.netElapsedMs)}`
    );
  }

  if (!timingSummary.isFallback) {
    lines.push("", "TIMING PHASES:");
    for (const ph of timingSummary.phases) {
      lines.push(
        `  ${ph.label.padEnd(24)} ${formatMsPrecise(ph.durationMs).padStart(10)} (${ph.percent.toFixed(1)}%)`
      );
    }
  }

  lines.push("", "CONNECTION & TLS:");
  lines.push(
    `  Client:               ${detail.clientAddr || "—"} (reused=${stats?.clientConnReused ?? "—"}, proto=${stats?.clientHttpVersion || s.protocol})`
  );
  lines.push(
    `  Server:               ${stats?.serverAddr || stats?.serverIp || s.serverIp || s.host} (reused=${stats?.serverConnReused ?? s.serverConnReused ?? "—"}, proto=${stats?.serverHttpVersion || "—"})`
  );
  if (stats?.serverTlsVersion || stats?.serverTlsCipher || detail.tlsVersion) {
    lines.push(
      `  Server TLS:           ${stats?.serverTlsVersion || detail.tlsVersion || "—"} ${stats?.serverTlsCipher ? `(${stats.serverTlsCipher})` : ""} ${stats?.serverTlsAlpn ? `ALPN=${stats.serverTlsAlpn}` : ""}`.trimEnd()
    );
  }
  if (stats?.serverCertSubject) {
    lines.push(`  Server Cert:          ${stats.serverCertSubject}`);
  }

  return lines.join("\n");
}

/**
 * Generates GitHub-flavored Markdown report for single session or multi-selection.
 */
export function formatStatisticsMarkdown(
  detail: SessionDetail | null,
  selectedSessions?: SessionSummary[]
): string {
  if (selectedSessions && selectedSessions.length >= 2) {
    const agg = aggregateSessionsStatistics(selectedSessions);
    const lines: string[] = [
      `## FluxProxy Multi-Session Statistics (${agg.requestCount} requests)`,
      "",
      "| Metric | Value |",
      "| --- | --- |",
      `| Request Count | ${agg.requestCount} (${agg.errorCount} errors) |`,
      `| Bytes Sent | ${formatBytes(agg.bytesSent)} (${agg.bytesSent.toLocaleString("en-US")} B) |`,
      `| Bytes Received (Wire / Decoded) | ${formatBytes(agg.bytesReceivedWire)} / ${formatBytes(agg.bytesReceivedDecoded)} |`,
      `| Overall Wall Elapsed | ${formatDuration(Math.round(agg.overallWallElapsedMs))} |`,
      `| Latency Avg / P50 / P95 / P99 | ${agg.avgLatencyMs.toFixed(1)} / ${agg.p50LatencyMs.toFixed(1)} / ${agg.p95LatencyMs.toFixed(1)} / ${agg.p99LatencyMs.toFixed(1)} ms |`,
      ...(agg.avgTtfbMs !== null
        ? [
            `| TTFB Avg / P50 / P95 / P99 | ${agg.avgTtfbMs.toFixed(1)} / ${agg.p50TtfbMs?.toFixed(1)} / ${agg.p95TtfbMs?.toFixed(1)} / ${agg.p99TtfbMs?.toFixed(1)} ms |`,
          ]
        : []),
      "",
      "### Top Slowest URLs",
      "",
      "| # | Method | Status | URL | Duration |",
      "| --- | --- | --- | --- | --- |",
      ...agg.topSlowest.map(
        (s) =>
          `| #${s.id} | ${s.method} | ${s.status} | \`${s.host}${s.path}\` | ${s.durationMs} ms |`
      ),
    ];
    return lines.join("\n");
  }

  if (!detail) return "_No session selected._";
  const s = detail.summary;
  const xfer = computeTransferMetrics(detail);
  const timingSummary = normalizeTimingPhases(detail);

  const lines: string[] = [
    `## Session #${s.id} — \`${s.method} ${s.url}\``,
    "",
    `- **Status**: \`${s.status}\` (${s.protocol})`,
    `- **Overall Elapsed**: ${formatMsPrecise(timingSummary.overallElapsedMs)}`,
    `- **Wire Transfer**: ${formatBytes(xfer.totalWireBytes)} (Sent ${formatBytes(xfer.requestTotalWireBytes)}, Received ${formatBytes(xfer.responseTotalWireBytes)})${xfer.isCompressed ? ` — ${xfer.encoding || "compressed"} saved ${xfer.savingsPercent.toFixed(1)}%` : ""}`,
    "",
    "### Timing Phases",
    "",
    "| Phase | Duration | Share |",
    "| --- | --- | --- |",
    ...timingSummary.phases.map(
      (p) =>
        `| ${p.label} | ${formatMsPrecise(p.durationMs)} | ${p.percent.toFixed(1)}% |`
    ),
  ];

  return lines.join("\n");
}

/**
 * Formats a concise multi-phase tooltip string for TrafficGrid's `Time` cell.
 */
export function formatTimeCellTooltip(
  session: SessionSummary,
  prefixLabel?: string | null
): string {
  const parts: string[] = [];
  if (prefixLabel) parts.push(prefixLabel);

  parts.push(`Total: ${formatDuration(session.durationMs)}`);

  const phases: string[] = [];
  if (isFiniteNonNeg(session.dnsMs)) {
    phases.push(`DNS ${formatMsPrecise(session.dnsMs)}`);
  }
  if (isFiniteNonNeg(session.connectMs)) {
    phases.push(`TCP ${formatMsPrecise(session.connectMs)}`);
  }
  if (isFiniteNonNeg(session.tlsMs)) {
    phases.push(`TLS ${formatMsPrecise(session.tlsMs)}`);
  }
  if (isFiniteNonNeg(session.ttfbMs)) {
    phases.push(`TTFB ${formatMsPrecise(session.ttfbMs)}`);
  }
  if (isFiniteNonNeg(session.receiveMs)) {
    phases.push(`Recv ${formatMsPrecise(session.receiveMs)}`);
  }

  if (phases.length > 0) {
    parts.push(phases.join(" · "));
  }
  if (session.serverConnReused === true) {
    parts.push("Connection: Reused");
  } else if (session.serverConnReused === false) {
    parts.push("Connection: Cold");
  }
  if (session.serverIp) {
    parts.push(`Server IP: ${session.serverIp}`);
  }

  return parts.join("\n");
}
