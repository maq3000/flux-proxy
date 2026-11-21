use std::sync::{Arc, RwLock};

use dashmap::DashMap;
use regex::Regex;
use tokio::sync::{mpsc, oneshot};

use crate::models::{
    BreakpointAction, BreakpointConfig, BreakpointResolution, BreakpointRule, BreakpointStage,
    PausedBreakpointItem,
};

struct PendingBreakpoint {
    item: PausedBreakpointItem,
    tx: oneshot::Sender<BreakpointResolution>,
}

#[derive(Clone, Debug)]
enum CompiledUrlPattern {
    MatchAll,
    Substring(String),
    Regex(Option<Regex>),
}

impl CompiledUrlPattern {
    fn compile(pattern: &str) -> Self {
        let trimmed = pattern.trim();
        if trimmed.is_empty() || trimmed == "*" {
            return Self::MatchAll;
        }
        if let Some(re_pat) = strip_regex_prefix(trimmed) {
            let compiled = match Regex::new(re_pat.trim()) {
                Ok(re) => Some(re),
                Err(err) => {
                    tracing::warn!(pattern = %pattern, "Invalid breakpoint regex pattern: {err}");
                    None
                }
            };
            return Self::Regex(compiled);
        }

        let pat_lower = trimmed.to_ascii_lowercase();
        if pat_lower.contains('*') || pat_lower.contains('?') {
            let anchor_start = pat_lower.starts_with('^');
            let anchor_end = pat_lower.ends_with('$');
            let inner = pat_lower.strip_prefix('^').unwrap_or(&pat_lower);
            let inner = inner.strip_suffix('$').unwrap_or(inner);

            let mut regex_str = String::from("(?i)");
            if anchor_start {
                regex_str.push('^');
            }
            for ch in inner.chars() {
                if ch == '*' {
                    regex_str.push_str(".*");
                } else if ch == '?' {
                    regex_str.push('.');
                } else {
                    regex_str.push_str(&regex::escape(&ch.to_string()));
                }
            }
            if anchor_end {
                regex_str.push('$');
            }
            let compiled = match Regex::new(&regex_str) {
                Ok(re) => Some(re),
                Err(err) => {
                    tracing::warn!(pattern = %pattern, "Invalid wildcard breakpoint regex: {err}");
                    None
                }
            };
            return Self::Regex(compiled);
        }

        Self::Substring(pat_lower)
    }

    fn matches(&self, url_lower: &mut Option<String>, raw_url: &str) -> bool {
        match self {
            Self::MatchAll => true,
            Self::Substring(needle) => {
                let lowered = url_lower.get_or_insert_with(|| raw_url.to_ascii_lowercase());
                lowered.contains(needle)
            }
            Self::Regex(re_opt) => re_opt.as_ref().is_some_and(|re| re.is_match(raw_url)),
        }
    }

    #[cfg(test)]
    fn compiled_regex(&self) -> Option<&Regex> {
        match self {
            Self::Regex(re_opt) => re_opt.as_ref(),
            Self::MatchAll | Self::Substring(_) => None,
        }
    }
}

#[derive(Clone, Debug)]
struct CompiledBreakpointRule {
    rule: BreakpointRule,
    compiled_pattern: CompiledUrlPattern,
    method_filter_trimmed: Option<String>,
}

impl CompiledBreakpointRule {
    fn compile(rule: BreakpointRule) -> Self {
        let compiled_pattern = CompiledUrlPattern::compile(&rule.url_pattern);
        let method_filter_trimmed = rule
            .method_filter
            .as_deref()
            .map(str::trim)
            .filter(|mf| !mf.is_empty() && !mf.eq_ignore_ascii_case("ANY"))
            .map(str::to_owned);
        Self {
            rule,
            compiled_pattern,
            method_filter_trimmed,
        }
    }

    fn matches(&self, stage: BreakpointStage, method: &str, url_lower: &mut Option<String>, raw_url: &str) -> bool {
        if !self.rule.enabled {
            return false;
        }
        let stage_matches = matches!(
            (self.rule.stage, stage),
            (BreakpointStage::Both, _)
                | (BreakpointStage::Request, BreakpointStage::Request)
                | (BreakpointStage::Response, BreakpointStage::Response)
        );
        if !stage_matches {
            return false;
        }
        if let Some(ref mf) = self.method_filter_trimmed {
            if !mf.eq_ignore_ascii_case(method) {
                return false;
            }
        }
        self.compiled_pattern.matches(url_lower, raw_url)
    }
}

