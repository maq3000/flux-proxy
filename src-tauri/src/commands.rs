use std::path::PathBuf;
use std::sync::Arc;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::models::{
    AutoResponderRule, BreakpointAction, BreakpointConfig, BreakpointResolution,
    CaCertificateInfo, CodecOperation, CodecTransformResult, ComposedRequest, LoadedSessionBody,
    NetworkInterfaceInfo, PausedBreakpointItem, ProxyError, ProxyFilterBackendConfig, ProxyStatus,
    SessionDetail, SessionSummary, StorageStats,
};
use crate::proxy::codec::execute_codec_transform;
use crate::proxy::network::list_network_interfaces;
use crate::proxy::server::ProxyEngineController;
use crate::storage::export_import::{
    export_sessions_to_path, import_sessions_from_bytes, import_sessions_from_path,
    write_raw_bytes_to_file,
};

pub struct AppState {
    pub controller: Arc<ProxyEngineController>,
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
    let bind_host = host.unwrap_or_else(|| state.controller.preferred_bind_host());
    let bind_port = port.unwrap_or(8888);
    state.controller.start(bind_host, bind_port).await
}

#[tauri::command]
pub async fn set_allow_remote(
    allow: bool,
    state: State<'_, AppState>,
) -> Result<ProxyStatus, ProxyError> {
    state.controller.set_allow_remote(allow).await
}

#[tauri::command]
pub async fn get_network_interfaces() -> Result<Vec<NetworkInterfaceInfo>, ProxyError> {
    Ok(list_network_interfaces())
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
pub async fn get_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, ProxyError> {
    Ok(state.controller.context.store.list_summaries())
}

#[tauri::command]
pub async fn get_session_detail(
    id: u64,
    state: State<'_, AppState>,
) -> Result<Option<SessionDetail>, ProxyError> {
    Ok(state.controller.context.store.get(id))
}

#[tauri::command]
pub async fn clear_sessions(state: State<'_, AppState>) -> Result<(), ProxyError> {
    state.controller.context.store.clear();
    Ok(())
}

#[tauri::command]
pub async fn delete_sessions(
    ids: Vec<u64>,
    state: State<'_, AppState>,
) -> Result<usize, ProxyError> {
    Ok(state.controller.context.store.remove_many(&ids))
}

#[tauri::command]
pub async fn save_sessions_sqlite(state: State<'_, AppState>) -> Result<usize, ProxyError> {
    state.controller.context.store.save_all_to_sqlite()
}

#[tauri::command]
pub async fn load_sessions_sqlite(
    state: State<'_, AppState>,
) -> Result<Vec<SessionSummary>, ProxyError> {
    state.controller.context.store.load_from_sqlite()
}

#[tauri::command]
pub async fn update_session_annotations(
    ids: Vec<u64>,
    comment: Option<String>,
    marked_color: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<SessionSummary>, ProxyError> {
    let updated = state
        .controller
        .context
        .store
        .update_annotations(&ids, comment, marked_color)?;
    for summary in &updated {
        let _ = state.controller.context.event_tx.send(summary.clone());
    }
    Ok(updated)
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
pub async fn codec_transform(
    operation: CodecOperation,
    input: String,
    input_is_base64: Option<bool>,
) -> Result<CodecTransformResult, ProxyError> {
    execute_codec_transform(operation, &input, input_is_base64.unwrap_or(false))
}

#[tauri::command]
pub async fn set_session_retention_limit(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<(), ProxyError> {
    state.controller.context.store.set_retention_limit(limit)
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
    Ok(())
}

#[tauri::command]
pub async fn get_memory_storage_stats(
    state: State<'_, AppState>,
) -> Result<StorageStats, ProxyError> {
    let drop_enabled = state
        .controller
        .context
        .filters
        .is_drop_non_matching_enabled();
    Ok(state.controller.context.store.storage_stats(drop_enabled))
}

#[tauri::command]
pub async fn load_session_body(
    id: u64,
    is_response: bool,
    state: State<'_, AppState>,
) -> Result<LoadedSessionBody, ProxyError> {
    state
        .controller
        .context
        .store
        .load_session_body(id, is_response)
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
        Ok(dialog
            .save_file()
            .map(|p| p.to_string_lossy().into_owned()))
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
        Ok(dialog
            .pick_file()
            .map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Native open dialog join error: {e}")))?
}

#[tauri::command]
pub async fn export_sessions_file(
    session_ids: Vec<u64>,
    format: String,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<usize, ProxyError> {
    let store = state.controller.context.store.clone();
    tokio::task::spawn_blocking(move || {
        let sessions = store.collect_sessions_for_export(&session_ids)?;
        export_sessions_to_path(&sessions, &format, &PathBuf::from(file_path))
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Export task join error: {e}")))?
}

#[tauri::command]
pub async fn import_sessions_file(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<SessionSummary>, ProxyError> {
    let store = state.controller.context.store.clone();
    let event_tx = state.controller.context.event_tx.clone();
    tokio::task::spawn_blocking(move || {
        let details = import_sessions_from_path(&PathBuf::from(file_path))?;
        let summaries = store.import_sessions(details);
        for summary in &summaries {
            let _ = event_tx.send(summary.clone());
        }
        Ok(summaries)
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Import task join error: {e}")))?
}

#[tauri::command]
pub async fn import_sessions_bytes(
    file_name: String,
    data_base64: String,
    state: State<'_, AppState>,
) -> Result<Vec<SessionSummary>, ProxyError> {
    let store = state.controller.context.store.clone();
    let event_tx = state.controller.context.event_tx.clone();
    tokio::task::spawn_blocking(move || {
        let cleaned: String = data_base64.chars().filter(|c| !c.is_whitespace()).collect();
        let raw_bytes = base64::engine::general_purpose::STANDARD
            .decode(&cleaned)
            .map_err(|e| ProxyError::Custom(format!("Invalid Base64 archive payload: {e}")))?;
        let details = import_sessions_from_bytes(&file_name, &raw_bytes)?;
        let summaries = store.import_sessions(details);
        for summary in &summaries {
            let _ = event_tx.send(summary.clone());
        }
        Ok(summaries)
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Import bytes task join error: {e}")))?
}

#[tauri::command]
pub async fn save_session_body_file(
    session_id: u64,
    is_response: bool,
    file_path: String,
    state: State<'_, AppState>,
) -> Result<usize, ProxyError> {
    let store = state.controller.context.store.clone();
    tokio::task::spawn_blocking(move || {
        let bytes = store.extract_raw_body_bytes(session_id, is_response)?;
        write_raw_bytes_to_file(&PathBuf::from(file_path), &bytes)
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Save body task join error: {e}")))?
}
