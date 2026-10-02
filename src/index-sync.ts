/**
 * Sync of the local shared-folder indexes through the indexed folder itself.
 *
 * An index is kept as `.yandex-disk-mcp-index.json.gz` in the ROOT of the folder it
 * describes, so everyone who works with that folder (and has this server) shares one
 * index: the first person builds it, the others download it instead of walking the tree.
 * Needs only the session cookie and the `write` right on the folder for uploading.
 * The file contains names, sizes and dates of the whole tree — the same that any member
 * of the folder already sees. YANDEX_INDEX_SYNC=off turns sync off.
 *
 * Rules per index: remote only → pull; local only and complete → push; both → the
 * newer version wins and the loser is kept as `.bak` next to the local index.
 * Unfinished builds are never pushed.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { CONFIG_DIR } from "./credentials.js";
import { indexId, INDEX_FILE_NAME, type IndexFile, type SharedIndex } from "./shared-index.js";
import type { YandexDiskWebClient } from "./yandex-disk-web-client.js";

const INDEX_DIR = join(CONFIG_DIR, "index");
const STATE_PATH = join(INDEX_DIR, "sync.json");
const SHARED_ROOT_DEPTH = 2; // "/aa/d_<id>" — the top of a shared folder

/** What the last successful sync of one index left behind. */
interface SyncState {
  /** "<size>:<mtime>" of the remote file right after the last push/pull */
  remoteSignature?: string;
  /** Version (updatedAt or builtAt) of the index at that moment */
  version: string;
}

/** The remote copy of an index as listings show it. */
interface RemoteFile {
  path: string;
  signature: string;
}

/** True unless sync is turned off with YANDEX_INDEX_SYNC=off. */
function isSyncEnabled(): boolean {
  return !["off", "0", "false", "no"].includes((process.env.YANDEX_INDEX_SYNC ?? "").toLowerCase());
}

