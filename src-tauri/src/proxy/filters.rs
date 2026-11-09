use std::collections::HashSet;
use std::sync::RwLock;

use regex::Regex;

use crate::models::{
    CaptureFilterRule, HeaderMutationDirection, HeaderMutationOp, HeaderMutationRule, HeaderPair,
    HostListBackendSyncConfig, HostListFilterMode, NoiseThresholdsBackendConfig,
    ProxyFilterBackendConfig, SessionSummary, TlsBypassRule, TlsInterceptMode,
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

struct FilterEngineState {
    config: ProxyFilterBackendConfig,
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
}

impl Default for ProxyFilterEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl ProxyFilterEngine {
    pub fn new() -> Self {
        let initial_cfg = default_backend_config();
        Self {
            state: RwLock::new(build_filter_engine_state(initial_cfg)),
        }
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

        // 1. Noise Thresholds
        let th = &guard.config.noise_thresholds;
        if th.hide_304_not_modified && summary.status == 304 {
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
        if th.hide_static_assets {
            let ct = summary.content_type.to_ascii_lowercase();
            if ct.starts_with("image/")
                || ct.starts_with("font/")
                || ct.contains("text/css")
                || guard.static_asset_ext_re.is_match(&summary.path)
            {
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
                    "images" => !is_err && !is_ws && ct.starts_with("image/"),
                    "sse" => !is_err && !is_ws && ct.contains("text/event-stream"),
                    "xhr" => {
                        ct.contains("json")
                            || ct.contains("xml")
                            || ct.contains("graphql")
                            || ct.contains("grpc")
                            || ct.contains("protobuf")
                            || ct.contains("event-stream")
                    }
                    "ws" => !is_err && is_ws,
                    "errors" => is_err,
                    "mocked" => summary.is_mocked || summary.breakpoint_modified,
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
                && eval_capture_dnf_groups(summary, &guard.compiled_capture_matrix.exclude_groups)
            {
                return false;
            }
            if !guard.compiled_capture_matrix.include_groups.is_empty() {
                if !eval_capture_dnf_groups(summary, &guard.compiled_capture_matrix.include_groups)
                {
                    return false;
                }
                explicitly_included = true;
            }
        }

        // 5. Built-in OS Background Noise Guard (`svchost`, Windows/macOS telemetry & connectivity probes)
        // Dropped automatically when `Drop Non-Matching` is active unless explicitly whitelisted/included.
        if !explicitly_whitelisted && !explicitly_included && is_background_os_noise(summary, &host_clean)
        {
            return false;
        }

        true
    }

    /// Evaluates how an incoming `CONNECT host:port` tunnel should be handled according to
    /// the synced Bulk Hosts List (if enabled) and the active `TlsInterceptMode` (`InterceptAll` vs `TargetedOnly`).
    pub fn evaluate_connect_tunnel(&self, host: &str, port: u16) -> ConnectTunnelDecision {
        let host_lower = host.trim().trim_matches(['[', ']']).to_ascii_lowercase();
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
                    ConnectTunnelDecision::Passthrough(reason)
                }
                ConnectTunnelDecision::InterceptMitm => {
                    if guard.config.tls_bypass_enabled {
                        if let Some(rule) =
                            match_host_rule_list(&guard.config.tls_bypass_rules, host, port)
                        {
                            return ConnectTunnelDecision::Passthrough(
                                PassthroughReason::BypassRule(rule),
                            );
                        }
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
                if let Some(rule) =
                    match_host_rule_list(&guard.config.tls_bypass_rules, host, port)
                {
                    ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(rule))
                } else {
                    ConnectTunnelDecision::InterceptMitm
                }
            }
            TlsInterceptMode::TargetedOnly => {
                if match_host_rule_list(&guard.config.tls_target_rules, host, port).is_some() {
                    ConnectTunnelDecision::InterceptMitm
                } else {
                    ConnectTunnelDecision::Passthrough(PassthroughReason::NotInTargetAllowlist)
                }
            }
        }
    }

    /// Checks whether a `CONNECT host:port` tunnel matches an explicit rule in `tls_bypass_rules`.
    pub fn match_tls_bypass(&self, host: &str, port: u16) -> Option<TlsBypassRule> {
        let guard = self.state.read().ok()?;
        if !guard.config.tls_bypass_enabled {
            return None;
        }
        match_host_rule_list(&guard.config.tls_bypass_rules, host, port)
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
        if direction == HeaderMutationDirection::Response && guard.config.strip_alt_svc {
            if strip_alt_svc_vec(headers) {
                mutated = true;
            }
        }

        if !guard.config.header_mutations_enabled {
            return mutated;
        }

        let url_lower = url.to_ascii_lowercase();

        for rule in &guard.config.header_mutations {
            if !rule.enabled || rule.direction != direction {
                continue;
            }
            if !url_scope_matches(&url_lower, url, &rule.url_pattern) {
                continue;
            }

            match rule.operation {
                HeaderMutationOp::Remove => {
                    let targets: Vec<String> = rule
                        .header_name
                        .split(',')
                        .map(|s| s.trim().to_ascii_lowercase())
                        .filter(|s| !s.is_empty())
                        .collect();
                    if targets.is_empty() {
                        continue;
                    }
                    let before = headers.len();
                    headers.retain(|h| {
                        let name_lower = h.name.trim().to_ascii_lowercase();
                        !targets.iter().any(|t| t == &name_lower)
                    });
                    if headers.len() != before {
                        mutated = true;
                    }
                }
                HeaderMutationOp::Set => {
                    let target_name = rule.header_name.trim();
                    if target_name.is_empty() {
                        continue;
                    }
                    headers.retain(|h| !h.name.trim().eq_ignore_ascii_case(target_name));
                    headers.push(HeaderPair {
                        name: target_name.to_string(),
                        value: rule.header_value.clone(),
                    });
                    mutated = true;
                }
                HeaderMutationOp::Append => {
                    let target_name = rule.header_name.trim();
                    if target_name.is_empty() {
                        continue;
                    }
                    headers.push(HeaderPair {
                        name: target_name.to_string(),
                        value: rule.header_value.clone(),
                    });
                    mutated = true;
                }
            }
        }

        if direction == HeaderMutationDirection::Response && guard.config.strip_alt_svc {
            if strip_alt_svc_vec(headers) {
                mutated = true;
            }
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
/// glob `*`/`?`, `regex:`, optional `:port`, and `!pattern` negative carve-out exclusions.
/// Negative `!` tokens across all enabled rules take priority over positive matches.
pub fn match_host_rule_list(rules: &[TlsBypassRule], host: &str, port: u16) -> Option<TlsBypassRule> {
    let host_clean = host.trim().trim_matches(['[', ']']).to_ascii_lowercase();
    let host_with_port = format!("{host_clean}:{port}");

    // First pass: check negative carve-outs (`!sub.domain.com`)
    for rule in rules {
        if !rule.enabled {
            continue;
        }
        for raw_token in rule.pattern.split(',') {
            if let Some((true, token)) = normalize_host_token(raw_token) {
                let subject = if token.contains(':') && !token.starts_with("regex:") {
                    host_with_port.as_str()
                } else {
                    host_clean.as_str()
                };
                if wildcard_or_regex_matches(subject, &token) {
                    return None;
                }
            }
        }
    }

    // Second pass: check positive host/wildcard/regex rules
    for rule in rules {
        if !rule.enabled {
            continue;
        }
        for raw_token in rule.pattern.split(',') {
            if let Some((false, token)) = normalize_host_token(raw_token) {
                let subject = if token.contains(':') && !token.starts_with("regex:") {
                    host_with_port.as_str()
                } else {
                    host_clean.as_str()
                };
                if wildcard_or_regex_matches(subject, &token) {
                    return Some(rule.clone());
                }
            }
        }
    }

    None
}

fn normalize_host_token(raw: &str) -> Option<(bool, String)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (negated, rest) = if let Some(stripped) = trimmed.strip_prefix('!') {
        (true, stripped.trim())
    } else {
        (false, trimmed)
    };
    if rest.is_empty() {
        return None;
    }
    if rest.len() >= 6 && rest[..6].eq_ignore_ascii_case("regex:") {
        let expr = rest[6..].trim();
        if expr.is_empty() {
            return None;
        }
        return Some((negated, format!("regex:{expr}")));
    }

    let mut lower = rest.to_ascii_lowercase();
    for scheme in ["https://", "http://", "wss://", "ws://"] {
        if let Some(after_scheme) = lower.strip_prefix(scheme) {
            lower = after_scheme.to_string();
            break;
        }
    }
    if let Some((authority, _)) = lower.split_once('/') {
        lower = authority.to_string();
    }
    let clean = lower.trim().trim_matches(['[', ']']).to_string();
    if clean.is_empty() {
        None
    } else {
        Some((negated, clean))
    }
}

fn url_scope_matches(url_lower: &str, raw_url: &str, pattern: &str) -> bool {
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
        return glob_matches(url_lower, &pat_lower);
    }
    url_lower.contains(&pat_lower)
}

fn wildcard_or_regex_matches(subject: &str, token: &str) -> bool {
    if token == "*" {
        return true;
    }
    if let Some(re_str) = token.strip_prefix("regex:") {
        return Regex::new(&format!("(?i){}", re_str.trim()))
            .map(|re| re.is_match(subject))
            .unwrap_or(false);
    }
    if let Some(domain_suffix) = token.strip_prefix("*.") {
        return subject == domain_suffix || subject.ends_with(&format!(".{domain_suffix}"));
    }
    if let Some(domain_suffix) = token.strip_prefix('.') {
        return subject == domain_suffix || subject.ends_with(token);
    }
    if token.contains('*') {
        return glob_matches(subject, token);
    }
    subject == token
}

fn glob_matches(subject: &str, glob: &str) -> bool {
    let mut regex_str = String::from("^(?i)");
    for ch in glob.chars() {
        if ch == '*' {
            regex_str.push_str(".*");
        } else if ch == '?' {
            regex_str.push('.');
        } else {
            regex_str.push_str(&regex::escape(&ch.to_string()));
        }
    }
    regex_str.push('$');
    Regex::new(&regex_str)
        .map(|re| re.is_match(subject))
        .unwrap_or(false)
}

fn strip_inline_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i].is_ascii_whitespace() {
            let rest = &line[i..];
            let trimmed_rest = rest.trim_start();
            if trimmed_rest.starts_with('#') || trimmed_rest.starts_with("//") {
                return line[..i].trim_end();
            }
        }
    }
    line
}

