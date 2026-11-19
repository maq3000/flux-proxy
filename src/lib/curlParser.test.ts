import { describe, expect, it } from "vitest";
import {
  isCurlCommand,
  parseCurlCommand,
  tokenizeShellCommand,
} from "./curlParser";

describe("curlParser — tokenization & Windows/Bash/PowerShell quoting", () => {
  it("detects curl and curl.exe commands", () => {
    expect(isCurlCommand("  curl https://api.example.com")).toBe(true);
    expect(isCurlCommand("CURL.EXE -X POST https://api.example.com")).toBe(true);
    expect(isCurlCommand("fetch('https://api.example.com')")).toBe(false);
  });

  it("tokenizes bash line continuations, single/double quotes, and ANSI-C $'...' strings", () => {
    const cmd = [
      "curl -X POST \\",
      `  'https://api.test/v1/echo' \\`,
      `  -H "X-Quote: \\"hi\\" \\nliteral" \\`,
      `  --data-raw $'line1\\nline2\\x21\\u2713\\t\\''`,
    ].join("\n");

    const tok = tokenizeShellCommand(cmd);
    expect(tok.ok).toBe(true);
    if (!tok.ok) return;

    expect(tok.tokens).toEqual([
      "curl",
      "-X",
      "POST",
      "https://api.test/v1/echo",
      "-H",
      'X-Quote: "hi" \\nliteral',
      "--data-raw",
      "line1\nline2!\u2713\t'",
    ]);
  });

  it("handles Chrome DevTools Windows cmd ^\"...^\" escapes and PowerShell backtick continuations", () => {
    const cmdWin = [
      'curl ^"https://api.test/items^" ^',
      '  -H ^"content-type: application/json^" ^',
      '  --data-raw ^"{\\"ok\\":true}^"',
    ].join("\r\n");

    const parsedWin = parseCurlCommand(cmdWin);
    expect(parsedWin.ok).toBe(true);
    if (!parsedWin.ok) return;
    expect(parsedWin.result.request.url).toBe("https://api.test/items");
    expect(parsedWin.result.request.headers).toEqual([
      { name: "content-type", value: "application/json" },
    ]);
    expect(parsedWin.result.request.body).toBe('{"ok":true}');

    const psCmd = [
      "curl.exe -X PUT `",
      "  'https://api.test/ps' `",
      "  --data-raw 'payload'",
    ].join("\n");
    const parsedPs = parseCurlCommand(psCmd);
    expect(parsedPs.ok).toBe(true);
    if (!parsedPs.ok) return;
    expect(parsedPs.result.request.method).toBe("PUT");
    expect(parsedPs.result.request.url).toBe("https://api.test/ps");
    expect(parsedPs.result.request.body).toBe("payload");
  });

  it("returns explicit errors on unclosed quotes", () => {
    expect(tokenizeShellCommand("curl 'unclosed").ok).toBe(false);
    expect(tokenizeShellCommand('curl "unclosed').ok).toBe(false);
    expect(tokenizeShellCommand("curl $'unclosed\\").ok).toBe(false);
  });
});

describe("curlParser — parseCurlCommand semantics", () => {
  it("parses GET with implicit http:// scheme, headers, removal, cookies, and auth flags", () => {
    const parsed = parseCurlCommand(
      `curl api.example.com/v1/users -H "Accept: application/json" -H "Accept:" -H "X-Empty;" -H "X-Trace: 123" -b "sid=1" -b "theme=dark" -A "MyAgent/1.0" -e "https://ref.test" -u "alice:s3cr3t" --max-redirs 0`
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { request, warnings } = parsed.result;

    expect(warnings).toHaveLength(0);
    expect(request.method).toBe("GET");
    expect(request.url).toBe("http://api.example.com/v1/users");
    expect(request.followRedirects).toBe(false);
    expect(request.headers).toEqual([
      { name: "X-Empty", value: "" },
      { name: "X-Trace", value: "123" },
      { name: "Cookie", value: "sid=1; theme=dark" },
      { name: "User-Agent", value: "MyAgent/1.0" },
      { name: "Referer", value: "https://ref.test" },
      { name: "Authorization", value: `Basic ${btoa("alice:s3cr3t")}` },
    ]);
  });

  it("handles --json, --data-urlencode, -G query appending with hash, -I HEAD, and clustered short flags", () => {
    const jsonRes = parseCurlCommand(
      `curl --json '{"hello":"world"}' https://api.test/json`
    );
    expect(jsonRes.ok).toBe(true);
    if (jsonRes.ok) {
      expect(jsonRes.result.request.method).toBe("POST");
      expect(jsonRes.result.request.body).toBe('{"hello":"world"}');
      expect(jsonRes.result.request.headers).toEqual([
        { name: "Content-Type", value: "application/json" },
        { name: "Accept", value: "application/json" },
      ]);
    }

    const urlEncRes = parseCurlCommand(
      `curl -sSL --data-urlencode "q=hello world" --data-urlencode "a=1&2" https://api.test/form`
    );
    expect(urlEncRes.ok).toBe(true);
    if (urlEncRes.ok) {
      expect(urlEncRes.result.request.method).toBe("POST");
      expect(urlEncRes.result.request.body).toBe("q=hello%20world&a=1%262");
      expect(urlEncRes.result.request.headers).toContainEqual({
        name: "Content-Type",
        value: "application/x-www-form-urlencoded",
      });
    }

    const getQueryRes = parseCurlCommand(
      `curl -G -d "a=1" --data-urlencode "b=hello world" "https://api.test/search?existing=0#top"`
    );
    expect(getQueryRes.ok).toBe(true);
    if (getQueryRes.ok) {
      expect(getQueryRes.result.request.method).toBe("GET");
      expect(getQueryRes.result.request.body).toBe("");
      expect(getQueryRes.result.request.url).toBe(
        "https://api.test/search?existing=0&a=1&b=hello%20world#top"
      );
    }

    const headRes = parseCurlCommand(`curl -sILXDELETE https://api.test/head`);
    expect(headRes.ok).toBe(true);
    if (headRes.ok) {
      expect(headRes.result.request.method).toBe("DELETE");
    }

    const implicitHead = parseCurlCommand(`curl -I https://api.test/ping`);
    expect(implicitHead.ok).toBe(true);
    if (implicitHead.ok) {
      expect(implicitHead.result.request.method).toBe("HEAD");
    }
  });

  it("handles --oauth2-bearer, -- delimiter, warnings, and validation errors", () => {
    const warnRes = parseCurlCommand(
      `curl --oauth2-bearer tok123 -x http://proxy:8080 -b cookies.txt -d @body.json -F "file=@a.png" --unknown-flag -- https://api.test/upload`
    );
    expect(warnRes.ok).toBe(true);
    if (warnRes.ok) {
      expect(warnRes.result.request.url).toBe("https://api.test/upload");
      expect(warnRes.result.request.headers).toContainEqual({
        name: "Authorization",
        value: "Bearer tok123",
      });
      expect(warnRes.result.warnings.length).toBeGreaterThanOrEqual(5);
    }

    expect(parseCurlCommand("   ").ok).toBe(false);
    expect(parseCurlCommand("wget https://api.test").ok).toBe(false);
    expect(parseCurlCommand("curl -X GET").ok).toBe(false);
    expect(parseCurlCommand("curl -H").ok).toBe(false);
    expect(parseCurlCommand("curl --header").ok).toBe(false);
  });
});
