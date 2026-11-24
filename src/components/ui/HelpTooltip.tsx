import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { HelpCircle } from "lucide-react";

export interface HelpTooltipProps {
  /** Accessible name describing what this help icon explains (e.g. "Подробнее о Drop Non-Matching") */
  label: string;
  /** Optional short heading shown inside the tooltip card */
  title?: string;
  /** Main explanation text */
  content: React.ReactNode;
  /** Optional practical example shown in a distinct box */
  example?: string;
  /** Preferred placement relative to the trigger button */
  placement?: "top" | "bottom";
  /** Optional extra classes for the wrapper element */
  className?: string;
}

interface FixedCoords {
  top: number;
  left: number;
}

function supportsAnchorPositionArea(): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    return false;
  }
  try {
    return CSS.supports("position-area", "block-start");
  } catch {
    return false;
  }
}

function supportsNativePopover(el: HTMLElement | null): boolean {
  return (
    Boolean(el) &&
    typeof HTMLElement !== "undefined" &&
    "popover" in HTMLElement.prototype &&
    typeof (el as HTMLElement & { showPopover?: unknown }).showPopover ===
      "function"
  );
}

/**
 * Accessible contextual help toggletip (`?` icon) using native `popover="hint"`,
 * `interestfor`, and `popovertarget="show"` with progressive hover/focus/click/Escape fallback.
 * Never nest this inside another `<button>`.
 */
export const HelpTooltip: React.FC<HelpTooltipProps> = ({
  label,
  title,
  content,
  example,
  placement = "top",
  className = "",
}) => {
  const reactId = useId();
  const tooltipId = `help-tip-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const wrapperRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<FixedCoords | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const updateFallbackCoords = useCallback(() => {
    if (supportsAnchorPositionArea()) {
      setCoords(null);
      return;
    }
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const popWidth = popover?.offsetWidth || 264;
    const popHeight = popover?.offsetHeight || 96;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;

    const left = Math.max(
      8,
      Math.min(rect.left + rect.width / 2 - popWidth / 2, vw - popWidth - 8)
    );
    const preferTop = placement === "top";
    let top = preferTop ? rect.top - popHeight - 6 : rect.bottom + 6;
    if (preferTop && top < 8) {
      top = Math.min(vh - popHeight - 8, rect.bottom + 6);
    } else if (!preferTop && top + popHeight > vh - 8) {
      top = Math.max(8, rect.top - popHeight - 6);
    }
    setCoords({ top: Math.round(top), left: Math.round(left) });
  }, [placement]);

  const openPopover = useCallback(() => {
    clearCloseTimer();
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (popover && supportsNativePopover(popover)) {
      // Fall back from unsupported `hint` to `auto` so click-opened toggletips can still light-dismiss
      const probe = popover as HTMLElement & { popover: string };
      if (probe.popover !== "hint" && probe.popover !== "auto") {
        probe.popover = "auto";
      }
      try {
        if (!popover.matches(":popover-open")) {
          (
            popover as HTMLElement & {
              showPopover: (opts?: { source?: HTMLElement }) => void;
            }
          ).showPopover(trigger ? { source: trigger } : undefined);
        }
      } catch {
        // Fallback to state-driven display
      }
    }
    setIsOpen(true);
    window.requestAnimationFrame(updateFallbackCoords);
  }, [clearCloseTimer, updateFallbackCoords]);

  const closePopover = useCallback(() => {
    clearCloseTimer();
    const popover = popoverRef.current;
    if (popover && supportsNativePopover(popover)) {
      try {
        if (popover.matches(":popover-open")) {
          (
            popover as HTMLElement & {
              hidePopover: () => void;
            }
          ).hidePopover();
        }
      } catch {
        // Ignore if already hidden
      }
    }
    setIsOpen(false);
  }, [clearCloseTimer]);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closePopover();
    }, 120);
  }, [clearCloseTimer, closePopover]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  // Sync `aria-expanded` from native `toggle` events (capture/element listener)
  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const onToggle = (e: Event) => {
      const evt = e as Event & { newState?: string };
      if (evt.newState === "open") {
        setIsOpen(true);
        window.requestAnimationFrame(updateFallbackCoords);
      } else if (evt.newState === "closed") {
        setIsOpen(false);
      }
    };
    popover.addEventListener("toggle", onToggle);
    return () => popover.removeEventListener("toggle", onToggle);
  }, [updateFallbackCoords]);

  // WCAG 1.4.13 Dismissible: Escape & outside click close only this tooltip
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePopover();
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (
        target instanceof Node &&
        wrapperRef.current &&
        !wrapperRef.current.contains(target)
      ) {
        closePopover();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [isOpen, closePopover]);

  const handleBlur = (e: React.FocusEvent<HTMLSpanElement>) => {
    const nextFocus = e.relatedTarget;
    if (
      nextFocus instanceof Node &&
      wrapperRef.current?.contains(nextFocus)
    ) {
      return;
    }
    closePopover();
  };

  return (
    <span
      ref={wrapperRef}
      onBlur={handleBlur}
      className={`relative inline-flex shrink-0 items-center ${className}`}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={isOpen}
        aria-controls={tooltipId}
        {...({
          interestfor: tooltipId,
          popovertarget: tooltipId,
          popovertargetaction: "show",
        } as Record<string, string>)}
        onPointerEnter={openPopover}
        onPointerLeave={scheduleClose}
        onFocus={openPopover}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isOpen) {
            closePopover();
          } else {
            openPopover();
          }
        }}
        className={`inline-flex h-4 w-4 items-center justify-center rounded-full border border-transparent text-subtle transition-colors hover:border-strong hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          isOpen ? "bg-hover text-fg" : ""
        }`}
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <span
        ref={popoverRef}
        id={tooltipId}
        role="tooltip"
        data-placement={placement}
        data-open={isOpen ? "true" : undefined}
        {...({ popover: "hint" } as Record<string, string>)}
        style={
          coords
            ? {
                top: `${coords.top}px`,
                left: `${coords.left}px`,
              }
            : undefined
        }
        onPointerEnter={clearCloseTimer}
        onPointerLeave={scheduleClose}
        className={`help-tooltip-popover z-[80] w-64 max-w-[min(18rem,calc(100vw-16px))] whitespace-normal rounded-lg border border-strong bg-surface p-2.5 text-left text-[11px] font-normal leading-relaxed text-fg shadow-popover ${
          isOpen ? "block" : "hidden"
        }`}
      >
        {title && (
          <span className="mb-1 block font-semibold text-fg">{title}</span>
        )}
        <span className="block text-muted">{content}</span>
        {example && (
          <span className="mt-1.5 block rounded border border-hairline bg-canvas px-2 py-1 font-mono text-[10px] text-accent">
            {example}
          </span>
        )}
      </span>
    </span>
  );
};
