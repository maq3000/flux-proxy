import React from "react";
import { useProxyStore } from "../../stores/proxyStore";
import { useTrafficTelemetryStore } from "../../stores/trafficTelemetryStore";

export interface SessionCountsBadgeProps {
  format: "menuBar" | "filterButton";
}

export const SessionCountsBadge: React.FC<SessionCountsBadgeProps> = React.memo(
  ({ format }) => {
    const totalCount = useTrafficTelemetryStore((s) => s.totalCount);
    const filteredCount = useTrafficTelemetryStore((s) => s.filteredCount);

    if (format === "menuBar") {
      return (
        <span className="hidden tabular-nums sm:inline">
          {filteredCount.toLocaleString()} / {totalCount.toLocaleString()} sessions
        </span>
      );
    }

    return (
      <>
        {filteredCount.toLocaleString()}/{totalCount.toLocaleString()}
      </>
    );
  }
);
SessionCountsBadge.displayName = "SessionCountsBadge";

interface TelemetryMenuButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  mode: "total" | "filtered";
  explicitDisabled?: boolean;
}

export const TelemetryMenuButton: React.FC<TelemetryMenuButtonProps> =
  React.memo(({ mode, explicitDisabled, disabled, children, ...rest }) => {
    const hasMetric = useTrafficTelemetryStore((s) =>
      mode === "total" ? s.hasSessions : s.hasFilteredSessions
    );
    const resolvedDisabled =
      explicitDisabled !== undefined
        ? explicitDisabled
        : Boolean(disabled) || !hasMetric;

    return (
      <button type="button" disabled={resolvedDisabled} {...rest}>
        {children}
      </button>
    );
  });
TelemetryMenuButton.displayName = "TelemetryMenuButton";

export const DroppedSessionsBadge: React.FC = React.memo(() => {
  const droppedSessionsCount = useProxyStore(
    (s) => s.storageStats.droppedSessionsCount
  );
  if (droppedSessionsCount <= 0) return null;
  return (
    <span className="rounded-full bg-canvas/80 px-1.5 font-mono text-[10px] font-semibold tabular-nums text-fg">
      {droppedSessionsCount.toLocaleString()}
    </span>
  );
});
DroppedSessionsBadge.displayName = "DroppedSessionsBadge";

export const MarkedSessionsBadge: React.FC = React.memo(() => {
  const markedCount = useProxyStore((s) => s.markedSessionsCount);
  if (markedCount <= 0) return null;
  return (
    <span className="rounded-full bg-status4xx-bg px-1 font-mono text-[9px] font-semibold text-status4xx-fg tabular-nums">
      {markedCount}
    </span>
  );
});
MarkedSessionsBadge.displayName = "MarkedSessionsBadge";

export interface FooterStorageStatsBadgeProps {
  sessionRetentionLimit: number | null;
  dropNonMatching: boolean;
  clearDbOnExit: boolean;
  onOpenCustomRetentionLimit: () => void;
  onConfirmSqlitePurge: () => void;
}

export const FooterStorageStatsBadge: React.FC<FooterStorageStatsBadgeProps> =
  React.memo(
    ({
      sessionRetentionLimit,
      dropNonMatching,
      clearDbOnExit,
      onOpenCustomRetentionLimit,
      onConfirmSqlitePurge,
    }) => {
      const storageStats = useProxyStore((s) => s.storageStats);
      return (
        <div className="flex shrink-0 items-center gap-1.5 tabular-nums text-muted">
          <button
            type="button"
            onClick={onOpenCustomRetentionLimit}
            title={`Кольцевой буфер (Ring Buffer): ${
              sessionRetentionLimit === null
                ? "All Sessions (без ограничений)"
                : `Keep ${sessionRetentionLimit.toLocaleString("en-US")} сессий`
            } • Drop Non-Matching: ${
              dropNonMatching ? "ON" : "OFF"
            } — нажмите для настройки лимита`}
            className="transition-colors hover:text-fg"
          >
            RAM:{" "}
            <strong className="font-semibold text-fg">
              {storageStats.ramSessions.toLocaleString("en-US")}
            </strong>{" "}
            ses
          </button>
          <span aria-hidden="true">|</span>
          <button
            type="button"
            onClick={onConfirmSqlitePurge}
            title={`Размер архива SQLite (sessions.sqlite + WAL): ${(
              storageStats.sqliteSizeBytes /
              (1024 * 1024)
            ).toFixed(2)} MB • Очистка при выходе: ${
              clearDbOnExit ? "ON" : "OFF"
            } — нажмите для очистки и VACUUM`}
            className="transition-colors hover:text-fg"
          >
            SQLite:{" "}
            <strong className="font-semibold text-fg">
              {(storageStats.sqliteSizeBytes / (1024 * 1024)).toFixed(1)} MB
            </strong>
          </button>
          <span aria-hidden="true">|</span>
          <button
            type="button"
            onClick={onOpenCustomRetentionLimit}
            title={`Отброшено сессий фильтром (Drop Non-Matching): ${storageStats.droppedSessionsCount.toLocaleString(
              "en-US"
            )} — нажмите для настройки буфера`}
            className="transition-colors hover:text-fg"
          >
            Dropped:{" "}
            <strong
              className={`font-semibold ${
                storageStats.droppedSessionsCount > 0
                  ? "text-status4xx-fg"
                  : "text-fg"
              }`}
            >
              {storageStats.droppedSessionsCount.toLocaleString("en-US")}
            </strong>
          </button>
        </div>
      );
    }
  );
FooterStorageStatsBadge.displayName = "FooterStorageStatsBadge";
