# 🗺️ Дорожная карта (Roadmap) развития FluxProxy

> **FluxProxy** — кроссплатформенный локальный отладочный HTTP/HTTPS/WebSocket-прокси на базе **Tauri v2 (Rust)** и **React 19 (TypeScript) + Zustand 5**.
>
> Документ содержит актуальный статус реализованных подсистем, утверждённые архитектурные решения по итогам доказательного аудита `v0.5.0`, упорядоченную по спринтам матрицу приоритетов с явными зависимостями, инженерные ограничения кодовой базы и **самодостаточные промпты для агента Antigravity**.

---

## ✅ Реализованные этапы (Verified Milestones `v0.1.0` – `v0.5.0`)

Следующие подсистемы **полностью реализованы, покрыты тестами в кодовой базе (`92` теста Vitest + `149` тестов Rust) и не требуют повторной разработки** *(примечание по путям: после архитектурной декомпозиции в Этапе 11 / п. 34 бывшие монолиты `server.rs`, `filters.rs` и `export_import.rs` разнесены по модульным директориям `src-tauri/src/proxy/server/`, `src-tauri/src/proxy/filters/` и `src-tauri/src/storage/export_import/`, а `src/components/HostFiltersTab.tsx` является реэкспортом `src/components/filters/HostFiltersTab.tsx`)*:

1. **Поддержка мобильных устройств (iOS & Android):**
   - Биндинг `0.0.0.0` (`set_allow_remote`), автоопределение LAN IP (`get_network_interfaces` в `src-tauri/src/proxy/network.rs`) и встроенный веб-портал `http://flux.proxy` (`src-tauri/src/proxy/server/mobile_portal.rs`) с отдачей `.crt`, `.der`, `.pem` и `.mobileconfig`.
   - Модальное окно `src/components/MobileSetupModal.tsx` (`Ctrl+Shift+M`) с QR-кодами и шаблоном Android `network_security_config.xml`; покрыто интеграционными тестами в `src-tauri/src/proxy/server/mod.rs`.
2. **Массовый фильтр хостов (Bulk Hosts List), матрица фильтров и протокольные инспекторы:**
   - Вкладка `src/components/filters/HostFiltersTab.tsx` (реэкспорт в `src/components/HostFiltersTab.tsx`) с многострочным вводом доменов, масок `*` и `regex:`, режимами Whitelist / Blacklist и опциональной синхронизацией с TLS Passthrough (`applyToTlsPassthrough`).
   - Матрица фильтров (`src/components/FilterDrawer.tsx`, `src/lib/filterEngine.ts`, `src-tauri/src/proxy/filters/{mod,parsers}.rs`), пороги шума, мутации заголовков и анализаторы в `src/components/InspectorProtocolPanels.tsx` (SSE/LLM, gRPC/Protobuf, Auth, RFC 9111 Cache, Multipart).
3. **Совместимость с WebSocket и SignalR:**
   - Полный форвардинг заголовков клиента (`Authorization`, `Cookie`, `Sec-WebSocket-Protocol`, `X-SignalR-*`) в `build_upstream_websocket_request` (`src-tauri/src/proxy/server/websocket_relay.rs`) с unit-тестами.
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
   - Подсистема `src-tauri/src/storage/export_import/{mod,har,saz,raw,sanitize}.rs`, нативные диалоги (`rfd`), горячие клавиши `Ctrl+S` / `Ctrl+O`, Drag-and-Drop архивов и команда `save_session_body_file`.
8. **[Этап 4 — Выполнено] Версионированные профили настроек и централизованный Preferences:**
   - Схема `FluxUserSettingsProfile` (`schemaVersion: 1`, `src/types/settings.ts`), валидатор/мигратор `src/lib/settingsManager.ts` и модальное окно `src/components/SettingsModal.tsx` (`Ctrl+,`) с 5 вкладками (*General*, *UI & Columns*, *Filters*, *Rules & Proxy*, *Backup & Export* в `src/components/settings/`).
9. **[Этап 26 — Выполнено] Безопасность: защита от XSS и инъекций, CSP и устранение UB в Rust:**
   - Санитизация `host_header`, отказ от рендеринга SVG `data:` в `SessionInspector.tsx`, устранение shell/CLI-инъекций (`pkexec`, `adb`/cURL, CRLF), валидация IPC-путей, усиление CSP и исправление UB/паник в Rust (`process.rs`, `network.rs`, `sysproxy.rs`, `proxy/filters/`).
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
    - Вынос `resolve_client_process` и операций SQLite в `spawn_blocking`, предкомпиляция `Regex`, устранение квадратичной сложности ($O(N^2)$) в SSE/WebSocket и пул соединений в Composer.
17. **[Этап 24 — Выполнено] Интерактивная сортировка колонок таблицы (ASC/DESC) и массовое выделение (Ctrl+A):**
    - Циклическая сортировка всех 12 колонок `ColumnId` (`null → asc → desc → null`, включая добавленные в Этапе 34 `ttfb` и `serverIp`, компараторы в `src/components/TrafficGrid.tsx`, пункты контекстного меню шапки, адаптация `followTail`) и массовое выделение видимых сессий по `Ctrl+A` / `Cmd+A` (`Edit → Select All Sessions`, `selectSessions` в `useProxySessions.ts`).
18. **[Этап 23 — Выполнено] Персистентность геометрии сплитов и адаптивной сетки панелей:**
    - Сохранение пропорций всех 4 `<PanelGroup>` (`flux-layout-bottom-outer-v1`, `flux-layout-bottom-inner-v1`, `flux-layout-right-v1`, `flux-inspector-split-v1`), настройка `inspectorSplitDirection` (`"auto" | "horizontal" | "vertical"`) в `useUiPreferences.ts` и `FluxUserSettingsProfile`, сброс двойным кликом по разделителю и команда `View → Reset Panel Layout to Default`.
19. **[Этап 5 — Выполнено] Ультра-компактный тулбар, автоподбор колонок и шорткаты инспектора:**
    - Однострочный Slim-тулбар (`Ctrl+Shift+T` / `Cmd+Shift+T`) с выносом второстепенных кнопок в меню переполнения `•••`, определение колонки через `data-col-id` в контекстном меню шапки `TrafficGrid.tsx` с пунктами `Auto-fit "<Column>"` и `Auto-fit All Visible Columns`, а также быстрые шорткаты вкладок активной панели `SessionInspector` (`Ctrl+1` … `Ctrl+6`).
20. **[Этап 16 — Выполнено] Очистка и маскирование PII / секретов при экспорте (Sanitized Export):**
    - Структура `SanitizationOptions` и функция `sanitize_sessions` в `src-tauri/src/storage/export_import/sanitize.rs` для санитизации `.har`, `.saz`, `.json` и Raw HTTP (`.txt`), модальное окно `src/components/SanitizedExportModal.tsx` (`File → Export Sanitized Sessions…`, `Ctrl+Shift+S`) с пресетами *Safe Sharing*, *Strict Anonymization* и *Custom* и unit-тестами.
21. **[Этап 17 — Выполнено] Диагностический мастер самопроверки «Proxy Doctor»:**
    - Модуль `src-tauri/src/proxy/doctor.rs` (`run_proxy_doctor`, `fix_doctor_issue`), лёгкий маршрут `http://flux.proxy/health` (`200 OK` без замусоривания `TrafficStore`), 6 проверок (порт/сокет, доверие Root CA, системный прокси ОС, конфликтующие VPN/TUN-интерфейсы, Windows Firewall, сквозная loopback-проверка) и модальное окно `src/components/ProxyDoctorModal.tsx` (`Help → Run Proxy Doctor…`, `Ctrl+Shift+D`).
22. **[Этап 29 — Выполнено] Единый источник конфигурации запуска, устранение гонок useProxySessions и честные ошибки Bridge:**
    - Единый источник стартового порта (`proxy_port.pref` в `app_data_dir`) в `lib.rs` и `sysproxy.rs` без двойного старта `:8888`, автооткат порта при `AddrInUse` в `setProxyPort`, устранение утечки подписки в React StrictMode и гонок фильтров/деталей в `useProxySessions.ts`, поддержка `requestBodyBase64`/offloaded тел в `replaySessions`, транзакционный `applySettingsProfile` с поддержкой `breakpoints` (`BreakpointConfig`), отказ от маскировки ошибок IPC в `tauriBridge.ts` и нативная команда `generate_stress_sessions`.
23. **[Этап 30 — Выполнено] Исправление багов UI-компонентов, виртуализация HexViewer и настройка manualChunks:**
    - Виртуализация `src/components/HexViewer.tsx` через `@tanstack/react-virtual` (без перерисовки всей таблицы на hover), настройка `manualChunks` в `vite.config.ts` (`monaco-editor`, `react-vendor`, `tauri-ui`), исправление багов в `BreakpointModal.tsx`, `ComposerPanel.tsx`, `AutoResponderPanel.tsx`, `SessionInspector.tsx` (`ws`/`wss`, токены загрузки тел), `TrafficGrid.tsx` (cleanup слушателей, `finally` для popover, `followTail` по хвостовому ID), `textWizard.ts` (JWT `null`-защита) и `mockTraffic.ts`.
24. **[Этап 22 — Выполнено] Продвинутая кастомизация темы: 8 пресетов, редактор палитры и синхронизация Monaco:**
    - Модуль `src/lib/themePresets.ts` с 8 темами (`default-dark`, `default-light`, `dracula`, `tokyo-night`, `nord`, `fiddler-classic`, `github-dark`, `monokai-pro`), helper `hexToRgbaString` / `deriveSelectedBgHex`, динамическое применение токенов в `src/hooks/useTheme.ts`, синхронизация темы Monaco Editor (`src/lib/monaco.ts`), галерея пресетов и детальный редактор палитры в `SettingsModal.tsx`, интеграция с `FluxUserSettingsProfile` (`src/types/settings.ts`, `src/lib/settingsManager.ts`) и `CommandPalette`, а также unit-тесты `src/lib/themePresets.test.ts`.
25. **[Этап 6 — Выполнено] Selective MITM & Bypass 2.0: Bulk Editor, 11 Quick-Packs, PKI-дефолты и lock-free Hit Counter:**
    - Выделение `default_tls_bypass_rules()` с PKI/OCSP/CRL и мессенджерами в `src-tauri/src/proxy/filters/mod.rs`, lock-free счётчик попаданий `hit_counts: DashMap<String, AtomicU64>`, команды `get_tls_rule_hit_counts` и `reset_tls_bypass_rules_to_recommended` (`commands.rs`), синхронизация `TLS_BYPASS_QUICK_PACKS` (11 наборов) и чистые конвертеры `tlsRulesToBulkText` / `parseBulkTextToTlsRules` (`src/lib/filterEngine.ts`), режимы `Table View` ↔ `Bulk Text Editor`, `Quick Paste…`, импорт/экспорт TXT/JSON, чипы доменов сессии, бейджи `Hits: N` в `FilterDrawer.tsx` и бейдж `TUNNEL` в `TrafficGrid.tsx`.
26. **[Этап 18 — Выполнено] Клиентские сертификаты (mTLS / Client Certificates Store):**
    - Модуль `src-tauri/src/proxy/client_certs.rs` (`ClientCertificateStore`) с поддержкой PKCS#12 (`.p12`/`.pfx`) и PEM, извлечением X.509 CN / срока действия (`x509-parser`), безопасным хранением в `app_data_dir/client_certs` (права `0600` на Unix, без утечки паролей в профили настроек), сопоставлением точных и wildcard-доменов (`*.domain.com`), интеграцией в `UpstreamHttpClient`, командами `list_client_certificates` / `add_client_certificate` / `toggle_client_certificate` / `remove_client_certificate` и модальным окном `src/components/ClientCertificatesModal.tsx` (`Tools → Client Certificates…`, `Ctrl+Shift+C`).
27. **[Этап 7 — Выполнено] Кастомные скрипты на Python (Python Scripting Engine):**
    - Модули `src-tauri/src/scripting/mod.rs` и `python_runner.rs` с автопоиском Python 3, долгоживущим JSON Lines IPC-воркером, сериализацией через `AsyncMutex` и fail-open таймаутом 1500 мс, вызовами `on_request` / `on_response` в `http_handler.rs` (после декомпрессии `zstd` и с пропуском SSE / `video/*` / `206`), трансляцией `stdout`/`stderr` в `proxy://script-console-log`, панелью `src/components/ScriptingPanel.tsx` (`Alt+5`, Monaco Editor, 4 пресета, живая консоль), сохранением в `FluxUserSettingsProfile`, тестами и гайдами [`PYTHON_SCRIPTING_GUIDE.md`](PYTHON_SCRIPTING_GUIDE.md) / [`PYTHON_SCRIPTING_AI_GUIDE.md`](PYTHON_SCRIPTING_AI_GUIDE.md).
28. **[Этап 8 — Выполнено] Composer 2.0: Умный «Paste cURL» и генератор клиентского кода на 5 языках:**
    - Чистый детерминированный лексер-парсер `src/lib/curlParser.ts` (POSIX Bash, Windows cmd `^` и PowerShell), кнопка `Import cURL` и перехват вставки `curl ...` в URL в `src/components/ComposerPanel.tsx`, модуль `src/lib/codeGenerators.ts` и модальное окно `src/components/CodeSnippetModal.tsx` (Monaco Editor) для генерации кода на **JavaScript** (`fetch`, `axios`), **Python** (`requests`, `httpx`), **Go** (`net/http`), **Rust** (`reqwest`) и **cURL** (Bash, PowerShell) из Composer, `TrafficGrid.tsx` и `MenuBar.tsx`, с unit-тестами `curlParser.test.ts` и `codeGenerators.test.ts`.
29. **[Этап 19 — Выполнено] Автоматическая генерация спецификаций OpenAPI 3.0.3 / Swagger:**
    - Чистый генератор `src/lib/openApiGenerator.ts` (параметризация числовых ID и UUID в `{id}` / `{uuid}`, объединение статус-кодов и рекурсивное слияние JSON Schema, безопасный вынос `Authorization` / `Cookie` / `X-Api-Key` в `components.securitySchemes` без раскрытия боевых секретов, сериализатор YAML/JSON) и модальное окно `src/components/OpenApiExportModal.tsx` (Monaco Editor, настройка title/version/`Include Examples`, сохранение файла) с вызовом из `MenuBar.tsx` (`File → Export as OpenAPI 3.0 Spec…`), контекстного меню `TrafficGrid.tsx` и `CommandPalette`, плюс unit-тесты `openApiGenerator.test.ts`.
30. **[Этап 9 — Выполнено] Тестирование фронтенда (Vitest) и кроссплатформенный CI/CD (GitHub Actions):**
    - Настройка `Vitest 4` (`jsdom`) и `@testing-library/react` в `package.json` и `vite.config.ts`, 12 тестовых файлов (92 unit/integration-теста для `src/lib/*.ts` и `src/hooks/useProxySessions.test.tsx`), а также `.github/workflows/ci.yml` для матрицы `ubuntu-latest`, `windows-latest`, `macos-latest` (`npm ci`, `typecheck`, `test`, `build`, `cargo clippy -- -D warnings`, `cargo test`).
