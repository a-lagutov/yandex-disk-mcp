# Yandex Disk MCP Server

MCP-сервер для Яндекс Диска: свои файлы, публичные ссылки, корзина, **общие папки** (чтение и запись), загрузка локальных файлов. Работает с любым MCP-клиентом (Claude Code, Claude Desktop, Cursor и др.).

Требуется **Node.js ≥ 20**.

## Инструменты (30)

### Вход

| Инструмент | Что делает |
|---|---|
| `login` | Вход через окно Chrome: cookie сессии + OAuth-токен, сохраняются сами |

### Свой Диск — официальный REST API

| Инструмент | Что делает |
|---|---|
| `disk_info` | Объём, занято, корзина |
| `list_files` | Содержимое папки |
| `get_file_info` | Метаданные файла/папки |
| `search_files` | Все файлы, фильтр по типу |
| `last_uploaded` | Недавно загруженные |
| `create_folder` | Создать папку |
| `copy` / `move` | Копировать / переместить, переименовать |
| `delete` | Удалить (в корзину или навсегда) |
| `upload_file` | Загрузить локальный файл |
| `upload_from_url` | Загрузить по внешнему URL |
| `get_upload_link` | URL для загрузки (PUT) |
| `get_download_link` | Ссылка на скачивание |
| `operation_status` | Статус асинхронной операции |
| `list_trash` / `restore_from_trash` / `clear_trash` | Корзина |

### Публичные ссылки — официальный API

| Инструмент | Что делает |
|---|---|
| `publish` / `unpublish` | Открыть / закрыть доступ по ссылке |
| `list_public` | Мои опубликованные ресурсы |
| `list_public_folder` | Содержимое папки по публичной ссылке |
| `get_public_download_link` | Скачать файл из папки по публичной ссылке (без `path` — вся папка zip-архивом) |

### Общие папки — веб-API, нужна cookie сессии (`login`)

| Инструмент | Что делает |
|---|---|
| `list_shared_with_me` | Раздел «Общий доступ»: папки/файлы, владелец, права, ссылка. Следующая страница — через `iteration_key` из ответа |
| `list_shared_folder` | Содержимое общей папки (до 40 за раз, дальше — `offset`) |
| `shared_create_folder` | Создать папку |
| `shared_move` | Переместить / переименовать |
| `shared_delete` | Удалить (в корзину владельца). Корень общей папки удалить нельзя |
| `shared_upload_file` | Загрузить локальный файл ⚠️ не проверено на живой папке |

### Яндекс 360 для бизнеса

| Инструмент | Что делает |
|---|---|
| `list_shared_disks` | Общие диски организации и права на них. Нужен `org_id` / `YANDEX_ORG_ID`. Автоопределение организации (право `directory:read_organization`) работает только у администратора — у остальных API 360 возвращает пустой список |

## Установка

```bash
git clone https://github.com/a-lagutov/yandex-disk-mcp.git
cd yandex-disk-mcp
npm install
npm run build
```

## Вход

Сервер запускается **без каких-либо настроек**. Когда нужен доступ, вызовите инструмент **`login`** (просто попросите Claude «войди в Яндекс Диск»):

1. Откроется окно Chrome с **отдельным профилем** (`~/.config/yandex-disk-mcp/chrome-profile`) — войдите в Яндекс.
2. В том же окне Яндекс выдаст OAuth-токен для вашего приложения (при первом входе нужно нажать «Разрешить»).
3. Токен и cookie сессии сохраняются в `~/.config/yandex-disk-mcp/credentials.json` (права 600) и работают сразу, без перезапуска.

Дальше всё автоматически: cookie общих папок, когда протухнет, обновляется в фоне из сохранённого профиля. Если сессия профиля тоже истекла — инструменты попросят снова вызвать `login`.

Работает на любой ОС и в любой оболочке (zsh не нужен). Требуется Google Chrome и Node.js ≥ 22. То же без Claude: `npm run login`.

### OAuth-приложение (один раз)

1. https://oauth.yandex.ru → «Создать приложение».
2. Платформа «Веб-сервисы», redirect URI: `https://oauth.yandex.ru/verification_code`.
3. Доступы **Яндекс.Диск REST API**: `cloud_api:disk.read`, `cloud_api:disk.write`, `cloud_api:disk.info`.
   Необязательно, **API Яндекс 360**: `directory:read_organization`.
4. Скопируйте Client ID и передайте при первом входе: «войди в Яндекс Диск, client_id …» (или `npm run login -- --client-id <ID>`). Он запоминается.

> Добавили право позже — вызовите `login` заново. Если право не добавилось, отзовите доступ приложения на https://id.yandex.ru/security и войдите ещё раз.

