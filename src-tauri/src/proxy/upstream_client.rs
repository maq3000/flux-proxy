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

use crate::models::HeaderPair;
use crate::proxy::hosts::HostRemapRegistry;

const CONNECT_TIMEOUT_DEFAULT: Duration = Duration::from_secs(15);
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

fn default_root_store() -> Arc<rustls::RootCertStore> {
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
    pub is_tls: bool,
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
}

impl InstrumentedStream {
    fn meta(&self) -> &Arc<UpstreamConnMeta> {
        match self {
            Self::Plain { meta, .. } | Self::Tls { meta, .. } => meta,
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
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), io::Error>> {
        match &mut *self {
            Self::Plain { io, .. } => Pin::new(io).poll_flush(cx),
            Self::Tls { io, .. } => Pin::new(io.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Result<(), io::Error>> {
        match &mut *self {
            Self::Plain { io, .. } => Pin::new(io).poll_shutdown(cx),
            Self::Tls { io, .. } => Pin::new(io.as_mut()).poll_shutdown(cx),
        }
    }

    fn is_write_vectored(&self) -> bool {
        match self {
            Self::Plain { io, .. } => io.is_write_vectored(),
            Self::Tls { io, .. } => io.is_write_vectored(),
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
        }
    }
}

impl Connection for InstrumentedStream {
    fn connected(&self) -> Connected {
        let meta = self.meta();
        let mut connected = Connected::new().extra(Arc::clone(meta));
        if meta.tls_alpn.as_deref() == Some("h2") {
            connected = connected.negotiated_h2();
        }
        connected
    }
}

#[derive(Debug)]
pub struct UpstreamConnectorError(pub String);

impl std::fmt::Display for UpstreamConnectorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UpstreamConnectorError {}

#[derive(Clone)]
pub struct InstrumentedConnector {
    tls_config: Arc<rustls::ClientConfig>,
    host_remap: Option<Arc<HostRemapRegistry>>,
    connect_timeout: Duration,
    mtls_cn: Option<String>,
}

impl InstrumentedConnector {
    pub fn new(
        host_remap: Option<Arc<HostRemapRegistry>>,
        client_auth: Option<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>, String)>,
        connect_timeout: Duration,
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
            connect_timeout,
            mtls_cn,
        })
    }
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
        let connect_timeout = self.connect_timeout;
        let mtls_cn = self.mtls_cn.clone();

        Box::pin(async move {
            let scheme = dst.scheme_str().unwrap_or("http");
            let is_tls = scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("wss");
            let orig_host = dst
                .host()
                .ok_or_else(|| UpstreamConnectorError(format!("Missing host in URI: {dst}")))?
                .to_string();
            let orig_port = dst
                .port_u16()
                .unwrap_or(if is_tls { 443 } else { 80 });

            let remap_rule = host_remap.as_ref().and_then(|reg| reg.match_host(&orig_host));
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

            // 1. DNS Resolution phase
            let (addrs, dns_ms): (Vec<SocketAddr>, f64) =
                if let Ok(ip) = connect_host.parse::<IpAddr>() {
                    (vec![SocketAddr::new(ip, connect_port)], 0.0)
                } else {
                    let dns_start = Instant::now();
                    let resolved_iter =
                        tokio::time::timeout(
                            connect_timeout,
                            tokio::net::lookup_host((connect_host.as_str(), connect_port)),
                        )
                        .await
                        .map_err(|_| {
                            UpstreamConnectorError(format!(
                                "DNS lookup timed out for {connect_host}:{connect_port}"
                            ))
                        })?
                        .map_err(|e| {
                            UpstreamConnectorError(format!(
                                "DNS lookup failed for {connect_host}:{connect_port}: {e}"
                            ))
                        })?;
                    let collected: Vec<SocketAddr> = resolved_iter.collect();
                    if collected.is_empty() {
                        return Err(UpstreamConnectorError(format!(
                            "DNS lookup returned no addresses for {connect_host}:{connect_port}"
                        )));
                    }
                    (collected, elapsed_ms(dns_start))
                };

            // 2. TCP Connect phase
            let tcp_start = Instant::now();
            let deadline = tcp_start + connect_timeout;
            let mut tcp_stream_opt: Option<TcpStream> = None;
            let mut last_tcp_err: Option<String> = None;

            for addr in addrs {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    last_tcp_err = Some(format!(
                        "TCP connect timed out after {} ms",
                        connect_timeout.as_millis()
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
                        last_tcp_err = Some(format!("{addr}: timed out"));
                    }
                }
            }

            let tcp_stream = tcp_stream_opt.ok_or_else(|| {
                UpstreamConnectorError(format!(
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
                    is_tls: false,
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
                UpstreamConnectorError(format!("Invalid TLS ServerName for '{sni_clean}'"))
            })?;

            let tls_start = Instant::now();
            let tls_connector = TlsConnector::from(tls_config);
            let tls_stream = tokio::time::timeout(
                connect_timeout,
                tls_connector.connect(server_name, tcp_stream),
            )
            .await
            .map_err(|_| {
                UpstreamConnectorError(format!(
                    "TLS handshake timed out for {orig_host}:{orig_port}"
                ))
            })?
            .map_err(|e| {
                UpstreamConnectorError(format!("TLS handshake failed for {orig_host}:{orig_port}: {e}"))
            })?;
            let tls_handshake_ms = Some(elapsed_ms(tls_start));
            let now_instant = Instant::now();

            let conn_info = tls_stream.get_ref().1;
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
                is_tls: true,
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
    Connect(String),
    Timeout(String),
    Transport(String),
}

impl std::fmt::Display for UpstreamClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(msg)
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
            Self::Connect(_) | Self::Transport(_) => StatusCode::BAD_GATEWAY,
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
    mtls_cn: Option<String>,
    host_remap: Option<Arc<HostRemapRegistry>>,
}

impl UpstreamHttpClient {
    pub fn build(
        host_remap: Option<Arc<HostRemapRegistry>>,
        client_auth: Option<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>, String)>,
    ) -> Result<Self, String> {
        let mtls_cn = client_auth.as_ref().map(|(_, _, cn)| cn.clone());
        let connector =
            InstrumentedConnector::new(host_remap.clone(), client_auth, CONNECT_TIMEOUT_DEFAULT)?;
        let client = Client::builder(TokioExecutor::new())
            .timer(TokioTimer::new())
            .pool_timer(TokioTimer::new())
            .pool_idle_timeout(Some(Duration::from_secs(35)))
            .http2_keep_alive_interval(Some(Duration::from_secs(20)))
            .http2_keep_alive_timeout(Duration::from_secs(10))
            .http2_keep_alive_while_idle(true)
            .build(connector);

        Ok(Self {
            client,
            mtls_cn,
            host_remap,
        })
    }

    pub fn mtls_cn(&self) -> Option<&str> {
        self.mtls_cn.as_deref()
    }

    pub fn host_remap(&self) -> Option<&Arc<HostRemapRegistry>> {
        self.host_remap.as_ref()
    }

    pub async fn send_request(
        &self,
        method: Method,
        url: &str,
        headers: &[(String, String)],
        host_header_override: Option<&str>,
        body: Bytes,
        timeout: Duration,
    ) -> Result<UpstreamExchange, UpstreamClientError> {
        let uri: Uri = url
            .parse()
            .map_err(|e| UpstreamClientError::InvalidRequest(format!("Invalid upstream URI '{url}': {e}")))?;

        let proxy_begin_request_instant = Instant::now();
        let proxy_begin_request_utc = Utc::now();
        let proxy_begin_request_at = format_rfc3339_micros(proxy_begin_request_utc);

        let (tracked_body, send_tracker) = TrackedRequestBody::new(body);
        let mut builder = Request::builder().method(method).uri(uri);

        for (name, value) in headers {
            if let (Ok(hn), Ok(hv)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(value),
            ) {
                builder = builder.header(hn, hv);
            }
        }
        if let Some(host_val) = host_header_override {
            if let Ok(hv) = HeaderValue::from_str(host_val) {
                builder = builder.header(HOST, hv);
            }
        }

        let req = builder
            .body(tracked_body)
            .map_err(|e| UpstreamClientError::InvalidRequest(format!("Failed building upstream request: {e}")))?;

        let response = match tokio::time::timeout(timeout, self.client.request(req)).await {
            Ok(Ok(resp)) => resp,
            Ok(Err(err)) => {
                let chain = format_hyper_client_error(&err);
                if err.is_connect() {
                    return Err(UpstreamClientError::Connect(chain));
                }
                return Err(UpstreamClientError::Transport(chain));
            }
            Err(_) => {
                return Err(UpstreamClientError::Timeout(format!(
                    "Upstream request timed out after {} ms",
                    timeout.as_millis()
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
        headers: &[(String, String)],
        host_header_override: Option<&str>,
        body: Bytes,
        timeout: Duration,
    ) -> Result<UpstreamExchange, UpstreamClientError> {
        let can_retry = matches!(method, Method::GET | Method::HEAD | Method::OPTIONS);
        match self
            .send_request(
                method.clone(),
                url,
                headers,
                host_header_override,
                body.clone(),
                timeout,
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
                self.send_request(method, url, headers, host_header_override, body, timeout)
                    .await
            }
            Err(err) => Err(err),
        }
    }

    pub async fn send_following_redirects(
        &self,
        initial_method: Method,
        initial_url: &str,
        initial_headers: &[(String, String)],
        initial_host_override: Option<&str>,
        initial_body: Bytes,
        timeout: Duration,
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
                    timeout,
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

            // Strip sensitive headers on cross-origin redirect
            let same_origin = base.scheme() == next_parsed.scheme()
                && base.host_str() == next_parsed.host_str()
                && base.port_or_known_default() == next_parsed.port_or_known_default();
            if !same_origin {
                current_headers.retain(|(name, _)| {
                    !name.eq_ignore_ascii_case(AUTHORIZATION.as_str())
                        && !name.eq_ignore_ascii_case(COOKIE.as_str())
                        && !name.eq_ignore_ascii_case(PROXY_AUTHORIZATION.as_str())
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
                current_headers.retain(|(name, _)| {
                    !name.eq_ignore_ascii_case(CONTENT_LENGTH.as_str())
                        && !name.eq_ignore_ascii_case(CONTENT_TYPE.as_str())
                });
            }

            current_url = next_parsed.to_string();
        }

        Err(UpstreamClientError::Transport(
            "Exceeded maximum redirect limit".to_string(),
        ))
    }
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
            is_tls: true,
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

        let client = UpstreamHttpClient::build(None, None).unwrap();
        let url = format!("http://{addr}/hello");

        let first = client
            .send_request(
                Method::GET,
                &url,
                &[],
                None,
                Bytes::new(),
                Duration::from_secs(5),
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
                Duration::from_secs(5),
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
}
