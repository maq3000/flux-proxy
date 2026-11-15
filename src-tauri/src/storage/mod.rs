pub mod export_import;
pub mod sqlite;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use base64::Engine as _;
use dashmap::DashMap;

use crate::models::{LoadedSessionBody, ProxyError, SessionDetail, SessionSummary, StorageStats};
use crate::storage::sqlite::SqliteArchive;

/// Default maximum number of sessions kept in RAM before FIFO eviction to SQLite.
pub const DEFAULT_SESSION_RETENTION_LIMIT: usize = 10_000;

/// Payloads strictly larger than 2 MiB are offloaded to SQLite `offloaded_bodies`
/// and stripped from in-memory `DashMap` entries to guarantee OOM protection.
pub const BODY_OFFLOAD_THRESHOLD_BYTES: usize = 2 * 1024 * 1024;

/// Dual-tier traffic store:
/// 1. Lock-free in-memory `DashMap` Ring Buffer for sub-millisecond capture & inspection.
/// 2. Embedded WAL-mode SQLite archive (`rusqlite`) for FIFO spill, heavy body offloading, and persistence.
pub struct TrafficStore {
    next_id: AtomicU64,
    sessions: DashMap<u64, Arc<SessionDetail>>,
    sqlite: SqliteArchive,
    db_path: PathBuf,
    clear_db_on_exit_pref_path: PathBuf,
    clear_db_on_exit: AtomicBool,
    exit_purge_executed: AtomicBool,
    clear_pref_lock: Mutex<()>,
    session_retention_limit: RwLock<Option<usize>>,
    dropped_sessions_count: AtomicU64,
    eviction_lock: Mutex<()>,
}

impl TrafficStore {
    pub fn new(db_path: PathBuf) -> Result<Self, ProxyError> {
        let sqlite = SqliteArchive::open(&db_path)?;
        let clear_db_on_exit_pref_path = Self::clear_db_on_exit_pref_path(&db_path);
        let initial_clear_on_exit =
            Self::load_clear_db_on_exit_pref(&clear_db_on_exit_pref_path);
        Ok(Self {
            next_id: AtomicU64::new(1),
            sessions: DashMap::with_capacity(16_384),
            sqlite,
            db_path,
            clear_db_on_exit_pref_path,
            clear_db_on_exit: AtomicBool::new(initial_clear_on_exit),
            exit_purge_executed: AtomicBool::new(false),
            clear_pref_lock: Mutex::new(()),
            session_retention_limit: RwLock::new(Some(DEFAULT_SESSION_RETENTION_LIMIT)),
            dropped_sessions_count: AtomicU64::new(0),
            eviction_lock: Mutex::new(()),
        })
    }

    fn clear_db_on_exit_pref_path(db_path: &Path) -> PathBuf {
        db_path.with_file_name("clear_db_on_exit.pref")
    }

