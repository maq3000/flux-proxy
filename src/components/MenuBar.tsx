import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Command } from "lucide-react";
import {
  TOOLBAR_GROUP_DEFINITIONS,
  TRAFFIC_COLUMNS,
} from "../hooks/useUiPreferences";
import type { ThemePreference } from "../hooks/useTheme";
import { SESSION_RETENTION_PRESETS } from "../types/proxy";
import type {
  ActiveNavSection,
  BreakpointConfig,
  ColumnId,
  InspectorDockPosition,
  ProxyStatus,
  TlsInterceptMode,
  ToolbarGroupId,
} from "../types/proxy";

function formatMenuRetentionLabel(limit: number | null): string {
  if (limit === null) return "All Sessions";
  return limit.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

interface MenuBarProps {
  status: ProxyStatus;
  totalCount: number;
  filteredCount: number;
  hasSelection: boolean;
  selectedCount: number;
  activeSection: ActiveNavSection;
  onSelectSection: (section: ActiveNavSection) => void;
  // File
  onToggleProxy: () => void;
  onToggleAllowRemote: () => void;
  onToggleSystemProxy: () => void;
  onToggleAutoSystemProxy: () => void;
  onSaveAllSessionsAs: () => void;
  onSaveSelectedSessionsAs: () => void;
  onImportArchive: () => void;
  onSaveSqlite: () => void;
  onLoadSqlite: () => void;
  onClearSessions: () => void;
  onExportSettingsProfile: () => void;
  onImportSettingsProfile: () => void;
  onOpenPreferences: () => void;
  // Edit
  onCopyUrl: () => void;
  onCopyCurl: () => void;
  onCopyRequestHeaders: () => void;
  onCopyResponseHeaders: () => void;
  onAnnotateSelected: () => void;
  onUnmarkSelected: () => void;
  onDeleteSelected: () => void;
  onFocusSearch: () => void;
  // Rules
  breakpointConfig: BreakpointConfig;
  onToggleBreakBeforeRequest: () => void;
  onToggleBreakAfterResponse: () => void;
  onDisableAllBreakpoints: () => void;
  onOpenBreakpointsModal: () => void;
  isForceNoCacheActive: boolean;
  onToggleForceNoCache: () => void;
  hideConnectTunnels: boolean;
  onToggleHideConnectTunnels: () => void;
  tlsInterceptMode: TlsInterceptMode;
  targetHostsCount: number;
  onToggleTlsInterceptMode: () => void;
  onOpenFilterDrawer: () => void;
  onOpenHostsListDrawer: () => void;
  onOpenTlsModeDrawer: () => void;
  // View
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  inspectorCollapsed: boolean;
  onToggleInspector: () => void;
  inspectorPosition: InspectorDockPosition;
  onSetInspectorPosition: (pos: InspectorDockPosition) => void;
  dockedComposer: boolean;
  onToggleDockedComposer: () => void;
  followTail: boolean;
  onToggleFollowTail: () => void;
  compactToolbar?: boolean;
  onToggleCompactToolbar?: () => void;
  toolbarGroups: Record<ToolbarGroupId, boolean>;
  onToggleToolbarGroup: (groupId: ToolbarGroupId) => void;
  onResetToolbarGroups: () => void;
  visibleColumns: Record<ColumnId, boolean>;
  onToggleColumnVisibility: (colId: ColumnId) => void;
  onResetColumns: () => void;
  themePreference: ThemePreference;
  onSetTheme: (pref: ThemePreference) => void;
  // Tools
  sessionRetentionLimit: number | null;
  onSetSessionRetentionLimit: (limit: number | null) => void;
  onOpenCustomRetentionLimit: () => void;
  dropNonMatching: boolean;
  onToggleDropNonMatching: () => void;
  onReplaySelected: () => void;
  onSendSelectedToComposer: () => void;
  onOpenSessionDiff: () => void;
  onOpenTextWizard: () => void;
  onOpenHexConverter: () => void;
  onInspectInHex: () => void;
  onOpenCompressionCodec: () => void;
  onOpenMobileSetup: () => void;
  onOpenCertificates: () => void;
  onGenerateStress10k: () => void;
  // Help
  onOpenCommandPalette: () => void;
  onOpenShortcutsModal: () => void;
  onCopyCliEnv: () => void;
  onResetAllUiPreferences: () => void;
}

type TopMenuKey = "file" | "edit" | "rules" | "view" | "tools" | "help";

const TOP_MENUS: { key: TopMenuKey; label: string }[] = [
  { key: "file", label: "File" },
  { key: "edit", label: "Edit" },
  { key: "rules", label: "Rules" },
  { key: "view", label: "View" },
  { key: "tools", label: "Tools" },
  { key: "help", label: "Help" },
];

function isPopoverOpen(el: HTMLElement | null): boolean {
  if (!el) return false;
  try {
    if ("popover" in HTMLElement.prototype && el.matches(":popover-open")) {
      return true;
    }
  } catch {
    // ignore selector errors on legacy engines
  }
  return el.classList.contains(":popover-open");
}

function showMenuPopover(menu: HTMLElement, trigger: HTMLElement) {
  if (!CSS.supports("position-area", "block-end")) {
    positionPopoverFallback(trigger, menu, Boolean(menu.parentElement?.closest("[popover]")));
  }
  if ("popover" in HTMLElement.prototype) {
    if (!isPopoverOpen(menu)) {
      try {
        (
          menu as HTMLElement & {
            showPopover: (opts?: { source?: HTMLElement }) => void;
          }
        ).showPopover({ source: trigger });
      } catch {
        menu.showPopover();
      }
      if (!CSS.supports("position-area", "block-end")) {
        window.requestAnimationFrame(() => {
          positionPopoverFallback(
            trigger,
            menu,
            Boolean(menu.parentElement?.closest("[popover]"))
          );
        });
      }
    }
  } else {
    menu.classList.add(":popover-open");
  }
}

function hideMenuPopover(menu: HTMLElement | null) {
  if (!menu) return;
  if ("popover" in HTMLElement.prototype) {
    if (isPopoverOpen(menu)) {
      menu.hidePopover();
    }
  } else {
    menu.classList.remove(":popover-open");
  }
}

function positionPopoverFallback(
  trigger: HTMLElement,
  menu: HTMLElement,
  isSubmenu: boolean
) {
  const rect = trigger.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 248;
  const menuHeight = menu.offsetHeight || 280;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left: number;
  let top: number;

  if (isSubmenu) {
    left = rect.right + 4;
    if (left + menuWidth > vw - 8) {
      left = Math.max(8, rect.left - menuWidth - 4);
    }
    top = Math.min(rect.top, Math.max(8, vh - menuHeight - 8));
  } else {
    left = Math.min(rect.left, Math.max(8, vw - menuWidth - 8));
    top = rect.bottom + 3;
    if (top + menuHeight > vh - 8 && rect.top > menuHeight + 8) {
      top = rect.top - menuHeight - 3;
    }
  }

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function startSubmenuSafeTriangle(
  submenu: HTMLElement | null,
  event: React.PointerEvent<HTMLButtonElement>
) {
  if (
    !submenu ||
    typeof window === "undefined" ||
    !window.matchMedia("(hover: hover)").matches ||
    !isPopoverOpen(submenu)
  ) {
    return;
  }
  const rect = submenu.getBoundingClientRect();
  if (event.clientX >= rect.left && event.clientX <= rect.right) return;
  const style = submenu.style;
  style.setProperty(
    "--bridge-edge",
    `${event.clientX < rect.left ? 0 : rect.width}px`
  );
  style.setProperty("--bridge-height", `${rect.height}px`);

  const update = (ev: PointerEvent) => {
    if (
      ev.target instanceof Node &&
      ev.target !== submenu &&
      submenu.contains(ev.target)
    ) {
      stop();
      return;
    }
    style.setProperty("--bridge-x", `${ev.clientX - rect.left}px`);
    style.setProperty("--bridge-y", `${ev.clientY - rect.top}px`);
  };

  const stop = () => {
    window.clearTimeout(timer);
    document.removeEventListener("pointermove", update);
    submenu.removeEventListener("toggle", stop);
    submenu.removeAttribute("data-bridge");
  };

  const timer = window.setTimeout(stop, 300);
  style.setProperty("--bridge-x", `${event.clientX - rect.left}px`);
  style.setProperty("--bridge-y", `${event.clientY - rect.top}px`);
  submenu.dataset.bridge = "";
  document.addEventListener("pointermove", update);
  submenu.addEventListener("toggle", stop, { once: true });
}

export const MenuBar: React.FC<MenuBarProps> = ({
  status,
  totalCount,
  filteredCount,
  hasSelection,
  selectedCount,
  activeSection,
  onSelectSection,
  onToggleProxy,
  onToggleAllowRemote,
  onToggleSystemProxy,
  onToggleAutoSystemProxy,
  onSaveAllSessionsAs,
  onSaveSelectedSessionsAs,
  onImportArchive,
  onSaveSqlite,
  onLoadSqlite,
  onClearSessions,
  onExportSettingsProfile,
  onImportSettingsProfile,
  onOpenPreferences,
  onCopyUrl,
  onCopyCurl,
  onCopyRequestHeaders,
  onCopyResponseHeaders,
  onAnnotateSelected,
  onUnmarkSelected,
  onDeleteSelected,
  onFocusSearch,
  breakpointConfig,
  onToggleBreakBeforeRequest,
  onToggleBreakAfterResponse,
  onDisableAllBreakpoints,
  onOpenBreakpointsModal,
  isForceNoCacheActive,
  onToggleForceNoCache,
  hideConnectTunnels,
  onToggleHideConnectTunnels,
  tlsInterceptMode,
  targetHostsCount,
  onToggleTlsInterceptMode,
  onOpenFilterDrawer,
  onOpenHostsListDrawer,
  onOpenTlsModeDrawer,
  sidebarCollapsed,
  onToggleSidebar,
  inspectorCollapsed,
  onToggleInspector,
  inspectorPosition,
  onSetInspectorPosition,
  dockedComposer,
  onToggleDockedComposer,
  followTail,
  onToggleFollowTail,
  compactToolbar = false,
  onToggleCompactToolbar,
  toolbarGroups,
  onToggleToolbarGroup,
  onResetToolbarGroups,
  visibleColumns,
  onToggleColumnVisibility,
  onResetColumns,
  themePreference,
  onSetTheme,
  sessionRetentionLimit,
  onSetSessionRetentionLimit,
  onOpenCustomRetentionLimit,
  dropNonMatching,
  onToggleDropNonMatching,
  onReplaySelected,
  onSendSelectedToComposer,
  onOpenSessionDiff,
  onOpenTextWizard,
  onOpenHexConverter,
  onInspectInHex,
  onOpenCompressionCodec,
  onOpenMobileSetup,
  onOpenCertificates,
  onGenerateStress10k,
  onOpenCommandPalette,
  onOpenShortcutsModal,
  onCopyCliEnv,
  onResetAllUiPreferences,
}) => {
  const baseId = useId();
  const menubarRef = useRef<HTMLDivElement>(null);
  const triggerRefs = useRef<Record<TopMenuKey, HTMLButtonElement | null>>({
    file: null,
    edit: null,
    rules: null,
    view: null,
    tools: null,
    help: null,
  });
  const menuRefs = useRef<Record<TopMenuKey, HTMLDivElement | null>>({
    file: null,
    edit: null,
    rules: null,
    view: null,
    tools: null,
    help: null,
  });
  const toolbarSubTriggerRef = useRef<HTMLButtonElement>(null);
  const toolbarSubMenuRef = useRef<HTMLDivElement>(null);
  const columnsSubTriggerRef = useRef<HTMLButtonElement>(null);
  const columnsSubMenuRef = useRef<HTMLDivElement>(null);
  const retentionSubTriggerRef = useRef<HTMLButtonElement>(null);
  const retentionSubMenuRef = useRef<HTMLDivElement>(null);

  const [activeTabIdx, setActiveTabIdx] = useState(0);
  const [openTopKey, setOpenTopKey] = useState<TopMenuKey | null>(null);
  const [toolbarSubOpen, setToolbarSubOpen] = useState(false);
  const [columnsSubOpen, setColumnsSubOpen] = useState(false);
  const [retentionSubOpen, setRetentionSubOpen] = useState(false);

  const enterOnOpenRef = useRef<WeakSet<HTMLElement>>(new WeakSet());
  const enterLastOnOpenRef = useRef<WeakSet<HTMLElement>>(new WeakSet());
  const pointerPressedRef = useRef<HTMLElement | null>(null);

  const closeAllMenus = useCallback(
    (restoreFocusToTrigger = false, fromPointer = true) => {
      const currentKey = openTopKey;
      hideMenuPopover(toolbarSubMenuRef.current);
      hideMenuPopover(columnsSubMenuRef.current);
      hideMenuPopover(retentionSubMenuRef.current);
      for (const { key } of TOP_MENUS) {
        hideMenuPopover(menuRefs.current[key]);
      }
      setOpenTopKey(null);
      setToolbarSubOpen(false);
      setColumnsSubOpen(false);
      setRetentionSubOpen(false);

      if (restoreFocusToTrigger && currentKey) {
        const trigger = triggerRefs.current[currentKey];
        if (trigger) {
          (
            trigger as HTMLElement & {
              focus: (opts?: FocusOptions & { focusVisible?: boolean }) => void;
            }
          ).focus({ preventScroll: true, focusVisible: !fromPointer });
        }
      }
    },
    [openTopKey]
  );

  // Progressive enhancement fallback for focusgroup + toggle listeners
  useEffect(() => {
    const bar = menubarRef.current;
    if (!bar) return;

    const cleanups: (() => void)[] = [];

    if (
      typeof HTMLElement !== "undefined" &&
      !("focusGroup" in HTMLElement.prototype)
    ) {
      bar.querySelectorAll<HTMLElement>('[focusgroup~="menu"]').forEach(
        (group) => {
          group.setAttribute("role", "menu");
          group
            .querySelectorAll<HTMLButtonElement>("button:not([role])")
            .forEach((item) => {
              item.setAttribute("role", "menuitem");
            });

          const onKeyDown = (event: KeyboardEvent) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              return;
            }
            const items = Array.from(
              group.querySelectorAll<HTMLButtonElement>("button")
            )
              .filter((item) => item.closest("[focusgroup]") === group)
              .filter(
                (item) =>
                  !item.disabled &&
                  item.getAttribute("aria-disabled") !== "true"
              );
            if (items.length === 0) return;
            const current = items.indexOf(
              document.activeElement as HTMLButtonElement
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : current < 0
                    ? 0
                    : (current +
                        (event.key === "ArrowUp" ? -1 : 1) +
                        items.length) %
                      items.length;
            event.preventDefault();
            event.stopImmediatePropagation();
            items[next]?.focus({ preventScroll: true });
          };

          group.addEventListener("keydown", onKeyDown, true);
          cleanups.push(() =>
            group.removeEventListener("keydown", onKeyDown, true)
          );
        }
      );
    }

    // Sync aria-expanded & keyboard-open initial focus via native toggle events
    TOP_MENUS.forEach(({ key }) => {
      const menu = menuRefs.current[key];
      const trigger = triggerRefs.current[key];
      if (!menu || !trigger) return;

      const onToggle = () => {
        const opened = isPopoverOpen(menu);
        if (opened) {
          setOpenTopKey(key);
          if (!CSS.supports("position-area", "block-end")) {
            positionPopoverFallback(trigger, menu, false);
          }
          if (enterOnOpenRef.current.has(menu)) {
            enterOnOpenRef.current.delete(menu);
            const focusLast = enterLastOnOpenRef.current.has(menu);
            enterLastOnOpenRef.current.delete(menu);
            const group = menu.querySelector<HTMLElement>('[focusgroup~="menu"]');
            const items = group
              ? Array.from(group.querySelectorAll<HTMLButtonElement>("button"))
                  .filter((b) => b.closest("[focusgroup]") === group)
                  .filter((b) => !b.disabled)
              : [];
            const target = focusLast ? items[items.length - 1] : items[0];
            window.requestAnimationFrame(() => {
              target?.focus({ preventScroll: true });
            });
          } else if (pointerPressedRef.current === trigger) {
            pointerPressedRef.current = null;
            (
              trigger as HTMLElement & {
                focus: (opts?: FocusOptions & { focusVisible?: boolean }) => void;
              }
            ).focus({ preventScroll: true, focusVisible: false });
          }
        } else {
          setOpenTopKey((prev) => (prev === key ? null : prev));
        }
      };

      menu.addEventListener("toggle", onToggle);
      cleanups.push(() => menu.removeEventListener("toggle", onToggle));
    });

    const subPairs: [
      React.RefObject<HTMLButtonElement>,
      React.RefObject<HTMLDivElement>,
      React.Dispatch<React.SetStateAction<boolean>>,
    ][] = [
      [toolbarSubTriggerRef, toolbarSubMenuRef, setToolbarSubOpen],
      [columnsSubTriggerRef, columnsSubMenuRef, setColumnsSubOpen],
      [retentionSubTriggerRef, retentionSubMenuRef, setRetentionSubOpen],
    ];

    subPairs.forEach(([trigRef, subRef, setter]) => {
      const sub = subRef.current;
      const trig = trigRef.current;
      if (!sub || !trig) return;
      const onSubToggle = () => {
        const opened = isPopoverOpen(sub);
        setter(opened);
        if (opened) {
          if (!CSS.supports("position-area", "block-end")) {
            positionPopoverFallback(trig, sub, true);
          }
          if (enterOnOpenRef.current.has(sub)) {
            enterOnOpenRef.current.delete(sub);
            const group = sub.querySelector<HTMLElement>('[focusgroup~="menu"]');
            const first = group?.querySelector<HTMLButtonElement>(
              "button:not(:disabled)"
            );
            window.requestAnimationFrame(() => {
              first?.focus({ preventScroll: true });
            });
          }
        }
      };
      sub.addEventListener("toggle", onSubToggle);
      cleanups.push(() => sub.removeEventListener("toggle", onSubToggle));
    });

    const onFocusIn = (e: FocusEvent) => {
      if (
        e.target instanceof Node &&
        !bar.contains(e.target)
      ) {
        for (const { key } of TOP_MENUS) {
          hideMenuPopover(menuRefs.current[key]);
        }
        hideMenuPopover(toolbarSubMenuRef.current);
        hideMenuPopover(columnsSubMenuRef.current);
        hideMenuPopover(retentionSubMenuRef.current);
        setOpenTopKey(null);
      }
    };
    document.addEventListener("focusin", onFocusIn);
    cleanups.push(() => document.removeEventListener("focusin", onFocusIn));

    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, []);

  const handleTriggerClickFallback = (
    e: React.MouseEvent<HTMLButtonElement>,
    menu: HTMLElement | null,
    trigger: HTMLElement | null
  ) => {
    if (!menu || !trigger) return;
    const fromKeyboard = e.detail === 0;
    if (fromKeyboard) {
      enterOnOpenRef.current.add(menu);
    }
    if (
      typeof HTMLButtonElement !== "undefined" &&
      !("commandForElement" in HTMLButtonElement.prototype)
    ) {
      e.preventDefault();
      if (isPopoverOpen(menu)) {
        hideMenuPopover(menu);
      } else {
        showMenuPopover(menu, trigger);
      }
    }
  };

  const openAdjacentTopMenu = (delta: 1 | -1, enterItems = false) => {
    const currentIdx =
      openTopKey !== null
        ? TOP_MENUS.findIndex((m) => m.key === openTopKey)
        : activeTabIdx;
    const nextIdx =
      (Math.max(0, currentIdx) + delta + TOP_MENUS.length) % TOP_MENUS.length;
    const nextKey = TOP_MENUS[nextIdx].key;
    setActiveTabIdx(nextIdx);

    const wasAnyOpen = openTopKey !== null;
    for (const { key } of TOP_MENUS) {
      if (key !== nextKey) hideMenuPopover(menuRefs.current[key]);
    }
    hideMenuPopover(toolbarSubMenuRef.current);
    hideMenuPopover(columnsSubMenuRef.current);
    hideMenuPopover(retentionSubMenuRef.current);

    const nextTrigger = triggerRefs.current[nextKey];
    const nextMenu = menuRefs.current[nextKey];
    nextTrigger?.focus({ preventScroll: true });

    if (wasAnyOpen && nextMenu && nextTrigger) {
      if (enterItems) {
        enterOnOpenRef.current.add(nextMenu);
      }
      showMenuPopover(nextMenu, nextTrigger);
      setOpenTopKey(nextKey);
    }
  };

  const handleMenubarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const inSubmenu =
      toolbarSubMenuRef.current?.contains(target) ||
      columnsSubMenuRef.current?.contains(target) ||
      retentionSubMenuRef.current?.contains(target);

    if (e.key === "Tab") {
      closeAllMenus(false);
      return;
    }

    if (inSubmenu) {
      if (e.key === "Escape" || e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        if (toolbarSubMenuRef.current?.contains(target)) {
          toolbarSubTriggerRef.current?.focus({ preventScroll: true });
          hideMenuPopover(toolbarSubMenuRef.current);
        } else if (columnsSubMenuRef.current?.contains(target)) {
          columnsSubTriggerRef.current?.focus({ preventScroll: true });
          hideMenuPopover(columnsSubMenuRef.current);
        } else if (retentionSubMenuRef.current?.contains(target)) {
          retentionSubTriggerRef.current?.focus({ preventScroll: true });
          hideMenuPopover(retentionSubMenuRef.current);
        }
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        openAdjacentTopMenu(1, false);
        return;
      }
      return;
    }

    // Submenu trigger ArrowRight
    if (
      e.key === "ArrowRight" &&
      (target === toolbarSubTriggerRef.current ||
        target === columnsSubTriggerRef.current ||
        target === retentionSubTriggerRef.current)
    ) {
      e.preventDefault();
      e.stopPropagation();
      const sub =
        target === toolbarSubTriggerRef.current
          ? toolbarSubMenuRef.current
          : target === columnsSubTriggerRef.current
            ? columnsSubMenuRef.current
            : retentionSubMenuRef.current;
      if (sub) {
        enterOnOpenRef.current.add(sub);
        showMenuPopover(sub, target);
      }
      return;
    }

    if (e.key === "ArrowRight") {
      e.preventDefault();
      openAdjacentTopMenu(1, false);
      return;
    }

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      openAdjacentTopMenu(-1, false);
      return;
    }

    if (e.key === "Escape" && openTopKey !== null) {
      e.preventDefault();
      e.stopPropagation();
      closeAllMenus(true, false);
      return;
    }

    // On a top-level trigger: ArrowDown / Home / End opens and enters the menu
    const triggerKey = TOP_MENUS.find(
      ({ key }) => triggerRefs.current[key] === target
    )?.key;
    if (
      triggerKey &&
      (e.key === "ArrowDown" || e.key === "Home" || e.key === "End")
    ) {
      e.preventDefault();
      const menu = menuRefs.current[triggerKey];
      const trigger = triggerRefs.current[triggerKey];
      if (menu && trigger) {
        enterOnOpenRef.current.add(menu);
        if (e.key === "End") {
          enterLastOnOpenRef.current.add(menu);
        }
        if (isPopoverOpen(menu)) {
          const group = menu.querySelector<HTMLElement>('[focusgroup~="menu"]');
          const items = group
            ? Array.from(group.querySelectorAll<HTMLButtonElement>("button"))
                .filter((b) => b.closest("[focusgroup]") === group)
                .filter((b) => !b.disabled)
            : [];
          const dest =
            e.key === "End" ? items[items.length - 1] : items[0];
          dest?.focus({ preventScroll: true });
        } else {
          showMenuPopover(menu, trigger);
        }
      }
    }
  };

  const activateCommand = (
    e: React.MouseEvent<HTMLButtonElement>,
    action: () => void
  ) => {
    const fromPointer = e.detail !== 0;
    action();
    closeAllMenus(true, fromPointer);
  };

  const activateCheckbox = (
    e: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>,
    toggleFn: () => void,
    keepSubmenuOpenOnPointer = false
  ) => {
    toggleFn();
    if ("key" in e) {
      if (e.key === " ") {
        return;
      }
      window.setTimeout(() => closeAllMenus(true, false), 140);
      return;
    }
    const fromPointer = e.detail !== 0;
    if (fromPointer && keepSubmenuOpenOnPointer) {
      return;
    }
    if (!fromPointer) {
      // Space on a <button> dispatches synthetic click with detail === 0; Enter also dispatches click.
      // KeyDown handles Enter explicitly below, so keep Space open!
      return;
    }
    window.setTimeout(() => closeAllMenus(true, true), 160);
  };

  const checkboxKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter") {
      window.setTimeout(() => closeAllMenus(true, false), 140);
    }
  };

  const handleItemPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn || btn.disabled) return;
    (
      btn as HTMLElement & {
        focus: (opts?: FocusOptions & { focusVisible?: boolean }) => void;
      }
    ).focus({ preventScroll: true, focusVisible: false });

    // Preview submenu when hovering its trigger, or close sibling submenus when hovering other items
    if (btn === toolbarSubTriggerRef.current && toolbarSubMenuRef.current) {
      hideMenuPopover(columnsSubMenuRef.current);
      hideMenuPopover(retentionSubMenuRef.current);
      showMenuPopover(toolbarSubMenuRef.current, btn);
    } else if (
      btn === columnsSubTriggerRef.current &&
      columnsSubMenuRef.current
    ) {
      hideMenuPopover(toolbarSubMenuRef.current);
      hideMenuPopover(retentionSubMenuRef.current);
      showMenuPopover(columnsSubMenuRef.current, btn);
    } else if (
      btn === retentionSubTriggerRef.current &&
      retentionSubMenuRef.current
    ) {
      hideMenuPopover(toolbarSubMenuRef.current);
      hideMenuPopover(columnsSubMenuRef.current);
      showMenuPopover(retentionSubMenuRef.current, btn);
    } else if (
      !toolbarSubMenuRef.current?.contains(btn) &&
      !columnsSubMenuRef.current?.contains(btn) &&
      !retentionSubMenuRef.current?.contains(btn)
    ) {
      hideMenuPopover(toolbarSubMenuRef.current);
      hideMenuPopover(columnsSubMenuRef.current);
      hideMenuPopover(retentionSubMenuRef.current);
    }
  };

  const menuIds: Record<TopMenuKey, { trigger: string; menu: string }> = {
    file: { trigger: `${baseId}-file-trig`, menu: `${baseId}-file-menu` },
    edit: { trigger: `${baseId}-edit-trig`, menu: `${baseId}-edit-menu` },
    rules: { trigger: `${baseId}-rules-trig`, menu: `${baseId}-rules-menu` },
    view: { trigger: `${baseId}-view-trig`, menu: `${baseId}-view-menu` },
    tools: { trigger: `${baseId}-tools-trig`, menu: `${baseId}-tools-menu` },
    help: { trigger: `${baseId}-help-trig`, menu: `${baseId}-help-menu` },
  };

  const toolbarSubTriggerId = `${baseId}-sub-toolbar-trig`;
  const toolbarSubMenuId = `${baseId}-sub-toolbar-menu`;
  const columnsSubTriggerId = `${baseId}-sub-columns-trig`;
  const columnsSubMenuId = `${baseId}-sub-columns-menu`;
  const retentionSubTriggerId = `${baseId}-sub-retention-trig`;
  const retentionSubMenuId = `${baseId}-sub-retention-menu`;

  const isCustomMenuRetention =
    sessionRetentionLimit !== null &&
    !(SESSION_RETENTION_PRESETS as readonly number[]).includes(
      sessionRetentionLimit
    );

  const renderTopTrigger = (key: TopMenuKey, label: string, idx: number) => {
    const isExpanded = openTopKey === key;
    return (
      <button
        key={key}
        ref={(el) => {
          triggerRefs.current[key] = el;
        }}
        id={menuIds[key].trigger}
        type="button"
        tabIndex={activeTabIdx === idx ? 0 : -1}
        aria-haspopup="menu"
        aria-expanded={isExpanded}
        {...({
          commandfor: menuIds[key].menu,
          command: "toggle-popover",
        } as Record<string, string>)}
        onPointerDown={(e) => {
          pointerPressedRef.current = e.currentTarget;
          e.preventDefault();
        }}
        onPointerEnter={() => {
          if (openTopKey !== null && openTopKey !== key) {
            setActiveTabIdx(idx);
            for (const item of TOP_MENUS) {
              if (item.key !== key) hideMenuPopover(menuRefs.current[item.key]);
            }
            hideMenuPopover(toolbarSubMenuRef.current);
            hideMenuPopover(columnsSubMenuRef.current);
            const trig = triggerRefs.current[key];
            const menu = menuRefs.current[key];
            if (trig && menu) {
              (
                trig as HTMLElement & {
                  focus: (opts?: FocusOptions & { focusVisible?: boolean }) => void;
                }
              ).focus({ preventScroll: true, focusVisible: false });
              showMenuPopover(menu, trig);
              setOpenTopKey(key);
            }
          }
        }}
        onClick={(e) => {
          setActiveTabIdx(idx);
          handleTriggerClickFallback(
            e,
            menuRefs.current[key],
            triggerRefs.current[key]
          );
        }}
        className={`inline-flex h-6 items-center rounded px-2 text-xs transition-colors focus-visible:bg-hover focus-visible:text-fg focus-visible:outline-none ${
          isExpanded
            ? "bg-hover font-medium text-fg"
            : "text-muted hover:bg-hover/70 hover:text-fg"
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="flex h-7 shrink-0 items-center justify-between border-b border-hairline bg-surface px-2.5 text-xs">
      {/* Left: App Brand + Continuous Desktop Menubar */}
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1.5 pr-1 font-mono text-[11px] font-semibold tracking-tight text-fg">
          <span className="inline-block h-2 w-2 rounded-full bg-accent/80" />
          <span>FluxProxy</span>
        </span>

        <div
          ref={menubarRef}
          role="menubar"
          aria-label="Application commands"
          onKeyDown={handleMenubarKeyDown}
          className="flex items-center"
        >
          {/* FILE */}
          {renderTopTrigger("file", "File", 0)}
          <div
            ref={(el) => {
              menuRefs.current.file = el;
            }}
            id={menuIds.file.menu}
            {...({ popover: "auto" } as Record<string, string>)}
            onPointerMove={handleItemPointerMove}
            className="desktop-menu z-50 hidden min-w-64 rounded-lg border border-strong bg-surface text-fg shadow-popover"
          >
            <div
              {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
              aria-labelledby={menuIds.file.trigger}
            >
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={status.running}
                onKeyDown={checkboxKeyDown}
                onClick={(e) => activateCheckbox(e, onToggleProxy)}
              >
                <span>Capture Traffic</span>
                <span className="hint" aria-hidden="true">
                  F12
                </span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={status.systemProxyEnabled}
                onKeyDown={checkboxKeyDown}
                onClick={(e) => activateCheckbox(e, onToggleSystemProxy)}
              >
                <span>Act as OS System Proxy</span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={status.autoSystemProxy}
                onKeyDown={checkboxKeyDown}
                onClick={(e) => activateCheckbox(e, onToggleAutoSystemProxy)}
              >
                <span>Attach System Proxy on Startup</span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={Boolean(
                  status.allowRemote || status.bindAddr === "0.0.0.0"
                )}
                onKeyDown={checkboxKeyDown}
                onClick={(e) => activateCheckbox(e, onToggleAllowRemote)}
              >
                <span>Разрешить подключения с удаленных устройств (0.0.0.0)</span>
              </button>
              <hr />
              <button
                type="button"
                disabled={totalCount === 0}
                onClick={(e) => activateCommand(e, onSaveAllSessionsAs)}
              >
                <span>Save All Sessions As...</span>
                <span className="hint" aria-hidden="true">
                  Ctrl+S
                </span>
              </button>
              <button
                type="button"
                disabled={!hasSelection}
                onClick={(e) => activateCommand(e, onSaveSelectedSessionsAs)}
              >
                <span>
                  Save Selected Sessions...
                  {selectedCount > 1 ? ` (${selectedCount})` : ""}
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onImportArchive)}
              >
                <span>Open / Import Archive...</span>
                <span className="hint" aria-hidden="true">
                  Ctrl+O
                </span>
              </button>
              <hr />
              <button
                type="button"
                onClick={(e) => activateCommand(e, onSaveSqlite)}
              >
                <span>Save Archive to SQLite</span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onLoadSqlite)}
              >
                <span>Restore Archive from SQLite</span>
              </button>
              <hr />
              <button
                type="button"
                onClick={(e) => activateCommand(e, onClearSessions)}
              >
                <span>Clear All Sessions</span>
                <span className="hint" aria-hidden="true">
                  Ctrl+X
                </span>
              </button>
              <hr />
              <button
                type="button"
                onClick={(e) => activateCommand(e, onExportSettingsProfile)}
              >
                <span>Export Settings Profile (JSON)...</span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onImportSettingsProfile)}
              >
                <span>Import Settings Profile...</span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onOpenPreferences)}
              >
                <span>Preferences...</span>
                <span className="hint" aria-hidden="true">
                  Ctrl+,
                </span>
              </button>
            </div>
          </div>

          {/* EDIT */}
          {renderTopTrigger("edit", "Edit", 1)}
          <div
            ref={(el) => {
              menuRefs.current.edit = el;
            }}
            id={menuIds.edit.menu}
            {...({ popover: "auto" } as Record<string, string>)}
            onPointerMove={handleItemPointerMove}
            className="desktop-menu z-50 hidden min-w-64 rounded-lg border border-strong bg-surface text-fg shadow-popover"
          >
            <div
              {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
              aria-labelledby={menuIds.edit.trigger}
            >
              <button
                type="button"
                disabled={!hasSelection}
                onClick={(e) => activateCommand(e, onCopyUrl)}
              >
                <span>Copy URL</span>
                <span className="hint" aria-hidden="true">
                  Ctrl+C
                </span>
              </button>
              <button
                type="button"
                disabled={!hasSelection}
                onClick={(e) => activateCommand(e, onCopyCurl)}
              >
                <span>Copy as cURL</span>
              </button>
              <button
                type="button"
                disabled={!hasSelection}
                onClick={(e) => activateCommand(e, onCopyRequestHeaders)}
              >
                <span>Copy Request Headers</span>
              </button>
              <button
                type="button"
                disabled={!hasSelection}
                onClick={(e) => activateCommand(e, onCopyResponseHeaders)}
              >
                <span>Copy Response Headers</span>
              </button>
              <hr />
              <button
                type="button"
                disabled={!hasSelection}
                onClick={(e) => activateCommand(e, onAnnotateSelected)}
              >
                <span>Comment / Mark Session…</span>
                <span className="hint" aria-hidden="true">
                  M
                </span>
              </button>
              <button
                type="button"
                disabled={!hasSelection}
                onClick={(e) => activateCommand(e, onUnmarkSelected)}
              >
                <span>Unmark Session</span>
                <span className="hint" aria-hidden="true">
                  U
                </span>
              </button>
              <hr />
              <button
                type="button"
                disabled={!hasSelection}
                onClick={(e) => activateCommand(e, onDeleteSelected)}
              >
                <span>
                  Remove Selected{selectedCount > 1 ? ` (${selectedCount})` : ""}
                </span>
                <span className="hint" aria-hidden="true">
                  Del
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onFocusSearch)}
              >
                <span>Quick Find / Filter</span>
                <span className="hint" aria-hidden="true">
                  Ctrl+F
                </span>
              </button>
            </div>
          </div>

          {/* RULES */}
          {renderTopTrigger("rules", "Rules", 2)}
          <div
            ref={(el) => {
              menuRefs.current.rules = el;
            }}
            id={menuIds.rules.menu}
            {...({ popover: "auto" } as Record<string, string>)}
            onPointerMove={handleItemPointerMove}
            className="desktop-menu z-50 hidden min-w-68 rounded-lg border border-strong bg-surface text-fg shadow-popover"
          >
            <div
              {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
              aria-labelledby={menuIds.rules.trigger}
            >
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={breakpointConfig.breakBeforeRequest}
                onKeyDown={checkboxKeyDown}
                onClick={(e) => activateCheckbox(e, onToggleBreakBeforeRequest)}
              >
                <span>Break Before Requests</span>
                <span className="hint" aria-hidden="true">
                  F11
                </span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={breakpointConfig.breakAfterResponse}
                onKeyDown={checkboxKeyDown}
                onClick={(e) => activateCheckbox(e, onToggleBreakAfterResponse)}
              >
                <span>Break After Responses</span>
                <span className="hint" aria-hidden="true">
                  Alt+F11
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onDisableAllBreakpoints)}
              >
                <span>Disable All Breakpoints</span>
                <span className="hint" aria-hidden="true">
                  Shift+F11
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onOpenBreakpointsModal)}
              >
                <span>Breakpoint Rules (bpu / bpafter)…</span>
              </button>
              <hr />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={isForceNoCacheActive}
                onKeyDown={checkboxKeyDown}
                onClick={(e) => activateCheckbox(e, onToggleForceNoCache)}
              >
                <span>Disable Caching (Strip ETag / IMS)</span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={hideConnectTunnels}
                onKeyDown={checkboxKeyDown}
                onClick={(e) => activateCheckbox(e, onToggleHideConnectTunnels)}
              >
                <span>Hide CONNECT / Passthrough Tunnels</span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={tlsInterceptMode === "targetedOnly"}
                onKeyDown={checkboxKeyDown}
                onClick={(e) => activateCheckbox(e, onToggleTlsInterceptMode)}
              >
                <span>
                  Selective MITM: Targeted Allowlist ({targetHostsCount})
                </span>
              </button>
              <hr />
              <button
                type="button"
                onClick={(e) =>
                  activateCommand(e, () => onSelectSection("rules"))
                }
              >
                <span>AutoResponder &amp; Latency Rules…</span>
                <span className="hint" aria-hidden="true">
                  Alt+3
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onOpenFilterDrawer)}
              >
                <span>Filter Matrix &amp; Header Mutations…</span>
                <span className="hint" aria-hidden="true">
                  Alt+4
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onOpenHostsListDrawer)}
              >
                <span>Hosts List (Whitelist / Blacklist)…</span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onOpenTlsModeDrawer)}
              >
                <span>TLS Allowlist &amp; Bypass Domains…</span>
              </button>
            </div>
          </div>

          {/* VIEW */}
          {renderTopTrigger("view", "View", 3)}
          <div
            ref={(el) => {
              menuRefs.current.view = el;
            }}
            id={menuIds.view.menu}
            {...({ popover: "auto" } as Record<string, string>)}
            onPointerMove={handleItemPointerMove}
            className="desktop-menu z-50 hidden min-w-64 rounded-lg border border-strong bg-surface text-fg shadow-popover"
          >
            <div
              {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
              aria-labelledby={menuIds.view.trigger}
            >
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={!sidebarCollapsed}
                onKeyDown={checkboxKeyDown}
                onClick={(e) => activateCheckbox(e, onToggleSidebar)}
              >
                <span>Show Navigation Sidebar</span>
                <span className="hint" aria-hidden="true">
                  Ctrl+B
                </span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={!inspectorCollapsed}
                onKeyDown={checkboxKeyDown}
                onClick={(e) => activateCheckbox(e, onToggleInspector)}
              >
                <span>Show Session Inspector</span>
                <span className="hint" aria-hidden="true">
                  Enter
                </span>
              </button>

              <div role="group" aria-label="Inspector Dock Position">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={
                    !inspectorCollapsed && inspectorPosition === "bottom"
                  }
                  onClick={(e) =>
                    activateCommand(e, () => onSetInspectorPosition("bottom"))
                  }
                >
                  <span>Dock Inspector at Bottom</span>
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={
                    !inspectorCollapsed && inspectorPosition === "right"
                  }
                  onClick={(e) =>
                    activateCommand(e, () => onSetInspectorPosition("right"))
                  }
                >
                  <span>Dock Inspector on Right</span>
                </button>
              </div>

              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={dockedComposer}
                onKeyDown={checkboxKeyDown}
                onClick={(e) => activateCheckbox(e, onToggleDockedComposer)}
              >
                <span>Split Composer Pane</span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={followTail}
                onKeyDown={checkboxKeyDown}
                onClick={(e) => activateCheckbox(e, onToggleFollowTail)}
              >
                <span>Auto-Scroll Stream (Tail)</span>
              </button>

              <hr />

              {/* Submenu: Customize Toolbar */}
              <button
                ref={toolbarSubTriggerRef}
                id={toolbarSubTriggerId}
                type="button"
                aria-haspopup="menu"
                aria-expanded={toolbarSubOpen}
                {...({
                  commandfor: toolbarSubMenuId,
                  command: "toggle-popover",
                } as Record<string, string>)}
                onPointerLeave={(e) =>
                  startSubmenuSafeTriangle(toolbarSubMenuRef.current, e)
                }
                onClick={(e) =>
                  handleTriggerClickFallback(
                    e,
                    toolbarSubMenuRef.current,
                    toolbarSubTriggerRef.current
                  )
                }
              >
                <span>Customize Toolbar</span>
                <span className="hint" aria-hidden="true">
                  ›
                </span>
              </button>
              <div
                ref={toolbarSubMenuRef}
                id={toolbarSubMenuId}
                {...({ popover: "auto" } as Record<string, string>)}
                className="z-50 hidden min-w-60 rounded-lg border border-strong bg-surface text-fg shadow-popover"
              >
                <div
                  {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
                  aria-labelledby={toolbarSubTriggerId}
                >
                  {onToggleCompactToolbar && (
                    <>
                      <button
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={compactToolbar}
                        onKeyDown={checkboxKeyDown}
                        onClick={(e) =>
                          activateCheckbox(e, onToggleCompactToolbar, true)
                        }
                      >
                        <span>Compact Toolbar</span>
                      </button>
                      <hr />
                    </>
                  )}
                  {TOOLBAR_GROUP_DEFINITIONS.map((grp) => (
                    <button
                      key={grp.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={toolbarGroups[grp.id]}
                      onKeyDown={checkboxKeyDown}
                      onClick={(e) =>
                        activateCheckbox(
                          e,
                          () => onToggleToolbarGroup(grp.id),
                          true
                        )
                      }
                    >
                      <span>{grp.label}</span>
                    </button>
                  ))}
                  <hr />
                  <button
                    type="button"
                    onClick={(e) => activateCommand(e, onResetToolbarGroups)}
                  >
                    <span>Reset Default Toolbar</span>
                  </button>
                </div>
              </div>

              {/* Submenu: Session Columns */}
              <button
                ref={columnsSubTriggerRef}
                id={columnsSubTriggerId}
                type="button"
                aria-haspopup="menu"
                aria-expanded={columnsSubOpen}
                {...({
                  commandfor: columnsSubMenuId,
                  command: "toggle-popover",
                } as Record<string, string>)}
                onPointerLeave={(e) =>
                  startSubmenuSafeTriangle(columnsSubMenuRef.current, e)
                }
                onClick={(e) =>
                  handleTriggerClickFallback(
                    e,
                    columnsSubMenuRef.current,
                    columnsSubTriggerRef.current
                  )
                }
              >
                <span>Session Columns</span>
                <span className="hint" aria-hidden="true">
                  ›
                </span>
              </button>
              <div
                ref={columnsSubMenuRef}
                id={columnsSubMenuId}
                {...({ popover: "auto" } as Record<string, string>)}
                className="z-50 hidden min-w-52 rounded-lg border border-strong bg-surface text-fg shadow-popover"
              >
                <div
                  {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
                  aria-labelledby={columnsSubTriggerId}
                >
                  {TRAFFIC_COLUMNS.map((col) => (
                    <button
                      key={col.id}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={visibleColumns[col.id]}
                      onKeyDown={checkboxKeyDown}
                      onClick={(e) =>
                        activateCheckbox(
                          e,
                          () => onToggleColumnVisibility(col.id),
                          true
                        )
                      }
                    >
                      <span>{col.label}</span>
                    </button>
                  ))}
                  <hr />
                  <button
                    type="button"
                    onClick={(e) => activateCommand(e, onResetColumns)}
                  >
                    <span>Reset Columns &amp; Widths</span>
                  </button>
                </div>
              </div>

              <hr />

              <div role="group" aria-label="Workspace Section">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={activeSection === "traffic"}
                  onClick={(e) =>
                    activateCommand(e, () => onSelectSection("traffic"))
                  }
                >
                  <span>Traffic Viewer</span>
                  <span className="hint" aria-hidden="true">
                    Alt+1
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={activeSection === "composer"}
                  onClick={(e) =>
                    activateCommand(e, () => onSelectSection("composer"))
                  }
                >
                  <span>Request Composer</span>
                  <span className="hint" aria-hidden="true">
                    Alt+2
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={activeSection === "rules"}
                  onClick={(e) =>
                    activateCommand(e, () => onSelectSection("rules"))
                  }
                >
                  <span>AutoResponder</span>
                  <span className="hint" aria-hidden="true">
                    Alt+3
                  </span>
                </button>
              </div>

              <hr />

              <div role="group" aria-label="Color Theme">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={themePreference === "dark"}
                  onClick={(e) => activateCommand(e, () => onSetTheme("dark"))}
                >
                  <span>Theme: Dark (Zinc)</span>
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={themePreference === "light"}
                  onClick={(e) => activateCommand(e, () => onSetTheme("light"))}
                >
                  <span>Theme: Light (Zinc)</span>
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={themePreference === "system"}
                  onClick={(e) =>
                    activateCommand(e, () => onSetTheme("system"))
                  }
                >
                  <span>Theme: System</span>
                </button>
              </div>
            </div>
          </div>

          {/* TOOLS */}
          {renderTopTrigger("tools", "Tools", 4)}
          <div
            ref={(el) => {
              menuRefs.current.tools = el;
            }}
            id={menuIds.tools.menu}
            {...({ popover: "auto" } as Record<string, string>)}
            onPointerMove={handleItemPointerMove}
            className="desktop-menu z-50 hidden min-w-64 rounded-lg border border-strong bg-surface text-fg shadow-popover"
          >
            <div
              {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
              aria-labelledby={menuIds.tools.trigger}
            >
              <button
                type="button"
                disabled={!hasSelection}
                onClick={(e) => activateCommand(e, onReplaySelected)}
              >
                <span>Replay Selected Request</span>
                <span className="hint" aria-hidden="true">
                  R
                </span>
              </button>
              <button
                type="button"
                disabled={!hasSelection}
                onClick={(e) => activateCommand(e, onSendSelectedToComposer)}
              >
                <span>Edit in Request Composer</span>
              </button>
              <hr />
              <button
                type="button"
                onClick={(e) => activateCommand(e, onOpenSessionDiff)}
              >
                <span>Session Diff (Compare)…</span>
                <span className="hint" aria-hidden="true">
                  Ctrl+D
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onOpenTextWizard)}
              >
                <span>Text Wizard &amp; JWT Decoder…</span>
                <span className="hint" aria-hidden="true">
                  Ctrl+E
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onOpenHexConverter)}
              >
                <span>Hex ↔ Text Converter…</span>
              </button>
              <button
                type="button"
                disabled={!hasSelection}
                onClick={(e) => activateCommand(e, onInspectInHex)}
              >
                <span>Inspect Session in Hex View</span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onOpenCompressionCodec)}
              >
                <span>Gzip / Brotli / Deflate Codec…</span>
              </button>
              <hr />
              <button
                type="button"
                onClick={(e) => activateCommand(e, onSaveSqlite)}
              >
                <span>Save Sessions to SQLite</span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onLoadSqlite)}
              >
                <span>Load Sessions from SQLite</span>
              </button>

              {/* Submenu: Session Retention Limit... */}
              <button
                ref={retentionSubTriggerRef}
                id={retentionSubTriggerId}
                type="button"
                aria-haspopup="menu"
                aria-expanded={retentionSubOpen}
                {...({
                  commandfor: retentionSubMenuId,
                  command: "toggle-popover",
                } as Record<string, string>)}
                onPointerLeave={(e) =>
                  startSubmenuSafeTriangle(retentionSubMenuRef.current, e)
                }
                onClick={(e) =>
                  handleTriggerClickFallback(
                    e,
                    retentionSubMenuRef.current,
                    retentionSubTriggerRef.current
                  )
                }
              >
                <span>Session Retention Limit...</span>
                <span className="hint" aria-hidden="true">
                  {formatMenuRetentionLabel(sessionRetentionLimit)} ›
                </span>
              </button>
              <div
                ref={retentionSubMenuRef}
                id={retentionSubMenuId}
                {...({ popover: "auto" } as Record<string, string>)}
                className="z-50 hidden min-w-56 rounded-lg border border-strong bg-surface text-fg shadow-popover"
              >
                <div
                  {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
                  aria-labelledby={retentionSubTriggerId}
                >
                  <div role="group" aria-label="Session Retention Limit">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={sessionRetentionLimit === null}
                      onClick={(e) =>
                        activateCommand(e, () =>
                          onSetSessionRetentionLimit(null)
                        )
                      }
                    >
                      <span>Keep: All Sessions</span>
                    </button>
                    {SESSION_RETENTION_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        role="menuitemradio"
                        aria-checked={sessionRetentionLimit === preset}
                        onClick={(e) =>
                          activateCommand(e, () =>
                            onSetSessionRetentionLimit(preset)
                          )
                        }
                      >
                        <span>
                          Keep: {formatMenuRetentionLabel(preset)}
                        </span>
                      </button>
                    ))}
                  </div>
                  <hr />
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isCustomMenuRetention}
                    onClick={(e) =>
                      activateCommand(e, onOpenCustomRetentionLimit)
                    }
                  >
                    <span>Custom...</span>
                    {isCustomMenuRetention && (
                      <span className="hint" aria-hidden="true">
                        {formatMenuRetentionLabel(sessionRetentionLimit)}
                      </span>
                    )}
                  </button>
                  <hr />
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={dropNonMatching}
                    onKeyDown={checkboxKeyDown}
                    onClick={(e) => activateCheckbox(e, onToggleDropNonMatching)}
                  >
                    <span>Drop Non-Matching on Capture</span>
                  </button>
                </div>
              </div>

              <hr />
              <button
                type="button"
                onClick={(e) => activateCommand(e, onOpenMobileSetup)}
              >
                <span>Connect Mobile Device (iOS / Android)…</span>
                <span className="hint" aria-hidden="true">
                  Ctrl+Shift+M
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onOpenCertificates)}
              >
                <span>HTTPS Root CA Certificate…</span>
              </button>
              <hr />
              <button
                type="button"
                onClick={(e) => activateCommand(e, onGenerateStress10k)}
              >
                <span>Generate +10,000 Test Sessions</span>
              </button>
            </div>
          </div>

          {/* HELP */}
          {renderTopTrigger("help", "Help", 5)}
          <div
            ref={(el) => {
              menuRefs.current.help = el;
            }}
            id={menuIds.help.menu}
            {...({ popover: "auto" } as Record<string, string>)}
            onPointerMove={handleItemPointerMove}
            className="desktop-menu z-50 hidden min-w-64 rounded-lg border border-strong bg-surface text-fg shadow-popover"
          >
            <div
              {...({ focusgroup: "menu nomemory" } as Record<string, string>)}
              aria-labelledby={menuIds.help.trigger}
            >
              <button
                type="button"
                onClick={(e) => activateCommand(e, onOpenCommandPalette)}
              >
                <span>Command Palette…</span>
                <span className="hint" aria-hidden="true">
                  Ctrl+K
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onOpenShortcutsModal)}
              >
                <span>Keyboard Shortcuts…</span>
                <span className="hint" aria-hidden="true">
                  ?
                </span>
              </button>
              <hr />
              <button
                type="button"
                onClick={(e) => activateCommand(e, onCopyCliEnv)}
              >
                <span>Copy CLI HTTP_PROXY Snippet</span>
              </button>
              <button
                type="button"
                onClick={(e) => activateCommand(e, onResetAllUiPreferences)}
              >
                <span>Reset Workspace Layout &amp; Columns</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Right: Compact Telemetry & Command Palette Trigger */}
      <div className="flex items-center gap-2 font-mono text-[11px] text-subtle">
        <span className="hidden tabular-nums sm:inline">
          {filteredCount.toLocaleString()} / {totalCount.toLocaleString()} sessions
        </span>
        <span className="hidden text-hairline md:inline">|</span>
        <button
          type="button"
          onClick={onToggleSystemProxy}
          title="Click to toggle OS System Proxy"
          className={`hidden rounded px-1.5 py-0.5 transition-colors hover:bg-hover md:inline-flex ${
            status.systemProxyError
              ? "text-status4xx-fg"
              : status.systemProxyEnabled
                ? "text-status2xx-fg"
                : "text-subtle"
          }`}
        >
          SysProxy:{" "}
          {status.systemProxyError
            ? "WARN"
            : status.systemProxyEnabled
              ? "ON"
              : "OFF"}
        </button>
        <button
          type="button"
          onClick={onOpenCommandPalette}
          title="Open Command Palette (Ctrl+K)"
          className="inline-flex h-5 items-center gap-1 rounded border border-hairline bg-elevated px-1.5 font-sans text-[11px] text-muted transition-colors hover:border-strong hover:text-fg"
        >
          <Command className="h-3 w-3" />
          <span className="hidden lg:inline">Commands</span>
          <kbd className="font-mono text-[10px] text-subtle">Ctrl+K</kbd>
        </button>
      </div>
    </div>
  );
};