struct CompiledBreakpointState {
    config: BreakpointConfig,
    compiled_rules: Vec<CompiledBreakpointRule>,
}

impl CompiledBreakpointState {
    fn from_config(config: BreakpointConfig) -> Self {
        let compiled_rules = config
            .rules
            .iter()
            .cloned()
            .map(CompiledBreakpointRule::compile)
            .collect();
        Self {
            config,
            compiled_rules,
        }
    }
}

/// Live Breakpoint Engine (Fiddler Classic F11 / Alt+F11 / `bpu` / `bpafter` equivalent).
/// Parks intercepted HTTP/HTTPS requests & responses on `tokio::sync::oneshot::channel`
/// while waiting for interactive developer edits or abort verdicts from the UI.
pub struct BreakpointEngine {
    state: RwLock<CompiledBreakpointState>,
    pending: DashMap<String, PendingBreakpoint>,
    snapshot_tx: Option<mpsc::UnboundedSender<Vec<PausedBreakpointItem>>>,
}

impl Default for BreakpointEngine {
    fn default() -> Self {
        Self::new(None)
    }
}

impl BreakpointEngine {
    pub fn new(snapshot_tx: Option<mpsc::UnboundedSender<Vec<PausedBreakpointItem>>>) -> Self {
        Self {
            state: RwLock::new(CompiledBreakpointState::from_config(default_breakpoint_config())),
            pending: DashMap::new(),
            snapshot_tx,
        }
    }

    pub fn get_config(&self) -> BreakpointConfig {
        self.state
            .read()
            .map(|g| g.config.clone())
            .unwrap_or_else(|_| default_breakpoint_config())
    }

    pub fn update_config(&self, mut next: BreakpointConfig) -> BreakpointConfig {
        next.timeout_secs = next.timeout_secs.clamp(5, 600);
        let compiled_state = CompiledBreakpointState::from_config(next.clone());
        if let Ok(mut guard) = self.state.write() {
            *guard = compiled_state;
        }
        next
    }

    /// Evaluates whether an HTTP request (`BreakpointStage::Request`) or upstream response
    /// (`BreakpointStage::Response`) should pause at an interactive breakpoint.
    /// Patterns and regexes are precompiled during config updates; no regex compilation occurs here.
    pub fn should_break(&self, stage: BreakpointStage, method: &str, url: &str) -> bool {
        let Ok(guard) = self.state.read() else {
            return false;
        };

        match stage {
            BreakpointStage::Request if guard.config.break_before_request => return true,
            BreakpointStage::Response if guard.config.break_after_response => return true,
            _ => {}
        }

        let mut url_lower: Option<String> = None;
        for compiled_rule in &guard.compiled_rules {
            if compiled_rule.matches(stage, method, &mut url_lower, url) {
                return true;
            }
        }

        false
    }

    /// Registers a paused request/response and returns a `(oneshot::Receiver, timeout_secs)` pair
    /// on which `handle_intercepted_request` awaits the developer's verdict.
    pub fn park(&self, mut item: PausedBreakpointItem) -> (oneshot::Receiver<BreakpointResolution>, u64) {
        let timeout_secs = self
            .state
            .read()
            .map(|g| g.config.timeout_secs.clamp(5, 600))
            .unwrap_or(120);
        item.timeout_secs = timeout_secs;

        let (tx, rx) = oneshot::channel();
        let bp_id = item.breakpoint_id.clone();
        self.pending.insert(bp_id, PendingBreakpoint { item, tx });
        self.emit_snapshot();
        (rx, timeout_secs)
    }

    /// Delivers the UI's Continue (with optional edits) or Abort verdict to a parked task.
    pub fn resolve(&self, resolution: BreakpointResolution) -> bool {
        let removed = self.pending.remove(&resolution.breakpoint_id);
        if let Some((_, entry)) = removed {
            let _ = entry.tx.send(resolution);
            self.emit_snapshot();
            true
        } else {
            false
        }
    }

