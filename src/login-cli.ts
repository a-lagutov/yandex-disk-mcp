#!/usr/bin/env node
/**
 * CLI login, same as the MCP `login` tool: opens Chrome, you sign in to Yandex,
 * credentials are saved to ~/.config/yandex-disk-mcp/credentials.json.
 *
 *   npm run login                       sign in (+ OAuth token if a client ID is known)
 *   npm run login -- --client-id <ID>   also remember the OAuth app client ID
 *   npm run login -- --token <T> --cookie <C>   save values obtained manually (no browser)
 */

import { CONFIG_DIR, saveCredentials } from "./credentials.js";
import { loginAndSave } from "./cookie-source.js";

/** Value following a `--flag` on the command line, if present. */
function readFlag(flagName: string): string | undefined {
  const flagIndex = process.argv.indexOf(flagName);
  return flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
}

const clientId = readFlag("--client-id");
const manualToken = readFlag("--token");
const manualCookie = readFlag("--cookie");

// Manual mode: nothing to open, just store what the user obtained
if (manualToken || manualCookie) {
  saveCredentials({
    ...(manualToken ? { token: manualToken } : {}),
    ...(manualCookie ? { cookie: manualCookie } : {}),
    ...(clientId ? { clientId } : {}),
  });
  console.error(`Saved to ${CONFIG_DIR}/credentials.json`);
  process.exit(0);
}

try {
  console.error("Opening Chrome — log in to Yandex, the window closes by itself…");
  const { token } = await loginAndSave(clientId);
  console.error(`Saved to ${CONFIG_DIR}/credentials.json (OAuth token: ${token ? "yes" : "no"})`);
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exit(1);
}
