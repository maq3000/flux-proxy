use std::net::SocketAddr;
use std::time::Instant;

use base64::Engine as _;
use bytes::Bytes;
use http::header::CONTENT_TYPE;
use http::{Request, Response, StatusCode};
use hyper::body::Incoming;

use crate::models::{HeaderPair, SessionDetail, SessionSummary};
use crate::proxy::network::{is_host_own_ip, normalize_client_ip};
use crate::proxy::process::ClientProcessInfo;

use super::{
    boxed_full, extract_hyper_headers, is_loopback_ip, is_unspecified_ip,
    parse_host_and_optional_port, parse_ip_including_mapped_and_shorthand, plain_response,
    resolve_protocol_label, ProxyBoxBody, SharedProxyContext,
};

pub(super) fn is_virtual_portal_domain(host: &str) -> bool {
    let clean = host
        .trim()
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    matches!(
        clean.as_str(),
        "flux.proxy" | "cert.flux.proxy" | "fluxproxy.local"
    )
}

pub(super) fn is_builtin_portal_target(
    host_header: &str,
    is_direct_origin_http: bool,
    active_listener_port: u16,
) -> bool {
    if is_direct_origin_http {
        return true;
    }
    let (host_only, maybe_port) = parse_host_and_optional_port(host_header);
    let host_clean = host_only.trim_end_matches('.');
    if is_virtual_portal_domain(host_clean) {
        return true;
    }
    if active_listener_port > 0 && maybe_port == Some(active_listener_port) {
        if host_clean == "localhost" || host_clean.ends_with(".localhost") {
            return true;
        }
        if let Some(ip) = parse_ip_including_mapped_and_shorthand(host_clean) {
            if is_loopback_ip(ip) || is_unspecified_ip(ip) || is_host_own_ip(ip) {
                return true;
            }
        }
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PortalAssetKind {
    HtmlLanding,
    AppleMobileConfig,
    X509CrtPem,
    PemFile,
    DerBinary,
}

pub(super) fn select_portal_asset(path: &str, query: &str, user_agent: &str) -> PortalAssetKind {
    let clean_path = path.trim_end_matches('/').to_ascii_lowercase();
    let q_lower = query.to_ascii_lowercase();

    if q_lower.contains("format=mobileconfig") || q_lower.contains("os=ios") {
        return PortalAssetKind::AppleMobileConfig;
    }
    if q_lower.contains("format=der") {
        return PortalAssetKind::DerBinary;
    }
    if q_lower.contains("format=pem") {
        return PortalAssetKind::PemFile;
    }
    if q_lower.contains("format=crt") {
        return PortalAssetKind::X509CrtPem;
    }

    match clean_path.as_str() {
        "/ca.mobileconfig"
        | "/cert.mobileconfig"
        | "/fluxproxy.mobileconfig"
        | "/fluxproxy-root-ca.mobileconfig"
        | "/ios"
        | "/profile" => PortalAssetKind::AppleMobileConfig,
        "/ca.crt" | "/cert.crt" | "/fluxproxy-root-ca.crt" | "/android" => {
            PortalAssetKind::X509CrtPem
        }
        "/ca.pem" | "/cert.pem" | "/fluxproxy-root-ca.pem" => PortalAssetKind::PemFile,
        "/ca.der" | "/ca.cer" | "/cert.der" | "/cert.cer" | "/fluxproxy-root-ca.der"
        | "/fluxproxy-root-ca.cer" => PortalAssetKind::DerBinary,
        "/cert" => {
            let ua = user_agent.to_ascii_lowercase();
            let is_ios = ua.contains("iphone")
                || ua.contains("ipad")
                || ua.contains("ipod")
                || (ua.contains("macintosh") && ua.contains("mobile"));
            if is_ios {
                PortalAssetKind::AppleMobileConfig
            } else {
                PortalAssetKind::X509CrtPem
            }
        }
        _ => PortalAssetKind::HtmlLanding,
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn handle_builtin_portal_request(
    req: Request<Incoming>,
    session_id: u64,
    scheme_str: &str,
    host_header: &str,
    path_and_query: &str,
    full_url: &str,
    alpn: Option<&str>,
    start: Instant,
    timestamp: String,
    client_addr: SocketAddr,
    client_proc: Option<&ClientProcessInfo>,
    ctx: &SharedProxyContext,
) -> Response<ProxyBoxBody> {
    let raw_path = req.uri().path();
    if raw_path.eq_ignore_ascii_case("/favicon.ico") {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(boxed_full(Bytes::new()))
            .unwrap();
    }
    if raw_path.trim_end_matches('/').eq_ignore_ascii_case("/health") {
        return Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "application/json")
            .header("Cache-Control", "no-store, no-cache, must-revalidate")
            .body(boxed_full(Bytes::from_static(br#"{"status":"ok"}"#)))
            .unwrap();
    }

    let query = req.uri().query().unwrap_or("");
    let user_agent = req
        .headers()
        .get(http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let method_str = req.method().as_str().to_string();
    let req_version = req.version();
    let req_headers = extract_hyper_headers(req.headers());
    let client_ip_str = normalize_client_ip(client_addr);

    let asset = select_portal_asset(raw_path, query, user_agent);
    let (content_type, disposition, resp_bytes): (&str, Option<&str>, Bytes) = match asset {
        PortalAssetKind::AppleMobileConfig => (
            "application/x-apple-aspen-config",
            Some("attachment; filename=\"fluxproxy-root-ca.mobileconfig\""),
            Bytes::from(ctx.ca.root_ca_mobileconfig().into_bytes()),
        ),
        PortalAssetKind::X509CrtPem => (
            "application/x-x509-ca-cert",
            Some("attachment; filename=\"fluxproxy-root-ca.crt\""),
            Bytes::from(ctx.ca.root_ca_pem().as_bytes().to_vec()),
        ),
        PortalAssetKind::PemFile => (
            "application/x-pem-file",
            Some("attachment; filename=\"fluxproxy-root-ca.pem\""),
            Bytes::from(ctx.ca.root_ca_pem().as_bytes().to_vec()),
        ),
        PortalAssetKind::DerBinary => (
            "application/x-x509-ca-cert",
            Some("attachment; filename=\"fluxproxy-root-ca.der\""),
            Bytes::from(ctx.ca.root_ca_der().to_vec()),
        ),
        PortalAssetKind::HtmlLanding => {
            let info = ctx.ca.info();
            let html = render_mobile_portal_html(&client_ip_str, host_header, &info.sha256_fingerprint, user_agent);
            ("text/html; charset=utf-8", None, Bytes::from(html.into_bytes()))
        }
    };

    let mut resp_headers = vec![
        HeaderPair {
            name: "Content-Type".into(),
            value: content_type.into(),
        },
        HeaderPair {
            name: "Cache-Control".into(),
            value: "no-store, no-cache, must-revalidate".into(),
        },
        HeaderPair {
            name: "X-Content-Type-Options".into(),
            value: "nosniff".into(),
        },
    ];
    if let Some(disp) = disposition {
        resp_headers.push(HeaderPair {
            name: "Content-Disposition".into(),
            value: disp.into(),
        });
    }

    let protocol_label = resolve_protocol_label(scheme_str, alpn, req_version);
    let summary = SessionSummary {
        id: session_id,
        status: 200,
        protocol: protocol_label,
        scheme: scheme_str.to_string(),
        method: method_str,
        host: host_header.to_string(),
        path: path_and_query.to_string(),
        url: full_url.to_string(),
        content_type: content_type.to_string(),
        body_size: resp_bytes.len(),
        duration_ms: start.elapsed().as_millis() as u64,
        timestamp,
        is_mocked: false,
        matched_rule_id: None,
        error: None,
        process_name: client_proc.map(|p| p.name.clone()),
        process_pid: client_proc.map(|p| p.pid),
        tls_bypassed: false,
        headers_mutated: false,
        breakpoint_paused: None,
        breakpoint_modified: false,
        comment: None,
        marked_color: None,
        client_ip: Some(client_ip_str),
    };

    let detail = SessionDetail {
        summary: summary.clone(),
        request_headers: req_headers,
        response_headers: resp_headers.clone(),
        request_body_base64: String::new(),
        response_body_base64: base64::engine::general_purpose::STANDARD.encode(&resp_bytes),
        request_body_text: None,
        response_body_text: std::str::from_utf8(&resp_bytes).ok().map(str::to_owned),
        tls_version: if scheme_str == "https" {
            Some("TLS 1.3 (FluxProxy Portal)".into())
        } else {
            None
        },
        client_addr: client_addr.to_string(),
        websocket_frames: Vec::new(),
        sse_events: Vec::new(),
        body_offloaded: false,
        request_body_offloaded: false,
    };

    ctx.store.insert(detail);
    let _ = ctx.event_tx.send(summary);

    let mut builder = Response::builder().status(StatusCode::OK);
    for h in &resp_headers {
        builder = builder.header(&h.name, &h.value);
    }
    builder
        .body(boxed_full(resp_bytes))
        .unwrap_or_else(|_| plain_response(StatusCode::INTERNAL_SERVER_ERROR, "Portal build error"))
}

pub(crate) fn escape_html(raw: &str) -> String {
    let mut escaped = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

pub(super) fn render_mobile_portal_html(
    client_ip: &str,
    host_header: &str,
    fingerprint: &str,
    user_agent: &str,
) -> String {
    let ua = user_agent.to_ascii_lowercase();
    let is_ios = ua.contains("iphone")
        || ua.contains("ipad")
        || ua.contains("ipod")
        || (ua.contains("macintosh") && ua.contains("mobile"));
    let is_android = ua.contains("android");

    let client_ip = escape_html(client_ip);
    let host_header = escape_html(host_header);
    let fingerprint = escape_html(fingerprint);
    let _user_agent_escaped = escape_html(user_agent);

    let detected_badge = if is_ios {
        "Определено устройство: iOS / iPadOS"
    } else if is_android {
        "Определено устройство: Android"
    } else {
        "Подключение к FluxProxy активно"
    };

    let ios_btn_class = if is_ios || !is_android { "btn btn-primary" } else { "btn btn-secondary" };
    let android_btn_class = if is_android { "btn btn-primary" } else { "btn btn-secondary" };

    format!(
        r#"<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FluxProxy — Установка Root CA сертификата</title>
  <style>
    :root {{
      color-scheme: dark light;
      --bg: #0b0f17;
      --card: #131a26;
      --border: #253247;
      --fg: #f1f5f9;
      --muted: #94a3b8;
      --accent: #3b82f6;
      --accent-fg: #ffffff;
      --ok-bg: rgba(16, 185, 129, 0.14);
      --ok-fg: #34d399;
    }}
    @media (prefers-color-scheme: light) {{
      :root {{
        --bg: #f8fafc;
        --card: #ffffff;
        --border: #e2e8f0;
        --fg: #0f172a;
        --muted: #475569;
        --accent: #2563eb;
        --ok-bg: rgba(16, 185, 129, 0.12);
        --ok-fg: #059669;
      }}
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      padding: 20px 16px 40px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.5;
    }}
    .wrap {{ max-width: 540px; margin: 0 auto; }}
    .card {{
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 22px 20px;
      margin-bottom: 16px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
    }}
    .pill {{
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: var(--ok-bg);
      color: var(--ok-fg);
      margin-bottom: 10px;
    }}
    h1 {{ margin: 0 0 6px; font-size: 22px; letter-spacing: -0.02em; }}
    h2 {{ margin: 0 0 10px; font-size: 15px; }}
    p {{ margin: 0 0 14px; font-size: 14px; color: var(--muted); }}
    .meta {{
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      color: var(--muted);
      margin-bottom: 16px;
      word-break: break-all;
    }}
    .actions {{ display: flex; flex-direction: column; gap: 10px; }}
    .btn {{
      display: block;
      text-align: center;
      text-decoration: none;
      padding: 13px 16px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 15px;
      transition: opacity 0.15s;
    }}
    .btn:active {{ opacity: 0.8; }}
    .btn-primary {{
      background: var(--accent);
      color: var(--accent-fg);
    }}
    .btn-secondary {{
      border: 1px solid var(--border);
      color: var(--fg);
      background: transparent;
    }}
    .alt-links {{
      margin-top: 12px;
      display: flex;
      gap: 14px;
      justify-content: center;
      font-size: 13px;
    }}
    .alt-links a {{ color: var(--accent); text-decoration: none; font-weight: 500; }}
    ol {{ margin: 0; padding-left: 20px; font-size: 13.5px; color: var(--muted); }}
    li {{ margin-bottom: 8px; }}
    strong {{ color: var(--fg); }}
    code {{
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      padding: 1px 5px;
      border-radius: 4px;
      border: 1px solid var(--border);
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="pill">● {detected_badge}</div>
      <h1>FluxProxy Root CA</h1>
      <p>Установите корневой сертификат для расшифровки HTTPS и WSS трафика с вашего устройства.</p>
      <div class="meta">Client IP: <strong>{client_ip}</strong> • Proxy: <strong>{host_header}</strong></div>
      <div class="actions">
        <a class="{ios_btn_class}" href="/ca.mobileconfig">Установить профиль iOS / iPadOS (.mobileconfig)</a>
        <a class="{android_btn_class}" href="/ca.crt">Скачать сертификат Android / Desktop (.crt)</a>
      </div>
      <div class="alt-links">
        <a href="/cert">Авто (/cert)</a>
        <a href="/ca.der">DER (.der)</a>
        <a href="/ca.pem">PEM (.pem)</a>
      </div>
    </div>

    <div class="card">
      <h2>iOS / iPadOS (Safari)</h2>
      <ol>
        <li>Нажмите <strong>Установить профиль iOS (.mobileconfig)</strong> выше и подтвердите <strong>Разрешить</strong> в Safari.</li>
        <li>Откройте <strong>Настройки → Профиль загружен</strong> и нажмите <strong>Установить</strong>.</li>
        <li>Перейдите в <strong>Настройки → Основные → Об этом устройстве → Доверие сертификатам</strong> и включите тумблер для <strong>FluxProxy Local Debugging Root CA</strong>.</li>
      </ol>
    </div>

    <div class="card">
      <h2>Android</h2>
      <ol>
        <li>Нажмите <strong>Скачать сертификат Android (.crt)</strong>.</li>
        <li>Откройте <strong>Настройки → Безопасность → Шифрование и учетные данные → Установить сертификат → Сертификат CA</strong> (нажмите «Все равно установить») и выберите скачанный файл.</li>
        <li>Для отладки собственных приложений на Android 7+ добавьте <code>&lt;certificates src="user" /&gt;</code> в <code>res/xml/network_security_config.xml</code>.</li>
      </ol>
      <div class="meta" style="margin-top:12px;margin-bottom:0">SHA-256: {fingerprint}</div>
    </div>
  </div>
</body>
</html>
"#
    )
}
