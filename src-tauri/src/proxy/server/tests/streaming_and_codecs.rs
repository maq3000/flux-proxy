use super::*;

#[tokio::test]
async fn transparently_decompresses_zstd_upstream_responses_for_client_and_traffic_store() {
    let json_plain = r#"{"service":"FluxProxy","codec":"zstd","ok":true}"#;
    let html_plain = "<!DOCTYPE html><html><body><h1>Zstd OK</h1></body></html>";
    let large_plain = "FluxProxyZstdLargePayload-".repeat(12_000); // > 256 KiB
    assert!(large_plain.len() > ZSTD_SPAWN_BLOCKING_THRESHOLD_BYTES);
    let sse_plain = "id: z1\nevent: delta\ndata: {\"ok\":true}\n\ndata: [DONE]\n\n";
    let corrupt_payload = b"NOT_A_VALID_ZSTD_FRAME";

    let json_zstd = zstd::encode_all(json_plain.as_bytes(), 3).unwrap();
    let html_br = {
        use std::io::Write;
        let mut buf = Vec::new();
        let mut compressor = brotli::CompressorWriter::new(&mut buf, 4096, 4, 22);
        compressor.write_all(html_plain.as_bytes()).unwrap();
        drop(compressor);
        buf
    };
    let html_zstd = zstd::encode_all(html_br.as_slice(), 3).unwrap();
    let large_zstd = zstd::encode_all(large_plain.as_bytes(), 3).unwrap();
    let sse_zstd = zstd::encode_all(sse_plain.as_bytes(), 3).unwrap();

    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();

    tokio::spawn(async move {
        loop {
            let Ok((tcp_stream, _)) = upstream_listener.accept().await else {
                break;
            };
            let json_zstd = json_zstd.clone();
            let html_zstd = html_zstd.clone();
            let large_zstd = large_zstd.clone();
            let sse_zstd = sse_zstd.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(tcp_stream);
                let svc = service_fn(move |req: Request<Incoming>| {
                    let json_zstd = json_zstd.clone();
                    let html_zstd = html_zstd.clone();
                    let large_zstd = large_zstd.clone();
                    let sse_zstd = sse_zstd.clone();
                    async move {
                        let resp = match req.uri().path() {
                            "/zstd-json" => Response::builder()
                                .status(StatusCode::OK)
                                .header(CONTENT_TYPE, "application/json; charset=utf-8")
                                .header("Content-Encoding", "zstd")
                                .body(Full::new(Bytes::from(json_zstd)))
                                .unwrap(),
                            "/zstd-html" => Response::builder()
                                .status(StatusCode::OK)
                                .header(CONTENT_TYPE, "text/html; charset=utf-8")
                                .header("Content-Encoding", "br, ZSTD")
                                .body(Full::new(Bytes::from(html_zstd)))
                                .unwrap(),
                            "/zstd-large" => Response::builder()
                                .status(StatusCode::OK)
                                .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                                .header("Content-Encoding", "zstd")
                                .body(Full::new(Bytes::from(large_zstd)))
                                .unwrap(),
                            "/zstd-sse" => Response::builder()
                                .status(StatusCode::OK)
                                .header(CONTENT_TYPE, "text/event-stream; charset=utf-8")
                                .header("Content-Encoding", "zstd")
                                .body(Full::new(Bytes::from(sse_zstd)))
                                .unwrap(),
                            "/zstd-corrupt" => Response::builder()
                                .status(StatusCode::OK)
                                .header(CONTENT_TYPE, "application/octet-stream")
                                .header("Content-Encoding", "zstd")
                                .body(Full::new(Bytes::from_static(corrupt_payload)))
                                .unwrap(),
                            _ => Response::builder()
                                .status(StatusCode::NOT_FOUND)
                                .body(Full::new(Bytes::new()))
                                .unwrap(),
                        };
                        Ok::<_, Infallible>(resp)
                    }
                });
                let _ = AutoConnBuilder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, svc)
                    .await;
            });
        }
    });

    let tmp_dir =
        std::env::temp_dir().join(format!("fluxproxy-test-zstd-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("zstd.sqlite")).unwrap());
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

    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
        .build()
        .unwrap();

    // 1. JSON with `Content-Encoding: zstd`
    let json_resp = client
        .get(format!("http://127.0.0.1:{}/zstd-json", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(json_resp.status(), StatusCode::OK);
    assert!(json_resp.headers().get("content-encoding").is_none());
    assert_eq!(json_resp.text().await.unwrap(), json_plain);

    // 2. HTML with `Content-Encoding: br, ZSTD`
    let html_resp = client
        .get(format!("http://127.0.0.1:{}/zstd-html", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(html_resp.status(), StatusCode::OK);
    assert!(html_resp.headers().get("content-encoding").is_none());
    assert_eq!(html_resp.text().await.unwrap(), html_plain);

    // 3. Large (> 256 KB) payload via `spawn_blocking`
    let large_resp = client
        .get(format!("http://127.0.0.1:{}/zstd-large", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(large_resp.status(), StatusCode::OK);
    assert!(large_resp.headers().get("content-encoding").is_none());
    assert_eq!(large_resp.text().await.unwrap(), large_plain);

    // 4. SSE stream with `Content-Encoding: zstd`
    let sse_resp = client
        .get(format!("http://127.0.0.1:{}/zstd-sse", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(sse_resp.status(), StatusCode::OK);
    assert!(sse_resp.headers().get("content-encoding").is_none());
    assert_eq!(sse_resp.text().await.unwrap(), sse_plain);

    // 5. Corrupt zstd frame preserves `Content-Encoding: zstd` and returns original bytes
    let corrupt_resp = client
        .get(format!("http://127.0.0.1:{}/zstd-corrupt", upstream_addr.port()))
        .send()
        .await
        .unwrap();
    assert_eq!(corrupt_resp.status(), StatusCode::OK);
    assert_eq!(
        corrupt_resp
            .headers()
            .get("content-encoding")
            .and_then(|v| v.to_str().ok()),
        Some("zstd")
    );
    assert_eq!(corrupt_resp.bytes().await.unwrap().as_ref(), corrupt_payload);

    tokio::time::sleep(Duration::from_millis(40)).await;
    let summaries = store.list_summaries();
    let json_summary = summaries
        .iter()
        .find(|s| s.path == "/zstd-json")
        .expect("missing /zstd-json session");
    let json_detail = store.get(json_summary.id).unwrap();
    assert_eq!(json_detail.response_body_text.as_deref(), Some(json_plain));
    assert_eq!(json_detail.summary.body_size, json_plain.len());

    let html_summary = summaries
        .iter()
        .find(|s| s.path == "/zstd-html")
        .expect("missing /zstd-html session");
    let html_detail = store.get(html_summary.id).unwrap();
    assert_eq!(html_detail.response_body_text.as_deref(), Some(html_plain));
    assert_eq!(html_detail.summary.body_size, html_plain.len());

    let large_summary = summaries
        .iter()
        .find(|s| s.path == "/zstd-large")
        .expect("missing /zstd-large session");
    let large_detail = store.get(large_summary.id).unwrap();
    assert_eq!(large_detail.response_body_text.as_deref(), Some(large_plain.as_str()));
    assert_eq!(large_detail.summary.body_size, large_plain.len());

    let sse_summary = summaries
        .iter()
        .find(|s| s.path == "/zstd-sse")
        .expect("missing /zstd-sse session");
    let sse_detail = store.get(sse_summary.id).unwrap();
    assert_eq!(sse_detail.response_body_text.as_deref(), Some(sse_plain));
    assert_eq!(sse_detail.sse_events.len(), 2);
    assert_eq!(sse_detail.sse_events[0].event, "delta");
    assert_eq!(sse_detail.sse_events[1].data, "[DONE]");

    let corrupt_summary = summaries
        .iter()
        .find(|s| s.path == "/zstd-corrupt")
        .expect("missing /zstd-corrupt session");
    let corrupt_detail = store.get(corrupt_summary.id).unwrap();
    assert_eq!(corrupt_detail.summary.body_size, corrupt_payload.len());

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn streams_video_partial_content_without_full_buffering() {
    let release_second_chunk = Arc::new(tokio::sync::Notify::new());
    let release_clone = release_second_chunk.clone();

    // 1. Mock upstream video server (request 1: 206 Partial Content chunked across a barrier;
    // request 2: truncated 206 video stream to verify mid-stream error recording).
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();

    tokio::spawn(async move {
        // Request 1: zero-buffering 206 Partial Content
        if let Ok((mut sock, _)) = upstream_listener.accept().await {
            let mut req_buf = [0u8; 2048];
            let _ = sock.read(&mut req_buf).await;
            let headers = b"HTTP/1.1 206 Partial Content\r\n\
                            Content-Type: video/mp4\r\n\
                            Content-Range: bytes 0-32767/1048576\r\n\
                            Content-Length: 32768\r\n\
                            Connection: close\r\n\r\n";
            sock.write_all(headers).await.unwrap();
            sock.write_all(&vec![b'A'; 16_384]).await.unwrap();
            sock.flush().await.unwrap();

            release_clone.notified().await;

            sock.write_all(&vec![b'B'; 16_384]).await.unwrap();
            sock.flush().await.unwrap();
            let _ = sock.shutdown().await;
        }

        // Request 2: mid-stream abrupt EOF before declared Content-Length (65536)
        if let Ok((mut sock, _)) = upstream_listener.accept().await {
            let mut req_buf = [0u8; 2048];
            let _ = sock.read(&mut req_buf).await;
            let headers = b"HTTP/1.1 206 Partial Content\r\n\
                            Content-Type: video/mp4\r\n\
                            Content-Range: bytes 0-65535/1048576\r\n\
                            Content-Length: 65536\r\n\
                            Connection: close\r\n\r\n";
            sock.write_all(headers).await.unwrap();
            sock.write_all(&vec![b'C'; 4_096]).await.unwrap();
            sock.flush().await.unwrap();
            drop(sock);
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-video-stream-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("video-stream.sqlite")).unwrap());
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

    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
        .build()
        .unwrap();

    // Start request #1: client MUST receive 206 + first chunk BEFORE chunk #2 is released!
    let mut resp = tokio::time::timeout(
        Duration::from_secs(3),
        client
            .get(format!("http://{upstream_addr}/video.mp4"))
            .header("Range", "bytes=0-32767")
            .send(),
    )
    .await
    .expect("proxied 206 headers must arrive without buffering full video")
    .unwrap();

    assert_eq!(resp.status().as_u16(), 206);
    assert_eq!(
        resp.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("video/mp4")
    );
    assert_eq!(
        resp.headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok()),
        Some("bytes 0-32767/1048576")
    );
    assert_eq!(
        resp.headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok()),
        Some("32768")
    );

    let mut received = Vec::new();
    while received.len() < 16_384 {
        let chunk = tokio::time::timeout(Duration::from_secs(3), resp.chunk())
            .await
            .expect("first chunk must arrive while upstream still holds second chunk")
            .unwrap()
            .expect("expected first chunk bytes");
        received.extend_from_slice(&chunk);
    }
    assert!(received[..16_384].iter().all(|&b| b == b'A'));

    // Two-phase check mid-stream: TrafficStore already has status 206 while stream is open
    let mid_detail = store.get(1).expect("session 1 should be committed in phase 1");
    assert_eq!(mid_detail.summary.status, 206);
    assert!(mid_detail.response_body_base64.is_empty());

    // Release second chunk and read to EOF
    release_second_chunk.notify_one();
    while let Some(chunk) = resp.chunk().await.unwrap() {
        received.extend_from_slice(&chunk);
    }
    assert_eq!(received.len(), 32_768);
    assert!(received[16_384..].iter().all(|&b| b == b'B'));

    // Poll until stream task finishes updating final byte count & check binary video was NOT buffered
    let mut final_detail = None;
    for _ in 0..40 {
        if let Some(d) = store.get(1) {
            if d.summary.body_size == 32_768 {
                final_detail = Some(d);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let final_detail = final_detail.expect("TrafficStore should record 32768 streamed bytes");
    assert_eq!(final_detail.summary.status, 206);
    assert!(final_detail.summary.error.is_none());
    assert!(
        final_detail.response_body_base64.is_empty(),
        "binary video/206 response must not be accumulated into response_body_base64"
    );
    assert!(final_detail.response_body_text.is_none());
    assert!(!final_detail.body_offloaded);

    // Request #2: verify mid-stream truncation error is recorded on session #2
    let mut err_resp = client
        .get(format!("http://{upstream_addr}/broken-video.mp4"))
        .header("Range", "bytes=0-65535")
        .send()
        .await
        .unwrap();
    assert_eq!(err_resp.status().as_u16(), 206);
    while let Ok(Some(_)) = err_resp.chunk().await {}

    let mut broken_detail = None;
    for _ in 0..40 {
        if let Some(d) = store.get(2) {
            if d.summary.error.is_some() {
                broken_detail = Some(d);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let broken_detail = broken_detail.expect("session 2 should record mid-stream error");
    assert!(
        broken_detail
            .summary
            .error
            .as_deref()
            .unwrap_or("")
            .contains("Upstream response stream error"),
        "unexpected stream error text: {:?}",
        broken_detail.summary.error
    );

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn collect_request_body_limited_enforces_limit_and_returns_payload_too_large() {
    let within = collect_request_body_limited(Full::new(Bytes::from_static(b"hello")), 5)
        .await
        .expect("body equal to limit must succeed");
    assert_eq!(within.as_ref(), b"hello");

    let exceeded = collect_request_body_limited(Full::new(Bytes::from_static(b"hello!")), 5).await;
    match exceeded {
        Err(RequestBodyReadError::PayloadTooLarge(limit)) => assert_eq!(limit, 5),
        other => panic!("expected PayloadTooLarge(5), got {other:?}"),
    }

    // Also test via multi-frame chunked StreamBody crossing the limit
    let chunks = futures_util::stream::iter(vec![
        Ok::<_, Infallible>(Frame::data(Bytes::from_static(b"abc"))),
        Ok::<_, Infallible>(Frame::data(Bytes::from_static(b"def"))),
        Ok::<_, Infallible>(Frame::data(Bytes::from_static(b"ghi"))),
    ]);
    let streamed_exceeded = collect_request_body_limited(StreamBody::new(chunks), 8).await;
    match streamed_exceeded {
        Err(RequestBodyReadError::PayloadTooLarge(limit)) => assert_eq!(limit, 8),
        other => panic!("expected PayloadTooLarge(8) on streamed body, got {other:?}"),
    }
}

#[tokio::test]
async fn python_script_hooks_run_after_zstd_and_skip_sse_and_video_streams() {
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();

    let zstd_json = zstd::encode_all(br#"{"msg":"hello-zstd"}"#.as_slice(), 1).unwrap();
    let received_req_header = Arc::new(std::sync::Mutex::new(None::<String>));
    let received_req_header_clone = received_req_header.clone();

    tokio::spawn(async move {
        for _ in 0..3 {
            let Ok((mut sock, _)) = upstream_listener.accept().await else {
                break;
            };
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req_str = String::from_utf8_lossy(&buf[..n]).to_string();
            let lower = req_str.to_ascii_lowercase();

            if req_str.contains("/zstd-api") {
                for line in req_str.lines() {
                    if line.to_ascii_lowercase().starts_with("x-from-pyreq:") {
                        if let Ok(mut g) = received_req_header_clone.lock() {
                            *g = Some(line.split_once(':').map(|x| x.1.trim().to_string()).unwrap_or_default());
                        }
                    }
                }
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: zstd\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    zstd_json.len()
                );
                sock.write_all(head.as_bytes()).await.unwrap();
                sock.write_all(&zstd_json).await.unwrap();
            } else if req_str.contains("/sse-stream") {
                let body = b"data: {\"ping\":1}\n\n";
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                sock.write_all(head.as_bytes()).await.unwrap();
                sock.write_all(body).await.unwrap();
            } else if lower.contains("/clip.mp4") {
                let body = vec![b'V'; 1024];
                let head = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Range: bytes 0-1023/4096\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                sock.write_all(head.as_bytes()).await.unwrap();
                sock.write_all(&body).await.unwrap();
            }
            let _ = sock.shutdown().await;
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-py-hooks-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("py-hooks.sqlite")).unwrap());
    let script_runner = Arc::new(PythonScriptRunner::new(None));
    if !script_runner.get_status().await.available {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return;
    }

    let py_code = r#"
import json

def on_request(request):
    request["headers"]["X-From-PyReq"] = "signed-v1"

def on_response(response, request):
    response["headers"]["X-From-PyResp"] = "decompressed"
    data = json.loads(response["body"])
    data["via_python"] = True
    response["body"] = json.dumps(data)
"#;
    let status = script_runner.set_script(py_code.to_string(), true).await.unwrap();
    assert!(status.enabled && status.has_on_request && status.has_on_response);

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
        script_runner: script_runner.clone(),
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

    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
        .build()
        .unwrap();

    // 1. Standard zstd response -> on_request + on_response (after zstd decompression) must run
    let resp_zstd = client
        .get(format!("http://{upstream_addr}/zstd-api"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp_zstd.status().as_u16(), 200);
    assert_eq!(
        resp_zstd.headers().get("x-from-pyresp").and_then(|v| v.to_str().ok()),
        Some("decompressed")
    );
    let zstd_body_text = resp_zstd.text().await.unwrap();
    assert!(zstd_body_text.contains("\"msg\": \"hello-zstd\""));
    assert!(zstd_body_text.contains("\"via_python\": true"));
    assert_eq!(
        received_req_header.lock().unwrap().as_deref(),
        Some("signed-v1")
    );

    // 2. SSE response -> on_request runs (1 more invocation), on_response MUST be skipped
    let resp_sse = client
        .get(format!("http://{upstream_addr}/sse-stream"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp_sse.status().as_u16(), 200);
    assert!(resp_sse.headers().get("x-from-pyresp").is_none());
    let sse_body = resp_sse.text().await.unwrap();
    assert!(sse_body.contains("data: {\"ping\":1}"));

    // 3. 206 video/mp4 response -> on_request runs (1 more invocation), on_response MUST be skipped
    let resp_video = client
        .get(format!("http://{upstream_addr}/clip.mp4"))
        .header("Range", "bytes=0-1023")
        .send()
        .await
        .unwrap();
    assert_eq!(resp_video.status().as_u16(), 206);
    assert!(resp_video.headers().get("x-from-pyresp").is_none());
    let video_bytes = resp_video.bytes().await.unwrap();
    assert_eq!(video_bytes.len(), 1024);

    // Invocations: #1 (on_req + on_resp = 2), #2 SSE (on_req only = 1), #3 206 video (on_req only = 1) => 4 total
    let final_status = script_runner.get_status().await;
    assert_eq!(final_status.invocations_count, 4);

    script_runner.shutdown_sync();
    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[test]
fn sec05_decode_zstd_bounded_enforces_limit_and_decodes_within_limit() {
    let plain = vec![b'A'; 4096];
    let compressed = zstd::encode_all(plain.as_slice(), 1).unwrap();

    let ok = decode_zstd_bounded(&compressed, 4096).expect("within exact limit");
    assert_eq!(ok.len(), 4096);

    let err = decode_zstd_bounded(&compressed, 2048).expect_err("must reject oversized output");
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
}

#[tokio::test]
async fn head_preserves_content_length_and_layered_or_unknown_content_encoding_preserved() {
    use std::io::Write;

    let plain_layered = "MultiLayerEncodedBody-1234567890";
    let gzipped = {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(plain_layered.as_bytes()).unwrap();
        enc.finish().unwrap()
    };
    let gzip_then_zstd = zstd::encode_all(gzipped.as_slice(), 3).unwrap();
    let unknown_inner = b"OPAQUE_CUSTOM_STREAM";
    let custom_then_zstd = zstd::encode_all(unknown_inner.as_slice(), 3).unwrap();
    let raw_custom = b"RAW_UNKNOWN_ENCODING_BYTES";

    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();

    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = upstream_listener.accept().await else {
                break;
            };
            let gzip_then_zstd = gzip_then_zstd.clone();
            let custom_then_zstd = custom_then_zstd.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&buf[..n]);
                if req_str.starts_with("HEAD ") {
                    let head = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 4096\r\nConnection: close\r\n\r\n";
                    sock.write_all(head.as_bytes()).await.unwrap();
                } else if req_str.contains("/multi-gzip-zstd") {
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Encoding: gzip, zstd\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        gzip_then_zstd.len()
                    );
                    sock.write_all(head.as_bytes()).await.unwrap();
                    sock.write_all(&gzip_then_zstd).await.unwrap();
                } else if req_str.contains("/partial-custom-zstd") {
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Encoding: x-custom, zstd\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        custom_then_zstd.len()
                    );
                    sock.write_all(head.as_bytes()).await.unwrap();
                    sock.write_all(&custom_then_zstd).await.unwrap();
                } else if req_str.contains("/unknown-enc") {
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Encoding: x-custom-enc\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        raw_custom.len()
                    );
                    sock.write_all(head.as_bytes()).await.unwrap();
                    sock.write_all(raw_custom).await.unwrap();
                }
                let _ = sock.shutdown().await;
            });
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-head-ce-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("head-ce.sqlite")).unwrap());
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
        store,
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

    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{proxy_addr}")).unwrap())
        .build()
        .unwrap();

    // 1. HEAD preserves original Content-Length: 4096
    let head_resp = client
        .head(format!("http://{upstream_addr}/file.bin"))
        .send()
        .await
        .unwrap();
    assert_eq!(head_resp.status(), StatusCode::OK);
    assert_eq!(
        head_resp
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok()),
        Some("4096")
    );

    // 2. Multi-layer gzip, zstd -> both layers decoded, Content-Encoding removed
    let multi_resp = client
        .get(format!("http://{upstream_addr}/multi-gzip-zstd"))
        .send()
        .await
        .unwrap();
    assert!(multi_resp.headers().get("content-encoding").is_none());
    assert_eq!(multi_resp.text().await.unwrap(), plain_layered);

    // 3. Partial x-custom, zstd -> zstd peeled, x-custom preserved
    let partial_resp = client
        .get(format!("http://{upstream_addr}/partial-custom-zstd"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        partial_resp
            .headers()
            .get("content-encoding")
            .and_then(|v| v.to_str().ok()),
        Some("x-custom")
    );
    assert_eq!(partial_resp.bytes().await.unwrap().as_ref(), unknown_inner);

    // 4. Unknown Content-Encoding preserved verbatim with original bytes
    let unknown_resp = client
        .get(format!("http://{upstream_addr}/unknown-enc"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        unknown_resp
            .headers()
            .get("content-encoding")
            .and_then(|v| v.to_str().ok()),
        Some("x-custom-enc")
    );
    assert_eq!(unknown_resp.bytes().await.unwrap().as_ref(), raw_custom);

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

#[tokio::test]
async fn collect_response_body_limited_and_http_handler_enforce_64mib_cap() {
    use crate::models::{ThrottleConfig, ThrottlePreset};
    use super::http_handler::{collect_response_body_limited, ResponseBodyReadError};

    // 1. Unit check on collect_response_body_limited (both unthrottled and throttled paths)
    let make_chunks = || {
        vec![
            Ok::<_, Infallible>(Frame::data(Bytes::from(vec![b'A'; 600]))),
            Ok(Frame::data(Bytes::from(vec![b'B'; 600]))),
        ]
    };
    let throttle = ThrottleEngine::new();
    let body_unthrottled = StreamBody::new(futures_util::stream::iter(make_chunks()));
    let err1 = collect_response_body_limited(body_unthrottled, &throttle, 1024)
        .await
        .unwrap_err();
    assert!(matches!(
        err1,
        ResponseBodyReadError::PayloadTooLarge { limit: 1024, .. }
    ));

    throttle.set_config(ThrottleConfig {
        preset: ThrottlePreset::Custom,
        download_kbps: 1_000_000,
        upload_kbps: 1_000_000,
        latency_ms: 0,
    });
    let body_throttled = StreamBody::new(futures_util::stream::iter(make_chunks()));
    let err2 = collect_response_body_limited(body_throttled, &throttle, 1024)
        .await
        .unwrap_err();
    assert!(matches!(
        err2,
        ResponseBodyReadError::PayloadTooLarge { limit: 1024, .. }
    ));

    // 2. Full proxy HTTP chunked response exceeding MAX_BUFFERED_RESPONSE_BODY_BYTES (64 MiB) returns 502 cleanly
    static CHUNK_64K: [u8; 64 * 1024] = [b'Z'; 64 * 1024];
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();
    tokio::spawn(async move {
        if let Ok((stream, _)) = upstream_listener.accept().await {
            let io = TokioIo::new(stream);
            let svc = service_fn(|_req: Request<Incoming>| async move {
                let s = futures_util::stream::iter((0..1026).map(|_| {
                    Ok::<_, Infallible>(Frame::data(Bytes::from_static(&CHUNK_64K)))
                }));
                Ok::<_, Infallible>(
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(CONTENT_TYPE, "application/json")
                        .body(StreamBody::new(s))
                        .unwrap(),
                )
            });
            let _ = AutoConnBuilder::new(TokioExecutor::new())
                .serve_connection(io, svc)
                .await;
        }
    });

    let tmp_dir = std::env::temp_dir().join(format!(
        "fluxproxy-test-oom-cap-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).unwrap();

    let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
    let rules = Arc::new(RuleEngine::new());
    // Stage 44 BUG-05 spills unhooked chunked responses >2 MiB to streaming; attach an
    // OverrideStatus rule so this test exercises the 64 MiB buffered OOM cap path.
    rules.set_rules(vec![crate::models::AutoResponderRule {
        id: "oom-cap-buffered".into(),
        enabled: true,
        name: "Require Buffered Mode for 64 MiB Cap".into(),
        match_target: crate::models::RuleMatchTarget::UrlContains,
        pattern: "/huge-chunked".into(),
        method_filter: None,
        header_name: None,
        action: RuleActionType::OverrideStatus,
        status_code: 201,
        latency_ms: 0,
        response_headers: Vec::new(),
        response_body: String::new(),
    }]);
    let filters = Arc::new(ProxyFilterEngine::new());
    let breakpoints = Arc::new(BreakpointEngine::new(None));
    let store = Arc::new(TrafficStore::new(tmp_dir.join("oom-cap.sqlite")).unwrap());
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
        .get(format!("http://{upstream_addr}/huge-chunked"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    let err_body = resp.text().await.unwrap();
    assert!(err_body.contains("exceeds maximum buffered limit"));

    let _ = std::fs::remove_dir_all(&tmp_dir);
}

