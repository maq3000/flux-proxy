# 🗺️ Дорожная карта (Roadmap) развития FluxProxy

> **FluxProxy** — кроссплатформенный локальный отладочный HTTP/HTTPS/WebSocket-прокси на базе **Tauri v2 (Rust)** и **React 18 (TypeScript)**.
>
> Документ содержит актуальный статус реализованных подсистем, упорядоченную по спринтам матрицу приоритетов с явными зависимостями, инженерные ограничения кодовой базы и **самодостаточные промпты для агента Antigravity**.

---

## ✅ Реализованные этапы (Verified Milestones)

Следующие подсистемы **полностью реализованы, покрыты тестами в кодовой базе и не требуют повторной разработки**:

1. **Поддержка мобильных устройств (iOS & Android):**
   - Биндинг `0.0.0.0` (`set_allow_remote`), автоопределение LAN IP (`get_network_interfaces` в `src-tauri/src/proxy/network.rs`) и встроенный веб-портал `http://flux.proxy` с отдачей `.crt`, `.der`, `.pem` и `.mobileconfig`.
   - Модальное окно `src/components/MobileSetupModal.tsx` (`Ctrl+Shift+M`) с QR-кодами и шаблоном Android `network_security_config.xml`; покрыто интеграционными тестами в `src-tauri/src/proxy/server.rs`.
2. **Массовый фильтр хостов (Bulk Hosts List), матрица фильтров и протокольные инспекторы:**
   - Вкладка `src/components/HostFiltersTab.tsx` с многострочным вводом доменов, масок `*` и `regex:`, режимами Whitelist / Blacklist и опциональной синхронизацией с TLS Passthrough (`applyToTlsPassthrough`).
   - Матрица фильтров (`src/components/FilterDrawer.tsx`, `src/lib/filterEngine.ts`, `src-tauri/src/proxy/filters.rs`), пороги шума, мутации заголовков и анализаторы в `src/components/InspectorProtocolPanels.tsx` (SSE/LLM, gRPC/Protobuf, Auth, RFC 9111 Cache, Multipart).
3. **Совместимость с WebSocket и SignalR:**
   - Полный форвардинг заголовков клиента (`Authorization`, `Cookie`, `Sec-WebSocket-Protocol`, `X-SignalR-*`) в `build_upstream_websocket_request` (`src-tauri/src/proxy/server.rs`) с unit-тестами.
4. **Базовая эргономика интерфейса:**
   - Виртуализированная таблица `src/components/TrafficGrid.tsx` (интерактивный ресайз колонок и двойной клик для auto-fit, поповер видимости колонок по правому клику на шапку).
   - Верхнее меню `src/components/MenuBar.tsx` (`File`, `Edit`, `Rules`, `View`, `Tools`, `Help`), базовый переключатель `compactToolbar` и справочник горячих клавиш `src/components/ShortcutsModal.tsx` (`?`).
5. **[Этап 1 — Выполнено] Сетевая надежность, блокировка HTTP/3 (`Alt-Svc`) и безопасность CA / CSP:**
   - Автоудаление `Alt-Svc` / `Alternate-Protocol` (`strip_alt_svc`), проверка доверия ОС (`isTrusted`), установка (`install_root_ca`) и удаление корневого сертификата (`uninstall_root_ca`) в `src-tauri/src/proxy/ca.rs` и `src/components/CertificateModal.tsx`, защита ключа правами `0600` и строгая CSP в `src-tauri/tauri.conf.json`.
6. **[Этап 2 — Выполнено] Кольцевой буфер памяти (Ring Buffer), захват с фильтрацией и оффлоадинг тел:**
   - Настройка лимита сессий (`All Sessions / 100..10 000 / Custom...`), FIFO-вытеснение из `DashMap` в SQLite (`src-tauri/src/storage/mod.rs`, `sqlite.rs`) и ленивая подгрузка тел > 2 MiB (`load_session_body`).
   - Очистка `TrafficStore::clear()` удаляет RAM-сессии и неархивированные оффлоад-тела (`delete_unarchived_offloaded_bodies`), но не затрагивает уже вытесненные записи в `captured_sessions`.
   - Стриминговый отсев `Drop Non-Matching` (`set_drop_non_matching`) и телеметрия `RAM | SQLite | Dropped` в строке состояния (`src/App.tsx`).
7. **[Этап 3 — Выполнено] Поддержка HAR 1.2, Fiddler SAZ (`.saz`), JSON, Raw HTTP и выгрузки тел:**
   - Модуль `src-tauri/src/storage/export_import.rs`, нативные диалоги (`rfd`), горячие клавиши `Ctrl+S` / `Ctrl+O`, Drag-and-Drop архивов и команда `save_session_body_file`.
8. **[Этап 4 — Выполнено] Версионированные профили настроек и централизованный Preferences:**
   - Схема `FluxUserSettingsProfile` (`schemaVersion: 1`, `src/types/settings.ts`), валидатор/мигратор `src/lib/settingsManager.ts` и модальное окно `src/components/SettingsModal.tsx` (`Ctrl+,`) с 5 вкладками (*General*, *UI & Columns*, *Filters*, *Rules & Proxy*, *Backup & Export*).
9. **[Этап 26 — Выполнено] Безопасность: защита от XSS и инъекций, CSP и устранение UB в Rust:**
   - Санитизация `host_header`, отказ от небезопасного рендеринга SVG `data:`, устранение shell/CLI-инъекций (`pkexec`, `adb`/cURL, CRLF), валидация IPC-путей, усиление CSP и исправление UB/паник в Rust (`process.rs`, `network.rs`, `sysproxy.rs`, `filters.rs`).
10. **[Этап 27 — Выполнено] Целостность `TrafficStore` и SQLite, безопасность парсеров SAZ и консистентность CA:**
    - Настройка SQLite `busy_timeout`, корректная дочитка вытесненных сессий с диска, защита парсеров `.saz`/HAR от ZIP-бомб и переполнения (включая UTF-16BE), а также консистентная загрузка Root CA.
11. **[Этап 20 — Выполнено] Управление хранилищем SQLite (ручная очистка `VACUUM` и автоочистка при выходе):**
    - Очистка `sessions.sqlite` через `VACUUM` + `wal_checkpoint(TRUNCATE)`, интерактивный индикатор размера БД в статус-баре, кнопка очистки в настройках и опция *Clear DB on App Exit*.
12. **[Этап 21 — Выполнено] Двухфазный захват сессий (In-Flight / Pending в стиле Fiddler):**
    - Мгновенное появление запроса в таблице при получении заголовков (`status: 0` / `Pending`) еще до ответа сервера и real-time обновление метрик/тела после завершения ответа.
13. **[Этап 14 — Выполнено] Поддержка сжатия Zstandard (RFC 8878 / `zstd`):**
    - Прозрачная потоковая распаковка `Content-Encoding: zstd` на лету в прокси-ядре и Composer, а также кодирование/декодирование `Zstd` в TextWizard и Compression Codec.
14. **[Этап 15 — Выполнено] Привязка к конкретному IP / сетевому интерфейсу и мульти-бинд:**
    - Выбор конкретного сетевого адаптера (Wi-Fi/Ethernet/WSL/VPN) и режим Dual Listener (loopback + выбранный интерфейс) без обязательного открытия порта на `0.0.0.0`.
15. **[Этап 25 — Выполнено] Надежность upstream-соединений, стриминг видео, диагностика ошибок и консистентный TCP-проброс:**
    - Zero-buffering стриминг для видео/CDN и ответов `206`, диагностика причин обрывов по цепочке `err.source()`, Video & CDN Quick-Pack и мгновенный сброс активных MITM-туннелей в Passthrough.
16. **[Этап 28 — Выполнено] Неблокирующий Tokio-рантайм, предкомпиляция Regex и потоковый SSE/WebSocket:**
    - Вынос `resolve_client_process` и операций SQLite в `spawn_blocking`, предкомпиляция `Regex`, устранение квадратичной сложности ($O(N^2)$) в SSE/WebSocket и переиспользование пула `reqwest::Client` в Composer.
17. **[Этап 24 — Выполнено] Интерактивная сортировка колонок таблицы (ASC/DESC) и массовое выделение (Ctrl+A):**
    - Циклическая сортировка всех 10 колонок `ColumnId` (`null → asc → desc → null`, компараторы в `src/components/TrafficGrid.tsx`, пункты контекстного меню шапки, адаптация `followTail`) и массовое выделение видимых сессий по `Ctrl+A` / `Cmd+A` (`Edit → Select All Sessions`, `selectSessions` в `useProxySessions.ts`).
18. **[Этап 23 — Выполнено] Персистентность геометрии сплитов и адаптивной сетки панелей:**
    - Сохранение пропорций всех 4 `<PanelGroup>` (`flux-layout-bottom-outer-v1`, `flux-layout-bottom-inner-v1`, `flux-layout-right-v1`, `flux-inspector-split-v1`), настройка `inspectorSplitDirection` (`"auto" | "horizontal" | "vertical"`) в `useUiPreferences.ts` и `FluxUserSettingsProfile`, сброс двойным кликом по разделителю и команда `View → Reset Panel Layout to Default`.
19. **[Этап 5 — Выполнено] Ультра-компактный тулбар, автоподбор колонок и шорткаты инспектора:**
    - Однострочный Slim-тулбар (`Ctrl+Shift+T` / `Cmd+Shift+T`) с выносом второстепенных кнопок в меню переполнения `•••`, определение колонки через `data-col-id` в контекстном меню шапки `TrafficGrid.tsx` с пунктами `Auto-fit "<Column>"` и `Auto-fit All Visible Columns`, а также быстрые шорткаты вкладок активной панели `SessionInspector` (`Ctrl+1` … `Ctrl+6`).
20. **[Этап 16 — Выполнено] Очистка и маскирование PII / секретов при экспорте (Sanitized Export):**
    - Структура `SanitizationOptions` и функция `sanitize_sessions` в `src-tauri/src/storage/export_import.rs` для санитизации `.har`, `.saz`, `.json` и Raw HTTP (`.txt`), модальное окно `src/components/SanitizedExportModal.tsx` (`File → Export Sanitized Sessions…`, `Ctrl+Shift+S`) с пресетами *Safe Sharing*, *Strict Anonymization* и *Custom* и unit-тестами.
