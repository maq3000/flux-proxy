pub mod commands;
pub mod models;
pub mod proxy;
pub mod scripting;
pub mod storage;

use std::sync::Arc;
use tauri::Manager;

use crate::commands::AppState;
use crate::proxy::ca::CertificateAuthority;
use crate::proxy::client_certs::ClientCertificateStore;
use crate::proxy::filters::ProxyFilterEngine;
use crate::proxy::rules::RuleEngine;
use crate::proxy::server::ProxyEngineController;
use crate::proxy::sysproxy::{install_panic_hook_rollback, SystemProxyManager};
use crate::storage::TrafficStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "flux_proxy_lib=info,warn".into()),
        )
        .init();

    let app = tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .or_else(|_| app.path().app_local_data_dir())
                .map_err(|e| {
                    format!("Failed to resolve secure application data directory for Root CA: {e}")
                })?;

            let sysproxy = Arc::new(SystemProxyManager::new(&app_data_dir));
            install_panic_hook_rollback(sysproxy.clone());

            let ca = Arc::new(
                CertificateAuthority::init_or_load(&app_data_dir)
                    .expect("Failed to initialize FluxProxy Root CA"),
            );
            let rules = Arc::new(RuleEngine::new());
            let filters = Arc::new(ProxyFilterEngine::new());
            let store = Arc::new(
                TrafficStore::new(app_data_dir.join("sessions.sqlite"))
                    .expect("Failed to initialize SQLite TrafficStore"),
            );
            let client_certs = Arc::new(
                ClientCertificateStore::init_or_load(&app_data_dir)
                    .expect("Failed to initialize ClientCertificateStore"),
            );

            let controller = Arc::new(
                ProxyEngineController::new(
                    ca,
                    rules,
                    filters,
                    store,
                    sysproxy,
                    client_certs,
                    app.handle().clone(),
                )
                .expect("Failed to create ProxyEngineController"),
            );

            // Auto-start proxy listener using saved port & bind configuration (Loopback, AllInterfaces, or Specific + Dual Listener)
            let startup_controller = controller.clone();
            tauri::async_runtime::spawn(async move {
                let startup_port = startup_controller.preferred_port();
                if let Err(err) = startup_controller.start_with_config(startup_port).await {
                    let bind_host = startup_controller.preferred_bind_host();
                    tracing::warn!(
                        "Could not auto-bind {bind_host}:{startup_port} on startup: {err}"
                    );
                }
            });

            app.manage(AppState { controller });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                if let Some(state) = window.try_state::<AppState>() {
                    state.controller.shutdown_sync();
                }
            }
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                for path in paths {
                    commands::register_authorized_dialog_path(path);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_proxy_status,
            commands::start_proxy,
            commands::stop_proxy,
            commands::set_proxy_port,
            commands::set_allow_remote,
            commands::set_bind_configuration,
            commands::get_network_interfaces,
            commands::set_system_proxy,
            commands::set_auto_system_proxy,
            commands::run_proxy_doctor,
            commands::fix_doctor_issue,
            commands::get_sessions,
            commands::get_session_detail,
            commands::clear_sessions,
            commands::delete_sessions,
            commands::save_sessions_sqlite,
            commands::load_sessions_sqlite,
            commands::update_session_annotations,
            commands::get_ca_info,
            commands::install_root_ca,
            commands::uninstall_root_ca,
            commands::list_client_certificates,
            commands::add_client_certificate,
            commands::toggle_client_certificate,
            commands::remove_client_certificate,
            commands::list_rules,
            commands::upsert_rule,
            commands::delete_rule,
            commands::get_autoresponder_enabled,
            commands::set_autoresponder_enabled,
            commands::set_autoresponder_config,
            commands::execute_composed_request,
            commands::cancel_composed_request,
            commands::get_upstream_timeouts,
            commands::set_upstream_timeouts,
            commands::get_filter_backend_config,
            commands::update_filter_backend_config,
            commands::update_proxy_filter_config,
            commands::get_tls_rule_hit_counts,
            commands::reset_tls_bypass_rules_to_recommended,
            commands::get_breakpoint_config,
            commands::update_breakpoint_config,
            commands::list_paused_breakpoints,
            commands::resolve_breakpoint,
            commands::resume_all_breakpoints,
            commands::codec_transform,
            commands::set_session_retention_limit,
            commands::set_drop_non_matching,
            commands::get_memory_storage_stats,
            commands::clear_sqlite_database,
            commands::get_clear_db_on_exit,
            commands::set_clear_db_on_exit,
            commands::load_session_body,
            commands::export_sessions_file,
            commands::import_sessions_file,
            commands::import_sessions_bytes,
            commands::save_session_body_file,
            commands::export_settings_file,
            commands::export_text_file,
            commands::import_settings_file,
            commands::pick_save_file_dialog,
            commands::pick_open_file_dialog,
            commands::set_python_script,
            commands::get_python_runner_status,
            commands::generate_stress_sessions,
            commands::get_host_remap_rules,
            commands::update_host_remap_rules,
            commands::get_throttle_config,
            commands::set_throttle_config,
            commands::get_upstream_proxy_config,
            commands::set_upstream_proxy_config,
            commands::inject_websocket_frame,
        ])
        .build(tauri::generate_context!())
        .expect("error while building FluxProxy Tauri application");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.controller.shutdown_sync();
                if matches!(event, tauri::RunEvent::Exit)
                    && state.controller.context.store.clear_db_on_exit()
                {
                    let drop_enabled = state
                        .controller
                        .context
                        .filters
                        .is_drop_non_matching_enabled();
                    state
                        .controller
                        .context
                        .store
                        .purge_on_exit_once(drop_enabled);
                }
            }
        }
    });
}

#[cfg(all(test, target_os = "windows"))]
#[link(name = "resource")]
extern "C" {}
