import type {
  FilterConditionRule,
  FilterField,
  FilterOperator,
  FilterPreset,
  HeaderMutationDirection,
  HeaderPair,
  HostListFilterConfig,
  HostListFilterMode,
  NoiseThresholdsConfig,
  ProxyFilterBackendConfig,
  SessionSummary,
  TlsBypassRule,
} from "../types/proxy";

export const DEFAULT_HOST_LIST_FILTER_CONFIG: HostListFilterConfig = {
  enabled: true,
  mode: "whitelist",
  rawText: "",
  applyToTlsPassthrough: false,
};

export const DEFAULT_NOISE_THRESHOLDS: NoiseThresholdsConfig = {
  hide304NotModified: false,
  hideOptionsPreflight: false,
  hideConnectTunnels: false,
  hideStaticAssets: false,
  minBodySizeBytes: null,
  maxBodySizeBytes: null,
  timeHeatEnabled: true,
  timeHeatWarningMs: 500,
  timeHeatCriticalMs: 1500,
  onlySlowRequests: false,
};

export const FILTER_FIELD_OPTIONS: {
  value: FilterField;
  label: string;
  isNumeric?: boolean;
}[] = [
  { value: "url", label: "URL (полный)" },
  { value: "host", label: "Host / Домен" },
  { value: "path", label: "Path & Query" },
  { value: "method", label: "HTTP Method" },
  { value: "status", label: "Status Code", isNumeric: true },
  { value: "contentType", label: "Content-Type" },
  { value: "processName", label: "Process Name (приложение)" },
  { value: "processPid", label: "Process PID", isNumeric: true },
  { value: "clientIp", label: "Client IP (мобильное устройство / LAN)" },
  { value: "protocol", label: "Protocol (HTTPS/2, WSS...)" },
  { value: "bodySize", label: "Body Size (B / KB / MB)", isNumeric: true },
  { value: "durationMs", label: "Duration / Time (ms)", isNumeric: true },
  { value: "comment", label: "Comment / Заметка (M)" },
];

export const FILTER_OPERATOR_OPTIONS: {
  value: FilterOperator;
  label: string;
}[] = [
  { value: "contains", label: "содержит (contains)" },
  { value: "notContains", label: "не содержит (!contains)" },
  { value: "equals", label: "равно (==)" },
  { value: "notEquals", label: "не равно (!=)" },
  { value: "startsWith", label: "начинается с (starts)" },
  { value: "endsWith", label: "заканчивается на (ends)" },
  { value: "regex", label: "RegExp (.*)" },
  { value: "gt", label: "больше (>)" },
  { value: "gte", label: "больше или равно (>=)" },
  { value: "lt", label: "меньше (<)" },
  { value: "lte", label: "меньше или равно (<=)" },
];

export const BUILT_IN_FILTER_PRESETS: FilterPreset[] = [
  {
    id: "preset-backend-api",
    name: "Только API бэкенда",
    description:
      "Показывает JSON / GraphQL / REST API эндпоинты, скрывая CORS preflight, 304 и статику",
    builtIn: true,
    matrixEnabled: true,
    rules: [
      {
        id: "r-api-1",
        enabled: true,
        action: "include",
        logicalOp: "OR",
        field: "contentType",
        operator: "contains",
        value: "json",
      },
      {
        id: "r-api-2",
        enabled: true,
        action: "include",
        logicalOp: "OR",
        field: "path",
        operator: "regex",
        value: "^/(api|v[0-9]+|graphql|oauth2)",
      },
      {
        id: "r-api-3",
        enabled: true,
        action: "exclude",
        logicalOp: "OR",
        field: "host",
        operator: "regex",
        value: "(telemetry|analytics|doubleclick|sentry)",
      },
    ],
    thresholds: {
      ...DEFAULT_NOISE_THRESHOLDS,
      hide304NotModified: true,
      hideOptionsPreflight: true,
      hideConnectTunnels: true,
      hideStaticAssets: true,
    },
  },
  {
    id: "preset-hide-os-noise",
    name: "Скрыть аналитику и фоновый шум ОС",
    description:
      "Исключает системные апдейтеры, телеметрию ОС (svchost), метрики, 304 и OPTIONS",
    builtIn: true,
    matrixEnabled: true,
    rules: [
      {
        id: "r-noise-1",
        enabled: true,
        action: "exclude",
        logicalOp: "OR",
        field: "host",
        operator: "regex",
        value:
          "(google-analytics|doubleclick|segment\\.io|sentry\\.io|mixpanel|clarity\\.ms|hotjar)",
      },
      {
        id: "r-noise-2",
        enabled: true,
        action: "exclude",
        logicalOp: "OR",
        field: "host",
        operator: "regex",
        value:
          "(windowsupdate|delivery\\.mp\\.microsoft|telemetry\\.microsoft|msftconnecttest|icloud\\.com|mzstatic\\.com|ocsp|digicert)",
      },
      {
        id: "r-noise-3",
        enabled: true,
        action: "exclude",
        logicalOp: "OR",
        field: "processName",
        operator: "regex",
        value: "^(svchost|SearchHost|Widgets|OneDrive|mDNSResponder|apsd)",
      },
    ],
    thresholds: {
      ...DEFAULT_NOISE_THRESHOLDS,
      hide304NotModified: true,
      hideOptionsPreflight: true,
      hideConnectTunnels: true,
    },
  },
  {
    id: "preset-slow-heavy",
    name: "Медленные и тяжелые (> 500 ms / > 1 MB)",
    description:
      "Выделяет деградацию ответов: запросы дольше 500 ms, ответы крупнее 1 MB или ошибки 5xx",
    builtIn: true,
    matrixEnabled: true,
    rules: [
      {
        id: "r-slow-1",
        enabled: true,
        action: "include",
        logicalOp: "OR",
        field: "durationMs",
        operator: "gt",
        value: "500",
      },
      {
        id: "r-slow-2",
        enabled: true,
        action: "include",
        logicalOp: "OR",
        field: "bodySize",
        operator: "gt",
        value: "1MB",
      },
      {
        id: "r-slow-3",
        enabled: true,
        action: "include",
        logicalOp: "OR",
        field: "status",
        operator: "gte",
        value: "500",
      },
    ],
    thresholds: {
      ...DEFAULT_NOISE_THRESHOLDS,
      timeHeatEnabled: true,
      timeHeatWarningMs: 500,
      timeHeatCriticalMs: 1500,
    },
  },
  {
    id: "preset-dev-processes",
    name: "Только Dev-клиенты (Node / Python / Postman)",
    description:
      "Отбирает трафик только от локальных инструментов разработки и скриптов, игнорируя браузеры и ОС",
    builtIn: true,
    matrixEnabled: true,
    rules: [
      {
        id: "r-proc-1",
        enabled: true,
        action: "include",
        logicalOp: "OR",
        field: "processName",
        operator: "regex",
        value: "(node|python|postman|insomnia|curl|Composer)",
      },
    ],
    thresholds: {
      ...DEFAULT_NOISE_THRESHOLDS,
      hideConnectTunnels: true,
    },
  },
];

