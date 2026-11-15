use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

use regex::Regex;

use crate::models::{AutoResponderRule, HeaderPair, RuleMatchTarget};

#[derive(Clone, Debug)]
struct CompiledAutoResponderRule {
    rule: AutoResponderRule,
    compiled_regex: Option<Regex>,
    pattern_lower: String,
    method_filter_trimmed: Option<String>,
    header_name_trimmed: Option<String>,
}

impl CompiledAutoResponderRule {
    fn compile(rule: AutoResponderRule) -> Self {
        let compiled_regex = if matches!(rule.match_target, RuleMatchTarget::UrlRegex) {
            match Regex::new(&rule.pattern) {
                Ok(re) => Some(re),
                Err(err) => {
                    tracing::warn!(
                        rule_id = %rule.id,
                        pattern = %rule.pattern,
                        "Invalid AutoResponder URL regex pattern: {err}"
                    );
                    None
                }
            }
        } else {
            None
        };
        let pattern_lower = rule.pattern.to_ascii_lowercase();
        let method_filter_trimmed = rule
            .method_filter
            .as_deref()
            .map(str::trim)
            .filter(|mf| !mf.is_empty() && !mf.eq_ignore_ascii_case("ANY"))
            .map(str::to_owned);
        let header_name_trimmed = rule
            .header_name
            .as_deref()
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .map(str::to_owned);

        Self {
            rule,
            compiled_regex,
            pattern_lower,
            method_filter_trimmed,
            header_name_trimmed,
        }
    }

    fn matches(&self, method: &str, url: &str, url_lower: &mut Option<String>, headers: &[HeaderPair]) -> bool {
        if !self.rule.enabled {
            return false;
        }
        if let Some(ref mf) = self.method_filter_trimmed {
            if !mf.eq_ignore_ascii_case(method) {
                return false;
            }
        }

        match self.rule.match_target {
            RuleMatchTarget::UrlContains => {
                let lowered = url_lower.get_or_insert_with(|| url.to_ascii_lowercase());
                lowered.contains(&self.pattern_lower)
            }
            RuleMatchTarget::UrlRegex => self
                .compiled_regex
                .as_ref()
                .is_some_and(|re| re.is_match(url)),
            RuleMatchTarget::HeaderMatch => {
                let target_header = self.header_name_trimmed.as_deref().unwrap_or("");
                headers.iter().any(|h| {
                    (target_header.is_empty() || h.name.eq_ignore_ascii_case(target_header))
                        && h.value.to_ascii_lowercase().contains(&self.pattern_lower)
                })
            }
        }
    }
}

