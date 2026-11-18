export type ThemeTokenKey =
  | "--bg-canvas"
  | "--bg-surface"
  | "--bg-elevated"
  | "--bg-hover"
  | "--bg-selected"
  | "--border-hairline"
  | "--border-strong"
  | "--text-primary"
  | "--text-secondary"
  | "--text-muted"
  | "--accent-primary"
  | "--status-2xx-fg"
  | "--status-3xx-fg"
  | "--status-4xx-fg"
  | "--status-5xx-fg"
  | "--status-ws-fg"
  | "--scrollbar-track"
  | "--scrollbar-thumb";

export type StatusBgTokenKey =
  | "--status-2xx-bg"
  | "--status-3xx-bg"
  | "--status-4xx-bg"
  | "--status-5xx-bg"
  | "--status-ws-bg";

export type StatusFgTokenKey =
  | "--status-2xx-fg"
  | "--status-3xx-fg"
  | "--status-4xx-fg"
  | "--status-5xx-fg"
  | "--status-ws-fg";

export type ThemePresetId =
  | "default-dark"
  | "default-light"
  | "dracula"
  | "tokyo-night"
  | "nord"
  | "fiddler-classic"
  | "github-dark"
  | "monokai-pro";

export type ThemeBaseScheme = "dark" | "light";
export type ThemePreference = "dark" | "light" | "system";
export type CustomColorOverrides = Partial<Record<ThemeTokenKey, string>>;

export interface ThemePresetDefinition {
  id: ThemePresetId;
  name: string;
  description: string;
  baseScheme: ThemeBaseScheme;
  swatches: [string, string, string, string, string];
  tokens: Record<ThemeTokenKey, string>;
}

export const ALL_THEME_TOKEN_KEYS: readonly ThemeTokenKey[] = [
  "--bg-canvas",
  "--bg-surface",
  "--bg-elevated",
  "--bg-hover",
  "--bg-selected",
  "--border-hairline",
  "--border-strong",
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--accent-primary",
  "--status-2xx-fg",
  "--status-3xx-fg",
  "--status-4xx-fg",
  "--status-5xx-fg",
  "--status-ws-fg",
  "--scrollbar-track",
  "--scrollbar-thumb",
] as const;

export const VALID_THEME_TOKEN_KEYS = new Set<ThemeTokenKey>(
  ALL_THEME_TOKEN_KEYS
);

export const STATUS_FG_TO_BG_MAP: Record<StatusFgTokenKey, StatusBgTokenKey> = {
  "--status-2xx-fg": "--status-2xx-bg",
  "--status-3xx-fg": "--status-3xx-bg",
  "--status-4xx-fg": "--status-4xx-bg",
  "--status-5xx-fg": "--status-5xx-bg",
  "--status-ws-fg": "--status-ws-bg",
};

const STATUS_BG_ALPHA: Record<
  ThemeBaseScheme,
  Record<StatusFgTokenKey, number>
> = {
  light: {
    "--status-2xx-fg": 0.11,
    "--status-3xx-fg": 0.11,
    "--status-4xx-fg": 0.11,
    "--status-5xx-fg": 0.11,
    "--status-ws-fg": 0.11,
  },
  dark: {
    "--status-2xx-fg": 0.13,
    "--status-3xx-fg": 0.13,
    "--status-4xx-fg": 0.14,
    "--status-5xx-fg": 0.15,
    "--status-ws-fg": 0.14,
  },
};

export const ALL_MANAGED_CSS_VARIABLES: readonly string[] = [
  ...ALL_THEME_TOKEN_KEYS,
  ...Object.values(STATUS_FG_TO_BG_MAP),
];

