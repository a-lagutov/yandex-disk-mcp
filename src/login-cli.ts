#!/usr/bin/env node
/**
 * CLI login, same as the MCP `login` tool: opens Chrome, you sign in to Yandex,
 * credentials are saved to ~/.config/yandex-disk-mcp/credentials.json.
 *
 *   npm run login                       sign in (+ OAuth token if a client ID is known)
 *   npm run login -- --client-id <ID>   also remember the OAuth app client ID
 */

import { CONFIG_DIR } from "./credentials.js";
import { loginAndSave } from "./cookie-source.js";

const clientIdFlagIndex = process.argv.indexOf("--client-id");
const clientId = clientIdFlagIndex >= 0 ? process.argv[clientIdFlagIndex + 1] : undefined;

try {
  console.error("Opening Chrome — log in to Yandex, the window closes by itself…");
  const { token } = await loginAndSave(clientId);
  console.error(`Saved to ${CONFIG_DIR}/credentials.json (OAuth token: ${token ? "yes" : "no"})`);
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exit(1);
}
