use std::collections::HashSet;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use base64::Engine as _;
use regex::Regex;
use rustls_pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

use crate::models::ProxyError;
use crate::proxy::upstream_client::{default_root_store, elapsed_ms};

pub use crate::models::{UpstreamProxyConfig, UpstreamProxyProtocol};

const MAX_HTTP_CONNECT_RESPONSE_BYTES: usize = 16 * 1024;

/// Splits a comma/semicolon/whitespace/newline-separated bypass string into normalized tokens.
pub fn parse_bypass_list(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for token in raw.split(|c: char| c == ',' || c == ';' || c.is_whitespace()) {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
    }
    out
}

/// Flattens and deduplicates bypass entries while preserving rule order.
pub fn normalize_bypass_list(items: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        for token in parse_bypass_list(item) {
            let key = token.to_ascii_lowercase();
            if seen.insert(key) {
                out.push(token);
            }
        }
    }
    out
}

#[derive(Debug, Clone)]
enum UpstreamBypassRule {
    Any,
    Local,
    Localhost {
        port: Option<u16>,
    },
    Ipv4Cidr {
        net: Ipv4Addr,
        prefix: u8,
        port: Option<u16>,
    },
    Ipv6Cidr {
        net: Ipv6Addr,
        prefix: u8,
        port: Option<u16>,
    },
    ExactIp {
        ip: IpAddr,
        port: Option<u16>,
    },
    ExactHost {
        host: String,
        port: Option<u16>,
    },
    SubdomainWildcard {
        suffix: String,
        port: Option<u16>,
    },
    DotSuffix {
        suffix: String,
        port: Option<u16>,
    },
    Glob {
        regex: Regex,
        port: Option<u16>,
    },
}

fn split_host_and_optional_port(raw: &str) -> Result<(&str, Option<u16>), ()> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(());
    }
    if let Some(after_open) = trimmed.strip_prefix('[') {
        let Some(close_idx) = after_open.find(']') else {
            return Err(());
        };
        let host_part = &after_open[..close_idx];
        let rest = after_open[close_idx + 1..].trim();
        if rest.is_empty() {
            return Ok((host_part, None));
        }
        if let Some(port_str) = rest.strip_prefix(':') {
            let port = port_str.parse::<u16>().map_err(|_| ())?;
            if port == 0 {
                return Err(());
            }
            return Ok((host_part, Some(port)));
        }
        return Err(());
    }

    if trimmed.matches(':').count() == 1 {
        if let Some((host_part, port_str)) = trimmed.split_once(':') {
            if !port_str.is_empty() && port_str.chars().all(|c| c.is_ascii_digit()) {
                let port = port_str.parse::<u16>().map_err(|_| ())?;
                if port == 0 {
                    return Err(());
                }
                return Ok((host_part, Some(port)));
            }
        }
    }

    Ok((trimmed, None))
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

fn compile_bypass_rule(raw: &str) -> Option<UpstreamBypassRule> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "*" {
        return Some(UpstreamBypassRule::Any);
    }
    if trimmed.eq_ignore_ascii_case("<local>") {
        return Some(UpstreamBypassRule::Local);
    }

    let (host_raw, port) = split_host_and_optional_port(trimmed).ok()?;
    let host_clean = host_raw
        .trim()
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host_clean.is_empty() {
        return None;
    }
    if host_clean == "*" && port.is_none() {
        return Some(UpstreamBypassRule::Any);
    }
    if host_clean == "localhost" {
        return Some(UpstreamBypassRule::Localhost { port });
    }

    if let Some((ip_str, prefix_str)) = host_clean.split_once('/') {
        let prefix = prefix_str.parse::<u8>().ok()?;
        if let Ok(v4) = ip_str.parse::<Ipv4Addr>() {
            if prefix > 32 {
                return None;
            }
            let mask = if prefix == 0 {
                0u32
            } else {
                !0u32 << (32 - prefix)
            };
            let net = Ipv4Addr::from(u32::from(v4) & mask);
            return Some(UpstreamBypassRule::Ipv4Cidr { net, prefix, port });
        }
        if let Ok(v6) = ip_str.parse::<Ipv6Addr>() {
            if prefix > 128 {
                return None;
            }
            let mask = if prefix == 0 {
                0u128
            } else {
                !0u128 << (128 - prefix)
            };
            let net = Ipv6Addr::from(u128::from(v6) & mask);
            return Some(UpstreamBypassRule::Ipv6Cidr { net, prefix, port });
        }
        return None;
    }

    if host_clean.contains('*') || host_clean.contains('?') {
        if let Some(suffix) = host_clean.strip_prefix("*.") {
            if !suffix.is_empty() && !suffix.contains('*') && !suffix.contains('?') {
                return Some(UpstreamBypassRule::SubdomainWildcard {
                    suffix: suffix.to_string(),
                    port,
                });
            }
        }
        let regex = compile_glob_regex(&host_clean)?;
        return Some(UpstreamBypassRule::Glob { regex, port });
    }

    if let Some(suffix) = host_clean.strip_prefix('.') {
        if suffix.is_empty() || suffix.starts_with('.') {
            return None;
        }
        return Some(UpstreamBypassRule::DotSuffix {
            suffix: suffix.to_string(),
            port,
        });
    }

    if let Ok(ip) = host_clean.parse::<IpAddr>() {
        return Some(UpstreamBypassRule::ExactIp { ip, port });
    }

    Some(UpstreamBypassRule::ExactHost {
        host: host_clean,
        port,
    })
}

fn ip_to_effective_v4(ip: IpAddr) -> Option<Ipv4Addr> {
    match ip {
        IpAddr::V4(v4) => Some(v4),
        IpAddr::V6(v6) => v6.to_ipv4_mapped(),
    }
}