export const THEME_PRESETS: readonly ThemePresetDefinition[] = [
  {
    id: "default-dark",
    name: "Flux Dark (Zinc)",
    description: "Эргономичная тёмная палитра Zinc без неоновых бликов",
    baseScheme: "dark",
    swatches: ["#121214", "#18181b", "#6ba3d6", "#6bc497", "#e58e88"],
    tokens: {
      "--bg-canvas": "#121214",
      "--bg-surface": "#18181b",
      "--bg-elevated": "#202024",
      "--bg-hover": "#27272a",
      "--bg-selected": "#222936",
      "--border-hairline": "#27272a",
      "--border-strong": "#3f3f46",
      "--text-primary": "#e4e4e7",
      "--text-secondary": "#a1a1aa",
      "--text-muted": "#82828c",
      "--accent-primary": "#6ba3d6",
      "--status-2xx-fg": "#6bc497",
      "--status-3xx-fg": "#7cc0e6",
      "--status-4xx-fg": "#e0b26b",
      "--status-5xx-fg": "#e58e88",
      "--status-ws-fg": "#b39fe0",
      "--scrollbar-track": "#18181b",
      "--scrollbar-thumb": "#3f3f46",
    },
  },
  {
    id: "default-light",
    name: "Flux Light (Zinc)",
    description: "Чистая дневная палитра с мягким нейтральным контрастом",
    baseScheme: "light",
    swatches: ["#f4f4f5", "#fafafa", "#2b6cb0", "#1f7a52", "#b63d37"],
    tokens: {
      "--bg-canvas": "#f4f4f5",
      "--bg-surface": "#fafafa",
      "--bg-elevated": "#ececef",
      "--bg-hover": "#e4e4e7",
      "--bg-selected": "#dde7f2",
      "--border-hairline": "#e4e4e7",
      "--border-strong": "#d4d4d8",
      "--text-primary": "#18181b",
      "--text-secondary": "#52525b",
      "--text-muted": "#71717a",
      "--accent-primary": "#2b6cb0",
      "--status-2xx-fg": "#1f7a52",
      "--status-3xx-fg": "#1f6fa5",
      "--status-4xx-fg": "#9a5b13",
      "--status-5xx-fg": "#b63d37",
      "--status-ws-fg": "#5f489e",
      "--scrollbar-track": "#f4f4f5",
      "--scrollbar-thumb": "#c8c8d0",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    description: "Классическая фиолетово-графитовая тема с пастельным кодом",
    baseScheme: "dark",
    swatches: ["#21222c", "#282a36", "#bd93f9", "#50fa7b", "#ff79c6"],
    tokens: {
      "--bg-canvas": "#21222c",
      "--bg-surface": "#282a36",
      "--bg-elevated": "#313442",
      "--bg-hover": "#383b4d",
      "--bg-selected": "#3b3f54",
      "--border-hairline": "#3b3e51",
      "--border-strong": "#535872",
      "--text-primary": "#f8f8f2",
      "--text-secondary": "#c5c8dc",
      "--text-muted": "#8893b8",
      "--accent-primary": "#bd93f9",
      "--status-2xx-fg": "#50fa7b",
      "--status-3xx-fg": "#8be9fd",
      "--status-4xx-fg": "#ffb86c",
      "--status-5xx-fg": "#ff6e6e",
      "--status-ws-fg": "#ff79c6",
      "--scrollbar-track": "#282a36",
      "--scrollbar-thumb": "#4b5069",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    description: "Глубокий индиго-ночной интерфейс и мягкие неоновые акценты",
    baseScheme: "dark",
    swatches: ["#16161e", "#1a1b26", "#7aa2f7", "#9ece6a", "#f7768e"],
    tokens: {
      "--bg-canvas": "#16161e",
      "--bg-surface": "#1a1b26",
      "--bg-elevated": "#222436",
      "--bg-hover": "#292e42",
      "--bg-selected": "#283457",
      "--border-hairline": "#26293b",
      "--border-strong": "#3b4261",
      "--text-primary": "#c0caf5",
      "--text-secondary": "#9aa5ce",
      "--text-muted": "#6d769c",
      "--accent-primary": "#7aa2f7",
      "--status-2xx-fg": "#9ece6a",
      "--status-3xx-fg": "#7dcfff",
      "--status-4xx-fg": "#e0af68",
      "--status-5xx-fg": "#f7768e",
      "--status-ws-fg": "#bb9af7",
      "--scrollbar-track": "#1a1b26",
      "--scrollbar-thumb": "#3b4261",
    },
  },
  {
    id: "nord",
    name: "Nord",
    description: "Спокойная арктическая палитра для долгих сессий отладки",
    baseScheme: "dark",
    swatches: ["#242933", "#2e3440", "#88c0d0", "#a3be8c", "#bf616a"],
    tokens: {
      "--bg-canvas": "#242933",
      "--bg-surface": "#2e3440",
      "--bg-elevated": "#363d4c",
      "--bg-hover": "#3b4252",
      "--bg-selected": "#344257",
      "--border-hairline": "#3b4252",
      "--border-strong": "#4c566a",
      "--text-primary": "#eceff4",
      "--text-secondary": "#d8dee9",
      "--text-muted": "#8f9bb0",
      "--accent-primary": "#88c0d0",
      "--status-2xx-fg": "#a3be8c",
      "--status-3xx-fg": "#81a1c1",
      "--status-4xx-fg": "#ebcb8b",
      "--status-5xx-fg": "#bf616a",
      "--status-ws-fg": "#b48ead",
      "--scrollbar-track": "#2e3440",
      "--scrollbar-thumb": "#4c566a",
    },
  },
  {
    id: "fiddler-classic",
    name: "Fiddler Classic",
    description: "Светлый десктопный стиль в духе классических инспекторов HTTP",
    baseScheme: "light",
    swatches: ["#eef2f7", "#ffffff", "#0f5bb5", "#16794b", "#c23636"],
    tokens: {
      "--bg-canvas": "#eef2f7",
      "--bg-surface": "#ffffff",
      "--bg-elevated": "#e5eaf2",
      "--bg-hover": "#dce4ef",
      "--bg-selected": "#cde0f7",
      "--border-hairline": "#d4dce7",
      "--border-strong": "#b6c3d4",
      "--text-primary": "#16202e",
      "--text-secondary": "#475569",
      "--text-muted": "#64748b",
      "--accent-primary": "#0f5bb5",
      "--status-2xx-fg": "#16794b",
      "--status-3xx-fg": "#1d6fb8",
      "--status-4xx-fg": "#a65f0d",
      "--status-5xx-fg": "#c23636",
      "--status-ws-fg": "#6b3fa0",
      "--scrollbar-track": "#eef2f7",
      "--scrollbar-thumb": "#b7c4d6",
    },
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    description: "Контрастный тёмный графит с чёткими границами и синим акцентом",
    baseScheme: "dark",
    swatches: ["#0d1117", "#161b22", "#58a6ff", "#3fb950", "#f85149"],
    tokens: {
      "--bg-canvas": "#0d1117",
      "--bg-surface": "#161b22",
      "--bg-elevated": "#1f2630",
      "--bg-hover": "#262c36",
      "--bg-selected": "#192c46",
      "--border-hairline": "#21262d",
      "--border-strong": "#30363d",
      "--text-primary": "#e6edf3",
      "--text-secondary": "#9ea7b3",
      "--text-muted": "#7d8590",
      "--accent-primary": "#58a6ff",
      "--status-2xx-fg": "#3fb950",
      "--status-3xx-fg": "#79c0ff",
      "--status-4xx-fg": "#d29922",
      "--status-5xx-fg": "#f85149",
      "--status-ws-fg": "#bc8cff",
      "--scrollbar-track": "#161b22",
      "--scrollbar-thumb": "#30363d",
    },
  },
  {
    id: "monokai-pro",
    name: "Monokai Pro",
    description: "Тёплый угольный фон и насыщенная янтарно-изумрудная палитра",
    baseScheme: "dark",
    swatches: ["#221f22", "#2d2a2e", "#d9822b", "#a9dc76", "#ff6188"],
    tokens: {
      "--bg-canvas": "#221f22",
      "--bg-surface": "#2d2a2e",
      "--bg-elevated": "#383439",
      "--bg-hover": "#403e41",
      "--bg-selected": "#42372c",
      "--border-hairline": "#3c383d",
      "--border-strong": "#5b595c",
      "--text-primary": "#fcfcfa",
      "--text-secondary": "#c1c0c0",
      "--text-muted": "#939293",
      "--accent-primary": "#d9822b",
      "--status-2xx-fg": "#a9dc76",
      "--status-3xx-fg": "#78dce8",
      "--status-4xx-fg": "#fc9867",
      "--status-5xx-fg": "#ff6188",
      "--status-ws-fg": "#ab9df2",
      "--scrollbar-track": "#2d2a2e",
      "--scrollbar-thumb": "#5b595c",
    },
  },
];

export const THEME_PRESETS_BY_ID: Record<ThemePresetId, ThemePresetDefinition> =
  THEME_PRESETS.reduce(
    (acc, preset) => {
      acc[preset.id] = preset;
      return acc;
    },
    {} as Record<ThemePresetId, ThemePresetDefinition>
  );

export const VALID_THEME_PRESET_IDS = new Set<ThemePresetId>(
  THEME_PRESETS.map((p) => p.id)
);

export function isThemePresetId(value: unknown): value is ThemePresetId {
  return (
    typeof value === "string" &&
    VALID_THEME_PRESET_IDS.has(value as ThemePresetId)
  );
}

/**
 * Normalizes `#RGB` or `#RRGGBB` strings (with or without leading `#`) to lowercase `#rrggbb`.
 * Returns `null` if the input is not a valid 3- or 6-digit hex color.
 */
export function normalizeHexColor(input: string): string | null {
  const cleaned = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    const expanded = cleaned
      .split("")
      .map((ch) => `${ch}${ch}`)
      .join("")
      .toLowerCase();
    return `#${expanded}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return `#${cleaned.toLowerCase()}`;
  }
  return null;
}

function hexToRgbChannels(hex: string): [number, number, number] {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return [128, 128, 128];
  const raw = normalized.slice(1);
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const toByte = (n: number) =>
    Math.min(255, Math.max(0, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

/**
 * Converts a HEX color into a CSS `rgb(R G B / alpha)` string compatible with
 * FluxProxy's `--status-*-bg` tokens and `src/index.css`.
 */
export function hexToRgbaString(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgbChannels(hex);
  const clampedAlpha = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1));
  const alphaStr = Number(clampedAlpha.toFixed(3)).toString();
  return `rgb(${r} ${g} ${b} / ${alphaStr})`;
}

/**
 * Derives a comfortable, readable `--bg-selected` HEX color by blending
 * `--accent-primary` into `--bg-canvas` when the user overrides accent without
 * explicitly overriding `--bg-selected`.
 */
export function deriveSelectedBgHex(
  accentHex: string,
  canvasHex: string,
  baseScheme: ThemeBaseScheme
): string {
  const [ar, ag, ab] = hexToRgbChannels(accentHex);
  const [cr, cg, cb] = hexToRgbChannels(canvasHex);
  const ratio = baseScheme === "dark" ? 0.2 : 0.16;
  return rgbToHex(
    cr * (1 - ratio) + ar * ratio,
    cg * (1 - ratio) + ag * ratio,
    cb * (1 - ratio) + ab * ratio
  );
}

export function sanitizeCustomColorOverrides(
  raw: unknown
): CustomColorOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const result: CustomColorOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!VALID_THEME_TOKEN_KEYS.has(key as ThemeTokenKey)) continue;
    if (typeof value !== "string") continue;
    const normalized = normalizeHexColor(value);
    if (normalized) {
      result[key as ThemeTokenKey] = normalized;
    }
  }
  return result;
}