/// Tokenizes raw bulk Hosts & URL input:
/// - Ignores empty lines and lines starting with `#` or `//`
/// - Strips trailing inline comments (` # ...` / ` // ...`) on non-regex lines
/// - Splits comma `,` and semicolon `;` lists while preserving `regex:` patterns and `{m,n}` quantifiers
pub fn tokenize_host_list_input(raw_text: &str) -> Vec<String> {
    if raw_text.trim().is_empty() {
        return Vec::new();
    }
    let mut tokens = Vec::new();

    for raw_line in raw_text.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("//") {
            continue;
        }

        if trimmed.len() >= 6 && trimmed[..6].eq_ignore_ascii_case("regex:") {
            tokens.push(trimmed.to_string());
            continue;
        }

        let cleaned = strip_inline_comment(trimmed).trim();
        if cleaned.is_empty() {
            continue;
        }

        let mut current = String::new();
        let mut depth: usize = 0;
        let mut escaped = false;
        let mut in_regex_segment = false;

        for ch in cleaned.chars() {
            if escaped {
                current.push(ch);
                escaped = false;
                continue;
            }
            if ch == '\\' {
                current.push(ch);
                escaped = true;
                continue;
            }
            let curr_trimmed = current.trim_start();
            if !in_regex_segment
                && curr_trimmed.len() >= 6
                && curr_trimmed[..6].eq_ignore_ascii_case("regex:")
            {
                in_regex_segment = true;
            }
            match ch {
                '{' | '[' | '(' => depth += 1,
                '}' | ']' | ')' => depth = depth.saturating_sub(1),
                _ => {}
            }

            if (ch == ',' || ch == ';') && depth == 0 && !in_regex_segment {
                let piece = current.trim();
                if !piece.is_empty() && !piece.starts_with('#') && !piece.starts_with("//") {
                    tokens.push(piece.to_string());
                }
                current.clear();
                in_regex_segment = false;
            } else {
                current.push(ch);
            }
        }

        let tail = current.trim();
        if !tail.is_empty() && !tail.starts_with('#') && !tail.starts_with("//") {
            tokens.push(tail.to_string());
        }
    }

    tokens
}

fn split_authority_pattern(authority: &str) -> (&str, Option<&str>) {
    let trimmed = authority.trim();
    if let Some(after_open) = trimmed.strip_prefix('[') {
        if let Some(close_idx) = after_open.find(']') {
            let host_pat = &after_open[..close_idx];
            let rest = &after_open[close_idx + 1..];
            let port_pat = rest.strip_prefix(':').filter(|p| !p.is_empty());
            return (host_pat, port_pat);
        }
    }
    if let Some((host_pat, port_pat)) = trimmed.rsplit_once(':') {
        if !port_pat.is_empty() && !host_pat.contains(':') {
            return (host_pat, Some(port_pat));
        }
    }
    (trimmed, None)
}

fn glob_segment_to_regex_src(glob: &str, star_char_class: &str) -> String {
    let mut out = String::new();
    for ch in glob.chars() {
        if ch == '*' {
            out.push_str(star_char_class);
            out.push('*');
        } else if ch == '?' {
            out.push_str(star_char_class);
        } else {
            out.push_str(&regex::escape(&ch.to_string()));
        }
    }
    out
}