export const DEFAULT_BACKEND_FILTER_CONFIG: ProxyFilterBackendConfig = {
  tlsInterceptMode: "interceptAll",
  tlsBypassEnabled: true,
  tlsBypassRules: [
    {
      id: "bypass-apple-icloud",
      enabled: true,
      pattern: "*.apple.com, *.icloud.com, *.mzstatic.com",
      category: "OS Updaters",
      description: "Apple / iCloud / App Store жесткий Certificate Pinning",
    },
    {
      id: "bypass-windows-update",
      enabled: true,
      pattern: "*.windowsupdate.com, *.delivery.mp.microsoft.com",
      category: "OS Updaters",
      description: "Windows Update & системные службы обновления ОС",
    },
    {
      id: "bypass-messengers",
      enabled: true,
      pattern: "*.telegram.org, *.whatsapp.net, *.signal.org",
      category: "Messengers",
      description: "Мессенджеры со встроенным пиннингом ключей",
    },
    {
      id: "bypass-payments-3ds",
      enabled: true,
      pattern: "*.stripe.network, *.3dsecure.io, *.braintreegateway.com",
      category: "Payment Gateways",
      description: "Платежные шлюзы и 3-D Secure виджеты",
    },
  ],
  tlsTargetRules: [],
  headerMutationsEnabled: true,
  headerMutations: [
    {
      id: "hm-nocache-req",
      enabled: false,
      name: "Обход кэша: удалять If-Modified-Since / If-None-Match",
      direction: "request",
      operation: "remove",
      headerName: "If-Modified-Since, If-None-Match",
      headerValue: "",
      urlPattern: "*",
    },
    {
      id: "hm-nocache-resp",
      enabled: false,
      name: "Обход кэша: удалять ETag / Last-Modified в ответе",
      direction: "response",
      operation: "remove",
      headerName: "ETag, Last-Modified",
      headerValue: "",
      urlPattern: "*",
    },
    {
      id: "hm-ua-override",
      enabled: false,
      name: "Подмена User-Agent (iPhone 16 Pro Mobile Safari)",
      direction: "request",
      operation: "set",
      headerName: "User-Agent",
      headerValue:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      urlPattern: "*",
    },
    {
      id: "hm-cors-permissive",
      enabled: false,
      name: "Инъекция Access-Control-Allow-Origin: * (Dev CORS)",
      direction: "response",
      operation: "set",
      headerName: "Access-Control-Allow-Origin",
      headerValue: "*",
      urlPattern: "*",
    },
  ],
  hostListSync: {
    enabled: false,
    mode: "whitelist",
    rawText: "",
  },
};

export const TLS_BYPASS_QUICK_PACKS: {
  label: string;
  rule: Omit<TlsBypassRule, "id">;
}[] = [
  {
    label: "+ Платежные шлюзы (Checkout / PayPal / Adyen)",
    rule: {
      enabled: true,
      pattern: "*.paypal.com, *.adyen.com, *.checkout.com, *.cloudpayments.ru",
      category: "Payment Gateways",
      description: "Платежные провайдеры с TLS Pinning / mTLS",
    },
  },
  {
    label: "+ OCSP / CRL проверки сертификатов",
    rule: {
      enabled: true,
      pattern: "*.digicert.com, *.sectigo.com, *.letsencrypt.org, ocsp.*",
      category: "OS Updaters",
      description: "Серверы отзыва сертификатов OCSP/CRL",
    },
  },
  {
    label: "+ Корпоративные мессенджеры (Slack / Discord / Teams)",
    rule: {
      enabled: true,
      pattern: "*.discord.gg, *.slack-msgs.com, *.teams.microsoft.com",
      category: "Messengers",
      description: "Десктопные клиенты с пиннингом WebSocket/TLS",
    },
  },
];

export const USER_AGENT_PRESETS: { label: string; value: string }[] = [
  {
    label: "iPhone 16 Pro (iOS 18 Safari)",
    value:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  },
  {
    label: "Android 15 (Pixel 9 Chrome)",
    value:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  },
  {
    label: "Chrome 131 Desktop (Windows 11)",
    value:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  {
    label: "Googlebot Smartphone Crawler",
    value:
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  },
  {
    label: "curl/8.10.1 CLI",
    value: "curl/8.10.1",
  },
];

// ============================================================================
// Pre-compiled Matrix Evaluator (Zero RegExp allocation per row at 10k+ sessions)
// ============================================================================
export interface CompiledCondition {
  rule: FilterConditionRule;
  regex: RegExp | null;
  numericTarget: number | null;
  lowerValue: string;
}

export interface CompiledFilterMatrix {
  includeGroups: CompiledCondition[][];
  excludeGroups: CompiledCondition[][];
  ruleErrors: Record<string, string>;
}

/**
 * Parses human-friendly byte or millisecond literals:
 * - "1.5MB" / "1 MB" -> 1572864
 * - "500KB" -> 512000
 * - "2s" -> 2000
 * - "500ms" -> 500
 */
export function parseThresholdNumber(raw: string, field: FilterField): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  const match = /^(-?\d+(?:\.\d+)?)\s*(b|kb|mb|gb|ms|s)?$/i.exec(trimmed);
  if (!match) {
    const fallback = Number(trimmed);
    return Number.isFinite(fallback) ? fallback : null;
  }

  const num = Number(match[1]);
  if (!Number.isFinite(num)) return null;
  const unit = match[2]?.toLowerCase();

  if (field === "bodySize") {
    if (unit === "gb") return num * 1024 * 1024 * 1024;
    if (unit === "mb") return num * 1024 * 1024;
    if (unit === "kb") return num * 1024;
    return num;
  }
  if (field === "durationMs") {
    if (unit === "s") return num * 1000;
    return num;
  }
  return num;
}

function buildDnfGroups(items: CompiledCondition[]): CompiledCondition[][] {
  const groups: CompiledCondition[][] = [];
  for (const item of items) {
    if (groups.length === 0 || item.rule.logicalOp === "OR") {
      groups.push([item]);
    } else {
      groups[groups.length - 1].push(item);
    }
  }
  return groups;
}

export function compileFilterMatrix(
  rules: FilterConditionRule[]
): CompiledFilterMatrix {
  const includes: CompiledCondition[] = [];
  const excludes: CompiledCondition[] = [];
  const ruleErrors: Record<string, string> = {};

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const rawVal = rule.value.trim();
    if (!rawVal) continue;

    let regex: RegExp | null = null;
    if (rule.operator === "regex") {
      try {
        regex = new RegExp(rawVal, "i");
      } catch (err) {
        ruleErrors[rule.id] =
          err instanceof Error ? err.message : "Invalid RegExp";
        continue;
      }
    }

    const compiled: CompiledCondition = {
      rule,
      regex,
      numericTarget: parseThresholdNumber(rawVal, rule.field),
      lowerValue: rawVal.toLowerCase(),
    };

    if (rule.action === "include") {
      includes.push(compiled);
    } else {
      excludes.push(compiled);
    }
  }

  return {
    includeGroups: buildDnfGroups(includes),
    excludeGroups: buildDnfGroups(excludes),
    ruleErrors,
  };
}

