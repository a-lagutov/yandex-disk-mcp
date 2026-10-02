#!/usr/bin/env node

/**
 * Yandex Disk MCP Server
 *
 * Universal MCP server for Yandex Disk file management.
 * Supports: listing, upload, download, copy, move, delete,
 * public links, trash, disk info, and more.
 *
 * Starts without credentials; call the `login` tool to sign in.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { YandexDiskClient, Resource } from "./yandex-disk-client.js";
import { loginAndSave, refreshStoredCookie } from "./cookie-source.js";
import { loadCredentials, saveCredentials } from "./credentials.js";
import { YandexDiskWebClient, SharedResource } from "./yandex-disk-web-client.js";
import { openLocalFile, putFile, resolveDestinationPath } from "./local-file.js";
import { basename } from "node:path";

// ─── Init ───────────────────────────────────────────────

// No credentials are required to start: the server starts logged out and the `login`
// tool signs in (credential store, see credentials.ts; env variables override it)
const initialCredentials = loadCredentials();
const client = new YandexDiskClient(initialCredentials.token ?? "");

// Browser session cookie for the internal web API (shared folders); an expired
// cookie is refreshed automatically from the saved Chrome profile
const webClient = new YandexDiskWebClient(initialCredentials.cookie ?? "", refreshStoredCookie);

const server = new McpServer({
  name: "yandex-disk",
  version: "1.0.0",
});

// ─── Helpers ────────────────────────────────────────────

function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}

function formatResource(r: Resource): string {
  const icon = r.type === "dir" ? "📁" : "📄";
  const size = r.size ? ` (${formatSize(r.size)})` : "";
  const pub = r.public_url ? ` 🔗 ${r.public_url}` : "";
  return `${icon} ${r.name}${size} — ${r.path}${pub}`;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ─── Tool: login ────────────────────────────────────────

server.tool(
  "login",
  "Sign in to Yandex: opens a Chrome window (separate profile) where the user logs in to " +
    "Yandex once; obtains the session cookie (shared folders) and, if an OAuth app client ID " +
    "is known, the OAuth token (own Disk). Credentials are saved and used immediately. " +
    "Call this when other tools report that the user is not logged in. Without a Chromium-based " +
    "browser, pass `token` and/or `cookie` obtained manually instead.",
  {
    token: z.string().optional().describe("OAuth token (y0_…) to save as is, no browser needed"),
    cookie: z
      .string()
      .optional()
      .describe("Cookie header of a disk.yandex.ru request to save as is, no browser needed"),
    client_id: z
      .string()
      .optional()
      .describe(
        "Client ID of the OAuth app from https://oauth.yandex.ru (needs cloud_api:disk.* rights, " +
          "redirect URI https://oauth.yandex.ru/verification_code). Saved for next time."
      ),
  },
  async ({ client_id, token: manualToken, cookie: manualCookie }) => {
    // Manual mode: credentials were obtained by the user, skip the browser entirely
    if (manualToken || manualCookie) {
      saveCredentials({
        ...(manualToken ? { token: manualToken.trim() } : {}),
        ...(manualCookie ? { cookie: manualCookie.trim() } : {}),
        ...(client_id ? { clientId: client_id } : {}),
      });
      if (manualToken) client.setToken(manualToken.trim());
      if (manualCookie) webClient.setCookie(manualCookie.trim());
      return textResult(
        `✅ Saved: ${[manualToken && "OAuth token", manualCookie && "session cookie"]
          .filter(Boolean)
          .join(" + ")}.`
      );
    }
    try {
      const { cookie, token, clientId } = await loginAndSave(client_id);
      webClient.setCookie(cookie);
      if (token) client.setToken(token);
      return textResult(
        "✅ Logged in. Shared folders: available." +
          (token
            ? " Own Disk: available."
            : clientId
              ? " Own Disk: token was not issued — try login again."
              : " Own Disk: needs an OAuth app — call login again with client_id.")
      );
    } catch (error) {
      return textResult(`❌ Login failed: ${(error as Error).message}`);
    }
  }
);

// ─── Tool: disk_info ────────────────────────────────────

server.tool(
  "disk_info",
  "Get Yandex Disk storage info: total space, used space, trash size",
  {},
  async () => {
    const info = await client.getDiskInfo();
    const text = [
      `💽 Yandex Disk Info`,
      `Total:  ${formatSize(info.total_space)}`,
      `Used:   ${formatSize(info.used_space)}`,
      `Free:   ${formatSize(info.total_space - info.used_space)}`,
      `Trash:  ${formatSize(info.trash_size)}`,
    ].join("\n");
    return textResult(text);
  }
);

// ─── Tool: list_files ───────────────────────────────────

server.tool(
  "list_files",
  "List files and folders at a given path on Yandex Disk",
  {
    path: z
      .string()
      .default("disk:/")
      .describe("Path on Yandex Disk, e.g. 'disk:/' or 'disk:/Documents'"),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe("Max number of items to return (default 20)"),
    offset: z.number().optional().default(0).describe("Offset for pagination"),
    sort: z
      .string()
      .optional()
      .describe("Sort field: name, path, created, modified, size. Prefix with '-' for desc"),
  },
  async ({ path, limit, offset, sort }) => {
    const resource = await client.getResource(path, { limit, offset, sort });
    if (!resource._embedded) {
      return textResult(formatResource(resource));
    }
    const items = resource._embedded.items.map(formatResource);
    const header = `📂 ${resource.path} (${resource._embedded.total} items, showing ${resource._embedded.offset + 1}–${resource._embedded.offset + items.length})`;
    return textResult([header, "", ...items].join("\n"));
  }
);

// ─── Tool: get_file_info ────────────────────────────────

server.tool(
  "get_file_info",
  "Get detailed metadata for a file or folder on Yandex Disk",
  {
    path: z.string().describe("Path to the file/folder, e.g. 'disk:/report.pdf'"),
  },
  async ({ path }) => {
    const r = await client.getResource(path);
    const lines = [
      `Name:     ${r.name}`,
      `Type:     ${r.type}`,
      `Path:     ${r.path}`,
      `Created:  ${r.created}`,
      `Modified: ${r.modified}`,
    ];
    if (r.size !== undefined) lines.push(`Size:     ${formatSize(r.size)}`);
    if (r.mime_type) lines.push(`MIME:     ${r.mime_type}`);
    if (r.md5) lines.push(`MD5:      ${r.md5}`);
    if (r.public_url) lines.push(`Public:   ${r.public_url}`);
    return textResult(lines.join("\n"));
  }
);

// ─── Tool: create_folder ────────────────────────────────

server.tool(
  "create_folder",
  "Create a new folder on Yandex Disk",
  {
    path: z.string().describe("Path for the new folder, e.g. 'disk:/New Folder'"),
  },
  async ({ path }) => {
    await client.createFolder(path);
    return textResult(`✅ Folder created: ${path}`);
  }
);

// ─── Tool: delete ───────────────────────────────────────

server.tool(
  "delete",
  "Delete a file or folder on Yandex Disk (moves to trash by default)",
  {
    path: z.string().describe("Path to delete, e.g. 'disk:/old-file.txt'"),
    permanently: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, delete permanently instead of moving to trash"),
  },
  async ({ path, permanently }) => {
    await client.deleteResource(path, permanently);
    const mode = permanently ? "permanently deleted" : "moved to trash";
    return textResult(`🗑️ ${path} — ${mode}`);
  }
);

// ─── Tool: copy ─────────────────────────────────────────

server.tool(
  "copy",
  "Copy a file or folder on Yandex Disk",
  {
    from: z.string().describe("Source path, e.g. 'disk:/file.txt'"),
    to: z.string().describe("Destination path, e.g. 'disk:/backup/file.txt'"),
    overwrite: z.boolean().optional().default(false).describe("Overwrite if exists"),
  },
  async ({ from, to, overwrite }) => {
    await client.copyResource(from, to, overwrite);
    return textResult(`📋 Copied: ${from} → ${to}`);
  }
);

// ─── Tool: move ─────────────────────────────────────────

server.tool(
  "move",
  "Move or rename a file or folder on Yandex Disk",
  {
    from: z.string().describe("Source path"),
    to: z.string().describe("Destination path"),
    overwrite: z.boolean().optional().default(false).describe("Overwrite if exists"),
  },
  async ({ from, to, overwrite }) => {
    await client.moveResource(from, to, overwrite);
    return textResult(`📦 Moved: ${from} → ${to}`);
  }
);

// ─── Tool: get_download_link ────────────────────────────

server.tool(
  "get_download_link",
  "Get a temporary download link for a file on Yandex Disk",
  {
    path: z.string().describe("Path to the file, e.g. 'disk:/photo.jpg'"),
  },
  async ({ path }) => {
    const link = await client.getDownloadLink(path);
    return textResult(`⬇️ Download link for ${path}:\n${link.href}`);
  }
);

// ─── Tool: get_upload_link ──────────────────────────────

server.tool(
  "get_upload_link",
  "Get an upload URL to upload a file to Yandex Disk. Use the returned URL with PUT to upload file content.",
  {
    path: z.string().describe("Destination path on disk, e.g. 'disk:/uploads/report.pdf'"),
    overwrite: z.boolean().optional().default(false).describe("Overwrite if file exists"),
  },
  async ({ path, overwrite }) => {
    const link = await client.getUploadLink(path, overwrite);
    return textResult(
      `⬆️ Upload URL for ${path}:\n${link.href}\n\nUse HTTP PUT with file content to this URL.`
    );
  }
);

// ─── Tool: upload_file ──────────────────────────────────

server.tool(
  "upload_file",
  "Upload a local file to your Yandex Disk (official API: upload link + PUT)",
  {
    local_path: z.string().describe("Absolute path of the local file, e.g. '/Users/me/report.pdf'"),
    path: z
      .string()
      .describe("Destination on disk, e.g. 'disk:/uploads/report.pdf'. Ending with '/' keeps the local file name"),
    overwrite: z.boolean().optional().default(false).describe("Overwrite if exists"),
  },
  async ({ local_path, path, overwrite }) => {
    const file = await openLocalFile(local_path);
    const destination = resolveDestinationPath(path, file.name);
    const link = await client.getUploadLink(destination, overwrite);
    await putFile(link.href, file);
    return textResult(`⬆️ Uploaded: ${local_path} → ${destination} (${formatSize(file.size)})`);
  }
);

// ─── Tool: upload_from_url ──────────────────────────────

server.tool(
  "upload_from_url",
  "Upload a file to Yandex Disk from an external URL",
  {
    path: z.string().describe("Destination path on disk"),
    url: z.string().describe("URL of the file to upload"),
  },
  async ({ path, url }) => {
    await client.uploadByUrl(path, url);
    return textResult(`⬆️ Upload started from URL → ${path}`);
  }
);

// ─── Tool: publish ──────────────────────────────────────

server.tool(
  "publish",
  "Make a file or folder publicly accessible via link",
  {
    path: z.string().describe("Path to publish"),
  },
  async ({ path }) => {
    await client.publishResource(path);
    const resource = await client.getResource(path);
    return textResult(`🔗 Published: ${path}\nPublic URL: ${resource.public_url ?? "(pending)"}`);
  }
);

// ─── Tool: unpublish ────────────────────────────────────

server.tool(
  "unpublish",
  "Remove public access from a file or folder",
  {
    path: z.string().describe("Path to unpublish"),
  },
  async ({ path }) => {
    await client.unpublishResource(path);
    return textResult(`🔒 Unpublished: ${path}`);
  }
);

// ─── Tool: list_public ──────────────────────────────────

server.tool(
  "list_public",
  "List all publicly shared files and folders",
  {
    limit: z.number().optional().default(20).describe("Max items"),
    offset: z.number().optional().default(0).describe("Offset"),
    type: z
      .enum(["dir", "file"])
      .optional()
      .describe("Filter by type: 'dir' or 'file'"),
  },
  async ({ limit, offset, type }) => {
    const result = await client.getPublicResources({ limit, offset, type });
    if (result.items.length === 0) {
      return textResult("No public resources found.");
    }
    const header = `🔗 Public resources (${result.total} total):`;
    const items = result.items.map(formatResource);
    return textResult([header, "", ...items].join("\n"));
  }
);

// ─── Tool: list_trash ───────────────────────────────────

server.tool(
  "list_trash",
  "List files in the Yandex Disk trash",
  {
    limit: z.number().optional().default(20).describe("Max items"),
    offset: z.number().optional().default(0).describe("Offset"),
  },
  async ({ limit, offset }) => {
    const trash = await client.getTrash({ limit, offset });
    if (!trash._embedded || trash._embedded.items.length === 0) {
      return textResult("🗑️ Trash is empty.");
    }
    const header = `🗑️ Trash (${trash._embedded.total} items):`;
    const items = trash._embedded.items.map(formatResource);
    return textResult([header, "", ...items].join("\n"));
  }
);

// ─── Tool: restore_from_trash ───────────────────────────

server.tool(
  "restore_from_trash",
  "Restore a file or folder from the trash",
  {
    path: z.string().describe("Path in trash, e.g. 'trash:/old-file.txt'"),
    name: z.string().optional().describe("New name after restoring (optional)"),
    overwrite: z.boolean().optional().default(false).describe("Overwrite if exists"),
  },
  async ({ path, name, overwrite }) => {
    await client.restoreFromTrash(path, name, overwrite);
    return textResult(`♻️ Restored from trash: ${path}${name ? ` as ${name}` : ""}`);
  }
);

// ─── Tool: clear_trash ──────────────────────────────────

server.tool(
  "clear_trash",
  "Clear the trash (delete all or a specific item permanently)",
  {
    path: z
      .string()
      .optional()
      .describe("Specific trash path to delete, or omit to clear entire trash"),
  },
  async ({ path }) => {
    await client.clearTrash(path);
    return textResult(path ? `🗑️ Permanently deleted from trash: ${path}` : "🗑️ Trash cleared.");
  }
);

// ─── Tool: search_files ─────────────────────────────────

server.tool(
  "search_files",
  "Search your own Disk by name (`query`), or list all files with an optional media type filter. " +
    "Name search needs a session (see `login`) and ignores media_type/sort.",
  {
    query: z.string().optional().describe("Text to look for in names; omit to list all files"),
    limit: z.number().optional().default(20).describe("Max items"),
    offset: z.number().optional().default(0).describe("Offset"),
    media_type: z
      .string()
      .optional()
      .describe(
        "Filter by media type: audio, backup, book, compressed, data, development, diskimage, document, encoded, executable, flash, font, image, settings, spreadsheet, text, unknown, video, web"
      ),
    sort: z
      .string()
      .optional()
      .describe("Sort: name, path, created, modified, size (prefix '-' for desc)"),
  },
  async ({ query, limit, offset, media_type, sort }) => {
    if (query) {
      // The REST API has no name search; the web client's search box does
      const page = await webClient.searchResources(query, { scope: "/disk", amount: limit, offset });
      if (page.resources.length === 0) return textResult(`Nothing found for "${query}".`);
      const lines = await Promise.all(page.resources.map(formatSearchHit));
      return textResult([`🔎 "${query}" (showing ${lines.length}, offset ${offset}):`, "", ...lines].join("\n"));
    }
    const result = await client.getFlatFileList({ limit, offset, media_type, sort });
    if (result.items.length === 0) {
      return textResult("No files found matching criteria.");
    }
    const items = result.items.map(formatResource);
    return textResult([`📄 Files (showing ${items.length}):`, "", ...items].join("\n"));
  }
);

// ─── Tool: last_uploaded ────────────────────────────────

server.tool(
  "last_uploaded",
  "Get recently uploaded files",
  {
    limit: z.number().optional().default(10).describe("Number of files to return"),
    media_type: z.string().optional().describe("Filter by media type"),
  },
  async ({ limit, media_type }) => {
    const result = await client.getLastUploaded({ limit, media_type });
    if (result.items.length === 0) {
      return textResult("No recently uploaded files.");
    }
    const items = result.items.map(formatResource);
    return textResult(["⏱️ Recently uploaded:", "", ...items].join("\n"));
  }
);

// ─── Tool: list_shared_disks ────────────────────────────

server.tool(
  "list_shared_disks",
  "List Yandex 360 organization shared disks the user has access to, with permissions. " +
    "Note: personal shared folders (invites from other users) are not exposed by the public API.",
  {
    org_id: z
      .string()
      .optional()
      .describe(
        "Yandex 360 organization ID. Optional: defaults to YANDEX_ORG_ID env variable, " +
          "otherwise all organizations of the user are discovered automatically"
      ),
    limit: z.number().optional().default(20).describe("Max items per organization (1–100)"),
    offset: z.number().optional().default(0).describe("Offset"),
  },
  async ({ org_id, limit, offset }) => {
    const explicitOrgId = org_id ?? process.env.YANDEX_ORG_ID;

    // Without an explicit ID, discover organizations via Yandex 360 Directory API
    let organizations: { id: string; name?: string }[];
    if (explicitOrgId) {
      organizations = [{ id: explicitOrgId }];
    } else {
      try {
        const found = await client.getOrganizations();
        organizations = found.map((org) => ({ id: String(org.id), name: org.name }));
      } catch (error) {
        return textResult(
          `❌ Could not detect organization automatically: ${(error as Error).message}\n` +
            "Add the `directory:read_organization` scope to the OAuth app and reissue the token, " +
            "or pass org_id / set YANDEX_ORG_ID."
        );
      }
      if (organizations.length === 0) {
        return textResult("No Yandex 360 organizations found for this account.");
      }
    }

    const sections: string[] = [];
    for (const organization of organizations) {
      const result = await client.getSharedDisks(organization.id, { limit, offset });
      const title = organization.name
        ? `${organization.name} (org ${organization.id})`
        : `org ${organization.id}`;
      if (result.items.length === 0) {
        sections.push(`🏢 ${title}: no shared disks available.`);
        continue;
      }
      const items = result.items.map(
        (disk) =>
          `🗄️ ${disk.name} — ${formatSize(disk.used_space)} / ${formatSize(disk.total_space)}` +
          ` — rights: ${disk.permissions.join(", ") || "none"} — id: ${disk.resource_id}`
      );
      sections.push([`🏢 ${title} — ${result.total} shared disks:`, ...items].join("\n"));
    }
    return textResult(sections.join("\n\n"));
  }
);

// ─── Tool: list_shared_with_me ──────────────────────────

/**
 * Format a shared resource as one line: name, owner, rights and public link.
 * @param resource - item from the "Общий доступ" page
 */
