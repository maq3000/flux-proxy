import type { ActiveNavSection } from "../types/proxy";
import type { SettingsModalTab } from "../types/settings";

export type SectionKind = "tab" | "settingsTab" | "screen" | "dialog";

export type SettingsSectionId = `settings.${SettingsModalTab}`;

export type ScreenOrDialogSectionId =
  | "settings"
  | "rootCa"
  | "openApiExport"
  | "sanitizedExport"
  | "codeGenerator"
  | "shortcuts"
  | "commentMark"
  | "importCurl";

export type SectionId =
  | ActiveNavSection
  | SettingsSectionId
  | ScreenOrDialogSectionId;

export interface SectionShortcutHint {
  keys: string;
  label: string;
}

export interface SectionMeta {
  id: SectionId;
  kind: SectionKind;
  title: string;
  shortcut?: string;
  summary: string;
  details: string;
  highlights?: readonly string[];
  shortcuts?: readonly SectionShortcutHint[];
}

export const SECTION_REGISTRY: Record<SectionId, SectionMeta> = {
  // ==========================================================================
  // Level 1: Primary Workspace Tabs (ActiveNavSection)
  // ==========================================================================
  traffic: {
    id: "traffic",
    kind: "tab",
    title: "Traffic",
    shortcut: "Alt+1",
    summary: "Живой поток HTTP/HTTPS, WebSocket и SSE сессий с инспектором",
    details:
      "Основная рабочая область для захвата, фильтрации и глубокого разбора сетевого трафика. Таблица сессий работает в паре с инспектором запросов/ответов, анализом протоколов, таймингами и быстрыми действиями над выделенными запросами.",
    highlights: [
      "Мгновенный поиск, регулярные выражения, сортировка колонок и массовое выделение строк",
      "Разбор JSON, XML, Hex, Cookies, Auth, Multipart, SSE, WebSocket и Statistics",
      "Быстрый переход в Composer (E), Comment & Mark (M), Replay (R) и Session Diff (Ctrl+D)",
    ],
    shortcuts: [
      { keys: "F12", label: "Запустить / остановить захват" },
      { keys: "Ctrl+F", label: "Фокус на строку поиска" },
      { keys: "E", label: "Редактировать выбранный запрос в Composer" },
      { keys: "R", label: "Повторить выбранный запрос" },
      { keys: "M", label: "Добавить комментарий или маркер" },
    ],
  },
  composer: {
    id: "composer",
    kind: "tab",
    title: "Composer",
    shortcut: "Alt+2",
    summary: "Конструктор, модификация и повторная отправка HTTP-запросов",
    details:
      "Полноценная рабочая вкладка для ручного составления и отладки HTTP/HTTPS-запросов. Поддерживает перетаскивание сессий из таблицы Traffic, вставку cURL прямо в поле URL, настройку таймаутов и генерацию клиентского кода.",
    highlights: [
      "Клонирование любой сессии из Traffic по клавише E или Drag & Drop",
      "Импорт cURL (Bash, Windows cmd, PowerShell) и генерация клиентского кода",
      "Настраиваемый таймаут запроса с кнопкой отмены и просмотром ответа в сплит-панели",
    ],
    shortcuts: [
      { keys: "Alt+2", label: "Перейти в Composer" },
      { keys: "Alt+1", label: "Вернуться в Traffic" },
      { keys: "E", label: "Открыть выбранную сессию в Composer" },
    ],
  },
  rules: {
    id: "rules",
    kind: "tab",
    title: "AutoResponder",
    shortcut: "Alt+3",
    summary: "Локальные моки ответов, подмена статусов и искусственная задержка",
    details:
      "Движок автоматических правил перехвата для имитации бэкенда без изменения кода приложения. Позволяет возвращать локальные JSON-ответы, подменять HTTP-статусы и добавлять искусственную задержку по шаблонам URL или заголовков.",
    highlights: [
      "Сопоставление по подстроке URL, регулярному выражению или заголовку запроса",
      "Три режима действия: локальный мок ответа, подмена кода статуса и задержка ответа",
      "Глобальный переключатель On/Off и независимое включение отдельных правил",
    ],
    shortcuts: [{ keys: "Alt+3", label: "Перейти в AutoResponder" }],
  },
  breakpoints: {
    id: "breakpoints",
    kind: "tab",
    title: "Breakpoints",
    shortcut: "Alt+6",
    summary: "Интерактивная пауза и правка запросов и ответов на лету",
    details:
      "Неблокирующая вкладка для пошагового перехвата HTTP/HTTPS трафика до отправки на сервер или до возврата клиенту. Во время паузы можно свободно переключаться в Traffic или TextWizard, а верхняя панель позволяет вернуться к ожидающему пакету в один клик.",
    highlights: [
      "Глобальный перехват запросов (F11), ответов (Alt+F11) и условные правила bpu / bpafter",
      "Редактирование метода, URL, кода статуса, заголовков и тела пакета перед продолжением",
      "Быстрая инъекция ответа 500 Internal Server Error, пропуск очереди или отмена запроса",
    ],
    shortcuts: [
      { keys: "Alt+6", label: "Открыть вкладку Breakpoints" },
      { keys: "F11", label: "Переключить Break Before Request" },
      { keys: "Alt+F11", label: "Переключить Break After Response" },
      { keys: "Shift+F11", label: "Снять все точки останова" },
    ],
  },
  scripts: {
    id: "scripts",
    kind: "tab",
    title: "Scripts",
    shortcut: "Alt+5",
    summary: "Пользовательские Python-хуки on_request и on_response с консолью",
    details:
      "Среда написания и запуска Python-скриптов для программной обработки проходящего трафика. Скрипты выполняются в отдельном воркере с защитным fail-open таймаутом и потоковой трансляцией stdout/stderr в консоль.",
    highlights: [
      "Хуки on_request и on_response для подписи запросов, подмены заголовков и трансформации JSON",
      "Готовые шаблоны сценариев и сохранение активного скрипта в профиле настроек",
      "Живая консоль логов с фильтрацией ошибок и мгновенным применением по Ctrl+S / Ctrl+Enter",
    ],
    shortcuts: [
      { keys: "Alt+5", label: "Перейти в Scripts" },
      { keys: "Ctrl+Enter", label: "Применить скрипт в редакторе" },
      { keys: "Ctrl+S", label: "Сохранить и применить скрипт" },
    ],
  },
  diff: {
    id: "diff",
    kind: "tab",
    title: "Session Diff",
    shortcut: "Ctrl+D",
    summary: "Построчное сравнение двух HTTP/HTTPS сессий по заголовкам, кукам и телу",
    details:
      "Полноэкранная вкладка для структурного сравнения пары сессий A и B. Поддерживает переключение областей сравнения, нормализацию порядка ключей и скрытие шумовых заголовков, сохраняя выбранную пару при возврате в Traffic.",
    highlights: [
      "Пять режимов сравнения: Full HTTP, Headers, Cookies & Auth, Req Payload и Resp Body",
      "Алфавитная сортировка ключей JSON/заголовков (Sort Keys) и фильтр шума (No-Noise)",
      "Режимы Split и Inline, пошаговый переход по отличиям и быстрая замена A ↔ B",
    ],
    shortcuts: [{ keys: "Ctrl+D", label: "Переключить вкладку Session Diff / Traffic" }],
  },
  wizard: {
    id: "wizard",
    kind: "tab",
    title: "TextWizard",
    shortcut: "Ctrl+E",
    summary: "Декодер JWT, Base64, URL, алгоритмов сжатия, Hex и Unix Timestamp",
    details:
      "Неблокирующая панель текстовых и бинарных утилит для повседневного анализа API. Сохраняет введённые данные и выбранный инструмент при переключении обратно в Traffic или Composer.",
    highlights: [
      "Разбор JWT с проверкой сроков exp/nbf, заголовков JOSE и предупреждениями безопасности",
      "Кодирование и декодирование Base64 / Base64URL, URL (%XX + разбор Query) и Hex ↔ Text",
      "Сжатие и распаковка Gzip, Brotli, Deflate и Zstd, а также конвертер Unix Timestamp ↔ ISO 8601",
    ],
    shortcuts: [{ keys: "Ctrl+E", label: "Переключить вкладку TextWizard / Traffic" }],
  },

  // ==========================================================================
  // Settings Sections (inside fullscreen Settings)
  // ==========================================================================
  "settings.general": {
    id: "settings.general",
    kind: "settingsTab",
    title: "General",
    summary: "Порт прокси, сетевые интерфейсы, кольцевой буфер памяти и SQLite",
    details:
      "Базовые параметры запуска прокси-сервера, привязки к локальному или сетевому интерфейсу, системного прокси ОС и политики хранения сессий в оперативной памяти и базе SQLite.",
  },
  "settings.networkRouting": {
    id: "settings.networkRouting",
    kind: "settingsTab",
    title: "Network & Routing",
    summary: "Ограничение скорости, HOSTS Remapping, Upstream Proxy и таймауты",
    details:
      "Управление маршрутизацией и сетевыми условиями: профили Throttling, виртуальный DNS (HOSTS Remapping), каскадирование через HTTP/HTTPS/SOCKS5 Upstream Proxy и раздельные таймауты соединения и TTFB.",
  },
  "settings.tlsCertificates": {
    id: "settings.tlsCertificates",
    kind: "settingsTab",
    title: "TLS & Mobile",
    summary: "Режим HTTPS MITM, списки TLS Bypass, mTLS сертификаты и мобильные устройства",
    details:
      "Настройка выборочной расшифровки HTTPS (Intercept All / Targeted Only), пакетный редактор доменов обхода, хранилище клиентских сертификатов mTLS и подключение iOS/Android через Wi-Fi и QR-коды.",
  },
  "settings.filters": {
    id: "settings.filters",
    kind: "settingsTab",
    title: "Filters",
    shortcut: "Alt+4",
    summary: "Матрица фильтров, список хостов, пороги шума и мутации заголовков",
    details:
      "Комплексная фильтрация потока трафика: табличные правила Include/Exclude, массовый Whitelist/Blacklist доменов, скрытие служебного шума и правила модификации HTTP-заголовков.",
  },
  "settings.uiColumns": {
    id: "settings.uiColumns",
    kind: "settingsTab",
    title: "Appearance & Layout",
    summary: "Цветовые темы, редактор палитры, панели и колонки таблицы трафика",
    details:
      "Настройка визуальной среды: выбор готовых тем-пресетов, тонкая правка цветовых токенов, режим компактного тулбара, расположение инспектора и конфигурация колонок таблицы.",
  },
  "settings.diagnosticsBackup": {
    id: "settings.diagnosticsBackup",
    kind: "settingsTab",
    title: "Diagnostics & Backup",
    summary: "Самодиагностика Proxy Doctor, переносимый профиль JSON и сброс настроек",
    details:
      "Проверка работоспособности порта, доверия Root CA, системного прокси, VPN и межсетевого экрана в Proxy Doctor, а также экспорт/импорт полного профиля настроек и сброс к заводским параметрам.",
  },

  // ==========================================================================
  // Level 2 & Level 3: Fullscreen Screens & Compact Dialogs
  // ==========================================================================
  settings: {
    id: "settings",
    kind: "screen",
    title: "Settings",
    shortcut: "Ctrl+,",
    summary: "Центр настроек прокси, маршрутизации, TLS, фильтров, темы и диагностики",
    details:
      "Единый полноэкранный центр конфигурации FluxProxy со сквозным поиском по параметрам, живыми индикаторами активных правил и глубокими ссылками в подразделы.",
    highlights: [
      "Шесть разделов: General, Network & Routing, TLS & Mobile, Filters, Appearance & Layout, Diagnostics & Backup",
      "Сквозной поиск по ключевым словам с мгновенным переходом к нужной карточке настройки",
      "Переносимый экспорт и безопасный импорт профиля настроек JSON с предварительным просмотром",
    ],
    shortcuts: [
      { keys: "Ctrl+,", label: "Открыть / закрыть Settings" },
      { keys: "Alt+4", label: "Открыть Settings → Filters" },
      { keys: "Ctrl+Shift+M", label: "Открыть Settings → Mobile Setup" },
      { keys: "Ctrl+Shift+D", label: "Открыть Settings → Proxy Doctor" },
    ],
  },
  rootCa: {
    id: "rootCa",
    kind: "dialog",
    title: "Root CA",
    summary: "Статус доверия, отпечаток SHA-256 и установка локального корневого сертификата",
    details:
      "Компактный диалог управления локальным корневым центром сертификации FluxProxy для расшифровки HTTPS и WSS трафика в доверенном хранилище операционной системы.",
  },
  openApiExport: {
    id: "openApiExport",
    kind: "screen",
    title: "OpenAPI Export",
    summary: "Автогенерация спецификации OpenAPI 3.0.3 в форматах YAML и JSON",
    details:
      "Полноэкранный генератор документации API по выбранным или всем видимым сессиям. Автоматически параметризует числовые ID и UUID, объединяет JSON-схемы и выносит токены в securitySchemes без раскрытия секретов.",
    highlights: [
      "Выбор области генерации: только выделенные сессии или весь отфильтрованный список",
      "Переключение форматов YAML / JSON, настройка названия и версии спецификации",
      "Безопасное маскирование секретов при включении примеров запросов и ответов",
    ],
  },
  sanitizedExport: {
    id: "sanitizedExport",
    kind: "screen",
    title: "Sanitized Export",
    shortcut: "Ctrl+Shift+S",
    summary: "Безопасный экспорт архивов с очисткой токенов, cookie, секретов и PII",
    details:
      "Полноэкранный мастер подготовки архивов трафика (HAR, SAZ, JSON, Raw HTTP) к передаче коллегам или в баг-трекер с автоматическим маскированием чувствительных данных.",
    highlights: [
      "Готовые пресеты Safe Sharing, Strict Anonymization и гибкий режим Custom",
      "Очистка заголовков авторизации, JSON/Form полей, query-параметров, SSE/WS и метаданных клиента",
      "Живой предпросмотр маскирования перед сохранением архива на диск",
    ],
    shortcuts: [{ keys: "Ctrl+Shift+S", label: "Открыть Sanitized Export" }],
  },
  codeGenerator: {
    id: "codeGenerator",
    kind: "screen",
    title: "Code Generator",
    summary: "Генерация готового клиентского кода на JavaScript, Python, Go, Rust и cURL",
    details:
      "Полноэкранный просмотр и копирование воспроизводимого HTTP-кода по выбранной сессии Traffic или черновику Composer с поддержкой нескольких библиотек и оболочек.",
    highlights: [
      "Поддержка JavaScript (fetch, axios), Python (requests, httpx), Go (net/http), Rust (reqwest) и cURL",
      "Запоминание последнего выбранного языка и библиотеки между открытиями",
      "Корректная обработка заголовков, JSON-пейлоада и бинарных тел запроса",
    ],
  },
  shortcuts: {
    id: "shortcuts",
    kind: "screen",
    title: "Shortcuts",
    shortcut: "?",
    summary: "Справочник клавиатурных комбинаций навигации, сессий, фильтров и инструментов",
    details:
      "Полный список глобальных и контекстных горячих клавиш FluxProxy для быстрой работы с таблицей трафика, инспектором, точками останова и инструментами без мыши.",
    highlights: [
      "Навигация по вкладкам Alt+1 … Alt+6, Session Diff (Ctrl+D) и TextWizard (Ctrl+E)",
      "Одноклавишные действия над сессиями: E, R, M, U, Del, Space/Enter",
      "Управление захватом (F12), точками останова (F11 / Alt+F11 / Shift+F11) и палитрой команд (Ctrl+K)",
    ],
    shortcuts: [{ keys: "?", label: "Открыть / закрыть Shortcuts" }],
  },
  commentMark: {
    id: "commentMark",
    kind: "dialog",
    title: "Comment & Mark",
    shortcut: "M",
    summary: "Текстовая заметка и цветовая подсветка для выбранных сессий",
    details:
      "Компактный диалог добавления комментария и цветового маркера к одной или нескольким сессиям с сохранением в базе SQLite.",
  },
  importCurl: {
    id: "importCurl",
    kind: "dialog",
    title: "Import cURL",
    summary: "Разбор команды cURL в метод, URL, заголовки и тело запроса Composer",
    details:
      "Компактный диалог импорта команд cURL в форматах POSIX Bash, Windows cmd и PowerShell с предварительным разбором перед загрузкой в Composer.",
  },
};

export const SECTION_LIST: readonly SectionMeta[] = Object.values(
  SECTION_REGISTRY
);

export function getSectionMeta(id: SectionId): SectionMeta {
  return SECTION_REGISTRY[id];
}

export function formatSectionTooltip(id: SectionId): string {
  const meta = SECTION_REGISTRY[id];
  return meta.shortcut ? `${meta.title} (${meta.shortcut})` : meta.title;
}
