use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use chrono::{DateTime, Utc};
use http::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, PROXY_AUTHORIZATION};
use http::{HeaderName, HeaderValue, Method, Request, Response, StatusCode, Uri};
use http_body_util::combinators::BoxBody;
use hyper::body::{Body as HttpBody, Frame, Incoming, SizeHint};
use hyper_util::client::legacy::connect::{Connected, Connection};
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use rustls_pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;
use tower_service::Service;

use crate::models::{HeaderPair, UpstreamProxyProtocol};
use crate::proxy::hosts::HostRemapRegistry;
use crate::proxy::server::{is_loopback_or_unspecified_host, validate_resolved_addrs_for_peer};
use crate::proxy::upstream_proxy::{
    connect_http_proxy_direct, connect_tunnel_via_upstream, format_via_proxy_telemetry,
    proxy_authorization_header_value, UpstreamProxyManager, UpstreamTransportStream,
};

const MAX_REDIRECT_HOPS: usize = 10;

static NEXT_UPSTREAM_CONN_ID: AtomicU64 = AtomicU64::new(1);
static NATIVE_ROOT_STORE: OnceLock<Arc<rustls::RootCertStore>> = OnceLock::new();

#[inline]
pub fn round_ms(ms: f64) -> f64 {
    if !ms.is_finite() || ms < 0.0 {
        0.0
    } else {
        (ms * 1000.0).round() / 1000.0
    }
}

#[inline]
pub fn duration_ms_f64(d: Duration) -> f64 {
    round_ms(d.as_secs_f64() * 1000.0)
}

#[inline]
pub fn elapsed_ms(start: Instant) -> f64 {
    duration_ms_f64(start.elapsed())
}

#[inline]
pub fn format_rfc3339_micros(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
}

pub fn timestamp_at_instant(base_instant: Instant, base_utc: DateTime<Utc>, target: Instant) -> String {
    let dt = if target >= base_instant {
        match chrono::Duration::from_std(target.duration_since(base_instant)) {
            Ok(delta) => base_utc + delta,
            Err(_) => base_utc,
        }
    } else {
        match chrono::Duration::from_std(base_instant.duration_since(target)) {
            Ok(delta) => base_utc - delta,
            Err(_) => base_utc,
        }
    };
    format_rfc3339_micros(dt)
}

pub fn format_tls_protocol(v: rustls::ProtocolVersion) -> String {
    match v {
        rustls::ProtocolVersion::TLSv1_3 => "TLS 1.3".to_string(),
        rustls::ProtocolVersion::TLSv1_2 => "TLS 1.2".to_string(),
        rustls::ProtocolVersion::TLSv1_1 => "TLS 1.1".to_string(),
        rustls::ProtocolVersion::TLSv1_0 => "TLS 1.0".to_string(),
        other => format!("{other:?}"),
    }
}

pub fn format_tls_cipher(suite: rustls::SupportedCipherSuite) -> String {
    format!("{:?}", suite.suite())
}

pub fn extract_peer_cert_subject_issuer(der: &[u8]) -> (Option<String>, Option<String>) {
    let Ok((_, cert)) = x509_parser::parse_x509_certificate(der) else {
        return (None, None);
    };
    let subject = {
        let s = cert.subject().to_string();
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };
    let issuer = {
        let s = cert.issuer().to_string();
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };
    (subject, issuer)
}

pub fn estimate_request_headers_bytes(
    method: &str,
    path: &str,
    version_label: &str,
    headers: &[HeaderPair],
) -> usize {
    // `<METHOD> <PATH> HTTP/1.1\r\n` + headers + `\r\n`
    let ver_len = if version_label.is_empty() { 8 } else { version_label.len() };
    let mut total = method.len() + 1 + path.len() + 1 + ver_len + 2 + 2;
    for h in headers {
        total = total.saturating_add(h.name.len() + 2 + h.value.len() + 2);
    }
    total
}

pub fn estimate_response_headers_bytes(
    status: u16,
    version_label: &str,
    headers: &[HeaderPair],
) -> usize {
    let reason_len = StatusCode::from_u16(status)
        .ok()
        .and_then(|s| s.canonical_reason())
        .map_or(2, str::len);
    let ver_len = if version_label.is_empty() { 8 } else { version_label.len() };
    let mut total = ver_len + 1 + 3 + 1 + reason_len + 2 + 2;
    for h in headers {
        total = total.saturating_add(h.name.len() + 2 + h.value.len() + 2);
    }
    total
}

pub(crate) fn default_root_store() -> Arc<rustls::RootCertStore> {
    Arc::clone(NATIVE_ROOT_STORE.get_or_init(|| {
        let mut store = rustls::RootCertStore::empty();
        let native = rustls_native_certs::load_native_certs();
        for cert in native.certs {
            let _ = store.add(cert);
        }
        if store.is_empty() {
            store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        }
        Arc::new(store)
    }))
}

#[derive(Debug)]
pub struct UpstreamConnMeta {
    pub conn_id: u64,
    pub server_addr: SocketAddr,
    pub server_ip: String,
    pub server_port: u16,
    pub dns_ms: f64,
    pub tcp_connect_ms: f64,
    pub tls_handshake_ms: Option<f64>,
    pub server_connected_at: String,
    pub server_connected_instant: Instant,
    pub tls_version: Option<String>,
    pub tls_cipher: Option<String>,
    pub tls_alpn: Option<String>,
    pub cert_subject: Option<String>,
    pub cert_issuer: Option<String>,
    pub mtls_cn: Option<String>,
    pub remapped_target: Option<String>,
    pub via_proxy_addr: Option<String>,
    pub is_tls: bool,
    pub via_http_proxy: bool,
    claimed: AtomicBool,
}

#[derive(Debug, Clone)]
pub struct ClaimedConnMetrics {
    pub reused: bool,
    pub dns_ms: f64,
    pub tcp_connect_ms: f64,
    pub tls_handshake_ms: Option<f64>,
    pub server_connected_at: Option<String>,
}

impl UpstreamConnMeta {
    /// Atomically claims connection setup costs for the first request on this pooled socket.
    /// Subsequent requests reuse the pool entry (`reused = true` and `0.0 ms` setup phases).
    pub fn claim_for_request(&self) -> ClaimedConnMetrics {
        let was_claimed = self.claimed.swap(true, Ordering::AcqRel);
        if !was_claimed {
            ClaimedConnMetrics {
                reused: false,
                dns_ms: self.dns_ms,
                tcp_connect_ms: self.tcp_connect_ms,
                tls_handshake_ms: self.tls_handshake_ms,
                server_connected_at: Some(self.server_connected_at.clone()),
            }
        } else {
            ClaimedConnMetrics {
                reused: true,
                dns_ms: 0.0,
                tcp_connect_ms: 0.0,
                tls_handshake_ms: if self.is_tls { Some(0.0) } else { None },
                server_connected_at: None,
            }
        }
    }
}

pub enum InstrumentedStream {
    Plain {
        io: TokioIo<TcpStream>,
        meta: Arc<UpstreamConnMeta>,
    },
    Tls {
        io: Box<TokioIo<TlsStream<TcpStream>>>,
        meta: Arc<UpstreamConnMeta>,
    },
    Proxied {
        io: Box<TokioIo<UpstreamTransportStream>>,
        meta: Arc<UpstreamConnMeta>,
    },
    ProxiedTls {
        io: Box<TokioIo<TlsStream<UpstreamTransportStream>>>,
        meta: Arc<UpstreamConnMeta>,
    },
}

impl InstrumentedStream {
    fn meta(&self) -> &Arc<UpstreamConnMeta> {
        match self {
            Self::Plain { meta, .. }
            | Self::Tls { meta, .. }
            | Self::Proxied { meta, .. }
            | Self::ProxiedTls { meta, .. } => meta,
        }
    }
}

impl hyper::rt::Read for InstrumentedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: hyper::rt::ReadBufCursor<'_>,
    ) -> Poll<Result<(), io::Error>> {
        match &mut *self {
            Self::Plain { io, .. } => Pin::new(io).poll_read(cx, buf),
            Self::Tls { io, .. } => Pin::new(io.as_mut()).poll_read(cx, buf),
            Self::Proxied { io, .. } => Pin::new(io.as_mut()).poll_read(cx, buf),
            Self::ProxiedTls { io, .. } => Pin::new(io.as_mut()).poll_read(cx, buf),
        }
    }
}

