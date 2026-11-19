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
    - Виртуализация `src/components/HexViewer.tsx` через `@tanstack/react-virtual` (без перерисовки всей таблицы на hover), настройка `manualChunks` в `vite.config.ts` (`monaco-editor`, `react-vendor`, `ui-vendor`), исправление багов в `BreakpointModal.tsx`, `ComposerPanel.tsx`, `AutoResponderPanel.tsx`, `SessionInspector.tsx` (`ws`/`wss`, токены загрузки тел), `TrafficGrid.tsx` (cleanup слушателей, `finally` для popover, `followTail` по хвостовому ID), `textWizard.ts` (JWT `null`-защита) и `mockTraffic.ts`.
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

> *Номера этапов (`10–13`) используются как стабильные идентификаторы задач (`phase-N`). Все секции документа ниже отсортированы строго в порядке выполнения сверху вниз. Завершенные этапы Спринта 1 (Этапы 14, 15, 20, 21, 25–28) выполнены в релизе `v0.2.0`, этапы Спринта 2 (Этапы 5, 16, 17, 23, 24, 29, 30) выполнены в релизе `v0.3.0`, а этапы Спринта 3 (Этапы 6, 7, 8, 9, 18, 19, 22) выполнены в релизе `v0.4.0` и перенесены в раздел реализованных этапов выше.*

