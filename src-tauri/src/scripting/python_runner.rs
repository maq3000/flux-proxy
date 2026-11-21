use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::Engine as _;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

use crate::models::{HeaderPair, ProxyError, PythonRunnerStatus, ScriptConsoleLogEvent};

pub const DEFAULT_SCRIPT_TIMEOUT: Duration = Duration::from_millis(1500);
pub const DEFAULT_LOCK_ACQUIRE_TIMEOUT: Duration = Duration::from_millis(5000);
pub const MAX_SCRIPT_BODY_BYTES: usize = 4 * 1024 * 1024; // 4 MiB safety cap per hook payload
const SCRIPT_CONSOLE_LOG_EVENT: &str = "proxy://script-console-log";

const PYTHON_BOOTSTRAP_SCRIPT: &str = r#"
import base64
import inspect
import io
import json
import sys
import traceback

for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

_proto_out = sys.stdout
sys.stdout = sys.stderr

_script_ns = {}
_fn_on_request = None
_fn_on_response = None


def _emit(obj):
    _proto_out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _proto_out.flush()


def _collect_logs(buf):
    raw = buf.getvalue()
    if not raw:
        return []
    return raw.rstrip("\r\n").splitlines()


def _normalize_headers_in(raw_headers):
    out = {}
    if isinstance(raw_headers, dict):
        for k, v in raw_headers.items():
            out[str(k)] = "" if v is None else str(v)
    elif isinstance(raw_headers, list):
        for item in raw_headers:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                out[str(item[0])] = "" if item[1] is None else str(item[1])
    return out


def _normalize_header_value(val):
    if isinstance(val, (list, tuple)):
        return [str(x) for x in val if x is not None]
    return "" if val is None else str(val)


def _diff_headers(orig_headers, new_headers):
    orig_by_lower = {}
    for k, v in orig_headers.items():
        orig_by_lower[str(k).lower()] = (str(k), _normalize_header_value(v))

    new_by_lower = {}
    if isinstance(new_headers, dict):
        for k, v in new_headers.items():
            if v is None:
                continue
            new_by_lower[str(k).lower()] = (str(k), _normalize_header_value(v))
    elif isinstance(new_headers, list):
        grouped = {}
        for item in new_headers:
            if isinstance(item, (list, tuple)) and len(item) >= 2 and item[1] is not None:
                k_str = str(item[0])
                kl = k_str.lower()
                if kl not in grouped:
                    grouped[kl] = (k_str, [str(item[1])])
                else:
                    grouped[kl][1].append(str(item[1]))
        for kl, (k_str, vals) in grouped.items():
            new_by_lower[kl] = (k_str, vals[0] if len(vals) == 1 else vals)
    else:
        return [], []

    removed = [orig_k for kl, (orig_k, _) in orig_by_lower.items() if kl not in new_by_lower]
    headers_set = []
    for kl, (new_k, new_v) in new_by_lower.items():
        if kl not in orig_by_lower or orig_by_lower[kl][1] != new_v:
            if isinstance(new_v, list):
                for item in new_v:
                    headers_set.append([new_k, item])
            else:
                headers_set.append([new_k, new_v])
    return removed, headers_set


def _encode_body_value(val):
    if val is None:
        return ""
    if isinstance(val, (bytes, bytearray)):
        raw = bytes(val)
    elif isinstance(val, (dict, list)):
        raw = json.dumps(val, ensure_ascii=False).encode("utf-8")
    else:
        raw = str(val).encode("utf-8")
    return base64.b64encode(raw).decode("ascii")


def _extract_headers_pairs(raw_headers):
    pairs = []
    if isinstance(raw_headers, dict):
        for k, v in raw_headers.items():
            if v is None:
                continue
            if isinstance(v, (list, tuple)):
                for item in v:
                    if item is not None:
                        pairs.append([str(k), str(item)])
            else:
                pairs.append([str(k), str(v)])
    elif isinstance(raw_headers, list):
        for item in raw_headers:
            if isinstance(item, (list, tuple)) and len(item) >= 2 and item[1] is not None:
                pairs.append([str(item[0]), str(item[1])])
    return pairs


def _extract_mock_response(req_obj):
    mock_raw = req_obj.get("mock_response")
    if mock_raw is None:
        mock_raw = req_obj.get("response")
    if not isinstance(mock_raw, dict):
        return None
    status = mock_raw.get("status", 200)
    try:
        status_int = int(status)
    except Exception:
        status_int = 200
    headers = _extract_headers_pairs(mock_raw.get("headers") or {})
    if mock_raw.get("body_base64") is not None:
        body_b64 = str(mock_raw.get("body_base64"))
    elif "body" in mock_raw:
        body_b64 = _encode_body_value(mock_raw.get("body"))
    else:
        body_b64 = ""
    return {
        "status": status_int,
        "headers": headers,
        "body_base64": body_b64,
    }


def _call_on_response(fn, resp_dict, req_ctx):
    try:
        sig = inspect.signature(fn)
        params = list(sig.parameters.values())
        positional = [
            p for p in params
            if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
        ]
        has_varargs = any(p.kind == inspect.Parameter.VAR_POSITIONAL for p in params)
        if has_varargs or len(positional) >= 2:
            return fn(resp_dict, req_ctx)
    except Exception:
        pass
    return fn(resp_dict)