fn compile_host_pattern_src(host_pat: &str) -> String {
    if host_pat == "*" {
        return "[^/:]+".to_string();
    }
    if let Some(rest) = host_pat.strip_prefix("*.") {
        return format!(
            "(?:[^/:]+\\.)?{}",
            glob_segment_to_regex_src(rest, "[^/:]")
        );
    }
    if let Some(rest) = host_pat.strip_prefix('.') {
        return format!(
            "(?:[^/:]+\\.)?{}",
            glob_segment_to_regex_src(rest, "[^/:]")
        );
    }
    glob_segment_to_regex_src(host_pat, "[^/:]")
}

fn build_combined_regex(sources: &[String]) -> Option<Regex> {
    if sources.is_empty() {
        return None;
    }
    let pattern = format!("^(?i)(?:{})$", sources.join("|"));
    Regex::new(&pattern).ok()
}

fn compile_backend_host_list(sync: &HostListBackendSyncConfig) -> CompiledBackendHostList {
    let mut compiled = CompiledBackendHostList {
        enabled: sync.enabled,
        mode: sync.mode,
        ..Default::default()
    };

    if !sync.enabled {
        return compiled;
    }

    let tokens = tokenize_host_list_input(&sync.raw_text);
    let mut whitelist_glob_sources: Vec<String> = Vec::new();
    let mut blacklist_glob_sources: Vec<String> = Vec::new();

    for token in tokens {
        // 1. Explicit `regex:...`
        if token.len() >= 6 && token[..6].eq_ignore_ascii_case("regex:") {
            let expr = token[6..].trim();
            if expr.is_empty() {
                continue;
            }
            if let Ok(re) = Regex::new(&format!("(?i){expr}")) {
                compiled.user_regexes.push(re);
                compiled.active_count += 1;
            }
            continue;
        }

        // 2. Universal wildcard
        if token == "*" || token == "*/*" {
            compiled.matches_everything = true;
            compiled.has_universal_host_rule = true;
            compiled.active_count += 1;
            continue;
        }

        // 3. Path-only rule (`/api/v1/*`) — applies across any host in Whitelist mode, never whole-host-bypasses CONNECT in Blacklist mode
        if token.starts_with('/') {
            compiled.has_universal_host_rule = true;
            compiled.active_count += 1;
            continue;
        }

        // 4. Host / Authority / URL pattern
        let mut lower = token.to_ascii_lowercase();
        let mut scheme: Option<&str> = None;
        for (prefix, name) in [
            ("https://", "https"),
            ("http://", "http"),
            ("wss://", "wss"),
            ("ws://", "ws"),
        ] {
            if let Some(rest) = lower.strip_prefix(prefix) {
                scheme = Some(name);
                lower = rest.to_string();
                break;
            }
        }

        let (authority_raw, path_raw) = match lower.find('/') {
            Some(idx) => (&lower[..idx], Some(&lower[idx..])),
            None => (lower.as_str(), None),
        };

        let (host_pat, port_pat) = split_authority_pattern(authority_raw);
        if host_pat.is_empty() {
            continue;
        }

        compiled.active_count += 1;

        let is_tls_compatible = matches!(scheme, None | Some("https") | Some("wss"));
        if !is_tls_compatible {
            // Explicit `http://` or `ws://` rule does not apply to HTTPS CONNECT tunnels
            continue;
        }

        if host_pat == "*" {
            compiled.has_universal_host_rule = true;
        }

        let is_whole_host_path = matches!(path_raw, None | Some("/") | Some("/*"));
        let host_has_wildcard = host_pat.contains('*') || host_pat.contains('?');
        let port_has_wildcard =
            port_pat.map_or(false, |p| p.contains('*') || p.contains('?'));

        let simple_subdomain_suffix = if let Some(rest) = host_pat.strip_prefix("*.") {
            (!rest.is_empty() && !rest.contains('*') && !rest.contains('?')).then_some(rest)
        } else if let Some(rest) = host_pat.strip_prefix('.') {
            (!rest.is_empty() && !rest.contains('*') && !rest.contains('?')).then_some(rest)
        } else {
            None
        };

        if !host_has_wildcard && !port_has_wildcard {
            if let Some(port) = port_pat {
                let hp = format!("{host_pat}:{port}");
                compiled.whitelist_host_ports.insert(hp.clone());
                if is_whole_host_path {
                    compiled.blacklist_host_ports.insert(hp);
                }
            } else {
                compiled.whitelist_hosts.insert(host_pat.to_string());
                if is_whole_host_path {
                    compiled.blacklist_hosts.insert(host_pat.to_string());
                }
            }
        } else if let (Some(suffix), None) = (simple_subdomain_suffix, port_pat) {
            compiled.whitelist_wildcards.insert(suffix.to_string());
            if is_whole_host_path {
                compiled.blacklist_wildcards.insert(suffix.to_string());
            }
        } else {
            let h_src = compile_host_pattern_src(host_pat);
            let full_hp_src = match port_pat {
                Some(p) => format!("{h_src}:{}", glob_segment_to_regex_src(p, "[0-9]")),
                None => format!("{h_src}(?::[0-9]+)?"),
            };
            whitelist_glob_sources.push(full_hp_src.clone());
            if is_whole_host_path {
                blacklist_glob_sources.push(full_hp_src);
            }
        }
    }

    compiled.whitelist_glob_regex = build_combined_regex(&whitelist_glob_sources);
    compiled.blacklist_glob_regex = build_combined_regex(&blacklist_glob_sources);
    compiled
}

fn matches_wildcard_domain_set(hostname_lower: &str, domain_set: &HashSet<String>) -> bool {
    if domain_set.is_empty() {
        return false;
    }
    if domain_set.contains(hostname_lower) {
        return true;
    }
    let mut rest = hostname_lower;
    while let Some(dot_idx) = rest.find('.') {
        let suffix = &rest[dot_idx + 1..];
        if domain_set.contains(suffix) {
            return true;
        }
        rest = suffix;
    }
    false
}

fn matches_any_user_regex(
    regexes: &[Regex],
    host_lower: &str,
    host_port: &str,
    synthetic_url: &str,
    synthetic_url_with_port: &str,
) -> bool {
    for re in regexes {
        if re.is_match(host_lower)
            || re.is_match(host_port)
            || re.is_match(synthetic_url)
            || re.is_match(synthetic_url_with_port)
        {
            return true;
        }
    }
    false
}