31. **[Этап 31 — Выполнено] Критическая безопасность: защита импорта профилей (RCE), изоляция файлового IPC, санитизация PII/SSE/WS и защита от OOM-бомб (`SEC-01`..`SEC-06`, `BUG-12`):**
    - Превью и принудительное отключение импортируемых Python-скриптов по умолчанию (до явного подтверждения доверия пользователем) в `src/types/settings.ts`, `src/lib/settingsManager.ts`, `src/components/SettingsModal.tsx` и `src/App.tsx`.
    - Жёсткая валидация пользовательских путей `validate_user_file_path` (запрет `..`, UNC, NTFS ADS и DOS-устройств) и лимит `16 MiB` для `import_settings_file` в `src-tauri/src/commands.rs`, изоляция `stored_cert_path` внутри `storage_dir` в `src-tauri/src/proxy/client_certs.rs`.
    - Блокировка LAN SSRF к loopback/unspecified (включая `::ffff:127.0.0.1`), проверка `is_builtin_portal_target` до `CONNECT`, запрет перенаправления через внутренний заголовок `Host` в `TargetedOnly` и изоляция хозяйских mTLS-сертификатов от внешних LAN-клиентов в `src-tauri/src/proxy/server/`.
    - Нормализация ключей в `mask_sensitive_json_value` (`camelCase`), пересборка санитизированных тел SSE/WebSocket (включая SignalR, Socket.IO, Bearer и JWT), санитизация `userinfo`/`#fragment` и заголовков `Location`/`Referer` в `src-tauri/src/storage/export_import/sanitize.rs`, `src-tauri/src/models.rs` и `src/components/SanitizedExportModal.tsx`.
    - Ограниченная потоковая декомпрессия `zstd` (`decode_zstd_bounded`) и кодеков (`src-tauri/src/proxy/codec.rs`), кумулятивный лимит `512 MiB` / `2` слоя `Content-Encoding` и поддержка `zstd` в `.saz`, а также безопасный `chrono::TimeDelta::try_milliseconds` при экспорте `.saz`; покрыто тестами в Rust и `src/lib/settingsManager.test.ts`.
32. **[Этап 32 — Выполнено] Целостность хранилища `TrafficStore` + SQLite и реактивного состояния UI (`BUG-01`, `BUG-02`, `BUG-03`, `BUG-08`, `BUG-11`, `PERF-01`, `PERF-02`, `PERF-06`):**
    - Инициализация `next_id` из `SqliteStore::max_persisted_session_id`, добавление `TrafficStore::get_in_ram` (без синхронных обращений к SQLite на `record_in_flight_session`), приоритизация RAM перед `offloaded_bodies` и сохранение выгруженных тел (`> 2 MiB`) активных RAM-сессий при `clear_sqlite_archive` (`purge_and_vacuum_preserving`) в `src-tauri/src/storage/mod.rs`, `sqlite.rs` и `proxy/server/http_handler.rs`.
    - Перенос `PRAGMA busy_timeout = 5000` перед `WAL`, удаление неиспользуемых индексов `idx_sessions_url`/`idx_sessions_status`, защита `clear()` и `remove_many()` через `eviction_lock`, а также пакетное вытеснение с гистерезисом (`EVICTION_HYSTERESIS_BATCH = 64`) после успешного `persist_batch`.
    - Устойчивая регистрация IPC-подписок в `bootstrap()` с откатом к `127.0.0.1` при ошибке бинда, дедупликация батчей в `flushPendingSessions` на пустой таблице и удаление `sessions.length` из зависимостей `getSessionDetail` в `src/hooks/useProxySessions.ts`; покрыто Rust-тестами и `src/hooks/useProxySessions.test.tsx`.
33. **[Этап 33 — Выполнено] Надежность сетевого ядра, протоколов HTTP/WS/TLS, фильтров и диагностики (`BUG-04`..`BUG-07`, `BUG-09`, `BUG-10`, `BUG-13`, `PERF-03`, `PERF-04`):**
    - RAII-гард `PendingBreakpointGuard` в `src-tauri/src/proxy/breakpoints.rs` и `proxy/server/` (статус `499` и `proxy://breakpoints-changed` при разрыве соединения) + запись статуса `502` при `Abort` в Composer; таймаут `connect_async` и неблокирующий двунаправленный релей WebSocket без взаимной блокировки.
    - Проверка отпечатка SHA-256 активного Root CA в Windows (`certutil`) и macOS (`security`) в `src-tauri/src/proxy/ca.rs`; сохранение `Content-Length` для `HEAD` и точное снятие `Content-Encoding` только для распакованных слоёв в `http_handler.rs`.
    - Поддержка суффиксных масок `.domain.com`, единый разбор IPv6 `[::1]:port` и полная предкомпиляция Regex в `ProxyFilterEngine` (`src-tauri/src/proxy/filters/`) при обновлении конфига; откат `sysproxy` и `proxy://status-changed` в `set_bind_configuration`, стабилизация `ProxyDoctor` (`retry_attempts = 6/3` и отмена timed-out листенеров при shutdown в `doctor.rs`/`server/mod.rs`).
    - Разделение ожидания очереди мьютекса и таймаута пайпа в `src-tauri/src/scripting/python_runner.rs` (очередь пропускается fail-open без перезапуска живого воркера), лимит кэша `pid_name_cache` (4096 записей) в `process.rs` и стабилизация CI (`.github/workflows/ci.yml`: `NODE_OPTIONS=--max-old-space-size=4096` и фиксы `clippy`).
34. **[Этап 11 — Выполнено] Архитектурная декомпозиция монолитов, внедрение Zustand и оптимизация бандла (`ARCH-01`, `PERF-05`):**
    - Разбиение Rust-ядра на подмодули с сохранением публичного API `ProxyController`: `src-tauri/src/proxy/server/{mod,http_handler,connect_tunnel,websocket_relay,composer_exec,mobile_portal}.rs`, `src-tauri/src/proxy/filters/{mod,parsers,tests}.rs` и `src-tauri/src/storage/export_import/{mod,har,saz,raw,sanitize}.rs`.
    - Внедрение `zustand` (`src/stores/{proxyStore,filterStore,uiStore}.ts`), декомпозиция `FilterDrawer` (`src/components/filters/`) и `SettingsModal` (`src/components/settings/`), выделение `src/components/BreakpointBanner.tsx` и перевод тяжёлых модальных окон/панелей на `React.lazy()` + `Suspense`.
    - Оптимизация холодного старта (`PERF-05`): ленивый синглтон `getPreviewEngine()` в `src/lib/tauriBridge.ts` (только вне Tauri-рантайма) и удаление неиспользуемого языкового воркера `ts.worker` (7.05 МБ) из `src/lib/monaco.ts`.
35. **[Этап 10 — Выполнено] Сетевая инфраструктура: HOSTS Remapping и Bandwidth Throttling:**
    - Модуль `src-tauri/src/proxy/hosts.rs` (`HostRemapRegistry` с точными доменами и wildcard-масками, интеграция в `UpstreamHttpClient` и `CONNECT`-туннели с сохранением TLS SNI и заголовка `Host`), модальное окно `src/components/HostRemapModal.tsx` (`Tools → HOSTS Remapping…`, `Ctrl+Shift+H`), бейдж `REMAP` в `TrafficGrid.tsx` и `SessionInspector.tsx`.
    - Модуль `src-tauri/src/proxy/throttle.rs` (шейпинг потоков `AsyncRead` / `AsyncWrite` с RTT-задержкой, пресетами `No Throttling`, `GPRS`, `Slow 3G`, `Fast 3G`, `LTE / 4G`, `Offline` HTTP 503 и `Custom…`), селектор на `TopToolbar.tsx`, команды в `Ctrl+K`, индикатор статус-бара `App.tsx`, сохранение в `FluxUserSettingsProfile` (`settingsManager.ts`) и тесты в Rust и `settingsManager.test.ts`.
36. **[Этап 34 — Выполнено] Статистика запроса и детальные тайминги в стиле Fiddler (`SessionTimers`, метрики соединения и панель `Statistics`):**
    - Опциональные структуры `SessionTimings`, `SessionTransferStats` и компактные поля `SessionSummary` (`ttfb_ms`, `dns_ms`, `connect_ms`, `tls_ms`, `receive_ms`, `request_size`, `wire_body_size`, `server_ip`, `server_conn_reused`) в `src-tauri/src/models.rs` и `src/types/proxy.ts` с полной обратной совместимостью `sessions.sqlite`.
    - Инструментированный транспорт `InstrumentedConnector` / `UpstreamHttpClient` (`src-tauri/src/proxy/upstream_client.rs` на базе `hyper-util` + `tokio-rustls`) и `ClientConnContext` (`CltReuse`, реальные версия TLS, шифр и ALPN вместо заглушек), честный round-trip таймингов и `<SessionTimers>` / `<PipeInfo>` в HAR 1.2 и Fiddler `.saz` + маскирование `client_conn_id` в `sanitize.rs`.
    - Вычислительный движок `src/lib/requestStatistics.ts`, панель `src/components/SessionStatisticsPanel.tsx` (`Inspectors | Statistics` в `SessionInspector.tsx`: Single Session с фазовой шкалой, `ACTUAL PERFORMANCE`, `Bytes & Compression`, `Connection & TLS`, *Estimated Worldwide Performance*; Multi-Selection 2+ сессий с KPI, P50/P95/P99 и inline SVG-диаграммами), опциональные сортируемые колонки `TTFB` / `Server IP` и пофазный tooltip на `Time` в `TrafficGrid.tsx`, unit-тесты `requestStatistics.test.ts` и Rust-тесты.
37. **[Этап 13 — Выполнено] Расширенные протоколы: Upstream Proxy Chaining и ручная инъекция WebSocket-фреймов:**
    - Модуль `src-tauri/src/proxy/upstream_proxy.rs` (`HTTP` / `HTTPS CONNECT` / `SOCKS5` RFC 1928/1929 с опциональной аутентификацией и сопоставлением `bypass_list`: `localhost`, `<local>`, CIDR, `*.domain`, glob, `host:port`) с маршрутизацией HTTP, HTTPS/mTLS, `CONNECT`-туннелей, Composer и WebSocket, модальное окно `src/components/UpstreamProxyModal.tsx` (`Tools → Upstream Proxy…`, `Ctrl+Shift+U`) и беспарольная сериализация `FluxUserUpstreamProxySettings` (пароль хранится только в RAM).
    - Реестр `active_ws_channels` (`DashMap` с RAII-очисткой) в `server/mod.rs` + `websocket_relay.rs`, команда `inject_websocket_frame`, форма ручной инъекции (`Text` / `JSON` / `Hex (Binary)`, `Send to Server` / `Send to Client`, `Ctrl+Enter`) во вкладке `WS` (`src/components/InspectorProtocolPanels.tsx`) и интеграционные/unit-тесты в Rust и `settingsManager.test.ts`.

---

## 📋 Матрица приоритетов и порядок выполнения

> *Номера этапов (`35`, `39`, `36`, `37`, `38`, `12`) используются как стабильные идентификаторы задач (`phase-N`). Все секции документа ниже отсортированы строго в порядке выполнения сверху вниз. Завершенные этапы Спринта 1 (Этапы 14, 15, 20, 21, 25–28) выполнены в релизе `v0.2.0`, этапы Спринта 2 (Этапы 5, 16, 17, 23, 24, 29, 30) выполнены в релизе `v0.3.0`, этапы Спринта 3 (Этапы 6, 7, 8, 9, 18, 19, 22) выполнены в релизе `v0.4.0`, стабилизационный Спринт 4 (Этапы 31–33) выполнен в релизе `v0.4.1`, а этапы Спринта 5 (Этапы 10, 11, 13, 34) выполнены в релизе `v0.5.0` и перенесены в раздел реализованных этапов выше.*

