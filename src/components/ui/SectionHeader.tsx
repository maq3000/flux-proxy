import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Info, X } from "lucide-react";
import { getSectionMeta, type SectionId } from "../../lib/sectionRegistry";

export interface SectionHeaderProps {
  sectionId: SectionId;
  icon?: React.ReactNode;
  headingLevel?: 1 | 2;
  titleId?: string;
  leading?: React.ReactNode;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  compact?: boolean;
  showSummary?: boolean;
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
    return CSS.supports("position-area", "block-end");
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
 * Unified header for workspace tabs and fullscreen screens backed by `SECTION_REGISTRY`.
 * Renders a concise canonical title, single-line summary, and an on-demand "О разделе"
 * disclosure popover (native `popover="auto"` + CSS Anchor Positioning with JS fallback).
 */
export const SectionHeader: React.FC<SectionHeaderProps> = ({
  sectionId,
  icon,
  headingLevel = 1,
  titleId,
  leading,
  badges,
  actions,
  compact = false,
  showSummary = true,
  className = "",
}) => {
  const meta = getSectionMeta(sectionId);
  const reactId = useId();
  const safeId = reactId.replace(/[^a-zA-Z0-9_-]/g, "");
  const resolvedTitleId = titleId ?? `section-title-${safeId}`;
  const popoverId = `section-about-${safeId}`;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const [aboutOpen, setAboutOpen] = useState(false);
  const [coords, setCoords] = useState<FixedCoords | null>(null);

  const updateFallbackCoords = useCallback(() => {
    if (supportsAnchorPositionArea()) {
      setCoords(null);
      return;
    }
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const popWidth = popover?.offsetWidth || 360;
    const popHeight = popover?.offsetHeight || 220;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;

    const left = Math.max(8, Math.min(rect.left, vw - popWidth - 8));
    let top = rect.bottom + 6;
    if (top + popHeight > vh - 8 && rect.top > popHeight + 8) {
      top = Math.max(8, rect.top - popHeight - 6);
    }
    setCoords({ top: Math.round(top), left: Math.round(left) });
  }, []);

  const openAbout = useCallback(() => {
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (popover && supportsNativePopover(popover)) {
      try {
        if (!popover.matches(":popover-open")) {
          (
            popover as HTMLElement & {
              showPopover: (opts?: { source?: HTMLElement }) => void;
            }
          ).showPopover(trigger ? { source: trigger } : undefined);
        }
      } catch {
        // Fallback to state-driven visibility
      }
    }
    setAboutOpen(true);
    window.requestAnimationFrame(updateFallbackCoords);
  }, [updateFallbackCoords]);

  const closeAbout = useCallback(() => {
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
        // Ignore if already closed
      }
    }
    setAboutOpen(false);
  }, []);

  // Keep React state in sync with native popover light-dismiss / Escape toggle events
  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const onToggle = (e: Event) => {
      const evt = e as Event & { newState?: string };
      if (evt.newState === "open") {
        setAboutOpen(true);
        window.requestAnimationFrame(updateFallbackCoords);
      } else if (evt.newState === "closed") {
        setAboutOpen(false);
      }
    };
    popover.addEventListener("toggle", onToggle);
    return () => popover.removeEventListener("toggle", onToggle);
  }, [updateFallbackCoords]);

  // Dismiss on Escape & outside pointer click when running without native popover light-dismiss
  useEffect(() => {
    if (!aboutOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeAbout();
        triggerRef.current?.focus({ preventScroll: true });
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (
        target instanceof Node &&
        wrapperRef.current &&
        !wrapperRef.current.contains(target)
      ) {
        closeAbout();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [aboutOpen, closeAbout]);

  const HeadingTag = headingLevel === 2 ? "h2" : "h1";

  return (
    <header
      className={`flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-hairline bg-surface ${
        compact ? "min-h-8 px-3 py-1" : "min-h-11 px-4 py-2"
      } ${className}`}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
        {leading}

        <div className="flex min-w-0 items-center gap-2">
          {icon && (
            <span className="shrink-0 text-accent" aria-hidden="true">
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <HeadingTag
                id={resolvedTitleId}
                className={`truncate font-semibold text-fg ${
                  compact ? "text-xs" : "text-sm"
                }`}
              >
                {meta.title}
              </HeadingTag>

              {meta.shortcut && (
                <kbd className="hidden rounded border border-hairline bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-subtle sm:inline">
                  {meta.shortcut}
                </kbd>
              )}

              {/* On-demand "О разделе" help disclosure popover */}
              <div
                ref={wrapperRef}
                className="relative inline-flex shrink-0 items-center"
              >
                <button
                  ref={triggerRef}
                  type="button"
                  aria-expanded={aboutOpen}
                  aria-controls={popoverId}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (aboutOpen) {
                      closeAbout();
                    } else {
                      openAbout();
                    }
                  }}
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                    aboutOpen
                      ? "border-accent/60 bg-selected text-fg"
                      : "border-hairline bg-canvas text-muted hover:border-strong hover:bg-hover hover:text-fg"
                  }`}
                >
                  <Info className="h-3 w-3 text-accent" aria-hidden="true" />
                  <span>О разделе</span>
                </button>

                <div
                  ref={popoverRef}
                  id={popoverId}
                  role="region"
                  aria-label={`О разделе: ${meta.title}`}
                  data-open={aboutOpen ? "true" : undefined}
                  {...({ popover: "auto" } as Record<string, string>)}
                  style={
                    coords
                      ? {
                          top: `${coords.top}px`,
                          left: `${coords.left}px`,
                        }
                      : undefined
                  }
                  className={`section-about-popover z-[85] w-[min(24rem,calc(100vw-16px))] rounded-xl border border-strong bg-surface p-3.5 text-left text-xs text-fg shadow-popover select-text ${
                    aboutOpen ? "block" : "hidden"
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-2 border-b border-hairline pb-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-xs font-semibold text-fg">
                        {meta.title}
                      </span>
                      {meta.shortcut && (
                        <kbd className="rounded border border-hairline bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-subtle">
                          {meta.shortcut}
                        </kbd>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        closeAbout();
                        triggerRef.current?.focus({ preventScroll: true });
                      }}
                      aria-label={`Закрыть справку о разделе ${meta.title}`}
                      className="rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>

                  <p className="font-medium leading-relaxed text-fg">
                    {meta.summary}
                  </p>
                  <p className="mt-1.5 leading-relaxed text-muted">
                    {meta.details}
                  </p>

                  {meta.highlights && meta.highlights.length > 0 && (
                    <ul className="mt-2.5 list-disc space-y-1 pl-4 text-[11px] leading-snug text-muted">
                      {meta.highlights.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}

                  {meta.shortcuts && meta.shortcuts.length > 0 && (
                    <div className="mt-2.5 border-t border-hairline pt-2">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-subtle">
                        Горячие клавиши
                      </div>
                      <div className="space-y-1">
                        {meta.shortcuts.map((sc) => (
                          <div
                            key={`${sc.keys}-${sc.label}`}
                            className="flex items-center justify-between gap-2 text-[11px]"
                          >
                            <span className="text-muted">{sc.label}</span>
                            <kbd className="shrink-0 rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-fg">
                              {sc.keys}
                            </kbd>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {compact && showSummary && (
                <span className="hidden truncate text-[11px] text-muted xl:inline">
                  {meta.summary}
                </span>
              )}

              {badges}
            </div>

            {!compact && showSummary && (
              <p className="mt-0.5 truncate text-[11px] text-muted">
                {meta.summary}
              </p>
            )}
          </div>
        </div>
      </div>

      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </header>
  );
};