impl hyper::rt::Write for InstrumentedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<Result<usize, io::Error>> {
        match &mut *self {
            Self::Plain { io, .. } => Pin::new(io).poll_write(cx, buf),
            Self::Tls { io, .. } => Pin::new(io.as_mut()).poll_write(cx, buf),
            Self::Proxied { io, .. } => Pin::new(io.as_mut()).poll_write(cx, buf),
            Self::ProxiedTls { io, .. } => Pin::new(io.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), io::Error>> {
        match &mut *self {
            Self::Plain { io, .. } => Pin::new(io).poll_flush(cx),
            Self::Tls { io, .. } => Pin::new(io.as_mut()).poll_flush(cx),
            Self::Proxied { io, .. } => Pin::new(io.as_mut()).poll_flush(cx),
            Self::ProxiedTls { io, .. } => Pin::new(io.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Result<(), io::Error>> {
        match &mut *self {
            Self::Plain { io, .. } => Pin::new(io).poll_shutdown(cx),
            Self::Tls { io, .. } => Pin::new(io.as_mut()).poll_shutdown(cx),
            Self::Proxied { io, .. } => Pin::new(io.as_mut()).poll_shutdown(cx),
            Self::ProxiedTls { io, .. } => Pin::new(io.as_mut()).poll_shutdown(cx),
        }
    }

    fn is_write_vectored(&self) -> bool {
        match self {
            Self::Plain { io, .. } => io.is_write_vectored(),
            Self::Tls { io, .. } => io.is_write_vectored(),
            Self::Proxied { io, .. } => io.is_write_vectored(),
            Self::ProxiedTls { io, .. } => io.is_write_vectored(),
        }
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<Result<usize, io::Error>> {
        match &mut *self {
            Self::Plain { io, .. } => Pin::new(io).poll_write_vectored(cx, bufs),
            Self::Tls { io, .. } => Pin::new(io.as_mut()).poll_write_vectored(cx, bufs),
            Self::Proxied { io, .. } => Pin::new(io.as_mut()).poll_write_vectored(cx, bufs),
            Self::ProxiedTls { io, .. } => Pin::new(io.as_mut()).poll_write_vectored(cx, bufs),
        }
    }
}

impl Connection for InstrumentedStream {
    fn connected(&self) -> Connected {
        let meta = self.meta();
        let mut connected = Connected::new().extra(Arc::clone(meta));
        if meta.via_http_proxy {
            connected = connected.proxy(true);
        }
        if meta.tls_alpn.as_deref() == Some("h2") {
            connected = connected.negotiated_h2();
        }
        connected
    }
}

#[derive(Debug)]
pub struct UpstreamConnectorError {
    pub message: String,
    pub forbidden: bool,
}

impl UpstreamConnectorError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            forbidden: false,
        }
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            forbidden: true,
        }
    }
}

impl std::fmt::Display for UpstreamConnectorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UpstreamConnectorError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HostRemapAlreadyApplied;

#[derive(Clone)]
pub struct InstrumentedConnector {
    tls_config: Arc<rustls::ClientConfig>,
    host_remap: Option<Arc<HostRemapRegistry>>,
    upstream_proxy: Option<Arc<UpstreamProxyManager>>,
    connect_timeout_sec: Arc<AtomicU64>,
    mtls_cn: Option<String>,
    peer_is_remote: bool,
    skip_host_remap: bool,
}

impl InstrumentedConnector {
    pub fn new(
        host_remap: Option<Arc<HostRemapRegistry>>,
        upstream_proxy: Option<Arc<UpstreamProxyManager>>,
        client_auth: Option<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>, String)>,
        connect_timeout_sec: Arc<AtomicU64>,
        peer_is_remote: bool,
    ) -> Result<Self, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let roots = default_root_store();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let builder = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| format!("TLS protocol config error: {e}"))?
            .with_root_certificates(roots);

        let (mut tls_config, mtls_cn) = match client_auth {
            Some((certs, key, cn)) => {
                let cfg = builder
                    .with_client_auth_cert(certs, key)
                    .map_err(|e| format!("Invalid client certificate / key for mTLS: {e}"))?;
                (cfg, Some(cn))
            }
            None => (builder.with_no_client_auth(), None),
        };
        tls_config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

        Ok(Self {
            tls_config: Arc::new(tls_config),
            host_remap,
            upstream_proxy,
            connect_timeout_sec,
            mtls_cn,
            peer_is_remote,
            skip_host_remap: false,
        })
    }

    pub(crate) fn with_skip_host_remap(mut self, skip: bool) -> Self {
        self.skip_host_remap = skip;
        self
    }
}

struct TlsConnDetails {
    tls_version: Option<String>,
    tls_cipher: Option<String>,
    tls_alpn: Option<String>,
    cert_subject: Option<String>,
    cert_issuer: Option<String>,
}

fn extract_tls_conn_details(conn_info: &rustls::ClientConnection) -> TlsConnDetails {
    let tls_version = conn_info.protocol_version().map(format_tls_protocol);
    let tls_cipher = conn_info
        .negotiated_cipher_suite()
        .map(format_tls_cipher);
    let tls_alpn = conn_info
        .alpn_protocol()
        .map(|b| String::from_utf8_lossy(b).into_owned());
    let (cert_subject, cert_issuer) = conn_info
        .peer_certificates()
        .and_then(|certs| certs.first())
        .map(|leaf| extract_peer_cert_subject_issuer(leaf.as_ref()))
        .unwrap_or((None, None));
    TlsConnDetails {
        tls_version,
        tls_cipher,
        tls_alpn,
        cert_subject,
        cert_issuer,
    }
}

async fn resolve_and_validate_addrs(
    connect_host: &str,
    connect_port: u16,
    connect_timeout: Duration,
    dns_timeout: Duration,
    peer_is_remote: bool,
) -> Result<(Vec<SocketAddr>, f64), UpstreamConnectorError> {
    let (addrs, dns_ms): (Vec<SocketAddr>, f64) =
        if let Ok(ip) = connect_host.parse::<IpAddr>() {
            (vec![SocketAddr::new(ip, connect_port)], 0.0)
        } else {
            if dns_timeout.is_zero() {
                return Err(UpstreamConnectorError::new(format!(
                    "DNS lookup timed out after {} s connect deadline for {connect_host}:{connect_port}",
                    connect_timeout.as_secs()
                )));
            }
            let dns_start = Instant::now();
            let resolved_iter = tokio::time::timeout(
                dns_timeout,
                tokio::net::lookup_host((connect_host, connect_port)),
            )
            .await
            .map_err(|_| {
                UpstreamConnectorError::new(format!(
                    "DNS lookup timed out after {} s connect deadline for {connect_host}:{connect_port}",
                    connect_timeout.as_secs()
                ))
            })?
            .map_err(|e| {
                UpstreamConnectorError::new(format!(
                    "DNS lookup failed for {connect_host}:{connect_port}: {e}"
                ))
            })?;
            let collected: Vec<SocketAddr> = resolved_iter.collect();
            if collected.is_empty() {
                return Err(UpstreamConnectorError::new(format!(
                    "DNS lookup returned no addresses for {connect_host}:{connect_port}"
                )));
            }
            (collected, elapsed_ms(dns_start))
        };

    validate_resolved_addrs_for_peer(
        &addrs,
        peer_is_remote,
        &format!("{connect_host}:{connect_port}"),
    )
    .map_err(UpstreamConnectorError::forbidden)?;

    Ok((addrs, dns_ms))
}

