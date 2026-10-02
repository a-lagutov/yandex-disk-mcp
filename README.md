# Yandex Disk MCP Server

MCP-сервер для Яндекс Диска: свои файлы, публичные ссылки, корзина, **общие папки** (чтение и запись), загрузка локальных файлов. Работает с любым MCP-клиентом (Claude Code, Claude Desktop, Cursor и др.).

Требуется **Node.js ≥ 20**.

## Инструменты (29)

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

### Общие папки — веб-API, нужен `YANDEX_SESSION_COOKIE`

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

## Переменные окружения

| Переменная | Обязательна | Для чего |
|---|---|---|
| `YANDEX_DISK_TOKEN` | да | OAuth-токен. Без него сервер не запускается |
| `YANDEX_SESSION_COOKIE` | нет | Cookie сессии браузера, инструменты общих папок |
| `YANDEX_ORG_ID` | нет | ID организации Яндекс 360 для `list_shared_disks` |

### OAuth-токен

1. https://oauth.yandex.ru → «Создать приложение».
2. Платформа «Веб-сервисы», redirect URI: `https://oauth.yandex.ru/verification_code`.
3. Доступы **Яндекс.Диск REST API**: `cloud_api:disk.read`, `cloud_api:disk.write`, `cloud_api:disk.info`.
   Необязательно, **API Яндекс 360**: `directory:read_organization`.
4. Сохранить, скопировать Client ID, открыть:
   `https://oauth.yandex.ru/authorize?response_type=token&client_id=<CLIENT_ID>`
5. Скопировать токен (`y0_…`).

> Добавили право позже — пройдите ссылку `/authorize` из шага 4 заново и подтвердите доступ. Строка токена может не измениться, но новое право к нему добавится. Если не добавилось — отзовите доступ приложения на https://id.yandex.ru/security и получите токен ещё раз.

### Cookie сессии

disk.yandex.ru → DevTools → Network → любой запрос `models-v2` → Request Headers → значение `Cookie` целиком.

> ⚠️ Cookie = полный доступ к аккаунту Яндекса. Не храните её в репозитории.
>
> Безопаснее взять cookie из отдельной сессии:
> 1. Откройте окно инкогнито, войдите в Яндекс, скопируйте `Cookie` как описано выше.
> 2. Закройте окно **без выхода из аккаунта** — если нажать «Выйти», cookie сразу перестанет работать.
> 3. Отозвать позже: https://id.yandex.ru/security → «Выйти на всех устройствах» (завершит и остальные ваши сессии).
>
> Истекла — инструменты вернут ошибку, возьмите cookie заново.

## Подключение

### Claude Code — секреты из `~/.zshenv` (рекомендуется)

`~/.zshenv`:

```bash
export YANDEX_DISK_TOKEN='y0_...'
export YANDEX_SESSION_COOKIE='...'   # одинарные кавычки: в cookie есть ; и =
```

Регистрация сервера:

```bash
claude mcp add yandex-disk --scope user -- /bin/zsh -c 'exec node /path/to/yandex-disk-mcp/dist/index.js'
```

zsh читает `.zshenv` при каждом запуске, поэтому переменные доходят до сервера, даже если Claude запущен из Dock. Секретов в конфиге клиента нет.

Секреты в `.zshenv` лежат открытым текстом — закройте файл от других пользователей:

```bash
chmod 600 ~/.zshenv
```

> Не редактируйте `~/.claude.json` вручную при запущенном Claude — файл может быть перезаписан. Используйте `claude mcp add`.

### Claude Desktop / Cursor / другие клиенты

```json
{
  "mcpServers": {
    "yandex-disk": {
      "command": "node",
      "args": ["/path/to/yandex-disk-mcp/dist/index.js"],
      "env": {
        "YANDEX_DISK_TOKEN": "y0_...",
        "YANDEX_SESSION_COOKIE": "...",
        "YANDEX_ORG_ID": "..."
      }
    }
  }
}
```

Необязательные переменные можно не указывать.

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
