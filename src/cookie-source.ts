/**
 * Automatic acquisition of Yandex credentials (session cookie, OAuth token).
 *
 * Drives a dedicated Google Chrome profile through the DevTools protocol
 * (no extra dependencies): the user logs in once in a visible window, after
 * that the cookie is re-read from the saved profile in headless mode.
 * Results go to the credential store (see credentials.ts).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, loadCredentials, saveCredentials } from "./credentials.js";

const PROFILE_DIR = join(CONFIG_DIR, "chrome-profile");

/**
 * Chromium-based browsers share the DevTools protocol, so any of them works.
 * Order: Chrome first, then Edge (preinstalled on Windows), Yandex Browser, others.
 */
const BROWSER_CANDIDATES = [
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Yandex.app/Contents/MacOS/Yandex",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/microsoft-edge",
  "/usr/bin/yandex-browser",
  "/usr/bin/brave-browser",
  "/usr/bin/vivaldi",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  // Windows (per-machine and per-user installs)
  ...["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].flatMap((variable) => {
    const root = process.env[variable];
    return root
      ? [
          `${root}\\Google\\Chrome\\Application\\chrome.exe`,
          `${root}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${root}\\Yandex\\YandexBrowser\\Application\\browser.exe`,
          `${root}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
        ]
      : [];
  }),
];
const DISK_URL = "https://disk.yandex.ru/client/disk";
const OAUTH_AUTHORIZE_URL = "https://oauth.yandex.ru/authorize?response_type=token&client_id=";

const HEADLESS_TIMEOUT_MS = 30_000;
const INTERACTIVE_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 1_000;

/** Find a Chromium-based browser: YANDEX_CHROME_PATH first, then the usual locations. */
function findChromeBinary(): string {
  const browserPath = [process.env.YANDEX_CHROME_PATH, ...BROWSER_CANDIDATES].find(
    (candidate) => candidate && existsSync(candidate)
  );
  if (!browserPath) {
    throw new Error(
      "No Chromium-based browser found (Chrome, Edge, Yandex Browser, Brave, Vivaldi, Chromium). " +
        "Install one or set YANDEX_CHROME_PATH. Or log in manually: call `login` with " +
        "`token` (open https://oauth.yandex.ru/authorize?response_type=token&client_id=<CLIENT_ID> " +
        "in any browser and copy access_token from the address bar) and `cookie` (Cookie header of " +
        "any disk.yandex.ru `models-v2` request: DevTools → Network → Request Headers)."
    );
  }
  return browserPath;
}

/** Sleep helper for polling loops. */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Minimal DevTools protocol client over a WebSocket.
 * Uses the global WebSocket available in Node >= 22.
 */
class DevToolsConnection {
  private socket: WebSocket;
  private nextMessageId = 1;
  private pendingCalls = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const resolvePending = this.pendingCalls.get(message.id);
      if (resolvePending) {
        this.pendingCalls.delete(message.id);
        resolvePending(message);
      }
    });
  }

  /** Open a connection to a DevTools WebSocket endpoint. */
  static async connect(webSocketUrl: string): Promise<DevToolsConnection> {
    if (typeof WebSocket === "undefined") {
      throw new Error("Automatic cookie refresh needs Node.js >= 22 (global WebSocket)");
    }
    const socket = new WebSocket(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("DevTools connection failed")), {
        once: true,
      });
    });
    return new DevToolsConnection(socket);
  }

  /** Send a protocol command and wait for its result. */
  async send<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
    const messageId = this.nextMessageId++;
    const response = new Promise<{ result?: unknown; error?: { message: string } }>((resolve) =>
      this.pendingCalls.set(messageId, resolve)
    );
    this.socket.send(JSON.stringify({ id: messageId, method, params }));
    const message = await response;
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result as T;
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * Wait until Chrome writes DevToolsActivePort into the profile (remote debugging port 0).
 * @returns the debugging port
 */
async function waitForDebuggingPort(chromeProcess: ChildProcess): Promise<number> {
  const portFile = join(PROFILE_DIR, "DevToolsActivePort");
  for (let attempt = 0; attempt < 50; attempt++) {
    if (chromeProcess.exitCode !== null) {
      throw new Error(
        "Chrome exited right after start — is another Chrome using the same profile?"
      );
    }
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
      if (port > 0) return port;
    }
    await sleep(200);
  }
  throw new Error("Chrome did not open a DevTools port");
}

export interface BrowserSession {
  cookie: string;
  /** OAuth token, only when a client ID was given and the user approved the app */
  token?: string;
}

interface PageTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** List the open pages of the controlled Chrome. */
async function listPages(port: number): Promise<PageTarget[]> {
  const targets: PageTarget[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return targets.filter((target) => target.type === "page");
}

/**
 * Log in through the dedicated Chrome profile and collect credentials.
 * @param interactive - show a visible window so the user can log in; otherwise
 *   headless, failing fast if the saved session is gone
 * @param clientId - OAuth app client ID; if given (interactive only), the OAuth
 *   token is obtained too, in the same window
 * @returns the Cookie header for disk.yandex.ru and, optionally, the OAuth token
 */
export async function fetchSessionFromBrowser(
  interactive: boolean,
  clientId?: string
): Promise<BrowserSession> {
  const chromeBinary = findChromeBinary();
  mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  // A stale port file from a crashed run would be mistaken for the new one
  writeFileSync(join(PROFILE_DIR, "DevToolsActivePort"), "");

  const chromeProcess = spawn(
    chromeBinary,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(interactive ? [] : ["--headless=new"]),
      DISK_URL,
    ],
    { stdio: "ignore" }
  );

  let connection: DevToolsConnection | null = null;
  try {
    const port = await waitForDebuggingPort(chromeProcess);
    const deadline = Date.now() + (interactive ? INTERACTIVE_TIMEOUT_MS : HEADLESS_TIMEOUT_MS);
    let cookieHeader: string | null = null;
    let isAuthorizeStarted = false;

    while (Date.now() < deadline) {
      // Re-list pages on every poll: the user may open or switch tabs while logging in
      const pages = await listPages(port);

      if (cookieHeader === null) {
        // Logged in once a tab sits on the Disk page itself (not passport, not a redirect hop)
        const diskPage = pages.find((page) =>
          /^https:\/\/disk(\.360)?\.yandex\.ru\/client/.test(page.url)
        );
        if (diskPage) {
          connection = await DevToolsConnection.connect(diskPage.webSocketDebuggerUrl);
          const { cookies } = await connection.send<{ cookies: { name: string; value: string }[] }>(
            "Network.getCookies",
            { urls: [new URL(diskPage.url).origin, "https://yandex.ru"] }
          );
          // A guest can open the Disk landing page too: only Session_id proves a real login
          if (cookies.some((cookie) => cookie.name === "Session_id")) {
            cookieHeader = [...new Map(cookies.map((cookie) => [cookie.name, cookie])).values()]
              .map((cookie) => `${cookie.name}=${cookie.value}`)
              .join("; ");
            if (!interactive || !clientId) return { cookie: cookieHeader };
          } else {
            connection.close();
            connection = null;
          }
        }
      } else if (clientId) {
        // Same window, same login: ask Yandex to issue an OAuth token for the app
        if (!isAuthorizeStarted) {
          await connection!.send("Page.navigate", { url: OAUTH_AUTHORIZE_URL + clientId });
          isAuthorizeStarted = true;
        }
        // The implicit flow ends on verification_code#access_token=…
        const tokenMatch = pages
          .map((page) => page.url.match(/[#&]access_token=([^&]+)/))
          .find((match) => match);
        if (tokenMatch) return { cookie: cookieHeader, token: tokenMatch[1] };
      }
      if (interactive) {
        console.error(`  page: ${(pages[0]?.url ?? "").split("?")[0].split("#")[0]}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      !interactive
        ? "Saved Yandex session is gone — call the `login` tool to log in again"
        : cookieHeader
          ? "OAuth access was not granted in time"
          : "Login was not completed in time"
    );
  } finally {
    // Browser.close shuts Chrome down gracefully so the profile is written to disk
    await connection?.send("Browser.close").catch(() => undefined);
    connection?.close();
    await sleep(500);
    if (chromeProcess.exitCode === null) chromeProcess.kill();
  }
}

