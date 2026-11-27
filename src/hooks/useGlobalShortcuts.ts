import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ActiveNavSection, SessionSummary } from "../types/proxy";
import type { SettingsModalSubTab, SettingsModalTab } from "../types/settings";

export interface UseGlobalShortcutsOptions {
  activeSection: ActiveNavSection;
  setActiveSection: (
    updater: ActiveNavSection | ((prev: ActiveNavSection) => ActiveNavSection)
  ) => void;
  sanitizedExportModalOpen: boolean;
  setSanitizedExportModalOpen: Dispatch<SetStateAction<boolean>>;
  settingsModalOpen: boolean;
  onToggleSettingsMain: () => void;
  onToggleSettingsAt: (
    tab: SettingsModalTab,
    subTab?: SettingsModalSubTab
  ) => void;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setShortcutsModalOpen: Dispatch<SetStateAction<boolean>>;
  selectedId: number | null;
  effectiveSelectedIds: number[];
  filteredSessions?: SessionSummary[];
  getFilteredSessions?: () => SessionSummary[];
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
  openInComposer: (sessionId: number) => Promise<void> | void;
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
    sanitizedExportModalOpen,
    setSanitizedExportModalOpen,
    settingsModalOpen,
    onToggleSettingsMain,
    onToggleSettingsAt,
    setPaletteOpen,
    setShortcutsModalOpen,
    selectedId,
    effectiveSelectedIds,
    filteredSessions,
    getFilteredSessions,
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
    openInComposer,
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

    const hasBlockingModal = (): boolean =>
      Boolean(
        document.querySelector(
          'dialog[open]:not([data-settings-hub-dialog="true"])'
        )
      );

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

      // Ctrl+, / Cmd+, -> Unified Settings Hub
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "," || e.code === "Comma")
      ) {
        e.preventDefault();
        if (!hasBlockingModal() || settingsModalOpen) {
          onToggleSettingsMain();
        }
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

      // Ctrl+E / Cmd+E -> TextWizard tab (toggles back to Traffic if already active)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "e" || e.code === "KeyE") &&
        !hasOpenModal()
      ) {
        e.preventDefault();
        setActiveSection((prev) => (prev === "wizard" ? "traffic" : "wizard"));
        return;
      }

      // Ctrl+Shift+M / Cmd+Shift+M -> Settings Hub -> Mobile Setup
      if (
        ctrlOrMeta &&
        !e.altKey &&
        e.shiftKey &&
        (keyLower === "m" || e.code === "KeyM")
      ) {
        e.preventDefault();
        if (!hasBlockingModal()) {
          onToggleSettingsAt("tlsCertificates", "mobileSetup");
        }
        return;
      }

      // Ctrl+Shift+C / Cmd+Shift+C -> Settings Hub -> Client Certificates (mTLS)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        e.shiftKey &&
        (keyLower === "c" || e.code === "KeyC")
      ) {
        e.preventDefault();
        if (!hasBlockingModal()) {
          onToggleSettingsAt("tlsCertificates", "clientCerts");
        }
        return;
      }

      // Ctrl+Shift+H / Cmd+Shift+H -> Settings Hub -> HOSTS Remapping
      if (
        ctrlOrMeta &&
        !e.altKey &&
        e.shiftKey &&
        (keyLower === "h" || e.code === "KeyH")
      ) {
        e.preventDefault();
        if (!hasBlockingModal()) {
          onToggleSettingsAt("networkRouting", "hostsRemap");
        }
        return;
      }

      // Ctrl+Shift+U / Cmd+Shift+U -> Settings Hub -> Upstream Proxy Chaining
      if (
        ctrlOrMeta &&
        !e.altKey &&
        e.shiftKey &&
        (keyLower === "u" || e.code === "KeyU")
      ) {
        e.preventDefault();
        if (!hasBlockingModal()) {
          onToggleSettingsAt("networkRouting", "upstreamProxy");
        }
        return;
      }

      // Ctrl+Shift+D / Cmd+Shift+D -> Settings Hub -> Proxy Doctor
      if (
        ctrlOrMeta &&
        !e.altKey &&
        e.shiftKey &&
        (keyLower === "d" || e.code === "KeyD")
      ) {
        e.preventDefault();
        if (!hasBlockingModal()) {
          onToggleSettingsAt("diagnosticsBackup", "proxyDoctor");
        }
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
          const currentFiltered = getFilteredSessions
            ? getFilteredSessions()
            : (filteredSessions ?? []);
          const ids =
            sortedSessionsRef.current.length === currentFiltered.length
              ? sortedSessionsRef.current.map((s) => s.id)
              : currentFiltered.map((s) => s.id);
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

      // Ctrl+D / Cmd+D -> Session Diff tab (toggles back to Traffic if already active)
      if (
        ctrlOrMeta &&
        !e.altKey &&
        !e.shiftKey &&
        (keyLower === "d" || e.code === "KeyD") &&
        !hasOpenModal() &&
        !(
          e.target instanceof HTMLElement &&
          e.target.closest(".monaco-editor") &&
          activeSection !== "diff"
        )
      ) {
        e.preventDefault();
        if (activeSection === "diff") {
          setActiveSection("traffic");
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

      // Alt+1..6 -> Primary workspace views & Settings -> Filters
      if (e.altKey && !ctrlOrMeta && !e.shiftKey) {
        if (e.key === "1") {
          e.preventDefault();
          if (!hasOpenModal()) setActiveSection("traffic");
          return;
        }
        if (e.key === "2") {
          e.preventDefault();
          if (!hasOpenModal()) setActiveSection("composer");
          return;
        }
        if (e.key === "3") {
          e.preventDefault();
          if (!hasOpenModal()) setActiveSection("rules");
          return;
        }
        if (e.key === "4") {
          e.preventDefault();
          if (!hasBlockingModal()) {
            onToggleSettingsAt("filters", "matrix");
          }
          return;
        }
        if (e.key === "5") {
          e.preventDefault();
          if (!hasOpenModal()) setActiveSection("scripts");
          return;
        }
        if (e.key === "6") {
          e.preventDefault();
          if (!hasOpenModal()) setActiveSection("breakpoints");
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

        if (!e.shiftKey && (keyLower === "e" || e.code === "KeyE")) {
          const targetId = selectedId ?? effectiveSelectedIds[0] ?? null;
          if (targetId !== null) {
            e.preventDefault();
            void openInComposer(targetId);
          }
          return;
        }

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
    copyUrlsForIds,
    deleteSessions,
    disableAllBreakpoints,
    effectiveSelectedIds,
    exportAllSessionsAs,
    filteredSessions,
    getFilteredSessions,
    handleFocusSearch,
    importArchiveDialog,
    onToggleSettingsAt,
    onToggleSettingsMain,
    openAnnotationFor,
    openDiffWithPairSmart,
    openInComposer,
    openSanitizedExportModal,
    replaySessions,
    sanitizedExportModalOpen,
    selectSessions,
    selectedId,
    setActiveSection,
    setPaletteOpen,
    setShortcutsModalOpen,
    settingsModalOpen,
    sortedSessionsRef,
    toggleBreakAfterResponse,
    toggleBreakBeforeRequest,
    toggleCompactToolbar,
    toggleProxy,
    toggleSidebar,
    unmarkSessions,
  ]);
}
