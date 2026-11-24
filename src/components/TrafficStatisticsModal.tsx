import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  Check,
  Clock,
  FileText,
  Globe,
  HardDriveDownload,
  Layers,
  X,
} from "lucide-react";
import { copyTextToClipboard } from "../lib/contextMenuBuilders";
import { formatBytes, formatDuration } from "../lib/formatters";
import {
  aggregateSessionsStatistics,
  formatMsPrecise,
  formatTrafficStatisticsMarkdown,
  isSessionPending,
} from "../lib/requestStatistics";
import type { SessionSummary } from "../types/proxy";

export type TrafficStatisticsScope = "filtered" | "selected";

export interface TrafficStatisticsModalProps {
  open: boolean;
  onClose: () => void;
  filteredSessions: SessionSummary[];
  selectedSessions?: SessionSummary[];
  totalCapturedCount?: number;
  filterQuery?: string;
  initialScope?: TrafficStatisticsScope;
  onSelectSession?: (id: number) => void;
  onFilterByHost?: (host: string) => void;
  onNotify?: (msg: string) => void;
}

function getStatusBadgeClass(session: SessionSummary): string {
  if (isSessionPending(session)) {
    return "bg-accent/15 text-accent";
  }
  if (session.error || session.status >= 500) {
    return "bg-status5xx-bg text-status5xx-fg";
  }
  if (session.status >= 400) return "bg-status4xx-bg text-status4xx-fg";
  if (session.status === 101) return "bg-statusWs-bg text-statusWs-fg";
  if (session.status >= 300) return "bg-status3xx-bg text-status3xx-fg";
  if (session.status >= 200) return "bg-status2xx-bg text-status2xx-fg";
  return "bg-elevated text-muted";
}

