import type { ComposedRequest, HeaderPair } from "../types/proxy";
import { encodeTextToBase64 } from "./formatters";

export interface ParsedCurlResult {
  request: ComposedRequest;
  warnings: string[];
}

export type ParseCurlOutcome =
  | { ok: true; result: ParsedCurlResult }
  | { ok: false; error: string };

export type TokenizeOutcome =
  | { ok: true; tokens: string[] }
  | { ok: false; error: string };

const CURL_EXECUTABLE_RE = /^curl(?:\.exe)?$/i;

const SHORT_VALUE_FLAGS = new Set([
  "X",
  "H",
  "b",
  "A",
  "e",
  "u",
  "d",
  "x",
  "m",
  "o",
  "w",
  "E",
  "c",
  "D",
  "U",
  "F",
  "T",
  "r",
  "Y",
  "y",
  "z",
  "K",
  "C",
  "Q",
  "P",
  "t",
]);

const LONG_VALUE_FLAGS = new Set([
  "request",
  "header",
  "cookie",
  "user-agent",
  "referer",
  "user",
  "data",
  "data-ascii",
  "data-binary",
  "data-raw",
  "data-urlencode",
  "json",
  "url",
  "proxy",
  "max-time",
  "connect-timeout",
  "output",
  "write-out",
  "cacert",
  "cert",
  "key",
  "resolve",
  "interface",
  "retry",
  "cookie-jar",
  "dump-header",
  "proxy-user",
  "max-redirs",
  "form",
  "form-string",
  "oauth2-bearer",
  "connect-to",
  "noproxy",
  "proxy-header",
  "range",
  "upload-file",
]);

const LONG_BOOLEAN_FLAGS = new Set([
  "get",
  "head",
  "location",
  "location-trusted",
  "compressed",
  "insecure",
  "include",
  "silent",
  "show-error",
  "verbose",
  "fail",
  "fail-with-body",
  "http1.0",
  "http1.1",
  "http2",
  "http2-prior-knowledge",
  "http3",
  "http3-only",
  "globoff",
  "no-buffer",
  "ipv4",
  "ipv6",
  "raw",
  "remote-name",
  "remote-header-name",
  "no-keepalive",
  "anyauth",
  "basic",
  "digest",
  "negotiate",
  "ntlm",
  "tlsv1",
  "tlsv1.0",
  "tlsv1.1",
  "tlsv1.2",
  "tlsv1.3",
  "ssl",
  "ssl-reqd",
  "create-dirs",
  "no-alpn",
  "no-npn",
  "no-progress-meter",
  "progress-bar",
  "proxytunnel",
  "tcp-fastopen",
  "tcp-nodelay",
  "tr-encoding",
]);

/**
 * Returns true if the clipboard/pasted text looks like a cURL command.
 */
export function isCurlCommand(text: string): boolean {
  return /^curl(?:\.exe)?\s+/i.test(text.trimStart());
}

/**
 * Converts Chrome/Edge DevTools "Copy as cURL (cmd)" caret-escaped syntax (`^"..."^`)
 * into standard shell-quoted text before tokenization.
 */
