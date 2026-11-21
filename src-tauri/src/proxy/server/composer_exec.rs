use std::time::{Duration, Instant};

use base64::Engine as _;
use chrono::Utc;

use crate::models::{
    BreakpointStage, ComposedRequest, HeaderMutationDirection, ProxyError, RuleActionType,
    SessionDetail, SessionSummary,
};

use super::http_handler::{
    build_autoresponder_mock_detail, format_error_chain, maybe_decompress_content_encodings,
    parse_sse_events_from_bytes, run_request_breakpoint_stage, run_response_breakpoint_stage,
    send_upstream_with_retry, AutoResponderMockInput, RequestBreakpointStageInput,
    ResponseBreakpointStageInput,
};
use super::{
    encode_inline_or_offload, extract_reqwest_headers, format_http_version,
    record_completed_session, record_error_session, record_in_flight_session,
    ProxyEngineController, MAX_CAPTURED_BODY_BYTES,
};

impl ProxyEngineController {
    /// Executes a request crafted in the Composer tab and records it into the Traffic Viewer.
    pub async fn execute_composed(&self, composed: ComposedRequest) -> Result<SessionDetail, ProxyError> {
        let start = Instant::now();
        let timestamp = Utc::now().to_rfc3339();
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

        let parsed_initial = reqwest::Url::parse(&full_url)
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
            if run_request_breakpoint_stage(
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
            .await
            .is_err()
            {
                let proto = if scheme == "https" {
                    "HTTPS/2".to_string()
                } else {
                    "HTTP/1.1".to_string()
                };
                record_error_session(
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
                    "Request aborted at Live Breakpoint",
                );
                return Err(ProxyError::Custom(
                    "Request aborted at Live Breakpoint".into(),
                ));
            }
        }

        let parsed_url = reqwest::Url::parse(&full_url)
            .map_err(|e| ProxyError::Custom(format!("Invalid URL '{full_url}': {e}")))?;
        let method = reqwest::Method::from_bytes(method_str.as_bytes())
            .map_err(|e| ProxyError::Custom(format!("Invalid HTTP method: {e}")))?;

        // Check AutoResponder rules for composed requests too
        if let Some(rule) =
            self.context
                .rules
                .find_matching_rule(&method_str, &full_url, &req_headers)
        {
            if rule.latency_ms > 0 {
                tokio::time::sleep(Duration::from_millis(rule.latency_ms)).await;
            }
            if matches!(rule.action, RuleActionType::MockResponse) {
                let (detail, _, mock_bytes) = build_autoresponder_mock_detail(
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
        let target_host = parsed_url.host_str().unwrap_or(&host).to_string();
        let (client, mtls_cn) = if scheme.eq_ignore_ascii_case("https") {
            match self
                .context
                .client_certs
                .get_or_build_client(&target_host, composed.follow_redirects)
            {
                Ok(Some((mtls_client, entry))) => (mtls_client, Some(entry.common_name)),
                Ok(None) => (
                    if composed.follow_redirects {
                        self.context.upstream_redirect_client.clone()
                    } else {
                        self.context.upstream_client.clone()
                    },
                    None,
                ),
                Err(err) => {
                    let err_msg =
                        format!("Client certificate (mTLS) error for '{target_host}': {err}");
                    record_error_session(
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
                        &err_msg,
                    );
                    return Err(ProxyError::Custom(err_msg));
                }
            }
        } else if composed.follow_redirects {
            (self.context.upstream_redirect_client.clone(), None)
        } else {
            (self.context.upstream_client.clone(), None)
        };

        let in_flight_tls = if scheme == "https" {
            Some(match &mtls_cn {
                Some(cn) => format!("TLS 1.3 (Composer · mTLS: {cn})"),
                None => "TLS 1.3 (Composer)".to_string(),
            })
        } else {
            None
        };
        record_in_flight_session(
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
        );

        let upstream_resp = match send_upstream_with_retry(&client, &method, |c| {
            let mut builder = c.request(method.clone(), parsed_url.clone());
            for h in &req_headers {
                if !h.name.trim().is_empty() && !h.name.eq_ignore_ascii_case("content-length") {
                    builder = builder.header(&h.name, &h.value);
                }
            }
            if !req_bytes.is_empty() {
                builder = builder.body(req_bytes.clone());
            }
            builder
        })
        .await
        {
            Ok(resp) => resp,
            Err(err) => {
                let chain = format_error_chain(&err);
                record_error_session(
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
                    &format!("Upstream connection error: {chain}"),
                );
                return Err(err.into());
            }
        };

        let mut status = upstream_resp.status().as_u16();
        let version_str = format_http_version(&scheme, upstream_resp.version());
        let mut resp_headers = extract_reqwest_headers(upstream_resp.headers());
        let mut resp_mutated = self.context.filters.apply_header_mutations(
            HeaderMutationDirection::Response,
            &full_url,
            &mut resp_headers,
        );
        let raw_resp_bytes = match upstream_resp.bytes().await {
            Ok(b) => b,
            Err(err) => {
                let chain = format_error_chain(&err);
                record_error_session(
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
                    &format!("Failed reading upstream response body: {chain}"),
                );
                return Err(err.into());
            }
        };
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
            if bp_outcome.aborted {
                record_error_session(
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
                    "Response aborted at Live Breakpoint",
                );
                return Err(ProxyError::Custom(
                    "Response aborted at Live Breakpoint".into(),
                ));
            }
        }

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

        let summary = SessionSummary {
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
        };

        let capped_req = &req_bytes[..req_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
        let capped_resp = &resp_bytes[..resp_bytes.len().min(MAX_CAPTURED_BODY_BYTES)];
        let (req_b64, req_txt, req_offloaded) = encode_inline_or_offload(capped_req);
        let (resp_b64, resp_txt, resp_offloaded) = encode_inline_or_offload(capped_resp);
        let detail = SessionDetail {
            summary,
            request_headers: req_headers,
            response_headers: resp_headers,
            request_body_base64: req_b64,
            response_body_base64: resp_b64,
            request_body_text: req_txt,
            response_body_text: resp_txt,
            tls_version: if scheme == "https" {
                Some(match &mtls_cn {
                    Some(cn) => format!("TLS 1.3 (Composer · mTLS: {cn})"),
                    None => "TLS 1.3".to_string(),
                })
            } else {
                None
            },
            client_addr: "Composer (Local)".into(),
            websocket_frames: Vec::new(),
            sse_events,
            body_offloaded: resp_offloaded,
            request_body_offloaded: req_offloaded,
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
