import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/monaco", () => ({
  FLUX_MONACO_THEME: "fluxproxy-active",
  getMonacoThemeName: () => "fluxproxy-active",
  syncMonacoTheme: vi.fn(),
}));

vi.mock("@monaco-editor/react", () => ({
  default: () => <div data-testid="monaco-mock" />,
  DiffEditor: () => <div data-testid="monaco-diff-mock" />,
}));

vi.mock("../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauriBridge")>();
  return {
    ...actual,
    isTauriRuntime: () => false,
    proxyBridge: {
      ...actual.proxyBridge,
      getCaInfo: vi.fn().mockResolvedValue({
        exists: true,
        installed: true,
        commonName: "FluxProxy Root CA",
        fingerprintSha256: "AA:BB:CC:DD",
        validUntil: "2030-01-01",
        certPath: "/tmp/fluxproxy-ca.pem",
      }),
      getSessionDetail: vi.fn().mockResolvedValue(null),
      transformCodec: vi.fn().mockResolvedValue({
        output: "",
        inputBytes: 0,
        outputBytes: 0,
        ratio: 1,
      }),
    },
  };
});

import { BreakpointBanner } from "./BreakpointBanner";
import { BreakpointsPanel } from "./BreakpointsPanel";
import { CertificateModal } from "./CertificateModal";
import { CodeSnippetModal } from "./CodeSnippetModal";
import { OpenApiExportModal } from "./OpenApiExportModal";
import { SanitizedExportModal } from "./SanitizedExportModal";
import { SessionAnnotationModal } from "./SessionAnnotationModal";
import { SessionDiffView } from "./SessionDiffView";
import { ShortcutsModal } from "./ShortcutsModal";
import { TextWizardPanel } from "./TextWizardPanel";
import type { PausedBreakpointItem, SessionSummary } from "../types/proxy";

const FULLSCREEN_CLASSES = [
  "fixed",
  "inset-0",
  "h-screen",
  "w-screen",
  "max-h-none",
  "max-w-none",
  "m-0",
  "rounded-none",
  "border-0",
];

const SAMPLE_SESSION: SessionSummary = {
  id: 7,
  status: 200,
  protocol: "HTTPS",
  scheme: "https",
  method: "GET",
  host: "api.example.com",
  path: "/v1/orders",
  url: "https://api.example.com/v1/orders",
  contentType: "application/json",
  bodySize: 64,
  durationMs: 14,
  timestamp: "12:00:00.000",
  isMocked: false,
};

const PAUSED_ITEM: PausedBreakpointItem = {
  breakpointId: "bp-1",
  sessionId: 7,
  stage: "request",
  createdAt: new Date().toISOString(),
  timeoutSecs: 120,
  scheme: "https",
  method: "POST",
  url: "https://api.example.com/v1/orders",
  host: "api.example.com",
  path: "/v1/orders",
  requestHeaders: [{ name: "Content-Type", value: "application/json" }],
  requestBodyBase64: "",
  requestBodyText: '{"item":"book"}',
  responseStatus: null,
  responseHeaders: [],
  responseBodyBase64: "",
  responseBodyText: null,
};

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
});

