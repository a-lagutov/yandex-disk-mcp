# Yandex Disk MCP Server

**English** · [Русский](README.ru.md)

MCP server for Yandex Disk: your own files, public links, trash, **shared folders** (read and write), local file upload. Works with any MCP client (Claude Code, Claude Desktop, Cursor, etc.).

Requires **Node.js ≥ 20** (**≥ 22** for `login`).

## Tools (32)

### Login

| Tool | What it does |
|---|---|
| `login` | Sign in through a browser window: session cookie + OAuth token, saved automatically |

### Your Disk — official REST API

| Tool | What it does |
|---|---|
| `disk_info` | Total space, used space, trash size |
| `list_files` | Folder contents |
| `get_file_info` | File/folder metadata |
| `search_files` | Search by name (`query`, needs `login`), or list all files with a type filter |
| `last_uploaded` | Recently uploaded |
| `create_folder` | Create a folder |
| `copy` / `move` | Copy / move, rename |
| `delete` | Delete (to trash or permanently) |
| `upload_file` | Upload a local file |
| `upload_from_url` | Upload from an external URL |
| `get_upload_link` | Upload URL (PUT) |
| `get_download_link` | Download link |
| `operation_status` | Status of an async operation |
| `list_trash` / `restore_from_trash` / `clear_trash` | Trash |

### Public links — official API

| Tool | What it does |
|---|---|
| `publish` / `unpublish` | Open / close access by link |
| `list_public` | My published resources |
| `list_public_folder` | Folder contents by public link |
| `get_public_download_link` | Download a file from a public folder (without `path` — the whole folder as a zip) |

### Shared folders — web API, needs the session cookie (`login`)

