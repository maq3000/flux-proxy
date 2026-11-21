# 🐍 Руководство по Python Scripting Engine (FluxProxy)

Встроенный **Python Scripting Engine** позволяет программно перехватывать, анализировать, изменять и мокировать HTTP/HTTPS-трафик на лету на языке Python 3 — по аналогии с *FiddlerScript* и *mitmproxy addons*, без перекомпиляции приложения.

Если **AutoResponder** и **Header Mutations** удобны для статических правил, то Python-скрипты незаменимы, когда нужна динамическая логика: расчёт HMAC-подписей, условный патчинг JSON, роутинг запросов на другой хост, корреляция запросов и ответов, сложные моки или логирование нестандартных структур данных.

> Общее руководство пользователя см. в [USER_GUIDE.md](USER_GUIDE.md), обзор архитектуры и возможностей проекта — в [README.md](README.md).
>
> 🤖 **Генерируете скрипты с помощью AI?** Передайте вашему AI-агенту (ChatGPT, Claude, Gemini, Cursor и др.) готовую техническую спецификацию [**PYTHON_SCRIPTING_AI_GUIDE.md**](PYTHON_SCRIPTING_AI_GUIDE.md) с точным контрактом хуков, запретами и эталонным шаблоном.

---

## 📑 Оглавление

