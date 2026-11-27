import React from "react";
import { AlertTriangle, Binary, Download } from "lucide-react";
import { formatBytes } from "../lib/formatters";
import { MAX_MONACO_RENDER_BYTES } from "../lib/monacoLimits";

export interface MonacoSizeGuardNoticeProps {
  payloadLabel?: string;
  sizeBytes?: number | null;
  onOpenHexViewer?: () => void;
  hexButtonLabel?: string;
  onSaveToDisk?: () => void;
  saveButtonLabel?: string;
}

export const MonacoSizeGuardNotice: React.FC<MonacoSizeGuardNoticeProps> = ({
  payloadLabel = "тело",
  sizeBytes,
  onOpenHexViewer,
  hexButtonLabel = "Открыть в HexViewer",
  onSaveToDisk,
  saveButtonLabel = "Сохранить тело на диск",
}) => {
  const formattedSize =
    typeof sizeBytes === "number" && sizeBytes > 0
      ? formatBytes(sizeBytes)
      : `> ${formatBytes(MAX_MONACO_RENDER_BYTES)}`;

  return (
    <div
      data-testid="monaco-size-guard-notice"
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-full border border-status3xx-fg/35 bg-status3xx-bg text-status3xx-fg">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="max-w-md space-y-1">
        <p className="text-xs font-semibold text-fg">
          Потолок памяти Monaco/WebView2: {payloadLabel} ({formattedSize}) превышает лимит{" "}
          {formatBytes(MAX_MONACO_RENDER_BYTES)}
        </p>
        <p className="text-[11px] leading-relaxed text-muted">
          Рендеринг текстов свыше 2 МБ в Monaco отключён для защиты WebView2 от утечек памяти и
          зависаний. Используйте HexViewer или сохраните payload на диск.
        </p>
      </div>
      {(onOpenHexViewer || onSaveToDisk) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onOpenHexViewer && (
            <button
              type="button"
              onClick={onOpenHexViewer}
              className="inline-flex items-center gap-1.5 rounded border border-accent/50 bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/25"
            >
              <Binary className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{hexButtonLabel}</span>
            </button>
          )}
          {onSaveToDisk && (
            <button
              type="button"
              onClick={onSaveToDisk}
              className="inline-flex items-center gap-1.5 rounded border border-hairline bg-surface px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-hover"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{saveButtonLabel}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
