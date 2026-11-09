use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

use regex::Regex;

use crate::models::{AutoResponderRule, HeaderPair, RuleMatchTarget};

/// Thread-safe rule evaluation engine for AutoResponder mocking, status overrides,
/// and artificial network latency injection.
pub struct RuleEngine {
    enabled: AtomicBool,
    rules: RwLock<Vec<AutoResponderRule>>,
}

impl Default for RuleEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl RuleEngine {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(true),
            rules: RwLock::new(Vec::new()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn list_rules(&self) -> Vec<AutoResponderRule> {
        self.rules
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn set_rules(&self, updated: Vec<AutoResponderRule>) {
        if let Ok(mut guard) = self.rules.write() {
            *guard = updated;
        }
    }

    pub fn upsert_rule(&self, rule: AutoResponderRule) {
        if let Ok(mut guard) = self.rules.write() {
            if let Some(existing) = guard.iter_mut().find(|r| r.id == rule.id) {
                *existing = rule;
            } else {
                guard.push(rule);
            }
        }
    }

    pub fn delete_rule(&self, id: &str) {
        if let Ok(mut guard) = self.rules.write() {
            guard.retain(|r| r.id != id);
        }
    }

    /// Evaluates active rules in priority order against an incoming HTTP request.
    pub fn find_matching_rule(
        &self,
        method: &str,
        url: &str,
        headers: &[HeaderPair],
    ) -> Option<AutoResponderRule> {
        if !self.is_enabled() {
            return None;
        }
        let guard = self.rules.read().ok()?;
        for rule in guard.iter() {
            if !rule.enabled {
                continue;
            }

            if let Some(ref method_filter) = rule.method_filter {
                let mf = method_filter.trim();
                if !mf.is_empty() && !mf.eq_ignore_ascii_case("ANY") && !mf.eq_ignore_ascii_case(method) {
                    continue;
                }
            }

            let matched = match rule.match_target {
                RuleMatchTarget::UrlContains => {
                    url.to_ascii_lowercase().contains(&rule.pattern.to_ascii_lowercase())
                }
                RuleMatchTarget::UrlRegex => Regex::new(&rule.pattern)
                    .map(|re| re.is_match(url))
                    .unwrap_or(false),
                RuleMatchTarget::HeaderMatch => {
                    let target_header = rule.header_name.as_deref().unwrap_or("");
                    headers.iter().any(|h| {
                        (target_header.is_empty() || h.name.eq_ignore_ascii_case(target_header))
                            && h.value
                                .to_ascii_lowercase()
                                .contains(&rule.pattern.to_ascii_lowercase())
                    })
                }
            };

            if matched {
                return Some(rule.clone());
            }
        }
        None
    }
}