    fn load_clear_db_on_exit_pref(pref_path: &Path) -> bool {
        std::fs::read_to_string(pref_path)
            .ok()
            .map(|raw| matches!(raw.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false)
    }

    fn persist_clear_db_on_exit_pref(pref_path: &Path, enabled: bool) -> Result<(), ProxyError> {
        if let Some(parent) = pref_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::write(pref_path, if enabled { "true\n" } else { "false\n" }).map_err(|e| {
            ProxyError::Custom(format!(
                "Failed to persist clear_db_on_exit preference: {e}"
            ))
        })
    }

    pub fn allocate_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn retention_limit(&self) -> Option<usize> {
        self.session_retention_limit
            .read()
            .map(|g| *g)
            .unwrap_or(Some(DEFAULT_SESSION_RETENTION_LIMIT))
    }

    pub fn set_retention_limit(&self, limit: Option<usize>) -> Result<(), ProxyError> {
        if matches!(limit, Some(0)) {
            return Err(ProxyError::Custom(
                "Лимит сессий должен быть больше 0 (или None — без ограничений)".into(),
            ));
        }
        {
            let mut guard = self
                .session_retention_limit
                .write()
                .map_err(|_| ProxyError::Custom("Retention limit lock poisoned".into()))?;
            *guard = limit;
        }
        self.enforce_retention_limit();
        Ok(())
    }

    pub fn increment_dropped_sessions(&self) -> u64 {
        self.dropped_sessions_count.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn dropped_sessions_count(&self) -> u64 {
        self.dropped_sessions_count.load(Ordering::Relaxed)
    }

    pub fn storage_stats(&self, drop_non_matching: bool) -> StorageStats {
        StorageStats {
            ram_sessions: self.sessions.len(),
            sqlite_size_bytes: self.sqlite.database_size_bytes(&self.db_path),
            dropped_sessions_count: self.dropped_sessions_count(),
            session_retention_limit: self.retention_limit(),
            drop_non_matching,
        }
    }

    pub fn clear_sqlite_archive(&self, drop_non_matching: bool) -> Result<StorageStats, ProxyError> {
        let _evict_guard = match self.eviction_lock.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        self.sqlite.purge_and_vacuum()?;
        Ok(self.storage_stats(drop_non_matching))
    }

    pub fn clear_db_on_exit(&self) -> bool {
        self.clear_db_on_exit.load(Ordering::SeqCst)
    }

    pub fn set_clear_db_on_exit(&self, enabled: bool) -> Result<bool, ProxyError> {
        let _guard = match self.clear_pref_lock.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        Self::persist_clear_db_on_exit_pref(&self.clear_db_on_exit_pref_path, enabled)?;
        self.clear_db_on_exit.store(enabled, Ordering::SeqCst);
        Ok(enabled)
    }

    /// Runs `clear_sqlite_archive` at most once per `TrafficStore` lifecycle when `clear_db_on_exit` is enabled.
    pub fn purge_on_exit_once(&self, drop_non_matching: bool) -> bool {
        if !self.clear_db_on_exit() {
            return false;
        }
        if self
            .exit_purge_executed
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            match self.clear_sqlite_archive(drop_non_matching) {
                Ok(_) => {
                    tracing::info!("Cleared and vacuumed SQLite archive on application exit");
                }
                Err(err) => {
                    tracing::warn!("Failed to clear SQLite archive on application exit: {err}");
                }
            }
            return true;
        }
        false
    }

    pub fn insert(&self, detail: SessionDetail) {
        self.insert_with_bodies(detail, None, None);
    }

    /// Inserts a session into the Ring Buffer, automatically offloading request/response payloads
    /// exceeding `BODY_OFFLOAD_THRESHOLD_BYTES` (2 MiB) into SQLite and evicting oldest FIFO sessions
    /// if `session_retention_limit` is exceeded.
    pub fn insert_with_bodies(
        &self,
        mut detail: SessionDetail,
        raw_req_body: Option<&[u8]>,
        raw_resp_body: Option<&[u8]>,
    ) {
        let id = detail.summary.id;

        // Offload heavy response body (> 2 MiB) to SQLite to prevent heap bloat / OOM.
        // Note: re-offload even when `detail.body_offloaded` is already true (e.g. growing SSE streams).
        if let Some(resp_bytes) = raw_resp_body {
            if resp_bytes.len() > BODY_OFFLOAD_THRESHOLD_BYTES {
                match self.sqlite.save_offloaded_body(id, true, resp_bytes) {
                    Ok(()) => {
                        detail.body_offloaded = true;
                        detail.summary.body_size = detail.summary.body_size.max(resp_bytes.len());
                        detail.response_body_base64 = String::new();
                        detail.response_body_text = None;
                    }
                    Err(err) => {
                        tracing::error!(
                            "Failed to offload response body for session #{id}: {err}"
                        );
                        eprintln!("Failed to offload response body for session #{id}: {err}");
                    }
                }
            }
        } else if let Some(decoded_resp) = extract_heavy_payload_bytes(
            &detail.response_body_base64,
            detail.response_body_text.as_deref(),
        ) {
            match self.sqlite.save_offloaded_body(id, true, &decoded_resp) {
                Ok(()) => {
                    detail.body_offloaded = true;
                    detail.summary.body_size = detail.summary.body_size.max(decoded_resp.len());
                    detail.response_body_base64 = String::new();
                    detail.response_body_text = None;
                }
                Err(err) => {
                    tracing::error!(
                        "Failed to offload response body for session #{id}: {err}"
                    );
                    eprintln!("Failed to offload response body for session #{id}: {err}");
                }
            }
        }

        // Offload heavy request body (> 2 MiB) to SQLite as well.
        if let Some(req_bytes) = raw_req_body {
            if req_bytes.len() > BODY_OFFLOAD_THRESHOLD_BYTES {
                match self.sqlite.save_offloaded_body(id, false, req_bytes) {
                    Ok(()) => {
                        detail.request_body_offloaded = true;
                        detail.request_body_base64 = String::new();
                        detail.request_body_text = None;
                    }
                    Err(err) => {
                        tracing::error!(
                            "Failed to offload request body for session #{id}: {err}"
                        );
                        eprintln!("Failed to offload request body for session #{id}: {err}");
                    }
                }
            }
        } else if let Some(decoded_req) = extract_heavy_payload_bytes(
            &detail.request_body_base64,
            detail.request_body_text.as_deref(),
        ) {
            match self.sqlite.save_offloaded_body(id, false, &decoded_req) {
                Ok(()) => {
                    detail.request_body_offloaded = true;
                    detail.request_body_base64 = String::new();
                    detail.request_body_text = None;
                }
                Err(err) => {
                    tracing::error!(
                        "Failed to offload request body for session #{id}: {err}"
                    );
                    eprintln!("Failed to offload request body for session #{id}: {err}");
                }
            }
        }

        // Preserve user annotations (`comment` / `marked_color`) atomically under the DashMap shard lock
        match self.sessions.entry(id) {
            dashmap::mapref::entry::Entry::Occupied(mut occupied) => {
                let existing = occupied.get();
                if detail.summary.comment.is_none() && existing.summary.comment.is_some() {
                    detail.summary.comment = existing.summary.comment.clone();
                }
                if detail.summary.marked_color.is_none() && existing.summary.marked_color.is_some()
                {
                    detail.summary.marked_color = existing.summary.marked_color.clone();
                }
                occupied.insert(Arc::new(detail));
            }
            dashmap::mapref::entry::Entry::Vacant(vacant) => {
                vacant.insert(Arc::new(detail));
            }
        }

        if let Some(limit) = self.retention_limit() {
            if self.sessions.len() > limit {
                self.enforce_retention_limit();
            }
        }
    }

    fn enforce_retention_limit(&self) {
        let _guard = match self.eviction_lock.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };

        let Some(limit) = self.retention_limit() else {
            return;
        };
        if self.sessions.len() <= limit {
            return;
        }

        let mut keys: Vec<u64> = self.sessions.iter().map(|entry| *entry.key()).collect();
        if keys.len() <= limit {
            return;
        }

        // Oldest sessions have the smallest monotonically-allocated `id` (strict FIFO)
        keys.sort_unstable();
        let excess = keys.len() - limit;
        let mut evicted_batch = Vec::with_capacity(excess);

        for &old_id in &keys[..excess] {
            if let Some((_, arc_detail)) = self.sessions.remove(&old_id) {
                evicted_batch.push((*arc_detail).clone());
            }
        }

        if !evicted_batch.is_empty() {
            if let Err(err) = self.sqlite.persist_batch(&evicted_batch) {
                tracing::error!(
                    "Failed to persist {} evicted sessions to SQLite: {err}",
                    evicted_batch.len()
                );
                eprintln!(
                    "Failed to persist {} evicted sessions to SQLite: {err}",
                    evicted_batch.len()
                );
            }
        }
    }

