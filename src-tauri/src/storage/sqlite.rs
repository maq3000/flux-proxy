use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
#[cfg(test)]
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{ProxyError, SessionDetail, SessionSummary};

pub const OFFLOAD_KIND_REQUEST: i64 = 0;
pub const OFFLOAD_KIND_RESPONSE: i64 = 1;
pub const OFFLOAD_KIND_BREAKPOINT_REQUEST: i64 = 2;
pub const OFFLOAD_KIND_BREAKPOINT_RESPONSE: i64 = 3;
const SQLITE_WRITER_QUEUE_CAPACITY: usize = 4096;

fn populate_fallback_client_ip(detail: &mut SessionDetail) {
    if detail.summary.client_ip.is_none() {
        if let Ok(sock) = detail.client_addr.parse::<std::net::SocketAddr>() {
            let ip = match sock.ip() {
                std::net::IpAddr::V6(v6) => v6
                    .to_ipv4_mapped()
                    .map(std::net::IpAddr::V4)
                    .unwrap_or(std::net::IpAddr::V6(v6)),
                other => other,
            };
            detail.summary.client_ip = Some(ip.to_string());
        }
    }
}

#[cfg(test)]
#[derive(Default)]
struct SqliteTestMetrics {
    req_offload_writes: AtomicUsize,
    total_writes: AtomicUsize,
    last_writer_thread_id: Mutex<Option<std::thread::ThreadId>>,
}

enum SqliteCommand {
    EnqueuePersistBatch(Vec<SessionDetail>),
    EnqueueSyncIfArchived(Box<SessionDetail>),
    EnqueueSaveOffloadedBody {
        session_id: u64,
        kind: i64,
        bytes: Vec<u8>,
    },
    EnqueueDeleteOffloadedBody {
        session_id: u64,
        kind: i64,
    },
    EnqueueDeleteOffloadedBodies(Vec<(u64, i64)>),
    PersistBatch {
        sessions: Vec<SessionDetail>,
        reply: mpsc::SyncSender<Result<usize, ProxyError>>,
    },
    SyncIfArchived {
        item: Box<SessionDetail>,
        reply: mpsc::SyncSender<Result<bool, ProxyError>>,
    },
    UpdateAnnotations {
        id: u64,
        comment: Option<String>,
        marked_color: Option<String>,
        reply: mpsc::SyncSender<Result<Option<SessionSummary>, ProxyError>>,
    },
    LoadRecent {
        limit: usize,
        reply: mpsc::SyncSender<Result<Vec<SessionDetail>, ProxyError>>,
    },
    LoadSessionById {
        id: u64,
        reply: mpsc::SyncSender<Result<Option<SessionDetail>, ProxyError>>,
    },
    LoadArchivedPageAfter {
        after_id: Option<u64>,
        limit: usize,
        reply: mpsc::SyncSender<Result<Vec<SessionDetail>, ProxyError>>,
    },
    SaveOffloadedBody {
        session_id: u64,
        kind: i64,
        bytes: Vec<u8>,
        reply: mpsc::SyncSender<Result<(), ProxyError>>,
    },
    LoadOffloadedBody {
        session_id: u64,
        kind: i64,
        reply: mpsc::SyncSender<Result<Option<Vec<u8>>, ProxyError>>,
    },
    DeleteUnarchivedOffloadedBodies {
        reply: mpsc::SyncSender<Result<usize, ProxyError>>,
    },
    DatabaseSizeFallback {
        reply: mpsc::SyncSender<u64>,
    },
    DeleteMany {
        ids: Vec<u64>,
        reply: mpsc::SyncSender<Result<usize, ProxyError>>,
    },
    MaxPersistedSessionId {
        reply: mpsc::SyncSender<Result<u64, ProxyError>>,
    },
    PurgeAndVacuum {
        preserved_offloaded_keys: Vec<(u64, bool)>,
        include_breakpoints: bool,
        reply: mpsc::SyncSender<Result<(), ProxyError>>,
    },
    CountSessions {
        reply: mpsc::SyncSender<Result<usize, ProxyError>>,
    },
    CountOffloadedBodies {
        reply: mpsc::SyncSender<Result<usize, ProxyError>>,
    },
    Flush {
        reply: mpsc::SyncSender<Result<(), ProxyError>>,
    },
    #[cfg(test)]
    RunWithConn {
        func: Box<dyn FnOnce(&mut Connection) + Send>,
        reply: mpsc::SyncSender<()>,
    },
}

pub struct SqliteArchive {
    tx: Option<mpsc::SyncSender<SqliteCommand>>,
    worker: Option<std::thread::JoinHandle<()>>,
    cached_session_count: Arc<AtomicUsize>,
    #[cfg(test)]
    test_metrics: Arc<SqliteTestMetrics>,
}