function extractSessionFieldString(s: SessionSummary, field: FilterField): string {
  switch (field) {
    case "url":
      return s.url;
    case "host":
      return s.host;
    case "path":
      return s.path;
    case "method":
      return s.method;
    case "status":
      return String(s.status);
    case "contentType":
      return s.contentType;
    case "processName":
      return s.processName ?? "";
    case "processPid":
      return s.processPid != null ? String(s.processPid) : "";
    case "clientIp":
      return s.clientIp ?? "";
    case "protocol":
      return s.protocol;
    case "bodySize":
      return String(s.bodySize);
    case "durationMs":
      return String(s.durationMs);
    case "comment":
      return s.comment ?? "";
  }
}

function extractSessionFieldNumber(
  s: SessionSummary,
  field: FilterField
): number | null {
  switch (field) {
    case "status":
      return s.status;
    case "bodySize":
      return s.bodySize;
    case "durationMs":
      return s.durationMs;
    case "processPid":
      return s.processPid ?? null;
    default: {
      const parsed = Number(extractSessionFieldString(s, field));
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
}

function evalCondition(s: SessionSummary, cond: CompiledCondition): boolean {
  const { rule, regex, numericTarget, lowerValue } = cond;
  const op = rule.operator;

  if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
    const actual = extractSessionFieldNumber(s, rule.field);
    if (actual === null || numericTarget === null) return false;
    if (op === "gt") return actual > numericTarget;
    if (op === "gte") return actual >= numericTarget;
    if (op === "lt") return actual < numericTarget;
    return actual <= numericTarget;
  }

  // Support human unit equality on numeric fields too (e.g. status == 200, pid == 14280)
  if (
    (op === "equals" || op === "notEquals") &&
    numericTarget !== null &&
    (rule.field === "status" ||
      rule.field === "bodySize" ||
      rule.field === "durationMs" ||
      rule.field === "processPid")
  ) {
    const actual = extractSessionFieldNumber(s, rule.field);
    if (actual !== null) {
      return op === "equals" ? actual === numericTarget : actual !== numericTarget;
    }
  }

  const rawText = extractSessionFieldString(s, rule.field);
  if (op === "regex") {
    return regex ? regex.test(rawText) : false;
  }

  const textLower = rawText.toLowerCase();
  switch (op) {
    case "contains":
      return textLower.includes(lowerValue);
    case "notContains":
      return !textLower.includes(lowerValue);
    case "equals":
      return textLower === lowerValue;
    case "notEquals":
      return textLower !== lowerValue;
    case "startsWith":
      return textLower.startsWith(lowerValue);
    case "endsWith":
      return textLower.endsWith(lowerValue);
    default:
      return false;
  }
}

function evalDnfGroups(
  s: SessionSummary,
  groups: CompiledCondition[][]
): boolean {
  // (G1_c1 AND G1_c2) OR (G2_c1) ...
  for (const conjunction of groups) {
    let groupMatched = true;
    for (const cond of conjunction) {
      if (!evalCondition(s, cond)) {
        groupMatched = false;
        break;
      }
    }
    if (groupMatched) return true;
  }
  return false;
}

const STATIC_ASSET_EXT_RE = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|css|map)(\?|$)/i;

// ============================================================================
// High-Performance Bulk Hosts & URL Filter (Cached Set + Combined RegExp)
// ============================================================================
export interface HostListParseError {
  line: number;
  token: string;
  message: string;
}

export interface CompiledHostListFilter {
  enabled: boolean;
  mode: HostListFilterMode;
  activeCount: number;
  exactCount: number;
  wildcardCount: number;
  regexCount: number;
  errors: HostListParseError[];
  matchesEverything: boolean;
  hasUniversalHostRule: boolean;
  hasPortOrSchemeRules: boolean;
  hasUrlOrPathRules: boolean;
  // Fast O(1) lookup tables
  exactHosts: Set<string>;
  exactHostPorts: Set<string>;
  exactSchemeHosts: Set<string>;
  exactSchemeHostPorts: Set<string>;
  wildcardDomainSet: Set<string>;
  // Combined single-pass automaton RegExps for wildcard globs & path prefixes
  combinedHostGlobRegex: RegExp | null;
  combinedHostPortGlobRegex: RegExp | null;
  combinedHostPathRegex: RegExp | null;
  combinedFullUrlRegex: RegExp | null;
  combinedPathOnlyRegex: RegExp | null;
  // Validated `regex:` user rules (combined single-pass automaton + per-rule fallback)
  combinedUserRegex: RegExp | null;
  userRegexes: { pattern: string; regex: RegExp }[];
  // Additional host-level matchers used for CONNECT tunnel whitelist/blacklist decisions
  connectWhitelistHosts: Set<string>;
  connectWhitelistHostPorts: Set<string>;
  connectWhitelistWildcards: Set<string>;
  connectWhitelistHostRegex: RegExp | null;
  connectBlacklistWildcards: Set<string>;
  connectBlacklistHostRegex: RegExp | null;
}

const HOST_LIST_COMPILE_CACHE = new Map<string, CompiledHostListFilter>();
const MAX_HOST_LIST_CACHE_ENTRIES = 32;

function escapeRegexLiteral(str: string): string {
  return str.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globSegmentToRegexSource(glob: string, starCharClass: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      out += `${starCharClass}*`;
    } else if (ch === "?") {
      out += starCharClass;
    } else {
      out += escapeRegexLiteral(ch);
    }
  }
  return out;
}

function buildCombinedRegex(sources: string[]): RegExp | null {
  if (sources.length === 0) return null;
  try {
    return new RegExp(`^(?:${sources.join("|")})$`, "i");
  } catch {
    return null;
  }
}

/**
 * Splits raw multiline input into individual rule tokens:
 * - Ignores empty lines and full-line comments starting with `#` or `//`
 * - Strips trailing inline comments (` # ...` or ` // ...`) after whitespace on non-regex lines
 * - Splits comma `,` and semicolon `;` lists while preserving quantifiers like `{1,3}` and `regex:` expressions
 */
export function tokenizeHostListInput(
  rawText: string
): { line: number; token: string }[] {
  if (!rawText) return [];
  const tokens: { line: number; token: string }[] = [];
  const lines = rawText.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
      continue;
    }

    if (/^regex:/i.test(trimmed)) {
      tokens.push({ line: lineNo, token: trimmed });
      continue;
    }

    const cleanedLine = trimmed.replace(/\s+(?:#|\/\/).*$/, "").trim();
    if (!cleanedLine) continue;

    let current = "";
    let depth = 0;
    let escaped = false;
    let inRegexSegment = false;

    for (let c = 0; c < cleanedLine.length; c++) {
      const ch = cleanedLine[c];
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        current += ch;
        escaped = true;
        continue;
      }
      if (!inRegexSegment && /^regex:/i.test(current.trimStart())) {
        inRegexSegment = true;
      }
      if (ch === "{" || ch === "[" || ch === "(") {
        depth++;
      } else if (ch === "}" || ch === "]" || ch === ")") {
        depth = Math.max(0, depth - 1);
      }

      if ((ch === "," || ch === ";") && depth === 0 && !inRegexSegment) {
        const piece = current.trim();
        if (piece && !piece.startsWith("#") && !piece.startsWith("//")) {
          tokens.push({ line: lineNo, token: piece });
        }
        current = "";
        inRegexSegment = false;
      } else {
        current += ch;
      }
    }

    const tail = current.trim();
    if (tail && !tail.startsWith("#") && !tail.startsWith("//")) {
      tokens.push({ line: lineNo, token: tail });
    }
  }

  return tokens;
}

