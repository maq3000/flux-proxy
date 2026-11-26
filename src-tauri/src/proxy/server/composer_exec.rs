use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use tokio::sync::oneshot;

struct ActiveComposerRequestGuard {
    map: Arc<DashMap<String, oneshot::Sender<()>>>,
    request_id: Option<String>,
}

impl Drop for ActiveComposerRequestGuard {
    fn drop(&mut self) {
        if let Some(ref id) = self.request_id {
            self.map.remove(id);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn record_composer_cancelled(
    ctx: &super::SharedProxyContext,
    session_id: u64,
    protocol: String,
    scheme: &str,
    method_str: &str,
    host: &str,
    path: &str,
    full_url: &str,
    req_headers: Vec<crate::models::HeaderPair>,
    req_bytes: &[u8],
    start: Instant,
    timestamp: String,
    self_pid: u32,
    headers_mutated: bool,
    bp_modified: bool,
    remapped_to: Option<String>,
) -> ProxyError {
    let msg = "Composer request cancelled by user";
    super::record_error_session_with_telemetry_and_code(
        ctx,
        session_id,
        protocol,
        scheme,
        method_str,
        host,
        path,
        full_url,
        req_headers,
        req_bytes,
        start.elapsed().as_millis() as u64,
        timestamp,
        Some("flux-proxy (Composer)".into()),
        Some(self_pid),
        false,
        headers_mutated,
        bp_modified,
        Some("127.0.0.1".into()),
        "Composer (Local)".into(),
        499,
        remapped_to,
        None,
        None,
        msg,
        Some(super::FLUXPROXY_ERR_COMPOSER_CANCELLED),
    );
    ProxyError::Custom(msg.to_string())
}

use base64::Engine as _;
use bytes::Bytes;
use chrono::Utc;
use http::StatusCode;

use crate::models::{
    BreakpointStage, ComposedRequest, HeaderMutationDirection, ProxyError, RuleActionType,
    SessionDetail, SessionSummary, SessionTimings, SessionTransferStats,
};
use crate::proxy::upstream_client::{
    duration_ms_f64, elapsed_ms, estimate_request_headers_bytes, estimate_response_headers_bytes,
    format_rfc3339_micros, round_ms, timestamp_at_instant,
};
use crate::scripting::{apply_header_diff, ScriptRequestOutcome, ScriptResponseOutcome};

use super::http_handler::{
    apply_script_request_edits, build_autoresponder_mock_detail, collect_response_body_limited,
    compute_timings_summary, format_error_chain, maybe_decompress_content_encodings,
    parse_sse_events_from_bytes, prepare_remapped_upstream_target, run_request_breakpoint_stage,
    run_response_breakpoint_stage, AutoResponderMockInput, RequestBreakpointStageInput,
    ResponseBodyReadError, ResponseBreakpointStageInput,
};
use super::{
    encode_inline_or_offload, extract_hyper_headers, format_http_version, format_raw_http_version,
    is_hop_by_hop_header, record_completed_session, record_error_session_with_telemetry,
    record_in_flight_session_with_remap, ProxyEngineController, MAX_BUFFERED_RESPONSE_BODY_BYTES,
    MAX_CAPTURED_BODY_BYTES,
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

        let timeout_override = composed.timeout_sec;
        if let Some(sec) = timeout_override {
            crate::models::validate_composer_timeout_sec(sec)?;
        }
        let clean_request_id = composed
            .request_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let cancel_rx = clean_request_id.as_ref().map(|req_id| {
            let (tx, rx) = oneshot::channel::<()>();
            self.active_composer_requests.insert(req_id.clone(), tx);
            rx
        });
        let _composer_cancel_guard = ActiveComposerRequestGuard {
            map: Arc::clone(&self.active_composer_requests),
            request_id: clean_request_id,
        };
        let mut cancel_fut = Box::pin(async move {
            match cancel_rx {
                Some(rx) => {
                    let _ = rx.await;
                }
                None => std::future::pending::<()>().await,
            }
        });

        let skip_python_scripts = composed.skip_python_scripts.unwrap_or(false);
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
        let mut total_script_hook_ms = 0.0_f64;
        let mut autoresponder_delay_ms = 0.0_f64;

        let parsed_initial = url::Url::parse(&full_url)
            .map_err(|e| ProxyError::Custom(format!("Invalid URL '{full_url}': {e}")))?;
        let mut scheme = parsed_initial.scheme().to_string();
        let mut host = parsed_initial.host_str().unwrap_or("unknown").to_string();
        let mut path = match parsed_initial.query() {
            Some(q) => format!("{}?{}", parsed_initial.path(), q),
            None => parsed_initial.path().to_string(),
        };

        let mut req_mutated = self.context.filters.apply_header_mutations(
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
            let bp_res = tokio::select! {
                biased;
                _ = &mut cancel_fut => {
                    return Err(record_composer_cancelled(
                        &self.context,
                        session_id,
                        if scheme == "https" {
                            "HTTPS/2".to_string()
                        } else {
                            "HTTP/1.1".to_string()
                        },
                        &scheme,
                        &method_str,
                        &host,
                        &path,
                        &full_url,
                        req_headers,
                        &req_bytes,
                        start,
                        timestamp,
                        self_pid,
                        req_mutated,
                        bp_modified,
                        None,
                    ));
                }
                res = run_request_breakpoint_stage(
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
                ) => res,
            };
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

        // Python Scripting Engine: on_request(request)
        if !skip_python_scripts && self.context.script_runner.should_run_request() {
            let py_req_start = Instant::now();
            let outcome = tokio::select! {
                biased;
                _ = &mut cancel_fut => {
                    return Err(record_composer_cancelled(
                        &self.context,
                        session_id,
                        if scheme == "https" {
                            "HTTPS/2".to_string()
                        } else {
                            "HTTP/1.1".to_string()
                        },
                        &scheme,
                        &method_str,
                        &host,
                        &path,
                        &full_url,
                        req_headers,
                        &req_bytes,
                        start,
                        timestamp,
                        self_pid,
                        req_mutated,
                        bp_modified,
                        None,
                    ));
                }
                res = self
                    .context
                    .script_runner
                    .run_on_request(session_id, &method_str, &full_url, &req_headers, &req_bytes) => res,
            };
            total_script_hook_ms += elapsed_ms(py_req_start);
            match outcome {
                ScriptRequestOutcome::Unchanged => {}
                ScriptRequestOutcome::Modified(edits) => {
                    let mut body_buf = Bytes::from(std::mem::take(&mut req_bytes));
                    apply_script_request_edits(
                        edits,
                        &mut method_str,
                        &mut full_url,
                        &mut scheme,
                        &mut host,
                        &mut path,
                        &mut req_headers,
                        &mut body_buf,
                        &mut req_mutated,
                    );
                    req_bytes = body_buf.to_vec();
                    req_headers_bytes = estimate_request_headers_bytes(
                        &method_str,
                        &path,
                        "HTTP/1.1",
                        &req_headers,
                    );
                }
                ScriptRequestOutcome::MockResponse { edits, mock } => {
                    let mut body_buf = Bytes::from(std::mem::take(&mut req_bytes));
                    apply_script_request_edits(
                        edits,
                        &mut method_str,
                        &mut full_url,
                        &mut scheme,
                        &mut host,
                        &mut path,
                        &mut req_headers,
                        &mut body_buf,
                        &mut req_mutated,
                    );
                    req_bytes = body_buf.to_vec();
                    req_headers_bytes = estimate_request_headers_bytes(
                        &method_str,
                        &path,
                        "HTTP/1.1",
                        &req_headers,
                    );

                    let mock_bytes = mock.body;
                    let mut mock_resp_headers = mock.headers;
                    let resp_mutated = self.context.filters.apply_header_mutations(
                        HeaderMutationDirection::Response,
                        &full_url,
                        &mut mock_resp_headers,
                    );
                    let content_type = mock_resp_headers
                        .iter()
                        .find(|h| h.name.eq_ignore_ascii_case("content-type"))
                        .map(|h| h.value.clone())
                        .unwrap_or_else(|| "application/json; charset=utf-8".to_string());
                    let sse_events = if content_type
                        .to_ascii_lowercase()
                        .starts_with("text/event-stream")
                    {
                        parse_sse_events_from_bytes(
                            &mock_bytes,
                            start.elapsed().as_millis() as u64,
                        )
                    } else {
                        Vec::new()
                    };

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
                        script_hook_ms: Some(round_ms(total_script_hook_ms)),
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
                            mock.status,
                            "HTTP/1.1",
                            &mock_resp_headers,
                        )),
                        response_body_bytes: Some(mock_bytes.len()),
                        response_wire_body_bytes: Some(mock_bytes.len()),
                        client_conn_reused: Some(false),
                        client_http_version: Some("HTTP/1.1".into()),
                        ..Default::default()
                    };

                    let protocol_label = if scheme == "https" {
                        "HTTPS/2".to_string()
                    } else {
                        "HTTP/1.1".to_string()
                    };
                    let mut summary = SessionSummary {
                        id: session_id,
                        status: mock.status,
                        protocol: protocol_label,
                        scheme: scheme.clone(),
                        method: method_str,
                        host,
                        path,
                        url: full_url,
                        content_type,
                        body_size: mock_bytes.len(),
                        duration_ms: start.elapsed().as_millis() as u64,
                        timestamp,
                        is_mocked: true,
                        matched_rule_id: Some("python-script".to_string()),
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
                    summary.apply_telemetry(Some(&mock_timings), Some(&mock_stats));

                    let capped_req = &req_bytes[..req_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
                    let capped_mock = &mock_bytes[..mock_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
                    let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
                    let (resp_b64, resp_txt, resp_offloaded) = encode_inline_or_offload(capped_mock);
                    let detail = SessionDetail {
                        summary,
                        request_headers: req_headers,
                        response_headers: mock_resp_headers,
                        request_body_base64: req_b64,
                        response_body_base64: resp_b64,
                        request_body_text: req_txt,
                        response_body_text: resp_txt,
                        tls_version: (scheme == "https")
                            .then(|| "TLS (Composer · Python Mock)".to_string()),
                        client_addr: "Composer (Local)".into(),
                        websocket_frames: Vec::new(),
                        sse_events,
                        body_offloaded: resp_offloaded,
                        request_body_offloaded: req_offloaded,
                        timings: Some(mock_timings),
                        transfer_stats: Some(mock_stats),
                    };

                    let _ = record_completed_session(
                        &self.context,
                        detail.clone(),
                        Some(capped_req),
                        Some(capped_mock),
                    );
                    let stored = self.context.store.get(session_id).unwrap_or(detail);
                    return Ok(stored);
                }
            }
        }

        let parsed_url = url::Url::parse(&full_url)
            .map_err(|e| ProxyError::Custom(format!("Invalid URL '{full_url}': {e}")))?;
        let method = http::Method::from_bytes(method_str.as_bytes())
            .map_err(|e| ProxyError::Custom(format!("Invalid HTTP method: {e}")))?;

        // Check AutoResponder rules for composed requests too
        let matched_rule = self
            .context
            .rules
            .find_matching_rule(&method_str, &full_url, &req_headers);
        if let Some(ref rule) = matched_rule {
            if rule.latency_ms > 0 {
                let delay_t = Instant::now();
                tokio::select! {
                    biased;
                    _ = &mut cancel_fut => {
                        return Err(record_composer_cancelled(
                            &self.context,
                            session_id,
                            if scheme == "https" {
                                "HTTPS/2".to_string()
                            } else {
                                "HTTP/1.1".to_string()
                            },
                            &scheme,
                            &method_str,
                            &host,
                            &path,
                            &full_url,
                            req_headers,
                            &req_bytes,
                            start,
                            timestamp,
                            self_pid,
                            req_mutated,
                            bp_modified,
                            None,
                        ));
                    }
                    _ = tokio::time::sleep(Duration::from_millis(rule.latency_ms)) => {}
                }
                autoresponder_delay_ms = elapsed_ms(delay_t);
            }
            if matches!(rule.action, RuleActionType::MockResponse) {
                let (mut detail, mock_resp_headers, mock_bytes) = build_autoresponder_mock_detail(
                    &self.context,
                    AutoResponderMockInput {
                        session_id,
                        rule,
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
                    script_hook_ms: (total_script_hook_ms > 0.0)
                        .then(|| round_ms(total_script_hook_ms)),
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

                let capped_req = &req_bytes[..req_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
                let capped_mock = &mock_bytes[..mock_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
                let _ = record_completed_session(
                    &self.context,
                    detail.clone(),
                    Some(capped_req),
                    Some(capped_mock),
                );
                let stored = self.context.store.get(session_id).unwrap_or(detail);
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
                Some(self.context.upstream_proxy.clone()),
                Arc::clone(&self.context.connect_timeout_sec),
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
        let mut in_flight_guard =
            super::InFlightSessionGuard::new_composer(Arc::clone(&self.context), session_id, start);

        let throttle_latency_res = tokio::select! {
            biased;
            _ = &mut cancel_fut => {
                in_flight_guard.disarm();
                return Err(record_composer_cancelled(
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
                    start,
                    timestamp,
                    self_pid,
                    req_mutated,
                    bp_modified,
                    upstream_target.remapped_to.clone(),
                ));
            }
            res = self.context.throttle.apply_latency() => res,
        };
        if let Err(err) = throttle_latency_res {
            in_flight_guard.disarm();
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
            let throttle_upload_res = tokio::select! {
                biased;
                _ = &mut cancel_fut => {
                    in_flight_guard.disarm();
                    return Err(record_composer_cancelled(
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
                        start,
                        timestamp,
                        self_pid,
                        req_mutated,
                        bp_modified,
                        upstream_target.remapped_to.clone(),
                    ));
                }
                res = self.context.throttle.throttle_bytes(req_bytes.len(), false) => res,
            };
            if let Err(err) = throttle_upload_res {
                in_flight_guard.disarm();
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

        let outbound_headers: Vec<crate::models::HeaderPair> = req_headers
            .iter()
            .filter(|h| {
                let name = h.name.trim();
                !name.is_empty()
                    && !is_hop_by_hop_header(name)
                    && !name.eq_ignore_ascii_case("content-length")
                    && !(upstream_target.host_header_override.is_some()
                        && name.eq_ignore_ascii_case("host"))
            })
            .cloned()
            .collect();
        let req_timeout = self.context.composer_timeout(timeout_override);
        let req_body_bytes = Bytes::from(req_bytes.clone());

        let send_fut = async {
            if composed.follow_redirects {
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
            }
        };

        let exchange = tokio::select! {
            biased;
            _ = &mut cancel_fut => {
                in_flight_guard.disarm();
                return Err(record_composer_cancelled(
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
                    start,
                    timestamp,
                    self_pid,
                    req_mutated,
                    bp_modified,
                    upstream_target.remapped_to.clone(),
                ));
            }
            res = send_fut => res,
        };

        let exchange = match exchange {
            Ok(ex) => ex,
            Err(err) => {
                in_flight_guard.disarm();
                let chain = format_error_chain(&err);
                let proxy_err_code = err.proxy_error_code();
                let msg = match &err {
                    crate::proxy::upstream_client::UpstreamClientError::Timeout(_) => {
                        format!("Upstream response timeout: {chain}")
                    }
                    _ => format!("Upstream connection error: {chain}"),
                };
                super::record_error_session_with_telemetry_and_code(
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
                    Some(proxy_err_code),
                );
                return Err(ProxyError::Custom(msg));
            }
        };

        if !exchange.final_url.is_empty() && exchange.final_url != full_url {
            full_url = exchange.final_url.clone();
            if let Ok(parsed_final) = url::Url::parse(&full_url) {
                scheme = parsed_final.scheme().to_string();
                if let Some(final_host) = parsed_final.host_str() {
                    host = final_host.to_string();
                }
                path = match parsed_final.query() {
                    Some(q) => format!("{}?{}", parsed_final.path(), q),
                    None => parsed_final.path().to_string(),
                };
            }
        }

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
        let mut is_mocked = false;
        let mut matched_rule_id = None;
        if let Some(ref rule) = matched_rule {
            matched_rule_id = Some(rule.id.clone());
            if matches!(rule.action, RuleActionType::OverrideStatus) {
                status = rule.status_code;
                is_mocked = true;
            }
        }
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
        let upstream_resp_body = upstream_resp.into_body();

        let body_collect_res = tokio::select! {
            biased;
            _ = &mut cancel_fut => {
                in_flight_guard.disarm();
                return Err(record_composer_cancelled(
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
                    start,
                    timestamp,
                    self_pid,
                    req_mutated || resp_mutated,
                    bp_modified,
                    upstream_target.remapped_to.clone(),
                ));
            }
            res = collect_response_body_limited(
                upstream_resp_body,
                &self.context.throttle,
                MAX_BUFFERED_RESPONSE_BODY_BYTES,
            ) => res,
        };

        let raw_resp_bytes = match body_collect_res {
            Ok(bytes) => bytes,
            Err(err) => {
                in_flight_guard.disarm();
                let (err_status, msg) = match err {
                    ResponseBodyReadError::PayloadTooLarge { limit, .. } => (
                        StatusCode::BAD_GATEWAY.as_u16(),
                        format!(
                            "Upstream response body exceeds maximum buffered limit ({limit} bytes)"
                        ),
                    ),
                    ResponseBodyReadError::Throttle { message, .. } => (503, message),
                    ResponseBodyReadError::Transport { message, .. } => (
                        StatusCode::BAD_GATEWAY.as_u16(),
                        format!("Failed reading upstream response body: {message}"),
                    ),
                };
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
                    err_status,
                    upstream_target.remapped_to.clone(),
                    None,
                    None,
                    &msg,
                );
                return Err(ProxyError::Custom(msg));
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

        let mut content_type = resp_headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("content-type"))
            .map(|h| h.value.clone())
            .unwrap_or_else(|| "text/plain".to_string());
        let ct_lower = content_type.to_ascii_lowercase();
        let is_streaming_response = status == 206
            || ct_lower.starts_with("text/event-stream")
            || ct_lower.starts_with("video/")
            || ct_lower.starts_with("audio/");

        // Python Scripting Engine: on_response(response)
        if !skip_python_scripts
            && !is_streaming_response
            && self.context.script_runner.should_run_response()
        {
            let py_resp_start = Instant::now();
            let outcome = tokio::select! {
                biased;
                _ = &mut cancel_fut => {
                    in_flight_guard.disarm();
                    return Err(record_composer_cancelled(
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
                        start,
                        timestamp,
                        self_pid,
                        req_mutated || resp_mutated,
                        bp_modified,
                        upstream_target.remapped_to.clone(),
                    ));
                }
                res = self.context.script_runner.run_on_response(
                    session_id,
                    &method_str,
                    &full_url,
                    status,
                    &resp_headers,
                    &resp_bytes,
                ) => res,
            };
            total_script_hook_ms += elapsed_ms(py_resp_start);
            if let ScriptResponseOutcome::Modified(edits) = outcome {
                if let Some(next_status) = edits.status {
                    if (100..=599).contains(&next_status) && next_status != status {
                        status = next_status;
                        resp_mutated = true;
                    }
                }
                if edits.headers_changed
                    && apply_header_diff(
                        &mut resp_headers,
                        &edits.headers_removed,
                        &edits.headers_set,
                    )
                {
                    let _ = self.context.filters.strip_alt_svc_headers(&mut resp_headers);
                    if let Some(ct_hdr) = resp_headers
                        .iter()
                        .find(|h| h.name.eq_ignore_ascii_case("content-type"))
                    {
                        content_type = ct_hdr.value.clone();
                    }
                    resp_mutated = true;
                }
                if let Some(next_body) = edits.body {
                    resp_bytes = next_body;
                    resp_mutated = true;
                }
            }
        }

        // Live Breakpoint: After Response (Alt+F11 / `bpafter`)
        if self
            .context
            .breakpoints
            .should_break(BreakpointStage::Response, &method_str, &full_url)
        {
            let bp_resp_start = Instant::now();
            let bp_outcome = tokio::select! {
                biased;
                _ = &mut cancel_fut => {
                    in_flight_guard.disarm();
                    return Err(record_composer_cancelled(
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
                        start,
                        timestamp,
                        self_pid,
                        req_mutated || resp_mutated,
                        bp_modified,
                        upstream_target.remapped_to.clone(),
                    ));
                }
                res = run_response_breakpoint_stage(
                    &self.context,
                    ResponseBreakpointStageInput {
                        session_id,
                        protocol: version_str.clone(),
                        scheme: scheme.clone(),
                        method: method_str.clone(),
                        host: host.clone(),
                        path: path.clone(),
                        url: full_url.clone(),
                        content_type: content_type.clone(),
                        timestamp: timestamp.clone(),
                        start,
                        process_name: Some("flux-proxy (Composer)".into()),
                        process_pid: Some(self_pid),
                        client_ip: Some("127.0.0.1".into()),
                        client_addr: "Composer (Local)".into(),
                        tls_version: None,
                        is_mocked,
                        matched_rule_id: matched_rule_id.clone(),
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
                ) => res,
            };
            total_bp_pause_ms += elapsed_ms(bp_resp_start);
            if bp_outcome.aborted {
                in_flight_guard.disarm();
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
            if bp_outcome.headers_changed {
                if let Some(ct_hdr) = resp_headers
                    .iter()
                    .find(|h| h.name.eq_ignore_ascii_case("content-type"))
                {
                    content_type = ct_hdr.value.clone();
                }
            }
        }

        let finish_instant = Instant::now();
        let finish_at = timestamp_at_instant(start, start_utc, finish_instant);
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
            script_hook_ms: (total_script_hook_ms > 0.0).then(|| round_ms(total_script_hook_ms)),
            autoresponder_delay_ms: (autoresponder_delay_ms > 0.0)
                .then(|| round_ms(autoresponder_delay_ms)),
            ..Default::default()
        };
        compute_timings_summary(
            &mut timings,
            duration_ms_f64(finish_instant.saturating_duration_since(start)),
        );

        let is_proxied = conn_meta.as_ref().is_some_and(|m| m.via_proxy_addr.is_some());
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
            server_addr: if is_proxied {
                None
            } else {
                conn_meta.as_ref().map(|m| m.server_addr.to_string())
            },
            server_ip: conn_meta.as_ref().map(|m| m.server_ip.clone()),
            server_port: if is_proxied {
                None
            } else {
                conn_meta.as_ref().map(|m| m.server_port)
            },
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
            via_proxy_addr: conn_meta.as_ref().and_then(|m| m.via_proxy_addr.clone()),
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
            is_mocked,
            matched_rule_id,
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
            ws_open: None,
        };
        summary.apply_telemetry(Some(&timings), Some(&transfer_stats));

        let capped_req = &req_bytes[..req_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
        let capped_resp = &resp_bytes[..resp_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
        let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
        let (resp_b64, resp_txt, resp_offloaded) = encode_inline_or_offload(capped_resp);
        let server_tls_ver = conn_meta.as_ref().and_then(|m| m.tls_version.as_deref());
        let is_tls = scheme.eq_ignore_ascii_case("https")
            || conn_meta.as_ref().is_some_and(|m| m.is_tls);
        let detail = SessionDetail {
            summary,
            request_headers: req_headers,
            response_headers: resp_headers,
            request_body_base64: req_b64,
            response_body_base64: resp_b64,
            request_body_text: req_txt,
            response_body_text: resp_txt,
            tls_version: if is_tls {
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

        in_flight_guard.disarm();
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