impl Service<Uri> for InstrumentedConnector {
    type Response = InstrumentedStream;
    type Error = UpstreamConnectorError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, dst: Uri) -> Self::Future {
        let tls_config = Arc::clone(&self.tls_config);
        let host_remap = self.host_remap.clone();
        let upstream_proxy = self.upstream_proxy.clone();
        let connect_timeout_sec = self.connect_timeout_sec.load(Ordering::Relaxed).max(1);
        let connect_timeout = Duration::from_secs(connect_timeout_sec);
        let mtls_cn = self.mtls_cn.clone();
        let peer_is_remote = self.peer_is_remote;
        let skip_host_remap = self.skip_host_remap;

        Box::pin(async move {
            let connect_deadline = Instant::now() + connect_timeout;
            let scheme = dst.scheme_str().unwrap_or("http");
            let is_tls = scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("wss");
            let orig_host = dst
                .host()
                .ok_or_else(|| UpstreamConnectorError::new(format!("Missing host in URI: {dst}")))?
                .to_string();
            let orig_port = dst
                .port_u16()
                .unwrap_or(if is_tls { 443 } else { 80 });
            let remaining_connect_budget = |phase: &str| -> Result<Duration, UpstreamConnectorError> {
                let remaining = connect_deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    Err(UpstreamConnectorError::new(format!(
                        "{phase} timed out after {} s connect deadline for {orig_host}:{orig_port}",
                        connect_timeout.as_secs()
                    )))
                } else {
                    Ok(remaining)
                }
            };

            let remap_rule = if skip_host_remap {
                None
            } else {
                host_remap.as_ref().and_then(|reg| reg.match_host(&orig_host))
            };
            if let Some(ref rule) = remap_rule {
                if peer_is_remote && is_loopback_or_unspecified_host(&rule.target_host) {
                    return Err(UpstreamConnectorError::forbidden(format!(
                        "Forbidden: remote LAN clients cannot connect via HOSTS Remapping to loopback or unspecified host '{}'",
                        rule.target_host
                    )));
                }
            }
            let (connect_host, connect_port, remapped_target) = if let Some(ref rule) = remap_rule
            {
                let target_port = rule.target_port.unwrap_or(orig_port);
                let label = HostRemapRegistry::format_remap_target(rule, rule.target_port);
                (
                    rule.target_host.trim_matches(['[', ']']).to_string(),
                    target_port,
                    Some(label),
                )
            } else {
                (
                    orig_host.trim_matches(['[', ']']).to_string(),
                    orig_port,
                    None,
                )
            };

            if peer_is_remote && is_loopback_or_unspecified_host(&connect_host) {
                return Err(UpstreamConnectorError::forbidden(format!(
                    "Forbidden: remote LAN clients cannot connect to loopback or unspecified host '{connect_host}'"
                )));
            }

            let active_proxy = upstream_proxy.as_ref().and_then(|mgr| {
                mgr.resolve_for_target(
                    &orig_host,
                    orig_port,
                    remap_rule.as_ref().map(|_| connect_host.as_str()),
                    remap_rule.as_ref().map(|_| connect_port),
                )
            });

            if let Some(proxy_cfg) = active_proxy {
                let conn_id = NEXT_UPSTREAM_CONN_ID.fetch_add(1, Ordering::Relaxed);
                if !is_tls {
                    let is_http_proxy = matches!(
                        proxy_cfg.protocol,
                        UpstreamProxyProtocol::Http | UpstreamProxyProtocol::Https
                    );
                    let tunnel_timeout = remaining_connect_budget("Upstream proxy connect")?;
                    let tunnel = if is_http_proxy {
                        connect_http_proxy_direct(&proxy_cfg, tunnel_timeout).await
                    } else {
                        connect_tunnel_via_upstream(
                            &proxy_cfg,
                            &connect_host,
                            connect_port,
                            tunnel_timeout,
                        )
                        .await
                    }
                    .map_err(UpstreamConnectorError::new)?;

                    let (via_proxy_addr, via_server_ip) =
                        format_via_proxy_telemetry(proxy_cfg.protocol, tunnel.proxy_addr);
                    let meta = Arc::new(UpstreamConnMeta {
                        conn_id,
                        server_addr: tunnel.proxy_addr,
                        server_ip: via_server_ip,
                        server_port: tunnel.proxy_addr.port(),
                        dns_ms: tunnel.dns_ms,
                        tcp_connect_ms: tunnel.tcp_connect_ms,
                        tls_handshake_ms: None,
                        server_connected_at: format_rfc3339_micros(Utc::now()),
                        server_connected_instant: Instant::now(),
                        tls_version: None,
                        tls_cipher: None,
                        tls_alpn: None,
                        cert_subject: None,
                        cert_issuer: None,
                        mtls_cn,
                        remapped_target,
                        via_proxy_addr: Some(via_proxy_addr),
                        is_tls: false,
                        via_http_proxy: is_http_proxy,
                        claimed: AtomicBool::new(false),
                    });
                    return Ok(InstrumentedStream::Proxied {
                        io: Box::new(TokioIo::new(tunnel.stream)),
                        meta,
                    });
                }

                // HTTPS over upstream proxy (`CONNECT` or `SOCKS5` tunnel + inner TLS with original SNI & mTLS)
                let tunnel_timeout = remaining_connect_budget("Upstream proxy tunnel")?;
                let tunnel = connect_tunnel_via_upstream(
                    &proxy_cfg,
                    &connect_host,
                    connect_port,
                    tunnel_timeout,
                )
                .await
                .map_err(UpstreamConnectorError::new)?;

                let sni_clean = orig_host.trim_matches(['[', ']']).to_string();
                let server_name = ServerName::try_from(sni_clean.clone()).map_err(|_| {
                    UpstreamConnectorError::new(format!("Invalid TLS ServerName for '{sni_clean}'"))
                })?;

                let tls_timeout = remaining_connect_budget("TLS handshake via upstream proxy")?;
                let tls_start = Instant::now();
                let tls_connector = TlsConnector::from(tls_config);
                let tls_stream = tokio::time::timeout(
                    tls_timeout,
                    tls_connector.connect(server_name, tunnel.stream),
                )
                .await
                .map_err(|_| {
                    UpstreamConnectorError::new(format!(
                        "TLS handshake timed out via upstream proxy after {} s connect deadline for {orig_host}:{orig_port}",
                        connect_timeout.as_secs()
                    ))
                })?
                .map_err(|e| {
                    UpstreamConnectorError::new(format!(
                        "TLS handshake failed via upstream proxy for {orig_host}:{orig_port}: {e}"
                    ))
                })?;
                let tls_handshake_ms = Some(elapsed_ms(tls_start));
                let now_instant = Instant::now();
                let TlsConnDetails {
                    tls_version,
                    tls_cipher,
                    tls_alpn,
                    cert_subject,
                    cert_issuer,
                } = extract_tls_conn_details(tls_stream.get_ref().1);

                let (via_proxy_addr, via_server_ip) =
                    format_via_proxy_telemetry(proxy_cfg.protocol, tunnel.proxy_addr);
                let meta = Arc::new(UpstreamConnMeta {
                    conn_id,
                    server_addr: tunnel.proxy_addr,
                    server_ip: via_server_ip,
                    server_port: tunnel.proxy_addr.port(),
                    dns_ms: tunnel.dns_ms,
                    tcp_connect_ms: tunnel.tcp_connect_ms,
                    tls_handshake_ms,
                    server_connected_at: format_rfc3339_micros(Utc::now()),
                    server_connected_instant: now_instant,
                    tls_version,
                    tls_cipher,
                    tls_alpn,
                    cert_subject,
                    cert_issuer,
                    mtls_cn,
                    remapped_target,
                    via_proxy_addr: Some(via_proxy_addr),
                    is_tls: true,
                    via_http_proxy: false,
                    claimed: AtomicBool::new(false),
                });
                return Ok(InstrumentedStream::ProxiedTls {
                    io: Box::new(TokioIo::new(tls_stream)),
                    meta,
                });
            }

            // 1. DNS Resolution phase
            let dns_timeout = if connect_host.parse::<IpAddr>().is_ok() {
                Duration::from_millis(1)
            } else {
                remaining_connect_budget("DNS lookup")?
            };
            let (addrs, dns_ms) = resolve_and_validate_addrs(
                &connect_host,
                connect_port,
                connect_timeout,
                dns_timeout,
                peer_is_remote,
            )
            .await?;

            // 2. TCP Connect phase
            let tcp_start = Instant::now();
            let mut tcp_stream_opt: Option<TcpStream> = None;
            let mut last_tcp_err: Option<String> = None;

            for addr in addrs {
                let remaining = connect_deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    last_tcp_err = Some(format!(
                        "TCP connect timed out after {} s connect deadline",
                        connect_timeout.as_secs()
                    ));
                    break;
                }
                match tokio::time::timeout(remaining, TcpStream::connect(addr)).await {
                    Ok(Ok(stream)) => {
                        let _ = stream.set_nodelay(true);
                        tcp_stream_opt = Some(stream);
                        break;
                    }
                    Ok(Err(e)) => {
                        last_tcp_err = Some(format!("{addr}: {e}"));
                    }
                    Err(_) => {
                        last_tcp_err = Some(format!(
                            "{addr}: timed out after {} s connect deadline",
                            connect_timeout.as_secs()
                        ));
                    }
                }
            }

            let tcp_stream = tcp_stream_opt.ok_or_else(|| {
                UpstreamConnectorError::new(format!(
                    "TCP connect failed for {connect_host}:{connect_port}: {}",
                    last_tcp_err.unwrap_or_else(|| "no reachable address".to_string())
                ))
            })?;
            let tcp_connect_ms = elapsed_ms(tcp_start);
            let server_addr = tcp_stream
                .peer_addr()
                .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], connect_port)));

            let conn_id = NEXT_UPSTREAM_CONN_ID.fetch_add(1, Ordering::Relaxed);

            if !is_tls {
                let now_instant = Instant::now();
                let meta = Arc::new(UpstreamConnMeta {
                    conn_id,
                    server_addr,
                    server_ip: server_addr.ip().to_string(),
                    server_port: server_addr.port(),
                    dns_ms,
                    tcp_connect_ms,
                    tls_handshake_ms: None,
                    server_connected_at: format_rfc3339_micros(Utc::now()),
                    server_connected_instant: now_instant,
                    tls_version: None,
                    tls_cipher: None,
                    tls_alpn: None,
                    cert_subject: None,
                    cert_issuer: None,
                    mtls_cn,
                    remapped_target,
                    via_proxy_addr: None,
                    is_tls: false,
                    via_http_proxy: false,
                    claimed: AtomicBool::new(false),
                });
                return Ok(InstrumentedStream::Plain {
                    io: TokioIo::new(tcp_stream),
                    meta,
                });
            }

            // 3. TLS Handshake phase (preserving original URI hostname for SNI!)
            let sni_clean = orig_host.trim_matches(['[', ']']).to_string();
            let server_name = ServerName::try_from(sni_clean.clone()).map_err(|_| {
                UpstreamConnectorError::new(format!("Invalid TLS ServerName for '{sni_clean}'"))
            })?;

            let tls_timeout = remaining_connect_budget("TLS handshake")?;
            let tls_start = Instant::now();
            let tls_connector = TlsConnector::from(tls_config);
            let tls_stream = tokio::time::timeout(
                tls_timeout,
                tls_connector.connect(server_name, tcp_stream),
            )
            .await
            .map_err(|_| {
                UpstreamConnectorError::new(format!(
                    "TLS handshake timed out after {} s connect deadline for {orig_host}:{orig_port}",
                    connect_timeout.as_secs()
                ))
            })?
            .map_err(|e| {
                UpstreamConnectorError::new(format!(
                    "TLS handshake failed for {orig_host}:{orig_port}: {e}"
                ))
            })?;
            let tls_handshake_ms = Some(elapsed_ms(tls_start));
            let now_instant = Instant::now();

            let TlsConnDetails {
                tls_version,
                tls_cipher,
                tls_alpn,
                cert_subject,
                cert_issuer,
            } = extract_tls_conn_details(tls_stream.get_ref().1);

            let meta = Arc::new(UpstreamConnMeta {
                conn_id,
                server_addr,
                server_ip: server_addr.ip().to_string(),
                server_port: server_addr.port(),
                dns_ms,
                tcp_connect_ms,
                tls_handshake_ms,
                server_connected_at: format_rfc3339_micros(Utc::now()),
                server_connected_instant: now_instant,
                tls_version,
                tls_cipher,
                tls_alpn,
                cert_subject,
                cert_issuer,
                mtls_cn,
                remapped_target,
                via_proxy_addr: None,
                is_tls: true,
                via_http_proxy: false,
                claimed: AtomicBool::new(false),
            });

            Ok(InstrumentedStream::Tls {
                io: Box::new(TokioIo::new(tls_stream)),
                meta,
            })
        })
    }
}