while True:
    raw_line = sys.stdin.readline()
    if not raw_line:
        break
    line = raw_line.strip()
    if not line:
        continue

    req_id = 0
    buf = io.StringIO()
    try:
        msg = json.loads(line)
        req_id = msg.get("id", 0)
        op = msg.get("op")

        if op == "ping":
            _emit({"id": req_id, "ok": True, "logs": [], "error": None})
            continue

        if op == "load":
            code = msg.get("code", "")
            sys.stdout = buf
            try:
                new_ns = {"__name__": "__fluxproxy_script__"}
                compiled = compile(code, "<fluxproxy_script>", "exec")
                exec(compiled, new_ns)
                fn_req = new_ns.get("on_request")
                fn_resp = new_ns.get("on_response")
                _script_ns = new_ns
                _fn_on_request = fn_req if callable(fn_req) else None
                _fn_on_response = fn_resp if callable(fn_resp) else None
            finally:
                sys.stdout = sys.stderr

            _emit({
                "id": req_id,
                "ok": True,
                "has_on_request": _fn_on_request is not None,
                "has_on_response": _fn_on_response is not None,
                "logs": _collect_logs(buf),
                "error": None,
            })
            continue

        if op == "on_request":
            if _fn_on_request is None:
                _emit({"id": req_id, "ok": True, "modified": False, "logs": [], "error": None})
                continue

            orig_method = str(msg.get("method", "GET"))
            orig_url = str(msg.get("url", ""))
            orig_headers = _normalize_headers_in(msg.get("headers"))
            body_is_utf8 = bool(msg.get("body_is_utf8", True))
            if body_is_utf8:
                orig_body = str(msg.get("body", ""))
                orig_body_b64 = base64.b64encode(orig_body.encode("utf-8")).decode("ascii")
            else:
                orig_body = ""
                orig_body_b64 = str(msg.get("body_base64", ""))

            req_dict = {
                "session_id": msg.get("session_id"),
                "method": orig_method,
                "url": orig_url,
                "headers": dict(orig_headers),
                "body": orig_body,
                "body_base64": orig_body_b64,
            }

            sys.stdout = buf
            try:
                ret = _fn_on_request(req_dict)
                if isinstance(ret, dict):
                    req_dict = ret
            finally:
                sys.stdout = sys.stderr

            new_method = str(req_dict.get("method", orig_method))
            new_url = str(req_dict.get("url", orig_url))
            removed, headers_set = _diff_headers(orig_headers, req_dict.get("headers", orig_headers))
            headers_changed = bool(removed or headers_set)

            new_body = req_dict.get("body", orig_body)
            new_body_b64 = str(req_dict.get("body_base64", orig_body_b64))
            if new_body != orig_body:
                body_changed = True
                out_body_b64 = _encode_body_value(new_body)
            elif new_body_b64 != orig_body_b64:
                body_changed = True
                out_body_b64 = new_body_b64
            else:
                body_changed = False
                out_body_b64 = None

            mock_resp = _extract_mock_response(req_dict)
            method_out = new_method if new_method != orig_method else None
            url_out = new_url if new_url != orig_url else None
            modified = bool(
                method_out is not None
                or url_out is not None
                or headers_changed
                or body_changed
                or mock_resp is not None
            )

            _emit({
                "id": req_id,
                "ok": True,
                "modified": modified,
                "method": method_out,
                "url": url_out,
                "headers_changed": headers_changed,
                "headers_removed": removed,
                "headers_set": headers_set,
                "body_changed": body_changed,
                "body_base64": out_body_b64,
                "mock_response": mock_resp,
                "logs": _collect_logs(buf),
                "error": None,
            })
            continue

        if op == "on_response":
            if _fn_on_response is None:
                _emit({"id": req_id, "ok": True, "modified": False, "logs": [], "error": None})
                continue

            orig_status = int(msg.get("status", 200))
            req_method = str(msg.get("method", "GET"))
            req_url = str(msg.get("url", ""))
            orig_headers = _normalize_headers_in(msg.get("headers"))
            body_is_utf8 = bool(msg.get("body_is_utf8", True))
            if body_is_utf8:
                orig_body = str(msg.get("body", ""))
                orig_body_b64 = base64.b64encode(orig_body.encode("utf-8")).decode("ascii")
            else:
                orig_body = ""
                orig_body_b64 = str(msg.get("body_base64", ""))

            resp_dict = {
                "session_id": msg.get("session_id"),
                "status": orig_status,
                "method": req_method,
                "url": req_url,
                "headers": dict(orig_headers),
                "body": orig_body,
                "body_base64": orig_body_b64,
            }
            req_ctx = {
                "session_id": msg.get("session_id"),
                "method": req_method,
                "url": req_url,
            }

            sys.stdout = buf
            try:
                ret = _call_on_response(_fn_on_response, resp_dict, req_ctx)
                if isinstance(ret, dict):
                    resp_dict = ret
            finally:
                sys.stdout = sys.stderr

            try:
                new_status = int(resp_dict.get("status", orig_status))
            except Exception:
                new_status = orig_status
            status_out = new_status if new_status != orig_status else None

            removed, headers_set = _diff_headers(orig_headers, resp_dict.get("headers", orig_headers))
            headers_changed = bool(removed or headers_set)

            new_body = resp_dict.get("body", orig_body)
            new_body_b64 = str(resp_dict.get("body_base64", orig_body_b64))
            if new_body != orig_body:
                body_changed = True
                out_body_b64 = _encode_body_value(new_body)
            elif new_body_b64 != orig_body_b64:
                body_changed = True
                out_body_b64 = new_body_b64
            else:
                body_changed = False
                out_body_b64 = None

            modified = bool(status_out is not None or headers_changed or body_changed)

            _emit({
                "id": req_id,
                "ok": True,
                "modified": modified,
                "status": status_out,
                "headers_changed": headers_changed,
                "headers_removed": removed,
                "headers_set": headers_set,
                "body_changed": body_changed,
                "body_base64": out_body_b64,
                "logs": _collect_logs(buf),
                "error": None,
            })
            continue

        _emit({
            "id": req_id,
            "ok": False,
            "modified": False,
            "logs": [],
            "error": f"Unknown runner op: {op}",
        })
    except Exception:
        sys.stdout = sys.stderr
        if op_err := traceback.format_exc():
            if req_id is None:
                req_id = 0
            try:
                _emit({
                    "id": req_id,
                    "ok": False,
                    "modified": False,
                    "logs": _collect_logs(buf),
                    "error": op_err,
                })
            except Exception:
                pass
"#;

#[derive(Debug, Clone)]
pub(crate) struct PythonBinarySpec {
    pub program: String,
    pub pre_args: Vec<String>,
    pub version: String,
}

#[derive(Debug, Clone)]
pub struct ScriptMockResponse {
    pub status: u16,
    pub headers: Vec<HeaderPair>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct ScriptRequestEdits {
    pub method: Option<String>,
    pub url: Option<String>,
    pub headers_changed: bool,
    pub headers_removed: Vec<String>,
    pub headers_set: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub enum ScriptRequestOutcome {
    Unchanged,
    Modified(ScriptRequestEdits),
    MockResponse {
        edits: ScriptRequestEdits,
        mock: ScriptMockResponse,
    },
}

#[derive(Debug, Clone, Default)]
pub struct ScriptResponseEdits {
    pub status: Option<u16>,
    pub headers_changed: bool,
    pub headers_removed: Vec<String>,
    pub headers_set: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub enum ScriptResponseOutcome {
    Unchanged,
    Modified(ScriptResponseEdits),
}

#[derive(Debug, Serialize)]
struct RpcLoadPayload<'a> {
    id: u64,
    op: &'static str,
    code: &'a str,
}

#[derive(Debug, Serialize)]
struct RpcRequestPayload<'a> {
    id: u64,
    op: &'static str,
    session_id: u64,
    method: &'a str,
    url: &'a str,
    headers: Vec<(&'a str, &'a str)>,
    body_is_utf8: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_base64: Option<&'a str>,
}

#[derive(Debug, Serialize)]
struct RpcResponsePayload<'a> {
    id: u64,
    op: &'static str,
    session_id: u64,
    status: u16,
    method: &'a str,
    url: &'a str,
    headers: Vec<(&'a str, &'a str)>,
    body_is_utf8: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_base64: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
struct RpcLoadReply {
    #[allow(dead_code)]
    id: u64,
    ok: bool,
    #[serde(default)]
    has_on_request: bool,
    #[serde(default)]
    has_on_response: bool,
    #[serde(default)]
    logs: Vec<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RpcMockResponse {
    status: u16,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body_base64: String,
}

#[derive(Debug, Deserialize)]
struct RpcRequestReply {
    #[allow(dead_code)]
    id: u64,
    ok: bool,
    #[serde(default)]
    modified: bool,
    method: Option<String>,
    url: Option<String>,
    #[serde(default)]
    headers_changed: bool,
    #[serde(default)]
    headers_removed: Vec<String>,
    #[serde(default)]
    headers_set: Vec<(String, String)>,
    #[serde(default)]
    body_changed: bool,
    body_base64: Option<String>,
    mock_response: Option<RpcMockResponse>,
    #[serde(default)]
    logs: Vec<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RpcResponseReply {
    #[allow(dead_code)]
    id: u64,
    ok: bool,
    #[serde(default)]
    modified: bool,
    status: Option<u16>,
    #[serde(default)]
    headers_changed: bool,
    #[serde(default)]
    headers_removed: Vec<String>,
    #[serde(default)]
    headers_set: Vec<(String, String)>,
    #[serde(default)]
    body_changed: bool,
    body_base64: Option<String>,
    #[serde(default)]
    logs: Vec<String>,
    error: Option<String>,
}

struct PythonWorkerProcess {
    child: Child,
    pid: Option<u32>,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    stderr_task: JoinHandle<()>,
}

impl Drop for PythonWorkerProcess {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        self.stderr_task.abort();
    }
}

struct ScriptConfigState {
    code: String,
    enabled: bool,
    probed_binary: Option<Option<PythonBinarySpec>>,
    forced_binary_candidates: Option<Vec<(String, Vec<String>)>>,
    worker_pid: Option<u32>,
    worker_running: bool,
    last_error: Option<String>,
    restart_count: u64,
    invocations_count: u64,
    timeout_count: u64,
}

pub struct PythonScriptRunner {
    enabled: AtomicBool,
    has_on_request: AtomicBool,
    has_on_response: AtomicBool,
    rpc_seq: AtomicU64,
    log_seq: Arc<AtomicU64>,
    timeout: Duration,
    lock_acquire_timeout: Duration,
    app_handle: Option<AppHandle>,
    config: StdMutex<ScriptConfigState>,
    worker: AsyncMutex<Option<PythonWorkerProcess>>,
    #[cfg(test)]
    captured_logs: Arc<StdMutex<Vec<ScriptConsoleLogEvent>>>,
}

/// Applies case-insensitive header removals and updates returned from Python hooks while
/// leaving unrelated (including duplicate multi-value) headers intact.
pub fn apply_header_diff(
    headers: &mut Vec<HeaderPair>,
    removed: &[String],
    set: &[(String, String)],
) -> bool {
    if removed.is_empty() && set.is_empty() {
        return false;
    }

    let before_len = headers.len();
    let mut keys_to_remove: Vec<String> = Vec::with_capacity(removed.len() + set.len());
    for name in removed {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            keys_to_remove.push(trimmed.to_ascii_lowercase());
        }
    }
    for (name, _) in set {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            keys_to_remove.push(trimmed.to_ascii_lowercase());
        }
    }

