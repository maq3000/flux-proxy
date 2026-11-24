import { describe, expect, it, vi } from "vitest";

vi.mock("./monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

import {
  buildAutoResponderEmptyContextMenu,
  buildAutoResponderRuleContextMenu,
  buildBreakpointRuleContextMenu,
  buildComposerHeaderRowContextMenu,
  buildComposerUrlContextMenu,
  buildCookieRowContextMenu,
  buildFooterContextMenu,
  buildHexViewerContextMenu,
  buildInspectorChromeContextMenu,
  buildInspectorSummaryContextMenu,
  buildKeyValueRowContextMenu,
  buildQuickFilterInputContextMenu,
  buildScriptConsoleContextMenu,
  buildSelectionContextMenuItems,
  buildSessionDiffHeaderContextMenu,
  buildSidebarContextMenu,
  buildSseEventContextMenu,
  buildStatisticsContextMenu,
  buildTextWizardOutputContextMenu,
  buildTopToolbarContextMenu,
  buildTrafficEmptyContextMenu,
  buildTrafficHeaderContextMenu,
  buildTrafficRowContextMenu,
  buildWsFrameContextMenu,
  detectTextWizardTab,
} from "./contextMenuBuilders";
import type { ContextMenuItem } from "../hooks/useContextMenu";
import {
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_VISIBLE_COLUMNS,
  TRAFFIC_COLUMNS,
} from "../hooks/useUiPreferences";
import { getSectionMeta } from "./sectionRegistry";
import type {
  AutoResponderRule,
  BreakpointRule,
  ScriptConsoleLogEvent,
  SessionSummary,
  WebSocketFrameRecord,
} from "../types/proxy";

function collectAllItems(items: ContextMenuItem[]): ContextMenuItem[] {
  const flat: ContextMenuItem[] = [];
  for (const item of items) {
    flat.push(item);
    if (item.type === "submenu") {
      flat.push(...collectAllItems(item.items));
    }
  }
  return flat;
}

function getLabels(items: ContextMenuItem[]): string[] {
  return collectAllItems(items)
    .filter((i): i is Exclude<ContextMenuItem, { type: "separator" }> => i.type !== "separator")
    .map((i) => i.label);
}

const SAMPLE_SESSION: SessionSummary = {
  id: 42,
  status: 201,
  protocol: "HTTPS",
  scheme: "https",
  method: "POST",
  host: "api.mobile.example.com",
  path: "/v1/orders?currency=EUR",
  url: "https://api.mobile.example.com/v1/orders?currency=EUR",
  contentType: "application/json",
  bodySize: 1024,
  durationMs: 48,
  timestamp: "12:00:00.000",
  isMocked: false,
  processName: "curl.exe",
  clientIp: "192.168.1.44",
};

describe("detectTextWizardTab", () => {
  it("auto-detects JWT, Unix/ISO timestamps, URL-encoded values, Hex dumps, and Base64", () => {
    expect(
      detectTextWizardTab(
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
      )
    ).toBe("jwt");
    expect(detectTextWizardTab("1793356800")).toBe("timestamp");
    expect(detectTextWizardTab("2026-11-24T12:00:00Z")).toBe("timestamp");
    expect(detectTextWizardTab("https://api.example.com?q=hello%20world")).toBe(
      "url"
    );
    expect(detectTextWizardTab("48 65 6C 6C 6F 21")).toBe("hex");
    expect(detectTextWizardTab("SGVsbG8gV29ybGQ=")).toBe("base64");
  });
});

describe("contextMenuBuilders across all application zones", () => {
  it("builds TrafficGrid row menu with E Composer shortcut, bpu/bpafter, LAN Allowlist, Export, and Delete", () => {
    const onSendToComposer = vi.fn();
    const onAddBreakpoint = vi.fn();
    const onAddAllowlist = vi.fn();

    const items = buildTrafficRowContextMenu({
      session: SAMPLE_SESSION,
      targetIds: [42],
      selectedId: 42,
      onReplaySessions: vi.fn(),
      onSendToComposer,
      onCompareWithSession: vi.fn(),
      onOpenDiffModal: vi.fn(),
      onOpenStatistics: vi.fn(),
      onCopyUrl: vi.fn(),
      onCopyCurl: vi.fn(),
      onGenerateClientCode: vi.fn(),
      onCopyHeaders: vi.fn(),
      onExportSelectedSessions: vi.fn(),
      onExportOpenApi: vi.fn(),
      onSaveSessionBody: vi.fn(),
      onAnnotateSessions: vi.fn(),
      onUnmarkSessions: vi.fn(),
      onCreateRuleFromSession: vi.fn(),
      onAddBreakpoint,
      onFilterByHost: vi.fn(),
      onFilterByStatus: vi.fn(),
      onFilterByProcess: vi.fn(),
      onFilterByClientIp: vi.fn(),
      onAddClientIpToAllowlist: onAddAllowlist,
      onAlwaysInspectHost: vi.fn(),
      onAlwaysPassthroughHost: vi.fn(),
      onDeleteSessions: vi.fn(),
    });

    const flat = collectAllItems(items);
    const labels = getLabels(items);

    const composerItem = flat.find((i) => i.id === "row-composer");
    expect(composerItem && composerItem.type !== "separator" && composerItem.type !== "header" && composerItem.type !== "submenu" ? composerItem.shortcut : null).toBe("E");
    expect(labels).toContain("Открыть Statistics");
    expect(labels).toContain("Copy as cURL");
    expect(labels).toContain("Save Selected as HAR (.har)");
    expect(labels).toContain("Save Selected as Fiddler SAZ (.saz)");
    expect(labels).toContain("Allow only this device IP (192.168.1.44)");
    expect(labels.some((l) => l.includes("bpu /v1/orders"))).toBe(true);
    expect(labels.some((l) => l.includes("bpafter /v1/orders"))).toBe(true);
    expect(labels).toContain("Always inspect (api.mobile.example.com)");
    expect(labels).toContain("Always passthrough (api.mobile.example.com)");

    const bpReq = flat.find((i) => i.id === "row-bp-request");
    if (bpReq && !bpReq.type) bpReq.onSelect();
    expect(onAddBreakpoint).toHaveBeenCalledWith("request", "/v1/orders");

    const allowLan = flat.find((i) => i.id === "row-allow-lan-ip");
    if (allowLan && !allowLan.type) allowLan.onSelect();
    expect(onAddAllowlist).toHaveBeenCalledWith("192.168.1.44");
  });

  it("builds TrafficGrid column header and empty area context menus", () => {
    const headerItems = buildTrafficHeaderContextMenu({
      clickedColumn: TRAFFIC_COLUMNS.find((c) => c.id === "host") ?? null,
      allColumns: TRAFFIC_COLUMNS,
      visibleColumns: DEFAULT_VISIBLE_COLUMNS,
      columnWidths: DEFAULT_COLUMN_WIDTHS,
      sortColumn: "host",
      sortDirection: "asc",
      onSort: vi.fn(),
      onClearSort: vi.fn(),
      onAutoFitColumn: vi.fn(),
      onAutoFitAllVisible: vi.fn(),
      onToggleColumnVisibility: vi.fn(),
      onResetColumns: vi.fn(),
    });
    const headerLabels = getLabels(headerItems);
    expect(headerLabels).toContain("Sort Ascending (ASC)");
    expect(headerLabels).toContain("Sort Descending (DESC)");
    expect(headerLabels).toContain("Clear Sort");
    expect(headerLabels).toContain('Auto-fit "Host"');
    expect(headerLabels).toContain("Auto-fit All Visible Columns");
    expect(headerLabels).toContain("Reset Columns");

    const emptyItems = buildTrafficEmptyContextMenu({
      visibleCount: 5,
      totalCount: 10,
      proxyRunning: true,
      followTail: true,
      hasActiveFilters: true,
      onSelectAllVisible: vi.fn(),
      onToggleCapture: vi.fn(),
      onToggleFollowTail: vi.fn(),
      onImportArchive: vi.fn(),
      onSaveAllSessions: vi.fn(),
      onResetFilters: vi.fn(),
      onResetColumns: vi.fn(),
      onClearAllSessions: vi.fn(),
    });
    const emptyLabels = getLabels(emptyItems);
    expect(emptyLabels).toContain("Select All Visible Sessions");
    expect(emptyLabels).toContain("Pause Capture");
    expect(emptyLabels).toContain("Follow Tail (Auto-Scroll)");
    expect(emptyLabels).toContain("Import Archive…");
    expect(emptyLabels).toContain("Save All Sessions…");
    expect(emptyLabels).toContain("Reset Active Filters");
    expect(emptyLabels).toContain("Reset Columns");
    expect(emptyLabels).toContain("Clear All Sessions");
  });

  it("builds SessionInspector summary, KeyValueTable headers (with Header Mutation submenu), Cookies, WS, SSE, Hex, Statistics, and read-only selection menus", () => {
    const summaryLabels = getLabels(
      buildInspectorSummaryContextMenu({
        summary: SAMPLE_SESSION,
        inspectorPosition: "bottom",
        onCopyUrl: vi.fn(),
        onCopyHost: vi.fn(),
        onCopyPath: vi.fn(),
        onCopyCurl: vi.fn(),
        onReplay: vi.fn(),
        onEditInComposer: vi.fn(),
        onAddBpu: vi.fn(),
        onCreateAutoResponderRule: vi.fn(),
        onFilterByHost: vi.fn(),
        onDecodeUrlInTextWizard: vi.fn(),
        onToggleDock: vi.fn(),
        onCollapseInspector: vi.fn(),
      })
    );
    expect(summaryLabels).toContain("Copy Full URL");
    expect(summaryLabels).toContain("Copy Host");
    expect(summaryLabels).toContain("Copy Path & Query");
    expect(summaryLabels).toContain("Copy as cURL");
    expect(summaryLabels).toContain("Edit in Composer");
    expect(summaryLabels).toContain("Add bpu Breakpoint");
    expect(summaryLabels).toContain("Decode URL in TextWizard");
    expect(summaryLabels).toContain("Dock Inspector at Right");
    expect(summaryLabels).toContain("Collapse Inspector");

    const onAddMutation = vi.fn();
    const kvItems = buildKeyValueRowContextMenu({
      kind: "requestHeaders",
      item: {
        name: "Authorization",
        value:
          "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
      },
      allItems: [{ name: "Authorization", value: "Bearer tok" }],
      onCopyValue: vi.fn(),
      onCopyPair: vi.fn(),
      onCopyName: vi.fn(),
      onCopyAll: vi.fn(),
      onDecodeInTextWizard: vi.fn(),
      onFilterByValue: vi.fn(),
      onAddHeaderMutationRule: onAddMutation,
    });
    const kvLabels = getLabels(kvItems);
    expect(kvLabels).toContain("Copy Value");
    expect(kvLabels).toContain('Copy "Name: Value"');
    expect(kvLabels).toContain("Copy Name");
    expect(kvLabels).toContain("Decode Value in TextWizard (JWT)");
    expect(kvLabels).toContain("Filter by Value");
    expect(kvLabels).toContain("Add Header Mutation Rule");

    const setMut = collectAllItems(kvItems).find(
      (i) => i.id === "kv-mutation-set"
    );
    if (setMut && !setMut.type) setMut.onSelect();
    expect(onAddMutation).toHaveBeenCalledWith(
      "request",
      "set",
      "Authorization",
      expect.stringContaining("Bearer eyJ")
    );

    const cookieLabels = getLabels(
      buildCookieRowContextMenu({
        cookie: { name: "sid", value: "abc123", attributes: "HttpOnly" },
        allCookies: [{ name: "sid", value: "abc123", attributes: "HttpOnly" }],
        onCopyValue: vi.fn(),
        onCopyPair: vi.fn(),
        onCopyName: vi.fn(),
        onCopyAll: vi.fn(),
        onDecodeInTextWizard: vi.fn(),
        onFilterByValue: vi.fn(),
      })
    );
    expect(cookieLabels).toContain('Copy "Name=Value"');
    expect(cookieLabels).toContain("Copy All Cookies (1)");

    const wsFrame: WebSocketFrameRecord = {
      index: 3,
      direction: "inbound",
      opcode: "text",
      payloadPreview: '{"event":"ping"}',
      byteLength: 16,
      timestamp: "12:00:01",
    };
    const wsLabels = getLabels(
      buildWsFrameContextMenu({
        frame: wsFrame,
        canReuseInInject: true,
        isJsonPayload: true,
        onCopyPayload: vi.fn(),
        onCopyPrettyJson: vi.fn(),
        onCopyHex: vi.fn(),
        onReuseInInject: vi.fn(),
        onDecodeInTextWizard: vi.fn(),
      })
    );
    expect(wsLabels).toContain("Copy Frame Payload");
    expect(wsLabels).toContain("Copy Pretty JSON");
    expect(wsLabels).toContain("Reuse Payload in Inject Form");

    const sseLabels = getLabels(
      buildSseEventContextMenu({
        eventIndex: 1,
        eventName: "message",
        eventData: '{"delta":"Hi"}',
        hasFullStream: true,
        onCopyEventData: vi.fn(),
        onCopyFullStream: vi.fn(),
        onDecodeInTextWizard: vi.fn(),
      })
    );
    expect(sseLabels).toContain("Copy Event Data");
    expect(sseLabels).toContain("Copy Full SSE Stream");

    const hexLabels = getLabels(
      buildHexViewerContextMenu({
        rowOffset: 0,
        totalBytes: 32,
        hasRow: true,
        onCopyRowHex: vi.fn(),
        onCopyRowAscii: vi.fn(),
        onCopyAllHex: vi.fn(),
        onCopyAllBase64: vi.fn(),
        onOpenInTextWizard: vi.fn(),
        onSaveBodyAs: vi.fn(),
      })
    );
    expect(hexLabels).toContain("Copy Row Hex");
    expect(hexLabels).toContain("Copy All as Base64");
    expect(hexLabels).toContain("Open in TextWizard (Hex)");
    expect(hexLabels).toContain("Save Body As…");

    const statsLabels = getLabels(
      buildStatisticsContextMenu({
        title: "Statistics (#42)",
        serverIp: "104.18.2.1",
        onCopyMarkdown: vi.fn(),
        onCopyText: vi.fn(),
        onCopyServerIp: vi.fn(),
      })
    );
    expect(statsLabels).toContain("Copy Timing Summary (Markdown)");
    expect(statsLabels).toContain("Copy Server IP (104.18.2.1)");

    const selLabels = getLabels(
      buildSelectionContextMenuItems({
        selectedText: "SGVsbG8=",
        onOpenTextWizard: vi.fn(),
        onQuickFilter: vi.fn(),
      })
    );
    expect(selLabels).toContain("Copy Selection");
    expect(selLabels).toContain("Decode Selection in TextWizard");
    expect(selLabels).toContain("Filter Traffic by Selection");
  });

  it("builds Composer, AutoResponder, Scripting console, Breakpoints, Session Diff, TextWizard, Toolbar, Sidebar, Inspector chrome, and Footer menus with canonical SECTION_REGISTRY names", () => {
    const urlInput = document.createElement("input");
    urlInput.value = "https://example.com";
    const composerUrlLabels = getLabels(
      buildComposerUrlContextMenu({
        input: urlInput,
        hasUrl: true,
        onPasteAndImportCurl: vi.fn(),
        onCopyAsCurl: vi.fn(),
        onClearUrl: vi.fn(),
      })
    );
    expect(composerUrlLabels).toEqual(
      expect.arrayContaining([
        "Cut",
        "Copy",
        "Paste",
        "Select All",
        "Paste & Import cURL",
        "Copy as cURL",
        "Clear URL",
      ])
    );

    const composerHdrLabels = getLabels(
      buildComposerHeaderRowContextMenu({
        header: { name: "X-Api-Key", value: "secret" },
        index: 1,
        totalCount: 3,
        onCopyHeader: vi.fn(),
        onDuplicateHeader: vi.fn(),
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onAddHeader: vi.fn(),
        onRemoveHeader: vi.fn(),
      })
    );
    expect(composerHdrLabels).toEqual(
      expect.arrayContaining([
        'Copy "Name: Value"',
        "Duplicate Header",
        "Move Up",
        "Move Down",
        "Add New Header",
        "Remove Header",
      ])
    );

    const rule: AutoResponderRule = {
      id: "r1",
      enabled: true,
      name: "Mock Login",
      matchTarget: "urlContains",
      pattern: "/oauth/token",
      action: "mockResponse",
      statusCode: 200,
      latencyMs: 50,
      responseHeaders: [],
      responseBody: "{}",
    };
    expect(
      getLabels(
        buildAutoResponderRuleContextMenu({
          rule,
          onToggleEnabled: vi.fn(),
          onDuplicate: vi.fn(),
          onCopyPattern: vi.fn(),
          onDelete: vi.fn(),
        })
      )
    ).toEqual(
      expect.arrayContaining([
        "Disable Rule",
        "Duplicate Rule",
        "Copy Match Pattern",
        "Delete Rule",
      ])
    );
    expect(
      getLabels(
        buildAutoResponderEmptyContextMenu({
          enabled: true,
          onAddRule: vi.fn(),
          onToggleGlobal: vi.fn(),
        })
      )
    ).toContain(`Disable ${getSectionMeta("rules").title} Globally`);

    const logEntry: ScriptConsoleLogEvent = {
      id: 1,
      timestamp: "12:00:00",
      level: "stdout",
      hook: "on_request",
      sessionId: 42,
      message: "patched header",
    };
    const consoleLabels = getLabels(
      buildScriptConsoleContextMenu({
        entry: logEntry,
        visibleCount: 4,
        totalCount: 4,
        logFilter: "all",
        autoScroll: true,
        onCopyLine: vi.fn(),
        onCopyAllVisible: vi.fn(),
        onChangeFilter: vi.fn(),
        onToggleAutoScroll: vi.fn(),
        onClearConsole: vi.fn(),
      })
    );
    expect(consoleLabels).toEqual(
      expect.arrayContaining([
        "Copy Log Line",
        "Copy All Visible Logs (4)",
        "Filter: All",
        "Filter: stdout",
        "Filter: stderr / errors",
        "Auto-Scroll",
        "Clear Console",
      ])
    );

    const bpRule: BreakpointRule = {
      id: "bp1",
      enabled: true,
      name: "bpu /pay",
      stage: "request",
      urlPattern: "/pay",
      methodFilter: "POST",
    };
    expect(
      getLabels(
        buildBreakpointRuleContextMenu({
          rule: bpRule,
          onToggleEnabled: vi.fn(),
          onCopyPattern: vi.fn(),
          onDelete: vi.fn(),
        })
      )
    ).toEqual(
      expect.arrayContaining(["Disable Rule", "Copy Pattern", "Delete Rule"])
    );

    expect(
      getLabels(
        buildSessionDiffHeaderContextMenu({
          leftSummary: SAMPLE_SESSION,
          rightSummary: { ...SAMPLE_SESSION, id: 43 },
          sortKeys: true,
          ignoreNoise: true,
          sideBySide: true,
          wordWrap: true,
          onSwapPair: vi.fn(),
          onCopyDiffHeader: vi.fn(),
          onCopyLeft: vi.fn(),
          onCopyRight: vi.fn(),
          onToggleSortKeys: vi.fn(),
          onToggleIgnoreNoise: vi.fn(),
          onToggleSideBySide: vi.fn(),
          onToggleWordWrap: vi.fn(),
        })
      )
    ).toEqual(expect.arrayContaining(["Swap A ↔ B", "Copy Diff Header"]));

    expect(
      getLabels(
        buildTextWizardOutputContextMenu({
          title: "JWT Claims",
          value: '{"sub":"1"}',
          hasInput: true,
          onCopyOutput: vi.fn(),
          onClearInput: vi.fn(),
        })
      )
    ).toEqual(expect.arrayContaining(["Copy Output", "Clear Input"]));

    const qfInput = document.createElement("input");
    qfInput.value = "api";
    expect(
      getLabels(
        buildQuickFilterInputContextMenu({
          input: qfInput,
          hasQuery: true,
          useRegex: false,
          onClearFilter: vi.fn(),
          onToggleRegex: vi.fn(),
        })
      )
    ).toEqual(expect.arrayContaining(["Cut", "Copy", "Paste", "Clear Filter", "Toggle RegExp"]));

    expect(
      getLabels(
        buildTopToolbarContextMenu({
          compactToolbar: false,
          sidebarCollapsed: false,
          onToggleCompactToolbar: vi.fn(),
          onToggleSidebar: vi.fn(),
          onResetPanelLayout: vi.fn(),
          onOpenAppearanceSettings: vi.fn(),
        })
      )
    ).toEqual(
      expect.arrayContaining([
        "Slim Toolbar",
        "Toggle Sidebar",
        "Reset Panel Layout",
        `Customize ${getSectionMeta("settings.uiColumns").title}…`,
      ])
    );

    expect(
      getLabels(
        buildSidebarContextMenu({
          targetSection: "breakpoints",
          activeSection: "traffic",
          onOpenSection: vi.fn(),
          onOpenSettings: vi.fn(),
          onCollapseSidebar: vi.fn(),
        })
      )
    ).toEqual(
      expect.arrayContaining([
        `Open ${getSectionMeta("breakpoints").title}`,
        `Open ${getSectionMeta("settings").title}`,
        "Collapse Sidebar",
      ])
    );

    expect(
      getLabels(
        buildInspectorChromeContextMenu({
          inspectorCollapsed: true,
          inspectorPosition: "bottom",
          onExpandOrCollapse: vi.fn(),
          onSetPosition: vi.fn(),
          onToggleSplitDirection: vi.fn(),
          onResetPanelLayout: vi.fn(),
        })
      )
    ).toEqual(
      expect.arrayContaining([
        "Expand Session Inspector",
        "Dock Inspector at Bottom",
        "Dock Inspector at Right",
        "Toggle Request/Response Split",
        "Reset Panel Layout",
      ])
    );

    expect(
      getLabels(
        buildFooterContextMenu({
          proxyAddress: "127.0.0.1:8888",
          proxyRunning: true,
          systemProxyEnabled: false,
          onToggleCapture: vi.fn(),
          onToggleSystemProxy: vi.fn(),
          onCopyProxyAddress: vi.fn(),
          onCopyCliEnv: vi.fn(),
          onRunProxyDoctor: vi.fn(),
          onPurgeSqlite: vi.fn(),
        })
      )
    ).toEqual(
      expect.arrayContaining([
        "Pause Capture",
        "Toggle System Proxy",
        "Copy Proxy Address (127.0.0.1:8888)",
        "Copy CLI Proxy Env (HTTP_PROXY / HTTPS_PROXY)",
        "Run Proxy Doctor",
        "Purge SQLite Archive…",
      ])
    );
  });
});
