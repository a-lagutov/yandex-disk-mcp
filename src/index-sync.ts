/**
 * Sync of the local shared-folder indexes with the user's OWN Yandex Disk.
 *
 * Each index is kept as `disk:/.yandex-disk-mcp/index/<id>.json.gz`, so a second
 * machine (or a reinstall) gets it with one download instead of a walk of the
 * whole tree. Only the user's private Disk is used: nothing is published or shared.
 * Needs the OAuth token; without it, or with YANDEX_INDEX_SYNC=off, sync is skipped.
 *
 * Rules per index: remote only → pull; local only and complete → push; both → the
 * newer `builtAt` wins and the loser is kept as `.bak`. Unfinished builds are never pushed.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { CONFIG_DIR } from "./credentials.js";
import { openLocalFile, putFile } from "./local-file.js";
import { indexId, type IndexFile, type SharedIndex } from "./shared-index.js";
import type { YandexDiskClient } from "./yandex-disk-client.js";

const REMOTE_ROOT = "disk:/.yandex-disk-mcp";
const REMOTE_DIR = `${REMOTE_ROOT}/index`;
const INDEX_DIR = join(CONFIG_DIR, "index");
const STATE_PATH = join(INDEX_DIR, "sync.json");
const UPLOAD_SETTLE_MS = 2_000;

/** What the last successful sync of one index left behind. */
interface SyncState {
  /** md5 of the remote file right after the last push/pull */
  remoteMd5?: string;
  /** builtAt of the index at that moment */
  builtAt: string;
}

/** True unless sync is turned off with YANDEX_INDEX_SYNC=off. */
function isSyncEnabled(): boolean {
  return !["off", "0", "false", "no"].includes((process.env.YANDEX_INDEX_SYNC ?? "").toLowerCase());
}

/** The error text is enough to tell "not found" from the rest. */
function isNotFound(error: unknown): boolean {
  return /\b404\b|NotFound/i.test((error as Error).message);
}