    if !keys_to_remove.is_empty() {
        headers.retain(|h| {
            let lower = h.name.trim().to_ascii_lowercase();
            !keys_to_remove.iter().any(|k| k == &lower)
        });
    }

    let mut added_any = false;
    for (name, value) in set {
        let clean_name = name.trim();
        if !clean_name.is_empty() {
            headers.push(HeaderPair {
                name: clean_name.to_string(),
                value: value.clone(),
            });
            added_any = true;
        }
    }

    added_any || headers.len() != before_len
}

fn configure_command(cmd: &mut Command) {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

async fn probe_candidate(program: &str, pre_args: &[String]) -> Option<PythonBinarySpec> {
    let mut cmd = Command::new(program);
    for arg in pre_args {
        cmd.arg(arg);
    }
    cmd.arg("--version");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = tokio::time::timeout(Duration::from_secs(3), cmd.output())
        .await
        .ok()?
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let stderr_str = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout_str}\n{stderr_str}");
    let version_line = combined
        .lines()
        .map(str::trim)
        .find(|l| l.to_ascii_lowercase().contains("python 3."))?;

    Some(PythonBinarySpec {
        program: program.to_string(),
        pre_args: pre_args.to_vec(),
        version: version_line.to_string(),
    })
}

async fn detect_python_binary(candidates: &[(String, Vec<String>)]) -> Option<PythonBinarySpec> {
    for (program, pre_args) in candidates {
        if let Some(spec) = probe_candidate(program, pre_args).await {
            return Some(spec);
        }
    }
    None
}

fn default_python_candidates() -> Vec<(String, Vec<String>)> {
    #[cfg(target_os = "windows")]
    {
        vec![
            ("python3".to_string(), Vec::new()),
            ("python".to_string(), Vec::new()),
            ("py".to_string(), vec!["-3".to_string()]),
            ("py".to_string(), Vec::new()),
        ]
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![
            ("python3".to_string(), Vec::new()),
            ("python".to_string(), Vec::new()),
            ("py".to_string(), Vec::new()),
        ]
    }
}

fn emit_log_with_sink(
    app_handle: &Option<AppHandle>,
    log_seq: &AtomicU64,
    #[cfg(test)] captured_logs: &Arc<StdMutex<Vec<ScriptConsoleLogEvent>>>,
    level: &str,
    hook: Option<&str>,
    session_id: Option<u64>,
    message: impl Into<String>,
) {
    let msg = message.into();
    if msg.is_empty() {
        return;
    }
    let event = ScriptConsoleLogEvent {
        id: log_seq.fetch_add(1, Ordering::Relaxed) + 1,
        timestamp: Utc::now().to_rfc3339(),
        level: level.to_string(),
        hook: hook.map(str::to_string),
        session_id,
        message: msg,
    };

    #[cfg(test)]
    if let Ok(mut logs) = captured_logs.lock() {
        logs.push(event.clone());
    }

    if let Some(ref app) = app_handle {
        let _ = app.emit(SCRIPT_CONSOLE_LOG_EVENT, &event);
    }
}

impl PythonScriptRunner {
    pub fn new(app_handle: Option<AppHandle>) -> Self {
        Self::create_inner(
            app_handle,
            DEFAULT_SCRIPT_TIMEOUT,
            DEFAULT_LOCK_ACQUIRE_TIMEOUT,
            None,
        )
    }

    #[cfg(test)]
    pub(crate) fn new_with_options(
        timeout: Duration,
        forced_candidates: Option<Vec<(String, Vec<String>)>>,
    ) -> Self {
        Self::create_inner(
            None,
            timeout,
            DEFAULT_LOCK_ACQUIRE_TIMEOUT,
            forced_candidates,
        )
    }

    #[cfg(test)]
    pub(crate) fn new_with_timeouts(
        timeout: Duration,
        lock_acquire_timeout: Duration,
        forced_candidates: Option<Vec<(String, Vec<String>)>>,
    ) -> Self {
        Self::create_inner(None, timeout, lock_acquire_timeout, forced_candidates)
    }

    fn create_inner(
        app_handle: Option<AppHandle>,
        timeout: Duration,
        lock_acquire_timeout: Duration,
        forced_candidates: Option<Vec<(String, Vec<String>)>>,
    ) -> Self {
        Self {
            enabled: AtomicBool::new(false),
            has_on_request: AtomicBool::new(false),
            has_on_response: AtomicBool::new(false),
            rpc_seq: AtomicU64::new(0),
            log_seq: Arc::new(AtomicU64::new(0)),
            timeout,
            lock_acquire_timeout,
            app_handle,
            config: StdMutex::new(ScriptConfigState {
                code: String::new(),
                enabled: false,
                probed_binary: None,
                forced_binary_candidates: forced_candidates,
                worker_pid: None,
                worker_running: false,
                last_error: None,
                restart_count: 0,
                invocations_count: 0,
                timeout_count: 0,
            }),
            worker: AsyncMutex::new(None),
            #[cfg(test)]
            captured_logs: Arc::new(StdMutex::new(Vec::new())),
        }
    }

    #[cfg(test)]
    pub(crate) fn take_test_logs(&self) -> Vec<ScriptConsoleLogEvent> {
        let mut guard = self.captured_logs.lock().unwrap();
        std::mem::take(&mut *guard)
    }

    #[inline]
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    #[inline]
    pub fn should_run_request(&self) -> bool {
        self.enabled.load(Ordering::Acquire) && self.has_on_request.load(Ordering::Acquire)
    }

    #[inline]
    pub fn should_run_response(&self) -> bool {
        self.enabled.load(Ordering::Acquire) && self.has_on_response.load(Ordering::Acquire)
    }

    fn lock_config(&self) -> std::sync::MutexGuard<'_, ScriptConfigState> {
        match self.config.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn emit_log(
        &self,
        level: &str,
        hook: Option<&str>,
        session_id: Option<u64>,
        message: impl Into<String>,
    ) {
        emit_log_with_sink(
            &self.app_handle,
            &self.log_seq,
            #[cfg(test)]
            &self.captured_logs,
            level,
            hook,
            session_id,
            message,
        );
    }