| # | Этап | Приоритет | Спринт | Зависимости | Ключевая ценность |
| :-: | :--- | :--- | :--- | :--- | :--- |
| 1 | **[Этап 35](#этап-35-стабилизация-маршрутизации-hosts--ws--upstream-proxy-атомарная-инъекция-ws-фреймов-паритет-composer-и-защита-от-oom)** | **P1 (Core Reliability & Security)** | Спринт 6 | Этапы 7 ✅, 10 ✅, 13 ✅, 34 ✅ | Починка `HOSTS Remapping` для прямых WebSocket (`BUG-01`) и IP / HTTP-прокси (`BUG-02`), предкомпиляция Regex в `hosts.rs` (`PERF-01`), сохранение инъектированных WS-фреймов (`CONC-02`), лимит 64 MiB для буферизации ответов (`SEC-01`), Python-хуки и `OverrideStatus` в Composer (`BUG-03`), синхронизация `clientSendMs` (`BUG-04`), индикация `via <proxy>` в `Server IP` (`BUG-05`) и дедупликация 16-мс батчера (`PERF-02`) |
| 2 | **[Этап 39](#этап-39-разделение-и-настройка-upstream-таймаутов-прозрачное-ожидание-ответа-сервера-ttfb-и-raii-финализация-отменённых-запросов-499)** | **P1 (Core Proxy Transparency & Timeouts)** | Спринт 6 | Этапы 4 ✅, 21 ✅, 33 ✅, 34 ✅, 35 | Разделение жёсткого 15-с лимита на настраиваемые `connectTimeoutSec` (15 с) и `responseHeaderTimeoutSec` (по умолчанию `0` = Unlimited / ожидание реального ответа или ошибки сервера), отдельный `composerTimeoutSec` (120 с) + кнопка отмены `Cancel`, RAII-гард `InFlightSessionGuard` (финализация обрывов клиента как `499`) и диагностический заголовок `X-FluxProxy-Error` |
| 3 | **[Этап 36](#этап-36-защита-ключей-mtls-dpapi--in-memory-lan-client-allowlist-чистота-zustand-сторов-очистка-техдолга-и-синхронизация-документации)** | **P1 / P2 (Security, State & Hygiene)** | Спринт 6 | Этапы 11 ✅, 18 ✅, 35 | Шифрование ключей mTLS/CA через Windows DPAPI + режим `Session-only (In-Memory)` (`SEC-03`), белый список `LAN Client Allowlist`, фильтрация `SAFE_RASTER_IMAGE_MIMES` в Multipart (`SEC-02`), устранение сброса сессий в `syncFromLocalStorage` (`CONC-01`) и $O(N)$ аллокаций (`PERF-03`), удаление мёртвого кода `reqwest` (`ARCH-01`), вынос `BrowserPreviewEngine` (`ARCH-02`) и синхронизация документации с кодом |
| 4 | **[Этап 37](#этап-37-исправление-ui-багов-инспектора-hexviewer-и-timing-breakdown-и-редизайн-command-palette-20)** | **P1 (UI Bugfixes & UX Ergonomics)** | Спринт 6 | Этапы 22 ✅, 30 ✅, 34 ✅ | Устранение сдвига колонок и наложения байтов на `DECODED ASCII` во вкладке `Hex` (`HexViewer.tsx`), устранение мелькания тултипа при наведении на легенду `TIMING BREAKDOWN` (`SessionStatisticsPanel.tsx`, показ только на таймлайне без layout shift) и крупная понятная `Command Palette 2.0` (`max-w-3xl`, категории, описания, статусы, чипы синтаксиса `bpu`/`jwt`) |
| 5 | **[Этап 38](#этап-38-единый-полноэкранный-центр-настроек-unified-fullscreen-settings-hub-реорганизация-вкладок-дедупликация-панелей-и-система-подсказок)** | **P1 / P2 (UI Architecture & Discoverability)** | Спринт 6 | Этапы 4 ✅, 10 ✅, 11 ✅, 13 ✅, 18 ✅, 22 ✅, 37, 39 | Консолидация всех разрозненных модалок настроек (`FilterDrawer`, `HOSTS`, `Upstream Proxy`, `Root CA`, `mTLS`, `Mobile`, `Throttling`, `Proxy Doctor`) в единый полноэкранный `Settings Hub` (`Ctrl+,`), сохранение/перенос `Upstream Timeouts`, перевод конфигурационных модалок в fullscreen, удаление устаревшего свитча темы и дубликатов кнопок между `MenuBar`/`TopToolbar`/`Sidebar`/`Inspector`, наглядный доступ к `Throttling` и контекстные подсказки (`HelpTooltip`) |
| 6 | **[Этап 12](#этап-12-аналитика-и-визуализация-waterfall-timeline-и-статистика-трафика)** | **P2 (Feature)** | Спринт 6 | Этапы 34 ✅, 35, 39, 36, 37, 38 | Виртуализированная многофазная каскадная диаграмма (Waterfall) и сводный Markdown-отчет по всей выборке (P95, TTFB, статусы, MIME) |

---

## 🏛️ Утверждённые архитектурные решения по открытым вопросам (По итогам аудита `v0.5.0`)

> По итогам доказательного аудита `v0.5.0` (`BUG-01..05`, `CONC-01..02`, `SEC-01..03`, `PERF-01..03`, `ARCH-01..02`) по четырём архитектурным развилкам приняты следующие решения на основе лучших индустриальных практик (Fiddler Classic, Proxyman, mitmproxy, OWASP Desktop Security), включённые в **Этапы 35 и 36**:

1. **Исполнение Python-хуков (`on_request` / `on_response`) для запросов из Request Composer и `Replay` (`src-tauri/src/proxy/server/composer_exec.rs` → Этап 35):**
   - *Утверждённое решение (Best Practice):* По умолчанию все запросы, отправляемые через `execute_composed` (включая ручную отправку из Request Composer и команду `Replay` по `R` / `Ctrl+R`), **проходят через активный `PythonScriptRunner` (`on_request` и `on_response`)** в том же порядке конвейера, что и обычный трафик прокси (`HeaderMutations → Breakpoint Before Request → Python on_request → AutoResponder → Upstream → Decompression → Python on_response → Breakpoint After Response`). Это гарантирует автоматический пересчёт динамических подписей (`HMAC`, `X-Signature`), токенов и JSON-мутаций при повторе запросов. Для случаев, когда инженеру нужен «сырой» запрос в обход скрипта, в `ComposedRequest` добавляется опциональное поле `skipPythonScripts?: boolean` (по умолчанию `false`), управляемое компактным чекбоксом *«Run Python Scripts»* в панели `ComposerPanel.tsx`.
2. **Защита приватных ключей mTLS (`{id}.identity.pem`) и Root CA на диске (`[SEC-03]`, `src-tauri/src/proxy/client_certs.rs`, `ca.rs` → Этап 36):**
   - *Утверждённое решение (Best Practice — Defense-in-Depth):*
     1. **Прозрачное шифрование на диске средствами ОС (Windows DPAPI):** На Windows функция сохранения приватных ключей (`{id}.identity.pem` и `fluxproxy-root-ca.key`) шифрует содержимое через Win32 API `CryptProtectData` (с флагом `CRYPTPROTECT_UI_FORBIDDEN`, привязанным к учётной записи текущего пользователя Windows) и записывает с заголовком `FLUX_DPAPI_V1:<base64>`. При чтении ключа поддерживается обратная совместимость с существующими открытыми PEM-файлами (с автоматической перешифровкой в DPAPI), а на Unix сохраняются строгие права `0600`.
     2. **Режим `Session-only (In-Memory)` для корпоративных сертификатов:** В `AddClientCertificateInput` / `ClientCertificateEntry` и модальное окно `ClientCertificatesModal.tsx` добавляется опция `ephemeral?: boolean` (*«Session-only (Keep in RAM, do not write key to disk)»*, по умолчанию `false`), позволяющая загрузить защищённый паролем `.p12`/`.pfx` исключительно в оперативную память текущего сеанса без создания файлов в `app_data_dir/client_certs`.
3. **Телеметрия `Server IP` при активном `Upstream Proxy Chaining` (`[BUG-05]`, `src-tauri/src/proxy/upstream_client.rs`, `websocket_relay.rs`, `connect_tunnel.rs` → Этап 35):**
   - *Утверждённое решение (Best Practice):* Не выдавать IP-адрес вышестоящего прокси-шлюза за IP целевого веб-сервера. В `SessionTransferStats` (`models.rs`, `proxy.ts`) добавляется опциональное поле `viaProxyAddr?: string | null` (например, `"SOCKS5 127.0.0.1:1080"` или `"HTTP 10.0.0.2:8080"`), а в `SessionSummary.server_ip` и `SessionTransferStats.server_ip` при маршрутизации через прокси записывается строка `"via <proxy_ip>:<port>"` (отображаемая в колонке `Server IP` таблицы `TrafficGrid` и в карточке `Connection & TLS` панели `Statistics`).
4. **Контроль доступа для внешних LAN-клиентов в режимах `AllInterfaces` (`0.0.0.0`) и `Specific` (`src-tauri/src/proxy/filters/mod.rs`, `connect_tunnel.rs`, `http_handler.rs` → Этап 36):**
   - *Утверждённое решение (Best Practice):* В дополнение к уже действующей блокировке LAN SSRF к loopback-адресам и изоляции хозяйских mTLS-сертификатов, в `ProxyFilterBackendConfig` и `FluxUserProxySettings` добавляется опциональный белый список клиентских адресов **`lanClientAllowlist?: string[]`** (поддерживающий точные IPv4/IPv6 адреса `192.168.1.45` и CIDR-подсети `192.168.1.0/24`; пустой список по умолчанию разрешает все LAN-клиенты для zero-friction подключения смартфона по QR-коду). Неразрешённые внешние клиенты отклоняются с `403 Forbidden` до создания записи в `TrafficStore`. В `MobileSetupModal.tsx` и контекстное меню строки мобильного устройства в `TrafficGrid.tsx` добавляется быстрое действие *«Allow only this device IP»*.

---

## ⚙️ Общие инженерные правила

1. **Изоляция новых подсистем (Modular-First Guardrail):**
   После архитектурной декомпозиции в Этапе 11 (`v0.5.0`) крупные подсистемы разнесены по модулям (`src-tauri/src/proxy/server/`, `proxy/filters/`, `storage/export_import/`, `src/stores/`, `src/components/filters/`, `src/components/settings/`). При реализации новых этапов **продолжайте выносить новую логику в отдельные Rust-модули, TS-утилиты и React-компоненты**, избегая повторного разрастания `App.tsx`, `tauriBridge.ts`, `settingsManager.ts`, `useProxySessions.ts` и `http_handler.rs`.
2. **Обязательная верификация после каждого этапа:**
   - Проверка типов: `npm run typecheck`
   - Тесты фронтенда: `npm run test`
   - Сборка фронтенда: `npm run build`
   - Линтер Rust: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
   - Rust-тесты: `cargo test --manifest-path src-tauri/Cargo.toml`
3. **Dual-Mode разработка (Browser Preview Simulator):**
   Каждая новая Tauri-команда и событие должны иметь безопасный fallback в `src/lib/tauriBridge.ts` (и выделяемом `src/lib/previewEngine.ts`) и `src/lib/mockTraffic.ts`, чтобы интерфейс полноценно запускался через `npm run dev` в обычном браузере.
4. **Обратная совместимость `FluxUserSettingsProfile`:**
   Новые настройки (`src/types/settings.ts`, `src/lib/settingsManager.ts`) добавляйте как опциональные с безопасными значениями по умолчанию и fallback-нормализацией при импорте старых JSON-профилей `schemaVersion: 1` (обновляя все 7 точек регистрации: `src/types/settings.ts`, `SETTINGS_STORAGE_KEYS` / `createDefaultSettingsProfile`, `validateAndMigrateSettingsProfileWithReport`, `collectCurrentSettingsProfile`, `atomicWriteProfileToLocalStorage` / `applySettingsProfile`, `liveSnapshotRef` в `src/App.tsx` и обработчики события `SETTINGS_APPLIED_EVENT` в Zustand-сторах).
5. **Паритет Rust ↔ TypeScript:**
   Изменения в правилах фильтрации, TLS-режимах или типах данных синхронизируйте между `src-tauri/src/models.rs` ↔ `src/types/proxy.ts` и `src-tauri/src/proxy/filters/` ↔ `src/lib/filterEngine.ts`.
6. **Атомарная фиксация в Git:**
   ```bash
   git add .
   git commit -m "feat(phase-N): <краткое описание выполненного этапа>"
   ```

---

## 🔴 Спринт 6 — P1 / P2 (Audit `v0.5.0` Remediation, UX Redesign & Analytics): Стабилизация сетевого ядра, настраиваемые upstream-таймауты, защита ключей, единый полноэкранный Settings Hub, Command Palette 2.0 и Waterfall Timeline

---

## Этап 35: Стабилизация маршрутизации (HOSTS / WS / Upstream Proxy), атомарная инъекция WS-фреймов, паритет Composer и защита от OOM
**Приоритет: P1 (Core Reliability & Security) | Спринт 6 | Зависимости: Этапы 7 ✅, 10 ✅, 13 ✅, 34 ✅ | Находки аудита: `BUG-01`..`BUG-05`, `CONC-02`, `SEC-01`, `PERF-01`, `PERF-02` + Решения №1, №3**

### Цель и контекст
В ходе доказательного аудита `v0.5.0` в сетевом конвейере Rust-ядра обнаружены дефекты маршрутизации, конкурентности и буферизации:
1. **`[BUG-01]` Обход `HOSTS Remapping`, `ThrottleController` и `mTLS` на прямых WebSocket (`ws://` / `wss://`):** в `handle_websocket_intercept` (`src-tauri/src/proxy/server/websocket_relay.rs:849-862, 1250-1255`) `ctx.host_remap.resolve_connect_target` вычисляет `(connect_host, connect_port, remapped_to)` и выставляет бейдж `REMAP` в `SessionSummary`, но при `active_upstream_proxy == None` вызывает `tokio_tungstenite::connect_async(ws_req)`, который резолвит исходный `host_header` через системный DNS и подключается к реальному серверу в обход `connect_host:connect_port`. Также для WebSocket не применяются `ThrottleController` (RTT + шейпинг потока) и `ClientCertificateStore` (mTLS).
2. **`[BUG-02]` & `[PERF-01]` Ошибки `HOSTS Remapping` для IP-источников и plain HTTP через HTTP Upstream Proxy + компиляция Regex на горячем пути:**
   - в `prepare_remapped_upstream_target` (`src-tauri/src/proxy/server/http_handler.rs:161-186`) для IP-источников (`is_ip_source == true`) `upstream_url` перезаписывается до вызова `UpstreamHttpClient`, из-за чего `InstrumentedConnector::call` (`src-tauri/src/proxy/upstream_client.rs:442-466`) теряет оригинальный хост (ломая TLS SNI и `transfer_stats.remapped_target`);
   - для доменных источников (`is_ip_source == false`) при отправке plain `http://` через вышестоящий `HTTP`/`HTTPS` прокси (`via_http_proxy == true` в `upstream_client.rs:475-521, 1346-1356`) вышестоящему прокси уходит `GET http://original-domain/...`, игнорируя `target_host:target_port`;
   - `HostRemapRegistry::match_host` (`src-tauri/src/proxy/hosts.rs:158-191, 273-310`) на каждом запросе заново компилирует `Regex::new` через `compile_glob_regex` для всех масок с `*`/`?` (кроме простого `*.suffix`).
3. **`[CONC-02]` & `[PERF-02]` Потеря вручную инъектированных WebSocket-фреймов и шторм дубликатов в IPC:**
   - `ProxyEngineController::inject_websocket_frame` (`src-tauri/src/proxy/server/mod.rs:1449-1461`) пушит инъектированный кадр в `detail.websocket_frames` в `TrafficStore`, но цикл релея в `websocket_relay.rs:577, 608-615, 672-679` хранит отдельный локальный вектор `frames` (не знающий об инъекциях) и при следующем входящем/исходящем кадре перезаписывает `detail.websocket_frames.clone_from(&frames)`, стирая инъектированные кадры;
   - каждый фрейм WebSocket и чанк SSE (`http_handler.rs:2934-2946`) без троттлинга пушит `SessionSummary` в `event_tx`, а 16-мс батчер (`server/mod.rs:829-848`) пересылает до 250 дубликатов одной и той же сессии за один тик без дедупликации по `id`.
4. **`[SEC-01]` Неограниченная буферизация тела ответа сервера в RAM (OOM DoS):** в ветке `4c` (`http_handler.rs:2349-2457`) и в `composer_exec.rs:557-641` ответы, не попавшие в zero-buffering стриминг `4b` (например, крупные или бесконечные `Transfer-Encoding: chunked`, потоки HTTP/2 без `Content-Length`, ответы с поддельным малым `Content-Length` или крупные ответы со сжатием `zstd`), буферизируются в `Vec<u8>` без верхнего предела.
5. **`[BUG-03]` & Решение №1 (Неполный конвейер `execute_composed` в Composer и `Replay`):** `src-tauri/src/proxy/server/composer_exec.rs:175-266, 456-466, 539-555` отбрасывает найденное правило AutoResponder для `RuleActionType::OverrideStatus` (не подменяя код статуса ответа), не вызывает `PythonScriptRunner` (`on_request` / `on_response`), не фильтрует hop-by-hop заголовки и оставляет старый `Host` в `outbound_headers`, который при кросс-доменном редиректе (`upstream_client.rs:1252-1263`) отправляется на новый домен.
6. **`[BUG-04]` & `[BUG-05]` & Решение №3 (Потеря обновления `clientSendMs` в UI и подмена `server_ip` адресом прокси):** `TrafficStore::update_client_send_timing` (`src-tauri/src/storage/mod.rs:790-828`) не вызывает `summary.apply_telemetry` и не пушит обновлённый `SessionSummary` в `event_tx`; при активном `UpstreamProxy` в `server_ip` записывается чистый IP прокси без маркера `via` и без `via_proxy_addr`.

### Критерии приемки (DoD)
- **`[PERF-01]`:** В `src-tauri/src/proxy/hosts.rs` `HostRemapRegistry` хранит предкомпилированные `CompiledHostRemapRule` (с `Option<Regex>`), компилируемые один раз при `update_rules`; на горячем пути `match_host` нет вызовов `Regex::new`.
- **`[BUG-01]`:** В `src-tauri/src/proxy/server/websocket_relay.rs` при прямом подключении (`active_upstream_proxy == None`) TCP-соединение устанавливается к `(connect_host, connect_port)` из `resolve_connect_target`, применяется `ctx.throttle.apply_latency()` и `ctx.throttle.wrap_stream(...)`, а для `wss://` при `is_loopback_client` используется клиентский сертификат из `ctx.client_certs` и оригинальный TLS SNI (`target_host`).
- **`[BUG-02]`:** В `http_handler.rs` `prepare_remapped_upstream_target` не перезаписывает `upstream_url` для IP-источников (передавая оригинальный URL в `UpstreamHttpClient`, где `InstrumentedConnector` сам подменяет физический адрес сокета и сохраняет SNI и `remapped_target`); при `via_http_proxy == true` и наличии правила `HostRemapRule` запрос к вышестоящему HTTP-прокси направляется на `target_host:target_port` с сохранением заголовка `Host` (при `preserve_host_header == true`).
- **`[CONC-02]` & `[PERF-02]`:**
  - В `websocket_relay.rs` удалён локальный теневой вектор `frames: Vec<WebSocketFrameRecord>` и вызовы `detail.websocket_frames.clone_from(&frames)`; каждый входящий/исходящий фрейм добавляется напрямую в `detail.websocket_frames` внутри `ctx.store.update_session_in_place` с последовательным `index = detail.websocket_frames.len() + 1`, гарантируя сохранность кадров, добавленных через `inject_websocket_frame`.
  - В 16-мс микро-батчере (`src-tauri/src/proxy/server/mod.rs:829-848`) при накоплении `buffer` записи с одинаковым `summary.id` коалесцируются (в батче остаётся последнее состояние сессии с сохранением порядка), а в `websocket_relay.rs` и `record_sse_chunk` промежуточные отправки в `event_tx` троттлятся интервалом `75 мс` (с обязательной отправкой первого кадра и финального состояния).
- **`[SEC-01]`:** В ветке `4c` (`http_handler.rs:2349-2457`) и в `composer_exec.rs:557-641` чтение тела ответа от upstream ограничено константой `MAX_BUFFERED_RESPONSE_BODY_BYTES = 64 * 1024 * 1024` (64 MiB); при превышении лимита чтение безопасно прекращается с понятной диагностикой без OOM.
- **`[BUG-03]` & Решение №1:**
  - В `composer_exec.rs` применяется `RuleActionType::OverrideStatus` (перезапись статуса ответа, `is_mocked: true`, `matched_rule_id`), очищаются hop-by-hop заголовки, а в цикле редиректов `upstream_client.rs:1252-1263` при смене `authority` удаляется старый заголовок `Host`.
  - В `ComposedRequest` (`models.rs`, `src/types/proxy.ts`) добавлено опциональное поле `skipPythonScripts?: boolean` (по умолчанию `false`); в `composer_exec.rs` при `!request.skip_python_scripts.unwrap_or(false)` вызываются `script_runner.run_on_request` (с поддержкой `mock_response`) и `script_runner.run_on_response`, а в `src/components/ComposerPanel.tsx` добавлен чекбокс *«Run Python Scripts»*.
- **`[BUG-04]` & `[BUG-05]` & Решение №3:**
  - В `TrafficStore::update_client_send_timing` (`src-tauri/src/storage/mod.rs:790-828`) вызывается `detail_mut.summary.apply_telemetry(...)` и при `duration_changed == true` обновлённый `SessionSummary` отправляется в `self.event_tx`.
  - В `SessionTransferStats` (`models.rs`, `src/types/proxy.ts`) добавлено поле `viaProxyAddr?: string | null`; при активном `UpstreamProxy` в `server_ip` записывается `"via <proxy_ip>:<port>"`, а в `via_proxy_addr` — `"<PROTO> <proxy_ip>:<port>"`.
- Добавлены регрессионные Rust-тесты на прямой WebSocket с `HostRemapRegistry`, чередование `inject_websocket_frame` с обычными WS-кадрами, `OverrideStatus` + Python-хуки в `execute_composed` и лимит буферизации chunked-ответа.

### 📝 Промпт для Antigravity (Этап 35)

```markdown
Роль: Principal Rust Network Systems & Full-Stack Engineer (Tauri v2 + Hyper + Tokio + React 19).
Проект: FluxProxy (Tauri v2 + Rust + React 19).

Задача: Выполнить Этап 35 из ROADMAP.md — устранить дефекты маршрутизации, конкурентности WebSocket-инъекции, паритета Composer и ограничения памяти из аудита v0.5.0 (`BUG-01`..`BUG-05`, `CONC-02`, `SEC-01`, `PERF-01`, `PERF-02` и Решения №1, №3).

1. Предкомпиляция Regex в `HostRemapRegistry` и починка `HOSTS Remapping` (`[PERF-01]`, `[BUG-01]`, `[BUG-02]`, `src-tauri/src/proxy/hosts.rs`, `src-tauri/src/proxy/server/websocket_relay.rs`, `src-tauri/src/proxy/server/http_handler.rs`, `src-tauri/src/proxy/upstream_client.rs`):
   - В `hosts.rs` создать внутреннюю структуру `CompiledHostRemapRule` с предкомпилированным `Option<Regex>` при обновлении правил в `update_rules`, чтобы `match_host` работал без вызовов `Regex::new` на горячем пути.
   - В `websocket_relay.rs:849-1255` при прямом подключении (`active_upstream_proxy == None`) подключать TCP-сокет к `(connect_host.as_str(), connect_port)` через `measure_ws_tcp_connect`, применять `ctx.throttle.apply_latency().await` и оборачивать поток в `ThrottledStream` (если троттлинг активен). Для `ws://` запускать `tokio_tungstenite::client_async(ws_req, stream)`, а для `wss://` выполнять TLS-рукопожатие с оригинальным SNI (`target_host`) и клиентским сертификатом из `ctx.client_certs` (для loopback-клиентов).
   - В `http_handler.rs:136-216` (`prepare_remapped_upstream_target`) не перезаписывать `upstream_url` для IP-источников, оставив подмену физического сокета коннектору `InstrumentedConnector::call`. В `upstream_client.rs` для случая `via_http_proxy == true` и наличия `remapped_target` направлять запрос через вышестоящий HTTP-прокси на `target_host:target_port`, сохраняя оригинальный заголовок `Host` при `preserve_host_header == true`.

2. Атомарное хранение WebSocket-фреймов и дедупликация IPC-батчера (`[CONC-02]`, `[PERF-02]`, `src-tauri/src/proxy/server/websocket_relay.rs`, `src-tauri/src/proxy/server/mod.rs`, `src-tauri/src/proxy/server/http_handler.rs`):
   - В `websocket_relay.rs:577-697` удалить теневой вектор `frames: Vec<WebSocketFrameRecord>` и вызов `detail.websocket_frames.clone_from(&frames)`. При получении каждого фрейма добавлять его напрямую в `detail.websocket_frames` внутри `ctx.store.update_session_in_place(session_id, |detail| ...)` с индексом `detail.websocket_frames.len() + 1` (до лимита 500 кадров), чтобы кадры от `inject_websocket_frame` никогда не затирались.
   - В 16-мс микро-батчере (`server/mod.rs:829-848`) при добавлении `SessionSummary` в `buffer` заменять существующий элемент с тем же `id` на месте, чтобы за один тик батчера каждая сессия отправлялась через IPC максимум один раз.
   - В `websocket_relay.rs` и `record_sse_chunk` (`http_handler.rs:2934-2946`) троттлить промежуточные вызовы `event_tx.send(summary)` интервалом `75 мс` (всегда отправляя первый кадр/чанк и финальное завершение потока).

3. Защита от OOM на буферизированных ответах (`[SEC-01]`, `src-tauri/src/proxy/server/http_handler.rs`, `src-tauri/src/proxy/server/composer_exec.rs`):
   - Ввести константу `MAX_BUFFERED_RESPONSE_BODY_BYTES: usize = 64 * 1024 * 1024` (64 MiB) и ограничить буферизацию тела ответа в ветке `4c` (`http_handler.rs:2349-2457`) и в `composer_exec.rs:557-641` (через `http_body_util::Limited::new` и проверку длины `collected` при активном download-троттлинге).

4. Полный конвейер Request Composer / Replay (`[BUG-03]`, Решение №1, `src-tauri/src/proxy/server/composer_exec.rs`, `src-tauri/src/proxy/upstream_client.rs`, `src-tauri/src/models.rs`, `src/types/proxy.ts`, `src/components/ComposerPanel.tsx`):
   - Добавить в `ComposedRequest` (`models.rs` и `proxy.ts`) опциональное поле `skip_python_scripts: Option<bool>` (`skipPythonScripts?: boolean`).
   - В `composer_exec.rs` фильтровать hop-by-hop заголовки при сборке запроса, вызывать `script_runner.run_on_request` и `run_on_response` (если `!request.skip_python_scripts.unwrap_or(false)`, с учётом `script_hook_ms` и `mock_response`), а также сохранять правило AutoResponder и применять `RuleActionType::OverrideStatus` к полученному ответу (`status = rule.status_code`, `is_mocked = true`, `matched_rule_id = Some(rule.id)`).
   - В цикле редиректов `upstream_client.rs:1252-1263` при смене `authority` между исходным URL и `next_url` удалять заголовок `Host` из `current_headers`.
   - В `src/components/ComposerPanel.tsx` добавить компактный чекбокс «Run Python Scripts» (по умолчанию включён).

5. Телеметрия `clientSendMs` и `viaProxyAddr` (`[BUG-04]`, `[BUG-05]`, Решение №3, `src-tauri/src/storage/mod.rs`, `src-tauri/src/models.rs`, `src-tauri/src/proxy/upstream_client.rs`, `websocket_relay.rs`, `connect_tunnel.rs`, `src/types/proxy.ts`, `src/components/SessionStatisticsPanel.tsx`):
   - В `TrafficStore::update_client_send_timing` (`storage/mod.rs:790-828`) вызывать `detail_mut.summary.apply_telemetry(...)` и при `duration_changed == true` отправлять `let _ = self.event_tx.send(summary.clone());`.
   - Добавить `via_proxy_addr: Option<String>` (`viaProxyAddr?: string | null`) в `SessionTransferStats`, а при маршрутизации через `UpstreamProxy` записывать в `server_ip` формат `"via <proxy_ip>:<port>"`.

6. Тесты: добавить интеграционные тесты в `src-tauri/src/proxy/server/mod.rs` на прямой WebSocket с `HostRemapRegistry`, сохранение инъектированного WS-фрейма после прихода новых кадров от сервера и работу `OverrideStatus` + Python-хука в `execute_composed`.

Проверка: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 39: Разделение и настройка upstream-таймаутов, прозрачное ожидание ответа сервера (TTFB) и RAII-финализация отменённых запросов (499)
**Приоритет: P1 (Core Proxy Transparency & Timeouts) | Спринт 6 | Зависимости: Этапы 4 ✅, 21 ✅, 33 ✅, 34 ✅, 35**

### Цель и контекст
В текущем сетевом ядре FluxProxy зашит единый неконфигурируемый 15-секундный лимит на ожидание ответа upstream-сервера:
1. **Единый жёстко зашитый таймаут на соединение и обработку на сервере:**
   - В `src-tauri/src/proxy/server/mod.rs:48, 977` объявлена константа `DEFAULT_UPSTREAM_TIMEOUT_SEC: u64 = 15`, передаваемая как неизменяемое поле `upstream_timeout_sec` в `SharedProxyContext`, а в `src-tauri/src/proxy/upstream_client.rs:33` — `CONNECT_TIMEOUT_DEFAULT: Duration = Duration::from_secs(15)`.
   - В `UpstreamHttpClient::send_request` (`src-tauri/src/proxy/upstream_client.rs:1072-1087`) конструкция `tokio::time::timeout(timeout, self.client.request(req))` накрывает одним 15-секундным таймером **и** установку соединения (DNS + TCP + Upstream Proxy + TLS Handshake), **и** ожидание первых заголовков ответа от сервера (TTFB). При превышении 15 000 мс возвращается `UpstreamClientError::Timeout("Upstream request timed out after 15000 ms")` со статусом `504 Gateway Timeout`, который в `http_handler.rs:1598-1659` и `composer_exec.rs:467-527` преобразуется в `"Upstream connection error: Upstream request timed out after 15000 ms"`.
2. **Почему это ломает диагностику и отладку серверных ошибок:**
   - Когда бэкенд, БД, LLM-API или вышестоящий reverse proxy (nginx / ALB / Cloudflare / API Gateway с таймаутами 30–60 с) долго обрабатывает запрос (> 15 с) и затем возвращает **реальную ошибку сервера** (`500` со stack trace / JSON error details, `502`/`503`/`504`/`408` с заголовками `X-Request-Id` / `Traceparent`), FluxProxy обрывает запрос ровно на 15 000 мс и подменяет ответ синтетическим `504` с текстом `Upstream connection error: Upstream request timed out after 15000 ms`.
   - В итоге и клиентское приложение, и разработчик в Traffic Viewer **полностью теряют информацию об ошибке от сервера**, а отладочный прокси нарушает принцип прозрачности (observer effect).
3. **Почему нельзя ограничиться простым увеличением константы или удалением таймаута:**
   - **Разделение фаз Connect vs TTFB:** зависания на фазе установления соединения (недоступный IP, firewall drop, зависший TLS handshake) должны продолжать отсекаться быстрым `connectTimeoutSec` (по умолчанию `15` с) с единым дедлайном на DNS → TCP → Upstream Proxy → TLS в `InstrumentedConnector` (а также в прямом пути `connect_tunnel.rs:231, 264`, где сейчас вообще нет таймаута на DNS/TCP). При этом ожидание заголовков ответа (TTFB) после отправки запроса должно управляться отдельно (`responseHeaderTimeoutSec`, по умолчанию `0` = `Unlimited`, т.е. прокси не перебивает таймауты клиента и сервера и дожидается реального ответа или ошибки сервера).
   - **Риск «вечных Pending-сессий» без RAII-гарда:** при `responseHeaderTimeoutSec = 0` (или большом значении) если сам клиент (браузер/SDK) разорвёт соединение раньше сервера, Hyper отменит future `handle_intercepted_request`. Поскольку сейчас в `server/mod.rs:445-473` RAII-очистка есть только для паузы на Breakpoint (`PendingBreakpointGuard`), но не для активного `send_request`, сессия из Этапа 21 останется в `TrafficStore` в статусе `0 / Pending` навсегда. Нужен `InFlightSessionGuard`, фиксирующий разрыв клиента как `499 Client Closed Request`.
   - **Автономность Request Composer / Replay:** в Composer нет внешнего сокета клиента, который прервёт запрос по своему таймауту, поэтому Composer нужен отдельный настраиваемый `composerTimeoutSec` (по умолчанию `120` с) и кнопка ручной отмены `Cancel`.
   - **Диагностическая прозрачность ошибок прокси:** синтетические ответы `504` от FluxProxy сейчас не имеют маркерного заголовка, из-за чего их легко спутать с настоящим `504 Gateway Timeout` от upstream-сервера или CDN.

### Критерии приемки (DoD)
- **Разделённая модель конфигурации `UpstreamTimeoutConfig` (`src-tauri/src/models.rs` ↔ `src/types/proxy.ts`):**
  - `connectTimeoutSec: u64` — таймаут установления соединения (DNS + TCP + Upstream Proxy + TLS handshake), по умолчанию `15` с, допустимый диапазон `1..=300` с.
  - `responseHeaderTimeoutSec: u64` — таймаут ожидания первых заголовков ответа сервера (TTFB), по умолчанию `0` (`0` = Unlimited / не обрывать медленный сервер, либо `5..=3600` с при явном ограничении).
  - `composerTimeoutSec: u64` — таймаут для запросов из Request Composer и `Replay`, по умолчанию `120` с (`0` = Unlimited, либо `1..=3600` с).
- **Lock-free обновление на лету и персистентность:**
  - В `SharedProxyContext` (`src-tauri/src/proxy/server/mod.rs`) плоское поле `upstream_timeout_sec: u64` заменено на `Arc<AtomicU64>` (для `connect_timeout_sec`, `response_header_timeout_sec`, `composer_timeout_sec`), пробрасываемые в `InstrumentedConnector` (включая mTLS-клиенты в `src-tauri/src/proxy/client_certs.rs`) — изменение настроек применяется мгновенно без перезапуска прокси и без сброса пула соединений; устаревший `reqwest`-код в `http_handler.rs:92` остаётся компилируемым до удаления в Этапе 36.
  - Конфигурация сохраняется в `app_data_dir` (по аналогии с `proxy_port.pref` / `bind_config.pref` в `sysproxy.rs`) и автоматически загружается при инициализации `ProxyEngineController::new`.
- **Единый Connect Deadline и опциональный TTFB-таймаут (`src-tauri/src/proxy/upstream_client.rs`, `connect_tunnel.rs`, `websocket_relay.rs`):**
  - `InstrumentedConnector::call` читает актуальный `connect_timeout_sec` и использует единый `connect_deadline = Instant::now() + connect_timeout` на всю цепочку DNS → TCP → Upstream Proxy → TLS handshake с чётким указанием зависшего этапа при ошибке (`UpstreamClientError::Connect`).
  - В `connect_tunnel.rs:225-279` прямой путь `CONNECT` (DNS lookup и `TcpStream::connect`) также ограничен `connect_timeout_sec`, а в `websocket_relay.rs:871` используется `connect_timeout_sec`.
  - Сигнатуры `UpstreamHttpClient::send_request`, `send_with_idempotent_retry` и `send_following_redirects` принимают `response_timeout: Option<Duration>`: при `None` (`responseHeaderTimeoutSec == 0`) вызов `self.client.request(req).await` не обрывается прокси по искусственному TTFB-таймеру (оставаясь защищённым `connectTimeoutSec` на уровне коннектора); при `Some(dur)` оборачивается в `tokio::time::timeout`.
- **RAII-гард `InFlightSessionGuard` (`499 Client Closed Request` в `http_handler.rs`):**
  - Создаётся сразу после `record_in_flight_session_with_remap` и снимается (`guard.disarm()`) при нормальном завершении ответа, переходе в SSE/Stream или записи ошибки.
  - Если клиент закрыл соединение во время ожидания ответа upstream-сервера, `Drop` обновляет сессию в `TrafficStore` со статусом `499`, фактическим `duration_ms` и ошибкой `"Client closed connection while waiting for upstream response"` и пушит обновлённый `SessionSummary` в `event_tx`.
- **Явная диагностика синтетических ошибок FluxProxy (`X-FluxProxy-Error`):**
  - `record_and_return_error_with_telemetry` / `plain_response` добавляет диагностический заголовок `X-FluxProxy-Error` (`upstream-response-timeout`, `upstream-connect-timeout`, `upstream-connect-error` и т.п.) как в HTTP-ответ клиенту, так и в `SessionDetail.response_headers`.
  - Текст ошибки таймаута явно называет фазу и настройку (`FluxProxy upstream response timeout after <N> ms while waiting for response headers (TTFB)...`), а в `src/components/SessionInspector.tsx` для сессий с `X-FluxProxy-Error: upstream-response-timeout` отображается информационный баннер с кнопкой перехода к настройкам таймаутов.
- **Request Composer / Replay: per-request таймаут и ручная отмена (`composer_exec.rs`, `ComposerPanel.tsx`):**
  - В `ComposedRequest` (`models.rs`, `src/types/proxy.ts`) добавлено опциональное поле `timeoutSec?: number` для разового переопределения таймаута.
  - В `ProxyEngineController` добавлен реестр активных запросов Composer (`DashMap` с каналом отмены) и Tauri-команда `cancel_composed_request`; в `ComposerPanel.tsx` во время выполнения отображается кнопка `Cancel`, фиксирующая отменённый запрос со статусом `499`.
- **Tauri IPC, Настройки UI и совместимость `FluxUserSettingsProfile`:**
  - Новые Tauri-команды `get_upstream_timeouts` и `set_upstream_timeouts` (с fallback-реализацией в `src/lib/tauriBridge.ts` для Browser Preview).
  - В `FluxUserProxySettings` (`src/types/settings.ts`) добавлено опциональное поле `upstreamTimeouts?: UpstreamTimeoutConfig`, проведённое через все 7 точек регистрации в `src/lib/settingsManager.ts` и `src/App.tsx` с обратной совместимостью при импорте старых профилей `schemaVersion: 1`.
  - В `src/components/settings/GeneralSettingsTab.tsx` добавлена секция **Upstream Timeouts** с быстрыми пресетами для ожидания ответа сервера (`Unlimited (Recommended)`, `30 s`, `60 s`, `120 s`, `300 s`, `Custom`), полями для Connect / Response Headers / Composer timeouts и предупреждением, если `responseHeaderTimeoutSec` задан в интервале `1..29` с.
- **Тесты:**
  - Интеграционные Rust-тесты в `src-tauri/src/proxy/server/mod.rs` и `upstream_client.rs`:
    1) медленный сервер с задержкой дольше порога при `responseHeaderTimeoutSec == 0` возвращает реальный ответ `500` с JSON-ошибкой целиком без подмены на `504`;
    2) при конечном `responseHeaderTimeoutSec = 1` прокси возвращает `504` с заголовком `X-FluxProxy-Error: upstream-response-timeout`;
    3) закрытие сокета клиентом во время ожидания ответа финализирует in-flight сессию в `TrafficStore` со статусом `499` через `InFlightSessionGuard`;
    4) `connectTimeoutSec` корректно прерывает зависшее TCP/TLS-подключение и прямой `CONNECT`-туннель.
  - Unit-тесты в `src/lib/settingsManager.test.ts` на дефолтные значения, валидацию границ и миграцию профилей без `upstreamTimeouts`.

### 📝 Промпт для Antigravity (Этап 39)

```markdown
Роль: Principal Rust Network Systems & Full-Stack Engineer (Tauri v2 + Hyper + Tokio + React 19).
Проект: FluxProxy (Tauri v2 + Rust + React 19).

Задача: Выполнить Этап 39 из ROADMAP.md — разделить жёсткий 15-секундный таймаут на настраиваемые `connectTimeoutSec` и `responseHeaderTimeoutSec` (по умолчанию `0` = Unlimited для прозрачного ожидания реальных ответов и ошибок медленных серверов), добавить `composerTimeoutSec` + ручную отмену, RAII-гард `InFlightSessionGuard` (`499`) и маркерный заголовок `X-FluxProxy-Error`.

1. Модель конфигурации и хранилище (`src-tauri/src/models.rs`, `src-tauri/src/proxy/sysproxy.rs`, `src-tauri/src/proxy/server/mod.rs`):
   - Добавить структуру `UpstreamTimeoutConfig` (`connect_timeout_sec: u64`, `response_header_timeout_sec: u64`, `composer_timeout_sec: u64`) с дефолтами `15`, `0` (`Unlimited`) и `120`, а также метод нормализации/валидации границ (`connect: 1..=300`, `response_header: 0 | 5..=3600`, `composer: 0 | 1..=3600`).
   - Сохранять и загружать `UpstreamTimeoutConfig` в `app_data_dir` (аналогично `proxy_port.pref` / `bind_config.pref`).
   - В `SharedProxyContext` заменить `upstream_timeout_sec: u64` на атомарные `Arc<AtomicU64>` (connect, response_header, composer), чтобы изменения применялись без перезапуска прокси и сброса connection pool (сохранив компиляцию старого `reqwest`-хелпера в `http_handler.rs:92` до Этапа 36).

2. Разделение Connect Deadline и Response Header (TTFB) Timeout (`src-tauri/src/proxy/upstream_client.rs`, `src-tauri/src/proxy/client_certs.rs`, `src-tauri/src/proxy/server/connect_tunnel.rs`, `src-tauri/src/proxy/server/websocket_relay.rs`):
   - В `InstrumentedConnector` передавать `Arc<AtomicU64>` для `connect_timeout_sec`; внутри `call()` отслеживать единый `connect_deadline` на всю цепочку DNS → TCP → Upstream Proxy → TLS handshake и возвращать `UpstreamClientError::Connect` с точным описанием зависшего этапа.
   - В `connect_tunnel.rs` ограничить `connect_timeout_sec` также прямой DNS lookup и `TcpStream::connect`; в `websocket_relay.rs` использовать `connect_timeout_sec`.
   - В `UpstreamHttpClient::send_request`, `send_with_idempotent_retry` и `send_following_redirects` заменить `timeout: Duration` на `response_timeout: Option<Duration>`: при `None` (`0`) выполнять `self.client.request(req).await` без искусственного TTFB-таймера (под защитой connect timeout в коннекторе), при `Some(dur)` оборачивать в `tokio::time::timeout` и возвращать `UpstreamClientError::Timeout` с информативным текстом фазы TTFB.

3. RAII-гард `InFlightSessionGuard` (499) и диагностика `X-FluxProxy-Error` (`src-tauri/src/proxy/server/http_handler.rs`, `src-tauri/src/proxy/server/mod.rs`):
   - Добавить `InFlightSessionGuard`: сразу после `record_in_flight_session_with_remap` создавать гард, который снимается (`disarm()`) после записи ответа/ошибки или старта стриминга; при `Drop` без `disarm` (обрыв клиента в ожидании upstream) завершать сессию в `TrafficStore` со статусом `499`, реальным `duration_ms`, ошибкой `"Client closed connection while waiting for upstream response"` и отправкой события в `event_tx`.
   - При возврате синтетических прокси-ошибок (`UpstreamClientError::Timeout` / `Connect` / `Transport`) прикреплять заголовок `X-FluxProxy-Error` (`upstream-response-timeout`, `upstream-connect-timeout`, `upstream-connect-error`) в `plain_response` и в `SessionDetail.response_headers`.

4. Composer / Replay таймаут и кнопка Cancel (`src-tauri/src/models.rs`, `src-tauri/src/proxy/server/composer_exec.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/components/ComposerPanel.tsx`):
   - Добавить опциональные `request_id` и `timeout_sec` в `ComposedRequest`; в `composer_exec.rs` использовать `request.timeout_sec` или `composer_timeout_sec` (`0` = `None`) и отслеживать активный запрос через канал отмены (`cancel_composed_request`), завершая отменённый запрос со статусом `499`.
   - В `ComposerPanel.tsx` добавить кнопку `Cancel` во время выполнения запроса и опцию выбора таймаута.

5. IPC, настройки, инспектор и профиль (`src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/types/proxy.ts`, `src/types/settings.ts`, `src/lib/tauriBridge.ts`, `src/lib/settingsManager.ts`, `src/components/settings/GeneralSettingsTab.tsx`, `src/components/SessionInspector.tsx`, `src/App.tsx`):
   - Зарегистрировать `get_upstream_timeouts` и `set_upstream_timeouts` в Tauri и в fallback `tauriBridge.ts`.
   - Добавить опциональное поле `upstreamTimeouts?: UpstreamTimeoutConfig` в `FluxUserProxySettings` (во все 7 точек регистрации `settingsManager.ts` + `App.tsx`) с безопасными дефолтами для старых профилей `schemaVersion: 1`.
   - В `GeneralSettingsTab.tsx` добавить секцию «Upstream Timeouts» (пресеты `Unlimited (Recommended)`, `30 s`, `60 s`, `120 s`, `300 s`, `Custom`, поля Connect / Response Headers / Composer timeouts и предупреждение при TTFB `< 30` с).
   - В `SessionInspector.tsx` для ответов с `X-FluxProxy-Error: upstream-response-timeout` показывать понятный баннер с кнопкой перехода к настройкам таймаутов.

6. Тесты (`src-tauri/src/proxy/server/mod.rs`, `src-tauri/src/proxy/upstream_client.rs`, `src/lib/settingsManager.test.ts`):
   - Rust: проверка сквозного получения реального ответа `500` от медленного сервера при `responseHeaderTimeoutSec = 0`, возврат `504` + `X-FluxProxy-Error` при конечном таймауте, финализация `499` через `InFlightSessionGuard` при обрыве клиента и срабатывание `connectTimeoutSec`.
   - Vitest: проверка дефолтов, валидации границ и миграции `upstreamTimeouts` в `settingsManager.test.ts`.

Проверка: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 36: Защита ключей mTLS (DPAPI / In-Memory), LAN Client Allowlist, чистота Zustand-сторов, очистка техдолга и синхронизация документации
**Приоритет: P1 / P2 (Security, State & Hygiene) | Спринт 6 | Зависимости: Этапы 11 ✅, 18 ✅, 35 | Находки аудита: `CONC-01`, `SEC-02`, `SEC-03`, `PERF-03`, `ARCH-01`, `ARCH-02` + Решения №2, №4 + Doc Sync**

### Цель и контекст
Этап закрывает оставшиеся находки безопасности, управления состоянием React/Zustand, архитектурного техдолга и синхронизации документации из аудита `v0.5.0`:
1. **`[SEC-03]` & Решение №2 (Открытое хранение приватных ключей mTLS и Root CA на диске в Windows):** при импорте защищённого паролем сертификата `.p12`/`.pfx` функция `write_bytes_securely` (`src-tauri/src/proxy/client_certs.rs:289-330`) сохраняет расшифрованный приватный ключ в открытый `{id}.identity.pem` без шифрования Windows DPAPI и без режима `Session-only (In-Memory)`.
2. **Решение №4 (Контроль доступа `LAN Client Allowlist` в режимах `0.0.0.0` и `Specific`):** при мобильной отладке в офисных или публичных Wi-Fi сетях разработчику нужен опциональный белый список разрешённых IP/подсетей клиентских устройств (`lanClientAllowlist`).
3. **`[SEC-02]` Генерация `data:image/svg+xml;base64,...` в `MultipartInspectorPanel`:** `parseMultipartBody` (`src/lib/protocolInspectors.ts:443-446, 572-578`) формирует `imageDataUrl` для любого `sniffedMime.startsWith("image/")` (включая `image/svg+xml`), обходя белый список `SAFE_RASTER_IMAGE_MIMES` из `SessionInspector.tsx:43-50`.
4. **`[CONC-01]` & `[PERF-03]` Синхронный `syncFromLocalStorage()` в рендере хуков и $O(N)$ аллокации в React:**
   - `useProxySessions.ts:71-78`, `useUiPreferences.ts:48-52` и `useTheme.ts:30-34` синхронно вызывают Zustand `set(...)` прямо внутри тела рендера, а `useProxyStore.syncFromLocalStorage()` (`src/stores/proxyStore.ts:741-743`) вызывает `set(readInitialProxySlice())`, который при любом повторном маунте хука стирает `sessions: []`, `selectedId: null`, `selectedDetail: null` и `pausedBreakpoints: []`;
   - `selectedSessions` в `src/App.tsx:2901-2907` на каждый входящий батч трафика строит `new Map(sessions.map((s) => [s.id, s]))` на 10 000 элементов даже при одной выбранной строке.
5. **`[ARCH-01]` & `[ARCH-02]` Мёртвый код `reqwest` в Rust и монолитный `BrowserPreviewEngine` в `tauriBridge.ts`:**
   - в `http_handler.rs:78-120, 233-309`, `client_certs.rs:597, 1002-1051` и `hosts.rs:315-358` остались неиспользуемые билдеры, кэш `moka` и `impl reqwest::dns::Resolve` от старого транспорта `reqwest`;
   - `src/lib/tauriBridge.ts` (4201 строка) содержит внутри себя 3200 строк `BrowserPreviewEngine`, а `src/App.tsx` (4254 строки) — монолитный блок глобальных шорткатов и определений команд палитры.
6. **Расхождения документации и кода (`Doc-vs-Code Sync`):** приведение `README.md`, `USER_GUIDE.md`, `PYTHON_SCRIPTING_GUIDE.md` и `ROADMAP.md` в полное соответствие с кодом после выполнения Этапов 35 и 36.

### Критерии приемки (DoD)
- **`[SEC-03]` & Решение №2:**
  - На Windows (`#[cfg(target_os = "windows")]`) запись приватных ключей в `client_certs.rs` и `ca.rs` шифрует байты через Win32 DPAPI (`CryptProtectData` / `CryptUnprotectData` из `windows-sys` с `CRYPTPROTECT_UI_FORBIDDEN`) с префиксом `FLUX_DPAPI_V1:`; чтение прозрачно поддерживает как `FLUX_DPAPI_V1:`, так и ранее созданные plain-PEM файлы (автоматически мигрируя их в DPAPI при загрузке).
  - В `AddClientCertificateInput` и `ClientCertificateEntry` (`models.rs`, `src/types/proxy.ts`) добавлено поле `ephemeral?: boolean` (по умолчанию `false`); при `ephemeral == true` сертификат хранится только в in-memory структурах `ClientCertificateStore` без записи `.identity.pem` на диск и без сохранения в `index.json`, а в `src/components/ClientCertificatesModal.tsx` добавлен чекбокс *«Session-only (In-Memory, do not save to disk)»* и бейдж `RAM ONLY`.
- **Решение №4 (`LAN Client Allowlist`):**
  - В `ProxyFilterBackendConfig` (`models.rs`, `proxy.ts`) и `FluxUserProxySettings` (`settings.ts`, `settingsManager.ts`) добавлено опциональное поле `lanClientAllowlist?: string[]` (по умолчанию `[]`).
  - В `ProxyFilterEngine` (`src-tauri/src/proxy/filters/mod.rs`) предкомпилируются IP-адреса и CIDR-подсети (`IpNet` / маски) из `lan_client_allowlist`; метод `is_lan_client_allowed(&self, peer_ip: IpAddr) -> bool` всегда разрешает loopback, разрешает всех при пустом списке и проверяет попадание в список при непустом `lan_client_allowlist`.
  - В `connect_tunnel.rs` и `http_handler.rs` неразрешённые LAN-клиенты отклоняются с `403 Forbidden` без записи в `TrafficStore`; в `src/components/MobileSetupModal.tsx` и контекстное меню `TrafficGrid.tsx` добавлено управление списком разрешённых IP устройств.
- **`[SEC-02]`:** В `src/lib/protocolInspectors.ts:443-446` `imageDataUrl` создаётся только если базовый MIME входит в `SAFE_RASTER_IMAGE_MIMES` (`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/bmp`, `image/x-icon`); для `image/svg+xml` в Multipart отображается текстовый предпросмотр.
- **`[CONC-01]` & `[PERF-03]`:**
  - В `src/stores/proxyStore.ts` метод `syncFromLocalStorage()` обновляет только персистентные поля настроек из `localStorage`, **сохраняя** текущие `sessions`, `selectedId`, `selectedIds`, `selectedDetail`, `diffLeftDetail`, `diffRightDetail`, `pausedBreakpoints` и `storageStats`.
  - В `src/App.tsx:2901-2907` для `selectedIds.length <= 2` поиск в `sessions` выполняется без создания `new Map(sessions.map(...))` на 10 000 элементов.
- **`[ARCH-01]` & `[ARCH-02]`:**
  - Из `http_handler.rs`, `client_certs.rs` и `hosts.rs` удалены мёртвые функции и кэши `reqwest::Client` (`build_upstream_client*`, `client_cache`, `impl reqwest::dns::Resolve`).
  - Класс `BrowserPreviewEngine` и его вспомогательные функции вынесены из `src/lib/tauriBridge.ts` в `src/lib/previewEngine.ts` (размер `tauriBridge.ts` сокращён до `< 1000` строк); глобальные шорткаты вынесены из `src/App.tsx` в `src/hooks/useGlobalShortcuts.ts`.
- **Синхронизация документации:** обновлены описания в `README.md`, `USER_GUIDE.md` и `PYTHON_SCRIPTING_GUIDE.md`.

### 📝 Промпт для Antigravity (Этап 36)

```markdown
Роль: Principal Security & Full-Stack Architect (Rust + Win32 DPAPI + React 19 + Zustand 5).
Проект: FluxProxy (Tauri v2 + Rust + React 19).

Задача: Выполнить Этап 36 из ROADMAP.md — реализовать защиту ключей mTLS (DPAPI + режим In-Memory), LAN Client Allowlist, устранить дефекты Zustand/React (`CONC-01`, `SEC-02`, `PERF-03`), очистить техдолг (`ARCH-01`, `ARCH-02`) и синхронизировать документацию.

1. Защита приватных ключей на диске и режим Session-only (`[SEC-03]`, Решение №2, `src-tauri/Cargo.toml`, `src-tauri/src/proxy/client_certs.rs`, `src-tauri/src/proxy/ca.rs`, `src-tauri/src/models.rs`, `src/types/proxy.ts`, `src/components/ClientCertificatesModal.tsx`):
   - На Windows (`#[cfg(target_os = "windows")]`) с помощью `windows-sys` (`Win32_Security_Cryptography`: `CryptProtectData` / `CryptUnprotectData`, флаг `CRYPTPROTECT_UI_FORBIDDEN`) шифровать приватные ключи при записи на диск с префиксом `FLUX_DPAPI_V1:<base64>`. При чтении прозрачно расшифровывать `FLUX_DPAPI_V1:`, а если файл начинается с `-----BEGIN`, читать его как plain PEM и мигрировать в DPAPI.
   - Добавить флаг `ephemeral: bool` (`#[serde(default)]`) в `AddClientCertificateInput` и `ClientCertificateEntry` (`models.rs`, `proxy.ts`). При `ephemeral == true` хранить распарсенный `CertifiedKey` и метаданные только в RAM в `ClientCertificateStore` (не записывая `.identity.pem` на диск и не сохраняя запись в `index.json`). В `ClientCertificatesModal.tsx` добавить чекбокс «Session-only (In-Memory, do not save key to disk)» и бейдж `RAM ONLY`.

2. Белый список LAN-устройств (`LAN Client Allowlist`, Решение №4, `src-tauri/src/models.rs`, `src-tauri/src/proxy/filters/mod.rs`, `src-tauri/src/proxy/server/connect_tunnel.rs`, `http_handler.rs`, `src/types/proxy.ts`, `src/types/settings.ts`, `src/lib/settingsManager.ts`, `src/components/MobileSetupModal.tsx`, `src/components/TrafficGrid.tsx`):
   - Добавить `lan_client_allowlist: Vec<String>` (`#[serde(default)]`) в `ProxyFilterBackendConfig` и `lanClientAllowlist?: string[]` в `FluxUserProxySettings` (провести через все 7 точек `settingsManager.ts`).
   - В `ProxyFilterEngine` предкомпилировать IP и CIDR-маски из `lan_client_allowlist` и реализовать `is_lan_client_allowed(&self, peer_ip: IpAddr) -> bool` (loopback всегда `true`; если список пуст — `true`; иначе проверка совпадения IP/CIDR).
   - В `connect_tunnel.rs` и `http_handler.rs` при `!ctx.filters.is_lan_client_allowed(peer_addr.ip())` возвращать `403 Forbidden` до создания сессии в `TrafficStore`. Добавить поле ввода списка разрешённых IP в `MobileSetupModal.tsx` и быстрый пункт в контекстное меню `TrafficGrid.tsx` для внешних `clientIp`.

3. Безопасность Multipart, чистота Zustand и оптимизация React (`[SEC-02]`, `[CONC-01]`, `[PERF-03]`, `src/lib/protocolInspectors.ts`, `src/stores/proxyStore.ts`, `src/hooks/useProxySessions.ts`, `src/App.tsx`):
   - В `src/lib/protocolInspectors.ts:443-446` формировать `imageDataUrl` только для MIME из белого списка `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/bmp`, `image/x-icon` (исключив `image/svg+xml`).
   - В `src/stores/proxyStore.ts` изменить `syncFromLocalStorage()` так, чтобы он обновлял только персистентные конфигурационные поля из `localStorage`, не сбрасывая `sessions`, `selectedId`, `selectedIds`, `selectedDetail`, `diffLeftDetail`, `diffRightDetail`, `pausedBreakpoints` и `storageStats`.
   - В `src/App.tsx:2901-2907` оптимизировать `selectedSessions`: при `selectedIds.length === 0` возвращать `[]`, при `selectedIds.length <= 2` находить элементы через `sessions.find(...)` без аллокации `new Map(sessions.map(...))` на 10 000 элементов.

4. Очистка мёртвого кода `reqwest` и декомпозиция фронтенда (`[ARCH-01]`, `[ARCH-02]`, `src-tauri/src/proxy/server/http_handler.rs`, `src-tauri/src/proxy/client_certs.rs`, `src-tauri/src/proxy/hosts.rs`, `src/lib/tauriBridge.ts`, `src/lib/previewEngine.ts`, `src/App.tsx`, `src/hooks/useGlobalShortcuts.ts`):
   - Удалить неиспользуемые функции `build_upstream_client*` из `http_handler.rs`, кэш `client_cache: Cache<String, reqwest::Client>` и `get_or_build_client*` из `client_certs.rs`, а также `impl reqwest::dns::Resolve for HostRemapRegistry` из `hosts.rs`.
   - Вынести `BrowserPreviewEngine` и его вспомогательные функции из `src/lib/tauriBridge.ts` в `src/lib/previewEngine.ts`.
   - Вынести обработчик глобальных горячих клавиш из `src/App.tsx` в хук `src/hooks/useGlobalShortcuts.ts`.

5. Синхронизация документации (`README.md`, `USER_GUIDE.md`, `PYTHON_SCRIPTING_GUIDE.md`):
   - Обновить описания новых возможностей (чекбокс Python-скриптов в Composer, DPAPI / `Session-only` для mTLS, `LAN Client Allowlist`, индикатор `via <proxy>` в `Server IP`) и убедиться в полном соответствии документации фактической кодовой базе.

Проверка: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 37: Исправление UI-багов инспектора (`HexViewer` и `TIMING BREAKDOWN`) и редизайн `Command Palette 2.0`
**Приоритет: P1 (UI Bugfixes & UX Ergonomics) | Спринт 6 | Зависимости: Этапы 22 ✅, 30 ✅, 34 ✅ | Замечания: №1, №2, №5**

### Цель и контекст
По итогам пользовательского UX-аудита выявлены два визуальных дефекта в инспекторе сессий и недостаточная эргономика палитры команд (`Ctrl+K`):
1. **`[UX-01]` Сдвиг байтовых колонок и наложение на `DECODED ASCII` во вкладке `Hex` (`src/components/HexViewer.tsx`):**
   - В липкой шапке (`HexViewer.tsx:47-53`) индексы колонок `00 01 ... 0F` рендерятся единой текстовой строкой со стилями `text-[10px] tracking-wider` внутри `<span className="w-[360px] shrink-0">`.
   - В виртуализированных строках данных (`HexViewer.tsx:90-138`) используется `text-xs` (`12px`, без `tracking-wider`), а каждый из 16 байтов оборачивается в `<span className="inline-block rounded px-0.5">{hex}</span>{" "}` (`+4px` горизонтального padding на каждый байт = `+64px` на строку + 16 пробелов + дополнительный пробел перед `colIdx === 8`).
   - В результате фактическая ширина 16 байтов составляет `~417px`, что: а) прогрессивно смещает байты вправо относительно заголовков `00..0F`, и б) переполняет фиксированный контейнер `w-[360px]` (без `overflow-hidden` при `whitespace-pre`) на `~57px`, из-за чего последние колонки (`0D 0E 0F`) визуально накладываются поверх колонки `Decoded ASCII`.
