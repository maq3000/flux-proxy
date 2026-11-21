import React, { useState } from "react";
import { AlertTriangle, Check, Copy, Download, FileJson, RotateCcw, Upload } from "lucide-react";
import { TOOLBAR_GROUP_DEFINITIONS, TRAFFIC_COLUMNS } from "../../hooks/useUiPreferences";
import { collectCurrentSettingsProfile } from "../../lib/settingsManager";
import type {
  AutoResponderRule,
  ColumnId,
  FilterConditionRule,
  FilterPreset,
  ProxyFilterBackendConfig,
  ToolbarGroupId,
} from "../../types/proxy";
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  DEFAULT_SETTINGS_EXPORT_FILENAME,
} from "../../types/settings";

export interface BackupExportSettingsTabProps {
  baseId: string;
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

export const BackupExportSettingsTab: React.FC<BackupExportSettingsTabProps> = ({
  baseId,
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
  const [rawJsonDraft, setRawJsonDraft] = useState("");
  const [copiedProfileJson, setCopiedProfileJson] = useState(false);

  const handleCopyCurrentProfileJson = async () => {
    try {
      const snapshot = collectCurrentSettingsProfile();
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      setCopiedProfileJson(true);
      onNotify("📋 JSON текущего профиля настроек скопирован в буфер обмена");
      window.setTimeout(() => setCopiedProfileJson(false), 2000);
    } catch {
      onNotify("⚠️ Не удалось скопировать JSON в буфер обмена");
    }
  };

  const visibleColsCount = TRAFFIC_COLUMNS.filter((c) => visibleColumns[c.id]).length;
  const visibleGroupsCount = TOOLBAR_GROUP_DEFINITIONS.filter((g) => toolbarGroups[g.id]).length;

  return (
              <>
                <div className="space-y-3 rounded-lg border border-hairline bg-canvas p-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-fg">
                        Экспорт и импорт единого JSON-профиля настроек
                      </h3>
                      <p className="text-[11px] text-muted">
                        Файл по умолчанию:{" "}
                        <code className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-fg">
                          {DEFAULT_SETTINGS_EXPORT_FILENAME}
                        </code>{" "}
                        • Версия схемы:{" "}
                        <code className="font-mono">
                          v{CURRENT_SETTINGS_SCHEMA_VERSION}
                        </code>
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-md border border-hairline bg-surface p-2.5">
                      <div className="text-[10px] text-muted">Колонки и UI</div>
                      <div className="mt-0.5 font-mono text-sm font-semibold text-fg tabular-nums">
                        {visibleColsCount}/{TRAFFIC_COLUMNS.length} кол.
                      </div>
                      <div className="text-[10px] text-subtle">
                        Тулбар: {visibleGroupsCount}/
                        {TOOLBAR_GROUP_DEFINITIONS.length}
                      </div>
                    </div>
                    <div className="rounded-md border border-hairline bg-surface p-2.5">
                      <div className="text-[10px] text-muted">Пресеты фильтров</div>
                      <div className="mt-0.5 font-mono text-sm font-semibold text-fg tabular-nums">
                        {userPresets.length} польз.
                      </div>
                      <div className="text-[10px] text-subtle">
                        Матрица: {filterRules.length} усл.
                      </div>
                    </div>
                    <div className="rounded-md border border-hairline bg-surface p-2.5">
                      <div className="text-[10px] text-muted">TLS &amp; Заголовки</div>
                      <div className="mt-0.5 font-mono text-sm font-semibold text-fg tabular-nums">
                        {backendFilterConfig.tlsBypassRules.length +
                          backendFilterConfig.tlsTargetRules.length}{" "}
                        TLS
                      </div>
                      <div className="text-[10px] text-subtle">
                        Headers: {backendFilterConfig.headerMutations.length}
                      </div>
                    </div>
                    <div className="rounded-md border border-hairline bg-surface p-2.5">
                      <div className="text-[10px] text-muted">AutoResponder</div>
                      <div className="mt-0.5 font-mono text-sm font-semibold text-fg tabular-nums">
                        {autoResponderRules.length} правил
                      </div>
                      <div className="text-[10px] text-subtle">
                        Статус: {autoResponderEnabled ? "Enabled" : "Disabled"}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => void onExportProfile()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-sky-600 px-3 text-xs font-semibold text-white hover:bg-sky-500"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Export Settings Profile (JSON)...</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => void onImportProfileDialog()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-strong bg-surface px-3 text-xs font-semibold text-fg hover:bg-hover"
                    >
                      <Upload className="h-3.5 w-3.5 text-accent" />
                      <span>Import Settings Profile...</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleCopyCurrentProfileJson()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-elevated px-3 text-xs text-muted hover:border-strong hover:text-fg"
                    >
                      {copiedProfileJson ? (
                        <Check className="h-3.5 w-3.5 text-status2xx-fg" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      <span>Copy JSON</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-2 rounded-lg border border-hairline bg-canvas p-3.5">
                  <label
                    htmlFor={`${baseId}-paste-json`}
                    className="block text-xs font-semibold text-fg"
                  >
                    Быстрый импорт профиля из текста JSON (с проверкой и превью)
                  </label>
                  <textarea
                    id={`${baseId}-paste-json`}
                    rows={5}
                    value={rawJsonDraft}
                    onChange={(e) => setRawJsonDraft(e.target.value)}
                    placeholder='{"schemaVersion": 1, "ui": { ... }, "filters": { ... }}'
                    className="w-full rounded-md border border-strong bg-surface p-2 font-mono text-[11px] text-fg focus:border-accent focus:outline-none"
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      disabled={!rawJsonDraft.trim()}
                      onClick={() =>
                        onImportFromRawJsonText(
                          rawJsonDraft,
                          "буфер JSON (вставленный текст)"
                        )
                      }
                      className="inline-flex h-7 items-center gap-1.5 rounded border border-accent/40 bg-selected px-3 text-xs font-medium text-fg hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <FileJson className="h-3.5 w-3.5 text-accent" />
                      <span>Проверить и открыть превью импорта…</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-2.5 rounded-lg border border-status5xx-fg/35 bg-status5xx-bg p-3.5">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status5xx-fg" />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-xs font-semibold text-fg">
                        Сброс всех настроек к заводским значениям (Reset to Defaults)
                      </h3>
                      <p className="mt-0.5 text-[11px] text-muted">
                        Восстанавливает тему, компактность и группы тулбара, ширину всех колонок,
                        пользовательские пресеты, правила фильтрации, порт прокси (8888), TLS и AutoResponder.
                      </p>
                      <button
                        type="button"
                        onClick={onRequestResetAll}
                        className="mt-2.5 inline-flex h-8 items-center gap-1.5 rounded-md border border-status5xx-fg/50 bg-surface px-3 text-xs font-semibold text-status5xx-fg hover:bg-hover"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Reset to Defaults…</span>
                      </button>
                    </div>
                  </div>
                </div>
              </>
  );
};
