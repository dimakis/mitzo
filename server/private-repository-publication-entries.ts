import { createHash } from 'node:crypto';
import { chmod, lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryGitEntrySizeLimit } from './repository-git-container-policy.js';
import type { NativeExclusiveTreeEntry } from './native-tree-publication.js';

const unavailable = () => Error('Qualified repository materialization unavailable');
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Observe independently owned PRIVATE scratch, never source reads or published
 * task effects. Join bounded batches under the original consumed owner; its
 * fixed publication worker still verifies every byte/identity before writing.
 */
export async function capturePrivateRepositoryPublicationEntries(
  root: string,
  current: () => void,
  active: () => void,
): Promise<NativeExclusiveTreeEntry[]> {
  const entries: NativeExclusiveTreeEntry[] = [];
  let bytes = 0;
  // One batch budget spans directory recursion too: a Git object store can
  // contain hundreds of empty shard directories and only a few pack files.
  let observations = 0;
  const checkpoint = () => {
    active();
    if (observations++ % 32 === 0) current();
  };
  const identity = async (file: string) => {
    checkpoint();
    const info = await lstat(file, { bigint: true });
    active();
    return Object.freeze({ dev: String(info.dev), ino: String(info.ino) });
  };
  const walk = async (directory: string, prefix = '') => {
    checkpoint();
    const names = await readdir(directory);
    active();
    for (const name of names) {
      checkpoint();
      const file = join(directory, name),
        path = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(file);
      active();
      if (entries.length >= 10000 || info.isSymbolicLink()) throw unavailable();
      if (info.isDirectory()) {
        entries.push({
          path,
          mode: '040000',
          identity: await identity(file),
          size: 0,
          sha256: sha(''),
        });
        await walk(file, path);
      } else {
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > repositoryGitEntrySizeLimit(path) ||
          (bytes += info.size) > 128 * 1024 * 1024
        )
          throw unavailable();
        checkpoint();
        await chmod(file, 0o644);
        active();
        checkpoint();
        const content = await readFile(file);
        active();
        entries.push({
          path,
          mode: '100644',
          identity: await identity(file),
          size: content.length,
          sha256: sha(content),
        });
      }
    }
  };
  current();
  await walk(root);
  current();
  return entries;
}
