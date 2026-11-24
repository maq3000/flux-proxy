import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import {
  ContextMenuContext,
  normalizeContextMenuItems,
  type ContextMenuActionItem,
  type ContextMenuContextValue,
  type ContextMenuEventLike,
  type ContextMenuItem,
  type ContextMenuOpenOptions,
  type ContextMenuSubmenuItem,
} from "../../hooks/useContextMenu";

export interface MenuPositionInput {
  x: number;
  y: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  padding?: number;
}

export interface MenuPositionResult {
  left: number;
  top: number;
  maxHeight: number;
  flippedX: boolean;
  flippedY: boolean;
}

/**
 * Computes exact viewport-clamped coordinates for a root context menu using
 * measured DOM dimensions (no hardcoded menu sizes). Flips left/up when space
 * at the pointer overflows the viewport.
 */
export function computeContextMenuPosition({
  x,
  y,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  padding = 8,
}: MenuPositionInput): MenuPositionResult {
  const safeW = Math.max(0, menuWidth);
  const safeH = Math.max(0, menuHeight);
  const maxHeight = Math.max(120, Math.floor(viewportHeight - padding * 2));
  const effectiveH = Math.min(safeH, maxHeight);

  let left = x;
  let flippedX = false;
  if (x + safeW > viewportWidth - padding && x - safeW >= padding) {
    left = x - safeW;
    flippedX = true;
  } else if (x + safeW > viewportWidth - padding) {
    left = viewportWidth - safeW - padding;
    flippedX = left < x;
  }
  left = Math.max(padding, Math.min(left, Math.max(padding, viewportWidth - safeW - padding)));

  let top = y;
  let flippedY = false;
  if (y + effectiveH > viewportHeight - padding && y - effectiveH >= padding) {
    top = y - effectiveH;
    flippedY = true;
  } else if (y + effectiveH > viewportHeight - padding) {
    top = viewportHeight - effectiveH - padding;
    flippedY = top < y;
  }
  top = Math.max(padding, Math.min(top, Math.max(padding, viewportHeight - effectiveH - padding)));

  return {
    left: Math.round(left),
    top: Math.round(top),
    maxHeight,
    flippedX,
    flippedY,
  };
}

export interface SubmenuPositionInput {
  triggerRect: Pick<DOMRect, "left" | "right" | "top" | "bottom">;
  submenuWidth: number;
  submenuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  padding?: number;
}

export interface SubmenuPositionResult {
  left: number;
  top: number;
  maxHeight: number;
  placement: "right" | "left" | "below";
}

/**
 * Computes viewport-aware placement for a nested submenu: right of trigger,
 * auto-flipping left if overflowing, or falling back below-indented on narrow viewports.
 */
export function computeSubmenuPosition({
  triggerRect,
  submenuWidth,
  submenuHeight,
  viewportWidth,
  viewportHeight,
  padding = 8,
}: SubmenuPositionInput): SubmenuPositionResult {
  const safeW = Math.max(0, submenuWidth);
  const safeH = Math.max(0, submenuHeight);
  const maxHeight = Math.max(120, Math.floor(viewportHeight - padding * 2));
  const effectiveH = Math.min(safeH, maxHeight);
  const overlap = 2;

  const fitsRight = triggerRect.right - overlap + safeW <= viewportWidth - padding;
  const fitsLeft = triggerRect.left + overlap - safeW >= padding;

  let left: number;
  let top = triggerRect.top - 4;
  let placement: "right" | "left" | "below";

  if (fitsRight) {
    left = triggerRect.right - overlap;
    placement = "right";
  } else if (fitsLeft) {
    left = triggerRect.left + overlap - safeW;
    placement = "left";
  } else {
    // Narrow-viewport fallback: place below trigger with slight indent so trigger remains visible
    left = Math.max(
      padding,
      Math.min(triggerRect.left + 12, Math.max(padding, viewportWidth - safeW - padding))
    );
    top = triggerRect.bottom + 2;
    placement = "below";
  }

  if (top + effectiveH > viewportHeight - padding) {
    top = Math.max(padding, viewportHeight - effectiveH - padding);
  }
  top = Math.max(padding, top);
  left = Math.max(padding, Math.min(left, Math.max(padding, viewportWidth - safeW - padding)));

  return {
    left: Math.round(left),
    top: Math.round(top),
    maxHeight,
    placement,
  };
}