| # | Этап | Приоритет | Спринт | Зависимости | Ключевая ценность |
| :-: | :--- | :--- | :--- | :--- | :--- |
| 1 | **[Этап 10](#этап-10-сетевая-инфраструктура-hosts-remapping-и-bandwidth-throttling)** | **P2 (Feature)** | Спринт 4 | Этап 15 ✅, 25 ✅ | Виртуальный DNS (`resolve` / `CONNECT`) без правки системного `hosts` и эмуляция медленных сетей |
| 2 | **[Этап 11](#этап-11-архитектурная-декомпозиция-монолитов-и-внедрение-zustand)** | **P2 (Feature)** | Спринт 4 | — | Разделение крупных Rust/React-модулей, внедрение `zustand` и `React.lazy()` Code Splitting |
| 3 | **[Этап 12](#этап-12-аналитика-и-визуализация-waterfall-timeline-и-статистика-трафика)** | **P2 (Feature)** | Спринт 4 | — | Виртуализированная каскадная диаграмма таймингов и сводный Markdown-отчет (P95, статусы, MIME) |
| 4 | **[Этап 13](#этап-13-расширенные-протоколы-upstream-proxy-chaining-и-ws-инъекция)** | **P2 (Feature)** | Спринт 4 | Этап 18 ✅, 25 ✅ | Каскадирование трафика через внешний HTTP/HTTPS/SOCKS5-прокси и отправка фреймов в открытые WS |

---

## ⚙️ Общие инженерные правила

1. **Изоляция новых подсистем (Modular-First Guardrail):**
   Ключевые файлы уже достигли крупных размеров (`src-tauri/src/proxy/server.rs` ~6.9k строк, `export_import.rs` ~3.5k, `useProxySessions.ts` ~3.1k, `SettingsModal.tsx` ~3.0k, `App.tsx` ~2.9k, `filters.rs` ~2.4k, `FilterDrawer.tsx` ~2.2k). При реализации этапов Спринта 4 **выносите новую логику в отдельные Rust-модули, TS-утилиты и React-компоненты**, минимизируя разрастание существующих монолитов до рефакторинга в Этапе 11.
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

## 🔵 Спринт 4 — P2 (Feature): Сетевая инфраструктура, декомпозиция и аналитика

---

## Этап 10: Сетевая инфраструктура: HOSTS Remapping и Bandwidth Throttling
**Приоритет: P2 (Feature) | Спринт 4 | Зависимости: Этап 15, Этап 25**

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

## Этап 11: Архитектурная декомпозиция монолитов и внедрение Zustand
**Приоритет: P2 (Feature) | Спринт 4 | Зависимости: нет**

### Цель и контекст
Крупнейшие файлы проекта (`server.rs`, `export_import.rs`, `filters.rs`, `sysproxy.rs`, `useProxySessions.ts`, `App.tsx`, `SettingsModal.tsx`, `tauriBridge.ts`, `FilterDrawer.tsx`, `filterEngine.ts`, `protocolInspectors.ts`, `settingsManager.ts`, `MenuBar.tsx`, `TopToolbar.tsx`, `TrafficGrid.tsx`) перегружены и затрудняют параллельную разработку, а состояние фронтенда передается десятками пропсов через `App.tsx`.

### Критерии приемки (DoD)
- Rust-ядро разложено на подмодули без изменения внешнего поведения:
  - `src-tauri/src/proxy/server/` (`mod.rs`, `http_handler.rs`, `connect_tunnel.rs`, `websocket_relay.rs`, `composer_exec.rs`, `mobile_portal.rs`);
  - `src-tauri/src/storage/export_import/` (`mod.rs`, `har.rs`, `saz.rs`, `raw.rs`, `sanitize.rs`);
  - при необходимости выделены подмодули в `filters/` и `sysproxy/`.
- Внедрен `zustand` (`useProxyStore`, `useFilterStore`, `useUiStore`), устранен сквозной prop-drilling из `App.tsx` и `useProxySessions.ts`.
- `FilterDrawer.tsx` и `SettingsModal.tsx` разбиты на компоненты вкладок (`src/components/filters/`, `src/components/settings/`).
- Тяжелые модальные окна и Monaco-представления загружаются через `React.lazy()` + `Suspense`, уменьшая стартовый JS-бандл.
- Все существующие Rust- и Vitest-тесты проходят без регрессий.

### 📝 Промпт для Antigravity (Этап 11)

```markdown
Роль: Principal Systems Architect & React Performance Specialist.
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Провести безопасную модульную декомпозицию крупных файлов Rust и React/TypeScript, внедрить `zustand` и настроить Code Splitting без изменения пользовательской функциональности.

1. Декомпозиция Rust-ядра:
   - Разбить `src-tauri/src/proxy/server.rs` на `src-tauri/src/proxy/server/{mod.rs, http_handler.rs, connect_tunnel.rs, websocket_relay.rs, composer_exec.rs, mobile_portal.rs}` (сохранив публичный API `ProxyEngineController`).
   - Разбить `src-tauri/src/storage/export_import.rs` на `src-tauri/src/storage/export_import/{mod.rs, har.rs, saz.rs, raw.rs, sanitize.rs}`.
   - При объеме > 2000 строк также вынести парсеры/тесты `filters.rs` в подмодули `src-tauri/src/proxy/filters/`.
   - Сохранить и прогнать все существующие Rust-тесты.

2. Декомпозиция фронтенда, Zustand и Code Splitting:
   - Установить `zustand`, выделить сторы `src/stores/{proxyStore.ts, filterStore.ts, uiStore.ts}` с сохранением синхронизации с `settingsManager.ts` и `localStorage`.
   - Разделить `SettingsModal.tsx` на вкладки в `src/components/settings/` и `FilterDrawer.tsx` на вкладки в `src/components/filters/`.
   - Перевести тяжелые модальные окна и редакторы (`SettingsModal`, `FilterDrawer`, `BreakpointModal`, `SessionDiffView`, `TextWizardModal`, `MobileSetupModal`, `ProxyDoctorModal`, `SanitizedExportModal`, `OpenApiExportModal`, `ScriptingPanel`) на `React.lazy()` + `Suspense`.

Проверка: убедиться в уменьшении размера стартового чанка `dist/assets/index-*.js`, выполнить `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run test`, `npm run build`.
```

---

## Этап 12: Аналитика и визуализация: Waterfall Timeline и статистика трафика
**Приоритет: P2 (Feature) | Спринт 4 | Зависимости: нет**

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
**Приоритет: P2 (Feature) | Спринт 4 | Зависимости: Этап 18 ✅, Этап 25 ✅**

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
