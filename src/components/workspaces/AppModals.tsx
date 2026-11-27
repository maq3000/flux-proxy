import React, { useEffect, useMemo, useRef, useState } from "react";
import { Database, Trash2, X } from "lucide-react";
import { useFilteredSessions } from "../../hooks/useProxySessions";
import { useTheme } from "../../hooks/useTheme";
import { useUiPreferences } from "../../hooks/useUiPreferences";
import type { CodeGenRequest } from "../../lib/codeGenerators";
import { computeDetectedProcesses } from "../../lib/trafficFilter";
import { useFilterStore } from "../../stores/filterStore";
import { findSessionById, useProxyStore } from "../../stores/proxyStore";
import type {
  ActiveNavSection,
  BindHostMode,
  FilterConditionRule,
  FilterPreset,
  HostListFilterConfig,
  NoiseThresholdsConfig,
  ProxyFilterBackendConfig,
  ProxyStatus,
  SanitizationOptions,
  SessionSummary,
  StorageStats,
  ThrottleConfig,
  UpstreamProxyConfig,
  UpstreamTimeoutConfig,
} from "../../types/proxy";
import type {
  FluxUserSettingsProfile,
  SettingsImportPreviewSummary,
  SettingsModalSubTab,
  SettingsModalTab,
} from "../../types/settings";
import { CertificateModal } from "../CertificateModal";
import { CodeSnippetModal } from "../CodeSnippetModal";
import { SessionAnnotationModal } from "../SessionAnnotationModal";
import { ShortcutsModal } from "../ShortcutsModal";
import {
  TrafficStatisticsModal,
  type TrafficStatisticsScope,
} from "../TrafficStatisticsModal";

const OpenApiExportModal = React.lazy(() =>
  import("../OpenApiExportModal").then((m) => ({
    default: m.OpenApiExportModal,
  }))
);
const SanitizedExportModal = React.lazy(() =>
  import("../SanitizedExportModal").then((m) => ({
    default: m.SanitizedExportModal,
  }))
);
const SettingsImportPreviewModal = React.lazy(() =>
  import("../SettingsModal").then((m) => ({
    default: m.SettingsImportPreviewModal,
  }))
);
const SettingsModal = React.lazy(() =>
  import("../SettingsModal").then((m) => ({
    default: m.SettingsModal,
  }))
);

export interface AppModalsProps {
  shortcutsModalOpen: boolean;
  onCloseShortcutsModal: () => void;

  settingsModalOpen: boolean;
  settingsInitialTab: SettingsModalTab;
  settingsInitialSubTab: SettingsModalSubTab | undefined;
  settingsNavSeq: number;
  onCloseSettingsModal: () => void;

  onResetPanelLayout: () => void;
  followTail: boolean;
  onSetFollowTail: (v: boolean) => void;
  activePresetId: string | null;
  customPresets: FilterPreset[];
  allPresets: FilterPreset[];
  onApplyPreset: (presetId: string) => void;
  onSaveCustomPreset: (name: string, description?: string) => void;
  onDeleteCustomPreset: (presetId: string) => void;
  matrixEnabled: boolean;
  onSetMatrixEnabled: (enabled: boolean) => void;
  filterRules: FilterConditionRule[];
  onSetFilterRules: (
    updater:
      | FilterConditionRule[]
      | ((prev: FilterConditionRule[]) => FilterConditionRule[])
  ) => void;
  ruleErrors: Record<string, string>;
  onQuickProcessFilter: (
    processName: string,
    action?: "include" | "exclude"
  ) => void;
  thresholds: NoiseThresholdsConfig;
  onSetThresholds: (
    updater:
      | NoiseThresholdsConfig
      | ((prev: NoiseThresholdsConfig) => NoiseThresholdsConfig)
  ) => void;
  hostListFilter: HostListFilterConfig;
  onSetHostListFilter: (
    updater:
      | HostListFilterConfig
      | ((prev: HostListFilterConfig) => HostListFilterConfig)
  ) => void;
  onResetAdvancedFilters: () => void;
  isForceNoCacheActive: boolean;
  onToggleForceNoCache: () => Promise<void>;
  status: ProxyStatus;
  onToggleProxy: () => Promise<void>;
  onSetProxyPort: (port: number) => Promise<void>;
  onSetAutoSystemProxy: (auto: boolean) => Promise<void>;
  onSetAllowRemote: (allow: boolean) => Promise<void>;
  onSetBindConfiguration: (
    bindMode: BindHostMode,
    specificBindIp?: string | null,
    alsoBindLoopback?: boolean
  ) => Promise<void>;
  throttleConfig: ThrottleConfig;
  onChangeThrottleConfig: (cfg: ThrottleConfig) => Promise<void>;
  activeHostRemapCount: number;
  upstreamProxyConfig: UpstreamProxyConfig;
  onSaveUpstreamProxyConfig: (next: UpstreamProxyConfig) => Promise<void>;
  upstreamTimeouts: UpstreamTimeoutConfig;
  onSaveUpstreamTimeouts: (next: UpstreamTimeoutConfig) => Promise<void>;
  sessionRetentionLimit: number | null;
  onSetSessionRetentionLimit: (limit: number | null) => Promise<void>;
  dropNonMatching: boolean;
  onSetDropNonMatching: (enabled: boolean) => Promise<void>;
  clearDbOnExit: boolean;
  onSetClearDbOnExit: (enabled: boolean) => Promise<boolean>;
  onClearSqliteDatabase: () => Promise<StorageStats>;
  backendFilterConfig: ProxyFilterBackendConfig;
  onUpdateBackendFilterConfig: (next: ProxyFilterBackendConfig) => Promise<void>;
  onUpdateLanClientAllowlist: (next: string[]) => Promise<void>;
  onOpenCertificateModal: () => void;
  caRefreshKey: number;
  activeClientCertsCount: number;
  onClientCertsCountChange: (count: number) => void;
  onExportSettingsProfile: () => Promise<void>;
  onImportSettingsProfileDialog: () => Promise<void>;
  onImportFromRawJsonText: (jsonText: string, fileName?: string) => void;
  onResetAllSettings: (skipConfirm?: boolean) => Promise<void>;