export class IndexSync {
  private state: Record<string, SyncState> = {};
  private startupSync: Promise<string> | null = null;
  private discoveryDone = new Set<string>();
  private lastResult = "not synced yet";
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private webClient: YandexDiskWebClient,
    private sharedIndex: SharedIndex
  ) {
    try {
      this.state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    } catch {
      // No state yet: the first sync compares versions
    }
    // A finished build or a batch of fixes goes to the shared folder on its own
    sharedIndex.onBuilt = (root) => {
      void this.run(() => this.syncRoot(root)).catch((error: Error) => {
        this.lastResult = `push failed: ${error.message}`;
      });
    };
  }

  /** Why sync would not run, or null when it can. */
  private unavailableReason(): string | null {
    return isSyncEnabled() ? null : "off (YANDEX_INDEX_SYNC=off)";
  }

  /** Run sync steps one after another so two never write the same file at once. */
  private run<T>(step: () => Promise<T>): Promise<T> {
    const result = this.chain.then(step, step);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** One-line state for index_status. */
  describe(): string {
    return `☁️ Folder sync: ${this.unavailableReason() ?? this.lastResult}`;
  }

  /**
   * Get ready for a folder: sync known indexes once per process, then look for an index
   * of this folder (or of a parent) that someone else left in the folder's root.
   * Never throws: a broken sync must not block searching.
   * @param folderPath - internal path of the folder being searched or indexed
   */
  async prepare(folderPath: string): Promise<void> {
    if (this.unavailableReason()) return;
    this.startupSync ??= this.syncAll().catch((error: Error) => `sync failed: ${error.message}`);
    await this.startupSync;
    if (this.sharedIndex.findCovering(folderPath) || this.discoveryDone.has(folderPath)) return;
    this.discoveryDone.add(folderPath);
    await this.run(async () => {
      // Nearest folder first: the index of the exact folder beats one of a parent
      const segments = folderPath.split("/");
      for (let depth = segments.length; depth > SHARED_ROOT_DEPTH; depth--) {
        const candidate = segments.slice(0, depth).join("/");
        const remote = await this.findRemote(candidate).catch(() => null);
        if (remote) {
          const file = await this.download(remote.path);
          this.install(file.root, file, remote.signature);
          this.lastResult = `pulled index of ${file.rootDisplay} from the shared folder`;
          return;
        }
      }
    }).catch(() => undefined);
  }

  /** Persist the sync state. */
  private saveState(): void {
    mkdirSync(INDEX_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(STATE_PATH, JSON.stringify(this.state), { mode: 0o600 });
  }

  /**
   * Sync every index known locally.
   * @returns a report, one line per index
   */
  syncAll(): Promise<string> {
    const reason = this.unavailableReason();
    if (reason) return Promise.resolve(`Sync skipped: ${reason}.`);
    return this.run(async () => {
      const lines: string[] = [];
      for (const summary of this.sharedIndex.summaries()) {
        try {
          lines.push(await this.syncOne(summary.root));
        } catch (error) {
          lines.push(`❌ ${summary.rootDisplay}: ${(error as Error).message}`);
        }
      }
      this.lastResult = `last sync ${new Date().toISOString()}`;
      return lines.length ? lines.join("\n") : "Nothing to sync.";
    });
  }

  /** Sync one index by its root path (after a build). */
  private async syncRoot(root: string): Promise<string> {
    if (this.unavailableReason()) return "skipped";
    const line = await this.syncOne(root);
    this.lastResult = `${line} (${new Date().toISOString()})`;
    return line;
  }

  /** Find the index file in the root of a folder (pages through the listing; dot names are not first). */
  private async findRemote(folderPath: string): Promise<RemoteFile | null> {
    for (let offset = 0; ; offset += 40) {
      const { items, rawCount } = await this.webClient.listFolderPage(folderPath, { amount: 40, offset });
      const item = items.find((entry) => entry.name === INDEX_FILE_NAME);
      if (item) return { path: item.path, signature: `${item.meta?.size ?? 0}:${item.mtime ?? 0}` };
      if (rawCount < 40) return null;
    }
  }

  /** Decide and do the sync of one index. */
  private async syncOne(root: string): Promise<string> {
    const local = this.sharedIndex.summaries().find((entry) => entry.root === root);
    if (!local) return "unknown index";
    const label = local.rootDisplay;
    // A running build owns the local file: leave it alone
    if (local.isBuilding) return `⏳ ${label}: building, sync later`;

    const remote = await this.findRemote(root);
    if (!remote) {
      return local.builtAt ? this.push(root, label) : `· ${label}: nothing to push (index unfinished)`;
    }

    // Remote unchanged since our last sync: only a newer local version needs a push
    const known = this.state[local.id];
    if (known && known.remoteSignature === remote.signature) {
      return local.version && local.version > known.version ? this.push(root, label) : `= ${label}: up to date`;
    }

    // Remote changed (or never synced): compare versions
    const remoteFile = await this.download(remote.path);
    const remoteVersion = remoteFile.updatedAt ?? remoteFile.builtAt ?? "";
    if (!local.version || remoteVersion > local.version) {
      this.keepBackup(root);
      this.install(root, remoteFile, remote.signature);
      return `⬇️ ${label}: pulled newer index from the shared folder`;
    }
    if (remoteVersion === local.version) {
      this.state[local.id] = { remoteSignature: remote.signature, version: local.version };
      this.saveState();
      return `= ${label}: already identical`;
    }
    // Local is newer: the remote copy is the loser, keep it as .bak, then overwrite
    writeFileSync(join(INDEX_DIR, `${local.id}.remote.json.bak`), JSON.stringify(remoteFile), { mode: 0o600 });
    return this.push(root, label);
  }

  /** Download and unpack an index file from the shared folder. */
  private async download(remotePath: string): Promise<IndexFile> {
    const url = await this.webClient.getDownloadUrl(remotePath);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
    return JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8")) as IndexFile;
  }

  /** Put a downloaded index in place and remember the sync point. */
  private install(root: string, file: IndexFile, remoteSignature: string): void {
    this.sharedIndex.importIndexText(JSON.stringify(file));
    this.state[indexId(root)] = { remoteSignature, version: file.updatedAt ?? file.builtAt ?? "" };
    this.saveState();
  }

  /** Keep the losing local index next to the new one, as `<id>.json.bak`. */
  private keepBackup(root: string): void {
    const text = this.sharedIndex.readIndexText(root);
    if (text) writeFileSync(join(INDEX_DIR, `${indexId(root)}.json.bak`), text, { mode: 0o600 });
  }

  /** Upload the local index (gzip) to the root of its folder and remember the sync point. */
  private async push(root: string, label: string): Promise<string> {
    const text = this.sharedIndex.readIndexText(root);
    if (!text) throw new Error("local index file is missing");
    const parsed = JSON.parse(text) as IndexFile;
    if (!parsed.builtAt) return `· ${label}: unfinished, not pushed`;

    const id = indexId(root);
    const temporaryPath = join(INDEX_DIR, `${id}.json.gz.upload`);
    writeFileSync(temporaryPath, gzipSync(text), { mode: 0o600 });
    try {
      await this.webClient.uploadFile(temporaryPath, `${root}/${INDEX_FILE_NAME}`, true);
    } catch (error) {
      return `⚠️ ${label}: not uploaded (${(error as Error).message}) — needs the write right on the folder`;
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
    const remote = await this.findRemote(root).catch(() => null);
    this.state[id] = { remoteSignature: remote?.signature, version: parsed.updatedAt ?? parsed.builtAt };
    this.saveState();
    return `⬆️ ${label}: pushed to the folder`;
  }
}
