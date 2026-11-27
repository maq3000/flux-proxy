use super::*;

#[tokio::test]
async fn captures_cold_vs_reused_upstream_connection_timings_and_transfer_stats() {
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();

    tokio::spawn(async move {
        let (mut sock, _) = upstream_listener.accept().await.unwrap();
        let mut buf = [0u8; 4096];
        // Request 1 on keep-alive connection
        let _ = sock.read(&mut buf).await;
        let _ = sock
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: keep-alive\r\n\r\nfirst")
            .await;
        let _ = sock.flush().await;
        // Request 2 reused on same upstream TCP socket
        let _ = sock.read(&mut buf).await;
        tokio::time::sleep(Duration::from_millis(8)).await;
        let _ = sock
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 6\r\nConnection: keep-alive\r\n\r\nsecond")
            .await;
        let _ = sock.flush().await;
        let _ = sock.read(&mut buf).await;
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-pool-timings-{}",
        std::process::id()
    ));
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("pool.sqlite")).unwrap());
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

    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();
    let proxy_ctx = ctx.clone();

    tokio::spawn(async move {
        loop {
            let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                break;
            };
            let c = proxy_ctx.clone();
            let conn_ctx = ClientConnContext::new();
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_ctx = c.clone();
                    let req_conn = conn_ctx.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(req, client_addr, None, req_conn, inner_ctx)
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

    let r1 = client
        .get(format!("http://127.0.0.1:{}/one", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(r1.text().await.unwrap(), "first");

    let r2 = client
        .get(format!("http://127.0.0.1:{}/two", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(r2.text().await.unwrap(), "second");

    tokio::time::sleep(Duration::from_millis(40)).await;

    let d1 = store.get(1).expect("first session stored");
    let d2 = store.get(2).expect("second session stored");

    let t1 = d1.timings.as_ref().expect("session 1 timings");
    let s1 = d1.transfer_stats.as_ref().expect("session 1 stats");
    assert_eq!(s1.server_conn_reused, Some(false));
    assert_eq!(s1.server_ip.as_deref(), Some("127.0.0.1"));
    assert!(s1.server_conn_id.is_some());
    assert!(t1.tcp_connect_ms.is_some());
    assert!(t1.server_wait_ms.is_some());
    assert_eq!(s1.response_body_bytes, Some(5));
    assert_eq!(s1.response_wire_body_bytes, Some(5));
    assert!(s1.request_headers_bytes.is_some());
    assert!(s1.response_headers_bytes.is_some());

    let t2 = d2.timings.as_ref().expect("session 2 timings");
    let s2 = d2.transfer_stats.as_ref().expect("session 2 stats");
    assert_eq!(s2.server_conn_reused, Some(true));
    assert_eq!(s2.server_conn_id, s1.server_conn_id);
    assert_eq!(t2.dns_ms, Some(0.0));
    assert_eq!(t2.tcp_connect_ms, Some(0.0));
    assert_eq!(d2.summary.server_conn_reused, Some(true));
    assert!(d2.summary.ttfb_ms.is_some());
    assert!(t2.server_wait_ms.unwrap_or(0.0) >= 5.0);

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn captures_gzip_and_zstd_wire_vs_decoded_bytes() {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write as _;

    let plain_json = serde_json::json!({
        "items": vec!["fluxproxy-compression-benchmark-payload-item"; 24],
        "ok": true
    })
    .to_string();
    let plain_bytes = plain_json.as_bytes().to_vec();

    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(&plain_bytes).unwrap();
    let gz_bytes = gz.finish().unwrap();
    let zstd_bytes = zstd::encode_all(plain_bytes.as_slice(), 3).unwrap();
    assert!(gz_bytes.len() < plain_bytes.len());
    assert!(zstd_bytes.len() < plain_bytes.len());

    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();
    let gz_clone = gz_bytes.clone();
    let zstd_clone = zstd_bytes.clone();

    tokio::spawn(async move {
        for (enc, body) in [("gzip", gz_clone), ("zstd", zstd_clone)] {
            let (mut sock, _) = upstream_listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: {enc}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(&body).await;
            let _ = sock.shutdown().await;
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-wire-compression-{}",
        std::process::id()
    ));
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let store = Arc::new(TrafficStore::new(tmp_dir.join("comp.sqlite")).unwrap());
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
    let ctx = Arc::new(SharedProxyContext {
        ca,
        rules: Arc::new(RuleEngine::new()),
        filters: Arc::new(ProxyFilterEngine::new()),
        breakpoints: Arc::new(BreakpointEngine::new(None)),
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
        loop {
            let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                break;
            };
            let c = proxy_ctx.clone();
            let conn_ctx = ClientConnContext::new();
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_ctx = c.clone();
                    let req_conn = conn_ctx.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(req, client_addr, None, req_conn, inner_ctx)
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

    let r_gz = client
        .get(format!("http://127.0.0.1:{}/gz", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(r_gz.status(), StatusCode::OK);
    let _ = r_gz.bytes().await.unwrap();

    let r_zstd = client
        .get(format!("http://127.0.0.1:{}/zstd", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(r_zstd.status(), StatusCode::OK);
    let _ = r_zstd.bytes().await.unwrap();

    tokio::time::sleep(Duration::from_millis(40)).await;

    let d_gz = store.get(1).expect("gzip session stored");
    let st_gz = d_gz.transfer_stats.as_ref().expect("gzip stats");
    assert_eq!(st_gz.response_content_encoding.as_deref(), Some("gzip"));
    assert_eq!(st_gz.response_wire_body_bytes, Some(gz_bytes.len()));
    assert_eq!(st_gz.response_body_bytes, Some(plain_bytes.len()));
    assert!(st_gz.response_wire_body_bytes.unwrap() < st_gz.response_body_bytes.unwrap());
    assert_eq!(d_gz.summary.wire_body_size, Some(gz_bytes.len()));
    assert_eq!(d_gz.response_body_text.as_deref(), Some(plain_json.as_str()));

    let d_zstd = store.get(2).expect("zstd session stored");
    let st_zstd = d_zstd.transfer_stats.as_ref().expect("zstd stats");
    assert_eq!(st_zstd.response_content_encoding.as_deref(), Some("zstd"));
    assert_eq!(st_zstd.response_wire_body_bytes, Some(zstd_bytes.len()));
    assert_eq!(st_zstd.response_body_bytes, Some(plain_bytes.len()));
    assert!(st_zstd.response_wire_body_bytes.unwrap() < st_zstd.response_body_bytes.unwrap());
    assert_eq!(d_zstd.summary.wire_body_size, Some(zstd_bytes.len()));
    assert_eq!(d_zstd.response_body_text.as_deref(), Some(plain_json.as_str()));

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn captures_autoresponder_delay_and_breakpoint_pause_timings() {
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = upstream_listener.accept().await {
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await;
            let _ = sock.shutdown().await;
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-bp-mock-timings-{}",
        std::process::id()
    ));
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let store = Arc::new(TrafficStore::new(tmp_dir.join("bpmock.sqlite")).unwrap());
    let (bp_tx, mut bp_rx) = breakpoint_snapshot_channel();
    let breakpoints = Arc::new(BreakpointEngine::new_with_store(
        Some(bp_tx),
        Some(Arc::clone(&store)),
    ));
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);

    rules.upsert_rule(crate::models::AutoResponderRule {
        id: "mock-delayed".into(),
        enabled: true,
        name: "Delayed Mock".into(),
        match_target: crate::models::RuleMatchTarget::UrlContains,
        pattern: "/mock-delay".into(),
        method_filter: None,
        header_name: None,
        action: RuleActionType::MockResponse,
        status_code: 200,
        latency_ms: 40,
        response_headers: vec![HeaderPair::new("Content-Type", "application/json")],
        response_body: "{\"mock\":true}".into(),
    });

    let ctx = Arc::new(SharedProxyContext {
        ca,
        rules: rules.clone(),
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
        loop {
            let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await else {
                break;
            };
            let c = proxy_ctx.clone();
            let conn_ctx = ClientConnContext::new();
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let inner_ctx = c.clone();
                    let req_conn = conn_ctx.clone();
                    async move {
                        Ok::<_, Infallible>(
                            handle_outer_proxy_request(req, client_addr, None, req_conn, inner_ctx)
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

    // 1. AutoResponder delayed mock
    let mock_resp = client
        .get(format!("http://127.0.0.1:{}/mock-delay", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(mock_resp.text().await.unwrap(), "{\"mock\":true}");

    tokio::time::sleep(Duration::from_millis(25)).await;
    let mock_detail = store.get(1).expect("mock session stored");
    assert!(mock_detail.summary.is_mocked);
    let mock_timings = mock_detail.timings.as_ref().expect("mock timings");
    assert!(
        mock_timings.autoresponder_delay_ms.unwrap_or(0.0) >= 20.0,
        "expected autoresponder_delay_ms >= 20, got {:?}",
        mock_timings.autoresponder_delay_ms
    );

    // 2. Live request breakpoint pause
    breakpoints.update_config(BreakpointConfig {
        break_before_request: true,
        break_after_response: false,
        timeout_secs: 60,
        rules: Vec::new(),
    });

    let bp_clone = breakpoints.clone();
    tokio::spawn(async move {
        if let Some(items) = bp_rx.recv().await {
            if let Some(first) = items.first() {
                tokio::time::sleep(Duration::from_millis(45)).await;
                bp_clone.resolve(BreakpointResolution {
                    breakpoint_id: first.breakpoint_id.clone(),
                    action: BreakpointAction::Continue,
                    method: None,
                    url: None,
                    request_headers: None,
                    request_body_base64: None,
                    request_body_text: None,
                    status_code: None,
                    response_headers: None,
                    response_body_base64: None,
                    response_body_text: None,
                });
            }
        }
    });

    let bp_resp = client
        .get(format!("http://127.0.0.1:{}/pause-bp", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(bp_resp.text().await.unwrap(), "ok");

    tokio::time::sleep(Duration::from_millis(25)).await;
    let bp_detail = store.get(2).expect("breakpoint session stored");
    let bp_timings = bp_detail.timings.as_ref().expect("bp timings");
    let pause_ms = bp_timings.breakpoint_pause_ms.unwrap_or(0.0);
    assert!(
        pause_ms >= 20.0,
        "expected breakpoint_pause_ms >= 20, got {:?}",
        pause_ms
    );
    assert!(
        bp_timings.net_elapsed_ms.unwrap_or(f64::MAX)
            < bp_timings.overall_elapsed_ms.unwrap_or(0.0),
        "net_elapsed_ms ({:?}) should exclude breakpoint pause from overall_elapsed_ms ({:?})",
        bp_timings.net_elapsed_ms,
        bp_timings.overall_elapsed_ms
    );

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn stage39_slow_upstream_500_transparent_at_unlimited_and_504_at_finite_ttfb() {
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();

    tokio::spawn(async move {
        while let Ok((stream, _)) = upstream_listener.accept().await {
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = service_fn(|req: Request<Incoming>| async move {
                    let delay_ms = if req.uri().path().contains("very-slow") {
                        1500
                    } else {
                        350
                    };
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    let resp = Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .body(Full::new(Bytes::from("backend-real-500")))
                        .unwrap();
                    Ok::<_, Infallible>(resp)
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection(io, svc)
                    .await;
            });
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-stage39-ttfb-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("ttfb.sqlite")).unwrap());
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
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(5)),
        response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(120)),
        app_handle: None,
        stats_dirty: Arc::new(AtomicBool::new(false)),
    });

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
        .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
        .build()
        .unwrap();

    // 1. Unlimited TTFB (0) waits and forwards authentic backend 500
    let ok_slow = client
        .get(format!("http://{upstream_addr}/slow-500"))
        .send()
        .await
        .unwrap();
    assert_eq!(ok_slow.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(ok_slow.headers().get("x-fluxproxy-error").is_none());
    assert_eq!(ok_slow.text().await.unwrap(), "backend-real-500");

    // 2. Finite TTFB (1s) returns synthetic 504 + X-FluxProxy-Error: upstream-response-timeout
    ctx.response_header_timeout_sec.store(1, Ordering::Relaxed);
    let timed_out = client
        .get(format!("http://{upstream_addr}/very-slow"))
        .send()
        .await
        .unwrap();
    assert_eq!(timed_out.status(), StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(
        timed_out
            .headers()
            .get("x-fluxproxy-error")
            .and_then(|v| v.to_str().ok()),
        Some("upstream-response-timeout")
    );

    let recorded_timeout = store.get(2).expect("timeout session recorded");
    assert_eq!(recorded_timeout.summary.status, 504);
    assert!(recorded_timeout.response_headers.iter().any(|h| {
        h.name.eq_ignore_ascii_case("x-fluxproxy-error")
            && h.value == "upstream-response-timeout"
    }));

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn stage39_in_flight_session_guard_finalizes_499_on_client_disconnect() {
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();
    let release = Arc::new(tokio::sync::Notify::new());
    let release_srv = Arc::clone(&release);

    tokio::spawn(async move {
        if let Ok((_stream, _)) = upstream_listener.accept().await {
            release_srv.notified().await;
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-stage39-499-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("499.sqlite")).unwrap());
    let (event_tx, mut event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
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
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(5)),
        response_header_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        composer_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(120)),
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

    let mut client_tcp = TcpStream::connect(proxy_addr).await.unwrap();
    let raw_req = format!(
        "GET http://{upstream_addr}/hang HTTP/1.1\r\nHost: {upstream_addr}\r\nConnection: close\r\n\r\n"
    );
    client_tcp.write_all(raw_req.as_bytes()).await.unwrap();

    let in_flight = tokio::time::timeout(Duration::from_secs(3), event_rx.recv())
        .await
        .expect("should emit in-flight session")
        .unwrap();
    assert_eq!(in_flight.status, 0);

    // Client aborts TCP connection while proxy is awaiting slow/hanging upstream
    drop(client_tcp);

    let closed_evt = tokio::time::timeout(Duration::from_secs(3), event_rx.recv())
        .await
        .expect("InFlightSessionGuard should emit 499 update on drop")
        .unwrap();
    assert_eq!(closed_evt.status, 499);
    assert!(closed_evt
        .error
        .as_deref()
        .unwrap_or("")
        .contains("Client closed connection"));

    let stored = store.get(in_flight.id).unwrap();
    assert_eq!(stored.summary.status, 499);
    assert!(stored.response_headers.iter().any(|h| {
        h.name.eq_ignore_ascii_case("x-fluxproxy-error") && h.value == "client-closed-request"
    }));

    release.notify_one();
    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn stage39_connect_timeout_bounds_stalled_connect_tunnel_and_persists_prefs() {
    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-stage39-connect-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let store = Arc::new(TrafficStore::new(tmp_dir.join("connect.sqlite")).unwrap());
    let sysproxy = Arc::new(SystemProxyManager::new(&tmp_dir));
    let client_certs = Arc::new(ClientCertificateStore::in_memory());
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
    let (bp_tx, _bp_rx) = breakpoint_snapshot_channel();

    let controller = ProxyEngineController::new_with_channels(
        ca,
        rules,
        filters,
        store.clone(),
        sysproxy.clone(),
        client_certs,
        event_tx,
        removed_tx,
        bp_tx,
        None,
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();

    // 1. Default prefs & persistence check
    assert_eq!(
        controller.get_upstream_timeouts(),
        crate::models::UpstreamTimeoutConfig::default()
    );
    assert!(controller
        .set_upstream_timeouts(crate::models::UpstreamTimeoutConfig {
            connect_timeout_sec: 1,
            response_header_timeout_sec: 3,
            composer_timeout_sec: 60,
        })
        .is_err());

    let saved = controller
        .set_upstream_timeouts(crate::models::UpstreamTimeoutConfig {
            connect_timeout_sec: 1,
            response_header_timeout_sec: 0,
            composer_timeout_sec: 45,
        })
        .unwrap();
    assert_eq!(saved.connect_timeout_sec, 1);
    assert_eq!(saved.response_header_timeout_sec, 0);
    assert_eq!(saved.composer_timeout_sec, 45);
    assert_eq!(sysproxy.load_upstream_timeouts_pref(), saved);

    // 2. Stalled upstream proxy CONNECT tunnel times out according to connectTimeoutSec=1
    let stalled_proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let stalled_proxy_addr = stalled_proxy_listener.local_addr().unwrap();
    tokio::spawn(async move {
        if let Ok((_sock, _)) = stalled_proxy_listener.accept().await {
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });

    controller
        .context
        .upstream_proxy
        .set_config(crate::models::UpstreamProxyConfig {
            enabled: true,
            protocol: crate::models::UpstreamProxyProtocol::Http,
            host: stalled_proxy_addr.ip().to_string(),
            port: stalled_proxy_addr.port(),
            username: None,
            password: None,
            has_password: false,
            bypass_list: Vec::new(),
        })
        .unwrap();

    // Bypass MITM on this domain so CONNECT tunnel passthrough executes
    let mut fcfg = controller.context.filters.get_config();
    fcfg.tls_bypass_enabled = true;
    fcfg.tls_bypass_rules.push(crate::models::TlsBypassRule {
        id: "stalled-connect".into(),
        enabled: true,
        pattern: "stalled-connect.example".into(),
        category: "custom".into(),
        description: "Stage 39 connect timeout test".into(),
    });
    controller.context.filters.update_config(fcfg);

    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();
    let proxy_ctx = Arc::clone(&controller.context);
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

    let started = Instant::now();
    let mut client_tcp = TcpStream::connect(proxy_addr).await.unwrap();
    client_tcp
        .write_all(b"CONNECT stalled-connect.example:443 HTTP/1.1\r\nHost: stalled-connect.example:443\r\n\r\n")
        .await
        .unwrap();
    let mut buf = vec![0u8; 2048];
    let n = tokio::time::timeout(Duration::from_secs(4), client_tcp.read(&mut buf))
        .await
        .expect("CONNECT tunnel timeout should fire cleanly near 1s")
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(4));
    let resp_str = String::from_utf8_lossy(&buf[..n]);
    assert!(resp_str.starts_with("HTTP/1.1 502"));
    assert!(resp_str.to_ascii_lowercase().contains("x-fluxproxy-error: upstream-connect-timeout"));

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn bug01_preserves_raw_utf8_and_obs_text_headers_end_to_end_and_on_edit() {
    let raw_utf8 = b"attachment; filename=\"\xd0\xbe\xd1\x82\xd1\x87\xd0\xb5\xd1\x82.pdf\"";
    let raw_obs = b"val\xff!";
    let mut hmap = http::HeaderMap::new();
    hmap.insert(
        http::HeaderName::from_static("content-disposition"),
        http::HeaderValue::from_bytes(raw_utf8).unwrap(),
    );
    hmap.insert(
        http::HeaderName::from_static("x-raw-obs"),
        http::HeaderValue::from_bytes(raw_obs).unwrap(),
    );

    let extracted = extract_hyper_headers(&hmap);
    let cd = extracted
        .iter()
        .find(|h| h.name == "content-disposition")
        .unwrap();
    assert!(cd.raw_bytes_b64.is_some());
    assert_eq!(cd.to_hyper_header_value().unwrap().as_bytes(), raw_utf8);

    let obs = extracted.iter().find(|h| h.name == "x-raw-obs").unwrap();
    assert!(obs.raw_bytes_b64.is_some());
    assert_eq!(obs.to_hyper_header_value().unwrap().as_bytes(), raw_obs);

    let mut edited = obs.clone();
    edited.value = "edited-ascii".into();
    assert_eq!(
        edited.to_hyper_header_value().unwrap().as_bytes(),
        b"edited-ascii"
    );

    // End-to-end raw TCP proxy verification
    let upstream_seen_req = Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    let upstream_seen_srv = Arc::clone(&upstream_seen_req);
    let up_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up_addr = up_listener.local_addr().unwrap();
    tokio::spawn(async move {
        if let Ok((mut sock, _)) = up_listener.accept().await {
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = sock.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&chunk[..n]);
            }
            *upstream_seen_srv.lock().unwrap() = raw;
            let mut resp = Vec::new();
            resp.extend_from_slice(b"HTTP/1.1 200 OK\r\nContent-Disposition: ");
            resp.extend_from_slice(b"attachment; filename=\"\xd0\xbe\xd1\x82\xd1\x87\xd0\xb5\xd1\x82.pdf\"");
            resp.extend_from_slice(b"\r\nX-Raw-Obs: ");
            resp.extend_from_slice(b"val\xff!");
            resp.extend_from_slice(b"\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
            sock.write_all(&resp).await.unwrap();
        }
    });

    let (controller, _rules, _filters, store, tmp_dir) = make_stage44_controller("bug01");
    let status = controller.start("127.0.0.1".into(), 0).await.unwrap();

    let mut client = TcpStream::connect(("127.0.0.1", status.port))
        .await
        .unwrap();
    let client_raw_hdr = b"\xd0\xbf\xd1\x80\xd0\xb8";
    let mut req_wire = format!(
        "GET http://{up_addr}/raw-hdr HTTP/1.1\r\nHost: {up_addr}\r\nX-Client-Raw: "
    )
    .into_bytes();
    req_wire.extend_from_slice(client_raw_hdr);
    req_wire.extend_from_slice(b"\r\nConnection: close\r\n\r\n");
    client.write_all(&req_wire).await.unwrap();

    let (resp_head, resp_body) = read_raw_http_head_and_body(&mut client).await;
    assert_eq!(resp_body, b"ok");
    assert!(resp_head.windows(raw_utf8.len()).any(|w| w == raw_utf8));
    assert!(resp_head.windows(raw_obs.len()).any(|w| w == raw_obs));

    let upstream_wire = upstream_seen_req.lock().unwrap().clone();
    assert!(
        upstream_wire
            .windows(client_raw_hdr.len())
            .any(|w| w == client_raw_hdr),
        "upstream did not receive raw non-ASCII client header"
    );

    let sessions = store.list_summaries();
    let detail = store.get(sessions[0].id).unwrap();
    assert!(detail
        .response_headers
        .iter()
        .any(|h| h.name.eq_ignore_ascii_case("x-raw-obs") && h.raw_bytes_b64.is_some()));

    controller.stop().await;
    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn bug02_autoresponder_mock_strips_stale_headers_and_sets_exact_cl() {
    use crate::models::{AutoResponderRule, RuleMatchTarget};

    let (controller, rules, _filters, _store, tmp_dir) = make_stage44_controller("bug02");
    rules.set_rules(vec![AutoResponderRule {
        id: "mock-clean".into(),
        enabled: true,
        name: "Mock Clean".into(),
        match_target: RuleMatchTarget::UrlContains,
        pattern: "/mock-cl".into(),
        method_filter: None,
        header_name: None,
        action: RuleActionType::MockResponse,
        status_code: 200,
        latency_ms: 0,
        response_headers: vec![
            HeaderPair::new("Content-Type", "application/json"),
            HeaderPair::new("Content-Length", "99999"),
            HeaderPair::new("Content-Encoding", "gzip"),
            HeaderPair::new("Transfer-Encoding", "chunked"),
            HeaderPair::new("Connection", "keep-alive"),
            HeaderPair::new("Keep-Alive", "timeout=9"),
            HeaderPair::new("Proxy-Connection", "keep-alive"),
        ],
        response_body: "{\"ok\":1}".into(),
    }]);
    let status = controller.start("127.0.0.1".into(), 0).await.unwrap();

    let mut client = TcpStream::connect(("127.0.0.1", status.port))
        .await
        .unwrap();
    client
        .write_all(b"GET http://mock.example/mock-cl HTTP/1.1\r\nHost: mock.example\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let (head, body) = read_raw_http_head_and_body(&mut client).await;
    assert_eq!(body, br#"{"ok":1}"#);
    let head_lower = String::from_utf8_lossy(&head).to_ascii_lowercase();
    assert!(head_lower.contains("content-length: 8"), "head={head_lower}");
    assert!(!head_lower.contains("content-encoding"), "head={head_lower}");
    assert!(!head_lower.contains("transfer-encoding"), "head={head_lower}");
    assert!(!head_lower.contains("proxy-connection"), "head={head_lower}");
    assert!(!head_lower.contains("keep-alive:"), "head={head_lower}");

    let comp = controller
        .execute_composed(ComposedRequest {
            method: "GET".into(),
            url: "http://mock.example/mock-cl".into(),
            headers: vec![],
            body: String::new(),
            body_base64: None,
            follow_redirects: false,
            skip_python_scripts: Some(true),
            request_id: None,
            timeout_sec: None,
        })
        .await
        .unwrap();
    assert!(comp
        .response_headers
        .iter()
        .any(|h| h.name.eq_ignore_ascii_case("content-length") && h.value == "8"));
    assert!(!comp.response_headers.iter().any(|h| {
        h.name.eq_ignore_ascii_case("content-encoding")
            || h.name.eq_ignore_ascii_case("transfer-encoding")
            || h.name.eq_ignore_ascii_case("proxy-connection")
    }));

    controller.stop().await;
    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn bug03_custom_host_header_after_mutation_bpu_and_ws_reaches_upstream() {
    use crate::models::{
        BreakpointRule, HeaderMutationDirection, HeaderMutationOp, HeaderMutationRule,
    };

    let recorded_http_hosts = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let recorded_ws_hosts = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let http_hosts_srv = Arc::clone(&recorded_http_hosts);
    let ws_hosts_srv = Arc::clone(&recorded_ws_hosts);

    let up_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up_addr = up_listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = up_listener.accept().await {
            let http_hosts = Arc::clone(&http_hosts_srv);
            let ws_hosts = Arc::clone(&ws_hosts_srv);
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = service_fn(move |req: Request<Incoming>| {
                    let http_hosts = Arc::clone(&http_hosts);
                    let ws_hosts = Arc::clone(&ws_hosts);
                    async move {
                        let host_val = req
                            .headers()
                            .get(http::header::HOST)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        let is_ws = req
                            .headers()
                            .get(http::header::UPGRADE)
                            .and_then(|v| v.to_str().ok())
                            .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
                        if is_ws {
                            ws_hosts.lock().unwrap().push(host_val);
                            let key = req
                                .headers()
                                .get("sec-websocket-key")
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("");
                            let accept =
                                tokio_tungstenite::tungstenite::handshake::derive_accept_key(
                                    key.as_bytes(),
                                );
                            tokio::spawn(async move {
                                if let Ok(up) = hyper::upgrade::on(req).await {
                                    let mut ws = WebSocketStream::from_raw_socket(
                                        TokioIo::new(up),
                                        Role::Server,
                                        None,
                                    )
                                    .await;
                                    let _ = ws.close(None).await;
                                }
                            });
                            return Ok::<_, Infallible>(
                                Response::builder()
                                    .status(StatusCode::SWITCHING_PROTOCOLS)
                                    .header(http::header::CONNECTION, "Upgrade")
                                    .header(http::header::UPGRADE, "websocket")
                                    .header("Sec-WebSocket-Accept", accept)
                                    .body(Full::new(Bytes::new()))
                                    .unwrap(),
                            );
                        }
                        http_hosts.lock().unwrap().push(host_val);
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"ok"))))
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, svc)
                    .await;
            });
        }
    });

    let (controller, _rules, filters, _store, tmp_dir) = make_stage44_controller("bug03");
    filters.update_config(ProxyFilterBackendConfig {
        header_mutations_enabled: true,
        header_mutations: vec![
            HeaderMutationRule {
                id: "mut-http-host".into(),
                enabled: true,
                name: "Mutate HTTP Host".into(),
                direction: HeaderMutationDirection::Request,
                operation: HeaderMutationOp::Set,
                header_name: "Host".into(),
                header_value: "mutated-http.example".into(),
                url_pattern: "/mut-host".into(),
            },
            HeaderMutationRule {
                id: "mut-ws-host".into(),
                enabled: true,
                name: "Mutate WS Host".into(),
                direction: HeaderMutationDirection::Request,
                operation: HeaderMutationOp::Set,
                header_name: "Host".into(),
                header_value: "ws-mutated.example".into(),
                url_pattern: "/ws-host".into(),
            },
        ],
        ..crate::proxy::filters::default_backend_config()
    });
    let status = controller.start("127.0.0.1".into(), 0).await.unwrap();

    // 1. Header Mutation custom Host
    let mut c1 = TcpStream::connect(("127.0.0.1", status.port))
        .await
        .unwrap();
    c1.write_all(
        format!("GET http://{up_addr}/mut-host HTTP/1.1\r\nHost: {up_addr}\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .await
    .unwrap();
    let _ = read_raw_http_head_and_body(&mut c1).await;

    // 2. Breakpoint (bpu) custom Host
    controller.context.breakpoints.update_config(BreakpointConfig {
        break_before_request: false,
        break_after_response: false,
        timeout_secs: 5,
        rules: vec![BreakpointRule {
            id: "bp-host".into(),
            enabled: true,
            name: "BPU Host".into(),
            stage: BreakpointStage::Request,
            url_pattern: "/bpu-host".into(),
            method_filter: None,
        }],
    });
    let bp_ctx = controller.context.clone();
    let bp_task = tokio::spawn(async move {
        for _ in 0..100 {
            let paused = bp_ctx.breakpoints.list_paused();
            if let Some(item) = paused.into_iter().next() {
                let resolved = bp_ctx.breakpoints.resolve(BreakpointResolution {
                    breakpoint_id: item.breakpoint_id,
                    action: BreakpointAction::Continue,
                    method: None,
                    url: None,
                    request_headers: Some(vec![HeaderPair::new("Host", "bpu-host.example")]),
                    request_body_base64: None,
                    request_body_text: None,
                    status_code: None,
                    response_headers: None,
                    response_body_base64: None,
                    response_body_text: None,
                });
                assert!(resolved);
                return;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        panic!("breakpoint never paused");
    });
    let mut c2 = TcpStream::connect(("127.0.0.1", status.port))
        .await
        .unwrap();
    c2.write_all(
        format!("GET http://{up_addr}/bpu-host HTTP/1.1\r\nHost: {up_addr}\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .await
    .unwrap();
    let _ = read_raw_http_head_and_body(&mut c2).await;
    bp_task.await.unwrap();

    // 3. WebSocket custom Host
    let _ws = open_proxied_ws(status.port, &format!("ws://{up_addr}/ws-host")).await;

    assert_eq!(
        recorded_http_hosts.lock().unwrap().as_slice(),
        &[
            "mutated-http.example".to_string(),
            "bpu-host.example".to_string()
        ]
    );
    assert_eq!(
        recorded_ws_hosts.lock().unwrap().as_slice(),
        &["ws-mutated.example".to_string()]
    );

    controller.stop().await;
    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn bug04_empty_post_put_patch_emits_explicit_content_length_zero() {
    let raw_heads = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let heads_srv = Arc::clone(&raw_heads);
    let up_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up_addr = up_listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = up_listener.accept().await {
            let heads = Arc::clone(&heads_srv);
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 2048];
                while let Ok(n) = sock.read(&mut tmp).await {
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head_str = String::from_utf8_lossy(&buf[..pos + 4]).to_string();
                        heads.lock().unwrap().push(head_str);
                        let _ = sock
                            .write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                            )
                            .await;
                        break;
                    }
                }
            });
        }
    });

    let (controller, _rules, _filters, _store, tmp_dir) = make_stage44_controller("bug04");
    let status = controller.start("127.0.0.1".into(), 0).await.unwrap();

    for method in ["POST", "PUT", "PATCH"] {
        let mut client = TcpStream::connect(("127.0.0.1", status.port))
            .await
            .unwrap();
        client
            .write_all(
                format!(
                    "{method} http://{up_addr}/empty HTTP/1.1\r\nHost: {up_addr}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let (_h, body) = read_raw_http_head_and_body(&mut client).await;
        assert_eq!(body, b"ok");
    }

    {
        let captured = raw_heads.lock().unwrap();
        assert_eq!(captured.len(), 3);
        for head in captured.iter() {
            let lower = head.to_ascii_lowercase();
            assert!(
                lower.contains("\r\ncontent-length: 0\r\n"),
                "missing explicit Content-Length: 0 in raw request head:\n{head}"
            );
            assert!(
                !lower.contains("transfer-encoding: chunked"),
                "unexpected Transfer-Encoding: chunked in:\n{head}"
            );
        }
    }

    controller.stop().await;
    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn bug05_sse_sink_reset_4b_gzip_preview_and_4c_chunked_spill() {
    use std::io::Write;

    // 4a. BoundedSseSink resets total_written inside take_bytes()
    let mut sink = BoundedSseSink::new(1024);
    sink.write_all(&vec![b'a'; 900]).unwrap();
    assert_eq!(sink.take_bytes().len(), 900);
    sink.write_all(&vec![b'b'; 900]).unwrap();
    assert_eq!(sink.take_bytes().len(), 900);
    assert!(sink.write_all(&vec![b'c'; 1025]).is_err());

    // Prepare >2 MiB valid gzip JSON payload (compressible 4KiB prefix + incompressible ASCII tail)
    let mut plain_payload = Vec::with_capacity(4_020_000);
    plain_payload.extend_from_slice(br#"{"preview":"fluxproxy-gzip-ok","pad":"#);
    plain_payload.extend(std::iter::repeat_n(b'A', 4096));
    plain_payload.extend_from_slice(br#"","noise":""#);
    let mut rng: u64 = 0x1234_5678_9abc_def0;
    for _ in 0..4_000_000 {
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
        let ch = b'a' + ((rng >> 32) as u8 % 26);
        plain_payload.push(ch);
    }
    plain_payload.extend_from_slice(br#""}"#);

    let mut gz_encoder =
        flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz_encoder.write_all(&plain_payload).unwrap();
    let gz_bytes = Arc::new(gz_encoder.finish().unwrap());
    assert!(
        gz_bytes.len() > BODY_OFFLOAD_THRESHOLD_BYTES,
        "compressed payload must exceed 2 MiB to trigger branch 4b"
    );

    let chunked_piece = Arc::new(vec![b'J'; 65_536]);
    let gz_srv = Arc::clone(&gz_bytes);
    let chunk_srv = Arc::clone(&chunked_piece);
    let up_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up_addr = up_listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = up_listener.accept().await {
            let gz = Arc::clone(&gz_srv);
            let cp = Arc::clone(&chunk_srv);
            tokio::spawn(async move {
                let mut req_buf = Vec::new();
                let mut tmp = [0u8; 2048];
                while let Ok(n) = sock.read(&mut tmp).await {
                    if n == 0 {
                        break;
                    }
                    req_buf.extend_from_slice(&tmp[..n]);
                    if req_buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let req_head = String::from_utf8_lossy(&req_buf);
                if req_head.contains("/gzip-4b") {
                    let hdr = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        gz.len()
                    );
                    let _ = sock.write_all(hdr.as_bytes()).await;
                    let _ = sock.write_all(&gz).await;
                } else {
                    let _ = sock
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                        )
                        .await;
                    let chunk_hdr = format!("{:x}\r\n", cp.len());
                    for _ in 0..40 {
                        if sock.write_all(chunk_hdr.as_bytes()).await.is_err()
                            || sock.write_all(&cp).await.is_err()
                            || sock.write_all(b"\r\n").await.is_err()
                        {
                            return;
                        }
                    }
                    let _ = sock.write_all(b"0\r\n\r\n").await;
                }
            });
        }
    });

    let (controller, _rules, _filters, store, tmp_dir) = make_stage44_controller("bug05");
    let status = controller.start("127.0.0.1".into(), 0).await.unwrap();

    // 4b. Gzipped >2 MiB response decodes 64 KiB preview into TrafficStore
    {
        let tcp = TcpStream::connect(("127.0.0.1", status.port))
            .await
            .unwrap();
        let (mut sender, conn) =
            hyper::client::conn::http1::handshake(TokioIo::new(tcp))
                .await
                .unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let req = Request::builder()
            .method(hyper::Method::GET)
            .uri(format!("http://{up_addr}/gzip-4b"))
            .header(http::header::HOST, up_addr.to_string())
            .body(http_body_util::Empty::<Bytes>::new())
            .unwrap();
        let resp = sender.send_request(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let received = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(received.len(), gz_bytes.len());

        tokio::time::sleep(Duration::from_millis(80)).await;
        let s4b = store
            .list_summaries()
            .into_iter()
            .find(|s| s.path.contains("/gzip-4b"))
            .unwrap();
        let d4b = store.get(s4b.id).unwrap();
        let preview_txt = d4b.response_body_text.expect("expected decoded 4b text preview");
        assert!(
            preview_txt.contains("fluxproxy-gzip-ok"),
            "decoded preview missing marker: {}",
            &preview_txt[..preview_txt.len().min(120)]
        );
    }

    // 4c. Chunked >2 MiB response spills to streaming seamlessly instead of 502 / 499
    {
        let tcp = TcpStream::connect(("127.0.0.1", status.port))
            .await
            .unwrap();
        let (mut sender, conn) =
            hyper::client::conn::http1::handshake(TokioIo::new(tcp))
                .await
                .unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let req = Request::builder()
            .method(hyper::Method::GET)
            .uri(format!("http://{up_addr}/chunked-4c"))
            .header(http::header::HOST, up_addr.to_string())
            .body(http_body_util::Empty::<Bytes>::new())
            .unwrap();
        let resp = sender.send_request(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let received = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(received.len(), 40 * chunked_piece.len());

        tokio::time::sleep(Duration::from_millis(80)).await;
        let s4c = store
            .list_summaries()
            .into_iter()
            .find(|s| s.path.contains("/chunked-4c"))
            .unwrap();
        assert_eq!(s4c.status, 200);
        let d4c = store.get(s4c.id).unwrap();
        assert_eq!(
            d4c.transfer_stats.as_ref().and_then(|st| st.is_streaming),
            Some(true)
        );
    }

    controller.stop().await;
    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn bug06_self_loop_rejects_loopback_ranges_v6_and_local_interfaces() {
    use crate::models::UpstreamProxyProtocol;

    let (controller, _rules, _filters, _store, tmp_dir) = make_stage44_controller("bug06");
    let status = controller.start("127.0.0.1".into(), 0).await.unwrap();
    let active_port = status.port;

    let make_cfg = |host: &str, port: u16| UpstreamProxyConfig {
        enabled: true,
        protocol: UpstreamProxyProtocol::Http,
        host: host.into(),
        port,
        username: None,
        password: None,
        has_password: false,
        bypass_list: Vec::new(),
    };

    for loopback_host in [
        "127.0.0.2",
        "localhost",
        "::1",
        "::ffff:127.0.0.1",
        "0.0.0.0",
    ] {
        let err = controller
            .set_upstream_proxy_config(make_cfg(loopback_host, active_port))
            .unwrap_err();
        assert!(
            err.to_string().contains("Защита от петли трафика"),
            "expected self-loop error for {loopback_host}:{active_port}, got {err}"
        );
    }

    let local_ifs = crate::proxy::network::list_network_interfaces_with_options(true);
    if let Some(iface) = local_ifs.first() {
        let err = controller
            .set_upstream_proxy_config(make_cfg(&iface.ip, active_port))
            .unwrap_err();
        assert!(err.to_string().contains("Защита от петли трафика"));
    }

    // Bind a spare port to guarantee Q != active_port and Q is free
    let probe_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let alt_port = probe_listener.local_addr().unwrap().port();
    drop(probe_listener);

    // Verify set_bind_configuration also enforces self-loop protection against active port
    controller
        .context
        .upstream_proxy
        .set_config(make_cfg("127.0.0.2", active_port))
        .unwrap();
    let bind_loop_err = controller
        .set_bind_configuration(BindHostMode::AllInterfaces, None, false)
        .await
        .unwrap_err();
    assert!(bind_loop_err.to_string().contains("Защита от петли трафика"));

    controller
        .set_upstream_proxy_config(make_cfg("127.0.0.2", alt_port))
        .expect("different port must be accepted");

    let set_port_err = controller.set_port(alt_port).await.unwrap_err();
    assert!(set_port_err.to_string().contains("Защита от петли трафика"));
    assert_eq!(controller.status().await.port, active_port);

    controller.stop().await;
    controller.set_port(alt_port).await.unwrap_err();
    let start_err = controller.start("0.0.0.0".into(), alt_port).await.unwrap_err();
    assert!(start_err.to_string().contains("Защита от петли трафика"));

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn bug07_composer_cancel_latency_and_bpu_redirect_url_and_mock_filter() {
    use crate::models::{
        AutoResponderRule, BreakpointRule, HostListBackendSyncConfig, HostListFilterMode,
        RuleMatchTarget,
    };

    let (controller, rules, filters, store, tmp_dir) = make_stage44_controller("bug07");

    // Redirect + Target servers
    let dest_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dest_addr = dest_listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = dest_listener.accept().await {
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = service_fn(|_req: Request<Incoming>| async move {
                    Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"landed"))))
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection(io, svc)
                    .await;
            });
        }
    });
    let redir_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let redir_addr = redir_listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = redir_listener.accept().await {
            let target_url = format!("http://localhost:{}/landed?foo=bar", dest_addr.port());
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = service_fn(move |_req: Request<Incoming>| {
                    let loc = target_url.clone();
                    async move {
                        Ok::<_, Infallible>(
                            Response::builder()
                                .status(StatusCode::FOUND)
                                .header(http::header::LOCATION, loc)
                                .body(Full::new(Bytes::new()))
                                .unwrap(),
                        )
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection(io, svc)
                    .await;
            });
        }
    });

    // 1. Follow redirects updates final summary url/host/path
    let redir_detail = controller
        .execute_composed(ComposedRequest {
            method: "GET".into(),
            url: format!("http://{redir_addr}/bounce"),
            headers: vec![],
            body: String::new(),
            body_base64: None,
            follow_redirects: true,
            skip_python_scripts: Some(true),
            request_id: None,
            timeout_sec: None,
        })
        .await
        .unwrap();
    assert_eq!(redir_detail.summary.status, 200);
    assert_eq!(redir_detail.summary.host, "localhost");
    assert_eq!(redir_detail.summary.path, "/landed?foo=bar");
    assert_eq!(
        redir_detail.summary.url,
        format!("http://localhost:{}/landed?foo=bar", dest_addr.port())
    );

    // 2. Cancel during DelayOnly latency simulation
    rules.set_rules(vec![
        AutoResponderRule {
            id: "slow-rule".into(),
            enabled: true,
            name: "Slow Latency".into(),
            match_target: RuleMatchTarget::UrlContains,
            pattern: "/slow-cancel".into(),
            method_filter: None,
            header_name: None,
            action: RuleActionType::DelayOnly,
            status_code: 200,
            latency_ms: 5_000,
            response_headers: vec![],
            response_body: String::new(),
        },
        AutoResponderRule {
            id: "mock-dropped".into(),
            enabled: true,
            name: "Mock Dropped".into(),
            match_target: RuleMatchTarget::UrlContains,
            pattern: "/dropped-mock".into(),
            method_filter: None,
            header_name: None,
            action: RuleActionType::MockResponse,
            status_code: 200,
            latency_ms: 0,
            response_headers: vec![HeaderPair::new("Content-Type", "application/json")],
            response_body: "{\"m\":1}".into(),
        },
    ]);

    let c_lat = Arc::new(controller);
    let c_lat_exec = Arc::clone(&c_lat);
    let lat_start = Instant::now();
    let lat_handle = tokio::spawn(async move {
        c_lat_exec
            .execute_composed(ComposedRequest {
                method: "GET".into(),
                url: "http://example.invalid/slow-cancel".into(),
                headers: vec![],
                body: String::new(),
                body_base64: None,
                follow_redirects: false,
                skip_python_scripts: Some(true),
                request_id: Some("cancel-lat-1".into()),
                timeout_sec: Some(10),
            })
            .await
    });
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert!(c_lat.cancel_composed_request("cancel-lat-1"));
    let lat_res = lat_handle.await.unwrap();
    assert!(lat_res.is_err());
    assert!(lat_start.elapsed() < Duration::from_millis(500));

    // 3. Cancel during bpu cleans up paused breakpoint
    c_lat.context.breakpoints.update_config(BreakpointConfig {
        break_before_request: false,
        break_after_response: false,
        timeout_secs: 10,
        rules: vec![BreakpointRule {
            id: "bp-comp-cancel".into(),
            enabled: true,
            name: "Composer BPU Cancel".into(),
            stage: BreakpointStage::Request,
            url_pattern: "/comp-bpu-cancel".into(),
            method_filter: None,
        }],
    });
    let c_bpu_exec = Arc::clone(&c_lat);
    let bpu_handle = tokio::spawn(async move {
        c_bpu_exec
            .execute_composed(ComposedRequest {
                method: "GET".into(),
                url: "http://example.invalid/comp-bpu-cancel".into(),
                headers: vec![],
                body: String::new(),
                body_base64: None,
                follow_redirects: false,
                skip_python_scripts: Some(true),
                request_id: Some("cancel-bpu-1".into()),
                timeout_sec: Some(10),
            })
            .await
    });
    let mut paused_seen = false;
    for _ in 0..100 {
        if !c_lat.context.breakpoints.list_paused().is_empty() {
            paused_seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(paused_seen, "Composer bpu should have paused");
    assert!(c_lat.cancel_composed_request("cancel-bpu-1"));
    assert!(bpu_handle.await.unwrap().is_err());
    assert!(
        c_lat.context.breakpoints.list_paused().is_empty(),
        "paused breakpoint must be cleaned up on Composer cancel"
    );

    // 4. MockResponse respects drop_non_matching_on_capture
    filters.update_config(ProxyFilterBackendConfig {
        drop_non_matching_on_capture: true,
        capture_host_list: HostListBackendSyncConfig {
            enabled: true,
            mode: HostListFilterMode::Whitelist,
            raw_text: "only-keep.invalid".into(),
        },
        ..crate::proxy::filters::default_backend_config()
    });
    let dropped_before = store.storage_stats(true).dropped_sessions_count;
    let mock_res = c_lat
        .execute_composed(ComposedRequest {
            method: "GET".into(),
            url: "http://dropped-host.invalid/dropped-mock".into(),
            headers: vec![],
            body: String::new(),
            body_base64: None,
            follow_redirects: false,
            skip_python_scripts: Some(true),
            request_id: None,
            timeout_sec: None,
        })
        .await
        .unwrap();
    assert!(store.get(mock_res.summary.id).is_none());
    assert!(store.storage_stats(true).dropped_sessions_count > dropped_before);

    c_lat.stop().await;
    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn conc01_conc02_graceful_drain_hard_abort_and_live_policy_reactivity() {
    use std::sync::atomic::AtomicUsize;

    // Upstream HTTP + WebSocket echo server
    let up_http_ws = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up_addr = up_http_ws.local_addr().unwrap();
    let up_hits = Arc::new(AtomicUsize::new(0));
    let up_hits_srv = Arc::clone(&up_hits);
    tokio::spawn(async move {
        while let Ok((stream, _)) = up_http_ws.accept().await {
            let hits = Arc::clone(&up_hits_srv);
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = service_fn(move |req: Request<Incoming>| {
                    let hits = Arc::clone(&hits);
                    async move {
                        let is_ws = req
                            .headers()
                            .get(http::header::UPGRADE)
                            .and_then(|v| v.to_str().ok())
                            .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
                        if is_ws {
                            let key = req
                                .headers()
                                .get("sec-websocket-key")
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("");
                            let accept =
                                tokio_tungstenite::tungstenite::handshake::derive_accept_key(
                                    key.as_bytes(),
                                );
                            tokio::spawn(async move {
                                if let Ok(up) = hyper::upgrade::on(req).await {
                                    let mut ws = WebSocketStream::from_raw_socket(
                                        TokioIo::new(up),
                                        Role::Server,
                                        None,
                                    )
                                    .await;
                                    while let Some(Ok(msg)) = ws.next().await {
                                        if msg.is_close() {
                                            break;
                                        }
                                        if ws.send(msg).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            });
                            return Ok::<_, Infallible>(
                                Response::builder()
                                    .status(StatusCode::SWITCHING_PROTOCOLS)
                                    .header(http::header::CONNECTION, "Upgrade")
                                    .header(http::header::UPGRADE, "websocket")
                                    .header("Sec-WebSocket-Accept", accept)
                                    .body(Full::new(Bytes::new()))
                                    .unwrap(),
                            );
                        }
                        hits.fetch_add(1, Ordering::Relaxed);
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"ok"))))
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, svc)
                    .await;
            });
        }
    });

    let (controller, _rules, filters, store, tmp_dir) = make_stage44_controller("conc01");
    controller.set_drain_deadline_for_test(Duration::from_millis(450));

    // 1. CONC-01 Graceful Drain via stop()
    let status = controller.start("127.0.0.1".into(), 0).await.unwrap();
    let port1 = status.port;

    let mut ws = open_proxied_ws(port1, &format!("ws://{up_addr}/ws-drain")).await;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        "before-drain".into(),
    ))
    .await
    .unwrap();
    let reply1 = ws.next().await.unwrap().unwrap();
    assert_eq!(reply1.to_text().unwrap(), "before-drain");
    tokio::time::sleep(Duration::from_millis(40)).await;
    let ws_session_id = store
        .list_summaries()
        .into_iter()
        .find(|s| s.path.contains("/ws-drain"))
        .unwrap()
        .id;
    let frames_before_drain = store.get(ws_session_id).unwrap().websocket_frames.len();
    assert!(frames_before_drain >= 2);

    // Open HTTP/1.1 keep-alive connection and finish one request before stop()
    let mut keepalive_sock = TcpStream::connect(("127.0.0.1", port1)).await.unwrap();
    keepalive_sock
        .write_all(
            format!("GET http://{up_addr}/ka1 HTTP/1.1\r\nHost: {up_addr}\r\n\r\n").as_bytes(),
        )
        .await
        .unwrap();
    let (_h1, b1) = read_raw_http_head_and_body(&mut keepalive_sock).await;
    assert_eq!(b1, b"ok");
    let hits_before_stop = up_hits.load(Ordering::Relaxed);

    controller.stop().await;

    // Listener socket must be released immediately after stop() (avoids Windows ~2s connect SYN-retry eating the 450ms drain window)
    let probe_listener = TcpListener::bind(("127.0.0.1", port1))
        .await
        .expect("listener must be closed after stop()");
    drop(probe_listener);

    // Keep-alive follow-up request during drain receives 503 (or closes) and never reaches upstream
    if keepalive_sock
        .write_all(
            format!("GET http://{up_addr}/ka2 HTTP/1.1\r\nHost: {up_addr}\r\n\r\n").as_bytes(),
        )
        .await
        .is_ok()
    {
        let mut ka2_buf = [0u8; 512];
        if let Ok(n_ka2) = keepalive_sock.read(&mut ka2_buf).await {
            if n_ka2 > 0 {
                let ka2_str = String::from_utf8_lossy(&ka2_buf[..n_ka2]);
                assert!(
                    ka2_str.starts_with("HTTP/1.1 503"),
                    "expected 503 during drain, got: {ka2_str}"
                );
            }
        }
    }
    assert_eq!(up_hits.load(Ordering::Relaxed), hits_before_stop);

    // Live WebSocket keeps relaying frames during drain window WITHOUT recording into TrafficStore
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        "during-drain".into(),
    ))
    .await
    .unwrap();
    let reply2 = ws.next().await.unwrap().unwrap();
    assert_eq!(reply2.to_text().unwrap(), "during-drain");
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(
        store.get(ws_session_id).unwrap().websocket_frames.len(),
        frames_before_drain,
        "TrafficStore capture must be suppressed during graceful drain"
    );

    // Wait for 450 ms drain deadline -> WS must close
    let ws_closed_on_deadline = tokio::time::timeout(Duration::from_millis(1000), async {
        loop {
            match ws.next().await {
                None | Some(Err(_)) => break,
                Some(Ok(_)) => continue,
            }
        }
    })
    .await;
    assert!(
        ws_closed_on_deadline.is_ok(),
        "live WebSocket should close after drain deadline expires"
    );

    // 2. CONC-01 Hard Abort (0 ms) on narrowing AllInterfaces -> Loopback, set_port, shutdown_sync
    let st_all = controller.start("0.0.0.0".into(), 0).await.unwrap();
    let mut ws_narrow = open_proxied_ws(st_all.port, &format!("ws://{up_addr}/ws-narrow")).await;
    let t_narrow = Instant::now();
    controller
        .set_bind_configuration(BindHostMode::Loopback, None, false)
        .await
        .unwrap();
    let closed_narrow = tokio::time::timeout(Duration::from_millis(250), async {
        while let Some(Ok(_)) = ws_narrow.next().await {}
    })
    .await;
    assert!(
        closed_narrow.is_ok() && t_narrow.elapsed() < Duration::from_millis(250),
        "narrowing bind change must hard-abort live WS in <250ms"
    );

    let spare_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let next_port = spare_listener.local_addr().unwrap().port();
    drop(spare_listener);

    let mut ws_setport = open_proxied_ws(st_all.port, &format!("ws://{up_addr}/ws-setport")).await;
    let t_setport = Instant::now();
    controller.set_port(next_port).await.unwrap();
    let closed_setport = tokio::time::timeout(Duration::from_millis(250), async {
        while let Some(Ok(_)) = ws_setport.next().await {}
    })
    .await;
    assert!(
        closed_setport.is_ok() && t_setport.elapsed() < Duration::from_millis(250),
        "set_port must hard-abort live WS in <250ms"
    );

    let mut ws_shutdown =
        open_proxied_ws(next_port, &format!("ws://{up_addr}/ws-shutdown")).await;
    let t_shutdown = Instant::now();
    controller.shutdown_sync();
    let closed_shutdown = tokio::time::timeout(Duration::from_millis(250), async {
        while let Some(Ok(_)) = ws_shutdown.next().await {}
    })
    .await;
    assert!(
        closed_shutdown.is_ok() && t_shutdown.elapsed() < Duration::from_millis(250),
        "shutdown_sync must hard-abort live WS in <250ms"
    );

    // 3. CONC-02 Live Policy Switch: Passthrough <-> MITM & LAN Client Allowlist removal (<250 ms)
    // 3a. Active Passthrough CONNECT tunnel aborts in <250 ms when filter flips TargetedOnly -> InterceptAll
    let echo_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_addr = echo_listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = echo_listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 512];
                while let Ok(n) = s.read(&mut buf).await {
                    if n == 0 || s.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });

    filters.update_config(ProxyFilterBackendConfig {
        tls_intercept_mode: TlsInterceptMode::TargetedOnly,
        tls_target_rules: Vec::new(),
        ..crate::proxy::filters::default_backend_config()
    });
    let st_pt = controller.start("127.0.0.1".into(), 0).await.unwrap();
    let mut pt_sock = TcpStream::connect(("127.0.0.1", st_pt.port))
        .await
        .unwrap();
    pt_sock
        .write_all(
            format!("CONNECT {echo_addr} HTTP/1.1\r\nHost: {echo_addr}\r\n\r\n").as_bytes(),
        )
        .await
        .unwrap();
    let mut conn_ack = [0u8; 256];
    let n_ack = pt_sock.read(&mut conn_ack).await.unwrap();
    assert!(String::from_utf8_lossy(&conn_ack[..n_ack]).starts_with("HTTP/1.1 200"));
    pt_sock.write_all(b"ping").await.unwrap();
    let mut ping_buf = [0u8; 16];
    assert_eq!(pt_sock.read(&mut ping_buf).await.unwrap(), 4);

    let t_pt_flip = Instant::now();
    filters.update_config(ProxyFilterBackendConfig {
        tls_intercept_mode: TlsInterceptMode::InterceptAll,
        tls_bypass_enabled: false,
        tls_bypass_rules: Vec::new(),
        ..crate::proxy::filters::default_backend_config()
    });
    let closed_pt = tokio::time::timeout(Duration::from_millis(250), async {
        let mut sink = [0u8; 64];
        loop {
            match pt_sock.read(&mut sink).await {
                Ok(0) | Err(_) => break,
                Ok(_) => continue,
            }
        }
    })
    .await;
    assert!(
        closed_pt.is_ok() && t_pt_flip.elapsed() < Duration::from_millis(250),
        "active passthrough tunnel must abort <250ms when switching to InterceptAll"
    );

    // 3b. Active MITM TLS tunnel aborts in <250 ms when filter flips InterceptAll -> Passthrough
    let mut mitm_sock = TcpStream::connect(("127.0.0.1", st_pt.port))
        .await
        .unwrap();
    mitm_sock
        .write_all(b"CONNECT mitm-flip.test:443 HTTP/1.1\r\nHost: mitm-flip.test:443\r\n\r\n")
        .await
        .unwrap();
    let n_m_ack = mitm_sock.read(&mut conn_ack).await.unwrap();
    assert!(String::from_utf8_lossy(&conn_ack[..n_m_ack]).starts_with("HTTP/1.1 200"));
    let mut root_store = rustls::RootCertStore::empty();
    root_store
        .add(rustls::pki_types::CertificateDer::from(
            controller.context.ca.root_ca_der().to_vec(),
        ))
        .unwrap();
    let client_tls_cfg = Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth(),
    );
    let tls_conn = tokio_rustls::TlsConnector::from(client_tls_cfg);
    let mut mitm_tls = tls_conn
        .connect(
            rustls::pki_types::ServerName::try_from("mitm-flip.test").unwrap(),
            mitm_sock,
        )
        .await
        .unwrap();
    let t_mitm_flip = Instant::now();
    filters.update_config(ProxyFilterBackendConfig {
        tls_intercept_mode: TlsInterceptMode::InterceptAll,
        tls_bypass_enabled: true,
        tls_bypass_rules: vec![TlsBypassRule {
            id: "bypass-mitm-flip".into(),
            enabled: true,
            pattern: "mitm-flip.test".into(),
            category: "Test".into(),
            description: "Flip to Passthrough".into(),
        }],
        ..crate::proxy::filters::default_backend_config()
    });
    let closed_mitm = tokio::time::timeout(Duration::from_millis(250), async {
        let mut sink = [0u8; 64];
        loop {
            match mitm_tls.read(&mut sink).await {
                Ok(0) | Err(_) => break,
                Ok(_) => continue,
            }
        }
    })
    .await;
    assert!(
        closed_mitm.is_ok() && t_mitm_flip.elapsed() < Duration::from_millis(250),
        "active MITM TLS connection must abort <250ms when switching to Passthrough"
    );

    // 3c. LAN Client Allowlist removal aborts active non-loopback connection in <250 ms
    let remote_peer: SocketAddr = "192.168.50.77:55555".parse().unwrap();
    filters.update_config(ProxyFilterBackendConfig {
        lan_client_allowlist: vec!["192.168.50.77".into()],
        ..crate::proxy::filters::default_backend_config()
    });
    let srv_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let srv_addr = srv_listener.local_addr().unwrap();
    let sc_ctx = controller.context.clone();
    let lc_handle = ConnectionLifecycleHandle::new();
    let lc_child = lc_handle.lifecycle();
    tokio::spawn(async move {
        if let Ok((stream, _)) = srv_listener.accept().await {
            serve_connection(stream, remote_peer, Some(srv_addr.port()), lc_child, sc_ctx).await;
        }
    });
    let mut remote_client = TcpStream::connect(srv_addr).await.unwrap();
    let t_allow = Instant::now();
    filters.update_config(ProxyFilterBackendConfig {
        lan_client_allowlist: vec!["192.168.50.99".into()],
        ..crate::proxy::filters::default_backend_config()
    });
    let closed_allow = tokio::time::timeout(Duration::from_millis(250), async {
        let mut sink = [0u8; 64];
        loop {
            match remote_client.read(&mut sink).await {
                Ok(0) | Err(_) => break,
                Ok(_) => continue,
            }
        }
    })
    .await;
    assert!(
        closed_allow.is_ok() && t_allow.elapsed() < Duration::from_millis(250),
        "removing peer IP from lan_client_allowlist must hard-abort connection <250ms"
    );

    controller.shutdown_sync();
    let _ = std::fs::remove_dir_all(&tmp_dir);
}
