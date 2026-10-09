const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Recognized native startup rejects RSA before store, extensions or driver
 * construction. This disposition preserves the launch; it is not retirement. */
export function classifyKeyRefusal(s) {
  const r = s.row,
    p = s.plan;
  if (
    s.contract !== 'native-ed25519-before-store-v1' ||
    !uuid.test(s.operation ?? '') ||
    s.lock?.id !== s.operation ||
    s.lock.mode !== 'ordinary-to-owned' ||
    s.activation?.operation !== s.operation ||
    s.activation.target !== p?.sourceCommit ||
    !r ||
    !uuid.test(r.launchId ?? '') ||
    r.sourceCommit !== p.sourceCommit ||
    r.buildSha256 !== p.buildSha256 ||
    r.configSha256 !== p.configSha256 ||
    r.planDirectory !== p.planDirectory ||
    r.state !== 'retirement_uncertain' ||
    r.instanceId !== null ||
    r.controllerGeneration !== 0 ||
    r.completedAt !== null ||
    r.retirementStateParent !== null ||
    s.job?.pid !== null ||
    s.job.state !== 'not running' ||
    s.job.runs !== 1 ||
    s.job.lastExitCode !== 1 ||
    s.signingAlgorithm !== 'rsa' ||
    s.publicAlgorithm !== 'rsa' ||
    [
      'nativeMandatoryGateVerified',
      'sourceContractVerified',
      'gatewayMaterialVerified',
      'originalOwnerAbsent',
      'attestationAbsent',
      'sessionArtifactLedgerAbsent',
      'tokenCacheAbsent',
      'gatewayDatabaseAbsent',
      'artifactSchemaEmpty',
    ].some((k) => s[k] !== true) ||
    !Array.isArray(s.eventCounts) ||
    s.eventCounts.length !== 4 ||
    s.eventCounts.some((n) => n !== 0) ||
    !Array.isArray(s.containers) ||
    s.containers.length ||
    !Array.isArray(s.volumes) ||
    s.volumes.length ||
    !Array.isArray(s.qualified) ||
    s.qualified.length !== 1 ||
    s.qualified[0].classification !== 'pre_native_refused'
  )
    throw Error(
      'Exact mandatory pre-resource refusal is not proven; retain operation and reservation',
    );
  return {
    classification: 'pre_resource_refused',
    launchId: r.launchId,
    nativeRetirement: false,
    adoption: false,
  };
}
export function quarantineKeyReservation(db, s, archive, auditSha256) {
  const disposition = classifyKeyRefusal(s);
  if (!archive.startsWith('/') || !/^[a-f0-9]{64}$/.test(auditSha256))
    throw Error('Pinned private archive and audit required');
  db.transaction(() => {
    if (
      db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity !== 1 ||
      JSON.stringify(db.prepare('SELECT * FROM launches').all()) !== JSON.stringify([s.row]) ||
      JSON.stringify(db.prepare('SELECT * FROM qualified_cold_refusals').all()) !==
        JSON.stringify(s.qualified)
    )
      throw Error('Exact previous disposition or held reservation changed');
    db.prepare('INSERT INTO qualified_cold_refusals VALUES(?,?,?,?,?)').run(
      rId(s),
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
        .run(rId(s)).changes !== 1
    )
      throw Error('Original reservation disposition failed');
  }).immediate();
}
function rId(s) {
  return s.row.launchId;
}
