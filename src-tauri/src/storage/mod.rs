pub mod export_import;
pub mod sqlite;

use std::borrow::Cow;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use base64::Engine as _;
use dashmap::DashMap;

use crate::models::{
    HeaderPair, LoadedSessionBody, ProxyError, SessionDetail, SessionSummary, SseEventRecord,
    StorageStats, WebSocketFrameRecord,
};
use crate::proxy::filters::ProxyFilterEngine;
use crate::storage::sqlite::SqliteArchive;

/// Default maximum number of sessions kept in RAM before FIFO eviction to SQLite.
pub const DEFAULT_SESSION_RETENTION_LIMIT: usize = 10_000;

/// Payloads strictly larger than 2 MiB are offloaded to SQLite `offloaded_bodies`
/// and stripped from in-memory `DashMap` entries to guarantee OOM protection.
pub const BODY_OFFLOAD_THRESHOLD_BYTES: usize = 2 * 1024 * 1024;

/// Hysteresis batch size amortized across FIFO eviction runs to avoid per-insert O(N) scans.
const EVICTION_HYSTERESIS_BATCH: usize = 64;

#[derive(Clone, Debug, Default)]
struct LiveSseAccumulator {
    raw_bytes: Vec<u8>,
    events: Vec<SseEventRecord>,
    total_bytes: usize,
    duration_ms: u64,
}

#[derive(Clone, Debug, Default)]
struct LiveWsAccumulator {
    frames: Vec<WebSocketFrameRecord>,
    total_bytes: usize,
}

/// Parameters for an incremental SSE stream chunk append.
pub struct SseChunkUpdate<'a> {
    pub chunk_slice: &'a [u8],
    pub new_events: Vec<SseEventRecord>,
    pub total_bytes: usize,
    pub duration_ms: u64,
    pub max_capture_bytes: usize,
    pub max_events: usize,
}