fn evaluate_compiled_host_list_connect(
    compiled: &CompiledBackendHostList,
    host_lower: &str,
    port: u16,
) -> Option<ConnectTunnelDecision> {
    if !compiled.enabled || compiled.active_count == 0 {
        return None;
    }

    let host_port = format!("{host_lower}:{port}");
    let synthetic_url = if port == 443 {
        format!("https://{host_lower}/")
    } else {
        format!("https://{host_lower}:{port}/")
    };
    let synthetic_url_with_port = format!("https://{host_lower}:{port}/");

    match compiled.mode {
        HostListFilterMode::Whitelist => {
            if compiled.matches_everything || compiled.has_universal_host_rule {
                return None;
            }
            let matched = compiled.whitelist_hosts.contains(host_lower)
                || compiled.whitelist_host_ports.contains(&host_port)
                || matches_wildcard_domain_set(host_lower, &compiled.whitelist_wildcards)
                || compiled.whitelist_glob_regex.as_ref().map_or(false, |re| {
                    re.is_match(host_lower) || re.is_match(&host_port)
                })
                || matches_any_user_regex(
                    &compiled.user_regexes,
                    host_lower,
                    &host_port,
                    &synthetic_url,
                    &synthetic_url_with_port,
                );

            if matched {
                Some(ConnectTunnelDecision::InterceptMitm)
            } else {
                Some(ConnectTunnelDecision::Passthrough(
                    PassthroughReason::NotInHostsWhitelist,
                ))
            }
        }
        HostListFilterMode::Blacklist => {
            let whole_host_matched = compiled.matches_everything
                || compiled.blacklist_hosts.contains(host_lower)
                || compiled.blacklist_host_ports.contains(&host_port)
                || matches_wildcard_domain_set(host_lower, &compiled.blacklist_wildcards)
                || compiled.blacklist_glob_regex.as_ref().map_or(false, |re| {
                    re.is_match(host_lower) || re.is_match(&host_port)
                })
                || matches_any_user_regex(
                    &compiled.user_regexes,
                    host_lower,
                    &host_port,
                    &synthetic_url,
                    &synthetic_url_with_port,
                );

            if whole_host_matched {
                Some(ConnectTunnelDecision::Passthrough(
                    PassthroughReason::BypassRule(TlsBypassRule {
                        id: "hosts-list-blacklist".into(),
                        enabled: true,
                        pattern: host_port,
                        category: "Hosts List (Blacklist)".into(),
                        description: "Bulk Hosts Filter — Hide & TLS Passthrough".into(),
                    }),
                ))
            } else {
                None
            }
        }
    }
}