    pub fn load_session_body(
        &self,
        id: u64,
        is_response: bool,
    ) -> Result<LoadedSessionBody, ProxyError> {
        if let Some(raw_bytes) = self.sqlite.load_offloaded_body(id, is_response)? {
            let body_size = raw_bytes.len();
            let body_base64 = base64::engine::general_purpose::STANDARD.encode(&raw_bytes);
            let body_text = std::str::from_utf8(&raw_bytes).ok().map(str::to_owned);
            return Ok(LoadedSessionBody {
                id,
                is_response,
                body_base64,
                body_text,
                body_size,
            });
        }

        let maybe_detail = self.get_from_ram_or_sqlite(id)?;

        if let Some(detail) = maybe_detail {
            let (body_base64, body_text) = if is_response {
                (detail.response_body_base64, detail.response_body_text)
            } else {
                (detail.request_body_base64, detail.request_body_text)
            };
            let decoded_len = if !body_base64.is_empty() {
                base64::engine::general_purpose::STANDARD
                    .decode(body_base64.trim())
                    .map(|b| b.len())
                    .unwrap_or_else(|_| body_text.as_ref().map_or(0, |t| t.len()))
            } else {
                body_text.as_ref().map_or(0, |t| t.len())
            };

            return Ok(LoadedSessionBody {
                id,
                is_response,
                body_base64,
                body_text,
                body_size: if is_response && decoded_len == 0 {
                    detail.summary.body_size
                } else {
                    decoded_len
                },
            });
        }

        Err(ProxyError::Custom(format!(
            "Тело сессии #{id} не найдено ни в RAM, ни в SQLite"
        )))
    }

