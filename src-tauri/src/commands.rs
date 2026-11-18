use std::path::PathBuf;
use std::sync::Arc;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::models::{
    AutoResponderRule, BindHostMode, BreakpointAction, BreakpointConfig, BreakpointResolution,
    CaCertificateInfo, CodecOperation, CodecTransformResult, ComposedRequest, DoctorCheckResult,
    LoadedSessionBody, NetworkInterfaceInfo, PausedBreakpointItem, ProxyError,
    ProxyFilterBackendConfig, ProxyStatus, SanitizationOptions, SessionDetail, SessionSummary,
    StorageStats,
};
use crate::proxy::codec::execute_codec_transform;
use crate::proxy::network::list_network_interfaces_with_options;
use crate::proxy::server::ProxyEngineController;
use crate::storage::export_import::{
    export_sessions_to_path, import_sessions_from_bytes, import_sessions_from_path,
    sanitize_sessions, write_raw_bytes_to_file,
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
    let bind_port = port.unwrap_or(8888);
    match host.map(|h| h.trim().to_string()).filter(|h| !h.is_empty()) {
        Some(explicit_host) => state.controller.start(explicit_host, bind_port).await,
        None => state.controller.start_with_config(bind_port).await,
    }
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

pub(crate) fn validate_user_file_path(
    raw_path: &str,
    allowed_extensions: Option<&[&str]>,
    must_exist: bool,
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

    let path = PathBuf::from(trimmed);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .ok_or_else(|| ProxyError::Custom("Некорректное имя файла в пути.".into()))?;
    if file_name.trim().is_empty() {
        return Err(ProxyError::Custom("Некорректное имя файла в пути.".into()));
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
    state: State<'_, AppState>,
) -> Result<usize, ProxyError> {
    let validated_path =
        validate_user_file_path(&file_path, Some(&["har", "saz", "json", "txt", "raw"]), false)?;
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

    let store = state.controller.context.store.clone();
    tokio::task::spawn_blocking(move || {
        let sessions = store.collect_sessions_for_export(&session_ids)?;
        let effective_sessions = match sanitization.as_ref() {
            Some(opts) => sanitize_sessions(&sessions, opts),
            None => sessions,
        };
        export_sessions_to_path(&effective_sessions, &format, &validated_path)
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
        validate_user_file_path(&file_path, Some(&["har", "saz", "json", "zip"]), true)?;
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
    let validated_path = validate_user_file_path(&file_path, None, false)?;
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
    let validated_path = validate_user_file_path(&file_path, Some(&["json"]), false)?;
    tokio::task::spawn_blocking(move || {
        write_raw_bytes_to_file(&validated_path, contents.as_bytes())
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Export settings task join error: {e}")))?
}

#[tauri::command]
pub async fn import_settings_file(file_path: String) -> Result<String, ProxyError> {
    let validated_path = validate_user_file_path(&file_path, Some(&["json"]), true)?;
    tokio::task::spawn_blocking(move || {
        let raw = std::fs::read_to_string(&validated_path)
            .map_err(|e| ProxyError::Custom(format!("Не удалось прочитать файл {}: {e}", validated_path.display())))?;
        Ok(raw.trim_start_matches('\u{feff}').to_owned())
    })
    .await
    .map_err(|e| ProxyError::Custom(format!("Import settings task join error: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::validate_user_file_path;

    #[test]
    fn validates_user_file_paths_and_extensions() {
        assert!(validate_user_file_path("", Some(&["har"]), false).is_err());
        assert!(validate_user_file_path("   ", None, false).is_err());
        assert!(validate_user_file_path("capture.har\0.exe", Some(&["har"]), false).is_err());
        assert!(validate_user_file_path("some/dir/", None, false).is_err());
        assert!(validate_user_file_path("some/dir/..", None, false).is_err());
        assert!(validate_user_file_path("capture.exe", Some(&["har", "saz"]), false).is_err());
        assert!(validate_user_file_path("capture", Some(&["har", "saz"]), false).is_err());

        let valid_har = validate_user_file_path("exports/trace.HAR", Some(&["har", "saz"]), false)
            .expect("valid extension case-insensitive");
        assert!(valid_har.ends_with("trace.HAR"));

        let valid_body = validate_user_file_path("payload.bin", None, false)
            .expect("unrestricted save body path");
        assert!(valid_body.ends_with("payload.bin"));
    }
}
