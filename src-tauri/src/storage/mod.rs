pub mod sqlite;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
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
    session_retention_limit: RwLock<Option<usize>>,
    dropped_sessions_count: AtomicU64,
    eviction_lock: Mutex<()>,
}

impl TrafficStore {
    pub fn new(db_path: PathBuf) -> Result<Self, ProxyError> {
        let sqlite = SqliteArchive::open(&db_path)?;
        Ok(Self {
            next_id: AtomicU64::new(1),
            sessions: DashMap::with_capacity(16_384),
            sqlite,
            db_path,
            session_retention_limit: RwLock::new(Some(DEFAULT_SESSION_RETENTION_LIMIT)),
            dropped_sessions_count: AtomicU64::new(0),
            eviction_lock: Mutex::new(()),
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
        // Preserve user annotations (`comment` / `marked_color`) when an active stream or breakpoint updates in-place
        if let Some(existing) = self.sessions.get(&id) {
            if detail.summary.comment.is_none() && existing.summary.comment.is_some() {
                detail.summary.comment = existing.summary.comment.clone();
            }
            if detail.summary.marked_color.is_none() && existing.summary.marked_color.is_some() {
                detail.summary.marked_color = existing.summary.marked_color.clone();
            }
        }

        // Offload heavy response body (> 2 MiB) to SQLite to prevent heap bloat / OOM
        if let Some(resp_bytes) = raw_resp_body {
            if resp_bytes.len() > BODY_OFFLOAD_THRESHOLD_BYTES {
                if self.sqlite.save_offloaded_body(id, true, resp_bytes).is_ok() {
                    detail.body_offloaded = true;
                    detail.summary.body_size = detail.summary.body_size.max(resp_bytes.len());
                    detail.response_body_base64 = String::new();
                    detail.response_body_text = None;
                }
            }
        } else if !detail.body_offloaded {
            if let Some(decoded_resp) = extract_heavy_payload_bytes(
                &detail.response_body_base64,
                detail.response_body_text.as_deref(),
            ) {
                if self
                    .sqlite
                    .save_offloaded_body(id, true, &decoded_resp)
                    .is_ok()
                {
                    detail.body_offloaded = true;
                    detail.summary.body_size = detail.summary.body_size.max(decoded_resp.len());
                    detail.response_body_base64 = String::new();
                    detail.response_body_text = None;
                }
            }
        }

        // Offload heavy request body (> 2 MiB) to SQLite as well
        if let Some(req_bytes) = raw_req_body {
            if req_bytes.len() > BODY_OFFLOAD_THRESHOLD_BYTES {
                if self.sqlite.save_offloaded_body(id, false, req_bytes).is_ok() {
                    detail.request_body_offloaded = true;
                    detail.request_body_base64 = String::new();
                    detail.request_body_text = None;
                }
            }
        } else if !detail.request_body_offloaded {
            if let Some(decoded_req) = extract_heavy_payload_bytes(
                &detail.request_body_base64,
                detail.request_body_text.as_deref(),
            ) {
                if self
                    .sqlite
                    .save_offloaded_body(id, false, &decoded_req)
                    .is_ok()
                {
                    detail.request_body_offloaded = true;
                    detail.request_body_base64 = String::new();
                    detail.request_body_text = None;
                }
            }
        }

        self.sessions.insert(id, Arc::new(detail));

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
            let _ = self.sqlite.persist_batch(&evicted_batch);
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

        let maybe_detail = match self.get(id) {
            Some(d) => Some(d),
            None => self.sqlite.load_session_by_id(id)?,
        };

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

    pub fn update_annotations(
        &self,
        ids: &[u64],
        comment: Option<String>,
        marked_color: Option<String>,
    ) -> Result<Vec<SessionSummary>, ProxyError> {
        let clean_comment = comment
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty());
        let clean_color = marked_color
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty());

        let mut updated_summaries = Vec::with_capacity(ids.len());

        for &id in ids {
            let maybe_next = self.sessions.get(&id).map(|entry| {
                let mut cloned = (**entry).clone();
                cloned.summary.comment = clean_comment.clone();
                cloned.summary.marked_color = clean_color.clone();
                cloned
            });

            if let Some(next_detail) = maybe_next {
                let _ = self.sqlite.sync_session_if_archived(&next_detail)?;
                updated_summaries.push(next_detail.summary.clone());
                self.sessions.insert(id, Arc::new(next_detail));
            }
        }

        Ok(updated_summaries)
    }

    pub fn get(&self, id: u64) -> Option<SessionDetail> {
        self.sessions.get(&id).map(|entry| (**entry).clone())
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
        let _ = self.sqlite.delete_unarchived_offloaded_bodies();
    }

    pub fn remove_many(&self, ids: &[u64]) -> usize {
        let mut removed = 0usize;
        for &id in ids {
            if self.sessions.remove(&id).is_some() {
                removed += 1;
            }
        }
        let _ = self.sqlite.delete_many(ids);
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
        let mut max_id = self.next_id.load(Ordering::Relaxed);

        for detail in loaded {
            if detail.summary.id >= max_id {
                max_id = detail.summary.id + 1;
            }
            self.sessions.insert(detail.summary.id, Arc::new(detail));
        }

        self.next_id.store(max_id, Ordering::Relaxed);
        self.enforce_retention_limit();
        Ok(self.list_summaries())
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

        // Evicted sessions (1..=7) are freed from RAM DashMap, yet preserved in SQLite archive
        for evicted_id in 1..=7 {
            assert!(store.get(evicted_id).is_none());
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

        drop(store);
        cleanup_temp_db(&db_path);
    }
}
