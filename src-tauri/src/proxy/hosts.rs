use std::net::{IpAddr, SocketAddr};
use std::sync::RwLock;

use regex::Regex;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};

use crate::models::ProxyError;

pub use crate::models::HostRemapRule;

fn strip_scheme_and_path(raw: &str) -> &str {
    let mut s = raw.trim();
    for scheme in ["https://", "http://", "wss://", "ws://"] {
        if s.len() >= scheme.len() && s[..scheme.len()].eq_ignore_ascii_case(scheme) {
            s = &s[scheme.len()..];
            break;
        }
    }
    if let Some((authority, _)) = s.split_once('/') {
        authority
    } else {
        s
    }
}

fn strip_optional_port(authority: &str) -> &str {
    let trimmed = authority.trim();
    if let Some(after_open) = trimmed.strip_prefix('[') {
        if let Some(close_idx) = after_open.find(']') {
            return &after_open[..close_idx];
        }
    }
    if trimmed.matches(':').count() == 1 {
        if let Some((host_part, port_part)) = trimmed.split_once(':') {
            if !port_part.is_empty() && port_part.chars().all(|c| c.is_ascii_digit()) {
                return host_part;
            }
        }
    }
    trimmed
}

/// Normalizes a source host mask (`api.prod.example.com`, `*.staging.local`, `api-*.corp.net`)
/// and validates syntax so empty or catch-all `*` rules are rejected upfront.
pub fn normalize_source_pattern(raw: &str) -> Result<String, ProxyError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ProxyError::Custom(
            "Исходный домен или маска не может быть пустой.".into(),
        ));
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(ProxyError::Custom(
            "Исходный домен не должен содержать пробелы или управляющие символы.".into(),
        ));
    }

    let without_scheme = strip_scheme_and_path(trimmed);
    let host_only = strip_optional_port(without_scheme)
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();

    if host_only.is_empty() {
        return Err(ProxyError::Custom(
            "Не удалось определить имя хоста из исходной маски.".into(),
        ));
    }
    if host_only == "*" || host_only == "*." {
        return Err(ProxyError::Custom(
            "Укажите конкретный домен или маску (например, *.example.com) вместо '*'.".into(),
        ));
    }

    if let Some(suffix) = host_only.strip_prefix("*.") {
        if suffix.is_empty() || suffix.starts_with('.') || suffix.contains("..") {
            return Err(ProxyError::Custom(format!(
                "Некорректная wildcard-маска '{raw}'. Ожидается формат *.domain.com."
            )));
        }
    } else if host_only.starts_with('.') || host_only.contains("..") {
        return Err(ProxyError::Custom(format!(
            "Некорректное имя домена '{raw}'."
        )));
    }

    Ok(host_only)
}

/// Normalizes a target host / IP (`127.0.0.1`, `localhost`, `staging.internal`, `[::1]`).
pub fn normalize_target_host(raw: &str) -> Result<String, ProxyError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ProxyError::Custom(
            "Целевой хост или IP не может быть пустым.".into(),
        ));
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(ProxyError::Custom(
            "Целевой хост не должен содержать пробелы или управляющие символы.".into(),
        ));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains('?') || trimmed.contains('#') {
        return Err(ProxyError::Custom(
            "Целевой хост не должен содержать путь или символы '/', '\\', '?', '#'.".into(),
        ));
    }

    let mut clean = trimmed;
    for scheme in ["https://", "http://", "wss://", "ws://"] {
        if clean.len() >= scheme.len() && clean[..scheme.len()].eq_ignore_ascii_case(scheme) {
            clean = &clean[scheme.len()..];
            break;
        }
    }
    let clean = clean.trim_matches(['[', ']']).trim_end_matches('.');
    if clean.is_empty() {
        return Err(ProxyError::Custom(
            "Целевой хост или IP не может быть пустым.".into(),
        ));
    }

    // Reject accidental `host:port` embedded in target_host (unless valid IPv6 literal)
    if clean.parse::<IpAddr>().is_err() && clean.contains(':') {
        return Err(ProxyError::Custom(
            "Укажите порт в отдельном поле Target Port, а не в Target Host.".into(),
        ));
    }

    Ok(clean.to_ascii_lowercase())
}