| Tool | What it does |
|---|---|
| `list_shared_with_me` | The "Shared" section: folders/files, owner, rights, link. Next page via `iteration_key` from the response |
| `shared_search` | Search by name across all shared folders, or inside one (`folder`). Slow — see Limitations; next page via `iteration_key` |
| `list_shared_folder` | Shared folder contents (up to 40 at a time, then `offset`) |
| `shared_create_folder` | Create a folder |
| `shared_move` | Move / rename |
| `shared_copy` | Copy (same destination rules as `shared_move`) |
| `shared_delete` | Delete (to the owner's trash). A shared folder root cannot be deleted |
| `shared_upload_file` | Upload a local file |

### Yandex 360 for business

| Tool | What it does |
|---|---|
| `list_shared_disks` | Organization shared disks and rights on them. Needs `org_id` / `YANDEX_ORG_ID`. Auto-detecting the organization (the `directory:read_organization` right) works for administrators only — for others the 360 API returns an empty list |

## Installation

```bash
git clone https://github.com/a-lagutov/yandex-disk-mcp.git
cd yandex-disk-mcp
npm install
npm run build
```

## Login

The server starts with **no configuration at all**. The `login` tool gives access:

- **Shared folders** — signing in to Yandex (cookie) is enough, no OAuth app needed.
- **Your Disk, public links, trash, upload** — need an OAuth token, so an OAuth app too (created once).

### 1. OAuth app (once, only for your own Disk)

1. https://oauth.yandex.com → "Create app".
2. Platform "Web services", redirect URI: `https://oauth.yandex.ru/verification_code`.
3. Access to **Yandex Disk REST API**: `cloud_api:disk.read`, `cloud_api:disk.write`, `cloud_api:disk.info`.
   Optional, **Yandex 360 API**: `directory:read_organization`.
4. Copy the Client ID — you need it at the first login. Without it `login` gets only the cookie: shared folders work, your own Disk does not.

> Added a right later — call `login` again. If the right did not appear, revoke the app's access at https://id.yandex.com/security and sign in again.

### 2. Sign in with `login`

Ask Claude: "log in to Yandex Disk, client_id …" (the Client ID is remembered, no need to repeat it). Shared folders only — "log in to Yandex Disk" without `client_id`. Without Claude: `npm run login -- --client-id <ID>`.

1. A browser window opens with a **separate profile** (`~/.config/yandex-disk-mcp/chrome-profile`) — sign in to Yandex.
2. In the same window Yandex issues an OAuth token for your app (on the first login, click "Allow").
3. The token and the session cookie are saved to `~/.config/yandex-disk-mcp/credentials.json` (mode 600) and work at once, no restart.

After that it is automatic: when the shared-folders cookie expires, it is refreshed in the background from the saved profile. If the profile session has expired too, tools ask you to call `login` again.

Works on any OS and in any shell (zsh is not needed); on Windows `~` is `C:\Users\<name>`. Any Chromium-based browser is required: Chrome, Edge, Yandex Browser, Brave, Vivaldi, Chromium (set the path in `YANDEX_CHROME_PATH`), and Node.js ≥ 22.

**Firefox and Safari** do not support automatic login — manual mode only. Do this: open `https://oauth.yandex.ru/authorize?response_type=token&client_id=<CLIENT_ID>` in any browser and copy `access_token` from the address bar; the cookie is the `Cookie` header of any `models-v2` request on disk.yandex.ru (DevTools → Network). Pass them to `login` (`token`, `cookie`) or `npm run login -- --token <T> --cookie <C>`. Automatic cookie refresh does not work in this mode.

> ⚠️ The cookie gives full access to your Yandex account, the token — to your Disk. `credentials.json` is protected by mode 600; do not put it in a repository. A separate browser profile isolates the session from your main browser. To revoke: https://id.yandex.com/security → "Sign out on all devices". If you click "Sign out" in the profile, the cookie stops working.

### Environment variables (optional)

They override the saved values — for example in Docker/CI, where there is no browser.

| Variable | Purpose |
|---|---|
| `YANDEX_DISK_TOKEN` | OAuth token (`y0_…`) |
| `YANDEX_SESSION_COOKIE` | Browser session cookie (the `Cookie` header of a `models-v2` request on disk.yandex.ru) |
| `YANDEX_CLIENT_ID` | OAuth app Client ID |
| `YANDEX_ORG_ID` | Yandex 360 organization ID for `list_shared_disks` |
| `YANDEX_CHROME_PATH` | Path to a Chromium-based browser if it is in a non-standard place |

> ⚠️ A variable **overrides** the saved value. A stale `YANDEX_DISK_TOKEN` or `YANDEX_SESSION_COOKIE` in the environment gives 401 even after a successful `login` — remove it (`unset`, edit `~/.zshenv`, etc.).

## Connecting

### Claude Code

```bash
claude mcp add yandex-disk --scope user -- node /path/to/yandex-disk-mcp/dist/index.js
```

No secrets in the config. Then ask: "log in to Yandex Disk".

> Do not edit `~/.claude.json` by hand while Claude is running — the file may be overwritten. Use `claude mcp add`.

### Claude Desktop / Cursor / other clients

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

No variables needed: if there is no login, the tool answers "call the `login` tool".

### Docker

```bash
docker build -t yandex-disk-mcp .
docker run -i --rm -e YANDEX_DISK_TOKEN -e YANDEX_SESSION_COOKIE yandex-disk-mcp
```

There is no browser in the container, so `login` does not work and the cookie does not refresh itself: take the token and cookie manually (see "Login") and renew the cookie when it expires. `-e VAR` without a value takes it from the current environment. With compose: `docker compose run --rm -T yandex-disk-mcp` (variables from `.env`; `-T` disables the TTY, which can break stdio exchange).

> In the container, `upload_file` and `shared_upload_file` see only container files — mount a folder to upload from the host (`-v ~/Uploads:/uploads`).

## Paths

| Where | Format | Example |
|---|---|---|
| Your Disk | `disk:/…` | `disk:/Projects/report.pdf` |
| Shared folders | `<shared folder name>/…` | `ADV Team 2/Tasks 2026/New folder` |
| Inside a public link | link + `path` | `https://yadi.sk/d/…` + `/subfolder` |

The shared folder name is as in `list_shared_with_me`. A destination path ending in `/` keeps the local file name on upload. Writing to shared folders needs the `write` right.

## Example prompts

- "What is on my Disk?"
- "Which shared folders do I have?"
- "Show the contents of ADV Team 2/Tasks 2026"
- "Create the folder ADV Team 2/Tasks 2026/New project"
- "Upload ~/Desktop/report.pdf to ADV Team 2/Tasks 2026/"
- "Make disk:/photo.jpg public and give me the link"
- "What is in the trash? Restore the last deleted file"

## How it works

- `src/yandex-disk-client.ts` — official REST API (`cloud-api.yandex.net/v1/disk`), OAuth token.
- `src/yandex-disk-web-client.ts` — **undocumented** web API (`disk.yandex.ru/models-v2`, for Yandex 360 accounts `disk.360.yandex.ru`, the host is detected from the redirect), cookie + the `sk` CSRF token from the Disk page. Methods: `mpfs/resources`, `mpfs/mkdir`, `mpfs/bulk-async-move`, `mpfs/bulk-async-copy`, `mpfs/bulk-async-delete`, `mpfs/bulk-operation-status`, `mpfs/store`. May break without notice.
- `src/credentials.ts` — token and cookie store (`credentials.json`, mode 600); environment variables override it.
- `src/cookie-source.ts` — login and cookie refresh through a Chromium-based browser over the DevTools protocol (separate profile), OAuth token issue.
- `src/login-cli.ts` — the same from a terminal: `npm run login`.
- `src/local-file.ts` — streaming reads of local files, hashes, PUT.

The public REST API does not return the "Shared" list and cannot write to other people's folders — hence the web API.

## Limitations

- Search (`shared_search`, `search_files` with `query`) is the web client's own search and is slow on Yandex's side: 2–11 s per page of 20. The server cannot limit the area to one shared folder, so `folder` filters hits here and may need several pages; one call stops after about 30 s and returns an `iteration_key` to continue.
- Writing to a read-only shared folder — the error format is not verified.
- `list_shared_folder` returns up to 40 items per request — use `offset` for more.
- Move/delete waits up to 15 s; for large folders it returns "in progress" and the operation continues on Yandex's side.

## License

MIT — see [LICENSE](LICENSE).
