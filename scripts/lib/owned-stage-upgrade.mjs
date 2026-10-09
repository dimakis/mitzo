/** Update only through the retained original owner's normal retirement. No
 * restart, rollback, PID adoption or continuation of an uncertain attempt. */
export async function runOwnedStageUpgrade(effects) {
  await effects.lock();
  let controlAttempted = false;
  try {
    await effects.validateLive();
    controlAttempted = true;
    await effects.retire();
    await effects.verifyRetired();
    await effects.preserveRetired();
    await effects.qualifyRetired();
    await effects.prepareFresh();
    await effects.startFresh();
    await effects.verifyFresh();
    await effects.audit('verified');
  } catch (error) {
    await effects.audit(controlAttempted ? 'uncertain' : 'refused');
    if (!controlAttempted) await effects.unlock();
    throw error;
  }
  await effects.unlock();
}
/** Validator is a private constructor callback bound to the actual original
 * owner, state parent, operation time and native receipt. No CLI input can supply
 * it. Preserve full raw retirement history before removing that exact row. */
export function archiveRetiredReservation(db, row, receipt, archive, auditSha256, validate) {
  if (
    typeof validate !== 'function' ||
    !archive.startsWith('/') ||
    !/^[a-f0-9]{64}$/.test(auditSha256) ||
    row.state !== 'retired' ||
    !row.instanceId ||
    !Number.isInteger(row.controllerGeneration) ||
    row.controllerGeneration < 1 ||
    !Number.isInteger(row.completedAt)
  )
    throw Error('Actual original retirement proof required');
  if (validate(row, receipt) !== undefined)
    throw Error('Retirement validation must be synchronous');
  db.transaction(() => {
    if (JSON.stringify(db.prepare('SELECT * FROM launches').all()) !== JSON.stringify([row]))
      throw Error('Exact retired reservation changed');
    db.exec(
      'CREATE TABLE IF NOT EXISTS retired_owned_launches(launchId TEXT PRIMARY KEY, recordJson TEXT NOT NULL, receiptJson TEXT NOT NULL, auditSha256 TEXT NOT NULL, archive TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO retired_owned_launches VALUES(?,?,?,?,?)').run(
      row.launchId,
      JSON.stringify(row),
      JSON.stringify(receipt),
      auditSha256,
      archive,
    );
    if (
      db.prepare("DELETE FROM launches WHERE launchId=? AND state='retired'").run(row.launchId)
        .changes !== 1
    )
      throw Error('Original retirement disposition failed');
  }).immediate();
}
