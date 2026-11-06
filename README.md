# ⚡ FluxProxy — Modern Cross-Platform Web Debugging Proxy

<div align="center">

[![Tauri v2](https://img.shields.io/badge/Tauri-v2.2-blue?logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-2021_%281.80%2B%29-orange?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![React 18](https://img.shields.io/badge/React-18.3-61dafb?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3.4-38bdf8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Высокопроизводительный кроссплатформенный аналог Fiddler Classic, Charles Proxy и Proxyman**, созданный на базе **Tauri v2 (Rust)** и **React 18 (TypeScript)**. 

Мгновенный запуск, минимальное потребление оперативной памяти, аппаратное ускорение рендеринга и стабильные 60 FPS при работе с десятками тысяч перехваченных сессий.

</div>

---

## 📋 Оглавление

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
- [Разработка и Contributing](#-разработка-и-contributing)

---

## ✨ Особенности и возможности

### 🚀 Ядро перехвата трафика (Rust MITM Core)
- **HTTP/1.1 и HTTP/2**: Прозрачный перехват и мультиплексирование потоков с автоматическим выбором протокола (`hyper-util auto`).
- **Расшифровка HTTPS на лету**: Динамическая генерация X.509 сертификатов (ECDSA P-256) под целевые домены через `rcgen` с LRU-кэшированием в оперативной памяти (`moka`).
- **Перехват WebSocket (WS/WSS)**: Декодирование и инспекция фреймов в реальном времени (`tokio-tungstenite`) с направлением, опкодами и payload.
- **Управление системным прокси**: Автоматическое включение и гарантированный сброс настроек системного прокси (`sysproxy`) в Windows, macOS и Linux при старте и завершении программы.
- **Привязка к процессам ОС**: Автоматическое определение процесса-источника (PID, имя процесса, путь к исполняемому файлу) для каждого соединения.
- **Защита от зацикливания**: Встроенная защита upstream-клиента (`.no_proxy()`) от рекурсивного перехвата собственного трафика.

### 🛠 Инструменты анализа и модификации
- **Live Breakpoints (Точки останова)**:
  - Пауза до отправки запроса на сервер (*Before Request*) с редактированием метода, URL, заголовков и тела.
  - Пауза после получения ответа (*After Response*) с подменой статус-кода, заголовков и payload до того, как ответ дойдет до клиента.
- **AutoResponder (Правила подмены и мокирования)**:
  - Гибкие условия совпадения: `Exact`, `Regex`, `Contains`, `Wildcard`.
  - Действия: возврат кастомного статуса, эмуляция задержки (Latency), ответ статическим файлом, возврат заранее заготовленного JSON/XML.
- **HTTP Composer**:
  - Полнофункциональный конструктор запросов.
  - Поддержка **Drag-and-Drop** сессий из таблицы прямо в Composer для быстрого редактирования и повторной отправки (*Replay*).
- **Session Diff**:
  - Интерактивное сравнение двух выбранных сессий (Side-by-Side и Inline) с подсветкой различий в заголовках, телах и статусах.
- **Text Wizard & JWT Decoder (`Ctrl+E`)**:
  - Быстрое кодирование и декодирование: Base64, URL-encoding, Hex, MD5, SHA-256, Gzip, Deflate.
  - Встроенный визуализатор и декодер JSON Web Token (Header / Payload / Signature).

### 🖥 Интерфейс пользователя (React 18 + Tailwind)
- **Виртуализированная таблица сессий**: Построена на `@tanstack/react-virtual` — плавный скролл 60 FPS даже при **10,000+** активных сессиях.
- **Многофункциональный инспектор**:
  - Просмотр заголовков, Query-параметров, Cookies.
  - Древовидный интерактивный JSON Viewer и встроенный редактор с подсветкой кода (**Monaco Editor**).
  - Полноценный Hex Viewer с ASCII-дампом для бинарных протоколов.
  - Просмотр Server-Sent Events (SSE) и стриминговых ответов.
- **Продвинутая фильтрация**:
  - Быстрый поиск и поддержка Regex (`Ctrl+F`).
  - Фильтры по хостам (*Target Hosts / Whitelist / Blacklist*).
  - Быстрые пресеты: All, XHR/Fetch, JS, CSS, Images, Media, WebSockets.
  - Фильтрация по статусам ответов (2xx, 3xx, 4xx, 5xx) и процессам.
- **Command Palette (`Ctrl+K` / `Cmd+K`)**: Быстрый доступ ко всем действиям, генераторам стресс-тестов и переключению настроек.
- **Персистентность и экспорт**:
  - Сохранение и загрузка базы сессий через встроенный SQLite (`rusqlite` в режиме WAL).
  - Экспорт выбранного запроса в команду `cURL` в один клик.
  - Цветовая маркировка и текстовые комментарии к сессиям.

---

## 🏗 Архитектура и стек технологий

```
┌─────────────────────────────────────────────────────────────┐
│                   React 18 Frontend UI                      │
│   (Vite, TypeScript, Tailwind CSS, Monaco Editor, Virtual)  │
└──────────────────────────────┬──────────────────────────────┘
                               │  Tauri IPC (Commands / Events)
┌──────────────────────────────▼──────────────────────────────┐
│                    Tauri v2 Desktop Core                    │
│      (lib.rs, commands.rs, models.rs, sqlite storage)       │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                  Asynchronous MITM Engine                   │
│   ├── Hyper 1.x + Tokio (HTTP/1.1 & HTTP/2 Server/Client)   │
│   ├── Tokio-Rustls + rcgen + Moka (On-the-fly ECDSA CA)     │
│   ├── Tokio-Tungstenite (WebSocket Interception)            │
│   ├── Breakpoints & Rules Engine (Live Pause & Modify)      │
│   ├── SysProxy Controller (OS Proxy Auto-Configuration)     │
│   └── Process Resolver (PID / App Path Identification)      │
└─────────────────────────────────────────────────────────────┘
```

| Компонент | Назначение | Используемые технологии |
| :--- | :--- | :--- |
| **Desktop Runtime** | Оконный менеджер, нативный биндинг, IPC | [Tauri v2](https://tauri.app/) (Rust 2021) |
| **Сетевой движок** | Асинхронный HTTP/HTTPS сервер и клиент | `tokio`, `hyper 1.5`, `hyper-util`, `reqwest` |
| **TLS & Сертификаты** | MITM расшифровка, генерация сертификатов | `rustls`, `tokio-rustls`, `rcgen`, `moka` |
| **WebSockets** | Перехват фреймов WS/WSS | `tokio-tungstenite` |
| **Хранилище сессий** | Быстрый in-memory кэш и дампы на диск | `DashMap` (lock-free) + `rusqlite` (bundled, WAL) |
| **Frontend UI** | Компонентный интерфейс | `React 18`, `TypeScript`, `Vite 6`, `Tailwind CSS` |
| **Виртуализация** | Высокопроизводительный скроллинг грида | `@tanstack/react-virtual 3` |
| **Редактор кода** | Подсветка синтаксиса JSON, XML, HTML | `@monaco-editor/react` |
| **Layout** | Изменяемые сплит-панели | `react-resizable-panels` |

---

## 📁 Структура проекта

```text
├── index.html                  # HTML точка входа Vite
├── package.json                # Зависимости и npm-скрипты фронтенда
├── vite.config.ts              # Конфигурация сборщика Vite
├── tailwind.config.js          # Конфигурация стилей Tailwind CSS
│
├── src/                        # Исходный код Frontend UI (React + TypeScript)
│   ├── components/             # React-компоненты
│   │   ├── TrafficGrid.tsx     # Виртуализированная таблица сессий
│   │   ├── SessionInspector.tsx# Инспектор запросов/ответов (Headers, JSON, Raw)
│   │   ├── ComposerPanel.tsx   # Конструктор и повторитель HTTP-запросов
│   │   ├── AutoResponderPanel.tsx # Панель правил подмены и моков
│   │   ├── BreakpointModal.tsx # Окно перехвата запросов/ответов на лету
│   │   ├── SessionDiffView.tsx # Сравнение двух сессий
│   │   ├── TextWizardModal.tsx # Конвертер/декодер (Base64, URL, Hex, JWT)
│   │   ├── MobileSetupModal.tsx# Настройка подключения iOS/Android устройств
│   │   ├── CommandPalette.tsx  # Командная строка быстрого вызова (Ctrl+K)
│   │   ├── TopToolbar.tsx      # Верхняя панель быстрого управления
│   │   └── MenuBar.tsx         # Главное меню приложения
│   ├── hooks/                  # Пользовательские хуки (сессии, темы, настройки)
│   ├── lib/                    # Клиентские утилиты, IPC-мост, мок-генератор
│   └── types/                  # TypeScript-интерфейсы и типы данных
│
└── src-tauri/                  # Исходный код Core & MITM Proxy (Rust)
    ├── Cargo.toml              # Rust зависимости и метаданные проекта
    ├── tauri.conf.json         # Конфигурация сборки и окон Tauri v2
    └── src/
        ├── main.rs / lib.rs    # Точка входа приложения и регистрация IPC
        ├── commands.rs         # Tauri IPC команды для вызова из интерфейса
        ├── models.rs           # Структуры данных (Session, Breakpoint, Rule)
        ├── proxy/              # Ядро MITM-прокси
        │   ├── server.rs       # HTTP/HTTPS/WS прокси-сервер на Hyper + Tokio
        │   ├── ca.rs           # Генерация Root CA и сертификатов доменов
        │   ├── sysproxy.rs     # Управление системным прокси ОС (Win/macOS/Linux)
        │   ├── breakpoints.rs  # Движок перехвата и паузы соединений
        │   ├── rules.rs        # Движок правил AutoResponder
        │   ├── filters.rs      # Бэкенд-фильтрация трафика
        │   ├── process.rs      # Распознавание PID и имени приложения
        │   └── network.rs      # Сетевые интерфейсы и локальные IP-адреса
        └── storage/            # Персистентное хранилище (SQLite)
```

---

## 🚀 Быстрый старт

### Требования к окружению
- **Node.js**: версии `18.x` или новее.
- **Rust**: версия `1.80+` (устанавливается через [rustup.rs](https://rustup.rs/)).
- **C++ Build Tools**:
  - **Windows**: Microsoft C++ Build Tools (или Visual Studio с пакетом *Desktop development with C++*).
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`).
  - **Linux**: `build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev`, `libgtk-3-dev`.

---

### 1. Режим UI Preview Simulator (без Rust)
Если вам нужно быстро протестировать или доработать интерфейс без компиляции Rust:

```bash
# Клонируйте репозиторий
git clone https://github.com/<ваш-логин>/flux-proxy.git
cd flux-proxy

# Установите зависимости
npm install

# Запустите симулятор в браузере
npm run dev
```

В браузере откроется симулятор на `http://localhost:5173`. Нажмите `Ctrl+K` → **"Generate +1,000 Demo Sessions"** (или стресс-тест на **+10,000 сессий**), чтобы протестировать фильтрацию, инспектор и виртуализированный скроллинг.

---

### 2. Полнофункциональный режим приложения (Tauri + Rust)
Запуск полноценного десктопного приложения с активным MITM-прокси на `127.0.0.1:8888`:

```bash
# Запуск в режиме разработки с Hot Reload для UI и компиляцией Rust
npx @tauri-apps/cli dev
```

При первом запуске:
1. FluxProxy автоматически запустит прокси-сервер на порту `8888`.
2. Включите перехват системного трафика кнопкой **Capture** в тулбаре или нажмите `F12`.

---

### 3. Сборка релизного пакета

Для компиляции оптимизированного автономного установщика (`.exe` / `.msi` на Windows, `.dmg` / `.app` на macOS, `.deb` / `.AppImage` на Linux):

```bash
npx @tauri-apps/cli build
```

Собранные бинарные файлы будут находиться в каталоге `src-tauri/target/release/bundle/`.

---

## 🔒 Настройка HTTPS MITM Decryption (Root CA)

Для того чтобы расшифровывать защищенный трафик (HTTPS/TLS) без предупреждений браузера о недоверенном сертификате, необходимо один раз установить корневой сертификат FluxProxy:

1. Откройте FluxProxy.
2. Нажмите на иконку **щита с замком** в левом нижнем углу статус-бара (или нажмите `Ctrl+K` → *"Install Root CA into OS Trust Store"*).
3. В открывшемся окне нажмите **Trust Root CA in OS Store**:
   - **Windows**: Сертификат автоматически добавится в хранилище *«Доверенные корневые центры сертификации»* текущего пользователя.
   - **macOS**: Сертификат будет добавлен в системную связку ключей *System Keychain* с доверием SSL.
   - **Linux**: Сертификат скопируется в `/usr/local/share/ca-certificates/` с вызовом `update-ca-certificates`.
4. Также вы можете скачать файл `ca.crt` / `ca.pem` вручную для установки в браузеры с собственной базой сертификатов (например, Mozilla Firefox) или на эмуляторы.

---

## 📱 Перехват трафика с мобильных устройств (iOS / Android)

FluxProxy позволяет перехватывать и отлаживать HTTP/HTTPS запросы с мобильных телефонов и планшетов, находящихся в одной Wi-Fi сети:

1. В меню выберите **Tools → Connect Mobile Device** (или нажмите `Ctrl+Shift+M`).
2. В появившемся окне отобразится:
   - Ваш локальный IP-адрес в Wi-Fi сети (например, `192.168.1.45`) и порт (`8888`).
   - QR-код для быстрого скачивания Root CA сертификата на мобильное устройство.
3. **На смартфоне**:
   - В свойствах вашей Wi-Fi сети укажите ручной HTTP-прокси: IP вашего компьютера и порт `8888`.
   - Откройте браузер на смартфоне и перейдите по ссылке из окна (или отсканируйте QR-код) для загрузки профиля сертификата.
   - Установите сертификат в настройках телефона и разрешите полное доверие корневому сертификату (*В iOS: Настройки → Основные → Об этом устройстве → Доверие сертификатам*).

---

## ⌨️ Горячие клавиши (Keyboard Shortcuts)

| Сочетание клавиш | Описание действия |
| :--- | :--- |
| `Ctrl+K` / `Cmd+K` | Открыть палитру команд (**Command Palette**) |
| `F12` | Включить / приостановить перехват трафика (**Capture**) |
| `Ctrl+F` | Фокус на поле быстрого поиска и фильтрации |
| `F11` | Включить / выключить перехват **Break Before Request** |
| `Alt+F11` | Включить / выключить перехват **Break After Response** |
| `Shift+F11` | Снять все активные точки останова |
| `R` / `Ctrl+R` | **Replay** — повторить выбранный запрос в upstream |
| `Ctrl+D` | Открыть окно сравнения двух сессий (**Session Diff**) |
| `Ctrl+E` | Открыть **Text Wizard & JWT Decoder** |
| `Ctrl+Shift+M` | Открыть мастер подключения мобильных устройств (**Mobile Setup**) |
| `M` | Добавить комментарий или цветовую метку к сессии |
| `U` | Снять цветовую метку с выделенных сессий |
| `Delete` / `Backspace` | Удалить выбранные сессии из таблицы |
| `Ctrl+X` / `Cmd+X` | Полностью очистить список сессий (**Clear All**) |
| `Ctrl+C` | Скопировать URL выбранной сессии |
| `Ctrl+B` | Свернуть / развернуть боковую панель (**Sidebar**) |
| `↑` / `↓` / `Shift+↑/↓` | Навигация и множественное выделение строк |

---

## 💻 Интеграция с CLI инструментами

Для направления консольного трафика (curl, git, npm, python и др.) через FluxProxy используйте стандартные переменные окружения:

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

### Пример проверки через cURL (с флагом доверия к локальному CA):
```bash
curl -x http://127.0.0.1:8888 https://httpbin.org/get -k
```

*(Или скопируйте любую сессию из контекстного меню FluxProxy: **Right Click → Copy → Copy as cURL**).*

---

## 🤝 Разработка и Contributing

Будем рады вашему участию в развитии проекта!

1. Сделайте Fork репозитория.
2. Создайте функциональную ветку (`git checkout -b feature/amazing-feature`).
3. Сделайте коммит ваших изменений (`git commit -m 'feat: add amazing new feature'`).
4. Отправьте ветку в удаленный репозиторий (`git push origin feature/amazing-feature`).
5. Откройте **Pull Request**.

Перед отправкой изменений рекомендуется выполнить проверку типов и кода:
```bash
npm run typecheck
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## 📄 Лицензия

Проект распространяется под свободной лицензией **MIT**. Подробности в файле [LICENSE](LICENSE).