1. [Требования и режимы работы](#1-требования-и-режимы-работы)
2. [Быстрый старт и интерфейс панели (Alt+5)](#2-быстрый-старт-и-интерфейс-панели-alt5)
3. [Место скриптов в конвейере MITM-прокси](#3-место-скриптов-в-конвейере-mitm-прокси)
4. [Справочник API хуков](#4-справочник-api-хуков)
5. [Логирование, жизненный цикл и состояние в памяти](#5-логирование-жизненный-цикл-и-состояние-в-памяти)
6. [Практические рецепты](#6-практические-рецепты)
7. [Отказоустойчивость (Fail-Open), лимиты и ограничения](#7-отказоустойчивость-fail-open-лимиты-и-ограничения)
8. [Производительность и безопасность](#8-производительность-и-безопасность)
9. [Устранение неполадок (Troubleshooting)](#9-устранение-неполадок-troubleshooting)

---

## 1. Требования и режимы работы

### Установка и автообнаружение Python 3
Для реального исполнения скриптов требуется установленный **Python 3** в системном `PATH`. При первом обращении ядро FluxProxy ([`python_runner.rs`](src-tauri/src/scripting/python_runner.rs)) автоматически ищет интерпретатор в следующем порядке:

- **Windows:** `python3` → `python` → `py -3` → `py`
- **macOS / Linux:** `python3` → `python` → `py`

Для каждого кандидата запускается проверка `--version` с таймаутом 3 секунды (в выводе ищется строка с `Python 3.`). Результат обнаружения кэшируется на время работы приложения.

Воркер запускается командой `-u -c <bootstrap>` (небуферизованный ввод-вывод) со следующими переменными окружения:
- `PYTHONUTF8=1`
- `PYTHONIOENCODING=utf-8`
- `PYTHONDONTWRITEBYTECODE=1`
- На Windows процесс создаётся с флагом `CREATE_NO_WINDOW` (без всплывающих консольных окон).

Внутри скриптов доступна вся стандартная библиотека Python 3, а также любые сторонние пакеты (`pip`), установленные в окружении найденного интерпретатора.

### Нативное приложение (Tauri) и Browser Preview Simulator
- **Нативное приложение FluxProxy (Tauri):** запускает реальный долгоживущий дочерний процесс Python с обменом по `stdin`/`stdout` (JSON Lines) и применяет хуки к живому MITM-трафику.
- **Browser Preview Simulator (`npm run dev`):** реальный дочерний процесс Python в браузере не запускается. Текст скрипта и состояние переключателя сохраняются в `localStorage` (ключ `fluxproxy.pythonScript.v1`) и в профиле настроек, а в шапке отображается статус `Preview Simulator · Ready` / `Preview Simulator · Active`.

> [!NOTE]
> Если Python 3 не найден в `PATH`, прокси продолжает работать штатно в режиме **fail-open** без модификации трафика (в панели появится баннер предупреждения и статус `Python 3 Not Found`).

---

## 2. Быстрый старт и интерфейс панели (Alt+5)

### Как открыть панель скриптов
- Горячая клавиша **`Alt+5`**
- Левая боковая панель (**Sidebar**) → иконка **Python Scripting Engine** *(когда скрипт активен, на кнопке отображается зелёный индикатор)*
- Верхнее меню: **Rules → Python Scripting Engine (on_request / on_response)…** или **View → Python Scripting Engine**
- Командная палитра **`Ctrl+K`** (`Cmd+K` на macOS) → *Open Python Scripting Engine (on_request / on_response)* или *Enable / Disable Python Scripting Engine*

### Как устроена панель ([`ScriptingPanel.tsx`](src/components/ScriptingPanel.tsx))

1. **Верхняя шапка управления:**
   - **Статус-бейдж:** отображает состояние движка (`Probing Python…`, `Ready (Idle)`, `Active (PID …)`, `Error`, `Python 3 Not Found` или `Preview Simulator`).
   - **Бейджи хуков (`on_request`, `on_response`):** появляются автоматически, если соответствующие функции найдены после загрузки кода.
   - **Метка `Modified`:** указывает, что текст скрипта или переключатель изменены, но ещё не применены.
   - **Переключатель `Enabled / Disabled`:** мгновенно включает или отключает выполнение скрипта. При выключении дочерний процесс Python завершается и освобождает память.
   - **Кнопка `Check Python`:** запрашивает актуальный статус интерпретатора и телеметрию воркера.
   - **Кнопка `Apply Script` (`Ctrl+Enter` или `Ctrl+S` внутри редактора):** компилирует скрипт в воркере, активирует/обновляет хуки и сохраняет код в `localStorage`.

> [!TIP]
> Когда фокус находится внутри редактора кода **Monaco** на вкладке скриптов, нажатие **`Ctrl+S`** (`Cmd+S`) применяет скрипт, а не открывает диалог сохранения архива сессий.

2. **Левая колонка (Script Presets & Worker Telemetry):**
   - **Script Presets** — 4 встроенных шаблона:
     - **HMAC Header Injection** (`on_request`) — вычисляет HMAC-SHA256 подпись (`timestamp + method + url + body`) и добавляет заголовки `X-Flux-Timestamp` и `X-Flux-Signature`.
     - **Conditional Mock** (`on_request`) — возвращает локальный JSON-ответ для `/feature-flags` или при наличии заголовка `X-Flux-Mock: 1`.
     - **Query Rewriter** (`on_request`) — очищает трекинговые параметры (`utm_*`, `fbclid`, `gclid`, `yclid`) и добавляет `_flux_debug=1`.
     - **Payload Logger** (`on_request`, `on_response`) — логирует краткую структуру JSON-запросов и ответов в консоль и помечает `4xx`/`5xx` без изменения трафика.
   - **Worker Telemetry** — счётчики `Calls` (общее число вызовов хуков), `Timeouts`, `Restarts`, текущий таймаут (`1500 ms fail-open`), путь к исполняемому файлу (`bin`) и краткая шпаргалка полей.

> [!IMPORTANT]
> Клик по пресету подставляет шаблон в редактор и сохраняет черновик, но **не загружает его в воркер автоматически**. После выбора шаблона или редактирования кода нажмите **Apply Script** (`Ctrl+Enter` / `Ctrl+S`).

3. **Правая область (Monaco Editor + Console Output):**
   - **Редактор (`fluxproxy_script.py`):** встроенный Monaco Editor с подсветкой синтаксиса Python, табуляцией 4 пробела и переносом строк.
   - **Консоль (`Console Output`):** отображает в реальном времени события `proxy://script-console-log` (время, уровень, имя хука и `#session_id`). Доступны фильтры **`All`**, **`stdout`**, **`stderr / errors`**, кнопка **`Auto-scroll`** и **`Clear`**. В интерфейсе хранятся последние **500** сообщений.
   - Размер разделителя между редактором и консолью сохраняется автоматически между запусками.

### Сохранение и перенос между компьютерами
Код скрипта, состояние `enabled` и идентификатор выбранного пресета сохраняются в `localStorage` и автоматически загружаются при старте FluxProxy. Кроме того, секция `scripting` включена в версионированный профиль настроек `fluxproxy-settings-v1.json` (экспорт/импорт через **Preferences → `Ctrl+,`**). При импорте внешнего профиля, содержащего Python-скрипт, в окне предпросмотра показывается предупреждение безопасности с числом строк, а сам скрипт по умолчанию загружается в выключенном состоянии (`enabled = false`), если пользователь явно не подтвердил доверие чекбоксом в окне импорта.

---

## 3. Место скриптов в конвейере MITM-прокси

Точный порядок обработки трафика в [`server.rs`](src-tauri/src/proxy/server.rs) позволяет предсказуемо комбинировать Python-скрипты с точками останова, AutoResponder и мутациями заголовков:

```text
Входящий HTTP / расшифрованный HTTPS запрос
  │
  ├─▶ [Встроенный портал flux.proxy/*] ──▶ (скрипты не вызываются)
  ├─▶ [WebSocket Upgrade ws / wss]     ──▶ (скрипты не вызываются)
  ├─▶ [TLS Bypass / Passthrough]       ──▶ (не расшифровывается, скрипты не вызываются)
  │
  ▼
1. Header Mutations (Request) из Filter Matrix
  ▼
2. Live Breakpoint: Before Request (F11 / bpu)
  ▼
3. Python hook: on_request(request)
  │   ├─ Если задан request["mock_response"] (или request["response"]):
  │   │    └─▶ Response Header Mutations ─▶ запись сессии (бейдж MOCK) ─▶ ответ клиенту
  │   │        (AutoResponder, upstream и on_response НЕ вызываются)
  │   └─ Иначе применяются правки method / url / headers / body (бейдж HDR)
  ▼
4. AutoResponder (Alt+3) — проверяет уже изменённый скриптом запрос
  ▼
5. Отправка запроса на Upstream (с поддержкой mTLS, если настроено)
  ▼
6. Ответ Upstream ─▶ AutoResponder OverrideStatus ─▶ Header Mutations (Response)
  ▼
7. Ветка Zero-Buffering стримов:
  │   └─ SSE (text/event-stream), video/*, audio/*, 206 Partial Content,
  │      а также ответы с Content-Length > 2 MiB (без zstd и response breakpoint)
  │      ──▶ отдаются потоком напрямую (on_response ПРОПУСКАЕТСЯ)
  ▼
8. Прозрачная распаковка тела ответа (gzip, deflate, br, zstd)
  ▼
9. Python hook: on_response(response[, request])
  │   └─ Применяются правки status / headers / body (бейдж HDR),
  │      Content-Length и Content-Encoding корректируются автоматически
  ▼
10. Live Breakpoint: After Response (Alt+F11 / bpafter) — видит ответ после скрипта
  ▼
11. Запись сессии в TrafficStore и отправка ответа клиенту
```

### Отображение в таблице трафика
- **`MOCK`** — запрос перехвачен скриптом через `request["mock_response"]` (в деталях сессии правило обозначается как `python-script`, а для HTTPS указывается `TLS 1.3 (MITM Python Mock)`).
- **`HDR`** — `on_request` или `on_response` изменил метод, URL, заголовки, статус или тело.

---

## 4. Справочник API хуков

В одном скрипте можно определить `on_request`, `on_response` или обе функции сразу. Если одна из функций не определена (или не является вызываемой), движок не тратит время на IPC-вызовы для соответствующей фазы.

Возвращать изменения из хука можно **двумя равноправными способами**:
1. **In-place (на месте):** изменять поля переданного словаря `request` или `response` и ничего не возвращать (`None`).
2. **Через `return`:** вернуть новый `dict` — если возвращённое значение является словарём, движок считает его итоговым состоянием.

---

### 4.1. Хук `on_request(request)`

Вызывается перед отправкой запроса на сервер (после Breakpoint Before Request и до AutoResponder).

#### Поля словаря `request`

| Поле | Тип (вход) | Можно менять | Описание и поведение |
| :--- | :--- | :---: | :--- |
| `session_id` | `int` | нет | Уникальный номер сессии в FluxProxy. |
| `method` | `str` | **да** | HTTP-метод (`"GET"`, `"POST"` и др.). При изменении пробелы по краям обрезаются, значение приводится к `UPPERCASE`. |
| `url` | `str` | **да** | Полный URL запроса (например, `"https://api.example.com/v1/items?a=1"`). Должен быть **валидным абсолютным URL** со схемой. При изменении FluxProxy автоматически обновляет `scheme`, `host`, `path+query` и **синхронизирует заголовок `Host`**. Невалидный URL игнорируется. |
| `headers` | `dict[str, str]` | **да** | Словарь заголовков запроса. Подробнее о регистре и множественных значениях см. в [разделе 4.3](#43-правила-работы-с-заголовками-headers). |
| `body` | `str` | **да** | Текстовое тело запроса, если оно валидный UTF-8 (для бинарных данных приходит `""`). На выходе принимает `str`, `bytes` / `bytearray`, `dict` / `list` (автоматическая сериализация в UTF-8 JSON) или `None` (пустое тело). |
| `body_base64` | `str` | **да** | Base64-кодированное тело запроса (заполнено всегда, включая бинарные тела). Применяется, **только если поле `body` не изменялось**. |
| `mock_response` *(или `response`)* | `dict` *(добавляется скриптом)* | **да** | При наличии словаря запрос замыкается локально без обращения к upstream. |

#### Формат локального ответа `mock_response`
Чтобы вернуть синтетический ответ сразу из `on_request`, запишите словарь в `request["mock_response"]` (также поддерживается ключ `request["response"]`):

```python
request["mock_response"] = {
    "status": 200,  # int, по умолчанию 200
    "headers": {    # dict[str, str | list[str]] или list[[name, value]]
        "Content-Type": "application/json; charset=utf-8",
        "X-Mocked-By": "FluxProxy-Python",
        "Set-Cookie": ["a=1; Path=/", "b=2; Path=/"],  # несколько одноимённых заголовков
    },
    # Вариант 1: str, bytes, bytearray, dict или list (dict/list сериализуются в JSON автоматически)
    "body": {"ok": True, "items": [1, 2, 3]},
    # Вариант 2 (имеет приоритет над "body", если не None): бинарные данные в Base64
    # "body_base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
}
```

> [!NOTE]
> Если в `mock_response["headers"]` не указать `Content-Type`, клиент получит ответ без этого HTTP-заголовка (хотя в таблице FluxProxy по умолчанию отобразит `application/json; charset=utf-8`). Всегда задавайте `Content-Type` явно. Заголовок `Content-Length` выставлять не нужно — FluxProxy рассчитает его сам.

---

### 4.2. Хук `on_response(response)` / `on_response(response, request)`

Вызывается для буферизированных ответов **после прозрачной распаковки** (`gzip`, `deflate`, `br`, `zstd`) и до Live Breakpoint After Response.

Движок автоматически проверяет сигнатуру функции через `inspect.signature`:
- `def on_response(response):` — передаётся только словарь `response`.
- `def on_response(response, request):` (или `*args`) — вторым аргументом передаётся словарь контекста исходного запроса.

#### Поля словаря `response`

| Поле | Тип (вход) | Можно менять | Описание и поведение |
| :--- | :--- | :---: | :--- |
| `session_id` | `int` | нет | Номер сессии (совпадает с `on_request`). |
| `status` | `int` | **да** | HTTP-код ответа. Принимаются значения в диапазоне `100..=599` (остальные игнорируются). |
| `method` | `str` | нет | HTTP-метод исходного запроса (только для чтения). |
| `url` | `str` | нет | Полный URL исходного запроса (только для чтения). |
| `headers` | `dict[str, str]` | **да** | Заголовки ответа. Неизменённые дублирующиеся заголовки (например, несколько `Set-Cookie`) сохраняются. |
| `body` | `str` | **да** | **Уже распакованное** тело ответа (UTF-8) или `""` для бинарных данных. На выходе принимает `str`, `bytes` / `bytearray`, `dict` / `list` (авто-JSON) или `None`. |
| `body_base64` | `str` | **да** | Base64 распакованного тела. Учитывается, **только если `body` не менялось**. |

#### Поля второго аргумента `request` (контекст)
Содержит 3 поля (только для чтения):
```python
{
    "session_id": 42,
    "method": "POST",
    "url": "https://api.example.com/v1/orders",
}
```

> [!TIP]
> Заголовки и тело исходного запроса во второй аргумент `request` внутри `on_response` не передаются. Если они нужны на этапе ответа, сохраняйте их в глобальном словаре по ключу `session_id` в `on_request` (см. [Рецепт 4](#6-практические-рецепты)).

---

### 4.3. Правила работы с заголовками (`headers`)

Сравнение исходных и изменённых заголовков (`_diff_headers` и `apply_header_diff`) устроено так, чтобы не ломать существующие заголовки ответа и запроса:

- **Имена сравниваются регистронезависимо.**
- **Неизменённые дубликаты сохраняются.** Если сервер прислал два заголовка `Set-Cookie`, а скрипт добавил лишь `X-Debug: 1`, оба `Set-Cookie` останутся на месте.
- **Добавление или замена заголовка:**
  ```python
  response["headers"]["X-Custom"] = "value"
  ```
- **Несколько заголовков с одним именем:** присвойте список строк (или замените `headers` на список пар `[["Name", "Val1"], ["Name", "Val2"]]`):
  ```python
  response["headers"]["Set-Cookie"] = ["a=1; Path=/", "b=2; Path=/"]
  ```
- **Удаление заголовка:** удалите ключ оператором `del` или присвойте ему `None`:
  ```python
  response["headers"]["X-Powered-By"] = None
  ```
- **Подводный камень с регистром ключей в Python `dict`:** в HTTP/2 имена заголовков обычно приходят в нижнем регистре (`"authorization"`, `"content-type"`), тогда как в HTTP/1.1 — в Title-Case (`"Authorization"`, `"Content-Type"`). Обычное обращение `del headers["Authorization"]` вызовет `KeyError`, если ключ в словаре записан как `"authorization"`, а присваивание `headers["Authorization"] = ...` создаст второй ключ с тем же именем в другом регистре. Используйте регистронезависимые хелперы из [раздела 6](#6-практические-рецепты).
- **Служебные заголовки:** hop-by-hop заголовки (`Connection`, `Transfer-Encoding` и др.), `Content-Length`, `Content-Encoding` (при изменении тела или после декомпрессии) и `Alt-Svc` (при включённой защите от HTTP/3) управляются прокси автоматически.

---

## 5. Логирование, жизненный цикл и состояние в памяти

### Вывод в консоль (`print` и `stderr`)
- При загрузке скрипта (`load`) и при каждом вызове `on_request` / `on_response` поток `sys.stdout` перехватывается, а каждая выведенная строка попадает в **Console Output** с уровнем `STDOUT`, именем хука и номером сессии (`#42`).
- Любой вывод в `sys.stderr` (предупреждения `warnings`, стандартный `logging`, вывод из фоновых потоков) поступает в консоль в реальном времени с уровнем `STDERR` и тегом `worker`.
- Исключения Python с полным `traceback` выводятся с уровнем `ERROR` в консоль и дублируются в красный баннер в верхней части панели.

### Жизненный цикл и глобальное состояние
- **Долгоживущий воркер:** процесс Python запускается один раз и обрабатывает вызовы последовательно (под защитой `AsyncMutex`).
- **Состояние между запросами:** глобальные переменные, счётчики, кэши и предкомпилированные регулярные выражения (`re.compile(...)`) **сохраняются между запросами**, пока вы не нажмёте **Apply Script**, не выключите переключатель **Enabled** или пока воркер не перезапустится после таймаута/краша.
- **Чистая перезагрузка:** каждое нажатие **Apply Script** исполняет код в свежем словаре пространства имён (`__name__ == "__fluxproxy_script__"`), очищая старые глобальные переменные.

---

## 6. Практические рецепты

### Рецепт 1. Регистронезависимые хелперы для заголовков
Удобно разместить в начале скрипта, чтобы одинаково надёжно работать с HTTP/1.1 и HTTP/2:

```python
def get_header(headers, name, default=None):
    target = name.lower()
    for k, v in headers.items():
        if k.lower() == target:
            return v
    return default


def set_header(headers, name, value):
    target = name.lower()
    for k in [k for k in headers if k.lower() == target]:
        del headers[k]
    headers[name] = value


def del_header(headers, name):
    target = name.lower()
    for k in [k for k in headers if k.lower() == target]:
        del headers[k]
```

### Рецепт 2. Выборочный патчинг JSON-ответа
Подменяет поля JSON-ответа только для конкретного эндпоинта, не трогая остальные запросы:

```python
import json


def on_response(response, request):
    if "/api/v1/user/profile" not in request["url"]:
        return

    ct = next(
        (v for k, v in response["headers"].items() if k.lower() == "content-type"),
        "",
    )
    if "application/json" not in ct.lower():
        return

    try:
        data = json.loads(response["body"])
    except json.JSONDecodeError:
        return

    data["role"] = "admin"
    data.setdefault("features", {})["betaDashboard"] = True

    # Можно присвоить dict напрямую — движок сам сериализует его в UTF-8 JSON
    response["body"] = data
    response["headers"]["X-Patched-By"] = "FluxProxy"
    print(f"[PATCH] Elevated profile role on session #{response['session_id']}")
```

### Рецепт 3. Перенаправление API с production на локальный сервер
При изменении `request["url"]` FluxProxy автоматически обновляет `scheme`, порт, путь и заголовок `Host`:

```python
from urllib.parse import urlparse, urlunparse


def on_request(request):
    parsed = urlparse(request["url"])
    if parsed.hostname == "api.prod-service.com" and parsed.path.startswith("/v2/"):
        rewritten = urlunparse(
            parsed._replace(scheme="http", netloc="127.0.0.1:8080")
        )
        print(f"[ROUTE] {request['url']} -> {rewritten}")
        request["url"] = rewritten
```

### Рецепт 4. Корреляция данных между `on_request` и `on_response`
Чтобы связать детали запроса (заголовки, размер тела, время начала) с ответом, используйте `OrderedDict` с ограничением размера (чтобы оборвавшиеся запросы не копились в памяти):

```python
from collections import OrderedDict
import time

PENDING_REQ = OrderedDict()
MAX_TRACKED = 1000


def on_request(request):
    sid = request["session_id"]
    PENDING_REQ[sid] = {
        "started_at": time.perf_counter(),
        "body_len": len(request.get("body", "")),
        "trace_id": next(
            (v for k, v in request["headers"].items() if k.lower() == "x-trace-id"),
            "-",
        ),
    }
    while len(PENDING_REQ) > MAX_TRACKED:
        PENDING_REQ.popitem(last=False)


def on_response(response, request):
    ctx = PENDING_REQ.pop(response["session_id"], None)
    if not ctx:
        return
    elapsed_ms = (time.perf_counter() - ctx["started_at"]) * 1000
    print(
        f"[TRACE {ctx['trace_id']}] {request['method']} {request['url']} "
        f"-> {response['status']} ({elapsed_ms:.1f} ms, req={ctx['body_len']} chars)"
    )
```

### Рецепт 5. Динамическое мокирование ошибок для проверки retry-логики
Возвращает ошибку `503 Service Unavailable` на первые 2 попытки, а 3-й запрос пропускает на реальный сервер:

```python
ATTEMPTS = {}


def on_request(request):
    if "/api/payments/charge" not in request["url"]:
        return

    key = f"{request['method']}:{request['url']}"
    attempt = ATTEMPTS.get(key, 0) + 1
    ATTEMPTS[key] = attempt

    if attempt <= 2:
        request["mock_response"] = {
            "status": 503,
            "headers": {
                "Content-Type": "application/json; charset=utf-8",
                "Retry-After": "1",
            },
            "body": {"error": "temporary_unavailable", "attempt": attempt},
        }
        print(f"[RETRY-TEST] Returning 503 for attempt #{attempt}")
    else:
        ATTEMPTS[key] = 0
        print(f"[RETRY-TEST] Allowing attempt #{attempt} to upstream")
```

### Рецепт 6. Работа с бинарными телами (`body_base64` и `bytes`)
Для бинарного содержимого (например, Protobuf или изображений) `body` на входе равен `""`, а исходные байты находятся в `body_base64`:

```python
import base64


def on_response(response, request):
    if request["url"].endswith("/api/binary-payload"):
        raw_bytes = base64.b64decode(response["body_base64"])
        patched = raw_bytes.replace(b"OLD_FLAG", b"NEW_FLAG")
        # Можно присвоить bytes напрямую в body (или записать base64 в body_base64, не трогая body)
        response["body"] = patched
        print(f"[BIN] Patched {len(raw_bytes)} -> {len(patched)} bytes")
```

---

## 7. Отказоустойчивость (Fail-Open), лимиты и ограничения

Движок спроектирован по принципу **fail-open**: сбой в пользовательском скрипте не должен блокировать сеть.

| Ситуация | Что происходит с трафиком | Что происходит с воркером |
| :--- | :--- | :--- |
| **Исключение Python** (`KeyError`, `ZeroDivisionError` и т.д.) | Текущий запрос/ответ идёт **без изменений**. | Воркер **остаётся живым** (PID и глобальные переменные сохраняются, `Restarts` не растёт). Traceback пишется в консоль. |
| **Синтаксическая/runtime ошибка при `Apply Script`** | Скрипт отключается (`enabled = false`), трафик идёт штатно. | Хуки деактивируются, текст ошибки виден в консоли и баннере. |
| **Таймаут выполнения > 1500 мс** (`time.sleep`, бесконечный цикл) | Текущий запрос/ответ пропускается **без изменений**. | Воркер **принудительно завершается и перезапускается** (`Timeouts +1`, `Restarts +1`, память сбрасывается). |
| **Очередь воркера занята > 1500 мс** | Ожидающий запрос/ответ пропускается **без изменений** (`WARN` в консоли). | `Timeouts +1`, живой воркер **не убивается и не перезапускается** (PID и глобальные переменные сохраняются) и продолжает текущую задачу. |
| **Аварийное завершение процесса** (`os._exit`, сбой C-расширения) | Текущий запрос/ответ пропускается **без изменений**. | Воркер **автоматически перезапускается** (`Restarts +1`) и повторно загружает скрипт. |
| **Размер тела > 4 MiB** (`MAX_SCRIPT_BODY_BYTES = 4 194 304` байт) | Хук для этого сообщения пропускается (`WARN` в консоли). | Воркер работает штатно. |

### Какой трафик не обрабатывается скриптами
- **TLS Passthrough / Bypass** — домены, идущие через прямой зашифрованный TCP-туннель. Если сайт не расшифровывается в режиме *Targeted Only*, нажмите ПКМ по строке в таблице трафика → **Always inspect (`домен`)**.
- **WebSocket (`ws://` / `wss://`)** — handshake и фреймы WebSocket не передаются в Python-хуки.
- **Встроенный портал `http://flux.proxy/*`** — обслуживается напрямую.
- **Потоковые ответы в `on_response`** *(для них `on_request` вызывается, а `on_response` пропускается ради сохранения zero-buffering)*:
  - Server-Sent Events (`Content-Type: text/event-stream`);
  - медиапотоки (`Content-Type: video/*`, `audio/*`);
  - частичные ответы (`206 Partial Content`);
  - крупные ответы с заголовком `Content-Length > 2 MiB` (если не требуется распаковка `zstd` и не активен Response Breakpoint).

---

## 8. Производительность и безопасность

1. **Избегайте петли прокси (Deadlock) при HTTP-запросах из скрипта!**
   > [!WARNING]
   > Если внутри `on_request` или `on_response` выполнить HTTP-запрос через `requests` или `urllib` при включённом системном прокси (`SysProxy`), этот запрос может пойти обратно в FluxProxy и встать в очередь за тем же самым единственным воркером — это приведёт к гарантированному таймауту **1500 мс**.

   При необходимости внешних HTTP-вызовов из скрипта явно отключайте прокси и задавайте короткий таймаут:
   ```python
   # Библиотека requests:
   resp = requests.get(
       "http://127.0.0.1:9000/token",
       proxies={"http": None, "https": None},
       timeout=0.5,
   )

   # Стандартная библиотека urllib:
   import urllib.request
   opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
   data = opener.open("http://127.0.0.1:9000/token", timeout=0.5).read()
   ```

2. **Фильтруйте по URL первой строкой хука.**
   Поскольку воркер один, максимально быстрый ранний выход экономит миллисекунды на каждом фоновом запросе браузера:
   ```python
   def on_request(request):
       if "api.myproject.local" not in request["url"]:
           return
       # основная логика...
   ```

3. **Ограничивайте глобальные кэши.**
   Не храните полные тела запросов или ответов в глобальных списках/словарях без ограничения размера (используйте `collections.deque(maxlen=...)` или удаляйте записи, как в [Рецепте 4](#6-практические-рецепты)).

4. **Модель доверия (отсутствие песочницы).**
   > [!CAUTION]
   > Скрипт исполняется стандартным интерпретатором Python 3 с правами текущего пользователя ОС (полный доступ к файловой системе, переменным окружения и сети). Всегда проверяйте код перед запуском чужих скриптов и перед импортом сторонних профилей настроек `fluxproxy-settings-v1.json`.

---

## 9. Устранение неполадок (Troubleshooting)

| Симптом | Вероятная причина | Решение |
| :--- | :--- | :--- |
| Статус **`Python 3 Not Found`** | Python 3 не установлен или отсутствует в `PATH` (на Windows также возможен алиас-заглушка Microsoft Store вместо реального Python). | Установите Python 3 с опцией *Add Python to PATH*, перезапустите FluxProxy (чтобы обновился кэш `PATH`) и нажмите **Check Python**. |
| Статус **`Preview Simulator`** и трафик не меняется | Приложение открыто в браузерном режиме `npm run dev`. | Запустите нативное десктопное приложение FluxProxy или `npx @tauri-apps/cli dev`. |
| Выбран пресет или изменён код, но скрипт не срабатывает | Изменения не применены (горит бейдж **`Modified`**) или выключен переключатель **`Enabled`**. | Переведите тумблер в **`Enabled`** и нажмите **Apply Script** (`Ctrl+Enter` / `Ctrl+S`). Убедитесь, что в шапке видны бейджи `on_request` / `on_response`. |
| HTTPS-запросы не попадают в хуки | Домен находится в TLS Bypass или не добавлен в список режима *Targeted Only* (в таблице у строки метка `TUNNEL`). | Кликните ПКМ по строке запроса в таблице → **Always inspect (`домен`)**. |
| `on_response` не вызывается для ответа | Ответ является потоковым (`text/event-stream`, `video/*`, `audio/*`, `206`, `Content-Length > 2 MiB`), тело превышает `4 MiB` либо запрос был перехвачен через `mock_response` / AutoResponder. | Проверьте `Content-Type`, код статуса и размер ответа, а также сообщения `WARN` в **Console Output**. |
| Растут счётчики **`Timeouts`** и **`Restarts`** | Хук выполняется дольше `1500 мс` или возникла петля прокси при HTTP-вызове из скрипта. | Уберите блокирующие паузы (`sleep`), отключите прокси в клиентах внутри скрипта (`ProxyHandler({})`), оптимизируйте парсинг и используйте ранний `return`. |
| `KeyError` при удалении заголовка | В HTTP/2 имена заголовков приходят в нижнем регистре (`authorization`), а код ищет `Authorization`. | Используйте регистронезависимые функции `get_header` / `set_header` / `del_header` из [раздела 6](#6-практические-рецепты). |

---

### См. также
- [🤖 Инструкция для AI-агента по написанию скриптов (`PYTHON_SCRIPTING_AI_GUIDE.md`)](PYTHON_SCRIPTING_AI_GUIDE.md)
- [📖 Руководство пользователя FluxProxy (`USER_GUIDE.md`)](USER_GUIDE.md)
- [⚡ Обзор проекта и быстрый старт (`README.md`)](README.md)
- [🗺️ Дорожная карта развития проекта (`ROADMAP.md`)](ROADMAP.md)
- Исходный код движка: [`src-tauri/src/scripting/python_runner.rs`](src-tauri/src/scripting/python_runner.rs), [`src/components/ScriptingPanel.tsx`](src/components/ScriptingPanel.tsx)