2. **`[UX-02]` Мелькание подсказки при наведении на легенду `TIMING BREAKDOWN` в статистике запроса (`src/components/SessionStatisticsPanel.tsx`):**
   - В `SessionStatisticsPanel.tsx:630-653` блок тултипа `<div id={activeTooltipId} role="tooltip" className="mt-2 flex ...">` рендерится условно (`{hoveredPhase && ...}`) **в обычном потоке документа** непосредственно над блоком легенды (`Phase Legend`, строки `656-686`).
   - Элементы самой легенды (`строки 657-685`) сделаны кнопками с `onMouseEnter={() => setHoveredPhase(phase)}` и `onMouseLeave`. При наведении курсора на элемент легенды появление тултипа в потоке документа сдвигает легенду вниз на `~36px`; кнопка легенды выскальзывает из-под неподвижного курсора мыши, браузер мгновенно генерирует `onMouseLeave` → `setHoveredPhase(null)` → тултип исчезает, возвращая легенду обратно под курсор, что вызывает бесконечное мелькание.
   - По требованию пользователя подсказка **не должна мелькать и должна отображаться только при наведении на сам таймлайн** (полосу `Timing Breakdown`), а не на легенду.
3. **`[UX-05]` Мелкий размер и перегруженность `Command Palette` (`src/components/CommandPalette.tsx`, `src/App.tsx`):**
   - Текущее окно палитры команд (`max-w-xl` / `576px`, список `max-h-80` / `320px`, мелкий шрифт `text-xs`) выводит 60+ команд единым плоским негруппированным списком без описаний, без индикации текущего состояния переключателей (`ON`/`OFF`, активный пресет троттлинга, порт), без фильтра по категориям и без наглядных подсказок по специальным QuickExec-командам (`bpu`, `bpafter`, `jwt`).

