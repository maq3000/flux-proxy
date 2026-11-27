use super::*;

#[tokio::test]
async fn connect_tls_bypass_relays_raw_bytes_via_copy_bidirectional() {
    // 1. Start mock upstream "pinned TLS" raw TCP echo endpoint
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((mut sock, _)) = upstream_listener.accept().await {
            let mut buf = [0u8; 64];
            if let Ok(n) = sock.read(&mut buf).await {
                let _ = sock.write_all(&buf[..n]).await;
            }
            let _ = sock.shutdown().await;
        }
    });

    // 2. Initialize SharedProxyContext with 127.0.0.1 in TLS Bypass list
    let tmp_dir =
        std::env::temp_dir().join(format!("fluxproxy-test-bypass-{}", std::process::id()));
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    filters.update_config(ProxyFilterBackendConfig {
        tls_intercept_mode: TlsInterceptMode::InterceptAll,
        tls_bypass_enabled: true,
        tls_bypass_rules: vec![TlsBypassRule {
            id: "test-loopback-pin".into(),
            enabled: true,
            pattern: "127.0.0.1".into(),
            category: "Test".into(),
            description: "Loopback pinned endpoint".into(),
        }],
        tls_target_rules: Vec::new(),
        header_mutations_enabled: true,
        header_mutations: Vec::new(),
        strip_alt_svc: true,
        host_list_sync: Default::default(),
        ..crate::proxy::filters::default_backend_config()
    });
    let store = Arc::new(TrafficStore::new(tmp_dir.join("test.sqlite")).unwrap());
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
    let ctx = Arc::new(SharedProxyContext {
        ca,
        rules,
        filters,
        breakpoints,
        host_remap: Arc::new(HostRemapRegistry::new()),
        upstream_proxy: Arc::new(UpstreamProxyManager::new()),
        throttle: Arc::new(ThrottleEngine::new()),
        store: store.clone(),
        upstream_http_client: test_upstream_http_client(None),
        remote_upstream_http_client: test_remote_upstream_http_client(None),
        shared_http1_tls_config: shared_http1_tls_config().unwrap(),
        client_certs: Arc::new(ClientCertificateStore::in_memory()),
        script_runner: Arc::new(PythonScriptRunner::new(None)),
        active_ws_channels: Arc::new(DashMap::new()),
        event_tx,
        removed_tx,
        active_port: AtomicU16::new(0),
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
        response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
        )),
        composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
        )),
        app_handle: None,
        stats_dirty: Arc::new(AtomicBool::new(false)),
    });

    // 3. Bind outer proxy listener and issue CONNECT tunnel
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();
    let proxy_ctx = ctx.clone();

    tokio::spawn(async move {
        if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
            let proc_info = resolve_client_process_async(client_addr, Some(proxy_addr.port())).await;
            let io = TokioIo::new(tcp_stream);
            let service = service_fn(move |req: Request<Incoming>| {
                let c = proxy_ctx.clone();
                let p = proc_info.clone();
                async move {
                    Ok::<_, Infallible>(handle_outer_proxy_request(req, client_addr, p, ClientConnContext::new(), c).await)
                }
            });
            let _ = AutoConnBuilder::new(TokioExecutor::new())
                .serve_connection_with_upgrades(io, service)
                .await;
        }
    });

    let mut client = TcpStream::connect(proxy_addr).await.unwrap();
    let connect_req = format!(
        "CONNECT 127.0.0.1:{} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
        upstream_addr.port(),
        upstream_addr.port()
    );
    client.write_all(connect_req.as_bytes()).await.unwrap();

    let mut resp_buf = [0u8; 256];
    let n = client.read(&mut resp_buf).await.unwrap();
    let resp_str = String::from_utf8_lossy(&resp_buf[..n]);
    assert!(resp_str.starts_with("HTTP/1.1 200"));

    // Send raw "encrypted" payload through the passthrough tunnel without TLS MITM
    let payload = b"RAW_PINNED_CLIENT_HELLO";
    client.write_all(payload).await.unwrap();
    let mut echoed = vec![0u8; payload.len()];
    client.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, payload);
    drop(client);

    tokio::time::sleep(Duration::from_millis(40)).await;
    let summaries = store.list_summaries();
    assert_eq!(summaries.len(), 1);
    assert!(summaries[0].tls_bypassed);
    assert_eq!(summaries[0].protocol, "TLS-BYPASS");
    assert_eq!(summaries[0].process_pid, Some(std::process::id()));
    assert_eq!(summaries[0].body_size, payload.len() * 2);

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn live_breakpoints_intercept_request_and_response_on_oneshot_channel() {
    // 1. Mock HTTP upstream server echoing received request body inside JSON response
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((tcp_stream, _)) = upstream_listener.accept().await {
            let io = TokioIo::new(tcp_stream);
            let svc = service_fn(|req: Request<Incoming>| async move {
                let req_bytes = req.into_body().collect().await.unwrap().to_bytes();
                let body_str = String::from_utf8_lossy(&req_bytes);
                let json = format!("{{\"upstreamSaw\":{body_str},\"ok\":true}}");
                Ok::<_, Infallible>(
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(CONTENT_TYPE, "application/json")
                        .body(Full::new(Bytes::from(json)))
                        .unwrap(),
                )
            });
            let _ = AutoConnBuilder::new(TokioExecutor::new())
                .serve_connection_with_upgrades(io, svc)
                .await;
        }
    });

    // 2. Enable BOTH Break Before Request (F11) and Break After Response (Alt+F11)
    let tmp_dir =
        std::env::temp_dir().join(format!("fluxproxy-test-bp-{}", std::process::id()));
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let store = Arc::new(TrafficStore::new(tmp_dir.join("bp.sqlite")).unwrap());
    let (bp_tx, mut bp_rx) = breakpoint_snapshot_channel();
    let breakpoints = Arc::new(BreakpointEngine::new_with_store(
        Some(bp_tx),
        Some(Arc::clone(&store)),
    ));
    breakpoints.update_config(BreakpointConfig {
        break_before_request: true,
        break_after_response: true,
        timeout_secs: 15,
        rules: Vec::new(),
    });
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
    let ctx = Arc::new(SharedProxyContext {
        ca,
        rules,
        filters,
        breakpoints: breakpoints.clone(),
        host_remap: Arc::new(HostRemapRegistry::new()),
        upstream_proxy: Arc::new(UpstreamProxyManager::new()),
        throttle: Arc::new(ThrottleEngine::new()),
        store: store.clone(),
        upstream_http_client: test_upstream_http_client(None),
        remote_upstream_http_client: test_remote_upstream_http_client(None),
        shared_http1_tls_config: shared_http1_tls_config().unwrap(),
        client_certs: Arc::new(ClientCertificateStore::in_memory()),
        script_runner: Arc::new(PythonScriptRunner::new(None)),
        active_ws_channels: Arc::new(DashMap::new()),
        event_tx,
        removed_tx,
        active_port: AtomicU16::new(0),
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
        response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
        )),
        composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
        )),
        app_handle: None,
        stats_dirty: Arc::new(AtomicBool::new(false)),
    });

    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();
    let proxy_ctx = ctx.clone();

    tokio::spawn(async move {
        if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
            let io = TokioIo::new(tcp_stream);
            let service = service_fn(move |req: Request<Incoming>| {
                let c = proxy_ctx.clone();
                async move {
                    Ok::<_, Infallible>(
                        handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), c).await,
                    )
                }
            });
            let _ = AutoConnBuilder::new(TokioExecutor::new())
                .serve_connection_with_upgrades(io, service)
                .await;
        }
    });

    // 3. Spawn simulated UI controller resolving Request Breakpoint -> then Response Breakpoint (mutating status to 500)
    let ui_bp = breakpoints.clone();
    tokio::spawn(async move {
        while let Some(snapshot) = bp_rx.recv().await {
            if let Some(paused) = snapshot.first() {
                match paused.stage {
                    BreakpointStage::Request => {
                        ui_bp.resolve(BreakpointResolution {
                            breakpoint_id: paused.breakpoint_id.clone(),
                            action: BreakpointAction::Continue,
                            method: None,
                            url: None,
                            request_headers: None,
                            request_body_base64: None,
                            request_body_text: Some("{\"amount\":9999}".into()),
                            status_code: None,
                            response_headers: None,
                            response_body_base64: None,
                            response_body_text: None,
                        });
                    }
                    BreakpointStage::Response => {
                        let orig = paused.response_body_text.clone().unwrap_or_default();
                        assert!(orig.contains("9999"));
                        ui_bp.resolve(BreakpointResolution {
                            breakpoint_id: paused.breakpoint_id.clone(),
                            action: BreakpointAction::Continue,
                            method: None,
                            url: None,
                            request_headers: None,
                            request_body_base64: None,
                            request_body_text: None,
                            status_code: Some(500),
                            response_headers: None,
                            response_body_base64: None,
                            response_body_text: Some(
                                "{\"error\":\"Injected 500 at Breakpoint\"}".into(),
                            ),
                        });
                        break;
                    }
                    BreakpointStage::Both => {}
                }
            }
        }
    });

    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
        .build()
        .unwrap();

    let resp = client
        .post(format!("http://127.0.0.1:{}/v1/pay", upstream_addr.port()))
        .body("{\"amount\":100}")
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status().as_u16(), 500);
    let text = resp.text().await.unwrap();
    assert_eq!(text, "{\"error\":\"Injected 500 at Breakpoint\"}");

    let detail = store.get(1).unwrap();
    assert!(detail.summary.breakpoint_modified);
    assert!(detail.summary.breakpoint_paused.is_none());

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[test]
fn parses_sse_event_stream_chunks() {
    let raw = b"id: evt_1\nevent: content_block_delta\ndata: {\"delta\":\"Hello\"}\n\ndata: {\"delta\":\" world\"}\n\ndata: [DONE]\n\n";
    let events = parse_sse_events_from_bytes(raw, 85);
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].id.as_deref(), Some("evt_1"));
    assert_eq!(events[0].event, "content_block_delta");
    assert_eq!(events[0].data, "{\"delta\":\"Hello\"}");
    assert_eq!(events[1].event, "message");
    assert_eq!(events[2].data, "[DONE]");
}

