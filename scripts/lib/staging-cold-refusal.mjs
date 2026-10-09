/** Metadata disposition of a proven never-native launch. No retirement, cleanup,
 * adoption or owner capability is constructed. CLI binds the proof to sources/OS. */
export function classifyColdRefusal(s) {
  const r = s.row,
    p = s.plan;
  if (
    s.contract !== 'sealed-macos-restricted-path-lsof-v1' ||
    !/^[a-f0-9-]{36}$/.test(s.operation ?? '') ||
    s.operation !== s.lock?.id ||
    s.operation !== s.transition?.id ||
    s.lock.mode !== 'ordinary-to-owned' ||
    s.lock.target !== p?.sourceCommit ||
    s.transition.target !== p?.sourceCommit ||
    !s.sourceContractVerified ||
    !s.sealedSystem ||
    !s.lookupPathsAbsent ||
    s.restrictedProbeError !== 'ENOENT' ||
    s.job?.pid !== null ||
    s.job.state !== 'not running' ||
    s.job.runs !== 1 ||
    s.job.lastExitCode !== 1 ||
    !r ||
    r.state !== 'retirement_uncertain' ||
    r.instanceId !== null ||
    r.controllerGeneration !== 0 ||
    r.completedAt !== null ||
    r.retirementStateParent !== null ||
    !/^[a-f0-9-]{36}$/.test(r.launchId ?? '') ||
    r.sourceCommit !== p.sourceCommit ||
    r.buildSha256 !== p.buildSha256 ||
    r.configSha256 !== p.configSha256 ||
    r.planDirectory !== p.planDirectory ||
    !s.originalOwnerAbsent ||
    !s.attestationAbsent ||
    !s.sessionArtifactLedgerAbsent ||
    !s.artifactSchemaEmpty ||
    s.eventCounts?.length !== 4 ||
    s.eventCounts.some((n) => n !== 0) ||
    !Array.isArray(s.gatewayDirectories) ||
    s.gatewayDirectories.length ||
    !Array.isArray(s.containers) ||
    s.containers.length ||
    !Array.isArray(s.volumes) ||
    s.volumes.length
  )
    throw Error('Exact pre-native refusal is not proven; retain operation and reservation');
  return {
    classification: 'pre_native_refused',
    launchId: r.launchId,
    nativeRetirement: false,
    adoption: false,
  };
}
export function quarantineColdReservation(db, s, archive, auditSha256) {
  const disposition = classifyColdRefusal(s);
  if (!archive.startsWith('/') || !/^[a-f0-9]{64}$/.test(auditSha256))
    throw Error('Pinned private archive and audit required');
  db.transaction(() => {
    const rows = db.prepare('SELECT * FROM launches').all();
    if (rows.length !== 1 || JSON.stringify(rows[0]) !== JSON.stringify(s.row))
      throw Error('Held reservation changed');
    if (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='qualified_cold_refusals'",
        )
        .get()
    )
      throw Error('Existing refusal disposition requires investigation');
    db.exec(
      'CREATE TABLE qualified_cold_refusals(launchId TEXT PRIMARY KEY,classification TEXT NOT NULL,recordJson TEXT NOT NULL,auditSha256 TEXT NOT NULL,archive TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO qualified_cold_refusals VALUES(?,?,?,?,?)').run(
      s.row.launchId,
      disposition.classification,
      JSON.stringify(s.row),
      auditSha256,
      archive,
    );
    if (
      db
        .prepare(
          'DELETE FROM launches WHERE launchId=? AND instanceId IS NULL AND controllerGeneration=0',
        )
        .run(s.row.launchId).changes !== 1
    )
      throw Error('Original reservation disposition failed');
  }).immediate();
}
export async function prepareColdRefusal(effects) {
  try {
    await effects.validate();
    await effects.archive();
    await effects.validate();
    await effects.classify();
    await effects.vacate();
    await effects.record();
  } catch (error) {
    await effects.audit();
    throw error;
  }
  // Existing deployment lock remains held. Activation is separately planned.
}
