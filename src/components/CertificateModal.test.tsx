import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CaCertificateInfo } from "../types/proxy";

const BASE_CA_INFO: CaCertificateInfo = {
  certPemPath: "/home/dev/.local/share/dev.fluxproxy.desktop/ca/fluxproxy-root-ca.pem",
  certCerPath: "/home/dev/.local/share/dev.fluxproxy.desktop/ca/fluxproxy-root-ca.cer",
  sha256Fingerprint:
    "8F:4B:1C:92:A7:03:E1:55:9D:C4:11:7A:6E:20:B8:3C:44:F9:02:D1:77:8A:91:0E:5B:2D:6C:3F:19:A4:E8:10",
  subject: "CN=FluxProxy Local Debugging Root CA, O=FluxProxy Web Debugger",
  validUntil: "2036-10-30 00:00:00 UTC",
  isTrusted: false,
  manualInstallCommand:
    "sudo cp '/home/dev/.local/share/dev.fluxproxy.desktop/ca/fluxproxy-root-ca.pem' /etc/pki/ca-trust/source/anchors/fluxproxy-root-ca.crt && sudo update-ca-trust extract",
  trustStoreBackend: "update-ca-trust",
};

const { getCaInfoMock, installRootCaMock, uninstallRootCaMock } = vi.hoisted(
  () => ({
    getCaInfoMock: vi.fn(),
    installRootCaMock: vi.fn(),
    uninstallRootCaMock: vi.fn(),
  })
);

vi.mock("../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauriBridge")>();
  return {
    ...actual,
    isTauriRuntime: () => false,
    proxyBridge: {
      ...actual.proxyBridge,
      getCaInfo: getCaInfoMock,
      installRootCa: installRootCaMock,
      uninstallRootCa: uninstallRootCaMock,
    },
  };
});

import { CertificateModal } from "./CertificateModal";

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

describe("CertificateModal manual CLI fallback (VER-02)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("displays extracted manual install command with copy button on timeout/error", async () => {
    const manualCmd =
      "sudo cp '/tmp/fluxproxy-root-ca.pem' /etc/ca-certificates/trust-source/anchors/fluxproxy-root-ca.crt && sudo trust anchor --store /etc/ca-certificates/trust-source/anchors/fluxproxy-root-ca.crt && sudo trust extract-compat";
    getCaInfoMock.mockResolvedValue({ ...BASE_CA_INFO });
    installRootCaMock.mockRejectedValue(
      new Error(
        `Превышен таймаут ожидания подтверждения привилегий (60 с): процесс 'pkexec' принудительно завершён.\nКоманда для ручной установки в терминале:\n${manualCmd}`
      )
    );

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onNotify = vi.fn();

    render(
      <CertificateModal open={true} onClose={vi.fn()} onNotify={onNotify} />
    );

    await waitFor(() => {
      expect(screen.getByText(BASE_CA_INFO.subject)).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Trust Root CA in OS Store/i })
    );

    await waitFor(() => {
      expect(screen.getByTestId("ca-manual-install-fallback")).toBeTruthy();
    });

    expect(screen.getByTestId("ca-manual-install-command").textContent).toBe(
      manualCmd
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Копировать команду ручной установки" })
    );
    expect(writeText).toHaveBeenCalledWith(manualCmd);
    expect(onNotify).toHaveBeenCalledWith(
      "Команда ручной установки Root CA скопирована"
    );
  });

  it("falls back to caInfo.manualInstallCommand when error text has no inline command", async () => {
    getCaInfoMock.mockResolvedValue({ ...BASE_CA_INFO });
    installRootCaMock.mockRejectedValue(new Error("User cancelled dialog"));

    render(
      <CertificateModal open={true} onClose={vi.fn()} onNotify={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText(BASE_CA_INFO.subject)).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Trust Root CA in OS Store/i })
    );

    await waitFor(() => {
      expect(screen.getByTestId("ca-manual-install-command").textContent).toBe(
        BASE_CA_INFO.manualInstallCommand
      );
    });
  });

  it("does not render manual fallback box when installRootCa succeeds", async () => {
    getCaInfoMock
      .mockResolvedValueOnce({ ...BASE_CA_INFO, isTrusted: false })
      .mockResolvedValueOnce({ ...BASE_CA_INFO, isTrusted: true });
    installRootCaMock.mockResolvedValue(
      "Root CA installed via update-ca-trust extract."
    );

    render(
      <CertificateModal open={true} onClose={vi.fn()} onNotify={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText(BASE_CA_INFO.subject)).toBeTruthy();
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Trust Root CA in OS Store/i })
    );

    await waitFor(() => {
      expect(
        screen.getByText("Root CA installed via update-ca-trust extract.")
      ).toBeTruthy();
    });
    expect(screen.queryByTestId("ca-manual-install-fallback")).toBeNull();
  });
});
