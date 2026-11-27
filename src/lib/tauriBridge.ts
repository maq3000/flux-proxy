import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type {
  AddClientCertificateInput,
  AutoResponderRule,
  BindHostMode,
  BreakpointAction,
  BreakpointConfig,
  BreakpointResolution,
  CaCertificateInfo,
  ClientCertificateEntry,
  CodecOperation,
  CodecTransformResult,
  ComposedRequest,
  DoctorCheckResult,
  HostRemapRule,
  LoadedSessionBody,
  NetworkInterfaceInfo,
  PausedBreakpointItem,
  ProxyFilterBackendConfig,
  ProxyStatus,
  PythonRunnerStatus,
  SanitizationOptions,
  ScriptConsoleLogEvent,
  SessionDetail,
  SessionSummary,
  StorageStats,
  ThrottleConfig,
  UpstreamProxyConfig,
  UpstreamTimeoutConfig,
  WebSocketFrameRecord,
  WsInjectDirection,
  WsInjectOpcode,
} from "../types/proxy";
import { browserPreviewCodecTransform } from "./textWizard";
import { DEFAULT_BREAKPOINT_CONFIG } from "../types/proxy";
import { encodeUint8ArrayToBase64 } from "./formatters";
import { previewPickedFiles } from "./appDefaults";
import type { BrowserPreviewEngine } from "./previewEngine";

export { DEFAULT_BREAKPOINT_CONFIG };

let previewEnginePromise: Promise<BrowserPreviewEngine> | null = null;
function loadPreviewEngine(): Promise<BrowserPreviewEngine> {
  if (!previewEnginePromise) {
    previewEnginePromise = import("./previewEngine").then((mod) =>
      mod.getPreviewEngine()
    );
  }
  return previewEnginePromise;
}

export interface FileDialogFilter {
  name: string;
  extensions: string[];
}

