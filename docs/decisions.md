# 1C Deploy Cabinet — контекст проекта и принятые решения

> **Назначение файла:** брифинг для ИИ-агента / разработчика. Содержит полный контекст:
> что есть сейчас, к каким архитектурным решениям пришли, что делать дальше.
> Если сессия прервалась или начинается новая — показать этот файл агенту.

Дата фиксации: 2026-10-29
Статус: архитектура выбрана, разработка не начата.

---

## 1. Что есть сейчас (исходная точка)

Рабочий скрипт развертки 1С-проектов (PowerShell 5.1, автономный, **без прав администратора**):

```
C:\1C_Bases\AI\1c-deploy_new\deploy-new-1c-project-ru-publish.ps1
```

Что делает один прогон (`.dt` → готовый проект для AI-разработки):

1. **Параметры** (CLI или интерактивный ввод): TemplateDir, ProjectDir, DtPath, PlatformPath,
   IbcmdPath, DbUser/DbPassword, Prefix (по умолч. `ФК_`), NewObjectsIn (`extension`),
   ApacheDir (portable Apache 2.4), PublishPort (по умолч. 8080), RulesSource/RulesCacheDir,
   SkipRulesUpdate, BslAnalyzerDir/Version, SkipBslAnalyzer, JavaPath,
   PlatformContextDir/Version, SkipPlatformContext.
2. Автодетект платформы в `C:\Program Files\1cv8\<версия>` (выбор из установленных) и `ibcmd.exe`.
3. Создание папки проекта, копирование эталона: `env.json`, `packagedef`, `.kilo/kilo.json(.jsonc/.gitignore)`, `tools/mcp-1c` (mcp-1c.exe + MCP_HTTPService.cfe).
4. Патч `.dev.env` (PLATFORM_PATH/VERSION, INFOBASE_PATH=build\ib, INFOBASE_KIND=file, IB_USER/PASSWORD, EXPORT_PATH=src\cf, EXTENSIONS_PATH=src\cfe, PREFIX, NEW_OBJECTS_IN) и `env.json` (профиль default: --ibconnection `/F"...""`, --db-user, --db-pwd, --v8version, --root, --workspace).
5. Создание структуры каталогов проекта (.1cpt, build, docs, src\epf, tests, tools, vendor и др.).
6. **Создание ИБ из .dt**: `ibcmd infobase create --db-path=<ib> --create-database --restore=<dt>`.
7. **Проверка блокировок ИБ**: ненулевые `*.1cl`, зависшие 1cv8/1cv8c/designer с этой ИБ, ibsrv с `--db-path=<ib>`; цикл «исправил — проверь ещё раз» (сейчас интерактивный).
8. **Установка расширения MCP_HTTPService**: `mcp-1c.exe -install <ib> -platform <1cv8.exe>` (через Конфигуратор, декларирует MCP_ОсновнаяРоль), затем `ibcmd config extension update --safe-mode=no --unsafe-action-protection=no`.
9. **Дамп основной конфигурации**: `ibcmd infobase config export` → `src/cf`.
10. **Дамп расширений**: `ibcmd config export all-extensions` → `src/cfe`.
11. **Веб-публикация в portable Apache** (без службы, без админа, порт >1024):
    патч `httpd.conf` (SRVROOT, Listen, ServerName, LoadModule wsap24 + Include, маркерный блок),
    блок публикации в `conf/1c-publications.conf` (маркеры `# project: <id>` / `# end project: <id>`,
    один Apache обслуживает много баз), `build/publish/default.vrd`
    (File=..., опц. Usr/Pwd внутри строки ib, httpServices publishByDefault + publishExtensionsByDefault, ws enable),
    рестарт httpd.exe (свой видимый консольный процесс), probe `GET /<vdir>/hs/mcp-1c/version`,
    запись INFOBASE_PUBLISH_URL в `.dev.env`. Веб-клиент: `http://localhost:<port>/<vdir>/ru_RU/`.
