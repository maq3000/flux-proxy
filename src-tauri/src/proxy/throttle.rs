use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::Sleep;

use crate::models::ProxyError;

pub use crate::models::{ThrottleConfig, ThrottlePreset};

const RESPONSIVE_SLICE: Duration = Duration::from_millis(50);

/// Thread-safe global bandwidth & RTT latency throttling engine.
#[derive(Debug, Default)]
pub struct ThrottleEngine {
    config: RwLock<ThrottleConfig>,
}

impl ThrottleEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_config(&self) -> ThrottleConfig {
        self.config
            .read()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    pub fn set_config(&self, config: ThrottleConfig) -> ThrottleConfig {
        let normalized = config.normalized();
        if let Ok(mut guard) = self.config.write() {
            *guard = normalized.clone();
        }
        normalized
    }

    pub fn is_offline(&self) -> bool {
        self.get_config().is_offline()
    }

    /// Applies the configured initial RTT latency before forwarding an upstream request.
    /// Slices long sleeps into ≤50ms increments so switching to `None` unblocks immediately
    /// and switching to `Offline` aborts with an error.
    pub async fn apply_latency(&self) -> Result<(), ProxyError> {
        let initial = self.get_config();
        if initial.is_offline() {
            return Err(ProxyError::Custom(
                "Network Offline (Bandwidth Throttling: Offline)".into(),
            ));
        }
        if initial.latency_ms == 0 {
            return Ok(());
        }

        let started = Instant::now();
        loop {
            let current = self.get_config();
            if current.is_offline() {
                return Err(ProxyError::Custom(
                    "Network Offline (Bandwidth Throttling: Offline)".into(),
                ));
            }
            if current.latency_ms == 0 {
                return Ok(());
            }
            let target = Duration::from_millis(current.latency_ms);
            let elapsed = started.elapsed();
            if elapsed >= target {
                return Ok(());
            }
            let step = (target - elapsed).min(RESPONSIVE_SLICE);
            tokio::time::sleep(step).await;
        }
    }

    /// Delays proportional to `byte_count` according to the active upload or download rate.
    pub async fn throttle_bytes(&self, byte_count: usize, is_download: bool) -> Result<(), ProxyError> {
        let mut pacer = BandwidthPacer::new();
        pacer.pace(self, byte_count, is_download).await
    }
}

/// Stateful per-stream bandwidth pacer for chunked HTTP/SSE/buffered upstream transfers.
#[derive(Debug, Default)]
pub struct BandwidthPacer {
    next_available: Option<Instant>,
}

impl BandwidthPacer {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn pace(
        &mut self,
        engine: &ThrottleEngine,
        byte_count: usize,
        is_download: bool,
    ) -> Result<(), ProxyError> {
        let initial = engine.get_config();
        if initial.is_offline() {
            return Err(ProxyError::Custom(
                "Network Offline (Bandwidth Throttling: Offline)".into(),
            ));
        }
        let Some(bps) = (if is_download {
            initial.download_bytes_per_sec()
        } else {
            initial.upload_bytes_per_sec()
        }) else {
            self.next_available = None;
            return Ok(());
        };
        if byte_count == 0 {
            return Ok(());
        }

        let debt = Duration::from_secs_f64(byte_count as f64 / bps as f64);
        let now = Instant::now();
        let base = self.next_available.filter(|t| *t > now).unwrap_or(now);
        let target = base + debt;
        self.next_available = Some(target);

        loop {
            let current = engine.get_config();
            if current.is_offline() {
                return Err(ProxyError::Custom(
                    "Network Offline (Bandwidth Throttling: Offline)".into(),
                ));
            }
            let active_bps = if is_download {
                current.download_bytes_per_sec()
            } else {
                current.upload_bytes_per_sec()
            };
            if active_bps.is_none() {
                self.next_available = None;
                return Ok(());
            }

            let now = Instant::now();
            if now >= target {
                return Ok(());
            }
            let step = (target - now).min(RESPONSIVE_SLICE);
            tokio::time::sleep(step).await;
        }
    }
}

#[derive(Default)]
struct DirectionThrottleState {
    next_available: Option<Instant>,
    sleep: Option<Pin<Box<Sleep>>>,
}

/// `AsyncRead + AsyncWrite` stream wrapper enforcing initial RTT latency and separate
/// upload/download byte-rate limits (used on CONNECT TCP passthrough tunnels).
pub struct ThrottledStream<S> {
    inner: S,
    engine: Arc<ThrottleEngine>,
    initial_delay_done: bool,
    initial_delay_sleep: Option<Pin<Box<Sleep>>>,
    read_state: DirectionThrottleState,
    write_state: DirectionThrottleState,
}

