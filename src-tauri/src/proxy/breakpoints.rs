use std::sync::{Arc, RwLock};

use base64::Engine as _;
use dashmap::DashMap;
use regex::Regex;
use tokio::sync::{mpsc, oneshot};

use crate::models::{
    BreakpointAction, BreakpointConfig, BreakpointResolution, BreakpointRule, BreakpointStage,
    LoadedSessionBody, PausedBreakpointItem, ProxyError,
};
use crate::storage::TrafficStore;

/// Maximum decoded body size inlined directly inside `PausedBreakpointItem` snapshots (256 KiB).
/// Larger payloads are offloaded to SQLite `offloaded_bodies` and fetched lazily on queue selection.
pub const BREAKPOINT_INLINE_BODY_LIMIT_BYTES: usize = 256 * 1024;

struct PendingBreakpoint {
    item: PausedBreakpointItem,
    offloaded_keys: Vec<(u64, bool)>,
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
    store: Option<Arc<TrafficStore>>,
}

impl Default for BreakpointEngine {
    fn default() -> Self {
        Self::new(None)
    }
}

impl BreakpointEngine {
    pub fn new(snapshot_tx: Option<mpsc::UnboundedSender<Vec<PausedBreakpointItem>>>) -> Self {
        Self::new_with_store(snapshot_tx, None)
    }

    pub fn new_with_store(
        snapshot_tx: Option<mpsc::UnboundedSender<Vec<PausedBreakpointItem>>>,
        store: Option<Arc<TrafficStore>>,
    ) -> Self {
        Self {
            state: RwLock::new(CompiledBreakpointState::from_config(default_breakpoint_config())),
            pending: DashMap::new(),
            snapshot_tx,
            store,
        }
    }

