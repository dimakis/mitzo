import { join } from 'node:path';
const sha = /^[a-f0-9]{40}$/;
export function stagingBoundary({ root, label, port, workspace, release, sourceCommit }) {
  if (
    !sha.test(sourceCommit) ||
    label !== 'com.mitzo.staging' ||
    port !== 3190 ||
    workspace !== join(root, 'workspace') ||
    release !== join(root, 'releases', sourceCommit.slice(0, 12))
  )
    throw Error('Canonical staging boundary refused');
}
export function compareStage({ expected, main, source, artifacts, dependencies, runtime }) {
  const issues = [];
  if (source !== expected) issues.push('source');
  if (!artifacts) issues.push('artifacts');
  if (!dependencies) issues.push('dependencies');
  if (!runtime) issues.push('runtime');
  return { safe: issues.length === 0, stale: main !== expected, issues };
}
/** Effects retain the original staging job control. No force stop, rollback,
 * parent adoption or automatic successor is inferred from failure. */
export async function promoteStage({ expectedCurrent, target }, effects) {
  if (!sha.test(expectedCurrent) || !sha.test(target))
    throw Error('Exact staging commits required');
  await effects.lock();
  let stopAttempted = false;
  try {
    await effects.audit({ phase: 'preparing', expectedCurrent, target });
    await effects.validate();
    if ((await effects.current()) !== expectedCurrent)
      throw Error('Staging release changed since plan');
    stopAttempted = true;
    await effects.stop();
    await effects.snapshot();
    await effects.activate();
    await effects.start();
    await effects.verify();
    await effects.audit({ phase: 'verified', expectedCurrent, target });
  } catch (error) {
    await effects.audit({
      phase: stopAttempted ? 'uncertain' : 'refused',
      expectedCurrent,
      target,
    });
    if (!stopAttempted) await effects.unlock();
    throw error;
  }
  await effects.unlock();
}
