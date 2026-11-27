import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

import { SanitizedExportModal } from "./SanitizedExportModal";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement
  ) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (
    this: HTMLDialogElement
  ) {
    this.removeAttribute("open");
  });
});

afterEach(() => {
  cleanup();
});

describe("SanitizedExportModal includeEvictedSqlite option [PERF-03]", () => {
  it("defaults includeEvictedSqlite to false and forwards true only when checked for All Sessions", async () => {
    const onExport = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    render(
      <SanitizedExportModal
        open={true}
        totalCount={100}
        archivedCount={250}
        selectedIds={[1, 2]}
        onClose={vi.fn()}
        onExport={onExport}
      />
    );

    const checkbox = screen.getByRole("checkbox", {
      name: /Включить вытесненные в SQLite/i,
    }) as HTMLInputElement;
    // Modal defaults to "selected" scope when selectedIds is non-empty, disabling SQLite toggle
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);

    // Switch to All Sessions -> checkbox becomes enabled & stays unchecked by default
    fireEvent.click(screen.getByRole("button", { name: /All Sessions/i }));
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(false);

    // Default submit (returning false keeps dialog open) -> includeEvictedSqlite = false
    fireEvent.click(
      screen.getByRole("button", { name: /Export Sanitized Archive/i })
    );
    await waitFor(() => {
      expect(onExport).toHaveBeenCalledTimes(1);
    });
    expect(onExport).toHaveBeenLastCalledWith(
      [],
      "har",
      expect.any(Object),
      false
    );

    // Selecting "Selected Only" disables the SQLite archive checkbox; switching back re-enables it
    fireEvent.click(screen.getByRole("button", { name: /Selected Only/i }));
    expect(checkbox.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /All Sessions/i }));
    expect(checkbox.disabled).toBe(false);

    // Checking the SQLite archive option updates count & forwards true
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(screen.getByText("350")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Export Sanitized Archive/i })
    );
    await waitFor(() => {
      expect(onExport).toHaveBeenCalledTimes(2);
    });
    expect(onExport).toHaveBeenLastCalledWith(
      [],
      "har",
      expect.any(Object),
      true
    );
  });
});