fn is_loopback_ip_addr(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
}

fn ips_equivalent(a: IpAddr, b: IpAddr) -> bool {
    if a == b {
        return true;
    }
    match (ip_to_effective_v4(a), ip_to_effective_v4(b)) {
        (Some(va), Some(vb)) => va == vb,
        _ => false,
    }
}

fn matches_subdomain_only(norm_host: &str, suffix: &str) -> bool {
    if norm_host.len() <= suffix.len() + 1 || !norm_host.ends_with(suffix) {
        return false;
    }
    let prefix_len = norm_host.len() - suffix.len();
    norm_host.as_bytes().get(prefix_len - 1) == Some(&b'.')
}

/// Precompiled matcher for upstream proxy `bypass_list` rules (`localhost`, `<local>`,
/// IPv4/IPv6 CIDR, `*.corp.local` subdomain wildcards, `.corp.local` suffix masks, globs).
#[derive(Debug, Default, Clone)]
pub struct UpstreamBypassMatcher {
    rules: Vec<UpstreamBypassRule>,
}

impl UpstreamBypassMatcher {
    pub fn from_rules(raw_rules: &[String]) -> Self {
        let mut compiled = Vec::new();
        for item in raw_rules {
            for token in parse_bypass_list(item) {
                if let Some(rule) = compile_bypass_rule(&token) {
                    compiled.push(rule);
                }
            }
        }
        Self { rules: compiled }
    }

    pub fn parse(raw: &str) -> Self {
        Self::from_rules(&parse_bypass_list(raw))
    }

    pub fn should_bypass(&self, host: &str, port: Option<u16>) -> bool {
        if self.rules.is_empty() {
            return false;
        }
        let Ok((parsed_host, parsed_port)) = split_host_and_optional_port(host) else {
            return false;
        };
        let eff_port = port.or(parsed_port);
        let norm_host = parsed_host
            .trim()
            .trim_matches(['[', ']'])
            .trim_end_matches('.')
            .to_ascii_lowercase();
        if norm_host.is_empty() {
            return false;
        }
        let target_ip = norm_host.parse::<IpAddr>().ok();
        let target_v4 = target_ip.and_then(ip_to_effective_v4);

        for rule in &self.rules {
            let port_ok = |rule_port: Option<u16>| -> bool {
                match (rule_port, eff_port) {
                    (Some(rp), Some(tp)) => rp == tp,
                    (Some(_), None) => false,
                    (None, _) => true,
                }
            };

            let matched = match rule {
                UpstreamBypassRule::Any => true,
                UpstreamBypassRule::Local => match target_ip {
                    Some(ip) => is_loopback_ip_addr(ip),
                    None => !norm_host.contains('.'),
                },
                UpstreamBypassRule::Localhost { port: rp } => {
                    port_ok(*rp)
                        && (norm_host == "localhost"
                            || matches_subdomain_only(&norm_host, "localhost"))
                }
                UpstreamBypassRule::Ipv4Cidr {
                    net,
                    prefix,
                    port: rp,
                } => {
                    port_ok(*rp)
                        && target_v4.is_some_and(|v4| {
                            let mask = if *prefix == 0 {
                                0u32
                            } else {
                                !0u32 << (32 - *prefix)
                            };
                            (u32::from(v4) & mask) == u32::from(*net)
                        })
                }
                UpstreamBypassRule::Ipv6Cidr {
                    net,
                    prefix,
                    port: rp,
                } => {
                    port_ok(*rp)
                        && matches!(target_ip, Some(IpAddr::V6(v6)) if {
                            let mask = if *prefix == 0 {
                                0u128
                            } else {
                                !0u128 << (128 - *prefix)
                            };
                            (u128::from(v6) & mask) == u128::from(*net)
                        })
                }
                UpstreamBypassRule::ExactIp { ip, port: rp } => {
                    port_ok(*rp) && target_ip.is_some_and(|tip| ips_equivalent(*ip, tip))
                }
                UpstreamBypassRule::ExactHost { host: h, port: rp } => {
                    port_ok(*rp) && norm_host == *h
                }
                UpstreamBypassRule::SubdomainWildcard { suffix, port: rp } => {
                    port_ok(*rp) && matches_subdomain_only(&norm_host, suffix)
                }
                UpstreamBypassRule::DotSuffix { suffix, port: rp } => {
                    port_ok(*rp)
                        && (norm_host == *suffix || matches_subdomain_only(&norm_host, suffix))
                }
                UpstreamBypassRule::Glob { regex, port: rp } => {
                    port_ok(*rp) && regex.is_match(&norm_host)
                }
            };

            if matched {
                return true;
            }
        }

        false
    }
}

fn validate_and_normalize_proxy_host(raw: &str, enabled: bool) -> Result<String, ProxyError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        if enabled {
            return Err(ProxyError::Custom(
                "Укажите хост или IP-адрес вышестоящего прокси.".into(),
            ));
        }
        return Ok(String::new());
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(ProxyError::Custom(
            "Адрес вышестоящего прокси не должен содержать пробелы или управляющие символы."
                .into(),
        ));
    }
    if trimmed.contains("://")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('?')
        || trimmed.contains('#')
    {
        return Err(ProxyError::Custom(
            "Укажите только имя хоста или IP вышестоящего прокси (без схемы, пути или параметров)."
                .into(),
        ));
    }

    let clean = trimmed.trim_matches(['[', ']']).trim_end_matches('.');
    if clean.is_empty() {
        return Err(ProxyError::Custom(
            "Некорректный хост вышестоящего прокси.".into(),
        ));
    }
    if clean.parse::<IpAddr>().is_err() && clean.contains(':') {
        return Err(ProxyError::Custom(
            "Укажите порт вышестоящего прокси в отдельном поле Port, а не в Host.".into(),
        ));
    }
    Ok(clean.to_string())
}

