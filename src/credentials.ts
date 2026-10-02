/**
 * Credential store: ~/.config/yandex-disk-mcp/credentials.json (chmod 600).
 *
 * Independent of the shell and of the MCP client config. Environment
 * variables (YANDEX_DISK_TOKEN, YANDEX_SESSION_COOKIE, YANDEX_CLIENT_ID)
 * still take precedence when set.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".config", "yandex-disk-mcp");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");

export interface Credentials {
  token?: string;
  cookie?: string;
  clientId?: string;
}

/** Read the stored credentials file; a missing or broken file counts as empty. */
function readStoredCredentials(): Credentials {
  if (!existsSync(CREDENTIALS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Effective credentials: environment variables override the stored file.
 * Read on every call so a login in another process is picked up.
 */
export function loadCredentials(): Credentials {
  const stored = readStoredCredentials();
  return {
    token: process.env.YANDEX_DISK_TOKEN || stored.token,
    cookie: process.env.YANDEX_SESSION_COOKIE || stored.cookie,
    clientId: process.env.YANDEX_CLIENT_ID || stored.clientId,
  };
}

/**
 * Merge values into the stored credentials file.
 * @param updates - fields to set; others are kept
 */
export function saveCredentials(updates: Credentials): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const merged = { ...readStoredCredentials(), ...updates };
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  // writeFileSync keeps the old mode of an existing file
  chmodSync(CREDENTIALS_FILE, 0o600);
}
