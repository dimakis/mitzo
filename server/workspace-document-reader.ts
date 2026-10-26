import { lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  captureLocalArtifactFile,
  OpenShellArtifactReadError,
  type ArtifactCommandRunner,
} from './openshell-artifact-reader.js';

const changed = () =>
  new OpenShellArtifactReadError(
    409,
    'Original conversation workspace changed. Preview the document again.',
  );
/** Pin the original directory before asynchronous capture, then renew custody and the exact file witness. */
export async function readHostWorkspaceDocument(
  root: string,
  path: string,
  assertAuthority: () => void = () => {},
  run?: ArtifactCommandRunner,
) {
  root = resolve(root);
  const identity = () => {
    const stat = lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed();
    return [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].map(String);
  };
  const original = identity();
  const assertRoot = () => {
    assertAuthority();
    if (!isDeepStrictEqual(identity(), original)) throw changed();
  };
  const captured = await captureLocalArtifactFile(root, path, assertRoot, undefined, run);
  return {
    path: captured.path,
    bytes: captured.bytes,
    assertCurrentSync: () => {
      assertRoot();
      captured.assertCurrentSync();
    },
  };
}

/** Root selection is supplied by the existing conversation artifact owner, including recorded secondary repos. */
export function createSessionWorkspaceDocumentReader(options: {
  remote(id: string): boolean;
  readRemote(id: string, path: string): Promise<{ path: string; bytes: Buffer }>;
  resolve(id: string, path: string): string;
  root(id: string, path: string): string | null;
  allowed(id: string, path: string): boolean;
}) {
  return async (
    id: string,
    requested: string,
  ): Promise<{ path: string; bytes: Buffer; assertCurrentSync?: () => void }> => {
    if (options.remote(id)) return options.readRemote(id, requested);
    const path = options.resolve(id, requested),
      root = options.root(id, path);
    const rel = root ? relative(root, path) : '..';
    if (
      !root ||
      rel === '' ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      !options.allowed(id, path)
    )
      throw new OpenShellArtifactReadError(403, 'Path is outside this conversation workspace');
    const assertAuthority = () => {
      if (
        options.remote(id) ||
        options.resolve(id, requested) !== path ||
        options.root(id, path) !== root ||
        !options.allowed(id, path)
      )
        throw changed();
    };
    return readHostWorkspaceDocument(root, path, assertAuthority);
  };
}
