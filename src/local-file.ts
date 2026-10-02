/**
 * Helpers for uploading local files: open as a streamable Blob,
 * compute hashes, and PUT to an upload URL.
 */

import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

/** Local file opened for upload. */
export interface LocalFile {
  name: string;
  size: number;
  blob: Blob;
}

/**
 * Open a local file for streaming upload.
 * @param localPath - absolute path on this machine
 * @throws if the path does not exist or is not a regular file
 */
export async function openLocalFile(localPath: string): Promise<LocalFile> {
  const fileStat = await stat(localPath);
  if (!fileStat.isFile()) {
    throw new Error(`Not a regular file: ${localPath}`);
  }
  // openAsBlob streams from disk on read, so large files are not loaded into memory
  const blob = await openAsBlob(localPath);
  return { name: basename(localPath), size: fileStat.size, blob };
}

/**
 * Compute MD5 and SHA-256 of a local file in one streaming pass.
 * @param localPath - absolute path on this machine
 */
export async function hashLocalFile(localPath: string): Promise<{ md5: string; sha256: string }> {
  const md5 = createHash("md5");
  const sha256 = createHash("sha256");
  for await (const chunk of createReadStream(localPath)) {
    md5.update(chunk);
    sha256.update(chunk);
  }
  return { md5: md5.digest("hex"), sha256: sha256.digest("hex") };
}

/**
 * Build the destination path: if it ends with "/", append the local file name.
 * @param destination - target path given by the user
 * @param fileName - local file name
 */
export function resolveDestinationPath(destination: string, fileName: string): string {
  return destination.endsWith("/") ? `${destination}${fileName}` : destination;
}

/**
 * Upload file contents with HTTP PUT to a pre-signed upload URL.
 * @param uploadUrl - URL returned by the Disk API
 * @param file - opened local file
 * @throws on non-2xx response
 */
export async function putFile(uploadUrl: string, file: LocalFile): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: file.blob,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Upload failed with HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
}