/// Thread-safe runtime store for Upstream Proxy Chaining configuration.
#[derive(Debug)]
pub struct UpstreamProxyManager {
    state: RwLock<(UpstreamProxyConfig, Arc<UpstreamBypassMatcher>)>,
}

impl Default for UpstreamProxyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl UpstreamProxyManager {
    pub fn new() -> Self {
        let cfg = UpstreamProxyConfig::default();
        let matcher = Arc::new(UpstreamBypassMatcher::from_rules(&cfg.bypass_list));
        Self {
            state: RwLock::new((cfg, matcher)),
        }
    }

    pub fn get_runtime_config(&self) -> UpstreamProxyConfig {
        self.state
            .read()
            .map(|g| g.0.clone())
            .unwrap_or_default()
    }

    pub fn get_public_config(&self) -> UpstreamProxyConfig {
        self.get_runtime_config().redacted_for_ipc()
    }

    pub fn set_config(
        &self,
        incoming: UpstreamProxyConfig,
    ) -> Result<UpstreamProxyConfig, ProxyError> {
        let host = validate_and_normalize_proxy_host(&incoming.host, incoming.enabled)?;
        let port = if incoming.port == 0 {
            if incoming.enabled {
                return Err(ProxyError::Custom(
                    "Порт вышестоящего прокси должен быть в диапазоне 1..65535.".into(),
                ));
            }
            8080
        } else {
            incoming.port
        };

        let username = incoming
            .username
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        if let Some(ref u) = username {
            if u.contains('\r') || u.contains('\n') || u.contains('\0') {
                return Err(ProxyError::Custom(
                    "Имя пользователя прокси содержит недопустимые управляющие символы.".into(),
                ));
            }
        }

        let existing_password = self
            .state
            .read()
            .ok()
            .and_then(|g| g.0.password.clone());

        let password = match incoming.password {
            Some(p) if !p.is_empty() => Some(p),
            Some(_) => None, // explicit empty string clears stored password
            None => {
                if incoming.has_password {
                    existing_password
                } else {
                    None
                }
            }
        };

        if let Some(ref p) = password {
            if p.contains('\r') || p.contains('\n') || p.contains('\0') {
                return Err(ProxyError::Custom(
                    "Пароль прокси содержит недопустимые управляющие символы.".into(),
                ));
            }
        }

        if incoming.protocol == UpstreamProxyProtocol::Socks5 {
            if username.as_ref().is_some_and(|u| u.len() > 255) {
                return Err(ProxyError::Custom(
                    "Имя пользователя SOCKS5 не может превышать 255 байт (RFC 1929).".into(),
                ));
            }
            if password.as_ref().is_some_and(|p| p.len() > 255) {
                return Err(ProxyError::Custom(
                    "Пароль SOCKS5 не может превышать 255 байт (RFC 1929).".into(),
                ));
            }
        }

        let bypass_list = normalize_bypass_list(&incoming.bypass_list);
        let has_password = password.as_deref().is_some_and(|p| !p.is_empty());
        let normalized = UpstreamProxyConfig {
            enabled: incoming.enabled,
            protocol: incoming.protocol,
            host,
            port,
            username,
            password,
            has_password,
            bypass_list,
        };
        let matcher = Arc::new(UpstreamBypassMatcher::from_rules(&normalized.bypass_list));

        let mut guard = self.state.write().map_err(|_| {
            ProxyError::Custom("Ошибка блокировки конфигурации Upstream Proxy.".into())
        })?;
        *guard = (normalized.clone(), matcher);
        Ok(normalized.redacted_for_ipc())
    }

    /// Resolves whether a connection to `(orig_host, orig_port)` (or its HOSTS-remapped target)
    /// should route through the configured upstream proxy, or bypass it directly (`None`).
    pub fn resolve_for_target(
        &self,
        orig_host: &str,
        orig_port: u16,
        remapped_host: Option<&str>,
        remapped_port: Option<u16>,
    ) -> Option<UpstreamProxyConfig> {
        let guard = self.state.read().ok()?;
        let (cfg, matcher) = &*guard;
        if !cfg.enabled || cfg.host.is_empty() {
            return None;
        }
        if matcher.should_bypass(orig_host, Some(orig_port)) {
            return None;
        }
        if let Some(rh) = remapped_host {
            if matcher.should_bypass(rh, remapped_port.or(Some(orig_port))) {
                return None;
            }
        }
        Some(cfg.clone())
    }
}

/// Formats `Basic <base64(user:pass)>` for `Proxy-Authorization` when credentials are configured.
pub fn proxy_authorization_header_value(cfg: &UpstreamProxyConfig) -> Option<String> {
    if !cfg.has_credentials() {
        return None;
    }
    let user = cfg.username.as_deref().unwrap_or("");
    let pass = cfg.password.as_deref().unwrap_or("");
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
    Some(format!("Basic {encoded}"))
}

pub fn format_authority(host: &str, port: u16) -> Result<String, String> {
    let trimmed = host.trim();
    if trimmed.is_empty()
        || trimmed.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(format!("Invalid authority host '{host}'"));
    }
    let clean = trimmed.trim_matches(['[', ']']);
    if clean.contains(':') {
        Ok(format!("[{clean}]:{port}"))
    } else {
        Ok(format!("{clean}:{port}"))
    }
}

