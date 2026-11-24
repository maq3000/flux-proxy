import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";

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

function createTestCommands(onPerform: (id: string) => void): PaletteCommand[] {
  return [
    {
      id: "toggle-proxy",
      category: "Proxy",
      group: "capture",
      label: "Pause MITM Capture",
      description: "Остановить прослушивание порта :8888",
      statusBadge: "ON :8888",
      shortcut: "F12",
      perform: () => onPerform("toggle-proxy"),
    },
    {
      id: "throttle-preset-fast3g",
      category: "Throttling",
      group: "network",
      label: "Network Throttling: Fast 3G",
      description: "Ограничить канал до 1500 Kbps",
      statusBadge: "Активно",
      perform: () => onPerform("throttle-preset-fast3g"),
    },
    {
      id: "toggle-tls-mitm-mode",
      category: "TLS / CA",
      group: "filters",
      label: "Switch TLS MITM Mode",
      description: "Переключить Intercept All / Targeted Only",
      statusBadge: "Targeted (2)",
      perform: () => onPerform("toggle-tls-mitm-mode"),
    },
    {
      id: "open-text-wizard",
      category: "TextWizard",
      group: "tools",
      label: "Открыть TextWizard & JWT Decoder",
      description: "Кодирование и декодирование JWT / Base64",
      shortcut: "Ctrl+E",
      perform: () => onPerform("open-text-wizard"),
    },
    {
      id: "open-theme-gallery",
      category: "Theme",
      group: "settings",
      label: "Theme Gallery & Custom Palette",
      description: "Выбор цветовой темы и редактор палитры",
      statusBadge: "Tokyo Night",
      perform: () => onPerform("open-theme-gallery"),
    },
  ];
}