impl Drop for SqliteArchive {
    fn drop(&mut self) {
        self.tx.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl SqliteArchive {
    pub fn open(path: &Path) -> Result<Self, ProxyError> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(path)?;
        Self::init_schema(&conn)?;
        let initial_count = Self::count_sessions_raw(&conn).unwrap_or(0);
        let cached_session_count = Arc::new(AtomicUsize::new(initial_count));
        #[cfg(test)]
        let test_metrics = Arc::new(SqliteTestMetrics::default());

        let (tx, rx) = mpsc::sync_channel::<SqliteCommand>(SQLITE_WRITER_QUEUE_CAPACITY);
        let count_clone = Arc::clone(&cached_session_count);
        #[cfg(test)]
        let metrics_clone = Arc::clone(&test_metrics);

        let worker = std::thread::Builder::new()
            .name("fluxproxy-sqlite-writer".to_string())
            .spawn(move || {
                Self::writer_loop(
                    conn,
                    rx,
                    count_clone,
                    #[cfg(test)]
                    metrics_clone,
                );
            })
            .map_err(|e| ProxyError::Custom(format!("Failed to spawn SQLite writer thread: {e}")))?;

        Ok(Self {
            tx: Some(tx),
            worker: Some(worker),
            cached_session_count,
            #[cfg(test)]
            test_metrics,
        })
    }

    pub fn cached_session_count(&self) -> usize {
        self.cached_session_count.load(Ordering::Acquire)
    }

    fn send_cmd(&self, cmd: SqliteCommand) -> Result<(), ProxyError> {
        let tx = self
            .tx
            .as_ref()
            .ok_or_else(|| ProxyError::Custom("SQLite writer channel closed".into()))?;
        tx.send(cmd)
            .map_err(|_| ProxyError::Custom("SQLite writer thread terminated".into()))
    }

    fn call_sync<T>(&self, build: impl FnOnce(mpsc::SyncSender<T>) -> SqliteCommand) -> Result<T, ProxyError> {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.send_cmd(build(reply_tx))?;
        reply_rx
            .recv()
            .map_err(|_| ProxyError::Custom("SQLite writer dropped reply channel".into()))
    }

    fn is_enqueued_write(cmd: &SqliteCommand) -> bool {
        matches!(
            cmd,
            SqliteCommand::EnqueuePersistBatch(_)
                | SqliteCommand::EnqueueSyncIfArchived(_)
                | SqliteCommand::EnqueueSaveOffloadedBody { .. }
                | SqliteCommand::EnqueueDeleteOffloadedBody { .. }
                | SqliteCommand::EnqueueDeleteOffloadedBodies(_)
        )
    }

    fn writer_loop(
        mut conn: Connection,
        rx: mpsc::Receiver<SqliteCommand>,
        cached_session_count: Arc<AtomicUsize>,
        #[cfg(test)] test_metrics: Arc<SqliteTestMetrics>,
    ) {
        #[cfg(test)]
        if let Ok(mut guard) = test_metrics.last_writer_thread_id.lock() {
            *guard = Some(std::thread::current().id());
        }

        while let Ok(first) = rx.recv() {
            if Self::is_enqueued_write(&first) {
                let mut batch = Vec::with_capacity(32);
                batch.push(first);
                let mut deferred_sync = None;
                while batch.len() < 128 {
                    match rx.try_recv() {
                        Ok(next) if Self::is_enqueued_write(&next) => batch.push(next),
                        Ok(other) => {
                            deferred_sync = Some(other);
                            break;
                        }
                        Err(_) => break,
                    }
                }

                Self::apply_enqueued_batch(
                    &mut conn,
                    batch,
                    &cached_session_count,
                    #[cfg(test)]
                    &test_metrics,
                );

                if let Some(sync_cmd) = deferred_sync {
                    Self::execute_sync_command(
                        &mut conn,
                        sync_cmd,
                        &cached_session_count,
                        #[cfg(test)]
                        &test_metrics,
                    );
                }
            } else {
                Self::execute_sync_command(
                    &mut conn,
                    first,
                    &cached_session_count,
                    #[cfg(test)]
                    &test_metrics,
                );
            }
        }
    }

    fn apply_enqueued_batch(
        conn: &mut Connection,
        batch: Vec<SqliteCommand>,
        cached_session_count: &Arc<AtomicUsize>,
        #[cfg(test)] test_metrics: &Arc<SqliteTestMetrics>,
    ) {
        let mut sessions_changed = false;
        let result: Result<(), ProxyError> = (|| {
            let tx = conn.transaction()?;
            for cmd in batch {
                match cmd {
                    SqliteCommand::EnqueuePersistBatch(sessions) => {
                        Self::persist_batch_tx(&tx, &sessions)?;
                        #[cfg(test)]
                        test_metrics
                            .total_writes
                            .fetch_add(sessions.len().max(1), Ordering::Relaxed);
                        sessions_changed = true;
                    }
                    SqliteCommand::EnqueueSyncIfArchived(item) => {
                        let _ = Self::sync_session_if_archived_conn(&tx, &item)?;
                        #[cfg(test)]
                        test_metrics.total_writes.fetch_add(1, Ordering::Relaxed);
                    }
                    SqliteCommand::EnqueueSaveOffloadedBody {
                        session_id,
                        kind,
                        bytes,
                    } => {
                        Self::save_offloaded_body_conn(&tx, session_id, kind, &bytes)?;
                        #[cfg(test)]
                        {
                            test_metrics.total_writes.fetch_add(1, Ordering::Relaxed);
                            if kind == OFFLOAD_KIND_REQUEST {
                                test_metrics
                                    .req_offload_writes
                                    .fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                    SqliteCommand::EnqueueDeleteOffloadedBody { session_id, kind } => {
                        Self::delete_offloaded_body_conn(&tx, session_id, kind)?;
                        #[cfg(test)]
                        test_metrics.total_writes.fetch_add(1, Ordering::Relaxed);
                    }
                    SqliteCommand::EnqueueDeleteOffloadedBodies(keys) => {
                        Self::delete_offloaded_bodies_tx(&tx, &keys)?;
                        #[cfg(test)]
                        test_metrics.total_writes.fetch_add(1, Ordering::Relaxed);
                    }
                    _ => {}
                }
            }
            tx.commit()?;
            Ok(())
        })();

        if let Err(err) = result {
            tracing::warn!("Background SQLite batch write failed: {err}");
            eprintln!("Background SQLite batch write failed: {err}");
        }
        if sessions_changed {
            if let Ok(count) = Self::count_sessions_raw(conn) {
                cached_session_count.store(count, Ordering::Release);
            }
        }
    }

    fn execute_sync_command(
        conn: &mut Connection,
        cmd: SqliteCommand,
        cached_session_count: &Arc<AtomicUsize>,
        #[cfg(test)] test_metrics: &Arc<SqliteTestMetrics>,
    ) {
        match cmd {
            SqliteCommand::PersistBatch { sessions, reply } => {
                let res = (|| -> Result<usize, ProxyError> {
                    let tx = conn.transaction()?;
                    let count = Self::persist_batch_tx(&tx, &sessions)?;
                    tx.commit()?;
                    Ok(count)
                })();
                if res.is_ok() {
                    #[cfg(test)]
                    test_metrics
                        .total_writes
                        .fetch_add(sessions.len().max(1), Ordering::Relaxed);
                    if let Ok(total) = Self::count_sessions_raw(conn) {
                        cached_session_count.store(total, Ordering::Release);
                    }
                }
                let _ = reply.send(res);
            }
            SqliteCommand::SyncIfArchived { item, reply } => {
                let res = Self::sync_session_if_archived_conn(conn, &item);
                if matches!(res, Ok(true)) {
                    #[cfg(test)]
                    test_metrics.total_writes.fetch_add(1, Ordering::Relaxed);
                }
                let _ = reply.send(res);
            }
            SqliteCommand::UpdateAnnotations {
                id,
                comment,
                marked_color,
                reply,
            } => {
                let res = Self::update_session_annotations_conn(conn, id, comment, marked_color);
                if matches!(res, Ok(Some(_))) {
                    #[cfg(test)]
                    test_metrics.total_writes.fetch_add(1, Ordering::Relaxed);
                }
                let _ = reply.send(res);
            }
            SqliteCommand::LoadRecent { limit, reply } => {
                let _ = reply.send(Self::load_recent_conn(conn, limit));
            }
            SqliteCommand::LoadSessionById { id, reply } => {
                let _ = reply.send(Self::load_session_by_id_conn(conn, id));
            }
            SqliteCommand::LoadArchivedPageAfter {
                after_id,
                limit,
                reply,
            } => {
                let _ = reply.send(Self::load_archived_page_after_conn(conn, after_id, limit));
            }
            SqliteCommand::SaveOffloadedBody {
                session_id,
                kind,
                bytes,
                reply,
            } => {
                let res = Self::save_offloaded_body_conn(conn, session_id, kind, &bytes);
                if res.is_ok() {
                    #[cfg(test)]
                    {
                        test_metrics.total_writes.fetch_add(1, Ordering::Relaxed);
                        if kind == OFFLOAD_KIND_REQUEST {
                            test_metrics
                                .req_offload_writes
                                .fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
                let _ = reply.send(res);
            }
            SqliteCommand::LoadOffloadedBody {
                session_id,
                kind,
                reply,
            } => {
                let _ = reply.send(Self::load_offloaded_body_conn(conn, session_id, kind));
            }
            SqliteCommand::DeleteUnarchivedOffloadedBodies { reply } => {
                let res = Self::delete_unarchived_offloaded_bodies_conn(conn);
                if res.is_ok() {
                    #[cfg(test)]
                    test_metrics.total_writes.fetch_add(1, Ordering::Relaxed);
                }
                let _ = reply.send(res);
            }
            SqliteCommand::DatabaseSizeFallback { reply } => {
                let page_count: i64 = conn
                    .query_row("PRAGMA page_count", [], |r| r.get(0))
                    .unwrap_or(0);
                let page_size: i64 = conn
                    .query_row("PRAGMA page_size", [], |r| r.get(0))
                    .unwrap_or(4096);
                let bytes = (page_count.max(0) as u64).saturating_mul(page_size.max(0) as u64);
                let _ = reply.send(bytes);
            }
            SqliteCommand::DeleteMany { ids, reply } => {
                let res = Self::delete_many_conn(conn, &ids);
                if res.is_ok() {
                    #[cfg(test)]
                    test_metrics.total_writes.fetch_add(1, Ordering::Relaxed);
                    if let Ok(total) = Self::count_sessions_raw(conn) {
                        cached_session_count.store(total, Ordering::Release);
                    }
                }
                let _ = reply.send(res);
            }
            SqliteCommand::MaxPersistedSessionId { reply } => {
                let _ = reply.send(Self::max_persisted_session_id_conn(conn));
            }
            SqliteCommand::PurgeAndVacuum {
                preserved_offloaded_keys,
                include_breakpoints,
                reply,
            } => {
                let res = Self::purge_and_vacuum_conn(
                    conn,
                    &preserved_offloaded_keys,
                    include_breakpoints,
                );
                if res.is_ok() {
                    #[cfg(test)]
                    test_metrics.total_writes.fetch_add(1, Ordering::Relaxed);
                    cached_session_count.store(0, Ordering::Release);
                }
                let _ = reply.send(res);
            }
            SqliteCommand::CountSessions { reply } => {
                let res = Self::count_sessions_raw(conn);
                if let Ok(total) = res {
                    cached_session_count.store(total, Ordering::Release);
                }
                let _ = reply.send(res);
            }
            SqliteCommand::CountOffloadedBodies { reply } => {
                let _ = reply.send(Self::count_offloaded_bodies_conn(conn));
            }
            SqliteCommand::Flush { reply } => {
                let _ = reply.send(Ok(()));
            }
            #[cfg(test)]
            SqliteCommand::RunWithConn { func, reply } => {
                func(conn);
                let _ = reply.send(());
            }
            _ => {}
        }
    }

    fn init_schema(conn: &Connection) -> Result<(), ProxyError> {
        conn.execute_batch(
            "PRAGMA busy_timeout = 5000;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS captured_sessions (
                 id INTEGER PRIMARY KEY,
                 timestamp TEXT NOT NULL,
                 method TEXT NOT NULL,
                 url TEXT NOT NULL,
                 status INTEGER NOT NULL,
                 duration_ms INTEGER NOT NULL,
                 comment TEXT,
                 marked_color TEXT,
                 payload_json TEXT NOT NULL
             );
             DROP INDEX IF EXISTS idx_sessions_url;
             DROP INDEX IF EXISTS idx_sessions_status;
             CREATE TABLE IF NOT EXISTS offloaded_bodies (
                 session_id INTEGER NOT NULL,
                 is_response INTEGER NOT NULL,
                 body_bytes BLOB NOT NULL,
                 PRIMARY KEY (session_id, is_response)
             );",
        )?;

        Self::ensure_annotation_columns(conn)?;
        Ok(())
    }

    /// Idempotent migration for pre-existing `sessions.sqlite` archives created before
    /// `comment` and `marked_color` columns were introduced.
    fn ensure_annotation_columns(conn: &Connection) -> Result<(), ProxyError> {
        let mut stmt = conn.prepare("PRAGMA table_info(captured_sessions)")?;
        let existing_cols: HashSet<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .collect();

        if !existing_cols.contains("comment") {
            conn.execute("ALTER TABLE captured_sessions ADD COLUMN comment TEXT", [])?;
        }
        if !existing_cols.contains("marked_color") {
            conn.execute(
                "ALTER TABLE captured_sessions ADD COLUMN marked_color TEXT",
                [],
            )?;
        }
        Ok(())
    }

    fn persist_batch_tx(conn: &Connection, sessions: &[SessionDetail]) -> Result<usize, ProxyError> {
        if sessions.is_empty() {
            return Ok(0);
        }
        let mut stmt = conn.prepare_cached(
            "INSERT OR REPLACE INTO captured_sessions
             (id, timestamp, method, url, status, duration_ms, comment, marked_color, payload_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;

        for item in sessions {
            let json = serde_json::to_string(item)
                .map_err(|e| ProxyError::Custom(format!("JSON serialize failed: {e}")))?;
            stmt.execute(params![
                item.summary.id as i64,
                item.summary.timestamp,
                item.summary.method,
                item.summary.url,
                item.summary.status as i64,
                item.summary.duration_ms as i64,
                item.summary.comment,
                item.summary.marked_color,
                json
            ])?;
        }
        Ok(sessions.len())
    }

    pub fn enqueue_persist_batch(&self, sessions: Vec<SessionDetail>) -> Result<(), ProxyError> {
        if sessions.is_empty() {
            return Ok(());
        }
        self.send_cmd(SqliteCommand::EnqueuePersistBatch(sessions))
    }

    pub fn persist_batch(&self, sessions: &[SessionDetail]) -> Result<usize, ProxyError> {
        if sessions.is_empty() {
            return Ok(0);
        }
        let owned = sessions.to_vec();
        self.call_sync(|reply| SqliteCommand::PersistBatch {
            sessions: owned,
            reply,
        })?
    }

    fn sync_session_if_archived_conn(
        conn: &Connection,
        item: &SessionDetail,
    ) -> Result<bool, ProxyError> {
        let json = serde_json::to_string(item)
            .map_err(|e| ProxyError::Custom(format!("JSON serialize failed: {e}")))?;

        let affected = conn.execute(
            "UPDATE captured_sessions
             SET comment = ?1, marked_color = ?2, payload_json = ?3
             WHERE id = ?4",
            params![
                item.summary.comment,
                item.summary.marked_color,
                json,
                item.summary.id as i64
            ],
        )?;

        Ok(affected > 0)
    }

    pub fn enqueue_sync_session_if_archived(&self, item: SessionDetail) -> Result<(), ProxyError> {
        self.send_cmd(SqliteCommand::EnqueueSyncIfArchived(Box::new(item)))
    }

    /// Synchronizes updated user annotations (`comment` / `marked_color`) directly into SQLite
    /// if the session has already been persisted in `captured_sessions`.
    pub fn sync_session_if_archived(&self, item: &SessionDetail) -> Result<bool, ProxyError> {
        let owned = Box::new(item.clone());
        self.call_sync(|reply| SqliteCommand::SyncIfArchived { item: owned, reply })?
    }

    fn update_session_annotations_conn(
        conn: &Connection,
        id: u64,
        comment: Option<String>,
        marked_color: Option<String>,
    ) -> Result<Option<SessionSummary>, ProxyError> {
        let raw: Option<String> = conn
            .query_row(
                "SELECT payload_json FROM captured_sessions WHERE id = ?1",
                params![id as i64],
                |r| r.get(0),
            )
            .optional()?;

        let Some(payload_json) = raw else {
            return Ok(None);
        };

        let mut detail = serde_json::from_str::<SessionDetail>(&payload_json)
            .map_err(|e| ProxyError::Custom(format!("JSON deserialize failed: {e}")))?;
        populate_fallback_client_ip(&mut detail);
        detail.summary.comment = comment;
        detail.summary.marked_color = marked_color;

        let updated_json = serde_json::to_string(&detail)
            .map_err(|e| ProxyError::Custom(format!("JSON serialize failed: {e}")))?;

        conn.execute(
            "UPDATE captured_sessions
             SET comment = ?1, marked_color = ?2, payload_json = ?3
             WHERE id = ?4",
            params![
                detail.summary.comment,
                detail.summary.marked_color,
                updated_json,
                id as i64
            ],
        )?;

        Ok(Some(detail.summary))
    }

    /// Updates `comment` and `marked_color` for an evicted session stored in `captured_sessions`,
    /// keeping `payload_json` synchronized as well. Returns `Ok(None)` if `id` is not archived.
    pub fn update_session_annotations(
        &self,
        id: u64,
        comment: Option<String>,
        marked_color: Option<String>,
    ) -> Result<Option<SessionSummary>, ProxyError> {
        self.call_sync(|reply| SqliteCommand::UpdateAnnotations {
            id,
            comment,
            marked_color,
            reply,
        })?
    }

    fn decode_archived_row(
        raw: String,
        col_comment: Option<String>,
        col_color: Option<String>,
    ) -> Option<SessionDetail> {
        let mut detail = serde_json::from_str::<SessionDetail>(&raw).ok()?;
        if col_comment.is_some() {
            detail.summary.comment = col_comment;
        }
        if col_color.is_some() {
            detail.summary.marked_color = col_color;
        }
        populate_fallback_client_ip(&mut detail);
        Some(detail)
    }

    fn load_recent_conn(conn: &Connection, limit: usize) -> Result<Vec<SessionDetail>, ProxyError> {
        let mut stmt = conn.prepare(
            "SELECT payload_json, comment, marked_color
             FROM (
                 SELECT id, payload_json, comment, marked_color
                 FROM captured_sessions
                 ORDER BY id DESC
                 LIMIT ?1
             )
             ORDER BY id ASC",
        )?;

        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;

        let mut out = Vec::new();
        for row in rows {
            let (raw, col_comment, col_color) = row?;
            if let Some(detail) = Self::decode_archived_row(raw, col_comment, col_color) {
                out.push(detail);
            }
        }
        Ok(out)
    }

    pub fn load_recent(&self, limit: usize) -> Result<Vec<SessionDetail>, ProxyError> {
        self.call_sync(|reply| SqliteCommand::LoadRecent { limit, reply })?
    }

    fn load_session_by_id_conn(
        conn: &Connection,
        id: u64,
    ) -> Result<Option<SessionDetail>, ProxyError> {
        let row: Option<(String, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT payload_json, comment, marked_color
                 FROM captured_sessions
                 WHERE id = ?1",
                params![id as i64],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;

        let Some((raw, col_comment, col_color)) = row else {
            return Ok(None);
        };

        let mut detail = serde_json::from_str::<SessionDetail>(&raw)
            .map_err(|e| ProxyError::Custom(format!("JSON deserialize failed: {e}")))?;
        if col_comment.is_some() {
            detail.summary.comment = col_comment;
        }
        if col_color.is_some() {
            detail.summary.marked_color = col_color;
        }
        populate_fallback_client_ip(&mut detail);
        Ok(Some(detail))
    }

    pub fn load_session_by_id(&self, id: u64) -> Result<Option<SessionDetail>, ProxyError> {
        self.call_sync(|reply| SqliteCommand::LoadSessionById { id, reply })?
    }

    fn load_archived_page_after_conn(
        conn: &Connection,
        after_id: Option<u64>,
        limit: usize,
    ) -> Result<Vec<SessionDetail>, ProxyError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let after_param = after_id.map(|id| id as i64);
        let mut stmt = conn.prepare_cached(
            "SELECT payload_json, comment, marked_color
             FROM captured_sessions
             WHERE (?1 IS NULL OR id > ?1)
             ORDER BY id ASC
             LIMIT ?2",
        )?;

        let rows = stmt.query_map(params![after_param, limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;

        let mut out = Vec::with_capacity(limit.min(512));
        for row in rows {
            let (raw, col_comment, col_color) = row?;
            if let Some(detail) = Self::decode_archived_row(raw, col_comment, col_color) {
                out.push(detail);
            }
        }
        Ok(out)
    }

    pub fn load_archived_page_after(
        &self,
        after_id: Option<u64>,
        limit: usize,
    ) -> Result<Vec<SessionDetail>, ProxyError> {
        self.call_sync(|reply| SqliteCommand::LoadArchivedPageAfter {
            after_id,
            limit,
            reply,
        })?
    }

    fn save_offloaded_body_conn(
        conn: &Connection,
        session_id: u64,
        kind: i64,
        bytes: &[u8],
    ) -> Result<(), ProxyError> {
        let mut stmt = conn.prepare_cached(
            "INSERT OR REPLACE INTO offloaded_bodies (session_id, is_response, body_bytes)
             VALUES (?1, ?2, ?3)",
        )?;
        stmt.execute(params![session_id as i64, kind, bytes])?;
        Ok(())
    }

    pub fn enqueue_save_offloaded_body_by_kind(
        &self,
        session_id: u64,
        kind: i64,
        bytes: Vec<u8>,
    ) -> Result<(), ProxyError> {
        self.send_cmd(SqliteCommand::EnqueueSaveOffloadedBody {
            session_id,
            kind,
            bytes,
        })
    }

    pub fn save_offloaded_body_by_kind(
        &self,
        session_id: u64,
        kind: i64,
        bytes: &[u8],
    ) -> Result<(), ProxyError> {
        let owned = bytes.to_vec();
        self.call_sync(|reply| SqliteCommand::SaveOffloadedBody {
            session_id,
            kind,
            bytes: owned,
            reply,
        })?
    }

    pub fn save_offloaded_body(
        &self,
        session_id: u64,
        is_response: bool,
        bytes: &[u8],
    ) -> Result<(), ProxyError> {
        let kind = if is_response {
            OFFLOAD_KIND_RESPONSE
        } else {
            OFFLOAD_KIND_REQUEST
        };
        self.save_offloaded_body_by_kind(session_id, kind, bytes)
    }

    fn load_offloaded_body_conn(
        conn: &Connection,
        session_id: u64,
        kind: i64,
    ) -> Result<Option<Vec<u8>>, ProxyError> {
        let mut stmt = conn.prepare_cached(
            "SELECT body_bytes
             FROM offloaded_bodies
             WHERE session_id = ?1 AND is_response = ?2",
        )?;
        let bytes = stmt
            .query_row(params![session_id as i64, kind], |row| row.get::<_, Vec<u8>>(0))
            .optional()?;

        Ok(bytes)
    }

    pub fn load_offloaded_body_by_kind(
        &self,
        session_id: u64,
        kind: i64,
    ) -> Result<Option<Vec<u8>>, ProxyError> {
        self.call_sync(|reply| SqliteCommand::LoadOffloadedBody {
            session_id,
            kind,
            reply,
        })?
    }

    pub fn load_offloaded_body(
        &self,
        session_id: u64,
        is_response: bool,
    ) -> Result<Option<Vec<u8>>, ProxyError> {
        let kind = if is_response {
            OFFLOAD_KIND_RESPONSE
        } else {
            OFFLOAD_KIND_REQUEST
        };
        self.load_offloaded_body_by_kind(session_id, kind)
    }

    fn delete_offloaded_body_conn(
        conn: &Connection,
        session_id: u64,
        kind: i64,
    ) -> Result<usize, ProxyError> {
        let mut stmt = conn.prepare_cached(
            "DELETE FROM offloaded_bodies
             WHERE session_id = ?1 AND is_response = ?2",
        )?;
        Ok(stmt.execute(params![session_id as i64, kind])?)
    }

    fn delete_offloaded_bodies_tx(
        conn: &Connection,
        keys: &[(u64, i64)],
    ) -> Result<usize, ProxyError> {
        if keys.is_empty() {
            return Ok(0);
        }
        let mut stmt = conn.prepare_cached(
            "DELETE FROM offloaded_bodies
             WHERE session_id = ?1 AND is_response = ?2",
        )?;
        let mut removed = 0usize;
        for &(session_id, kind) in keys {
            removed += stmt.execute(params![session_id as i64, kind])?;
        }
        Ok(removed)
    }

    pub fn enqueue_delete_offloaded_body_by_kind(
        &self,
        session_id: u64,
        kind: i64,
    ) -> Result<(), ProxyError> {
        self.send_cmd(SqliteCommand::EnqueueDeleteOffloadedBody { session_id, kind })
    }

    pub fn enqueue_delete_offloaded_bodies_by_kind(
        &self,
        keys: Vec<(u64, i64)>,
    ) -> Result<(), ProxyError> {
        if keys.is_empty() {
            return Ok(());
        }
        self.send_cmd(SqliteCommand::EnqueueDeleteOffloadedBodies(keys))
    }

    fn delete_unarchived_offloaded_bodies_conn(conn: &Connection) -> Result<usize, ProxyError> {
        let removed = conn.execute(
            "DELETE FROM offloaded_bodies
             WHERE is_response IN (0, 1)
               AND session_id NOT IN (SELECT id FROM captured_sessions)",
            [],
        )?;
        Ok(removed)
    }

    pub fn delete_unarchived_offloaded_bodies(&self) -> Result<usize, ProxyError> {
        self.call_sync(|reply| SqliteCommand::DeleteUnarchivedOffloadedBodies { reply })?
    }

    pub fn database_size_bytes(&self, db_path: &Path) -> u64 {
        let mut total = 0u64;
        if let Ok(meta) = std::fs::metadata(db_path) {
            total = total.saturating_add(meta.len());
        }
        let base = db_path.as_os_str();
        for suffix in ["-wal", "-shm"] {
            let mut sidecar = base.to_os_string();
            sidecar.push(suffix);
            if let Ok(meta) = std::fs::metadata(&sidecar) {
                total = total.saturating_add(meta.len());
            }
        }
        if total > 0 {
            return total;
        }
        self.call_sync(|reply| SqliteCommand::DatabaseSizeFallback { reply })
            .unwrap_or(0)
    }

    fn delete_many_conn(conn: &mut Connection, ids: &[u64]) -> Result<usize, ProxyError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let tx = conn.transaction()?;
        let mut removed = 0usize;
        {
            let mut stmt =
                tx.prepare_cached("DELETE FROM captured_sessions WHERE id = ?1")?;
            let mut body_stmt = tx.prepare_cached(
                "DELETE FROM offloaded_bodies WHERE session_id = ?1 AND is_response IN (0, 1)",
            )?;
            for &id in ids {
                removed += stmt.execute(params![id as i64])?;
                body_stmt.execute(params![id as i64])?;
            }
        }
        tx.commit()?;
        Ok(removed)
    }

    pub fn delete_many(&self, ids: &[u64]) -> Result<usize, ProxyError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let owned = ids.to_vec();
        self.call_sync(|reply| SqliteCommand::DeleteMany { ids: owned, reply })?
    }

    fn max_persisted_session_id_conn(conn: &Connection) -> Result<u64, ProxyError> {
        let max_id: i64 = conn.query_row(
            "SELECT COALESCE(MAX(m), 0)
             FROM (
                 SELECT MAX(id) AS m FROM captured_sessions
                 UNION ALL
                 SELECT MAX(session_id) AS m FROM offloaded_bodies WHERE is_response IN (0, 1)
             )",
            [],
            |r| r.get(0),
        )?;
        Ok(max_id.max(0) as u64)
    }

    pub fn max_persisted_session_id(&self) -> Result<u64, ProxyError> {
        self.call_sync(|reply| SqliteCommand::MaxPersistedSessionId { reply })?
    }

    pub fn purge_and_vacuum(&self) -> Result<(), ProxyError> {
        self.call_sync(|reply| SqliteCommand::PurgeAndVacuum {
            preserved_offloaded_keys: Vec::new(),
            include_breakpoints: true,
            reply,
        })?
    }

    fn purge_and_vacuum_conn(
        conn: &mut Connection,
        preserved_offloaded_keys: &[(u64, bool)],
        include_breakpoints: bool,
    ) -> Result<(), ProxyError> {
        let tx = conn.transaction()?;
        if include_breakpoints && preserved_offloaded_keys.is_empty() {
            tx.execute("DELETE FROM offloaded_bodies;", [])?;
        } else if preserved_offloaded_keys.is_empty() {
            tx.execute("DELETE FROM offloaded_bodies WHERE is_response IN (0, 1);", [])?;
        } else {
            tx.execute_batch(
                "CREATE TEMP TABLE IF NOT EXISTS _preserve_offloaded (
                    session_id INTEGER NOT NULL,
                    is_response INTEGER NOT NULL,
                    PRIMARY KEY (session_id, is_response)
                );
                DELETE FROM _preserve_offloaded;",
            )?;
            {
                let mut stmt = tx.prepare(
                    "INSERT OR IGNORE INTO _preserve_offloaded (session_id, is_response)
                     VALUES (?1, ?2)",
                )?;
                for &(session_id, is_response) in preserved_offloaded_keys {
                    stmt.execute(params![
                        session_id as i64,
                        if is_response { 1i64 } else { 0i64 }
                    ])?;
                }
            }
            if include_breakpoints {
                tx.execute(
                    "DELETE FROM offloaded_bodies
                     WHERE NOT EXISTS (
                         SELECT 1 FROM _preserve_offloaded p
                         WHERE p.session_id = offloaded_bodies.session_id
                           AND p.is_response = offloaded_bodies.is_response
                     );",
                    [],
                )?;
            } else {
                tx.execute(
                    "DELETE FROM offloaded_bodies
                     WHERE is_response IN (0, 1)
                       AND NOT EXISTS (
                         SELECT 1 FROM _preserve_offloaded p
                         WHERE p.session_id = offloaded_bodies.session_id
                           AND p.is_response = offloaded_bodies.is_response
                     );",
                    [],
                )?;
            }
            tx.execute("DROP TABLE _preserve_offloaded;", [])?;
        }
        tx.execute("DELETE FROM captured_sessions;", [])?;
        tx.commit()?;

        conn.execute_batch(
            "PRAGMA wal_checkpoint(TRUNCATE);
             VACUUM;
             PRAGMA wal_checkpoint(TRUNCATE);",
        )?;
        Ok(())
    }

    pub fn purge_and_vacuum_preserving(
        &self,
        preserved_offloaded_keys: &[(u64, bool)],
    ) -> Result<(), ProxyError> {
        let owned = preserved_offloaded_keys.to_vec();
        self.call_sync(|reply| SqliteCommand::PurgeAndVacuum {
            preserved_offloaded_keys: owned,
            include_breakpoints: false,
            reply,
        })?
    }

    fn count_sessions_raw(conn: &Connection) -> Result<usize, ProxyError> {
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM captured_sessions", [], |r| r.get(0))?;
        Ok(count.max(0) as usize)
    }

    pub fn count_sessions(&self) -> Result<usize, ProxyError> {
        self.call_sync(|reply| SqliteCommand::CountSessions { reply })?
    }

    fn count_offloaded_bodies_conn(conn: &Connection) -> Result<usize, ProxyError> {
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM offloaded_bodies", [], |r| r.get(0))?;
        Ok(count.max(0) as usize)
    }

    pub fn count_offloaded_bodies(&self) -> Result<usize, ProxyError> {
        self.call_sync(|reply| SqliteCommand::CountOffloadedBodies { reply })?
    }

    pub fn flush(&self) -> Result<(), ProxyError> {
        self.call_sync(|reply| SqliteCommand::Flush { reply })?
    }

    #[cfg(test)]
    pub(crate) fn with_conn_for_test<F, R>(&self, func: F) -> R
    where
        F: FnOnce(&mut Connection) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (res_tx, res_rx) = mpsc::sync_channel(1);
        let wrapped = Box::new(move |conn: &mut Connection| {
            let _ = res_tx.send(func(conn));
        });
        self.call_sync(|reply| SqliteCommand::RunWithConn {
            func: wrapped,
            reply,
        })
        .expect("sqlite test closure");
        res_rx.recv().expect("sqlite test closure result")
    }

    #[cfg(test)]
    pub(crate) fn req_offload_write_count(&self) -> usize {
        self.test_metrics.req_offload_writes.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn total_write_ops(&self) -> usize {
        self.test_metrics.total_writes.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn writer_thread_id(&self) -> Option<std::thread::ThreadId> {
        self.test_metrics
            .last_writer_thread_id
            .lock()
            .ok()
            .and_then(|g| *g)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{HeaderPair, SessionSummary};

    fn sample_detail(id: u64, comment: Option<&str>, color: Option<&str>) -> SessionDetail {
        SessionDetail {
            summary: SessionSummary {
                id,
                status: 401,
                protocol: "HTTPS/2".into(),
                scheme: "https".into(),
                method: "POST".into(),
                host: "auth.internal.corp".into(),
                path: "/oauth2/token".into(),
                url: "https://auth.internal.corp/oauth2/token".into(),
                content_type: "application/json".into(),
                body_size: 64,
                duration_ms: 42,
                timestamp: "2026-10-30T11:55:00Z".into(),
                is_mocked: false,
                matched_rule_id: None,
                error: None,
                process_name: Some("Postman.exe".into()),
                process_pid: Some(8840),
                tls_bypassed: false,
                headers_mutated: false,
                breakpoint_paused: None,
                breakpoint_modified: false,
                comment: comment.map(str::to_owned),
                marked_color: color.map(str::to_owned),
                client_ip: Some("127.0.0.1".into()),
                remapped_to: None,
                ttfb_ms: None,
                dns_ms: None,
                connect_ms: None,
                tls_ms: None,
                receive_ms: None,
                request_size: None,
                wire_body_size: None,
                server_ip: None,
                server_conn_reused: None,
                ws_open: None,
            },
            request_headers: vec![HeaderPair::new("Authorization", "Bearer expired_jwt")],
            response_headers: vec![HeaderPair::new("Content-Type", "application/json")],
            request_body_base64: String::new(),
            response_body_base64: String::new(),
            request_body_text: None,
            response_body_text: Some(r#"{"error":"invalid_grant"}"#.into()),
            tls_version: Some("TLS 1.3".into()),
            client_addr: "127.0.0.1:54000".into(),
            websocket_frames: Vec::new(),
            sse_events: Vec::new(),
            body_offloaded: false,
            request_body_offloaded: false,
            timings: None,
            transfer_stats: None,
        }
    }

    #[test]
    fn persists_and_restores_comments_and_custom_row_colors() {
        let tmp_path = std::env::temp_dir().join(format!(
            "fluxproxy_test_annotations_{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&tmp_path);

        // Simulate legacy table without comment/marked_color columns first
        {
            let legacy = Connection::open(&tmp_path).unwrap();
            legacy
                .execute_batch(
                    "CREATE TABLE captured_sessions (
                        id INTEGER PRIMARY KEY,
                        timestamp TEXT NOT NULL,
                        method TEXT NOT NULL,
                        url TEXT NOT NULL,
                        status INTEGER NOT NULL,
                        duration_ms INTEGER NOT NULL,
                        payload_json TEXT NOT NULL
                    );",
                )
                .unwrap();
        }

        let archive = SqliteArchive::open(&tmp_path).expect("open & migrate legacy sqlite");
        let item = sample_detail(9, Some("Кейс с протухшим токеном"), Some("#ef4444"));
        archive.persist_batch(&[item]).expect("persist batch");

        let loaded = archive.load_recent(100).expect("load recent");
        assert_eq!(loaded.len(), 1);
        assert_eq!(
            loaded[0].summary.comment.as_deref(),
            Some("Кейс с протухшим токеном")
        );
        assert_eq!(loaded[0].summary.marked_color.as_deref(), Some("#ef4444"));

        // Verify in-place annotation update on archived row
        let mut updated = loaded[0].clone();
        updated.summary.comment = Some("Обновленная заметка".into());
        updated.summary.marked_color = Some("#f59e0b".into());
        assert!(archive.sync_session_if_archived(&updated).unwrap());

        let reloaded = archive.load_recent(100).unwrap();
        assert_eq!(
            reloaded[0].summary.comment.as_deref(),
            Some("Обновленная заметка")
        );
        assert_eq!(
            reloaded[0].summary.marked_color.as_deref(),
            Some("#f59e0b")
        );

        let _ = std::fs::remove_file(&tmp_path);
    }

    #[test]
    fn configures_busy_timeout_and_updates_evicted_annotations() {
        let tmp_path = std::env::temp_dir().join(format!(
            "fluxproxy_test_sqlite_busy_{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&tmp_path);

        let archive = SqliteArchive::open(&tmp_path).expect("open sqlite archive");
        archive.with_conn_for_test(|guard| {
            let timeout: i64 = guard
                .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
                .unwrap();
            assert_eq!(timeout, 5000);
        });

        let mut item = sample_detail(17, None, None);
        item.summary.client_ip = None;
        item.client_addr = "10.0.0.42:51234".into();
        archive.persist_batch(&[item]).unwrap();

        let summary = archive
            .update_session_annotations(17, Some("Evicted note".into()), Some("purple".into()))
            .unwrap()
            .expect("evicted row updated");
        assert_eq!(summary.comment.as_deref(), Some("Evicted note"));
        assert_eq!(summary.marked_color.as_deref(), Some("purple"));
        assert_eq!(summary.client_ip.as_deref(), Some("10.0.0.42"));

        let loaded = archive.load_session_by_id(17).unwrap().unwrap();
        assert_eq!(loaded.summary.comment.as_deref(), Some("Evicted note"));
        assert_eq!(loaded.summary.marked_color.as_deref(), Some("purple"));
        assert_eq!(loaded.summary.client_ip.as_deref(), Some("10.0.0.42"));

        let cleared = archive
            .update_session_annotations(17, None, None)
            .unwrap()
            .unwrap();
        assert!(cleared.comment.is_none());
        assert!(cleared.marked_color.is_none());

        let reloaded = archive.load_session_by_id(17).unwrap().unwrap();
        assert!(reloaded.summary.comment.is_none());
        assert!(reloaded.summary.marked_color.is_none());

        drop(archive);
        let _ = std::fs::remove_file(&tmp_path);
    }

    #[test]
    fn purge_and_vacuum_reclaims_disk_space() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tmp_path = std::env::temp_dir().join(format!(
            "fluxproxy_vacuum_test_{}_{nanos}.sqlite",
            std::process::id()
        ));
        let cleanup = |path: &std::path::Path| {
            let _ = std::fs::remove_file(path);
            let base = path.as_os_str();
            for suffix in ["-wal", "-shm"] {
                let mut sidecar = base.to_os_string();
                sidecar.push(suffix);
                let _ = std::fs::remove_file(sidecar);
            }
        };
        cleanup(&tmp_path);

        let archive = SqliteArchive::open(&tmp_path).expect("open sqlite archive");

        // Insert 40 large sessions (~64 KiB each) + 20 offloaded bodies (~128 KiB each)
        let large_text = "A".repeat(64 * 1024);
        let sessions: Vec<SessionDetail> = (1u64..=40)
            .map(|id| {
                let mut detail = sample_detail(id, Some("heavy session"), None);
                detail.response_body_text = Some(large_text.clone());
                detail.summary.body_size = large_text.len();
                detail
            })
            .collect();
        archive.persist_batch(&sessions).expect("persist heavy batch");

        let large_blob = vec![0x5Au8; 128 * 1024];
        for id in 1000u64..1020 {
            archive
                .save_offloaded_body(id, true, &large_blob)
                .expect("save heavy offloaded body");
        }

        let size_before = archive.database_size_bytes(&tmp_path);
        assert!(
            size_before > 2 * 1024 * 1024,
            "expected size_before > 2 MiB, got {size_before} bytes"
        );
        assert_eq!(archive.count_sessions().expect("count sessions"), 40);
        assert_eq!(
            archive
                .count_offloaded_bodies()
                .expect("count offloaded bodies"),
            20
        );

        archive
            .purge_and_vacuum()
            .expect("purge_and_vacuum should succeed");

        let size_after = archive.database_size_bytes(&tmp_path);
        assert_eq!(archive.count_sessions().expect("count after purge"), 0);
        assert_eq!(
            archive
                .count_offloaded_bodies()
                .expect("count offloaded after purge"),
            0
        );
        assert_eq!(
            archive
                .load_offloaded_body(1000, true)
                .expect("load offloaded after purge"),
            None
        );
        assert!(
            size_after < size_before / 4 && size_after < 256 * 1024,
            "expected compacted DB < min({} / 4, 256 KiB), got size_after={size_after}, size_before={size_before}",
            size_before
        );

        drop(archive);
        cleanup(&tmp_path);
    }

    #[test]
    fn max_persisted_session_id_and_schema_index_cleanup() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tmp_path = std::env::temp_dir().join(format!(
            "fluxproxy_max_id_test_{}_{nanos}.sqlite",
            std::process::id()
        ));
        let cleanup = |path: &std::path::Path| {
            let _ = std::fs::remove_file(path);
            let base = path.as_os_str();
            for suffix in ["-wal", "-shm"] {
                let mut sidecar = base.to_os_string();
                sidecar.push(suffix);
                let _ = std::fs::remove_file(sidecar);
            }
        };
        cleanup(&tmp_path);

        // Pre-populate legacy unused indexes to verify `init_schema` drops them
        {
            let legacy = Connection::open(&tmp_path).unwrap();
            legacy
                .execute_batch(
                    "CREATE TABLE captured_sessions (
                        id INTEGER PRIMARY KEY,
                        timestamp TEXT NOT NULL,
                        method TEXT NOT NULL,
                        url TEXT NOT NULL,
                        status INTEGER NOT NULL,
                        duration_ms INTEGER NOT NULL,
                        payload_json TEXT NOT NULL
                    );
                    CREATE INDEX idx_sessions_url ON captured_sessions(url);
                    CREATE INDEX idx_sessions_status ON captured_sessions(status);",
                )
                .unwrap();
        }

        let archive = SqliteArchive::open(&tmp_path).expect("open & migrate schema");
        archive.with_conn_for_test(|guard| {
            let timeout: i64 = guard
                .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
                .unwrap();
            assert_eq!(timeout, 5000);
            let journal_mode: String = guard
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap();
            assert_eq!(journal_mode.to_ascii_lowercase(), "wal");

            let idx_count: i64 = guard
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type = 'index' AND name IN ('idx_sessions_url', 'idx_sessions_status')",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(idx_count, 0, "unused legacy indexes must be dropped");
        });

        assert_eq!(archive.max_persisted_session_id().unwrap(), 0);

        archive
            .persist_batch(&[sample_detail(42, None, None)])
            .unwrap();
        assert_eq!(archive.max_persisted_session_id().unwrap(), 42);

        archive
            .save_offloaded_body(77, true, b"large-response")
            .unwrap();
        assert_eq!(archive.max_persisted_session_id().unwrap(), 77);

        archive.purge_and_vacuum().unwrap();
        assert_eq!(archive.max_persisted_session_id().unwrap(), 0);

        drop(archive);
        cleanup(&tmp_path);
    }

    #[test]
    fn purge_and_vacuum_preserving_keeps_only_active_ram_offloaded_keys() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tmp_path = std::env::temp_dir().join(format!(
            "fluxproxy_preserve_vacuum_{}_{nanos}.sqlite",
            std::process::id()
        ));
        let cleanup = |path: &std::path::Path| {
            let _ = std::fs::remove_file(path);
            let base = path.as_os_str();
            for suffix in ["-wal", "-shm"] {
                let mut sidecar = base.to_os_string();
                sidecar.push(suffix);
                let _ = std::fs::remove_file(sidecar);
            }
        };
        cleanup(&tmp_path);

        let archive = SqliteArchive::open(&tmp_path).expect("open sqlite archive");
        archive
            .persist_batch(&[
                sample_detail(1, None, None),
                sample_detail(2, None, None),
            ])
            .unwrap();
        archive.save_offloaded_body(1, true, b"evicted-resp-1").unwrap();
        archive.save_offloaded_body(2, false, b"evicted-req-2").unwrap();
        archive.save_offloaded_body(10, true, b"ram-resp-10").unwrap();
        archive.save_offloaded_body(10, false, b"ram-req-10").unwrap();
        archive.save_offloaded_body(11, false, b"ram-req-11").unwrap();

        archive
            .purge_and_vacuum_preserving(&[(10, true), (11, false)])
            .expect("purge preserving RAM offloaded keys");

        assert_eq!(archive.count_sessions().unwrap(), 0);
        assert_eq!(archive.count_offloaded_bodies().unwrap(), 2);
        assert_eq!(archive.load_offloaded_body(1, true).unwrap(), None);
        assert_eq!(archive.load_offloaded_body(2, false).unwrap(), None);
        assert_eq!(archive.load_offloaded_body(10, false).unwrap(), None);
        assert_eq!(
            archive.load_offloaded_body(10, true).unwrap().as_deref(),
            Some(b"ram-resp-10".as_slice())
        );
        assert_eq!(
            archive.load_offloaded_body(11, false).unwrap().as_deref(),
            Some(b"ram-req-11".as_slice())
        );

        drop(archive);
        cleanup(&tmp_path);
    }
}
