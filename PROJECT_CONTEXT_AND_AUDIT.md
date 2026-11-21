# PROJECT_CONTEXT_AND_AUDIT.md — Всесторонний архитектурный справочник и доказательный аудит FluxProxy (`v0.4.0`)

> **Дата аудита:** 2026-11-21
> **Ревизия репозитория:** ветка `main`, коммит `0776426` (`fix(ci): resolve clippy needless_bool and cross-platform unused warnings`), 1 коммит поверх релизного тега `v0.4.0` (`303f985`).
> **Режим аудита:** строго Read-Only (исходный код, конфигурации и тесты не модифицировались; выполнены только безопасные проверочные команды).

---

## 1. Паспорт проекта (Executive Summary)

### 1.1. Назначение системы и решаемая задача
**FluxProxy** (`package.json:2-4`, `src-tauri/Cargo.toml:1-9`, `src-tauri/tauri.conf.json:1-6`) — кроссплатформенное настольное приложение (Windows, macOS, Linux) для перехвата, инспекции, модификации, повтора и отладки HTTP/1.1, HTTP/2, HTTPS (динамический MITM с генерацией листовых X.509 сертификатов на лету), WebSocket (`ws://` / `wss://`) и Server-Sent Events (SSE) трафика. Позиционируется как легковесная нативная альтернатива Fiddler Classic / Fiddler Everywhere, Charles Proxy и mitmproxy без зависимости от Electron и .NET (`README.md:10-20`).

Ключевые функциональные подсистемы:
- **MITM-прокси и сетевое ядро** (`src-tauri/src/proxy/server.rs:1-7759`) — приём `HTTP` и `CONNECT`-туннелей, динамическая подмена TLS-сертификатов (`ca.rs:1-910`), избирательный перехват (`InterceptAll` / `TargetedOnly` / `Bypass` в `filters.rs:1-2571`), клиентские сертификаты mTLS (`client_certs.rs:1-1117`), двухфазный захват сессий (Pending → Completed), потоковая передача крупных тел и SSE без буферизации (`server.rs:3212-3489`), перехват фреймов WebSocket (`server.rs:3844-4152`).
- **Инструменты активного вмешательства в трафик** — Live Breakpoints до отправки запроса и после получения ответа (`breakpoints.rs:1-490`), правила AutoResponder (`Mock`, `Redirect`, `Delay`, `Drop`, `OverrideStatus` в `rules.rs:1-315`), мутации заголовков (`filters.rs:480-555`), встроенный Python 3 Scripting Engine с хуками `on_request` / `on_response` в долгоживущем дочернем процессе (`scripting/python_runner.rs:1-2006`), ручной конструктор запросов Request Composer (`server.rs:1544-2122`, `src/components/ComposerPanel.tsx:1-2135`).
- **Гибридное хранилище и обмен архивами** — in-memory индекс `DashMap` с вытеснением по лимиту (`retention_limit`) и сбросом тел `> 2 MiB` в локальную базу SQLite (`storage/mod.rs:1-1558`, `storage/sqlite.rs:1-663`), импорт/экспорт `.har`, `.saz` (Fiddler Archive ZIP), `.json`, cURL и сырых дампов с опциональной санитизацией секретов (`storage/export_import.rs:1-4053`).
- **Системная интеграция и самодиагностика** — управление системным прокси ОС с журналом аварийного отката `.sysproxy-recovery.json` (`proxy/sysproxy.rs:1-2276`), сопоставление локальных TCP-портов с PID/именем процесса (`proxy/process.rs:1-511`), обнаружение LAN-интерфейсов и портал `http://flux.proxy/cert` с QR-кодом для мобильных устройств (`proxy/network.rs:1-952`), самодиагностика Proxy Doctor (`proxy/doctor.rs:1-1260`).
- **Двухрежимный фронтенд** — React-интерфейс работает как поверх нативного Tauri IPC, так и в режиме автономного браузерного симулятора (`BrowserPreviewEngine` в `src/lib/tauriBridge.ts:319-2491`) при открытии `npm run dev` в обычном браузере.

### 1.2. Технологический стек и точные версии

| Слой / Категория | Технология / Пакет | Версия в манифесте | Фактическая версия в окружении / Lock | Источник |
| :--- | :--- | :--- | :--- | :--- |
| **OS / Окружение аудита** | Windows / PowerShell | Windows x64 | Node `v24.14.0`, npm `11.19.0`, `rustc 1.99.1`, `cargo 1.99.1`, Python `3.15.0` | Команды терминала |
| **Desktop Shell & IPC** | Tauri v2 (`tauri`, `tauri-build`) | `2` (`Cargo.toml:14,17`) | `@tauri-apps/api ^2.10.1`, `@tauri-apps/cli ^2.10.1` | `package.json:15,24`, `src-tauri/Cargo.toml:14-18` |
| **Tauri Plugins** | `tauri-plugin-dialog`, `tauri-plugin-clipboard-manager` | `2` (`Cargo.toml:18-19`) | `@tauri-apps/plugin-dialog ^2.6.0`, `@tauri-apps/plugin-clipboard-manager ^2.3.2` | `package.json:16-17`, `src-tauri/Cargo.toml:18-19` |
| **Frontend UI** | React / React DOM | `^19.2.4` | React 19 + TypeScript `^5.9.3` | `package.json:19-20,30` |
| **Bundler / Test Runner** | Vite / Vitest | `vite ^8.0.0`, `vitest ^4.1.0` | `@vitejs/plugin-react ^6.0.1`, `jsdom ^29.0.0` | `package.json:25-32` |
| **UI Виртуализация и Редактор** | `@tanstack/react-virtual`, `monaco-editor` | `^3.13.23`, `^0.55.1` | `@monaco-editor/react ^4.7.0`, `lucide-react ^0.577.0` | `package.json:14,18,21-22` |
| **Async Runtime (Rust)** | `tokio` (`full`) | `1` | Многопоточный Tokio runtime | `src-tauri/Cargo.toml:22` |
| **HTTP Сервер и Клиент** | `hyper`, `hyper-util`, `http-body-util`, `reqwest` | `1`, `0.1`, `0.1`, `0.12` | `reqwest` с `rustls-tls`, `gzip`, `brotli`, `deflate`, `zstd`, `http2`, `stream` | `src-tauri/Cargo.toml:23-32` |
| **TLS & Криптография** | `tokio-rustls`, `rustls`, `rcgen`, `x509-parser`, `p12-keystore`, `sha2` | `0.26`, `0.23` (`ring`), `0.13`, `0.16`, `0.2`, `0.10` | Динамическая генерация X.509 (`rcgen`), парсинг PKCS#12 (`p12-keystore`) | `src-tauri/Cargo.toml:33-37,49-50` |
| **WebSocket** | `tokio-tungstenite`, `tungstenite` | `0.26`, `0.26` | `rustls-tls-webpki-roots` | `src-tauri/Cargo.toml:40-41` |
| **Хранилище и Архивы** | `rusqlite`, `dashmap`, `zip` | `0.32`, `6`, `2.2` | `rusqlite` с `bundled` SQLite 3, `zip` с `deflate` | `src-tauri/Cargo.toml:42,45,48` |
| **Сжатие и Сериализация** | `flate2`, `brotli`, `zstd`, `serde`, `serde_json`, `regex`, `url`, `chrono`, `qrcode` | `1.0`, `7.0`, `0.13`, `1`, `1`, `1`, `2`, `0.4`, `0.14` | Полный стек кодеков HTTP | `src-tauri/Cargo.toml:20-21,38-39,43-47,51` |

### 1.3. Тип архитектуры
**Гибридный настольный монолит (Tauri v2 Native Core + React SPA Frontend)** с чётким разделением через границу IPC (`src-tauri/src/commands.rs:1-838` ↔ `src/lib/tauriBridge.ts:1-3371`):
1. **Rust-ядро (`src-tauri/src/`)** управляемо единым фасадом `ProxyController` (`src-tauri/src/proxy/server.rs:731-806`), который агрегирует потокобезопасные (`Arc<...>`) подсистемы: `CertificateAuthority`, `TrafficStore` (RAM `DashMap` + `SqliteStore`), `RuleEngine`, `BreakpointEngine`, `ProxyFilterEngine`, `ClientCertificateStore`, `PythonScriptRunner`, `SystemProxyManager` и `ProcessResolver`.
2. **React-фронтенд (`src/`)** построен вокруг центрального хука оркестрации `useProxySessions` (`src/hooks/useProxySessions.ts:703-3337`) и корневого компонента `App` (`src/App.tsx:263-3747`), получающих батчи событий из Rust через Tauri Events (`proxy://session-batch`, `proxy://sessions-removed`, `proxy://breakpoints-changed`, `proxy://status-changed`, `proxy://storage-stats`, `proxy://script-console-log`) и вызывающих 59 Tauri IPC-команд.

### 1.4. Текущий статус здоровья проекта (Вердикт)
- **Сборка и статический анализ:** **Зелёный (с замечаниями по размеру бандла и 1 flaky-тесту).**
  - `npm run typecheck` (`tsc --noEmit`): **PASS** (0 ошибок).
  - `npm run test` (`vitest run`): **PASS** (11 тестовых файлов, 80 тестов, `2.84s`).
  - `npm run build` (`tsc && vite build`): **PASS** (`44.07s`), но с предупреждением Vite о чанках `> 500 kB` (`ts.worker` 7.05 МБ, `monaco-editor` 4.62 МБ, `index` 1.06 МБ).
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`: **PASS** (0 предупреждений).
  - `cargo test --manifest-path src-tauri/Cargo.toml`: **FLAKY** — при первом параллельном прогоне упал 1 из 101 тестов (`proxy::doctor::tests::doctor_detects_stopped_port_and_fixes_listener_plus_e2e_health` в `src-tauri/src/proxy/doctor.rs:1100:9` из-за гонки освобождения эфемерного порта при `retry_attempts = 1`); при повторном запуске всего набора и изолированном запуске проходит (`101 passed; 0 failed`).
- **Критические риски архитектуры и безопасности:**
  - Обнаружено **25 подтверждённых кодом проблем**: **3 Critical**, **10 High**, **9 Medium**, **3 Low**.
  - Главные блокеры:
    1. **Скрытое выполнение произвольного Python-кода (RCE)** при импорте JSON-профиля настроек без предупреждения в превью (`[SEC-01]`).
    2. **Коллизия `next_id = 1` после перезапуска приложения** при живой базе `sessions.sqlite`, приводящая к подмешиванию чужих выгруженных тел (`> 2 MiB`) и заметок к новым сессиям и перезаписи архивных сессий (`[BUG-01]`).
    3. **Обход валидации путей в Tauri IPC-командах** (`validate_user_file_path` проверяет только последний сегмент пути и допускает `..`, UNC-пути и перезапись произвольных файлов через `save_session_body_file`) (`[SEC-02]`).
    4. **Детерминированная утечка токенов и PII при санитизированном экспорте** в сырых телах SSE (`response_body_text`/`base64` не редактируются вообще), фреймах WebSocket и `camelCase`-ключах JSON (`[SEC-04]`).

---

## 2. Карта кодовой базы (Codebase Map)

### 2.1. Дерево ключевых директорий и файлов

```text
Fiddler Clone/
├── .github/workflows/
│   └── ci.yml                          # GitHub Actions CI: Frontend (ubuntu) + Rust matrix (ubuntu, windows, macos)
├── .agents/skills/fluxproxy-release/
│   └── SKILL.md                        # Внутренний регламент выпуска релизов FluxProxy
├── public/
│   └── theme-init.js                   # Скрипт ранней инициализации CSS-переменных темы до монтирования React
├── src/                                # Frontend (React 19 + TypeScript 5.9 + Vite 8)
│   ├── main.tsx                        # Точка входа браузера/WebView: настройка воркеров Monaco и рендер <App />
│   ├── App.tsx                         # Корневой UI-компонент (3,747 строк): лейаут, модалки, хоткеи, меню
│   ├── styles.css                      # Глобальные стили и дизайн-система на CSS-переменных (9,259 строк)
│   ├── types/
│   │   ├── proxy.ts                    # Все доменные типы трафика, правил, сертификатов, скриптинга и диагностик (599 строк)
│   │   └── settings.ts                 # Схема версионированного профиля настроек fluxproxy-settings-v1 (153 строки)
│   ├── hooks/
│   │   ├── useProxySessions.ts         # Главный стейт-хук приложения: синхронизация с Rust, фильтрация, батчинг (3,337 строк)
│   │   ├── useUiPreferences.ts         # Персистентные настройки таблиц, сплит-панелей, тулбара и лимитов (626 строк)
│   │   └── useTheme.ts                 # Управление 8 пресетами тем, кастомной палитрой и темой Monaco (351 строка)
│   ├── lib/
│   │   ├── tauriBridge.ts              # Обёртка над 59 командами Tauri IPC + автономный BrowserPreviewEngine (3,371 строка)
│   │   ├── settingsManager.ts          # Сбор, валидация, миграция, превью и применение профиля настроек (2,859 строк)
│   │   ├── filterEngine.ts             # Клиентский движок фильтрации, пресеты, матрица условий, подсветка (2,328 строк)
│   │   ├── protocolInspectors.ts       # Парсеры JWT/Auth, Cookies, Caching, Multipart, Protobuf/gRPC, GraphQL (966 строк)
│   │   ├── codeGenerators.ts           # Генерация клиентского кода (fetch, axios, requests, httpx, Go, Rust, cURL) (458 строк)
│   │   ├── openApiGenerator.ts         # Вывод спецификаций OpenAPI 3.0.3 (YAML/JSON) из набора сессий (467 строк)
│   │   ├── curlParser.ts               # Парсер команд cURL (bash/cmd/PowerShell) в запросы Composer (423 строки)
│   │   ├── mockTraffic.ts              # Генератор демонстрационных сессий для BrowserPreviewEngine (429 строк)
│   │   ├── monaco.ts                   # Регистрация локальных Web Workers для Monaco Editor (102 строки)
│   │   └── __tests__/                  # Модульные тесты Vitest (11 файлов, 80 тестов)
│   └── components/                     # 28 React-компонентов (TrafficGrid, SessionInspector, FilterDrawer, SettingsModal и др.)
├── src-tauri/                          # Backend (Rust 2021 + Tauri v2 + Tokio + Hyper 1.0)
│   ├── Cargo.toml                      # Манифест зависимостей Rust-ядра
│   ├── tauri.conf.json                 # Конфигурация окна Tauri, CSP и сборщика инсталляторов (.exe / .msi)
│   ├── capabilities/default.json       # Разрешения Tauri v2 Capability (core, dialog, clipboard-manager)
│   └── src/
│       ├── main.rs                     # Бинарная точка входа: вызывает flux_proxy_lib::run()
│       ├── lib.rs                      # Инициализация Tauri, создание ProxyController, регистрация 59 команд и хука выхода
│       ├── models.rs                   # Структуры данных IPC/хранилища, санитизация URL/заголовков/JSON (582 строки)
│       ├── commands.rs                 # Тонкий слой Tauri #[tauri::command] + валидация файловых путей (838 строк)
│       ├── scripting/
│       │   ├── mod.rs
│       │   └── python_runner.rs        # Долгоживущий Python-воркер (JSONL по stdin/stdout), обнаружение Python 3 (2,006 строк)
│       ├── storage/
│       │   ├── mod.rs                  # Гибридный TrafficStore (DashMap в RAM + вытеснение/оффлоад в SQLite) (1,558 строк)
│       │   ├── sqlite.rs               # Обёртка rusqlite (WAL, таблицы sessions и offloaded_bodies, миграции, VACUUM) (663 строки)
│       │   └── export_import.rs        # Экспорт/импорт HAR 1.2, SAZ, JSON, cURL, Raw + санитизация PII (4,053 строки)
│       └── proxy/
│           ├── mod.rs
│           ├── server.rs               # Ядро HTTP/HTTPS/WS/SSE MITM-прокси, портал flux.proxy, Composer (7,759 строк)
│           ├── filters.rs              # Движок фильтрации захвата, TLS Bypass/TargetedOnly, мутации заголовков (2,571 строка)
│           ├── sysproxy.rs             # Системный прокси ОС (WinINet/Registry, networksetup, gsettings/kioslaverc) (2,276 строк)
│           ├── doctor.rs               # Самодиагностика Proxy Doctor (8 проверок + автоисправление) (1,260 строк)
│           ├── client_certs.rs         # Хранилище клиентских сертификатов mTLS (PKCS#12 / PEM) и пул reqwest::Client (1,117 строк)
│           ├── network.rs              # Обнаружение сетевых интерфейсов LAN (Win32 IpHlpApi / POSIX) и QR-код (952 строки)
│           ├── ca.rs                   # Генерация Root CA и листовых сертификатов (rcgen), доверие в ОС, LRU-кэш (910 строк)
│           ├── process.rs              # Резолвер локальный порт -> PID -> имя процесса (Win32 IP Helper / procfs / lsof) (511 строк)
│           ├── breakpoints.rs          # Движок точек останова (Before Request / After Response) на oneshot-каналах (490 строк)
│           ├── rules.rs                # Движок правил AutoResponder с предкомпилированными Regex (315 строк)
│           └── codec.rs                # Трансформации TextWizard (Base64, URL, Hex, HTML, JWT, Gzip/Deflate/Brotli/Zstd, Hash) (197 строк)
├── README.md                           # Обзор проекта, возможностей, архитектуры и сборки
├── USER_GUIDE.md                       # Пользовательское руководство на русском языке
├── ROADMAP.md                          # История выполненных этапов (Stages 1–28) и бэклог развития
├── PYTHON_SCRIPTING_GUIDE.md           # Руководство пользователя по Python Scripting Engine
└── PYTHON_SCRIPTING_AI_GUIDE.md        # Спецификация контракта хуков Python для генерации скриптов ИИ
```

### 2.2. Точки входа (Entry Points)

1. **Нативное приложение (Rust Binary):**
   - `src-tauri/src/main.rs:4-6` (`fn main()`) → вызывает `flux_proxy_lib::run()` в `src-tauri/src/lib.rs:64-187`.
   - В `setup`-хуке (`src-tauri/src/lib.rs:70-99`) вычисляется директория данных `app.path().app_data_dir()` (с фолбэком на `.fluxproxy-data`), создаётся `Arc::new(ProxyController::new(app_data_dir))`, привязывается `AppHandle` (`controller_for_setup.set_app_handle`), и в фоновом `tauri::async_runtime::spawn` запускается TCP-сервер прокси на `127.0.0.1:8888` (`controller_for_autostart.start(8888).await`).
   - В `.build()` (`src-tauri/src/lib.rs:170-186`) регистрируется обработчик `RunEvent::ExitRequested` / `RunEvent::Exit`, который вызывает `controller.shutdown_cleanup()` (откат системного прокси ОС, остановка Python-воркера и опциональный `VACUUM` базы SQLite при `clear_db_on_exit == true`).
2. **Веб-интерфейс (React Frontend):**
   - `index.html:1-19` синхронно загружает `/theme-init.js` (`public/theme-init.js:1-162`) для предотвращения вспышки светлой/тёмной темы (FOUC), затем монтирует `/src/main.tsx`.
   - `src/main.tsx:1-10` импортирует `./lib/monaco` (конфигурирует локальные Web Workers для Monaco Editor без CDN в `src/lib/monaco.ts:17-37`) и рендерит `<App />` (`src/App.tsx:263`).
3. **Фоновый субпроцесс Python-воркера:**
   - Запускается лениво из `PythonScriptRunner::ensure_worker_locked` (`src-tauri/src/scripting/python_runner.rs:1076-1129`) вызовом `python -u -c PYTHON_WORKER_BOOTSTRAP` (`python_runner.rs:34-345`). Общается с Rust-ядром по `stdin`/`stdout` протоколом JSON Lines (`\n`), а `stderr` читается отдельной задачей Tokio (`python_runner.rs:1106-1121`).
4. **Тестовые точки входа:**
   - Frontend: `vitest run` (`package.json:10`), конфигурация в `vite.config.ts:59-63`, тесты в `src/lib/__tests__/*.test.ts`.
   - Backend: `cargo test --manifest-path src-tauri/Cargo.toml` — встроенные модули `#[cfg(test)] mod tests` в 15 файлах `src-tauri/src/**/*.rs`.

### 2.3. Внешние зависимости, системные вызовы и интеграции

- **Файловая система (`app_data_dir`, на Windows `%APPDATA%\com.fluxproxy.desktop\`):**
  - `ca/fluxproxy-root-ca.crt`, `ca/fluxproxy-root-ca.cer`, `ca/fluxproxy-root-ca.key` — корневой сертификат и приватный ключ (`src-tauri/src/proxy/ca.rs:107-110`).
  - `sessions.sqlite` (+ `-wal`, `-shm`) — база SQLite для вытесненных сессий и тел `> 2 MiB` (`src-tauri/src/storage/mod.rs:64`).
  - `storage-config.json` — персистентная конфигурация хранилища (`clear_db_on_exit`, `src-tauri/src/storage/mod.rs:32-37, 65`).
  - `client_certs/registry.json` и `client_certs/{id}.identity.pem` — реестр и PEM-файлы клиентских сертификатов mTLS (`src-tauri/src/proxy/client_certs.rs:451-462, 643-644`).
  - `.sysproxy-recovery.json` — журнал состояния системного прокси ОС для аварийного восстановления после краша (`src-tauri/src/proxy/sysproxy.rs:115, 224`).
- **Нативные Win32 FFI (`#[cfg(target_os = "windows")]`):**
  - `wininet.dll` (`InternetSetOptionW`), `advapi32.dll` (`RegOpenKeyExW`, `RegQueryValueExW`, `RegSetValueExW`, `RegDeleteValueW`, `RegEnumValueW`, `RegCloseKey`), `user32.dll` (`SendMessageTimeoutW`) — атомарное переключение системного прокси Windows без мигания консольных окон (`src-tauri/src/proxy/sysproxy.rs:956-1215`) и чтение правил брандмауэра Windows (`src-tauri/src/proxy/doctor.rs:483-640`).
  - `iphlpapi.dll` (`GetExtendedTcpTable`, `GetIpAddrTable`, `GetIfEntry`, `ConvertInterfaceIndexToLuid`, `ConvertInterfaceLuidToAlias`) и `kernel32.dll` (`OpenProcess`, `QueryFullProcessImageNameW`, `CloseHandle`) — разрешение PID/имени процесса по локальному порту (`src-tauri/src/proxy/process.rs:124-296`) и перечисление LAN-интерфейсов (`src-tauri/src/proxy/network.rs:482-585`).