### Критерии приемки (DoD)
- **`[UX-01]` (`src/components/HexViewer.tsx`):**
  - Шапка колонок `00..0F` и байтовые ячейки в виртуализированных строках рендерятся через единую детерминированную геометрию ячеек (`COL_INDICES.map`): каждая из 16 колонок и в шапке, и в строках имеет строго одинаковую фиксированную ширину `w-6 text-center font-mono text-xs tabular-nums` (без рассинхронизирующего `tracking-wider` в шапке и без хрупких текстовых пробелов `" "`), с визуальным разделителем октетов `ml-2` перед `colIdx === 8` (`00..07` и `08..0F`).
  - Контейнер байтового блока в шапке и строках имеет одинаковую детерминированную ширину (`flex w-[392px] shrink-0 items-center`), а символы в колонке `Decoded ASCII` рендерятся фиксированными ячейками `inline-block w-2.5 text-center` (с `ml-1` перед `colIdx === 8`), что полностью исключает смещение колонок и любое наложение на `Decoded ASCII`.
- **`[UX-02]` (`src/components/SessionStatisticsPanel.tsx`):**
  - Из элементов `Phase Legend` (`строки 656-686`) полностью удалены обработчики `onMouseEnter`, `onMouseLeave`, `onFocus`, `onBlur` (элементы легенды преобразованы в статические информационные бейджи `<div>`/`<span>`): наведение на легенду больше не вызывает показ или мелькание тултипа.
  - Тултип `Timing Breakdown` отображается **только** при наведении/фокусе на сегменты самого таймлайна (`role="group"` полосы фаз) и позиционируется как плавающий оверлей (`absolute left-0 right-0 top-full z-20 mt-1.5 pointer-events-none`) без сдвига вёрстки (`layout shift`) легенды и карточек `Actual Performance` под таймлайном.
