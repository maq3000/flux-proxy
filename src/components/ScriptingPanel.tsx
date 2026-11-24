import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Cpu,
  FileCode2,
  Play,
  RefreshCw,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { SAFE_PANEL_STORAGE } from "../hooks/useUiPreferences";
import { PYTHON_SCRIPT_PRESETS } from "../lib/mockTraffic";
import { getMonacoThemeName } from "../lib/monaco";
import type {
  PythonRunnerStatus,
  PythonScriptPreset,
  ScriptConsoleLogEvent,
} from "../types/proxy";
import { SectionHeader } from "./ui/SectionHeader";

interface ScriptingPanelProps {
  code: string;
  enabled: boolean;
  activePresetId: string | null;
  status: PythonRunnerStatus | null;
  logs: ScriptConsoleLogEvent[];
  resolvedTheme: "dark" | "light";
  isApplying: boolean;
  onChangeCode: (nextCode: string) => void;
  onSelectPreset: (preset: PythonScriptPreset) => void;
  onApplyScript: (code: string, enabled: boolean) => Promise<void> | void;
  onToggleEnabled: (enabled: boolean) => Promise<void> | void;
  onRefreshStatus: () => Promise<void> | void;
  onClearLogs: () => void;
}

type LogFilterKind = "all" | "stdout" | "errors";

function formatConsoleTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString("en-GB", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

export const ScriptingPanel: React.FC<ScriptingPanelProps> = ({
  code,
  enabled,
  activePresetId,
  status,
  logs,
  resolvedTheme,
  isApplying,
  onChangeCode,
  onSelectPreset,
  onApplyScript,
  onToggleEnabled,
  onRefreshStatus,
  onClearLogs,
}) => {
  const toggleId = useId();
  const [logFilter, setLogFilter] = useState<LogFilterKind>("all");
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  const supportsNativeSwitch =
    typeof HTMLInputElement !== "undefined" &&
    "switch" in HTMLInputElement.prototype;

  const monacoTheme = getMonacoThemeName(resolvedTheme);

  // Keep latest apply callback in ref so Monaco keybindings never capture stale code/enabled
  const latestApplyRef = useRef<() => void>(() => {});
  latestApplyRef.current = () => {
    void onApplyScript(code, enabled);
  };

  const handleEditorMount: OnMount = (editor, monacoInstance) => {
    editor.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter,
      () => latestApplyRef.current()
    );
    editor.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
      () => latestApplyRef.current()
    );
  };

  const hasUnsavedChanges = useMemo(() => {
    if (!status) return false;
    return code !== status.code || enabled !== status.enabled;
  }, [code, enabled, status]);

  const filteredLogs = useMemo(() => {
    if (logFilter === "all") return logs;
    if (logFilter === "stdout") {
      return logs.filter((l) => l.level === "stdout" || l.level === "info");
    }
    return logs.filter(
      (l) => l.level === "stderr" || l.level === "error" || l.level === "warn"
    );
  }, [logFilter, logs]);

  useEffect(() => {
    if (autoScrollLogs) {
      consoleEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [autoScrollLogs, filteredLogs.length]);

  const statusBadge = useMemo(() => {
    if (!status) {
      return {
        tone: "bg-elevated text-muted border-hairline",
        icon: <Cpu className="h-3.5 w-3.5 animate-pulse" />,
        label: "Probing Python…",
        title: "Определение доступного интерпретатора Python 3",
      };
    }
    if (status.isSimulator) {
      return {
        tone: "bg-status3xx-bg text-status3xx-fg border-status3xx-fg/30",
        icon: <Cpu className="h-3.5 w-3.5" />,
        label: enabled
          ? "Preview Simulator · Active"
          : "Preview Simulator · Ready",
        title:
          "Browser Preview: код сохраняется в localStorage; реальный процесс Python запускается в Tauri (`cargo tauri dev`).",
      };
    }
    if (!status.available) {
      return {
        tone: "bg-status5xx-bg text-status5xx-fg border-status5xx-fg/35",
        icon: <XCircle className="h-3.5 w-3.5" />,
        label: "Python 3 Not Found",
        title:
          "Установите Python 3 и убедитесь, что `python3`, `python` или `py` доступен в PATH.",
      };
    }
    if (status.lastError) {
      return {
        tone: "bg-status5xx-bg text-status5xx-fg border-status5xx-fg/35",
        icon: <AlertTriangle className="h-3.5 w-3.5" />,
        label: `${status.pythonVersion ?? "Python 3"} · Error`,
        title: status.lastError,
      };
    }
    if (status.enabled && status.running) {
      return {
        tone: "bg-status2xx-bg text-status2xx-fg border-status2xx-fg/35",
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        label: `${status.pythonVersion ?? "Python 3"} · Active${
          status.workerPid ? ` (PID ${status.workerPid})` : ""
        }`,
        title: `Исполняемый файл: ${status.pythonExecutable ?? "python"}`,
      };
    }
    return {
      tone: "bg-elevated text-fg border-strong",
      icon: <CheckCircle2 className="h-3.5 w-3.5 text-status2xx-fg" />,
      label: `${status.pythonVersion ?? "Python 3"} · Ready (Idle)`,
      title: `Исполняемый файл: ${status.pythonExecutable ?? "python"}`,
    };
  }, [enabled, status]);

  return (
    <div className="pane-contain flex h-full w-full flex-col overflow-hidden bg-canvas">
      {/* Top Header Bar */}
      <SectionHeader
        sectionId="scripts"
        icon={<FileCode2 className="h-4 w-4 text-accent" />}
        badges={
          <>
            <span
              title={statusBadge.title}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium ${statusBadge.tone}`}
            >
              {statusBadge.icon}
              <span>{statusBadge.label}</span>
            </span>

            {status?.hasOnRequest && (
              <span className="rounded bg-status3xx-bg px-1.5 py-0.5 font-mono text-[10px] font-semibold text-status3xx-fg">
                on_request
              </span>
            )}
            {status?.hasOnResponse && (
              <span className="rounded bg-status2xx-bg px-1.5 py-0.5 font-mono text-[10px] font-semibold text-status2xx-fg">
                on_response
              </span>
            )}
            {hasUnsavedChanges && (
              <span className="rounded bg-status4xx-bg px-1.5 py-0.5 font-mono text-[10px] font-medium text-status4xx-fg">
                Modified
              </span>
            )}
          </>
        }
        actions={
          <div className="flex items-center gap-2.5">
            <label
              htmlFor={toggleId}
              className="inline-flex cursor-pointer select-none items-center gap-2 rounded-md border border-hairline bg-elevated px-2.5 py-1 text-xs font-medium text-fg"
            >
              <input
                id={toggleId}
                type="checkbox"
                {...({ switch: "" } as Record<string, string>)}
                {...(!supportsNativeSwitch
                  ? {
                      role: "switch",
                      "data-switch-fallback": "true",
                    }
                  : {})}
                checked={enabled}
                disabled={isApplying}
                onChange={(e) => void onToggleEnabled(e.target.checked)}
                className="cert-switch"
              />
              <span>{enabled ? "Enabled" : "Disabled"}</span>
            </label>

            <button
              type="button"
              onClick={() => void onRefreshStatus()}
              disabled={isApplying}
              title="Проверить доступность Python и обновить статус воркера"
              className="inline-flex h-7 items-center gap-1 rounded border border-hairline bg-elevated px-2 text-xs text-muted transition-colors hover:border-strong hover:text-fg disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Check Python</span>
            </button>

            <button
              type="button"
              onClick={() => void onApplyScript(code, enabled)}
              disabled={isApplying}
              title="Загрузить скрипт в Python-раннер (Ctrl+Enter / Ctrl+S)"
              className="inline-flex h-7 items-center gap-1.5 rounded bg-emerald-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{isApplying ? "Applying…" : "Apply Script"}</span>
            </button>
          </div>
        }
      />

      {/* Contextual Simulator / Missing Interpreter / Error Banners */}
      {status?.isSimulator && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline bg-status3xx-bg px-4 py-1.5 text-[11px] text-status3xx-fg">
          <span>
            <strong>Browser Preview Simulator:</strong> текст скрипта и состояние
            сохраняются в <code className="font-mono">localStorage</code> и
            профиле настроек. Живой дочерний процесс{" "}
            <code className="font-mono">python3 / python / py</code> с IPC
            таймаутом 1500 мс (fail-open) активен в нативном приложении Tauri (
            <code className="font-mono">cargo tauri dev</code>).
          </span>
        </div>
      )}

      {!status?.isSimulator && status && !status.available && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-status4xx-bg px-4 py-1.5 text-[11px] text-status4xx-fg">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            Интерпретатор Python 3 (<code className="font-mono">python3</code>,{" "}
            <code className="font-mono">python</code>,{" "}
            <code className="font-mono">py</code>) не найден в PATH. Прокси
            работает в режиме <strong>fail-open</strong> без модификации
            трафика.
          </span>
        </div>
      )}

      {status?.lastError && (
        <div className="max-h-24 shrink-0 overflow-y-auto border-b border-hairline bg-status5xx-bg px-4 py-2 font-mono text-[11px] text-status5xx-fg">
          <div className="whitespace-pre-wrap break-words">
            {status.lastError}
          </div>
        </div>
      )}

      {/* Main Split Workspace */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Sidebar: Script Presets & Telemetry */}
        <aside className="flex w-72 shrink-0 flex-col justify-between overflow-hidden border-r border-hairline bg-surface">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-hairline px-3">
              <div className="flex items-center gap-1.5">
                <Code2 className="h-3.5 w-3.5 text-accent" />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Script Presets
                </span>
              </div>
              <span className="font-mono text-[10px] text-subtle">
                {PYTHON_SCRIPT_PRESETS.length} templates
              </span>
            </div>

            <div className="flex-1 space-y-1.5 overflow-y-auto p-2.5">
              {PYTHON_SCRIPT_PRESETS.map((preset) => {
                const isSelected = activePresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => onSelectPreset(preset)}
                    className={`w-full rounded-md border p-2.5 text-left transition-colors ${
                      isSelected
                        ? "border-accent/60 bg-selected"
                        : "border-hairline bg-canvas hover:border-strong hover:bg-hover"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold text-fg">
                        {preset.name}
                      </span>
                      <span className="shrink-0 rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-accent">
                        {preset.badge}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted">
                      {preset.description}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {preset.hooks.map((hk) => (
                        <span
                          key={hk}
                          className="rounded border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle"
                        >
                          {hk}
                        </span>
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Telemetry & Hook API Reference */}
          <div className="shrink-0 space-y-2 border-t border-hairline bg-elevated/40 p-3 text-[11px]">
            <div className="flex items-center justify-between font-semibold text-fg">
              <span>Worker Telemetry</span>
              <span className="font-mono text-[10px] text-muted">
                {status?.timeoutMs ?? 1500} ms fail-open
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 text-center font-mono text-[10px]">
              <div className="rounded border border-hairline bg-canvas px-1.5 py-1">
                <div className="text-subtle">Calls</div>
                <div className="font-semibold text-fg tabular-nums">
                  {status?.invocationsCount ?? 0}
                </div>
              </div>
              <div className="rounded border border-hairline bg-canvas px-1.5 py-1">
                <div className="text-subtle">Timeouts</div>
                <div
                  className={`font-semibold tabular-nums ${
                    (status?.timeoutCount ?? 0) > 0
                      ? "text-status4xx-fg"
                      : "text-fg"
                  }`}
                >
                  {status?.timeoutCount ?? 0}
                </div>
              </div>
              <div className="rounded border border-hairline bg-canvas px-1.5 py-1">
                <div className="text-subtle">Restarts</div>
                <div
                  className={`font-semibold tabular-nums ${
                    (status?.restartCount ?? 0) > 0
                      ? "text-status5xx-fg"
                      : "text-fg"
                  }`}
                >
                  {status?.restartCount ?? 0}
                </div>
              </div>
            </div>
            <div className="rounded border border-hairline bg-canvas p-2 font-mono text-[10px] leading-relaxed text-muted">
              <div className="truncate text-fg">
                bin:{" "}
                {status?.pythonExecutable ??
                  (status?.isSimulator ? "simulator" : "not detected")}
              </div>
              <div className="mt-1 text-subtle">
                request: method, url, headers, body, mock_response
              </div>
              <div className="text-subtle">
                response: status, headers, body (post-zstd; skips SSE/206/video)
              </div>
            </div>
          </div>
        </aside>

        {/* Right Side: Resizable Monaco Python Editor + Console Output */}
        <div className="min-w-0 flex-1 overflow-hidden">
          <PanelGroup
            autoSaveId="flux-scripts-editor-console-v1"
            storage={SAFE_PANEL_STORAGE}
            direction="vertical"
            className="h-full w-full"
          >
            <Panel id="python-script-editor" order={1} defaultSize={66} minSize={30}>
              <div className="flex h-full flex-col overflow-hidden bg-canvas">
                <div className="flex h-8 shrink-0 items-center justify-between border-b border-hairline bg-surface px-3 text-[11px] text-muted">
                  <span className="font-mono">
                    fluxproxy_script.py — hooks:{" "}
                    <code className="text-fg">on_request(request)</code> &amp;{" "}
                    <code className="text-fg">
                      on_response(response, request)
                    </code>
                  </span>
                  <span className="hidden font-mono text-[10px] text-subtle sm:inline">
                    Ctrl+Enter / Ctrl+S to Apply
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <Editor
                    height="100%"
                    language="python"
                    theme={monacoTheme}
                    value={code}
                    onChange={(val) => onChangeCode(val ?? "")}
                    onMount={handleEditorMount}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineHeight: 20,
                      tabSize: 4,
                      insertSpaces: true,
                      automaticLayout: true,
                      scrollBeyondLastLine: false,
                      wordWrap: "on",
                      padding: { top: 10, bottom: 10 },
                    }}
                  />
                </div>
              </div>
            </Panel>

            <PanelResizeHandle
              title="Перетащите для изменения высоты редактора и консоли"
              className="h-1 w-full bg-hairline transition-colors hover:bg-accent/60"
            />

            <Panel
              id="python-script-console"
              order={2}
              defaultSize={34}
              minSize={18}
            >
              <div className="flex h-full flex-col overflow-hidden bg-surface">
                <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-hairline px-3">
                  <div className="flex items-center gap-2">
                    <Terminal className="h-3.5 w-3.5 text-accent" />
                    <span className="text-xs font-semibold text-fg">
                      Console Output
                    </span>
                    <span className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-muted tabular-nums">
                      {filteredLogs.length}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <div
                      role="group"
                      aria-label="Filter console logs"
                      className="flex items-center rounded border border-hairline bg-canvas p-0.5 text-[11px]"
                    >
                      {(
                        [
                          { id: "all", label: "All" },
                          { id: "stdout", label: "stdout" },
                          { id: "errors", label: "stderr / errors" },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setLogFilter(opt.id)}
                          className={`rounded px-2 py-0.5 transition-colors ${
                            logFilter === opt.id
                              ? "bg-elevated font-medium text-fg"
                              : "text-muted hover:text-fg"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => setAutoScrollLogs((v) => !v)}
                      className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                        autoScrollLogs
                          ? "border-accent/40 bg-selected text-accent"
                          : "border-hairline bg-canvas text-muted hover:text-fg"
                      }`}
                    >
                      Auto-scroll
                    </button>

                    <button
                      type="button"
                      onClick={onClearLogs}
                      disabled={logs.length === 0}
                      className="inline-flex items-center gap-1 rounded border border-hairline bg-canvas px-2 py-0.5 text-[11px] text-muted transition-colors hover:text-fg disabled:opacity-40"
                    >
                      <Trash2 className="h-3 w-3" />
                      <span>Clear</span>
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto bg-canvas p-2 font-mono text-[11px] leading-relaxed">
                  {filteredLogs.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-center text-xs text-subtle">
                      Вывод <code className="mx-1 text-muted">print(...)</code>{" "}
                      и ошибки <code className="mx-1 text-muted">stderr</code>{" "}
                      будут отображаться здесь в реальном времени (событие{" "}
                      <code className="mx-1 text-muted">
                        proxy://script-console-log
                      </code>
                      ).
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {filteredLogs.map((entry) => {
                        const levelClass =
                          entry.level === "error" || entry.level === "stderr"
                            ? "text-status5xx-fg bg-status5xx-bg"
                            : entry.level === "warn"
                              ? "text-status4xx-fg bg-status4xx-bg"
                              : entry.level === "info"
                                ? "text-status3xx-fg bg-status3xx-bg"
                                : "text-status2xx-fg bg-status2xx-bg";

                        return (
                          <div
                            key={entry.id}
                            className="flex items-start gap-2 rounded px-2 py-1 hover:bg-hover/60"
                          >
                            <span className="shrink-0 text-[10px] text-subtle tabular-nums">
                              {formatConsoleTimestamp(entry.timestamp)}
                            </span>
                            <span
                              className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${levelClass}`}
                            >
                              {entry.level}
                            </span>
                            {(entry.hook || entry.sessionId !== null) && (
                              <span className="shrink-0 rounded border border-hairline bg-surface px-1.5 py-0.5 text-[10px] text-muted">
                                {entry.hook ?? "script"}
                                {entry.sessionId !== null
                                  ? ` #${entry.sessionId}`
                                  : ""}
                              </span>
                            )}
                            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-fg">
                              {entry.message}
                            </span>
                          </div>
                        );
                      })}
                      <div ref={consoleEndRef} />
                    </div>
                  )}
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </div>
      </div>
    </div>
  );
};
