use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use dashmap::DashMap;
use regex::Regex;
use tokio::sync::watch;

use crate::models::{
    CaptureFilterRule, HeaderMutationDirection, HeaderMutationOp, HeaderMutationRule, HeaderPair,
    HostListBackendSyncConfig, HostListFilterMode, NoiseThresholdsBackendConfig,
    ProxyFilterBackendConfig, SessionSummary, TlsBypassRule, TlsInterceptMode,
};


mod parsers;
#[cfg(test)]
mod tests;

pub(crate) use parsers::strip_regex_prefix;
pub use parsers::tokenize_host_list_input;
use parsers::{
    build_combined_regex, compile_backend_host_list, compile_capture_host_list,
    compile_capture_matrix, compile_glob_regex, compile_host_pattern_src, eval_capture_condition,
    eval_capture_dnf_groups, evaluate_compiled_host_list_connect, extract_clean_hostname,
    extract_session_port, is_background_os_noise, is_response_dependent_capture_field,
    matches_compiled_capture_host_list, normalize_clean_host, normalize_host_token,
    NormalizedHostPattern,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PassthroughReason {
    /// Matched an explicit rule in `tls_bypass_rules` (or synced Hosts List Blacklist) while in `InterceptAll` mode.
    BypassRule(TlsBypassRule),
    /// Mode is `TargetedOnly` and the host is not matched by `tls_target_rules` (or excluded via `!pattern`).
    NotInTargetAllowlist,
    /// Bulk Hosts List is in `Whitelist` mode with TLS Passthrough sync enabled, and host is outside the whitelist.
    NotInHostsWhitelist,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectTunnelDecision {
    /// Decrypt traffic via dynamic MITM TLS certificate generation.
    InterceptMitm,
    /// Relay encrypted bytes directly via `tokio::io::copy_bidirectional` with zero TLS handshake.
    Passthrough(PassthroughReason),
}

#[derive(Default)]
struct CompiledBackendHostList {
    enabled: bool,
    mode: HostListFilterMode,
    active_count: usize,
    matches_everything: bool,
    has_universal_host_rule: bool,
    whitelist_hosts: HashSet<String>,
    whitelist_host_ports: HashSet<String>,
    whitelist_wildcards: HashSet<String>,
    whitelist_glob_regex: Option<Regex>,
    blacklist_hosts: HashSet<String>,
    blacklist_host_ports: HashSet<String>,
    blacklist_wildcards: HashSet<String>,
    blacklist_glob_regex: Option<Regex>,
    user_regexes: Vec<Regex>,
}

#[derive(Default)]
struct CompiledCaptureHostList {
    enabled: bool,
    mode: HostListFilterMode,
    active_count: usize,
    matches_everything: bool,
    exact_hosts: HashSet<String>,
    exact_host_ports: HashSet<String>,
    exact_scheme_hosts: HashSet<String>,
    exact_scheme_host_ports: HashSet<String>,
    wildcard_domains: HashSet<String>,
    host_glob_regex: Option<Regex>,
    host_port_glob_regex: Option<Regex>,
    host_path_regex: Option<Regex>,
    full_url_regex: Option<Regex>,
    path_only_regex: Option<Regex>,
    user_regexes: Vec<Regex>,
}

struct CompiledCaptureCondition {
    rule: CaptureFilterRule,
    regex: Option<Regex>,
    numeric_target: Option<f64>,
    lower_value: String,
}

#[derive(Default)]
struct CompiledCaptureMatrix {
    include_groups: Vec<Vec<CompiledCaptureCondition>>,
    exclude_groups: Vec<Vec<CompiledCaptureCondition>>,
}

#[derive(Clone, Debug)]
enum CompiledHostMatcher {
    MatchAll,
    Exact(String),
    DomainSuffix(String),
    Glob(Option<Regex>),
    Regex(Option<Regex>),
}

impl CompiledHostMatcher {
    fn matches(&self, host_clean: &str, host_port: &str) -> bool {
        match self {
            Self::MatchAll => true,
            Self::Exact(expected) => host_clean == expected,
            Self::DomainSuffix(suffix) => {
                host_clean == suffix
                    || (host_clean.len() > suffix.len()
                        && host_clean.ends_with(suffix)
                        && host_clean.as_bytes()[host_clean.len() - suffix.len() - 1] == b'.')
            }
            Self::Glob(re_opt) => re_opt.as_ref().is_some_and(|re| re.is_match(host_clean)),
            Self::Regex(re_opt) => re_opt
                .as_ref()
                .is_some_and(|re| re.is_match(host_clean) || re.is_match(host_port)),
        }
    }

    #[cfg(test)]
    fn has_compiled_regex(&self) -> bool {
        matches!(self, Self::Glob(Some(_)) | Self::Regex(Some(_)))
    }
}

#[derive(Clone, Debug)]
enum CompiledPortMatcher {
    Any,
    Exact(u16),
    Glob(Option<Regex>),
    Never,
}

impl CompiledPortMatcher {
    fn compile(port_opt: Option<&str>) -> Self {
        let Some(raw_port) = port_opt else {
            return Self::Any;
        };
        if let Ok(port) = raw_port.parse::<u16>() {
            return Self::Exact(port);
        }
        if raw_port.contains('*') || raw_port.contains('?') {
            return Self::Glob(compile_glob_regex(raw_port));
        }
        Self::Never
    }

    fn matches(&self, port: u16) -> bool {
        match self {
            Self::Any => true,
            Self::Exact(expected) => port == *expected,
            Self::Glob(re_opt) => {
                let port_str = port.to_string();
                re_opt.as_ref().is_some_and(|re| re.is_match(&port_str))
            }
            Self::Never => false,
        }
    }
}

#[derive(Clone, Debug)]
struct CompiledHostToken {
    host: CompiledHostMatcher,
    port: CompiledPortMatcher,
}

impl CompiledHostToken {
    fn compile(pattern: &NormalizedHostPattern) -> Self {
        match pattern {
            NormalizedHostPattern::Regex(expr) => {
                let compiled = Regex::new(&format!("(?i){expr}")).ok();
                Self {
                    host: CompiledHostMatcher::Regex(compiled),
                    port: CompiledPortMatcher::Any,
                }
            }
            NormalizedHostPattern::HostPort { host, port } => {
                let port_matcher = CompiledPortMatcher::compile(port.as_deref());
                let host_matcher = if host == "*" {
                    CompiledHostMatcher::MatchAll
                } else if let Some(rest) = host.strip_prefix("*.") {
                    if !rest.is_empty() && !rest.contains('*') && !rest.contains('?') {
                        CompiledHostMatcher::DomainSuffix(rest.to_string())
                    } else {
                        CompiledHostMatcher::Glob(build_combined_regex(&[compile_host_pattern_src(
                            host,
                        )]))
                    }
                } else if let Some(rest) = host.strip_prefix('.') {
                    if !rest.is_empty() && !rest.contains('*') && !rest.contains('?') {
                        CompiledHostMatcher::DomainSuffix(rest.to_string())
                    } else {
                        CompiledHostMatcher::Glob(build_combined_regex(&[compile_host_pattern_src(
                            host,
                        )]))
                    }
                } else if host.contains('*') || host.contains('?') {
                    CompiledHostMatcher::Glob(compile_glob_regex(host))
                } else {
                    CompiledHostMatcher::Exact(host.clone())
                };
                Self {
                    host: host_matcher,
                    port: port_matcher,
                }
            }
        }
    }

    fn matches(&self, host_clean: &str, port: u16, host_port: &str) -> bool {
        self.port.matches(port) && self.host.matches(host_clean, host_port)
    }
}

#[derive(Clone, Debug)]
struct CompiledHostRule {
    rule: TlsBypassRule,
    positive_tokens: Vec<CompiledHostToken>,
}

#[derive(Default)]
struct CompiledHostRuleList {
    has_active_rules: bool,
    negative_tokens: Vec<CompiledHostToken>,
    positive_rules: Vec<CompiledHostRule>,
}

impl CompiledHostRuleList {
    fn compile(rules: &[TlsBypassRule]) -> Self {
        let mut out = Self::default();
        for rule in rules {
            if !rule.enabled {
                continue;
            }
            if !rule.pattern.trim().is_empty() {
                out.has_active_rules = true;
            }
            let mut positive_tokens = Vec::new();
            for raw_token in rule.pattern.split(',') {
                if let Some(norm) = normalize_host_token(raw_token) {
                    let compiled = CompiledHostToken::compile(&norm.pattern);
                    if norm.negated {
                        out.negative_tokens.push(compiled);
                    } else {
                        positive_tokens.push(compiled);
                    }
                }
            }
            if !positive_tokens.is_empty() {
                out.positive_rules.push(CompiledHostRule {
                    rule: rule.clone(),
                    positive_tokens,
                });
            }
        }
        out
    }

    fn matches(&self, host_clean: &str, port: u16) -> Option<&TlsBypassRule> {
        if self.negative_tokens.is_empty() && self.positive_rules.is_empty() {
            return None;
        }
        let host_port = if host_clean.contains(':') {
            format!("[{host_clean}]:{port}")
        } else {
            format!("{host_clean}:{port}")
        };
        for neg in &self.negative_tokens {
            if neg.matches(host_clean, port, &host_port) {
                return None;
            }
        }
        for entry in &self.positive_rules {
            if entry
                .positive_tokens
                .iter()
                .any(|tok| tok.matches(host_clean, port, &host_port))
            {
                return Some(&entry.rule);
            }
        }
        None
    }
}

#[derive(Clone, Debug)]
enum CompiledUrlScope {
    MatchAll,
    Substring(String),
    Glob(Option<Regex>),
    Regex(Option<Regex>),
}

impl CompiledUrlScope {
    fn compile(pattern: &str) -> Self {
        let trimmed = pattern.trim();
        if trimmed.is_empty() || trimmed == "*" {
            return Self::MatchAll;
        }
        if let Some(re_pat) = strip_regex_prefix(trimmed) {
            return Self::Regex(Regex::new(re_pat.trim()).ok());
        }
        let pat_lower = trimmed.to_ascii_lowercase();
        if pat_lower.contains('*') {
            return Self::Glob(compile_glob_regex(&pat_lower));
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
            Self::Glob(re_opt) => re_opt.as_ref().is_some_and(|re| {
                let lowered = url_lower.get_or_insert_with(|| raw_url.to_ascii_lowercase());
                re.is_match(lowered)
            }),
            Self::Regex(re_opt) => re_opt.as_ref().is_some_and(|re| re.is_match(raw_url)),
        }
    }

    #[cfg(test)]
    fn has_compiled_regex(&self) -> bool {
        matches!(self, Self::Glob(Some(_)) | Self::Regex(Some(_)))
    }
}

#[derive(Clone, Debug)]
enum CompiledHeaderMutationOp {
    Remove(Vec<String>),
    Set { name: String, value: String },
    Append { name: String, value: String },
}

#[derive(Clone, Debug)]
struct CompiledHeaderMutationRule {
    direction: HeaderMutationDirection,
    url_scope: CompiledUrlScope,
    op: CompiledHeaderMutationOp,
}

impl CompiledHeaderMutationRule {
    fn compile(rule: &HeaderMutationRule) -> Option<Self> {
        if !rule.enabled {
            return None;
        }
        let op = match rule.operation {
            HeaderMutationOp::Remove => {
                let targets: Vec<String> = rule
                    .header_name
                    .split(',')
                    .map(|s| s.trim().to_ascii_lowercase())
                    .filter(|s| !s.is_empty())
                    .collect();
                if targets.is_empty() {
                    return None;
                }
                CompiledHeaderMutationOp::Remove(targets)
            }
            HeaderMutationOp::Set => {
                let name = rule.header_name.trim();
                if name.is_empty() {
                    return None;
                }
                CompiledHeaderMutationOp::Set {
                    name: name.to_string(),
                    value: rule.header_value.clone(),
                }
            }
            HeaderMutationOp::Append => {
                let name = rule.header_name.trim();
                if name.is_empty() {
                    return None;
                }
                CompiledHeaderMutationOp::Append {
                    name: name.to_string(),
                    value: rule.header_value.clone(),
                }
            }
        };
        Some(Self {
            direction: rule.direction,
            url_scope: CompiledUrlScope::compile(&rule.url_pattern),
            op,
        })
    }
}

struct FilterEngineState {
    config: ProxyFilterBackendConfig,
    compiled_tls_bypass_rules: CompiledHostRuleList,
    compiled_tls_target_rules: CompiledHostRuleList,
    compiled_header_mutations: Vec<CompiledHeaderMutationRule>,
    compiled_host_list: CompiledBackendHostList,
    compiled_capture_host_list: CompiledCaptureHostList,
    compiled_capture_matrix: CompiledCaptureMatrix,
    compiled_query_regex: Option<Regex>,
    static_asset_ext_re: Regex,
}

/// Real-time proxy filter subsystem handling:
/// 1. SSL/TLS Selective MITM Pass-Through (`InterceptAll` with Bypass list, `TargetedOnly` Allowlist, and synced Bulk Hosts List via `copy_bidirectional`)
/// 2. Lightweight Request & Response Header Mutations (e.g. cache-bypass ETag/If-Modified-Since stripping, User-Agent spoofing)
/// 3. Capture-stage streaming session filter (`drop_non_matching_on_capture`) preventing unwanted/noisy sessions from entering RAM or IPC
pub struct ProxyFilterEngine {
    state: RwLock<FilterEngineState>,
    config_version_tx: watch::Sender<u64>,
    hit_counts: DashMap<String, AtomicU64>,
}

impl Default for ProxyFilterEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl ProxyFilterEngine {
    pub fn new() -> Self {
        let initial_cfg = default_backend_config();
        let (config_version_tx, _) = watch::channel(0u64);
        Self {
            state: RwLock::new(build_filter_engine_state(initial_cfg)),
            config_version_tx,
            hit_counts: DashMap::new(),
        }
    }

    fn record_rule_hit(&self, rule_id: &str) {
        if let Some(counter) = self.hit_counts.get(rule_id) {
            counter.fetch_add(1, Ordering::Relaxed);
            return;
        }
        self.hit_counts
            .entry(rule_id.to_string())
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn get_tls_rule_hit_counts(&self) -> HashMap<String, u64> {
        self.hit_counts
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().load(Ordering::Relaxed)))
            .collect()
    }

    pub fn reset_tls_bypass_rules_to_recommended(&self) -> ProxyFilterBackendConfig {
        let mut cfg = self.get_config();
        cfg.tls_bypass_enabled = true;
        cfg.tls_bypass_rules = default_tls_bypass_rules();
        self.update_config(cfg)
    }

    pub fn subscribe_config_updates(&self) -> watch::Receiver<u64> {
        self.config_version_tx.subscribe()
    }

    pub fn get_config(&self) -> ProxyFilterBackendConfig {
        self.state
            .read()
            .map(|g| g.config.clone())
            .unwrap_or_else(|_| default_backend_config())
    }

    pub fn update_config(&self, next: ProxyFilterBackendConfig) -> ProxyFilterBackendConfig {
        let next_state = build_filter_engine_state(next.clone());
        if let Ok(mut guard) = self.state.write() {
            *guard = next_state;
        }
        self.config_version_tx.send_modify(|v| *v = v.wrapping_add(1));
        next
    }

    pub fn set_drop_non_matching(&self, enabled: bool) {
        if let Ok(mut guard) = self.state.write() {
            guard.config.drop_non_matching_on_capture = enabled;
        }
    }

    pub fn is_drop_non_matching_enabled(&self) -> bool {
        self.state
            .read()
            .map(|g| g.config.drop_non_matching_on_capture)
            .unwrap_or(false)
    }

    /// Fast lock-minimal predicate invoked on request completion in `server.rs` when deciding
    /// whether to store a session in `TrafficStore` and emit it over IPC (`proxy://sessions-batch`).
    pub fn evaluate_should_store_session(&self, summary: &SessionSummary) -> bool {
        let Ok(guard) = self.state.read() else {
            return true;
        };

        if !guard.config.drop_non_matching_on_capture {
            return true;
        }

        let host_clean = extract_clean_hostname(&summary.host);
        if matches!(
            host_clean.as_str(),
            "flux.proxy" | "cert.flux.proxy" | "fluxproxy.local"
        ) {
            return true;
        }

        let is_in_flight = summary.status == 0 && summary.error.is_none() && !summary.tls_bypassed;

        // 1. Noise Thresholds
        let th = &guard.config.noise_thresholds;
        if !is_in_flight && th.hide_304_not_modified && summary.status == 304 {
            return false;
        }
        if th.hide_options_preflight && summary.method.eq_ignore_ascii_case("OPTIONS") {
            return false;
        }
        if th.hide_connect_tunnels
            && (summary.method.eq_ignore_ascii_case("CONNECT") || summary.tls_bypassed)
        {
            return false;
        }
        if !is_in_flight {
            if let Some(min_b) = th.min_body_size_bytes {
                if summary.body_size < min_b {
                    return false;
                }
            }
            if let Some(max_b) = th.max_body_size_bytes {
                if summary.body_size > max_b {
                    return false;
                }
            }
            if th.only_slow_requests && summary.duration_ms < th.time_heat_warning_ms {
                return false;
            }
        }
        if th.hide_static_assets {
            let ct = summary.content_type.to_ascii_lowercase();
            let ct_is_static = !is_in_flight
                && (ct.starts_with("image/")
                    || ct.starts_with("font/")
                    || ct.contains("text/css"));
            if ct_is_static || guard.static_asset_ext_re.is_match(&summary.path) {
                return false;
            }
        }

        // 2. Synced Capture Bulk Hosts & URL List (or fallback to `host_list_sync` if `capture_host_list` wasn't populated)
        let active_capture_hl = if guard.compiled_capture_host_list.enabled
            && guard.compiled_capture_host_list.active_count > 0
        {
            Some(&guard.compiled_capture_host_list)
        } else {
            None
        };

        let mut explicitly_whitelisted = false;
        if let Some(hl) = active_capture_hl {
            let matched = matches_compiled_capture_host_list(summary, &host_clean, hl);
            match hl.mode {
                HostListFilterMode::Whitelist => {
                    if !matched {
                        return false;
                    }
                    explicitly_whitelisted = true;
                }
                HostListFilterMode::Blacklist => {
                    if matched {
                        return false;
                    }
                }
            }
        } else if guard.compiled_host_list.enabled && guard.compiled_host_list.active_count > 0 {
            let port = extract_session_port(summary);
            if let Some(ConnectTunnelDecision::Passthrough(_)) =
                evaluate_compiled_host_list_connect(&guard.compiled_host_list, &host_clean, port)
            {
                return false;
            }
            if guard.compiled_host_list.mode == HostListFilterMode::Whitelist {
                explicitly_whitelisted = true;
            }
        }

        // 3. Toolbar Quick Category & Text/RegExp Search Query (when active)
        if let Some(ref cat) = guard.config.quick_category {
            let cat_str = cat.trim();
            if !cat_str.is_empty() && !cat_str.eq_ignore_ascii_case("all") {
                let ct = summary.content_type.to_ascii_lowercase();
                let is_ws = summary.status == 101
                    || summary.scheme.eq_ignore_ascii_case("ws")
                    || summary.scheme.eq_ignore_ascii_case("wss")
                    || summary.protocol.contains("WS")
                    || ct.contains("websocket");
                let is_err = summary.status >= 400 || summary.error.is_some();
                let cat_ok = match cat_str {
                    "json" => {
                        if is_in_flight {
                            true
                        } else {
                            !is_err
                                && !is_ws
                                && !ct.contains("text/event-stream")
                                && !ct.starts_with("image/")
                                && (ct.contains("json")
                                    || ct.contains("graphql")
                                    || ct.contains("grpc")
                                    || ct.contains("protobuf")
                                    || summary.path.starts_with("/api/")
                                    || summary.path.starts_with("/v1/"))
                        }
                    }
                    "images" => is_in_flight || (!is_err && !is_ws && ct.starts_with("image/")),
                    "sse" => is_in_flight || (!is_err && !is_ws && ct.contains("text/event-stream")),
                    "xhr" => {
                        is_in_flight
                            || ct.contains("json")
                            || ct.contains("xml")
                            || ct.contains("graphql")
                            || ct.contains("grpc")
                            || ct.contains("protobuf")
                            || ct.contains("event-stream")
                    }
                    "ws" => !is_err && is_ws,
                    "errors" => is_in_flight || is_err,
                    "mocked" => is_in_flight || summary.is_mocked || summary.breakpoint_modified,
                    "marked" => summary.comment.is_some() || summary.marked_color.is_some(),
                    _ => true,
                };
                if !cat_ok {
                    return false;
                }
            }
        }

        if let Some(ref raw_q) = guard.config.filter_query {
            let q = raw_q.trim();
            if !q.is_empty() {
                let haystack = format!(
                    "{} {} {} {} {} {} {}",
                    summary.url,
                    summary.method,
                    summary.status,
                    summary.content_type,
                    summary.process_name.as_deref().unwrap_or(""),
                    summary.client_ip.as_deref().unwrap_or(""),
                    summary.comment.as_deref().unwrap_or("")
                );
                if guard.config.use_regex_query.unwrap_or(false) {
                    if let Some(ref re) = guard.compiled_query_regex {
                        if !re.is_match(&haystack) {
                            return false;
                        }
                    }
                } else if !haystack.to_lowercase().contains(&q.to_lowercase()) {
                    return false;
                }
            }
        }

        // 4. Filter Rules Matrix (Include / Exclude with AND / OR DNF grouping)
        let mut explicitly_included = false;
        if guard.config.capture_matrix_enabled {
            if !guard.compiled_capture_matrix.exclude_groups.is_empty()
                && eval_capture_dnf_groups(
                    summary,
                    &guard.compiled_capture_matrix.exclude_groups,
                    is_in_flight,
                    true,
                )
            {
                return false;
            }
            if !guard.compiled_capture_matrix.include_groups.is_empty() {
                if !eval_capture_dnf_groups(
                    summary,
                    &guard.compiled_capture_matrix.include_groups,
                    is_in_flight,
                    false,
                ) {
                    return false;
                }
                explicitly_included = !is_in_flight
                    || guard.compiled_capture_matrix.include_groups.iter().any(|conj| {
                        conj.iter().all(|c| eval_capture_condition(summary, c, is_in_flight, false))
                            && conj
                                .iter()
                                .any(|c| !is_response_dependent_capture_field(&c.rule.field))
                    });
            }
        }

        // 5. Built-in OS Background Noise Guard (`svchost`, Windows/macOS telemetry & connectivity probes)
        // Dropped automatically when `Drop Non-Matching` is active unless explicitly whitelisted/included.
        explicitly_whitelisted
            || explicitly_included
            || !is_background_os_noise(summary, &host_clean)
    }

    /// Evaluates how an incoming `CONNECT host:port` tunnel should be handled according to
    /// the synced Bulk Hosts List (if enabled) and the active `TlsInterceptMode` (`InterceptAll` vs `TargetedOnly`).
    pub fn evaluate_connect_tunnel(&self, host: &str, port: u16) -> ConnectTunnelDecision {
        let host_lower = normalize_clean_host(host);
        if matches!(
            host_lower.as_str(),
            "flux.proxy" | "cert.flux.proxy" | "fluxproxy.local"
        ) {
            return ConnectTunnelDecision::InterceptMitm;
        }

        let Ok(guard) = self.state.read() else {
            return ConnectTunnelDecision::InterceptMitm;
        };

        if let Some(host_list_decision) =
            evaluate_compiled_host_list_connect(&guard.compiled_host_list, &host_lower, port)
        {
            return match host_list_decision {
                ConnectTunnelDecision::Passthrough(reason) => {
                    if let PassthroughReason::BypassRule(ref rule) = reason {
                        self.record_rule_hit(&rule.id);
                    }
                    ConnectTunnelDecision::Passthrough(reason)
                }
                ConnectTunnelDecision::InterceptMitm => {
                    if guard.config.tls_bypass_enabled {
                        if let Some(rule) = guard
                            .compiled_tls_bypass_rules
                            .matches(&host_lower, port)
                            .cloned()
                        {
                            self.record_rule_hit(&rule.id);
                            return ConnectTunnelDecision::Passthrough(
                                PassthroughReason::BypassRule(rule),
                            );
                        }
                    }
                    if guard.config.tls_intercept_mode == TlsInterceptMode::TargetedOnly
                        && guard.compiled_tls_target_rules.has_active_rules
                    {
                        if let Some(rule) = guard
                            .compiled_tls_target_rules
                            .matches(&host_lower, port)
                            .cloned()
                        {
                            self.record_rule_hit(&rule.id);
                            return ConnectTunnelDecision::InterceptMitm;
                        }
                        return ConnectTunnelDecision::Passthrough(
                            PassthroughReason::NotInTargetAllowlist,
                        );
                    }
                    ConnectTunnelDecision::InterceptMitm
                }
            };
        }

        match guard.config.tls_intercept_mode {
            TlsInterceptMode::InterceptAll => {
                if !guard.config.tls_bypass_enabled {
                    return ConnectTunnelDecision::InterceptMitm;
                }
                if let Some(rule) = guard
                    .compiled_tls_bypass_rules
                    .matches(&host_lower, port)
                    .cloned()
                {
                    self.record_rule_hit(&rule.id);
                    ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(rule))
                } else {
                    ConnectTunnelDecision::InterceptMitm
                }
            }
            TlsInterceptMode::TargetedOnly => {
                if let Some(rule) = guard
                    .compiled_tls_target_rules
                    .matches(&host_lower, port)
                    .cloned()
                {
                    self.record_rule_hit(&rule.id);
                    ConnectTunnelDecision::InterceptMitm
                } else {
                    ConnectTunnelDecision::Passthrough(PassthroughReason::NotInTargetAllowlist)
                }
            }
        }
    }

    /// Returns `true` when `TlsInterceptMode::TargetedOnly` (allowlist-only MITM) is active.
    pub fn is_targeted_only_mode(&self) -> bool {
        self.state
            .read()
            .map(|g| g.config.tls_intercept_mode == TlsInterceptMode::TargetedOnly)
            .unwrap_or(false)
    }

    /// Evaluates whether TLS MITM interception is permitted for `host_or_authority`
    /// (`host`, `host:port`, `[ipv6]`, or `[ipv6]:port`), defaulting port to `443`.
    pub fn should_intercept_tls(&self, host_or_authority: &str) -> bool {
        let trimmed = host_or_authority.trim();
        let (raw_host, port) = if let Ok(sock) = trimmed.parse::<std::net::SocketAddr>() {
            (sock.ip().to_string(), sock.port())
        } else if let Some(rest) = trimmed.strip_prefix('[') {
            if let Some((ipv6, tail)) = rest.split_once(']') {
                let port = tail
                    .strip_prefix(':')
                    .and_then(|p| p.parse::<u16>().ok())
                    .unwrap_or(443);
                (ipv6.to_string(), port)
            } else {
                (trimmed.to_string(), 443)
            }
        } else if trimmed.parse::<std::net::IpAddr>().is_ok() {
            (trimmed.to_string(), 443)
        } else if let Some((h, p)) = trimmed.rsplit_once(':') {
            if !h.contains(':') {
                if let Ok(port) = p.parse::<u16>() {
                    (h.to_string(), port)
                } else {
                    (trimmed.to_string(), 443)
                }
            } else {
                (trimmed.to_string(), 443)
            }
        } else {
            (trimmed.to_string(), 443)
        };
        let clean_host = normalize_clean_host(&raw_host);
        matches!(
            self.evaluate_connect_tunnel(&clean_host, port),
            ConnectTunnelDecision::InterceptMitm
        )
    }

    /// Checks whether a `CONNECT host:port` tunnel matches an explicit rule in `tls_bypass_rules`.
    pub fn match_tls_bypass(&self, host: &str, port: u16) -> Option<TlsBypassRule> {
        let guard = self.state.read().ok()?;
        if !guard.config.tls_bypass_enabled {
            return None;
        }
        let host_clean = normalize_clean_host(host);
        guard
            .compiled_tls_bypass_rules
            .matches(&host_clean, port)
            .cloned()
    }

    /// Returns whether automatic `Alt-Svc` / `Alternate-Protocol` response header stripping is active.
    pub fn is_strip_alt_svc_enabled(&self) -> bool {
        self.state
            .read()
            .map(|g| g.config.strip_alt_svc)
            .unwrap_or(true)
    }

    /// Removes `Alt-Svc` and `Alternate-Protocol` headers in-place when `strip_alt_svc` is enabled,
    /// preventing browsers from upgrading connections to HTTP/3 (QUIC / UDP 443) and bypassing the proxy.
    pub fn strip_alt_svc_headers(&self, headers: &mut Vec<HeaderPair>) -> bool {
        if !self.is_strip_alt_svc_enabled() {
            return false;
        }
        strip_alt_svc_vec(headers)
    }

    /// Applies lightweight header mutations (`Remove`, `Set`, `Append`) in-place, plus automatic
    /// `Alt-Svc` / `Alternate-Protocol` stripping on responses when `strip_alt_svc` is enabled.
    /// Returns `true` if at least one header was modified, added, or stripped.
    pub fn apply_header_mutations(
        &self,
        direction: HeaderMutationDirection,
        url: &str,
        headers: &mut Vec<HeaderPair>,
    ) -> bool {
        let Ok(guard) = self.state.read() else {
            return false;
        };

        let mut mutated = false;
        if direction == HeaderMutationDirection::Response
            && guard.config.strip_alt_svc
            && strip_alt_svc_vec(headers)
        {
            mutated = true;
        }

        if !guard.config.header_mutations_enabled {
            return mutated;
        }

        let mut url_lower: Option<String> = None;

        for rule in &guard.compiled_header_mutations {
            if rule.direction != direction {
                continue;
            }
            if !rule.url_scope.matches(&mut url_lower, url) {
                continue;
            }

            match &rule.op {
                CompiledHeaderMutationOp::Remove(targets) => {
                    let before = headers.len();
                    headers.retain(|h| {
                        let name_lower = h.name.trim().to_ascii_lowercase();
                        !targets.iter().any(|t| t == &name_lower)
                    });
                    if headers.len() != before {
                        mutated = true;
                    }
                }
                CompiledHeaderMutationOp::Set { name, value } => {
                    headers.retain(|h| !h.name.trim().eq_ignore_ascii_case(name));
                    headers.push(HeaderPair {
                        name: name.clone(),
                        value: value.clone(),
                    });
                    mutated = true;
                }
                CompiledHeaderMutationOp::Append { name, value } => {
                    headers.push(HeaderPair {
                        name: name.clone(),
                        value: value.clone(),
                    });
                    mutated = true;
                }
            }
        }

        if direction == HeaderMutationDirection::Response
            && guard.config.strip_alt_svc
            && strip_alt_svc_vec(headers)
        {
            mutated = true;
        }

        mutated
    }
}

