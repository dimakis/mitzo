import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isPrivateCodexPath } from './codex-private-path.js';

/** Server-owned ordinary files, independent of any repository/source directory. */
export function ordinaryWorkspaceTaskRoot(create = false): string {
  const root =
    process.env.MITZO_ORDINARY_TASK_ROOT ||
    join(homedir(), '.local', 'share', 'mitzo', 'ordinary-tasks');
  const unavailable = () =>
    Error(
      'Ordinary task directory requires a private canonical root outside credential and configuration storage',
    );
  if (!isAbsolute(root) || resolve(root) !== root || isPrivateCodexPath(root)) throw unavailable();
  let ancestor = root;
  while (true) {
    try {
      const stat = lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(ancestor) !== ancestor)
        throw unavailable();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw unavailable();
      ancestor = parent;
    }
  }
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const stat = lstatSync(root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(root) !== root ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw unavailable();
  } catch (error) {
    if (create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return root;
}