export type NativeDragDropPayload =
  | { type: "enter"; paths: string[] }
  | { type: "over" }
  | { type: "drop"; paths: string[] }
  | { type: "leave" };

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ============================================================================
// Unified Tauri IPC API Bridge
// ============================================================================
export const proxyBridge = {
  async getStatus(): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("get_proxy_status");
    }
    return (await loadPreviewEngine()).getStatus();
  },

  async startProxy(host?: string, port = 8888): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("start_proxy", {
        host: host ?? null,
        port,
      });
    }
    return (await loadPreviewEngine()).setRunning(true, host, port);
  },

  async stopProxy(): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("stop_proxy");
    }
    return (await loadPreviewEngine()).setRunning(false);
  },

  async setAllowRemote(allow: boolean): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("set_allow_remote", { allow });
    }
    return (await loadPreviewEngine()).setAllowRemote(allow);
  },

  async setBindConfiguration(
    bindMode: BindHostMode,
    specificBindIp?: string | null,
    alsoBindLoopback = true
  ): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("set_bind_configuration", {
        bindMode,
        specificBindIp: specificBindIp ?? null,
        alsoBindLoopback,
      });
    }
    return (await loadPreviewEngine()).setBindConfiguration(
      bindMode,
      specificBindIp,
      alsoBindLoopback
    );
  },

  async getNetworkInterfaces(
    includeVirtual = false
  ): Promise<NetworkInterfaceInfo[]> {
    if (isTauriRuntime()) {
      return invoke<NetworkInterfaceInfo[]>("get_network_interfaces", {
        includeVirtual,
      });
    }
    return (await loadPreviewEngine()).getNetworkInterfaces(includeVirtual);
  },

  async setSystemProxy(enabled: boolean): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("set_system_proxy", { enabled });
    }
    return (await loadPreviewEngine()).setSystemProxy(enabled);
  },

  async setAutoSystemProxy(auto: boolean): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("set_auto_system_proxy", { auto });
    }
    return (await loadPreviewEngine()).setAutoSystemProxy(auto);
  },

  async runProxyDoctor(): Promise<DoctorCheckResult[]> {
    if (isTauriRuntime()) {
      return invoke<DoctorCheckResult[]>("run_proxy_doctor");
    }
    return (await loadPreviewEngine()).runProxyDoctor();
  },

  async fixDoctorIssue(issueId: string): Promise<DoctorCheckResult[]> {
    if (isTauriRuntime()) {
      return invoke<DoctorCheckResult[]>("fix_doctor_issue", { issueId });
    }
    return (await loadPreviewEngine()).fixDoctorIssue(issueId);
  },

  async setPreviewPort(port: number): Promise<ProxyStatus> {
    if (isTauriRuntime()) {
      return invoke<ProxyStatus>("set_proxy_port", { port });
    }
    return (await loadPreviewEngine()).setPort(port);
  },

  async getSessions(): Promise<SessionSummary[]> {
    if (isTauriRuntime()) {
      return invoke<SessionSummary[]>("get_sessions");
    }
    return (await loadPreviewEngine()).getSummaries();
  },

  async getSessionDetail(id: number): Promise<SessionDetail | null> {
    if (isTauriRuntime()) {
      return invoke<SessionDetail | null>("get_session_detail", { id });
    }
    return (await loadPreviewEngine()).getDetail(id);
  },

  async setSessionRetentionLimit(limit: number | null): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("set_session_retention_limit", { limit });
      return;
    }
    (await loadPreviewEngine()).setSessionRetentionLimit(limit);
  },

  async setDropNonMatching(enabled: boolean): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("set_drop_non_matching", { enabled });
      return;
    }
    (await loadPreviewEngine()).setDropNonMatching(enabled);
  },

  async getMemoryStorageStats(): Promise<StorageStats> {
    if (isTauriRuntime()) {
      return invoke<StorageStats>("get_memory_storage_stats");
    }
    return (await loadPreviewEngine()).getMemoryStorageStats();
  },

  async clearSqliteDatabase(): Promise<StorageStats> {
    if (isTauriRuntime()) {
      return invoke<StorageStats>("clear_sqlite_database");
    }
    return (await loadPreviewEngine()).clearSqliteDatabase();
  },

  async getClearDbOnExit(): Promise<boolean> {
    if (isTauriRuntime()) {
      return invoke<boolean>("get_clear_db_on_exit");
    }
    return (await loadPreviewEngine()).getClearDbOnExit();
  },

  async setClearDbOnExit(enabled: boolean): Promise<boolean> {
    if (isTauriRuntime()) {
      return invoke<boolean>("set_clear_db_on_exit", { enabled });
    }
    return (await loadPreviewEngine()).setClearDbOnExit(enabled);
  },

  async loadSessionBody(
    id: number,
    isResponse: boolean
  ): Promise<LoadedSessionBody> {
    if (isTauriRuntime()) {
      return invoke<LoadedSessionBody>("load_session_body", {
        id,
        isResponse,
      });
    }
    return (await loadPreviewEngine()).loadSessionBody(id, isResponse);
  },

  async clearSessions(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("clear_sessions");
      return;
    }
    (await loadPreviewEngine()).clear();
  },

  async deleteSessions(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    if (isTauriRuntime()) {
      return invoke<number>("delete_sessions", { ids });
    }
    return (await loadPreviewEngine()).deleteMany(ids);
  },

  async saveSessionsSqlite(): Promise<number> {
    if (isTauriRuntime()) {
      return invoke<number>("save_sessions_sqlite");
    }
    return (await loadPreviewEngine()).saveArchiveToPreviewStorage();
  },

  async loadSessionsSqlite(): Promise<SessionSummary[]> {
    if (isTauriRuntime()) {
      return invoke<SessionSummary[]>("load_sessions_sqlite");
    }
    return (await loadPreviewEngine()).loadArchiveFromPreviewStorage();
  },

  async updateSessionAnnotations(
    ids: number[],
    comment: string | null,
    markedColor: string | null
  ): Promise<SessionSummary[]> {
    if (isTauriRuntime()) {
      return invoke<SessionSummary[]>("update_session_annotations", {
        ids,
        comment,
        markedColor,
      });
    }
    return (await loadPreviewEngine()).updateAnnotations(ids, comment, markedColor);
  },

  async getCaInfo(): Promise<CaCertificateInfo> {
    if (isTauriRuntime()) {
      return invoke<CaCertificateInfo>("get_ca_info");
    }
    return (await loadPreviewEngine()).getCaInfo();
  },

  async installRootCa(): Promise<string> {
    if (isTauriRuntime()) {
      return invoke<string>("install_root_ca");
    }
    return (await loadPreviewEngine()).installRootCa();
  },

  async uninstallRootCa(): Promise<string> {
    if (isTauriRuntime()) {
      return invoke<string>("uninstall_root_ca");
    }
    return (await loadPreviewEngine()).uninstallRootCa();
  },

  async listClientCertificates(): Promise<ClientCertificateEntry[]> {
    if (isTauriRuntime()) {
      return invoke<ClientCertificateEntry[]>("list_client_certificates");
    }
    return (await loadPreviewEngine()).listClientCertificates();
  },

  async addClientCertificate(
    request: AddClientCertificateInput
  ): Promise<ClientCertificateEntry> {
    if (isTauriRuntime()) {
      return invoke<ClientCertificateEntry>("add_client_certificate", {
        request,
      });
    }
    return (await loadPreviewEngine()).addClientCertificate(request);
  },

  async toggleClientCertificate(
    id: string,
    enabled: boolean
  ): Promise<ClientCertificateEntry> {
    if (isTauriRuntime()) {
      return invoke<ClientCertificateEntry>("toggle_client_certificate", {
        id,
        enabled,
      });
    }
    return (await loadPreviewEngine()).toggleClientCertificate(id, enabled);
  },

  async removeClientCertificate(
    id: string
  ): Promise<ClientCertificateEntry[]> {
    if (isTauriRuntime()) {
      return invoke<ClientCertificateEntry[]>("remove_client_certificate", {
        id,
      });
    }
    return (await loadPreviewEngine()).removeClientCertificate(id);
  },

  async listRules(): Promise<AutoResponderRule[]> {
    if (isTauriRuntime()) {
      return invoke<AutoResponderRule[]>("list_rules");
    }
    return (await loadPreviewEngine()).listRules();
  },

  async getAutoResponderEnabled(): Promise<boolean> {
    if (isTauriRuntime()) {
      return invoke<boolean>("get_autoresponder_enabled");
    }
    return (await loadPreviewEngine()).isAutoResponderEnabled();
  },

  async setAutoResponderEnabled(enabled: boolean): Promise<boolean> {
    if (isTauriRuntime()) {
      return invoke<boolean>("set_autoresponder_enabled", {
        enabled,
      });
    }
    return (await loadPreviewEngine()).setAutoResponderEnabled(enabled);
  },

  async setAutoResponderConfig(
    enabled: boolean,
    rules: AutoResponderRule[]
  ): Promise<AutoResponderRule[]> {
    const cloned = structuredClone(rules);
    if (isTauriRuntime()) {
      try {
        return await invoke<AutoResponderRule[]>("set_autoresponder_config", {
          enabled,
          rules: cloned,
        });
      } catch {
        // Graceful fallback if running against an older compiled binary
        const existing = await invoke<AutoResponderRule[]>("list_rules");
        for (const oldRule of existing) {
          await invoke("delete_rule", { id: oldRule.id });
        }
        const effective = enabled
          ? cloned
          : cloned.map((r) => ({ ...r, enabled: false }));
        for (const r of effective) {
          await invoke("upsert_rule", { rule: r });
        }
        return cloned;
      }
    }
    (await loadPreviewEngine()).setAutoResponderConfig(enabled, cloned);
    return cloned;
  },

  async upsertRule(rule: AutoResponderRule): Promise<AutoResponderRule[]> {
    if (isTauriRuntime()) {
      return invoke<AutoResponderRule[]>("upsert_rule", {
        rule,
      });
    }
    return (await loadPreviewEngine()).upsertRule(rule);
  },

  async deleteRule(id: string): Promise<AutoResponderRule[]> {
    if (isTauriRuntime()) {
      return invoke<AutoResponderRule[]>("delete_rule", { id });
    }
    return (await loadPreviewEngine()).deleteRule(id);
  },

  async getFilterBackendConfig(): Promise<ProxyFilterBackendConfig> {
    if (isTauriRuntime()) {
      return invoke<ProxyFilterBackendConfig>("get_filter_backend_config");
    }
    return (await loadPreviewEngine()).getFilterBackendConfig();
  },

  async updateFilterBackendConfig(
    config: ProxyFilterBackendConfig
  ): Promise<ProxyFilterBackendConfig> {
    if (isTauriRuntime()) {
      return invoke<ProxyFilterBackendConfig>("update_filter_backend_config", {
        config,
      });
    }
    return (await loadPreviewEngine()).updateFilterBackendConfig(config);
  },

  async updateProxyFilterConfig(
    config: ProxyFilterBackendConfig
  ): Promise<ProxyFilterBackendConfig> {
    return this.updateFilterBackendConfig(config);
  },

  async getTlsRuleHitCounts(): Promise<Record<string, number>> {
    if (isTauriRuntime()) {
      try {
        return await invoke<Record<string, number>>("get_tls_rule_hit_counts");
      } catch {
        return {};
      }
    }
    return (await loadPreviewEngine()).getTlsRuleHitCounts();
  },

  async resetTlsBypassRulesToRecommended(): Promise<ProxyFilterBackendConfig> {
    if (isTauriRuntime()) {
      return invoke<ProxyFilterBackendConfig>(
        "reset_tls_bypass_rules_to_recommended"
      );
    }
    return (await loadPreviewEngine()).resetTlsBypassRulesToRecommended();
  },

  async getBreakpointConfig(): Promise<BreakpointConfig> {
    if (isTauriRuntime()) {
      return invoke<BreakpointConfig>("get_breakpoint_config");
    }
    return (await loadPreviewEngine()).getBreakpointConfig();
  },

  async updateBreakpointConfig(
    config: BreakpointConfig
  ): Promise<BreakpointConfig> {
    if (isTauriRuntime()) {
      return invoke<BreakpointConfig>("update_breakpoint_config", { config });
    }
    return (await loadPreviewEngine()).updateBreakpointConfig(config);
  },

  async listPausedBreakpoints(): Promise<PausedBreakpointItem[]> {
    if (isTauriRuntime()) {
      return invoke<PausedBreakpointItem[]>("list_paused_breakpoints");
    }
    return (await loadPreviewEngine()).listPausedBreakpoints();
  },

  async resolveBreakpoint(resolution: BreakpointResolution): Promise<boolean> {
    if (isTauriRuntime()) {
      return invoke<boolean>("resolve_breakpoint", { resolution });
    }
    return (await loadPreviewEngine()).resolveBreakpoint(resolution);
  },

  async resumeAllBreakpoints(
    action: BreakpointAction = "continue"
  ): Promise<number> {
    if (isTauriRuntime()) {
      return invoke<number>("resume_all_breakpoints", { action });
    }
    return (await loadPreviewEngine()).resumeAllBreakpoints(action);
  },

  async loadBreakpointBody(
    breakpointId: string,
    isResponse: boolean
  ): Promise<LoadedSessionBody | null> {
    if (isTauriRuntime()) {
      return invoke<LoadedSessionBody | null>("load_breakpoint_body", {
        breakpointId,
        isResponse,
      });
    }
    return (await loadPreviewEngine()).loadBreakpointBody(breakpointId, isResponse);
  },

  async subscribeBreakpointsChanged(
    onChanged: (items: PausedBreakpointItem[]) => void
  ): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<PausedBreakpointItem[]>(
        "proxy://breakpoints-changed",
        (event) => {
          if (Array.isArray(event.payload)) {
            onChanged(event.payload);
          }
        }
      );
    }
    return (await loadPreviewEngine()).subscribeBreakpoints(onChanged);
  },

  async codecTransform(
    operation: CodecOperation,
    input: string,
    inputIsBase64 = false
  ): Promise<CodecTransformResult> {
    if (isTauriRuntime()) {
      try {
        return await invoke<CodecTransformResult>("codec_transform", {
          operation,
          input,
          inputIsBase64,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes("unknown variant")) {
          return browserPreviewCodecTransform(operation, input, inputIsBase64);
        }
        throw err;
      }
    }
    return browserPreviewCodecTransform(operation, input, inputIsBase64);
  },

  async executeComposedRequest(req: ComposedRequest): Promise<SessionDetail> {
    if (isTauriRuntime()) {
      return invoke<SessionDetail>("execute_composed_request", {
        request: req,
      });
    }
    return (await loadPreviewEngine()).executeComposed(req);
  },

  async subscribeSessionBatches(
    onBatch: (batch: SessionSummary[]) => void
  ): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<SessionSummary[]>("proxy://sessions-batch", (event) => {
        if (Array.isArray(event.payload) && event.payload.length > 0) {
          onBatch(event.payload);
        }
      });
    }
    return (await loadPreviewEngine()).subscribe(onBatch);
  },

  async subscribeSessionsRemoved(
    onRemoved: (ids: number[]) => void
  ): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<number[]>("proxy://sessions-removed", (event) => {
        if (Array.isArray(event.payload) && event.payload.length > 0) {
          onRemoved(event.payload);
        }
      });
    }
    return (await loadPreviewEngine()).subscribeRemoved(onRemoved);
  },

  async subscribeStatusChanged(
    onChanged: (status: ProxyStatus) => void
  ): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<ProxyStatus>("proxy://status-changed", (event) => {
        if (event.payload) {
          onChanged(event.payload);
        }
      });
    }
    return (await loadPreviewEngine()).subscribeStatus(onChanged);
  },

  async subscribeStorageStatsChanged(
    onChanged: (stats: StorageStats) => void
  ): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<StorageStats>("proxy://storage-stats-changed", (event) => {
        if (event.payload) {
          onChanged(event.payload);
        }
      });
    }
    return (await loadPreviewEngine()).subscribeStorageStats(onChanged);
  },

  async pickSaveFileDialog(options: {
    title?: string;
    defaultName?: string;
    filters: FileDialogFilter[];
  }): Promise<string | null> {
    if (isTauriRuntime()) {
      return invoke<string | null>("pick_save_file_dialog", {
        title: options.title ?? null,
        defaultName: options.defaultName ?? null,
        filters: options.filters,
      });
    }
    return options.defaultName ?? "fluxproxy-capture.har";
  },

  async pickOpenFileDialog(options: {
    title?: string;
    filters: FileDialogFilter[];
  }): Promise<string | null> {
    if (isTauriRuntime()) {
      return invoke<string | null>("pick_open_file_dialog", {
        title: options.title ?? null,
        filters: options.filters,
      });
    }
    if (typeof document === "undefined") return null;
    const exts = Array.from(
      new Set(
        options.filters.flatMap((f) =>
          f.extensions.filter((e) => e !== "*").map((e) => `.${e}`)
        )
      )
    );
    return new Promise<string | null>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      if (exts.length > 0) {
        input.accept = exts.join(",");
      }
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        const token = `preview://${Date.now()}_${file.name}`;
        previewPickedFiles.set(token, file);
        resolve(token);
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },

  async exportSessionsFile(
    sessionIds: number[],
    format: string,
    filePath: string,
    sanitization?: SanitizationOptions | null,
    includeEvictedSqlite = false
  ): Promise<number> {
    if (isTauriRuntime()) {
      return invoke<number>("export_sessions_file", {
        sessionIds,
        format,
        filePath,
        sanitization: sanitization ?? null,
        includeEvictedSqlite,
      });
    }
    return (await loadPreviewEngine()).exportPreviewSessions(
      sessionIds,
      format,
      filePath,
      sanitization,
      includeEvictedSqlite
    );
  },

  async importSessionsFile(filePath: string): Promise<SessionSummary[]> {
    if (isTauriRuntime()) {
      return invoke<SessionSummary[]>("import_sessions_file", { filePath });
    }
    const file = previewPickedFiles.get(filePath);
    if (!file) {
      throw new Error("Файл не найден в режиме Browser Preview");
    }
    previewPickedFiles.delete(filePath);
    if (file.name.toLowerCase().endsWith(".saz")) {
      throw new Error(
        "Чтение архивов Fiddler .saz выполняется в нативном Rust-бэкенде Tauri (`cargo tauri dev`)"
      );
    }
    const text = await file.text();
    return (await loadPreviewEngine()).importPreviewText(text);
  },

  async importSessionsBytes(
    fileName: string,
    bytes: Uint8Array
  ): Promise<SessionSummary[]> {
    if (isTauriRuntime()) {
      return invoke<SessionSummary[]>("import_sessions_bytes", {
        fileName,
        dataBase64: encodeUint8ArrayToBase64(bytes),
      });
    }
    if (fileName.toLowerCase().endsWith(".saz")) {
      throw new Error(
        "Чтение архивов Fiddler .saz выполняется в нативном Rust-бэкенде Tauri (`cargo tauri dev`)"
      );
    }
    const text = new TextDecoder().decode(bytes);
    return (await loadPreviewEngine()).importPreviewText(text);
  },

  async saveSessionBodyFile(
    sessionId: number,
    isResponse: boolean,
    filePath: string
  ): Promise<number> {
    if (isTauriRuntime()) {
      return invoke<number>("save_session_body_file", {
        sessionId,
        isResponse,
        filePath,
      });
    }
    return (await loadPreviewEngine()).savePreviewBody(sessionId, isResponse, filePath);
  },

  async exportSettingsJsonFile(
    filePath: string,
    jsonContent: string
  ): Promise<void> {
    if (isTauriRuntime()) {
      await invoke<number>("export_settings_file", {
        filePath,
        contents: jsonContent,
      });
      return;
    }
    (await loadPreviewEngine()).exportPreviewTextFile(
      filePath,
      jsonContent,
      "application/json;charset=utf-8"
    );
  },

  async exportTextFile(
    filePath: string,
    contents: string,
    mimeType = "text/plain;charset=utf-8"
  ): Promise<void> {
    if (isTauriRuntime()) {
      await invoke<number>("export_text_file", {
        filePath,
        contents,
      });
      return;
    }
    (await loadPreviewEngine()).exportPreviewTextFile(filePath, contents, mimeType);
  },

  async readSettingsJsonFile(filePath: string): Promise<string> {
    if (!isTauriRuntime() || filePath.startsWith("preview://")) {
      const file = previewPickedFiles.get(filePath);
      if (!file) {
        throw new Error("Выбранный файл настроек не найден");
      }
      previewPickedFiles.delete(filePath);
      const raw = await file.text();
      return raw.replace(/^\uFEFF/, "");
    }
    return invoke<string>("import_settings_file", { filePath });
  },

  async subscribeNativeFileDrop(
    onEvent: (payload: NativeDragDropPayload) => void
  ): Promise<UnlistenFn> {
    if (!isTauriRuntime()) {
      return () => {};
    }
    return getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter") {
        onEvent({ type: "enter", paths: p.paths });
      } else if (p.type === "over") {
        onEvent({ type: "over" });
      } else if (p.type === "drop") {
        onEvent({ type: "drop", paths: p.paths });
      } else if (p.type === "leave") {
        onEvent({ type: "leave" });
      }
    });
  },

  async setPythonScript(
    code: string,
    enabled: boolean
  ): Promise<PythonRunnerStatus> {
    if (isTauriRuntime()) {
      return invoke<PythonRunnerStatus>("set_python_script", { code, enabled });
    }
    return (await loadPreviewEngine()).setPythonScript(code, enabled);
  },

  async getPythonRunnerStatus(): Promise<PythonRunnerStatus> {
    if (isTauriRuntime()) {
      return invoke<PythonRunnerStatus>("get_python_runner_status");
    }
    return (await loadPreviewEngine()).getPythonRunnerStatus();
  },

  async subscribeScriptConsoleLogs(
    onLog: (entry: ScriptConsoleLogEvent) => void
  ): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<ScriptConsoleLogEvent>(
        "proxy://script-console-log",
        (event) => {
          if (event.payload) {
            onLog(event.payload);
          }
        }
      );
    }
    return (await loadPreviewEngine()).subscribeScriptLogs(onLog);
  },

  async generateStressTestSessions(count = 10_000): Promise<number> {
    if (isTauriRuntime()) {
      return invoke<number>("generate_stress_sessions", { count });
    }
    return (await loadPreviewEngine()).generateBulkStressSessions(count).length;
  },

  async getHostRemapRules(): Promise<HostRemapRule[]> {
    if (isTauriRuntime()) {
      return invoke<HostRemapRule[]>("get_host_remap_rules");
    }
    return (await loadPreviewEngine()).getHostRemapRules();
  },

  async updateHostRemapRules(
    rules: HostRemapRule[]
  ): Promise<HostRemapRule[]> {
    if (isTauriRuntime()) {
      return invoke<HostRemapRule[]>("update_host_remap_rules", { rules });
    }
    return (await loadPreviewEngine()).updateHostRemapRules(rules);
  },

  async getThrottleConfig(): Promise<ThrottleConfig> {
    if (isTauriRuntime()) {
      return invoke<ThrottleConfig>("get_throttle_config");
    }
    return (await loadPreviewEngine()).getThrottleConfig();
  },

  async setThrottleConfig(config: ThrottleConfig): Promise<ThrottleConfig> {
    if (isTauriRuntime()) {
      return invoke<ThrottleConfig>("set_throttle_config", { config });
    }
    return (await loadPreviewEngine()).setThrottleConfig(config);
  },

  async getUpstreamProxyConfig(): Promise<UpstreamProxyConfig> {
    if (isTauriRuntime()) {
      return invoke<UpstreamProxyConfig>("get_upstream_proxy_config");
    }
    return (await loadPreviewEngine()).getUpstreamProxyConfig();
  },

  async setUpstreamProxyConfig(
    config: UpstreamProxyConfig
  ): Promise<UpstreamProxyConfig> {
    if (isTauriRuntime()) {
      return invoke<UpstreamProxyConfig>("set_upstream_proxy_config", {
        config,
      });
    }
    return (await loadPreviewEngine()).setUpstreamProxyConfig(config);
  },

  async getUpstreamTimeouts(): Promise<UpstreamTimeoutConfig> {
    if (isTauriRuntime()) {
      return invoke<UpstreamTimeoutConfig>("get_upstream_timeouts");
    }
    return (await loadPreviewEngine()).getUpstreamTimeouts();
  },

  async setUpstreamTimeouts(
    config: UpstreamTimeoutConfig
  ): Promise<UpstreamTimeoutConfig> {
    if (isTauriRuntime()) {
      return invoke<UpstreamTimeoutConfig>("set_upstream_timeouts", { config });
    }
    return (await loadPreviewEngine()).setUpstreamTimeouts(config);
  },

  async cancelComposedRequest(requestId: string): Promise<boolean> {
    if (isTauriRuntime()) {
      return invoke<boolean>("cancel_composed_request", { requestId });
    }
    return (await loadPreviewEngine()).cancelComposedRequest(requestId);
  },

  async injectWebSocketFrame(
    sessionId: number,
    direction: WsInjectDirection,
    opcode: WsInjectOpcode,
    payload: string
  ): Promise<WebSocketFrameRecord> {
    if (isTauriRuntime()) {
      return invoke<WebSocketFrameRecord>("inject_websocket_frame", {
        sessionId,
        direction,
        opcode,
        payload,
      });
    }
    return (await loadPreviewEngine()).injectWebSocketFrame(
      sessionId,
      direction,
      opcode,
      payload
    );
  },

  triggerSimulatedTrafficHit(): void {
    if (!isTauriRuntime()) {
      void loadPreviewEngine().then((engine) =>
        engine.simulateLiveSessionFlow()
      );
    }
  },
};
