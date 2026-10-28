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
  const identity = async (file: string) => {
    const info = await lstat(file, { bigint: true });
    return Object.freeze({ dev: String(info.dev), ino: String(info.ino) });
  };
  const walk = async (directory: string, prefix = '') => {
    current();
    const names = await readdir(directory);
    current();
    for (let index = 0; index < names.length; index += 32) {
      current();
      for (const name of names.slice(index, index + 32)) {
        active();
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
          await chmod(file, 0o644);
          active();
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
      current();
    }
  };
  await walk(root);
  current();
  return entries;
}