/// Returns `true` if `name` is an HTTP/3 / QUIC discovery header (`alt-svc` or `alternate-protocol`),
/// matched case-insensitively.
pub fn is_alt_svc_header(name: &str) -> bool {
    let trimmed = name.trim();
    trimmed.eq_ignore_ascii_case("alt-svc") || trimmed.eq_ignore_ascii_case("alternate-protocol")
}

fn strip_alt_svc_vec(headers: &mut Vec<HeaderPair>) -> bool {
    let before = headers.len();
    headers.retain(|h| !is_alt_svc_header(&h.name));
    headers.len() != before
}

/// Evaluates a list of `TlsBypassRule` items against `(host, port)`.
/// Supports comma-separated tokens, wildcard domains (`*.example.com`, `.example.com`),
/// IPv6 literals (`[::1]`, `[::1]:8443`), glob `*`/`?`, `regex:`, optional `:port`, and `!pattern` negative carve-out exclusions.
/// Negative `!` tokens across all enabled rules take priority over positive matches.
pub fn match_host_rule_list(rules: &[TlsBypassRule], host: &str, port: u16) -> Option<TlsBypassRule> {
    let host_clean = normalize_clean_host(host);
    CompiledHostRuleList::compile(rules)
        .matches(&host_clean, port)
        .cloned()
}


