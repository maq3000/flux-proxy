import React from "react";
import {
  BarChart2,
  ChevronLeft,
  ChevronUp,
  PanelBottom,
  PanelRight,
} from "lucide-react";
import type { InspectorDockPosition, SessionSummary } from "../types/proxy";

export interface CollapsedInspectorBarProps {
  position: InspectorDockPosition;
  selectedSession?: SessionSummary | null;
  selectedCount?: number;
  onExpand: () => void;
  onOpenStatistics: () => void;
  onChangePosition: (next: InspectorDockPosition) => void;
}

function getStatusToneClass(status: number): string {
  if (status === 0) return "text-muted";
  if (status >= 500) return "text-status5xx-fg";
  if (status >= 400) return "text-status4xx-fg";
  if (status >= 300) return "text-status3xx-fg";
  return "text-status2xx-fg";
}

function formatStatusBadge(status: number): string {
  return status === 0 ? "Pending" : String(status);
}

/**
 * Persistent one-click restore bar rendered whenever the Session Inspector
 * is collapsed on the Traffic screen (bottom horizontal strip or right vertical rail).
 */
export const CollapsedInspectorBar: React.FC<CollapsedInspectorBarProps> = ({
  position,
  selectedSession = null,
  selectedCount = 0,
  onExpand,
  onOpenStatistics,
  onChangePosition,
}) => {
  if (position === "right") {
    return (
      <div
        role="toolbar"
        aria-orientation="vertical"
        aria-label="Collapsed Session Inspector"
        data-testid="collapsed-inspector-bar"
        className="flex h-full w-7 shrink-0 select-none flex-col items-center justify-between border-l border-hairline bg-surface py-1.5"
      >
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={false}
          aria-label="Expand Session Inspector"
          title="Expand Session Inspector (Enter)"
          className="flex min-h-0 w-6 flex-1 flex-col items-center gap-2 rounded py-1 text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
          <span
            style={{ writingMode: "vertical-rl" }}
            className="rotate-180 whitespace-nowrap text-[11px] font-medium tracking-wide text-fg"
          >
            Session Inspector
          </span>
          {selectedCount > 1 ? (
            <span
              style={{ writingMode: "vertical-rl" }}
              className="rotate-180 whitespace-nowrap font-mono text-[10px] text-muted tabular-nums"
            >
              {selectedCount} selected
            </span>
          ) : (
            selectedSession && (
              <span
                style={{ writingMode: "vertical-rl" }}
                className="rotate-180 truncate whitespace-nowrap font-mono text-[10px] text-muted tabular-nums"
              >
                #{selectedSession.id} · {formatStatusBadge(selectedSession.status)}
              </span>
            )
          )}
        </button>

        <div className="mt-1 flex shrink-0 flex-col items-center gap-1 border-t border-hairline pt-1">
          <button
            type="button"
            onClick={onOpenStatistics}
            aria-label="Open Statistics"
            title="Expand Session Inspector on Statistics tab"
            className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <BarChart2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onChangePosition("bottom")}
            aria-label="Dock Bottom"
            title="Dock Session Inspector to Bottom"
            className="flex h-6 w-6 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <PanelBottom className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="toolbar"
      aria-label="Collapsed Session Inspector"
      data-testid="collapsed-inspector-bar"
      className="flex h-7 w-full shrink-0 select-none items-center justify-between gap-2 border-t border-hairline bg-surface px-2 text-xs"
    >
      <button
        type="button"
        onClick={onExpand}
        aria-expanded={false}
        title="Expand Session Inspector (Enter)"
        className="flex h-6 min-w-0 flex-1 items-center gap-2 rounded px-1.5 text-left transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <ChevronUp className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
        <span className="shrink-0 font-medium text-fg">
          Expand Session Inspector
        </span>

        {selectedCount > 1 ? (
          <span className="truncate font-mono text-[11px] text-muted tabular-nums">
            {selectedCount} sessions selected
          </span>
        ) : (
          selectedSession && (
            <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[11px] text-muted tabular-nums">
              <span className="shrink-0 text-subtle">#{selectedSession.id}</span>
              <span className="shrink-0 font-semibold text-fg">
                {selectedSession.method}
              </span>
              <span className="truncate text-muted">{selectedSession.path}</span>
              <span className="shrink-0 text-subtle">·</span>
              <span
                className={`shrink-0 font-semibold ${getStatusToneClass(selectedSession.status)}`}
              >
                {formatStatusBadge(selectedSession.status)}
              </span>
            </span>
          )
        )}

        <kbd
          aria-hidden="true"
          className="ml-auto hidden shrink-0 rounded border border-hairline bg-elevated px-1 font-mono text-[10px] text-subtle sm:inline"
        >
          Enter
        </kbd>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onOpenStatistics}
          title="Expand Session Inspector on Statistics tab"
          className="inline-flex h-6 items-center gap-1 rounded border border-hairline bg-elevated/70 px-2 text-[11px] font-medium text-muted transition-colors hover:border-strong hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <BarChart2 className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>Statistics</span>
        </button>

        <button
          type="button"
          onClick={() => onChangePosition("right")}
          aria-label="Dock Right"
          title="Dock Session Inspector to Right"
          className="inline-flex h-6 items-center gap-1 rounded border border-hairline bg-elevated/70 px-2 text-[11px] font-medium text-muted transition-colors hover:border-strong hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <PanelRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">Dock Right</span>
        </button>
      </div>
    </div>
  );
};
