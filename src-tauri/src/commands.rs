use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::models::{
    AutoResponderRule, BindHostMode, BreakpointAction, BreakpointConfig, BreakpointResolution,
    CaCertificateInfo, CodecOperation, CodecTransformResult, ComposedRequest, DoctorCheckResult,
    HostRemapRule, LoadedSessionBody, NetworkInterfaceInfo, PausedBreakpointItem, ProxyError,
    ProxyFilterBackendConfig, ProxyStatus, PythonRunnerStatus, SanitizationOptions, SessionDetail,
    SessionSummary, StorageStats, ThrottleConfig, UpstreamProxyConfig, UpstreamTimeoutConfig,
    WebSocketFrameRecord, WsInjectDirection, WsInjectOpcode,
};
use crate::proxy::client_certs::{AddClientCertificateRequest, ClientCertificateEntry};
use crate::proxy::codec::execute_codec_transform;
use crate::proxy::network::list_network_interfaces_with_options;
use crate::proxy::server::ProxyEngineController;
use crate::storage::export_import::{
    import_sessions_from_bytes, import_sessions_from_path, write_raw_bytes_to_file,
    CompiledSanitizationOptions, StreamingSessionExporter,
};

pub struct AppState {
    pub controller: Arc<ProxyEngineController>,
}

async fn run_blocking<F, T>(label: &'static str, f: F) -> Result<T, ProxyError>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ProxyError::Custom(format!("{label} task join error: {e}")))
}

#[tauri::command]
pub async fn get_proxy_status(state: State<'_, AppState>) -> Result<ProxyStatus, ProxyError> {
    Ok(state.controller.status().await)
}

#[tauri::command]
pub async fn start_proxy(
    host: Option<String>,
    port: Option<u16>,
    state: State<'_, AppState>,
) -> Result<ProxyStatus, ProxyError> {
    let bind_port = port.unwrap_or_else(|| state.controller.preferred_port());
    match host.map(|h| h.trim().to_string()).filter(|h| !h.is_empty()) {
        Some(explicit_host) => state.controller.start(explicit_host, bind_port).await,
        None => state.controller.start_with_config(bind_port).await,
    }
}

#[tauri::command]
pub async fn set_proxy_port(
    port: u16,
    state: State<'_, AppState>,
) -> Result<ProxyStatus, ProxyError> {
    state.controller.set_port(port).await
}

#[tauri::command]
pub async fn set_allow_remote(
    allow: bool,
    state: State<'_, AppState>,
) -> Result<ProxyStatus, ProxyError> {
    state.controller.set_allow_remote(allow).await
}

#[tauri::command]
pub async fn set_bind_configuration(
    bind_mode: BindHostMode,
    specific_bind_ip: Option<String>,
    also_bind_loopback: Option<bool>,
    state: State<'_, AppState>,
) -> Result<ProxyStatus, ProxyError> {
    state
        .controller
        .set_bind_configuration(
            bind_mode,
            specific_bind_ip,
            also_bind_loopback.unwrap_or(true),
        )
        .await
}

#[tauri::command]
pub async fn get_network_interfaces(
    include_virtual: Option<bool>,
) -> Result<Vec<NetworkInterfaceInfo>, ProxyError> {
    let include = include_virtual.unwrap_or(false);
    run_blocking("List network interfaces", move || {
        list_network_interfaces_with_options(include)
    })
    .await
}

#[tauri::command]
pub async fn stop_proxy(state: State<'_, AppState>) -> Result<ProxyStatus, ProxyError> {
    Ok(state.controller.stop().await)
}