function splitAuthorityPattern(authority: string): {
  hostPattern: string;
  portPattern: string | null;
} {
  const trimmed = authority.trim();
  if (trimmed.startsWith("[")) {
    const closeIdx = trimmed.indexOf("]");
    if (closeIdx !== -1) {
      const hostPattern = trimmed.slice(1, closeIdx);
      const after = trimmed.slice(closeIdx + 1);
      const portPattern = after.startsWith(":") ? after.slice(1) : null;
      return { hostPattern, portPattern: portPattern || null };
    }
  }
  const colonIdx = trimmed.lastIndexOf(":");
  if (colonIdx !== -1) {
    const hostPattern = trimmed.slice(0, colonIdx);
    const portPattern = trimmed.slice(colonIdx + 1);
    if (portPattern && !hostPattern.includes(":")) {
      return { hostPattern, portPattern };
    }
  }
  return { hostPattern: trimmed, portPattern: null };
}

function compileHostPatternSource(hostPattern: string): string {
  if (hostPattern === "*") return "[^/:]+";
  if (hostPattern.startsWith("*.")) {
    return `(?:[^/:]+\\.)?${globSegmentToRegexSource(hostPattern.slice(2), "[^/:]")}`;
  }
  if (hostPattern.startsWith(".")) {
    return `(?:[^/:]+\\.)?${globSegmentToRegexSource(hostPattern.slice(1), "[^/:]")}`;
  }
  return globSegmentToRegexSource(hostPattern, "[^/:]");
}

