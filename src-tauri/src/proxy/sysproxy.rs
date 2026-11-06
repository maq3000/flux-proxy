use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::models::ProxyError;

pub const BACKUP_FILE_NAME: &str = "system-proxy-backup.json";
pub const PREFS_FILE_NAME: &str = "system-proxy-prefs.json";
pub const DEFAULT_WINDOWS_PROXY_OVERRIDE: &str = "localhost;127.*;10.*;192.168.*;<local>";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowsProxySnapshot {
    pub proxy_enable: Option<u32>,
    pub proxy_server: Option<String>,
    pub proxy_override: Option<String>,
    pub auto_config_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacServiceProxySnapshot {
    pub service: String,
    pub web_enabled: bool,
    pub web_server: String,
    pub web_port: u16,
    pub secure_web_enabled: bool,
    pub secure_web_server: String,
    pub secure_web_port: u16,
    pub bypass_domains: Vec<String>,
    pub auto_proxy_enabled: bool,
    pub auto_proxy_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MacProxySnapshot {
    pub services: Vec<MacServiceProxySnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxProxySnapshot {
    pub mode: String,
    pub http_host: String,
    pub http_port: u16,
    pub https_host: String,
    pub https_port: u16,
    pub ignore_hosts: String,
    pub autoconfig_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "camelCase")]
pub enum PlatformProxySnapshot {
    Windows(WindowsProxySnapshot),
    Macos(MacProxySnapshot),
    Linux(LinuxProxySnapshot),
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyBackup {
    pub version: u32,
    pub saved_at: String,
    pub flux_endpoint: String,
    pub snapshot: PlatformProxySnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSystemProxyPrefs {
    #[serde(default = "default_auto_system_proxy")]
    pub auto_system_proxy: bool,
    #[serde(default)]
    pub allow_remote: bool,
}

fn default_auto_system_proxy() -> bool {
    true
}

impl Default for PersistedSystemProxyPrefs {
    fn default() -> Self {
        Self {
            auto_system_proxy: true,
            allow_remote: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsActiveProxyState {
    pub matches_flux: bool,
    pub any_proxy_enabled: bool,
    pub current_target_summary: String,
}

pub trait OsProxyBackend: Send + Sync {
    fn capture_snapshot(&self) -> Result<PlatformProxySnapshot, ProxyError>;

    fn apply_system_proxy(
        &self,
        host: &str,
        port: u16,
        baseline: &PlatformProxySnapshot,
    ) -> Result<(), ProxyError>;

    fn restore_snapshot(&self, snapshot: &PlatformProxySnapshot) -> Result<(), ProxyError>;

    fn inspect_active_state(
        &self,
        expected_host: &str,
        expected_port: u16,
    ) -> Result<OsActiveProxyState, ProxyError>;
}

struct NativeOsProxyBackend;

impl OsProxyBackend for NativeOsProxyBackend {
    fn capture_snapshot(&self) -> Result<PlatformProxySnapshot, ProxyError> {
        platform::capture_snapshot()
    }

    fn apply_system_proxy(
        &self,
        host: &str,
        port: u16,
        baseline: &PlatformProxySnapshot,
    ) -> Result<(), ProxyError> {
        platform::apply_system_proxy(host, port, baseline)
    }

    fn restore_snapshot(&self, snapshot: &PlatformProxySnapshot) -> Result<(), ProxyError> {
        platform::restore_snapshot(snapshot)
    }

    fn inspect_active_state(
        &self,
        expected_host: &str,
        expected_port: u16,
    ) -> Result<OsActiveProxyState, ProxyError> {
        platform::inspect_active_state(expected_host, expected_port)
    }
}

struct ManagerInner {
    desired_enabled: bool,
    active_target: (String, u16),
    backup: Option<SystemProxyBackup>,
    last_error: Option<String>,
}

pub struct SystemProxyManager {
    backup_path: PathBuf,
    prefs_path: PathBuf,
    backend: Arc<dyn OsProxyBackend>,
    inner: Mutex<ManagerInner>,
}

impl SystemProxyManager {
    pub fn new(app_data_dir: &Path) -> Self {
        Self::with_backend(app_data_dir, Arc::new(NativeOsProxyBackend))
    }

    pub fn with_backend(app_data_dir: &Path, backend: Arc<dyn OsProxyBackend>) -> Self {
        let backup_path = app_data_dir.join(BACKUP_FILE_NAME);
        let prefs_path = app_data_dir.join(PREFS_FILE_NAME);
        let recovered_backup = Self::read_backup_file_opt(&backup_path);
        if recovered_backup.is_some() {
            tracing::warn!(
                "Found existing {} from an unclean shutdown; preserving pre-crash OS proxy snapshot for safe rollback.",
                backup_path.display()
            );
        }

        Self {
            backup_path,
            prefs_path,
            backend,
            inner: Mutex::new(ManagerInner {
                desired_enabled: false,
                active_target: ("127.0.0.1".to_string(), 8888),
                backup: recovered_backup,
                last_error: None,
            }),
        }
    }

    pub fn backup_file_path(&self) -> &Path {
        &self.backup_path
    }

    fn load_prefs(&self) -> PersistedSystemProxyPrefs {
        let Ok(raw) = fs::read_to_string(&self.prefs_path) else {
            return PersistedSystemProxyPrefs::default();
        };
        serde_json::from_str::<PersistedSystemProxyPrefs>(&raw).unwrap_or_default()
    }

    fn save_prefs(&self, prefs: &PersistedSystemProxyPrefs) {
        if let Some(parent) = self.prefs_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(prefs) {
            let _ = fs::write(&self.prefs_path, json);
        }
    }

    pub fn load_auto_system_proxy_pref(&self) -> bool {
        self.load_prefs().auto_system_proxy
    }

    pub fn save_auto_system_proxy_pref(&self, auto: bool) {
        let mut prefs = self.load_prefs();
        prefs.auto_system_proxy = auto;
        self.save_prefs(&prefs);
    }

    pub fn load_allow_remote_pref(&self) -> bool {
        self.load_prefs().allow_remote
    }

    pub fn save_allow_remote_pref(&self, allow_remote: bool) {
        let mut prefs = self.load_prefs();
        prefs.allow_remote = allow_remote;
        self.save_prefs(&prefs);
    }

    /// Enables the OS system proxy pointing to `normalize_sysproxy_host(host):port`.
    /// Crash-recovery guarantee:
    /// 1. If `system-proxy-backup.json` already exists on disk (or in memory), it is NEVER overwritten.
    /// 2. If the OS system proxy already points to FluxProxy (`127.0.0.1:8888` / `host:port`) after a crash
    ///    without a backup file, the snapshot is sanitized to a clean disabled state before saving.
    pub fn enable(&self, raw_host: &str, port: u16) -> Result<(), ProxyError> {
        let target_host = normalize_sysproxy_host(raw_host);
        let mut guard = self.lock_inner();

        let disk_backup = Self::read_backup_file_opt(&self.backup_path);
        let effective_backup = if let Some(existing_disk) = disk_backup {
            guard.backup = Some(existing_disk.clone());
            existing_disk
        } else if let Some(existing_mem) = guard.backup.clone() {
            Self::write_backup_file(&self.backup_path, &existing_mem)?;
            existing_mem
        } else {
            let current_os = self.backend.capture_snapshot()?;
            let safe_snapshot = if snapshot_points_to_self(&current_os, &target_host, port) {
                tracing::warn!(
                    "OS system proxy already points to FluxProxy ({target_host}:{port}) without backup file; sanitizing fallback snapshot to disabled."
                );
                sanitize_self_referential_snapshot(current_os, &target_host, port)
            } else {
                current_os
            };

            let created = SystemProxyBackup {
                version: 1,
                saved_at: Utc::now().to_rfc3339(),
                flux_endpoint: format!("{target_host}:{port}"),
                snapshot: safe_snapshot,
            };
            Self::write_backup_file(&self.backup_path, &created)?;
            guard.backup = Some(created.clone());
            created
        };

        match self
            .backend
            .apply_system_proxy(&target_host, port, &effective_backup.snapshot)
        {
            Ok(()) => {
                guard.desired_enabled = true;
                guard.active_target = (target_host, port);
                guard.last_error = None;
                Ok(())
            }
            Err(err) => {
                guard.desired_enabled = false;
                guard.active_target = (target_host, port);
                guard.last_error = Some(err.to_string());
                Err(err)
            }
        }
    }

    /// Restores the OS system proxy to the pre-FluxProxy snapshot and deletes `system-proxy-backup.json`.
    pub fn disable(&self) -> Result<(), ProxyError> {
        let mut guard = self.lock_inner();
        let (target_host, target_port) = guard.active_target.clone();

        let backup_to_restore = guard
            .backup
            .clone()
            .or_else(|| Self::read_backup_file_opt(&self.backup_path));

        if let Some(backup) = backup_to_restore {
            match self.backend.restore_snapshot(&backup.snapshot) {
                Ok(()) => {
                    if self.backup_path.exists() {
                        let _ = fs::remove_file(&self.backup_path);
                    }
                    guard.backup = None;
                    guard.desired_enabled = false;
                    guard.last_error = None;
                    return Ok(());
                }
                Err(err) => {
                    guard.desired_enabled = false;
                    guard.last_error = Some(format!("Не удалось откатить системный прокси ОС: {err}"));
                    return Err(err);
                }
            }
        }

        // Even if no backup file was present, ensure OS isn't left pointing to our port
        if let Ok(current_os) = self.backend.capture_snapshot() {
            if snapshot_points_to_self(&current_os, &target_host, target_port) {
                let sanitized =
                    sanitize_self_referential_snapshot(current_os, &target_host, target_port);
                if let Err(err) = self.backend.restore_snapshot(&sanitized) {
                    guard.desired_enabled = false;
                    guard.last_error = Some(format!("Не удалось отключить системный прокси ОС: {err}"));
                    return Err(err);
                }
            }
        }

        guard.desired_enabled = false;
        guard.last_error = None;
        Ok(())
    }

    /// Synchronous best-effort rollback invoked from `RunEvent::Exit`, window close, and `std::panic::set_hook`.
    pub fn rollback_sync(&self) {
        if let Err(err) = self.disable() {
            tracing::error!("Failed synchronous system proxy rollback: {err}");
        }
    }

    /// Rolls back dirty crash-leftover state if `auto_system_proxy` is disabled on startup or listener bind fails.
    pub fn rollback_if_dirty(&self) {
        let has_dirty_backup = {
            let guard = self.lock_inner();
            guard.backup.is_some() || self.backup_path.exists()
        };
        if has_dirty_backup {
            let _ = self.disable();
        }
    }

    /// Evaluates current OS proxy state against expected FluxProxy state, detecting external hijack/reset.
    pub fn status_for_listener(&self, raw_host: &str, port: u16) -> (bool, Option<String>) {
        let expected_host = normalize_sysproxy_host(raw_host);
        let mut guard = self.lock_inner();

        match self.backend.inspect_active_state(&expected_host, port) {
            Ok(os_state) => {
                if os_state.matches_flux {
                    guard.last_error = None;
                    return (true, None);
                }

                if let Some(ref err) = guard.last_error {
                    return (false, Some(err.clone()));
                }

                if guard.desired_enabled {
                    let msg = if os_state.any_proxy_enabled {
                        format!(
                            "Системный прокси перехвачен другой программой ({})",
                            os_state.current_target_summary
                        )
                    } else {
                        "Системный прокси был отключён извне (настройками ОС или VPN)".to_string()
                    };
                    return (false, Some(msg));
                }

                (false, None)
            }
            Err(err) => {
                let err_msg = guard.last_error.clone().or_else(|| {
                    if guard.desired_enabled {
                        Some(err.to_string())
                    } else {
                        None
                    }
                });
                (false, err_msg)
            }
        }
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, ManagerInner> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn read_backup_file_opt(path: &Path) -> Option<SystemProxyBackup> {
        if !path.exists() {
            return None;
        }
        let raw = fs::read_to_string(path).ok()?;
        serde_json::from_str::<SystemProxyBackup>(&raw).ok()
    }

    fn write_backup_file(path: &Path, backup: &SystemProxyBackup) -> Result<(), ProxyError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let payload = serde_json::to_string_pretty(backup)
            .map_err(|e| ProxyError::Custom(format!("Failed serializing proxy backup: {e}")))?;

        let tmp_path = path.with_extension("json.tmp");
        fs::write(&tmp_path, payload.as_bytes())?;
        if fs::rename(&tmp_path, path).is_err() {
            fs::write(path, payload.as_bytes())?;
            let _ = fs::remove_file(&tmp_path);
        }
        Ok(())
    }
}

// ============================================================================
// Global Panic Hook Registration for Crash Safety
// ============================================================================
fn global_manager_slot() -> &'static OnceLock<Arc<SystemProxyManager>> {
    static SLOT: OnceLock<Arc<SystemProxyManager>> = OnceLock::new();
    &SLOT
}

pub fn install_panic_hook_rollback(manager: Arc<SystemProxyManager>) {
    static HOOK_INSTALLED: OnceLock<()> = OnceLock::new();
    let _ = global_manager_slot().set(manager);

    HOOK_INSTALLED.get_or_init(|| {
        let prev_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic_info| {
            if let Some(mgr) = global_manager_slot().get() {
                mgr.rollback_sync();
            }
            prev_hook(panic_info);
        }));
    });
}

// ============================================================================
// Pure Cross-Platform Helpers (Host Normalization, Matching & Override Merge)
// ============================================================================
pub fn normalize_sysproxy_host(bind_host: &str) -> String {
    let trimmed = bind_host.trim();
    if trimmed.is_empty()
        || trimmed == "0.0.0.0"
        || trimmed == "::"
        || trimmed == "[::]"
        || trimmed == "::0"
    {
        "127.0.0.1".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn merge_windows_proxy_override(existing: Option<&str>) -> String {
    let Some(raw) = existing.map(str::trim).filter(|s| !s.is_empty()) else {
        return DEFAULT_WINDOWS_PROXY_OVERRIDE.to_string();
    };

    let required_prefixes = ["localhost", "127.*", "10.*", "192.168.*"];
    let mut items: Vec<String> = Vec::new();

    for token in raw.split(';').map(str::trim).filter(|t| !t.is_empty()) {
        if token.eq_ignore_ascii_case("<local>") {
            continue;
        }
        if !items.iter().any(|existing_item| existing_item.eq_ignore_ascii_case(token)) {
            items.push(token.to_string());
        }
    }

    for req in required_prefixes {
        if !items.iter().any(|existing_item| existing_item.eq_ignore_ascii_case(req)) {
            items.push(req.to_string());
        }
    }

    items.push("<local>".to_string());
    items.join(";")
}

pub fn hosts_equivalent(a: &str, b: &str) -> bool {
    let clean_a = a.trim().trim_start_matches('[').trim_end_matches(']');
    let clean_b = b.trim().trim_start_matches('[').trim_end_matches(']');
    if clean_a.eq_ignore_ascii_case(clean_b) {
        return true;
    }
    let is_loopback_a = clean_a == "127.0.0.1" || clean_a.eq_ignore_ascii_case("localhost");
    let is_loopback_b = clean_b == "127.0.0.1" || clean_b.eq_ignore_ascii_case("localhost");
    is_loopback_a && is_loopback_b
}

pub fn endpoint_matches(actual_host: &str, actual_port: u16, expected_host: &str, expected_port: u16) -> bool {
    actual_port == expected_port && hosts_equivalent(actual_host, expected_host)
}

fn single_endpoint_str_matches(raw_ep: &str, expected_host: &str, expected_port: u16) -> bool {
    let mut cleaned = raw_ep.trim();
    if let Some(rest) = cleaned.strip_prefix("http://").or_else(|| cleaned.strip_prefix("HTTP://")) {
        cleaned = rest;
    } else if let Some(rest) = cleaned.strip_prefix("https://").or_else(|| cleaned.strip_prefix("HTTPS://")) {
        cleaned = rest;
    }
    cleaned = cleaned.trim_end_matches('/');

    let Some((h, p_str)) = cleaned.rsplit_once(':') else {
        return false;
    };
    let Ok(p) = p_str.trim().parse::<u16>() else {
        return false;
    };
    endpoint_matches(h, p, expected_host, expected_port)
}

pub fn proxy_server_matches_endpoint(raw: &str, expected_host: &str, expected_port: u16) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }

    if trimmed.contains('=') {
        let mut checked_any = false;
        for part in trimmed.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            if let Some((scheme, ep)) = part.split_once('=') {
                let s = scheme.trim().to_ascii_lowercase();
                if s == "http" || s == "https" {
                    checked_any = true;
                    if !single_endpoint_str_matches(ep, expected_host, expected_port) {
                        return false;
                    }
                }
            }
        }
        return checked_any;
    }

    trimmed
        .split(';')
        .map(str::trim)
        .find(|s| !s.is_empty())
        .is_some_and(|ep| single_endpoint_str_matches(ep, expected_host, expected_port))
}

pub fn snapshot_points_to_self(snapshot: &PlatformProxySnapshot, host: &str, port: u16) -> bool {
    match snapshot {
        PlatformProxySnapshot::Windows(w) => {
            w.proxy_enable.unwrap_or(0) != 0
                && w.proxy_server.as_deref().is_some_and(|srv| {
                    proxy_server_matches_endpoint(srv, host, port)
                        || proxy_server_matches_endpoint(srv, "127.0.0.1", 8888)
                })
        }
        PlatformProxySnapshot::Macos(m) => {
            !m.services.is_empty()
                && m.services.iter().any(|svc| {
                    (svc.web_enabled
                        && (endpoint_matches(&svc.web_server, svc.web_port, host, port)
                            || endpoint_matches(&svc.web_server, svc.web_port, "127.0.0.1", 8888)))
                        || (svc.secure_web_enabled
                            && (endpoint_matches(
                                &svc.secure_web_server,
                                svc.secure_web_port,
                                host,
                                port,
                            ) || endpoint_matches(
                                &svc.secure_web_server,
                                svc.secure_web_port,
                                "127.0.0.1",
                                8888,
                            )))
                })
        }
        PlatformProxySnapshot::Linux(l) => {
            let mode = l.mode.trim().trim_matches('\'');
            let http_h = l.http_host.trim().trim_matches('\'');
            let https_h = l.https_host.trim().trim_matches('\'');
            mode.eq_ignore_ascii_case("manual")
                && (endpoint_matches(http_h, l.http_port, host, port)
                    || endpoint_matches(http_h, l.http_port, "127.0.0.1", 8888)
                    || endpoint_matches(https_h, l.https_port, host, port)
                    || endpoint_matches(https_h, l.https_port, "127.0.0.1", 8888))
        }
        PlatformProxySnapshot::Unsupported => false,
    }
}

pub fn sanitize_self_referential_snapshot(
    snapshot: PlatformProxySnapshot,
    host: &str,
    port: u16,
) -> PlatformProxySnapshot {
    match snapshot {
        PlatformProxySnapshot::Windows(mut w) => {
            w.proxy_enable = Some(0);
            w.proxy_server = None;
            if w.proxy_override
                .as_deref()
                .is_some_and(|ov| ov.eq_ignore_ascii_case(DEFAULT_WINDOWS_PROXY_OVERRIDE))
            {
                w.proxy_override = None;
            }
            PlatformProxySnapshot::Windows(w)
        }
        PlatformProxySnapshot::Macos(mut m) => {
            for svc in &mut m.services {
                if endpoint_matches(&svc.web_server, svc.web_port, host, port)
                    || endpoint_matches(&svc.web_server, svc.web_port, "127.0.0.1", 8888)
                {
                    svc.web_enabled = false;
                    svc.web_server.clear();
                    svc.web_port = 0;
                }
                if endpoint_matches(&svc.secure_web_server, svc.secure_web_port, host, port)
                    || endpoint_matches(&svc.secure_web_server, svc.secure_web_port, "127.0.0.1", 8888)
                {
                    svc.secure_web_enabled = false;
                    svc.secure_web_server.clear();
                    svc.secure_web_port = 0;
                }
            }
            PlatformProxySnapshot::Macos(m)
        }
        PlatformProxySnapshot::Linux(mut l) => {
            l.mode = "'none'".to_string();
            l.http_host = "''".to_string();
            l.http_port = 0;
            l.https_host = "''".to_string();
            l.https_port = 0;
            PlatformProxySnapshot::Linux(l)
        }
        PlatformProxySnapshot::Unsupported => PlatformProxySnapshot::Unsupported,
    }
}

// ============================================================================
// Windows Implementation (`HKCU\...\Internet Settings` + `wininet.dll`)
// ============================================================================
#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    const INTERNET_SETTINGS_SUBKEY: &str =
        "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

    type HKey = *mut c_void;
    const HKEY_CURRENT_USER: HKey = (0x8000_0001u32 as i32 as isize) as HKey;
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const KEY_SET_VALUE: u32 = 0x0002;
    const REG_SZ: u32 = 1;
    const REG_EXPAND_SZ: u32 = 2;
    const REG_BINARY: u32 = 3;
    const REG_DWORD: u32 = 4;
    const ERROR_SUCCESS: u32 = 0;
    const ERROR_FILE_NOT_FOUND: u32 = 2;

    const INTERNET_OPTION_REFRESH: u32 = 37;
    const INTERNET_OPTION_SETTINGS_CHANGED: u32 = 39;

    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            h_key: HKey,
            lp_sub_key: *const u16,
            ul_options: u32,
            sam_desired: u32,
            phk_result: *mut HKey,
        ) -> u32;

        fn RegCreateKeyExW(
            h_key: HKey,
            lp_sub_key: *const u16,
            reserved: u32,
            lp_class: *mut u16,
            dw_options: u32,
            sam_desired: u32,
            lp_security_attributes: *const c_void,
            phk_result: *mut HKey,
            lpdw_disposition: *mut u32,
        ) -> u32;

        fn RegQueryValueExW(
            h_key: HKey,
            lp_value_name: *const u16,
            lp_reserved: *mut u32,
            lp_type: *mut u32,
            lp_data: *mut u8,
            lpcb_data: *mut u32,
        ) -> u32;

        fn RegSetValueExW(
            h_key: HKey,
            lp_value_name: *const u16,
            reserved: u32,
            dw_type: u32,
            lp_data: *const u8,
            cb_data: u32,
        ) -> u32;

        fn RegDeleteValueW(h_key: HKey, lp_value_name: *const u16) -> u32;

        fn RegCloseKey(h_key: HKey) -> u32;
    }

    #[link(name = "wininet")]
    extern "system" {
        fn InternetSetOptionW(
            h_internet: *mut c_void,
            dw_option: u32,
            lp_buffer: *mut c_void,
            dw_buffer_length: u32,
        ) -> i32;
    }

    struct RegKeyGuard(HKey);

    impl Drop for RegKeyGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = RegCloseKey(self.0);
                }
            }
        }
    }

    fn to_wide_null(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn open_internet_settings_read() -> Result<Option<RegKeyGuard>, ProxyError> {
        let subkey = to_wide_null(INTERNET_SETTINGS_SUBKEY);
        let mut hkey: HKey = null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut hkey,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(ProxyError::Custom(format!(
                "RegOpenKeyExW(Internet Settings) failed with Win32 code {status}"
            )));
        }
        Ok(Some(RegKeyGuard(hkey)))
    }

    fn open_internet_settings_write() -> Result<RegKeyGuard, ProxyError> {
        let subkey = to_wide_null(INTERNET_SETTINGS_SUBKEY);
        let mut hkey: HKey = null_mut();
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                null_mut(),
                0,
                KEY_SET_VALUE | KEY_QUERY_VALUE,
                null(),
                &mut hkey,
                null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(ProxyError::Custom(format!(
                "RegCreateKeyExW(Internet Settings) failed with Win32 code {status}"
            )));
        }
        Ok(RegKeyGuard(hkey))
    }

    fn read_dword(hkey: HKey, value_name: &str) -> Result<Option<u32>, ProxyError> {
        let wide_name = to_wide_null(value_name);
        let mut reg_type: u32 = 0;
        let mut buf = [0u8; 16];
        let mut cb_data = buf.len() as u32;
        let status = unsafe {
            RegQueryValueExW(
                hkey,
                wide_name.as_ptr(),
                null_mut(),
                &mut reg_type,
                buf.as_mut_ptr(),
                &mut cb_data,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(ProxyError::Custom(format!(
                "RegQueryValueExW({value_name}) failed with Win32 code {status}"
            )));
        }
        if (reg_type == REG_DWORD || reg_type == REG_BINARY) && cb_data >= 4 {
            return Ok(Some(u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]])));
        }
        if reg_type == REG_SZ || reg_type == REG_EXPAND_SZ {
            if let Some(text) = read_string(hkey, value_name)? {
                return Ok(text.trim().parse::<u32>().ok());
            }
        }
        Ok(None)
    }

    fn read_string(hkey: HKey, value_name: &str) -> Result<Option<String>, ProxyError> {
        let wide_name = to_wide_null(value_name);
        let mut reg_type: u32 = 0;
        let mut cb_data: u32 = 0;
        let probe = unsafe {
            RegQueryValueExW(
                hkey,
                wide_name.as_ptr(),
                null_mut(),
                &mut reg_type,
                null_mut(),
                &mut cb_data,
            )
        };
        if probe == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if probe != ERROR_SUCCESS {
            return Err(ProxyError::Custom(format!(
                "RegQueryValueExW({value_name}) size probe failed with Win32 code {probe}"
            )));
        }
        if reg_type != REG_SZ && reg_type != REG_EXPAND_SZ {
            return Ok(None);
        }
        if cb_data == 0 {
            return Ok(Some(String::new()));
        }

        let mut buf = vec![0u8; (cb_data as usize).saturating_add(2)];
        let mut actual_len = buf.len() as u32;
        let status = unsafe {
            RegQueryValueExW(
                hkey,
                wide_name.as_ptr(),
                null_mut(),
                &mut reg_type,
                buf.as_mut_ptr(),
                &mut actual_len,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(ProxyError::Custom(format!(
                "RegQueryValueExW({value_name}) read failed with Win32 code {status}"
            )));
        }

        let mut wide: Vec<u16> = buf[..actual_len as usize]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        while wide.last() == Some(&0) {
            wide.pop();
        }
        Ok(Some(String::from_utf16_lossy(&wide)))
    }

    fn write_dword(hkey: HKey, value_name: &str, value: u32) -> Result<(), ProxyError> {
        let wide_name = to_wide_null(value_name);
        let bytes = value.to_le_bytes();
        let status = unsafe {
            RegSetValueExW(
                hkey,
                wide_name.as_ptr(),
                0,
                REG_DWORD,
                bytes.as_ptr(),
                bytes.len() as u32,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(ProxyError::Custom(format!(
                "RegSetValueExW({value_name}) failed with Win32 code {status}"
            )));
        }
        Ok(())
    }

    fn write_string(hkey: HKey, value_name: &str, value: &str) -> Result<(), ProxyError> {
        let wide_name = to_wide_null(value_name);
        let wide_val = to_wide_null(value);
        let cb_data = (wide_val.len() * std::mem::size_of::<u16>()) as u32;
        let status = unsafe {
            RegSetValueExW(
                hkey,
                wide_name.as_ptr(),
                0,
                REG_SZ,
                wide_val.as_ptr() as *const u8,
                cb_data,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(ProxyError::Custom(format!(
                "RegSetValueExW({value_name}) failed with Win32 code {status}"
            )));
        }
        Ok(())
    }

    fn delete_value_if_exists(hkey: HKey, value_name: &str) -> Result<(), ProxyError> {
        let wide_name = to_wide_null(value_name);
        let status = unsafe { RegDeleteValueW(hkey, wide_name.as_ptr()) };
        if status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        Err(ProxyError::Custom(format!(
            "RegDeleteValueW({value_name}) failed with Win32 code {status}"
        )))
    }

    fn notify_wininet_settings_changed() {
        unsafe {
            let changed = InternetSetOptionW(
                null_mut(),
                INTERNET_OPTION_SETTINGS_CHANGED,
                null_mut(),
                0,
            );
            let refreshed =
                InternetSetOptionW(null_mut(), INTERNET_OPTION_REFRESH, null_mut(), 0);
            if changed == 0 || refreshed == 0 {
                tracing::warn!(
                    "InternetSetOptionW returned changed={changed}, refreshed={refreshed}"
                );
            }
        }
    }

    pub fn read_windows_snapshot() -> Result<WindowsProxySnapshot, ProxyError> {
        let Some(guard) = open_internet_settings_read()? else {
            return Ok(WindowsProxySnapshot::default());
        };
        Ok(WindowsProxySnapshot {
            proxy_enable: read_dword(guard.0, "ProxyEnable")?,
            proxy_server: read_string(guard.0, "ProxyServer")?,
            proxy_override: read_string(guard.0, "ProxyOverride")?,
            auto_config_url: read_string(guard.0, "AutoConfigURL")?,
        })
    }

    pub fn capture_snapshot() -> Result<PlatformProxySnapshot, ProxyError> {
        Ok(PlatformProxySnapshot::Windows(read_windows_snapshot()?))
    }

    pub fn apply_system_proxy(
        host: &str,
        port: u16,
        baseline: &PlatformProxySnapshot,
    ) -> Result<(), ProxyError> {
        let baseline_override = match baseline {
            PlatformProxySnapshot::Windows(w) => w.proxy_override.as_deref(),
            _ => None,
        };
        let merged_override = merge_windows_proxy_override(baseline_override);
        let proxy_server = format!("{host}:{port}");

        {
            let guard = open_internet_settings_write()?;
            write_string(guard.0, "ProxyServer", &proxy_server)?;
            write_string(guard.0, "ProxyOverride", &merged_override)?;
            // Remove PAC AutoConfigURL while FluxProxy is active so WinINet/Chrome uses ProxyServer immediately;
            // it will be restored verbatim from `WindowsProxySnapshot.auto_config_url` upon disable/exit.
            delete_value_if_exists(guard.0, "AutoConfigURL")?;
            write_dword(guard.0, "ProxyEnable", 1)?;
        }

        notify_wininet_settings_changed();
        Ok(())
    }

    pub fn restore_snapshot(snapshot: &PlatformProxySnapshot) -> Result<(), ProxyError> {
        let PlatformProxySnapshot::Windows(w) = snapshot else {
            return Ok(());
        };

        {
            let guard = open_internet_settings_write()?;
            write_dword(guard.0, "ProxyEnable", w.proxy_enable.unwrap_or(0))?;

            match &w.proxy_server {
                Some(server) => write_string(guard.0, "ProxyServer", server)?,
                None => delete_value_if_exists(guard.0, "ProxyServer")?,
            }
            match &w.proxy_override {
                Some(ov) => write_string(guard.0, "ProxyOverride", ov)?,
                None => delete_value_if_exists(guard.0, "ProxyOverride")?,
            }
            match &w.auto_config_url {
                Some(pac) => write_string(guard.0, "AutoConfigURL", pac)?,
                None => delete_value_if_exists(guard.0, "AutoConfigURL")?,
            }
        }

        notify_wininet_settings_changed();
        Ok(())
    }

    pub fn inspect_active_state(
        expected_host: &str,
        expected_port: u16,
    ) -> Result<OsActiveProxyState, ProxyError> {
        let snap = read_windows_snapshot()?;
        let pac = snap
            .auto_config_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let manual_enabled = snap.proxy_enable.unwrap_or(0) != 0;
        let server_str = snap.proxy_server.as_deref().unwrap_or("").trim();

        if let Some(pac_url) = pac {
            return Ok(OsActiveProxyState {
                matches_flux: false,
                any_proxy_enabled: true,
                current_target_summary: format!("PAC {pac_url}"),
            });
        }

        if manual_enabled {
            let matches = proxy_server_matches_endpoint(server_str, expected_host, expected_port);
            let summary = if server_str.is_empty() {
                "empty ProxyServer".to_string()
            } else {
                server_str.to_string()
            };
            return Ok(OsActiveProxyState {
                matches_flux: matches,
                any_proxy_enabled: true,
                current_target_summary: summary,
            });
        }

        Ok(OsActiveProxyState {
            matches_flux: false,
            any_proxy_enabled: false,
            current_target_summary: "disabled".to_string(),
        })
    }
}

// ============================================================================
// macOS Implementation (`networksetup`)
// ============================================================================
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::process::Command;

    fn run_networksetup(args: &[&str]) -> Result<String, ProxyError> {
        let out = Command::new("networksetup").args(args).output()?;
        if !out.status.success() {
            return Err(ProxyError::Custom(format!(
                "networksetup {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn is_interface_active(device: &str) -> bool {
        let Ok(out) = Command::new("ifconfig").arg(device).output() else {
            return false;
        };
        if !out.status.success() {
            return false;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines()
            .any(|l| l.trim().eq_ignore_ascii_case("status: active"))
    }

    fn discover_active_services() -> Result<Vec<String>, ProxyError> {
        let all_raw = run_networksetup(&["-listallnetworkservices"])?;
        let enabled_services: Vec<String> = all_raw
            .lines()
            .skip(1)
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('*'))
            .map(ToOwned::to_owned)
            .collect();

        if let Ok(order_raw) = run_networksetup(&["-listnetworkserviceorder"]) {
            let mut active = Vec::new();
            let mut current_service: Option<String> = None;

            for line in order_raw.lines().map(str::trim) {
                if let Some(rest) = line.strip_prefix('(') {
                    if let Some((num, svc_name)) = rest.split_once(')') {
                        if num.trim().chars().all(|c| c.is_ascii_digit()) {
                            let clean = svc_name.trim().to_string();
                            if enabled_services.contains(&clean) {
                                current_service = Some(clean);
                            } else {
                                current_service = None;
                            }
                        }
                    }
                } else if line.starts_with("(Hardware Port:") {
                    if let Some(svc) = current_service.take() {
                        if let Some(dev_idx) = line.find("Device:") {
                            let dev = line[dev_idx + "Device:".len()..]
                                .trim_end_matches(')')
                                .trim();
                            if !dev.is_empty() && is_interface_active(dev) && !active.contains(&svc) {
                                active.push(svc);
                            }
                        }
                    }
                }
            }

            if !active.is_empty() {
                return Ok(active);
            }
        }

        Ok(enabled_services)
    }

    fn parse_proxy_output(raw: &str) -> (bool, String, u16) {
        let mut enabled = false;
        let mut server = String::new();
        let mut port = 0u16;

        for line in raw.lines() {
            if let Some((k, v)) = line.split_once(':') {
                let key = k.trim();
                let val = v.trim();
                if key.eq_ignore_ascii_case("Enabled") {
                    enabled = val.eq_ignore_ascii_case("Yes");
                } else if key.eq_ignore_ascii_case("Server") {
                    server = val.to_string();
                } else if key.eq_ignore_ascii_case("Port") {
                    port = val.parse::<u16>().unwrap_or(0);
                }
            }
        }
        (enabled, server, port)
    }

    fn snapshot_service(service: &str) -> Result<MacServiceProxySnapshot, ProxyError> {
        let web_raw = run_networksetup(&["-getwebproxy", service])?;
        let (web_enabled, web_server, web_port) = parse_proxy_output(&web_raw);

        let sec_raw = run_networksetup(&["-getsecurewebproxy", service])?;
        let (secure_web_enabled, secure_web_server, secure_web_port) = parse_proxy_output(&sec_raw);

        let bypass_raw = run_networksetup(&["-getproxybypassdomains", service]).unwrap_or_default();
        let bypass_domains: Vec<String> = bypass_raw
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("There aren't any"))
            .map(ToOwned::to_owned)
            .collect();

        let auto_raw = run_networksetup(&["-getautoproxyurl", service]).unwrap_or_default();
        let mut auto_proxy_enabled = false;
        let mut auto_proxy_url = None;
        for line in auto_raw.lines() {
            if let Some((k, v)) = line.split_once(':') {
                let key = k.trim();
                let val = v.trim();
                if key.eq_ignore_ascii_case("Enabled") {
                    auto_proxy_enabled = val.eq_ignore_ascii_case("Yes");
                } else if key.eq_ignore_ascii_case("URL")
                    && !val.is_empty()
                    && !val.eq_ignore_ascii_case("(null)")
                {
                    auto_proxy_url = Some(val.to_string());
                }
            }
        }

        Ok(MacServiceProxySnapshot {
            service: service.to_string(),
            web_enabled,
            web_server,
            web_port,
            secure_web_enabled,
            secure_web_server,
            secure_web_port,
            bypass_domains,
            auto_proxy_enabled,
            auto_proxy_url,
        })
    }

    pub fn capture_snapshot() -> Result<PlatformProxySnapshot, ProxyError> {
        let services = discover_active_services()?;
        let mut snaps = Vec::with_capacity(services.len());
        for svc in services {
            if let Ok(s) = snapshot_service(&svc) {
                snaps.push(s);
            }
        }
        Ok(PlatformProxySnapshot::Macos(MacProxySnapshot {
            services: snaps,
        }))
    }

    pub fn apply_system_proxy(
        host: &str,
        port: u16,
        baseline: &PlatformProxySnapshot,
    ) -> Result<(), ProxyError> {
        let port_str = port.to_string();
        let target_services: Vec<String> = match baseline {
            PlatformProxySnapshot::Macos(m) if !m.services.is_empty() => {
                m.services.iter().map(|s| s.service.clone()).collect()
            }
            _ => discover_active_services()?,
        };

        if target_services.is_empty() {
            return Err(ProxyError::Custom(
                "No active macOS network services found via networksetup".into(),
            ));
        }

        for svc in &target_services {
            run_networksetup(&["-setwebproxy", svc, host, &port_str])?;
            run_networksetup(&["-setsecurewebproxy", svc, host, &port_str])?;
            run_networksetup(&["-setwebproxystate", svc, "on"])?;
            run_networksetup(&["-setsecurewebproxystate", svc, "on"])?;

            let mut bypass = vec![
                "localhost".to_string(),
                "127.0.0.1".to_string(),
                "*.local".to_string(),
                "10.0.0.0/8".to_string(),
                "192.168.0.0/16".to_string(),
            ];
            if let PlatformProxySnapshot::Macos(m) = baseline {
                if let Some(orig) = m.services.iter().find(|s| &s.service == svc) {
                    for d in &orig.bypass_domains {
                        if !bypass.iter().any(|b| b.eq_ignore_ascii_case(d)) {
                            bypass.push(d.clone());
                        }
                    }
                }
            }
            let mut args: Vec<&str> = Vec::with_capacity(2 + bypass.len());
            args.push("-setproxybypassdomains");
            args.push(svc.as_str());
            for b in &bypass {
                args.push(b.as_str());
            }
            let _ = run_networksetup(&args);
        }

        Ok(())
    }

    pub fn restore_snapshot(snapshot: &PlatformProxySnapshot) -> Result<(), ProxyError> {
        let PlatformProxySnapshot::Macos(m) = snapshot else {
            return Ok(());
        };

        for svc in &m.services {
            if !svc.web_server.is_empty() && svc.web_port > 0 {
                let p = svc.web_port.to_string();
                let _ = run_networksetup(&["-setwebproxy", &svc.service, &svc.web_server, &p]);
            }
            if !svc.secure_web_server.is_empty() && svc.secure_web_port > 0 {
                let p = svc.secure_web_port.to_string();
                let _ = run_networksetup(&[
                    "-setsecurewebproxy",
                    &svc.service,
                    &svc.secure_web_server,
                    &p,
                ]);
            }
            let _ = run_networksetup(&[
                "-setwebproxystate",
                &svc.service,
                if svc.web_enabled { "on" } else { "off" },
            ]);
            let _ = run_networksetup(&[
                "-setsecurewebproxystate",
                &svc.service,
                if svc.secure_web_enabled { "on" } else { "off" },
            ]);

            if svc.bypass_domains.is_empty() {
                let _ = run_networksetup(&["-setproxybypassdomains", &svc.service, "Empty"]);
            } else {
                let mut args = vec!["-setproxybypassdomains", svc.service.as_str()];
                for d in &svc.bypass_domains {
                    args.push(d.as_str());
                }
                let _ = run_networksetup(&args);
            }

            if let Some(ref url) = svc.auto_proxy_url {
                let _ = run_networksetup(&["-setautoproxyurl", &svc.service, url]);
            }
            let _ = run_networksetup(&[
                "-setautoproxystate",
                &svc.service,
                if svc.auto_proxy_enabled { "on" } else { "off" },
            ]);
        }

        Ok(())
    }

    pub fn inspect_active_state(
        expected_host: &str,
        expected_port: u16,
    ) -> Result<OsActiveProxyState, ProxyError> {
        let services = discover_active_services()?;
        for svc in services {
            let snap = snapshot_service(&svc)?;
            if snap.web_enabled || snap.secure_web_enabled {
                let matches = snap.web_enabled
                    && snap.secure_web_enabled
                    && endpoint_matches(&snap.web_server, snap.web_port, expected_host, expected_port)
                    && endpoint_matches(
                        &snap.secure_web_server,
                        snap.secure_web_port,
                        expected_host,
                        expected_port,
                    );
                return Ok(OsActiveProxyState {
                    matches_flux: matches,
                    any_proxy_enabled: true,
                    current_target_summary: format!("{}:{} ({})", snap.web_server, snap.web_port, svc),
                });
            }
        }

        Ok(OsActiveProxyState {
            matches_flux: false,
            any_proxy_enabled: false,
            current_target_summary: "disabled".to_string(),
        })
    }
}

// ============================================================================
// Linux Implementation (`gsettings` `org.gnome.system.proxy` with safe fallback)
// ============================================================================
#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::process::Command;

    const DEFAULT_GNOME_IGNORE_HOSTS: &str =
        "['localhost', '127.0.0.0/8', '::1', '10.0.0.0/8', '192.168.0.0/16']";

    fn gsettings_get(schema: &str, key: &str) -> Result<String, ProxyError> {
        let out = Command::new("gsettings")
            .args(["get", schema, key])
            .output()
            .map_err(|e| {
                ProxyError::Custom(format!(
                    "gsettings unavailable in this Linux session ({e}); configure HTTP_PROXY manually"
                ))
            })?;
        if !out.status.success() {
            return Err(ProxyError::Custom(format!(
                "gsettings get {schema} {key} unsupported: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn gsettings_set(schema: &str, key: &str, value: &str) -> Result<(), ProxyError> {
        let out = Command::new("gsettings")
            .args(["set", schema, key, value])
            .output()
            .map_err(|e| {
                ProxyError::Custom(format!(
                    "gsettings unavailable in this Linux session ({e}); configure HTTP_PROXY manually"
                ))
            })?;
        if !out.status.success() {
            return Err(ProxyError::Custom(format!(
                "gsettings set {schema} {key} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(())
    }

    fn parse_gsettings_port(raw: &str) -> u16 {
        raw.split_whitespace()
            .last()
            .and_then(|tok| tok.parse::<u16>().ok())
            .unwrap_or(0)
    }

    pub fn capture_snapshot() -> Result<PlatformProxySnapshot, ProxyError> {
        let mode = gsettings_get("org.gnome.system.proxy", "mode")?;
        let ignore_hosts = gsettings_get("org.gnome.system.proxy", "ignore-hosts")
            .unwrap_or_else(|_| DEFAULT_GNOME_IGNORE_HOSTS.to_string());
        let autoconfig_url = gsettings_get("org.gnome.system.proxy", "autoconfig-url").ok();

        let http_host = gsettings_get("org.gnome.system.proxy.http", "host")
            .unwrap_or_else(|_| "''".to_string());
        let http_port = gsettings_get("org.gnome.system.proxy.http", "port")
            .map(|v| parse_gsettings_port(&v))
            .unwrap_or(0);

        let https_host = gsettings_get("org.gnome.system.proxy.https", "host")
            .unwrap_or_else(|_| "''".to_string());
        let https_port = gsettings_get("org.gnome.system.proxy.https", "port")
            .map(|v| parse_gsettings_port(&v))
            .unwrap_or(0);

        Ok(PlatformProxySnapshot::Linux(LinuxProxySnapshot {
            mode,
            http_host,
            http_port,
            https_host,
            https_port,
            ignore_hosts,
            autoconfig_url,
        }))
    }

    pub fn apply_system_proxy(
        host: &str,
        port: u16,
        baseline: &PlatformProxySnapshot,
    ) -> Result<(), ProxyError> {
        let quoted_host = format!("'{host}'");
        let port_str = port.to_string();
        let ignore_hosts = match baseline {
            PlatformProxySnapshot::Linux(l)
                if !l.ignore_hosts.trim().is_empty() && l.ignore_hosts != "@as []" =>
            {
                l.ignore_hosts.as_str()
            }
            _ => DEFAULT_GNOME_IGNORE_HOSTS,
        };

        gsettings_set("org.gnome.system.proxy.http", "host", &quoted_host)?;
        gsettings_set("org.gnome.system.proxy.http", "port", &port_str)?;
        let _ = gsettings_set("org.gnome.system.proxy.http", "enabled", "true");
        gsettings_set("org.gnome.system.proxy.https", "host", &quoted_host)?;
        gsettings_set("org.gnome.system.proxy.https", "port", &port_str)?;
        let _ = gsettings_set("org.gnome.system.proxy", "ignore-hosts", ignore_hosts);
        gsettings_set("org.gnome.system.proxy", "mode", "'manual'")?;
        Ok(())
    }

    pub fn restore_snapshot(snapshot: &PlatformProxySnapshot) -> Result<(), ProxyError> {
        let PlatformProxySnapshot::Linux(l) = snapshot else {
            return Ok(());
        };
        let _ = gsettings_set("org.gnome.system.proxy.http", "host", &l.http_host);
        let _ = gsettings_set(
            "org.gnome.system.proxy.http",
            "port",
            &l.http_port.to_string(),
        );
        let _ = gsettings_set("org.gnome.system.proxy.https", "host", &l.https_host);
        let _ = gsettings_set(
            "org.gnome.system.proxy.https",
            "port",
            &l.https_port.to_string(),
        );
        let _ = gsettings_set("org.gnome.system.proxy", "ignore-hosts", &l.ignore_hosts);
        if let Some(ref pac) = l.autoconfig_url {
            let _ = gsettings_set("org.gnome.system.proxy", "autoconfig-url", pac);
        }
        gsettings_set("org.gnome.system.proxy", "mode", &l.mode)?;
        Ok(())
    }

    pub fn inspect_active_state(
        expected_host: &str,
        expected_port: u16,
    ) -> Result<OsActiveProxyState, ProxyError> {
        let PlatformProxySnapshot::Linux(snap) = capture_snapshot()? else {
            return Ok(OsActiveProxyState {
                matches_flux: false,
                any_proxy_enabled: false,
                current_target_summary: "unsupported".to_string(),
            });
        };

        let mode = snap.mode.trim().trim_matches('\'');
        if mode.eq_ignore_ascii_case("none") {
            return Ok(OsActiveProxyState {
                matches_flux: false,
                any_proxy_enabled: false,
                current_target_summary: "disabled".to_string(),
            });
        }

        if mode.eq_ignore_ascii_case("manual") {
            let http_h = snap.http_host.trim().trim_matches('\'');
            let https_h = snap.https_host.trim().trim_matches('\'');
            let matches = endpoint_matches(http_h, snap.http_port, expected_host, expected_port)
                && endpoint_matches(https_h, snap.https_port, expected_host, expected_port);
            return Ok(OsActiveProxyState {
                matches_flux: matches,
                any_proxy_enabled: true,
                current_target_summary: format!("{http_h}:{}", snap.http_port),
            });
        }

        Ok(OsActiveProxyState {
            matches_flux: false,
            any_proxy_enabled: true,
            current_target_summary: format!("mode={mode}"),
        })
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    use super::*;

    pub fn capture_snapshot() -> Result<PlatformProxySnapshot, ProxyError> {
        Ok(PlatformProxySnapshot::Unsupported)
    }

    pub fn apply_system_proxy(
        _host: &str,
        _port: u16,
        _baseline: &PlatformProxySnapshot,
    ) -> Result<(), ProxyError> {
        Err(ProxyError::Custom(
            "System proxy management is not supported on this OS".into(),
        ))
    }

    pub fn restore_snapshot(_snapshot: &PlatformProxySnapshot) -> Result<(), ProxyError> {
        Ok(())
    }

    pub fn inspect_active_state(
        _expected_host: &str,
        _expected_port: u16,
    ) -> Result<OsActiveProxyState, ProxyError> {
        Ok(OsActiveProxyState {
            matches_flux: false,
            any_proxy_enabled: false,
            current_target_summary: "unsupported".to_string(),
        })
    }
}

// ============================================================================
// Unit Tests: Serialization, Crash Recovery & Self-Overwrite Protection
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct MockWindowsOsBackend {
        state: Mutex<WindowsProxySnapshot>,
    }

    impl MockWindowsOsBackend {
        fn new(initial: WindowsProxySnapshot) -> Arc<Self> {
            Arc::new(Self {
                state: Mutex::new(initial),
            })
        }

        fn current(&self) -> WindowsProxySnapshot {
            self.state.lock().unwrap().clone()
        }

        fn simulate_external_change(&self, next: WindowsProxySnapshot) {
            *self.state.lock().unwrap() = next;
        }
    }

    impl OsProxyBackend for MockWindowsOsBackend {
        fn capture_snapshot(&self) -> Result<PlatformProxySnapshot, ProxyError> {
            Ok(PlatformProxySnapshot::Windows(self.current()))
        }

        fn apply_system_proxy(
            &self,
            host: &str,
            port: u16,
            baseline: &PlatformProxySnapshot,
        ) -> Result<(), ProxyError> {
            let base_override = match baseline {
                PlatformProxySnapshot::Windows(w) => w.proxy_override.as_deref(),
                _ => None,
            };
            let mut guard = self.state.lock().unwrap();
            guard.proxy_enable = Some(1);
            guard.proxy_server = Some(format!("{host}:{port}"));
            guard.proxy_override = Some(merge_windows_proxy_override(base_override));
            guard.auto_config_url = None;
            Ok(())
        }

        fn restore_snapshot(&self, snapshot: &PlatformProxySnapshot) -> Result<(), ProxyError> {
            if let PlatformProxySnapshot::Windows(w) = snapshot {
                let mut guard = self.state.lock().unwrap();
                guard.proxy_enable = Some(w.proxy_enable.unwrap_or(0));
                guard.proxy_server = w.proxy_server.clone();
                guard.proxy_override = w.proxy_override.clone();
                guard.auto_config_url = w.auto_config_url.clone();
            }
            Ok(())
        }

        fn inspect_active_state(
            &self,
            expected_host: &str,
            expected_port: u16,
        ) -> Result<OsActiveProxyState, ProxyError> {
            let snap = self.current();
            if let Some(ref pac) = snap.auto_config_url {
                if !pac.trim().is_empty() {
                    return Ok(OsActiveProxyState {
                        matches_flux: false,
                        any_proxy_enabled: true,
                        current_target_summary: format!("PAC {pac}"),
                    });
                }
            }
            if snap.proxy_enable.unwrap_or(0) != 0 {
                let srv = snap.proxy_server.unwrap_or_default();
                let matches = proxy_server_matches_endpoint(&srv, expected_host, expected_port);
                return Ok(OsActiveProxyState {
                    matches_flux: matches,
                    any_proxy_enabled: true,
                    current_target_summary: srv,
                });
            }
            Ok(OsActiveProxyState {
                matches_flux: false,
                any_proxy_enabled: false,
                current_target_summary: "disabled".to_string(),
            })
        }
    }

    fn make_temp_test_dir(label: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(1);
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "fluxproxy-sysproxy-test-{}-{label}-{id}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    #[test]
    fn backup_serialization_roundtrip_and_clean_rollback_removes_file() {
        let dir = make_temp_test_dir("roundtrip");
        let original = WindowsProxySnapshot {
            proxy_enable: Some(1),
            proxy_server: Some("corp-gateway.internal:3128".into()),
            proxy_override: Some("*.corp.internal;<local>".into()),
            auto_config_url: Some("http://wpad.corp.internal/wpad.dat".into()),
        };

        let backend = MockWindowsOsBackend::new(original.clone());
        let mgr = SystemProxyManager::with_backend(&dir, backend.clone());

        // Enable on 0.0.0.0:8888 -> must normalize OS target to 127.0.0.1:8888
        mgr.enable("0.0.0.0", 8888).expect("enable sysproxy");
        assert!(mgr.backup_file_path().exists(), "backup file must exist while active");

        let active_os = backend.current();
        assert_eq!(active_os.proxy_enable, Some(1));
        assert_eq!(active_os.proxy_server.as_deref(), Some("127.0.0.1:8888"));
        assert!(active_os
            .proxy_override
            .as_deref()
            .unwrap()
            .contains("*.corp.internal"));
        assert!(active_os
            .proxy_override
            .as_deref()
            .unwrap()
            .ends_with("<local>"));
        assert_eq!(active_os.auto_config_url, None);

        // Verify JSON backup on disk holds original corporate settings, NOT 127.0.0.1:8888
        let raw_json = fs::read_to_string(mgr.backup_file_path()).expect("read backup json");
        let parsed: SystemProxyBackup = serde_json::from_str(&raw_json).expect("parse backup json");
        assert_eq!(parsed.flux_endpoint, "127.0.0.1:8888");
        assert_eq!(
            parsed.snapshot,
            PlatformProxySnapshot::Windows(original.clone())
        );

        let (is_on, warn) = mgr.status_for_listener("0.0.0.0", 8888);
        assert!(is_on);
        assert!(warn.is_none());

        // Normal disable -> restores exact corporate proxy + PAC URL and deletes backup file
        mgr.disable().expect("disable sysproxy");
        assert!(
            !mgr.backup_file_path().exists(),
            "backup file must be deleted after clean rollback"
        );
        assert_eq!(backend.current(), original);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn crash_recovery_does_not_overwrite_existing_backup_with_self_address() {
        let dir = make_temp_test_dir("crash-with-file");
        let user_original = WindowsProxySnapshot {
            proxy_enable: Some(0),
            proxy_server: None,
            proxy_override: Some("intranet.local;<local>".into()),
            auto_config_url: None,
        };

        let backend = MockWindowsOsBackend::new(user_original.clone());

        // Run #1: enables proxy (writes backup), then "crashes" without calling disable()
        {
            let crashed_mgr = SystemProxyManager::with_backend(&dir, backend.clone());
            crashed_mgr
                .enable("127.0.0.1", 8888)
                .expect("first run enable");
            assert_eq!(
                backend.current().proxy_server.as_deref(),
                Some("127.0.0.1:8888")
            );
            assert!(crashed_mgr.backup_file_path().exists());
            // Drop without disable() -> simulates SIGKILL / hard crash!
        }

        // Run #2: restarts while OS is still pointing to 127.0.0.1:8888 and backup file exists
        let recovered_mgr = SystemProxyManager::with_backend(&dir, backend.clone());
        recovered_mgr
            .enable("127.0.0.1", 8888)
            .expect("second run enable after crash");

        // Backup file MUST still hold `user_original`, NOT `127.0.0.1:8888`!
        let saved_after_restart: SystemProxyBackup = serde_json::from_str(
            &fs::read_to_string(recovered_mgr.backup_file_path()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            saved_after_restart.snapshot,
            PlatformProxySnapshot::Windows(user_original.clone())
        );

        // Clean exit on Run #2 restores original disabled state and cleans up backup file
        recovered_mgr.disable().expect("clean disable on run 2");
        assert!(!recovered_mgr.backup_file_path().exists());
        assert_eq!(backend.current(), user_original);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn self_address_protection_when_backup_file_missing_after_forced_kill() {
        let dir = make_temp_test_dir("crash-missing-file");
        // Simulate OS already stuck at 127.0.0.1:8888 with NO system-proxy-backup.json on disk
        let stuck_os = WindowsProxySnapshot {
            proxy_enable: Some(1),
            proxy_server: Some("127.0.0.1:8888".into()),
            proxy_override: Some(DEFAULT_WINDOWS_PROXY_OVERRIDE.into()),
            auto_config_url: None,
        };

        let backend = MockWindowsOsBackend::new(stuck_os);
        let mgr = SystemProxyManager::with_backend(&dir, backend.clone());

        mgr.enable("127.0.0.1", 8888)
            .expect("enable when OS already points to 127.0.0.1:8888");

        // Backup file must NOT record 127.0.0.1:8888 as the rollback state!
        let backup: SystemProxyBackup =
            serde_json::from_str(&fs::read_to_string(mgr.backup_file_path()).unwrap()).unwrap();
        assert_eq!(
            backup.snapshot,
            PlatformProxySnapshot::Windows(WindowsProxySnapshot {
                proxy_enable: Some(0),
                proxy_server: None,
                proxy_override: None,
                auto_config_url: None,
            })
        );

        // When FluxProxy exits, OS proxy must be disabled (ProxyEnable = 0), not left at 127.0.0.1:8888
        mgr.disable().expect("disable cleans up stuck proxy");
        assert_eq!(backend.current().proxy_enable, Some(0));
        assert_eq!(backend.current().proxy_server, None);
        assert!(!mgr.backup_file_path().exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_external_vpn_hijack_and_recovers_on_reapply() {
        let dir = make_temp_test_dir("vpn-hijack");
        let backend = MockWindowsOsBackend::new(WindowsProxySnapshot::default());
        let mgr = SystemProxyManager::with_backend(&dir, backend.clone());

        mgr.enable("127.0.0.1", 8888).expect("enable");
        assert_eq!(mgr.status_for_listener("127.0.0.1", 8888), (true, None));

        // Simulate VPN client hijacking Windows ProxyServer to 127.0.0.1:7890
        backend.simulate_external_change(WindowsProxySnapshot {
            proxy_enable: Some(1),
            proxy_server: Some("127.0.0.1:7890".into()),
            proxy_override: None,
            auto_config_url: None,
        });

        let (enabled, warning) = mgr.status_for_listener("127.0.0.1", 8888);
        assert!(!enabled);
        assert!(
            warning
                .as_deref()
                .is_some_and(|w| w.contains("127.0.0.1:7890")),
            "expected hijack warning mentioning external proxy, got {warning:?}"
        );

        mgr.disable().expect("cleanup");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn windows_override_defaults_and_proxy_server_formats_match_correctly() {
        assert_eq!(
            merge_windows_proxy_override(None),
            "localhost;127.*;10.*;192.168.*;<local>"
        );
        assert_eq!(
            merge_windows_proxy_override(Some("   ")),
            "localhost;127.*;10.*;192.168.*;<local>"
        );
        assert_eq!(
            merge_windows_proxy_override(Some("*.dev.internal;10.*;<local>")),
            "*.dev.internal;10.*;localhost;127.*;192.168.*;<local>"
        );

        assert!(proxy_server_matches_endpoint("127.0.0.1:8888", "127.0.0.1", 8888));
        assert!(proxy_server_matches_endpoint("localhost:8888", "127.0.0.1", 8888));
        assert!(proxy_server_matches_endpoint(
            "http=127.0.0.1:8888;https=127.0.0.1:8888",
            "127.0.0.1",
            8888
        ));
        assert!(!proxy_server_matches_endpoint("127.0.0.1:7890", "127.0.0.1", 8888));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_hkcu_read_only_smoke_test() {
        // Non-mutating read check against real HKCU\...\Internet Settings
        let snap = platform::capture_snapshot().expect("read HKCU Internet Settings without admin");
        assert!(matches!(snap, PlatformProxySnapshot::Windows(_)));
    }
}
