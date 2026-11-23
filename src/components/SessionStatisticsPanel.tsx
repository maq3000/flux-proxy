import React, { useEffect, useId, useMemo, useState } from "react";
import {
  Activity,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Database,
  FileText,
  Globe,
  HardDriveDownload,
  Lock,
  Network,
  Server,
  Zap,
} from "lucide-react";
import { formatBytes, formatDuration } from "../lib/formatters";
import {
  aggregateSessionsStatistics,
  buildFiddlerTimestampRows,
  computeTransferMetrics,
  estimateWorldwidePerformance,
  formatFiddlerStatisticsText,
  formatMsPrecise,
  formatStatisticsMarkdown,
  normalizeTimingPhases,
  type NormalizedTimingPhase,
} from "../lib/requestStatistics";
import type { SessionDetail, SessionSummary } from "../types/proxy";

interface SessionStatisticsPanelProps {
  detail: SessionDetail | null;
  selectedSessions?: SessionSummary[];
  onSelectSession?: (id: number) => void;
}

function getStatusBadgeClass(status: number): string {
  if (status >= 500 || status === 502 || status === 504) {
    return "bg-status5xx-bg text-status5xx-fg";
  }
  if (status >= 400) return "bg-status4xx-bg text-status4xx-fg";
  if (status === 101) return "bg-statusWs-bg text-statusWs-fg";
  if (status >= 300) return "bg-status3xx-bg text-status3xx-fg";
  if (status >= 200) return "bg-status2xx-bg text-status2xx-fg";
  return "bg-elevated text-muted";
}

function formatRate(bytesPerSec: number | null): string {
  if (bytesPerSec === null || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return "—";
  }
  return `${formatBytes(Math.round(bytesPerSec))}/s`;
}