- **Внешние CLI-утилиты ОС:**
  - Доверие Root CA (`src-tauri/src/proxy/ca.rs:317-616`): `certutil` (Windows), `security` / `osascript` (macOS), `pkexec` / `update-ca-certificates` / `update-ca-trust` / `trust` (Linux).
  - Системный прокси на macOS/Linux (`src-tauri/src/proxy/sysproxy.rs:582-953`): `networksetup`, `scutil` (macOS), `gsettings`, `kreadconfig6`/`kreadconfig5`, `kwriteconfig6`/`kwriteconfig5` (Linux).
  - Резолвер процессов и сети на macOS/Linux: `lsof` (`src-tauri/src/proxy/process.rs:415`), `ifconfig` / `route` / `ip` (`src-tauri/src/proxy/network.rs:629-845`), `pfctl` / `ufw` (`src-tauri/src/proxy/doctor.rs:682-780`).
  - Python 3 (`python3`, `python`, `py -3`, `py`) — внешний интерпретатор для движка скриптов (`src-tauri/src/scripting/python_runner.rs:963-1020`).

### 2.4. Конфигурация, переменные окружения и ключи хранилища

#### Переменные окружения, читаемые в рантайме
1. **Переменные прокси окружения** (`src-tauri/src/proxy/doctor.rs:950-985`, `check_env_proxy_vars`):
   - `HTTP_PROXY`, `http_proxy`, `HTTPS_PROXY`, `https_proxy`, `ALL_PROXY`, `all_proxy`, `NO_PROXY`, `no_proxy` — проверяются диагностикой Proxy Doctor на конфликт с текущим адресом прокси.
2. **Окружение Linux Desktop / XDG** (`src-tauri/src/proxy/sysproxy.rs:845-938`, `src-tauri/src/proxy/ca.rs:462-472`):
   - `XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`, `KDE_FULL_SESSION` — определение GNOME vs KDE для `gsettings`/`kioslaverc`.
   - `XDG_CONFIG_HOME`, `HOME` — поиск пути к `kioslaverc` и `~/.local/share/fluxproxy`.
3. **Переменные дочернего процесса Python** (`src-tauri/src/scripting/python_runner.rs:1087-1089`):
   - Устанавливаются принудительно при спавне воркера: `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, `PYTHONDONTWRITEBYTECODE=1`.

#### Ключи `localStorage` фронтенда (единый реестр)
Фронтенд хранит пользовательские настройки и правила в `window.localStorage` (и синхронизирует серверные части с Rust при старте в `useProxySessions.ts:819-962`):
- Сеть и захват: `fluxproxy.bindMode.v1`, `fluxproxy.specificBindIp.v1`, `fluxproxy.dropNonMatching.v1`, `fluxproxy.retentionLimit.v1`, `fluxproxy.customRetentionLimits.v1`, `fluxproxy.autoEnableSystemProxyOnLoad.v1`, `fluxproxy.upstreamTimeoutSec.v1` (`src/hooks/useProxySessions.ts:154-160`, `src/hooks/useUiPreferences.ts:62-63`).
- Фильтры и списки хостов: `fluxproxy.filterConfig.v2`, `fluxproxy.customFilterPresets.v1`, `fluxproxy.backendFilterConfig.v2`, `fluxproxy.hostFilter.v1` (`src/lib/filterEngine.ts:523-526`, `src/components/HostFiltersTab.tsx:31`).
- Правила, точки останова и скрипты: `fluxproxy.autoResponderRules.v1`, `fluxproxy.breakpointRules.v1`, `fluxproxy.pythonScript.v1`, `fluxproxy.composerHistory.v1` (`src/hooks/useProxySessions.ts:152-153`, `src/lib/settingsManager.ts:74-77`).
- Внешний вид и лейаут: `fluxproxy-theme`, `fluxproxy-theme-preset`, `fluxproxy-custom-palette`, `fluxproxy-custom-palette-enabled`, `fluxproxy.uiPreferences.v1`, `fluxproxy.toolbarSlimMode.v1` (`src/hooks/useTheme.ts:19-22`, `src/hooks/useUiPreferences.ts:60-61`, `public/theme-init.js:5-8`).
- Ключи браузерного симулятора (`BrowserPreviewEngine`): `fluxproxy.preview.storageConfig.v1`, `fluxproxy.preview.clientCerts.v1`, `fluxproxy.preview.pythonScript.v1` (`src/lib/tauriBridge.ts:323-325`).

---

## 3. Архитектура, потоки и контракты

### 3.1. Схема взаимодействия компонентов

```mermaid
graph TD
    subgraph Client_Tier["Клиенты трафика"]
        Browser["Браузер / Приложение / Смартфон"]
    end

    subgraph Frontend_Tier["Frontend (React 19 + TypeScript, WebView)"]
        App["App.tsx"]
        Hook["useProxySessions.ts<br/>(RAF 16ms Batching + Client Filter)"]
        SettingsMgr["settingsManager.ts<br/>(fluxproxy-settings-v1)"]
        Bridge["tauriBridge.ts<br/>(IPC Wrapper / BrowserPreviewEngine)"]
        App --> Hook
        App --> SettingsMgr
        Hook --> Bridge
        SettingsMgr --> Bridge
    end

    subgraph IPC_Boundary["Tauri v2 IPC Boundary"]
        Cmds["commands.rs (59 #[tauri::command])"]
        Events["Tauri Events (proxy://*)"]
    end

    subgraph Rust_Core["Rust Backend Core (src-tauri/src/)"]
        Controller["ProxyController (server.rs)"]
        FilterEng["ProxyFilterEngine (filters.rs)"]
        BPEng["BreakpointEngine (breakpoints.rs)"]
        PyRunner["PythonScriptRunner (python_runner.rs)"]
        RuleEng["RuleEngine / AutoResponder (rules.rs)"]
        CA["CertificateAuthority (ca.rs)"]
        ClientCerts["ClientCertificateStore (client_certs.rs)"]
        Store["TrafficStore (storage/mod.rs)<br/>DashMap RAM + Event Batcher (40ms)"]
        SQLite["SqliteStore (storage/sqlite.rs)<br/>sessions.sqlite (WAL)"]
        ExpImp["Export / Import & Sanitizer<br/>(storage/export_import.rs)"]
        SysProxy["SystemProxyManager (sysproxy.rs)"]
        ProcRes["ProcessResolver (process.rs)"]
        Doctor["ProxyDoctor (doctor.rs)"]
    end

    subgraph External_Tier["Внешние процессы и сеть"]
        PyProc["Дочерний процесс Python 3<br/>(JSONL stdin/stdout)"]
        Upstream["Целевой Upstream-сервер"]
        OS["ОС: Cert Store / WinINet / IpHlpApi"]
    end

    Browser <-->|"HTTP / HTTPS MITM / WS / SSE"| Controller
    Bridge <-->|"invoke()"| Cmds
    Events -->|"listen()"| Bridge
    Cmds --> Controller
    Cmds --> ExpImp
    Controller --> Events
    Controller --> FilterEng
    Controller --> BPEng
    Controller --> PyRunner
    Controller --> RuleEng
    Controller --> CA
    Controller --> ClientCerts
    Controller --> Store
    Controller --> SysProxy
    Controller --> ProcRes
    Controller --> Doctor
    Store <-->|"Eviction & >2MiB Offload"| SQLite
    ExpImp --> Store
    PyRunner <-->|"JSON Lines"| PyProc
    Controller <-->|"reqwest / tokio-tungstenite"| Upstream
    CA --> OS
    SysProxy --> OS
    ProcRes --> OS
    Doctor --> OS
```

### 3.2. Пошаговая трассировка ключевых сквозных сценариев (End-to-End Data Flow)

#### Сценарий 1: Перехват HTTPS-запроса (CONNECT → MITM → Фильтры → Breakpoint → Python → AutoResponder → Upstream → Хранилище → UI)
1. **Приём TCP-соединения и определение процесса:**
   - Цикл `accept` в `ProxyController::start_on_addr` (`src-tauri/src/proxy/server.rs:845-935`) принимает `TcpStream`, берёт `peer_addr`, и для loopback-клиентов вызывает `ProcessResolver::resolve_client_process(peer_addr.port())` (`src-tauri/src/proxy/process.rs:28-55`), определяя имя процесса (например, `chrome.exe (1234)`).
2. **Обработка `CONNECT host:port` и решение о MITM или Passthrough:**
   - `proxy_service` (`src-tauri/src/proxy/server.rs:2125-2258`) перехватывает метод `Method::CONNECT`.
   - Проверяется фильтр захвата по хосту и процессу (`ctx.filters.should_capture_By_host_and_process`) и режим TLS (`ctx.filters.should_intercept_tls(&host)` в `src-tauri/src/proxy/filters.rs:384-456`).
   - **Ветка Passthrough (`should_intercept_tls == false`):** `hyper::upgrade::on(req)` переключает соединение в сырой TCP-туннель `tokio::io::copy_bidirectional` до `(host, port)` (`server.rs:2152-2201`) и записывает в `TrafficStore` синтетическую сессию с бейджем `TUNNEL` (`protocol: "HTTPS Tunnel (Passthrough)"`).
   - **Ветка MITM (`should_intercept_tls == true`):** после `hyper::upgrade::on(req)` вызывается `ctx.ca.get_or_create_leaf_config(&host)` (`src-tauri/src/proxy/ca.rs:202-261`), который возвращает из LRU-кэша (до 1 000 хостов) или генерирует на лету `rustls::ServerConfig` с SAN для домена/IP и ALPN `["h2", "http/1.1"]`. Поверх апгрейднутого потока выполняется `TlsAcceptor::accept`, и запускается внутренний `hyper_util::server::conn::auto::Builder` (`server.rs:2215-2254`), направляющий расшифрованные запросы в `handle_intercepted_request` (`server.rs:2415-3842`).
3. **Встроенный портал и защита от рекурсии:**
   - В начале `handle_intercepted_request` (`server.rs:2456-2478`) проверяется `is_builtin_portal_target(&host, port, ctx.proxy_port)` (`server.rs:4782-4808`). Запросы к `flux.proxy` или к самому прокси обслуживаются локально функцией `serve_builtin_portal` (`server.rs:4810-5055`: страница `/`, скачивание сертификатов `/cert`, `/cert.pem`, `/cert.cer`, `/health`).
4. **Чтение тела запроса и Фаза 1 захвата (In-Flight / Pending):**
   - Тело запроса читается в память через `req.into_body().collect().await` (`server.rs:2560-2575`), при необходимости распаковывается (`maybe_decompress_request_body`, `server.rs:2585`).
   - Применяются **Request Header Mutations** из `ctx.filters.apply_request_header_mutations` (`server.rs:2659-2667`, `filters.rs:480-516`).
   - Вызывается `record_in_flight_session` (`server.rs:2679-2688`, реализация `server.rs:264-357`): выделяется ID через `ctx.store.allocate_id()` (`storage/mod.rs:209-211`), создаётся `CapturedSession` со `status: 0` (`Pending`), сохраняется в `TrafficStore` (`ctx.store.insert_with_id`) и ставится в очередь 40-мс батчера событий `proxy://session-batch`.
5. **Точка останова запроса (Request Breakpoint):**
   - Если `ctx.breakpoints.should_pause_request(&method, &url)` возвращает `true` (`server.rs:2690`, `breakpoints.rs:193-216`), сессия помечается `breakpoint_paused: Some("request")`, в `BreakpointEngine` создаётся `oneshot::channel`, эмитится событие `proxy://breakpoints-changed`, и задача ждёт `bp_rx.await` (до 300 секунд, `server.rs:2728`). Пользователь в UI может продолжить (`Continue` с правками метода/URL/заголовков/тела) или оборвать запрос (`Abort` → `502 Bad Gateway`).
6. **Python-хук `on_request`:**
   - Вызывается `ctx.python_runner.run_on_request(...)` (`server.rs:2812-2923`, `python_runner.rs:1244-1431`).
   - Если скрипт вернул `mock_response` (`outcome.mock_response`), запрос **не идёт в сеть**: применяются мутации заголовков ответа, сессия записывается с `matched_rule: Some("python-script")` и возвращается клиенту (`server.rs:2853-2922`).
7. **AutoResponder:**
   - `ctx.rules.evaluate(&method, &url)` (`server.rs:2925-2986`, `rules.rs:207-237`) проверяет список активных правил по `priority`:
     - `Drop`: возвращает `502 Dropped by FluxProxy AutoResponder`.
     - `Delay`: спит `delay_ms`, затем либо возвращает локальный ответ, либо продолжает запрос к upstream (`forward_after_delay: true`).
     - `Redirect`: возвращает `301/302/307/308` с заголовком `Location`.
     - `Mock`: возвращает синтетический ответ с подстановкой шаблонов.
     - `OverrideStatus`: пропускает запрос к upstream, но подменяет HTTP-статус ответа сервера (`server.rs:3140-3147`).
8. **Обращение к Upstream (с поддержкой mTLS):**
   - `ctx.client_certs.get_or_build_client(&host, &ctx.http_client, ctx.upstream_timeout_sec)` (`server.rs:3000`, `client_certs.rs:845-942`) выбирает стандартный `reqwest::Client` или собирает кэшированный клиент с PKCS#12/PEM-идентичностью для целевого домена.
9. **Потоковая ветка (Zero-Buffering) vs Буферизированная ветка ответа:**
   - После получения заголовков ответа и применения `apply_response_header_mutations` проверяется условие потоковой передачи (`is_sse || is_streaming_media || is_large_non_zstd_without_bp` при `Content-Length > 2 MiB`, `server.rs:3162-3210`).
   - **Для SSE (`text/event-stream`)** и крупных потоков (`server.rs:3212-3489`): чанки проксируются клиенту по мере поступления через `tokio::sync::mpsc::channel(32)`, параллельно парсятся SSE-события (до `MAX_CAPTURED_SSE_EVENTS = 2_000`) и накапливается превью тела (до `MAX_STREAM_CAPTURE_BYTES = 2 MiB`). Хук `on_response` для стримов **не вызывается**.
   - **Для обычных ответов (`server.rs:3508-3838`):** тело читается целиком (`upstream_resp.bytes().await`), распаковывается (`maybe_decompress_zstd` / `reqwest`), проходит через Python-хук `ctx.python_runner.run_on_response(...)` (`server.rs:3572-3660`) и точку останова ответа `should_pause_response` (`server.rs:3663-3729`).
10. **Фаза 2 захвата (Completed) и доставка в UI:**
    - `record_completed_session` (`server.rs:3731-3795`, реализация `server.rs:359-468`) проверяет финальные фильтры захвата (`should_capture_completed_exchange`), и если сессия не отфильтрована (или `drop_non_matching == false`), вызывает `ctx.store.insert_with_id` (`storage/mod.rs:215-315`).
    - Если тело запроса или ответа `> 2 MiB` (`LARGE_BODY_OFFLOAD_THRESHOLD_BYTES`), оно синхронно записывается в таблицу `offloaded_bodies` в SQLite, а в RAM остаётся превью из первых 16 КБ и флаг `body_offloaded = true` (`storage/mod.rs:235-275`).
    - При превышении `retention_limit` старейшие сессии вытесняются из `DashMap` в таблицу `sessions` SQLite (`enforce_retention_limit`, `storage/mod.rs:317-373`).
    - Фоновый воркер `TrafficStore` каждые 40 мс или при накоплении 64 элементов сбрасывает `Vec<SessionSummary>` в событие Tauri `proxy://session-batch` (`storage/mod.rs:108-145`).
    - На фронтенде `useProxySessions` (`src/hooks/useProxySessions.ts:965-971, 761-817`) буферизует входящие сводки в `pendingBatchRef` и сбрасывает их в React-стейт не чаще одного раза за кадр (`requestAnimationFrame` / 16 мс), обновляя `sessions` на месте по `id`.

#### Сценарий 2: Исполнение Python-скрипта (`PythonScriptRunner`)
1. При вызове `set_python_script(code, enabled)` (`src-tauri/src/commands.rs:226-235` → `python_runner.rs:1166-1242`) Rust захватывает `self.worker.lock().await` (`tokio::sync::Mutex`).
2. Если `enabled == false`, дочерний процесс Python убивается (`kill_worker_locked`). Если `enabled == true`, `ensure_worker_locked` ищет интерпретатор Python 3 (`resolve_python_binary`, `python_runner.rs:963-1020`), спавнит `python -u -c PYTHON_WORKER_BOOTSTRAP` и отправляет JSONL-команду `{"cmd": "load_script", "code": "..."}`.
3. Внутри Python-процесса функция `load_user_script` (`python_runner.rs:203-233`) выполняет `compile(code, "<fluxproxy_script>", "exec")` и `exec(compiled, new_ns)`, проверяет `callable(ns.get("on_request"))` и `callable(ns.get("on_response"))` (плюс арность `on_response` через `inspect.signature`) и возвращает `{"ok": true, "has_on_request": ..., "has_on_response": ...}`.
4. На каждом HTTP-запросе/ответе `invoke_worker` (`python_runner.rs:1433-1554`) проверяет атомарные флаги `enabled` и `has_on_request`/`has_on_response` (lock-free fast path!), и только если хук активен, захватывает `self.worker.lock()` с таймаутом `1500 ms` (`hook_timeout_ms`), пишет JSON-строку в `stdin` и ждёт JSON-ответ из `stdout`. При любом таймауте, синтаксической ошибке или падении процесса воркер перезапускается, счётчики `timeout_count`/`restart_count` инкрементируются, логи отправляются в UI через `proxy://script-console-log`, а запрос продолжает движение без изменений (**fail-open**).

