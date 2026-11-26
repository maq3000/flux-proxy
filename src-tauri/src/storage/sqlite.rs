use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{ProxyError, SessionDetail, SessionSummary};

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

pub struct SqliteArchive {
    conn: Mutex<Connection>,
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

        Ok(Self {
            conn: Mutex::new(conn),
        })
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

    pub fn persist_batch(&self, sessions: &[SessionDetail]) -> Result<usize, ProxyError> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| ProxyError::Custom("SQLite mutex poisoned".into()))?;

        let tx = guard.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
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
        }
        tx.commit()?;
        Ok(sessions.len())
    }

    /// Synchronizes updated user annotations (`comment` / `marked_color`) directly into SQLite
    /// if the session has already been persisted in `captured_sessions`.
    pub fn sync_session_if_archived(&self, item: &SessionDetail) -> Result<bool, ProxyError> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| ProxyError::Custom("SQLite mutex poisoned".into()))?;

        let json = serde_json::to_string(item)
            .map_err(|e| ProxyError::Custom(format!("JSON serialize failed: {e}")))?;

        let affected = guard.execute(
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

    /// Updates `comment` and `marked_color` for an evicted session stored in `captured_sessions`,
    /// keeping `payload_json` synchronized as well. Returns `Ok(None)` if `id` is not archived.
    pub fn update_session_annotations(
        &self,
        id: u64,
        comment: Option<String>,
        marked_color: Option<String>,
    ) -> Result<Option<SessionSummary>, ProxyError> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| ProxyError::Custom("SQLite mutex poisoned".into()))?;

        let raw: Option<String> = guard
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

        guard.execute(
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

    pub fn load_recent(&self, limit: usize) -> Result<Vec<SessionDetail>, ProxyError> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| ProxyError::Custom("SQLite mutex poisoned".into()))?;

        let mut stmt = guard.prepare(
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
            if let Ok(mut detail) = serde_json::from_str::<SessionDetail>(&raw) {
                if col_comment.is_some() {
                    detail.summary.comment = col_comment;
                }
                if col_color.is_some() {
                    detail.summary.marked_color = col_color;
                }
                populate_fallback_client_ip(&mut detail);
                out.push(detail);
            }
        }
        Ok(out)
    }

    pub fn load_session_by_id(&self, id: u64) -> Result<Option<SessionDetail>, ProxyError> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| ProxyError::Custom("SQLite mutex poisoned".into()))?;

        let row: Option<(String, Option<String>, Option<String>)> = guard
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

    pub fn save_offloaded_body(
        &self,
        session_id: u64,
        is_response: bool,
        bytes: &[u8],
    ) -> Result<(), ProxyError> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| ProxyError::Custom("SQLite mutex poisoned".into()))?;

        guard.execute(
            "INSERT OR REPLACE INTO offloaded_bodies (session_id, is_response, body_bytes)
             VALUES (?1, ?2, ?3)",
            params![session_id as i64, if is_response { 1i64 } else { 0i64 }, bytes],
        )?;
        Ok(())
    }

    pub fn load_offloaded_body(
        &self,
        session_id: u64,
        is_response: bool,
    ) -> Result<Option<Vec<u8>>, ProxyError> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| ProxyError::Custom("SQLite mutex poisoned".into()))?;

        let bytes = guard
            .query_row(
                "SELECT body_bytes
                 FROM offloaded_bodies
                 WHERE session_id = ?1 AND is_response = ?2",
                params![session_id as i64, if is_response { 1i64 } else { 0i64 }],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?;

        Ok(bytes)
    }

    pub fn delete_unarchived_offloaded_bodies(&self) -> Result<usize, ProxyError> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| ProxyError::Custom("SQLite mutex poisoned".into()))?;

        let removed = guard.execute(
            "DELETE FROM offloaded_bodies
             WHERE session_id NOT IN (SELECT id FROM captured_sessions)",
            [],
        )?;
        Ok(removed)
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
        if let Ok(guard) = self.conn.lock() {
            let page_count: i64 = guard
                .query_row("PRAGMA page_count", [], |r| r.get(0))
                .unwrap_or(0);
            let page_size: i64 = guard
                .query_row("PRAGMA page_size", [], |r| r.get(0))
                .unwrap_or(4096);
            return (page_count.max(0) as u64).saturating_mul(page_size.max(0) as u64);
        }
        0
    }

    pub fn delete_many(&self, ids: &[u64]) -> Result<usize, ProxyError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| ProxyError::Custom("SQLite mutex poisoned".into()))?;
        let tx = guard.transaction()?;
        let mut removed = 0usize;
        {
            let mut stmt =
                tx.prepare_cached("DELETE FROM captured_sessions WHERE id = ?1")?;
            let mut body_stmt =
                tx.prepare_cached("DELETE FROM offloaded_bodies WHERE session_id = ?1")?;
            for &id in ids {
                removed += stmt.execute(params![id as i64])?;
                body_stmt.execute(params![id as i64])?;
            }
        }
        tx.commit()?;
        Ok(removed)
    }

    pub fn max_persisted_session_id(&self) -> Result<u64, ProxyError> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| ProxyError::Custom("SQLite mutex poisoned".into()))?;
        let max_id: i64 = guard.query_row(
            "SELECT COALESCE(MAX(m), 0)
             FROM (
                 SELECT MAX(id) AS m FROM captured_sessions
                 UNION ALL
                 SELECT MAX(session_id) AS m FROM offloaded_bodies
             )",
            [],
            |r| r.get(0),
        )?;
        Ok(max_id.max(0) as u64)
    }

    pub fn purge_and_vacuum(&self) -> Result<(), ProxyError> {
        self.purge_and_vacuum_preserving(&[])
    }

    pub fn purge_and_vacuum_preserving(
        &self,
        preserved_offloaded_keys: &[(u64, bool)],
    ) -> Result<(), ProxyError> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| ProxyError::Custom("SQLite mutex poisoned".into()))?;

        let tx = guard.transaction()?;
        if preserved_offloaded_keys.is_empty() {
            tx.execute("DELETE FROM offloaded_bodies;", [])?;
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
            tx.execute(
                "DELETE FROM offloaded_bodies
                 WHERE NOT EXISTS (
                     SELECT 1 FROM _preserve_offloaded p
                     WHERE p.session_id = offloaded_bodies.session_id
                       AND p.is_response = offloaded_bodies.is_response
                 );",
                [],
            )?;
            tx.execute("DROP TABLE _preserve_offloaded;", [])?;
        }
        tx.execute("DELETE FROM captured_sessions;", [])?;
        tx.commit()?;

        guard.execute_batch(
            "PRAGMA wal_checkpoint(TRUNCATE);
             VACUUM;
             PRAGMA wal_checkpoint(TRUNCATE);",
        )?;
        Ok(())
    }

    pub fn count_sessions(&self) -> Result<usize, ProxyError> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| ProxyError::Custom("SQLite mutex poisoned".into()))?;
        let count: i64 =
            guard.query_row("SELECT COUNT(*) FROM captured_sessions", [], |r| r.get(0))?;
        Ok(count.max(0) as usize)
    }

    pub fn count_offloaded_bodies(&self) -> Result<usize, ProxyError> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| ProxyError::Custom("SQLite mutex poisoned".into()))?;
        let count: i64 =
            guard.query_row("SELECT COUNT(*) FROM offloaded_bodies", [], |r| r.get(0))?;
        Ok(count.max(0) as usize)
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
        {
            let guard = archive.conn.lock().unwrap();
            let timeout: i64 = guard
                .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
                .unwrap();
            assert_eq!(timeout, 5000);
        }

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
        {
            let guard = archive.conn.lock().unwrap();
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
        }

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