21. **[Этап 17 — Выполнено] Диагностический мастер самопроверки «Proxy Doctor»:**
    - Модуль `src-tauri/src/proxy/doctor.rs` (`run_proxy_doctor`, `fix_doctor_issue`), лёгкий маршрут `http://flux.proxy/health` (`200 OK` без замусоривания `TrafficStore`), 6 проверок (порт/сокет, доверие Root CA, системный прокси ОС, конфликтующие VPN/TUN-интерфейсы, Windows Firewall, сквозная loopback-проверка) и модальное окно `src/components/ProxyDoctorModal.tsx` (`Help → Run Proxy Doctor…`, `Ctrl+Shift+D`).
22. **[Этап 29 — Выполнено] Единый источник конфигурации запуска, устранение гонок useProxySessions и честные ошибки Bridge:**
    - Единый источник стартового порта (`proxy_port.pref` в `app_data_dir`) в `lib.rs` и `sysproxy.rs` без двойного старта `:8888`, автооткат порта при `AddrInUse` в `setProxyPort`, устранение утечки подписки в React StrictMode и гонок фильтров/деталей в `useProxySessions.ts`, поддержка `requestBodyBase64`/offloaded тел в `replaySessions`, транзакционный `applySettingsProfile` с поддержкой `breakpoints` (`BreakpointConfig`), отказ от маскировки ошибок IPC в `tauriBridge.ts` и нативная команда `generate_stress_sessions`.
23. **[Этап 30 — Выполнено] Исправление багов UI-компонентов, виртуализация HexViewer и настройка manualChunks:**
    - Виртуализация `src/components/HexViewer.tsx` через `@tanstack/react-virtual` (без перерисовки всей таблицы на hover), настройка `manualChunks` в `vite.config.ts` (`monaco-editor`, `react-vendor`, `tauri-ui`), исправление багов в `BreakpointModal.tsx`, `ComposerPanel.tsx`, `AutoResponderPanel.tsx`, `SessionInspector.tsx` (`ws`/`wss`, токены загрузки тел), `TrafficGrid.tsx` (cleanup слушателей, `finally` для popover, `followTail` по хвостовому ID), `textWizard.ts` (JWT `null`-защита) и `mockTraffic.ts`.
24. **[Этап 22 — Выполнено] Продвинутая кастомизация темы: 8 пресетов, редактор палитры и синхронизация Monaco:**
    - Модуль `src/lib/themePresets.ts` с 8 темами (`default-dark`, `default-light`, `dracula`, `tokyo-night`, `nord`, `fiddler-classic`, `github-dark`, `monokai-pro`), helper `hexToRgbaString` / `deriveSelectedBgHex`, динамическое применение токенов в `src/hooks/useTheme.ts`, синхронизация темы Monaco Editor (`src/lib/monaco.ts`), галерея пресетов и детальный редактор палитры в `SettingsModal.tsx`, интеграция с `FluxUserSettingsProfile` (`src/types/settings.ts`, `src/lib/settingsManager.ts`) и `CommandPalette`, а также unit-тесты `src/lib/themePresets.test.ts`.
25. **[Этап 6 — Выполнено] Selective MITM & Bypass 2.0: Bulk Editor, 11 Quick-Packs, PKI-дефолты и lock-free Hit Counter:**
    - Выделение `default_tls_bypass_rules()` с PKI/OCSP/CRL и мессенджерами в `src-tauri/src/proxy/filters.rs`, lock-free счётчик попаданий `hit_counts: DashMap<String, AtomicU64>`, команды `get_tls_rule_hit_counts` и `reset_tls_bypass_rules_to_recommended` (`commands.rs`), синхронизация `TLS_BYPASS_QUICK_PACKS` (11 наборов) и чистые конвертеры `tlsRulesToBulkText` / `parseBulkTextToTlsRules` (`src/lib/filterEngine.ts`), режимы `Table View` ↔ `Bulk Text Editor`, `Quick Paste…`, импорт/экспорт TXT/JSON, чипы доменов сессии, бейджи `Hits: N` в `FilterDrawer.tsx` и бейдж `TUNNEL` в `TrafficGrid.tsx`.
26. **[Этап 18 — Выполнено] Клиентские сертификаты (mTLS / Client Certificates Store):**
    - Модуль `src-tauri/src/proxy/client_certs.rs` (`ClientCertificateStore`) с поддержкой PKCS#12 (`.p12`/`.pfx`) и PEM, извлечением X.509 CN / срока действия (`x509-parser`), безопасным хранением в `app_data_dir/client_certs` (права `0600` на Unix, без утечки паролей в профили настроек), сопоставлением точных и wildcard-доменов (`*.domain.com`), кэшированием upstream mTLS-клиентов в `moka::sync::Cache`, интеграцией в `server.rs`, командами `list_client_certificates` / `add_client_certificate` / `toggle_client_certificate` / `remove_client_certificate` и модальным окном `src/components/ClientCertificatesModal.tsx` (`Tools → Client Certificates…`, `Ctrl+Shift+C`).
27. **[Этап 7 — Выполнено] Кастомные скрипты на Python (Python Scripting Engine):**
    - Модули `src-tauri/src/scripting/mod.rs` и `python_runner.rs` с автопоиском Python 3, долгоживущим JSON Lines IPC-воркером, сериализацией через `AsyncMutex` и fail-open таймаутом 1500 мс, вызовами `on_request` / `on_response` в `server.rs` (после декомпрессии `zstd` и с пропуском SSE / `video/*` / `206`), трансляцией `stdout`/`stderr` в `proxy://script-console-log`, панелью `src/components/ScriptingPanel.tsx` (`Alt+5`, Monaco Editor, 4 пресета, живая консоль), сохранением в `FluxUserSettingsProfile`, тестами и гайдами [`PYTHON_SCRIPTING_GUIDE.md`](PYTHON_SCRIPTING_GUIDE.md) / [`PYTHON_SCRIPTING_AI_GUIDE.md`](PYTHON_SCRIPTING_AI_GUIDE.md).
28. **[Этап 8 — Выполнено] Composer 2.0: Умный «Paste cURL» и генератор клиентского кода на 5 языках:**
    - Чистый детерминированный лексер-парсер `src/lib/curlParser.ts` (POSIX Bash, Windows cmd `^` и PowerShell), кнопка `Import cURL` и перехват вставки `curl ...` в URL в `src/components/ComposerPanel.tsx`, модуль `src/lib/codeGenerators.ts` и модальное окно `src/components/CodeSnippetModal.tsx` (Monaco Editor) для генерации кода на **JavaScript** (`fetch`, `axios`), **Python** (`requests`, `httpx`), **Go** (`net/http`), **Rust** (`reqwest`) и **cURL** (Bash, PowerShell) из Composer, `TrafficGrid.tsx` и `MenuBar.tsx`, с unit-тестами `curlParser.test.ts` и `codeGenerators.test.ts`.
29. **[Этап 19 — Выполнено] Автоматическая генерация спецификаций OpenAPI 3.0.3 / Swagger:**
    - Чистый генератор `src/lib/openApiGenerator.ts` (параметризация числовых ID и UUID в `{id}` / `{uuid}`, объединение статус-кодов и рекурсивное слияние JSON Schema, безопасный вынос `Authorization` / `Cookie` / `X-Api-Key` в `components.securitySchemes` без раскрытия боевых секретов, сериализатор YAML/JSON) и модальное окно `src/components/OpenApiExportModal.tsx` (Monaco Editor, настройка title/version/`Include Examples`, сохранение файла) с вызовом из `MenuBar.tsx` (`File → Export as OpenAPI 3.0 Spec…`), контекстного меню `TrafficGrid.tsx` и `CommandPalette`, плюс unit-тесты `openApiGenerator.test.ts`.
30. **[Этап 9 — Выполнено] Тестирование фронтенда (Vitest) и кроссплатформенный CI/CD (GitHub Actions):**
    - Настройка `Vitest 3` (`jsdom`) и `@testing-library/react` в `package.json` и `vite.config.ts`, 11 тестовых файлов (80 unit/integration-тестов для `src/lib/*.ts` и `src/hooks/useProxySessions.test.tsx`), а также `.github/workflows/ci.yml` для матрицы `ubuntu-latest`, `windows-latest`, `macos-latest` (`npm ci`, `typecheck`, `test`, `build`, `cargo clippy -- -D warnings`, `cargo test`).

---

## 📋 Матрица приоритетов и порядок выполнения

> *Номера этапов (`31–33`, `10–13`) используются как стабильные идентификаторы задач (`phase-N`). Все секции документа ниже отсортированы строго в порядке выполнения сверху вниз. Завершенные этапы Спринта 1 (Этапы 14, 15, 20, 21, 25–28) выполнены в релизе `v0.2.0`, этапы Спринта 2 (Этапы 5, 16, 17, 23, 24, 29, 30) выполнены в релизе `v0.3.0`, а этапы Спринта 3 (Этапы 6, 7, 8, 9, 18, 19, 22) выполнены в релизе `v0.4.0` и перенесены в раздел реализованных этапов выше. По результатам глубокого аудита `v0.4.0` ([PROJECT_CONTEXT_AND_AUDIT.md](PROJECT_CONTEXT_AND_AUDIT.md)) перед разработкой новых фич сформирован стабилизационный **Спринт 4 (Этапы 31–33)**.*