#### Сценарий 3: Управление системным прокси ОС и аварийное восстановление (`SystemProxyManager`)
1. При первом включении системного прокси (`SystemProxyManager::enable`, `src-tauri/src/proxy/sysproxy.rs:133-188`) метод `capture_snapshot_if_needed` (`sysproxy.rs:254-308`) считывает текущие настройки прокси ОС (на Windows — `ProxyEnable`, `ProxyServer`, `ProxyOverride`, `AutoConfigURL` из `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`), помечает `dirty = true` и атомарно записывает снимок в `app_data_dir/.sysproxy-recovery.json` (`sysproxy.rs:222-238`).
2. Затем применяются настройки проксирования на `127.0.0.1:<port>` (на Windows — через прямой Win32 FFI `RegSetValueExW` + `InternetSetOptionW(INTERNET_OPTION_SETTINGS_CHANGED)` + `SendMessageTimeoutW(WM_SETTINGCHANGE)` в `sysproxy.rs:985-1097`).
3. При штатном выключении (`disable` или `rollback_if_dirty` из `ProxyController::shutdown_cleanup`, `server.rs:823-842`) исходные значения реестра/ОС восстанавливаются из снимка, а файл `.sysproxy-recovery.json` удаляется (`sysproxy.rs:240-245`).
4. Если приложение было убито через `kill -9` / Task Manager или упало по панике, при следующем старте `SystemProxyManager::new` вызывает `recover_from_crash_journal_if_needed` (`sysproxy.rs:124, 310-372`), обнаруживает оставшийся `.sysproxy-recovery.json` с `dirty == true` и немедленно откатывает настройки ОС к сохранённому до-прокси состоянию.

### 3.3. Управление состоянием, транзакциями и конкурентностью

| Подсистема | Примитив синхронизации | Инварианты и особенности |
| :--- | :--- | :--- |
| **`ProxyController`** (`server.rs:731-764`) | `tokio::sync::Mutex<Option<RunningServer>>`, `AtomicBool` (`capturing`, `strip_alt_svc`), `AtomicU16` (`port`), `AtomicU64` (`upstream_timeout_sec`), `std::sync::RwLock<ProxyBindConfig>` | Перезапуск слушателя (`start_on_addr`, `set_bind_configuration`) сериализован через `running.lock().await`. |
| **`TrafficStore`** (`storage/mod.rs:40-58`) | `DashMap<u64, CapturedSession>` (64 шарда), `AtomicU64` (`next_id`), `AtomicUsize` (`retention_limit`, `approx_ram_bytes`), `std::sync::Mutex<()>` (`eviction_lock`), `tokio::sync::mpsc::UnboundedSender<SessionSummary>` | Чтение/запись сессий в RAM конкурентны через `DashMap`; вытеснение в SQLite сериализуется через `eviction_lock`, но `clear()` и `remove_many()` этот лок не берут (см. `[BUG-11]`). |
| **`SqliteStore`** (`storage/sqlite.rs:10-16`) | `std::sync::Mutex<rusqlite::Connection>` | Единое соединение SQLite в режиме `WAL` (`synchronous = NORMAL`). Все операции к БД блокируют вызывающий поток ОС до получения мьютекса. |
| **`ProxyFilterEngine`** (`filters.rs:342-345`) | `std::sync::RwLock<FilterEngineState>` + `AtomicU64` (`dropped_sessions_count`) | Читается на каждом HTTP-запросе и каждом `CONNECT`-туннеле через `.read()`. |
| **`RuleEngine` / `BreakpointEngine`** (`rules.rs:88`, `breakpoints.rs:64-67`) | `std::sync::RwLock<Vec<...>>` + `DashMap<u64, PendingBreakpoint>` | В `RuleEngine` и `BreakpointEngine` регулярные выражения предкомпилируются при записи правил (`CompiledRule`, `CompiledBreakpointRule`). |
| **`CertificateAuthority`** (`ca.rs:71-79`) | `std::sync::Mutex<LruCertCache>` | Кэширует до `MAX_CACHED_CERTS = 1_000` сгенерированных `Arc<ServerConfig>` с вытеснением по LRU. |
| **`ClientCertificateStore`** (`client_certs.rs:444-449`) | `std::sync::RwLock<ClientCertState>` + `DashMap<String, CachedClientEntry>` | Кэширует собранные `reqwest::Client` по ключу `(cert_id, timeout_sec)`. |
| **`PythonScriptRunner`** (`python_runner.rs:599-612`) | `tokio::sync::Mutex<Option<PythonWorkerProcess>>`, `std::sync::RwLock<ScriptConfigState>`, `AtomicBool` (`enabled`, `has_on_request`, `has_on_response`) | Все вызовы хуков сериализуются через единственный `tokio::sync::Mutex` к одному дочернему процессу Python (см. `[PERF-04]`). |

### 3.4. Стратегия обработки ошибок, логирования и валидации
- **На границе Tauri IPC (`src-tauri/src/commands.rs:1-838`):** все асинхронные и синхронные команды возвращают `Result<T, String>`. Внутренние ошибки (`anyhow::Result`, `rusqlite::Error`, `io::Error`) преобразуются в человекочитаемые строки через `.map_err(|e| e.to_string())`.
- **В прокси-пайплайне (`src-tauri/src/proxy/server.rs`):** ошибки подключения к upstream или таймауты не роняют процесс прокси, а преобразуются в синтетический HTTP-ответ `502 Bad Gateway` с JSON-описанием ошибки и записываются в `TrafficStore`, чтобы разработчик видел неудавшийся запрос в таблице (`server.rs:3040-3105`).
- **В Python Scripting Engine (`python_runner.rs`):** реализована строгая стратегия **Fail-Open** — любая ошибка компиляции, исключение внутри `on_request`/`on_response`, некорректный тип поля или таймаут (`1500 ms`) логируются в `proxy://script-console-log` и возвращают исходный немодифицированный запрос/ответ.
- **Логирование:** в Rust-ядре нет `tracing` или `log` крейта — диагностический вывод ведётся точечно через `eprintln!` (`storage/mod.rs:94`, `server.rs:2251`) и специализированные Tauri-события (`proxy://script-console-log`).

---

## 4. Руководство для ИИ-агента (AI Agent Playbook)

### 4.1. Конвенции проекта
1. **Сериализация контрактов Rust ↔ TypeScript (`camelCase`):**
   - Все структуры в `src-tauri/src/models.rs`, `src-tauri/src/proxy/*.rs` и `src-tauri/src/scripting/python_runner.rs`, передаваемые через Tauri IPC или события, обязаны иметь атрибут `#[serde(rename_all = "camelCase")]` (или явные `#[serde(rename = "...")]`).
   - Зеркальные TypeScript-интерфейсы находятся в `src/types/proxy.ts` и `src/types/settings.ts`.
2. **Дуализм Tauri IPC и Browser Preview Simulator:**
   - Каждая новая Tauri-команда, добавленная в `src-tauri/src/commands.rs` и зарегистрированная в `tauri::generate_handler![...]` (`src-tauri/src/lib.rs:101-163`), **должна** быть обёрнута в `proxyBridge` (`src/lib/tauriBridge.ts:2493-3371`) с реализацией фолбэка в `BrowserPreviewEngine` (`src/lib/tauriBridge.ts:319-2491`), чтобы интерфейс не падал при запуске `npm run dev` в обычном браузере.
3. **Персистентность настроек:**
   - Rust-ядро при старте инициализирует правила, фильтры, точки останова и скрипты значениями по умолчанию в памяти (кроме `storage-config.json` и `client_certs/registry.json`). Источником правды для пользовательских настроек выступает `localStorage` фронтенда, который при загрузке `useProxySessions` (`src/hooks/useProxySessions.ts:819-962`) пушит сохранённую конфигурацию в Rust через IPC, а также единый профиль экспорта/импорта `fluxproxy-settings-v1` в `src/lib/settingsManager.ts`.
4. **Отсутствие консольных окон на Windows:**
   - При любом вызове `std::process::Command` или `tokio::process::Command` на Windows обязательно устанавливать `.creation_flags(0x08000000)` (`CREATE_NO_WINDOW`), иначе у пользователя поверх GUI будут вспыхивать чёрные окна `cmd.exe` / `python.exe` (см. `ca.rs:41-55`, `python_runner.rs:1091-1095`, `network.rs:69`).

### 4.2. Жёсткие инварианты (Do Not Break)
1. **Двухфазный захват сессий (один и тот же `id` для `Pending` и `Completed`):**
   - `record_in_flight_session` (`src-tauri/src/proxy/server.rs:264-357`) выделяет `session_id = ctx.store.allocate_id()` и эмитит сводку со `status: 0`. Когда ответ получен, `record_completed_session` (`server.rs:359-468`) обязан вызывать `ctx.store.insert_with_id(session_id, ...)` с **тем же самым `session_id`** и сохранять пользовательские `marked_color` и `note`, если пользователь успел пометить запрос, пока он был `Pending` (`server.rs:378-383`).
2. **Синхронность двухуровневой фильтрации (Backend Capture Filter ↔ Frontend Display Filter):**
   - Логика фильтрации хостов (`rawText`, `mode: "blacklist" | "whitelist"`), категорий, матрицы условий (`FilterRule`) и шумовых порогов дублируется на Rust (`src-tauri/src/proxy/filters.rs`) и на TypeScript (`src/lib/filterEngine.ts`). При изменении синтаксиса правил или нормализации хостов правки необходимо синхронно вносить в оба файла.
3. **Журнал аварийного восстановления системного прокси (`.sysproxy-recovery.json`):**
   - Никогда не изменяйте системный прокси ОС в обход `SystemProxyManager::enable` / `disable` / `rollback_if_dirty` (`src-tauri/src/proxy/sysproxy.rs:133-220`). Перед любой модификацией настроек ОС на диске обязан существовать актуальный `.sysproxy-recovery.json` с исходным состоянием (`capture_snapshot_if_needed`).
4. **Контракт протокола JSON Lines в `PythonScriptRunner`:**
   - Bootstrap-скрипт Python (`src-tauri/src/scripting/python_runner.rs:34-345`) перенаправляет `sys.stdout = sys.stderr` на время выполнения пользовательского кода (`with _contextlib.redirect_stdout(sys.stderr):`), чтобы `print()` в скрипте пользователя не попал в `stdout`-пайп и не сломал JSONL-протокол между Rust и Python. Никогда не пишите в настоящий `_PROTO_STDOUT` ничего, кроме однострочного JSON с `\n`.
5. **Автоматическая коррекция `Content-Length` и `Content-Encoding` после распаковки и модификации тела:**
   - Буферизированные ответы от `reqwest` и `maybe_decompress_zstd` в `handle_intercepted_request` (`src-tauri/src/proxy/server.rs:3508-3818`) уже распакованы. Если тело было распаковано или изменено Python-скриптом / точкой останова, исходный `Content-Encoding` и старый `Content-Length` не соответствуют байтам тела и должны синхронно пересчитываться.

### 4.3. Подводные камни (Footguns & Gotchas)
1. **Зависимость `useEffect` загрузки деталей сессии от `sessions.length` (`src/hooks/useProxySessions.ts:1128-1156`):**
   - В массив зависимостей `useEffect`, вызывающего `proxyBridge.getSessionDetail(selectedId)`, включён `sessions.length`. Это приводит к повторному IPC-запросу деталей выбранной сессии при каждом новом перехваченном запросе (подробнее в `[PERF-01]`).
2. **Сброс `next_id = 1` при перезапуске поверх существующей `sessions.sqlite` (`src-tauri/src/storage/mod.rs:76`):**
   - `TrafficStore::new` инициализирует `next_id: AtomicU64::new(1)`, не читая `MAX(id)` из `sessions.sqlite`. При этом `load_session_body` и `extract_raw_body_bytes` сначала ищут тело в SQLite `offloaded_bodies` по `id` (подробнее в `[BUG-01]`).
3. **Различие проверки ведущих точек `.example.com` в `filters.rs`:**
   - В `compile_backend_host_list` (`src-tauri/src/proxy/filters.rs:986-1015`) и `compile_capture_host_list` (`filters.rs:1438-1470`) функция `host_has_wildcard(pattern)` проверяет только символы `*` и `?`. Ветка `pattern.strip_prefix('.')` находится *внутри* блока `if host_has_wildcard(&pattern)` и поэтому является мёртвым кодом для шаблонов вида `.example.com` без звёздочки (подробнее в `[BUG-09]`).
4. **Потеря дублирующихся заголовков при чтении в Python-скрипте (`src-tauri/src/scripting/python_runner.rs:56-65`):**
   - В `_normalize_headers_in` входной список пар `[[Name, Value], ...]` сворачивается в плоский Python `dict[str, str]`, где при наличии нескольких одноимённых заголовков (например, двух `Set-Cookie`) в словаре `headers` остаётся только **последнее** значение. Если скрипт не трогает этот ключ, `_diff_headers` сохранит оба заголовка в Rust, но если скрипт прочитает и перезапишет `response["headers"]["Set-Cookie"]`, первый `Set-Cookie` будет потерян.
5. **Безусловная инициализация `BrowserPreviewEngine` даже в нативном Tauri (`src/lib/tauriBridge.ts:2491`):**
   - Строка `const previewEngine = new BrowserPreviewEngine();` выполняется на верхнем уровне модуля при импорте `tauriBridge.ts` независимо от `isTauriRuntime()`, запуская `setInterval` на 1800 мс и генерируя фейковые сессии в памяти даже в десктопном приложении (`[PERF-05]`).

### 4.4. Рецепты изменений (How-To для ИИ-агента)

#### Рецепт А: Как добавить новую Tauri IPC-команду
1. **Модели данных (если нужны новые типы):**
   - Добавьте Rust-структуру с `#[derive(Debug, Clone, Serialize, Deserialize)]` и `#[serde(rename_all = "camelCase")]` в `src-tauri/src/models.rs` (или профильный модуль `proxy/*.rs`).
   - Добавьте зеркальный TypeScript-интерфейс в `src/types/proxy.ts`.
2. **Реализация в Rust:**
   - Добавьте метод в `ProxyController` (`src-tauri/src/proxy/server.rs`) или соответствующую подсистему (`TrafficStore`, `CertificateAuthority` и т.д.).
   - Объявите `#[tauri::command] pub async fn my_command(state: State<'_, Arc<ProxyController>>, ...) -> Result<MyResponse, String>` в `src-tauri/src/commands.rs`.
   - Зарегистрируйте `commands::my_command` в макросе `tauri::generate_handler![...]` в `src-tauri/src/lib.rs:101-163`.
3. **Обёртка на фронтенде:**
   - Добавьте метод в `BrowserPreviewEngine` (`src/lib/tauriBridge.ts`) для поддержки браузерного превью.
   - Экспортируйте метод в объекте `proxyBridge` (`src/lib/tauriBridge.ts:2493-3371`) с ветвлением `if (!isTauriRuntime()) return previewEngine.myCommand(...); return invoke<MyResponse>("my_command", { ... });`.
4. **Тесты:**
   - Добавьте Rust unit-тест в `#[cfg(test)] mod tests` соответствующего модуля и Vitest-тест в `src/lib/__tests__/`.

#### Рецепт Б: Как добавить новую опцию конфигурации в профиль настроек (`fluxproxy-settings-v1`)
1. Расширьте интерфейс `FluxProxySettingsProfile` (и при необходимости `SettingsImportPreviewSummary`) в `src/types/settings.ts`.
2. В `src/lib/settingsManager.ts`:
   - Добавьте ключ `localStorage` в `SETTINGS_STORAGE_KEYS` (`settingsManager.ts:62-95`).
   - Обновите `collectCurrentSettingsProfile` (`settingsManager.ts:1995-2100`), валидатор/нормализатор при импорте, `buildSettingsImportPreview` (`settingsManager.ts:2237-2317`), `applySettingsProfile` (`settingsManager.ts:2495-2630`) и `resetAllSettingsToDefaults` (`settingsManager.ts:2635-2750`).
3. Добавьте покрытие в `src/lib/__tests__/settingsManager.test.ts`.

#### Рецепт В: Как подготовить релиз новой версии
- Следуйте встроенному навыку `.agents/skills/fluxproxy-release/SKILL.md`: синхронно обновите версию в 5 файлах (`package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`) и ссылки/бейджи в `README.md`, `ROADMAP.md`, `USER_GUIDE.md`.

### 4.5. Расхождения документации и фактической реализации кода

| № | Утверждение в документации | Где написано | Фактическая реализация в коде | Где в коде |
| :- | :--- | :--- | :--- | :--- |
| 1 | На macOS установка Root CA добавляет сертификат в **System Keychain** (`/Library/Keychains/System.keychain`). | `README.md:299` | Фактически `install_ca_macos` устанавливает сертификат в пользовательский **Login Keychain** (`~/Library/Keychains/login.keychain-db`) командой `security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db`. | `src-tauri/src/proxy/ca.rs:522-537` |
| 2 | Очистка и сжатие базы SQLite (`Purge SQLite Archive / VACUUM`) удаляет старые записи с диска, **«не трогая текущие сессии в RAM»**. | `USER_GUIDE.md:186` | `clear_sqlite_archive` вызывает `purge_and_vacuum`, который выполняет `DELETE FROM offloaded_bodies`. Все активные сессии в RAM с телом `> 2 MiB` (`body_offloaded: true`) хранят своё полное тело именно в `offloaded_bodies` и после `VACUUM` безвозвратно теряют тела запросов/ответов. | `src-tauri/src/storage/mod.rs:162-169`, `src-tauri/src/storage/sqlite.rs:380-397` |
| 3 | В Этапе 28 (`ROADMAP.md`) операции SQLite и компиляция Regex были вынесены из горячего пути (`hot-path`) обработки запросов. | `ROADMAP.md:48` | 1) `record_in_flight_session` и `record_completed_session` вызываются синхронно прямо из async-задач Tokio (`server.rs:2680, 3732`) и блокируют воркер на `Mutex<rusqlite::Connection>` при вытеснении, оффлоаде `> 2 MiB` и даже при `ctx.store.get(new_session_id)` (`server.rs:319`).<br/>2) В `ProxyFilterEngine` (`filters.rs:707, 723, 751`) `Regex::new` по-прежнему компилируется заново на каждом `CONNECT` и HTTP-запросе внутри `state.read()`. | `src-tauri/src/proxy/server.rs:319, 2680, 3732`, `src-tauri/src/proxy/filters.rs:701-754` |
| 4 | В `vite.config.ts` настроено разделение бандла (`manualChunks`) на `monaco-editor`, `react-vendor` и **`ui-vendor`**. | `ROADMAP.md:63` | Третий чанк в `vite.config.ts` фактически называется **`tauri-ui`**, а не `ui-vendor`. | `vite.config.ts:52` |
| 5 | Оценка размеров God-модулей в техдолге `ROADMAP.md`: `server.rs` (~6.9k строк), `App.tsx` (~2.9k строк), `FilterDrawer.tsx` (~2.2k строк). | `ROADMAP.md:97` | Фактические размеры файлов существенно выросли: `server.rs` — **7 759** строк, `export_import.rs` — **4 053** строки, `FilterDrawer.tsx` — **3 820** строк, `App.tsx` — **3 747** строк, `SettingsModal.tsx` — **3 599** строк. | `src-tauri/src/proxy/server.rs`, `src/App.tsx`, `src/components/FilterDrawer.tsx` |
| 6 | Клиентские сертификаты mTLS (`.p12`/`.pfx`/`.pem`) хранятся защищённо в `app_data_dir/client_certs` с правами `0600`. | `README.md:76`, `ROADMAP.md:69` | 1) Защищённый паролем `.p12`/`.pfx` при импорте расшифровывается, и его приватный ключ сохраняется на диск **в открытом виде (unencrypted PEM)** в `{id}.identity.pem`.<br/>2) Права `0600` выставляются только под `#[cfg(unix)]`; на Windows функция `write_bytes_securely` выполняет обычный `fs::write` без ограничения NTFS ACL или DPAPI. | `src-tauri/src/proxy/client_certs.rs:89-92, 640-652` |
| 7 | Документация Python Scripting Engine описывает сохранение неизменённых дублирующихся заголовков и конвейер запросов, не упоминая исключения. | `PYTHON_SCRIPTING_GUIDE.md:98-138, 235` | 1) Запросы из **Request Composer** (`execute_composed`, `server.rs:1544-2122`) полностью обходят `PythonScriptRunner` (ни `on_request`, ни `on_response` для них не вызываются), хотя проходят через Breakpoints, AutoResponder и Header Mutations.<br/>2) При чтении `request["headers"]` / `response["headers"]` в Python дублирующиеся заголовки схлопываются до последнего значения (`_normalize_headers_in`, `python_runner.rs:56-65`). | `src-tauri/src/proxy/server.rs:1544-2122`, `src-tauri/src/scripting/python_runner.rs:56-65` |

