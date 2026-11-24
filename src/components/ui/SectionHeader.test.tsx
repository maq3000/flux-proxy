import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SectionHeader } from "./SectionHeader";
import { getSectionMeta } from "../../lib/sectionRegistry";

describe("SectionHeader", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders canonical heading, shortcut badge, single-line summary, and optional slots", () => {
    const meta = getSectionMeta("breakpoints");
    render(
      <SectionHeader
        sectionId="breakpoints"
        leading={<button type="button">Traffic</button>}
        badges={<span>2 paused</span>}
        actions={<button type="button">Resume all</button>}
      />
    );

    const heading = screen.getByRole("heading", {
      level: 1,
      name: meta.title,
    });
    expect(heading.textContent).toBe("Breakpoints");
    expect(screen.getAllByText("Alt+6").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(meta.summary).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2 paused")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume all" })).toBeTruthy();
  });

  it("supports headingLevel={2} and custom titleId", () => {
    render(
      <SectionHeader
        sectionId="diff"
        headingLevel={2}
        titleId="custom-diff-title"
      />
    );

    const heading = screen.getByRole("heading", {
      level: 2,
      name: "Session Diff",
    });
    expect(heading.id).toBe("custom-diff-title");
  });

  it("toggles the 'О разделе' disclosure popover with details, highlights, shortcuts, and closes via button / Escape / outside click", () => {
    const meta = getSectionMeta("wizard");
    render(
      <div>
        <SectionHeader sectionId="wizard" />
        <button type="button" data-testid="outside-el">
          Outside
        </button>
      </div>
    );

    const aboutButton = screen.getByRole("button", { name: "О разделе" });
    expect(aboutButton.getAttribute("aria-expanded")).toBe("false");

    const popoverId = aboutButton.getAttribute("aria-controls");
    expect(popoverId).toBeTruthy();
    const popoverEl = document.getElementById(popoverId!);
    expect(popoverEl).not.toBeNull();
    expect(popoverEl?.getAttribute("data-open")).toBeNull();

    // Open disclosure
    fireEvent.click(aboutButton);
    expect(aboutButton.getAttribute("aria-expanded")).toBe("true");
    expect(popoverEl?.getAttribute("data-open")).toBe("true");
    expect(popoverEl?.textContent).toContain(meta.details);
    for (const item of meta.highlights ?? []) {
      expect(popoverEl?.textContent).toContain(item);
    }
    for (const sc of meta.shortcuts ?? []) {
      expect(popoverEl?.textContent).toContain(sc.keys);
      expect(popoverEl?.textContent).toContain(sc.label);
    }

    // Close via internal close button
    fireEvent.click(
      screen.getByRole("button", { name: "Закрыть справку о разделе TextWizard" })
    );
    expect(aboutButton.getAttribute("aria-expanded")).toBe("false");
    expect(popoverEl?.getAttribute("data-open")).toBeNull();

    // Re-open and close via Escape
    fireEvent.click(aboutButton);
    expect(aboutButton.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(aboutButton.getAttribute("aria-expanded")).toBe("false");

    // Re-open and close via outside pointerdown
    fireEvent.click(aboutButton);
    expect(aboutButton.getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(screen.getByTestId("outside-el"));
    expect(aboutButton.getAttribute("aria-expanded")).toBe("false");
  });
});
