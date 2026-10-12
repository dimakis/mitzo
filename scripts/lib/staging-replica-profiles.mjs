const text = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v);
function validate(records, stage) {
  const keys = stage
    ? 'authorization,capabilities,profileId,provider,referenceId,runtime'
    : 'capabilities,id,provider,runtime';
  if (!Array.isArray(records) || !records.length || records.length > 100)
    throw Error('Bounded public profile snapshot required');
  const seen = new Set();
  for (const r of records) {
    const id = stage ? r.referenceId : r.id;
    if (
      !r ||
      Object.keys(r).sort().join() !== keys ||
      !text(id) ||
      !text(r.provider) ||
      !text(r.runtime) ||
      (stage && (!text(r.profileId) || !['ready', 'pending'].includes(r.authorization))) ||
      !Array.isArray(r.capabilities) ||
      r.capabilities.length > 100 ||
      r.capabilities.some((c) => !text(c)) ||
      new Set(r.capabilities).size !== r.capabilities.length ||
      seen.has(id)
    )
      throw Error('Credential-free unique public profile records required');
    seen.add(id);
  }
}
/** Public configuration parity only. Input snapshots cannot grant runtime,
 * provider, credential or model authority. Live feature proof remains separate.
 * Provider names are discovered from the reference, never a two-provider list. */
export function assessStagingReplicaProfiles(reference, stage) {
  validate(reference, false);
  validate(stage, true);
  const issues = [],
    expected = new Set(reference.map((r) => r.id));
  for (const r of reference) {
    const actual = stage.find((p) => p.referenceId === r.id);
    if (!actual) {
      issues.push({ profileId: r.id, reason: 'missing-profile' });
      continue;
    }
    if (actual.provider !== r.provider || actual.runtime !== r.runtime)
      issues.push({ profileId: r.id, reason: 'provider-runtime-mismatch' });
    if (actual.authorization !== 'ready')
      issues.push({ profileId: r.id, reason: 'authorization-pending' });
    if ([...actual.capabilities].sort().join() !== [...r.capabilities].sort().join())
      issues.push({ profileId: r.id, reason: 'capability-mismatch' });
  }
  for (const r of stage)
    if (!expected.has(r.referenceId))
      issues.push({ profileId: r.referenceId, reason: 'unexpected-profile' });
  return { configurationMatches: issues.length === 0, issues, liveFeatureValidation: 'required' };
}