/**
 * Re-read the cookie without user interaction (used by the MCP server when
 * the current cookie is rejected).
 * @returns the fresh Cookie header (saved to the credential store), or null
 *   if a manual login is needed
 */
export async function refreshStoredCookie(): Promise<string | null> {
  // No profile yet means the user never logged in: nothing to refresh from
  if (!existsSync(join(PROFILE_DIR, "Default"))) return null;
  try {
    const { cookie } = await fetchSessionFromBrowser(false);
    saveCredentials({ cookie });
    return cookie;
  } catch (error) {
    console.error(`Cookie refresh failed: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Interactive login: Yandex sign-in plus (if a client ID is known) the OAuth
 * token, in one browser window. Saves everything to the credential store.
 * @param clientId - OAuth app client ID; defaults to the stored one
 * @returns what was obtained
 */
export async function loginAndSave(
  clientId?: string
): Promise<{ cookie: string; token?: string; clientId?: string }> {
  const effectiveClientId = clientId || loadCredentials().clientId;
  const { cookie, token } = await fetchSessionFromBrowser(true, effectiveClientId);
  saveCredentials({ cookie, ...(token ? { token } : {}), ...(effectiveClientId ? { clientId: effectiveClientId } : {}) });
  return { cookie, token, clientId: effectiveClientId };
}
