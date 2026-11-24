import React, { createContext, useContext } from "react";

export interface ContextMenuHeaderItem {
  type: "header";
  id: string;
  label: string;
  subtitle?: string;
}

export interface ContextMenuSeparatorItem {
  type: "separator";
  id: string;
}

export interface ContextMenuActionItem {
  type?: "action";
  id: string;
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  checkVariant?: "checkbox" | "radio";
  keepOpen?: boolean;
  onSelect: () => void | Promise<void>;
}

export interface ContextMenuSubmenuItem {
  type: "submenu";
  id: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  items: ContextMenuItem[];
}

export type ContextMenuItem =
  | ContextMenuHeaderItem
  | ContextMenuSeparatorItem
  | ContextMenuActionItem
  | ContextMenuSubmenuItem;

export interface ContextMenuOpenOptions {
  ariaLabel?: string;
  minWidth?: number;
  maxWidth?: number;
  restoreFocusTo?: HTMLElement | null;
  keepPropagation?: boolean;
}

export interface ContextMenuEventLike {
  clientX: number;
  clientY: number;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  target?: EventTarget | null;
  currentTarget?: EventTarget | null;
}

export interface ContextMenuContextValue {
  openContextMenu: (
    event: ContextMenuEventLike,
    items: ContextMenuItem[],
    options?: ContextMenuOpenOptions
  ) => void;
  closeContextMenu: (opts?: { restoreFocus?: boolean }) => void;
  isOpen: boolean;
}

const NOOP_CONTEXT_MENU: ContextMenuContextValue = {
  openContextMenu: () => {},
  closeContextMenu: () => {},
  isOpen: false,
};

export const ContextMenuContext =
  createContext<ContextMenuContextValue>(NOOP_CONTEXT_MENU);

/**
 * Strips leading/trailing separators, collapses consecutive separators,
 * and recursively normalizes nested submenus (dropping empty submenus).
 */
export function normalizeContextMenuItems(
  items: readonly ContextMenuItem[]
): ContextMenuItem[] {
  const result: ContextMenuItem[] = [];

  for (const raw of items) {
    if (raw.type === "separator") {
      if (result.length === 0) continue;
      const prev = result[result.length - 1];
      if (prev.type === "separator" || prev.type === "header") continue;
      result.push(raw);
      continue;
    }

    if (raw.type === "submenu") {
      const normalizedChildren = normalizeContextMenuItems(raw.items);
      if (normalizedChildren.length === 0) continue;
      result.push({
        ...raw,
        items: normalizedChildren,
      });
      continue;
    }

    result.push(raw);
  }

  while (result.length > 0 && result[result.length - 1].type === "separator") {
    result.pop();
  }

  return result;
}

/**
 * Returns the unified FluxProxy context menu controller.
 * Safely degrades to a no-op outside `<ContextMenuProvider>` (e.g. isolated unit tests).
 */
export function useContextMenu(): ContextMenuContextValue {
  return useContext(ContextMenuContext);
}