export interface ResolvedThemePalette {
  effectivePresetId: ThemePresetId;
  baseScheme: ThemeBaseScheme;
  tokens: Record<ThemeTokenKey, string>;
  statusBgTokens: Record<StatusBgTokenKey, string>;
  isDefaultBaseline: boolean;
}

export function resolveEffectiveThemeTokens(
  presetId: ThemePresetId,
  overrides: CustomColorOverrides,
  systemDark = true,
  preference: ThemePreference = "dark"
): ResolvedThemePalette {
  const effectivePresetId: ThemePresetId =
    preference === "system" &&
    (presetId === "default-dark" || presetId === "default-light")
      ? systemDark
        ? "default-dark"
        : "default-light"
      : presetId;

  const preset =
    THEME_PRESETS_BY_ID[effectivePresetId] ?? THEME_PRESETS_BY_ID["default-dark"];

  const tokens: Record<ThemeTokenKey, string> = { ...preset.tokens };
  for (const key of ALL_THEME_TOKEN_KEYS) {
    const override = overrides[key];
    if (override) {
      const normalized = normalizeHexColor(override);
      if (normalized) {
        tokens[key] = normalized;
      }
    }
  }

  if (overrides["--accent-primary"] && !overrides["--bg-selected"]) {
    tokens["--bg-selected"] = deriveSelectedBgHex(
      tokens["--accent-primary"],
      tokens["--bg-canvas"],
      preset.baseScheme
    );
  }

  const statusBgTokens = {} as Record<StatusBgTokenKey, string>;
  for (const [fgKey, bgKey] of Object.entries(STATUS_FG_TO_BG_MAP) as [
    StatusFgTokenKey,
    StatusBgTokenKey,
  ][]) {
    const alpha = STATUS_BG_ALPHA[preset.baseScheme][fgKey];
    statusBgTokens[bgKey] = hexToRgbaString(tokens[fgKey], alpha);
  }

  const hasOverrides = Object.keys(overrides).length > 0;
  const isDefaultBaseline =
    !hasOverrides &&
    (effectivePresetId === "default-dark" ||
      effectivePresetId === "default-light");

  return {
    effectivePresetId,
    baseScheme: preset.baseScheme,
    tokens,
    statusBgTokens,
    isDefaultBaseline,
  };
}