pub enum UpstreamTransportStream {
    Tcp(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl UpstreamTransportStream {
    pub fn peer_addr(&self) -> io::Result<SocketAddr> {
        match self {
            Self::Tcp(s) => s.peer_addr(),
            Self::Tls(s) => s.get_ref().0.peer_addr(),
        }
    }
}

impl AsyncRead for UpstreamTransportStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match &mut *self {
            Self::Tcp(s) => Pin::new(s).poll_read(cx, buf),
            Self::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for UpstreamTransportStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match &mut *self {
            Self::Tcp(s) => Pin::new(s).poll_write(cx, buf),
            Self::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut *self {
            Self::Tcp(s) => Pin::new(s).poll_flush(cx),
            Self::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut *self {
            Self::Tcp(s) => Pin::new(s).poll_shutdown(cx),
            Self::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
}

pub struct UpstreamTunnelResult {
    pub stream: UpstreamTransportStream,
    pub proxy_addr: SocketAddr,
    pub dns_ms: f64,
    pub tcp_connect_ms: f64,
}

async fn connect_proxy_tcp(
    proxy_host: &str,
    proxy_port: u16,
    deadline: Instant,
) -> Result<(TcpStream, SocketAddr, f64, f64), String> {
    let clean_host = proxy_host.trim().trim_matches(['[', ']']);
    let (addrs, dns_ms): (Vec<SocketAddr>, f64) = if let Ok(ip) = clean_host.parse::<IpAddr>() {
        (vec![SocketAddr::new(ip, proxy_port)], 0.0)
    } else {
        let dns_start = Instant::now();
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "Upstream proxy DNS lookup timed out for {proxy_host}:{proxy_port}"
            ));
        }
        let resolved: Vec<SocketAddr> = tokio::time::timeout(
            remaining,
            tokio::net::lookup_host((clean_host, proxy_port)),
        )
        .await
        .map_err(|_| {
            format!("Upstream proxy DNS lookup timed out for {proxy_host}:{proxy_port}")
        })?
        .map_err(|e| {
            format!("Upstream proxy DNS lookup failed for {proxy_host}:{proxy_port}: {e}")
        })?
        .collect();
        if resolved.is_empty() {
            return Err(format!(
                "Upstream proxy DNS lookup returned no addresses for {proxy_host}:{proxy_port}"
            ));
        }
        (resolved, elapsed_ms(dns_start))
    };

    let tcp_start = Instant::now();
    let mut tcp_opt = None;
    let mut last_err = None;
    for addr in addrs {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            last_err = Some("timed out".to_string());
            break;
        }
        match tokio::time::timeout(remaining, TcpStream::connect(addr)).await {
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                tcp_opt = Some(stream);
                break;
            }
            Ok(Err(e)) => last_err = Some(format!("{addr}: {e}")),
            Err(_) => last_err = Some(format!("{addr}: timed out")),
        }
    }

    let tcp = tcp_opt.ok_or_else(|| {
        format!(
            "Failed to connect to upstream proxy {proxy_host}:{proxy_port}: {}",
            last_err.unwrap_or_else(|| "no reachable address".to_string())
        )
    })?;
    let tcp_connect_ms = elapsed_ms(tcp_start);
    let proxy_addr = tcp
        .peer_addr()
        .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], proxy_port)));
    Ok((tcp, proxy_addr, dns_ms, tcp_connect_ms))
}

async fn connect_proxy_transport(
    cfg: &UpstreamProxyConfig,
    deadline: Instant,
) -> Result<(UpstreamTransportStream, SocketAddr, f64, f64), String> {
    let (tcp, proxy_addr, dns_ms, tcp_connect_ms) =
        connect_proxy_tcp(&cfg.host, cfg.port, deadline).await?;

    if cfg.protocol != UpstreamProxyProtocol::Https {
        return Ok((
            UpstreamTransportStream::Tcp(tcp),
            proxy_addr,
            dns_ms,
            tcp_connect_ms,
        ));
    }

    let _ = rustls::crypto::ring::default_provider().install_default();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut tls_cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("Upstream HTTPS proxy TLS config error: {e}"))?
        .with_root_certificates(default_root_store())
        .with_no_client_auth();
    tls_cfg.alpn_protocols = vec![b"http/1.1".to_vec()];

    let sni = cfg.host.trim().trim_matches(['[', ']']).to_string();
    let server_name = ServerName::try_from(sni.clone()).map_err(|_| {
        format!("Invalid TLS ServerName for upstream HTTPS proxy '{sni}'")
    })?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(format!(
            "TLS handshake timed out for upstream HTTPS proxy {sni}:{}",
            cfg.port
        ));
    }
    let tls_stream = tokio::time::timeout(
        remaining,
        TlsConnector::from(Arc::new(tls_cfg)).connect(server_name, tcp),
    )
    .await
    .map_err(|_| {
        format!(
            "TLS handshake timed out for upstream HTTPS proxy {sni}:{}",
            cfg.port
        )
    })?
    .map_err(|e| {
        format!(
            "TLS handshake failed for upstream HTTPS proxy {sni}:{}: {e}",
            cfg.port
        )
    })?;

    Ok((
        UpstreamTransportStream::Tls(Box::new(tls_stream)),
        proxy_addr,
        dns_ms,
        tcp_connect_ms,
    ))
}

/// Opens a direct connection to an HTTP or HTTPS upstream proxy for plain-HTTP forwarding
/// (where `hyper` sends absolute-form URIs and `Proxy-Authorization`).
pub async fn connect_http_proxy_direct(
    cfg: &UpstreamProxyConfig,
    timeout: Duration,
) -> Result<UpstreamTunnelResult, String> {
    if cfg.protocol == UpstreamProxyProtocol::Socks5 {
        return Err(
            "connect_http_proxy_direct only supports HTTP/HTTPS upstream proxies".to_string(),
        );
    }
    let deadline = Instant::now() + timeout;
    let (stream, proxy_addr, dns_ms, tcp_connect_ms) =
        connect_proxy_transport(cfg, deadline).await?;
    Ok(UpstreamTunnelResult {
        stream,
        proxy_addr,
        dns_ms,
        tcp_connect_ms,
    })
}