function formatSharedResource(resource: SharedResource): string {
  const icon = resource.type === "dir" ? "📁" : "📄";
  const owner = resource.owner?.self ? "you" : resource.owner?.displayName ?? "unknown";
  const rights = resource.meta?.rights?.join(", ") || "unknown";
  const link = resource.meta?.short_url ? ` 🔗 ${resource.meta.short_url}` : "";
  return `${icon} ${resource.name} — owner: ${owner} — rights: ${rights}${link}`;
}

server.tool(
  "list_shared_with_me",
  "List folders or files shared with the user (the 'Общий доступ' page of Yandex Disk web), " +
    "with owner, access rights and public link. Browse a folder's contents with list_public_folder " +
    "using its link. Uses the undocumented web API.",
  {
    type: z
      .enum(["folders", "files"])
      .optional()
      .default("folders")
      .describe("What to list: 'folders' (default) or 'files'"),
    limit: z.number().optional().default(40).describe("Max items per page (1–40)"),
    iteration_key: z
      .string()
      .optional()
      .describe("Continuation key from the previous page to get the next one"),
  },
  async ({ type, limit, iteration_key }) => {
    if (!webClient) {
      return textResult(
        "❌ YANDEX_SESSION_COOKIE is not set.\n" +
          "Copy the Cookie header of any disk.yandex.ru request from browser DevTools " +
          "and put it into the server env as YANDEX_SESSION_COOKIE."
      );
    }
    const page = await webClient.getSharedResources(type, {
      amount: limit,
      iterationKey: iteration_key,
    });
    if (page.resources.length === 0) {
      return textResult(`No shared ${type} found.`);
    }
    const lines = [
      `🤝 Shared ${type} (showing ${page.resources.length}):`,
      "",
      ...page.resources.map(formatSharedResource),
    ];
    // A full page means there may be more; hand the key back for pagination
    if (page.iteration_key && page.resources.length >= Math.min(limit, 40)) {
      lines.push("", `More available — iteration_key: ${page.iteration_key}`);
    }
    return textResult(lines.join("\n"));
  }
);

