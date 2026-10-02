/**
 * Local name index of shared folders.
 *
 * The server search takes 2–11 s per page and is fuzzy, while folder listings are
 * fast (~20 per second). A folder tree is walked once, its names are kept in a
 * JSON file (~/.config/yandex-disk-mcp/index/<id>.json) and searched locally in
 * milliseconds, with names compared without punctuation ("prod9514" finds
 * "PROD-9514 - 360"). The index is a snapshot: rebuild it with `refresh`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./credentials.js";
import type { SharedResource, YandexDiskWebClient } from "./yandex-disk-web-client.js";

const INDEX_DIR = join(CONFIG_DIR, "index");
/** Name of the shared copy of an index, stored in the root of the indexed folder. */
export const INDEX_FILE_NAME = ".yandex-disk-mcp-index.json.gz";
const BUILD_CONCURRENCY = 8;
const CHECKPOINT_INTERVAL_MS = 30_000;
/** Folders deeper than this have no stored signature: a changed parent re-lists them */
const SIGNATURE_DEPTH = 4;
const VERIFY_MAX_FOLDERS = 20;
const ROTATION_BATCH = 200;
const ROTATION_PAUSE_MS = 10 * 60_000;
const STALE_AFTER_MS = 24 * 60 * 60_000;
const JOURNAL_MARGIN_MS = 5 * 60_000;
const PUSH_DELAY_MS = 10 * 60_000;

/** One indexed item; `isDir` and the other fields mirror what listings return. */
interface IndexEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/** What is stored on disk. `queue` holds folders still to visit while unfinished. */
export interface IndexFile {
  root: string;
  rootDisplay: string;
  startedAt: string;
  builtAt: string | null;
  /** Last time the contents were corrected by an update, a verify or a rotation */
  updatedAt?: string;
  queue: string[];
  /** [name, path, isDir, size, mtime, fid] — `fid` is the first 16 hex chars of file_id (absent in old files) */
  entries: [string, string, number, number, number, string?][];
  /** Folder path → [size, filesCount] from the last smart update (cheap change signature) */
  sigs?: Record<string, [number, number]>;
  /** Folder path → epoch ms of its last re-listing (rotation takes the stalest first) */
  reconciledAt?: Record<string, number>;
}

export interface LoadedIndex {
  file: IndexFile;
  /** Names without punctuation and case, parallel to `file.entries`. */
  normalizedNames: string[];
}

/** Progress of a running build. */
interface BuildJob {
  root: string;
  rootDisplay: string;
  startedAt: number;
  foldersVisited: number;
  entryCount: number;
  queueLength: number;
  error: string | null;
  isFinished: boolean;
  kind?: "build" | "update";
  /** Outcome text of a finished update */
  summary?: string;
}

/** What a reconcile changed in the index. */
export interface ReconcileStats {
  folders: number;
  added: number;
  removed: number;
  renamed: number;
  changed: number;
}