    /// Releases all currently parked breakpoints (e.g., «Resume All» button or proxy stop/shutdown).
    pub fn resume_all(&self, action: BreakpointAction) -> usize {
        let keys: Vec<String> = self.pending.iter().map(|e| e.key().clone()).collect();
        let mut count = 0;
        for key in keys {
            if let Some((_, entry)) = self.pending.remove(&key) {
                let _ = entry.tx.send(BreakpointResolution {
                    breakpoint_id: key,
                    action,
                    method: None,
                    url: None,
                    request_headers: None,
                    request_body_base64: None,
                    request_body_text: None,
                    status_code: None,
                    response_headers: None,
                    response_body_base64: None,
                    response_body_text: None,
                });
                count += 1;
            }
        }
        if count > 0 {
            self.emit_snapshot();
        }
        count
    }

    /// Cleans up a parked entry if the safety timeout elapsed before the user responded.
    pub fn remove_expired(&self, breakpoint_id: &str) {
        if self.pending.remove(breakpoint_id).is_some() {
            self.emit_snapshot();
        }
    }

    /// Cancels a parked breakpoint entry by `breakpoint_id` (e.g., on client disconnect)
    /// and emits an updated snapshot if it was still pending.
    pub fn cancel_pending(&self, breakpoint_id: &str) -> bool {
        if self.pending.remove(breakpoint_id).is_some() {
            self.emit_snapshot();
            true
        } else {
            false
        }
    }

    /// Cancels all parked breakpoint entries belonging to `session_id` and emits an updated
    /// snapshot if at least one entry was removed.
    pub fn cancel_session(&self, session_id: u64) -> usize {
        let keys: Vec<String> = self
            .pending
            .iter()
            .filter(|entry| entry.value().item.session_id == session_id)
            .map(|entry| entry.key().clone())
            .collect();
        let mut count = 0usize;
        for key in keys {
            if self.pending.remove(&key).is_some() {
                count += 1;
            }
        }
        if count > 0 {
            self.emit_snapshot();
        }
        count
    }

    pub fn list_paused(&self) -> Vec<PausedBreakpointItem> {
        let mut list: Vec<PausedBreakpointItem> = self
            .pending
            .iter()
            .map(|entry| entry.value().item.clone())
            .collect();
        list.sort_unstable_by_key(|item| item.session_id);
        list
    }

    fn emit_snapshot(&self) {
        if let Some(ref tx) = self.snapshot_tx {
            let _ = tx.send(self.list_paused());
        }
    }
}

/// RAII guard that removes a parked breakpoint entry and updates session state if the awaiting
/// task is dropped or cancelled before `disarm()` is called (e.g., client socket disconnect).
pub struct PendingBreakpointGuard {
    engine: Arc<BreakpointEngine>,
    breakpoint_id: String,
    session_id: u64,
    on_cancel: Option<Box<dyn FnOnce(u64) + Send>>,
    active: bool,
}

impl PendingBreakpointGuard {
    pub fn new(
        engine: Arc<BreakpointEngine>,
        breakpoint_id: String,
        session_id: u64,
        on_cancel: Option<Box<dyn FnOnce(u64) + Send>>,
    ) -> Self {
        Self {
            engine,
            breakpoint_id,
            session_id,
            on_cancel,
            active: true,
        }
    }

    /// Disarms the guard once awaiting `bp_rx` finishes normally (verdict received or handled timeout).
    pub fn disarm(&mut self) {
        self.active = false;
        self.on_cancel = None;
    }
}

impl Drop for PendingBreakpointGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;
        if !self.engine.cancel_pending(&self.breakpoint_id) {
            let _ = self.engine.cancel_session(self.session_id);
        }
        if let Some(cb) = self.on_cancel.take() {
            cb(self.session_id);
        }
    }
}

pub fn default_breakpoint_config() -> BreakpointConfig {
    BreakpointConfig {
        break_before_request: false,
        break_after_response: false,
        timeout_secs: 120,
        rules: Vec::new(),
    }
}

fn strip_regex_prefix(s: &str) -> Option<&str> {
    if s.is_char_boundary(6) && s.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("regex:")) {
        s.get(6..)
    } else {
        None
    }
}

#[cfg(test)]
fn url_pattern_matches(url_lower: &str, raw_url: &str, pattern: &str) -> bool {
    let mut cached_lower = Some(url_lower.to_string());
    CompiledUrlPattern::compile(pattern).matches(&mut cached_lower, raw_url)
}

