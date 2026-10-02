/**
 * Yandex Disk web client (internal, undocumented API of disk.yandex.ru).
 *
 * Used only for what the public REST API does not expose: the list of
 * resources shared with the user ("Общий доступ" page). Authenticates with
 * the browser session cookie and the `sk` CSRF token from the web page.
 * The API may change without notice.
 */

import { hashLocalFile, openLocalFile, putFile } from "./local-file.js";

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
    const folderId = `${path}/`;
    const result = await this.callModel<{ resources: SharedResource[] }>("mpfs/resources", {
      idContext: folderId,
      sort: "name",
      order: "1",
      amount: Math.min(Math.max(options?.amount ?? 40, 1), 40),
      offset: options?.offset ?? 0,
    });
    // The folder itself may come back as the first item — keep only children
    return result.resources.filter((resource) => resource.id !== folderId);
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
