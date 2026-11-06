pub mod sqlite;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;

use crate::models::{ProxyError, SessionDetail, SessionSummary};
use crate::storage::sqlite::SqliteArchive;

/// Dual-tier traffic store:
/// 1. Lock-free in-memory `DashMap` for sub-millisecond capture & inspection.
/// 2. Embedded WAL-mode SQLite archive (`rusqlite`) for persisting and restoring sessions.
pub struct TrafficStore {
    next_id: AtomicU64,
    sessions: DashMap<u64, Arc<SessionDetail>>,
    sqlite: SqliteArchive,
}

impl TrafficStore {
    pub fn new(db_path: PathBuf) -> Result<Self, ProxyError> {
        let sqlite = SqliteArchive::open(&db_path)?;
        Ok(Self {
            next_id: AtomicU64::new(1),
            sessions: DashMap::with_capacity(16_384),
            sqlite,
        })
    }

    pub fn allocate_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn insert(&self, mut detail: SessionDetail) {
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
        self.sessions.insert(id, Arc::new(detail));
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

    pub fn clear(&self) {
        self.sessions.clear();
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
        let loaded = self.sqlite.load_recent(10_000)?;
        let mut max_id = self.next_id.load(Ordering::Relaxed);
        let mut summaries = Vec::with_capacity(loaded.len());

        for detail in loaded {
            if detail.summary.id >= max_id {
                max_id = detail.summary.id + 1;
            }
            summaries.push(detail.summary.clone());
            self.sessions.insert(detail.summary.id, Arc::new(detail));
        }

        self.next_id.store(max_id, Ordering::Relaxed);
        Ok(summaries)
    }
}