async fn perform_http_connect_handshake(
    stream: &mut UpstreamTransportStream,
    cfg: &UpstreamProxyConfig,
    target_host: &str,
    target_port: u16,
    deadline: Instant,
) -> Result<(), String> {
    let authority = format_authority(target_host, target_port)?;
    let mut req = format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Connection: Keep-Alive\r\n"
    );
    if let Some(auth_val) = proxy_authorization_header_value(cfg) {
        req.push_str(&format!("Proxy-Authorization: {auth_val}\r\n"));
    }
    req.push_str("\r\n");

    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(format!(
            "Upstream proxy CONNECT timed out before write for {authority}"
        ));
    }
    tokio::time::timeout(remaining, async {
        stream.write_all(req.as_bytes()).await?;
        stream.flush().await
    })
    .await
    .map_err(|_| format!("Upstream proxy CONNECT write timed out for {authority}"))?
    .map_err(|e| format!("Upstream proxy CONNECT write failed for {authority}: {e}"))?;

    // Read response strictly 1 byte at a time until `\r\n\r\n` so zero post-handshake
    // server bytes (e.g. TLS ServerHello or early banner) are ever consumed into a buffer.
    let mut resp_buf = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "Upstream proxy CONNECT response timed out for {authority}"
            ));
        }
        let n = tokio::time::timeout(remaining, stream.read(&mut byte))
            .await
            .map_err(|_| format!("Upstream proxy CONNECT response timed out for {authority}"))?
            .map_err(|e| format!("Upstream proxy CONNECT read failed for {authority}: {e}"))?;
        if n == 0 {
            return Err(format!(
                "Upstream proxy closed connection during CONNECT {authority}"
            ));
        }
        resp_buf.push(byte[0]);
        if resp_buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if resp_buf.len() >= MAX_HTTP_CONNECT_RESPONSE_BYTES {
            return Err(format!(
                "Upstream proxy CONNECT response exceeded {MAX_HTTP_CONNECT_RESPONSE_BYTES} bytes"
            ));
        }
    }

    let header_text = String::from_utf8_lossy(&resp_buf);
    let status_line = header_text
        .lines()
        .next()
        .unwrap_or("")
        .trim_end_matches('\r');
    let mut parts = status_line.split_whitespace();
    let version = parts.next().unwrap_or("");
    let code_str = parts.next().unwrap_or("");
    let status_code = code_str.parse::<u16>().unwrap_or(0);
    if !version.starts_with("HTTP/") || status_code == 0 {
        return Err(format!(
            "Malformed upstream proxy CONNECT response for {authority}: '{status_line}'"
        ));
    }
    if status_code == 407 {
        return Err(format!(
            "Upstream proxy authentication required (407) for {authority}: {status_line}"
        ));
    }
    if !(200..300).contains(&status_code) {
        return Err(format!(
            "Upstream proxy rejected CONNECT {authority} with HTTP {status_code}: {status_line}"
        ));
    }
    Ok(())
}

fn socks5_reply_code_description(rep: u8) -> &'static str {
    match rep {
        0x01 => "general SOCKS server failure",
        0x02 => "connection not allowed by ruleset",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused by destination",
        0x06 => "TTL expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown SOCKS5 error",
    }
}

