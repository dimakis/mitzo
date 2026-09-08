import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
export function codexPrivateDirectory() {
  const path = process.env.MITZO_CODEX_PRIVATE_DIR || join(homedir(), '.mitzo', 'private', 'codex');
  if (!isAbsolute(path)) throw new Error('Codex private directory must be absolute');
  return path;
}
function canonical(path: string): string {
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(full);
    return parent === full ? full : join(canonical(parent), basename(full));
  }
}
// Process-lifetime registry shared by profile consumers and all path guards.
// Removing a configured account must not make its credential storage public.
const observedProfileRoots = new Set<string>();
export function protectCodexProfileRoots(roots: string[]) {
  const resolved = roots.map(canonical);
  resolved.forEach((root) => observedProfileRoots.add(root));
}

export function isPrivateCodexPath(path: string, extraRoots: string[] = []) {
  const target = canonical(path);
  return [
    codexPrivateDirectory(),
    process.env.CODEX_HOME || join(homedir(), '.codex'),
    ...observedProfileRoots,
    ...extraRoots,
  ].some((root) => {
    const rel = relative(canonical(root), target);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
  });
}

/** Snapshot once per request. Keep all previously known login roots protected even
 * when an account is removed or its configuration becomes temporarily unreadable.
 * Before the first valid snapshot, unknown private roots require fail-closed access.
 */
export function createCodexPathProtection(loadRoots: () => string[]) {
  let knownRoots: Set<string> | undefined;
  return () => {
    try {
      const roots = loadRoots().map(canonical);
      knownRoots ??= new Set<string>();
      roots.forEach((root) => knownRoots!.add(root));
    } catch {
      if (!knownRoots) return () => true;
    }
    const roots = [...knownRoots!];
    return (path: string) => isPrivateCodexPath(path, roots);
  };
}
