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

export type StatusBucketGroup =
  | "2xx"
  | "3xx"
  | "4xx"
  | "5xx"
  | "Pending"
  | "Other";

export interface StatusBucket {
  group: StatusBucketGroup;
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

export interface HostBucket {
  host: string;
  count: number;
  errorCount: number;
  bytes: number;
  wireBytes: number;
  totalDurationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
  percentOfRequests: number;
  percentOfBytes: number;
}

export interface MultiSessionStatistics {
  requestCount: number;
  completedCount: number;
  pendingCount: number;
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
  ttfbCount: number;
  avgTtfbMs: number | null;
  p50TtfbMs: number | null;
  p95TtfbMs: number | null;
  p99TtfbMs: number | null;
  statusBuckets: StatusBucket[];
  allStatusBuckets: StatusBucket[];
  mimeBuckets: MimeBucket[];
  hostBuckets: HostBucket[];
  topSlowest: SessionSummary[];
  topLargest: SessionSummary[];
}

export type WaterfallPhaseKey = "dns" | "connect" | "tls" | "ttfb" | "receive";

export interface WaterfallPhaseDef {
  key: WaterfallPhaseKey;
  summaryField: "dnsMs" | "connectMs" | "tlsMs" | "ttfbMs" | "receiveMs";
  label: string;
  shortLabel: string;
  color: string;
  description: string;
}

export interface WaterfallPhaseSegment {
  key: WaterfallPhaseKey;
  label: string;
  shortLabel: string;
  durationMs: number;
  widthPercent: number;
  sharePercent: number;
  color: string;
  description: string;
}

export interface SessionWaterfallBreakdown {
  segments: WaterfallPhaseSegment[];
  recordedPhaseSumMs: number;
  totalDurationMs: number;
  isFallback: boolean;
  fallbackColor: string;
  fallbackLabel: string;
}

export interface WaterfallRowTiming {
  session: SessionSummary;
  startMs: number;
  offsetMs: number;
  durationMs: number;
  endOffsetMs: number;
}

export interface WaterfallTimelineData {
  rows: WaterfallRowTiming[];
  minStartMs: number;
  maxEndMs: number;
  totalSpanMs: number;
  hasValidTimestamps: boolean;
}

export interface TimeRulerTick {
  offsetMs: number;
  label: string;
  positionPercent: number;
}

export interface TrafficStatisticsMarkdownOptions {
  scopeLabel?: string;
  totalCapturedCount?: number;
  filterQuery?: string;
  generatedAtIso?: string;
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

/**
 * Compact 5-phase waterfall definitions reusing Stage 34 timing semantics from `SessionSummary`.
 */
export const WATERFALL_PHASE_DEFS: readonly WaterfallPhaseDef[] = [
  {
    key: "dns",
    summaryField: "dnsMs",
    label: "DNS Lookup",
    shortLabel: "DNS",
    color: "#2dd4bf",
    description: "Upstream hostname DNS resolution (0 ms if pooled/reused).",
  },
  {
    key: "connect",
    summaryField: "connectMs",
    label: "TCP Connect",
    shortLabel: "TCP",
    color: "#f59e0b",
    description: "TCP three-way handshake to upstream server.",
  },
  {
    key: "tls",
    summaryField: "tlsMs",
    label: "TLS Handshake",
    shortLabel: "TLS",
    color: "#a855f7",
    description: "TLS negotiation and certificate verification with upstream.",
  },
  {
    key: "ttfb",
    summaryField: "ttfbMs",
    label: "Wait (TTFB)",
    shortLabel: "TTFB",
    color: "#10b981",
    description: "Waiting for first response byte after sending request.",
  },
  {
    key: "receive",
    summaryField: "receiveMs",
    label: "Download",
    shortLabel: "Download",
    color: "#3b82f6",
    description: "Reading full response body from upstream server.",
  },
] as const;

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

/**
 * Parses a `SessionSummary.timestamp` string into epoch milliseconds (or ms-of-day
 * for legacy clock-only `HH:mm:ss.SSS` values). Returns `NaN` if unparseable.
 */
export function parseSessionTimestampMs(timestamp: string): number {
  const trimmed = timestamp.trim();
  if (!trimmed) return NaN;

  const isoMs = parseIsoEpochMsPrecise(trimmed);
  if (Number.isFinite(isoMs)) return isoMs;

  const clockMatch = trimmed.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (clockMatch) {
    const hh = Number(clockMatch[1]);
    const mm = Number(clockMatch[2]);
    const ss = Number(clockMatch[3]);
    const fracRaw = clockMatch[4] ?? "";
    const fracMs =
      fracRaw.length > 0
        ? Number(fracRaw.padEnd(6, "0").slice(0, 6)) / 1000
        : 0;
    if (
      Number.isFinite(hh) &&
      Number.isFinite(mm) &&
      Number.isFinite(ss) &&
      Number.isFinite(fracMs)
    ) {
      return ((hh * 3600 + mm * 60 + ss) * 1000) + fracMs;
    }
  }

  return NaN;
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
export function computePercentile(
  sortedValues: ArrayLike<number>,
  p: number
): number {
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

export function isSessionPending(session: SessionSummary): boolean {
  return (
    Boolean(session.breakpointPaused) ||
    (session.status === 0 && !session.error && !session.tlsBypassed)
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

function insertTopK(
  list: SessionSummary[],
  item: SessionSummary,
  score: (s: SessionSummary) => number,
  k = 5
): void {
  const itemScore = score(item);
  if (list.length === k && itemScore <= score(list[k - 1])) {
    return;
  }
  let insertAt = list.length;
  while (insertAt > 0 && itemScore > score(list[insertAt - 1])) {
    insertAt -= 1;
  }
  list.splice(insertAt, 0, item);
  if (list.length > k) {
    list.pop();
  }
}

/**
 * Aggregates Fiddler-style multi-selection or full-sample KPIs, percentile latency/TTFB,
 * status (`2xx/3xx/4xx/5xx/Pending/Other`), MIME, host breakdowns, and Top-5 tables in a single O(N) pass.
 */
export function aggregateSessionsStatistics(
  sessions: SessionSummary[]
): MultiSessionStatistics {
  const requestCount = sessions.length;
  let completedCount = 0;
  let pendingCount = 0;
  let errorCount = 0;
  let reusedCount = 0;
  let coldCount = 0;
  let unknownReuseCount = 0;
  let bytesSent = 0;
  let bytesReceivedDecoded = 0;
  let bytesReceivedWire = 0;
  let cumulativeDurationMs = 0;
  let cumulativeTtfbMs = 0;

  const latencies = new Float64Array(requestCount);
  const ttfbs: number[] = [];

  let minStartMs = Number.POSITIVE_INFINITY;
  let maxEndMs = Number.NEGATIVE_INFINITY;

  const statusAcc: Record<
    StatusBucketGroup,
    { count: number; bytes: number; label: string; color: string }
  > = {
    "2xx": { count: 0, bytes: 0, label: "2xx Success", color: "#10b981" },
    "3xx": { count: 0, bytes: 0, label: "3xx Redirect", color: "#f59e0b" },
    "4xx": { count: 0, bytes: 0, label: "4xx Client Err", color: "#f97316" },
    "5xx": { count: 0, bytes: 0, label: "5xx Server Err", color: "#ef4444" },
    Pending: { count: 0, bytes: 0, label: "Pending", color: "#38bdf8" },
    Other: { count: 0, bytes: 0, label: "Other / WS / Tunnel", color: "#8b5cf6" },
  };

  const mimeAcc = new Map<
    string,
    { count: number; bytes: number; wireBytes: number }
  >();

  const hostAcc = new Map<
    string,
    {
      count: number;
      errorCount: number;
      bytes: number;
      wireBytes: number;
      totalDurationMs: number;
      maxDurationMs: number;
    }
  >();

  const topSlowest: SessionSummary[] = [];
  const topLargest: SessionSummary[] = [];

  for (let i = 0; i < requestCount; i += 1) {
    const s = sessions[i];
    const dur = Math.max(0, Number.isFinite(s.durationMs) ? s.durationMs : 0);
    latencies[i] = dur;
    cumulativeDurationMs += dur;

    if (isFiniteNonNeg(s.ttfbMs)) {
      ttfbs.push(s.ttfbMs);
      cumulativeTtfbMs += s.ttfbMs;
    }

    const pending = isSessionPending(s);
    if (pending) {
      pendingCount += 1;
    } else if (s.status > 0) {
      completedCount += 1;
    }

    const isErr = Boolean(s.error || s.status >= 400);
    if (isErr) errorCount += 1;

    if (s.serverConnReused === true) reusedCount += 1;
    else if (s.serverConnReused === false) coldCount += 1;
    else unknownReuseCount += 1;

    const reqBytes = isFiniteNonNeg(s.requestSize) ? s.requestSize : 0;
    const decBytes = Math.max(0, Number.isFinite(s.bodySize) ? s.bodySize : 0);
    const wireBytes = isFiniteNonNeg(s.wireBodySize)
      ? s.wireBodySize
      : decBytes;

    bytesSent += reqBytes;
    bytesReceivedDecoded += decBytes;
    bytesReceivedWire += wireBytes;

    const parsedStart = parseSessionTimestampMs(s.timestamp);
    if (Number.isFinite(parsedStart)) {
      if (parsedStart < minStartMs) minStartMs = parsedStart;
      if (parsedStart + dur > maxEndMs) maxEndMs = parsedStart + dur;
    }

    const bucketKey: StatusBucketGroup = pending
      ? "Pending"
      : s.status >= 200 && s.status < 300
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
    const existingMime = mimeAcc.get(mimeGroup);
    if (existingMime) {
      existingMime.count += 1;
      existingMime.bytes += decBytes;
      existingMime.wireBytes += wireBytes;
    } else {
      mimeAcc.set(mimeGroup, { count: 1, bytes: decBytes, wireBytes });
    }

    const hostKey = s.host.trim() || "(unknown)";
    const existingHost = hostAcc.get(hostKey);
    if (existingHost) {
      existingHost.count += 1;
      if (isErr) existingHost.errorCount += 1;
      existingHost.bytes += decBytes;
      existingHost.wireBytes += wireBytes;
      existingHost.totalDurationMs += dur;
      if (dur > existingHost.maxDurationMs) existingHost.maxDurationMs = dur;
    } else {
      hostAcc.set(hostKey, {
        count: 1,
        errorCount: isErr ? 1 : 0,
        bytes: decBytes,
        wireBytes,
        totalDurationMs: dur,
        maxDurationMs: dur,
      });
    }

    insertTopK(topSlowest, s, (x) => x.durationMs, 5);
    insertTopK(topLargest, s, (x) => x.bodySize, 5);
  }

  latencies.sort();
  const sortedTtfbs = Float64Array.from(ttfbs);
  sortedTtfbs.sort();

  const avgLatencyMs =
    requestCount > 0 ? cumulativeDurationMs / requestCount : 0;
  const minLatencyMs = requestCount > 0 ? latencies[0] : 0;
  const maxLatencyMs = requestCount > 0 ? latencies[requestCount - 1] : 0;

  const avgTtfbMs =
    sortedTtfbs.length > 0 ? cumulativeTtfbMs / sortedTtfbs.length : null;

  const overallWallElapsedMs =
    Number.isFinite(minStartMs) &&
    Number.isFinite(maxEndMs) &&
    maxEndMs >= minStartMs
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

  const statusOrder: StatusBucketGroup[] = [
    "2xx",
    "3xx",
    "4xx",
    "5xx",
    "Pending",
    "Other",
  ];
  const makeStatusBucket = (group: StatusBucketGroup): StatusBucket => ({
    group,
    label: statusAcc[group].label,
    count: statusAcc[group].count,
    percent: requestCount > 0 ? (statusAcc[group].count / requestCount) * 100 : 0,
    bytes: statusAcc[group].bytes,
    color: statusAcc[group].color,
  });

  const statusBuckets: StatusBucket[] = statusOrder
    .filter((k) => statusAcc[k].count > 0)
    .map(makeStatusBucket);

  const allStatusBuckets: StatusBucket[] = statusOrder
    .filter((k) => k !== "Other" || statusAcc[k].count > 0)
    .map(makeStatusBucket);

  const mimeTotalBytes = bytesReceivedWire;
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

  const hostBuckets: HostBucket[] = Array.from(hostAcc.entries())
    .sort(
      (a, b) =>
        b[1].count - a[1].count ||
        b[1].wireBytes - a[1].wireBytes ||
        a[0].localeCompare(b[0])
    )
    .map(([host, val]) => ({
      host,
      count: val.count,
      errorCount: val.errorCount,
      bytes: val.bytes,
      wireBytes: val.wireBytes,
      totalDurationMs: val.totalDurationMs,
      avgDurationMs: val.count > 0 ? val.totalDurationMs / val.count : 0,
      maxDurationMs: val.maxDurationMs,
      percentOfRequests: requestCount > 0 ? (val.count / requestCount) * 100 : 0,
      percentOfBytes:
        bytesReceivedWire > 0 ? (val.wireBytes / bytesReceivedWire) * 100 : 0,
    }));

  return {
    requestCount,
    completedCount,
    pendingCount,
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
    ttfbCount: sortedTtfbs.length,
    avgTtfbMs,
    p50TtfbMs:
      sortedTtfbs.length > 0 ? computePercentile(sortedTtfbs, 50) : null,
    p95TtfbMs:
      sortedTtfbs.length > 0 ? computePercentile(sortedTtfbs, 95) : null,
    p99TtfbMs:
      sortedTtfbs.length > 0 ? computePercentile(sortedTtfbs, 99) : null,
    statusBuckets,
    allStatusBuckets,
    mimeBuckets,
    hostBuckets,
    topSlowest,
    topLargest,
  };
}

function resolveWaterfallFallbackStyle(session: SessionSummary): {
  color: string;
  label: string;
} {
  if (isSessionPending(session)) {
    return {
      color: "#38bdf8",
      label: session.breakpointPaused ? "Paused (Breakpoint)" : "Pending",
    };
  }
  if (session.error || session.status >= 500) {
    return {
      color: "#ef4444",
      label: session.status >= 500 ? `${session.status} Server Error` : "Transport Error",
    };
  }
  if (session.status >= 400) {
    return { color: "#f97316", label: `${session.status} Client Error` };
  }
  if (session.status >= 300) {
    return { color: "#f59e0b", label: `${session.status} Redirect` };
  }
  const scheme = session.scheme.toLowerCase();
  if (session.status === 101 || scheme === "ws" || scheme === "wss") {
    return { color: "#8b5cf6", label: "WebSocket" };
  }
  const ct = session.contentType.toLowerCase();
  if (ct.includes("text/event-stream")) {
    return { color: "#14b8a6", label: "SSE Stream" };
  }
  if (
    ct.includes("json") ||
    ct.includes("graphql") ||
    ct.includes("grpc") ||
    ct.includes("protobuf")
  ) {
    return { color: "#3b82f6", label: "API / JSON" };
  }
  if (ct.includes("javascript") || ct.includes("ecmascript")) {
    return { color: "#eab308", label: "JavaScript" };
  }
  if (ct.includes("text/css")) {
    return { color: "#6366f1", label: "CSS" };
  }
  if (ct.includes("text/html")) {
    return { color: "#06b6d4", label: "HTML" };
  }
  if (ct.startsWith("image/")) {
    return { color: "#ec4899", label: "Image" };
  }
  if (ct.startsWith("font/") || ct.includes("woff")) {
    return { color: "#a855f7", label: "Font" };
  }
  return {
    color: "#10b981",
    label: session.status >= 200 ? `${session.status} OK` : "HTTP",
  };
}

/**
 * Resolves compact `SessionSummary` timing fields (`dnsMs`, `connectMs`, `tlsMs`,
 * `ttfbMs`, `receiveMs`) into stacked Waterfall Timeline segments, falling back
 * to a single semantic status/MIME bar when per-phase data is absent.
 */
export function buildSessionWaterfallPhases(
  session: SessionSummary
): SessionWaterfallBreakdown {
  const totalDurationMs = Math.max(
    0,
    Number.isFinite(session.durationMs) ? session.durationMs : 0
  );
  const fallback = resolveWaterfallFallbackStyle(session);

  let hasAnyPhaseField = false;
  let recordedPhaseSumMs = 0;
  const rawSegments: {
    def: WaterfallPhaseDef;
    durationMs: number;
  }[] = [];

  for (const def of WATERFALL_PHASE_DEFS) {
    const val = session[def.summaryField];
    if (isFiniteNonNeg(val)) {
      hasAnyPhaseField = true;
      recordedPhaseSumMs += val;
      if (val > 0) {
        rawSegments.push({ def, durationMs: val });
      }
    }
  }

  if (!hasAnyPhaseField || rawSegments.length === 0) {
    return {
      segments: [],
      recordedPhaseSumMs: 0,
      totalDurationMs,
      isFallback: true,
      fallbackColor: fallback.color,
      fallbackLabel: fallback.label,
    };
  }

  const scaleBase = Math.max(totalDurationMs, recordedPhaseSumMs, 0.001);
  const segments: WaterfallPhaseSegment[] = rawSegments.map(
    ({ def, durationMs }) => ({
      key: def.key,
      label: def.label,
      shortLabel: def.shortLabel,
      durationMs,
      widthPercent: (durationMs / scaleBase) * 100,
      sharePercent:
        recordedPhaseSumMs > 0 ? (durationMs / recordedPhaseSumMs) * 100 : 0,
      color: def.color,
      description: def.description,
    })
  );

  return {
    segments,
    recordedPhaseSumMs,
    totalDurationMs,
    isFallback: false,
    fallbackColor: fallback.color,
    fallbackLabel: fallback.label,
  };
}

/**
 * Computes relative Waterfall Timeline offsets (`offsetMs = startMs - minStartMs`)
 * across a session list in O(N) time.
 */
export function buildWaterfallTimelineData(
  sessions: SessionSummary[]
): WaterfallTimelineData {
  const count = sessions.length;
  if (count === 0) {
    return {
      rows: [],
      minStartMs: 0,
      maxEndMs: 0,
      totalSpanMs: 1,
      hasValidTimestamps: false,
    };
  }

  const parsedStarts = new Float64Array(count);
  let minStartMs = Number.POSITIVE_INFINITY;
  let maxEndMs = Number.NEGATIVE_INFINITY;
  let hasValidTimestamps = false;

  for (let i = 0; i < count; i += 1) {
    const s = sessions[i];
    const dur = Math.max(0, Number.isFinite(s.durationMs) ? s.durationMs : 0);
    const startMs = parseSessionTimestampMs(s.timestamp);
    parsedStarts[i] = startMs;
    if (Number.isFinite(startMs)) {
      hasValidTimestamps = true;
      if (startMs < minStartMs) minStartMs = startMs;
      if (startMs + dur > maxEndMs) maxEndMs = startMs + dur;
    }
  }

  if (!hasValidTimestamps) {
    let maxDur = 1;
    const rows: WaterfallRowTiming[] = new Array(count);
    for (let i = 0; i < count; i += 1) {
      const s = sessions[i];
      const dur = Math.max(0, Number.isFinite(s.durationMs) ? s.durationMs : 0);
      if (dur > maxDur) maxDur = dur;
      rows[i] = {
        session: s,
        startMs: 0,
        offsetMs: 0,
        durationMs: dur,
        endOffsetMs: dur,
      };
    }
    return {
      rows,
      minStartMs: 0,
      maxEndMs: maxDur,
      totalSpanMs: Math.max(1, maxDur),
      hasValidTimestamps: false,
    };
  }

  const rows: WaterfallRowTiming[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const s = sessions[i];
    const dur = Math.max(0, Number.isFinite(s.durationMs) ? s.durationMs : 0);
    const rawStart = parsedStarts[i];
    const effectiveStart = Number.isFinite(rawStart) ? rawStart : minStartMs;
    const offsetMs = Math.max(0, effectiveStart - minStartMs);
    const endOffsetMs = offsetMs + dur;
    if (minStartMs + endOffsetMs > maxEndMs) {
      maxEndMs = minStartMs + endOffsetMs;
    }
    rows[i] = {
      session: s,
      startMs: effectiveStart,
      offsetMs,
      durationMs: dur,
      endOffsetMs,
    };
  }

  return {
    rows,
    minStartMs,
    maxEndMs,
    totalSpanMs: Math.max(1, maxEndMs - minStartMs),
    hasValidTimestamps: true,
  };
}

export function formatRulerOffset(offsetMs: number): string {
  if (!Number.isFinite(offsetMs) || offsetMs <= 0) return "0 ms";
  if (offsetMs < 1000) {
    return offsetMs < 10 && offsetMs % 1 !== 0
      ? `${offsetMs.toFixed(1)} ms`
      : `${Math.round(offsetMs)} ms`;
  }
  if (offsetMs < 60_000) {
    const secs = offsetMs / 1000;
    return secs >= 10 && Number.isInteger(secs)
      ? `${secs.toFixed(0)} s`
      : `${secs.toFixed(secs < 10 ? 2 : 1)} s`;
  }
  const totalSecs = Math.round(offsetMs / 1000);
  const mins = Math.floor(totalSecs / 60);
  const remSecs = totalSecs % 60;
  return remSecs === 0 ? `${mins}m` : `${mins}m ${remSecs}s`;
}

/**
 * Generates non-overlapping "nice" millisecond/second tick positions for a Waterfall ruler.
 */
export function computeTimeRulerTicks(
  totalSpanMs: number,
  trackWidthPx: number
): TimeRulerTick[] {
  const safeSpan = Math.max(1, Number.isFinite(totalSpanMs) ? totalSpanMs : 1);
  const safeWidth = Math.max(120, Number.isFinite(trackWidthPx) ? trackWidthPx : 600);
  const targetCount = Math.max(2, Math.min(30, Math.floor(safeWidth / 110)));
  const rawStep = safeSpan / targetCount;

  const niceSteps = [
    1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1_000, 2_000, 5_000, 10_000,
    15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000,
  ];
  let step = niceSteps.find((candidate) => candidate >= rawStep);
  if (!step) {
    const pow10 = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const mult = rawStep / pow10;
    step = (mult <= 1 ? 1 : mult <= 2 ? 2 : mult <= 5 ? 5 : 10) * pow10;
  }

  const ticks: TimeRulerTick[] = [];
  for (let ms = 0; ms <= safeSpan; ms += step) {
    ticks.push({
      offsetMs: ms,
      label: formatRulerOffset(ms),
      positionPercent: (ms / safeSpan) * 100,
    });
    if (ticks.length > 64) break;
  }
  return ticks;
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
  const serverDisplay = stats?.viaProxyAddr
    ? stats?.serverIp || s.serverIp || s.host
    : stats?.serverAddr || stats?.serverIp || s.serverIp || s.host;
  lines.push(
    `  Server:               ${serverDisplay} (reused=${stats?.serverConnReused ?? s.serverConnReused ?? "—"}, proto=${stats?.serverHttpVersion || "—"})`
  );
  if (stats?.viaProxyAddr) {
    lines.push(`  Upstream Proxy:       ${stats.viaProxyAddr}`);
  }
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

function escapeMdTableCell(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`");
}

/**
 * Generates a comprehensive GitHub-flavored Markdown report from pre-aggregated
 * `MultiSessionStatistics` (reusing Stage 34 metrics without recomputing on 10,000+ rows).
 */
export function formatTrafficStatisticsMarkdown(
  stats: MultiSessionStatistics,
  options?: TrafficStatisticsMarkdownOptions
): string {
  const scopeLabel = options?.scopeLabel ?? "Filtered Sample";
  const countPart =
    typeof options?.totalCapturedCount === "number" &&
    options.totalCapturedCount !== stats.requestCount
      ? `${stats.requestCount.toLocaleString("en-US")} of ${options.totalCapturedCount.toLocaleString("en-US")} sessions`
      : `${stats.requestCount.toLocaleString("en-US")} sessions`;

  const lines: string[] = [
    `# FluxProxy Traffic Statistics Report`,
    "",
    `- **Scope**: ${scopeLabel} (${countPart})`,
  ];

  if (options?.filterQuery?.trim()) {
    lines.push(
      `- **Active Filter**: \`${escapeMdTableCell(options.filterQuery.trim())}\``
    );
  }
  if (options?.generatedAtIso) {
    lines.push(`- **Generated At**: \`${options.generatedAtIso}\``);
  }

  if (stats.requestCount === 0) {
    lines.push("", "_No captured sessions in this selection._");
    return lines.join("\n");
  }

  const errorPct = ((stats.errorCount / stats.requestCount) * 100).toFixed(1);
  const pendingPct = ((stats.pendingCount / stats.requestCount) * 100).toFixed(1);

  lines.push(
    "",
    "## Summary Metrics",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Total Sessions | ${stats.requestCount.toLocaleString("en-US")} (${stats.completedCount.toLocaleString("en-US")} completed, ${stats.pendingCount.toLocaleString("en-US")} pending (${pendingPct}%), ${stats.errorCount.toLocaleString("en-US")} errors (${errorPct}%)) |`,
    `| Overall Wall Elapsed | ${formatDuration(Math.round(stats.overallWallElapsedMs))} (cumulative: ${formatDuration(Math.round(stats.cumulativeDurationMs))}) |`,
    `| Decoded Body Size | ${formatBytes(stats.bytesReceivedDecoded)} (${stats.bytesReceivedDecoded.toLocaleString("en-US")} B) |`,
    `| Wire Body Size | ${formatBytes(stats.bytesReceivedWire)} (${stats.bytesReceivedWire.toLocaleString("en-US")} B)${stats.compressionSavedBytes > 0 ? ` — saved ${formatBytes(stats.compressionSavedBytes)} (${stats.compressionSavingsPercent.toFixed(1)}%)` : ""} |`,
    `| Request Bytes Sent | ${formatBytes(stats.bytesSent)} (${stats.bytesSent.toLocaleString("en-US")} B) |`,
    `| Duration (Avg / Median / P95 / P99) | ${formatMsPrecise(stats.avgLatencyMs)} / ${formatMsPrecise(stats.p50LatencyMs)} / ${formatMsPrecise(stats.p95LatencyMs)} / ${formatMsPrecise(stats.p99LatencyMs)} |`,
    `| Duration (Min / Max) | ${formatMsPrecise(stats.minLatencyMs)} / ${formatMsPrecise(stats.maxLatencyMs)} |`
  );

  if (stats.avgTtfbMs !== null) {
    lines.push(
      `| TTFB (Avg / Median / P95 / P99) | ${formatMsPrecise(stats.avgTtfbMs)} / ${formatMsPrecise(stats.p50TtfbMs)} / ${formatMsPrecise(stats.p95TtfbMs)} / ${formatMsPrecise(stats.p99TtfbMs)} (${stats.ttfbCount.toLocaleString("en-US")}/${stats.requestCount.toLocaleString("en-US")}) |`
    );
  }

  if (stats.reuseRatePercent !== null) {
    lines.push(
      `| Connection Reuse | ${stats.reusedCount.toLocaleString("en-US")}/${(stats.reusedCount + stats.coldCount).toLocaleString("en-US")} (${stats.reuseRatePercent.toFixed(1)}%) |`
    );
  }

  lines.push(
    "",
    "## Status Code Distribution",
    "",
    "| Status Group | Count | Share | Wire Bytes |",
    "| --- | ---: | ---: | ---: |",
    ...stats.allStatusBuckets.map(
      (b) =>
        `| ${b.label} | ${b.count.toLocaleString("en-US")} | ${b.percent.toFixed(1)}% | ${formatBytes(b.bytes)} |`
    )
  );

  if (stats.mimeBuckets.length > 0) {
    const topMimes = stats.mimeBuckets.slice(0, 10);
    lines.push(
      "",
      "## Breakdown by Content-Type",
      "",
      "| Content-Type | Requests | Decoded Size | Wire Size | Wire Share |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...topMimes.map(
        (m) =>
          `| \`${escapeMdTableCell(m.mimeGroup)}\` | ${m.count.toLocaleString("en-US")} | ${formatBytes(m.bytes)} | ${formatBytes(m.wireBytes)} | ${m.percentOfBytes.toFixed(1)}% |`
      )
    );
  }

  if (stats.hostBuckets.length > 0) {
    const topHosts = stats.hostBuckets.slice(0, 10);
    lines.push(
      "",
      `## Breakdown by Host (${stats.hostBuckets.length.toLocaleString("en-US")} unique)`,
      "",
      "| Host | Requests | Share | Errors | Wire Size | Avg Duration |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      ...topHosts.map(
        (h) =>
          `| \`${escapeMdTableCell(h.host)}\` | ${h.count.toLocaleString("en-US")} | ${h.percentOfRequests.toFixed(1)}% | ${h.errorCount.toLocaleString("en-US")} | ${formatBytes(h.wireBytes)} | ${formatMsPrecise(h.avgDurationMs)} |`
      )
    );
  }

  if (stats.topSlowest.length > 0) {
    lines.push(
      "",
      "## Top 5 Slowest URLs",
      "",
      "| # | Method | Status | URL | Duration | TTFB |",
      "| --- | --- | ---: | --- | ---: | ---: |",
      ...stats.topSlowest.map(
        (s) =>
          `| #${s.id} | ${escapeMdTableCell(s.method)} | ${s.status || "Pending"} | \`${escapeMdTableCell(`${s.host}${s.path}`)}\` | ${formatDuration(s.durationMs)} | ${isFiniteNonNeg(s.ttfbMs) ? formatMsPrecise(s.ttfbMs) : "—"} |`
      )
    );
  }

  if (stats.topLargest.length > 0) {
    lines.push(
      "",
      "## Top 5 Heaviest URLs",
      "",
      "| # | Method | Status | URL | Decoded Size | Wire Size |",
      "| --- | --- | ---: | --- | ---: | ---: |",
      ...stats.topLargest.map((s) => {
        const wire = isFiniteNonNeg(s.wireBodySize) ? s.wireBodySize : s.bodySize;
        return `| #${s.id} | ${escapeMdTableCell(s.method)} | ${s.status || "Pending"} | \`${escapeMdTableCell(`${s.host}${s.path}`)}\` | ${formatBytes(s.bodySize)} | ${formatBytes(wire)} |`;
      })
    );
  }

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
