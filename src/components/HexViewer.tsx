import React, { useMemo, useState } from "react";
import { decodeBase64ToBytes } from "../lib/formatters";

interface HexViewerProps {
  base64Data: string;
  maxBytes?: number;
}

const BYTES_PER_ROW = 16;

export const HexViewer: React.FC<HexViewerProps> = ({
  base64Data,
  maxBytes = 16_384,
}) => {
  const [hoveredOffset, setHoveredOffset] = useState<number | null>(null);

  const bytes = useMemo(() => {
    const decoded = decodeBase64ToBytes(base64Data);
    return decoded.length > maxBytes ? decoded.subarray(0, maxBytes) : decoded;
  }, [base64Data, maxBytes]);

  const rowCount = Math.ceil(bytes.length / BYTES_PER_ROW);

  if (bytes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-mono text-xs text-subtle">
        Empty payload (0 bytes)
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-canvas p-3 font-mono text-xs leading-5 select-text">
      <div className="mb-1.5 flex items-center gap-4 border-b border-hairline pb-1 text-[10px] font-semibold uppercase tracking-wider text-subtle">
        <span className="w-20">Offset</span>
        <span className="w-[360px]">
          00 01 02 03 04 05 06 07 &nbsp;08 09 0A 0B 0C 0D 0E 0F
        </span>
        <span>Decoded ASCII</span>
      </div>

      {Array.from({ length: rowCount }).map((_, rowIdx) => {
        const rowStart = rowIdx * BYTES_PER_ROW;
        const slice = bytes.subarray(rowStart, rowStart + BYTES_PER_ROW);

        return (
          <div
            key={rowStart}
            className="flex items-center gap-4 whitespace-pre hover:bg-hover/50"
          >
            <span className="w-20 text-subtle tabular-nums">
              {rowStart.toString(16).padStart(8, "0").toUpperCase()}
            </span>

            <span className="w-[360px] tabular-nums">
              {Array.from({ length: BYTES_PER_ROW }).map((__, colIdx) => {
                const absOffset = rowStart + colIdx;
                const val = colIdx < slice.length ? slice[colIdx] : null;
                const isHovered = hoveredOffset === absOffset;

                return (
                  <React.Fragment key={colIdx}>
                    {colIdx === 8 ? " " : ""}
                    {val !== null ? (
                      <span
                        onMouseEnter={() => setHoveredOffset(absOffset)}
                        onMouseLeave={() => setHoveredOffset(null)}
                        className={`inline-block rounded px-0.5 ${
                          isHovered
                            ? "bg-sky-500/30 text-sky-300"
                            : val === 0
                              ? "text-subtle"
                              : "text-fg"
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

            <span className="text-sky-400/90">
              {Array.from(slice).map((b, colIdx) => {
                const absOffset = rowStart + colIdx;
                const ch = b >= 32 && b <= 126 ? String.fromCharCode(b) : ".";
                const isHovered = hoveredOffset === absOffset;
                return (
                  <span
                    key={colIdx}
                    onMouseEnter={() => setHoveredOffset(absOffset)}
                    onMouseLeave={() => setHoveredOffset(null)}
                    className={
                      isHovered
                        ? "rounded bg-sky-500/30 text-sky-200"
                        : b < 32 || b > 126
                          ? "text-subtle"
                          : ""
                    }
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
  );
};
