# 🗺️ Дорожная карта (Roadmap) развития FluxProxy

> **FluxProxy** — современный кроссплатформенный локальный отладочный HTTP/HTTPS/WebSocket прокси на базе **Tauri v2 (Rust)** и **React 18 (TypeScript)**.
>
> Данный документ отражает актуальный статус реализованных подсистем, обновленную матрицу приоритетов задач (включая безопасность, диагностику и протокольные расширения), технические спецификации и **готовые самодостаточные промпты для агента Antigravity** для последовательной разработки следующих этапов.

---

## ✅ Реализованные ключевые возможности (Verified Milestones)

Следующие этапы и подсистемы **полностью реализованы, протестированы в кодовой базе и не требуют повторной разработки**:

1. **Поддержка мобильных устройств (iOS & Android)**:
   - Биндинг на все интерфейсы (`0.0.0.0` / `set_allow_remote`) и автоопределение LAN IP (`get_network_interfaces`).
   - Встроенный веб-портал `http://flux.proxy` с отдачей сертификатов: `.crt`, `.der`, `.pem`, Apple Configuration Profile `.mobileconfig`.
   - Модальное окно `MobileSetupModal.tsx` (`Ctrl+Shift+M`) с QR-кодами, пошаговыми инструкциями и Android `network_security_config.xml`.
   - Покрыто интеграционными тестами в `server.rs`.
2. **Массовый фильтр хостов и URL (Bulk Hosts List) и матрица фильтров**:
   - Вкладка `HostFiltersTab.tsx` с многострочным вводом доменов, масок `*.example.com` и регулярных выражений `regex:`, режимами Whitelist / Blacklist и синхронизацией с TLS Passthrough.
   - Матрица фильтров (`FilterDrawer.tsx`), пороги фонового шума, мутации заголовков (*Force No-Cache*, *CORS*, *User-Agent*) и протокольные анализаторы (`InspectorProtocolPanels.tsx`: SSE/LLM, gRPC/Protobuf, Auth, RFC 9111 Cache, Multipart).
3. **Совместимость с WebSocket и SignalR**:
   - В `server.rs` (`build_upstream_websocket_request`) реализован полный форвардинг заголовков клиента (`Authorization`, `Cookie`, `Sec-WebSocket-Protocol`, `X-SignalR-*`), покрытый unit-тестами.
4. **Базовая эргономика интерфейса**:
   - Виртуализированная таблица `TrafficGrid.tsx` (60 FPS, интерактивный ресайз колонок мышью и двойной клик для auto-fit, поповер видимости колонок по правому клику на шапку).
   - Полнофункциональное меню `MenuBar.tsx` (`File`, `Edit`, `Rules`, `View`, `Tools`, `Help`), режим `compactToolbar` и справочник горячих клавиш `ShortcutsModal.tsx` (`?`).
5. **✅ [Этап 1 — Выполнено] Сетевая надежность, блокировка обхода HTTP/3 (`Alt-Svc`) и безопасность CA / CSP**:
   - Автоматическое удаление заголовков `Alt-Svc` и `Alternate-Protocol` из HTTP/1.1 и HTTP/2 ответов (управляется флагом `strip_alt_svc` в `ProxyFilterBackendConfig`, включено по умолчанию).
   - Проверка статуса доверия ОС (`isTrusted`), установка (`install_root_ca`) и штатное удаление корневого сертификата (`uninstall_root_ca`) в `ca.rs` и `CertificateModal.tsx`, защита приватного ключа правами `0600` и миграция legacy-ключей.
   - Строгая политика Content Security Policy (CSP) в `src-tauri/tauri.conf.json`.
6. **✅ [Этап 2 — Выполнено] Кольцевой буфер памяти (Ring Buffer), фильтрация при захвате и оффлоадинг тяжелых тел**:
   - Селектор лимита сессий в стиле Fiddler (`Keep: All Sessions / 100..10 000 / Custom...` с ручным вводом произвольного числа) на тулбаре, в меню `Tools → Session Retention Limit...` и в `SettingsModal.tsx`.
   - FIFO-вытеснение старейших сессий из RAM (`TrafficStore`) с архивацией в SQLite (`sqlite.rs`) и ленивой подгрузкой тел крупнее 2 МБ по клику в `SessionInspector.tsx` (`load_session_body`).
   - Стриминговое отбрасывание нецелевого трафика на этапе захвата (`Drop Non-Matching` / `set_drop_non_matching`) и живая телеметрия `RAM | SQLite | Dropped` в строке состояния.
7. **✅ [Этап 3 — Выполнено] Полная поддержка спецификации HAR 1.2, архивов Fiddler SAZ (`.saz`) и выгрузки сырых тел**:
   - Модуль `src-tauri/src/storage/export_import.rs` с сериализацией/десериализацией **HAR 1.2**, упаковкой и чтением ZIP-архивов **Fiddler Classic (`.saz`)**, экспортом **JSON** и **Raw HTTP (`.txt`)**, а также выгрузкой отдельных тел запросов и ответов (`Save Request/Response Body As...`).
   - Нативные файловые диалоги ОС (`rfd`), горячие клавиши `Ctrl+S` / `Ctrl+O` и поддержка **Drag-and-Drop** файлов `.har`, `.saz`, `.json` прямо в окно приложения.
8. **✅ [Этап 4 — Выполнено] Версионированные профили пользовательских настроек и централизованный Preferences**:
   - Типизированная схема `FluxUserSettingsProfile` (`schemaVersion: 1`, `src/types/settings.ts`) и менеджер валидации/миграций `src/lib/settingsManager.ts`.
   - Единое модальное окно `SettingsModal.tsx` (`Preferences...` / `Ctrl+,`) с 5 вкладками (*General*, *UI & Columns*, *Filters*, *Rules & Proxy*, *Backup & Export*), сменой порта прокси и глобальным управлением AutoResponder.
   - Экспорт и импорт JSON-профиля настроек с модальным превью перезаписываемых параметров и безопасным сбросом к дефолтам.

---

## 📋 Актуальная очередь разработки (Матрица приоритетов)

> *Этапы 1–4 полностью завершены. Очередь переупорядочена с учетом критичности сетевых сбоев, безопасности корпоративных сред, эргономики и инструментов автоматизации.*