export function compileHostListFilter(
  config: Pick<HostListFilterConfig, "enabled" | "mode" | "rawText">
): CompiledHostListFilter {
  const cacheKey = `${config.enabled ? "1" : "0"}|${config.mode}|${config.rawText}`;
  const cached = HOST_LIST_COMPILE_CACHE.get(cacheKey);
  if (cached) {
    // Refresh LRU order
    HOST_LIST_COMPILE_CACHE.delete(cacheKey);
    HOST_LIST_COMPILE_CACHE.set(cacheKey, cached);
    return cached;
  }

  const exactHosts = new Set<string>();
  const exactHostPorts = new Set<string>();
  const exactSchemeHosts = new Set<string>();
  const exactSchemeHostPorts = new Set<string>();
  const wildcardDomainSet = new Set<string>();

  const hostGlobSources: string[] = [];
  const hostPortGlobSources: string[] = [];
  const hostPathSources: string[] = [];
  const fullUrlSources: string[] = [];
  const pathOnlySources: string[] = [];
  const userRegexSources: string[] = [];
  const userRegexes: { pattern: string; regex: RegExp }[] = [];
  const errors: HostListParseError[] = [];

  const connectWhitelistHosts = new Set<string>();
  const connectWhitelistHostPorts = new Set<string>();
  const connectWhitelistWildcards = new Set<string>();
  const connectWhitelistHostGlobSources: string[] = [];
  const connectBlacklistWildcards = new Set<string>();
  const connectBlacklistHostGlobSources: string[] = [];

  let activeCount = 0;
  let exactCount = 0;
  let wildcardCount = 0;
  let regexCount = 0;
  let matchesEverything = false;
  let hasUniversalHostRule = false;
  let hasPortOrSchemeRules = false;
  let hasUrlOrPathRules = false;

  const entries = tokenizeHostListInput(config.rawText);

  for (const { line, token } of entries) {
    // 1. Explicit RegExp (`regex:...`)
    if (/^regex:/i.test(token)) {
      const expr = token.slice(6).trim();
      if (!expr) {
        errors.push({
          line,
          token,
          message: "Пустое регулярное выражение после префикса regex:",
        });
        continue;
      }
      try {
        const compiledRe = new RegExp(expr, "i");
        userRegexes.push({ pattern: token, regex: compiledRe });
        userRegexSources.push(`(?:${expr})`);
        activeCount++;
        regexCount++;
      } catch (err) {
        errors.push({
          line,
          token,
          message: err instanceof Error ? err.message : "Некорректный RegExp",
        });
      }
      continue;
    }

    // 2. Universal wildcard `*`
    if (token === "*" || token === "*/*") {
      matchesEverything = true;
      hasUniversalHostRule = true;
      activeCount++;
      wildcardCount++;
      continue;
    }

    // 3. Path-only pattern (`/api/v1/*`, `/graphql`)
    if (token.startsWith("/")) {
      const patLower = token.toLowerCase();
      hasUniversalHostRule = true;
      hasUrlOrPathRules = true;
      activeCount++;
      if (patLower.includes("*") || patLower.includes("?")) {
        wildcardCount++;
        pathOnlySources.push(globSegmentToRegexSource(patLower, "."));
      } else {
        exactCount++;
        const cleanPrefix =
          patLower.length > 1 && patLower.endsWith("/")
            ? patLower.slice(0, -1)
            : patLower;
        pathOnlySources.push(
          `${escapeRegexLiteral(cleanPrefix)}(?:[/?#].*)?`
        );
      }
      continue;
    }

    // 4. Host / Authority / Full URL pattern
    let lower = token.toLowerCase();
    let scheme: string | null = null;
    for (const prefix of ["https://", "http://", "wss://", "ws://"]) {
      if (lower.startsWith(prefix)) {
        scheme = prefix.slice(0, -3);
        lower = lower.slice(prefix.length);
        break;
      }
    }

    const slashIdx = lower.indexOf("/");
    const authorityRaw = slashIdx === -1 ? lower : lower.slice(0, slashIdx);
    const pathRaw = slashIdx === -1 ? null : lower.slice(slashIdx);

    const { hostPattern, portPattern } = splitAuthorityPattern(authorityRaw);
    if (!hostPattern) continue;

    const isWholeHostPath =
      pathRaw === null || pathRaw === "/" || pathRaw === "/*";
    const hostHasWildcard =
      hostPattern.includes("*") || hostPattern.includes("?");
    const portHasWildcard =
      portPattern !== null &&
      (portPattern.includes("*") || portPattern.includes("?"));
    const pathHasWildcard =
      pathRaw !== null && (pathRaw.includes("*") || pathRaw.includes("?"));

    activeCount++;
    if (hostHasWildcard || portHasWildcard || pathHasWildcard) {
      wildcardCount++;
    } else {
      exactCount++;
    }

    if (
      hostPattern === "*" &&
      (scheme === null || scheme === "https" || scheme === "wss")
    ) {
      hasUniversalHostRule = true;
    }

    // Record host-level coverage for TLS CONNECT tunnel decisions (when scheme is unspecified or https/wss)
    const isTlsCompatibleScheme =
      scheme === null || scheme === "https" || scheme === "wss";
    const isSimpleSubdomainWildcard =
      (hostPattern.startsWith("*.") &&
        !hostPattern.slice(2).includes("*") &&
        !hostPattern.includes("?")) ||
      (hostPattern.startsWith(".") &&
        !hostPattern.slice(1).includes("*") &&
        !hostPattern.includes("?"));

    if (isTlsCompatibleScheme) {
      if (!hostHasWildcard && !portHasWildcard) {
        if (portPattern) {
          connectWhitelistHostPorts.add(`${hostPattern}:${portPattern}`);
        } else {
          connectWhitelistHosts.add(hostPattern);
        }
      } else if (isSimpleSubdomainWildcard && !portPattern) {
        const suffix = hostPattern.startsWith("*.")
          ? hostPattern.slice(2)
          : hostPattern.slice(1);
        if (suffix) {
          connectWhitelistWildcards.add(suffix);
          if (isWholeHostPath) {
            connectBlacklistWildcards.add(suffix);
          }
        }
      } else {
        const hSrc = compileHostPatternSource(hostPattern);
        const fullHostPortSrc = portPattern
          ? `${hSrc}:${globSegmentToRegexSource(portPattern, "[0-9]")}`
          : `${hSrc}(?::[0-9]+)?`;
        connectWhitelistHostGlobSources.push(fullHostPortSrc);
        if (isWholeHostPath) {
          connectBlacklistHostGlobSources.push(fullHostPortSrc);
        }
      }
    }

    // 4a. Fast O(1) Set rules (no wildcards in host/port and whole-host path)
    if (isWholeHostPath && !hostHasWildcard && !portHasWildcard) {
      if (scheme === null && portPattern === null) {
        exactHosts.add(hostPattern);
      } else if (scheme === null && portPattern !== null) {
        hasPortOrSchemeRules = true;
        exactHostPorts.add(`${hostPattern}:${portPattern}`);
      } else if (scheme !== null && portPattern !== null) {
        hasPortOrSchemeRules = true;
        exactSchemeHostPorts.add(`${scheme}://${hostPattern}:${portPattern}`);
      } else if (scheme !== null) {
        hasPortOrSchemeRules = true;
        exactSchemeHosts.add(`${scheme}://${hostPattern}`);
      }
      continue;
    }

    // 4b. Fast O(1) dot-segment Set for `*.domain.com` / `.domain.com` (no scheme, no port, whole-host path)
    if (
      isWholeHostPath &&
      isSimpleSubdomainWildcard &&
      scheme === null &&
      portPattern === null
    ) {
      const suffix = hostPattern.startsWith("*.")
        ? hostPattern.slice(2)
        : hostPattern.slice(1);
      if (suffix) {
        wildcardDomainSet.add(suffix);
        continue;
      }
    }

    // 4c. Combined single-pass RegExp for general globs, ports with wildcards, or specific sub-paths
    const hostRegexSrc = compileHostPatternSource(hostPattern);

    if (isWholeHostPath && scheme === null && portPattern === null) {
      hostGlobSources.push(hostRegexSrc);
      continue;
    }

    if (isWholeHostPath && scheme === null && portPattern !== null) {
      hasPortOrSchemeRules = true;
      hostPortGlobSources.push(
        `${hostRegexSrc}:${globSegmentToRegexSource(portPattern, "[0-9]")}`
      );
      continue;
    }

    const portRegexSrc =
      portPattern !== null
        ? `:${globSegmentToRegexSource(portPattern, "[0-9]")}`
        : "(?::[0-9]+)?";

    let pathRegexSrc: string;
    if (pathRaw === null || pathRaw === "/") {
      pathRegexSrc = "(?:\\/.*)?";
    } else if (pathRaw === "/*") {
      pathRegexSrc = "\\/.*";
    } else if (pathHasWildcard) {
      pathRegexSrc = globSegmentToRegexSource(pathRaw, ".");
    } else {
      const cleanPath =
        pathRaw.length > 1 && pathRaw.endsWith("/")
          ? pathRaw.slice(0, -1)
          : pathRaw;
      pathRegexSrc = `${escapeRegexLiteral(cleanPath)}(?:[/?#].*)?`;
    }

    if (scheme !== null) {
      hasPortOrSchemeRules = true;
      hasUrlOrPathRules = true;
      fullUrlSources.push(
        `${escapeRegexLiteral(scheme)}:\\/\\/${hostRegexSrc}${portRegexSrc}${pathRegexSrc}`
      );
    } else {
      if (portPattern !== null) {
        hasPortOrSchemeRules = true;
      }
      hasUrlOrPathRules = true;
      hostPathSources.push(`${hostRegexSrc}${portRegexSrc}${pathRegexSrc}`);
    }
  }

  let combinedUserRegex: RegExp | null = null;
  if (userRegexSources.length > 0) {
    try {
      combinedUserRegex = new RegExp(userRegexSources.join("|"), "i");
    } catch {
      combinedUserRegex = null;
    }
  }

  const compiled: CompiledHostListFilter = {
    enabled: config.enabled,
    mode: config.mode,
    activeCount,
    exactCount,
    wildcardCount,
    regexCount,
    errors,
    matchesEverything,
    hasUniversalHostRule,
    hasPortOrSchemeRules,
    hasUrlOrPathRules,
    exactHosts,
    exactHostPorts,
    exactSchemeHosts,
    exactSchemeHostPorts,
    wildcardDomainSet,
    combinedHostGlobRegex: buildCombinedRegex(hostGlobSources),
    combinedHostPortGlobRegex: buildCombinedRegex(hostPortGlobSources),
    combinedHostPathRegex: buildCombinedRegex(hostPathSources),
    combinedFullUrlRegex: buildCombinedRegex(fullUrlSources),
    combinedPathOnlyRegex: buildCombinedRegex(pathOnlySources),
    combinedUserRegex,
    userRegexes,
    connectWhitelistHosts,
    connectWhitelistHostPorts,
    connectWhitelistWildcards,
    connectWhitelistHostRegex: buildCombinedRegex(
      connectWhitelistHostGlobSources
    ),
    connectBlacklistWildcards,
    connectBlacklistHostRegex: buildCombinedRegex(
      connectBlacklistHostGlobSources
    ),
  };

  if (HOST_LIST_COMPILE_CACHE.size >= MAX_HOST_LIST_CACHE_ENTRIES) {
    const oldestKey = HOST_LIST_COMPILE_CACHE.keys().next().value;
    if (oldestKey !== undefined) {
      HOST_LIST_COMPILE_CACHE.delete(oldestKey);
    }
  }
  HOST_LIST_COMPILE_CACHE.set(cacheKey, compiled);

  return compiled;
}

