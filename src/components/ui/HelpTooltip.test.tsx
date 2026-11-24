import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpTooltip } from "./HelpTooltip";

describe("HelpTooltip", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders accessible trigger and popover attributes without React DOM warnings", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <HelpTooltip
        label="Подробнее о Drop Non-Matching"
        title="Drop Non-Matching"
        content="Сбрасывает отфильтрованные сессии до записи в буфер."
        example="*.png, *.css"
      />
    );

    const trigger = screen.getByRole("button", {
      name: "Подробнее о Drop Non-Matching",
    });
    expect(trigger.getAttribute("type")).toBe("button");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const controlsId = trigger.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();

    const tooltip = document.getElementById(controlsId!);
    expect(tooltip).not.toBeNull();
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(tooltip?.getAttribute("popover")).toBe("hint");
    expect(tooltip?.className).toContain("hidden");
    expect(tooltip?.textContent).toContain("Drop Non-Matching");
    expect(tooltip?.textContent).toContain("*.png, *.css");

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("opens on pointerEnter, focus, and click, and toggles closed on second click", () => {
    render(
      <HelpTooltip
        label="Ring Buffer"
        content="Хранит последние N сессий в ОЗУ."
      />
    );

    const trigger = screen.getByRole("button", { name: "Ring Buffer" });
    const tooltip = screen.getByRole("tooltip", { hidden: true });

    fireEvent.pointerEnter(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(tooltip.getAttribute("data-open")).toBe("true");
    expect(tooltip.className).toContain("block");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(tooltip.getAttribute("data-open")).toBeNull();

    fireEvent.focus(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("stops click propagation so parent clickable rows/labels are not triggered", () => {
    const parentClick = vi.fn();

    render(
      <div onClick={parentClick}>
        <HelpTooltip label="CLI Env" content="Переменные окружения терминала." />
      </div>
    );

    const trigger = screen.getByRole("button", { name: "CLI Env" });
    fireEvent.click(trigger);

    expect(parentClick).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on Escape and stops keydown propagation to parent listeners", () => {
    const parentKeyDown = vi.fn();

    render(
      <div onKeyDown={parentKeyDown}>
        <HelpTooltip label="Selective MITM" content="Targeted Allowlist." />
      </div>
    );

    const trigger = screen.getByRole("button", { name: "Selective MITM" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(parentKeyDown).not.toHaveBeenCalled();
  });
});
