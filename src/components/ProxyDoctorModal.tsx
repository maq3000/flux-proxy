import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  RefreshCw,
  Stethoscope,
  Wrench,
  X,
} from "lucide-react";
import { proxyBridge } from "../lib/tauriBridge";
import type { DoctorCheckResult, DoctorCheckStatus } from "../types/proxy";

interface ProxyDoctorModalProps {
  open: boolean;
  onClose: () => void;
  onNotify: (msg: string) => void;
}

const STATUS_BADGE_MAP: Record<
  DoctorCheckStatus,
  { label: string; badgeClass: string; borderClass: string }
> = {
  ok: {
    label: "OK",
    badgeClass:
      "border-emerald-500/35 bg-emerald-500/12 text-emerald-400",
    borderClass: "border-hairline",
  },
  warning: {
    label: "WARN",
    badgeClass: "border-amber-500/35 bg-amber-500/12 text-amber-400",
    borderClass: "border-amber-500/30",
  },
  error: {
    label: "ERROR",
    badgeClass: "border-rose-500/40 bg-rose-500/12 text-rose-400",
    borderClass: "border-rose-500/35",
  },
};

export const ProxyDoctorModal: React.FC<ProxyDoctorModalProps> = ({
  open,
  onClose,
  onNotify,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const [checks, setChecks] = useState<DoctorCheckResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const syncDefaultExpansion = useCallback((results: DoctorCheckResult[]) => {
    setExpandedIds((prev) => {
      const next: Record<string, boolean> = { ...prev };
      for (const item of results) {
        if (item.status !== "ok") {
          next[item.id] = true;
        } else if (!(item.id in next)) {
          next[item.id] = false;
        }
      }
      return next;
    });
  }, []);

  const runScan = useCallback(async () => {
    setScanning(true);
    setFeedback(null);
    try {
      const results = await proxyBridge.runProxyDoctor();
      setChecks(results);
      syncDefaultExpansion(results);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({
        tone: "error",
        text: `Не удалось выполнить диагностику: ${msg}`,
      });
    } finally {
      setScanning(false);
    }
  }, [syncDefaultExpansion]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      setFeedback(null);
      if (!dialog.open) {
        dialog.showModal();
      }
      void runScan();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, runScan]);

  // Light-dismiss pointer-bounds fallback when `<dialog closedby="any">` is missing
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
      if (pressedOutside && isOutside(e)) dialog.close();
    };

    dialog.addEventListener("pointerdown", onDown);
    dialog.addEventListener("pointerup", onUp);
    return () => {
      dialog.removeEventListener("pointerdown", onDown);
      dialog.removeEventListener("pointerup", onUp);
    };
  }, []);

  const handleFix = useCallback(
    async (issueId: string, label?: string | null) => {
      setFixingId(issueId);
      setFeedback(null);
      try {
        const updated = await proxyBridge.fixDoctorIssue(issueId);
        setChecks(updated);
        syncDefaultExpansion(updated);

        // Prompt status reconciliation in hooks listening to window focus
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("focus"));
        }

        const successMsg =
          issueId === "all"
            ? "Автоисправление завершено — результаты диагностики обновлены"
            : `Выполнено: ${label || issueId}`;
        setFeedback({ tone: "success", text: successMsg });
        onNotify(successMsg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFeedback({ tone: "error", text: msg });
        onNotify(`⚠️ Proxy Doctor: ${msg}`);
        try {
          const refreshed = await proxyBridge.runProxyDoctor();
          setChecks(refreshed);
          syncDefaultExpansion(refreshed);
        } catch {
          // keep current list if refresh fails
        }
      } finally {
        setFixingId(null);
      }
    },
    [onNotify, syncDefaultExpansion]
  );

  const stats = useMemo(() => {
    let okCount = 0;
    let warnCount = 0;
    let errorCount = 0;
    let fixableCount = 0;

    for (const c of checks) {
      if (c.status === "ok") okCount += 1;
      else if (c.status === "warning") warnCount += 1;
      else errorCount += 1;

      if (c.canAutoFix && c.status !== "ok") {
        fixableCount += 1;
      }
    }
    return { okCount, warnCount, errorCount, fixableCount };
  }, [checks]);

  const busy = scanning || fixingId !== null;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto w-full max-w-2xl rounded-xl border border-strong bg-surface p-0 text-fg shadow-2xl open:flex open:flex-col"
    >
      {/* Modal Header */}
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <div className="flex items-center gap-2">
          <Stethoscope aria-hidden="true" className="h-4 w-4 text-accent" />
          <h2 id={titleId} className="text-sm font-semibold text-fg">
            Proxy Doctor — Диагностика сети и прокси
          </h2>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Закрыть Proxy Doctor"
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {/* Summary & Action Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-hairline bg-canvas/60 px-4 py-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          {scanning && checks.length === 0 ? (
            <span className="inline-flex items-center gap-1.5 text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
              <span>Выполняется диагностика сокетов, Root CA и маршрутов…</span>
            </span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-emerald-400">
                OK: {stats.okCount}
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold ${
                  stats.warnCount > 0
                    ? "border-amber-500/35 bg-amber-500/10 text-amber-400"
                    : "border-hairline bg-surface text-subtle"
                }`}
              >
                WARN: {stats.warnCount}
              </span>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold ${
                  stats.errorCount > 0
                    ? "border-rose-500/40 bg-rose-500/10 text-rose-400"
                    : "border-hairline bg-surface text-subtle"
                }`}
              >
                ERROR: {stats.errorCount}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void runScan()}
            className="inline-flex items-center gap-1.5 rounded-md border border-strong bg-surface px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:bg-hover disabled:opacity-50"
          >
            <RefreshCw
              aria-hidden="true"
              className={`h-3.5 w-3.5 ${scanning ? "animate-spin text-accent" : ""}`}
            />
            <span>{scanning ? "Проверка..." : "Проверить снова"}</span>
          </button>

          {stats.fixableCount > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleFix("all", "Fix All Fixable")}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {fixingId === "all" ? (
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wrench aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              <span>Fix All Fixable ({stats.fixableCount})</span>
            </button>
          )}
        </div>
      </div>

      {/* Diagnostic Checks List */}
      <div className="max-h-[62vh] space-y-2.5 overflow-y-auto p-4 text-xs">
        {feedback && (
          <div
            role={feedback.tone === "error" ? "alert" : "status"}
            aria-live={feedback.tone === "error" ? "assertive" : "polite"}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
              feedback.tone === "error"
                ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            }`}
          >
            {feedback.tone === "error" ? (
              <AlertCircle
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
            ) : (
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
            )}
            <span className="break-words leading-relaxed">{feedback.text}</span>
          </div>
        )}

        {checks.map((check) => {
          const meta = STATUS_BADGE_MAP[check.status] ?? STATUS_BADGE_MAP.warning;
          const isExpanded = Boolean(expandedIds[check.id]);
          const showFixBtn = check.canAutoFix && check.status !== "ok";
          const isThisFixing = fixingId === check.id;

          return (
            <div
              key={check.id}
              className={`rounded-lg border bg-canvas/80 p-3 transition-colors ${meta.borderClass}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  {check.status === "ok" ? (
                    <CheckCircle2
                      aria-hidden="true"
                      className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400"
                    />
                  ) : check.status === "warning" ? (
                    <AlertTriangle
                      aria-hidden="true"
                      className="mt-0.5 h-4 w-4 shrink-0 text-amber-400"
                    />
                  ) : (
                    <AlertCircle
                      aria-hidden="true"
                      className="mt-0.5 h-4 w-4 shrink-0 text-rose-400"
                    />
                  )}

                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-fg">
                        {check.title}
                      </span>
                      <span
                        className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${meta.badgeClass}`}
                      >
                        {meta.label}
                      </span>
                      <code className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-subtle">
                        {check.id}
                      </code>
                    </div>

                    <p className="text-xs leading-relaxed text-muted">
                      {check.summary}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {showFixBtn && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleFix(check.id, check.fixLabel)}
                      title={check.fixLabel || "Fix"}
                      className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {isThisFixing ? (
                        <Loader2
                          aria-hidden="true"
                          className="h-3 w-3 animate-spin"
                        />
                      ) : (
                        <Wrench aria-hidden="true" className="h-3 w-3" />
                      )}
                      <span>{check.fixLabel || "Fix"}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() =>
                      setExpandedIds((prev) => ({
                        ...prev,
                        [check.id]: !prev[check.id],
                      }))
                    }
                    aria-expanded={isExpanded}
                    title={isExpanded ? "Скрыть подробности" : "Показать подробности"}
                    className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-fg"
                  >
                    {isExpanded ? (
                      <ChevronDown aria-hidden="true" className="h-3 w-3" />
                    ) : (
                      <ChevronRight aria-hidden="true" className="h-3 w-3" />
                    )}
                    <span>Детали</span>
                  </button>
                </div>
              </div>

              {isExpanded && check.details && (
                <div className="mt-2.5 flex items-start justify-between gap-2 rounded-md border border-hairline bg-surface/75 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted select-text">
                  <span className="whitespace-pre-wrap break-words">
                    {check.details}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(check.details);
                      onNotify(`Скопированы детали проверки «${check.title}»`);
                    }}
                    title="Копировать детали"
                    aria-label={`Копировать детали ${check.id}`}
                    className="shrink-0 rounded border border-hairline bg-canvas p-1 text-subtle hover:text-fg"
                  >
                    <Copy aria-hidden="true" className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline bg-elevated/40 px-4 py-2.5 text-[11px]">
        <span className="text-subtle">
          Горячая клавиша:{" "}
          <kbd className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-fg">
            Ctrl+Shift+D
          </kbd>{" "}
          • Health endpoint:{" "}
          <code className="font-mono text-muted">http://flux.proxy/health</code>
        </span>
        <form method="dialog">
          <button
            value="cancel"
            autoFocus
            {...({ autofocus: "" } as Record<string, string>)}
            className="rounded-md border border-strong bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:bg-hover"
          >
            Закрыть
          </button>
        </form>
      </div>
    </dialog>
  );
};
