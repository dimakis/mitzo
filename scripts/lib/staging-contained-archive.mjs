import process from 'node:process';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { basename, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createOfflineRecoveryProposal } from './staging-offline-ordinary-restore.mjs';
import { offlineContainmentDigest as digest } from './staging-offline-containment-contract.mjs';
import {
  assertArchivedOfflineContainmentPhysicalClosure,
  inspectOpaqueContainmentTree,
  assertOpaqueContainmentManifest,
  inspectOpaquePreservationTree,
  assertScopedNoOpenHandles,
  scopedLsofArguments,
  assertNoScopedMountAliases,
} from './staging-offline-containment-observation.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const requireProof = (condition) => {
  if (!condition)
    throw Error('Completed containment proof unavailable or changed; retain original uncertainty');
};
const same = (a, b) => digest(a) === digest(b);
/** Metadata binding only; this return value is not physical proof or authority. */
export function assertCompletedContainmentBindings(b, r) {
  const { intent, receipt, backup, nativeCompleted, ordinaryIntent, ordinaryCompleted } = r;
  requireProof(
    intent?.version === 1 &&
      intent.operation === b.operation &&
      intent.planSha256 === b.nativePlanSha256 &&
      intent.originalRowSha256 === b.rowSha256 &&
      digest(intent.row) === b.rowSha256 &&
      intent.row.state === 'retirement_uncertain',
  );
  requireProof(
    receipt?.version === 1 &&
      receipt.operation === b.operation &&
      receipt.proposalSha256 === b.nativePlanSha256 &&
      receipt.disposition === 'contained_offline_native_cleanup_unconfirmed' &&
      receipt.nativeCleanupConfirmed === false &&
      receipt.originalRowSha256 === b.rowSha256 &&
      receipt.registryBackupSha256 === b.backupSha256 &&
      receipt.archiveRoot === b.archiveRoot &&
      receipt.unitManifestSha256 === b.manifestSha256,
  );
  requireProof(
    backup?.version === 1 &&
      backup.operation === b.operation &&
      backup.planSha256 === b.nativePlanSha256 &&
      backup.rowSha256 === b.rowSha256 &&
      backup.sha256 === b.backupSha256,
  );
  requireProof(
    nativeCompleted?.version === 1 &&
      nativeCompleted.operation === b.operation &&
      nativeCompleted.planSha256 === b.nativePlanSha256 &&
      nativeCompleted.receiptSha256 === b.receiptSha256,
  );
  requireProof(
    ordinaryIntent?.version === 1 &&
      ordinaryIntent.mode === 'offline-ordinary-restoration' &&
      ordinaryIntent.operation === b.operation &&
      ordinaryIntent.planSha256 === b.ordinaryPlanSha256 &&
      ordinaryIntent.containmentSha256 === b.receiptSha256 &&
      ordinaryIntent.target === b.sourceCommit,
  );
  requireProof(
    ordinaryCompleted?.version === 1 &&
      ordinaryCompleted.mode === 'ordinary' &&
      ordinaryCompleted.planSha256 === b.ordinaryPlanSha256 &&
      ordinaryCompleted.containmentSha256 === b.receiptSha256 &&
      ordinaryCompleted.sourceCommit === b.sourceCommit &&
      ordinaryCompleted.label === 'com.mitzo.staging' &&
      ordinaryCompleted.port === 3190 &&
      ordinaryCompleted.providerProfiles === 0 &&
      ordinaryCompleted.nativeCleanupConfirmed === false &&
      Number.isSafeInteger(ordinaryCompleted.pid) &&
      ordinaryCompleted.pid > 1 &&
      typeof ordinaryCompleted.birth === 'string' &&
      ordinaryCompleted.birth.trim(),
  );
}
function bytes(path, privateMode = true) {
  const s = lstatSync(path);
  requireProof(
    s.isFile() &&
      !s.isSymbolicLink() &&
      s.nlink === 1 &&
      s.uid === process.getuid() &&
      realpathSync(path) === path &&
      !(s.mode & (privateMode ? 0o077 : 0o022)),
  );
  return readFileSync(path);
}
const json = (path) => JSON.parse(bytes(path).toString('utf8'));
function directory(path) {
  const s = lstatSync(path);
  requireProof(
    s.isDirectory() &&
      !s.isSymbolicLink() &&
      s.uid === process.getuid() &&
      (s.mode & 0o777) === 0o700 &&
      realpathSync(path) === path,
  );
}
function command(program, argv) {
  return spawnSync(program, argv, {
    encoding: 'utf8',
    shell: false,
    timeout: 10000,
    maxBuffer: 1024 ** 2,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  });
}
function scopedArchive(path, quarantine) {
  assertScopedNoOpenHandles(command('/usr/sbin/lsof', scopedLsofArguments([path], true)));
  const mount = command('/sbin/mount', []);
  requireProof(mount.status === 0 && !mount.error && !mount.signal && !mount.stderr);
  assertNoScopedMountAliases(mount.stdout, [path, quarantine]);
}
/** NEW independent read-only inspector; it never reopens the released recovery
 * owner/guard. The saved complete combined proposal supplies omitted durable
 * facts and is bound against both completed component records. Constructor
 * callbacks are accepted operator code; JSON cannot supply these capabilities. */
