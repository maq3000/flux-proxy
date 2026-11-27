import type {
  AutoResponderRule,
  HostRemapRule,
  PythonScriptPreset,
} from "../types/proxy";
import { createSampleJwtToken } from "./textWizard";

export const DEFAULT_AUTORESPONDER_RULES: AutoResponderRule[] = [
  {
    id: "rule-mock-auth",
    enabled: false,
    name: "Mock OAuth2 Token Refresh (200 OK)",
    matchTarget: "urlContains",
    pattern: "/oauth2/token",
    methodFilter: "POST",
    headerName: null,
    action: "mockResponse",
    statusCode: 200,
    latencyMs: 65,
    responseHeaders: [
      { name: "Content-Type", value: "application/json; charset=utf-8" },
      { name: "X-AutoResponder", value: "FluxProxy-Rule-Engine" },
    ],
    responseBody: JSON.stringify(
      {
        access_token: createSampleJwtToken(false),
        token_type: "Bearer",
        expires_in: 3600,
        mocked_by: "FluxProxy AutoResponder",
      },
      null,
      2
    ),
  },
  {
    id: "rule-throttle-stripe",
    enabled: false,
    name: "Simulate 650ms Slow 3G Latency on /v1/payment_intents",
    matchTarget: "urlRegex",
    pattern: "stripe\\.com/v1/payment_intents",
    methodFilter: "GET",
    headerName: null,
    action: "delayOnly",
    statusCode: 200,
    latencyMs: 650,
    responseHeaders: [],
    responseBody: "",
  },
];

export const DEFAULT_CLEAR_DB_ON_EXIT = false;

export const previewPickedFiles = new Map<string, File>();

export const PREVIEW_SQLITE_ARCHIVE_STORAGE_KEY =
  "fluxproxy.sqliteArchivePreview.v1";
export const PREVIEW_SQLITE_COUNT_STORAGE_KEY =
  "fluxproxy-sqlite-preview-count";
export const PREVIEW_CLEAR_DB_ON_EXIT_STORAGE_KEY =
  "fluxproxy.clearDbOnExit.v1";
export const PREVIEW_SANITIZATION_OPTIONS_STORAGE_KEY =
  "fluxproxy.sanitizationOptions.v1";
export const PREVIEW_CLIENT_CERTS_STORAGE_KEY =
  "fluxproxy.previewClientCerts.v1";
export const PREVIEW_PYTHON_SCRIPT_STORAGE_KEY =
  "fluxproxy.pythonScript.v1";
export const PREVIEW_HOST_REMAP_RULES_STORAGE_KEY =
  "fluxproxy.previewHostRemapRules.v1";
export const PREVIEW_THROTTLE_CONFIG_STORAGE_KEY =
  "fluxproxy.previewThrottleConfig.v1";
export const PREVIEW_UPSTREAM_PROXY_CONFIG_STORAGE_KEY =
  "fluxproxy.previewUpstreamProxyConfig.v1";
export const PREVIEW_UPSTREAM_TIMEOUTS_STORAGE_KEY =
  "fluxproxy.preview.upstreamTimeouts.v1";

export const DEFAULT_HOST_REMAP_RULES: HostRemapRule[] = [];