    pub fn annotate_session(
        &self,
        id: u64,
        comment: Option<String>,
        marked_color: Option<String>,
    ) -> Result<Option<SessionSummary>, ProxyError> {
        let clean_comment = comment
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty());
        let clean_color = marked_color
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty());

        if let Some(mut entry) = self.sessions.get_mut(&id) {
            let detail_mut = Arc::make_mut(entry.value_mut());
            detail_mut.summary.comment = clean_comment;
            detail_mut.summary.marked_color = clean_color;
            let snapshot = detail_mut.clone();
            let summary = detail_mut.summary.clone();
            drop(entry);

            let _ = self.sqlite.sync_session_if_archived(&snapshot)?;
            return Ok(Some(summary));
        }

        // Coordinate with eviction so an in-flight spill to `captured_sessions` cannot race.
        let _guard = match self.eviction_lock.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };

        if let Some(mut entry) = self.sessions.get_mut(&id) {
            let detail_mut = Arc::make_mut(entry.value_mut());
            detail_mut.summary.comment = clean_comment;
            detail_mut.summary.marked_color = clean_color;
            let snapshot = detail_mut.clone();
            let summary = detail_mut.summary.clone();
            drop(entry);

            let _ = self.sqlite.sync_session_if_archived(&snapshot)?;
            return Ok(Some(summary));
        }

        self.sqlite
            .update_session_annotations(id, clean_comment, clean_color)
    }

    pub fn update_annotations(
        &self,
        ids: &[u64],
        comment: Option<String>,
        marked_color: Option<String>,
    ) -> Result<Vec<SessionSummary>, ProxyError> {
        let mut seen = HashSet::with_capacity(ids.len());
        let mut updated_summaries = Vec::with_capacity(ids.len());

        for &id in ids {
            if !seen.insert(id) {
                continue;
            }
            if let Some(summary) =
                self.annotate_session(id, comment.clone(), marked_color.clone())?
            {
                updated_summaries.push(summary);
            }
        }

        Ok(updated_summaries)
    }

    fn get_from_ram_or_sqlite(&self, id: u64) -> Result<Option<SessionDetail>, ProxyError> {
        if let Some(entry) = self.sessions.get(&id) {
            return Ok(Some((**entry).clone()));
        }
        self.sqlite.load_session_by_id(id)
    }

    pub fn get(&self, id: u64) -> Option<SessionDetail> {
        match self.get_from_ram_or_sqlite(id) {
            Ok(opt) => opt,
            Err(err) => {
                tracing::warn!("Failed to load session #{id} from SQLite: {err}");
                eprintln!("Failed to load session #{id} from SQLite: {err}");
                None
            }
        }
    }

    pub fn get_archived(&self, id: u64) -> Result<Option<SessionDetail>, ProxyError> {
        self.sqlite.load_session_by_id(id)
    }

    pub fn list_summaries(&self) -> Vec<SessionSummary> {
        let mut summaries: Vec<SessionSummary> = self
            .sessions
            .iter()
            .map(|entry| entry.value().summary.clone())
            .collect();
        summaries.sort_unstable_by_key(|s| s.id);
        summaries
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    pub fn clear(&self) {
        self.sessions.clear();
        if let Err(err) = self.sqlite.delete_unarchived_offloaded_bodies() {
            tracing::error!("Failed to delete unarchived offloaded bodies on clear: {err}");
            eprintln!("Failed to delete unarchived offloaded bodies on clear: {err}");
        }
    }

    pub fn remove_many(&self, ids: &[u64]) -> usize {
        let mut removed = 0usize;
        for &id in ids {
            if self.sessions.remove(&id).is_some() {
                removed += 1;
            }
        }
        if let Err(err) = self.sqlite.delete_many(ids) {
            tracing::error!("Failed to delete sessions from SQLite: {err}");
            eprintln!("Failed to delete sessions from SQLite: {err}");
        }
        removed
    }

    pub fn save_all_to_sqlite(&self) -> Result<usize, ProxyError> {
        let mut all: Vec<SessionDetail> = self
            .sessions
            .iter()
            .map(|entry| (**entry.value()).clone())
            .collect();
        all.sort_unstable_by_key(|d| d.summary.id);
        self.sqlite.persist_batch(&all)
    }

    pub fn load_from_sqlite(&self) -> Result<Vec<SessionSummary>, ProxyError> {
        let fetch_cap = self.retention_limit().unwrap_or(DEFAULT_SESSION_RETENTION_LIMIT);
        let loaded = self.sqlite.load_recent(fetch_cap)?;
        let mut max_id = 1u64;

        for detail in loaded {
            max_id = max_id.max(detail.summary.id.saturating_add(1));
            self.sessions.insert(detail.summary.id, Arc::new(detail));
        }

        self.next_id.fetch_max(max_id, Ordering::SeqCst);
        self.enforce_retention_limit();
        Ok(self.list_summaries())
    }

    /// Loads a `SessionDetail` from RAM or SQLite archive and hydrates any heavy (> 2 MiB)
    /// offloaded request/response bodies so archive exports (`HAR 1.2` / `SAZ`) are complete.
    pub fn get_hydrated(&self, id: u64) -> Result<Option<SessionDetail>, ProxyError> {
        let Some(mut detail) = self.get_from_ram_or_sqlite(id)? else {
            return Ok(None);
        };

        if detail.request_body_offloaded || detail.request_body_base64.is_empty() {
            if let Some(req_bytes) = self.sqlite.load_offloaded_body(id, false)? {
                detail.request_body_base64 =
                    base64::engine::general_purpose::STANDARD.encode(&req_bytes);
                detail.request_body_text = std::str::from_utf8(&req_bytes).ok().map(str::to_owned);
                detail.request_body_offloaded = false;
            }
        }

        if detail.body_offloaded || detail.response_body_base64.is_empty() {
            if let Some(resp_bytes) = self.sqlite.load_offloaded_body(id, true)? {
                detail.summary.body_size = detail.summary.body_size.max(resp_bytes.len());
                detail.response_body_base64 =
                    base64::engine::general_purpose::STANDARD.encode(&resp_bytes);
                detail.response_body_text =
                    std::str::from_utf8(&resp_bytes).ok().map(str::to_owned);
                detail.body_offloaded = false;
            }
        }

        Ok(Some(detail))
    }

    /// Collects hydrated `SessionDetail` entries for export.
    /// When `session_ids` is empty, exports all sessions currently in the store ordered by `id`.
    pub fn collect_sessions_for_export(
        &self,
        session_ids: &[u64],
    ) -> Result<Vec<SessionDetail>, ProxyError> {
        let mut target_ids: Vec<u64> = if session_ids.is_empty() {
            self.sessions.iter().map(|entry| *entry.key()).collect()
        } else {
            session_ids.to_vec()
        };
        target_ids.sort_unstable();
        target_ids.dedup();

        let mut out = Vec::with_capacity(target_ids.len());
        for id in target_ids {
            if let Some(detail) = self.get_hydrated(id)? {
                out.push(detail);
            }
        }
        Ok(out)
    }

    /// Extracts raw binary/text body bytes for saving directly to disk without Base64 overhead
    /// when a payload was offloaded to SQLite.
    pub fn extract_raw_body_bytes(
        &self,
        id: u64,
        is_response: bool,
    ) -> Result<Vec<u8>, ProxyError> {
        if let Some(raw_bytes) = self.sqlite.load_offloaded_body(id, is_response)? {
            return Ok(raw_bytes);
        }

        let maybe_detail = self.get_from_ram_or_sqlite(id)?;

        if let Some(detail) = maybe_detail {
            return Ok(export_import::decode_detail_body_bytes(&detail, is_response));
        }

        Err(ProxyError::Custom(format!(
            "Сессия #{id} не найдена ни в RAM, ни в SQLite"
        )))
    }

    /// Allocates fresh sequential IDs for imported sessions, inserts them into the store
    /// (offloading > 2 MiB payloads automatically), and returns their `SessionSummary` list.
    pub fn import_sessions(&self, imported: Vec<SessionDetail>) -> Vec<SessionSummary> {
        let mut summaries = Vec::with_capacity(imported.len());
        for mut detail in imported {
            let new_id = self.allocate_id();
            detail.summary.id = new_id;
            detail.body_offloaded = false;
            detail.request_body_offloaded = false;
            self.insert(detail);
            if let Some(stored) = self.sessions.get(&new_id) {
                summaries.push(stored.summary.clone());
            }
        }
        summaries
    }
}