export interface ThemeTokenFieldMeta {
  key: ThemeTokenKey;
  label: string;
  hint: string;
  previewBadge?: string;
}

export interface ThemeTokenGroupMeta {
  id: string;
  title: string;
  description: string;
  fields: readonly ThemeTokenFieldMeta[];
}

export const THEME_TOKEN_GROUPS: readonly ThemeTokenGroupMeta[] = [
  {
    id: "surfaces",
    title: "Фоны, поверхности и границы",
    description:
      "Базовый холст окна, панели инспектора, выделение строк и разделители",
    fields: [
      { key: "--bg-canvas", label: "Canvas", hint: "Основной фон окна и редактора" },
      { key: "--bg-surface", label: "Surface", hint: "Поверхности таблиц, тулбара и модалок" },
      { key: "--bg-elevated", label: "Elevated", hint: "Карточки, вкладки и приподнятые блоки" },
      { key: "--bg-hover", label: "Hover", hint: "Подсветка наведения на строки и кнопки" },
      { key: "--bg-selected", label: "Selected", hint: "Фон выбранной HTTP-сессии" },
      { key: "--border-hairline", label: "Border Hairline", hint: "Тонкие разделители таблиц" },
      { key: "--border-strong", label: "Border Strong", hint: "Границы инпутов и активных карточек" },
    ],
  },
  {
    id: "typography",
    title: "Текст, акцент и скроллбар",
    description: "Контраст шрифтов, фирменный акцент и полосы прокрутки",
    fields: [
      { key: "--text-primary", label: "Primary Text", hint: "Основной текст и значения" },
      { key: "--text-secondary", label: "Secondary Text", hint: "Подписи и второстепенный текст" },
      { key: "--text-muted", label: "Muted Text", hint: "Подсказки и неактивные метки" },
      { key: "--accent-primary", label: "Primary Accent", hint: "Фокус, активные вкладки и ссылки" },
      { key: "--scrollbar-track", label: "Scrollbar Track", hint: "Дорожка полосы прокрутки" },
      { key: "--scrollbar-thumb", label: "Scrollbar Thumb", hint: "Ползунок прокрутки" },
    ],
  },
  {
    id: "statuses",
    title: "Семантика HTTP-статусов и WebSocket",
    description:
      "Фон плашек (--status-*-bg) вычисляется автоматически с оптимальной прозрачностью",
    fields: [
      {
        key: "--status-2xx-fg",
        label: "2xx Success",
        hint: "Успешные ответы 200–299",
        previewBadge: "200 OK",
      },
      {
        key: "--status-3xx-fg",
        label: "3xx Redirect",
        hint: "Редиректы и кэш 300–399",
        previewBadge: "304",
      },
      {
        key: "--status-4xx-fg",
        label: "4xx Client Error",
        hint: "Ошибки клиента 400–499",
        previewBadge: "404",
      },
      {
        key: "--status-5xx-fg",
        label: "5xx Server Error",
        hint: "Ошибки сервера 500–599",
        previewBadge: "502",
      },
      {
        key: "--status-ws-fg",
        label: "WebSocket",
        hint: "WebSocket 101 и фреймы",
        previewBadge: "WS 101",
      },
    ],
  },
];