---

## 5. Аудит кода: ошибки, риски и узкие места

### 5.1. Сводная таблица всех обнаруженных проблем (25 находок)

| ID | Severity | Категория | Файл:Строки | Краткое описание |
| :--- | :---: | :--- | :--- | :--- |
| **`BUG-01`** | **Critical** | Баги и логика / Потеря данных | `src-tauri/src/storage/mod.rs:76, 375-391, 754-780, 807-825`, `src-tauri/src/proxy/server.rs:319-324` | Сброс `next_id = 1` при старте поверх существующей `sessions.sqlite` подмешивает старые выгруженные тела (`> 2 MiB`) и заметки к новым сессиям и перезаписывает архив. |
| **`SEC-01`** | **Critical** | Безопасность (RCE) | `src/lib/settingsManager.ts:2237-2317, 2538-2545, 2602`, `src-tauri/src/scripting/python_runner.rs:203-209` | Импорт профиля настроек `fluxproxy-settings-v1.json` скрыто активирует и исполняет произвольный Python-код (`exec`) с правами пользователя без отображения в превью импорта. |
| **`SEC-02`** | **Critical** | Безопасность (Path Traversal / File Write) | `src-tauri/src/commands.rs:573-638, 641-776`, `src-tauri/src/storage/export_import.rs:823-829, 2918-2925` | `validate_user_file_path` проверяет только последний сегмент пути; `save_session_body_file` не ограничивает расширения и создаёт директории, позволяя перезаписать любой файл на диске. |
| **`BUG-02`** | **High** | Баги и логика / Отказ UI | `src/hooks/useProxySessions.ts:819-1052` | Отсутствие `try/catch` в `bootstrap()` вокруг стартовых IPC-вызовов (например, `setBindConfiguration`) навсегда блокирует регистрацию всех Tauri Event-подписок (`proxy://*`). |
| **`BUG-03`** | **High** | Баги и логика / Потеря данных | `src-tauri/src/storage/mod.rs:162-169`, `src-tauri/src/storage/sqlite.rs:380-397` | `clear_sqlite_archive` (`Purge SQLite Archive / VACUUM`) очищает таблицу `offloaded_bodies`, безвозвратно уничтожая тела (`> 2 MiB`) активных сессий, оставшихся в RAM. |
| **`BUG-04`** | **High** | Конкурентность и утечки ресурсов | `src-tauri/src/proxy/breakpoints.rs:228-241`, `src-tauri/src/proxy/server.rs:1618-1663, 2690-2745, 3663-3729` | Утечка `PendingBreakpoint` в `DashMap` и вечно висящая сессия `WAIT` при обрыве клиентского соединения во время паузы на точке останова или при `Abort` в Composer. |
| **`BUG-05`** | **High** | Конкурентность / Сеть | `src-tauri/src/proxy/server.rs:3881, 4061-4108`, `src-tauri/Cargo.toml:41` | Взаимная блокировка (deadlock) двунаправленного релея WebSocket при встречной отправке крупных фреймов + отсутствие таймаута подключения, системных корней ОС и mTLS для `wss://`. |
| **`BUG-06`** | **High** | Баги и логика / TLS | `src-tauri/src/proxy/ca.rs:317-347` | Ложноположительный статус доверия Root CA на Windows и macOS: проверка ищет только совпадение текстового `Common Name`, не сверяя SHA-256 отпечаток сертификата. |
| **`BUG-07`** | **High** | Баги и логика / Протокол HTTP | `src-tauri/src/proxy/server.rs:204-247, 3801-3814, 4705-4721` | Искажение трафика на проводе: удаление `Content-Length` у `HEAD`-ответов, безусловное удаление `Content-Encoding` при многослойном/неизвестном сжатии и замена бинарных заголовков на `"<binary>"`. |
| **`SEC-03`** | **High** | Безопасность (Network / SSRF / mTLS) | `src-tauri/src/proxy/server.rs:517-585, 2152-2162, 2447-2453, 2999-3028, 4782-4808` | В режимах `AllInterfaces`/`Specific` прокси работает без аутентификации, открывает LAN-клиентам TCP-туннели к `127.0.0.1` хоста, прикрепляет хозяйские mTLS-ключи и позволяет обойти `TargetedOnly` подменой `Host`. |
| **`SEC-04`** | **High** | Безопасность (Утечка PII/секретов) | `src-tauri/src/storage/export_import.rs:962-969, 1014-1329`, `src-tauri/src/storage/mod.rs:1003-1013`, `src-tauri/src/models.rs:468-485` | Санитизированный экспорт (`sanitize: true`) оставляет в открытом виде сырые тела SSE-потоков, фреймы WebSocket в `response_body_text`, `camelCase`-ключи JSON (`accessToken`, `apiKey`), `#fragment` и `Location`. |
| **`SEC-05`** | **High** | Безопасность / DoS (OOM) | `src-tauri/src/storage/export_import.rs:672, 2202-2203, 2434-2504`, `src-tauri/src/proxy/server.rs:213-247, 1921, 3222-3273, 3508`, `src-tauri/src/proxy/codec.rs:44-92` | Отсутствие кумулятивного лимита при HTTP-декомпрессии `.saz` и отсутствие лимитов буферизации chunked/zstd ответов в прокси, Composer и TextWizard приводят к OOM-крашу. |
| **`PERF-01`** | **High** | Производительность (Frontend IPC) | `src/hooks/useProxySessions.ts:1128-1156` | Лишняя зависимость `sessions.length` в `useEffect` вызывает повторный IPC-запрос `getSessionDetail(selectedId)` на каждый новый перехваченный запрос (до 60 раз/сек). |
| **`PERF-02`** | **High** | Производительность (Async Runtime) | `src-tauri/src/storage/mod.rs:215-373`, `src-tauri/src/proxy/server.rs:272, 292, 319, 378` | Блокирующий синхронный ввод-вывод SQLite (`Mutex<Connection>`) и полная сортировка 10 000 ключей `DashMap` (`O(N log N)`) выполняются прямо на async-воркерах Tokio на каждом запросе. |
| **`PERF-03`** | **High** | Производительность (Hot-Path CPU) | `src-tauri/src/proxy/filters.rs:417, 531, 701-754, 1153` | Перекомпиляция `Regex::new` внутри `RwLock::read()` на каждом `CONNECT`-туннеле и HTTP-запросе из-за дефолтных масок `ocsp.*, crl.*` в `ProxyFilterEngine`. |
| **`BUG-08`** | **Medium** | Баги и логика (React State) | `src/hooks/useProxySessions.ts:768-800` | Быстрый путь `prev.length === 0` в `flushPendingSessions` пропускает дедупликацию `indexById`, создавая дубликаты одного `session.id` в пустой таблице. |
| **`BUG-09`** | **Medium** | Баги и логика (Фильтрация и IPv6) | `src-tauri/src/proxy/filters.rs:620, 639, 693, 986-1015, 1438-1470`, `src-tauri/src/proxy/server.rs:4693-4703` | Мёртвый код `.strip_prefix('.')` в `compile_backend_host_list` / `compile_capture_host_list` ломает суффиксные правила `.example.com`; `split_authority` и `normalize_host_token` некорректно парсят IPv6 (`[::1]`). |
| **`BUG-10`** | **Medium** | Конкурентность и состояние | `src-tauri/src/proxy/server.rs:1158-1308` | `set_bind_configuration` не откатывает системный прокси ОС при двойной ошибке бинда (`rollback_if_dirty`) и не отправляет событие `proxy://status-changed`. |
| **`BUG-11`** | **Medium** | Конкурентность (Storage/SQLite) | `src-tauri/src/storage/mod.rs:346-372, 441-451, 518-643, 697-721`, `src-tauri/src/storage/sqlite.rs:36-39` | Удаление сессий из RAM до проверки успеха `sqlite.persist_batch`, гонки `clear()`/`remove_many()`/`annotate_session` без `eviction_lock` и порядок `PRAGMA busy_timeout`. |
| **`BUG-12`** | **Medium** | Баги и логика (Экспорт/Импорт) | `src-tauri/src/storage/export_import.rs:1999, 2484-2504, 2558-2586` | Паника переполнения `chrono::Duration::milliseconds` при экспорте `.saz` для импортированных HAR-сессий и отсутствие поддержки `zstd` в SAZ/Raw декодере. |
| **`BUG-13`** | **Medium** | Тестирование / Гонка в тестах | `src-tauri/src/proxy/doctor.rs:88, 1078-1128` | Flaky-падение теста `doctor_detects_stopped_port_and_fixes_listener_plus_e2e_health` при параллельном `cargo test` из-за TOCTOU-гонки за эфемерный порт при `retry_attempts = 1`. |
| **`SEC-06`** | **Medium** | Безопасность (Хранение ключей) | `src-tauri/src/proxy/client_certs.rs:61-108, 519-526, 640-652, 735-750`, `src-tauri/src/proxy/ca.rs:127-163` | Сохранение расшифрованных приватных ключей из парольных `.p12`/`.pfx` в открытый `{id}.identity.pem`, отсутствие защиты ACL/DPAPI на Windows и непроверенный `stored_cert_path`. |
| **`PERF-04`** | **Medium** | Производительность (Python Engine) | `src-tauri/src/scripting/python_runner.rs:601, 1264, 1452` | Head-of-Line блокировка всего трафика на единственном `tokio::sync::Mutex<Option<PythonWorkerProcess>>` при параллельных запросах. |
| **`PERF-05`** | **Medium** | Производительность (Bundle & Startup) | `src/lib/tauriBridge.ts:336-348, 954-962, 2491`, `src/main.tsx:1`, `src/lib/monaco.ts:1-13` | Безусловное создание `BrowserPreviewEngine` (с таймером 1800 мс) в нативном Tauri и ранняя загрузка 7.05 МБ `ts.worker` / 4.62 МБ `monaco-editor` при старте приложения. |
| **`PERF-06`** | **Low** | Производительность и ресурсы | `src-tauri/src/storage/mod.rs:475-496, 754-780`, `src-tauri/src/storage/sqlite.rs:51-52`, `src-tauri/src/proxy/process.rs:15-18, 414-436` | N+1 запросы в SQLite для пустых тел (`GET`), неиспользуемые индексы `idx_sessions_url`/`status`, неограниченный `pid_name_cache` и спавн `lsof` на каждое соединение на macOS. |
| **`ARCH-01`** | **Low** | Архитектурный техдолг | `src-tauri/src/proxy/server.rs`, `src-tauri/src/storage/export_import.rs`, `src/App.tsx`, `src/components/FilterDrawer.tsx` и др. | Концентрация логики в 11 сверхкрупных God-модулях (от 2 200 до 7 759 строк) и дублирование логики фильтрации/парсинга между Rust и TypeScript. |

*(Примечание: 25 уникальных карточек `BUG-01..13`, `SEC-01..06`, `PERF-01..06` + архитектурная карточка `ARCH-01` — всего 26 детальных карточек ниже).*

---

### 5.2. Категория 1: Баги и логические ошибки

#### `[BUG-01] [Severity: Critical]` Сброс счётчика `next_id = 1` при старте приложения поверх существующей `sessions.sqlite` приводит к подмешиванию чужих тел (`> 2 MiB`), заметок и перезаписи архива
- **Локация:**
  - `src-tauri/src/storage/mod.rs:73-83` (`TrafficStore::new`)
  - `src-tauri/src/storage/mod.rs:375-391` (`TrafficStore::load_session_body`)
  - `src-tauri/src/storage/mod.rs:754-780` (`TrafficStore::get_hydrated`)
  - `src-tauri/src/storage/mod.rs:807-825` (`TrafficStore::extract_raw_body_bytes`)
  - `src-tauri/src/proxy/server.rs:319-324` (`record_in_flight_session`)
  - `src-tauri/src/storage/sqlite.rs:98` (`SqliteStore::persist_batch`)
- **Доказательство (Evidence):**
  1. В `TrafficStore::new` (`src-tauri/src/storage/mod.rs:76`) счётчик ID всегда инициализируется единицей:
     ```rust
     next_id: AtomicU64::new(1),
     ```
     При этом `sessions.sqlite` по умолчанию сохраняется между запусками (`clear_db_on_exit: false` в `storage/mod.rs:33`).
  2. В `load_session_body` (`storage/mod.rs:380`) и `extract_raw_body_bytes` (`storage/mod.rs:812`) запрос в SQLite `offloaded_bodies` выполняется **до** обращения к RAM и без проверки флага `detail.body_offloaded`:
     ```rust
     if let Some(ref sqlite) = self.sqlite {
         if let Ok(Some(bytes)) = sqlite.load_offloaded_body(id, is_response) {
             return Some(bytes);
         }
     }
     ```
  3. В `get_hydrated` (`storage/mod.rs:759, 768`) чтение из `offloaded_bodies` срабатывает для любой сессии в RAM, у которой `request_body_base64.is_empty()` (то есть для **каждого** обычного `GET`-запроса!).
  4. В `record_in_flight_session` (`server.rs:319-324`) при создании новой сессии вызывается `ctx.store.get(new_session_id)`: если `new_session_id` отсутствует в RAM, `store.get()` (`storage/mod.rs:413-421`) читает старую сессию с таким же `id` из SQLite и копирует её `marked_color` и `note` в новый запрос.
- **Сценарий проявления и влияние (Impact):**
  1.В сеансе №1 пользователь перехватывает трафик; сессия `#5` имела POST-тело `> 2 MiB` (сохранено в `offloaded_bodies` с `session_id = 5`), а сессия `#12` была вытеснена в таблицу `sessions` с заметкой `"PROD BUG"`.
  2. Пользователь перезапускает FluxProxy. Счётчик `next_id` снова стартует с `1`.
  3. Новый `GET`-запрос `#5` при экспорте в HAR/SAZ (`get_hydrated` / `extract_raw_body_bytes`) или при вызове `load_session_body` молча получает 5-мегабайтное тело от старого POST-запроса из прошлого запуска.
  4. Новый запрос `#12` автоматически наследует чужую цветовую метку и заметку `"PROD BUG"`, а при последующем вытеснении перезаписывает архивную запись `#12` в SQLite через `INSERT OR REPLACE INTO sessions` (`sqlite.rs:98`).
- **Рекомендация по исправлению (Fix):**
  1. В `SqliteStore::new` добавить метод `max_session_id(&self) -> rusqlite::Result<u64>`, выполняющий:
     ```sql
     SELECT COALESCE(MAX(m), 0) FROM (
         SELECT MAX(id) AS m FROM sessions
         UNION ALL
         SELECT MAX(session_id) AS m FROM offloaded_bodies
     );
     ```
     и инициализировать `next_id: AtomicU64::new(max_id + 1)` в `TrafficStore::new`.
  2. В `load_session_body`, `get_hydrated` и `extract_raw_body_bytes` сначала проверять сессию в RAM и обращаться к `offloaded_bodies` только тогда, когда `detail.body_offloaded == true` и соответствующее поле в RAM пусто.
  3. В `record_in_flight_session` (`server.rs:319`) заменить `ctx.store.get(new_session_id)` на проверку только в RAM (`ctx.store.get_in_ram(new_session_id)`), исключив ложный поиск новой сессии в архивной БД.

---

#### `[BUG-02] [Severity: High]` Необработанное отклонение промиса в `useProxySessions` `bootstrap()` навсегда оставляет интерфейс без Tauri Event-подписок
- **Локация:** `src/hooks/useProxySessions.ts:819-1052` (`useEffect` → `bootstrap`)
- **Доказательство (Evidence):**
  В `bootstrap()` (`src/hooks/useProxySessions.ts:819-962`) последовательно выполняются `await proxyBridge.getStatus()`, `await proxyBridge.setBindConfiguration(...)`, `await proxyBridge.updateRules(...)`, `await proxyBridge.setBreakpoints(...)`, `await proxyBridge.setCapturing(...)` **без единого блока `try / catch`** (кроме локального `try` вокруг `setPythonScript` на строках `946-957`). Регистрация всех реактивных слушателей событий (`proxyBridge.subscribeSessionBatches`, `subscribeSessionsRemoved`, `subscribeBreakpointsChanged`, `subscribeStatusChanged`, `subscribeStorageStatsChanged`) расположена в конце `bootstrap()` на строках `964-1050`, а сам вызов `void bootstrap();` (`1052`) игнорирует `Promise` rejection.
- **Сценарий проявления и влияние (Impact):**
  Если пользователь в прошлой сессии выбрал режим привязки `Specific` к LAN IP (например, `192.168.1.55`), а при следующем запуске ноутбук подключён к другой Wi-Fi сети, вызов `await proxyBridge.setBindConfiguration("specific", "192.168.1.55")` на строке `842` выбрасывает ошибку (`AddrNotAvailable`). Выполнение `bootstrap()` аварийно прерывается на строке `842`, ни одна подписка на события `proxy://*` не регистрируется, и таблица трафика остаётся мёртвой на всё время работы приложения, даже если переключить интерфейс в настройках.
- **Рекомендация по исправлению (Fix):**
  1. Вынести регистрацию всех подписок `subscribe*` (`964-1050`) в начало `bootstrap()` до выполнения конфигурационных IPC-вызовов (или в отдельный независимый `useEffect`).
  2. Обернуть каждый стартовый IPC-вызов (`setBindConfiguration`, `setUpstreamTimeout`, `setRetentionLimit`, `updateRules`, `setBreakpoints`, `setCapturing`) в индивидуальный `try / catch` с выводом уведомления `showToast(..., "error")` и безопасным откатом (например, к `127.0.0.1` при недоступности сохранённого `specificBindIp`).

---

#### `[BUG-03] [Severity: High]` Очистка архива SQLite (`clear_sqlite_archive` / `VACUUM`) безвозвратно удаляет тела (`> 2 MiB`) активных сессий, находящихся в RAM
- **Локация:**
  - `src-tauri/src/storage/mod.rs:162-169` (`TrafficStore::clear_sqlite_archive`)
  - `src-tauri/src/storage/sqlite.rs:380-397` (`SqliteStore::purge_and_vacuum`)
- **Доказательство (Evidence):**
  При вставке любой сессии с телом запроса или ответа `> 2 MiB` метод `TrafficStore::insert_with_id` (`storage/mod.rs:235-275`) сразу выгружает полное тело в таблицу SQLite `offloaded_bodies`, оставляя в оперативной памяти (`self.sessions`) только 16-килобайтное превью и флаг `detail.body_offloaded = true`.
  Однако когда пользователь нажимает в статус-баре кнопку `Purge SQLite Archive (VACUUM)`, вызывается `clear_sqlite_archive` → `sqlite.purge_and_vacuum()`, который безусловно выполняет (`sqlite.rs:386-389`):
  ```sql
  DELETE FROM sessions;
  DELETE FROM offloaded_bodies;
  ```
- **Сценарий проявления и влияние (Impact):**
  Вопреки прямому обещанию в UI и `USER_GUIDE.md:186` (*«программа удалит старые записи с диска и сожмет файл базы, не трогая текущие сессии в RAM»*), все живые сессии в таблице, у которых размер тела превышал 2 МБ, теряют свои тела в `offloaded_bodies`. При попытке нажать «Load full body» в Инспекторе или экспортировать эти сессии в `.har`/`.saz` возвращаются пустые или обрезанные до 16 КБ данные, а флаг `body_offloaded` остаётся `true`.
- **Рекомендация по исправлению (Fix):**
  Передавать в `purge_and_vacuum` список (или диапазоны) `id` сессий, находящихся сейчас в `self.sessions` в RAM, и удалять из `offloaded_bodies` только записи, не принадлежащие активным сессиям в RAM (`DELETE FROM offloaded_bodies WHERE session_id NOT IN (...)`), либо сбрасывать только таблицу `sessions` и осиротевшие строки `offloaded_bodies`.

---

