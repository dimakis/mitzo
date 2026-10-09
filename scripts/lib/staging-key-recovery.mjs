import { verifyOriginalKeyRetention } from './staging-key-retention.mjs';
import {
  validateKeyRefusalRegistration,
  validateLoadedHistoricalJob,
} from './staging-cold-plist.mjs';
import { run } from './staging-cold-audit.mjs';
import process from 'node:process';
import { verifyControlCopies, verifyHistoricalControls } from './staging-key-controls.mjs';
import { join } from 'node:path';
import { mkdirSync, cpSync, renameSync } from 'node:fs';
import Database from 'better-sqlite3';
import { privateJson } from './staging-files.mjs';
import { bytes, hash, directory, inventory } from './staging-cold-audit.mjs';
import { exclusive, sync, sealTree } from './staging-cold-prepare.mjs';
import { prepareColdRefusal, classifyColdRefusal } from './staging-cold-refusal.mjs';
import { classifyKeyRefusal, quarantineKeyReservation } from './staging-key-refusal.mjs';
import {
  deriveKeyConfiguration,
  installFreshKeyConfiguration,
} from './staging-key-configuration.mjs';
const trees = (s) => [
  ['service', s.serviceFiles],
  ['workspace', s.workspaceFiles],
  ['gateway-state', s.gatewayFiles],
  ['registry', s.registryFiles],
];
export async function prepareKeyMetadata(root, expectedAudit, audit) {
  const first = await audit(root),
    s = first.snapshot;
  if (first.auditSha256 !== expectedAudit) throw Error('Original key-refusal audit changed');
  const owned = join(root, 'symposium/service'),
    archive = join(s.previousRecovery.archive, 'key-refusals', s.row.launchId),
    originalConfig = bytes(s.plan.configPath);
  let ownedArchive = false;
  await prepareColdRefusal({
    async validate() {
      if ((await audit(root)).auditSha256 !== expectedAudit)
        throw Error('Original key refusal changed during preservation');
    },
    async archive() {
      mkdirSync(join(s.previousRecovery.archive, 'key-refusals'), { recursive: true, mode: 0o700 });
      directory(join(s.previousRecovery.archive, 'key-refusals'));
      mkdirSync(archive, { mode: 0o700 });
      ownedArchive = true;
      for (const [src, dst] of [
        [owned, 'service'],
        [s.plan.repositoryPath, 'workspace'],
        [first.config.gateway.stateParent, 'gateway-state'],
        [join(root, 'registry'), 'registry'],
      ])
        cpSync(src, join(archive, dst), {
          recursive: true,
          verbatimSymlinks: true,
          errorOnExist: true,
          force: false,
        });
      for (const [name, expected] of trees(s))
        if (JSON.stringify(inventory(join(archive, name))) !== JSON.stringify(expected))
          throw Error('Original preserved evidence changed');
      exclusive(join(archive, 'audit.json'), JSON.stringify(s, null, 2) + '\n');
      exclusive(join(archive, 'original-config.json'), originalConfig);
      mkdirSync(join(archive, 'original-keys'), { mode: 0o700 });
      for (const [name, record] of Object.entries(s.originalKeys))
        cpSync(record.path, join(archive, 'original-keys', name), {
          errorOnExist: true,
          force: false,
        });
      verifyOriginalKeyRetention(archive, s.originalKeys, first.config);
      for (const name of [
        'deployment.lock',
        'topology.json',
        'com.mitzo.staging.plist',
        'cold-recovery.json',
        'cold-activation.json',
      ])
        cpSync(join(root, 'service', name), join(archive, name), {
          errorOnExist: true,
          force: false,
        });
      verifyControlCopies(archive, s.controlRecords);
      sealTree(archive);
    },
    async classify() {
      const db = new Database(join(root, 'registry/staging.db'), { fileMustExist: true });
      try {
        db.pragma('synchronous = FULL');
        quarantineKeyReservation(db, s, archive, expectedAudit);
      } finally {
        db.close();
      }
    },
    async vacate() {
      mkdirSync(join(archive, 'original-service-files'), { mode: 0o700 });
      for (const name of [
        'empty-accounts.json',
        'owned-release.json',
        'staging-operator.json',
        'staging-custodian.plist',
        'owner.stdout.log',
        'owner.stderr.log',
        'launch.intent',
      ]) {
        if (hash(bytes(join(owned, name))) !== s.serviceFiles[name]?.sha256)
          throw Error('Original service evidence changed');
        renameSync(join(owned, name), join(archive, 'original-service-files', name));
      }
      for (const [old, name] of [
        [s.plan.repositoryPath, 'original-workspace'],
        [first.config.gateway.stateParent, 'original-gateway-state'],
      ]) {
        renameSync(old, join(archive, name));
        mkdirSync(old, { mode: 0o700 });
        sync(join(old, '..'));
      }
      renameSync(
        join(root, 'service/cold-activation.json'),
        join(archive, 'original-activation-intent.json'),
      );
      sync(owned);
      sync(archive);
      sync(join(root, 'service'));
    },
    async record() {
      const fresh = installFreshKeyConfiguration(
        root,
        s.plan.configPath,
        originalConfig,
        s.row.launchId,
      );
      const receipt = {
        version: 2,
        operation: s.operation,
        archive,
        auditSha256: expectedAudit,
        classification: 'pre_resource_refused',
        originalLaunchId: s.row.launchId,
        originalSource: s.plan.sourceCommit,
        originalRegistrationSha256: s.registrationSha256,
        ...fresh,
        nativeRetirement: false,
        serviceControl: false,
        modelCalls: 0,
        productionActions: [],
      };
      exclusive(
        join(root, 'service/cold-recovery.json.key-prepared'),
        JSON.stringify(receipt, null, 2) + '\n',
      );
      // Preserve the exact previous receipt before promoting the newly bound one.
      renameSync(
        join(root, 'service/cold-recovery.json'),
        join(archive, 'previous-cold-recovery.json'),
      );
      renameSync(
        join(root, 'service/cold-recovery.json.key-prepared'),
        join(root, 'service/cold-recovery.json'),
      );
      sync(join(root, 'service'));
      sync(archive);
    },
    async audit() {
      if (ownedArchive)
        exclusive(
          join(archive, 'metadata-uncertain.json'),
          JSON.stringify({ operation: s.operation, lockRetained: true, serviceControl: false }) +
            '\n',
        );
    },
  });
  return {
    prepared: true,
    archive,
    originalOperation: s.operation,
    classification: 'pre_resource_refused',
    lockRetained: true,
    oldKeysPreserved: true,
    serviceControl: false,
    modelCalls: 0,
  };
}
export async function verifyKeyRecovery(root, recovery, vacant = true, trustedValidateSigning) {
  if (
    recovery.version !== 2 ||
    recovery.classification !== 'pre_resource_refused' ||
    recovery.nativeRetirement !== false ||
    recovery.serviceControl !== false ||
    recovery.modelCalls !== 0 ||
    JSON.stringify(recovery.productionActions) !== '[]' ||
    !/^[a-f0-9-]{36}$/.test(recovery.operation ?? '') ||
    !/^[a-f0-9-]{36}$/.test(recovery.originalLaunchId ?? '') ||
    recovery.archive !==
      join(
        root,
        'service/cold-refusals',
        recovery.operation,
        'key-refusals',
        recovery.originalLaunchId,
      )
  )
    throw Error('Exact prepared key refusal required');
  directory(recovery.archive);
  const s = privateJson(join(recovery.archive, 'audit.json'));
  if (
    hash(JSON.stringify(s)) !== recovery.auditSha256 ||
    s.operation !== recovery.operation ||
    s.row.launchId !== recovery.originalLaunchId ||
    s.plan.sourceCommit !== recovery.originalSource ||
    s.registrationSha256 !== recovery.originalRegistrationSha256
  )
    throw Error('Prepared key refusal proof changed');
  classifyKeyRefusal(s);
  verifyControlCopies(recovery.archive, s.controlRecords);
  verifyHistoricalControls(recovery.archive, s);
  validateKeyRefusalRegistration(
    root,
    s.plan,
    bytes(join(recovery.archive, 'com.mitzo.staging.plist')),
    bytes(join(recovery.archive, 'service/staging-custodian.plist')),
    s.registration,
    s.nodeExecutable,
  );
  for (const [name, expected] of trees(s))
    if (JSON.stringify(inventory(join(recovery.archive, name))) !== JSON.stringify(expected))
      throw Error('Archived key refusal evidence drift');
  const old = s.previousRecovery;
  if (
    old.version !== 1 ||
    old.archive !== join(root, 'service/cold-refusals', s.operation) ||
    JSON.stringify(privateJson(join(recovery.archive, 'previous-cold-recovery.json'))) !==
      JSON.stringify(old) ||
    JSON.stringify(privateJson(join(recovery.archive, 'cold-recovery.json'))) !==
      JSON.stringify(old)
  )
    throw Error('Exact previous refusal receipt changed');
  for (const path of [
    join(old.archive, 'activation-attempt.json'),
    join(recovery.archive, 'cold-activation.json'),
    join(recovery.archive, 'original-activation-intent.json'),
  ])
    if (JSON.stringify(privateJson(path)) !== JSON.stringify(s.activation))
      throw Error('Preserved original activation proof changed');
  directory(old.archive);
  const original = privateJson(join(old.archive, 'audit.json'));
  classifyColdRefusal(original);
  verifyControlCopies(old.archive, s.previousControlRecords);
  verifyHistoricalControls(old.archive, original);
  if (
    hash(JSON.stringify(original)) !== old.auditSha256 ||
    old.auditSha256 !== s.previousAuditSha256 ||
    original.operation !== s.operation ||
    original.row.launchId !== old.originalLaunchId
  )
    throw Error('Previous mandatory refusal proof changed');
  for (const [name, expected] of trees(original))
    if (JSON.stringify(inventory(join(old.archive, name))) !== JSON.stringify(expected))
      throw Error('Archived first refusal evidence drift');
  const oldConfig = bytes(join(recovery.archive, 'original-config.json'));
  if (
    hash(oldConfig) !== s.configSha256 ||
    hash(oldConfig) !== original.configSha256 ||
    s.plan.configSha256 !== s.configSha256
  )
    throw Error('Exact original key configuration changed');
  verifyOriginalKeyRetention(recovery.archive, s.originalKeys, JSON.parse(oldConfig));
  const next = deriveKeyConfiguration(root, JSON.parse(oldConfig), s.row.launchId),
    actual = bytes(s.plan.configPath);
  if (
    JSON.stringify(JSON.parse(actual)) !== JSON.stringify(next) ||
    hash(actual) !== recovery.freshConfigSha256
  )
    throw Error('Only exact fresh key references are permitted');
  const expectedKeys = Object.entries(next.gateway.jwt);
  if (
    JSON.stringify(Object.keys(recovery.freshKeys ?? {}).sort()) !==
    JSON.stringify(expectedKeys.map(([name]) => name).sort())
  )
    throw Error('Exact fresh key receipt required');
  for (const [name, path] of expectedKeys)
    if (
      recovery.freshKeys[name]?.path !== path ||
      hash(bytes(path)) !== recovery.freshKeys[name]?.sha256
    )
      throw Error('Fresh private key bytes changed');
  // Private constructor seam for hermetic tests; CLI never accepts a hook.
  const validateSigning =
    trustedValidateSigning ??
    (await import('../../dist/symposium-gateway-signing.js')).validateGatewaySigningMaterial;
  if (
    typeof validateSigning !== 'function' ||
    validateSigning(Object.fromEntries(expectedKeys.map(([name, path]) => [name, bytes(path)]))) !==
      undefined
  )
    throw Error('Synchronous trusted signing validation required');
  const lock = privateJson(join(root, 'service/deployment.lock'));
  if (
    JSON.stringify(lock) !== JSON.stringify(s.lock) ||
    JSON.stringify(original.lock) !== JSON.stringify(lock)
  )
    throw Error('Original deployment operation changed');
  const db = new Database(join(root, 'registry/staging.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rows = db.prepare('SELECT * FROM qualified_cold_refusals').all(),
      earlier = s.qualified[0];
    if (
      rows.length !== 2 ||
      rows[0].launchId !== earlier.launchId ||
      JSON.stringify(rows[0]) !== JSON.stringify(earlier) ||
      earlier.recordJson !== JSON.stringify(original.row) ||
      earlier.auditSha256 !== old.auditSha256 ||
      earlier.archive !== old.archive ||
      rows[1].launchId !== s.row.launchId ||
      rows[1].classification !== 'pre_resource_refused' ||
      rows[1].recordJson !== JSON.stringify(s.row) ||
      rows[1].auditSha256 !== recovery.auditSha256 ||
      rows[1].archive !== recovery.archive ||
      db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity !== 1 ||
      (vacant && db.prepare('SELECT COUNT(*) n FROM launches').get().n)
    )
      throw Error('Exact preserved disposition changed');
  } finally {
    db.close();
  }
  if (vacant) {
    const { failedJob } = await import('./staging-cold-control.mjs');
    failedJob(root, s);
    validateLoadedHistoricalJob(
      run('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/com.mitzo.staging']),
      s.registration,
    );
  }
  return { recovery, s, lock };
}
