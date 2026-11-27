import React from "react";
import {
  persistAutoResponderStorage,
  persistPythonScriptStorage,
} from "../../hooks/useAutomationSync";
import { useTheme } from "../../hooks/useTheme";
import { proxyBridge } from "../../lib/tauriBridge";
import { useProxyStore } from "../../stores/proxyStore";
import type {
  ActiveNavSection,
  BreakpointAction,
  BreakpointConfig,
  BreakpointResolution,
  ComposedRequest,
  PythonScriptPreset,
} from "../../types/proxy";
import { AutoResponderPanel } from "../AutoResponderPanel";
import type { BreakpointsPanelMode } from "../BreakpointsPanel";
import { ComposerPanel } from "../ComposerPanel";
import type { TextWizardTab } from "../TextWizardPanel";

const BreakpointsPanel = React.lazy(() =>
  import("../BreakpointsPanel").then((m) => ({
    default: m.BreakpointsPanel,
  }))
);
const ScriptingPanel = React.lazy(() =>
  import("../ScriptingPanel").then((m) => ({
    default: m.ScriptingPanel,
  }))
);
const TextWizardPanel = React.lazy(() =>
  import("../TextWizardPanel").then((m) => ({
    default: m.TextWizardPanel,
  }))
);

export interface SecondaryWorkspacesProps {
  activeSection: ActiveNavSection;
  visitedSections: Record<ActiveNavSection, boolean>;
  composerDraft: ComposedRequest | null;
  bpPanelMode: BreakpointsPanelMode;
  selectedBpId: string | null;
  bpRequestSeq: number;
  textWizardTab: TextWizardTab;
  textWizardInput: string | undefined;
  textWizardRequestSeq: number;
  onSetActiveSection: (section: ActiveNavSection) => void;
  onLoadSessionIntoComposer: (id: number) => Promise<void>;
  onSelectSessionId: (id: number) => void;
  onInspectSessionFromComposer: (id: number) => void;
  onOpenCodeGeneratorForComposerDraft: (draft: ComposedRequest) => void;
  onSetAutoResponderEnabled: (enabled: boolean) => Promise<void>;
  onUpdateBreakpointConfig: (next: BreakpointConfig) => Promise<BreakpointConfig>;
  onResolvePausedBreakpoint: (
    resolution: BreakpointResolution
  ) => Promise<boolean>;
  onResumeAllBreakpoints: (action?: BreakpointAction) => Promise<void>;
  onSelectPythonPreset: (preset: PythonScriptPreset) => void;
  onApplyPythonScript: (code: string, enabled: boolean) => Promise<void>;
  onTogglePythonScript: (enabled: boolean) => Promise<void>;
  onRefreshPythonStatus: () => Promise<void>;
  onNotify: (msg: string) => void;
}

const ComposerTabContainer: React.FC<{
  isActive: boolean;
  composerDraft: ComposedRequest | null;
  resolvedTheme: "dark" | "light";
  onLoadSessionIntoComposer: (id: number) => Promise<void>;
  onSelectSessionId: (id: number) => void;
  onBackToTraffic: () => void;
  onInspectSessionFromComposer: (id: number) => void;
  onGenerateCode: (draft: ComposedRequest) => void;
  onNotify: (msg: string) => void;
}> = ({
  isActive,
  composerDraft,
  resolvedTheme,
  onLoadSessionIntoComposer,
  onSelectSessionId,
  onBackToTraffic,
  onInspectSessionFromComposer,
  onGenerateCode,
  onNotify,
}) => {
  const composerTimeoutSec = useProxyStore(
    (s) => s.upstreamTimeouts.composerTimeoutSec
  );

  return (
    <div
      hidden={!isActive}
      className={isActive ? "h-full w-full overflow-hidden" : "hidden"}
    >
      <ComposerPanel
        draftRequest={composerDraft}
        resolvedTheme={resolvedTheme}
        defaultComposerTimeoutSec={composerTimeoutSec}
        onLoadSessionIntoComposer={(id) => void onLoadSessionIntoComposer(id)}
        onSessionCreated={(detail) => onSelectSessionId(detail.summary.id)}
        onBackToTraffic={onBackToTraffic}
        onInspectSessionInTraffic={onInspectSessionFromComposer}
        onGenerateCode={onGenerateCode}
        onNotify={onNotify}
      />
    </div>
  );
};

