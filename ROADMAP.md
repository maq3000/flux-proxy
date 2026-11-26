# 🗺️ Дорожная карта (Roadmap) развития FluxProxy

> **FluxProxy** — кроссплатформенный локальный отладочный HTTP/HTTPS/WebSocket-прокси на базе **Tauri v2 (Rust)** и **React 18 (TypeScript) + Zustand 5**.
>
> Документ содержит актуальный статус реализованных подсистем (`v0.1.0` – `v0.6.0`), план **Спринта 7 (Этапы 43–49)** по итогам комплексного аудита `v0.6.0` ([PROJECT_CONTEXT_AND_AUDIT.md](PROJECT_CONTEXT_AND_AUDIT.md)), принятые оптимальные архитектурные решения (`ADR-01`–`ADR-04`), зоны проверки (`VER-01`–`VER-03`), матрицу приоритетов и инженерные ограничения кодовой базы.

---

## ✅ Реализованные этапы (Verified Milestones `v0.1.0` – `v0.6.0`)

Следующие подсистемы **полностью реализованы, покрыты тестами в кодовой базе (`167` тестов Vitest в 29 файлах + `170` тестов Rust) и не требуют повторной разработки** *(примечание по путям: после архитектурной декомпозиции в Этапе 11 / п. 34 и Этапе 36 / п. 40 бывшие монолиты `server.rs`, `filters.rs`, `export_import.rs` и `tauriBridge.ts` разнесены по модулям `src-tauri/src/proxy/server/`, `src-tauri/src/proxy/filters/`, `src-tauri/src/storage/export_import/`, `src/lib/previewEngine.ts` и `src/hooks/useGlobalShortcuts.ts`, а `src/components/HostFiltersTab.tsx` является реэкспортом `src/components/filters/HostFiltersTab.tsx`; в Этапе 38 / п. 42 разрозненные модальные экраны настроек консолидированы в полноэкранный `src/components/SettingsModal.tsx` и подпанели `src/components/settings/`; в Этапе 42 / п. 44 модальные окна `BreakpointModal.tsx` и `TextWizardModal.tsx` заменены неблокирующими панелями `BreakpointsPanel.tsx` и `TextWizardPanel.tsx`)*:

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
    - Сохранение пропорций всех 4 `<PanelGroup>` (первоначально `flux-layout-bottom-outer-v1`, `flux-layout-bottom-inner-v1`, `flux-layout-right-v1`, `flux-inspector-split-v1`; в Этапе 40 `flux-layout-bottom-outer-v1` заменён и актуализирован в `FLUX_PANEL_AUTOSAVE_IDS`: `bottomInner`, `right`, `inspectorSplit`, `composerSplit` в `src/stores/uiStore.ts`), настройка `inspectorSplitDirection` (`"auto" | "horizontal" | "vertical"`) в `useUiPreferences.ts` и `FluxUserSettingsProfile`, сброс двойным кликом по разделителю и команда `View → Reset Panel Layout to Default`.
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
    - Настройка `Vitest 3` (`^3.2.7`, `jsdom`) и `@testing-library/react` в `package.json` и `vite.config.ts`, 12 тестовых файлов (92 unit/integration-теста для `src/lib/*.ts` и `src/hooks/useProxySessions.test.tsx`), а также `.github/workflows/ci.yml` для матрицы `ubuntu-latest`, `windows-latest`, `macos-latest` (`npm ci`, `typecheck`, `test`, `build`, `cargo clippy -- -D warnings`, `cargo test`).
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
38. **[Этап 35 — Выполнено] Стабилизация маршрутизации, атомарность WS-инъекций, паритет Composer и защита от OOM (`BUG-01`..`BUG-05`, `PERF-01`..`PERF-02`, `CONC-02`, `SEC-01`):**
    - Единая маршрутизация через `HOSTS Remapping` (с предкомпилированными Regex) и `Upstream Proxy` (включая прямые WebSocket `ws://`/`wss://` и IP/HTTP-прокси), атомарная запись инъектированных WS-фреймов (`CONC-02`), лимит буферизации ответов `64 MiB` (`SEC-01`), индикация **`via <proxy>`** в `Server IP` / `Statistics` (`BUG-05`), паритет `on_request`/`on_response` и `OverrideStatus` в Composer + чекбокс **`Run Python Scripts`**, синхронизация `clientSendMs` (`BUG-04`) и дедупликация 16-мс батчера (`PERF-02`).
39. **[Этап 39 — Выполнено] Разделение и настройка Upstream-таймаутов, прозрачный TTFB и RAII-гард `499`:**
    - Конфигурация `UpstreamTimeoutConfig` (`connectTimeoutSec = 15`, `responseHeaderTimeoutSec = 0` Unlimited по умолчанию, `composerTimeoutSec = 120` + кнопка **`Cancel`** и настройка в `Preferences → General`), отмена долгих запросов через токен/реестр, RAII-гард `InFlightSessionGuard` (честный статус `499` при обрыве клиентом), заголовок `X-FluxProxy-Error` и тесты в `upstream_client.rs` / `server/mod.rs` / `settingsManager.test.ts`.
40. **[Этап 36 — Выполнено] Защита ключей mTLS (DPAPI / In-Memory), LAN Client Allowlist, чистота Zustand-сторов, очистка техдолга и синхронизация документации:**
    - Прозрачное шифрование приватных ключей CA и mTLS через **Windows DPAPI** (`src-tauri/src/proxy/dpapi.rs`, префикс `FLUX_DPAPI_V1:`, `CRYPTPROTECT_UI_FORBIDDEN`, автомиграция старых PEM-файлов) и режим **`Session-only (In-Memory)`** (`ephemeral: true`, бейдж `RAM ONLY` без записи на диск) в `client_certs.rs` и `ClientCertificatesModal.tsx` (`SEC-03`).
    - Белый список **`LAN Client Allowlist`** (`ProxyFilterBackendConfig.lan_client_allowlist` / `FluxUserProxySettings.lanClientAllowlist`, предкомпиляция IPv4/IPv6 + CIDR в `filters/mod.rs`, ранний `403 Forbidden` в `connect_tunnel.rs` и `http_handler.rs`, управление в `MobileSetupModal.tsx`, быстрый пункт в `TrafficGrid.tsx` и полный round-trip в `settingsManager.ts`).
    - Фильтрация `SAFE_RASTER_IMAGE_MIMES` в Multipart (`SEC-02`, исключён `image/svg+xml`), сохранение runtime-состояния при `syncFromLocalStorage()` (`CONC-01`) и вынос sync-вызовов в `useEffect`, оптимизация `selectedSessions` в `App.tsx` (`PERF-03`), удаление мёртвых билдеров и кэшей `reqwest::Client` (`ARCH-01`; окончательный перенос крейта `reqwest` из `[dependencies]` в `[dev-dependencies]` с заменой 5 вызовов `reqwest::Url::parse` на `url::Url::parse` вынесен в Этап 47 / `ARCH-02`), декомпозиция `BrowserPreviewEngine` → `src/lib/previewEngine.ts` и глобальных шорткатов → `src/hooks/useGlobalShortcuts.ts` (`ARCH-02`) и синхронизация документации (`README.md`, `USER_GUIDE.md`, `PYTHON_SCRIPTING_GUIDE.md`, `ROADMAP.md`).
41. **[Этап 37 — Выполнено] Исправление UI-багов инспектора (`HexViewer` и `TIMING BREAKDOWN`) и редизайн `Command Palette 2.0` (`UX-01`, `UX-02`, `UX-05`):**
    - Единая детерминированная сетка `flex w-[392px] shrink-0 items-center tabular-nums` для шапки `00..0F` и виртуализированных байтовых строк (`w-6`, октет `ml-2`) и фиксированные ячейки `w-2.5 text-center` (`ml-1` на октете) для `Decoded ASCII` в `src/components/HexViewer.tsx`, исключающие сдвиг колонок и наложение байтов на ASCII.
    - Статический блок `Phase Legend` (`<div>`/`<span>` без hover/focus-обработчиков) и плавающий оверлей тултипа (`pointer-events-none absolute left-0 right-0 top-full z-20 mt-1.5`) исключительно на сегментах таймлайна в `src/components/SessionStatisticsPanel.tsx`, устраняющий мелькание и сдвиг макета.
    - Расширенная `Command Palette 2.0` (`src/components/CommandPalette.tsx`, `src/App.tsx`: `w-[min(92vw,820px)] max-w-3xl`, поиск `h-12 text-base`, список `max-h-[62vh]`, фильтры категорий с переключением по `Tab`, чипы QuickExec `bpu `/`bpafter `/`jwt `/`doctor`/`mtls`, группировка секций, однострочные описания `description`, живые бейджи состояния `statusBadge` и футер навигации) + компонентные тесты Vitest (`HexViewer.test.tsx`, `SessionStatisticsPanel.test.tsx`, `CommandPalette.test.tsx`).
42. **[Этап 38 — Выполнено] Единый полноэкранный центр настроек (`Unified Fullscreen Settings Hub`), дедупликация навигации, наглядный `Throttling` и система подсказок (`HelpTooltip`):**
    - Полноэкранный `SettingsModal.tsx` (`fixed inset-0 h-screen w-screen max-h-none max-w-none m-0 rounded-none border-0`) с 6 разделами (`general`, `networkRouting`, `tlsCertificates`, `filters`, `uiColumns`, `diagnosticsBackup`), подвкладками, живыми счётчиками и кросс-секционным поиском (`SETTINGS_SEARCH_INDEX`).
    - Перенос в `Settings Hub` и удаление разрозненных модальных окон (`FilterDrawer.tsx`, `HostRemapModal.tsx`, `UpstreamProxyModal.tsx`, `ClientCertificatesModal.tsx`, `MobileSetupModal.tsx`, `ProxyDoctorModal.tsx`, `RulesProxySettingsTab.tsx`), перенос `Upstream Timeouts` в `Network & Routing`, единый экземпляр `BindConfigSection` в `General`, удаление дублирующего свитча темы и сохранение компактного диалога `CertificateModal.tsx` (`Root CA`).
    - Дедупликация `Sidebar.tsx`, `TopToolbar.tsx`, `MenuBar.tsx` и `SessionInspector.tsx` (всегда видимый подписанный селектор `Throttle: Off / ...` + кнопка `Routing` в `TopToolbar`, удаление меню переполнения `•••`, дубля `Wizard`, радио-пунктов темы в `MenuBar`, кнопок докинга инспектора `PanelBottom`/`PanelRight` с учётом Этапа 40), доступный компонент `HelpTooltip.tsx` и 14 новых Vitest-тестов (`HelpTooltip.test.tsx`, `SettingsModal.test.tsx`, `NavigationDeduplication.test.tsx`).
43. **[Этап 40 — Выполнено] Эргономика Request Composer (хоткей `E`, отдельная вкладка и отказ от Split-сайдбара) и панель возврата свёрнутого `Session Inspector`:**
    - Единый переход во вкладку `Composer` (`loadSessionIntoComposer(sessionId)` без `openStandalone`, сохранение `sourceSessionId`), Fiddler-style одиночный хоткей `E` в `src/hooks/useGlobalShortcuts.ts` (вне редактируемых полей, `.monaco-editor`, модалок и поповеров, без конфликта с `Ctrl+E` для `TextWizard`) и подсказки `E` в `TrafficGrid.tsx`, `SessionInspector.tsx`, `MenuBar.tsx`, `CommandPalette` и `ShortcutsModal.tsx`.
    - Упразднение обрезанного Split-сайдбара `dockedComposer` (`uiStore.ts`, `App.tsx`, `TopToolbar.tsx`, `MenuBar.tsx`, `CommandPalette`) и апгрейд полноэкранного `ComposerPanel.tsx` (`← Traffic` `Alt+1`, бейдж `From #<id>`, кнопка `Inspect #<id> in Traffic`, гибкая сетка колонок заголовков и ресайзабельный `PanelGroup` `flux-composer-split-v1`).
    - Постоянная панель возврата свёрнутого инспектора `src/components/CollapsedInspectorBar.tsx` (`bottom` полоса `h-7` с превью сессии / `Statistics` / `Dock Right` и `right` рельса `w-7` с `Statistics` / `Dock Bottom`), `collapsible` / `collapsedSize={0}` / `onCollapse` у панелей `SessionInspector` + защита `sanitizeInspectorPanelStorageJson` в `SAFE_PANEL_STORAGE` и 13 новых Vitest-тестов (`CollapsedInspectorBar.test.tsx`, `ComposerPanel.test.tsx`, `uiStore.test.ts`, `useGlobalShortcuts.test.tsx`).
44. **[Этап 42 — Выполнено] 3-уровневая архитектура экранов (7 неблокирующих вкладок, полноэкранные экраны, компактные диалоги) и единые лаконичные заголовки (`SECTION_REGISTRY` + `SectionHeader`):**
    - Расширен `ActiveNavSection` (`src/types/proxy.ts`, `src/stores/uiStore.ts`) до 7 вкладок (`traffic`, `composer`, `rules`, `breakpoints`, `scripts`, `diff`, `wizard`); извлечены неблокирующие панели `src/components/BreakpointsPanel.tsx` и `src/components/TextWizardPanel.tsx` (удалены `BreakpointModal.tsx` и `TextWizardModal.tsx`), `SessionDiffView.tsx` встроен вкладкой в `<main>` с сохранением рабочего состояния (lazy-mount + `hidden` и персистентность пары A/B), `BreakpointBanner.tsx` ведёт кликом во вкладку `Breakpoints`, а `useGlobalShortcuts.ts` и `Sidebar.tsx` поддерживают `Alt+1..6`, `Ctrl+D`, `Ctrl+E` и `F11`/`Alt+F11`/`Shift+F11`.
    - Полноэкранный контейнер (`fixed inset-0 h-screen w-screen max-h-none max-w-none m-0 rounded-none border-0`) применён к `OpenApiExportModal.tsx`, `SanitizedExportModal.tsx`, `CodeSnippetModal.tsx` и `ShortcutsModal.tsx` (в дополнение к `SettingsModal.tsx`), при сохранении компактных диалогов `CertificateModal.tsx` (`Root CA`, `max-w-xl`), `SessionAnnotationModal.tsx` (`Comment & Mark`, `max-w-lg`), `Import cURL`, `Quick Paste`, `CommandPalette` и подтверждений.
    - Созданы единый реестр `src/lib/sectionRegistry.ts` (`SECTION_REGISTRY`, 21 канонический заголовок) и компонент `src/components/ui/SectionHeader.tsx` с поповером «О разделе» (`popover="auto"` + CSS Anchor Positioning с fallback); унифицированы заголовки и подписи в `Sidebar`, `MenuBar`, `CommandPalette`, `ShortcutsModal`, `TrafficGrid` и всех экранах, плюс 13 новых Vitest-тестов (`sectionRegistry.test.ts`, `SectionHeader.test.tsx`, `ScreenArchitecture.test.tsx`, обновления `uiStore.test.ts`, `useGlobalShortcuts.test.tsx`, `NavigationDeduplication.test.tsx`, `SettingsModal.test.tsx`).
