pub(super) use super::http_handler;
pub(super) use super::http_handler::*;
pub(super) use super::mobile_portal::*;
pub(super) use super::*;
pub(super) use base64::Engine as _;
pub(super) use futures_util::{SinkExt, StreamExt};
pub(super) use http::header::CONTENT_TYPE;
pub(super) use http::{Response, StatusCode};
pub(super) use http_body_util::{BodyExt, Full, StreamBody};
pub(super) use hyper::body::Frame;
pub(super) use tokio::net::TcpStream;
pub(super) use tokio_tungstenite::tungstenite::protocol::Role;
pub(super) use tokio_tungstenite::WebSocketStream;
pub(super) use crate::models::{BreakpointStage, ComposedRequest, HeaderPair, RuleActionType};
pub(super) use crate::models::{
    BreakpointConfig, BreakpointResolution, ProxyFilterBackendConfig, TlsBypassRule,
    TlsInterceptMode,
};
pub(super) use crate::proxy::process::ClientProcessInfo;
pub(super) use crate::storage::BODY_OFFLOAD_THRESHOLD_BYTES;
pub(super) use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) fn test_upstream_http_client(
    host_remap: Option<Arc<HostRemapRegistry>>,
) -> std::sync::RwLock<Arc<UpstreamHttpClient>> {
    std::sync::RwLock::new(Arc::new(
        UpstreamHttpClient::build(
            host_remap,
            None,
            None,
            Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_CONNECT_TIMEOUT_SEC,
            )),
            false,
        )
        .unwrap(),
    ))
}

pub(super) fn test_remote_upstream_http_client(
    host_remap: Option<Arc<HostRemapRegistry>>,
) -> std::sync::RwLock<Arc<UpstreamHttpClient>> {
    std::sync::RwLock::new(Arc::new(
        UpstreamHttpClient::build(
            host_remap,
            None,
            None,
            Arc::new(std::sync::atomic::AtomicU64::new(
                crate::models::DEFAULT_CONNECT_TIMEOUT_SEC,
            )),
            true,
        )
        .unwrap(),
    ))
}

pub(super) struct RecordingOsProxyBackend {
    applied_targets: std::sync::Mutex<Vec<(String, u16)>>,
    active: std::sync::Mutex<Option<(String, u16)>>,
}

impl RecordingOsProxyBackend {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            applied_targets: std::sync::Mutex::new(Vec::new()),
            active: std::sync::Mutex::new(None),
        })
    }

    pub(super) fn last_target(&self) -> Option<(String, u16)> {
        self.applied_targets.lock().unwrap().last().cloned()
    }
}

impl crate::proxy::sysproxy::OsProxyBackend for RecordingOsProxyBackend {
    fn capture_snapshot(
        &self,
    ) -> Result<crate::proxy::sysproxy::PlatformProxySnapshot, ProxyError> {
        Ok(crate::proxy::sysproxy::PlatformProxySnapshot::Windows(
            crate::proxy::sysproxy::WindowsProxySnapshot {
                proxy_enable: Some(0),
                proxy_server: None,
                proxy_override: None,
                auto_config_url: None,
            },
        ))
    }

    fn apply_system_proxy(
        &self,
        host: &str,
        port: u16,
        _baseline: &crate::proxy::sysproxy::PlatformProxySnapshot,
    ) -> Result<(), ProxyError> {
        self.applied_targets
            .lock()
            .unwrap()
            .push((host.to_string(), port));
        *self.active.lock().unwrap() = Some((host.to_string(), port));
        Ok(())
    }

    fn restore_snapshot(
        &self,
        _snapshot: &crate::proxy::sysproxy::PlatformProxySnapshot,
    ) -> Result<(), ProxyError> {
        *self.active.lock().unwrap() = None;
        Ok(())
    }

    fn inspect_active_state(
        &self,
        expected_host: &str,
        expected_port: u16,
    ) -> Result<crate::proxy::sysproxy::OsActiveProxyState, ProxyError> {
        let cur = self.active.lock().unwrap().clone();
        match cur {
            Some((h, p)) => Ok(crate::proxy::sysproxy::OsActiveProxyState {
                matches_flux: h == expected_host && p == expected_port,
                any_proxy_enabled: true,
                current_target_summary: format!("{h}:{p}"),
            }),
            None => Ok(crate::proxy::sysproxy::OsActiveProxyState {
                matches_flux: false,
                any_proxy_enabled: false,
                current_target_summary: "disabled".to_string(),
            }),
        }
    }
}