function preprocessCmdCaretEscapes(rawInput: string): string {
  let out = "";
  let i = 0;

  while (i < rawInput.length) {
    const ch = rawInput[i];
    if (ch === "^") {
      if (rawInput[i + 1] === "\r" && rawInput[i + 2] === "\n") {
        i += 3;
        if (rawInput[i] === "\r" && rawInput[i + 1] === "\n") {
          out += "\n";
          i += 2;
        } else if (rawInput[i] === "\n") {
          out += "\n";
          i += 1;
        }
        continue;
      }
      if (rawInput[i + 1] === "\n") {
        i += 2;
        if (rawInput[i] === "\r" && rawInput[i + 1] === "\n") {
          out += "\n";
          i += 2;
        } else if (rawInput[i] === "\n") {
          out += "\n";
          i += 1;
        }
        continue;
      }
      if (i + 1 < rawInput.length) {
        out += rawInput[i + 1];
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function isHexDigit(ch: string | undefined): boolean {
  return ch !== undefined && /^[0-9a-fA-F]$/.test(ch);
}

function isOctalDigit(ch: string | undefined): boolean {
  return ch !== undefined && /^[0-7]$/.test(ch);
}

function readAnsiCQuoted(
  input: string,
  startIndex: number
):
  | { ok: true; value: string; nextIndex: number }
  | { ok: false; error: string } {
  let value = "";
  let i = startIndex;

  while (i < input.length) {
    const ch = input[i];
    if (ch === "'") {
      return { ok: true, value, nextIndex: i + 1 };
    }
    if (ch !== "\\") {
      value += ch;
      i += 1;
      continue;
    }

    if (i + 1 >= input.length) {
      return { ok: false, error: "Незакрытая ANSI-C кавычка $'...'" };
    }

    const esc = input[i + 1];
    switch (esc) {
      case "a":
        value += "\x07";
        i += 2;
        break;
      case "b":
        value += "\b";
        i += 2;
        break;
      case "e":
      case "E":
        value += "\x1b";
        i += 2;
        break;
      case "f":
        value += "\f";
        i += 2;
        break;
      case "n":
        value += "\n";
        i += 2;
        break;
      case "r":
        value += "\r";
        i += 2;
        break;
      case "t":
        value += "\t";
        i += 2;
        break;
      case "v":
        value += "\v";
        i += 2;
        break;
      case "\\":
        value += "\\";
        i += 2;
        break;
      case "'":
        value += "'";
        i += 2;
        break;
      case '"':
        value += '"';
        i += 2;
        break;
      case "?":
        value += "?";
        i += 2;
        break;
      case "x": {
        let hex = "";
        let j = i + 2;
        while (j < input.length && hex.length < 2 && isHexDigit(input[j])) {
          hex += input[j];
          j += 1;
        }
        if (hex.length > 0) {
          value += String.fromCharCode(parseInt(hex, 16));
          i = j;
        } else {
          value += "\\x";
          i += 2;
        }
        break;
      }
      case "u": {
        let hex = "";
        let j = i + 2;
        while (j < input.length && hex.length < 4 && isHexDigit(input[j])) {
          hex += input[j];
          j += 1;
        }
        if (hex.length > 0) {
          value += String.fromCodePoint(parseInt(hex, 16));
          i = j;
        } else {
          value += "\\u";
          i += 2;
        }
        break;
      }
      case "U": {
        let hex = "";
        let j = i + 2;
        while (j < input.length && hex.length < 8 && isHexDigit(input[j])) {
          hex += input[j];
          j += 1;
        }
        if (hex.length > 0) {
          const cp = parseInt(hex, 16);
          value += cp <= 0x10ffff ? String.fromCodePoint(cp) : `\\U${hex}`;
          i = j;
        } else {
          value += "\\U";
          i += 2;
        }
        break;
      }
      case "c": {
        if (i + 2 < input.length && input[i + 2] !== "'") {
          const ctrlChar = input[i + 2].toUpperCase().charCodeAt(0);
          value += String.fromCharCode(ctrlChar ^ 0x40);
          i += 3;
        } else {
          value += "\\c";
          i += 2;
        }
        break;
      }
      default: {
        if (isOctalDigit(esc)) {
          let oct = "";
          let j = i + 1;
          while (j < input.length && oct.length < 3 && isOctalDigit(input[j])) {
            oct += input[j];
            j += 1;
          }
          value += String.fromCharCode(parseInt(oct, 8) & 0xff);
          i = j;
        } else {
          value += `\\${esc}`;
          i += 2;
        }
        break;
      }
    }
  }

  return { ok: false, error: "Незакрытая ANSI-C кавычка $'...'" };
}

/**
 * Deterministic shell lexer without `eval`.
 * Supports bash (`\`), Windows cmd (`^`, including Chrome DevTools `^"` escaping),
 * PowerShell (`` ` ``) line continuations, `'...'`, `"..."`, and ANSI-C `$'...'` quotes.
 */
export function tokenizeShellCommand(rawInput: string): TokenizeOutcome {
  const input = /(?:^|[\s=])\^"/.test(rawInput)
    ? preprocessCmdCaretEscapes(rawInput)
    : rawInput;

  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let i = 0;

  const flushToken = () => {
    if (inToken) {
      tokens.push(current);
      current = "";
      inToken = false;
    }
  };

  while (i < input.length) {
    const ch = input[i];

    // Unquoted line continuations & backslash escaping
    if (ch === "\\") {
      if (input[i + 1] === "\r" && input[i + 2] === "\n") {
        i += 3;
        continue;
      }
      if (input[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 < input.length) {
        current += input[i + 1];
        inToken = true;
        i += 2;
        continue;
      }
      current += "\\";
      inToken = true;
      i += 1;
      continue;
    }

    if (ch === "^") {
      if (input[i + 1] === "\r" && input[i + 2] === "\n") {
        i += 3;
        continue;
      }
      if (input[i + 1] === "\n") {
        i += 2;
        continue;
      }
    }

    if (ch === "`") {
      if (input[i + 1] === "\r" && input[i + 2] === "\n") {
        i += 3;
        continue;
      }
      if (input[i + 1] === "\n") {
        i += 2;
        continue;
      }
    }

    // Unquoted whitespace separates tokens
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      flushToken();
      i += 1;
      continue;
    }

    // ANSI-C single-quoted string $'...'
    if (ch === "$" && input[i + 1] === "'") {
      const res = readAnsiCQuoted(input, i + 2);
      if (!res.ok) return res;
      current += res.value;
      inToken = true;
      i = res.nextIndex;
      continue;
    }

    // Strictly literal single-quoted string '...'
    if (ch === "'") {
      const closeIdx = input.indexOf("'", i + 1);
      if (closeIdx === -1) {
        return { ok: false, error: "Незакрытая одинарная кавычка '...'" };
      }
      current += input.slice(i + 1, closeIdx);
      inToken = true;
      i = closeIdx + 1;
      continue;
    }

    // Double-quoted string "..."
    if (ch === '"') {
      let j = i + 1;
      let closed = false;

      while (j < input.length) {
        const c = input[j];
        if (c === "\\") {
          if (input[j + 1] === "\r" && input[j + 2] === "\n") {
            j += 3;
            continue;
          }
          if (input[j + 1] === "\n") {
            j += 2;
            continue;
          }
          const next = input[j + 1];
          if (next === undefined) {
            return { ok: false, error: 'Незакрытая двойная кавычка "..."' };
          }
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            current += next;
            j += 2;
          } else {
            // Preserve literal backslash for escapes like \n inside JSON strings
            current += `\\${next}`;
            j += 2;
          }
          continue;
        }
        if (c === '"') {
          closed = true;
          j += 1;
          break;
        }
        current += c;
        j += 1;
      }

      if (!closed) {
        return { ok: false, error: 'Незакрытая двойная кавычка "..."' };
      }
      inToken = true;
      i = j;
      continue;
    }

    current += ch;
    inToken = true;
    i += 1;
  }

  flushToken();
  return { ok: true, tokens };
}

function upsertHeader(headers: HeaderPair[], name: string, value: string): void {
  const lower = name.toLowerCase();
  const idx = headers.findIndex((h) => h.name.toLowerCase() === lower);
  if (idx >= 0) {
    headers[idx] = { name, value };
  } else {
    headers.push({ name, value });
  }
}

function hasHeader(headers: HeaderPair[], name: string): boolean {
  const lower = name.toLowerCase();
  return headers.some((h) => h.name.toLowerCase() === lower);
}

function removeHeader(headers: HeaderPair[], name: string): void {
  const lower = name.toLowerCase();
  for (let i = headers.length - 1; i >= 0; i -= 1) {
    if (headers[i].name.toLowerCase() === lower) {
      headers.splice(i, 1);
    }
  }
}

function encodeUrlEncodedItem(raw: string): string {
  const eqIdx = raw.indexOf("=");
  if (eqIdx === -1) {
    return encodeURIComponent(raw);
  }
  const key = raw.slice(0, eqIdx);
  const val = raw.slice(eqIdx + 1);
  if (key.length === 0) {
    return encodeURIComponent(val);
  }
  return `${key}=${encodeURIComponent(val)}`;
}

function appendQueryToUrl(baseUrl: string, query: string): string {
  if (!query) return baseUrl;
  const hashIdx = baseUrl.indexOf("#");
  const withoutHash = hashIdx >= 0 ? baseUrl.slice(0, hashIdx) : baseUrl;
  const hash = hashIdx >= 0 ? baseUrl.slice(hashIdx) : "";
  const separator = withoutHash.includes("?")
    ? withoutHash.endsWith("?") || withoutHash.endsWith("&")
      ? ""
      : "&"
    : "?";
  return `${withoutHash}${separator}${query}${hash}`;
}

/**
 * Parses a cURL CLI command into a `ComposedRequest` suitable for ComposerPanel.
 */
export function parseCurlCommand(rawInput: string): ParseCurlOutcome {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { ok: false, error: "Вставьте команду cURL для разбора" };
  }

  const tokenized = tokenizeShellCommand(trimmed);
  if (!tokenized.ok) {
    return tokenized;
  }

  const tokens = tokenized.tokens;
  if (tokens.length === 0) {
    return { ok: false, error: "Пустая команда cURL" };
  }

  const execParts = tokens[0].split(/[\\/]/);
  const execBase = execParts[execParts.length - 1] ?? "";
  if (!CURL_EXECUTABLE_RE.test(execBase)) {
    return {
      ok: false,
      error: "Команда должна начинаться с `curl`",
    };
  }

  let explicitMethod: string | null = null;
  let implicitHead = false;
  let forceGetQuery = false;
  let url = "";
  let followRedirects = true;
  const headers: HeaderPair[] = [];
  const dataParts: string[] = [];
  const jsonParts: string[] = [];
  let hasBodyFlag = false;
  let hasJsonFlag = false;
  let hasUrlEncodedFlag = false;
  const warnings: string[] = [];

  const applyOptionValue = (flag: string, value: string) => {
    switch (flag) {
      case "X":
      case "request": {
        const clean = value.trim().toUpperCase();
        if (clean) explicitMethod = clean;
        break;
      }
      case "H":
      case "header": {
        const colonIdx = value.indexOf(":");
        if (colonIdx > 0) {
          const name = value.slice(0, colonIdx).trim();
          const val = value.slice(colonIdx + 1).trim();
          if (!name) {
            warnings.push(`Пропущен пустой заголовок: ${value}`);
            break;
          }
          if (val === "") {
            removeHeader(headers, name);
          } else {
            headers.push({ name, value: val });
          }
        } else if (colonIdx === -1 && value.trim().endsWith(";")) {
          const name = value.trim().slice(0, -1).trim();
          if (name) {
            headers.push({ name, value: "" });
          }
        } else {
          warnings.push(`Некорректный формат заголовка -H: "${value}"`);
        }
        break;
      }
      case "b":
      case "cookie": {
        if (value.includes("=")) {
          const existingIdx = headers.findIndex(
            (h) => h.name.toLowerCase() === "cookie"
          );
          if (existingIdx >= 0 && headers[existingIdx].value.trim()) {
            headers[existingIdx] = {
              name: headers[existingIdx].name,
              value: `${headers[existingIdx].value}; ${value}`,
            };
          } else {
            upsertHeader(headers, "Cookie", value);
          }
        } else {
          warnings.push(
            `Флаг -b "${value}" указывает на cookie-файл — локальные файлы не читаются.`
          );
        }
        break;
      }
      case "A":
      case "user-agent": {
        upsertHeader(headers, "User-Agent", value);
        break;
      }
      case "e":
      case "referer": {
        upsertHeader(headers, "Referer", value);
        break;
      }
      case "u":
      case "user": {
        const credentials = value.includes(":") ? value : `${value}:`;
        const encoded = encodeTextToBase64(credentials);
        upsertHeader(headers, "Authorization", `Basic ${encoded}`);
        break;
      }
      case "oauth2-bearer": {
        upsertHeader(headers, "Authorization", `Bearer ${value}`);
        break;
      }
      case "d":
      case "data":
      case "data-ascii":
      case "data-binary": {
        hasBodyFlag = true;
        if (value.startsWith("@")) {
          warnings.push(
            `Обнаружен файловый аргумент "${value}" — содержимое файла с диска не загружается.`
          );
        }
        dataParts.push(value);
        break;
      }
      case "data-raw": {
        hasBodyFlag = true;
        dataParts.push(value);
        break;
      }
      case "data-urlencode": {
        hasBodyFlag = true;
        hasUrlEncodedFlag = true;
        dataParts.push(encodeUrlEncodedItem(value));
        break;
      }
      case "json": {
        hasBodyFlag = true;
        hasJsonFlag = true;
        if (value.startsWith("@")) {
          warnings.push(
            `Обнаружен файловый аргумент --json "${value}" — содержимое файла с диска не загружается.`
          );
        }
        jsonParts.push(value);
        break;
      }
      case "url": {
        if (!url) {
          url = value;
        } else {
          warnings.push(`Игнорирован дополнительный URL: ${value}`);
        }
        break;
      }
      case "max-redirs": {
        const parsedRedirs = Number(value);
        if (parsedRedirs === 0) {
          followRedirects = false;
        }
        break;
      }
      case "x":
      case "proxy": {
        warnings.push(
          `Флаг прокси (${flag.length === 1 ? `-${flag}` : `--${flag}`} ${value}) проигнорирован.`
        );
        break;
      }
      case "F":
      case "form":
      case "form-string": {
        hasBodyFlag = true;
        warnings.push(
          `Флаг multipart (${flag.length === 1 ? `-${flag}` : `--${flag}`}) не преобразуется в multipart-буфер автоматически.`
        );
        dataParts.push(value);
        break;
      }
      default:
        break;
    }
  };

  let afterDoubleDash = false;
  let i = 1;

  while (i < tokens.length) {
    const token = tokens[i];

    if (!afterDoubleDash && token === "--") {
      afterDoubleDash = true;
      i += 1;
      continue;
    }

    if (!afterDoubleDash && token.startsWith("--")) {
      const bodyPart = token.slice(2);
      const eqIdx = bodyPart.indexOf("=");
      const flagName = eqIdx >= 0 ? bodyPart.slice(0, eqIdx) : bodyPart;
      const inlineValue = eqIdx >= 0 ? bodyPart.slice(eqIdx + 1) : null;

      if (flagName === "get") {
        forceGetQuery = true;
        i += 1;
        continue;
      }
      if (flagName === "head") {
        implicitHead = true;
        i += 1;
        continue;
      }
      if (flagName === "location" || flagName === "location-trusted") {
        followRedirects = true;
        i += 1;
        continue;
      }

      if (LONG_VALUE_FLAGS.has(flagName)) {
        if (inlineValue !== null) {
          applyOptionValue(flagName, inlineValue);
          i += 1;
          continue;
        }
        if (i + 1 >= tokens.length) {
          return {
            ok: false,
            error: `Флаг --${flagName} требует значение`,
          };
        }
        applyOptionValue(flagName, tokens[i + 1]);
        i += 2;
        continue;
      }

      if (LONG_BOOLEAN_FLAGS.has(flagName)) {
        i += 1;
        continue;
      }

      // Unknown --flag: consume cleanly without breaking URL detection
      warnings.push(`Неизвестный флаг --${flagName} проигнорирован.`);
      i += 1;
      continue;
    }

    if (!afterDoubleDash && token.startsWith("-") && token.length > 1) {
      const cluster = token.slice(1);
      let consumedNext = false;

      for (let cIdx = 0; cIdx < cluster.length; cIdx += 1) {
        const shortFlag = cluster[cIdx];

        if (shortFlag === "G") {
          forceGetQuery = true;
          continue;
        }
        if (shortFlag === "I") {
          implicitHead = true;
          continue;
        }
        if (shortFlag === "L") {
          followRedirects = true;
          continue;
        }

        if (SHORT_VALUE_FLAGS.has(shortFlag)) {
          const remainder = cluster.slice(cIdx + 1);
          if (remainder.length > 0) {
            applyOptionValue(shortFlag, remainder);
          } else {
            if (i + 1 >= tokens.length) {
              return {
                ok: false,
                error: `Флаг -${shortFlag} требует значение`,
              };
            }
            applyOptionValue(shortFlag, tokens[i + 1]);
            consumedNext = true;
          }
          break;
        }
      }

      i += consumedNext ? 2 : 1;
      continue;
    }

    // Positional URL token
    if (token.trim().length > 0) {
      if (!url) {
        url = token.trim();
      } else if (/^https?:\/\//i.test(token)) {
        warnings.push(`Игнорирован дополнительный URL: ${token}`);
      }
    }
    i += 1;
  }

  if (!url) {
    return { ok: false, error: "Не найден URL в команде cURL" };
  }

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    url = `http://${url}`;
  }

  let body = "";
  if (hasJsonFlag && dataParts.length === 0) {
    body = jsonParts.join("");
  } else {
    body = [...dataParts, ...jsonParts].join("&");
  }

  if (forceGetQuery && body.length > 0) {
    url = appendQueryToUrl(url, body);
    body = "";
  }

  const method = explicitMethod
    ? explicitMethod
    : forceGetQuery
      ? "GET"
      : hasBodyFlag
        ? "POST"
        : implicitHead
          ? "HEAD"
          : "GET";

  if (hasJsonFlag) {
    if (!hasHeader(headers, "Content-Type")) {
      headers.push({ name: "Content-Type", value: "application/json" });
    }
    if (!hasHeader(headers, "Accept")) {
      headers.push({ name: "Accept", value: "application/json" });
    }
  } else if (hasUrlEncodedFlag && !forceGetQuery) {
    if (!hasHeader(headers, "Content-Type")) {
      headers.push({
        name: "Content-Type",
        value: "application/x-www-form-urlencoded",
      });
    }
  }

  return {
    ok: true,
    result: {
      request: {
        method,
        url,
        headers,
        body,
        followRedirects,
      },
      warnings,
    },
  };
}
