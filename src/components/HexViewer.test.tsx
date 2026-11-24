import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HexViewer } from "./HexViewer";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number;
    estimateSize: () => number;
  }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * estimateSize(),
        size: estimateSize(),
      })),
  }),
}));

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

describe("HexViewer", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders empty placeholder when payload has 0 bytes", () => {
    render(<HexViewer base64Data="" />);
    expect(screen.getByText("Empty payload (0 bytes)")).toBeTruthy();
  });

  it("aligns header columns 00..0F and data rows in matching w-[392px] flex grids without ASCII overlap", () => {
    // 18 bytes => Row 0: 16 printable ASCII bytes ("ABCDEFGHIJKLMNOP"), Row 1: 0x00 + "Z"
    const payload = new Uint8Array([
      65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 0, 90,
    ]);
    const { container } = render(
      <HexViewer base64Data={bytesToBase64(payload)} />
    );

    const headerGrid = screen.getByLabelText("Hex byte columns 00 to 0F");
    expect(headerGrid.className).toContain("flex");
    expect(headerGrid.className).toContain("w-[392px]");
    expect(headerGrid.className).toContain("tracking-normal");
    expect(headerGrid.className).toContain("tabular-nums");

    const headerCells = Array.from(
      headerGrid.querySelectorAll<HTMLElement>("[data-header-col]")
    );
    expect(headerCells).toHaveLength(16);
    expect(headerCells.map((el) => el.textContent)).toEqual([
      "00",
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
      "07",
      "08",
      "09",
      "0A",
      "0B",
      "0C",
      "0D",
      "0E",
      "0F",
    ]);
    for (const cell of headerCells) {
      expect(cell.className).toContain("w-6");
      expect(cell.className).toContain("h-5");
      expect(cell.className).toContain("inline-flex");
    }
    expect(headerCells[0].className).not.toContain("ml-2");
    expect(headerCells[8].className).toContain("ml-2");

    const rows = Array.from(container.querySelectorAll<HTMLElement>(".hex-row"));
    expect(rows).toHaveLength(2);

    const firstRow = rows[0];
    expect(firstRow.className).toContain("flex");
    expect(firstRow.className).not.toContain("whitespace-pre");

    const byteContainer = firstRow.children[1] as HTMLElement;
    expect(byteContainer.className).toContain("flex");
    expect(byteContainer.className).toContain("w-[392px]");
    expect(byteContainer.className).toContain("tabular-nums");
    const row0ByteSpans = Array.from(
      byteContainer.querySelectorAll<HTMLElement>("[data-byte-col]")
    );
    expect(row0ByteSpans).toHaveLength(16);
    expect(row0ByteSpans[8].className).toContain("ml-2");
    expect(row0ByteSpans[15].textContent).toBe("50");

    const asciiContainer = firstRow.children[2] as HTMLElement;
    expect(asciiContainer.className).toContain("min-w-[164px]");
    const row0AsciiSpans = Array.from(
      asciiContainer.querySelectorAll<HTMLElement>("[data-byte-col]")
    );
    expect(row0AsciiSpans).toHaveLength(16);
    expect(row0AsciiSpans[8].className).toContain("ml-1");
    for (const span of row0AsciiSpans) {
      expect(span.className).toContain("w-2.5");
      expect(span.className).toContain("text-center");
    }
    expect(row0AsciiSpans.map((s) => s.textContent).join("")).toBe(
      "ABCDEFGHIJKLMNOP"
    );

    // Partial second row keeps 16 structural hex cells and 16 structural ASCII cells
    const secondRow = rows[1];
    const row1ByteContainer = secondRow.children[1] as HTMLElement;
    expect(row1ByteContainer.children).toHaveLength(16);
    expect(
      row1ByteContainer.querySelectorAll("[data-byte-col]")
    ).toHaveLength(2);
    const row1AsciiContainer = secondRow.children[2] as HTMLElement;
    expect(row1AsciiContainer.children).toHaveLength(16);
    const row1AsciiCells = Array.from(
      row1AsciiContainer.querySelectorAll<HTMLElement>("[data-byte-col]")
    );
    expect(row1AsciiCells.map((s) => s.textContent)).toEqual([".", "Z"]);
    expect(row1AsciiCells[0].className).toContain("text-subtle");

    // Paired byte hover highlights the matching column via data-hover-col without re-render
    fireEvent.mouseOver(row0ByteSpans[3]);
    expect(firstRow.dataset.hoverCol).toBe("3");
    fireEvent.mouseLeave(firstRow);
    expect(firstRow.dataset.hoverCol).toBeUndefined();
  });
});
