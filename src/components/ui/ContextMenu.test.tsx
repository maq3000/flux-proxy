import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

vi.mock("@monaco-editor/react", () => ({
  default: () => <div className="monaco-editor" data-testid="monaco-mock" />,
  DiffEditor: () => <div className="monaco-editor" data-testid="monaco-diff-mock" />,
}));

import {
  ContextMenuProvider,
  computeContextMenuPosition,
  computeSubmenuPosition,
} from "./ContextMenu";
import {
  normalizeContextMenuItems,
  useContextMenu,
  type ContextMenuItem,
} from "../../hooks/useContextMenu";
import {
  buildEditableInputMenuItems,
  captureEditableSelection,
  findEditableTextTarget,
  shouldPreserveNativeContextMenu,
} from "../../lib/contextMenuBuilders";
import {
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_VISIBLE_COLUMNS,
} from "../../hooks/useUiPreferences";
import { AutoResponderPanel } from "../AutoResponderPanel";
import { CollapsedInspectorBar } from "../CollapsedInspectorBar";
import { ScriptingPanel } from "../ScriptingPanel";
import { SessionInspector } from "../SessionInspector";
import { Sidebar } from "../Sidebar";
import { TrafficGrid } from "../TrafficGrid";
import type { AutoResponderRule, SessionDetail } from "../../types/proxy";

const TestHarness: React.FC<{
  items: ContextMenuItem[];
  onRootUnhandled?: (e: React.MouseEvent<HTMLDivElement>) => void;
}> = ({ items, onRootUnhandled }) => {
  const { openContextMenu, closeContextMenu } = useContextMenu();

  const handleRootContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    onRootUnhandled?.(e);
    if (e.defaultPrevented) return;
    if (shouldPreserveNativeContextMenu(e.target)) {
      return;
    }
    const editable = findEditableTextTarget(e.target);
    if (editable) {
      openContextMenu(
        e,
        buildEditableInputMenuItems({
          target: editable,
          snapshot: captureEditableSelection(editable),
        }),
        { ariaLabel: "Text Editing Context Menu", restoreFocusTo: editable }
      );
      return;
    }
    e.preventDefault();
    closeContextMenu({ restoreFocus: false });
  };

  return (
    <div data-testid="app-root" onContextMenu={handleRootContextMenu}>
      <button
        type="button"
        data-testid="zone-trigger"
        onContextMenu={(e) =>
          openContextMenu(e, items, { ariaLabel: "Zone Context Menu" })
        }
      >
        Target Zone
      </button>
      <div className="monaco-editor">
        <div data-testid="monaco-inner" className="view-lines">
          Monaco Code Line
        </div>
      </div>
      <input
        data-testid="plain-input"
        type="text"
        defaultValue="hello world"
        aria-label="Plain text input"
      />
      <div data-testid="dead-zone">Dead Zone</div>
    </div>
  );
};