    fn cleanup_offloaded(&self, offloaded_keys: &[(u64, bool)]) {
        if offloaded_keys.is_empty() {
            return;
        }
        if let Some(ref store) = self.store {
            store.delete_breakpoint_offloaded_bodies(offloaded_keys);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare_stage_body(
        store: Option<&Arc<TrafficStore>>,
        session_id: u64,
        is_response: bool,
        raw: Option<&[u8]>,
        body_base64: &mut String,
        body_text: &mut Option<String>,
        body_offloaded: &mut bool,
        body_size: &mut usize,
        offloaded_keys: &mut Vec<(u64, bool)>,
    ) {
        let decoded_owned: Option<Vec<u8>> = if raw.is_some() {
            None
        } else if !body_base64.is_empty() {
            base64::engine::general_purpose::STANDARD
                .decode(body_base64.as_bytes())
                .ok()
        } else {
            body_text.as_ref().map(|t| t.as_bytes().to_vec())
        };

        let effective_bytes: &[u8] = match (raw, decoded_owned.as_deref()) {
            (Some(slice), _) => slice,
            (None, Some(vec)) => vec,
            (None, None) => &[],
        };

        *body_size = effective_bytes.len();
        if effective_bytes.len() > BREAKPOINT_INLINE_BODY_LIMIT_BYTES {
            let offloaded_ok = store
                .map(|st| {
                    st.save_breakpoint_offloaded_body(
                        session_id,
                        is_response,
                        effective_bytes.to_vec(),
                    )
                    .is_ok()
                })
                .unwrap_or(false);

            if offloaded_ok {
                *body_offloaded = true;
                body_base64.clear();
                *body_text = None;
                offloaded_keys.push((session_id, is_response));
            } else {
                *body_offloaded = false;
                let clipped =
                    &effective_bytes[..effective_bytes.len().min(BREAKPOINT_INLINE_BODY_LIMIT_BYTES)];
                *body_base64 = base64::engine::general_purpose::STANDARD.encode(clipped);
                *body_text = truncate_utf8_prefix(clipped);
            }
        } else {
            *body_offloaded = false;
            if let Some(slice) = raw {
                if slice.is_empty() {
                    body_base64.clear();
                    *body_text = None;
                } else {
                    *body_base64 = base64::engine::general_purpose::STANDARD.encode(slice);
                    *body_text = std::str::from_utf8(slice).ok().map(str::to_owned);
                }
            }
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
    pub fn park(&self, item: PausedBreakpointItem) -> (oneshot::Receiver<BreakpointResolution>, u64) {
        self.park_with_bodies(item, None, None)
    }

    /// Registers a paused request/response with optional raw byte buffers so payloads exceeding
    /// `BREAKPOINT_INLINE_BODY_LIMIT_BYTES` (256 KiB) are offloaded into `offloaded_bodies` instead
    /// of inflating `PausedBreakpointItem` snapshots and IPC broadcasts.
    pub fn park_with_bodies(
        &self,
        mut item: PausedBreakpointItem,
        raw_req_bytes: Option<&[u8]>,
        raw_resp_bytes: Option<&[u8]>,
    ) -> (oneshot::Receiver<BreakpointResolution>, u64) {
        let timeout_secs = self
            .state
            .read()
            .map(|g| g.config.timeout_secs.clamp(5, 600))
            .unwrap_or(120);
        item.timeout_secs = timeout_secs;

        let mut offloaded_keys = Vec::new();
        Self::prepare_stage_body(
            self.store.as_ref(),
            item.session_id,
            false,
            raw_req_bytes,
            &mut item.request_body_base64,
            &mut item.request_body_text,
            &mut item.request_body_offloaded,
            &mut item.request_body_size,
            &mut offloaded_keys,
        );
        Self::prepare_stage_body(
            self.store.as_ref(),
            item.session_id,
            true,
            raw_resp_bytes,
            &mut item.response_body_base64,
            &mut item.response_body_text,
            &mut item.response_body_offloaded,
            &mut item.response_body_size,
            &mut offloaded_keys,
        );

        match item.stage {
            BreakpointStage::Request | BreakpointStage::Both => {
                item.body_offloaded = item.request_body_offloaded;
                item.body_size = item.request_body_size;
            }
            BreakpointStage::Response => {
                item.body_offloaded = item.response_body_offloaded;
                item.body_size = item.response_body_size;
            }
        }

        let (tx, rx) = oneshot::channel();
        let bp_id = item.breakpoint_id.clone();
        self.pending.insert(
            bp_id,
            PendingBreakpoint {
                item,
                offloaded_keys,
                tx,
            },
        );
        self.emit_snapshot();
        (rx, timeout_secs)
    }

    /// Lazily loads a paused breakpoint's full body (hydrating from `offloaded_bodies` if > 256 KiB).
    pub fn load_paused_body(
        &self,
        breakpoint_id: &str,
        is_response: bool,
    ) -> Result<Option<LoadedSessionBody>, ProxyError> {
        let Some(entry) = self.pending.get(breakpoint_id) else {
            return Ok(None);
        };
        let session_id = entry.item.session_id;
        let (offloaded, inline_b64, inline_txt, expected_size) = if is_response {
            (
                entry.item.response_body_offloaded,
                entry.item.response_body_base64.clone(),
                entry.item.response_body_text.clone(),
                entry.item.response_body_size,
            )
        } else {
            (
                entry.item.request_body_offloaded,
                entry.item.request_body_base64.clone(),
                entry.item.request_body_text.clone(),
                entry.item.request_body_size,
            )
        };
        drop(entry);

        if offloaded {
            if let Some(ref store) = self.store {
                if let Some(raw_bytes) =
                    store.load_breakpoint_offloaded_body(session_id, is_response)?
                {
                    return Ok(Some(LoadedSessionBody {
                        id: session_id,
                        is_response,
                        body_base64: base64::engine::general_purpose::STANDARD.encode(&raw_bytes),
                        body_text: std::str::from_utf8(&raw_bytes).ok().map(str::to_owned),
                        body_size: raw_bytes.len().max(expected_size),
                    }));
                }
            }
            return Ok(None);
        }

        let decoded_len = if !inline_b64.is_empty() {
            base64::engine::general_purpose::STANDARD
                .decode(inline_b64.as_bytes())
                .map(|b| b.len())
                .unwrap_or(expected_size)
        } else if let Some(ref txt) = inline_txt {
            txt.len()
        } else {
            0
        };

        Ok(Some(LoadedSessionBody {
            id: session_id,
            is_response,
            body_base64: inline_b64,
            body_text: inline_txt,
            body_size: decoded_len.max(expected_size),
        }))
    }

    /// Delivers the UI's Continue (with optional edits) or Abort verdict to a parked task.
    pub fn resolve(&self, resolution: BreakpointResolution) -> bool {
        let removed = self.pending.remove(&resolution.breakpoint_id);
        if let Some((_, entry)) = removed {
            self.cleanup_offloaded(&entry.offloaded_keys);
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
        let mut offloaded_cleanup = Vec::new();
        for key in keys {
            if let Some((_, entry)) = self.pending.remove(&key) {
                offloaded_cleanup.extend(entry.offloaded_keys);
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
        self.cleanup_offloaded(&offloaded_cleanup);
        if count > 0 {
            self.emit_snapshot();
        }
        count
    }

    /// Cleans up a parked entry if the safety timeout elapsed before the user responded.
    pub fn remove_expired(&self, breakpoint_id: &str) {
        if let Some((_, entry)) = self.pending.remove(breakpoint_id) {
            self.cleanup_offloaded(&entry.offloaded_keys);
            self.emit_snapshot();
        }
    }

    /// Cancels a parked breakpoint entry by `breakpoint_id` (e.g., on client disconnect)
    /// and emits an updated snapshot if it was still pending.
    pub fn cancel_pending(&self, breakpoint_id: &str) -> bool {
        if let Some((_, entry)) = self.pending.remove(breakpoint_id) {
            self.cleanup_offloaded(&entry.offloaded_keys);
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
        let mut offloaded_cleanup = Vec::new();
        for key in keys {
            if let Some((_, entry)) = self.pending.remove(&key) {
                offloaded_cleanup.extend(entry.offloaded_keys);
                count += 1;
            }
        }
        self.cleanup_offloaded(&offloaded_cleanup);
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

fn truncate_utf8_prefix(slice: &[u8]) -> Option<String> {
    if slice.is_empty() {
        return None;
    }
    match std::str::from_utf8(slice) {
        Ok(s) => Some(s.to_owned()),
        Err(err) => {
            let valid_up_to = err.valid_up_to();
            if valid_up_to > 0 && valid_up_to + 4 >= slice.len() {
                std::str::from_utf8(&slice[..valid_up_to])
                    .ok()
                    .map(str::to_owned)
            } else {
                None
            }
        }
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
            request_body_offloaded: false,
            request_body_size: 15,
            response_status: None,
            response_headers: Vec::new(),
            response_body_base64: String::new(),
            response_body_text: None,
            response_body_offloaded: false,
            response_body_size: 0,
            body_offloaded: false,
            body_size: 15,
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

    #[test]
    fn park_with_bodies_offloads_over_256kib_and_cleans_up_all_exit_paths() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let db_path = std::env::temp_dir().join(format!(
            "fluxproxy_bp_offload_{}_{nanos}.sqlite",
            std::process::id()
        ));
        let cleanup = |p: &std::path::Path| {
            let _ = std::fs::remove_file(p);
            for suffix in ["-wal", "-shm"] {
                let mut sc = p.as_os_str().to_os_string();
                sc.push(suffix);
                let _ = std::fs::remove_file(sc);
            }
        };
        cleanup(&db_path);

        let store = Arc::new(TrafficStore::new(db_path.clone()).expect("init store"));
        let engine = BreakpointEngine::new_with_store(None, Some(Arc::clone(&store)));

        let heavy_req = vec![b'R'; BREAKPOINT_INLINE_BODY_LIMIT_BYTES + 4096];
        let heavy_resp = vec![b'S'; BREAKPOINT_INLINE_BODY_LIMIT_BYTES + 8192];

        let blank_item = |bp_id: &str, session_id: u64, stage: BreakpointStage| PausedBreakpointItem {
            breakpoint_id: bp_id.into(),
            session_id,
            stage,
            created_at: "2026-11-26T12:00:00Z".into(),
            timeout_secs: 120,
            scheme: "https".into(),
            method: "POST".into(),
            url: format!("https://example.com/{session_id}"),
            host: "example.com".into(),
            path: format!("/{session_id}"),
            request_headers: Vec::new(),
            request_body_base64: String::new(),
            request_body_text: None,
            request_body_offloaded: false,
            request_body_size: 0,
            response_status: (stage == BreakpointStage::Response).then_some(200),
            response_headers: Vec::new(),
            response_body_base64: String::new(),
            response_body_text: None,
            response_body_offloaded: false,
            response_body_size: 0,
            body_offloaded: false,
            body_size: 0,
            process_name: None,
            process_pid: None,
        };

        // 1. Request stage > 256 KiB -> offloaded, inline cleared, lazy load works, resolve cleans up
        let (_rx1, _) = engine.park_with_bodies(
            blank_item("bp-1", 10, BreakpointStage::Request),
            Some(&heavy_req),
            None,
        );
        // 2. Response stage > 256 KiB -> remove_expired cleans up
        let (_rx2, _) = engine.park_with_bodies(
            blank_item("bp-2", 11, BreakpointStage::Response),
            None,
            Some(&heavy_resp),
        );
        // 3. Cancel pending -> cleans up
        let (_rx3, _) = engine.park_with_bodies(
            blank_item("bp-3", 12, BreakpointStage::Request),
            Some(&heavy_req),
            None,
        );
        // 4. Cancel session -> cleans up
        let (_rx4, _) = engine.park_with_bodies(
            blank_item("bp-4", 13, BreakpointStage::Request),
            Some(&heavy_req),
            None,
        );
        // 5. Resume all -> cleans up
        let (_rx5, _) = engine.park_with_bodies(
            blank_item("bp-5", 14, BreakpointStage::Response),
            Some(&heavy_req),
            Some(&heavy_resp),
        );

        let paused = engine.list_paused();
        assert_eq!(paused.len(), 5);
        assert!(paused[0].request_body_offloaded);
        assert!(paused[0].body_offloaded);
        assert_eq!(paused[0].request_body_size, heavy_req.len());
        assert_eq!(paused[0].body_size, heavy_req.len());
        assert!(paused[0].request_body_base64.is_empty());
        assert!(paused[0].request_body_text.is_none());

        assert!(paused[1].response_body_offloaded);
        assert!(paused[1].body_offloaded);
        assert_eq!(paused[1].response_body_size, heavy_resp.len());

        let loaded1 = engine
            .load_paused_body("bp-1", false)
            .unwrap()
            .expect("lazy request body loaded");
        assert_eq!(loaded1.body_size, heavy_req.len());
        assert_eq!(loaded1.body_text.as_deref().unwrap().len(), heavy_req.len());

        let loaded2 = engine
            .load_paused_body("bp-2", true)
            .unwrap()
            .expect("lazy response body loaded");
        assert_eq!(loaded2.body_size, heavy_resp.len());

        assert!(engine.resolve(BreakpointResolution {
            breakpoint_id: "bp-1".into(),
            action: BreakpointAction::Continue,
            method: None,
            url: None,
            request_headers: None,
            request_body_base64: None,
            request_body_text: None,
            status_code: None,
            response_headers: None,
            response_body_base64: None,
            response_body_text: None,
        }));
        engine.remove_expired("bp-2");
        assert!(engine.cancel_pending("bp-3"));
        assert_eq!(engine.cancel_session(13), 1);
        assert_eq!(engine.resume_all(BreakpointAction::Abort), 1);

        store.flush_sqlite().unwrap();
        assert_eq!(
            store.load_breakpoint_offloaded_body(10, false).unwrap(),
            None
        );
        assert_eq!(
            store.load_breakpoint_offloaded_body(11, true).unwrap(),
            None
        );
        assert_eq!(
            store.load_breakpoint_offloaded_body(12, false).unwrap(),
            None
        );
        assert_eq!(
            store.load_breakpoint_offloaded_body(13, false).unwrap(),
            None
        );
        assert_eq!(
            store.load_breakpoint_offloaded_body(14, false).unwrap(),
            None
        );
        assert_eq!(
            store.load_breakpoint_offloaded_body(14, true).unwrap(),
            None
        );

        drop(engine);
        drop(store);
        cleanup(&db_path);
    }
}
