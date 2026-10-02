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
const BUILD_CONCURRENCY = 8;
const CHECKPOINT_INTERVAL_MS = 30_000;

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
  queue: string[];
  entries: [string, string, number, number, number][];
}

interface LoadedIndex {
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
    if (existing && existing.file.builtAt && !refresh) {
      return `✅ ${folder} is already indexed (${existing.file.entries.length} items, ${existing.file.builtAt}). Use refresh=true to rebuild.`;
    }
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
          const itemPath = item.path.replace(/\/+$/, "");
          if (seenPaths.has(itemPath)) continue;
          seenPaths.add(itemPath);
          file.entries.push([
            item.name.trim(),
            itemPath,
            item.type === "dir" ? 1 : 0,
            item.meta?.size ?? 0,
            item.mtime ?? 0,
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

  /** Text for index_status: running builds and saved indexes. */
  describe(): string {
    const lines: string[] = [];
    for (const job of this.jobs.values()) {
      const seconds = Math.round((Date.now() - job.startedAt) / 1000);
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
          ? `📚 ${file.rootDisplay}: ${file.entries.length} items, built ${file.builtAt}`
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