const AutoResponderTabContainer: React.FC<{
  isActive: boolean;
  resolvedTheme: "dark" | "light";
  onSetAutoResponderEnabled: (enabled: boolean) => Promise<void>;
  onNotify: (msg: string) => void;
}> = ({ isActive, resolvedTheme, onSetAutoResponderEnabled, onNotify }) => {
  const autoResponderEnabled = useProxyStore((s) => s.autoResponderEnabled);
  const rules = useProxyStore((s) => s.rules);
  const setRules = useProxyStore((s) => s.setRules);

  return (
    <div
      hidden={!isActive}
      className={isActive ? "h-full w-full overflow-hidden" : "hidden"}
    >
      <AutoResponderPanel
        enabled={autoResponderEnabled}
        onToggleEnabled={onSetAutoResponderEnabled}
        rules={rules}
        resolvedTheme={resolvedTheme}
        onUpsertRule={async (rule) => {
          const next = await proxyBridge.upsertRule(rule);
          setRules(next);
          persistAutoResponderStorage(autoResponderEnabled, next);
          onNotify(`Saved rule "${rule.name}"`);
        }}
        onDeleteRule={async (id) => {
          const next = await proxyBridge.deleteRule(id);
          setRules(next);
          persistAutoResponderStorage(autoResponderEnabled, next);
          onNotify("Deleted AutoResponder rule");
        }}
        onNotify={onNotify}
      />
    </div>
  );
};

const BreakpointsTabContainer: React.FC<{
  isActive: boolean;
  resolvedTheme: "dark" | "light";
  requestedMode: BreakpointsPanelMode;
  selectedBreakpointId: string | null;
  requestSeq: number;
  onBackToTraffic: () => void;
  onUpdateConfig: (next: BreakpointConfig) => Promise<BreakpointConfig>;
  onResolve: (resolution: BreakpointResolution) => Promise<boolean>;
  onResumeAll: (action?: BreakpointAction) => Promise<void>;
  onNotify: (msg: string) => void;
}> = ({
  isActive,
  resolvedTheme,
  requestedMode,
  selectedBreakpointId,
  requestSeq,
  onBackToTraffic,
  onUpdateConfig,
  onResolve,
  onResumeAll,
  onNotify,
}) => {
  const pausedBreakpoints = useProxyStore((s) => s.pausedBreakpoints);
  const breakpointConfig = useProxyStore((s) => s.breakpointConfig);

  return (
    <div
      hidden={!isActive}
      className={
        isActive ? "flex h-full w-full flex-col overflow-hidden" : "hidden"
      }
    >
      <React.Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center text-xs text-muted">
            Loading Breakpoints...
          </div>
        }
      >
        <BreakpointsPanel
          isActive={isActive}
          requestedMode={requestedMode}
          selectedBreakpointId={selectedBreakpointId}
          requestSeq={requestSeq}
          pausedItems={pausedBreakpoints}
          config={breakpointConfig}
          resolvedTheme={resolvedTheme}
          onBackToTraffic={onBackToTraffic}
          onUpdateConfig={onUpdateConfig}
          onResolve={onResolve}
          onResumeAll={onResumeAll}
          onNotify={onNotify}
        />
      </React.Suspense>
    </div>
  );
};

const ScriptingTabContainer: React.FC<{
  isActive: boolean;
  resolvedTheme: "dark" | "light";
  onSelectPreset: (preset: PythonScriptPreset) => void;
  onApplyScript: (code: string, enabled: boolean) => Promise<void>;
  onToggleEnabled: (enabled: boolean) => Promise<void>;
  onRefreshStatus: () => Promise<void>;
  onNotify: (msg: string) => void;
}> = ({
  isActive,
  resolvedTheme,
  onSelectPreset,
  onApplyScript,
  onToggleEnabled,
  onRefreshStatus,
  onNotify,
}) => {
  const scriptCode = useProxyStore((s) => s.scriptCode);
  const setScriptCode = useProxyStore((s) => s.setScriptCode);
  const scriptEnabled = useProxyStore((s) => s.scriptEnabled);
  const scriptActivePresetId = useProxyStore((s) => s.scriptActivePresetId);
  const pythonRunnerStatus = useProxyStore((s) => s.pythonRunnerStatus);
  const scriptConsoleLogs = useProxyStore((s) => s.scriptConsoleLogs);
  const setScriptConsoleLogs = useProxyStore((s) => s.setScriptConsoleLogs);
  const isApplyingScript = useProxyStore((s) => s.isApplyingScript);

  return (
    <div
      hidden={!isActive}
      className={
        isActive ? "flex h-full w-full flex-col overflow-hidden" : "hidden"
      }
    >
      <React.Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center text-xs text-muted">
            Loading Scripts...
          </div>
        }
      >
        <ScriptingPanel
          code={scriptCode}
          enabled={scriptEnabled}
          activePresetId={scriptActivePresetId}
          status={pythonRunnerStatus}
          logs={scriptConsoleLogs}
          resolvedTheme={resolvedTheme}
          isApplying={isApplyingScript}
          onChangeCode={(nextCode) => {
            setScriptCode(nextCode);
            persistPythonScriptStorage(
              scriptEnabled,
              nextCode,
              scriptActivePresetId
            );
          }}
          onSelectPreset={onSelectPreset}
          onApplyScript={onApplyScript}
          onToggleEnabled={onToggleEnabled}
          onRefreshStatus={onRefreshStatus}
          onClearLogs={() => setScriptConsoleLogs([])}
          onNotify={onNotify}
        />
      </React.Suspense>
    </div>
  );
};

