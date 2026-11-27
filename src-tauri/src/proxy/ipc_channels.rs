use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, Notify};

use crate::models::{PausedBreakpointItem, SessionSummary};

pub const DEFAULT_EVENT_CHANNEL_CAPACITY: usize = 16_384;
pub const DEFAULT_REMOVED_CHANNEL_CAPACITY: usize = 16_384;

struct SummaryQueueState {
    order: VecDeque<u64>,
    items: HashMap<u64, SessionSummary>,
    capacity: usize,
    sender_count: usize,
    receiver_dropped: bool,
}

struct SummaryChannelInner {
    state: Mutex<SummaryQueueState>,
    notify: Notify,
}

pub struct SessionEventSender {
    inner: Arc<SummaryChannelInner>,
}

pub struct SessionEventReceiver {
    inner: Arc<SummaryChannelInner>,
}

pub fn session_event_channel(capacity: usize) -> (SessionEventSender, SessionEventReceiver) {
    let cap = capacity.max(1);
    let inner = Arc::new(SummaryChannelInner {
        state: Mutex::new(SummaryQueueState {
            order: VecDeque::with_capacity(cap.min(1024)),
            items: HashMap::with_capacity(cap.min(1024)),
            capacity: cap,
            sender_count: 1,
            receiver_dropped: false,
        }),
        notify: Notify::new(),
    });
    (
        SessionEventSender {
            inner: Arc::clone(&inner),
        },
        SessionEventReceiver { inner },
    )
}

impl SessionEventSender {
    pub fn send(&self, item: SessionSummary) -> Result<(), Box<SessionSummary>> {
        {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.receiver_dropped {
                return Err(Box::new(item));
            }
            if let Some(existing) = state.items.get_mut(&item.id) {
                *existing = item;
            } else {
                if state.items.len() >= state.capacity {
                    if let Some(oldest_id) = state.order.pop_front() {
                        state.items.remove(&oldest_id);
                    }
                }
                let id = item.id;
                state.order.push_back(id);
                state.items.insert(id, item);
            }
        }
        self.inner.notify.notify_one();
        Ok(())
    }
}

impl Clone for SessionEventSender {
    fn clone(&self) -> Self {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.sender_count += 1;
        drop(state);
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl Drop for SessionEventSender {
    fn drop(&mut self) {
        let last_sender = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.sender_count = state.sender_count.saturating_sub(1);
            state.sender_count == 0
        };
        if last_sender {
            self.inner.notify.notify_waiters();
        }
    }
}

impl SessionEventReceiver {
    pub fn is_closed(&self) -> bool {
        let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.sender_count == 0
    }

    pub fn try_recv(&mut self) -> Result<SessionSummary, mpsc::error::TryRecvError> {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        while let Some(id) = state.order.pop_front() {
            if let Some(item) = state.items.remove(&id) {
                return Ok(item);
            }
        }
        if state.sender_count == 0 {
            Err(mpsc::error::TryRecvError::Disconnected)
        } else {
            Err(mpsc::error::TryRecvError::Empty)
        }
    }

    pub async fn recv(&mut self) -> Option<SessionSummary> {
        loop {
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(id) = state.order.pop_front() {
                    if let Some(item) = state.items.remove(&id) {
                        return Some(item);
                    }
                    continue;
                }
                if state.sender_count == 0 {
                    return None;
                }
            }
            notified.await;
        }
    }
}

impl Drop for SessionEventReceiver {
    fn drop(&mut self) {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.receiver_dropped = true;
    }
}

struct RemovedQueueState {
    order: VecDeque<u64>,
    seen: HashSet<u64>,
    capacity: usize,
    sender_count: usize,
    receiver_dropped: bool,
}

struct RemovedChannelInner {
    state: Mutex<RemovedQueueState>,
    notify: Notify,
}

pub struct RemovedIdsSender {
    inner: Arc<RemovedChannelInner>,
}

pub struct RemovedIdsReceiver {
    inner: Arc<RemovedChannelInner>,
}

pub fn removed_ids_channel(capacity: usize) -> (RemovedIdsSender, RemovedIdsReceiver) {
    let cap = capacity.max(1);
    let inner = Arc::new(RemovedChannelInner {
        state: Mutex::new(RemovedQueueState {
            order: VecDeque::with_capacity(cap.min(256)),
            seen: HashSet::with_capacity(cap.min(256)),
            capacity: cap,
            sender_count: 1,
            receiver_dropped: false,
        }),
        notify: Notify::new(),
    });
    (
        RemovedIdsSender {
            inner: Arc::clone(&inner),
        },
        RemovedIdsReceiver { inner },
    )
}