pub fn default_tls_bypass_rules() -> Vec<TlsBypassRule> {
    vec![
        TlsBypassRule {
            id: "bypass-pki-ocsp-crl".into(),
            enabled: true,
            pattern: "ocsp.*, crl.*, *.digicert.com, *.sectigo.com, *.letsencrypt.org, ocsp.apple.com, *.globalsign.com, *.identrust.com".into(),
            category: "OCSP / CRL PKI".into(),
            description: "OCSP / CRL серверы проверки отзыва сертификатов X.509".into(),
        },
        TlsBypassRule {
            id: "bypass-apple-icloud".into(),
            enabled: true,
            pattern: "*.apple.com, *.icloud.com, *.mzstatic.com, *.cdn-apple.com, *.push.apple.com".into(),
            category: "OS Updaters".into(),
            description: "Apple / iCloud / App Store / APNs strict Certificate Pinning".into(),
        },
        TlsBypassRule {
            id: "bypass-windows-update".into(),
            enabled: true,
            pattern: "*.windowsupdate.com, *.delivery.mp.microsoft.com, *.update.microsoft.com, *.msftconnecttest.com, *.sfx.ms".into(),
            category: "OS Updaters".into(),
            description: "Windows Update, Delivery Optimization & NCSI pinned TLS".into(),
        },
        TlsBypassRule {
            id: "bypass-messengers".into(),
            enabled: true,
            pattern: "*.telegram.org, *.t.me, *.whatsapp.net, *.whatsapp.com, *.signal.org, *.viber.com".into(),
            category: "Messengers".into(),
            description: "E2EE Messengers with hardcoded public key pinning".into(),
        },
        TlsBypassRule {
            id: "bypass-payments-3ds".into(),
            enabled: true,
            pattern: "*.stripe.network, *.3dsecure.io, *.braintreegateway.com".into(),
            category: "Payment Gateways".into(),
            description: "PCI-DSS / 3DSecure payment frames with strict TLS pinning".into(),
        },
    ]
}

