# FluxProxy — Modern Cross-Platform Web Debugging Proxy

Высокопроизводительный кроссплатформенный аналог **Fiddler Classic / Proxyman / Charles Proxy**, написанный на **Tauri v2 (Rust)** + **React 18 (TypeScript)**.

## Технологический стек

- **Core / Desktop Runtime**: Tauri v2 (`Rust 2021`)
- **MITM Proxy Engine**: `tokio`, `hyper 1.x`, `hyper-util` (`auto` HTTP/1.1 + HTTP/2), `tokio-rustls` (`ring`), `rcgen` (ECDSA P-256 генерация сертификатов на лету + кэш `moka`), `tokio-tungstenite` (перехват фреймов `ws://` / `wss://`), `reqwest` (`.no_proxy()` защита от рекурсии)
- **Хранилище сессий**: Lock-free `DashMap` (In-Memory) + `rusqlite` (`bundled`, `WAL` mode) для сохранения/загрузки дампов
- **Frontend UI**: React 18, TypeScript, Vite, Tailwind CSS, `@tanstack/react-virtual` (60 FPS при 10,000+ сессиях), `react-resizable-panels`, `@monaco-editor/react`, нативный `<dialog>` Command Palette (`Ctrl+K` / `Cmd+K`)

## Быстрый старт

### 1. Мгновенный запуск UI (Browser Preview Simulator)
Даже без установленного Rust-тулчейна можно запустить полноценный интерактивный интерфейс со стримингом трафика, стресс-тестом на **10,000+ сессий** (`Ctrl+K` → `Generate +10,000 Sessions`), Drag-and-Drop в **Composer** и движком **AutoResponder**:

```bash
npm install
npm run dev
```

### 2. Полный нативный режим (Tauri + Rust MITM Proxy на `127.0.0.1:8888`)
Установите [Rustup](https://rustup.rs/) (на Windows также требуется Build Tools C++), затем выполните:

```bash
npx @tauri-apps/cli dev
```

Для расшифровки HTTPS/2 и WSS трафика откройте **HTTPS MITM Root CA** (иконка щита слева снизу или через `Ctrl+K`) и нажмите **Trust Root CA in OS Store**.
