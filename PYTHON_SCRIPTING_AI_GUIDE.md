# 🤖 Инструкция для AI-агента: написание скриптов для FluxProxy Python Scripting Engine

> **Как использовать этот файл:** приложите `PYTHON_SCRIPTING_AI_GUIDE.md` к запросу AI-агенту (или вставьте его содержимое в системный / пользовательский промпт) и опишите задачу — например: *«Используя инструкцию из PYTHON_SCRIPTING_AI_GUIDE.md, напиши скрипт для FluxProxy, который…»*.

---

## 1. Роль и задача агента

Ты пишешь пользовательский скрипт (`fluxproxy_script.py`) для встроенного **Python Scripting Engine** в **FluxProxy**.

Требования к результату:
1. Выдавай **самодостаточный однофайловый код на Python 3**, готовый к вставке в редактор панели **Python Scripting Engine (`Alt+5`)**.
2. Предпочитай **только стандартную библиотеку Python 3** (`json`, `re`, `hmac`, `hashlib`, `base64`, `time`, `urllib.parse`, `collections` и т.д.). Используй сторонние `pip`-пакеты, только если пользователь прямо попросил об этом.
3. Строго соблюдай приведённый ниже контракт движка FluxProxy (`src-tauri/src/scripting/python_runner.rs` и `src-tauri/src/proxy/server.rs`). **Ничего не додумывай из API mitmproxy, FiddlerScript (C#/JScript.NET) или Charles.**

---

## 2. Критичные запреты (Anti-Hallucination Rules)

Никогда не делай следующего в скриптах для FluxProxy:

1. **Нет никакого SDK или импортируемых модулей FluxProxy.** Не пиши `import fluxproxy`, `from mitmproxy import http`, `HTTPFlow`, `ctx.log`, `Session` и т.д.
2. **`request` и `response` — это обычные Python `dict`, а НЕ объекты с атрибутами.** Используй `request["url"]`, `response["status"]`, `request["headers"]` — **никогда** `request.url` или `response.text`.
3. **Распознаются только две глобальные функции:** `on_request` и `on_response`. Классы, аддоны (`addons = [...]`), декораторы и функции с другими именами движком не вызываются.
4. **Строгий порядок аргументов в `on_response`:**
   - допустимы **только** `def on_response(response):` или `def on_response(response, request):`
   - **первый аргумент — всегда `response`, второй — `request`!** Никогда не пиши `(request, response)`.
5. **Не используй `if __name__ == "__main__":` для инициализации.** Скрипт исполняется через `exec(..., {"__name__": "__fluxproxy_script__"})`. Инициализацию кэшей, констант и компиляцию `re.compile(...)` размещай на верхнем уровне модуля.
6. **Не распаковывай вручную `gzip`, `deflate`, `br` или `zstd` в `on_response`.** FluxProxy прозрачно распаковывает ответ до вызова `on_response` — `response["body"]` уже содержит декодированный текст (или пустую строку для бинарных данных).
7. **Не используй `time.sleep()` и долгий блокирующий I/O.** На каждый вызов хука действует жёсткий таймаут **1500 мс**, по истечении которого процесс Python принудительно убивается и перезапускается. Если пользователю нужна эмуляция медленной сети (Latency), прямо подскажи использовать **AutoResponder (`Alt+3` → поле `Latency`)**, а не `time.sleep()` в Python.
8. **Не пиши в `sys.__stdout__` или файловый дескриптор `1` (`os.write(1, ...)`).** Нативный поток `stdout` процесса занят служебным IPC-протоколом JSON Lines между Rust и Python — прямая запись туда сломает обмен и вызовет рестарт воркера. Используй обычный `print(...)` или `sys.stderr`.
9. **Не обращайся к ключам `headers` с учётом регистра напрямую** (`headers["Authorization"]`, `del headers["X-Token"]`). В HTTP/2 имена заголовков приходят в нижнем регистре (`"authorization"`), а в HTTP/1.1 — в Title-Case (`"Authorization"`). Прямой `del headers["Authorization"]` выбросит `KeyError`, а прямое присваивание создаст дубликат с другим регистром. Всегда используй регистронезависимые хелперы.
10. **Не записывай относительный путь (`"/v2/users"`) в `request["url"]`.** Поле `request["url"]` должно оставаться валидным абсолютным URL со схемой (`"http://..."` или `"https://..."`), иначе изменение URL будет проигнорировано.

---

## 3. Модель исполнения и жизненный цикл

- **Долгоживущий однопоточный воркер:** FluxProxy запускает один дочерний процесс Python 3 (`-u`, `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, `PYTHONDONTWRITEBYTECODE=1`) и вызывает хуки последовательно под защитой `AsyncMutex`.
- **Загрузка скрипта (`Apply Script`):** код компилируется (`compile(code, "<fluxproxy_script>", "exec")`) и выполняется в новом пространстве имён `{"__name__": "__fluxproxy_script__"}`.
- **Состояние между запросами:** глобальные переменные, счётчики, кэши и `re.compile(...)` **сохраняются между запросами**, пока пользователь не нажмёт **Apply Script**, не выключит переключатель **Enabled** или пока воркер не перезапустится из-за таймаута или аварийного завершения.
- **Минимизация накладных расходов:** определяй только те хуки (`on_request` и/или `on_response`), которые реально нужны для задачи. Если `on_response` не определена, фаза ответа вообще не делает IPC-вызовов.

---

## 4. Точный API-контракт хуков и схемы данных

Изменения из любого хука возвращаются **одним из двух способов**:
- **In-place (рекомендуется):** изменить переданный словарь `request` или `response` и вернуть `None` (`return` без значения).
- **Возврат нового словаря:** если хук возвращает объект типа `dict`, движок берёт итоговое состояние из возвращённого словаря.

### 4.1. `on_request(request: dict) -> dict | None`

Вызывается перед отправкой запроса на сервер (после *Live Breakpoint: Before Request* и **до** *AutoResponder*).

#### Схема входного словаря `request`

| Ключ | Тип на входе | Можно менять | Контракт и особенности |
| :--- | :--- | :---: | :--- |
| `session_id` | `int` | Нет | Уникальный ID сессии в FluxProxy. |
| `method` | `str` | **Да** | HTTP-метод (`"GET"`, `"POST"` и т.д.). При изменении обрезается `.strip()` и приводится к `UPPERCASE`. |
| `url` | `str` | **Да** | Полный URL (`https://host/path?query`). При записи должен быть валидным абсолютным URL (`http://` / `https://`). Rust-ядро автоматически синхронизирует `scheme`, `host`, `path+query` и обновляет заголовок `Host`. |
| `headers` | `dict[str, str]` | **Да** | Заголовки запроса. См. правила в [разделе 4.3](#43-правила-работы-с-заголовками-headers). |
| `body` | `str` | **Да** | Тело запроса, если оно валидный UTF-8 (для бинарного тела приходит `""`). На выходе принимает `str`, `bytes` / `bytearray`, `dict` / `list` (автоматическая сериализация через `json.dumps(..., ensure_ascii=False)` в UTF-8) или `None` (пустое тело). |
| `body_base64` | `str` | **Да** | Base64-строка тела запроса (заполнена всегда, включая бинарные тела). Читается движком, **только если `body` не менялось**. |
| `mock_response` *(псевдоним: `response`)* | `dict` *(добавляется скриптом)* | **Да** | При наличии словаря запрос немедленно замыкается локальным ответом без обращения к AutoResponder, upstream и `on_response`. |

#### Крайний случай `body` vs `body_base64`
Движок проверяет сначала `request["body"] != orig_body`, и только если `body` не изменилось, проверяет `request["body_base64"] != orig_body_base64`:
- Если нужно изменить **текстовое / JSON тело** — меняй `body` (и не трогай `body_base64`).
- Если нужно изменить **бинарное тело** — декодируй `body_base64`, измени байты и либо запиши `bytes` в `body` (например, `request["body"] = patched_bytes`), либо запиши новую base64-строку в `body_base64`, не трогая `body`.
- **Важно:** если на вход пришло не-UTF-8 бинарное тело, то `orig_body == ""`. Присвоение `request["body"] = ""` **не** очистит его (так как `"" == orig_body`). Чтобы очистить бинарное тело до пустого, присвой `request["body"] = b""` или `request["body_base64"] = ""`.

#### Схема `request["mock_response"]` (или `request["response"]`)

```python
request["mock_response"] = {
    "status": 200,  # int (по умолчанию 200)
    "headers": {    # dict[str, str | list[str]] или list[[str, str]]
        "Content-Type": "application/json; charset=utf-8",
        "X-Mock": "1",
        "Set-Cookie": ["a=1; Path=/", "b=2; Path=/"],
    },
    # Либо "body" (str / bytes / bytearray / dict / list / None):
    "body": {"ok": True},
    # Либо "body_base64" (str) — имеет ПРИОРИТЕТ над "body", если не None:
    # "body_base64": "...",
}
```

Правила для `mock_response`:
- Всегда явно задавай `Content-Type` в `headers`, если клиент ожидает конкретный MIME-тип.
- Не добавляй `Content-Length` и hop-by-hop заголовки (`Connection`, `Transfer-Encoding`) — FluxProxy вычисляет и фильтрует их сам.
- В таблице трафика такая сессия получает бейдж `MOCK` и `matched_rule_id = "python-script"`.

---

### 4.2. `on_response(response: dict) -> dict | None` и `on_response(response: dict, request: dict) -> dict | None`

Вызывается для буферизированных ответов **после декомпрессии** (`gzip`, `deflate`, `br`, `zstd`) и до *Live Breakpoint: After Response*.
Движок проверяет арность функции через `inspect.signature` и передаёт второй аргумент `request`, если сигнатура принимает 2+ позиционных аргумента или `*args`.

#### Схема входного словаря `response`

| Ключ | Тип на входе | Можно менять | Контракт и особенности |
| :--- | :--- | :---: | :--- |
| `session_id` | `int` | Нет | ID сессии (совпадает с `on_request`). |
| `status` | `int` | **Да** | Код ответа. Допустим диапазон `100..=599` (значения вне диапазона игнорируются). |
| `method` | `str` | Нет | HTTP-метод исходного запроса (read-only). |
| `url` | `str` | Нет | Полный URL исходного запроса (read-only). |
| `headers` | `dict[str, str]` | **Да** | Заголовки ответа. |
| `body` | `str` | **Да** | Уже распакованное тело ответа (UTF-8) или `""` для бинарных ответов. Правила записи и приоритет над `body_base64` такие же, как в `on_request`. |
| `body_base64` | `str` | **Да** | Base64 распакованного тела ответа. |

#### Схема второго аргумента `request` (контекст в `on_response`)

Содержит **ровно 3 read-only поля**:
```python
{
    "session_id": int,
    "method": str,
    "url": str,
}
```
Заголовки и тело исходного запроса в этом словаре **отсутствуют**. Если в `on_response` нужны заголовки, тело или тайминг запроса — сохраняй их в `on_request` в глобальный `OrderedDict` по ключу `request["session_id"]` с ограничением размера (и удаляй через `.pop(session_id, None)` в `on_response`).

---

### 4.3. Правила работы с заголовками (`headers`)

1. **Сравнение имён регистронезависимое:** Rust-ядро получает только разницу (`headers_removed`, `headers_set`) и применяет её без учёта регистра.
2. **Неизменённые дубликаты сохраняются:** хотя в `dict` на вход попадает одно значение (последнее при дубликатах), если скрипт не менял и не удалял этот заголовок, все исходные дубликаты (например, несколько `Set-Cookie`) полностью сохранятся в реальном HTTP-сообщении.
3. **Добавление / замена:** удали старые ключи без учёта регистра и запиши новое значение (`str`).
4. **Несколько заголовков с одним именем:** присвой список строк `headers["Set-Cookie"] = ["a=1; Path=/", "b=2; Path=/"]` или замени `headers` на список 2-элементных списков/кортежей `[["Name", "Val1"], ["Name", "Val2"]]`.
5. **Удаление заголовка:** удали ключ через `del` (без учёта регистра) или присвой ему `None`.
6. **Автоматическое управление служебными заголовками:** `Content-Length`, `Content-Encoding` (при изменении тела или после распаковки), hop-by-hop заголовки и `Alt-Svc` обновляются прокси автоматически.

---

## 5. Место в конвейере и границы применимости

```text
Запрос ──▶ Header Mutations (Req)
       ──▶ Breakpoint Before Request (F11 / bpu)
       ──▶ on_request(request)
             ├─ mock_response задан ──▶ Header Mutations (Resp) ──▶ Клиенту [MOCK]
             └─ иначе               ──▶ AutoResponder (Alt+3)
                                    ──▶ Upstream (+ mTLS)
                                    ──▶ AutoResponder OverrideStatus
                                    ──▶ Header Mutations (Resp)
                                    ──▶ [Пропуск on_response для SSE / video/* / audio/* / 206 / >2 MiB stream]
                                    ──▶ Декомпрессия (gzip / deflate / br / zstd)
                                    ──▶ on_response(response, request)
                                    ──▶ Breakpoint After Response (Alt+F11 / bpafter)
                                    ──▶ Клиенту
```

### Ограничения, о которых агент ОБЯЗАН предупредить пользователя
Если задача пользователя затрагивает один из следующих случаев, прямо укажи ограничение в комментарии к решению:
1. **TLS Passthrough / Bypass** и режим **Targeted Only**: зашифрованные туннели не расшифровываются; нужный домен должен быть разрешён для MITM (*Always inspect*).
2. **WebSocket (`ws://` / `wss://`)** и **встроенный портал `http://flux.proxy/*`**: через Python-хуки не проходят.
3. **Потоковые ответы в `on_response`:** `on_response` намеренно **не вызывается** для:
   - Server-Sent Events (`Content-Type: text/event-stream`);
   - медиапотоков (`Content-Type: video/*`, `audio/*`);
   - частичных ответов (`206 Partial Content`);
   - ответов с `Content-Length > 2 MiB` (при отсутствии `zstd` и активного Response Breakpoint).
   *(Для всех этих запросов `on_request` по-прежнему вызывается.)*
4. **Лимит размера тела `4 MiB` (`4 194 304` байт):** если тело запроса или ответа превышает 4 MiB, соответствующий хук пропускается (fail-open).

---

## 6. Таймауты, Fail-Open, логирование и защита от Deadlock

1. **Таймаут 1500 мс (fail-open):**
   - Действует отдельно на ожидание освобождения очереди мьютекса воркера и на вызов пайпа (`Apply Script`, `on_request` / `on_response`).
   - При таймауте исполнения в самом пайпе или краше воркер убивается и перезапускается (глобальное состояние в памяти сбрасывается), а текущий трафик пропускается без изменений.
   - При таймауте ожидания очереди мьютекса (`lock_acquire_timeout`) ожидающий запрос пропускается fail-open (`Timeouts +1`), но **живой воркер не убивается и не перезапускается**, сохраняя глобальное состояние.
   - При обычном Python-исключении (`Exception`) воркер остаётся жив, трафик идёт без изменений, а `traceback` отправляется в консоль.
2. **Чистое логирование:**
   - Пиши через `print(...)` с коротким префиксом (например, `[TAG #42] ...`) **только для совпавших/интересных запросов** — консоль UI хранит последние **500** строк.
   - При модификации JSON или текста всегда защищай парсинг (`try ... except`) или проверяй `Content-Type` / непустое тело, чтобы не засорять консоль трассировками на бинарных или пустых ответах.
3. **Запрет петли прокси (Deadlock) при исходящих HTTP-запросах из скрипта:**
   - Если скрипт делает HTTP-вызов (`requests`, `urllib`, `httpx`) при включённом `SysProxy`, запрос может пойти обратно в FluxProxy и встать в очередь за тем же единственным воркером → гарантированный таймаут **1500 мс**.
   - При любых сетевых запросах из скрипта **обязательно** отключай системный прокси и ставь короткий таймаут (`<= 0.5` с):
     ```python
     # requests:
     requests.get(url, proxies={"http": None, "https": None}, timeout=0.5)

     # urllib (стандартная библиотека):
     import urllib.request
     _NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
     _NO_PROXY_OPENER.open(url, timeout=0.5)
     ```
4. **Ограничение памяти:** любые глобальные кэши (`PENDING_REQ`, счётчики по URL и т.д.) ограничивай по размеру (`OrderedDict` с удалением старых записей или `collections.deque(maxlen=...)`).
5. **Ранний выход:** первой строкой хука проверяй хост/путь/метод и сразу делай `return`, если запрос не относится к задаче.

---

## 7. Эталонный шаблон скрипта (Canonical Boilerplate)

Используй эту структуру как базу при генерации скриптов:

```python
"""FluxProxy Python Script — <краткое описание задачи>."""
from collections import OrderedDict
import json
import re

TARGET_URL_RE = re.compile(r"^https?://api\.example\.com/")
MAX_PENDING = 1000
PENDING_REQ = OrderedDict()


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


def on_request(request):
    url = request["url"]
    if not TARGET_URL_RE.match(url):
        return

    sid = request["session_id"]
    PENDING_REQ[sid] = {"trace_id": get_header(request["headers"], "x-trace-id", "-")}
    while len(PENDING_REQ) > MAX_PENDING:
        PENDING_REQ.popitem(last=False)

    # Пример 1: добавить/перезаписать заголовок без дублей регистра
    set_header(request["headers"], "X-Flux-Debug", "1")

    # Пример 2: условный локальный мок (при необходимости)
    # if "/health" in url:
    #     request["mock_response"] = {
    #         "status": 200,
    #         "headers": {"Content-Type": "application/json; charset=utf-8"},
    #         "body": {"ok": True, "session_id": sid},
    #     }


def on_response(response, request):
    ctx = PENDING_REQ.pop(response["session_id"], None)
    if not TARGET_URL_RE.match(request["url"]):
        return

    ct = get_header(response["headers"], "content-type", "")
    if "application/json" not in ct.lower() or not response.get("body"):
        return

    try:
        data = json.loads(response["body"])
    except (ValueError, TypeError):
        return

    if isinstance(data, dict):
        data["_proxied"] = True
        response["body"] = data  # dict/list сериализуются в UTF-8 JSON автоматически
        trace_id = ctx["trace_id"] if ctx else "-"
        print(f"[PATCH #{response['session_id']}] trace={trace_id} status={response['status']}")
```

---

## 8. Чек-лист самопроверки перед выдачей ответа

Перед тем как отдать скрипт пользователю, проверь каждый пункт:

1. Используются только допустимые хуки `on_request(request)` и/или `on_response(response, request)` (первый аргумент `response`, второй `request`).
2. Ненужный хук не объявлен (если правятся только запросы — нет пустого `on_response`; если только ответы — нет пустого `on_request`).
3. Все обращения к полям `request` и `response` идут как к ключам `dict` (`request["url"]`, `response["status"]`), без атрибутов и несуществующих импортов.
4. Все чтения, записи и удаления в `headers` выполняются **регистронезависимо** (через `get_header` / `set_header` / `del_header`).
5. Внутри `request["url"]` записывается только полный абсолютный URL с `http://` или `https://`.
6. При формировании `mock_response` задан `Content-Type` и не указаны `Content-Length` / hop-by-hop заголовки.
7. В `on_response` нет ручной распаковки `gzip`/`br`/`zstd`, а JSON-парсинг защищён от не-JSON/пустых тел.
8. В коде нет `time.sleep()`, прямого вывода в `sys.__stdout__` и `if __name__ == "__main__":`.
9. Если есть глобальные словари/кэши корреляции — их размер ограничен; если есть исходящие HTTP-запросы — отключён системный прокси и задан таймаут `<= 0.5` с.
10. В пояснении пользователю кратко указано: нужно ли включать *Always inspect* для целевого домена, какие ограничения применимы (SSE/видео/`>4 MiB`, если релевантно) и напоминание нажать **Apply Script** (`Ctrl+Enter` / `Ctrl+S`) в панели `Alt+5`.

---

### См. также
- [🐍 Полное руководство пользователя по Python Scripting Engine (`PYTHON_SCRIPTING_GUIDE.md`)](PYTHON_SCRIPTING_GUIDE.md)
- [⚡ Обзор проекта и быстрый старт (`README.md`)](README.md)
- Исходный код движка: [`src-tauri/src/scripting/python_runner.rs`](src-tauri/src/scripting/python_runner.rs), [`src-tauri/src/proxy/server.rs`](src-tauri/src/proxy/server.rs)
