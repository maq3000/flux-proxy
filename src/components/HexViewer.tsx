import React, { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { decodeBase64ToBytes } from "../lib/formatters";

interface HexViewerProps {
  base64Data: string;
  maxBytes?: number;
}

const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 20;
const COL_INDICES = Array.from({ length: BYTES_PER_ROW }, (_, i) => i);

export const HexViewer: React.FC<HexViewerProps> = ({
  base64Data,
  maxBytes = 16_384,
}) => {
  const scrollParentRef = useRef<HTMLDivElement>(null);

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

  if (bytes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-mono text-xs text-subtle">
        Empty payload (0 bytes)
      </div>
    );
  }

  return (
    <div
      ref={scrollParentRef}
      className="h-full overflow-auto bg-canvas px-3 pb-3 font-mono text-xs leading-5 select-text"
    >
      <div className="sticky top-0 z-10 mb-1.5 flex min-w-max items-center gap-4 border-b border-hairline bg-canvas pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-subtle">
        <span className="w-20 shrink-0">Offset</span>
        <span className="w-[360px] shrink-0">
          00 01 02 03 04 05 06 07 &nbsp;08 09 0A 0B 0C 0D 0E 0F
        </span>
        <span className="shrink-0">Decoded ASCII</span>
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
              className="hex-row flex items-center gap-4 whitespace-pre hover:bg-hover/50"
            >
              <span className="w-20 shrink-0 text-subtle tabular-nums">
                {rowStart.toString(16).padStart(8, "0").toUpperCase()}
              </span>

              <span className="w-[360px] shrink-0 tabular-nums">
                {COL_INDICES.map((colIdx) => {
                  const absOffset = rowStart + colIdx;
                  const val = colIdx < slice.length ? slice[colIdx] : null;

                  return (
                    <React.Fragment key={colIdx}>
                      {colIdx === 8 ? " " : ""}
                      {val !== null ? (
                        <span
                          data-byte-col={colIdx}
                          data-byte-offset={absOffset}
                          className={`inline-block rounded px-0.5 ${
                            val === 0 ? "text-subtle" : "text-fg"
                          }`}
                        >
                          {val.toString(16).padStart(2, "0").toUpperCase()}
                        </span>
                      ) : (
                        <span className="inline-block px-0.5">{"  "}</span>
                      )}{" "}
                    </React.Fragment>
                  );
                })}
              </span>

              <span className="shrink-0 text-sky-400/90">
                {Array.from(slice, (b, colIdx) => {
                  const absOffset = rowStart + colIdx;
                  const ch = b >= 32 && b <= 126 ? String.fromCharCode(b) : ".";
                  return (
                    <span
                      key={colIdx}
                      data-byte-col={colIdx}
                      data-byte-offset={absOffset}
                      className={b < 32 || b > 126 ? "rounded text-subtle" : "rounded"}
                    >
                      {ch}
                    </span>
                  );
                })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
