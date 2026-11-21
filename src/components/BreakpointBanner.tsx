import React, { useEffect, useState } from "react";
import {
  Ban,
  FastForward,
  Flame,
  OctagonPause,
  Play,
  Sparkles,
  Zap,
} from "lucide-react";
import { isTauriRuntime, proxyBridge } from "../lib/tauriBridge";
import type {
  BreakpointAction,
  BreakpointConfig,
  BreakpointResolution,
  PausedBreakpointItem,
} from "../types/proxy";

export interface BreakpointBannerProps {
  config: BreakpointConfig;
  pausedItems: PausedBreakpointItem[];
  onInspectItem: (breakpointId: string) => void;
  onOpenRules: () => void;
  onQuickResolve: (resolution: BreakpointResolution) => void;
  onResumeAll: (action: BreakpointAction) => void;
  onDisableAll: () => void;
}

export const BreakpointBanner: React.FC<BreakpointBannerProps> = ({
  config,
  pausedItems,
  onInspectItem,
  onOpenRules,
  onQuickResolve,
  onResumeAll,
  onDisableAll,
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const activeRuleCount = config.rules.filter((r) => r.enabled).length;
  const anyArmed =
    config.breakBeforeRequest ||
    config.breakAfterResponse ||
    activeRuleCount > 0;

  useEffect(() => {
    if (pausedItems.length === 0) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [pausedItems.length]);

  if (pausedItems.length === 0 && !anyArmed) {
    return null;
  }

  const head = pausedItems[0] ?? null;
  const remainingSec = head
    ? Math.max(
        0,
        head.timeoutSecs -
          Math.floor((nowMs - Date.parse(head.createdAt)) / 1000)
      )
    : 0;

  if (!head) {
    // Armed indicator strip (no request currently parked yet)
    return (
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/[0.08] px-3 text-xs">
        <div className="flex min-w-0 items-center gap-2 font-mono text-[11px]">
          <OctagonPause className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span className="font-semibold text-amber-300">
            Live Breakpoints Armed:
          </span>
          {config.breakBeforeRequest && (
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-200">
              Before Request (F11)
            </span>
          )}
          {config.breakAfterResponse && (
            <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-bold text-violet-200">
              After Response (Alt+F11)
            </span>
          )}
          {activeRuleCount > 0 && (
            <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-bold text-sky-200">
              bpu rules: {activeRuleCount}
            </span>
          )}
          <span className="hidden truncate text-muted md:inline">
            Ожидание подходящего HTTP/HTTPS пакета...
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {!isTauriRuntime() && (
            <button
              type="button"
              onClick={() => proxyBridge.triggerSimulatedTrafficHit()}
              className="inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25"
            >
              <Zap className="h-3 w-3" />
              <span>Поймать пакет сейчас</span>
            </button>
          )}
          <button
            type="button"
            onClick={onOpenRules}
            className="rounded border border-hairline bg-surface px-2 py-0.5 text-[11px] text-muted hover:text-fg"
          >
            Правила `bpu`
          </button>
          <button
            type="button"
            onClick={onDisableAll}
            title="Отключить все точки останова (Shift+F11)"
            className="rounded border border-rose-500/35 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300 hover:bg-rose-500/20"
          >
            Снять все (Shift+F11)
          </button>
        </div>
      </div>
    );
  }

  const isResponseStage = head.stage === "response";

  return (
    <div
      className={`flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-1 text-xs ${
        isResponseStage
          ? "border-violet-500/45 bg-violet-500/15"
          : "border-amber-500/45 bg-amber-500/15"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2 font-mono text-[11px]">
        <span className="inline-flex animate-pulse items-center gap-1 rounded bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
          <OctagonPause className="h-3 w-3" />
          <span>
            {isResponseStage ? "PAUSED RESPONSE" : "PAUSED REQUEST"}
          </span>
        </span>

        {pausedItems.length > 1 && (
          <span className="rounded bg-canvas/80 px-1.5 py-0.5 text-[10px] font-bold text-amber-200">
            Очередь: {pausedItems.length}
          </span>
        )}

        <span className="font-bold text-fg">#{head.sessionId}</span>
        <span className="rounded bg-canvas/70 px-1.5 py-0.5 font-bold text-sky-300">
          {head.method}
        </span>
        {isResponseStage && head.responseStatus != null && (
          <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 font-bold text-emerald-300">
            HTTP {head.responseStatus}
          </span>
        )}
        <span className="max-w-md truncate text-fg" title={head.url}>
          {head.url}
        </span>
        <span className="text-[10px] text-muted tabular-nums">
          (авто-таймаут: {remainingSec}с)
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => onInspectItem(head.breakpointId)}
          className="inline-flex items-center gap-1 rounded-md border border-sky-400/60 bg-sky-500/25 px-2.5 py-1 text-xs font-semibold text-sky-100 shadow-sm hover:bg-sky-500/35"
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span>Править в Monaco</span>
        </button>

        {isResponseStage && (
          <button
            type="button"
            onClick={() =>
              onQuickResolve({
                breakpointId: head.breakpointId,
                action: "continue",
                statusCode: 500,
                responseHeaders: [
                  ...head.responseHeaders.filter(
                    (h) => h.name.toLowerCase() !== "content-type"
                  ),
                  { name: "Content-Type", value: "application/json; charset=utf-8" },
                ],
                responseBodyText: JSON.stringify(
                  {
                    error: "Internal Server Error",
                    injectedBy: "FluxProxy Live Breakpoint",
                    sessionId: head.sessionId,
                  },
                  null,
                  2
                ),
              })
            }
            title="Мгновенно подменить статус ответа на 500 Internal Server Error и вернуть в браузер"
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/50 bg-amber-500/20 px-2 py-1 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/30"
          >
            <Flame className="h-3 w-3" />
            <span>Вернуть 500</span>
          </button>
        )}

        <button
          type="button"
          onClick={() =>
            onQuickResolve({
              breakpointId: head.breakpointId,
              action: "continue",
            })
          }
          className="inline-flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/20 px-2.5 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/30"
        >
          <Play className="h-3 w-3" />
          <span>Continue</span>
        </button>

        <button
          type="button"
          onClick={() =>
            onQuickResolve({
              breakpointId: head.breakpointId,
              action: "abort",
            })
          }
          className="inline-flex items-center gap-1 rounded-md border border-rose-500/50 bg-rose-500/20 px-2 py-1 text-xs font-medium text-rose-200 hover:bg-rose-500/30"
        >
          <Ban className="h-3 w-3" />
          <span>Abort</span>
        </button>

        {pausedItems.length > 1 && (
          <button
            type="button"
            onClick={() => onResumeAll("continue")}
            title="Пропустить все поставленные на паузу пакеты"
            className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[11px] text-muted hover:text-fg"
          >
            <FastForward className="h-3 w-3" />
            <span>Resume All ({pausedItems.length})</span>
          </button>
        )}
      </div>
    </div>
  );
};