/** Lower-case a text and drop everything but letters and digits. */
export function normalizeName(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Short stable id of a root folder: names its index file locally and on the Disk. */
export function indexId(root: string): string {
  return createHash("sha1").update(root).digest("hex").slice(0, 16);
}

/** Path of the index file of a root folder. */
function indexFilePath(root: string): string {
  return join(INDEX_DIR, `${indexId(root)}.json`);
}

/** What the sync layer needs to know about a saved index. */
export interface IndexSummary {
  id: string;
  root: string;
  rootDisplay: string;
  /** Null while the build is unfinished */
  builtAt: string | null;
  /** Newest change of the contents: what sync compares */
  version: string | null;
  /** True while a build of this root is running */
  isBuilding: boolean;
}

/** Write a file in one step so a crash never leaves half a JSON behind. */
function writeFileAtomically(path: string, content: string): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, content, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

export class SharedIndex {
  private indexes = new Map<string, LoadedIndex>();
  private jobs = new Map<string, BuildJob>();
  /** Called after a build finished successfully (used to push the index to the Disk). */
  onBuilt: ((root: string) => void) | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Roots with a background update or rotation running */
  private maintenance = new Set<string>();
  private lastRotationAt = new Map<string, number>();
  private updateAttempted = new Set<string>();

  constructor(private webClient: YandexDiskWebClient) {
    this.loadFromDisk();
  }

  /** Load all saved indexes. Broken files are skipped. */
  private loadFromDisk(): void {
    if (!existsSync(INDEX_DIR)) return;
    for (const fileName of readdirSync(INDEX_DIR).filter((name) => name.endsWith(".json"))) {
      try {
        const file: IndexFile = JSON.parse(readFileSync(join(INDEX_DIR, fileName), "utf8"));
        this.indexes.set(file.root, {
          file,
          normalizedNames: file.entries.map((entry) => normalizeName(entry[0])),
        });
      } catch {
        // A damaged index only means a rebuild is needed
      }
    }
  }

  /**
   * Start building (or resuming) the index of a folder in the background.
   * @param folder - folder as given by the user
   * @param refresh - rebuild from scratch even if an index exists
   * @returns a message for the user
   */
  async startBuild(folder: string, refresh: boolean): Promise<string> {
    const root = await this.webClient.resolvePath(folder);
    const runningJob = this.jobs.get(root);
    if (runningJob && !runningJob.isFinished) {
      return `⏳ Already indexing ${folder}. See index_status.`;
    }
    const existing = this.indexes.get(root);
    // An existing complete index gets a cheap update; refresh=true walks the tree again
    if (existing && existing.file.builtAt && !refresh) return this.startUpdate(root);
    const resumeFrom = !refresh && existing && !existing.file.builtAt ? existing.file : null;
    const rootDisplay = await this.webClient.toDisplayPath(root);
    const job: BuildJob = {
      root,
      rootDisplay,
      startedAt: Date.now(),
      foldersVisited: 0,
      entryCount: resumeFrom?.entries.length ?? 0,
      queueLength: resumeFrom?.queue.length ?? 1,
      error: null,
      isFinished: false,
    };
    this.jobs.set(root, job);
    // Runs on its own: the tool answers at once and index_status shows progress
    void this.runBuild(job, resumeFrom).catch((error: Error) => {
      job.error = error.message;
      job.isFinished = true;
    });
    return (
      `⏳ Indexing ${rootDisplay} started${resumeFrom ? " (resuming an interrupted build)" : ""}. ` +
      "It runs in the background, about 20 folders per second. Check index_status."
    );
  }

  /** The build itself: worker pool over a folder queue, with periodic checkpoints. */
  private async runBuild(job: BuildJob, resumeFrom: IndexFile | null): Promise<void> {
    const file: IndexFile = resumeFrom ?? {
      root: job.root,
      rootDisplay: job.rootDisplay,
      startedAt: new Date().toISOString(),
      builtAt: null,
      queue: [job.root],
      entries: [],
    };
    const queue = [...file.queue];
    // Folders being listed right now: part of the queue as far as a checkpoint cares
    const inFlight = new Set<string>();
    // Paths already indexed, so a resumed build does not add the same item twice
    const seenPaths = new Set(file.entries.map((entry) => entry[1]));
    let activeVisits = 0;
    let lastCheckpointAt = Date.now();
    mkdirSync(INDEX_DIR, { recursive: true, mode: 0o700 });

    /** Save progress so an interrupted build can be resumed. */
    const checkpoint = (): void => {
      file.queue = file.builtAt ? [] : [...inFlight, ...queue];
      writeFileAtomically(indexFilePath(job.root), JSON.stringify(file));
      lastCheckpointAt = Date.now();
    };

    const visit = async (folderPath: string): Promise<void> => {
      for (let offset = 0; ; offset += 40) {
        const { items, rawCount } = await this.webClient.listFolderPage(folderPath, {
          amount: 40,
          offset,
        });
        for (const item of items) {
          if (item.name === INDEX_FILE_NAME) continue;
          const itemPath = item.path.replace(/\/+$/, "");
          if (seenPaths.has(itemPath)) continue;
          seenPaths.add(itemPath);
          file.entries.push([
            item.name.trim(),
            itemPath,
            item.type === "dir" ? 1 : 0,
            item.meta?.size ?? 0,
            item.mtime ?? 0,
            item.meta?.file_id?.slice(0, 16) ?? "",
          ]);
          if (item.type === "dir") queue.push(itemPath);
        }
        if (rawCount < 40) break;
      }
    };

    const worker = async (): Promise<void> => {
      while (true) {
        const folderPath = queue.shift();
        if (folderPath === undefined) {
          if (activeVisits === 0) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        activeVisits++;
        inFlight.add(folderPath);
        try {
          await visit(folderPath);
          inFlight.delete(folderPath);
          job.foldersVisited++;
        } catch (error) {
          // Folder stays in `inFlight`: the final checkpoint keeps it for a resume
          throw error;
        } finally {
          activeVisits--;
          job.entryCount = file.entries.length;
          job.queueLength = queue.length;
          if (Date.now() - lastCheckpointAt > CHECKPOINT_INTERVAL_MS) checkpoint();
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: BUILD_CONCURRENCY }, worker));
      file.builtAt = new Date().toISOString();
    } finally {
      // Always save: after an error the checkpoint lets the build be resumed
      checkpoint();
      this.indexes.set(job.root, {
        file,
        normalizedNames: file.entries.map((entry) => normalizeName(entry[0])),
      });
      job.isFinished = true;
    }
    // Only a complete index is worth sharing; the hook must never break the build
    if (file.builtAt) this.onBuilt?.(job.root);
  }

  /** Summaries of all saved indexes, for the sync layer. */
  summaries(): IndexSummary[] {
    return [...this.indexes.values()].map(({ file }) => ({
      id: indexId(file.root),
      root: file.root,
      rootDisplay: file.rootDisplay,
      builtAt: file.builtAt,
      version: file.builtAt ? (file.updatedAt ?? file.builtAt) : null,
      isBuilding: this.jobs.get(file.root)?.isFinished === false,
    }));
  }

  /** True while a build of this root is running. */
  isBuilding(root: string): boolean {
    return this.jobs.get(root)?.isFinished === false;
  }

  /** Raw JSON text of a saved index, or null if there is none. */
  readIndexText(root: string): string | null {
    const path = indexFilePath(root);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  /**
   * Install an index received from the Disk (replaces the local one).
   * @param text - JSON text of an index file
   * @returns the root of the installed index
   * @throws if the text is not a valid index
   */
  importIndexText(text: string): IndexFile {
    const file: IndexFile = JSON.parse(text);
    if (typeof file.root !== "string" || !Array.isArray(file.entries) || !Array.isArray(file.queue)) {
      throw new Error("Not an index file");
    }
    mkdirSync(INDEX_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomically(indexFilePath(file.root), text);
    this.indexes.set(file.root, {
      file,
      normalizedNames: file.entries.map((entry) => normalizeName(entry[0])),
    });
    return file;
  }


  // ─── Freshness: keep the snapshot close to the real tree ──────────────

  /** Result counters of a reconcile. */
  private static emptyStats(): ReconcileStats {
    return { folders: 0, added: 0, removed: 0, renamed: 0, changed: 0 };
  }

  /** Parent path of an internal path. */
  private static parentOf(path: string): string {
    return path.slice(0, path.lastIndexOf("/"));
  }

  /** Rebuild lookup data after entries changed, bump the version, save, schedule a sync push. */
  private commit(loaded: LoadedIndex): void {
    loaded.normalizedNames = loaded.file.entries.map((entry) => normalizeName(entry[0]));
    loaded.file.updatedAt = new Date().toISOString();
    writeFileAtomically(indexFilePath(loaded.file.root), JSON.stringify(loaded.file));
    // Many small fixes make one push, not one push each
    if (!this.pushTimer && this.onBuilt) {
      this.pushTimer = setTimeout(() => {
        this.pushTimer = null;
        this.onBuilt?.(loaded.file.root);
      }, PUSH_DELAY_MS);
      this.pushTimer.unref();
    }
  }

  /** Every listed child of a folder, all pages. Returns null when the folder is gone. */
  private async listAllChildren(folderPath: string): Promise<SharedResource[] | null> {
    const children: SharedResource[] = [];
    try {
      for (let offset = 0; ; offset += 40) {
        const { items, rawCount } = await this.webClient.listFolderPage(folderPath, { amount: 40, offset });
        children.push(...items.filter((item) => item.name !== INDEX_FILE_NAME));
        if (rawCount < 40) break;
      }
    } catch (error) {
      if (/\b404\b|not.?found/i.test((error as Error).message)) return null;
      throw error;
    }
    return children;
  }

  /** Walk new folders and return their whole subtree as entries (no index mutation). */
  private async walkNewFolders(startPaths: string[]): Promise<IndexFile["entries"]> {
    const found: IndexFile["entries"] = [];
    const queue = [...startPaths];
    let active = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const folderPath = queue.shift();
        if (folderPath === undefined) {
          if (active === 0) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        active++;
        try {
          for (const item of (await this.listAllChildren(folderPath)) ?? []) {
            if (item.name === INDEX_FILE_NAME) continue;
            const itemPath = item.path.replace(/\/+$/, "");
            found.push([item.name.trim(), itemPath, item.type === "dir" ? 1 : 0, item.meta?.size ?? 0, item.mtime ?? 0, item.meta?.file_id?.slice(0, 16) ?? ""]);
            if (item.type === "dir") queue.push(itemPath);
          }
        } finally {
          active--;
        }
      }
    };
    await Promise.all(Array.from({ length: BUILD_CONCURRENCY }, worker));
    return found;
  }

  /**
   * Re-list one folder and correct its direct children in the index: new items are added
   * (new folders are walked), missing ones removed with their subtree, renamed ones
   * (same file_id, new name) are renamed and their subtree paths rewritten.
   * Does not save: the caller commits when a batch is done.
   */
  private async reconcileFolder(loaded: LoadedIndex, folderPath: string, stats: ReconcileStats): Promise<void> {
    const listed = await this.listAllChildren(folderPath);
    const { file } = loaded;
    stats.folders++;
    file.reconciledAt ??= {};
    file.reconciledAt[folderPath] = Date.now();

    // The folder no longer exists: drop it and everything under it
    if (listed === null) {
      const before = file.entries.length;
      file.entries = file.entries.filter(([, path]) => path !== folderPath && !path.startsWith(`${folderPath}/`));
      stats.removed += before - file.entries.length;
      return;
    }

    const knownByPath = new Map<string, number>();
    file.entries.forEach((entry, position) => {
      if (SharedIndex.parentOf(entry[1]) === folderPath) knownByPath.set(entry[1], position);
    });
    const listedPaths = new Set(listed.map((item) => item.path.replace(/\/+$/, "")));
    // Known children that disappeared by path: candidates for a rename, matched by file_id
    const vanishedByFid = new Map<string, number>();
    for (const [path, position] of knownByPath) {
      const fid = file.entries[position][5];
      if (!listedPaths.has(path) && fid) vanishedByFid.set(fid, position);
    }

    const newFolders: string[] = [];
    const additions: IndexFile["entries"] = [];
    const renamedFrom = new Set<number>();
    for (const item of listed) {
      const itemPath = item.path.replace(/\/+$/, "");
      const fid = item.meta?.file_id?.slice(0, 16) ?? "";
      const isDir = item.type === "dir" ? 1 : 0;
      const size = item.meta?.size ?? 0;
      const position = knownByPath.get(itemPath);
      if (position !== undefined) {
        const entry = file.entries[position];
        if (entry[3] !== size || entry[4] !== (item.mtime ?? 0) || entry[0] !== item.name.trim() || entry[5] !== fid) {
          stats.changed++;
        }
        file.entries[position] = [item.name.trim(), itemPath, isDir, size, item.mtime ?? 0, fid];
        continue;
      }
      const renamedPosition = fid ? vanishedByFid.get(fid) : undefined;
      if (renamedPosition !== undefined) {
        const oldPath = file.entries[renamedPosition][1];
        renamedFrom.add(renamedPosition);
        stats.renamed++;
        file.entries[renamedPosition] = [item.name.trim(), itemPath, isDir, size, item.mtime ?? 0, fid];
        // A renamed folder carries its subtree: rewrite the paths below it
        if (isDir) {
          for (const entry of file.entries) {
            if (entry[1].startsWith(`${oldPath}/`)) entry[1] = itemPath + entry[1].slice(oldPath.length);
          }
        }
        continue;
      }
      stats.added++;
      additions.push([item.name.trim(), itemPath, isDir, size, item.mtime ?? 0, fid]);
      if (isDir) newFolders.push(itemPath);
    }

    // Still unmatched known children are gone: drop them and their subtrees
    const removedPaths = [...knownByPath.entries()]
      .filter(([path, position]) => !listedPaths.has(path) && !renamedFrom.has(position))
      .map(([path]) => path);
    if (removedPaths.length) {
      const gone = new Set(removedPaths);
      const before = file.entries.length;
      file.entries = file.entries.filter(([, path]) => {
        if (gone.has(path)) return false;
        return !removedPaths.some((prefix) => path.startsWith(`${prefix}/`));
      });
      stats.removed += before - file.entries.length;
    }

    file.entries.push(...additions);
    if (newFolders.length) {
      const subtree = await this.walkNewFolders(newFolders);
      stats.added += subtree.length;
      file.entries.push(...subtree);
    }
  }

  /**
   * Run `step` over items with a few at a time.
   */
  private async forEachParallel<T>(items: T[], step: (item: T) => Promise<void>): Promise<void> {
    const pending = [...items];
    await Promise.all(
      Array.from({ length: Math.min(BUILD_CONCURRENCY, pending.length) }, async () => {
        while (pending.length) await step(pending.shift()!);
      })
    );
  }

  /**
   * Check the parent folders of search hits against the live tree and fix the index.
   * @returns what changed; all zeros when the index was right
   */
  async verifyParents(loaded: LoadedIndex, hits: SharedResource[]): Promise<ReconcileStats> {
    const stats = SharedIndex.emptyStats();
    const parents = [...new Set(hits.map((hit) => SharedIndex.parentOf(hit.path)))].slice(0, VERIFY_MAX_FOLDERS);
    await this.forEachParallel(parents, (parent) => this.reconcileFolder(loaded, parent, stats));
    if (stats.added || stats.removed || stats.renamed || stats.changed) this.commit(loaded);
    return stats;
  }

  /**
   * Re-list the stalest folders of an index (background, one run per root at a time).
   * Catches what size signatures cannot: renames and new empty folders.
   */
  private async rotate(loaded: LoadedIndex): Promise<void> {
    const root = loaded.file.root;
    if (this.maintenance.has(root)) return;
    this.maintenance.add(root);
    try {
      const stats = SharedIndex.emptyStats();
      const builtTime = Date.parse(loaded.file.builtAt ?? "") || 0;
      const reconciledAt = loaded.file.reconciledAt ?? {};
      const folders = [root, ...loaded.file.entries.filter((entry) => entry[2] === 1).map((entry) => entry[1])];
      const stalest = folders
        .sort((first, second) => (reconciledAt[first] ?? builtTime) - (reconciledAt[second] ?? builtTime))
        .slice(0, ROTATION_BATCH);
      await this.forEachParallel(stalest, (folder) => this.reconcileFolder(loaded, folder, stats));
      this.commit(loaded);
    } catch {
      // Rotation is best effort: the next search tries again
    } finally {
      this.maintenance.delete(root);
    }
  }

  /**
   * Background upkeep triggered by a search on an index: rotate when the last rotation is
   * old, run a smart update when the whole index is older than a day.
   */
  scheduleUpkeep(loaded: LoadedIndex): void {
    const root = loaded.file.root;
    if (this.maintenance.has(root) || this.isBuilding(root)) return;
    const version = Date.parse(loaded.file.updatedAt ?? loaded.file.builtAt ?? "") || 0;
    if (Date.now() - version > STALE_AFTER_MS && !this.updateAttempted.has(root)) {
      this.updateAttempted.add(root);
      void this.startUpdate(root).catch(() => undefined);
      return;
    }
    if (Date.now() - (this.lastRotationAt.get(root) ?? 0) > ROTATION_PAUSE_MS) {
      this.lastRotationAt.set(root, Date.now());
      void this.rotate(loaded);
    }
  }

  /**
   * Smart update in the background: compare folder size signatures (one cheap call per
   * folder) and re-list only the folders whose signature changed. The first run on an
   * index without signatures records them and trusts the current contents.
   * @param root - internal root path of an existing complete index
   */
  async startUpdate(root: string): Promise<string> {
    const loaded = this.indexes.get(root);
    if (!loaded?.file.builtAt) return "No complete index to update — use index_shared to build one.";
    if (this.isBuilding(root) || this.maintenance.has(root)) return `⏳ ${loaded.file.rootDisplay}: already working. See index_status.`;
    const job: BuildJob = {
      root,
      rootDisplay: loaded.file.rootDisplay,
      startedAt: Date.now(),
      foldersVisited: 0,
      entryCount: loaded.file.entries.length,
      queueLength: 0,
      error: null,
      isFinished: false,
      kind: "update",
      summary: "",
    };
    this.jobs.set(root, job);
    this.maintenance.add(root);
    void this.runUpdate(loaded, job)
      .catch((error: Error) => {
        job.error = error.message;
      })
      .finally(() => {
        job.isFinished = true;
        this.maintenance.delete(root);
      });
    return `⏳ Updating ${loaded.file.rootDisplay} in the background (changed folders only). Check index_status.`;
  }

  /** The signature walk of a smart update. */
  private async runUpdate(loaded: LoadedIndex, job: BuildJob): Promise<void> {
    const { file } = loaded;
    const stats = SharedIndex.emptyStats();
    const isBaseline = !file.sigs || Object.keys(file.sigs).length === 0;
    file.sigs ??= {};
    const sigs = file.sigs;
    let checked = 0;

    const check = async (folderPath: string, depth: number): Promise<void> => {
      job.queueLength++;
      const { size, filesCount } = await this.webClient.getDirSize(folderPath).catch(() => ({ size: -1, filesCount: -1 }));
      job.queueLength--;
      checked++;
      job.foldersVisited = checked;
      const previous = sigs[folderPath];
      if (size >= 0) sigs[folderPath] = [size, filesCount];
      const isUnchanged = !!previous && size >= 0 && previous[0] === size && previous[1] === filesCount;
      if (isUnchanged) return; // the whole subtree is the same: prune
      // Baseline: trust the index, only record signatures downwards
      if (!(isBaseline && previous === undefined)) await this.reconcileFolder(loaded, folderPath, stats);
      const childDirs = loaded.file.entries
        .filter((entry) => entry[2] === 1 && SharedIndex.parentOf(entry[1]) === folderPath)
        .map((entry) => entry[1]);
      if (depth < SIGNATURE_DEPTH) {
        await this.forEachParallel(childDirs, (childPath) => check(childPath, depth + 1));
      } else if (!isBaseline) {
        // Below the signature depth nothing is stored: re-list the whole subtree of a changed folder
        await this.forEachParallel(childDirs, async (childPath) => {
          const stack = [childPath];
          while (stack.length) {
            const current = stack.pop()!;
            await this.reconcileFolder(loaded, current, stats);
            stack.push(...loaded.file.entries.filter((entry) => entry[2] === 1 && SharedIndex.parentOf(entry[1]) === current).map((entry) => entry[1]));
          }
        });
      }
    };

    // Journal first: the user's own recent changes name the folders to re-list directly
    let journalFolders: string[] = [];
    try {
      // A margin covers clock skew and the journal's own delay; re-listing an extra folder is cheap
      const since = (Date.parse(file.updatedAt ?? file.builtAt ?? "") || 0) - JOURNAL_MARGIN_MS;
      journalFolders = (await this.webClient.getJournalFolders(since)).filter(
        (folder) => folder === file.root || folder.startsWith(`${file.root}/`)
      );
      await this.forEachParallel(journalFolders, (folder) => this.reconcileFolder(loaded, folder, stats));
    } catch {
      // The journal is an extra signal: signatures below still find the changes
    }

    await check(loaded.file.root, 0);
    this.commit(loaded);
    job.entryCount = loaded.file.entries.length;
    job.summary = isBaseline
      ? `signatures recorded for ${checked} folders (first run trusts the current contents)`
      : `${journalFolders.length} folders from the journal, ${stats.folders} folders re-listed: +${stats.added} −${stats.removed} renamed ${stats.renamed} changed ${stats.changed}`;
  }

  /** Text for index_status: running builds and saved indexes. */
  describe(): string {
    const lines: string[] = [];
    for (const job of this.jobs.values()) {
      const seconds = Math.round((Date.now() - job.startedAt) / 1000);
      if (job.kind === "update") {
        lines.push(
          job.isFinished
            ? `${job.error ? "❌" : "✅"} ${job.rootDisplay}: update ${job.error ? `stopped (${job.error})` : `finished — ${job.summary}`}, ${seconds}s`
            : `🔄 ${job.rootDisplay}: updating, ${job.foldersVisited} folders checked, ${seconds}s`
        );
        continue;
      }
      lines.push(
        job.isFinished
          ? `${job.error ? "❌" : "✅"} ${job.rootDisplay}: build ${job.error ? `stopped (${job.error}); start index_shared again to resume` : "finished"}, ${seconds}s`
          : `⏳ ${job.rootDisplay}: ${job.foldersVisited} folders done, ${job.entryCount} items, ${job.queueLength} folders in queue, ${seconds}s`
      );
    }
    for (const { file } of this.indexes.values()) {
      if (this.jobs.get(file.root) && !this.jobs.get(file.root)!.isFinished) continue;
      lines.push(
        file.builtAt
          ? `📚 ${file.rootDisplay}: ${file.entries.length} items, built ${file.builtAt}${file.updatedAt ? `, updated ${file.updatedAt}` : ""}`
          : `⚠️ ${file.rootDisplay}: incomplete (${file.entries.length} items, ${file.queue.length} folders left) — run index_shared to resume`
      );
    }
    return lines.length ? lines.join("\n") : "No indexes. Build one with index_shared.";
  }

  /**
   * Find the complete index that covers a folder, if any.
   * @param internalPath - resolved internal path of the searched folder
   */
  findCovering(internalPath: string): LoadedIndex | null {
    let best: LoadedIndex | null = null;
    for (const [root, loaded] of this.indexes) {
      if (!loaded.file.builtAt) continue;
      if (internalPath === root || internalPath.startsWith(`${root}/`)) {
        if (!best || root.length > best.file.root.length) best = loaded;
      }
    }
    return best;
  }

  /**
   * Search an index by name; every word of the query must occur in the name
   * (punctuation and case ignored).
   * @param loaded - the index
   * @param folderPath - only items under this internal path
   * @param query - words to look for
   * @param limit - max hits
   * @param offset - hits to skip (paging)
   * @returns hits and the offset of the next page (null when exhausted)
   */
  search(
    loaded: LoadedIndex,
    folderPath: string,
    query: string,
    limit: number,
    offset: number
  ): { resources: SharedResource[]; nextOffset: number | null } {
    const words = query.split(/\s+/).map(normalizeName).filter(Boolean);
    const resources: SharedResource[] = [];
    let skipped = 0;
    let nextOffset: number | null = null;
    for (let index = 0; index < loaded.file.entries.length; index++) {
      const [name, path, isDir, size, mtime] = loaded.file.entries[index];
      if (!(path === folderPath || path.startsWith(`${folderPath}/`))) continue;
      const normalized = loaded.normalizedNames[index];
      if (!words.every((word) => normalized.includes(word))) continue;
      if (skipped < offset) {
        skipped++;
        continue;
      }
      if (resources.length >= limit) {
        nextOffset = offset + resources.length;
        break;
      }
      resources.push({
        id: path,
        name,
        path,
        type: isDir ? "dir" : "file",
        mtime,
        meta: { size },
      });
    }
    return { resources, nextOffset };
  }
}
