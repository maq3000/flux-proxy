import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useGlobalShortcuts,
  type UseGlobalShortcutsOptions,
} from "./useGlobalShortcuts";
import type { ActiveNavSection, SessionSummary } from "../types/proxy";

const SAMPLE_SESSIONS: SessionSummary[] = [
  {
    id: 101,
    status: 200,
    protocol: "HTTPS",
    scheme: "https",
    method: "GET",
    host: "api.example.com",
    path: "/v1/users",
    url: "https://api.example.com/v1/users",
    contentType: "application/json",
    bodySize: 120,
    durationMs: 12,
    timestamp: "12:00:00.000",
    isMocked: false,
  },
];

function createOptions(
  overrides: Partial<UseGlobalShortcutsOptions> = {}
): UseGlobalShortcutsOptions {
  return {
    activeSection: "traffic" as ActiveNavSection,
    setActiveSection: vi.fn(),
    diffModalOpen: false,
    setDiffModalOpen: vi.fn(),
    sanitizedExportModalOpen: false,
    setSanitizedExportModalOpen: vi.fn(),
    settingsModalOpen: false,
    onToggleSettingsMain: vi.fn(),
    onToggleSettingsAt: vi.fn(),
    onToggleBreakpointsModal: vi.fn(),
    setPaletteOpen: vi.fn(),
    setShortcutsModalOpen: vi.fn(),
    setTextWizardOpen: vi.fn(),
    selectedId: 101,
    effectiveSelectedIds: [101],
    filteredSessions: SAMPLE_SESSIONS,
    sortedSessionsRef: { current: SAMPLE_SESSIONS },
    clearAllSessions: vi.fn(),
    copyUrlsForIds: vi.fn(),
    deleteSessions: vi.fn(),
    disableAllBreakpoints: vi.fn(),
    exportAllSessionsAs: vi.fn(),
    handleFocusSearch: vi.fn(),
    importArchiveDialog: vi.fn(),
    openAnnotationFor: vi.fn(),
    openDiffWithPairSmart: vi.fn(),
    openInComposer: vi.fn(),
    openSanitizedExportModal: vi.fn(),
    replaySessions: vi.fn(),
    selectSessions: vi.fn(),
    toggleBreakAfterResponse: vi.fn(),
    toggleBreakBeforeRequest: vi.fn(),
    toggleCompactToolbar: vi.fn(),
    toggleProxy: vi.fn(),
    toggleSidebar: vi.fn(),
    unmarkSessions: vi.fn(),
    ...overrides,
  };
}

const ShortcutHarness: React.FC<{ options: UseGlobalShortcutsOptions }> = ({
  options,
}) => {
  useGlobalShortcuts(options);
  return (
    <div>
      <input data-testid="text-input" type="text" />
      <textarea data-testid="textarea-input" />
      <select data-testid="select-input">
        <option value="a">A</option>
      </select>
      <div data-testid="contenteditable" contentEditable suppressContentEditableWarning />
      <div className="monaco-editor">
        <div data-testid="monaco-inner" />
      </div>
      <div data-testid="grid-focus-target" tabIndex={0} />
    </div>
  );
};