/// Dual-tier traffic store:
/// 1. Lock-free in-memory `DashMap` Ring Buffer for sub-millisecond capture & inspection.
/// 2. Embedded WAL-mode SQLite archive (`rusqlite`) for FIFO spill, heavy body offloading, and persistence.
pub struct TrafficStore {
    next_id: AtomicU64,
    sessions: DashMap<u64, Arc<SessionDetail>>,
    sse_streams: DashMap<u64, LiveSseAccumulator>,
    ws_streams: DashMap<u64, LiveWsAccumulator>,
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
        let max_persisted_id = sqlite.max_persisted_session_id()?;
        let clear_db_on_exit_pref_path = Self::clear_db_on_exit_pref_path(&db_path);
        let initial_clear_on_exit =
            Self::load_clear_db_on_exit_pref(&clear_db_on_exit_pref_path);
        Ok(Self {
            next_id: AtomicU64::new(max_persisted_id.saturating_add(1)),
            sessions: DashMap::with_capacity(16_384),
            sse_streams: DashMap::new(),
            ws_streams: DashMap::new(),
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
        self.enforce_retention_limit_exact();
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
        let mut preserved_offloaded_keys = Vec::new();
        for entry in self.sessions.iter() {
            let detail = entry.value();
            if detail.body_offloaded {
                preserved_offloaded_keys.push((detail.summary.id, true));
            }
            if detail.request_body_offloaded {
                preserved_offloaded_keys.push((detail.summary.id, false));
            }
        }
        self.sqlite
            .purge_and_vacuum_preserving(&preserved_offloaded_keys)?;
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

    /// Runs a full `purge_and_vacuum` at most once per `TrafficStore` lifecycle when `clear_db_on_exit` is enabled.
    pub fn purge_on_exit_once(&self, _drop_non_matching: bool) -> bool {
        if !self.clear_db_on_exit() {
            return false;
        }
        if self
            .exit_purge_executed
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let _evict_guard = match self.eviction_lock.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            match self.sqlite.purge_and_vacuum() {
                Ok(()) => {
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

        let resp_offload_bytes: Option<Cow<'_, [u8]>> = if let Some(resp_bytes) = raw_resp_body {
            if resp_bytes.len() > BODY_OFFLOAD_THRESHOLD_BYTES {
                Some(Cow::Borrowed(resp_bytes))
            } else {
                None
            }
        } else {
            extract_heavy_payload_bytes(
                &detail.response_body_base64,
                detail.response_body_text.as_deref(),
            )
            .map(Cow::Owned)
        };

        let req_offload_bytes: Option<Cow<'_, [u8]>> = if let Some(req_bytes) = raw_req_body {
            if req_bytes.len() > BODY_OFFLOAD_THRESHOLD_BYTES {
                Some(Cow::Borrowed(req_bytes))
            } else {
                None
            }
        } else {
            extract_heavy_payload_bytes(
                &detail.request_body_base64,
                detail.request_body_text.as_deref(),
            )
            .map(Cow::Owned)
        };

        {
            let _offload_guard = if resp_offload_bytes.is_some() || req_offload_bytes.is_some() {
                Some(match self.eviction_lock.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                })
            } else {
                None
            };

            // Offload heavy response body (> 2 MiB) to SQLite to prevent heap bloat / OOM.
            // Note: re-offload even when `detail.body_offloaded` is already true (e.g. growing SSE streams).
            if let Some(resp_bytes) = resp_offload_bytes.as_deref() {
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

            // Offload heavy request body (> 2 MiB) to SQLite as well.
            if let Some(req_bytes) = req_offload_bytes.as_deref() {
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

            // Preserve user annotations (`comment` / `marked_color`) atomically under the DashMap shard lock
            match self.sessions.entry(id) {
                dashmap::mapref::entry::Entry::Occupied(mut occupied) => {
                    let existing = occupied.get();
                    if detail.summary.comment.is_none() && existing.summary.comment.is_some() {
                        detail.summary.comment = existing.summary.comment.clone();
                    }
                    if detail.summary.marked_color.is_none()
                        && existing.summary.marked_color.is_some()
                    {
                        detail.summary.marked_color = existing.summary.marked_color.clone();
                    }
                    occupied.insert(Arc::new(detail));
                }
                dashmap::mapref::entry::Entry::Vacant(vacant) => {
                    vacant.insert(Arc::new(detail));
                }
            }
        }

        if let Some(limit) = self.retention_limit() {
            if self.sessions.len() > limit {
                self.enforce_retention_limit();
            }
        }
    }

    fn enforce_retention_limit(&self) {
        self.enforce_retention_limit_inner(true);
    }

    fn enforce_retention_limit_exact(&self) {
        self.enforce_retention_limit_inner(false);
    }

    fn enforce_retention_limit_inner(&self, allow_hysteresis: bool) {
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
        let current_len = keys.len();
        if current_len <= limit {
            return;
        }

        // Oldest sessions have the smallest monotonically-allocated `id` (strict FIFO).
        // Evict with bounded hysteresis on normal inserts to amortize SQLite batches & O(N) scans.
        let overflow = current_len - limit;
        let hysteresis = if allow_hysteresis {
            (limit / 8).min(EVICTION_HYSTERESIS_BATCH)
        } else {
            0
        };
        let evict_count = overflow.saturating_add(hysteresis).min(current_len);

        if evict_count < current_len {
            keys.select_nth_unstable(evict_count);
        }
        let evicted_keys = &mut keys[..evict_count];
        evicted_keys.sort_unstable();

        let mut candidates: Vec<(u64, Arc<SessionDetail>)> = Vec::with_capacity(evict_count);
        let mut evicted_batch: Vec<SessionDetail> = Vec::with_capacity(evict_count);

        for &old_id in evicted_keys.iter() {
            if let Some(entry) = self.sessions.get(&old_id) {
                let arc_detail = Arc::clone(entry.value());
                drop(entry);
                let mut detail = (*arc_detail).clone();
                self.hydrate_live_streams(&mut detail);
                candidates.push((old_id, arc_detail));
                evicted_batch.push(detail);
            }
        }

        if evicted_batch.is_empty() {
            return;
        }

        // Persist batch BEFORE removing from RAM so a transient SQLite failure never loses data.
        if let Err(err) = self.sqlite.persist_batch(&evicted_batch) {
            tracing::error!(
                "Failed to persist {} evicted sessions to SQLite (keeping entries in RAM): {err}",
                evicted_batch.len()
            );
            eprintln!(
                "Failed to persist {} evicted sessions to SQLite (keeping entries in RAM): {err}",
                evicted_batch.len()
            );
            return;
        }

        for (old_id, snapshotted_arc) in candidates {
            let live_sse = self.sse_streams.remove(&old_id).map(|(_, v)| v);
            let live_ws = self.ws_streams.remove(&old_id).map(|(_, v)| v);
            if let Some((_, removed_arc)) = self.sessions.remove(&old_id) {
                if !Arc::ptr_eq(&removed_arc, &snapshotted_arc)
                    || live_sse.is_some()
                    || live_ws.is_some()
                {
                    let mut detail = (*removed_arc).clone();
                    if let Some(sse) = live_sse {
                        apply_sse_to_detail(
                            &mut detail,
                            sse.raw_bytes,
                            sse.events,
                            sse.total_bytes,
                            sse.duration_ms,
                        );
                    }
                    if let Some(ws) = live_ws {
                        apply_ws_to_detail(&mut detail, ws.frames, ws.total_bytes);
                    }
                    if let Err(err) = self.sqlite.sync_session_if_archived(&detail) {
                        tracing::warn!(
                            "Failed to re-sync concurrently updated evicted session #{old_id}: {err}"
                        );
                    }
                }
            }
        }
    }

    pub fn load_session_body(
        &self,
        id: u64,
        is_response: bool,
    ) -> Result<LoadedSessionBody, ProxyError> {
        let Some(detail) = self.get_from_ram_or_sqlite(id)? else {
            return Err(ProxyError::Custom(format!(
                "Тело сессии #{id} не найдено ни в RAM, ни в SQLite"
            )));
        };

        let is_offloaded = if is_response {
            detail.body_offloaded
        } else {
            detail.request_body_offloaded
        };

        if is_offloaded {
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
        }

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

        Ok(LoadedSessionBody {
            id,
            is_response,
            body_base64,
            body_text,
            body_size: if is_response && decoded_len == 0 {
                detail.summary.body_size
            } else {
                decoded_len
            },
        })
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

    fn hydrate_live_streams(&self, detail: &mut SessionDetail) {
        let id = detail.summary.id;
        if let Some(sse) = self.sse_streams.get(&id) {
            apply_sse_to_detail(
                detail,
                sse.raw_bytes.clone(),
                sse.events.clone(),
                sse.total_bytes,
                sse.duration_ms,
            );
        }
        if let Some(ws) = self.ws_streams.get(&id) {
            apply_ws_to_detail(detail, ws.frames.clone(), ws.total_bytes);
        }
    }

    /// Incrementally appends an SSE chunk and parsed events without re-encoding the
    /// accumulated body to Base64/UTF-8 on every chunk ($O(\text{chunk\_len})$ per update).
    /// The full Base64/text representation is materialized lazily on `get`/`load_session_body`
    /// or once on stream close via [`Self::finalize_sse_stream`].
    pub fn append_sse_chunk(
        &self,
        id: u64,
        update: SseChunkUpdate<'_>,
    ) -> Option<SessionSummary> {
        if !self.sessions.contains_key(&id) {
            return None;
        }

        let SseChunkUpdate {
            chunk_slice,
            new_events,
            total_bytes,
            duration_ms,
            max_capture_bytes,
            max_events,
        } = update;

        {
            let mut acc = self.sse_streams.entry(id).or_default();
            if acc.raw_bytes.len() < max_capture_bytes && !chunk_slice.is_empty() {
                let room = max_capture_bytes - acc.raw_bytes.len();
                let take = chunk_slice.len().min(room);
                acc.raw_bytes.extend_from_slice(&chunk_slice[..take]);
            }
            for mut ev in new_events {
                if acc.events.len() >= max_events {
                    break;
                }
                ev.index = acc.events.len() + 1;
                acc.events.push(ev);
            }
            acc.total_bytes = total_bytes;
            acc.duration_ms = duration_ms;
        }

        let mut entry = self.sessions.get_mut(&id)?;
        let detail_mut = Arc::make_mut(entry.value_mut());
        detail_mut.summary.body_size = total_bytes;
        detail_mut.summary.duration_ms = duration_ms;
        Some(detail_mut.summary.clone())
    }

    /// Finalizes an SSE stream: commits the accumulated raw body and parsed events into the session,
    /// performing Base64/UTF-8 encoding (or SQLite offload if > 2 MiB) a single time.
    pub fn finalize_sse_stream(
        &self,
        id: u64,
        duration_ms: u64,
        trailing_event: Option<SseEventRecord>,
        max_events: usize,
    ) -> Option<SessionSummary> {
        let mut live = self.sse_streams.remove(&id).map(|(_, v)| v);
        if let Some(mut ev) = trailing_event {
            let acc = live.get_or_insert_with(LiveSseAccumulator::default);
            if acc.events.len() < max_events {
                ev.index = acc.events.len() + 1;
                acc.events.push(ev);
            }
        }

        let acc = live?;

        let needs_offload = acc.raw_bytes.len() > BODY_OFFLOAD_THRESHOLD_BYTES;
        let _offload_guard = if needs_offload {
            Some(match self.eviction_lock.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            })
        } else {
            None
        };

        if needs_offload && !self.sessions.contains_key(&id) {
            return None;
        }

        let mut offload_failed = false;
        let offloaded = if needs_offload {
            match self.sqlite.save_offloaded_body(id, true, &acc.raw_bytes) {
                Ok(()) => true,
                Err(err) => {
                    offload_failed = true;
                    tracing::error!(
                        "Failed to offload finalized SSE body for session #{id}: {err}"
                    );
                    false
                }
            }
        } else {
            false
        };

        let mut entry = self.sessions.get_mut(&id)?;
        let detail_mut = Arc::make_mut(entry.value_mut());
        detail_mut.summary.body_size = detail_mut.summary.body_size.max(acc.total_bytes);
        detail_mut.summary.duration_ms = duration_ms;
        detail_mut.sse_events = acc.events;
        if offloaded {
            detail_mut.body_offloaded = true;
            detail_mut.response_body_base64 = String::new();
            detail_mut.response_body_text = None;
        } else if !offload_failed || detail_mut.response_body_base64.is_empty() {
            detail_mut.response_body_base64 =
                base64::engine::general_purpose::STANDARD.encode(&acc.raw_bytes);
            detail_mut.response_body_text =
                Some(String::from_utf8_lossy(&acc.raw_bytes).into_owned());
        }
        Some(detail_mut.summary.clone())
    }

    /// Incrementally appends a WebSocket frame in $O(1)$ without re-serializing all frames
    /// to JSON on every message. JSON preview is generated lazily on inspect or once on close.
    pub fn append_ws_frame(
        &self,
        id: u64,
        frame: Option<WebSocketFrameRecord>,
        total_bytes: usize,
        max_frames: usize,
    ) -> Option<SessionSummary> {
        if !self.sessions.contains_key(&id) {
            return None;
        }

        {
            let mut acc = self.ws_streams.entry(id).or_default();
            if let Some(mut rec) = frame {
                if acc.frames.len() < max_frames {
                    rec.index = acc.frames.len() + 1;
                    acc.frames.push(rec);
                }
            }
            acc.total_bytes = total_bytes;
        }

        let mut entry = self.sessions.get_mut(&id)?;
        let detail_mut = Arc::make_mut(entry.value_mut());
        detail_mut.summary.body_size = total_bytes;
        Some(detail_mut.summary.clone())
    }

    /// Finalizes a WebSocket stream: materializes `websocket_frames` and JSON preview once on close.
    pub fn finalize_ws_stream(&self, id: u64) -> Option<SessionSummary> {
        let (_, acc) = self.ws_streams.remove(&id)?;
        let mut entry = self.sessions.get_mut(&id)?;
        let detail_mut = Arc::make_mut(entry.value_mut());
        apply_ws_to_detail(detail_mut, acc.frames, acc.total_bytes);
        Some(detail_mut.summary.clone())
    }

    pub fn get_in_ram(&self, id: u64) -> Option<SessionDetail> {
        let entry = self.sessions.get(&id)?;
        let mut detail = (**entry).clone();
        drop(entry);
        self.hydrate_live_streams(&mut detail);
        Some(detail)
    }

    fn get_from_ram_or_sqlite(&self, id: u64) -> Result<Option<SessionDetail>, ProxyError> {
        if let Some(detail) = self.get_in_ram(id) {
            return Ok(Some(detail));
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
        let _guard = match self.eviction_lock.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        self.sessions.clear();
        self.sse_streams.clear();
        self.ws_streams.clear();
        if let Err(err) = self.sqlite.delete_unarchived_offloaded_bodies() {
            tracing::error!("Failed to delete unarchived offloaded bodies on clear: {err}");
            eprintln!("Failed to delete unarchived offloaded bodies on clear: {err}");
        }
    }

    pub fn remove_many(&self, ids: &[u64]) -> usize {
        let _guard = match self.eviction_lock.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut removed = 0usize;
        for &id in ids {
            self.sse_streams.remove(&id);
            self.ws_streams.remove(&id);
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
            .map(|entry| {
                let mut detail = (**entry.value()).clone();
                self.hydrate_live_streams(&mut detail);
                detail
            })
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
        self.enforce_retention_limit_exact();
        Ok(self.list_summaries())
    }

    /// Loads a `SessionDetail` from RAM or SQLite archive and hydrates any heavy (> 2 MiB)
    /// offloaded request/response bodies so archive exports (`HAR 1.2` / `SAZ`) are complete.
    pub fn get_hydrated(&self, id: u64) -> Result<Option<SessionDetail>, ProxyError> {
        let Some(mut detail) = self.get_from_ram_or_sqlite(id)? else {
            return Ok(None);
        };

        if detail.request_body_offloaded {
            if let Some(req_bytes) = self.sqlite.load_offloaded_body(id, false)? {
                detail.request_body_base64 =
                    base64::engine::general_purpose::STANDARD.encode(&req_bytes);
                detail.request_body_text = std::str::from_utf8(&req_bytes).ok().map(str::to_owned);
                detail.request_body_offloaded = false;
            }
        }

        if detail.body_offloaded {
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
        let Some(detail) = self.get_from_ram_or_sqlite(id)? else {
            return Err(ProxyError::Custom(format!(
                "Сессия #{id} не найдена ни в RAM, ни в SQLite"
            )));
        };

        let is_offloaded = if is_response {
            detail.body_offloaded
        } else {
            detail.request_body_offloaded
        };

        if is_offloaded {
            if let Some(raw_bytes) = self.sqlite.load_offloaded_body(id, is_response)? {
                return Ok(raw_bytes);
            }
        }

        Ok(export_import::decode_detail_body_bytes(&detail, is_response))
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

    /// Populates synthetic HTTP/HTTPS diagnostic sessions directly into the store
    /// (respecting active capture filters and retention limits) for virtualized grid stress testing.
    pub fn generate_stress_sessions(
        &self,
        count: usize,
        filters: &ProxyFilterEngine,
        event_tx: &tokio::sync::mpsc::UnboundedSender<SessionSummary>,
    ) -> usize {
        if count == 0 {
            return 0;
        }
        let target_count = count.min(100_000);
        let hosts = [
            "api.github.com",
            "auth.internal.corp",
            "cdn.cloudflare.com",
            "analytics.telemetry.io",
            "payments.stripe.com",
            "graphql.shop.local",
        ];
        let methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"];
        let paths = [
            "/v1/users/profile",
            "/oauth2/token",
            "/graphql",
            "/assets/app.bundle.js",
            "/v2/checkout/sessions",
            "/healthz",
        ];
        let statuses: [u16; 7] = [200, 200, 200, 201, 204, 304, 502];
        let mut generated = 0usize;

        for i in 0..target_count {
            let id = self.allocate_id();
            let host = hosts[i % hosts.len()];
            let method = methods[i % methods.len()];
            let path = paths[(i / 2) % paths.len()];
            let status = statuses[i % statuses.len()];
            let is_static = path.ends_with(".js");
            let content_type = if is_static {
                "application/javascript; charset=utf-8"
            } else if status == 204 {
                ""
            } else {
                "application/json; charset=utf-8"
            };
            let resp_text = if status == 204 || status == 304 {
                String::new()
            } else {
                format!("{{\"stressId\":{id},\"host\":\"{host}\",\"status\":{status}}}")
            };
            let body_size = resp_text.len();
            let url = format!("https://{host}{path}?seq={i}");
            let summary = SessionSummary {
                id,
                status,
                protocol: "HTTPS/2".to_string(),
                scheme: "https".to_string(),
                method: method.to_string(),
                host: host.to_string(),
                path: format!("{path}?seq={i}"),
                url,
                content_type: content_type.to_string(),
                body_size,
                duration_ms: ((i % 240) + 8) as u64,
                timestamp: chrono::Utc::now().to_rfc3339(),
                is_mocked: false,
                matched_rule_id: None,
                error: if status >= 500 {
                    Some("Simulated stress upstream 502".to_string())
                } else {
                    None
                },
                process_name: Some("stress-bench.exe".to_string()),
                process_pid: Some(4242),
                tls_bypassed: false,
                headers_mutated: false,
                breakpoint_paused: None,
                breakpoint_modified: false,
                comment: None,
                marked_color: None,
                client_ip: Some("127.0.0.1".to_string()),
            };

            if !filters.evaluate_should_store_session(&summary) {
                self.increment_dropped_sessions();
                continue;
            }

            let resp_b64 = if resp_text.is_empty() {
                String::new()
            } else {
                base64::engine::general_purpose::STANDARD.encode(resp_text.as_bytes())
            };
            let detail = SessionDetail {
                summary: summary.clone(),
                request_headers: vec![
                    HeaderPair {
                        name: "Host".to_string(),
                        value: host.to_string(),
                    },
                    HeaderPair {
                        name: "User-Agent".to_string(),
                        value: "FluxProxy-StressBench/1.0".to_string(),
                    },
                ],
                response_headers: vec![HeaderPair {
                    name: "Content-Type".to_string(),
                    value: if content_type.is_empty() {
                        "text/plain".to_string()
                    } else {
                        content_type.to_string()
                    },
                }],
                request_body_base64: String::new(),
                response_body_base64: resp_b64,
                request_body_text: None,
                response_body_text: if resp_text.is_empty() {
                    None
                } else {
                    Some(resp_text)
                },
                tls_version: Some("TLS 1.3".to_string()),
                client_addr: "127.0.0.1:0".to_string(),
                websocket_frames: Vec::new(),
                sse_events: Vec::new(),
                body_offloaded: false,
                request_body_offloaded: false,
            };

            self.sessions.insert(id, Arc::new(detail));
            let _ = event_tx.send(summary);
            generated += 1;
        }

        if let Some(limit) = self.retention_limit() {
            if self.sessions.len() > limit {
                self.enforce_retention_limit_exact();
            }
        }

        generated
    }
}

fn apply_sse_to_detail(
    detail: &mut SessionDetail,
    raw_bytes: Vec<u8>,
    events: Vec<SseEventRecord>,
    total_bytes: usize,
    duration_ms: u64,
) {
    detail.summary.body_size = detail.summary.body_size.max(total_bytes);
    detail.summary.duration_ms = duration_ms.max(detail.summary.duration_ms);
    detail.sse_events = events;
    detail.response_body_base64 = base64::engine::general_purpose::STANDARD.encode(&raw_bytes);
    detail.response_body_text = Some(String::from_utf8_lossy(&raw_bytes).into_owned());
}

fn apply_ws_to_detail(
    detail: &mut SessionDetail,
    frames: Vec<WebSocketFrameRecord>,
    total_bytes: usize,
) {
    detail.summary.body_size = detail.summary.body_size.max(total_bytes);
    if !frames.is_empty() {
        detail.response_body_text = serde_json::to_string_pretty(&frames).ok();
        detail.websocket_frames = frames;
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

        // Explicit archive purge shrinks SQLite while keeping RAM sessions and their offloaded bodies intact
        let after = store
            .clear_sqlite_archive(false)
            .expect("clear_sqlite_archive");
        assert_eq!(after.ram_sessions, 2);
        assert!(after.sqlite_size_bytes < before.sqlite_size_bytes);
        assert_eq!(store.sqlite.count_sessions().unwrap(), 0);
        assert_eq!(store.sqlite.count_offloaded_bodies().unwrap(), 4);

        for in_ram_id in [4u64, 5u64] {
            let loaded = store
                .load_session_body(in_ram_id, true)
                .expect("in-RAM offloaded body must survive clear_sqlite_archive");
            assert_eq!(loaded.body_text.as_deref(), Some(heavy_payload.as_str()));
        }

        // Persist clear_db_on_exit preference and verify reload from disk
        assert!(store.set_clear_db_on_exit(true).unwrap());
        drop(store);

        let reloaded_store =
            TrafficStore::new(db_path.clone()).expect("reopen isolated TrafficStore");
        assert!(reloaded_store.clear_db_on_exit());

        // purge_on_exit_once executes strictly once and reclaims all disk space including previous RAM offloads
        assert!(reloaded_store.purge_on_exit_once(false));
        assert!(!reloaded_store.purge_on_exit_once(false));
        assert_eq!(reloaded_store.sqlite.count_offloaded_bodies().unwrap(), 0);
        assert!(reloaded_store.storage_stats(false).sqlite_size_bytes < 256 * 1024);

        drop(reloaded_store);
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn incremental_sse_and_ws_streams_append_and_hydrate_lazily() {
        let db_path = unique_temp_db("incremental_sse_ws");
        let store = TrafficStore::new(db_path.clone()).expect("init TrafficStore");

        // 1. SSE incremental append + lazy get() + finalization
        let sse_id = store.allocate_id();
        let mut sse_initial = make_session(sse_id, b"");
        sse_initial.summary.body_size = 0;
        sse_initial.response_body_base64.clear();
        sse_initial.response_body_text = Some(String::new());
        store.insert(sse_initial);

        let chunk1 = b"event: message\ndata: hello\n\n";
        let ev1 = SseEventRecord {
            index: 1,
            id: None,
            event: "message".into(),
            data: "hello".into(),
            retry: None,
            byte_length: chunk1.len(),
            offset_ms: 10,
            timestamp: "2026-11-15T10:00:00Z".into(),
        };
        let sum1 = store
            .append_sse_chunk(
                sse_id,
                SseChunkUpdate {
                    chunk_slice: chunk1,
                    new_events: vec![ev1],
                    total_bytes: chunk1.len(),
                    duration_ms: 10,
                    max_capture_bytes: 64 * 1024 * 1024,
                    max_events: 1024,
                },
            )
            .expect("append chunk1");
        assert_eq!(sum1.body_size, chunk1.len());

        // Raw RAM entry stays lightweight while streaming (no eager base64 / event cloning)
        {
            let raw_entry = store.sessions.get(&sse_id).unwrap();
            assert!(raw_entry.response_body_base64.is_empty());
            assert!(raw_entry.sse_events.is_empty());
        }

        // Lazy inspection via get() materializes full body + events on demand
        let live_sse = store.get(sse_id).expect("lazy get during SSE stream");
        assert_eq!(live_sse.sse_events.len(), 1);
        assert_eq!(live_sse.sse_events[0].data, "hello");
        assert_eq!(
            live_sse.response_body_text.as_deref(),
            Some("event: message\ndata: hello\n\n")
        );

        let chunk2 = b"data: world\n\n";
        let ev2 = SseEventRecord {
            index: 2,
            id: None,
            event: "message".into(),
            data: "world".into(),
            retry: None,
            byte_length: chunk2.len(),
            offset_ms: 25,
            timestamp: "2026-11-15T10:00:01Z".into(),
        };
        let _ = store
            .append_sse_chunk(
                sse_id,
                SseChunkUpdate {
                    chunk_slice: chunk2,
                    new_events: vec![ev2],
                    total_bytes: chunk1.len() + chunk2.len(),
                    duration_ms: 25,
                    max_capture_bytes: 64 * 1024 * 1024,
                    max_events: 1024,
                },
            )
            .expect("append chunk2");

        let final_sum = store
            .finalize_sse_stream(sse_id, 30, None, 1024)
            .expect("finalize SSE stream");
        assert_eq!(final_sum.duration_ms, 30);
        assert!(store.sse_streams.get(&sse_id).is_none());

        let finalized_sse = store.get(sse_id).expect("get finalized SSE");
        assert_eq!(finalized_sse.sse_events.len(), 2);
        assert_eq!(
            finalized_sse.response_body_text.as_deref(),
            Some("event: message\ndata: hello\n\ndata: world\n\n")
        );

        // 2. WebSocket incremental append + lazy get() + finalization
        let ws_id = store.allocate_id();
        let mut ws_initial = make_session(ws_id, b"");
        ws_initial.summary.body_size = 0;
        ws_initial.response_body_base64.clear();
        ws_initial.response_body_text = Some("[WebSocket Tunnel Established]".into());
        store.insert(ws_initial);

        let frame1 = WebSocketFrameRecord {
            index: 1,
            direction: "outbound".into(),
            opcode: "text".into(),
            payload_preview: "ping".into(),
            byte_length: 4,
            timestamp: "2026-11-15T10:00:02Z".into(),
        };
        let ws_sum = store
            .append_ws_frame(ws_id, Some(frame1), 4, 256)
            .expect("append ws frame");
        assert_eq!(ws_sum.body_size, 4);

        // Raw RAM entry has not serialized JSON or copied frames yet
        {
            let raw_entry = store.sessions.get(&ws_id).unwrap();
            assert!(raw_entry.websocket_frames.is_empty());
        }

        // Lazy inspection materializes frames & pretty JSON
        let live_ws = store.get(ws_id).expect("lazy get during WS stream");
        assert_eq!(live_ws.websocket_frames.len(), 1);
        assert!(live_ws
            .response_body_text
            .as_deref()
            .unwrap()
            .contains("\"ping\""));

        let finalized_sum = store.finalize_ws_stream(ws_id).expect("finalize WS");
        assert_eq!(finalized_sum.body_size, 4);
        assert!(store.ws_streams.get(&ws_id).is_none());
        let finalized_ws = store.get(ws_id).expect("get finalized WS");
        assert_eq!(finalized_ws.websocket_frames.len(), 1);

        drop(store);
        cleanup_temp_db(&db_path);
    }

    #[test]
    fn generate_stress_sessions_respects_retention_limit_and_emits_events() {
        let db_path = unique_temp_db("stress_gen");
        let store = TrafficStore::new(db_path.clone()).expect("init TrafficStore");
        store.set_retention_limit(Some(25)).expect("set limit 25");

        let filters = ProxyFilterEngine::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let generated = store.generate_stress_sessions(60, &filters, &tx);
        assert_eq!(generated, 60);
        assert_eq!(store.len(), 25);

        let mut received = 0usize;
        while rx.try_recv().is_ok() {
            received += 1;
        }
        assert_eq!(received, 60);

        drop(store);
        cleanup_temp_db(&db_path);
    }

    #[test]
    fn restart_traffic_store_with_existing_db_advances_next_id_and_ignores_stale_offloaded_bodies() {
        let db_path = unique_temp_db("restart_id_consistency");
        cleanup_temp_db(&db_path);

        // Simulate a previous app run that persisted sessions and an even higher offloaded_bodies ID
        {
            let prev = TrafficStore::new(db_path.clone()).expect("init first TrafficStore");
            prev.sqlite
                .persist_batch(&[make_session(15, br#"{"archived":15}"#)])
                .unwrap();
            prev.sqlite
                .save_offloaded_body(42, true, b"stale-offloaded-response-42")
                .unwrap();
            prev.sqlite
                .save_offloaded_body(43, false, b"stale-offloaded-request-43")
                .unwrap();
        }

        // Restarting TrafficStore must initialize next_id > MAX(captured_sessions.id, offloaded_bodies.session_id)
        let restarted = TrafficStore::new(db_path.clone()).expect("restart TrafficStore");
        let first_new_id = restarted.allocate_id();
        assert_eq!(first_new_id, 44);

        // get_in_ram must only inspect RAM and not fall back to SQLite
        assert!(restarted.get_in_ram(15).is_none());
        assert!(restarted.get(15).is_some());

        // Even if a stale row exists in `offloaded_bodies` for an in-RAM non-offloaded session,
        // RAM-first checks and `*_offloaded == false` flags prevent reading stale offloaded blobs.
        let non_offloaded_id = restarted.allocate_id();
        assert_eq!(non_offloaded_id, 45);
        restarted
            .sqlite
            .save_offloaded_body(non_offloaded_id, true, b"STALE_RESP_BLOB")
            .unwrap();
        restarted
            .sqlite
            .save_offloaded_body(non_offloaded_id, false, b"STALE_REQ_BLOB")
            .unwrap();

        let mut fresh = make_session(non_offloaded_id, br#"{"fresh":"ram"}"#);
        fresh.request_body_base64 = base64::engine::general_purpose::STANDARD.encode(b"fresh-req");
        fresh.request_body_text = Some("fresh-req".into());
        restarted.insert(fresh);

        assert!(restarted.get_in_ram(non_offloaded_id).is_some());

        let loaded_resp = restarted
            .load_session_body(non_offloaded_id, true)
            .expect("load RAM response body");
        assert_eq!(loaded_resp.body_text.as_deref(), Some(r#"{"fresh":"ram"}"#));

        let loaded_req = restarted
            .load_session_body(non_offloaded_id, false)
            .expect("load RAM request body");
        assert_eq!(loaded_req.body_text.as_deref(), Some("fresh-req"));

        let raw_resp = restarted
            .extract_raw_body_bytes(non_offloaded_id, true)
            .expect("extract RAM response bytes");
        assert_eq!(raw_resp, br#"{"fresh":"ram"}"#);

        let hydrated = restarted
            .get_hydrated(non_offloaded_id)
            .expect("get_hydrated")
            .expect("session exists");
        assert_eq!(
            hydrated.response_body_text.as_deref(),
            Some(r#"{"fresh":"ram"}"#)
        );
        assert_eq!(hydrated.request_body_text.as_deref(), Some("fresh-req"));

        drop(restarted);
        cleanup_temp_db(&db_path);
    }

    #[test]
    fn clear_sqlite_archive_preserves_in_ram_offloaded_request_and_response_bodies() {
        let db_path = unique_temp_db("preserve_ram_offload");
        cleanup_temp_db(&db_path);

        let store = TrafficStore::new(db_path.clone()).expect("init TrafficStore");
        store.set_retention_limit(Some(2)).unwrap();

        let heavy_resp = "R".repeat(BODY_OFFLOAD_THRESHOLD_BYTES + 4096);
        let heavy_req = "Q".repeat(BODY_OFFLOAD_THRESHOLD_BYTES + 4096);

        // Session 1 & 2 will be evicted to SQLite
        for _ in 0..2 {
            let id = store.allocate_id();
            store.insert(make_session(id, heavy_resp.as_bytes()));
        }

        // Session 3 stays in RAM with response offloaded
        let ram_resp_id = store.allocate_id();
        let mut resp_heavy_detail = make_session(ram_resp_id, heavy_resp.as_bytes());
        resp_heavy_detail.request_body_text = None;
        store.insert(resp_heavy_detail);

        // Session 4 stays in RAM with request offloaded
        let ram_req_id = store.allocate_id();
        let mut req_heavy_detail = make_session(ram_req_id, br#"{"small":true}"#);
        req_heavy_detail.request_body_base64 =
            base64::engine::general_purpose::STANDARD.encode(heavy_req.as_bytes());
        req_heavy_detail.request_body_text = Some(heavy_req.clone());
        store.insert(req_heavy_detail);

        assert_eq!(store.len(), 2);
        assert_eq!(store.sqlite.count_sessions().unwrap(), 2);

        let stats = store.clear_sqlite_archive(false).expect("clear archive");
        assert_eq!(stats.ram_sessions, 2);
        assert_eq!(store.sqlite.count_sessions().unwrap(), 0);
        // Evicted sessions 1 and 2 had their offloaded blobs deleted;
        // RAM session 3 (response offload) and RAM session 4 (request offload) are preserved (total 2).
        assert_eq!(store.sqlite.count_offloaded_bodies().unwrap(), 2);
        assert!(store.sqlite.load_offloaded_body(1, true).unwrap().is_none());
        assert!(store.sqlite.load_offloaded_body(2, true).unwrap().is_none());

        assert_eq!(
            store.extract_raw_body_bytes(ram_resp_id, true).unwrap(),
            heavy_resp.as_bytes()
        );
        assert_eq!(
            store.extract_raw_body_bytes(ram_req_id, false).unwrap(),
            heavy_req.as_bytes()
        );

        let hydrated_req = store.get_hydrated(ram_req_id).unwrap().unwrap();
        assert_eq!(
            hydrated_req.request_body_text.as_deref(),
            Some(heavy_req.as_str())
        );

        drop(store);
        cleanup_temp_db(&db_path);
    }

    #[test]
    fn enforce_retention_limit_uses_hysteresis_batch_eviction() {
        let db_path = unique_temp_db("hysteresis_eviction");
        cleanup_temp_db(&db_path);

        let store = TrafficStore::new(db_path.clone()).expect("init TrafficStore");
        store.set_retention_limit(Some(512)).unwrap();

        for _ in 0..512 {
            let id = store.allocate_id();
            store.insert(make_session(id, b"ok"));
        }
        assert_eq!(store.len(), 512);
        assert_eq!(store.sqlite.count_sessions().unwrap(), 0);

        // Inserting the 513th session triggers hysteresis batch eviction: overflow (1) + 64 = 65 evicted
        let id_513 = store.allocate_id();
        store.insert(make_session(id_513, b"ok"));
        assert_eq!(store.len(), 512 - EVICTION_HYSTERESIS_BATCH);
        assert_eq!(store.sqlite.count_sessions().unwrap(), 65);

        // Next 64 inserts fit below the limit without triggering any additional SQLite eviction
        for _ in 0..64 {
            let id = store.allocate_id();
            store.insert(make_session(id, b"ok"));
        }
        assert_eq!(store.len(), 512);
        assert_eq!(store.sqlite.count_sessions().unwrap(), 65);

        drop(store);
        cleanup_temp_db(&db_path);
    }
}
