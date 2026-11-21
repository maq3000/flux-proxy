use std::collections::HashSet;

use regex::Regex;

use crate::models::{
    CaptureFilterRule, HostListBackendSyncConfig, HostListFilterMode, SessionSummary, TlsBypassRule,
};

use super::{
    CompiledBackendHostList, CompiledCaptureCondition, CompiledCaptureHostList,
    CompiledCaptureMatrix, ConnectTunnelDecision, PassthroughReason,
};
#[cfg(test)]
use super::{CompiledHostToken, CompiledUrlScope};

pub(crate) fn strip_regex_prefix(s: &str) -> Option<&str> {
    if s.is_char_boundary(6) && s.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("regex:")) {
        s.get(6..)
    } else {
        None
    }
}

pub(super) fn normalize_clean_host(raw: &str) -> String {
    let trimmed = raw
        .trim()
        .trim_matches(['[', ']'])
        .trim_end_matches('.');
    if let Ok(ip) = trimmed.parse::<std::net::IpAddr>() {
        ip.to_string()
    } else {
        trimmed.to_ascii_lowercase()
    }
}

pub(super) fn extract_host_from_url_or_authority(raw: &str) -> String {
    let mut lower = raw.trim().to_ascii_lowercase();
    for scheme in ["https://", "http://", "wss://", "ws://"] {
        if let Some(after_scheme) = lower.strip_prefix(scheme) {
            lower = after_scheme.to_string();
            break;
        }
    }
    if let Some(idx) = lower.find(['/', '?', '#']) {
        lower.truncate(idx);
    }
    let (host_pat, _) = split_authority_pattern(&lower);
    normalize_clean_host(host_pat)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum NormalizedHostPattern {
    Regex(String),
    HostPort { host: String, port: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NormalizedHostToken {
    pub(super) negated: bool,
    pub(super) pattern: NormalizedHostPattern,
}

pub(super) fn normalize_host_token(raw: &str) -> Option<NormalizedHostToken> {
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
    if let Some(regex_body) = strip_regex_prefix(rest) {
        let expr = regex_body.trim();
        if expr.is_empty() {
            return None;
        }
        return Some(NormalizedHostToken {
            negated,
            pattern: NormalizedHostPattern::Regex(expr.to_string()),
        });
    }

    let mut lower = rest.to_ascii_lowercase();
    for scheme in ["https://", "http://", "wss://", "ws://"] {
        if let Some(after_scheme) = lower.strip_prefix(scheme) {
            lower = after_scheme.to_string();
            break;
        }
    }
    if let Some(idx) = lower.find(['/', '#']) {
        lower.truncate(idx);
    }
    let (host_raw, port_raw) = split_authority_pattern(&lower);
    let host = normalize_clean_host(host_raw);
    if host.is_empty() {
        None
    } else {
        Some(NormalizedHostToken {
            negated,
            pattern: NormalizedHostPattern::HostPort {
                host,
                port: port_raw.map(str::to_string),
            },
        })
    }
}

#[cfg(test)]
pub(super) fn url_scope_matches(url_lower: &str, raw_url: &str, pattern: &str) -> bool {
    let mut cached = Some(url_lower.to_string());
    CompiledUrlScope::compile(pattern).matches(&mut cached, raw_url)
}

#[cfg(test)]
pub(super) fn wildcard_or_regex_matches(subject: &str, token: &str) -> bool {
    let Some(norm) = normalize_host_token(token) else {
        return false;
    };
    let (host_clean, port, host_port) = if let Ok(sock) = subject.parse::<std::net::SocketAddr>() {
        (
            sock.ip().to_string(),
            sock.port(),
            format!("{}:{}", sock.ip(), sock.port()),
        )
    } else {
        let (h_raw, p_opt) = split_authority_pattern(subject);
        let h_clean = normalize_clean_host(h_raw);
        let port = p_opt.and_then(|p| p.parse::<u16>().ok()).unwrap_or(443);
        (h_clean, port, subject.to_string())
    };
    CompiledHostToken::compile(&norm.pattern).matches(&host_clean, port, &host_port)
}

pub(super) fn compile_glob_regex(glob: &str) -> Option<Regex> {
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
    Regex::new(&regex_str).ok()
}

pub(super) fn strip_inline_comment(line: &str) -> &str {
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

        if strip_regex_prefix(trimmed).is_some() {
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
            if !in_regex_segment && strip_regex_prefix(curr_trimmed).is_some() {
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

pub(super) fn split_authority_pattern(authority: &str) -> (&str, Option<&str>) {
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

pub(super) fn glob_segment_to_regex_src(glob: &str, star_char_class: &str) -> String {
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

pub(super) fn compile_host_pattern_src(host_pat: &str) -> String {
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

pub(super) fn build_combined_regex(sources: &[String]) -> Option<Regex> {
    if sources.is_empty() {
        return None;
    }
    let pattern = format!("^(?i)(?:{})$", sources.join("|"));
    Regex::new(&pattern).ok()
}

pub(super) fn compile_backend_host_list(sync: &HostListBackendSyncConfig) -> CompiledBackendHostList {
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
        if let Some(regex_body) = strip_regex_prefix(&token) {
            let expr = regex_body.trim();
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

        let (raw_host_pat, port_pat) = split_authority_pattern(authority_raw);
        if raw_host_pat.is_empty() || raw_host_pat == "." {
            continue;
        }
        let host_pat_canon = raw_host_pat
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| raw_host_pat.to_string());
        let host_pat = host_pat_canon.as_str();

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
        let host_has_wildcard =
            host_pat.contains('*') || host_pat.contains('?') || host_pat.starts_with('.');
        let port_has_wildcard =
            port_pat.is_some_and(|p| p.contains('*') || p.contains('?'));

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

pub(super) fn matches_wildcard_domain_set(hostname_lower: &str, domain_set: &HashSet<String>) -> bool {
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

pub(super) fn matches_any_user_regex(
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

pub(super) fn evaluate_compiled_host_list_connect(
    compiled: &CompiledBackendHostList,
    host_lower: &str,
    port: u16,
) -> Option<ConnectTunnelDecision> {
    if !compiled.enabled || compiled.active_count == 0 {
        return None;
    }

    let host_port = format!("{host_lower}:{port}");
    let url_host = if host_lower.contains(':') && !host_lower.starts_with('[') {
        format!("[{host_lower}]")
    } else {
        host_lower.to_string()
    };
    let synthetic_url = if port == 443 {
        format!("https://{url_host}/")
    } else {
        format!("https://{url_host}:{port}/")
    };
    let synthetic_url_with_port = format!("https://{url_host}:{port}/");

    match compiled.mode {
        HostListFilterMode::Whitelist => {
            if compiled.matches_everything || compiled.has_universal_host_rule {
                return None;
            }
            let matched = compiled.whitelist_hosts.contains(host_lower)
                || compiled.whitelist_host_ports.contains(&host_port)
                || matches_wildcard_domain_set(host_lower, &compiled.whitelist_wildcards)
                || compiled.whitelist_glob_regex.as_ref().is_some_and(|re| {
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
                || compiled.blacklist_glob_regex.as_ref().is_some_and(|re| {
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


pub(super) fn extract_clean_hostname(raw_host: &str) -> String {
    extract_host_from_url_or_authority(raw_host)
}

pub(super) fn extract_session_port(summary: &SessionSummary) -> u16 {
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

pub(super) fn is_background_os_noise(summary: &SessionSummary, host_clean: &str) -> bool {
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

pub(super) fn compile_capture_host_list(sync: &HostListBackendSyncConfig) -> CompiledCaptureHostList {
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
        if let Some(regex_body) = strip_regex_prefix(&token) {
            let expr = regex_body.trim();
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
        let (raw_host_pat, port_pat) = split_authority_pattern(authority_raw);
        if raw_host_pat.is_empty() || raw_host_pat == "." {
            continue;
        }
        let host_pat_canon = raw_host_pat
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| raw_host_pat.to_string());
        let host_pat = host_pat_canon.as_str();

        out.active_count += 1;

        let is_whole_host_path = matches!(path_raw, None | Some("/") | Some("/*"));
        let host_has_wildcard =
            host_pat.contains('*') || host_pat.contains('?') || host_pat.starts_with('.');
        let port_has_wildcard = port_pat.is_some_and(|p| p.contains('*') || p.contains('?'));

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

pub(super) fn matches_compiled_capture_host_list(
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
            .is_some_and(|re| re.is_match(host_clean))
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
        .is_some_and(|re| re.is_match(&host_port))
    {
        return true;
    }

    if compiled
        .path_only_regex
        .as_ref()
        .is_some_and(|re| re.is_match(url_path))
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

pub(super) fn parse_threshold_number(raw: &str, field: &str) -> Option<f64> {
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

pub(super) fn build_capture_dnf_groups(
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

pub(super) fn compile_capture_matrix(rules: &[CaptureFilterRule]) -> CompiledCaptureMatrix {
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

pub(super) fn extract_summary_field_str(s: &SessionSummary, field: &str) -> String {
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

pub(super) fn extract_summary_field_num(s: &SessionSummary, field: &str) -> Option<f64> {
    match field {
        "status" => Some(s.status as f64),
        "bodySize" => Some(s.body_size as f64),
        "durationMs" => Some(s.duration_ms as f64),
        "processPid" => s.process_pid.map(|p| p as f64),
        _ => extract_summary_field_str(s, field).parse::<f64>().ok(),
    }
}

pub(super) fn is_response_dependent_capture_field(field: &str) -> bool {
    matches!(field, "status" | "contentType" | "bodySize" | "durationMs")
}

pub(super) fn eval_capture_condition(
    s: &SessionSummary,
    cond: &CompiledCaptureCondition,
    is_in_flight: bool,
    is_exclude: bool,
) -> bool {
    if is_in_flight && is_response_dependent_capture_field(&cond.rule.field) {
        // In Phase 1 (in-flight, status == 0), response fields are not yet known:
        // - Inside exclude groups: return false so we don't prematurely drop the request.
        // - Inside include groups: return true so we allow the in-flight request until Phase 2 re-evaluates.
        return !is_exclude;
    }

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
            .is_some_and(|re| re.is_match(&raw_text));
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

pub(super) fn eval_capture_dnf_groups(
    s: &SessionSummary,
    groups: &[Vec<CompiledCaptureCondition>],
    is_in_flight: bool,
    is_exclude: bool,
) -> bool {
    for conjunction in groups {
        if conjunction
            .iter()
            .all(|c| eval_capture_condition(s, c, is_in_flight, is_exclude))
        {
            return true;
        }
    }
    false
}