// ─── Shared folders: read / write via web API ───────────

const SHARED_PATH_DESCRIPTION =
  "Path inside a shared folder: '<shared folder name>/sub/path' " +
  "(e.g. 'ADV Team 2/Tasks 2026') or internal path ('/aa/d_…/sub')";

const MISSING_COOKIE_MESSAGE =
  "❌ Not logged in — call the `login` tool.";

/**
 * Describe the result of an async web operation for the user.
 * @param action - what was done, e.g. "Moved: a → b"
 * @param state - final state from waitForOperation
 */
function operationResult(action: string, state: "done" | "failed" | "in-progress") {
  if (state === "done") return textResult(`✅ ${action}`);
  if (state === "failed") return textResult(`❌ Failed: ${action}`);
  return textResult(`⏳ Still in progress (large folder?): ${action}`);
}

server.tool(
  "list_shared_folder",
  "List contents of a folder shared with the user (including subfolders without public links). " +
    "Requires a session (see `login`).",
  {
    path: z.string().describe(SHARED_PATH_DESCRIPTION),
    limit: z.number().optional().default(40).describe("Max items (1–40)"),
    offset: z.number().optional().default(0).describe("Offset"),
  },
  async ({ path, limit, offset }) => {
    if (!webClient) return textResult(MISSING_COOKIE_MESSAGE);
    const internalPath = await webClient.resolvePath(path);
    const items = await webClient.listFolder(internalPath, { amount: limit, offset });
    if (items.length === 0) {
      return textResult(`📂 ${path} is empty.`);
    }
    const lines = items.map((item) => `${item.type === "dir" ? "📁" : "📄"} ${item.name}`);
    return textResult([`📂 ${path} (showing ${items.length}):`, "", ...lines].join("\n"));
  }
);