#### `[BUG-06] [Severity: High]` Ложноположительная проверка доверия Root CA в хранилище ОС на Windows и macOS
- **Локация:** `src-tauri/src/proxy/ca.rs:317-347` (`CertificateAuthority::check_os_trust_Uncached`)
- **Доказательство (Evidence):**
  На Linux (`ca.rs:336-341`) функция `check_os_trust_uncached` проверяет побайтовое совпадение SHA-256 отпечатка установленного файла с текущим `self.ca_cert_der` через `cert_file_matches_ca_der(&self.ca_cert_der, Path::new(p))` (`ca.rs:426-447`).
  Однако на Windows (`ca.rs:319-325`) и macOS (`ca.rs:327-333`) проверяется только код возврата поиска по текстовому `Common Name`:
  ```rust
  // Windows:
  hidden_command("certutil").args(["-user", "-store", "Root", CA_COMMON_NAME]).output()
  // macOS:
  hidden_command("security").args(["find-certificate", "-c", CA_COMMON_NAME, ...]).output()
  ```
- **Сценарий проявления и влияние (Impact):**
  Если пользователь переустановил приложение, очистил `app_data_dir/ca` или сгенерировал новый Root CA, в системном хранилище Windows (`CurrentUser\Root`) или macOS (`login.keychain-db`) остаётся старый сертификат с тем же именем `"FluxProxy Local Debugging Root CA"`. В результате модальное окно сертификата и диагностика Proxy Doctor показывают зелёный статус `Установлен (доверен ОС)`, тогда как все браузеры отвергают перехваченные HTTPS-соединения с ошибкой `NET::ERR_CERT_AUTHORITY_INVALID`.
- **Рекомендация по исправлению (Fix):**
  - На **Windows**: проверять в `stdout` команды `certutil -user -store Root "FluxProxy Local Debugging Root CA"` (или `certutil -user -verifystore Root <sha1_or_serial>`) наличие серийного номера / SHA-1 или SHA-256 отпечатка текущего сертификата `self.ca_cert_der`.
  - На **macOS**: вызывать `security find-certificate -a -Z -c "FluxProxy Local Debugging Root CA"` и сверять строку `SHA-256 hash:` с `self.fingerprint_sha256`.

---

#### `[BUG-07] [Severity: High]` Искажение HTTP-ответов на проводе: удаление `Content-Length` у `HEAD`, удаление `Content-Encoding` при многослойном/неизвестном сжатии и замена бинарных заголовков на `"<binary>"`
- **Локация:**
  - `src-tauri/src/proxy/server.rs:204-247` (`header_has_zstd_token`, `maybe_decompress_zstd`)
  - `src-tauri/src/proxy/server.rs:3801-3814` (формирование финального `Response` в `handle_intercepted_request`)
  - `src-tauri/src/proxy/server.rs:4705-4721` (`extract_hyper_headers`, `extract_reqwest_headers`)
- **Доказательство (Evidence):**
  1. На строках `server.rs:3808-3809` при сборке ответа для клиента прокси **безусловно** пропускает заголовки `content-length` и `content-encoding`:
     ```rust
     if k.eq_ignore_ascii_case("content-length")
         || k.eq_ignore_ascii_case("content-encoding")
         || is_hop_by_hop_header(k)
     ```
     и на строке `3813` подставляет `resp_body_bytes.len().to_string()`. Для метода `HEAD` тело ответа пустое (`resp_body_bytes.len() == 0`), поэтому клиент вместо реального размера ресурса от сервера всегда получает `Content-Length: 0` (для ответов `<= 2 MiB`, не попавших в ветку `is_large_non_zstd_without_bp`).
  2. Там же заголовок `Content-Encoding` удаляется безусловно, даже если:
     - Сервер вернул неизвестное сжатие (например, `Content-Encoding: compress` или кастомный токен), которое `reqwest` не распаковал;
     - Сервер вернул многослойное сжатие `Content-Encoding: gzip, zstd`, где `maybe_decompress_zstd` (`server.rs:213-247`) снял только внешний слой `zstd`, оставив внутри сжатый `gzip`-поток без заголовка `Content-Encoding: gzip`.
  3. В `extract_hyper_headers` и `extract_reqwest_headers` (`server.rs:4705-4721`) заголовки с не-ASCII/ISO-8859-1 байтами конвертируются через `.to_str().unwrap_or("<binary>")`, и именно этот вектор пар затем используется для отправки запроса на upstream (`server.rs:3013`) и ответа клиенту (`server.rs:3811`), подменяя реальные байты заголовка строкой `"<binary>"`.
- **Сценарий проявления и влияние (Impact):**
  Нарушается работа HTTP-клиентов, проверяющих размер файла перед загрузкой через `HEAD` (менеджеры загрузок, S3/CDN SDK), ломается декодирование многослойного `Content-Encoding`, а легальные HTTP/1.1 заголовки с `obs-text` (`0x80..0xFF`) повреждаются при проксировании.
- **Рекомендация по исправлению (Fix):**
  1. Для запросов с `method.eq_ignore_ascii_case("HEAD")` сохранять оригинальный `Content-Length` от upstream, если тело ответа пустое и не модифицировалось скриптом/точкой останова.
  2. Удалять `Content-Encoding` только для тех алгоритмов (`gzip`, `deflate`, `br`, `zstd`), которые были фактически распакованы; при многослойном `Content-Encoding: gzip, zstd` либо распаковывать все слои по цепочке в обратном порядке, либо оставлять оставшиеся токены в `Content-Encoding`.

---

#### `[BUG-08] [Severity: Medium]` Быстрый путь `prev.length === 0` в `flushPendingSessions` пропускает дедупликацию по `id`, создавая дубликаты строк в таблице
- **Локация:** `src/hooks/useProxySessions.ts:768-800` (`flushPendingSessions`)
- **Доказательство (Evidence):**
  ```ts
  setSessions((prev) => {
    let next: SessionSummary[];
    if (prev.length === 0) {
      next = incoming.slice();
    } else {
      next = prev.slice();
      const indexById = new Map<number, number>();
      ...
  ```
  В ветке `else` (`prev.length > 0`) строится `indexById`, который корректно склеивает Фазу 1 (`status: 0`, Pending) и Фазу 2 (`status: 200`, Completed) одной и той же сессии, если обе сводки пришли в одном массиве `incoming`. Но когда таблица пуста (`prev.length === 0` — сразу после старта или после `Clear`), выполняется `next = incoming.slice()` без дедупликации внутри самого `incoming`.
- **Сценарий проявления и влияние (Impact):**
  Если первый быстрый запрос (или локальный Mock / AutoResponder) стартует и завершается в пределах одного 40-мс батча Rust или одного 16-мс RAF-кадра на пустой таблице, в `incoming` оказываются два элемента с `id: 1` (`status: 0` и `status: 200`). Оба попадают в массив `sessions`, порождая дубликат ключа React и вечно висящую фантомную строку `Pending` (`status: 0`).
- **Рекомендация по исправлению (Fix):**
  Убрать специальную ветку `if (prev.length === 0) { next = incoming.slice(); }` и всегда прогонять `incoming` через цикл с `indexById`.

---

#### `[BUG-09] [Severity: Medium]` Мёртвый код `.strip_prefix('.')` в компиляторе списков хостов ломает правила `.example.com`, а `split_authority` и `normalize_host_token` некорректно обрабатывают IPv6
- **Локация:**
  - `src-tauri/src/proxy/filters.rs:986-1015` (`compile_backend_host_list`)
  - `src-tauri/src/proxy/filters.rs:1438-1470` (`compile_capture_host_list`)
  - `src-tauri/src/proxy/filters.rs:620, 639, 693` (`normalize_host_token`, `extract_host_from_url_or_authority`)
  - `src-tauri/src/proxy/server.rs:4693-4703` (`split_authority`)
- **Доказательство (Evidence):**
  1. В `compile_backend_host_list` (`filters.rs:990-1011`) и `compile_capture_host_list` (`filters.rs:1465-1469`):
     ```rust
     if host_has_wildcard(&pattern) {
         let suffix = pattern
             .strip_prefix("*.")
             .or_else(|| pattern.strip_prefix('.'));
     ```
     Но `host_has_wildcard` (`filters.rs:689-691`) возвращает `pattern.contains('*') || pattern.contains('?')`. Поэтому шаблон `.example.com` (ведущая точка без `*`) получает `host_has_wildcard == false`, попадает в `else` (`exact_hosts.insert(".example.com")`), а `.or_else(|| pattern.strip_prefix('.'))` внутри `if` **никогда не выполняется** и никогда не совпадёт ни с одним доменом.
  2. В `normalize_host_token` (`filters.rs:620`): `no_path.split(':').next()` отрезает от IPv6-адреса `[::1]:8443` всё после первого двоеточия, возвращая пустую строку `""` после `trim_matches('[')`.
  3. В `split_authority` (`server.rs:4693-4703`): для `"[::1]"` без порта условие `authority.starts_with('[')` ищет `]:`, не находит и проваливается в общий `authority.rsplit_once(':')`, возвращая `("[::1]", default_port)` со скобками внутри имени хоста, а для `"::1"` без скобок возвращает `(":", 1)`.
- **Сценарий проявления и влияние (Impact):**
  Пользовательские списки хостов (Hosts List Whitelist/Blacklist), содержащие записи с ведущей точкой `.mycompany.ru` (стандартная нотация Fiddler/Squid/PAC), полностью игнорируются, а фильтрация и MITM-перехват по IPv6-литералам (`[::1]`, `[2001:db8::1]`) работают некорректно.
- **Рекомендация по исправлению (Fix):**
  1. Изменить условие в `compile_backend_host_list` и `compile_capture_host_list` на `if host_has_wildcard(&pattern) || pattern.starts_with('.')`.
  2. В `normalize_host_token`, `extract_host_from_url_or_authority` и `split_authority` обрабатывать `authority.starts_with('[')` через поиск закрывающей скобки `']'`: выделять IPv6-хост внутри `[...]` и опциональный `:port` после `']'`.

---

#### `[BUG-12] [Severity: Medium]` Паника переполнения `chrono::Duration::milliseconds` при экспорте `.saz` и отсутствие декодирования `zstd` в SAZ/Raw
- **Локация:**
  - `src-tauri/src/storage/export_import.rs:1999` (`export_saz`)
  - `src-tauri/src/storage/export_import.rs:2484-2504` (`decode_single_content_encoding`)
  - `src-tauri/src/storage/export_import.rs:2558-2586` (`is_matching_compressed_magic`)
- **Доказательство (Evidence):**
  1. В `export_saz` (`export_import.rs:1999`):
     ```rust
     let done_dt = start_dt + chrono::Duration::milliseconds(s.duration_ms as i64);
     ```
     Метод `chrono::Duration::milliseconds(secs)` вызывает `TimeDelta::try_milliseconds(...).expect(...)`, который **паникует** при `|ms| > i64::MAX / 1000` (а при импорте `.har` на строке `2832` `entry.time.max(0.0).round() as u64` может содержать `u64::MAX`, что при касте в `i64` даёт `-1` или переполнение).
  2. В `decode_single_content_encoding` (`export_import.rs:2484-2504`) обрабатываются только `"gzip" | "x-gzip"`, `"deflate"` и `"br"`. Алгоритм `"zstd"`, поддерживаемый в живом прокси (`server.rs:213`) и в TextWizard (`codec.rs:78`), в импорте/экспорте `.saz` и сырых HTTP-дампов пропущен.
- **Сценарий проявления и влияние (Impact):**
  Экспорт в `.saz` сессии, импортированной из специально сформированного или повреждённого `.har` файла с огромным `time`, вызывает панику потока в Rust; а импортированные `.saz` архивы с `Content-Encoding: zstd` остаются нераспакованными.
- **Рекомендация по исправлению (Fix):**
  1. Заменить `chrono::Duration::milliseconds(s.duration_ms as i64)` на `chrono::TimeDelta::try_milliseconds(s.duration_ms.min(86_400_000 * 365) as i64).unwrap_or_default()`.
  2. Добавить ветку `"zstd" | "x-zstd"` с ограниченным `zstd::stream::read::Decoder` (`take(MAX_HTTP_DECOMPRESSED_BODY_BYTES)`) в `decode_single_content_encoding` и магические байты `0x28, 0xB5, 0x2F, 0xFD` в `is_matching_compressed_magic`.

---

### 5.3. Категория 2: Конкурентность, состояние и утечки ресурсов

#### `[BUG-04] [Severity: High]` Утечка `PendingBreakpoint` в `DashMap` и вечно висящая сессия `WAIT` при дисконнекте клиента или отмене запроса в Composer
- **Локация:**
  - `src-tauri/src/proxy/breakpoints.rs:228-241` (`BreakpointEngine::pause_exchange`)
  - `src-tauri/src/proxy/server.rs:2690-2745` (Request Breakpoint в `handle_intercepted_request`)
  - `src-tauri/src/proxy/server.rs:3663-3729` (Response Breakpoint в `handle_intercepted_request`)
  - `src-tauri/src/proxy/server.rs:1618-1663` (Request Breakpoint в `execute_composed`)
- **Доказательство (Evidence):**
  1. `BreakpointEngine::pause_exchange` (`breakpoints.rs:228-241`) вставляет `PendingBreakpoint` с `oneshot::Sender` в `self.pending: DashMap<u64, PendingBreakpoint>` и возвращает `rx` (`oneshot::Receiver`).
  2. В `handle_intercepted_request` ожидание `tokio::time::timeout(Duration::from_secs(300), bp_rx).await` (`server.rs:2728, 3705`) выполняется внутри HTTP-задачи Hyper. Если клиент (браузер/приложение) закрывает TCP-сокет по собственному таймауту (например, через 15 секунд), пока запрос стоит на паузе в UI, Hyper **дропает всю future `handle_intercepted_request`**. При дропе `bp_rx` запись в `ctx.breakpoints.pending` **не удаляется**, событие `proxy://breakpoints-changed` не отправляется, а сессия в `TrafficStore` навсегда остаётся со `status: 0` и `breakpoint_paused: Some("request")`.
  3. В `execute_composed` (`server.rs:1659-1663`) при выборе пользователем `BreakpointAction::Abort` на точке останова запроса функция сразу делает `return Err(anyhow::anyhow!("Request aborted at breakpoint by user"))`, **не обновляя и не удаляя** in-flight сессию, записанную на строке `1618` со `status: 0` и `breakpoint_paused: Some("request")` (в отличие от `handle_intercepted_request` на строках `2988-2993`, где вызывается `record_completed_session` со статусом `502`).
- **Сценарий проявления и влияние (Impact):**
  Оборванные клиентом запросы накапливаются в `BreakpointEngine::pending` и висят в очереди точек останова в UI; в таблице трафика остаются неубираемые строки в состоянии `WAIT`.
- **Рекомендация по исправлению (Fix):**
  1. Создать RAII-гард `PendingBreakpointGuard`, который в `impl Drop` проверяет, была ли запись извлечена из `BreakpointEngine::pending`, и если нет — удаляет `session_id` из `pending`, обновляет сессию в `TrafficStore` (`status: 499` / `"Client Closed Request during Breakpoint"`, `breakpoint_paused: None`) и эмитит `proxy://breakpoints-changed`.
  2. В `execute_composed` (`server.rs:1659-1663`) перед `return Err(...)` вызывать `record_completed_session` со статусом `502` и `breakpoint_paused: None`.

---

#### `[BUG-05] [Severity: High]` Взаимная блокировка (Deadlock) двунаправленного релея WebSocket при одновременной отправке крупных фреймов + отсутствие системных CA, mTLS и таймаута подключения для `wss://`
- **Локация:**
  - `src-tauri/src/proxy/server.rs:3881` (`tokio_tungstenite::connect_async`)
  - `src-tauri/src/proxy/server.rs:4061-4108` (`proxy_websocket_upgrade` → цикл `tokio::select!`)
  - `src-tauri/Cargo.toml:40-41` (`tokio-tungstenite` features)
- **Доказательство (Evidence):**
  1. В `proxy_websocket_upgrade` (`server.rs:4061-4108`) оба направления (`client_stream.next()` и `upstream_stream.next()`) опрашиваются в одном цикле `loop { tokio::select! { ... } }`, внутри веток которого синхронно ожидается запись в противоположный сокет:
     ```rust
     client_msg = client_stream.next() => {
         ...
         if upstream_sink.send(msg).await.is_err() { break; }
     }
     upstream_msg = upstream_stream.next() => {
         ...
         if client_sink.send(msg).await.is_err() { break; }
     }
     ```
     Если и клиент, и сервер одновременно отправляют поток крупных WebSocket-сообщений, превышающих размер TCP-буфера ОС, задача заблокируется внутри `upstream_sink.send(msg).await`, перестав вычитывать `upstream_stream.next()`, в то время как сервер заблокируется на записи в сторону прокси. Возникает классический TCP/WebSocket deadlock.
  2. Подключение к upstream WebSocket (`server.rs:3881`) выполняется вызовом `tokio_tungstenite::connect_async(ws_request).await`:
     - Без `tokio::time::timeout` (зависший TCP handshake блокирует задачу навечно);
     - С дефолтным TLS-коннектором `rustls-tls-webpki-roots` (`Cargo.toml:41`), который **не доверяет корпоративным/локальным CA из хранилища ОС** и **не передаёт клиентские сертификаты mTLS** из `ClientCertificateStore`.
- **Сценарий проявления и влияние (Impact):**
  Интенсивный двунаправленный WebSocket-трафик (передача файлов, видео/аудио-стриминг, крупные state-синхронизации) намертво зависает, а `wss://` подключения к внутренним корпоративным серверам или серверам с mTLS падают с ошибкой TLS handshake.
- **Рекомендация по исправлению (Fix):**
  1. Разделить перекачку `client_stream -> upstream_sink` и `upstream_stream -> client_sink` на две параллельные задачи через `tokio::join!` (или использовать буферизированные каналы с независимым `flush`).
  2. Обернуть `connect_async_tls_with_config` в `tokio::time::timeout(Duration::from_secs(ctx.upstream_timeout_sec), ...)` и передавать `Connector::Rustls(Arc<rustls::ClientConfig>)`, собранный с системными корнями и клиентским сертификатом mTLS для данного хоста.

---

#### `[BUG-10] [Severity: Medium]` `set_bind_configuration` не откатывает системный прокси ОС при двойной ошибке бинда и не уведомляет UI событием `proxy://status-changed`
- **Локация:** `src-tauri/src/proxy/server.rs:1158-1308` (`ProxyController::set_bind_configuration`)
- **Доказательство (Evidence):**
  1. В `stop_and_rollback_sysproxy` (`server.rs:957-961`) при остановке прокси вызывается `self.sysproxy.rollback_if_dirty()` и `self.emit_status_changed(&status)`.
  2. В `set_bind_configuration` (`server.rs:1245-1306`) старый слушатель останавливается (`prev.shutdown_tx.send(())`), затем вызывается `start_on_addr(current_port, target_ip)`. Если этот бинд падает и последующий фолбэк `start_on_addr(current_port, prev_ip)` тоже падает (строки `1296-1305`), прокси остаётся полностью остановленным, но **`self.sysproxy.rollback_if_dirty()` не вызывается**!
  3. Ни в успешной ветке (`1265-1280`), ни в ветках отката (`1288-1305`) `set_bind_configuration` не вызывает `self.emit_status_changed(&status)`.
- **Сценарий проявления и влияние (Impact):**
  При сбое перепривязки сетевого интерфейса системный прокси ОС остаётся направленным на мёртвый порт (весь интернет на машине пользователя перестаёт работать до закрытия FluxProxy), а индикаторы статуса в UI рассинхронизируются.
- **Рекомендация по исправлению (Fix):**
  В ветке двойной ошибки (`server.rs:1296-1305`) вызывать `let _ = self.sysproxy.rollback_if_dirty();`, а перед каждым выходом из `set_bind_configuration` вызывать `self.emit_status_changed(&status)`.

---

#### `[BUG-11] [Severity: Medium]` Гонки конкурентности в `TrafficStore` (`enforce_retention_limit`, `clear`, `remove_many`, `annotate_session`) и порядок `PRAGMA` в SQLite
- **Локация:**
  - `src-tauri/src/storage/mod.rs:317-373` (`TrafficStore::enforce_retention_limit`)
  - `src-tauri/src/storage/mod.rs:441-451` (`TrafficStore::annotate_session`)
  - `src-tauri/src/storage/mod.rs:518-643` (`TrafficStore::remove_many`)
  - `src-tauri/src/storage/mod.rs:697-721` (`TrafficStore::clear`)
  - `src-tauri/src/storage/sqlite.rs:36-39` (`SqliteStore::init_schema`)