impl RemovedIdsSender {
    pub fn send(&self, ids: Vec<u64>) -> Result<(), Vec<u64>> {
        let mut pushed_any = false;
        {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.receiver_dropped {
                return Err(ids);
            }
            if ids.is_empty() {
                return Ok(());
            }
            for id in ids {
                if state.seen.contains(&id) {
                    continue;
                }
                if state.seen.len() >= state.capacity {
                    if let Some(oldest) = state.order.pop_front() {
                        state.seen.remove(&oldest);
                    }
                }
                state.seen.insert(id);
                state.order.push_back(id);
                pushed_any = true;
            }
        }
        if pushed_any {
            self.inner.notify.notify_one();
        }
        Ok(())
    }
}

impl Clone for RemovedIdsSender {
    fn clone(&self) -> Self {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.sender_count += 1;
        drop(state);
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl Drop for RemovedIdsSender {
    fn drop(&mut self) {
        let last_sender = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.sender_count = state.sender_count.saturating_sub(1);
            state.sender_count == 0
        };
        if last_sender {
            self.inner.notify.notify_waiters();
        }
    }
}

impl RemovedIdsReceiver {
    pub fn is_closed(&self) -> bool {
        let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.sender_count == 0
    }

    pub fn try_recv(&mut self) -> Result<Vec<u64>, mpsc::error::TryRecvError> {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.order.is_empty() {
            let batch: Vec<u64> = state.order.drain(..).collect();
            state.seen.clear();
            return Ok(batch);
        }
        if state.sender_count == 0 {
            Err(mpsc::error::TryRecvError::Disconnected)
        } else {
            Err(mpsc::error::TryRecvError::Empty)
        }
    }

    pub async fn recv(&mut self) -> Option<Vec<u64>> {
        loop {
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
                if !state.order.is_empty() {
                    let batch: Vec<u64> = state.order.drain(..).collect();
                    state.seen.clear();
                    return Some(batch);
                }
                if state.sender_count == 0 {
                    return None;
                }
            }
            notified.await;
        }
    }
}

impl Drop for RemovedIdsReceiver {
    fn drop(&mut self) {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.receiver_dropped = true;
    }
}

struct BreakpointSnapshotState {
    latest: Option<Vec<PausedBreakpointItem>>,
    sender_count: usize,
    receiver_dropped: bool,
}

struct BreakpointChannelInner {
    state: Mutex<BreakpointSnapshotState>,
    notify: Notify,
}

pub struct BreakpointSnapshotSender {
    inner: Arc<BreakpointChannelInner>,
}

pub struct BreakpointSnapshotReceiver {
    inner: Arc<BreakpointChannelInner>,
}

pub fn breakpoint_snapshot_channel() -> (BreakpointSnapshotSender, BreakpointSnapshotReceiver) {
    let inner = Arc::new(BreakpointChannelInner {
        state: Mutex::new(BreakpointSnapshotState {
            latest: None,
            sender_count: 1,
            receiver_dropped: false,
        }),
        notify: Notify::new(),
    });
    (
        BreakpointSnapshotSender {
            inner: Arc::clone(&inner),
        },
        BreakpointSnapshotReceiver { inner },
    )
}

impl BreakpointSnapshotSender {
    pub fn send(
        &self,
        snapshot: Vec<PausedBreakpointItem>,
    ) -> Result<(), Vec<PausedBreakpointItem>> {
        {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.receiver_dropped {
                return Err(snapshot);
            }
            state.latest = Some(snapshot);
        }
        self.inner.notify.notify_one();
        Ok(())
    }
}

impl Clone for BreakpointSnapshotSender {
    fn clone(&self) -> Self {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.sender_count += 1;
        drop(state);
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl Drop for BreakpointSnapshotSender {
    fn drop(&mut self) {
        let last_sender = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.sender_count = state.sender_count.saturating_sub(1);
            state.sender_count == 0
        };
        if last_sender {
            self.inner.notify.notify_waiters();
        }
    }
}

impl BreakpointSnapshotReceiver {
    pub fn is_closed(&self) -> bool {
        let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.sender_count == 0
    }

    pub fn try_recv(
        &mut self,
    ) -> Result<Vec<PausedBreakpointItem>, mpsc::error::TryRecvError> {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(snapshot) = state.latest.take() {
            return Ok(snapshot);
        }
        if state.sender_count == 0 {
            Err(mpsc::error::TryRecvError::Disconnected)
        } else {
            Err(mpsc::error::TryRecvError::Empty)
        }
    }

    pub async fn recv(&mut self) -> Option<Vec<PausedBreakpointItem>> {
        loop {
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(snapshot) = state.latest.take() {
                    return Some(snapshot);
                }
                if state.sender_count == 0 {
                    return None;
                }
            }
            notified.await;
        }
    }
}