pub fn default_backend_config() -> ProxyFilterBackendConfig {
    ProxyFilterBackendConfig {
        tls_intercept_mode: TlsInterceptMode::InterceptAll,
        tls_bypass_enabled: true,
        tls_bypass_rules: vec![
            TlsBypassRule {
                id: "bypass-apple-icloud".into(),
                enabled: true,
                pattern: "*.apple.com, *.icloud.com, *.mzstatic.com".into(),
                category: "OS Updaters".into(),
                description: "Apple / iCloud / App Store strict Certificate Pinning".into(),
            },
            TlsBypassRule {
                id: "bypass-windows-update".into(),
                enabled: true,
                pattern: "*.windowsupdate.com, *.delivery.mp.microsoft.com".into(),
                category: "OS Updaters".into(),
                description: "Windows Update & Delivery Optimization pinned TLS".into(),
            },
            TlsBypassRule {
                id: "bypass-messengers".into(),
                enabled: true,
                pattern: "*.telegram.org, *.whatsapp.net, *.signal.org".into(),
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
        ],
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
        compiled_host_list,
        compiled_capture_host_list,
        compiled_capture_matrix,
        compiled_query_regex,
        static_asset_ext_re,
    }
}

fn extract_clean_hostname(raw_host: &str) -> String {
    let trimmed = raw_host.trim();
    let (h, _) = split_authority_pattern(trimmed);
    h.trim_matches(['[', ']']).to_ascii_lowercase()
}

fn extract_session_port(summary: &SessionSummary) -> u16 {
    let (_, port_opt) = split_authority_pattern(summary.host.trim());
    if let Some(p_str) = port_opt {
        if let Ok(p) = p_str.parse::<u16>() {
            return p;
        }
    }
    if let Ok(parsed) = reqwest::Url::parse(&summary.url) {
        if let Some(p) = parsed.port_or_known_default() {
            return p;
        }
    }
    if summary.scheme.eq_ignore_ascii_case("http") || summary.scheme.eq_ignore_ascii_case("ws") {
        80
    } else {
        443
    }
}

fn is_background_os_noise(summary: &SessionSummary, host_clean: &str) -> bool {
    if let Some(ref proc_raw) = summary.process_name {
        let proc_base = proc_raw
            .trim()
            .trim_end_matches(".exe")
            .trim_end_matches(".EXE")
            .to_ascii_lowercase();
        if matches!(
            proc_base.as_str(),
            "svchost"
                | "searchhost"
                | "compattelrunner"
                | "widgets"
                | "wuauclt"
                | "usoclient"
                | "trustedinstaller"
                | "mdnsresponder"
                | "apsd"
        ) {
            return true;
        }
    }

    const OS_NOISE_DOMAINS: &[&str] = &[
        "telemetry.microsoft.com",
        "vortex.data.microsoft.com",
        "watson.telemetry.microsoft.com",
        "settings-win.data.microsoft.com",
        "oca.microsoft.com",
        "sqm.microsoft.com",
        "msftconnecttest.com",
        "msftncsi.com",
        "windowsupdate.com",
        "delivery.mp.microsoft.com",
    ];

    for &noise_dom in OS_NOISE_DOMAINS {
        if host_clean == noise_dom
            || (host_clean.len() > noise_dom.len()
                && host_clean.ends_with(noise_dom)
                && host_clean.as_bytes()[host_clean.len() - noise_dom.len() - 1] == b'.')
        {
            return true;
        }
    }

    false
}

fn compile_capture_host_list(sync: &HostListBackendSyncConfig) -> CompiledCaptureHostList {
    let mut out = CompiledCaptureHostList {
        enabled: sync.enabled,
        mode: sync.mode,
        ..Default::default()
    };
    if !sync.enabled {
        return out;
    }

    let tokens = tokenize_host_list_input(&sync.raw_text);
    let mut host_glob_sources = Vec::new();
    let mut host_port_glob_sources = Vec::new();
    let mut host_path_sources = Vec::new();
    let mut full_url_sources = Vec::new();
    let mut path_only_sources = Vec::new();

    for token in tokens {
        if token.len() >= 6 && token[..6].eq_ignore_ascii_case("regex:") {
            let expr = token[6..].trim();
            if !expr.is_empty() {
                if let Ok(re) = Regex::new(&format!("(?i){expr}")) {
                    out.user_regexes.push(re);
                    out.active_count += 1;
                }
            }
            continue;
        }

        if token == "*" || token == "*/*" {
            out.matches_everything = true;
            out.active_count += 1;
            continue;
        }

        if token.starts_with('/') {
            let pat_lower = token.to_ascii_lowercase();
            out.active_count += 1;
            if pat_lower.contains('*') || pat_lower.contains('?') {
                path_only_sources.push(glob_segment_to_regex_src(&pat_lower, "."));
            } else {
                let clean_prefix = if pat_lower.len() > 1 && pat_lower.ends_with('/') {
                    &pat_lower[..pat_lower.len() - 1]
                } else {
                    pat_lower.as_str()
                };
                path_only_sources.push(format!("{}(?:[/?#].*)?", regex::escape(clean_prefix)));
            }
            continue;
        }

        let mut lower = token.to_ascii_lowercase();
        let mut scheme: Option<&str> = None;
        for (prefix, name) in [
            ("https://", "https"),
            ("http://", "http"),
            ("wss://", "wss"),
            ("ws://", "ws"),
        ] {
            if let Some(rest) = lower.strip_prefix(prefix) {
                scheme = Some(name);
                lower = rest.to_string();
                break;
            }
        }

        let (authority_raw, path_raw) = match lower.find('/') {
            Some(idx) => (&lower[..idx], Some(&lower[idx..])),
            None => (lower.as_str(), None),
        };
        let (host_pat, port_pat) = split_authority_pattern(authority_raw);
        if host_pat.is_empty() {
            continue;
        }

        out.active_count += 1;

        let is_whole_host_path = matches!(path_raw, None | Some("/") | Some("/*"));
        let host_has_wildcard = host_pat.contains('*') || host_pat.contains('?');
        let port_has_wildcard = port_pat.map_or(false, |p| p.contains('*') || p.contains('?'));

        if is_whole_host_path {
            if let Some(sc) = scheme {
                if !host_has_wildcard && !port_has_wildcard {
                    if let Some(p) = port_pat {
                        out.exact_scheme_host_ports
                            .insert(format!("{sc}://{host_pat}:{p}"));
                    } else {
                        out.exact_scheme_hosts.insert(format!("{sc}://{host_pat}"));
                    }
                } else {
                    let h_src = compile_host_pattern_src(host_pat);
                    let p_src = match port_pat {
                        Some(p) => format!(":{}", glob_segment_to_regex_src(p, "[0-9]")),
                        None => "(?::[0-9]+)?".to_string(),
                    };
                    full_url_sources.push(format!("{}://{}{}(?:/.*)?", regex::escape(sc), h_src, p_src));
                }
            } else if !host_has_wildcard && !port_has_wildcard {
                if let Some(p) = port_pat {
                    out.exact_host_ports.insert(format!("{host_pat}:{p}"));
                } else {
                    out.exact_hosts.insert(host_pat.to_string());
                }
            } else if port_pat.is_none() {
                let simple_suffix = host_pat
                    .strip_prefix("*.")
                    .or_else(|| host_pat.strip_prefix('.'))
                    .filter(|rest| !rest.is_empty() && !rest.contains('*') && !rest.contains('?'));
                if let Some(suf) = simple_suffix {
                    out.wildcard_domains.insert(suf.to_string());
                } else {
                    host_glob_sources.push(compile_host_pattern_src(host_pat));
                }
            } else if let Some(p) = port_pat {
                let h_src = compile_host_pattern_src(host_pat);
                host_port_glob_sources.push(format!("{h_src}:{}", glob_segment_to_regex_src(p, "[0-9]")));
            }
        } else if let Some(path_part) = path_raw {
            let h_src = compile_host_pattern_src(host_pat);
            let p_src = match port_pat {
                Some(p) => format!(":{}", glob_segment_to_regex_src(p, "[0-9]")),
                None => "(?::[0-9]+)?".to_string(),
            };
            let path_regex = if path_part.contains('*') || path_part.contains('?') {
                glob_segment_to_regex_src(path_part, ".")
            } else {
                let clean_p = if path_part.len() > 1 && path_part.ends_with('/') {
                    &path_part[..path_part.len() - 1]
                } else {
                    path_part
                };
                format!("{}(?:[/?#].*)?", regex::escape(clean_p))
            };
            if let Some(sc) = scheme {
                full_url_sources.push(format!("{}://{}{}{}", regex::escape(sc), h_src, p_src, path_regex));
            } else {
                host_path_sources.push(format!("{h_src}{p_src}{path_regex}"));
            }
        }
    }

    out.host_glob_regex = build_combined_regex(&host_glob_sources);
    out.host_port_glob_regex = build_combined_regex(&host_port_glob_sources);
    out.host_path_regex = build_combined_regex(&host_path_sources);
    out.full_url_regex = build_combined_regex(&full_url_sources);
    out.path_only_regex = build_combined_regex(&path_only_sources);
    out
}

fn matches_compiled_capture_host_list(
    summary: &SessionSummary,
    host_clean: &str,
    compiled: &CompiledCaptureHostList,
) -> bool {
    if !compiled.enabled || compiled.active_count == 0 {
        return false;
    }
    if compiled.matches_everything {
        return true;
    }
    if compiled.exact_hosts.contains(host_clean)
        || matches_wildcard_domain_set(host_clean, &compiled.wildcard_domains)
        || compiled
            .host_glob_regex
            .as_ref()
            .map_or(false, |re| re.is_match(host_clean))
    {
        return true;
    }

    let scheme_lower = summary.scheme.to_ascii_lowercase();
    let port = extract_session_port(summary);
    let host_port = format!("{host_clean}:{port}");
    let url_path = if summary.method.eq_ignore_ascii_case("CONNECT") || summary.path.is_empty() {
        "/"
    } else {
        summary.path.as_str()
    };

    if compiled.exact_host_ports.contains(&host_port)
        || compiled
            .exact_scheme_hosts
            .contains(&format!("{scheme_lower}://{host_clean}"))
        || compiled
            .exact_scheme_host_ports
            .contains(&format!("{scheme_lower}://{host_port}"))
    {
        return true;
    }

    if compiled
        .host_port_glob_regex
        .as_ref()
        .map_or(false, |re| re.is_match(&host_port))
    {
        return true;
    }

    if compiled
        .path_only_regex
        .as_ref()
        .map_or(false, |re| re.is_match(url_path))
    {
        return true;
    }

    if let Some(ref hp_re) = compiled.host_path_regex {
        if hp_re.is_match(&format!("{host_clean}{url_path}"))
            || hp_re.is_match(&format!("{host_port}{url_path}"))
        {
            return true;
        }
    }

    if let Some(ref url_re) = compiled.full_url_regex {
        let normalized_full = format!("{scheme_lower}://{host_port}{url_path}");
        if url_re.is_match(&summary.url) || url_re.is_match(&normalized_full) {
            return true;
        }
    }

    for re in &compiled.user_regexes {
        if re.is_match(&summary.url) || re.is_match(&summary.host) || re.is_match(host_clean) {
            return true;
        }
    }

    false
}

fn parse_threshold_number(raw: &str, field: &str) -> Option<f64> {
    let trimmed = raw.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return None;
    }
    let unit_candidates = ["gb", "mb", "kb", "ms", "b", "s"];
    let mut num_part = trimmed.as_str();
    let mut unit: Option<&str> = None;
    for cand in unit_candidates {
        if let Some(stripped) = trimmed.strip_suffix(cand) {
            let clean = stripped.trim();
            if clean.parse::<f64>().is_ok() {
                num_part = clean;
                unit = Some(cand);
                break;
            }
        }
    }
    let num = num_part.parse::<f64>().ok()?;
    if !num.is_finite() {
        return None;
    }
    if field == "bodySize" {
        return Some(match unit {
            Some("gb") => num * 1024.0 * 1024.0 * 1024.0,
            Some("mb") => num * 1024.0 * 1024.0,
            Some("kb") => num * 1024.0,
            _ => num,
        });
    }
    if field == "durationMs" && unit == Some("s") {
        return Some(num * 1000.0);
    }
    Some(num)
}

