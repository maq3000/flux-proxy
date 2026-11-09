use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{ProxyError, SessionDetail};

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
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
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
             CREATE INDEX IF NOT EXISTS idx_sessions_url ON captured_sessions(url);
             CREATE INDEX IF NOT EXISTS idx_sessions_status ON captured_sessions(status);
             CREATE TABLE IF NOT EXISTS offloaded_bodies (
                 session_id INTEGER NOT NULL,
                 is_response INTEGER NOT NULL,
                 body_bytes BLOB NOT NULL,
                 PRIMARY KEY (session_id, is_response)
             );",
        )?;

        Self::ensure_annotation_columns(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
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
                let _ = body_stmt.execute(params![id as i64])?;
            }
        }
        tx.commit()?;
        Ok(removed)
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
            },
            request_headers: vec![HeaderPair {
                name: "Authorization".into(),
                value: "Bearer expired_jwt".into(),
            }],
            response_headers: vec![HeaderPair {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }],
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
}