> ⚠️ Cookie = полный доступ к аккаунту Яндекса, токен — к Диску. Файл `credentials.json` закрыт правами 600; не кладите его в репозиторий. Отдельный профиль Chrome изолирует сессию от основного браузера. Отозвать: https://id.yandex.ru/security → «Выйти на всех устройствах». Если нажать «Выйти» в профиле, cookie перестанет работать.

### Переменные окружения (необязательно)

Переопределяют сохранённые значения — например, для Docker/CI, где браузера нет.

| Переменная | Для чего |
|---|---|
| `YANDEX_DISK_TOKEN` | OAuth-токен (`y0_…`) |
| `YANDEX_SESSION_COOKIE` | Cookie сессии браузера (заголовок `Cookie` запроса `models-v2` на disk.yandex.ru) |
| `YANDEX_CLIENT_ID` | Client ID OAuth-приложения |
| `YANDEX_ORG_ID` | ID организации Яндекс 360 для `list_shared_disks` |
| `YANDEX_CHROME_PATH` | Путь к Chrome, если он в нестандартном месте |

## Подключение

### Claude Code

```bash
claude mcp add yandex-disk --scope user -- node /path/to/yandex-disk-mcp/dist/index.js
```

Секреты в конфиге не нужны. Дальше — «войди в Яндекс Диск».

> Не редактируйте `~/.claude.json` вручную при запущенном Claude — файл может быть перезаписан. Используйте `claude mcp add`.

### Claude Desktop / Cursor / другие клиенты

```json
{
  "mcpServers": {
    "yandex-disk": {
      "command": "node",
      "args": ["/path/to/yandex-disk-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

Переменные не нужны — сервер сам предложит `login`.

### Docker

```bash
docker build -t yandex-disk-mcp .
docker run -i --rm -e YANDEX_DISK_TOKEN -e YANDEX_SESSION_COOKIE yandex-disk-mcp
```

`-e VAR` без значения берёт его из текущего окружения. Через compose: `docker compose run --rm -T yandex-disk-mcp` (переменные из `.env`; `-T` отключает TTY, иначе он может сломать обмен по stdio).

> В контейнере `upload_file` и `shared_upload_file` видят только файлы контейнера — для загрузки с хоста примонтируйте папку (`-v ~/Uploads:/uploads`).

## Пути

| Где | Формат | Пример |
|---|---|---|
| Свой Диск | `disk:/…` | `disk:/Projects/report.pdf` |
| Общие папки | `<имя общей папки>/…` | `ADV Team 2/Tasks 2026/Новая папка` |
| Внутри публичной ссылки | ссылка + `path` | `https://yadi.sk/d/…` + `/subfolder` |

Имя общей папки — как в `list_shared_with_me`. Путь назначения при загрузке, оканчивающийся на `/`, сохраняет имя локального файла. Запись в общие папки — только с правом `write`.

## Примеры запросов

- «Что лежит на моём Диске?»
- «Какие общие папки мне доступны?»
- «Покажи содержимое ADV Team 2/Tasks 2026»
- «Создай папку ADV Team 2/Tasks 2026/Новый проект»
- «Загрузи ~/Desktop/report.pdf в ADV Team 2/Tasks 2026/»
- «Сделай disk:/photo.jpg публичным и дай ссылку»
- «Что в корзине? Восстанови последний удалённый файл»

## Как устроено

- `src/yandex-disk-client.ts` — официальный REST API (`cloud-api.yandex.net/v1/disk`), OAuth-токен.
- `src/yandex-disk-web-client.ts` — **недокументированный** API веб-версии (`disk.yandex.ru/models-v2`, для аккаунтов Яндекс 360 — `disk.360.yandex.ru`, хост определяется по редиректу), cookie + CSRF-токен `sk` со страницы Диска. Методы: `mpfs/resources`, `mpfs/mkdir`, `mpfs/bulk-async-move`, `mpfs/bulk-async-delete`, `mpfs/bulk-operation-status`, `mpfs/store`. Может сломаться без предупреждения.
- `src/local-file.ts` — чтение локальных файлов потоком, хэши, PUT.

Публичный REST API не отдаёт список «Общий доступ» и не умеет писать в чужие папки — поэтому веб-API.

## Ограничения

- `shared_upload_file` собран по коду веб-клиента и ещё не проверен на реальной общей папке.
- Попытка записи в общую папку только для чтения — формат ошибки не проверен.
- `list_shared_folder` отдаёт до 40 элементов за запрос — дальше через `offset`.
- Перемещение/удаление ждёт до 15 с; для больших папок вернёт «in progress», операция продолжится на стороне Яндекса.

## Лицензия

MIT