/** Format one search hit as a line with its readable path. */
async function formatSearchHit(resource: SharedResource): Promise<string> {
  const icon = resource.type === "dir" ? "📁" : "📄";
  const size = resource.meta?.size ? ` (${formatSize(resource.meta.size)})` : "";
  return `${icon} ${resource.name.trim()}${size} — ${await webClient.toDisplayPath(resource.path)}`;
}

server.tool(
  "shared_search",
  "Search files and folders shared with the user by name (all shared folders at once, or one " +
    "shared folder). Requires a session (see `login`). Next page: pass `iteration_key` from the " +
    "previous answer.",
  {
    query: z.string().describe("Text to look for in names"),
    folder: z
      .string()
      .optional()
      .describe(`Limit to one shared folder or subfolder. ${SHARED_PATH_DESCRIPTION}`),
    limit: z.number().optional().default(20).describe("Wanted number of hits (may return a bit more)"),
    iteration_key: z.string().optional().describe("Continuation key from the previous answer"),
  },
  async ({ query, folder, limit, iteration_key }) => {
    if (!webClient) return textResult(MISSING_COOKIE_MESSAGE);
    const { resources, iterationKey } = await webClient.searchShared(query, {
      folder,
      limit,
      iterationKey: iteration_key,
    });
    if (resources.length === 0) {
      return textResult(
        `Nothing found for "${query}"` +
          (iterationKey
            ? ` yet — search is slow, not finished. Continue: iteration_key=${iterationKey}`
            : ".")
      );
    }
    const lines = await Promise.all(resources.map(formatSearchHit));
    const footer = iterationKey ? ["", `More: iteration_key=${iterationKey}`] : [];
    return textResult(
      [`🔎 "${query}"${folder ? ` in ${folder}` : ""} (showing ${lines.length}):`, "", ...lines, ...footer].join("\n")
    );
  }
);

