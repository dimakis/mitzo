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
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(canonical(parent), basename(full));
  }
}
export function isPrivateCodexPath(path: string, extraRoots: string[] = []) {
  const target = canonical(path);
  return [
    codexPrivateDirectory(),
    process.env.CODEX_HOME || join(homedir(), '.codex'),
    ...extraRoots,
  ].some((root) => {
    const rel = relative(canonical(root), target);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
  });
}
