# ⚡ FluxProxy — Modern Cross-Platform Web Debugging Proxy

<div align="center">

[![Latest Release](https://img.shields.io/github/v/release/maq3000/flux-proxy?color=blue&logo=github)](https://github.com/maq3000/flux-proxy/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/maq3000/flux-proxy/total?color=success&logo=github)](https://github.com/maq3000/flux-proxy/releases)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2.2-blue?logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-2021_%281.80%2B%29-orange?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![React 18](https://img.shields.io/badge/React-18.3-61dafb?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3.4-38bdf8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Высокопроизводительный кроссплатформенный аналог Fiddler Classic, Charles Proxy и Proxyman**, созданный на базе **Tauri v2 (Rust)** и **React 18 (TypeScript)**.

Мгновенный запуск, умный контроль памяти, аппаратное ускорение интерфейса и стабильные 60 FPS при работе с десятками тысяч перехваченных запросов.

> 📥 **Скачать готовую сборку для Windows:** [**FluxProxy Setup v0.3.0 (.exe)**](https://github.com/maq3000/flux-proxy/releases/download/v0.3.0/FluxProxy_0.3.0_x64-setup.exe) или [**MSI-пакет (.msi)**](https://github.com/maq3000/flux-proxy/releases/download/v0.3.0/FluxProxy_0.3.0_x64_en-US.msi). Подробнее см. раздел [Скачать готовые сборки](#-скачать-готовые-сборки-releases).
>
> 📖 **Ищете понятную инструкцию по работе с программой?** Откройте [**Руководство пользователя (USER_GUIDE.md)**](USER_GUIDE.md) — пошаговое описание всех возможностей простым языком: от первого запуска и настройки телефона до подмены ответов и сравнения запросов.
>
> 🗺️ **План развития проекта и спецификации задач:** См. [**Дорожную карту проекта (ROADMAP.md)**](ROADMAP.md).

</div>

---

## 📋 Оглавление

- [📥 Скачать готовые сборки (Releases)](#-скачать-готовые-сборки-releases)
- [📖 Руководство пользователя (USER_GUIDE.md)](USER_GUIDE.md)
- [🗺️ Дорожная карта проекта (ROADMAP.md)](ROADMAP.md)
- [Особенности и возможности](#-особенности-и-возможности)
- [Архитектура и стек технологий](#-архитектура-и-стек-технологий)
- [Структура проекта](#-структура-проекта)
- [Быстрый старт](#-быстрый-старт)
  - [1. Режим UI Preview Simulator (без Rust)](#1-режим-ui-preview-simulator-без-rust)
  - [2. Полнофункциональный режим приложения (Tauri + Rust)](#2-полнофункциональный-режим-приложения-tauri--rust)
  - [3. Сборка релизного пакета](#3-сборка-релизного-пакета)
- [Настройка HTTPS MITM Decryption (Root CA)](#-настройка-https-mitm-decryption-root-ca)
- [Перехват трафика с мобильных устройств (iOS / Android)](#-перехват-трафика-с-мобильных-устройств-ios--android)
- [Горячие клавиши (Keyboard Shortcuts)](#-горячие-клавиши-keyboard-shortcuts)
- [Интеграция с CLI инструментами](#-интеграция-с-cli-инструментами)
- [Дорожная карта (Roadmap)](#-дорожная-карта-roadmap)
- [Разработка и Contributing](#-разработка-и-contributing)

---

## 📥 Скачать готовые сборки (Releases)

Для запуска FluxProxy на **Windows** вам не требуется компилировать проект из исходных кодов — вы можете скачать готовые официальные установщики из [**GitHub Releases v0.3.0**](https://github.com/maq3000/flux-proxy/releases/tag/v0.3.0):

| Дистрибутив | Версия | Архитектура | Описание | Ссылка на загрузку | Контрольная сумма (SHA-256) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Windows Setup (`.exe`)** | `v0.3.0` | x64 | **Рекомендуемый** автономный инсталлятор (NSIS). Автоматическое создание ярлыков на рабочем столе и в меню «Пуск», встроенный деинсталлятор. | [📥 **FluxProxy_0.3.0_x64-setup.exe** (9.1 МБ)](https://github.com/maq3000/flux-proxy/releases/download/v0.3.0/FluxProxy_0.3.0_x64-setup.exe) | `d717be130f6f8233e5d4c180c27552445329b57a70036c7bdfe7f5548b17f69a` |
| **Windows Package (`.msi`)** | `v0.3.0` | x64 | Пакет Windows Installer (MSI). Оптимизирован для тихой установки (`msiexec /i ... /qn`) и автоматизированного развертывания через Active Directory (GPO). | [📥 **FluxProxy_0.3.0_x64_en-US.msi** (11.8 МБ)](https://github.com/maq3000/flux-proxy/releases/download/v0.3.0/FluxProxy_0.3.0_x64_en-US.msi) | `f1b5129e3ce269ee4db1ab9a58b0573f2ac3a2d19b2a6d9ab2f20f67f905fa3a` |

> 📦 **Все релизы проекта:** [github.com/maq3000/flux-proxy/releases](https://github.com/maq3000/flux-proxy/releases)  
> 🐧 🍏 **macOS и Linux:** На текущем этапе сборка выполняется из исходного кода с помощью команды `npx @tauri-apps/cli build` (см. раздел [Быстрый старт](#-быстрый-старт)). Готовые дистрибутивы `.dmg` и `.AppImage` будут доступны в следующих релизах.

---

## ✨ Особенности и возможности

### 🚀 Сетевое ядро перехвата (Rust MITM Core)
- **HTTP/1.1 и HTTP/2**: Прозрачный перехват и мультиплексирование потоков с автоматическим выбором протокола (`hyper-util auto`).
- **Двухфазный захват сессий (In-Flight / Pending)**: Мгновенное появление запроса в таблице еще до ответа сервера (`Pending`) с реальной инспекцией исходящих данных и последующим обновлением статуса, таймингов и ответа.
- **Zero-Buffering видео/CDN-стриминг и надежность upstream**: Потоковая передача медиа, `206 Partial Content` и крупных ответов без буферизации, мгновенный сброс активных MITM-туннелей в Passthrough при изменении правил и диагностика сбоев с полной цепочкой причин (`err.source()`).
- **Расшифровка HTTPS на лету и Zstandard (`zstd`)**: Динамическая генерация X.509 сертификатов (ECDSA P-256) под целевые домены через `rcgen` с LRU-кэшированием (`moka`), а также прозрачная распаковка `Content-Encoding: zstd` (RFC 8878) на лету в прокси и Composer.
- **Избирательный перехват (Selective MITM & TLS Bypass)**: Режимы *Intercept All* и *Targeted Allowlist*, готовые пресеты (включая *Video & CDN*), пропускающие трафик приложений с жестким Certificate Pinning или крупные медиа-CDN через прямой TCP-туннель.
- **Блокировка обхода через HTTP/3 (QUIC)**: Автоматическое удаление заголовков `Alt-Svc` и `Alternate-Protocol`, предотвращающее уход современных браузеров в UDP-туннель мимо системного прокси.
- **Перехват WebSocket (WS/WSS) и SSE**: Инкрементальное декодирование кадров в реальном времени ($O(1)$ append без лишних аллокаций, `tokio-tungstenite`) с полной передачей заголовков авторизации и субпротоколов (включая SignalR).
- **Гибкая привязка к IP и адаптерам ОС (Dual Listener)**: Точный выбор сетевого интерфейса (*Loopback Only*, *All Interfaces `0.0.0.0`* или *Specific Interface* — Wi-Fi / Ethernet / WSL / VPN + опциональный одновременный loopback-листенер), неблокирующий Tokio-рантайм (`spawn_blocking` для OS/SQLite), предкомпиляция Regex, управление системным прокси и определение процессов/LAN-клиентов.

### 🛠 Инструменты анализа и модификации
- **Протокольные анализаторы в Session Inspector**:
  - Заголовки, Query-параметры, Cookies с флагами безопасности, предпросмотр изображений, виртуализированный **Hex Viewer** (`@tanstack/react-virtual`) и быстрое переключение вкладок активной панели клавишами **`Ctrl+1` … `Ctrl+6`**.
  - **JSON / XML Viewer** на базе **Monaco Editor** с подсветкой синтаксиса, поиском и форматированием.
  - **SSE & LLM Stream Inspector**: разбор потоков `text/event-stream` и сборка чанков ответов нейросетей (OpenAI, Anthropic, Gemini) в единый связный текст в один клик.
  - **gRPC & Protobuf Wire Decoder**: декодирование бинарных Protobuf-сообщений и проекция в JSON без `.proto`-файлов.
  - **Auth & Caching Inspectors**: аудит безопасности Basic/Bearer/JWT токенов и анализ HTTP-кэширования по RFC 9111.
  - **Multipart Form Inspector**: разбор `multipart/form-data` с мини-превью загружаемых изображений.
- **Эргономика таблицы и адаптивный интерфейс**:
  - Интерактивная сортировка всех 10 колонок таблицы (`ASC` / `DESC`), массовое выделение видимых сессий (`Ctrl+A`), автоподбор ширины колонок из контекстного меню шапки (**Auto-fit**), однострочный **Slim Toolbar (`Ctrl+Shift+T`)** и персистентность геометрии всех сплит-панелей и ориентации Инспектора между перезапусками.
- **Диагностический мастер «Proxy Doctor» (`Ctrl+Shift+D`)**:
  - Проверка сокета и конфликта порта, доверия Root CA, синхронизации системного прокси ОС, конфликтующих VPN/TUN-интерфейсов, брандмауэра Windows и сквозного пробника `http://flux.proxy/health` с 1-клик автоисправлением (**Fix All Fixable**).
- **Live Breakpoints (Точки останова, `F11` / `Alt+F11`)**:
  - Пауза до отправки запроса (*Before Request*) или после ответа сервера (*After Response*), условные ловушки по URL (`bpu` / `bpafter`), редактирование заголовков, статусов и тел на лету.
- **AutoResponder & Header Mutations**:
  - Мокирование ответов без правки бэкенда, переопределение HTTP-статусов и эмуляция сетевой задержки (Latency).
  - Автоматические мутации заголовков (*Force No-Cache*, *CORS Injection*, пресеты *User-Agent*).
- **HTTP Composer & Session Diff**:
  - Конструктор запросов с поддержкой **Drag-and-Drop** строк из таблицы и параллельным режимом (*Split Composer*).
  - Визуальное сравнение двух сессий (**Session Diff**, `Ctrl+D`) с сортировкой ключей JSON и фильтрацией динамических заголовков.
- **Text Wizard & Codec Suite (`Ctrl+E`)**:
  - Декодер JWT с проверкой срока жизни токена, конвертеры Base64, URL, Hex, Unix Timestamp и сжатие/распаковка Gzip / Brotli / Deflate / Zstd.

### 💾 Управление памятью, SQLite и профили настроек
- **Кольцевой буфер (Ring Buffer), SQLite и защита памяти**:
  - Ограничение числа хранимых сессий в стиле Fiddler (`Keep: All / 100..10 000 / Custom...`) с архивацией в SQLite (`busy_timeout` + автоматическая дочитка вытесненных тел).
  - Управление размером `sessions.sqlite`: индикатор `SQLite: X.X MB` в статус-баре, ручной `VACUUM` + `wal_checkpoint(TRUNCATE)` и опция *Clear DB on App Exit* в настройках.
  - Режим **Drop Non-Matching on Capture** — отбрасывание фонового шума на этапе захвата без расхода оперативной памяти.
  - Ленивая подгрузка тяжелых тел (> 2 МБ) с диска только при открытии в инспекторе.
- **Полная совместимость форматов и Sanitized Export (`Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+O`)**:
  - Экспорт и импорт индустриального стандарта **HAR 1.2 (`.har`)**, архивов **Fiddler Classic (`.saz`)**, **JSON**, сырых HTTP-сообщений (`.txt`) с защитой парсеров от ZIP-бомб и переполнения (включая UTF-16BE), а также выгрузка отдельных тел запросов и ответов в файлы.
  - **Sanitized Export (`Ctrl+Shift+S`)**: безопасная передача архивов `.har`, `.saz`, `.json` и `.txt` с настраиваемым маскированием секретных заголовков (`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`), рекурсивных ключей в JSON и `form-urlencoded`, query-параметров и опциональной анонимизацией IP/имени процесса клиента (пресеты *Safe Sharing*, *Strict Anonymization*, *Custom*).
  - Поддержка **Drag-and-Drop** файлов `.har`, `.saz` и `.json` прямо в окно программы.
- **Централизованные настройки, профили и единый старт (`Preferences`, `Ctrl+,`)**:
  - Единое окно управления интерфейсом, портом прокси (с сохранением стартового порта в `proxy_port.pref` без двойного запуска), колонками, фильтрами и правилами.
  - Версионированный экспорт и импорт профиля настроек (`fluxproxy-settings-v1.json`) с превью изменений перед применением, сохранением конфигурации точек останова (`breakpoints`), правил санитизации и ориентации сплит-панелей, а также транзакционным применением с откатом при сбое.

---

## 🏗 Архитектура и стек технологий

```text
┌─────────────────────────────────────────────────────────────┐
│                   React 18 Frontend UI                      │
│   (Vite, TypeScript, Tailwind CSS, Monaco Editor, Virtual)  │
└──────────────────────────────┬──────────────────────────────┘
                               │  Tauri IPC (Commands / Events)
┌──────────────────────────────▼──────────────────────────────┐
│                    Tauri v2 Desktop Core                    │
│   (lib.rs, commands.rs, models.rs, HAR/SAZ & SQLite Store)  │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                  Asynchronous MITM Engine                   │
│   ├── Hyper 1.x + Tokio (HTTP/1.1 & HTTP/2 Server/Client)   │
│   ├── Two-Phase In-Flight Capture, Zstd & Zero-Buffering    │
│   ├── Tokio-Rustls + rcgen + Moka (On-the-fly ECDSA CA)     │
│   ├── Selective MITM, Alt-Svc Strip & Capture-Stage Drop    │
│   ├── Tokio-Tungstenite (WebSocket / SignalR Interception)  │
│   ├── Breakpoints, AutoResponder & Header Mutation Engine   │
│   └── Dual-Bind Listener, SysProxy, SQLite & OS Resolver    │
└─────────────────────────────────────────────────────────────┘
```

| Компонент | Назначение | Используемые технологии |
| :--- | :--- | :--- |
| **Desktop Runtime** | Оконный менеджер, нативные диалоги, IPC, CSP | [Tauri v2](https://tauri.app/) (Rust 2021), `rfd` |
| **Сетевой движок** | Асинхронный HTTP/HTTPS сервер и клиент | `tokio`, `hyper 1.5`, `hyper-util`, `reqwest` |
| **TLS & Сертификаты** | MITM-расшифровка, управление доверием ОС | `rustls`, `tokio-rustls`, `rcgen`, `moka` |
| **WebSockets** | Перехват и разбор фреймов WS/WSS | `tokio-tungstenite` |
| **Хранилище и архивы** | Ring Buffer в RAM, база SQLite, экспорт HAR/SAZ | `DashMap` + `rusqlite` (WAL) + `zip` |
| **Кодеки и сжатие** | Сжатие/распаковка и кодировки | `flate2` (Gzip/Deflate), `brotli`, `zstd`, `base64`, `hex`, `sha2` |
| **Frontend UI** | Компонентный реактивный интерфейс | `React 18`, `TypeScript 5.6`, `Vite 6`, `Tailwind CSS` |
| **Виртуализация и код** | Скроллинг 60 FPS, редакторы и diff-сравнение | `@tanstack/react-virtual 3`, `@monaco-editor/react` |

---

## 📁 Структура проекта

```text
├── index.html                           # HTML точка входа Vite
├── package.json                         # Зависимости и npm-скрипты фронтенда
├── USER_GUIDE.md                        # Подробная инструкция для пользователей
├── ROADMAP.md                           # Дорожная карта развития проекта
│
├── src/                                 # Исходный код Frontend UI (React + TypeScript)
│   ├── components/                      # Компоненты интерфейса
│   │   ├── TrafficGrid.tsx              # Виртуализированная таблица с сортировкой колонок и контекстным меню
│   │   ├── SessionInspector.tsx         # Инспектор запросов/ответов с ленивой подгрузкой тел и шорткатами Ctrl+1..6
│   │   ├── HexViewer.tsx                # Виртуализированный шестнадцатеричный инспектор байтов
│   │   ├── InspectorProtocolPanels.tsx  # Панели SSE/LLM, gRPC/Protobuf, Auth, Cache, Multipart
│   │   ├── FilterDrawer.tsx             # Матрица фильтров, пороги шума, Selective TLS, мутации
│   │   ├── HostFiltersTab.tsx           # Пакетный фильтр хостов (Whitelist / Blacklist)
│   │   ├── ComposerPanel.tsx            # Конструктор и повторитель HTTP-запросов
│   │   ├── AutoResponderPanel.tsx       # Правила подмены ответов и эмуляции задержек
│   │   ├── BreakpointModal.tsx          # Перехватчик запросов и ответов на лету
│   │   ├── SessionDiffView.tsx          # Визуальное сравнение двух сессий
│   │   ├── SanitizedExportModal.tsx     # Экспорт сессий с очисткой PII и секретов (Ctrl+Shift+S)
│   │   ├── ProxyDoctorModal.tsx         # Диагностический мастер самопроверки и автоисправления (Ctrl+Shift+D)
│   │   ├── SettingsModal.tsx            # Централизованные настройки и профили (Ctrl+,)
│   │   ├── TextWizardModal.tsx          # Декодер JWT, Base64, URL, Hex, Gzip/Brotli/Zstd
│   │   ├── MobileSetupModal.tsx         # Мастер подключения iOS/Android по Wi-Fi с QR-кодом
│   │   ├── CertificateModal.tsx         # Установка, проверка и удаление Root CA
│   │   ├── CommandPalette.tsx           # Командная палитра и QuickExec (Ctrl+K)
│   │   ├── TopToolbar.tsx               # Панель управления, Slim Toolbar, поиска, лимита Keep и пресетов
│   │   └── MenuBar.tsx                  # Главное меню приложения
│   ├── hooks/                           # Хуки управления сессиями, темой и раскладкой UI
│   ├── lib/                             # Движок фильтров, парсеры протоколов, менеджер настроек, IPC-мост
│   └── types/                           # TypeScript-интерфейсы сессий, правил и схемы настроек
│
└── src-tauri/                           # Исходный код Core & MITM Proxy (Rust)
    ├── Cargo.toml                       # Rust-зависимости и метаданные
    ├── tauri.conf.json                  # Конфигурация Tauri v2 и политики безопасности CSP
    └── src/
        ├── main.rs / lib.rs             # Точка входа приложения и регистрация IPC-команд
        ├── commands.rs                  # Команды Tauri для взаимодействия с UI
        ├── models.rs                    # Модели данных сессий, фильтров, санитизации, кодеков и статистики
        ├── proxy/                       # Асинхронное ядро MITM-прокси
        │   ├── server.rs                # HTTP/1.1, HTTP/2, HTTPS, WS прокси и портал flux.proxy (/health)
        │   ├── doctor.rs                # Самодиагностика порта, Root CA, SysProxy, VPN, Firewall и /health
        │   ├── ca.rs                    # Генерация Root CA, сертификатов доменов и управление хранилищем ОС
        │   ├── filters.rs               # Selective TLS, стриппинг Alt-Svc, мутации заголовков, capture-drop
        │   ├── breakpoints.rs           # Менеджер живых точек останова
        │   ├── rules.rs                 # Движок правил AutoResponder
        │   ├── codec.rs                 # Сжатие/распаковка и преобразования данных для TextWizard
        │   ├── sysproxy.rs              # Автонастройка системного прокси (Windows / macOS / Linux)
        │   ├── process.rs               # Определение PID и имени процесса-источника
        │   └── network.rs               # Сетевые интерфейсы и определение LAN IP
        └── storage/                     # Хранение и обмен данными
            ├── mod.rs                   # Потокобезопасный Ring Buffer и оффлоадинг тяжелых тел
            ├── sqlite.rs                # Архивация и чтение сессий из SQLite (WAL)
            └── export_import.rs         # Экспорт/импорт и санитизация HAR 1.2, Fiddler SAZ, JSON и Raw HTTP
```

---

## 🚀 Быстрый старт

### Требования к окружению
- **Node.js**: версии `18.x` или новее.
- **Rust**: версия `1.80+` (устанавливается через [rustup.rs](https://rustup.rs/)).
- **Системные пакеты для сборки Tauri**:
  - **Windows**: Microsoft C++ Build Tools (пакет *Desktop development with C++*) и WebView2.
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`).
  - **Linux**: `build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev`, `libgtk-3-dev`.

---

### 1. Режим UI Preview Simulator (без Rust)
Если вы хотите быстро посмотреть интерфейс или поработать над фронтендом без компиляции Rust-ядра:

```bash
# Клонируйте репозиторий
git clone https://github.com/<ваш-логин>/flux-proxy.git
cd flux-proxy

# Установите зависимости
npm install

# Запустите симулятор в браузере
npm run dev
```

Откройте `http://localhost:5173`. В режиме симулятора работают все панели, фильтры, инспекторы, настройки и импорт/экспорт файлов. Нажмите `Ctrl+K` → **«Generate +10,000 Test Sessions»**, чтобы протестировать скорость таблицы под высокой нагрузкой.

---

### 2. Полнофункциональный режим приложения (Tauri + Rust)
Запуск нативного десктопного приложения с реальным перехватом трафика на `127.0.0.1:8888` (порт можно изменить в `Ctrl+,`):

```bash
npx @tauri-apps/cli dev
```

При запуске:
1. Прокси-сервер стартует автоматически на выбранном порту (по умолчанию `8888`).
2. Управлять захватом трафика можно кнопкой в левом верхнем углу тулбара или клавишей `F12`.

---

### 3. Сборка релизного пакета

Для сборки оптимизированного установщика под вашу ОС (`.exe` / `.msi` на Windows, `.dmg` / `.app` на macOS, `.deb` / `.AppImage` на Linux):

```bash
npx @tauri-apps/cli build
```

Готовые установочные файлы появятся в каталоге `src-tauri/target/release/bundle/`.

---

## 🔒 Настройка HTTPS MITM Decryption (Root CA)

Чтобы расшифровывать защищенный HTTPS-трафик без предупреждений браузера, установите локальный корневой сертификат FluxProxy:

1. В верхнем меню выберите **Tools → HTTPS Root CA Certificate…** (или нажмите на кнопку сертификата на панели инструментов).
2. В окне отобразится текущий статус доверия в вашей ОС и отпечаток SHA-256. Нажмите **Trust Root CA in OS Store**:
   - **Windows**: сертификат добавится в хранилище *«Доверенные корневые центры сертификации»* текущего пользователя.
   - **macOS**: сертификат добавится в связку ключей *System Keychain* с доверием SSL.
   - **Linux**: сертификат скопируется в системное хранилище с обновлением `update-ca-certificates`.
3. Для браузеров со своим изолированным хранилищем (например, **Mozilla Firefox**) скопируйте путь к файлу сертификата из этого же окна и импортируйте его в настройках браузера (*Настройки → Приватность и защита → Сертификаты → Просмотр сертификатов → Импортировать*).
4. Когда отладка завершена и вы хотите полностью убрать сертификат из системы, в том же окне нажмите **«Удалить сертификат из доверенных ОС»**.

---

## 📱 Перехват трафика с мобильных устройств (iOS / Android)

FluxProxy умеет перехватывать трафик со смартфонов и планшетов в вашей локальной Wi-Fi сети:

1. Откройте **Tools → Connect Mobile Device (iOS / Android)…** (или нажмите `Ctrl+Shift+M`).
2. Выберите конкретный Wi-Fi/LAN-адаптер в режиме **Specific Interface** (с опцией **Dual Listener** в **Settings → Rules & Proxy**) либо включите режим внешних подключений (`0.0.0.0`) — программа покажет ваш IP-адрес, порт и **QR-код**.
3. В настройках Wi-Fi на телефоне укажите ручной прокси с IP вашего компьютера и портом `8888`.
4. Отсканируйте QR-код камерой телефона (или откройте `http://flux.proxy` в мобильном браузере), скачайте профиль сертификата и включите доверие к нему по пошаговой подсказке на экране.

---

## ⌨️ Горячие клавиши (Keyboard Shortcuts)

Полный список шорткатов всегда доступен внутри приложения по клавише `?`.

| Сочетание клавиш | Описание действия |
| :--- | :--- |
| `Ctrl+K` / `Cmd+K` | Открыть командную палитру (**Command Palette** и команды `bpu` / `bpafter`) |
| `Ctrl+,` / `Cmd+,` | Открыть окно настроек и профилей (**Preferences**) |
| `F12` | Включить / приостановить захват трафика (**Capture**) |
| `Ctrl+S` / `Cmd+S` | Сохранить все сессии в архив (`.har`, `.saz`, `.json`) |
| `Ctrl+Shift+S` | Безопасный экспорт с маскированием токенов и PII (**Export Sanitized Sessions…**) |
| `Ctrl+O` / `Cmd+O` | Открыть / импортировать архив сессий (`.har`, `.saz`, `.json`) |
| `Ctrl+F` / `Cmd+F` | Фокус на поле быстрого поиска и фильтрации |
| `F11` / `Alt+F11` | Перехват на лету: **Break Before Request** / **Break After Response** |
| `Shift+F11` | Снять все активные точки останова |
| `R` / `Ctrl+R` | **Replay** — повторить выбранный запрос на сервер |
| `Ctrl+D` / `Cmd+D` | Открыть визуальное сравнение двух сессий (**Session Diff**) |
| `Ctrl+E` / `Cmd+E` | Открыть **Text Wizard & JWT Decoder** |
| `Ctrl+Shift+M` | Мастер подключения мобильных устройств (**Mobile Setup**) |
| `Ctrl+Shift+D` | Запустить диагностический мастер самопроверки (**Proxy Doctor**) |
| `Ctrl+Shift+T` | Переключить однострочный компактный тулбар (**Slim / Compact Toolbar**) |
| `Ctrl+A` / `Cmd+A` | Выделить все видимые сессии в таблице |
| `M` / `U` | Добавить комментарий и цветовую метку (`M`) / снять метку (`U`) |
| `Space` / `Enter` | Открыть **Session Inspector** и переключить фокус между таблицей и инспектором |
| `Ctrl+1` … `Ctrl+6` | Переключение вкладок активной панели **Session Inspector** (*Headers*, *JSON/Raw*, *Cookies/Params*, *Auth*, *Raw*, *Hex*) |
| `Delete` / `Backspace` | Удалить выбранные сессии из таблицы |
| `Ctrl+X` / `Cmd+X` | Полностью очистить список сессий (**Clear All**) |
| `Ctrl+C` / `Cmd+C` | Скопировать URL выбранных сессий |
| `Ctrl+B` / `Cmd+B` | Показать / скрыть боковую панель навигации (**Sidebar**) |
| `Alt+1` … `Alt+4` | Переключение разделов: *Traffic*, *Composer*, *AutoResponder*, *Filter Matrix* |
| `?` | Показать справку по всем горячим клавишам |

---

## 💻 Интеграция с CLI инструментами

Чтобы направить трафик консольных утилит (`curl`, `git`, `npm`, `python`, `node`) через FluxProxy, задайте переменные окружения в терминале (готовую строку с вашим текущим портом можно скопировать в один клик через меню **Help → Copy CLI HTTP_PROXY Snippet**):

### Windows (PowerShell)
```powershell
$env:HTTP_PROXY="http://127.0.0.1:8888"
$env:HTTPS_PROXY="http://127.0.0.1:8888"
```

### macOS / Linux (Bash, Zsh)
```bash
export HTTP_PROXY="http://127.0.0.1:8888"
export HTTPS_PROXY="http://127.0.0.1:8888"
```

### Пример проверки через cURL
```bash
curl -x http://127.0.0.1:8888 https://httpbin.org/get -k
```

---

## 🗺️ Дорожная карта (Roadmap)

Детальный план развития проекта, матрица приоритетов и технические спецификации находятся в файле [**ROADMAP.md**](ROADMAP.md).

### Уже реализовано:
- ✅ Кроссплатформенная отладка iOS / Android с порталом `http://flux.proxy`, `.mobileconfig` и QR-кодами.
- ✅ Пакетные списки хостов (Whitelist / Blacklist), матрица фильтров и совместимость с WebSocket / SignalR.
- ✅ Блокировка обхода HTTP/3 (`Alt-Svc`), управление доверием Root CA (установка/удаление) и строгая политика CSP.
- ✅ Кольцевой буфер памяти (Ring Buffer `Keep`), фильтрация при захвате (*Drop Non-Matching*) и ленивая подгрузка тяжелых тел.
- ✅ Полная поддержка архивов **HAR 1.2** и **Fiddler SAZ** (экспорт, импорт, Drag-and-Drop), защита парсеров от ZIP-бомб/переполнения и выгрузка сырых тел.
- ✅ Централизованное окно настроек (`Preferences`) и версионированные JSON-профили конфигурации.
- ✅ **Двухфазный захват сессий (In-Flight / `Pending`)**, zero-buffering стриминг видео/`206`, сброс активных MITM-туннелей в Passthrough и диагностика сетевых сбоев (`err.source()`).
- ✅ Прозрачная распаковка сжатия **Zstandard (`zstd`, RFC 8878)** на лету (прокси-ядро, Composer, Text Wizard).
- ✅ **Привязка к конкретному IP / сетевому интерфейсу** (Wi-Fi/Ethernet/WSL/VPN) и режим **Dual Listener** (loopback + выбранный адаптер).
- ✅ Управление хранилищем SQLite (`VACUUM` + `wal_checkpoint(TRUNCATE)`, *Clear DB on App Exit*), неблокирующий Tokio-рантайм (`spawn_blocking`), предкомпиляция Regex и $O(1)$ SSE/WebSocket-стриминг.
- ✅ Сортировка всех колонок таблицы (`ASC`/`DESC`), `Ctrl+A`, автоподбор ширины колонок (`Auto-fit`), персистентность геометрии сплитов, однострочный **Slim Toolbar (`Ctrl+Shift+T`)**, шорткаты вкладок `Ctrl+1..6`, виртуализация `HexViewer` и `manualChunks` в Vite.
- ✅ Очистка и маскирование PII/секретов при экспорте (**Sanitized Export**, `Ctrl+Shift+S`) для `.har`, `.saz`, `.json` и Raw HTTP.
- ✅ Диагностический мастер самопроверки и 1-клик починки **«Proxy Doctor» (`Ctrl+Shift+D`)**, единая точка старта порта (`proxy_port.pref`) и транзакционное применение профилей настроек с поддержкой `breakpoints`.

### Ближайшие этапы разработки:
- 🔜 **P1** — Продвинутые темы-пресеты и палитра, **Selective MITM 2.0**, клиентские сертификаты (**mTLS**), **Python Scripting Engine**, **Composer 2.0** («Paste cURL» и кодогенератор), генератор **OpenAPI 3.0 / Swagger** и тесты **Vitest & CI/CD**.
- 🔜 **P2** — **HOSTS Remapping** (виртуальный DNS), **Bandwidth Throttling** (эмуляция 3G/LTE), архитектурная декомпозиция + **Zustand**, **Waterfall Timeline**, статистика трафика, **Upstream Proxy** и ручная отправка WebSocket-сообщений.

---

## 🤝 Разработка и Contributing

1. Сделайте Fork репозитория и создайте ветку (`git checkout -b feature/my-feature`).
2. Внесите изменения и убедитесь, что сборка и тесты проходят чисто:
   ```bash
   npm run typecheck
   npm run build
   cargo test --manifest-path src-tauri/Cargo.toml
   ```
3. Сделайте коммит и откройте **Pull Request**.

---

## 📄 Лицензия

Проект распространяется под свободной лицензией **MIT**. Подробности см. в файле [LICENSE](LICENSE).