export const PYTHON_SCRIPT_PRESETS: PythonScriptPreset[] = [
  {
    id: "hmac-header-injection",
    name: "HMAC Header Injection",
    badge: "Auth / Sig",
    description:
      "Динамически вычисляет HMAC-SHA256 подпись (timestamp + method + url + body) и добавляет X-Flux-Signature в каждый запрос.",
    hooks: ["on_request"],
    code: `"""FluxProxy Python Script — HMAC Header Injection
Автоматически подписывает исходящие запросы заголовками X-Flux-Timestamp и X-Flux-Signature.
"""
import hashlib
import hmac
import time

SECRET_KEY = b"fluxproxy-dev-hmac-secret"


def on_request(request):
    ts = str(int(time.time()))
    canonical = f"{ts}\\n{request['method']}\\n{request['url']}\\n{request.get('body', '')}"
    signature = hmac.new(
        SECRET_KEY,
        canonical.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    request["headers"]["X-Flux-Timestamp"] = ts
    request["headers"]["X-Flux-Signature"] = f"sha256={signature}"
    print(f"[HMAC] Signed #{request['session_id']} {request['method']} {request['url']} ({signature[:12]}...)")
`,
  },
  {
    id: "conditional-mock",
    name: "Conditional Mock",
    badge: "Mock",
    description:
      "Перехватывает запросы к заданному endpoint или с заголовком X-Mock-Mode и возвращает локальный JSON-ответ без обращения к upstream.",
    hooks: ["on_request"],
    code: `"""FluxProxy Python Script — Conditional Mock
Возвращает мгновенный mock_response, если URL или заголовок совпадает с условием.
"""
import json


def on_request(request):
    url = request["url"]
    headers = {k.lower(): v for k, v in request["headers"].items()}

    if "/feature-flags" in url or headers.get("x-flux-mock") == "1":
        payload = {
            "source": "fluxproxy-python-runner",
            "session_id": request["session_id"],
            "flags": {
                "newCheckout": True,
                "debugInspector": True,
                "betaStreaming": False,
            },
        }
        request["mock_response"] = {
            "status": 200,
            "headers": {
                "Content-Type": "application/json; charset=utf-8",
                "X-Mocked-By": "FluxProxy-Python",
                "Cache-Control": "no-store",
            },
            "body": json.dumps(payload, indent=2),
        }
        print(f"[MOCK] Short-circuited {request['method']} {url} -> 200 OK")
`,
  },
  {
    id: "query-rewriter",
    name: "Query Rewriter",
    badge: "URL",
    description:
      "Удаляет трекинговые параметры (utm_*, fbclid, gclid) и инжектирует/перезаписывает отладочный query-параметр _flux_debug=1.",
    hooks: ["on_request"],
    code: `"""FluxProxy Python Script — Query Rewriter
Очищает UTM/трекинговые параметры и добавляет отладочные query-параметры на лету.
"""
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

STRIP_PREFIXES = ("utm_",)
STRIP_KEYS = {"fbclid", "gclid", "yclid"}


def on_request(request):
    parsed = urlparse(request["url"])
    original_pairs = parse_qsl(parsed.query, keep_blank_values=True)
    cleaned = [
        (k, v)
        for (k, v) in original_pairs
        if not k.lower().startswith(STRIP_PREFIXES) and k.lower() not in STRIP_KEYS
    ]

    if not any(k == "_flux_debug" for (k, _) in cleaned):
        cleaned.append(("_flux_debug", "1"))

    next_url = urlunparse(parsed._replace(query=urlencode(cleaned, doseq=True)))
    if next_url != request["url"]:
        print(f"[REWRITE] {request['url']} -> {next_url}")
        request["url"] = next_url
`,
  },
  {
    id: "payload-logger",
    name: "Payload Logger",
    badge: "Inspect",
    description:
      "Логирует JSON-структуру запросов и ответов в живую консоль скриптов и подсвечивает ошибки 4xx/5xx без изменения трафика.",
    hooks: ["on_request", "on_response"],
    code: `"""FluxProxy Python Script — Payload Logger
Инспектирует JSON payload входящих запросов и распакованных ответов (включая zstd/gzip/br).
SSE (text/event-stream) и video/*/206 потоки автоматически пропускаются движком без буферизации.
"""
import json


def _summarize_json(raw_body):
    if not raw_body or not raw_body.strip():
        return "<empty>"
    try:
        parsed = json.loads(raw_body)
        if isinstance(parsed, dict):
            keys = list(parsed.keys())[:8]
            return f"dict keys={keys}"
        if isinstance(parsed, list):
            return f"list len={len(parsed)}"
        return repr(parsed)[:120]
    except Exception:
        return f"text({len(raw_body)} chars)"


def on_request(request):
    summary = _summarize_json(request.get("body", ""))
    print(f"[REQ #{request['session_id']}] {request['method']} {request['url']} | {summary}")


def on_response(response, request):
    status = response["status"]
    summary = _summarize_json(response.get("body", ""))
    tag = "ERR" if status >= 400 else "OK"
    print(f"[RESP #{response['session_id']} {tag}] {status} {request['method']} {request['url']} | {summary}")
`,
  },
];

export const DEFAULT_PYTHON_SCRIPT_CODE = PYTHON_SCRIPT_PRESETS[0].code;