- **`[UX-05]` (`src/components/CommandPalette.tsx`, `src/App.tsx`):**
  - Размер окна `CommandPalette` увеличен до `max-w-3xl` (`w-[min(92vw,820px)]`), высота списка — до `max-h-[62vh]` (`~520px`), поле поиска увеличено до `h-12 text-base px-4`, строки команд получили просторные отступы `px-3.5 py-2.5`.
  - Интерфейс `PaletteCommand` расширен опциональными полями `description?: string` (понятное однострочное пояснение назначения команды) и `statusBadge?: string` (текущее живое состояние: `Активно`, `ON` / `OFF`, `:8888`, `Fast 3G`, `Targeted (N)`).
  - Команды визуально сгруппированы по понятным смысловым секциям с липкими заголовками категорий (*Быстрые команды QuickExec*, *Захват и Управление сессиями*, *Сеть, Троттлинг и Маршрутизация*, *Фильтрация и HTTPS MITM*, *Инструменты и Экспорт*, *Настройки и Внешний вид*).
  - Под строкой поиска добавлены интерактивные пилюли фильтрации по категориям (`Все`, `Захват`, `Сеть и Троттлинг`, `Фильтры и TLS`, `Инструменты`, `Настройки`) и кликабельные чипы-подсказки синтаксиса QuickExec (`bpu /api`, `bpafter /graphql`, `jwt <токен>`, `doctor`, `mtls`), а внизу окна — строка подсказок клавиатурной навигации (`↑↓ Навигация`, `Enter Выполнить`, `Tab Категория`, `Esc Закрыть`, счётчик найденных команд).

