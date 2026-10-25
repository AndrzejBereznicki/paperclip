import { constants, lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { openRunnerApiWorkspaceFile } from "./native-runtime/runner-api-files.js";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

/**
 * Windows has no confined open, POSIX owner, or 0o600 mode. Reject any
 * symlink or junction on the path (realpath must equal the path), then open
 * and confirm the descriptor is the same file that was checked.
 */
async function openWindowsCredentialFile(filename: string): Promise<FileHandle> {
  if (!path.isAbsolute(filename)) throw new Error("Invalid credential file");
  const resolved = path.resolve(filename);
  if ((await realpath(resolved)).toLowerCase() !== resolved.toLowerCase()) throw new Error("Invalid credential file");
  const before = await lstat(resolved, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("Invalid credential file");
  const file = await open(resolved, constants.O_RDONLY);
  const after = await file.stat({ bigint: true });
  if (after.ino !== before.ino || after.dev !== before.dev) {
    await file.close();
    throw new Error("Invalid credential file");
  }
  return file;
}

/** Bounded descriptor read; never follows symlinks or reopens a checked path. */
export async function readLocalAiCredentialFile(filename: string): Promise<string> {
  const windows = process.platform === "win32";
  const file = windows ? await openWindowsCredentialFile(filename) : await openRunnerApiWorkspaceFile(filename);
  try {
    const stat = await file.stat();
    const privateToUser = windows || (stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600);
    if (!stat.isFile() || !privateToUser || stat.size > MAX_CREDENTIAL_BYTES) {
      throw new Error("Invalid credential file");
    }
    const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > MAX_CREDENTIAL_BYTES) throw new Error("Invalid credential file");
    return bytes.subarray(0, size).toString("utf8");
  } finally {
    await file.close();
  }
}