12. **Правила AI-агента**: кэш-клон ai_rules_1c (git clone/fetch+reset), `install.ps1 -Command init -ProjectRoot <dir> -Tools kilocode -NonInteractive -AssumeYes`.
13. **bsl-analyzer**: установка официальным install.ps1 в %LOCALAPPDATA%\Programs (без админа), `bsl-analyzer.toml` (root=src/cf), MCP-записи workspace/reference в `.kilo/kilo.json`, управляемый блок в `USER-RULES.md`.
14. **mcp-bsl-platform-context**: java 17+ (проверка версии), fat-JAR с GitHub Releases (кэш в tools, переиспользуется между проектами), MCP-запись `bsl-platform-context` (--platform-path), блок в USER-RULES.md.
15. **kilo.json**: `1c-data-mcp` переводится на локальный stdio-прокси (`tools/mcp-1c/mcp-1c.exe -base <publishUrl>/hs/mcp-1c [--dump src/cf]`); все прочие MCP-серверы каталога отключаются (enabled=false, whitelist-режим).
16. Итоговый лог `fk_deploy_log.bsl`, открытие в VS Code.

Важные свойства текущего скрипта (сохранить при рефакторинге):
- **Полная идемпотентность** шагов (маркерные блоки в httpd.conf / 1c-publications.conf / USER-RULES.md / kilo.json, пропуск уже выполненного).
- Прогресс длинных операций 1cv8/ibcmd через хвост лога дизайнера («Обрабатывается: <объект>», «Выгрузка …»).
- Аккуратная работа с PS 5.1: UTF-8 no BOM, экранирование аргументов Start-Process, $ProgressPreference при скачиваниях и т.п.
- Всё работает **без прав администратора**.

---

## 2. Цель проекта

Графический интерфейс — **«личный кабинет» в браузере** для управления развертками 1С:
- список/карточки развернутых проектов (статус, ссылки: веб-клиент, MCP, VS Code, логи);
- новая развертка рабочего пространства (все пункты скрипта) через визард;
- монитор прогона в реальном времени (шаги, живой лог, прогресс);
- управление публикациями (публикация/снятие/порт/рестарт Apache) для уже развернутых баз.

Заложить модульность под будущие функции:
1. развертка в **серверную** базу;
2. подключение **агента / MCP-серверов** к уже развернутым базам (файловым и серверным);
3. **индексация** проектов для лучшей работы AI-агента.

---

## 3. Жесткие ограничения

- **Без прав администратора** — весь стек.
- Windows, PowerShell **5.1** (код ядра должен работать на 5.1; не полагаться на pwsh 7).
- HTTP-порты **выше 1024**; кабинет слушает **только 127.0.0.1** (не спрашивать брандмауэр).
- Никаких системных служб и URL ACL (netsh http) — всё процессы пользователя.
- Portable Apache (`C:\1C_Bases\AI\tools\apache_portable\Apache24`) остается средством публикаций ИБ; кабинету он не нужен — у него свой порт.

---

## 4. Принятые архитектурные решения

### D1. Вариант интерфейса: локальный веб-кабинет (из сравнения с WPF / VS Code extension / Electron)
Бэкенд-процесс на localhost + страница в браузере. Полностью удовлетворяет «кабинету», живым логам и работе без админа.

### D2. Backend: **PowerShell (ядро шагов) + Pode** (HTTP-сервер на PowerShell)
- Ядро развертки **обязано** остаться на PowerShell — это обертки над ibcmd/1cv8/Конфигуратор/Apache, текущий код проверен годами.
- Pode — веб-сервер на чистом PowerShell (`Install-Module Pode -Scope CurrentUser`, без админа), слушает **сырым TcpListener** (не http.sys) → не нужен URL ACL → нет прав администратора. Поддерживает PS 5.1, REST и SSE.
- Рантайм: консольный процесс пользователя; автозапуск — ярлык или задача планировщика **от пользователя** (не служба).
- Альтернатива на вырост (не выбрана сейчас): ASP.NET Core Minimal API (Kestrel) + вызов тех же runner-процессов — API-слой тонкий, миграция дешева, если позже понадобится.