    fn emit_stdout_lines(&self, hook: &str, session_id: Option<u64>, lines: &[String]) {
        for line in lines {
            self.emit_log("stdout", Some(hook), session_id, line.clone());
        }
    }

    async fn ensure_python_binary(&self) -> Option<PythonBinarySpec> {
        let (cached, candidates) = {
            let cfg = self.lock_config();
            (
                cfg.probed_binary.clone(),
                cfg.forced_binary_candidates
                    .clone()
                    .unwrap_or_else(default_python_candidates),
            )
        };
        if let Some(spec_opt) = cached {
            return spec_opt;
        }
        let detected = detect_python_binary(&candidates).await;
        let mut cfg = self.lock_config();
        cfg.probed_binary = Some(detected.clone());
        detected
    }

    fn build_status_from_cfg(&self, cfg: &ScriptConfigState) -> PythonRunnerStatus {
        let spec = cfg.probed_binary.as_ref().and_then(|opt| opt.as_ref());
        PythonRunnerStatus {
            available: spec.is_some(),
            enabled: cfg.enabled,
            running: cfg.worker_running,
            python_executable: spec.map(|s| {
                if s.pre_args.is_empty() {
                    s.program.clone()
                } else {
                    format!("{} {}", s.program, s.pre_args.join(" "))
                }
            }),
            python_version: spec.map(|s| s.version.clone()),
            worker_pid: cfg.worker_pid,
            has_on_request: self.has_on_request.load(Ordering::Acquire),
            has_on_response: self.has_on_response.load(Ordering::Acquire),
            timeout_ms: self.timeout.as_millis() as u64,
            last_error: cfg.last_error.clone(),
            restart_count: cfg.restart_count,
            invocations_count: cfg.invocations_count,
            timeout_count: cfg.timeout_count,
            is_simulator: false,
            code: cfg.code.clone(),
        }
    }

    pub async fn get_status(&self) -> PythonRunnerStatus {
        let _ = self.ensure_python_binary().await;
        let cfg = self.lock_config();
        self.build_status_from_cfg(&cfg)
    }