export const TrafficStatisticsModal: React.FC<TrafficStatisticsModalProps> = ({
  open,
  onClose,
  filteredSessions,
  selectedSessions = [],
  totalCapturedCount,
  filterQuery,
  initialScope = "filtered",
  onSelectSession,
  onFilterByHost,
  onNotify,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [scope, setScope] = useState<TrafficStatisticsScope>(initialScope);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);

  const hasSelectedSessions = selectedSessions.length > 0;
  const effectiveScope: TrafficStatisticsScope =
    scope === "selected" && hasSelectedSessions ? "selected" : "filtered";

  // Sync dialog open/close state with native showModal() / close()
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      setScope(
        initialScope === "selected" && selectedSessions.length > 0
          ? "selected"
          : "filtered"
      );
      setCopiedMarkdown(false);
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, initialScope, selectedSessions.length]);

  // Progressive enhancement fallback for `<dialog closedby="any">` light dismiss
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || "closedBy" in HTMLDialogElement.prototype) return;

    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };

    let pressedOutside = false;
    const onDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
        dialog.close();
      }
    };

    dialog.addEventListener("pointerdown", onDown);
    dialog.addEventListener("pointerup", onUp);
    return () => {
      dialog.removeEventListener("pointerdown", onDown);
      dialog.removeEventListener("pointerup", onUp);
    };
  }, []);

  const activeSessions =
    effectiveScope === "selected" ? selectedSessions : filteredSessions;

  const stats = useMemo(() => {
    if (!open) return null;
    return aggregateSessionsStatistics(activeSessions);
  }, [open, activeSessions]);

  const handleCopyMarkdownReport = async () => {
    if (!stats) return;
    const scopeLabel =
      effectiveScope === "selected" ? "Selected Sessions" : "Filtered Sample";
    const markdown = formatTrafficStatisticsMarkdown(stats, {
      scopeLabel,
      totalCapturedCount: totalCapturedCount ?? filteredSessions.length,
      filterQuery: effectiveScope === "filtered" ? filterQuery : undefined,
      generatedAtIso: new Date().toISOString(),
    });
    const ok = await copyTextToClipboard(
      markdown,
      onNotify,
      `Markdown-отчёт скопирован (${stats.requestCount.toLocaleString("en-US")} сессий)`
    );
    if (ok) {
      setCopiedMarkdown(true);
      window.setTimeout(() => setCopiedMarkdown(false), 1800);
    }
  };

  const handleJumpToSession = (id: number) => {
    onSelectSession?.(id);
    dialogRef.current?.close();
  };

  const handleFilterHost = (host: string) => {
    onFilterByHost?.(host);
    dialogRef.current?.close();
  };

  const totalStatusCount = Math.max(1, stats?.requestCount ?? 1);
  const maxMimeWireBytes = Math.max(
    1,
    ...(stats?.mimeBuckets.map((m) => m.wireBytes) ?? [1])
  );
  const maxHostCount = Math.max(
    1,
    ...(stats?.hostBuckets.map((h) => h.count) ?? [1])
  );

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto max-h-[90vh] w-[min(96vw,1180px)] overflow-hidden rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:flex-col"
    >
      {/* Modal Header */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-hairline bg-surface px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <BarChart3
            className="h-4 w-4 shrink-0 text-accent"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1
                id={titleId}
                className="truncate text-sm font-semibold text-fg"
              >
                Traffic Statistics
              </h1>
              <span className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted">
                {activeSessions.length.toLocaleString("en-US")}
                {typeof totalCapturedCount === "number" &&
                totalCapturedCount !== activeSessions.length
                  ? ` / ${totalCapturedCount.toLocaleString("en-US")}`
                  : ""}{" "}
                sessions
              </span>
              {effectiveScope === "filtered" && filterQuery?.trim() && (
                <span className="max-w-[220px] truncate rounded border border-accent/35 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent">
                  filter: {filterQuery.trim()}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-muted">
              Сводная статистика по выборке: статусы, объём wire/decoded,
              перцентили Latency &amp; TTFB, MIME, хосты и топ-5 URL
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/* Scope Switcher: Filtered Sample vs Selected Sessions */}
          <div
            role="group"
            aria-label="Statistics sample scope"
            className="inline-flex items-center rounded-md border border-hairline bg-canvas p-0.5 text-[11px]"
          >
            <button
              type="button"
              aria-pressed={effectiveScope === "filtered"}
              onClick={() => setScope("filtered")}
              className={`rounded px-2 py-1 font-medium transition-colors ${
                effectiveScope === "filtered"
                  ? "bg-selected text-fg shadow-xs"
                  : "text-muted hover:text-fg"
              }`}
            >
              Filtered ({filteredSessions.length.toLocaleString("en-US")})
            </button>
            <button
              type="button"
              disabled={!hasSelectedSessions}
              aria-pressed={effectiveScope === "selected"}
              onClick={() => setScope("selected")}
              className={`rounded px-2 py-1 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                effectiveScope === "selected"
                  ? "bg-selected text-fg shadow-xs"
                  : "text-muted hover:text-fg"
              }`}
            >
              Selected ({selectedSessions.length.toLocaleString("en-US")})
            </button>
          </div>

          <button
            type="button"
            disabled={!stats || stats.requestCount === 0}
            onClick={() => void handleCopyMarkdownReport()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent/45 bg-accent/15 px-3 text-xs font-semibold text-accent transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {copiedMarkdown ? (
              <Check className="h-3.5 w-3.5 text-status2xx-fg" aria-hidden="true" />
            ) : (
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>
              {copiedMarkdown ? "Copied Markdown" : "Copy Markdown Report"}
            </span>
          </button>

          <button
            type="button"
            autoFocus
            onClick={() => dialogRef.current?.close()}
            aria-label="Закрыть Traffic Statistics"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-muted transition-colors hover:border-strong hover:bg-hover hover:text-fg"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Scrollable Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-xs">
        {!stats || stats.requestCount === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-14 text-center text-muted">
            <Activity className="h-8 w-8 text-subtle" aria-hidden="true" />
            <p className="text-sm font-medium text-fg">
              Нет сессий для расчёта статистики
            </p>
            <p className="max-w-md text-xs text-subtle">
              Захватите HTTP/HTTPS трафик, ослабьте активные фильтры или
              выберите другой диапазон выборки.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* KPI Summary Cards */}
            <section
              aria-label="Key traffic metrics"
              className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6"
            >
              <div className="rounded-lg border border-hairline bg-elevated/45 p-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                  Total Sessions
                </div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-fg">
                  {stats.requestCount.toLocaleString("en-US")}
                </div>
                <div className="mt-0.5 font-mono text-[10px] tabular-nums text-subtle">
                  {stats.errorCount > 0
                    ? `${stats.errorCount.toLocaleString("en-US")} err (${((stats.errorCount / stats.requestCount) * 100).toFixed(1)}%)`
                    : "0 errors"}
                  {stats.pendingCount > 0
                    ? ` · ${stats.pendingCount} pending`
                    : ""}
                </div>
              </div>

              <div className="rounded-lg border border-hairline bg-elevated/45 p-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                  Body Size (Decoded)
                </div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-fg">
                  {formatBytes(stats.bytesReceivedDecoded)}
                </div>
                <div className="mt-0.5 font-mono text-[10px] tabular-nums text-subtle">
                  {stats.bytesReceivedDecoded.toLocaleString("en-US")} B · Sent{" "}
                  {formatBytes(stats.bytesSent)}
                </div>
              </div>

              <div className="rounded-lg border border-hairline bg-elevated/45 p-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                  Wire Body Size
                </div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-fg">
                  {formatBytes(stats.bytesReceivedWire)}
                </div>
                <div className="mt-0.5 font-mono text-[10px] tabular-nums text-subtle">
                  {stats.compressionSavedBytes > 0
                    ? `Saved ${formatBytes(stats.compressionSavedBytes)} (-${stats.compressionSavingsPercent.toFixed(1)}%)`
                    : `${stats.bytesReceivedWire.toLocaleString("en-US")} B wire`}
                </div>
              </div>

              <div className="rounded-lg border border-hairline bg-elevated/45 p-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                  Duration (Avg)
                </div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-fg">
                  {formatMsPrecise(stats.avgLatencyMs)}
                </div>
                <div className="mt-0.5 font-mono text-[10px] tabular-nums text-subtle">
                  Med {formatMsPrecise(stats.p50LatencyMs)} · P95{" "}
                  {formatMsPrecise(stats.p95LatencyMs)}
                </div>
              </div>

              <div className="rounded-lg border border-hairline bg-elevated/45 p-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                  TTFB (Avg)
                </div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-fg">
                  {stats.avgTtfbMs !== null
                    ? formatMsPrecise(stats.avgTtfbMs)
                    : "—"}
                </div>
                <div className="mt-0.5 font-mono text-[10px] tabular-nums text-subtle">
                  {stats.p50TtfbMs !== null && stats.p95TtfbMs !== null
                    ? `Med ${formatMsPrecise(stats.p50TtfbMs)} · P95 ${formatMsPrecise(stats.p95TtfbMs)}`
                    : "No TTFB phases"}
                </div>
              </div>

              <div className="rounded-lg border border-hairline bg-elevated/45 p-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                  Wall Span &amp; Reuse
                </div>
                <div className="mt-1 font-mono text-base font-semibold tabular-nums text-fg">
                  {formatDuration(Math.round(stats.overallWallElapsedMs))}
                </div>
                <div className="mt-0.5 font-mono text-[10px] tabular-nums text-subtle">
                  {stats.reuseRatePercent !== null
                    ? `Reused ${stats.reuseRatePercent.toFixed(0)}% (${stats.reusedCount}/${stats.reusedCount + stats.coldCount})`
                    : `P99 ${formatMsPrecise(stats.p99LatencyMs)}`}
                </div>
              </div>
            </section>

            {/* Status Code Breakdown (2xx / 3xx / 4xx / 5xx / Pending / Other) */}
            <section
              aria-label="Status code distribution"
              className="rounded-lg border border-hairline bg-elevated/30 p-3"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                    Status Distribution (2xx / 3xx / 4xx / 5xx / Pending)
                  </h2>
                </div>
                <span className="font-mono text-[10px] tabular-nums text-subtle">
                  Min {formatMsPrecise(stats.minLatencyMs)} · P50{" "}
                  {formatMsPrecise(stats.p50LatencyMs)} · P95{" "}
                  {formatMsPrecise(stats.p95LatencyMs)} · Max{" "}
                  {formatMsPrecise(stats.maxLatencyMs)}
                </span>
              </div>

              <svg
                role="img"
                aria-label={`HTTP status distribution across ${stats.requestCount} sessions`}
                viewBox="0 0 600 18"
                preserveAspectRatio="none"
                className="mb-2.5 h-4 w-full overflow-hidden rounded bg-canvas"
              >
                <title>HTTP Status Code Distribution</title>
                {(() => {
                  let x = 0;
                  return stats.statusBuckets.map((bucket) => {
                    const width = (bucket.count / totalStatusCount) * 600;
                    const rect = (
                      <rect
                        key={bucket.group}
                        x={x}
                        y={0}
                        width={Math.max(width, 1.5)}
                        height={18}
                        fill={bucket.color}
                      >
                        <title>
                          {`${bucket.label}: ${bucket.count.toLocaleString("en-US")} (${bucket.percent.toFixed(1)}%), ${formatBytes(bucket.bytes)}`}
                        </title>
                      </rect>
                    );
                    x += width;
                    return rect;
                  });
                })()}
              </svg>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {stats.allStatusBuckets.map((b) => (
                  <div
                    key={b.group}
                    data-status-bucket={b.group}
                    className="flex items-center justify-between gap-2 rounded border border-hairline/70 bg-canvas/60 px-2.5 py-1.5"
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                        style={{ backgroundColor: b.color }}
                        aria-hidden="true"
                      />
                      <span className="truncate text-[11px] font-medium text-fg">
                        {b.group}
                      </span>
                    </div>
                    <div className="shrink-0 text-right font-mono text-[10px] tabular-nums">
                      <span className="font-semibold text-fg">
                        {b.count.toLocaleString("en-US")}
                      </span>{" "}
                      <span className="text-muted">
                        ({b.percent.toFixed(1)}%)
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Content-Type (MIME) & Host Breakdowns */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {/* By Content-Type */}
              <section
                aria-label="Breakdown by Content-Type"
                className="rounded-lg border border-hairline bg-elevated/30 p-3"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Layers
                      className="h-3.5 w-3.5 text-accent"
                      aria-hidden="true"
                    />
                    <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      By Content-Type
                    </h2>
                  </div>
                  <span className="font-mono text-[10px] tabular-nums text-subtle">
                    {stats.mimeBuckets.length} types ·{" "}
                    {formatBytes(stats.bytesReceivedWire)} wire
                  </span>
                </div>

                <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                  {stats.mimeBuckets.slice(0, 12).map((m) => {
                    const widthPct = Math.max(
                      2,
                      (m.wireBytes / maxMimeWireBytes) * 100
                    );
                    return (
                      <div key={m.mimeGroup} className="space-y-0.5">
                        <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                          <span className="truncate font-medium text-fg">
                            {m.mimeGroup}
                          </span>
                          <span className="shrink-0 tabular-nums text-muted">
                            {m.count.toLocaleString("en-US")} reqs ·{" "}
                            <strong className="font-semibold text-fg">
                              {formatBytes(m.wireBytes)}
                            </strong>
                            {m.bytes !== m.wireBytes
                              ? ` (${formatBytes(m.bytes)} dec)`
                              : ""}{" "}
                            · {m.percentOfBytes.toFixed(1)}%
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas">
                          <div
                            style={{
                              width: `${widthPct}%`,
                              backgroundColor: m.color,
                            }}
                            className="h-full rounded-full"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* By Host */}
              <section
                aria-label="Breakdown by Host"
                className="rounded-lg border border-hairline bg-elevated/30 p-3"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Globe
                      className="h-3.5 w-3.5 text-accent"
                      aria-hidden="true"
                    />
                    <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      By Host
                    </h2>
                  </div>
                  <span className="font-mono text-[10px] tabular-nums text-subtle">
                    {stats.hostBuckets.length.toLocaleString("en-US")} unique
                    hosts
                  </span>
                </div>

                <div className="max-h-56 overflow-y-auto pr-1">
                  <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
                    <thead>
                      <tr className="border-b border-hairline text-left text-[10px] text-subtle">
                        <th className="py-1 pr-2 font-medium">Host</th>
                        <th className="py-1 pr-2 text-right font-medium">
                          Reqs
                        </th>
                        <th className="py-1 pr-2 text-right font-medium">
                          Wire
                        </th>
                        <th className="py-1 text-right font-medium">Avg</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.hostBuckets.slice(0, 15).map((h) => {
                        const sharePct = Math.max(
                          2,
                          (h.count / maxHostCount) * 100
                        );
                        return (
                          <tr
                            key={h.host}
                            className="border-b border-hairline/40 last:border-b-0"
                          >
                            <td className="max-w-[200px] py-1 pr-2">
                              <div className="flex items-center gap-1.5">
                                {onFilterByHost ? (
                                  <button
                                    type="button"
                                    onClick={() => handleFilterHost(h.host)}
                                    title={`Filter traffic by host: ${h.host}`}
                                    className="truncate text-left text-fg hover:text-accent hover:underline"
                                  >
                                    {h.host}
                                  </button>
                                ) : (
                                  <span className="truncate text-fg">
                                    {h.host}
                                  </span>
                                )}
                                {h.errorCount > 0 && (
                                  <span className="shrink-0 rounded bg-status5xx-bg px-1 text-[9px] font-semibold text-status5xx-fg">
                                    {h.errorCount} err
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-canvas">
                                <div
                                  style={{ width: `${sharePct}%` }}
                                  className="h-full rounded-full bg-accent/70"
                                />
                              </div>
                            </td>
                            <td className="py-1 pr-2 text-right text-fg">
                              {h.count.toLocaleString("en-US")}{" "}
                              <span className="text-[10px] text-subtle">
                                ({h.percentOfRequests.toFixed(0)}%)
                              </span>
                            </td>
                            <td className="py-1 pr-2 text-right text-muted">
                              {formatBytes(h.wireBytes)}
                            </td>
                            <td className="py-1 text-right text-muted">
                              {formatMsPrecise(h.avgDurationMs)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            {/* Top 5 Slowest & Top 5 Heaviest URLs */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <section
                aria-label="Top 5 Slowest URLs"
                className="rounded-lg border border-hairline bg-elevated/30 p-3"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Clock
                      className="h-3.5 w-3.5 text-status4xx-fg"
                      aria-hidden="true"
                    />
                    <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Top 5 Slowest URLs
                    </h2>
                  </div>
                  <span className="font-mono text-[10px] text-subtle">
                    by durationMs
                  </span>
                </div>

                <div className="space-y-1">
                  {stats.topSlowest.map((item) => (
                    <button
                      key={`modal-slow-${item.id}`}
                      type="button"
                      onClick={() => handleJumpToSession(item.id)}
                      title={`Select session #${item.id}: ${item.url}`}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-canvas"
                    >
                      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
                        <span className="shrink-0 text-subtle">#{item.id}</span>
                        <span
                          className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${getStatusBadgeClass(
                            item
                          )}`}
                        >
                          {isSessionPending(item) ? "…" : item.status || "ERR"}
                        </span>
                        <span className="shrink-0 text-[10px] font-semibold text-muted">
                          {item.method}
                        </span>
                        <span className="truncate text-fg">
                          {item.host}
                          {item.path}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
                        {typeof item.ttfbMs === "number" &&
                          Number.isFinite(item.ttfbMs) && (
                            <span className="hidden text-[10px] text-subtle sm:inline">
                              TTFB {formatMsPrecise(item.ttfbMs)}
                            </span>
                          )}
                        <span className="font-semibold text-status4xx-fg">
                          {formatDuration(item.durationMs)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>

              <section
                aria-label="Top 5 Heaviest URLs"
                className="rounded-lg border border-hairline bg-elevated/30 p-3"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <HardDriveDownload
                      className="h-3.5 w-3.5 text-accent"
                      aria-hidden="true"
                    />
                    <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Top 5 Heaviest URLs
                    </h2>
                  </div>
                  <span className="font-mono text-[10px] text-subtle">
                    by bodySize / wire
                  </span>
                </div>

                <div className="space-y-1">
                  {stats.topLargest.map((item) => {
                    const wire =
                      typeof item.wireBodySize === "number" &&
                      Number.isFinite(item.wireBodySize)
                        ? item.wireBodySize
                        : item.bodySize;
                    return (
                      <button
                        key={`modal-heavy-${item.id}`}
                        type="button"
                        onClick={() => handleJumpToSession(item.id)}
                        title={`Select session #${item.id}: ${item.url}`}
                        className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-canvas"
                      >
                        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
                          <span className="shrink-0 text-subtle">
                            #{item.id}
                          </span>
                          <span
                            className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${getStatusBadgeClass(
                              item
                            )}`}
                          >
                            {isSessionPending(item)
                              ? "…"
                              : item.status || "ERR"}
                          </span>
                          <span className="shrink-0 text-[10px] font-semibold text-muted">
                            {item.method}
                          </span>
                          <span className="truncate text-fg">
                            {item.host}
                            {item.path}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
                          {wire !== item.bodySize && (
                            <span className="hidden text-[10px] text-subtle sm:inline">
                              wire {formatBytes(wire)}
                            </span>
                          )}
                          <span className="font-semibold text-accent">
                            {formatBytes(item.bodySize)}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
};
