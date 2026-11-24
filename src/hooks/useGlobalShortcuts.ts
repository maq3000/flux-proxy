import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ActiveNavSection, SessionSummary } from "../types/proxy";

export interface UseGlobalShortcutsOptions {
  activeSection: ActiveNavSection;
  setActiveSection: (
    updater: ActiveNavSection | ((prev: ActiveNavSection) => ActiveNavSection)
  ) => void;
  clientCertsModalOpen: boolean;
  setClientCertsModalOpen: Dispatch<SetStateAction<boolean>>;
  diffModalOpen: boolean;
  setDiffModalOpen: Dispatch<SetStateAction<boolean>>;
  hostRemapModalOpen: boolean;
  setHostRemapModalOpen: Dispatch<SetStateAction<boolean>>;
  sanitizedExportModalOpen: boolean;
  setSanitizedExportModalOpen: Dispatch<SetStateAction<boolean>>;
  upstreamProxyModalOpen: boolean;
  setUpstreamProxyModalOpen: Dispatch<SetStateAction<boolean>>;
  setFilterDrawerOpen: Dispatch<SetStateAction<boolean>>;
  setMobileModalOpen: Dispatch<SetStateAction<boolean>>;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setProxyDoctorModalOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsModalOpen: Dispatch<SetStateAction<boolean>>;
  setShortcutsModalOpen: Dispatch<SetStateAction<boolean>>;
  setTextWizardOpen: Dispatch<SetStateAction<boolean>>;
  effectiveSelectedIds: number[];
  filteredSessions: SessionSummary[];
  sortedSessionsRef: MutableRefObject<SessionSummary[]>;
  clearAllSessions: () => Promise<void> | void;
  copyUrlsForIds: (ids: number[]) => void;
  deleteSessions: (ids: number[]) => Promise<void> | void;
  disableAllBreakpoints: () => Promise<void> | void;
  exportAllSessionsAs: () => Promise<void> | void;
  handleFocusSearch: () => void;
  importArchiveDialog: () => Promise<void> | void;
  openAnnotationFor: (ids: number[]) => void;
  openDiffWithPairSmart: () => void;
  openSanitizedExportModal: () => void;
  replaySessions: (ids: number[]) => Promise<void> | void;
  selectSessions: (ids: number[]) => void;
  toggleBreakAfterResponse: () => Promise<void> | void;
  toggleBreakBeforeRequest: () => Promise<void> | void;
  toggleCompactToolbar: () => void;
  toggleProxy: () => Promise<void> | void;
  toggleSidebar: () => void;
  unmarkSessions: (ids: number[]) => Promise<void> | void;
}

/**
 * Registers FluxProxy's global keyboard shortcuts without conflicting with
 * text inputs, Monaco editors, native modals (`<dialog open>`), or popovers.
 */
