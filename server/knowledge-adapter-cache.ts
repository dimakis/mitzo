/** Reuse only a physical, fully verified conversion of the exact accepted revision. */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { KnowledgeBundleSelection } from './knowledge-publication-bridge.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const physicalFile = (path: string) => {
  if (!lstatSync(path).isFile() || realpathSync(path) !== resolve(path))
    throw Error('Cached knowledge metadata is not a physical file');
  return readFileSync(path);
};

export function cachedKnowledgeConversion(
  root: string,
  identity: { revision: string; builderCommit: string; sourceUrl: string },
  signal: AbortSignal,
): KnowledgeBundleSelection | undefined {
  signal.throwIfAborted();
  const statePath = join(root, 'state.json');
  if (!existsSync(statePath)) return undefined;
  const state = JSON.parse(physicalFile(statePath).toString());
  if (
    state.status !== 'current' ||
    state.publishedCommit !== identity.revision ||
    state.builderCommit !== identity.builderCommit ||
    state.publishedSourceUrl !== identity.sourceUrl
  )
    return undefined;
  const publications = realpathSync(join(root, 'publications'));
  const directory = state.publicationDirectory;
  if (
    typeof directory !== 'string' ||
    !isAbsolute(directory) ||
    !directory.startsWith(publications + sep) ||
    directory === join(publications, 'current') ||
    realpathSync(directory) !== directory ||
    !lstatSync(directory).isDirectory()
  )
    throw Error('Cached knowledge publication directory is unsafe');
  const raw = physicalFile(join(directory, 'baseline.json'));
  const baseline = JSON.parse(raw.toString());
  const receipt = JSON.parse(physicalFile(join(directory, 'publication.json')).toString());
  if (
    receipt.sourceCommit !== identity.revision ||
    receipt.builderCommit !== identity.builderCommit ||
    receipt.baselineSha256 !== hash(raw) ||
    receipt.payloadSha256 !== baseline.payloadSha256 ||
    baseline.startingCommit !== identity.revision ||
    !isDeepStrictEqual(receipt, state.receipt)
  )
    throw Error('Cached knowledge bundle provenance changed');
  const records = baseline.files;
  if (!records || typeof records !== 'object' || Array.isArray(records))
    throw Error('Cached knowledge file manifest is invalid');
  const remaining = new Set(Object.keys(records));
  const seed = join(directory, 'mgmt');
  const walk = (path: string, prefix = '') => {
    signal.throwIfAborted();
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== resolve(path))
      throw Error('Cached knowledge contains an unsafe directory');
    for (const name of readdirSync(path)) {
      signal.throwIfAborted();
      const file = join(path, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(file);
      if (stat.isDirectory()) walk(file, relative);
      else {
        const record = Object.hasOwn(records, relative) ? records[relative] : undefined;
        if (
          !stat.isFile() ||
          !record ||
          !/^[a-f0-9]{64}$/.test(record.sha256) ||
          !/^0[0-7]{3}$/.test(record.mode) ||
          (stat.mode & 0o7777).toString(8).padStart(4, '0') !== record.mode ||
          hash(readFileSync(file)) !== record.sha256
        )
          throw Error('Cached knowledge file integrity changed');
        remaining.delete(relative);
      }
    }
  };
  walk(seed);
  if (remaining.size) throw Error('Cached knowledge files are missing');
  return { seed, sourceCommit: identity.revision, baselineSha256: hash(raw) };
}
