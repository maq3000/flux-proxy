import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

vi.mock("@monaco-editor/react", () => ({
  default: () => null,
}));

import { MenuBar } from "./MenuBar";
import { SessionInspector } from "./SessionInspector";
import { Sidebar } from "./Sidebar";
import { TopToolbar } from "./TopToolbar";
import {
  DEFAULT_TOOLBAR_GROUPS,
  DEFAULT_VISIBLE_COLUMNS,
} from "../hooks/useUiPreferences";
import type { ProxyStatus, SessionDetail } from "../types/proxy";

vi.mock("../lib/tauriBridge", () => ({
  isTauriRuntime: () => false,
  proxyBridge: {
    loadSessionBody: vi.fn(),
  },
}));

const BASE_STATUS: ProxyStatus = {
  running: true,
  bindAddr: "127.0.0.1",
  port: 8888,
  activeSessions: 0,
  systemProxyEnabled: true,
  autoSystemProxy: true,
  systemProxyError: null,
  allowRemote: false,
  bindMode: "loopback",
  specificBindIp: null,
  alsoBindLoopback: true,
  boundIps: ["127.0.0.1"],
};

const SAMPLE_DETAIL: SessionDetail = {
  summary: {
    id: 42,
    status: 200,
    protocol: "HTTPS",
    scheme: "https",
    method: "GET",
    host: "api.example.com",
    path: "/v1/items",
    url: "https://api.example.com/v1/items",
    contentType: "application/json",
    bodySize: 18,
    durationMs: 25,
    timestamp: "12:00:00.000",
    isMocked: false,
  },
  requestHeaders: [{ name: "Host", value: "api.example.com" }],
  responseHeaders: [{ name: "Content-Type", value: "application/json" }],
  requestBodyBase64: "",
  responseBodyBase64: "eyJvayI6dHJ1ZX0=",
  requestBodyText: null,
  responseBodyText: '{"ok":true}',
  clientAddr: "127.0.0.1:51234",
  websocketFrames: [],
};

