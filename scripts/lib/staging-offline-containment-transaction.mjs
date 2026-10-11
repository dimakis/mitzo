import * as fs from 'node:fs';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createOfflineContainmentPlan,
  offlineContainmentDigest,
} from './staging-offline-containment-contract.mjs';
import { inspectOpaqueContainmentTree } from './staging-offline-containment-observation.mjs';

const classification = 'contained_offline_native_cleanup_unconfirmed';
const digest = offlineContainmentDigest;
const same = (left, right) => digest(left) === digest(right);

/** Constructor-only effects come from the reviewed original controller. Neither a
 * proposal's JSON observations nor a serialized authority authorize this transaction.
 * Physical verification and normal job control are mandatory live capabilities;
 * production filesystem preservation and SQLite CAS are implemented here. */
export function createOfflineContainmentTransaction({
  plan: selected,
  consumeAuthority,
  effects,
  continueGuard,
}) {
  const plan = createOfflineContainmentPlan(selected.facts);
  if (!same(selected, plan) || typeof consumeAuthority !== 'function')
    throw Error('Exact proposal and private operator authorizer required');
  for (const name of [
    'assertBeforeMove',
    'assertContained',
    'invalidateControl',
    'assertControlAbsent',
  ])
    if (typeof effects?.[name] !== 'function')
      throw Error('Reviewed live containment effects required');
  const io = effects.io ?? fs,
    facts = plan.facts,
    unit = facts.units[0];
  const operation = basename(facts.archiveRoot),
    intentPath = facts.archiveRoot + '.intent.json';
  const guardPath = join(facts.canonicalRoot, 'service/deployment.lock');
  const registryPath = join(facts.canonicalRoot, 'registry/staging.db');
  const backupPath = join(facts.archiveRoot, 'original-registry.db');
  const backupRecordPath = join(facts.archiveRoot, 'registry-backup.json');
  const receiptPath = join(facts.archiveRoot, 'containment-receipt.json');
  const openRegistry =
    effects.openRegistry ??
    ((path, readonly) => new Database(path, { readonly, fileMustExist: true }));
  const closeRegistry = effects.closeRegistry ?? ((db) => db.close());
  const tree = effects.inspectTree ?? inspectOpaqueContainmentTree;
  const exists = (path) => {
    try {
      io.lstatSync(path);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  const privateDirectory = (path) => {
    const s = io.lstatSync(path);
    if (
      !s.isDirectory() ||
      s.uid !== process.getuid() ||
      (s.mode & 0o777) !== 0o700 ||
      io.realpathSync(path) !== path
    )
      throw Error('Private unaliased operation directory required');
    return s;
  };
  const bytes = (path) => {
    const s = io.lstatSync(path);
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      s.nlink !== 1 ||
      s.mode & 0o077 ||
      io.realpathSync(path) !== path
    )
      throw Error('Private unchanged operation evidence required');
    return io.readFileSync(path);
  };
  const fileHash =
    effects.hashFile ?? ((path) => createHash('sha256').update(bytes(path)).digest('hex'));
  const controlIdentity = (control, path = control.path) => {
    const stat = io.lstatSync(path);
    if (
      stat.uid !== control.uid ||
      (stat.mode & 0o777) !== control.mode ||
      fileHash(path) !== control.sha256
    )
      throw Error('Original control bytes or metadata changed');
    return {
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      mode: stat.mode & 0o777,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  };
  const json = (path) => JSON.parse(bytes(path).toString('utf8'));
  const sync = (path) => {
    const fd = io.openSync(path, 'r');
    try {
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
  };
  const exclusive = (path, value) => {
    const fd = io.openSync(
      path,
      io.constants.O_CREAT | io.constants.O_EXCL | io.constants.O_WRONLY | io.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      io.writeFileSync(fd, JSON.stringify(value) + '\n');
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
    sync(dirname(path));
  };
  const withDb = async (readonly, work) => {
    const db = openRegistry(registryPath, readonly);
    try {
      return await work(db);
    } finally {
      closeRegistry(db);
    }
  };
  const assertOriginalRow = (rows) => {
    if (
      rows.length !== 1 ||
      digest(rows[0]) !== facts.retained.rowSha256 ||
      rows[0].state !== 'retirement_uncertain' ||
      rows[0].completedAt !== null ||
      rows[0].retirementStateParent !== null ||
      [
        'launchId',
        'instanceId',
        'controllerGeneration',
        'sourceCommit',
        'buildSha256',
        'configSha256',
        'createdAt',
      ].some((key) => rows[0][key] !== facts.original[key])
    )
      throw Error('Full original uncertain reservation changed');
    return rows[0];
  };
  const assertPolicy = (db) => {
    if (db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity !== 1)
      throw Error('Singleton policy changed');
  };
  const authority = (input) => {
    const lease = consumeAuthority(input, plan.sha256);
    if (!lease || typeof lease.assertCurrent !== 'function' || typeof lease.close !== 'function')
      throw Error('Original live operator lease required');
    const current = () => lease.assertCurrent(plan.sha256);
    current();
    return { lease, current };
  };
  let used = false;
  function verifyGuard(intent) {
    const expected = {
      version: 1,
      mode: 'offline-native-containment',
      operation,
      planSha256: plan.sha256,
      intentPath,
      intentSha256: digest(intent),
    };
    const retained = json(guardPath);
    const original = { ...retained };
    const extensionKeys = [
      'id',
      'target',
      'continuationPlanSha256',
      'continuationIntentPath',
      'continuationIntentSha256',
      'containmentReceiptSha256',
    ];
    const extended = extensionKeys.some((key) => Object.hasOwn(retained, key));
    if (extended && extensionKeys.some((key) => !Object.hasOwn(retained, key)))
      throw Error('Incomplete continuation guard');
    for (const key of extensionKeys) delete original[key];
    if (retained.continuationPlanSha256) {
      if (typeof effects.assertGuardContinuation !== 'function')
        throw Error('Trusted continuation verifier required');
      if (effects.assertGuardContinuation(plan, undefined, 'retained', retained) !== true)
        throw Error('Trusted continuation verification refused');
    }
    if (!same(original, expected) || !same(json(intentPath), intent))
      throw Error('Exact retained guard and immutable intent required');
  }
  function assertPreservedOwnership(intent) {
    privateDirectory(facts.archiveRoot);
    if (
      exists(unit.path) ||
      facts.controls.some(
        (c) =>
          exists(c.path) &&
          !(
            c.kind === 'app' &&
            json(guardPath).continuationPlanSha256 &&
            typeof effects.assertGuardContinuation === 'function' &&
            effects.assertGuardContinuation(plan, undefined, 'replacement', json(guardPath)) ===
              true
          ),
      )
    )
      throw Error('Original supported paths remain available');
    privateDirectory(unit.archivePath);
    for (const control of facts.controls) {
      if (
        !same(controlIdentity(control, control.archivePath), intent.controlIdentities[control.kind])
      )
        throw Error('Preserved control bytes or metadata changed');
    }
    if (fileHash(join(unit.archivePath, 'service/launch.intent')) !== facts.retained.intentSha256)
      throw Error('Original launch intent changed');
    if (exists(join(unit.archivePath, 'state/gateway/custodian-retirement.json')))
      throw Error('Containment cannot fabricate native retirement');
    const backup = json(backupRecordPath);
    if (
      !same(backup, {
        version: 1,
        operation,
        planSha256: plan.sha256,
        rowSha256: digest(intent.row),
        sha256: fileHash(backupPath),
      })
    )
      throw Error('Original SQLite backup proof changed');
    return backup;
  }
  function assertMoved(intent) {
    const backup = assertPreservedOwnership(intent);
    const manifest = tree(unit.archivePath);
    if (manifest.sha256 !== unit.manifestSha256 || !same(manifest.components, unit.components))
      throw Error('Archived full manifest changed');
    return backup;
  }
  async function finish(auth, intent) {
    verifyGuard(intent);
    auth.current();
    assertMoved(intent);
    await effects.assertContained(plan, intent);
    auth.current();
    const backup = assertMoved(intent);
    for (const control of facts.controls) await effects.assertControlAbsent(control);
    auth.current();
    verifyGuard(intent);
    const receipt = {
      version: 1,
      operation,
      proposalSha256: plan.sha256,
      disposition: classification,
      nativeCleanupConfirmed: false,
      originalRowSha256: digest(intent.row),
      registryBackupSha256: backup.sha256,
      archiveRoot: facts.archiveRoot,
      unitManifestSha256: unit.manifestSha256,
      controls: facts.controls,
    };
    if (exists(receiptPath)) {
      if (!same(json(receiptPath), receipt)) throw Error('Containment receipt changed');
    } else {
      auth.current();
      exclusive(receiptPath, receipt);
    }
    // Only this private closure reaches CAS, after fresh original-process auth and
    // positive whole-unit verification. History preserves every raw original column.
    auth.current();
    await withDb(false, (db) => {
      db.transaction(() => {
        auth.current();
        assertPolicy(db);
        verifyGuard(intent);
        assertMoved(intent);
        auth.current();
        db.exec(
          'CREATE TABLE IF NOT EXISTS contained_owned_launches(launchId TEXT PRIMARY KEY,classification TEXT NOT NULL,recordJson TEXT NOT NULL,proposalSha256 TEXT NOT NULL,operationId TEXT NOT NULL,archive TEXT NOT NULL,registryBackupSha256 TEXT NOT NULL,receiptSha256 TEXT NOT NULL)',
        );
        const expected = {
          launchId: intent.row.launchId,
          classification,
          recordJson: JSON.stringify(intent.row),
          proposalSha256: plan.sha256,
          operationId: operation,
          archive: facts.archiveRoot,
          registryBackupSha256: backup.sha256,
          receiptSha256: fileHash(receiptPath),
        };
        const prior = db
          .prepare('SELECT * FROM contained_owned_launches WHERE launchId=?')
          .get(intent.row.launchId);
        const rows = db.prepare('SELECT * FROM launches').all();
        if (prior) {
          if (!same(prior, expected)) throw Error('Contained history changed');
          assertOriginalRow(rows);
        } else {
          assertOriginalRow(rows);
          auth.current();
          db.prepare('INSERT INTO contained_owned_launches VALUES(?,?,?,?,?,?,?,?)').run(
            ...Object.values(expected),
          );
          // Containment does not release native capacity. Keep the original
          // uncertain reservation byte-for-byte until separate reviewed retirement.
          assertOriginalRow(db.prepare('SELECT * FROM launches').all());
        }
      }).immediate();
    });
    auth.current();
    verifyGuard(intent);
    assertMoved(intent);
    await effects.assertContained(plan, intent);
    auth.current();
    assertMoved(intent);
    const completedPath = join(facts.archiveRoot, 'completed.json'),
      completed = {
        version: 1,
        operation,
        planSha256: plan.sha256,
        receiptSha256: fileHash(receiptPath),
      };
    if (exists(completedPath)) {
      if (!same(json(completedPath), completed)) throw Error('Completion acknowledgement changed');
    } else {
      auth.current();
      exclusive(completedPath, completed);
    }
    auth.current();
    verifyGuard(intent);
    const receiptSha256 = fileHash(receiptPath);
    let bindAttempted = false,
      completeAttempted = false;
    const capability = Object.freeze({
      assertOwnedGuard(ordinaryPlan) {
        if (typeof effects.assertGuardContinuation !== 'function')
          throw Error('Trusted continuation verifier required');
        if (effects.assertGuardContinuation(plan, ordinaryPlan, 'owned', json(guardPath)) !== true)
          throw Error('Trusted continuation verification refused');
        verifyGuard(intent);
        // This hot check proves current custody only. It never substitutes for
        // independent full byte/physical proofs at move, start and release gates.
        assertPreservedOwnership(intent);
        if (fileHash(receiptPath) !== receiptSha256 || !same(json(completedPath), completed))
          throw Error('Contained completion evidence changed');
        return receiptSha256;
      },
      bindOrdinaryGuard(binding, ordinaryPlan) {
        if (bindAttempted) throw Error('Ordinary guard binding cannot be replayed');
        bindAttempted = true;
        this.assertOwnedGuard(ordinaryPlan);
        if (effects.assertGuardContinuation(plan, ordinaryPlan, 'bind', binding) !== true)
          throw Error('Trusted continuation binding refused');
        if (
          binding.planSha256 !== ordinaryPlan.sha256 ||
          !binding.intentPath ||
          !/^[a-f0-9]{64}$/.test(binding.intentSha256) ||
          !binding.target
        )
          throw Error('Exact ordinary continuation binding required');
        const current = json(guardPath);
        if (current.continuationPlanSha256) throw Error('Continuation already bound');
        const bound = {
          ...current,
          id: operation,
          target: binding.target,
          continuationPlanSha256: binding.planSha256,
          continuationIntentPath: binding.intentPath,
          continuationIntentSha256: binding.intentSha256,
          containmentReceiptSha256: receiptSha256,
        };
        exclusive(join(facts.archiveRoot, 'original-deployment-guard.json'), current);
        const pending = guardPath + '.' + operation + '.pending';
        exclusive(pending, bound);
        verifyGuard(intent);
        if (effects.assertGuardContinuation(plan, ordinaryPlan, 'bind', binding) !== true)
          throw Error('Trusted continuation binding refused');
        io.renameSync(pending, guardPath);
        sync(dirname(guardPath));
        return bound;
      },
      async completeOrdinaryGuard(witness, ordinaryPlan) {
        if (completeAttempted) throw Error('Ordinary guard completion cannot be replayed');
        completeAttempted = true;
        this.assertOwnedGuard(ordinaryPlan);
        if (!json(guardPath).continuationPlanSha256) throw Error('Ordinary continuation not bound');
        if (
          (await effects.assertGuardContinuation(plan, ordinaryPlan, 'complete', witness)) !== true
        )
          throw Error('Trusted ordinary completion refused');
        await effects.assertContained(plan, intent);
        this.assertOwnedGuard(ordinaryPlan);
        // The awaited observer may finish network probes after reading native
        // bytes. Verify the full native manifest synchronously after that await.
        assertMoved(intent);
        // Finish the separate ordinary archive proof after the last native
        // physical await. No asynchronous work may intervene before unlock.
        if (
          effects.assertGuardContinuation(plan, ordinaryPlan, 'final-preservation', witness) !==
          true
        )
          throw Error('Final preserved ordinary verification refused');
        this.assertOwnedGuard(ordinaryPlan);
        const retained = json(guardPath);
        try {
          io.unlinkSync(guardPath);
          sync(dirname(guardPath));
        } catch (error) {
          if (!exists(guardPath)) exclusive(guardPath, retained);
          throw error;
        }
      },
    });
    // Containment alone never releases deployment custody or authorizes startup.
    // Only the original controller receives the non-serializable continuation.
    if (continueGuard)
      await continueGuard(capability, Object.freeze({ ...receipt, receiptSha256 }));
    auth.lease.close();
    return receipt;
  }
  return Object.freeze({
    async apply(input) {
      if (used) throw Error('Original containment invocation cannot be replayed');
      used = true;
      const auth = authority(input);
      let intent,
        held = false,
        durable = false,
        guard;
      try {
        const row = await withDb(true, (db) => {
          assertPolicy(db);
          return assertOriginalRow(db.prepare('SELECT * FROM launches').all());
        });
        auth.current();
        intent = {
          version: 1,
          operation,
          planSha256: plan.sha256,
          originalRowSha256: digest(row),
          row,
          unit,
          controls: facts.controls,
          controlIdentities: Object.fromEntries(
            facts.controls.map((c) => [c.kind, controlIdentity(c)]),
          ),
          backupPath,
        };
        guard = {
          version: 1,
          mode: 'offline-native-containment',
          operation,
          planSha256: plan.sha256,
          intentPath,
          intentSha256: digest(intent),
        };
        privateDirectory(dirname(guardPath));
        exclusive(guardPath, guard);
        held = true;
        await effects.assertBeforeMove(plan, { invalidatedControls: [] });
        auth.current();
        if (!exists(dirname(facts.archiveRoot))) {
          const parent = dirname(dirname(facts.archiveRoot));
          const stat = io.lstatSync(parent);
          if (
            !stat.isDirectory() ||
            stat.uid !== process.getuid() ||
            stat.mode & 0o022 ||
            io.realpathSync(parent) !== parent
          )
            throw Error('Owned archive parent required');
          auth.current();
          io.mkdirSync(dirname(facts.archiveRoot), { mode: 0o700 });
          sync(parent);
        }
        privateDirectory(dirname(facts.archiveRoot));
        if (exists(facts.archiveRoot) || exists(intentPath))
          throw Error('Existing preservation requires same-operation verification');
        if (
          [
            privateDirectory(unit.path).dev,
            ...Object.values(intent.controlIdentities).map((identity) => identity.dev),
          ].some((dev) => dev !== privateDirectory(dirname(facts.archiveRoot)).dev)
        )
          throw Error('Atomic same-volume preservation required');
        if (fileHash(join(unit.path, 'service/launch.intent')) !== facts.retained.intentSha256)
          throw Error('Original launch intent changed');
        // Once intent writing is attempted, all uncertainty keeps the guard.
        durable = true;
        exclusive(intentPath, intent);
        io.mkdirSync(facts.archiveRoot, { mode: 0o700 });
        sync(dirname(facts.archiveRoot));
        io.mkdirSync(join(facts.archiveRoot, 'controls'), { mode: 0o700 });
        sync(facts.archiveRoot);
        await withDb(true, async (db) => {
          assertPolicy(db);
          assertOriginalRow(db.prepare('SELECT * FROM launches').all());
          if (exists(backupPath)) throw Error('Original backup already exists');
          auth.current();
          await (effects.backupRegistry ?? ((source, path) => source.backup(path)))(db, backupPath);
        });
        auth.current();
        io.chmodSync(backupPath, 0o600);
        sync(backupPath);
        sync(facts.archiveRoot);
        if (effects.verifyRegistryBackup) effects.verifyRegistryBackup(backupPath, row);
        else {
          const original = new Database(backupPath, { readonly: true, fileMustExist: true });
          try {
            assertPolicy(original);
            assertOriginalRow(original.prepare('SELECT * FROM launches').all());
          } finally {
            original.close();
          }
        }
        auth.current();
        exclusive(backupRecordPath, {
          version: 1,
          operation,
          planSha256: plan.sha256,
          rowSha256: digest(row),
          sha256: fileHash(backupPath),
        });
        const invalidatedControls = [];
        for (const control of facts.controls) {
          auth.current();
          verifyGuard(intent);
          await effects.assertBeforeMove(plan, { invalidatedControls: [...invalidatedControls] });
          auth.current();
          if (
            !same(controlIdentity(control), intent.controlIdentities[control.kind]) ||
            exists(control.archivePath)
          )
            throw Error('Original control binding changed');
          await effects.invalidateControl(control);
          auth.current();
          await effects.assertControlAbsent(control);
          auth.current();
          if (
            !same(controlIdentity(control), intent.controlIdentities[control.kind]) ||
            exists(control.archivePath)
          )
            throw Error('Original control binding changed');
          io.renameSync(control.path, control.archivePath);
          sync(dirname(control.path));
          sync(dirname(control.archivePath));
          invalidatedControls.push(control.kind);
        }
        await effects.assertBeforeMove(plan, { invalidatedControls: [...invalidatedControls] });
        auth.current();
        verifyGuard(intent);
        const original = tree(unit.path);
        if (original.sha256 !== unit.manifestSha256 || !same(original.components, unit.components))
          throw Error('Original full manifest changed');
        if (exists(unit.archivePath)) throw Error('Archive unit already exists');
        auth.current();
        io.renameSync(unit.path, unit.archivePath);
        sync(dirname(unit.path));
        sync(dirname(unit.archivePath));
        return await finish(auth, intent);
      } catch (error) {
        if (held && !durable && same(json(guardPath), guard)) {
          io.unlinkSync(guardPath);
          sync(dirname(guardPath));
        }
        throw error;
      } finally {
        auth.lease.close();
      }
    },
    async verify(input) {
      if (used) throw Error('Original containment invocation cannot be replayed');
      used = true;
      const auth = authority(input);
      try {
        const intent = json(intentPath);
        if (
          !same(intent, {
            version: 1,
            operation,
            planSha256: plan.sha256,
            originalRowSha256: facts.retained.rowSha256,
            row: intent.row,
            unit,
            controls: facts.controls,
            controlIdentities: intent.controlIdentities,
            backupPath,
          }) ||
          digest(intent.row) !== facts.retained.rowSha256
        )
          throw Error('Exact original preservation intent required');
        // Verification never repeats unloading or moving an original path.
        return await finish(auth, intent);
      } finally {
        auth.lease.close();
      }
    },
  });
}
