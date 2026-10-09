#!/usr/bin/env node
import { recordOrVerifyFreshOwnerReceipt } from './lib/staging-cold-receipt.mjs';
import process from 'node:process';
import console from 'node:console';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdirSync, cpSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import Database from 'better-sqlite3';
import {
  privateJson,
  replacePrivateJson,
  assertVisibleTrackedIndex,
} from './lib/staging-files.mjs';
import { bytes, hash, directory, inventory, git, run } from './lib/staging-cold-audit.mjs';
import { exclusive, sync, sealTree } from './lib/staging-cold-prepare.mjs';
import { verifyPreparedController } from './lib/staging-cold-control.mjs';
import { runOwnedStageUpgrade, archiveRetiredReservation } from './lib/owned-stage-upgrade.mjs';
import { preparePinnedProgram, assertPinnedProgram } from './lib/owned-stage-program.mjs';
import {
  observeLiveOwner,
  assertEmptyStagingUse,
  verifyOriginalRetirement,
  stageJob,
  stageRows,
  listeners,
} from './lib/owned-stage-observation.mjs';

const root = join(userInfo().homedir, '.local/share/mitzo-staging'),
  source = dirname(dirname(fileURLToPath(import.meta.url))),
  owned = join(root, 'symposium/service'),
  lockPath = join(root, 'service/deployment.lock'),
  planPath = join(root, 'service/owned-update-plan.json');
function accepted(prepared = true) {
  const current = git(source, 'rev-parse', 'HEAD');
  if (
    current !==
      git(source, 'ls-remote', 'https://github.com/dimakis/mitzo.git', 'refs/heads/main').split(
        /\s+/,
      )[0] ||
    git(source, 'status', '--porcelain', '--untracked-files=no') ||
    git(source, 'remote', 'get-url', 'origin') !== 'https://github.com/dimakis/mitzo.git'
  )
    throw Error('Exact clean accepted main required');
  assertVisibleTrackedIndex(git(source, 'ls-files', '-v'));
  if (prepared) verifyPreparedController(root, source, current);
  return current;
}
function noLock() {
  if (lstatSync(lockPath, { throwIfNoEntry: false }))
    throw Error('Existing operation requires investigation');
}
function readArgs(args) {
  const v = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1] || v[args[i]])
      throw Error('Exact named arguments required');
    v[args[i]] = args[i + 1];
  }
  return v;
}
function exactKeys(v, keys) {
  if (JSON.stringify(Object.keys(v).sort()) !== JSON.stringify(keys.sort()))
    throw Error('Exact update arguments required');
}
function same(v, w) {
  return JSON.stringify(v) === JSON.stringify(w);
}
function controls(path) {
  return Object.fromEntries(
    ['topology.json', 'com.mitzo.staging.plist'].map((name) => [
      name,
      hash(bytes(join(path, name))),
    ]),
  );
}
function verifyControls(path, expected) {
  if (!same(controls(path), expected)) throw Error('Exact original control records changed');
}