describe("ContextMenu positioning and normalization", () => {
  it("computes auto-flip and viewport clamping without hardcoded dimensions", () => {
    // Fits bottom-right cleanly
    const normal = computeContextMenuPosition({
      x: 120,
      y: 140,
      menuWidth: 260,
      menuHeight: 300,
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    expect(normal.left).toBe(120);
    expect(normal.top).toBe(140);
    expect(normal.flippedX).toBe(false);
    expect(normal.flippedY).toBe(false);

    // Near bottom-right corner -> flips left and up
    const flipped = computeContextMenuPosition({
      x: 1240,
      y: 760,
      menuWidth: 260,
      menuHeight: 300,
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    expect(flipped.left).toBe(1240 - 260);
    expect(flipped.top).toBe(760 - 300);
    expect(flipped.flippedX).toBe(true);
    expect(flipped.flippedY).toBe(true);

    // Tall menu on small viewport -> clamps to top padding and constrains maxHeight
    const tall = computeContextMenuPosition({
      x: 20,
      y: 200,
      menuWidth: 260,
      menuHeight: 900,
      viewportWidth: 360,
      viewportHeight: 400,
    });
    expect(tall.top).toBe(8);
    expect(tall.maxHeight).toBe(384);
    expect(tall.left).toBe(20);
  });

  it("flips nested submenu left or falls back below on narrow viewports", () => {
    const right = computeSubmenuPosition({
      triggerRect: { left: 100, right: 320, top: 80, bottom: 108 },
      submenuWidth: 220,
      submenuHeight: 160,
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    expect(right.placement).toBe("right");
    expect(right.left).toBe(318);

    const left = computeSubmenuPosition({
      triggerRect: { left: 900, right: 1120, top: 80, bottom: 108 },
      submenuWidth: 220,
      submenuHeight: 160,
      viewportWidth: 1200,
      viewportHeight: 800,
    });
    expect(left.placement).toBe("left");
    expect(left.left).toBe(682);

    const below = computeSubmenuPosition({
      triggerRect: { left: 40, right: 260, top: 80, bottom: 108 },
      submenuWidth: 220,
      submenuHeight: 160,
      viewportWidth: 320,
      viewportHeight: 600,
    });
    expect(below.placement).toBe("below");
    expect(below.top).toBe(110);
  });

  it("normalizes redundant leading/trailing/adjacent separators and empty submenus", () => {
    const normalized = normalizeContextMenuItems([
      { type: "separator", id: "s1" },
      { type: "header", id: "h1", label: "Title" },
      { type: "separator", id: "s2" },
      { id: "a1", label: "Action 1", onSelect: vi.fn() },
      { type: "separator", id: "s3" },
      { type: "separator", id: "s4" },
      { type: "submenu", id: "empty-sub", label: "Empty", items: [] },
      { id: "a2", label: "Action 2", onSelect: vi.fn() },
      { type: "separator", id: "s5" },
    ]);

    expect(normalized.map((i) => i.id)).toEqual(["h1", "a1", "s3", "a2"]);
  });
});

describe("ContextMenu component interactions, keyboard navigation & Monaco preservation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("positions using getBoundingClientRect(), supports Arrow/Home/End/Enter/Escape navigation and nested submenus", () => {
    const onFirst = vi.fn();
    const onSubAction = vi.fn();
    const onLast = vi.fn();
    const onCheckToggle = vi.fn();

    Object.defineProperty(window, "innerWidth", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 600,
      configurable: true,
    });

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.dataset?.fluxContextMenu === "root") {
          return {
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 240,
            bottom: 220,
            width: 240,
            height: 220,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return {
          x: 0,
          y: 0,
          left: 100,
          top: 100,
          right: 300,
          bottom: 128,
          width: 200,
          height: 28,
          toJSON: () => ({}),
        } as DOMRect;
      }
    );

    const items: ContextMenuItem[] = [
      { type: "header", id: "hdr", label: "Session #12" },
      { id: "first", label: "Replay", shortcut: "R", onSelect: onFirst },
      { id: "disabled", label: "Disabled Item", disabled: true, onSelect: vi.fn() },
      {
        id: "check",
        label: "Follow Tail",
        checked: false,
        keepOpen: true,
        onSelect: onCheckToggle,
      },
      {
        type: "submenu",
        id: "export-sub",
        label: "Export",
        items: [
          { id: "sub-har", label: "Save HAR", onSelect: onSubAction },
        ],
      },
      { type: "separator", id: "sep" },
      { id: "last", label: "Delete", danger: true, onSelect: onLast },
    ];

    render(
      <ContextMenuProvider>
        <TestHarness items={items} />
      </ContextMenuProvider>
    );

    // Open near bottom-right corner -> should flip left & up based on 240x220 rect
    fireEvent.contextMenu(screen.getByTestId("zone-trigger"), {
      clientX: 950,
      clientY: 550,
    });

    const menu = screen.getByRole("menu", { name: "Zone Context Menu" });
    const rootPopover = menu.closest("[data-flux-context-menu='root']") as HTMLElement;
    expect(rootPopover).toBeTruthy();
    expect(rootPopover.style.left).toBe(`${950 - 240}px`);
    expect(rootPopover.style.top).toBe(`${550 - 220}px`);

    const replayBtn = screen.getByRole("menuitem", { name: "Replay" });
    const checkBtn = screen.getByRole("menuitemcheckbox", { name: "Follow Tail" });
    const exportBtn = screen.getByRole("menuitem", { name: "Export" });
    const deleteBtn = screen.getByRole("menuitem", { name: "Delete" });

    // Start focus on first enabled item, ArrowDown skips disabled item -> Follow Tail
    replayBtn.focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(checkBtn);

    // Space toggles checkbox and keeps menu open (updates aria-checked)
    expect(checkBtn.getAttribute("aria-checked")).toBe("false");
    fireEvent.keyDown(checkBtn, { key: " " });
    expect(onCheckToggle).toHaveBeenCalledTimes(1);
    expect(checkBtn.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menu", { name: "Zone Context Menu" })).toBeTruthy();

    // End jumps to last enabled item, Home jumps back to first
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(deleteBtn);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(replayBtn);

    // Navigate to Export submenu and open with ArrowRight
    fireEvent.keyDown(menu, { key: "ArrowDown" }); // checkBtn
    fireEvent.keyDown(menu, { key: "ArrowDown" }); // exportBtn
    expect(document.activeElement).toBe(exportBtn);
    fireEvent.keyDown(menu, { key: "ArrowRight" });

    const subMenu = screen.getByRole("menu", { name: "Export" });
    expect(subMenu).toBeTruthy();
    const saveHarBtn = screen.getByRole("menuitem", { name: "Save HAR" });

    // Escape inside submenu closes ONLY submenu, keeping parent open
    fireEvent.keyDown(subMenu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Export" })).toBeNull();
    expect(screen.getByRole("menu", { name: "Zone Context Menu" })).toBeTruthy();

    // Re-open submenu and activate item via Enter -> invokes callback and closes all
    exportBtn.focus();
    fireEvent.keyDown(menu, { key: "ArrowRight" });
    const saveHarAgain = screen.getByRole("menuitem", { name: "Save HAR" });
    expect(saveHarAgain).not.toBe(saveHarBtn);
    fireEvent.keyDown(saveHarAgain, { key: "Enter" });
    expect(onSubAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "Zone Context Menu" })).toBeNull();

    // Re-open and dismiss via outside pointerdown
    fireEvent.contextMenu(screen.getByTestId("zone-trigger"), {
      clientX: 100,
      clientY: 100,
    });
    expect(screen.getByRole("menu", { name: "Zone Context Menu" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByTestId("dead-zone"));
    expect(screen.queryByRole("menu", { name: "Zone Context Menu" })).toBeNull();

    // Re-open and dismiss via Escape at root level
    fireEvent.contextMenu(screen.getByTestId("zone-trigger"), {
      clientX: 100,
      clientY: 100,
    });
    const rootMenuAgain = screen.getByRole("menu", { name: "Zone Context Menu" });
    fireEvent.keyDown(rootMenuAgain, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Zone Context Menu" })).toBeNull();
  });

  it("preserves native context menu inside .monaco-editor, provides Cut/Copy/Paste/Select All on inputs, and suppresses raw menu on dead zones", () => {
    render(
      <ContextMenuProvider>
        <TestHarness items={[]} />
      </ContextMenuProvider>
    );

    // 1. Inside .monaco-editor -> event must NOT be defaultPrevented and no FluxProxy menu opens
    const monacoTarget = screen.getByTestId("monaco-inner");
    const monacoEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
    });
    fireEvent(monacoTarget, monacoEvent);
    expect(monacoEvent.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();

    // 2. Plain <input> -> suppresses browser menu and opens Cut/Copy/Paste/Select All desktop menu
    const input = screen.getByTestId("plain-input") as HTMLInputElement;
    input.focus();
    input.setSelectionRange(0, 5);
    const inputEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 80,
      clientY: 80,
    });
    fireEvent(input, inputEvent);
    expect(inputEvent.defaultPrevented).toBe(true);
    expect(
      screen.getByRole("menu", { name: "Text Editing Context Menu" })
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Cut" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Paste" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Select All" })).toBeTruthy();

    // 3. Dead zone -> suppresses browser menu and closes any open menu
    const deadZone = screen.getByTestId("dead-zone");
    const deadEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 200,
    });
    fireEvent(deadZone, deadEvent);
    expect(deadEvent.defaultPrevented).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes open menu on outside scroll but stays open when scrolling inside the menu itself", () => {
    render(
      <ContextMenuProvider>
        <TestHarness
          items={[{ id: "a", label: "Action A", onSelect: vi.fn() }]}
        />
      </ContextMenuProvider>
    );

    fireEvent.contextMenu(screen.getByTestId("zone-trigger"), {
      clientX: 100,
      clientY: 100,
    });
    const menu = screen.getByRole("menu", { name: "Zone Context Menu" });

    // Scrolling inside menu keeps it open
    fireEvent.scroll(menu);
    expect(screen.getByRole("menu", { name: "Zone Context Menu" })).toBeTruthy();

    // Scrolling an external container closes the menu
    fireEvent.scroll(screen.getByTestId("dead-zone"));
    expect(screen.queryByRole("menu", { name: "Zone Context Menu" })).toBeNull();
  });
});