describe("CommandPalette 2.0", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders spacious layout, descriptions, live status badges, grouped sections, and keyboard footer", () => {
    const onPerform = vi.fn();
    const { container } = render(
      <CommandPalette
        open
        onClose={vi.fn()}
        commands={createTestCommands(onPerform)}
      />
    );

    const dialog = container.querySelector("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog?.className).toContain("max-w-3xl");
    expect(dialog?.className).toContain("w-[min(92vw,820px)]");
    expect(dialog?.className).toContain("open:flex");

    const input = screen.getByLabelText("Search commands");
    expect(input.className).toContain("h-12");
    expect(input.className).toContain("text-base");

    const resultsScroller = container.querySelector('[class*="max-h-[62vh]"]');
    expect(resultsScroller).toBeTruthy();

    // Descriptions and live status badges
    expect(
      screen.getByText("Остановить прослушивание порта :8888")
    ).toBeTruthy();
    expect(screen.getByText("ON :8888")).toBeTruthy();
    expect(screen.getByText("Targeted (2)")).toBeTruthy();
    expect(screen.getByText("Tokyo Night")).toBeTruthy();

    // Grouped section headers
    expect(
      screen.getByRole("region", { name: "Захват и Управление сессиями" })
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Сеть, Троттлинг и Маршрутизация" })
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Фильтрация и HTTPS MITM" })
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Инструменты и Экспорт" })
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Настройки и Внешний вид" })
    ).toBeTruthy();

    // Footer shortcut hints and counter
    expect(screen.getByText("↑↓")).toBeTruthy();
    expect(screen.getByText("Enter")).toBeTruthy();
    expect(screen.getByText("Tab")).toBeTruthy();
    expect(screen.getByText("Esc")).toBeTruthy();
    expect(screen.getByText("Найдено: 5")).toBeTruthy();
  });

  it("filters by category tabs and cycles categories with Tab / Shift+Tab", () => {
    const onPerform = vi.fn();
    const { container } = render(
      <CommandPalette
        open
        onClose={vi.fn()}
        commands={createTestCommands(onPerform)}
      />
    );

    const networkTab = container.querySelector<HTMLButtonElement>(
      '[data-category-tab="network"]'
    );
    expect(networkTab).toBeTruthy();
    fireEvent.click(networkTab!);

    expect(networkTab?.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Network Throttling: Fast 3G")).toBeTruthy();
    expect(screen.queryByText("Pause MITM Capture")).toBeNull();
    expect(screen.getByText("Найдено: 1 из 5")).toBeTruthy();

    const input = screen.getByLabelText("Search commands");
    fireEvent.keyDown(input, { key: "Tab" });

    const filtersTab = container.querySelector<HTMLButtonElement>(
      '[data-category-tab="filters"]'
    );
    expect(filtersTab?.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Switch TLS MITM Mode")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(networkTab?.getAttribute("aria-pressed")).toBe("true");
  });

  it("populates QuickExec query from chips and executes QuickExec commands on Enter", () => {
    const onPerform = vi.fn();
    const onClose = vi.fn();
    const onQuickExecBpu = vi.fn();
    const onQuickOpenJwt = vi.fn();
    const onQuickOpenProxyDoctor = vi.fn();

    const renderPalette = (isOpen: boolean) => (
      <CommandPalette
        open={isOpen}
        onClose={onClose}
        commands={createTestCommands(onPerform)}
        onQuickExecBpu={onQuickExecBpu}
        onQuickOpenJwt={onQuickOpenJwt}
        onQuickOpenProxyDoctor={onQuickOpenProxyDoctor}
      />
    );

    const { container, rerender } = render(renderPalette(true));

    // 1. Click `bpu ` chip, type pattern, verify QuickExec section, press Enter
    const bpuChip = container.querySelector<HTMLButtonElement>(
      '[data-quick-chip="bpu "]'
    );
    expect(bpuChip).toBeTruthy();
    fireEvent.click(bpuChip!);

    let input = screen.getByLabelText("Search commands") as HTMLInputElement;
    expect(input.value).toBe("bpu ");

    fireEvent.change(input, { target: { value: "bpu /api/orders" } });
    expect(
      screen.getByRole("region", { name: "Быстрые команды QuickExec" })
    ).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onQuickExecBpu).toHaveBeenCalledWith("request", "/api/orders");
    expect(onClose).toHaveBeenCalledTimes(1);

    // Re-open palette (verifies query/category reset on re-open)
    rerender(renderPalette(false));
    rerender(renderPalette(true));
    input = screen.getByLabelText("Search commands") as HTMLInputElement;
    expect(input.value).toBe("");

    // 2. Click `bpafter ` chip and execute
    const bpafterChip = container.querySelector<HTMLButtonElement>(
      '[data-quick-chip="bpafter "]'
    );
    expect(bpafterChip).toBeTruthy();
    fireEvent.click(bpafterChip!);
    expect(input.value).toBe("bpafter ");
    fireEvent.change(input, { target: { value: "bpafter /graphql" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onQuickExecBpu).toHaveBeenCalledWith("response", "/graphql");

    // Re-open for JWT chip
    rerender(renderPalette(false));
    rerender(renderPalette(true));
    input = screen.getByLabelText("Search commands") as HTMLInputElement;

    // 3. Click `jwt ` chip and verify QuickExec JWT action appears & decodes token
    const jwtChip = container.querySelector<HTMLButtonElement>(
      '[data-quick-chip="jwt "]'
    );
    expect(jwtChip).toBeTruthy();
    fireEvent.click(jwtChip!);
    expect(input.value).toBe("jwt ");
    expect(
      screen.getByText(
        "Открыть JWT Inspector (или вставьте токен eyJ… после jwt )"
      )
    ).toBeTruthy();
    fireEvent.change(input, {
      target: { value: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onQuickOpenJwt).toHaveBeenCalledWith(
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0"
    );

    // Re-open for doctor chip
    rerender(renderPalette(false));
    rerender(renderPalette(true));
    input = screen.getByLabelText("Search commands") as HTMLInputElement;

    // 4. Click `doctor` chip and execute Proxy Doctor
    const doctorChip = container.querySelector<HTMLButtonElement>(
      '[data-quick-chip="doctor"]'
    );
    expect(doctorChip).toBeTruthy();
    fireEvent.click(doctorChip!);
    expect(input.value).toBe("doctor");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onQuickOpenProxyDoctor).toHaveBeenCalledTimes(1);
  });

  it("supports ArrowDown / Enter keyboard navigation across grouped commands", () => {
    const onPerform = vi.fn();
    const onClose = vi.fn();

    render(
      <CommandPalette
        open
        onClose={onClose}
        commands={createTestCommands(onPerform)}
      />
    );

    const input = screen.getByLabelText("Search commands");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onPerform).toHaveBeenCalledWith("throttle-preset-fast3g");
    expect(onClose).toHaveBeenCalled();
  });
});