| Этап | Приоритет | Название этапа | Ключевая ценность |
| :--- | :--- | :--- | :--- |
| **[Этап 14](#этап-14-поддержка-сжатия-zstandard-rfc-8878-zstd-и-прозрачное-декодирование-контента)** | **P0 (Critical)** | Поддержка Zstandard (RFC 8878 zstd) и прозрачное декодирование тел | Устранение битого текста на сайтах Cloudflare/CDN, распаковка zstd на лету, поддержка zstd в инспекторе и TextWizard |
| **[Этап 15](#этап-15-привязка-к-конкретному-ip--сетевому-интерфейсу-и-мульти-бинд)** | **P0 (Critical)** | Привязка к конкретному IP / интерфейсу LAN и мульти-бинд | Безопасность: запрет открытия порта во всех сетях машины (`0.0.0.0`), выбор адаптера Wi-Fi/Ethernet/WSL/VPN для мобилок |
| **[Этап 5](#этап-5-оптимизация-вертикального-пространства-ui-автоподбор-колонок-и-шорткаты-инспектора)** | **P0 (High)** | Ультра-компактный тулбар (`Ctrl+Shift+T`), автоподбор колонок и шорткаты | Однострочный Slim-режим тулбара, групповой Auto-fit колонок из меню шапки и мгновенное переключение вкладок (`Ctrl+1..6`) |
| **[Этап 16](#этап-16-очистка-и-маскирование-pii--секретов-при-экспорте-сессий)** | **P0 (High)** | Очистка и маскирование PII / секретов при экспорте (Sanitized Export) | Защита от утечки боевых токенов (Bearer, Cookie), паролей и платежных данных при пересылке `.har` / `.saz` третьим лицам |
| **[Этап 17](#этап-17-диагностический-мастер-самопроверки-proxy-doctor)** | **P0 (High)** | Диагностический мастер самопроверки «Proxy Doctor» | 1-клик выявление и автоисправление проблем: занятый порт, файрвол, перехват VPN, системный прокси и доверие CA |
| **[Этап 6](#этап-6-selective-mitm--bypass-20-массовые-фильтры-bulk-editor-расширенная-база-правил-tls-pinning-и-1-click-ux)** | **P1 (High)** | Selective MITM 2.0: Массовый ввод хостов, база TLS Pinning и Quick-Packs | Пакетный редактор TLS-правил, 10 готовых наборов (PKI/Dev/DRM/Игры/FinTech/Госуслуги), защита от сбоев сторонних программ |
| **[Этап 18](#этап-18-клиентские-сертификаты-mtls--client-certificates-store)** | **P1 (High)** | Клиентские сертификаты (mTLS / Client Certificates Store) | Перехват и аутентификация в закрытых корпоративных API, банковских бэкендах и микросервисах с двусторонним TLS |
| **[Этап 7](#этап-7-кастомные-скрипты-на-python-python-scripting-engine)** | **P1 (Medium)** | Кастомные скрипты на Python (Python Scripting Engine) | Автоматизация перехвата «на лету» (хуки `on_request`/`on_response`), Monaco Editor и живая консоль логов |
| **[Этап 8](#этап-8-composer-20-умный-paste-curl-и-генератор-клиентского-кода-на-5-языках)** | **P1 (Medium)** | Composer 2.0: Умный «Paste cURL» и генератор кода на 5 языках | Ускорение тестирования API из буфера обмена и генерация готовых сниппетов (JS, Python, Go, Rust, cURL) |
| **[Этап 19](#этап-19-автоматическая-генерация-спецификаций-openapi-30--swagger)** | **P1 (Medium)** | Автоматическая генерация спецификаций OpenAPI 3.0 / Swagger | Превращение группы перехваченных сессий в готовую документацию API со схемами запросов и ответов в 1 клик |
| **[Этап 9](#этап-9-тестирование-фронтенда-vitest-и-cicd-github-actions)** | **P1 (Medium)** | Тестирование фронтенда (Vitest) и CI/CD (GitHub Actions) | Автоматическая верификация парсеров протоколов, матричных фильтров, миграций настроек и кроссплатформенной сборки |
| **[Этап 10](#этап-10-сетевая-инфраструктура-hosts-remapping-virtual-dns-и-bandwidth-throttling)** | **P2 (Feature)** | HOSTS Remapping (Virtual DNS) и Bandwidth Throttling | Локальный редирект доменов без правок системного файла `hosts` и физическая эмуляция медленной сети (3G/LTE) |
| **[Этап 11](#этап-11-архитектурная-декомпозиция-монолитов-и-внедрение-стейт-менеджера-zustand)** | **P2 (Feature)** | Архитектурная декомпозиция монолитов и Zustand | Разделение крупных модулей (`server.rs`, `export_import.rs`, `App.tsx`, `FilterDrawer.tsx`, `SettingsModal.tsx`) и Code Splitting |
| **[Этап 12](#этап-12-аналитика-и-визуализация-waterfall-timeline-и-панель-статистики-трафика)** | **P2 (Feature)** | Waterfall Timeline и панель агрегированной статистики | Наглядная каскадная диаграмма таймингов и многомерная статистика по выборке сессий |
| **[Этап 13](#этап-13-расширенные-протоколы-upstream-proxy-chaining-и-ws-инъекция)** | **P2 (Feature)** | Upstream Proxy Chaining и инъекция фреймов WebSocket | Работа за корпоративным вышестоящим прокси (HTTP/SOCKS5) и ручная отправка сообщений в открытые WS-соединения |

---

## ⚙️ Общие правила и рекомендации по выполнению

1. **Последовательное выполнение по приоритетам:** Двигайтесь сверху вниз по таблице приоритетов (`P0 Critical` → `P0 High` → `P1` → `P2`).
2. **Контроль сборки и тестов после каждого этапа:**
   - Проверка типов TypeScript: `npm run typecheck`
   - Сборка фронтенда: `npm run build`
   - Тесты Rust-ядра: `cargo test --manifest-path src-tauri/Cargo.toml`
3. **Фиксация в Git:** После каждого завершенного этапа создавайте атомарный коммит:
   ```bash
   git add .
   git commit -m "feat(phase-N): <краткое описание выполненного этапа>"
   ```
4. **Сохранение Dual-Mode разработки:** Всегда сохраняйте работоспособность Browser Preview Simulator (`src/lib/mockTraffic.ts`, `src/lib/tauriBridge.ts`), чтобы интерфейс можно было полноценно запускать в браузере (`npm run dev`) без обязательной компиляции Rust-ядра.

---

## Этап 14: Поддержка сжатия Zstandard (RFC 8878 zstd) и прозрачное декодирование контента
**Приоритет: P0 (Critical) | Ближайший этап (Сетевая надежность и протоколы)**

### Описание задачи
1. **Проблема повреждения страниц в браузере (Corrupted Body Bug):**
   - Современные браузеры (Chrome 123+, Firefox 126+, Edge) по умолчанию передают заголовок `Accept-Encoding: gzip, deflate, br, zstd`.
   - Крупные CDN и веб-серверы (Cloudflare, Fastly, Meta, Google) отвечают телом, сжатым с помощью Zstandard (`content-encoding: zstd`).
   - Используемый во FluxProxy клиент `reqwest 0.12` автоматически распаковывает только `gzip`, `brotli` и `deflate`, но **не декодирует `zstd`**.
   - Прокси-сервер (`src-tauri/src/proxy/server.rs`) удаляет заголовок `content-encoding` из ответа клиенту перед отправкой Hyper-фрейма.
   - В результате браузер получает сырой сжатый бинарный архив Zstandard с заголовком `content-type: text/html; charset=UTF-8` без заголовка `content-encoding`, интерпретирует бинарные байты как обычный текст и отображает битую страницу (начинающуюся с сигнатуры Zstandard `0x28 0xB5 0x2F 0xFD` -> `(/...`).
2. **Невозможность инспекции трафика:**
   - В инспекторе сессий FluxProxy поле `response_body_text` не формируется (или содержит нечитаемые символы), что ломает поиск по телу, форматирование JSON/HTML и подсветку синтаксиса.
3. **Отсутствие Zstd в TextWizard:**
   - В утилите кодирования/декодирования TextWizard (`codec.rs`, `TextWizardModal.tsx`) поддержаны Gzip, Brotli и Deflate, но нет операций сжатия/распаковки Zstd.

### Критерии приемки
- В `src-tauri/Cargo.toml` добавлен крейт `zstd` (версии `0.13` или совместимой).
- В `src-tauri/src/proxy/server.rs` реализована прозрачная распаковка тел ответов с `content-encoding: zstd`:
  - Если `content-encoding` содержит `zstd`, тело ответа автоматически декодируется в несжатые байты до сохранения в `TrafficStore` и до отправки в браузер.
  - Заголовок `content-encoding` корректно очищается (или синхронизируется с фактическим состоянием тела), исключая рассинхронизацию между телом и заголовками.
- Реализована защита исходящего запроса (Fallback/Normalization): если распаковка `zstd` невозможна или отключена, прокси может нормализовать `Accept-Encoding`, чтобы сервер отвечал в `br` или `gzip`.
- В `src-tauri/src/models.rs`, `src-tauri/src/proxy/codec.rs`, `src/types/proxy.ts`, `src/lib/textWizard.ts` и `src/components/TextWizardModal.tsx` добавлены операции `ZstdCompress` и `ZstdDecompress` (с поддержкой Base64/Hex).
- Покрыто unit-тестами в Rust (`roundtrips_zstd` в `codec.rs`, интеграционный тест на прозрачное декодирование ответа `zstd` в `server.rs`).
- `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck` и `npm run build` проходят без ошибок.

---

### 📝 Промпт для Antigravity (Этап 14)

```markdown
Роль: Senior Systems Engineer (Rust / Tokio / Hyper / Codecs) & Fullstack Developer.
Проект: FluxProxy — кроссплатформенный отладочный веб-прокси (Tauri v2 + Rust + React 18).

Задача: Реализовать полную поддержку алгоритма сжатия Zstandard (RFC 8878 zstd), устранить проблему отображения битого текста на веб-страницах при работе через прокси и добавить операции Zstd в TextWizard.

1. Подключение зависимостей:
   - В `src-tauri/Cargo.toml` добавить зависимость `zstd = "0.13"` (или совместимую свежую версию).

2. Прозрачная распаковка Zstandard в proxy-сервере:
   - В `src-tauri/src/proxy/server.rs`:
     * Обнаружение сжатия: проверять заголовок `content-encoding` на наличие `zstd` (без учета регистра, включая цепочки кодировок).
     * Декодирование буферизированного ответа: если ответ сжат zstd, распаковать `resp_bytes` с помощью `zstd::decode_all(resp_bytes.as_ref())`.
     * При успешной распаковке заменять `resp_bytes` на распакованные байты и обновлять `content-length`, чтобы и в `TrafficStore` (для отображения в UI и экспорта HAR/SAZ), и в исходящем Hyper-ответе клиенту передавался полноценный читаемый HTML/JSON/текст.
     * Если декодирование завершилось ошибкой (например, битый поток от сервера), не удалять исходный `content-encoding`, чтобы не повреждать ответ клиенту.

3. Поддержка Zstd в TextWizard & Codec Engine:
   - В `src-tauri/src/models.rs`:
     * Добавить в enum `CodecOperation` варианты `ZstdCompress`, `ZstdDecompress`.
   - В `src-tauri/src/proxy/codec.rs`:
     * Реализовать сжатие (`zstd::encode_all`) и распаковку (`zstd::decode_all`).
     * Добавить unit-тест `roundtrips_zstd` по аналогии с существующими тестами gzip/brotli/deflate.
   - В интерфейсе `src/components/TextWizardModal.tsx`, `src/lib/textWizard.ts`, `src/components/MenuBar.tsx` и типах `src/types/proxy.ts`:
     * Добавить `zstdCompress` и `zstdDecompress` в список поддерживаемых операций сжатия TextWizard (включая fallback для Browser Preview Simulator).

Файлы для модификации:
- `src-tauri/Cargo.toml`
- `src-tauri/src/models.rs`
- `src-tauri/src/proxy/codec.rs`
- `src-tauri/src/proxy/server.rs`
- `src/types/proxy.ts`
- `src/lib/textWizard.ts`
- `src/components/TextWizardModal.tsx`

Критерии готовности:
- Сайты за Cloudflare/CDN с `content-encoding: zstd` корректно отображаются в браузере (HTML рендерится без мусорных символов `(/...`).
- В инспекторе сессий FluxProxy в теле ответа отображается чистый HTML/JSON с форматированием.
- В TextWizard операции Zstd Compress и Zstd Decompress успешно сжимают и восстанавливают текст.
- `cargo test --manifest-path src-tauri/Cargo.toml` и `npm run build` проходят без ошибок.
```

---

## Этап 15: Привязка к конкретному IP / сетевому интерфейсу и мульти-бинд
**Приоритет: P0 (Critical) | Спринт 1 (Сетевая безопасность и сетевой стек)**

### Описание задачи
1. **Проблема безопасности и multi-homed ПК:**
   - Текущий переключатель `allow_remote` жестко выбирает между `127.0.0.1` (только локальный ПК) и `0.0.0.0` (все адаптеры).
   - Привязка к `0.0.0.0` открывает порт 8888 на всех сетевых картах машины, включая небезопасный Wi-Fi в кафе/коворкинге, корпоративный VPN и внутреннюю офисную сеть. Это нарушает правила корпоративной безопасности (Zero Trust) и может вызывать конфликты портов на машинах с несколькими интерфейсами (Ethernet, Wi-Fi, WSL, Docker, Hyper-V, VPN).
2. **Селектор сетевого интерфейса:**
   - Пользователь должен иметь возможность выбрать конкретный сетевой адаптер для внешнего перехвата (например, только интерфейс точки доступа Wi-Fi `192.168.43.15` или WSL `172.28.16.1`), не подвергая риску основной трафик.
3. **Бесшовный мульти-бинд (Dual Listener):**
   - Если сокет привязан строго к `192.168.1.105:8888`, локальные системные приложения, обращающиеся по `127.0.0.1:8888`, получат `Connection Refused`.
   - Прокси должен поддерживать режим Dual Listener: основной сокет на выбранном IP (для смартфона) + обязательный loopback сокет на `127.0.0.1` (для локального `sysproxy`), либо синхронизировать системный прокси ОС с выбранным IP.

### Критерии приемки
- В схеме настроек `FluxUserSettingsProfile` (`settings.ts`, `settingsManager.ts`) и в Rust-контроллере (`server.rs`, `models.rs`) поддержаны режимы привязки:
  - `loopback` (`127.0.0.1`);
  - `all` (`0.0.0.0`);
  - `specific` с указанием IP (`specificBindIp`).
- В `SettingsModal.tsx` (вкладка *Rules & Proxy*) и в тулбаре/меню добавлен выпадающий список доступных сетевых адаптеров, динамически получаемый через `get_network_interfaces()`.
- При выборе конкретного IP прокси успешно принимает входящие подключения на этом IP, при этом локальный системный прокси ОС продолжает бесперебойно работать.
- Покрыто unit-тестами в Rust (`server.rs`).

---

### 📝 Промпт для Antigravity (Этап 15)

```markdown
Роль: Senior Network Systems Engineer (Rust / Tokio / Sockets) & Fullstack Developer.
Проект: FluxProxy — отладочный веб-прокси (Tauri v2 + Rust + React 18).

Задача: Реализовать возможность выбора конкретного IP-адреса / сетевого интерфейса для прослушивания (вместо жесткого переключения 127.0.0.1 / 0.0.0.0), поддержать мульти-бинд для сохранения работы локального системного прокси и обновить UI настроек.

1. Бэкенд (Rust — `src-tauri/src/proxy/server.rs`, `models.rs`, `commands.rs`):
   - В `models.rs` добавить типизацию `BindHostMode`: `Loopback` (127.0.0.1), `AllInterfaces` (0.0.0.0), `Specific(String)`.
   - Обновить `ProxyEngineController`:
     * Хранить целевой режим биндинга и выбранный IP.
     * При запуске прокси в режиме `Specific(ip)` поднимать основной `TcpListener` на `{ip}:{port}`. Если `{ip}` не равен `127.0.0.1`, также поднимать дополнительный listener на `127.0.0.1:{port}` (Dual Listener), чтобы системный прокси ОС (`sysproxy.rs`) продолжал перехватывать локальные приложения без сетевых ошибок.
     * Добавить команду Tauri `set_bind_configuration(mode: BindHostMode, ip: Option<String>, port: u16) -> Result<ProxyStatus, ProxyError>`.
     * В `ProxyStatus` возвращать фактический `bound_ips: Vec<String>` и `bind_mode`.

2. Настройки и профили (`src/types/settings.ts`, `src/lib/settingsManager.ts`):
   - Расширить схему `FluxUserSettingsProfile` полями:
     `bindMode: 'loopback' | 'all' | 'specific'` и `specificBindIp?: string`.
   - Обеспечить обратную совместимость (миграция v1 -> v2 или сохранение дефолта `loopback` при `allowRemote: false`).

3. Frontend UI (`src/components/SettingsModal.tsx`, `MobileSetupModal.tsx`, `TopToolbar.tsx`):
   - В `SettingsModal.tsx` (вкладка *Rules & Proxy*) заменить одиночный чекбокс на трехпозиционный переключатель с выпадающим списком интерфейсов (на базе команды `get_network_interfaces()`):
     * [x] Только локальный компьютер (`127.0.0.1`)
     * [ ] Все сетевые интерфейсы (`0.0.0.0`)
     * [ ] Выбранный сетевой интерфейс: `<Select: "Wi-Fi (192.168.1.105)", "Ethernet (10.0.0.2)", "WSL (172.28.16.1)">`
   - В строке состояния и подсказке порта отображать актуальный привязанный IP.

Файлы для модификации:
- `src-tauri/src/models.rs`
- `src-tauri/src/proxy/server.rs`
- `src-tauri/src/commands.rs`
- `src/types/settings.ts`
- `src/lib/settingsManager.ts`
- `src/components/SettingsModal.tsx`
- `src/hooks/useProxySessions.ts`

Критерии готовности:
- Привязка к конкретному адаптеру Wi-Fi позволяет мобильному телефону подключаться к прокси, но отсекает доступ с других сетевых карт.
- Локальный браузер на ПК продолжает работать через `127.0.0.1` благодаря Dual Listener.
- `cargo test --manifest-path src-tauri/Cargo.toml` и `npm run build` проходят без ошибок.
```

---

## Этап 5: Оптимизация вертикального пространства UI, автоподбор колонок и шорткаты инспектора
**Приоритет: P0 (High) | Спринт 2 (Эргономика и UX)**

### Описание задачи
Базовый флаг `compactToolbar` (уменьшение высоты строки тулбара) и поповер переключения чекбоксов колонок по правому клику на шапку в `TrafficGrid.tsx` уже добавлены в проект, однако:
1. В компактном режиме на узких экранах ноутбуков тулбар всё ещё требует горизонтальной прокрутки вместо лаконичной однострочной Slim-компоновки с выносом второстепенных групп в меню переполнения `•••`, и отсутствует глобальный шорткат быстрого переключения `Ctrl+Shift+T`.
2. Контекстное меню шапки таблицы (`TrafficGrid.tsx`) пока умеет только скрывать колонки и сбрасывать их целиком, но не содержит быстрых действий `Auto-fit This Column` (по колонке под курсором) и `Auto-fit All Columns`.
3. В `SessionInspector.tsx` отсутствует быстрое переключение вкладок с клавиатуры (`Ctrl+1` … `Ctrl+6`), вынуждающее кликать мышью при проверке заголовков, JSON, Auth и Hex.

### Критерии приемки
- Глобальный шорткат `Ctrl+Shift+T` (и пункт в `MenuBar.tsx` / `ShortcutsModal.tsx`) мгновенно переключает `Compact Toolbar`, а сам Slim-режим укладывает основные контролы в одну компактную строку без лишнего скролла.
- Правый клик по конкретной колонке в шапке `TrafficGrid.tsx` предлагает действия `Auto-fit "<Column>"`, `Auto-fit All Columns` и `Reset Columns & Widths` наряду с чекбоксами видимости.
- В фокусе таблицы или инспектора сочетания `Ctrl+1` … `Ctrl+6` переключают ключевые вкладки инспектора (Headers, JSON/Preview, Cookies, Auth, Raw, Hex).

---

### 📝 Промпт для Antigravity (Этап 5)

```markdown
Роль: Senior UX / Frontend Engineer (React 18 + TypeScript + Tailwind CSS).
Проект: FluxProxy — отладочный веб-прокси (Tauri v2 + React 18).

Контекст: В проекте уже есть состояние `compactToolbar` (`useUiPreferences.ts`, `SettingsModal.tsx`, `TopToolbar.tsx`) и поповер видимости колонок `headerColPopoverRef` в `TrafficGrid.tsx`, а также глобальный поиск `Ctrl+F`. Необходимо довести эти механизмы до завершенного UX.

Задача:
1. Доработка режима Compact Toolbar (`TopToolbar.tsx`, `MenuBar.tsx`, `App.tsx`, `ShortcutsModal.tsx`):
   - Добавить глобальную горячую клавишу `Ctrl+Shift+T` / `Cmd+Shift+T` для переключения `compactToolbar` и отобразить подсказку шортката в `MenuBar.tsx` (`View -> Customize Toolbar -> Compact Toolbar`) и `ShortcutsModal.tsx`.
   - В `TopToolbar.tsx` при `compactToolbar === true` уплотнить второстепенные подписи кнопок и скрывать редкие группы в существующее меню переполнения `•••`, чтобы ключевые элементы (Capture, Clear, Tail, Keep, быстрый поиск с RegExp и фильтр-чипы) гарантированно помещались в одну строку на 13-дюймовом экране.

2. Расширение контекстного меню шапки таблицы (`src/components/TrafficGrid.tsx`):
   - При вызове `handleHeaderContextMenu` определять колонку `ColumnId`, по заголовку которой кликнул пользователь.
   - В поповере шапки добавить быстрые кнопки действий:
     * `Auto-fit "<Название колонки>"` (вызывает существующую логику автоподбора ширины для выбранной колонки).
     * `Auto-fit All Visible Columns` (автоподбор ширины для всех видимых колонок по текущим строкам).
     * `Reset Columns & Widths` (существующий сброс).

3. Шорткаты вкладок Session Inspector (`src/components/SessionInspector.tsx`, `ShortcutsModal.tsx`):
   - Реализовать переключение вкладок активной панели инспектора по `Ctrl+1` … `Ctrl+6` (вне текстового ввода Monaco Editor):
     `1` -> Headers, `2` -> JSON (или Raw, если не JSON), `3` -> Params / Cookies, `4` -> Auth, `5` -> Raw, `6` -> Hex.
   - Отразить новые сочетания в `ShortcutsModal.tsx` и `CommandPalette.tsx`.

Критерии готовности:
- Шорткаты `Ctrl+Shift+T` и `Ctrl+1..6` работают без конфликтов с Monaco Editor и системными полями ввода.
- Правый клик по любому столбцу шапки позволяет в 1 клик подогнать ширину одного или всех столбцов.
- `npm run typecheck` и `npm run build` проходят без ошибок.
```

---

## Этап 16: Очистка и маскирование PII / секретов при экспорте сессий
**Приоритет: P0 (High) | Спринт 2 (Безопасность и соответствие стандартам)**

### Описание задачи
1. **Проблема утечки конфиденциальных данных:**
   - При сохранении архивов `.har` и `.saz` или копировании запросов для коллег/баг-трекеров в файлы попадают боевые учетные данные:
     - `Authorization: Bearer eyJ...`, `Basic ...`, `Cookie`, `Set-Cookie`, `X-Api-Key`;
     - Пароли, refresh-токены, секретные ключи в JSON-телах;
     - Платежные данные (PAN карт, CVV) и персональные данные (телефоны, email).
2. **Очищенный экспорт (Sanitized Export):**
   - Возможность в один клик сохранить безопасный файл без конфиденциальных данных.
   - Диалог параметров санитизации с настраиваемыми правилами (замена заголовков на `[REDACTED]`, маскирование JSON-полей, удаление токенов из URL query-параметров).

### Критерии приемки
- При экспорте (`Ctrl+S`, `File → Save Sessions...`) или вызове «Save Sanitized Sessions As...» открывается диалог настройки маскирования с сохраняемыми чекбоксами:
  - `Redact Authorization Headers` (`Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization`, `X-Api-Key`);
  - `Mask Sensitive JSON Fields` (`password`, `token`, `secret`, `refreshToken`, `cvv`, `pan`);
  - `Strip Sensitive Query Params` (`token`, `auth`, `api_key`, `signature`);
  - `Anonymize Client IPs and Process Names`.
- Экспортированный HAR/SAZ сохраняет валидную структуру JSON/ZIP, но все чувствительные значения заменяются плейсхолдерами.
- Покрыто unit-тестами в Rust (`export_import.rs`) и TypeScript.

---

### 📝 Промпт для Antigravity (Этап 16)

```markdown
Роль: Senior Security & Full-Stack Engineer (Rust + TypeScript + React).
Проект: FluxProxy — отладочный веб-прокси (Tauri v2 + Rust + React 18).

Задача: Реализовать подсистему безопасного экспорта (Data Sanitization & PII Redaction) для защиты от утечки секретов и персональных данных при сохранении HAR 1.2, SAZ, JSON и Raw HTTP архивов.

1. Бэкенд санитизации (Rust — `src-tauri/src/storage/export_import.rs`, `models.rs`):
   - Добавить структуру `SanitizationOptions`:
     * `redact_auth_headers: bool`,
     * `mask_json_keys: Vec<String>` (по умолчанию: `password`, `secret`, `token`, `refresh_token`, `access_token`, `cvv`, `card_number`, `pin`),
     * `strip_query_params: Vec<String>`,
     * `anonymize_client_info: bool`.
   - В функциях сериализации HAR, SAZ и JSON реализовать прозрачное применение `SanitizationOptions`:
     * Замена значений секретных заголовков на `"[REDACTED]"`.
     * Рекурсивный проход по JSON-телам: замена строковых значений для совпавших ключей на `"[REDACTED]"`.
     * Очистка query-параметров в строке URL.
   - Добавить unit-тест `sanitizes_har_and_saz_exports_without_corrupting_structure`.

2. Интерфейс санитизации (`src/components/SanitizedExportModal.tsx`, `MenuBar.tsx`, `App.tsx`):
   - Создать модальное окно `SanitizedExportModal.tsx` с пресетами: *Safe Sharing (рекомендуемый)*, *Strict Anonymization*, *Custom*.
   - Добавить пункт меню `File → Export Sanitized Sessions...` (`Ctrl+Shift+S`) и кнопку в поповер экспорта.
   - Сохранять пользовательские предпочтения санитизации в `settingsManager.ts`.

Критерии готовности:
- Сохраненный с маскированием HAR успешно импортируется обратно во FluxProxy и Chrome DevTools, не содержа оригинальных Bearer-токенов.
- `cargo test --manifest-path src-tauri/Cargo.toml` и `npm run build` проходят без ошибок.
```

---

## Этап 17: Диагностический мастер самопроверки «Proxy Doctor»
**Приоритет: P0 (High) | Спринт 2 (UX и снижение обращений в поддержку)**

### Описание задачи
1. **Проблема неявных сетевых сбоев:**
   - Когда пользователь включает прокси, но «трафик не идет», причина часто кроется вне программы:
     - Порт 8888 уже занят другим приложением (Fiddler, IIS, Docker, Charles);
     - Windows Firewall или антивирус блокирует локальный входящий сокет;
     - Внешний корпоративный VPN перехватил системный маршрут и сбросил `sysproxy`;
     - Корневой сертификат FluxProxy не установлен в хранилище ОС или не добавлен в Firefox.
2. **Мастер самодиагностики «Proxy Doctor»:**
   - Встроенный инструмент, по одной кнопке запускающий серию проверок и предлагающий исправление обнаруженных проблем в 1 клик.

### Критерии приемки
- Окно `ProxyDoctorModal.tsx` (доступно через `Help → Run Proxy Doctor…` или иконку стетоскопа в статусной строке при возникновении ошибок).
- Набор автоматических тестов:
  1. *Port Availability & Socket Bind*: порт свободен и слушается без конфликтов;
  2. *OS Trust Store*: корневой сертификат FluxProxy установлен и валиден;
  3. *Active SysProxy Configuration*: системный прокси ОС указывает на текущий endpoint FluxProxy;
  4. *Firewall Rule Check*: брандмауэр не блокирует TCP-порт приложения;
  5. *VPN / Interface Conflict*: отсутствие конфликтующих сетевых туннелей;
  6. *End-to-End Loopback Request*: тестовый ping через локальный прокси с успешной валидацией ответа.
- Кнопка «Auto-Repair All Issues» (переустановка сертификата, перепривязка порта, восстановление системного прокси).

---

### 📝 Промпт для Antigravity (Этап 17)

```markdown
Роль: Senior Systems Engineer & Diagnostics Specialist (Rust + React 18).
Проект: FluxProxy — отладочный веб-прокси (Tauri v2 + Rust + React 18).

Задача: Реализовать встроенный диагностический инструмент «Proxy Doctor» для выявления и автоматического устранения распространенных сетевых конфликтов и проблем с сертификатами.

1. Бэкенд проверок (Rust — `src-tauri/src/proxy/doctor.rs`, `commands.rs`):
   - Создать модуль `src-tauri/src/proxy/doctor.rs`:
     * `check_port_binding(port: u16)`: проверка доступности порта и определение процесса-конфликта при ошибке bind.
     * `check_root_ca_status()`: проверка присутствия сертификата в системном хранилище ОС.
     * `check_sysproxy_status()`: проверка фактических реестровых/системных настроек прокси в Windows/macOS/Linux.
     * `check_loopback_health(port: u16)`: отправка тестового GET-запроса на `http://flux.proxy/health` через прокси.
   - Команды Tauri:
     * `run_proxy_doctor() -> Result<Vec<DoctorCheckResult>, ProxyError>`
     * `fix_doctor_issue(issue_id: String) -> Result<DoctorFixResult, ProxyError>`

2. Интерфейс «Proxy Doctor» (`src/components/ProxyDoctorModal.tsx`, `MenuBar.tsx`, `TopToolbar.tsx`):
   - Модальное окно `ProxyDoctorModal.tsx` с красивым списком проверок, анимацией сканирования, статусами (OK, Warning, Error) и детальным описанием проблем понятным языком.
   - Кнопка «Repair Selected» (вызывает переустановку сертификата, перепривязку порта или сброс/повторное включение SysProxy).
   - Интеграция в верхнее меню `Help → Run Proxy Doctor…` (`Ctrl+Shift+D`) и кликабельный индикатор ошибок в строке состояния.

Критерии готовности:
- Proxy Doctor корректно определяет выключенный системный прокси, отсутствие Root CA или занятый порт.
- Кнопка восстановления успешно устраняет ошибку без перезапуска программы.
- `cargo test --manifest-path src-tauri/Cargo.toml` и `npm run build` проходят без ошибок.
```

---

## Этап 6: Selective MITM & Bypass 2.0: Массовые фильтры (Bulk Editor), расширенная база правил TLS Pinning и 1-Click UX
**Приоритет: P1 (High) | Спринт 2 (Сетевая надежность и избирательный перехват)**

### Описание задачи
Режим избирательного перехвата (Selective MITM) позволяет расшифровывать только нужные веб-сервисы, а остальной трафик пробрасывать через прямой TCP-туннель (`tokio::io::copy_bidirectional`), устраняя проблемы с Certificate Pinning. Переключатели режимов `MITM: All / Targeted` и быстрые команды контекстного меню `Always inspect` / `Always passthrough` уже работают в UI, однако управление самими списками правил нуждается в серьезном расширении:

1. **Массовые фильтры и пакетный редактор (Bulk Editor & Fast Input)** во вкладке `tlsBypass` (`FilterDrawer.tsx`):
   - Переключение между **Табличным видом (Table View)** и **Пакетным текстовым редактором (Bulk Text Mode)** (аналогично `HostFiltersTab.tsx`) для списков **Target Allowlist** и **TLS Bypass** с поддержкой многострочной вставки, масок `*.domain.com`, `regex:` и комментариев `#`.
   - Кнопка **«Quick Paste…»** для вставки сырого списка доменов из буфера обмена с назначением категории.
   - **Панель групповых операций**: чекбокс «Выбрать все», массовое включение/отключение/удаление выбранных правил, экспорт и импорт списков в `.txt` / `.json`.
   - **Чипы обнаруженных хостов (Detected Hosts Chips)**: топ доменов текущего сеанса с кнопками в 1 клик `+ Bypass` / `+ Target`.
2. **Расширенная база правил TLS Pinning и 10 курируемых Quick-Packs**:
   - Критические PKI-сервисы (OCSP / CRL) в дефолтном наборе (`ocsp.*, crl.*, *.digicert.com, *.sectigo.com, *.letsencrypt.org`) для исключения рекурсивных сбоев проверки сертификатов.
   - Расширение `TLS_BYPASS_QUICK_PACKS` до 10 готовых наборов: *Dev Tools & Package Managers* (`github.com`, `npmjs.org`, `pypi.org`, `crates.io`, `docker.io`), *DRM & Streaming* (Spotify, Netflix), *Gaming & Anti-Cheat* (Steam, Epic, Riot, Battle.net), *РФ FinTech & Госуслуги* (Сбер, Т-Банк, Альфа, ВТБ, Госуслуги), *Google & Android FCM*, *Apple Ecosystem & APNs*, *Windows Updates*, *Secure Messengers*, *Corporate Collaboration* (Slack, Teams, Zoom), *Payment Gateways & 3-D Secure*.
3. **Счетчик попаданий (Hit Counter)** в Rust (`filters.rs`, `server.rs`) для каждого правила обхода и визуальный бейдж `TUNNEL` в колонке `Protocol` для транзитных сессий.

### Критерии приемки
- Во вкладке Selective MITM доступно переключение `Table View` ↔ `Bulk Text Editor` без потери описаний и категорий правил.
- Работают массовые операции (выделение чекбоксами, пакетное включение/отключение/удаление, Quick Paste, экспорт/импорт TXT/JSON).
- В `filters.rs` и `filterEngine.ts` синхронизированы расширенные базовые правила PKI/OCSP и 10 курируемых Quick-Packs + кнопка «Восстановить рекомендованные дефолты».
- В реальном времени отображается счетчик срабатываний каждого правила (`Hits: N`).
- `cargo test --manifest-path src-tauri/Cargo.toml` и `npm run build` проходят без ошибок.

---

### 📝 Промпт для Antigravity (Этап 6)

```markdown
Роль: Senior Full-Stack & Network Systems Engineer (Rust + React 18 + TypeScript).
Проект: FluxProxy — отладочный веб-прокси (Tauri v2 + Rust + React 18).

Задача: Модернизировать подсистему Selective MITM & Bypass: реализовать пакетный редактор правил (Bulk Text & Quick Paste), расширить встроенную базу правил TLS Pinning и Quick-Packs до 10 категорий, добавить счетчик попаданий (Hit Counter) в Rust и улучшить индикацию транзитных туннелей.

1. Бэкенд (Rust — `src-tauri/src/proxy/filters.rs`, `src-tauri/src/proxy/server.rs`, `commands.rs`, `lib.rs`):
   - Расширить `default_tls_bypass_rules()` критическими сервисами PKI / OCSP / CRL (`ocsp.*, crl.*, *.digicert.com, *.sectigo.com, *.letsencrypt.org, ocsp.apple.com`), а также дополнить домены Apple APNs, Microsoft SmartScreen/Delivery, Discord/Slack/Teams и платежных шлюзов.
   - Добавить потокобезопасный учет срабатываний правил (`hit_count`) при проверке CONNECT-туннеля и команду Tauri `get_tls_rule_hit_counts()` + `reset_tls_bypass_rules_to_recommended()`.

2. Расширение наборов правил на фронтенде (`src/lib/filterEngine.ts`):
   - Синхронизировать `DEFAULT_BACKEND_FILTER_CONFIG.tlsBypassRules` с Rust-бэкендом и корректно сохранять новые поля в `settingsManager.ts`.
   - Расширить `TLS_BYPASS_QUICK_PACKS` до 10 готовых наборов: Dev Tools & Package Managers, DRM & Streaming, Gaming & Anti-Cheat, РФ FinTech & Госуслуги, Google & Android FCM, Apple Ecosystem & APNs, Windows Services, E2EE Messengers, Corporate Collaboration, Payment Gateways.

3. Интерфейс Selective MITM & Bypass (`src/components/FilterDrawer.tsx`, `TrafficGrid.tsx`):
   - Добавить переключатель режима `[Table View]` | `[Bulk Text Editor]` для списков Target Allowlist и TLS Bypass.
   - Реализовать чекбоксы мультивыбора, тулбар массовых действий (Включить / Отключить / Удалить выбранные), диалог «Quick Paste…», экспорт/импорт в `.txt` и `.json`, кнопку сброса к рекомендованным дефолтам и отображение бейджа `Hits: N`.
   - Добавить панель чипов обнаруженных в текущем сеансе хостов с кнопками `+ Target` / `+ Bypass` в 1 клик.
   - В `TrafficGrid.tsx` отображать аккуратный бейдж `TUNNEL` для сессий с `tlsBypassed === true`.

Критерии готовности:
- Вставка 50+ доменов через Bulk Text или Quick Paste мгновенно создает валидные правила и синхронизирует их с Rust.
- Счетчик попаданий увеличивается при прохождении CONNECT-туннелей через соответствующее правило.
- `cargo test --manifest-path src-tauri/Cargo.toml` и `npm run build` проходят без ошибок.
```

---

## Этап 18: Клиентские сертификаты (mTLS / Client Certificates Store)
**Приоритет: P1 (High) | Спринт 3 (Корпоративные протоколы)**

### Описание задачи
1. **Проблема взаимной аутентификации TLS:**
   - Во многих корпоративных, микросервисных и банковских API сервер требует, чтобы клиент предоставил свой собственный X.509 сертификат (Mutual TLS / mTLS).
   - Без поддержки клиентских сертификатов проксирование таких запросов завершается ошибкой рукопожатия TLS `400 Bad Request: No required SSL certificate was sent` или `403 Forbidden`.
2. **Хранилище клиентских сертификатов:**
   - Возможность импортировать файлы `.p12` / `.pfx` (PKCS#12 с защитой паролем) или `.pem` + закрытый ключ.
   - Привязка сертификата к маске хостов (например, `*.internal.company.com` -> `corp-cert.p12`).
   - Автоматическая передача `Identity` в TLS-клиент Rust при соединении с соответствующим upstream-сервером.

### Критерии приемки
- Модальное окно `ClientCertificatesModal.tsx` (`Tools → Client Certificates…` / `Ctrl+Shift+C`).
- Добавление, редактирование, проверка срока действия и удаление клиентских сертификатов.
- Безопасное хранение сертификатов и паролей в локальном хранилище приложения.
- Rust-клиент (`server.rs`) успешно устанавливает mTLS-соединение с тестовым сервером, требующим клиентский сертификат.

---

### 📝 Промпт для Antigravity (Этап 18)

```markdown
Роль: Senior Security & Network Engineer (Rust / Tokio / TLS / reqwest) & Frontend Developer.
Проект: FluxProxy — отладочный веб-прокси (Tauri v2 + Rust + React 18).

Задача: Реализовать поддержку Mutual TLS (mTLS): хранилище клиентских сертификатов (PKCS#12 / PEM), сопоставление с доменами и отправку сертификата upstream-серверу при перехвате трафика.

1. Бэкенд клиентских сертификатов (Rust — `src-tauri/src/proxy/client_certs.rs`, `server.rs`):
   - Создать модуль `src-tauri/src/proxy/client_certs.rs`:
     * Структура `ClientCertificateEntry`: `id`, `domain_pattern`, `cert_path`, `password_encrypted`, `common_name`, `expires_at`, `enabled: bool`.
     * Загрузка PKCS#12 (`.p12`/`.pfx`) через `reqwest::Identity::from_pkcs12_der` или PEM (`reqwest::Identity::from_pkcs8_pem`).
     * Реестр сертификатов с поиском подходящего сертификата по запрашиваемому `host`.
   - В `server.rs`: если для целевого домена зарегистрирован клиентский сертификат, инстанциировать upstream HTTP/HTTPS клиент с соответствующим `Identity`.
   - Команды Tauri: `list_client_certificates`, `add_client_certificate`, `remove_client_certificate`, `test_client_certificate`.

2. Интерфейс управления сертификатами (`src/components/ClientCertificatesModal.tsx`, `MenuBar.tsx`):
   - Создать `ClientCertificatesModal.tsx` с таблицей привязок (Доменная маска, Имя сертификата, Срок действия, Статус).
   - Кнопка «Add Certificate…» с выбором файла (`.p12`, `.pfx`, `.pem`), вводом пароля и автоматическим извлечением метаданных (CN, Expiration Date).
   - Интеграция в верхнее меню `Tools → Client Certificates…`.

Критерии готовности:
- При обращении к mTLS-эндпоинту прокси корректно отправляет клиентский сертификат, и сервер возвращает успешный ответ вместо ошибки рукопожатия.
- `cargo test --manifest-path src-tauri/Cargo.toml` и `npm run build` проходят без ошибок.
```

---

## Этап 7: Кастомные скрипты на Python (Python Scripting Engine)
**Приоритет: P1 (Medium) | Спринт 3 (Автоматизация для продвинутых пользователей)**

### Описание задачи
Реализовать аналог FiddlerScript / mitmproxy Python addons: возможность писать пользовательские скрипты на Python для динамической модификации запросов и ответов «на лету» (расчет HMAC-подписей, переписывание параметров, кастомное логирование и сложная логика мокирования).

### Критерии приемки
- Асинхронный воркер-процесс Python (`tokio::process::Child`), общающийся с Rust через `stdin`/`stdout` (JSON Lines / JSON-RPC) с защитным таймаутом 1500 мс (fail-open без блокировки прокси).
- Поддержка хуков `on_request(request)` и `on_response(response)` в Python.
- Раздел **Scripts** в боковой панели (`Sidebar.tsx`) со встроенным Monaco Editor (подсветка Python), готовыми шаблонами (Templates), сохранением скрипта в профиле настроек и живой консолью вывода `print(...)` / `stderr`.

---

### 📝 Промпт для Antigravity (Этап 7)

```markdown
Роль: Senior Systems Engineer (Rust / Tokio / IPC) & Full-Stack Developer.
Проект: FluxProxy — отладочный веб-прокси (Tauri v2 + Rust + React 18 + Monaco Editor).

Задача: Реализовать движок кастомных скриптов на Python (Python Scripting Engine) для перехвата и модификации сетевого трафика «на лету».

1. Rust Python Runner (`src-tauri/src/scripting/`):
   - Создать модуль `src-tauri/src/scripting/python_runner.rs`:
     * Управление долгоживущим дочерним процессом Python (`python3` / `python` / `py`).
     * Протокол обмена сообщениями через stdin/stdout (JSON Lines).
     * Таймаут безопасности на вызов хука: 1500 мс. При превышении таймаута или падении скрипта запрос пропускается без изменений (fail-safe), а ошибка пишется в консоль скрипта.
   - Поддерживаемые хуки в Python:
     ```python
     def on_request(request):
         # request: {"id": 1, "method": "POST", "url": "...", "headers": [...], "body": "..."}
         if "api/v1/auth" in request["url"]:
             request["headers"].append({"name": "X-Custom-Trace", "value": "Python"})
         return request

     def on_response(response):
         # response: {"id": 1, "status": 200, "headers": [...], "body": "..."}
         if response["status"] >= 500:
             print(f"Server error intercepted: {response.get('url')}")
         return response
     ```
   - Интегрировать вызов хуков в `server.rs` перед отправкой запроса в upstream и перед возвратом ответа клиенту.
   - Экспортировать Tauri-команды `set_python_script(code: String, enabled: bool)`, `get_python_runner_status()` и потоковое событие логов `proxy://script-console-log`.

2. Frontend UI (`src/components/ScriptingPanel.tsx`, `Sidebar.tsx`, `MenuBar.tsx`):
   - Добавить раздел **Scripts (`Alt+5`)** в `Sidebar.tsx` и `MenuBar.tsx`.
   - Создать `ScriptingPanel.tsx` с Monaco Editor (`language="python"`), выпадающим списком шаблонов (HMAC Header Injection, Conditional Mock, Query Rewriter, Payload Logger), кнопкой «Apply Script», индикатором статуса интерпретатора Python и нижней панелью логов.

Критерии готовности:
- Если Python не найден в системе, отображается понятная диагностика без падения приложения.
- Модификация заголовков и тела в `on_request` / `on_response` реально применяется к трафику и видна в Session Inspector.
- `cargo test --manifest-path src-tauri/Cargo.toml` и `npm run build` проходят без ошибок.
```

---

## Этап 8: Composer 2.0: Умный «Paste cURL» и генератор клиентского кода на 5 языках
**Приоритет: P1 (Medium) | Спринт 3 (Продуктивность разработчика)**

### Описание задачи
Модернизировать HTTP Composer и экспорт запросов: добавить умный импорт команд `cURL` из буфера обмена («Paste cURL») и генератор готового клиентского кода (Code Snippet Generator) для популярных языков программирования.

### Критерии приемки
- Кнопка «Import cURL» в `ComposerPanel.tsx` и автоопределение вставки: при нажатии `Ctrl+V` в фокусе Composer строка `curl ...` автоматически разбирается в метод, URL, заголовки, куки, Basic-авторизацию и тело.
- Парсер корректно обрабатывает многострочные команды с `\`, одинарные/двойные кавычки и флаги `-X/--request`, `-H/--header`, `-d/--data/--data-raw/--data-binary`, `-b/--cookie`, `-u/--user`.
- Модальное окно `CodeSnippetModal.tsx` (вызывается из Composer и контекстного меню `TrafficGrid.tsx`) генерирует готовый к запуску код в Monaco Editor для **JavaScript** (`fetch`, `axios`), **Python** (`requests`, `httpx`), **Go** (`net/http`), **Rust** (`reqwest`) и **cURL**.

---

### 📝 Промпт для Antigravity (Этап 8)

```markdown
Роль: Senior Full-Stack Developer.
Проект: FluxProxy — кроссплатформенный отладочный веб-прокси (Tauri v2 + React 18 + TypeScript + Monaco Editor).

Задача: Модернизировать Request Composer: реализовать умный парсер команд cURL («Import / Paste cURL») и модальное окно генерации клиентского кода (Code Snippet Generator).

1. Умный импорт cURL (`src/lib/curlParser.ts`, `src/components/ComposerPanel.tsx`):
   - Реализовать надежный парсер shell-аргументов команды `curl` (поддержка одинарных/двойных кавычек, экранирования, переносов строк `\` и `^` в Windows cmd/PowerShell):
     * Метод: `-X`, `--request` (автоматический переход в `POST`, если передан `-d` без явного `-X`).
     * Заголовки и куки: `-H`, `--header`, `-b`, `--cookie`, `-A`, `--user-agent`.
     * Авторизация: `-u user:pass` -> `Authorization: Basic <base64>`.
     * Тело: `-d`, `--data`, `--data-raw`, `--data-binary`, `--json`.
   - В `ComposerPanel.tsx` добавить кнопку «Import cURL» с модальным полем ввода, а также авторазбор при вставке команды `curl ...` в поле URL.

2. Генератор клиентского кода (`src/lib/codeGenerators.ts`, `src/components/CodeSnippetModal.tsx`):
   - Поддержать генерацию кода из любой сессии или черновика Composer для 5 целей:
     * JavaScript (`fetch` / `axios`),
     * Python (`requests` / `httpx`),
     * Go (`net/http`),
     * Rust (`reqwest`),
     * cURL (POSIX bash & Windows PowerShell).
   - Добавить вызов «Generate Client Code…» в `ComposerPanel.tsx`, `TrafficGrid.tsx` (контекстное меню строки) и `MenuBar.tsx` (`Edit`).

Критерии готовности:
- Многострочный `Copy as cURL` из Chrome DevTools корректно импортируется в Composer без потери заголовков и JSON-тела.
- `npm run typecheck` и `npm run build` завершаются без ошибок.
```

---

## Этап 19: Автоматическая генерация спецификаций OpenAPI 3.0 / Swagger
**Приоритет: P1 (Medium) | Спринт 3 (Продуктивность разработчиков)**

### Описание задачи
1. **Проблема ручного документирования API:**
   - При реверс-инжиниринге, создании тестов или обновлении документации разработчики тратят часы на ручное описание эндпоинтов, параметров и JSON-схем.
2. **Генератор OpenAPI из захваченного трафика:**
   - Возможность выделить несколько сессий в таблице трафика и нажать **«Export as OpenAPI 3.0 Spec…»**.
   - Движок автоматически определяет структуру путей (`/api/v1/orders/{id}`), методы, query-параметры, заголовки и выводит JSON-схему для тел запросов и ответов (`type`, `properties`, `items`, примеры).

### Критерии приемки
- Модальное окно `OpenApiExportModal.tsx` с предварительным просмотром сгенерированной спецификации в Monaco Editor (`yaml` / `json`).
- Автоматическое объединение повторяющихся эндпоинтов с разными HTTP-статусами (`200`, `400`, `500`) в один путь OpenAPI.
- Возможность скачать файл `.yaml` или `.json`.

---

### 📝 Промпт для Antigravity (Этап 19)

```markdown
Роль: Senior Fullstack Engineer & API Specialist (TypeScript + OpenAPI).
Проект: FluxProxy — отладочный веб-прокси (React 18 + TypeScript + Monaco Editor).

Задача: Реализовать генератор спецификаций OpenAPI 3.0 / Swagger на основе выбранных пользователем сессий перехваченного сетевого трафика.

1. Движок генерации OpenAPI (`src/lib/openApiGenerator.ts`):
   - Функция `generateOpenApiSpec(sessions: SessionDetail[], options: OpenApiGeneratorOptions): string`.
   - Алгоритм группировки:
     * Извлечение базового URL (`servers`) и путей (`paths`).
     * Определение path-параметров по числовым или UUID сегментам (`/orders/123` -> `/orders/{orderId}`).
     * Преобразование Query-параметров в параметры OpenAPI (`in: "query"`).
     * Автоматический инференс JSON-схемы из тела запроса и ответа (распознавание примитивных типов `string`, `number`, `boolean`, массивов и вложенных объектов с генерацией `example`).
     * Поддержка нескольких кодов ответов (`responses["200"]`, `responses["400"]`, `responses["500"]`).
   - Поддержка сериализации в YAML (через компактный сериализатор) и JSON.

2. Интерфейс генератора (`src/components/OpenApiExportModal.tsx`, `TrafficGrid.tsx`):
   - Добавить пункт контекстного меню таблицы «Export as OpenAPI Spec…» при выборе одной или нескольких сессий.
   - Окно экспорта с Monaco Editor для предпросмотра, переключателем YAML / JSON, полями для названия API и версии, а также кнопкой «Save to File».

Критерии готовности:
- Сгенерированная спецификация успешно проходит валидацию на Swagger Editor (editor.swagger.io) без синтаксических ошибок.
- `npm run typecheck` и `npm run build` проходят без ошибок.
```

---

## Этап 9: Тестирование фронтенда (Vitest) и CI/CD (GitHub Actions)
**Приоритет: P1 (Medium) | Спринт 3 (Качество и автоматизация)**

### Описание задачи
Подключить тестовый раннер `Vitest`, покрыть модульными тестами ключевые клиентские движки в `src/lib/` (парсеры протоколов, матричные фильтры, сравнение сессий, валидатор и миграции профилей настроек, кодеки TextWizard) и настроить кроссплатформенный пайплайн GitHub Actions для Windows, macOS и Linux.

### Критерии приемки
- Команда `npm run test` запускает `vitest run` и успешно выполняет все тестовые наборы.
- Покрыты unit-тестами `protocolInspectors.ts`, `filterEngine.ts`, `settingsManager.ts`, `sessionDiff.ts`, `textWizard.ts` (и `curlParser.ts`, если Этап 8 уже выполнен).
- Создан `.github/workflows/ci.yml` с матричной проверкой фронтенда и Rust-бэкенда (`npm run typecheck`, `npm run test`, `npm run build`, `cargo test`) на трех ОС.

---

### 📝 Промпт для Antigravity (Этап 9)

```markdown
Роль: Senior QA & DevOps / Frontend Automation Engineer.
Проект: FluxProxy — кроссплатформенный веб-прокси (Tauri v2 + Rust + React 18 + TypeScript).

Задача: Настроить `vitest` для фронтенда, покрыть unit-тестами критическую бизнес-логику `src/lib/` и создать кроссплатформенный GitHub Actions CI workflow.

1. Настройка Vitest:
   - Установить dev-зависимости `vitest` и `jsdom`.
   - Настроить секцию `test` в `vite.config.ts` и добавить скрипты `"test": "vitest run"` и `"test:watch": "vitest"` в `package.json`.

2. Unit-тесты модулей `src/lib/`:
   - `protocolInspectors.test.ts`: разбор SSE/LLM стримов (`[DONE]`, сборка текста), Protobuf wire-декодер без `.proto`, парсер `multipart/form-data`, аудит безопасности Auth/JWT и анализ кэша RFC 9111.
   - `filterEngine.test.ts`: вычисление условий Filter Matrix (`AND`/`OR`, числовые и строковые операторы), компиляция списков хостов (wildcards, `regex:`), пороги шума.
   - `settingsManager.test.ts`: экспорт, валидация, fallback поврежденных полей и миграция профиля `FluxUserSettingsProfile`.
   - `sessionDiff.test.ts` и `textWizard.test.ts`: нормализация JSON/заголовков при diff-сравнении и преобразования Base64/URL/Hex/JWT/Timestamp.

3. GitHub Actions CI (`.github/workflows/ci.yml`):
   - Матрица ОС: `ubuntu-latest` (с установкой системных пакетов WebKitGTK), `windows-latest`, `macos-latest`.
   - Кэширование зависимостей npm и Cargo, запуск `npm ci`, `npm run typecheck`, `npm run test`, `npm run build` и `cargo test --manifest-path src-tauri/Cargo.toml`.

Критерии готовности:
- `npm run test` и `cargo test --manifest-path src-tauri/Cargo.toml` полностью зеленые.
- Конфигурация `.github/workflows/ci.yml` валидна и готова к запуску в GitHub.
```

---

## Этап 10: Сетевая инфраструктура: HOSTS Remapping (Virtual DNS) и Bandwidth Throttling
**Приоритет: P2 (Feature) | Спринт 4 (Расширенный сетевой функционал)**

### Описание задачи
Реализовать две востребованные сетевые возможности классических прокси-отладчиков:
1. **HOSTS Remapping (Virtual DNS):** аналог `Tools → HOSTS…` во Fiddler Classic — прозрачное перенаправление запросов с боевых доменов (например, `api.production.com`) на локальный или тестовый сервер (`127.0.0.1:3000` или `staging.internal:8443`) с сохранением оригинального заголовка `Host`, без редактирования системного файла `hosts` и без прав администратора.
2. **Bandwidth Throttling:** физическое ограничение скорости чтения/записи и добавление сетевой задержки на уровне потоков Tokio (пресеты `GPRS`, `Slow 3G`, `Fast 3G`, `LTE`, `Offline`, `Custom KB/s`).

### Критерии приемки
- В Rust реализован потокобезопасный реестр `HostRemapRegistry` с поддержкой точных доменов и масок `*.example.com`.
- Реализовано модальное окно `HostRemapModal.tsx` (`Tools → HOSTS Remapping…`) и сохранение правил ремаппинга в профиле настроек.
- Реализован шейпер трафика (Token Bucket / AsyncRead+AsyncWrite wrapper) в Rust и быстрый переключатель сетевого профиля на тулбаре и в строке состояния.

---

### 📝 Промпт для Antigravity (Этап 10)

```markdown
Роль: Senior Rust Systems Engineer & Frontend Developer.
Проект: FluxProxy — кроссплатформенный отладочный веб-прокси (Tauri v2 + Tokio + Hyper + React 18).

Задача: Реализовать HOSTS Remapping (виртуальный DNS-редирект без правок системного hosts) и глобальный Bandwidth Throttling (эмуляция медленных сетей).

1. HOSTS Remapping (`src-tauri/src/proxy/hosts.rs`, `server.rs`, `src/components/HostRemapModal.tsx`):
   - Правило `HostRemapRule`: `id`, `enabled`, `sourcePattern` (домен или wildcard), `targetHost`, `targetPort`, `preserveHostHeader: bool`, `comment`.
   - При проксировании HTTP/HTTPS и установке CONNECT-туннелей перенаправлять физическое TCP-подключение на `targetHost:targetPort`, сохраняя исходный заголовок `Host` и помечая сессию индикатором ремаппинга.
   - Добавить команды Tauri `get_host_remap_rules` / `update_host_remap_rules` и окно `HostRemapModal.tsx` в меню `Tools`.

2. Bandwidth Throttling (`src-tauri/src/proxy/throttle.rs`, `TopToolbar.tsx`):
   - Пресеты: `No Throttling`, `GPRS (50 Kbps / 500 ms)`, `Slow 3G (400 Kbps / 400 ms)`, `Fast 3G (1.6 Mbps / 150 ms)`, `4G LTE (30 Mbps / 40 ms)`, `Offline`, `Custom`.
   - Ограничивать скорость передачи данных на уровне потоков прокси и отображать активный профиль троттлинга на `TopToolbar.tsx` и в статус-баре.

Критерии готовности:
- Правило `example.test -> 127.0.0.1:8080` прозрачно направляет запрос на локальный сервер, что подтверждается интеграционным тестом в Rust.
- При включении профиля `Slow 3G` загрузка крупных ответов предсказуемо замедляется, а `Offline` обрывает внешние соединения.
- `cargo test --manifest-path src-tauri/Cargo.toml` и `npm run build` проходят без ошибок.
```

---

## Этап 11: Архитектурная декомпозиция монолитов и внедрение стейт-менеджера (Zustand)
**Приоритет: P2 (Feature) | Спринт 4 (Масштабируемость архитектуры)**

### Описание задачи
По мере активного роста функциональности несколько ключевых файлов стали слишком крупными (`server.rs`, `export_import.rs`, `App.tsx`, `SettingsModal.tsx`, `FilterDrawer.tsx`, `useProxySessions.ts`). Необходимо аккуратно разделить их на логические подмодули без изменения внешнего поведения, перевести глобальное состояние фронтенда на легковесный стор `Zustand` (устранив сквозную передачу десятков пропсов через `App.tsx`) и настроить ленивую подгрузку тяжелых модальных окон и Monaco Editor (`React.lazy` + `Suspense`).

### Критерии приемки
- `src-tauri/src/proxy/server.rs` и `src-tauri/src/storage/export_import.rs` разбиты на компактные тематические подмодули (`server/mod.rs`, `http_handler.rs`, `connect_tunnel.rs`, `websocket_relay.rs`, `mobile_portal.rs`; `export_import/har.rs`, `saz.rs`, `raw.rs`).
- `FilterDrawer.tsx` и `SettingsModal.tsx` разделены на отдельные компоненты вкладок.
- Внедрен `zustand` для состояния сессий, прокси и фильтров; устранен prop-drilling в `App.tsx`.
- Тяжелые модальные окна загружаются асинхронными чанками через `React.lazy()`, заметно сокращая размер стартового JS-бандла.
- Все существующие тесты и функции работают идентично состоянию до рефакторинга.

---

### 📝 Промпт для Antigravity (Этап 11)

```markdown
Роль: Principal Systems Architect & React Performance Specialist.
Проект: FluxProxy — кроссплатформенный веб-прокси (Tauri v2 + Rust + React 18).

Задача: Провести безопасную модульную декомпозицию крупных файлов Rust и React, внедрить `zustand` для устранения prop-drilling и настроить Code Splitting без регрессий функциональности.

1. Декомпозиция Rust-ядра:
   - Разделить `src-tauri/src/proxy/server.rs` на подмодули в `src-tauri/src/proxy/server/` (`mod.rs`, `http_handler.rs`, `connect_tunnel.rs`, `websocket_relay.rs`, `composer_exec.rs`, `mobile_portal.rs`).
   - Разделить `src-tauri/src/storage/export_import.rs` на `src-tauri/src/storage/export_import/` (`mod.rs`, `har.rs`, `saz.rs`, `raw.rs`).
   - Сохранить и прогнать все существующие unit- и интеграционные тесты.

2. Декомпозиция фронтенда, Zustand и Code Splitting:
   - Установить `zustand` и выделить сторы `useProxyStore`, `useFilterStore`, `useUiStore` с полной совместимостью с `settingsManager.ts` и `localStorage`.
   - Разбить `FilterDrawer.tsx` на компоненты вкладок в `src/components/filters/`, а `SettingsModal.tsx` — на вкладки в `src/components/settings/`.
   - Обернуть тяжелые модальные окна (`SettingsModal`, `FilterDrawer`, `BreakpointModal`, `SessionDiffView`, `TextWizardModal`, `MobileSetupModal`) в `React.lazy()` + `Suspense`.

Критерии готовности:
- Стартовый бандл `dist/assets/index-*.js` существенно уменьшился за счет вынесения Monaco Editor и модальных окон в отдельные чанки.
- `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run typecheck` и `npm run build` проходят без ошибок.
```

---

## Этап 12: Аналитика и визуализация: Waterfall Timeline и панель статистики трафика
**Приоритет: P2 (Feature) | Спринт 4 (Аналитика и профилирование)**

### Описание задачи
Добавить инструменты наглядного анализа производительности по серии запросов:
1. **Каскадная диаграмма (Waterfall Timeline):** визуализация параллельных и последовательных запросов на единой шкале времени с отображением задержек и блокировок.
2. **Панель агрегированной статистики (Traffic Statistics):** сводный отчет по всем отфильтрованным или выделенным в таблице сессиям (общий объем трафика, среднее время, медиана и P95, распределение по кодам ответов и Content-Type, топ самых медленных и самых тяжелых эндпоинтов с копированием готовой сводки в буфер обмена).

### Критерии приемки
- Режим просмотра **Timeline** с масштабированием временной шкалы и синхронизацией выбора строки с `TrafficGrid`.
- Модальное окно / вкладка `TrafficStatisticsModal.tsx` с мгновенным расчетом метрик по выделенным сессиям и кнопкой «Copy Summary Report» (Markdown) для вставки в баг-репорты.

---

### 📝 Промпт для Antigravity (Этап 12)

```markdown
Роль: Senior Frontend & Data Visualization Engineer.
Проект: FluxProxy — кроссплатформенный отладочный веб-прокси (React 18 + TypeScript + Tailwind CSS).

Задача: Реализовать каскадную диаграмму таймингов (Waterfall Timeline) и панель сводной статистики трафика (Traffic Statistics).

1. Waterfall Timeline (`src/components/WaterfallTimeline.tsx`):
   - Горизонтальная шкала времени относительно старта первой сессии в выборке с масштабированием (Zoom) и цветовой кодировкой по статусам / типам контента.
   - Синхронизация клика по полосе таймлайна с выбором сессии в `TrafficGrid` и открытием `SessionInspector`.

2. Панель статистики (`src/components/TrafficStatisticsModal.tsx`):
   - Расчет показателей по выделенным (или всем видимым) сессиям: общее число запросов, доля 2xx/3xx/4xx/5xx, суммарный объем данных, Average / Median / P95 Latency, распределение по MIME-типам, топ-5 самых медленных URL и топ-5 самых крупных ответов.
   - Кнопка «Copy Markdown Report» для удобной вставки отчета в задачу или чат.

Критерии готовности:
- Статистика и таймлайн по 1 000+ сессий строятся плавно без блокировки интерфейса.
- `npm run typecheck` и `npm run build` проходят без ошибок.
```

---

## Этап 13: Расширенные протоколы: Upstream Proxy Chaining и WS-инъекция
**Приоритет: P2 (Feature) | Спринт 4 (Корпоративные сети и продвинутая отладка)**

### Описание задачи
1. **Upstream Proxy Chaining:** возможность направлять исходящий трафик FluxProxy через вышестоящий корпоративный или внешний прокси-сервер (`HTTP`, `HTTPS`, `SOCKS5` с поддержкой логина/пароля и списка исключений `localhost, *.internal`).
2. **Инъекция сообщений в активные WebSocket-соединения:** возможность вручную отправить произвольный текстовый или бинарный фрейм в открытый сокет (как в сторону сервера, так и в сторону клиента) прямо из вкладки `WS` инспектора.

### Критерии приемки
- Модальное окно / секция настроек `UpstreamProxyModal.tsx` с применением параметров в `reqwest::ClientBuilder` и CONNECT-туннелях (с поддержкой сохранения в профиле настроек без утечки секретов при экспорте по желанию пользователя).
- Панель «Send Frame» во вкладке `WS` инспектора для активных соединений с отправкой Text / JSON / Hex сообщений клиенту или серверу.

---

### 📝 Промпт для Antigravity (Этап 13)

```markdown
Роль: Principal Systems Architect & Protocol Specialist.
Проект: FluxProxy — кроссплатформенный отладочный веб-прокси (Tauri v2 + Rust + React 18).

Задача: Реализовать каскадирование через вышестоящий прокси (Upstream Proxy Chaining) и ручную отправку фреймов в активные WebSocket-соединения.

1. Upstream Proxy Chaining (`src-tauri/src/proxy/`, `src/components/UpstreamProxyModal.tsx`):
   - Поддержать маршрутизацию исходящих соединений через внешний HTTP / HTTPS / SOCKS5 прокси с опциональной Basic-авторизацией и списком обхода (`bypassList`, например `localhost, 127.0.0.1, *.local`).
   - Обновлять upstream-клиент и установку CONNECT-туннелей на лету через команду Tauri `set_upstream_proxy_config`.

2. Инъекция WebSocket-фреймов (`server.rs`, `InspectorProtocolPanels.tsx`):
   - Регистрировать активные открытые WebSocket-сессии в реестре каналов управления и удалять при закрытии соединения.
   - Добавить команду Tauri `inject_websocket_frame(session_id, direction, opcode, payload)` и компактную форму отправки сообщения (`Send to Server` / `Send to Client`) во вкладку `WS` инспектора.

Критерии готовности:
- Запросы успешно проходят через тестовый вышестоящий прокси, а домены из списка исключений идут напрямую.
- Отправленный из инспектора WS-фрейм доставляется адресату и отображается в ленте кадров сессии.
- `cargo test --manifest-path src-tauri/Cargo.toml` и `npm run build` проходят без ошибок.
```