  pendingImportState: {
    profile: FluxUserSettingsProfile;
    preview: SettingsImportPreviewSummary;
  } | null;
  onCancelPendingImport: () => void;
  onConfirmImportSettingsProfile: (options?: {
    trustImportedPythonScript?: boolean;
  }) => Promise<void>;

  annotationModalOpen: boolean;
  annotationTargetIds: number[];
  onCloseAnnotationModal: () => void;
  onAnnotateSessions: (
    ids: number[],
    comment: string | null,
    markedColor: string | null
  ) => Promise<void>;

  certModalOpen: boolean;
  onCloseCertModal: () => void;

  sanitizedExportModalOpen: boolean;
  effectiveSelectedIds: number[];
  onCloseSanitizedExportModal: () => void;
  onExportSanitizedSessions: (
    targetSessionIds: number[],
    format: "har" | "saz" | "json" | "raw",
    sanitization: SanitizationOptions,
    includeEvictedSqlite?: boolean
  ) => Promise<boolean>;

  openApiModalOpen: boolean;
  openApiSelectedIds: number[];
  openApiAllIds: number[];
  onCloseOpenApiModal: () => void;

  codeSnippetModalOpen: boolean;
  codeSnippetRequest: CodeGenRequest | null;
  onCloseCodeSnippetModal: () => void;

  trafficStatsModalOpen: boolean;
  trafficStatsInitialScope: TrafficStatisticsScope;
  onCloseTrafficStatsModal: () => void;
  onSetActiveSection: (section: ActiveNavSection) => void;
  onDismissInlineDiff: () => void;
  onSelectSessionId: (id: number) => void;
  onSetInspectorCollapsed: (collapsed: boolean) => void;
  onFilterByHost: (host: string) => void;

  confirmSqlitePurgeOpen: boolean;
  onCloseConfirmSqlitePurge: () => void;

  showToast: (msg: string) => void;
}