pub(super) async fn pick_distinct_bindable_ip_for_test() -> Option<String> {
    if let Ok(l) = TcpListener::bind("127.0.0.2:0").await {
        drop(l);
        return Some("127.0.0.2".to_string());
    }
    for iface in crate::proxy::network::list_network_interfaces_with_options(false) {
        if iface.ip != "127.0.0.1" {
            let addr = format!("{}:0", iface.ip);
            if let Ok(l) = TcpListener::bind(&addr).await {
                drop(l);
                return Some(iface.ip);
            }
        }
    }
    None
}

pub(super) async fn read_raw_http_head_and_body(stream: &mut TcpStream) -> (Vec<u8>, Vec<u8>) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let split_pos = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        let n = stream.read(&mut tmp).await.unwrap();
        assert!(n > 0, "unexpected EOF while reading HTTP response headers");
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = buf[..split_pos].to_vec();
    let mut body = buf[split_pos + 4..].to_vec();
    let head_str = String::from_utf8_lossy(&head);
    let content_len = head_str
        .lines()
        .skip(1)
        .find_map(|line| {
            let (k, v) = line.split_once(':')?;
            if k.trim().eq_ignore_ascii_case("content-length") {
                v.trim().parse::<usize>().ok()
            } else {
                None
            }
        });
    if let Some(cl) = content_len {
        while body.len() < cl {
            let n = stream.read(&mut tmp).await.unwrap();
            if n == 0 {
                break;
            }
            body.extend_from_slice(&tmp[..n]);
        }
        body.truncate(cl);
    } else {
        let _ = stream.read_to_end(&mut body).await;
    }
    (head, body)
}

pub(super) async fn open_proxied_ws(
    proxy_port: u16,
    ws_url: &str,
) -> WebSocketStream<TcpStream> {
    let mut tcp = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
    let rest = ws_url
        .strip_prefix("ws://")
        .expect("open_proxied_ws expects ws:// URL");
    let (host_port, path_q) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    let req = format!(
        "GET http://{host_port}{path_q} HTTP/1.1\r\n\
         Host: {host_port}\r\n\
         Connection: Upgrade\r\n\
         Upgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    tcp.write_all(req.as_bytes()).await.unwrap();
    let mut resp_buf = Vec::with_capacity(512);
    let mut byte = [0u8; 1];
    while !resp_buf.ends_with(b"\r\n\r\n") {
        let n = tcp.read(&mut byte).await.unwrap();
        assert!(n > 0, "unexpected EOF waiting for WS 101 response");
        resp_buf.push(byte[0]);
    }
    let resp_str = String::from_utf8_lossy(&resp_buf);
    assert!(
        resp_str.starts_with("HTTP/1.1 101"),
        "expected 101 Switching Protocols, got: {resp_str}"
    );
    WebSocketStream::from_raw_socket(
        tcp,
        tokio_tungstenite::tungstenite::protocol::Role::Client,
        None,
    )
    .await
}

pub(super) fn make_stage44_controller(
    label: &str,
) -> (
    ProxyEngineController,
    Arc<RuleEngine>,
    Arc<ProxyFilterEngine>,
    Arc<TrafficStore>,
    std::path::PathBuf,
) {
    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy_stage44_{}_{}_{}",
        label,
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    let _ = std::fs::create_dir_all(&tmp_dir);
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let store = Arc::new(TrafficStore::new(tmp_dir.join("sessions.sqlite")).unwrap());
    let os_backend = RecordingOsProxyBackend::new();
    let sysproxy = Arc::new(SystemProxyManager::with_backend(&tmp_dir, os_backend));
    let controller = ProxyEngineController::new_for_test(
        ca,
        rules.clone(),
        filters.clone(),
        store.clone(),
        sysproxy,
    )
    .unwrap();
    (controller, rules, filters, store, tmp_dir)
}


mod core_proxy;
mod lifecycle_and_regressions;
mod routing_and_security;
mod streaming_and_codecs;
mod websocket_and_composer;
