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
    sanitizedExportModalOpen: false,
    setSanitizedExportModalOpen: vi.fn(),
    settingsModalOpen: false,
    onToggleSettingsMain: vi.fn(),
    onToggleSettingsAt: vi.fn(),
    setPaletteOpen: vi.fn(),
    setShortcutsModalOpen: vi.fn(),
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

describe("useGlobalShortcuts — Fiddler E, 7-tab workspace navigation & Breakpoints", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens selected session in Composer on single key E (including non-Latin KeyE)", () => {
    const openInComposer = vi.fn();
    const setActiveSection = vi.fn();
    const { getByTestId } = render(
      <ShortcutHarness
        options={createOptions({ openInComposer, setActiveSection })}
      />
    );

    const target = getByTestId("grid-focus-target");
    fireEvent.keyDown(target, { key: "e", code: "KeyE" });
    expect(openInComposer).toHaveBeenCalledTimes(1);
    expect(openInComposer).toHaveBeenCalledWith(101);
    expect(setActiveSection).not.toHaveBeenCalled();

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

  it("switches to TextWizard tab (and back to Traffic) on Ctrl+E / Cmd+E without triggering openInComposer", () => {
    const openInComposer = vi.fn();
    let currentSection: ActiveNavSection = "traffic";
    const setActiveSection = vi.fn(
      (
        updater:
          | ActiveNavSection
          | ((prev: ActiveNavSection) => ActiveNavSection)
      ) => {
        currentSection =
          typeof updater === "function" ? updater(currentSection) : updater;
      }
    );

    const { getByTestId } = render(
      <ShortcutHarness
        options={createOptions({ openInComposer, setActiveSection })}
      />
    );

    const target = getByTestId("grid-focus-target");
    fireEvent.keyDown(target, { key: "e", code: "KeyE", ctrlKey: true });
    expect(setActiveSection).toHaveBeenCalledTimes(1);
    expect(currentSection).toBe("wizard");
    expect(openInComposer).not.toHaveBeenCalled();

    fireEvent.keyDown(target, { key: "e", code: "KeyE", metaKey: true });
    expect(setActiveSection).toHaveBeenCalledTimes(2);
    expect(currentSection).toBe("traffic");
    expect(openInComposer).not.toHaveBeenCalled();
  });

  it("navigates all Alt+1..6 targets, Ctrl+D Session Diff tab toggle, and F11 breakpoint arm/disarm shortcuts", () => {
    const setActiveSection = vi.fn();
    const onToggleSettingsAt = vi.fn();
    const openDiffWithPairSmart = vi.fn();
    const toggleBreakBeforeRequest = vi.fn();
    const toggleBreakAfterResponse = vi.fn();
    const disableAllBreakpoints = vi.fn();

    const { rerender, getByTestId } = render(
      <ShortcutHarness
        options={createOptions({
          activeSection: "traffic",
          setActiveSection,
          onToggleSettingsAt,
          openDiffWithPairSmart,
          toggleBreakBeforeRequest,
          toggleBreakAfterResponse,
          disableAllBreakpoints,
        })}
      />
    );

    const target = getByTestId("grid-focus-target");
    fireEvent.keyDown(target, { key: "1", altKey: true });
    expect(setActiveSection).toHaveBeenLastCalledWith("traffic");

    fireEvent.keyDown(target, { key: "2", altKey: true });
    expect(setActiveSection).toHaveBeenLastCalledWith("composer");

    fireEvent.keyDown(target, { key: "3", altKey: true });
    expect(setActiveSection).toHaveBeenLastCalledWith("rules");

    fireEvent.keyDown(target, { key: "4", altKey: true });
    expect(onToggleSettingsAt).toHaveBeenCalledWith("filters", "matrix");

    fireEvent.keyDown(target, { key: "5", altKey: true });
    expect(setActiveSection).toHaveBeenLastCalledWith("scripts");

    fireEvent.keyDown(target, { key: "6", altKey: true });
    expect(setActiveSection).toHaveBeenLastCalledWith("breakpoints");

    // Ctrl+D opens Session Diff tab via smart pair helper
    fireEvent.keyDown(target, { key: "d", code: "KeyD", ctrlKey: true });
    expect(openDiffWithPairSmart).toHaveBeenCalledTimes(1);

    // Ctrl+D while already on Session Diff returns to Traffic tab
    rerender(
      <ShortcutHarness
        options={createOptions({
          activeSection: "diff",
          setActiveSection,
          onToggleSettingsAt,
          openDiffWithPairSmart,
          toggleBreakBeforeRequest,
          toggleBreakAfterResponse,
          disableAllBreakpoints,
        })}
      />
    );
    fireEvent.keyDown(target, { key: "d", code: "KeyD", ctrlKey: true });
    expect(setActiveSection).toHaveBeenLastCalledWith("traffic");

    // F11 / Alt+F11 / Shift+F11 arm/disarm
    fireEvent.keyDown(target, { key: "F11" });
    expect(toggleBreakBeforeRequest).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(target, { key: "F11", altKey: true });
    expect(toggleBreakAfterResponse).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(target, { key: "F11", shiftKey: true });
    expect(disableAllBreakpoints).toHaveBeenCalledTimes(1);
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
