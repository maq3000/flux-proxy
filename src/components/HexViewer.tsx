import React, { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useContextMenu } from "../hooks/useContextMenu";
import {
  buildHexViewerContextMenu,
  copyTextToClipboard,
} from "../lib/contextMenuBuilders";
import { decodeBase64ToBytes } from "../lib/formatters";
import { bytesToHex } from "../lib/textWizard";
import type { TextWizardTab } from "./TextWizardPanel";

interface HexViewerProps {
  base64Data: string;
  maxBytes?: number;
  onOpenTextWizard?: (text: string, tab: TextWizardTab) => void;
  onSaveBodyAs?: () => void;
  onNotify?: (msg: string) => void;
}

const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 20;
const COL_INDICES = Array.from({ length: BYTES_PER_ROW }, (_, i) => i);

export const HexViewer: React.FC<HexViewerProps> = ({
  base64Data,
  maxBytes = 16_384,
  onOpenTextWizard,
  onSaveBodyAs,
  onNotify,
}) => {
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const { openContextMenu } = useContextMenu();

  const bytes = useMemo(() => {
    const decoded = decodeBase64ToBytes(base64Data);
    return decoded.length > maxBytes ? decoded.subarray(0, maxBytes) : decoded;
  }, [base64Data, maxBytes]);

  const rowCount = Math.ceil(bytes.length / BYTES_PER_ROW);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  const handleHexContextMenu = (
    e: React.MouseEvent,
    rowStart: number | null,
    rowSlice: Uint8Array | null
  ) => {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (
      sel &&
      !sel.isCollapsed &&
      sel.toString().trim().length > 0 &&
      scrollParentRef.current?.contains(sel.anchorNode)
    ) {
      return;
    }

    const rowHex = rowSlice ? bytesToHex(rowSlice, " ") : "";
    const rowAscii = rowSlice
      ? Array.from(rowSlice, (b) =>
          b >= 32 && b <= 126 ? String.fromCharCode(b) : "."
        ).join("")
      : "";

    openContextMenu(
      e,
      buildHexViewerContextMenu({
        rowOffset: rowStart,
        totalBytes: bytes.length,
        hasRow: Boolean(rowSlice && rowSlice.length > 0),
        onCopyRowHex: () =>
          void copyTextToClipboard(rowHex, onNotify, "Скопирована строка Hex"),
        onCopyRowAscii: () =>
          void copyTextToClipboard(
            rowAscii,
            onNotify,
            "Скопирована строка ASCII"
          ),
        onCopyAllHex: () =>
          void copyTextToClipboard(
            bytesToHex(bytes, " "),
            onNotify,
            `Скопирован Hex (${bytes.length} B)`
          ),
        onCopyAllBase64: () =>
          void copyTextToClipboard(
            base64Data,
            onNotify,
            "Скопировано в Base64"
          ),
        onOpenInTextWizard: onOpenTextWizard
          ? () => onOpenTextWizard(bytesToHex(bytes, " "), "hex")
          : undefined,
        onSaveBodyAs,
      }),
      { ariaLabel: "Hex Viewer Context Menu" }
    );
  };

  if (bytes.length === 0) {
    return (
      <div
        onContextMenu={(e) => handleHexContextMenu(e, null, null)}
        className="flex h-full items-center justify-center font-mono text-xs text-subtle"
      >
        Empty payload (0 bytes)
      </div>
    );
  }

  return (
    <div
      ref={scrollParentRef}
      onContextMenu={(e) => handleHexContextMenu(e, null, null)}
      className="h-full overflow-auto bg-canvas px-3 pb-3 font-mono text-xs leading-5 select-text"
    >
      <div className="sticky top-0 z-10 mb-1.5 flex min-w-max items-center gap-4 border-b border-hairline bg-canvas pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-subtle">
        <span className="w-20 shrink-0">Offset</span>
        <div
          aria-label="Hex byte columns 00 to 0F"
          className="flex w-[392px] shrink-0 items-center tracking-normal tabular-nums"
        >
          {COL_INDICES.map((colIdx) => (
            <span
              key={colIdx}
              data-header-col={colIdx}
              className={`inline-flex h-5 w-6 shrink-0 items-center justify-center font-mono text-xs font-semibold ${
                colIdx === 8 ? "ml-2" : ""
              }`}
            >
              {colIdx.toString(16).padStart(2, "0").toUpperCase()}
            </span>
          ))}
        </div>
        <span className="min-w-[164px] shrink-0">Decoded ASCII</span>
      </div>

      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          position: "relative",
          minWidth: "max-content",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const rowStart = virtualRow.index * BYTES_PER_ROW;
          const slice = bytes.subarray(rowStart, rowStart + BYTES_PER_ROW);

          return (
            <div
              key={rowStart}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              onMouseOver={(e) => {
                const cell = (
                  e.target as HTMLElement | null
                )?.closest<HTMLElement>("[data-byte-col]");
                if (cell?.dataset.byteCol !== undefined) {
                  e.currentTarget.dataset.hoverCol = cell.dataset.byteCol;
                } else {
                  delete e.currentTarget.dataset.hoverCol;
                }
              }}
              onMouseLeave={(e) => {
                delete e.currentTarget.dataset.hoverCol;
              }}
              onContextMenu={(e) => handleHexContextMenu(e, rowStart, slice)}
              className="hex-row flex min-w-max items-center gap-4 hover:bg-hover/50"
            >
              <span className="w-20 shrink-0 text-subtle tabular-nums">
                {rowStart.toString(16).padStart(8, "0").toUpperCase()}
              </span>

              <div className="flex w-[392px] shrink-0 items-center tabular-nums">
                {COL_INDICES.map((colIdx) => {
                  const absOffset = rowStart + colIdx;
                  const val = colIdx < slice.length ? slice[colIdx] : null;

                  if (val === null) {
                    return (
                      <span
                        key={colIdx}
                        aria-hidden="true"
                        className={`inline-flex h-5 w-6 shrink-0 items-center justify-center font-mono text-xs ${
                          colIdx === 8 ? "ml-2" : ""
                        }`}
                      />
                    );
                  }

                  return (
                    <span
                      key={colIdx}
                      data-byte-col={colIdx}
                      data-byte-offset={absOffset}
                      className={`inline-flex h-5 w-6 shrink-0 items-center justify-center rounded font-mono text-xs ${
                        colIdx === 8 ? "ml-2" : ""
                      } ${val === 0 ? "text-subtle" : "text-fg"}`}
                    >
                      {val.toString(16).padStart(2, "0").toUpperCase()}
                    </span>
                  );
                })}
              </div>

              <div className="flex min-w-[164px] shrink-0 items-center whitespace-pre text-sky-400/90">
                {COL_INDICES.map((colIdx) => {
                  if (colIdx >= slice.length) {
                    return (
                      <span
                        key={colIdx}
                        aria-hidden="true"
                        className={`inline-block w-2.5 shrink-0 text-center ${
                          colIdx === 8 ? "ml-1" : ""
                        }`}
                      />
                    );
                  }
                  const b = slice[colIdx];
                  const absOffset = rowStart + colIdx;
                  const ch = b >= 32 && b <= 126 ? String.fromCharCode(b) : ".";
                  return (
                    <span
                      key={colIdx}
                      data-byte-col={colIdx}
                      data-byte-offset={absOffset}
                      className={`inline-block w-2.5 shrink-0 rounded text-center ${
                        colIdx === 8 ? "ml-1" : ""
                      } ${b < 32 || b > 126 ? "text-subtle" : ""}`}
                    >
                      {ch}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
