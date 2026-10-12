import process from 'node:process';
import { join } from 'node:path';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { assessStagingResources } from './staging-resource-budget.mjs';

export function assertStagingSnapshotAdmission(root, observe) {
  const growthGiB = measureStagingDeploymentGrowth(root);
  if (!assessStagingResources(observe(), growthGiB).admitted)
    throw Error('Canonical deployment snapshot resource admission refused');
  return growthGiB;
}

/** Snapshot copies are budgeted without sparse-file, hard-link or COW credit.
 * Symlinks are copied verbatim by the canonical controller, never traversed. */
export function measureStagingDeploymentGrowth(root) {
  let entries = 0;
  // Previous receipt and replacement controller/launcher metadata allowance.
  let bytes = 64 * 1024 ** 2;
  const refuse = () => {
    throw Error('Canonical deployment snapshot growth unavailable');
  };
  const visit = (path) => {
    const s = lstatSync(path);
    if (++entries > 100000 || !Number.isSafeInteger(s.size) || s.size < 0) refuse();
    bytes += 4096 + Math.ceil(s.size / 4096) * 4096;
    if (!Number.isSafeInteger(bytes) || bytes > 128 * 1024 ** 3) refuse();
    if (s.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else if (!s.isFile() && !s.isSymbolicLink()) refuse();
  };
  for (const kind of ['workspace', 'state']) {
    const path = join(root, kind),
      s = lstatSync(path);
    if (!s.isDirectory() || s.uid !== process.getuid() || realpathSync(path) !== path) refuse();
    visit(path);
  }
  return bytes / 1024 ** 3;
}