| # | Этап | Приоритет | Спринт | Зависимости | Ключевая ценность |
| :-: | :--- | :--- | :--- | :--- | :--- |
| 1 | **[Этап 31](#этап-31-критическая-безопасность-защита-импорта-профилей-rce-изоляция-файлового-ipc-санитизация-piissews-и-защита-от-oom-бомб)** | **P0 (Security / Blocker)** | Спринт 4 | Этапы 4 ✅, 7 ✅, 16 ✅, 18 ✅ | Устранение скрытого RCE при импорте настроек (`SEC-01`), Path Traversal в IPC (`SEC-02`), LAN SSRF/mTLS (`SEC-03`), утечек в санитизаторе (`SEC-04`), OOM-бомб (`SEC-05`, `BUG-12`) и защиты ключей (`SEC-06`) |
| 2 | **[Этап 32](#этап-32-целостность-хранилища-trafficstore--sqlite-и-реактивного-состояния-ui)** | **P0 (Data Integrity / Perf)** | Спринт 4 | Этапы 2 ✅, 20 ✅, 28 ✅, 29 ✅ | Устранение коллизии `next_id = 1` после рестарта (`BUG-01`), потери тел `> 2 MiB` при `VACUUM` (`BUG-03`), срыва IPC-подписок в `bootstrap()` (`BUG-02`), дублей в гриде (`BUG-08`), спама `getSessionDetail` (`PERF-01`) и блокировок SQLite (`BUG-11`, `PERF-02`, `PERF-06`) |
| 3 | **[Этап 33](#этап-33-надежность-сетевого-ядра-протоколов-httpwstls-фильтров-и-диагностики)** | **P1 (Core Reliability)** | Спринт 4 | Этапы 1 ✅, 6 ✅, 7 ✅, 15 ✅, 17 ✅ | Очистка зависших Breakpoints при дисконнекте (`BUG-04`), устранение deadlock в WebSocket (`BUG-05`), сверка SHA-256 Root CA (`BUG-06`), фикс `HEAD` и `Content-Encoding` (`BUG-07`), `.domain.com`/IPv6 и предкомпиляция Regex в `filters.rs` (`BUG-09`, `PERF-03`), откат `sysproxy` (`BUG-10`), стабилизация `ProxyDoctor` (`BUG-13`) и очереди Python (`PERF-04`) |
| 4 | **[Этап 10](#этап-10-сетевая-инфраструктура-hosts-remapping-и-bandwidth-throttling)** | **P2 (Feature)** | Спринт 5 | Этапы 15 ✅, 25 ✅, 33 | Виртуальный DNS (`resolve` / `CONNECT`) без правки системного `hosts` и эмуляция медленных сетей |
| 5 | **[Этап 11](#этап-11-архитектурная-декомпозиция-монолитов-внедрение-zustand-и-оптимизация-бандла)** | **P2 (Architecture / Perf)** | Спринт 5 | Этапы 31–33 | Разделение крупных Rust/React-модулей (`ARCH-01`), ленивый `BrowserPreviewEngine` и удаление `ts.worker` 7 МБ (`PERF-05`), внедрение `zustand` и `React.lazy()` |
| 6 | **[Этап 12](#этап-12-аналитика-и-визуализация-waterfall-timeline-и-статистика-трафика)** | **P2 (Feature)** | Спринт 5 | — | Виртуализированная каскадная диаграмма таймингов и сводный Markdown-отчет (P95, статусы, MIME) |
| 7 | **[Этап 13](#этап-13-расширенные-протоколы-upstream-proxy-chaining-и-ws-инъекция)** | **P2 (Feature)** | Спринт 5 | Этапы 18 ✅, 25 ✅, 33 | Каскадирование трафика через внешний HTTP/HTTPS/SOCKS5-прокси и отправка фреймов в открытые WS |

---

## ❓ Открытые вопросы и продуктовые неоднозначности (По итогам аудита `v0.4.0`)

> Полный доказательный разбор каждой находки с трассировкой строк кода см. в [PROJECT_CONTEXT_AND_AUDIT.md](PROJECT_CONTEXT_AND_AUDIT.md). Ниже зафиксированы архитектурные и продуктовые развилки (`[Требует проверки]`), требующие принятия решения при реализации Спринта 4:

1. **Вызов Python-хуков (`on_request` / `on_response`) для запросов из Request Composer (`src-tauri/src/proxy/server.rs:1544-2122`):**
   - *Фактическое поведение:* `execute_composed` пропускает запросы через Header Mutations, Live Breakpoints (`Before Request` / `After Response`) и AutoResponder, но полностью обходит `PythonScriptRunner`.Кроме того, в `_normalize_headers_in` (`src-tauri/src/scripting/python_runner.rs:56-65`) дублирующиеся одноимённые заголовки (например, несколько `Set-Cookie`) схлопываются до последнего значения при чтении словаря `headers` в Python.
   - *Неоднозначность:* Должны ли запросы из Composer проходить через активный Python-скрипт (например, для автоматического расчёта `X-Signature` / HMAC), или необходим отдельный чекбокс в UI Composer *«Run Python script hooks on composed requests»*?
2. **Политика очистки `Purge SQLite Archive (VACUUM)` для выгруженных тел (`> 2 MiB`) активных RAM-сессий (`[BUG-03]`, `src-tauri/src/storage/mod.rs:162-169`, `src-tauri/src/storage/sqlite.rs:380-397`):**
   - *Фактическое поведение:* В `USER_GUIDE.md:186` заявлено, что очистка архива SQLite не затрагивает текущие сессии в RAM. Однако `purge_and_vacuum` выполняет `DELETE FROM offloaded_bodies;`, безвозвратно удаляя тела (`> 2 MiB`) всех живых сессий в RAM (`body_offloaded: true`).
   - *Рекомендуемое решение в Этапе 32:* Удалять из `offloaded_bodies` только записи, чьи `session_id` отсутствуют в `self.sessions` в RAM (`WHERE session_id NOT IN (...)`).
3. **Хранение приватных ключей mTLS из защищённых паролем `.p12`/`.pfx` (`[SEC-06]`, `src-tauri/src/proxy/client_certs.rs:640-652`):**
   - *Фактическое поведение:* При импорте `.p12`/`.pfx` архив расшифровывается в памяти, после чего приватный ключ сохраняется на диск **в открытом текстовом виде (unencrypted PEM)** в `app_data_dir/client_certs/{id}.identity.pem`, а на Windows функция `write_bytes_securely` (`client_certs.rs:89-92`) не применяет ни DPAPI, ни ограничивающий NTFS DACL.
   - *Неоднозначность:* Должен ли FluxProxy шифровать `{id}.identity.pem` и `fluxproxy-root-ca.key` на диске средствами ОС (Windows DPAPI `CryptProtectData` / OS Keychain), или для парольных корпоративных сертификатов дополнительно нужен режим *«Session-only (In-Memory)»* без записи ключа на диск?
4. **Контроль доступа для LAN-клиентов в режимах `AllInterfaces` (`0.0.0.0`) и `Specific` (`[SEC-03]`, `src-tauri/src/proxy/server.rs:517-585, 2152-2162, 3000`):**
   - *Фактическое поведение:* Любое устройство в той же Wi-Fi сети может подключиться к открытому порту прокси без аутентификации, открыть `CONNECT`-туннель к локальным сервисам `127.0.0.1` хост-машины и отправлять запросы во внешние сети с автоматическим прикреплением хозяйских mTLS-сертификатов разработчика.
   - *Неоднозначность:* Помимо обязательного запрета проксирования на loopback и отключения хозяйских mTLS для внешних IP (включено в Этап 31), какой UX контроля доступа предпочтителен для мобильной отладки: ручной список разрешённых IP (`Client IP Allowlist`), интерактивное подтверждение нового устройства в тосте UI или опциональная `Proxy-Authorization`?
5. **Судьба неиспользуемых SQLite-индексов `idx_sessions_url` и `idx_sessions_status` (`[PERF-06]`, `src-tauri/src/storage/sqlite.rs:51-52`):**
   - *Фактическое поведение:* Оба индекса создаются при инициализации БД и обновляются на каждый `INSERT OR REPLACE`, но ни один SQL-запрос в `sqlite.rs` не фильтрует по колонкам `url` или `status`.
   - *Неоднозначность:* Удалить эти индексы в Этапе 32 (`DROP INDEX IF EXISTS`) для ускорения батч-вытеснения или оставить под будущий полнотекстовый/SQL-поиск по дисковому архиву?
6. **Актуализация документации (`README.md`, `USER_GUIDE.md`, `PYTHON_SCRIPTING_GUIDE.md`):**
   - В `README.md:299` указано, что на macOS Root CA устанавливается в *System Keychain*, хотя фактически `src-tauri/src/proxy/ca.rs:522-537` устанавливает его в пользовательский `~/Library/Keychains/login.keychain-db`.

---

## ⚙️ Общие инженерные правила

1. **Изоляция новых подсистем (Modular-First Guardrail):**
   Ключевые файлы уже достигли сверхкрупных размеров (`src-tauri/src/proxy/server.rs` — 7 759 строк, `export_import.rs` — 4 053, `FilterDrawer.tsx` — 3 820, `App.tsx` — 3 747, `SettingsModal.tsx` — 3 599, `tauriBridge.ts` — 3 371, `useProxySessions.ts` — 3 337, `settingsManager.ts` — 2 859, `filters.rs` — 2 571, `filterEngine.ts` — 2 328, `sysproxy.rs` — 2 276). При реализации новых этапов **выносите новую логику в отдельные Rust-модули, TS-утилиты и React-компоненты**, минимизируя разрастание существующих монолитов до рефакторинга в Этапе 11.
2. **Обязательная верификация после каждого этапа:**
   - Проверка типов: `npm run typecheck`
   - Тесты фронтенда: `npm run test`
   - Сборка фронтенда: `npm run build`
   - Линтер Rust: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
   - Rust-тесты: `cargo test --manifest-path src-tauri/Cargo.toml`
3. **Dual-Mode разработка (Browser Preview Simulator):**
   Каждая новая Tauri-команда и событие должны иметь безопасный fallback в `src/lib/tauriBridge.ts` и `src/lib/mockTraffic.ts`, чтобы интерфейс полноценно запускался через `npm run dev` в обычном браузере.
4. **Обратная совместимость `FluxUserSettingsProfile`:**
   Новые настройки (`src/types/settings.ts`, `src/lib/settingsManager.ts`) добавляйте как опциональные с безопасными значениями по умолчанию и fallback-нормализацией при импорте старых JSON-профилей `schemaVersion: 1` (или повышайте `CURRENT_SETTINGS_SCHEMA_VERSION` с обязательной миграцией `v1 -> vN`).
5. **Паритет Rust ↔ TypeScript:**
   Изменения в правилах фильтрации, TLS-режимах или типах данных синхронизируйте между `src-tauri/src/models.rs` ↔ `src/types/proxy.ts` и `src-tauri/src/proxy/filters.rs` ↔ `src/lib/filterEngine.ts`.
6. **Атомарная фиксация в Git:**
   ```bash
   git add .
   git commit -m "feat(phase-N): <краткое описание выполненного этапа>"
   ```

---

## 🔴 Спринт 4 — P0 / P1 (Audit Remediation): Безопасность, целостность хранилища и стабилизация ядра

---

## Этап 31: Критическая безопасность: защита импорта профилей (RCE), изоляция файлового IPC, санитизация PII/SSE/WS и защита от OOM-бомб
**Приоритет: P0 (Security / Blocker) | Спринт 4 | Зависимости: Этапы 4 ✅, 7 ✅, 16 ✅, 18 ✅ | Находки аудита: `SEC-01`, `SEC-02`, `SEC-03`, `SEC-04`, `SEC-05`, `SEC-06`, `BUG-12`**

### Цель и контекст
В ходе всестороннего аудита `v0.4.0` ([PROJECT_CONTEXT_AND_AUDIT.md](PROJECT_CONTEXT_AND_AUDIT.md)) выявлены векторы атак и утечек данных:
1. **`[SEC-01]` Скрытый RCE через Python Scripting при импорте настроек:** `applySettingsProfile` (`src/lib/settingsManager.ts:2538-2545, 2602`) автоматически вызывает `proxyBridge.setPythonScript(nextScripting.code, nextScripting.enabled)` (запуская `exec(compiled, new_ns)` в `src-tauri/src/scripting/python_runner.rs:209`), при этом `buildSettingsImportPreview` (`settingsManager.ts:2237-2317`) и `SettingsImportPreviewSummary` (`src/types/settings.ts:122-153`) вообще не показывают наличие или статус Python-скрипта.
2. **`[SEC-02]` Path Traversal и перезапись произвольных файлов через IPC:** `validate_user_file_path` (`src-tauri/src/commands.rs:573-638`) проверяет только конечный `path.file_name()` на `.` и `..`, пропуская промежуточные `Component::ParentDir` (`a/../../b`), UNC-пути (`\\server\share\...` с утечкой NTLMv2 при `path.is_dir()`), NTFS ADS и зарезервированные имена DOS-устройств. Кроме того, `save_session_body_file` (`commands.rs:736-750`) передаёт `allowed_extensions: None` и создаёт директории (`export_import.rs:2918-2925`), а `import_settings_file` (`commands.rs:767-776`) читает любой `.json` без лимита размера.
3. **`[SEC-03]` Открытый прокси, SSRF к `127.0.0.1` и утечка хозяйских mTLS в LAN-режимах:** в `AllInterfaces` (`0.0.0.0`) / `Specific` внешние LAN-клиенты могут открывать `CONNECT`-туннели к `127.0.0.1` хоста (`server.rs:2162`), автоматически используют хозяйские mTLS-сертификаты (`server.rs:3000`), обходят `is_builtin_portal_target` через `CONNECT` Passthrough или `[::ffff:127.0.0.1]`, а внутри `CONNECT allowed.com:443` переопределяют целевой хост заголовком `Host` (`server.rs:2447-2453`), обходя `TargetedOnly`.
4. **`[SEC-04]` Утечка секретов в санитизированном экспорте (`sanitize: true`):** в `sanitize_sessions` (`src-tauri/src/storage/export_import.rs:1014-1329`) сырые тела SSE (`detail.response_body_text` / `response_body_base64`) остаются полностью нередактированными; после санитизации `websocket_frames` поле `detail.response_body_text` (сформированное в `apply_ws_to_detail`, `storage/mod.rs:1010`) не пересобирается, а не-JSON фреймы SignalR (`\x1e`) / Socket.IO (`42[...]`) не маскируются; в JSON-телах проверка `SENSITIVE_BODY_KEYS` (`models.rs:468-485`, `export_import.rs:1024`) пропускает все `camelCase`-ключи (`accessToken`, `refreshToken`, `apiKey`, `clientSecret`, `idToken`, `privateKey`, `cardNumber`, `sessionId`); не очищаются URL `userinfo`, `#fragment` и query-параметры в заголовках `Location` / `Referer`.
5. **`[SEC-05]` & `[BUG-12]` Бомбы декомпрессии (OOM) и паника в `.saz`:** `decode_http_body` (`export_import.rs:2434-2504`) допускает до 64 МиБ декомпрессии на каждый файл внутри `.saz` без общего кумулятивного лимита и без поддержки `zstd`; `zstd::decode_all` в `server.rs:213-247, 3223-3273` и `codec.rs:78` не ограничен по выходу; в `export_saz` (`export_import.rs:1999`) `chrono::Duration::milliseconds(s.duration_ms as i64)` паникует при больших `duration_ms`.
6. **`[SEC-06]` Открытое хранение приватных ключей из парольных `.p12`/`.pfx`:** `ClientCertificateStore::add_certificate` (`src-tauri/src/proxy/client_certs.rs:643-644`) сохраняет расшифрованный приватный ключ в открытый `{id}.identity.pem`, а `stored_cert_path` из `registry.json` (`client_certs.rs:519-526, 735-750`) не проверяется на принадлежность `storage_dir`.

### Критерии приемки (DoD)
- **`[SEC-01]`:** В `SettingsImportPreviewSummary` (`src/types/settings.ts`) и `buildSettingsImportPreview` (`src/lib/settingsManager.ts`) добавлены поля `hasPythonScript`, `pythonScriptEnabledInFile`, `pythonScriptLines`; при импорте внешнего профиля `scripting.enabled` по умолчанию принудительно сбрасывается в `false` (или требует явного подтверждения в `SettingsModal.tsx` с показом предупреждения безопасности).
- **`[SEC-02]`:** В `validate_user_file_path` (`src-tauri/src/commands.rs`) запрещены любые `Component::ParentDir` (`..`), UNC-пути (`Prefix::UNC` / `Prefix::VerbatimUNC`), NTFS ADS (`:` в имени файла) и зарезервированные имена DOS-устройств (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`). В `import_settings_file` добавлен лимит размера файла `16 MiB`, а `save_session_body_file` не создаёт произвольные вложенные директории вне родительской папки, одобренной нативным диалогом.
- **`[SEC-03]`:** В `src-tauri/src/proxy/server.rs` для не-loopback клиентов (`!peer_addr.ip().is_loopback()`) заблокированы `CONNECT` и HTTP-запросы к loopback/unspecified адресам хоста (включая `::1`, `127.0.0.0/8`, `::ffff:127.0.0.0/104` и `localhost`), `is_builtin_portal_target` проверяется до `CONNECT` Passthrough, хозяйские mTLS-сертификаты из `ClientCertificateStore` не прикрепляются к запросам от внешних LAN-клиентов, а в режиме `TargetedOnly` внутренний заголовок `Host` не может перенаправить туннель на неразрешённый домен.
- **`[SEC-04]`:** В `src-tauri/src/storage/export_import.rs` и `src-tauri/src/models.rs`:
  - ключи JSON нормализуются (удаляются `_` и `-` перед сверкой с `SENSITIVE_BODY_KEYS`), маскируя `accessToken`, `refreshToken`, `apiKey`, `clientSecret`, `idToken`, `privateKey`, `cardNumber`, `sessionId`;
  - для SSE-сессий и WebSocket-сессий после санитизации `sse_events` и `websocket_frames` пересобираются `detail.response_body_text` и `detail.response_body_base64`;
  - `sanitize_ws_frame_payload` маскирует JSON-пейлоады с префиксами/суффиксами SignalR (`\x1e`) и Socket.IO (`42[...]`), а также Bearer/JWT токены в текстовых фреймах;
  - `sanitize_url_query` очищает `userinfo` (`user:pass@`), редактирует `#fragment` и применяется к заголовкам `Location` и `Referer`.
- **`[SEC-05]` & `[BUG-12]`:** В `import_saz` введён кумулятивный счётчик распакованных HTTP-тел (`<= 512 MiB`) и лимит `<= 2` вложенных слоёв `Content-Encoding`, добавлена поддержка `zstd` в `decode_single_content_encoding` и `is_matching_compressed_magic`; в `server.rs` и `codec.rs` вызовы `zstd::decode_all` и `read_to_end` заменены на потоковое чтение с `.take(limit)`; в `export_saz` используется безопасный `chrono::TimeDelta::try_milliseconds`.
- **`[SEC-06]`:** В `src-tauri/src/proxy/client_certs.rs` путь к PEM-файлу вычисляется строго внутри `self.storage_dir` по `id` сертификата (с проверкой канонического префикса), исключая чтение/удаление произвольных файлов через `registry.json`.
- Добавлены unit-тесты для всех 7 исправлений в Rust и Vitest.

### 📝 Промпт для Antigravity (Этап 31)

```markdown
Роль: Principal Application Security & Rust/TypeScript Systems Engineer.
Проект: FluxProxy (Tauri v2 + Rust + React 19).

Задача: Устранить критические и высокоприоритетные уязвимости безопасности, выявленные в аудите v0.4.0 (`SEC-01`..`SEC-06`, `BUG-12`).

1. Защита импорта профиля настроек от скрытого RCE (`[SEC-01]`, `src/types/settings.ts`, `src/lib/settingsManager.ts`, `src/components/SettingsModal.tsx`):
   - Расширить `SettingsImportPreviewSummary` полями `hasPythonScript: boolean`, `pythonScriptEnabledInProfile: boolean`, `pythonScriptLineCount: number`.
   - В `buildSettingsImportPreview` вычислять эти поля, а в `SettingsModal.tsx` показывать заметное предупреждение, если импортируемый профиль содержит непустой Python-скрипт.
   - В `applySettingsProfile` при импорте внешнего JSON-файла принудительно передавать `enabled = false` в `proxyBridge.setPythonScript(nextScripting.code, false)` (если пользователь явно не отметил чекбокс доверия скрипту в превью), сохраняя сам код скрипта в редакторе в выключенном состоянии.

2. Изоляция файлового IPC и закрытие Path Traversal (`[SEC-02]`, `src-tauri/src/commands.rs`, `src-tauri/src/storage/export_import.rs`):
   - В `validate_user_file_path` запретить любые пути, содержащие `std::path::Component::ParentDir` (`..`), Windows UNC-префиксы (`Prefix::UNC`, `Prefix::VerbatimUNC`), альтернативные потоки NTFS (`:` в `file_name`) и зарезервированные имена DOS-устройств (`CON`, `PRN`, `AUX`, `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9`).
   - В `import_settings_file` проверять `std::fs::metadata(&path)?.len() <= 16 * 1024 * 1024` до чтения файла.
   - Покрыть `validate_user_file_path` набором unit-тестов в `commands.rs` (включая `a/../../etc/passwd`, `\\attacker\share\a.json`, `file.json:ads`, `CON.json`).

3. Защита LAN-режимов от SSRF и утечки mTLS (`[SEC-03]`, `src-tauri/src/proxy/server.rs`):
   - Проверять `is_builtin_portal_target` (включая IPv6-mapped `::ffff:127.0.0.1`) в том числе перед установкой `CONNECT` Passthrough-туннеля.
   - Если `!peer_addr.ip().is_loopback()`, запрещать `CONNECT` и HTTP-запросы к loopback/unspecified хостам (`localhost`, `127.0.0.0/8`, `::1`, `::ffff:127.0.0.0/104`, `0.0.0.0`) и не использовать хозяйские mTLS-сертификаты (`ctx.client_certs`) для запросов от внешних LAN-клиентов.
   - В `handle_intercepted_request` при активном режиме `TargetedOnly` проверять `ctx.filters.should_intercept_tls(&host)` после чтения заголовка `Host`, если он отличается от `default_authority`.

4. Полная санитизация экспорта (`[SEC-04]`, `src-tauri/src/storage/export_import.rs`, `src-tauri/src/models.rs`):
   - В `mask_sensitive_json_value` нормализовать имя ключа (удаляя `_` и `-` в lower-case), чтобы маскировались `camelCase` ключи (`accessToken`, `refreshToken`, `apiKey`, `clientSecret`, `idToken`, `privateKey`, `cardNumber`, `sessionId`).
   - После санитизации `detail.sse_events` и `detail.websocket_frames` пересобирать `detail.response_body_text` и `detail.response_body_base64` из санитизированных событий/фреймов.
   - В `sanitize_ws_frame_payload` поддержать SignalR (суффикс `\x1e`) и Socket.IO (числовой префикс перед `[` или `{`), а также редактирование `Bearer`/`eyJ...` JWT в строковых фреймах.
   - В `sanitize_url_query` очищать `username`/`password`, редактировать `fragment` и применять `sanitize_url_query` к значениям заголовков `Location` и `Referer`.

5. Лимиты декомпрессии, SAZ и ключи mTLS (`[SEC-05]`, `[SEC-06]`, `[BUG-12]`, `export_import.rs`, `server.rs`, `codec.rs`, `client_certs.rs`):
   - В `import_saz` передавать кумулятивный счётчик распакованных HTTP-байтов в `decode_http_body` (общий лимит `512 MiB`, максимум 2 слоя `Content-Encoding`) и добавить поддержку `zstd`.
   - Заменить неограниченный `zstd::decode_all` в `server.rs` и `codec.rs` на `zstd::stream::read::Decoder` с `.take(...)`.
   - В `export_saz` заменить `chrono::Duration::milliseconds(s.duration_ms as i64)` на `chrono::TimeDelta::try_milliseconds(s.duration_ms.min(86_400_000 * 365) as i64).unwrap_or_default()`.
   - В `client_certs.rs` проверять, что `stored_cert_path` находится строго внутри `self.storage_dir`.

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 32: Целостность хранилища TrafficStore + SQLite и реактивного состояния UI
**Приоритет: P0 (Data Integrity & Performance) | Спринт 4 | Зависимости: Этапы 2 ✅, 20 ✅, 28 ✅, 29 ✅ | Находки аудита: `BUG-01`, `BUG-02`, `BUG-03`, `BUG-08`, `BUG-11`, `PERF-01`, `PERF-02`, `PERF-06`**

### Цель и контекст
Аудит выявил критические дефекты целостности данных между in-memory индексом `TrafficStore` (`DashMap`), базой `sessions.sqlite` и фронтенд-хуком `useProxySessions.ts`:
1. **`[BUG-01]` Сброс `next_id = 1` при перезапуске поверх живой `sessions.sqlite`:** `TrafficStore::new` (`src-tauri/src/storage/mod.rs:76`) всегда инициализирует `next_id` единицей. Поскольку `load_session_body` (`mod.rs:380`), `extract_raw_body_bytes` (`mod.rs:812`) и `get_hydrated` (`mod.rs:759, 768`) читают из таблицы `offloaded_bodies` по `id` до проверки флага `detail.body_offloaded`, а `record_in_flight_session` (`server.rs:319`) вызывает `ctx.store.get(new_session_id)`, новые запросы `#1..#N` после перезапуска приложения молча получают чужие многомегабайтные тела и старые заметки из прошлого запуска, а затем перезаписывают архив через `INSERT OR REPLACE`.
2. **`[BUG-03]` Уничтожение выгруженных тел (`> 2 MiB`) активных RAM-сессий при `VACUUM`:** `clear_sqlite_archive` (`storage/mod.rs:162-169` → `sqlite.rs:380-397`) выполняет `DELETE FROM offloaded_bodies;`, оставляя живые сессии в RAM с `body_offloaded: true` без их тел на диске.
3. **`[BUG-11]` & `[PERF-02]` & `[PERF-06]` Гонки вытеснения и синхронные блокировки SQLite на потоках Tokio:**
   - `enforce_retention_limit` (`storage/mod.rs:346-361`) удаляет сессии из `DashMap` до проверки результата `sqlite.persist_batch` и на каждую вставку при заполненном буфере сортирует все 10 000 ключей `DashMap` (`O(N log N)`) прямо на async-воркере Tokio;
   - `clear()` и `remove_many()` не захватывают `eviction_lock`, конкурируя с вытеснением;
   - `PRAGMA busy_timeout = 5000;` вызывается после `PRAGMA journal_mode = WAL;` (`sqlite.rs:37-39`);
   - `record_in_flight_session` (`server.rs:319`) на каждый новый запрос делает синхронный `SELECT` в SQLite;
   - в `sqlite.rs:51-52` создаются неиспользуемые индексы `idx_sessions_url` и `idx_sessions_status`.
4. **`[BUG-02]` Отказ всех Tauri Event-подписок при ошибке стартового IPC в `bootstrap()`:** в `src/hooks/useProxySessions.ts:819-1052` отсутствие `try/catch` вокруг `setBindConfiguration` (например, когда сохранённый `specificBindIp` недоступен в новой Wi-Fi сети) прерывает `bootstrap()` до строк `964-1050`, оставляя интерфейс без `subscribeSessionBatches` и остальных подписок.
5. **`[BUG-08]` Дубликаты `session.id` в React-стейте на пустой таблице:** в `flushPendingSessions` (`useProxySessions.ts:776-777`) ветка `if (prev.length === 0) { next = incoming.slice(); }` пропускает дедупликацию `indexById` внутри батча.
6. **`[PERF-01]` Повторный IPC-вызов `getSessionDetail(selectedId)` на каждый новый запрос:** массив зависимостей `useEffect` (`useProxySessions.ts:1156`) включает `sessions.length`, перекачивая детали открытой сессии до 60 раз/сек при фоновом трафике.

### Критерии приемки (DoD)
- **`[BUG-01]`:** `SqliteStore` при открытии БД вычисляет `MAX(id)` из `sessions` и `MAX(session_id)` из `offloaded_bodies`, а `TrafficStore::new` инициализирует `next_id` значением `max_id + 1`. Методы `load_session_body`, `get_hydrated` и `extract_raw_body_bytes` обращаются к `offloaded_bodies` только тогда, когда сессия отсутствует в RAM или у неё установлен `detail.body_offloaded == true`. В `record_in_flight_session` (`server.rs:319`) поиск существующих аннотаций выполняется только в RAM (`get_in_ram`).
- **`[BUG-03]`:** `clear_sqlite_archive` (`purge_and_vacuum`) принимает список `id` активных сессий в RAM с `body_offloaded == true` и сохраняет их строки в `offloaded_bodies` при очистке архива.
- **`[BUG-11]` & `[PERF-02]` & `[PERF-06]`:**
  - `PRAGMA busy_timeout = 5000;` выполняется первой командой в `SqliteStore::init_schema`;
  - `clear()` и `remove_many()` синхронизированы через `eviction_lock`;
  - в `enforce_retention_limit` сессии удаляются из `DashMap` только после успешного `sqlite.persist_batch`, а само вытеснение работает батчами (с гистерезисом, например по 64 сессии), исключая сортировку 10 000 ключей на каждый отдельный запрос;
  - удалены неиспользуемые индексы `idx_sessions_url` и `idx_sessions_status` (`DROP INDEX IF EXISTS`).
- **`[BUG-02]`, `[BUG-08]`, `[PERF-01]`:** В `src/hooks/useProxySessions.ts`:
  - подписки `subscribe*` регистрируются независимо от ошибок стартовых конфигурационных команд, а каждый стартовый IPC-вызов в `bootstrap()` обёрнут в `try/catch` с безопасным фолбэком;
  - `flushPendingSessions` всегда дедуплицирует входящий батч через `indexById`;
  - `sessions.length` удалён из зависимостей `useEffect` загрузки `selectedSession` (`1156`).
- Добавлены регрессионные тесты в `storage/mod.rs` (перезапуск `TrafficStore` поверх существующей БД и `clear_sqlite_archive` с живыми оффлоад-телами).

### 📝 Промпт для Antigravity (Этап 32)

```markdown
Роль: Senior Rust Database/Storage Engineer & React State Architect.
Проект: FluxProxy (Tauri v2 + Rusqlite + DashMap + React 19).

Задача: Устранить ошибки целостности данных и узкие места производительности в связке `TrafficStore` ↔ `SqliteStore` и `useProxySessions.ts` (`BUG-01`, `BUG-02`, `BUG-03`, `BUG-08`, `BUG-11`, `PERF-01`, `PERF-02`, `PERF-06`).

1. Консистентность ID и оффлоад-тел при рестарте и VACUUM (`[BUG-01]`, `[BUG-03]`, `src-tauri/src/storage/sqlite.rs`, `src-tauri/src/storage/mod.rs`, `src-tauri/src/proxy/server.rs`):
   - В `SqliteStore` добавить метод `max_persisted_session_id(&self) -> rusqlite::Result<u64>` (`SELECT COALESCE(MAX(m), 0) FROM (SELECT MAX(id) AS m FROM sessions UNION ALL SELECT MAX(session_id) AS m FROM offloaded_bodies)`).
   - В `TrafficStore::new` инициализировать `next_id: AtomicU64::new(max_id.saturating_add(1))`.
   - В `load_session_body`, `get_hydrated` и `extract_raw_body_bytes` проверять `self.sessions.get(&id)` в RAM в первую очередь и запрашивать `sqlite.load_offloaded_body` только если `detail.body_offloaded == true` (или сессия уже вытеснена из RAM в SQLite).
   - В `TrafficStore` добавить метод `get_in_ram(&self, id: u64) -> Option<CapturedSession>` и использовать его в `record_in_flight_session` (`server.rs:319`) вместо `ctx.store.get(new_session_id)`.
   - В `clear_sqlite_archive` / `purge_and_vacuum` сохранять в `offloaded_bodies` записи тех сессий, которые сейчас находятся в `self.sessions` в RAM с `detail.body_offloaded == true`.

2. Конкурентность `TrafficStore` и оптимизация SQLite (`[BUG-11]`, `[PERF-02]`, `[PERF-06]`, `src-tauri/src/storage/mod.rs`, `src-tauri/src/storage/sqlite.rs`):
   - В `SqliteStore::init_schema` перенести `PRAGMA busy_timeout = 5000;` перед `PRAGMA journal_mode = WAL;` и заменить создание неиспользуемых индексов `idx_sessions_url` / `idx_sessions_status` на `DROP INDEX IF EXISTS idx_sessions_url; DROP INDEX IF EXISTS idx_sessions_status;`.
   - Захватывать `self.eviction_lock` в `clear()` и `remove_many()`.
   - В `enforce_retention_limit` вытеснять сессии пачкой с гистерезисом (например, до `min(overflow + 64, current_len)`) и удалять записи из `self.sessions` только после успешного завершения `sqlite.persist_batch(&evicted_sessions)`.

3. Исправление реактивного стейта фронтенда (`[BUG-02]`, `[BUG-08]`, `[PERF-01]`, `src/hooks/useProxySessions.ts`):
   - В `flushPendingSessions` убрать ветку `if (prev.length === 0) { next = incoming.slice(); }` и всегда выполнять слияние через `indexById`.
   - В `useEffect` загрузки деталей выбранной сессии (`getSessionDetail(selectedId)`) удалить `sessions.length` из массива зависимостей.
   - В `bootstrap()` гарантировать регистрацию всех подписок `proxyBridge.subscribe*` даже при ошибке любого из стартовых IPC-вызовов (`setBindConfiguration`, `setUpstreamTimeout`, `setRetentionLimit`, `updateRules`, `setBreakpoints`, `setCapturing`), обернув каждый вызов в индивидуальный `try/catch` с откатом к `127.0.0.1` при недоступности `specificBindIp`.

Проверка: написать unit-тесты на перезапуск `TrafficStore` с существующей БД и `clear_sqlite_archive`, выполнить `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 33: Надежность сетевого ядра, протоколов HTTP/WS/TLS, фильтров и диагностики
**Приоритет: P1 (Core Reliability & Hot-Path) | Спринт 4 | Зависимости: Этапы 1 ✅, 6 ✅, 7 ✅, 15 ✅, 17 ✅ | Находки аудита: `BUG-04`, `BUG-05`, `BUG-06`, `BUG-07`, `BUG-09`, `BUG-10`, `BUG-13`, `PERF-03`, `PERF-04`**

### Цель и контекст
Этап устраняет протокольные, сетевые и алгоритмические дефекты в горячем пути проксирования:
1. **`[BUG-04]` Утечка `PendingBreakpoint` и зависших сессий `WAIT` при обрыве соединения или `Abort` в Composer:** если клиент разрывает TCP-соединение во время ожидания `bp_rx.await` (`server.rs:2728, 3705`), Hyper дропает future без удаления записи из `BreakpointEngine::pending` (`breakpoints.rs:228-241`), а в `execute_composed` (`server.rs:1659-1663`) действие `BreakpointAction::Abort` возвращает `Err` без завершения in-flight сессии.
2. **`[BUG-05]` Deadlock двунаправленного релея WebSocket и отсутствие таймаута `wss://`:** в `proxy_websocket_upgrade` (`server.rs:4061-4108`) цикл `tokio::select!` синхронно ждёт `upstream_sink.send(msg).await` и `client_sink.send(msg).await` в одной задаче, что приводит к взаимной блокировке при одновременной встречной передаче крупных фреймов; вызов `tokio_tungstenite::connect_async` (`server.rs:3881`) не имеет таймаута подключения.
3. **`[BUG-06]` Ложноположительная проверка доверия Root CA на Windows и macOS:** `check_os_trust_uncached` (`src-tauri/src/proxy/ca.rs:317-335`) проверяет только наличие текстового `Common Name` `"FluxProxy Local Debugging Root CA"`, не сверяя отпечаток текущего сертификата (в отличие от Linux на строках `336-341`).
4. **`[BUG-07]` Искажение `Content-Length` у `HEAD`-ответов и `Content-Encoding` на проводе:** `server.rs:3808-3813` заменяет `Content-Length` на `0` у буферизированных `HEAD`-ответов (`<= 2 MiB`) и безусловно удаляет `Content-Encoding` даже при нераспакованных или многослойных кодировках (`Content-Encoding: gzip, zstd`).
5. **`[BUG-09]` & `[PERF-03]` Сломанные правила `.example.com`, IPv6 authority и перекомпиляция `Regex::new` на каждом запросе:**
   - в `compile_backend_host_list` (`filters.rs:990`) и `compile_capture_host_list` (`filters.rs:1465`) `.strip_prefix('.')` находится внутри `if host_has_wildcard(&pattern)` и является мёртвым кодом;
   - `split_authority` (`server.rs:4693`) и `normalize_host_token` (`filters.rs:620`) некорректно разбирают IPv6 (`[::1]`, `[::1]:8443`);
   - `ProxyFilterEngine` (`filters.rs:417, 531, 701-754`) компилирует `Regex::new` внутри `state.read()` на каждом `CONNECT` (из-за дефолтного правила `ocsp.*, crl.*`) и каждом HTTP-запросе.
6. **`[BUG-10]` Отсутствие отката `sysproxy` и события `proxy://status-changed` в `set_bind_configuration`:** при двойной ошибке бинда (`server.rs:1296-1305`) не вызывается `self.sysproxy.rollback_if_dirty()`, а при успешной смене бинда не отправляется `self.emit_status_changed(&status)`.
7. **`[BUG-13]` Flaky-тест `ProxyDoctor` при параллельном `cargo test`:** `check_port_binding` (`doctor.rs:88`) при `running == false` использует `retry_attempts = 1`, периодически падая в `doctor_detects_stopped_port_and_fixes_listener_plus_e2e_health` (`doctor.rs:1100`).
8. **`[PERF-04]` Убийство живого Python-воркера из-за очереди на `AsyncMutex`:** в `invoke_worker` (`python_runner.rs:1452`) время ожидания в очереди за мьютексом входит в 1500-мс таймаут исполнения хука, из-за чего всплеск параллельных запросов вызывает ложный `kill_worker_locked` и потерю состояния скрипта.

### Критерии приемки (DoD)
- **`[BUG-04]`:** Реализован RAII-гард для `PendingBreakpoint`, автоматически удаляющий запись из `BreakpointEngine::pending`, снимающий `breakpoint_paused` в `TrafficStore` и отправляющий `proxy://breakpoints-changed` при дропе задачи; в `execute_composed` при `Abort` на точке останова сессия переводится в статус `502`.
- **`[BUG-05]`:** В `proxy_websocket_upgrade` чтение и запись клиентского и серверного потоков разделены так, чтобы заполнение TCP-буфера в одну сторону не блокировало вычитывание встречного потока; `connect_async` обёрнут в `tokio::time::timeout`.
- **`[BUG-06]`:** На Windows и macOS `check_os_trust_uncached` сверяет отпечаток (SHA-1 / SHA-256) сертификата в хранилище ОС с текущим Root CA.
- **`[BUG-07]`:** Для `HEAD`-запросов сохраняется оригинальный `Content-Length` от upstream; `Content-Encoding` снимается только для реально декодированных слоёв.
- **`[BUG-09]` & `[PERF-03]`:** В `filters.rs` шаблоны `.example.com` корректно компилируются в суффиксные правила; `split_authority` и `normalize_host_token` корректно обрабатывают IPv6 `[::1]` и `[::1]:port`; все шаблоны `tls_bypass_rules`, `tls_target_rules` и `header_mutations` предкомпилируются при `set_config` без вызова `Regex::new` внутри `state.read()`.
- **`[BUG-10]` & `[BUG-13]` & `[PERF-04]`:** В `set_bind_configuration` добавлены `rollback_if_dirty()` и `emit_status_changed`; в `doctor.rs:88` `retry_attempts` для остановленного порта увеличен до `3`; в `python_runner.rs` разделены таймаут ожидания очереди мьютекса и таймаут выполнения хука в воркере (без убийства воркера при перегрузке очереди).

### 📝 Промпт для Antigravity (Этап 33)

```markdown
Роль: Principal Rust Network & Systems Engineer.
Проект: FluxProxy (Tauri v2 + Tokio + Hyper + Rustls).

Задача: Устранить сетевые, протокольные и алгоритмические дефекты ядра прокси (`BUG-04`, `BUG-05`, `BUG-06`, `BUG-07`, `BUG-09`, `BUG-10`, `BUG-13`, `PERF-03`, `PERF-04`).

1. Точки останова и WebSocket-релей (`[BUG-04]`, `[BUG-05]`, `src-tauri/src/proxy/breakpoints.rs`, `src-tauri/src/proxy/server.rs`):
   - Реализовать RAII-гард вокруг ожидания `bp_rx`, который при отмене/дропе задачи (дисконнект клиента) очищает `session_id` из `BreakpointEngine::pending`, обновляет сессию в `TrafficStore` (`breakpoint_paused: None`, `status: 499`) и эмитит `proxy://breakpoints-changed`. В `execute_composed` при `BreakpointAction::Abort` вызывать `record_completed_session` со статусом `502`.
   - В `proxy_websocket_upgrade` обернуть `connect_async` в `tokio::time::timeout(Duration::from_secs(ctx.upstream_timeout_sec), ...)` и устранить deadlock встречной записи в цикле ретрансляции фреймов.

2. Предкомпиляция фильтров, `.domain.com` и IPv6 (`[BUG-09]`, `[PERF-03]`, `src-tauri/src/proxy/filters.rs`, `src-tauri/src/proxy/server.rs`):
   - В `compile_backend_host_list` и `compile_capture_host_list` обрабатывать ведущую точку `pattern.starts_with('.')` как суффикс домена даже при отсутствии символов `*` и `?`.
   - Исправить разбор IPv6-хостов `[::1]` и `[::1]:8443` в `split_authority`, `normalize_host_token` и `extract_host_from_url_or_authority`.
   - Предкомпилировать `tls_bypass_rules`, `tls_target_rules` и `header_mutations` при обновлении конфигурации в `ProxyFilterEngine`, полностью убрав `Regex::new` из `should_intercept_tls` и `apply_header_mutations`.

3. Протокол HTTP, проверка Root CA, биндинг, Doctor и Python-очередь (`[BUG-06]`, `[BUG-07]`, `[BUG-10]`, `[BUG-13]`, `[PERF-04]`, `server.rs`, `ca.rs`, `doctor.rs`, `python_runner.rs`, `process.rs`):
   - В `server.rs:3808` сохранять исходный `Content-Length` для `HEAD`-запросов (если тело пустое) и удалять `Content-Encoding` только при фактической распаковке всех его слоёв.
   - В `ca.rs:317-335` сверять отпечаток текущего сертификата Root CA в выводе `certutil` (Windows) и `security find-certificate -Z` (macOS).
   - В `set_bind_configuration` (`server.rs:1265-1305`) добавить `self.sysproxy.rollback_if_dirty()` при двойной ошибке бинда и `self.emit_status_changed(&status)` при любом изменении состояния.
   - В `doctor.rs:88` установить `let retry_attempts = if running { 6 } else { 3 };`.
   - В `python_runner.rs:1452` отделить ожидание `self.worker.lock().await` от таймаута чтения/записи пайпа воркера, чтобы таймаут ожидания очереди не вызывал `kill_worker_locked`.
   - В `process.rs` ограничить максимальный размер `pid_name_cache` (до 4096 записей).

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`.
```

---

## 🔵 Спринт 5 — P2 (Feature & Architecture): Сетевая инфраструктура, декомпозиция и аналитика

---

## Этап 10: Сетевая инфраструктура: HOSTS Remapping и Bandwidth Throttling
**Приоритет: P2 (Feature) | Спринт 5 | Зависимости: Этапы 15 ✅, 25 ✅, 33**

### Цель и контекст
Разработчикам часто требуется перенаправлять запросы с боевого домена (`api.production.com`) на локальный сервер (`127.0.0.1:3000`) без правки системного файла `hosts` (требующего прав администратора), а также проверять поведение приложений на медленных каналах связи (GPRS, 3G, LTE, Offline).

> **Важный технический нюанс:** При HTTPS MITM-перенаправлении домена `api.production.com` на `127.0.0.1:8443` нельзя просто подменить URL на `https://127.0.0.1:8443`, иначе сломается TLS SNI и проверка сертификата upstream. Для HTTP/HTTPS MITM необходимо использовать `reqwest::ClientBuilder::resolve(host, socket_addr)` (или динамический DNS-резолвер `reqwest::dns::Resolve`), сохраняя оригинальный SNI и заголовок `Host`, а для `CONNECT` Passthrough — напрямую подключаться к `targetHost:targetPort`.

### Критерии приемки (DoD)
- Модуль `src-tauri/src/proxy/hosts.rs` с потокобезопасным `HostRemapRegistry` (точные домены и wildcard `*.example.com`) интегрирован как в `CONNECT`-туннели, так и в DNS-резолвер `upstream_client` (с сохранением SNI и заголовка `Host` при `preserveHostHeader`).
- Модуль `src-tauri/src/proxy/throttle.rs` с Token Bucket / `AsyncRead + AsyncWrite` шейпером и пресетами `No Throttling`, `GPRS`, `Slow 3G`, `Fast 3G`, `4G LTE`, `Offline`, `Custom`.
- Модальное окно `src/components/HostRemapModal.tsx` (`Tools → HOSTS Remapping…`), переключатель профиля скорости на `TopToolbar.tsx` / в статус-баре `App.tsx`, сохранение правил в `FluxUserSettingsProfile`.
- Интеграционные тесты ремаппинга и ограничения скорости в Rust.

### 📝 Промпт для Antigravity (Этап 10)

```markdown
Роль: Senior Rust Systems Engineer & Frontend Developer.
Проект: FluxProxy (Tauri v2 + Tokio + Hyper + Reqwest + React 18).

Задача: Реализовать виртуальный DNS (HOSTS Remapping) и эмуляцию медленной сети (Bandwidth Throttling).

1. HOSTS Remapping (`src-tauri/src/proxy/hosts.rs`, `server.rs`):
   - Модель `HostRemapRule`: `id`, `enabled`, `source_pattern`, `target_host`, `target_port: Option<u16>`, `preserve_host_header: bool`, `comment`.
   - Реализовать `HostRemapRegistry` (и кастомный `reqwest::dns::Resolve` для `build_upstream_client`, чтобы HTTPS-запросы сохраняли правильный TLS SNI, подключаясь к IP/порту назначения!). Для `CONNECT` Passthrough направлять `TcpStream::connect` на `target_host:target_port`.
   - Помечать перенаправленные сессии индикатором/комментарием или метаданным в `SessionDetail`.
   - Добавить команды `get_host_remap_rules` / `update_host_remap_rules` и интеграционный тест перенаправления на локальный тестовый сервер.

2. Bandwidth Throttling (`src-tauri/src/proxy/throttle.rs`, `server.rs`, `commands.rs`):
   - Пресеты: `None`, `Gprs` (50 Kbps / 500 ms), `Slow3g` (400 Kbps / 400 ms), `Fast3g` (1.6 Mbps / 150 ms), `Lte` (30 Mbps / 40 ms), `Offline`, `Custom`.
   - Обертка потоков (`ThrottledStream` / rate-limiter для чтения-записи и начальной RTT-задержки) в `handle_outer_proxy_request` / `handle_intercepted_request`.
   - Команды `get_throttle_config` / `set_throttle_config` и unit-тест.

3. Frontend UI (`src/components/HostRemapModal.tsx`, `src/components/TopToolbar.tsx`, `src/components/MenuBar.tsx`, `src/App.tsx`, `src/types/settings.ts`, `src/lib/settingsManager.ts`, `src/lib/tauriBridge.ts`, `src/lib/mockTraffic.ts`):
   - Создать `HostRemapModal.tsx` (`Tools → HOSTS Remapping…`).
   - Добавить селектор профиля скорости на `TopToolbar.tsx` и индикатор в статус-бар `App.tsx`, а также сохранение конфигурации в `FluxUserSettingsProfile`.

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## Этап 11: Архитектурная декомпозиция монолитов, внедрение Zustand и оптимизация бандла
**Приоритет: P2 (Architecture & Performance) | Спринт 5 | Зависимости: Этапы 31–33 | Находки аудита: `ARCH-01`, `PERF-05`**

### Цель и контекст
Крупнейшие файлы проекта (`server.rs` — 7 759 строк, `export_import.rs` — 4 053, `FilterDrawer.tsx` — 3 820, `App.tsx` — 3 747, `SettingsModal.tsx` — 3 599, `tauriBridge.ts` — 3 371, `useProxySessions.ts` — 3 337, `settingsManager.ts` — 2 859, `filters.rs` — 2 571, `filterEngine.ts` — 2 328, `sysproxy.rs` — 2 276) перегружены и затрудняют параллельную разработку (`[ARCH-01]`), а состояние фронтенда передается десятками пропсов через `App.tsx`.
Кроме того, аудит выявил неоптимальную инициализацию бандла (`[PERF-05]`):
- В `src/lib/tauriBridge.ts:2491` строка `const previewEngine = new BrowserPreviewEngine();` выполняется безусловно на верхнем уровне модуля даже в нативном Tauri-приложении (читая 15 ключей `localStorage`, создавая 18 фейковых сессий в памяти и запуская вечный `window.setInterval(..., 1800)` на строке `958`).
- В `src/main.tsx:1` синхронно импортируется `src/lib/monaco.ts:1-13`, статически включающий в сборку неиспользуемый языковой воркер TypeScript `ts.worker` весом **7.05 МБ** (при том, что Monaco в FluxProxy используется только для `json`, `xml`, `html`, `yaml`, `python` и `plaintext`).

### Критерии приемки (DoD)
- Rust-ядро разложено на подмодули без изменения внешнего поведения:
  - `src-tauri/src/proxy/server/` (`mod.rs`, `http_handler.rs`, `connect_tunnel.rs`, `websocket_relay.rs`, `composer_exec.rs`, `mobile_portal.rs`);
  - `src-tauri/src/storage/export_import/` (`mod.rs`, `har.rs`, `saz.rs`, `raw.rs`, `sanitize.rs`);
  - при необходимости выделены подмодули в `filters/` и `sysproxy/`.
- **`[PERF-05]`:** `BrowserPreviewEngine` создаётся лениво через `getPreviewEngine()` только при `!isTauriRuntime()` (в нативном Tauri не создаётся экземпляр и не запускается `setInterval(1800)`), а из `src/lib/monaco.ts` удалён импорт `ts.worker` (с фолбэком на `editor.worker` 277 КБ).
- Внедрен `zustand` (`useProxyStore`, `useFilterStore`, `useUiStore`), устранен сквозной prop-drilling из `App.tsx` и `useProxySessions.ts`.
- `FilterDrawer.tsx` и `SettingsModal.tsx` разбиты на компоненты вкладок (`src/components/filters/`, `src/components/settings/`).
- Тяжелые модальные окна и Monaco-представления загружаются через `React.lazy()` + `Suspense`, уменьшая стартовый JS-бандл.
- Все существующие Rust- и Vitest-тесты проходят без регрессий.

### 📝 Промпт для Antigravity (Этап 11)

```markdown
Роль: Principal Systems Architect & React Performance Specialist.
Проект: FluxProxy (Tauri v2 + Rust + React 19).

Задача: Провести безопасную модульную декомпозицию крупных файлов Rust и React/TypeScript (`ARCH-01`), устранить лишнюю инициализацию `BrowserPreviewEngine` и `ts.worker` (`PERF-05`), внедрить `zustand` и настроить Code Splitting без изменения пользовательской функциональности.

1. Оптимизация холодного старта и бандла (`[PERF-05]`, `src/lib/tauriBridge.ts`, `src/lib/monaco.ts`, `src/main.tsx`):
   - В `src/lib/tauriBridge.ts` заменить `const previewEngine = new BrowserPreviewEngine();` на ленивый синглтон `getPreviewEngine()`, вызываемый только в ветках `if (!isTauriRuntime())`, чтобы в нативном десктопном режиме не аллоцировались мок-сессии и не запускался 1800-мс таймер `startTrafficLoop`.
   - В `src/lib/monaco.ts` удалить импорт `tsWorker` (`monaco-editor/esm/vs/language/typescript/ts.worker?worker`, 7.05 МБ).

2. Декомпозиция Rust-ядра (`[ARCH-01]`):
   - Разбить `src-tauri/src/proxy/server.rs` на `src-tauri/src/proxy/server/{mod.rs, http_handler.rs, connect_tunnel.rs, websocket_relay.rs, composer_exec.rs, mobile_portal.rs}` (сохранив публичный API `ProxyController` и переиспользовав общие этапы пайплайна между `http_handler` и `composer_exec`).
   - Разбить `src-tauri/src/storage/export_import.rs` на `src-tauri/src/storage/export_import/{mod.rs, har.rs, saz.rs, raw.rs, sanitize.rs}`.
   - При объеме > 2000 строк также вынести парсеры/тесты `filters.rs` в подмодули `src-tauri/src/proxy/filters/`.
   - Сохранить и прогнать все существующие Rust-тесты.

3. Декомпозиция фронтенда, Zustand и Code Splitting:
   - Установить `zustand`, выделить сторы `src/stores/{proxyStore.ts, filterStore.ts, uiStore.ts}` с сохранением синхронизации с `settingsManager.ts` и `localStorage`.
   - Разделить `SettingsModal.tsx` на вкладки в `src/components/settings/` и `FilterDrawer.tsx` на вкладки в `src/components/filters/`.
   - Перевести тяжелые модальные окна и редакторы (`SettingsModal`, `FilterDrawer`, `BreakpointModal`, `SessionDiffView`, `TextWizardModal`, `MobileSetupModal`, `ProxyDoctorModal`, `SanitizedExportModal`, `OpenApiExportModal`, `ScriptingPanel`) на `React.lazy()` + `Suspense`.

Проверка: убедиться в исчезновении 7-МБ чанка `ts.worker-*.js` и уменьшении стартового чанка `dist/assets/index-*.js`, выполнить `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 12: Аналитика и визуализация: Waterfall Timeline и статистика трафика
**Приоритет: P2 (Feature) | Спринт 5 | Зависимости: нет**

### Цель и контекст
Для поиска узких мест производительности (последовательные «лесенки» запросов, тяжелые эндпоинты, всплески 4xx/5xx и P95-латентность) нужна наглядная временная диаграмма и агрегированная статистика по выборке сессий.

### Критерии приемки (DoD)
- Компонент `src/components/WaterfallTimeline.tsx` (вкладка/переключатель режима просмотра в `Traffic Viewer`) с виртуализацией строк (`@tanstack/react-virtual`), горизонтальной шкалой времени (Zoom + линейка мс) на базе `summary.timestamp` и `summary.durationMs` и цветовой кодировкой по статусу/MIME.
- Клик по полосе таймлайна синхронизирует выбор сессии с `TrafficGrid` и `SessionInspector`.
- Модальное окно `src/components/TrafficStatisticsModal.tsx` (с расчетом метрик за один проход $O(N)$ в `useMemo`): количество запросов, распределение 2xx/3xx/4xx/5xx, суммарный объем, Average / Median / P95 Latency, распределение по MIME, топ-5 медленных и топ-5 крупных URL + кнопка «Copy Markdown Report».
- Выдерживает 10 000+ сессий без блокировки UI.

### 📝 Промпт для Antigravity (Этап 12)

```markdown
Роль: Senior Frontend & Data Visualization Engineer (React 18 + TypeScript + Tailwind CSS).
Проект: FluxProxy (Tauri v2 + React 18).

Задача: Реализовать виртуализированный Waterfall Timeline и панель сводной статистики трафика по текущей выборке или выделенным сессиям.

1. Waterfall Timeline (`src/components/WaterfallTimeline.tsx`, `src/App.tsx`):
   - Построение шкалы относительно минимального `timestamp` выборки (`offsetMs = startMs - minStartMs`, длина полосы = `durationMs`).
   - Виртуализация списка через `@tanstack/react-virtual`, управление масштабом (Zoom In / Zoom Out / Fit All), тултип с точным началом/длительностью и синхронизация выбора `selectedId` с `SessionInspector`.

2. Панель статистики (`src/components/TrafficStatisticsModal.tsx`, `src/lib/trafficStats.ts`, `src/components/MenuBar.tsx`, `src/components/CommandPalette.tsx`):
   - Вынести чистые вычисления в `src/lib/trafficStats.ts` (удобно для тестирования): общее число сессий (выделенных или всех отфильтрованных), доли `2xx/3xx/4xx/5xx/Pending`, суммарный `bodySize`, `avg` / `median` / `p95` `durationMs`, сводка по `contentType`, топ-5 самых медленных и самых тяжелых URL.
   - Генерация аккуратного Markdown-отчета в буфер обмена («Copy Markdown Report»).
   - Добавить вызов из `MenuBar.tsx` (`View` / `Tools`), контекстного меню таблицы и `CommandPalette.tsx`.

Проверка: `npm run typecheck`, `npm run test` (если Vitest уже настроен), `npm run build`.
```

---

## Этап 13: Расширенные протоколы: Upstream Proxy Chaining и WS-инъекция
**Приоритет: P2 (Feature) | Спринт 5 | Зависимости: Этапы 18 ✅, 25 ✅, 33**

### Цель и контекст
В корпоративных сетях и при сложной маршрутизации FluxProxy должен уметь работать через вышестоящий прокси (`HTTP`, `HTTPS`, `SOCKS5`), а при отладке real-time протоколов инженеру нужна ручная отправка сообщений в уже открытый WebSocket.

> **Важные технические нюансы:**
> - Для работы через внешний `HTTP`/`HTTPS`/`SOCKS5`-прокси у `reqwest` в `Cargo.toml` нужно включить фичу `socks` (или поддержать SOCKS5-коннектор), а для `CONNECT`-туннелей (Passthrough и MITM) реализовать upstream handshake (`HTTP CONNECT` / `SOCKS5`) до `copy_bidirectional` или `TlsAcceptor`.
> - Пароль вышестоящего прокси нельзя выгружать в открытом виде при экспорте `FluxUserSettingsProfile` (или требовать явного подтверждения/маскировать).

### Критерии приемки (DoD)
- Выделенный модуль `src-tauri/src/proxy/upstream_proxy.rs` с моделью `UpstreamProxyConfig` (тип `http`/`https`/`socks5`, `host`, `port`, опциональный логин/пароль и `bypass_list` вроде `localhost, 127.0.0.1, *.internal`), интегрированный через общий `build_upstream_client` (`reqwest::Proxy`) и `CONNECT`-туннели.
- Команды `get_upstream_proxy_config` / `set_upstream_proxy_config` и модальное окно `src/components/UpstreamProxyModal.tsx` (`Tools → Upstream Proxy…`).
- В `server.rs` (`handle_websocket_intercept`) активные WS-соединения регистрируются в реестре каналов управления (`DashMap<u64, mpsc::Sender<WsInjectCommand>>`) и удаляются при закрытии сокета.
- Команда `inject_websocket_frame(session_id, direction, opcode, payload)` и компактная форма отправки (Text / JSON / Hex → «Send to Server» / «Send to Client») во вкладке `WS` (`src/components/InspectorProtocolPanels.tsx`), отображающая отправленный фрейм в ленте сессии.
- Unit/интеграционные тесты в Rust на bypass-правила и WS-инъекцию.

### 📝 Промпт для Antigravity (Этап 13)

```markdown
Роль: Principal Systems Architect & Protocol Specialist (Rust / Tokio / WebSockets).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Реализовать каскадирование через вышестоящий прокси (HTTP / HTTPS / SOCKS5) и ручную инъекцию фреймов в активные WebSocket-соединения.

1. Upstream Proxy Chaining (`src-tauri/Cargo.toml`, `src-tauri/src/proxy/upstream_proxy.rs`, `server.rs`, `commands.rs`):
   - При необходимости включить фичу `socks` у `reqwest` в `Cargo.toml` (и `tokio-socks` для сырых `CONNECT`/WS-туннелей).
   - В `upstream_proxy.rs` реализовать `UpstreamProxyConfig`, парсинг `bypass_list` (`localhost`, CIDR/маски `*.corp.local`) и функцию установки TCP-туннеля через upstream (`HTTP CONNECT` с Basic-Auth или `SOCKS5`).
   - В `server.rs` пересобирать/обновлять `upstream_client` (с сохранением настроек Этапа 25 и mTLS Этапа 18) и маршрутизировать `CONNECT`-туннели + WebSocket-подключения с учетом `bypass_list`.
   - Покрыть тестами сопоставление `bypass_list`.

2. WebSocket Frame Injection (`src-tauri/src/proxy/server.rs`, `src-tauri/src/commands.rs`, `src/components/InspectorProtocolPanels.tsx`):
   - В `SharedProxyContext` добавить `active_ws_channels: DashMap<u64, mpsc::UnboundedSender<WsInjectCommand>>`.
   - В цикле ретрансляции `handle_websocket_intercept` принимать команды инъекции в сторону `server` или `client`, отправлять фрейм (`Text`/`Binary`) и записывать его через `record_ws_frame` с пометкой ручной инъекции.
   - При закрытии соединения гарантированно удалять запись из `active_ws_channels`.
   - Добавить команду `inject_websocket_frame` и интеграционный тест в `server.rs`.

3. Frontend UI (`src/components/UpstreamProxyModal.tsx`, `src/components/InspectorProtocolPanels.tsx`, `src/components/MenuBar.tsx`, `src/lib/tauriBridge.ts`, `src/lib/mockTraffic.ts`):
   - Создать `UpstreamProxyModal.tsx` (`Tools → Upstream Proxy…`) — при экспорте настроек в `FluxUserSettingsProfile` не сохранять пароль в открытом виде.
   - Во вкладке `WS` (`InspectorProtocolPanels.tsx`) для открытых соединений добавить панель «Inject WebSocket Frame» (редактор Text/JSON/Hex + кнопки `Send to Server` / `Send to Client`).

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```