export function useGlobalShortcuts(options: UseGlobalShortcutsOptions): void {
  const {
    activeSection,
    setActiveSection,
    clientCertsModalOpen,
    setClientCertsModalOpen,
    diffModalOpen,
    setDiffModalOpen,
    hostRemapModalOpen,
    setHostRemapModalOpen,
    sanitizedExportModalOpen,
    setSanitizedExportModalOpen,
    upstreamProxyModalOpen,
    setUpstreamProxyModalOpen,
    setFilterDrawerOpen,
    setMobileModalOpen,
    setPaletteOpen,
    setProxyDoctorModalOpen,
    setSettingsModalOpen,
    setShortcutsModalOpen,
    setTextWizardOpen,
    effectiveSelectedIds,
    filteredSessions,
    sortedSessionsRef,
    clearAllSessions,
    copyUrlsForIds,
    deleteSessions,
    disableAllBreakpoints,
    exportAllSessionsAs,
    handleFocusSearch,
    importArchiveDialog,
    openAnnotationFor,
    openDiffWithPairSmart,
    openSanitizedExportModal,
    replaySessions,
    selectSessions,
    toggleBreakAfterResponse,
    toggleBreakBeforeRequest,
    toggleCompactToolbar,
    toggleProxy,
    toggleSidebar,
    unmarkSessions,
  } = options;

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return true;
      }
      if (target.isContentEditable) return true;
      if (target.closest("[contenteditable]")) return true;
      if (target.closest(".monaco-editor")) return true;
      return false;
    };

    const hasOpenModal = (): boolean =>
      Boolean(document.querySelector("dialog[open]"));

    const isInsidePopover = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement && Boolean(target.closest("[popover]"));

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      const keyLower = e.key.toLowerCase();
      const ctrlOrMeta = e.ctrlKey || e.metaKey;

      // F12 -> Toggle proxy capture
      if (
        e.key === "F12" &&
        !ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        void toggleProxy();
        return;
      }

      // F11 / Alt+F11 / Shift+F11 -> Live Breakpoints
      if (e.key === "F11" && !ctrlOrMeta) {
        e.preventDefault();
        if (e.shiftKey) {
          void disableAllBreakpoints();
        } else if (e.altKey) {
          void toggleBreakAfterResponse();
        } else {
          void toggleBreakBeforeRequest();
        }
        return;
      }

      // Ctrl+K / Cmd+K -> Command Palette
      if (ctrlOrMeta && !e.altKey && !e.shiftKey && keyLower === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
        return;
      }

      // Ctrl+, / Cmd+, -> Preferences & Settings Profile Modal
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "," || e.code === "Comma")
      ) {
        e.preventDefault();
        setSettingsModalOpen((prev) => !prev);
        return;
      }

      // Ctrl+Shift+S / Cmd+Shift+S -> Export Sanitized Sessions...
      if (
        ctrlOrMeta &&
        !e.altKey &&
        e.shiftKey &&
        (keyLower === "s" || e.code === "KeyS")
      ) {
        e.preventDefault();
        if (sanitizedExportModalOpen) {
          setSanitizedExportModalOpen(false);
        } else if (!hasOpenModal()) {
          openSanitizedExportModal();
        }
        return;
      }

      // Ctrl+S / Cmd+S -> Save All Sessions As... (.har, .saz, .json)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "s" || e.code === "KeyS") &&
        !hasOpenModal()
      ) {
        const inMonaco =
          e.target instanceof HTMLElement &&
          Boolean(e.target.closest(".monaco-editor"));
        if (inMonaco && activeSection === "scripts") {
          return;
        }
        e.preventDefault();
        void exportAllSessionsAs();
        return;
      }

      // Ctrl+O / Cmd+O -> Open / Import Archive... (.har, .saz, .json)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "o" || e.code === "KeyO") &&
        !hasOpenModal()
      ) {
        e.preventDefault();
        void importArchiveDialog();
        return;
      }

      // Ctrl+F / Cmd+F -> Focus Quick Filter bar (unless inside Monaco Editor or an open modal)
      if (ctrlOrMeta && !e.altKey && !e.shiftKey && keyLower === "f") {
        const inMonaco =
          e.target instanceof HTMLElement &&
          Boolean(e.target.closest(".monaco-editor"));
        if (!inMonaco && !hasOpenModal()) {
          e.preventDefault();
          handleFocusSearch();
        }
        return;
      }

      // Ctrl+E / Cmd+E -> TextWizard
      if (ctrlOrMeta && !e.altKey && !e.shiftKey && keyLower === "e") {
        e.preventDefault();
        setTextWizardOpen((prev) => !prev);
        return;
      }

      // Ctrl+Shift+M / Cmd+Shift+M -> Connect Mobile Device (iOS & Android Wi-Fi Proxy + QR Code)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        e.shiftKey &&
        (keyLower === "m" || e.code === "KeyM")
      ) {
        e.preventDefault();
        setMobileModalOpen((prev) => !prev);
        return;
      }

      // Ctrl+Shift+C / Cmd+Shift+C -> Client Certificates (mTLS)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        e.shiftKey &&
        (keyLower === "c" || e.code === "KeyC")
      ) {
        e.preventDefault();
        if (clientCertsModalOpen) {
          setClientCertsModalOpen(false);
        } else if (!hasOpenModal()) {
          setClientCertsModalOpen(true);
        }
        return;
      }

      // Ctrl+Shift+H / Cmd+Shift+H -> Virtual DNS (HOSTS Remapping…)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        e.shiftKey &&
        (keyLower === "h" || e.code === "KeyH")
      ) {
        e.preventDefault();
        if (hostRemapModalOpen) {
          setHostRemapModalOpen(false);
        } else if (!hasOpenModal()) {
          setHostRemapModalOpen(true);
        }
        return;
      }

      // Ctrl+Shift+U / Cmd+Shift+U -> Upstream Proxy Chaining…
      if (
        ctrlOrMeta &&
        !e.altKey &&
        e.shiftKey &&
        (keyLower === "u" || e.code === "KeyU")
      ) {
        e.preventDefault();
        if (upstreamProxyModalOpen) {
          setUpstreamProxyModalOpen(false);
        } else if (!hasOpenModal()) {
          setUpstreamProxyModalOpen(true);
        }
        return;
      }

      // Ctrl+Shift+D / Cmd+Shift+D -> Run Proxy Doctor
      if (
        ctrlOrMeta &&
        !e.altKey &&
        e.shiftKey &&
        (keyLower === "d" || e.code === "KeyD")
      ) {
        e.preventDefault();
        setProxyDoctorModalOpen((prev) => !prev);
        return;
      }

      // Ctrl+Shift+T / Cmd+Shift+T -> Toggle Slim / Compact Toolbar
      if (
        ctrlOrMeta &&
        !e.altKey &&
        e.shiftKey &&
        (keyLower === "t" || e.code === "KeyT")
      ) {
        e.preventDefault();
        toggleCompactToolbar();
        return;
      }

      // Ctrl+A / Cmd+A -> Select all visible sessions
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "a" || e.code === "KeyA") &&
        !isEditableTarget(e.target) &&
        !hasOpenModal()
      ) {
        if (activeSection === "traffic") {
          e.preventDefault();
          const ids =
            sortedSessionsRef.current.length === filteredSessions.length
              ? sortedSessionsRef.current.map((s) => s.id)
              : filteredSessions.map((s) => s.id);
          if (ids.length > 0) {
            selectSessions(ids);
          }
        }
        return;
      }

      // Ctrl+B / Cmd+B -> Toggle Sidebar
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        keyLower === "b" &&
        !isEditableTarget(e.target) &&
        !hasOpenModal()
      ) {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Ctrl+D / Cmd+D -> Session Diff
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "d" || e.code === "KeyD") &&
        !(
          e.target instanceof HTMLElement &&
          e.target.closest(".monaco-editor") &&
          !diffModalOpen
        )
      ) {
        e.preventDefault();
        if (diffModalOpen) {
          setDiffModalOpen(false);
        } else {
          openDiffWithPairSmart();
        }
        return;
      }

      // Ctrl+X / Cmd+X -> Clear all sessions (strictly outside text inputs so Cut works normally)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "x" || e.code === "KeyX") &&
        !isEditableTarget(e.target) &&
        !hasOpenModal()
      ) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) {
          return;
        }
        e.preventDefault();
        void clearAllSessions();
        return;
      }

      // Ctrl+R / Cmd+R -> Replay selected request(s) to upstream (prevent accidental WebView reload)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "r" || e.code === "KeyR")
      ) {
        e.preventDefault();
        if (
          !isEditableTarget(e.target) &&
          !hasOpenModal() &&
          effectiveSelectedIds.length > 0
        ) {
          void replaySessions(effectiveSelectedIds);
        }
        return;
      }

      // Ctrl+C / Cmd+C -> Copy selected session URL(s) when no DOM text selection is active
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "c" || e.code === "KeyC") &&
        !isEditableTarget(e.target) &&
        !hasOpenModal()
      ) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) {
          return;
        }
        if (effectiveSelectedIds.length > 0) {
          e.preventDefault();
          copyUrlsForIds(effectiveSelectedIds);
        }
        return;
      }

      // Alt+1..5 -> Primary views
      if (e.altKey && !ctrlOrMeta && !e.shiftKey) {
        if (e.key === "1") {
          e.preventDefault();
          setActiveSection("traffic");
          return;
        }
        if (e.key === "2") {
          e.preventDefault();
          setActiveSection("composer");
          return;
        }
        if (e.key === "3") {
          e.preventDefault();
          setActiveSection("rules");
          return;
        }
        if (e.key === "4") {
          e.preventDefault();
          setFilterDrawerOpen((prev) => !prev);
          return;
        }
        if (e.key === "5") {
          e.preventDefault();
          setActiveSection("scripts");
          return;
        }
      }

      // Single-key shortcuts (only when outside inputs, modals, and open popovers)
      if (
        !ctrlOrMeta &&
        !e.altKey &&
        !isEditableTarget(e.target) &&
        !hasOpenModal() &&
        !isInsidePopover(e.target)
      ) {
        if (e.key === "?") {
          e.preventDefault();
          setShortcutsModalOpen((prev) => !prev);
          return;
        }

        if (activeSection !== "traffic") return;

        if (keyLower === "m" || e.code === "KeyM") {
          e.preventDefault();
          openAnnotationFor(effectiveSelectedIds);
          return;
        }

        if (
          (keyLower === "u" || e.code === "KeyU") &&
          effectiveSelectedIds.length > 0
        ) {
          e.preventDefault();
          void unmarkSessions(effectiveSelectedIds);
          return;
        }

        if (
          (keyLower === "r" || e.code === "KeyR") &&
          !e.shiftKey &&
          effectiveSelectedIds.length > 0
        ) {
          e.preventDefault();
          void replaySessions(effectiveSelectedIds);
          return;
        }

        if (
          (e.key === "Delete" || e.key === "Backspace") &&
          effectiveSelectedIds.length > 0 &&
          !(e.target instanceof HTMLElement && e.target.closest("button"))
        ) {
          e.preventDefault();
          void deleteSessions(effectiveSelectedIds);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeSection,
    clearAllSessions,
    clientCertsModalOpen,
    copyUrlsForIds,
    deleteSessions,
    diffModalOpen,
    disableAllBreakpoints,
    effectiveSelectedIds,
    exportAllSessionsAs,
    filteredSessions,
    handleFocusSearch,
    hostRemapModalOpen,
    importArchiveDialog,
    openAnnotationFor,
    openDiffWithPairSmart,
    openSanitizedExportModal,
    replaySessions,
    sanitizedExportModalOpen,
    selectSessions,
    setActiveSection,
    setClientCertsModalOpen,
    setDiffModalOpen,
    setFilterDrawerOpen,
    setHostRemapModalOpen,
    setMobileModalOpen,
    setPaletteOpen,
    setProxyDoctorModalOpen,
    setSettingsModalOpen,
    setShortcutsModalOpen,
    setTextWizardOpen,
    setUpstreamProxyModalOpen,
    sortedSessionsRef,
    toggleBreakAfterResponse,
    toggleBreakBeforeRequest,
    toggleCompactToolbar,
    toggleProxy,
    toggleSidebar,
    unmarkSessions,
    upstreamProxyModalOpen,
  ]);
}