fn build_capture_dnf_groups(
    items: Vec<CompiledCaptureCondition>,
) -> Vec<Vec<CompiledCaptureCondition>> {
    let mut groups: Vec<Vec<CompiledCaptureCondition>> = Vec::new();
    for item in items {
        if groups.is_empty() || item.rule.logical_op.eq_ignore_ascii_case("OR") {
            groups.push(vec![item]);
        } else if let Some(last) = groups.last_mut() {
            last.push(item);
        }
    }
    groups
}

fn compile_capture_matrix(rules: &[CaptureFilterRule]) -> CompiledCaptureMatrix {
    let mut includes = Vec::new();
    let mut excludes = Vec::new();

    for rule in rules {
        if !rule.enabled {
            continue;
        }
        let raw_val = rule.value.trim();
        if raw_val.is_empty() {
            continue;
        }
        let regex = if rule.operator == "regex" {
            match Regex::new(&format!("(?i){raw_val}")) {
                Ok(re) => Some(re),
                Err(_) => continue,
            }
        } else {
            None
        };

        let cond = CompiledCaptureCondition {
            rule: rule.clone(),
            regex,
            numeric_target: parse_threshold_number(raw_val, &rule.field),
            lower_value: raw_val.to_lowercase(),
        };

        if rule.action.eq_ignore_ascii_case("include") {
            includes.push(cond);
        } else {
            excludes.push(cond);
        }
    }

    CompiledCaptureMatrix {
        include_groups: build_capture_dnf_groups(includes),
        exclude_groups: build_capture_dnf_groups(excludes),
    }
}

fn extract_summary_field_str(s: &SessionSummary, field: &str) -> String {
    match field {
        "url" => s.url.clone(),
        "host" => s.host.clone(),
        "path" => s.path.clone(),
        "method" => s.method.clone(),
        "status" => s.status.to_string(),
        "contentType" => s.content_type.clone(),
        "processName" => s.process_name.clone().unwrap_or_default(),
        "processPid" => s.process_pid.map(|p| p.to_string()).unwrap_or_default(),
        "clientIp" => s.client_ip.clone().unwrap_or_default(),
        "protocol" => s.protocol.clone(),
        "bodySize" => s.body_size.to_string(),
        "durationMs" => s.duration_ms.to_string(),
        "comment" => s.comment.clone().unwrap_or_default(),
        _ => String::new(),
    }
}

fn extract_summary_field_num(s: &SessionSummary, field: &str) -> Option<f64> {
    match field {
        "status" => Some(s.status as f64),
        "bodySize" => Some(s.body_size as f64),
        "durationMs" => Some(s.duration_ms as f64),
        "processPid" => s.process_pid.map(|p| p as f64),
        _ => extract_summary_field_str(s, field).parse::<f64>().ok(),
    }
}

fn eval_capture_condition(s: &SessionSummary, cond: &CompiledCaptureCondition) -> bool {
    let op = cond.rule.operator.as_str();
    if matches!(op, "gt" | "gte" | "lt" | "lte") {
        let (Some(actual), Some(target)) = (
            extract_summary_field_num(s, &cond.rule.field),
            cond.numeric_target,
        ) else {
            return false;
        };
        return match op {
            "gt" => actual > target,
            "gte" => actual >= target,
            "lt" => actual < target,
            _ => actual <= target,
        };
    }

    if matches!(op, "equals" | "notEquals")
        && cond.numeric_target.is_some()
        && matches!(
            cond.rule.field.as_str(),
            "status" | "bodySize" | "durationMs" | "processPid"
        )
    {
        if let (Some(actual), Some(target)) = (
            extract_summary_field_num(s, &cond.rule.field),
            cond.numeric_target,
        ) {
            let eq = (actual - target).abs() < f64::EPSILON;
            return if op == "equals" { eq } else { !eq };
        }
    }

    let raw_text = extract_summary_field_str(s, &cond.rule.field);
    if op == "regex" {
        return cond
            .regex
            .as_ref()
            .map_or(false, |re| re.is_match(&raw_text));
    }

    let text_lower = raw_text.to_lowercase();
    match op {
        "contains" => text_lower.contains(&cond.lower_value),
        "notContains" => !text_lower.contains(&cond.lower_value),
        "equals" => text_lower == cond.lower_value,
        "notEquals" => text_lower != cond.lower_value,
        "startsWith" => text_lower.starts_with(&cond.lower_value),
        "endsWith" => text_lower.ends_with(&cond.lower_value),
        _ => false,
    }
}