### 📝 Промпт для Antigravity (Этап 37)

```markdown
Роль: Senior Frontend & UI/UX Engineer (React 19 + TypeScript + Tailwind CSS).
Проект: FluxProxy (Tauri v2 + Rust + React 19).

Задача: Выполнить Этап 37 из ROADMAP.md — исправить сдвиг колонок и наложение на Decoded ASCII в `HexViewer.tsx`, устранить мелькание тултипа легенды `TIMING BREAKDOWN` в `SessionStatisticsPanel.tsx` и провести редизайн `CommandPalette.tsx` (Command Palette 2.0).

1. Точная сетка колонок во вкладке Hex (`[UX-01]`, `src/components/HexViewer.tsx`):
   - В липкой шапке (`HexViewer.tsx:47-53`) и в виртуализированных строках (`HexViewer.tsx:90-138`) заменить `w-[360px]` и текстовую строку `"00 01 ... 0F"` на единый flex-контейнер `flex w-[392px] shrink-0 items-center tabular-nums`.
   - Рендерить заголовки `00`..`0F` в шапке через `COL_INDICES.map((colIdx) => ...)` с теми же размерами ячейки `inline-flex h-5 w-6 shrink-0 items-center justify-center font-mono text-xs` и разделителем октетов `colIdx === 8 ? "ml-2" : ""`, что и байтовые ячейки в строках данных.
   - В колонке `Decoded ASCII` рендерить каждый из 16 символов в фиксированной ячейке `inline-block w-2.5 text-center` (с `ml-1` при `colIdx === 8`), чтобы исключить любое переполнение и наложение байтов на ASCII.

2. Тултип TIMING BREAKDOWN только на таймлайне без мелькания и layout shift (`[UX-02]`, `src/components/SessionStatisticsPanel.tsx`):
   - В блоке `Phase Legend` (`SessionStatisticsPanel.tsx:656-686`) заменить `<button>` с `onMouseEnter`/`onMouseLeave`/`onFocus`/`onBlur` на статические элементы `<div>`/`<span>` (с подсветкой `hoveredPhase?.key === phase.key` при наведении на сам таймлайн), чтобы наведение курсора на легенду никогда не открывало тултип.
   - Позиционировать блок `{hoveredPhase && (<div id={activeTooltipId} role="tooltip" ...>)}` (`строки 630-653`) абсолютно относительно контейнера полосы таймлайна (`pointer-events-none absolute left-0 right-0 top-full z-20 mt-1.5 ...`), чтобы при наведении на сегменты таймлайна тултип всплывал поверх без сдвига легенды и таблиц под ним.

3. Редизайн Command Palette 2.0 (`[UX-05]`, `src/components/CommandPalette.tsx`, `src/App.tsx`):
   - Увеличить размеры диалога до `w-[min(92vw,820px)] max-w-3xl`, поле ввода поиска — до `h-12 text-base`, область результатов — до `max-h-[62vh]`.
   - Расширить `PaletteCommand` полями `description?: string` и `statusBadge?: string`; заполнить описания и живые бейджи состояния для команд в `src/App.tsx` (статус прокси, порт, активный пресет Throttling, режим TLS MITM, число правил HOSTS / AutoResponder / Breakpoints, активная тема).
   - Добавить под строкой поиска переключатель категорий (`Все`, `Захват`, `Сеть и Троттлинг`, `Фильтры и TLS`, `Инструменты`, `Настройки`) и интерактивные чипы быстрых команд (`bpu `, `bpafter `, `jwt `, `doctor`), группировку результатов по категориям с заголовками секций и нижний футер с подсказками клавиш (`↑↓`, `Enter`, `Tab`, `Esc`).

Проверка: `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 38: Единый полноэкранный центр настроек (Unified Fullscreen Settings Hub), реорганизация вкладок, дедупликация панелей и система подсказок
**Приоритет: P1 / P2 (UI Architecture & Discoverability) | Спринт 6 | Зависимости: Этапы 4 ✅, 10 ✅, 11 ✅, 13 ✅, 18 ✅, 22 ✅, 37, 39 | Замечания: №3, №4**

### Цель и контекст
По мере роста функциональности FluxProxy (Этапы 1–34) элементы управления и окна настроек оказались фрагментированы и многократно продублированы по интерфейсу:
1. **Хаотичное распределение функций и низкая обнаружимость (Замечание №3):**
   - Чтобы найти **Bandwidth Throttling**, нужно знать про компактную кнопку с иконкой спидометра на `TopToolbar.tsx:1202` (которая в режиме `compactToolbar` при `preset === "none"` вообще скрывается из интерфейса!), а в общих настройках `SettingsModal` управление троттлингом отсутствует вовсе.
   - Настройки **HOSTS Remapping**, **Upstream Proxy**, **Client Certificates (mTLS)**, **Root CA**, **Mobile Device Setup** и **Proxy Doctor** спрятаны в выпадающих меню `Tools` / `Help` или в меню `•••` и открываются в 7 разных маленьких модальных окнах, никак не связанных с центральным окном `SettingsModal` (`Ctrl+,`).
2. **Фрагментация настроек и «урезанные дубликаты» вместо единой точки входа (Замечания №3.3 и №4):**
   - В `SettingsModal.tsx` вкладки `FiltersSettingsTab.tsx` и `RulesProxySettingsTab.tsx` дублируют функционал `FilterDrawer.tsx` и `AutoResponderPanel.tsx` в урезанном, менее удобном виде и содержат кнопки-костыли (*«Открыть Filter Matrix»*, *«Полный редактор TLS…»*, *«Редактор мутаций заголовков…»*), которые закрывают окно настроек и открывают другое модальное окно (`FilterDrawer`).
   - Внутри самого `SettingsModal` секция привязки сетевых интерфейсов `<BindConfigSection />` рендерится **дважды** (в `GeneralSettingsTab.tsx:234` и в `RulesProxySettingsTab.tsx:79`), а переключатель `Theme: Dark / Light / System` также рендерится **дважды** (в `GeneralSettingsTab.tsx:81-138` и в `UiColumnsSettingsTab.tsx:184-209`).
   - Все модальные окна настроек зажаты в узких рамках (`max-w-xl`..`max-w-4xl`, `h-[84vh] max-h-[760px]`) с внутренними скроллбарами `max-h-36`, хотя в десктопном отладчике их гораздо удобнее открывать **на весь экран**.
3. **Устаревший свитч темы и массовое дублирование кнопок между барами (Замечания №3.1, №3.2, №3.5):**
   - Кнопка переключения темы `Sun`/`Moon` в `Sidebar.tsx:273-284` (и радио-пункты `Dark/Light/System` в `MenuBar.tsx:1659-1685` и `GeneralSettingsTab.tsx:81-138`) потеряла актуальность после появления в настройках галереи из 8 тем-пресетов и редактора палитры.
   - Одни и те же кнопки визуально повторяются в 4–6 местах одновременно:
     - `Connect Mobile Device`: в `Sidebar`, в правой части `TopToolbar`, внутри поповера `SysProxy` на `TopToolbar`, в меню `•••` на `TopToolbar`, в `MenuBar (Tools)` и в `Footer`.
     - `Session Diff` и `TextWizard`: в `Sidebar`, в группе утилит `TopToolbar`, в меню `•••` на `TopToolbar`, в шапке `SessionInspector` и в `MenuBar (Tools)`.
     - `Breakpoints`, `Filters`, `Inspector Dock Position (Bottom/Right)`, `SysProxy`, `Command Palette`, `Drop Non-Matching`, `Customize Toolbar`: дублируются между `Sidebar`, `TopToolbar`, поповерами `Keep`/`Columns`, меню `•••`, `MenuBar`, шапкой `SessionInspector` и `Footer`.
4. **Нехватка поясняющих подсказок (Замечание №3.4):**
   - В выпадающих списках тулбара и в секциях настроек отсутствуют встроенные контекстные подсказки (`?` / описания), объясняющие назначение специфичных прокси-функций (`Drop Non-Matching`, `Targeted Only MITM`, `Strip Alt-Svc`, `Preserve Host/SNI`, `Time Heat`, `Dual Listener`).

### Критерии приемки (DoD)
- **1. Единый полноэкранный центр настроек (`Unified Fullscreen Settings Hub`, `src/components/SettingsModal.tsx` и `src/components/settings/`):**
  - `SettingsModal.tsx` (`Ctrl+,`) переведён в **полноэкранный режим** (`fixed inset-0 h-screen w-screen max-h-none max-w-none m-0 rounded-none border-0`) с удобным боковым меню разделов, строкой быстрого фильтра по настройкам и счётчиками активных правил.
  - Все настройки приложения собраны в **единой точке входа** за счёт прямого встраивания полнофункциональных компонентов вместо урезанных копий и отдельных модалок:
    1. **`general` (Прокси, Интерфейсы и Буфер):** TCP-порт, `Act as System Proxy on startup`, привязка к сетевым адаптерам `BindConfigSection` (**строго в одном месте**, дубликат из `RulesProxySettingsTab` удалён; устаревший блок `Theme` из `GeneralSettingsTab` удалён), `Follow Tail`, лимит `Ring Buffer (Keep)`, `Drop Non-Matching` и управление базой `SQLite (VACUUM / Clear on Exit)`.
    2. **`networkRouting` (Троттлинг, HOSTS, Upstream Proxy и Таймауты):** полноценная панель управления **Bandwidth Throttling & Latency** (пресеты + кастомный профиль `↓/↑ Kbps, RTT ms`), встроенный полный редактор **HOSTS Remapping (Virtual DNS)**, встроенная настройка **Upstream Proxy Chaining (`HTTP/HTTPS/SOCKS5`)** и встроенная секция **Upstream Timeouts** из Этапа 39 (`Connect` / `Response Headers` / `Composer`).
    3. **`tlsCertificates` (HTTPS MITM, Сертификаты и Мобильные устройства):** встроенный менеджер **Root CA Certificate** (статус доверия ОС, установка, экспорт форматов), **полный редактор Selective TLS MITM & Bypass 2.0** (`TlsBypassTab` с 11 Quick-Packs, `Hits: N` и `Table View ↔ Bulk Text Editor` вместо прежнего урезанного списка), встроенное хранилище **Client Certificates (mTLS)** и встроенный мастер **Mobile Device Setup (QR / iOS & Android)**.
    4. **`filters` (Матрица фильтров, Списки хостов, Пороги шума и Заголовки):** встроенные полнофункциональные вкладки `FilterMatrixTab` (матрица условий и пресеты), `HostFiltersTab` (массовый Whitelist/Blacklist доменов), `ThresholdsTab` (`Noise & Time Heat`) и `HeaderMutationsTab` (мутации заголовков и `Force No-Cache`) — отдельный дублирующий диалог `FilterDrawer` упразднён, а все вызовы `openFilterDrawerAt(...)` открывают соответствующую подвкладку в едином полноэкранном `Settings Hub`.
    5. **`uiColumns` (Внешний вид, Темы, Панели и Колонки):** единственная точка управления темой (8 пресетов + режим `Dark / Light / System` + детальный редактор палитры), настройка компоновки панелей, групп тулбара и видимости/ширины колонок `TrafficGrid`.
    6. **`diagnosticsBackup` (Диагностика Proxy Doctor и Профили настроек):** встроенная панель самодиагностики **Proxy Doctor** (6 проверок + 1-click fix) и управление профилем `FluxUserSettingsProfile` (`schemaVersion: 1`, экспорт/импорт JSON, сброс к дефолтам).
  - Все триггеры настроек из `TopToolbar`, `MenuBar`, `Sidebar`, `Footer`, контекстного меню и `CommandPalette` (`Ctrl+,`, `Alt+4`, `Ctrl+Shift+H`, `Ctrl+Shift+U`, `Ctrl+Shift+C`, `Ctrl+Shift+M`, `Ctrl+Shift+D`) открывают **единый полноэкранный Settings Hub** на нужном разделе (`openPreferencesAt(tab, subTab)`), без открытия разрозненных маленьких окон.
