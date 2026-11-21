use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::Bytes;
use chrono::Utc;
use http::{Method, Request, Response, StatusCode};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as AutoConnBuilder;
use tokio::net::TcpStream;
use tokio_rustls::TlsAcceptor;

use crate::models::{HeaderPair, SessionDetail, SessionSummary};
use crate::proxy::filters::{ConnectTunnelDecision, PassthroughReason};
use crate::proxy::network::normalize_client_ip;
use crate::proxy::process::ClientProcessInfo;

use super::http_handler::handle_intercepted_request;
use super::mobile_portal::{is_builtin_portal_target, is_virtual_portal_domain};
use super::{
    boxed_full, extract_hyper_headers, is_loopback_ip, is_loopback_or_unspecified_host,
    plain_response, record_and_return_error, record_completed_session, split_authority,
    ProxyBoxBody, SharedProxyContext,
};

/// Entry handler for outer proxy TCP connections:
/// - `Method::CONNECT`: Either relays raw encrypted bytes directly via `tokio::io::copy_bidirectional`
///   when matched by the TLS/MITM Bypass list (Certificate Pinning passthrough), or negotiates an
///   on-the-fly MITM TLS tunnel (HTTP/2 + HTTP/1.1 + WSS).
/// - Plain HTTP / WS: Directly intercepts and forwards.
pub(super) async fn handle_outer_proxy_request(
    req: Request<Incoming>,
    client_addr: SocketAddr,
    client_proc: Option<ClientProcessInfo>,
    ctx: Arc<SharedProxyContext>,
) -> Response<ProxyBoxBody> {
    if req.method() == Method::CONNECT {
        let authority = match req.uri().authority() {
            Some(auth) => auth.to_string(),
            None => {
                return plain_response(
                    StatusCode::BAD_REQUEST,
                    "CONNECT request missing authority host:port",
                );
            }
        };

        let (host, port) = split_authority(&authority);
        let is_remote_peer = !is_loopback_ip(client_addr.ip());
        if is_remote_peer && is_loopback_or_unspecified_host(&host) {
            return plain_response(
                StatusCode::FORBIDDEN,
                "Forbidden: remote LAN clients cannot open CONNECT tunnels to loopback or unspecified hosts",
            );
        }

        let active_port = ctx.active_port.load(Ordering::Relaxed);
        let is_portal_connect = is_builtin_portal_target(&authority, false, active_port);
        if is_portal_connect && !is_virtual_portal_domain(&host) {
            return plain_response(
                StatusCode::FORBIDDEN,
                "Forbidden: CONNECT tunnel to the proxy listener itself is not permitted",
            );
        }

        // Selective MITM Pass-Through:
        // - Mode 1 (`InterceptAll`): passthrough if matched by `tls_bypass_rules`
        // - Mode 2 (`TargetedOnly`): pure TCP passthrough (`copy_bidirectional`) for EVERYTHING except `tls_target_rules`
        if !is_portal_connect {
            if let ConnectTunnelDecision::Passthrough(reason) =
                ctx.filters.evaluate_connect_tunnel(&host, port)
            {
            let start = Instant::now();
            let timestamp = Utc::now().to_rfc3339();
            let session_id = ctx.store.allocate_id();
            let connect_headers = extract_hyper_headers(req.headers());
            let target_url = format!("https://{authority}/");
            let tunnel_path = format!("Tunnel to {host}:{port}");

            let mut upstream_tcp = match TcpStream::connect((host.as_str(), port)).await {
                Ok(stream) => stream,
                Err(err) => {
                    return record_and_return_error(
                        &ctx,
                        session_id,
                        "https",
                        "CONNECT",
                        &host,
                        &tunnel_path,
                        &target_url,
                        connect_headers,
                        Bytes::new(),
                        start,
                        timestamp,
                        client_addr,
                        client_proc.as_ref(),
                        true,
                        false,
                        format!("TLS Passthrough TCP connect failed for {host}:{port}: {err}"),
                    );
                }
            };

            let (protocol_label, passthrough_note, mode_header_val, tls_version_label) =
                match &reason {
                    PassthroughReason::BypassRule(bypass_rule) => (
                        "TLS-BYPASS".to_string(),
                        format!(
                            "[TLS / MITM Passthrough Tunnel Active]\n\
                             Host: {host}:{port}\n\
                             Matched Bypass Rule: {} ({})\n\
                             Relay Mode: Direct TCP tunnel via tokio::io::copy_bidirectional (no certificate replacement / pinning preserved).",
                            bypass_rule.pattern, bypass_rule.description
                        ),
                        format!("Passthrough ({})", bypass_rule.pattern),
                        format!("SSL Passthrough ({})", bypass_rule.category),
                    ),
                    PassthroughReason::NotInTargetAllowlist => (
                        "PASSTHROUGH".to_string(),
                        format!(
                            "[Selective MITM Pass-Through Tunnel Active]\n\
                             Host: {host}:{port}\n\
                             Mode: Targeted Only (Inspect Allowlist Only)\n\
                             Reason: Host is outside Target Allowlist — relayed as pure encrypted TCP stream via tokio::io::copy_bidirectional (zero CA substitution, mTLS & Certificate Pinning intact)."
                        ),
                        "Passthrough (Targeted-Only Allowlist Mode)".to_string(),
                        "Pure TCP Passthrough (Targeted-Only)".to_string(),
                    ),
                    PassthroughReason::NotInHostsWhitelist => (
                        "PASSTHROUGH".to_string(),
                        format!(
                            "[Hosts List Whitelist Pass-Through Active]\n\
                             Host: {host}:{port}\n\
                             Mode: Bulk Hosts List — Show only (Whitelist) + TLS Passthrough\n\
                             Reason: Host is not matched by Hosts List Whitelist — relayed as pure encrypted TCP stream via tokio::io::copy_bidirectional."
                        ),
                        "Passthrough (Hosts List Whitelist)".to_string(),
                        "Pure TCP Passthrough (Hosts List Whitelist)".to_string(),
                    ),
                };

            let summary = SessionSummary {
                id: session_id,
                status: 200,
                protocol: protocol_label,
                scheme: "https".into(),
                method: "CONNECT".into(),
                host: host.clone(),
                path: tunnel_path,
                url: target_url,
                content_type: "tls/passthrough".into(),
                body_size: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                timestamp,
                is_mocked: false,
                matched_rule_id: None,
                error: None,
                process_name: client_proc.as_ref().map(|p| p.name.clone()),
                process_pid: client_proc.as_ref().map(|p| p.pid),
                tls_bypassed: true,
                headers_mutated: false,
                breakpoint_paused: None,
                breakpoint_modified: false,
                comment: None,
                marked_color: None,
                client_ip: Some(normalize_client_ip(client_addr)),
            };

            let detail = SessionDetail {
                summary: summary.clone(),
                request_headers: connect_headers,
                response_headers: vec![HeaderPair {
                    name: "X-FluxProxy-TLS-Mode".into(),
                    value: mode_header_val,
                }],
                request_body_base64: String::new(),
                response_body_base64: base64::engine::general_purpose::STANDARD
                    .encode(passthrough_note.as_bytes()),
                request_body_text: None,
                response_body_text: Some(passthrough_note),
                tls_version: Some(tls_version_label),
                client_addr: client_addr.to_string(),
                websocket_frames: Vec::new(),
                sse_events: Vec::new(),
                body_offloaded: false,
                request_body_offloaded: false,
            };

            record_completed_session(&ctx, detail, None, None);

            tokio::spawn(async move {
                match hyper::upgrade::on(req).await {
                    Ok(upgraded) => {
                        let mut client_io = TokioIo::new(upgraded);
                        match tokio::io::copy_bidirectional(&mut client_io, &mut upstream_tcp).await
                        {
                            Ok((tx_bytes, rx_bytes)) => {
                                if let Some(mut existing) = ctx.store.get(session_id) {
                                    existing.summary.body_size =
                                        (tx_bytes.saturating_add(rx_bytes)) as usize;
                                    existing.summary.duration_ms =
                                        start.elapsed().as_millis() as u64;
                                    let updated_summary = existing.summary.clone();
                                    ctx.store.insert(existing);
                                    let _ = ctx.event_tx.send(updated_summary);
                                }
                            }
                            Err(err) => {
                                tracing::debug!("TLS passthrough tunnel closed for {host}: {err}");
                            }
                        }
                    }
                    Err(err) => {
                        tracing::debug!("HTTP CONNECT passthrough upgrade error: {err}");
                    }
                }
            });

            return Response::builder()
                .status(StatusCode::OK)
                .body(boxed_full(Bytes::new()))
                .unwrap();
            }
        }

        let mut filter_updates_rx = ctx.filters.subscribe_config_updates();

        tokio::spawn(async move {
            match hyper::upgrade::on(req).await {
                Ok(upgraded) => {
                    let server_cfg = match ctx.ca.server_config_for_host(&host) {
                        Ok(cfg) => cfg,
                        Err(err) => {
                            tracing::error!("Failed to generate MITM cert for {host}: {err}");
                            return;
                        }
                    };

                    let acceptor = TlsAcceptor::from(server_cfg);
                    let tls_stream = match acceptor.accept(TokioIo::new(upgraded)).await {
                        Ok(s) => s,
                        Err(err) => {
                            tracing::debug!("Client TLS handshake aborted for {host}: {err}");
                            return;
                        }
                    };

                    if let ConnectTunnelDecision::Passthrough(reason) =
                        ctx.filters.evaluate_connect_tunnel(&host, port)
                    {
                        tracing::info!(
                            "Closing newly negotiated MITM tunnel for {}:{} after filter switch to Passthrough ({:?})",
                            host,
                            port,
                            reason
                        );
                        return;
                    }

                    let negotiated_alpn = tls_stream
                        .get_ref()
                        .1
                        .alpn_protocol()
                        .map(|p| String::from_utf8_lossy(p).to_string())
                        .unwrap_or_else(|| "http/1.1".to_string());

                    let inner_io = TokioIo::new(tls_stream);
                    let authority_host = if host.contains(':') {
                        if port == 443 {
                            format!("[{host}]")
                        } else {
                            format!("[{host}]:{port}")
                        }
                    } else if port == 443 {
                        host.clone()
                    } else {
                        format!("{host}:{port}")
                    };
                    let conn_ctx = ctx.clone();
                    let mitm_host = host.clone();

                    let service = service_fn(move |inner_req: Request<Incoming>| {
                        let req_ctx = ctx.clone();
                        let default_host = authority_host.clone();
                        let alpn = negotiated_alpn.clone();
                        let proc_info = client_proc.clone();
                        async move {
                            Ok::<_, Infallible>(
                                handle_intercepted_request(
                                    inner_req,
                                    "https",
                                    Some(&default_host),
                                    Some(&alpn),
                                    client_addr,
                                    proc_info,
                                    req_ctx,
                                )
                                .await,
                            )
                        }
                    });

                    let auto_builder = AutoConnBuilder::new(TokioExecutor::new());
                    let conn = auto_builder.serve_connection_with_upgrades(inner_io, service);
                    tokio::pin!(conn);

                    loop {
                        tokio::select! {
                            res = conn.as_mut() => {
                                let _ = res;
                                break;
                            }
                            changed = filter_updates_rx.changed() => {
                                if changed.is_err() {
                                    let _ = conn.as_mut().await;
                                    break;
                                }
                                if let ConnectTunnelDecision::Passthrough(reason) =
                                    conn_ctx.filters.evaluate_connect_tunnel(&mitm_host, port)
                                {
                                    tracing::info!(
                                        "Gracefully shutting down active MITM tunnel for {}:{} after filter switch to Passthrough ({:?})",
                                        mitm_host,
                                        port,
                                        reason
                                    );
                                    conn.as_mut().graceful_shutdown();
                                    let _ = tokio::time::timeout(
                                        Duration::from_secs(2),
                                        conn.as_mut(),
                                    )
                                    .await;
                                    break;
                                }
                            }
                        }
                    }
                }
                Err(err) => {
                    tracing::debug!("HTTP CONNECT upgrade error: {err}");
                }
            }
        });

        // Acknowledge tunnel establishment so the client begins TLS ClientHello
        return Response::builder()
            .status(StatusCode::OK)
            .body(boxed_full(Bytes::new()))
            .unwrap();
    }

    handle_intercepted_request(req, "http", None, None, client_addr, client_proc, ctx).await
}
