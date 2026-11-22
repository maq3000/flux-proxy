use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::Bytes;
use chrono::Utc;
use http::StatusCode;
use http_body_util::BodyExt;

use crate::models::{
    BreakpointStage, ComposedRequest, HeaderMutationDirection, ProxyError, RuleActionType,
    SessionDetail, SessionSummary, SessionTimings, SessionTransferStats,
};
use crate::proxy::throttle::BandwidthPacer;
use crate::proxy::upstream_client::{
    duration_ms_f64, elapsed_ms, estimate_request_headers_bytes, estimate_response_headers_bytes,
    format_rfc3339_micros, round_ms, timestamp_at_instant,
};

use super::http_handler::{
    build_autoresponder_mock_detail, compute_timings_summary, format_error_chain, maybe_decompress_content_encodings, parse_sse_events_from_bytes,
    prepare_remapped_upstream_target, run_request_breakpoint_stage, run_response_breakpoint_stage,
    AutoResponderMockInput, RequestBreakpointStageInput, ResponseBreakpointStageInput,
};
use super::{
    encode_inline_or_offload, extract_hyper_headers, format_http_version, format_raw_http_version,
    record_completed_session, record_error_session_with_telemetry,
    record_in_flight_session_with_remap, ProxyEngineController, MAX_CAPTURED_BODY_BYTES,
};