export function createCompletedOfflineContainmentInspector({
  recoveryPlanPath,
  expectedRecoveryPlan,
  verifyExecutingController,
  verifyReplacementBoundary,
}) {
  requireProof(
    isAbsolute(recoveryPlanPath) &&
      /^[a-f0-9]{64}$/.test(expectedRecoveryPlan) &&
      typeof verifyExecutingController === 'function' &&
      typeof verifyReplacementBoundary === 'function',
  );
  const saved = bytes(recoveryPlanPath);
  requireProof(saved.length <= 256 * 1024);
  const selected = JSON.parse(saved.toString('utf8'));
  const proposal = createOfflineRecoveryProposal(selected);
  requireProof(same(proposal, selected) && proposal.sha256 === expectedRecoveryPlan);
  const n = proposal.containmentPlan,
    o = proposal.ordinaryPlan,
    archive = n.facts.archiveRoot;
  const ensureProposal = () => requireProof(bytes(recoveryPlanPath).equals(saved));
  const verify = async () => {
    ensureProposal();
    await verifyExecutingController(proposal);
    ensureProposal();
    directory(archive);
    directory(archive + '/symposium');
    const receiptBytes = bytes(join(archive, 'containment-receipt.json'));
    const r = {
      intent: json(archive + '.intent.json'),
      receipt: JSON.parse(receiptBytes.toString('utf8')),
      backup: json(join(archive, 'registry-backup.json')),
      nativeCompleted: json(join(archive, 'completed.json')),
      ordinaryIntent: json(join(archive, 'ordinary-restore-intent.json')),
      ordinaryCompleted: json(join(archive, 'ordinary-completed.json')),
    };
    const b = {
      operation: basename(archive),
      nativePlanSha256: n.sha256,
      ordinaryPlanSha256: o.sha256,
      sourceCommit: o.facts.source.sourceCommit,
      rowSha256: n.facts.retained.rowSha256,
      manifestSha256: n.facts.units[0].manifestSha256,
      archiveRoot: archive,
      backupSha256: hash(bytes(join(archive, 'original-registry.db'))),
      receiptSha256: hash(receiptBytes),
    };
    assertCompletedContainmentBindings(b, r);
    requireProof(
      same(r.intent.unit, n.facts.units[0]) &&
        same(r.intent.controls, n.facts.controls) &&
        same(r.receipt.controls, n.facts.controls),
    );
    for (const control of n.facts.controls) {
      const s = lstatSync(control.archivePath);
      requireProof(
        same(
          {
            dev: s.dev,
            ino: s.ino,
            uid: s.uid,
            mode: s.mode & 0o777,
            size: s.size,
            mtimeMs: s.mtimeMs,
          },
          r.intent.controlIdentities[control.kind],
        ),
      );
    }
    for (const path of [
      join(archive, 'original-registry.db'),
      join(n.facts.canonicalRoot, 'registry/staging.db'),
    ]) {
      const db = new Database(path, { readonly: true, fileMustExist: true });
      try {
        requireProof(db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity === 1);
        const rows = db
          .prepare('SELECT * FROM launches WHERE launchId=?')
          .all(r.intent.row.launchId);
        requireProof(rows.length === 1 && digest(rows[0]) === b.rowSha256);
        if (path.endsWith('original-registry.db'))
          requireProof(db.prepare('SELECT COUNT(*) AS n FROM launches').get().n === 1);
        else {
          const history = db
            .prepare('SELECT * FROM contained_owned_launches WHERE launchId=?')
            .get(r.intent.row.launchId);
          requireProof(
            history &&
              history.recordJson === JSON.stringify(r.intent.row) &&
              history.classification === r.receipt.disposition &&
              history.proposalSha256 === n.sha256 &&
              history.operationId === b.operation &&
              history.archive === archive &&
              history.registryBackupSha256 === b.backupSha256 &&
              history.receiptSha256 === b.receiptSha256,
          );
        }
      } finally {
        db.close();
      }
    }
    for (const unit of o.facts.preservation) {
      directory(unit.archivePath);
      scopedArchive(unit.archivePath, archive);
      requireProof(inspectOpaquePreservationTree(unit.archivePath).sha256 === unit.manifestSha256);
      scopedArchive(unit.archivePath, archive);
    }
    for (const file of o.facts.installation.controlFiles) {
      requireProof(same(json(file.archivePath + '.metadata.json'), file.prior));
      if (file.prior.state === 'present')
        requireProof(hash(bytes(file.archivePath)) === file.prior.sha256);
      else requireProof(!lstatSync(file.archivePath, { throwIfNoEntry: false }));
    }
    // This mandatory verifier measures the exact independently enrolled current
    // ordinary/preallocation/native replacement. Archived JSON cannot authorize
    // its ownership or permit new controls/native activity by itself.
    await verifyReplacementBoundary(proposal, r);
    await assertArchivedOfflineContainmentPhysicalClosure(n);
    await verifyReplacementBoundary(proposal, r);
    ensureProposal();
    await verifyExecutingController(proposal);
    ensureProposal();
    // After the last asynchronous source/ownership check, reread every complete
    // preserved manifest and control snapshot synchronously. No receipt cache,
    // timestamp equality or hot ownership capsule can replace these bytes.
    assertOpaqueContainmentManifest(
      inspectOpaqueContainmentTree(n.facts.units[0].archivePath),
      n.facts.units[0],
    );
    for (const unit of o.facts.preservation)
      requireProof(inspectOpaquePreservationTree(unit.archivePath).sha256 === unit.manifestSha256);
    for (const file of o.facts.installation.controlFiles) {
      requireProof(same(json(file.archivePath + '.metadata.json'), file.prior));
      if (file.prior.state === 'present')
        requireProof(hash(bytes(file.archivePath)) === file.prior.sha256);
      else requireProof(!lstatSync(file.archivePath, { throwIfNoEntry: false }));
    }
    requireProof(
      bytes(join(archive, 'containment-receipt.json')).equals(receiptBytes) &&
        hash(bytes(join(archive, 'original-registry.db'))) === b.backupSha256 &&
        same(json(archive + '.intent.json'), r.intent) &&
        same(json(join(archive, 'completed.json')), r.nativeCompleted) &&
        same(json(join(archive, 'ordinary-restore-intent.json')), r.ordinaryIntent) &&
        same(json(join(archive, 'ordinary-completed.json')), r.ordinaryCompleted),
    );
    return Object.freeze({
      proposalSha256: proposal.sha256,
      containmentReceiptSha256: b.receiptSha256,
      ordinaryCompletionSha256: hash(bytes(join(archive, 'ordinary-completed.json'))),
      originalRowSha256: b.rowSha256,
      archiveManifestSha256: b.manifestSha256,
      nativeCleanupConfirmed: false,
      capacityGrant: false,
    });
  };
  return Object.freeze({ proposal, verify });
}
