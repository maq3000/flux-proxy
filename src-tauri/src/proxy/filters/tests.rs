use super::*;
use super::parsers::*;

#[test]
fn matches_wildcard_and_exact_tls_bypass_domains() {
    let engine = ProxyFilterEngine::new();
    assert!(engine.match_tls_bypass("p12-buy.itunes.apple.com", 443).is_some());
    assert!(engine.match_tls_bypass("apple.com", 443).is_some());
    assert!(engine.match_tls_bypass("web.telegram.org", 443).is_some());
    assert!(engine.match_tls_bypass("api.stripe.com", 443).is_none());
}

#[test]
fn targeted_only_mode_inspects_allowlist_and_passes_through_everything_else() {
    let engine = ProxyFilterEngine::new();
    let mut cfg = engine.get_config();
    cfg.tls_intercept_mode = TlsInterceptMode::TargetedOnly;
    cfg.tls_target_rules = vec![
        TlsBypassRule {
            id: "target-corp".into(),
            enabled: true,
            pattern: "*.mycompany.com, https://api.test.ru/v1".into(),
            category: "Target Allowlist".into(),
            description: "Inspect corporate and test services only".into(),
        },
        TlsBypassRule {
            id: "exclude-mtls".into(),
            enabled: true,
            pattern: "!mtls.mycompany.com".into(),
            category: "Exception".into(),
            description: "Carve out mTLS endpoint from wildcard target".into(),
        },
    ];
    engine.update_config(cfg);

    // Allowlisted hosts -> InterceptMitm
    assert_eq!(
        engine.evaluate_connect_tunnel("app.mycompany.com", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("mycompany.com", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("api.test.ru", 443),
        ConnectTunnelDecision::InterceptMitm
    );

    // Carved-out subdomain via `!mtls.mycompany.com` -> Passthrough
    assert_eq!(
        engine.evaluate_connect_tunnel("mtls.mycompany.com", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::NotInTargetAllowlist)
    );

    // Unlisted 3rd-party services (Telegram, Steam, Teams, banking) -> Passthrough
    for host in [
        "kws2.web.telegram.org",
        "api.steampowered.com",
        "teams.microsoft.com",
        "online.sberbank.ru",
    ] {
        assert_eq!(
            engine.evaluate_connect_tunnel(host, 443),
            ConnectTunnelDecision::Passthrough(PassthroughReason::NotInTargetAllowlist),
            "expected {host} to be pure TCP passthrough in TargetedOnly mode"
        );
    }
}

#[test]
fn negative_carve_out_allows_inspecting_single_host_in_intercept_all_mode() {
    let engine = ProxyFilterEngine::new();
    let mut cfg = engine.get_config();
    cfg.tls_bypass_rules.push(TlsBypassRule {
        id: "inspect-web-telegram".into(),
        enabled: true,
        pattern: "!web.telegram.org".into(),
        category: "Override".into(),
        description: "Inspect web.telegram.org despite *.telegram.org bypass".into(),
    });
    engine.update_config(cfg);

    assert_eq!(
        engine.evaluate_connect_tunnel("web.telegram.org", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert!(matches!(
        engine.evaluate_connect_tunnel("kws4.web.telegram.org", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
    ));
}

#[test]
fn mutates_headers_for_cache_bypass_and_user_agent() {
    let engine = ProxyFilterEngine::new();
    let mut cfg = engine.get_config();
    for rule in &mut cfg.header_mutations {
        rule.enabled = true;
    }
    engine.update_config(cfg);

    let mut req_headers = vec![
        HeaderPair::new("User-Agent", "OldBrowser/1.0"),
        HeaderPair::new("If-Modified-Since", "Wed, 21 Oct 2026 07:28:00 GMT"),
        HeaderPair::new("If-None-Match", "\"abc-123\""),
    ];

    let changed = engine.apply_header_mutations(
        HeaderMutationDirection::Request,
        "https://api.example.com/v1/items",
        &mut req_headers,
    );
    assert!(changed);
    assert_eq!(req_headers.len(), 1);
    assert_eq!(req_headers[0].name, "User-Agent");
    assert!(req_headers[0].value.contains("iPhone"));

    let mut resp_headers = vec![
        HeaderPair::new("ETag", "\"abc-123\""),
        HeaderPair::new("Content-Type", "application/json"),
    ];
    let resp_changed = engine.apply_header_mutations(
        HeaderMutationDirection::Response,
        "https://api.example.com/v1/items",
        &mut resp_headers,
    );
    assert!(resp_changed);
    assert!(!resp_headers.iter().any(|h| h.name.eq_ignore_ascii_case("etag")));
    assert!(resp_headers
        .iter()
        .any(|h| h.name.eq_ignore_ascii_case("access-control-allow-origin")));
}

#[test]
fn tokenizes_bulk_host_list_with_comments_delimiters_and_regex() {
    let raw = r#"
        # Вставьте домены, пути или маски:
        // Комментарий в стиле C
        *.my-api.com, api.partner.org; domain.com:8080 # inline comment
        https://auth.internal.corp:8443 // trailing comment
        regex:^https:\/\/(dev|stage)\.app\.com(:[0-9]{1,5})?
    "#;
    let tokens = tokenize_host_list_input(raw);
    assert_eq!(
        tokens,
        vec![
            "*.my-api.com",
            "api.partner.org",
            "domain.com:8080",
            "https://auth.internal.corp:8443",
            r"regex:^https:\/\/(dev|stage)\.app\.com(:[0-9]{1,5})?",
        ]
    );
}

#[test]
fn bulk_host_list_blacklist_sync_bypasses_whole_hosts_and_preserves_subpath_mitm() {
    let engine = ProxyFilterEngine::new();
    let mut cfg = engine.get_config();
    cfg.host_list_sync = HostListBackendSyncConfig {
        enabled: true,
        mode: HostListFilterMode::Blacklist,
        raw_text: r#"
            # Blacklist + TLS Passthrough
            *.my-api.com
            api.partner.org
            https://auth.internal.corp:8443
            api.*.company.ru/*
            partial.service.io/healthz
            regex:^https:\/\/(dev|stage)\.app\.com
        "#
        .into(),
    };
    engine.update_config(cfg);

    assert!(matches!(
        engine.evaluate_connect_tunnel("v2.my-api.com", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
    ));
    assert!(matches!(
        engine.evaluate_connect_tunnel("api.partner.org", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
    ));
    assert!(matches!(
        engine.evaluate_connect_tunnel("auth.internal.corp", 8443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
    ));
    // Different port should NOT match explicit :8443 rule
    assert_eq!(
        engine.evaluate_connect_tunnel("auth.internal.corp", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    // `api.*.company.ru/*` covers whole host path `/*` -> bypasses CONNECT
    assert!(matches!(
        engine.evaluate_connect_tunnel("api.eu.company.ru", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
    ));
    // `partial.service.io/healthz` is sub-path only -> keep MITM so other paths remain inspectable
    assert_eq!(
        engine.evaluate_connect_tunnel("partial.service.io", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    // `regex:` rule matching https://stage.app.com
    assert!(matches!(
        engine.evaluate_connect_tunnel("stage.app.com", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
    ));
}

#[test]
fn bulk_host_list_whitelist_sync_intercepts_listed_hosts_and_passes_through_others() {
    let engine = ProxyFilterEngine::new();
    let mut cfg = engine.get_config();
    cfg.host_list_sync = HostListBackendSyncConfig {
        enabled: true,
        mode: HostListFilterMode::Whitelist,
        raw_text: r#"
            *.my-api.com; api.partner.org
            https://auth.internal.corp:8443
            api.*.company.ru/v1/*
            regex:^https:\/\/(dev|stage)\.app\.com
        "#
        .into(),
    };
    engine.update_config(cfg);

    assert_eq!(
        engine.evaluate_connect_tunnel("orders.my-api.com", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("api.partner.org", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("auth.internal.corp", 8443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("auth.internal.corp", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::NotInHostsWhitelist)
    );
    // Sub-path rule in Whitelist mode MUST still intercept CONNECT for that host so /v1/* can be inspected
    assert_eq!(
        engine.evaluate_connect_tunnel("api.msk.company.ru", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("dev.app.com", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("telemetry.noise.net", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::NotInHostsWhitelist)
    );
}

#[test]
fn strips_alt_svc_and_alternate_protocol_by_default_even_when_mutations_disabled() {
    let engine = ProxyFilterEngine::new();
    assert!(engine.is_strip_alt_svc_enabled());

    let mut cfg = engine.get_config();
    assert!(cfg.strip_alt_svc);
    cfg.header_mutations_enabled = false;
    engine.update_config(cfg);

    let mut resp_headers = vec![
        HeaderPair::new("Content-Type", "application/json"),
        HeaderPair::new("Alt-Svc", "h3=\":443\"; ma=86400, h3-29=\":443\"; ma=86400"),
        HeaderPair::new("alternate-protocol", "443:quic"),
        HeaderPair::new("Cache-Control", "no-store"),
    ];

    let mutated = engine.apply_header_mutations(
        HeaderMutationDirection::Response,
        "https://www.google.com/search?q=rust",
        &mut resp_headers,
    );
    assert!(mutated);
    assert_eq!(resp_headers.len(), 2);
    assert!(!resp_headers.iter().any(|h| is_alt_svc_header(&h.name)));
    assert_eq!(resp_headers[0].name, "Content-Type");
    assert_eq!(resp_headers[1].name, "Cache-Control");
}

#[test]
fn preserves_alt_svc_headers_when_strip_alt_svc_is_disabled() {
    let engine = ProxyFilterEngine::new();
    let mut cfg = engine.get_config();
    cfg.strip_alt_svc = false;
    engine.update_config(cfg);
    assert!(!engine.is_strip_alt_svc_enabled());

    let mut resp_headers = vec![
        HeaderPair::new("alt-svc", "h3=\":443\"; ma=2592000"),
        HeaderPair::new("Alternate-Protocol", "443:quic,p=1"),
    ];

    let mutated = engine.apply_header_mutations(
        HeaderMutationDirection::Response,
        "https://cloudflare.com/",
        &mut resp_headers,
    );
    assert!(!mutated);
    assert_eq!(resp_headers.len(), 2);

    // Also verify serde backward-compatibility default (`strip_alt_svc = true` when omitted)
    let legacy_json = r#"{
        "tlsInterceptMode": "interceptAll",
        "tlsBypassEnabled": true,
        "tlsBypassRules": [],
        "headerMutationsEnabled": true,
        "headerMutations": []
    }"#;
    let parsed: ProxyFilterBackendConfig =
        serde_json::from_str(legacy_json).expect("deserialize legacy config");
    assert!(parsed.strip_alt_svc);
}

fn make_summary_for_filter(
    method: &str,
    host: &str,
    path: &str,
    status: u16,
    process_name: Option<&str>,
) -> SessionSummary {
    SessionSummary {
        id: 1,
        status,
        protocol: "HTTPS/2".into(),
        scheme: "https".into(),
        method: method.into(),
        host: host.into(),
        path: path.into(),
        url: format!("https://{host}{path}"),
        content_type: "application/json".into(),
        body_size: 256,
        duration_ms: 48,
        timestamp: "2026-11-09T09:00:00Z".into(),
        is_mocked: false,
        matched_rule_id: None,
        error: None,
        process_name: process_name.map(str::to_owned),
        process_pid: Some(1200),
        tls_bypassed: false,
        headers_mutated: false,
        breakpoint_paused: None,
        breakpoint_modified: false,
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
    }
}

#[test]
fn evaluate_should_store_session_drops_os_noise_host_list_and_thresholds() {
    let engine = ProxyFilterEngine::new();

    let svchost_telemetry = make_summary_for_filter(
        "POST",
        "telemetry.microsoft.com",
        "/OneCollector/1.0/",
        200,
        Some("svchost.exe"),
    );
    let api_ok = make_summary_for_filter(
        "GET",
        "api.stripe.com",
        "/v1/payment_intents",
        200,
        Some("node.exe"),
    );
    let not_modified_304 = make_summary_for_filter(
        "GET",
        "api.stripe.com",
        "/v1/config",
        304,
        Some("chrome.exe"),
    );
    let other_host = make_summary_for_filter(
        "GET",
        "ads.example.net",
        "/banner",
        200,
        Some("chrome.exe"),
    );

    // Disabled by default -> everything stored
    assert!(engine.evaluate_should_store_session(&svchost_telemetry));
    assert!(engine.evaluate_should_store_session(&api_ok));

    // Enable Drop Non-Matching -> svchost & telemetry dropped immediately
    engine.set_drop_non_matching(true);
    assert!(engine.is_drop_non_matching_enabled());
    assert!(!engine.evaluate_should_store_session(&svchost_telemetry));
    assert!(engine.evaluate_should_store_session(&api_ok));

    // Activate host-list whitelist (*.stripe.com) + hide 304 threshold
    let mut cfg = engine.get_config();
    cfg.capture_host_list = HostListBackendSyncConfig {
        enabled: true,
        mode: HostListFilterMode::Whitelist,
        raw_text: "*.stripe.com".into(),
    };
    cfg.noise_thresholds.hide_304_not_modified = true;
    engine.update_config(cfg);

    assert!(engine.evaluate_should_store_session(&api_ok));
    assert!(!engine.evaluate_should_store_session(&not_modified_304));
    assert!(!engine.evaluate_should_store_session(&other_host));
    assert!(!engine.evaluate_should_store_session(&svchost_telemetry));
}

#[test]
fn strip_regex_prefix_handles_multibyte_utf8_at_byte_six_and_case_insensitivity() {
    // Multi-byte UTF-8 straddling byte index 6 (Cyrillic 2-byte chars & 4-byte emoji)
    let cyrillic_6_boundary = "приветик.рф"; // 'п'(2) 'р'(2) 'и'(2) -> byte 6, try 5+ byte straddle:
    let cyrillic_straddle = "abвгд.рф"; // 'a'(1) 'b'(1) 'в'(2) 'г'(2..4->4) 'д'(4..6->6), wait: "abcдe" => a(0..1), b(1..2), c(2..3), 'д'(3..5), 'е'(5..7)! Byte 6 is mid-'е'!
    let emoji_straddle = "ab😀cd"; // a(0..1), b(1..2), '😀'(2..6), Wait: "abc😀def" => a(0),b(1),c(2), '😀'(3..7)! Byte 6 is inside '😀'!

    for sample in [cyrillic_6_boundary, "abcдеж", cyrillic_straddle, emoji_straddle, "abc😀def", "пr😀"] {
        assert_eq!(strip_regex_prefix(sample), None);
        assert!(normalize_host_token(sample).is_some());
        assert!(!tokenize_host_list_input(sample).is_empty());
        assert!(!wildcard_or_regex_matches("example.com", sample));
        assert!(!url_scope_matches("https://example.com", "https://example.com", sample));
    }

    // Case-insensitive `regex:` matching across helpers
    assert_eq!(strip_regex_prefix("REGEX:^https://api\\."), Some("^https://api\\."));
    assert_eq!(strip_regex_prefix("ReGeX:.*тест😀"), Some(".*тест😀"));
    assert!(url_scope_matches(
        "https://api.example.com/v1",
        "https://api.example.com/v1",
        "REGEX:^https://api\\.example\\.com/v1$"
    ));
    assert!(wildcard_or_regex_matches(
        "api.example.com",
        "ReGeX:^api\\.example\\.com$"
    ));
}

#[test]
fn evaluate_should_store_session_defers_response_filters_during_in_flight_phase() {
    let engine = ProxyFilterEngine::new();
    let mut cfg = engine.get_config();
    cfg.drop_non_matching_on_capture = true;
    cfg.noise_thresholds.only_slow_requests = true;
    cfg.noise_thresholds.time_heat_warning_ms = 500;
    cfg.noise_thresholds.min_body_size_bytes = Some(100);
    cfg.noise_thresholds.max_body_size_bytes = Some(4096);
    cfg.capture_matrix_enabled = true;
    cfg.capture_filter_rules = vec![
        CaptureFilterRule {
            id: "inc-status".into(),
            enabled: true,
            action: "include".into(),
            logical_op: "AND".into(),
            field: "status".into(),
            operator: "equals".into(),
            value: "200".into(),
        },
        CaptureFilterRule {
            id: "exc-status-204".into(),
            enabled: true,
            action: "exclude".into(),
            logical_op: "AND".into(),
            field: "status".into(),
            operator: "equals".into(),
            value: "204".into(),
        },
        CaptureFilterRule {
            id: "exc-noise-host".into(),
            enabled: true,
            action: "exclude".into(),
            logical_op: "OR".into(),
            field: "host".into(),
            operator: "contains".into(),
            value: "noise.local".into(),
        },
    ];
    engine.update_config(cfg);

    // Phase 1 in-flight API request (status: 0, body_size: 0, duration_ms: 0, content_type: "")
    // must NOT be dropped by status/bodySize/onlySlowRequests rules.
    let mut in_flight_api =
        make_summary_for_filter("POST", "api.example.com", "/v1/orders", 0, Some("node.exe"));
    in_flight_api.content_type = String::new();
    in_flight_api.body_size = 0;
    in_flight_api.duration_ms = 0;
    assert!(engine.evaluate_should_store_session(&in_flight_api));

    // Phase 1 in-flight request to excluded host MUST still be dropped immediately.
    let mut in_flight_noise =
        make_summary_for_filter("GET", "ads.noise.local", "/pixel", 0, Some("chrome.exe"));
    in_flight_noise.content_type = String::new();
    in_flight_noise.body_size = 0;
    in_flight_noise.duration_ms = 0;
    assert!(!engine.evaluate_should_store_session(&in_flight_noise));

    // Phase 1 in-flight OPTIONS preflight MUST still be dropped if hide_options_preflight is set,
    // and fast response in Phase 2 fails `only_slow_requests`.
    let mut fast_200 = in_flight_api.clone();
    fast_200.status = 200;
    fast_200.content_type = "application/json".into();
    fast_200.body_size = 512;
    fast_200.duration_ms = 40;
    assert!(!engine.evaluate_should_store_session(&fast_200));

    // Phase 2 slow 200 within body bounds passes everything.
    let mut slow_200 = fast_200;
    slow_200.duration_ms = 750;
    assert!(engine.evaluate_should_store_session(&slow_200));

    // Phase 2 slow 204 fails include(status==200) and matches exclude(status==204).
    let mut slow_204 = slow_200;
    slow_204.status = 204;
    assert!(!engine.evaluate_should_store_session(&slow_204));
}

#[test]
fn video_cdn_bypass_pack_bypasses_googlevideo_and_notifies_config_watch() {
    let engine = ProxyFilterEngine::new();
    let mut rx = engine.subscribe_config_updates();
    assert_eq!(*rx.borrow(), 0);

    let mut cfg = engine.get_config();
    cfg.tls_bypass_enabled = true;
    cfg.tls_bypass_rules.push(TlsBypassRule {
        id: "pack-video-cdn".into(),
        enabled: true,
        pattern: "*.googlevideo.com, *.youtube.com, *.ytimg.com, *.ggpht.com, *.ttvnw.net, *.vimeocdn.com".into(),
        category: "Video & CDN".into(),
        description: "Video streaming & CDN passthrough".into(),
    });
    engine.update_config(cfg);

    assert!(rx.has_changed().unwrap());
    assert_eq!(*rx.borrow_and_update(), 1);

    for host in [
        "rr1---sn-n8v7zn7d.googlevideo.com",
        "www.youtube.com",
        "i.ytimg.com",
        "yt3.ggpht.com",
        "video-weaver.ams01.hls.ttvnw.net",
        "skyfire.vimeocdn.com",
    ] {
        assert!(
            matches!(
                engine.evaluate_connect_tunnel(host, 443),
                ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
            ),
            "expected video/CDN host {host} to enter TLS Passthrough"
        );
    }
    assert_eq!(
        engine.evaluate_connect_tunnel("api.myservice.dev", 443),
        ConnectTunnelDecision::InterceptMitm
    );
}

#[test]
fn host_list_whitelist_and_targeted_only_priority_match_preview_contract() {
    let engine = ProxyFilterEngine::new();
    let mut cfg = engine.get_config();
    cfg.tls_intercept_mode = TlsInterceptMode::TargetedOnly;
    cfg.host_list_sync = HostListBackendSyncConfig {
        enabled: true,
        mode: HostListFilterMode::Whitelist,
        raw_text: "*.mycompany.com\n*.othercorp.com".into(),
    };
    cfg.tls_target_rules = vec![
        TlsBypassRule {
            id: "target-api".into(),
            enabled: true,
            pattern: "api.mycompany.com, *.mycompany.com, !mtls.mycompany.com".into(),
            category: "Target".into(),
            description: "Restrict TargetedOnly allowlist within Whitelist".into(),
        },
    ];
    engine.update_config(cfg.clone());

    // Matched by BOTH Whitelist and TargetedOnly -> InterceptMitm
    assert_eq!(
        engine.evaluate_connect_tunnel("api.mycompany.com", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    // Matched by Whitelist, carved out via `!mtls.mycompany.com` in TargetedOnly -> NotInTargetAllowlist
    assert_eq!(
        engine.evaluate_connect_tunnel("mtls.mycompany.com", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::NotInTargetAllowlist)
    );
    // Matched by Whitelist (`*.othercorp.com`), but outside active TargetedOnly allowlist -> NotInTargetAllowlist
    assert_eq!(
        engine.evaluate_connect_tunnel("cdn.othercorp.com", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::NotInTargetAllowlist)
    );
    // Outside Whitelist -> NotInHostsWhitelist
    assert_eq!(
        engine.evaluate_connect_tunnel("external.example.org", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::NotInHostsWhitelist)
    );

    // When TargetedOnly has no enabled rules, active Hosts Whitelist supplies the allowlist
    cfg.tls_target_rules.clear();
    engine.update_config(cfg);
    assert_eq!(
        engine.evaluate_connect_tunnel("cdn.othercorp.com", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("external.example.org", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::NotInHostsWhitelist)
    );
}

#[test]
fn default_tls_bypass_rules_cover_critical_pki_ocsp_crl_and_messengers() {
    let rules = default_tls_bypass_rules();
    let pki_rule = rules
        .iter()
        .find(|r| r.id == "bypass-pki-ocsp-crl")
        .expect("default PKI/OCSP/CRL rule should exist");
    for token in [
        "ocsp.*",
        "crl.*",
        "*.digicert.com",
        "*.sectigo.com",
        "*.letsencrypt.org",
        "ocsp.apple.com",
    ] {
        assert!(
            pki_rule.pattern.contains(token),
            "expected PKI rule pattern to contain {token}"
        );
    }

    let engine = ProxyFilterEngine::new();
    for host in [
        "ocsp.digicert.com",
        "crl.sectigo.com",
        "ocsp.int-x3.letsencrypt.org",
        "ocsp.apple.com",
        "ocsp.custom-ca.org",
        "crl.custom-ca.org",
        "web.whatsapp.com",
        "signal.org",
    ] {
        assert!(
            matches!(
                engine.evaluate_connect_tunnel(host, 443),
                ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
            ),
            "expected default bypass rules to passthrough {host}"
        );
    }
}

#[test]
fn evaluates_connect_tunnel_and_increments_lock_free_hit_counts_for_bypass_and_target_rules() {
    let engine = ProxyFilterEngine::new();

    // InterceptAll mode: hit bypass rules and unmatched MITM host
    assert!(matches!(
        engine.evaluate_connect_tunnel("ocsp.digicert.com", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
    ));
    assert!(matches!(
        engine.evaluate_connect_tunnel("crl.sectigo.com", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
    ));
    assert!(matches!(
        engine.evaluate_connect_tunnel("web.telegram.org", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
    ));
    assert_eq!(
        engine.evaluate_connect_tunnel("api.unmatched.example", 443),
        ConnectTunnelDecision::InterceptMitm
    );

    let counts = engine.get_tls_rule_hit_counts();
    assert_eq!(counts.get("bypass-pki-ocsp-crl").copied(), Some(2));
    assert_eq!(counts.get("bypass-messengers").copied(), Some(1));
    assert_eq!(counts.len(), 2);

    // TargetedOnly mode: hit tls_target_rules
    let mut cfg = engine.get_config();
    cfg.tls_intercept_mode = TlsInterceptMode::TargetedOnly;
    cfg.tls_target_rules = vec![TlsBypassRule {
        id: "target-payments".into(),
        enabled: true,
        pattern: "*.mycompany.com".into(),
        category: "Target".into(),
        description: "Inspect corporate API".into(),
    }];
    engine.update_config(cfg);

    assert_eq!(
        engine.evaluate_connect_tunnel("api.mycompany.com", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("other.example.net", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::NotInTargetAllowlist)
    );

    let counts_after = engine.get_tls_rule_hit_counts();
    assert_eq!(counts_after.get("target-payments").copied(), Some(1));
    assert_eq!(counts_after.get("bypass-pki-ocsp-crl").copied(), Some(2));
}

#[test]
fn reset_tls_bypass_rules_to_recommended_restores_defaults_and_preserves_other_settings() {
    let engine = ProxyFilterEngine::new();
    let mut cfg = engine.get_config();
    cfg.tls_bypass_enabled = false;
    cfg.tls_bypass_rules.clear();
    cfg.tls_target_rules = vec![TlsBypassRule {
        id: "custom-target".into(),
        enabled: true,
        pattern: "api.keep-me.dev".into(),
        category: "Target Service".into(),
        description: "Preserve custom target rule".into(),
    }];
    engine.update_config(cfg);

    let reset_cfg = engine.reset_tls_bypass_rules_to_recommended();
    assert!(reset_cfg.tls_bypass_enabled);
    assert_eq!(reset_cfg.tls_bypass_rules, default_tls_bypass_rules());
    assert_eq!(reset_cfg.tls_target_rules.len(), 1);
    assert_eq!(reset_cfg.tls_target_rules[0].id, "custom-target");

    let stored = engine.get_config();
    assert!(stored.tls_bypass_enabled);
    assert_eq!(stored.tls_bypass_rules, default_tls_bypass_rules());
    assert_eq!(stored.tls_target_rules.len(), 1);
}

#[test]
fn leading_dot_domain_suffix_works_in_host_list_and_capture_host_list() {
    // 1. Bare "." must be ignored and must not create active rules
    let engine = ProxyFilterEngine::new();
    let mut cfg = engine.get_config();
    cfg.tls_bypass_enabled = false;
    cfg.host_list_sync = HostListBackendSyncConfig {
        enabled: true,
        mode: HostListFilterMode::Whitelist,
        raw_text: ".".into(),
    };
    engine.update_config(cfg);
    assert_eq!(engine.state.read().unwrap().compiled_host_list.active_count, 0);
    assert_eq!(
        engine.evaluate_connect_tunnel("example.com", 443),
        ConnectTunnelDecision::InterceptMitm
    );

    // 2. Leading ".example.com" in Blacklist mode bypasses root domain & subdomains, not suffix collisions
    let mut cfg = engine.get_config();
    cfg.host_list_sync = HostListBackendSyncConfig {
        enabled: true,
        mode: HostListFilterMode::Blacklist,
        raw_text: ".example.com\n.\n".into(),
    };
    engine.update_config(cfg);
    assert_eq!(engine.state.read().unwrap().compiled_host_list.active_count, 1);
    assert!(matches!(
        engine.evaluate_connect_tunnel("example.com", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
    ));
    assert!(matches!(
        engine.evaluate_connect_tunnel("api.example.com", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::BypassRule(_))
    ));
    assert_eq!(
        engine.evaluate_connect_tunnel("notexample.com", 443),
        ConnectTunnelDecision::InterceptMitm
    );

    // 3. Leading ".example.com" in Whitelist mode
    let mut cfg = engine.get_config();
    cfg.host_list_sync = HostListBackendSyncConfig {
        enabled: true,
        mode: HostListFilterMode::Whitelist,
        raw_text: ".example.com".into(),
    };
    engine.update_config(cfg);
    assert_eq!(
        engine.evaluate_connect_tunnel("example.com", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("sub.api.example.com", 443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("notexample.com", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::NotInHostsWhitelist)
    );

    // 4. Leading ".example.com" in capture_host_list (Whitelist & Blacklist) and bare "." ignored
    let mut cfg = default_backend_config();
    cfg.drop_non_matching_on_capture = true;
    cfg.capture_host_list = HostListBackendSyncConfig {
        enabled: true,
        mode: HostListFilterMode::Whitelist,
        raw_text: ".example.com\n.\n".into(),
    };
    engine.update_config(cfg);
    assert_eq!(
        engine.state.read().unwrap().compiled_capture_host_list.active_count,
        1
    );

    let root_sum = make_summary_for_filter("GET", "example.com", "/v1", 200, Some("curl.exe"));
    let sub_sum = make_summary_for_filter("GET", "api.example.com", "/v1", 200, Some("curl.exe"));
    let other_sum = make_summary_for_filter("GET", "notexample.com", "/v1", 200, Some("curl.exe"));
    assert!(engine.evaluate_should_store_session(&root_sum));
    assert!(engine.evaluate_should_store_session(&sub_sum));
    assert!(!engine.evaluate_should_store_session(&other_sum));

    let mut cfg = engine.get_config();
    cfg.capture_host_list.mode = HostListFilterMode::Blacklist;
    engine.update_config(cfg);
    assert!(!engine.evaluate_should_store_session(&root_sum));
    assert!(!engine.evaluate_should_store_session(&sub_sum));
    assert!(engine.evaluate_should_store_session(&other_sum));

    let mut cfg = engine.get_config();
    cfg.capture_host_list = HostListBackendSyncConfig {
        enabled: true,
        mode: HostListFilterMode::Whitelist,
        raw_text: ".".into(),
    };
    engine.update_config(cfg);
    assert_eq!(
        engine.state.read().unwrap().compiled_capture_host_list.active_count,
        0
    );
}

#[test]
fn ipv6_hosts_and_ports_parse_consistently_across_all_filter_engines() {
    // 1. Direct authority & token parsers
    assert_eq!(extract_host_from_url_or_authority("[::1]"), "::1");
    assert_eq!(extract_host_from_url_or_authority("[::1]:8443"), "::1");
    assert_eq!(extract_host_from_url_or_authority("::1"), "::1");
    assert_eq!(extract_host_from_url_or_authority("[0:0::1]:8443"), "::1");
    assert_eq!(
        extract_host_from_url_or_authority("https://[::1]:8443/v1"),
        "::1"
    );

    assert_eq!(
        normalize_host_token("[::1]"),
        Some(NormalizedHostToken {
            negated: false,
            pattern: NormalizedHostPattern::HostPort {
                host: "::1".into(),
                port: None,
            },
        })
    );
    assert_eq!(
        normalize_host_token("[::1]:8443"),
        Some(NormalizedHostToken {
            negated: false,
            pattern: NormalizedHostPattern::HostPort {
                host: "::1".into(),
                port: Some("8443".into()),
            },
        })
    );
    assert_eq!(
        normalize_host_token("::1"),
        Some(NormalizedHostToken {
            negated: false,
            pattern: NormalizedHostPattern::HostPort {
                host: "::1".into(),
                port: None,
            },
        })
    );
    assert_eq!(
        normalize_host_token("[0:0::1]:8443"),
        Some(NormalizedHostToken {
            negated: false,
            pattern: NormalizedHostPattern::HostPort {
                host: "::1".into(),
                port: Some("8443".into()),
            },
        })
    );
    assert_eq!(
        normalize_host_token("https://[::1]:8443/v1"),
        Some(NormalizedHostToken {
            negated: false,
            pattern: NormalizedHostPattern::HostPort {
                host: "::1".into(),
                port: Some("8443".into()),
            },
        })
    );

    // 2. TLS bypass rules & `should_intercept_tls`
    let engine = ProxyFilterEngine::new();
    let mut cfg = default_backend_config();
    cfg.tls_bypass_rules = vec![TlsBypassRule {
        id: "ipv6-port-bypass".into(),
        enabled: true,
        pattern: "[::1]:8443".into(),
        category: "Custom".into(),
        description: "IPv6 port bypass".into(),
    }];
    engine.update_config(cfg);

    assert!(!engine.should_intercept_tls("[::1]:8443"));
    assert!(!engine.should_intercept_tls("[0:0::1]:8443"));
    assert!(engine.should_intercept_tls("[::1]:443"));
    assert!(engine.should_intercept_tls("[::1]"));
    assert!(engine.should_intercept_tls("::1"));

    // Any-port IPv6 bypass rule matches both bare `[::1]` and `[::1]:8443`
    let mut cfg = engine.get_config();
    cfg.tls_bypass_rules[0].pattern = "::1".into();
    engine.update_config(cfg);
    assert!(!engine.should_intercept_tls("[::1]"));
    assert!(!engine.should_intercept_tls("::1"));
    assert!(!engine.should_intercept_tls("[::1]:8443"));

    // 3. TargetedOnly allowlist & host_list_sync (including IPv6 synthetic URL regex)
    let mut cfg = default_backend_config();
    cfg.tls_bypass_enabled = false;
    cfg.tls_intercept_mode = TlsInterceptMode::TargetedOnly;
    cfg.tls_target_rules = vec![TlsBypassRule {
        id: "ipv6-target".into(),
        enabled: true,
        pattern: "[::1]:8443".into(),
        category: "Target".into(),
        description: "Target IPv6".into(),
    }];
    engine.update_config(cfg);
    assert!(engine.should_intercept_tls("[::1]:8443"));
    assert!(engine.should_intercept_tls("[0:0::1]:8443"));
    assert!(!engine.should_intercept_tls("[::1]:9443"));

    let mut cfg = default_backend_config();
    cfg.tls_bypass_enabled = false;
    cfg.host_list_sync = HostListBackendSyncConfig {
        enabled: true,
        mode: HostListFilterMode::Whitelist,
        raw_text: "https://[::1]:8443/v1, [2001:db8::1]:9443, regex:^https://\\[fe80::1\\]:8443/".into(),
    };
    engine.update_config(cfg);
    assert_eq!(
        engine.evaluate_connect_tunnel("[0:0::1]", 8443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("[2001:db8::1]", 9443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("fe80::1", 8443),
        ConnectTunnelDecision::InterceptMitm
    );
    assert_eq!(
        engine.evaluate_connect_tunnel("[::1]", 443),
        ConnectTunnelDecision::Passthrough(PassthroughReason::NotInHostsWhitelist)
    );

    // 4. `capture_host_list` IPv6 matching
    let mut cfg = default_backend_config();
    cfg.drop_non_matching_on_capture = true;
    cfg.capture_host_list = HostListBackendSyncConfig {
        enabled: true,
        mode: HostListFilterMode::Whitelist,
        raw_text: "[0:0::1]:8443".into(),
    };
    engine.update_config(cfg);
    let mut ipv6_match = make_summary_for_filter("GET", "[::1]:8443", "/v1", 200, Some("app"));
    ipv6_match.url = "https://[::1]:8443/v1".into();
    let mut ipv6_other_port =
        make_summary_for_filter("GET", "[::1]:9443", "/v1", 200, Some("app"));
    ipv6_other_port.url = "https://[::1]:9443/v1".into();
    assert!(engine.evaluate_should_store_session(&ipv6_match));
    assert!(!engine.evaluate_should_store_session(&ipv6_other_port));
}

#[test]
fn tls_rules_and_header_mutations_precompile_regexes_on_config_update() {
    let engine = ProxyFilterEngine::new();
    {
        let guard = engine.state.read().unwrap();
        let pki_rule = guard
            .compiled_tls_bypass_rules
            .positive_rules
            .iter()
            .find(|r| r.rule.id == "bypass-pki-ocsp-crl")
            .expect("default PKI bypass rule should compile");
        assert!(
            pki_rule
                .positive_tokens
                .iter()
                .any(|t| t.host.has_compiled_regex()),
            "ocsp.*/crl.* wildcards must precompile regexes in FilterEngineState"
        );
    }
    assert!(!engine.should_intercept_tls("ocsp.digicert.com"));
    assert!(!engine.should_intercept_tls("crl.sectigo.com"));

    let mut cfg = default_backend_config();
    cfg.tls_bypass_rules = vec![TlsBypassRule {
        id: "glob-and-regex-bypass".into(),
        enabled: true,
        pattern: "api-*.internal.net, regex:^pinned-[0-9]+\\.local$".into(),
        category: "Custom".into(),
        description: "Precompiled glob + regex bypass".into(),
    }];
    cfg.tls_target_rules = vec![TlsBypassRule {
        id: "glob-target".into(),
        enabled: true,
        pattern: "edge-?.target.dev, regex:^svc-[a-z]+\\.target\\.dev$".into(),
        category: "Target".into(),
        description: "Precompiled glob + regex target".into(),
    }];
    cfg.header_mutations = vec![
        HeaderMutationRule {
            id: "hm-glob-set".into(),
            enabled: true,
            name: "Glob URL Set".into(),
            direction: HeaderMutationDirection::Request,
            operation: HeaderMutationOp::Set,
            header_name: "X-Pre".into(),
            header_value: "glob".into(),
            url_pattern: "https://api.example.com/*/v1".into(),
        },
        HeaderMutationRule {
            id: "hm-regex-append".into(),
            enabled: true,
            name: "Regex URL Append".into(),
            direction: HeaderMutationDirection::Response,
            operation: HeaderMutationOp::Append,
            header_name: "X-Auth".into(),
            header_value: "rx".into(),
            url_pattern: "regex:^https://auth\\.example\\.com/[0-9]+$".into(),
        },
        HeaderMutationRule {
            id: "hm-disabled".into(),
            enabled: false,
            name: "Disabled".into(),
            direction: HeaderMutationDirection::Request,
            operation: HeaderMutationOp::Set,
            header_name: "X-Off".into(),
            header_value: "no".into(),
            url_pattern: "regex:.*".into(),
        },
    ];
    engine.update_config(cfg);

    {
        let guard = engine.state.read().unwrap();
        assert_eq!(guard.compiled_tls_bypass_rules.positive_rules.len(), 1);
        assert!(guard.compiled_tls_bypass_rules.positive_rules[0]
            .positive_tokens
            .iter()
            .all(|t| t.host.has_compiled_regex()));
        assert_eq!(guard.compiled_tls_target_rules.positive_rules.len(), 1);
        assert!(guard.compiled_tls_target_rules.positive_rules[0]
            .positive_tokens
            .iter()
            .all(|t| t.host.has_compiled_regex()));
        assert_eq!(guard.compiled_header_mutations.len(), 2);
        assert!(guard
            .compiled_header_mutations
            .iter()
            .all(|m| m.url_scope.has_compiled_regex()));
    }

    assert!(engine.match_tls_bypass("api-eu.internal.net", 443).is_some());
    assert!(engine.match_tls_bypass("pinned-42.local", 443).is_some());
    assert!(engine.match_tls_bypass("pinned-abc.local", 443).is_none());

    let mut req_headers = Vec::new();
    assert!(engine.apply_header_mutations(
        HeaderMutationDirection::Request,
        "https://api.example.com/users/v1",
        &mut req_headers,
    ));
    assert_eq!(req_headers.len(), 1);
    assert_eq!(req_headers[0].name, "X-Pre");
    assert_eq!(req_headers[0].value, "glob");

    let mut resp_headers = Vec::new();
    assert!(engine.apply_header_mutations(
        HeaderMutationDirection::Response,
        "https://auth.example.com/123",
        &mut resp_headers,
    ));
    assert_eq!(resp_headers.len(), 1);
    assert_eq!(resp_headers[0].name, "X-Auth");
    assert_eq!(resp_headers[0].value, "rx");
}

#[test]
fn lan_client_allowlist_matches_exact_ips_cidrs_and_always_allows_loopback() {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    let engine = ProxyFilterEngine::new();
    let remote_v4: IpAddr = "192.168.1.42".parse().unwrap();
    let remote_other: IpAddr = "10.20.30.40".parse().unwrap();
    let loopback_v4: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let loopback_v6: IpAddr = IpAddr::V6(Ipv6Addr::LOCALHOST);
    let mapped_loopback: IpAddr = "::ffff:127.0.0.1".parse().unwrap();
    let mapped_lan: IpAddr = "::ffff:192.168.1.42".parse().unwrap();

    // Empty allowlist permits all LAN peers
    assert!(engine.is_lan_client_allowed(remote_v4));
    assert!(engine.is_lan_client_allowed(remote_other));
    assert!(engine.is_lan_client_allowed(loopback_v4));

    // Exact IP + CIDR IPv4 + CIDR IPv6
    let mut cfg = default_backend_config();
    cfg.lan_client_allowlist = vec![
        " 192.168.1.42 ".into(),
        "172.16.0.0/16".into(),
        "[fe80::]/10".into(),
    ];
    engine.update_config(cfg);

    assert!(engine.is_lan_client_allowed(loopback_v4));
    assert!(engine.is_lan_client_allowed(loopback_v6));
    assert!(engine.is_lan_client_allowed(mapped_loopback));
    assert!(engine.is_lan_client_allowed(remote_v4));
    assert!(engine.is_lan_client_allowed(mapped_lan));
    assert!(engine.is_lan_client_allowed("172.16.254.5".parse().unwrap()));
    assert!(engine.is_lan_client_allowed("fe80::1234:abcd".parse().unwrap()));
    assert!(!engine.is_lan_client_allowed("192.168.1.43".parse().unwrap()));
    assert!(!engine.is_lan_client_allowed(remote_other));
    assert!(!engine.is_lan_client_allowed("2001:db8::1".parse().unwrap()));

    // Non-empty allowlist containing only malformed entries must fail closed for LAN clients (still allowing loopback)
    let mut bad_cfg = default_backend_config();
    bad_cfg.lan_client_allowlist = vec!["not-an-ip".into(), "192.168.1.1/99".into()];
    engine.update_config(bad_cfg);
    assert!(engine.is_lan_client_allowed(loopback_v4));
    assert!(!engine.is_lan_client_allowed(remote_v4));
}

#[test]
fn granular_css_images_fonts_js_filters_and_json_protection() {
    let make_asset = |path: &str, content_type: &str, status: u16| {
        let mut sum = make_summary_for_filter("GET", "cdn.example.com", path, status, Some("chrome.exe"));
        sum.content_type = content_type.into();
        sum
    };

    let css_mime = make_asset("/theme", "text/css; charset=utf-8", 200);
    let css_path = make_asset("/styles/main.css?v=1", "application/octet-stream", 200);
    let css_map = make_asset("/styles/main.css.map", "application/json", 200);
    let img_mime = make_asset("/avatar", "image/webp", 200);
    let img_avif = make_asset("/hero.avif?w=600", "application/octet-stream", 200);
    let img_heic = make_asset("/photo.heic", "", 200);
    let font_mime = make_asset("/font-a", "application/font-woff", 200);
    let font_ms = make_asset("/font-b", "application/vnd.ms-fontobject", 200);
    let font_x = make_asset("/font-c", "application/x-font-opentype", 200);
    let font_eot = make_asset("/icons.eot?v=4", "", 200);
    let js_mime = make_asset("/sdk", "application/javascript; charset=utf-8", 200);
    let es_mime = make_asset("/esm", "text/ecmascript", 200);
    let js_mjs = make_asset("/chunks/app.mjs?h=123", "text/plain", 200);
    let js_cjs = make_asset("/chunks/vendor.cjs", "", 200);
    let js_jsx = make_asset("/src/Button.jsx", "", 200);
    let js_map = make_asset("/chunks/app.js.map", "application/json", 200);
    let mjs_map = make_asset("/chunks/app.mjs.map?v=2", "", 200);
    let cjs_map = make_asset("/chunks/vendor.cjs.map", "", 200);
    let json_api = make_asset("/api/config.json?env=prod", "application/json", 200);
    let jsp_page = make_asset("/legacy/login.jsp", "text/html", 200);

    // 1. CSS only
    let engine = ProxyFilterEngine::new();
    let mut cfg = default_backend_config();
    cfg.drop_non_matching_on_capture = true;
    cfg.noise_thresholds.hide_css = true;
    engine.update_config(cfg);
    assert!(!engine.evaluate_should_store_session(&css_mime));
    assert!(!engine.evaluate_should_store_session(&css_path));
    assert!(!engine.evaluate_should_store_session(&css_map));
    assert!(engine.evaluate_should_store_session(&js_map));
    assert!(engine.evaluate_should_store_session(&img_avif));
    assert!(engine.evaluate_should_store_session(&font_eot));
    assert!(engine.evaluate_should_store_session(&js_mjs));
    assert!(engine.evaluate_should_store_session(&json_api));

    // 2. Images only
    let mut cfg = default_backend_config();
    cfg.drop_non_matching_on_capture = true;
    cfg.noise_thresholds.hide_images = true;
    engine.update_config(cfg);
    for ext in ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "cur", "tif", "tiff", "heic"] {
        let sample = make_asset(&format!("/img.{ext}"), "", 200);
        assert!(
            !engine.evaluate_should_store_session(&sample),
            "expected .{ext} to be hidden when hide_images = true"
        );
    }
    assert!(!engine.evaluate_should_store_session(&img_mime));
    assert!(!engine.evaluate_should_store_session(&img_avif));
    assert!(!engine.evaluate_should_store_session(&img_heic));
    assert!(engine.evaluate_should_store_session(&css_path));
    assert!(engine.evaluate_should_store_session(&font_eot));
    assert!(engine.evaluate_should_store_session(&js_mjs));
    assert!(engine.evaluate_should_store_session(&json_api));

    // 3. Fonts only
    let mut cfg = default_backend_config();
    cfg.drop_non_matching_on_capture = true;
    cfg.noise_thresholds.hide_fonts = true;
    engine.update_config(cfg);
    for sample in [
        &font_mime,
        &font_ms,
        &font_x,
        &font_eot,
        &make_asset("/f.woff", "", 200),
        &make_asset("/f.woff2", "", 200),
        &make_asset("/f.ttf", "", 200),
        &make_asset("/f.otf", "", 200),
        &make_asset("/f-mime", "font/woff2", 200),
    ] {
        assert!(!engine.evaluate_should_store_session(sample));
    }
    assert!(engine.evaluate_should_store_session(&css_path));
    assert!(engine.evaluate_should_store_session(&img_avif));
    assert!(engine.evaluate_should_store_session(&js_mjs));
    assert!(engine.evaluate_should_store_session(&json_api));

    // 4. JavaScript only (must never match .json, application/json, .jsp, or .css.map)
    let mut cfg = default_backend_config();
    cfg.drop_non_matching_on_capture = true;
    cfg.noise_thresholds.hide_js = true;
    engine.update_config(cfg);
    for sample in [&js_mime, &es_mime, &js_mjs, &js_cjs, &js_jsx, &js_map, &mjs_map, &cjs_map] {
        assert!(!engine.evaluate_should_store_session(sample));
    }
    assert!(engine.evaluate_should_store_session(&json_api));
    assert!(engine.evaluate_should_store_session(&jsp_page));
    assert!(engine.evaluate_should_store_session(&css_map));
    assert!(engine.evaluate_should_store_session(&img_avif));
    assert!(engine.evaluate_should_store_session(&font_eot));

    // In-flight pending request defers MIME check while matching explicit JS path
    let in_flight_mime = make_asset("/api/stream", "application/javascript", 0);
    let in_flight_path = make_asset("/assets/bundle.js", "", 0);
    assert!(engine.evaluate_should_store_session(&in_flight_mime));
    assert!(!engine.evaluate_should_store_session(&in_flight_path));
}

#[test]
fn legacy_hide_static_assets_serde_migrates_without_hiding_js() {
    let legacy_json = r#"{
        "tlsInterceptMode": "interceptAll",
        "tlsBypassEnabled": true,
        "tlsBypassRules": [],
        "tlsTargetRules": [],
        "headerMutationsEnabled": true,
        "headerMutations": [],
        "dropNonMatchingOnCapture": true,
        "noiseThresholds": {
            "hideStaticAssets": true
        }
    }"#;
    let parsed: ProxyFilterBackendConfig =
        serde_json::from_str(legacy_json).expect("deserialize legacy noiseThresholds");
    let engine = ProxyFilterEngine::new();
    let normalized = engine.update_config(parsed);

    assert!(normalized.noise_thresholds.hide_css);
    assert!(normalized.noise_thresholds.hide_images);
    assert!(normalized.noise_thresholds.hide_fonts);
    assert!(!normalized.noise_thresholds.hide_js);
    assert!(!normalized.noise_thresholds.hide_static_assets);

    let reserialized = serde_json::to_string(&normalized).expect("serialize normalized config");
    assert!(!reserialized.contains("hideStaticAssets"));

    let mut css = make_summary_for_filter("GET", "cdn.test", "/a.css", 200, Some("chrome.exe"));
    css.content_type = "text/css".into();
    let mut img = make_summary_for_filter("GET", "cdn.test", "/a.png", 200, Some("chrome.exe"));
    img.content_type = "image/png".into();
    let mut font = make_summary_for_filter("GET", "cdn.test", "/a.woff2", 200, Some("chrome.exe"));
    font.content_type = "font/woff2".into();
    let mut js = make_summary_for_filter("GET", "cdn.test", "/app.js", 200, Some("chrome.exe"));
    js.content_type = "application/javascript".into();

    assert!(!engine.evaluate_should_store_session(&css));
    assert!(!engine.evaluate_should_store_session(&img));
    assert!(!engine.evaluate_should_store_session(&font));
    assert!(engine.evaluate_should_store_session(&js));

    // Explicit granular flag alongside legacy hideStaticAssets=true must NOT trigger expansion
    let explicit_json = r#"{
        "tlsInterceptMode": "interceptAll",
        "tlsBypassEnabled": true,
        "tlsBypassRules": [],
        "tlsTargetRules": [],
        "headerMutationsEnabled": true,
        "headerMutations": [],
        "dropNonMatchingOnCapture": true,
        "noiseThresholds": {
            "hideStaticAssets": true,
            "hideJs": true
        }
    }"#;
    let parsed_explicit: ProxyFilterBackendConfig =
        serde_json::from_str(explicit_json).expect("deserialize explicit + legacy");
    let norm_explicit = engine.update_config(parsed_explicit);
    assert!(!norm_explicit.noise_thresholds.hide_css);
    assert!(!norm_explicit.noise_thresholds.hide_images);
    assert!(!norm_explicit.noise_thresholds.hide_fonts);
    assert!(norm_explicit.noise_thresholds.hide_js);
    assert!(!norm_explicit.noise_thresholds.hide_static_assets);

    assert!(engine.evaluate_should_store_session(&css));
    assert!(engine.evaluate_should_store_session(&img));
    assert!(engine.evaluate_should_store_session(&font));
    assert!(!engine.evaluate_should_store_session(&js));
}
