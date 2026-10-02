/**
 * Yandex Disk web client (internal, undocumented API of disk.yandex.ru).
 *
 * Used only for what the public REST API does not expose: the list of
 * resources shared with the user ("Общий доступ" page). Authenticates with
 * the browser session cookie and the `sk` CSRF token from the web page.
 * The API may change without notice.
 */

import { randomUUID } from "node:crypto";
import { hashLocalFile, openLocalFile, putFile } from "./local-file.js";

/** How long one shared search call may keep fetching pages. */
const SEARCH_TIME_BUDGET_MS = 30_000;
/** The server returns 20 items per search page whatever `amount` says. */
const SEARCH_PAGE_SIZE = 20;
const SEARCH_MAX_PARALLEL_PAGES = 4;
/** Limits of the folder walk: simultaneous listings and total folders per call. */
const WALK_CONCURRENCY = 8;
const WALK_MAX_FOLDERS = 3000;

/** How long a folder-walk continuation stays valid, and how many are kept. */
const WALK_SESSION_TTL_MS = 30 * 60_000;
const WALK_SESSION_MAX = 20;

/** Prefix that marks a folder-walk continuation key (server-search keys are base64). */
const WALK_KEY_PREFIX = "walk:";

/** Lower-cased query without the double quotes used for whole-word server search. */
function plainNeedle(query: string): string {
  return query.replace(/"/g, "").toLowerCase();
}

/** Continuation key for "start at this offset" (`dir;;N`), as the server issues it. */
function makeOffsetKey(offset: number): string {
  return Buffer.from(`dir;;${offset}`).toString("base64");
}

/** Offset from an offset-style continuation key; null for time-cursor keys. */
function parseOffsetKey(iterationKey: string): number | null {
  const match = Buffer.from(iterationKey, "base64").toString().match(/^dir;;(\d+)$/);
  return match ? Number(match[1]) : null;
}

const WEB_ENTRY_URL ="https://disk.yandex.ru/client/disk";

/** Resource shown on the "Общий доступ" page. */
export interface SharedResource {
  id: string;
  name: string;
  path: string;
  type: "dir" | "file";
  mtime?: number;
  owner?: {
    displayName?: string;
    email?: string;
    self?: boolean;
    isOuter?: boolean;
  };
  meta?: {
    rights?: string[];
    public_hash?: string;
    short_url?: string;
    size?: number | null;
    /** Stable id of the item: does not change when it is renamed or moved */
    file_id?: string;
  };
}

/** One page of shared resources; pass `iteration_key` back to get the next one. */
export interface SharedResourcesPage {
  resources: SharedResource[];
  iteration_key?: string | null;
}

/** Context names used by the web client for the two tabs of the page. */
const SHARED_CONTEXTS = {
  folders: "/shared",
  files: "/shared_files",
} as const;

export type SharedKind = keyof typeof SHARED_CONTEXTS;

export class YandexDiskWebClient {
  private cookie: string;
  private sk: string | null = null;
  // Disk web host differs for Yandex 360 accounts (disk.360.yandex.ru), detected from redirect
  private origin: string | null = null;
  private organizationId: string | null = null;
  // Folders still to visit by an interrupted search, kept in memory for continuation
  private walkSessions = new Map<string, { query: string; queue: string[]; expiresAt: number }>();
  private sharedFoldersCache: { items: SharedResource[]; loadedAt: number } | null = null;

  /**
   * @param cookie - Cookie header value (may be empty if it will be fetched on demand)
   * @param reloadCookie - called when the cookie is rejected; returns a fresh one or null
   */
  constructor(cookie: string, private reloadCookie?: () => Promise<string | null>) {
    this.cookie = cookie;
  }

  /** Replace the cookie (after a login), no restart needed. */
  setCookie(cookie: string): void {
    this.cookie = cookie;
    this.sk = null;
    this.origin = null;
  }

  /**
   * Load the web client page and extract the `sk` CSRF token and the actual host.
   * @throws if the cookie is invalid or expired (redirect to login page)
   */
  private async refreshSession(isRetry: boolean = false): Promise<void> {
    // Follow redirects manually: fetch drops the Cookie header on cross-origin
    // redirects (disk.yandex.ru → disk.360.yandex.ru for Yandex 360 accounts)
    let currentUrl = new URL(WEB_ENTRY_URL);
    let response: Response | null = null;
    for (let redirectCount = 0; redirectCount < 5; redirectCount++) {
      if (!currentUrl.hostname.endsWith("yandex.ru")) {
        throw new Error(`Unexpected redirect to ${currentUrl.hostname}`);
      }
      response = await fetch(currentUrl, {
        headers: { Cookie: this.cookie, Accept: "text/html" },
        redirect: "manual",
      });
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) break;
      currentUrl = new URL(location, currentUrl);
    }
    if (!response) {
      throw new Error("Could not load Yandex Disk web page");
    }
    const finalUrl = currentUrl;
    if (finalUrl.hostname.startsWith("passport.")) {
      // Try to get a fresh cookie automatically (headless Chrome profile) before giving up
      if (!isRetry && this.reloadCookie) {
        const freshCookie = await this.reloadCookie();
        if (freshCookie) {
          this.cookie = freshCookie;
          return this.refreshSession(true);
        }
      }
      throw new Error(
        "Yandex session cookie is invalid or expired — call the `login` tool to log in again"
      );
    }
    const html = await response.text();
    // The token lives in <script id="preloaded-data"> as "sk":"<hex>:<timestamp>"
    const match = html.match(/"sk":"([0-9a-f]+:\d+)"/);
    if (!match) {
      throw new Error("Could not find sk token on Yandex Disk web page (web API changed?)");
    }
    this.sk = match[1];
    this.origin = finalUrl.origin;
    // Yandex 360 accounts carry their organization id in the page data (the journal needs it)
    this.organizationId = html.match(/"organizationIds":\["(\d+)"/)?.[1] ?? null;
  }

  /**
   * Call an internal `models-v2` method of the Disk web client.
   * Refreshes the session once if the cached `sk` is rejected.
   * @param apiMethod - internal method name, e.g. "mpfs/resources"
   * @param requestParams - method parameters
   * @returns the method's data payload
   */
  private async callModel<T>(
    apiMethod: string,
    requestParams: Record<string, unknown>,
    isRetry: boolean = false
  ): Promise<T> {
    if (!this.sk || !this.origin) {
      await this.refreshSession();
    }
    const response = await fetch(`${this.origin}/models-v2?m=${apiMethod}`, {
      method: "POST",
      headers: {
        Cookie: this.cookie,
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({ sk: this.sk, apiMethod, requestParams }),
    });

    const text = await response.text();
    // Error is either an object ({ title, message }) or a bare code string ("UNKNOWN_ERROR")
    let json: { error?: string | { statusCode?: number; title?: string; message?: string } } & T;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Yandex Disk web API error ${response.status}: ${text.slice(0, 200)}`);
    }

    if (!response.ok || json.error) {
      // Expired sk or session: reload the page token and try once more
      if (!isRetry && (response.status === 401 || response.status === 403)) {
        this.sk = null;
        return this.callModel<T>(apiMethod, requestParams, true);
      }
      const description =
        typeof json.error === "string"
          ? json.error
          : json.error?.title ?? json.error?.message ?? text.slice(0, 200);
      throw new Error(`Yandex Disk web API error ${response.status}: ${description}`);
    }
    return json;
  }

  /**
   * List folders or files shared with the user (the "Общий доступ" page).
   * @param kind - "folders" or "files"
   * @param options - page size and continuation key from the previous page
   */
  async getSharedResources(
    kind: SharedKind,
    options?: { amount?: number; iterationKey?: string }
  ): Promise<SharedResourcesPage> {
    return this.callModel<SharedResourcesPage>("mpfs/resources", {
      idContext: SHARED_CONTEXTS[kind],
      sort: "name",
      order: "1",
      // Web API accepts page size only in range 1–40
      amount: Math.min(Math.max(options?.amount ?? 40, 1), 40),
      offset: 0,
      iteration_key: options?.iterationKey ?? null,
      with_share: "1",
      isPDD: "1",
      shouldUseContactUser: "1",
      isPublicSavedLinks: "1",
    });
  }

  // ─── Search ───────────────────────────────────────────

  /**
   * Run one page of the web client's search (same request as the search box).
   * The server only searches whole areas: "/disk" (own Disk) or "/aa" (everything
   * shared with the user); narrowing to one folder is not supported (405).
   * @param query - text to look for
   * @param options - search area, page size and the continuation key / offset
   */
  async searchResources(
    query: string,
    options: { scope: "/disk" | "/aa"; amount?: number; offset?: number; iterationKey?: string }
  ): Promise<SharedResourcesPage> {
    return this.callModel<SharedResourcesPage>("mpfs/resources", {
      sort: "name",
      order: "1",
      idContext: `/search/${encodeURIComponent(query)}${options.scope}`,
      amount: Math.min(Math.max(options.amount ?? 40, 1), 40),
      offset: options.offset ?? 0,
      withParent: "1",
      iteration_key: options.iterationKey ?? null,
      querySearch: query,
      scopeSearch: options.scope,
      sessionIdSearch: { sessionId: `${Date.now()}-${Math.floor(Math.random() * 1e16)}` },
      with_share: "1",
    });
  }

  /**
   * Search everything shared with the user, optionally limited to one shared folder.
   * - No folder: the server search, pages fetched in parallel while the continuation
   *   key is an offset (`dir;;N`); sparse results switch to a time cursor, which is
   *   sequential only.
   * - With folder: the server cannot limit the area (405) and scanning its pages for a
   *   narrow folder is slow, so the folder tree is walked with fast listings instead.
   * @param query - text to look for
   * @param options - folder to limit to (user path), wanted hit count, continuation key,
   *   `exactName` to keep only items whose name contains the query (the server search is
   *   fuzzy and also matches paths and similar words)
   * @returns hits and the key of the next page (null when exhausted)
   */
  async searchShared(
    query: string,
    options: { folder?: string; limit: number; iterationKey?: string; exactName?: boolean }
  ): Promise<{ resources: SharedResource[]; iterationKey: string | null }> {
    // A walk continuation carries its own folder, so `folder` is not needed with it
    if (options.folder || options.iterationKey?.startsWith(WALK_KEY_PREFIX)) {
      return this.searchByWalking(query, options.folder, options.limit, options.iterationKey);
    }
    const hits: SharedResource[] = [];
    let iterationKey: string | null = options.iterationKey ?? null;
    // The time budget keeps one call bounded; the rest is reachable via the returned key
    const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
    while (hits.length < options.limit && Date.now() < deadline) {
      const startOffset = iterationKey === null ? 0 : parseOffsetKey(iterationKey);
      // Offset keys allow several pages at once; a cursor key must go one by one
      const pageCount =
        startOffset === null
          ? 1
          : Math.min(SEARCH_MAX_PARALLEL_PAGES, Math.ceil((options.limit - hits.length) / SEARCH_PAGE_SIZE));
      const keys = Array.from({ length: pageCount }, (_, index) =>
        startOffset === null
          ? iterationKey ?? undefined
          : index === 0
            ? iterationKey ?? undefined
            : makeOffsetKey(startOffset + index * SEARCH_PAGE_SIZE)
      );
      const pages = await Promise.all(
        keys.map((key) => this.searchResources(query, { scope: "/aa", iterationKey: key }))
      );
      iterationKey = null;
      for (const page of pages) {
        hits.push(
          ...page.resources.filter(
            (resource) =>
              !options.exactName || resource.name.toLowerCase().includes(plainNeedle(query))
          )
        );
        iterationKey = page.iteration_key ?? null;
        // Pages after a non-offset key were requested with guessed offsets: drop them
        if (!iterationKey || parseOffsetKey(iterationKey) === null) break;
      }
      if (!iterationKey) break;
    }
    return { resources: hits, iterationKey };
  }

  /**
   * Find resources by name inside one folder by walking its tree (listing is ~20x
   * faster than the server search). Folders are listed several at a time. When the
   * time budget or the hit limit stops the walk, the folders not visited yet are kept
   * in memory and a continuation key is returned.
   * @param query - case-insensitive substring of the name
   * @param folder - folder as given by the user (not needed when resuming)
   * @param limit - stop after this many hits
   * @param resumeKey - key from an earlier call that was cut short
   */
  private async searchByWalking(
    query: string,
    folder: string | undefined,
    limit: number,
    resumeKey?: string
  ): Promise<{ resources: SharedResource[]; iterationKey: string | null }> {
    this.dropExpiredWalkSessions();
    let queue: string[];
    if (resumeKey?.startsWith(WALK_KEY_PREFIX)) {
      const session = this.walkSessions.get(resumeKey);
      if (!session) {
        throw new Error("Search continuation expired or unknown — repeat the search");
      }
      this.walkSessions.delete(resumeKey);
      query = session.query;
      queue = session.queue;
    } else {
      queue = [await this.resolvePath(folder!)];
    }

    const needle = plainNeedle(query);
    const hits: SharedResource[] = [];
    const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
    let visitedFolders = 0;
    let activeVisits = 0;

    /** List one folder completely (all pages), record hits, queue subfolders. */
    const visit = async (folderPath: string): Promise<void> => {
      for (let offset = 0; ; offset += 40) {
        const { items, rawCount } = await this.listFolderPage(folderPath, { amount: 40, offset });
        for (const item of items) {
          if (item.name.toLowerCase().includes(needle)) hits.push(item);
          if (item.type === "dir") queue.push(item.path.replace(/\/+$/, ""));
        }
        if (rawCount < 40) break;
      }
    };

    // Worker pool instead of fixed batches: a slow listing must not stall the others
    const worker = async (): Promise<void> => {
      while (hits.length < limit && visitedFolders < WALK_MAX_FOLDERS && Date.now() < deadline) {
        const folderPath = queue.shift();
        if (folderPath === undefined) {
          // Queue may refill while other workers still list folders
          if (activeVisits === 0) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        visitedFolders++;
        activeVisits++;
        try {
          await visit(folderPath);
        } catch (error) {
          // Keep the folder for the continuation instead of losing it with the error
          queue.unshift(folderPath);
          throw error;
        } finally {
          activeVisits--;
        }
      }
    };
    await Promise.all(Array.from({ length: WALK_CONCURRENCY }, worker));

    if (queue.length === 0) return { resources: hits, iterationKey: null };
    const key = `${WALK_KEY_PREFIX}${randomUUID()}`;
    this.walkSessions.set(key, { query, queue, expiresAt: Date.now() + WALK_SESSION_TTL_MS });
    // Oldest sessions go first when too many searches were left unfinished
    while (this.walkSessions.size > WALK_SESSION_MAX) {
      this.walkSessions.delete(this.walkSessions.keys().next().value!);
    }
    return { resources: hits, iterationKey: key };
  }

  /** Forget continuations nobody came back for. */
  private dropExpiredWalkSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.walkSessions) {
      if (session.expiresAt < now) this.walkSessions.delete(key);
    }
  }

  /**
   * Convert an internal path to the readable form used by the tools:
   * "/aa/d_…/Tasks" → "ADV Team 2/Tasks", "/disk/a/b" → "disk:/a/b".
   * @param internalPath - path as returned by the web API
   */
  async toDisplayPath(internalPath: string): Promise<string> {
    if (internalPath.startsWith("/disk")) return `disk:${internalPath.slice("/disk".length) || "/"}`;
    const folders = await this.getAllSharedFolders();
    const root = folders.find(
      (folder) =>
        internalPath === folder.path.replace(/\/+$/, "") ||
        internalPath.startsWith(`${folder.path.replace(/\/+$/, "")}/`)
    );
    if (!root) return internalPath;
    return `${root.name.trim()}${internalPath.slice(root.path.replace(/\/+$/, "").length)}`;
  }

  // ─── Paths inside shared folders ──────────────────────

  /**
   * Fetch all shared folders (all pages), cached for a minute.
   * Used to resolve human-readable paths like "ADV Team 2/Tasks".
   */
  private async getAllSharedFolders(): Promise<SharedResource[]> {
    if (this.sharedFoldersCache && Date.now() - this.sharedFoldersCache.loadedAt < 60_000) {
      return this.sharedFoldersCache.items;
    }
    const items: SharedResource[] = [];
    let iterationKey: string | undefined;
    // Safety cap on pages in case the API keeps returning the same key
    for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
      const page = await this.getSharedResources("folders", { amount: 40, iterationKey });
      items.push(...page.resources);
      if (!page.iteration_key || page.resources.length < 40) break;
      iterationKey = page.iteration_key;
    }
    this.sharedFoldersCache = { items, loadedAt: Date.now() };
    return items;
  }

  /**
   * Convert a user path to the internal web API path.
   * Accepts "<shared folder name>/sub/path" or a raw internal path ("/aa/d_…/sub").
   * @param userPath - path as given by the user
   * @returns internal path without trailing slash, e.g. "/aa/d_b8g5…/Tasks"
   */
  async resolvePath(userPath: string): Promise<string> {
    const trimmed = userPath.trim().replace(/\/+$/, "");
    if (trimmed.startsWith("/aa/") || trimmed.startsWith("/disk/") || trimmed === "/disk") {
      return trimmed;
    }
    const [folderName, ...rest] = trimmed.replace(/^\/+/, "").split("/");
    const folders = await this.getAllSharedFolders();
    const matches = folders.filter((folder) => folder.name.trim() === folderName.trim());
    if (matches.length === 0) {
      throw new Error(
        `Shared folder "${folderName}" not found. Use list_shared_with_me to see available names.`
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Several shared folders are named "${folderName}": ` +
          matches.map((folder) => folder.path).join(", ") +
          ". Use the internal path instead."
      );
    }
    const basePath = matches[0].path.replace(/\/+$/, "");
    return [basePath, ...rest].join("/");
  }

  // ─── Read / write inside shared folders ───────────────

  /**
   * List contents of a folder by internal path.
   * @param path - internal path, e.g. "/aa/d_b8g5…/Tasks"
   * @param options - page size and offset
   */
  async listFolder(
    path: string,
    options?: { amount?: number; offset?: number }
  ): Promise<SharedResource[]> {
    return (await this.listFolderPage(path, options)).items;
  }

  /**
   * One page of a folder listing together with the raw page size (the folder itself
   * can come back as an extra item, so the item count alone cannot tell the last page).
   */
  async listFolderPage(
    path: string,
    options?: { amount?: number; offset?: number }
  ): Promise<{ items: SharedResource[]; rawCount: number }> {
    const folderId = `${path}/`;
    const result = await this.callModel<{ resources: SharedResource[] }>("mpfs/resources", {
      idContext: folderId,
      sort: "name",
      order: "1",
      amount: Math.min(Math.max(options?.amount ?? 40, 1), 40),
      offset: options?.offset ?? 0,
    });
    // The folder itself may come back as the first item — keep only children
    return {
      items: result.resources.filter((resource) => resource.id !== folderId),
      rawCount: result.resources.length,
    };
  }

  /**
   * Folders touched by the user's own recent changes (from any device or client),
   * read from the Disk journal. Other people's changes are not in this journal.
   * @param sinceMs - epoch ms; older events are ignored
   * @returns internal paths of the folders where something was added, moved or removed
   */
  async getJournalFolders(sinceMs: number): Promise<string[]> {
    if (!this.sk) await this.refreshSession();
    const orgId = process.env.YANDEX_ORG_ID || this.organizationId;
    if (!orgId) return [];
    const folders = new Set<string>();
    const pageLoadDate = new Date().toISOString();
    for (let offset = 0; offset < 400; offset += 40) {
      const result = await this.callModel<{
        clusters?: { groups?: { events?: { event_date?: string; path?: string; from?: string }[] }[] }[];
      }>("intapi/journal", {
        org_id: orgId,
        vd_hash: null,
        page_load_date: pageLoadDate,
        offset,
        text: "",
        limit: 40,
        event_type: "",
        limit_per_group: 20,
        counters_date: pageLoadDate,
      });
      const events = (result.clusters ?? []).flatMap((cluster) => (cluster.groups ?? []).flatMap((group) => group.events ?? []));
      if (events.length === 0) break;
      let isOlderReached = false;
      for (const event of events) {
        if (Date.parse(event.event_date ?? "") < sinceMs) {
          isOlderReached = true;
          continue;
        }
        // Both ends of a move/rename matter: the old parent lost an item, the new one got it
        for (const path of [event.path, event.from]) {
          if (path) folders.add(path.replace(/\/+$/, "").replace(/\/[^/]*$/, ""));
        }
      }
      if (isOlderReached) break;
    }
    return [...folders].filter(Boolean);
  }

  /**
   * Temporary direct download URL of a file.
   * @param path - internal path of the file
   */
  async getDownloadUrl(path: string): Promise<string> {
    const result = await this.callModel<{ file?: string }>("mpfs/url", { path });
    if (!result.file) throw new Error("No download URL returned");
    // The URL comes protocol-relative ("//downloader.disk.yandex.ru/…")
    return result.file.startsWith("//") ? `https:${result.file}` : result.file;
  }

  /**
   * Total size and file count of a folder tree: a cheap change signature (adds,
   * removals and size changes show up; renames and empty new folders do not).
   * @param path - internal path of the folder
   */
  async getDirSize(path: string): Promise<{ size: number; filesCount: number }> {
    const result = await this.callModel<{ size?: number; files_count?: number }>("mpfs/dir-size", { path });
    return { size: result.size ?? 0, filesCount: result.files_count ?? 0 };
  }

  /**
   * Create a folder.
   * @param path - internal path of the new folder
   */
  async createFolder(path: string): Promise<void> {
    await this.callModel<Record<string, never>>("mpfs/mkdir", { path });
  }

  /**
   * Start moving/renaming a resource; returns the async operation ID.
   * @param from - internal source path
   * @param to - internal destination path (full path including the new name)
   * @param overwrite - replace an existing resource at the destination
   */
  async moveResource(from: string, to: string, overwrite: boolean = false): Promise<string> {
    const operations = await this.callModel<BulkOperation[]>("mpfs/bulk-async-move", {
      operations: [{ src: from, dst: to, force: overwrite ? 1 : 0 }],
    });
    return operations[0].oid;
  }

  /**
   * Start copying a resource; returns the async operation ID.
   * @param from - internal source path
   * @param to - internal destination path (full path including the name)
   * @param overwrite - replace an existing resource at the destination
   */
  async copyResource(from: string, to: string, overwrite: boolean = false): Promise<string> {
    const operations = await this.callModel<BulkOperation[]>("mpfs/bulk-async-copy", {
      operations: [{ src: from, dst: to, force: overwrite ? 1 : 0 }],
    });
    return operations[0].oid;
  }

  /**
   * Start moving a resource to trash; returns the async operation ID.
   * @param path - internal path of the resource
   */
  async deleteResource(path: string): Promise<string> {
    const operations = await this.callModel<BulkOperation[]>("mpfs/bulk-async-delete", {
      operations: [{ src: path }],
    });
    return operations[0].oid;
  }

  /**
   * Upload a local file to an internal path (e.g. inside a shared folder).
   * Flow reconstructed from the web client: mpfs/store → PUT to uploadUrl.
   * If Disk already has identical content (matched by hashes), store answers
   * "hardlinked" and no upload is needed.
   * @param localPath - absolute path of the local file
   * @param path - internal destination path including the file name
   * @param overwrite - replace an existing file at the destination
   * @returns "uploaded" or "hardlinked"
   */
  async uploadFile(
    localPath: string,
    path: string,
    overwrite: boolean = false
  ): Promise<"uploaded" | "hardlinked"> {
    const file = await openLocalFile(localPath);
    const { md5, sha256 } = await hashLocalFile(localPath);
    const store = await this.callModel<StoreResponse>("mpfs/store", {
      path,
      force: overwrite ? 1 : 0,
      size: file.size,
      md5,
      sha256,
    });
    if (store.status === "hardlinked") {
      return "hardlinked";
    }
    // Field name differs between web client versions
    const uploadUrl = store.uploadUrl ?? store.upload_url;
    if (!uploadUrl) {
      throw new Error(`mpfs/store returned no upload URL (status: ${store.status ?? "unknown"})`);
    }
    await putFile(uploadUrl, file);
    return "uploaded";
  }

  /**
   * Poll an async operation until it finishes or the timeout expires.
   * @param oid - operation ID from moveResource / deleteResource
   * @param timeoutMs - how long to wait before giving up
   * @returns "done", "failed" or "in-progress" (timed out)
   */
  async waitForOperation(
    oid: string,
    timeoutMs: number = 15_000
  ): Promise<"done" | "failed" | "in-progress"> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const statuses = await this.callModel<Record<string, BulkOperationStatus>>(
        "mpfs/bulk-operation-status",
        { oids: [oid] }
      );
      const status = statuses[oid];
      // Observed finished state: { status: "DONE", state: "COMPLETED" }
      if (status?.status === "DONE" || status?.state === "COMPLETED") return "done";
      if (status?.status === "FAILED" || status?.state === "FAILED" || status?.error) {
        return "failed";
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return "in-progress";
  }
}

/** Async operation started by bulk-async-* methods. */
interface BulkOperation {
  oid: string;
  type: string;
}

/** Response of mpfs/store (upload preparation). */
interface StoreResponse {
  status?: string;
  uploadUrl?: string;
  upload_url?: string;
  oid?: string;
}

/** Status entry returned by mpfs/bulk-operation-status. */
interface BulkOperationStatus {
  status?: string;
  state?: string;
  type?: string;
  error?: unknown;
}