server.tool(
  "shared_create_folder",
  "Create a folder inside a shared folder (needs write rights).",
  {
    path: z.string().describe(`${SHARED_PATH_DESCRIPTION} — of the new folder`),
  },
  async ({ path }) => {
    if (!webClient) return textResult(MISSING_COOKIE_MESSAGE);
    const internalPath = await webClient.resolvePath(path);
    await webClient.createFolder(internalPath);
    return textResult(`✅ Folder created: ${path}`);
  }
);

server.tool(
  "shared_move",
  "Move or rename a file/folder inside shared folders (needs write rights). " +
    "'to' is the full new path including the name.",
  {
    from: z.string().describe(SHARED_PATH_DESCRIPTION),
    to: z.string().describe(`${SHARED_PATH_DESCRIPTION} — full destination path`),
    overwrite: z.boolean().optional().default(false).describe("Overwrite if exists"),
  },
  async ({ from, to, overwrite }) => {
    if (!webClient) return textResult(MISSING_COOKIE_MESSAGE);
    const sourcePath = await webClient.resolvePath(from);
    const destinationPath = await webClient.resolvePath(to);
    const oid = await webClient.moveResource(sourcePath, destinationPath, overwrite);
    const state = await webClient.waitForOperation(oid);
    return operationResult(`Moved: ${from} → ${to}`, state);
  }
);