/// Thread-safe rule evaluation engine for AutoResponder mocking, status overrides,
/// and artificial network latency injection.
pub struct RuleEngine {
    enabled: AtomicBool,
    rules: RwLock<Vec<CompiledAutoResponderRule>>,
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
            .map(|guard| guard.iter().map(|entry| entry.rule.clone()).collect())
            .unwrap_or_default()
    }

    pub fn set_rules(&self, updated: Vec<AutoResponderRule>) {
        let compiled: Vec<CompiledAutoResponderRule> = updated
            .into_iter()
            .map(CompiledAutoResponderRule::compile)
            .collect();
        if let Ok(mut guard) = self.rules.write() {
            *guard = compiled;
        }
    }

    pub fn upsert_rule(&self, rule: AutoResponderRule) {
        let compiled = CompiledAutoResponderRule::compile(rule);
        if let Ok(mut guard) = self.rules.write() {
            if let Some(existing) = guard.iter_mut().find(|r| r.rule.id == compiled.rule.id) {
                *existing = compiled;
            } else {
                guard.push(compiled);
            }
        }
    }

    pub fn delete_rule(&self, id: &str) {
        if let Ok(mut guard) = self.rules.write() {
            guard.retain(|r| r.rule.id != id);
        }
    }

    /// Evaluates active rules in priority order against an incoming HTTP request.
    /// Regex patterns and lowercase strings are precompiled in `set_rules`/`upsert_rule`,
    /// keeping this hot path free of regex compilation.
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
        let mut url_lower: Option<String> = None;
        for entry in guard.iter() {
            if entry.matches(method, url, &mut url_lower, headers) {
                return Some(entry.rule.clone());
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::RuleActionType;
    use std::time::Instant;

    fn make_rule(
        id: &str,
        match_target: RuleMatchTarget,
        pattern: &str,
        method_filter: Option<&str>,
        header_name: Option<&str>,
    ) -> AutoResponderRule {
        AutoResponderRule {
            id: id.to_string(),
            enabled: true,
            name: id.to_string(),
            match_target,
            pattern: pattern.to_string(),
            method_filter: method_filter.map(str::to_string),
            header_name: header_name.map(str::to_string),
            action: RuleActionType::MockResponse,
            status_code: 200,
            latency_ms: 0,
            response_headers: Vec::new(),
            response_body: "{}".to_string(),
        }
    }

    #[test]
    fn precompiles_url_regex_and_handles_invalid_patterns() {
        let engine = RuleEngine::new();
        let valid_regex = make_rule(
            "r-valid",
            RuleMatchTarget::UrlRegex,
            r"^https://api\.example\.com/v\d+/orders/\d+$",
            Some("POST"),
            None,
        );
        let invalid_regex = make_rule(
            "r-invalid",
            RuleMatchTarget::UrlRegex,
            r"^([unclosed",
            None,
            None,
        );
        let contains_rule = make_rule(
            "r-contains",
            RuleMatchTarget::UrlContains,
            "CHECKOUT",
            Some("ANY"),
            None,
        );
        let header_rule = make_rule(
            "r-header",
            RuleMatchTarget::HeaderMatch,
            "bearer secret",
            None,
            Some("Authorization"),
        );

        engine.set_rules(vec![
            invalid_regex,
            valid_regex,
            contains_rule,
            header_rule,
        ]);

        {
            let guard = engine.rules.read().unwrap();
            assert!(guard[0].compiled_regex.is_none());
            assert!(guard[1].compiled_regex.is_some());
            assert!(guard[2].compiled_regex.is_none());
            assert!(guard[3].compiled_regex.is_none());
        }

        let matched = engine.find_matching_rule(
            "POST",
            "https://api.example.com/v2/orders/42",
            &[],
        );
        assert_eq!(matched.as_ref().map(|r| r.id.as_str()), Some("r-valid"));

        assert!(engine
            .find_matching_rule("GET", "https://api.example.com/v2/orders/42", &[])
            .is_none());

        let contains_match = engine.find_matching_rule(
            "GET",
            "https://shop.example.com/checkout/session",
            &[],
        );
        assert_eq!(
            contains_match.as_ref().map(|r| r.id.as_str()),
            Some("r-contains")
        );

        let hdrs = vec![HeaderPair {
            name: "authorization".into(),
            value: "Bearer Secret-Token".into(),
        }];
        let header_match = engine.find_matching_rule("GET", "https://other.local/", &hdrs);
        assert_eq!(
            header_match.as_ref().map(|r| r.id.as_str()),
            Some("r-header")
        );
    }

    #[test]
    fn hot_path_precompiled_regex_matching_benchmark_smoke() {
        let engine = RuleEngine::new();
        let rules: Vec<AutoResponderRule> = (0..16)
            .map(|idx| {
                make_rule(
                    &format!("re-{idx}"),
                    RuleMatchTarget::UrlRegex,
                    &format!(r"^https://svc-{idx}\.internal\.local/api/v\d+/items/[a-f0-9]{{8,16}}$"),
                    None,
                    None,
                )
            })
            .collect();
        engine.set_rules(rules);

        let target_url = "https://svc-15.internal.local/api/v3/items/deadbeef1234";
        let started = Instant::now();
        let mut hits = 0usize;
        for _ in 0..5_000 {
            if engine
                .find_matching_rule("GET", target_url, &[])
                .is_some_and(|r| r.id == "re-15")
            {
                hits += 1;
            }
        }
        let elapsed = started.elapsed();
        assert_eq!(hits, 5_000);
        assert!(
            elapsed.as_secs_f64() < 5.0,
            "5k hot-path precompiled regex evaluations took unexpectedly long: {elapsed:?}"
        );
    }
}