describe("Stage 38 Navigation & Panel Deduplication", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("Sidebar keeps 7 workspace sections + Settings/Collapse and removes obsolete buttons", () => {
    render(
      <Sidebar
        activeSection="traffic"
        onSelectSection={vi.fn()}
        onDropSessionToComposer={vi.fn()}
        onOpenBreakpoints={vi.fn()}
        breakpointsArmed={false}
        pausedBreakpointCount={0}
        onOpenSessionDiff={vi.fn()}
        onOpenTextWizard={vi.fn()}
        activeRulesCount={0}
        onOpenSettings={vi.fn()}
        onCollapseSidebar={vi.fn()}
      />
    );

    expect(screen.getByTitle("Traffic (Alt+1)")).toBeTruthy();
    expect(screen.getByTitle("Composer (Alt+2)")).toBeTruthy();
    expect(screen.getByTitle("AutoResponder (Alt+3)")).toBeTruthy();
    expect(screen.getByTitle("Breakpoints (Alt+6)")).toBeTruthy();
    expect(screen.getByTitle("Scripts (Alt+5)")).toBeTruthy();
    expect(screen.getByTitle("Session Diff (Ctrl+D)")).toBeTruthy();
    expect(screen.getByTitle("TextWizard (Ctrl+E)")).toBeTruthy();
    expect(screen.getByTitle("Settings (Ctrl+,)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Traffic" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Composer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "AutoResponder" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Breakpoints" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scripts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Session Diff" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "TextWizard" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide Sidebar" })).toBeTruthy();

    // Removed duplicates / obsolete toggles
    expect(screen.queryByTitle(/Switch to Light Theme/i)).toBeNull();
    expect(screen.queryByTitle(/Switch to Dark Theme/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Connect Mobile Device" })
    ).toBeNull();
    expect(screen.queryByTitle(/Command Palette/i)).toBeNull();
    expect(screen.queryByTitle(/HTTPS MITM Root CA/i)).toBeNull();
    expect(screen.queryByTitle(/Таблицы фильтров/i)).toBeNull();
  });

  it("TopToolbar always shows labeled Throttle + Routing, HelpTooltips, and removes duplicate/overflow buttons", () => {
    const searchInputRef = React.createRef<HTMLInputElement>();

    render(
      <TopToolbar
        status={BASE_STATUS}
        searchInputRef={searchInputRef}
        onFocusTrafficGrid={vi.fn()}
        filterQuery=""
        onFilterQueryChange={vi.fn()}
        useRegex={false}
        onToggleRegex={vi.fn()}
        regexError={null}
        quickCategory="all"
        onSelectCategory={vi.fn()}
        activeFilterCount={0}
        onOpenFilterDrawer={vi.fn()}
        onResetAdvancedFilters={vi.fn()}
        isForceNoCacheActive={false}
        onToggleForceNoCache={vi.fn()}
        breakpointConfig={{
          breakBeforeRequest: false,
          breakAfterResponse: false,
          timeoutSecs: 120,
          rules: [],
        }}
        pausedBreakpointCount={0}
        onToggleBreakBeforeRequest={vi.fn()}
        onToggleBreakAfterResponse={vi.fn()}
        onOpenBreakpointsModal={vi.fn()}
        markedCount={0}
        followTail={true}
        onToggleFollowTail={vi.fn()}
        compactToolbar={true}
        sidebarCollapsed={false}
        onToggleSidebar={vi.fn()}
        toolbarGroups={{ ...DEFAULT_TOOLBAR_GROUPS, proxyMode: true }}
        visibleColumns={{ ...DEFAULT_VISIBLE_COLUMNS }}
        onToggleColumnVisibility={vi.fn()}
        onResetColumns={vi.fn()}
        sessionRetentionLimit={10_000}
        onSetSessionRetentionLimit={vi.fn()}
        dropNonMatching={false}
        onToggleDropNonMatching={vi.fn()}
        droppedSessionsCount={0}
        onToggleProxy={vi.fn()}
        onToggleAllowRemote={vi.fn()}
        onToggleSystemProxy={vi.fn()}
        onToggleAutoSystemProxy={vi.fn()}
        tlsInterceptMode="targetedOnly"
        targetHostsCount={2}
        hideConnectTunnels={false}
        onSelectTlsInterceptMode={vi.fn()}
        onToggleTlsInterceptMode={vi.fn()}
        onQuickAddTargetHost={vi.fn()}
        onToggleHideConnectTunnels={vi.fn()}
        onOpenTlsModeDrawer={vi.fn()}
        onClearSessions={vi.fn()}
        throttleConfig={{
          preset: "none",
          downloadKbps: 0,
          uploadKbps: 0,
          latencyMs: 0,
        }}
        onChangeThrottleConfig={vi.fn()}
        activeHostRemapCount={2}
        upstreamProxyEnabled={true}
        activeClientCertsCount={1}
        onOpenNetworkRouting={vi.fn()}
        onOpenAppearanceSettings={vi.fn()}
      />
    );

    // Always visible & explicitly labeled even in compactToolbar mode
    expect(screen.getByText("Throttle: Off")).toBeTruthy();
    const routingBtn = screen.getByRole("button", {
      name: /Network & Routing \(4 active\)/i,
    });
    expect(routingBtn.textContent).toContain("Routing");
    expect(routingBtn.textContent).toContain("4");

    // HelpTooltips present across popovers
    expect(
      screen.getByRole("button", { name: "Ring Buffer (Keep)" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Подробнее об OS System Proxy" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Selective TLS MITM" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Bandwidth Throttling & Latency" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Session Columns" })
    ).toBeTruthy();

    // Removed duplicates & overflow
    expect(
      screen.queryByRole("button", { name: "More tools and utilities" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Connect Mobile Device" })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Session Diff" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hex Converter" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Text Wizard" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save to SQLite" })).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Dock Session Inspector at bottom or collapse",
      })
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Dock Session Inspector on right or collapse",
      })
    ).toBeNull();
    expect(screen.queryByText("Drop Non-Matching on Capture")).toBeNull();
    expect(screen.queryByText("Customize Toolbar")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Toggle split Request Composer" })
    ).toBeNull();
  });

  it("MenuBar removes duplicate SysProxy status button and View Theme radios", () => {
    render(
      <MenuBar
        status={BASE_STATUS}
        totalCount={10}
        filteredCount={5}
        hasSelection={false}
        selectedCount={0}
        activeSection="traffic"
        onSelectSection={vi.fn()}
        onToggleProxy={vi.fn()}
        onToggleAllowRemote={vi.fn()}
        onToggleSystemProxy={vi.fn()}
        onToggleAutoSystemProxy={vi.fn()}
        onSaveAllSessionsAs={vi.fn()}
        onSaveSelectedSessionsAs={vi.fn()}
        onOpenSanitizedExport={vi.fn()}
        onOpenOpenApiExport={vi.fn()}
        onImportArchive={vi.fn()}
        onSaveSqlite={vi.fn()}
        onLoadSqlite={vi.fn()}
        onPurgeSqliteArchive={vi.fn()}
        onClearSessions={vi.fn()}
        onExportSettingsProfile={vi.fn()}
        onImportSettingsProfile={vi.fn()}
        onOpenPreferences={vi.fn()}
        onCopyUrl={vi.fn()}
        onCopyCurl={vi.fn()}
        onGenerateClientCode={vi.fn()}
        onCopyRequestHeaders={vi.fn()}
        onCopyResponseHeaders={vi.fn()}
        onAnnotateSelected={vi.fn()}
        onUnmarkSelected={vi.fn()}
        onDeleteSelected={vi.fn()}
        onFocusSearch={vi.fn()}
        breakpointConfig={{
          breakBeforeRequest: false,
          breakAfterResponse: false,
          timeoutSecs: 120,
          rules: [],
        }}
        onToggleBreakBeforeRequest={vi.fn()}
        onToggleBreakAfterResponse={vi.fn()}
        onDisableAllBreakpoints={vi.fn()}
        onOpenBreakpointsModal={vi.fn()}
        isForceNoCacheActive={false}
        onToggleForceNoCache={vi.fn()}
        hideConnectTunnels={false}
        onToggleHideConnectTunnels={vi.fn()}
        tlsInterceptMode="targetedOnly"
        targetHostsCount={1}
        onToggleTlsInterceptMode={vi.fn()}
        onOpenFilterDrawer={vi.fn()}
        onOpenHostsListDrawer={vi.fn()}
        onOpenTlsModeDrawer={vi.fn()}
        sidebarCollapsed={false}
        onToggleSidebar={vi.fn()}
        inspectorCollapsed={false}
        onToggleInspector={vi.fn()}
        inspectorPosition="bottom"
        onSetInspectorPosition={vi.fn()}
        followTail={true}
        onToggleFollowTail={vi.fn()}
        toolbarGroups={{ ...DEFAULT_TOOLBAR_GROUPS }}
        onToggleToolbarGroup={vi.fn()}
        onResetToolbarGroups={vi.fn()}
        visibleColumns={{ ...DEFAULT_VISIBLE_COLUMNS }}
        onToggleColumnVisibility={vi.fn()}
        onResetColumns={vi.fn()}
        onResetPanelLayout={vi.fn()}
        onOpenThemeGallery={vi.fn()}
        trafficViewMode="grid"
        onSetTrafficViewMode={vi.fn()}
        onOpenTrafficStatistics={vi.fn()}
        sessionRetentionLimit={10_000}
        onSetSessionRetentionLimit={vi.fn()}
        onOpenCustomRetentionLimit={vi.fn()}
        dropNonMatching={false}
        onToggleDropNonMatching={vi.fn()}
        onReplaySelected={vi.fn()}
        onSendSelectedToComposer={vi.fn()}
        onOpenSessionDiff={vi.fn()}
        onOpenTextWizard={vi.fn()}
        onOpenHexConverter={vi.fn()}
        onInspectInHex={vi.fn()}
        onOpenCompressionCodec={vi.fn()}
        onOpenMobileSetup={vi.fn()}
        onOpenCertificates={vi.fn()}
        onOpenClientCertificates={vi.fn()}
        onOpenProxyDoctor={vi.fn()}
        onOpenCommandPalette={vi.fn()}
        onOpenShortcutsModal={vi.fn()}
        onGenerateStress10k={vi.fn()}
        onCopyCliEnv={vi.fn()}
        onResetAllUiPreferences={vi.fn()}
      />
    );

    expect(screen.queryByText(/SysProxy:/i)).toBeNull();
    expect(screen.queryByText("Theme: Dark (Zinc)")).toBeNull();
    expect(screen.queryByText("Theme: Light (Zinc)")).toBeNull();
    expect(screen.queryByText("Theme: System")).toBeNull();
    expect(screen.queryByText("Split Composer Pane")).toBeNull();
    expect(screen.getByText("Appearance & Layout")).toBeTruthy();
    expect(screen.getByText("OpenAPI Export")).toBeTruthy();
    expect(screen.getByText("Sanitized Export")).toBeTruthy();
    expect(screen.getByText("Code Generator")).toBeTruthy();
    expect(screen.getByText("Root CA")).toBeTruthy();
    expect(screen.getByText("Shortcuts")).toBeTruthy();
    expect(screen.getByText("Traffic View: Waterfall Timeline")).toBeTruthy();
    expect(screen.getByText("Traffic Statistics Summary…")).toBeTruthy();
    expect(screen.getByText("Traffic Statistics Report…")).toBeTruthy();
  });

  it("SessionInspector removes the duplicate top summary bar Wizard button", () => {
    render(
      <SessionInspector
        detail={SAMPLE_DETAIL}
        resolvedTheme="dark"
        onSendToComposer={vi.fn()}
        onOpenTextWizard={vi.fn()}
        onReplaySession={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "Wizard" })).toBeNull();
    expect(screen.getByRole("button", { name: /Replay/i })).toBeTruthy();
    expect(
      screen.getByTitle("Edit & Replay session in Composer (E)")
    ).toBeTruthy();
  });

  it("TopToolbar updates Throttle button label dynamically for active preset", () => {
    const searchInputRef = React.createRef<HTMLInputElement>();
    const onOpenNetworkRouting = vi.fn();

    render(
      <TopToolbar
        status={BASE_STATUS}
        searchInputRef={searchInputRef}
        onFocusTrafficGrid={vi.fn()}
        filterQuery=""
        onFilterQueryChange={vi.fn()}
        useRegex={false}
        onToggleRegex={vi.fn()}
        regexError={null}
        quickCategory="all"
        onSelectCategory={vi.fn()}
        activeFilterCount={0}
        onOpenFilterDrawer={vi.fn()}
        onResetAdvancedFilters={vi.fn()}
        isForceNoCacheActive={false}
        onToggleForceNoCache={vi.fn()}
        breakpointConfig={{
          breakBeforeRequest: false,
          breakAfterResponse: false,
          timeoutSecs: 120,
          rules: [],
        }}
        pausedBreakpointCount={0}
        onToggleBreakBeforeRequest={vi.fn()}
        onToggleBreakAfterResponse={vi.fn()}
        onOpenBreakpointsModal={vi.fn()}
        markedCount={0}
        followTail={true}
        onToggleFollowTail={vi.fn()}
        compactToolbar={true}
        sidebarCollapsed={false}
        onToggleSidebar={vi.fn()}
        toolbarGroups={{ ...DEFAULT_TOOLBAR_GROUPS, proxyMode: true }}
        visibleColumns={{ ...DEFAULT_VISIBLE_COLUMNS }}
        onToggleColumnVisibility={vi.fn()}
        onResetColumns={vi.fn()}
        sessionRetentionLimit={10_000}
        onSetSessionRetentionLimit={vi.fn()}
        dropNonMatching={false}
        onToggleDropNonMatching={vi.fn()}
        droppedSessionsCount={0}
        onToggleProxy={vi.fn()}
        onToggleAllowRemote={vi.fn()}
        onToggleSystemProxy={vi.fn()}
        onToggleAutoSystemProxy={vi.fn()}
        tlsInterceptMode="interceptAll"
        targetHostsCount={0}
        hideConnectTunnels={false}
        onSelectTlsInterceptMode={vi.fn()}
        onToggleTlsInterceptMode={vi.fn()}
        onQuickAddTargetHost={vi.fn()}
        onToggleHideConnectTunnels={vi.fn()}
        onOpenTlsModeDrawer={vi.fn()}
        onClearSessions={vi.fn()}
        throttleConfig={{
          preset: "fast3g",
          downloadKbps: 1500,
          uploadKbps: 750,
          latencyMs: 150,
        }}
        onChangeThrottleConfig={vi.fn()}
        activeHostRemapCount={0}
        onOpenNetworkRouting={onOpenNetworkRouting}
        onOpenAppearanceSettings={vi.fn()}
      />
    );

    expect(screen.getByText("Throttle: Fast 3G")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /^Network & Routing \(\d+ active\)$/i })
    );
    expect(onOpenNetworkRouting).toHaveBeenCalledTimes(1);
  });
});