export const SessionStatisticsPanel: React.FC<SessionStatisticsPanelProps> = ({
  detail,
  selectedSessions,
  onSelectSession,
}) => {
  const isMultiMode = Boolean(selectedSessions && selectedSessions.length >= 2);
  const baseTooltipId = useId();
  const [hoveredPhase, setHoveredPhase] =
    useState<NormalizedTimingPhase | null>(null);
  const [copiedMode, setCopiedMode] = useState<"text" | "md" | null>(null);

  useEffect(() => {
    setHoveredPhase(null);
  }, [detail?.summary.id, selectedSessions?.length]);

  useEffect(() => {
    if (!hoveredPhase) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHoveredPhase(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hoveredPhase]);

  const multiStats = useMemo(() => {
    if (!isMultiMode || !selectedSessions) return null;
    return aggregateSessionsStatistics(selectedSessions);
  }, [isMultiMode, selectedSessions]);

  const singleMetrics = useMemo(() => {
    if (isMultiMode || !detail) return null;
    return {
      timingSummary: normalizeTimingPhases(detail),
      timestampRows: buildFiddlerTimestampRows(detail),
      transfer: computeTransferMetrics(detail),
      worldwide: estimateWorldwidePerformance(detail),
    };
  }, [isMultiMode, detail]);

  const handleCopy = async (kind: "text" | "md") => {
    const content =
      kind === "text"
        ? formatFiddlerStatisticsText(
            detail,
            isMultiMode ? selectedSessions : undefined
          )
        : formatStatisticsMarkdown(
            detail,
            isMultiMode ? selectedSessions : undefined
          );
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMode(kind);
      window.setTimeout(() => {
        setCopiedMode((cur) => (cur === kind ? null : cur));
      }, 1500);
    } catch {
      // Clipboard unavailable in restricted test/browser contexts
    }
  };

  if (isMultiMode && multiStats && selectedSessions) {
    const maxMimeWireBytes = Math.max(
      1,
      ...multiStats.mimeBuckets.map((b) => b.wireBytes)
    );
    const totalStatusCount = Math.max(1, multiStats.requestCount);

    return (
      <div className="flex h-full flex-col overflow-auto bg-surface p-3 text-xs text-fg">
        {/* Top Action Bar */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-2">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-accent" aria-hidden="true" />
            <div>
              <h2 className="text-xs font-semibold text-fg">
                Multi-Session Statistics
              </h2>
              <p className="text-[11px] text-muted">
                Aggregated Fiddler Classic summary across{" "}
                <span className="font-mono font-semibold text-fg">
                  {multiStats.requestCount}
                </span>{" "}
                selected sessions
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleCopy("text")}
              className="inline-flex items-center gap-1 rounded border border-hairline bg-elevated px-2 py-1 text-[11px] font-medium text-fg hover:border-strong"
            >
              {copiedMode === "text" ? (
                <Check
                  className="h-3 w-3 text-status2xx-fg"
                  aria-hidden="true"
                />
              ) : (
                <Copy className="h-3 w-3 text-muted" aria-hidden="true" />
              )}
              <span>{copiedMode === "text" ? "Copied" : "Copy Text"}</span>
            </button>
            <button
              type="button"
              onClick={() => void handleCopy("md")}
              className="inline-flex items-center gap-1 rounded border border-hairline bg-elevated px-2 py-1 text-[11px] font-medium text-fg hover:border-strong"
            >
              {copiedMode === "md" ? (
                <Check
                  className="h-3 w-3 text-status2xx-fg"
                  aria-hidden="true"
                />
              ) : (
                <FileText className="h-3 w-3 text-muted" aria-hidden="true" />
              )}
              <span>{copiedMode === "md" ? "Copied" : "Copy Markdown"}</span>
            </button>
          </div>
        </div>

        {/* Summary KPI Strip */}
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <div className="rounded border border-hairline bg-elevated/50 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted">
              Request Count
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-fg">
              {multiStats.requestCount}
            </div>
            <div className="mt-0.5 text-[10px] text-subtle">
              {multiStats.errorCount > 0
                ? `${multiStats.errorCount} failed / 4xx+`
                : "0 errors"}
            </div>
          </div>

          <div className="rounded border border-hairline bg-elevated/50 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted">
              Bytes Sent
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-fg">
              {formatBytes(multiStats.bytesSent)}
            </div>
            <div className="mt-0.5 font-mono text-[10px] tabular-nums text-subtle">
              {multiStats.bytesSent.toLocaleString("en-US")} B
            </div>
          </div>

          <div className="rounded border border-hairline bg-elevated/50 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted">
              Bytes Received
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-fg">
              {formatBytes(multiStats.bytesReceivedWire)}
            </div>
            <div className="mt-0.5 font-mono text-[10px] tabular-nums text-subtle">
              {multiStats.compressionSavedBytes > 0
                ? `${formatBytes(multiStats.bytesReceivedDecoded)} decoded (-${multiStats.compressionSavingsPercent.toFixed(1)}%)`
                : `${multiStats.bytesReceivedDecoded.toLocaleString("en-US")} B decoded`}
            </div>
          </div>

          <div className="rounded border border-hairline bg-elevated/50 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted">
              Overall Elapsed
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-fg">
              {formatDuration(Math.round(multiStats.overallWallElapsedMs))}
            </div>
            <div className="mt-0.5 font-mono text-[10px] tabular-nums text-subtle">
              Sum {formatDuration(Math.round(multiStats.cumulativeDurationMs))}
            </div>
          </div>

          <div className="rounded border border-hairline bg-elevated/50 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted">
              Latency (Avg / P95)
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-fg">
              {formatMsPrecise(multiStats.avgLatencyMs)}
            </div>
            <div className="mt-0.5 font-mono text-[10px] tabular-nums text-subtle">
              P50 {formatMsPrecise(multiStats.p50LatencyMs)} · P95{" "}
              {formatMsPrecise(multiStats.p95LatencyMs)} · P99{" "}
              {formatMsPrecise(multiStats.p99LatencyMs)}
            </div>
          </div>

          <div className="rounded border border-hairline bg-elevated/50 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted">
              TTFB & Pool Reuse
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-fg">
              {multiStats.avgTtfbMs !== null
                ? formatMsPrecise(multiStats.avgTtfbMs)
                : "—"}
            </div>
            <div className="mt-0.5 font-mono text-[10px] tabular-nums text-subtle">
              {multiStats.reuseRatePercent !== null
                ? `Reused ${multiStats.reusedCount}/${multiStats.reusedCount + multiStats.coldCount} (${multiStats.reuseRatePercent.toFixed(0)}%)`
                : "Reuse: unknown"}
            </div>
          </div>
        </div>

        {/* Status Distribution & Bytes by Content-Type (Inline Accessible SVGs) */}
        <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded border border-hairline bg-elevated/35 p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Status Code Breakdown
              </h3>
              <span className="font-mono text-[10px] text-subtle">
                {multiStats.requestCount} responses
              </span>
            </div>

            <svg
              role="img"
              aria-label={`HTTP status distribution across ${multiStats.requestCount} requests`}
              viewBox="0 0 360 20"
              className="mb-2.5 h-5 w-full overflow-hidden rounded bg-canvas"
            >
              <title>HTTP Status Code Distribution Bar</title>
              {(() => {
                let x = 0;
                return multiStats.statusBuckets.map((bucket) => {
                  const width = (bucket.count / totalStatusCount) * 360;
                  const rect = (
                    <rect
                      key={bucket.group}
                      x={x}
                      y={0}
                      width={Math.max(width, 1)}
                      height={20}
                      fill={bucket.color}
                    >
                      <title>
                        {`${bucket.label}: ${bucket.count} (${bucket.percent.toFixed(1)}%), ${formatBytes(bucket.bytes)}`}
                      </title>
                    </rect>
                  );
                  x += width;
                  return rect;
                });
              })()}
            </svg>

            <div className="space-y-1">
              {multiStats.statusBuckets.map((b) => (
                <div
                  key={b.group}
                  className="flex items-center justify-between gap-2 text-[11px]"
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-xs"
                      style={{ backgroundColor: b.color }}
                      aria-hidden="true"
                    />
                    <span className="font-medium text-fg">{b.label}</span>
                  </div>
                  <div className="font-mono tabular-nums text-muted">
                    {b.count} ({b.percent.toFixed(1)}%) · {formatBytes(b.bytes)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded border border-hairline bg-elevated/35 p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Bytes by Content-Type (Wire)
              </h3>
              <span className="font-mono text-[10px] text-subtle">
                {formatBytes(multiStats.bytesReceivedWire)}
              </span>
            </div>

            {(() => {
              const visibleMimes = multiStats.mimeBuckets.slice(0, 6);
              const svgHeight = Math.max(24, visibleMimes.length * 22);
              return (
                <svg
                  role="img"
                  aria-label={`Wire bytes by Content-Type across ${visibleMimes.length} categories`}
                  viewBox={`0 0 420 ${svgHeight}`}
                  className="w-full"
                >
                  <title>Response Wire Bytes by Content-Type</title>
                  {visibleMimes.map((m, idx) => {
                    const y = idx * 22;
                    const barWidth = Math.max(
                      4,
                      Math.round((m.wireBytes / maxMimeWireBytes) * 190)
                    );
                    return (
                      <g key={m.mimeGroup} transform={`translate(0, ${y})`}>
                        <text
                          x={0}
                          y={14}
                          fill="currentColor"
                          className="fill-muted font-mono text-[10px]"
                        >
                          {m.mimeGroup.length > 21
                            ? `${m.mimeGroup.slice(0, 19)}..`
                            : m.mimeGroup}
                        </text>
                        <rect
                          x={145}
                          y={4}
                          width={190}
                          height={12}
                          rx={2}
                          className="fill-canvas"
                        />
                        <rect
                          x={145}
                          y={4}
                          width={barWidth}
                          height={12}
                          rx={2}
                          fill={m.color}
                        >
                          <title>
                            {`${m.mimeGroup}: ${formatBytes(m.wireBytes)} (${m.percentOfBytes.toFixed(1)}%), ${m.count} reqs`}
                          </title>
                        </rect>
                        <text
                          x={418}
                          y={14}
                          textAnchor="end"
                          className="fill-fg font-mono text-[10px]"
                        >
                          {`${formatBytes(m.wireBytes)} (${m.count})`}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              );
            })()}
          </div>
        </div>

        {/* Top 5 Slowest & Top 5 Largest */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded border border-hairline bg-elevated/35 p-2.5">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Top 5 Slowest Requests
            </h3>
            <div className="space-y-1">
              {multiStats.topSlowest.map((item) => (
                <button
                  key={`slow-${item.id}`}
                  type="button"
                  onClick={() => onSelectSession?.(item.id)}
                  title={`Open session #${item.id}: ${item.url}`}
                  className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left hover:bg-canvas/70"
                >
                  <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
                    <span className="shrink-0 text-subtle">#{item.id}</span>
                    <span
                      className={`shrink-0 rounded px-1 text-[10px] font-semibold ${getStatusBadgeClass(item.status)}`}
                    >
                      {item.status || "..."}
                    </span>
                    <span className="truncate text-fg">
                      {item.host}
                      {item.path}
                    </span>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-status4xx-fg">
                    {formatDuration(item.durationMs)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded border border-hairline bg-elevated/35 p-2.5">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Top 5 Largest Payloads
            </h3>
            <div className="space-y-1">
              {multiStats.topLargest.map((item) => (
                <button
                  key={`large-${item.id}`}
                  type="button"
                  onClick={() => onSelectSession?.(item.id)}
                  title={`Open session #${item.id}: ${item.url}`}
                  className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left hover:bg-canvas/70"
                >
                  <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
                    <span className="shrink-0 text-subtle">#{item.id}</span>
                    <span className="shrink-0 text-muted">{item.method}</span>
                    <span className="truncate text-fg">
                      {item.host}
                      {item.path}
                    </span>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-accent">
                    {formatBytes(item.bodySize)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!detail || !singleMetrics) {
    return (
      <div className="flex h-full items-center justify-center bg-surface p-6 text-xs text-muted">
        Select a captured session to inspect Fiddler Classic request timings,
        wire bytes, and TLS connection telemetry.
      </div>
    );
  }

  const { summary, transferStats } = detail;
  const { timingSummary, timestampRows, transfer, worldwide } = singleMetrics;
  const effectiveReused =
    transferStats?.serverConnReused ?? summary.serverConnReused;
  const activeTooltipId = hoveredPhase
    ? `${baseTooltipId}-tip-${hoveredPhase.key}`
    : undefined;

  return (
    <div className="flex h-full flex-col overflow-auto bg-surface p-3 text-xs text-fg">
      {/* Header Summary + Copy Controls */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${getStatusBadgeClass(summary.status)}`}
          >
            {summary.status || "..."}
          </span>
          <span className="font-mono text-xs font-semibold text-fg">
            #{summary.id} · {summary.method} {summary.host}
          </span>
          <span className="rounded border border-hairline bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-muted">
            {summary.protocol}
          </span>
          {effectiveReused === true && (
            <span className="rounded border border-status2xx-fg/35 bg-status2xx-bg px-1.5 py-0.5 font-mono text-[10px] font-semibold text-status2xx-fg">
              Pooled / Reused
            </span>
          )}
          {effectiveReused === false && (
            <span className="rounded border border-accent/40 bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent">
              Cold Connect
            </span>
          )}
          {transferStats?.isStreaming && (
            <span className="rounded border border-statusWs-fg/35 bg-statusWs-bg px-1.5 py-0.5 font-mono text-[10px] font-semibold text-statusWs-fg">
              Streaming
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void handleCopy("text")}
            className="inline-flex items-center gap-1 rounded border border-hairline bg-elevated px-2 py-1 text-[11px] font-medium text-fg hover:border-strong"
          >
            {copiedMode === "text" ? (
              <Check
                className="h-3 w-3 text-status2xx-fg"
                aria-hidden="true"
              />
            ) : (
              <Copy className="h-3 w-3 text-muted" aria-hidden="true" />
            )}
            <span>{copiedMode === "text" ? "Copied" : "Copy Text"}</span>
          </button>
          <button
            type="button"
            onClick={() => void handleCopy("md")}
            className="inline-flex items-center gap-1 rounded border border-hairline bg-elevated px-2 py-1 text-[11px] font-medium text-fg hover:border-strong"
          >
            {copiedMode === "md" ? (
              <Check
                className="h-3 w-3 text-status2xx-fg"
                aria-hidden="true"
              />
            ) : (
              <FileText className="h-3 w-3 text-muted" aria-hidden="true" />
            )}
            <span>{copiedMode === "md" ? "Copied" : "Copy Markdown"}</span>
          </button>
        </div>
      </div>

      {/* Horizontal Per-Phase Timing Breakdown Bar + Accessible Tooltip */}
      <section className="mb-3 rounded border border-hairline bg-elevated/40 p-2.5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Timing Breakdown
            </h3>
            {timingSummary.isFallback && (
              <span className="rounded bg-canvas px-1.5 py-0.5 text-[10px] text-subtle">
                Legacy / coarse estimate
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums">
            <span>
              <span className="text-muted">Overall:</span>{" "}
              <strong className="text-fg">
                {formatMsPrecise(timingSummary.overallElapsedMs)}
              </strong>
            </span>
            {timingSummary.netElapsedMs !== null && (
              <span>
                <span className="text-muted">Net:</span>{" "}
                <strong className="text-status2xx-fg">
                  {formatMsPrecise(timingSummary.netElapsedMs)}
                </strong>
              </span>
            )}
          </div>
        </div>

        <div className="relative">
          <div
            role="group"
            aria-label="Request lifecycle phase timing segments"
            className="flex h-6 w-full overflow-hidden rounded border border-hairline bg-canvas"
          >
            {timingSummary.phases.map((phase) => {
              const widthPct = Math.max(phase.percent, 2);
              const isSelected = hoveredPhase?.key === phase.key;
              return (
                <button
                  key={phase.key}
                  type="button"
                  style={{
                    width: `${widthPct}%`,
                    backgroundColor: phase.color,
                  }}
                  aria-label={`${phase.label}: ${formatMsPrecise(phase.durationMs)} (${phase.percent.toFixed(1)}%)`}
                  aria-describedby={
                    isSelected ? `${baseTooltipId}-tip-${phase.key}` : undefined
                  }
                  onMouseEnter={() => setHoveredPhase(phase)}
                  onMouseLeave={() =>
                    setHoveredPhase((cur) =>
                      cur?.key === phase.key ? null : cur
                    )
                  }
                  onFocus={() => setHoveredPhase(phase)}
                  onBlur={() =>
                    setHoveredPhase((cur) =>
                      cur?.key === phase.key ? null : cur
                    )
                  }
                  className={`h-full min-w-[6px] border-r border-canvas/60 text-left transition-opacity last:border-r-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-fg ${
                    hoveredPhase && !isSelected ? "opacity-65" : "opacity-100"
                  }`}
                />
              );
            })}
          </div>

          {hoveredPhase && (
            <div
              id={activeTooltipId}
              role="tooltip"
              className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-strong bg-canvas px-2.5 py-1.5 text-[11px] shadow-popover"
            >
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-xs"
                  style={{ backgroundColor: hoveredPhase.color }}
                  aria-hidden="true"
                />
                <span className="font-semibold text-fg">
                  {hoveredPhase.label}
                </span>
                <span className="text-muted">— {hoveredPhase.description}</span>
              </div>
              <span className="font-mono font-semibold tabular-nums text-fg">
                {formatMsPrecise(hoveredPhase.durationMs)} (
                {hoveredPhase.percent.toFixed(1)}%)
              </span>
            </div>
          )}
        </div>

        {/* Phase Legend */}
        <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1">
          {timingSummary.phases.map((phase) => (
            <button
              key={`legend-${phase.key}`}
              type="button"
              onMouseEnter={() => setHoveredPhase(phase)}
              onMouseLeave={() =>
                setHoveredPhase((cur) => (cur?.key === phase.key ? null : cur))
              }
              onFocus={() => setHoveredPhase(phase)}
              onBlur={() =>
                setHoveredPhase((cur) => (cur?.key === phase.key ? null : cur))
              }
              className={`inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] transition-colors ${
                hoveredPhase?.key === phase.key
                  ? "bg-canvas text-fg ring-1 ring-hairline"
                  : "text-muted hover:text-fg"
              }`}
            >
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-xs"
                style={{ backgroundColor: phase.color }}
                aria-hidden="true"
              />
              <span>{phase.shortLabel}:</span>
              <span className="font-mono tabular-nums text-fg">
                {formatMsPrecise(phase.durationMs)}
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Main Two-Column Grid: ACTUAL PERFORMANCE + Bytes/Connection Cards */}
      <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-12">
        {/* ACTUAL PERFORMANCE Table */}
        <section className="rounded border border-hairline bg-elevated/35 p-2.5 lg:col-span-6">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Actual Performance
            </h3>
            <span className="font-mono text-[10px] text-subtle">
              UTC clock · microsecond precision
            </span>
          </div>
          {timestampRows.length === 0 ? (
            <p className="text-[11px] text-muted">
              No detailed milestone timestamps recorded for this session.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
                <thead>
                  <tr className="border-b border-hairline text-left text-[10px] text-subtle">
                    <th className="py-1 pr-2 font-medium">Milestone</th>
                    <th className="py-1 pr-2 font-medium">Clock Time</th>
                    <th className="py-1 text-right font-medium">+Step ms</th>
                  </tr>
                </thead>
                <tbody>
                  {timestampRows.map((row) => (
                    <tr
                      key={row.key}
                      className="border-b border-hairline/40 last:border-b-0"
                    >
                      <td className="py-1 pr-2 text-fg">{row.label}</td>
                      <td
                        className="py-1 pr-2 text-muted"
                        title={row.isoTimestamp}
                      >
                        {row.formattedTime}
                      </td>
                      <td className="py-1 text-right text-accent">
                        {row.deltaMs !== null
                          ? `+${row.deltaMs.toFixed(2)}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Right Column: Bytes & Compression + Connection & TLS */}
        <div className="flex flex-col gap-3 lg:col-span-6">
          {/* Bytes & Compression */}
          <section className="rounded border border-hairline bg-elevated/35 p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <HardDriveDownload
                  className="h-3.5 w-3.5 text-accent"
                  aria-hidden="true"
                />
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Bytes & Compression
                </h3>
              </div>
              {transfer.isCompressed && (
                <span className="inline-flex items-center gap-1 rounded bg-status2xx-bg px-1.5 py-0.5 font-mono text-[10px] font-semibold text-status2xx-fg">
                  <Zap className="h-2.5 w-2.5" aria-hidden="true" />
                  <span>
                    {transfer.encoding ?? "compressed"}{" "}
                    {transfer.savingsPercent > 0
                      ? `(-${transfer.savingsPercent.toFixed(1)}%)`
                      : ""}
                  </span>
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 font-mono text-[11px] tabular-nums">
              <div className="rounded bg-canvas/70 p-2">
                <div className="text-[10px] text-subtle">Request Sent</div>
                <div className="mt-0.5 font-semibold text-fg">
                  {formatBytes(transfer.requestTotalWireBytes)}
                </div>
                <div className="text-[10px] text-muted">
                  Hdr {transfer.requestHeadersBytes} B · Body{" "}
                  {transfer.requestWireBodyBytes} B
                  {transfer.isEstimatedHeaders ? " (est)" : ""}
                </div>
              </div>

              <div className="rounded bg-canvas/70 p-2">
                <div className="text-[10px] text-subtle">
                  Response Wire / Decoded
                </div>
                <div className="mt-0.5 font-semibold text-fg">
                  {formatBytes(transfer.responseWireBodyBytes)} /{" "}
                  {formatBytes(transfer.responseBodyBytes)}
                </div>
                <div className="text-[10px] text-muted">
                  Hdr {transfer.responseHeadersBytes} B · Saved{" "}
                  {formatBytes(transfer.savedBytes)}
                </div>
              </div>

              <div className="rounded bg-canvas/70 p-2">
                <div className="text-[10px] text-subtle">
                  Total Wire Volume
                </div>
                <div className="mt-0.5 font-semibold text-fg">
                  {formatBytes(transfer.totalWireBytes)}
                </div>
                <div className="text-[10px] text-muted">
                  {transfer.totalWireBytes.toLocaleString("en-US")} bytes
                </div>
              </div>

              <div className="rounded bg-canvas/70 p-2">
                <div className="text-[10px] text-subtle">Throughput</div>
                <div className="mt-0.5 font-semibold text-fg">
                  {formatRate(transfer.downloadBandwidthBytesPerSec)}
                </div>
                <div className="text-[10px] text-muted">
                  Overall {formatRate(transfer.throughputBytesPerSec)}
                </div>
              </div>
            </div>
          </section>

          {/* Connection & TLS */}
          <section className="rounded border border-hairline bg-elevated/35 p-2.5">
            <div className="mb-2 flex items-center gap-1.5">
              <Network className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Connection & TLS
              </h3>
            </div>

            <div className="space-y-1.5 font-mono text-[11px]">
              <div className="flex items-start justify-between gap-2">
                <span className="flex items-center gap-1 text-muted">
                  <Database className="h-3 w-3" aria-hidden="true" />
                  Client ↔ Proxy
                </span>
                <span className="text-right text-fg">
                  {detail.clientAddr || "—"}
                  {transferStats?.clientConnId != null
                    ? ` (conn #${transferStats.clientConnId}`
                    : ""}
                  {transferStats?.clientConnReused != null
                    ? `${transferStats?.clientConnId != null ? ", " : " ("}${transferStats.clientConnReused ? "reused" : "fresh"}`
                    : ""}
                  {transferStats?.clientConnId != null ||
                  transferStats?.clientConnReused != null
                    ? ")"
                    : ""}
                  {transferStats?.clientHttpVersion
                    ? ` · ${transferStats.clientHttpVersion}`
                    : ""}
                </span>
              </div>

              {(transferStats?.clientTlsVersion ||
                transferStats?.clientTlsCipher) && (
                <div className="flex items-start justify-between gap-2">
                  <span className="flex items-center gap-1 text-muted">
                    <Lock className="h-3 w-3" aria-hidden="true" />
                    Client MITM TLS
                  </span>
                  <span className="text-right text-fg">
                    {[
                      transferStats?.clientTlsVersion,
                      transferStats?.clientTlsCipher,
                      transferStats?.clientAlpn
                        ? `ALPN ${transferStats.clientAlpn}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
              )}

              <div className="flex items-start justify-between gap-2">
                <span className="flex items-center gap-1 text-muted">
                  <Server className="h-3 w-3" aria-hidden="true" />
                  Proxy ↔ Server
                </span>
                <span className="text-right text-fg">
                  {transferStats?.viaProxyAddr
                    ? transferStats?.serverIp || summary.serverIp || "—"
                    : transferStats?.serverAddr ||
                      (transferStats?.serverIp && transferStats?.serverPort
                        ? `${transferStats.serverIp}:${transferStats.serverPort}`
                        : transferStats?.serverIp || summary.serverIp || "—")}
                  {transferStats?.serverConnId != null
                    ? ` (conn #${transferStats.serverConnId}`
                    : ""}
                  {effectiveReused != null
                    ? `${transferStats?.serverConnId != null ? ", " : " ("}${effectiveReused ? "reused" : "cold"}`
                    : ""}
                  {transferStats?.serverConnId != null ||
                  effectiveReused != null
                    ? ")"
                    : ""}
                  {transferStats?.serverHttpVersion
                    ? ` · ${transferStats.serverHttpVersion}`
                    : ""}
                </span>
              </div>

              {transferStats?.viaProxyAddr && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-muted">Upstream Proxy</span>
                  <span className="text-right text-accent">
                    {transferStats.viaProxyAddr}
                  </span>
                </div>
              )}

              {(transferStats?.serverTlsVersion ||
                transferStats?.serverTlsCipher ||
                detail.tlsVersion) && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-muted">Upstream TLS</span>
                  <span className="text-right text-fg">
                    {[
                      transferStats?.serverTlsVersion || detail.tlsVersion,
                      transferStats?.serverTlsCipher,
                      transferStats?.serverTlsAlpn
                        ? `ALPN ${transferStats.serverTlsAlpn}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
              )}

              {transferStats?.serverCertSubject && (
                <div className="flex items-start justify-between gap-2">
                  <span className="shrink-0 text-muted">Certificate</span>
                  <span
                    className="truncate text-right text-fg"
                    title={transferStats.serverCertSubject}
                  >
                    {transferStats.serverCertSubject}
                    {transferStats.serverCertIssuer
                      ? ` (Issuer: ${transferStats.serverCertIssuer})`
                      : ""}
                  </span>
                </div>
              )}

              {transferStats?.serverMtlsCn && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-muted">Client mTLS Cert</span>
                  <span className="text-right text-accent">
                    {transferStats.serverMtlsCn}
                  </span>
                </div>
              )}

              {(transferStats?.remappedTarget || summary.remappedTo) && (
                <div className="flex items-start justify-between gap-2">
                  <span className="text-muted">HOSTS Remap</span>
                  <span className="text-right text-accent">
                    {transferStats?.remappedTarget || summary.remappedTo}
                  </span>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Collapsible Estimated Worldwide Performance (<details>/<summary> per Modern Web Guidance) */}
      <details className="group rounded border border-hairline bg-elevated/35">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-fg">
          <span className="flex items-center gap-1.5">
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90"
              aria-hidden="true"
            />
            <Globe className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            <span>Estimated Worldwide Performance</span>
          </span>
          <span className="font-mono text-[10px] font-normal normal-case text-subtle">
            {effectiveReused
              ? "Warm keep-alive (1 HTTP RTT)"
              : "Cold handshake + transfer model"}
          </span>
        </summary>

        <div className="border-t border-hairline px-2.5 py-2">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
              <thead>
                <tr className="border-b border-hairline text-left text-[10px] text-subtle">
                  <th className="py-1 pr-2 font-medium">Region / Profile</th>
                  <th className="py-1 pr-2 text-right font-medium">RTT</th>
                  <th className="py-1 pr-2 text-right font-medium">
                    Network Wait
                  </th>
                  <th className="py-1 pr-2 text-right font-medium">Transfer</th>
                  <th className="py-1 text-right font-medium">
                    Estimated Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {worldwide.map((row) => (
                  <tr
                    key={row.profile.id}
                    className="border-b border-hairline/40 last:border-b-0"
                  >
                    <td className="py-1 pr-2 text-fg">
                      {row.profile.name}{" "}
                      <span className="text-[10px] text-subtle">
                        ({row.profile.downloadMbps} Mbps)
                      </span>
                    </td>
                    <td className="py-1 pr-2 text-right text-muted">
                      {row.profile.rttMs} ms × {row.rttCount}
                    </td>
                    <td className="py-1 pr-2 text-right text-muted">
                      {formatMsPrecise(row.networkRttMs)}
                    </td>
                    <td className="py-1 pr-2 text-right text-muted">
                      {formatMsPrecise(row.transferMs)}
                    </td>
                    <td className="py-1 text-right font-semibold text-fg">
                      {formatMsPrecise(row.estimatedTotalMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </div>
  );
};