45. **[Этап 41 — Выполнено] Единая контекстно-зависимая система ПКМ-меню по всему приложению (Context-Aware Right-Click Menus):**
    - Реализована единая декларативная инфраструктура ПКМ (`src/hooks/useContextMenu.ts`, `src/components/ui/ContextMenu.tsx`, `src/lib/contextMenuBuilders.ts`, `src/index.css`): `ContextMenuProvider`, `useContextMenu()`, поддержка `header`, `separator`, `icon`, `shortcut`, `checked`, `disabled`, `danger` и вложенных `submenu`, точное позиционирование через `getBoundingClientRect()` с auto-flip / viewport clamping (удалены жёсткие размеры `288×396`), safe-triangle для подменю, полная клавиатурная навигация (`↑`/`↓`/`Home`/`End`/`→`/`←`/`Enter`/`Space`/`Esc`), закрытие по клику/скроллу вне меню и глобальный перехват `onContextMenu` в `App.tsx` (подавление «сырого» меню WebView2 при сохранении штатного меню `.monaco-editor`, десктопных операций `Cut / Copy / Paste / Select All` в `<input>`/`<textarea>`/`[contenteditable]` и меню выделенного read-only текста).
    - Внедрены контекстные меню по всем зонам: `TrafficGrid.tsx` (строки сессий с `E` / `bpu` / `Allow only this device IP`, шапка колонок, пустая область таблицы), `SessionInspector.tsx` (сводка сессии, `KeyValueTable` + `Header Mutation`, `CookiesTable`, `Image/SVG`, сплиттер), `InspectorProtocolPanels.tsx` (`WS` с инъекцией, `SSE`), `HexViewer.tsx`, `SessionStatisticsPanel.tsx`, `ComposerPanel.tsx` (поле URL + заголовки), `AutoResponderPanel.tsx`, консоль `ScriptingPanel.tsx`, каркас (`TopToolbar.tsx`, `Sidebar.tsx`, `PanelResizeHandle`, `CollapsedInspectorBar.tsx`, `Footer` в `App.tsx`) и вкладки Этапа 42 (`BreakpointsPanel.tsx`, `SessionDiffView.tsx`, `TextWizardPanel.tsx`) с едиными названиями из `SECTION_REGISTRY`.
    - Добавлены 12 Vitest-тестов (`src/components/ui/ContextMenu.test.tsx` и `src/lib/contextMenuBuilders.test.ts`), проверяющих auto-flip/clamping, клавиатурную навигацию и вложенные подменю, сохранение `.monaco-editor`, редактирование полей ввода и состав меню для всех контекстных зон.
46. **[Этап 12 — Выполнено] Аналитика и визуализация: виртуализированный многофазный Waterfall Timeline и сводная статистика трафика (`Traffic Statistics`):**
    - Компонент `src/components/WaterfallTimeline.tsx` (переключатель `Grid` ↔ `Waterfall` в заголовке `Traffic` в `src/App.tsx`, `MenuBar.tsx` и `CommandPalette.tsx`) с виртуализацией строк (`@tanstack/react-virtual`, 10 000+ сессий без блокировки UI), горизонтальной линейкой времени и масштабированием (`Zoom In` / `Zoom Out` / `Fit All`), многофазной цветной разбивкой полос (`DNS` / `TCP` / `TLS` / `Wait (TTFB)` / `Download` с fallback на сплошную полосу для сессий без детальных фаз), фазовым tooltip, ПКМ-меню и синхронизацией выбора с `SessionInspector`.
    - Модальная панель `src/components/TrafficStatisticsModal.tsx` и расширенный $O(N)$-движок `src/lib/requestStatistics.ts` (переключение области `Filtered Sample` / `Selected Sessions`, доли `2xx`–`5xx` / `Pending`, суммарный трафик wire/decoded, `Avg / Median / P95` Latency и TTFB, разбивка по MIME и хостам с быстрым фильтром, топ-5 самых медленных и самых крупных URL с переходом к строке и кнопка **`Copy Markdown Report`**), интегрированные с `MenuBar.tsx`, контекстным меню таблицы (`src/lib/contextMenuBuilders.ts`) и `CommandPalette.tsx` (`stats` / `waterfall`).
    - Добавлены Vitest-тесты (`src/components/WaterfallTimeline.test.tsx`, `src/components/TrafficStatisticsModal.test.tsx`, дополнения в `requestStatistics.test.ts`, `CommandPalette.test.tsx`, `contextMenuBuilders.test.ts` и `NavigationDeduplication.test.tsx`).

---

## 📋 Матрица приоритетов и порядок выполнения

> *Номера этапов (`43`–`49`) используются как стабильные идентификаторы задач (`phase-N`). Все секции Спринта 7 ниже отсортированы строго в порядке выполнения сверху вниз. Завершённые этапы Спринтов 1–6 (`v0.1.0` – `v0.6.0`) перенесены в раздел реализованных этапов выше.*