#[allow(dead_code)]
pub fn make_bpu_rule(pattern: &str, stage: BreakpointStage) -> BreakpointRule {
    BreakpointRule {
        id: format!("bpu-{}", pattern),
        enabled: true,
        name: format!("bpu {pattern}"),
        stage,
        url_pattern: pattern.to_string(),
        method_filter: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn parks_and_resolves_breakpoint_via_oneshot_channel() {
        let engine = BreakpointEngine::new(None);
        let mut cfg = engine.get_config();
        cfg.rules.push(make_bpu_rule("/v1/checkout", BreakpointStage::Request));
        engine.update_config(cfg);

        assert!(engine.should_break(
            BreakpointStage::Request,
            "POST",
            "https://api.stripe.com/v1/checkout/sessions"
        ));
        assert!(!engine.should_break(
            BreakpointStage::Response,
            "POST",
            "https://api.stripe.com/v1/checkout/sessions"
        ));

        let item = PausedBreakpointItem {
            breakpoint_id: "bp-req-42".into(),
            session_id: 42,
            stage: BreakpointStage::Request,
            created_at: "2026-10-30T11:00:00Z".into(),
            timeout_secs: 120,
            scheme: "https".into(),
            method: "POST".into(),
            url: "https://api.stripe.com/v1/checkout/sessions".into(),
            host: "api.stripe.com".into(),
            path: "/v1/checkout/sessions".into(),
            request_headers: Vec::new(),
            request_body_base64: String::new(),
            request_body_text: Some("{\"amount\":1000}".into()),
            response_status: None,
            response_headers: Vec::new(),
            response_body_base64: String::new(),
            response_body_text: None,
            process_name: Some("chrome.exe".into()),
            process_pid: Some(1234),
        };

        let (rx, timeout) = engine.park(item);
        assert_eq!(timeout, 120);
        assert_eq!(engine.list_paused().len(), 1);

        let resolved = engine.resolve(BreakpointResolution {
            breakpoint_id: "bp-req-42".into(),
            action: BreakpointAction::Continue,
            method: None,
            url: None,
            request_headers: None,
            request_body_base64: None,
            request_body_text: Some("{\"amount\":9999}".into()),
            status_code: None,
            response_headers: None,
            response_body_base64: None,
            response_body_text: None,
        });
        assert!(resolved);
        assert!(engine.list_paused().is_empty());

        let verdict = rx.await.unwrap();
        assert_eq!(verdict.action, BreakpointAction::Continue);
        assert_eq!(
            verdict.request_body_text.as_deref(),
            Some("{\"amount\":9999}")
        );
    }

    #[test]
    fn wildcard_patterns_match_substrings_consistently_with_plain_patterns_and_explicit_anchors() {
        let url = "https://api.stripe.com/v1/checkout/sessions?mode=payment";
        let lower = url.to_ascii_lowercase();

        // Plain substring vs wildcard substring
        assert!(url_pattern_matches(&lower, url, "/v1/checkout"));
        assert!(url_pattern_matches(&lower, url, "/v1/*/sessions"));
        assert!(url_pattern_matches(&lower, url, "api.*.com/*/sessions"));
        assert!(url_pattern_matches(&lower, url, "v?/checkout"));
        assert!(url_pattern_matches(&lower, url, "*checkout*"));
        assert!(url_pattern_matches(&lower, url, "https://*.stripe.com/*"));

        // Explicit anchors still restrict boundaries
        assert!(url_pattern_matches(&lower, url, "^https://api.stripe.com/*mode=payment$"));
        assert!(!url_pattern_matches(&lower, url, "^/v1/*/sessions$"));

        // Case-insensitive `regex:` prefix and UTF-8 safety
        assert!(url_pattern_matches(&lower, url, "ReGeX:/v1/[a-z]+/sessions"));
        assert!(!url_pattern_matches(&lower, url, "ab😀cd"));
    }

    #[test]
    fn precompiles_breakpoint_regex_and_wildcards_on_update_config() {
        let engine = BreakpointEngine::new(None);
        let mut cfg = default_breakpoint_config();
        cfg.rules.push(make_bpu_rule(
            r"regex:^https://api\.example\.com/v\d+/pay/[a-f0-9]+$",
            BreakpointStage::Request,
        ));
        cfg.rules.push(make_bpu_rule(
            "https://*.stripe.com/*/sessions",
            BreakpointStage::Both,
        ));
        cfg.rules.push(make_bpu_rule(
            "/healthz",
            BreakpointStage::Response,
        ));
        cfg.rules.push(make_bpu_rule(
            "regex:[unclosed",
            BreakpointStage::Request,
        ));
        engine.update_config(cfg);

        {
            let guard = engine.state.read().unwrap();
            assert!(guard.compiled_rules[0].compiled_pattern.compiled_regex().is_some());
            assert!(guard.compiled_rules[1].compiled_pattern.compiled_regex().is_some());
            assert!(guard.compiled_rules[2].compiled_pattern.compiled_regex().is_none());
            assert!(guard.compiled_rules[3].compiled_pattern.compiled_regex().is_none());
        }

        let started = std::time::Instant::now();
        let mut matched_count = 0usize;
        for _ in 0..5_000 {
            if engine.should_break(
                BreakpointStage::Request,
                "POST",
                "https://api.example.com/v2/pay/deadbeef",
            ) {
                matched_count += 1;
            }
        }
        assert_eq!(matched_count, 5_000);
        assert!(started.elapsed().as_secs_f64() < 5.0);
        assert!(!engine.should_break(
            BreakpointStage::Request,
            "GET",
            "https://api.example.com/healthz",
        ));
        assert!(engine.should_break(
            BreakpointStage::Response,
            "GET",
            "https://api.example.com/healthz",
        ));
    }

    #[test]
    fn pending_breakpoint_guard_cleans_up_on_drop_unless_disarmed() {
        use std::sync::atomic::{AtomicU64, Ordering};

        let (tx, mut rx) = mpsc::unbounded_channel();
        let engine = Arc::new(BreakpointEngine::new(Some(tx)));

        let make_item = |bp_id: &str, session_id: u64| PausedBreakpointItem {
            breakpoint_id: bp_id.into(),
            session_id,
            stage: BreakpointStage::Request,
            created_at: "2026-11-21T10:00:00Z".into(),
            timeout_secs: 120,
            scheme: "https".into(),
            method: "GET".into(),
            url: format!("https://example.com/{session_id}"),
            host: "example.com".into(),
            path: format!("/{session_id}"),
            request_headers: Vec::new(),
            request_body_base64: String::new(),
            request_body_text: None,
            response_status: None,
            response_headers: Vec::new(),
            response_body_base64: String::new(),
            response_body_text: None,
            process_name: None,
            process_pid: None,
        };

        // 1. Dropped guard without disarm -> removes pending, emits empty snapshot, fires on_cancel
        let (_bp_rx1, _) = engine.park(make_item("bp-req-101", 101));
        assert_eq!(rx.try_recv().unwrap().len(), 1);
        let cancelled_sid = Arc::new(AtomicU64::new(0));
        let cancelled_sid_clone = cancelled_sid.clone();
        {
            let _guard = PendingBreakpointGuard::new(
                engine.clone(),
                "bp-req-101".into(),
                101,
                Some(Box::new(move |sid| {
                    cancelled_sid_clone.store(sid, Ordering::SeqCst);
                })),
            );
        }
        assert!(engine.list_paused().is_empty());
        assert_eq!(cancelled_sid.load(Ordering::SeqCst), 101);
        assert!(rx.try_recv().unwrap().is_empty());

        // 2. Disarmed guard -> does not fire on_cancel or cancel entry on drop
        let (_bp_rx2, _) = engine.park(make_item("bp-req-102", 102));
        assert_eq!(rx.try_recv().unwrap().len(), 1);
        let disarmed_cb_called = Arc::new(AtomicU64::new(0));
        let disarmed_cb_clone = disarmed_cb_called.clone();
        {
            let mut guard = PendingBreakpointGuard::new(
                engine.clone(),
                "bp-req-102".into(),
                102,
                Some(Box::new(move |sid| {
                    disarmed_cb_clone.store(sid, Ordering::SeqCst);
                })),
            );
            guard.disarm();
        }
        assert_eq!(disarmed_cb_called.load(Ordering::SeqCst), 0);
        assert_eq!(engine.list_paused().len(), 1);
        assert!(rx.try_recv().is_err());
    }
}