impl ProxyEngineController {
    /// Executes a request crafted in the Composer tab and records it into the Traffic Viewer.
    pub async fn execute_composed(&self, composed: ComposedRequest) -> Result<SessionDetail, ProxyError> {
        let start = Instant::now();
        let start_utc = Utc::now();
        let timestamp = start_utc.to_rfc3339();
        let req_begin_at = format_rfc3339_micros(start_utc);
        let session_id = self.context.store.allocate_id();
        let self_pid = std::process::id();

        let mut method_str = composed.method;
        let mut full_url = composed.url;
        let mut req_headers = composed.headers;
        let mut req_bytes = match composed
            .body_base64
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(b64) => base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| ProxyError::Custom(format!("Invalid request bodyBase64: {e}")))?,
            None => composed.body.into_bytes(),
        };
        let mut bp_modified = false;
        let mut total_bp_pause_ms = 0.0_f64;
        let mut autoresponder_delay_ms = 0.0_f64;

        let parsed_initial = url::Url::parse(&full_url)
            .map_err(|e| ProxyError::Custom(format!("Invalid URL '{full_url}': {e}")))?;
        let mut scheme = parsed_initial.scheme().to_string();
        let mut host = parsed_initial.host_str().unwrap_or("unknown").to_string();
        let mut path = match parsed_initial.query() {
            Some(q) => format!("{}?{}", parsed_initial.path(), q),
            None => parsed_initial.path().to_string(),
        };

        let req_mutated = self.context.filters.apply_header_mutations(
            HeaderMutationDirection::Request,
            &full_url,
            &mut req_headers,
        );
        let mut req_headers_bytes =
            estimate_request_headers_bytes(&method_str, &path, "HTTP/1.1", &req_headers);

        // Live Breakpoint: Before Request (F11 / `bpu`)
        if self
            .context
            .breakpoints
            .should_break(BreakpointStage::Request, &method_str, &full_url)
        {
            let bp_input = RequestBreakpointStageInput {
                session_id,
                protocol: if scheme == "https" {
                    "HTTPS/2".into()
                } else {
                    "HTTP/1.1".into()
                },
                timestamp: timestamp.clone(),
                start,
                process_name: Some("flux-proxy (Composer)".into()),
                process_pid: Some(self_pid),
                client_ip: Some("127.0.0.1".into()),
                client_addr: "Composer (Local)".into(),
                tls_version: None,
                summary_body_size: 0,
                req_mutated,
            };
            let bp_start = Instant::now();
            let bp_res = run_request_breakpoint_stage(
                &self.context,
                bp_input,
                &mut method_str,
                &mut full_url,
                &mut scheme,
                &mut host,
                &mut path,
                &mut req_headers,
                &mut req_bytes,
                &mut bp_modified,
            )
            .await;
            total_bp_pause_ms += elapsed_ms(bp_start);
            if bp_res.is_err() {
                let proto = if scheme == "https" {
                    "HTTPS/2".to_string()
                } else {
                    "HTTP/1.1".to_string()
                };
                let msg = "Request aborted at Live Breakpoint";
                let mut err_timings = SessionTimings {
                    client_begin_request: Some(req_begin_at.clone()),
                    got_request_headers: Some(req_begin_at.clone()),
                    client_done_request: Some(req_begin_at),
                    breakpoint_pause_ms: (total_bp_pause_ms > 0.0)
                        .then(|| round_ms(total_bp_pause_ms)),
                    ..Default::default()
                };
                compute_timings_summary(&mut err_timings, elapsed_ms(start));
                let err_stats = SessionTransferStats {
                    request_headers_bytes: Some(req_headers_bytes),
                    request_body_bytes: Some(req_bytes.len()),
                    request_wire_body_bytes: Some(req_bytes.len()),
                    response_body_bytes: Some(msg.len()),
                    response_wire_body_bytes: Some(msg.len()),
                    ..Default::default()
                };
                record_error_session_with_telemetry(
                    &self.context,
                    session_id,
                    proto,
                    &scheme,
                    &method_str,
                    &host,
                    &path,
                    &full_url,
                    req_headers,
                    &req_bytes,
                    start.elapsed().as_millis() as u64,
                    timestamp,
                    Some("flux-proxy (Composer)".into()),
                    Some(self_pid),
                    false,
                    req_mutated,
                    true,
                    Some("127.0.0.1".into()),
                    "Composer (Local)".into(),
                    502,
                    None,
                    Some(err_timings),
                    Some(err_stats),
                    msg,
                );
                return Err(ProxyError::Custom(msg.into()));
            }
            req_headers_bytes =
                estimate_request_headers_bytes(&method_str, &path, "HTTP/1.1", &req_headers);
        }

        let parsed_url = url::Url::parse(&full_url)
            .map_err(|e| ProxyError::Custom(format!("Invalid URL '{full_url}': {e}")))?;
        let method = http::Method::from_bytes(method_str.as_bytes())
            .map_err(|e| ProxyError::Custom(format!("Invalid HTTP method: {e}")))?;

        // Check AutoResponder rules for composed requests too
        if let Some(rule) =
            self.context
                .rules
                .find_matching_rule(&method_str, &full_url, &req_headers)
        {
            if rule.latency_ms > 0 {
                let delay_t = Instant::now();
                tokio::time::sleep(Duration::from_millis(rule.latency_ms)).await;
                autoresponder_delay_ms = elapsed_ms(delay_t);
            }
            if matches!(rule.action, RuleActionType::MockResponse) {
                let (mut detail, mock_resp_headers, mock_bytes) = build_autoresponder_mock_detail(
                    &self.context,
                    AutoResponderMockInput {
                        session_id,
                        rule: &rule,
                        protocol: if scheme == "https" {
                            "HTTPS/2".into()
                        } else {
                            "HTTP/1.1".into()
                        },
                        scheme,
                        method: method_str,
                        host,
                        path,
                        full_url,
                        req_headers,
                        req_bytes: &req_bytes,
                        elapsed_ms: start.elapsed().as_millis() as u64,
                        timestamp,
                        process_name: Some("flux-proxy (Composer)".into()),
                        process_pid: Some(self_pid),
                        req_mutated,
                        bp_modified,
                        client_ip: Some("127.0.0.1".into()),
                        client_addr: "Composer (Local)".into(),
                        tls_version: Some("AutoResponder Mock".into()),
                    },
                );
                let now = Instant::now();
                let resp_at = timestamp_at_instant(start, start_utc, now);
                let mut mock_timings = SessionTimings {
                    client_begin_request: Some(req_begin_at.clone()),
                    got_request_headers: Some(req_begin_at.clone()),
                    client_done_request: Some(req_begin_at),
                    client_begin_response: Some(resp_at.clone()),
                    client_done_response: Some(resp_at),
                    client_read_ms: Some(0.0),
                    breakpoint_pause_ms: (total_bp_pause_ms > 0.0)
                        .then(|| round_ms(total_bp_pause_ms)),
                    autoresponder_delay_ms: (autoresponder_delay_ms > 0.0)
                        .then(|| round_ms(autoresponder_delay_ms)),
                    ..Default::default()
                };
                compute_timings_summary(
                    &mut mock_timings,
                    duration_ms_f64(now.saturating_duration_since(start)),
                );
                let mock_stats = SessionTransferStats {
                    request_headers_bytes: Some(req_headers_bytes),
                    request_body_bytes: Some(req_bytes.len()),
                    request_wire_body_bytes: Some(req_bytes.len()),
                    response_headers_bytes: Some(estimate_response_headers_bytes(
                        rule.status_code,
                        "HTTP/1.1",
                        &mock_resp_headers,
                    )),
                    response_body_bytes: Some(mock_bytes.len()),
                    response_wire_body_bytes: Some(mock_bytes.len()),
                    client_conn_reused: Some(false),
                    client_http_version: Some("HTTP/1.1".into()),
                    ..Default::default()
                };
                detail
                    .summary
                    .apply_telemetry(Some(&mock_timings), Some(&mock_stats));
                detail.timings = Some(mock_timings);
                detail.transfer_stats = Some(mock_stats);

                let summary = detail.summary.clone();
                let capped_req = &req_bytes[..req_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
                let capped_mock = &mock_bytes[..mock_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
                self.context.store.insert_with_bodies(
                    detail.clone(),
                    Some(capped_req),
                    Some(capped_mock),
                );
                let stored = self.context.store.get(session_id).unwrap_or(detail);
                let _ = self.context.event_tx.send(summary);
                return Ok(stored);
            }
        }

        let in_flight_proto = if scheme == "https" {
            "HTTPS/2".to_string()
        } else {
            "HTTP/1.1".to_string()
        };

        if self.context.throttle.is_offline() {
            let err_msg = "Network Offline (Bandwidth Throttling: Offline)".to_string();
            record_error_session_with_telemetry(
                &self.context,
                session_id,
                in_flight_proto,
                &scheme,
                &method_str,
                &host,
                &path,
                &full_url,
                req_headers,
                &req_bytes,
                start.elapsed().as_millis() as u64,
                timestamp,
                Some("flux-proxy (Composer)".into()),
                Some(self_pid),
                false,
                req_mutated,
                bp_modified,
                Some("127.0.0.1".into()),
                "Composer (Local)".into(),
                503,
                None,
                None,
                None,
                &err_msg,
            );
            return Err(ProxyError::Custom(err_msg));
        }

        let target_host = parsed_url.host_str().unwrap_or(&host).to_string();
        let host_for_remap = req_headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("host"))
            .map(|h| h.value.clone())
            .unwrap_or_else(|| target_host.clone());
        let upstream_target =
            prepare_remapped_upstream_target(&self.context, &full_url, &host_for_remap, &scheme);

        let (client, mtls_cn) = if scheme.eq_ignore_ascii_case("https") {
            match self.context.client_certs.get_or_build_upstream_client(
                &target_host,
                Some(self.context.host_remap.clone()),
            ) {
                Ok(Some((mtls_client, entry))) => (mtls_client, Some(entry.common_name)),
                Ok(None) => (self.context.upstream_http_client(), None),
                Err(err) => {
                    let err_msg =
                        format!("Client certificate (mTLS) error for '{target_host}': {err}");
                    record_error_session_with_telemetry(
                        &self.context,
                        session_id,
                        in_flight_proto,
                        &scheme,
                        &method_str,
                        &host,
                        &path,
                        &full_url,
                        req_headers,
                        &req_bytes,
                        start.elapsed().as_millis() as u64,
                        timestamp,
                        Some("flux-proxy (Composer)".into()),
                        Some(self_pid),
                        false,
                        req_mutated,
                        bp_modified,
                        Some("127.0.0.1".into()),
                        "Composer (Local)".into(),
                        502,
                        upstream_target.remapped_to.clone(),
                        None,
                        None,
                        &err_msg,
                    );
                    return Err(ProxyError::Custom(err_msg));
                }
            }
        } else {
            (self.context.upstream_http_client(), None)
        };

        let in_flight_tls = if scheme == "https" {
            Some(match &mtls_cn {
                Some(cn) => format!("TLS (Composer · mTLS: {cn})"),
                None => "TLS (Composer)".to_string(),
            })
        } else {
            None
        };
        record_in_flight_session_with_remap(
            &self.context,
            session_id,
            timestamp.clone(),
            in_flight_proto.clone(),
            scheme.clone(),
            method_str.clone(),
            host.clone(),
            path.clone(),
            full_url.clone(),
            Some("flux-proxy (Composer)".into()),
            Some(self_pid),
            req_mutated,
            bp_modified,
            Some("127.0.0.1".into()),
            "Composer (Local)".into(),
            in_flight_tls,
            req_headers.clone(),
            &req_bytes,
            upstream_target.remapped_to.clone(),
        );

        if let Err(err) = self.context.throttle.apply_latency().await {
            let err_msg = err.to_string();
            record_error_session_with_telemetry(
                &self.context,
                session_id,
                in_flight_proto,
                &scheme,
                &method_str,
                &host,
                &path,
                &full_url,
                req_headers,
                &req_bytes,
                start.elapsed().as_millis() as u64,
                timestamp,
                Some("flux-proxy (Composer)".into()),
                Some(self_pid),
                false,
                req_mutated,
                bp_modified,
                Some("127.0.0.1".into()),
                "Composer (Local)".into(),
                503,
                upstream_target.remapped_to.clone(),
                None,
                None,
                &err_msg,
            );
            return Err(ProxyError::Custom(err_msg));
        }
        if !req_bytes.is_empty() {
            if let Err(err) = self
                .context
                .throttle
                .throttle_bytes(req_bytes.len(), false)
                .await
            {
                let err_msg = err.to_string();
                record_error_session_with_telemetry(
                    &self.context,
                    session_id,
                    in_flight_proto,
                    &scheme,
                    &method_str,
                    &host,
                    &path,
                    &full_url,
                    req_headers,
                    &req_bytes,
                    start.elapsed().as_millis() as u64,
                    timestamp,
                    Some("flux-proxy (Composer)".into()),
                    Some(self_pid),
                    false,
                    req_mutated,
                    bp_modified,
                    Some("127.0.0.1".into()),
                    "Composer (Local)".into(),
                    503,
                    upstream_target.remapped_to.clone(),
                    None,
                    None,
                    &err_msg,
                );
                return Err(ProxyError::Custom(err_msg));
            }
        }

        let outbound_headers: Vec<(String, String)> = req_headers
            .iter()
            .filter(|h| {
                let name = h.name.trim();
                !name.is_empty()
                    && !name.eq_ignore_ascii_case("content-length")
                    && !(upstream_target.host_header_override.is_some()
                        && name.eq_ignore_ascii_case("host"))
            })
            .map(|h| (h.name.clone(), h.value.clone()))
            .collect();
        let req_timeout = Duration::from_secs(self.context.upstream_timeout_sec.max(1));
        let req_body_bytes = Bytes::from(req_bytes.clone());

        let exchange = if composed.follow_redirects {
            client
                .send_following_redirects(
                    method,
                    &upstream_target.upstream_url,
                    &outbound_headers,
                    upstream_target.host_header_override.as_deref(),
                    req_body_bytes,
                    req_timeout,
                )
                .await
        } else {
            client
                .send_with_idempotent_retry(
                    method,
                    &upstream_target.upstream_url,
                    &outbound_headers,
                    upstream_target.host_header_override.as_deref(),
                    req_body_bytes,
                    req_timeout,
                )
                .await
        };

        let exchange = match exchange {
            Ok(ex) => ex,
            Err(err) => {
                let chain = format_error_chain(&err);
                let msg = format!("Upstream connection error: {chain}");
                record_error_session_with_telemetry(
                    &self.context,
                    session_id,
                    in_flight_proto,
                    &scheme,
                    &method_str,
                    &host,
                    &path,
                    &full_url,
                    req_headers,
                    &req_bytes,
                    start.elapsed().as_millis() as u64,
                    timestamp,
                    Some("flux-proxy (Composer)".into()),
                    Some(self_pid),
                    false,
                    req_mutated,
                    bp_modified,
                    Some("127.0.0.1".into()),
                    "Composer (Local)".into(),
                    err.status_hint().as_u16(),
                    upstream_target.remapped_to.clone(),
                    None,
                    None,
                    &msg,
                );
                return Err(ProxyError::Custom(msg));
            }
        };

        let conn_meta = exchange.conn_meta.clone();
        let claimed = exchange.claimed.clone();
        let proxy_begin_request_at = exchange.proxy_begin_request_at.clone();
        let server_got_request_at = exchange.server_got_request_at.clone();
        let got_response_headers_at = exchange.got_response_headers_at.clone();
        let got_response_headers_instant = exchange.got_response_headers_instant;
        let send_request_ms = exchange.send_request_ms;
        let server_wait_ms = exchange.server_wait_ms;
        let upstream_resp = exchange.response;

        let mut status = upstream_resp.status().as_u16();
        let upstream_version = upstream_resp.version();
        let version_str = format_http_version(&scheme, upstream_version);
        let server_http_ver = format_raw_http_version(upstream_version).to_string();
        let mut resp_headers = extract_hyper_headers(upstream_resp.headers());
        let raw_response_content_encoding = resp_headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("content-encoding"))
            .map(|h| h.value.clone());
        let resp_headers_bytes =
            estimate_response_headers_bytes(status, &server_http_ver, &resp_headers);
        let mut resp_mutated = self.context.filters.apply_header_mutations(
            HeaderMutationDirection::Response,
            &full_url,
            &mut resp_headers,
        );
        let mut upstream_resp_body = upstream_resp.into_body();

        let raw_resp_bytes = if self
            .context
            .throttle
            .get_config()
            .download_bytes_per_sec()
            .is_some()
            || self.context.throttle.is_offline()
        {
            let mut collected = Vec::new();
            let mut pacer = BandwidthPacer::new();
            loop {
                match upstream_resp_body.frame().await {
                    Some(Ok(frame)) => {
                        let Some(chunk) = frame.into_data().ok().filter(|c| !c.is_empty()) else {
                            continue;
                        };
                        if let Err(err) = pacer.pace(&self.context.throttle, chunk.len(), true).await {
                            let err_msg = err.to_string();
                            record_error_session_with_telemetry(
                                &self.context,
                                session_id,
                                version_str,
                                &scheme,
                                &method_str,
                                &host,
                                &path,
                                &full_url,
                                req_headers,
                                &req_bytes,
                                start.elapsed().as_millis() as u64,
                                timestamp,
                                Some("flux-proxy (Composer)".into()),
                                Some(self_pid),
                                false,
                                req_mutated || resp_mutated,
                                bp_modified,
                                Some("127.0.0.1".into()),
                                "Composer (Local)".into(),
                                503,
                                upstream_target.remapped_to.clone(),
                                None,
                                None,
                                &err_msg,
                            );
                            return Err(ProxyError::Custom(err_msg));
                        }
                        collected.extend_from_slice(&chunk);
                    }
                    None => break,
                    Some(Err(err)) => {
                        let chain = format_error_chain(&err);
                        let msg = format!("Failed reading upstream response body: {chain}");
                        record_error_session_with_telemetry(
                            &self.context,
                            session_id,
                            version_str,
                            &scheme,
                            &method_str,
                            &host,
                            &path,
                            &full_url,
                            req_headers,
                            &req_bytes,
                            start.elapsed().as_millis() as u64,
                            timestamp,
                            Some("flux-proxy (Composer)".into()),
                            Some(self_pid),
                            false,
                            req_mutated || resp_mutated,
                            bp_modified,
                            Some("127.0.0.1".into()),
                            "Composer (Local)".into(),
                            502,
                            upstream_target.remapped_to.clone(),
                            None,
                            None,
                            &msg,
                        );
                        return Err(ProxyError::Custom(msg));
                    }
                }
            }
            Bytes::from(collected)
        } else {
            match upstream_resp_body.collect().await {
                Ok(collected) => collected.to_bytes(),
                Err(err) => {
                    let chain = format_error_chain(&err);
                    let msg = format!("Failed reading upstream response body: {chain}");
                    record_error_session_with_telemetry(
                        &self.context,
                        session_id,
                        version_str,
                        &scheme,
                        &method_str,
                        &host,
                        &path,
                        &full_url,
                        req_headers,
                        &req_bytes,
                        start.elapsed().as_millis() as u64,
                        timestamp,
                        Some("flux-proxy (Composer)".into()),
                        Some(self_pid),
                        false,
                        req_mutated || resp_mutated,
                        bp_modified,
                        Some("127.0.0.1".into()),
                        "Composer (Local)".into(),
                        502,
                        upstream_target.remapped_to.clone(),
                        None,
                        None,
                        &msg,
                    );
                    return Err(ProxyError::Custom(msg));
                }
            }
        };

        let server_done_instant = Instant::now();
        let server_done_at = timestamp_at_instant(start, start_utc, server_done_instant);
        let content_download_ms = duration_ms_f64(
            server_done_instant.saturating_duration_since(got_response_headers_instant),
        );
        let response_wire_len = raw_resp_bytes.len();

        let mut resp_bytes = if method_str.eq_ignore_ascii_case("HEAD") {
            raw_resp_bytes.to_vec()
        } else {
            maybe_decompress_content_encodings(&resp_headers, raw_resp_bytes)
                .await
                .body
                .to_vec()
        };

        // Live Breakpoint: After Response (Alt+F11 / `bpafter`)
        if self
            .context
            .breakpoints
            .should_break(BreakpointStage::Response, &method_str, &full_url)
        {
            let bp_resp_start = Instant::now();
            let bp_outcome = run_response_breakpoint_stage(
                &self.context,
                ResponseBreakpointStageInput {
                    session_id,
                    protocol: version_str.clone(),
                    scheme: scheme.clone(),
                    method: method_str.clone(),
                    host: host.clone(),
                    path: path.clone(),
                    url: full_url.clone(),
                    content_type: String::new(),
                    timestamp: timestamp.clone(),
                    start,
                    process_name: Some("flux-proxy (Composer)".into()),
                    process_pid: Some(self_pid),
                    client_ip: Some("127.0.0.1".into()),
                    client_addr: "Composer (Local)".into(),
                    tls_version: None,
                    is_mocked: false,
                    matched_rule_id: None,
                    req_headers: req_headers.clone(),
                    req_bytes: req_bytes.clone(),
                    req_mutated,
                    insert_paused_summary: false,
                },
                &mut status,
                &mut resp_headers,
                &mut resp_bytes,
                &mut resp_mutated,
                &mut bp_modified,
            )
            .await;
            total_bp_pause_ms += elapsed_ms(bp_resp_start);
            if bp_outcome.aborted {
                let msg = "Response aborted at Live Breakpoint";
                record_error_session_with_telemetry(
                    &self.context,
                    session_id,
                    version_str,
                    &scheme,
                    &method_str,
                    &host,
                    &path,
                    &full_url,
                    req_headers,
                    &req_bytes,
                    start.elapsed().as_millis() as u64,
                    timestamp,
                    Some("flux-proxy (Composer)".into()),
                    Some(self_pid),
                    false,
                    req_mutated || resp_mutated,
                    true,
                    Some("127.0.0.1".into()),
                    "Composer (Local)".into(),
                    StatusCode::BAD_GATEWAY.as_u16(),
                    upstream_target.remapped_to.clone(),
                    None,
                    None,
                    msg,
                );
                return Err(ProxyError::Custom(msg.into()));
            }
        }

        let finish_instant = Instant::now();
        let finish_at = timestamp_at_instant(start, start_utc, finish_instant);
        let content_type = resp_headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("content-type"))
            .map(|h| h.value.clone())
            .unwrap_or_else(|| "text/plain".to_string());
        let sse_events = if content_type.to_ascii_lowercase().starts_with("text/event-stream") {
            parse_sse_events_from_bytes(&resp_bytes, start.elapsed().as_millis() as u64)
        } else {
            Vec::new()
        };
        let duration_ms = start.elapsed().as_millis() as u64;

        let mut timings = SessionTimings {
            client_begin_request: Some(req_begin_at.clone()),
            got_request_headers: Some(req_begin_at.clone()),
            client_done_request: Some(req_begin_at),
            proxy_begin_request: Some(proxy_begin_request_at),
            server_connected: claimed.as_ref().and_then(|c| c.server_connected_at.clone()),
            server_got_request: Some(server_got_request_at),
            server_begin_response: Some(got_response_headers_at.clone()),
            got_response_headers: Some(got_response_headers_at),
            server_done_response: Some(server_done_at),
            client_begin_response: Some(finish_at.clone()),
            client_done_response: Some(finish_at),
            client_read_ms: Some(0.0),
            dns_ms: Some(claimed.as_ref().map_or(0.0, |c| c.dns_ms)),
            tcp_connect_ms: Some(claimed.as_ref().map_or(0.0, |c| c.tcp_connect_ms)),
            tls_handshake_ms: claimed.as_ref().and_then(|c| c.tls_handshake_ms),
            send_request_ms: Some(send_request_ms),
            server_wait_ms: Some(server_wait_ms),
            content_download_ms: Some(content_download_ms),
            client_send_ms: Some(0.0),
            breakpoint_pause_ms: (total_bp_pause_ms > 0.0).then(|| round_ms(total_bp_pause_ms)),
            autoresponder_delay_ms: (autoresponder_delay_ms > 0.0)
                .then(|| round_ms(autoresponder_delay_ms)),
            ..Default::default()
        };
        compute_timings_summary(
            &mut timings,
            duration_ms_f64(finish_instant.saturating_duration_since(start)),
        );

        let transfer_stats = SessionTransferStats {
            request_headers_bytes: Some(req_headers_bytes),
            request_body_bytes: Some(req_bytes.len()),
            request_wire_body_bytes: Some(req_bytes.len()),
            response_headers_bytes: Some(resp_headers_bytes),
            response_body_bytes: Some(resp_bytes.len()),
            response_wire_body_bytes: Some(response_wire_len),
            response_content_encoding: raw_response_content_encoding,
            client_conn_reused: Some(false),
            client_http_version: Some("HTTP/1.1".into()),
            server_addr: conn_meta.as_ref().map(|m| m.server_addr.to_string()),
            server_ip: conn_meta.as_ref().map(|m| m.server_ip.clone()),
            server_port: conn_meta.as_ref().map(|m| m.server_port),
            server_conn_id: conn_meta.as_ref().map(|m| m.conn_id),
            server_conn_reused: claimed.as_ref().map(|c| c.reused),
            server_http_version: Some(server_http_ver),
            server_tls_version: conn_meta.as_ref().and_then(|m| m.tls_version.clone()),
            server_tls_cipher: conn_meta.as_ref().and_then(|m| m.tls_cipher.clone()),
            server_tls_alpn: conn_meta.as_ref().and_then(|m| m.tls_alpn.clone()),
            server_cert_subject: conn_meta.as_ref().and_then(|m| m.cert_subject.clone()),
            server_cert_issuer: conn_meta.as_ref().and_then(|m| m.cert_issuer.clone()),
            server_mtls_cn: mtls_cn.clone(),
            remapped_target: upstream_target
                .remapped_to
                .clone()
                .or_else(|| conn_meta.as_ref().and_then(|m| m.remapped_target.clone())),
            ..Default::default()
        };

        let mut summary = SessionSummary {
            id: session_id,
            status,
            protocol: version_str,
            scheme: scheme.clone(),
            method: method_str,
            host,
            path,
            url: full_url,
            content_type,
            body_size: resp_bytes.len(),
            duration_ms,
            timestamp,
            is_mocked: false,
            matched_rule_id: None,
            error: None,
            process_name: Some("flux-proxy (Composer)".into()),
            process_pid: Some(self_pid),
            tls_bypassed: false,
            headers_mutated: req_mutated || resp_mutated,
            breakpoint_paused: None,
            breakpoint_modified: bp_modified,
            comment: None,
            marked_color: None,
            client_ip: Some("127.0.0.1".into()),
            remapped_to: upstream_target.remapped_to.clone(),
            ttfb_ms: None,
            dns_ms: None,
            connect_ms: None,
            tls_ms: None,
            receive_ms: None,
            request_size: None,
            wire_body_size: None,
            server_ip: None,
            server_conn_reused: None,
        };
        summary.apply_telemetry(Some(&timings), Some(&transfer_stats));

        let capped_req = &req_bytes[..req_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
        let capped_resp = &resp_bytes[..resp_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
        let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
        let (resp_b64, resp_txt, resp_offloaded) = encode_inline_or_offload(capped_resp);
        let server_tls_ver = conn_meta.as_ref().and_then(|m| m.tls_version.as_deref());
        let detail = SessionDetail {
            summary,
            request_headers: req_headers,
            response_headers: resp_headers,
            request_body_base64: req_b64,
            response_body_base64: resp_b64,
            request_body_text: req_txt,
            response_body_text: resp_txt,
            tls_version: if scheme == "https" {
                let tls_label = server_tls_ver.unwrap_or("TLS");
                Some(match &mtls_cn {
                    Some(cn) => format!("{tls_label} (Composer · mTLS: {cn})"),
                    None => format!("{tls_label} (Composer)"),
                })
            } else {
                None
            },
            client_addr: "Composer (Local)".into(),
            websocket_frames: Vec::new(),
            sse_events,
            body_offloaded: resp_offloaded,
            request_body_offloaded: req_offloaded,
            timings: Some(timings),
            transfer_stats: Some(transfer_stats),
        };

        let _ = record_completed_session(
            &self.context,
            detail.clone(),
            Some(capped_req),
            Some(capped_resp),
        );
        let stored = self.context.store.get(session_id).unwrap_or(detail);
        Ok(stored)
    }
}
