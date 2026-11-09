pub mod commands;
pub mod models;
pub mod proxy;
pub mod storage;

use std::sync::Arc;
use tauri::Manager;

use crate::commands::AppState;
use crate::proxy::ca::CertificateAuthority;
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
                .unwrap_or_else(|_| std::env::temp_dir().join("fluxproxy"));

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

            let controller = Arc::new(
                ProxyEngineController::new(
                    ca,
                    rules,
                    filters,
                    store,
                    sysproxy,
                    app.handle().clone(),
                )
                .expect("Failed to create ProxyEngineController"),
            );

            // Auto-start proxy listener on preferred bind host (127.0.0.1 or 0.0.0.0 if Remote Devices is enabled)
            let startup_controller = controller.clone();
            tauri::async_runtime::spawn(async move {
                let bind_host = startup_controller.preferred_bind_host();
                if let Err(err) = startup_controller.start(bind_host.clone(), 8888).await {
                    tracing::warn!("Could not auto-bind {bind_host}:8888 on startup: {err}");
                }
            });

            app.manage(AppState { controller });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                if let Some(state) = window.try_state::<AppState>() {
                    state.controller.shutdown_sync();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_proxy_status,
            commands::start_proxy,
            commands::stop_proxy,
            commands::set_allow_remote,
            commands::get_network_interfaces,
            commands::set_system_proxy,
            commands::set_auto_system_proxy,
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
            commands::list_rules,
            commands::upsert_rule,
            commands::delete_rule,
            commands::execute_composed_request,
            commands::get_filter_backend_config,
            commands::update_filter_backend_config,
            commands::get_breakpoint_config,
            commands::update_breakpoint_config,
            commands::list_paused_breakpoints,
            commands::resolve_breakpoint,
            commands::resume_all_breakpoints,
            commands::codec_transform,
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
            }
        }
    });
}
