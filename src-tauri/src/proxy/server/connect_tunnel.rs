use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

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

use crate::models::{
    HeaderPair, SessionDetail, SessionSummary, SessionTimings, SessionTransferStats,
    UpstreamProxyProtocol,
};
use crate::proxy::filters::{ConnectTunnelDecision, PassthroughReason};
use crate::proxy::hosts::HostRemapRegistry;
use crate::proxy::network::normalize_client_ip;
use crate::proxy::process::ClientProcessInfo;
use crate::proxy::throttle::ThrottledStream;
use crate::proxy::upstream_client::{
    duration_ms_f64, elapsed_ms, estimate_request_headers_bytes, estimate_response_headers_bytes,
    format_rfc3339_micros, format_tls_cipher, format_tls_protocol, timestamp_at_instant,
};
use crate::proxy::upstream_proxy::{
    connect_tunnel_via_upstream, format_via_proxy_telemetry, UpstreamTransportStream,
};

use super::http_handler::handle_intercepted_request;
use super::mobile_portal::{is_builtin_portal_target, is_virtual_portal_domain};
use super::{
    boxed_full, extract_hyper_headers, format_raw_http_version, is_loopback_ip,
    is_loopback_or_unspecified_host, plain_response, record_and_return_error_with_opts,
    record_completed_session, split_authority, validate_resolved_addrs_for_peer, ClientConnContext,
    ProxyBoxBody, SharedProxyContext, FLUXPROXY_ERR_FORBIDDEN_REMOTE_TARGET,
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
    client_conn: ClientConnContext,
    ctx: Arc<SharedProxyContext>,
) -> Response<ProxyBoxBody> {
    if !ctx.filters.is_lan_client_allowed(client_addr.ip()) {
        return plain_response(
            StatusCode::FORBIDDEN,
            "Forbidden: client IP is not in the LAN Client Allowlist",
        );
    }

    if client_conn.is_draining_or_aborted() {
        return plain_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Service Unavailable: FluxProxy is stopping",
        );
    }

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

        // Selective MITM Pass-Through & Offline Throttling:
        // - Mode 1 (`InterceptAll`): passthrough if matched by `tls_bypass_rules`
        // - Mode 2 (`TargetedOnly`): pure TCP passthrough (`copy_bidirectional`) for EVERYTHING except `tls_target_rules`
        if !is_portal_connect {
            if ctx.throttle.is_offline() {
                let start = Instant::now();
                let timestamp = Utc::now().to_rfc3339();
                let session_id = ctx.store.allocate_id();
                let connect_headers = extract_hyper_headers(req.headers());
                let target_url = format!("https://{authority}/");
                let tunnel_path = format!("Tunnel to {host}:{port}");
                return record_and_return_error_with_opts(
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
                    false,
                    false,
                    StatusCode::SERVICE_UNAVAILABLE,
                    None,
                    "Network Offline (Bandwidth Throttling: Offline)".to_string(),
                );
            }

            if let ConnectTunnelDecision::Passthrough(reason) =
                ctx.filters.evaluate_connect_tunnel(&host, port)
            {
            let start = Instant::now();
            let start_utc = Utc::now();
            let timestamp = start_utc.to_rfc3339();
            let req_begin_at = format_rfc3339_micros(start_utc);
            let session_id = ctx.store.allocate_id();
            let connect_headers = extract_hyper_headers(req.headers());
            let client_http_ver = format_raw_http_version(req.version()).to_string();
            let req_headers_bytes =
                estimate_request_headers_bytes("CONNECT", &authority, &client_http_ver, &connect_headers);
            let (client_reused, _) = client_conn.claim_request_seq();
            let target_url = format!("https://{authority}/");
            let tunnel_path = format!("Tunnel to {host}:{port}");

            let remapped_connect = ctx.host_remap.resolve_connect_target(&host, port);
            let (connect_host, connect_port, remapped_to) = match &remapped_connect {
                Some((target_host, target_port, rule)) => {
                    if is_remote_peer && is_loopback_or_unspecified_host(target_host) {
                        return super::record_and_return_error_with_opts_and_code(
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
                            StatusCode::FORBIDDEN,
                            None,
                            format!(
                                "Forbidden: remote LAN clients cannot open CONNECT tunnels via HOSTS Remapping to loopback or unspecified host '{target_host}'"
                            ),
                            Some(FLUXPROXY_ERR_FORBIDDEN_REMOTE_TARGET),
                        );
                    }
                    (
                        target_host.clone(),
                        *target_port,
                        Some(HostRemapRegistry::format_remap_target(rule, rule.target_port)),
                    )
                }
                None => (host.clone(), port, None),
            };

            if let Err(err) = ctx.throttle.apply_latency().await {
                return record_and_return_error_with_opts(
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
                    StatusCode::SERVICE_UNAVAILABLE,
                    remapped_to,
                    err.to_string(),
                );
            }

            let active_upstream_proxy = ctx.upstream_proxy.resolve_for_target(
                &host,
                port,
                remapped_connect.as_ref().map(|_| connect_host.as_str()),
                remapped_connect.as_ref().map(|_| connect_port),
            );

            let connect_timeout = ctx.connect_timeout();
            let connect_deadline = Instant::now() + connect_timeout;

            let (
                upstream_tcp,
                dns_ms,
                tcp_connect_ms,
                upstream_proxy_label,
                upstream_proxy_telemetry,
            ): (
                UpstreamTransportStream,
                f64,
                f64,
                Option<String>,
                Option<(String, String)>,
            ) = if let Some(proxy_cfg) = active_upstream_proxy {
                let tunnel_res = match connect_tunnel_via_upstream(
                    &proxy_cfg,
                    &connect_host,
                    connect_port,
                    connect_timeout,
                )
                .await
                {
                    Ok(res) => res,
                    Err(err_msg) => {
                        let proxy_err_code = if err_msg.to_ascii_lowercase().contains("timed out") {
                            super::FLUXPROXY_ERR_UPSTREAM_CONNECT_TIMEOUT
                        } else {
                            super::FLUXPROXY_ERR_UPSTREAM_CONNECT_ERROR
                        };
                        return super::record_and_return_error_with_opts_and_code(
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
                            StatusCode::BAD_GATEWAY,
                            remapped_to,
                            format!(
                                "TLS Passthrough upstream proxy connect failed for {connect_host}:{connect_port}: {err_msg}"
                            ),
                            Some(proxy_err_code),
                        );
                    }
                };
                let proto_label = match proxy_cfg.protocol {
                    UpstreamProxyProtocol::Http => "http",
                    UpstreamProxyProtocol::Https => "https",
                    UpstreamProxyProtocol::Socks5 => "socks5",
                };
                let label = format!("{proto_label}://{}:{}", proxy_cfg.host, proxy_cfg.port);
                let via_telemetry =
                    format_via_proxy_telemetry(proxy_cfg.protocol, tunnel_res.proxy_addr);
                (
                    tunnel_res.stream,
                    tunnel_res.dns_ms,
                    tunnel_res.tcp_connect_ms,
                    Some(label),
                    Some(via_telemetry),
                )
            } else {
                let connect_host_clean = connect_host.trim_matches(['[', ']']);
                let (resolved_addrs, dns_ms): (Vec<SocketAddr>, f64) =
                    if let Ok(ip) = connect_host_clean.parse::<IpAddr>() {
                        (vec![SocketAddr::new(ip, connect_port)], 0.0)
                    } else {
                        let dns_rem = connect_deadline.saturating_duration_since(Instant::now());
                        if dns_rem.is_zero() {
                            return super::record_and_return_error_with_opts_and_code(
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
                                StatusCode::BAD_GATEWAY,
                                remapped_to,
                                format!(
                                    "TLS Passthrough DNS lookup timed out after {} s for {connect_host}:{connect_port}",
                                    connect_timeout.as_secs()
                                ),
                                Some(super::FLUXPROXY_ERR_UPSTREAM_CONNECT_TIMEOUT),
                            );
                        }
                        let dns_start = Instant::now();
                        match tokio::time::timeout(
                            dns_rem,
                            tokio::net::lookup_host((connect_host_clean, connect_port)),
                        )
                        .await
                        {
                            Ok(Ok(iter)) => (iter.collect(), elapsed_ms(dns_start)),
                            Ok(Err(err)) => {
                                return super::record_and_return_error_with_opts_and_code(
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
                                    StatusCode::BAD_GATEWAY,
                                    remapped_to,
                                    format!(
                                        "TLS Passthrough DNS lookup failed for {connect_host}:{connect_port}: {err}"
                                    ),
                                    Some(super::FLUXPROXY_ERR_UPSTREAM_CONNECT_ERROR),
                                );
                            }
                            Err(_) => {
                                return super::record_and_return_error_with_opts_and_code(
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
                                    StatusCode::BAD_GATEWAY,
                                    remapped_to,
                                    format!(
                                        "TLS Passthrough DNS lookup timed out after {} s for {connect_host}:{connect_port}",
                                        connect_timeout.as_secs()
                                    ),
                                    Some(super::FLUXPROXY_ERR_UPSTREAM_CONNECT_TIMEOUT),
                                );
                            }
                        }
                    };

                if let Err(err_msg) = validate_resolved_addrs_for_peer(
                    &resolved_addrs,
                    is_remote_peer,
                    &format!("{connect_host}:{connect_port}"),
                ) {
                    return super::record_and_return_error_with_opts_and_code(
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
                        StatusCode::FORBIDDEN,
                        remapped_to,
                        err_msg,
                        Some(FLUXPROXY_ERR_FORBIDDEN_REMOTE_TARGET),
                    );
                }

                let tcp_start = Instant::now();
                let mut upstream_tcp_opt = None;
                let mut last_tcp_err: Option<String> = None;
                let mut tcp_timed_out = false;
                for addr in resolved_addrs {
                    let remaining = connect_deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        tcp_timed_out = true;
                        last_tcp_err = Some(format!(
                            "timed out after {} s connect deadline",
                            connect_timeout.as_secs()
                        ));
                        break;
                    }
                    match tokio::time::timeout(remaining, TcpStream::connect(addr)).await {
                        Ok(Ok(stream)) => {
                            let _ = stream.set_nodelay(true);
                            upstream_tcp_opt = Some(stream);
                            break;
                        }
                        Ok(Err(err)) => last_tcp_err = Some(format!("{addr}: {err}")),
                        Err(_) => {
                            tcp_timed_out = true;
                            last_tcp_err = Some(format!(
                                "{addr}: timed out after {} s connect deadline",
                                connect_timeout.as_secs()
                            ));
                        }
                    }
                }
                let tcp_stream = match upstream_tcp_opt {
                    Some(stream) => stream,
                    None => {
                        let err_detail = last_tcp_err
                            .unwrap_or_else(|| "no reachable address".to_string());
                        let proxy_err_code = if tcp_timed_out {
                            super::FLUXPROXY_ERR_UPSTREAM_CONNECT_TIMEOUT
                        } else {
                            super::FLUXPROXY_ERR_UPSTREAM_CONNECT_ERROR
                        };
                        return super::record_and_return_error_with_opts_and_code(
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
                            StatusCode::BAD_GATEWAY,
                            remapped_to,
                            format!(
                                "TLS Passthrough TCP connect failed for {connect_host}:{connect_port}: {err_detail}"
                            ),
                            Some(proxy_err_code),
                        );
                    }
                };
                (
                    UpstreamTransportStream::Tcp(tcp_stream),
                    dns_ms,
                    elapsed_ms(tcp_start),
                    None,
                    None,
                )
            };
            let tunnel_start_instant = Instant::now();
            let server_connected_at = timestamp_at_instant(start, start_utc, tunnel_start_instant);
            let server_sock = upstream_tcp.peer_addr().ok();

            let (protocol_label, mut passthrough_note, mode_header_val, tls_version_label) =
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

            let mut resp_headers = vec![HeaderPair::new("X-FluxProxy-TLS-Mode", mode_header_val)];
            if let Some(ref target_label) = remapped_to {
                passthrough_note.push_str(&format!(
                    "\nHOSTS Remapped Target: {connect_host}:{connect_port} (label: {target_label})"
                ));
                resp_headers.push(HeaderPair::new(
                    "X-FluxProxy-Host-Remap",
                    format!("{connect_host}:{connect_port}"),
                ));
            }
            if let Some(ref proxy_label) = upstream_proxy_label {
                passthrough_note.push_str(&format!("\nUpstream Proxy: {proxy_label}"));
                resp_headers.push(HeaderPair::new(
                    "X-FluxProxy-Upstream-Proxy",
                    proxy_label.clone(),
                ));
            }

            let resp_headers_bytes =
                estimate_response_headers_bytes(200, "HTTP/1.1", &resp_headers);
            let initial_overall = elapsed_ms(start);
            let initial_timings = SessionTimings {
                client_connected: Some(client_conn.connected_at.clone()),
                client_begin_request: Some(req_begin_at.clone()),
                got_request_headers: Some(req_begin_at.clone()),
                client_done_request: Some(req_begin_at.clone()),
                proxy_begin_request: Some(req_begin_at),
                server_connected: Some(server_connected_at.clone()),
                server_got_request: Some(server_connected_at.clone()),
                client_begin_response: Some(server_connected_at),
                dns_ms: Some(dns_ms),
                tcp_connect_ms: Some(tcp_connect_ms),
                overall_elapsed_ms: Some(initial_overall),
                net_elapsed_ms: Some(initial_overall),
                ..Default::default()
            };
            let (server_addr, server_ip, server_port, via_proxy_addr) =
                match upstream_proxy_telemetry {
                    Some((via_addr, via_ip)) => (None, Some(via_ip), None, Some(via_addr)),
                    None => (
                        server_sock.map(|a| a.to_string()),
                        server_sock.map(|a| a.ip().to_string()),
                        server_sock.map(|a| a.port()),
                        None,
                    ),
                };
            let initial_stats = SessionTransferStats {
                request_headers_bytes: Some(req_headers_bytes),
                request_body_bytes: Some(0),
                request_wire_body_bytes: Some(0),
                response_headers_bytes: Some(resp_headers_bytes),
                response_body_bytes: Some(0),
                response_wire_body_bytes: Some(0),
                client_conn_id: Some(client_conn.conn_id),
                client_conn_reused: Some(client_reused),
                client_http_version: Some(client_http_ver),
                server_addr,
                server_ip,
                server_port,
                server_conn_reused: Some(false),
                remapped_target: remapped_to.clone(),
                via_proxy_addr,
                is_streaming: Some(true),
                ..Default::default()
            };

            let mut summary = SessionSummary {
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
                remapped_to,
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
            summary.apply_telemetry(Some(&initial_timings), Some(&initial_stats));

            let detail = SessionDetail {
                summary: summary.clone(),
                request_headers: connect_headers,
                response_headers: resp_headers,
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
                timings: Some(initial_timings),
                transfer_stats: Some(initial_stats),
            };

            if !client_conn.is_capture_suppressed() {
                record_completed_session(&ctx, detail, None, None);
            }

            let tunnel_lifecycle = client_conn.lifecycle.clone();
            tokio::spawn(tunnel_passthrough_bidirectional(
                req,
                upstream_tcp,
                host,
                port,
                client_addr,
                session_id,
                start,
                start_utc,
                tunnel_start_instant,
                tunnel_lifecycle,
                ctx,
            ));

            return Response::builder()
                .status(StatusCode::OK)
                .body(boxed_full(Bytes::new()))
                .unwrap();
            }
        }

        tokio::spawn(serve_mitm_tls_connection(
            req,
            host,
            port,
            client_addr,
            client_proc,
            client_conn,
            ctx,
        ));

        // Acknowledge tunnel establishment so the client begins TLS ClientHello
        return Response::builder()
            .status(StatusCode::OK)
            .body(boxed_full(Bytes::new()))
            .unwrap();
    }

    handle_intercepted_request(req, "http", None, None, client_addr, client_proc, client_conn, ctx)
        .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn tunnel_passthrough_bidirectional(
    req: Request<Incoming>,
    upstream_tcp: UpstreamTransportStream,
    host: String,
    port: u16,
    client_addr: SocketAddr,
    session_id: u64,
    start: Instant,
    start_utc: chrono::DateTime<Utc>,
    tunnel_start_instant: Instant,
    lifecycle: super::ConnectionLifecycle,
    ctx: Arc<SharedProxyContext>,
) {
    let mut abort_sig = lifecycle.clone();
    let mut drain_sig = lifecycle.clone();
    let mut upgrade_drain_sig = lifecycle.clone();
    let mut config_rx = ctx.filters.subscribe_config_updates();
    let mut config_closed = false;
    let mut drain_deadline: Option<tokio::time::Instant> = None;

    let upgraded = tokio::select! {
        biased;
        _ = abort_sig.wait_abort() => return,
        _ = upgrade_drain_sig.wait_drain_expired() => return,
        res = hyper::upgrade::on(req) => match res {
            Ok(upgraded) => upgraded,
            Err(err) => {
                tracing::debug!("HTTP CONNECT passthrough upgrade error: {err}");
                return;
            }
        }
    };

    let mut client_io = TokioIo::new(upgraded);
    let mut throttled_upstream =
        ThrottledStream::new_without_initial_delay(upstream_tcp, ctx.throttle.clone());
    let mut transfer_fut = std::pin::pin!(tokio::io::copy_bidirectional(
        &mut client_io,
        &mut throttled_upstream,
    ));

    loop {
        tokio::select! {
            biased;
            _ = abort_sig.wait_abort() => {
                tracing::info!("Hard-aborting passthrough tunnel for {}:{}", host, port);
                break;
            }
            changed = config_rx.changed(), if !config_closed => {
                if changed.is_err() {
                    config_closed = true;
                } else {
                    if !ctx.filters.is_lan_client_allowed(client_addr.ip()) {
                        tracing::info!(
                            "Hard-aborting active passthrough tunnel for {}:{} after LAN Client Allowlist excluded {}",
                            host,
                            port,
                            client_addr.ip()
                        );
                        break;
                    }
                    if matches!(
                        ctx.filters.evaluate_connect_tunnel(&host, port),
                        ConnectTunnelDecision::InterceptMitm
                    ) {
                        tracing::info!(
                            "Hard-aborting active passthrough tunnel for {}:{} after filter switch to MITM Intercept",
                            host,
                            port
                        );
                        break;
                    }
                }
            }
            deadline = drain_sig.wait_drain_started(), if drain_deadline.is_none() => {
                drain_deadline = Some(deadline);
            }
            _ = async {
                match drain_deadline {
                    Some(d) => tokio::time::sleep_until(d).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                tracing::info!(
                    "Graceful drain deadline expired for passthrough tunnel {}:{}",
                    host,
                    port
                );
                break;
            }
            res = transfer_fut.as_mut() => {
                match res {
                    Ok((tx_bytes, rx_bytes)) => {
                        if !lifecycle.is_capture_suppressed() {
                            let end_instant = Instant::now();
                            let done_at = timestamp_at_instant(start, start_utc, end_instant);
                            let overall_ms =
                                duration_ms_f64(end_instant.saturating_duration_since(start));
                            let transfer_ms = duration_ms_f64(
                                end_instant.saturating_duration_since(tunnel_start_instant),
                            );
                            if let Some(updated_summary) =
                                ctx.store.update_session_telemetry(session_id, |detail| {
                                    detail.summary.body_size =
                                        (tx_bytes.saturating_add(rx_bytes)) as usize;
                                    detail.summary.duration_ms =
                                        start.elapsed().as_millis() as u64;
                                    let timings =
                                        detail.timings.get_or_insert_with(Default::default);
                                    timings.server_done_response = Some(done_at.clone());
                                    timings.client_done_response = Some(done_at);
                                    timings.content_download_ms = Some(transfer_ms);
                                    timings.overall_elapsed_ms = Some(overall_ms);
                                    timings.net_elapsed_ms = Some(overall_ms);
                                    let stats = detail
                                        .transfer_stats
                                        .get_or_insert_with(Default::default);
                                    stats.request_wire_body_bytes = Some(tx_bytes as usize);
                                    stats.request_body_bytes = Some(tx_bytes as usize);
                                    stats.response_wire_body_bytes = Some(rx_bytes as usize);
                                    stats.response_body_bytes = Some(rx_bytes as usize);
                                    let timings_clone = detail.timings.clone();
                                    let stats_clone = detail.transfer_stats.clone();
                                    detail
                                        .summary
                                        .apply_telemetry(timings_clone.as_ref(), stats_clone.as_ref());
                                })
                            {
                                let _ = ctx.event_tx.send(updated_summary);
                            }
                        }
                    }
                    Err(err) => {
                        tracing::debug!("TLS passthrough tunnel closed for {host}: {err}");
                    }
                }
                break;
            }
        }
    }
}

async fn serve_mitm_tls_connection(
    req: Request<Incoming>,
    host: String,
    port: u16,
    client_addr: SocketAddr,
    client_proc: Option<ClientProcessInfo>,
    client_conn: ClientConnContext,
    ctx: Arc<SharedProxyContext>,
) {
    let mut filter_updates_rx = ctx.filters.subscribe_config_updates();
    let mut filter_closed = false;
    let mut abort_sig = client_conn.lifecycle.clone();
    let mut drain_sig = client_conn.lifecycle.clone();
    let mut upgrade_drain_sig = client_conn.lifecycle.clone();
    let mut tls_drain_sig = client_conn.lifecycle.clone();
    let mut drain_notified = false;
    let mut drain_deadline: Option<tokio::time::Instant> = None;

    let upgraded = tokio::select! {
        biased;
        _ = abort_sig.wait_abort() => return,
        _ = upgrade_drain_sig.wait_drain_expired() => return,
        res = hyper::upgrade::on(req) => match res {
            Ok(upgraded) => upgraded,
            Err(err) => {
                tracing::debug!("HTTP CONNECT upgrade error: {err}");
                return;
            }
        }
    };

    let server_cfg = match ctx.ca.server_config_for_host(&host) {
        Ok(cfg) => cfg,
        Err(err) => {
            tracing::error!("Failed to generate MITM cert for {host}: {err}");
            return;
        }
    };

    let tls_accept_start = Instant::now();
    let acceptor = TlsAcceptor::from(server_cfg);
    let tls_stream = tokio::select! {
        biased;
        _ = abort_sig.wait_abort() => return,
        _ = tls_drain_sig.wait_drain_expired() => return,
        res = acceptor.accept(TokioIo::new(upgraded)) => match res {
            Ok(s) => s,
            Err(err) => {
                tracing::debug!("Client TLS handshake aborted for {host}: {err}");
                return;
            }
        }
    };
    let client_tls_handshake_ms = elapsed_ms(tls_accept_start);

    if abort_sig.is_aborted() || !ctx.filters.is_lan_client_allowed(client_addr.ip()) {
        return;
    }

    if !is_virtual_portal_domain(&host) {
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
    }

    let client_tls_info = tls_stream.get_ref().1;
    let client_tls_version = client_tls_info
        .protocol_version()
        .map(format_tls_protocol);
    let client_tls_cipher = client_tls_info
        .negotiated_cipher_suite()
        .map(format_tls_cipher);
    let negotiated_alpn_opt = client_tls_info
        .alpn_protocol()
        .map(|p| String::from_utf8_lossy(p).to_string());
    let negotiated_alpn = negotiated_alpn_opt
        .clone()
        .unwrap_or_else(|| "http/1.1".to_string());
    let mitm_conn = client_conn.with_mitm_tls(
        client_tls_handshake_ms,
        client_tls_version,
        client_tls_cipher,
        negotiated_alpn_opt,
    );

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
        let inner_conn = mitm_conn.clone();
        async move {
            Ok::<_, Infallible>(
                handle_intercepted_request(
                    inner_req,
                    "https",
                    Some(&default_host),
                    Some(&alpn),
                    client_addr,
                    proc_info,
                    inner_conn,
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
            biased;
            _ = abort_sig.wait_abort() => {
                tracing::info!("Hard-aborting MITM tunnel for {}:{}", mitm_host, port);
                break;
            }
            res = conn.as_mut() => {
                let _ = res;
                break;
            }
            deadline = drain_sig.wait_drain_started(), if !drain_notified => {
                drain_notified = true;
                drain_deadline = Some(deadline);
                conn.as_mut().graceful_shutdown();
            }
            _ = async {
                match drain_deadline {
                    Some(d) => tokio::time::sleep_until(d).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                tracing::info!("Graceful drain deadline expired for MITM tunnel {}:{}", mitm_host, port);
                break;
            }
            changed = filter_updates_rx.changed(), if !filter_closed => {
                if changed.is_err() {
                    filter_closed = true;
                } else {
                    if !conn_ctx.filters.is_lan_client_allowed(client_addr.ip()) {
                        tracing::info!(
                            "Hard-aborting active MITM tunnel for {}:{} after LAN Client Allowlist update excluded {}",
                            mitm_host,
                            port,
                            client_addr.ip()
                        );
                        break;
                    }
                    if !is_virtual_portal_domain(&mitm_host) {
                        if let ConnectTunnelDecision::Passthrough(reason) =
                            conn_ctx.filters.evaluate_connect_tunnel(&mitm_host, port)
                        {
                            tracing::info!(
                                "Hard-aborting active MITM tunnel for {}:{} after filter switch to Passthrough ({:?})",
                                mitm_host,
                                port,
                                reason
                            );
                            break;
                        }
                    }
                }
            }
        }
    }
}
