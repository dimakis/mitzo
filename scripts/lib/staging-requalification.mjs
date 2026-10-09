// Metadata-only migration; no service-control or provider/model effect exists here.
export async function requalifyStage(effects) {
  await effects.lock();
  let mutationAttempted = false;
  try {
    await effects.verify();
    await effects.preserve();
    mutationAttempted = true;
    await effects.migrate();
    await effects.check();
    await effects.audit('verified');
  } catch (error) {
    await effects.audit(mutationAttempted ? 'uncertain' : 'refused');
    if (!mutationAttempted) await effects.unlock();
    throw error;
  }
  await effects.unlock();
}