fn extract_heavy_payload_bytes(body_b64: &str, body_text: Option<&str>) -> Option<Vec<u8>> {
    let min_b64_len = (BODY_OFFLOAD_THRESHOLD_BYTES * 4) / 3;
    let b64_trimmed = body_b64.trim();

    if b64_trimmed.len() > min_b64_len {
        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(b64_trimmed) {
            if decoded.len() > BODY_OFFLOAD_THRESHOLD_BYTES {
                return Some(decoded);
            }
        }
    }

    if let Some(txt) = body_text {
        if txt.len() > BODY_OFFLOAD_THRESHOLD_BYTES {
            return Some(txt.as_bytes().to_vec());
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::HeaderPair;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_db(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "fluxproxy_ringbuf_{tag}_{}_{nanos}.sqlite",
            std::process::id()
        ))
    }

    fn cleanup_temp_db(path: &PathBuf) {
        let _ = std::fs::remove_file(path);
        let base = path.as_os_str();
        for suffix in ["-wal", "-shm"] {
            let mut sidecar = base.to_os_string();
            sidecar.push(suffix);
            let _ = std::fs::remove_file(sidecar);
        }
    }

    fn make_session(id: u64, resp_bytes: &[u8]) -> SessionDetail {
        SessionDetail {
            summary: SessionSummary {
                id,
                status: 200,
                protocol: "HTTPS/2".into(),
                scheme: "https".into(),
                method: "GET".into(),
                host: "api.fluxproxy.dev".into(),
                path: format!("/v1/items/{id}"),
                url: format!("https://api.fluxproxy.dev/v1/items/{id}"),
                content_type: "application/json".into(),
                body_size: resp_bytes.len(),
                duration_ms: 15,
                timestamp: "2026-11-09T09:00:00Z".into(),
                is_mocked: false,
                matched_rule_id: None,
                error: None,
                process_name: Some("node.exe".into()),
                process_pid: Some(1234),
                tls_bypassed: false,
                headers_mutated: false,
                breakpoint_paused: None,
                breakpoint_modified: false,
                comment: None,
                marked_color: None,
                client_ip: Some("127.0.0.1".into()),
            },
            request_headers: vec![HeaderPair {
                name: "Host".into(),
                value: "api.fluxproxy.dev".into(),
            }],
            response_headers: vec![HeaderPair {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }],
            request_body_base64: String::new(),
            response_body_base64: base64::engine::general_purpose::STANDARD.encode(resp_bytes),
            request_body_text: std::str::from_utf8(resp_bytes).ok().map(str::to_owned),
            response_body_text: std::str::from_utf8(resp_bytes).ok().map(str::to_owned),
            tls_version: Some("TLS 1.3".into()),
            client_addr: "127.0.0.1:55000".into(),
            websocket_frames: Vec::new(),
            sse_events: Vec::new(),
            body_offloaded: false,
            request_body_offloaded: false,
        }
    }

    #[test]
    fn fifo_ring_buffer_evicts_oldest_sessions_and_spills_to_sqlite() {
        let db_path = unique_temp_db("fifo_evict");
        let store = TrafficStore::new(db_path.clone()).expect("init TrafficStore");

        // Default limit must be Some(10_000)
        assert_eq!(store.retention_limit(), Some(10_000));

        // Set tight retention limit = 5 and insert 12 sessions (IDs 1..=12)
        store.set_retention_limit(Some(5)).expect("set limit 5");
        for _ in 0..12 {
            let id = store.allocate_id();
            store.insert(make_session(id, br#"{"ok":true}"#));
        }

        // Only the 5 newest sessions (8..=12) remain in RAM
        assert_eq!(store.len(), 5);
        let remaining_ids: Vec<u64> = store.list_summaries().into_iter().map(|s| s.id).collect();
        assert_eq!(remaining_ids, vec![8, 9, 10, 11, 12]);

        // Evicted sessions (1..=7) are freed from RAM DashMap, yet transparently loaded from SQLite archive via `get`
        for evicted_id in 1..=7 {
            assert!(!store.sessions.contains_key(&evicted_id));
            let via_get = store
                .get(evicted_id)
                .expect("get() must fall back to SQLite for evicted session");
            assert_eq!(via_get.summary.id, evicted_id);
            let archived = store
                .get_archived(evicted_id)
                .expect("query sqlite")
                .expect("evicted session persisted in sqlite");
            assert_eq!(archived.summary.id, evicted_id);
        }

        drop(store);
        cleanup_temp_db(&db_path);
    }

    #[test]
    fn custom_manual_limit_777_immediately_caps_ram_and_rejects_zero() {
        let db_path = unique_temp_db("custom_777");
        let store = TrafficStore::new(db_path.clone()).expect("init TrafficStore");

        // Zero limit must be rejected
        assert!(store.set_retention_limit(Some(0)).is_err());

        // Unlimited mode (`None`) keeps all 1,000 inserted sessions
        store.set_retention_limit(None).expect("set unlimited");
        for _ in 0..1_000 {
            let id = store.allocate_id();
            store.insert(make_session(id, b"payload"));
        }
        assert_eq!(store.len(), 1_000);

        // Applying manual limit 777 immediately shrinks RAM to 777 newest sessions (224..=1000)
        store.set_retention_limit(Some(777)).expect("set 777");
        assert_eq!(store.len(), 777);
        let summaries = store.list_summaries();
        assert_eq!(summaries.first().map(|s| s.id), Some(224));
        assert_eq!(summaries.last().map(|s| s.id), Some(1_000));

        let stats = store.storage_stats(true);
        assert_eq!(stats.ram_sessions, 777);
        assert_eq!(stats.session_retention_limit, Some(777));
        assert!(stats.sqlite_size_bytes > 0);

        drop(store);
        cleanup_temp_db(&db_path);
    }

    #[test]
    fn offloads_response_bodies_over_2mb_and_lazy_loads_on_demand() {
        let db_path = unique_temp_db("offload_2mb");
        let store = TrafficStore::new(db_path.clone()).expect("init TrafficStore");

        let heavy_len = BODY_OFFLOAD_THRESHOLD_BYTES + 256 * 1024; // 2.25 MiB
        let heavy_json = "x".repeat(heavy_len);
        let id = store.allocate_id();

        store.insert(make_session(id, heavy_json.as_bytes()));

        // In-memory SessionDetail must mark body_offloaded = true and strip multi-MB strings
        let in_ram = store.get(id).expect("session in RAM");
        assert!(in_ram.body_offloaded);
        assert!(in_ram.response_body_base64.is_empty());
        assert!(in_ram.response_body_text.is_none());
        assert_eq!(in_ram.summary.body_size, heavy_len);

        // Lazy load via load_session_body(id, true) restores full body accurately
        let loaded = store
            .load_session_body(id, true)
            .expect("lazy load offloaded response body");
        assert_eq!(loaded.id, id);
        assert!(loaded.is_response);
        assert_eq!(loaded.body_size, heavy_len);
        assert_eq!(loaded.body_text.as_deref(), Some(heavy_json.as_str()));

        // Export hydration & raw body extraction also preserve the full >2 MiB payload
        let raw_extracted = store
            .extract_raw_body_bytes(id, true)
            .expect("extract offloaded raw bytes");
        assert_eq!(raw_extracted.len(), heavy_len);

        let hydrated_export = store
            .collect_sessions_for_export(&[id])
            .expect("collect hydrated sessions");
        assert_eq!(hydrated_export.len(), 1);
        assert_eq!(
            hydrated_export[0].response_body_text.as_deref(),
            Some(heavy_json.as_str())
        );

        drop(store);
        cleanup_temp_db(&db_path);
    }

    #[test]
    fn annotate_session_updates_sqlite_evicted_and_preserves_across_response_updates() {
        let db_path = unique_temp_db("annotate_sync");
        let store = TrafficStore::new(db_path.clone()).expect("init TrafficStore");
        store.set_retention_limit(Some(2)).expect("set limit 2");

        // Insert 3 sessions -> session #1 is evicted to SQLite
        for _ in 0..3 {
            let id = store.allocate_id();
            store.insert(make_session(id, br#"{"ok":true}"#));
        }
        assert!(!store.sessions.contains_key(&1));

        // Annotate evicted session #1 -> updates captured_sessions in SQLite
        let evicted_updated = store
            .update_annotations(&[1, 1, 2], Some("Pinned".into()), Some("amber".into()))
            .expect("update annotations");
        // Duplicate ID `1` is deduplicated
        assert_eq!(evicted_updated.len(), 2);

        let reloaded_evicted = store.get(1).expect("load evicted from sqlite");
        assert_eq!(reloaded_evicted.summary.comment.as_deref(), Some("Pinned"));
        assert_eq!(
            reloaded_evicted.summary.marked_color.as_deref(),
            Some("amber")
        );

        // Concurrent/subsequent response update on session #2 must preserve annotations
        let mut resp_update = make_session(2, br#"{"updated":true}"#);
        resp_update.summary.status = 201;
        store.insert(resp_update);

        let after_resp = store.get(2).expect("session 2 in RAM");
        assert_eq!(after_resp.summary.status, 201);
        assert_eq!(after_resp.summary.comment.as_deref(), Some("Pinned"));
        assert_eq!(after_resp.summary.marked_color.as_deref(), Some("amber"));

        drop(store);
        cleanup_temp_db(&db_path);
    }

    #[test]
    fn sse_streaming_over_2mb_reoffloads_even_when_body_offloaded_already_true() {
        let db_path = unique_temp_db("sse_reoffload");
        let store = TrafficStore::new(db_path.clone()).expect("init TrafficStore");

        let id = store.allocate_id();
        let initial_len = BODY_OFFLOAD_THRESHOLD_BYTES + 1024;
        let first_payload = "data: a\n\n".repeat(initial_len / 9 + 1);
        let mut s = make_session(id, first_payload.as_bytes());
        s.response_headers = vec![HeaderPair {
            name: "Content-Type".into(),
            value: "text/event-stream".into(),
        }];
        store.insert(s);

        let mid = store.get(id).expect("session present");
        assert!(mid.body_offloaded);
        assert!(mid.response_body_base64.is_empty());
        assert!(mid.response_body_text.is_none());

        // Simulate subsequent SSE chunk appending more bytes to detail already marked `body_offloaded = true`
        let second_payload = format!("{first_payload}data: final-sse-chunk\n\n");
        let mut next = mid;
        next.summary.body_size = second_payload.len();
        next.response_body_base64 =
            base64::engine::general_purpose::STANDARD.encode(second_payload.as_bytes());
        next.response_body_text = Some(second_payload.clone());
        store.insert(next);

        // RAM entry must still have multi-MB strings cleared, and SQLite must hold the updated payload
        let after = store.get(id).expect("updated session present");
        assert!(after.body_offloaded);
        assert!(after.response_body_base64.is_empty());
        assert!(after.response_body_text.is_none());

        let loaded = store.load_session_body(id, true).expect("load updated body");
        assert_eq!(loaded.body_size, second_payload.len());
        assert!(loaded
            .body_text
            .as_deref()
            .unwrap()
            .ends_with("data: final-sse-chunk\n\n"));

        drop(store);
        cleanup_temp_db(&db_path);
    }

    #[test]
    fn load_from_sqlite_advances_next_id_with_fetch_max_without_regressing() {
        let db_path = unique_temp_db("next_id_fetch_max");
        let store = TrafficStore::new(db_path.clone()).expect("init TrafficStore");

        // Persist session #50 directly into SQLite
        let archived = make_session(50, b"ok");
        store.sqlite.persist_batch(&[archived]).unwrap();

        // Simulate concurrent allocation advancing `next_id` past 50 -> e.g. to 101
        for _ in 0..100 {
            let _ = store.allocate_id();
        }
        assert!(store.next_id.load(Ordering::SeqCst) >= 101);

        // Reloading from SQLite must NOT regress `next_id` back to 51
        let _ = store.load_from_sqlite().unwrap();
        let next = store.allocate_id();
        assert!(next >= 101, "expected allocated id >= 101, got {next}");

        // Conversely, on a fresh store opening the same DB, `next_id` advances to at least 51
        let store2 = TrafficStore::new(db_path.clone()).expect("open second TrafficStore");
        let _ = store2.load_from_sqlite().unwrap();
        assert!(store2.allocate_id() >= 51);

        drop(store);
        drop(store2);
        cleanup_temp_db(&db_path);
    }

    #[test]
    fn clear_sqlite_archive_and_clear_on_exit_pref_run_once() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!(
            "fluxproxy_store_exit_{}_{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let db_path = temp_dir.join("sessions.sqlite");

        let store = TrafficStore::new(db_path.clone()).expect("init isolated TrafficStore");
        assert!(!store.clear_db_on_exit());

        // Set retention limit small and spill several heavy sessions into SQLite
        store.set_retention_limit(Some(2)).unwrap();
        let heavy_payload = "B".repeat(BODY_OFFLOAD_THRESHOLD_BYTES + 128 * 1024);
        for _ in 0..5 {
            let id = store.allocate_id();
            store.insert(make_session(id, heavy_payload.as_bytes()));
        }
        assert_eq!(store.len(), 2);

        let before = store.storage_stats(false);
        assert!(before.sqlite_size_bytes > 2 * 1024 * 1024);

        // Explicit archive purge shrinks SQLite while keeping RAM sessions intact
        let after = store
            .clear_sqlite_archive(false)
            .expect("clear_sqlite_archive");
        assert_eq!(after.ram_sessions, 2);
        assert!(after.sqlite_size_bytes < before.sqlite_size_bytes / 4);

        // Persist clear_db_on_exit preference and verify reload from disk
        assert!(store.set_clear_db_on_exit(true).unwrap());
        drop(store);

        let reloaded_store =
            TrafficStore::new(db_path.clone()).expect("reopen isolated TrafficStore");
        assert!(reloaded_store.clear_db_on_exit());

        // purge_on_exit_once executes strictly once
        assert!(reloaded_store.purge_on_exit_once(false));
        assert!(!reloaded_store.purge_on_exit_once(false));

        drop(reloaded_store);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
