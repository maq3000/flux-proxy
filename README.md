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

> 📥 **Скачать готовую сборку для Windows:** [**FluxProxy Setup v0.7.0 (.exe)**](https://github.com/maq3000/flux-proxy/releases/download/v0.7.0/FluxProxy_0.7.0_x64-setup.exe) или [**MSI-пакет (.msi)**](https://github.com/maq3000/flux-proxy/releases/download/v0.7.0/FluxProxy_0.7.0_x64_en-US.msi). Подробнее см. раздел [Скачать готовые сборки](#-скачать-готовые-сборки-releases).
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

Для запуска FluxProxy на **Windows** вам не требуется компилировать проект из исходных кодов — вы можете скачать готовые официальные установщики из [**GitHub Releases v0.7.0**](https://github.com/maq3000/flux-proxy/releases/tag/v0.7.0):

| Дистрибутив | Версия | Архитектура | Описание | Ссылка на загрузку | Контрольная сумма (SHA-256) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Windows Setup (`.exe`)** | `v0.7.0` | x64 | **Рекомендуемый** автономный инсталлятор (NSIS). Автоматическое создание ярлыков на рабочем столе и в меню «Пуск», встроенный деинсталлятор. | [📥 **FluxProxy_0.7.0_x64-setup.exe** (8.2 МБ)](https://github.com/maq3000/flux-proxy/releases/download/v0.7.0/FluxProxy_0.7.0_x64-setup.exe) | `d4053706e692f19b66bb97a4c8aa5d48b1fdf3a3805b81a539f9aebd5957d829` |
| **Windows Package (`.msi`)** | `v0.7.0` | x64 | Пакет Windows Installer (MSI). Оптимизирован для тихой установки (`msiexec /i ... /qn`) и автоматизированного развертывания через Active Directory (GPO). | [📥 **FluxProxy_0.7.0_x64_en-US.msi** (11.1 МБ)](https://github.com/maq3000/flux-proxy/releases/download/v0.7.0/FluxProxy_0.7.0_x64_en-US.msi) | `9fb40aab3344f30e2a7608ae029c47a2c9dc3d24e05a5a2e7625fbaa786fba99` |

> 📦 **Все релизы проекта:** [github.com/maq3000/flux-proxy/releases](https://github.com/maq3000/flux-proxy/releases)  
> 🐧 🍏 **macOS и Linux:** На текущем этапе сборка выполняется из исходного кода с помощью команды `npx @tauri-apps/cli build` (см. раздел [Быстрый старт](#-быстрый-старт)). Готовые дистрибутивы `.dmg` и `.AppImage` будут доступны в следующих релизах.

---

## ✨ Особенности и возможности

### 🚀 Сетевое ядро перехвата (Rust MITM Core)
- **HTTP/1.1 и HTTP/2**: Прозрачный перехват и мультиплексирование потоков с автоматическим выбором протокола (`hyper-util auto`).
- **Двухфазный захват сессий (In-Flight / Pending)**: Мгновенное появление запроса в таблице еще до ответа сервера (`Pending`) с реальной инспекцией исходящих данных и последующим обновлением статуса, таймингов и ответа.
- **Zero-Buffering видео/CDN-стриминг, протокольная точность и управление жизненным циклом**: Потоковая передача медиа, `206 Partial Content`, `chunked`-ответов свыше 2 МБ и сжатых SSE-потоков без буферизации и искусственного потолка `64 MiB`, сохранение сырых не-ASCII заголовков (`raw_bytes_b64`) и кастомного `Host`, явный `Content-Length: 0` для пустых `POST`/`PUT`/`PATCH` по HTTP/1.1, мгновенный сброс активных MITM/Passthrough/WS-соединений при изменении правил и двухуровневая остановка (**Graceful Drain 30 с** по `F12` vs **Hard Abort 0 мс** при сужении границ безопасности).
- **Расшифровка HTTPS на лету и Zstandard (`zstd`)**: Динамическая генерация X.509 сертификатов (ECDSA P-256) под целевые домены через `rcgen` с коалесцирующим кэшем (`moka::try_get_with` + `spawn_blocking`), прозрачная потоковая распаковка `Content-Encoding: zstd` (RFC 8878) с лимитами от OOM-бомб, сохранение оригинального `Content-Length` для `HEAD` и точное снятие `Content-Encoding` только для распакованных слоёв.
- **Избирательный перехват (Selective MITM & TLS Bypass 2.0)**: Режимы *Intercept All* и *Targeted Allowlist* (с проверкой расхождения внутреннего `Host`/`:authority` во **всех** режимах против domain fronting и H2 coalescing), переключение `Table View` ↔ `Bulk Text Editor`, диалог `Quick Paste…`, импорт/экспорт TXT/JSON, **11 готовых Quick-Packs** (включая *OCSP / CRL PKI*, *Payment Gateways*, *Gaming & Anti-Cheat*, *РФ FinTech & Госуслуги* и *Video & CDN*), сброс к рекомендованным PKI-дефолтам, предкомпилированные Regex-правила с поддержкой суффиксов `.domain.com` и IPv6, lock-free счётчики попаданий `Hits: N` и бейдж `TUNNEL` в таблице.
- **Клиентские сертификаты (mTLS, `Ctrl+Shift+C`)**: Write-Only хранилище сертификатов **PKCS#12 (`.p12` / `.pfx`)** и **PEM** с привязкой к точным и wildcard-маскам доменов (`*.corp.local`), прозрачным шифрованием приватных ключей на диске через **Windows DPAPI** (`FLUX_DPAPI_V1:<base64>`, без сохранения сырых `.p12`/`.pfx` дубликатов на диск, с автоочисткой старых копий и правами `0600` на Unix), режимом **`Session-only (In-Memory)`** (`RAM ONLY` — ключ и сертификат хранятся только в RAM и не записываются на диск), изоляцией от внешних LAN-клиентов и передачей mTLS-идентичности через инструментированный `UpstreamHttpClient` (`tokio-rustls`).
- **Блокировка обхода через HTTP/3 (QUIC)**: Автоматическое удаление заголовков `Alt-Svc` и `Alternate-Protocol`, предотвращающее уход современных браузеров в UDP-туннель мимо системного прокси.
- **Перехват WebSocket (WS/WSS), ручная инъекция фреймов и SSE**: Инкрементальное декодирование кадров в реальном времени ($O(1)$ append без лишних аллокаций, `tokio-tungstenite`), конкурентный двунаправленный релей без взаимных блокировок с кэшированным `rustls::ClientConfig`, реакцией на смену правил (`config_rx.changed()`), upstream-таймаутом подключения и полной передачей заголовков авторизации/субпротоколов (включая SignalR), а также **ручная инъекция WebSocket-фреймов** в активные соединения (`Text` / `JSON` / `Hex (Binary)` → *Send to Server* / *Send to Client*).
- **Инструментированный транспорт, Fiddler-тайминги и статистика (`SessionTimers`)**: Собственный коннектор на базе `hyper-util` + `tokio-rustls` с замером фаз `DNS`, `TCP Connect`, `TLS Handshake`, `Send`, `Wait (TTFB)` и `Content Download`, учётом wire vs decoded байт, реального TLS-протокола/шифра/ALPN, переиспользования keep-alive сокетов (`CltReuse` / `Reused`), раздельными таймаутами `Connect` / `Response Headers (TTFB)` (по умолчанию `Unlimited`) / `Composer` и RAII-финализацией оборванных клиентом запросов со статусом `499`.
- **Виртуальный DNS (`HOSTS Remapping`, `Ctrl+Shift+H`) и Bandwidth Throttling**: Локальное перенаправление доменов и wildcard-масок на заданный IP/порт с сохранением TLS SNI и заголовка `Host` (бейдж `REMAP`) и защитой от двойного ремапа, а также эмуляция медленных каналов и офлайна (*GPRS*, *Slow 3G*, *Fast 3G*, *LTE / 4G*, *Offline HTTP 503*, *Custom*) с шейпингом чтения/записи и RTT-задержкой.
- **Каскадирование через внешний прокси (`Upstream Proxy Chaining`, `Ctrl+Shift+U`)**: Поддержка исходящих `HTTP`, `HTTPS CONNECT` и `SOCKS5` (RFC 1928/1929) прокси с опциональной аутентификацией (пароль хранится только в RAM и не попадает в экспортируемые профили), защитой от self-loop через все локальные интерфейсы, индикацией **`via <proxy>`** в `Server IP` / `Statistics` и гибким `bypass_list` (`localhost`, `<local>`, CIDR, `*.domain`, glob, `host:port`) для HTTP, HTTPS/mTLS, `CONNECT`-туннелей, Composer и WebSocket.
- **Гибкая привязка к IP и контроль LAN-доступа (`Dual Listener` + `LAN Client Allowlist`)**: Точный выбор сетевого интерфейса (*Loopback Only*, *All Interfaces `0.0.0.0`* или *Specific Interface* — Wi-Fi / Ethernet / WSL / VPN + опциональный одновременный loopback-листенер), опциональный белый список **`LAN Client Allowlist`** (точные IPv4/IPv6 и CIDR-подсети — неразрешённые внешние устройства получают `403 Forbidden` до записи сессии, loopback разрешён всегда), защита от LAN SSRF к локальным сервисам `127.0.0.1` / `localhost` / `::ffff:127.0.0.1` **после реального DNS-разрешения** (`lookup_host`) с изолированным пулом сокетов для LAN-пиров, автоматический откат системного прокси при сбое бинда, неблокирующий Tokio-рантайм (`spawn_blocking` для OS/SQLite), кэш процессов (`pid_name_cache`, до 4096 записей) и проверка доверия Root CA по точному SHA-256 отпечатку.

### 🛠 Инструменты анализа, визуализации и модификации
- **Waterfall Timeline и сводная статистика (`Traffic Statistics`)**:
  - Мгновенное переключение в шапке `Traffic` между таблицей **`Grid`** и виртуализированной многофазной каскадной диаграммой **`Waterfall`** (`@tanstack/react-virtual`, 10 000+ сессий без лагов): цветовая разбивка полос по фазам `DNS` / `TCP` / `TLS` / `Wait (TTFB)` / `Download`, масштабирование (`Zoom In` / `Zoom Out` / `Fit All`), подробный фазовый tooltip и синхронизация выбора с `Session Inspector`.
  - Модальная панель **`Traffic Statistics`** (по всей отфильтрованной выборке или выделенным строкам, также из `View` / `Tools` / ПКМ / `Ctrl+K → stats`): доли `2xx–5xx` / `Pending`, суммарный трафик wire/decoded, `Avg / Median / P95` Latency и TTFB, разбивка по MIME и хостам, топ-5 медленных и крупных URL с переходом к строке и экспортом в буфер (**Copy Markdown Report**).
- **Протокольные анализаторы и статистика в Session Inspector**:
  - Переключатель **`Inspectors | Statistics`** в шапке инспектора (плюс клик по бейджу `size • duration` или через `Ctrl+K`): в режиме **1 сессии** отображаются шкала фаз (`DNS`/`TCP`/`TLS`/`Send`/`Wait`/`Download`) с плавающим оверлей-тултипом без сдвига макета и статической легендой, таблица `ACTUAL PERFORMANCE`, `Bytes & Compression`, `Connection & TLS` и сворачиваемый блок *Estimated Worldwide Performance*; при выделении **2+ сессий** — агрегированные KPI, перцентили `P50 / P95 / P99`, `% Reused`, inline SVG-диаграммы статусов/MIME и топ медленных/крупных URL с копированием отчётов (`Copy Text` / `Copy Markdown`).
  - Заголовки, Query-параметры, Cookies с флагами безопасности, предпросмотр изображений, виртуализированный **Hex Viewer** с детерминированной колонковой сеткой `00..0F` + `Decoded ASCII` (без наложения колонок) и быстрое переключение вкладок активной панели клавишами **`Ctrl+1` … `Ctrl+6`**.
  - **JSON / XML Viewer** на базе **Monaco Editor** с подсветкой синтаксиса, поиском, форматированием, стабильными URI моделей (без утечек памяти при быстрой навигации) и статическим потолком `2 MiB` (`MonacoSizeGuardNotice` с кнопками перехода в `HexViewer` и сохранения на диск).
  - **SSE & LLM Stream Inspector**: разбор потоков `text/event-stream` и сборка чанков ответов нейросетей (OpenAI, Anthropic, Gemini) в единый связный текст в один клик.
  - **gRPC & Protobuf Wire Decoder**: декодирование бинарных Protobuf-сообщений и проекция в JSON без `.proto`-файлов.
  - **Auth & Caching Inspectors**: аудит безопасности Basic/Bearer/JWT токенов и анализ HTTP-кэширования по RFC 9111.
  - **Multipart Form Inspector**: разбор `multipart/form-data` с безопасным мини-превью растровых изображений (`PNG`, `JPEG`, `GIF`, `WebP`, `BMP`, `ICO`; `image/svg+xml` исключён из рендера).
- **3-уровневая архитектура экранов, ПКМ-меню и эргономика интерфейса**:
  - **7 неблокирующих рабочих вкладок** (`Traffic` `Alt+1`, `Composer` `Alt+2`, `AutoResponder` `Alt+3`, `Breakpoints` `Alt+6`, `Scripts` `Alt+5`, `Session Diff` `Ctrl+D`, `TextWizard` `Ctrl+E`) с сохранением рабочего состояния, единый реестр лаконичных заголовков (`SECTION_REGISTRY` + `SectionHeader` с поповером «О разделе»), полноэкранные экраны (`Settings`, `OpenAPI Export`, `Sanitized Export`, `Code Generator`, `Shortcuts`) и компактные диалоги (`Root CA`, `Comment & Mark`, `Import cURL`).
  - **Единая система контекстно-зависимых ПКМ-меню** (`ContextMenuProvider` с auto-flip / clamping и клавиатурной навигацией) во всех зонах приложения — строки, шапка и пустая область таблицы, `Waterfall`, все вкладки инспектора, выделенный текст, `Composer`, `AutoResponder`, консоль `Scripts`, `Breakpoints`, `Session Diff`, `TextWizard`, тулбар, сайдбар, сплиттеры и футер — с подавлением «сырого» меню WebView2 и сохранением штатного меню **Monaco Editor** и буфера обмена в полях ввода.
  - **Command Palette 2.0 (`Ctrl+K`)**: просторный диалог с фильтрацией по категориям (`Tab`), чипами QuickExec (`bpu /api`, `bpafter /graphql`, `jwt`, `doctor`, `mtls`, `waterfall`, `stats`), описаниями команд и живыми бейджами состояния.
  - Интерактивная сортировка всех **12 колонок** таблицы (`ASC` / `DESC`, включая **`TTFB`** и **`Server IP`**), массовое выделение (`Ctrl+A`), **Auto-fit** колонок, всегда видимый подписанный селектор **`Throttle`** и кнопка **`Routing`** на тулбаре, **Slim Toolbar (`Ctrl+Shift+T`)**, постоянная панель возврата свёрнутого инспектора (`CollapsedInspectorBar`) с drag-to-collapse, подсказки `HelpTooltip` и персистентность геометрии всех сплит-панелей.
- **Диагностический мастер «Proxy Doctor» (`Ctrl+Shift+D`)**:
  - Проверка сокета и конфликта порта (с сохранением восстановленного порта), доверия Root CA, синхронизации системного прокси ОС (включая **Windows GPO `ProxySettingsPerUser = 0`** с командой `--proxy-server` и **KDE `kioslaverc`** / фоллбэк `HTTP_PROXY` на Linux), конфликтующих VPN/TUN-интерфейсов, брандмауэра Windows (с корректным чтением длинных правил `ERROR_MORE_DATA`), сквозного пробника `http://flux.proxy/health` и обнаружения сторонних SSL/EDR-инспекторов (`Zscaler` / `Kaspersky` / `EDR`) с 1-клик автоисправлением (**Fix All Fixable**).
- **Live Breakpoints (Точки останова, `Alt+6` / `F11` / `Alt+F11`)**:
  - Неблокирующая вкладка **`Breakpoints`** с верхним баннером возврата при паузе: перехват до отправки запроса (*Before Request*) или после ответа сервера (*After Response*), условные ловушки по URL (`bpu` / `bpafter`), превью тел `<= 256 KiB` с ленивой догрузкой крупных пакетов из SQLite, редактирование заголовков, статусов и тел на лету, RAII-очистка зависших точек останова при разрыве соединения клиентом (`499`) и корректное завершение при `Abort` в Composer (`502`).
- **AutoResponder, Header Mutations и гранулярная фильтрация ассетов**:
  - Мокирование ответов без правки бэкенда (с очисткой устаревших `Content-Length` / `Content-Encoding` и hop-by-hop заголовков), переопределение HTTP-статусов и эмуляция сетевой задержки (Latency).
  - Автоматические мутации заголовков (*Force No-Cache*, *CORS Injection*, пресеты *User-Agent*) и 4 независимых фильтра ресурсов (**`CSS`**, **`Images`**, **`Fonts`**, **`JavaScript (JS)`**) с 1-клик пресетами, поддержкой `.js`/`.mjs`/`.cjs`/`.jsx`/`.js.map` без ложных срабатываний на `.json` и автоматической миграцией старого флага `hideStaticAssets` в **Settings → Filters**.
- **Python Scripting Engine (`Scripts`, `Alt+5`)**:
  - Программируемая обработка и мокирование трафика на лету с помощью хуков `on_request(request)` и `on_response(response, request)` через долгоживущий IPC-процесс Python 3 (fail-open, таймаут 1500 мс с разделением ожидания очереди от таймаута пайпа без убийства воркера, потолок `stdout` IPC-ответа `16 MiB`), встроенный Monaco Editor, готовые пресеты и живую консоль вывода. Подробнее см. [**PYTHON_SCRIPTING_GUIDE.md**](PYTHON_SCRIPTING_GUIDE.md) и [**PYTHON_SCRIPTING_AI_GUIDE.md**](PYTHON_SCRIPTING_AI_GUIDE.md).
- **Composer (`Alt+2` / `E`), Code Generator & Session Diff (`Ctrl+D`)**:
  - Полноценная рабочая вкладка **`Composer`** с Fiddler-style хоткеем **`E`** прямо из таблицы трафика, поддержкой **Drag-and-Drop** строк на иконку Composer, кнопкой возврата `← Traffic` (`Alt+1`), бейджем `From #<id>`, ресайзабельным сплитом Request/Response, чекбоксом **`Run Python Scripts`** (по умолчанию хуки `on_request` / `on_response` применяются к Composer и `Replay`), настройкой таймаута, сквозной отменой **`Cancel`** (включая `bpu`, Python-хуки и задержку `AddLatency`), обновлением итогового URL при редиректах (`final_url`), умным **Import / Paste cURL** (POSIX Bash, Windows cmd и PowerShell) и генератором клиентского кода на **5 языках** (8 таргетов: *JavaScript `fetch`/`axios`*, *Python `requests`/`httpx`*, *Go `net/http`*, *Rust `reqwest`*, *cURL Bash/PowerShell*).
  - Неблокирующая вкладка визуального сравнения двух сессий (**Session Diff**, `Ctrl+D`) с сохранением выбранной пары A/B, сортировкой ключей JSON и фильтрацией динамических заголовков.
- **Генератор спецификаций OpenAPI 3.0.3 / Swagger**:
  - Полноэкранный автоматический синтез OpenAPI 3.0.3 контрактов (`YAML` / `JSON`) по выбранным или всем захваченным сессиям (`File → OpenAPI Export` или контекстное меню таблицы): параметризация числовых/UUID-сегментов (`{id}`, `{uuid}`), рекурсивное слияние JSON Schema, безопасный вынос `Authorization` / `Cookie` / `X-Api-Key` в `components.securitySchemes` без раскрытия секретов и предпросмотр в Monaco Editor.
- **Темы оформления и детальный редактор палитры**:
  - 8 встроенных цветовых тем-пресетов (*Flux Dark*, *Flux Light*, *Dracula*, *Tokyo Night*, *Nord*, *Fiddler Classic*, *GitHub Dark*, *Monokai Pro*) в **Settings (`Ctrl+,`) → *Appearance & Layout*** и командной палитре (`Ctrl+K`), детальный редактор CSS-токенов (фоны, акценты, цвета статусов) и мгновенная синхронизация темы **Monaco Editor**.
- **TextWizard (`Ctrl+E`)**:
  - Неблокирующая вкладка текстовых и бинарных утилит: декодер JWT с проверкой срока жизни токена, конвертеры Base64, URL, Hex, Unix Timestamp и сжатие/распаковка Gzip / Brotli / Deflate / Zstd.

### 💾 Управление памятью, SQLite и профили настроек
- **Кольцевой буфер (Ring Buffer), SQLite и защита памяти**:
  - Ограничение числа хранимых сессий в стиле Fiddler (`Keep: All / 100..10 000 / Custom...`) с пакетным вытеснением с гистерезисом в SQLite через выделенный фоновый поток-писатель (без блокировки Tokio-воркеров, без дублирующей записи request-тела на Phase 2, с `busy_timeout` до WAL, консистентным `next_id` и автоматической дочиткой вытесненных тел).
  - Управление размером `sessions.sqlite`: индикатор `SQLite: X.X MB` в статус-баре, ручной `VACUUM` + `wal_checkpoint(TRUNCATE)` с сохранением выгруженных тел (`> 2 MiB`) активных RAM-сессий и опция *Clear DB on App Exit* в настройках.
  - Режим **Drop Non-Matching on Capture** — отбрасывание фонового шума (включая гранулярные фильтры CSS/Images/Fonts/JS) на этапе захвата без расхода оперативной памяти.
  - Ленивая подгрузка тяжелых тел (> 2 МБ) с диска только при открытии в инспекторе, предпроверка размера запроса в `OpenAPI Export` и лимит буферизации ответов **64 MiB** против OOM.
- **Полная совместимость форматов и Sanitized Export (`Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+O`)**:
  - Потоковый экспорт (текущее окно RAM по умолчанию + опция `include_evicted_sqlite` для курсорного чтения архива SQLite в порядке `ORDER BY id ASC`) и импорт **HAR 1.2 (`.har`)**, **Fiddler Classic (`.saz`)** с реальным round-trip пофазных таймингов, **JSON** и сырых HTTP-сообщений (`.txt`/`.md`) с защитой файлового IPC через реестр авторизованных путей диалогов (`AUTHORIZED_DIALOG_PATHS`), командой `export_text_file`, поддержкой `zstd` и защитой парсеров от ZIP/OOM-бомб (лимит 50 000 записей `.saz`, кумулятивный лимит 512 MiB и UTF-16BE).
  - **Sanitized Export (`Ctrl+Shift+S`)**: полноэкранный мастер безопасной передачи архивов `.har`, `.saz`, `.json` и `.txt` с настраиваемым маскированием секретных заголовков (`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `Location`, `Referer`), рекурсивных ключей в JSON (включая `camelCase`: `accessToken`, `apiKey`, `clientSecret`), `form-urlencoded` (включая многострочные тела) и **`multipart/form-data`** (с вложенным JSON), потоков **SSE** и фреймов **WebSocket** (включая SignalR, Socket.IO и Bearer/JWT), query-параметров, URL `userinfo`/`#fragment` и опциональной анонимизацией IP/имени процесса и `client_conn_id` клиента (пресеты *Safe Sharing*, *Strict Anonymization*, *Custom*).
  - Поддержка **Drag-and-Drop** файлов `.har`, `.saz` и `.json` прямо в окно программы.
- **Единый полноэкранный центр настроек (`Settings Hub`, `Ctrl+,`) и профили**:
  - Полноэкранный центр **`Settings`** со сквозным поиском по параметрам, живыми счётчиками и 6 разделами: ***General*** (порт с `proxy_port.pref`, сетевой интерфейс `Bind Host`, буфер памяти, SQLite), ***Network & Routing*** (Throttling, HOSTS Remapping, Upstream Proxy, Upstream Timeouts), ***TLS & Mobile*** (MITM / TLS Bypass, mTLS Client Certificates, Mobile Setup & LAN Allowlist), ***Filters*** (`Alt+4`: Filter Matrix, Hosts List, Thresholds, Header Mutations), ***Appearance & Layout*** (8 тем, редактор палитры, тулбар и колонки) и ***Diagnostics & Backup*** (Proxy Doctor, переносимый профиль и сброс к дефолтам).
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
| **Тестирование и CI** | 210 frontend-тестов (41 файл) + 216 Rust-тестов, матрица Windows/Linux/macOS, MSRV 1.80 и security audit | `Vitest 3`, `@testing-library/react`, `cargo clippy --locked`, `cargo-audit`, GitHub Actions |

---

## 📁 Структура проекта

```text
├── .github/workflows/ci.yml             # Кроссплатформенный CI (typecheck, Vitest, Vite build, clippy/test --locked, --no-bundle, MSRV 1.80, audit)
├── index.html                           # HTML точка входа Vite
├── package.json                         # Зависимости и npm-скрипты фронтенда
├── USER_GUIDE.md                        # Подробная инструкция для пользователей
├── PYTHON_SCRIPTING_GUIDE.md            # Руководство по встроенному Python Scripting Engine
├── PYTHON_SCRIPTING_AI_GUIDE.md         # Спецификация для AI-агентов по генерации скриптов FluxProxy
├── ROADMAP.md                           # Дорожная карта развития проекта
│
├── src/                                 # Исходный код Frontend UI (React + TypeScript)
│   ├── components/                      # Компоненты интерфейса (7 вкладок, экраны, диалоги и тесты)
│   │   ├── filters/                     # Подпанели фильтров (FilterMatrixTab, TlsBypassTab, HostFiltersTab, ThresholdsTab, HeaderMutationsTab)
│   │   ├── settings/                    # Секции Settings Hub (General, NetworkRouting, TlsCertificates, Filters, UiColumns, DiagnosticsBackup + панели)
│   │   ├── ui/                          # Переиспользуемые примитивы (ContextMenu, SectionHeader, HelpTooltip) и тесты
│   │   ├── workspaces/                  # Изолированные контейнеры рабочих областей (TrafficWorkspace, CommandPaletteContainer, AppModals, SecondaryWorkspaces, SessionDiffWorkspace, StatusFooter, TrafficCountBadges)
│   │   ├── TrafficGrid.tsx              # Виртуализированная таблица, 12 колонок, тултип таймингов, бейджи TUNNEL/REMAP
│   │   ├── WaterfallTimeline.tsx        # Виртуализированная многофазная каскадная диаграмма (DNS/TCP/TLS/TTFB/Download, Zoom)
│   │   ├── TrafficStatisticsModal.tsx   # Сводная статистика отфильтрованной/выделенной выборки и экспорт Markdown-отчёта
│   │   ├── SessionInspector.tsx         # Инспектор запросов/ответов (Inspectors | Statistics), шорткаты Ctrl+1..6 и лимит 2 MiB Monaco
│   │   ├── MonacoSizeGuardNotice.tsx    # Защитный экран при превышении потолка 2 MiB в Monaco Editor
│   │   ├── CollapsedInspectorBar.tsx    # Панель/рельса возврата свёрнутого инспектора (bottom/right)
│   │   ├── SessionStatisticsPanel.tsx   # Пофазные тайминги в стиле Fiddler, SVG-диаграммы и Multi-Session статистика
│   │   ├── HexViewer.tsx                # Виртуализированный шестнадцатеричный инспектор байтов с фиксированной сеткой
│   │   ├── InspectorProtocolPanels.tsx  # Панели SSE/LLM, WS (+ инъекция фреймов), gRPC/Protobuf, Auth, Cache, Multipart
│   │   ├── ComposerPanel.tsx            # Вкладка Composer (хоткей E, Import cURL, Run Python Scripts, Cancel)
│   │   ├── AutoResponderPanel.tsx       # Вкладка AutoResponder (моки ответов, подмена статусов и задержки)
│   │   ├── BreakpointsPanel.tsx         # Неблокирующая вкладка Breakpoints (Alt+6) + BreakpointBanner.tsx
│   │   ├── ScriptingPanel.tsx           # Вкладка Scripts (Alt+5): Monaco Editor, пресеты и живая консоль Python
│   │   ├── SessionDiffView.tsx          # Неблокирующая вкладка Session Diff (Ctrl+D) с сохранением пары A/B
│   │   ├── TextWizardPanel.tsx          # Неблокирующая вкладка TextWizard (Ctrl+E): JWT, Base64, URL, Hex, Gzip/Brotli/Zstd
│   │   ├── SettingsModal.tsx            # Единый полноэкранный Settings Hub (Ctrl+,) с 6 разделами и сквозным поиском
│   │   ├── OpenApiExportModal.tsx       # Полноэкранный экспорт OpenAPI 3.0.3 (YAML / JSON)
│   │   ├── SanitizedExportModal.tsx     # Полноэкранный экспорт с очисткой PII и секретов (Ctrl+Shift+S)
│   │   ├── CodeSnippetModal.tsx         # Полноэкранный генератор клиентского кода на 5 языках (Monaco)
│   │   ├── ShortcutsModal.tsx           # Полноэкранный справочник горячих клавиш (?)
│   │   ├── CertificateModal.tsx         # Компактный диалог Root CA (установка, проверка SHA-256, CLI fallback, удаление)
│   │   ├── SessionAnnotationModal.tsx   # Компактный диалог Comment & Mark (M)
│   │   ├── CommandPalette.tsx           # Command Palette 2.0 и QuickExec (Ctrl+K)
│   │   ├── Sidebar.tsx                  # Боковая навигация по 7 рабочим вкладкам и Settings
│   │   ├── TopToolbar.tsx               # Панель управления, Slim Toolbar, видимый Throttle + Routing и пресеты
│   │   └── MenuBar.tsx                  # Главное меню приложения (File / Edit / Rules / View / Tools / Help)
│   ├── stores/                          # Zustand-сторы (proxyStore.ts с O(1) sessionIndexById, trafficTelemetryStore.ts, filterStore.ts, uiStore.ts) и тесты
│   ├── hooks/                           # Хуки (useProxySessions, useGlobalShortcuts, useStoreGlobalSync, useAutomationSync, useContextMenu, useTheme, useUiPreferences)
│   ├── lib/                             # appDefaults, sectionRegistry, contextMenuBuilders, requestStatistics, filterEngine, trafficFilter, monacoLimits, settings/{schema,migrations,applyProfile}, lazy previewEngine, tauriBridge и тесты
│   ├── test/                            # Общие тестовые фабрики (mockProxyBridge.ts)
│   └── types/                           # TypeScript-интерфейсы сессий, таймингов, правил и схемы настроек
│
└── src-tauri/                           # Исходный код Core & MITM Proxy (Rust)
    ├── Cargo.toml                       # Rust-зависимости и метаданные
    ├── tauri.conf.json                  # Конфигурация Tauri v2 и политики безопасности CSP
    └── src/
        ├── main.rs / lib.rs             # Точка входа приложения и регистрация IPC-команд
        ├── commands.rs                  # Команды Tauri (AUTHORIZED_DIALOG_PATHS, export_text_file, WS-инъекция)
        ├── models.rs                    # Модели сессий, HeaderPair (raw_bytes_b64), SessionTimings, SessionTransferStats, фильтров и статистики
        ├── proxy/                       # Асинхронное ядро MITM-прокси
        │   ├── server/                  # Модульный прокси-сервер (mod, http_handler, pipeline_stages, connect_tunnel, websocket_relay, composer_exec, mobile_portal, tests/)
        │   ├── ipc_channels.rs          # Ограниченные коалесцирующие IPC-каналы (events / removed / breakpoints)
        │   ├── filters/                 # Selective MITM 2.0 (hit counters), LAN Client Allowlist, парсеры и тесты
        │   ├── upstream_client.rs       # Инструментированный hyper-util + tokio-rustls транспорт с замером фаз и общим TLS ClientConfig
        │   ├── upstream_proxy.rs        # Каскадирование HTTP / HTTPS CONNECT / SOCKS5 и bypass_list
        │   ├── hosts.rs                 # Виртуальный DNS (HostRemapRegistry) с сохранением TLS SNI
        │   ├── throttle.rs              # Шейпинг пропускной способности и эмуляция RTT / Offline 503
        │   ├── doctor.rs                # Самодиагностика порта, Root CA, SysProxy, VPN, Firewall, GPO и /health
        │   ├── dpapi.rs                 # Windows DPAPI-шифрование приватных ключей (FLUX_DPAPI_V1) и автомиграция
        │   ├── ca.rs                    # Генерация Root CA, однопоточная коалесценция листовых сертификатов (try_get_with) и хранилище ОС
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

1. В верхнем меню выберите **Tools → Root CA** (или откройте через командную палитру `Ctrl+K` → *Root CA*).
2. В окне отобразится текущий статус доверия в вашей ОС и отпечаток SHA-256. Нажмите **Trust Root CA in OS Store**:
   - **Windows**: сертификат добавится в хранилище *«Доверенные корневые центры сертификации»* текущего пользователя (`CurrentUser\Root`).
   - **macOS**: сертификат добавится в пользовательскую связку ключей *Login Keychain* (`~/Library/Keychains/login.keychain-db`) с доверием SSL.
   - **Linux**: сертификат устанавливается в системное хранилище вашего дистрибутива: Debian / Ubuntu (`/usr/local/share/ca-certificates/` + `update-ca-certificates`), Fedora / RHEL / CentOS (`/etc/pki/ca-trust/source/anchors/` + `update-ca-trust extract`) или Arch Linux (`/etc/ca-certificates/trust-source/anchors/` + `trust anchor` / `trust extract-compat`).
   *(Проверка статуса доверия на Windows, macOS и Linux сверяет отпечаток SHA-256 активного Root CA.)*
3. Для браузеров со своим изолированным хранилищем (например, **Mozilla Firefox**) скопируйте путь к файлу сертификата из этого же окна и импортируйте его в настройках браузера (*Настройки → Приватность и защита → Сертификаты → Просмотр сертификатов → Импортировать*).
4. Когда отладка завершена и вы хотите полностью убрать сертификат из системы, в том же окне нажмите **«Удалить сертификат из доверенных ОС»**.

---

## 📱 Перехват трафика с мобильных устройств (iOS / Android)

FluxProxy умеет перехватывать трафик со смартфонов и планшетов в вашей локальной Wi-Fi сети:

1. Откройте **Tools → Mobile Setup** (или нажмите `Ctrl+Shift+M` — откроется **Settings → TLS & Mobile → Mobile Setup**).
2. Выберите конкретный Wi-Fi/LAN-адаптер в режиме **Specific Interface** (с опцией **Dual Listener** в **Settings → General**) либо включите режим внешних подключений (`0.0.0.0`) — программа покажет ваш IP-адрес, порт и **QR-код**.
3. В настройках Wi-Fi на телефоне укажите ручной прокси с IP вашего компьютера и портом `8888`.
4. Отсканируйте QR-код камерой телефона (или откройте `http://flux.proxy` в мобильном браузере), скачайте профиль сертификата и включите доверие к нему по пошаговой подсказке на экране.

---

## ⌨️ Горячие клавиши (Keyboard Shortcuts)

Полный список шорткатов всегда доступен внутри приложения по клавише `?`.

| Сочетание клавиш | Описание действия |
| :--- | :--- |
| `Ctrl+K` / `Cmd+K` | Открыть командную палитру (**Command Palette 2.0** и команды `bpu` / `bpafter` / `jwt` / `doctor` / `mtls` / `waterfall` / `stats`) |
| `Ctrl+,` / `Cmd+,` | Открыть полноэкранный центр настроек (**Settings Hub**) |
| `F12` | Включить / приостановить захват трафика (**Capture**) |
| `Ctrl+S` / `Cmd+S` | Сохранить все сессии в архив (`.har`, `.saz`, `.json`) |
| `Ctrl+Shift+S` | Безопасный экспорт с маскированием токенов и PII (**Sanitized Export**) |
| `Ctrl+O` / `Cmd+O` | Открыть / импортировать архив сессий (`.har`, `.saz`, `.json`) |
| `Ctrl+F` / `Cmd+F` | Фокус на поле быстрого поиска и фильтрации |
| `F11` / `Alt+F11` | Перехват на лету: **Break Before Request** / **Break After Response** |
| `Shift+F11` | Снять все активные точки останова |
| `R` / `Ctrl+R` | **Replay** — повторить выбранный запрос на сервер |
| `E` | Открыть и отредактировать выбранную сессию во вкладке **Composer** |
| `Ctrl+D` / `Cmd+D` | Переключить вкладку визуального сравнения двух сессий (**Session Diff**) |
| `Ctrl+E` / `Cmd+E` | Переключить вкладку **TextWizard** (JWT, Base64, URL, Hex, сжатие, Timestamp) |
| `Ctrl+Shift+M` | Открыть **Settings → Mobile Setup** (Wi-Fi / QR-код / LAN Allowlist) |
| `Ctrl+Shift+C` | Открыть **Settings → Client Certificates** (mTLS) |
| `Ctrl+Shift+H` | Открыть **Settings → HOSTS Remapping** (виртуальный DNS) |
| `Ctrl+Shift+U` | Открыть **Settings → Upstream Proxy** (HTTP / HTTPS / SOCKS5) |
| `Ctrl+Shift+D` | Открыть **Settings → Proxy Doctor** (самодиагностика) |
| `Ctrl+Shift+T` | Переключить однострочный компактный тулбар (**Slim / Compact Toolbar**) |
| `Ctrl+A` / `Cmd+A` | Выделить все видимые сессии в таблице |
| `M` / `U` | Добавить комментарий и цветовую метку (`M`) / снять метку (`U`) |
| `Space` / `Enter` | Открыть **Session Inspector** и переключить фокус между таблицей и инспектором |
| `Ctrl+1` … `Ctrl+6` | Переключение вкладок активной панели **Session Inspector** (*Headers*, *JSON/Raw*, *Cookies/Params*, *Auth*, *Raw*, *Hex*) |
| `Delete` / `Backspace` | Удалить выбранные сессии из таблицы |
| `Ctrl+X` / `Cmd+X` | Полностью очистить список сессий (**Clear All**) |
| `Ctrl+C` / `Cmd+C` | Скопировать URL выбранных сессий |
| `Ctrl+B` / `Cmd+B` | Показать / скрыть боковую панель навигации (**Sidebar**) |
| `Alt+1` … `Alt+6` | Переключение разделов: *Traffic* (`1`), *Composer* (`2`), *AutoResponder* (`3`), *Settings → Filters* (`4`), [*Scripts*](PYTHON_SCRIPTING_GUIDE.md) (`5`), *Breakpoints* (`6`) |
| `?` | Показать полноэкранную справку по всем горячим клавишам (**Shortcuts**) |

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
- ✅ **Тестирование и CI/CD (`v0.4.0` – `v0.7.0`)**: 41 набор Vitest (210 frontend-тестов) + 216 Rust-тестов и кроссплатформенный GitHub Actions CI (`ubuntu-latest`, `windows-latest`, `macos-latest`, `clippy --locked -D warnings`, `cargo test --locked`, `--no-bundle`, MSRV `1.80`, `audit`).
- ✅ **Аудит безопасности, целостности и надёжности (`v0.4.1`)**: защита импорта профилей настроек от скрытого RCE (`SEC-01`), изоляция файлового IPC и лимит 16 MiB (`SEC-02`), блокировка LAN SSRF и утечки хозяйских mTLS (`SEC-03`), полная санитизация `camelCase` JSON / SSE / WebSocket (включая SignalR/Socket.IO/Bearer/JWT) / `Location` / `Referer` (`SEC-04`), лимиты декомпрессии и поддержка `zstd` в `.saz` (`SEC-05`, `BUG-12`), консистентность `next_id` и выгруженных тел при рестарте и `VACUUM` (`BUG-01`, `BUG-03`, `BUG-11`), устойчивый bootstrap UI (`BUG-02`, `BUG-08`, `PERF-01`), RAII-очистка Breakpoints (`BUG-04`), конкурентный релей WebSocket (`BUG-05`), сверка SHA-256 Root CA (`BUG-06`), фиксы `HEAD` / `Content-Encoding` (`BUG-07`), предкомпиляция Regex + IPv6 / `.domain.com` (`BUG-09`, `PERF-03`), откат `sysproxy` (`BUG-10`) и неразрушающий fail-open очереди Python-воркера (`PERF-04`).
- ✅ **Архитектурная декомпозиция и оптимизация бандла (`v0.5.0`, `ARCH-01`, `PERF-05`)**: модульное разбиение Rust-ядра (`proxy/server/`, `proxy/filters/`, `storage/export_import/`) и UI-компонентов, внедрение **Zustand 5**, `React.lazy()` + `Suspense`, ленивый `getPreviewEngine()` и удаление чанка `ts.worker` (7.05 МБ).
- ✅ **Fiddler-тайминги, статистика запросов и сетевая маршрутизация (`v0.5.0`)**: инструментированный `UpstreamHttpClient` (`hyper-util` + `tokio-rustls`), панель **`Statistics`** (Single & Multi-Selection с SVG-диаграммами и *Estimated Worldwide Performance*), колонки `TTFB` / `Server IP`, реальный round-trip таймингов HAR/SAZ, **HOSTS Remapping (`Ctrl+Shift+H`)**, **Bandwidth Throttling**, **Upstream Proxy Chaining (`Ctrl+Shift+U`)** (`HTTP`/`HTTPS`/`SOCKS5`) и **ручная инъекция WebSocket-фреймов**.
- ✅ **Стабилизация ядра, раздельные таймауты и защита ключей (`v0.6.0`, Этапы 35, 39, 36)**: унификация маршрутизации `HOSTS Remapping` + `Upstream Proxy` (`via <proxy>` в `Server IP`) + WebSocket, атомарное сохранение инъектированных WS-фреймов, лимит `64 MiB` ответа, раздельные `Upstream Timeouts` (`Connect` / `TTFB Unlimited` / `Composer`) с кнопкой `Cancel` и RAII-гардом `499`, Windows **DPAPI** (`FLUX_DPAPI_V1`) + режим **`Session-only (In-Memory)`**, **`LAN Client Allowlist`** (`403 Forbidden`), запрет SVG в превью Multipart, чистота `syncFromLocalStorage` и вынос `previewEngine.ts` / `useGlobalShortcuts.ts`.
- ✅ **Редизайн UX, 3-уровневая архитектура экранов и Settings Hub (`v0.6.0`, Этапы 37, 38, 40, 42)**: фиксы колонковой сетки `HexViewer` и оверлей-тултипа `TIMING BREAKDOWN`, **Command Palette 2.0 (`Ctrl+K`)**, единый полноэкранный **`Settings Hub`** (`Ctrl+,`) с 6 разделами и сквозным поиском, дедупликация навигации с видимым `Throttle` + `Routing` и `HelpTooltip`, Fiddler-style хоткей **`E`** для вкладки `Composer`, `CollapsedInspectorBar`, 7 неблокирующих вкладок (`Traffic`, `Composer`, `AutoResponder`, `Breakpoints` `Alt+6`, `Scripts`, `Session Diff`, `TextWizard`) и единые заголовки `SECTION_REGISTRY` + `SectionHeader`.
- ✅ **Единая система контекстных ПКМ-меню (`v0.6.0`, Этап 41)**: декларативный `ContextMenuProvider` с auto-flip / clamping и клавиатурной навигацией во всех рабочих областях при сохранении штатного меню Monaco Editor.
- ✅ **Виртуализированный многофазный Waterfall Timeline и Traffic Statistics (`v0.6.0`, Этап 12)**: переключение `Grid` ↔ `Waterfall` для 10 000+ сессий с разбивкой фаз `DNS`/`TCP`/`TLS`/`TTFB`/`Download`, зумом и синхронизацией инспектора, а также модальный сводный отчёт `Traffic Statistics` (P95 Latency/TTFB, статусы, MIME, хосты, топ-5 URL, **Copy Markdown Report**).
- ✅ **Безопасность периметра, протокольная точность и двухуровневый lifecycle (`v0.7.0`, Этапы 43, 44)**: блокировка LAN→Loopback DNS SSRF (`lookup_host`) + изолированный пул `UpstreamHttpClient` для удалённых пиров, Write-Only хранилище mTLS без сырых `.p12`/`.pfx` на диске, проверка `Host`/`:authority` во **всех** режимах MITM, реестр диалог-токенов `AUTHORIZED_DIALOG_PATHS` + `export_text_file`, потолок `16 MiB` `stdout` Python-воркера, сохранение не-ASCII заголовков (`raw_bytes_b64`), чистка `MockResponse` заголовков, сохранение кастомного `Host`, `Content-Length: 0`, фиксы SSE/chunked/streaming веток `4a`/`4b`/`4c`, полная защита от self-loop/двойного `HOSTS`-ремапа, отмена всех фаз Composer + `final_url` и двухуровневая остановка (**Graceful Drain 30 с** по `F12` vs **Hard Abort 0 мс** при смене периметра).
- ✅ **Потолок памяти, потоковый SQLite/Export, OS-диагностика и гранулярная фильтрация (`v0.7.0`, Этапы 45, 46, 47, 49, 48)**: оффлоад тел `BreakpointEngine > 256 KiB`, асинхронный фоновый писатель SQLite без повторной записи request-тела и 150-мс тиков, санитизация `multipart/form-data` + лимит 50 000 записей `.saz`, потоковый экспорт (RAM по умолчанию + `include_evicted_sqlite`), pre-check `requestSize` в `OpenApiExportModal`, статический потолок памяти Monaco `2 MiB` (`MonacoSizeGuardNotice`), фикс Win32 Firewall `ERROR_MORE_DATA` + диагностика Windows GPO (`ProxySettingsPerUser`) и внешнего SSL/EDR-инспектора, Tier-1 Linux PKI (Debian/Ubuntu, Fedora/RHEL/openSUSE, Arch) + KDE `kioslaverc`/no-DE фоллбэк, 60-с таймаут `security`/`pkexec` с копируемой CLI-командой, singleflight `try_get_with` + `spawn_blocking` в `ca.rs`, развязка IPC-батчера и `ipc_channels.rs`, кэширование TLS `ClientConfig`, $O(1)$ `sessionIndexById`, ленивый `./previewEngine` и удаление `css.worker`/`html.worker`, перенос `reqwest` в `[dev-dependencies]`, удаление `clsx`/`tailwind-merge`/дубля `update_proxy_filter_config`/`autofocus`, 4 независимых фильтра (`CSS`, `Images`, `Fonts`, `JS`) с миграцией `hideStaticAssets` и декомпозиция монолитов (`server/pipeline_stages.rs`, `server/tests/`, `lib/settings/`, `components/workspaces/`, `useStoreGlobalSync`, `mockProxyBridge.ts`).

### Дальнейшее развитие:
- Все запланированные этапы Спринтов 1–7 (Этапы 1–49) выполнены в релизах `v0.1.0`–`v0.7.0` (см. [**ROADMAP.md**](ROADMAP.md)). В будущих релизах планируются автоматизированные релизные сборки под macOS (`.dmg`) и Linux (`.AppImage` / `.deb`).

---

## 🤝 Разработка и Contributing

1. Сделайте Fork репозитория и создайте ветку (`git checkout -b feature/my-feature`).
2. Внесите изменения и убедитесь, что сборка и тесты проходят чисто:
   ```bash
   npm run typecheck
   npm run test
   npm run build
   cargo clippy --locked --manifest-path src-tauri/Cargo.toml -- -D warnings
   cargo test --locked --manifest-path src-tauri/Cargo.toml
   ```
3. Сделайте коммит и откройте **Pull Request**.

---

## 📄 Лицензия

Проект распространяется под свободной лицензией **MIT**. Подробности см. в файле [LICENSE](LICENSE).