impl<S> ThrottledStream<S> {
    pub fn new(inner: S, engine: Arc<ThrottleEngine>) -> Self {
        Self {
            inner,
            engine,
            initial_delay_done: false,
            initial_delay_sleep: None,
            read_state: DirectionThrottleState::default(),
            write_state: DirectionThrottleState::default(),
        }
    }

    pub fn new_without_initial_delay(inner: S, engine: Arc<ThrottleEngine>) -> Self {
        Self {
            inner,
            engine,
            initial_delay_done: true,
            initial_delay_sleep: None,
            read_state: DirectionThrottleState::default(),
            write_state: DirectionThrottleState::default(),
        }
    }
}

fn offline_io_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::NotConnected,
        "Network Offline (Bandwidth Throttling: Offline)",
    )
}

fn schedule_direction_sleep(state: &mut DirectionThrottleState, bytes: usize, bps: u64) {
    if bytes == 0 {
        return;
    }
    let now = Instant::now();
    let debt = Duration::from_secs_f64(bytes as f64 / bps as f64);
    let base = state.next_available.filter(|t| *t > now).unwrap_or(now);
    let next_at = base + debt;
    state.next_available = Some(next_at);
    if next_at > now {
        state.sleep = Some(Box::pin(tokio::time::sleep_until(next_at.into())));
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for ThrottledStream<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let cfg = this.engine.get_config();
        if cfg.is_offline() {
            return Poll::Ready(Err(offline_io_error()));
        }

        if !this.initial_delay_done {
            if this.initial_delay_sleep.is_none() {
                if cfg.latency_ms > 0 {
                    this.initial_delay_sleep = Some(Box::pin(tokio::time::sleep(
                        Duration::from_millis(cfg.latency_ms),
                    )));
                } else {
                    this.initial_delay_done = true;
                }
            }
            if let Some(sleep) = this.initial_delay_sleep.as_mut() {
                if cfg.latency_ms == 0 {
                    this.initial_delay_sleep = None;
                    this.initial_delay_done = true;
                } else {
                    match sleep.as_mut().poll(cx) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(()) => {
                            this.initial_delay_sleep = None;
                            this.initial_delay_done = true;
                        }
                    }
                }
            }
        }

        if let Some(sleep) = this.read_state.sleep.as_mut() {
            if cfg.download_bytes_per_sec().is_none() {
                this.read_state.sleep = None;
                this.read_state.next_available = None;
            } else {
                match sleep.as_mut().poll(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(()) => {
                        this.read_state.sleep = None;
                    }
                }
            }
        }

        if buf.remaining() == 0 {
            return Pin::new(&mut this.inner).poll_read(cx, buf);
        }

        let Some(bps) = cfg.download_bytes_per_sec() else {
            return Pin::new(&mut this.inner).poll_read(cx, buf);
        };

        let chunk_cap = ((bps / 10).clamp(512, 16 * 1024) as usize).min(buf.remaining());
        let mut scratch = [0u8; 16 * 1024];
        let mut sub_buf = ReadBuf::new(&mut scratch[..chunk_cap]);

        match Pin::new(&mut this.inner).poll_read(cx, &mut sub_buf) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(err)) => Poll::Ready(Err(err)),
            Poll::Ready(Ok(())) => {
                let filled = sub_buf.filled();
                let n = filled.len();
                if n > 0 {
                    buf.put_slice(filled);
                    schedule_direction_sleep(&mut this.read_state, n, bps);
                }
                Poll::Ready(Ok(()))
            }
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for ThrottledStream<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let cfg = this.engine.get_config();
        if cfg.is_offline() {
            return Poll::Ready(Err(offline_io_error()));
        }

        if !this.initial_delay_done {
            if this.initial_delay_sleep.is_none() {
                if cfg.latency_ms > 0 {
                    this.initial_delay_sleep = Some(Box::pin(tokio::time::sleep(
                        Duration::from_millis(cfg.latency_ms),
                    )));
                } else {
                    this.initial_delay_done = true;
                }
            }
            if let Some(sleep) = this.initial_delay_sleep.as_mut() {
                if cfg.latency_ms == 0 {
                    this.initial_delay_sleep = None;
                    this.initial_delay_done = true;
                } else {
                    match sleep.as_mut().poll(cx) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(()) => {
                            this.initial_delay_sleep = None;
                            this.initial_delay_done = true;
                        }
                    }
                }
            }
        }

        if let Some(sleep) = this.write_state.sleep.as_mut() {
            if cfg.upload_bytes_per_sec().is_none() {
                this.write_state.sleep = None;
                this.write_state.next_available = None;
            } else {
                match sleep.as_mut().poll(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(()) => {
                        this.write_state.sleep = None;
                    }
                }
            }
        }

        let Some(bps) = cfg.upload_bytes_per_sec() else {
            return Pin::new(&mut this.inner).poll_write(cx, buf);
        };

        let chunk_cap = ((bps / 10).clamp(512, 16 * 1024) as usize).min(buf.len());
        let slice = &buf[..chunk_cap];

        match Pin::new(&mut this.inner).poll_write(cx, slice) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(err)) => Poll::Ready(Err(err)),
            Poll::Ready(Ok(n)) => {
                if n > 0 {
                    schedule_direction_sleep(&mut this.write_state, n, bps);
                }
                Poll::Ready(Ok(n))
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let cfg = this.engine.get_config();
        if cfg.is_offline() {
            return Poll::Ready(Err(offline_io_error()));
        }
        if let Some(sleep) = this.write_state.sleep.as_mut() {
            if cfg.upload_bytes_per_sec().is_none() {
                this.write_state.sleep = None;
                this.write_state.next_available = None;
            } else {
                match sleep.as_mut().poll(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(()) => {
                        this.write_state.sleep = None;
                    }
                }
            }
        }
        Pin::new(&mut this.inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn throttle_presets_match_canonical_profiles() {
        let gprs = ThrottleConfig::from_preset(ThrottlePreset::Gprs);
        assert_eq!((gprs.download_kbps, gprs.upload_kbps, gprs.latency_ms), (50, 50, 500));

        let slow3g = ThrottleConfig::from_preset(ThrottlePreset::Slow3g);
        assert_eq!(
            (slow3g.download_kbps, slow3g.upload_kbps, slow3g.latency_ms),
            (400, 400, 400)
        );

        let fast3g = ThrottleConfig::from_preset(ThrottlePreset::Fast3g);
        assert_eq!(
            (fast3g.download_kbps, fast3g.upload_kbps, fast3g.latency_ms),
            (1600, 1600, 150)
        );

        let lte = ThrottleConfig::from_preset(ThrottlePreset::Lte);
        assert_eq!(
            (lte.download_kbps, lte.upload_kbps, lte.latency_ms),
            (30_000, 30_000, 40)
        );

        let offline = ThrottleConfig::from_preset(ThrottlePreset::Offline);
        assert!(offline.is_offline());
        assert!(offline.is_active());
        assert!(offline.download_bytes_per_sec().is_none());

        let none = ThrottleConfig::from_preset(ThrottlePreset::None);
        assert!(!none.is_active());
        assert!(!none.is_offline());
    }

    #[tokio::test]
    async fn throttled_stream_enforces_latency_rate_and_offline_mode() {
        let engine = Arc::new(ThrottleEngine::new());

        // 1. Offline mode immediately fails reads and writes
        engine.set_config(ThrottleConfig::from_preset(ThrottlePreset::Offline));
        let (duplex_a, _duplex_b) = tokio::io::duplex(4096);
        let mut offline_stream = ThrottledStream::new(duplex_a, engine.clone());
        let mut buf = [0u8; 16];
        let err = offline_stream.read(&mut buf).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotConnected);

        // 2. Initial RTT latency + download rate pacing
        engine.set_config(ThrottleConfig {
            preset: ThrottlePreset::Custom,
            download_kbps: 64, // 8000 bytes/sec
            upload_kbps: 64,   // 8000 bytes/sec
            latency_ms: 100,
        });

        let (client_end, mut server_end) = tokio::io::duplex(16 * 1024);
        let mut throttled = ThrottledStream::new(client_end, engine.clone());
        let payload = vec![0xABu8; 3200]; // 3200 bytes @ 8000 B/s ≈ 400ms (with 512..800B slices >= 250ms) + 100ms latency

        let writer = tokio::spawn(async move {
            server_end.write_all(&payload).await.unwrap();
            server_end.shutdown().await.unwrap();
        });

        let started = Instant::now();
        let mut received = Vec::new();
        throttled.read_to_end(&mut received).await.unwrap();
        let elapsed = started.elapsed();
        writer.await.unwrap();

        assert_eq!(received.len(), 3200);
        assert!(
            elapsed >= Duration::from_millis(250),
            "expected throttled transfer to take >= 250ms, took {:?}",
            elapsed
        );

        // 3. No throttling transfers without artificial wait
        engine.set_config(ThrottleConfig::from_preset(ThrottlePreset::None));
        let (c2, mut s2) = tokio::io::duplex(8192);
        let mut fast = ThrottledStream::new(c2, engine.clone());
        s2.write_all(b"fast-ok").await.unwrap();
        s2.shutdown().await.unwrap();
        let mut out = String::new();
        fast.read_to_string(&mut out).await.unwrap();
        assert_eq!(out, "fast-ok");
    }
}