async fn perform_socks5_handshake(
    stream: &mut TcpStream,
    cfg: &UpstreamProxyConfig,
    target_host: &str,
    target_port: u16,
    deadline: Instant,
) -> Result<(), String> {
    let has_creds = cfg.has_credentials();
    let user_bytes = cfg.username.as_deref().unwrap_or("").as_bytes();
    let pass_bytes = cfg.password.as_deref().unwrap_or("").as_bytes();
    if user_bytes.len() > 255 || pass_bytes.len() > 255 {
        return Err("SOCKS5 username/password exceeds RFC 1929 255-byte limit".to_string());
    }

    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("SOCKS5 handshake timed out before greeting".to_string());
    }

    // 1. Greeting / auth method selection (RFC 1928)
    let greeting: &[u8] = if has_creds {
        &[0x05, 0x02, 0x00, 0x02]
    } else {
        &[0x05, 0x01, 0x00]
    };
    let mut method_resp = [0u8; 2];
    tokio::time::timeout(remaining, async {
        stream.write_all(greeting).await?;
        stream.flush().await?;
        stream.read_exact(&mut method_resp).await?;
        Ok::<_, io::Error>(())
    })
    .await
    .map_err(|_| "SOCKS5 greeting timed out".to_string())?
    .map_err(|e| format!("SOCKS5 greeting failed: {e}"))?;

    if method_resp[0] != 0x05 {
        return Err(format!(
            "Invalid SOCKS5 protocol version in greeting response: 0x{:02x}",
            method_resp[0]
        ));
    }

    match method_resp[1] {
        0x00 => {}
        0x02 => {
            if !has_creds {
                return Err(
                    "SOCKS5 proxy requires username/password authentication (method 0x02)"
                        .to_string(),
                );
            }
            let mut auth_pkt = Vec::with_capacity(3 + user_bytes.len() + pass_bytes.len());
            auth_pkt.push(0x01); // RFC 1929 subnegotiation version
            auth_pkt.push(user_bytes.len() as u8);
            auth_pkt.extend_from_slice(user_bytes);
            auth_pkt.push(pass_bytes.len() as u8);
            auth_pkt.extend_from_slice(pass_bytes);

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("SOCKS5 authentication timed out".to_string());
            }
            let mut auth_resp = [0u8; 2];
            tokio::time::timeout(remaining, async {
                stream.write_all(&auth_pkt).await?;
                stream.flush().await?;
                stream.read_exact(&mut auth_resp).await?;
                Ok::<_, io::Error>(())
            })
            .await
            .map_err(|_| "SOCKS5 username/password auth timed out".to_string())?
            .map_err(|e| format!("SOCKS5 username/password auth failed: {e}"))?;

            if auth_resp[1] != 0x00 {
                return Err(format!(
                    "SOCKS5 authentication rejected by proxy (status 0x{:02x})",
                    auth_resp[1]
                ));
            }
        }
        0xFF => {
            return Err("SOCKS5 proxy rejected all offered authentication methods".to_string());
        }
        other => {
            return Err(format!(
                "SOCKS5 proxy selected unsupported auth method 0x{other:02x}"
            ));
        }
    }

    // 2. CONNECT command (RFC 1928)
    let clean_target = target_host.trim().trim_matches(['[', ']']);
    let mut connect_pkt = Vec::with_capacity(7 + clean_target.len());
    connect_pkt.extend_from_slice(&[0x05, 0x01, 0x00]);
    match clean_target.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            connect_pkt.push(0x01);
            connect_pkt.extend_from_slice(&v4.octets());
        }
        Ok(IpAddr::V6(v6)) => {
            connect_pkt.push(0x04);
            connect_pkt.extend_from_slice(&v6.octets());
        }
        Err(_) => {
            let host_bytes = clean_target.as_bytes();
            if host_bytes.is_empty() || host_bytes.len() > 255 {
                return Err(format!(
                    "Invalid target domain length for SOCKS5 CONNECT: '{clean_target}'"
                ));
            }
            connect_pkt.push(0x03);
            connect_pkt.push(host_bytes.len() as u8);
            connect_pkt.extend_from_slice(host_bytes);
        }
    }
    connect_pkt.extend_from_slice(&target_port.to_be_bytes());

    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("SOCKS5 CONNECT timed out".to_string());
    }

    let mut head = [0u8; 4];
    let rep_res = tokio::time::timeout(remaining, async {
        stream
            .write_all(&connect_pkt)
            .await
            .map_err(|e| e.to_string())?;
        stream.flush().await.map_err(|e| e.to_string())?;
        stream.read_exact(&mut head).await.map_err(|e| e.to_string())?;
        if head[0] != 0x05 {
            return Err(format!(
                "Invalid SOCKS5 version in CONNECT reply: 0x{:02x}",
                head[0]
            ));
        }
        match head[3] {
            0x01 => {
                let mut tail = [0u8; 6];
                stream.read_exact(&mut tail).await.map_err(|e| e.to_string())?;
            }
            0x04 => {
                let mut tail = [0u8; 18];
                stream.read_exact(&mut tail).await.map_err(|e| e.to_string())?;
            }
            0x03 => {
                let mut len_buf = [0u8; 1];
                stream
                    .read_exact(&mut len_buf)
                    .await
                    .map_err(|e| e.to_string())?;
                let mut tail = vec![0u8; len_buf[0] as usize + 2];
                stream.read_exact(&mut tail).await.map_err(|e| e.to_string())?;
            }
            other => {
                return Err(format!("Invalid SOCKS5 ATYP in CONNECT reply: 0x{other:02x}"));
            }
        }
        Ok(head[1])
    })
    .await
    .map_err(|_| format!("SOCKS5 CONNECT timed out for {clean_target}:{target_port}"))?;

    let rep = rep_res?;
    if rep != 0x00 {
        return Err(format!(
            "SOCKS5 CONNECT failed for {clean_target}:{target_port}: {} (0x{rep:02x})",
            socks5_reply_code_description(rep)
        ));
    }

    Ok(())
}

