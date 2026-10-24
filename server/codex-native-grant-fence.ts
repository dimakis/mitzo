import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { NativeApprovalRequest } from './codex-native-permission-protocol.js';

function canonical(path: string): string {
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path)
    throw Error('Native grant path must be canonical and absolute');
  let ancestor = path;
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(ancestor), ...missing.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      // A broken symlink is not a nonexistent safe path.
      try {
        if (lstatSync(ancestor).isSymbolicLink())
          throw Error('Unresolved native grant alias', { cause: error });
      } catch (statError) {
        if (!(statError instanceof Error) || !('code' in statError) || statError.code !== 'ENOENT')
          throw statError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}
function overlap(first: string, second: string): boolean {
  const within = (path: string, root: string) => {
    const child = relative(root, path);
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  };
  return within(first, second) || within(second, first);
}
function identity(path: string) {
  const result: Array<unknown> = [];
  let current = path;
  for (;;) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw Error('Native grant aliases are unsupported');
      result.push([current, stat.dev, stat.ino, stat.mode]);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      result.push([current, null]);
    }
    const parent = dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

/** Additional native permissions can outrank parent deny entries in this pin.
 * Only explicit, canonical, disjoint paths are eligible. Revalidate path identity
 * at the final RPC write; do not turn opaque glob/special grants into authority.
 */
export function nativeGrantFence(
  request: NativeApprovalRequest,
  deniedRoots: readonly string[],
  writeProtectedRoots: readonly string[],
  fileChangePaths?: readonly string[],
): () => void {
  const grants: Array<{ path: string; write: boolean }> = [];
  if (request.method === 'item/fileChange/requestApproval') {
    if (!fileChangePaths?.length) throw Error('Native file changes require the exact item paths');
    for (const path of fileChangePaths) grants.push({ path, write: true });
  } else {
    const profile =
      request.method === 'item/permissions/requestApproval'
        ? request.params.permissions
        : request.params.additionalPermissions;
    const files = profile?.fileSystem;
    for (const path of files?.read ?? []) grants.push({ path, write: false });
    for (const path of files?.write ?? []) grants.push({ path, write: true });
    for (const entry of files?.entries ?? []) {
      if (entry.access === 'deny') continue;
      if (entry.path.type !== 'path') throw Error('Unbounded native permission entry');
      grants.push({ path: entry.path.path, write: entry.access === 'write' });
    }
  }
  const capture = () => {
    const denied = deniedRoots.map(canonical);
    const protectedWrites = writeProtectedRoots.map(canonical);
    return grants.map(({ path, write }) => {
      const target = canonical(path);
      if (
        target !== path ||
        denied.some((root) => overlap(target, root)) ||
        (write && protectedWrites.some((root) => overlap(target, root)))
      )
        throw Error('Native grant intersects a protected filesystem boundary');
      return identity(target);
    });
  };
  const accepted = capture();
  return () => {
    if (!isDeepStrictEqual(capture(), accepted))
      throw Error('Native grant paths changed during review');
  };
}