### D3. Frontend: **TypeScript SPA — да, JavaScript/TypeScript использовать можно и рекомендуется**
- Сборка: **Vite + TypeScript** (Vanilla TS или легкий фреймворк — Preact/Svelte/Vue/React; фреймворк вторичен, можно начать с Vanilla TS или Preact).
- Результат сборки — **статические файлы** (`dist/`), которые просто отдаются Pode как статика.
- **Node.js нужен только на этапе разработки/сборки** (dev-машина). В рантайме на машине с 1С Node не требуется.
- Общение с бэкендом: REST + SSE (fallback — поллинг `GET /runs/:id`).

Итог по языкам:
| Слой | Язык | Комментарий |
|---|---|---|
| Ядро шагов (deploy logic) | PowerShell 5.1 | обязателен (обертки над 1С-тулингом) |
| API-сервер | PowerShell + Pode | тонкий слой, тот же язык, без админа |
| Frontend | TypeScript (Vite) | JS/TS — да; статика в рантайме |
| Runner (прогон деплоя) | PowerShell | отдельный процесс на прогон |

### D4. Разделение на слои (главный принцип модульности)
GUI только показывает и запускает; вся логика — в переиспользуемом ядре:

```
UI (браузер, TS SPA)
  ↕ REST + SSE
API-сервер (Pode, localhost)
  ↕ запуск процессов, чтение статус-файлов
Job Runner (powershell.exe -File runner.ps1 -RunId ...)
  ↕
Ядро: Modules/Core — функции-шаги (рефакторинг текущего скрипта)
  ↕
Данные: registry.json + project.json + runs/<id>/*
```

### D5. Рефакторинг монолита в ядро-модуль
Требования к каждому шагу:
- **Никакого Read-Host / Ask-YesNo** — параметры приходят объектом-манифестом (JSON); интерактив заменен валидацией с кодами ошибок (решение принимает UI).
- Структурированный результат: `{ step, status, durationSec, logPath, error }`.
- События прогресса — **JSON-lines** (`steps.jsonl`): `{ ts, step, phase, detail, elapsed }`; «Обрабатывается: X» из лога дизайнера попадает в `detail`.
- Идемпотентность и маркерные блоки — сохранить как есть.

### D6. Job Runner — модель прогонов
- Каждый деплой = **отдельный процесс** `powershell.exe -File runner.ps1 -RunManifest <json> -RunDir <dir>`.
- UI/сервер могут перезапуститься — прогон продолжится, статус дочитывается из файлов (`runs/<id>/state.json` + `steps.jsonl` + логи ibcmd, которые и сейчас пишутся в `build\*.log`).
- Параллельные прогоны разрешены, но: **один Apache / один порт** и **одна ИБ = одна ibcmd-операция** — очередь/файловые lock-файлы на уровне реестра.

### D7. Реестр проектов и данные
- `C:\1C_Bases\AI\registry.json` — центральный индекс; в каждом проекте `project.json`.
- `project.json` (черновик схемы): `name, path, kind: "file"|"server" (заложено сразу), ibPath, platformPath, platformVersion, dbUser, publish { url, webClientUrl, mcpUrl, vdir, port, apacheDir }, mcpServers[], createdAt, lastDeployAt, status, runs[]`.
- История: `runs/<runId>/manifest.json`, `steps.jsonl`, логи stdout/stderr.
- **Секреты** (пароль ИБ): DPAPI (`ConvertFrom/To-SecureString` текущего пользователя), в открытом виде не хранить.

### D8. API-контракт (черновик)
- `GET    /api/projects` — список из реестра;
- `POST   /api/projects/deploy` — создать прогон (тело = манифест визарда);
- `GET    /api/runs/:id` — статус прогона;
- `GET    /api/runs/:id/events` — SSE живого лога;
- `POST   /api/projects/:id/publish | unpublish` — управление публикацией;
- `POST   /api/apache/restart`, `GET /api/apache/status`;
- `POST   /api/tools/bsl-analyzer/install` и т.п. (будущий «подключить MCP к базе»);
- `GET    /api/settings`, `PUT /api/settings` — пути (Apache, tools), платформы, порт кабинета;
- `GET    /api/platforms` — детект установленных платформ.

