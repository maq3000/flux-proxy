# Чеклист и шаблоны релиза FluxProxy

Справочник для скилла `fluxproxy-release`. Используй точные шаблоны и команды ниже при выполнении этапов 1–6.

---

## 1. Карта мест версии в FluxProxy

Версия `X.Y.Z` (без префикса `v`) должна быть синхронизирована во всех следующих файлах:

| Файл | Поле / место | Способ обновления |
| :--- | :--- | :--- |
| `package.json` | `"version": "X.Y.Z"` | Правка вручную |
| `package-lock.json` | `version` в корне и `packages[""]` | `npm install --package-lock-only` |
| `src-tauri/Cargo.toml` | `version = "X.Y.Z"` в `[package]` | Правка вручную |
| `src-tauri/Cargo.lock` | `version = "X.Y.Z"` у пакета `flux-proxy` | `cargo check --manifest-path src-tauri/Cargo.toml` |
| `src-tauri/tauri.conf.json` | `"version": "X.Y.Z"` | Правка вручную |
| `src/lib/previewEngine.ts` | `creator: { name: "FluxProxy", version: "X.Y.Z" }` | Правка вручную |

> **Примечание:** `src-tauri/src/storage/export_import/har.rs` читает версию автоматически через `env!("CARGO_PKG_VERSION")`, поэтому отдельной правки не требует.

### Поиск остаточных упоминаний прошлой версии

После обновления файлов выполни поиск по репозиторию, чтобы ничего не пропустить:

```powershell
git grep "<prev-version>" -- ':!package-lock.json' ':!src-tauri/Cargo.lock'
```

Дополнительно проверь:
- `src/types/settings.ts` и `src/lib/settingsManager.ts` (новые настройки, дефолты, миграция профиля).
- `src/components/MenuBar.tsx` и `src/App.tsx` (Command Palette, подсказки, горячие клавиши).
- `src-tauri/tauri.conf.json` (`app.security.csp`, `bundle`).
- `.github/workflows/ci.yml` (соответствие локальных проверок и CI).

---

## 2. Чеклист проверки и обновления зависимостей (npm & Cargo)

### Команды аудита и проверки актуальности

```powershell
# Frontend (npm)
npm outdated
npm audit --audit-level=moderate
npm ls --depth=0

# Backend (Cargo / Rust)
cargo update --manifest-path src-tauri/Cargo.toml --dry-run --verbose
cargo audit --file src-tauri/Cargo.lock   # если установлен cargo-audit

# Проверка фактического максимального MSRV среди всех пакетов Cargo.lock
$meta = cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 | ConvertFrom-Json
$meta.packages |
  Where-Object { $_.rust_version } |
  Select-Object name, version, rust_version, edition |
  Sort-Object { [version](($_.rust_version -replace '^\D*','') + $(if ($_.rust_version -notmatch '\.\d+\.') { '.0' } else { '' })) } -Descending |
  Select-Object -First 10 |
  Format-Table -AutoSize
```

### Политика обновлений при подготовке релиза

| Категория | Что делать | На что обратить внимание |
| :--- | :--- | :--- |
| **Безопасность (`npm audit`, RustSec)** | Обновлять в обязательном порядке | Не использовать `npm audit fix --force` вслепую; проверять breaking changes |
| **Совместимые миноры/патчи** | Обновлять (`npm install`, `cargo update`) | Проверить `npm ls --depth=0` (`extraneous` / `peerDependencies`) |
| **Чувствительные пакеты UI/сборки** | Обновлять с проверкой совместимости | `engines.node` vs CI Node, импорты и воркеры `monaco-editor` в `src/lib/monaco.ts`, специфика `jsdom` в Vitest |
| **Чувствительные крейты Rust** | Обновлять с проверкой feature-флагов | На Windows избегать `aws-lc-rs` (например, `rustls-no-provider` для `reqwest`), проверять `clippy` для нового MSRV |
| **Ломающие мажорные миграции** | Не выполнять автоматически | React, Tailwind CSS, Vite/Rolldown, TypeScript, крупные мажоры Rust — только по явному запросу пользователя |
| **MSRV (`rust-version`)** | Синхронизировать при росте максимума | `src-tauri/Cargo.toml`, `.github/workflows/ci.yml` (`msrv`), `README.md` |

---

## 3. Шаблоны для `README.md`

### Верхняя плашка (под описанием проекта)

```markdown
> 📥 **Скачать готовую сборку для Windows:** [**FluxProxy Setup v<X.Y.Z> (.exe)**](https://github.com/maq3000/flux-proxy/releases/download/v<X.Y.Z>/FluxProxy_<X.Y.Z>_x64-setup.exe) или [**MSI-пакет (.msi)**](https://github.com/maq3000/flux-proxy/releases/download/v<X.Y.Z>/FluxProxy_<X.Y.Z>_x64_en-US.msi). Подробнее см. раздел [Скачать готовые сборки](#-скачать-готовые-сборки-releases).
```

### Таблица в разделе `## 📥 Скачать готовые сборки (Releases)`

Используй готовые строки из вывода `node ".agents/skills/fluxproxy-release/scripts/artifact-info.mjs" <X.Y.Z>`:

```markdown
Для запуска FluxProxy на **Windows** вам не требуется компилировать проект из исходных кодов — вы можете скачать готовые официальные установщики из [**GitHub Releases v<X.Y.Z>**](https://github.com/maq3000/flux-proxy/releases/tag/v<X.Y.Z>):

| Дистрибутив | Версия | Архитектура | Описание | Ссылка на загрузку | Контрольная сумма (SHA-256) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Windows Setup (`.exe`)** | `v<X.Y.Z>` | x64 | **Рекомендуемый** автономный инсталлятор (NSIS). Автоматическое создание ярлыков на рабочем столе и в меню «Пуск», встроенный деинсталлятор. | [📥 **FluxProxy_<X.Y.Z>_x64-setup.exe** (<SIZE_EXE> МБ)](https://github.com/maq3000/flux-proxy/releases/download/v<X.Y.Z>/FluxProxy_<X.Y.Z>_x64-setup.exe) | `<SHA256_EXE>` |
| **Windows Package (`.msi`)** | `v<X.Y.Z>` | x64 | Пакет Windows Installer (MSI). Оптимизирован для тихой установки (`msiexec /i ... /qn`) и автоматизированного развертывания через Active Directory (GPO). | [📥 **FluxProxy_<X.Y.Z>_x64_en-US.msi** (<SIZE_MSI> МБ)](https://github.com/maq3000/flux-proxy/releases/download/v<X.Y.Z>/FluxProxy_<X.Y.Z>_x64_en-US.msi) | `<SHA256_MSI>` |
```

Также проверь в `README.md`:
- Раздел «Особенности и возможности» (описание новых функций релиза).
- Раздел «Структура проекта» (если появились новые ключевые модули/гайды).
- Таблицу горячих клавиш (если добавлены или изменены сочетания).
- Раздел «Разработка и Contributing» (команды тестирования, например `npm run test` / Vitest, если они появились).

---

## 4. Шаблон для `USER_GUIDE.md`

### Раздел `### Шаг 0. Скачайте и установите программу`

```markdown
### Шаг 0. Скачайте и установите программу
Для Windows доступны готовые официальные установщики из [**GitHub Releases v<X.Y.Z>**](https://github.com/maq3000/flux-proxy/releases/tag/v<X.Y.Z>):
- [📥 **FluxProxy Setup (.exe)**](https://github.com/maq3000/flux-proxy/releases/download/v<X.Y.Z>/FluxProxy_<X.Y.Z>_x64-setup.exe) — стандартный установщик для домашнего и рабочего использования (автоматически создает ярлыки и деинсталлятор).
- [📥 **FluxProxy Package (.msi)**](https://github.com/maq3000/flux-proxy/releases/download/v<X.Y.Z>/FluxProxy_<X.Y.Z>_x64_en-US.msi) — MSI-пакет для корпоративного развертывания (GPO / Active Directory).
```

### Чеклист разделов `USER_GUIDE.md`

- Добавь понятные пользовательские сценарии (шаги в UI, кнопки, меню, горячие клавиши, советы `[!TIP]`/`[!NOTE]`) для каждой новой функции релиза.
- Обнови оглавление в начале `USER_GUIDE.md` и проверь якоря ссылок.
- Добавь ссылки на специализированные руководства (например, `PYTHON_SCRIPTING_GUIDE.md`), если функционал с ними связан.

---

## 5. Правила обновления `ROADMAP.md`

1. **Перенос в `## ✅ Реализованные этапы (Verified Milestones)`**:
   - Для каждого полностью закрытого в `vX.Y.Z` этапа добавь нумерованный пункт в формате:
     ```markdown
     <N>. **[Этап <K> — Выполнено] <Название этапа>:**
        - Краткое описание реализованной архитектуры, ключевых файлов (`src/...`, `src-tauri/src/...`), команд/UI и добавленных тестов.
     ```
2. **Очистка активных спринтов**:
   - Удали выполненные разделы `## Этап <K>: ...` (вместе с их подсекциями «Цель и контекст», «Критерии приемки (DoD)» и «📝 Промпт для Antigravity») из активного плана ниже матрицы приоритетов.
   - Если весь спринт закрыт — убери пустой заголовок спринта.
3. **Обновление матрицы приоритетов (`## 📋 Матрица приоритетов и порядок выполнения`)**:
   - Убери закрытые этапы из таблицы активных задач (или обнови зависимости у оставшихся этапов, если они ссылались на завершённые).
   - Обнови примечание под таблицей: укажи, какие этапы и спринты выполнены в релизе `vX.Y.Z` и перенесены в раздел реализованных этапов выше.

---

## 6. Шаблон GitHub Release Notes

Используй этот шаблон для `gh release create ... --notes-file` или в качестве готового Markdown-блока при ручной публикации на `https://github.com/maq3000/flux-proxy/releases/new?tag=v<X.Y.Z>`:

```markdown
## 🚀 FluxProxy v<X.Y.Z>

<Краткое резюме релиза в 1–2 предложениях.>

### ✨ Что нового
- **<Фича 1>**: <краткое описание и где найти в интерфейсе>.
- **<Фича 2>**: <краткое описание>.

### 🛠️ Исправления, производительность и качество
- <Ключевые исправления / оптимизации / тесты / CI>.

### 📦 Установочные файлы (Windows x64)

| Файл | Размер | SHA-256 |
| :--- | :--- | :--- |
| `FluxProxy_<X.Y.Z>_x64-setup.exe` | `<SIZE_EXE>` МБ | `<SHA256_EXE>` |
| `FluxProxy_<X.Y.Z>_x64_en-US.msi` | `<SIZE_MSI>` МБ | `<SHA256_MSI>` |

**Full Changelog:** https://github.com/maq3000/flux-proxy/compare/<prev-tag>...v<X.Y.Z>
```
