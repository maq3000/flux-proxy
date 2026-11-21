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

---

## 📋 Матрица приоритетов и порядок выполнения

> *Номера этапов (`10–13, 34`) используются как стабильные идентификаторы задач (`phase-N`). Все секции документа ниже отсортированы строго в порядке выполнения сверху вниз. Завершенные этапы Спринта 1 (Этапы 14, 15, 20, 21, 25–28) выполнены в релизе `v0.2.0`, этапы Спринта 2 (Этапы 5, 16, 17, 23, 24, 29, 30) выполнены в релизе `v0.3.0`, этапы Спринта 3 (Этапы 6, 7, 8, 9, 18, 19, 22) выполнены в релизе `v0.4.0`, а стабилизационный Спринт 4 (Этапы 31–33) выполнен в релизе `v0.4.1` и перенесен в раздел реализованных этапов выше.*

| # | Этап | Приоритет | Спринт | Зависимости | Ключевая ценность |
| :-: | :--- | :--- | :--- | :--- | :--- |
| 1 | **[Этап 10](#этап-10-сетевая-инфраструктура-hosts-remapping-и-bandwidth-throttling)** | **P2 (Feature)** | Спринт 5 | Этапы 15 ✅, 25 ✅, 33 ✅ | Виртуальный DNS (`resolve` / `CONNECT`) без правки системного `hosts` и эмуляция медленных сетей |
| 2 | **[Этап 11](#этап-11-архитектурная-декомпозиция-монолитов-внедрение-zustand-и-оптимизация-бандла)** | **P2 (Architecture / Perf)** | Спринт 5 | Этапы 31–33 ✅ | Разделение крупных Rust/React-модулей (`ARCH-01`), ленивый `BrowserPreviewEngine` и удаление `ts.worker` 7 МБ (`PERF-05`), внедрение `zustand` и `React.lazy()` |
| 3 | **[Этап 34](#этап-34-статистика-запроса-и-детальные-тайминги-в-стиле-fiddler-sessiontimers-метрики-соединения-и-панель-statistics)** | **P2 (Feature)** | Спринт 5 | Этапы 10, 11 | Детальные тайминги в стиле Fiddler (`DNS`/`TCP`/`TLS`/`TTFB`/`Receive`, `SessionTimers`), учёт wire/decoded-байт, переиспользование сокетов, реальный экспорт/импорт HAR/SAZ и панель `Statistics` |
| 4 | **[Этап 12](#этап-12-аналитика-и-визуализация-waterfall-timeline-и-статистика-трафика)** | **P2 (Feature)** | Спринт 5 | Этап 34 | Виртуализированная многофазная каскадная диаграмма (Waterfall) и сводный Markdown-отчет по всей выборке (P95, TTFB, статусы, MIME) |
| 5 | **[Этап 13](#этап-13-расширенные-протоколы-upstream-proxy-chaining-и-ws-инъекция)** | **P2 (Feature)** | Спринт 5 | Этапы 18 ✅, 25 ✅, 33 ✅ | Каскадирование трафика через внешний HTTP/HTTPS/SOCKS5-прокси и отправка фреймов в открытые WS |

---

## ❓ Открытые вопросы и продуктовые неоднозначности (По итогам аудита `v0.4.0`)

> Полный доказательный разбор исходных находок см. в [PROJECT_CONTEXT_AND_AUDIT.md](PROJECT_CONTEXT_AND_AUDIT.md). Вопросы по `VACUUM` (`BUG-03`), SQLite-индексам (`PERF-06`) и macOS Keychain закрыты в `v0.4.1`; ниже сохранены оставшиеся архитектурные и продуктовые развилки (`[Требует проверки]`):

1. **Вызов Python-хуков (`on_request` / `on_response`) для запросов из Request Composer (`src-tauri/src/proxy/server.rs`):**
   - *Фактическое поведение:* `execute_composed` пропускает запросы через Header Mutations, Live Breakpoints (`Before Request` / `After Response`) и AutoResponder, но полностью обходит `PythonScriptRunner`. Кроме того, в `_normalize_headers_in` (`src-tauri/src/scripting/python_runner.rs`) дублирующиеся одноимённые заголовки (например, несколько `Set-Cookie`) схлопываются до последнего значения при чтении словаря `headers` в Python.
   - *Неоднозначность:* Должны ли запросы из Composer проходить через активный Python-скрипт (например, для автоматического расчёта `X-Signature` / HMAC), или необходим отдельный чекбокс в UI Composer *«Run Python script hooks on composed requests»*?
2. **Хранение приватных ключей mTLS из защищённых паролем `.p12`/`.pfx` (`[SEC-06]`, `src-tauri/src/proxy/client_certs.rs`):**
   - *Фактическое поведение:* При импорте `.p12`/`.pfx` архив расшифровывается в памяти, после чего приватный ключ сохраняется на диск **в открытом текстовом виде (unencrypted PEM)** в `app_data_dir/client_certs/{id}.identity.pem`, а на Windows функция `write_bytes_securely` не применяет ни DPAPI, ни ограничивающий NTFS DACL (в `v0.4.1` пути строго изолированы внутри `storage_dir`).
   - *Неоднозначность:* Должен ли FluxProxy шифровать `{id}.identity.pem` и `fluxproxy-root-ca.key` на диске средствами ОС (Windows DPAPI `CryptProtectData` / OS Keychain), или для парольных корпоративных сертификатов дополнительно нужен режим *«Session-only (In-Memory)»* без записи ключа на диск?
3. **Расширенный контроль доступа для LAN-клиентов в режимах `AllInterfaces` (`0.0.0.0`) и `Specific` (`[SEC-03]`, `src-tauri/src/proxy/server.rs`):**
   - *Фактическое поведение:* В `v0.4.1` внешним LAN-клиентам запрещены `CONNECT`/HTTP-запросы на loopback/unspecified хосты (`127.0.0.1`, `localhost`, `::1`, `::ffff:127.0.0.1`) и отключено автоматическое прикрепление хозяйских mTLS-сертификатов. При этом само подключение к открытому порту в доверенной Wi-Fi сети не требует аутентификации.
   - *Неоднозначность:* Какой дополнительный UX контроля доступа предпочтителен для мобильной отладки: ручной список разрешённых IP (`Client IP Allowlist`), интерактивное подтверждение нового устройства в тосте UI или опциональная `Proxy-Authorization`?

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

## 🔵 Спринт 5 — P2 (Feature & Architecture): Сетевая инфраструктура, декомпозиция и аналитика

---

## Этап 10: Сетевая инфраструктура: HOSTS Remapping и Bandwidth Throttling
**Приоритет: P2 (Feature) | Спринт 5 | Зависимости: Этапы 15 ✅, 25 ✅, 33 ✅**

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
**Приоритет: P2 (Architecture & Performance) | Спринт 5 | Зависимости: Этапы 31–33 ✅ | Находки аудита: `ARCH-01`, `PERF-05`**

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

## Этап 34: Статистика запроса и детальные тайминги в стиле Fiddler (SessionTimers, метрики соединения и панель Statistics)
**Приоритет: P2 (Feature) | Спринт 5 | Зависимости: Этапы 10, 11**

### Цель и контекст
Сейчас FluxProxy фиксирует только суммарное время `duration_ms`, итоговый размер распакованного тела `body_size` и заглушечную строку `tls_version` (`"TLS 1.3 (MITM)"`), из-за чего невозможно отличить медленный DNS/TCP/TLS-хендшейк от высокого серверного TTFB, медленной скачки тела, задержки в Breakpoint/Python-скрипте или переиспользования keep-alive соединения. Кроме того, при экспорте `.har` (`src-tauri/src/storage/export_import/har.rs`) и `.saz` (`saz.rs`) тайминги фаз (`DNSTime`, `TCPConnectTime`, `HTTPSHandshakeTime`, `timings.dns/connect/ssl/receive`) и `<PipeInfo CltReuse Reused />` заполняются нулями/`-1`.

Задача — реализовать полноценную **статистику запроса и детальные тайминги на уровне Fiddler Classic**: точные метки времени жизненного цикла (`ACTUAL PERFORMANCE` / `SessionTimers`), разбивку длительности по сетевым и прокси-фазам, учёт «сырых» (wire/compressed) и распакованных байт заголовков и тела, реальную телеметрию клиентского и серверного соединений (IP:port, keep-alive reuse, реальный TLS-протокол/шифр/ALPN), полноценный round-trip таймингов в HAR 1.2 / Fiddler `.saz` и встроенную вкладку **`Statistics`** в `SessionInspector` (для 1 или нескольких выделенных сессий).

> **Важные технические нюансы:**
> - **Ограничение `reqwest 0.12` (black-box транспорт):** `reqwest::Client` скрывает этапы `TcpStream::connect`, `tokio-rustls` handshake, факт переиспользования соединения из пула (`Reused`), реальный upstream TLS cipher/версию и авто-распаковывает `gzip`/`br`/`deflate` до того, как прокси увидит сырой размер тела (`wire_body_size`). При этом в `src-tauri/Cargo.toml` уже подключены `hyper = "1.5"` (`full`), `hyper-util = "0.1"`, `tokio-rustls = "0.26"`, `rustls = "0.23"`, `x509-parser`, `flate2`, `brotli` и `zstd`, а в `http_handler.rs` уже реализована ограниченная декомпрессия `maybe_decompress_content_encodings`. Поэтому для честных Fiddler-таймингов (`DNSTime`, `TCPConnectTime`, `HTTPSHandshakeTime`, `ServerConnReused`, `wire_body_size`, реальный upstream TLS) необходимо вынести upstream-транспорт в отдельный инструментированный коннектор на базе `hyper_util::client::legacy::Client` (`src-tauri/src/proxy/upstream_client.rs`), интегрировав его с `HostRemapRegistry` (Этап 10), `ClientCertificateStore` (mTLS, Этап 18) и `ThrottleConfig` (Этап 10). Этот же коннектор впоследствии упростит Этап 13 (`GatewayTime` и Upstream Proxy Chaining).
> - **Клиентская сторона (`CltReuse` и реальный MITM TLS):** в `spawn_accept_loop` (`src-tauri/src/proxy/server/mod.rs`) и `connect_tunnel.rs` необходимо передавать `ClientConnContext` (`conn_id`, `connected_at`, `request_seq: AtomicU64`, `client_tls_handshake_ms`, реальные `protocol_version()`, `negotiated_cipher_suite()`, `alpn_protocol()` из `rustls::ServerConnection`), заменив захардкоженную строку `"TLS 1.3 (MITM)"`.
> - **Отделение прокси-оверхеда от сетевого времени:** время ожидания пользователя на Live Breakpoints (`breakpoint_pause_ms`), работы Python-хуков (`script_hook_ms`) и искусственной задержки AutoResponder (`autoresponder_delay_ms`) должно фиксироваться отдельно от `server_wait_ms` (TTFB) с отображением чистого сетевого времени (`net_elapsed_ms`), чтобы ручная пауза на брейкпоинте не искажала диагностику бэкенда.
> - **Особые типы сессий:** корректно фиксировать метрики для `SSE` (`text/event-stream` — TTFB до заголовков 200, время до 1-го события, итоговая длительность потока), zero-buffering стриминга (`206` / `video/*` / `> 2 MiB`), `CONNECT` Passthrough (отдельный учёт `tx_bytes` / `rx_bytes` и DNS+TCP), `WebSocket` (время 101-хендшейка + суммарные outbound/inbound байты и фреймы), `Composer` (`composer_exec.rs`) и локальных `Mock`-ответов.
> - **Спецификация HAR 1.2 и обратная совместимость:** в HAR 1.2 поле `timings.connect` **включает** `timings.ssl` (`connect = tcp_ms + tls_ms`, `ssl = tls_ms`, либо `-1.0` если не применимо); все новые поля в `SessionSummary` и `SessionDetail` должны иметь `#[serde(default, skip_serializing_if = "Option::is_none")]`, чтобы старые базы `sessions.sqlite` и JSON-архивы десериализовались без миграции схемы.
> - **Приватность при санитизации (`sanitize.rs`):** при включённом `anonymize_client_info` в `SanitizationOptions` очищать/маскировать дублирующиеся сетевые адреса клиента (`client_addr`/`client_ip`) и при необходимости учитывать приватные адреса в экспортируемых метаданных статистики.

### Критерии приемки (DoD)
- **Модели данных (`src-tauri/src/models.rs` ↔ `src/types/proxy.ts`):**
  - Добавлены опциональные структуры `SessionTimings` (12 меток жизненного цикла Fiddler `client_connected` … `client_done_response` в RFC 3339 с микросекундами + фазы `client_read_ms`, `client_tls_handshake_ms`, `dns_ms`, `tcp_connect_ms`, `tls_handshake_ms`, `send_request_ms`, `server_wait_ms`, `content_download_ms`, `client_send_ms`, `breakpoint_pause_ms`, `script_hook_ms`, `autoresponder_delay_ms`, `proxy_overhead_ms`, `overall_elapsed_ms`, `net_elapsed_ms`) и `SessionTransferStats` (байты заголовков/тела запроса и ответа, `response_wire_body_bytes` vs `response_body_bytes`, `response_content_encoding`, `client_conn_id`/`client_conn_reused`, `client_tls_version`/`cipher`/`alpn`, `server_addr`/`server_ip`/`server_port`, `server_conn_id`/`server_conn_reused`, `server_http_version`, `server_tls_version`/`cipher`/`alpn`, `server_cert_subject`/`issuer`, `server_mtls_cn`, `remapped_target`).
  - В `SessionSummary` добавлены лёгкие опциональные поля (`ttfb_ms`, `dns_ms`, `connect_ms`, `tls_ms`, `receive_ms`, `request_size`, `wire_body_size`, `server_ip`, `server_conn_reused`) для мгновенной агрегации по N выделенным строкам, подсказок в таблице и многофазного Waterfall (Этап 12) без лишних IPC-запросов `get_session_detail`.
- **Инструментированный Rust-транспорт (`src-tauri/src/proxy/upstream_client.rs`, `server/{mod,http_handler,connect_tunnel,composer_exec,websocket_relay}.rs`, `client_certs.rs`):**
  - Реализован `InstrumentedUpstreamClient` на `hyper_util::client::legacy::Client` с поэтапным замером DNS → TCP Connect → TLS Handshake, определением `server_conn_reused` через `Connected::extra`, сбором `remote_addr`, реальных TLS-параметров и сырых `wire`-байт до распаковки, поддержкой mTLS, `HostRemapRegistry`, `ThrottleConfig`, HTTP/1.1 + HTTP/2 и ретрая устаревшего соединения из пула.
  - В `server/mod.rs` и `connect_tunnel.rs` добавлен `ClientConnContext` (`CltReuse`, время клиентского TLS-хендшейка, реальные `protocol_version` и `cipher_suite`), а в `http_handler.rs` — замер `client_read_ms`, `breakpoint_pause_ms`, `script_hook_ms`, `autoresponder_delay_ms`, `server_wait_ms` (TTFB), `content_download_ms` и `client_send_ms`.
- **Реальный экспорт/импорт HAR 1.2 и Fiddler `.saz` (`src-tauri/src/storage/export_import/{har,saz,sanitize}.rs`):**
  - Экспорт HAR заполняет реальные `timings` (соблюдая правило `connect = tcp + ssl`), `serverIPAddress`, `connection`, `headersSize`, `bodySize` (wire) и `content.compression`; импорт HAR восстанавливает `SessionTimings` и `SessionTransferStats`.
  - Экспорт `.saz` заполняет все атрибуты `<SessionTimers ... />`, `<PipeInfo CltReuse="..." Reused="..." />` и флаги `x-hostip`/`https-server-cipher`; импорт `.saz` парсит реальные `<SessionTimers>` и `<PipeInfo>` из архивов Fiddler Classic.
- **Фронтенд: панель `Statistics`, утилиты расчёта и таблица (`src/lib/requestStatistics.ts`, `src/components/SessionStatisticsPanel.tsx`, `src/components/SessionInspector.tsx`, `src/components/TrafficGrid.tsx`, `src/hooks/useUiPreferences.ts`):**
  - В заголовке `SessionInspector` добавлен переключатель режимов **`Inspectors` | `Statistics`** (плюс быстрый переход по клику на бейдж длительности `size • duration` в шапке инспектора).
  - Режим **1 сессии**: горизонтальная сегментированная шкала фаз (`DNS`, `TCP`, `TLS`, `Send`, `Wait (TTFB)`, `Download`, `Proxy/Breakpoint`), хронологическая таблица `ACTUAL PERFORMANCE` (`HH:MM:SS.fff` + `+Δ ms`), карточка объёма данных и сжатия (`Bytes Sent / Received`, Headers vs Body, Wire vs Decoded, экономия `%`, скорость `KB/s`), карточка `Connection & TLS` (Client ↔ Server, `Reused`, IP:port, шифр, ALPN, сертификат), сворачиваемый блок **Estimated Worldwide Performance** (как в Fiddler Classic) и кнопки `Copy Fiddler Text` / `Copy Markdown`.
  - Режим **множественного выделения (2+ сессии)**: сводная статистика по выделенным строкам в стиле Fiddler (`Request Count`, `Bytes Sent/Received` + экономия сжатия, `Overall Elapsed`, `Avg / Median / P95 / P99` Total и TTFB, `% Reused`, распределение статус-кодов и байт по MIME со встроенной SVG-диаграммой, топ медленных/крупных запросов с переходом по клику).
  - В `TrafficGrid.tsx` добавлен богатый tooltip с разбивкой фаз на ячейке `Time` и две опциональные сортируемые колонки `TTFB` (`ttfb`) и `Server IP` (`serverIp`) (скрытые по умолчанию, с обратной совместимостью `FluxUserSettingsProfile` в `src/types/settings.ts` и `src/lib/settingsManager.ts`).
  - Реалистичные синтетические тайминги и сетевые метрики добавлены в `src/lib/mockTraffic.ts` и `src/lib/tauriBridge.ts` для Browser Preview.
- **Тесты и проверки:** unit/интеграционные тесты в Rust (замеры холодного vs переиспользованного соединения, сжатие wire vs decoded, round-trip HAR/SAZ таймингов, обратная совместимость SQLite) и Vitest-тесты для `src/lib/requestStatistics.ts`.

### 📝 Промпт для Antigravity (Этап 34)

```markdown
Роль: Principal Rust Networking Engineer & Frontend Developer (Tauri v2 + Hyper + Rustls + React 19 + TypeScript).
Проект: FluxProxy (Tauri v2 + Tokio + Hyper 1.5 + Rustls + React 19 + Zustand).

Задача: Реализовать детальную статистику запроса и пофазные тайминги в стиле Fiddler Classic (`SessionTimers`, метрики байт/сжатия и соединения, реальный HAR/SAZ round-trip и вкладку `Statistics` в `SessionInspector`).

1. Модели данных (`src-tauri/src/models.rs`, `src/types/proxy.ts`):
   - Добавить структуры `SessionTimings` (RFC 3339 микросекундные метки `client_connected`, `client_begin_request`, `got_request_headers`, `client_done_request`, `proxy_begin_request`, `server_connected`, `server_got_request`, `server_begin_response`, `got_response_headers`, `server_done_response`, `client_begin_response`, `client_done_response` и фазы `Option<f64>` в мс: `client_read_ms`, `client_tls_handshake_ms`, `dns_ms`, `tcp_connect_ms`, `tls_handshake_ms`, `send_request_ms`, `server_wait_ms`, `content_download_ms`, `client_send_ms`, `breakpoint_pause_ms`, `script_hook_ms`, `autoresponder_delay_ms`, `proxy_overhead_ms`, `overall_elapsed_ms`, `net_elapsed_ms`) и `SessionTransferStats` (размеры заголовков/тела запроса и ответа, `request_wire_body_bytes`, `response_wire_body_bytes`, `response_content_encoding`, `client_conn_id`, `client_conn_reused`, `client_http_version`, `client_tls_version`, `client_tls_cipher`, `client_alpn`, `server_addr`, `server_ip`, `server_port`, `server_conn_id`, `server_conn_reused`, `server_http_version`, `server_tls_version`, `server_tls_cipher`, `server_tls_alpn`, `server_cert_subject`, `server_cert_issuer`, `server_mtls_cn`, `remapped_target`, `is_streaming`).
   - Прикрепить `timings: Option<SessionTimings>` и `transfer_stats: Option<SessionTransferStats>` к `SessionDetail` с `#[serde(default, skip_serializing_if = "Option::is_none")]` (сохраняя 100% обратную совместимость `sessions.sqlite`).
   - В `SessionSummary` добавить компактные опциональные поля `ttfb_ms`, `dns_ms`, `connect_ms`, `tls_ms`, `receive_ms`, `request_size`, `wire_body_size`, `server_ip`, `server_conn_reused` (`#[serde(default, skip_serializing_if = "Option::is_none")]`).

2. Инструментированный upstream-транспорт и клиентские тайминги (`src-tauri/Cargo.toml`, `src-tauri/src/proxy/upstream_client.rs`, `src-tauri/src/proxy/client_certs.rs`, `src-tauri/src/proxy/server/{mod,http_handler,connect_tunnel,composer_exec,websocket_relay}.rs`):
   - Включить фичу `client-legacy` у `hyper-util` (и при необходимости `rustls-native-certs` / `tower-service`) в `Cargo.toml`.
   - Создать модуль `src-tauri/src/proxy/upstream_client.rs`: кастомный `InstrumentedConnector` для `hyper_util::client::legacy::Client` (HTTP/1.1 + HTTP/2 + `tokio-rustls`), замеряющий отдельно DNS (с поддержкой `HostRemapRegistry`), `TcpStream::connect` (`tcp_connect_ms`, `server_addr`), `TlsConnector::connect` (`tls_handshake_ms`, реальные `protocol_version`, `cipher_suite`, `alpn`, `peer_certificates` subject/issuer, опциональный mTLS из `ClientCertificateStore`) и переиспользование соединения из пула (`AtomicBool` в `Connected::extra` → первый запрос забирает DNS/TCP/TLS и `server_conn_reused = false`, последующие получают `server_conn_reused = true` и `0.0 ms`).
   - Обернуть тело запроса и исходящего ответа лёгкими счётчиками для фиксации `server_got_request` (`send_request_ms`), `wire_response_body_bytes` (до `maybe_decompress_content_encodings`) и `client_done_response` (`client_send_ms`). Сохранить поддержку ретрая stale-соединения для идемпотентных запросов и redirect-цикл для `Composer`.
   - В `server/mod.rs` (`spawn_accept_loop`) и `connect_tunnel.rs` ввести `ClientConnContext` (`conn_id`, `connected_at`, `request_seq`, `client_tls_handshake_ms`, реальный MITM TLS protocol/cipher/ALPN), заменив хардкод `"TLS 1.3 (MITM)"`.
   - В `http_handler.rs`, `connect_tunnel.rs`, `websocket_relay.rs` и `composer_exec.rs` заполнить `SessionTimings` и `SessionTransferStats` для всех веток: обычные HTTP/HTTPS, SSE, zero-buffering streaming (`206`/`video/*`/`>2 MiB`), `CONNECT` Passthrough (`tx_bytes` / `rx_bytes`), WebSocket, Live Breakpoints (`breakpoint_pause_ms`), Python hooks (`script_hook_ms`), AutoResponder (`autoresponder_delay_ms` / Mock).

3. HAR 1.2, Fiddler `.saz` и санитизация (`src-tauri/src/storage/export_import/{har,saz,sanitize}.rs`):
   - В `har.rs` при экспорте записывать реальные `HarTimings` (помня правило HAR 1.2: `connect = tcp_connect_ms + tls_handshake_ms`, `ssl = tls_handshake_ms`, `-1.0` если неприменимо), `serverIPAddress`, `connection`, `headersSize`, `bodySize` (wire), `content.compression` и lossless-поля в `_fluxProxy`; при импорте восстанавливать `SessionTimings` и `SessionTransferStats`.
   - В `saz.rs` при экспорте записывать реальные метки и длительности в `<SessionTimers ... />`, реальный `<PipeInfo CltReuse="..." Reused="..." />` и `SessionFlag` (`x-hostip`, `https-server-cipher`); при импорте парсить `<SessionTimers>` и `<PipeInfo>` из реальных `.saz` Fiddler Classic.
   - В `sanitize.rs` при `anonymize_client_info: true` корректно маскировать клиентские адреса в `transfer_stats` / `SessionSummary`.

4. Frontend: расчёт статистики, панель `Statistics` и колонки таблицы (`src/lib/requestStatistics.ts`, `src/components/SessionStatisticsPanel.tsx`, `src/components/SessionInspector.tsx`, `src/components/TrafficGrid.tsx`, `src/hooks/useUiPreferences.ts`, `src/types/settings.ts`, `src/lib/settingsManager.ts`, `src/lib/mockTraffic.ts`, `src/lib/tauriBridge.ts`, `src/App.tsx`):
   - Вынести чистые вычисления и форматирование в `src/lib/requestStatistics.ts`: нормализация фаз тайминга, расчёт экономии сжатия и скорости передачи, оценка `Estimated Worldwide Performance` по профилям RTT/скорости, агрегация по массиву `SessionSummary[]` (Request Count, Bytes Sent/Received, Overall Elapsed, Avg/P50/P95/P99 Latency & TTFB, Status/MIME breakdown, Top Slowest/Largest), генерация отчётов `formatFiddlerStatisticsText` и `formatStatisticsMarkdown`.
   - Создать `src/components/SessionStatisticsPanel.tsx` с двумя режимами:
     - **Single Session:** визуальный горизонтальный Timing Breakdown Bar с тултипами, таблица `ACTUAL PERFORMANCE` (Fiddler timestamps + `+Δ ms`), карточка `Bytes & Compression` (Headers/Body, Wire vs Decoded, Savings %, Throughput), карточка `Connection & TLS` (Client ↔ Server, `Reused`, IP:port, шифр, ALPN, сертификат), сворачиваемый `Estimated Worldwide Performance`, кнопки копирования Text / Markdown.
     - **Multi-Selection (2+ сессий):** сводные KPI, распределение статус-кодов и байт по MIME (лёгкий inline SVG без сторонних chart-библиотек), топ-5 медленных и крупных URL с кликом перехода к сессии.
   - Интегрировать переключатель **`Inspectors` | `Statistics`** в шапку `SessionInspector.tsx` (клик по метрике `size • duration` также открывает `Statistics`; при выделении 2+ сессий передавать `selectedSessions` из `App.tsx` для мульти-статистики).
   - В `TrafficGrid.tsx` добавить tooltip с разбивкой фаз на ячейке `Time` и опциональные сортируемые колонки `ttfb` (`TTFB`) и `serverIp` (`Server IP`) со скрытым дефолтом и обратной совместимостью в `settings.ts` / `settingsManager.ts`.
   - Обновить `src/lib/mockTraffic.ts` и `src/lib/tauriBridge.ts` реалистичными таймингами (cold connect vs reused) и сетевыми метриками.

5. Верификация и тесты:
   - Добавить Rust-тесты в `upstream_client.rs` / `server/mod.rs` (холодное vs переиспользованное соединение, gzip/zstd wire vs decoded bytes, тайминги Breakpoint/Mock) и `export_import` (HAR 1.2 + Fiddler `.saz` timers round-trip).
   - Добавить `src/lib/requestStatistics.test.ts` (Vitest) для расчёта фаз, сжатия, перцентилей, Worldwide Performance и Fiddler/Markdown-форматирования.
   - Выполнить: `npm run typecheck`, `npm run test`, `npm run build`, `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`.
```

---

## Этап 12: Аналитика и визуализация: Waterfall Timeline и статистика трафика
**Приоритет: P2 (Feature) | Спринт 5 | Зависимости: Этап 34**

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

---

## Этап 13: Расширенные протоколы: Upstream Proxy Chaining и WS-инъекция
**Приоритет: P2 (Feature) | Спринт 5 | Зависимости: Этапы 18 ✅, 25 ✅, 33 ✅**

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
