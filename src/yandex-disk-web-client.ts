/**
 * Yandex Disk web client (internal, undocumented API of disk.yandex.ru).
 *
 * Used only for what the public REST API does not expose: the list of
 * resources shared with the user ("Общий доступ" page). Authenticates with
 * the browser session cookie and the `sk` CSRF token from the web page.
 * The API may change without notice.
 */

const WEB_ENTRY_URL = "https://disk.yandex.ru/client/disk";

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

  constructor(cookie: string) {
    this.cookie = cookie;
  }

  /**
   * Load the web client page and extract the `sk` CSRF token and the actual host.
   * @throws if the cookie is invalid or expired (redirect to login page)
   */
  private async refreshSession(): Promise<void> {
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
      throw new Error(
        "Yandex session cookie is invalid or expired — update YANDEX_SESSION_COOKIE"
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
    let json: { error?: { statusCode?: number; title?: string; message?: string } } & T;
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
      const description = json.error?.title ?? json.error?.message ?? text.slice(0, 200);
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
}