pub fn normalize_host_for_match(host: &str) -> String {
    let without_scheme = strip_scheme_and_path(host);
    strip_optional_port(without_scheme)
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

fn compile_glob_regex(pattern: &str) -> Option<Regex> {
    let mut expr = String::with_capacity(pattern.len() * 2 + 6);
    expr.push_str("(?i)^");
    for ch in pattern.chars() {
        match ch {
            '*' => expr.push_str(".*"),
            '?' => expr.push('.'),
            other => expr.push_str(&regex::escape(&other.to_string())),
        }
    }
    expr.push('$');
    Regex::new(&expr).ok()
}

/// Matches a normalized `source_pattern` against an incoming target host.
/// `*.domain.com` strictly matches subdomains (e.g., `api.domain.com`),
/// NOT the apex `domain.com` and NOT `evildomain.com`.
pub fn source_pattern_matches_host(pattern: &str, host: &str) -> bool {
    let norm_host = normalize_host_for_match(host);
    if norm_host.is_empty() {
        return false;
    }

    let norm_pattern = pattern
        .trim()
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if norm_pattern.is_empty() {
        return false;
    }

    if !norm_pattern.contains('*') && !norm_pattern.contains('?') {
        return norm_host == norm_pattern;
    }

    if let Some(suffix) = norm_pattern.strip_prefix("*.") {
        if !suffix.is_empty() && !suffix.contains('*') && !suffix.contains('?') {
            if norm_host.len() <= suffix.len() + 1 {
                return false;
            }
            let Some(prefix_len) = norm_host.len().checked_sub(suffix.len()) else {
                return false;
            };
            return norm_host.ends_with(suffix)
                && norm_host.as_bytes().get(prefix_len - 1) == Some(&b'.');
        }
    }

    compile_glob_regex(&norm_pattern).is_some_and(|re| re.is_match(&norm_host))
}

#[derive(Debug, Clone)]
struct CompiledHostRemapRule {
    rule: HostRemapRule,
    /// Precompiled glob regex for patterns containing `*`/`?` other than simple `*.suffix`.
    glob_regex: Option<Regex>,
    /// Precomputed `(tier, len)` specificity rank.
    specificity: (u8, usize),
}

impl CompiledHostRemapRule {
    fn compile(rule: HostRemapRule) -> Self {
        let pat = rule
            .source_pattern
            .trim()
            .trim_matches(['[', ']'])
            .trim_end_matches('.');
        let (glob_regex, specificity) = if !pat.contains('*') && !pat.contains('?') {
            (None, (2, pat.len()))
        } else if let Some(suffix) = pat.strip_prefix("*.") {
            if !suffix.is_empty() && !suffix.contains('*') && !suffix.contains('?') {
                (None, (1, suffix.len()))
            } else {
                (compile_glob_regex(pat), (0, pat.len()))
            }
        } else {
            (compile_glob_regex(pat), (0, pat.len()))
        };
        Self {
            rule,
            glob_regex,
            specificity,
        }
    }

    fn matches_normalized(&self, norm_host: &str) -> bool {
        if norm_host.is_empty() {
            return false;
        }
        let pat = self.rule.source_pattern.as_str();
        if pat.is_empty() {
            return false;
        }
        if !pat.contains('*') && !pat.contains('?') {
            return norm_host == pat;
        }
        if let Some(suffix) = pat.strip_prefix("*.") {
            if !suffix.is_empty() && !suffix.contains('*') && !suffix.contains('?') {
                if norm_host.len() <= suffix.len() + 1 {
                    return false;
                }
                let Some(prefix_len) = norm_host.len().checked_sub(suffix.len()) else {
                    return false;
                };
                return norm_host.ends_with(suffix)
                    && norm_host.as_bytes().get(prefix_len - 1) == Some(&b'.');
            }
        }
        self.glob_regex
            .as_ref()
            .is_some_and(|re| re.is_match(norm_host))
    }
}

/// Thread-safe Virtual DNS / HOSTS Remapping registry.
/// Implements `reqwest::dns::Resolve` so HTTP and HTTPS requests preserve original
/// `Host` header & TLS SNI while opening TCP connections to the remapped target IP/port.
#[derive(Debug, Default)]
pub struct HostRemapRegistry {
    rules: RwLock<Vec<CompiledHostRemapRule>>,
}

impl HostRemapRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list_rules(&self) -> Vec<HostRemapRule> {
        self.rules
            .read()
            .map(|g| g.iter().map(|c| c.rule.clone()).collect())
            .unwrap_or_default()
    }

    pub fn set_rules(&self, rules: Vec<HostRemapRule>) -> Result<Vec<HostRemapRule>, ProxyError> {
        let mut normalized = Vec::with_capacity(rules.len());
        let mut compiled = Vec::with_capacity(rules.len());
        for (idx, rule) in rules.into_iter().enumerate() {
            let source_pattern = normalize_source_pattern(&rule.source_pattern)?;
            let target_host = normalize_target_host(&rule.target_host)?;
            if matches!(rule.target_port, Some(0)) {
                return Err(ProxyError::Custom(
                    "Целевой порт (Target Port) должен быть в диапазоне 1..65535.".into(),
                ));
            }
            let id = {
                let trimmed = rule.id.trim();
                if trimmed.is_empty() {
                    format!("remap-{}", idx + 1)
                } else {
                    trimmed.to_string()
                }
            };
            let normalized_rule = HostRemapRule {
                id,
                enabled: rule.enabled,
                source_pattern,
                target_host,
                target_port: rule.target_port,
                preserve_host_header: rule.preserve_host_header,
                comment: rule.comment.trim().to_string(),
            };
            compiled.push(CompiledHostRemapRule::compile(normalized_rule.clone()));
            normalized.push(normalized_rule);
        }

        let mut guard = self.rules.write().map_err(|_| {
            ProxyError::Custom("Ошибка блокировки реестра HOSTS Remapping.".into())
        })?;
        *guard = compiled;
        Ok(normalized)
    }

    /// Returns the highest-specificity enabled rule matching `host`.
    pub fn match_host(&self, host: &str) -> Option<HostRemapRule> {
        let norm_host = normalize_host_for_match(host);
        if norm_host.is_empty() {
            return None;
        }
        let guard = self.rules.read().ok()?;
        let mut best: Option<((u8, usize), &HostRemapRule)> = None;
        for compiled in guard.iter() {
            if !compiled.rule.enabled {
                continue;
            }
            if compiled.matches_normalized(&norm_host) {
                let rank = compiled.specificity;
                if best.as_ref().map(|(best_rank, _)| rank > *best_rank).unwrap_or(true) {
                    best = Some((rank, &compiled.rule));
                }
            }
        }
        best.map(|(_, r)| r.clone())
    }

    /// Resolves a `CONNECT host:port` passthrough destination when a HOSTS remap matches.
    pub fn resolve_connect_target(
        &self,
        host: &str,
        original_port: u16,
    ) -> Option<(String, u16, HostRemapRule)> {
        let rule = self.match_host(host)?;
        let port = rule.target_port.unwrap_or(original_port);
        Some((rule.target_host.clone(), port, rule))
    }

    pub fn format_host_for_authority(host: &str) -> String {
        let clean = host.trim_matches(['[', ']']);
        if clean.contains(':') {
            format!("[{clean}]")
        } else {
            clean.to_string()
        }
    }

    pub fn format_remap_target(rule: &HostRemapRule, effective_port: Option<u16>) -> String {
        let h = Self::format_host_for_authority(&rule.target_host);
        match effective_port {
            Some(p) => format!("{h}:{p}"),
            None => h,
        }
    }
}