const SettingsModalContainer: React.FC<AppModalsProps> = ({
  settingsModalOpen,
  settingsInitialTab,
  settingsInitialSubTab,
  settingsNavSeq,
  onCloseSettingsModal,
  onResetPanelLayout,
  followTail,
  onSetFollowTail,
  activePresetId,
  customPresets,
  allPresets,
  onApplyPreset,
  onSaveCustomPreset,
  onDeleteCustomPreset,
  matrixEnabled,
  onSetMatrixEnabled,
  filterRules,
  onSetFilterRules,
  ruleErrors,
  onQuickProcessFilter,
  thresholds,
  onSetThresholds,
  hostListFilter,
  onSetHostListFilter,
  onResetAdvancedFilters,
  isForceNoCacheActive,
  onToggleForceNoCache,
  status,
  onToggleProxy,
  onSetProxyPort,
  onSetAutoSystemProxy,
  onSetAllowRemote,
  onSetBindConfiguration,
  throttleConfig,
  onChangeThrottleConfig,
  activeHostRemapCount,
  upstreamProxyConfig,
  onSaveUpstreamProxyConfig,
  upstreamTimeouts,
  onSaveUpstreamTimeouts,
  sessionRetentionLimit,
  onSetSessionRetentionLimit,
  dropNonMatching,
  onSetDropNonMatching,
  clearDbOnExit,
  onSetClearDbOnExit,
  onClearSqliteDatabase,
  backendFilterConfig,
  onUpdateBackendFilterConfig,
  onUpdateLanClientAllowlist,
  onOpenCertificateModal,
  caRefreshKey,
  activeClientCertsCount,
  onClientCertsCountChange,
  onExportSettingsProfile,
  onImportSettingsProfileDialog,
  onImportFromRawJsonText,
  onResetAllSettings,
  showToast,
}) => {
  const {
    preference,
    themePreset,
    customColorOverrides,
    effectiveTokens,
    setTheme,
    setThemePreset,
    setCustomColorOverride,
    resetCustomColorOverride,
    resetCustomColorOverrides,
  } = useTheme();
  const {
    compactToolbar,
    setCompactToolbar,
    sidebarCollapsed,
    setSidebarCollapsed,
    inspectorCollapsed,
    setInspectorCollapsed,
    inspectorPosition,
    setInspectorPosition,
    inspectorSplitDirection,
    setInspectorSplitDirection,
    toolbarGroups,
    toggleToolbarGroup,
    resetToolbarGroups,
    visibleColumns,
    toggleColumnVisibility,
    columnWidths,
    setColumnWidth,
    resetColumns,
  } = useUiPreferences();

  const sessions = useProxyStore((s) => s.sessions);
  const storageStats = useProxyStore((s) => s.storageStats);
  const autoResponderEnabled = useProxyStore((s) => s.autoResponderEnabled);
  const rules = useProxyStore((s) => s.rules);
  const { filteredSessions } = useFilteredSessions();
  const detectedProcesses = useMemo(
    () => computeDetectedProcesses(sessions),
    [sessions]
  );

  return (
    <React.Suspense fallback={null}>
      <SettingsModal
        open={settingsModalOpen}
        initialTab={settingsInitialTab}
        initialSubTab={settingsInitialSubTab}
        navigationSeq={settingsNavSeq}
        onClose={onCloseSettingsModal}
        themePreference={preference}
        onSetTheme={setTheme}
        themePreset={themePreset}
        customColorOverrides={customColorOverrides}
        effectiveThemeTokens={effectiveTokens}
        onSetThemePreset={setThemePreset}
        onSetCustomColorOverride={setCustomColorOverride}
        onResetCustomColorOverride={resetCustomColorOverride}
        onResetCustomColorOverrides={resetCustomColorOverrides}
        compactToolbar={compactToolbar}
        onSetCompactToolbar={setCompactToolbar}
        sidebarCollapsed={sidebarCollapsed}
        onSetSidebarCollapsed={setSidebarCollapsed}
        inspectorCollapsed={inspectorCollapsed}
        onSetInspectorCollapsed={setInspectorCollapsed}
        inspectorPosition={inspectorPosition}
        onSetInspectorPosition={setInspectorPosition}
        inspectorSplitDirection={inspectorSplitDirection}
        onSetInspectorSplitDirection={setInspectorSplitDirection}
        onResetPanelLayout={onResetPanelLayout}
        followTail={followTail}
        onSetFollowTail={onSetFollowTail}
        toolbarGroups={toolbarGroups}
        onToggleToolbarGroup={toggleToolbarGroup}
        onResetToolbarGroups={resetToolbarGroups}
        visibleColumns={visibleColumns}
        onToggleColumnVisibility={toggleColumnVisibility}
        columnWidths={columnWidths}
        onSetColumnWidth={setColumnWidth}
        onResetColumns={resetColumns}
        sessions={sessions}
        totalCount={sessions.length}
        filteredCount={filteredSessions.length}
        activePresetId={activePresetId}
        userPresets={customPresets}
        allPresets={allPresets}
        onApplyPreset={(presetId) => {
          if (presetId) {
            onApplyPreset(presetId);
          } else {
            onResetAdvancedFilters();
          }
        }}
        onSaveCustomPreset={onSaveCustomPreset}
        onDeleteCustomPreset={onDeleteCustomPreset}
        matrixEnabled={matrixEnabled}
        onSetMatrixEnabled={onSetMatrixEnabled}
        filterRules={filterRules}
        onSetFilterRules={onSetFilterRules}
        ruleErrors={ruleErrors}
        detectedProcesses={detectedProcesses}
        onQuickProcessFilter={onQuickProcessFilter}
        noiseThresholds={thresholds}
        onSetNoiseThresholds={onSetThresholds}
        hostFilters={hostListFilter}
        onSetHostFilters={onSetHostListFilter}
        onResetAdvancedFilters={onResetAdvancedFilters}
        isForceNoCacheActive={isForceNoCacheActive}
        onToggleForceNoCache={onToggleForceNoCache}
        status={status}
        onToggleProxy={onToggleProxy}
        onSetProxyPort={onSetProxyPort}
        onSetAutoSystemProxy={onSetAutoSystemProxy}
        onSetAllowRemote={onSetAllowRemote}
        onSetBindConfiguration={onSetBindConfiguration}
        throttleConfig={throttleConfig}
        onChangeThrottleConfig={onChangeThrottleConfig}
        activeHostRemapCount={activeHostRemapCount}
        upstreamProxyConfig={upstreamProxyConfig}
        onSaveUpstreamProxyConfig={onSaveUpstreamProxyConfig}
        upstreamTimeouts={upstreamTimeouts}
        onSetUpstreamTimeouts={onSaveUpstreamTimeouts}
        sessionRetentionLimit={sessionRetentionLimit}
        onSetSessionRetentionLimit={onSetSessionRetentionLimit}
        dropNonMatching={dropNonMatching}
        onSetDropNonMatching={onSetDropNonMatching}
        storageStats={storageStats}
        clearDbOnExit={clearDbOnExit}
        onSetClearDbOnExit={onSetClearDbOnExit}
        onClearSqliteDatabase={onClearSqliteDatabase}
        backendFilterConfig={backendFilterConfig}
        onUpdateBackendFilterConfig={onUpdateBackendFilterConfig}
        onUpdateLanClientAllowlist={onUpdateLanClientAllowlist}
        onOpenCertificateModal={onOpenCertificateModal}
        caRefreshKey={caRefreshKey}
        activeClientCertsCount={activeClientCertsCount}
        onClientCertsCountChange={onClientCertsCountChange}
        autoResponderEnabled={autoResponderEnabled}
        autoResponderRules={rules}
        onExportProfile={onExportSettingsProfile}
        onImportProfileDialog={onImportSettingsProfileDialog}
        onImportFromRawJsonText={(jsonText, label) =>
          onImportFromRawJsonText(jsonText, label ?? "pasted-settings.json")
        }
        onResetAllToDefaults={() => onResetAllSettings(true)}
        onNotify={showToast}
      />
    </React.Suspense>
  );
};

