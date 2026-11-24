import React from "react";
import { FileJson, Stethoscope } from "lucide-react";
import type {
  AutoResponderRule,
  ColumnId,
  FilterConditionRule,
  FilterPreset,
  ProxyFilterBackendConfig,
  ToolbarGroupId,
} from "../../types/proxy";
import type { SettingsDiagnosticsSubTab } from "../../types/settings";
import { BackupExportSettingsTab } from "./BackupExportSettingsTab";
import { ProxyDoctorPanel } from "./ProxyDoctorPanel";

export interface DiagnosticsBackupSettingsTabProps {
  baseId: string;
  activeSubTab: SettingsDiagnosticsSubTab;
  onSubTabChange: (subTab: SettingsDiagnosticsSubTab) => void;
  visibleColumns: Record<ColumnId, boolean>;
  toolbarGroups: Record<ToolbarGroupId, boolean>;
  userPresets: FilterPreset[];
  filterRules: FilterConditionRule[];
  autoResponderEnabled: boolean;
  autoResponderRules: AutoResponderRule[];
  backendFilterConfig: ProxyFilterBackendConfig;
  onExportProfile: () => Promise<void>;
  onImportProfileDialog: () => Promise<void>;
  onImportFromRawJsonText: (jsonText: string, sourceLabel?: string) => void;
  onRequestResetAll: () => void;
  onNotify: (msg: string) => void;
}

export const DiagnosticsBackupSettingsTab: React.FC<
  DiagnosticsBackupSettingsTabProps
> = ({
  baseId,
  activeSubTab,
  onSubTabChange,
  visibleColumns,
  toolbarGroups,
  userPresets,
  filterRules,
  autoResponderEnabled,
  autoResponderRules,
  backendFilterConfig,
  onExportProfile,
  onImportProfileDialog,
  onImportFromRawJsonText,
  onRequestResetAll,
  onNotify,
}) => {
  const subTabs: {
    id: SettingsDiagnosticsSubTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [
    {
      id: "proxyDoctor",
      label: "Proxy Doctor",
      icon: Stethoscope,
    },
    {
      id: "profileBackup",
      label: "Settings Profile",
      icon: FileJson,
    },
  ];

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Подразделы диагностики и резервного копирования"
        className="flex flex-wrap items-center gap-1.5 border-b border-hairline pb-2.5"
      >
        {subTabs.map((st) => {
          const Icon = st.icon;
          const selected = activeSubTab === st.id;
          return (
            <button
              key={st.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onSubTabChange(st.id)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                selected
                  ? "border-accent/60 bg-selected text-fg"
                  : "border-hairline bg-canvas text-muted hover:border-strong hover:text-fg"
              }`}
            >
              <Icon className="h-3.5 w-3.5 text-accent" />
              <span>{st.label}</span>
            </button>
          );
        })}
      </div>

      {activeSubTab === "proxyDoctor" && (
        <ProxyDoctorPanel onNotify={onNotify} />
      )}

      {activeSubTab === "profileBackup" && (
        <div id="settings-profile-section" className="space-y-4">
          <BackupExportSettingsTab
            baseId={baseId}
            visibleColumns={visibleColumns}
            toolbarGroups={toolbarGroups}
            userPresets={userPresets}
            filterRules={filterRules}
            autoResponderEnabled={autoResponderEnabled}
            autoResponderRules={autoResponderRules}
            backendFilterConfig={backendFilterConfig}
            onExportProfile={onExportProfile}
            onImportProfileDialog={onImportProfileDialog}
            onImportFromRawJsonText={onImportFromRawJsonText}
            onRequestResetAll={onRequestResetAll}
            onNotify={onNotify}
          />
        </div>
      )}
    </div>
  );
};