#[tauri::command]
pub async fn set_system_proxy(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<ProxyStatus, ProxyError> {
    state.controller.set_system_proxy(enabled).await
}

#[tauri::command]
pub async fn set_auto_system_proxy(
    auto: bool,
    state: State<'_, AppState>,
) -> Result<ProxyStatus, ProxyError> {
    state.controller.set_auto_system_proxy(auto).await
}

#[tauri::command]
pub async fn run_proxy_doctor(
    state: State<'_, AppState>,
) -> Result<Vec<DoctorCheckResult>, ProxyError> {
    Ok(crate::proxy::doctor::run_proxy_doctor(&state.controller).await)
}

#[tauri::command]
pub async fn fix_doctor_issue(
    issue_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<DoctorCheckResult>, ProxyError> {
    crate::proxy::doctor::fix_doctor_issue(&state.controller, &issue_id).await
}

#[tauri::command]
pub async fn get_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, ProxyError> {
    let store = state.controller.context.store.clone();
    run_blocking("Get sessions", move || store.list_summaries()).await
}

#[tauri::command]
pub async fn get_session_detail(
    id: u64,
    state: State<'_, AppState>,
) -> Result<Option<SessionDetail>, ProxyError> {
    let store = state.controller.context.store.clone();
    run_blocking("Get session detail", move || store.get(id)).await
}

#[tauri::command]
pub async fn clear_sessions(state: State<'_, AppState>) -> Result<(), ProxyError> {
    let store = state.controller.context.store.clone();
    run_blocking("Clear sessions", move || store.clear()).await?;
    state.controller.context.emit_storage_stats_changed();
    Ok(())
}

#[tauri::command]
pub async fn delete_sessions(
    ids: Vec<u64>,
    state: State<'_, AppState>,
) -> Result<usize, ProxyError> {
    let store = state.controller.context.store.clone();
    let removed = run_blocking("Delete sessions", move || store.remove_many(&ids)).await?;
    state.controller.context.emit_storage_stats_changed();
    Ok(removed)
}

#[tauri::command]
pub async fn save_sessions_sqlite(state: State<'_, AppState>) -> Result<usize, ProxyError> {
    let store = state.controller.context.store.clone();
    let saved = run_blocking("Save sessions SQLite", move || store.save_all_to_sqlite()).await??;
    state.controller.context.emit_storage_stats_changed();
    Ok(saved)
}

#[tauri::command]
pub async fn load_sessions_sqlite(
    state: State<'_, AppState>,
) -> Result<Vec<SessionSummary>, ProxyError> {
    let store = state.controller.context.store.clone();
    let loaded = run_blocking("Load sessions SQLite", move || store.load_from_sqlite()).await??;
    state.controller.context.emit_storage_stats_changed();
    Ok(loaded)
}

#[tauri::command]
pub async fn update_session_annotations(
    ids: Vec<u64>,
    comment: Option<String>,
    marked_color: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<SessionSummary>, ProxyError> {
    let store = state.controller.context.store.clone();
    run_blocking("Update session annotations", move || {
        store.update_annotations(&ids, comment, marked_color)
    })
    .await?
}

#[tauri::command]
pub async fn get_ca_info(state: State<'_, AppState>) -> Result<CaCertificateInfo, ProxyError> {
    let ca = state.controller.context.ca.clone();
    tokio::task::spawn_blocking(move || ca.info_with_trust_status())
        .await
        .map_err(|e| ProxyError::Custom(format!("CA info task join error: {e}")))
}

#[tauri::command]
pub async fn install_root_ca(state: State<'_, AppState>) -> Result<String, ProxyError> {
    let ca = state.controller.context.ca.clone();
    tokio::task::spawn_blocking(move || ca.install_into_os_trust_store())
        .await
        .map_err(|e| ProxyError::Custom(format!("CA install task join error: {e}")))?
}

#[tauri::command]
pub async fn uninstall_root_ca(state: State<'_, AppState>) -> Result<String, ProxyError> {
    let ca = state.controller.context.ca.clone();
    tokio::task::spawn_blocking(move || ca.uninstall_from_os_trust_store())
        .await
        .map_err(|e| ProxyError::Custom(format!("CA uninstall task join error: {e}")))?
}

#[tauri::command]
pub async fn list_client_certificates(
    state: State<'_, AppState>,
) -> Result<Vec<ClientCertificateEntry>, ProxyError> {
    let certs = state.controller.context.client_certs.clone();
    run_blocking("List client certificates", move || certs.list()).await
}

#[tauri::command]
pub async fn add_client_certificate(
    request: AddClientCertificateRequest,
    state: State<'_, AppState>,
) -> Result<ClientCertificateEntry, ProxyError> {
    let certs = state.controller.context.client_certs.clone();
    run_blocking("Add client certificate", move || certs.add_certificate(request)).await?
}

#[tauri::command]
pub async fn toggle_client_certificate(
    id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<ClientCertificateEntry, ProxyError> {
    let certs = state.controller.context.client_certs.clone();
    run_blocking("Toggle client certificate", move || {
        certs.toggle_certificate(&id, enabled)
    })
    .await?
}

#[tauri::command]
pub async fn remove_client_certificate(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ClientCertificateEntry>, ProxyError> {
    let certs = state.controller.context.client_certs.clone();
    run_blocking("Remove client certificate", move || certs.remove_certificate(&id)).await?
}

#[tauri::command]
pub async fn list_rules(
    state: State<'_, AppState>,
) -> Result<Vec<AutoResponderRule>, ProxyError> {
    Ok(state.controller.context.rules.list_rules())
}

#[tauri::command]
pub async fn upsert_rule(
    rule: AutoResponderRule,
    state: State<'_, AppState>,
) -> Result<Vec<AutoResponderRule>, ProxyError> {
    state.controller.context.rules.upsert_rule(rule);
    Ok(state.controller.context.rules.list_rules())
}

#[tauri::command]
pub async fn delete_rule(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<AutoResponderRule>, ProxyError> {
    state.controller.context.rules.delete_rule(&id);
    Ok(state.controller.context.rules.list_rules())
}

#[tauri::command]
pub async fn get_autoresponder_enabled(
    state: State<'_, AppState>,
) -> Result<bool, ProxyError> {
    Ok(state.controller.context.rules.is_enabled())
}

#[tauri::command]
pub async fn set_autoresponder_enabled(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<bool, ProxyError> {
    state.controller.context.rules.set_enabled(enabled);
    Ok(state.controller.context.rules.is_enabled())
}

#[tauri::command]
pub async fn set_autoresponder_config(
    enabled: bool,
    rules: Vec<AutoResponderRule>,
    state: State<'_, AppState>,
) -> Result<Vec<AutoResponderRule>, ProxyError> {
    state.controller.context.rules.set_enabled(enabled);
    state.controller.context.rules.set_rules(rules);
    Ok(state.controller.context.rules.list_rules())
}

#[tauri::command]
pub async fn execute_composed_request(
    request: ComposedRequest,
    state: State<'_, AppState>,
) -> Result<SessionDetail, ProxyError> {
    state.controller.execute_composed(request).await
}

#[tauri::command]
pub async fn get_filter_backend_config(
    state: State<'_, AppState>,
) -> Result<ProxyFilterBackendConfig, ProxyError> {
    Ok(state.controller.context.filters.get_config())
}

#[tauri::command]
pub async fn update_filter_backend_config(
    config: ProxyFilterBackendConfig,
    state: State<'_, AppState>,
) -> Result<ProxyFilterBackendConfig, ProxyError> {
    Ok(state.controller.context.filters.update_config(config))
}

#[tauri::command]
pub async fn update_proxy_filter_config(
    config: ProxyFilterBackendConfig,
    state: State<'_, AppState>,
) -> Result<ProxyFilterBackendConfig, ProxyError> {
    Ok(state.controller.context.filters.update_config(config))
}

#[tauri::command]
pub async fn get_tls_rule_hit_counts(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, u64>, ProxyError> {
    Ok(state.controller.context.filters.get_tls_rule_hit_counts())
}

#[tauri::command]
pub async fn reset_tls_bypass_rules_to_recommended(
    state: State<'_, AppState>,
) -> Result<ProxyFilterBackendConfig, ProxyError> {
    Ok(state
        .controller
        .context
        .filters
        .reset_tls_bypass_rules_to_recommended())
}

#[tauri::command]
pub async fn get_breakpoint_config(
    state: State<'_, AppState>,
) -> Result<BreakpointConfig, ProxyError> {
    Ok(state.controller.context.breakpoints.get_config())
}

#[tauri::command]
pub async fn update_breakpoint_config(
    config: BreakpointConfig,
    state: State<'_, AppState>,
) -> Result<BreakpointConfig, ProxyError> {
    Ok(state.controller.context.breakpoints.update_config(config))
}

#[tauri::command]
pub async fn list_paused_breakpoints(
    state: State<'_, AppState>,
) -> Result<Vec<PausedBreakpointItem>, ProxyError> {
    Ok(state.controller.context.breakpoints.list_paused())
}

#[tauri::command]
pub async fn resolve_breakpoint(
    resolution: BreakpointResolution,
    state: State<'_, AppState>,
) -> Result<bool, ProxyError> {
    Ok(state.controller.context.breakpoints.resolve(resolution))
}

#[tauri::command]
pub async fn resume_all_breakpoints(
    action: Option<BreakpointAction>,
    state: State<'_, AppState>,
) -> Result<usize, ProxyError> {
    Ok(state
        .controller
        .context
        .breakpoints
        .resume_all(action.unwrap_or(BreakpointAction::Continue)))
}

#[tauri::command]
pub async fn load_breakpoint_body(
    breakpoint_id: String,
    is_response: bool,
    state: State<'_, AppState>,
) -> Result<Option<LoadedSessionBody>, ProxyError> {
    let breakpoints = state.controller.context.breakpoints.clone();
    run_blocking("Load breakpoint body", move || {
        breakpoints.load_paused_body(&breakpoint_id, is_response)
    })
    .await?
}

#[tauri::command]
pub async fn codec_transform(
    operation: CodecOperation,
    input: String,
    input_is_base64: Option<bool>,
) -> Result<CodecTransformResult, ProxyError> {
    let is_b64 = input_is_base64.unwrap_or(false);
    run_blocking("Codec transform", move || {
        execute_codec_transform(operation, &input, is_b64)
    })
    .await?
}

#[tauri::command]
pub async fn set_session_retention_limit(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<(), ProxyError> {
    let store = state.controller.context.store.clone();
    run_blocking("Set session retention limit", move || {
        store.set_retention_limit(limit)
    })
    .await??;
    state.controller.context.emit_storage_stats_changed();
    Ok(())
}

#[tauri::command]
pub async fn set_drop_non_matching(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), ProxyError> {
    state
        .controller
        .context
        .filters
        .set_drop_non_matching(enabled);
    state.controller.context.emit_storage_stats_changed();
    Ok(())
}

#[tauri::command]
pub async fn get_memory_storage_stats(
    state: State<'_, AppState>,
) -> Result<StorageStats, ProxyError> {
    let store = state.controller.context.store.clone();
    let drop_enabled = state
        .controller
        .context
        .filters
        .is_drop_non_matching_enabled();
    run_blocking("Get storage stats", move || store.storage_stats(drop_enabled)).await
}

#[tauri::command]
pub async fn clear_sqlite_database(
    state: State<'_, AppState>,
) -> Result<StorageStats, ProxyError> {
    let store = state.controller.context.store.clone();
    let drop_enabled = state
        .controller
        .context
        .filters
        .is_drop_non_matching_enabled();
    let stats = tokio::task::spawn_blocking(move || store.clear_sqlite_archive(drop_enabled))
        .await
        .map_err(|e| ProxyError::Custom(format!("Clear SQLite task join error: {e}")))??;
    state.controller.context.emit_storage_stats_changed();
    Ok(stats)
}

#[tauri::command]
pub async fn get_clear_db_on_exit(state: State<'_, AppState>) -> Result<bool, ProxyError> {
    Ok(state.controller.context.store.clear_db_on_exit())
}

#[tauri::command]
pub async fn set_clear_db_on_exit(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<bool, ProxyError> {
    let store = state.controller.context.store.clone();
    run_blocking("Set clear DB on exit", move || {
        store.set_clear_db_on_exit(enabled)
    })
    .await?
}

#[tauri::command]
pub async fn load_session_body(
    id: u64,
    is_response: bool,
    state: State<'_, AppState>,
) -> Result<LoadedSessionBody, ProxyError> {
    let store = state.controller.context.store.clone();
    run_blocking("Load session body", move || {
        store.load_session_body(id, is_response)
    })
    .await?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[tauri::command]
pub async fn pick_save_file_dialog(
    title: Option<String>,
    default_name: Option<String>,
    filters: Vec<FileDialogFilter>,
) -> Result<Option<String>, ProxyError> {
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new();
        if let Some(t) = title.as_deref() {
            if !t.is_empty() {
                dialog = dialog.set_title(t);
            }
        }
        if let Some(name) = default_name.as_deref() {
            if !name.is_empty() {
                dialog = dialog.set_file_name(name);
            }
        }
        for f in &filters {
            let ext_refs: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            if !ext_refs.is_empty() {
                dialog = dialog.add_filter(&f.name, &ext_refs);
            }
        }
        Ok(dialog.save_file().map(|p| {
            register_authorized_dialog_path(&p);
            p.to_string_lossy().into_owned()
        }))
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Native save dialog join error: {e}")))?
}

#[tauri::command]
pub async fn pick_open_file_dialog(
    title: Option<String>,
    filters: Vec<FileDialogFilter>,
) -> Result<Option<String>, ProxyError> {
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new();
        if let Some(t) = title.as_deref() {
            if !t.is_empty() {
                dialog = dialog.set_title(t);
            }
        }
        for f in &filters {
            let ext_refs: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            if !ext_refs.is_empty() {
                dialog = dialog.add_filter(&f.name, &ext_refs);
            }
        }
        Ok(dialog.pick_file().map(|p| {
            register_authorized_dialog_path(&p);
            p.to_string_lossy().into_owned()
        }))
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Native open dialog join error: {e}")))?
}

pub const MAX_SETTINGS_FILE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_AUTHORIZED_DIALOG_PATHS: usize = 128;
pub const ALLOWED_TEXT_EXPORT_EXTENSIONS: &[&str] = &["txt", "md", "json", "yaml", "yml"];

struct AuthorizedDialogPathRegistry {
    max_entries: usize,
    paths: VecDeque<String>,
}

impl AuthorizedDialogPathRegistry {
    fn new(max_entries: usize) -> Self {
        Self {
            max_entries: max_entries.max(1),
            paths: VecDeque::with_capacity(max_entries.min(256)),
        }
    }

    fn register(&mut self, key: String) {
        if key.is_empty() {
            return;
        }
        if let Some(pos) = self.paths.iter().position(|existing| existing == &key) {
            self.paths.remove(pos);
        }
        while self.paths.len() >= self.max_entries {
            self.paths.pop_front();
        }
        self.paths.push_back(key);
    }

    fn contains(&self, key: &str) -> bool {
        !key.is_empty() && self.paths.iter().any(|existing| existing == key)
    }
}

static AUTHORIZED_DIALOG_PATHS: OnceLock<StdMutex<AuthorizedDialogPathRegistry>> = OnceLock::new();

fn authorized_dialog_registry() -> &'static StdMutex<AuthorizedDialogPathRegistry> {
    AUTHORIZED_DIALOG_PATHS
        .get_or_init(|| StdMutex::new(AuthorizedDialogPathRegistry::new(MAX_AUTHORIZED_DIALOG_PATHS)))
}

fn normalize_dialog_path_key(path: &Path) -> String {
    let resolved = if path.exists() {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    } else if let Some(file_name) = path.file_name() {
        let parent_dir = match path.parent() {
            Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
            _ => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        };
        if let Ok(canon_parent) = std::fs::canonicalize(&parent_dir) {
            canon_parent.join(file_name)
        } else if path.is_relative() {
            std::env::current_dir()
                .map(|cwd| cwd.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        } else {
            path.to_path_buf()
        }
    } else {
        path.to_path_buf()
    };

    let raw_str = resolved.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    {
        let stripped = if is_windows_verbatim_disk_prefix(&raw_str) {
            &raw_str[4..]
        } else {
            raw_str.as_str()
        };
        stripped.replace('/', "\\").to_ascii_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        raw_str
    }
}

pub(crate) fn register_authorized_dialog_path(path: &Path) {
    let key = normalize_dialog_path_key(path);
    let mut guard = authorized_dialog_registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    guard.register(key);
}

fn is_authorized_dialog_path(path: &Path) -> bool {
    let key = normalize_dialog_path_key(path);
    let guard = authorized_dialog_registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    guard.contains(&key)
}

fn is_reserved_dos_device_name(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn is_windows_verbatim_disk_prefix(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    bytes.len() >= 7
        && &bytes[0..4] == br"\\?\"
        && bytes[4].is_ascii_alphabetic()
        && bytes[5] == b':'
        && (bytes[6] == b'\\' || bytes[6] == b'/')
}

pub(crate) fn validate_user_file_path(
    raw_path: &str,
    allowed_extensions: Option<&[&str]>,
    must_exist: bool,
    require_dialog_token: bool,
) -> Result<PathBuf, ProxyError> {
    if raw_path.contains('\0') {
        return Err(ProxyError::Custom(
            "Путь к файлу содержит недопустимый NUL-байт.".into(),
        ));
    }
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(ProxyError::Custom(
            "Путь к файлу не может быть пустым.".into(),
        ));
    }
    if trimmed.ends_with('/') || trimmed.ends_with('\\') {
        return Err(ProxyError::Custom(
            "Указан путь к каталогу вместо имени файла.".into(),
        ));
    }
    if trimmed.starts_with("//")
        || (trimmed.starts_with(r"\\") && !is_windows_verbatim_disk_prefix(trimmed))
    {
        return Err(ProxyError::Custom(
            "Сетевые UNC-пути и пути к устройствам запрещены.".into(),
        ));
    }
    if trimmed == ".."
        || trimmed.starts_with(r"..\")
        || trimmed.ends_with(r"\..")
        || trimmed.contains(r"\..\")
    {
        return Err(ProxyError::Custom(
            "Путь к файлу не может содержать переходы '..'.".into(),
        ));
    }

    let path = PathBuf::from(trimmed);
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                return Err(ProxyError::Custom(
                    "Путь к файлу не может содержать переходы '..'.".into(),
                ));
            }
            Component::Prefix(prefix) => match prefix.kind() {
                Prefix::UNC(..) | Prefix::VerbatimUNC(..) | Prefix::DeviceNS(..) => {
                    return Err(ProxyError::Custom(
                        "Сетевые UNC-пути и пространства имён устройств запрещены.".into(),
                    ));
                }
                Prefix::Disk(_) | Prefix::VerbatimDisk(_) | Prefix::Verbatim(_) => {}
            },
            Component::Normal(seg) => {
                let seg_str = seg.to_string_lossy();
                if seg_str.contains(':') {
                    return Err(ProxyError::Custom(
                        "Альтернативные потоки NTFS (:) и двоеточия в имени файла запрещены."
                            .into(),
                    ));
                }
                if is_reserved_dos_device_name(&seg_str) {
                    return Err(ProxyError::Custom(format!(
                        "Использование зарезервированного имени устройства ОС '{seg_str}' запрещено."
                    )));
                }
            }
            Component::RootDir | Component::CurDir => {}
        }
    }

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .ok_or_else(|| ProxyError::Custom("Некорректное имя файла в пути.".into()))?;
    if file_name.trim().is_empty() {
        return Err(ProxyError::Custom("Некорректное имя файла в пути.".into()));
    }
    if file_name.contains(':') {
        return Err(ProxyError::Custom(
            "Альтернативные потоки NTFS (:) в имени файла запрещены.".into(),
        ));
    }
    if is_reserved_dos_device_name(file_name) {
        return Err(ProxyError::Custom(format!(
            "Использование зарезервированного имени устройства ОС '{file_name}' запрещено."
        )));
    }
    if require_dialog_token && !is_authorized_dialog_path(&path) {
        return Err(ProxyError::Custom(
            "Доступ к файлу запрещён: путь должен быть выбран через системный диалог файла."
                .into(),
        ));
    }
    if path.is_dir() {
        return Err(ProxyError::Custom(format!(
            "Указанный путь является каталогом: {}",
            path.display()
        )));
    }

    if let Some(exts) = allowed_extensions {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .ok_or_else(|| {
                ProxyError::Custom(format!(
                    "Отсутствует расширение файла. Ожидается одно из: {}",
                    exts.join(", ")
                ))
            })?;
        if !exts.iter().any(|allowed| allowed.eq_ignore_ascii_case(&ext)) {
            return Err(ProxyError::Custom(format!(
                "Недопустимое расширение файла '.{ext}'. Разрешены: {}",
                exts.join(", ")
            )));
        }
    }

    if must_exist && !path.is_file() {
        return Err(ProxyError::Custom(format!(
            "Файл не найден или недоступен: {}",
            path.display()
        )));
    }

    Ok(path)
}

#[tauri::command]
pub async fn export_sessions_file(
    session_ids: Vec<u64>,
    format: String,
    file_path: String,
    sanitization: Option<SanitizationOptions>,
    include_evicted_sqlite: Option<bool>,
    state: State<'_, AppState>,
) -> Result<usize, ProxyError> {
    let validated_path = validate_user_file_path(
        &file_path,
        Some(&["har", "saz", "json", "txt", "raw"]),
        false,
        true,
    )?;
    let fmt_clean = format.trim().trim_start_matches('.').to_ascii_lowercase();
    if !fmt_clean.is_empty() {
        let ext = validated_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let compatible = match fmt_clean.as_str() {
            "raw" | "txt" => ext == "txt" || ext == "raw",
            "har" | "saz" | "json" => ext == fmt_clean,
            _ => {
                return Err(ProxyError::Custom(format!(
                    "Неподдерживаемый формат экспорта: '{format}'"
                )));
            }
        };
        if !compatible {
            return Err(ProxyError::Custom(format!(
                "Расширение файла '.{ext}' не соответствует выбранному формату экспорта '{fmt_clean}'."
            )));
        }
    }

    let include_archived = include_evicted_sqlite.unwrap_or(false);
    let store = state.controller.context.store.clone();
    tokio::task::spawn_blocking(move || {
        let compiled_sanitization = sanitization.as_ref().map(CompiledSanitizationOptions::new);
        let estimated_count = store.estimate_export_count(&session_ids, include_archived);
        let mut exporter =
            StreamingSessionExporter::create(&validated_path, &format, estimated_count)?;
        store.for_each_export_session(&session_ids, include_archived, |detail| {
            if let Some(ref sanitizer) = compiled_sanitization {
                let sanitized = sanitizer.sanitize_detail(&detail);
                exporter.write_session(&sanitized)
            } else {
                exporter.write_session(&detail)
            }
        })?;
        exporter.finish()
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Export task join error: {e}")))?
}

#[tauri::command]
pub async fn import_sessions_file(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<SessionSummary>, ProxyError> {
    let validated_path =
        validate_user_file_path(&file_path, Some(&["har", "saz", "json", "zip"]), true, true)?;
    let store = state.controller.context.store.clone();
    let event_tx = state.controller.context.event_tx.clone();
    let summaries = tokio::task::spawn_blocking(move || {
        let details = import_sessions_from_path(&validated_path)?;
        let summaries = store.import_sessions(details);
        for summary in &summaries {
            let _ = event_tx.send(summary.clone());
        }
        Ok::<_, ProxyError>(summaries)
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Import task join error: {e}")))??;
    state.controller.context.emit_storage_stats_changed();
    Ok(summaries)
}

#[tauri::command]
pub async fn import_sessions_bytes(
    file_name: String,
    data_base64: String,
    state: State<'_, AppState>,
) -> Result<Vec<SessionSummary>, ProxyError> {
    let store = state.controller.context.store.clone();
    let event_tx = state.controller.context.event_tx.clone();
    let summaries = tokio::task::spawn_blocking(move || {
        let cleaned: String = data_base64.chars().filter(|c| !c.is_whitespace()).collect();
        let raw_bytes = base64::engine::general_purpose::STANDARD
            .decode(&cleaned)
            .map_err(|e| ProxyError::Custom(format!("Invalid Base64 archive payload: {e}")))?;
        let details = import_sessions_from_bytes(&file_name, &raw_bytes)?;
        let summaries = store.import_sessions(details);
        for summary in &summaries {
            let _ = event_tx.send(summary.clone());
        }
        Ok::<_, ProxyError>(summaries)
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Import bytes task join error: {e}")))??;
    state.controller.context.emit_storage_stats_changed();
    Ok(summaries)
}

#[tauri::command]
pub async fn save_session_body_file(
    session_id: u64,
    is_response: bool,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<usize, ProxyError> {
    let validated_path = validate_user_file_path(&file_path, None, false, true)?;
    let store = state.controller.context.store.clone();
    tokio::task::spawn_blocking(move || {
        let bytes = store.extract_raw_body_bytes(session_id, is_response)?;
        write_raw_bytes_to_file(&validated_path, &bytes)
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Save body task join error: {e}")))?
}

#[tauri::command]
pub async fn export_settings_file(
    file_path: String,
    contents: String,
) -> Result<usize, ProxyError> {
    let validated_path =
        validate_user_file_path(&file_path, Some(&["json", "yaml", "yml"]), false, true)?;
    tokio::task::spawn_blocking(move || {
        write_raw_bytes_to_file(&validated_path, contents.as_bytes())
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Export settings task join error: {e}")))?
}

#[tauri::command]
pub async fn export_text_file(
    file_path: String,
    contents: String,
) -> Result<usize, ProxyError> {
    let validated_path =
        validate_user_file_path(&file_path, Some(ALLOWED_TEXT_EXPORT_EXTENSIONS), false, true)?;
    tokio::task::spawn_blocking(move || {
        write_raw_bytes_to_file(&validated_path, contents.as_bytes())
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Export text file task join error: {e}")))?
}

fn read_bounded_settings_file(path: &Path) -> Result<String, ProxyError> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_SETTINGS_FILE_BYTES {
        return Err(ProxyError::Custom(format!(
            "Размер файла настроек {} ({} байт) превышает допустимый лимит ({MAX_SETTINGS_FILE_BYTES} байт)",
            path.display(),
            meta.len()
        )));
    }
    let bytes = crate::storage::export_import::read_bounded_file(path, MAX_SETTINGS_FILE_BYTES)?;
    let raw = String::from_utf8(bytes).map_err(|e| {
        ProxyError::Custom(format!(
            "Файл настроек {} содержит некорректную UTF-8 кодировку: {e}",
            path.display()
        ))
    })?;
    Ok(raw.trim_start_matches('\u{feff}').to_owned())
}

#[tauri::command]
pub async fn import_settings_file(file_path: String) -> Result<String, ProxyError> {
    let validated_path = validate_user_file_path(&file_path, Some(&["json"]), true, true)?;
    tokio::task::spawn_blocking(move || read_bounded_settings_file(&validated_path))
        .await
        .map_err(|e| ProxyError::Custom(format!("Import settings task join error: {e}")))?
}

#[tauri::command]
pub async fn set_python_script(
    code: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<PythonRunnerStatus, ProxyError> {
    state
        .controller
        .context
        .script_runner
        .set_script(code, enabled)
        .await
}

#[tauri::command]
pub async fn get_python_runner_status(
    state: State<'_, AppState>,
) -> Result<PythonRunnerStatus, ProxyError> {
    Ok(state.controller.context.script_runner.get_status().await)
}

#[tauri::command]
pub async fn generate_stress_sessions(
    count: Option<usize>,
    state: State<'_, AppState>,
) -> Result<usize, ProxyError> {
    let target = count.unwrap_or(10_000);
    let store = state.controller.context.store.clone();
    let filters = state.controller.context.filters.clone();
    let event_tx = state.controller.context.event_tx.clone();
    let generated = run_blocking("Generate stress sessions", move || {
        store.generate_stress_sessions(target, &filters, &event_tx)
    })
    .await?;
    state.controller.context.emit_storage_stats_changed();
    Ok(generated)
}

#[tauri::command]
pub async fn get_host_remap_rules(
    state: State<'_, AppState>,
) -> Result<Vec<HostRemapRule>, ProxyError> {
    Ok(state.controller.context.host_remap.list_rules())
}

#[tauri::command]
pub async fn update_host_remap_rules(
    rules: Vec<HostRemapRule>,
    state: State<'_, AppState>,
) -> Result<Vec<HostRemapRule>, ProxyError> {
    let saved = state.controller.context.host_remap.set_rules(rules)?;
    state.controller.context.rebuild_upstream_clients();
    Ok(saved)
}

#[tauri::command]
pub async fn get_throttle_config(state: State<'_, AppState>) -> Result<ThrottleConfig, ProxyError> {
    Ok(state.controller.context.throttle.get_config())
}

#[tauri::command]
pub async fn set_throttle_config(
    config: ThrottleConfig,
    state: State<'_, AppState>,
) -> Result<ThrottleConfig, ProxyError> {
    Ok(state.controller.context.throttle.set_config(config))
}

#[tauri::command]
pub async fn get_upstream_proxy_config(
    state: State<'_, AppState>,
) -> Result<UpstreamProxyConfig, ProxyError> {
    Ok(state.controller.get_upstream_proxy_config())
}

#[tauri::command]
pub async fn set_upstream_proxy_config(
    config: UpstreamProxyConfig,
    state: State<'_, AppState>,
) -> Result<UpstreamProxyConfig, ProxyError> {
    state.controller.set_upstream_proxy_config(config)
}

#[tauri::command]
pub async fn get_upstream_timeouts(
    state: State<'_, AppState>,
) -> Result<UpstreamTimeoutConfig, ProxyError> {
    Ok(state.controller.get_upstream_timeouts())
}

#[tauri::command]
pub async fn set_upstream_timeouts(
    config: UpstreamTimeoutConfig,
    state: State<'_, AppState>,
) -> Result<UpstreamTimeoutConfig, ProxyError> {
    state.controller.set_upstream_timeouts(config)
}

#[tauri::command]
pub async fn cancel_composed_request(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<bool, ProxyError> {
    Ok(state.controller.cancel_composed_request(&request_id))
}

#[tauri::command]
pub async fn inject_websocket_frame(
    session_id: u64,
    direction: WsInjectDirection,
    opcode: WsInjectOpcode,
    payload: String,
    state: State<'_, AppState>,
) -> Result<WebSocketFrameRecord, ProxyError> {
    state
        .controller
        .context
        .inject_websocket_frame(session_id, direction, opcode, payload)
        .await
}

#[cfg(test)]
mod tests {
    use super::{read_bounded_settings_file, validate_user_file_path, MAX_SETTINGS_FILE_BYTES};

    #[test]
    fn validates_user_file_paths_and_extensions() {
        assert!(validate_user_file_path("", Some(&["har"]), false, false).is_err());
        assert!(validate_user_file_path("   ", None, false, false).is_err());
        assert!(validate_user_file_path("capture.har\0.exe", Some(&["har"]), false, false).is_err());
        assert!(validate_user_file_path("some/dir/", None, false, false).is_err());
        assert!(validate_user_file_path("some/dir/..", None, false, false).is_err());
        assert!(validate_user_file_path("capture.exe", Some(&["har", "saz"]), false, false).is_err());
        assert!(validate_user_file_path("capture", Some(&["har", "saz"]), false, false).is_err());

        let valid_har =
            validate_user_file_path("exports/trace.HAR", Some(&["har", "saz"]), false, false)
                .expect("valid extension case-insensitive");
        assert!(valid_har.ends_with("trace.HAR"));

        let valid_body = validate_user_file_path("payload.bin", None, false, false)
            .expect("unrestricted save body path");
        assert!(valid_body.ends_with("payload.bin"));
    }

    #[test]
    fn sec02_rejects_parent_traversal_unc_ntfs_ads_and_dos_device_names() {
        // 1. Parent directory traversal
        assert!(validate_user_file_path("a/../../etc/passwd", None, false, false).is_err());
        assert!(validate_user_file_path("../a.json", Some(&["json"]), false, false).is_err());
        assert!(validate_user_file_path("a/b/../c.json", Some(&["json"]), false, false).is_err());
        assert!(validate_user_file_path(r"a\..\b.json", Some(&["json"]), false, false).is_err());

        // 2. UNC & device namespaces
        assert!(
            validate_user_file_path(r"\\attacker\share\a.json", Some(&["json"]), false, false)
                .is_err()
        );
        assert!(
            validate_user_file_path("//attacker/share/a.json", Some(&["json"]), false, false)
                .is_err()
        );
        assert!(
            validate_user_file_path(
                r"\\?\UNC\attacker\share\a.json",
                Some(&["json"]),
                false,
                false
            )
            .is_err()
        );
        assert!(
            validate_user_file_path(r"\\.\pipe\a.json", Some(&["json"]), false, false).is_err()
        );

        // 3. NTFS Alternate Data Streams (:)
        assert!(validate_user_file_path("file.json:ads", None, false, false).is_err());
        assert!(
            validate_user_file_path("dir:ads/file.json", Some(&["json"]), false, false).is_err()
        );

        // 4. Reserved DOS device names
        for reserved in [
            "CON.json",
            "con",
            "PRN.har",
            "AUX.saz",
            "NUL.txt",
            "COM1.json",
            "COM9.json",
            "LPT1.json",
            "lpt9.har",
            "dir/CON.json",
        ] {
            assert!(
                validate_user_file_path(reserved, None, false, false).is_err(),
                "must reject reserved DOS device path: {reserved}"
            );
        }

        // 5. Legitimate lookalike filenames remain accepted
        for safe in ["config.json", "console.har", "null.json", "com10.json"] {
            assert!(
                validate_user_file_path(safe, None, false, false).is_ok(),
                "must allow safe lookalike path: {safe}"
            );
        }
    }

    #[test]
    fn sec02_import_settings_file_enforces_16mib_limit_and_strips_bom() {
        let dir = std::env::temp_dir().join(format!(
            "fluxproxy_sec02_settings_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let small_path = dir.join("valid-settings.json");
        std::fs::write(&small_path, "\u{feff}{\"schemaVersion\":1}").unwrap();
        let validated_small = validate_user_file_path(
            &small_path.display().to_string(),
            Some(&["json"]),
            true,
            false,
        )
        .unwrap();
        let content = read_bounded_settings_file(&validated_small).unwrap();
        assert_eq!(content, "{\"schemaVersion\":1}");

        let huge_path = dir.join("oversized-settings.json");
        let file = std::fs::File::create(&huge_path).unwrap();
        file.set_len(MAX_SETTINGS_FILE_BYTES + 1).unwrap();
        drop(file);

        let validated_huge = validate_user_file_path(
            &huge_path.display().to_string(),
            Some(&["json"]),
            true,
            false,
        )
        .unwrap();
        let err = read_bounded_settings_file(&validated_huge)
            .expect_err("must reject settings file exceeding 16 MiB");
        assert!(err.to_string().contains("превышает допустимый лимит"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sec04_authorized_dialog_registry_enforces_fifo_capacity_128() {
        use super::{AuthorizedDialogPathRegistry, MAX_AUTHORIZED_DIALOG_PATHS};

        assert_eq!(MAX_AUTHORIZED_DIALOG_PATHS, 128);
        let mut reg = AuthorizedDialogPathRegistry::new(MAX_AUTHORIZED_DIALOG_PATHS);

        for i in 0..130 {
            reg.register(format!("c:\\tmp\\export_{i}.txt"));
        }

        assert!(!reg.contains("c:\\tmp\\export_0.txt"));
        assert!(!reg.contains("c:\\tmp\\export_1.txt"));
        for i in 2..130 {
            assert!(
                reg.contains(&format!("c:\\tmp\\export_{i}.txt")),
                "expected entry {i} to remain in bounded FIFO registry"
            );
        }

        // Re-registering an existing path refreshes its FIFO position without duplicating
        reg.register("c:\\tmp\\export_2.txt".to_string());
        reg.register("c:\\tmp\\export_130.txt".to_string());
        assert!(reg.contains("c:\\tmp\\export_2.txt"));
        assert!(!reg.contains("c:\\tmp\\export_3.txt"));
    }

    #[tokio::test]
    async fn sec04_dialog_tokens_and_export_text_file_enforce_authorization_and_extensions() {
        use super::{
            export_text_file, register_authorized_dialog_path, validate_user_file_path,
        };

        let dir = std::env::temp_dir().join(format!(
            "fluxproxy_sec04_dialog_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let unauthorized_txt = dir.join("unauthorized.txt");
        assert!(validate_user_file_path(
            &unauthorized_txt.display().to_string(),
            Some(&["txt"]),
            false,
            true
        )
        .is_err());

        let unauth_export = export_text_file(
            unauthorized_txt.display().to_string(),
            "secret".to_string(),
        )
        .await;
        assert!(
            unauth_export.is_err(),
            "export_text_file must reject unregistered paths"
        );
        assert!(!unauthorized_txt.exists());

        // Authorized text export extensions succeed
        for (ext, content) in [
            ("txt", "plain text report"),
            ("md", "# Markdown Report"),
            ("json", "{\"openapi\":\"3.0.3\"}"),
            ("yaml", "openapi: 3.0.3\n"),
            ("yml", "openapi: 3.0.3\n"),
        ] {
            let p = dir.join(format!("authorized.{ext}"));
            register_authorized_dialog_path(&p);
            let written = export_text_file(p.display().to_string(), content.to_string())
                .await
                .unwrap_or_else(|e| panic!("expected .{ext} export to succeed: {e}"));
            assert_eq!(written, content.len());
            assert_eq!(std::fs::read_to_string(&p).unwrap(), content);
        }

        // Disallowed extensions (.bat, .exe, .ps1) must be rejected even if registered in dialog cache
        for bad_ext in ["bat", "exe", "ps1"] {
            let bad_path = dir.join(format!("payload.{bad_ext}"));
            register_authorized_dialog_path(&bad_path);
            let err = export_text_file(bad_path.display().to_string(), "echo pwn".to_string())
                .await
                .expect_err("disallowed extension must fail");
            assert!(err.to_string().contains("Недопустимое расширение файла"));
            assert!(!bad_path.exists());
        }

        // Case/slash normalization test on Windows (and exact path on Unix)
        let norm_target = dir.join("mixed_Case_Report.MD");
        register_authorized_dialog_path(&norm_target);
        #[cfg(target_os = "windows")]
        let variant = norm_target.display().to_string().replace('\\', "/").to_uppercase();
        #[cfg(not(target_os = "windows"))]
        let variant = norm_target.display().to_string();
        assert!(validate_user_file_path(&variant, Some(&["md"]), false, true).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