const SessionAnnotationModalContainer: React.FC<{
  targetIds: number[];
  onClose: () => void;
  onSave: (
    ids: number[],
    comment: string | null,
    markedColor: string | null
  ) => Promise<void>;
}> = ({ targetIds, onClose, onSave }) => {
  const sessions = useProxyStore((s) => s.sessions);
  const targetSessions = useMemo(() => {
    if (targetIds.length === 0) return [];
    const idSet = new Set(targetIds);
    return sessions.filter((s) => idSet.has(s.id));
  }, [sessions, targetIds]);

  return (
    <SessionAnnotationModal
      open={true}
      targetSessions={targetSessions}
      onClose={onClose}
      onSave={(ids, comment, markedColor) => {
        void onSave(ids, comment, markedColor);
      }}
    />
  );
};

const SanitizedExportModalContainer: React.FC<{
  selectedIds: number[];
  onClose: () => void;
  onExport: (
    targetSessionIds: number[],
    format: "har" | "saz" | "json" | "raw",
    sanitization: SanitizationOptions,
    includeEvictedSqlite?: boolean
  ) => Promise<boolean>;
}> = ({ selectedIds, onClose, onExport }) => {
  const totalCount = useProxyStore((s) => s.sessions.length);
  const archivedCount = useProxyStore(
    (s) => s.storageStats.archivedSessions ?? 0
  );

  return (
    <React.Suspense fallback={null}>
      <SanitizedExportModal
        open={true}
        totalCount={totalCount}
        archivedCount={archivedCount}
        selectedIds={selectedIds}
        onClose={onClose}
        onExport={onExport}
      />
    </React.Suspense>
  );
};