function minimalConfig(old, pin) {
  return { ...old, personal: { ...old.personal, deviceLoginExecutable: pin } };
}
async function planUpdate(current, args) {
  noLock();
  exactKeys(args, [
    '--expected-source',
    '--instance',
    '--epoch',
    '--device-executable',
    '--expected-device-sha',
  ]);
  const live = await observeLiveOwner(root);
  if (
    args['--expected-source'] !== live.owner.sourceCommit ||
    args['--instance'] !== live.owner.instanceId ||
    Number(args['--epoch']) !== live.owner.epoch ||
    current === live.plan.sourceCommit
  )
    throw Error('Exact distinct original owner/target required');
  const empty = assertEmptyStagingUse(root, live),
    program = preparePinnedProgram(
      root,
      args['--device-executable'],
      args['--expected-device-sha'],
    ),
    proposal = minimalConfig(live.config, program.pin),
    operation = randomUUID(),
    archive = join(root, 'service/owned-updates', operation);
  const value = {
    version: 1,
    operation,
    target: current,
    controllerReceiptSha256: hash(bytes(join(source, 'staging-release.json'))),
    live,
    empty,
    controlRecords: controls(join(root, 'service')),
    proposal,
    programMetadata: program.metadata,
    proposalSha256: hash(JSON.stringify(proposal, null, 2) + '\n'),
    archive,
  };
  // Recheck the actual original owner after provisioning only the public program.
  if (!same(await observeLiveOwner(root), live))
    throw Error('Original owner changed during planning');
  exclusive(planPath, JSON.stringify(value, null, 2) + '\n');
  return {
    planned: true,
    operation,
    target: current,
    source: live.plan.sourceCommit,
    instanceId: live.owner.instanceId,
    epoch: live.owner.epoch,
    deviceExecutableSha256: program.pin.sha256,
    serviceControl: false,
    modelCalls: 0,
    productionActions: [],
  };
}
function verifyPlan(current, p) {
  if (
    p.version !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(p.operation ?? '') ||
    !/^[a-f0-9]{64}$/.test(p.proposal?.personal?.deviceLoginExecutable?.sha256 ?? '') ||
    p.proposal.personal.deviceLoginExecutable.executable !==
      join(
        root,
        'symposium/bin',
        'codex-device-auth-' + p.proposal.personal.deviceLoginExecutable.sha256.slice(0, 12),
      ) ||
    p.target !== current ||
    p.archive !== join(root, 'service/owned-updates', p.operation) ||
    hash(bytes(join(source, 'staging-release.json'))) !== p.controllerReceiptSha256 ||
    !same(p.proposal, minimalConfig(p.live.config, p.proposal.personal.deviceLoginExecutable)) ||
    hash(JSON.stringify(p.proposal, null, 2) + '\n') !== p.proposalSha256
  )
    throw Error('Exact prepared update drift');
  assertPinnedProgram(root, p.proposal.personal.deviceLoginExecutable, p.programMetadata);
}
async function freshOwner(p) {
  const { readOwnedReleasePlan, verifyRetainedOwnedRelease } =
      await import('../dist/symposium-owned-release.js'),
    { assertCanonicalOwnerRuntime } = await import('../dist/symposium-canonical-control.js'),
    { observeCanonicalProcess } = await import('../dist/symposium-canonical-owner-record.js');
  const plan = readOwnedReleasePlan(join(owned, 'owned-release.json'));
  verifyRetainedOwnedRelease(plan);
  if (
    plan.releaseRoot !== source ||
    plan.sourceCommit !== p.target ||
    plan.acceptedMainBaseline !== p.target ||
    plan.configSha256 !== p.proposalSha256
  )
    throw Error('Exact new owner target required');
  const owner = privateJson(join(owned, 'original-owner.json')),
    rows = stageRows(root);
  if (rows.length !== 1 || owner.instanceId === p.live.owner.instanceId)
    throw Error('Distinct original fresh owner required');
  const intent = privateJson(join(p.archive, 'fresh-activation.json'));
  for (const [name, expected] of Object.entries(intent.inputs))
    if (hash(bytes(join(owned, name))) !== expected) throw Error('Fresh prepared input changed');
  if (
    hash(bytes(join(root, 'service/com.mitzo.staging.plist'))) !== intent.plistSha256 ||
    hash(bytes(join(source, 'staging-release.json'))) !== p.controllerReceiptSha256
  )
    throw Error('Fresh canonical registration or controller changed');
  assertCanonicalOwnerRuntime(plan, owner, rows[0], {
    jobPid: stageJob(root).pid,
    parent: observeCanonicalProcess(owner.parent.pid),
    app: observeCanonicalProcess(owner.app.pid),
    portPids: listeners(3190),
    protectedPids: [...listeners(3100), ...listeners(3101)],
  });
  const response = await globalThis.fetch('http://127.0.0.1:3190/', {
    signal: globalThis.AbortSignal.timeout(3000),
  });
  if (!response.ok) throw Error('Fresh canonical HTTP unavailable');
  return { owner, row: rows[0], source: p.target, verified: true };
}
function verifyArchive(p, lock) {
  const receipt = privateJson(join(p.archive, 'retired-audit.json'));
  if (
    !same(receipt.live, p.live) ||
    receipt.operation !== p.operation ||
    receipt.target !== p.target ||
    receipt.retiredUse?.vmConfigSha256 !== p.empty.vmConfigSha256 ||
    !same(receipt.retiredUse?.workspaceFiles, receipt.files?.workspace) ||
    hash(JSON.stringify(receipt)) !== lock.retiredAuditSha256
  )
    throw Error('Original retirement archive binding changed');
  for (const [name, expected] of Object.entries(receipt.files))
    if (!same(inventory(join(p.archive, name)), expected))
      throw Error('Original archived evidence changed');
  verifyControls(p.archive, p.controlRecords);
  if (hash(bytes(join(p.archive, 'deployment.lock'))) !== receipt.controlRecords['deployment.lock'])
    throw Error('Archived original operation changed');
  if (
    hash(bytes(join(p.archive, 'original-config.json'))) !== p.live.configSha256 ||
    !bytes(join(p.archive, 'plan.json')).equals(bytes(planPath))
  )
    throw Error('Archived original config or full plan changed');
  return receipt;
}
function verifyRetiredHistory(p, lock) {
  const audit = verifyArchive(p, lock),
    db = new Database(join(root, 'registry/staging.db'), { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare('SELECT * FROM retired_owned_launches WHERE launchId=?')
      .get(audit.retired.row.launchId);
    if (
      !row ||
      row.recordJson !== JSON.stringify(audit.retired.row) ||
      row.receiptJson !== JSON.stringify(audit.retired.receipt) ||
      row.archive !== p.archive ||
      row.auditSha256 !== hash(bytes(join(p.archive, 'retired-audit.json')))
    )
      throw Error('Preserved original retirement history changed');
  } finally {
    db.close();
  }
}
async function applyUpdate(current) {
  noLock();
  const p = privateJson(planPath);
  verifyPlan(current, p);
  let retired,
    retiredUse,
    archiveOwned = false;
  const lock = {
    id: p.operation,
    mode: 'owned-custodian-update',
    expected: p.live.plan.sourceCommit,
    target: p.target,
    instanceId: p.live.owner.instanceId,
    epoch: p.live.owner.epoch,
    controllerSource: current,
    planSha256: hash(bytes(planPath)),
    requestedAt: Date.now(),
  };
  const ownLock = () => {
    if (!same(privateJson(lockPath), lock) || hash(bytes(planPath)) !== lock.planSha256)
      throw Error('Exact owned update lock changed');
  };
  await runOwnedStageUpgrade({
    async lock() {
      exclusive(lockPath, JSON.stringify(lock) + '\n');
    },
    async validateLive() {
      ownLock();
      verifyPlan(accepted(), p);
      const live = await observeLiveOwner(root);
      if (!same(live, p.live) || !same(assertEmptyStagingUse(root, live), p.empty))
        throw Error('Original initial stage changed');
      verifyControls(join(root, 'service'), p.controlRecords);
    },
    async retire() {
      ownLock();
      if (!same(await observeLiveOwner(root), p.live))
        throw Error('Original owner changed before retirement');
      if (accepted() !== current) throw Error('Main changed before control');
      assertPinnedProgram(root, p.proposal.personal.deviceLoginExecutable, p.programMetadata);
      run('/bin/launchctl', ['kill', 'SIGTERM', 'gui/' + process.getuid() + '/com.mitzo.staging']);
    },
    async verifyRetired() {
      const until = Date.now() + 180000;
      while (Date.now() < until) {
        try {
          retired = await verifyOriginalRetirement(root, p.live, lock.requestedAt);
          return;
        } catch {
          /* Original stop once; wait only. */
        }
        await setTimeout(250);
      }
      throw Error('Original retirement uncertain; retain lock');
    },
    async validateRetiredUse() {
      ownLock();
      const proof = await verifyOriginalRetirement(root, p.live, lock.requestedAt);
      if (!same(proof, retired)) throw Error('Original retirement changed');
      // The live check cannot cover writes before SIGTERM or during graceful
      // shutdown. Inspect the original paths after retirement, and recheck the
      // preserved snapshot immediately before any original-state disposition.
      const observed = assertEmptyStagingUse(root, p.live);
      if (
        observed.vmConfigSha256 !== p.empty.vmConfigSha256 ||
        (retiredUse && !same(observed, retiredUse))
      )
        throw Error('Retired initial stage changed; retain original state and lock');
      retiredUse = observed;
    },
    async preserveRetired() {
      ownLock();
      mkdirSync(join(root, 'service/owned-updates'), { recursive: true, mode: 0o700 });
      directory(join(root, 'service/owned-updates'));
      mkdirSync(p.archive, { mode: 0o700 });
      archiveOwned = true;
      const sources = {
          service: owned,
          workspace: p.live.plan.repositoryPath,
          'gateway-state': p.live.config.gateway.stateParent,
          registry: join(root, 'registry'),
        },
        files = Object.fromEntries(
          Object.entries(sources).map(([name, path]) => [name, inventory(path)]),
        );
      for (const [name, path] of Object.entries(sources))
        cpSync(path, join(p.archive, name), {
          recursive: true,
          verbatimSymlinks: true,
          errorOnExist: true,
          force: false,
        });
      for (const [name, expected] of Object.entries(files))
        if (!same(inventory(join(p.archive, name)), expected))
          throw Error('Retired evidence preservation mismatch');
      // The active update lock is new; preserve the original planned control bytes separately.
      exclusive(join(p.archive, 'deployment.lock'), JSON.stringify(lock) + '\n');
      for (const name of ['topology.json', 'com.mitzo.staging.plist'])
        cpSync(join(root, 'service', name), join(p.archive, name), {
          errorOnExist: true,
          force: false,
        });
      exclusive(join(p.archive, 'original-config.json'), bytes(p.live.plan.configPath));
      exclusive(join(p.archive, 'plan.json'), bytes(planPath));
      const audit = {
        operation: p.operation,
        target: p.target,
        live: p.live,
        retired,
        retiredUse,
        files,
        requestedAt: lock.requestedAt,
        controlRecords: { ...p.controlRecords, 'deployment.lock': hash(bytes(lockPath)) },
      };
      exclusive(join(p.archive, 'retired-audit.json'), JSON.stringify(audit, null, 2) + '\n');
      sealTree(p.archive);
      ownLock();
      const next = { ...lock, retiredAuditSha256: hash(JSON.stringify(audit)) };
      replacePrivateJson(lockPath, next);
      Object.assign(lock, next);
      verifyArchive(p, lock);
    },
    async qualifyRetired() {
      ownLock();
      verifyArchive(p, lock);
      const proof = await verifyOriginalRetirement(root, p.live, lock.requestedAt);
      if (!same(proof, retired)) throw Error('Original retirement changed');
      const { assertCanonicalOwnerRetired } =
          await import('../dist/symposium-canonical-control.js'),
        db = new Database(join(root, 'registry/staging.db'), { fileMustExist: true });
      try {
        db.pragma('synchronous = FULL');
        archiveRetiredReservation(
          db,
          retired.row,
          retired.receipt,
          p.archive,
          hash(bytes(join(p.archive, 'retired-audit.json'))),
          (row, receipt) =>
            assertCanonicalOwnerRetired(p.live.owner, row, receipt, lock.requestedAt),
        );
      } finally {
        db.close();
      }
      mkdirSync(join(p.archive, 'original-service-files'), { mode: 0o700 });
      for (const name of [
        'empty-accounts.json',
        'owned-release.json',
        'staging-operator.json',
        'staging-custodian.plist',
        'owner.stdout.log',
        'owner.stderr.log',
        'launch.intent',
        'original-owner.json',
      ])
        renameSync(join(owned, name), join(p.archive, 'original-service-files', name));
      for (const [old, name] of [
        [p.live.plan.repositoryPath, 'original-workspace'],
        [p.live.config.gateway.stateParent, 'original-gateway-state'],
      ]) {
        renameSync(old, join(p.archive, name));
        mkdirSync(old, { mode: 0o700 });
        sync(dirname(old));
      }
      const temp = p.live.plan.configPath + '.owned-update';
      exclusive(temp, JSON.stringify(p.proposal, null, 2) + '\n');
      if (hash(bytes(p.live.plan.configPath)) !== p.live.configSha256)
        throw Error('Original configuration changed');
      renameSync(temp, p.live.plan.configPath);
      sync(dirname(temp));
      sync(owned);
      sync(p.archive);
    },
    async prepareFresh() {
      ownLock();
      verifyRetiredHistory(p, lock);
      verifyArchive(p, lock);
      run(
        process.execPath,
        [
          join(source, 'scripts/prepare-owned-custodian-release.mjs'),
          '--owned-custodian',
          p.live.plan.configPath,
          p.live.plan.repositoryPath,
          owned,
          '--canonical',
          '--accepted-main-baseline',
          current,
        ],
        source,
      );
      run(
        process.execPath,
        [
          join(source, 'scripts/prepare-staging-service.mjs'),
          join(owned, 'owned-release.json'),
          join(root, 'symposium/settings/staging-registration.json'),
          '3190',
          '--canonical',
          '--accepted-main-baseline',
          current,
        ],
        source,
      );
      const { readOwnedReleasePlan, verifyOwnedRelease } =
        await import('../dist/symposium-owned-release.js');
      verifyOwnedRelease(readOwnedReleasePlan(join(owned, 'owned-release.json')));
      const { validateRecoveryPlist } = await import('./lib/staging-cold-plist.mjs'),
        plan = readOwnedReleasePlan(join(owned, 'owned-release.json')),
        plist = JSON.parse(
          run('/usr/bin/plutil', [
            '-convert',
            'json',
            '-o',
            '-',
            join(owned, 'staging-custodian.plist'),
          ]),
        );
      validateRecoveryPlist(root, plan, plist, process.execPath);
      exclusive(
        join(p.archive, 'fresh-activation.json'),
        JSON.stringify({
          target: current,
          inputs: Object.fromEntries(
            [
              'owned-release.json',
              'staging-custodian.plist',
              'staging-operator.json',
              'empty-accounts.json',
            ].map((n) => [n, hash(bytes(join(owned, n)))]),
          ),
          plistSha256: hash(bytes(join(owned, 'staging-custodian.plist'))),
          configSha256: hash(bytes(p.live.plan.configPath)),
        }) + '\n',
      );
    },
    async startFresh() {
      ownLock();
      verifyRetiredHistory(p, lock);
      verifyArchive(p, lock);
      if (
        accepted() !== current ||
        stageJob(root).pid ||
        listeners(3190).length ||
        listeners(p.live.config.gateway.port).length
      )
        throw Error('Exact accepted vacant canonical job required');
      const job = 'gui/' + process.getuid() + '/com.mitzo.staging';
      exclusive(
        join(p.archive, 'start-attempt.json'),
        JSON.stringify({ target: current, operation: p.operation, at: Date.now() }) + '\n',
      );
      run('/bin/launchctl', ['bootout', job]);
      const temporary = join(root, 'service/com.mitzo.staging.plist.owned-update');
      exclusive(temporary, bytes(join(owned, 'staging-custodian.plist')));
      renameSync(temporary, join(root, 'service/com.mitzo.staging.plist'));
      sync(join(root, 'service'));
      exclusive(
        join(root, 'service/topology.json.owned-update'),
        JSON.stringify({
          mode: 'owned-custodian',
          sourceCommit: current,
          transitionId: p.operation,
        }) + '\n',
      );
      renameSync(
        join(root, 'service/topology.json.owned-update'),
        join(root, 'service/topology.json'),
      );
      sync(join(root, 'service'));
      run('/bin/launchctl', [
        'bootstrap',
        'gui/' + process.getuid(),
        join(root, 'service/com.mitzo.staging.plist'),
      ]);
      run('/bin/launchctl', ['kickstart', job]);
    },
    async verifyFresh() {
      ownLock();
      verifyRetiredHistory(p, lock);
      verifyArchive(p, lock);
      const until = Date.now() + 120000;
      while (Date.now() < until) {
        try {
          const result = await freshOwner(p);
          recordOrVerifyFreshOwnerReceipt(join(p.archive, 'fresh-owner-verified.json'), result);
          return;
        } catch {
          /* One start only; no adoption or restart. */
        }
        await setTimeout(500);
      }
      throw Error('Fresh original owner uncertain; retain lock');
    },
    async audit(state) {
      if (archiveOwned)
        exclusive(
          join(p.archive, 'update-' + state + '.json'),
          JSON.stringify({ operation: p.operation, state, modelCalls: 0, productionActions: [] }) +
            '\n',
        );
    },
    async unlock() {
      ownLock();
      unlinkSync(lockPath);
      sync(dirname(lockPath));
    },
  });
  return {
    verified: true,
    target: current,
    operation: p.operation,
    originalRetirementVerified: true,
    modelCalls: 0,
    productionActions: [],
  };
}
try {
  if (process.platform !== 'darwin') throw Error('Canonical macOS only');
  const args = process.argv.slice(2),
    command = args.shift();
  if (command === 'prepare-release') {
    const v = readArgs(args);
    exactKeys(v, ['--commit', '--dependency-source', '--expected-dependency-fingerprint']);
    const current = accepted(false);
    noLock();
    await observeLiveOwner(root);
    if (v['--commit'] !== current) throw Error('Exact accepted target required');
    console.log(
      run(
        process.execPath,
        [join(source, 'scripts/staging.mjs'), 'prepare', ...args],
        source,
        undefined,
        0,
      ),
    );
  } else if (command === 'verify' && !args.length) {
    const current = accepted(),
      p = privateJson(planPath),
      lock = privateJson(lockPath);
    verifyPlan(current, p);
    if (
      lock.id !== p.operation ||
      lock.target !== current ||
      lock.mode !== 'owned-custodian-update' ||
      lock.planSha256 !== hash(bytes(planPath))
    )
      throw Error('Exact interrupted update required');
    verifyRetiredHistory(p, lock);
    const result = await freshOwner(p);
    recordOrVerifyFreshOwnerReceipt(join(p.archive, 'fresh-owner-verified.json'), result);
    if (!same(privateJson(lockPath), lock)) throw Error('Interrupted operation changed');
    unlinkSync(lockPath);
    sync(dirname(lockPath));
    console.log(
      JSON.stringify({
        ...result,
        operation: p.operation,
        verificationOnly: true,
        modelCalls: 0,
        productionActions: [],
      }),
    );
  } else if (command === 'plan')
    console.log(JSON.stringify(await planUpdate(accepted(), readArgs(args))));
  else if (command === 'apply' && !args.length)
    console.log(JSON.stringify(await applyUpdate(accepted())));
  else throw Error('Use prepare-release, plan with exact owner/device pins, or apply');
} catch (error) {
  console.error(
    error.message +
      '; preserve original ownership, lock and archive. No forced restart or rollback.',
  );
  process.exitCode = 1;
}