function matchesWildcardDomainSet(
  hostnameLower: string,
  domainSet: Set<string>
): boolean {
  if (domainSet.size === 0) return false;
  if (domainSet.has(hostnameLower)) return true;
  let dotIdx = hostnameLower.indexOf(".");
  while (dotIdx !== -1) {
    if (domainSet.has(hostnameLower.slice(dotIdx + 1))) {
      return true;
    }
    dotIdx = hostnameLower.indexOf(".", dotIdx + 1);
  }
  return false;
}

function extractHostnameLowerFast(rawHost: string): string {
  const len = rawHost.length;
  if (len === 0) return "";
  let needsNormalize = false;
  for (let i = 0; i < len; i++) {
    const code = rawHost.charCodeAt(i);
    // Uppercase A-Z (65..90), whitespace (<=32), ':' (58), '[' (91)
    if (
      (code >= 65 && code <= 90) ||
      code <= 32 ||
      code === 58 ||
      code === 91
    ) {
      needsNormalize = true;
      break;
    }
  }
  if (!needsNormalize) return rawHost;

  const lower = rawHost.trim().toLowerCase();
  if (!lower) return "";
  if (lower.startsWith("[")) {
    const closeIdx = lower.indexOf("]");
    return closeIdx !== -1 ? lower.slice(1, closeIdx) : lower.slice(1);
  }
  const colonIdx = lower.indexOf(":");
  return colonIdx === -1 ? lower : lower.slice(0, colonIdx);
}

function extractSessionAuthorityDetails(
  s: SessionSummary,
  hostnameLower: string
): {
  schemeLower: string;
  hostPortLower: string;
  authorityInUrlLower: string;
  urlPath: string;
  normalizedFullUrl: string;
} {
  const schemeLower = (s.scheme || "https").toLowerCase();
  const defaultPort =
    schemeLower === "https" || schemeLower === "wss" ? "443" : "80";

  let explicitPort = "";
  const urlLower = s.url.toLowerCase();
  const schemeSep = urlLower.indexOf("://");
  let authoritySlice = "";
  if (schemeSep !== -1) {
    const authStart = schemeSep + 3;
    const slashIdx = urlLower.indexOf("/", authStart);
    authoritySlice =
      slashIdx === -1
        ? urlLower.slice(authStart)
        : urlLower.slice(authStart, slashIdx);
  } else {
    authoritySlice = s.host.toLowerCase();
  }

  if (authoritySlice.startsWith("[")) {
    const closeIdx = authoritySlice.indexOf("]");
    if (closeIdx !== -1 && authoritySlice[closeIdx + 1] === ":") {
      explicitPort = authoritySlice.slice(closeIdx + 2);
    }
  } else {
    const colonIdx = authoritySlice.lastIndexOf(":");
    if (colonIdx !== -1) {
      explicitPort = authoritySlice.slice(colonIdx + 1);
    }
  }

  const effectivePort = explicitPort || defaultPort;
  const hostPortLower = `${hostnameLower}:${effectivePort}`;
  const authorityInUrlLower = explicitPort
    ? `${hostnameLower}:${explicitPort}`
    : hostnameLower;
  const isConnect = s.method.toUpperCase() === "CONNECT";
  const urlPath = isConnect ? "/" : s.path || "/";
  const normalizedFullUrl = `${schemeLower}://${hostPortLower}${urlPath}`;

  return {
    schemeLower,
    hostPortLower,
    authorityInUrlLower,
    urlPath,
    normalizedFullUrl,
  };
}

export function matchesCompiledHostList(
  s: SessionSummary,
  compiled: CompiledHostListFilter
): boolean {
  if (compiled.matchesEverything) return true;

  const hostname = extractHostnameLowerFast(s.host);

  // 1. Zero-allocation O(1) Set lookups on bare hostname & `*.domain`
  if (compiled.exactHosts.size > 0 && compiled.exactHosts.has(hostname)) {
    return true;
  }
  if (matchesWildcardDomainSet(hostname, compiled.wildcardDomainSet)) {
    return true;
  }
  if (
    compiled.combinedHostGlobRegex !== null &&
    compiled.combinedHostGlobRegex.test(hostname)
  ) {
    return true;
  }

  // 2. Port, Scheme & URL/Path-aware rules (computed only when such rules exist)
  if (compiled.hasPortOrSchemeRules || compiled.hasUrlOrPathRules) {
    if (!compiled.hasPortOrSchemeRules) {
      // Fast path when rules use host+path or path-only without explicit port or scheme
      const urlPath =
        s.method === "CONNECT" || s.method === "connect" ? "/" : s.path || "/";
      if (
        compiled.combinedPathOnlyRegex !== null &&
        compiled.combinedPathOnlyRegex.test(urlPath)
      ) {
        return true;
      }
      if (
        compiled.combinedHostPathRegex !== null &&
        compiled.combinedHostPathRegex.test(`${hostname}${urlPath}`)
      ) {
        return true;
      }
    } else {
      const {
        schemeLower,
        hostPortLower,
        authorityInUrlLower,
        urlPath,
        normalizedFullUrl,
      } = extractSessionAuthorityDetails(s, hostname);

      if (
        compiled.exactHostPorts.size > 0 &&
        compiled.exactHostPorts.has(hostPortLower)
      ) {
        return true;
      }
      if (
        compiled.exactSchemeHosts.size > 0 &&
        compiled.exactSchemeHosts.has(`${schemeLower}://${hostname}`)
      ) {
        return true;
      }
      if (
        compiled.exactSchemeHostPorts.size > 0 &&
        compiled.exactSchemeHostPorts.has(`${schemeLower}://${hostPortLower}`)
      ) {
        return true;
      }
      if (
        compiled.combinedHostPortGlobRegex !== null &&
        compiled.combinedHostPortGlobRegex.test(hostPortLower)
      ) {
        return true;
      }
      if (
        compiled.combinedPathOnlyRegex !== null &&
        compiled.combinedPathOnlyRegex.test(urlPath)
      ) {
        return true;
      }
      if (compiled.combinedHostPathRegex !== null) {
        if (
          compiled.combinedHostPathRegex.test(`${authorityInUrlLower}${urlPath}`) ||
          compiled.combinedHostPathRegex.test(`${hostPortLower}${urlPath}`)
        ) {
          return true;
        }
      }
      if (compiled.combinedFullUrlRegex !== null) {
        if (
          compiled.combinedFullUrlRegex.test(s.url) ||
          compiled.combinedFullUrlRegex.test(normalizedFullUrl)
        ) {
          return true;
        }
      }
    }
  }

  // 3. Pre-compiled `regex:` rules (single combined DFA pass with per-rule fallback)
  if (compiled.combinedUserRegex !== null) {
    if (
      compiled.combinedUserRegex.test(s.url) ||
      compiled.combinedUserRegex.test(s.host)
    ) {
      return true;
    }
  } else if (compiled.userRegexes.length > 0) {
    for (let i = 0; i < compiled.userRegexes.length; i++) {
      const re = compiled.userRegexes[i].regex;
      if (re.test(s.url) || re.test(s.host)) {
        return true;
      }
    }
  }

  return false;
}