pub struct RequestSendTracker {
    done_instant: OnceLock<Instant>,
    bytes_sent: AtomicUsize,
}

impl RequestSendTracker {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            done_instant: OnceLock::new(),
            bytes_sent: AtomicUsize::new(0),
        })
    }

    fn mark_done(&self) {
        let _ = self.done_instant.set(Instant::now());
    }

    pub fn done_instant(&self) -> Option<Instant> {
        self.done_instant.get().copied()
    }

    pub fn bytes_sent(&self) -> usize {
        self.bytes_sent.load(Ordering::Relaxed)
    }
}

pub struct TrackedRequestBody {
    data: Option<Bytes>,
    tracker: Arc<RequestSendTracker>,
}

impl TrackedRequestBody {
    fn new(data: Bytes) -> (Self, Arc<RequestSendTracker>) {
        let tracker = RequestSendTracker::new();
        let opt = if data.is_empty() { None } else { Some(data) };
        (
            Self {
                data: opt,
                tracker: Arc::clone(&tracker),
            },
            tracker,
        )
    }
}

impl HttpBody for TrackedRequestBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match self.data.take() {
            Some(b) if !b.is_empty() => {
                self.tracker.bytes_sent.fetch_add(b.len(), Ordering::Relaxed);
                Poll::Ready(Some(Ok(Frame::data(b))))
            }
            _ => {
                self.tracker.mark_done();
                Poll::Ready(None)
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        let ended = !self.data.as_ref().is_some_and(|b| !b.is_empty());
        if ended {
            self.tracker.mark_done();
        }
        ended
    }

    fn size_hint(&self) -> SizeHint {
        let len = self.data.as_ref().map_or(0, Bytes::len) as u64;
        SizeHint::with_exact(len)
    }
}

type ResponseDoneCallback = Box<dyn FnOnce(usize, Instant) + Send + Sync>;

/// Wraps an outgoing `BoxBody` sent back to the local client and fires an optional completion
/// callback once the last frame finishes streaming (or when the response body is dropped).
pub struct TrackedResponseBody {
    inner: BoxBody<Bytes, Infallible>,
    bytes_sent: usize,
    on_complete: Option<ResponseDoneCallback>,
}

impl TrackedResponseBody {
    pub fn new(
        inner: BoxBody<Bytes, Infallible>,
        on_complete: impl FnOnce(usize, Instant) + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner,
            bytes_sent: 0,
            on_complete: Some(Box::new(on_complete)),
        }
    }

    fn finish(&mut self) {
        if let Some(cb) = self.on_complete.take() {
            cb(self.bytes_sent, Instant::now());
        }
    }
}