- **Доказательство (Evidence):**
  1. В `enforce_retention_limit` (`storage/mod.rs:346-361`) вытесняемые сессии **сначала удаляются из `self.sessions` (`DashMap`)**, и лишь затем на строке `360` вызывается `sqlite.persist_batch(&evicted_sessions)`:
     ```rust
     if let Some((_, removed)) = self.sessions.remove(&evict_id) {
         ...
         evicted_sessions.push(removed);
     }
     ...
     let _ = sqlite.persist_batch(&evicted_sessions);
     ```
     Во-первых, если `persist_batch` вернёт ошибку (`SQLITE_FULL`, `SQLITE_BUSY`), данные безвозвратно потеряны и из RAM, и из SQLite (`let _ = ...`). Во-вторых, между `self.sessions.remove(&evict_id)` и коммитом транзакции SQLite сессия временно исчезает из обоих хранилищ: параллельный вызов `store.get(evict_id)` вернёт `None`.
  2. Методы `clear()` (`storage/mod.rs:697`) и `remove_many()` (`storage/mod.rs:518`) очищают `self.sessions` и SQLite, **не захватывая `self.eviction_lock`**. Если в этот момент параллельный поток находится внутри `enforce_retention_limit` (уже забрал сессии из `DashMap`, но ещё не записал в SQLite), после завершения `clear()` он запишет «удалённые» сессии обратно в чистую БД SQLite!
  3. В `annotate_session` (`storage/mod.rs:441-445`) быстрый путь для сессии в RAM вызывает `sqlite.persist_session(&cloned)` вне `eviction_lock`, перезаписывая весь `payload_json` в SQLite.
  4. В `SqliteStore::init_schema` (`sqlite.rs:36-39`) `PRAGMA journal_mode = WAL;` выполняется **до** `PRAGMA busy_timeout = 5000;`, поэтому сама смена режима журнала не защищена таймаутом ожидания блокировки.
- **Сценарий проявления и влияние (Impact):**
  Фантомное воскрешение удалённых сессий в SQLite после нажатия `Clear` под высокой нагрузкой, кратковременные `Session not found` при клике по вытесняемой сессии и тихая потеря сессий при ошибках диска.
- **Рекомендация по исправлению (Fix):**
  1. В `enforce_retention_limit` сначала клонировать (или сериализовать) вытесняемые записи и выполнять `sqlite.persist_batch(...)`, и только при `Ok(())` удалять их из `self.sessions`.
  2. В `clear()` и `remove_many()` захватывать `let _guard = self.eviction_lock.lock();`.
  3. В `SqliteStore::init_schema` поставить `PRAGMA busy_timeout = 5000;` первой строкой перед `PRAGMA journal_mode = WAL;`.

---

### 5.4. Категория 3: Безопасность (Security)

#### `[SEC-01] [Severity: Critical]` Скрытое выполнение произвольного кода (RCE) через Python Scripting Engine при импорте профиля настроек `fluxproxy-settings-v1.json`
- **Локация:**
  - `src/lib/settingsManager.ts:2237-2317` (`buildSettingsImportPreview`)
  - `src/lib/settingsManager.ts:2538-2545, 2602` (`applySettingsProfile`)
  - `src/types/settings.ts:122-153` (`SettingsImportPreviewSummary`)
  - `src-tauri/src/scripting/python_runner.rs:203-209, 1076-1129` (`load_user_script`, `ensure_worker_locked`)
- **Доказательство (Evidence):**
  1. Профиль настроек `FluxProxySettingsProfile` включает секцию `scripting: { enabled: boolean, code: string }` (`src/types/settings.ts:95-100`).
  2. При импорте файла настроек пользователь видит модальное окно превью, данные для которого формирует `buildSettingsImportPreview` (`src/lib/settingsManager.ts:2237-2317`). Однако структура `SettingsImportPreviewSummary` (`src/types/settings.ts:122-153`) и функция `buildSettingsImportPreview` **вообще не содержат полей о наличии или включении Python-скрипта** (в превью показываются только тема, порт, лимит сессий, число правил AutoResponder и Breakpoints).
  3. Как только пользователь нажимает «Import / Apply», функция `applySettingsProfile` (`src/lib/settingsManager.ts:2602`) безусловно вызывает:
     ```ts
     await proxyBridge.setPythonScript(nextScripting.code, nextScripting.enabled);
     ```
  4. На стороне Rust `PythonScriptRunner::set_script` (`python_runner.rs:1166-1208`) при `enabled == true` немедленно запускает процесс `python` и выполняет `exec(compiled, new_ns)` (`python_runner.rs:209`) на уровне модуля (даже без ожидания первого HTTP-запроса!).
- **Сценарий проявления и влияние (Impact):**
  Злоумышленник или автор статьи/баг-репорта передаёт разработчику файл «готовых фильтров и тем FluxProxy» (`team-preset.fluxproxy-settings.json`), внутри которого прописано `"scripting": { "enabled": true, "code": "import os; os.system('...')" }`. В окне предпросмотра импорта скрипт никак не отображается, и сразу после подтверждения импорта вредоносный код исполняется на машине разработчика с полными правами пользователя ОС.
- **Рекомендация по исправлению (Fix):**
  1. При импорте любого внешнего профиля настроек принудительно сбрасывать `scripting.enabled = false` (требуя от пользователя явно открыть вкладку Python Scripting Engine, увидеть код и нажать `Apply Script`), либо показывать в `SettingsImportPreviewSummary` явный красный баннер предупреждения безопасности с полным диффом Python-кода и отдельным чекбоксом *«Разрешить выполнение импортируемого Python-скрипта»* (по умолчанию выключенным).

---

#### `[SEC-02] [Severity: Critical]` Обход валидации путей (`Path Traversal`), утечка NTLMv2 по UNC и перезапись произвольных файлов через Tauri IPC-команды
- **Локация:**
  - `src-tauri/src/commands.rs:573-638` (`validate_user_file_path`)
  - `src-tauri/src/commands.rs:641-776` (`export_sessions_file`, `import_sessions_file`, `save_session_body_file`, `export_settings_file`, `import_settings_file`)
  - `src-tauri/src/storage/export_import.rs:823-829, 2918-2925` (`save_body_to_file`)
- **Доказательство (Evidence):**
  1. Функция `validate_user_file_path` (`commands.rs:573-638`) пытается защититься от traversal следующей проверкой (`596-600`):
     ```rust
     let file_name = path
         .file_name()
         .and_then(|n| n.to_str())
         .ok_or_else(|| "Target path must include a valid file name".to_string())?;
     if file_name == "." || file_name == ".." {
         return Err("Invalid file name".to_string());
     }
     ```
     В Rust `Path::new("/safe/dir/../../../Users/victim/.ssh/authorized_keys").file_name()` возвращает `Some("authorized_keys")`, так как `Path::file_name()` нормализует только конечный сегмент и не запрещает промежуточные `Component::ParentDir` (`..`).
  2. Команды чтения и записи файлов (`export_sessions_file`, `save_session_body_file`, `import_settings_file`) принимают произвольную строку `file_path: String` из IPC и **не проверяют**, что этот путь был ранее выбран пользователем через нативный диалог `pick_save_file_dialog` / `pick_open_file_dialog`.
  3. Команда `save_session_body_file` (`commands.rs:736-750`) передаёт `allowed_extensions: None` (`commands.rs:742`), а `TrafficStore::save_body_to_file` (`export_import.rs:2918-2925`) автоматически создаёт все родительские директории (`std::fs::create_dir_all(parent)`) и записывает сырые бинарные байты тела любой сессии по указанному пути (`std::fs::write(target, bytes)`).
  4. На Windows `validate_user_file_path` не блокирует UNC-пути (`\\attacker.com\share\file.json`), резервированные имена устройств (`CON`, `NUL`, `COM1`) и альтернативные потоки данных NTFS (`file.txt:stream.json`), а вызов `path.is_dir()` (`commands.rs:584`) инициирует SMB-обращение к внешнему хосту с отправкой NTLMv2-хэша пользователя.
  5. Команда `import_settings_file` (`commands.rs:767-776`) читает любой `.json`-файл на диске через `std::fs::read_to_string(&path)` без ограничения размера файла (в отличие от `import_sessions_from_file`, где на строке `export_import.rs:826` стоит лимит 512 МиБ).
- **Сценарий проявления и влияние (Impact):**
  Любой код в контексте WebView (или при эксплуатации XSS / вредоносного расширения) может перезаписать произвольный исполняемый файл, скрипт автозагрузки или конфиг на диске бинарным содержимым из тела сессии (`save_session_body_file`), выгрузить любой `.json`-файл из файловой системы (`import_settings_file`) или инициировать утечку Net-NTLMv2 по SMB.
- **Рекомендация по исправлению (Fix):**
  1. Хранить в `ProxyController` белый список путей (`DashSet<PathBuf>`), выданных пользователем через нативные диалоги `pick_save_file_dialog` и `pick_open_file_dialog`, и разрешать запись/чтение только по одобренным диалогом путям.
  2. В `validate_user_file_path` явно проверять `path.components().any(|c| matches!(c, std::path::Component::ParentDir))` и отклонять UNC-пути (`Prefix::UNC` / `Prefix::VerbatimUNC`), NTFS ADS (`:` в имени файла) и зарезервированные имена DOS-устройств.
  3. В `import_settings_file` добавить проверку `metadata.len() <= 16 * 1024 * 1024` (16 МиБ) перед `fs::read_to_string`.

---

#### `[SEC-03] [Severity: High]` Открытый неаутентифицированный прокси в режимах `AllInterfaces`/`Specific`: произвольные TCP-туннели к `127.0.0.1` хоста (SSRF), использование хозяйских mTLS-ключей и обход `TargetedOnly`
- **Локация:**
  - `src-tauri/src/proxy/server.rs:517-585` (`ProxyBindMode`)
  - `src-tauri/src/proxy/server.rs:2152-2162` (ветка `CONNECT` Passthrough)
  - `src-tauri/src/proxy/server.rs:2447-2453` (переопределение `host` из внутреннего заголовка `Host` в `handle_intercepted_request`)
  - `src-tauri/src/proxy/server.rs:2999-3028` (применение mTLS-сертификата к upstream-запросу)
  - `src-tauri/src/proxy/server.rs:4782-4808` (`is_builtin_portal_target`)
- **Доказательство (Evidence):**
  1. При включении режима для тестирования мобильных устройств (`ProxyBindMode::AllInterfaces` `0.0.0.0` или `ProxyBindMode::Specific` LAN IP) прокси не поддерживает ни `Proxy-Authorization`, ни белый список IP-адресов клиентов.
  2. Любой узел в той же Wi-Fi/LAN сети может отправить `CONNECT 127.0.0.1:6379 HTTP/1.1` (или к любому другому локальному порту хост-машины: Redis, PostgreSQL, Docker API, Dev-серверу). Если хост попадает в Passthrough, `server.rs:2162` выполняет `TcpStream::connect((host.as_str(), port)).await`, открывая прямой TCP-туннель к `127.0.0.1` компьютера разработчика.
  3. Даже для самого порта прокси (`127.0.0.1:8888`) защита от рекурсии `is_builtin_portal_target` (`server.rs:4782-4808`) проверяется **только внутри `handle_intercepted_request`** (после TLS-терминации или для plain HTTP), но **не проверяется в ветке `CONNECT` Passthrough (`server.rs:2152`)** и не учитывает IPv6-mapped адреса `[::ffff:127.0.0.1]`.
  4. Для любого HTTPS-запроса, пришедшего от внешнего LAN-клиента, `server.rs:3000` вызывает `ctx.client_certs.get_or_build_client(&host, ...)`, автоматически прикрепляя **приватные mTLS-сертификаты разработчика** к запросам постороннего устройства в локальной сети.
  5. В `handle_intercepted_request` (`server.rs:2447-2453`) внутри уже установленного TLS-туннеля `CONNECT allowed-domain.com:443` хост целевого upstream-запроса перезаписывается из HTTP-заголовка `Host`:
     ```rust
     if let Some(h) = req.headers().get(hyper::header::HOST).and_then(|v| v.to_str().ok()) {
         let (parsed_h, parsed_p) = split_authority(h, port);
         if !parsed_h.is_empty() {
             host = parsed_h;
             port = parsed_p;
         }
     }
     ```
     Это позволяет клиенту пройти фильтр `TargetedOnly` через `CONNECT allowed.com:443`, а внутри туннеля отправить `GET / HTTP/1.1\r\nHost: internal-corp.local` (domain fronting / обход правил фильтрации и TLS Bypass).
- **Сценарий проявления и влияние (Impact):**
  При отладке смартфона в офисной или публичной Wi-Fi сети любой сосед по сети получает полный доступ к `localhost`-сервисам компьютера разработчика и может отправлять запросы во внутренние контуры от имени его корпоративных mTLS-сертификатов.
- **Рекомендация по исправлению (Fix):**
  1. Запретить для не-loopback клиентов (`!peer_addr.ip().is_loopback()`) подключение к loopback/link-local адресам (`ip.is_loopback()`, `ip.is_unspecified()`, `::ffff:127.0.0.0/104`) как после парсинга хоста, так и после DNS-резолвинга, а также проверять `is_builtin_portal_target` до открытия `CONNECT` Passthrough-туннеля.
  2. По умолчанию отключать прикрепление хозяйских mTLS-сертификатов (`ClientCertificateStore`) для запросов от не-loopback `peer_addr` (или добавить явный переключатель *«Allow LAN clients to use host mTLS certificates»*).
  3. Добавить опциональный список разрешённых IP клиентов (Client IP Allowlist) или токен `Proxy-Authorization` для режимов `AllInterfaces` / `Specific`.

---

#### `[SEC-04] [Severity: High]` Детерминированная утечка токенов и PII при санитизированном экспорте (`sanitize: true`) в сырых телах SSE, фреймах WebSocket и `camelCase`-ключах JSON
- **Локация:**
  - `src-tauri/src/storage/export_import.rs:962-969, 1014-1329` (`sanitize_sessions`, `mask_sensitive_json_value`, `sanitize_body_content`)
  - `src-tauri/src/storage/mod.rs:1003-1013` (`apply_ws_to_detail`)
  - `src-tauri/src/models.rs:468-485` (` SENSITIVE_BODY_KEYS`)
- **Доказательство (Evidence):**
  1. **Полная утечка сырого тела SSE-стримов:** в `sanitize_sessions` (`export_import.rs:1285-1292`) редактируются только распарсенные элементы `detail.sse_events[i].data`, однако для SSE-ответов `detail.response_body_text` и `detail.response_body_base64` содержат полный сырой поток `event: message\ndata: {"api_key":"secret"}\n\n`. Поскольку `Content-Type` равен `text/event-stream`, функция `sanitize_body_content` (`1267-1283`) не распознаёт его как JSON или `application/x-www-form-urlencoded` и **оставляет `response_body_text` и `response_body_base64` полностью нетронутыми**. Именно эти поля затем записываются в `.har`, `.saz`, `.json` и `.http`!
  2. **Полная утечка WebSocket-фреймов в `response_body_text` и не-JSON протоколах:** при завершении WebSocket-сессии функция `apply_ws_to_detail` (`storage/mod.rs:1010`) сериализует массив `websocket_frames` в `detail.response_body_text`. При этом внутри каждого объекта фрейма поле `payloadPreview` является **экранированной строкой** (а не вложенным JSON-объектом). В `sanitize_sessions` (`export_import.rs:1294-1301`) редактируются структуры `detail.websocket_frames`, но:
     - `detail.response_body_text` и `detail.response_body_base64` после этого **не пересобираются**, а в `mask_sensitive_json_value` ключ `"payloadPreview"` не входит в `SENSITIVE_BODY_KEYS`, поэтому все фреймы утекают в `response_body_text` в открытом виде;
     - если фрейм WebSocket использует формат SignalR (JSON с суффиксом `\x1e`), Socket.IO (`42["auth",{"token":"..."}]`), STOMP или обычный текст, `serde_json::from_str` в `sanitize_ws_frame_payload` возвращает `Err`, и фрейм остаётся несанитизированным даже в `websocket_frames`.
  3. **Пропуск `camelCase`-ключей в JSON-телах:** список `SENSITIVE_BODY_KEYS` (`models.rs:468-485`) содержит только `snake_case` и дефисные строки (`"access_token"`, `"refresh_token"`, `"api_key"`, `"client_secret"`, `"private_key"`, `"card_number"`, `"session_id"`), а проверка в `mask_sensitive_json_value` (`export_import.rs:1024`) использует точное равенство после `to_ascii_lowercase()`:
     ```rust
     SENSITIVE_BODY_KEYS.iter().any(|mk| mk == &k_lower)
     ```
     Поскольку `"accessToken".to_ascii_lowercase()` даёт `"accesstoken"` (без подчёркивания!), стандартные `camelCase` JSON-поля `"accessToken"`, `"refreshToken"`, `"apiKey"`, `"clientSecret"`, `"idToken"`, `"privateKey"`, `"cardNumber"`, `"sessionId"` **не маскируются вообще**.
  4. **Прочие пропуски санитизатора:**
     - `#fragment` в URL (`https://app.example.com/callback#access_token=eyJ...`) сохраняется без изменений (`export_import.rs:1164, 1201`);
     - `userinfo` в URL (`https://admin:SecretPass@api.example.com`) не очищается;
     - query-параметры внутри заголовков `Location` и `Referer` (`Location: https://app.com/?code=secret&token=xyz`) не проходят через `sanitize_url_query` (`export_import.rs:962-969`);
     - `multipart/form-data` тела, NDJSON (`application/x-ndjson`) и JSON с UTF-8 BOM (`\u{FEFF}`) не парсятся и остаются в открытом виде.
- **Сценарий проявления и влияние (Impact):**
  Пользователь экспортирует архив трафика с включённой галочкой **«Sanitize sensitive data (tokens, cookies, passwords)»**, чтобы безопасно приложить `.har` или `.saz` к публичному баг-трекеру или передать подрядчику, но в экспортированном файле в открытом виде остаются JWT/OAuth токены в `accessToken`/`refreshToken`, ключи в SSE-ответах и сообщениях WebSocket.
- **Рекомендация по исправлению (Fix):**
  1. Нормализовать имена ключей JSON перед сверкой с `SENSITIVE_BODY_KEYS`, удаляя символы `_` и `-` (`k.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase()`), чтобы `"access_token"`, `"access-token"` и `"accessToken"` сводились к `"accesstoken"`.
  2. В `sanitize_sessions` после санитизации `sse_events` и `websocket_frames` принудительно пересобирать `detail.response_body_text` и `detail.response_body_base64` из уже отредактированных событий/фреймов, а для не-JSON текстовых фреймов (SignalR/Socket.IO) применять регулярную замену Bearer/JWT и парсинг JSON после отрезания префикса/суффикса протокола.
  3. В `sanitize_url_query` очищать `parsed.set_username("")`, `parsed.set_password(None)` и редактировать `fragment` по тем же правилам `key=value`, а для заголовков `Location` и `Referer` прогонять значение через `sanitize_url_query`.

---

#### `[SEC-05] [Severity: High]` Бомбы декомпрессии и неограниченная буферизация ответов (OOM DoS) в импорте `.saz`, прокси-сервере, Composer и TextWizard
- **Локация:**
  - `src-tauri/src/storage/export_import.rs:672, 2202-2203, 2434-2504` (`import_saz`, `decode_http_body`)
  - `src-tauri/src/proxy/server.rs:213-247, 1921, 3222-3273, 3508` (`maybe_decompress_zstd`, `execute_composed`, `handle_intercepted_request`)
  - `src-tauri/src/proxy/codec.rs:44-92` (`execute_codec_transform`)
