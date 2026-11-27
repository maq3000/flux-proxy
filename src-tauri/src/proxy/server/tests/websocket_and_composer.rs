use super::*;

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn websocket_signalr_forwards_auth_cookies_subprotocol_and_response_headers() {
    use tokio_tungstenite::tungstenite::handshake::server::{Request as WsReq, Response as WsResp};
    use tokio_tungstenite::tungstenite::Message;

    let client_original_ws_key = "dGhlIHNhbXBsZSBub25jZQ==";

    // 1. Mock ASP.NET Core SignalR Hub WebSocket endpoint
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((sock, _)) = upstream_listener.accept().await {
            let mut auth_valid = false;
            let ws_stream = tokio_tungstenite::accept_hdr_async(
                sock,
                |req: &WsReq, mut resp: WsResp| {
                    let hdrs = req.headers();
                    let auth = hdrs
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let cookie = hdrs
                        .get("cookie")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let subproto = hdrs
                        .get("sec-websocket-protocol")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let ua = hdrs
                        .get("user-agent")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let x_signalr = hdrs
                        .get("x-signalr-user-agent")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let x_req_with = hdrs
                        .get("x-requested-with")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let ext = hdrs
                        .get("sec-websocket-extensions")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let upstream_key = hdrs
                        .get("sec-websocket-key")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");

                    // Hop-by-hop Sec-WebSocket-Key must be freshly generated, never duplicated
                    assert_eq!(hdrs.get_all("sec-websocket-key").iter().count(), 1);
                    assert_ne!(upstream_key, client_original_ws_key);

                    // permessage-deflate must be stripped while custom extensions pass through
                    assert!(!ext.contains("permessage-deflate"));
                    assert_eq!(ext, "x-flux-trace; v=1");

                    auth_valid = auth == "Bearer signalr-jwt-token-2026"
                        && cookie.contains(".AspNetCore.Cookies=auth_chunk_1")
                        && cookie.contains("XSRF-TOKEN=csrf_42")
                        && subproto == "json"
                        && ua == "Microsoft.AspNetCore.Http.Connections.Client/8.0.0"
                        && x_signalr == "Microsoft SignalR/8.0"
                        && x_req_with == "XMLHttpRequest";

                    if subproto == "json" {
                        resp.headers_mut().insert(
                            "Sec-WebSocket-Protocol",
                            http::header::HeaderValue::from_static("json"),
                        );
                    }
                    resp.headers_mut().append(
                        http::header::SET_COOKIE,
                        http::header::HeaderValue::from_static("AWSALB=sticky1; Path=/"),
                    );
                    resp.headers_mut().append(
                        http::header::SET_COOKIE,
                        http::header::HeaderValue::from_static(
                            "SRVID=node2; Path=/; HttpOnly",
                        ),
                    );
                    resp.headers_mut().insert(
                        "X-SignalR-Hub",
                        http::header::HeaderValue::from_static("NotificationsHub"),
                    );
                    Ok(resp)
                },
            )
            .await
            .unwrap();

            let (mut sink, mut stream) = ws_stream.split();
            if let Some(Ok(Message::Text(handshake_frame))) = stream.next().await {
                assert!(handshake_frame.contains("\"protocol\":\"json\""));
                if auth_valid {
                    // SignalR empty JSON handshake ack + authorized hub message
                    sink.send(Message::Text("{}\u{001e}".into())).await.unwrap();
                    sink.send(Message::Text(
                        "{\"type\":1,\"target\":\"Connected\",\"arguments\":[\"ok\"]}\u{001e}"
                            .into(),
                    ))
                    .await
                    .unwrap();
                } else {
                    // Exact SignalR failure when Authorization/Cookie headers are lost
                    sink.send(Message::Text(
                        "{\"type\":7,\"error\":\"Connection closed with an error. HiddenStackTraceException: Authorization required\"}\u{001e}"
                            .into(),
                    ))
                    .await
                    .unwrap();
                }
            }
        }
    });

    // 2. Start FluxProxy listener
    let tmp_dir =
        std::env::temp_dir().join(format!("fluxproxy-test-signalr-{}", std::process::id()));
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("signalr.sqlite")).unwrap());
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

    // 3. Connect SignalR client through FluxProxy with JWT, Cookies, Subprotocol & X-* headers
    let mut client_tcp = TcpStream::connect(proxy_addr).await.unwrap();
    let raw_upgrade = format!(
        "GET http://127.0.0.1:{port}/hubs/notifications?id=conn_abc HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Connection: Upgrade\r\n\
         Upgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Key: {key}\r\n\
         Sec-WebSocket-Protocol: json\r\n\
         Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits, x-flux-trace; v=1\r\n\
         Authorization: Bearer signalr-jwt-token-2026\r\n\
         Cookie: .AspNetCore.Cookies=auth_chunk_1\r\n\
         Cookie: XSRF-TOKEN=csrf_42\r\n\
         User-Agent: Microsoft.AspNetCore.Http.Connections.Client/8.0.0\r\n\
         X-SignalR-User-Agent: Microsoft SignalR/8.0\r\n\
         X-Requested-With: XMLHttpRequest\r\n\r\n",
        port = upstream_addr.port(),
        key = client_original_ws_key,
    );
    client_tcp.write_all(raw_upgrade.as_bytes()).await.unwrap();

    let mut resp_buf = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    while !resp_buf.ends_with(b"\r\n\r\n") {
        client_tcp.read_exact(&mut byte).await.unwrap();
        resp_buf.push(byte[0]);
    }
    let handshake_headers_str = String::from_utf8_lossy(&resp_buf);
    let lower_resp = handshake_headers_str.to_ascii_lowercase();
    assert!(handshake_headers_str.starts_with("HTTP/1.1 101"));
    assert!(lower_resp.contains("sec-websocket-protocol: json\r\n"));
    assert!(handshake_headers_str.contains("AWSALB=sticky1; Path=/"));
    assert!(handshake_headers_str.contains("SRVID=node2; Path=/; HttpOnly"));
    assert!(lower_resp.contains("x-signalr-hub: notificationshub\r\n"));

    let mut client_ws = WebSocketStream::from_raw_socket(client_tcp, Role::Client, None).await;
    client_ws
        .send(Message::Text(
            "{\"protocol\":\"json\",\"version\":1}\u{001e}".into(),
        ))
        .await
        .unwrap();

    let ack = client_ws.next().await.unwrap().unwrap().into_text().unwrap();
    assert_eq!(ack.as_str(), "{}\u{001e}");

    let hub_msg = client_ws.next().await.unwrap().unwrap().into_text().unwrap();
    assert!(!hub_msg.contains("Authorization required"));
    assert!(hub_msg.contains("\"target\":\"Connected\""));

    let _ = client_ws.close(None).await;
    tokio::time::sleep(Duration::from_millis(40)).await;

    let detail = store.get(1).unwrap();
    assert_eq!(detail.summary.status, 101);
    assert_eq!(detail.websocket_frames.len(), 3);

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn breakpoint_raii_guard_cleans_up_pending_on_client_disconnect_and_composer_abort_records_502() {
    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-bp-guard-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let store = Arc::new(TrafficStore::new(tmp_dir.join("bp-guard.sqlite")).unwrap());
    let (bp_tx, mut bp_rx) = breakpoint_snapshot_channel();
    let breakpoints = Arc::new(BreakpointEngine::new_with_store(
        Some(bp_tx),
        Some(Arc::clone(&store)),
    ));
    breakpoints.update_config(BreakpointConfig {
        break_before_request: true,
        break_after_response: false,
        timeout_secs: 60,
        rules: Vec::new(),
    });
    let (event_tx, mut event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
    let os_backend = RecordingOsProxyBackend::new();
    let sysproxy = Arc::new(SystemProxyManager::with_backend(&tmp_dir, os_backend));

    let ctx = Arc::new(SharedProxyContext {
        ca: ca.clone(),
        rules: rules.clone(),
        filters: filters.clone(),
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

    // 1. Client opens HTTP request via proxy, pauses at Before Request breakpoint, then drops TCP socket
    let mut client_sock = TcpStream::connect(proxy_addr).await.unwrap();
    client_sock
        .write_all(b"GET http://example.invalid/disconnect-bp HTTP/1.1\r\nHost: example.invalid\r\n\r\n")
        .await
        .unwrap();

    let paused_snap = tokio::time::timeout(Duration::from_secs(3), bp_rx.recv())
        .await
        .expect("expected breakpoint snapshot")
        .expect("snapshot channel open");
    assert_eq!(paused_snap.len(), 1);
    let paused_sid = paused_snap[0].session_id;
    assert_eq!(breakpoints.list_paused().len(), 1);

    // Simulate client abort/disconnect while paused at breakpoint
    drop(client_sock);

    let cleared_snap = tokio::time::timeout(Duration::from_secs(3), bp_rx.recv())
        .await
        .expect("expected cleared breakpoint snapshot on disconnect")
        .expect("snapshot channel open");
    assert!(
        cleared_snap.is_empty(),
        "breakpoint pending snapshot must be cleared on client disconnect"
    );
    assert!(breakpoints.list_paused().is_empty());

    let updated_detail = store.get(paused_sid).expect("session must exist in TrafficStore");
    assert_eq!(updated_detail.summary.status, 499);
    assert!(updated_detail.summary.breakpoint_paused.is_none());
    let mut saw_499_event = false;
    while let Ok(ev) = event_rx.try_recv() {
        if ev.id == paused_sid && ev.status == 499 && ev.breakpoint_paused.is_none() {
            saw_499_event = true;
        }
    }
    assert!(saw_499_event, "TrafficStore update event with status 499 must be emitted");

    // 2. Composer Abort at Request Breakpoint must update session to 502 with breakpoint_paused = None
    let (comp_bp_tx, mut comp_bp_rx) = breakpoint_snapshot_channel();
    let (comp_event_tx, _comp_event_rx) =
        session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (comp_removed_tx, _comp_removed_rx) =
        removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
    let controller = ProxyEngineController::new_with_channels(
        ca,
        rules,
        filters,
        store.clone(),
        sysproxy,
        Arc::new(ClientCertificateStore::in_memory()),
        comp_event_tx,
        comp_removed_tx,
        comp_bp_tx,
        None,
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    controller.context.breakpoints.update_config(BreakpointConfig {
        break_before_request: true,
        break_after_response: false,
        timeout_secs: 60,
        rules: Vec::new(),
    });
    let comp_bp = controller.context.breakpoints.clone();
    tokio::spawn(async move {
        if let Some(snapshot) = comp_bp_rx.recv().await {
            if let Some(item) = snapshot.first() {
                comp_bp.resolve(BreakpointResolution {
                    breakpoint_id: item.breakpoint_id.clone(),
                    action: BreakpointAction::Abort,
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

    let composed_res = controller
        .execute_composed(ComposedRequest {
            method: "POST".into(),
            url: "http://example.invalid/composer-abort".into(),
            headers: Vec::new(),
            body: "payload".into(),
            body_base64: None,
            follow_redirects: false,
            skip_python_scripts: None,
            request_id: None,
            timeout_sec: None,
        })
        .await;
    assert!(composed_res.is_err());

    let composer_summary = store
        .list_summaries()
        .into_iter()
        .find(|s| s.path == "/composer-abort")
        .expect("aborted composed session must be recorded in TrafficStore");
    assert_eq!(composer_summary.status, 502);
    assert!(composer_summary.breakpoint_paused.is_none());

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn websocket_connect_timeout_and_bidirectional_large_frame_blast_without_deadlock() {
    use tokio_tungstenite::tungstenite::Message;

    // 1. Stalled TCP listener (accepts socket, never sends HTTP 101) to test connect_async timeout
    let stalled_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let stalled_addr = stalled_listener.local_addr().unwrap();
    let stalled_task = tokio::spawn(async move {
        if let Ok((sock, _)) = stalled_listener.accept().await {
            tokio::time::sleep(Duration::from_secs(10)).await;
            drop(sock);
        }
    });

    // 2. Blast WS upstream: after 1 trigger frame, immediately writes 32 * 64 KiB = 2 MiB
    // BEFORE reading client's 32 * 64 KiB frames (would deadlock single-loop select!)
    let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws_addr = ws_listener.local_addr().unwrap();
    tokio::spawn(async move {
        if let Ok((sock, _)) = ws_listener.accept().await {
            let ws_stream = tokio_tungstenite::accept_async(sock).await.unwrap();
            let (mut sink, mut stream) = ws_stream.split();
            let trigger = stream.next().await.unwrap().unwrap();
            assert_eq!(trigger.into_text().unwrap().as_str(), "start-blast");

            let server_payload = "S".repeat(64 * 1024);
            for _ in 0..32 {
                sink.send(Message::Text(server_payload.clone().into()))
                    .await
                    .unwrap();
            }

            let mut client_frames = 0usize;
            while client_frames < 32 {
                let msg = stream.next().await.unwrap().unwrap();
                assert_eq!(msg.len(), 64 * 1024);
                client_frames += 1;
            }
            let _ = sink.close().await;
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-ws-deadlock-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("ws-deadlock.sqlite")).unwrap());
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
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(1)),
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
        for _ in 0..2 {
            if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
                let c = proxy_ctx.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(tcp_stream);
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

    // Verify connect_async timeout returns 502 promptly
    let mut stalled_client = TcpStream::connect(proxy_addr).await.unwrap();
    let stalled_req = format!(
        "GET http://{stalled_addr}/ws-hang HTTP/1.1\r\n\
         Host: {stalled_addr}\r\n\
         Connection: Upgrade\r\n\
         Upgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    stalled_client.write_all(stalled_req.as_bytes()).await.unwrap();
    let mut stalled_resp_buf = vec![0u8; 1024];
    let n = tokio::time::timeout(Duration::from_secs(4), stalled_client.read(&mut stalled_resp_buf))
        .await
        .expect("WS connect timeout must fire promptly within 4s")
        .unwrap();
    let stalled_resp_str = String::from_utf8_lossy(&stalled_resp_buf[..n]);
    assert!(stalled_resp_str.starts_with("HTTP/1.1 502"));
    assert!(stalled_resp_str.contains("timed out"));
    stalled_task.abort();

    // Verify bidirectional 2 MiB * 2 simultaneous large frame blast completes without deadlock
    let mut blast_client_tcp = TcpStream::connect(proxy_addr).await.unwrap();
    let blast_req = format!(
        "GET http://{ws_addr}/ws-blast HTTP/1.1\r\n\
         Host: {ws_addr}\r\n\
         Connection: Upgrade\r\n\
         Upgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    blast_client_tcp.write_all(blast_req.as_bytes()).await.unwrap();
    let mut hs_buf = Vec::new();
    let mut b = [0u8; 1];
    while !hs_buf.ends_with(b"\r\n\r\n") {
        blast_client_tcp.read_exact(&mut b).await.unwrap();
        hs_buf.push(b[0]);
    }
    assert!(String::from_utf8_lossy(&hs_buf).starts_with("HTTP/1.1 101"));

    let blast_ws = WebSocketStream::from_raw_socket(blast_client_tcp, Role::Client, None).await;
    let (mut c_sink, mut c_stream) = blast_ws.split();
    c_sink
        .send(Message::Text("start-blast".into()))
        .await
        .unwrap();

    let send_fut = async move {
        let client_payload = "C".repeat(64 * 1024);
        for _ in 0..32 {
            c_sink
                .send(Message::Text(client_payload.clone().into()))
                .await
                .unwrap();
        }
        c_sink
    };
    let recv_fut = async move {
        let mut server_frames = 0usize;
        while server_frames < 32 {
            let msg = c_stream.next().await.unwrap().unwrap();
            assert_eq!(msg.len(), 64 * 1024);
            server_frames += 1;
        }
    };

    let (mut c_sink, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(send_fut, recv_fut)
    })
    .await
    .expect("bidirectional large WS frame relay must not deadlock");
    let _ = c_sink.close().await;

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn websocket_manual_frame_injection_to_server_and_client_and_channel_cleanup() {
    use tokio_tungstenite::tungstenite::Message;

    let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws_addr = ws_listener.local_addr().unwrap();
    let (server_rx_tx, mut server_rx_rx) = mpsc::unbounded_channel::<Message>();

    tokio::spawn(async move {
        if let Ok((sock, _)) = ws_listener.accept().await {
            let ws_stream = tokio_tungstenite::accept_async(sock).await.unwrap();
            let (_sink, mut stream) = ws_stream.split();
            while let Some(Ok(msg)) = stream.next().await {
                let is_close = matches!(msg, Message::Close(_));
                let _ = server_rx_tx.send(msg);
                if is_close {
                    break;
                }
            }
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-ws-inject-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("ws-inject.sqlite")).unwrap());
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
        if let Ok((tcp_stream, client_addr)) = proxy_listener.accept().await {
            let io = TokioIo::new(tcp_stream);
            let service = service_fn(move |req: Request<Incoming>| {
                let c = proxy_ctx.clone();
                async move {
                    Ok::<_, Infallible>(
                        handle_outer_proxy_request(
                            req,
                            client_addr,
                            None,
                            ClientConnContext::new(),
                            c,
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
    let raw_upgrade = format!(
        "GET http://{ws_addr}/ws-inject HTTP/1.1\r\n\
         Host: {ws_addr}\r\n\
         Connection: Upgrade\r\n\
         Upgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    client_tcp.write_all(raw_upgrade.as_bytes()).await.unwrap();

    let mut hs_buf = Vec::new();
    let mut b = [0u8; 1];
    while !hs_buf.ends_with(b"\r\n\r\n") {
        client_tcp.read_exact(&mut b).await.unwrap();
        hs_buf.push(b[0]);
    }
    assert!(String::from_utf8_lossy(&hs_buf).starts_with("HTTP/1.1 101"));

    let mut client_ws = WebSocketStream::from_raw_socket(client_tcp, Role::Client, None).await;
    tokio::time::sleep(Duration::from_millis(25)).await;

    assert!(ctx.active_ws_channels.contains_key(&1));
    assert_eq!(store.get(1).unwrap().summary.ws_open, Some(true));

    // 1. Inject Text frame toward Server
    let srv_rec = ctx
        .inject_websocket_frame(
            1,
            WsInjectDirection::Server,
            WsInjectOpcode::Text,
            r#"{"cmd":"ping"}"#.into(),
        )
        .await
        .expect("inject text frame to server");
    assert!(srv_rec.injected);
    assert_eq!(srv_rec.direction, "outbound");
    assert_eq!(srv_rec.opcode, "text");
    assert_eq!(srv_rec.payload_preview, r#"{"cmd":"ping"}"#);

    let server_got = tokio::time::timeout(Duration::from_secs(3), server_rx_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(server_got.into_text().unwrap().as_str(), r#"{"cmd":"ping"}"#);

    // 2. Inject Binary Hex frame toward Client
    let cli_rec = ctx
        .inject_websocket_frame(
            1,
            WsInjectDirection::Client,
            WsInjectOpcode::Binary,
            "de ad be ef".into(),
        )
        .await
        .expect("inject binary frame to client");
    assert!(cli_rec.injected);
    assert_eq!(cli_rec.direction, "inbound");
    assert_eq!(cli_rec.opcode, "binary");
    assert_eq!(cli_rec.byte_length, 4);

    let client_got = tokio::time::timeout(Duration::from_secs(3), client_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(client_got.into_data().as_ref(), &[0xde, 0xad, 0xbe, 0xef]);

    // 3. Close connection and verify active_ws_channels cleanup + ws_open == false
    let _ = client_ws.close(None).await;
    drop(client_ws);

    let mut cleaned = false;
    for _ in 0..40 {
        let ch_gone = !ctx.active_ws_channels.contains_key(&1);
        let marked_closed = store
            .get(1)
            .and_then(|d| d.summary.ws_open)
            == Some(false);
        if ch_gone && marked_closed {
            cleaned = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(cleaned, "active_ws_channels entry must be removed and ws_open marked false on close");
    assert!(ctx.active_ws_channels.is_empty());

    let detail = store.get(1).unwrap();
    assert_eq!(detail.summary.ws_open, Some(false));
    let injected_frames: Vec<_> = detail
        .websocket_frames
        .iter()
        .filter(|f| f.injected)
        .collect();
    assert_eq!(injected_frames.len(), 2);
    assert!(detail
        .websocket_frames
        .iter()
        .filter(|f| !f.injected)
        .all(|f| f.opcode == "close"));

    let post_close_err = ctx
        .inject_websocket_frame(
            1,
            WsInjectDirection::Server,
            WsInjectOpcode::Text,
            "after-close".into(),
        )
        .await;
    assert!(post_close_err.is_err());

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[test]
fn push_or_replace_summary_coalesces_duplicate_session_ids_in_place() {
    let make_sum = |id: u64, status: u16, body_size: usize| SessionSummary {
        id,
        status,
        protocol: "HTTP/1.1".into(),
        scheme: "http".into(),
        method: "GET".into(),
        host: "example.test".into(),
        path: format!("/s/{id}"),
        url: format!("http://example.test/s/{id}"),
        content_type: "text/plain".into(),
        body_size,
        duration_ms: 1,
        timestamp: "2026-11-23T00:00:00Z".into(),
        is_mocked: false,
        matched_rule_id: None,
        error: None,
        process_name: None,
        process_pid: None,
        tls_bypassed: false,
        headers_mutated: false,
        breakpoint_paused: None,
        breakpoint_modified: false,
        comment: None,
        marked_color: None,
        client_ip: None,
        remapped_to: None,
        ttfb_ms: None,
        dns_ms: None,
        connect_ms: None,
        tls_ms: None,
        receive_ms: None,
        request_size: None,
        wire_body_size: None,
        server_ip: None,
        server_conn_reused: None,
        ws_open: None,
    };

    let mut buf = Vec::new();
    push_or_replace_summary(&mut buf, make_sum(1, 0, 0));
    push_or_replace_summary(&mut buf, make_sum(2, 200, 10));
    push_or_replace_summary(&mut buf, make_sum(1, 200, 50));
    push_or_replace_summary(&mut buf, make_sum(1, 200, 120));

    assert_eq!(buf.len(), 2);
    assert_eq!(buf[0].id, 1);
    assert_eq!(buf[0].status, 200);
    assert_eq!(buf[0].body_size, 120);
    assert_eq!(buf[1].id, 2);
}

#[tokio::test]
async fn direct_websocket_with_hosts_remap_and_interleaved_injection_preserves_frames() {
    use tokio_tungstenite::tungstenite::Message;

    // 1. Local WS server capturing incoming Host header and controlling inbound server frames
    let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws_addr = ws_listener.local_addr().unwrap();
    let (server_send_tx, mut server_send_rx) = mpsc::unbounded_channel::<String>();
    let (server_got_tx, mut server_got_rx) = mpsc::unbounded_channel::<String>();
    let (ws_host_tx, ws_host_rx) = oneshot::channel::<Option<String>>();

    tokio::spawn(async move {
        if let Ok((mut sock, _)) = ws_listener.accept().await {
            let mut req_buf = Vec::new();
            let mut b = [0u8; 1];
            while !req_buf.ends_with(b"\r\n\r\n") {
                if sock.read_exact(&mut b).await.is_err() {
                    return;
                }
                req_buf.push(b[0]);
            }
            let req_str = String::from_utf8_lossy(&req_buf);
            let host_hdr = req_str
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("host:"))
                .map(|l| l.split_once(':').map(|x| x.1.trim().to_string()).unwrap_or_default());
            let _ = ws_host_tx.send(host_hdr);

            let key = req_str
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("sec-websocket-key:"))
                .and_then(|l| l.split_once(':').map(|x| x.1.trim().to_string()))
                .unwrap_or_default();
            let accept =
                tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
            let resp = format!(
                "HTTP/1.1 101 Switching Protocols\r\n\
                 Upgrade: websocket\r\n\
                 Connection: Upgrade\r\n\
                 Sec-WebSocket-Accept: {accept}\r\n\r\n"
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
            let ws_stream = WebSocketStream::from_raw_socket(sock, Role::Server, None).await;
            let (mut sink, mut stream) = ws_stream.split();

            tokio::spawn(async move {
                while let Some(msg) = server_send_rx.recv().await {
                    if sink.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
            });

            while let Some(Ok(msg)) = stream.next().await {
                match msg {
                    Message::Text(t) => {
                        let _ = server_got_tx.send(t.to_string());
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    });

    // 2. Local TLS listener capturing SNI from direct wss:// connection via HostRemapRegistry
    let wss_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let wss_addr = wss_listener.local_addr().unwrap();
    let (wss_sni_tx, wss_sni_rx) = oneshot::channel::<Option<String>>();
    tokio::spawn(async move {
        if let Ok((stream, _)) = wss_listener.accept().await {
            let acceptor = tokio_rustls::LazyConfigAcceptor::new(
                rustls::server::Acceptor::default(),
                stream,
            );
            tokio::pin!(acceptor);
            let sni = match acceptor.as_mut().await {
                Ok(start) => start.client_hello().server_name().map(str::to_owned),
                Err(_) => None,
            };
            let _ = wss_sni_tx.send(sni);
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-ws-remap-inject-{}",
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
        .set_rules(vec![
            crate::models::HostRemapRule {
                id: "ws-remap".into(),
                enabled: true,
                source_pattern: "api.virtual-ws.invalid".into(),
                target_host: "127.0.0.1".into(),
                target_port: Some(ws_addr.port()),
                preserve_host_header: true,
                comment: "WS remap".into(),
            },
            crate::models::HostRemapRule {
                id: "wss-remap".into(),
                enabled: true,
                source_pattern: "wss-remap.virtual.invalid".into(),
                target_host: "127.0.0.1".into(),
                target_port: Some(wss_addr.port()),
                preserve_host_header: true,
                comment: "WSS SNI remap".into(),
            },
        ])
        .unwrap();
    let store = Arc::new(TrafficStore::new(tmp_dir.join("ws-remap.sqlite")).unwrap());
    let (event_tx, _event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);

    let ctx = Arc::new(SharedProxyContext {
        ca: ca.clone(),
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
        connect_timeout_sec: Arc::new(std::sync::atomic::AtomicU64::new(3)),
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

    // A. Direct ws:// to non-existent virtual domain remapped to local server
    let mut client_tcp = TcpStream::connect(proxy_addr).await.unwrap();
    let raw_upgrade = "GET http://api.virtual-ws.invalid/live HTTP/1.1\r\n\
         Host: api.virtual-ws.invalid\r\n\
         Connection: Upgrade\r\n\
         Upgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
    client_tcp.write_all(raw_upgrade.as_bytes()).await.unwrap();
    let mut hs_buf = Vec::new();
    let mut b = [0u8; 1];
    while !hs_buf.ends_with(b"\r\n\r\n") {
        client_tcp.read_exact(&mut b).await.unwrap();
        hs_buf.push(b[0]);
    }
    assert!(String::from_utf8_lossy(&hs_buf).starts_with("HTTP/1.1 101"));
    assert_eq!(
        ws_host_rx.await.unwrap().as_deref(),
        Some("api.virtual-ws.invalid")
    );

    let mut client_ws = WebSocketStream::from_raw_socket(client_tcp, Role::Client, None).await;
    tokio::time::sleep(Duration::from_millis(25)).await;

    // 1) Normal inbound frame before injection
    server_send_tx.send("srv-before".into()).unwrap();
    let f1 = tokio::time::timeout(Duration::from_secs(2), client_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(f1.into_text().unwrap().as_str(), "srv-before");

    // 2) Manual injected outbound frame + manual injected inbound frame
    let inj_srv = ctx
        .inject_websocket_frame(
            1,
            WsInjectDirection::Server,
            WsInjectOpcode::Text,
            "injected-to-srv".into(),
        )
        .await
        .unwrap();
    assert!(inj_srv.injected);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), server_got_rx.recv())
            .await
            .unwrap()
            .unwrap(),
        "injected-to-srv"
    );

    let inj_cli = ctx
        .inject_websocket_frame(
            1,
            WsInjectDirection::Client,
            WsInjectOpcode::Text,
            "injected-to-cli".into(),
        )
        .await
        .unwrap();
    assert!(inj_cli.injected);
    let f_inj = tokio::time::timeout(Duration::from_secs(2), client_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(f_inj.into_text().unwrap().as_str(), "injected-to-cli");

    // 3) New normal inbound frames AFTER injection must NOT overwrite injected frames!
    server_send_tx.send("srv-after-1".into()).unwrap();
    server_send_tx.send("srv-after-2".into()).unwrap();
    let f_after1 = tokio::time::timeout(Duration::from_secs(2), client_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let f_after2 = tokio::time::timeout(Duration::from_secs(2), client_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(f_after1.into_text().unwrap().as_str(), "srv-after-1");
    assert_eq!(f_after2.into_text().unwrap().as_str(), "srv-after-2");

    let _ = client_ws.close(None).await;
    drop(client_ws);
    tokio::time::sleep(Duration::from_millis(60)).await;

    let ws_detail = store.get(1).expect("remapped WS session stored");
    assert_eq!(
        ws_detail.summary.remapped_to.as_deref(),
        Some(format!("127.0.0.1:{}", ws_addr.port()).as_str())
    );
    assert_eq!(ws_detail.summary.server_ip.as_deref(), Some("127.0.0.1"));
    let payloads: Vec<&str> = ws_detail
        .websocket_frames
        .iter()
        .map(|f| f.payload_preview.as_str())
        .collect();
    assert!(payloads.contains(&"srv-before"));
    assert!(payloads.contains(&"injected-to-srv"));
    assert!(payloads.contains(&"injected-to-cli"));
    assert!(payloads.contains(&"srv-after-1"));
    assert!(payloads.contains(&"srv-after-2"));
    for (pos, rec) in ws_detail.websocket_frames.iter().enumerate() {
        assert_eq!(rec.index, pos + 1, "frame indices must be strictly 1..=N");
    }

    // B. Direct wss:// via HostRemapRegistry preserves original TLS SNI
    let mut wss_tcp = TcpStream::connect(proxy_addr).await.unwrap();
    wss_tcp
        .write_all(
            b"CONNECT wss-remap.virtual.invalid:443 HTTP/1.1\r\nHost: wss-remap.virtual.invalid:443\r\n\r\n",
        )
        .await
        .unwrap();
    let mut conn_buf = [0u8; 256];
    let n = wss_tcp.read(&mut conn_buf).await.unwrap();
    assert!(String::from_utf8_lossy(&conn_buf[..n]).starts_with("HTTP/1.1 200"));

    let mut root_store = rustls::RootCertStore::empty();
    root_store
        .add(rustls::pki_types::CertificateDer::from(
            ca.root_ca_der().to_vec(),
        ))
        .unwrap();
    let mut tls_cfg = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    tls_cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_cfg));
    let server_name =
        rustls::pki_types::ServerName::try_from("wss-remap.virtual.invalid").unwrap();
    let mut mitm_tls = connector.connect(server_name, wss_tcp).await.unwrap();
    mitm_tls
        .write_all(
            b"GET /sni-ws HTTP/1.1\r\n\
              Host: wss-remap.virtual.invalid\r\n\
              Connection: Upgrade\r\n\
              Upgrade: websocket\r\n\
              Sec-WebSocket-Version: 13\r\n\
              Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        )
        .await
        .unwrap();
    let mut _drain = [0u8; 256];
    let _ = tokio::time::timeout(Duration::from_secs(2), mitm_tls.read(&mut _drain)).await;

    let captured_sni = tokio::time::timeout(Duration::from_secs(2), wss_sni_rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(captured_sni.as_deref(), Some("wss-remap.virtual.invalid"));

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn execute_composed_runs_override_status_hop_by_hop_filter_and_python_hooks() {
    use crate::models::{AutoResponderRule, RuleMatchTarget};

    type ObservedHeaders = Arc<std::sync::Mutex<Vec<(Option<String>, bool)>>>;
    let received_headers: ObservedHeaders = Arc::new(std::sync::Mutex::new(Vec::new()));
    let rec_srv = Arc::clone(&received_headers);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let rec = Arc::clone(&rec_srv);
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = service_fn(move |req: Request<Incoming>| {
                    let rec = Arc::clone(&rec);
                    async move {
                        let py_hdr = req
                            .headers()
                            .get("x-from-composer-py")
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_owned);
                        let has_hop_by_hop = req.headers().contains_key("keep-alive")
                            || req.headers().contains_key("proxy-connection");
                        rec.lock().unwrap().push((py_hdr, has_hop_by_hop));
                        Ok::<_, Infallible>(
                            Response::builder()
                                .status(StatusCode::OK)
                                .header(CONTENT_TYPE, "application/json")
                                .body(Full::new(Bytes::from_static(br#"{"upstream":true}"#)))
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

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-composer-parity-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    rules.set_rules(vec![AutoResponderRule {
        id: "override-201".into(),
        enabled: true,
        name: "Override Status 201".into(),
        match_target: RuleMatchTarget::UrlContains,
        pattern: "/composer-parity".into(),
        method_filter: None,
        header_name: None,
        action: RuleActionType::OverrideStatus,
        status_code: 201,
        latency_ms: 0,
        response_headers: Vec::new(),
        response_body: String::new(),
    }]);
    let filters = Arc::new(ProxyFilterEngine::new());
    let store = Arc::new(TrafficStore::new(tmp_dir.join("composer-parity.sqlite")).unwrap());
    let sysproxy = Arc::new(SystemProxyManager::with_backend(
        &tmp_dir,
        RecordingOsProxyBackend::new(),
    ));
    let controller =
        ProxyEngineController::new_for_test(ca, rules, filters, store, sysproxy).unwrap();

    let py_available = controller
        .context
        .script_runner
        .get_status()
        .await
        .available;
    if py_available {
        let py_code = r#"
import json

def on_request(request):
    request["headers"]["X-From-Composer-Py"] = "hmac-ok"

def on_response(response, request):
    response["headers"]["X-Py-Resp"] = "hooked"
    data = json.loads(response["body"])
    data["py_hooked"] = True
    response["body"] = json.dumps(data)
"#;
        controller
            .context
            .script_runner
            .set_script(py_code.to_string(), true)
            .await
            .unwrap();
    }

    // 1. Default run (skip_python_scripts = None -> Python runs when available + OverrideStatus + hop-by-hop stripped)
    let detail1 = controller
        .execute_composed(ComposedRequest {
            method: "GET".into(),
            url: format!("http://{addr}/composer-parity"),
            headers: vec![
                HeaderPair::new("Keep-Alive", "timeout=5"),
                HeaderPair::new("Proxy-Connection", "keep-alive"),
                HeaderPair::new("X-Custom", "1"),
            ],
            body: String::new(),
            body_base64: None,
            follow_redirects: false,
            skip_python_scripts: None,
            request_id: None,
            timeout_sec: None,
        })
        .await
        .unwrap();

    assert_eq!(detail1.summary.status, 201);
    assert!(detail1.summary.is_mocked);
    assert_eq!(
        detail1.summary.matched_rule_id.as_deref(),
        Some("override-201")
    );

    // 2. Explicit skip_python_scripts = Some(true) bypasses hooks while keeping OverrideStatus & hop-by-hop filter
    let detail2 = controller
        .execute_composed(ComposedRequest {
            method: "GET".into(),
            url: format!("http://{addr}/composer-parity"),
            headers: vec![HeaderPair::new("Proxy-Connection", "keep-alive")],
            body: String::new(),
            body_base64: None,
            follow_redirects: false,
            skip_python_scripts: Some(true),
            request_id: None,
            timeout_sec: None,
        })
        .await
        .unwrap();

    assert_eq!(detail2.summary.status, 201);
    assert!(detail2.summary.is_mocked);

    let recorded = received_headers.lock().unwrap();
    assert_eq!(recorded.len(), 2);
    assert!(!recorded[0].1, "hop-by-hop headers must be stripped");
    assert!(!recorded[1].1, "hop-by-hop headers must be stripped");

    if py_available {
        assert_eq!(recorded[0].0.as_deref(), Some("hmac-ok"));
        assert_eq!(recorded[1].0, None);
        assert!(detail1
            .response_headers
            .iter()
            .any(|h| h.name.eq_ignore_ascii_case("x-py-resp") && h.value == "hooked"));
        assert!(detail1
            .response_body_text
            .as_deref()
            .unwrap_or("")
            .contains("\"py_hooked\": true"));
        assert!(detail1.timings.as_ref().and_then(|t| t.script_hook_ms).is_some());
        assert!(!detail2
            .response_headers
            .iter()
            .any(|h| h.name.eq_ignore_ascii_case("x-py-resp")));
        controller.context.script_runner.shutdown_sync();
    }

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn stage39_composer_cancel_records_499() {
    let stalled_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let stalled_addr = stalled_listener.local_addr().unwrap();
    let release = Arc::new(tokio::sync::Notify::new());
    let release_srv = Arc::clone(&release);
    tokio::spawn(async move {
        if let Ok((_sock, _)) = stalled_listener.accept().await {
            release_srv.notified().await;
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-stage39-composer-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let store = Arc::new(TrafficStore::new(tmp_dir.join("composer-cancel.sqlite")).unwrap());
    let sysproxy = Arc::new(SystemProxyManager::new(&tmp_dir));
    let client_certs = Arc::new(ClientCertificateStore::in_memory());
    let (event_tx, mut event_rx) = session_event_channel(DEFAULT_EVENT_CHANNEL_CAPACITY);
    let (removed_tx, _removed_rx) = removed_ids_channel(DEFAULT_REMOVED_CHANNEL_CAPACITY);
    let (bp_tx, _bp_rx) = breakpoint_snapshot_channel();

    let controller = Arc::new(
        ProxyEngineController::new_with_channels(
            ca,
            rules,
            filters,
            store.clone(),
            sysproxy,
            client_certs,
            event_tx,
            removed_tx,
            bp_tx,
            None,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap(),
    );

    let ctrl_spawn = Arc::clone(&controller);
    let url = format!("http://{stalled_addr}/slow-composer");
    let task = tokio::spawn(async move {
        ctrl_spawn
            .execute_composed(ComposedRequest {
                method: "GET".into(),
                url,
                headers: Vec::new(),
                body: String::new(),
                body_base64: None,
                follow_redirects: false,
                skip_python_scripts: Some(true),
                request_id: Some("cmp-req-cancel-1".into()),
                timeout_sec: Some(0),
            })
            .await
    });

    let in_flight = tokio::time::timeout(Duration::from_secs(3), event_rx.recv())
        .await
        .expect("Composer should emit in-flight session")
        .unwrap();
    assert_eq!(in_flight.status, 0);

    assert!(controller.cancel_composed_request("cmp-req-cancel-1"));
    assert!(!controller.cancel_composed_request("cmp-req-cancel-1"));

    let res = task.await.unwrap();
    assert!(res.is_err());

    let cancelled_evt = tokio::time::timeout(Duration::from_secs(3), event_rx.recv())
        .await
        .expect("Composer cancel should emit 499 session summary")
        .unwrap();
    assert_eq!(cancelled_evt.status, 499);
    let detail = store.get(in_flight.id).unwrap();
    assert_eq!(detail.summary.status, 499);
    assert!(detail.response_headers.iter().any(|h| {
        h.name.eq_ignore_ascii_case("x-fluxproxy-error") && h.value == "composer-cancelled"
    }));

    release.notify_one();
    let _ = std::fs::remove_dir_all(&tmp_dir);
}