server.tool(
  "shared_copy",
  "Copy a file/folder inside shared folders (needs write rights at the destination). " +
    "'to' is the full new path including the name.",
  {
    from: z.string().describe(SHARED_PATH_DESCRIPTION),
    to: z.string().describe(`${SHARED_PATH_DESCRIPTION} — full destination path`),
    overwrite: z.boolean().optional().default(false).describe("Overwrite if exists"),
  },
  async ({ from, to, overwrite }) => {
    if (!webClient) return textResult(MISSING_COOKIE_MESSAGE);
    const sourcePath = await webClient.resolvePath(from);
    const destinationPath = await webClient.resolvePath(to);
    const oid = await webClient.copyResource(sourcePath, destinationPath, overwrite);
    const state = await webClient.waitForOperation(oid);
    return operationResult(`Copied: ${from} → ${to}`, state);
  }
);

server.tool(
  "shared_delete",
  "Delete a file/folder inside a shared folder (moves it to the owner's trash; needs write rights). " +
    "Requires a session (see `login`).",
  {
    path: z.string().describe(SHARED_PATH_DESCRIPTION),
  },
  async ({ path }) => {
    if (!webClient) return textResult(MISSING_COOKIE_MESSAGE);
    const internalPath = await webClient.resolvePath(path);
    // Refuse to delete a whole shared folder root — too destructive for a path typo
    if (/^\/aa\/[^/]+$/.test(internalPath)) {
      return textResult(`❌ Refusing to delete the shared folder root itself: ${path}`);
    }
    const oid = await webClient.deleteResource(internalPath);
    const state = await webClient.waitForOperation(oid);
    return operationResult(`Moved to trash: ${path}`, state);
  }
);

