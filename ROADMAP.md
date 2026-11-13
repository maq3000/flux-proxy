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

---

## 📋 Матрица приоритетов и порядок выполнения

> *Номера этапов (`5–30`) используются как стабильные идентификаторы задач (`phase-N`). Все секции документа ниже отсортированы строго в порядке выполнения сверху вниз.*

| # | Этап | Приоритет | Спринт | Зависимости | Ключевая ценность |
| :-: | :--- | :--- | :--- | :--- | :--- |
| 1 | **[Этап 26](#этап-26-безопасность-защита-от-xss-и-инъекций-csp-и-устранение-ub-в-rust)** | **P0 (Critical)** | Спринт 1 | — | Устранение XSS/инъекций (`host_header`, SVG `data:`, `pkexec`, `adb`/cURL, CRLF), валидация IPC-путей, CSP и починка UB/паник в Rust (`process.rs`, `network.rs`, `sysproxy.rs`, `filters.rs`) |
| 2 | **[Этап 27](#этап-27-целостность-trafficstore-и-sqlite-безопасность-парсеров-saz-и-консистентность-ca)** | **P0 (Critical)** | Спринт 1 | — | SQLite `busy_timeout` и дочитка вытесненных сессий, защита `.saz`/HAR от ZIP-бомб и переполнения, консистентная загрузка Root CA |
| 3 | **[Этап 20](#этап-20-управление-хранилищем-sqlite-ручная-очистка-vacuum-и-автоочистка-при-выходе)** | **P0 (Critical)** | Спринт 1 | Этап 27 | Защита диска от раздувания `sessions.sqlite` (`VACUUM` + `wal_checkpoint(TRUNCATE)` и автоочистка при выходе) |
| 4 | **[Этап 21](#этап-21-двухфазный-захват-сессий-in-flight--pending-в-стиле-fiddler)** | **P0 (Critical)** | Спринт 1 | — | Мгновенное появление запроса в таблице до ответа сервера (`status: 0`) и инспекция исходящих данных |
| 5 | **[Этап 14](#этап-14-поддержка-сжатия-zstandard-rfc-8878-zstd)** | **P0 (Critical)** | Спринт 1 | — | Прозрачная распаковка `content-encoding: zstd` на лету (в прокси и Composer) и поддержка в TextWizard |
| 6 | **[Этап 15](#этап-15-привязка-к-конкретному-ip--сетевому-интерфейсу-и-мульти-бинд)** | **P0 (Critical)** | Спринт 1 | — | Безопасный выбор конкретного сетевого адаптера (Wi-Fi/Ethernet/WSL/VPN) и Dual Listener без открытия порта на `0.0.0.0` |
| 7 | **[Этап 25](#этап-25-надежность-upstream-соединений-стриминг-видео-диагностика-ошибок-и-консистентный-tcp-проброс)** | **P0 (Critical)** | Спринт 1 | Этап 21, Этап 14 | Устранение `Upstream connection error` на видео/CDN, zero-buffering стриминг, цепочка `err.source()` и сброс устаревших MITM-туннелей |
| 8 | **[Этап 28](#этап-28-неблокирующий-tokio-рантайм-предкомпиляция-regex-и-потоковый-sse-и-websocket)** | **P0 (High)** | Спринт 1 | Этап 21, Этап 25 | Вынос `resolve_client_process` и SQLite в `spawn_blocking`, предкомпиляция `Regex`, устранение $O(N^2)$ в SSE/WS и пул `reqwest::Client` в Composer |
| 9 | **[Этап 24](#этап-24-интерактивная-сортировка-колонок-таблицы-ascdesc-и-массовое-выделение-ctrla)** | **P0 (High)** | Спринт 2 | — | Быстрый поиск аномалий по `Status` / `Time` / `Size` / `ID` и массовое выделение `Ctrl+A` |
| 10 | **[Этап 23](#этап-23-персистентность-геометрии-сплитов-и-адаптивной-сетки-панелей)** | **P0 (High)** | Спринт 2 | — | Сохранение пропорций всех `<PanelGroup>` и ориентации сплита инспектора между перезапусками |
| 11 | **[Этап 5](#этап-5-ультра-компактный-тулбар-автоподбор-колонок-и-шорткаты-инспектора)** | **P0 (High)** | Спринт 2 | — | Однострочный Slim-тулбар (`Ctrl+Shift+T`), автоподбор колонок из меню шапки и быстрые вкладки `Ctrl+1..6` |
| 12 | **[Этап 16](#этап-16-очистка-и-маскирование-pii--секретов-при-экспорте-sanitized-export)** | **P0 (High)** | Спринт 2 | — | Безопасная передача `.har`/`.saz`/`.json`/`.txt` без утечки токенов, cookie, паролей и платежных данных |
| 13 | **[Этап 17](#этап-17-диагностический-мастер-самопроверки-proxy-doctor)** | **P0 (High)** | Спринт 2 | Этап 15 | 1-клик диагностика и автоисправление конфликтов порта, файрвола, системного прокси, Root CA и VPN |
| 14 | **[Этап 29](#этап-29-единый-источник-конфигурации-запуска-гонки-useproxysessions-и-честные-ошибки-bridge)** | **P0 (High)** | Спринт 2 | Этап 15, Этап 27 | Устранение двойного старта `:8888`, атомарная смена порта и профилей настроек, слияние гонок фильтров и отказ от маскировки ошибок IPC |
| 15 | **[Этап 30](#этап-30-исправление-багов-ui-компонентов-виртуализация-hexviewer-и-настройка-manualchunks)** | **P1 (High)** | Спринт 2 | Этап 26 | Исправление багов `BreakpointModal`/`ComposerPanel`/`AutoResponderPanel`/`SessionInspector`/`TrafficGrid`/`TextWizard`, виртуализация `HexViewer` и дробление JS-бандла |
| 16 | **[Этап 22](#этап-22-продвинутая-кастомизация-темы-пресеты-и-детальная-палитра-цветов)** | **P1 (High)** | Спринт 3 | — | 8 тем-пресетов (Dracula, Tokyo Night, Nord, Fiddler Classic и др.) и live-редактор CSS-токенов + Monaco |
| 17 | **[Этап 6](#этап-6-selective-mitm--bypass-20-bulk-editor-10-quick-packs-и-hit-counter)** | **P1 (High)** | Спринт 3 | Этап 25 | Пакетный редактор TLS-правил, расширение `TLS_BYPASS_QUICK_PACKS` до 10+ наборов, счетчик срабатываний и бейдж `TUNNEL` |
| 18 | **[Этап 18](#этап-18-клиентские-сертификаты-mtls--client-certificates-store)** | **P1 (High)** | Спринт 3 | Этап 25 | Хранилище PKCS#12/PEM-сертификатов с привязкой к маскам доменов и кэшируемыми mTLS-клиентами |
| 19 | **[Этап 7](#этап-7-кастомные-скрипты-на-python-python-scripting-engine)** | **P1 (Medium)** | Спринт 3 | Этап 14 | Автоматизация перехвата `on_request` / `on_response` через долгоживущий IPC-процесс Python + Monaco Editor |
| 20 | **[Этап 8](#этап-8-composer-20-умный-paste-curl-и-генератор-клиентского-кода-на-5-языках)** | **P1 (Medium)** | Спринт 3 | — | Парсер команд `cURL` из буфера обмена и генерация сниппетов (JS, Python, Go, Rust, cURL) |
| 21 | **[Этап 19](#этап-19-автоматическая-генерация-спецификаций-openapi-30--swagger)** | **P1 (Medium)** | Спринт 3 | Этап 16 | Генерация YAML/JSON OpenAPI 3.0 спецификации по выделенным сессиям с выводом JSON Schema |
| 22 | **[Этап 9](#этап-9-тестирование-фронтенда-vitest-и-cicd-github-actions)** | **P1 (Medium)** | Спринт 3 | Этап 8, 19, 22, 29, 30 | Покрытие движков `src/lib/*.ts` и хуков тестами Vitest и кроссплатформенный CI (включая `clippy -D warnings`) |
| 23 | **[Этап 10](#этап-10-сетевая-инфраструктура-hosts-remapping-и-bandwidth-throttling)** | **P2 (Feature)** | Спринт 4 | Этап 15, 25 | Виртуальный DNS (`resolve` / `CONNECT`) без правки системного `hosts` и эмуляция медленных сетей |
| 24 | **[Этап 11](#этап-11-архитектурная-декомпозиция-монолитов-и-внедрение-zustand)** | **P2 (Feature)** | Спринт 4 | — | Разделение крупных Rust/React-модулей, внедрение `zustand` и `React.lazy()` Code Splitting |
| 25 | **[Этап 12](#этап-12-аналитика-и-визуализация-waterfall-timeline-и-статистика-трафика)** | **P2 (Feature)** | Спринт 4 | — | Виртуализированная каскадная диаграмма таймингов и сводный Markdown-отчет (P95, статусы, MIME) |
| 26 | **[Этап 13](#этап-13-расширенные-протоколы-upstream-proxy-chaining-и-ws-инъекция)** | **P2 (Feature)** | Спринт 4 | Этап 18, 25 | Каскадирование трафика через внешний HTTP/HTTPS/SOCKS5-прокси и отправка фреймов в открытые WS |

---

## ⚙️ Общие инженерные правила

1. **Изоляция новых подсистем (Modular-First Guardrail):**
   Ключевые файлы уже достигли крупных размеров (`src-tauri/src/proxy/server.rs` ~4.4k строк, `export_import.rs` ~3k, `useProxySessions.ts` ~2.7k, `App.tsx` ~2.7k, `SettingsModal.tsx` ~2.5k, `FilterDrawer.tsx` ~2.2k, `filters.rs` ~2.1k). При реализации этапов Спринтов 1–3 **выносите новую логику в отдельные Rust-модули, TS-утилиты и React-компоненты**, минимизируя разрастание существующих монолитов до рефакторинга в Этапе 11.
2. **Обязательная верификация после каждого этапа:**
   - Проверка типов: `npm run typecheck`
   - Сборка фронтенда: `npm run build`
   - Линтер Rust: `cargo clippy --manifest-path src-tauri/Cargo.toml --message-format=short`
   - Rust-тесты: `cargo test --manifest-path src-tauri/Cargo.toml`
   - Тесты фронтенда (после Этапа 9): `npm run test`
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

## 🔴 Спринт 1 — P0 (Critical): Надежность хранилища, real-time захват и сетевой стек

---

## Этап 26: Безопасность, защита от XSS и инъекций, CSP и устранение UB в Rust
**Приоритет: P0 (Critical) | Спринт 1 | Зависимости: нет**

### Цель и контекст
Аудит безопасности и системного кода выявил критические уязвимости инъекций, конфликт CSP и три класса потенциальных UB/паник/дедлоков в Rust:
1. В веб-портале мобильной настройки (`src-tauri/src/proxy/server.rs`) заголовок `Host` (`host_header`, извлекаемый для `is_direct_origin_http`) напрямую интерполируется в HTML (`Proxy: <strong>{host_header}</strong>`) без HTML-экранирования (Reflected XSS).
2. `SessionInspector.tsx` подставляет заголовок `Content-Type` ответа напрямую в `data:` URL для `<img>` (при `image/svg+xml` рендерится произвольный SVG), а `decodeBase64ToBytes` в `src/lib/formatters.ts` при ошибке `atob` молча подменяет данные UTF-8 текстом.
3. Генераторы команд допускают инъекции: `ca.rs` вызывает `pkexec sh -c "cp '{}' ..."` с неэкранированным `pem_path`, `formatters.ts` (`buildCurlCommand`) подставляет `summary.method` без шелл-экранирования, `MobileSetupModal.tsx` подставляет непроверенный `customIp` в `adb shell settings put global http_proxy` и QR-схему `WIFI:`, а `export_import.rs` (`build_raw_http_request_bytes` / `build_raw_http_response_bytes`) записывает заголовки и целевой путь без удаления `\r`/`\n` (CRLF-инъекция).
4. IPC-команды `export_sessions_file`, `import_sessions_file`, `save_session_body_file`, `export_settings_file`, `import_settings_file` (`src-tauri/src/commands.rs`) принимают произвольный `file_path` из WebView без проверки, а `src-tauri/src/lib.rs` при отказе `app_data_dir()` уводит хранение приватного ключа Root CA и SQLite в общий каталог `std::env::temp_dir().join("fluxproxy")`.
5. `src-tauri/tauri.conf.json` задаёт `script-src 'self' 'wasm-unsafe-eval'` без `'unsafe-inline'`, блокируя pre-paint inline-скрипт `index.html` для `color-scheme`.
6. **UB, дедлоки и паники в Rust:**
   - `MibTcp6RowOwnerPid` в `src-tauri/src/proxy/process.rs` не содержит поля `dw_state: u32` перед `dw_owning_pid`, искажая раскладку Win32 `MIB_TCP6ROW_OWNER_PID` для IPv6;
   - `src-tauri/src/proxy/network.rs` разыменовывает `buf.as_ptr().add(4) as *const MibIpAddrRow` без учёта выравнивания;
   - `panic::set_hook` в `src-tauri/src/proxy/sysproxy.rs` вызывает `rollback_sync()` → `disable()` → `lock_inner()` на не-реентрантном `Mutex` (дедлок при панике под захваченным мьютексом);
   - `src-tauri/src/proxy/filters.rs` в пяти местах режет строку `&token[..6]` до проверки UTF-8 границ (паника на многобайтных UTF-8 символах на 6-м байте) и несогласованно использует чувствительный к регистру `strip_prefix("regex:")`;
   - `src-tauri/src/proxy/breakpoints.rs` для правил с `*` ставит жёсткие якоря `^(?i)...$`, тогда как без `*` ищет подстроку.

### Критерии приемки (DoD)
- HTML-портал в `server.rs` экранирует `host_header`, `client_ip` и любые внешние значения; `SessionInspector.tsx` использует allowlist безопасных растровых MIME для `<img src="data:...">` (исключая небезопасный рендеринг SVG через `data:`), а `decodeBase64ToBytes` явно сигнализирует об ошибке или возвращает пустой буфер без молчаливой подмены.
- `ca.rs` передаёт путь в `pkexec` аргументами без интерполяции в shell (`cp`, `--`, `pem_path`, ...); `buildCurlCommand` экранирует HTTP-метод; `MobileSetupModal.tsx` валидирует `customIp` как IP/hostname; `export_import.rs` удаляет `\r`/`\n` из всех полей заголовков и стартовой строки при экспорте Raw HTTP.
- IPC-команды в `commands.rs` валидируют/канонизируют пути (проверка расширений/запрет системных/неожиданных директорий и проверка существования/согласованности путей от диалогов), а `lib.rs` при отказе `app_data_dir()` завершает запуск с понятной ошибкой вместо записи приватного ключа CA в общедоступный `temp_dir`.
- Pre-paint скрипт темы вынесен из inline `<script>` в статический локальный JS-файл (`script-src 'self'`), либо авторизован SHA-256 хэшем в CSP.
- Исправлены раскладка `MibTcp6RowOwnerPid` (`dw_state: u32`) в `process.rs`, чтение через `std::ptr::read_unaligned` в `network.rs`, защита от дедлока `try_lock`/безблокировочный откат в panic-hook `sysproxy.rs`, безопасный UTF-8 разбор префикса `regex:` в `filters.rs`, согласованное сопоставление wildcard `*` в `breakpoints.rs`, а также устранены все 15 предупреждений `cargo clippy`.
- Unit-тесты в Rust на XSS-экранирование портала, CRLF-санитизацию, UTF-8 многобайтный ввод в `filters.rs` и `MibTcp6RowOwnerPid`.

### 📝 Промпт для Antigravity (Этап 26)

```markdown
Роль: Principal Security & Systems Engineer (Rust / Win32 FFI / WebView CSP).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Закрыть уязвимости XSS/инъекций, исправить конфликт CSP, валидировать пути в IPC и устранить UB, паники и дедлоки в Rust-бэкенде.

1. Безопасность HTML/Команд/CSP (`server.rs`, `ca.rs`, `export_import.rs`, `commands.rs`, `lib.rs`, `index.html`, `tauri.conf.json`, `SessionInspector.tsx`, `formatters.ts`, `MobileSetupModal.tsx`):
   - В `src-tauri/src/proxy/server.rs` реализовать `escape_html(...)` и экранировать все динамические поля в `render_mobile_portal_html` (`client_ip`, `host_header`, `user_agent`).
   - В `src-tauri/src/proxy/ca.rs` заменить вызов `pkexec sh -c "cp '{}' ..."` на безопасное экранирование / передачу путей через позиционные параметры `sh -c 'cp "$1" "$2" && update-ca-certificates' _ "$pem_path" "$dst"`.
   - В `src-tauri/src/storage/export_import.rs` в `build_raw_http_request_bytes` и `build_raw_http_response_bytes` очищать `\r` и `\n` (и NUL) из `method`, `target`, `h.name`, `h.value`, `s.host`, `s.content_type`.
   - В `src-tauri/src/commands.rs` добавить общую проверку `validate_user_file_path` (запрет пустых/NUL/некорректных путей и несоответствующих расширений при сохранении/экспорте), а в `src-tauri/src/lib.rs` убрать небезопасный fallback приватного ключа Root CA в `std::env::temp_dir()`.
   - В `index.html` и `src-tauri/tauri.conf.json`: вынести pre-paint скрипт `color-scheme` во внешний скрипт из `public/` (совместимо с `script-src 'self'`) либо добавить точный `sha256-...` хэш в `csp` без использования `'unsafe-inline'`.
   - На фронтенде:
     * В `src/components/SessionInspector.tsx` разрешать `<img src="data:...">` только для безопасных растровых MIME (`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/bmp`, `image/x-icon`), а `image/svg+xml` показывать только как текст/безопасное превью.
     * В `src/lib/formatters.ts`: экранировать `summary.method.toUpperCase()` в `buildCurlCommand` через `escapePosixSingleQuotes`; в `decodeBase64ToBytes` не подменять битый base64 на UTF-8 байты исходной строки.
     * В `src/components/MobileSetupModal.tsx`: валидировать `customIp` (IPv4/IPv6/RFC-hostname без разделителей `;`, `:`, пробелов и спецсимволов shell) перед подстановкой в `adb shell` и QR-код `WIFI:`.

2. Устранение UB, дедлоков, паник и warnings (`process.rs`, `network.rs`, `sysproxy.rs`, `filters.rs`, `breakpoints.rs`):
   - В `src-tauri/src/proxy/process.rs`: добавить `dw_state: u32` в `MibTcp6RowOwnerPid` согласно Win32 ABI (`MIB_TCP6ROW_OWNER_PID`).
   - В `src-tauri/src/proxy/network.rs`: читать `MibIpAddrRow` из `buf` через `std::ptr::read_unaligned` (с проверкой длины буфера относительно `dw_num_entries`).
   - В `src-tauri/src/proxy/sysproxy.rs`: в `rollback_sync()` (вызываемом из `std::panic::set_hook`) использовать `try_lock` (или lock-free состояние резервного прокси) и не вызывать блокирующий `lock_inner()` поверх уже захваченного в текущем потоке мьютекса.
   - В `src-tauri/src/proxy/filters.rs`: заменить все срезы `&s[..6]` на helper `strip_regex_prefix(s: &str) -> Option<&str>` через `s.get(..6)` с проверкой `is_char_boundary(6)` (и case-insensitive `eq_ignore_ascii_case("regex:")`), убрать чувствительность к регистру в `strip_prefix("regex:")`. Добавить тест с многобайтным UTF-8 символом на 5–7 байтах (кириллица/эмодзи).
   - В `src-tauri/src/proxy/breakpoints.rs`: унифицировать сопоставление wildcard `*` с поведением без `*` (поиск подстроки / явные якоря только при `^`/`$` или корректная семантика URL-маски) и покрыть unit-тестом.
   - Исправить все предупреждения `cargo clippy --manifest-path src-tauri/Cargo.toml`.

Проверка: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## Этап 27: Целостность TrafficStore и SQLite, безопасность парсеров SAZ и консистентность CA
**Приоритет: P0 (Critical) | Спринт 1 | Зависимости: нет**

### Цель и контекст
Аудит подсистемы хранения и импорта/экспорта выявил риски потери данных, гонок, исчерпания памяти и рассинхронизации сертификатов:
1. **`TrafficStore` и SQLite (`src-tauri/src/storage/mod.rs`, `sqlite.rs`, `commands.rs`):**
   - `get_session_detail` читает только in-memory `DashMap` (`store.get(id)`), возвращая `None` для сессий, уже вытесненных в SQLite при FIFO eviction.
   - В `SqliteArchive::open` не задан `PRAGMA busy_timeout`, что приводит к немедленному `SQLITE_BUSY` при параллельных операциях.
   - Обновление аннотаций (`comment`/`marked_color`) выполняет неатомарный read-modify-write и не обновляет сессии в SQLite; при импорте/загрузке `next_id` обновляется неатомарным `Relaxed` `load`/`store`; SSE-стриминг после первого превышения порога 2 MiB (`body_offloaded == true`) перестаёт повторно выгружать дописываемые чанки; ошибки `persist_batch` и `save_offloaded_body` молча игнорируются.
2. **Парсеры `.saz` / HAR / JSON / HTTP (`src-tauri/src/storage/export_import.rs`):**
   - При распаковке `.saz` `Vec::with_capacity(entry.size() as usize)` + `read_to_end` и `std::fs::read(path)` не имеют лимита размера (уязвимость к ZIP-бомбам и OOM); в `decode_chunked` сложение `pos + chunk_size` без `checked_add` грозит паникой переполнения.
   - `decode_xml_bytes` пропускает UTF-16BE (`0xFE 0xFF`); `extract_xml_tag_fragment` ищет `<{tag_name}` подстрокой (конфликт префиксов тегов и `>` в атрибутах); парсер URL `rest.find('/')` ломается на `https://example.com?a=1`.
   - Распаковка `Content-Encoding` идёт через `if / else if` (ломаются цепочки вроде `gzip, br`), `is_matching_compressed_magic` знает только gzip-магик `1f 8b` (ложноположительно вырезая `content-encoding` для `br`/`deflate`), при импорте `.saz` теряются `sse_events`, а при экспорте `status == 0` подменяется на `200`.
3. **Root CA (`src-tauri/src/proxy/ca.rs`):**
   - При перезапуске с существующим ключом `params.self_signed(&ca_key)` перегенерирует новый CA-объект с новыми датами/серийником, но `der` читается с диска из старого `.cer`; `valid_until` захардкожен строкой `"10 years (Local Root CA)"`; проверка установки на Linux проверяет лишь `.exists()` без сверки отпечатка.

### Критерии приемки (DoD)
- `get_session_detail` подгружает вытесненную сессию из SQLite при промахе RAM-кэша; `SqliteArchive` задаёт `PRAGMA busy_timeout = 5000`; аннотации атомарно обновляются в RAM и SQLite; `next_id` обновляется через `fetch_max`; SSE-тела > 2 MiB корректно обновляются в `offloaded_bodies` при дозаписи чанков; ошибки записи SQLite логируются и не глотаются бесследно.
- Импорт файлов и `.saz`-архивов защищён явными лимитами на размер файла и распакованной записи (`take(limit)` + проверка заявленного и фактического размера); в `decode_chunked` используется `checked_add`.
- Починены `decode_xml_bytes` (UTF-16BE BOM), `extract_xml_tag_fragment` (границы имени тега и кавычки), единый URL-парсер с `?`/`@`, цепочка декодирования `Content-Encoding` (`gzip`/`br`/`deflate`/`zstd`), точное определение/сохранение `Content-Encoding` в Raw HTTP и отказ от подмены `status == 0` на `200` при экспорте.
- При загрузке существующего Root CA в `ca.rs` гарантируется идентичность подписанного сертификата в памяти и `.cer`/`.pem` на диске, вычисляется реальная дата окончания `valid_until`, а проверка доверия на Linux сверяет отпечаток/содержимое сертификата.
- Добавлены Rust-тесты на чтение вытесненных сессий, защиту от ZIP-бомб/`decode_chunked` overflow и reload CA без смены отпечатка.

### 📝 Промпт для Antigravity (Этап 27)

```markdown
Роль: Senior Rust Systems & Storage Engineer (SQLite / X.509 / Parsers).
Проект: FluxProxy (Tauri v2 + Rust).

Задача: Устранить потерю и рассинхронизацию данных в `TrafficStore`/SQLite, защитить импорт `.saz`/HAR от ZIP-бомб и ошибок парсинга, и исправить перезагрузку Root CA.

1. Хранилище (`src-tauri/src/storage/sqlite.rs`, `src-tauri/src/storage/mod.rs`, `src-tauri/src/commands.rs`):
   - В `sqlite.rs`: добавить `PRAGMA busy_timeout = 5000;` при инициализации соединения; добавить чтение полной вытесненной `SessionDetail` по `id` и обновление `comment` / `marked_color` для записей в `captured_sessions`.
   - В `storage/mod.rs`:
     * В `TrafficStore::get(id)` при отсутствии сессии в `self.sessions` подгружать её из `self.sqlite`.
     * Для `annotate_session` исключить потерю обновлений при параллельном `update_response` (обновлять атомарно / под узкой синхронизацией) и обновлять запись также в SQLite; не вызывать лишний двойной emit при обновлении.
     * Заменить цикл обновления `next_id` через `Relaxed` `load`/`store` на атомарный `self.next_id.fetch_max(max_id, Ordering::SeqCst)`.
     * В ветке SSE > 2 MiB разрешить повторную запись/обновление оффлоада даже когда `detail.body_offloaded` уже установлен в `true`.
     * Ошибки `persist_batch` и `save_offloaded_body` логировать через `eprintln!`/tracing (или возвращать вызывающему коду там, где возможно) вместо тихого `let _ = ...`.

2. Импорт/Экспорт (`src-tauri/src/storage/export_import.rs`):
   - Ввести константы лимитов (например, `MAX_IMPORT_FILE_BYTES`, `MAX_SAZ_ENTRY_BYTES`, `MAX_SAZ_TOTAL_UNCOMPRESSED_BYTES`) и при чтении `.saz`-записей использовать ограниченную аллокацию + `Read::take`, отвергая подозрительные архивы с понятной ошибкой `ProxyError`. Проверять размер файла до `std::fs::read`.
   - В `decode_chunked` заменить `pos + chunk_size` на `pos.checked_add(chunk_size)`.
   - Поддержать UTF-16BE BOM (`[0xFE, 0xFF]`) в `decode_xml_bytes`, исправить поиск открывающего/закрывающего тега в `extract_xml_tag_fragment` (сверять разделитель после имени тега и учитывать кавычки атрибутов) и унифицировать разбор URL (`find(['/', '?'])` + `rsplit_once('@')`).
   - Исправить `decode_http_body`: обрабатывать список кодировок в `Content-Encoding` справа налево (стек кодировок), не обнулять `is_matching_compressed_magic` для `br` и `deflate`, сохранять `status: 0` без подмены на `200` при экспорте.

3. Root CA (`src-tauri/src/proxy/ca.rs`):
   - При наличии сохранённых CA PEM/DER и ключа использовать сохранённый PEM/DER напрямую (через `rcgen::Issuer::from_ca_cert_pem` / разбор X.509) вместо повторного `self_signed` с новым серийным номером и датой; если `.cer` отсутствует или повреждён, пересоздавать `.cer` строго из загруженного CA.
   - Парсить `not_after` сертификата (через `x509-parser` или ASN.1) для реального `valid_until`.
   - На Linux сверять содержимое/SHA-256 установленного `LINUX_SYSTEM_CA_CERT_PATH` с активным Root CA, а не просто `.exists()`.

Проверка: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`.
```

---

## Этап 20: Управление хранилищем SQLite: ручная очистка, VACUUM и автоочистка при выходе
**Приоритет: P0 (Critical) | Спринт 1 | Зависимости: Этап 27**

### Цель и контекст
При длительной работе сессии сверх лимита `TrafficStore` вытесняются в `sessions.sqlite` (`captured_sessions`), а тела > 2 MiB — в `offloaded_bodies` (`src-tauri/src/storage/mod.rs`). Текущая команда `clear_sessions` (`TrafficStore::clear()`) очищает RAM и удаляет только неархивированные оффлоад-тела (`delete_unarchived_offloaded_bodies`), оставляя вытесненные сессии в `captured_sessions` и не сжимая WAL/freelist-страницы. В результате база разрастается до гигабайтов.

> **Важный архитектурный нюанс:** UI-настройки хранятся в `localStorage`, а не в файле внутри `app_data_dir` (в `app_data_dir` Rust-бэкенд хранит только свои `.pref`-файлы, см. `SystemProxyManager` в `src-tauri/src/proxy/sysproxy.rs`). Поэтому флаг автоочистки при выходе должен синхронизироваться в Rust через отдельную команду и локальный `.pref`-файл. Также в `src-tauri/src/lib.rs` и `WindowEvent::CloseRequested`, и `RunEvent::Exit` вызывают завершение работы — очистку при выходе нужно защитить `AtomicBool` от повторного запуска.

### Критерии приемки (DoD)
- В `SqliteArchive` (`src-tauri/src/storage/sqlite.rs`) и `TrafficStore` (`src-tauri/src/storage/mod.rs`) реализован метод `purge_and_vacuum()` / `clear_sqlite_archive()`, очищающий `captured_sessions` и `offloaded_bodies` с выполнением `PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);` и возвращающий обновленный `StorageStats`.
- Экспортированы Tauri-команды `clear_sqlite_database` и `set_clear_db_on_exit(enabled: bool)` / `get_clear_db_on_exit()`.
- Флаг `clearDbOnExit: boolean` (по умолчанию `false`) добавлен в `FluxUserSettingsProfile`, синхронизируется с Rust при старте/изменении и срабатывает ровно один раз при выходе в `src-tauri/src/lib.rs` (после `shutdown_sync()`).
- Управление доступно в `SettingsModal.tsx` (*General* → блок *Хранилище*), в `MenuBar.tsx` (меню `File` и `Tools` — отдельного меню `Sessions` в приложении нет), по клику на индикатор `SQLite: X.X MB` в строке состояния `App.tsx` и через `CommandPalette.tsx` (`Ctrl+K`).
- Unit-тест `purge_and_vacuum_reclaims_disk_space` в `sqlite.rs` проверяет сжатие файла на диске после удаления записей.

### 📝 Промпт для Antigravity (Этап 20)

```markdown
Роль: Senior Systems Engineer (Rust / SQLite / WAL) & Fullstack UI Developer.
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Реализовать полную очистку архива SQLite со сжатием файла через VACUUM, настройку автоочистки при выходе из приложения и UI-элементы управления хранилищем.

1. Бэкенд (`src-tauri/src/storage/sqlite.rs`, `src-tauri/src/storage/mod.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`):
   - В `SqliteArchive` (`sqlite.rs`):
     * Добавить `pub fn purge_and_vacuum(&self) -> Result<(), ProxyError>`: в транзакции выполнить `DELETE FROM offloaded_bodies;` и `DELETE FROM captured_sessions;`, зафиксировать транзакцию, затем выполнить `PRAGMA wal_checkpoint(TRUNCATE);`, `VACUUM;`, `PRAGMA wal_checkpoint(TRUNCATE);`.
     * Добавить unit-тест `purge_and_vacuum_reclaims_disk_space`, вставляющий крупные записи, вызывающий `purge_and_vacuum()` и проверяющий уменьшение `database_size_bytes()` и пустоту таблиц.
   - В `TrafficStore` (`mod.rs`):
     * Добавить `pub fn clear_sqlite_archive(&self, drop_non_matching: bool) -> Result<StorageStats, ProxyError>`, вызывающий `self.sqlite.purge_and_vacuum()` и возвращающий `self.storage_stats(drop_non_matching)`.
     * Добавить потокобезопасное чтение/сохранение преференса `clear_db_on_exit` (например, `clear_db_on_exit.pref` в `app_data_dir`, аналогично `sysproxy.rs`) и `AtomicBool`-защиту, чтобы автоочистка при завершении выполнялась строго один раз.
   - В `commands.rs` и `lib.rs`:
     * Зарегистрировать команды `clear_sqlite_database`, `get_clear_db_on_exit`, `set_clear_db_on_exit`.
     * В `lib.rs` (в ветке финального завершения `RunEvent::Exit` после `state.controller.shutdown_sync()`) при включенном `clear_db_on_exit` вызывать `clear_sqlite_archive(...)`.

2. Настройки и Dual-Mode (`src/types/settings.ts`, `src/lib/settingsManager.ts`, `src/lib/tauriBridge.ts`, `src/lib/mockTraffic.ts`, `src/hooks/useProxySessions.ts`):
   - Добавить `clearDbOnExit?: boolean` (дефолт `false`) в `FluxUserUiSettings` или `FluxUserProxySettings` (использовать единое место, например `ui` или `proxy`, с нормализацией в `settingsManager.ts`).
   - В `useProxySessions.ts` при старте и изменении синхронизировать флаг в Rust через `proxyBridge.setClearDbOnExit(...)`, а при вызове `clearSqliteDatabase()` обновлять `storageStats`.
   - Поддержать методы в Browser Preview (`tauriBridge.ts`, `mockTraffic.ts`).

3. Пользовательский интерфейс:
   - В `src/components/SettingsModal.tsx` (вкладка `General`):
     * Отобразить размер БД (`storageStats.sqliteSizeBytes`), чекбокс «Очищать базу SQLite при выходе (Clear DB on App Exit)» и кнопку «Очистить архив SQLite сейчас (VACUUM)» с подтверждением.
   - В `src/components/MenuBar.tsx`:
     * Добавить пункт `Purge SQLite Archive (Free Disk)...` в меню `File` и/или `Tools` (актуальные верхние меню: `File`, `Edit`, `Rules`, `View`, `Tools`, `Help`).
   - В `src/App.tsx` и `src/components/CommandPalette.tsx`:
     * Сделать бейдж `SQLite: X.X MB` в статус-баре (или отдельную кнопку рядом с `RAM`) интерактивным для быстрого вызова диалога очистки/сжатия, не ломая клик по `RAM` (открывающий лимит удержания).
     * Добавить действие `clear-sqlite-db` в `CommandPalette.tsx`.

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## Этап 21: Двухфазный захват сессий (In-Flight / Pending в стиле Fiddler)
**Приоритет: P0 (Critical) | Спринт 1 | Зависимости: нет**

### Цель и контекст
Сейчас прокси (`handle_intercepted_request` и `execute_composed` в `src-tauri/src/proxy/server.rs`) регистрирует сессию и отправляет событие в UI только **после получения ответа** от upstream. На медленных запросах (LLM API, долгие SQL/HTTP-запросы, таймауты) пользователь не видит запрос в таблице до завершения или обрыва. В Fiddler сессия появляется мгновенно при отправке запроса (`status: 0` / `Pending`), позволяет инспектировать исходящие заголовки/тело и обновляется на месте при приходе ответа.

> **Важные технические нюансы:**
> - `TrafficGrid.tsx` сейчас красит любой `status < 300` (включая `0`) зеленым стилем `2xx` — статус `0` (при `!breakpointPaused && !tlsBypassed && !error`) нужно отделить в нейтральный/пульсирующий стиль `Pending`.
> - При активном `Drop Non-Matching on Capture` (`evaluate_should_store_session` в `filters.rs`): в Фазе 1 (`status: 0`, `duration_ms: 0`, `body_size: 0`, пустой `content_type`) фильтры по статусу, `contentType`, `bodySize` и `onlySlowRequests` еще не применимы. Нужно либо пропускать эти проверки на этапе `in-flight`, а при отбраковке в Фазе 2 удалять сессию из `TrafficStore` и уведомлять UI (например, событием `proxy://sessions-removed`), чтобы в таблице не оставались «зависшие» строки `Pending`.
> - `useProxySessions.ts` уже умеет обновлять строки по `id` в `flushPendingSessions` и перечитывать `selectedDetail` при изменении `status`/`bodySize`/`durationMs`.

### Критерии приемки (DoD)
- **Фаза 1 (In-Flight):** в `handle_intercepted_request` (и `execute_composed`) перед отправкой upstream-запроса (`upstream_req.send().await`) вызывается `record_in_flight_session`, записывающая `SessionDetail` со `status: 0`, `duration_ms: 0`, `body_size: 0`, полными данными запроса и пустыми данными ответа в `TrafficStore`, и отправляющая `summary` в `event_tx`.
- **Фаза 2 (Completion / Error):** при получении ответа (или сетевой ошибке `record_and_return_error`) сессия с тем же `session_id` обновляется на месте (`status`, `duration_ms`, `body_size`, заголовки и тело ответа, `error`), сохраняя пользовательские аннотации (`comment`/`marked_color`). При активном `Drop Non-Matching` отсеянная по факту ответа сессия корректно удаляется из UI и `TrafficStore`.
- **`TrafficGrid.tsx`:** строки со `status === 0` (и `!breakpointPaused`) отображают нейтральный пульсирующий бейдж `...` / `Pending`, время `...` и размер `--`.
- **`SessionInspector.tsx`:** для `status === 0` вкладки Request полностью доступны, а панель Response показывает индикатор ожидания «Запрос отправлен, ожидание ответа от сервера...», автоматически сменяющийся на ответ без потери выбранной вкладки.
- Покрыто интеграционным тестом в `server.rs` (медленный upstream-сервер возвращает ответ с задержкой, проверяется появление `status == 0` до завершения ответа и обновление до `200`).

### 📝 Промпт для Antigravity (Этап 21)

```markdown
Роль: Principal Systems Network Engineer (Rust / Tokio / Hyper) & Senior Frontend Engineer (React 18).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Реализовать двухфазный захват трафика (Two-Phase Capture): немедленное отображение запроса в статусе In-Flight (`status: 0`) в момент отправки в upstream и обновление строки/инспектора на месте при получении ответа или ошибки.

1. Бэкенд (`src-tauri/src/proxy/server.rs`, `src-tauri/src/proxy/filters.rs`, `src-tauri/src/models.rs`):
   - В `server.rs`:
     * Реализовать helper `record_in_flight_session(ctx, session_id, ...)` для `handle_intercepted_request` (непосредственно перед `upstream_req.send().await`) и `execute_composed` (перед `builder.send().await`). Note: `handle_outer_proxy_request` лишь делегирует в `handle_intercepted_request` или открывает `CONNECT`-туннель.
     * Формировать `SessionSummary` с `status: 0`, `duration_ms: 0`, `body_size: 0`, `content_type: ""` и `SessionDetail` с заполненными `request_headers`, `request_body_base64`, `request_body_text`.
     * Учитывать `Drop Non-Matching on Capture`:
       - В `filters.rs` проверить, чтобы в Фазе 1 (`status == 0`) хост/метод/URL-фильтры могли отбрасывать шум сразу, а фильтры, зависящие от ответа (`status`, `contentType`, `bodySize`, `onlySlowRequests`), не отбрасывали `in-flight` запрос раньше времени.
       - Если в Фазе 2 (после получения ответа) `evaluate_should_store_session` вернул `false` для уже эмиченной сессии, удалять её из `ctx.store` и отправлять в UI событие `proxy://sessions-removed` (`Vec<u64>`) для удаления строки из таблицы.
     * При завершении ответа или ошибке (`record_and_return_error`) обновлять ту же `session_id` через `record_completed_session` (сохраняя `comment` и `marked_color`).
   - Добавить интеграционный тест в `server.rs` с искусственной задержкой ответа upstream.

2. Таблица и Инспектор (`src/components/TrafficGrid.tsx`, `src/components/SessionInspector.tsx`, `src/hooks/useProxySessions.ts`, `src/lib/tauriBridge.ts`, `src/lib/mockTraffic.ts`):
   - В `TrafficGrid.tsx`:
     * В логике `statusBadgeClasses` выделить `s.status === 0 && !s.breakpointPaused && !s.tlsBypassed && !s.error` до ветки `else (2xx)`, чтобы `Pending` не подсвечивался зеленым.
     * Для `status === 0` показывать компактный пульсирующий бейдж `...` / `Pending`, длительность `...` и размер `--`.
   - В `SessionInspector.tsx`:
     * При `detail.summary.status === 0 && !detail.summary.breakpointPaused && !detail.summary.error` оставлять Request-вкладки полностью активными, а в Response-панели показывать плашку ожидания ответа со спиннером.
   - В `useProxySessions.ts` и `tauriBridge.ts`:
     * Подписаться на `proxy://sessions-removed` (если удаляется in-flight строка по `Drop Non-Matching`).
     * В `mockTraffic.ts` добавить демонстрацию задержки ответа (Phase 1 -> Phase 2) для Browser Preview.

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## Этап 14: Поддержка сжатия Zstandard (RFC 8878 zstd)
**Приоритет: P0 (Critical) | Спринт 1 | Зависимости: нет**

### Цель и контекст
Браузеры (Chrome 123+, Firefox 126+, Edge) отправляют `Accept-Encoding: gzip, deflate, br, zstd`. Крупные CDN (Cloudflare, Fastly, Google, Meta) возвращают `content-encoding: zstd`. Крейт `reqwest 0.12` (с текущими фичами в `src-tauri/Cargo.toml`) декодирует только `gzip`, `brotli` и `deflate`, а `server.rs` (`handle_intercepted_request` и `execute_composed`) удаляет `content-encoding` перед отправкой ответа браузеру. В результате браузер и инспектор получают сырой бинарный поток `zstd` (`0x28 0xB5 0x2F 0xFD`) вместо HTML/JSON. Кроме того, в TextWizard отсутствует поддержка Zstd.

### Критерии приемки (DoD)
- В `src-tauri/Cargo.toml` добавлен крейт `zstd = "0.13"`.
- В `src-tauri/src/proxy/server.rs` (и в `handle_intercepted_request`, и в `execute_composed`) ответы с `content-encoding: zstd` (включая регистронезависимые и комбинированные заголовки) прозрачно декодируются до сохранения в `TrafficStore` и до отправки в клиентский Hyper `Response`.
- При ошибке декодирования `zstd` исходные байты и заголовок `content-encoding` сохраняются без повреждения ответа клиенту (fail-safe); если декодирование отключено/неудачно, предусмотрена нормализация `Accept-Encoding` (fallback).
- В `src-tauri/src/models.rs`, `src-tauri/src/proxy/codec.rs`, `src/types/proxy.ts`, `src/lib/textWizard.ts`, `src/lib/tauriBridge.ts` и `src/components/TextWizardModal.tsx` добавлены операции `ZstdCompress` / `ZstdDecompress` (с preview-реализацией или явным fallback).
- Unit-тест `roundtrips_zstd` в `codec.rs` и интеграционный тест прозрачного декодирования `zstd`-ответа в `server.rs`.

### 📝 Промпт для Antigravity (Этап 14)

```markdown
Роль: Senior Systems Engineer (Rust / Tokio / Hyper / Codecs) & Fullstack Developer.
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Реализовать прозрачную распаковку HTTP-ответов, сжатых алгоритмом Zstandard (`content-encoding: zstd`), и добавить сжатие/распаковку Zstd в TextWizard.

1. Зависимости (`src-tauri/Cargo.toml`):
   - Добавить `zstd = "0.13"`.

2. Прозрачная распаковка в прокси и Composer (`src-tauri/src/proxy/server.rs`):
   - Написать общий helper `maybe_decompress_zstd(headers: &[HeaderPair], body: Bytes) -> (Bytes, bool)`:
     * Проверять `content-encoding` на наличие токена `zstd` (case-insensitive, учитывая списки через запятую).
     * Декодировать через `zstd::decode_all(body.as_ref())` (внутри `spawn_blocking` для крупных тел > 256 KB или напрямую для небольших).
     * Если декодирование успешно, возвращать распакованные `Bytes` и `true` (разрешая удаление `content-encoding` / `content-length` при пересборке Hyper `Response`).
     * Если декодирование вернуло ошибку — логировать предупреждение, возвращать исходный `body` и `false`, и **НЕ** удалять заголовок `content-encoding` у ответа клиенту.
   - Применить helper в `handle_intercepted_request` и в `execute_composed` (`server.rs`).
   - Для SSE-ветки (и будущих потоковых веток): если `content-encoding` содержит `zstd`, не отправлять сырой `zstd`-поток со снятым `content-encoding` (либо снимать `zstd` из `Accept-Encoding` на SSE/стриминг, либо использовать потоковый декодер).
   - Добавить интеграционный тест в `server.rs`, проверяющий получение клиентом и сохранение в `TrafficStore` чистого HTML/JSON от upstream с `content-encoding: zstd`.

3. TextWizard & Codec Engine (`src-tauri/src/models.rs`, `src-tauri/src/proxy/codec.rs`, `src/types/proxy.ts`, `src/lib/textWizard.ts`, `src/lib/tauriBridge.ts`, `src/components/TextWizardModal.tsx`):
   - В `models.rs` расширить `CodecOperation` вариантами `ZstdCompress`, `ZstdDecompress`.
   - В `codec.rs` реализовать обработку через `zstd::encode_all(..., 3)` и `zstd::decode_all(...)`, добавить тест `roundtrips_zstd`.
   - Обновить `src/types/proxy.ts`, `src/lib/textWizard.ts`, `src/lib/tauriBridge.ts` и `src/components/TextWizardModal.tsx` (кнопки/опции Zstd Compress и Zstd Decompress + поддержка Base64/Hex).

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## Этап 15: Привязка к конкретному IP / сетевому интерфейсу и мульти-бинд
**Приоритет: P0 (Critical) | Спринт 1 | Зависимости: нет**

### Цель и контекст
Сейчас `allow_remote` переключает прослушивание только между `127.0.0.1` и `0.0.0.0` (`src-tauri/src/proxy/server.rs`). Биндинг на `0.0.0.0` открывает порт на всех интерфейсах сразу (включая публичный Wi-Fi и корпоративные VPN), что противоречит требованиям безопасности, а также мешает при наличии нескольких адаптеров (Ethernet, Wi-Fi, WSL, Docker, VPN).

> **Важные технические нюансы:**
> - Функция `list_network_interfaces()` в `src-tauri/src/proxy/network.rs` сейчас намеренно **исключает** CGNAT/VPN (`100.64.0.0/10`) и виртуальные адаптеры (WSL, Hyper-V, Docker, VMware). Для окна `MobileSetupModal.tsx` это поведение нужно сохранить, а для выбора bind-интерфейса в `SettingsModal.tsx` добавить параметр `include_virtual: Option<bool>` в `get_network_interfaces`, чтобы отображались также WSL/Docker/VPN-адаптеры.
> - При режиме `Specific(ip)` опциональный Dual Listener на `127.0.0.1:{port}` должен быть настраиваемым (`also_bind_loopback: bool`, по умолчанию `true`) и безопасно обрабатывать конфликт порта `AddrInUse` на `127.0.0.1` (предупреждение без срыва основного сокета или корректный откат), а `SystemProxyManager` (`sysproxy.rs`) должен корректно регистрировать в ОС `127.0.0.1` (если loopback поднят) или `{ip}`.

### Критерии приемки (DoD)
- В `models.rs` и `server.rs` поддержана конфигурация `BindHostMode`: `Loopback` (`127.0.0.1`), `AllInterfaces` (`0.0.0.0`), `Specific(String)` + флаг `also_bind_loopback: bool`.
- `ProxyStatus` возвращает `bind_mode`, `bound_ips: Vec<String>` и сохраняет обратную совместимость полей `bind_addr` / `allow_remote`.
- Добавлена команда `set_bind_configuration(mode, ip, port, also_bind_loopback)` (и параметр `include_virtual` у `get_network_interfaces`), а преференс режима привязки сохраняется в `app_data_dir` через `sysproxy.rs`.
- В `SettingsModal.tsx` (*Rules & Proxy*), `MobileSetupModal.tsx` и строке состояния `App.tsx` добавлен выбор конкретного сетевого интерфейса с отображением актуальных привязанных IP.
- `FluxUserProxySettings` (`settings.ts` / `settingsManager.ts`) поддерживает `bindMode`, `specificBindIp` и `alsoBindLoopback` с миграцией старого `allowRemote`.
- Unit-тесты мульти-бинда (поднятие двух `TcpListener` и корректное завершение обоих при `stop()`/`shutdown_sync()`) в `server.rs`.

### 📝 Промпт для Antigravity (Этап 15)

```markdown
Роль: Senior Network Systems Engineer (Rust / Tokio / Sockets) & Fullstack Developer.
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Заменить жесткое переключение `127.0.0.1` / `0.0.0.0` на гибкую конфигурацию привязки к сетевым интерфейсам (Loopback, All Interfaces, Specific IP + опциональный Dual Listener для локального системного прокси).

1. Бэкенд (`src-tauri/src/models.rs`, `src-tauri/src/proxy/network.rs`, `src-tauri/src/proxy/server.rs`, `src-tauri/src/proxy/sysproxy.rs`, `src-tauri/src/commands.rs`):
   - В `models.rs`:
     * Добавить `BindHostMode` (`Loopback`, `AllInterfaces`, `Specific`), поля `bind_mode`, `specific_bind_ip`, `also_bind_loopback`, `bound_ips: Vec<String>` в `ProxyStatus` (с `#[serde(default)]` для совместимости).
   - В `network.rs`:
     * Добавить `list_network_interfaces_with_options(include_virtual: bool) -> Vec<NetworkInterfaceInfo>` (старую `list_network_interfaces()` оставить для `MobileSetupModal` / совместимости). При `include_virtual = true` включать WSL / Docker / Hyper-V / VPN-интерфейсы с понятным `kind`/`name`.
   - В `server.rs`:
     * Обновить `ProxyEngineController` для запуска одного или двух `TcpListener` (в режиме `Specific(ip)`: основной на `{ip}:{port}` и при `also_bind_loopback && ip != "127.0.0.1"` дополнительный на `127.0.0.1:{port}` с общим `watch::Receiver<bool>` для синхронного закрытия).
     * Корректно обрабатывать ошибку `AddrInUse` при старте (останавливать уже поднятый второй сокет и возвращать понятный `ProxyError`, либо сообщать причину).
     * Сохранить совместимость метода `set_allow_remote` (как переключение между `Loopback` и `AllInterfaces`).
   - В `sysproxy.rs`:
     * Сохранять `bind_mode` / `specific_ip` / `also_bind_loopback` в преференсы `app_data_dir` (с чтением legacy `allow_remote.pref`) и указывать в системный прокси ОС `127.0.0.1` (если loopback слушается) или `{specific_ip}`.
   - В `commands.rs` и `lib.rs`:
     * Добавить `set_bind_configuration` и расширить `get_network_interfaces(include_virtual: Option<bool>)`.
   - Добавить unit-тест в `server.rs` на мульти-бинд и остановку всех listener-задач.

2. Настройки и Frontend (`src/types/proxy.ts`, `src/types/settings.ts`, `src/lib/settingsManager.ts`, `src/lib/tauriBridge.ts`, `src/lib/mockTraffic.ts`, `src/hooks/useProxySessions.ts`, `src/components/SettingsModal.tsx`, `src/components/MobileSetupModal.tsx`, `src/App.tsx`):
   - Расширить `FluxUserProxySettings` полями `bindMode?: 'loopback' | 'all' | 'specific'`, `specificBindIp?: string | null`, `alsoBindLoopback?: boolean` с автомиграцией из `allowRemote`.
   - В `SettingsModal.tsx` (*Rules & Proxy*) заменить чекбокс `allowRemote` на радиогруппу: `Loopback (127.0.0.1)`, `All Interfaces (0.0.0.0)`, `Specific Interface` (список из `getNetworkInterfaces(true)` + чекбокс «Также слушать 127.0.0.1 для системного прокси ОС»).
   - Обновить `MobileSetupModal.tsx` и индикатор адреса/порта в `App.tsx` для отображения активных `boundIps`.

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## Этап 25: Надежность upstream-соединений, стриминг видео, диагностика ошибок и консистентный TCP-проброс
**Приоритет: P0 (Critical) | Спринт 1 | Зависимости: Этап 21 (Two-Phase Capture), Этап 14 (Zstd)**

### Цель и контекст
При воспроизведении видео (YouTube / `*.googlevideo.com`) и тяжелых CDN-ответов возникает ошибка `Upstream connection error: error sending request for url (...)` — иногда даже после попытки включить Passthrough. Аудит `server.rs` и `filters.rs` выявил 4 причины:
1. Ошибка `reqwest::Error` форматируется через `{err}`, скрывая всю цепочку `std::error::Error::source()` (DNS, TLS, reset, HTTP/2 `GOAWAY`, timeout).
2. `upstream_client` (`src-tauri/src/proxy/server.rs:120`) настроен с `pool_idle_timeout(90s)` и без `tcp_keepalive`, `http2_keep_alive_*`, `rustls-tls-native-roots` и retry на оборванном keep-alive сокете из пула.
3. Все не-SSE ответы вычитываются целиком через `upstream_resp.bytes().await` до отправки первого байта браузеру, ломая `206 Partial Content` и ABR-стриминг видео.
4. Долгоживущие открытые HTTP/2 `CONNECT` MITM-туннели продолжают работать после изменения правил TLS Bypass / `TargetedOnly`; правило `*.youtube.com` не покрывает `*.googlevideo.com`; в `filters.rs` и `filterEngine.ts` `Hosts List (Whitelist)` с включенным `applyToTlsPassthrough` перекрывает `TargetedOnly`, а в `HostFiltersTab.tsx` слабо заметно, что без этого чекбокса трафик все еще расшифровывается через MITM.

> **Критичные межэтапные ограничения:**
> - **Взаимодействие с Этапом 14 (Zstd):** ответы с `content-encoding: zstd` (например, > 2 MiB HTML/JSON) НЕЛЬЗЯ пускать в сырую ветку `StreamBody` со снятым `content-encoding` — иначе браузер получит несжатый мусор. Сырой zero-buffering стриминг разрешен только если `!is_zstd_encoded` (или через потоковый декодер Zstd).
> - **Защита от OOM на видео-стримах:** `MAX_CAPTURED_BODY_BYTES` в `server.rs` равен **64 MiB**! Буферизация 64 MiB на каждый видеосегмент `video/*` / `206` вызовет утечку/скачок RAM. Для медиа-потоков (`video/*`, `audio/*`, `206`) сохранять метаданные, заголовки и точный счетчик `body_size` (либо не более превью `<= 64 KB` / без хранения 64 MiB видео в `TrafficStore`).
> - **Точное место `TLS_BYPASS_QUICK_PACKS`:** константа экспортируется из `src/lib/filterEngine.ts`, а не из `FilterDrawer.tsx`.

### Критерии приемки (DoD)
- Реализован `format_error_chain(err: &dyn std::error::Error) -> String` для всех ошибок upstream (`handle_intercepted_request`, `execute_composed`, `handle_websocket_intercept`).
- `upstream_client` (через переиспользуемый `build_upstream_client`) включает `rustls-tls-native-roots`, `tcp_keepalive`, `http2_keep_alive_interval`, `http2_keep_alive_while_idle`, сниженный `pool_idle_timeout` (~35 сек) и безопасный 1-кратный retry для идемпотентных запросов (`GET`/`HEAD`/`OPTIONS`) с переиспользуемым `Bytes`-телом при отказе stale-соединения до получения заголовков.
- Для ответов `206 Partial Content`, `video/*`, `audio/*` или `Content-Length > 2 MiB` (при `!should_break_resp` и `!is_zstd_encoded`) используется zero-buffering `StreamBody` поверх двухфазного захвата (Этап 21) без 64-MiB буферизации видеосегментов в памяти.
- В `ProxyFilterEngine` добавлен `watch::Sender<u64>` генерации правил `CONNECT`: при переводе хоста из MITM в Passthrough открытые простаивающие MITM-туннели корректно завершаются через `graceful_shutdown` (`AutoConnBuilder`), чтобы браузер немедленно переоткрыл прямой TCP-туннель.
- Уточнен и синхронизирован приоритет `host_list_sync` vs `TargetedOnly` между `src-tauri/src/proxy/filters.rs` (`evaluate_connect_tunnel`) и `src/lib/filterEngine.ts` (`evaluateTlsConnectInPreview`).
- В `src/lib/filterEngine.ts` (`TLS_BYPASS_QUICK_PACKS`) добавлен пресет для видеохостингов и CDN (`*.googlevideo.com`, `*.youtube.com`, `*.ytimg.com`, `*.ggpht.com`, `*.ttvnw.net`, `*.vimeocdn.com`), а в `HostFiltersTab.tsx` усилен визуальный индикатор «UI Only — HTTPS все еще расшифровывается через MITM».
- Unit/интеграционные тесты `formats_full_reqwest_error_source_chain`, `streams_video_partial_content_without_full_buffering` в `server.rs` и тесты в `filters.rs`.

### 📝 Промпт для Antigravity (Этап 25)

```markdown
Роль: Principal Network Systems Engineer (Rust / Tokio / Hyper / Reqwest / Rustls) & Senior Frontend Engineer (React 18).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Контекст: Зависит от двухфазного захвата (Этап 21) и поддержки Zstd (Этап 14). Необходимо устранить скрытые ошибки upstream на видео/CDN, перевести медиа и крупные ответы на потоковую передачу, а также сделать переключение в TLS Passthrough мгновенным для активных соединений.

1. Диагностика ошибок и настройка `upstream_client` (`src-tauri/Cargo.toml`, `src-tauri/src/proxy/server.rs`):
   - В `Cargo.toml` для `reqwest` добавить фичу `"rustls-tls-native-roots"` (вместе с `"rustls-tls"`).
   - Вынести сборку клиента в общий helper `build_upstream_client(...)`:
     * `tcp_keepalive(Some(Duration::from_secs(30)))`,
     * `http2_keep_alive_interval(Some(Duration::from_secs(20)))`, `http2_keep_alive_timeout(Duration::from_secs(10))`, `http2_keep_alive_while_idle(true)`,
     * `pool_idle_timeout(Some(Duration::from_secs(35)))`.
   - Реализовать `format_error_chain(err: &dyn std::error::Error) -> String` (обход `err.source()` через ` -> `) и использовать его в `handle_intercepted_request`, `execute_composed` и `handle_websocket_intercept`.
   - Добавить безопасный 1-кратный retry при ошибке `send().await` до получения ответа для идемпотентных методов (`GET`, `HEAD`, `OPTIONS`) при признаках обрыва stale-соединения из пула (`is_request()` / `is_connect()` + IO `ConnectionReset` / `BrokenPipe` / `UnexpectedEof` или hyper `IncompleteMessage` / `Canceled`).

2. Zero-buffering потоковая передача для медиа и `206` (`src-tauri/src/proxy/server.rs`):
   - В `handle_intercepted_request` (рядом с веткой SSE) добавить потоковую передачу через `StreamBody`, если `!should_break_resp`, `!is_sse_stream`, И НЕ требуется буферизация для `content-encoding: zstd` (Этап 14), когда выполняется одно из условий:
     * `final_status == 206` (Partial Content),
     * `content_type` начинается с `video/` или `audio/`,
     * `content-length` > `BODY_OFFLOAD_THRESHOLD_BYTES` (2 MiB).
   - Использовать двухфазную модель Этапа 21: обновить запись заголовками ответа (`status = final_status`), транслировать чанки `upstream_resp.chunk().await` клиенту без ожидания конца файла, обновляя `body_size` и `duration_ms` в `TrafficStore` (для `video/*` / `audio/*` / `206` не накапливать 64 MiB видеобайтов в `raw_accum`, ограничиваясь заголовками/счетчиком байт или малым текстовым превью для `text/*`/`application/*`).
   - При ошибке чтения чанка на лету корректно фиксировать `error` в сессии.

3. Консистентный TLS Passthrough и инвалидация открытых MITM-туннелей (`src-tauri/src/proxy/filters.rs`, `server.rs`, `src/lib/filterEngine.ts`, `src/components/HostFiltersTab.tsx`):
   - В `ProxyFilterEngine` (`filters.rs`) добавить `watch::Sender<u64>` (инкрементировать при `update_config`).
   - В `handle_outer_proxy_request` (`server.rs`) при обслуживании MITM-соединения (`AutoConnBuilder::serve_connection_with_upgrades`) слушать канал обновления правил и вызывать `conn.graceful_shutdown()`, если `evaluate_connect_tunnel(&host, port)` сменился на `Passthrough`.
   - Согласовать и протестировать приоритет `host_list_sync` (Whitelist) vs `TargetedOnly` одинаково в `filters.rs` и `src/lib/filterEngine.ts` (`evaluateTlsConnectInPreview`).
   - В `src/lib/filterEngine.ts` (`TLS_BYPASS_QUICK_PACKS`) добавить пак `+ Видеохостинги / CDN (YouTube, Googlevideo, Twitch, Vimeo)` (`*.googlevideo.com, *.youtube.com, *.ytimg.com, *.ggpht.com, *.ttvnw.net, *.vimeocdn.com`).
   - В `src/components/HostFiltersTab.tsx` сделать явный предупреждающий баннер, когда фильтр активен, но `applyToTlsPassthrough` выключен (пояснить, что HTTPS-соединения все еще расшифровываются через MITM).

4. Тесты (`server.rs`, `filters.rs`):
   - Добавить `formats_full_reqwest_error_source_chain`, `streams_video_partial_content_without_full_buffering` и тест пака `*.googlevideo.com` в `filters.rs`.

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## Этап 28: Неблокирующий Tokio-рантайм, предкомпиляция Regex и потоковый SSE и WebSocket
**Приоритет: P0 (High) | Спринт 1 | Зависимости: Этап 21, Этап 25**

### Цель и контекст
Профилирование пути прохождения трафика выявило узкие места по CPU, памяти и блокировке асинхронных потоков Tokio:
1. `resolve_client_process` вызывается синхронно в async-обработчике каждого соединения (`src-tauri/src/proxy/server.rs:272`), сканируя таблицы сокетов ОС прямо на воркер-потоке Tokio; тяжёлые синхронные вызовы `rusqlite` и файлового I/O в `commands.rs` также исполняются без `tokio::task::spawn_blocking`.
2. `RuleEngine` (`src-tauri/src/proxy/rules.rs:93`) и `BreakpointEngine` (`src-tauri/src/proxy/breakpoints.rs:196`) вызывают `Regex::new(...)` заново на каждый проходящий HTTP-запрос под read-локом.
3. Приём тела запроса в `server.rs` (`req.into_body().collect().await`) неограниченно буферизует payload в RAM; при `composed.follow_redirects` (`server.rs:738-742`) на каждый запрос создаётся новый `reqwest::Client`.
4. На потоковых соединениях наблюдается квадратичная деградация ($O(N^2)$): SSE (`server.rs:1689`) на каждый чанк заново кодирует весь накопленный буфер целиком в Base64 и `String`, а WebSocket (`server.rs:2245-2247`) на каждый новый фрейм пересчитывает/перезаписывает весь массив `recorded_frames`.
5. На фронтенде параллельно работают polling-интервалы `1500` мс и `3500` мс (`useProxySessions.ts`), постоянно нагружающие IPC и синхронные Rust-команды.

### Критерии приемки (DoD)
- Вызовы `resolve_client_process` и команды работы с SQLite / файловой системой в `commands.rs` выполняются через `tokio::task::spawn_blocking`, не блокируя планировщик Tokio.
- Регулярные выражения в `RuleEngine` и `BreakpointEngine` предкомпилируются один раз при загрузке/обновлении правил (`CompiledRule` / `CompiledBreakpoint`).
- Чтение тела запроса в `server.rs` защищено явным лимитом размера (`http_body_util::Limited` или потоковое ограничение) до полной буферизации в памяти.
- SSE-накопление и запись WebSocket-фреймов в `TrafficStore` работают инкрементально ($O(1)$ амортизированно на фрейм/чанк с отложенным/финальным формированием `SessionDetail` или `append_sse_chunk`/`append_ws_frame`) без $O(N^2)$ перекодирования на каждый пакет.
- В `SharedProxyContext` переиспользуется общий `reqwest::Client` с поддержкой редиректов для Composer (вместо `Client::builder()` на каждый запрос).
- Polling-интервалы статуса и статистики в `useProxySessions.ts` заменены на event-push при изменении состояния (либо увеличены/объединены без лишней фоновой нагрузки при простое).

### 📝 Промпт для Antigravity (Этап 28)

```markdown
Роль: Senior Rust Performance & Async Runtime Engineer (Tokio / Hyper).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Устранить блокировки Tokio worker-потоков, вынести компиляцию Regex из hot-path, убрать $O(N^2)$ на SSE/WebSocket и наладить пул клиентов Composer.

1. Неблокирующий Tokio (`src-tauri/src/proxy/server.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/proxy/process.rs`):
   - Вызывать `resolve_client_process` внутри `tokio::task::spawn_blocking` (или с коротким неблокирующим таймаутом/кэшем) при принятии подключения.
   - Обернуть тяжёлые синхронные обращения к `TrafficStore`/SQLite/ФС в `src-tauri/src/commands.rs` (`get_session_detail`, `load_session_body`, экспорт/импорт и т.д.) в `tokio::task::spawn_blocking`.

2. Предкомпиляция Regex (`src-tauri/src/proxy/rules.rs`, `src-tauri/src/proxy/breakpoints.rs`):
   - Хранить предкомпилированный `Option<regex::Regex>` рядом с правилом в `RuleEngine` (`rules.rs`) и `BreakpointEngine` (`breakpoints.rs`), компилируя его только в `set_rules`/`update_rules`/`set_config`. В hot-path (`evaluate`/`matches`) использовать только готовый `&Regex`.
   - Покрыть бенчмарком/unit-тестом сопоставление без аллокации компиляции в hot-path.

3. Потоки, лимиты памяти и Composer (`src-tauri/src/proxy/server.rs`, `src-tauri/src/storage/mod.rs`):
   - Заменить безлимитный `req.into_body().collect().await` на ограниченное чтение (`http_body_util::Limited::new(body, MAX_CAPTURED_REQUEST_BODY_BYTES)` с корректным `413 Payload Too Large` или потоковым пробросом для крупных запросов).
   - Перевести обновление SSE и WebSocket в `TrafficStore` на инкрементальный append (хранить/дописывать дельту, а полное Base64/текстовое представление собирать лениво при запросе `get_session_detail` или финально при закрытии потока), убрав $O(N^2)$ цикл на каждом чанке/фрейме.
   - Добавить в `SharedProxyContext` предсозданный `upstream_redirect_client` для Composer при `follow_redirects: true` вместо пересоздания `reqwest::Client` на каждый вызов `execute_composed`.

4. Снижение polling-нагрузки (`src/hooks/useProxySessions.ts`, `src-tauri/src/proxy/server.rs`):
   - Заменить или проредить интервалы `1500` мс и `3500` мс (перевести изменение статуса/статистики на события `tauri` при изменении и паузе на скрытой вкладке).

Проверка: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## 🟠 Спринт 2 — P0 (High): Эргономика таблицы, безопасность экспорта и диагностика

---

## Этап 24: Интерактивная сортировка колонок таблицы (ASC/DESC) и массовое выделение (Ctrl+A)
**Приоритет: P0 (High) | Спринт 2 | Зависимости: нет**

### Цель и контекст
В `TrafficGrid.tsx` сессии отображаются только в хронологическом порядке (FIFO), что затрудняет поиск самых долгих, тяжелых или ошибочных запросов среди тысяч строк. Также отсутствует перехват `Ctrl+A` / `Cmd+A` для выбора всех отфильтрованных строк без системного выделения текста DOM.

> **Важные уточнения по кодовой базе:**
> - Реальный тип `ColumnId` в `src/types/proxy.ts` содержит ровно 10 колонок: `'id' | 'status' | 'method' | 'protocol' | 'host' | 'url' | 'process' | 'size' | 'time' | 'comment'` (полей `durationMs`, `bodySize`, `timestamp`, `path`, `clientIp` в `ColumnId` нет).
> - В `TrafficGrid.tsx` уже есть `onSelectSessionRange(id: number)` для `Shift+Click`, но нет callback-а для пакетной установки массива ID — нужно добавить `onSelectAllSessions(ids: number[])` из `useProxySessions.ts`.
> - При активной сортировке (`sortColumn !== null`) автоскролл `followTail` в `TrafficGrid.tsx` (`scrollToIndex(sessions.length - 1)`) должен учитывать направление (например, для `id desc` не прыгать в конец таблицы к самой старой сессии).

### Критерии приемки (DoD)
- Клик по заголовку колонки (вне зоны `col-resize`) циклически переключает сортировку: `null → 'asc' → 'desc' → null` с индикатором `▲` / `▼` в шапке `TrafficGrid.tsx`.
- Поддержана сортировка всех 10 колонок `ColumnId` (числовая для `id`, `status`, `size` → `bodySize`, `time` → `durationMs`; строковая с `localeCompare` для `method`, `protocol`, `host`, `url` → `path`, `process` → `processName || clientIp`, `comment`) с мемоизацией `useMemo`.
- В контекстное меню шапки добавлены действия «Sort Ascending», «Sort Descending», «Clear Sort».
- `Ctrl+A` / `Cmd+A` (когда фокус не в `input`/`textarea`/`select`/`contenteditable`/Monaco и не открыт `<dialog>`) выбирает все текущие отображаемые сессии, `Delete` удаляет выделение, `Escape` сбрасывает к активной сессии.
- Добавлен пункт `Edit → Select All Sessions` (`Ctrl+A`) в `MenuBar.tsx` и запись в `ShortcutsModal.tsx`.

### 📝 Промпт для Antigravity (Этап 24)

```markdown
Роль: Senior Frontend Performance Engineer (React 18 + TypeScript) & UX Designer.
Проект: FluxProxy (Tauri v2 + React 18).

Задача: Реализовать интерактивную сортировку всех колонок таблицы `TrafficGrid` (ASC/DESC/Default) и массовое выделение всех видимых сессий по `Ctrl+A` / `Cmd+A`.

1. Сортировка колонок (`src/components/TrafficGrid.tsx`, `src/types/proxy.ts`):
   - Добавить типы `SortDirection = "asc" | "desc"` и состояние `sortColumn: ColumnId | null`, `sortDirection: SortDirection`.
   - По клику на `<div role="columnheader">` (игнорируя клики на resize-handle) циклически переключать `null -> 'asc' -> 'desc' -> null`, отображая компактные `▲` / `▼`.
   - Реализовать компаратор по всем реальным `ColumnId`:
     * числовые: `id`, `status`, `size` (`s.bodySize`), `time` (`s.durationMs`);
     * строковые (`localeCompare` с `numeric: false, sensitivity: "base"`): `method`, `protocol`, `host`, `url` (`s.path || s.url`), `process` (`s.processName || s.clientIp || ""`), `comment` (`s.comment || ""`).
   - Мемоизировать `sortedSessions = useMemo(...)` и корректно скорректировать `followTail` (при активной нестандартной сортировке не прокручивать в конец, если новые строки сверху, например для `id desc` прокручивать к индексу `0`).
   - В поповер контекстного меню шапки (`headerColPopoverRef`) добавить пункты сортировки выбранной колонки и сброса сортировки.

2. Массовое выделение `Ctrl+A` (`src/hooks/useProxySessions.ts`, `src/components/TrafficGrid.tsx`, `src/App.tsx`, `src/components/MenuBar.tsx`, `src/components/ShortcutsModal.tsx`):
   - В `useProxySessions.ts` добавить `selectSessions(ids: number[])` (обновляет `selectedIds`, сохраняя `selectedId` в пределах выборки) и передать в `TrafficGrid` как `onSelectAllSessions`.
   - В `TrafficGrid.tsx` и глобальном обработчике `App.tsx` перехватывать `(e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && key === 'a'`:
     * срабатывать только когда нет открытого `<dialog open>` и фокус вне `input`, `textarea`, `select`, `[contenteditable]`, `.monaco-editor`;
     * вызывать `e.preventDefault()` и выделять `sortedSessions.map(s => s.id)`.
   - Добавить пункт `Select All Sessions` (`Ctrl+A`) в `MenuBar.tsx` (`Edit`) и обновить `ShortcutsModal.tsx`.

Проверка: `npm run typecheck`, `npm run build`.
```

---

## Этап 23: Персистентность геометрии сплитов и адаптивной сетки панелей
**Приоритет: P0 (High) | Спринт 2 | Зависимости: нет**

### Цель и контекст
В `src/App.tsx` и `src/components/SessionInspector.tsx` используются 4 группы `<PanelGroup>` из `react-resizable-panels`, ни одна из которых не имеет `autoSaveId`, а `splitDirection` хранится в локальном состоянии `SessionInspector`. При перезапуске приложения, переключении позиции инспектора (`bottom`/`right`) или открытии док-панели Composer пропорции сбрасываются.

> **Важный технический нюанс:** В `App.tsx` для режима `bottom` используются ДВЕ вложенные группы `<PanelGroup>` (внешняя горизонтальная для док-панели Composer и внутренняя вертикальная для «таблица / инспектор»), а в `SessionInspector.tsx` у `<Panel>` вообще отсутствуют пропсы `id` (без стабильных `id` и `autoSaveId` библиотека `react-resizable-panels` теряет размеры при условном рендере панелей). Кроме того, сохранение `inspectorSplitDirection` в режиме `"auto" | "horizontal" | "vertical"` предотвратит неудобную ориентацию при переключении `bottom ↔ right`.

### Критерии приемки (DoD)
- Все 4 `<PanelGroup>` снабжены согласованными `autoSaveId` и стабильными `id` у дочерних `<Panel>`:
  - `flux-layout-bottom-outer-v1` (внешний горизонтальный сплит в режиме `bottom` в `App.tsx`);
  - `flux-layout-bottom-inner-v1` (внутренний вертикальный сплит «таблица / инспектор» в `App.tsx`);
  - `flux-layout-right-v1` (горизонтальный сплит «таблица / инспектор / composer» в режиме `right` в `App.tsx`);
  - `flux-inspector-split-v1` (внутренний сплит Request / Response в `SessionInspector.tsx` с `id="inspector-req-pane"` и `id="inspector-resp-pane"`).
- Состояние `inspectorSplitDirection: "auto" | "horizontal" | "vertical"` вынесено в `useUiPreferences.ts` и `FluxUserSettingsProfile` (`src/types/settings.ts`, `settingsManager.ts`).
- Двойной клик по `<PanelResizeHandle>` сбрасывает текущую группу к сбалансированным пропорциям (50/50 или дефолту), а пункт `View → Reset Split Layout` (и команда в `CommandPalette.tsx`) сбрасывает сохраненные размеры и возвращает `inspectorSplitDirection: "auto"`.

### 📝 Промпт для Antigravity (Этап 23)

```markdown
Роль: Senior Frontend UX Engineer (React 18 + react-resizable-panels).
Проект: FluxProxy (Tauri v2 + React 18).

Задача: Обеспечить сохранение и восстановление геометрии всех сплит-панелей в `App.tsx` и `SessionInspector.tsx`, а также ориентации внутреннего сплиттера инспектора.

1. Персистентность `react-resizable-panels` (`src/App.tsx`, `src/components/SessionInspector.tsx`):
   - В `App.tsx` добавить `autoSaveId` (с безопасным `localStorage`-адаптером или встроенным механизмом `react-resizable-panels` v2) на все 3 `<PanelGroup>`:
     * `autoSaveId="flux-layout-bottom-outer-v1"`,
     * `autoSaveId="flux-layout-bottom-inner-v1"`,
     * `autoSaveId="flux-layout-right-v1"`.
   - В `SessionInspector.tsx` добавить `autoSaveId="flux-inspector-split-v1"` на `<PanelGroup>` и задать стабильные `id="inspector-req-pane"` (`order={1}`) и `id="inspector-resp-pane"` (`order={2}`) обоим `<Panel>`.
   - Добавить обработчик `onDoubleClick` на разделители `<PanelResizeHandle>` (используя `ImperativePanelGroupHandle` / `setLayout`) для быстрого сброса текущей группы панелей.

2. Ориентация сплита и профиль настроек (`src/hooks/useUiPreferences.ts`, `src/types/settings.ts`, `src/lib/settingsManager.ts`, `src/types/proxy.ts`):
   - Добавить `InspectorSplitDirection = "auto" | "horizontal" | "vertical"` в `useUiPreferences.ts` и `FluxUserUiSettings` (при `"auto"` вычисляется от `inspectorPosition`: `bottom -> "horizontal"`, `right -> "vertical"`).
   - Передать `splitDirection` и `onToggleSplitDirection` в `SessionInspector.tsx`.
   - Поддержать сохранение/экспорт/импорт `inspectorSplitDirection` (и при желании карты сохраненных размеров панелей) в `settingsManager.ts` и `SettingsModal.tsx`.

3. Команда сброса (`src/components/MenuBar.tsx`, `src/components/CommandPalette.tsx`, `src/App.tsx`):
   - В `MenuBar.tsx` (`View`) и `CommandPalette.tsx` добавить `Reset Panel Layout to Default`, очищающий ключи `autoSaveId` (префикс `react-resizable-panels:flux-`) и сбрасывающий `inspectorSplitDirection` в `"auto"`.

Проверка: `npm run typecheck`, `npm run build`.
```

---

## Этап 5: Ультра-компактный тулбар, автоподбор колонок и шорткаты инспектора
**Приоритет: P0 (High) | Спринт 2 | Зависимости: нет**

### Цель и контекст
Состояние `compactToolbar` и базовый поповер видимости колонок (`headerColPopoverRef` в `TrafficGrid.tsx`) уже существуют, но:
1. В компактном режиме на 13-дюймовых экранах тулбар всё ещё требует прокрутки вместо лаконичной однострочной Slim-компоновки с выносом второстепенных групп в меню `•••` и шортката `Ctrl+Shift+T`.
2. Контекстное меню шапки `TrafficGrid.tsx` привязано к всей строке заголовка и не определяет колонку под курсором, а также не содержит `Auto-fit This Column` и `Auto-fit All Visible Columns`.
3. В `SessionInspector.tsx` две независимые панели вкладок (`REQUEST_TABS` и `RESPONSE_TABS`), и отсутствуют клавиатурные шорткаты `Ctrl+1` … `Ctrl+6`.

### Критерии приемки (DoD)
- Глобальный шорткат `Ctrl+Shift+T` / `Cmd+Shift+T` переключает `compactToolbar`; Slim-режим гарантирует однострочную компоновку ключевых контролов без горизонтального скролла.
- Правый клик по конкретному `<div role="columnheader">` в `TrafficGrid.tsx` определяет `ColumnId` через `data-col-id` и показывает в поповере действия `Auto-fit "<Column>"`, `Auto-fit All Visible Columns` и `Reset Columns & Widths`.
- В `SessionInspector.tsx` отслеживается активная подпанель (`activePane: "request" | "response"`, по умолчанию `"response"`), и `Ctrl+1` … `Ctrl+6` переключают вкладки активной панели (вне текстовых полей и Monaco Editor).
- Новые шорткаты отражены в `MenuBar.tsx`, `ShortcutsModal.tsx` и `CommandPalette.tsx`.

### 📝 Промпт для Antigravity (Этап 5)

```markdown
Роль: Senior UX / Frontend Engineer (React 18 + TypeScript + Tailwind CSS).
Проект: FluxProxy (Tauri v2 + React 18).

Задача: Завершить Slim-режим тулбара, расширить контекстное меню шапки колонок таблицы и добавить шорткаты вкладок инспектора.

1. Slim Toolbar и `Ctrl+Shift+T` (`src/components/TopToolbar.tsx`, `src/App.tsx`, `src/components/MenuBar.tsx`, `src/components/ShortcutsModal.tsx`):
   - В `App.tsx` добавить глобальный шорткат `(e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && key === 't'` для переключения `compactToolbar`.
   - В `TopToolbar.tsx` при `compactToolbar === true` убирать вторичные подписи и убирать редкие кнопки в уже существующее меню переполнения `•••`, чтобы Capture, Clear, Tail, Keep, поиск и быстрые категории умещались в 1 строку на 1280px.
   - Указать подсказку `Ctrl+Shift+T` в `MenuBar.tsx` (`View`) и `ShortcutsModal.tsx`.

2. Контекстное меню шапки `TrafficGrid.tsx`:
   - Добавить `data-col-id={col.id}` на каждый `<div role="columnheader">`.
   - В `handleHeaderContextMenu` определять колонку через `(e.target as HTMLElement).closest<HTMLElement>("[data-col-id]")?.dataset.colId`.
   - Вынести логику измерения авто-ширины из `handleResizeDoubleClick` в общий helper `computeAutoFitWidth(col, sessions)` и добавить в `headerColPopoverRef`:
     * `Auto-fit "<Column>"` (если клик был по колонке),
     * `Auto-fit All Visible Columns`,
     * существующий `Reset`.

3. Шорткаты вкладок `SessionInspector.tsx` (`Ctrl+1` … `Ctrl+6`):
   - В `SessionInspector.tsx` отслеживать `activePane: "request" | "response"` (обновляется по `onFocusCapture`/`onPointerDownCapture` внутри левой/верхней или правой/нижней панели, по умолчанию `"response"`).
   - По `Ctrl+1..6` (если фокус внутри инспектора или таблицы, но вне `input`/`textarea`/`.monaco-editor`) переключать вкладку активной панели:
     `1` -> `headers`, `2` -> `json` (или `raw`, если для текущей сессии/панели JSON пуст/неприменим), `3` -> `cookies` (или `params` в Request, если выбрана 3-я), `4` -> `auth`, `5` -> `raw`, `6` -> `hex`.
   - Добавить описание `Ctrl+1..6` в `ShortcutsModal.tsx`.

Проверка: `npm run typecheck`, `npm run build`.
```

---

## Этап 16: Очистка и маскирование PII / секретов при экспорте (Sanitized Export)
**Приоритет: P0 (High) | Спринт 2 | Зависимости: нет**

### Цель и контекст
При экспорте `.har`, `.saz`, `.json` или Raw HTTP (`.txt`) для коллег и баг-трекеров в архивы попадают боевые токены (`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`), пароли/секреты в JSON/form-телах, токены в query-параметрах и локальные IP/имена процессов. Необходим безопасный режим экспорта с настраиваемой санитизацией без поломки структуры архива.

### Критерии приемки (DoD)
- В `src-tauri/src/models.rs` и `src-tauri/src/storage/export_import.rs` реализована структура `SanitizationOptions` и функция санитизации копий `SessionDetail` перед сериализацией в HAR 1.2, SAZ, JSON и Raw HTTP.
- Команда `export_sessions_file` (`commands.rs`) принимает опциональный параметр `sanitization: Option<SanitizationOptions>` с сохранением обратной совместимости для обычного `Ctrl+S`.
- Модальное окно `src/components/SanitizedExportModal.tsx` (меню `File → Export Sanitized Sessions...` / `Ctrl+Shift+S`, Command Palette, контекстное меню таблицы) с пресетами *Safe Sharing*, *Strict Anonymization* и *Custom*.
- Маскируются заголовки, рекурсивные ключи в JSON и `application/x-www-form-urlencoded`, query-параметры URL, а также опционально `clientAddr`, `clientIp` и `processName`.
- Покрыто unit-тестами `sanitizes_har_and_saz_exports_without_corrupting_structure` в `export_import.rs`.

### 📝 Промпт для Antigravity (Этап 16)

```markdown
Роль: Senior Security & Full-Stack Engineer (Rust + TypeScript + React).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Реализовать подсистему санитизации и маскирования чувствительных данных (PII & Secrets Redaction) при экспорте сессий в HAR 1.2, SAZ, JSON и Raw HTTP.

1. Бэкенд (`src-tauri/src/models.rs`, `src-tauri/src/storage/export_import.rs`, `src-tauri/src/commands.rs`):
   - Добавить `SanitizationOptions` (`#[serde(rename_all = "camelCase")]`):
     * `redact_auth_headers: bool`,
     * `custom_redacted_headers: Vec<String>`,
     * `mask_json_keys: Vec<String>` (дефолты: `password`, `passwd`, `secret`, `token`, `access_token`, `refresh_token`, `api_key`, `cvv`, `pan`, `card_number`, `pin`),
     * `strip_query_params: Vec<String>` (дефолты: `token`, `auth`, `api_key`, `key`, `signature`, `sig`, `code`),
     * `anonymize_client_info: bool`,
     * `replacement_text: String` (по умолчанию `"[REDACTED]"`).
   - Реализовать чистую функцию `sanitize_sessions(sessions: &[SessionDetail], opts: &SanitizationOptions) -> Vec<SessionDetail>`:
     * Замена значений секретных заголовков (включая `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`) на `replacement_text`.
     * Рекурсивный обход JSON-тел (`serde_json::Value`) и маскирование `application/x-www-form-urlencoded` пар по case-insensitive совпадению ключей, с пересчетом `request_body_text`/`response_body_text` и `base64`.
     * Замена значений указанных query-параметров в `summary.url` и `summary.path`.
     * При `anonymize_client_info`: замена `client_addr` (`0.0.0.0:0`), `client_ip` (`0.0.0.0`) и `process_name` (`"redacted-process"`).
   - Расширить `export_sessions_file` в `commands.rs` опциональным полем `sanitization: Option<SanitizationOptions>` и добавить unit-тест `sanitizes_har_and_saz_exports_without_corrupting_structure` в `export_import.rs`.

2. Frontend UI (`src/components/SanitizedExportModal.tsx`, `src/types/proxy.ts`, `src/types/settings.ts`, `src/lib/settingsManager.ts`, `src/lib/tauriBridge.ts`, `src/lib/mockTraffic.ts`, `src/components/MenuBar.tsx`, `src/App.tsx`):
   - Создать `SanitizedExportModal.tsx` с выбором формата (`har` / `saz` / `json` / `raw`), пресетами (*Safe Sharing*, *Strict Anonymization*, *Custom*) и сохранением настроек санитизации.
   - Интегрировать в `File → Export Sanitized Sessions…` (`Ctrl+Shift+S`), `CommandPalette.tsx` и `ShortcutsModal.tsx`, а также в Browser Preview (`tauriBridge.ts`, `mockTraffic.ts`).

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## Этап 17: Диагностический мастер самопроверки «Proxy Doctor»
**Приоритет: P0 (High) | Спринт 2 | Зависимости: Этап 15 (Bind Configuration)**

### Цель и контекст
Когда трафик не проходит через прокси, причина обычно внешняя: занятый порт, блокировка файрволом, вмешательство VPN, сброс системного прокси ОС или недоверенный Root CA. Пользователю нужен единый мастер диагностики и 1-клик исправления типовых сбоев.

> **Важные уточнения по кодовой базе:**
> - В `handle_builtin_portal_request` (`src-tauri/src/proxy/server.rs:2881`) сейчас **нет** маршрута `/health` (`select_portal_asset` возвращает HTML-страницу лендинга и записывает сессию в `TrafficStore`). Нужно явно добавить легкий эндпоинт `/health` на `http://flux.proxy/health`, возвращающий `200 OK` без замусоривания таблицы трафика (или с флагом игнорирования health-check).
> - Проверки порта и системного прокси должны опираться на актуальные `bound_ips` и `bind_mode` из Этапа 15, а не на жесткий `127.0.0.1:8888`.

### Критерии приемки (DoD)
- Создан отдельный Rust-модуль `src-tauri/src/proxy/doctor.rs` (без перегрузки `server.rs`), экспортирующий команды `run_proxy_doctor()` и `fix_doctor_issue(issue_id)`.
- Проверяются: (1) доступность/состояние сокета и конфликт порта, (2) доверие ОС к Root CA (`ca.rs`), (3) соответствие системного прокси ОС (`sysproxy.rs`) активным `bound_ips:port`, (4) наличие потенциально конфликтующих VPN/туннельных интерфейсов (`network.rs`), (5) правила/доступность Windows Firewall (или диагностика прав), (6) сквозной loopback-запрос через прокси на `http://flux.proxy/health`.
- В `handle_builtin_portal_request` (`server.rs`) добавлен маршрут `/health` (`200 OK`), не создающий лишнего шума в `TrafficStore`.
- Модальное окно `src/components/ProxyDoctorModal.tsx` (`Help → Run Proxy Doctor…` / `Ctrl+Shift+D`, кнопка при ошибке в статус-баре и в `CommandPalette.tsx`) с кнопкой 1-клик автоисправления («Repair»).
- Покрыто unit-тестами в `doctor.rs`.

### 📝 Промпт для Antigravity (Этап 17)

```markdown
Роль: Senior Systems Engineer & Diagnostics Specialist (Rust + React 18).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Реализовать встроенный диагностический мастер «Proxy Doctor» для выявления и 1-клик устранения проблем с портом, Root CA, системным прокси ОС, VPN и loopback-маршрутизацией.

1. Бэкенд (`src-tauri/src/proxy/doctor.rs`, `src-tauri/src/proxy/mod.rs`, `src-tauri/src/proxy/server.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`):
   - В `server.rs` (`handle_builtin_portal_request`):
     * Добавить быстрый ответ для пути `/health` (`200 OK`, `application/json`, `{"status":"ok"}`) без записи шумной сессии в `TrafficStore`.
   - Создать `src-tauri/src/proxy/doctor.rs`:
     * Модель `DoctorCheckResult`: `id`, `title`, `status: "ok" | "warning" | "error"`, `summary`, `details`, `can_auto_fix: bool`, `fix_label: Option<String>`.
     * Проверки:
       1. `port_binding`: статус `ProxyEngineController` (учитывая `bound_ips` и `port` из Этапа 15; при остановленном состоянии — пробный `TcpListener::bind`).
       2. `root_ca_trust`: статус `ca.info_with_trust_status()`.
       3. `system_proxy_sync`: сопоставление `sysproxy.status_for_listener(...)` с ожидаемым адресом и `auto_system_proxy`.
       4. `vpn_interface_check`: обнаружение активных TUN/VPN/CGNAT маршрутов, способных перехватывать системный прокси.
       5. `firewall_check`: проверка доступности локального/LAN входа (на Windows — безопасная проверка без требования UAC там, где возможно, с понятной рекомендацией при блокировке).
       6. `loopback_e2e`: отправка `GET http://flux.proxy/health` через локальный сокет прокси с проверкой ответа `200`.
     * Автоисправление `fix_doctor_issue(issue_id)` (перезапуск listener / установка Root CA / восстановление `set_system_proxy(true)`).
   - Зарегистрировать команды `run_proxy_doctor` и `fix_doctor_issue` в `commands.rs` и `lib.rs`.
   - Добавить unit-тесты в `doctor.rs`.

2. Frontend UI (`src/components/ProxyDoctorModal.tsx`, `src/lib/tauriBridge.ts`, `src/lib/mockTraffic.ts`, `src/components/MenuBar.tsx`, `src/App.tsx`, `src/components/CommandPalette.tsx`, `src/components/ShortcutsModal.tsx`):
   - Создать `ProxyDoctorModal.tsx` с запуском сканирования, статусами проверок, понятными пояснениями и кнопками «Fix» / «Fix All Fixable».
   - Добавить `Help → Run Proxy Doctor…` (`Ctrl+Shift+D`) и кликабельный триггер в статус-баре `App.tsx` при наличии ошибки системного прокси/движка.

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## Этап 29: Единый источник конфигурации запуска, гонки useProxySessions и честные ошибки Bridge
**Приоритет: P0 (High) | Спринт 2 | Зависимости: Этап 15, Этап 27**

### Цель и контекст
Аудит связки фронтенда (`src/hooks/useProxySessions.ts`, `src/lib/settingsManager.ts`, `src/lib/tauriBridge.ts`) и запуска бэкенда (`src-tauri/src/lib.rs`) выявил структурный split-state и гонки:
1. При старте Rust безусловно запускает прокси на захардкоженном `:8888` (`src-tauri/src/lib.rs:63`), а `bootstrap` на фронтенде останавливает его и переподнимает на `initialPort` (`useProxySessions.ts:597-600`). Более того, `if (!mounted) return` проверяется **до** `await proxyBridge.subscribeSessionBatches(...)`, из-за чего в React StrictMode подписка утекает.
2. `setProxyPort` записывает новый порт в `localStorage` до фактического биндинга, останавливает работающий прокси без отката при падении `startProxy` и вызывает `setPreviewPort` даже при остановленном прокси.
3. Два пересекающихся debounced-эффекта фильтров (`useProxySessions.ts:880-896` и `928-945`) читают `backendFilterConfigRef.current` и перетирают изменения друг друга; загрузка `selectedDetail` не имеет `.catch()` и не сбрасывает устаревшую карточку; `replaySessions` передаёт `detail.requestBodyText ?? ""`, теряя бинарные (`requestBodyBase64`) и выгруженные тела.
4. `applySettingsProfile` (`settingsManager.ts:1815-1889`) сохраняет профиль в `localStorage` и диспатчит `SETTINGS_APPLIED_EVENT` **до** выполнения IPC-вызовов без rollback при ошибке и без сохранения `BreakpointConfig`.
5. `tauriBridge.ts` маскирует сбои IPC: `deleteSessions` при ошибке возвращает `ids.length`, `getAutoResponderEnabled`/`setAutoResponderEnabled` глотают исключения, а `generateStressTestSessions` в нативном режиме работает только через `previewEngine`.

### Критерии приемки (DoD)
- Rust читает сохранённый стартовый порт/параметры биндинга из `.pref` в `app_data_dir` (единая точка правды запуска) и стартует сразу на нужном порту без принудительного рестарта из `bootstrap`; фронтенд обновляет преференс через IPC при смене порта.
- В `useProxySessions.ts` проверка `mounted` выполняется и **после** `await subscribeSessionBatches` с немедленным `unlisten()`; `setProxyPort` сначала пытается переключить порт в Rust/откатить старый при ошибке, и лишь затем фиксирует UI-состояние/`localStorage`.
- Синхронизация фильтров сведена в единый сериализованный debounced-поток; `loadSessionDetail` обрабатывает ошибки, защищён от race-condition и сбрасывает устаревший `selectedDetail`; `replaySessions` поддерживает бинарные/base64 и offloaded-тела запроса.
- `applySettingsProfile` применяет изменения к бэкенду транзакционно (фиксирует `localStorage` и `SETTINGS_APPLIED_EVENT` только после успешного IPC, либо откатывает/отдаёт список ошибок); `FluxUserSettingsProfile` опционально сохраняет `breakpoints` (`BreakpointConfig`).
- `tauriBridge.ts` не подделывает успешные ответы при ошибках IPC и честно разводит `generateStressTestSessions` (поддержка Tauri или явная индикация Preview-режима).

### 📝 Промпт для Antigravity (Этап 29)

```markdown
Роль: Senior Fullstack Tauri / React State Architect.
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Устранить двойной старт прокси `:8888`, гонки `useProxySessions.ts` и `settingsManager.ts`, а также скрытие ошибок в `tauriBridge.ts`.

1. Единая стартовая конфигурация (`src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`, `src/hooks/useProxySessions.ts`):
   - Сохранять порт/режим запуска в `app_data_dir` (`.pref` по аналогии с `sysproxy.rs` / Этап 15), чтобы `lib.rs` при старте сразу поднимал прокси на сохранённом порту без перезапуска `:8888 -> initialPort`.
   - В `useProxySessions.ts`:
     * После `const unlisten = await proxyBridge.subscribeSessionBatches(...)` проверять `if (!mounted) { unlisten(); return; }`.
     * Переписать `setProxyPort`: сохранить `previousPort`/`wasRunning`; при ошибке `startProxy` на новом порту автоматически возвращать предыдущий порт и не писать нерабочий порт в `localStorage`.
     * Объединить два debounced-эффекта синхронизации фильтров (`880-896` и `928-945`) в один эффект с единым актуальным снимком конфига.
     * В эффекте `selectedId`: сбрасывать устаревший `selectedDetail`, проверять актуальность `selectedId` после `await` и добавлять `.catch(...)`.
     * В `replaySessions`: при наличии `requestBodyBase64` (или `bodyOffloaded`) догружать тело через `loadSessionBody` и передавать raw-байты/base64 в `replay`.

2. Честный Bridge и профили настроек (`src/lib/tauriBridge.ts`, `src/lib/settingsManager.ts`, `src/types/settings.ts`):
   - В `tauriBridge.ts`: убрать `catch { return ids.length }` в `deleteSessions` и тихое проглатывание ошибок в `getAutoResponderEnabled`/`setAutoResponderEnabled` — пробрасывать ошибку в вызывающий код/toast. В `generateStressTestSessions` либо добавить нативную Tauri-команду генерации в `TrafficStore` (только для dev/stress диагностики), либо явно сообщать о режиме Preview вместо тихого no-op в нативном окне.
   - В `src/types/settings.ts` и `src/lib/settingsManager.ts`: добавить опциональное поле `breakpoints?: BreakpointConfig` (с нормализацией для профилей `schemaVersion: 1`); в `applySettingsProfile` вызывать IPC-обновления **до** записи в `localStorage` и события `SETTINGS_APPLIED_EVENT` с отчётом/откатом при сбое.

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## Этап 30: Исправление багов UI-компонентов, виртуализация HexViewer и настройка manualChunks
**Приоритет: P1 (High) | Спринт 2 | Зависимости: Этап 26**

### Цель и контекст
Детальная ревизия компонентов UI и конфигурации сборки выявила конкретные дефекты UX, утечки слушателей DOM и просадки производительности:
1. **`BreakpointModal.tsx`:** зависимость эффекта от `pausedItems.length` сбрасывает текущий режим и выбор при поступлении нового паузированного запроса; при Resume всегда отправляется текстовый `draftBody` (ломая бинарные тела); закрытие модалки опирается на устаревшее `pausedItems.length <= 1`.
2. **`ComposerPanel.tsx`:** `handleExecute` использует `try ... finally` без `catch`, из-за чего ошибка выполнения уходит в `unhandledrejection` без индикации в интерфейсе.
3. **`AutoResponderPanel.tsx`:** `RuleDetailForm` инициализирует `useState(rule)` однократно, поэтому переключение чекбокса правила в левом списке не синхронизирует `draft` и откатывается кнопкой Apply.
4. **`SessionInspector.tsx`:** автопереключение на вкладку `"ws"` проверяет `scheme === "wss"`, но пропускает `ws`; при быстром переключении `A → B → A` флаги `loadingRespBody` / `loadingReqBody` сбрасываются до завершения первого асинхронного запроса.
5. **`TrafficGrid.tsx`:** слушатели `mousemove`/`mouseup` и inline-стили `document.body` при ресайзе колонок утекают при unmount компонента во время перетаскивания; `followTail` завязан на `sessions.length` и перестаёт автоскроллить при заполнении FIFO-лимита; при исключении `showPopover()` добавленный класс `":popover-open"` не снимается.
6. **`HexViewer.tsx`, `textWizard.ts`, `mockTraffic.ts` и `vite.config.ts`:**
   - `HexViewer.tsx` рендерит до `16_384` байт в DOM без виртуализации, а `hoveredOffset` в React state перерисовывает всю таблицу при движении курсора;
   - `textWizard.ts` падает с `TypeError` на `headerObj.alg`, если заголовок/payload JWT является валидным JSON `null`;
   - в `mockTraffic.ts` (`SAMPLE_GRPC_REQ_B64`) длина protobuf submessage для поля `#4` (`cus_denis_42`) записана как `0x10` (16 байт) вместо фактических `0x0e` (14 байт);
   - `vite.config.ts` не настраивает `manualChunks`, из-за чего основной JS-чанк превышает `5 MB`.

### Критерии приемки (DoD)
- В `BreakpointModal.tsx` состояние формы синхронизировано по `selectedId`, бинарные тела при Resume сохраняются без искажения текстом, а закрытие проверяет реальное отсутствие оставшихся элементов.
- В `ComposerPanel.tsx` добавлен `catch` с понятным отображением ошибки запроса; в `AutoResponderPanel.tsx` `RuleDetailForm` корректно синхронизируется с изменениями `rule.enabled` из левого списка.
- В `SessionInspector.tsx` вкладка `WS` автовыбирается и для `ws`, и для `wss`; загрузка тел отслеживается через идентификатор/счётчик активного запроса без залипания индикаторов `loading*`.
- В `TrafficGrid.tsx` реализован гарантированный cleanup listeners/body styles при unmount, `try/finally` вокруг `showPopover()` / снятия `:popover-open` и автоскролл `followTail` по изменению ID хвостовой сессии (или счётчику апдейтов), а не по `sessions.length`.
- `HexViewer.tsx` виртуализован по строкам (например, `@tanstack/react-virtual`) и не перерисовывает всю таблицу на hover каждого байта.
- В `textWizard.ts` JWT-декодер проверяет `typeof obj === "object" && obj !== null && !Array.isArray(obj)`; в `mockTraffic.ts` исправлен `SAMPLE_GRPC_REQ_B64`; в `vite.config.ts` настроено разбиение на чанки (`manualChunks` для `monaco-editor`, `@tauri-apps`, React vendor).

### 📝 Промпт для Antigravity (Этап 30)

```markdown
Роль: Senior React UI & Performance Engineer.
Проект: FluxProxy (React 18 + TypeScript + Vite 6 + Tailwind).

Задача: Исправить дефекты интерактивных компонентов UI, виртуализовать `HexViewer` и настроить `manualChunks` в Vite.

1. Компонентные баги (`BreakpointModal.tsx`, `ComposerPanel.tsx`, `AutoResponderPanel.tsx`, `SessionInspector.tsx`, `TrafficGrid.tsx`):
   - `src/components/BreakpointModal.tsx`: убрать сброс черновика/вкладки при росте `pausedItems.length`; при Resume учитывать `isBinary` / base64 без отправки повреждённого `draftBody`; закрывать модалку только после проверки реальной пустой очереди.
   - `src/components/ComposerPanel.tsx`: добавить `catch (err)` в `handleExecute` и выводить сообщение об ошибке в UI.
   - `src/components/AutoResponderPanel.tsx`: синхронизировать `draft` с внешними изменениями активного `rule` (в частности `rule.enabled` из левого списка, при смене `rule.id` или тоггле).
   - `src/components/SessionInspector.tsx`: включить `scheme === "ws"` в условие автовыбора вкладки `"ws"`; привязать загрузку тела (`loadingReqBody` / `loadingRespBody`) к `currentSessionIdRef`/токену запроса, чтобы быстрое переключение `A -> B -> A` не сбрасывало состояние текущего запроса.
   - `src/components/TrafficGrid.tsx`:
     * Вынести очистку `mousemove`/`mouseup` и сброс `document.body.style.cursor`/`userSelect` в `useEffect` cleanup.
     * В управлении popover снимать `":popover-open"` в `finally` при ошибке `showPopover()`.
     * Заменить зависимость `followTail` с `sessions.length` на `lastSessionId` / монотонный маркер новых сессий, чтобы автопрокрутка продолжала работать после достижения FIFO-лимита RAM.

2. Виртуализация HexViewer, JWT/gRPC-фиксы и Vite Chunking (`HexViewer.tsx`, `textWizard.ts`, `mockTraffic.ts`, `vite.config.ts`):
   - `src/components/HexViewer.tsx`: виртуализовать 16-байтовые строки через `@tanstack/react-virtual` и перенести подсветку пары hex/ASCII на CSS/локальный атрибут без полного ре-рендера дерева на `hoveredOffset`.
   - `src/lib/textWizard.ts`: добавить проверку не-null plain-object после `JSON.parse` в декодере JWT перед чтением `headerObj.alg` и claims.
   - `src/lib/mockTraffic.ts`: исправить длину поля `#4` (`cus_denis_42`) в `SAMPLE_GRPC_REQ_B64` с `0x10` на `0x0e`.
   - `vite.config.ts`: добавить `build.rollupOptions.output.manualChunks` с выделением `monaco-editor`, `react`/`react-dom` и `@tauri-apps`/`lucide-react` в отдельные чанки.

Проверка: `npm run typecheck`, `npm run build` (проверить снижение размера `dist/assets/index-*.js`), `cargo test --manifest-path src-tauri/Cargo.toml`.
```

---

## 🟡 Спринт 3 — P1 (High / Medium): Кастомизация, mTLS, автоматизация и качество

---

## Этап 22: Продвинутая кастомизация темы: пресеты и детальная палитра цветов
**Приоритет: P1 (High) | Спринт 3 | Зависимости: нет**

### Цель и контекст
Сейчас в `src/hooks/useTheme.ts` доступно только переключение `light` / `dark` / `system`. Инженеры работают за инструментом часами и нуждаются как в привычных темах (Dracula, Tokyo Night, Nord, Fiddler Classic, GitHub Dark/Light, Monokai Pro), так и в тонкой подстройке акцентов, фонов и цветов статусов.

> **Важные уточнения по реальным CSS-токенам в `src/index.css` и `tailwind.config.js`:**
> - В проекте уже используются точные имена переменных: `--bg-canvas`, `--bg-surface`, `--bg-elevated`, `--bg-hover`, `--bg-selected`, `--border-hairline`, **`--border-strong`** (не `--border-default`), **`--text-primary`**, **`--text-secondary`**, **`--text-muted`** (не `--fg-primary`/`--fg-muted`), `--accent-primary`, `--status-2xx-fg`, `--status-2xx-bg`, `--status-3xx-fg`, `--status-3xx-bg`, `--status-4xx-fg`, `--status-4xx-bg`, `--status-5xx-fg`, `--status-5xx-bg`, `--status-ws-fg`, `--status-ws-bg`, `--scrollbar-track`, `--scrollbar-thumb`.
> - `src/index.css:136` переключает палитру через селектор `:root:has(> head > meta[name="color-scheme"][content="dark"])`. При применении пресета через `document.documentElement.style.setProperty(...)` инлайновые переменные имеют приоритет над CSS-селектором, а при возврате к `default-dark` / `default-light` / `system` инлайновые свойства нужно корректно очищать (`removeProperty`), сохраняя корректное значение `meta[name="color-scheme"]` (dark vs light) и синхронизируя тему Monaco Editor (`vs-dark` / `vs` или кастомный `monaco.editor.defineTheme`).
> - В `SettingsModal.tsx` и `src/types/settings.ts` вкладка называется `uiColumns` (*UI & Columns*).

### Критерии приемки (DoD)
- Создан модуль `src/lib/themePresets.ts` с 8 пресетами (`default-dark`, `default-light`, `dracula`, `tokyo-night`, `nord`, `fiddler-classic`, `github-dark`, `monokai-pro`), каждый из которых явно задает `baseScheme: "dark" | "light"` и токены из `src/index.css`.
- В `FluxUserUiSettings` (`src/types/settings.ts`, `settingsManager.ts`) добавлены `themePreset?: ThemePresetId` и `customColorOverrides?: Partial<Record<ThemeTokenKey, string>>` с экспортом/импортом в JSON-профиле.
- `src/hooks/useTheme.ts` динамически применяет токены активного пресета + `customColorOverrides` на `:root`, автоматически вычисляет полупрозрачный `--status-*-bg` (`rgb(... / 0.13)`) при смене `--status-*-fg` и синхронизирует тему Monaco Editor (`src/lib/monaco.ts`).
- В `SettingsModal.tsx` (вкладка *UI & Columns* / *Theme & UI*) добавлена галерея карточек пресетов с мини-свотчами и раскрываемый редактор палитры (`<input type="color">` + валидируемый HEX-ввод + кнопка сброса).

### 📝 Промпт для Antigravity (Этап 22)

```markdown
Роль: Design Systems Lead & Senior Frontend Engineer (React 18 + Tailwind CSS + CSS Variables).
Проект: FluxProxy (Tauri v2 + React 18).

Задача: Реализовать галерею цветовых тем-пресетов и редактор детальной палитры UI и HTTP-статусов поверх существующей системы CSS-переменных (`src/index.css`, `tailwind.config.js`).

1. Модуль пресетов (`src/lib/themePresets.ts`, `src/types/settings.ts`):
   - Использовать строгие имена CSS-переменных проекта:
     `--bg-canvas`, `--bg-surface`, `--bg-elevated`, `--bg-hover`, `--bg-selected`, `--border-hairline`, `--border-strong`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent-primary`, `--status-2xx-fg`, `--status-3xx-fg`, `--status-4xx-fg`, `--status-5xx-fg`, `--status-ws-fg`, `--scrollbar-track`, `--scrollbar-thumb`.
   - Описать 8 пресетов (`default-dark`, `default-light`, `dracula`, `tokyo-night`, `nord`, `fiddler-classic`, `github-dark`, `monokai-pro`) с `baseScheme: "dark" | "light"` и свотчами для превью.
   - Написать helper `hexToRgbaString(hex, alpha)` для автоматического вычисления `--status-*-bg` при переопределении любого `--status-*-fg` (и `--bg-selected` с комфортным контрастом).

2. Движок применения темы и Monaco (`src/hooks/useTheme.ts`, `src/lib/monaco.ts`, `src/lib/settingsManager.ts`):
   - Расширить `useTheme()` поддержкой `themePreset` и `customColorOverrides` с персистенцией в `localStorage` и реакцией на `SETTINGS_APPLIED_EVENT`.
   - При выборе `default-dark` / `default-light` / `system` (без кастомных оверрайдов) очищать инлайновые `style.removeProperty(...)` на `document.documentElement`, чтобы работали базовые правила `src/index.css`; для пресетов выставлять `meta[name="color-scheme"]` в `baseScheme` и применять все токены через `setProperty`.
   - Синхронизировать фон/подсветку Monaco Editor (`monaco.editor.defineTheme("fluxproxy-active", ...)` или переключение `vs-dark` / `vs` в соответствии с `baseScheme`).

3. Интерфейс в `SettingsModal.tsx`:
   - Во вкладке `uiColumns` (*UI, Theme & Columns*) добавить:
     * сетку карточек 8 пресетов с 5 цветными свотчами и бейджем `Dark` / `Light`;
     * раскрываемую секцию «Детальная настройка палитры» с `<input type="color">` и HEX-полями для фонов, текста, акцента и статусов `2xx/3xx/4xx/5xx/WS`;
     * кнопку сброса кастомных цветов к выбранному пресету.

Проверка: `npm run typecheck`, `npm run build`.
```

---

## Этап 6: Selective MITM & Bypass 2.0: Bulk Editor, 10+ Quick-Packs и Hit Counter
**Приоритет: P1 (High) | Спринт 3 | Зависимости: Этап 25 (синхронизация `TLS_BYPASS_QUICK_PACKS`)**

### Цель и контекст
Вкладка `tlsBypass` в `FilterDrawer.tsx` уже поддерживает режимы `InterceptAll` / `TargetedOnly`, но ввод правил по одной строке неудобен для крупных списков, а дефолтная база в `default_backend_config()` (`src-tauri/src/proxy/filters.rs`) и `TLS_BYPASS_QUICK_PACKS` (`src/lib/filterEngine.ts`) ограничена (3 базовых пака + видео-пак из Этапа 25). Также не хватает счетчика срабатываний правил в реальном времени.

### Критерии приемки (DoD)
- В `FilterDrawer.tsx` (вкладка `tlsBypass`) добавлено переключение `Table View` ↔ `Bulk Text Mode` для списков `Target Allowlist` и `TLS Bypass` с поддержкой комментариев `#`, масок `*`, `regex:` и сохранением категорий/описаний.
- Реализованы групповые операции (чекбоксы, Enable/Disable/Delete selected), диалог «Quick Paste…», экспорт/импорт `.txt`/`.json` и чипы обнаруженных в текущей сессии хостов (`+ Target` / `+ Bypass` в 1 клик).
- В `filters.rs` (`default_backend_config` / выделенный helper `default_tls_bypass_rules()`) и `filterEngine.ts` синхронизированы расширенные дефолтные правила PKI/OCSP/CRL и 10+ курируемых Quick-Packs (с сохранением видео/CDN-пака из Этапа 25) + кнопка «Восстановить рекомендованные дефолты».
- В `ProxyFilterEngine` (`filters.rs`) реализован lock-free счетчик попаданий (`DashMap<String, AtomicU64>`) по `rule.id`, команды `get_tls_rule_hit_counts` / `reset_tls_bypass_rules_to_recommended`, отображение `Hits: N` в UI и явный бейдж `TUNNEL` для `tlsBypassed` в `TrafficGrid.tsx`.

### 📝 Промпт для Antigravity (Этап 6)

```markdown
Роль: Senior Full-Stack & Network Systems Engineer (Rust + React 18 + TypeScript).
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Модернизировать интерфейс и бэкенд Selective MITM & Bypass: пакетный редактор правил (Bulk Text & Quick Paste), 10+ курируемых Quick-Packs, расширенные дефолты PKI/OCSP, счетчик попаданий в Rust и индикацию туннелей.

1. Бэкенд (`src-tauri/src/proxy/filters.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`):
   - Вынести дефолтные правила из `default_backend_config()` в `pub fn default_tls_bypass_rules() -> Vec<TlsBypassRule>` и расширить критическими PKI/OCSP/CRL-доменами (`ocsp.*`, `crl.*`, `*.digicert.com`, `*.sectigo.com`, `*.letsencrypt.org`, `ocsp.apple.com`), системными службами и мессенджерами.
   - В `ProxyFilterEngine` добавить lock-free `hit_counts: DashMap<String, AtomicU64>` (учет при возврате `Passthrough(BypassRule(rule))` или совпадении `tls_target_rules` в `evaluate_connect_tunnel` — без взятия write-lock!).
   - Добавить Tauri-команды `get_tls_rule_hit_counts() -> HashMap<String, u64>` и `reset_tls_bypass_rules_to_recommended() -> ProxyFilterBackendConfig`.
   - Покрыть тестами в `filters.rs`.

2. Конфигурация и утилиты (`src/lib/filterEngine.ts`, `src/lib/tauriBridge.ts`, `src/lib/mockTraffic.ts`):
   - Синхронизировать `DEFAULT_BACKEND_FILTER_CONFIG.tlsBypassRules` с `default_tls_bypass_rules()`.
   - Расширить `TLS_BYPASS_QUICK_PACKS` в `src/lib/filterEngine.ts` до 10+ наборов (сохранив `+ Видеохостинги / CDN` из Этапа 25): *Dev Tools & Package Managers*, *OCSP / CRL PKI*, *Payment Gateways & 3-DS*, *DRM & Audio/Video Streaming*, *Gaming & Anti-Cheat*, *РФ FinTech & Госуслуги*, *Google & Android FCM*, *Apple Ecosystem & APNs*, *Windows Updates & Telemetry*, *E2EE & Corporate Messengers*.
   - Реализовать чистые конвертеры `tlsRulesToBulkText` / `parseBulkTextToTlsRules` с сохранением существующих метаданных правил при переключении видов.

3. UI (`src/components/FilterDrawer.tsx`, `src/components/TrafficGrid.tsx`):
   - В `FilterDrawer.tsx` (вкладка `tlsBypass`) добавить переключатель `Table View` / `Bulk Text Editor`, массовые чекбоксы и тулбар действий, диалог `Quick Paste…`, экспорт/импорт TXT/JSON, чипы доменов текущей сессии (`+ Target` / `+ Bypass`) и бейджи `Hits: N`.
   - В `TrafficGrid.tsx` отображать аккуратный бейдж `TUNNEL` для сессий с `tlsBypassed === true`.

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## Этап 18: Клиентские сертификаты (mTLS / Client Certificates Store)
**Приоритет: P1 (High) | Спринт 3 | Зависимости: Этап 25 (`build_upstream_client`)**

### Цель и контекст
Корпоративные, внутренние и банковские API часто требуют двусторонней аутентификации TLS (Mutual TLS / mTLS). Без отправки клиентского X.509-сертификата прокси завершает рукопожатие с upstream ошибками 400/403 или TLS Alert.

> **Важный технический нюанс:** Создавать новый `reqwest::Client` с нуля на каждый HTTP-запрос дорого (теряется TLS-кэш и пул сокетов). Для mTLS-доменов нужно кэшировать инстансы `reqwest::Client` по ключу `cert_id` в `moka::sync::Cache` (крейт `moka` уже подключен в `Cargo.toml`) и собирать их через общий `build_upstream_client` из Этапа 25.

### Критерии приемки (DoD)
- Выделенный Rust-модуль `src-tauri/src/proxy/client_certs.rs` для хранения и сопоставления клиентских сертификатов (`.p12`/`.pfx` и `.pem`) с масками доменов (`*.internal.company.com`).
- Файлы сертификатов и конфигурация привязок безопасно хранятся в `app_data_dir/client_certs` (с правами `0600` на Unix, как в `ca.rs`); при экспорте настроек в `FluxUserSettingsProfile` приватные ключи и пароли не утекают в открытом виде.
- В `server.rs` (`handle_intercepted_request`, `execute_composed`) при наличии подходящего сертификата используется кэшированный `reqwest::Client` с `reqwest::Identity` (`from_pkcs12_der` / `from_pkcs8_pem`), собранный на тех же настройках keep-alive и корней ОС, что и основной `upstream_client`.
- Tauri-команды `list_client_certificates`, `add_client_certificate`, `toggle_client_certificate`, `remove_client_certificate`, `test_client_certificate`.
- Модальное окно `src/components/ClientCertificatesModal.tsx` (`Tools → Client Certificates…` / `Ctrl+Shift+C`) с таблицей сертификатов, отображением CN и срока действия.
- Интеграционный тест mTLS-соединения (или `ClientCertStore` + `Identity` parsing/matching) в Rust.

### 📝 Промпт для Antigravity (Этап 18)

```markdown
Роль: Senior Security & Network Engineer (Rust / Tokio / TLS / reqwest) & Frontend Developer.
Проект: FluxProxy (Tauri v2 + Rust + React 18).

Задача: Реализовать хранилище клиентских сертификатов (mTLS) с поддержкой PKCS#12 (`.p12`/`.pfx`) и PEM, привязкой к маскам доменов и кэшируемыми mTLS-клиентами upstream.

1. Бэкенд (`src-tauri/src/proxy/client_certs.rs`, `src-tauri/src/proxy/mod.rs`, `src-tauri/src/proxy/server.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`):
   - Создать `client_certs.rs`:
     * Модель `ClientCertificateEntry`: `id`, `domain_pattern`, `label`, `format` (`pkcs12` | `pem`), `stored_cert_path`, `common_name`, `expires_at`, `enabled: bool`.
     * Парсинг и валидация `.p12`/`.pfx` (`reqwest::Identity::from_pkcs12_der`) и `.pem` (`reqwest::Identity::from_pkcs8_pem` / `from_pem`), извлечение метаданных X.509 (`x509-parser` уже в зависимостях через `rcgen`).
     * Копирование файлов сертификата внутрь `app_data_dir/client_certs` с правами `0600` и сохранение метаданных реестра (без экспорта паролей в общедоступный JSON-профиль).
     * Сопоставление хоста (`match_certificate_for_host(&self, host: &str)`) с поддержкой точных доменов и масок `*.domain.com`.
     * Потокобезопасный кэш `moka::sync::Cache<String, reqwest::Client>` (инвалидируется при изменении/удалении сертификата); сборка клиента через общий `build_upstream_client` из Этапа 25 с `.identity(identity)`.
   - Интегрировать выбор mTLS-клиента в `handle_intercepted_request` и `execute_composed` (`server.rs`).
   - Добавить команды в `commands.rs` и `lib.rs` (`list_client_certificates`, `add_client_certificate`, `toggle_client_certificate`, `remove_client_certificate`).
   - Покрыть тестами (парсинг, сопоставление доменов и кэширование) в `client_certs.rs`.

2. Frontend UI (`src/components/ClientCertificatesModal.tsx`, `src/lib/tauriBridge.ts`, `src/lib/mockTraffic.ts`, `src/components/MenuBar.tsx`, `src/App.tsx`, `src/components/ShortcutsModal.tsx`, `src/components/CommandPalette.tsx`):
   - Создать `ClientCertificatesModal.tsx` с формой добавления `.p12`/`.pfx`/`.pem`, пароля, маски домена и таблицей сертификатов (CN, срок действия, предупреждение об истечении срока, включение/удаление).
   - Добавить пункт `Tools → Client Certificates…` (`Ctrl+Shift+C`) и команду в `CommandPalette.tsx`.

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## Этап 7: Кастомные скрипты на Python (Python Scripting Engine)
**Приоритет: P1 (Medium) | Спринт 3 | Зависимости: Этап 14 (Zstd декодирован до передачи в `on_response`)**

### Цель и контекст
Инженерам нужна программируемая модификация трафика «на лету» (аналог FiddlerScript / mitmproxy addons) для расчета HMAC-подписей, динамического мокирования и переписывания query/body без перекомпиляции приложения.

### Критерии приемки (DoD)
- Отдельный модуль `src-tauri/src/scripting/python_runner.rs` запускает долгоживущий воркер Python (`python3`/`python`/`py`) с обменом по `stdin`/`stdout` (JSON Lines) и защитным таймаутом 1500 мс (fail-open при ошибке или таймауте).
- В `server.rs` (`handle_intercepted_request`) вызываются хуки `on_request(request)` (после `BodyExt::collect`, до `upstream_req.send`) и `on_response(response)` (только для буферизированных и уже распакованных ответов, не блокируя SSE/медиа-стримы).
- Вывод `print(...)` и ошибки `stderr` транслируются в UI через событие `proxy://script-console-log`.
- Раздел **Scripts (`Alt+5`)** в `Sidebar.tsx`, `MenuBar.tsx` (`View`) и компонент `src/components/ScriptingPanel.tsx` со встроенным Monaco Editor (`language="python"`), шаблонами, статусом интерпретатора и живой консолью логов.
- Покрыто unit-тестами в `scripting/python_runner.rs` (включая fail-open при падении/таймауте или отсутствии Python).

### 📝 Промпт для Antigravity (Этап 7)

```markdown
Роль: Senior Systems Engineer (Rust / Tokio / IPC) & Full-Stack Developer.
Проект: FluxProxy (Tauri v2 + Rust + React 18 + Monaco Editor).

Задача: Реализовать движок пользовательских Python-скриптов (`on_request` / `on_response`) для модификации HTTP-трафика на лету.

1. Бэкенд (`src-tauri/src/scripting/mod.rs`, `src-tauri/src/scripting/python_runner.rs`, `src-tauri/src/proxy/server.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`):
   - Реализовать в `python_runner.rs` управление дочерним процессом Python (`python3` / `python` / `py`) со встроенным Python-буферным раннером (`-u -c ...`):
     * Протокол JSON Lines через `stdin`/`stdout`.
     * Сериализуемый mutex-канал и жесткий `tokio::time::timeout(Duration::from_millis(1500), ...)`; при зависании — перезапуск воркера и fail-open пропуск запроса без модификаций.
     * Сбор `print(...)` и `stderr` с отправкой через `app_handle.emit("proxy://script-console-log", ...)`.
   - Интегрировать вызов в `handle_intercepted_request` (`server.rs`) — **пропускать** `on_response` для потоковых ветвей SSE / `video/*` / `206`, чтобы не буферизовать стримы; для обычных ответов вызывать уже после распаковки (включая `zstd`).
   - Добавить Tauri-команды `set_python_script(code: String, enabled: bool)`, `get_python_runner_status()`.
   - Написать тесты протокола обмена и fail-open поведения в `python_runner.rs`.

2. Frontend UI (`src/components/ScriptingPanel.tsx`, `src/components/Sidebar.tsx`, `src/components/MenuBar.tsx`, `src/App.tsx`, `src/types/settings.ts`, `src/lib/settingsManager.ts`, `src/lib/tauriBridge.ts`, `src/lib/mockTraffic.ts`):
   - Расширить `activeSection` в `App.tsx` и `Sidebar.tsx` разделом `scripts` (`Alt+5`).
   - В `ScriptingPanel.tsx` разместить Monaco Editor (`language="python"`), пресеты скриптов (*HMAC Header Injection*, *Conditional Mock*, *Query Rewriter*, *Payload Logger*), индикатор доступности Python, кнопку «Apply Script» и панель консоли вывода.
   - Сохранять текст и состояние скрипта в `localStorage` / `FluxUserSettingsProfile`, а в Browser Preview отображать понятный статус симулятора.

Проверка: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck`, `npm run build`.
```

---

## Этап 8: Composer 2.0: Умный «Paste cURL» и генератор клиентского кода на 5 языках
**Приоритет: P1 (Medium) | Спринт 3 | Зависимости: нет**

### Цель и контекст
Текущий `src/components/ComposerPanel.tsx` требует ручного заполнения URL, заголовков и тела, а также не умеет экспортировать захваченную сессию в готовый код. Умный парсер `cURL` и генератор сниппетов ускоряют воспроизведение API-запросов из Chrome DevTools и терминала.

### Критерии приемки (DoD)
- Чистый модуль `src/lib/curlParser.ts` разбирает POSIX bash и Windows cmd/PowerShell команды `curl` (`\`, `^`, одинарные/двойные/экранированные кавычки, `-X/--request`, `-H/--header`, `-b/--cookie`, `-A/--user-agent`, `-u/--user`, `-d/--data/--data-raw/--data-binary/--json`, `--url`).
- В `ComposerPanel.tsx` добавлена кнопка «Import cURL» и автоопределение вставки `curl ...` в поле URL.
- Чистый модуль `src/lib/codeGenerators.ts` и модальное окно `src/components/CodeSnippetModal.tsx` (с Monaco Editor) генерируют корректный код для **JavaScript** (`fetch`, `axios`), **Python** (`requests`, `httpx`), **Go** (`net/http`), **Rust** (`reqwest`) и **cURL** (Bash & PowerShell).
- Вызов «Generate Client Code…» доступен в `ComposerPanel.tsx`, контекстном меню строки `TrafficGrid.tsx` и `MenuBar.tsx` (`Edit`).

### 📝 Промпт для Antigravity (Этап 8)

```markdown
Роль: Senior Full-Stack Developer (TypeScript + React 18 + Monaco Editor).
Проект: FluxProxy (Tauri v2 + React 18).

Задача: Реализовать умный парсер команд `cURL` (Import / Paste cURL) в `ComposerPanel` и модальный генератор клиентского кода на 5 языках.

1. Парсер cURL (`src/lib/curlParser.ts`, `src/components/ComposerPanel.tsx`):
   - Написать детерминированный лексер shell-токенов (без `eval`), поддерживающий:
     * перенос строк `\` (bash) и `^` (Windows cmd), `'`/`"`/ANSI-C `$'...'` кавычки;
     * флаги `-X`/`--request` (авто-переключение на `POST`, если передано тело без `-X`);
     * `-H`/`--header`, `-b`/`--cookie`, `-A`/`--user-agent`, `-u`/`--user` -> `Authorization: Basic <base64>`;
     * `-d`/`--data`/`--data-raw`/`--data-binary`/`--data-urlencode`/`--json` (с автозаголовком `Content-Type: application/json` для `--json`).
   - В `ComposerPanel.tsx`: кнопка «Import cURL» с диалогом вставки + перехват `onPaste` в поле URL (если буфер начинается с `curl `).

2. Генератор кода (`src/lib/codeGenerators.ts`, `src/components/CodeSnippetModal.tsx`, `src/components/TrafficGrid.tsx`, `src/components/MenuBar.tsx`):
   - Реализовать чистые генераторы из `SessionDetail` / черновика Composer для 5 целей: JS (`fetch` / `axios`), Python (`requests` / `httpx`), Go (`net/http`), Rust (`reqwest`), cURL (Bash / PowerShell) с безопасным экранированием строк и заголовков.
   - Создать `CodeSnippetModal.tsx` с переключателем языка/библиотеки, Monaco Editor (read-only) и кнопкой «Copy Code».
   - Добавить вызов «Generate Client Code…» в `ComposerPanel.tsx`, контекстное меню строки `TrafficGrid.tsx` и `MenuBar.tsx` (`Edit`).

Проверка: `npm run typecheck`, `npm run build`.
```

---

## Этап 19: Автоматическая генерация спецификаций OpenAPI 3.0 / Swagger
**Приоритет: P1 (Medium) | Спринт 3 | Зависимости: Этап 16 (опциональная санитизация секретов)**

### Цель и контекст
При исследовании недокументированных API или создании контрактов разработчикам приходится вручную описывать пути, параметры и JSON-схемы. Генерация OpenAPI 3.0 по группе захваченных сессий решает эту задачу в один клик.

### Критерии приемки (DoD)
- Чистый модуль `src/lib/openApiGenerator.ts` преобразует массив `SessionDetail[]` в валидную спецификацию OpenAPI 3.0.3 (в форматах YAML и JSON).
- Выполняется параметризация путей (числовые ID и UUID в сегментах URL объединяются в `{id}`), группировка по `method` + шаблон пути, слияние нескольких HTTP-статусов (`200`, `400`, `500`), извлечение `query`-параметров и рекурсивный инференс JSON Schema (`type`, `properties`, `items`, `nullable`, `example`).
- Автоматическое распознавание `Bearer` / `ApiKey` заголовков в `components.securitySchemes` (без вставки реальных боевых токенов в `example`!).
- Модальное окно `src/components/OpenApiExportModal.tsx` с предпросмотром в Monaco Editor (`yaml` / `json`), редактированием `title`/`version` и сохранением в файл.

### 📝 Промпт для Antigravity (Этап 19)

```markdown
Роль: Senior Fullstack Engineer & API Specialist (TypeScript + OpenAPI 3.0).
Проект: FluxProxy (Tauri v2 + React 18 + Monaco Editor).

Задача: Реализовать движок генерации спецификаций OpenAPI 3.0.3 по выбранным захваченным сессиям и UI предпросмотра/экспорта.

1. Генератор схем (`src/lib/openApiGenerator.ts`):
   - Реализовать `generateOpenApiSpec(sessions: SessionDetail[], options: OpenApiGeneratorOptions): string`:
     * Нормализация базовых URL (`servers`) и путей (`paths`): замена числовых сегментов и UUID на `{id}` / `{uuid}` (или `{paramN}` при коллизиях).
     * Объединение одинаковых эндпоинтов и нескольких статус-кодов (`200`, `4xx`, `5xx`) в общую операцию OpenAPI.
     * Вывод параметров (`in: "query"`, `in: "path"`), `requestBody` и `responses` через рекурсивный слиятель JSON Schema (объединение свойств объектов по разным ответам одного эндпоинта).
     * Защита от утечки секретов: заголовки `Authorization`, `Cookie`, `X-Api-Key` выносить в `components.securitySchemes` без включения реальных токенов.
     * Детерминированный компактный сериализатор в YAML и JSON без тяжелых внешних зависимостей.

2. Интерфейс (`src/components/OpenApiExportModal.tsx`, `src/components/TrafficGrid.tsx`, `src/components/MenuBar.tsx`, `src/App.tsx`):
   - Создать `OpenApiExportModal.tsx` с предпросмотром в Monaco Editor (`yaml`/`json`), полями названия/версии API, опцией включения примеров (`includeExamples`) и кнопкой сохранения/копирования (использовать `pickSaveFileDialog` / `exportSettingsFile` или browser download в preview).
   - Подключить пункт «Export as OpenAPI 3.0 Spec…» в контекстное меню выделенных сессий `TrafficGrid.tsx` и меню `File` в `MenuBar.tsx`.

Проверка: `npm run typecheck`, `npm run build`.
```

---

## Этап 9: Тестирование фронтенда (Vitest) и CI/CD (GitHub Actions)
**Приоритет: P1 (Medium) | Спринт 3 | Зависимости: Этап 8, 19, 22, 29, 30 (покрывает модули `src/lib/`, хуки и UI)**

### Цель и контекст
В `package.json` сейчас есть только `dev`, `build`, `preview` и `typecheck`, а на фронтенде пока **0 тестовых файлов**. Отсутствуют автоматический раннер модульных/компонентных тестов (`src/lib/*.ts`, `src/hooks/*.ts`, UI-компоненты) и CI-пайплайн для контроля кроссплатформенной сборки и строгого линтинга.

### Критерии приемки (DoD)
- Установлены `vitest`, `jsdom` (и при необходимости `@testing-library/react`), настроена секция `test` в `vite.config.ts`, в `package.json` добавлены `"test": "vitest run"` и `"test:watch": "vitest"`.
- Unit- и регрессионными тестами покрыты ключевые модули:
  - `protocolInspectors.test.ts` (SSE/LLM, Protobuf wire-decoder включая `SAMPLE_GRPC_REQ_B64`, Multipart, Auth/JWT, RFC 9111 Cache);
  - `filterEngine.test.ts` (Filter Matrix, Bulk Hosts List, TLS Passthrough parity);
  - `settingsManager.test.ts` (валидация, миграция, `BreakpointConfig`, rollback `applySettingsProfile` и экспорт/импорт `FluxUserSettingsProfile`);
  - `formatters.test.ts` (экранирование `buildCurlCommand`, `decodeBase64ToBytes` на битом вводе);
  - `sessionDiff.test.ts`, `textWizard.test.ts` (включая Zstd fallback и JWT `null`-секции);
  - `useProxySessions.test.ts` (гонка `setProxyPort`, фильтрация, `replaySessions` binary body, StrictMode unmount после `subscribeSessionBatches`);
  - `curlParser.test.ts`, `codeGenerators.test.ts`, `openApiGenerator.test.ts`, `themePresets.test.ts` (при наличии модулей к моменту запуска этапа).
- Создан `.github/workflows/ci.yml` с матрицей `ubuntu-latest` (с системными библиотеками WebKitGTK/Tauri), `windows-latest` и `macos-latest`, прогоняющий `npm ci`, `npm run typecheck`, `npm run test`, `npm run build`, `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` и `cargo test --manifest-path src-tauri/Cargo.toml`.

### 📝 Промпт для Antigravity (Этап 9)

```markdown
Роль: Senior QA & DevOps / Frontend Automation Engineer.
Проект: FluxProxy (Tauri v2 + Rust + React 18 + TypeScript).

Задача: Подключить Vitest для модульного/интеграционного тестирования TypeScript-логики в `src/lib/` и `src/hooks/` и настроить кроссплатформенный GitHub Actions CI.

1. Настройка Vitest (`package.json`, `vite.config.ts`):
   - Добавить dev-зависимости `vitest`, `jsdom` (и `@testing-library/react` для тестирования хуков/компонентов, совместимые с `vite: ^6.0.3` и `react: ^18.3.1`).
   - Настроить `test: { environment: "jsdom", include: ["src/**/*.test.ts", "src/**/*.test.tsx"] }` в `vite.config.ts` (через `vitest/config` или корректные типы, чтобы `npm run typecheck` и `npm run build` оставались чистыми).
   - Добавить скрипты `"test": "vitest run"` и `"test:watch": "vitest"` в `package.json`.

2. Unit- и регрессионные тесты (`src/**/*.test.ts(x)`):
   - Написать надежные тесты для `protocolInspectors.ts`, `filterEngine.ts`, `settingsManager.ts` (включая `BreakpointConfig` и откат), `formatters.ts` (шелл-экранирование и `decodeBase64ToBytes`), `sessionDiff.ts`, `textWizard.ts` (включая JWT с `null`), `useProxySessions.ts` (порт/StrictMode/replay), а также для добавленных на предыдущих этапах `curlParser.ts`, `codeGenerators.ts`, `openApiGenerator.ts`, `themePresets.ts`.

3. GitHub Actions (`.github/workflows/ci.yml`):
   - Матрица ОС: `ubuntu-latest`, `windows-latest`, `macos-latest`.
   - Для `ubuntu-latest` установить системные зависимости Tauri v2 (`libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`).
   - Настроить кэширование `npm` и `Cargo` (`Swatinem/rust-cache`), запускать `npm ci`, `npm run typecheck`, `npm run test`, `npm run build`, `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` и `cargo test --manifest-path src-tauri/Cargo.toml`.

Проверка: `npm run typecheck`, `npm run test`, `npm run build`, `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`.
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
**Приоритет: P2 (Feature) | Спринт 4 | Зависимости: Этап 18, Этап 25**

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
