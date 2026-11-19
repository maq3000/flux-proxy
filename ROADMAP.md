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

---

## 📋 Матрица приоритетов и порядок выполнения

> *Номера этапов (`6–22`) используются как стабильные идентификаторы задач (`phase-N`). Все секции документа ниже отсортированы строго в порядке выполнения сверху вниз. Завершенные этапы Спринта 1 (Этапы 14, 15, 20, 21, 25–28) выполнены в релизе `v0.2.0`, а этапы Спринта 2 (Этапы 5, 16, 17, 23, 24, 29, 30) выполнены в релизе `v0.3.0` и перенесены в раздел реализованных этапов выше.*

| # | Этап | Приоритет | Спринт | Зависимости | Ключевая ценность |
| :-: | :--- | :--- | :--- | :--- | :--- |
| 1 | **[Этап 22](#этап-22-продвинутая-кастомизация-темы-пресеты-и-детальная-палитра-цветов)** | **P1 (High)** | Спринт 3 | — | 8 тем-пресетов (Dracula, Tokyo Night, Nord, Fiddler Classic и др.) и live-редактор CSS-токенов + Monaco |
| 2 | **[Этап 6](#этап-6-selective-mitm--bypass-20-bulk-editor-10-quick-packs-и-hit-counter)** | **P1 (High)** | Спринт 3 | Этап 25 ✅ | Пакетный редактор TLS-правил, расширение `TLS_BYPASS_QUICK_PACKS` до 10+ наборов, счетчик срабатываний и бейдж `TUNNEL` |
| 3 | **[Этап 18](#этап-18-клиентские-сертификаты-mtls--client-certificates-store)** | **P1 (High)** | Спринт 3 | Этап 25 ✅ | Хранилище PKCS#12/PEM-сертификатов с привязкой к маскам доменов и кэшируемыми mTLS-клиентами |
| 4 | **[Этап 7](#этап-7-кастомные-скрипты-на-python-python-scripting-engine)** | **P1 (Medium)** | Спринт 3 | Этап 14 ✅ | Автоматизация перехвата `on_request` / `on_response` через долгоживущий IPC-процесс Python + Monaco Editor |
| 5 | **[Этап 8](#этап-8-composer-20-умный-paste-curl-и-генератор-клиентского-кода-на-5-языках)** | **P1 (Medium)** | Спринт 3 | — | Парсер команд `cURL` из буфера обмена и генерация сниппетов (JS, Python, Go, Rust, cURL) |
| 6 | **[Этап 19](#этап-19-автоматическая-генерация-спецификаций-openapi-30--swagger)** | **P1 (Medium)** | Спринт 3 | Этап 16 ✅ | Генерация YAML/JSON OpenAPI 3.0 спецификации по выделенным сессиям с выводом JSON Schema |
| 7 | **[Этап 9](#этап-9-тестирование-фронтенда-vitest-и-cicd-github-actions)** | **P1 (Medium)** | Спринт 3 | Этап 8, 19, 22, 29 ✅, 30 ✅ | Покрытие движков `src/lib/*.ts` и хуков тестами Vitest и кроссплатформенный CI (включая `clippy -D warnings`) |
| 8 | **[Этап 10](#этап-10-сетевая-инфраструктура-hosts-remapping-и-bandwidth-throttling)** | **P2 (Feature)** | Спринт 4 | Этап 15 ✅, 25 ✅ | Виртуальный DNS (`resolve` / `CONNECT`) без правки системного `hosts` и эмуляция медленных сетей |
| 9 | **[Этап 11](#этап-11-архитектурная-декомпозиция-монолитов-и-внедрение-zustand)** | **P2 (Feature)** | Спринт 4 | — | Разделение крупных Rust/React-модулей, внедрение `zustand` и `React.lazy()` Code Splitting |
| 10 | **[Этап 12](#этап-12-аналитика-и-визуализация-waterfall-timeline-и-статистика-трафика)** | **P2 (Feature)** | Спринт 4 | — | Виртуализированная каскадная диаграмма таймингов и сводный Markdown-отчет (P95, статусы, MIME) |
| 11 | **[Этап 13](#этап-13-расширенные-протоколы-upstream-proxy-chaining-и-ws-инъекция)** | **P2 (Feature)** | Спринт 4 | Этап 18, 25 ✅ | Каскадирование трафика через внешний HTTP/HTTPS/SOCKS5-прокси и отправка фреймов в открытые WS |

---

## ⚙️ Общие инженерные правила

1. **Изоляция новых подсистем (Modular-First Guardrail):**
   Ключевые файлы уже достигли крупных размеров (`src-tauri/src/proxy/server.rs` ~6.9k строк, `export_import.rs` ~3.5k, `useProxySessions.ts` ~3.1k, `SettingsModal.tsx` ~3.0k, `App.tsx` ~2.9k, `filters.rs` ~2.4k, `FilterDrawer.tsx` ~2.2k). При реализации этапов Спринтов 2–3 **выносите новую логику в отдельные Rust-модули, TS-утилиты и React-компоненты**, минимизируя разрастание существующих монолитов до рефакторинга в Этапе 11.
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

> 📖 **Документация:** Подробное руководство пользователя, справочник API хуков `on_request` / `on_response` и практические рецепты вынесены в [**PYTHON_SCRIPTING_GUIDE.md**](PYTHON_SCRIPTING_GUIDE.md).

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
