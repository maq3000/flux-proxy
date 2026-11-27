import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

import { SettingsModal, type SettingsModalProps } from "./SettingsModal";
import {
  DEFAULT_BACKEND_FILTER_CONFIG,
  DEFAULT_HOST_LIST_FILTER_CONFIG,
  DEFAULT_NOISE_THRESHOLDS,
} from "../lib/filterEngine";
import {
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_TOOLBAR_GROUPS,
  DEFAULT_VISIBLE_COLUMNS,
} from "../hooks/useUiPreferences";
import { THEME_PRESETS } from "../lib/themePresets";
import type { SettingsModalSubTab, SettingsModalTab } from "../types/settings";

vi.mock("../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauriBridge")>();
  return {
    ...actual,
    isTauriRuntime: () => false,
    proxyBridge: {
      ...actual.proxyBridge,
      getNetworkInterfaces: vi.fn().mockResolvedValue([
        {
          name: "Wi-Fi",
          ip: "192.168.1.50",
          isLoopback: false,
          isPrimary: true,
        },
      ]),
      getRootCaStatus: vi.fn().mockResolvedValue({
        exists: true,
        installed: true,
        isTrusted: true,
        commonName: "FluxProxy Root CA",
        sha256Fingerprint: "AA:BB:CC",
        notAfter: "2030-01-01",
        certPemPath: "/tmp/ca.pem",
      }),
      listClientCertificates: vi.fn().mockResolvedValue([]),
      getHostRemapRules: vi.fn().mockResolvedValue([]),
      addHostRemapRule: vi.fn().mockResolvedValue([]),
      updateHostRemapRules: vi.fn().mockResolvedValue([]),
      setUpstreamProxyConfig: vi.fn().mockResolvedValue({
        enabled: false,
        protocol: "http",
        host: "",
        port: 8080,
        username: null,
        password: null,
        bypassList: ["localhost", "127.0.0.1"],
      }),
      runProxyDoctor: vi.fn().mockResolvedValue([]),
      fixProxyDoctorCheck: vi.fn().mockResolvedValue({
        fixed: true,
        message: "ok",
      }),
    },
  };
});

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  if (typeof window.ResizeObserver === "undefined") {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

function createDefaultProps(
  overrides: Partial<SettingsModalProps> = {}
): SettingsModalProps {
  return {
    open: true,
    initialTab: "general",
    navigationSeq: 1,
    onClose: vi.fn(),
    themePreference: "system",
    onSetTheme: vi.fn(),
    themePreset: THEME_PRESETS[0].id,
    customColorOverrides: {},
    effectiveThemeTokens: { ...THEME_PRESETS[0].tokens },
    onSetThemePreset: vi.fn(),
    onSetCustomColorOverride: vi.fn(),
    onResetCustomColorOverride: vi.fn(),
    onResetCustomColorOverrides: vi.fn(),
    compactToolbar: false,
    onSetCompactToolbar: vi.fn(),
    sidebarCollapsed: false,
    onSetSidebarCollapsed: vi.fn(),
    inspectorCollapsed: false,
    onSetInspectorCollapsed: vi.fn(),
    inspectorPosition: "bottom",
    onSetInspectorPosition: vi.fn(),
    inspectorSplitDirection: "auto",
    onSetInspectorSplitDirection: vi.fn(),
    onResetPanelLayout: vi.fn(),
    followTail: true,
    onSetFollowTail: vi.fn(),
    toolbarGroups: { ...DEFAULT_TOOLBAR_GROUPS },
    onToggleToolbarGroup: vi.fn(),
    onResetToolbarGroups: vi.fn(),
    visibleColumns: { ...DEFAULT_VISIBLE_COLUMNS },
    onToggleColumnVisibility: vi.fn(),
    columnWidths: { ...DEFAULT_COLUMN_WIDTHS },
    onSetColumnWidth: vi.fn(),
    onResetColumns: vi.fn(),
    sessions: [],
    totalCount: 0,
    filteredCount: 0,
    activePresetId: null,
    userPresets: [],
    allPresets: [],
    onApplyPreset: vi.fn(),
    onSaveCustomPreset: vi.fn(),
    onDeleteCustomPreset: vi.fn(),
    matrixEnabled: false,
    onSetMatrixEnabled: vi.fn(),
    filterRules: [],
    onSetFilterRules: vi.fn(),
    ruleErrors: {},
    detectedProcesses: [],
    onQuickProcessFilter: vi.fn(),
    noiseThresholds: { ...DEFAULT_NOISE_THRESHOLDS },
    onSetNoiseThresholds: vi.fn(),
    hostFilters: { ...DEFAULT_HOST_LIST_FILTER_CONFIG },
    onSetHostFilters: vi.fn(),
    onResetAdvancedFilters: vi.fn(),
    isForceNoCacheActive: false,
    onToggleForceNoCache: vi.fn().mockResolvedValue(undefined),
    status: {
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
    },
    onToggleProxy: vi.fn().mockResolvedValue(undefined),
    onSetProxyPort: vi.fn().mockResolvedValue(undefined),
    onSetAutoSystemProxy: vi.fn().mockResolvedValue(undefined),
    onSetAllowRemote: vi.fn().mockResolvedValue(undefined),
    onSetBindConfiguration: vi.fn().mockResolvedValue(undefined),
    throttleConfig: {
      preset: "none",
      downloadKbps: 0,
      uploadKbps: 0,
      latencyMs: 0,
    },
    onChangeThrottleConfig: vi.fn().mockResolvedValue(undefined),
    activeHostRemapCount: 0,
    upstreamProxyConfig: {
      enabled: false,
      protocol: "http",
      host: "",
      port: 8080,
      username: null,
      password: null,
      bypassList: ["localhost", "127.0.0.1"],
    },
    onSaveUpstreamProxyConfig: vi.fn().mockResolvedValue(undefined),
    upstreamTimeouts: {
      connectTimeoutSec: 15,
      responseHeaderTimeoutSec: 0,
      composerTimeoutSec: 120,
    },
    onSetUpstreamTimeouts: vi.fn().mockResolvedValue(undefined),
    sessionRetentionLimit: 10_000,
    onSetSessionRetentionLimit: vi.fn(),
    dropNonMatching: false,
    onSetDropNonMatching: vi.fn(),
    storageStats: {
      ramSessions: 0,
      sqliteSizeBytes: 0,
      droppedSessionsCount: 0,
      sessionRetentionLimit: 10_000,
      dropNonMatching: false,
    },
    clearDbOnExit: false,
    onSetClearDbOnExit: vi.fn(),
    onClearSqliteDatabase: vi.fn().mockResolvedValue(undefined),
    backendFilterConfig: structuredClone(DEFAULT_BACKEND_FILTER_CONFIG),
    onUpdateBackendFilterConfig: vi.fn().mockResolvedValue(undefined),
    onUpdateLanClientAllowlist: vi.fn().mockResolvedValue(undefined),
    onOpenCertificateModal: vi.fn(),
    caRefreshKey: 0,
    activeClientCertsCount: 0,
    onClientCertsCountChange: vi.fn(),
    autoResponderEnabled: false,
    autoResponderRules: [],
    onExportProfile: vi.fn().mockResolvedValue(undefined),
    onImportProfileDialog: vi.fn().mockResolvedValue(undefined),
    onImportFromRawJsonText: vi.fn(),
    onResetAllToDefaults: vi.fn().mockResolvedValue(undefined),
    onNotify: vi.fn(),
    ...overrides,
  };
}

describe("SettingsModal (Unified Fullscreen Settings Hub)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders fullscreen dialog with h1 heading, 6 navigation tabs, single BindConfigSection, and no Theme block in General", async () => {
    render(<SettingsModal {...createDefaultProps()} />);

    const dialog = document.querySelector(
      'dialog[data-settings-hub-dialog="true"][open]'
    );
    expect(dialog).not.toBeNull();
    for (const cls of [
      "fixed",
      "inset-0",
      "h-screen",
      "w-screen",
      "max-h-none",
      "max-w-none",
      "rounded-none",
      "border-0",
    ]) {
      expect(dialog?.className).toContain(cls);
    }

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Settings",
    });
    expect(heading).toBeTruthy();
    expect(screen.getByRole("button", { name: "О разделе" })).toBeTruthy();

    const tablist = screen.getByRole("tablist", {
      name: "Разделы настроек FluxProxy",
    });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(6);
    expect(tabs.map((t) => t.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("General"),
        expect.stringContaining("Network & Routing"),
        expect.stringContaining("TLS & Mobile"),
        expect.stringContaining("Filters"),
        expect.stringContaining("Appearance & Layout"),
        expect.stringContaining("Diagnostics & Backup"),
      ])
    );

    // Single BindConfigSection in General, and no duplicate Theme selector or Upstream Timeouts
    expect(document.querySelectorAll("#bind-config-section")).toHaveLength(1);
    expect(document.getElementById("upstream-timeouts-section")).toBeNull();
    expect(screen.queryByText(/Базовая цветовая схема/i)).toBeNull();

    await waitFor(() => {
      expect(
        screen.getByText(/Локальный прокси-сервер и сетевые подключения/i)
      ).toBeTruthy();
    });
  });

  it.each<{
    initialTab: SettingsModalTab;
    initialSubTab: SettingsModalSubTab;
    expectedId: string;
  }>([
    {
      initialTab: "networkRouting",
      initialSubTab: "timeouts",
      expectedId: "upstream-timeouts-section",
    },
    {
      initialTab: "tlsCertificates",
      initialSubTab: "mobileSetup",
      expectedId: "mobile-setup-section",
    },
    {
      initialTab: "diagnosticsBackup",
      initialSubTab: "proxyDoctor",
      expectedId: "proxy-doctor-section",
    },
  ])(
    "deep-links directly to $initialTab / $initialSubTab",
    async ({ initialTab, initialSubTab, expectedId }) => {
      render(
        <SettingsModal
          {...createDefaultProps({
            initialTab,
            initialSubTab,
            navigationSeq: 5,
          })}
        />
      );

      await waitFor(() => {
        expect(document.getElementById(expectedId)).not.toBeNull();
      });
    }
  );

  it("filters cross-section settings search results and jumps to target tab on click", async () => {
    render(<SettingsModal {...createDefaultProps()} />);

    const searchInput = screen.getByRole("searchbox", {
      name: "Поиск по настройкам",
    });
    fireEvent.change(searchInput, { target: { value: "throttling" } });

    const matchBtn = screen.getByRole("button", {
      name: /Bandwidth Throttling & Latency/i,
    });
    fireEvent.click(matchBtn);

    await waitFor(() => {
      expect(document.getElementById("throttling-section")).not.toBeNull();
    });
  });

  it("stage 49: searches JS/font keywords, renders 4 granular asset toggles + 1-click chips, and counts active threshold badge", async () => {
    const onSetNoiseThresholds = vi.fn();
    render(
      <SettingsModal
        {...createDefaultProps({
          noiseThresholds: {
            ...DEFAULT_NOISE_THRESHOLDS,
            hideCss: true,
            hideJs: true,
          },
          onSetNoiseThresholds,
        })}
      />
    );

    const tablist = screen.getByRole("tablist", {
      name: "Разделы настроек FluxProxy",
    });
    const filtersTab = within(tablist).getByRole("tab", { name: /Filters/i });
    expect(filtersTab.textContent).toContain("2");

    const searchInput = screen.getByRole("searchbox", {
      name: "Поиск по настройкам",
    });
    fireEvent.change(searchInput, { target: { value: "javascript" } });
    expect(
      screen.getByRole("button", { name: /Noise & Thresholds/i })
    ).toBeTruthy();

    fireEvent.change(searchInput, { target: { value: "шрифты" } });
    fireEvent.click(
      screen.getByRole("button", { name: /Noise & Thresholds/i })
    );

    await waitFor(() => {
      expect(screen.getByText("Скрывать JavaScript (JS)")).toBeTruthy();
    });

    expect(screen.getByLabelText(/Скрывать CSS/i)).toBeTruthy();
    expect(screen.getByLabelText(/Скрывать Images/i)).toBeTruthy();
    expect(screen.getByLabelText(/Скрывать Fonts/i)).toBeTruthy();
    expect(screen.getByLabelText(/Скрывать JavaScript \(JS\)/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Скрыть всё (4)" }));
    const hideAllUpdater = onSetNoiseThresholds.mock.calls.at(-1)?.[0];
    expect(hideAllUpdater(DEFAULT_NOISE_THRESHOLDS)).toMatchObject({
      hideCss: true,
      hideImages: true,
      hideFonts: true,
      hideJs: true,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Только статика (CSS / Img / Fonts)" })
    );
    const onlyStaticUpdater = onSetNoiseThresholds.mock.calls.at(-1)?.[0];
    expect(onlyStaticUpdater({ ...DEFAULT_NOISE_THRESHOLDS, hideJs: true })).toMatchObject({
      hideCss: true,
      hideImages: true,
      hideFonts: true,
      hideJs: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    const resetUpdater = onSetNoiseThresholds.mock.calls.at(-1)?.[0];
    expect(
      resetUpdater({
        ...DEFAULT_NOISE_THRESHOLDS,
        hideCss: true,
        hideImages: true,
        hideFonts: true,
        hideJs: true,
      })
    ).toMatchObject({
      hideCss: false,
      hideImages: false,
      hideFonts: false,
      hideJs: false,
    });
  });
});
