use super::*;

#[tokio::test]
async fn multi_bind_dual_listener_stops_all_tasks_and_rolls_back_addr_in_use() {
    let Some(specific_ip) = pick_distinct_bindable_ip_for_test().await else {
        // Skip cleanly on restricted hosts with only 127.0.0.1 available
        return;
    };

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-multibind-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let store = Arc::new(TrafficStore::new(tmp_dir.join("multibind.sqlite")).unwrap());
    let os_backend = RecordingOsProxyBackend::new();
    let sysproxy = Arc::new(SystemProxyManager::with_backend(
        &tmp_dir,
        os_backend.clone(),
    ));

    let controller = ProxyEngineController::new_for_test(
        ca,
        rules,
        filters,
        store,
        sysproxy,
    )
    .unwrap();

    // Allocate an ephemeral port that is free right now, then start in Loopback mode
    let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let test_port = probe.local_addr().unwrap().port();
    drop(probe);

    let started = controller
        .start("127.0.0.1".to_string(), test_port)
        .await
        .expect("start loopback on ephemeral port");
    assert!(started.running);
    assert_eq!(started.bind_mode, BindHostMode::Loopback);
    assert_eq!(started.bound_ips, vec!["127.0.0.1".to_string()]);
    assert_eq!(os_backend.last_target(), Some(("127.0.0.1".to_string(), test_port)));

    // Rebind to Specific + also_bind_loopback = true (Dual Listener)
    let dual_status = controller
        .set_bind_configuration(BindHostMode::Specific, Some(specific_ip.clone()), true)
        .await
        .expect("rebind to dual listener");
    assert!(dual_status.running);
    assert_eq!(dual_status.bind_mode, BindHostMode::Specific);
    assert_eq!(dual_status.specific_bind_ip.as_deref(), Some(specific_ip.as_str()));
    assert!(dual_status.also_bind_loopback);
    assert_eq!(
        dual_status.bound_ips,
        vec![specific_ip.clone(), "127.0.0.1".to_string()]
    );
    // OS system proxy stays on 127.0.0.1 when also_bind_loopback == true
    assert_eq!(os_backend.last_target(), Some(("127.0.0.1".to_string(), test_port)));

    // Verify TCP connections succeed on BOTH listeners
    TcpStream::connect(format!("{specific_ip}:{test_port}"))
        .await
        .expect("connect to primary specific IP listener");
    TcpStream::connect(format!("127.0.0.1:{test_port}"))
        .await
        .expect("connect to secondary loopback listener");

    // Switch also_bind_loopback -> false: single socket on specific_ip, system proxy updated to specific_ip
    let single_specific = controller
        .set_bind_configuration(BindHostMode::Specific, Some(specific_ip.clone()), false)
        .await
        .expect("rebind to specific without loopback");
    assert_eq!(single_specific.bound_ips, vec![specific_ip.clone()]);
    assert!(!single_specific.also_bind_loopback);
    assert_eq!(os_backend.last_target(), Some((specific_ip.clone(), test_port)));
    assert!(
        TcpListener::bind(format!("127.0.0.1:{test_port}")).await.is_ok(),
        "loopback socket must be released when also_bind_loopback is disabled"
    );

    // Re-enable dual listener, then test stop() synchronously shuts down all listener tasks
    let dual_again = controller
        .set_bind_configuration(BindHostMode::Specific, Some(specific_ip.clone()), true)
        .await
        .expect("rebind back to dual listener");
    assert_eq!(
        dual_again.bound_ips,
        vec![specific_ip.clone(), "127.0.0.1".to_string()]
    );

    let stopped = controller.stop().await;
    assert!(!stopped.running);

    // Both sockets must be released synchronously right after stop() returns
    let rebind_primary = TcpListener::bind(format!("{specific_ip}:{test_port}"))
        .await
        .expect("primary specific socket must be free after stop");
    drop(rebind_primary);
    let rebind_loopback = TcpListener::bind(format!("127.0.0.1:{test_port}"))
        .await
        .expect("secondary loopback socket must be free after stop");
    drop(rebind_loopback);

    // Test AddrInUse cleanup: occupy 127.0.0.1:conflict_port, then attempt dual bind
    // on [specific_ip, "127.0.0.1"]. First socket must be closed immediately when second fails.
    let occupied_loopback = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let conflict_port = occupied_loopback.local_addr().unwrap().port();
    let err = bind_listeners_with_cleanup(
        &[specific_ip.clone(), "127.0.0.1".to_string()],
        conflict_port,
        1,
    )
    .await
    .expect_err("second socket AddrInUse should fail dual bind");
    assert!(
        err.to_string().contains("AddrInUse"),
        "error should explain AddrInUse: {err}"
    );
    // Primary specific_ip:conflict_port MUST have been closed by cleanup
    let verify_primary_closed = TcpListener::bind(format!("{specific_ip}:{conflict_port}"))
        .await
        .expect("primary socket must be rolled back after second socket fails with AddrInUse");
    drop(verify_primary_closed);
    drop(occupied_loopback);

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn set_port_updates_stopped_and_running_with_rollback_on_addr_in_use() {
    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-setport-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let store = Arc::new(TrafficStore::new(tmp_dir.join("setport.sqlite")).unwrap());
    let os_backend = RecordingOsProxyBackend::new();
    let sysproxy = Arc::new(SystemProxyManager::with_backend(
        &tmp_dir,
        os_backend.clone(),
    ));

    let controller = ProxyEngineController::new_for_test(
        ca,
        rules,
        filters,
        store,
        sysproxy.clone(),
    )
    .unwrap();

    let p1_probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p1 = p1_probe.local_addr().unwrap().port();
    drop(p1_probe);

    // 1. Update port while stopped -> persists pref and updates preferred_port
    let stopped_status = controller.set_port(p1).await.expect("set_port while stopped");
    assert!(!stopped_status.running);
    assert_eq!(stopped_status.port, p1);
    assert_eq!(controller.preferred_port(), p1);
    assert_eq!(sysproxy.load_proxy_port_pref(), p1);

    // 2. Start using preferred_port
    let started = controller
        .start_with_config(controller.preferred_port())
        .await
        .expect("start on preferred_port");
    assert!(started.running);
    assert_eq!(started.port, p1);

    // 3. Rebind to another free port p2 while running
    let p2_probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p2 = p2_probe.local_addr().unwrap().port();
    drop(p2_probe);

    let moved = controller.set_port(p2).await.expect("set_port to p2 while running");
    assert!(moved.running);
    assert_eq!(moved.port, p2);
    assert_eq!(sysproxy.load_proxy_port_pref(), p2);
    TcpStream::connect(format!("127.0.0.1:{p2}"))
        .await
        .expect("connect to new port p2");

    // 4. Attempt switching to an already occupied port -> must fail AND roll back listener to p2
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let occupied_port = occupied.local_addr().unwrap().port();
    let err = controller
        .set_port(occupied_port)
        .await
        .expect_err("occupied port should fail");
    assert!(err.to_string().contains("AddrInUse"));

    let after_rollback = controller.status().await;
    assert!(after_rollback.running);
    assert_eq!(after_rollback.port, p2);
    assert_eq!(sysproxy.load_proxy_port_pref(), p2);
    TcpStream::connect(format!("127.0.0.1:{p2}"))
        .await
        .expect("listener restored on p2 after rollback");

    controller.stop().await;
    drop(occupied);
    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[test]
fn sec03_portal_target_loopback_unspecified_and_mtls_peer_guards() {
    // Portal target detects IPv6-mapped loopback & unspecified addresses on active port
    assert!(is_builtin_portal_target("[::ffff:127.0.0.1]:8888", false, 8888));
    assert!(is_builtin_portal_target("::ffff:127.0.0.1:8888", false, 8888));
    assert!(is_builtin_portal_target("[::1]:8888", false, 8888));
    assert!(is_builtin_portal_target("0.0.0.0:8888", false, 8888));
    assert!(is_builtin_portal_target("flux.proxy", false, 8888));
    assert!(!is_builtin_portal_target("[::ffff:127.0.0.1]:9999", false, 8888));

    // Loopback & unspecified host checks for LAN SSRF protection
    for blocked in [
        "localhost",
        "api.localhost:8080",
        "127.0.0.1",
        "127.42.0.1:9000",
        "::1",
        "[::1]:443",
        "::ffff:127.0.0.1",
        "[::ffff:127.5.6.7]:8443",
        "0.0.0.0:80",
        "::",
        "[::ffff:0.0.0.0]:80",
        "127.1",
        "2130706433",
    ] {
        assert!(
            is_loopback_or_unspecified_host(blocked),
            "expected loopback/unspecified host to be blocked: {blocked}"
        );
    }

    for allowed in ["api.example.com", "192.168.1.50:8443", "8.8.8.8", "2606:4700:4700::1111"] {
        assert!(
            !is_loopback_or_unspecified_host(allowed),
            "expected external host to be allowed: {allowed}"
        );
    }

    assert!(request_targets_loopback_or_unspecified(
        "example.com",
        "http://127.0.0.1:8080/admin"
    ));
    assert!(request_targets_loopback_or_unspecified(
        "127.0.0.1:8080",
        "http://example.com/"
    ));
    assert!(!request_targets_loopback_or_unspecified(
        "example.com",
        "https://example.com/api"
    ));

    // mTLS client cert lookup must be disabled for external LAN peers
    assert!(!should_use_host_mtls_for_peer(
        "192.168.1.50:55555".parse().unwrap(),
        "https"
    ));
    assert!(!should_use_host_mtls_for_peer(
        "[::ffff:192.168.1.50]:55555".parse().unwrap(),
        "https"
    ));
    assert!(should_use_host_mtls_for_peer(
        "127.0.0.1:55555".parse().unwrap(),
        "https"
    ));
    assert!(should_use_host_mtls_for_peer(
        "[::1]:55555".parse().unwrap(),
        "https"
    ));
    assert!(should_use_host_mtls_for_peer(
        "[::ffff:127.0.0.1]:55555".parse().unwrap(),
        "https"
    ));
    assert!(!should_use_host_mtls_for_peer(
        "127.0.0.1:55555".parse().unwrap(),
        "http"
    ));
}

#[tokio::test]
async fn sec03_blocks_self_connect_and_targeted_only_host_header_bypass() {
    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-sec03-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    filters.update_config(ProxyFilterBackendConfig {
        tls_intercept_mode: TlsInterceptMode::TargetedOnly,
        tls_bypass_enabled: true,
        tls_bypass_rules: Vec::new(),
        tls_target_rules: vec![TlsBypassRule {
            id: "only-allowed".into(),
            enabled: true,
            pattern: "allowed.test".into(),
            category: "Target".into(),
            description: "Allow only allowed.test".into(),
        }],
        header_mutations_enabled: false,
        header_mutations: Vec::new(),
        strip_alt_svc: true,
        host_list_sync: Default::default(),
        ..crate::proxy::filters::default_backend_config()
    });

    let store = Arc::new(TrafficStore::new(tmp_dir.join("sec03.sqlite")).unwrap());
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();

    let ctx = Arc::new(SharedProxyContext {
        ca: ca.clone(),
        rules,
        filters,
        breakpoints: Arc::new(BreakpointEngine::new(None)),
        host_remap: Arc::new(HostRemapRegistry::new()),
        upstream_proxy: Arc::new(UpstreamProxyManager::new()),
        throttle: Arc::new(ThrottleEngine::new()),
        store,
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
        for _ in 0..4 {
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

    // 1. Self-CONNECT in TargetedOnly mode (including IPv6-mapped ::ffff:127.0.0.1) must be 403 Forbidden
    for self_auth in [
        format!("127.0.0.1:{}", proxy_addr.port()),
        format!("[::ffff:127.0.0.1]:{}", proxy_addr.port()),
    ] {
        let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
        let req = format!("CONNECT {self_auth} HTTP/1.1\r\nHost: {self_auth}\r\n\r\n");
        sock.write_all(req.as_bytes()).await.unwrap();
        let mut buf = [0u8; 512];
        let n = sock.read(&mut buf).await.unwrap();
        let resp = String::from_utf8_lossy(&buf[..n]);
        assert!(
            resp.starts_with("HTTP/1.1 403"),
            "expected 403 for self-CONNECT {self_auth}, got: {resp}"
        );
    }

    // 2. Spoofed Host inside TargetedOnly CONNECT MITM tunnel must be rejected with 403 Forbidden
    let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
    sock.write_all(b"CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n")
        .await
        .unwrap();
    let mut connect_buf = [0u8; 256];
    let n = sock.read(&mut connect_buf).await.unwrap();
    assert!(String::from_utf8_lossy(&connect_buf[..n]).starts_with("HTTP/1.1 200"));

    let mut root_store = rustls::RootCertStore::empty();
    root_store
        .add(rustls::pki_types::CertificateDer::from(
            ca.root_ca_der().to_vec(),
        ))
        .unwrap();
    let tls_cfg = Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth(),
    );
    let connector = tokio_rustls::TlsConnector::from(tls_cfg);
    let server_name = rustls::pki_types::ServerName::try_from("allowed.test").unwrap();
    let mut tls_stream = connector.connect(server_name, sock).await.unwrap();

    tls_stream
        .write_all(
            b"GET /secret HTTP/1.1\r\nHost: non-allowlisted.example.com\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
    let mut resp_bytes = Vec::new();
    let _ = tls_stream.read_to_end(&mut resp_bytes).await;
    let inner_resp = String::from_utf8_lossy(&resp_bytes);
    assert!(
        inner_resp.starts_with("HTTP/1.1 403"),
        "expected 403 for spoofed Host inside TargetedOnly tunnel, got: {inner_resp}"
    );

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[test]
fn split_authority_parses_ipv6_and_host_port_variants() {
    assert_eq!(split_authority("[::1]"), ("::1".to_string(), 443));
    assert_eq!(split_authority("[::1]:8443"), ("::1".to_string(), 8443));
    assert_eq!(split_authority("::1"), ("::1".to_string(), 443));
    assert_eq!(
        split_authority("[2001:db8::1]:9443"),
        ("2001:db8::1".to_string(), 9443)
    );
    assert_eq!(
        split_authority("2001:db8::8080"),
        ("2001:db8::8080".to_string(), 443)
    );
    assert_eq!(
        split_authority("api.example.com:8443"),
        ("api.example.com".to_string(), 8443)
    );
    assert_eq!(
        split_authority("api.example.com"),
        ("api.example.com".to_string(), 443)
    );
    assert_eq!(
        split_authority("127.0.0.1:8080"),
        ("127.0.0.1".to_string(), 8080)
    );
}

#[tokio::test]
async fn set_bind_configuration_rolls_back_sysproxy_on_double_bind_failure() {
    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-bind-rollback-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let store = Arc::new(TrafficStore::new(tmp_dir.join("bind-rollback.sqlite")).unwrap());
    let os_backend = RecordingOsProxyBackend::new();
    let sysproxy = Arc::new(SystemProxyManager::with_backend(
        &tmp_dir,
        os_backend.clone(),
    ));

    let controller = ProxyEngineController::new_for_test(
        ca,
        rules,
        filters,
        store,
        sysproxy,
    )
    .unwrap();

    let started = controller
        .start("127.0.0.1".to_string(), 0)
        .await
        .expect("start loopback proxy");
    assert!(started.running);
    assert!(started.system_proxy_enabled);

    // Simulate previous bound interface becoming unavailable (e.g. Wi-Fi disconnected)
    {
        let mut guard = controller.lock_runtime();
        guard.bind_mode = BindHostMode::Specific;
        guard.specific_bind_ip = Some("203.0.113.1".to_string());
        guard.also_bind_loopback = false;
        guard.bound_ips = vec!["203.0.113.1".to_string()];
    }

    // Switching to another unbindable IP causes primary + fallback binds to fail
    let err = controller
        .set_bind_configuration(
            BindHostMode::Specific,
            Some("203.0.113.2".to_string()),
            false,
        )
        .await
        .expect_err("double bind failure must return error");
    let _ = err;

    let post_status = controller.status().await;
    assert!(!post_status.running);
    assert!(
        !post_status.system_proxy_enabled,
        "OS system proxy must be rolled back on double bind failure"
    );
    assert!(os_backend.active.lock().unwrap().is_none());

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn hosts_remap_redirects_http_request_to_local_test_server_and_marks_session() {
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
                    let host_hdr = req
                        .headers()
                        .get(http::header::HOST)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    let path = req
                        .uri()
                        .path_and_query()
                        .map(|pq| pq.as_str())
                        .unwrap_or("/")
                        .to_string();
                    let body = format!("host={host_hdr};path={path}");
                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(StatusCode::OK)
                            .header("Content-Type", "text/plain")
                            .body(Full::new(Bytes::from(body)))
                            .unwrap(),
                    )
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, svc)
                    .await;
            });
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-hosts-http-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let host_remap = Arc::new(HostRemapRegistry::new());
    let throttle = Arc::new(ThrottleEngine::new());
    let store = Arc::new(TrafficStore::new(tmp_dir.join("hosts-http.sqlite")).unwrap());
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);

    host_remap
        .set_rules(vec![crate::models::HostRemapRule {
            id: "http-remap".into(),
            enabled: true,
            source_pattern: "api.virtual-prod.invalid".into(),
            target_host: "127.0.0.1".into(),
            target_port: Some(upstream_addr.port()),
            preserve_host_header: true,
            comment: "redirect prod API to local upstream".into(),
        }])
        .unwrap();

    let resolver = Arc::clone(&host_remap);

    let ctx = Arc::new(SharedProxyContext {
        ca,
        rules,
        filters,
        breakpoints,
        host_remap: host_remap.clone(),
        upstream_proxy: Arc::new(UpstreamProxyManager::new()),
        throttle,
        store: store.clone(),
        upstream_http_client: test_upstream_http_client(Some(resolver)),
        remote_upstream_http_client: test_remote_upstream_http_client(Some(Arc::clone(&host_remap))),
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
        loop {
            let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                break;
            };
            let c = proxy_ctx.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_ctx = c.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_ctx).await,
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

    // 1. preserve_host_header = true -> upstream receives virtual Host header
    let resp1 = client
        .get("http://api.virtual-prod.invalid/v1/items?page=1")
        .send()
        .await
        .unwrap();
    assert_eq!(resp1.status(), StatusCode::OK);
    let body1 = resp1.text().await.unwrap();
    assert_eq!(body1, "host=api.virtual-prod.invalid;path=/v1/items?page=1");

    // 2. preserve_host_header = false -> upstream receives target host:port as Host header
    host_remap
        .set_rules(vec![crate::models::HostRemapRule {
            id: "http-remap".into(),
            enabled: true,
            source_pattern: "api.virtual-prod.invalid".into(),
            target_host: "127.0.0.1".into(),
            target_port: Some(upstream_addr.port()),
            preserve_host_header: false,
            comment: "rewrite Host header".into(),
        }])
        .unwrap();
    ctx.rebuild_upstream_clients();

    let resp2 = client
        .get("http://api.virtual-prod.invalid/v1/override")
        .send()
        .await
        .unwrap();
    assert_eq!(resp2.status(), StatusCode::OK);
    let body2 = resp2.text().await.unwrap();
    assert_eq!(
        body2,
        format!("host=127.0.0.1:{};path=/v1/override", upstream_addr.port())
    );

    tokio::time::sleep(Duration::from_millis(40)).await;
    let summaries = store.list_summaries();
    assert_eq!(summaries.len(), 2);
    let expected_remap = Some(format!("127.0.0.1:{}", upstream_addr.port()));
    for s in &summaries {
        assert_eq!(s.remapped_to, expected_remap);
        let detail = store.get(s.id).unwrap();
        assert_eq!(detail.summary.remapped_to, expected_remap);
    }

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn hosts_remap_preserves_tls_sni_for_https_upstream() {
    let tls_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tls_addr = tls_listener.local_addr().unwrap();
    let (sni_tx, sni_rx) = tokio::sync::oneshot::channel::<Option<String>>();

    tokio::spawn(async move {
        if let Ok((stream, _)) = tls_listener.accept().await {
            let acceptor =
                tokio_rustls::LazyConfigAcceptor::new(rustls::server::Acceptor::default(), stream);
            tokio::pin!(acceptor);
            let sni = match acceptor.as_mut().await {
                Ok(start) => start.client_hello().server_name().map(str::to_owned),
                Err(_) => None,
            };
            let _ = sni_tx.send(sni);
        }
    });

    let host_remap = Arc::new(HostRemapRegistry::new());
    host_remap
        .set_rules(vec![crate::models::HostRemapRule {
            id: "sni-test".into(),
            enabled: true,
            source_pattern: "sni-check.virtual-prod.invalid".into(),
            target_host: "127.0.0.1".into(),
            target_port: Some(tls_addr.port()),
            preserve_host_header: true,
            comment: "SNI verification".into(),
        }])
        .unwrap();

    let resolver = Arc::clone(&host_remap);
    let client = UpstreamHttpClient::build(
        Some(resolver),
        None,
        None,
        Arc::new(std::sync::atomic::AtomicU64::new(DEFAULT_UPSTREAM_TIMEOUT_SEC)),
        false,
    )
    .unwrap();

    let _ = client
        .send_request(
            hyper::Method::GET,
            "https://sni-check.virtual-prod.invalid/ping",
            &[],
            None,
            bytes::Bytes::new(),
            Some(Duration::from_secs(3)),
        )
        .await;

    let captured_sni = tokio::time::timeout(Duration::from_secs(3), sni_rx)
        .await
        .expect("TLS listener should accept ClientHello within timeout")
        .expect("SNI sender should not drop before sending");

    assert_eq!(
        captured_sni.as_deref(),
        Some("sni-check.virtual-prod.invalid"),
        "HTTPS upstream TLS handshake must keep original domain as SNI even when remapped to 127.0.0.1"
    );
}

#[tokio::test]
async fn hosts_remap_redirects_connect_passthrough_and_offline_throttle_blocks() {
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

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-remap-connect-offline-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let host_remap = Arc::new(HostRemapRegistry::new());
    let throttle = Arc::new(ThrottleEngine::new());
    let store = Arc::new(
        TrafficStore::new(tmp_dir.join("remap-connect-offline.sqlite")).unwrap(),
    );
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);

    filters.update_config(ProxyFilterBackendConfig {
        tls_intercept_mode: TlsInterceptMode::InterceptAll,
        tls_bypass_enabled: true,
        tls_bypass_rules: vec![TlsBypassRule {
            id: "bypass-pinned-remap".into(),
            enabled: true,
            pattern: "pinned.virtual-prod.invalid".into(),
            category: "Test".into(),
            description: "Pinned virtual host".into(),
        }],
        tls_target_rules: Vec::new(),
        header_mutations_enabled: true,
        header_mutations: Vec::new(),
        strip_alt_svc: true,
        host_list_sync: Default::default(),
        ..crate::proxy::filters::default_backend_config()
    });

    host_remap
        .set_rules(vec![crate::models::HostRemapRule {
            id: "connect-remap".into(),
            enabled: true,
            source_pattern: "pinned.virtual-prod.invalid".into(),
            target_host: "127.0.0.1".into(),
            target_port: Some(upstream_addr.port()),
            preserve_host_header: true,
            comment: "redirect CONNECT passthrough".into(),
        }])
        .unwrap();

    let ctx = Arc::new(SharedProxyContext {
        ca,
        rules,
        filters,
        breakpoints,
        host_remap,
        upstream_proxy: Arc::new(UpstreamProxyManager::new()),
        throttle: throttle.clone(),
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
        loop {
            let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                break;
            };
            let c = proxy_ctx.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_ctx = c.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(req, client_addr, None, ClientConnContext::new(), inner_ctx).await,
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service)
                    .await;
            });
        }
    });

    // 1. CONNECT passthrough redirects to local echo server on upstream_addr.port()
    let mut client = TcpStream::connect(proxy_addr).await.unwrap();
    let connect_req = "CONNECT pinned.virtual-prod.invalid:443 HTTP/1.1\r\nHost: pinned.virtual-prod.invalid:443\r\n\r\n";
    client.write_all(connect_req.as_bytes()).await.unwrap();

    let mut resp_buf = [0u8; 256];
    let n = client.read(&mut resp_buf).await.unwrap();
    let resp_str = String::from_utf8_lossy(&resp_buf[..n]);
    assert!(resp_str.starts_with("HTTP/1.1 200"));

    let payload = b"PING_REMAP_CONNECT";
    client.write_all(payload).await.unwrap();
    let mut echoed = vec![0u8; payload.len()];
    client.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, payload);
    drop(client);

    tokio::time::sleep(Duration::from_millis(40)).await;
    let expected_target = format!("127.0.0.1:{}", upstream_addr.port());
    let first_detail = store.get(1).unwrap();
    assert_eq!(first_detail.summary.remapped_to, Some(expected_target.clone()));
    assert!(first_detail
        .response_headers
        .iter()
        .any(|h| h.name == "X-FluxProxy-Host-Remap" && h.value == expected_target));

    // 2. Switch throttle preset to Offline -> CONNECT and HTTP both return 503
    throttle.set_config(crate::models::ThrottleConfig::from_preset(
        crate::models::ThrottlePreset::Offline,
    ));

    let mut offline_connect = TcpStream::connect(proxy_addr).await.unwrap();
    offline_connect
        .write_all(connect_req.as_bytes())
        .await
        .unwrap();
    let mut offline_buf = [0u8; 256];
    let n_off = offline_connect.read(&mut offline_buf).await.unwrap();
    let off_str = String::from_utf8_lossy(&offline_buf[..n_off]);
    assert!(
        off_str.starts_with("HTTP/1.1 503"),
        "expected CONNECT under Offline throttle to return 503, got: {off_str}"
    );

    let http_client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
        .build()
        .unwrap();
    let http_off_resp = http_client
        .get("http://127.0.0.1/offline-check")
        .send()
        .await
        .unwrap();
    assert_eq!(http_off_resp.status(), StatusCode::SERVICE_UNAVAILABLE);

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn upstream_proxy_chaining_routes_http_connect_ws_and_respects_bypass_list() {
    use crate::models::UpstreamProxyProtocol;
    use std::sync::atomic::AtomicUsize;
    use tokio_tungstenite::tungstenite::Message;

    // 1. Target HTTP + WS server (handles GET /hello and WS /ws)
    let target_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_addr = target_listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = target_listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut req_buf = Vec::new();
                let mut b = [0u8; 1];
                while !req_buf.ends_with(b"\r\n\r\n") {
                    if sock.read_exact(&mut b).await.is_err() {
                        return;
                    }
                    req_buf.push(b[0]);
                }
                let req_text = String::from_utf8_lossy(&req_buf);
                if let Some(key_line) = req_text
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("sec-websocket-key:"))
                {
                    let key = key_line.split(':').nth(1).unwrap_or("").trim();
                    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(
                        key.as_bytes(),
                    );
                    let resp = format!(
                        "HTTP/1.1 101 Switching Protocols\r\n\
                         Upgrade: websocket\r\n\
                         Connection: Upgrade\r\n\
                         Sec-WebSocket-Accept: {accept}\r\n\r\n"
                    );
                    sock.write_all(resp.as_bytes()).await.unwrap();
                    let mut ws =
                        WebSocketStream::from_raw_socket(sock, Role::Server, None).await;
                    if let Some(Ok(Message::Text(txt))) = ws.next().await {
                        let _ = ws.send(Message::Text(format!("echo:{txt}").into())).await;
                    }
                    let _ = ws.close(None).await;
                } else {
                    let body = "target-http-ok";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                }
            });
        }
    });

    // 2. Bypassed HTTP server (must be hit directly without upstream proxy)
    let bypassed_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bypassed_addr = bypassed_listener.local_addr().unwrap();
    let bypassed_hits = Arc::new(AtomicUsize::new(0));
    let bypassed_hits_srv = Arc::clone(&bypassed_hits);
    tokio::spawn(async move {
        while let Ok((sock, _)) = bypassed_listener.accept().await {
            let hits = Arc::clone(&bypassed_hits_srv);
            tokio::spawn(async move {
                let io = TokioIo::new(sock);
                let svc = service_fn(move |_req: Request<Incoming>| {
                    hits.fetch_add(1, Ordering::SeqCst);
                    async {
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(
                            b"bypass-direct-ok",
                        ))))
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection(io, svc)
                    .await;
            });
        }
    });

    // 3. Raw TCP echo server for CONNECT Passthrough through upstream proxy
    let raw_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let raw_addr = raw_listener.local_addr().unwrap();
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = raw_listener.accept().await {
            let mut buf = [0u8; 64];
            if let Ok(n) = sock.read(&mut buf).await {
                let _ = sock.write_all(&buf[..n]).await;
            }
        }
    });

    // 4. Mock Upstream HTTP Proxy requiring `Proxy-Authorization: Basic user:secret`
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();
    let upstream_http_hits = Arc::new(AtomicUsize::new(0));
    let upstream_connect_hits = Arc::new(AtomicUsize::new(0));
    let expected_auth = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode("user:secret")
    );

    let up_http_cnt = Arc::clone(&upstream_http_hits);
    let up_conn_cnt = Arc::clone(&upstream_connect_hits);
    tokio::spawn(async move {
        while let Ok((sock, _)) = upstream_listener.accept().await {
            let http_cnt = Arc::clone(&up_http_cnt);
            let conn_cnt = Arc::clone(&up_conn_cnt);
            let exp_auth = expected_auth.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(sock);
                let svc = service_fn(move |req: Request<Incoming>| {
                    let http_cnt = Arc::clone(&http_cnt);
                    let conn_cnt = Arc::clone(&conn_cnt);
                    let exp_auth = exp_auth.clone();
                    async move {
                        let auth_ok = req
                            .headers()
                            .get("proxy-authorization")
                            .and_then(|v| v.to_str().ok())
                            == Some(exp_auth.as_str());
                        if !auth_ok {
                            return Ok::<_, Infallible>(
                                Response::builder()
                                    .status(StatusCode::PROXY_AUTHENTICATION_REQUIRED)
                                    .body(boxed_full(Bytes::from_static(b"407 Auth Required")))
                                    .unwrap(),
                            );
                        }

                        if req.method() == http::Method::CONNECT {
                            conn_cnt.fetch_add(1, Ordering::SeqCst);
                            let authority = req.uri().authority().unwrap().to_string();
                            let mut target_tcp = TcpStream::connect(&authority).await.unwrap();
                            tokio::spawn(async move {
                                if let Ok(upgraded) = hyper::upgrade::on(req).await {
                                    let mut client_io = TokioIo::new(upgraded);
                                    let _ = tokio::io::copy_bidirectional(
                                        &mut client_io,
                                        &mut target_tcp,
                                    )
                                    .await;
                                }
                            });
                            return Ok(Response::builder()
                                .status(StatusCode::OK)
                                .body(boxed_full(Bytes::new()))
                                .unwrap());
                        }

                        http_cnt.fetch_add(1, Ordering::SeqCst);
                        let authority = req
                            .uri()
                            .authority()
                            .map(|a| a.to_string())
                            .unwrap_or_else(|| {
                                req.headers()
                                    .get(http::header::HOST)
                                    .and_then(|v| v.to_str().ok())
                                    .unwrap_or("")
                                    .to_string()
                            });
                        let path = req
                            .uri()
                            .path_and_query()
                            .map(|p| p.as_str())
                            .unwrap_or("/");
                        let mut target_tcp = TcpStream::connect(&authority).await.unwrap();
                        let raw_req = format!(
                            "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                            req.method(),
                            path,
                            authority
                        );
                        target_tcp.write_all(raw_req.as_bytes()).await.unwrap();
                        let mut raw_resp = Vec::new();
                        let _ = target_tcp.read_to_end(&mut raw_resp).await;
                        let body_bytes = raw_resp
                            .windows(4)
                            .position(|w| w == b"\r\n\r\n")
                            .map(|pos| raw_resp[pos + 4..].to_vec())
                            .unwrap_or_default();
                        Ok(Response::builder()
                            .status(StatusCode::OK)
                            .body(boxed_full(Bytes::from(body_bytes)))
                            .unwrap())
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, svc)
                    .await;
            });
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-upstream-chain-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    filters.update_config(ProxyFilterBackendConfig {
        tls_intercept_mode: TlsInterceptMode::InterceptAll,
        tls_bypass_enabled: true,
        tls_bypass_rules: vec![TlsBypassRule {
            id: "bypass-raw-connect".into(),
            enabled: true,
            pattern: "127.0.0.1".into(),
            category: "Test".into(),
            description: "Test passthrough CONNECT".into(),
        }],
        ..crate::proxy::filters::default_backend_config()
    });
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("upstream-chain.sqlite")).unwrap());
    let upstream_proxy = Arc::new(UpstreamProxyManager::new());
    upstream_proxy
        .set_config(UpstreamProxyConfig {
            enabled: true,
            protocol: UpstreamProxyProtocol::Http,
            host: "127.0.0.1".into(),
            port: upstream_addr.port(),
            username: Some("user".into()),
            password: Some("secret".into()),
            has_password: true,
            bypass_list: vec![format!("127.0.0.1:{}", bypassed_addr.port())],
        })
        .unwrap();

    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
    let ctx = Arc::new(SharedProxyContext {
        ca,
        rules,
        filters,
        breakpoints,
        host_remap: Arc::new(HostRemapRegistry::new()),
        upstream_proxy,
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
    ctx.rebuild_upstream_clients();

    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();
    let proxy_ctx = ctx.clone();

    tokio::spawn(async move {
        while let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
            let c = proxy_ctx.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_c = c.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(
                                req,
                                client_addr,
                                None,
                                ClientConnContext::new(),
                                inner_c,
                            )
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
        .proxy(reqwest::Proxy::all(format!("http://{proxy_addr}")).unwrap())
        .build()
        .unwrap();

    // A. Non-bypassed HTTP request -> routed through upstream HTTP proxy
    let resp_http = client
        .get(format!("http://{target_addr}/hello"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp_http.status(), StatusCode::OK);
    assert_eq!(resp_http.text().await.unwrap(), "target-http-ok");
    assert_eq!(upstream_http_hits.load(Ordering::SeqCst), 1);

    // B. Bypassed HTTP request -> goes directly to bypassed_addr
    let resp_bypass = client
        .get(format!("http://{bypassed_addr}/bypass"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp_bypass.status(), StatusCode::OK);
    assert_eq!(resp_bypass.text().await.unwrap(), "bypass-direct-ok");
    assert_eq!(upstream_http_hits.load(Ordering::SeqCst), 1);
    assert_eq!(bypassed_hits.load(Ordering::SeqCst), 1);

    // C. CONNECT Passthrough tunnel -> routed via upstream proxy CONNECT
    let mut connect_tcp = TcpStream::connect(proxy_addr).await.unwrap();
    let connect_req = format!("CONNECT {raw_addr} HTTP/1.1\r\nHost: {raw_addr}\r\n\r\n");
    connect_tcp.write_all(connect_req.as_bytes()).await.unwrap();
    let mut connect_resp = Vec::new();
    let mut b = [0u8; 1];
    while !connect_resp.ends_with(b"\r\n\r\n") {
        connect_tcp.read_exact(&mut b).await.unwrap();
        connect_resp.push(b[0]);
    }
    assert!(String::from_utf8_lossy(&connect_resp).starts_with("HTTP/1.1 200"));
    connect_tcp.write_all(b"TUNNEL_OK").await.unwrap();
    let mut echo = [0u8; 9];
    connect_tcp.read_exact(&mut echo).await.unwrap();
    assert_eq!(&echo, b"TUNNEL_OK");
    assert_eq!(upstream_connect_hits.load(Ordering::SeqCst), 1);

    // D. WebSocket ws:// -> routed via upstream proxy CONNECT
    let mut ws_tcp = TcpStream::connect(proxy_addr).await.unwrap();
    let ws_upgrade = format!(
        "GET http://{target_addr}/ws HTTP/1.1\r\n\
         Host: {target_addr}\r\n\
         Connection: Upgrade\r\n\
         Upgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    ws_tcp.write_all(ws_upgrade.as_bytes()).await.unwrap();
    let mut ws_hs = Vec::new();
    while !ws_hs.ends_with(b"\r\n\r\n") {
        ws_tcp.read_exact(&mut b).await.unwrap();
        ws_hs.push(b[0]);
    }
    assert!(String::from_utf8_lossy(&ws_hs).starts_with("HTTP/1.1 101"));
    assert_eq!(upstream_connect_hits.load(Ordering::SeqCst), 2);

    let mut ws_client = WebSocketStream::from_raw_socket(ws_tcp, Role::Client, None).await;
    ws_client
        .send(Message::Text("ws-via-proxy".into()))
        .await
        .unwrap();
    let ws_reply = ws_client.next().await.unwrap().unwrap().into_text().unwrap();
    assert_eq!(ws_reply.as_str(), "echo:ws-via-proxy");
    let _ = ws_client.close(None).await;

    tokio::time::sleep(Duration::from_millis(60)).await;
    let expected_via_ip = format!("via {upstream_addr}");
    let expected_via_proxy = format!("HTTP {upstream_addr}");
    let summaries = store.list_summaries();
    assert_eq!(summaries.len(), 4);

    let http_proxied = summaries
        .iter()
        .find(|s| s.path == "/hello")
        .expect("proxied HTTP summary");
    assert_eq!(
        http_proxied.server_ip.as_deref(),
        Some(expected_via_ip.as_str())
    );
    assert_eq!(
        store
            .get(http_proxied.id)
            .unwrap()
            .transfer_stats
            .as_ref()
            .and_then(|st| st.via_proxy_addr.as_deref()),
        Some(expected_via_proxy.as_str())
    );

    let http_bypassed = summaries
        .iter()
        .find(|s| s.path == "/bypass")
        .expect("bypassed HTTP summary");
    assert_eq!(http_bypassed.server_ip.as_deref(), Some("127.0.0.1"));
    assert_eq!(
        store
            .get(http_bypassed.id)
            .unwrap()
            .transfer_stats
            .as_ref()
            .and_then(|st| st.via_proxy_addr.as_deref()),
        None
    );

    let connect_proxied = summaries
        .iter()
        .find(|s| s.method == "CONNECT")
        .expect("proxied CONNECT summary");
    assert_eq!(
        connect_proxied.server_ip.as_deref(),
        Some(expected_via_ip.as_str())
    );
    assert_eq!(
        store
            .get(connect_proxied.id)
            .unwrap()
            .transfer_stats
            .as_ref()
            .and_then(|st| st.via_proxy_addr.as_deref()),
        Some(expected_via_proxy.as_str())
    );

    let ws_proxied = summaries
        .iter()
        .find(|s| s.path == "/ws")
        .expect("proxied WS summary");
    assert_eq!(
        ws_proxied.server_ip.as_deref(),
        Some(expected_via_ip.as_str())
    );
    assert_eq!(
        store
            .get(ws_proxied.id)
            .unwrap()
            .transfer_stats
            .as_ref()
            .and_then(|st| st.via_proxy_addr.as_deref()),
        Some(expected_via_proxy.as_str())
    );

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn ip_source_hosts_remap_preserves_host_and_remapped_target_telemetry() {
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = upstream_listener.accept().await {
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = service_fn(|req: Request<Incoming>| async move {
                    let host = req
                        .headers()
                        .get(http::header::HOST)
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

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-ip-remap-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let host_remap = Arc::new(HostRemapRegistry::new());
    host_remap
        .set_rules(vec![crate::models::HostRemapRule {
            id: "ip-remap".into(),
            enabled: true,
            source_pattern: "198.51.100.42".into(),
            target_host: "127.0.0.1".into(),
            target_port: Some(upstream_addr.port()),
            preserve_host_header: true,
            comment: "IP source remap".into(),
        }])
        .unwrap();
    let store = Arc::new(TrafficStore::new(tmp_dir.join("ip-remap.sqlite")).unwrap());
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);

    let ctx = Arc::new(SharedProxyContext {
        ca,
        rules,
        filters,
        breakpoints,
        host_remap: Arc::clone(&host_remap),
        upstream_proxy: Arc::new(UpstreamProxyManager::new()),
        throttle: Arc::new(ThrottleEngine::new()),
        store: store.clone(),
        upstream_http_client: test_upstream_http_client(Some(Arc::clone(&host_remap))),
        remote_upstream_http_client: test_remote_upstream_http_client(Some(host_remap)),
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
                let inner_c = proxy_ctx.clone();
                async move {
                    Ok::<_, Infallible>(
                        handle_outer_proxy_request(
                            req,
                            client_addr,
                            None,
                            ClientConnContext::new(),
                            inner_c,
                        )
                        .await,
                    )
                }
            });
            let _ = AutoConnBuilder::new(TokioExecutor::new())
                .serve_connection_with_upgrades(io, service)
                .await;
        }
    });

    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
        .build()
        .unwrap();
    let resp = client
        .get("http://198.51.100.42:8080/ip-remap")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.text().await.unwrap(),
        "host=198.51.100.42:8080;path=/ip-remap"
    );

    let detail = store.get(1).expect("IP remap session recorded");
    assert_eq!(
        detail.transfer_stats.as_ref().and_then(|s| s.remapped_target.as_deref()),
        Some(format!("127.0.0.1:{}", upstream_addr.port()).as_str())
    );

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn lan_client_allowlist_blocks_disallowed_lan_peers_with_403_without_recording() {
    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-lan-allowlist-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let mut cfg = crate::proxy::filters::default_backend_config();
    cfg.lan_client_allowlist = vec!["192.168.1.50".into(), "10.8.0.0/24".into()];
    filters.update_config(cfg);

    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("lan-allowlist.sqlite")).unwrap());
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
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
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            DEFAULT_UPSTREAM_TIMEOUT_SEC,
        )),
        response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
        )),
        composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
        )),
        app_handle: None,
        stats_dirty: Arc::new(AtomicBool::new(false)),
    });

    let scripted_peers: Vec<SocketAddr> = vec![
        "192.168.1.99:54321".parse().unwrap(),
        "192.168.1.99:54322".parse().unwrap(),
        "192.168.1.50:54323".parse().unwrap(),
        "127.0.0.1:54324".parse().unwrap(),
    ];
    let proxy_ctx = ctx.clone();
    tokio::spawn(async move {
        for peer_addr in scripted_peers {
            if let Ok((tcp_stream, _)) = proxy_listener.accept().await {
                let io = TokioIo::new(tcp_stream);
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(
                                    req,
                                    peer_addr,
                                    None,
                                    ClientConnContext::new(),
                                    inner_c,
                                )
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

    // 1. Disallowed LAN peer -> plain HTTP rejected with 403 without creating TrafficStore entry
    {
        let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
        sock.write_all(
            b"GET http://flux.proxy/health HTTP/1.1\r\nHost: flux.proxy\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
        let mut buf = Vec::new();
        let _ = sock.read_to_end(&mut buf).await;
        let resp = String::from_utf8_lossy(&buf);
        assert!(
            resp.starts_with("HTTP/1.1 403"),
            "expected 403 for disallowed HTTP peer, got: {resp}"
        );
        assert!(
            store.list_summaries().is_empty(),
            "disallowed HTTP request must not create TrafficStore session"
        );
    }

    // 2. Disallowed LAN peer -> CONNECT tunnel rejected with 403 without creating TrafficStore entry
    {
        let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
        sock.write_all(
            b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
        )
        .await
        .unwrap();
        let mut buf = [0u8; 512];
        let n = sock.read(&mut buf).await.unwrap();
        let resp = String::from_utf8_lossy(&buf[..n]);
        assert!(
            resp.starts_with("HTTP/1.1 403"),
            "expected 403 for disallowed CONNECT peer, got: {resp}"
        );
        assert!(
            store.list_summaries().is_empty(),
            "disallowed CONNECT request must not create TrafficStore session"
        );
    }

    // 3. Allowlisted LAN peer -> succeeds (200 OK)
    {
        let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
        sock.write_all(
            b"GET http://flux.proxy/health HTTP/1.1\r\nHost: flux.proxy\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
        let mut buf = Vec::new();
        let _ = sock.read_to_end(&mut buf).await;
        let resp = String::from_utf8_lossy(&buf);
        assert!(
            resp.starts_with("HTTP/1.1 200"),
            "expected 200 for allowlisted peer, got: {resp}"
        );
    }

    // 4. Loopback peer -> always succeeds (200 OK)
    {
        let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
        sock.write_all(
            b"GET http://flux.proxy/health HTTP/1.1\r\nHost: flux.proxy\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
        let mut buf = Vec::new();
        let _ = sock.read_to_end(&mut buf).await;
        let resp = String::from_utf8_lossy(&buf);
        assert!(
            resp.starts_with("HTTP/1.1 200"),
            "expected 200 for loopback peer, got: {resp}"
        );
    }

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn sec01_validates_resolved_ips_isolates_pools_and_blocks_remote_hosts_remap() {
    assert!(validate_resolved_addrs_for_peer(
        &["127.0.0.1:8080".parse().unwrap()],
        true,
        "evil.nip.io:8080"
    )
    .is_err());
    assert!(validate_resolved_addrs_for_peer(
        &["[::1]:8080".parse().unwrap()],
        true,
        "evil.nip.io:8080"
    )
    .is_err());
    assert!(validate_resolved_addrs_for_peer(
        &["[::ffff:127.0.0.1]:8080".parse().unwrap()],
        true,
        "evil.nip.io:8080"
    )
    .is_err());
    assert!(validate_resolved_addrs_for_peer(
        &["0.0.0.0:80".parse().unwrap()],
        true,
        "evil.zero.test:80"
    )
    .is_err());
    assert!(validate_resolved_addrs_for_peer(
        &["[::]:80".parse().unwrap()],
        true,
        "evil.zero.test:80"
    )
    .is_err());
    assert!(validate_resolved_addrs_for_peer(
        &["[::ffff:0.0.0.0]:80".parse().unwrap()],
        true,
        "evil.zero.test:80"
    )
    .is_err());
    assert!(validate_resolved_addrs_for_peer(
        &[
            "93.184.216.34:443".parse().unwrap(),
            "127.0.0.1:443".parse().unwrap(),
        ],
        true,
        "rebind.example:443"
    )
    .is_err());
    assert!(validate_resolved_addrs_for_peer(
        &["93.184.216.34:443".parse().unwrap()],
        true,
        "example.com:443"
    )
    .is_ok());
    assert!(validate_resolved_addrs_for_peer(
        &["127.0.0.1:8080".parse().unwrap()],
        false,
        "localhost:8080"
    )
    .is_ok());

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-sec01-pools-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();
    let upstream_hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let upstream_hits_srv = Arc::clone(&upstream_hits);
    tokio::spawn(async move {
        while let Ok((stream, _)) = upstream_listener.accept().await {
            upstream_hits_srv.fetch_add(1, Ordering::Relaxed);
            let io = TokioIo::new(stream);
            tokio::spawn(async move {
                let svc = service_fn(|_req: Request<Incoming>| async move {
                    Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(
                        b"loopback-only-ok",
                    ))))
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection(io, svc)
                    .await;
            });
        }
    });

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let mut cfg = crate::proxy::filters::default_backend_config();
    cfg.tls_bypass_enabled = true;
    cfg.tls_bypass_rules = vec![TlsBypassRule {
        id: "bypass-remapped".into(),
        enabled: true,
        pattern: "remapped-internal.test".into(),
        category: "Test".into(),
        description: "Passthrough test".into(),
    }];
    filters.update_config(cfg);

    let host_remap = Arc::new(HostRemapRegistry::new());
    host_remap
        .set_rules(vec![crate::models::HostRemapRule {
            id: "remap-to-loopback".into(),
            enabled: true,
            source_pattern: "remapped-internal.test".into(),
            target_host: "127.0.0.1".into(),
            target_port: Some(upstream_addr.port()),
            preserve_host_header: true,
            comment: String::new(),
        }])
        .unwrap();

    let store = Arc::new(TrafficStore::new(tmp_dir.join("sec01.sqlite")).unwrap());
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();

    let ctx = Arc::new(SharedProxyContext {
        ca,
        rules,
        filters,
        breakpoints: Arc::new(BreakpointEngine::new(None)),
        host_remap: Arc::clone(&host_remap),
        upstream_proxy: Arc::new(UpstreamProxyManager::new()),
        throttle: Arc::new(ThrottleEngine::new()),
        store,
        upstream_http_client: test_upstream_http_client(Some(Arc::clone(&host_remap))),
        remote_upstream_http_client: test_remote_upstream_http_client(Some(host_remap)),
        shared_http1_tls_config: shared_http1_tls_config().unwrap(),
        client_certs: Arc::new(ClientCertificateStore::in_memory()),
        script_runner: Arc::new(PythonScriptRunner::new(None)),
        active_ws_channels: Arc::new(DashMap::new()),
        event_tx,
        removed_tx,
        active_port: AtomicU16::new(proxy_addr.port()),
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            DEFAULT_UPSTREAM_TIMEOUT_SEC,
        )),
        response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_RESPONSE_HEADER_TIMEOUT_SEC,
        )),
        composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            crate::models::DEFAULT_COMPOSER_TIMEOUT_SEC,
        )),
        app_handle: None,
        stats_dirty: Arc::new(AtomicBool::new(false)),
    });

    let local_before = ctx.upstream_http_client_for_peer(false);
    let remote_before = ctx.upstream_http_client_for_peer(true);
    assert!(!Arc::ptr_eq(&local_before, &remote_before));
    assert!(!local_before.peer_is_remote());
    assert!(remote_before.peer_is_remote());

    ctx.rebuild_upstream_clients();
    let local_after = ctx.upstream_http_client_for_peer(false);
    let remote_after = ctx.upstream_http_client_for_peer(true);
    assert!(!Arc::ptr_eq(&local_before, &local_after));
    assert!(!Arc::ptr_eq(&remote_before, &remote_after));
    assert!(!Arc::ptr_eq(&local_after, &remote_after));
    assert!(!local_after.peer_is_remote());
    assert!(remote_after.peer_is_remote());

    let scripted_peers: Vec<SocketAddr> = vec![
        "192.168.1.50:55001".parse().unwrap(),
        "192.168.1.50:55002".parse().unwrap(),
        "127.0.0.1:55003".parse().unwrap(),
    ];
    let proxy_ctx = ctx.clone();
    tokio::spawn(async move {
        for peer_addr in scripted_peers {
            if let Ok((tcp_stream, _)) = proxy_listener.accept().await {
                let io = TokioIo::new(tcp_stream);
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(
                                    req,
                                    peer_addr,
                                    None,
                                    ClientConnContext::new(),
                                    inner_c,
                                )
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

    // Remote LAN peer -> plain HTTP via HOSTS Remapping to 127.0.0.1 must fail with 403
    {
        let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
        sock.write_all(
            b"GET http://remapped-internal.test/api HTTP/1.1\r\nHost: remapped-internal.test\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
        let mut buf = Vec::new();
        let _ = sock.read_to_end(&mut buf).await;
        let resp = String::from_utf8_lossy(&buf);
        assert!(resp.starts_with("HTTP/1.1 403"), "got: {resp}");
    }

    // Remote LAN peer -> CONNECT passthrough via HOSTS Remapping to 127.0.0.1 must fail with 403
    {
        let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
        sock.write_all(
            b"CONNECT remapped-internal.test:443 HTTP/1.1\r\nHost: remapped-internal.test:443\r\n\r\n",
        )
        .await
        .unwrap();
        let mut buf = [0u8; 512];
        let n = sock.read(&mut buf).await.unwrap();
        let resp = String::from_utf8_lossy(&buf[..n]);
        assert!(resp.starts_with("HTTP/1.1 403"), "got: {resp}");
    }
    assert_eq!(upstream_hits.load(Ordering::Relaxed), 0);

    // Local loopback peer -> plain HTTP via HOSTS Remapping succeeds with 200
    {
        let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
        sock.write_all(
            b"GET http://remapped-internal.test/api HTTP/1.1\r\nHost: remapped-internal.test\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
        let mut buf = Vec::new();
        let _ = sock.read_to_end(&mut buf).await;
        let resp = String::from_utf8_lossy(&buf);
        assert!(resp.starts_with("HTTP/1.1 200"), "got: {resp}");
        assert!(resp.contains("loopback-only-ok"), "got: {resp}");
    }
    assert_eq!(upstream_hits.load(Ordering::Relaxed), 1);

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn sec03_blocks_domain_fronting_and_h2_authority_coalescing_in_intercept_all() {
    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-sec03-intercept-all-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    filters.update_config(ProxyFilterBackendConfig {
        tls_intercept_mode: TlsInterceptMode::InterceptAll,
        tls_bypass_enabled: true,
        tls_bypass_rules: vec![TlsBypassRule {
            id: "bypass-pinned-bank".into(),
            enabled: true,
            pattern: "pinned-bank.test".into(),
            category: "Banking".into(),
            description: "Bypass pinned-bank.test".into(),
        }],
        tls_target_rules: Vec::new(),
        ..crate::proxy::filters::default_backend_config()
    });

    let store = Arc::new(TrafficStore::new(tmp_dir.join("sec03_ia.sqlite")).unwrap());
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();

    let ctx = Arc::new(SharedProxyContext {
        ca: ca.clone(),
        rules,
        filters,
        breakpoints: Arc::new(BreakpointEngine::new(None)),
        host_remap: Arc::new(HostRemapRegistry::new()),
        upstream_proxy: Arc::new(UpstreamProxyManager::new()),
        throttle: Arc::new(ThrottleEngine::new()),
        store,
        upstream_http_client: test_upstream_http_client(None),
        remote_upstream_http_client: test_remote_upstream_http_client(None),
        shared_http1_tls_config: shared_http1_tls_config().unwrap(),
        client_certs: Arc::new(ClientCertificateStore::in_memory()),
        script_runner: Arc::new(PythonScriptRunner::new(None)),
        active_ws_channels: Arc::new(DashMap::new()),
        event_tx,
        removed_tx,
        active_port: AtomicU16::new(proxy_addr.port()),
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(
            DEFAULT_UPSTREAM_TIMEOUT_SEC,
        )),
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
        for _ in 0..2 {
            if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let io = TokioIo::new(tcp_stream);
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req: Request<Incoming>| {
                        let inner_c = c.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_outer_proxy_request(
                                    req,
                                    client_addr,
                                    None,
                                    ClientConnContext::new(),
                                    inner_c,
                                )
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

    let mut root_store = rustls::RootCertStore::empty();
    root_store
        .add(rustls::pki_types::CertificateDer::from(
            ca.root_ca_der().to_vec(),
        ))
        .unwrap();

    // 1. HTTP/1.1 Host mismatch to bypassed domain inside InterceptAll CONNECT tunnel -> 421 Misdirected Request
    {
        let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
        sock.write_all(b"CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n")
            .await
            .unwrap();
        let mut connect_buf = [0u8; 256];
        let n = sock.read(&mut connect_buf).await.unwrap();
        assert!(String::from_utf8_lossy(&connect_buf[..n]).starts_with("HTTP/1.1 200"));

        let tls_cfg = Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(root_store.clone())
                .with_no_client_auth(),
        );
        let connector = tokio_rustls::TlsConnector::from(tls_cfg);
        let server_name = rustls::pki_types::ServerName::try_from("allowed.test").unwrap();
        let mut tls_stream = connector.connect(server_name, sock).await.unwrap();

        tls_stream
            .write_all(
                b"GET /secret HTTP/1.1\r\nHost: pinned-bank.test\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        let mut resp_bytes = Vec::new();
        let _ = tls_stream.read_to_end(&mut resp_bytes).await;
        let inner_resp = String::from_utf8_lossy(&resp_bytes);
        assert!(
            inner_resp.starts_with("HTTP/1.1 421"),
            "expected 421 Misdirected Request for HTTP/1.1 Host mismatch in InterceptAll, got: {inner_resp}"
        );
    }

    // 2. HTTP/2 :authority mismatch to bypassed domain inside InterceptAll CONNECT tunnel -> 421 Misdirected Request
    {
        let mut sock = TcpStream::connect(proxy_addr).await.unwrap();
        sock.write_all(b"CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n")
            .await
            .unwrap();
        let mut connect_buf = [0u8; 256];
        let n = sock.read(&mut connect_buf).await.unwrap();
        assert!(String::from_utf8_lossy(&connect_buf[..n]).starts_with("HTTP/1.1 200"));

        let mut tls_cfg = rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();
        tls_cfg.alpn_protocols = vec![b"h2".to_vec()];
        let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_cfg));
        let server_name = rustls::pki_types::ServerName::try_from("allowed.test").unwrap();
        let tls_stream = connector.connect(server_name, sock).await.unwrap();

        let (mut sender, conn) = hyper::client::conn::http2::Builder::new(TokioExecutor::new())
            .handshake::<_, http_body_util::Empty<Bytes>>(TokioIo::new(tls_stream))
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });

        let h2_req = Request::builder()
            .method(hyper::Method::GET)
            .uri("https://pinned-bank.test/secret")
            .body(http_body_util::Empty::<Bytes>::new())
            .unwrap();
        let h2_resp = sender.send_request(h2_req).await.unwrap();
        assert_eq!(
            h2_resp.status(),
            StatusCode::MISDIRECTED_REQUEST,
            "expected 421 Misdirected Request for HTTP/2 :authority mismatch in InterceptAll"
        );
    }

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