server.tool(
  "shared_upload_file",
  "Upload a local file into a shared folder (needs write rights). Uses the undocumented " +
    "web API (mpfs/store).",
  {
    local_path: z.string().describe("Absolute path of the local file, e.g. '/Users/me/report.pdf'"),
    path: z
      .string()
      .describe(
        `${SHARED_PATH_DESCRIPTION} — destination. Ending with '/' keeps the local file name`
      ),
    overwrite: z.boolean().optional().default(false).describe("Overwrite if exists"),
  },
  async ({ local_path, path, overwrite }) => {
    if (!webClient) return textResult(MISSING_COOKIE_MESSAGE);
    const destination = resolveDestinationPath(path, basename(local_path));
    const internalPath = await webClient.resolvePath(destination);
    const result = await webClient.uploadFile(local_path, internalPath, overwrite);
    const note = result === "hardlinked" ? " (identical content already on Disk, linked instantly)" : "";
    return textResult(`⬆️ Uploaded: ${local_path} → ${destination}${note}`);
  }
);

// ─── Tool: list_public_folder ───────────────────────────

server.tool(
  "list_public_folder",
  "List contents of a shared/public folder by its public link (e.g. https://yadi.sk/d/...) " +
    "or public key. Works for links returned by list_shared_with_me and list_public.",
  {
    public_key: z.string().describe("Public URL (https://yadi.sk/d/...) or public key"),
    path: z
      .string()
      .optional()
      .describe("Relative path inside the folder, e.g. '/subfolder'"),
    limit: z.number().optional().default(20).describe("Max items"),
    offset: z.number().optional().default(0).describe("Offset"),
    sort: z
      .string()
      .optional()
      .describe("Sort field: name, created, modified, size. Prefix with '-' for desc"),
  },
  async ({ public_key, path, limit, offset, sort }) => {
    const resource = await client.getPublicResource(public_key, { path, limit, offset, sort });
    if (!resource._embedded) {
      return textResult(formatResource(resource));
    }
    const items = resource._embedded.items.map(formatResource);
    const header = `📂 ${resource.name}${path ? ` ${path}` : ""} (${resource._embedded.total} items, showing ${resource._embedded.offset + 1}–${resource._embedded.offset + items.length})`;
    return textResult([header, "", ...items].join("\n"));
  }
);

// ─── Tool: get_public_download_link ─────────────────────

server.tool(
  "get_public_download_link",
  "Get a download link for a file (or a folder as zip) inside a shared/public folder",
  {
    public_key: z.string().describe("Public URL (https://yadi.sk/d/...) or public key"),
    path: z
      .string()
      .optional()
      .describe("Relative path of the file inside the folder, e.g. '/report.pdf'"),
  },
  async ({ public_key, path }) => {
    const link = await client.getPublicDownloadLink(public_key, path);
    return textResult(`⬇️ Download link${path ? ` for ${path}` : ""}:\n${link.href}`);
  }
);

// ─── Tool: operation_status ─────────────────────────────

server.tool(
  "operation_status",
  "Check the status of an async operation (copy/move/delete of large files)",
  {
    operation_id: z.string().describe("Operation ID returned by a previous async operation"),
  },
  async ({ operation_id }) => {
    const status = await client.getOperationStatus(operation_id);
    const emoji =
      status.status === "success" ? "✅" : status.status === "failure" ? "❌" : "⏳";
    return textResult(`${emoji} Operation ${operation_id}: ${status.status}`);
  }
);

// ─── Start ──────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