    fn spawn_worker_process(&self, spec: &PythonBinarySpec) -> Result<PythonWorkerProcess, String> {
        let mut cmd = Command::new(&spec.program);
        for arg in &spec.pre_args {
            cmd.arg(arg);
        }
        cmd.arg("-u").arg("-c").arg(PYTHON_BOOTSTRAP_SCRIPT);
        configure_command(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn Python worker '{}': {e}", spec.program))?;
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to acquire Python worker stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to acquire Python worker stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to acquire Python worker stderr".to_string())?;

        let app_handle = self.app_handle.clone();
        let log_seq_val = Arc::clone(&self.log_seq);
        #[cfg(test)]
        let captured_logs = self.captured_logs.clone();

        let stderr_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if !line.trim().is_empty() {
                    emit_log_with_sink(
                        &app_handle,
                        &log_seq_val,
                        #[cfg(test)]
                        &captured_logs,
                        "stderr",
                        Some("worker"),
                        None,
                        line,
                    );
                }
            }
        });

        Ok(PythonWorkerProcess {
            child,
            pid,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
            stderr_task,
        })
    }

    async fn kill_and_clear_worker_locked(&self, guard: &mut Option<PythonWorkerProcess>) {
        if let Some(mut worker) = guard.take() {
            worker.stderr_task.abort();
            let _ = worker.child.kill().await;
            let _ = worker.child.wait().await;
        }
        let mut cfg = self.lock_config();
        cfg.worker_running = false;
        cfg.worker_pid = None;
    }

    async fn send_rpc_line<Req: Serialize, Resp: for<'de> Deserialize<'de>>(
        worker: &mut PythonWorkerProcess,
        payload: &Req,
        timeout: Duration,
    ) -> Result<Resp, RpcFailure> {
        let mut serialized =
            serde_json::to_vec(payload).map_err(|e| RpcFailure::Protocol(e.to_string()))?;
        serialized.push(b'\n');

        let io_future = async {
            worker
                .stdin
                .write_all(&serialized)
                .await
                .map_err(|e| RpcFailure::Io(e.to_string()))?;
            worker
                .stdin
                .flush()
                .await
                .map_err(|e| RpcFailure::Io(e.to_string()))?;

            let mut line = String::new();
            let n = worker
                .stdout
                .read_line(&mut line)
                .await
                .map_err(|e| RpcFailure::Io(e.to_string()))?;
            if n == 0 {
                return Err(RpcFailure::Closed);
            }
            serde_json::from_str::<Resp>(line.trim())
                .map_err(|e| RpcFailure::Protocol(format!("Invalid worker JSON response: {e}")))
        };

        match tokio::time::timeout(timeout, io_future).await {
            Ok(res) => res,
            Err(_) => Err(RpcFailure::Timeout),
        }
    }

    async fn spawn_and_load_locked(
        &self,
        guard: &mut Option<PythonWorkerProcess>,
        spec: &PythonBinarySpec,
        code: &str,
    ) -> Result<RpcLoadReply, String> {
        let freshly_spawned = guard.is_none();
        if freshly_spawned {
            let spawned = self.spawn_worker_process(spec)?;
            let pid = spawned.pid;
            *guard = Some(spawned);
            let mut cfg = self.lock_config();
            cfg.worker_running = true;
            cfg.worker_pid = pid;
        }

        let load_timeout = if freshly_spawned {
            self.timeout.max(Duration::from_secs(3))
        } else {
            self.timeout
        };

        let rpc_id = self.rpc_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let payload = RpcLoadPayload {
            id: rpc_id,
            op: "load",
            code,
        };

        let worker_ref = guard
            .as_mut()
            .ok_or_else(|| "Python worker missing after spawn".to_string())?;
        match Self::send_rpc_line::<_, RpcLoadReply>(worker_ref, &payload, load_timeout).await {
            Ok(reply) => Ok(reply),
            Err(err) => {
                self.kill_and_clear_worker_locked(guard).await;
                Err(match err {
                    RpcFailure::Timeout => format!(
                        "Python script load timed out after {} ms",
                        load_timeout.as_millis()
                    ),
                    RpcFailure::Closed => "Python worker exited unexpectedly during script load".into(),
                    RpcFailure::Io(e) => format!("Python worker IPC error during load: {e}"),
                    RpcFailure::Protocol(e) => e,
                })
            }
        }
    }

    pub async fn set_script(
        &self,
        code: String,
        enabled: bool,
    ) -> Result<PythonRunnerStatus, ProxyError> {
        let spec_opt = self.ensure_python_binary().await;

        let mut worker_guard = self.worker.lock().await;

        if !enabled {
            self.enabled.store(false, Ordering::Release);
            self.has_on_request.store(false, Ordering::Release);
            self.has_on_response.store(false, Ordering::Release);
            self.kill_and_clear_worker_locked(&mut worker_guard).await;
            let status = {
                let mut cfg = self.lock_config();
                cfg.code = code;
                cfg.enabled = false;
                cfg.last_error = None;
                self.build_status_from_cfg(&cfg)
            };
            self.emit_log("info", Some("load"), None, "Python scripting engine disabled.");
            return Ok(status);
        }

        let Some(spec) = spec_opt else {
            self.enabled.store(false, Ordering::Release);
            self.has_on_request.store(false, Ordering::Release);
            self.has_on_response.store(false, Ordering::Release);
            let err_msg =
                "Python 3 interpreter (python3 / python / py) was not found in PATH.".to_string();
            let status = {
                let mut cfg = self.lock_config();
                cfg.code = code;
                cfg.enabled = false;
                cfg.last_error = Some(err_msg.clone());
                self.build_status_from_cfg(&cfg)
            };
            self.emit_log("error", Some("load"), None, err_msg);
            return Ok(status);
        };

        // Always store latest code & mark enabled config, while keeping hook atomics accurate
        {
            let mut cfg = self.lock_config();
            cfg.code = code.clone();
            cfg.enabled = true;
            cfg.last_error = None;
        }

        match self
            .spawn_and_load_locked(&mut worker_guard, &spec, &code)
            .await
        {
            Ok(reply) => {
                self.emit_stdout_lines("load", None, &reply.logs);
                if reply.ok {
                    self.has_on_request
                        .store(reply.has_on_request, Ordering::Release);
                    self.has_on_response
                        .store(reply.has_on_response, Ordering::Release);
                    self.enabled.store(true, Ordering::Release);

                    let status = {
                        let mut cfg = self.lock_config();
                        cfg.last_error = None;
                        self.build_status_from_cfg(&cfg)
                    };
                    self.emit_log(
                        "info",
                        Some("load"),
                        None,
                        format!(
                            "Python script applied (on_request: {}, on_response: {}).",
                            reply.has_on_request, reply.has_on_response
                        ),
                    );
                    Ok(status)
                } else {
                    self.has_on_request.store(false, Ordering::Release);
                    self.has_on_response.store(false, Ordering::Release);
                    self.enabled.store(false, Ordering::Release);
                    let err_msg = reply
                        .error
                        .unwrap_or_else(|| "Unknown Python syntax/runtime error".to_string());
                    let status = {
                        let mut cfg = self.lock_config();
                        cfg.last_error = Some(err_msg.clone());
                        self.build_status_from_cfg(&cfg)
                    };
                    self.emit_log("error", Some("load"), None, err_msg);
                    Ok(status)
                }
            }
            Err(err_msg) => {
                self.has_on_request.store(false, Ordering::Release);
                self.has_on_response.store(false, Ordering::Release);
                self.enabled.store(false, Ordering::Release);
                let status = {
                    let mut cfg = self.lock_config();
                    cfg.last_error = Some(err_msg.clone());
                    self.build_status_from_cfg(&cfg)
                };
                self.emit_log("error", Some("load"), None, err_msg);
                Ok(status)
            }
        }
    }

    async fn restart_worker_after_failure_locked(
        &self,
        worker_guard: &mut Option<PythonWorkerProcess>,
        was_timeout: bool,
        reason: String,
    ) {
        self.kill_and_clear_worker_locked(worker_guard).await;
        let (spec_opt, code, is_enabled) = {
            let mut cfg = self.lock_config();
            if was_timeout {
                cfg.timeout_count += 1;
            }
            cfg.restart_count += 1;
            cfg.last_error = Some(reason.clone());
            (
                cfg.probed_binary.clone().flatten(),
                cfg.code.clone(),
                cfg.enabled,
            )
        };

        if !is_enabled {
            return;
        }

        if let Some(spec) = spec_opt {
            match self
                .spawn_and_load_locked(worker_guard, &spec, &code)
                .await
            {
                Ok(reply) => {
                    self.emit_stdout_lines("worker", None, &reply.logs);
                    if reply.ok {
                        self.has_on_request
                            .store(reply.has_on_request, Ordering::Release);
                        self.has_on_response
                            .store(reply.has_on_response, Ordering::Release);
                        self.emit_log(
                            "info",
                            Some("worker"),
                            None,
                            "Python worker restarted successfully after failure.",
                        );
                    } else if let Some(err) = reply.error {
                        self.emit_log("error", Some("worker"), None, err);
                    }
                }
                Err(restart_err) => {
                    self.emit_log("error", Some("worker"), None, restart_err);
                }
            }
        }
    }

    async fn acquire_worker_lock(
        &self,
        hook: &str,
        session_id: u64,
    ) -> Option<tokio::sync::MutexGuard<'_, Option<PythonWorkerProcess>>> {
        match tokio::time::timeout(self.lock_acquire_timeout, self.worker.lock()).await {
            Ok(guard) => Some(guard),
            Err(_) => {
                {
                    let mut cfg = self.lock_config();
                    cfg.timeout_count += 1;
                    cfg.last_error = Some(format!(
                        "Python worker queue lock timed out after {} ms waiting for {hook} (fail-open)",
                        self.lock_acquire_timeout.as_millis()
                    ));
                }
                self.emit_log(
                    "warn",
                    Some(hook),
                    Some(session_id),
                    format!(
                        "Python worker busy after {} ms queue wait; skipping {hook} without killing worker (fail-open).",
                        self.lock_acquire_timeout.as_millis()
                    ),
                );
                None
            }
        }
    }

    pub async fn run_on_request(
        &self,
        session_id: u64,
        method: &str,
        url: &str,
        headers: &[HeaderPair],
        body: &[u8],
    ) -> ScriptRequestOutcome {
        if !self.should_run_request() {
            return ScriptRequestOutcome::Unchanged;
        }
        if body.len() > MAX_SCRIPT_BODY_BYTES {
            self.emit_log(
                "warn",
                Some("on_request"),
                Some(session_id),
                format!(
                    "Skipping on_request: body size {} bytes exceeds {} byte limit (fail-open).",
                    body.len(),
                    MAX_SCRIPT_BODY_BYTES
                ),
            );
            return ScriptRequestOutcome::Unchanged;
        }

        let Some(mut worker_guard) = self.acquire_worker_lock("on_request", session_id).await else {
            return ScriptRequestOutcome::Unchanged;
        };

        if !self.should_run_request() {
            return ScriptRequestOutcome::Unchanged;
        }

        if worker_guard.is_none() {
            let (spec_opt, code) = {
                let cfg = self.lock_config();
                (cfg.probed_binary.clone().flatten(), cfg.code.clone())
            };
            let Some(spec) = spec_opt else {
                return ScriptRequestOutcome::Unchanged;
            };
            if let Err(err) = self
                .spawn_and_load_locked(&mut worker_guard, &spec, &code)
                .await
            {
                self.emit_log("error", Some("on_request"), Some(session_id), err);
                return ScriptRequestOutcome::Unchanged;
            }
        }

        {
            let mut cfg = self.lock_config();
            cfg.invocations_count += 1;
        }

        let rpc_id = self.rpc_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let header_pairs: Vec<(&str, &str)> = headers
            .iter()
            .map(|h| (h.name.as_str(), h.value.as_str()))
            .collect();
        let (body_is_utf8, body_text, body_b64) = match std::str::from_utf8(body) {
            Ok(txt) => (true, Some(txt), None),
            Err(_) => (
                false,
                None,
                Some(base64::engine::general_purpose::STANDARD.encode(body)),
            ),
        };
        let payload = RpcRequestPayload {
            id: rpc_id,
            op: "on_request",
            session_id,
            method,
            url,
            headers: header_pairs,
            body_is_utf8,
            body: body_text,
            body_base64: body_b64.as_deref(),
        };

        let reply_res = {
            let Some(worker) = worker_guard.as_mut() else {
                return ScriptRequestOutcome::Unchanged;
            };
            Self::send_rpc_line::<_, RpcRequestReply>(worker, &payload, self.timeout).await
        };

        match reply_res {
            Ok(reply) => {
                self.emit_stdout_lines("on_request", Some(session_id), &reply.logs);
                if !reply.ok {
                    let err_msg = reply
                        .error
                        .unwrap_or_else(|| "Python on_request raised an exception".to_string());
                    {
                        let mut cfg = self.lock_config();
                        cfg.last_error = Some(err_msg.clone());
                    }
                    self.emit_log("error", Some("on_request"), Some(session_id), err_msg);
                    return ScriptRequestOutcome::Unchanged;
                }

                if !reply.modified {
                    return ScriptRequestOutcome::Unchanged;
                }

                let decoded_body = if reply.body_changed {
                    reply.body_base64.as_deref().and_then(|b64| {
                        base64::engine::general_purpose::STANDARD
                            .decode(b64.trim())
                            .ok()
                    })
                } else {
                    None
                };

                let edits = ScriptRequestEdits {
                    method: reply.method,
                    url: reply.url,
                    headers_changed: reply.headers_changed,
                    headers_removed: reply.headers_removed,
                    headers_set: reply.headers_set,
                    body: decoded_body,
                };

                if let Some(mock) = reply.mock_response {
                    let mock_body = base64::engine::general_purpose::STANDARD
                        .decode(mock.body_base64.trim())
                        .unwrap_or_default();
                    let mock_headers = mock
                        .headers
                        .into_iter()
                        .filter(|(k, _)| !k.trim().is_empty())
                        .map(|(name, value)| HeaderPair { name, value })
                        .collect();
                    return ScriptRequestOutcome::MockResponse {
                        edits,
                        mock: ScriptMockResponse {
                            status: mock.status,
                            headers: mock_headers,
                            body: mock_body,
                        },
                    };
                }

                ScriptRequestOutcome::Modified(edits)
            }
            Err(failure) => {
                let was_timeout = matches!(failure, RpcFailure::Timeout);
                let msg = match failure {
                    RpcFailure::Timeout => format!(
                        "Python on_request timed out after {} ms; restarting worker (fail-open).",
                        self.timeout.as_millis()
                    ),
                    RpcFailure::Closed => {
                        "Python worker crashed during on_request; restarting worker (fail-open)."
                            .to_string()
                    }
                    RpcFailure::Io(e) => {
                        format!("Python worker I/O failure during on_request: {e}; restarting.")
                    }
                    RpcFailure::Protocol(e) => {
                        format!("Python worker protocol error during on_request: {e}; restarting.")
                    }
                };
                self.emit_log("error", Some("on_request"), Some(session_id), msg.clone());
                self.restart_worker_after_failure_locked(&mut worker_guard, was_timeout, msg)
                    .await;
                ScriptRequestOutcome::Unchanged
            }
        }
    }

    pub async fn run_on_response(
        &self,
        session_id: u64,
        method: &str,
        url: &str,
        status: u16,
        headers: &[HeaderPair],
        body: &[u8],
    ) -> ScriptResponseOutcome {
        if !self.should_run_response() {
            return ScriptResponseOutcome::Unchanged;
        }
        if body.len() > MAX_SCRIPT_BODY_BYTES {
            self.emit_log(
                "warn",
                Some("on_response"),
                Some(session_id),
                format!(
                    "Skipping on_response: body size {} bytes exceeds {} byte limit (fail-open).",
                    body.len(),
                    MAX_SCRIPT_BODY_BYTES
                ),
            );
            return ScriptResponseOutcome::Unchanged;
        }

        let Some(mut worker_guard) = self.acquire_worker_lock("on_response", session_id).await else {
            return ScriptResponseOutcome::Unchanged;
        };

        if !self.should_run_response() {
            return ScriptResponseOutcome::Unchanged;
        }

        if worker_guard.is_none() {
            let (spec_opt, code) = {
                let cfg = self.lock_config();
                (cfg.probed_binary.clone().flatten(), cfg.code.clone())
            };
            let Some(spec) = spec_opt else {
                return ScriptResponseOutcome::Unchanged;
            };
            if let Err(err) = self
                .spawn_and_load_locked(&mut worker_guard, &spec, &code)
                .await
            {
                self.emit_log("error", Some("on_response"), Some(session_id), err);
                return ScriptResponseOutcome::Unchanged;
            }
        }

        {
            let mut cfg = self.lock_config();
            cfg.invocations_count += 1;
        }

        let rpc_id = self.rpc_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let header_pairs: Vec<(&str, &str)> = headers
            .iter()
            .map(|h| (h.name.as_str(), h.value.as_str()))
            .collect();
        let (body_is_utf8, body_text, body_b64) = match std::str::from_utf8(body) {
            Ok(txt) => (true, Some(txt), None),
            Err(_) => (
                false,
                None,
                Some(base64::engine::general_purpose::STANDARD.encode(body)),
            ),
        };
        let payload = RpcResponsePayload {
            id: rpc_id,
            op: "on_response",
            session_id,
            status,
            method,
            url,
            headers: header_pairs,
            body_is_utf8,
            body: body_text,
            body_base64: body_b64.as_deref(),
        };

        let reply_res = {
            let Some(worker) = worker_guard.as_mut() else {
                return ScriptResponseOutcome::Unchanged;
            };
            Self::send_rpc_line::<_, RpcResponseReply>(worker, &payload, self.timeout).await
        };

        match reply_res {
            Ok(reply) => {
                self.emit_stdout_lines("on_response", Some(session_id), &reply.logs);
                if !reply.ok {
                    let err_msg = reply
                        .error
                        .unwrap_or_else(|| "Python on_response raised an exception".to_string());
                    {
                        let mut cfg = self.lock_config();
                        cfg.last_error = Some(err_msg.clone());
                    }
                    self.emit_log("error", Some("on_response"), Some(session_id), err_msg);
                    return ScriptResponseOutcome::Unchanged;
                }

                if !reply.modified {
                    return ScriptResponseOutcome::Unchanged;
                }

                let decoded_body = if reply.body_changed {
                    reply.body_base64.as_deref().and_then(|b64| {
                        base64::engine::general_purpose::STANDARD
                            .decode(b64.trim())
                            .ok()
                    })
                } else {
                    None
                };

                ScriptResponseOutcome::Modified(ScriptResponseEdits {
                    status: reply.status,
                    headers_changed: reply.headers_changed,
                    headers_removed: reply.headers_removed,
                    headers_set: reply.headers_set,
                    body: decoded_body,
                })
            }
            Err(failure) => {
                let was_timeout = matches!(failure, RpcFailure::Timeout);
                let msg = match failure {
                    RpcFailure::Timeout => format!(
                        "Python on_response timed out after {} ms; restarting worker (fail-open).",
                        self.timeout.as_millis()
                    ),
                    RpcFailure::Closed => {
                        "Python worker crashed during on_response; restarting worker (fail-open)."
                            .to_string()
                    }
                    RpcFailure::Io(e) => {
                        format!("Python worker I/O failure during on_response: {e}; restarting.")
                    }
                    RpcFailure::Protocol(e) => {
                        format!("Python worker protocol error during on_response: {e}; restarting.")
                    }
                };
                self.emit_log("error", Some("on_response"), Some(session_id), msg.clone());
                self.restart_worker_after_failure_locked(&mut worker_guard, was_timeout, msg)
                    .await;
                ScriptResponseOutcome::Unchanged
            }
        }
    }

    pub fn shutdown_sync(&self) {
        self.enabled.store(false, Ordering::Release);
        self.has_on_request.store(false, Ordering::Release);
        self.has_on_response.store(false, Ordering::Release);
        if let Ok(mut guard) = self.worker.try_lock() {
            if let Some(mut worker) = guard.take() {
                let _ = worker.child.start_kill();
                worker.stderr_task.abort();
            }
        }
        let mut cfg = self.lock_config();
        cfg.enabled = false;
        cfg.worker_running = false;
        cfg.worker_pid = None;
    }
}