describe("useGlobalShortcuts — Fiddler E vs Ctrl+E", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens selected session in Composer on single key E (including non-Latin KeyE)", () => {
    const openInComposer = vi.fn();
    const setTextWizardOpen = vi.fn();
    const { getByTestId } = render(
      <ShortcutHarness
        options={createOptions({ openInComposer, setTextWizardOpen })}
      />
    );

    const target = getByTestId("grid-focus-target");
    fireEvent.keyDown(target, { key: "e", code: "KeyE" });
    expect(openInComposer).toHaveBeenCalledTimes(1);
    expect(openInComposer).toHaveBeenCalledWith(101);
    expect(setTextWizardOpen).not.toHaveBeenCalled();

    // Non-Latin keyboard layout (e.g. Russian 'у' on KeyE)
    fireEvent.keyDown(target, { key: "у", code: "KeyE" });
    expect(openInComposer).toHaveBeenCalledTimes(2);
    expect(openInComposer).toHaveBeenLastCalledWith(101);
  });

  it("falls back to effectiveSelectedIds[0] when selectedId is null and no-ops if empty", () => {
    const openInComposer = vi.fn();
    const { rerender, getByTestId } = render(
      <ShortcutHarness
        options={createOptions({
          selectedId: null,
          effectiveSelectedIds: [202],
          openInComposer,
        })}
      />
    );

    fireEvent.keyDown(getByTestId("grid-focus-target"), {
      key: "e",
      code: "KeyE",
    });
    expect(openInComposer).toHaveBeenCalledWith(202);

    openInComposer.mockClear();
    rerender(
      <ShortcutHarness
        options={createOptions({
          selectedId: null,
          effectiveSelectedIds: [],
          openInComposer,
        })}
      />
    );
    fireEvent.keyDown(getByTestId("grid-focus-target"), {
      key: "e",
      code: "KeyE",
    });
    expect(openInComposer).not.toHaveBeenCalled();
  });

  it("keeps Ctrl+E / Cmd+E bound to TextWizard without triggering openInComposer", () => {
    const openInComposer = vi.fn();
    const setTextWizardOpen = vi.fn();
    const { getByTestId } = render(
      <ShortcutHarness
        options={createOptions({ openInComposer, setTextWizardOpen })}
      />
    );

    const target = getByTestId("grid-focus-target");
    fireEvent.keyDown(target, { key: "e", code: "KeyE", ctrlKey: true });
    expect(setTextWizardOpen).toHaveBeenCalledTimes(1);
    expect(openInComposer).not.toHaveBeenCalled();

    fireEvent.keyDown(target, { key: "e", code: "KeyE", metaKey: true });
    expect(setTextWizardOpen).toHaveBeenCalledTimes(2);
    expect(openInComposer).not.toHaveBeenCalled();
  });

  it("ignores Shift+E, Alt+E, and E outside the traffic section", () => {
    const openInComposer = vi.fn();
    const { rerender, getByTestId } = render(
      <ShortcutHarness options={createOptions({ openInComposer })} />
    );

    const target = getByTestId("grid-focus-target");
    fireEvent.keyDown(target, { key: "E", code: "KeyE", shiftKey: true });
    fireEvent.keyDown(target, { key: "e", code: "KeyE", altKey: true });
    expect(openInComposer).not.toHaveBeenCalled();

    rerender(
      <ShortcutHarness
        options={createOptions({
          activeSection: "composer",
          openInComposer,
        })}
      />
    );
    fireEvent.keyDown(target, { key: "e", code: "KeyE" });
    expect(openInComposer).not.toHaveBeenCalled();
  });

  it("does not trigger single-key E inside editable fields, Monaco, open dialogs, or popovers", () => {
    const openInComposer = vi.fn();
    const { getByTestId } = render(
      <div>
        <ShortcutHarness options={createOptions({ openInComposer })} />
        <dialog open>
          <div data-testid="dialog-child" />
        </dialog>
        <div {...({ popover: "auto" } as Record<string, string>)}>
          <button type="button" data-testid="popover-btn">
            Item
          </button>
        </div>
      </div>
    );

    fireEvent.keyDown(getByTestId("text-input"), { key: "e", code: "KeyE" });
    fireEvent.keyDown(getByTestId("textarea-input"), { key: "e", code: "KeyE" });
    fireEvent.keyDown(getByTestId("select-input"), { key: "e", code: "KeyE" });
    fireEvent.keyDown(getByTestId("contenteditable"), {
      key: "e",
      code: "KeyE",
    });
    fireEvent.keyDown(getByTestId("monaco-inner"), { key: "e", code: "KeyE" });
    fireEvent.keyDown(getByTestId("popover-btn"), { key: "e", code: "KeyE" });
    fireEvent.keyDown(getByTestId("dialog-child"), { key: "e", code: "KeyE" });

    expect(openInComposer).not.toHaveBeenCalled();
  });
});