### D9. Что НЕ использовать
- ❌ `HttpListener`/http.sys без URL ACL (требует netsh = админ);
- ❌ IIS, системные службы, порты < 1024;
- ❌ `Invoke-Expression` над пользовательским вводом из UI — параметры строго через JSON-манифест и параметризованные вызовы runner.

---

## 5. Маппинг шагов скрипта → модули ядра (план рефакторинга)

| Шаг скрипта | Функция ядра (черновик) | Модуль |
|---|---|---|
| Детект платформ / ibcmd | `Find-Platform`, `Find-Ibcmd` | Core.Platform |
| Копирование эталона, структура каталогов | `Initialize-ProjectSkeleton` | Core.Project |
| Патч .dev.env / env.json | `Set-DevEnvValue`, `Set-EnvJsonValue` (уже есть) | Core.Config |
| ИБ из .dt | `New-IbFromDt` | Core.Infobase |
| Проверка блокировок | `Test-IbLock`, `Wait-IbFree` (возврат состояния, без Ask-YesNo) | Core.Infobase |
| Расширение MCP_HTTPService | `Install-McpExtension`, `Set-ExtensionSafeModeOff` | Core.Mcp |
| Дампы cf/cfe | `Export-Cf`, `Export-Cfe` | Core.Infobase |
| Публикация Apache | `Publish-ToApache`, `Unpublish-Project`, `Restart-Apache`, `Test-PublishPort` | Core.Publish |
| Правила ai_rules_1c | `Install-Rules` | Core.Tools |
| bsl-analyzer | `Install-BslAnalyzer`, `Set-BslAnalyzerToml`, `Set-KiloBslAnalyzerMcp` | Core.Tools |
| mcp-bsl-platform-context | `Install-PlatformContext` (java-проверка внутри) | Core.Tools |
| kilo.json MCP-конфиг | `Set-KiloDataMcpLocal`, `Add-KiloLocalMcpEntry`, `Disable-KiloMcpServers` (уже есть) | Core.Mcp |
| Реестр/статусы | `Save-ProjectRecord`, `Write-StepEvent` | Core.Registry |

Оркестратор деплоя (пайплайн шагов для kind=file) собирается из этих функций; runner.ps1 исполняет пайплайн и пишет events.

---

## 6. Экраны UI (TS SPA)

1. **Проекты** — карточки из реестра: статус, платформа, ссылки (веб-клиент `/ru_RU/`, MCP-эндпоинт, открыть в VS Code), действия: перепубликовать, снять публикацию, рестарт Apache, история прогонов.
2. **Новая развертка** — визард по параметрам скрипта: шаблон, папка проекта, .dt, платформа (детект+выбор), DbUser/пароль, префикс, порт публикации, чекбоксы Skip*, правила/анализатор/справочник платформы вкл-выкл; предпросмотр манифеста → запуск.
3. **Монитор прогона** — шаги со статусами, живой лог (SSE), «Обрабатывается: …», таймеры; по завершении — сводка + ссылки. Состояние переживает перезагрузку страницы (читается из files).
4. **Инструменты** — состояние bsl-analyzer / platform-context / кэша правил; кнопки установки/обновления (база для будущего «подключить MCP к существующей базе»).
5. **Настройки** — пути (Apache, tools, кэш правил), реестр платформ, порт кабинета, хранение паролей (DPAPI).

---

## 7. Дорожная карта