impl HttpBody for TrackedResponseBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match Pin::new(&mut self.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    self.bytes_sent = self.bytes_sent.saturating_add(data.len());
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(err))) => match err {},
            Poll::Ready(None) => {
                self.finish();
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for TrackedResponseBody {
    fn drop(&mut self) {
        self.finish();
    }
}

#[derive(Debug)]
pub enum UpstreamClientError {
    InvalidRequest(String),
    Forbidden(String),
    Connect(String),
    Timeout(String),
    Transport(String),
}

impl std::fmt::Display for UpstreamClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(msg)
            | Self::Forbidden(msg)
            | Self::Connect(msg)
            | Self::Timeout(msg)
            | Self::Transport(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for UpstreamClientError {}

impl UpstreamClientError {
    pub fn is_retryable_connection_error(&self) -> bool {
        matches!(self, Self::Transport(_))
    }

    pub fn status_hint(&self) -> StatusCode {
        match self {
            Self::Timeout(_) => StatusCode::GATEWAY_TIMEOUT,
            Self::InvalidRequest(_) => StatusCode::BAD_REQUEST,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::Connect(_) | Self::Transport(_) => StatusCode::BAD_GATEWAY,
        }
    }

    pub fn proxy_error_code(&self) -> &'static str {
        match self {
            Self::Timeout(_) => "upstream-response-timeout",
            Self::Forbidden(_) => "forbidden-remote-target",
            Self::Connect(msg) => {
                if msg.to_ascii_lowercase().contains("timed out") {
                    "upstream-connect-timeout"
                } else {
                    "upstream-connect-error"
                }
            }
            Self::Transport(_) => "upstream-connect-error",
            Self::InvalidRequest(_) => "upstream-invalid-request",
        }
    }
}

pub struct UpstreamExchange {
    pub response: Response<Incoming>,
    pub conn_meta: Option<Arc<UpstreamConnMeta>>,
    pub claimed: Option<ClaimedConnMetrics>,
    pub proxy_begin_request_at: String,
    pub proxy_begin_request_instant: Instant,
    pub proxy_begin_request_utc: DateTime<Utc>,
    pub server_got_request_at: String,
    pub server_got_request_instant: Instant,
    pub got_response_headers_at: String,
    pub got_response_headers_instant: Instant,
    pub send_request_ms: f64,
    pub server_wait_ms: f64,
    pub final_url: String,
}

#[derive(Clone)]
pub struct UpstreamHttpClient {
    client: Client<InstrumentedConnector, TrackedRequestBody>,
    pre_remapped_client: Client<InstrumentedConnector, TrackedRequestBody>,
    mtls_cn: Option<String>,
    host_remap: Option<Arc<HostRemapRegistry>>,
    upstream_proxy: Option<Arc<UpstreamProxyManager>>,
    peer_is_remote: bool,
}

impl UpstreamHttpClient {
    pub fn build(
        host_remap: Option<Arc<HostRemapRegistry>>,
        upstream_proxy: Option<Arc<UpstreamProxyManager>>,
        client_auth: Option<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>, String)>,
        connect_timeout_sec: Arc<AtomicU64>,
        peer_is_remote: bool,
    ) -> Result<Self, String> {
        let mtls_cn = client_auth.as_ref().map(|(_, _, cn)| cn.clone());
        let connector = InstrumentedConnector::new(
            host_remap.clone(),
            upstream_proxy.clone(),
            client_auth,
            connect_timeout_sec,
            peer_is_remote,
        )?;
        let pre_remapped_connector = connector.clone().with_skip_host_remap(true);
        let client = Client::builder(TokioExecutor::new())
            .timer(TokioTimer::new())
            .pool_timer(TokioTimer::new())
            .pool_idle_timeout(Some(Duration::from_secs(35)))
            .http2_keep_alive_interval(Some(Duration::from_secs(20)))
            .http2_keep_alive_timeout(Duration::from_secs(10))
            .http2_keep_alive_while_idle(true)
            .build(connector);
        let pre_remapped_client = Client::builder(TokioExecutor::new())
            .timer(TokioTimer::new())
            .pool_timer(TokioTimer::new())
            .pool_idle_timeout(Some(Duration::from_secs(35)))
            .http2_keep_alive_interval(Some(Duration::from_secs(20)))
            .http2_keep_alive_timeout(Duration::from_secs(10))
            .http2_keep_alive_while_idle(true)
            .build(pre_remapped_connector);

        Ok(Self {
            client,
            pre_remapped_client,
            mtls_cn,
            host_remap,
            upstream_proxy,
            peer_is_remote,
        })
    }

    pub fn mtls_cn(&self) -> Option<&str> {
        self.mtls_cn.as_deref()
    }

    pub fn host_remap(&self) -> Option<&Arc<HostRemapRegistry>> {
        self.host_remap.as_ref()
    }

    pub fn peer_is_remote(&self) -> bool {
        self.peer_is_remote
    }

    pub async fn send_request(
        &self,
        method: Method,
        url: &str,
        headers: &[HeaderPair],
        host_header_override: Option<&str>,
        body: Bytes,
        response_timeout: Option<Duration>,
    ) -> Result<UpstreamExchange, UpstreamClientError> {
        let uri: Uri = url
            .parse()
            .map_err(|e| UpstreamClientError::InvalidRequest(format!("Invalid upstream URI '{url}': {e}")))?;

        let proxy_begin_request_instant = Instant::now();
        let proxy_begin_request_utc = Utc::now();
        let proxy_begin_request_at = format_rfc3339_micros(proxy_begin_request_utc);

        let mut request_uri = uri.clone();
        let mut effective_host_override = host_header_override.map(str::to_owned);
        let mut proxy_auth_header: Option<String> = None;
        let mut plain_http_remapped = false;

        if uri
            .scheme_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("http"))
        {
            if let (Some(ref mgr), Some(orig_host)) = (&self.upstream_proxy, uri.host()) {
                let orig_port = uri.port_u16().unwrap_or(80);
                let remap_rule = self
                    .host_remap
                    .as_ref()
                    .and_then(|reg| reg.match_host(orig_host));
                let remap_target_port = remap_rule
                    .as_ref()
                    .map(|r| r.target_port.unwrap_or(orig_port));
                if let Some(proxy_cfg) = mgr.resolve_for_target(
                    orig_host,
                    orig_port,
                    remap_rule.as_ref().map(|r| r.target_host.as_str()),
                    remap_target_port,
                ) {
                    if matches!(
                        proxy_cfg.protocol,
                        UpstreamProxyProtocol::Http | UpstreamProxyProtocol::Https
                    ) {
                        if !headers
                            .iter()
                            .any(|h| h.name.trim().eq_ignore_ascii_case(PROXY_AUTHORIZATION.as_str()))
                        {
                            proxy_auth_header = proxy_authorization_header_value(&proxy_cfg);
                        }
                        if let Some(rule) = remap_rule {
                            if self.peer_is_remote
                                && is_loopback_or_unspecified_host(&rule.target_host)
                            {
                                return Err(UpstreamClientError::Forbidden(format!(
                                    "Forbidden: remote LAN clients cannot connect via HOSTS Remapping to loopback or unspecified host '{}'",
                                    rule.target_host
                                )));
                            }
                            plain_http_remapped = true;
                            let target_port = rule.target_port.unwrap_or(orig_port);
                            let target_host_fmt =
                                HostRemapRegistry::format_host_for_authority(&rule.target_host);
                            let target_authority = if target_port == 80 {
                                target_host_fmt
                            } else {
                                format!("{target_host_fmt}:{target_port}")
                            };
                            let pq = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
                            if let Ok(remapped_uri) =
                                format!("http://{target_authority}{pq}").parse::<Uri>()
                            {
                                request_uri = remapped_uri;
                            }
                            if rule.preserve_host_header {
                                if effective_host_override.is_none()
                                    && !headers
                                        .iter()
                                        .any(|h| h.name.trim().eq_ignore_ascii_case(HOST.as_str()))
                                {
                                    effective_host_override =
                                        uri.authority().map(|a| a.as_str().to_string());
                                }
                            } else if effective_host_override.is_none() {
                                effective_host_override = Some(target_authority);
                            }
                        }
                    }
                }
            }
        }

        let body_is_empty = body.is_empty();
        let method_for_cl = method.clone();
        let (tracked_body, send_tracker) = TrackedRequestBody::new(body);
        let mut builder = Request::builder().method(method).uri(request_uri);

        let mut host_added = false;
        let mut has_content_length = false;
        let mut has_transfer_encoding = false;
        for pair in headers {
            let trimmed_name = pair.name.trim();
            if trimmed_name.is_empty() {
                continue;
            }
            if trimmed_name.eq_ignore_ascii_case(HOST.as_str())
                && (effective_host_override.is_some() || host_added)
            {
                continue;
            }
            if let (Ok(hn), Ok(hv)) = (
                HeaderName::from_bytes(trimmed_name.as_bytes()),
                pair.to_hyper_header_value(),
            ) {
                if hn == HOST {
                    host_added = true;
                } else if hn == CONTENT_LENGTH {
                    has_content_length = true;
                } else if hn == http::header::TRANSFER_ENCODING {
                    has_transfer_encoding = true;
                }
                builder = builder.header(hn, hv);
            }
        }
        if let Some(host_val) = effective_host_override.as_deref() {
            if let Ok(hv) = HeaderValue::from_bytes(host_val.as_bytes()) {
                builder = builder.header(HOST, hv);
            }
        }
        if let Some(auth_val) = proxy_auth_header.as_deref() {
            if let Ok(hv) = HeaderValue::from_str(auth_val) {
                builder = builder.header(PROXY_AUTHORIZATION, hv);
            }
        }
        if body_is_empty
            && !has_content_length
            && !has_transfer_encoding
            && matches!(method_for_cl, Method::POST | Method::PUT | Method::PATCH)
        {
            builder = builder.header(CONTENT_LENGTH, HeaderValue::from_static("0"));
        }

        let mut req = builder
            .body(tracked_body)
            .map_err(|e| UpstreamClientError::InvalidRequest(format!("Failed building upstream request: {e}")))?;

        if plain_http_remapped {
            req.extensions_mut().insert(HostRemapAlreadyApplied);
        }
        let target_client = if plain_http_remapped {
            &self.pre_remapped_client
        } else {
            &self.client
        };

        let req_result = match response_timeout {
            None => Ok(target_client.request(req).await),
            Some(timeout) => tokio::time::timeout(timeout, target_client.request(req)).await,
        };
        let response = match req_result {
            Ok(Ok(resp)) => resp,
            Ok(Err(err)) => {
                if let Some(forbidden_msg) = find_forbidden_connector_error(&err) {
                    return Err(UpstreamClientError::Forbidden(forbidden_msg));
                }
                let chain = format_hyper_client_error(&err);
                if err.is_connect() {
                    return Err(UpstreamClientError::Connect(chain));
                }
                return Err(UpstreamClientError::Transport(chain));
            }
            Err(_) => {
                let timeout_ms = response_timeout.map(|d| d.as_millis()).unwrap_or(0);
                return Err(UpstreamClientError::Timeout(format!(
                    "Upstream response headers (TTFB) timed out after {timeout_ms} ms while waiting for {url}. Connect completed; the upstream server did not send HTTP response headers in time (increase Response Header Timeout or set it to Unlimited in Settings)."
                )));
            }
        };

        let got_response_headers_instant = Instant::now();
        let got_response_headers_at = timestamp_at_instant(
            proxy_begin_request_instant,
            proxy_begin_request_utc,
            got_response_headers_instant,
        );

        let conn_meta = response.extensions().get::<Arc<UpstreamConnMeta>>().cloned();
        let claimed = conn_meta.as_ref().map(|m| m.claim_for_request());

        let is_reused = claimed.as_ref().is_some_and(|c| c.reused);
        let send_base = if !is_reused {
            conn_meta
                .as_ref()
                .map_or(proxy_begin_request_instant, |m| m.server_connected_instant)
        } else {
            proxy_begin_request_instant
        };

        let raw_done = send_tracker
            .done_instant()
            .unwrap_or(got_response_headers_instant);
        let server_got_request_instant = if raw_done < send_base {
            send_base
        } else if raw_done > got_response_headers_instant {
            got_response_headers_instant
        } else {
            raw_done
        };
        let server_got_request_at = timestamp_at_instant(
            proxy_begin_request_instant,
            proxy_begin_request_utc,
            server_got_request_instant,
        );

        let send_request_ms =
            duration_ms_f64(server_got_request_instant.saturating_duration_since(send_base));
        let server_wait_ms = duration_ms_f64(
            got_response_headers_instant.saturating_duration_since(server_got_request_instant),
        );

        Ok(UpstreamExchange {
            response,
            conn_meta,
            claimed,
            proxy_begin_request_at,
            proxy_begin_request_instant,
            proxy_begin_request_utc,
            server_got_request_at,
            server_got_request_instant,
            got_response_headers_at,
            got_response_headers_instant,
            send_request_ms,
            server_wait_ms,
            final_url: url.to_string(),
        })
    }

    pub async fn send_with_idempotent_retry(
        &self,
        method: Method,
        url: &str,
        headers: &[HeaderPair],
        host_header_override: Option<&str>,
        body: Bytes,
        response_timeout: Option<Duration>,
    ) -> Result<UpstreamExchange, UpstreamClientError> {
        let can_retry = matches!(method, Method::GET | Method::HEAD | Method::OPTIONS);
        match self
            .send_request(
                method.clone(),
                url,
                headers,
                host_header_override,
                body.clone(),
                response_timeout,
            )
            .await
        {
            Ok(resp) => Ok(resp),
            Err(first_err) if can_retry && first_err.is_retryable_connection_error() => {
                tracing::debug!(
                    "Retrying idempotent {} {} after pooled connection error: {}",
                    method,
                    url,
                    first_err
                );
                self.send_request(
                    method,
                    url,
                    headers,
                    host_header_override,
                    body,
                    response_timeout,
                )
                .await
            }
            Err(err) => Err(err),
        }
    }

    pub async fn send_following_redirects(
        &self,
        initial_method: Method,
        initial_url: &str,
        initial_headers: &[HeaderPair],
        initial_host_override: Option<&str>,
        initial_body: Bytes,
        response_timeout: Option<Duration>,
    ) -> Result<UpstreamExchange, UpstreamClientError> {
        let mut current_method = initial_method;
        let mut current_url = initial_url.to_string();
        let mut current_headers = initial_headers.to_vec();
        let mut current_host_override = initial_host_override.map(str::to_owned);
        let mut current_body = initial_body;

        let earliest_instant = Instant::now();
        let earliest_utc = Utc::now();
        let earliest_at = format_rfc3339_micros(earliest_utc);

        for hop in 0..=MAX_REDIRECT_HOPS {
            let mut exchange = self
                .send_with_idempotent_retry(
                    current_method.clone(),
                    &current_url,
                    &current_headers,
                    current_host_override.as_deref(),
                    current_body.clone(),
                    response_timeout,
                )
                .await?;

            let status = exchange.response.status();
            let location = exchange
                .response
                .headers()
                .get(http::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);

            let is_redirect = matches!(
                status,
                StatusCode::MOVED_PERMANENTLY
                    | StatusCode::FOUND
                    | StatusCode::SEE_OTHER
                    | StatusCode::TEMPORARY_REDIRECT
                    | StatusCode::PERMANENT_REDIRECT
            );

            if !is_redirect || location.is_none() || hop == MAX_REDIRECT_HOPS {
                exchange.proxy_begin_request_instant = earliest_instant;
                exchange.proxy_begin_request_utc = earliest_utc;
                exchange.proxy_begin_request_at = earliest_at;
                return Ok(exchange);
            }

            let raw_location = location.unwrap();
            let base = url::Url::parse(&current_url).map_err(|e| {
                UpstreamClientError::InvalidRequest(format!(
                    "Invalid redirect base URL '{current_url}': {e}"
                ))
            })?;
            let next_parsed = base.join(&raw_location).map_err(|e| {
                UpstreamClientError::InvalidRequest(format!(
                    "Invalid redirect Location '{raw_location}': {e}"
                ))
            })?;

            // Strip stale Host on authority change and sensitive headers on cross-origin redirect
            let same_authority = base.host_str() == next_parsed.host_str()
                && base.port_or_known_default() == next_parsed.port_or_known_default();
            if !same_authority {
                current_headers.retain(|h| !h.name.trim().eq_ignore_ascii_case(HOST.as_str()));
                current_host_override = None;
            }
            let same_origin = base.scheme() == next_parsed.scheme() && same_authority;
            if !same_origin {
                current_headers.retain(|h| {
                    !h.name.trim().eq_ignore_ascii_case(AUTHORIZATION.as_str())
                        && !h.name.trim().eq_ignore_ascii_case(COOKIE.as_str())
                        && !h.name
                            .trim()
                            .eq_ignore_ascii_case(PROXY_AUTHORIZATION.as_str())
                });
                current_host_override = None;
            }

            if matches!(
                status,
                StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND | StatusCode::SEE_OTHER
            ) && !matches!(current_method, Method::GET | Method::HEAD)
            {
                current_method = Method::GET;
                current_body = Bytes::new();
                current_headers.retain(|h| {
                    !h.name.trim().eq_ignore_ascii_case(CONTENT_LENGTH.as_str())
                        && !h.name.trim().eq_ignore_ascii_case(CONTENT_TYPE.as_str())
                });
            }

            current_url = next_parsed.to_string();
        }

        Err(UpstreamClientError::Transport(
            "Exceeded maximum redirect limit".to_string(),
        ))
    }
}

