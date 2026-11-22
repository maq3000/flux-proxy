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
31. **[Этап 31 — Выполнено] Критическая безопасность: защита импорта профилей (RCE), изоляция файлового IPC, санитизация PII/SSE/WS и защита от OOM-бомб (`SEC-01`..`SEC-06`, `BUG-12`):**
    - Превью и принудительное отключение импортируемых Python-скриптов по умолчанию (до явного подтверждения доверия пользователем) в `src/types/settings.ts`, `src/lib/settingsManager.ts`, `src/components/SettingsModal.tsx` и `src/App.tsx`.
    - Жёсткая валидация пользовательских путей `validate_user_file_path` (запрет `..`, UNC, NTFS ADS и DOS-устройств) и лимит `16 MiB` для `import_settings_file` в `src-tauri/src/commands.rs`, изоляция `stored_cert_path` внутри `storage_dir` в `src-tauri/src/proxy/client_certs.rs`.
    - Блокировка LAN SSRF к loopback/unspecified (включая `::ffff:127.0.0.1`), проверка `is_builtin_portal_target` до `CONNECT`, запрет перенаправления через внутренний заголовок `Host` в `TargetedOnly` и изоляция хозяйских mTLS-сертификатов от внешних LAN-клиентов в `src-tauri/src/proxy/server.rs`.
    - Нормализация ключей в `mask_sensitive_json_value` (`camelCase`), пересборка санитизированных тел SSE/WebSocket (включая SignalR, Socket.IO, Bearer и JWT), санитизация `userinfo`/`#fragment` и заголовков `Location`/`Referer` в `src-tauri/src/storage/export_import.rs`, `src-tauri/src/models.rs` и `src/components/SanitizedExportModal.tsx`.
    - Ограниченная потоковая декомпрессия `zstd` (`decode_zstd_bounded`) и кодеков (`src-tauri/src/proxy/codec.rs`), кумулятивный лимит `512 MiB` / `2` слоя `Content-Encoding` и поддержка `zstd` в `.saz`, а также безопасный `chrono::TimeDelta::try_milliseconds` при экспорте `.saz`; покрыто тестами в Rust и `src/lib/settingsManager.test.ts`.
32. **[Этап 32 — Выполнено] Целостность хранилища `TrafficStore` + SQLite и реактивного состояния UI (`BUG-01`, `BUG-02`, `BUG-03`, `BUG-08`, `BUG-11`, `PERF-01`, `PERF-02`, `PERF-06`):**
    - Инициализация `next_id` из `SqliteStore::max_persisted_session_id`, добавление `TrafficStore::get_in_ram` (без синхронных обращений к SQLite на `record_in_flight_session`), приоритизация RAM перед `offloaded_bodies` и сохранение выгруженных тел (`> 2 MiB`) активных RAM-сессий при `clear_sqlite_archive` (`purge_and_vacuum_preserving`) в `src-tauri/src/storage/mod.rs`, `sqlite.rs` и `proxy/server.rs`.
    - Перенос `PRAGMA busy_timeout = 5000` перед `WAL`, удаление неиспользуемых индексов `idx_sessions_url`/`idx_sessions_status`, защита `clear()` и `remove_many()` через `eviction_lock`, а также пакетное вытеснение с гистерезисом (`EVICTION_HYSTERESIS_BATCH = 64`) после успешного `persist_batch`.
    - Устойчивая регистрация IPC-подписок в `bootstrap()` с откатом к `127.0.0.1` при ошибке бинда, дедупликация батчей в `flushPendingSessions` на пустой таблице и удаление `sessions.length` из зависимостей `getSessionDetail` в `src/hooks/useProxySessions.ts`; покрыто Rust-тестами и `src/hooks/useProxySessions.test.tsx`.
33. **[Этап 33 — Выполнено] Надежность сетевого ядра, протоколов HTTP/WS/TLS, фильтров и диагностики (`BUG-04`..`BUG-07`, `BUG-09`, `BUG-10`, `BUG-13`, `PERF-03`, `PERF-04`):**
    - RAII-гард `PendingBreakpointGuard` в `src-tauri/src/proxy/breakpoints.rs` и `server.rs` (статус `499` и `proxy://breakpoints-changed` при разрыве соединения) + запись статуса `502` при `Abort` в Composer; таймаут `connect_async` и неблокирующий двунаправленный релей WebSocket без взаимной блокировки.
    - Проверка отпечатка SHA-256 активного Root CA в Windows (`certutil`) и macOS (`security`) в `src-tauri/src/proxy/ca.rs`; сохранение `Content-Length` для `HEAD` и точное снятие `Content-Encoding` только для распакованных слоёв в `server.rs`.
    - Поддержка суффиксных масок `.domain.com`, единый разбор IPv6 `[::1]:port` и полная предкомпиляция Regex в `ProxyFilterEngine` (`src-tauri/src/proxy/filters.rs`) при обновлении конфига; откат `sysproxy` и `proxy://status-changed` в `set_bind_configuration`, стабилизация `ProxyDoctor` (`retry_attempts = 6/3` и отмена timed-out листенеров при shutdown в `doctor.rs`/`server.rs`).
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