pub fn default_backend_config() -> ProxyFilterBackendConfig {
    ProxyFilterBackendConfig {
        tls_intercept_mode: TlsInterceptMode::InterceptAll,
        tls_bypass_enabled: true,
        tls_bypass_rules: default_tls_bypass_rules(),
        tls_target_rules: Vec::new(),
        header_mutations_enabled: true,
        header_mutations: vec![
            HeaderMutationRule {
                id: "hm-nocache-req".into(),
                enabled: false,
                name: "Bypass Cache: Strip If-Modified-Since / If-None-Match".into(),
                direction: HeaderMutationDirection::Request,
                operation: HeaderMutationOp::Remove,
                header_name: "If-Modified-Since, If-None-Match".into(),
                header_value: String::new(),
                url_pattern: "*".into(),
            },
            HeaderMutationRule {
                id: "hm-nocache-resp".into(),
                enabled: false,
                name: "Bypass Cache: Strip Response ETag / Last-Modified".into(),
                direction: HeaderMutationDirection::Response,
                operation: HeaderMutationOp::Remove,
                header_name: "ETag, Last-Modified".into(),
                header_value: String::new(),
                url_pattern: "*".into(),
            },
            HeaderMutationRule {
                id: "hm-ua-override".into(),
                enabled: false,
                name: "Spoof User-Agent (iPhone 16 Pro Mobile Safari)".into(),
                direction: HeaderMutationDirection::Request,
                operation: HeaderMutationOp::Set,
                header_name: "User-Agent".into(),
                header_value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1".into(),
                url_pattern: "*".into(),
            },
            HeaderMutationRule {
                id: "hm-cors-permissive".into(),
                enabled: false,
                name: "Inject Permissive CORS (Access-Control-Allow-Origin: *)".into(),
                direction: HeaderMutationDirection::Response,
                operation: HeaderMutationOp::Set,
                header_name: "Access-Control-Allow-Origin".into(),
                header_value: "*".into(),
                url_pattern: "*".into(),
            },
        ],
        strip_alt_svc: true,
        host_list_sync: HostListBackendSyncConfig::default(),
        drop_non_matching_on_capture: false,
        capture_host_list: HostListBackendSyncConfig::default(),
        noise_thresholds: NoiseThresholdsBackendConfig {
            hide_304_not_modified: false,
            hide_options_preflight: false,
            hide_connect_tunnels: false,
            hide_static_assets: false,
            min_body_size_bytes: None,
            max_body_size_bytes: None,
            time_heat_warning_ms: 500,
            only_slow_requests: false,
        },
        capture_matrix_enabled: false,
        capture_filter_rules: Vec::new(),
        quick_category: None,
        filter_query: None,
        use_regex_query: None,
    }
}