describe("Integrated component right-click menus", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens unified context menus on TrafficGrid empty area, SessionInspector header row, AutoResponder rule, Scripting console log, Sidebar, and CollapsedInspectorBar", () => {
    const onResetColumns = vi.fn();
    const onOpenWizard = vi.fn();
    const onUpsertRule = vi.fn().mockResolvedValue(undefined);
    const onDeleteRule = vi.fn().mockResolvedValue(undefined);
    const onClearLogs = vi.fn();
    const onSelectSection = vi.fn();
    const onExpand = vi.fn();

    const sampleDetail: SessionDetail = {
      summary: {
        id: 11,
        status: 200,
        protocol: "HTTPS",
        scheme: "https",
        method: "GET",
        host: "api.flux.test",
        path: "/v1/me",
        url: "https://api.flux.test/v1/me",
        contentType: "application/json",
        bodySize: 64,
        durationMs: 12,
        timestamp: "12:00:00",
        isMocked: false,
      },
      requestHeaders: [{ name: "X-Custom-Token", value: "SGVsbG8=" }],
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      requestBodyBase64: "",
      responseBodyBase64: "",
      requestBodyText: null,
      responseBodyText: '{"ok":true}',
      clientAddr: "127.0.0.1:50000",
      websocketFrames: [],
    };

    const sampleRule: AutoResponderRule = {
      id: "rule-1",
      enabled: true,
      name: "Auth Mock",
      matchTarget: "urlContains",
      pattern: "/v1/me",
      action: "mockResponse",
      statusCode: 200,
      latencyMs: 0,
      responseHeaders: [],
      responseBody: "{}",
    };

    // 1. TrafficGrid empty area & header
    render(
      <ContextMenuProvider>
        <TrafficGrid
          sessions={[]}
          totalSessionsCount={0}
          selectedId={null}
          selectedIds={[]}
          visibleColumns={{ ...DEFAULT_VISIBLE_COLUMNS }}
          columnWidths={{ ...DEFAULT_COLUMN_WIDTHS }}
          onColumnWidthChange={vi.fn()}
          onToggleColumnVisibility={vi.fn()}
          onResetColumns={onResetColumns}
          onSelectSession={vi.fn()}
          onToggleSelectSession={vi.fn()}
          onSelectSessionRange={vi.fn()}
          onFocusInspector={vi.fn()}
          onDeleteSessions={vi.fn()}
          onReplaySessions={vi.fn()}
          onUnmarkSessions={vi.fn()}
          onCopyUrl={vi.fn()}
          onCopyCurl={vi.fn()}
          onCopyHeaders={vi.fn()}
          onCompareWithSession={vi.fn()}
          onSwapCompare={vi.fn()}
          onOpenDiffModal={vi.fn()}
          onAnnotateSessions={vi.fn()}
          onSendToComposer={vi.fn()}
          onCreateRuleFromSession={vi.fn()}
          onToggleCapture={vi.fn()}
          onToggleFollowTail={vi.fn()}
          thresholds={{
            hide304NotModified: false,
            hideOptionsPreflight: false,
            hideConnectTunnels: false,
            hideCss: false,
            hideImages: false,
            hideFonts: false,
            hideJs: false,
            minBodySizeBytes: null,
            maxBodySizeBytes: null,
            timeHeatEnabled: false,
            timeHeatWarningMs: 500,
            timeHeatCriticalMs: 1500,
            onlySlowRequests: false,
          }}
          followTail={true}
        />
      </ContextMenuProvider>
    );

    fireEvent.contextMenu(
      screen.getByText(/Нет подходящих сессий для текущих фильтров/i)
    );
    expect(
      screen.getByRole("menu", { name: "Действия таблицы Traffic" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset Columns" }));
    expect(onResetColumns).toHaveBeenCalledTimes(1);
    cleanup();

    // 2. SessionInspector KeyValueTable row
    render(
      <ContextMenuProvider>
        <SessionInspector
          detail={sampleDetail}
          resolvedTheme="dark"
          onSendToComposer={vi.fn()}
          onOpenTextWizard={onOpenWizard}
          onAddHeaderMutationRule={vi.fn()}
        />
      </ContextMenuProvider>
    );
    fireEvent.contextMenu(screen.getByText("X-Custom-Token"));
    expect(
      screen.getByRole("menuitem", { name: 'Copy "Name: Value"' })
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Add Header Mutation Rule" })
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: /Decode Value in TextWizard/i,
      })
    );
    expect(onOpenWizard).toHaveBeenCalledWith("SGVsbG8=", "base64");
    cleanup();

    // 3. AutoResponder rule card
    render(
      <ContextMenuProvider>
        <AutoResponderPanel
          enabled={true}
          onToggleEnabled={vi.fn()}
          rules={[sampleRule]}
          resolvedTheme="dark"
          onUpsertRule={onUpsertRule}
          onDeleteRule={onDeleteRule}
        />
      </ContextMenuProvider>
    );
    fireEvent.contextMenu(screen.getByText("Auth Mock"));
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Disable Rule" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate Rule" }));
    expect(onUpsertRule).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Auth Mock (Copy)" })
    );
    cleanup();

    // 4. ScriptingPanel console log line
    render(
      <ContextMenuProvider>
        <ScriptingPanel
          code="def on_request(req): pass"
          enabled={true}
          activePresetId={null}
          status={null}
          logs={[
            {
              id: 1,
              timestamp: "2026-11-24T12:00:00Z",
              level: "stdout",
              hook: "on_request",
              sessionId: 11,
              message: "injected trace id",
            },
          ]}
          resolvedTheme="dark"
          isApplying={false}
          onChangeCode={vi.fn()}
          onSelectPreset={vi.fn()}
          onApplyScript={vi.fn()}
          onToggleEnabled={vi.fn()}
          onRefreshStatus={vi.fn()}
          onClearLogs={onClearLogs}
        />
      </ContextMenuProvider>
    );
    fireEvent.contextMenu(screen.getByText("injected trace id"));
    expect(
      screen.getByRole("menuitem", { name: "Copy Log Line" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear Console" }));
    expect(onClearLogs).toHaveBeenCalledTimes(1);
    cleanup();

    // 5. Sidebar & CollapsedInspectorBar
    render(
      <ContextMenuProvider>
        <Sidebar
          activeSection="traffic"
          onSelectSection={onSelectSection}
          onDropSessionToComposer={vi.fn()}
          breakpointsArmed={false}
          pausedBreakpointCount={0}
          activeRulesCount={0}
          onOpenSettings={vi.fn()}
          onCollapseSidebar={vi.fn()}
        />
        <CollapsedInspectorBar
          position="bottom"
          onExpand={onExpand}
          onOpenStatistics={vi.fn()}
          onChangePosition={vi.fn()}
          onResetPanelLayout={vi.fn()}
        />
      </ContextMenuProvider>
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "Composer" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Composer" }));
    expect(onSelectSection).toHaveBeenCalledWith("composer");

    fireEvent.contextMenu(screen.getByTestId("collapsed-inspector-bar"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Expand Session Inspector" })
    );
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