interface ActiveContextMenuState {
  id: number;
  x: number;
  y: number;
  items: ContextMenuItem[];
  options: ContextMenuOpenOptions;
  restoreFocusTo: HTMLElement | null;
}

function supportsNativePopover(): boolean {
  return (
    typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype
  );
}

function supportsNativeFocusGroup(): boolean {
  return (
    typeof HTMLElement !== "undefined" && "focusGroup" in HTMLElement.prototype
  );
}

function showPopoverSafe(el: HTMLElement | null): void {
  if (!el) return;
  el.setAttribute("data-open", "true");
  if (supportsNativePopover()) {
    try {
      if (!el.matches(":popover-open")) {
        el.showPopover();
      }
      el.classList.remove(":popover-open");
    } catch {
      el.classList.add(":popover-open");
    }
  } else {
    el.classList.add(":popover-open");
  }
}

function hidePopoverSafe(el: HTMLElement | null): void {
  if (!el) return;
  el.removeAttribute("data-open");
  if (supportsNativePopover()) {
    try {
      if (el.matches(":popover-open")) {
        el.hidePopover();
      }
    } catch {
      // ignore if already detached
    }
  }
  el.classList.remove(":popover-open");
}

function getOwnEnabledButtons(groupEl: HTMLElement): HTMLButtonElement[] {
  return Array.from(groupEl.querySelectorAll<HTMLButtonElement>("button"))
    .filter((btn) => btn.closest("[data-flux-menu-group]") === groupEl)
    .filter(
      (btn) => !btn.disabled && btn.getAttribute("aria-disabled") !== "true"
    );
}

interface ContextMenuLevelProps {
  menuId: number;
  levelKey: string;
  items: ContextMenuItem[];
  ariaLabel: string;
  isSubmenu: boolean;
  checkedOverrides: Record<string, boolean>;
  onToggleCheckedOverride: (itemId: string, nextValue: boolean) => void;
  onCloseAll: (opts?: { restoreFocus?: boolean }) => void;
  onCloseSelf?: () => void;
  minWidth?: number;
  maxWidth?: number;
  popoverRef: React.RefObject<HTMLDivElement>;
  style: React.CSSProperties;
  autoFocusFirst?: boolean;
}