const TrafficStatisticsModalContainer: React.FC<{
  effectiveSelectedIds: number[];
  initialScope: TrafficStatisticsScope;
  onClose: () => void;
  onSelectSession: (id: number) => void;
  onFilterByHost: (host: string) => void;
  onNotify: (msg: string) => void;
}> = ({
  effectiveSelectedIds,
  initialScope,
  onClose,
  onSelectSession,
  onFilterByHost,
  onNotify,
}) => {
  const sessions = useProxyStore((s) => s.sessions);
  const sessionIndexById = useProxyStore((s) => s.sessionIndexById);
  const filterQuery = useFilterStore((s) => s.filterQuery);
  const { filteredSessions } = useFilteredSessions();

  const selectedSessions = useMemo(() => {
    const out: SessionSummary[] = [];
    for (let i = 0; i < effectiveSelectedIds.length; i += 1) {
      const match = findSessionById(
        sessions,
        sessionIndexById,
        effectiveSelectedIds[i]
      );
      if (match) out.push(match);
    }
    return out;
  }, [effectiveSelectedIds, sessionIndexById, sessions]);

  return (
    <TrafficStatisticsModal
      open={true}
      onClose={onClose}
      filteredSessions={filteredSessions}
      selectedSessions={selectedSessions}
      totalCapturedCount={sessions.length}
      filterQuery={filterQuery}
      initialScope={initialScope}
      onSelectSession={onSelectSession}
      onFilterByHost={onFilterByHost}
      onNotify={onNotify}
    />
  );
};

const SqlitePurgeDialog: React.FC<{
  clearDbOnExit: boolean;
  onSetClearDbOnExit: (enabled: boolean) => Promise<boolean>;
  onClearSqliteDatabase: () => Promise<StorageStats>;
  onClose: () => void;
}> = ({
  clearDbOnExit,
  onSetClearDbOnExit,
  onClearSqliteDatabase,
  onClose,
}) => {
  const sqlitePurgeDialogRef = useRef<HTMLDialogElement>(null);
  const [isPurgingSqlite, setIsPurgingSqlite] = useState(false);
  const storageStats = useProxyStore((s) => s.storageStats);

  useEffect(() => {
    const dialog = sqlitePurgeDialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      dialog.showModal();
    }
  }, []);

  const handleConfirmSqlitePurge = async () => {
    if (isPurgingSqlite) return;
    setIsPurgingSqlite(true);
    try {
      await onClearSqliteDatabase();
      onClose();
    } finally {
      setIsPurgingSqlite(false);
    }
  };

  return (
    <dialog
      ref={sqlitePurgeDialogRef}
      aria-labelledby="sqlite-purge-confirm-title"
      onCancel={(e) => {
        if (isPurgingSqlite) e.preventDefault();
      }}
      onClose={() => {
        if (!isPurgingSqlite) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPurgingSqlite) {
          onClose();
        }
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto w-full max-w-md rounded-xl border border-strong bg-surface p-0 text-fg shadow-popover open:flex open:flex-col"
    >
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-status5xx-fg" />
          <h2
            id="sqlite-purge-confirm-title"
            className="text-sm font-semibold text-fg"
          >
            Очистка и сжатие архива SQLite (VACUUM)
          </h2>
        </div>
        <button
          type="button"
          disabled={isPurgingSqlite}
          onClick={onClose}
          className="rounded p-1 text-muted hover:bg-hover hover:text-fg disabled:opacity-45"
          aria-label="Закрыть диалог очистки SQLite"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3 px-4 py-3 text-xs text-fg">
        <p>
          Полностью удаляет сохранённые сессии и выгруженные тела из{" "}
          <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[11px]">
            sessions.sqlite
          </code>
          , усекает WAL-журнал и выполняет{" "}
          <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[11px]">
            VACUUM
          </code>{" "}
          для освобождения места на диске.
        </p>
        <div className="rounded border border-hairline bg-canvas/60 px-3 py-2 text-[11px] text-muted">
          Текущий размер SQLite:{" "}
          <strong className="font-semibold text-fg">
            {(storageStats.sqliteSizeBytes / (1024 * 1024)).toFixed(2)} MB
          </strong>{" "}
          ({storageStats.sqliteSizeBytes.toLocaleString("en-US")} байт) • В ОЗУ:{" "}
          <strong className="font-semibold text-fg">
            {storageStats.ramSessions.toLocaleString("en-US")}
          </strong>{" "}
          сессий (остаются в таблице).
        </div>
        <label className="flex cursor-pointer items-start gap-2 rounded border border-hairline bg-canvas/40 px-2.5 py-2 text-xs">
          <input
            type="checkbox"
            checked={clearDbOnExit}
            onChange={(e) => void onSetClearDbOnExit(e.target.checked)}
            className="checkbox-native mt-0.5"
          />
          <div>
            <div className="font-medium text-fg">
              Очищать базу SQLite при выходе (Clear DB on App Exit)
            </div>
            <div className="text-[11px] text-muted">
              Автоматически очищать и сжимать архив при каждом закрытии FluxProxy.
            </div>
          </div>
        </label>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-hairline bg-canvas/50 px-4 py-2.5">
        <button
          type="button"
          autoFocus
          disabled={isPurgingSqlite}
          onClick={onClose}
          className="rounded border border-strong bg-surface px-3 py-1.5 text-xs font-medium text-fg hover:bg-hover disabled:opacity-45"
        >
          Отмена
        </button>
        <button
          type="button"
          disabled={isPurgingSqlite}
          onClick={() => void handleConfirmSqlitePurge()}
          className="inline-flex items-center gap-1.5 rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span>
            {isPurgingSqlite
              ? "Очистка и VACUUM..."
              : "Очистить архив и выполнить VACUUM"}
          </span>
        </button>
      </div>
    </dialog>
  );
};