- **2. Полноэкранный режим для всех остальных модальных окон инструментов (Замечание №4):**
  - Инструментальные модальные окна (`BreakpointModal.tsx`, `TextWizardModal.tsx`, `SessionDiffView.tsx` в модальном режиме, `OpenApiExportModal.tsx`, `SanitizedExportModal.tsx`, `CodeSnippetModal.tsx`, `ShortcutsModal.tsx`) переведены на полноэкранный контейнер (`h-screen w-screen max-h-none max-w-none m-0 rounded-none border-0`). Компактными оставлены только диалоги подтверждения деструктивных действий (`Purge SQLite`, `Reset Settings`) и поповер аннотации сессии (`SessionAnnotationModal`).
- **3. Переработка системы вкладок, удаление свитча темы и устранение дублирования кнопок (Замечания №3.1, №3.2, №3.5):**
  - **`Sidebar.tsx` (Левая панель рабочих вкладок):**
    - Полностью удалена неактуальная кнопка переключения темы `Sun`/`Moon` (`onToggleTheme`).
    - Из `Sidebar` удалены дублирующие кнопки вызова модалок (`FilterDrawer`, `Session Diff`, `Mobile Setup`, `Root CA Certificates`, `Command Palette`).
    - В `Sidebar` оставлены только чётко структурированные **рабочие вкладки и инструменты** с иконками, бейджами активности и понятными тултипами: `Traffic` (`Alt+1`), `Composer` (`Alt+2`), `AutoResponder` (`Alt+3`), `Python Scripts` (`Alt+5`), `Breakpoints` (`F11`) и `TextWizard` (`Ctrl+E`), а внизу — единая кнопка **Settings Hub (`Ctrl+,`)** и кнопка сворачивания панели (`Ctrl+B`).
  - **`TopToolbar.tsx` (Верхняя панель управления захватом и сетью):**
    - Селектор **Throttling** (`Gauge` + текстовая метка `Throttle: Off` или имя активного пресета) всегда виден в сетевой группе тулбара рядом с `SysProxy` и `HTTPS MITM`, обеспечивая мгновенную обнаружимость троттлинга.
    - Рядом добавлена компактная кнопка-индикатор сетевых правил (`Routing / Certs`), отображающая число активных правил `HOSTS Remapping` / `Upstream Proxy` / `mTLS` и открывающая вкладку `Network & Routing` в едином центре настроек.
    - Из `TopToolbar` удалены дублирующие элементы: кнопка `Mobile Setup` справа (`строки 1586-1605`) и внутри поповера `SysProxy` (`строки 1032-1042`), группа дублирующих иконок `Session Diff / Hex / TextWizard / Save SQLite` (`строки 1607-1660`), переключатели докинга инспектора `PanelBottom / PanelRight` (`строки 1690-1739` — они находятся непосредственно в шапке `SessionInspector`), дублирующий пункт `Drop Non-Matching` внутри меню `Keep` (`строки 902-912`), блок `Customize Toolbar` внутри поповера `Columns` (`строки 1821-1862`) и перегруженное меню переполнения `•••` на 20 дублирующих пунктов (`строки 1867-2104`).
  - **`MenuBar.tsx` и `SessionInspector.tsx`:**
    - Из правой части `MenuBar.tsx` удалён дублирующий переключатель `SysProxy: ON/OFF` (`строки 2019-2037`, оставлен счётчик сессий и кнопка `Command Palette Ctrl+K`), а из меню `View` удалены 3 радио-кнопки `Theme: Dark / Light / System` в пользу единого пункта `Theme Presets & Appearance…`.
    - Из шапки `SessionInspector.tsx` удалена дублирующая кнопка `Wizard` (`строки 948-958`, так как контекстная кнопка декодирования уже есть во вкладке `Auth`).
- **4. Система контекстных подсказок в настройках и выпадающих списках (Замечание №3.4):**
  - Добавлен переиспользуемый компонент `src/components/ui/HelpTooltip.tsx` (иконка `?` с доступным поповером по наведению/фокусу и кратким практическим примером) и снабжены пояснениями все пункты в выпадающих списках `TopToolbar` (`Keep`, `SysProxy`, `Selective MITM`, `Bandwidth Throttling`, `Columns`) и все секции единого центра настроек.

### 📝 Промпт для Antigravity (Этап 38)

```markdown
Роль: Principal UI/UX Architect & Senior React/TypeScript Engineer (React 19 + Zustand 5 + Tailwind CSS).
Проект: FluxProxy (Tauri v2 + Rust + React 19).

Задача: Выполнить Этап 38 из ROADMAP.md — объединить все разрозненные настройки приложения в единый полноэкранный центр управления (Unified Fullscreen Settings Hub), перевести модальные окна в полноэкранный режим, убрать устаревший свитч темы и дублирование кнопок между панелями, сделать Throttling и сетевые функции наглядными и добавить систему контекстных подсказок.

1. Единый полноэкранный центр настроек (`src/components/SettingsModal.tsx`, `src/components/settings/`, `src/types/settings.ts`, `src/App.tsx`):
   - Перевести `SettingsModal.tsx` в полноэкранный режим (`fixed inset-0 h-screen w-screen max-h-none max-w-none m-0 rounded-none border-0`) с боковой навигацией по 6 разделам и поиском по настройкам:
     1) `general` (Proxy, Interfaces & Storage): порт, автопривязка SysProxy, единственный экземпляр `BindConfigSection`, `Follow Tail`, `Ring Buffer (Keep)`, `Drop Non-Matching`, `SQLite Archive (VACUUM / Clear on Exit)`. Удалить из `GeneralSettingsTab.tsx` дублирующий блок выбора темы `Dark/Light/System`.
     2) `networkRouting` (Throttling, HOSTS, Upstream Proxy & Timeouts): встроить полноценное управление `Bandwidth Throttling & Latency` (пресеты + Custom `↓/↑ Kbps, RTT ms`), полный редактор `HOSTS Remapping`, форму `Upstream Proxy Chaining (HTTP/HTTPS/SOCKS5)` и секцию `Upstream Timeouts` из Этапа 39.
     3) `tlsCertificates` (HTTPS MITM, Certificates & Mobile): встроить полный редактор `TlsBypassTab` (Selective MITM, 11 Quick-Packs, Bulk Editor, Hit Counters), управление `Root CA Certificate`, хранилище `Client Certificates (mTLS)` и `Mobile Device Setup (QR / iOS & Android)`.
     4) `filters` (Filter Matrix, Hosts List, Thresholds & Headers): встроить полные вкладки `FilterMatrixTab`, `HostFiltersTab`, `ThresholdsTab` и `HeaderMutationsTab` напрямую (заменив урезанные списки из старых `FiltersSettingsTab`/`RulesProxySettingsTab` и отдельный диалог `FilterDrawer`).
     5) `uiColumns` (Appearance, Themes, Layout & Columns): галерея из 8 тем-пресетов + базовая схема `Dark/Light/System` + редактор палитры, компоновка панелей, группы тулбара и колонки `TrafficGrid`.
     6) `diagnosticsBackup` (Proxy Doctor & Settings Profile): встроенная панель самопроверки `Proxy Doctor` и экспорт/импорт/сброс `FluxUserSettingsProfile (schemaVersion: 1)`.
   - Направить все вызовы настроек из `TopToolbar`, `MenuBar`, `Sidebar`, `Footer` и `CommandPalette` в единый `SettingsModal` с переходом на нужную вкладку/подвкладку.

2. Полноэкранный режим для инструментальных модальных окон:
   - Перевести `BreakpointModal.tsx`, `TextWizardModal.tsx`, `SessionDiffView.tsx` (modal), `OpenApiExportModal.tsx`, `SanitizedExportModal.tsx`, `CodeSnippetModal.tsx` и `ShortcutsModal.tsx` на полноэкранный контейнер (`h-screen w-screen max-h-none max-w-none m-0 rounded-none border-0`).

3. Реорганизация навигации и устранение дублирования кнопок (`src/components/Sidebar.tsx`, `src/components/TopToolbar.tsx`, `src/components/MenuBar.tsx`, `src/components/SessionInspector.tsx`):
   - В `Sidebar.tsx`: удалить кнопку свитча темы (`Sun`/`Moon`), удалить дублирующие кнопки `FilterDrawer`, `Session Diff`, `Mobile Setup`, `Root CA`, `Command Palette`; оставить рабочие секции `Traffic (Alt+1)`, `Composer (Alt+2)`, `AutoResponder (Alt+3)`, `Python Scripts (Alt+5)`, `Breakpoints (F11)`, `TextWizard (Ctrl+E)` и внизу кнопку `Settings (Ctrl+,)` + `Collapse Sidebar (Ctrl+B)`.
   - В `TopToolbar.tsx`: сделать селектор `Throttling` (`Throttle: Off / Fast 3G / ...`) всегда видимым и подписанным в сетевой группе; удалить дублирующие кнопки `Mobile Setup`, `Session Diff`, `Hex`, `TextWizard`, `Save SQLite`, переключатели докинга инспектора `PanelBottom`/`PanelRight`, дубликат `Drop Non-Matching` в меню `Keep`, дубликат `Customize Toolbar` в поповере `Columns` и меню переполнения `•••`.
   - В `MenuBar.tsx`: удалить дублирующий индикатор `SysProxy: ON/OFF` справа и радио-пункты `Theme: Dark/Light/System` из меню `View`.
   - В `SessionInspector.tsx`: удалить дублирующую кнопку `Wizard` из верхней полосы сводки.

4. Контекстные подсказки (`src/components/ui/HelpTooltip.tsx`):
   - Создать доступный компонент `HelpTooltip` и добавить понятные описания ко всем настройкам и пунктам в выпадающих поповерах `TopToolbar` (`Keep`, `SysProxy`, `MITM`, `Throttle`, `Columns`) и разделах `SettingsModal`.

Проверка: `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 12: Аналитика и визуализация: Waterfall Timeline и статистика трафика
**Приоритет: P2 (Feature) | Спринт 6 | Зависимости: Этапы 34 ✅, 35, 39, 36, 37, 38**

### Цель и контекст
Для поиска узких мест производительности (последовательные «лесенки» запросов, тяжелые эндпоинты, всплески 4xx/5xx и P95-латентность) нужна наглядная временная диаграмма и агрегированная статистика по выборке сессий.

### Критерии приемки (DoD)
- Компонент `src/components/WaterfallTimeline.tsx` (вкладка/переключатель режима просмотра в `Traffic Viewer`) с виртуализацией строк (`@tanstack/react-virtual`), горизонтальной шкалой времени (Zoom + линейка мс) на базе `summary.timestamp` и `summary.durationMs` и **многофазной разбивкой полос** (`DNS` / `TCP` / `TLS` / `Wait (TTFB)` / `Download`) по полям `summary.dnsMs`, `connectMs`, `tlsMs`, `ttfbMs`, `receiveMs` из Этапа 34 (с плавным fallback на сплошную полосу по статусу/MIME для старых или импортированных сессий без фаз).
- Клик по полосе таймлайна синхронизирует выбор сессии с `TrafficGrid` и `SessionInspector`.
- Модальное окно `src/components/TrafficStatisticsModal.tsx` (с расчетом метрик за один проход $O(N)$ в `useMemo` на базе общих утилит `src/lib/requestStatistics.ts` из Этапа 34): количество запросов, распределение 2xx/3xx/4xx/5xx, суммарный объем (wire/decoded), Average / Median / P95 Latency и TTFB, распределение по MIME и хостам, топ-5 медленных и топ-5 крупных URL + кнопка «Copy Markdown Report».
- Выдерживает 10 000+ сессий без блокировки UI.

### 📝 Промпт для Antigravity (Этап 12)

```markdown
Роль: Senior Frontend & Data Visualization Engineer (React 19 + TypeScript + Tailwind CSS).
Проект: FluxProxy (Tauri v2 + React 19).

Задача: Реализовать виртуализированный многофазный Waterfall Timeline и модальную панель сводной статистики трафика по всей отфильтрованной выборке (переиспользуя фазы таймингов и расчётные утилиты `src/lib/requestStatistics.ts` из Этапа 34).

1. Waterfall Timeline (`src/components/WaterfallTimeline.tsx`, `src/App.tsx`):
   - Построение шкалы относительно минимального `timestamp` выборки (`offsetMs = startMs - minStartMs`, длина полосы = `durationMs`).
   - Рендеринг многофазных цветных сегментов (`DNS` / `TCP` / `TLS` / `Wait (TTFB)` / `Download`) по компактным полям `SessionSummary` (`dnsMs`, `connectMs`, `tlsMs`, `ttfbMs`, `receiveMs`) с fallback на единую полосу `durationMs` (по статусу/MIME), если детализация фаз отсутствует.
   - Виртуализация списка через `@tanstack/react-virtual`, управление масштабом (Zoom In / Zoom Out / Fit All), тултип с точным началом/длительностью и разбивкой фаз, синхронизация выбора `selectedId` с `SessionInspector`.

2. Модальная панель статистики выборки (`src/components/TrafficStatisticsModal.tsx`, `src/lib/requestStatistics.ts`, `src/components/MenuBar.tsx`, `src/components/CommandPalette.tsx`):
   - Переиспользовать и при необходимости расширить чистые вычисления в `src/lib/requestStatistics.ts` (без дублирования расчётов из Этапа 34): общее число сессий (всей отфильтрованной выборки 10 000+ или выделенных), доли `2xx/3xx/4xx/5xx/Pending`, суммарный `bodySize` и `wireBodySize`, `avg` / `median` / `p95` `durationMs` и `ttfbMs`, сводка по `contentType` и хостам, топ-5 самых медленных и самых тяжелых URL.
   - Генерация аккуратного Markdown-отчета в буфер обмена («Copy Markdown Report»).
   - Добавить вызов из `MenuBar.tsx` (`View` / `Tools`), контекстного меню таблицы и `CommandPalette.tsx`.

Проверка: `npm run typecheck`, `npm run test`, `npm run build`.
```
