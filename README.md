# ⚡ FluxProxy — Modern Cross-Platform Web Debugging Proxy

<div align="center">

[![Latest Release](https://img.shields.io/github/v/release/maq3000/flux-proxy?color=blue&logo=github)](https://github.com/maq3000/flux-proxy/releases/latest)
[![CI](https://github.com/maq3000/flux-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/maq3000/flux-proxy/actions/workflows/ci.yml)
[![Downloads](https://img.shields.io/github/downloads/maq3000/flux-proxy/total?color=success&logo=github)](https://github.com/maq3000/flux-proxy/releases)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2.2-blue?logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-2021_%281.80%2B%29-orange?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![React 18](https://img.shields.io/badge/React-18.3-61dafb?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3.4-38bdf8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Высокопроизводительный кроссплатформенный аналог Fiddler Classic, Charles Proxy и Proxyman**, созданный на базе **Tauri v2 (Rust)** и **React 18 (TypeScript)**.

Мгновенный запуск, умный контроль памяти, аппаратное ускорение интерфейса и стабильные 60 FPS при работе с десятками тысяч перехваченных запросов.

> 📥 **Скачать готовую сборку для Windows:** [**FluxProxy Setup v0.5.0 (.exe)**](https://github.com/maq3000/flux-proxy/releases/download/v0.5.0/FluxProxy_0.5.0_x64-setup.exe) или [**MSI-пакет (.msi)**](https://github.com/maq3000/flux-proxy/releases/download/v0.5.0/FluxProxy_0.5.0_x64_en-US.msi). Подробнее см. раздел [Скачать готовые сборки](#-скачать-готовые-сборки-releases).
>
> 📖 **Ищете понятную инструкцию по работе с программой?** Откройте [**Руководство пользователя (USER_GUIDE.md)**](USER_GUIDE.md) — пошаговое описание всех возможностей простым языком: от первого запуска и настройки телефона до подмены ответов и сравнения запросов.
>
> 🐍 **Нужна программируемая модификация трафика на Python?** Откройте [**Руководство по Python Scripting Engine (PYTHON_SCRIPTING_GUIDE.md)**](PYTHON_SCRIPTING_GUIDE.md) — API хуков `on_request` / `on_response`, локальные моки, готовые рецепты и отказоустойчивость. Для генерации скриптов с помощью нейросетей используйте [**инструкцию для AI-агентов (PYTHON_SCRIPTING_AI_GUIDE.md)**](PYTHON_SCRIPTING_AI_GUIDE.md).
>
> 🗺️ **План развития проекта и спецификации задач:** См. [**Дорожную карту проекта (ROADMAP.md)**](ROADMAP.md).

</div>

---

## 📋 Оглавление

- [📥 Скачать готовые сборки (Releases)](#-скачать-готовые-сборки-releases)
- [📖 Руководство пользователя (USER_GUIDE.md)](USER_GUIDE.md)
- [🐍 Руководство по Python Scripting Engine (PYTHON_SCRIPTING_GUIDE.md)](PYTHON_SCRIPTING_GUIDE.md)
- [🤖 Инструкция для AI-агента по Python-скриптам (PYTHON_SCRIPTING_AI_GUIDE.md)](PYTHON_SCRIPTING_AI_GUIDE.md)
- [🗺️ Дорожная карта проекта (ROADMAP.md)](ROADMAP.md)
- [Особенности и возможности](#-особенности-и-возможности)
- [Архитектура и стек технологий](#-архитектура-и-стек-технологий)
- [Структура проекта](#-структура-проекта)
- [Быстрый старт](#-быстрый-старт)
  - [1. Режим UI Preview Simulator (без Rust)](#1-режим-ui-preview-simulator-без-rust)
  - [2. Полнофункциональный режим приложения (Tauri + Rust)](#2-полнофункциональный-режим-приложения-tauri--rust)
  - [3. Сборка релизного пакета](#3-сборка-релизного-пакета)
- [Настройка HTTPS MITM Decryption (Root CA)](#-настройка-https-mitm-decryption-root-ca)
- [Перехват трафика с мобильных устройств (iOS / Android)](#-перехват-трафика-с-мобильных-устройств-ios--android)
- [Горячие клавиши (Keyboard Shortcuts)](#-горячие-клавиши-keyboard-shortcuts)
- [Интеграция с CLI инструментами](#-интеграция-с-cli-инструментами)
- [Дорожная карта (Roadmap)](#-дорожная-карта-roadmap)
- [Разработка и Contributing](#-разработка-и-contributing)

---

## 📥 Скачать готовые сборки (Releases)

Для запуска FluxProxy на **Windows** вам не требуется компилировать проект из исходных кодов — вы можете скачать готовые официальные установщики из [**GitHub Releases v0.5.0**](https://github.com/maq3000/flux-proxy/releases/tag/v0.5.0):

| Дистрибутив | Версия | Архитектура | Описание | Ссылка на загрузку | Контрольная сумма (SHA-256) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Windows Setup (`.exe`)** | `v0.5.0` | x64 | **Рекомендуемый** автономный инсталлятор (NSIS). Автоматическое создание ярлыков на рабочем столе и в меню «Пуск», встроенный деинсталлятор. | [📥 **FluxProxy_0.5.0_x64-setup.exe** (8.4 МБ)](https://github.com/maq3000/flux-proxy/releases/download/v0.5.0/FluxProxy_0.5.0_x64-setup.exe) | `7d829e4966cbbc8a5b5e22b9f417efb519dc2cc851271c53aedc0e070a4ad00a` |
| **Windows Package (`.msi`)** | `v0.5.0` | x64 | Пакет Windows Installer (MSI). Оптимизирован для тихой установки (`msiexec /i ... /qn`) и автоматизированного развертывания через Active Directory (GPO). | [📥 **FluxProxy_0.5.0_x64_en-US.msi** (11.3 МБ)](https://github.com/maq3000/flux-proxy/releases/download/v0.5.0/FluxProxy_0.5.0_x64_en-US.msi) | `231bdd82b54ad6be97ef9251706e49c0d30be80a80a0bbd7b9782b9a34f19152` |

> 📦 **Все релизы проекта:** [github.com/maq3000/flux-proxy/releases](https://github.com/maq3000/flux-proxy/releases)  
> 🐧 🍏 **macOS и Linux:** На текущем этапе сборка выполняется из исходного кода с помощью команды `npx @tauri-apps/cli build` (см. раздел [Быстрый старт](#-быстрый-старт)). Готовые дистрибутивы `.dmg` и `.AppImage` будут доступны в следующих релизах.

---

## ✨ Особенности и возможности

### 🚀 Сетевое ядро перехвата (Rust MITM Core)
- **HTTP/1.1 и HTTP/2**: Прозрачный перехват и мультиплексирование потоков с автоматическим выбором протокола (`hyper-util auto`).
- **Двухфазный захват сессий (In-Flight / Pending)**: Мгновенное появление запроса в таблице еще до ответа сервера (`Pending`) с реальной инспекцией исходящих данных и последующим обновлением статуса, таймингов и ответа.
- **Zero-Buffering видео/CDN-стриминг и надежность upstream**: Потоковая передача медиа, `206 Partial Content` и крупных ответов без буферизации, мгновенный сброс активных MITM-туннелей в Passthrough при изменении правил и диагностика сбоев с полной цепочкой причин (`err.source()`).
- **Расшифровка HTTPS на лету и Zstandard (`zstd`)**: Динамическая генерация X.509 сертификатов (ECDSA P-256) под целевые домены через `rcgen` с LRU-кэшированием (`moka`), прозрачная потоковая распаковка `Content-Encoding: zstd` (RFC 8878) с лимитами от OOM-бомб, сохранение оригинального `Content-Length` для `HEAD` и точное снятие `Content-Encoding` только для распакованных слоёв.
- **Избирательный перехват (Selective MITM & TLS Bypass 2.0)**: Режимы *Intercept All* и *Targeted Allowlist* (с защитой от подмены внутреннего заголовка `Host`), переключение `Table View` ↔ `Bulk Text Editor`, диалог `Quick Paste…`, импорт/экспорт TXT/JSON, **11 готовых Quick-Packs** (включая *OCSP / CRL PKI*, *Payment Gateways*, *Gaming & Anti-Cheat*, *РФ FinTech & Госуслуги* и *Video & CDN*), сброс к рекомендованным PKI-дефолтам, предкомпилированные Regex-правила с поддержкой суффиксов `.domain.com` и IPv6, lock-free счётчики попаданий `Hits: N` и бейдж `TUNNEL` в таблице.
- **Клиентские сертификаты (mTLS, `Ctrl+Shift+C`)**: Хранилище сертификатов **PKCS#12 (`.p12` / `.pfx`)** и **PEM** с привязкой к точным и wildcard-маскам доменов (`*.corp.local`), прозрачным шифрованием приватных ключей на диске через **Windows DPAPI** (`FLUX_DPAPI_V1:<base64>`, автоматическая миграция старых PEM-файлов, права `0600` на Unix), режимом **`Session-only (In-Memory)`** (`RAM ONLY` — ключ и сертификат хранятся только в RAM и не записываются на диск), изоляцией от внешних LAN-клиентов и передачей mTLS-идентичности через инструментированный `UpstreamHttpClient` (`tokio-rustls`).
- **Блокировка обхода через HTTP/3 (QUIC)**: Автоматическое удаление заголовков `Alt-Svc` и `Alternate-Protocol`, предотвращающее уход современных браузеров в UDP-туннель мимо системного прокси.
- **Перехват WebSocket (WS/WSS), ручная инъекция фреймов и SSE**: Инкрементальное декодирование кадров в реальном времени ($O(1)$ append без лишних аллокаций, `tokio-tungstenite`), конкурентный двунаправленный релей без взаимных блокировок с upstream-таймаутом подключения и полной передачей заголовков авторизации/субпротоколов (включая SignalR), а также **ручная инъекция WebSocket-фреймов** в активные соединения (`Text` / `JSON` / `Hex (Binary)` → *Send to Server* / *Send to Client*).
- **Инструментированный транспорт, Fiddler-тайминги и статистика (`SessionTimers`)**: Собственный коннектор на базе `hyper-util` + `tokio-rustls` с замером фаз `DNS`, `TCP Connect`, `TLS Handshake`, `Send`, `Wait (TTFB)` и `Content Download`, учётом wire vs decoded байт, реального TLS-протокола/шифра/ALPN, переиспользования keep-alive сокетов (`CltReuse` / `Reused`), раздельными таймаутами `Connect` / `Response Headers (TTFB)` (по умолчанию `Unlimited`) / `Composer` и RAII-финализацией оборванных клиентом запросов со статусом `499`.
- **Виртуальный DNS (`HOSTS Remapping`, `Ctrl+Shift+H`) и Bandwidth Throttling**: Локальное перенаправление доменов и wildcard-масок на заданный IP/порт с сохранением TLS SNI и заголовка `Host` (бейдж `REMAP`), а также эмуляция медленных каналов и офлайна (*GPRS*, *Slow 3G*, *Fast 3G*, *LTE / 4G*, *Offline HTTP 503*, *Custom*) с шейпингом чтения/записи и RTT-задержкой.
- **Каскадирование через внешний прокси (`Upstream Proxy Chaining`, `Ctrl+Shift+U`)**: Поддержка исходящих `HTTP`, `HTTPS CONNECT` и `SOCKS5` (RFC 1928/1929) прокси с опциональной аутентификацией (пароль хранится только в RAM и не попадает в экспортируемые профили), индикацией **`via <proxy>`** в `Server IP` / `Statistics` и гибким `bypass_list` (`localhost`, `<local>`, CIDR, `*.domain`, glob, `host:port`) для HTTP, HTTPS/mTLS, `CONNECT`-туннелей, Composer и WebSocket.
- **Гибкая привязка к IP и контроль LAN-доступа (`Dual Listener` + `LAN Client Allowlist`)**: Точный выбор сетевого интерфейса (*Loopback Only*, *All Interfaces `0.0.0.0`* или *Specific Interface* — Wi-Fi / Ethernet / WSL / VPN + опциональный одновременный loopback-листенер), опциональный белый список **`LAN Client Allowlist`** (точные IPv4/IPv6 и CIDR-подсети — неразрешённые внешние устройства получают `403 Forbidden` до записи сессии, loopback разрешён всегда), защита от LAN SSRF к локальным сервисам `127.0.0.1` / `localhost` / `::ffff:127.0.0.1`, автоматический откат системного прокси при сбое бинда, неблокирующий Tokio-рантайм (`spawn_blocking` для OS/SQLite), кэш процессов (`pid_name_cache`, до 4096 записей) и проверка доверия Root CA по точному SHA-256 отпечатку.

### 🛠 Инструменты анализа и модификации
- **Протокольные анализаторы и статистика в Session Inspector**:
  - Переключатель **`Inspectors | Statistics`** в шапке инспектора (плюс клик по бейджу `size • duration` или через `Ctrl+K`): в режиме **1 сессии** отображаются шкала фаз (`DNS`/`TCP`/`TLS`/`Send`/`Wait`/`Download`), таблица `ACTUAL PERFORMANCE`, `Bytes & Compression`, `Connection & TLS` и сворачиваемый блок *Estimated Worldwide Performance*; при выделении **2+ сессий** — агрегированные KPI, перцентили `P50 / P95 / P99`, `% Reused`, inline SVG-диаграммы статусов/MIME и топ медленных/крупных URL с копированием отчётов (`Copy Text` / `Copy Markdown`).
  - Заголовки, Query-параметры, Cookies с флагами безопасности, предпросмотр изображений, виртуализированный **Hex Viewer** (`@tanstack/react-virtual`) и быстрое переключение вкладок активной панели клавишами **`Ctrl+1` … `Ctrl+6`**.
  - **JSON / XML Viewer** на базе **Monaco Editor** с подсветкой синтаксиса, поиском и форматированием.
  - **SSE & LLM Stream Inspector**: разбор потоков `text/event-stream` и сборка чанков ответов нейросетей (OpenAI, Anthropic, Gemini) в единый связный текст в один клик.
  - **gRPC & Protobuf Wire Decoder**: декодирование бинарных Protobuf-сообщений и проекция в JSON без `.proto`-файлов.
  - **Auth & Caching Inspectors**: аудит безопасности Basic/Bearer/JWT токенов и анализ HTTP-кэширования по RFC 9111.
  - **Multipart Form Inspector**: разбор `multipart/form-data` с безопасным мини-превью растровых изображений (`PNG`, `JPEG`, `GIF`, `WebP`, `BMP`, `ICO`; `image/svg+xml` исключён из рендера).
- **Эргономика таблицы и адаптивный интерфейс**:
  - Интерактивная сортировка всех **12 колонок** таблицы (`ASC` / `DESC`, включая опциональные колонки **`TTFB`** и **`Server IP`** и пофазный tooltip на ячейке `Time`), массовое выделение видимых сессий (`Ctrl+A`), автоподбор ширины колонок из контекстного меню шапки (**Auto-fit**), однострочный **Slim Toolbar (`Ctrl+Shift+T`)** и персистентность геометрии всех сплит-панелей и ориентации Инспектора между перезапусками.
- **Диагностический мастер «Proxy Doctor» (`Ctrl+Shift+D`)**:
  - Проверка сокета и конфликта порта, доверия Root CA, синхронизации системного прокси ОС, конфликтующих VPN/TUN-интерфейсов, брандмауэра Windows и сквозного пробника `http://flux.proxy/health` с 1-клик автоисправлением (**Fix All Fixable**).
- **Live Breakpoints (Точки останова, `F11` / `Alt+F11`)**:
  - Пауза до отправки запроса (*Before Request*) или после ответа сервера (*After Response*), условные ловушки по URL (`bpu` / `bpafter`), редактирование заголовков, статусов и тел на лету, а также RAII-очистка зависших точек останова при разрыве соединения клиентом (`499`) и корректное завершение при `Abort` в Composer (`502`).
- **AutoResponder & Header Mutations**:
  - Мокирование ответов без правки бэкенда, переопределение HTTP-статусов и эмуляция сетевой задержки (Latency).
  - Автоматические мутации заголовков (*Force No-Cache*, *CORS Injection*, пресеты *User-Agent*).
- **Python Scripting Engine (`Alt+5`)**:
  - Программируемая обработка и мокирование трафика на лету с помощью хуков `on_request(request)` и `on_response(response, request)` через долгоживущий IPC-процесс Python 3 (fail-open, таймаут 1500 мс с разделением ожидания очереди от таймаута пайпа без убийства воркера), встроенный Monaco Editor, готовые пресеты и живую консоль вывода. Подробнее см. [**PYTHON_SCRIPTING_GUIDE.md**](PYTHON_SCRIPTING_GUIDE.md) и [**PYTHON_SCRIPTING_AI_GUIDE.md**](PYTHON_SCRIPTING_AI_GUIDE.md).
- **HTTP Composer 2.0, Code Generator & Session Diff**:
  - Конструктор запросов с поддержкой **Drag-and-Drop** строк из таблицы, параллельным режимом (*Split Composer*), чекбоксом **`Run Python Scripts`** (по умолчанию хуки `on_request` / `on_response` применяются к Composer и `Replay`), настройкой таймаута и кнопкой отмены **`Cancel`**, умным **Import / Paste cURL** (поддержка POSIX Bash, Windows cmd и PowerShell прямо при вставке в URL или через диалог) и генератором клиентского кода на **5 языках** (8 таргетов: *JavaScript `fetch`/`axios`*, *Python `requests`/`httpx`*, *Go `net/http`*, *Rust `reqwest`*, *cURL Bash/PowerShell*).
  - Визуальное сравнение двух сессий (**Session Diff**, `Ctrl+D`) с сортировкой ключей JSON и фильтрацией динамических заголовков.
- **Генератор спецификаций OpenAPI 3.0.3 / Swagger**:
  - Автоматический синтез OpenAPI 3.0.3 контрактов (`YAML` / `JSON`) по выбранным или всем захваченным сессиям (`File → Export as OpenAPI 3.0 Spec…` или контекстное меню таблицы): параметризация числовых/UUID-сегментов (`{id}`, `{uuid}`), рекурсивное слияние JSON Schema, безопасный вынос `Authorization` / `Cookie` / `X-Api-Key` в `components.securitySchemes` без раскрытия секретов и предпросмотр в Monaco Editor.
- **Темы оформления и детальный редактор палитры**:
  - 8 встроенных цветовых тем-пресетов (*Flux Dark*, *Flux Light*, *Dracula*, *Tokyo Night*, *Nord*, *Fiddler Classic*, *GitHub Dark*, *Monokai Pro*) в настройках (`Ctrl+,` → *UI & Columns*) и командной палитре (`Ctrl+K`), детальный редактор CSS-токенов (фоны, акценты, цвета статусов) и мгновенная синхронизация темы **Monaco Editor**.
- **Text Wizard & Codec Suite (`Ctrl+E`)**:
  - Декодер JWT с проверкой срока жизни токена, конвертеры Base64, URL, Hex, Unix Timestamp и сжатие/распаковка Gzip / Brotli / Deflate / Zstd.

### 💾 Управление памятью, SQLite и профили настроек
- **Кольцевой буфер (Ring Buffer), SQLite и защита памяти**:
  - Ограничение числа хранимых сессий в стиле Fiddler (`Keep: All / 100..10 000 / Custom...`) с пакетным вытеснением с гистерезисом в SQLite (`busy_timeout` до WAL, консистентный счётчик `next_id` поверх существующей БД и автоматическая дочитка вытесненных тел).
  - Управление размером `sessions.sqlite`: индикатор `SQLite: X.X MB` в статус-баре, ручной `VACUUM` + `wal_checkpoint(TRUNCATE)` с сохранением выгруженных тел (`> 2 MiB`) активных RAM-сессий и опция *Clear DB on App Exit* в настройках.
  - Режим **Drop Non-Matching on Capture** — отбрасывание фонового шума на этапе захвата без расхода оперативной памяти.
  - Ленивая подгрузка тяжелых тел (> 2 МБ) с диска только при открытии в инспекторе.
- **Полная совместимость форматов и Sanitized Export (`Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+O`)**:
  - Экспорт и импорт индустриального стандарта **HAR 1.2 (`.har`)** и архивов **Fiddler Classic (`.saz`)** с реальным round-trip пофазных таймингов (`timings`, `<SessionTimers>`, `<PipeInfo>`), сжатия и `serverIPAddress`, **JSON**, сырых HTTP-сообщений (`.txt`) с защитой файлового IPC от Path Traversal / UNC / NTFS ADS, поддержкой `zstd` и защитой парсеров от ZIP/OOM-бомб (включая кумулятивный лимит 512 MiB и UTF-16BE), а также выгрузка отдельных тел запросов и ответов в файлы.
  - **Sanitized Export (`Ctrl+Shift+S`)**: безопасная передача архивов `.har`, `.saz`, `.json` и `.txt` с настраиваемым маскированием секретных заголовков (`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `Location`, `Referer`), рекурсивных ключей в JSON (включая `camelCase`: `accessToken`, `apiKey`, `clientSecret`) и `form-urlencoded`, потоков **SSE** и фреймов **WebSocket** (включая SignalR, Socket.IO и Bearer/JWT), query-параметров, URL `userinfo`/`#fragment` и опциональной анонимизацией IP/имени процесса и `client_conn_id` клиента (пресеты *Safe Sharing*, *Strict Anonymization*, *Custom*).
  - Поддержка **Drag-and-Drop** файлов `.har`, `.saz` и `.json` прямо в окно программы.
- **Централизованные настройки, профили и единый старт (`Preferences`, `Ctrl+,`)**:
  - Единое окно управления интерфейсом, портом прокси (с сохранением стартового порта в `proxy_port.pref` без двойного запуска), колонками, фильтрами и правилами.
  - Версионированный экспорт и импорт профиля настроек (`fluxproxy-settings-v1.json`, лимит 16 MiB) с превью изменений (и предупреждением о наличии Python-скрипта — по умолчанию импортируемые скрипты отключаются в целях безопасности до явного подтверждения доверия), сохранением конфигурации точек останова (`breakpoints`), правил санитизации, **HOSTS Remapping**, **Bandwidth Throttling**, **`UpstreamTimeouts`**, **`LAN Client Allowlist`**, беспарольной конфигурации **Upstream Proxy** и ориентации сплит-панелей, а также транзакционным применением с откатом при сбое.

---

## 🏗 Архитектура и стек технологий

```text
┌─────────────────────────────────────────────────────────────┐
│                   React 18 Frontend UI                      │
│   (Vite, TypeScript, Zustand 5, Tailwind, Monaco, Virtual)  │
└──────────────────────────────┬──────────────────────────────┘
                               │  Tauri IPC (Commands / Events)
┌──────────────────────────────▼──────────────────────────────┐
│                    Tauri v2 Desktop Core                    │
│   (lib.rs, commands.rs, models.rs, HAR/SAZ & SQLite Store)  │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                  Asynchronous MITM Engine                   │
│   ├── Hyper 1.x + Tokio (HTTP/1.1 & HTTP/2, UpstreamClient) │
│   ├── Two-Phase In-Flight Capture, SessionTimers & Zstd     │
│   ├── Tokio-Rustls + rcgen + Moka (ECDSA CA & mTLS Client)  │
│   ├── HOSTS Remap, Throttling, Upstream HTTP/HTTPS/SOCKS5   │
│   ├── Tokio-Tungstenite (WS/SignalR Relay & Frame Inject)   │
│   ├── Breakpoints, AutoResponder, Mutations & Python IPC    │
│   └── Dual-Bind Listener, SysProxy, SQLite & OS Resolver    │
└─────────────────────────────────────────────────────────────┘
```

| Компонент | Назначение | Используемые технологии |
| :--- | :--- | :--- |
| **Desktop Runtime** | Оконный менеджер, нативные диалоги, IPC, CSP | [Tauri v2](https://tauri.app/) (Rust 2021), `rfd` |
| **Сетевой движок** | Инструментированный HTTP/HTTPS транспорт, upstream-прокси и шейпинг | `tokio`, `hyper 1.5`, `hyper-util` |
| **TLS, Root CA & mTLS** | MITM-расшифровка, шифрование ключей (DPAPI), доверие ОС и mTLS | `rustls`, `tokio-rustls`, `rcgen`, `moka`, `p12-keystore`, `x509-parser`, `windows-sys` (Win32 DPAPI) |
| **WebSockets** | Перехват, декодирование и ручная инъекция фреймов WS/WSS | `tokio-tungstenite`, `DashMap` |
| **Python Scripting** | Долгоживущий IPC-раннер хуков `on_request` / `on_response` | Python 3 subprocess (`JSON Lines`, fail-open 1500 ms) |
| **Хранилище и архивы** | Ring Buffer в RAM, база SQLite, экспорт/импорт HAR/SAZ с таймингами | `DashMap` + `rusqlite` (WAL) + `zip` |
| **Кодеки и сжатие** | Сжатие/распаковка и кодировки | `flate2` (Gzip/Deflate), `brotli`, `zstd`, `base64`, `hex`, `sha2` |
| **Frontend UI и State** | Модульный интерфейс, 8 тем-пресетов, state-сторы и `React.lazy()` | `React 18`, `TypeScript 5.6`, `Zustand 5`, `Vite 6`, `Tailwind CSS` |
| **Виртуализация и код** | Скроллинг 60 FPS, редакторы, OpenAPI и diff-сравнение | `@tanstack/react-virtual 3`, `@monaco-editor/react` |
| **Тестирование и CI** | 96 frontend-тестов + 170 Rust-тестов, матрица Windows/Linux/macOS | `Vitest 3`, `@testing-library/react`, `cargo clippy`, GitHub Actions |

---

## 📁 Структура проекта

```text
├── .github/workflows/ci.yml             # Кроссплатформенный CI (typecheck, Vitest, build, clippy, cargo test)
├── index.html                           # HTML точка входа Vite
├── package.json                         # Зависимости и npm-скрипты фронтенда
├── USER_GUIDE.md                        # Подробная инструкция для пользователей
├── PYTHON_SCRIPTING_GUIDE.md            # Руководство по встроенному Python Scripting Engine
├── PYTHON_SCRIPTING_AI_GUIDE.md         # Спецификация для AI-агентов по генерации скриптов FluxProxy
├── ROADMAP.md                           # Дорожная карта развития проекта
│
├── src/                                 # Исходный код Frontend UI (React + TypeScript)
│   ├── components/                      # Компоненты интерфейса (с React.lazy для тяжёлых окон)
│   │   ├── filters/                     # Вкладки FilterDrawer (FilterMatrixTab, TlsBypassTab, HostFiltersTab и др.)
│   │   ├── settings/                    # Вкладки SettingsModal (General, UiColumns, Filters, RulesProxy, BackupExport)
│   │   ├── TrafficGrid.tsx              # Виртуализированная таблица, 12 колонок, тултип таймингов, бейджи TUNNEL/REMAP
│   │   ├── SessionInspector.tsx         # Инспектор запросов/ответов (Inspectors | Statistics) и шорткаты Ctrl+1..6
│   │   ├── SessionStatisticsPanel.tsx   # Пофазные тайминги в стиле Fiddler, SVG-диаграммы и Multi-Session статистика
│   │   ├── HexViewer.tsx                # Виртуализированный шестнадцатеричный инспектор байтов
│   │   ├── InspectorProtocolPanels.tsx  # Панели SSE/LLM, WS (+ инъекция фреймов), gRPC/Protobuf, Auth, Cache, Multipart
│   │   ├── FilterDrawer.tsx             # Матрица фильтров, пороги шума, Selective MITM 2.0 (Bulk / Quick Paste), мутации
│   │   ├── ComposerPanel.tsx            # Конструктор HTTP-запросов (Import cURL, Run Python Scripts, Cancel)
│   │   ├── CodeSnippetModal.tsx         # Модальный генератор клиентского кода на 5 языках (Monaco)
│   │   ├── OpenApiExportModal.tsx       # Экспорт захваченных сессий в OpenAPI 3.0.3 (YAML / JSON)
│   │   ├── AutoResponderPanel.tsx       # Правила подмены ответов и эмуляции задержек
│   │   ├── ScriptingPanel.tsx           # Редактор Python-скриптов (Monaco), пресеты и консоль логов
│   │   ├── BreakpointBanner.tsx         # Баннер ожидающих точек останова
│   │   ├── BreakpointModal.tsx          # Перехватчик запросов и ответов на лету
│   │   ├── SessionDiffView.tsx          # Визуальное сравнение двух сессий
│   │   ├── SanitizedExportModal.tsx     # Экспорт сессий с очисткой PII и секретов (Ctrl+Shift+S)
│   │   ├── ProxyDoctorModal.tsx         # Диагностический мастер самопроверки и автоисправления (Ctrl+Shift+D)
│   │   ├── SettingsModal.tsx            # Настройки, тема, Upstream Timeouts и профили (Ctrl+,)
│   │   ├── HostRemapModal.tsx           # Управление правилами виртуального DNS (HOSTS Remapping, Ctrl+Shift+H)
│   │   ├── UpstreamProxyModal.tsx       # Настройка каскадного прокси HTTP / HTTPS / SOCKS5 (Ctrl+Shift+U)
│   │   ├── TextWizardModal.tsx          # Декодер JWT, Base64, URL, Hex, Gzip/Brotli/Zstd
│   │   ├── MobileSetupModal.tsx         # Мастер подключения iOS/Android по Wi-Fi с QR-кодом и LAN Client Allowlist
│   │   ├── CertificateModal.tsx         # Установка, проверка и удаление Root CA
│   │   ├── ClientCertificatesModal.tsx  # Хранилище mTLS (.p12/.pfx/.pem, DPAPI и режим Session-only RAM ONLY)
│   │   ├── CommandPalette.tsx           # Командная палитра и QuickExec (Ctrl+K)
│   │   ├── TopToolbar.tsx               # Панель управления, Slim Toolbar, селектор Throttling и пресетов
│   │   └── MenuBar.tsx                  # Главное меню приложения
│   ├── stores/                          # Zustand-сторы (proxyStore.ts, filterStore.ts, uiStore.ts)
│   ├── hooks/                           # Хуки (useProxySessions, useGlobalShortcuts, useTheme, useUiPreferences) и тесты
│   ├── lib/                             # Движки фильтров, статистики, previewEngine.ts, тонкий tauriBridge.ts (<1000 строк) и тесты
│   └── types/                           # TypeScript-интерфейсы сессий, таймингов, правил и схемы настроек
│
└── src-tauri/                           # Исходный код Core & MITM Proxy (Rust)
    ├── Cargo.toml                       # Rust-зависимости и метаданные
    ├── tauri.conf.json                  # Конфигурация Tauri v2 и политики безопасности CSP
    └── src/
        ├── main.rs / lib.rs             # Точка входа приложения и регистрация IPC-команд
        ├── commands.rs                  # Команды Tauri для взаимодействия с UI (включая WS-инъекцию)
        ├── models.rs                    # Модели сессий, SessionTimings, SessionTransferStats, фильтров и статистики
        ├── proxy/                       # Асинхронное ядро MITM-прокси
        │   ├── server/                  # Модульный прокси-сервер (mod, http_handler, connect_tunnel, websocket_relay, composer_exec, mobile_portal)
        │   ├── filters/                 # Selective MITM 2.0 (hit counters), LAN Client Allowlist, парсеры и тесты
        │   ├── upstream_client.rs       # Инструментированный hyper-util + tokio-rustls транспорт с замером фаз
        │   ├── upstream_proxy.rs        # Каскадирование HTTP / HTTPS CONNECT / SOCKS5 и bypass_list
        │   ├── hosts.rs                 # Виртуальный DNS (HostRemapRegistry) с сохранением TLS SNI
        │   ├── throttle.rs              # Шейпинг пропускной способности и эмуляция RTT / Offline 503
        │   ├── doctor.rs                # Самодиагностика порта, Root CA, SysProxy, VPN, Firewall и /health
        │   ├── dpapi.rs                 # Windows DPAPI-шифрование приватных ключей (FLUX_DPAPI_V1) и автомиграция
        │   ├── ca.rs                    # Генерация Root CA, сертификатов доменов и управление хранилищем ОС
        │   ├── client_certs.rs          # Хранилище mTLS (PKCS#12 / PEM), DPAPI и режим Session-only (In-Memory)
        │   ├── breakpoints.rs           # Менеджер живых точек останова
        │   ├── rules.rs                 # Движок правил AutoResponder
        │   ├── codec.rs                 # Сжатие/распаковка и преобразования данных для TextWizard
        │   ├── sysproxy.rs              # Автонастройка системного прокси (Windows / macOS / Linux)
        │   ├── process.rs               # Определение PID и имени процесса-источника
        │   └── network.rs               # Сетевые интерфейсы и определение LAN IP
        ├── scripting/                   # Движок пользовательских Python-скриптов
        │   ├── mod.rs                   # Экспорт типов и интерфейса скриптового раннера
        │   └── python_runner.rs         # Долгоживущий воркер Python (JSON Lines, fail-open таймаут, логи)
        └── storage/                     # Хранение и обмен данными
            ├── mod.rs                   # Потокобезопасный Ring Buffer и оффлоадинг тяжелых тел
            ├── sqlite.rs                # Архивация и чтение сессий из SQLite (WAL)
            └── export_import/           # Модульный экспорт/импорт и санитизация (mod, har, saz, raw, sanitize)
```

---

## 🚀 Быстрый старт

### Требования к окружению
- **Node.js**: версии `18.x` или новее.
- **Rust**: версия `1.80+` (устанавливается через [rustup.rs](https://rustup.rs/)).
- **Системные пакеты для сборки Tauri**:
  - **Windows**: Microsoft C++ Build Tools (пакет *Desktop development with C++*) и WebView2.
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`).
  - **Linux**: `build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev`, `libgtk-3-dev`.

---

### 1. Режим UI Preview Simulator (без Rust)
Если вы хотите быстро посмотреть интерфейс или поработать над фронтендом без компиляции Rust-ядра:

```bash
# Клонируйте репозиторий
git clone https://github.com/<ваш-логин>/flux-proxy.git
cd flux-proxy

# Установите зависимости
npm install

# Запустите симулятор в браузере
npm run dev
```

Откройте `http://localhost:5173`. В режиме симулятора работают все панели, фильтры, инспекторы, настройки и импорт/экспорт файлов. Нажмите `Ctrl+K` → **«Generate +10,000 Test Sessions»**, чтобы протестировать скорость таблицы под высокой нагрузкой.

---

### 2. Полнофункциональный режим приложения (Tauri + Rust)
Запуск нативного десктопного приложения с реальным перехватом трафика на `127.0.0.1:8888` (порт можно изменить в `Ctrl+,`):

```bash
npx @tauri-apps/cli dev
```

При запуске:
1. Прокси-сервер стартует автоматически на выбранном порту (по умолчанию `8888`).
2. Управлять захватом трафика можно кнопкой в левом верхнем углу тулбара или клавишей `F12`.

---

### 3. Сборка релизного пакета

Для сборки оптимизированного установщика под вашу ОС (`.exe` / `.msi` на Windows, `.dmg` / `.app` на macOS, `.deb` / `.AppImage` на Linux):

```bash
npx @tauri-apps/cli build
```

Готовые установочные файлы появятся в каталоге `src-tauri/target/release/bundle/`.

---

## 🔒 Настройка HTTPS MITM Decryption (Root CA)

Чтобы расшифровывать защищенный HTTPS-трафик без предупреждений браузера, установите локальный корневой сертификат FluxProxy:

1. В верхнем меню выберите **Tools → HTTPS Root CA Certificate…** (или нажмите на кнопку сертификата на панели инструментов).
2. В окне отобразится текущий статус доверия в вашей ОС и отпечаток SHA-256. Нажмите **Trust Root CA in OS Store**:
   - **Windows**: сертификат добавится в хранилище *«Доверенные корневые центры сертификации»* текущего пользователя (`CurrentUser\Root`).
   - **macOS**: сертификат добавится в пользовательскую связку ключей *Login Keychain* (`~/Library/Keychains/login.keychain-db`) с доверием SSL.
   - **Linux**: сертификат скопируется в системное хранилище с обновлением `update-ca-certificates`.
   *(Проверка статуса доверия на Windows, macOS и Linux сверяет отпечаток SHA-256 активного Root CA.)*
3. Для браузеров со своим изолированным хранилищем (например, **Mozilla Firefox**) скопируйте путь к файлу сертификата из этого же окна и импортируйте его в настройках браузера (*Настройки → Приватность и защита → Сертификаты → Просмотр сертификатов → Импортировать*).
4. Когда отладка завершена и вы хотите полностью убрать сертификат из системы, в том же окне нажмите **«Удалить сертификат из доверенных ОС»**.

---

## 📱 Перехват трафика с мобильных устройств (iOS / Android)

FluxProxy умеет перехватывать трафик со смартфонов и планшетов в вашей локальной Wi-Fi сети:

1. Откройте **Tools → Connect Mobile Device (iOS / Android)…** (или нажмите `Ctrl+Shift+M`).
2. Выберите конкретный Wi-Fi/LAN-адаптер в режиме **Specific Interface** (с опцией **Dual Listener** в **Settings → Rules & Proxy**) либо включите режим внешних подключений (`0.0.0.0`) — программа покажет ваш IP-адрес, порт и **QR-код**.
3. В настройках Wi-Fi на телефоне укажите ручной прокси с IP вашего компьютера и портом `8888`.
4. Отсканируйте QR-код камерой телефона (или откройте `http://flux.proxy` в мобильном браузере), скачайте профиль сертификата и включите доверие к нему по пошаговой подсказке на экране.

---

## ⌨️ Горячие клавиши (Keyboard Shortcuts)

Полный список шорткатов всегда доступен внутри приложения по клавише `?`.

| Сочетание клавиш | Описание действия |
| :--- | :--- |
| `Ctrl+K` / `Cmd+K` | Открыть командную палитру (**Command Palette** и команды `bpu` / `bpafter`) |
| `Ctrl+,` / `Cmd+,` | Открыть окно настроек и профилей (**Preferences**) |
| `F12` | Включить / приостановить захват трафика (**Capture**) |
| `Ctrl+S` / `Cmd+S` | Сохранить все сессии в архив (`.har`, `.saz`, `.json`) |
| `Ctrl+Shift+S` | Безопасный экспорт с маскированием токенов и PII (**Export Sanitized Sessions…**) |
| `Ctrl+O` / `Cmd+O` | Открыть / импортировать архив сессий (`.har`, `.saz`, `.json`) |
| `Ctrl+F` / `Cmd+F` | Фокус на поле быстрого поиска и фильтрации |
| `F11` / `Alt+F11` | Перехват на лету: **Break Before Request** / **Break After Response** |
| `Shift+F11` | Снять все активные точки останова |
| `R` / `Ctrl+R` | **Replay** — повторить выбранный запрос на сервер |
| `Ctrl+D` / `Cmd+D` | Открыть визуальное сравнение двух сессий (**Session Diff**) |
| `Ctrl+E` / `Cmd+E` | Открыть **Text Wizard & JWT Decoder** |
| `Ctrl+Shift+M` | Мастер подключения мобильных устройств (**Mobile Setup**) |
| `Ctrl+Shift+C` | Хранилище клиентских сертификатов (**Client Certificates / mTLS**) |
| `Ctrl+Shift+H` | Виртуальный DNS и перенаправление доменов (**HOSTS Remapping**) |
| `Ctrl+Shift+U` | Каскадирование через внешний прокси (**Upstream Proxy**) |
| `Ctrl+Shift+D` | Запустить диагностический мастер самопроверки (**Proxy Doctor**) |
| `Ctrl+Shift+T` | Переключить однострочный компактный тулбар (**Slim / Compact Toolbar**) |
| `Ctrl+A` / `Cmd+A` | Выделить все видимые сессии в таблице |
| `M` / `U` | Добавить комментарий и цветовую метку (`M`) / снять метку (`U`) |
| `Space` / `Enter` | Открыть **Session Inspector** и переключить фокус между таблицей и инспектором |
| `Ctrl+1` … `Ctrl+6` | Переключение вкладок активной панели **Session Inspector** (*Headers*, *JSON/Raw*, *Cookies/Params*, *Auth*, *Raw*, *Hex*) |
| `Delete` / `Backspace` | Удалить выбранные сессии из таблицы |
| `Ctrl+X` / `Cmd+X` | Полностью очистить список сессий (**Clear All**) |
| `Ctrl+C` / `Cmd+C` | Скопировать URL выбранных сессий |
| `Ctrl+B` / `Cmd+B` | Показать / скрыть боковую панель навигации (**Sidebar**) |
| `Alt+1` … `Alt+5` | Переключение разделов: *Traffic*, *Composer*, *AutoResponder*, *Filter Matrix*, [*Python Scripts*](PYTHON_SCRIPTING_GUIDE.md) |
| `?` | Показать справку по всем горячим клавишам |

---

## 💻 Интеграция с CLI инструментами

Чтобы направить трафик консольных утилит (`curl`, `git`, `npm`, `python`, `node`) через FluxProxy, задайте переменные окружения в терминале (готовую строку с вашим текущим портом можно скопировать в один клик через меню **Help → Copy CLI HTTP_PROXY Snippet**):

### Windows (PowerShell)
```powershell
$env:HTTP_PROXY="http://127.0.0.1:8888"
$env:HTTPS_PROXY="http://127.0.0.1:8888"
```

### macOS / Linux (Bash, Zsh)
```bash
export HTTP_PROXY="http://127.0.0.1:8888"
export HTTPS_PROXY="http://127.0.0.1:8888"
```

### Пример проверки через cURL
```bash
curl -x http://127.0.0.1:8888 https://httpbin.org/get -k
```

---

## 🗺️ Дорожная карта (Roadmap)

Детальный план развития проекта, матрица приоритетов и технические спецификации находятся в файле [**ROADMAP.md**](ROADMAP.md).

### Уже реализовано:
- ✅ Кроссплатформенная отладка iOS / Android с порталом `http://flux.proxy`, `.mobileconfig` и QR-кодами.
- ✅ Пакетные списки хостов (Whitelist / Blacklist), матрица фильтров и совместимость с WebSocket / SignalR.
- ✅ Блокировка обхода HTTP/3 (`Alt-Svc`), управление доверием Root CA (установка/удаление) и строгая политика CSP.
- ✅ Кольцевой буфер памяти (Ring Buffer `Keep`), фильтрация при захвате (*Drop Non-Matching*) и ленивая подгрузка тяжелых тел.
- ✅ Полная поддержка архивов **HAR 1.2** и **Fiddler SAZ** (экспорт, импорт, Drag-and-Drop), защита парсеров от ZIP-бомб/переполнения и выгрузка сырых тел.
- ✅ Централизованное окно настроек (`Preferences`) и версионированные JSON-профили конфигурации.
- ✅ **Двухфазный захват сессий (In-Flight / `Pending`)**, zero-buffering стриминг видео/`206`, сброс активных MITM-туннелей в Passthrough и диагностика сетевых сбоев (`err.source()`).
- ✅ Прозрачная распаковка сжатия **Zstandard (`zstd`, RFC 8878)** на лету (прокси-ядро, Composer, Text Wizard).
- ✅ **Привязка к конкретному IP / сетевому интерфейсу** (Wi-Fi/Ethernet/WSL/VPN) и режим **Dual Listener** (loopback + выбранный адаптер).
- ✅ Управление хранилищем SQLite (`VACUUM` + `wal_checkpoint(TRUNCATE)`, *Clear DB on App Exit*), неблокирующий Tokio-рантайм (`spawn_blocking`), предкомпиляция Regex и $O(1)$ SSE/WebSocket-стриминг.
- ✅ Сортировка всех колонок таблицы (`ASC`/`DESC`), `Ctrl+A`, автоподбор ширины колонок (`Auto-fit`), персистентность геометрии сплитов, однострочный **Slim Toolbar (`Ctrl+Shift+T`)**, шорткаты вкладок `Ctrl+1..6`, виртуализация `HexViewer` и `manualChunks` в Vite.
- ✅ Очистка и маскирование PII/секретов при экспорте (**Sanitized Export**, `Ctrl+Shift+S`) для `.har`, `.saz`, `.json` и Raw HTTP.
- ✅ Диагностический мастер самопроверки и 1-клик починки **«Proxy Doctor» (`Ctrl+Shift+D`)**, единая точка старта порта (`proxy_port.pref`) и транзакционное применение профилей настроек с поддержкой `breakpoints`.
- ✅ Встроенный **Python Scripting Engine (`Alt+5`)** для программируемой модификации и мокирования трафика (`on_request` / `on_response`) через долгоживущий IPC-процесс с fail-open защитой 1500 мс, встроенным Monaco Editor и живой консолью логов (см. [**PYTHON_SCRIPTING_GUIDE.md**](PYTHON_SCRIPTING_GUIDE.md) и [**PYTHON_SCRIPTING_AI_GUIDE.md**](PYTHON_SCRIPTING_AI_GUIDE.md)).
- ✅ **Галерея 8 цветовых тем и редактор палитры**: пресеты *Flux Dark*, *Flux Light*, *Dracula*, *Tokyo Night*, *Nord*, *Fiddler Classic*, *GitHub Dark*, *Monokai Pro*, кастомная настройка CSS-токенов и синхронизация темы Monaco Editor.
- ✅ **Selective MITM & Bypass 2.0**: переключение `Table View` ↔ `Bulk Text Editor`, диалог `Quick Paste…`, импорт/экспорт TXT/JSON, 11 курируемых Quick-Packs, PKI/OCSP/CRL-дефолты, lock-free счётчики `Hits: N` и бейдж `TUNNEL`.
- ✅ **Клиентские сертификаты (mTLS, `Ctrl+Shift+C`)**: хранилище PKCS#12 (`.p12`/`.pfx`) и PEM с масками доменов (`*.corp.local`), прозрачным шифрованием ключей Windows DPAPI (`FLUX_DPAPI_V1`) и режимом **`Session-only (In-Memory)`** (`RAM ONLY`).
- ✅ **Composer 2.0 & Кодогенератор**: умный импорт / вставка команд **cURL** (Bash / cmd / PowerShell), паритет Python-хуков (`Run Python Scripts`), кнопка отмены **`Cancel`** и генератор клиентского кода на 5 языках (8 вариантов: JS, Python, Go, Rust, cURL).
- ✅ **Генератор OpenAPI 3.0.3 / Swagger**: автоматический вывод контракта (`YAML` / `JSON`) с параметризацией `{id}` / `{uuid}`, слиянием JSON Schema и безопасными `components.securitySchemes`.
- ✅ **Тестирование и CI/CD**: 12 наборов Vitest (96 frontend-тестов) + 170 Rust-тестов и кроссплатформенный GitHub Actions CI (`ubuntu-latest`, `windows-latest`, `macos-latest`, `clippy -D warnings`, `NODE_OPTIONS=--max-old-space-size=4096`).
- ✅ **Аудит безопасности, целостности и надёжности (`v0.4.1`)**: защита импорта профилей настроек от скрытого RCE (`SEC-01`), изоляция файлового IPC и лимит 16 MiB (`SEC-02`), блокировка LAN SSRF и утечки хозяйских mTLS (`SEC-03`), полная санитизация `camelCase` JSON / SSE / WebSocket (включая SignalR/Socket.IO/Bearer/JWT) / `Location` / `Referer` (`SEC-04`), лимиты декомпрессии и поддержка `zstd` в `.saz` (`SEC-05`, `BUG-12`), консистентность `next_id` и выгруженных тел при рестарте и `VACUUM` (`BUG-01`, `BUG-03`, `BUG-11`), устойчивый bootstrap UI (`BUG-02`, `BUG-08`, `PERF-01`), RAII-очистка Breakpoints (`BUG-04`), конкурентный релей WebSocket (`BUG-05`), сверка SHA-256 Root CA (`BUG-06`), фиксы `HEAD` / `Content-Encoding` (`BUG-07`), предкомпиляция Regex + IPv6 / `.domain.com` (`BUG-09`, `PERF-03`), откат `sysproxy` (`BUG-10`) и неразрушающий fail-open очереди Python-воркера (`PERF-04`).
- ✅ **Архитектурная декомпозиция и оптимизация бандла (`v0.5.0`, `ARCH-01`, `PERF-05`)**: модульное разбиение Rust-ядра (`proxy/server/`, `proxy/filters/`, `storage/export_import/`) и UI-компонентов, внедрение **Zustand 5**, `React.lazy()` + `Suspense`, ленивый `getPreviewEngine()` и удаление чанка `ts.worker` (7.05 МБ).
- ✅ **Fiddler-тайминги, статистика запросов и сетевая маршрутизация (`v0.5.0`)**: инструментированный `UpstreamHttpClient` (`hyper-util` + `tokio-rustls`), панель **`Statistics`** (Single & Multi-Selection с SVG-диаграммами и *Estimated Worldwide Performance*), колонки `TTFB` / `Server IP`, реальный round-trip таймингов HAR/SAZ, **HOSTS Remapping (`Ctrl+Shift+H`)**, **Bandwidth Throttling**, **Upstream Proxy Chaining (`Ctrl+Shift+U`)** (`HTTP`/`HTTPS`/`SOCKS5`) и **ручная инъекция WebSocket-фреймов**.
- ✅ **Стабилизация ядра, раздельные таймауты и защита ключей (`Этапы 35, 39, 36`)**: унификация маршрутизации `HOSTS Remapping` + `Upstream Proxy` (`via <proxy>` в `Server IP`) + WebSocket, атомарное сохранение инъектированных WS-фреймов, лимит `64 MiB` ответа, раздельные `Upstream Timeouts` (`Connect` / `TTFB Unlimited` / `Composer`) с кнопкой `Cancel` и RAII-гардом `499`, Windows **DPAPI** (`FLUX_DPAPI_V1`) + режим **`Session-only (In-Memory)`**, **`LAN Client Allowlist`** (`403 Forbidden`), запрет SVG в превью Multipart (`SEC-02`), чистота `syncFromLocalStorage` (`CONC-01`), $O(1)$/`find` для `selectedSessions` (`PERF-03`), удаление мёртвого кода `reqwest` (`ARCH-01`) и вынос `previewEngine.ts` / `useGlobalShortcuts.ts` (`ARCH-02`).

### Ближайшие этапы разработки:
- 🔜 **P2** — Виртуализированный многофазный **Waterfall Timeline** и модальная сводная статистика трафика по всей отфильтрованной выборке (Этап 12).

---

## 🤝 Разработка и Contributing

1. Сделайте Fork репозитория и создайте ветку (`git checkout -b feature/my-feature`).
2. Внесите изменения и убедитесь, что сборка и тесты проходят чисто:
   ```bash
   npm run typecheck
   npm run test
   npm run build
   cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
   cargo test --manifest-path src-tauri/Cargo.toml
   ```
3. Сделайте коммит и откройте **Pull Request**.

---

## 📄 Лицензия

Проект распространяется под свободной лицензией **MIT**. Подробности см. в файле [LICENSE](LICENSE).