| # | Этап | Приоритет | Спринт | Зависимости | Аудит / ADR / VER | Ключевая ценность |
| :-: | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **[Этап 43](#этап-43-безопасность-периметра-dns-ssrf-write-only-mtls-dpapi-domain-fronting-файловый-и-python-ipc)** | **P0 (Critical Security)** | Спринт 7 | Этапы 7 ✅, 18 ✅, 31 ✅, 36 ✅ | `SEC-01`, `SEC-02`, `SEC-03`, `SEC-04`, `SEC-06`, `ADR-03` | Закрытие LAN→Loopback DNS SSRF и разделение пулов сокетов, отказ от записи сырых `.p12`/`.pfx` (`ADR-03`), проверка расхождения `Host`/`:authority` в `InterceptAll`, диалог-токены файлового IPC + починка экспорта `.md`/`.txt`, лимит `stdout.read_line` Python-воркера |
| 2 | **[Этап 44](#этап-44-протокольная-корректность-http-autoresponder-streaming-composer-и-двухуровневая-остановка-соединений)** | **P0 / P1 (Core Protocol & Lifecycle)** | Спринт 7 | Этап 43 | `BUG-01`..`BUG-07`, `CONC-01`, `CONC-02`, `ADR-02` | Сохранение сырых не-ASCII заголовков (`raw_bytes_b64`), чистка заголовков `AutoResponder` `MockResponse`, кастомный `Host` и `Content-Length: 0`, фикс веток `4a`/`4b`/`4c`, полная защита от self-loop/двойного `HOSTS`-ремапа, отмена всех фаз `Composer` + `final_url`, Graceful Drain (30 с) vs Hard Abort (`ADR-02`) и реакция passthrough/WS на смену правил |
| 3 | **[Этап 45](#этап-45-потолок-памяти-breakpointengine-асинхронный-sqlite-io-потоковый-sanitized-export-и-webview2-monaco)** | **P1 (Memory, Storage & Export)** | Спринт 7 | Этапы 43, 44 | `PERF-01`, `PERF-02`, `PERF-03`, `SEC-05`, `BUG-09`, `ADR-01`, `VER-03` | Перевод `BreakpointEngine` на превью `<= 256 KiB` + ленивую загрузку, вынос тяжёлых записей SQLite с потоков Tokio (устранение двойного оффлоада и 150-мс перезаписей `4b`), санитизация `multipart/form-data` + лимит `.saz`, потоковый экспорт с опцией `include_evicted_sqlite` (`ADR-01`), пре-чек размера запроса в `OpenApiExportModal`, фикс дефолтов `<local>`/`clearDbOnExit`/`theme-init.js` и потолок памяти Monaco `<= 2 MiB` + переиспользование моделей (`VER-03`) |
| 4 | **[Этап 46](#этап-46-диагностика-proxy-doctor-gpo-edr-кросс-дистрибутивный-linux-pki-sysproxy-и-таймауты-привилегий)** | **P1 / P2 (OS Diagnostics & Verification)** | Спринт 7 | Этап 43 | `BUG-08`, `ADR-04`, `VER-01`, `VER-02` | Починка сканера Windows Firewall при `ERROR_MORE_DATA` и сохранение порта восстановления, детекция GPO `ProxySettingsPerUser` и внешнего SSL-инспектора EDR (`VER-01`), Tier-1 Linux PKI (`update-ca-certificates`/`update-ca-trust`/`trust anchor`) + KDE `kioslaverc`/no-DE фоллбэк (`ADR-04`), таймаут `60 с` на `security`/`pkexec` и ручная CLI-инструкция в `CertificateModal` (`VER-02`) |
| 5 | **[Этап 47](#этап-47-производительность-ui-tls-ipc-ленивый-бандл-усиление-ci-cd-чистка-зависимостей-и-синхронизация-документации)** | **P2 (Performance, Bundle, CI & Hygiene)** | Спринт 7 | Этапы 44, 45, 46 | `PERF-04`, `PERF-05`, `ARCH-02`, CI & Doc Sync | Singleflight `try_get_with` + `spawn_blocking` в `ca.rs`, индекс `byId` в `proxyStore`, развязка IPC-батчера и кэш `ClientConfig` для `wss://`, динамический `import("./previewEngine")` и удаление `css.worker`/`html.worker`, перенос `reqwest` в `[dev-dependencies]`, удаление `clsx`/`tailwind-merge`/дубля `update_proxy_filter_config`/`HostFiltersTab.tsx`/предупреждений `autofocus`, усиление CI (`--locked`, MSRV `1.80`, `--no-bundle`, `audit`) и Doc Sync |
| 6 | **[Этап 49](#этап-49-раздельное-отсеивание-статических-ассетов-css-images-fonts-и-javascript-скриптов)** | **P2 (Feature / Filtering)** | Спринт 7 | Этапы 2 ✅, 4 ✅ | Product Improve (Noise Filtering) | Разделение монолитного `hideStaticAssets` на 4 независимых переключателя (`CSS`, `Images`, `Fonts`, `JavaScript`), добавление фильтрации JS-скриптов (MIME + `.js`/`.mjs`/`.cjs`/`.jsx`/`.js.map` без ложных срабатываний на `.json`), обратная совместимость профилей `schemaVersion: 1` / `localStorage`, 1-клик пресеты в `ThresholdsTab` и единый подсчёт бейджей |
| 7 | **[Этап 48](#этап-48-стратегическая-декомпозиция-монолитов-и-закрытие-пробелов-компонентного-тестирования)** | **P3 (Architecture & Test Coverage)** | Спринт 7 | Этапы 44, 45, 47, 49 | `ARCH-01`, Test Coverage Gaps | Вынос 6 600 строк тестов `server/mod.rs` в `server/tests/`, общие стадии `server/pipeline_stages.rs` для `http_handler`/`composer_exec` и хелпер транспорта WS, разбиение `settingsManager.ts`, изоляция подписок `sessions` в `App.tsx` и вынос `window`-слушателей в `useStoreGlobalSync()`, компонентные тесты для `TrafficGrid`, `SessionInspector`, `BreakpointsPanel` и `tauriBridge` |

---

## 🏛️ Принятые оптимальные архитектурные решения

### Новые принятые решения по итогам аудита `v0.6.0` (Спринт 7: `ADR-01` .. `ADR-04`)

> Для устранения продуктовых и архитектурных развилок, выявленных в `PROJECT_CONTEXT_AND_AUDIT.md` (`v0.6.0`), зафиксированы следующие оптимальные решения, обязательные к исполнению в **Этапах 43–46**:

1. **`ADR-01` — Семантика `Save All Sessions` (`Ctrl+S` / `Sanitized Export`) при вытеснении в SQLite (`[BUG-09]`, `[PERF-03]` → Этап 45):**
   - *Принятое решение:* По умолчанию экспорт с пустым списком выделения (`session_ids = []`) выгружает **строго текущее окно RAM (`DashMap`)**, полностью совпадающее с видимой таблицей `TrafficGrid` и счётчиком `totalCount` в UI. Для выгрузки длительных сеансов вместе с архивом диска в IPC `export_sessions_file`, `BrowserPreviewEngine` и UI экспорта (`SanitizedExportModal.tsx` / диалог сохранения) добавляется явный опциональный флаг `include_evicted_sqlite?: boolean` (*«Включить вытесненные в SQLite сессии (+N архивных)»*, активный при наличии записей в `captured_sessions`), читающий архив потоковым курсором по `ORDER BY id ASC`.
   - *Обоснование:* Исключает нарушение принципа наименьшего удивления и случайную утечку старых PII-данных (которых уже нет на экране оператора), сохраняя возможность полного дампа без пиков RAM.
2. **`ADR-02` — Двухуровневая остановка соединений: `Graceful Drain` на `F12` vs `Hard Abort` при смене периметра (`[CONC-01]`, `[CONC-02]` → Этап 44):**
   - *Принятое решение:* Разделить сигналы остановки в `ControllerRuntimeState` (`src-tauri/src/proxy/server/mod.rs`):
     - **Пауза захвата (`stop()` по `F12`):** закрывает `TcpListener` и снимает системный прокси ОС, переводя уже активные потоки (открытый WebSocket, скачивание файла, passthrough-туннель) в **Graceful Drain с дедлайном `30 с`** (HTTP/2 `GOAWAY`, запрет новых запросов на keep-alive и прекращение записи новых событий в `TrafficStore` без мгновенного обрыва живой вкладки браузера).
     - **Смена границы безопасности (`Hard Abort` — `0 мс`):** немедленно обрывает все дочерние задачи через поколенческий `CancellationToken` при сужении привязки сокета (`AllInterfaces` / `Specific` → `Loopback`, `set_port`), удалении IP из `lan_client_allowlist`, смене решения `MITM ↔ Passthrough` для хоста (`config_version_tx`) и выходе из приложения (`RunEvent::Exit`).
   - *Обоснование:* Сочетает бесшовный UX отладчика (пауза `F12` не рвёт активный звонок/стрим) со строгой гарантией безопасности при закрытии внешнего доступа.
3. **`ADR-03` — Write-Only хранение ключей mTLS и отказ от сохранения `.p12`/`.pfx` на диск (`[SEC-02]` → Этап 43):**
   - *Принятое решение:* **Не поддерживать обратный экспорт приватных ключей из UI и полностью прекратить запись исходного контейнера `{id}.p12` / `{id}.pfx` на диск** в `src-tauri/src/proxy/client_certs.rs`. Архив PKCS#12 разбирается только в оперативной памяти, на диск сохраняется исключительно защищённый через Windows DPAPI (`FLUX_DPAPI_V1:`) / `0600` файл `{id}.identity.pem` (именно он указывается в `stored_cert_path`), а при старте `ClientCertificateStore::new` автоматически удаляются старые незашифрованные `.p12`/`.pfx` дубликаты при наличии валидного `{id}.identity.pem`.
   - *Обоснование:* Следует принципу *Write-Only Key Store*, полностью устраняет риск кражи беспарольных `.p12` с диска без усложнения схемы `registry.json` и восстанавливает соответствие `USER_GUIDE.md:239`.
4. **`ADR-04` — Кросс-дистрибутивная поддержка Linux PKI и честный фоллбэк системного прокси (`[BUG-08]` → Этап 46):**
   - *Принятое решение:* В `src-tauri/src/proxy/ca.rs` реализовать Tier-1 автоопределение трёх стандартных систем доверия Linux (`update-ca-certificates` в `/usr/local/share/ca-certificates/` для Debian/Ubuntu → `update-ca-trust extract` в `/etc/pki/ca-trust/source/anchors/` для Fedora/RHEL/openSUSE → `trust anchor --store` / `trust extract-compat` в `/etc/ca-certificates/trust-source/anchors/` для Arch). В `src-tauri/src/proxy/sysproxy.rs` добавить пользовательский конфиг KDE (`kioslaverc` через `kwriteconfig6`/`kwriteconfig5`) в дополнение к GNOME `gsettings`, а в окружениях без DE (Sway/Hyprland/i3) не трогать root-файлы `/etc/environment`, возвращая информативный `systemProxyError` с кнопкой копирования `HTTP_PROXY`/`HTTPS_PROXY`.
   - *Обоснование:* Покрывает все массовые дистрибутивы Linux при установке Root CA и избегает опасных глобальных правок ОС с правами суперпользователя.

---

## 🔍 Моменты, требующие проверки, и защитные инженерные стратегии (По итогам аудита `v0.6.0`: `VER-01` .. `VER-03`)

> Следующие три зоны поведения зависят от окружения пользователя (корпоративные GPO/EDR, графические агенты привилегий ОС, GC движка WebView2) и требуют как внедрения защитных механизмов в коде, так и **обязательной ручной/стендовой проверки** при приёмке соответствующих этапов:

1. **`VER-01` (`[Требует проверки]` → Этап 46) Корпоративные политики GPO и сторонние WFP/SSL-перехватчики на Windows:**
   - *Защитная стратегия в коде:* Не пытаться обходить доменные запреты через повышение прав (`UAC`). В `src-tauri/src/proxy/doctor.rs` добавить чтение флага политики `HKLM\Software\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ProxySettingsPerUser`: при значении `0` выводить в `ProxyDoctorPanel.tsx` явный диагноз *«Системный прокси заблокирован политикой организации (GPO)»* с готовой к копированию командой изолированного запуска браузера (`--proxy-server=http://127.0.0.1:<port>`), а при несовпадении отпечатка SHA-256 тестового HTTPS-проба с локальным Root CA — предупреждать о внешнем корпоративном SSL-инспекторе (`Zscaler` / `Kaspersky` / `EDR`).
   - *Чек-лист ручной проверки:* Проверить на доменной Windows-машине (или тестовом ключе реестра `ProxySettingsPerUser = 0`) и при включённом стороннем HTTPS-сканере, что Proxy Doctor не падает с ошибкой прав доступа, корректно диагностирует блокировку GPO / подмену сертификата и предлагает рабочую команду запуска браузера.
2. **`VER-02` (`[Требует проверки]` → Этап 46) Интерактивные промпты привилегий `security` (macOS) и `pkexec` (Linux Wayland):**
   - *Защитная стратегия в коде:* Ограничить вызовы внешних утилит доверия в `src-tauri/src/proxy/ca.rs` жёстким таймаутом **`60 с`** с принудительным `kill()` дочернего процесса при таймауте (чтобы отсутствие графического PolKit-агента в минимальных сессиях Wayland не подвешивало UI навсегда) и при ошибке/таймауте показывать в `src/components/CertificateModal.tsx` готовую команду ручной установки сертификата в терминале с кнопкой копирования.
   - *Чек-лист ручной проверки:* Протестировать сценарий отказа пользователя в диалоге `security add-trusted-cert` на macOS и запуск без запущенного PolKit-агента (или с отменой `pkexec`) на Linux Wayland — убедиться, что интерфейс возвращается в рабочее состояние не позднее `60 с` и выводит валидную команду копирования.
3. **`VER-03` (`[Требует проверки]` → Этап 45) Потребление памяти `WebView2` и моделей `Monaco Editor` на сеансах `10 000+` запросов:**
   - *Защитная стратегия в коде:* Обеспечить детерминированный потолок памяти статически на уровне кода UI, не полагаясь на скорость GC в WebView2: задавать фиксированные стабильные `path` URI для экземпляров `<Editor>` в `src/components/SessionInspector.tsx` и `originalModelPath`/`modifiedModelPath` для `<DiffEditor>` в `src/components/SessionDiffView.tsx` (переиспользование постоянных текстовых моделей при навигации `↑`/`↓` по таблице вместо накопления осиротевших моделей) и жёстко отсекать рендеринг текстовых тел `> 2 MiB` в Monaco с предложением открыть `HexViewer` или сохранить тело на диск.
   - *Чек-лист ручной/нагрузочной проверки:* Сгенерировать `10 000` сессий (включая сессии с телами `> 2 MiB`), быстро пролистать `100+` записей клавишами `↑`/`↓` с открытым инспектором и Diff, проверить в DevTools Memory / Диспетчере задач Windows отсутствие утечки моделей `monaco.editor.getModels()` и стабильное потребление памяти `WebView2`.

---

## 🏛️ Архив: утверждённые архитектурные решения аудита `v0.5.0` (реализованы в `v0.6.0`)

> По итогам доказательного аудита `v0.5.0` (`BUG-01..05`, `CONC-01..02`, `SEC-01..03`, `PERF-01..03`, `ARCH-01..02`) по четырём архитектурным развилкам были приняты и реализованы в релизе **`v0.6.0`** (Этапы 35 и 36) следующие решения на основе лучших индустриальных практик (Fiddler Classic, Proxyman, mitmproxy, OWASP Desktop Security):

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

## 🔴 Спринт 7 — P0 / P1 / P2 / P3 (Audit `v0.6.0` Remediation, Security, Performance & Verification)

---

## Этап 43: Безопасность периметра: DNS SSRF, Write-Only mTLS DPAPI, Domain Fronting, файловый и Python IPC
**Приоритет: P0 (Critical Security) | Спринт 7 | Зависимости: Этапы 7 ✅, 18 ✅, 31 ✅, 36 ✅ | Находки аудита: `SEC-01`, `SEC-02`, `SEC-03`, `SEC-04`, `SEC-06` + `ADR-03`**

### Цель и контекст
В ходе аудита `v0.6.0` ([PROJECT_CONTEXT_AND_AUDIT.md](PROJECT_CONTEXT_AND_AUDIT.md)) выявлены 5 критичных/средних уязвимостей на границах доверия прокси, криптохранилища и IPC:
1. **`[SEC-01]` Обход запрета LAN → Loopback SSRF через DNS-резолвинг и общий пул сокетов:** `is_loopback_or_unspecified_host` (`src-tauri/src/proxy/server/mod.rs:2233-2264`) проверяет только строковое имя хоста **до** DNS-резолвинга (`localhost`, `127.*`, `::1`, `0.0.0.0`). Внешний домен (`lvh.me`, `127.0.0.1.nip.io`, DNS rebinding) резолвится через `tokio::net::lookup_host` в `127.0.0.1` внутри `upstream_client.rs:617-679,1003-1038`, `connect_tunnel.rs:284-375` и `websocket_relay.rs:122-178`. Кроме того, локальные и внешние LAN-клиенты делят единый пул keep-alive сокетов `UpstreamHttpClient`.
2. **`[SEC-02]` & `ADR-03` (Запись сырых `.p12`/`.pfx` без защиты DPAPI):** при импорте постоянного (`ephemeral = false`) PKCS#12-контейнера `ClientCertificateStore::add_certificate` (`src-tauri/src/proxy/client_certs.rs:81-103,826-835`) шифрует через DPAPI только `{id}.identity.pem`, но строкой выше записывает незашифрованную копию `{id}.p12`/`.pfx` обычным `std::fs::write` (`write_bytes_securely`), хотя `load_client_auth_for_entry` читает только `{id}.identity.pem`.
3. **`[SEC-03]` Обход `tls_bypass_rules` через внутренний `Host` / `:authority` в режиме `InterceptAll`:** сверка внутреннего `Host`/`:authority` с `tunnel_authority` (`src-tauri/src/proxy/server/http_handler.rs:770-800`) выполняется только под условием `if ctx.filters.is_targeted_only_mode()`. В режиме `InterceptAll` клиент может открыть `CONNECT allowed.example:443`, а внутри отправить HTTP/1.1 или HTTP/2 запрос с `Host: pinned-bank.ru` в обход `tls_bypass_rules` (domain fronting / H2 coalescing).
4. **`[SEC-04]` Отсутствие диалог-токенов файлового IPC и поломка экспорта `.md`/`.txt`:** при проверке исходного кода подтверждено, что механизм `AUTHORIZED_DIALOG_PATHS` и параметр `require_dialog_token` в `src-tauri/src/commands.rs:540-572,619-743,840-869` **ещё не реализованы**: `pick_save_file_dialog`/`pick_open_file_dialog` не регистрируют выданные пути, `save_session_body_file` вызывает `validate_user_file_path(&file_path, None, false)` без ограничений расширений и без токена, а `proxyBridge.exportTextFile` (`src/lib/tauriBridge.ts:791-812`) вызывает `export_settings_file` (который принимает лишь `["json", "yaml", "yml"]`), получает отказ при сохранении `.md`/`.txt` и в `catch` молча откатывается на `triggerBrowserDownload`.
5. **`[SEC-06]` Неограниченный `stdout.read_line` из Python-воркера:** в `src-tauri/src/scripting/python_runner.rs:1031-1039` ответ воркера читается через неограниченный `AsyncBufReadExt::read_line(&mut line)`, что позволяет скрипту вида `print("A" * 500_000_000)` вызвать OOM Rust-процесса за `1500 мс`.

### Критерии приемки (DoD)
- **`[SEC-01]`:**
  - Коннекторы в `upstream_client.rs`, `connect_tunnel.rs` и `websocket_relay.rs` получают признак `peer_is_remote: bool`; после `lookup_host` для удалённого пира (`!peer_addr.ip().is_loopback()`) подключение к любому разрешённому IP с `is_loopback_ip(ip) || is_unspecified_ip(ip)` блокируется с ошибкой/ответом `403 Forbidden`, а правила `HOSTS Remapping`, указывающие на loopback/unspecified IP, игнорируются/блокируются для внешних LAN-клиентов.
  - В `SharedProxyContext` поддерживается отдельный пул `UpstreamHttpClient` для не-loopback клиентов (изоляция keep-alive/HTTP2 сокетов хоста и LAN-устройств); инвариант `should_use_host_mtls_for_peer` (`server/mod.rs:2266-2270`) строго сохранён.
- **`[SEC-02]` & `ADR-03`:**
  - В `src-tauri/src/proxy/client_certs.rs:826-835` полностью удалена запись дублирующего `{id}.p12`/`.pfx` на диск; в `stored_cert_path` сохраняется путь к `{id}.identity.pem` (защищённому Windows DPAPI `FLUX_DPAPI_V1:` / `0600` на Unix).
  - При старте `ClientCertificateStore::new` автоматически удаляет старые незашифрованные `.p12`/`.pfx` файлы в `client_certs/`, если рядом существует валидный `{id}.identity.pem`.
- **`[SEC-03]`:**
  - В `src-tauri/src/proxy/server/http_handler.rs:770-800` проверка расхождения внутреннего `Host`/`:authority` с `tunnel_auth` выполняется **во всех** режимах (`InterceptAll` и `TargetedOnly`); при расхождении вызывается `ctx.filters.evaluate_connect_tunnel(&inner_host)` и запрос отклоняется (`421 Misdirected Request` либо `403 Forbidden`), если целевой домен требует `Passthrough` или не входит в `TargetedOnly`.
- **`[SEC-04]`:**
  - В `src-tauri/src/commands.rs` реализован ограниченный кэш авторизованных путей диалогов `AUTHORIZED_DIALOG_PATHS` (FIFO-очередь до `128` путей, заполняемая в `pick_save_file_dialog` и `pick_open_file_dialog`) и параметр `require_dialog_token: bool` в `validate_user_file_path`, проверяющий нормализованное совпадение с авторизованным путём.
  - `require_dialog_token = true` включён во всех файловых командах (`save_session_body_file`, `export_sessions_file`, `export_settings_file`, `import_sessions_file`, `import_settings_file`, `export_text_file`); выделена новая Tauri-команда `export_text_file` (зарегистрирована в `src-tauri/src/lib.rs`, разрешённые расширения `["txt", "md", "json", "yaml", "yml"]`), а `proxyBridge.exportTextFile` в `src/lib/tauriBridge.ts` переведён на `export_text_file` без скрытого глотания ошибок в Tauri-рантайме.
- **`[SEC-06]`:**
  - Чтение `worker.stdout` в `src-tauri/src/scripting/python_runner.rs:1031-1039` ограничено потолком `MAX_IPC_RESPONSE_BYTES = 16 * 1024 * 1024` (через `tokio::io::AsyncReadExt::take(...)` до `read_line`); при превышении лимита ошибка обрабатывается fail-open, а переполнивший буфер воркер перезапускается.
- **Тесты:** добавлены регрессионные Rust-тесты на блокировку DNS-резолвинга в `127.0.0.1` для удалённого пира и изоляцию пула, отсутствие `.p12` на диске + автоочистку старого `.p12`, отказ при domain fronting в `InterceptAll`, обязательность диалог-токена и работу `export_text_file`, а также ограничение длинной строки из Python `stdout`.

### 📝 Промпт для Antigravity (Этап 43)

```markdown
Роль: Principal Rust Security & Network Systems Engineer (Tauri v2 + Rustls + Hyper + React 18).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Выполнить Этап 43 из ROADMAP.md — закрыть уязвимости периметра безопасности (`SEC-01`, `SEC-02`, `SEC-03`, `SEC-04`, `SEC-06` и `ADR-03`) из аудита v0.6.0.

1. Закрыть DNS-обход LAN → Loopback SSRF и изолировать пул внешних клиентов (`[SEC-01]`, `src-tauri/src/proxy/server/mod.rs`, `connect_tunnel.rs`, `http_handler.rs`, `upstream_client.rs`, `websocket_relay.rs`):
   - Передавать признак `peer_is_remote: bool` (`!is_loopback_ip(peer_addr.ip())`) во все коннекторы (`UpstreamHttpClient`, `connect_tunnel`, `measure_ws_tcp_connect`).
   - Сразу после `tokio::net::lookup_host` проверять каждый разрешённый IP-адрес: если `peer_is_remote == true` и `is_loopback_ip(ip) || is_unspecified_ip(ip)`, немедленно отклонять соединение (`403 Forbidden`). Также блокировать для удалённых пиров правила `HOSTS Remapping`, ведущие на loopback/unspecified адреса.
   - Разделить пулы соединений `UpstreamHttpClient` для локальных и удалённых LAN-клиентов в `SharedProxyContext` (и обновлять оба пула в `rebuild_upstream_clients()`). Строго сохранить инвариант `should_use_host_mtls_for_peer`.

2. Write-Only хранение ключей mTLS и отказ от сырых `.p12`/`.pfx` (`[SEC-02]`, `ADR-03`, `src-tauri/src/proxy/client_certs.rs`):
   - В `ClientCertificateStore::add_certificate` (`client_certs.rs:826-835`) удалить вызов `write_bytes_securely(&archive_path, &cert_bytes)` для `ClientCertificateFormat::Pkcs12`. Сохранять на диск исключительно защищённый через `dpapi::write_protected_key_bytes` файл `{id}.identity.pem` и записывать его путь в `stored_cert_path`.
   - В `ClientCertificateStore::new` при загрузке реестра удалять старые незашифрованные `.p12`/`.pfx` дубликаты в `storage_dir`, если рядом уже есть валидный `{id}.identity.pem` (или мигрировать/удалять безопасно).

3. Проверка расхождения внутреннего `Host`/`:authority` во всех режимах MITM (`[SEC-03]`, `src-tauri/src/proxy/server/http_handler.rs`):
   - В `http_handler.rs:770-800` убрать условие `if ctx.filters.is_targeted_only_mode()`.
   - При любом расхождении внутреннего `Host` или HTTP/2 `:authority` с `tunnel_auth` (как в `InterceptAll`, так и в `TargetedOnly`) вызывать `ctx.filters.evaluate_connect_tunnel` / `should_intercept_tls` и отклонять запрос (`421 Misdirected Request` / `403 Forbidden`), если целевой домен требует `Passthrough` или запрещён в `TargetedOnly`.

4. Диалог-токены файлового IPC и выделение команды `export_text_file` (`[SEC-04]`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/tauriBridge.ts`, `src/lib/previewEngine.ts`):
   - Реализовать ограниченный потокобезопасный реестр `AUTHORIZED_DIALOG_PATHS` (FIFO до `128` путей): регистрировать выбранные пользователем пути внутри `pick_save_file_dialog` и `pick_open_file_dialog`.
   - Добавить параметр `require_dialog_token: bool` в `validate_user_file_path` (`commands.rs:619-743`) и включить `require_dialog_token = true` для `save_session_body_file`, `export_sessions_file`, `export_settings_file`, `import_sessions_file`, `import_settings_file` и новой команды `export_text_file`.
   - Добавить `#[tauri::command] pub async fn export_text_file(file_path: String, contents: String)` с белым списком расширений `["txt", "md", "json", "yaml", "yml"]`, зарегистрировать в `lib.rs` и переключить `proxyBridge.exportTextFile` (`src/lib/tauriBridge.ts:791-812`) на вызов `export_text_file` без скрытого fallback на браузерную загрузку при ошибке нативного IPC.

5. Лимит чтения строки из `stdout` Python-воркера (`[SEC-06]`, `src-tauri/src/scripting/python_runner.rs`):
   - В `send_command_locked` (`python_runner.rs:1031-1039`) ограничить чтение ответа через `AsyncReadExt::take(MAX_IPC_RESPONSE_BYTES + 1)` (`MAX_IPC_RESPONSE_BYTES = 16 * 1024 * 1024`), возвращать `RpcFailure::Protocol` при превышении и перезапускать воркер.

6. Тесты: добавить unit/интеграционные Rust-тесты для DNS-to-loopback SSRF, отсутствия `.p12` на диске, domain fronting в `InterceptAll`, `AUTHORIZED_DIALOG_PATHS` + `export_text_file` и лимита `stdout` Python-воркера.

Проверка: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 44: Протокольная корректность HTTP, AutoResponder, Streaming, Composer и двухуровневая остановка соединений
**Приоритет: P0 / P1 (Core Protocol & Lifecycle) | Спринт 7 | Зависимости: Этап 43 | Находки аудита: `BUG-01`..`BUG-07`, `CONC-01`, `CONC-02` + `ADR-02`**

### Цель и контекст
Аудит `v0.6.0` выявил ряд нарушений HTTP-семантики, потоковой передачи и жизненного цикла фоновых задач:
1. **`[BUG-01]` Порча не-ASCII / `obs-text` заголовков в `"<binary>"`:** `extract_hyper_headers` (`src-tauri/src/proxy/server/mod.rs:2079-2086`) превращает значения заголовков, не прошедшие `v.to_str()`, в строку `"<binary>"`, после чего заголовок пересобирается из этой строки и уходит по сети с литералом `"<binary>"` (ломая `Content-Disposition` с кириллицей, нестандартные `Set-Cookie`, `Location`).
2. **`[BUG-02]` Устаревшие заголовки в `AutoResponder` `MockResponse`:** ветка `RuleActionType::MockResponse` (`http_handler.rs:1371-1384`) не фильтрует `content-length`, `content-encoding`, `transfer-encoding`, `connection`, вызывая `ERR_CONTENT_DECODING_FAILED` или обрыв keep-alive.
3. **`[BUG-03]` & `[BUG-04]` Срезание кастомного `Host` и отсутствие `Content-Length: 0`:** `http_handler.rs:1574-1582` и `websocket_relay.rs:996,1005-1013,1981-1985` безусловно вырезают модифицированный `Host` (в отличие от `composer_exec.rs:804-805`); при пустом `POST`/`PUT`/`PATCH` на HTTP/1.1 удаляется `Content-Length: 0` (`upstream_client.rs:1132-1159`), провоцируя `411 Length Required`.
4. **`[BUG-05]` Ошибки веток стриминга `4a` / `4b` / `4c` (`http_handler.rs:1878-2372`):** в сжатом SSE `BoundedSseSink::total_written` не сбрасывается после `take_bytes()` (обрыв ровно на `64 MiB` суммарных данных); в ветке `4b` превью `64 KiB` хранит сырой `gzip`/`br`; ответы `chunked > 64 MiB` без `Content-Length` падают в ветке `4c` с `502`.
5. **`[BUG-06]` Неполная защита от петли `Upstream Proxy` и двойной ремап `HOSTS`:** `set_upstream_proxy_config` (`server/mod.rs:1852-1885`) проверяет только текущий порт и буквальные loopback-строки, а `set_port`/`set_bind_configuration` вообще не перепроверяют петлю; для plain-HTTP через HTTP-прокси `upstream_client.rs:463-479,1099-1113` выполняет двойной `HOSTS`-ремап.
6. **`[BUG-07]` Дефекты `Composer` (`composer_exec.rs:198-1135`):** отмена не прерывает `bpu`, Python-хуки и задержку `AutoResponder::AddLatency`; при редиректе `http → https` не обновляется `summary.url`/`scheme` из `exchange.final_url`; `MockResponse` не проверяет `evaluate_should_store_session`.
7. **`[CONC-01]`, `[CONC-02]` & `ADR-02` (Жизненный цикл соединений и горячая смена политик):** `stop()` (`F12`), смена порта и сужение `BindHostMode` останавливают только `TcpListener::accept()`, оставляя живыми открытые HTTP/2, keep-alive, passthrough (`connect_tunnel.rs:590-644`) и WebSocket (`websocket_relay.rs:552-943`) задачи; passthrough и WebSocket также не слушают `config_rx.changed()`.

### Критерии приемки (DoD)
- **`[BUG-01]`:** В `HeaderPair` (`src-tauri/src/models.rs`, `src/types/proxy.ts`) добавлено опциональное поле `#[serde(skip_serializing_if = "Option::is_none")] pub raw_bytes_b64: Option<String>` (`rawBytesB64?: string`), заполняемое при `!v.to_str().is_ok()`. При обратной сборке `HeaderMap` восстанавливаются исходные байты через `HeaderValue::from_bytes`, если пользователь не изменял отображаемое значение.
- **`[BUG-02]`:** В `http_handler.rs:1371-1384` и `composer_exec.rs:556-590` для `MockResponse` отфильтровываются `is_hop_by_hop_header`, `content-length` и `content-encoding`, а `Content-Length` выставляется по фактической длине `body_bytes.len()`.
- **`[BUG-03]` & `[BUG-04]`:** Модифицированный `Host` сохраняется и передаётся в `UpstreamHttpClient::send_streaming` (из `http_handler.rs`) и в рукопожатие WebSocket (`websocket_relay.rs`); для `POST`/`PUT`/`PATCH` с пустым телом по HTTP/1.1 `send_streaming` явно выставляет `Content-Length: 0`.
- **`[BUG-05]`:** `BoundedSseSink::take_bytes()` сбрасывает счётчик `total_written` (лимит ограничивает один чанк); в ветке `4b` превью `64 KiB` при известном `Content-Encoding` декодируется потоково (best-effort); в ветке `4c` при достижении `> 2 MiB` для ответов, не требующих `on_response`/`bpafter`/`OverrideStatus`, хвост переключается в потоковый проброс без `502 Body exceeds 64 MiB`.
- **`[BUG-06]`:** Проверка петли каскадирования использует `127.0.0.0/8`, `::1` и все локальные IP машины (`network::get_network_interfaces(true)`) как в `set_upstream_proxy_config`, так и в `set_port` / `set_bind_configuration`; уже ремапнутый plain-HTTP запрос помечается extension-флагом для исключения двойного ремапа в `InstrumentedConnector::call`.
- **`[BUG-07]`:** Единый сигнал отмены (`tokio::select!`) в `composer_exec.rs` отменяет все `.await`-фазы (`bpu`, Python-хуки, `AddLatency`); итоговый URL/схема/хост/путь и TLS-поля обновляются из `exchange.final_url`; `MockResponse` учитывает `evaluate_should_store_session` при активном `drop_non_matching`.
- **`[CONC-01]`, `[CONC-02]` & `ADR-02`:** В `ControllerRuntimeState` внедрены двухуровневые токены остановки: **Graceful Drain (`30 с`)** при `stop()` (`F12` — закрытие листенера, снятие системного прокси, HTTP/2 `GOAWAY`, запрет новых запросов и записи в `TrafficStore`) и **Hard Abort (`0 мс`)** при сужении бинда (`0.0.0.0`/`Specific` → `Loopback`), `set_port`, удалении IP из `lan_client_allowlist`, смене `MITM ↔ Passthrough` (`config_version_tx`) и `RunEvent::Exit`. Ветки `config_rx.changed()` встроены в `tunnel_passthrough_bidirectional` и `finish_ws_handshake_and_spawn`.
- **Тесты:** добавлены интеграционные Rust-тесты для каждого исправления (`non-ASCII Content-Disposition`, `MockResponse` с `Content-Encoding: gzip`, кастомный `Host`, пустой `POST` `Content-Length: 0`, SSE `take_bytes`, отмена `AddLatency` в Composer, Graceful Drain vs Hard Abort при `stop()`/смене бинда/allowlist).

### 📝 Промпт для Antigravity (Этап 44)

```markdown
Роль: Principal Rust Async Networking & Protocol Engineer (Tauri v2 + Hyper + Tokio + Rustls).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Выполнить Этап 44 из ROADMAP.md — устранить протокольные баги (`BUG-01`..`BUG-07`) и реализовать двухуровневое управление жизненным циклом соединений (`CONC-01`, `CONC-02`, `ADR-02`) из аудита v0.6.0.

1. Сохранность сырых не-ASCII заголовков (`[BUG-01]`, `src-tauri/src/models.rs`, `src/types/proxy.ts`, `src-tauri/src/proxy/server/mod.rs`, `http_handler.rs`, `upstream_client.rs`, `websocket_relay.rs`):
   - Добавить `#[serde(default, skip_serializing_if = "Option::is_none")] pub raw_bytes_b64: Option<String>` в `HeaderPair` (`models.rs` и зеркально `rawBytesB64?: string` в `src/types/proxy.ts`).
   - В `extract_hyper_headers` (`server/mod.rs:2079-2086`) при `v.to_str().is_err()` сохранять Base64 сырых байтов в `raw_bytes_b64` (и отображаемое превью `String::from_utf8_lossy` или `"<binary>"`), а при сборке исходящих `HeaderMap` восстанавливать оригинальные байты через `HeaderValue::from_bytes`, если текст не изменялся.

2. Исправление заголовков `AutoResponder`, кастомного `Host` и пустого `Content-Length: 0` (`[BUG-02]`, `[BUG-03]`, `[BUG-04]`, `http_handler.rs`, `composer_exec.rs`, `websocket_relay.rs`, `upstream_client.rs`):
   - В `RuleActionType::MockResponse` (`http_handler.rs:1371-1384` и `composer_exec.rs`) отфильтровывать `is_hop_by_hop_header`, `content-length` и `content-encoding`, выставляя актуальный `Content-Length: body_bytes.len()`.
   - Сохранять явно изменённый `Host` (после `bpu`, Python `on_request` или Header Mutations) при передаче в `UpstreamHttpClient::send_streaming` (`http_handler.rs:1574-1582`) и в `websocket_relay.rs:996-1013,1981-1985`.
   - В `UpstreamHttpClient::send_streaming` (`upstream_client.rs:1132-1159`) для `POST`/`PUT`/`PATCH` при `body.is_empty()` и HTTP/1.1 явно выставлять `Content-Length: 0`.

3. Починка веток стриминга `4a`/`4b`/`4c` (`[BUG-05]`, `src-tauri/src/proxy/server/http_handler.rs:1878-2372`):
   - Сбрасывать `total_written` внутри `BoundedSseSink::take_bytes()`, чтобы сжатый SSE-поток ограничивался размером одного чанка, а не обрывался на 64 MiB.
   - В ветке `4b` при известном `Content-Encoding` декодировать буфер `preview_accum` (`64 KiB`) потоково (best-effort).
   - В ветке `4c`, если тело с `Transfer-Encoding: chunked` превышает `2 MiB` и не требуются `on_response`/`bpafter`/`OverrideStatus`, бесшовно переключаться на потоковый проброс хвоста вместо `502 Body exceeds 64 MiB`. Обязательно вызывать `in_flight_guard.disarm()` на каждой успешной ветке!

4. Защита от self-loop каскадирования, двойного `HOSTS`-ремапа и доработка `Composer` (`[BUG-06]`, `[BUG-07]`, `server/mod.rs`, `upstream_client.rs`, `composer_exec.rs`):
   - Проверять self-loop по `127.0.0.0/8`, `::1` и всем локальным IP из `network::get_network_interfaces(true)` в `set_upstream_proxy_config`, `set_port` и `set_bind_configuration`. Помечать уже ремапнутые plain-HTTP запросы extension-флагом для исключения двойного ремапа в `InstrumentedConnector::call`.
   - В `composer_exec.rs` обернуть ожидание `bpu`, Python-хуков и `AddLatency` в `tokio::select!` с общим сигналом отмены, обновлять `summary.url`/`scheme`/`host`/`path` из `exchange.final_url` при cross-scheme редиректе и проверять `evaluate_should_store_session` для моков.

5. Двухуровневая остановка соединений и реакция на смену политик (`[CONC-01]`, `[CONC-02]`, `ADR-02`, `server/mod.rs`, `connect_tunnel.rs`, `websocket_relay.rs`):
   - Разделить сигналы `ControllerRuntimeState` на `drain_tx` (**Graceful Drain `30 с`** при `stop()`/`F12`: закрытие листенеров, SysProxy, HTTP/2 `GOAWAY`, запрет новых запросов и записи в `TrafficStore`) и `abort_tx` / `CancellationToken` (**Hard Abort `0 мс`** при сужении `BindHostMode`, `set_port`, удалении IP из `lan_client_allowlist`, смене `MITM ↔ Passthrough` и `RunEvent::Exit`).
   - Встроить `drain`/`abort` и `config_rx.changed()` в `serve_connection`, `serve_mitm_tls_connection`, `tunnel_passthrough_bidirectional` и `finish_ws_handshake_and_spawn`.

6. Тесты: написать интеграционные тесты в `src-tauri/src/proxy/server/` на все исправленные сценарии (`BUG-01`..`BUG-07`, `CONC-01`, `CONC-02`).

Проверка: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 45: Потолок памяти BreakpointEngine, асинхронный SQLite I/O, потоковый Sanitized Export и WebView2 Monaco
**Приоритет: P1 (Memory, Storage & Export) | Спринт 7 | Зависимости: Этапы 43, 44 | Находки аудита: `PERF-01`, `PERF-02`, `PERF-03`, `SEC-05`, `BUG-09` + `ADR-01`, `VER-03`**

### Цель и контекст
Аудит `v0.6.0` выявил узкие места потребления RAM, блокировки I/O, пробелы в санитизации и экспорте, а также зону проверки памяти WebView2/Monaco:
1. **`[PERF-01]` `O(N²)` амплификация RAM и IPC в `BreakpointEngine`:** при паузе `bpu`/`bpafter` (`http_handler.rs:3091-3354`, `breakpoints.rs:228-241,322-336`) тела до `64 MiB` кодируются в Base64 + UTF-8 прямо в `PausedBreakpointItem` в обход порога `2 MiB`, и на каждую новую паузу `emit_snapshot()` клонирует и шлёт по IPC весь массив с полными телами.
2. **`[PERF-02]` Синхронный SQLite на потоках Tokio и избыточные записи:** выгрузка тел `> 2 MiB` и вытеснение пачек до `512` записей выполняются синхронно под `Mutex<Connection>` на задачах `http_handler` (`storage/mod.rs:235-335,505-595`); upload `> 2 MiB` пишется в `offloaded_bodies` дважды (Phase 1 и Phase 2), а стрим `4b` вызывает запись превью каждые `150 мс`.
3. **`[SEC-05]` Пробелы `Sanitized Export` и импорта `.saz`:** `sanitize_body_payload` (`sanitize.rs:185-274`) игнорирует `multipart/form-data` и отвергает многострочные URL-encoded тела (`\r`/`\n`); в `saz.rs:149-213` отсутствует лимит на количество файлов в ZIP-архиве (`archive.len()`).
4. **`[PERF-03]`, `[BUG-09]` & `ADR-01` (Потоковый экспорт, `include_evicted_sqlite`, `OpenApiExportModal` и дефолты):**
   - `collect_sessions_for_export(&[])` (`storage/mod.rs:1014-1063`) загружает все оффлоад-тела в RAM (и клонирует ещё раз при санитизации), игнорируя вытесненные в SQLite записи (`captured_sessions`);
   - в `OpenApiExportModal.tsx:232-249` для ответа (`detail.bodyOffloaded`, строка 253) уже стоит предпроверка `bodySize <= MAX_HYDRATE_BODY_BYTES`, но **для оффлоад-тела запроса** (`detail.requestBodyOffloaded`, строки 232–249) она отсутствует — UI сначала тянет до `64 MiB` через `loadSessionBody(id, false)` и проверяет `loaded.bodySize` уже после перекачки;
   - расхождения дефолтов: в Rust `default_upstream_bypass_list` (`models.rs:922-928`) не содержит `"<local>"`, в `useProxySessions.ts:185` стоит `clearDbOnExit ?? true` вместо `false`, а `public/theme-init.js` не учитывает `fluxproxy.themePreset.v1`.
5. **`VER-03` (Потребление памяти WebView2 и моделей Monaco Editor):** `SessionInspector.tsx` (6 `<Editor>`) и `SessionDiffView.tsx` (`<DiffEditor>`) должны гарантировать переиспользование моделей по стабильным URI и жёсткий потолок рендеринга `2 MiB`.

### Критерии приемки (DoD)
- **`[PERF-01]`:** `PausedBreakpointItem` передаёт по `proxy://breakpoints-changed` только метаданные и превью тела `<= 256 KiB` (+ поля `bodyOffloaded`/`bodySize`); более крупные тела выгружаются в SQLite (`offloaded_bodies`) и лениво подгружаются в `BreakpointsPanel.tsx` только для активного выбранного элемента (с паритетом в `BrowserPreviewEngine`).
- **`[PERF-02]`:** В `TrafficStore` убрана повторная запись request-тела на Phase 2 при уже выполненном оффлоаде; `update_streaming_progress` (ветка `4b`) не пишет промежуточные 150-мс тики в SQLite; тяжёлые операции записи SQLite вынесены с рабочих потоков Tokio в выделенный фоновый писатель/канал (или упорядоченную очередь `spawn_blocking`).
- **`[SEC-05]`:** В `sanitize.rs` добавлен разбор `multipart/form-data` по `boundary` с маскированием чувствительных полей и рекурсивной санитизацией вложенных `application/json` частей, а `sanitize_urlencoded_text` поддерживает `\r\n`; в `saz.rs` добавлен жёсткий лимит `archive.len() <= 50_000`.
- **`[PERF-03]`, `[BUG-09]` & `ADR-01`:**
  - По умолчанию `export_sessions_file` с `session_ids = []` экспортирует только текущее окно RAM (`DashMap`), а при `include_evicted_sqlite = true` читает вытесненные записи из `captured_sessions` курсором по `ORDER BY id ASC`. Гидратация оффлоад-тел и санитизация выполняются потоково по одной сессии при записи в `BufWriter`/`ZipWriter`.
  - В `SanitizedExportModal.tsx` (и диалоге экспорта при наличии записей в SQLite) добавлен опциональный чекбокс *«Включить вытесненные в SQLite сессии (+N архивных)»* (с поддержкой в `tauriBridge.ts` и `previewEngine.ts`).
  - В `OpenApiExportModal.tsx:232-249` добавлена предпроверка `(detail.summary.requestSize ?? 0) <= MAX_HYDRATE_BODY_BYTES` до вызова `loadSessionBody(id, false)`.
  - В `models.rs:922-928` добавлено `"<local>"`, в `useProxySessions.ts:185` исправлено `?? true` → `?? false`, а `public/theme-init.js` учитывает светлые/тёмные пресеты из `fluxproxy.themePreset.v1`.
- **`VER-03`:** Все `<Editor>` в `SessionInspector.tsx` используют фиксированные стабильные `path` URI, `<DiffEditor>` в `SessionDiffView.tsx` — стабильные `originalModelPath`/`modifiedModelPath`, текстовые тела `> 2 MiB` отсекаются в Monaco с кнопками **Open in HexViewer** и **Save Body to Disk**. Выполнена нагрузочная проверка на `10 000` сессиях.
- **Тесты:** Rust-тесты на оффлоад брейкпоинтов `> 256 KiB`, `multipart/form-data` санитизацию, `.saz > 50k` записей, потоковый экспорт `include_evicted_sqlite` в порядке `ORDER BY id ASC` и отсутствие двойной записи request-тела; Vitest-тесты для `OpenApiExportModal` (pre-check `requestSize`), `clearDbOnExit ?? false` и отсечения `> 2 MiB` в Monaco.

### 📝 Промпт для Antigravity (Этап 45)

```markdown
Роль: Senior Systems & Performance Engineer (Rust + SQLite + React 18 + Monaco).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Выполнить Этап 45 из ROADMAP.md — устранить узкие места памяти и SQLite I/O (`PERF-01`, `PERF-02`, `PERF-03`), доработать санитизацию и экспорт (`SEC-05`, `ADR-01`, `BUG-09`) и внедрить статический потолок памяти WebView2/Monaco (`VER-03`).

1. Превью и оффлоад тел в `BreakpointEngine` (`[PERF-01]`, `src-tauri/src/proxy/breakpoints.rs`, `http_handler.rs`, `models.rs`, `src/types/proxy.ts`, `src/components/BreakpointsPanel.tsx`, `src/lib/previewEngine.ts`):
   - Ограничить размер инлайн-тела в `PausedBreakpointItem` пределом `256 KiB` (добавив флаг оффлоада и размер); тела `> 256 KiB` выгружать в `offloaded_bodies` (с корректной очисткой при резолве/отмене) и подгружать в `BreakpointsPanel.tsx` лениво только при выборе конкретного элемента в очереди.

2. Неблокирующий SQLite I/O и устранение дублирующих записей (`[PERF-02]`, `src-tauri/src/storage/mod.rs`, `sqlite.rs`, `http_handler.rs`):
   - Пропускать повторную запись request-тела на Phase 2, если тело уже было оффлоажено на Phase 1.
   - Убрать запись в SQLite из 150-мс тиков `update_streaming_progress` в стриминговой ветке `4b`.
   - Вынести тяжёлые записи в `SqliteArchive` (оффлоад тел и пакетное вытеснение) с рабочих потоков Tokio в выделенный фоновый писатель/канал (сохраняя порядок операций и совместимость `TrafficStore`).

3. Санитизация `multipart/form-data` и защита `.saz` (`[SEC-05]`, `src-tauri/src/storage/export_import/sanitize.rs`, `saz.rs`):
   - В `sanitize_body_payload` добавить парсинг `multipart/form-data` по `boundary`, маскируя поля из `mask_json_keys` по `Content-Disposition; name="..."` и рекурсивно санитизируя вложенные `application/json` секции; разрешить `\r\n` в `sanitize_urlencoded_text`.
   - В `saz.rs:149-213` отклонять архивы с `archive.len() > 50_000`.

4. Потоковый экспорт с `include_evicted_sqlite` и исправление дефолтов (`[PERF-03]`, `[BUG-09]`, `ADR-01`, `storage/mod.rs`, `sqlite.rs`, `commands.rs`, `export_import/`, `src/components/SanitizedExportModal.tsx`, `OpenApiExportModal.tsx`, `src/hooks/useProxySessions.ts`, `src-tauri/src/models.rs`, `public/theme-init.js`):
   - По умолчанию при пустом `session_ids` экспортировать текущее RAM-окно; добавить `include_evicted_sqlite: Option<bool>` в `export_sessions_file` (+ опцию в `SanitizedExportModal.tsx` и `previewEngine.ts`) с курсором SQLite `ORDER BY id ASC`.
   - Перевести `export_sessions_file` / `.har` / `.saz` / `.json` / `.txt` на потоковую поэкземплярную гидратацию и санитизацию прямо при записи в `BufWriter`/`ZipWriter`.
   - В `OpenApiExportModal.tsx:232-249` перед `proxyBridge.loadSessionBody(id, false)` проверять `(detail.summary.requestSize ?? 0) <= MAX_HYDRATE_BODY_BYTES`.
   - Добавить `"<local>"` в `default_upstream_bypass_list` (`models.rs:922-928`), заменить `clearDbOnExit ?? true` на `?? false` (`useProxySessions.ts:185`), а в `public/theme-init.js` считывать светлую/тёмную схему и из `fluxproxy.themePreset.v1`.

5. Потолок памяти WebView2 / Monaco (`VER-03`, `src/components/SessionInspector.tsx`, `src/components/SessionDiffView.tsx`):
   - Назначить фиксированные стабильные `path` URI всем `<Editor>` в `SessionInspector.tsx` и `originalModelPath`/`modifiedModelPath` в `<DiffEditor>` в `SessionDiffView.tsx` для переиспользования моделей при навигации `↑`/`↓`.
   - Внедрить жёсткую отсечку рендеринга тел `> 2 MiB` в Monaco с предложением открыть `HexViewer` или сохранить тело на диск.

6. Тесты и проверка: покрыть все пункты Rust и Vitest тестами + прогнать стресс-сценарий на `10 000` сессий.

Проверка: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 46: Диагностика Proxy Doctor (GPO, EDR), кросс-дистрибутивный Linux PKI, SysProxy и таймауты привилегий
**Приоритет: P1 / P2 (OS Diagnostics & Verification) | Спринт 7 | Зависимости: Этап 43 | Находки аудита: `BUG-08` + `ADR-04`, `VER-01`, `VER-02`**

### Цель и контекст
Этап закрывает системные дефекты диагностики/доверия ОС и реализует защитные механизмы для проверяемых окружений (`VER-01`, `VER-02`):
1. **`[BUG-08]` & `VER-01` (Windows Firewall, потеря порта восстановления, GPO и внешний SSL-инспектор):**
   - В `src-tauri/src/proxy/doctor.rs:624-644` `inspect_os_firewall_non_privileged` вызывает `RegEnumValueW` с фиксированным 4096-байтным `data_buf` и делает `if rc != ERROR_SUCCESS { break; }`: при любом правиле брандмауэра длиннее 2048 UTF-16 символов (`ERROR_MORE_DATA = 234`) цикл обрывается, выдавая ложный `warning`;
   - `restart_listener_with_recovery` (`doctor.rs:884-892`) меняет порт, но не вызывает `save_persisted_proxy_port`;
   - корпоративные политики GPO (`ProxySettingsPerUser = 0`) и внешние SSL-инспекторы (`Zscaler` / `Kaspersky` / `EDR`) не диагностируются явно (`VER-01`).
2. **`[BUG-08]` & `ADR-04` (Debian-only Root CA и GNOME-only SysProxy на Linux):**
   - `src-tauri/src/proxy/ca.rs:365-370,578-648` захардкожен под `/usr/local/share/ca-certificates/` и `update-ca-certificates`, не работая на Fedora/RHEL/openSUSE и Arch;
   - `sysproxy.rs:1670-1885` поддерживает только GNOME `gsettings` без поддержки KDE (`kioslaverc`) и понятного фоллбэка на оконных менеджерах без DE (`Sway`/`Hyprland`/`i3`).
3. **`VER-02` (Подвисание интерактивных промптов `security` на macOS и `pkexec` на Linux Wayland):**
   - Вызовы `security` и `pkexec` в `ca.rs:552-603` выполняются без таймаута и в сессиях без графического PolKit-агента могут блокироваться бессрочно, а `CertificateModal.tsx:227-252` не выводит готовую CLI-команду для ручной установки с кнопкой копирования.

### Критерии приемки (DoD)
- **`[BUG-08]` (Windows Doctor):**
  - В `inspect_os_firewall_non_privileged` (`doctor.rs:641-644`) при `rc == ERROR_MORE_DATA` буфер `data_buf` (и при необходимости `name_buf`) расширяется до требуемого размера и запись перечитывается без прерывания перечисления.
  - В `restart_listener_with_recovery` (`doctor.rs:884-892`) при смене порта вызывается `save_persisted_proxy_port`.
- **`VER-01` (GPO и EDR в `doctor.rs` и `src/components/settings/ProxyDoctorPanel.tsx`):**
  - На Windows добавлена проверка ключа `HKLM\Software\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ProxySettingsPerUser`: при значении `0` выводится явный диагноз блокировки GPO и готовая команда запуска браузера (`--proxy-server=http://127.0.0.1:<port>`) без попыток обхода UAC.
  - При HTTPS self-probe сравнивается SHA-256 отпечаток сертификата с локальным Root CA / листом: при несовпадении выводится предупреждение о стороннем корпоративном SSL-инспекторе (`Zscaler` / `Kaspersky` / `EDR`).
- **`[BUG-08]` (Linux CA) & `ADR-04`:**
  - В `ca.rs` реализован Tier-1 выбор хранилища доверия Linux: Debian/Ubuntu (`update-ca-certificates` в `/usr/local/share/ca-certificates/`), Fedora/RHEL/openSUSE (`update-ca-trust extract` в `/etc/pki/ca-trust/source/anchors/`), Arch (`trust anchor --store` / `trust extract-compat` в `/etc/ca-certificates/trust-source/anchors/`).
  - В `sysproxy.rs` добавлена поддержка KDE (`kwriteconfig6`/`kwriteconfig5` для `kioslaverc`) в дополнение к `gsettings`, а для WM без DE возвращается понятный `systemProxyError` с командой `HTTP_PROXY`/`HTTPS_PROXY` без модификации `/etc/environment`.
- **`VER-02` (Таймауты привилегий и ручная команда):**
  - В `ca.rs` внешние вызовы `security` (macOS) и `pkexec` (Linux) ограничены жёстким таймаутом `60 с` (с `kill()` дочернего процесса при таймауте) и возвращают структурированную команду для ручной установки.
  - В `src/components/CertificateModal.tsx` при ошибке или таймауте отображается команда ручной установки в терминале с кнопкой копирования (`previewEngine.ts` обновлён для паритета).
- **Тесты и ручная верификация:** добавлены Rust unit-тесты для парсинга длинных правил брандмауэра (`ERROR_MORE_DATA`), интерпретации GPO-флага, определения Linux PKI-дистрибутивов и таймаута процесса, а также Vitest-тест fallback-UI в `CertificateModal.test.tsx`. Проведены ручные проверки по чек-листам `VER-01` и `VER-02`.

### 📝 Промпт для Antigravity (Этап 46)

```markdown
Роль: Senior Cross-Platform Systems Engineer (Rust + Win32 FFI + Linux/macOS PKI + React 18).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Выполнить Этап 46 из ROADMAP.md — устранить баги `Proxy Doctor` / Linux CA (`BUG-08`, `ADR-04`) и внедрить диагностику/защиту для `VER-01` и `VER-02`.

1. Починка Win32 Firewall-сканера, сохранение порта и диагностика GPO/EDR (`[BUG-08]`, `VER-01`, `src-tauri/src/proxy/doctor.rs`, `src/components/settings/ProxyDoctorPanel.tsx`, `src/lib/previewEngine.ts`):
   - В `inspect_os_firewall_non_privileged` (`doctor.rs:624-644`) при `rc == ERROR_MORE_DATA` перевыделять `data_buf` (и `name_buf` при необходимости) до размера `data_len` и перечитывать элемент вместо `break`.
   - В `restart_listener_with_recovery` (`doctor.rs:884-892`) вызывать `save_persisted_proxy_port` при переключении на новый свободный порт.
   - На Windows читать `HKLM\Software\Policies\Microsoft\Windows\CurrentVersion\Internet Settings\ProxySettingsPerUser`: при значении `0` диагностировать блокировку GPO и отдавать команду `--proxy-server=http://127.0.0.1:<port>`. В HTTPS-пробе сверять отпечаток SHA-256 с локальным Root CA, предупреждая о внешнем SSL-инспекторе (Zscaler / Kaspersky / EDR).

2. Кросс-дистрибутивная поддержка Linux PKI и KDE / no-DE SysProxy (`[BUG-08]`, `ADR-04`, `src-tauri/src/proxy/ca.rs`, `src-tauri/src/proxy/sysproxy.rs`):
   - В `ca.rs` добавить автоопределение и поддержку `update-ca-certificates` (Debian/Ubuntu), `update-ca-trust extract` в `/etc/pki/ca-trust/source/anchors/` (Fedora/RHEL/openSUSE) и `trust anchor --store` / `trust extract-compat` в `/etc/ca-certificates/trust-source/anchors/` (Arch).
   - В `sysproxy.rs:1670-1885` добавить поддержку KDE (`kwriteconfig6`/`kwriteconfig5` для `kioslaverc`) в дополнение к `gsettings`, а при отсутствии DE (Sway/Hyprland/i3) возвращать информативный `systemProxyError` с командой экспорта `HTTP_PROXY`/`HTTPS_PROXY` без записи в `/etc/environment`.

3. Жёсткий таймаут `60 с` на `security` / `pkexec` и ручной CLI-фоллбэк (`VER-02`, `src-tauri/src/proxy/ca.rs`, `src/components/CertificateModal.tsx`):
   - Запускать `security` (macOS) и `pkexec` (Linux) с жёстким таймаутом `60 с` и принудительным `kill()` по истечении времени.
   - При ошибке или таймауте передавать команду ручной установки сертификата в терминале и отображать её в `CertificateModal.tsx` с кнопкой копирования.

4. Тесты: добавить Rust-тесты для буфера `ERROR_MORE_DATA`, GPO-диагностики, определения Linux CA store и таймаута процесса; добавить Vitest-тест отображения ручной команды в `CertificateModal`.

Проверка: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 47: Производительность UI, TLS, IPC, ленивый бандл, усиление CI-CD, чистка зависимостей и синхронизация документации
**Приоритет: P2 (Performance, Bundle, CI & Hygiene) | Спринт 7 | Зависимости: Этапы 44, 45, 46 | Находки аудита: `PERF-04`, `PERF-05`, `ARCH-02` + Секции 4.5 & 6.3**

### Цель и контекст
В аудите `v0.6.0` зафиксированы точечные оптимизации латентности, размера бандла, строгости CI и техдолга зависимостей:
1. **`[PERF-04]` Stampede генерации сертификатов в `ca.rs` и $O(N)$ поиск в `flushBatches`:** `CertificateAuthority::server_config_for_host` (`src-tauri/src/proxy/ca.rs:475-524`) делает раздельные `leaf_cache.get` + генерацию ECDSA-ключа на потоках Tokio + `insert` вместо коалесцирующего `try_get_with`; в `useProxySessions.ts:803-856` на каждое обновление выбранной строки выполняется линейный `sessions.find(...)` по `10 000` элементам.
2. **`[PERF-05]` Блокировка IPC-батчера, `unbounded_channel` и потеря TLS session resumption в `wss://`:** `start_ipc_batcher` (`server/mod.rs:896-994`) ожидает `spawn_blocking` `storage_stats()` прямо в `tokio::select!`, каналы `event_tx`/`removed_tx`/`bp_tx` не ограничены, а `build_ws_tls_config` (`websocket_relay.rs:197-231`) и коннектор HTTPS-прокси (`upstream_proxy.rs:763-786`) пересоздают `rustls::ClientConfig` на каждый сокет.
3. **Холодный старт бандла (Секция 6.3):** статический импорт `previewEngine.ts` (`3 575` LOC) и `mockTraffic.ts` (`1 739` LOC) раздувает главный чанк `index.js` (`961.98 kB`) даже в нативном окне Tauri; `src/lib/monaco.ts:85-115` статически грузит `css.worker` (`1.06 MB`) и `html.worker` (`718 kB`).
4. **`[ARCH-02]` & предупреждения React 18 `autofocus`:**
   - тяжёлый крейт `reqwest = "0.12"` остаётся в `[dependencies]` (`src-tauri/Cargo.toml:47-54`) ради **5** вызовов `reqwest::Url::parse` (`filters/parsers.rs:568`, `http_handler.rs:163,2777`, `server/mod.rs:2228,2256`) и неиспользуемого `ProxyError::Reqwest` (`models.rs:892`), хотя `url = "2"` уже подключён в `Cargo.toml:31`;
   - неиспользуемые npm-пакеты `clsx` и `tailwind-merge` (`package.json:19,26`), дублирующая команда `update_proxy_filter_config` (`commands.rs:341`, `lib.rs:132`, вызываемая из `tauriBridge.ts:469`) и 1-строчный шим `src/components/HostFiltersTab.tsx`;
   - в 8 компонентах модалок/панелей (`CertificateModal.tsx:260`, `CodeSnippetModal.tsx:306`, `CommandPalette.tsx:625`, `ComposerPanel.tsx:1022`, `OpenApiExportModal.tsx:696`, `SessionAnnotationModal.tsx:210`, `ShortcutsModal.tsx:132`, `filters/TlsBypassTab.tsx:2266`) проп `{...({ autofocus: "" } as Record<string, string>)}` вызывает React 18 предупреждения `Invalid DOM property autofocus`.
5. **Усиление CI и Doc-vs-Code Sync (Секции 4.5 и 6.3):** отсутствие `--locked`, проверки MSRV `1.80`, `tauri build --no-bundle`, `cargo audit` / `npm audit`, двойной прогон `tsc` в `.github/workflows/ci.yml`, а также расхождения в `PYTHON_SCRIPTING_GUIDE.md`, `PYTHON_SCRIPTING_AI_GUIDE.md`, `.agents/skills/fluxproxy-release/`, `README.md` и `USER_GUIDE.md`.

### Критерии приемки (DoD)
- **`[PERF-04]`:** В `ca.rs:475-524` `server_config_for_host` переведён на атомарный `self.leaf_cache.try_get_with(...)` с выносом крипто-генерации в `tokio::task::spawn_blocking` на точках вызова (`connect_tunnel.rs`); в `proxyStore.ts` / `useProxySessions.ts` добавлен $O(1)$ индекс `sessionIndexById` вместо линейного `sessions.find(...)`.
- **`[PERF-05]`:** Расчёт и отправка `proxy://storage-stats-changed` вынесены из цикла `summary_rx` в отдельную фоновую задачу; `event_tx`, `removed_tx` и `bp_tx` переведены на ограниченные каналы с коалесценцией; базовый `Arc<rustls::ClientConfig>` для `wss://` и HTTPS upstream-прокси кэшируется в `SharedProxyContext` (включая TLS session resumption).
- **Холодный старт UI:** `src/lib/tauriBridge.ts` загружает `./previewEngine` динамически через `await import("./previewEngine")` строго при `!isTauriRuntime()`; из `src/lib/monaco.ts` удалены неиспользуемые `css.worker` и `html.worker` (снижение размера стартового бандла подтверждено выводом `npm run build`).
- **`[ARCH-02]` & `autofocus`:**
  - Все 5 продакшен-вызовов `reqwest::Url::parse` заменены на `url::Url::parse`, вариант `ProxyError::Reqwest` удалён из `models.rs`, а `reqwest` перенесён в `[dev-dependencies]` в `src-tauri/Cargo.toml`.
  - Удалены `clsx` и `tailwind-merge` из `package.json`; `tauriBridge.ts:469` переключён на `update_filter_backend_config`, дубль `update_proxy_filter_config` удалён из `commands.rs` и `lib.rs`; удалён шим `src/components/HostFiltersTab.tsx` (с обновлением импортов).
  - Во всех 8 UI-компонентах `{...({ autofocus: "" } ...)}` заменён на программный `ref.current?.focus()` после `showModal()` — `npm run test` проходит без единого предупреждения `Invalid DOM property autofocus` в `stderr`.
- **CI/CD (`.github/workflows/ci.yml`):** добавлены `--locked` к `cargo clippy` и `cargo test`, исключён повторный запуск `tsc` при `vite build`, добавлены проверка MSRV `1.80`, `npx @tauri-apps/cli build --no-bundle` и `cargo audit` / `npm audit --audit-level=high`.
- **Doc-vs-Code Sync:** актуализированы таймауты Python (`1500 мс` / `5000 мс` / `3000 мс`) в `PYTHON_SCRIPTING_GUIDE.md:437` и `PYTHON_SCRIPTING_AI_GUIDE.md:174-175`, пути `previewEngine.ts` и `export_import/har.rs` в `.agents/skills/fluxproxy-release/SKILL.md` и `references/release-checklist.md`, а также описания Linux PKI, `reqwest` dev-only, mTLS DPAPI Write-Only, DNS SSRF и GPO в `README.md` и `USER_GUIDE.md`.

### 📝 Промпт для Antigravity (Этап 47)

```markdown
Роль: Principal Full-Stack Performance & DevOps Engineer (Rust + Vite + Monaco + GitHub Actions).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Выполнить Этап 47 из ROADMAP.md — устранить узкие места TLS/UI/IPC (`PERF-04`, `PERF-05`), вынести симулятор из стартового бандла, закрыть техдолг `[ARCH-02]`, убрать предупреждения `autofocus`, усилить CI и синхронизировать документацию.

1. Оптимизация `ca.rs`, `proxyStore` и IPC-батчера (`[PERF-04]`, `[PERF-05]`, `src-tauri/src/proxy/ca.rs`, `connect_tunnel.rs`, `server/mod.rs`, `websocket_relay.rs`, `upstream_proxy.rs`, `src/stores/proxyStore.ts`, `src/hooks/useProxySessions.ts`):
   - В `ca.rs:475-524` (`server_config_for_host`) использовать коалесцирующий `self.leaf_cache.try_get_with(...)` и вызывать генерацию листовых сертификатов в `tokio::task::spawn_blocking` из `connect_tunnel.rs`.
   - В `server/mod.rs:896-994` вынести периодический расчёт `storage_stats()` из `tokio::select!` цикла `summary_rx` в отдельную задачу; заменить `unbounded_channel` на ограниченные каналы с безопасной коалесценцией; кэшировать общий `Arc<rustls::ClientConfig>` в `SharedProxyContext` для `wss://` и HTTPS upstream-прокси.
   - Добавить $O(1)$ индекс `sessionIndexById` в `proxyStore.ts` / `useProxySessions.ts`, убрав линейные `sessions.find(...)` из `flushBatches`.

2. Ленивый бандл фронтенда (Секция 6.3, `src/lib/tauriBridge.ts`, `src/lib/monaco.ts`):
   - Заменить статический импорт `previewEngine` в `src/lib/tauriBridge.ts` на динамический `await import("./previewEngine")` (вызываемый только при `!isTauriRuntime()`).
   - Удалить неиспользуемые статические импорты `css.worker` и `html.worker` (и их `features/css` / `features/html`) из `src/lib/monaco.ts:85-115`.

3. Закрытие `[ARCH-02]` и предупреждений `autofocus` (`Cargo.toml`, `models.rs`, `commands.rs`, `lib.rs`, `package.json`, `tauriBridge.ts`, `src/components/`):
   - Заменить все 5 вызовов `reqwest::Url::parse` (`filters/parsers.rs:568`, `http_handler.rs:163,2777`, `server/mod.rs:2228,2256`) на `url::Url::parse`, удалить `ProxyError::Reqwest` (`models.rs:892`) и перенести `reqwest` в `[dev-dependencies]` в `src-tauri/Cargo.toml`.
   - Удалить `clsx` и `tailwind-merge` из `package.json`; переключить `tauriBridge.ts:469` на `update_filter_backend_config` и удалить дубль `update_proxy_filter_config` из `commands.rs` и `lib.rs`; удалить шим `src/components/HostFiltersTab.tsx`.
   - Заменить `{...({ autofocus: "" } as Record<string, string>)}` на `ref.current?.focus()` после `showModal()` в 8 файлах (`CertificateModal.tsx`, `CodeSnippetModal.tsx`, `CommandPalette.tsx`, `ComposerPanel.tsx`, `OpenApiExportModal.tsx`, `SessionAnnotationModal.tsx`, `ShortcutsModal.tsx`, `filters/TlsBypassTab.tsx`), добившись чистого `stderr` в Vitest.

4. Усиление CI (`.github/workflows/ci.yml`) и Doc-vs-Code Sync (Секция 4.5):
   - Добавить `--locked` к `cargo clippy` и `cargo test`, убрать двойной запуск `tsc` (оставить `npm run typecheck` + `npx vite build`), добавить джоб проверки MSRV `1.80`, `npx @tauri-apps/cli build --no-bundle` и `cargo audit` / `npm audit --audit-level=high`.
   - Синхронизировать `PYTHON_SCRIPTING_GUIDE.md`, `PYTHON_SCRIPTING_AI_GUIDE.md`, `.agents/skills/fluxproxy-release/SKILL.md`, `references/release-checklist.md`, `README.md` и `USER_GUIDE.md` с актуальным кодом.

Проверка: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 49: Раздельное отсеивание статических ассетов (CSS, Images, Fonts) и JavaScript-скриптов
**Приоритет: P2 (Feature / Filtering) | Спринт 7 | Зависимости: Этапы 2 ✅, 4 ✅ | Тип: Product Improvement (Noise & Asset Filtering)**

### Цель и контекст
В текущей реализации (`v0.6.0`) отсеивание фронтенд-ресурсов реализовано одним монолитным переключателем `hideStaticAssets` / `hide_static_assets`, который не позволяет отфильтровать только один тип ресурсов или скрыть JavaScript-бандлы отдельно от картинок, стилей и шрифтов:
1. **Отсутствие фильтрации JavaScript и монолитный Regex/MIME-чек:**
   - В `src/lib/filterEngine.ts:748,1546-1556,2386-2396` и `src-tauri/src/proxy/filters/mod.rs:520,671-680,1233-1247` используется единое выражение `STATIC_ASSET_EXT_RE = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|css|map)(\?|$)/i` и один общий блок проверки `Content-Type` (`image/*`, `font/*`, `text/css`).
   - Из-за этого невозможно, например, скрыть тяжёлые `.js`/`.mjs` бандлы и source-map'ы при анализе REST/GraphQL API (не скрывая изображения), либо наоборот — скрыть CSS/шрифты/картинки, но оставить JS-скрипты (аналитика, ошибки, загрузка чанков).
   - Общий суффикс `.map` необходимо разделить по принадлежности (`.css.map` → CSS, `.js.map` / `.mjs.map` / `.cjs.map` → JavaScript), не задевая при этом JSON API (`.json` и `application/json`), а также расширить покрытие современными расширениями и legacy MIME-типами (`.avif`, `.bmp`, `.cur`, `.tiff?`, `.heic`, `.eot`, `application/font-woff`, `application/vnd.ms-fontobject`, `application/x-font-*`, `javascript`/`ecmascript`).
2. **Обратная совместимость `FluxUserSettingsProfile`, `localStorage` и пользовательских пресетов:**
   - Схемы `NoiseThresholdsConfig` / `NoiseThresholdsBackendSyncConfig` (`src/types/proxy.ts:231-242,283-292`), `NoiseThresholdsBackendConfig` (`src-tauri/src/models.rs:386-405`), `sanitizeThresholds` (`src/lib/settingsManager.ts:600-650,2873-2882`), `filterStore.ts:68-105` (ключи `fluxproxy.activeFilterState.v1`, `fluxproxy.customFilterPresets.v1`, `fluxproxy.backendFilterConfig.v1`) и встроенный пресет `"preset-backend-api"` (`filterEngine.ts:75-117`) завязаны на единый флаг `hideStaticAssets`.
   - При обновлении пользователей со старых JSON-профилей `schemaVersion: 1` или старого `localStorage` с `hideStaticAssets: true` нужно автоматически мигрировать его в `{ hideCss: true, hideImages: true, hideFonts: true, hideJs: false }`, чтобы не сломать прежнее поведение и **не скрыть JS внезапно без ведома пользователя**.
3. **Разрозненный подсчёт активных фильтров в UI и единая карточка `ThresholdsTab`:**
   - В `src/components/filters/ThresholdsTab.tsx:63-73` выводится одна карточка *«Скрывать статику (Images / Fonts / CSS)»*; при появлении 4 независимых тумблеров нужно сохранить удобство массового переключения в 1 клик.
   - Логика подсчёта активных порогов сейчас продублирована в 3 местах (`src/hooks/useProxySessions.ts:1220-1249`, `src/components/SettingsModal.tsx:990-994`, `src/components/settings/FiltersSettingsTab.tsx:112-122`), а в `SETTINGS_SEARCH_INDEX` (`SettingsModal.tsx:233-240`) отсутствуют ключевые слова для поиска JS/CSS/Images/Fonts.

### Критерии приемки (DoD)
- **Схема данных и паритет Rust ↔ TypeScript ↔ Browser Preview:**
  - В `NoiseThresholdsConfig`, `NoiseThresholdsBackendSyncConfig` (`src/types/proxy.ts`) и `NoiseThresholdsBackendConfig` (`src-tauri/src/models.rs`, `#[serde(default)]`) добавлены 4 независимых булевых поля: `hideCss`, `hideImages`, `hideFonts`, `hideJs` (`hide_css`, `hide_images`, `hide_fonts`, `hide_js` в Rust).
  - Старое поле `hideStaticAssets?: boolean` (`#[serde(default)] pub hide_static_assets: bool`) сохранено как опциональный вход обратной совместимости для чтения устаревших профилей и пресетов; в Rust `build_filter_engine_state` и TS-хелпере `normalizeNoiseThresholds` реализована единая миграция: если ни один из 4 гранулярных флагов не задан явно (или в Rust все 4 `false` при `hide_static_assets == true`), то `hideStaticAssets: true` преобразуется в `{ hideCss: true, hideImages: true, hideFonts: true, hideJs: false }`.
  - Миграция применяется при чтении `localStorage` (`LS_ACTIVE_FILTER_STATE_KEY`, `LS_CUSTOM_PRESETS_KEY`, `LS_BACKEND_FILTER_CFG_KEY` в `filterStore.ts`) и при валидации/импорте профилей в `settingsManager.ts` (используя все точки регистрации `FluxUserSettingsProfile`).
- **Точные правила матчинга по категориям (без ложных срабатываний на `.json`):**
  - Предкомпилированные регулярные выражения путей в `FilterEngineState` (`src-tauri/src/proxy/filters/mod.rs`) и модульные константы в `src/lib/filterEngine.ts` (единый helper для `matchesFilterMatrix` и `evaluatePreviewCaptureFilter`):
    - **CSS (`hideCss`):** MIME (`!isInFlight`): `ct.includes("text/css")`; путь: `/\.(css|css\.map)(\?|$)/i`.
    - **Images (`hideImages`):** MIME (`!isInFlight`): `ct.startsWith("image/")`; путь: `/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|cur|tiff?|heic)(\?|$)/i`.
    - **Fonts (`hideFonts`):** MIME (`!isInFlight`): `ct.startsWith("font/") || ct.includes("application/font-woff") || ct.includes("application/vnd.ms-fontobject") || ct.includes("application/x-font-")`; путь: `/\.(woff2?|ttf|otf|eot)(\?|$)/i`.
    - **JavaScript (`hideJs`):** MIME (`!isInFlight`): `ct.includes("javascript") || ct.includes("ecmascript")`; путь: `/\.(([cm]?js)(\.map)?|jsx)(\?|$)/i` (охватывает `.js`, `.mjs`, `.cjs`, `.jsx`, `.js.map`, `.mjs.map`, `.cjs.map` и гарантированно **не** матчит `.json` или `.jsp`).
  - Работает консистентно как при визуальной фильтрации (`matchesFilterMatrix`), так и при стриминговом отсеве `Drop Non-Matching` на бэкенде (`evaluate_should_store_session` в Rust и `evaluatePreviewCaptureFilter` в `BrowserPreviewEngine`).
- **UI, пресеты, поиск и единый счётчик фильтров:**
  - В `src/components/filters/ThresholdsTab.tsx` заменена единая карточка статики на 4 отдельных тумблера (*«Скрывать CSS»*, *«Скрывать Images»*, *«Скрывать Fonts»*, *«Скрывать JavaScript (JS)»*) + компактные 1-клик кнопки-чипы группы (*«Скрыть всё (4)»*, *«Только статика (CSS / Img / Fonts)»*, *«Сбросить»*).
  - Встроенный пресет `"preset-backend-api"` (`filterEngine.ts:75-117`) и его описание в `App.tsx:2458` обновлены: пресет активирует все 4 флага (`hideCss`, `hideImages`, `hideFonts`, `hideJs`).
  - Выделен единый чистый helper `countActiveNoiseThresholds(thresholds)` в `src/lib/filterEngine.ts` и подключён в `useProxySessions.ts`, `SettingsModal.tsx` и `FiltersSettingsTab.tsx` (с учётом всех 4 новых флагов).
  - В `SETTINGS_SEARCH_INDEX` (`SettingsModal.tsx:233-240`) добавлены ключевые слова `js`, `javascript`, `scripts`, `css`, `images`, `fonts`, `скрипты`, `стили`, `шрифты`, `картинки`.
- **Тесты:** добавлены unit-тесты в `src/lib/filterEngine.test.ts` (проверка каждого из 4 типов по отдельности, `.js.map` vs `.css.map`, неложность для `.json` / `application/json`, `preset-backend-api`), `src/lib/settingsManager.test.ts` (миграция старых профилей с `hideStaticAssets: true` и явных флагов), Rust-тесты в `src-tauri/src/proxy/filters/` (`evaluate_should_store_session` + legacy fallback `hide_static_assets`), а также обновлены тестовые фикстуры (`src/components/ui/ContextMenu.test.tsx`).

### 📝 Промпт для Antigravity (Этап 49)

```markdown
Роль: Senior Full-Stack Engineer (Rust + TypeScript + React 18 + Zustand 5).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Выполнить Этап 49 из ROADMAP.md — разделить опцию отсеивания статических ассетов на 4 независимых переключателя (`CSS`, `Images`, `Fonts`, `JavaScript`), добавить фильтрацию JS-скриптов с полным паритетом Rust ↔ TypeScript ↔ BrowserPreviewEngine и обратной совместимостью профилей/настроек.

1. Расширение контракта типов и обратная совместимость (`src/types/proxy.ts`, `src-tauri/src/models.rs`, `src/lib/filterEngine.ts`, `src/stores/filterStore.ts`, `src/lib/settingsManager.ts`):
   - В `NoiseThresholdsConfig`, `NoiseThresholdsBackendSyncConfig` (`src/types/proxy.ts:231-292`) и `NoiseThresholdsBackendConfig` (`src-tauri/src/models.rs:386-405`) добавить поля `hideCss: boolean`, `hideImages: boolean`, `hideFonts: boolean`, `hideJs: boolean` (`hide_css`, `hide_images`, `hide_fonts`, `hide_js` с `#[serde(default)]`).
   - Сохранить `hideStaticAssets?: boolean` (`#[serde(default)] pub hide_static_assets: bool`) исключительно как legacy-поле миграции. Реализовать чистую функцию `normalizeNoiseThresholds(raw)` в `filterEngine.ts`: если хотя бы одно из 4 новых полей задано явно, использовать их (отсутствующие считать `false`); если не задано ни одно и `raw.hideStaticAssets === true`, мигрировать в `{ hideCss: true, hideImages: true, hideFonts: true, hideJs: false }`.
   - Применить эту нормализацию в `filterStore.ts` (при чтении `LS_ACTIVE_FILTER_STATE_KEY`, `LS_CUSTOM_PRESETS_KEY`, `LS_BACKEND_FILTER_CFG_KEY`), в `settingsManager.ts` (`sanitizeThresholds` и `buildBackendFilterConfigFromProfile`) и зеркально в Rust `build_filter_engine_state` (`src-tauri/src/proxy/filters/mod.rs`).

2. Движки фильтрации по категориям (`src/lib/filterEngine.ts`, `src-tauri/src/proxy/filters/mod.rs`):
   - Предкомпилировать 4 регулярных выражения в `FilterEngineState` (Rust) и на уровне модуля `filterEngine.ts` (TS), не допуская компиляции Regex на горячем пути:
     - `CSS`: `!isInFlight && ct.includes("text/css")` ИЛИ путь `/\.(css|css\.map)(\?|$)/i`;
     - `Images`: `!isInFlight && ct.startsWith("image/")` ИЛИ путь `/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|cur|tiff?|heic)(\?|$)/i`;
     - `Fonts`: `!isInFlight && (ct.startsWith("font/") || ct.includes("application/font-woff") || ct.includes("application/vnd.ms-fontobject") || ct.includes("application/x-font-"))` ИЛИ путь `/\.(woff2?|ttf|otf|eot)(\?|$)/i`;
     - `JavaScript`: `!isInFlight && (ct.includes("javascript") || ct.includes("ecmascript"))` ИЛИ путь `/\.(([cm]?js)(\.map)?|jsx)(\?|$)/i` (обязательно исключить ложные срабатывания на `.json` / `application/json` и `.jsp`!).
   - Вынести общую проверку в helper `matchesHiddenAssetCategory(...)` в `filterEngine.ts` и использовать его как в `matchesFilterMatrix`, так и в `evaluatePreviewCaptureFilter` (для `BrowserPreviewEngine`), а в Rust обновить `evaluate_should_store_session` (`proxy/filters/mod.rs:671-680`).

3. UI, пресеты, поиск и единый счётчик (`src/components/filters/ThresholdsTab.tsx`, `src/components/SettingsModal.tsx`, `src/components/settings/FiltersSettingsTab.tsx`, `src/hooks/useProxySessions.ts`, `src/App.tsx`):
   - В `ThresholdsTab.tsx:63-73` заменить единый переключатель статики на 4 отдельных `NoiseToggleCard` (`Скрывать CSS`, `Скрывать Images`, `Скрывать Fonts`, `Скрывать JavaScript (JS)`) и добавить 1-клик чипы группы (*«Скрыть всё (4)»*, *«Только статика (CSS / Img / Fonts)»*, *«Сбросить»*).
   - Обновить встроенный пресет `"preset-backend-api"` (`filterEngine.ts:75-117`) на включение всех 4 опций (`hideCss`, `hideImages`, `hideFonts`, `hideJs`) и описание в `App.tsx:2458`.
   - Выделить `countActiveNoiseThresholds(thresholds)` в `filterEngine.ts` и заменить разрозненный подсчёт в `useProxySessions.ts:1220-1249`, `SettingsModal.tsx:990-994` и `FiltersSettingsTab.tsx:112-122`.
   - Расширить ключевые слова записи `"noise-thresholds"` в `SETTINGS_SEARCH_INDEX` (`SettingsModal.tsx:233-240`) словами `js`, `javascript`, `scripts`, `css`, `images`, `fonts`, `скрипты`, `стили`, `шрифты`, `картинки`.

4. Тесты: добавить unit-тесты для каждого из 4 фильтров (включая `.js.map` vs `.css.map` и защиту `.json`), миграции `hideStaticAssets: true` в Rust (`proxy/filters/tests.rs` / `mod.rs`), `filterEngine.test.ts` и `settingsManager.test.ts`; обновить фикстуры в `ContextMenu.test.tsx`.

Проверка: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 48: Стратегическая декомпозиция монолитов и закрытие пробелов компонентного тестирования
**Приоритет: P3 (Architecture & Test Coverage) | Спринт 7 | Зависимости: Этапы 44, 45, 47, 49 | Находки аудита: `ARCH-01`, `PERF-04` (AppContent) + Секция 6.1**

### Цель и контекст
Последний этап Спринта 7 снижает технический долг крупных файлов (`3 000–8 871` LOC), устраняет архитектурное дублирование конвейеров и закрывает критичные пробелы модульного и компонентного тестирования:
1. **`[ARCH-01]` Монолитные Rust-модули и дублирование конвейеров:** `src-tauri/src/proxy/server/mod.rs` разросся до `8 871` LOC за счёт `6 600` строк встроенных тестов (`2272–8871`); стадии pre-request/post-response продублированы между `http_handler.rs` (`3 522` LOC) и `composer_exec.rs` (`1 337` LOC), а установка транспорта 4 раза повторена в `websocket_relay.rs` (`2 044` LOC).
2. **`[ARCH-01]` & `[PERF-04]` Монолиты фронтенда и подписка `AppContent` на массив `sessions`:** `src/App.tsx` (`4 957` LOC) подписан через `useProxySessions()` на весь массив `sessions` (вызывая перерендер шапки, тулбара, сайдбара и статус-бара до `60` раз/сек); `src/lib/settingsManager.ts` занимает `3 492` LOC; хуки `useTheme.ts` и `useUiPreferences.ts` вешают глобальные `window`-слушатели при каждом монтировании.
3. **Пробелы тестового покрытия (Секция 6.1):** ручные `180+`-строчные `vi.hoisted` моки `proxyBridge` дублируются в `useProxySessions.test.tsx` и `settingsManager.test.ts`; полностью отсутствуют прямые тесты для `tauriBridge.ts`, `TrafficGrid.tsx` (`1 611` LOC), `SessionInspector.tsx` (`2 258` LOC) и `BreakpointsPanel.tsx` (`1 000` LOC).

### Критерии приемки (DoD)
- **Декомпозиция Rust (`[ARCH-01]`):**
  - Тесты `src-tauri/src/proxy/server/mod.rs:2272-8871` вынесены в модульный каталог `src-tauri/src/proxy/server/tests/` (`mod.rs` сокращён до `< 2 300` строк чистого контроллера).
  - Общие стадии (`HeaderMutations`, `bpu`, Python `on_request`/`on_response`, `AutoResponder`, фильтрация заголовков, запись ошибок и таймингов) выделены в `src-tauri/src/proxy/server/pipeline_stages.rs` и переиспользуются обоими конвейерами (`http_handler.rs` и `composer_exec.rs`) без изменения поведения стриминговых веток `4a`/`4b` и под защитой всех интеграционных тестов Rust.
  - 4 варианта установки апстрим-транспорта в `websocket_relay.rs` унифицированы в единый helper с сохранением mTLS и `UpstreamProxy`.
- **Декомпозиция фронтенда и изоляция подписок (`[ARCH-01]`, `[PERF-04]`):**
  - `src/lib/settingsManager.ts` разбит на сфокусированные модули (`src/lib/settings/schema.ts`, `migrations.ts`, `applyProfile.ts`) с barrel-реэкспортом в `settingsManager.ts` (без поломки существующих импортов).
  - Контейнеры рабочих вкладок выделены из `src/App.tsx` так, что высокочастотный массив `sessions` читается только внутри `TrafficWorkspace` (исключая ререндеры `MenuBar`, `TopToolbar`, `Sidebar` и статус-бара при приходе батчей трафика).
  - Глобальные `window.addEventListener` (`matchMedia`, `storage`, `SETTINGS_APPLIED_EVENT`) вынесены из `useTheme.ts` и `useUiPreferences.ts` в единый хук `useStoreGlobalSync()`, вызываемый строго один раз в `App.tsx`.
- **Закрытие пробелов тестирования (Секция 6.1):**
  - Выделена единая типизированная тестовая фабрика `createMockProxyBridge()` (устраняющая дублирующиеся `180+`-строчные `vi.hoisted` моки в `useProxySessions.test.tsx` и `settingsManager.test.ts`).
  - Добавлены unit/компонентные тесты: `src/lib/tauriBridge.test.ts` (Dual-Mode роутинг и `exportTextFile`), `src/components/TrafficGrid.test.tsx` (виртуализация, сортировка, мультивыбор, контекстное меню), `src/components/SessionInspector.test.tsx` (вкладки, подгрузка/отсечка `2 MiB`, панели WS/SSE) и `src/components/BreakpointsPanel.test.tsx` (выбор в очереди, ленивая догрузка тела `> 256 KiB`, `Continue`/`Abort`).

### 📝 Промпт для Antigravity (Этап 48)

```markdown
Роль: Principal Full-Stack Software Architect (Rust + React 18 + Zustand 5 + Vitest).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Выполнить Этап 48 из ROADMAP.md — провести поэтапную декомпозицию монолитов (`ARCH-01`), изолировать подписку `AppContent` на `sessions` (`PERF-04`) и закрыть пробелы тестирования фронтенда (Секция 6.1).

1. Декомпозиция Rust-ядра (`[ARCH-01]`, `src-tauri/src/proxy/server/`):
   - Вынести `6 600` строк тестов из `src-tauri/src/proxy/server/mod.rs:2272-8871` в модуль `src-tauri/src/proxy/server/tests/`.
   - Выделить общие стадии обработки (`HeaderMutations`, `bpu`, Python-хуки, `AutoResponder`, фильтрация заголовков, запись ошибок/таймингов) в `src-tauri/src/proxy/server/pipeline_stages.rs` и перевести на них `http_handler.rs` и `composer_exec.rs` (строго поэтапно, не ломая ветки стриминга `4a`/`4b` и сохраняя вызовы `in_flight_guard.disarm()`).
   - Унифицировать 4 копии установки апстрим-транспорта в `websocket_relay.rs` через общий helper.

2. Декомпозиция фронтенда и изоляция подписок (`[ARCH-01]`, `[PERF-04]`, `src/App.tsx`, `src/lib/settingsManager.ts`, `src/hooks/useTheme.ts`, `src/hooks/useUiPreferences.ts`):
   - Разбить `src/lib/settingsManager.ts` на `src/lib/settings/{schema,migrations,applyProfile}.ts`, сохранив публичный реэкспорт в `settingsManager.ts`.
   - Вынести рабочие экраны из `src/App.tsx` в изолированные контейнеры, оставив подписку на высокочастотный массив `sessions` исключительно внутри `TrafficWorkspace` (чтобы `MenuBar`, `TopToolbar`, `Sidebar` и футер не ререндерились на каждый батч трафика).
   - Вынести регистрацию глобальных `window`-слушателей (`matchMedia`, `storage`, `SETTINGS_APPLIED_EVENT`) из `useTheme.ts` и `useUiPreferences.ts` в единый хук `useStoreGlobalSync()`, вызываемый один раз в `App.tsx`.

3. Закрытие пробелов тестового покрытия (Секция 6.1, `src/`):
   - Создать общую типизированную фабрику `createMockProxyBridge()` (например, `src/test/mockProxyBridge.ts`) и перевести на неё `useProxySessions.test.tsx` и `settingsManager.test.ts` (с контролем `satisfies typeof proxyBridge`).
   - Написать новые Vitest-сьюты: `src/lib/tauriBridge.test.ts`, `src/components/TrafficGrid.test.tsx`, `src/components/SessionInspector.test.tsx` и `src/components/BreakpointsPanel.test.tsx`.

Проверка: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run test`, `npm run build`.
```