#[tokio::test]
async fn targeted_only_mode_tunnels_unlisted_hosts_as_passthrough_and_decrypts_allowlisted_host()
{
    // 1. Start mock raw TCP echo server representing a 3rd-party pinned app (e.g. Telegram/Steam/Teams)
    let pinned_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let pinned_addr = pinned_listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((mut sock, _)) = pinned_listener.accept().await {
            let mut buf = [0u8; 64];
            if let Ok(n) = sock.read(&mut buf).await {
                let _ = sock.write_all(&buf[..n]).await;
            }
            let _ = sock.shutdown().await;
        }
    });

    // 2. Configure FluxProxy in Mode 2 (`TargetedOnly`) with ONLY `*.mycompany.com, localhost` in Target Allowlist
    let tmp_dir =
        std::env::temp_dir().join(format!("fluxproxy-test-targeted-{}", std::process::id()));
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    filters.update_config(ProxyFilterBackendConfig {
        tls_intercept_mode: TlsInterceptMode::TargetedOnly,
        tls_bypass_enabled: true,
        tls_bypass_rules: Vec::new(),
        tls_target_rules: vec![TlsBypassRule {
            id: "target-allowlist".into(),
            enabled: true,
            pattern: "*.mycompany.com, localhost".into(),
            category: "Target Allowlist".into(),
            description: "Only decrypt target services".into(),
        }],
        header_mutations_enabled: false,
        header_mutations: Vec::new(),
        strip_alt_svc: true,
        host_list_sync: Default::default(),
        ..crate::proxy::filters::default_backend_config()
    });

    let store = Arc::new(TrafficStore::new(tmp_dir.join("targeted.sqlite")).unwrap());
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
    let ctx = Arc::new(SharedProxyContext {
        ca: ca.clone(),
        rules: rules.clone(),
        filters,
        breakpoints,
        host_remap: Arc::new(HostRemapRegistry::new()),
        upstream_proxy: Arc::new(UpstreamProxyManager::new()),
        throttle: Arc::new(ThrottleEngine::new()),
        store: store.clone(),
        upstream_http_client: test_upstream_http_client(None),
        remote_upstream_http_client: test_remote_upstream_http_client(None),
        shared_http1_tls_config: shared_http1_tls_config().unwrap(),
        client_certs: Arc::new(ClientCertificateStore::in_memory()),
        script_runner: Arc::new(PythonScriptRunner::new(None)),
        active_ws_channels: Arc::new(DashMap::new()),
        event_tx,
        removed_tx,
        active_port: AtomicU16::new(0),
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
        response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
        )),
        composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
        )),
        app_handle: None,
        stats_dirty: Arc::new(AtomicBool::new(false)),
    });

    // Register a mock AutoResponder rule on allowlisted `https://localhost/...` so we can verify full MITM decryption
    rules.upsert_rule(crate::models::AutoResponderRule {
        id: "mock-target".into(),
        enabled: true,
        name: "Target Service Mock".into(),
        match_target: crate::models::RuleMatchTarget::UrlContains,
        pattern: "localhost".into(),
        method_filter: None,
        header_name: None,
        action: RuleActionType::MockResponse,
        status_code: 200,
        latency_ms: 0,
        response_headers: vec![HeaderPair::new("Content-Type", "application/json")],
        response_body: "{\"decrypted\":true}".into(),
    });

    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();
    let proxy_ctx = ctx.clone();

    tokio::spawn(async move {
        for _ in 0..2 {
            if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let io = TokioIo::new(tcp_stream);
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_c)
                                    .await,
                            )
                        }
                    });
                    let _ = AutoConnBuilder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(io, service)
                        .await;
                });
            }
        }
    });

    // 3A. Unlisted host (`127.0.0.1`) -> MUST be pure TCP tunnel (`PASSTHROUGH`), zero MITM TLS!
    let mut raw_client = TcpStream::connect(proxy_addr).await.unwrap();
    let connect_unlisted = format!(
        "CONNECT 127.0.0.1:{p} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n\r\n",
        p = pinned_addr.port()
    );
    raw_client
        .write_all(connect_unlisted.as_bytes())
        .await
        .unwrap();
    let mut ok_buf = [0u8; 128];
    let n = raw_client.read(&mut ok_buf).await.unwrap();
    assert!(String::from_utf8_lossy(&ok_buf[..n]).starts_with("HTTP/1.1 200"));

    let opaque_mtls_bytes = b"OPAQUE_MTLS_OR_TELEGRAM_STREAM";
    raw_client.write_all(opaque_mtls_bytes).await.unwrap();
    let mut echoed = vec![0u8; opaque_mtls_bytes.len()];
    raw_client.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, opaque_mtls_bytes);
    drop(raw_client);

    // 3B. Allowlisted host (`localhost`) -> MUST be decrypted via MITM Root CA!
    let root_pem = std::fs::read(ca.info().cert_pem_path).unwrap();
    let reqwest_ca = reqwest::Certificate::from_pem(&root_pem).unwrap();
    let https_client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::https(format!("http://{proxy_addr}")).unwrap())
        .tls_certs_only([reqwest_ca])
        .build()
        .unwrap();

    let decrypted_resp = https_client
        .get("https://localhost:8443/api/health")
        .send()
        .await
        .unwrap();
    assert_eq!(decrypted_resp.status().as_u16(), 200);
    assert_eq!(decrypted_resp.text().await.unwrap(), "{\"decrypted\":true}");

    tokio::time::sleep(Duration::from_millis(40)).await;
    let summaries = store.list_summaries();
    let passthrough_row = summaries
        .iter()
        .find(|s| s.host == "127.0.0.1")
        .expect("missing passthrough row");
    assert!(passthrough_row.tls_bypassed);
    assert_eq!(passthrough_row.protocol, "PASSTHROUGH");

    let inspected_row = summaries
        .iter()
        .find(|s| s.host.starts_with("localhost"))
        .expect("missing decrypted target row");
    assert!(!inspected_row.tls_bypassed);
    assert_eq!(inspected_row.status, 200);

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn mobile_portal_serves_html_crt_der_pem_and_ios_mobileconfig_on_all_interfaces() {
    let tmp_dir =
        std::env::temp_dir().join(format!("fluxproxy-test-mobile-{}", std::process::id()));
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("mobile.sqlite")).unwrap());
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);

    // Bind on 0.0.0.0:0 ("Allow remote connections / Listen on all network interfaces")
    let proxy_listener = TcpListener::bind("0.0.0.0:0").await.unwrap();
    let bound_port = proxy_listener.local_addr().unwrap().port();

    let ctx = Arc::new(SharedProxyContext {
        ca: ca.clone(),
        rules,
        filters,
        breakpoints,
        host_remap: Arc::new(HostRemapRegistry::new()),
        upstream_proxy: Arc::new(UpstreamProxyManager::new()),
        throttle: Arc::new(ThrottleEngine::new()),
        store: store.clone(),
        upstream_http_client: test_upstream_http_client(None),
        remote_upstream_http_client: test_remote_upstream_http_client(None),
        shared_http1_tls_config: shared_http1_tls_config().unwrap(),
        client_certs: Arc::new(ClientCertificateStore::in_memory()),
        script_runner: Arc::new(PythonScriptRunner::new(None)),
        active_ws_channels: Arc::new(DashMap::new()),
        event_tx,
        removed_tx,
        active_port: AtomicU16::new(bound_port),
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
        response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
        )),
        composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
        )),
        app_handle: None,
        stats_dirty: Arc::new(AtomicBool::new(false)),
    });

    let proxy_ctx = ctx.clone();
    tokio::spawn(async move {
        loop {
            let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                break;
            };
            let c = proxy_ctx.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_c = c.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_c).await,
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            });
        }
    });

    let direct_client = reqwest::Client::builder().no_proxy().build().unwrap();
    let proxied_client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{bound_port}")).unwrap())
        .build()
        .unwrap();

    // 1. Direct browser visit `http://127.0.0.1:<port>/` -> HTML onboarding portal
    let html_resp = direct_client
        .get(format!("http://127.0.0.1:{bound_port}/"))
        .send()
        .await
        .unwrap();
    assert_eq!(html_resp.status().as_u16(), 200);
    assert!(html_resp
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("text/html"));
    let html_body = html_resp.text().await.unwrap();
    assert!(html_body.contains("/ca.mobileconfig"));
    assert!(html_body.contains("/ca.crt"));

    // 2. Direct QR scan `http://<ip>:<port>/ca.crt` -> PEM X.509 certificate
    let crt_resp = direct_client
        .get(format!("http://127.0.0.1:{bound_port}/ca.crt"))
        .send()
        .await
        .unwrap();
    assert_eq!(crt_resp.status().as_u16(), 200);
    assert_eq!(
        crt_resp.headers().get("content-type").unwrap().to_str().unwrap(),
        "application/x-x509-ca-cert"
    );
    assert_eq!(crt_resp.text().await.unwrap(), ca.root_ca_pem());

    // 3. Direct `/ca.der` -> exact DER bytes
    let der_resp = direct_client
        .get(format!("http://127.0.0.1:{bound_port}/ca.der"))
        .send()
        .await
        .unwrap();
    assert_eq!(der_resp.status().as_u16(), 200);
    assert_eq!(der_resp.bytes().await.unwrap().as_ref(), ca.root_ca_der());

    // 4. Proxied iOS Safari visit `http://flux.proxy/cert` -> `.mobileconfig` (`application/x-apple-aspen-config`)
    let ios_resp = proxied_client
        .get("http://flux.proxy/cert")
        .header(
            "User-Agent",
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
        )
        .send()
        .await
        .unwrap();
    assert_eq!(ios_resp.status().as_u16(), 200);
    assert_eq!(
        ios_resp.headers().get("content-type").unwrap().to_str().unwrap(),
        "application/x-apple-aspen-config"
    );
    let profile_xml = ios_resp.text().await.unwrap();
    assert!(profile_xml.contains("com.apple.security.root"));

    // 5. Proxied Android Chrome visit `http://flux.proxy/cert` -> `.crt` (`application/x-x509-ca-cert`)
    let android_resp = proxied_client
        .get("http://flux.proxy/cert")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36",
        )
        .send()
        .await
        .unwrap();
    assert_eq!(android_resp.status().as_u16(), 200);
    assert_eq!(
        android_resp.headers().get("content-type").unwrap().to_str().unwrap(),
        "application/x-x509-ca-cert"
    );

    let summaries = store.list_summaries();
    assert!(!summaries.is_empty());
    assert_eq!(summaries[0].client_ip.as_deref(), Some("127.0.0.1"));

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn strips_alt_svc_and_alternate_protocol_across_http1_and_http2_responses() {
    // 1. Upstream HTTP server returning Alt-Svc and Alternate-Protocol headers
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();

    tokio::spawn(async move {
        loop {
            let Ok((tcp_stream, _)) = upstream_listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let svc = service_fn(|_req: Request<Incoming>| async move {
                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(CONTENT_TYPE, "application/json")
                            .header("Alt-Svc", "h3=\":443\"; ma=86400")
                            .header("Alternate-Protocol", "443:quic")
                            .header("X-Upstream", "ok")
                            .body(Full::new(Bytes::from_static(b"{\"quic\":false}")))
                            .unwrap(),
                    )
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, svc)
                    .await;
            });
        }
    });

    // 2. Start FluxProxy MITM listener with default `strip_alt_svc == true`
    let tmp_dir =
        std::env::temp_dir().join(format!("fluxproxy-test-altsvc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("altsvc.sqlite")).unwrap());
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);

    // Mock rule for HTTPS/2 `https://localhost:9443/...` carrying Alt-Svc & Alternate-Protocol
    rules.upsert_rule(crate::models::AutoResponderRule {
        id: "mock-h2-altsvc".into(),
        enabled: true,
        name: "HTTPS/2 Alt-Svc Mock".into(),
        match_target: crate::models::RuleMatchTarget::UrlContains,
        pattern: "https://localhost:9443/".into(),
        method_filter: None,
        header_name: None,
        action: RuleActionType::MockResponse,
        status_code: 200,
        latency_ms: 0,
        response_headers: vec![
            HeaderPair::new("Content-Type", "application/json"),
            HeaderPair::new("alt-svc", "h3=\":443\"; ma=2592000"),
            HeaderPair::new("alternate-protocol", "443:quic"),
        ],
        response_body: "{\"protocol\":\"h2\"}".into(),
    });

    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();
    let ctx = Arc::new(SharedProxyContext {
        ca: ca.clone(),
        rules,
        filters: filters.clone(),
        breakpoints,
        host_remap: Arc::new(HostRemapRegistry::new()),
        upstream_proxy: Arc::new(UpstreamProxyManager::new()),
        throttle: Arc::new(ThrottleEngine::new()),
        store: store.clone(),
        upstream_http_client: test_upstream_http_client(None),
        remote_upstream_http_client: test_remote_upstream_http_client(None),
        shared_http1_tls_config: shared_http1_tls_config().unwrap(),
        client_certs: Arc::new(ClientCertificateStore::in_memory()),
        script_runner: Arc::new(PythonScriptRunner::new(None)),
        active_ws_channels: Arc::new(DashMap::new()),
        event_tx,
        removed_tx,
        active_port: AtomicU16::new(proxy_addr.port()),
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
        response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
        )),
        composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
        )),
        app_handle: None,
        stats_dirty: Arc::new(AtomicBool::new(false)),
    });

    let proxy_ctx = ctx.clone();
    tokio::spawn(async move {
        loop {
            let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                break;
            };
            let c = proxy_ctx.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_c = c.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_c).await,
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            });
        }
    });

    let root_pem = std::fs::read(ca.info().cert_pem_path).unwrap();
    let reqwest_ca = reqwest::Certificate::from_pem(&root_pem).unwrap();
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://{proxy_addr}")).unwrap())
        .tls_certs_only([reqwest_ca])
        .build()
        .unwrap();

    // 3A. HTTP/1.1 upstream response -> Alt-Svc & Alternate-Protocol stripped by default
    let h1_resp = client
        .get(format!("http://127.0.0.1:{}/h1-test", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(h1_resp.version(), reqwest::Version::HTTP_11);
    assert!(h1_resp.headers().get("alt-svc").is_none());
    assert!(h1_resp.headers().get("alternate-protocol").is_none());
    assert_eq!(h1_resp.headers().get("x-upstream").unwrap(), "ok");

    // 3B. HTTPS/2 (`h2` via MITM ALPN) response -> Alt-Svc & Alternate-Protocol stripped by default
    let h2_resp = client
        .get("https://localhost:9443/h2-test")
        .send()
        .await
        .unwrap();
    assert_eq!(h2_resp.version(), reqwest::Version::HTTP_2);
    assert!(h2_resp.headers().get("alt-svc").is_none());
    assert!(h2_resp.headers().get("alternate-protocol").is_none());

    // 3C. Disable `strip_alt_svc` -> headers are preserved for both HTTP/1.1 and HTTPS/2
    let mut cfg = filters.get_config();
    cfg.strip_alt_svc = false;
    filters.update_config(cfg);

    let h1_preserved = client
        .get(format!("http://127.0.0.1:{}/h1-keep", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(
        h1_preserved.headers().get("alt-svc").unwrap(),
        "h3=\":443\"; ma=86400"
    );
    assert_eq!(
        h1_preserved.headers().get("alternate-protocol").unwrap(),
        "443:quic"
    );

    let h2_preserved = client
        .get("https://localhost:9443/h2-keep")
        .send()
        .await
        .unwrap();
    assert_eq!(h2_preserved.version(), reqwest::Version::HTTP_2);
    assert_eq!(
        h2_preserved.headers().get("alt-svc").unwrap(),
        "h3=\":443\"; ma=2592000"
    );
    assert_eq!(
        h2_preserved.headers().get("alternate-protocol").unwrap(),
        "443:quic"
    );

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn streaming_capture_drop_skips_store_and_ipc_and_increments_dropped_counter() {
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();

    tokio::spawn(async move {
        loop {
            let Ok((tcp_stream, _)) = upstream_listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let svc = service_fn(|req: Request<Incoming>| async move {
                    let status = if req.uri().path() == "/cached" {
                        StatusCode::NOT_MODIFIED
                    } else {
                        StatusCode::OK
                    };
                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(status)
                            .header(CONTENT_TYPE, "application/json")
                            .body(Full::new(Bytes::from_static(b"{\"ok\":true}")))
                            .unwrap(),
                    )
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, svc)
                    .await;
            });
        }
    });

    let tmp_dir =
        std::env::temp_dir().join(format!("fluxproxy-test-capdrop-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("capdrop.sqlite")).unwrap());
    let (event_tx, mut event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);

    // Enable `drop_non_matching_on_capture` + hide 304 Not Modified + path filter `/api/*`
    let mut cfg = filters.get_config();
    cfg.drop_non_matching_on_capture = true;
    cfg.noise_thresholds.hide_304_not_modified = true;
    cfg.capture_host_list = crate::models::HostListBackendSyncConfig {
        enabled: true,
        mode: crate::models::HostListFilterMode::Whitelist,
        raw_text: "/api/*".into(),
    };
    filters.update_config(cfg);

    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();
    let ctx = Arc::new(SharedProxyContext {
        ca,
        rules,
        filters,
        breakpoints,
        host_remap: Arc::new(HostRemapRegistry::new()),
        upstream_proxy: Arc::new(UpstreamProxyManager::new()),
        throttle: Arc::new(ThrottleEngine::new()),
        store: store.clone(),
        upstream_http_client: test_upstream_http_client(None),
        remote_upstream_http_client: test_remote_upstream_http_client(None),
        shared_http1_tls_config: shared_http1_tls_config().unwrap(),
        client_certs: Arc::new(ClientCertificateStore::in_memory()),
        script_runner: Arc::new(PythonScriptRunner::new(None)),
        active_ws_channels: Arc::new(DashMap::new()),
        event_tx,
        removed_tx,
        active_port: AtomicU16::new(proxy_addr.port()),
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
        response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
        )),
        composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
        )),
        app_handle: None,
        stats_dirty: Arc::new(AtomicBool::new(false)),
    });

    // Also register an AutoResponder mock for telemetry.microsoft.com to test svchost/telemetry drop
    ctx.rules.upsert_rule(crate::models::AutoResponderRule {
        id: "mock-telemetry".into(),
        enabled: true,
        name: "Telemetry Mock".into(),
        match_target: crate::models::RuleMatchTarget::UrlContains,
        pattern: "telemetry.microsoft.com".into(),
        method_filter: None,
        header_name: None,
        action: RuleActionType::MockResponse,
        status_code: 200,
        latency_ms: 0,
        response_headers: vec![HeaderPair::new("Content-Type", "application/json")],
        response_body: "{\"acc\":1}".into(),
    });

    let proxy_ctx = ctx.clone();
    tokio::spawn(async move {
        loop {
            let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                break;
            };
            let c = proxy_ctx.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_c = c.clone();
                    // Simulate svchost.exe when hitting telemetry.microsoft.com
                    let proc_info = if req
                        .uri()
                        .host()
                        .unwrap_or("")
                        .contains("telemetry.microsoft.com")
                    {
                        Some(ClientProcessInfo {
                            pid: 1120,
                            name: "svchost.exe".into(),
                        })
                    } else {
                        Some(ClientProcessInfo {
                            pid: 4200,
                            name: "node.exe".into(),
                        })
                    };
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(req, client_addr, proc_info, ClientConnContext::new(), inner_c)
                                .await,
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            });
        }
    });

    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
        .build()
        .unwrap();

    // 1. Non-matching path `/noise` -> client gets 200 OK, but NOT stored in RAM or emitted on IPC
    let r1 = client
        .get(format!("http://127.0.0.1:{}/noise", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(r1.status(), StatusCode::OK);

    // 2. 304 Not Modified on `/cached` -> dropped
    let r2 = client
        .get(format!("http://127.0.0.1:{}/cached", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(r2.status(), StatusCode::NOT_MODIFIED);

    // 3. Background svchost telemetry -> dropped
    let r3 = client
        .post("http://telemetry.microsoft.com/OneCollector/1.0/")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(r3.status(), StatusCode::OK);

    // 4. Matching `/api/orders` -> stored in RAM AND emitted once over IPC
    let r4 = client
        .get(format!(
            "http://127.0.0.1:{}/api/orders",
            upstream_addr.port()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r4.status(), StatusCode::OK);

    assert_eq!(store.len(), 1);
    assert_eq!(store.dropped_sessions_count(), 3);

    let emitted = event_rx.try_recv().expect("matching session emitted");
    assert_eq!(emitted.path, "/api/orders");
    assert_eq!(emitted.status, 200);
    while let Ok(extra) = event_rx.try_recv() {
        assert_eq!(
            extra.id, emitted.id,
            "no dropped session may be emitted (unexpected session {} path={})",
            extra.id, extra.path
        );
        assert_eq!(extra.path, "/api/orders");
    }

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn two_phase_capture_emits_in_flight_and_updates_or_removes_on_response() {
    use tokio::sync::Notify;

    // 1. Upstream server with controllable response delay via Notify
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();
    let entered_notify = Arc::new(Notify::new());
    let release_notify = Arc::new(Notify::new());

    let upstream_entered = entered_notify.clone();
    let upstream_release = release_notify.clone();
    tokio::spawn(async move {
        loop {
            let Ok((tcp_stream, _)) = upstream_listener.accept().await else {
                break;
            };
            let entered = upstream_entered.clone();
            let release = upstream_release.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let svc = service_fn(move |req: Request<Incoming>| {
                    let entered = entered.clone();
                    let release = release.clone();
                    async move {
                        let path = req.uri().path().to_string();
                        let _ = req.into_body().collect().await;
                        entered.notify_one();
                        release.notified().await;
                        if path == "/api/cached-304" {
                            Ok::<_, Infallible>(
                                Response::builder()
                                    .status(StatusCode::NOT_MODIFIED)
                                    .body(Full::new(Bytes::new()))
                                    .unwrap(),
                            )
                        } else {
                            Ok::<_, Infallible>(
                                Response::builder()
                                    .status(StatusCode::OK)
                                    .header(CONTENT_TYPE, "application/json")
                                    .body(Full::new(Bytes::from_static(b"{\"phase\":2}")))
                                    .unwrap(),
                            )
                        }
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, svc)
                    .await;
            });
        }
    });

    let tmp_dir =
        std::env::temp_dir().join(format!("fluxproxy-test-twophase-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("twophase.sqlite")).unwrap());
    let (event_tx, mut event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, mut removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);

    // Enable `drop_non_matching_on_capture` + `hide_304_not_modified` + matrix include `status == 200`
    let mut cfg = filters.get_config();
    cfg.drop_non_matching_on_capture = true;
    cfg.noise_thresholds.hide_304_not_modified = true;
    cfg.capture_matrix_enabled = true;
    cfg.capture_filter_rules = vec![crate::models::CaptureFilterRule {
        id: "inc-200".into(),
        enabled: true,
        action: "include".into(),
        logical_op: "AND".into(),
        field: "status".into(),
        operator: "equals".into(),
        value: "200".into(),
    }];
    filters.update_config(cfg);

    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();
    let ctx = Arc::new(SharedProxyContext {
        ca,
        rules,
        filters,
        breakpoints,
        host_remap: Arc::new(HostRemapRegistry::new()),
        upstream_proxy: Arc::new(UpstreamProxyManager::new()),
        throttle: Arc::new(ThrottleEngine::new()),
        store: store.clone(),
        upstream_http_client: test_upstream_http_client(None),
        remote_upstream_http_client: test_remote_upstream_http_client(None),
        shared_http1_tls_config: shared_http1_tls_config().unwrap(),
        client_certs: Arc::new(ClientCertificateStore::in_memory()),
        script_runner: Arc::new(PythonScriptRunner::new(None)),
        active_ws_channels: Arc::new(DashMap::new()),
        event_tx,
        removed_tx,
        active_port: AtomicU16::new(proxy_addr.port()),
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
        response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
        )),
        composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
        )),
        app_handle: None,
        stats_dirty: Arc::new(AtomicBool::new(false)),
    });

    let proxy_ctx = ctx.clone();
    tokio::spawn(async move {
        loop {
            let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                break;
            };
            let c = proxy_ctx.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_c = c.clone();
                    let proc_info = Some(ClientProcessInfo {
                        pid: 4242,
                        name: "node.exe".into(),
                    });
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(req, client_addr, proc_info, ClientConnContext::new(), inner_c)
                                .await,
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            });
        }
    });

    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
        .build()
        .unwrap();

    // Part A: Slow upstream POST -> verify Phase 1 (`status: 0` + request body), annotate, then verify Phase 2 update
    let url_ok = format!("http://127.0.0.1:{}/api/slow-submit", upstream_addr.port());
    let client_ok = client.clone();
    let req_task = tokio::spawn(async move {
        client_ok
            .post(url_ok)
            .header("X-Trace-Id", "two-phase-1")
            .body("{\"action\":\"create\"}")
            .send()
            .await
            .unwrap()
    });

    tokio::time::timeout(Duration::from_secs(5), entered_notify.notified())
        .await
        .expect("upstream received request headers");

    let phase1 = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
        .await
        .expect("phase 1 event arrives immediately")
        .expect("phase 1 summary");
    assert_eq!(phase1.status, 0);
    assert_eq!(phase1.duration_ms, 0);
    assert_eq!(phase1.body_size, 0);
    assert_eq!(phase1.content_type, "");

    let stored_p1 = store.get(phase1.id).expect("in-flight session stored");
    assert_eq!(stored_p1.summary.status, 0);
    assert!(stored_p1
        .request_headers
        .iter()
        .any(|h| h.name.eq_ignore_ascii_case("x-trace-id") && h.value == "two-phase-1"));
    assert_eq!(
        stored_p1.request_body_text.as_deref(),
        Some("{\"action\":\"create\"}")
    );
    assert!(stored_p1.response_headers.is_empty());

    // Annotate while request is still in-flight
    store
        .annotate_session(
            phase1.id,
            Some("waiting on upstream".into()),
            Some("amber".into()),
        )
        .unwrap();

    // Allow upstream to respond
    release_notify.notify_one();
    let resp_ok = req_task.await.unwrap();
    assert_eq!(resp_ok.status(), StatusCode::OK);

    let phase2 = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
        .await
        .expect("phase 2 event arrives")
        .expect("phase 2 summary");
    assert_eq!(phase2.id, phase1.id);
    assert_eq!(phase2.status, 200);
    assert!(phase2.body_size > 0);
    assert_eq!(phase2.comment.as_deref(), Some("waiting on upstream"));
    assert_eq!(phase2.marked_color.as_deref(), Some("amber"));

    let stored_p2 = store.get(phase1.id).expect("completed session updated in place");
    assert_eq!(stored_p2.summary.status, 200);
    assert_eq!(
        stored_p2.response_body_text.as_deref(),
        Some("{\"phase\":2}")
    );
    assert_eq!(
        stored_p2.summary.comment.as_deref(),
        Some("waiting on upstream")
    );
    assert_eq!(stored_p2.summary.marked_color.as_deref(), Some("amber"));
    assert!(removed_rx.try_recv().is_err());

    // Part B: Request that passes Phase 1 (`status: 0`) but gets dropped in Phase 2 (`304 Not Modified`)
    let url_304 = format!("http://127.0.0.1:{}/api/cached-304", upstream_addr.port());
    let client_304 = client.clone();
    let req_304_task = tokio::spawn(async move { client_304.get(url_304).send().await.unwrap() });

    tokio::time::timeout(Duration::from_secs(5), entered_notify.notified())
        .await
        .expect("upstream received 304 request");

    let p1_304 = loop {
        let ev = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
            .await
            .expect("phase 1 for 304 arrives before response")
            .expect("summary");
        if ev.id == phase1.id {
            assert_eq!(ev.status, 200);
            continue;
        }
        break ev;
    };
    assert_eq!(p1_304.status, 0);
    assert!(store.get(p1_304.id).is_some());

    release_notify.notify_one();
    let resp_304 = req_304_task.await.unwrap();
    assert_eq!(resp_304.status(), StatusCode::NOT_MODIFIED);

    let removed = tokio::time::timeout(Duration::from_secs(2), removed_rx.recv())
        .await
        .expect("removed event arrives")
        .expect("removed ids");
    assert_eq!(removed, vec![p1_304.id]);
    assert!(store.get(p1_304.id).is_none());

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[test]
fn mobile_portal_html_escapes_dynamic_fields_against_xss() {
    let html = render_mobile_portal_html(
        "10.0.0.1<script>alert(1)</script>",
        "evil.com\" onmouseover=\"alert(2)",
        "AB:CD'<img src=x onerror=alert(3)>",
        "Mozilla/5.0 iPhone <svg onload=alert(4)>",
    );

    assert!(!html.contains("<script>alert(1)</script>"));
    assert!(!html.contains("<img src=x onerror=alert(3)>"));
    assert!(!html.contains("<svg onload=alert(4)>"));
    assert!(!html.contains("\" onmouseover=\"alert(2)"));
    assert!(html.contains("10.0.0.1&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert!(html.contains("evil.com&quot; onmouseover=&quot;alert(2)"));
    assert!(html.contains("AB:CD&#39;&lt;img src=x onerror=alert(3)&gt;"));
    assert!(html.contains("Определено устройство: iOS / iPadOS"));
}

#[tokio::test]
async fn formats_full_reqwest_error_source_chain() {
    #[derive(Debug)]
    struct LeafCause(&'static str);
    impl std::fmt::Display for LeafCause {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }
    impl std::error::Error for LeafCause {}

    #[derive(Debug)]
    struct MiddleCause {
        msg: &'static str,
        src: Box<dyn std::error::Error + Send + Sync>,
    }
    impl std::fmt::Display for MiddleCause {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.msg)
        }
    }
    impl std::error::Error for MiddleCause {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&*self.src)
        }
    }

    let nested = MiddleCause {
        msg: "error sending request for url",
        src: Box::new(MiddleCause {
            msg: "client error (Connect)",
            src: Box::new(MiddleCause {
                msg: "client error (Connect)",
                src: Box::new(LeafCause("ConnectionReset")),
            }),
        }),
    };
    assert_eq!(
        format_error_chain(&nested),
        "error sending request for url -> client error (Connect) -> ConnectionReset"
    );

    // Verify real reqwest error source traversal
    let dead_probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_port = dead_probe.local_addr().unwrap().port();
    drop(dead_probe);

    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("reqwest test client should build");
    let req_err = client
        .get(format!("http://127.0.0.1:{dead_port}/unreachable"))
        .send()
        .await
        .expect_err("connecting to closed port must fail");
    let formatted_real = format_error_chain(&req_err);
    assert!(
        formatted_real.contains(" -> "),
        "expected reqwest error chain with ` -> `, got: {formatted_real}"
    );
}