export const AppModals: React.FC<AppModalsProps> = (props) => {
  const { resolvedTheme } = useTheme();

  return (
    <>
      <ShortcutsModal
        open={props.shortcutsModalOpen}
        onClose={props.onCloseShortcutsModal}
      />

      {props.settingsModalOpen && <SettingsModalContainer {...props} />}

      {props.pendingImportState && (
        <React.Suspense fallback={null}>
          <SettingsImportPreviewModal
            preview={props.pendingImportState.preview}
            onCancel={props.onCancelPendingImport}
            onConfirm={props.onConfirmImportSettingsProfile}
          />
        </React.Suspense>
      )}

      {props.annotationModalOpen && (
        <SessionAnnotationModalContainer
          targetIds={props.annotationTargetIds}
          onClose={props.onCloseAnnotationModal}
          onSave={props.onAnnotateSessions}
        />
      )}

      <CertificateModal
        open={props.certModalOpen}
        onClose={props.onCloseCertModal}
        onNotify={props.showToast}
      />

      {props.sanitizedExportModalOpen && (
        <SanitizedExportModalContainer
          selectedIds={props.effectiveSelectedIds}
          onClose={props.onCloseSanitizedExportModal}
          onExport={props.onExportSanitizedSessions}
        />
      )}

      {props.openApiModalOpen && (
        <React.Suspense fallback={null}>
          <OpenApiExportModal
            open={props.openApiModalOpen}
            selectedIds={props.openApiSelectedIds}
            allSessionIds={props.openApiAllIds}
            resolvedTheme={resolvedTheme}
            onClose={props.onCloseOpenApiModal}
            onNotify={props.showToast}
          />
        </React.Suspense>
      )}

      <CodeSnippetModal
        open={props.codeSnippetModalOpen}
        request={props.codeSnippetRequest}
        resolvedTheme={resolvedTheme}
        onClose={props.onCloseCodeSnippetModal}
        onNotify={props.showToast}
      />

      {props.trafficStatsModalOpen && (
        <TrafficStatisticsModalContainer
          effectiveSelectedIds={props.effectiveSelectedIds}
          initialScope={props.trafficStatsInitialScope}
          onClose={props.onCloseTrafficStatsModal}
          onSelectSession={(id) => {
            props.onSetActiveSection("traffic");
            props.onDismissInlineDiff();
            props.onSelectSessionId(id);
            props.onSetInspectorCollapsed(false);
          }}
          onFilterByHost={props.onFilterByHost}
          onNotify={props.showToast}
        />
      )}

      {props.confirmSqlitePurgeOpen && (
        <SqlitePurgeDialog
          clearDbOnExit={props.clearDbOnExit}
          onSetClearDbOnExit={props.onSetClearDbOnExit}
          onClearSqliteDatabase={props.onClearSqliteDatabase}
          onClose={props.onCloseConfirmSqlitePurge}
        />
      )}
    </>
  );
};