- **Доказательство (Evidence):**
  1. **Двойная декомпрессия в `import_saz`:** на уровне ZIP-архива действует кумулятивный лимит `MAX_SAZ_TOTAL_UNCOMPRESSED_BYTES = 512 MiB` (`export_import.rs:647`). Но внутри каждой пары файлов `raw/{id}_c.txt` и `raw/{id}_s.txt` вызывается `parse_raw_http_response` → `decode_http_body` (`export_import.rs:2434-2482`), который распаковывает HTTP `Content-Encoding: br / gzip / deflate` с лимитом `MAX_HTTP_DECOMPRESSED_BODY_BYTES = 64 MiB` **на каждый отдельный вызов и на каждый слой `Content-Encoding` без общего кумулятивного счётчика**. Архив `.saz` размером 2 МБ с 200 записями, каждая из которых содержит 50 КБ Brotli-потока, распаковывающегося в 64 МБ нулей, аллоцирует `200 × 64 MiB = 12.8 GiB` RAM и убивает приложение по OOM.
  2. **Неограниченный `zstd::decode_all` и `upstream_resp.bytes().await` в прокси и Composer:**
     - В `handle_intercepted_request` (`server.rs:3508`) и `execute_composed` (`server.rs:1921`) вызов `upstream_resp.bytes().await` буферизует весь ответ в память без лимита размера, если сервер использует `Transfer-Encoding: chunked` (без заголовка `Content-Length`) или прислал 1 МБ `gzip`/`zstd` с `Content-Length: 1000000`, который `reqwest` или `maybe_decompress_zstd` (`server.rs:213-247`, `zstd::decode_all`) распаковывают в гигабайты в памяти.
     - В SSE-стриминге с `Content-Encoding: zstd` (`server.rs:3223-3273`) все чанки накапливаются в `compressed_buf: Vec<u8>` без верхнего предела и в конце передаются в `zstd::decode_all`.
  3. **В TextWizard (`codec.rs:44-92`):** `GzDecoder`, `ZlibDecoder`, `brotli::Decompressor` читают через `read_to_end(&mut out)` без `.take(limit)`, а `zstd::decode_all` не ограничен по выходу, после чего результат одновременно клонируется в UTF-8, Base64 и Hex (`codec.rs:146-182`, ~5.3× умножение памяти).
- **Сценарий проявления и влияние (Impact):**
  Импорт вредоносного `.saz` файла, обращение к серверу с бесконечным chunked-ответом / сжатой бомбой или вставка сжатого пейлоада в TextWizard вызывают мгновенный Out-Of-Memory краш всего процесса FluxProxy.
- **Рекомендация по исправлению (Fix):**
  1. В `import_saz` ввести единый кумулятивный счётчик `total_decoded_http_bytes` на весь импортируемый архив (не более `512 MiB`) и ограничить число слоёв вложенного `Content-Encoding` в `decode_http_body` максимум 2 слоями.
  2. В `maybe_decompress_zstd` и `codec.rs` заменить `zstd::decode_all` и `read_to_end` на `zstd::stream::read::Decoder::new(...)?.take(MAX_DECOMPRESSED_BYTES).read_to_end(...)`.
  3. В `handle_intercepted_request` и `execute_composed` читать `upstream_resp` почанково; если размер распакованного буфера превышает `LARGE_BODY_OFFLOAD_THRESHOLD_BYTES` (или жёсткий предел, например 64 МиБ), сбрасывать поток во временный файл / SQLite `offloaded_bodies` или обрезать захват.

---

#### `[SEC-06] [Severity: Medium]` Хранение приватных ключей из парольных `.p12`/`.pfx` в открытом PEM-файле на диске, отсутствие ACL/DPAPI на Windows и непроверенный `stored_cert_path`
- **Локация:**
  - `src-tauri/src/proxy/client_certs.rs:61-108` (`write_bytes_securely`)
  - `src-tauri/src/proxy/client_certs.rs:640-652` (`ClientCertificateStore::add_certificate`)
  - `src-tauri/src/proxy/client_certs.rs:519-526, 735-750` (чтение и удаление `stored_cert_path` из `registry.json`)
  - `src-tauri/src/proxy/ca.rs:127-163` (`write_private_key_securely`)
- **Доказательство (Evidence):**
  1. При импорте защищённого паролем сертификата `.p12`/`.pfx` функция `parse_and_normalize_certificate` (`client_certs.rs:251-356`) расшифровывает приватный ключ паролем пользователя, а `add_certificate` (`client_certs.rs:643-644`) записывает объединённый сертификат и **незашифрованный приватный ключ (`PRIVATE KEY`)** в файл `{id}.identity.pem` на диске.
  2. В `write_bytes_securely` (`client_certs.rs:89-92`) и `write_private_key_securely` (`ca.rs:145-149`) для `#[cfg(not(unix))]` (то есть на Windows) выполняется обычный `fs::write(path, bytes)` без установки ограничивающего DACL или шифрования через Windows DPAPI (`CryptProtectData`).
  3. При загрузке `client_certs/registry.json` (`client_certs.rs:519-526`) и удалении сертификата (`735-750`) поле `stored_cert_path` из JSON-файла используется напрямую в `fs::read` и `fs::remove_file` без проверки того, что путь находится внутри `self.storage_dir`.
- **Сценарий проявления и влияние (Impact):**
  Пользователь импортирует корпоративный `.pfx`-сертификат, рассчитывая, что его приватный ключ защищён паролем, однако ключ оказывается сохранённым в открытом текстовом PEM-файле в `%APPDATA%`.
- **Рекомендация по исправлению (Fix):**
  1. На Windows защищать `{id}.identity.pem` и `fluxproxy-root-ca.key` через Windows DPAPI (`CryptProtectData` с привязкой к текущему пользователю) или выставлять строгий DACL только для SID текущего владельца.
  2. Хранить в `registry.json` только имя файла (или вычислять путь как `self.storage_dir.join(format!("{}.identity.pem", entry.id))`), игнорируя произвольные пути из JSON.

---

### 5.5. Категория 4: Производительность и масштабируемость (Performance)

#### `[PERF-01] [Severity: High]` Лишняя зависимость `sessions.length` в `useEffect` вызывает повторный IPC-запрос `getSessionDetail(selectedId)` на каждый новый перехваченный запрос
- **Локация:** `src/hooks/useProxySessions.ts:1128-1156` (`useEffect` загрузки `selectedSession`)
- **Доказательство (Evidence):**
  ```ts
  useEffect(() => {
    if (selectedId === null) {
      setSelectedSession(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    proxyBridge
      .getSessionDetail(selectedId)
      ...
  }, [selectedId, sessions.length, selectedSummarySignature, showToast]);
  ```
  На строках `1115-1126` уже вычисляется мемоизированная строка `selectedSummarySignature`, которая отслеживает изменения конкретной выбранной строки (`selectedId`: её `status`, `durationMs`, `responseBodySize`, `breakpointPaused`, `markedColor`, `note`). Однако в массив зависимостей `useEffect` на строке `1156` дополнительно включён `sessions.length`!
- **Сценарий проявления и влияние (Impact):**
  Когда у пользователя выбрана любая сессия в таблице и на фоне идёт активный трафик, **каждый новый перехваченный запрос** увеличивает `sessions.length`. В результате до 60 раз в секунду (на каждый RAF-флаш батча) фронтенд выставляет `setLoadingDetail(true)`, сериализует и гонит через Tauri IPC полный `CapturedSession` (с заголовками, телами, SSE-событиями и фреймами WebSocket) для уже открытой и давно завершённой сессии, вызывая лишние ререндеры `SessionInspector` и нагрузку на IPC и SQLite.
- **Рекомендация по исправлению (Fix):**
  Удалить `sessions.length` из массива зависимостей `useEffect` на строке `src/hooks/useProxySessions.ts:1156`, оставив `[selectedId, selectedSummarySignature, showToast]`.

---

#### `[PERF-02] [Severity: High]` Блокирующий синхронный ввод-вывод SQLite (`Mutex<Connection>`) и сортировка всех ключей `DashMap` (`O(N log N)`) прямо на async-воркерах Tokio на каждом запросе
- **Локация:**
  - `src-tauri/src/storage/mod.rs:215-373` (`TrafficStore::insert_with_id`, `enforce_retention_limit`)
  - `src-tauri/src/proxy/server.rs:272, 292, 319, 378, 2680, 3732` (`record_in_flight_session`, `record_completed_session`)
- **Доказательство (Evidence):**
  1. Функции `record_in_flight_session` и `record_completed_session` являются синхронными (`fn`) и вызываются напрямую из асинхронных задач Tokio (`handle_intercepted_request`, `proxy_service`) без `tokio::task::spawn_blocking`.
  2. На **каждом новом запросе** `record_in_flight_session` (`server.rs:319`) вызывает `ctx.store.get(new_session_id)`. Так как `new_session_id` только что выделен через `allocate_id()`, его гарантированно нет в `DashMap`, и `store.get()` (`storage/mod.rs:413-421`) захватывает глобальный `std::sync::Mutex<rusqlite::Connection>` и выполняет синхронный SQL-запрос `SELECT payload_json FROM sessions WHERE id = ?1` на потоке Tokio!
  3. Когда количество сессий в RAM достигает `retention_limit` (по умолчанию до 10 000), **каждая последующая вставка** вызывает `enforce_retention_limit` (`storage/mod.rs:317-373`), который:
     - захватывает `self.eviction_lock.lock()`;
     - собирает все 10 000 ключей из 64 шардов `DashMap` в `Vec<u64>` и выполняет `keys.sort_unstable()` (`O(N log N)`, строки `340-341`), чтобы найти всего 1 минимальный ID для удаления;
     - синхронно сериализует и записывает эту 1 сессию в SQLite транзакцией (`BEGIN IMMEDIATE ... COMMIT`), блокируя поток Tokio на дисковом I/O.
- **Сценарий проявления и влияние (Impact):**
  При заполненном буфере (`10 000` сессий) и высокой параллельности трафика все рабочие потоки Tokio выстраиваются в очередь на `eviction_lock` и `Mutex<rusqlite::Connection>`, выполняя по 10 000-элементной сортировке и индивидуальному `COMMIT` в SQLite на каждый HTTP-запрос, что резко увеличивает латентность проксирования.
- **Рекомендация по исправлению (Fix):**
  1. Убрать обращение к SQLite из `record_in_flight_session` (`server.rs:319`), проверяя наличие in-flight аннотации только в `self.sessions.get(&id)` в RAM.
  2. Вытеснять сессии из RAM пачками (гистерезис, например по 64–128 старейших сессий за раз или через `AtomicU64` указатель `min_ram_id`), а запись вытесненных сессий и крупных тел в SQLite отправлять через bounded/unbounded канал фоновому выделенному потоку БД (`std::thread::spawn`), полностью убрав `rusqlite` с потоков Tokio.

---

#### `[PERF-03] [Severity: High]` Компиляция `Regex::new` внутри `RwLock::read()` на каждом `CONNECT`-туннеле и HTTP-запросе в `ProxyFilterEngine`
- **Локация:**
  - `src-tauri/src/proxy/filters.rs:417, 531, 701-754, 1153` (`should_intercept_tls`, `apply_header_mutations`, `pattern_matches`, `glob_matches`, `regex_matches`)
- **Доказательство (Evidence):**
  В отличие от `RuleEngine` (`rules.rs:48-82`) и `BreakpointEngine` (`breakpoints.rs:34-61`), где регулярные выражения предкомпилируются при сохранении правил, `ProxyFilterEngine` хранит `tls_bypass_rules`, `tls_target_rules` и `header_mutations` как сырые структуры с текстовым `pattern: String`.
  При этом дефолтный список `default_tls_bypass_rules` (`filters.rs:1148-1157`) содержит включённое по умолчанию правило с шаблоном `"ocsp.*, crl.*"`.
  В результате на **каждом** входящем `CONNECT`-запросе внутри `self.state.read()` (`filters.rs:386`) вызывается `pattern_matches` → `glob_matches` (`filters.rs:731-754`), который строит строку регулярного выражения и компилирует `Regex::new(&regex_str)` с нуля дважды (для `ocsp.*` и `crl.*`), плюс для всех пользовательских правил `tls_bypass_rules`, `tls_target_rules` и `header_mutations`.
- **Сценарий проявления и влияние (Impact):**
  Компиляция конечного автомата `regex::Regex` в Rust на десятки порядков тяжелее его выполнения (`is_match`). Выполнение `Regex::new` на горячем пути каждого TLS-соединения и каждого HTTP-запроса создаёт лишнюю нагрузку на CPU и аллокатор.
- **Рекомендация по исправлению (Fix):**
  Предкомпилировать `tls_bypass_rules`, `tls_target_rules` и `header_mutations` в структуры `CompiledTlsInterceptRule` / `CompiledHeaderMutationRule` (с готовыми `Vec<Regex>` и списками суффиксов/точных хостов) один раз внутри `ProxyFilterEngine::set_config` (`filters.rs:358-382`).

---

#### `[PERF-04] [Severity: Medium]` Сериализация всех параллельных HTTP-запросов и ответов через единственный процесс Python (`AsyncMutex` Head-of-Line Blocking)
- **Локация:** `src-tauri/src/scripting/python_runner.rs:601, 1264, 1452` (`PythonScriptRunner::worker`, `invoke_worker`)
- **Доказательство (Evidence):**
  `PythonScriptRunner` управляет ровно одним дочерним процессом Python, обёрнутым в `worker: AsyncMutex<Option<PythonWorkerProcess>>` (`python_runner.rs:601`). В `invoke_worker` (`python_runner.rs:1452`) ожидание захвата мьютекса и само выполнение скрипта разделяют общий таймаут `timeout_dur = Duration::from_millis(1500)`.
- **Сценарий проявления и влияние (Impact):**
  Когда браузер загружает страницу и параллельно открывает 30–50 запросов, все они выстраиваются в очередь за единственным `worker.lock().await`. Если пользовательский скрипт тратит хотя бы 40 мс на каждый вызов (например, криптография или логирование), 38-й запрос в очереди простоит в ожидании лока больше 1500 мс, отвалится по таймауту, а `invoke_worker` на строке `1509` **убьёт и перезапустит Python-воркер**, сбросив всё in-memory состояние скрипта (`globals`).
- **Рекомендация по исправлению (Fix):**
  Разделить таймаут ожидания очереди (`lock_acquire_timeout`) и таймаут исполнения конкретного хука (`execution_timeout`), чтобы медленная очередь не убивала живой процесс воркера, а в перспективе — поддержать пул из `N` воркеров (например, 2–4 процесса) для чистых скриптов или асинхронный мультиплексированный протокол с `request_id`.

---

#### `[PERF-05] [Severity: Medium]` Безусловный запуск `BrowserPreviewEngine` в нативном Tauri и ранняя загрузка 12+ МБ воркеров Monaco при старте
- **Локация:**
  - `src/lib/tauriBridge.ts:336-348, 954-962, 2491` (`new BrowserPreviewEngine()`)
  - `src/main.tsx:1` (`import "./lib/monaco"`)
  - `src/lib/monaco.ts:1-13` (статический импорт 5 воркеров и полного `monaco-editor`)
- **Доказательство (Evidence):**
  1. В `src/lib/tauriBridge.ts:2491` на верхнем уровне модуля написано:
     ```ts
     const previewEngine = new BrowserPreviewEngine();
     ```
     Конструктор `BrowserPreviewEngine` (`tauriBridge.ts:336-348`) выполняется **всегда**, даже внутри нативного десктопного приложения Tauri: он читает ~15 ключей из `localStorage`, генерирует 18 демонстрационных сессий `createInitialMockSessions()` и запускает бесконечный `window.setInterval(..., 1800)` (`startTrafficLoop` на строке `958`). Кроме того, ~2 200 строк кода `BrowserPreviewEngine` и `mockTraffic.ts` навсегда попадают в основной production-бандл `index.js` (`1,062.14 kB`).
  2. В `src/main.tsx:1` синхронно импортируется `./lib/monaco`, который статически тянет `monaco-editor` (`4,623 kB`) и `ts.worker` (`7,046 kB`), хотя в FluxProxy Monaco используется только для просмотра/редактирования `json`, `xml`, `html`, `yaml`, `python` и `plaintext` (полный языковой сервис TypeScript `ts.worker` на 7 МБ вообще не востребован!).
- **Сценарий проявления и влияние (Impact):**
  Лишний расход RAM, фоновые срабатывания таймера каждые 1.8 с в нативном приложении и увеличение времени холодного старта WebView и размера дистрибутива на ~10 МБ.
- **Рекомендация по исправлению (Fix):**
  1. Лениво создавать `BrowserPreviewEngine` через геттер `getPreviewEngine()` только при `!isTauriRuntime()` (или загружать его через динамический `import("./browserPreviewEngine")`).
  2. В `src/lib/monaco.ts` убрать импорт `ts.worker` (направляя фолбэк в лёгкий `editor.worker` на 277 КБ) и загружать `monaco.ts` лениво при первом монтировании `MonacoBodyViewer` / `ScriptingPanel`.

---

#### `[PERF-06] [Severity: Low]` Лишние обращения к SQLite для пустых тел (`GET`), мёртвые индексы БД, неограниченный кэш PID и спавн `lsof` на каждое соединение на macOS
- **Локация:**
  - `src-tauri/src/storage/mod.rs:475-496, 754-780` (`list_Operator_annotations`, `get_hydrated`)
  - `src-tauri/src/storage/sqlite.rs:51-52` (`idx_sessions_url`, `idx_sessions_status`)
  - `src-tauri/src/proxy/process.rs:15-18, 414-436` (`ProcessResolver::pid_name_cache`, `lookup_owning_pid` на macOS)
- **Доказательство (Evidence):**
  1. В `get_hydrated` (`storage/mod.rs:759`) условие `if session.detail.request_body_base64.is_empty()` истинно для всех `GET`/`HEAD`/`DELETE` запросов без тела, из-за чего при экспорте или гидратации для каждого `GET`-запроса выполняется холостой `SELECT data FROM offloaded_bodies WHERE session_id = ?1 AND is_response = 0`.
  2. В `sqlite.rs:51-52` создаются индексы `idx_sessions_url` и `idx_sessions_status`, но ни один SQL-запрос в `sqlite.rs` не фильтрует и не сортирует по колонкам `url` или `status` — эти индексы только замедляют каждый `INSERT OR REPLACE` и раздувают файл `.sqlite`.
  3. В `ProcessResolver` (`process.rs:15-18`) кэш `pid_name_cache: DashMap<u32, (String, Instant)>` проверяет TTL при чтении, но никогда не очищает устаревшие PID при ротации процессов ОС. Кроме того, на macOS (`process.rs:414-436`) на каждое входящее loopback TCP-соединение синхронно спавнится внешний процесс `lsof -n -P -iTCP:<port> -sTCP:ESTABLISHED -Fp`.
- **Рекомендация по исправлению (Fix):**
  1. В `get_hydrated` проверять `if session.detail.body_offloaded` перед запросом к `offloaded_bodies`.
  2. Удалить неиспользуемые индексы `idx_sessions_url` и `idx_sessions_status` (или добавить SQL-поиск по архиву, если он планируется).
  3. Ограничить размер `pid_name_cache` (например, `4096` записей с очисткой при переполнении), а на macOS кэшировать вывод одного `lsof -n -P -iTCP -sTCP:ESTABLISHED -FnP` с TTL 250–500 мс или использовать `libproc` (`proc_pidinfo`).

---

### 5.6. Категория 5: Архитектурный техдолг и поддерживаемость

#### `[ARCH-01] [Severity: Low]` Концентрация ответственности в 11 сверхкрупных God-модулях и дублирование движка фильтрации между Rust и TypeScript
- **Локация:**
  - Backend: `src-tauri/src/proxy/server.rs` (7 759 строк), `src-tauri/src/storage/export_import.rs` (4 053 строки), `src-tauri/src/proxy/filters.rs` (2 571 строка), `src-tauri/src/proxy/sysproxy.rs` (2 276 строк), `src-tauri/src/scripting/python_runner.rs` (2 006 строк).
  - Frontend: `src/components/FilterDrawer.tsx` (3 820 строк), `src/App.tsx` (3 747 строк), `src/components/SettingsModal.tsx` (3 599 строк), `src/lib/tauriBridge.ts` (3 371 строка), `src/hooks/useProxySessions.ts` (3 337 строк), `src/lib/settingsManager.ts` (2 859 строк), `src/lib/filterEngine.ts` (2 328 строк).