> *Номера этапов (`12`) используются как стабильные идентификаторы задач (`phase-N`). Все секции документа ниже отсортированы строго в порядке выполнения сверху вниз. Завершенные этапы Спринта 1 (Этапы 14, 15, 20, 21, 25–28) выполнены в релизе `v0.2.0`, этапы Спринта 2 (Этапы 5, 16, 17, 23, 24, 29, 30) выполнены в релизе `v0.3.0`, этапы Спринта 3 (Этапы 6, 7, 8, 9, 18, 19, 22) выполнены в релизе `v0.4.0`, стабилизационный Спринт 4 (Этапы 31–33) выполнен в релизе `v0.4.1`, а этапы Спринта 5 (Этапы 10, 11, 13, 34) выполнены в релизе `v0.5.0` и перенесены в раздел реализованных этапов выше.*

| # | Этап | Приоритет | Спринт | Зависимости | Ключевая ценность |
| :-: | :--- | :--- | :--- | :--- | :--- |
| 1 | **[Этап 12](#этап-12-аналитика-и-визуализация-waterfall-timeline-и-статистика-трафика)** | **P2 (Feature)** | Спринт 5 | Этап 34 ✅ | Виртуализированная многофазная каскадная диаграмма (Waterfall) и сводный Markdown-отчет по всей выборке (P95, TTFB, статусы, MIME) |

---

## ❓ Открытые вопросы и продуктовые неоднозначности (По итогам аудита `v0.4.0`)

> Полный доказательный разбор исходных находок см. в [PROJECT_CONTEXT_AND_AUDIT.md](PROJECT_CONTEXT_AND_AUDIT.md). Вопросы по `VACUUM` (`BUG-03`), SQLite-индексам (`PERF-06`) и macOS Keychain закрыты в `v0.4.1`; ниже сохранены оставшиеся архитектурные и продуктовые развилки (`[Требует проверки]`):

1. **Вызов Python-хуков (`on_request` / `on_response`) для запросов из Request Composer (`src-tauri/src/proxy/server/composer_exec.rs`):**
   - *Фактическое поведение:* `execute_composed` пропускает запросы через Header Mutations, Live Breakpoints (`Before Request` / `After Response`) и AutoResponder, но полностью обходит `PythonScriptRunner`. Кроме того, в `_normalize_headers_in` (`src-tauri/src/scripting/python_runner.rs`) дублирующиеся одноимённые заголовки (например, несколько `Set-Cookie`) схлопываются до последнего значения при чтении словаря `headers` в Python.
   - *Неоднозначность:* Должны ли запросы из Composer проходить через активный Python-скрипт (например, для автоматического расчёта `X-Signature` / HMAC), или необходим отдельный чекбокс в UI Composer *«Run Python script hooks on composed requests»*?
2. **Хранение приватных ключей mTLS из защищённых паролем `.p12`/`.pfx` (`[SEC-06]`, `src-tauri/src/proxy/client_certs.rs`):**
   - *Фактическое поведение:* При импорте `.p12`/`.pfx` архив расшифровывается в памяти, после чего приватный ключ сохраняется на диск **в открытом текстовом виде (unencrypted PEM)** в `app_data_dir/client_certs/{id}.identity.pem`, а на Windows функция `write_bytes_securely` не применяет ни DPAPI, ни ограничивающий NTFS DACL (в `v0.4.1` пути строго изолированы внутри `storage_dir`).
   - *Неоднозначность:* Должен ли FluxProxy шифровать `{id}.identity.pem` и `fluxproxy-root-ca.key` на диске средствами ОС (Windows DPAPI `CryptProtectData` / OS Keychain), или для парольных корпоративных сертификатов дополнительно нужен режим *«Session-only (In-Memory)»* без записи ключа на диск?
3. **Расширенный контроль доступа для LAN-клиентов в режимах `AllInterfaces` (`0.0.0.0`) и `Specific` (`[SEC-03]`, `src-tauri/src/proxy/server/mod.rs`, `http_handler.rs`):**
   - *Фактическое поведение:* В `v0.4.1` внешним LAN-клиентам запрещены `CONNECT`/HTTP-запросы на loopback/unspecified хосты (`127.0.0.1`, `localhost`, `::1`, `::ffff:127.0.0.1`) и отключено автоматическое прикрепление хозяйских mTLS-сертификатов. При этом само подключение к открытому порту в доверенной Wi-Fi сети не требует аутентификации.
   - *Неоднозначность:* Какой дополнительный UX контроля доступа предпочтителен для мобильной отладки: ручной список разрешённых IP (`Client IP Allowlist`), интерактивное подтверждение нового устройства в тосте UI или опциональная `Proxy-Authorization`?

---

## ⚙️ Общие инженерные правила

1. **Изоляция новых подсистем (Modular-First Guardrail):**
   После архитектурной декомпозиции в Этапе 11 (`v0.5.0`) крупные подсистемы разнесены по модулям (`src-tauri/src/proxy/server/`, `proxy/filters/`, `storage/export_import/`, `src/stores/`, `src/components/filters/`, `src/components/settings/`). При реализации новых этапов **продолжайте выносить новую логику в отдельные Rust-модули, TS-утилиты и React-компоненты**, избегая повторного разрастания `App.tsx`, `tauriBridge.ts`, `settingsManager.ts` и `useProxySessions.ts`.
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

## 🔵 Спринт 5 — P2 (Feature & Architecture): Аналитика и визуализация

---

## Этап 12: Аналитика и визуализация: Waterfall Timeline и статистика трафика
**Приоритет: P2 (Feature) | Спринт 5 | Зависимости: Этап 34 ✅**

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