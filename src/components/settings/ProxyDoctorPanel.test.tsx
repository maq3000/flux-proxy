import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoctorCheckResult } from "../../types/proxy";

const { runProxyDoctorMock, fixDoctorIssueMock } = vi.hoisted(() => ({
  runProxyDoctorMock: vi.fn(),
  fixDoctorIssueMock: vi.fn(),
}));

vi.mock("../../lib/tauriBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauriBridge")>();
  return {
    ...actual,
    isTauriRuntime: () => false,
    proxyBridge: {
      ...actual.proxyBridge,
      runProxyDoctor: runProxyDoctorMock,
      fixDoctorIssue: fixDoctorIssueMock,
    },
  };
});

import { ProxyDoctorPanel } from "./ProxyDoctorPanel";

describe("ProxyDoctorPanel GPO & EDR diagnostics (VER-01)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders GPO suggested browser command with copy button and disables auto-fix", async () => {
    const gpoCmd = "chrome --proxy-server=http://127.0.0.1:8888";
    const checks: DoctorCheckResult[] = [
      {
        id: "system_proxy_sync",
        title: "Синхронизация системного прокси ОС",
        status: "error",
        summary: "Системный прокси заблокирован политикой организации (GPO)",
        details:
          "HKLM\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\ProxySettingsPerUser = 0",
        canAutoFix: false,
        fixLabel: null,
        suggestedCommand: gpoCmd,
      },
      {
        id: "loopback_e2e",
        title: "End-to-End loopback-маршрутизация (/health)",
        status: "warning",
        summary:
          "Обнаружен внешний SSL-инспектор (Zscaler): отпечаток HTTPS-пробы не совпадает с локальным Root CA",
        details:
          "Ожидаемый Root CA SHA-256: AA:BB\nПолученный сертификат SHA-256: CC:DD",
        canAutoFix: false,
        fixLabel: null,
        suggestedCommand: null,
      },
    ];
    runProxyDoctorMock.mockResolvedValue(checks);

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onNotify = vi.fn();

    render(<ProxyDoctorPanel onNotify={onNotify} />);

    await waitFor(() => {
      expect(
        screen.getByTestId("doctor-suggested-command-system_proxy_sync")
      ).toBeTruthy();
    });

    expect(
      screen.getByText("Системный прокси заблокирован политикой организации (GPO)")
    ).toBeTruthy();
    expect(screen.getByText(gpoCmd)).toBeTruthy();
    expect(
      screen.getByText(/Обнаружен внешний SSL-инспектор \(Zscaler\)/)
    ).toBeTruthy();
    expect(
      screen.getByText(/Полученный сертификат SHA-256: CC:DD/)
    ).toBeTruthy();
    expect(screen.queryByText(/Fix All Fixable/)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Копировать команду system_proxy_sync" })
    );
    expect(writeText).toHaveBeenCalledWith(gpoCmd);
    expect(onNotify).toHaveBeenCalledWith(
      "Команда скопирована: Синхронизация системного прокси ОС"
    );
  });
});