fn find_forbidden_connector_error(err: &(dyn std::error::Error + 'static)) -> Option<String> {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(source) = current {
        if let Some(conn_err) = source.downcast_ref::<UpstreamConnectorError>() {
            if conn_err.forbidden {
                return Some(conn_err.message.clone());
            }
        }
        current = source.source();
    }
    None
}

fn format_hyper_client_error(err: &dyn std::error::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut current = err.source();
    while let Some(source) = current {
        let text = source.to_string();
        if !text.is_empty() && parts.last() != Some(&text) {
            parts.push(text);
        }
        current = source.source();
    }
    parts.join(" -> ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DEFAULT_CONNECT_TIMEOUT_SEC;
    use bytes::Bytes;
    use http::Response;
    use http_body_util::Full;
    use hyper::service::service_fn;
    use hyper_util::server::conn::auto::Builder as AutoConnBuilder;
    use tokio::net::TcpListener;

    #[test]
    fn claim_for_request_charges_setup_only_once() {
        let meta = UpstreamConnMeta {
            conn_id: 77,
            server_addr: "93.184.216.34:443".parse().unwrap(),
            server_ip: "93.184.216.34".into(),
            server_port: 443,
            dns_ms: 12.5,
            tcp_connect_ms: 18.25,
            tls_handshake_ms: Some(24.75),
            server_connected_at: "2026-11-22T10:00:00.000000Z".into(),
            server_connected_instant: Instant::now(),
            tls_version: Some("TLS 1.3".into()),
            tls_cipher: Some("TLS13_AES_256_GCM_SHA384".into()),
            tls_alpn: Some("h2".into()),
            cert_subject: Some("CN=example.com".into()),
            cert_issuer: Some("CN=Example CA".into()),
            mtls_cn: None,
            remapped_target: None,
            via_proxy_addr: None,
            is_tls: true,
            via_http_proxy: false,
            claimed: AtomicBool::new(false),
        };

        let first = meta.claim_for_request();
        assert!(!first.reused);
        assert_eq!(first.dns_ms, 12.5);
        assert_eq!(first.tcp_connect_ms, 18.25);
        assert_eq!(first.tls_handshake_ms, Some(24.75));
        assert!(first.server_connected_at.is_some());

        let second = meta.claim_for_request();
        assert!(second.reused);
        assert_eq!(second.dns_ms, 0.0);
        assert_eq!(second.tcp_connect_ms, 0.0);
        assert_eq!(second.tls_handshake_ms, Some(0.0));
        assert!(second.server_connected_at.is_none());
    }

    #[tokio::test]
    async fn upstream_http_client_tracks_cold_vs_pooled_reuse() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(|_req: Request<Incoming>| async {
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"ok"))))
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        let client = UpstreamHttpClient::build(
            None,
            None,
            None,
            Arc::new(AtomicU64::new(DEFAULT_CONNECT_TIMEOUT_SEC)),
            false,
        )
        .unwrap();
        let url = format!("http://{addr}/hello");

        let first = client
            .send_request(
                Method::GET,
                &url,
                &[],
                None,
                Bytes::new(),
                Some(Duration::from_secs(5)),
            )
            .await
            .unwrap();
        let first_meta = first.conn_meta.as_ref().unwrap();
        let first_claimed = first.claimed.as_ref().unwrap();
        assert!(!first_claimed.reused);
        assert_eq!(first_claimed.dns_ms, 0.0);
        assert!(first_claimed.tcp_connect_ms >= 0.0);
        assert_eq!(first_meta.server_ip, "127.0.0.1");
        assert_eq!(first_meta.server_port, addr.port());
        let first_conn_id = first_meta.conn_id;

        // Drain body so HTTP/1.1 connection returns to pool
        use http_body_util::BodyExt;
        let _ = first.response.into_body().collect().await.unwrap();
        tokio::task::yield_now().await;

        let second = client
            .send_request(
                Method::GET,
                &url,
                &[],
                None,
                Bytes::new(),
                Some(Duration::from_secs(5)),
            )
            .await
            .unwrap();
        let second_meta = second.conn_meta.as_ref().unwrap();
        let second_claimed = second.claimed.as_ref().unwrap();
        assert!(second_claimed.reused);
        assert_eq!(second_meta.conn_id, first_conn_id);
        assert_eq!(second_claimed.dns_ms, 0.0);
        assert_eq!(second_claimed.tcp_connect_ms, 0.0);
        assert_eq!(second_claimed.tls_handshake_ms, None);
    }

    #[tokio::test]
    async fn send_following_redirects_strips_host_header_on_authority_change() {
        use std::sync::Mutex;

        let seen_hosts: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));

        let listener_b = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_b = listener_b.local_addr().unwrap();
        let seen_b = Arc::clone(&seen_hosts);
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener_b.accept().await {
                let io = TokioIo::new(stream);
                let svc = service_fn(move |req: Request<Incoming>| {
                    let seen = Arc::clone(&seen_b);
                    async move {
                        let host = req
                            .headers()
                            .get(HOST)
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_owned);
                        seen.lock().unwrap().push(host.clone());
                        let body = format!("host={}", host.unwrap_or_default());
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from(body))))
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection(io, svc)
                    .await;
            }
        });

        let listener_a = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_a = listener_a.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener_a.accept().await {
                let io = TokioIo::new(stream);
                let svc = service_fn(move |_req: Request<Incoming>| async move {
                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(StatusCode::FOUND)
                            .header(http::header::LOCATION, format!("http://{addr_b}/dest"))
                            .body(Full::new(Bytes::new()))
                            .unwrap(),
                    )
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection(io, svc)
                    .await;
            }
        });

        let client = UpstreamHttpClient::build(
            None,
            None,
            None,
            Arc::new(AtomicU64::new(DEFAULT_CONNECT_TIMEOUT_SEC)),
            false,
        )
        .unwrap();
        let headers = vec![HeaderPair::new("Host", addr_a.to_string())];
        let ex = client
            .send_following_redirects(
                Method::GET,
                &format!("http://{addr_a}/start"),
                &headers,
                Some(&addr_a.to_string()),
                Bytes::new(),
                Some(Duration::from_secs(5)),
            )
            .await
            .unwrap();
        assert_eq!(ex.response.status(), StatusCode::OK);
        use http_body_util::BodyExt;
        let body = ex.response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            String::from_utf8_lossy(&body),
            format!("host={addr_b}")
        );
        assert_eq!(
            seen_hosts.lock().unwrap().as_slice(),
            &[Some(addr_b.to_string())]
        );
    }

    #[tokio::test]
    async fn plain_http_via_http_proxy_with_host_remap_rewrites_target_and_sets_via_telemetry() {
        use crate::models::{HostRemapRule, UpstreamProxyConfig};
        use std::sync::Mutex;

        let target_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_addr = target_listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = target_listener.accept().await {
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(|req: Request<Incoming>| async move {
                        let host = req
                            .headers()
                            .get(HOST)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from(format!(
                            "host={host};path={}",
                            req.uri().path()
                        )))))
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        type RecordedProxyRequests = Arc<Mutex<Vec<(String, Option<String>)>>>;
        let recorded_proxy_uris: RecordedProxyRequests = Arc::new(Mutex::new(Vec::new()));
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let recorded_srv = Arc::clone(&recorded_proxy_uris);
        tokio::spawn(async move {
            while let Ok((stream, _)) = proxy_listener.accept().await {
                let recorded = Arc::clone(&recorded_srv);
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req: Request<Incoming>| {
                        let recorded = Arc::clone(&recorded);
                        async move {
                            let uri_str = req.uri().to_string();
                            let host_hdr = req
                                .headers()
                                .get(HOST)
                                .and_then(|v| v.to_str().ok())
                                .map(str::to_owned);
                            recorded.lock().unwrap().push((uri_str, host_hdr.clone()));

                            let authority = req.uri().authority().unwrap().as_str().to_string();
                            let path = req
                                .uri()
                                .path_and_query()
                                .map(|p| p.as_str())
                                .unwrap_or("/");
                            let mut target_tcp = TcpStream::connect(&authority).await.unwrap();
                            use tokio::io::{AsyncReadExt, AsyncWriteExt};
                            let raw_req = format!(
                                "GET {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                                host_hdr.unwrap_or(authority)
                            );
                            target_tcp.write_all(raw_req.as_bytes()).await.unwrap();
                            let mut raw_resp = Vec::new();
                            let _ = target_tcp.read_to_end(&mut raw_resp).await;
                            let body_bytes = raw_resp
                                .windows(4)
                                .position(|w| w == b"\r\n\r\n")
                                .map(|pos| raw_resp[pos + 4..].to_vec())
                                .unwrap_or_default();
                            Ok::<_, Infallible>(Response::new(Full::new(Bytes::from(body_bytes))))
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        let host_remap = Arc::new(HostRemapRegistry::new());
        host_remap
            .set_rules(vec![HostRemapRule {
                id: "http-proxy-remap".into(),
                enabled: true,
                source_pattern: "api.virtual-proxy.invalid".into(),
                target_host: "127.0.0.1".into(),
                target_port: Some(target_addr.port()),
                preserve_host_header: true,
                comment: String::new(),
            }])
            .unwrap();

        let upstream_proxy = Arc::new(UpstreamProxyManager::new());
        upstream_proxy
            .set_config(UpstreamProxyConfig {
                enabled: true,
                protocol: UpstreamProxyProtocol::Http,
                host: "127.0.0.1".into(),
                port: proxy_addr.port(),
                username: None,
                password: None,
                has_password: false,
                bypass_list: Vec::new(),
            })
            .unwrap();

        let client = UpstreamHttpClient::build(
            Some(Arc::clone(&host_remap)),
            Some(Arc::clone(&upstream_proxy)),
            None,
            Arc::new(AtomicU64::new(DEFAULT_CONNECT_TIMEOUT_SEC)),
            false,
        )
        .unwrap();

        let ex1 = client
            .send_request(
                Method::GET,
                "http://api.virtual-proxy.invalid/probe",
                &[],
                None,
                Bytes::new(),
                Some(Duration::from_secs(5)),
            )
            .await
            .unwrap();
        let meta1 = ex1.conn_meta.as_ref().unwrap().clone();
        assert_eq!(meta1.server_ip, format!("via {proxy_addr}"));
        assert_eq!(
            meta1.via_proxy_addr.as_deref(),
            Some(format!("HTTP {proxy_addr}").as_str())
        );
        use http_body_util::BodyExt;
        let body1 = ex1.response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            String::from_utf8_lossy(&body1),
            "host=api.virtual-proxy.invalid;path=/probe"
        );

        // Now with preserve_host_header = false
        host_remap
            .set_rules(vec![HostRemapRule {
                id: "http-proxy-remap".into(),
                enabled: true,
                source_pattern: "api.virtual-proxy.invalid".into(),
                target_host: "127.0.0.1".into(),
                target_port: Some(target_addr.port()),
                preserve_host_header: false,
                comment: String::new(),
            }])
            .unwrap();

        let ex2 = client
            .send_request(
                Method::GET,
                "http://api.virtual-proxy.invalid/override",
                &[],
                None,
                Bytes::new(),
                Some(Duration::from_secs(5)),
            )
            .await
            .unwrap();
        let body2 = ex2.response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            String::from_utf8_lossy(&body2),
            format!("host={target_addr};path=/override")
        );

        let recorded = recorded_proxy_uris.lock().unwrap();
        assert_eq!(
            recorded[0],
            (
                format!("http://{target_addr}/probe"),
                Some("api.virtual-proxy.invalid".to_string())
            )
        );
        assert_eq!(
            recorded[1],
            (
                format!("http://{target_addr}/override"),
                Some(target_addr.to_string())
            )
        );
    }

    #[test]
    fn upstream_timeout_config_validation_and_normalization() {
        let def = crate::models::UpstreamTimeoutConfig::default();
        assert_eq!(def.connect_timeout_sec, 15);
        assert_eq!(def.response_header_timeout_sec, 0);
        assert_eq!(def.composer_timeout_sec, 120);
        assert!(def.validate().is_ok());

        let invalid_connect_zero = crate::models::UpstreamTimeoutConfig {
            connect_timeout_sec: 0,
            ..def
        };
        assert!(invalid_connect_zero.validate().is_err());

        let invalid_ttfb_short = crate::models::UpstreamTimeoutConfig {
            response_header_timeout_sec: 3,
            ..def
        };
        assert!(invalid_ttfb_short.validate().is_err());

        let invalid_composer_over = crate::models::UpstreamTimeoutConfig {
            composer_timeout_sec: 4000,
            ..def
        };
        assert!(invalid_composer_over.validate().is_err());

        let boundary = crate::models::UpstreamTimeoutConfig {
            connect_timeout_sec: 300,
            response_header_timeout_sec: 3600,
            composer_timeout_sec: 0,
        };
        assert!(boundary.validate().is_ok());

        let out_of_bounds = crate::models::UpstreamTimeoutConfig {
            connect_timeout_sec: 0,
            response_header_timeout_sec: 2,
            composer_timeout_sec: 9999,
        };
        let normalized = out_of_bounds.normalized();
        assert_eq!(normalized.connect_timeout_sec, 1);
        assert_eq!(normalized.response_header_timeout_sec, 5);
        assert_eq!(normalized.composer_timeout_sec, 3600);
    }

    #[tokio::test]
    async fn stage39_unlimited_ttfb_receives_slow_500_while_finite_timeout_errors() {
        use http_body_util::BodyExt;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let io = TokioIo::new(stream);
                tokio::spawn(async move {
                    let svc = service_fn(|_req: Request<Incoming>| async move {
                        tokio::time::sleep(Duration::from_millis(450)).await;
                        let resp = Response::builder()
                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                            .body(Full::new(Bytes::from("slow-backend-500")))
                            .unwrap();
                        Ok::<_, Infallible>(resp)
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        let client = UpstreamHttpClient::build(
            None,
            None,
            None,
            Arc::new(AtomicU64::new(DEFAULT_CONNECT_TIMEOUT_SEC)),
            false,
        )
        .unwrap();
        let url = format!("http://{addr}/slow-500");

        let ex = client
            .send_request(Method::GET, &url, &[], None, Bytes::new(), None)
            .await
            .expect("Unlimited TTFB (None) should transparently wait for slow 500");
        assert_eq!(ex.response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = ex.response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body, Bytes::from("slow-backend-500"));

        let err = match client
            .send_request(
                Method::GET,
                &url,
                &[],
                None,
                Bytes::new(),
                Some(Duration::from_millis(120)),
            )
            .await
        {
            Ok(_) => panic!("Finite TTFB timeout should fail before slow server headers"),
            Err(e) => e,
        };
        assert!(matches!(err, UpstreamClientError::Timeout(_)));
        assert_eq!(err.status_hint(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(err.proxy_error_code(), "upstream-response-timeout");
    }

    #[tokio::test]
    async fn stage39_connect_timeout_enforces_stalled_tls_handshake_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            if let Ok((_socket, _)) = listener.accept().await {
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });

        let client = UpstreamHttpClient::build(None, None, None, Arc::new(AtomicU64::new(1)), false).unwrap();
        let url = format!("https://{addr}/tls-stall");

        let started = Instant::now();
        let err = match client
            .send_request(Method::GET, &url, &[], None, Bytes::new(), None)
            .await
        {
            Ok(_) => panic!("Stalled TLS handshake must fail with connect timeout even when TTFB is Unlimited"),
            Err(e) => e,
        };
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(matches!(err, UpstreamClientError::Connect(_)));
        assert_eq!(err.status_hint(), StatusCode::BAD_GATEWAY);
        assert_eq!(err.proxy_error_code(), "upstream-connect-timeout");
        assert!(err.to_string().to_ascii_lowercase().contains("timed out"));
    }

    #[tokio::test]
    async fn sec01_remote_connector_blocks_dns_to_loopback_and_hosts_remap_to_loopback() {
        use crate::models::HostRemapRule;
        use http_body_util::BodyExt;

        let accepted = Arc::new(AtomicUsize::new(0));
        let accepted_srv = Arc::clone(&accepted);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                accepted_srv.fetch_add(1, Ordering::Relaxed);
                let io = TokioIo::new(stream);
                tokio::spawn(async move {
                    let svc = service_fn(|_req: Request<Incoming>| async move {
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"local-secret"))))
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        // 1. Post-lookup_host check directly rejects DNS resolving to loopback for remote peers
        let dns_err = resolve_and_validate_addrs(
            "localhost",
            addr.port(),
            Duration::from_secs(5),
            Duration::from_secs(5),
            true,
        )
        .await
        .expect_err("remote peer DNS resolution to loopback must be forbidden");
        assert!(dns_err.forbidden);
        assert!(dns_err.to_string().contains("Forbidden"));

        // 2. Remote UpstreamHttpClient rejects http://localhost:<port>/ with Forbidden without touching socket
        let remote_client = UpstreamHttpClient::build(
            None,
            None,
            None,
            Arc::new(AtomicU64::new(DEFAULT_CONNECT_TIMEOUT_SEC)),
            true,
        )
        .unwrap();
        assert!(remote_client.peer_is_remote());

        let remote_err = match remote_client
            .send_request(
                Method::GET,
                &format!("http://localhost:{}/secret", addr.port()),
                &[],
                None,
                Bytes::new(),
                Some(Duration::from_secs(3)),
            )
            .await
        {
            Ok(_) => panic!("remote client must not connect to localhost"),
            Err(e) => e,
        };
        assert!(matches!(remote_err, UpstreamClientError::Forbidden(_)));
        assert_eq!(remote_err.status_hint(), StatusCode::FORBIDDEN);
        assert_eq!(remote_err.proxy_error_code(), "forbidden-remote-target");
        assert_eq!(accepted.load(Ordering::Relaxed), 0);

        // 3. Remote client with HOSTS Remapping targeting 127.0.0.1 is rejected with Forbidden, while local client succeeds
        let host_remap = Arc::new(HostRemapRegistry::new());
        host_remap
            .set_rules(vec![HostRemapRule {
                id: "remap-loopback".into(),
                enabled: true,
                source_pattern: "remapped-local.example".into(),
                target_host: "127.0.0.1".into(),
                target_port: Some(addr.port()),
                preserve_host_header: true,
                comment: String::new(),
            }])
            .unwrap();

        let remote_remap_client = UpstreamHttpClient::build(
            Some(Arc::clone(&host_remap)),
            None,
            None,
            Arc::new(AtomicU64::new(DEFAULT_CONNECT_TIMEOUT_SEC)),
            true,
        )
        .unwrap();
        let remap_err = match remote_remap_client
            .send_request(
                Method::GET,
                "http://remapped-local.example/secret",
                &[],
                None,
                Bytes::new(),
                Some(Duration::from_secs(3)),
            )
            .await
        {
            Ok(_) => panic!("remote client must not connect via HOSTS Remapping to 127.0.0.1"),
            Err(e) => e,
        };
        assert!(matches!(remap_err, UpstreamClientError::Forbidden(_)));
        assert_eq!(remap_err.status_hint(), StatusCode::FORBIDDEN);
        assert_eq!(accepted.load(Ordering::Relaxed), 0);

        let local_remap_client = UpstreamHttpClient::build(
            Some(host_remap),
            None,
            None,
            Arc::new(AtomicU64::new(DEFAULT_CONNECT_TIMEOUT_SEC)),
            false,
        )
        .unwrap();
        assert!(!local_remap_client.peer_is_remote());
        let ok_resp = local_remap_client
            .send_request(
                Method::GET,
                "http://remapped-local.example/secret",
                &[],
                None,
                Bytes::new(),
                Some(Duration::from_secs(3)),
            )
            .await
            .expect("local loopback client must succeed");
        assert_eq!(ok_resp.response.status(), StatusCode::OK);
        let body = ok_resp.response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body, Bytes::from_static(b"local-secret"));
        assert_eq!(accepted.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn bug06_plain_http_via_http_proxy_with_chained_host_remap_does_not_double_remap() {
        use crate::models::{HostRemapRule, UpstreamProxyConfig};
        use std::sync::Mutex;

        type RecordedProxyRequests = Arc<Mutex<Vec<(String, Option<String>)>>>;
        let recorded_proxy_uris: RecordedProxyRequests = Arc::new(Mutex::new(Vec::new()));
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();
        let recorded_srv = Arc::clone(&recorded_proxy_uris);
        tokio::spawn(async move {
            while let Ok((stream, _)) = proxy_listener.accept().await {
                let recorded = Arc::clone(&recorded_srv);
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req: Request<Incoming>| {
                        let recorded = Arc::clone(&recorded);
                        async move {
                            let uri_str = req.uri().to_string();
                            let host_hdr = req
                                .headers()
                                .get(HOST)
                                .and_then(|v| v.to_str().ok())
                                .map(str::to_owned);
                            recorded.lock().unwrap().push((uri_str, host_hdr));
                            Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(
                                b"single-remap-ok",
                            ))))
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        let host_remap = Arc::new(HostRemapRegistry::new());
        host_remap
            .set_rules(vec![
                HostRemapRule {
                    id: "hop-1".into(),
                    enabled: true,
                    source_pattern: "a.chain-hop.invalid".into(),
                    target_host: "b.chain-hop.invalid".into(),
                    target_port: Some(8081),
                    preserve_host_header: false,
                    comment: String::new(),
                },
                HostRemapRule {
                    id: "hop-2".into(),
                    enabled: true,
                    source_pattern: "b.chain-hop.invalid".into(),
                    target_host: "c.chain-hop.invalid".into(),
                    target_port: Some(9092),
                    preserve_host_header: false,
                    comment: String::new(),
                },
            ])
            .unwrap();

        let upstream_proxy = Arc::new(UpstreamProxyManager::new());
        upstream_proxy
            .set_config(UpstreamProxyConfig {
                enabled: true,
                protocol: UpstreamProxyProtocol::Http,
                host: "127.0.0.1".into(),
                port: proxy_addr.port(),
                username: None,
                password: None,
                has_password: false,
                bypass_list: Vec::new(),
            })
            .unwrap();

        let client = UpstreamHttpClient::build(
            Some(host_remap),
            Some(upstream_proxy),
            None,
            Arc::new(AtomicU64::new(DEFAULT_CONNECT_TIMEOUT_SEC)),
            false,
        )
        .unwrap();

        let ex = client
            .send_request(
                Method::GET,
                "http://a.chain-hop.invalid/step1",
                &[],
                None,
                Bytes::new(),
                Some(Duration::from_secs(5)),
            )
            .await
            .unwrap();
        assert_eq!(ex.response.status(), StatusCode::OK);
        use http_body_util::BodyExt;
        let body = ex.response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body, Bytes::from_static(b"single-remap-ok"));

        let captured = recorded_proxy_uris.lock().unwrap();
        assert_eq!(
            captured.as_slice(),
            &[(
                "http://b.chain-hop.invalid:8081/step1".to_string(),
                Some("b.chain-hop.invalid:8081".to_string())
            )]
        );
    }
}