impl Resolve for HostRemapRegistry {
    fn resolve(&self, name: Name) -> Resolving {
        let host_str = name.as_str().to_string();
        let matched = self.match_host(&host_str);

        Box::pin(async move {
            if let Some(rule) = matched {
                // `port == 0` tells `hyper_util::client::legacy::connect::HttpConnector` to use the
                // URL's default/explicit port, whereas a non-zero `target_port` overrides it when
                // the upstream URL has no explicit port.
                let port = rule.target_port.unwrap_or(0);
                let target_clean = rule.target_host.trim_matches(['[', ']']);

                if let Ok(ip) = target_clean.parse::<IpAddr>() {
                    let addrs: Addrs = Box::new(std::iter::once(SocketAddr::new(ip, port)));
                    return Ok(addrs);
                }

                let resolved: Vec<SocketAddr> = tokio::net::lookup_host((target_clean, port))
                    .await?
                    .collect();
                if resolved.is_empty() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::AddrNotAvailable,
                        format!(
                            "No addresses resolved for remapped host '{}'",
                            rule.target_host
                        ),
                    )
                    .into());
                }
                let addrs: Addrs = Box::new(resolved.into_iter());
                return Ok(addrs);
            }

            let clean = host_str.trim_matches(['[', ']']);
            let resolved: Vec<SocketAddr> = tokio::net::lookup_host((clean, 0u16))
                .await?
                .collect();
            let addrs: Addrs = Box::new(resolved.into_iter());
            Ok(addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn sample_rule(id: &str, source: &str, target: &str, port: Option<u16>) -> HostRemapRule {
        HostRemapRule {
            id: id.to_string(),
            enabled: true,
            source_pattern: source.to_string(),
            target_host: target.to_string(),
            target_port: port,
            preserve_host_header: true,
            comment: String::new(),
        }
    }

    #[test]
    fn matches_exact_wildcard_and_glob_with_specificity_precedence() {
        let registry = HostRemapRegistry::new();
        registry
            .set_rules(vec![
                sample_rule("glob", "api-*.example.com", "10.0.0.3", Some(8083)),
                sample_rule("wild", "*.example.com", "10.0.0.2", Some(8082)),
                sample_rule("exact", "api.example.com", "10.0.0.1", Some(8081)),
                HostRemapRule {
                    enabled: false,
                    ..sample_rule("disabled", "disabled.other.invalid", "10.0.0.9", None)
                },
            ])
            .unwrap();

        assert_eq!(
            registry.match_host("API.Example.COM:443").unwrap().id,
            "exact"
        );
        assert_eq!(
            registry.match_host("v2.api.example.com").unwrap().id,
            "wild"
        );
        // Apex domain and evil suffix should not match `*.example.com`
        assert!(registry.match_host("example.com").is_none());
        assert!(registry.match_host("evilexample.com").is_none());
        assert_eq!(
            registry.match_host("disabled.example.com").unwrap().id,
            "wild"
        );
        assert!(registry.match_host("disabled.other.invalid").is_none());

        // `*.example.com` has higher specificity (1, 11) than glob `api-*.example.com` (0, 17)
        assert_eq!(
            registry.match_host("api-dev.example.com").unwrap().id,
            "wild"
        );

        let registry_glob = HostRemapRegistry::new();
        registry_glob
            .set_rules(vec![sample_rule(
                "glob",
                "api-*.corp.local",
                "127.0.0.1",
                Some(9000),
            )])
            .unwrap();
        assert_eq!(
            registry_glob.match_host("api-staging.corp.local").unwrap().id,
            "glob"
        );
    }

    #[test]
    fn validates_invalid_rules_cleanly() {
        let registry = HostRemapRegistry::new();
        assert!(registry
            .set_rules(vec![sample_rule("1", "*", "127.0.0.1", None)])
            .is_err());
        assert!(registry
            .set_rules(vec![sample_rule("1", "api.test", "", None)])
            .is_err());
        assert!(registry
            .set_rules(vec![sample_rule("1", "api.test", "127.0.0.1:8080", None)])
            .is_err());
        assert!(registry
            .set_rules(vec![sample_rule("1", "api.test", "127.0.0.1", Some(0))])
            .is_err());
    }

    #[tokio::test]
    async fn reqwest_resolve_returns_remapped_ip_and_port() {
        let registry = HostRemapRegistry::new();
        registry
            .set_rules(vec![
                sample_rule("r1", "api.virtual.invalid", "127.0.0.1", Some(18443)),
                sample_rule("r2", "default-port.virtual.invalid", "127.0.0.1", None),
            ])
            .unwrap();

        let addrs1: Vec<SocketAddr> = registry
            .resolve(Name::from_str("api.virtual.invalid").unwrap())
            .await
            .unwrap()
            .collect();
        assert_eq!(addrs1, vec!["127.0.0.1:18443".parse().unwrap()]);

        let addrs2: Vec<SocketAddr> = registry
            .resolve(Name::from_str("default-port.virtual.invalid").unwrap())
            .await
            .unwrap()
            .collect();
        assert_eq!(addrs2, vec!["127.0.0.1:0".parse().unwrap()]);

        let fallback_addrs: Vec<SocketAddr> = registry
            .resolve(Name::from_str("localhost").unwrap())
            .await
            .unwrap()
            .collect();
        assert!(!fallback_addrs.is_empty());
    }

    #[test]
    fn precompiled_glob_and_wildcard_matching_and_rule_replacement() {
        let registry = HostRemapRegistry::new();
        registry
            .set_rules(vec![
                sample_rule("glob-q", "api-?.corp.local", "10.0.1.1", Some(8001)),
                sample_rule("glob-star", "edge-*.corp.local", "10.0.1.2", Some(8002)),
                sample_rule("wild", "*.svc.corp.local", "10.0.1.3", Some(8003)),
            ])
            .unwrap();

        assert_eq!(registry.match_host("API-7.CORP.LOCAL").unwrap().id, "glob-q");
        assert!(registry.match_host("api-12.corp.local").is_none());
        assert_eq!(
            registry.match_host("edge-eu-west.corp.local:8443").unwrap().id,
            "glob-star"
        );
        assert_eq!(
            registry.match_host("pay.svc.corp.local").unwrap().id,
            "wild"
        );

        // Replacing rules via `set_rules` compiles new rules and drops old ones.
        registry
            .set_rules(vec![sample_rule(
                "new-glob",
                "svc-*-v2.corp.local",
                "127.0.0.1",
                Some(9001),
            )])
            .unwrap();
        assert!(registry.match_host("api-7.corp.local").is_none());
        assert_eq!(
            registry.match_host("svc-auth-v2.corp.local").unwrap().id,
            "new-glob"
        );
    }
}