enum RpcFailure {
    Timeout,
    Closed,
    Io(String),
    Protocol(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn default_timeout_is_1500ms() {
        assert_eq!(DEFAULT_SCRIPT_TIMEOUT, Duration::from_millis(1500));
    }

    #[test]
    fn apply_header_diff_preserves_unmodified_duplicate_headers() {
        let mut headers = vec![
            HeaderPair {
                name: "Set-Cookie".into(),
                value: "sid=1; Path=/".into(),
            },
            HeaderPair {
                name: "Set-Cookie".into(),
                value: "csrf=2; Path=/".into(),
            },
            HeaderPair {
                name: "X-Remove".into(),
                value: "gone".into(),
            },
            HeaderPair {
                name: "X-Replace".into(),
                value: "old".into(),
            },
        ];

        let changed = apply_header_diff(
            &mut headers,
            &["x-remove".to_string()],
            &[
                ("X-Replace".to_string(), "new".to_string()),
                ("X-Added".to_string(), "yes".to_string()),
            ],
        );

        assert!(changed);
        let cookies: Vec<&str> = headers
            .iter()
            .filter(|h| h.name == "Set-Cookie")
            .map(|h| h.value.as_str())
            .collect();
        assert_eq!(cookies, vec!["sid=1; Path=/", "csrf=2; Path=/"]);
        assert!(!headers.iter().any(|h| h.name.eq_ignore_ascii_case("x-remove")));
        assert_eq!(
            headers
                .iter()
                .find(|h| h.name == "X-Replace")
                .map(|h| h.value.as_str()),
            Some("new")
        );
        assert_eq!(
            headers
                .iter()
                .find(|h| h.name == "X-Added")
                .map(|h| h.value.as_str()),
            Some("yes")
        );
    }

    #[tokio::test]
    async fn fail_open_when_python_unavailable() {
        let runner = PythonScriptRunner::new_with_options(
            Duration::from_millis(500),
            Some(vec![("__nonexistent_flux_python_bin__".to_string(), Vec::new())]),
        );

        let status = runner
            .set_script("def on_request(req):\n    pass\n".to_string(), true)
            .await
            .expect("missing python should not throw fatal error");

        assert!(!status.available);
        assert!(!status.enabled);
        assert!(!status.running);
        assert!(status.last_error.is_some());

        let req_outcome = runner
            .run_on_request(1, "GET", "https://example.com/", &[], b"")
            .await;
        assert!(matches!(req_outcome, ScriptRequestOutcome::Unchanged));

        let resp_outcome = runner
            .run_on_response(1, "GET", "https://example.com/", 200, &[], b"{}")
            .await;
        assert!(matches!(resp_outcome, ScriptResponseOutcome::Unchanged));
    }

    #[tokio::test]
    async fn protocol_roundtrip_modifies_request_response_and_captures_logs() {
        let runner = PythonScriptRunner::new(None);
        let probe = runner.get_status().await;
        if !probe.available {
            return;
        }

        let script = r#"
import json

def on_request(request):
    print(f"REQ {request['method']} {request['url']}")
    request["headers"]["X-Flux-Script"] = "applied"
    request["url"] = request["url"] + "&rewritten=1"
    request["body"] = json.dumps({"injected": True})

def on_response(response, request):
    print(f"RESP {response['status']} for {request['url']}")
    response["status"] = 201
    response["headers"]["X-Resp-Script"] = "ok"
    data = json.loads(response["body"])
    data["patched"] = True
    response["body"] = json.dumps(data)
"#;

        let status = runner
            .set_script(script.to_string(), true)
            .await
            .expect("script should load");
        assert!(status.available);
        assert!(status.enabled);
        assert!(status.running);
        assert!(status.has_on_request);
        assert!(status.has_on_response);
        assert!(status.last_error.is_none());

        let req_headers = vec![HeaderPair {
            name: "Host".into(),
            value: "api.example.com".into(),
        }];
        let req_outcome = runner
            .run_on_request(
                42,
                "POST",
                "https://api.example.com/v1/items?page=1",
                &req_headers,
                br#"{"raw":1}"#,
            )
            .await;

        match req_outcome {
            ScriptRequestOutcome::Modified(edits) => {
                assert_eq!(
                    edits.url.as_deref(),
                    Some("https://api.example.com/v1/items?page=1&rewritten=1")
                );
                assert!(edits.headers_changed);
                assert!(edits
                    .headers_set
                    .iter()
                    .any(|(k, v)| k == "X-Flux-Script" && v == "applied"));
                let body_str = String::from_utf8(edits.body.unwrap()).unwrap();
                assert!(body_str.contains("\"injected\": true"));
            }
            other => panic!("expected Modified request outcome, got {other:?}"),
        }

        let resp_headers = vec![
            HeaderPair {
                name: "Set-Cookie".into(),
                value: "a=1".into(),
            },
            HeaderPair {
                name: "Set-Cookie".into(),
                value: "b=2".into(),
            },
        ];
        let resp_outcome = runner
            .run_on_response(
                42,
                "POST",
                "https://api.example.com/v1/items?page=1&rewritten=1",
                200,
                &resp_headers,
                br#"{"ok":true}"#,
            )
            .await;

        match resp_outcome {
            ScriptResponseOutcome::Modified(edits) => {
                assert_eq!(edits.status, Some(201));
                assert!(edits.headers_changed);
                let mut merged = resp_headers.clone();
                apply_header_diff(&mut merged, &edits.headers_removed, &edits.headers_set);
                assert_eq!(
                    merged
                        .iter()
                        .filter(|h| h.name == "Set-Cookie")
                        .count(),
                    2,
                    "unmodified duplicate Set-Cookie headers must be preserved"
                );
                assert!(merged
                    .iter()
                    .any(|h| h.name == "X-Resp-Script" && h.value == "ok"));
                let body_str = String::from_utf8(edits.body.unwrap()).unwrap();
                assert!(body_str.contains("\"patched\": true"));
            }
            other => panic!("expected Modified response outcome, got {other:?}"),
        }

        let logs = runner.take_test_logs();
        assert!(logs
            .iter()
            .any(|l| l.level == "stdout" && l.message.contains("REQ POST")));
        assert!(logs
            .iter()
            .any(|l| l.level == "stdout" && l.message.contains("RESP 200")));

        let after_status = runner.get_status().await;
        assert_eq!(after_status.invocations_count, 2);
        assert_eq!(after_status.timeout_count, 0);
        runner.shutdown_sync();
    }

    #[tokio::test]
    async fn conditional_mock_short_circuits_request() {
        let runner = PythonScriptRunner::new(None);
        if !runner.get_status().await.available {
            return;
        }

        let script = r#"
import json

def on_request(request):
    if "/feature-flags" in request["url"]:
        request["mock_response"] = {
            "status": 200,
            "headers": {"Content-Type": "application/json", "X-Mock": "python"},
            "body": json.dumps({"beta": True})
        }
"#;
        runner.set_script(script.to_string(), true).await.unwrap();

        let mocked = runner
            .run_on_request(1, "GET", "https://app.test/feature-flags", &[], b"")
            .await;
        match mocked {
            ScriptRequestOutcome::MockResponse { mock, .. } => {
                assert_eq!(mock.status, 200);
                assert!(mock
                    .headers
                    .iter()
                    .any(|h| h.name == "X-Mock" && h.value == "python"));
                assert_eq!(String::from_utf8_lossy(&mock.body), "{\"beta\": true}");
            }
            other => panic!("expected MockResponse, got {other:?}"),
        }

        let passthrough = runner
            .run_on_request(2, "GET", "https://app.test/users", &[], b"")
            .await;
        assert!(matches!(passthrough, ScriptRequestOutcome::Unchanged));
        runner.shutdown_sync();
    }

    #[tokio::test]
    async fn fail_open_on_python_exception_keeps_worker_alive() {
        let runner = PythonScriptRunner::new(None);
        if !runner.get_status().await.available {
            return;
        }

        let script = r#"
def on_request(request):
    if "/boom" in request["url"]:
        print("about to fail")
        _ = 1 / 0
    request["headers"]["X-Alive"] = "1"
"#;
        let initial = runner.set_script(script.to_string(), true).await.unwrap();
        let pid1 = initial.worker_pid;

        let failed = runner
            .run_on_request(10, "GET", "https://test/boom", &[], b"")
            .await;
        assert!(matches!(failed, ScriptRequestOutcome::Unchanged));

        let logs = runner.take_test_logs();
        assert!(logs.iter().any(|l| l.level == "stdout" && l.message.contains("about to fail")));
        assert!(logs.iter().any(|l| l.level == "error" && l.message.contains("ZeroDivisionError")));

        let ok_res = runner
            .run_on_request(11, "GET", "https://test/ok", &[], b"")
            .await;
        match ok_res {
            ScriptRequestOutcome::Modified(edits) => {
                assert!(edits
                    .headers_set
                    .iter()
                    .any(|(k, v)| k == "X-Alive" && v == "1"));
            }
            other => panic!("expected Modified after exception, got {other:?}"),
        }
        let after = runner.get_status().await;
        assert_eq!(after.worker_pid, pid1);
        assert_eq!(after.restart_count, 0);
        runner.shutdown_sync();
    }

    #[tokio::test]
    async fn fail_open_and_restarts_worker_on_timeout() {
        let runner = PythonScriptRunner::new_with_options(Duration::from_millis(250), None);
        if !runner.get_status().await.available {
            return;
        }

        let script = r#"
import time

def on_request(request):
    if "/hang" in request["url"]:
        time.sleep(5.0)
    request["headers"]["X-Recovered"] = "yes"
"#;
        let initial = runner.set_script(script.to_string(), true).await.unwrap();
        let pid_before = initial.worker_pid;

        let t0 = Instant::now();
        let timed_out = runner
            .run_on_request(99, "GET", "https://test/hang", &[], b"")
            .await;
        let elapsed = t0.elapsed();

        assert!(matches!(timed_out, ScriptRequestOutcome::Unchanged));
        assert!(
            elapsed < Duration::from_millis(4500),
            "timeout + restart should stay bounded, took {:?}",
            elapsed
        );

        let mid = runner.get_status().await;
        assert_eq!(mid.timeout_count, 1);
        assert_eq!(mid.restart_count, 1);
        assert!(mid.running);
        assert_ne!(mid.worker_pid, pid_before);

        let recovered = runner
            .run_on_request(100, "GET", "https://test/ok", &[], b"")
            .await;
        match recovered {
            ScriptRequestOutcome::Modified(edits) => {
                assert!(edits
                    .headers_set
                    .iter()
                    .any(|(k, v)| k == "X-Recovered" && v == "yes"));
            }
            other => panic!("expected Modified on restarted worker, got {other:?}"),
        }
        runner.shutdown_sync();
    }

    #[tokio::test]
    async fn fail_open_and_restarts_worker_on_crash() {
        let runner = PythonScriptRunner::new_with_options(Duration::from_millis(1500), None);
        if !runner.get_status().await.available {
            return;
        }

        let script = r#"
import os

def on_request(request):
    if "/crash" in request["url"]:
        os._exit(1)
    request["headers"]["X-After-Crash"] = "ok"
"#;
        let initial = runner.set_script(script.to_string(), true).await.unwrap();
        let pid_before = initial.worker_pid;

        let crashed = runner
            .run_on_request(5, "GET", "https://test/crash", &[], b"")
            .await;
        assert!(matches!(crashed, ScriptRequestOutcome::Unchanged));

        let mid = runner.get_status().await;
        assert_eq!(mid.restart_count, 1);
        assert!(mid.running);
        assert_ne!(mid.worker_pid, pid_before);

        let ok_res = runner
            .run_on_request(6, "GET", "https://test/ok", &[], b"")
            .await;
        assert!(matches!(ok_res, ScriptRequestOutcome::Modified(_)));
        runner.shutdown_sync();
    }

    #[tokio::test]
    async fn queue_lock_timeout_skips_fail_open_without_killing_worker() {
        // Part 1: deterministic queue-timeout check without requiring Python binary
        let locked_runner = Arc::new(PythonScriptRunner::new_with_timeouts(
            Duration::from_millis(1500),
            Duration::from_millis(40),
            None,
        ));
        locked_runner.enabled.store(true, Ordering::Release);
        locked_runner.has_on_request.store(true, Ordering::Release);
        locked_runner.has_on_response.store(true, Ordering::Release);

        {
            let _held_guard = locked_runner.worker.lock().await;
            let req_res = locked_runner
                .run_on_request(101, "GET", "https://example.com/q", &[], b"")
                .await;
            let resp_res = locked_runner
                .run_on_response(102, "GET", "https://example.com/q", 200, &[], b"")
                .await;
            assert!(matches!(req_res, ScriptRequestOutcome::Unchanged));
            assert!(matches!(resp_res, ScriptResponseOutcome::Unchanged));
        }
        {
            let cfg = locked_runner.lock_config();
            assert_eq!(cfg.timeout_count, 2);
            assert_eq!(cfg.restart_count, 0);
        }
        let logs = locked_runner.take_test_logs();
        assert_eq!(logs.len(), 2);
        assert!(logs.iter().all(|l| l.level == "warn"));

        // Part 2: with live Python worker, slow-but-valid RPC (< pipe timeout) holds mutex past
        // concurrent caller's lock_acquire_timeout; concurrent caller skips fail-open WITHOUT killing worker.
        let runner = Arc::new(PythonScriptRunner::new_with_timeouts(
            Duration::from_millis(1500),
            Duration::from_millis(150),
            None,
        ));
        if !runner.get_status().await.available {
            return;
        }

        let script = r#"
import time

def on_request(request):
    if "/slow" in request["url"]:
        time.sleep(0.45)
    request["headers"]["X-Worker-Ok"] = "yes"
"#;
        let initial = runner.set_script(script.to_string(), true).await.unwrap();
        let pid_before = initial.worker_pid;
        assert!(pid_before.is_some());

        let r1 = Arc::clone(&runner);
        let slow_task = tokio::spawn(async move {
            r1.run_on_request(201, "GET", "https://test/slow", &[], b"")
                .await
        });

        // Yield briefly so slow_task acquires worker mutex first
        tokio::time::sleep(Duration::from_millis(30)).await;

        let queued_res = runner
            .run_on_request(202, "GET", "https://test/queued", &[], b"")
            .await;
        assert!(matches!(queued_res, ScriptRequestOutcome::Unchanged));

        let slow_res = slow_task.await.expect("slow task join");
        assert!(matches!(slow_res, ScriptRequestOutcome::Modified(_)));

        let mid = runner.get_status().await;
        assert_eq!(mid.restart_count, 0, "queue lock timeout must never kill/restart worker");
        assert_eq!(mid.worker_pid, pid_before);
        assert!(mid.running);
        assert_eq!(mid.timeout_count, 1);

        let fast_res = runner
            .run_on_request(203, "GET", "https://test/fast", &[], b"")
            .await;
        assert!(matches!(fast_res, ScriptRequestOutcome::Modified(_)));
        let after = runner.get_status().await;
        assert_eq!(after.restart_count, 0);
        assert_eq!(after.worker_pid, pid_before);

        runner.shutdown_sync();
    }
}