- **Доказательство (Evidence):**
  Один файл `src-tauri/src/proxy/server.rs` совмещает: управление жизненным циклом TCP-сервера, обработку HTTP/1.1 и HTTP/2, генерацию TLS-туннелей, парсинг и стриминг SSE, двунаправленный релей и парсинг фреймов WebSocket, исполнение запросов Request Composer, встроенный веб-портал `http://flux.proxy` с HTML/CSS-шаблонами и 2 650 строк интеграционных тестов (`server.rs:5109-7759`).
- **Сценарий проявления и влияние (Impact):**
  Высокая когнитивная сложность при навигации, риск регрессий при правке смежных веток (например, расхождение конвейера `handle_intercepted_request` и `execute_composed`, где забыли вызвать Python-скрипты и очистить прерванный Breakpoint), а также дрейф логики фильтрации между `filters.rs` и `filterEngine.ts` (см. `[BUG-09]`).
- **Рекомендация по исправлению (Fix):**
  Поэтапная декомпозиция по доменным границам (см. подробный план и компромиссы в Разделе 7.4).

---

#### `[BUG-13] [Severity: Medium]` Гонка за эфемерный порт (Flaky Test) в `doctor_detects_stopped_port_and_fixes_listener_plus_e2e_health` при параллельном запуске `cargo test`
- **Локация:**
  - `src-tauri/src/proxy/doctor.rs:88-100` (`check_port_binding`)
  - `src-tauri/src/proxy/doctor.rs:1078-1128` (`doctor_detects_stopped_port_and_fixes_listener_plus_e2e_health`)
- **Доказательство (Evidence):**
  1. Тест `doctor_detects_stopped_port_and_fixes_listener_plus_e2e_health` (`doctor.rs:1082-1091`) выделяет порт через `TcpListener::bind("127.0.0.1:0")` (`free_ephemeral_port`), закрывает его, запускает `controller.start(port)`, тут же вызывает `controller.stop()` и сразу запускает `run_proxy_doctor(&controller)`.
  2. Внутри `check_port_binding` (`doctor.rs:88`) при `running == false` количество попыток пробного бинда жёстко равно `1`:
     ```rust
     let retry_attempts = if running { 6 } else { 1 };
     ```
     Если в момент между `controller.stop()` и `TcpListener::bind((bind_ip, port))` параллельно выполняющийся в том же процессе `cargo test` другой тест из `server.rs` (который тоже активно открывает эфемерные порты) или стек ОС ещё не завершил освобождение сокета, `TcpListener::bind` возвращает `AddrInUse`, статус проверки становится `"error"` вместо `"warning"`, и ассерт на строке `1100` падает:
     ```text
     thread 'proxy::doctor::tests::doctor_detects_stopped_port_and_fixes_listener_plus_e2e_health' panicked at src-tauri\src\proxy\doctor.rs:1100:9:
     assertion `left == right` failed
       left: "error"
      right: "warning"
     ```
- **Сценарий проявления и влияние (Impact):**
  Недетерминированные падения CI (`cargo test`) на многоядерных раннерах без изменений в коде.
- **Рекомендация по исправлению (Fix):**
  В `check_port_binding` (`doctor.rs:88`) использовать `let retry_attempts = if running { 6 } else { 3 };` с паузой `15 ms` между попытками, чтобы сгладить окно асинхронного закрытия слушателя Tokio после `shutdown_tx.send(())`.

---

## 6. Состояние тестирования, сборки и CI/CD

### 6.1. Фактические результаты выполнения проверочных команд в окружении аудита

Все команды были реально запущены в корне проекта `c:\Users\denis.davydov.MERCURY\Documents\Antigravity\Fiddler Clone` (Windows x64, Node `v24.14.0`, Rust `1.99.1`):

| Команда | Статус | Время | Фактический вывод и замечания |
| :--- | :---: | :---: | :--- |
| `npm run typecheck` (`tsc --noEmit`) | **PASS** | `~3.1s` | Exit code `0`, 0 ошибок типизации. |
| `npm run test` (`vitest run`) | **PASS** | `2.84s` | **11 тестовых файлов, 80 тестов пройдено** (`filterEngine`: 22, `settingsManager`: 14, `protocolInspectors`: 9, `tauriBridge.preview`: 9, `codeGenerators`: 5, `curlParser`: 5, `openApiGenerator`: 4, `useTheme`: 4, `useUiPreferences`: 3, `themeInitSync`: 3, `mockTraffic`: 2). |
| `npm run build` (`tsc && vite build`) | **PASS (WARN)** | `44.07s` | Exit code `0`, сгенерирован `dist/`. **Предупреждение Vite:** `(!) Some chunks are larger than 500 kB after minification`: `ts.worker-CE_y865M.js` (`7,046.03 kB`), `monaco-editor-CE9WXXuv.js` (`4,623.13 kB`), `index-BCXXaFob.js` (`1,062.14 kB`), `css.worker-CH7Os8C2.js` (`1,056.20 kB`), `html.worker-DTgyLzoY.js` (`718.83 kB`). |
| `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` | **PASS** | `~8.4s` | Exit code `0`, 0 предупреждений компилятора и линтера Clippy. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | **FLAKY (100/101 → 101/101)** | `8.59s` | На 1-м прогоне: `100 passed; 1 failed` (`proxy::doctor::tests::doctor_detects_stopped_port_and_fixes_listener_plus_e2e_health`, см. `[BUG-13]`). На 2-м полном прогоне и при изолированном запуске: **`101 passed; 0 failed`**. |

### 6.2. Аудит пайплайна CI/CD (`.github/workflows/ci.yml`)
Пайплайн `.github/workflows/ci.yml:1-109` состоит из двух джобов на `push` и `pull_request` в `main`/`master`:
1. **`frontend` (`ubuntu-latest`, Node 22):** выполняет `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
2. **`rust` (`ubuntu-22.04`, `windows-latest`, `macos-latest`, stable Rust):** выполняет `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` и `cargo test --manifest-path src-tauri/Cargo.toml`.

**Выявленные пробелы в CI/CD:**
- В `package.json` отсутствует ESLint/Biome линтер для TypeScript/React (проверяется только `tsc --noEmit`).
- В `cargo clippy` флаг `--all-targets` проверяет тестовые модули, но не проверяется `cargo audit` / `npm audit` на уязвимости зависимостей.
- Из-за `[BUG-13]` матричный джоб `rust` на 3 ОС подвержен случайным падениям теста `doctor_detects_stopped_port_and_fixes_listener_plus_e2e_health`.

### 6.3. Карта тестового покрытия и критические пробелы

| Модуль / Подсистема | Покрытие тестами | Что покрыто хорошо | Где зияют пробелы (негативные кейсы и интеграция) |
| :--- | :---: | :--- | :--- |
| **Rust: `proxy/server.rs`, `filters.rs`, `rules.rs`, `breakpoints.rs`** | Высокое (41 тест в `server.rs` + модульные тесты) | E2E MITM-перехват, AutoResponder, Breakpoints, SSE, WebSocket, mTLS, `flux.proxy` портал. | Нет тестов на обрыв клиентского сокета во время паузы на Breakpoint (`[BUG-04]`), нет тестов на `HEAD` `Content-Length` (`[BUG-07]`) и IPv6 authority (`[BUG-09]`). |
| **Rust: `storage/mod.rs`, `sqlite.rs`, `export_import.rs`** | Среднее (22 теста) | Оффлоад тел `> 2 MiB`, HAR/SAZ экспорт и импорт, базовое маскирование `snake_case` ключей. | **Нет теста на перезапуск `TrafficStore::new` поверх непустой `sessions.sqlite`** (`[BUG-01]`), нет теста на `clear_sqlite_archive` при живых сессиях с `body_offloaded: true` (`[BUG-03]`), нет проверки санитизации сырого `response_body_text` у SSE/WS и `camelCase` ключей (`[SEC-04]`). |
| **Rust: `commands.rs`** | **0 тестов** | — | Функция `validate_user_file_path` (`commands.rs:573-638`) не имеет ни одного unit-теста, из-за чего пропущен обход через `a/../../b` (`[SEC-02]`). |
| **Rust: `proxy/process.rs`** | **0 тестов** | — | Нет тестов парсинга `/proc/net/tcp`, вывода `lsof` и Win32 таблиц `GetExtendedTcpTable`. |
| **Frontend: `src/lib/*`** | Высокое (73 теста) | `filterEngine`, `settingsManager`, `protocolInspectors`, `codeGenerators`, `curlParser`, `openApiGenerator`, `tauriBridge.preview`. | В `settingsManager.test.ts` не проверяется безопасное поведение при импорте профиля с `scripting.enabled: true` (`[SEC-01]`). |
| **Frontend: `src/hooks/useProxySessions.ts` и `src/components/*.tsx`** | **0 тестов** | Тестируются только `useTheme` и `useUiPreferences`. | Главный хук `useProxySessions.ts` (3 337 строк) и все 28 React-компонентов (`TrafficGrid`, `SessionInspector`, `FilterDrawer`, `ComposerPanel`, `ScriptingPanel` и др.) **вообще не имеют компонентных/хук-тестов** (`@testing-library/react` не установлен), из-за чего не ловятся `[BUG-02]`, `[BUG-08]` и `[PERF-01]`. |

---

## 7. Приоритетный план улучшений (Actionable Roadmap)

### 7.1. Quick Wins (до 1–2 часов — быстрые и безопасные исправления с максимальной отдачей)

1. **`[PERF-01]` Убрать спам IPC-вызовов `getSessionDetail` при каждом новом запросе:**
   - В `src/hooks/useProxySessions.ts:1156` удалить `sessions.length` из массива зависимостей `useEffect`.
2. **`[BUG-08]` Устранить дубликаты сессий при флаше в пустую таблицу:**
   - В `src/hooks/useProxySessions.ts:776-780` убрать ветку `if (prev.length === 0) { next = incoming.slice(); }`, всегда выполняя слияние через `indexById`.
3. **`[BUG-02]` Защитить `bootstrap()` в `useProxySessions.ts` от потери подписок:**
   - В `src/hooks/useProxySessions.ts:819-1050` перенести регистрацию `subscribeSessionBatches` / `subscribe*` в начало `bootstrap()` и обернуть стартовые IPC-вызовы (`setBindConfiguration` и др.) в `try / catch`.
4. **`[SEC-01]` Заблокировать скрытый автозапуск Python-скриптов при импорте настроек:**
   - В `src/lib/settingsManager.ts:2283-2316, 2538-2545` при импорте внешнего профиля принудительно выставлять `scripting.enabled = false` и выводить в `SettingsImportPreviewSummary` индикатор наличия Python-кода в импортируемом файле.
5. **`[BUG-09]` Починить фильтрацию доменов с ведущей точкой `.example.com`:**
   - В `src-tauri/src/proxy/filters.rs:990, 1465` заменить `if host_has_wildcard(&pattern)` на `if host_has_wildcard(&pattern) || pattern.starts_with('.')`.
6. **`[BUG-13]` Стабилизировать flaky-тест `ProxyDoctor`:**
   - В `src-tauri/src/proxy/doctor.rs:88` увеличить `retry_attempts` для остановленного порта с `1` до `3` с паузой `15 ms`.

### 7.2. Критическое (P0 / P1 — устранение потери данных и уязвимостей безопасности)

1. **`[BUG-01]` & `[BUG-03]` Исправить коллизию ID сессий и потерю выгруженных тел в SQLite:**
   - Инициализировать `TrafficStore::next_id` значением `MAX(id) + 1` из таблиц `sessions` и `offloaded_bodies` (`src-tauri/src/storage/mod.rs:76`, `sqlite.rs`).
   - Обращаться к `offloaded_bodies` в `load_session_body`, `get_hydrated` и `extract_raw_body_bytes` только при `detail.body_offloaded == true`.
   - В `clear_sqlite_archive` (`sqlite.rs:380-397`) не удалять строки `offloaded_bodies`, принадлежащие активным сессиям в RAM (`self.sessions`).
2. **`[SEC-02]` Закрыть Path Traversal и произвольную перезапись файлов в `commands.rs`:**
   - Запретить `Component::ParentDir` (`..`), UNC-пути и ADS в `validate_user_file_path` (`src-tauri/src/commands.rs:573-638`).
   - Привязать файловые команды (`save_session_body_file`, `export_sessions_file`, `import_settings_file` и др.) к реестру путей, явно выбранных пользователем через нативные диалоги `pick_save_file_dialog` / `pick_open_file_dialog`.
3. **`[SEC-04]` Устранить утечки секретов в санитизированном экспорте (`export_import.rs`):**
   - Пересобирать `detail.response_body_text` и `detail.response_body_base64` после санитизации `sse_events` и `websocket_frames` (`src-tauri/src/storage/export_import.rs:1285-1305`).
   - Нормализовать ключи JSON (удаляя `_` и `-` перед сверкой с `SENSITIVE_BODY_KEYS`), чтобы редактировались `accessToken`, `refreshToken`, `apiKey`, `clientSecret`, `cardNumber`.
   - Очищать `userinfo`, `#fragment` и query-параметры в заголовках `Location` / `Referer`.
4. **`[SEC-03]` Защитить LAN-режимы (`AllInterfaces` / `Specific`) от SSRF к localhost и утечки mTLS:**
   - Запретить проксирование и `CONNECT`-туннелирование к loopback-адресам хоста для не-loopback клиентов (`!peer_addr.ip().is_loopback()`) и не прикреплять хозяйские mTLS-сертификаты к внешним LAN-запросам без явного разрешения.
5. **`[SEC-05]` Ввести жёсткие лимиты декомпрессии и буферизации:**
   - Добавить кумулятивный счётчик распакованных байтов в `import_saz` (`export_import.rs:2434`), заменить `zstd::decode_all` на потоковый `zstd::stream::read::Decoder` с `.take(limit)` в `server.rs:213` и `codec.rs:78`, ограничить буферизацию chunked-ответов.
6. **`[BUG-04]`, `[BUG-05]`, `[BUG-06]`, `[BUG-07]` Исправить сетевые и протокольные дефекты ядра:**
   - Добавить `Drop`-гард для очистки `BreakpointEngine::pending` при дисконнекте клиента (`breakpoints.rs`, `server.rs:2728`).
   - Разделить чтение и запись в WebSocket-релее (`server.rs:4061-4108`) во избежание deadlock и добавить таймаут подключения `wss://`.
   - Проверять SHA-256 отпечаток Root CA в `certutil`/`security` на Windows и macOS (`ca.rs:317-335`).
   - Сохранять `Content-Length` для `HEAD`-ответов (`server.rs:3808`).

### 7.3. Стабилизация, производительность и тесты (P2)

1. **`[PERF-03]` Предкомпиляция правил в `ProxyFilterEngine` (`src-tauri/src/proxy/filters.rs`):**
   - Компилировать все glob/regex шаблоны `tls_bypass_rules`, `tls_target_rules` и `header_mutations` один раз в `set_config`, полностью исключив `Regex::new` из `should_intercept_tls` и `apply_header_mutations`.
2. **`[PERF-02]` & `[BUG-11]` Вынос SQLite I/O с потоков Tokio и батч-вытеснение:**
   - Убрать холостой вызов `ctx.store.get(new_session_id)` из `record_in_flight_session` (`server.rs:319`).
   - Защитить `clear()` и `remove_many()` мьютексом `eviction_lock`, удалять сессии из `DashMap` только после успешного `persist_batch` и вытеснять пачками по 64–128 записей.
3. **`[PERF-05]` Оптимизация бандла и холодного старта фронтенда:**
   - Сделать инициализацию `BrowserPreviewEngine` ленивой (`if (!isTauriRuntime())`) и исключить 7-мегабайтный `ts.worker` из `src/lib/monaco.ts`.
4. **Расширение тестового покрытия:**
   - Добавить unit-тесты для `validate_user_file_path` в `commands.rs`, тесты перезапуска `TrafficStore` с существующей SQLite БД и тесты санитизации SSE/WS/`camelCase` JSON.

### 7.4. Архитектурный рефакторинг (P3) и взвешивание компромиссов (Trade-offs)

1. **Декомпозиция `src-tauri/src/proxy/server.rs` (7 759 строк):**
   - *План:* разделить на `proxy/controller.rs` (жизненный цикл и биндинг), `proxy/http_pipeline.rs` (перехват HTTP/HTTPS), `proxy/streaming.rs` (SSE и медиа-стримы), `proxy/websocket.rs` (WS-релей и фреймы), `proxy/composer.rs` (`execute_composed`, переиспользующий общие шаги пайплайна с `http_pipeline.rs`), `proxy/portal.rs` (`flux.proxy/*`).
   - *Компромисс (Trade-off):* потребует аккуратного выделения внутренней структуры контекста `Arc<ProxyPipelineContext>` с видимостью `pub(super)`, но позволит устранить дублирование кода между `handle_intercepted_request` и `execute_composed` (объём `server.rs` сократится в ~4 раза).
2. **Единый источник правды для движка фильтрации (`filters.rs` ↔ `filterEngine.ts`):**
   - *Компромисс (Trade-off):* клиентская фильтрация в TypeScript (`src/lib/filterEngine.ts`) необходима для мгновенного (0 мс) отклика UI при вводе поискового запроса по уже загруженным в RAM сессиям без гонки данных через IPC, тогда как Rust-фильтр (`src-tauri/src/proxy/filters.rs`) нужен для режима `Drop Non-Matching on Capture` на входе прокси. Полностью сливать их в один слой через IPC нецелесообразно из-за задержек рендера таблицы, но необходимо покрыть оба движка единым JSON-набором кросс-языковых тестовых векторов (shared fixture tests).

---

## 8. Открытые вопросы и зоны неопределённости (`[Требует проверки]`)

1. **`[Требует проверки]` Продуктовое намерение по отсутствию Python-хуков в Request Composer (`src-tauri/src/proxy/server.rs:1544-2122`):**
   - Сейчас запросы, отправляемые вручную из вкладки **Request Composer** (`execute_composed`), проходят через Header Mutations, Live Breakpoints (`Before Request` / `After Response`) и AutoResponder, но **не вызывают** Python-хуки `on_request` и `on_response`. Необходимо подтвердить у автора проекта: является ли это намеренным решением (чтобы скрипт не перезаписывал ручной запрос) или пропуском при реализации Этапа 27 (например, для автоматического расчёта HMAC-подписи в Composer через Python-скрипт).
2. **`[Требует проверки]` Поведение `Purge SQLite Archive` (`clear_sqlite_archive`) для крупных тел активных сессий (`src-tauri/src/storage/mod.rs:162-169`):**
   - Следует ли при нажатии кнопки `SQLite: X.X MB (Purge & VACUUM)` в статус-баре сохранять в таблице `offloaded_bodies` тела (`> 2 MiB`) тех сессий, которые всё ещё находятся в оперативной памяти (`self.sessions`), удаляя только тела уже вытесненных архивных сессий?
3. **`[Требует проверки]` Политика хранения приватных ключей mTLS из парольных `.p12`/`.pfx` (`src-tauri/src/proxy/client_certs.rs:640-652`):**
   - Должен ли FluxProxy сохранять клиентские сертификаты на диск между перезапусками (с шифрованием через ОС Keychain / Windows DPAPI), или для корпоративных `.p12`/`.pfx` с паролем требуется режим хранения ключа только в оперативной памяти до закрытия приложения (*Session-only / In-Memory mode*)?
4. **`[Требует проверки]` Использование индексов `idx_sessions_url` и `idx_sessions_status` в `sessions.sqlite` (`src-tauri/src/storage/sqlite.rs:51-52`):**
   - Планируется ли в ближайших релизах серверный SQL-поиск по вытесненному архиву SQLite (в этом случае индексы пригодятся), или они остались от раннего прототипа и их следует удалить (`DROP INDEX IF EXISTS`) для ускорения записи?
5. **`[Требует проверки]` Защита доступа при работе в режиме `AllInterfaces` (`0.0.0.0`) для мобильной отладки (`src-tauri/src/proxy/server.rs:517-585`):**
   - Какой UX предпочтителен для защиты от несанкционированных подключений из локальной сети при отладке смартфонов: автоматический одноразовый PIN/подтверждение нового IP-адреса клиента во всплывающем тосте FluxProxy или настраиваемый в UI список разрешённых IP (`Client IP Allowlist`)?
