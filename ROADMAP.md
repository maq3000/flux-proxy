# 🗺️ Дорожная карта (Roadmap) развития FluxProxy

> **FluxProxy** — современный кроссплатформенный локальный отладочный HTTP/HTTPS/WebSocket прокси на базе **Tauri v2 (Rust)** и **React 18 (TypeScript)**.
> 
> Данный документ содержит детальный поэтапный план развития проекта, матрицу приоритетов, технические спецификации задач и **готовые самодостаточные промпты для агента Antigravity** для последовательной реализации каждого этапа.

---

## ✅ Реализованные ключевые возможности (Verified Milestones)

По результатам аудита кодовой базы следующие функции уже реализованы, протестированы и не требуют повторной разработки:

1. **Поддержка мобильных устройств (iOS & Android)**:
   - Биндинг на все интерфейсы (`0.0.0.0` / `set_allow_remote`) и автоопределение LAN IP (`get_network_interfaces`).
   - Встроенный веб-портал `http://flux.proxy` с отдачей сертификатов: `.crt`, `.der`, `.pem`, Apple Configuration Profile `.mobileconfig`.
   - Модальное окно `MobileSetupModal.tsx` с QR-кодами, пошаговыми инструкциями и Android Network Security Config.
   - Покрыто интеграционными тестами (`mobile_portal_serves_html_crt_der_pem_and_ios_mobileconfig_on_all_interfaces`).
2. **Массовый фильтр хостов и URL (Bulk Hosts List)**:
   - Вкладка `HostFiltersTab.tsx` с многострочным вводом доменов, масок `*.example.com` и регулярных выражений `regex:`.
   - Режимы Whitelist и Blacklist, чипы топ-хостов, импорт/экспорт списков и синхронизация с бэкендом.
3. **Устранение конфликта с SignalR**:
   - В `server.rs` (`build_upstream_websocket_request`) реализован полный форвардинг заголовков клиента (`Authorization`, `Cookie`, `Sec-WebSocket-Protocol`, `X-SignalR-*`).
   - Покрыто unit-тестом `websocket_signalr_forwards_auth_cookies_subprotocol_and_response_headers`.
4. **Базовая эргономика UI**:
   - Интерактивный ресайз колонок мышь/auto-fit с мутацией CSS переменных (60 FPS) в `TrafficGrid.tsx`.
   - Полнофункциональное меню `MenuBar.tsx` (`File`, `Edit`, `Rules`, `View`, `Tools`, `Help`).
   - Горячие клавиши (`Space`, `Enter`, `Delete`, `Ctrl+X`, `R`, `U`, `M`, `Ctrl+C`, `F12`, стрелки) и справка `ShortcutsModal.tsx`.

---

## 📋 Содержание и актуализированная матрица приоритетов

