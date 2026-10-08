const sha = /^[a-f0-9]{40}$/;
export function assertOrdinaryOwner(original, live) {
  if (
    !sha.test(original.sourceCommit) ||
    !Number.isSafeInteger(original.pid) ||
    original.pid < 2 ||
    !original.birth ||
    original.cwd !== original.release ||
    live.pid !== original.pid ||
    live.jobPid !== original.pid ||
    live.birth !== original.birth ||
    live.cwd !== original.release ||
    live.portPids.length !== 1 ||
    live.portPids[0] !== original.pid ||
    live.protectedPids.includes(original.pid)
  )
    throw Error('Original ordinary staging identity changed; refuse control');
}
export function assertAcceptedTransition(target, main, identical) {
  if (!sha.test(target) || target !== main || identical !== true)
    throw Error('Transition controller requires exact accepted main source');
}
export function routeStage(mode, command) {
  if (!mode) return 'ordinary';
  if (mode.mode === 'owned-custodian' && ['check', 'drain'].includes(command)) return 'owned';
  throw Error('Ordinary staging operations cannot control canonical owned or uncertain topology');
}
/** Exactly one stop and one start. Any attempted stop retains the lock on failure. */
export async function transitionStage(effects) {
  await effects.lock();
  let attempted = false;
  try {
    await effects.validate();
    attempted = true;
    await effects.stop();
    await effects.preserve();
    await effects.install();
    await effects.start();
    await effects.verify();
    await effects.audit('verified');
  } catch (error) {
    await effects.audit(attempted ? 'uncertain' : 'refused');
    if (!attempted) await effects.unlock();
    throw error;
  }
  await effects.unlock();
}
