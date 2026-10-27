import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeAnchoredReadRequest } from '../../native-file-operation.js';
import type { LocalRepositoryReadAnchor } from '../../local-repository-read-access.js';
import { NativeReadAnchorMissingError } from '../../native-file-operation.js';

/** Synthetic fixture owner only. Production must use its signed current owner;
 * the product reader has no filesystem-derived anchor fallback. */
export async function fixtureReadAnchor(path: string): Promise<LocalRepositoryReadAnchor> {
  const info = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new NativeReadAnchorMissingError();
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Fixture read root unavailable');
  return Object.freeze({
    rootPath: path,
    identity: Object.freeze({ dev: String(info.dev), ino: String(info.ino) }),
  });
}

/** Explicit empty actual projection for synthetic offline owners only. */
export async function fixtureReadExclusions(): Promise<readonly string[]> {
  return Object.freeze([]);
}

/** Controlled host descriptor transport for offline consumer tests only. */
export async function fixtureReadDescriptor(
  request: NativeAnchoredReadRequest,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const info = await lstat(request.file_path, { bigint: true });
  if (
    String(info.dev) !== request.identity.dev ||
    String(info.ino) !== request.identity.ino ||
    info.isSymbolicLink()
  )
    throw Error('Fixture descriptor identity changed');
  if (request.operation === 'ReadBytes') {
    const bytes = await readFile(request.file_path);
    if (bytes.length > request.limit) throw Error('Fixture descriptor read exceeds bound');
    signal.throwIfAborted();
    return { content: bytes.toString('base64'), is_error: false };
  }
  if (request.operation !== 'ListDirectory' || !info.isDirectory())
    throw Error('Unexpected fixture descriptor operation');
  const entries = await Promise.all(
    (await readdir(request.file_path)).map(async (name) => {
      const entry = await lstat(join(request.file_path, name), { bigint: true });
      return {
        name,
        identity: { dev: String(entry.dev), ino: String(entry.ino) },
        kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'unsupported',
        size: Number(entry.size),
        mode: Number(entry.mode),
        nlink: Number(entry.nlink),
        mtimeNs: String(entry.mtimeNs),
        ctimeNs: String(entry.ctimeNs),
      };
    }),
  );
  signal.throwIfAborted();
  return {
    content: JSON.stringify({
      identity: request.identity,
      entries,
      incomplete: false,
      truncated: false,
    }),
    is_error: false,
  };
}