export function evaluateSessionAgainstFilters(
  s: SessionSummary,
  compiled: CompiledFilterMatrix,
  matrixEnabled: boolean,
  thresholds: NoiseThresholdsConfig,
  compiledHostList?: CompiledHostListFilter
): boolean {
  // 1. Thresholds & Noise Cleanup
  if (thresholds.hide304NotModified && s.status === 304) {
    return false;
  }
  if (
    thresholds.hideOptionsPreflight &&
    s.method.toUpperCase() === "OPTIONS"
  ) {
    return false;
  }
  if (
    thresholds.hideConnectTunnels &&
    (s.method.toUpperCase() === "CONNECT" || s.tlsBypassed)
  ) {
    return false;
  }
  if (
    thresholds.minBodySizeBytes !== null &&
    s.bodySize < thresholds.minBodySizeBytes
  ) {
    return false;
  }
  if (
    thresholds.maxBodySizeBytes !== null &&
    s.bodySize > thresholds.maxBodySizeBytes
  ) {
    return false;
  }
  if (
    thresholds.onlySlowRequests &&
    s.durationMs < thresholds.timeHeatWarningMs
  ) {
    return false;
  }

  // 2. Bulk Hosts & URL Filter (Whitelist / Blacklist — O(1) Set + cached RegExp)
  if (
    compiledHostList &&
    compiledHostList.enabled &&
    compiledHostList.activeCount > 0
  ) {
    const hostMatched = matchesCompiledHostList(s, compiledHostList);
    if (compiledHostList.mode === "whitelist" && !hostMatched) {
      return false;
    }
    if (compiledHostList.mode === "blacklist" && hostMatched) {
      return false;
    }
  }

  if (thresholds.hideStaticAssets) {
    const ct = s.contentType.toLowerCase();
    if (
      ct.startsWith("image/") ||
      ct.startsWith("font/") ||
      ct.includes("text/css") ||
      STATIC_ASSET_EXT_RE.test(s.path)
    ) {
      return false;
    }
  }

  // 3. Filter Rules Matrix (Include / Exclude with AND / OR DNF grouping)
  if (!matrixEnabled) {
    return true;
  }

  if (
    compiled.excludeGroups.length > 0 &&
    evalDnfGroups(s, compiled.excludeGroups)
  ) {
    return false;
  }

  if (
    compiled.includeGroups.length > 0 &&
    !evalDnfGroups(s, compiled.includeGroups)
  ) {
    return false;
  }

  return true;
}

