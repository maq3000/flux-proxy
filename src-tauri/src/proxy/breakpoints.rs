use std::sync::RwLock;

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

/// Live Breakpoint Engine (Fiddler Classic F11 / Alt+F11 / `bpu` / `bpafter` equivalent).
/// Parks intercepted HTTP/HTTPS requests & responses on `tokio::sync::oneshot::channel`
/// while waiting for interactive developer edits or abort verdicts from the UI.
pub struct BreakpointEngine {
    config: RwLock<BreakpointConfig>,
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
            config: RwLock::new(default_breakpoint_config()),
            pending: DashMap::new(),
            snapshot_tx,
        }
    }

    pub fn get_config(&self) -> BreakpointConfig {
        self.config
            .read()
            .map(|g| g.clone())
            .unwrap_or_else(|_| default_breakpoint_config())
    }

    pub fn update_config(&self, mut next: BreakpointConfig) -> BreakpointConfig {
        next.timeout_secs = next.timeout_secs.clamp(5, 600);
        if let Ok(mut guard) = self.config.write() {
            *guard = next.clone();
        }
        next
    }

    /// Evaluates whether an HTTP request (`BreakpointStage::Request`) or upstream response
    /// (`BreakpointStage::Response`) should pause at an interactive breakpoint.
    pub fn should_break(&self, stage: BreakpointStage, method: &str, url: &str) -> bool {
        let Ok(guard) = self.config.read() else {
            return false;
        };

        match stage {
            BreakpointStage::Request if guard.break_before_request => return true,
            BreakpointStage::Response if guard.break_after_response => return true,
            _ => {}
        }

        let url_lower = url.to_ascii_lowercase();
        for rule in &guard.rules {
            if !rule.enabled {
                continue;
            }
            let stage_matches = matches!(
                (rule.stage, stage),
                (BreakpointStage::Both, _)
                    | (BreakpointStage::Request, BreakpointStage::Request)
                    | (BreakpointStage::Response, BreakpointStage::Response)
            );
            if !stage_matches {
                continue;
            }
            if let Some(ref mf) = rule.method_filter {
                let mf_trimmed = mf.trim();
                if !mf_trimmed.is_empty()
                    && !mf_trimmed.eq_ignore_ascii_case("ANY")
                    && !mf_trimmed.eq_ignore_ascii_case(method)
                {
                    continue;
                }
            }
            if url_pattern_matches(&url_lower, url, &rule.url_pattern) {
                return true;
            }
        }

        false
    }

    /// Registers a paused request/response and returns a `(oneshot::Receiver, timeout_secs)` pair
    /// on which `handle_intercepted_request` awaits the developer's verdict.
    pub fn park(&self, mut item: PausedBreakpointItem) -> (oneshot::Receiver<BreakpointResolution>, u64) {
        let timeout_secs = self
            .config
            .read()
            .map(|g| g.timeout_secs.clamp(5, 600))
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

pub fn default_breakpoint_config() -> BreakpointConfig {
    BreakpointConfig {
        break_before_request: false,
        break_after_response: false,
        timeout_secs: 120,
        rules: Vec::new(),
    }
}

fn url_pattern_matches(url_lower: &str, raw_url: &str, pattern: &str) -> bool {
    let trimmed = pattern.trim();
    if trimmed.is_empty() || trimmed == "*" {
        return true;
    }
    if let Some(re_pat) = trimmed.strip_prefix("regex:") {
        return Regex::new(re_pat.trim())
            .map(|re| re.is_match(raw_url))
            .unwrap_or(false);
    }
    let pat_lower = trimmed.to_ascii_lowercase();
    if pat_lower.contains('*') {
        let mut regex_str = String::from("^(?i)");
        for ch in pat_lower.chars() {
            if ch == '*' {
                regex_str.push_str(".*");
            } else if ch == '?' {
                regex_str.push('.');
            } else {
                regex_str.push_str(&regex::escape(&ch.to_string()));
            }
        }
        regex_str.push('$');
        return Regex::new(&regex_str)
            .map(|re| re.is_match(raw_url))
            .unwrap_or(false);
    }
    url_lower.contains(&pat_lower)
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
}