const ContextMenuLevel: React.FC<ContextMenuLevelProps> = ({
  menuId,
  levelKey,
  items,
  ariaLabel,
  isSubmenu,
  checkedOverrides,
  onToggleCheckedOverride,
  onCloseAll,
  onCloseSelf,
  minWidth = 208,
  maxWidth = 340,
  popoverRef,
  style,
  autoFocusFirst = false,
}) => {
  const groupRef = useRef<HTMLDivElement>(null);
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const [submenuFocusFirst, setSubmenuFocusFirst] = useState(false);
  const [submenuStyle, setSubmenuStyle] = useState<React.CSSProperties>({
    visibility: "hidden",
    left: 0,
    top: 0,
  });
  const submenuPopoverRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const hoverOpenTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const bridgeCleanupRef = useRef<(() => void) | null>(null);

  const hasNativeFocusGroup = supportsNativeFocusGroup();

  const clearHoverTimers = useCallback(() => {
    if (hoverOpenTimerRef.current !== null) {
      window.clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  const stopBridge = useCallback(() => {
    bridgeCleanupRef.current?.();
    bridgeCleanupRef.current = null;
  }, []);

  useEffect(() => {
    setOpenSubmenuId(null);
    clearHoverTimers();
    stopBridge();
  }, [menuId, items, clearHoverTimers, stopBridge]);

  useEffect(() => {
    return () => {
      clearHoverTimers();
      stopBridge();
    };
  }, [clearHoverTimers, stopBridge]);

  useEffect(() => {
    if (!autoFocusFirst) return;
    const raf = window.requestAnimationFrame(() => {
      const groupEl = groupRef.current;
      if (!groupEl) return;
      const first = getOwnEnabledButtons(groupEl)[0];
      first?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [autoFocusFirst, menuId, levelKey]);

  const positionActiveSubmenu = useCallback(() => {
    if (!openSubmenuId) return;
    const triggerEl = triggerRefs.current[openSubmenuId];
    const subEl = submenuPopoverRef.current;
    if (!triggerEl || !subEl) return;

    showPopoverSafe(subEl);
    const triggerRect = triggerEl.getBoundingClientRect();
    const subRect = subEl.getBoundingClientRect();
    const measuredW = subRect.width || subEl.offsetWidth || 216;
    const measuredH = subRect.height || subEl.offsetHeight || 160;

    const pos = computeSubmenuPosition({
      triggerRect,
      submenuWidth: measuredW,
      submenuHeight: measuredH,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });

    setSubmenuStyle({
      left: `${pos.left}px`,
      top: `${pos.top}px`,
      maxHeight: `${pos.maxHeight}px`,
      visibility: "visible",
    });
  }, [openSubmenuId]);

  useLayoutEffect(() => {
    if (!openSubmenuId) {
      stopBridge();
      hidePopoverSafe(submenuPopoverRef.current);
      return;
    }
    positionActiveSubmenu();
    const raf = window.requestAnimationFrame(() => {
      positionActiveSubmenu();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [openSubmenuId, positionActiveSubmenu, stopBridge]);

  // Start safe-triangle pointer bridge when pointer leaves an open submenu trigger
  const startSafeTriangleBridge = useCallback(
    (submenuEl: HTMLDivElement | null, e: React.PointerEvent<HTMLButtonElement>) => {
      stopBridge();
      if (!submenuEl) return;
      const canHover =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(hover: hover)").matches;
      if (!canHover) return;

      const rect = submenuEl.getBoundingClientRect();
      const pointerLeft = e.clientX < rect.left;
      const pointerRight = e.clientX > rect.right;
      if (!pointerLeft && !pointerRight) return; // --below placement has no side edge

      submenuEl.style.setProperty("--pointer-x", `${e.clientX - rect.left}px`);
      submenuEl.style.setProperty("--pointer-y", `${e.clientY - rect.top}px`);
      submenuEl.setAttribute("data-bridge", "");

      let lastX = e.clientX;
      let timer: number | null = null;

      const stop = () => {
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        submenuEl.removeEventListener("pointermove", onMove);
        submenuEl.removeAttribute("data-bridge");
        if (bridgeCleanupRef.current === stop) {
          bridgeCleanupRef.current = null;
        }
      };

      const onMove = (ev: PointerEvent) => {
        const movingAway = pointerLeft
          ? ev.clientX < lastX
          : ev.clientX > lastX;
        if (ev.target !== submenuEl || movingAway) {
          stop();
          return;
        }
        lastX = ev.clientX;
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(stop, 300);
      };

      timer = window.setTimeout(stop, 300);
      submenuEl.addEventListener("pointermove", onMove);
      bridgeCleanupRef.current = stop;
    },
    [stopBridge]
  );

  const openSubmenu = useCallback(
    (submenuId: string, focusFirst: boolean) => {
      clearHoverTimers();
      setSubmenuFocusFirst(focusFirst);
      setOpenSubmenuId(submenuId);
    },
    [clearHoverTimers]
  );

  const closeActiveSubmenuAndRefocus = useCallback(() => {
    const idToRefocus = openSubmenuId;
    stopBridge();
    clearHoverTimers();
    setOpenSubmenuId(null);
    if (idToRefocus) {
      window.requestAnimationFrame(() => {
        triggerRefs.current[idToRefocus]?.focus({ preventScroll: true });
      });
    }
  }, [openSubmenuId, stopBridge, clearHoverTimers]);

  const handleActivateAction = useCallback(
    (item: ContextMenuActionItem, viaSpaceKey: boolean) => {
      if (item.disabled) return;
      const isCheckbox =
        item.checked !== undefined && item.checkVariant !== "radio";
      const currentChecked =
        item.id in checkedOverrides ? checkedOverrides[item.id] : item.checked;

      if (isCheckbox && typeof currentChecked === "boolean") {
        onToggleCheckedOverride(item.id, !currentChecked);
      }

      const stayOpen = Boolean(item.keepOpen) || (viaSpaceKey && isCheckbox);
      if (!stayOpen) {
        onCloseAll({ restoreFocus: true });
      }
      void item.onSelect();
    },
    [checkedOverrides, onCloseAll, onToggleCheckedOverride]
  );

  const handleGroupKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const groupEl = groupRef.current;
    if (!groupEl) return;
    // Ignore events originating inside a nested child submenu (child handles its own keys)
    const targetEl = e.target as HTMLElement | null;
    if (targetEl && targetEl.closest("[data-flux-menu-group]") !== groupEl) {
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (isSubmenu && onCloseSelf) {
        onCloseSelf();
      } else {
        onCloseAll({ restoreFocus: true });
      }
      return;
    }

    if (e.key === "ArrowLeft" && isSubmenu && onCloseSelf) {
      e.preventDefault();
      e.stopPropagation();
      onCloseSelf();
      return;
    }

    if (e.key === "Tab") {
      onCloseAll({ restoreFocus: false });
      return;
    }

    if (
      e.key === "Home" ||
      e.key === "End" ||
      (!hasNativeFocusGroup && (e.key === "ArrowDown" || e.key === "ArrowUp"))
    ) {
      const enabledButtons = getOwnEnabledButtons(groupEl);
      if (enabledButtons.length === 0) return;
      const currentIdx = enabledButtons.indexOf(
        document.activeElement as HTMLButtonElement
      );
      let nextIdx: number;
      if (e.key === "Home") {
        nextIdx = 0;
      } else if (e.key === "End") {
        nextIdx = enabledButtons.length - 1;
      } else if (currentIdx < 0) {
        nextIdx = e.key === "ArrowUp" ? enabledButtons.length - 1 : 0;
      } else {
        nextIdx =
          (currentIdx + (e.key === "ArrowUp" ? -1 : 1) + enabledButtons.length) %
          enabledButtons.length;
      }

      e.preventDefault();
      e.stopPropagation();
      const nextBtn = enabledButtons[nextIdx];
      nextBtn?.focus({ preventScroll: true });

      const nextSubId = nextBtn?.dataset.submenuTriggerId;
      if (!nextSubId && openSubmenuId) {
        setOpenSubmenuId(null);
      }
      return;
    }

    if (e.key === "ArrowRight") {
      const activeBtn = document.activeElement as HTMLButtonElement | null;
      const subId = activeBtn?.dataset.submenuTriggerId;
      if (subId) {
        e.preventDefault();
        e.stopPropagation();
        openSubmenu(subId, true);
      }
      return;
    }
  };

  return (
    <div
      ref={popoverRef}
      {...({ popover: "auto" } as Record<string, string>)}
      data-flux-context-menu={isSubmenu ? "submenu" : "root"}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{
        minWidth: `${minWidth}px`,
        maxWidth: `${maxWidth}px`,
        ...style,
      }}
      className={`${
        isSubmenu ? "flux-context-submenu" : "flux-context-menu"
      } z-[200] rounded-lg border border-strong bg-surface text-fg shadow-popover`}
    >
      <div
        ref={groupRef}
        data-flux-menu-group={levelKey}
        {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
        {...(!hasNativeFocusGroup ? { role: "menu" } : {})}
        aria-label={ariaLabel}
        onKeyDown={handleGroupKeyDown}
        onPointerMove={(e) => {
          const groupEl = groupRef.current;
          if (!groupEl) return;
          const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(
            "button"
          );
          if (
            !btn ||
            btn.disabled ||
            btn.closest("[data-flux-menu-group]") !== groupEl
          ) {
            return;
          }
          // Guard against synthetic hit-test right after bridge activates
          if (typeof document.elementFromPoint === "function") {
            const topEl = document.elementFromPoint(e.clientX, e.clientY);
            if (topEl && !btn.contains(topEl)) return;
          }
          if (document.activeElement !== btn) {
            btn.focus({ preventScroll: true });
          }
        }}
        className="flux-context-menu-list"
      >
        {items.map((item) => {
          if (item.type === "separator") {
            return <hr key={item.id} className="flux-context-separator" />;
          }

          if (item.type === "header") {
            return (
              <div
                key={item.id}
                role="presentation"
                className="flux-context-header px-2.5 pb-1 pt-1.5"
              >
                <div className="truncate font-mono text-[10px] font-semibold text-muted">
                  {item.label}
                </div>
                {item.subtitle && (
                  <div className="truncate font-mono text-[10px] text-subtle">
                    {item.subtitle}
                  </div>
                )}
              </div>
            );
          }

          if (item.type === "submenu") {
            const subItem = item as ContextMenuSubmenuItem;
            const isSubOpen = openSubmenuId === subItem.id;
            return (
              <React.Fragment key={subItem.id}>
                <button
                  ref={(el) => {
                    triggerRefs.current[subItem.id] = el;
                  }}
                  type="button"
                  disabled={subItem.disabled}
                  data-submenu-trigger-id={subItem.id}
                  aria-haspopup="menu"
                  aria-expanded={isSubOpen}
                  {...(!hasNativeFocusGroup ? { role: "menuitem" } : {})}
                  onPointerEnter={() => {
                    if (subItem.disabled) return;
                    clearHoverTimers();
                    if (openSubmenuId === subItem.id) return;
                    hoverOpenTimerRef.current = window.setTimeout(() => {
                      openSubmenu(subItem.id, false);
                    }, 95);
                  }}
                  onPointerLeave={(e) => {
                    if (isSubOpen) {
                      startSafeTriangleBridge(submenuPopoverRef.current, e);
                    }
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (subItem.disabled) return;
                    if (isSubOpen) {
                      setOpenSubmenuId(null);
                    } else {
                      openSubmenu(subItem.id, e.detail === 0);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!subItem.disabled) {
                        openSubmenu(subItem.id, true);
                      }
                    }
                  }}
                  className="flux-context-item"
                >
                  <span className="flux-context-leading" aria-hidden="true">
                    {subItem.icon ?? null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{subItem.label}</span>
                  <span className="flux-context-hint" aria-hidden="true">
                    <ChevronRight className="h-3.5 w-3.5 text-subtle" />
                  </span>
                </button>

                {isSubOpen && (
                  <ContextMenuLevel
                    menuId={menuId}
                    levelKey={`${levelKey}/${subItem.id}`}
                    items={subItem.items}
                    ariaLabel={subItem.label}
                    isSubmenu={true}
                    checkedOverrides={checkedOverrides}
                    onToggleCheckedOverride={onToggleCheckedOverride}
                    onCloseAll={onCloseAll}
                    onCloseSelf={closeActiveSubmenuAndRefocus}
                    minWidth={200}
                    maxWidth={320}
                    popoverRef={submenuPopoverRef}
                    style={submenuStyle}
                    autoFocusFirst={submenuFocusFirst}
                  />
                )}
              </React.Fragment>
            );
          }

          const action = item as ContextMenuActionItem;
          const isCheckable = action.checked !== undefined;
          const effectiveChecked = isCheckable
            ? action.id in checkedOverrides
              ? checkedOverrides[action.id]
              : Boolean(action.checked)
            : undefined;
          const itemRole = isCheckable
            ? action.checkVariant === "radio"
              ? "menuitemradio"
              : "menuitemcheckbox"
            : !hasNativeFocusGroup
              ? "menuitem"
              : undefined;

          return (
            <button
              key={action.id}
              type="button"
              disabled={action.disabled}
              role={itemRole}
              aria-checked={isCheckable ? effectiveChecked : undefined}
              data-danger={action.danger ? "true" : undefined}
              onPointerEnter={() => {
                clearHoverTimers();
                if (openSubmenuId) {
                  hoverCloseTimerRef.current = window.setTimeout(() => {
                    setOpenSubmenuId(null);
                  }, 110);
                }
              }}
              onClick={(e) => {
                e.stopPropagation();
                handleActivateAction(action, false);
              }}
              onKeyDown={(e) => {
                if (e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  handleActivateAction(action, true);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  handleActivateAction(action, false);
                }
              }}
              className={`flux-context-item ${
                action.danger ? "flux-context-item-danger" : ""
              }`}
            >
              <span className="flux-context-leading" aria-hidden="true">
                {isCheckable ? (
                  effectiveChecked ? (
                    action.checkVariant === "radio" ? (
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                    ) : (
                      <Check className="h-3.5 w-3.5 text-accent" />
                    )
                  ) : null
                ) : (
                  action.icon ?? null
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
              {action.shortcut && (
                <span className="flux-context-hint" aria-hidden="true">
                  {action.shortcut}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export interface ContextMenuProviderProps {
  children: React.ReactNode;
}

export const ContextMenuProvider: React.FC<ContextMenuProviderProps> = ({
  children,
}) => {
  const nextIdRef = useRef(1);
  const rootPopoverRef = useRef<HTMLDivElement>(null);
  const [menuState, setMenuState] = useState<ActiveContextMenuState | null>(
    null
  );
  const [checkedOverrides, setCheckedOverrides] = useState<
    Record<string, boolean>
  >({});
  const [rootStyle, setRootStyle] = useState<React.CSSProperties>({
    left: 0,
    top: 0,
    visibility: "hidden",
  });

  const menuStateRef = useRef<ActiveContextMenuState | null>(null);
  menuStateRef.current = menuState;

  const closeContextMenu = useCallback((opts?: { restoreFocus?: boolean }) => {
    const current = menuStateRef.current;
    hidePopoverSafe(rootPopoverRef.current);
    setMenuState(null);
    setCheckedOverrides({});
    if (opts?.restoreFocus && current?.restoreFocusTo?.isConnected) {
      window.requestAnimationFrame(() => {
        try {
          current.restoreFocusTo?.focus({ preventScroll: true });
        } catch {
          // ignore unfocusable element
        }
      });
    }
  }, []);

  const openContextMenu = useCallback(
    (
      event: ContextMenuEventLike,
      rawItems: ContextMenuItem[],
      options: ContextMenuOpenOptions = {}
    ) => {
      event.preventDefault?.();
      if (!options.keepPropagation) {
        event.stopPropagation?.();
      }

      const items = normalizeContextMenuItems(rawItems);
      if (items.length === 0) {
        closeContextMenu({ restoreFocus: false });
        return;
      }

      const restoreFocusTo =
        options.restoreFocusTo !== undefined
          ? options.restoreFocusTo
          : document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;

      setCheckedOverrides({});
      setRootStyle({
        left: `${Math.max(8, Math.round(event.clientX))}px`,
        top: `${Math.max(8, Math.round(event.clientY))}px`,
        visibility: "hidden",
      });
      setMenuState({
        id: nextIdRef.current++,
        x: event.clientX,
        y: event.clientY,
        items,
        options,
        restoreFocusTo,
      });
    },
    [closeContextMenu]
  );

  const measureAndPositionRoot = useCallback(() => {
    const state = menuStateRef.current;
    const el = rootPopoverRef.current;
    if (!state || !el) return;

    showPopoverSafe(el);
    const rect = el.getBoundingClientRect();
    const measuredW = rect.width || el.offsetWidth || state.options.minWidth || 224;
    const measuredH = rect.height || el.offsetHeight || 200;

    const pos = computeContextMenuPosition({
      x: state.x,
      y: state.y,
      menuWidth: measuredW,
      menuHeight: measuredH,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });

    setRootStyle({
      left: `${pos.left}px`,
      top: `${pos.top}px`,
      maxHeight: `${pos.maxHeight}px`,
      visibility: "visible",
    });
  }, []);

  useLayoutEffect(() => {
    if (!menuState) return;
    measureAndPositionRoot();
    const raf = window.requestAnimationFrame(() => {
      measureAndPositionRoot();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [menuState, measureAndPositionRoot]);

  // Global dismissal listeners: outside pointerdown, outside scroll, resize, window blur, native popover toggle
  useEffect(() => {
    if (!menuState) return;

    const handlePointerDown = (e: PointerEvent | MouseEvent) => {
      const rootEl = rootPopoverRef.current;
      const target = e.target as Node | null;
      if (rootEl && target && rootEl.contains(target)) {
        return;
      }
      closeContextMenu({ restoreFocus: false });
    };

    const handleScroll = (e: Event) => {
      const rootEl = rootPopoverRef.current;
      const target = e.target as Node | null;
      if (rootEl && target && rootEl.contains(target)) {
        return;
      }
      closeContextMenu({ restoreFocus: false });
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        closeContextMenu({ restoreFocus: true });
      }
    };

    const handleWindowDismiss = () => {
      closeContextMenu({ restoreFocus: false });
    };

    const rootEl = rootPopoverRef.current;
    const handleNativeToggle = (e: Event) => {
      const toggleEv = e as Event & { newState?: string };
      if (toggleEv.newState === "closed" && menuStateRef.current) {
        setMenuState(null);
        setCheckedOverrides({});
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleWindowDismiss);
    window.addEventListener("blur", handleWindowDismiss);
    window.addEventListener("keydown", handleKeyDown);
    rootEl?.addEventListener("toggle", handleNativeToggle);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleWindowDismiss);
      window.removeEventListener("blur", handleWindowDismiss);
      window.removeEventListener("keydown", handleKeyDown);
      rootEl?.removeEventListener("toggle", handleNativeToggle);
    };
  }, [menuState, closeContextMenu]);

  const handleToggleCheckedOverride = useCallback(
    (itemId: string, nextValue: boolean) => {
      setCheckedOverrides((prev) => ({ ...prev, [itemId]: nextValue }));
    },
    []
  );

  const contextValue = useMemo<ContextMenuContextValue>(
    () => ({
      openContextMenu,
      closeContextMenu,
      isOpen: menuState !== null,
    }),
    [openContextMenu, closeContextMenu, menuState]
  );

  const portalTarget = typeof document !== "undefined" ? document.body : null;

  return (
    <ContextMenuContext.Provider value={contextValue}>
      {children}
      {portalTarget &&
        menuState &&
        createPortal(
          <ContextMenuLevel
            menuId={menuState.id}
            levelKey="root"
            items={menuState.items}
            ariaLabel={menuState.options.ariaLabel ?? "Context Menu"}
            isSubmenu={false}
            checkedOverrides={checkedOverrides}
            onToggleCheckedOverride={handleToggleCheckedOverride}
            onCloseAll={closeContextMenu}
            minWidth={menuState.options.minWidth ?? 216}
            maxWidth={menuState.options.maxWidth ?? 340}
            popoverRef={rootPopoverRef}
            style={rootStyle}
            autoFocusFirst={true}
          />,
          portalTarget
        )}
    </ContextMenuContext.Provider>
  );
};
