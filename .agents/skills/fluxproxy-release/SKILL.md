---
name: fluxproxy-release
description: >-
  Executes the end-to-end release workflow for FluxProxy (Tauri v2 + Rust + React/Vite):
  pre-release audit and auxiliary fixes, dependency freshness and security audit/updates
  (npm/Cargo), version synchronization across JS/Rust/Tauri manifests, CI-equivalent quality
  checks (npm audit, typecheck, Vitest, Vite build, clippy, cargo test), release installer
  builds (.exe/.msi) with SHA-256 calculation, updating README.md, ROADMAP.md, and USER_GUIDE.md,
  creating the release commit and annotated git tag, pushing to Git, and publishing builds to
  GitHub Releases. Use when the user asks to release a new version, prepare/cut a release, build
  release installers, or publish a FluxProxy release (e.g., "выпусти релиз", "собери релиз
  v0.4.0", "подготовь релиз", "cut release"). Do not use for regular feature commits, bug fixes,
  or dev builds.
---

# FluxProxy Release Runbook

Полный регламент подготовки, сборки, документирования и публикации нового релиза **FluxProxy**.

## Входные параметры

- **Целевая версия:** `vX.Y.Z` (например, `v0.4.0`).
- Если пользователь не указал номер версии явно, определи новую версию `X.Y.Z` по **SemVer** на основе истории коммитов с последнего релизного тега (`git describe --tags --abbrev=0`).

---

## Строгий порядок выполнения

Выполняй этапы последовательно. Если на этапе проверок или сборки возникают ошибки — сначала устрани их, и только потом переходи к следующим шагам. Детальные шаблоны и карта файлов вынесены в [references/release-checklist.md](./references/release-checklist.md).

### 1. Аудит изменений и сопутствующие доработки

1. Проверь состояние репозитория:
   ```powershell
   git status --short
   git branch --show-current
   $lastTag = git describe --tags --abbrev=0
   git log "$lastTag..HEAD" --stat
   ```
   Убедись, что работа ведётся в `main` и в рабочем дереве нет посторонних незавершённых изменений.
2. Определи целевую версию `X.Y.Z`.
3. Выполни предрелизный аудит кодовой базы:
   - Найди все упоминания предыдущей версии по репозиторию (`git grep "<prev-version>" -- ':!package-lock.json' ':!src-tauri/Cargo.lock'`).
   - Проверь UI-тексты, меню (`src/components/MenuBar.tsx`), Command Palette (`src/App.tsx`), подсказки и статусы на устаревшие формулировки относительно новых возможностей релиза.
   - Проверь схему пользовательских настроек (`src/types/settings.ts`, `src/lib/settingsManager.ts`) на корректность дефолтов и миграций.
   - Проверь конфигурацию Tauri (`src-tauri/tauri.conf.json`: CSP, настройки bundle, иконки) и пайплайн CI (`.github/workflows/ci.yml`).
   - Проверь актуальность смежных гайдов (например, `PYTHON_SCRIPTING_GUIDE.md`, `PYTHON_SCRIPTING_AI_GUIDE.md`) и кросс-ссылок между документами.
   - Убедись в чистоте рабочего дерева: никаких `*.pem`, `*.crt`, `*.key`, `*.p12`, `*.sqlite*`, `*.har`, `*.saz` и временных файлов.
4. Внеси все необходимые предрелизные правки до сборки.

### 2. Проверка актуальности и безопасности зависимостей (npm & Cargo)

Перед фиксацией релизной версии проверь актуальность и безопасность библиотек по чеклисту из [references/release-checklist.md](./references/release-checklist.md):

1. **Frontend (`npm`):**
   - Запусти `npm outdated` и `npm audit --audit-level=moderate` (порог CI — `--audit-level=high`).
   - Обнови пакеты с известными уязвимостями и безопасные совместимые минорные/патч-версии (`npm install`), затем проверь `npm ls --depth=0` на отсутствие `extraneous` и конфликтов `peerDependencies`.
   - Проверь совместимость `engines.node` обновляемых пакетов с версией Node.js в `.github/workflows/ci.yml`; при обновлении `monaco-editor` обязательно проверь сохранность всех глубоких импортов в `src/lib/monaco.ts` и сборку воркеров `editor.worker` / `json.worker`.
   - **Не** запускай `npm audit fix --force` вслепую и не выполняй ломающие мажорные миграции (например, React, Tailwind CSS, Vite/Rolldown, TypeScript) без явного подтверждения пользователя.
2. **Backend (`Cargo` / Rust):**
   - Проверь доступные обновления через `cargo update --manifest-path src-tauri/Cargo.toml --dry-run --verbose`.
   - Запусти аудит RustSec (`cargo audit --file src-tauri/Cargo.lock`, если установлен `cargo-audit`, либо проверь опубликованные бюллетени для отстающих прямых/транзитивных крейтов, особенно `zip`, `rusqlite`, `zstd`, `rustls*`, `h2`, `hyper`, `tauri`).
   - Примени совместимые обновления (`cargo update --manifest-path src-tauri/Cargo.toml`) и необходимые обновления безопасности или дедупликации версий в `src-tauri/Cargo.toml` (на Windows избегай сборочных зависимостей вроде `aws-lc-rs`, сохраняя, например, `rustls-no-provider` для `reqwest`).
3. **Синхронизация MSRV:**
   - Проверь максимальный `rust_version` среди всех зависимостей в обновлённом `Cargo.lock` через `cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1`.
   - Если требуемый MSRV вырос, синхронизируй `rust-version` в `src-tauri/Cargo.toml`, джобу `msrv` в `.github/workflows/ci.yml` и бейджи/требования в `README.md`, а также устрани новые предупреждения `clippy` для обновлённого MSRV.

### 3. Синхронизация версии и проверки качества (как в CI)

1. Синхронно обнови версию до `X.Y.Z` во всех манифестах, lock-файлах и коде по чеклисту из [references/release-checklist.md](./references/release-checklist.md):
   - `package.json` и `package-lock.json`
   - `src-tauri/Cargo.toml` и `src-tauri/Cargo.lock`
   - `src-tauri/tauri.conf.json`
   - `src/lib/previewEngine.ts` (`creator.version`; Rust-экспорт в `src-tauri/src/storage/export_import/har.rs` читает `env!("CARGO_PKG_VERSION")` автоматически) и любые другие места, найденные на этапе 1.
2. Запусти полный набор проверок (идентично `.github/workflows/ci.yml`):
   ```powershell
   npm audit --audit-level=high
   npm run typecheck
   npm run test
   npx vite build
   cargo clippy --locked --manifest-path src-tauri/Cargo.toml -- -D warnings
   cargo test --locked --manifest-path src-tauri/Cargo.toml
   ```
   *(Если локально установлен `cargo-audit`, также выполни `cargo audit --file src-tauri/Cargo.lock`.)*
3. **Стоп-условие:** не переходи к сборке установщиков, пока все проверки не завершатся с кодом `0` без ошибок, предупреждений и неразрешённых high/critical уязвимостей.

### 4. Сборка релизных билдов и расчёт SHA-256

1. Собери релизные установочные пакеты Tauri:
   ```powershell
   npx @tauri-apps/cli build
   ```
2. Собери метаданные и SHA-256 собранных артефактов с помощью скрипта [scripts/artifact-info.mjs](./scripts/artifact-info.mjs):
   ```powershell
   node ".agents/skills/fluxproxy-release/scripts/artifact-info.mjs" <X.Y.Z>
   ```
3. Убедись, что для текущей платформы собраны ожидаемые пакеты (на Windows — `FluxProxy_<X.Y.Z>_x64-setup.exe` и `FluxProxy_<X.Y.Z>_x64_en-US.msi`; на macOS/Linux — `.dmg` / `.AppImage` / `.deb`), зафиксируй точные размеры в МБ (с точкой в качестве разделителя) и 64-символьные SHA-256 в нижнем регистре.

### 5. Обновление документации (`README.md`, `ROADMAP.md`, `USER_GUIDE.md`)

Используй шаблоны и правила из [references/release-checklist.md](./references/release-checklist.md). Описывай только реально реализованный функционал из `git log <last-tag>..HEAD`.

1. **`README.md`**:
   - Обнови ссылки на релиз `vX.Y.Z` в верхней плашке и в разделе `## 📥 Скачать готовые сборки (Releases)`.
   - Вставь точные имена файлов, размеры в МБ и реальные SHA-256 из вывода `artifact-info.mjs`.
   - Отрази новые ключевые возможности, горячие клавиши, инструменты, тесты/CI и ссылки на новые гайды.
2. **`ROADMAP.md`**:
   - Перенеси завершённые в релизе `vX.Y.Z` этапы в раздел `## ✅ Реализованные этапы (Verified Milestones)` с кратким перечнем реальных модулей, UI-компонентов и тестов (в стиле записей о `v0.2.0` и `v0.3.0`).
   - Удали выполненные этапы и их промпты из активных спринтов, обнови матрицу приоритетов, зависимости и вводный комментарий о закрытых этапах.
3. **`USER_GUIDE.md`**:
   - Обнови ссылки на установщики `vX.Y.Z` в разделе «Шаг 0. Скачайте и установите программу».
   - Добавь понятные пошаговые инструкции по всем новым функциям, настройкам, окнам и горячим клавишам; обнови оглавление.
4. Проверь кросс-ссылки в остальных `.md`-файлах. Если на этом этапе изменялся исходный код (а не только `.md`), повторно выполни проверки этапа 3.

### 6. Коммит, тег, push и публикация в GitHub Releases

1. Проверь `git status --short` и `git diff --stat`. Убедись, что `src-tauri/target/`, `dist/`, сертификаты и базы данных **не** попадают в индекс.
2. Создай релизный коммит:
   ```powershell
   git add -A
   git commit -m "chore(release): bump version to vX.Y.Z and update documentation"
   ```
3. Создай аннотированный git-тег:
   ```powershell
   git tag -a "vX.Y.Z" -m "Release vX.Y.Z: <краткий список ключевых изменений>"
   ```
4. Отправь ветку и тег в удалённый репозиторий:
   ```powershell
   git push origin main
   git push origin "vX.Y.Z"
   ```
5. Опубликуй артефакты (`.exe`, `.msi` и т.д.) в **GitHub Releases** со структурированными Release Notes (шаблон — в [references/release-checklist.md](./references/release-checklist.md)):
   - Проверь наличие и авторизацию GitHub CLI (`gh --version` и `gh auth status`).
   - Если `gh` доступен и авторизован — выполни:
     ```powershell
     gh release create "vX.Y.Z" "<path-to-exe>" "<path-to-msi>" --title "FluxProxy vX.Y.Z" --notes-file "<notes-file>"
     ```
   - Если `gh` отсутствует или не авторизован — **не** коммить бинарники в ветку Git; выведи в отчёте готовый Markdown-текст Release Notes, точные абсолютные пути к установщикам, прямую ссылку `https://github.com/maq3000/flux-proxy/releases/new?tag=vX.Y.Z` и готовую команду `gh release create`.

### 7. Финальный отчёт

В финальном ответе пользователю представь краткую сводку:
- Целевая версия, хэш релизного коммита и имя тега.
- Итоги аудита/обновления зависимостей (npm & Cargo, статус `npm audit` / RustSec и MSRV).
- Результаты всех проверок (`npm audit`, `typecheck`, `vitest`, `vite build`, `cargo clippy`, `cargo test`).
- Перечень сопутствующих предрелизных доработок (этап 1).
- Таблицу собранных артефактов (абсолютный путь, размер в МБ, SHA-256).
- Статус `git push` (ветка + тег) и статус публикации в GitHub Releases.

---

## Ограничения и защита от ошибок

- **Никогда** не коммить бинарные установщики, `src-tauri/target/`, `dist/`, ключи/сертификаты (`*.pem`, `*.crt`, `*.key`, `*.p12`), локальные БД (`*.sqlite*`) и дампы (`*.har`, `*.saz`).
- **Никогда** не запускай `npm audit fix --force` вслепую и не применяй ломающие мажорные миграции библиотек в рамках релиза без явного подтверждения пользователя.
- **Никогда** не делай `git commit`, `git tag` или `git push` при падении тестов, `clippy` или сборки.
- **Никогда** не перезаписывай (`--force`) уже существующий опубликованный тег без явного подтверждения пользователя.
- **Не выдумывай** в документации и Release Notes функции или тесты, которых нет в реальном диффе `git log <last-tag>..HEAD`.