/// Establishes a tunneled TCP-like stream to `target_host:target_port` via an upstream
/// HTTP (`CONNECT`), HTTPS (`TLS + CONNECT`), or SOCKS5 (`RFC 1928/1929`) proxy.
pub async fn connect_tunnel_via_upstream(
    cfg: &UpstreamProxyConfig,
    target_host: &str,
    target_port: u16,
    timeout: Duration,
) -> Result<UpstreamTunnelResult, String> {
    let deadline = Instant::now() + timeout;
    match cfg.protocol {
        UpstreamProxyProtocol::Http | UpstreamProxyProtocol::Https => {
            let (mut stream, proxy_addr, dns_ms, tcp_connect_ms) =
                connect_proxy_transport(cfg, deadline).await?;
            perform_http_connect_handshake(&mut stream, cfg, target_host, target_port, deadline)
                .await?;
            Ok(UpstreamTunnelResult {
                stream,
                proxy_addr,
                dns_ms,
                tcp_connect_ms,
            })
        }
        UpstreamProxyProtocol::Socks5 => {
            let (mut tcp, proxy_addr, dns_ms, tcp_connect_ms) =
                connect_proxy_tcp(&cfg.host, cfg.port, deadline).await?;
            perform_socks5_handshake(&mut tcp, cfg, target_host, target_port, deadline).await?;
            Ok(UpstreamTunnelResult {
                stream: UpstreamTransportStream::Tcp(tcp),
                proxy_addr,
                dns_ms,
                tcp_connect_ms,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn bypass_list_parses_and_matches_localhost_cidrs_wildcards_and_ports() {
        let parsed = parse_bypass_list("localhost, 127.0.0.1; *.corp.local\n10.0.0.0/8 <local>");
        assert_eq!(
            parsed,
            vec![
                "localhost",
                "127.0.0.1",
                "*.corp.local",
                "10.0.0.0/8",
                "<local>"
            ]
        );

        let matcher = UpstreamBypassMatcher::from_rules(&[
            "localhost".into(),
            "<local>".into(),
            "10.0.0.0/8".into(),
            "192.168.1.0/24:8443".into(),
            "fd00::/8".into(),
            "::1".into(),
            "*.corp.local".into(),
            ".partner.internal".into(),
            "api-*.staging.dev".into(),
        ]);

        // Localhost & <local>
        assert!(matcher.should_bypass("localhost", Some(8080)));
        assert!(matcher.should_bypass("sub.localhost", Some(3000)));
        assert!(matcher.should_bypass("intranet", Some(80)));
        assert!(matcher.should_bypass("127.0.0.1", Some(8888)));
        assert!(matcher.should_bypass("127.0.1.9", Some(80)));
        assert!(matcher.should_bypass("::1", Some(443)));
        assert!(matcher.should_bypass("[::ffff:127.0.0.1]:8080", None));

        // CIDRs (IPv4, IPv4-mapped IPv6, IPv4 with port, IPv6)
        assert!(matcher.should_bypass("10.255.1.42", Some(443)));
        assert!(matcher.should_bypass("::ffff:10.0.1.5", Some(80)));
        assert!(!matcher.should_bypass("11.0.0.1", Some(443)));
        assert!(matcher.should_bypass("192.168.1.55", Some(8443)));
        assert!(!matcher.should_bypass("192.168.1.55", Some(443)));
        assert!(matcher.should_bypass("fd12:3456::1", Some(443)));
        assert!(!matcher.should_bypass("2001:db8::1", Some(443)));

        // Wildcard `*.corp.local` strictly matches subdomains only, NOT apex or evil suffix
        assert!(matcher.should_bypass("API.CORP.LOCAL.", Some(443)));
        assert!(matcher.should_bypass("v2.auth.corp.local", Some(443)));
        assert!(!matcher.should_bypass("corp.local", Some(443)));
        assert!(!matcher.should_bypass("evilcorp.local", Some(443)));

        // Dot suffix `.partner.internal` matches BOTH apex and subdomains, NOT evil suffix
        assert!(matcher.should_bypass("partner.internal", Some(443)));
        assert!(matcher.should_bypass("svc.partner.internal", Some(443)));
        assert!(!matcher.should_bypass("evilpartner.internal", Some(443)));

        // Glob pattern
        assert!(matcher.should_bypass("api-eu.staging.dev", Some(443)));
        assert!(!matcher.should_bypass("web-eu.staging.dev", Some(443)));

        // Public hosts must NOT bypass
        assert!(!matcher.should_bypass("api.github.com", Some(443)));
        assert!(!matcher.should_bypass("93.184.216.34", Some(443)));

        // Edge-case `/0` CIDR & wildcard `*`
        let catch_all = UpstreamBypassMatcher::parse("0.0.0.0/0");
        assert!(catch_all.should_bypass("8.8.8.8", Some(443)));
        let star = UpstreamBypassMatcher::parse("*");
        assert!(star.should_bypass("example.com", Some(443)));
    }

    #[test]
    fn manager_redacts_passwords_and_preserves_on_roundtrip() {
        let manager = UpstreamProxyManager::new();
        let saved = manager
            .set_config(UpstreamProxyConfig {
                enabled: true,
                protocol: UpstreamProxyProtocol::Http,
                host: "proxy.corp.local".into(),
                port: 3128,
                username: Some("alice".into()),
                password: Some("s3cr3t".into()),
                has_password: false,
                bypass_list: vec!["localhost, 127.0.0.1".into()],
            })
            .unwrap();

        assert!(saved.password.is_none());
        assert!(saved.has_password);
        assert_eq!(saved.bypass_list, vec!["localhost", "127.0.0.1"]);
        assert_eq!(
            manager.get_runtime_config().password.as_deref(),
            Some("s3cr3t")
        );
        assert!(!format!("{:?}", manager.get_runtime_config()).contains("s3cr3t"));

        // Updating bypass list while keeping `password: None, has_password: true` preserves existing password
        let updated = manager
            .set_config(UpstreamProxyConfig {
                enabled: true,
                protocol: UpstreamProxyProtocol::Http,
                host: "proxy.corp.local".into(),
                port: 3128,
                username: Some("alice".into()),
                password: None,
                has_password: true,
                bypass_list: vec!["*.corp.local".into()],
            })
            .unwrap();
        assert!(updated.has_password);
        assert_eq!(
            manager.get_runtime_config().password.as_deref(),
            Some("s3cr3t")
        );

        // Passing `password: Some("")` clears stored password
        let cleared = manager
            .set_config(UpstreamProxyConfig {
                enabled: true,
                protocol: UpstreamProxyProtocol::Http,
                host: "proxy.corp.local".into(),
                port: 3128,
                username: Some("alice".into()),
                password: Some(String::new()),
                has_password: false,
                bypass_list: vec![],
            })
            .unwrap();
        assert!(!cleared.has_password);
        assert!(manager.get_runtime_config().password.is_none());
    }

    #[tokio::test]
    async fn http_connect_tunnel_sends_basic_auth_and_preserves_early_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut req_buf = Vec::new();
                let mut b = [0u8; 1];
                while !req_buf.ends_with(b"\r\n\r\n") {
                    sock.read_exact(&mut b).await.unwrap();
                    req_buf.push(b[0]);
                }
                let req_str = String::from_utf8_lossy(&req_buf).to_string();
                let expected_auth = format!(
                    "Proxy-Authorization: Basic {}",
                    base64::engine::general_purpose::STANDARD.encode("eng:pass123")
                );
                if attempt == 0 {
                    assert!(req_str.starts_with("CONNECT example.com:443 HTTP/1.1\r\n"));
                    assert!(req_str.contains(&expected_auth));
                    // Send 200 AND immediate server banner in the very same write to verify zero BufReader over-read
                    sock.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\nEARLY_BANNER")
                        .await
                        .unwrap();
                    let mut echo_buf = [0u8; 5];
                    sock.read_exact(&mut echo_buf).await.unwrap();
                    assert_eq!(&echo_buf, b"HELLO");
                    sock.write_all(b"WORLD").await.unwrap();
                } else {
                    sock.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                        .await
                        .unwrap();
                }
            }
        });

        let cfg = UpstreamProxyConfig {
            enabled: true,
            protocol: UpstreamProxyProtocol::Http,
            host: "127.0.0.1".into(),
            port: proxy_addr.port(),
            username: Some("eng".into()),
            password: Some("pass123".into()),
            has_password: true,
            bypass_list: vec![],
        };

        let mut tunnel =
            connect_tunnel_via_upstream(&cfg, "example.com", 443, Duration::from_secs(5))
                .await
                .unwrap();
        let mut banner = [0u8; 12];
        tunnel.stream.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"EARLY_BANNER");
        tunnel.stream.write_all(b"HELLO").await.unwrap();
        tunnel.stream.flush().await.unwrap();
        let mut reply = [0u8; 5];
        tunnel.stream.read_exact(&mut reply).await.unwrap();
        assert_eq!(&reply, b"WORLD");

        let err = connect_tunnel_via_upstream(&cfg, "example.com", 443, Duration::from_secs(5))
            .await
            .err()
            .expect("407 response must return an error");
        assert!(err.contains("407"));
    }

    #[tokio::test]
    async fn socks5_tunnel_performs_rfc1929_auth_and_domain_connect() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socks_addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            // Connection 1: valid auth + echo
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut greet = [0u8; 4];
            sock.read_exact(&mut greet).await.unwrap();
            assert_eq!(greet, [0x05, 0x02, 0x00, 0x02]);
            sock.write_all(&[0x05, 0x02]).await.unwrap(); // select username/password

            let mut auth_head = [0u8; 2];
            sock.read_exact(&mut auth_head).await.unwrap();
            assert_eq!(auth_head[0], 0x01);
            let mut ubuf = vec![0u8; auth_head[1] as usize];
            sock.read_exact(&mut ubuf).await.unwrap();
            let mut plen = [0u8; 1];
            sock.read_exact(&mut plen).await.unwrap();
            let mut pbuf = vec![0u8; plen[0] as usize];
            sock.read_exact(&mut pbuf).await.unwrap();
            assert_eq!(ubuf, b"socksuser");
            assert_eq!(pbuf, b"sockspass");
            sock.write_all(&[0x01, 0x00]).await.unwrap();

            let mut req_head = [0u8; 5];
            sock.read_exact(&mut req_head).await.unwrap();
            assert_eq!(&req_head[..4], &[0x05, 0x01, 0x00, 0x03]);
            let mut host_port = vec![0u8; req_head[4] as usize + 2];
            sock.read_exact(&mut host_port).await.unwrap();
            assert_eq!(&host_port[..req_head[4] as usize], b"api.remote.test");
            let port = u16::from_be_bytes([
                host_port[req_head[4] as usize],
                host_port[req_head[4] as usize + 1],
            ]);
            assert_eq!(port, 8443);

            sock.write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x20, 0xfb])
                .await
                .unwrap();
            let mut ping = [0u8; 4];
            sock.read_exact(&mut ping).await.unwrap();
            assert_eq!(&ping, b"PING");
            sock.write_all(b"PONG").await.unwrap();

            // Connection 2: auth rejected
            let (mut sock2, _) = listener.accept().await.unwrap();
            let mut greet2 = [0u8; 4];
            sock2.read_exact(&mut greet2).await.unwrap();
            sock2.write_all(&[0x05, 0x02]).await.unwrap();
            let mut auth_head2 = [0u8; 2];
            sock2.read_exact(&mut auth_head2).await.unwrap();
            let mut rest = vec![0u8; auth_head2[1] as usize + 1];
            sock2.read_exact(&mut rest).await.unwrap();
            let mut pbuf2 = vec![0u8; rest[auth_head2[1] as usize] as usize];
            sock2.read_exact(&mut pbuf2).await.unwrap();
            sock2.write_all(&[0x01, 0x01]).await.unwrap();
        });

        let cfg = UpstreamProxyConfig {
            enabled: true,
            protocol: UpstreamProxyProtocol::Socks5,
            host: "127.0.0.1".into(),
            port: socks_addr.port(),
            username: Some("socksuser".into()),
            password: Some("sockspass".into()),
            has_password: true,
            bypass_list: vec![],
        };

        let mut tunnel = connect_tunnel_via_upstream(
            &cfg,
            "api.remote.test",
            8443,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        tunnel.stream.write_all(b"PING").await.unwrap();
        tunnel.stream.flush().await.unwrap();
        let mut pong = [0u8; 4];
        tunnel.stream.read_exact(&mut pong).await.unwrap();
        assert_eq!(&pong, b"PONG");

        let auth_err = connect_tunnel_via_upstream(
            &cfg,
            "api.remote.test",
            8443,
            Duration::from_secs(5),
        )
        .await
        .err()
        .expect("rejected SOCKS5 auth must return an error");
        assert!(auth_err.contains("authentication rejected"));
    }
}