export const SecondaryWorkspaces: React.FC<SecondaryWorkspacesProps> = ({
  activeSection,
  visitedSections,
  composerDraft,
  bpPanelMode,
  selectedBpId,
  bpRequestSeq,
  textWizardTab,
  textWizardInput,
  textWizardRequestSeq,
  onSetActiveSection,
  onLoadSessionIntoComposer,
  onSelectSessionId,
  onInspectSessionFromComposer,
  onOpenCodeGeneratorForComposerDraft,
  onSetAutoResponderEnabled,
  onUpdateBreakpointConfig,
  onResolvePausedBreakpoint,
  onResumeAllBreakpoints,
  onSelectPythonPreset,
  onApplyPythonScript,
  onTogglePythonScript,
  onRefreshPythonStatus,
  onNotify,
}) => {
  const { resolvedTheme } = useTheme();
  const handleBackToTraffic = React.useCallback(
    () => onSetActiveSection("traffic"),
    [onSetActiveSection]
  );

  return (
    <>
      {visitedSections.composer && (
        <ComposerTabContainer
          isActive={activeSection === "composer"}
          composerDraft={composerDraft}
          resolvedTheme={resolvedTheme}
          onLoadSessionIntoComposer={onLoadSessionIntoComposer}
          onSelectSessionId={onSelectSessionId}
          onBackToTraffic={handleBackToTraffic}
          onInspectSessionFromComposer={onInspectSessionFromComposer}
          onGenerateCode={onOpenCodeGeneratorForComposerDraft}
          onNotify={onNotify}
        />
      )}

      {visitedSections.rules && (
        <AutoResponderTabContainer
          isActive={activeSection === "rules"}
          resolvedTheme={resolvedTheme}
          onSetAutoResponderEnabled={onSetAutoResponderEnabled}
          onNotify={onNotify}
        />
      )}

      {visitedSections.breakpoints && (
        <BreakpointsTabContainer
          isActive={activeSection === "breakpoints"}
          resolvedTheme={resolvedTheme}
          requestedMode={bpPanelMode}
          selectedBreakpointId={selectedBpId}
          requestSeq={bpRequestSeq}
          onBackToTraffic={handleBackToTraffic}
          onUpdateConfig={onUpdateBreakpointConfig}
          onResolve={onResolvePausedBreakpoint}
          onResumeAll={onResumeAllBreakpoints}
          onNotify={onNotify}
        />
      )}

      {visitedSections.scripts && (
        <ScriptingTabContainer
          isActive={activeSection === "scripts"}
          resolvedTheme={resolvedTheme}
          onSelectPreset={onSelectPythonPreset}
          onApplyScript={onApplyPythonScript}
          onToggleEnabled={onTogglePythonScript}
          onRefreshStatus={onRefreshPythonStatus}
          onNotify={onNotify}
        />
      )}

      {visitedSections.wizard && (
        <div
          hidden={activeSection !== "wizard"}
          className={
            activeSection === "wizard"
              ? "flex h-full w-full flex-col overflow-hidden"
              : "hidden"
          }
        >
          <React.Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center text-xs text-muted">
                Loading TextWizard...
              </div>
            }
          >
            <TextWizardPanel
              isActive={activeSection === "wizard"}
              requestedTab={textWizardTab}
              requestedInput={textWizardInput}
              requestSeq={textWizardRequestSeq}
              onBackToTraffic={handleBackToTraffic}
              onNotify={onNotify}
            />
          </React.Suspense>
        </div>
      )}
    </>
  );
};