describe("Stage 42 3-tier screen architecture", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders BreakpointsPanel, TextWizardPanel, and SessionDiffView as non-blocking workspace panels (no <dialog>) with canonical SectionHeaders", () => {
    const { container: bpContainer } = render(
      <BreakpointsPanel
        pausedItems={[PAUSED_ITEM]}
        config={{
          breakBeforeRequest: true,
          breakAfterResponse: false,
          timeoutSecs: 120,
          rules: [],
        }}
        resolvedTheme="dark"
        onBackToTraffic={vi.fn()}
        onUpdateConfig={vi.fn().mockResolvedValue({
          breakBeforeRequest: true,
          breakAfterResponse: false,
          timeoutSecs: 120,
          rules: [],
        })}
        onResolve={vi.fn().mockResolvedValue(true)}
        onResumeAll={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(bpContainer.querySelector("dialog")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "Breakpoints" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "О разделе" })).toBeTruthy();

    cleanup();

    const { container: wizContainer } = render(
      <TextWizardPanel onBackToTraffic={vi.fn()} />
    );
    expect(wizContainer.querySelector("dialog")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "TextWizard" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "О разделе" })).toBeTruthy();

    cleanup();

    const { container: diffContainer } = render(
      <SessionDiffView
        leftDetail={null}
        rightDetail={null}
        resolvedTheme="dark"
        showSectionHeader={true}
        onSwapPair={vi.fn()}
        onBackToTraffic={vi.fn()}
      />
    );
    expect(diffContainer.querySelector("dialog")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "Session Diff" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "О разделе" })).toBeTruthy();
  });

  it("clicking BreakpointBanner navigates into Breakpoints tab without blocking UI", () => {
    const onInspectItem = vi.fn();
    const onOpenRules = vi.fn();

    render(
      <BreakpointBanner
        config={{
          breakBeforeRequest: true,
          breakAfterResponse: false,
          timeoutSecs: 120,
          rules: [],
        }}
        pausedItems={[PAUSED_ITEM]}
        onInspectItem={onInspectItem}
        onOpenRules={onOpenRules}
        onQuickResolve={vi.fn()}
        onResumeAll={vi.fn()}
        onDisableAll={vi.fn()}
      />
    );

    const openBtn = screen.getByRole("button", {
      name: /Открыть в Breakpoints/i,
    });
    fireEvent.click(openBtn);
    expect(onInspectItem).toHaveBeenCalledWith("bp-1");
  });

  it("renders OpenApiExportModal, SanitizedExportModal, CodeSnippetModal, and ShortcutsModal as fullscreen screens with canonical SectionHeader", () => {
    const screens = [
      {
        title: "OpenAPI Export",
        renderEl: () => (
          <OpenApiExportModal
            open={true}
            selectedIds={[7]}
            allSessionIds={[7]}
            resolvedTheme="dark"
            onClose={vi.fn()}
          />
        ),
      },
      {
        title: "Sanitized Export",
        renderEl: () => (
          <SanitizedExportModal
            open={true}
            totalCount={10}
            selectedIds={[7]}
            onClose={vi.fn()}
            onExport={vi.fn().mockResolvedValue(true)}
          />
        ),
      },
      {
        title: "Code Generator",
        renderEl: () => (
          <CodeSnippetModal
            open={true}
            request={{
              method: "GET",
              url: "https://api.example.com/v1/orders",
              headers: [{ name: "Accept", value: "application/json" }],
              body: "",
            }}
            resolvedTheme="dark"
            onClose={vi.fn()}
          />
        ),
      },
      {
        title: "Shortcuts",
        renderEl: () => <ShortcutsModal open={true} onClose={vi.fn()} />,
      },
    ];

    for (const entry of screens) {
      render(entry.renderEl());
      const dialog = document.querySelector("dialog[open]");
      expect(dialog).not.toBeNull();
      for (const cls of FULLSCREEN_CLASSES) {
        expect(dialog?.className).toContain(cls);
      }
      expect(
        screen.getByRole("heading", { level: 1, name: entry.title })
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "О разделе" })).toBeTruthy();
      cleanup();
    }
  });

  it("keeps CertificateModal (Root CA) and SessionAnnotationModal (Comment & Mark) compact dialogs", () => {
    render(
      <CertificateModal open={true} onClose={vi.fn()} onNotify={vi.fn()} />
    );
    const certDialog = document.querySelector("dialog[open]");
    expect(certDialog).not.toBeNull();
    expect(certDialog?.className).toContain("max-w-xl");
    expect(certDialog?.className).not.toContain("h-screen");
    expect(
      screen.getByRole("heading", { level: 1, name: "Root CA" })
    ).toBeTruthy();
    cleanup();

    render(
      <SessionAnnotationModal
        open={true}
        targetSessions={[SAMPLE_SESSION]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    );
    const annotationDialog = document.querySelector("dialog[open]");
    expect(annotationDialog).not.toBeNull();
    expect(annotationDialog?.className).toContain("max-w-lg");
    expect(annotationDialog?.className).not.toContain("h-screen");
    expect(
      screen.getByRole("heading", { level: 1, name: "Comment & Mark" })
    ).toBeTruthy();
  });
});
