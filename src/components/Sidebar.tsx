import React, { useState } from "react";
import {
  Activity,
  FileCode2,
  GitCompareArrows,
  OctagonPause,
  PanelLeftClose,
  Send,
  Settings,
  Sliders,
  Wand2,
} from "lucide-react";
import type { ActiveNavSection } from "../types/proxy";

interface SidebarProps {
  activeSection: ActiveNavSection;
  onSelectSection: (section: ActiveNavSection) => void;
  onDropSessionToComposer: (sessionId: number) => void;
  onOpenBreakpoints: () => void;
  breakpointsArmed: boolean;
  pausedBreakpointCount: number;
  onOpenSessionDiff: () => void;
  diffActive?: boolean;
  onOpenTextWizard: () => void;
  activeRulesCount: number;
  pythonScriptEnabled?: boolean;
  onOpenSettings: () => void;
  settingsOpen?: boolean;
  onCollapseSidebar?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSelectSection,
  onDropSessionToComposer,
  onOpenBreakpoints,
  breakpointsArmed,
  pausedBreakpointCount,
  onOpenSessionDiff,
  diffActive,
  onOpenTextWizard,
  activeRulesCount,
  pythonScriptEnabled = false,
  onOpenSettings,
  settingsOpen = false,
  onCollapseSidebar,
}) => {
  const [composerDragOver, setComposerDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-fluxproxy-session-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setComposerDragOver(true);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setComposerDragOver(false);
    const rawId = e.dataTransfer.getData("application/x-fluxproxy-session-id");
    const parsed = Number(rawId);
    if (!Number.isNaN(parsed) && parsed > 0) {
      onDropSessionToComposer(parsed);
    }
  };

  return (
    <aside
      aria-label="Primary Navigation"
      className="flex h-full w-11 shrink-0 flex-col items-center justify-between border-r border-hairline bg-surface py-2"
    >
      <div className="flex flex-col items-center gap-1">
        {/* Brand Monogram */}
        <div
          title="FluxProxy MITM Engine"
          className="mb-1.5 flex h-7 w-7 items-center justify-center rounded-md bg-elevated text-accent ring-1 ring-hairline"
        >
          <span className="font-mono text-[11px] font-bold tracking-tighter">
            FX
          </span>
        </div>

        {/* Traffic Stream */}
        <button
          type="button"
          onClick={() => onSelectSection("traffic")}
          title="Traffic Viewer & Session Inspector (Alt+1)"
          className={`group relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            activeSection === "traffic"
              ? "bg-elevated text-accent ring-1 ring-strong"
              : "text-muted hover:bg-hover hover:text-fg"
          }`}
        >
          <Activity className="h-4 w-4" />
        </button>

        {/* Composer (also acts as Drag-and-Drop target from Traffic Viewer) */}
        <button
          type="button"
          onClick={() => onSelectSection("composer")}
          onDragOver={handleDragOver}
          onDragLeave={() => setComposerDragOver(false)}
          onDrop={handleDrop}
          title="API Composer — Click or Drag & Drop any session here (Alt+2)"
          className={`group relative flex h-8 w-8 items-center justify-center rounded-md transition-all ${
            composerDragOver
              ? "scale-105 bg-status3xx-bg text-status3xx-fg ring-1 ring-status3xx-fg/60"
              : activeSection === "composer"
                ? "bg-elevated text-accent ring-1 ring-strong"
                : "text-muted hover:bg-hover hover:text-fg"
          }`}
        >
          <Send className="h-4 w-4" />
        </button>

        {/* AutoResponder / Rule Engine */}
        <button
          type="button"
          onClick={() => onSelectSection("rules")}
          title="AutoResponder & Latency Rules (Alt+3)"
          className={`group relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            activeSection === "rules"
              ? "bg-elevated text-accent ring-1 ring-strong"
              : "text-muted hover:bg-hover hover:text-fg"
          }`}
        >
          <Sliders className="h-4 w-4" />
          {activeRulesCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-status4xx-bg px-1 font-mono text-[9px] font-bold text-status4xx-fg ring-1 ring-status4xx-fg/40">
              {activeRulesCount}
            </span>
          )}
        </button>

        {/* Live Breakpoints (Before Request F11 / After Response Alt+F11 / Alt+6) */}
        <button
          type="button"
          onClick={onOpenBreakpoints}
          aria-label="Breakpoints"
          title="Breakpoints — Live Intercept (F11 / Alt+6)"
          className={`group relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            pausedBreakpointCount > 0
              ? "animate-pulse bg-status5xx-bg text-status5xx-fg ring-1 ring-status5xx-fg/50"
              : breakpointsArmed
                ? "bg-status4xx-bg text-status4xx-fg ring-1 ring-status4xx-fg/40"
                : "text-muted hover:bg-hover hover:text-fg"
          }`}
        >
          <OctagonPause className="h-4 w-4" aria-hidden="true" />
          {pausedBreakpointCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-status5xx-bg px-1 font-mono text-[9px] font-bold text-status5xx-fg ring-1 ring-status5xx-fg/50">
              {pausedBreakpointCount}
            </span>
          )}
        </button>

        {/* Python Scripting Engine (on_request / on_response) */}
        <button
          type="button"
          onClick={() => onSelectSection("scripts")}
          aria-label="Scripts"
          title="Scripts — Python on_request / on_response (Alt+5)"
          className={`group relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            activeSection === "scripts"
              ? "bg-elevated text-accent ring-1 ring-strong"
              : "text-muted hover:bg-hover hover:text-fg"
          }`}
        >
          <FileCode2 className="h-4 w-4" aria-hidden="true" />
          {pythonScriptEnabled && (
            <span
              aria-hidden="true"
              className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-status2xx-fg"
            />
          )}
        </button>

        {/* Session Diff (Monaco DiffEditor) */}
        <button
          type="button"
          onClick={onOpenSessionDiff}
          aria-label="Session Diff"
          title="Session Diff — Compare Sessions (Ctrl+D)"
          className={`group relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            diffActive
              ? "bg-elevated text-accent ring-1 ring-strong"
              : "text-muted hover:bg-hover hover:text-accent"
          }`}
        >
          <GitCompareArrows className="h-4 w-4" aria-hidden="true" />
        </button>

        {/* TextWizard & JWT Decoder */}
        <button
          type="button"
          onClick={onOpenTextWizard}
          aria-label="TextWizard"
          title="TextWizard — JWT & Codec Tools (Ctrl+E)"
          className="group relative flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-accent"
        >
          <Wand2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="flex flex-col items-center gap-1">
        {/* Unified Fullscreen Settings Hub */}
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings (Ctrl+,)"
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            settingsOpen
              ? "bg-elevated text-accent ring-1 ring-strong"
              : "text-muted hover:bg-hover hover:text-fg"
          }`}
        >
          <Settings className="h-4 w-4" aria-hidden="true" />
        </button>

        {/* Collapse Sidebar */}
        {onCollapseSidebar && (
          <button
            type="button"
            onClick={onCollapseSidebar}
            aria-label="Hide Sidebar"
            title="Hide Sidebar (Ctrl+B)"
            className="flex h-8 w-8 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </aside>
  );
};