fn build_filter_engine_state(config: ProxyFilterBackendConfig) -> FilterEngineState {
    let compiled_tls_bypass_rules = CompiledHostRuleList::compile(&config.tls_bypass_rules);
    let compiled_tls_target_rules = CompiledHostRuleList::compile(&config.tls_target_rules);
    let compiled_header_mutations = config
        .header_mutations
        .iter()
        .filter_map(CompiledHeaderMutationRule::compile)
        .collect();
    let compiled_host_list = compile_backend_host_list(&config.host_list_sync);
    let compiled_capture_host_list = compile_capture_host_list(&config.capture_host_list);
    let compiled_capture_matrix = compile_capture_matrix(&config.capture_filter_rules);
    let compiled_query_regex = if config.use_regex_query.unwrap_or(false) {
        config
            .filter_query
            .as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .and_then(|q| Regex::new(&format!("(?i){q}")).ok())
    } else {
        None
    };
    let static_asset_ext_re =
        Regex::new(r"(?i)\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|css|map)(\?|$)").unwrap();

    FilterEngineState {
        config,
        compiled_tls_bypass_rules,
        compiled_tls_target_rules,
        compiled_header_mutations,
        compiled_host_list,
        compiled_capture_host_list,
        compiled_capture_matrix,
        compiled_query_regex,
        static_asset_ext_re,
    }
}