- **Этап 0 (фундамент):** рефакторинг скрипта в `Modules/Core` + `runner.ps1` + JSON-события. Критерий: деплой из CLI дает результат, идентичный текущему скрипту (регрессия на реальном .dt).
- **Этап 1 (MVP кабинета):** Pode на 127.0.0.1, статика из Vite/TS, список проектов, визард .dt→файловая база, монитор прогона, реестр. = текущий функционал скрипта, но с GUI.
- **Этап 2:** управление публикациями (publish/unpublish/порт/состояние Apache, автодетект занятых портов).
- **Этап 3:** модуль «серверная база»: `New-IbOnServer` (ibcmd/COMConnector к кластеру), публикация с Srvr/Ref в .vrd; `kind: server` в реестре; визард ветвится.
- **Этап 4:** модуль «агент/MCP к существующим базам» = вынесенные `Install-McpExtension + Set-KiloMcp* + патч env/env.json` как точечные операции над произвольным проектом, экран с чекбоксами.
- **Этап 5:** индексация: фоновые задачи runner (дамп cf → bsl-analyzer workspace / поиск), кнопка «переиндексировать», статус индекса в карточке.

---

## 8. Риски и тонкости (учесть)

- PS 5.1: `ConvertTo-Json -Depth`, UTF-8 **no BOM**, экранирование аргументов `Start-Process` (массивы склеиваются без кавычек!), `2>&1` при `$ErrorActionPreference=Stop` — в текущем скрипте это уже решено, переносить как есть.
- Параллельные ibcmd-операции над одной ИБ запрещены → очередь/lock-файлы.
- Один portable Apache на все публикации: смена порта = перезапуск всех публикаций; порт кабинета выбрать отличным от 8080.
- Брандмауэр: слушать только 127.0.0.1.
- Не запускать деплой параллельно с активной работой VS Code в том же проекте (файловые блокировки 1CD) — предупреждение в UI, reuse `Test-IbLock`.
- Веб-кабинет доступен только с локальной машины (127.0.0.1). Если позже нужен доступ с других устройств — отдельная задача (LAN-бинд + брандмауэр = отдельное решение, сейчас не делать).

---

## 9. Следующий шаг

**Этап 0**: выделить шаги `deploy-new-1c-project-ru-publish.ps1` в модуль `Modules/Core` (функции из таблицы п.5) + `runner.ps1` с JSON-манифестом и JSON-lines событиями, не меняя поведение текущего деплоя. Затем этап 1 — Pode + TS SPA.

Инструкция агенту, берущему работу: начать с этапа 0; интерфейсы функций и контракт событий (п.4 D5–D8) не менять без записи изменений в этот файл.

---

## 10. Приложение: UI-прототип (этап 0.5)

> **Актуализация (2026-10-29):** проект перенесён из `C:\1C_Bases\AI\script` в
> `C:\1C_Bases\AI\cabinet` (корень git-репозитория `Gr1n4-py/1c-deploy-cabinet`).
> Прототип лежит в `prototype-legacy\index.html` (история, не развивать).
> Рабочий фронтенд — Vite + TypeScript (структура в README.md в корне проекта):
> hash-роутер, страницы в `src/pages`, компоненты в `src/components`,
> дизайн-токены в `src/styles/tokens.css`. Стили по классам, ID не стилизуются,
> JS-хуки — `data-ref`. Правила кода — в README.md.
> Node.js — портативная копия v24 (путь в README.md), без прав администратора.

Исторический прототип `prototype-legacy\index.html` (открывается двойным кликом, офлайн):
- экран входа: поле логина + кнопка «Войти», живая подсказка «пользователь найден / будет создан»;
- автосоздание профиля при первом входе; повторное открытие кабинета — автологин последнего пользователя на «Рабочий стол» (заглушка), кнопка «Выйти» возвращает на вход;
- ведение проектов — **в разрезе пользователя** (в реестре D7 предусмотреть поле `owner` в project.json).

Точки интеграции с будущим API: подсказка → `GET /api/users?prefix=`, вход → `POST /api/login {name}`, сессия → cookie на сервере (сейчас localStorage). Пароль не предусмотрен (локальный однопользовательский компьютер); если понадобится — добавить позже, не ломая контракт.