export class IndexSync {
  private state: Record<string, SyncState> = {};
  private startupSync: Promise<string> | null = null;
  private lastResult = "not synced yet";
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private client: YandexDiskClient,
    private sharedIndex: SharedIndex
  ) {
    try {
      this.state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    } catch {
      // No state yet: the first sync compares builtAt values
    }
    // A finished build goes to the Disk on its own
    sharedIndex.onBuilt = (root) => {
      void this.run(() => this.syncRoot(root)).catch((error: Error) => {
        this.lastResult = `push failed: ${error.message}`;
      });
    };
  }

  /** Why sync would not run, or null when it can. */
  private unavailableReason(): string | null {
    if (!isSyncEnabled()) return "off (YANDEX_INDEX_SYNC=off)";
    if (!this.client.hasToken()) return "needs the OAuth token — call `login` with a client_id";
    return null;
  }

  /** Run sync steps one after another so two never write the same file at once. */
  private run<T>(step: () => Promise<T>): Promise<T> {
    const result = this.chain.then(step, step);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** One-line state for index_status. */
  describe(): string {
    return `☁️ Disk sync: ${this.unavailableReason() ?? this.lastResult}`;
  }

  /**
   * Sync once per process (first search / first index build), then reuse the result.
   * Never throws: a broken sync must not block searching.
   */
  ensureStartupSync(): Promise<string> {
    this.startupSync ??= this.syncAll().catch((error: Error) => `sync failed: ${error.message}`);
    return this.startupSync;
  }

  /** Persist the sync state. */
  private saveState(): void {
    mkdirSync(INDEX_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(STATE_PATH, JSON.stringify(this.state), { mode: 0o600 });
  }

  /**
   * Sync every index known locally or on the Disk.
   * @returns a report, one line per index
   */
  syncAll(): Promise<string> {
    const reason = this.unavailableReason();
    if (reason) return Promise.resolve(`Sync skipped: ${reason}.`);
    return this.run(async () => {
      const remoteIds = await this.listRemoteIds();
      const localIds = new Map(this.sharedIndex.summaries().map((entry) => [entry.id, entry.root]));
      const lines: string[] = [];
      for (const id of new Set([...remoteIds, ...localIds.keys()])) {
        try {
          lines.push(await this.syncOne(id, localIds.get(id)));
        } catch (error) {
          lines.push(`❌ ${id}: ${(error as Error).message}`);
        }
      }
      this.lastResult = `last sync ${new Date().toISOString()}`;
      return lines.length ? lines.join("\n") : "Nothing to sync.";
    });
  }

  /** Sync one index by its root path (after a build). */
  private async syncRoot(root: string): Promise<string> {
    if (this.unavailableReason()) return "skipped";
    const summary = this.sharedIndex.summaries().find((entry) => entry.root === root);
    if (!summary) return "unknown index";
    const line = await this.syncOne(summary.id, root);
    this.lastResult = `${line} (${new Date().toISOString()})`;
    return line;
  }

  /** Ids of the index files that exist on the Disk. */
  private async listRemoteIds(): Promise<string[]> {
    try {
      const folder = await this.client.getResource(REMOTE_DIR, { limit: 200 });
      return (folder._embedded?.items ?? [])
        .map((item) => item.name.match(/^([0-9a-f]{16})\.json\.gz$/)?.[1])
        .filter((id): id is string => Boolean(id));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /** Decide and do the sync of one index. */
  private async syncOne(id: string, localRoot: string | undefined): Promise<string> {
    const remotePath = `${REMOTE_DIR}/${id}.json.gz`;
    const local = localRoot
      ? this.sharedIndex.summaries().find((entry) => entry.root === localRoot)
      : undefined;
    // A running build owns the local file: leave it alone
    if (local?.isBuilding) return `⏳ ${local.rootDisplay}: building, sync later`;

    let remoteMd5: string | undefined;
    let remoteExists = true;
    try {
      remoteMd5 = (await this.client.getResource(remotePath)).md5;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      remoteExists = false;
    }

    const label = local?.rootDisplay ?? id;
    if (!remoteExists) {
      if (local?.builtAt) return this.push(id, local.root, label);
      return `· ${label}: nothing to push (index unfinished)`;
    }
    if (!local) return this.pull(id, remotePath, remoteMd5, label);

    // Remote unchanged since our last sync: only a newer local build needs a push
    const known = this.state[id];
    if (known && remoteMd5 && known.remoteMd5 === remoteMd5) {
      return local.version && local.version > known.builtAt
        ? this.push(id, local.root, label)
        : `= ${label}: up to date`;
    }

    // Remote changed (or never synced): compare build times
    const remoteFile = await this.download(remotePath);
    if (!local.version || (remoteFile.updatedAt ?? remoteFile.builtAt ?? "") > (local.version ?? "")) {
      this.keepBackup(local.root);
      return this.install(id, remoteFile, remoteMd5, `⬇️ ${label}: pulled newer index from the Disk`);
    }
    if ((remoteFile.updatedAt ?? remoteFile.builtAt) === local.version) {
      this.state[id] = { remoteMd5, builtAt: local.version! };
      this.saveState();
      return `= ${label}: already identical`;
    }
    // Local is newer: keep the remote one as .bak, then overwrite
    await this.client.copyResource(remotePath, `${remotePath}.bak`, true).catch(() => undefined);
    return this.push(id, local.root, label);
  }

  /** Download and unpack an index file from the Disk. */
  private async download(remotePath: string): Promise<IndexFile> {
    const link = await this.client.getDownloadLink(remotePath);
    const response = await fetch(link.href);
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
    const text = gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
    return JSON.parse(text) as IndexFile;
  }

  /** Pull a remote-only index. */
  private async pull(id: string, remotePath: string, remoteMd5: string | undefined, label: string): Promise<string> {
    const remoteFile = await this.download(remotePath);
    return this.install(id, remoteFile, remoteMd5, `⬇️ ${label}: pulled from the Disk (${remoteFile.entries.length} items)`);
  }

  /** Put a downloaded index in place and remember the sync point. */
  private install(id: string, file: IndexFile, remoteMd5: string | undefined, message: string): string {
    this.sharedIndex.importIndexText(JSON.stringify(file));
    this.state[id] = { remoteMd5, builtAt: file.updatedAt ?? file.builtAt ?? "" };
    this.saveState();
    return message;
  }

  /** Keep the losing local index next to the new one, as `<id>.json.bak`. */
  private keepBackup(root: string): void {
    const text = this.sharedIndex.readIndexText(root);
    if (text) writeFileSync(join(INDEX_DIR, `${indexId(root)}.json.bak`), text, { mode: 0o600 });
  }

  /** Create `.yandex-disk-mcp/index` on the Disk; "already exists" is fine. */
  private async ensureRemoteFolders(): Promise<void> {
    for (const folder of [REMOTE_ROOT, REMOTE_DIR]) {
      await this.client.createFolder(folder).catch((error: Error) => {
        if (!/\b409\b|already exists|Exists/i.test(error.message)) throw error;
      });
    }
  }

  /** Upload the local index (gzip) and remember the sync point. */
  private async push(id: string, root: string, label: string): Promise<string> {
    const text = this.sharedIndex.readIndexText(root);
    if (!text) throw new Error("local index file is missing");
    const parsed = JSON.parse(text) as IndexFile;
    if (!parsed.builtAt) return `· ${label}: unfinished, not pushed`;
    await this.ensureRemoteFolders();

    const temporaryPath = join(INDEX_DIR, `${id}.json.gz.upload`);
    writeFileSync(temporaryPath, gzipSync(text), { mode: 0o600 });
    try {
      const remotePath = `${REMOTE_DIR}/${id}.json.gz`;
      const link = await this.client.getUploadLink(remotePath, true);
      await putFile(link.href, await openLocalFile(temporaryPath));
      // Yandex finishes the upload asynchronously: give it a moment before reading md5
      await new Promise((resolve) => setTimeout(resolve, UPLOAD_SETTLE_MS));
      const remoteMd5 = await this.client
        .getResource(remotePath)
        .then((resource) => resource.md5)
        .catch(() => undefined);
      this.state[id] = { remoteMd5, builtAt: parsed.updatedAt ?? parsed.builtAt };
      this.saveState();
      return `⬆️ ${label}: pushed to the Disk`;
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }
}