// ============================================================================
// Shared TLS Bypass & Header Mutation Evaluators (for Browser Preview Parity)
// ============================================================================
function globMatches(subject: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${escaped}$`, "i").test(subject);
  } catch {
    return false;
  }
}

function wildcardOrRegexMatches(subject: string, token: string): boolean {
  if (token === "*") return true;
  if (token.startsWith("regex:")) {
    try {
      return new RegExp(token.slice(6).trim(), "i").test(subject);
    } catch {
      return false;
    }
  }
  if (token.startsWith("*.")) {
    const suffix = token.slice(2);
    return subject === suffix || subject.endsWith(`.${suffix}`);
  }
  if (token.startsWith(".")) {
    const suffix = token.slice(1);
    return subject === suffix || subject.endsWith(token);
  }
  if (token.includes("*")) {
    return globMatches(subject, token);
  }
  return subject === token;
}

export type PreviewConnectDecision =
  | { mode: "intercept" }
  | { mode: "passthrough"; reason: "bypassRule"; rule: TlsBypassRule }
  | { mode: "passthrough"; reason: "notInTargetAllowlist" }
  | { mode: "passthrough"; reason: "notInHostsWhitelist" };

export function normalizeHostToken(
  raw: string
): { negated: boolean; token: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const negated = trimmed.startsWith("!");
  const rest = (negated ? trimmed.slice(1) : trimmed).trim();
  if (!rest) return null;

  if (rest.toLowerCase().startsWith("regex:")) {
    const expr = rest.slice(6).trim();
    if (!expr) return null;
    return { negated, token: `regex:${expr}` };
  }

  let lower = rest.toLowerCase();
  for (const scheme of ["https://", "http://", "wss://", "ws://"]) {
    if (lower.startsWith(scheme)) {
      lower = lower.slice(scheme.length);
      break;
    }
  }
  const slashIdx = lower.indexOf("/");
  if (slashIdx !== -1) {
    lower = lower.slice(0, slashIdx);
  }
  const clean = lower.trim().replace(/^\[|\]$/g, "");
  if (!clean) return null;
  return { negated, token: clean };
}

export function matchHostRuleList(
  rules: TlsBypassRule[],
  host: string,
  port: number
): TlsBypassRule | null {
  const hostClean = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  const hostPort = `${hostClean}:${port}`;

  // Pass 1: negative carve-outs (`!sub.domain.com`)
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const raw of rule.pattern.split(",")) {
      const parsed = normalizeHostToken(raw);
      if (!parsed || !parsed.negated) continue;
      const subject =
        parsed.token.includes(":") && !parsed.token.startsWith("regex:")
          ? hostPort
          : hostClean;
      if (wildcardOrRegexMatches(subject, parsed.token)) {
        return null;
      }
    }
  }

  // Pass 2: positive host/wildcard/regex rules
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const raw of rule.pattern.split(",")) {
      const parsed = normalizeHostToken(raw);
      if (!parsed || parsed.negated) continue;
      const subject =
        parsed.token.includes(":") && !parsed.token.startsWith("regex:")
          ? hostPort
          : hostClean;
      if (wildcardOrRegexMatches(subject, parsed.token)) {
        return rule;
      }
    }
  }

  return null;
}

function evaluateHostListConnectInPreview(
  hostClean: string,
  port: number,
  compiled: CompiledHostListFilter
): PreviewConnectDecision | null {
  if (!compiled.enabled || compiled.activeCount === 0) return null;

  const hostPort = `${hostClean}:${port}`;
  const syntheticUrl =
    port === 443
      ? `https://${hostClean}/`
      : `https://${hostClean}:${port}/`;
  const syntheticUrlWithPort = `https://${hostClean}:${port}/`;

  if (compiled.mode === "whitelist") {
    if (compiled.matchesEverything || compiled.hasUniversalHostRule) {
      return null;
    }
    let matched =
      compiled.connectWhitelistHosts.has(hostClean) ||
      compiled.connectWhitelistHostPorts.has(hostPort) ||
      matchesWildcardDomainSet(hostClean, compiled.connectWhitelistWildcards) ||
      (compiled.connectWhitelistHostRegex !== null &&
        (compiled.connectWhitelistHostRegex.test(hostClean) ||
          compiled.connectWhitelistHostRegex.test(hostPort)));

    if (!matched && compiled.userRegexes.length > 0) {
      for (let i = 0; i < compiled.userRegexes.length; i++) {
        const re = compiled.userRegexes[i].regex;
        if (
          re.test(hostClean) ||
          re.test(hostPort) ||
          re.test(syntheticUrl) ||
          re.test(syntheticUrlWithPort)
        ) {
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      return { mode: "passthrough", reason: "notInHostsWhitelist" };
    }
    return { mode: "intercept" };
  }

  // Blacklist mode: whole-host match sends CONNECT directly to TLS Bypass passthrough
  let wholeHostMatched =
    compiled.matchesEverything ||
    compiled.exactHosts.has(hostClean) ||
    compiled.exactHostPorts.has(hostPort) ||
    compiled.exactSchemeHosts.has(`https://${hostClean}`) ||
    compiled.exactSchemeHostPorts.has(`https://${hostPort}`) ||
    compiled.exactSchemeHosts.has(`wss://${hostClean}`) ||
    compiled.exactSchemeHostPorts.has(`wss://${hostPort}`) ||
    matchesWildcardDomainSet(hostClean, compiled.wildcardDomainSet) ||
    matchesWildcardDomainSet(hostClean, compiled.connectBlacklistWildcards) ||
    (compiled.combinedHostGlobRegex !== null &&
      compiled.combinedHostGlobRegex.test(hostClean)) ||
    (compiled.combinedHostPortGlobRegex !== null &&
      compiled.combinedHostPortGlobRegex.test(hostPort)) ||
    (compiled.connectBlacklistHostRegex !== null &&
      (compiled.connectBlacklistHostRegex.test(hostClean) ||
        compiled.connectBlacklistHostRegex.test(hostPort)));

  if (!wholeHostMatched && compiled.userRegexes.length > 0) {
    for (let i = 0; i < compiled.userRegexes.length; i++) {
      const re = compiled.userRegexes[i].regex;
      if (
        re.test(hostClean) ||
        re.test(hostPort) ||
        re.test(syntheticUrl) ||
        re.test(syntheticUrlWithPort)
      ) {
        wholeHostMatched = true;
        break;
      }
    }
  }

  if (wholeHostMatched) {
    return {
      mode: "passthrough",
      reason: "bypassRule",
      rule: {
        id: "hosts-list-blacklist",
        enabled: true,
        pattern: hostPort,
        category: "Hosts List (Blacklist)",
        description: "Bulk Hosts Filter — Hide & TLS Passthrough",
      },
    };
  }

  return null;
}

export function evaluateTlsConnectInPreview(
  host: string,
  port: number,
  config: ProxyFilterBackendConfig
): PreviewConnectDecision {
  const hostClean = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostClean === "flux.proxy" ||
    hostClean === "cert.flux.proxy" ||
    hostClean === "fluxproxy.local"
  ) {
    return { mode: "intercept" };
  }

  // Evaluate synced Bulk Hosts List (if enabled)
  if (config.hostListSync?.enabled) {
    const compiledSync = compileHostListFilter(config.hostListSync);
    const syncDecision = evaluateHostListConnectInPreview(
      hostClean,
      port,
      compiledSync
    );
    if (syncDecision) {
      if (syncDecision.mode === "passthrough") {
        return syncDecision;
      }
      // In Whitelist mode, matched hosts are intercepted unless explicitly in TLS Bypass list below
      if (config.tlsBypassEnabled) {
        const matchedBypass = matchHostRuleList(
          config.tlsBypassRules,
          host,
          port
        );
        if (matchedBypass) {
          return {
            mode: "passthrough",
            reason: "bypassRule",
            rule: matchedBypass,
          };
        }
      }
      return { mode: "intercept" };
    }
  }

  if (config.tlsInterceptMode === "targetedOnly") {
    const matchedTarget = matchHostRuleList(
      config.tlsTargetRules ?? [],
      host,
      port
    );
    if (matchedTarget) {
      return { mode: "intercept" };
    }
    return { mode: "passthrough", reason: "notInTargetAllowlist" };
  }

  if (!config.tlsBypassEnabled) {
    return { mode: "intercept" };
  }
  const matchedBypass = matchHostRuleList(config.tlsBypassRules, host, port);
  if (matchedBypass) {
    return { mode: "passthrough", reason: "bypassRule", rule: matchedBypass };
  }
  return { mode: "intercept" };
}

export function extractParentWildcardDomain(host: string): string | null {
  const clean = host
    .split(":")[0]
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!clean || clean === "localhost") return null;
  // IPv4 or IPv6 literal -> no wildcard parent domain
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean) || clean.includes(":")) {
    return null;
  }
  const labels = clean.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  if (labels.length === 2) {
    return `*.${clean}`;
  }
  // e.g. api.staging.mycompany.com -> *.mycompany.com (or co.uk -> last 3 labels)
  const twoLevelTlds = new Set([
    "co.uk",
    "org.uk",
    "com.au",
    "co.jp",
    "com.br",
    "co.kr",
  ]);
  const lastTwo = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`;
  if (twoLevelTlds.has(lastTwo) && labels.length >= 3) {
    return `*.${labels.slice(-3).join(".")}`;
  }
  return `*.${lastTwo}`;
}

export function matchTlsBypassInPreview(
  host: string,
  port: number,
  config: ProxyFilterBackendConfig
): TlsBypassRule | null {
  if (!config.tlsBypassEnabled) return null;
  return matchHostRuleList(config.tlsBypassRules, host, port);
}

export function applyHeaderMutationsInPreview(
  direction: HeaderMutationDirection,
  url: string,
  headers: HeaderPair[],
  config: ProxyFilterBackendConfig
): { headers: HeaderPair[]; mutated: boolean } {
  if (!config.headerMutationsEnabled) {
    return { headers, mutated: false };
  }

  let mutated = false;
  let next = [...headers];
  const urlLower = url.toLowerCase();

  for (const rule of config.headerMutations) {
    if (!rule.enabled || rule.direction !== direction) continue;

    const scope = rule.urlPattern.trim();
    if (scope && scope !== "*") {
      let scopeMatch = false;
      if (scope.startsWith("regex:")) {
        try {
          scopeMatch = new RegExp(scope.slice(6).trim(), "i").test(url);
        } catch {
          scopeMatch = false;
        }
      } else if (scope.includes("*")) {
        scopeMatch = globMatches(urlLower, scope.toLowerCase());
      } else {
        scopeMatch = urlLower.includes(scope.toLowerCase());
      }
      if (!scopeMatch) continue;
    }

    if (rule.operation === "remove") {
      const targets = rule.headerName
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      if (targets.length === 0) continue;
      const before = next.length;
      next = next.filter((h) => !targets.includes(h.name.trim().toLowerCase()));
      if (next.length !== before) mutated = true;
    } else if (rule.operation === "set") {
      const target = rule.headerName.trim();
      if (!target) continue;
      next = next.filter(
        (h) => h.name.trim().toLowerCase() !== target.toLowerCase()
      );
      next.push({ name: target, value: rule.headerValue });
      mutated = true;
    } else if (rule.operation === "append") {
      const target = rule.headerName.trim();
      if (!target) continue;
      next.push({ name: target, value: rule.headerValue });
      mutated = true;
    }
  }

  return { headers: next, mutated };
}