impl Drop for BreakpointSnapshotReceiver {
    fn drop(&mut self) {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.receiver_dropped = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::BreakpointStage;

    fn make_summary(id: u64, status: u16) -> SessionSummary {
        SessionSummary {
            id,
            status,
            protocol: "HTTPS/2".into(),
            scheme: "https".into(),
            method: "GET".into(),
            host: "example.com".into(),
            path: format!("/{id}"),
            url: format!("https://example.com/{id}"),
            content_type: "application/json".into(),
            body_size: 0,
            duration_ms: 1,
            timestamp: "2026-11-27T07:00:00Z".into(),
            is_mocked: false,
            matched_rule_id: None,
            error: None,
            process_name: None,
            process_pid: None,
            tls_bypassed: false,
            headers_mutated: false,
            breakpoint_paused: None,
            breakpoint_modified: false,
            comment: None,
            marked_color: None,
            client_ip: None,
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
        }
    }

    fn make_bp_item(bp_id: &str, session_id: u64) -> PausedBreakpointItem {
        PausedBreakpointItem {
            breakpoint_id: bp_id.into(),
            session_id,
            stage: BreakpointStage::Request,
            created_at: "2026-11-27T07:00:00Z".into(),
            timeout_secs: 120,
            scheme: "https".into(),
            method: "GET".into(),
            url: format!("https://example.com/{session_id}"),
            host: "example.com".into(),
            path: format!("/{session_id}"),
            request_headers: Vec::new(),
            request_body_base64: String::new(),
            request_body_text: None,
            request_body_offloaded: false,
            request_body_size: 0,
            response_status: None,
            response_headers: Vec::new(),
            response_body_base64: String::new(),
            response_body_text: None,
            response_body_offloaded: false,
            response_body_size: 0,
            body_offloaded: false,
            body_size: 0,
            process_name: None,
            process_pid: None,
        }
    }

    #[tokio::test]
    async fn session_event_channel_coalesces_by_id_and_evicts_oldest_on_capacity() {
        let (tx, mut rx) = session_event_channel(2);
        tx.send(make_summary(1, 0)).unwrap();
        tx.send(make_summary(2, 0)).unwrap();
        // In-place coalescing for existing ID does not evict ID 1
        tx.send(make_summary(1, 200)).unwrap();
        // New ID 3 exceeds capacity 2, evicting oldest ID 1
        tx.send(make_summary(3, 201)).unwrap();

        let first = rx.recv().await.unwrap();
        let second = rx.recv().await.unwrap();
        assert_eq!(first.id, 2);
        assert_eq!(second.id, 3);
        assert_eq!(second.status, 201);
        assert!(matches!(rx.try_recv(), Err(mpsc::error::TryRecvError::Empty)));

        tx.send(make_summary(10, 0)).unwrap();
        tx.send(make_summary(10, 204)).unwrap();
        let coalesced = rx.recv().await.unwrap();
        assert_eq!(coalesced.id, 10);
        assert_eq!(coalesced.status, 204);
        assert!(matches!(rx.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
    }

    #[tokio::test]
    async fn removed_ids_channel_deduplicates_coalesces_and_bounds_capacity() {
        let (tx, mut rx) = removed_ids_channel(3);
        tx.send(vec![1, 2]).unwrap();
        tx.send(vec![2, 3]).unwrap();
        tx.send(vec![4]).unwrap(); // evicts 1 -> leaves [2, 3, 4]

        let batch = rx.recv().await.unwrap();
        assert_eq!(batch, vec![2, 3, 4]);
        assert!(matches!(rx.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
    }

    #[tokio::test]
    async fn breakpoint_snapshot_channel_coalesces_to_latest() {
        let (tx, mut rx) = breakpoint_snapshot_channel();
        tx.send(vec![make_bp_item("bp-1", 1)]).unwrap();
        tx.send(vec![make_bp_item("bp-1", 1), make_bp_item("bp-2", 2)])
            .unwrap();
        tx.send(vec![make_bp_item("bp-3", 3)]).unwrap();

        let latest = rx.recv().await.unwrap();
        assert_eq!(latest.len(), 1);
        assert_eq!(latest[0].breakpoint_id, "bp-3");
        assert!(matches!(rx.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
    }

    #[tokio::test]
    async fn bounded_channels_wake_and_return_none_when_all_senders_drop() {
        let (ev_tx, mut ev_rx) = session_event_channel(4);
        let (rem_tx, mut rem_rx) = removed_ids_channel(4);
        let (bp_tx, mut bp_rx) = breakpoint_snapshot_channel();

        let ev_task = tokio::spawn(async move { ev_rx.recv().await });
        let rem_task = tokio::spawn(async move { rem_rx.recv().await });
        let bp_task = tokio::spawn(async move { bp_rx.recv().await });

        tokio::task::yield_now().await;
        drop(ev_tx);
        drop(rem_tx);
        drop(bp_tx);

        assert!(ev_task.await.unwrap().is_none());
        assert!(rem_task.await.unwrap().is_none());
        assert!(bp_task.await.unwrap().is_none());
    }
}
