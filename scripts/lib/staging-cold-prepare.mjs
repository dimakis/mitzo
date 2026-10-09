import { join, dirname } from 'node:path';
import {
  mkdirSync,
  cpSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import Database from 'better-sqlite3';
import { auditColdRefusal, hash, inventory, bytes, directory } from './staging-cold-audit.mjs';
import { prepareColdRefusal, quarantineColdReservation } from './staging-cold-refusal.mjs';
export function exclusive(path, data) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  sync(dirname(path));
}
export function sync(path) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function sealTree(path) {
  const s = lstatSync(path);
  if (s.isDirectory()) {
    for (const n of readdirSync(path)) sealTree(join(path, n));
  }
  sync(path);
}
export const displaced = [
  'empty-accounts.json',
  'owned-release.json',
  'staging-operator.json',
  'staging-custodian.plist',
  'owner.stdout.log',
  'owner.stderr.log',
  'launch.intent',
  'transition.json',
];
/** Uses the retained original lock. No service control or original owner claim. */
export async function prepareColdMetadata(root, expectedAudit, audit = auditColdRefusal) {
  const first = await audit(root);
  if (first.auditSha256 !== expectedAudit) throw Error('Original cold-refusal audit changed');
  const s = first.snapshot,
    archive = join(root, 'service/cold-refusals', s.operation),
    owned = join(root, 'symposium/service');
  const validate = async () => {
    if ((await audit(root)).auditSha256 !== expectedAudit)
      throw Error('Original refusal changed during preservation');
  };
  let archiveOwned = false;
  await prepareColdRefusal({
    validate,
    async archive() {
      mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
      directory(dirname(archive));
      mkdirSync(archive, { mode: 0o700 });
      archiveOwned = true;
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
      for (const [name, expected] of [
        ['service', s.serviceFiles],
        ['workspace', s.workspaceFiles],
        ['gateway-state', s.gatewayFiles],
        ['registry', s.registryFiles],
      ])
        if (JSON.stringify(inventory(join(archive, name))) !== JSON.stringify(expected))
          throw Error('Preserved original evidence changed');
      exclusive(join(archive, 'audit.json'), JSON.stringify(s, null, 2) + '\n');
      for (const name of ['deployment.lock', 'topology.json', 'com.mitzo.staging.plist'])
        cpSync(join(root, 'service', name), join(archive, name), {
          errorOnExist: true,
          force: false,
        });
      sealTree(archive);
    },
    async classify() {
      const db = new Database(join(root, 'registry/staging.db'), { fileMustExist: true });
      try {
        db.pragma('synchronous = FULL');
        quarantineColdReservation(db, s, archive, expectedAudit);
      } finally {
        db.close();
      }
    },
    async vacate() {
      mkdirSync(join(archive, 'original-service-files'), { mode: 0o700 });
      for (const name of [...displaced, 'transition-' + s.operation + '-uncertain.json']) {
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
        sync(dirname(old));
      }
      sync(owned);
      sync(archive);
    },
    async record() {
      exclusive(
        join(root, 'service/cold-recovery.json'),
        JSON.stringify(
          {
            version: 1,
            operation: s.operation,
            archive,
            auditSha256: expectedAudit,
            classification: 'pre_native_refused',
            originalLaunchId: s.row.launchId,
            originalSource: s.plan.sourceCommit,
            originalRegistrationSha256: s.registrationSha256,
            nativeRetirement: false,
            serviceControl: false,
            modelCalls: 0,
            productionActions: [],
          },
          null,
          2,
        ) + '\n',
      );
    },
    async audit() {
      if (!archiveOwned) return;
      exclusive(
        join(archive, 'metadata-uncertain.json'),
        JSON.stringify({ operation: s.operation, lockRetained: true, serviceControl: false }) +
          '\n',
      );
    },
  });
  return {
    archive,
    prepared: true,
    originalOperation: s.operation,
    lockRetained: true,
    serviceControl: false,
    modelCalls: 0,
  };
}