| Этап | Приоритет | Название этапа | Ключевая ценность |
| :--- | :--- | :--- | :--- |
| **[Этап 1](#этап-1-сетевая-надежность-предотвращение-обхода-http3-alt-svc-и-безопасность-cacsp)** | **P0 (Critical)** | Сетевая надежность, обход HTTP/3 (Alt-Svc) и безопасность CA/CSP | Предотвращение утечки трафика в обход прокси и безопасная работа с корневым сертификатом |
| **[Этап 2](#этап-2-управление-памятью-ring-buffer-с-лимитом-сессий-fiddler-style-фильтрация-при-захвате-drop-non-matching-и-оффлоадинг-тел)** | **P0 (Critical)** | Ring Buffer (Fiddler-style), отбрасывание трафика вне фильтра и оффлоадинг тел | Гибкий лимит сессий (выпадающий список + ручной ввод), сброс нецелевого трафика на лету и защита от OOM |
| **[Этап 3](#этап-3-полная-поддержка-спецификации-har-12-дампы-fiddler-saz-и-raw-export)** | **P0 (Critical)** | Спецификация HAR 1.2, Fiddler SAZ и сохранение сырых тел (Raw Export) | Индустриальная совместимость с Chrome DevTools, Postman, Fiddler и выгрузка тел запросов/ответов |
| **[Этап 4](#этап-4-версионирование-и-экспорт--импорт-профилей-пользовательских-настроек)** | **P0 (High)** | Версионирование и экспорт / импорт профилей настроек (Settings Profile) | Единый JSON-файл конфигурации (v1), сохранение фильтров, колонок, пресетов и перенос между ПК |
| **[Этап 5](#этап-5-оптимизация-вертикального-пространства-ui-компактный-тулбар-и-меню-шапки)** | **P0 (High)** | Оптимизация вертикального пространства: Slim Toolbar и меню шапки | Освобождение до 70px высоты экрана, контекстное скрытие колонок и шорткаты инспектора |
| **[Этап 6](#этап-6-selective-mitm--bypass-20-массовые-фильтры-bulk-editor-расширенная-база-правил-tls-pinning-и-1-click-ux)** | **P1 (High)** | Selective MITM 2.0: Массовый ввод хостов, расширенная база TLS Pinning и 1-Click UX | Пакетный редактор доменов, готовые Quick-Packs (Dev/DRM/Игры/Fintech), защита от сбоев сторонних программ |
| **[Этап 7](#этап-7-кастомные-скрипты-на-python-python-scripting-engine)** | **P1 (Medium)** | Кастомные скрипты на Python (Python Scripting Engine) | Автоматизация перехвата «на лету» (хуки `on_request`/`on_response`), Monaco Editor и логирование |
| **[Этап 8](#этап-8-composer-20-умный-paste-curl-и-генератор-клиентского-кода-на-5-языках)** | **P1 (Medium)** | Composer 2.0: Умный «Paste cURL» и генератор кода | Ускорение тестирования API и генерация кода для JS, Python, Go, Rust |
| **[Этап 9](#этап-9-тестирование-фронтенда-vitest-и-cicd-github-actions)** | **P1 (Medium)** | Тестирование фронтенда (Vitest) и CI/CD (GitHub Actions) | Автоматическая верификация парсеров Protobuf, SSE, Multipart и матричных фильтров |
| **[Этап 10](#этап-10-сетевая-инфраструктура-hosts-remapping-virtual-dns-и-bandwidth-throttling)** | **P2 (Feature)** | HOSTS Remapping (Virtual DNS) и Bandwidth Throttling | Локальный редирект доменов без правок hosts ОС и физическая эмуляция медленной сети |
| **[Этап 11](#этап-11-архитектурная-декомпозиция-монолитов-и-внедрение-стейт-менеджера-zustand)** | **P2 (Feature)** | Архитектурная декомпозиция монолитов и Zustand | Разделение файлов-гигантов (server.rs, FilterDrawer), ускорение IDE и бандла |
| **[Этап 12](#этап-12-аналитика-и-визуализация-waterfall-timeline-и-панель-статистики-трафика)** | **P2 (Feature)** | Waterfall Timeline и панель агрегированной статистики | Наглядная каскадная диаграмма таймингов и многомерная статистика по выборке сессий |
| **[Этап 13](#этап-13-расширенные-протоколы-upstream-proxy-chaining-и-ws-инъекция)** | **P2 (Feature)** | Upstream Proxy Chaining и инъекция фреймов WebSocket | Работа за корпоративным вышестоящим прокси и ручная отправка WS-сообщений |

---

## ⚙️ Общие правила и рекомендации по выполнению

1. **Последовательное выполнение по спринтам:** Рекомендуется двигаться строго по приоритетам (P0 → P1 → P2). Каждый этап логически опирается на стабильность предыдущего.
2. **Контроль сборки и тестов после каждого шага:**
   - Проверка типов TypeScript: `npm run typecheck` или `npx tsc --noEmit`
   - Сборка фронтенда: `npm run build`
   - Тесты бэкенда: `cd src-tauri && cargo test`
3. **Фиксация в Git:** После каждого завершенного промпта создавайте атомарный коммит:
   ```bash
   git add .
   git commit -m "feat(phase-N): <краткое описание выполненного этапа>"
   ```
4. **Сохранение Dual-Mode разработки:** Всегда сохраняйте работоспособность Browser Preview Simulator (`src/lib/mockTraffic.ts`, `src/lib/tauriBridge.ts`), чтобы интерфейс можно было полноценно тестировать в обычном браузере (`npm run dev`) без обязательной локальной компиляции Rust-ядра.

---

## Этап 1: Сетевая надежность, предотвращение обхода HTTP/3 (Alt-Svc) и безопасность CA/CSP
**Приоритет: P0 (Critical) | Спринт 1 (Безопасность и ядро)**

### Описание задачи
1. **Проблема HTTP/3 (QUIC / UDP 443):** Браузеры (Chrome, Edge, Safari), получая заголовок `Alt-Svc: h3="..."`, переключают последующие запросы к серверам Google, Cloudflare и др. на UDP-порт 443, полностью минуя системный TCP-прокси. Требуется принудительно вырезать заголовки `alt-svc` и `alternate-protocol`.
2. **Удаление Root CA:** В системе реализована только установка корневого сертификата в доверенные ОС, но нет штатного механизма его отзыва и деинсталляции (`uninstall`).
3. **Безопасность:** В `tauri.conf.json` выставлен `csp: null`, а приватный ключ CA на Unix-системах сохраняется без явного ограничения прав `0600`.

### Критерии приемки
- Заголовки `alt-svc` и `alternate-protocol` удаляются из всех проксируемых HTTP/1.1 и HTTP/2 ответов (управляется флагом `strip_alt_svc` в `ProxyFilterBackendConfig`).
- Реализована команда Tauri `uninstall_root_ca`, корректно удаляющая сертификат из доверенных хранилищ Windows (`certutil`), macOS (`security`) и Linux (`update-ca-certificates`).
- В модальном окне `CertificateModal.tsx` доступна кнопка удаления сертификата.
- В `tauri.conf.json` настроена строгая политика CSP.
- `cargo test`, `npm run build` проходят без ошибок.

---

### 📝 Промпт для Antigravity (Этап 1)

```markdown
Роль: Senior Systems Engineer (Rust / Tokio / Hyper) & Security Specialist.
Проект: FluxProxy — кроссплатформенный отладочный веб-прокси (Tauri v2 + Rust + React 18).

Задача: Устранить три критические проблемы сетевой надежности и безопасности:

1. Предотвращение обхода прокси через HTTP/3 (QUIC / UDP 443):
   - Браузеры, получая в ответах заголовок `Alt-Svc: h3="..."`, переключают запросы на UDP-порт 443, минуя локальный TCP-прокси.
   - В `src-tauri/src/proxy/server.rs` и `src-tauri/src/proxy/filters.rs` добавь автоматическое удаление заголовков `alt-svc` и `alternate-protocol` из всех перехватываемых HTTP/1.1 и HTTP/2 ответов.
   - Добавь в настройки `ProxyFilterBackendConfig` переключатель `strip_alt_svc: bool` (по умолчанию `true`).

2. Механизм удаления Root CA из доверенного хранилища ОС:
   - В `src-tauri/src/proxy/ca.rs` реализуй метод `uninstall_from_os_trust_store(&self) -> Result<String, ProxyError>`:
     * Windows: `certutil -user -delstore Root <thumbprint/common_name>`
     * macOS: `security delete-certificate -c "FluxProxy Local Debugging Root CA"`
     * Linux: удаление файла из `/usr/local/share/ca-certificates/` и вызов `update-ca-certificates --fresh`.
   - Экспортируй команду `uninstall_root_ca` в `commands.rs` и `lib.rs`.
   - В `src/components/CertificateModal.tsx` и `src/lib/tauriBridge.ts` добавь кнопку «Удалить сертификат из доверенных ОС» рядом с кнопкой установки.
   - На Unix/macOS гарантируй права доступа `0600` на создаваемый файл приватного ключа `fluxproxy-root-ca.key`.

3. Настройка CSP в Tauri:
   - В `src-tauri/tauri.conf.json` замени `csp: null` на безопасную политику для локального webview:
     `"csp": "default-src 'self' tauri: asset:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: asset:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost tauri: http://localhost:*; worker-src 'self' blob:;"`

Критерии готовности:
- `cargo test` проходит (добавить unit-тесты на стриппинг заголовка Alt-Svc и удаление CA).
- `npm run build` завершается без ошибок.
- В интерфейсе CertificateModal появляется кнопка деинсталляции сертификата с обновлением статуса.
```

---

## Этап 2: Управление памятью: Ring Buffer с лимитом сессий (Fiddler-style), фильтрация при захвате (Drop Non-Matching) и оффлоадинг тел
**Приоритет: P0 (Critical) | Спринт 1 (Масштабируемость и защита памяти)**

### Описание задачи
Все сессии сейчас сохраняются в оперативной памяти без верхнего предела (`DashMap` в Rust и массив сессий в React). При непрерывном сборе трафика или скачивании тяжелых файлов (видео, дистрибутивы) это приводит к росту RAM до гигабайтов и риску падения процесса (OOM).

Необходимо реализовать:
1. **Гибкий лимит одновременного хранения сессий в стиле Fiddler Classic**:
   - Выпадающий список в тулбаре и строке состояния: `Keep: [All Sessions v]` с быстрыми пресетами: `All Sessions (Без ограничений)`, `100`, `250`, `500`, `1 000`, `2 500`, `5 000`, `10 000`, `Custom...`.
   - При выборе `Custom...` или клике на число открывается компактное поле ввода, где пользователь может ввести **любое произвольное число** (например, `750` или `3000`).
   - При превышении установленного лимита старейшие сессии автоматически вытесняются по принципу FIFO из оперативной памяти Rust (`TrafficStore`) и из состояния React (`useProxySessions.ts`), сохраняя стабильные 60 FPS скролла.
2. **Фильтрация на этапе захвата (Drop Non-Matching Sessions on Capture)**:
   - В Fiddler отлаживать конкретный целевой API среди сотен фоновых процессов ОС помогает опция не сохранять отфильтрованный трафик.
   - Опция `Drop non-matching traffic on capture` («Не сохранять запросы, не отвечающие текущим фильтрам»): если флаг включен, входящий поток проверяется по активным критериям (Hosts List, Matrix, Noise thresholds) прямо в ядре перехвата (`server.rs` / `filters.rs`).
   - Не прошедшие фильтр запросы **не сохраняются в `DashMap` и SQLite** и **не отправляются в React**, экономя до 95% RAM и ресурсов CPU.
   - В строке состояния отображается счетчик отброшенных сессий: `Dropped: N` с возможностью быстрого сброса счетчика.
3. **Оффлоадинг тяжелых тел (Lazy Body Offloading)**:
   - Тела запросов/ответов крупнее 2 МБ не хранятся дублирующими строками в памяти, а сбрасываются во временное хранилище / SQLite и подгружаются лениво только при открытии инспектора.

### Критерии приемки
- В тулбаре и строке состояния доступен селектор лимита сессий `Keep: N` с пресетами и полем произвольного числового ввода.
- Кольцевой буфер (FIFO) строго соблюдает лимит: при поступлении новой сессии сверх лимита старейшая сессия немедленно удаляется из памяти фронтенда и бэкенда.
- Доступна опция «Не сохранять запросы вне фильтра»: отсеянные сессии не расходуют память, в строке состояния отображается живой счетчик `Dropped: N`.
- Тела более 2 МБ вытесняются на диск и подгружаются лениво по клику в инспекторе.
- `cargo test`, `npm run build` проходят успешно; unit-тесты покрывают вытеснение FIFO и стриминговый дроп.

---

### 📝 Промпт для Antigravity (Этап 2)

```markdown
Роль: Senior Systems Architect (Rust / SQLite) & Frontend Performance Specialist.
Проект: FluxProxy — кроссплатформенный отладочный веб-прокси (Tauri v2 + Rust + React 18).

Задача: Реализовать кольцевой буфер (Ring Buffer) с гибким ограничением сессий в стиле Fiddler (пресеты + ручной ввод), фильтрацию на этапе захвата (Drop Non-Matching Traffic on Capture) и ленивую загрузку тяжелых тел для абсолютной защиты от Out Of Memory (OOM).

1. Бэкенд (Rust):
   - В `src-tauri/src/storage/mod.rs` добавь настройку `session_retention_limit: Option<usize>` (None = без ограничений; дефолт: 10 000).
   - При добавлении новой сессии в `TrafficStore::insert`:
     * Если задан лимит и размер `sessions: DashMap` превышает его, удалять старейшие сессии по `id` (FIFO). При необходимости полной сохранности старейшие детали сбрасывать в SQLite (`sqlite.rs`), освобождая их из оперативной памяти.
   - Фильтрация на этапе захвата (`drop_non_matching_on_capture: bool` в `ProxyFilterBackendConfig`):
     * В `server.rs` при завершении запроса вызывать быстрый предикат `evaluate_should_store_session(&session_summary)`.
     * Если опция активна и сессия отсекается активными фильтрами (хост-лист, noise thresholds):
       - НЕ вызывать `TrafficStore::insert`.
       - НЕ отправлять IPC-событие сессии в UI через `emit("proxy://session-batch", ...)`.
       - Инкрементировать атомарный счетчик `dropped_sessions_count: AtomicU64`.
   - Добавить Tauri команды:
     * `set_session_retention_limit(limit: Option<usize>) -> Result<(), ProxyError>`
     * `set_drop_non_matching(enabled: bool) -> Result<(), ProxyError>`
     * `get_memory_storage_stats() -> Result<StorageStats, ProxyError>` (сессий в RAM, размер SQLite в байтах, отброшено сессий).
   - Оффлоадинг больших тел: если `response_body` превышает 2 МБ, сохранять его во временный файл/SQLite, устанавливая в `SessionDetail` флаг `body_offloaded: true`, и подгружать только командой `load_session_body(id, is_response)`.

2. Фронтенд (React / TypeScript):
   - В `src/hooks/useProxySessions.ts`:
     * Поддержать усечение массива `sessions` при поступлении пакетов в `flushPendingSessions`: `if (limit && next.length > limit) next.splice(0, next.length - limit)`.
     * Сохранять выбор лимита и опцию `dropNonMatching` в `localStorage` и синхронизировать с бэкендом при старте и изменении.
     * Отслеживать счетчик `droppedCount` через периодический опрос или событие из Rust.
   - В `TopToolbar.tsx` и `App.tsx` (Status Footer) добавить Fiddler-style контрол:
     * Комбинированный селектор `Keep: [All Sessions v]`:
       - Опции: `All Sessions`, `100`, `250`, `500`, `1 000`, `2 500`, `5 000`, `10 000`, `Custom...`.
       - Инлайн-инпут для ручного ввода произвольного числа (с валидацией > 0).
     * Чекбокс / кнопка-бейдж «Drop Non-Matching» с подсказкой «Не сохранять в память запросы, отсеянные фильтром».
     * В строке состояния (footer) индикатор: `RAM: 1,250 ses | SQLite: 4.2 MB | Dropped: 312`.
   - В `MenuBar.tsx` -> **Tools** добавить подменю `Session Retention Limit...`.

Критерии готовности:
- Написаны unit-тесты в Rust на FIFO-вытеснение в `TrafficStore` и работу стримингового дропа.
- Ввод любого ручного лимита (например, 777) мгновенно ограничивает количество сессий в гриде и в памяти Rust ровно до 777.
- При включении «Drop Non-Matching» фоновый системный шум (svchost, телеметрия) не попадает в оперативную память и не засоряет список.
- `cargo test` и `npm run build` проходят без ошибок.
```

---

## Этап 3: Полная поддержка спецификации HAR 1.2, дампы Fiddler SAZ и Raw Export
**Приоритет: P0 (Critical) | Спринт 1 (Совместимость и обмен данными)**

### Описание задачи
Сейчас сессии можно сбросить только во внутренний SQLite-дамп. Пользователю требуется возможность:
1. Экспортировать и импортировать стандартный `.har` (HTTP Archive 1.2) для обмена логами с Chrome DevTools, Charles, Postman.
2. Экспортировать и импортировать архивы `.saz` (Fiddler Session Archive Zip с файлами `raw/*_c.txt`, `raw/*_s.txt`, `raw/*_m.xml`).
3. Сохранять отдельные тела запросов и ответов на диск (`Save Body As...`) с правильным расширением по MIME-типу, а также выгружать сырой текст запроса/ответа.

### Критерии приемки
- Реализован конвертер HAR 1.2 (экспорт/импорт) с таймингами, куками, заголовками и телами.
- Реализован упаковщик и распаковщик Fiddler `.saz` архивов.
- Доступны действия сохранения отдельных тел запросов и ответов в файл.
- Поддерживается Drag-and-Drop `.har` и `.saz` файлов в окно приложения.
- Экспортированный HAR валиден и открывается в Chrome DevTools (`Network -> Import HAR`).

---

### 📝 Промпт для Antigravity (Этап 3)

```markdown
Роль: Senior Full-Stack Engineer (Rust + TypeScript).
Проект: FluxProxy — отладочный веб-прокси (Tauri v2 + Rust + React 18).

Задача: Реализовать экспорт и импорт спецификации HAR 1.2, архивов Fiddler Classic (.saz), а также сохранение сырых тел запросов/ответов (Raw Export).

1. Rust бэкенд (`src-tauri/Cargo.toml`, `src-tauri/src/storage/export_import.rs`, `commands.rs`):
   - Добавь зависимость `zip = { version = "2.2", default-features = false, features = ["deflate"] }` в `Cargo.toml`.
   - Создай модуль `src-tauri/src/storage/export_import.rs`:
     * HAR 1.2 Serializer/Deserializer: преобразование `Vec<SessionDetail>` в валидный HAR 1.2 (log, creator, pages, entries с полями startedDateTime, time, request, response, content, timings, cookies).
     * SAZ Builder & Reader (Fiddler Zip): чтение и запись zip-контейнера с директорией `raw/` (файлы `N_c.txt` - клиентский запрос, `N_s.txt` - ответ сервера, `N_m.xml` - тайминги и метаданные).
     * Raw Body Exporter: запись бинарного/текстового тела сессии в указанный файл на диске.
   - Зарегистрируй команды Tauri:
     * `export_sessions_file(session_ids: Vec<u64>, format: String, file_path: String) -> Result<usize, ProxyError>`
     * `import_sessions_file(file_path: String) -> Result<Vec<SessionSummary>, ProxyError>`
     * `save_session_body_file(session_id: u64, is_response: bool, file_path: String) -> Result<usize, ProxyError>`

2. Интеграция с нативными диалогами ОС:
   - Использовать нативный диалог сохранения и выбора файлов (через Tauri plugin dialog или rfd) с фильтрами расширений (*.har, *.saz, *.json, *.*).

3. Интерфейс (`src/components/MenuBar.tsx`, `TrafficGrid.tsx`, `SessionInspector.tsx`):
   - В `MenuBar.tsx` -> **File**:
     * `Save All Sessions As... (Ctrl+S)` -> выбор формата (.har, .saz, .json).
     * `Save Selected Sessions...` (активно при наличии выделения).
     * `Open / Import Archive... (Ctrl+O)` -> импорт .har, .saz, .json в грид.
   - В контекстное меню строки сессии в `TrafficGrid.tsx`:
     * `Save Selected as HAR (.har)`
     * `Save Selected as Fiddler SAZ (.saz)`
     * `Save Request Body As...` (авто-имя: `request_{id}.bin` или по mime-типу).
     * `Save Response Body As...` (авто-имя: `response_{id}.json` / `.png` / `.html`).
     * `Save Full Raw HTTP Message (.txt)`
   - В `SessionInspector.tsx` во вкладках Request и Response добавить иконку сохранения тела в файл.
   - Поддержка Drag-and-Drop: перетаскивание .har или .saz файла на окно FluxProxy автоматически загружает сессии в грид.

Критерии готовности:
- Написаны unit-тесты на Roundtrip в Rust (`cargo test`).
- Экспортированный HAR без ошибок импортируется в Chrome DevTools (Network -> Import HAR).
- Файл .saz из Fiddler Classic корректно открывается во FluxProxy.
- `npm run build` завершается без ошибок.
```

---

## Этап 4: Версионирование и экспорт / импорт профилей пользовательских настроек
**Приоритет: P0 (High) | Спринт 1 (Управление конфигурацией)**

### Описание задачи
Сейчас настройки приложения хранятся в 8 разрозненных ключах `localStorage` без версионирования схемы. При очистке кэша или переносе на другую машину все кастомные пресеты, списки хостов, ширина колонок и правила AutoResponder теряются.

Требуется создать централизованную систему версионированных профилей настроек (`schemaVersion: 1`), экспорт и импорт в JSON-файл и сброс к дефолтам.

### Критерии приемки
- Типизированный интерфейс `FluxUserSettingsProfile` с версией схемы (`schemaVersion: 1`).
- Модуль миграций, гарантирующий безопасное обновление устаревших конфигов.
- Модальное окно `SettingsModal.tsx` и пункты меню `File -> Export Settings...` / `Import Settings...`.
- Возможность сбросить настройки до заводских («Reset to Defaults»).

---

### 📝 Промпт для Antigravity (Этап 4)

```markdown
Роль: Senior Frontend Architecture Engineer (React + TypeScript).
Проект: FluxProxy — отладочный веб-прокси (Tauri v2 + React 18).

Задача: Реализовать централизованный модуль управления профилями настроек пользователя с версионированием схемы (`schemaVersion: 1`), экспортом/импортом в единый JSON-файл и безопасным сбросом к дефолтам.

1. Типизация схемы профиля (`src/types/settings.ts`):
   - Описать структуру `FluxUserSettingsProfile`:
     * `schemaVersion: number` (текущая версия = 1)
     * `exportedAt: string`
     * `ui`: тема (dark/light/system), compactToolbar, sidebarCollapsed, inspectorCollapsed, inspectorPosition (bottom/right), followTail, columnWidths (Record<ColumnId, number>), visibleColumns (Record<ColumnId, boolean>), toolbarGroups (Record<ToolbarGroupId, boolean>).
     * `filters`: activePresetId, userPresets (FilterPreset[]), noiseThresholds, hostFilters (HostListFilterConfig).
     * `proxy`: port, autoSystemProxy, allowRemote, tlsInterceptMode (interceptAll/targetedOnly), tlsBypassRules, tlsTargetRules, headerMutations.
     * `autoResponder`: enabled, rules (AutoResponderRule[]).

2. Менеджер настроек и миграций (`src/lib/settingsManager.ts`):
   - `exportCurrentSettingsProfile()`: сбор всех настроек из хуков и localStorage в единый объект и сохранение файла `fluxproxy-settings-v1.json`.
   - `validateAndMigrateSettingsProfile(rawJson: unknown): FluxUserSettingsProfile`: валидация, fallback к дефолтам при повреждении отдельных полей, поддержка цепочки версионных миграций.
   - `applySettingsProfile(profile: FluxUserSettingsProfile)`: атомарное сохранение в localStorage, обновление React-состояния и отправка обновленных правил прокси в Rust (`update_proxy_filter_config`).
   - `resetAllSettingsToDefault()`: сброс всех настроек с подтверждением.

3. UI настроек (`src/components/SettingsModal.tsx`, `MenuBar.tsx`):
   - Создать модальное окно настроек `SettingsModal.tsx` с вкладками: General, UI & Columns, Filters, Rules & Proxy, Backup & Export.
   - В меню `MenuBar.tsx` -> **File** добавить пункты:
     * `Export Settings Profile (JSON)...`
     * `Import Settings Profile...` (с модальным превью: сколько пресетов, правил и колонок будет перезаписано).
     * `Preferences... (Ctrl+,)`
   - Кнопка «Reset to Defaults» с предупреждением.

Критерии готовности:
- Экспорт настроек формирует валидный JSON с `schemaVersion: 1`.
- Импорт корректно восстанавливает ширину колонок, скрытые элементы тулбара, правила фильтрации и AutoResponder.
- При загрузке невалидного JSON выводится понятная ошибка в тосте, приложение не падает.
- `npm run build` проходит без ошибок.
```

---

## Этап 5: Оптимизация вертикального пространства UI: компактный тулбар и меню шапки
**Приоритет: P0 (High) | Спринт 2 (Эргономика и UX)**

### Описание задачи
Сейчас верхняя часть приложения (`MenuBar` + `TopToolbar` + панель поиска) занимает до 180px по высоте, что сильно ограничивает рабочую область таблицы на ноутбуках. Кроме того, скрывать колонки можно только через верхнее меню `View`, а не прямо из шапки таблицы.

### Критерии приемки
- Переключатель «Compact Toolbar» в меню `View (Ctrl+Shift+T)`, объединяющий ключевые контролы в одну строку высотой 36–40px.
- Контекстное меню шапки таблицы (правый клик по заголовку колонки) с чекбоксами видимости колонок, автоподбором ширины (Auto-fit all) и сбросом к дефолтам.
- Горячие клавиши `Ctrl+F` (фокус быстрого поиска) и `Ctrl+1..6` (переключение табов инспектора).

---

### 📝 Промпт для Antigravity (Этап 5)

```markdown
Роль: Senior UX / Frontend Engineer (React 18 + Tailwind CSS).
Проект: FluxProxy — отладочный веб-прокси (Tauri v2 + React 18).

Задача: Оптимизировать вертикальное пространство интерфейса (режим Slim Toolbar), добавить контекстное меню в шапку таблицы сессий и расширить горячие клавиши.

1. Компактный режим тулбара (Slim Toolbar):
   - В `src/hooks/useUiPreferences.ts` добавить опцию `compactToolbar: boolean` (по умолчанию `false`).
   - В `src/components/TopToolbar.tsx` реализовать альтернативную ультра-компактную компоновку (высота строки 36–40px):
     * В единой строке: Play/Pause перехвата, кнопка Clear, Follow Tail, счетчик сессий (120/450), поле быстрого поиска с кнопкой RegExp, компактные фильтр-чипы (All, API, WS, 4xx/5xx) и меню переполнения `•••`.
   - В `src/components/MenuBar.tsx` -> **View** добавить пункт `Compact Toolbar (Ctrl+Shift+T)`.

2. Контекстное меню шапки таблицы (Header Column Picker):
   - В `src/components/TrafficGrid.tsx` перехватывать правый клик мыши (`onContextMenu`) по шапке таблицы.
   - Открывать контекстное меню:
     * Список всех колонок (ID, Status, Method, Protocol, Host, URL, Process, Size, Time, Comment) с чекбоксами для быстрого скрытия/показа.
     * Разделитель.
     * `Auto-fit This Column` (автоподбор ширины по контенту).
     * `Auto-fit All Columns` (автоподбор ширины всех видимых колонок).
     * `Reset Column Widths to Default`.

3. Горячие клавиши:
   - `Ctrl+F` / `Cmd+F`: из любого места приложения мгновенно фокусирует поле поиска в тулбаре.
   - `Ctrl+1` ... `Ctrl+6` (или `Alt+1` ... `Alt+6`): мгновенно переключает вкладки инспектора (Headers, Preview/JSON, Auth, WebSocket, Hex, Timings).

Критерии готовности:
- При включении Compact Toolbar таблица сессий получает прирост высоты на 50–70px.
- Правый клик по шапке таблицы мгновенно открывает контекстное меню управления колонками.
- Все шорткаты работают стабильно, `npm run build` проходит без ошибок.
```

---

## Этап 6: Selective MITM & Bypass 2.0: Массовые фильтры (Bulk Editor), расширенная база правил TLS Pinning и 1-Click UX
**Приоритет: P1 (High) | Спринт 2 (Сетевая надежность и избирательный перехват)**

### Описание задачи
Режим избирательного перехвата (Selective MITM) — ключевое конкурентное преимущество FluxProxy перед Fiddler и Charles. Он позволяет расшифровывать только нужные веб-сервисы, а остальной трафик пробрасывать в нетронутом виде через быстрый TCP-туннель (`tokio::io::copy_bidirectional`), полностью устраняя проблемы с Certificate Pinning и SignalR.

Однако сейчас добавление правил в «Selective MITM & Bypass» возможно только по одному домену через одиночную форму, базовый список исключений минимален (всего 4 записи), а популярные сторонние приложения (Spotify, Steam, Git, npm, Apple APNs) при глобальном перехвате спамят ошибками.

Необходимо реализовать:
1. **Массовые фильтры и пакетный редактор (Bulk Editor & Fast Input)**:
   - Двухрежимное отображение для списков **Target Allowlist** и **TLS Bypass Table**:
     * **Табличный вид (Table View)**: классическая таблица со статусом, категорией, паттерном, заметкой и счетчиком срабатываний.
     * **Пакетный текстовый редактор (Bulk Text Mode)**: переключение вкладки в многострочное текстовое поле (аналогично `HostFiltersTab`) со свободной вставкой доменов, масок `*.domain.com`, исключений `!sub.domain.com`, регулярных выражений `regex:`, комментариев `#` и разделителей (перенос строки, запятая, точка с запятой).
   - Кнопка **«Пакетное добавление» (Quick Paste List)**: модальное окно/поповер для вставки сырого списка хостов из буфера (из логов, документации, чата команды) с выбором целевой категории и автопарсингом в правила.
   - **Массовые операции (Bulk Actions Toolbar)**:
     * Чекбокс «Выбрать все / Инвертировать выбор».
     * «Включить выбранные (N)» / «Отключить выбранные (N)».
     * «Удалить выбранные (N)».
     * «Экспорт списка в TXT/JSON» и «Импорт из TXT/JSON».
   - **Сниффер хостов сетевого трафика (Detected Hosts Chips)**: панель обнаруженных в текущем сеансе доменов с числом запросов и кнопками в 1 клик `+ в Bypass` / `+ в Target`.
2. **Расширение базового списка и курируемые Quick-Packs TLS / MITM Bypass**:
   - **Критические PKI-сервисы (OCSP / CRL) включены по умолчанию в базовый конфиг**: `ocsp.*, crl.*, *.digicert.com, *.sectigo.com, *.letsencrypt.org` (защита от циклической зависимости при проверке отзывов сертификатов).
   - Расширенный базовый набор по умолчанию:
     * Apple Ecosystem & APNs: `*.apple.com, *.icloud.com, *.mzstatic.com, *.cdn-apple.com, *.push.apple.com, gateway.push.apple.com`
     * Windows Updates & Services: `*.windowsupdate.com, *.delivery.mp.microsoft.com, *.update.microsoft.com, *.msftconnecttest.com, *.smartscreen.microsoft.com`
     * Мессенджеры с жестким пиннингом: `*.telegram.org, *.whatsapp.net, *.signal.org, *.discord.gg, *.slack-msgs.com, *.teams.microsoft.com`
     * Платежи и 3-D Secure: `*.stripe.com, *.stripe.network, *.paypal.com, *.braintreegateway.com, *.3dsecure.io, *.cardinalcommerce.com, *.adyen.com`
   - **10 готовых курируемых Quick-Packs (добавление в 1 клик)**:
     * 🛠️ **Dev Tools & Package Managers**: `github.com, *.githubusercontent.com, registry.npmjs.org, pypi.org, files.pythonhosted.org, crates.io, *.docker.io, registry-1.docker.io, proxy.golang.org` (устраняет сбои git, npm, pip, cargo при включенном прокси).
     * 🎵 **DRM & Streaming**: `*.spotify.com, dealer.spotify.com, audio-ak-spotify-com.akamaized.net, *.netflix.com, *.nflxvideo.net` (клиенты Spotify/Netflix не уходят в офлайн).
     * 🎮 **Gaming & Anti-Cheat**: `*.steampowered.com, *.steamcommunity.com, *.steamstatic.com, *.epicgames.com, *.riotgames.com, *.battle.net` (Steam и лаунчеры с античитом).
     * 💳 **РФ FinTech & Госуслуги (Минцифры Root)**: `*.sberbank.ru, *.tbank.ru, *.alfabank.ru, *.gosuslugi.ru, *.vtb.ru` (сервисы с отечественным TLS и жестким мобильным пиннингом).
     * 📱 **Google Play & Android FCM**: `play.google.com, play.googleapis.com, fcm.googleapis.com, *.gvt1.com, mtalk.google.com` (фоновые службы Android).
   - **Счетчик попаданий (Hit Counter)** для каждого правила в рантайме: показывает, сколько раз соединение было спасено от сбоя и пущено через passthrough.
   - Кнопка **«Восстановить рекомендованные дефолты» (Reset to Recommended Rules)**.
3. **1-Click UX переключения режимов Targeted MITM**:
   - Интерактивный бейдж сетевого режима на тулбаре и в статус-баре: `[🟢 Intercept All / 🎯 Targeted Only]` с отображением числа целевых хостов.
   - Действия в контекстном меню строк TrafficGrid: `🎯 Add '<host>' to Targeted Allowlist` и `⚡ Add '<host>' to TLS Bypass`.
   - Сессии, прошедшие через прямой туннель, помечаются нейтральным бейджем `TUNNEL` в колонке Protocol.

### Критерии приемки
- Во вкладке «Selective MITM & Bypass» доступно переключение между табличным видом и полнотекстовым редактором (Bulk Text Editor) без потери настроек.
- Работает быстрая вставка списка доменов (Paste List) с автоматическим парсингом строк, масок и выбором категории.
- Поддерживаются групповые действия: чекбоксы выбора строк, включение/отключение пачкой, удаление выделенных, экспорт/импорт в TXT/JSON.
- Базовая конфигурация в `filters.rs` и `filterEngine.ts` дополнена проверенным списком PKI/OCSP, Apple APNs, Windows Update, мессенджеров и платежей.
- Доступны 10 готовых Quick-Packs (Dev, Streaming, Games, FinTech, Android).
- Отображается счетчик срабатываний правил (Hit Counter) в реальном времени.
- Переключатель режимов `Targeted Only / Intercept All` доступен на тулбаре и в статус-баре; правый клик по сессии позволяет добавить хост в Target/Bypass в 1 клик.
- `cargo test`, `npm run build` проходят без ошибок.

---

### 📝 Промпт для Antigravity (Этап 6)

```markdown
Роль: Senior Full-Stack & Network Systems Engineer (Rust + React 18 + TypeScript).
Проект: FluxProxy — отладочный веб-прокси (Tauri v2 + Rust + React 18).

Задача: Модернизировать подсистему Selective MITM & Bypass: реализовать массовый ввод и редактирование правил (Bulk Text & Quick Paste), расширить встроенную базу правил TLS Pinning и Quick-Packs, добавить счетчик попаданий и 1-Click UX переключения режимов перехвата.

1. Бэкенд (Rust - `src-tauri/src/proxy/filters.rs`, `src-tauri/src/proxy/server.rs`, `commands.rs`):
   - Расширить базовый набор `default_tls_bypass_rules()`:
     * Добавить категорию PKI / OCSP / CRL: `ocsp.*, crl.*, *.digicert.com, *.sectigo.com, *.letsencrypt.org, ocsp.apple.com`.
     * Дополнить Apple: `*.cdn-apple.com, *.push.apple.com, gateway.push.apple.com`.
     * Дополнить Microsoft: `*.update.microsoft.com, *.msftconnecttest.com, *.smartscreen.microsoft.com`.
     * Дополнить мессенджеры: `*.discord.gg, *.slack-msgs.com, *.teams.microsoft.com`.
     * Дополнить платежи: `*.cardinalcommerce.com, *.adyen.com`.
   - В структуру `TlsBypassRule` добавить поле `hit_count: Arc<AtomicU64>` (сериализуется как число в summary).
   - В `evaluate_connect_tunnel`: при совпадении с правилом инкрементировать `rule.hit_count`.
   - Добавить команду Tauri: `reset_tls_bypass_rules_to_recommended()` и `get_tls_bypass_hit_counts()`.

2. Расширение наборов правил на фронтенде (`src/lib/filterEngine.ts`):
   - Синхронизировать `DEFAULT_BACKEND_FILTER_CONFIG.tlsBypassRules` с расширенным бэкендом.
   - Расширить `TLS_BYPASS_QUICK_PACKS` до 10 готовых паков:
     * Dev Tools & Package Managers (Git, GitHub, npm, PyPI, Docker, Cargo, Go proxy).
     * DRM & Media Streaming (Spotify, Netflix).
     * Gaming & Anti-Cheat (Steam, Epic Games, Riot, Battle.net).
     * РФ FinTech & Госуслуги (Сбер, Т-Банк, Альфа, Госуслуги).
     * Google & Android Services (Play Store, FCM push, mtalk).
     * Apple Ecosystem & APNs.
     * Microsoft Windows Services & Updates.
     * Secure & E2EE Messengers.
     * Corporate Collaboration (Slack, Teams, Zoom, Webex).
     * Payment Gateways & 3-D Secure.

3. Интерфейс Selective MITM & Bypass (`src/components/FilterDrawer.tsx`):
   - Добавить переключатель режимов представления:
     * `[Таблица / Table View]` | `[Пакетный текст / Bulk Text Editor]`.
   - В режиме «Пакетный текст»:
     * Многострочное поле ввода со стилизацией под `HostFiltersTab` (поддержка переносов строк, комментариев `#`, запятых, масок `*.domain.com`, `regex:`).
     * Кнопка «Применить изменения» с валидацией синтаксиса и отображением количества активных правил.
   - В режиме «Таблица»:
     * Чекбокс «Выбрать все» в шапке таблицы.
     * Тулбар массовых действий: «Включить (N)», «Отключить (N)», «Удалить (N)», «Сменить категорию...».
     * Кнопка «Quick Paste...» (диалог вставки сырого текста со списком хостов из буфера обмена с назначением категории).
     * Кнопки «Экспорт в файл (.txt / .json)» и «Импорт из файла».
     * Колонка или бейдж со счетчиком срабатываний (`Hits: N`).
     * Кнопка «Восстановить рекомендованные дефолты».
   - Сниффер хостов сетевого сеанса: чипы топ-12 хостов из захваченного трафика с кнопками в 1 клик `+ Bypass` / `+ Target`.

4. 1-Click Targeted MITM UX (`src/components/TopToolbar.tsx`, `App.tsx`, `TrafficGrid.tsx`):
   - Интерактивный бейдж сетевого режима на тулбаре и в статус-баре: `[🟢 Intercept All / 🎯 Targeted Only]` с поповером быстрого списка целевых хостов.
   - В контекстное меню строк сессий `TrafficGrid.tsx` добавить:
     * `🎯 Add '<host>' to Targeted Allowlist`.
     * `⚡ Add '<host>' to TLS Bypass`.
     * Показ всплывающего уведомления (тоста).
   - Визуальная индикация: сессии с `tls_bypassed == true` отображать со светлым бейджем `TUNNEL` в колонке Protocol.

Критерии готовности:
- Пользователь может вставить 50 доменов одной вставкой (через Quick Paste или Bulk Text) и мгновенно увидеть их в правилах.
- При включенном системном прокси Spotify, Steam, Git и npm работают стабильно благодаря предустановленным правилам.
- Переключение в режим Targeted Only в 1 клик на тулбаре мгновенно переводит прокси в режим избирательной расшифровки.
- `cargo test` и `npm run build` проходят без ошибок.
```

---

## Этап 7: Кастомные скрипты на Python (Python Scripting Engine)
**Приоритет: P1 (Medium) | Спринт 2 (Автоматизация для Power-юзеров)**

### Описание задачи
Пользователям требуется аналог FiddlerScript / mitmproxy Python addons: возможность писать код на Python для динамической модификации запросов и ответов «на лету» (генерация HMAC-подписей, парсинг специфичных форматов, мокирование по сложным условиям).

### Критерии приемки
- Асинхронный воркер-процесс Python (`tokio::process::Child`), общающийся с Rust через stdin/stdout (JSON-RPC) с таймаутом безопасности 1500 мс.
- Поддержка хуков `on_request(request)` и `on_response(response)` в Python.
- Вкладка **Scripts** в боковой панели со встроенным Monaco Editor (подсветка Python), готовыми шаблонами (Templates) и консолью вывода `print(...)` в реальном времени.
- Переключатель активности скриптинга в тулбаре.

---

### 📝 Промпт для Antigravity (Этап 7)

```markdown
Роль: Senior Systems Engineer (Rust / Tokio / IPC) & Full-Stack Developer.
Проект: FluxProxy — отладочный веб-прокси (Tauri v2 + Rust + React 18 + Monaco Editor).

Задача: Реализовать движок кастомных скриптов на Python (Python Scripting Engine) для перехвата и модификации сетевого трафика «на лету».

1. Rust Python Runner (`src-tauri/src/scripting/`):
   - Создать модуль `src-tauri/src/scripting/python_runner.rs`:
     * Управление долгоживущим дочерним процессом Python (`tokio::process::Command::new("python")`).
     * Протокол взаимодействия через stdin/stdout (JSON Lines / JSON-RPC).
     * Таймаут на ответ от скрипта: 1500 мс. При превышении таймаута запрос пропускается без изменений (fail-safe), а в консоль пишется предупреждение.
   - Поддерживаемые хуки в Python:
     ```python
     def on_request(request):
         # request: {"id": 1, "method": "POST", "url": "...", "headers": [...], "body": "..."}
         if "api/v1/auth" in request["url"]:
             request["headers"].append({"name": "X-Custom-Trace", "value": "Python"})
         return request

     def on_response(response):
         # response: {"id": 1, "status": 200, "headers": [...], "body": "..."}
         if response["status"] == 500:
             print(f"Error intercepted: {response.get('url')}")
         return response
     ```
   - Интегрировать хуки в `handle_intercepted_request` в `server.rs` перед отправкой в upstream и перед возвратом ответа клиенту.
   - Команды Tauri: `set_python_script(code: String, enabled: bool)`, `get_python_runner_status()`.
   - Потоковая передача `stdout`/`stderr` скрипта в UI через эвент `proxy://script-console-log`.

2. Frontend UI (`src/components/ScriptingPanel.tsx`, `Sidebar.tsx`):
   - Добавить раздел **Scripts** в `Sidebar.tsx` (иконка терминала/кода).
   - Создать `ScriptingPanel.tsx`:
     * Monaco Editor с подсветкой синтаксиса `python`.
     * Выпадающий список готовых шаблонов (Templates):
       - Header Injection (HMAC / Auth)
       - Mock Response by URL
       - Log Request Payloads to File
       - Rewrite Query Parameters
     * Кнопка «Save & Apply Script (Ctrl+S)».
     * Тоггл включения скриптинга с индикатором статуса (Active / Stopped / Error).
     * Консоль вывода логов скрипта в нижней части панели.

Критерии готовности:
- Если Python не установлен в системе, в UI отображается предупреждение («Python not found in PATH»).
- При активном скрипте добавление заголовка в `on_request` реально отражается в исходящем запросе и инспекторе сессий.
- Ошибки выполнения (Python Traceback) выводятся в консоль скрипта без падения Rust-бэкенда.
- `cargo test` и `npm run build` проходят успешно.
```

---

## Этап 8: Composer 2.0: Умный «Paste cURL» и генератор клиентского кода на 5 языках
**Приоритет: P1 (Medium) | Спринт 2 (Продуктивность разработчика)**

### Описание задачи
Модернизировать HTTP Composer: реализовать умный парсер команд cURL из буфера обмена («Paste cURL») и добавить модальное окно генерации клиентского кода (Code Snippet Generator).

### Критерии приемки
- Кнопка «Import cURL» в Composer и автодетекция вставки: если пользователь нажимает `Ctrl+V` в Composer и в буфере команда `curl ...`, она автоматически парсится.
- Парсер поддерживает флаги `-X`, `-H`, `-d/--data/--data-raw/--data-binary`, `-b`, `-u`, URL и переносы строк `\`.
- Добавлено модальное окно «Generate Client Code» с подсветкой в Monaco Editor для JavaScript (fetch/axios), Python (requests/httpx), Go (net/http), Rust (reqwest) и cURL.
- Добавлена кнопка «Copy Code to Clipboard».

---

### 📝 Промпт для Antigravity (Этап 8)

```markdown
Роль: Senior Full-Stack Developer.
Проект: FluxProxy — кроссплатформенный отладочный веб-прокси (Tauri v2 + React 18 + TypeScript + Monaco Editor).

Задача: Модернизировать Request Composer: реализовать умный парсер команд cURL из буфера обмена («Paste cURL») и добавить модальное окно генерации клиентского кода (Code Snippet Generator).

1. Умный импорт cURL в Composer:
   - В `src/components/ComposerPanel.tsx` добавь кнопку «Import cURL» с диалогом ввода, а также автодетекцию: при нажатии `Ctrl+V` в фокусе Composer, если буфер обмена начинается с `curl `, автоматически парсить команду.
   - Парсер (`src/lib/curlParser.ts`) должен надежно разбирать флаги:
     * Метод: `-X POST`, `--request PUT` (по умолчанию GET, либо POST при наличии тела).
     * Заголовки: `-H "Name: Value"`, `--header '...'`.
     * Тело: `-d`, `--data`, `--data-raw`, `--data-binary`, `--data-urlencode`.
     * Куки: `-b`, `--cookie`.
     * Аутентификация: `-u user:pass` (преобразование в `Authorization: Basic`).
     * URL и query-параметры с обработкой экранирования.
   - Результат сразу подставляется в поля Composer (Method, URL, Headers таблица, Body в Monaco Editor).

2. Генератор клиентского кода («Code Export»):
   - Кнопка «Code» в ComposerPanel и контекстном меню сессий в TrafficGrid.
   - Модальное окно `src/components/CodeSnippetModal.tsx` с табами языков и подсветкой в Monaco Editor:
     * JavaScript: `fetch()` и `axios`.
     * Python: `requests` и `httpx` (async).
     * Go: `net/http`.
     * Rust: `reqwest` (async).
     * cURL: эквивалентная команда cURL.
   - Кнопка «Copy to Clipboard» с визуальным подтверждением.

Файлы для создания/модификации:
- Создать: `src/lib/curlParser.ts`
- Создать: `src/lib/codeGenerators.ts`
- Создать: `src/components/CodeSnippetModal.tsx`
- Обновить: `src/components/ComposerPanel.tsx`
- Обновить: `src/components/TrafficGrid.tsx`

Критерии готовности:
- `npm run build` завершается без ошибок.
- Сложный cURL с json-телом и несколькими заголовками корректно наполняет форму Composer.
- Сгенерированный код на Python/JS/Rust валиден и готов к копированию.
```

---

## Этап 9: Тестирование фронтенда (Vitest) и CI/CD (GitHub Actions)
**Приоритет: P1 (Medium) | Спринт 3 (Качество и надежность)**

### Описание задачи
Подключить Vitest, написать исчерпывающие unit-тесты для парсеров `src/lib/` (Protobuf wire-format, SSE stream с LLM-токенами, Multipart, RFC 9111 Cache, матричные фильтры) и создать GitHub Actions workflow для автоматической валидации коммитов под Windows, macOS и Linux.

### Критерии приемки
- `npm run test` запускает Vitest и выполняет тесты без ошибок.
- Написаны тесты для `protocolInspectors.ts`, `filterEngine.ts`, `textWizard.ts`, `curlParser.ts`.
- Создан файл `.github/workflows/ci.yml`, запускающий линтинг, typecheck, тесты Vitest, `cargo test` и сборку.

---

### 📝 Промпт для Antigravity (Этап 9)

```markdown
Роль: Senior QA & DevOps / Frontend Automation Engineer.
Проект: FluxProxy — кроссплатформенный веб-прокси (Tauri v2 + React 18 + Vitest).

Задача: Настроить `vitest` для клиентского кода, написать базовый набор unit-тестов сложных парсеров и настроить кроссплатформенный GitHub Actions CI/CD пайплайн.

1. Установка и настройка Vitest:
   - Установи необходимые dev-зависимости: `vitest`, `@testing-library/react`, `jsdom`.
   - Настрой `vite.config.ts` для поддержки запуска тестов в среде `jsdom`.
   - Добавь скрипты `"test": "vitest run"` и `"test:watch": "vitest"` в `package.json`.

2. Написание Unit-тестов для `src/lib/`:
   - `src/lib/protocolInspectors.test.ts`:
     * Тест парсинга SSE-потока (включая стриминг LLM OpenAI c маркером `[DONE]` и вычисление deltaMs).
     * Тест Wire-декодера Protobuf (парсинг varint, length-delimited и 64-bit полей без схемы).
     * Тест multipart/form-data парсера с границами (boundary).
     * Тест RFC 9111 HTTP Caching Inspector (проверка статусов кэша fresh / stale / uncacheable).
   - `src/lib/filterEngine.test.ts`:
     * Тест компиляции и применения условий матрицы фильтров (Status Code, Host, Method, Latency).
     * Тест списков Allowlist/Denylist и wildcard/regex совпадений.
   - `src/lib/textWizard.test.ts`:
     * Тест кодирования/декодирования Base64, Hex, URL, JWT Inspector.

3. Создание GitHub Actions CI:
   - Создай `.github/workflows/ci.yml` с матричным запуском на `windows-latest`, `macos-latest` и `ubuntu-latest`:
     * Кэширование Rust / Node зависимостей.
     * `npm ci` и `npm run build`.
     * `npm run test` (Vitest).
     * `cargo test` в `src-tauri`.

Критерии готовности:
- Команда `npm run test` локально выполняет все созданные тесты и завершается со статусом 0.
- Все тесты `cargo test` зеленые.
- Файл `.github/workflows/ci.yml` синтаксически валиден.
```

---

## Этап 10: Сетевая инфраструктура: HOSTS Remapping (Virtual DNS) и Bandwidth Throttling
**Приоритет: P2 (Feature) | Спринт 3 (Сетевой функционал)**

### Описание задачи
Реализовать две ключевые сетевые функции Fiddler Classic и Charles Proxy:
1. **HOSTS Remapping (Virtual DNS):** Аналог `Tools -> HOSTS...` в Fiddler Classic. Позволяет прозрачно перенаправлять запросы с доменов (например, `api.production.com`) на локальный или тестовый сервер (`127.0.0.1:3000`), сохраняя оригинальный HTTP-заголовок `Host` и SNI, без правок файла hosts ОС и без прав администратора.
2. **Bandwidth Throttling:** Физическое ограничение пропускной способности (Slow 3G, 4G, Offline, Custom KB/s) на уровне сокетов Tokio.

### Критерии приемки
- В Rust реализована структура сопоставления хостов `HostRemapRule` с поддержкой wildcard (`*.api.dev`).
- Запросы прозрачно подключаются к переназначенному IP/хосту с сохранением оригинальных заголовков.
- В UI добавлено модальное окно `HostRemapModal.tsx` и пункт меню `Tools -> HOSTS Remapping...`.
- В Rust реализован механизм ограничения пропускной способности (RateLimiter / Token Bucket).
- В `TopToolbar.tsx` добавлен переключатель сетевого троттлинга с выбором профиля (`GPRS`, `Slow 3G`, `Fast 3G`, `LTE`, `Offline`).

---

### 📝 Промпт для Antigravity (Этап 10)

```markdown
Роль: Senior Rust Systems Engineer & Frontend Developer.
Проект: FluxProxy — кроссплатформенный отладочный веб-прокси (Tauri v2 + Tokio + Hyper + React 18).

Задача: Реализовать HOSTS Remapping (виртуальный DNS-редирект) и глобальный механизм Bandwidth Throttling (ограничение скорости сети).

1. HOSTS Remapping (Virtual DNS):
   - В `src-tauri/src/proxy/hosts.rs` реализуй потокобезопасный реестр `HostRemapRegistry`:
     * Структура правила: `id`, `enabled: bool`, `source_pattern: String` (поддержка точного совпадения и wildcards), `target_host: String`, `target_port: Option<u16>`, `comment: String`.
   - Встрой в `ProxyEngineController`: при отправке апстрим-запроса через reqwest или установке CONNECT-туннеля сопоставлять хост с правилами ремаппинга. При совпадении сокет подключается к `target_host:target_port`, но оригинальный заголовок `Host` и SNI сохраняются.
   - Создай команды Tauri: `get_host_remap_rules`, `update_host_remap_rules`.
   - Создай `src/components/HostRemapModal.tsx` с таблицей правил и добавь пункт в меню `Tools -> HOSTS Remapping...`.

2. Bandwidth Throttling (Эмуляция скорости сети):
   - Пресеты: `GPRS` (50 Kbps, 500ms latency), `Slow 3G` (400 Kbps, 400ms latency), `Fast 3G` (1.6 Mbps, 150ms latency), `4G / LTE` (30 Mbps, 40ms latency), `Offline`, `Custom`.
   - В `src-tauri/src/proxy/throttle.rs` реализуй обертку над асинхронными потоками Tokio (RateLimiter / Token Bucket), физически ограничивающую скорость передачи байт в секунду и добавляющую искусственный пинг.
   - В `TopToolbar.tsx` добавь селектор профилей скорости сети (иконка спидометра/шкалы сигнала) и индикатор в строку состояния.

Критерии готовности:
- При правиле `test.example.com -> 127.0.0.1:8080` запрос уходит на локальный порт с сохранением заголовков.
- При включении профиля "Slow 3G" время скачивания больших ресурсов физически замедляется до заданного лимита.
- `cargo test` и `npm run build` проходят успешно.
```

---

## Этап 11: Архитектурная декомпозиция монолитов и внедрение стейт-менеджера (Zustand)
**Приоритет: P2 (Feature) | Спринт 3 (Архитектура)**

### Описание задачи
В проекте накопились файлы чрезмерного размера (`server.rs`, `FilterDrawer.tsx`, `App.tsx`, `useProxySessions.ts`), что повышает когнитивную нагрузку и приводит к сквозной передаче пропсов (prop-drilling). Необходимо декомпозировать бэкенд на подмодули, а фронтенд перевести на легковесный стейт-менеджер (Zustand) с настройкой Code Splitting (lazy loading для тяжелых модалок и Monaco Editor).

### Критерии приемки
- `server.rs` разделен на суб-модули внутри `proxy/server/` (`http_handler.rs`, `connect_tunnel.rs`, `websocket_relay.rs`, `sse_stream.rs`, `composer_exec.rs`, `mod.rs`).
- `FilterDrawer.tsx` разбит на изолированные вкладки в `src/components/filters/`.
- Внедрен Zustand (`src/store/useProxyStore.ts`, `src/store/useFilterStore.ts`).
- Тяжелые диалоги открываются через `React.lazy()` + `Suspense`, уменьшая размер начального бандла.
- Поведение всех функций полностью идентично исходному; все тесты проходят.

---

### 📝 Промпт для Antigravity (Этап 11)

```markdown
Роль: Principal Systems Architect & React Performance Specialist.
Проект: FluxProxy — кроссплатформенный веб-прокси (Tauri v2 + Rust + React 18 + Zustand).

Задача: Провести безопасный модульный рефакторинг монолитных файлов без изменения функционального поведения.

1. Декомпозиция Rust-модуля `proxy/server.rs`:
   - Создай подпапку `src-tauri/src/proxy/server/` и разбей логику на файлы:
     * `http_handler.rs` — обработка обычных HTTP/1.1 и HTTP/2 запросов/ответов.
     * `connect_tunnel.rs` — обработка CONNECT туннелей, selective TLS bypass и passthrough.
     * `websocket_relay.rs` — ретрансляция фреймов WebSocket и handshake.
     * `sse_stream.rs` — обработка `text/event-stream` и чанкованной доставки.
     * `composer_exec.rs` — выполнение запросов из Composer.
     * `mod.rs` — `ProxyEngineController` и фасадный запуск.
   - Убедись, что все существующие unit-тесты перенесены и успешно выполняются.

2. Декомпозиция фронтенда и внедрение Zustand:
   - Установи `zustand`.
   - Создай хранилища:
     * `src/store/useProxyStore.ts` (статус прокси, сессии, выборка строк, брейкпоинты).
     * `src/store/useFilterStore.ts` (матричные фильтры, поиск, host list, пресеты).
   - Устрани prop-drilling через `App.tsx` в `TopToolbar`, `MenuBar` и `TrafficGrid`.
   - Разбей `FilterDrawer.tsx` на компоненты в директории `src/components/filters/`:
     * `FilterMatrixTab.tsx`, `NoiseThresholdsTab.tsx`, `HostFilterPresetsTab.tsx`, `BackendTlsSettingsTab.tsx`.
   - Настрой Code Splitting в `src/App.tsx`: тяжелые диалоги (`BreakpointModal`, `SessionDiffView`, `TextWizardModal`, `MobileSetupModal`, `CodeSnippetModal`) загружай через `React.lazy()` и `Suspense`.

Критерии готовности:
- Ни один исходный файл после рефакторинга не превышает 700 строк.
- Начальный бандл `dist/assets/index-*.js` уменьшился за счет code splitting.
- `cargo test` и `npm run build` завершаются без ошибок.
```

---

## Этап 12: Аналитика и визуализация: Waterfall Timeline и панель статистики трафика
**Приоритет: P2 (Feature) | Спринт 4 (Аналитика и профилирование)**

### Описание задачи
Реализовать две ключевые аналитические функции:
1. **Каскадная диаграмма (Waterfall Timeline):** Визуализация параллельных запросов на горизонтальной шкале времени, отражающая задержки, блокировки и каскадные цепочки.
2. **Панель статистики (Multi-Session Statistics):** Агрегированный отчет по выделенным сессиям (общий трафик, распределение MIME/статусов, топ самых медленных и тяжелых хостов).

### Критерии приемки
- Вкладка / окно «Timeline» с горизонтальной шкалой Waterfall относительно времени первой сессии.
- Масштабирование (Zoom In/Out) и синхронизация курсора со строкой в TrafficGrid.
- Модальное окно `TrafficStatisticsModal.tsx` с расчетом метрик (суммарный объем, P95 latency, распределение Content-Type, топ-5 медленных/тяжелых эндпоинтов).
- Кнопка «Copy Summary to Clipboard» для отчетов об ошибках.

---

### 📝 Промпт для Antigravity (Этап 12)

```markdown
Роль: Senior Frontend & Data Visualization Engineer.
Проект: FluxProxy — кроссплатформенный отладочный веб-прокси (React 18 + TypeScript + Tailwind CSS).

Задача: Реализовать каскадную диаграмму таймингов (Waterfall Timeline) и модальное окно агрегированной статистики по сессиям (Statistics Panel).

1. Каскадная диаграмма таймингов (Waterfall Timeline View):
   - Добавить режим отображения / вкладку «Timeline» рядом с инспектором сессий.
   - Отображение горизонтальной временной шкалы (Waterfall chart) относительно времени старта первой сессии.
   - Каждая полоса отображает:
     * Ожидание / смещение от старта.
     * Время выполнения запроса (duration_ms).
     * Цветовое кодирование по типу контента или статусу (2xx зеленый, 4xx/5xx красный).
   - Масштабирование (Zoom In/Out) и синхронизация клика по полосе с выделением строки в TrafficGrid.

2. Панель расширенной статистики (Traffic Statistics Panel):
   - Вызывается по кнопке в тулбаре, горячей клавише или при выделении нескольких сессий в гриде (`src/components/TrafficStatisticsModal.tsx`).
   - Метрики:
     * Общее число запросов, успешных, ошибок (4xx, 5xx).
     * Суммарный объем полученных и переданных данных (KB / MB).
     * Среднее время ответа (Average Latency), медиана и 95-й перцентиль (P95).
     * Круговое распределение (Donut / Bar) по Content-Type (JSON, HTML, Images, CSS, Fonts, WebSocket).
     * Топ-5 самых медленных эндпоинтов и топ-5 самых тяжелых пейлоадов.
   - Кнопка «Copy Summary to Clipboard» для вставки в баг-репорты.

Файлы для создания/модификации:
- Создать: `src/components/WaterfallTimeline.tsx`
- Создать: `src/components/TrafficStatisticsModal.tsx`
- Обновить: `src/components/TrafficGrid.tsx`
- Обновить: `src/App.tsx` и `src/components/TopToolbar.tsx`.

Критерии готовности:
- `npm run build` проходит успешно.
- При выделении 100+ сессий статистика рассчитывается мгновенно (< 16 мс) без задержек интерфейса.
```

---

## Этап 13: Расширенные протоколы: Upstream Proxy Chaining и WS-инъекция
**Приоритет: P2 (Feature) | Спринт 4 (Продвинутая кастомизация)**

### Описание задачи
1. **Upstream Proxy Chaining:** Маршрутизация трафика через корпоративный вышестоящий прокси (HTTP/HTTPS/SOCKS5 с авторизацией).
2. **Инъекция в активные WebSocket:** Ручная отправка текстовых и бинарных фреймов в открытые сокеты прямо из инспектора.

### Критерии приемки
- Реализовано модальное окно `UpstreamProxyModal.tsx` с поддержкой HTTP/SOCKS5 прокси и списком исключений.
- Во вкладке WebSocket доступна панель отправки кастомных сообщений клиенту или серверу.

---

### 📝 Промпт для Antigravity (Этап 13)

```markdown
Роль: Principal Systems Architect & Protocol Specialist.
Проект: FluxProxy — кроссплатформенный отладочный веб-прокси (Tauri v2 + Rust + React 18).

Задача: Реализовать поддержку вышестоящих корпоративных прокси (Upstream Proxy Chaining) и ручную инъекцию фреймов WebSocket.

1. Каскадирование прокси (Upstream Proxy Chaining):
   - Поддержка корпоративных цепочек прокси: HTTP, HTTPS, SOCKS5 с авторизацией (Username / Password).
   - Список исключений («Bypass for localhost, *.internal»).
   - Диалоговое окно `src/components/UpstreamProxyModal.tsx` и передача настроек в `reqwest::ClientBuilder` и CONNECT-туннели.

2. Инъекция WebSocket фреймов:
   - В `server.rs` (или `websocket_relay.rs`) предусмотреть канал отправки сообщений со стороны прокси.
   - Во вкладку WebSocket инспектора добавить панель «Send Message»: ввод текста / JSON / Hex и кнопки «Send to Server» / «Send to Client».

Критерии готовности:
- При включении SOCKS5/HTTP Upstream Proxy запросы ретранслируются через него.
- Сообщение, отправленное из инспектора WebSocket, доставляется клиенту или серверу.
- `cargo test` и `npm run build` проходят без ошибок.
```