fn eval_capture_dnf_groups(
    s: &SessionSummary,
    groups: &[Vec<CompiledCaptureCondition>],
) -> bool {
    for conjunction in groups {
        if conjunction.iter().all(|c| eval_capture_condition(s, c)) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_wildcard_and_exact_tls_bypass_domains() {
        let engine = ProxyFilterEngine::new();
        assert!(engine.match_tls_bypass("p12-buy.itunes.apple.com", 443).is_some());
        assert!(engine.match_tls_bypass("apple.com", 443).is_some());
        assert!(engine.match_tls_bypass("web.telegram.org", 443).is_some());
        assert!(engine.match_tls_bypass("api.stripe.com", 443).is_none());
    }

    #[test]
    fn targeted_only_mode_inspects_allowlist_and_passes_through_everything_else() {
        let engine = ProxyFilterEngine::new();
        let mut cfg = engine.get_config();
        cfg.tls_intercept_mode = TlsInterceptMode::TargetedOnly;
        cfg.tls_target_rules = vec![
            TlsBypassRule {
                id: "target-corp".into(),
                enabled: true,
                pattern: "*.mycompany.com, https://api.test.ru/v1".into(),
                category: "Target Allowlist".into(),
                description: "Inspect corporate and test services only".into(),
            },
            TlsBypassRule {
                id: "exclude-mtls".into(),
                enabled: true,
                pattern: "!mtls.mycompany.com".into(),
                category: "Exception".into(),
                description: "Carve out mTLS endpoint from wildcard target".into(),
            },
        ];
        engine.update_config(cfg);

        // Allowlisted hosts -> InterceptMitm
        assert_eq!(
            engine.evaluate_connect_tunnel("app.mycompany.com", 443),
            ConnectTunnelDecision::InterceptMitm
        );
        assert_eq!(
            engine.evaluate_connect_tunnel("mycompany.com", 443),
            ConnectTunnelDecision::InterceptMitm
        );
        assert_eq!(
            engine.evaluate_connect_tunnel("api.test.ru", 443),
            ConnectTunnelDecision::InterceptMitm
        );

        // Carved-out subdomain via `!mtls.mycompany.com` -> Passthrough
        assert_eq!(
            engine.evaluate_connect_tunnel("mtls.mycompany.com", 443),
            ConnectTunnelDecision::Passthrough(PassthroughReason::NotInTargetAllowlist)
        );

        // Unlisted 3rd-party services (Telegram, Steam, Teams, banking) -> Passthrough
        for host in [
            "kws2.web.telegram.org",
            "api.steampowered.com",
            "teams.microsoft.com",
            "online.sberbank.ru",
        ] {
            assert_eq!(
                engine.evaluate_connect_tunnel(host, 443),
                ConnectTunnelDecision::Passthrough(PassthroughReason::NotInTargetAllowlist),
                "expected {host} to be pure TCP passthrough in TargetedOnly mode"
            );
        }
    }

    #[test]
    fn negative_carve_out_allows_inspecting_single_host_in_intercept_all_mode() {
        let engine = ProxyFilterEngine::new();
        let mut cfg = engine.get_config();
        cfg.tls_bypass_rules.push(TlsBypassRule {
            id: "inspect-web-telegram".into(),
            enabled: true,
            pattern: "!web.telegram.org".into(),
            category: "Override".into(),
            description: "Inspect web.telegram.org despite *.telegram.org bypass".into(),
        });
        engine.update_config(cfg);

        assert_eq!(
            engine.evaluate_connect_tunnel("web.telegram.org", 443),
            ConnectTunnelDecision::InterceptMitm
        );
        assert!(matches!(
            engine.evaluate_connect_tunnel("kws4.web.telegram.org", 443),
            ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
        ));
    }

    #[test]
    fn mutates_headers_for_cache_bypass_and_user_agent() {
        let engine = ProxyFilterEngine::new();
        let mut cfg = engine.get_config();
        for rule in &mut cfg.header_mutations {
            rule.enabled = true;
        }
        engine.update_config(cfg);

        let mut req_headers = vec![
            HeaderPair {
                name: "User-Agent".into(),
                value: "OldBrowser/1.0".into(),
            },
            HeaderPair {
                name: "If-Modified-Since".into(),
                value: "Wed, 21 Oct 2026 07:28:00 GMT".into(),
            },
            HeaderPair {
                name: "If-None-Match".into(),
                value: "\"abc-123\"".into(),
            },
        ];

        let changed = engine.apply_header_mutations(
            HeaderMutationDirection::Request,
            "https://api.example.com/v1/items",
            &mut req_headers,
        );
        assert!(changed);
        assert_eq!(req_headers.len(), 1);
        assert_eq!(req_headers[0].name, "User-Agent");
        assert!(req_headers[0].value.contains("iPhone"));

        let mut resp_headers = vec![
            HeaderPair {
                name: "ETag".into(),
                value: "\"abc-123\"".into(),
            },
            HeaderPair {
                name: "Content-Type".into(),
                value: "application/json".into(),
            },
        ];
        let resp_changed = engine.apply_header_mutations(
            HeaderMutationDirection::Response,
            "https://api.example.com/v1/items",
            &mut resp_headers,
        );
        assert!(resp_changed);
        assert!(!resp_headers.iter().any(|h| h.name.eq_ignore_ascii_case("etag")));
        assert!(resp_headers
            .iter()
            .any(|h| h.name.eq_ignore_ascii_case("access-control-allow-origin")));
    }

    #[test]
    fn tokenizes_bulk_host_list_with_comments_delimiters_and_regex() {
        let raw = r#"
            # Вставьте домены, пути или маски:
            // Комментарий в стиле C
            *.my-api.com, api.partner.org; domain.com:8080 # inline comment
            https://auth.internal.corp:8443 // trailing comment
            regex:^https:\/\/(dev|stage)\.app\.com(:[0-9]{1,5})?
        "#;
        let tokens = tokenize_host_list_input(raw);
        assert_eq!(
            tokens,
            vec![
                "*.my-api.com",
                "api.partner.org",
                "domain.com:8080",
                "https://auth.internal.corp:8443",
                r"regex:^https:\/\/(dev|stage)\.app\.com(:[0-9]{1,5})?",
            ]
        );
    }

    #[test]
    fn bulk_host_list_blacklist_sync_bypasses_whole_hosts_and_preserves_subpath_mitm() {
        let engine = ProxyFilterEngine::new();
        let mut cfg = engine.get_config();
        cfg.host_list_sync = HostListBackendSyncConfig {
            enabled: true,
            mode: HostListFilterMode::Blacklist,
            raw_text: r#"
                # Blacklist + TLS Passthrough
                *.my-api.com
                api.partner.org
                https://auth.internal.corp:8443
                api.*.company.ru/*
                partial.service.io/healthz
                regex:^https:\/\/(dev|stage)\.app\.com
            "#
            .into(),
        };
        engine.update_config(cfg);

        assert!(matches!(
            engine.evaluate_connect_tunnel("v2.my-api.com", 443),
            ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
        ));
        assert!(matches!(
            engine.evaluate_connect_tunnel("api.partner.org", 443),
            ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
        ));
        assert!(matches!(
            engine.evaluate_connect_tunnel("auth.internal.corp", 8443),
            ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
        ));
        // Different port should NOT match explicit :8443 rule
        assert_eq!(
            engine.evaluate_connect_tunnel("auth.internal.corp", 443),
            ConnectTunnelDecision::InterceptMitm
        );
        // `api.*.company.ru/*` covers whole host path `/*` -> bypasses CONNECT
        assert!(matches!(
            engine.evaluate_connect_tunnel("api.eu.company.ru", 443),
            ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
        ));
        // `partial.service.io/healthz` is sub-path only -> keep MITM so other paths remain inspectable
        assert_eq!(
            engine.evaluate_connect_tunnel("partial.service.io", 443),
            ConnectTunnelDecision::InterceptMitm
        );
        // `regex:` rule matching https://stage.app.com
        assert!(matches!(
            engine.evaluate_connect_tunnel("stage.app.com", 443),
            ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
        ));
    }

    #[test]
    fn bulk_host_list_whitelist_sync_intercepts_listed_hosts_and_passes_through_others() {
        let engine = ProxyFilterEngine::new();
        let mut cfg = engine.get_config();
        cfg.host_list_sync = HostListBackendSyncConfig {
            enabled: true,
            mode: HostListFilterMode::Whitelist,
            raw_text: r#"
                *.my-api.com; api.partner.org
                https://auth.internal.corp:8443
                api.*.company.ru/v1/*
                regex:^https:\/\/(dev|stage)\.app\.com
            "#
            .into(),
        };
        engine.update_config(cfg);

        assert_eq!(
            engine.evaluate_connect_tunnel("orders.my-api.com", 443),
            ConnectTunnelDecision::InterceptMitm
        );
        assert_eq!(
            engine.evaluate_connect_tunnel("api.partner.org", 443),
            ConnectTunnelDecision::InterceptMitm
        );
        assert_eq!(
            engine.evaluate_connect_tunnel("auth.internal.corp", 8443),
            ConnectTunnelDecision::InterceptMitm
        );
        assert_eq!(
            engine.evaluate_connect_tunnel("auth.internal.corp", 443),
            ConnectTunnelDecision::Passthrough(PassthroughReason::NotInHostsWhitelist)
        );
        // Sub-path rule in Whitelist mode MUST still intercept CONNECT for that host so /v1/* can be inspected
        assert_eq!(
            engine.evaluate_connect_tunnel("api.msk.company.ru", 443),
            ConnectTunnelDecision::InterceptMitm
        );
        assert_eq!(
            engine.evaluate_connect_tunnel("dev.app.com", 443),
            ConnectTunnelDecision::InterceptMitm
        );
        assert_eq!(
            engine.evaluate_connect_tunnel("telemetry.noise.net", 443),
            ConnectTunnelDecision::Passthrough(PassthroughReason::NotInHostsWhitelist)
        );
    }

    #[test]
    fn strips_alt_svc_and_alternate_protocol_by_default_even_when_mutations_disabled() {
        let engine = ProxyFilterEngine::new();
        assert!(engine.is_strip_alt_svc_enabled());

        let mut cfg = engine.get_config();
        assert!(cfg.strip_alt_svc);
        cfg.header_mutations_enabled = false;
        engine.update_config(cfg);

        let mut resp_headers = vec![
            HeaderPair {
                name: "Content-Type".into(),
                value: "application/json".into(),
            },
            HeaderPair {
                name: "Alt-Svc".into(),
                value: "h3=\":443\"; ma=86400, h3-29=\":443\"; ma=86400".into(),
            },
            HeaderPair {
                name: "alternate-protocol".into(),
                value: "443:quic".into(),
            },
            HeaderPair {
                name: "Cache-Control".into(),
                value: "no-store".into(),
            },
        ];

        let mutated = engine.apply_header_mutations(
            HeaderMutationDirection::Response,
            "https://www.google.com/search?q=rust",
            &mut resp_headers,
        );
        assert!(mutated);
        assert_eq!(resp_headers.len(), 2);
        assert!(!resp_headers.iter().any(|h| is_alt_svc_header(&h.name)));
        assert_eq!(resp_headers[0].name, "Content-Type");
        assert_eq!(resp_headers[1].name, "Cache-Control");
    }

    #[test]
    fn preserves_alt_svc_headers_when_strip_alt_svc_is_disabled() {
        let engine = ProxyFilterEngine::new();
        let mut cfg = engine.get_config();
        cfg.strip_alt_svc = false;
        engine.update_config(cfg);
        assert!(!engine.is_strip_alt_svc_enabled());

        let mut resp_headers = vec![
            HeaderPair {
                name: "alt-svc".into(),
                value: "h3=\":443\"; ma=2592000".into(),
            },
            HeaderPair {
                name: "Alternate-Protocol".into(),
                value: "443:quic,p=1".into(),
            },
        ];

        let mutated = engine.apply_header_mutations(
            HeaderMutationDirection::Response,
            "https://cloudflare.com/",
            &mut resp_headers,
        );
        assert!(!mutated);
        assert_eq!(resp_headers.len(), 2);

        // Also verify serde backward-compatibility default (`strip_alt_svc = true` when omitted)
        let legacy_json = r#"{
            "tlsInterceptMode": "interceptAll",
            "tlsBypassEnabled": true,
            "tlsBypassRules": [],
            "headerMutationsEnabled": true,
            "headerMutations": []
        }"#;
        let parsed: ProxyFilterBackendConfig =
            serde_json::from_str(legacy_json).expect("deserialize legacy config");
        assert!(parsed.strip_alt_svc);
    }

    fn make_summary_for_filter(
        method: &str,
        host: &str,
        path: &str,
        status: u16,
        process_name: Option<&str>,
    ) -> SessionSummary {
        SessionSummary {
            id: 1,
            status,
            protocol: "HTTPS/2".into(),
            scheme: "https".into(),
            method: method.into(),
            host: host.into(),
            path: path.into(),
            url: format!("https://{host}{path}"),
            content_type: "application/json".into(),
            body_size: 256,
            duration_ms: 48,
            timestamp: "2026-11-09T09:00:00Z".into(),
            is_mocked: false,
            matched_rule_id: None,
            error: None,
            process_name: process_name.map(str::to_owned),
            process_pid: Some(1200),
            tls_bypassed: false,
            headers_mutated: false,
            breakpoint_paused: None,
            breakpoint_modified: false,
            comment: None,
            marked_color: None,
            client_ip: Some("127.0.0.1".into()),
        }
    }

    #[test]
    fn evaluate_should_store_session_drops_os_noise_host_list_and_thresholds() {
        let engine = ProxyFilterEngine::new();

        let svchost_telemetry = make_summary_for_filter(
            "POST",
            "telemetry.microsoft.com",
            "/OneCollector/1.0/",
            200,
            Some("svchost.exe"),
        );
        let api_ok = make_summary_for_filter(
            "GET",
            "api.stripe.com",
            "/v1/payment_intents",
            200,
            Some("node.exe"),
        );
        let not_modified_304 = make_summary_for_filter(
            "GET",
            "api.stripe.com",
            "/v1/config",
            304,
            Some("chrome.exe"),
        );
        let other_host = make_summary_for_filter(
            "GET",
            "ads.example.net",
            "/banner",
            200,
            Some("chrome.exe"),
        );

        // Disabled by default -> everything stored
        assert!(engine.evaluate_should_store_session(&svchost_telemetry));
        assert!(engine.evaluate_should_store_session(&api_ok));

        // Enable Drop Non-Matching -> svchost & telemetry dropped immediately
        engine.set_drop_non_matching(true);
        assert!(engine.is_drop_non_matching_enabled());
        assert!(!engine.evaluate_should_store_session(&svchost_telemetry));
        assert!(engine.evaluate_should_store_session(&api_ok));

        // Activate host-list whitelist (*.stripe.com) + hide 304 threshold
        let mut cfg = engine.get_config();
        cfg.capture_host_list = HostListBackendSyncConfig {
            enabled: true,
            mode: HostListFilterMode::Whitelist,
            raw_text: "*.stripe.com".into(),
        };
        cfg.noise_thresholds.hide_304_not_modified = true;
        engine.update_config(cfg);

        assert!(engine.evaluate_should_store_session(&api_ok));
        assert!(!engine.evaluate_should_store_session(&not_modified_304));
        assert!(!engine.evaluate_should_store_session(&other_host));
        assert!(!engine.evaluate_should_store_session(&svchost_telemetry));
    }
}
