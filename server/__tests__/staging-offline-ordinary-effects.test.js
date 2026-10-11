import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  collectOfflineOrdinaryRestorationFacts,
  createOfflineOrdinaryEffects,
  observeOfflineOrdinaryPhysicalScope,
} from '../../scripts/lib/staging-offline-ordinary-effects.mjs';
import {
  createOfflineOrdinaryRestoration,
  createOfflineOrdinaryRestorationPlan,
} from '../../scripts/lib/staging-offline-ordinary-restore.mjs';
import {
  OFFLINE_CONTAINMENT_TARGET,
  offlineContainmentDigest,
} from '../../scripts/lib/staging-offline-containment-contract.mjs';
const inspectionMapping = vi.hoisted(() => ({ map: (path) => path }));
vi.mock('../../scripts/lib/staging-offline-containment-observation.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    inspectOpaquePreservationTree: (path, options) =>
      actual.inspectOpaquePreservationTree(inspectionMapping.map(path), options),
    inspectOpaqueContainmentTree: (path, options) =>
      actual.inspectOpaqueContainmentTree(inspectionMapping.map(path), options),
  };
});
const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const temporary = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ordinary-effects-test-')));
  roots.push(temporary);
  const canonicalRoot = OFFLINE_CONTAINMENT_TARGET.canonicalRoot,
    archiveRoot = canonicalRoot + '-quarantine/33333333-3333-4333-8333-333333333333';
  const sourceCommit = 'a'.repeat(40),
    release = join(canonicalRoot, 'releases', sourceCommit.slice(0, 12));
  const map = (path) =>
    typeof path === 'string' && path.startsWith(canonicalRoot)
      ? temporary + '/stage' + path.slice(canonicalRoot.length)
      : path;
  const inverse = (path) =>
    path.startsWith(temporary + '/stage')
      ? canonicalRoot + path.slice((temporary + '/stage').length)
      : path;
  const io = { ...fs };
  for (const name of [
    'lstatSync',
    'readFileSync',
    'writeFileSync',
    'mkdirSync',
    'readdirSync',
    'openSync',
    'chmodSync',
    'unlinkSync',
  ])
    io[name] = (...args) => fs[name](map(args[0]), ...args.slice(1));
  io.renameSync = (a, b) => fs.renameSync(map(a), map(b));
  io.realpathSync = (path) => inverse(fs.realpathSync(map(path)));
  const mkdir = (path) => fs.mkdirSync(map(path), { recursive: true, mode: 0o700 });
  mkdir(canonicalRoot);
  mkdir(archiveRoot);
  mkdir(join(canonicalRoot, 'service/control-lib'));
  mkdir(join(canonicalRoot, 'bin'));
  for (const kind of ['home', 'workspace', 'state', 'settings']) {
    mkdir(join(canonicalRoot, kind));
    fs.writeFileSync(map(join(canonicalRoot, kind, 'retained.txt')), 'opaque prior ' + kind, {
      mode: 0o600,
    });
  }
  const sourceReceipt = {
    sourceCommit,
    sourceTree: 'b'.repeat(40),
    compiledArtifacts: { 'dist/index.js': 'c'.repeat(64) },
    dependencyFingerprint: 'd'.repeat(64),
  };
  mkdir(join(release, 'scripts/lib'));
  for (const name of [
    'staging-launcher-template.mjs',
    'staging-files.mjs',
    'staging-operations.mjs',
  ])
    fs.copyFileSync(
      join(process.cwd(), 'scripts/lib', name),
      map(join(release, 'scripts/lib', name)),
    );
  fs.writeFileSync(
    map(join(release, 'staging-release.json')),
    JSON.stringify(sourceReceipt) + '\n',
    { mode: 0o600 },
  );
  fs.writeFileSync(map(join(canonicalRoot, 'service/start.mjs')), 'prior launcher', {
    mode: 0o600,
  });
  const nodePath = '/virtual/node';
  const nodeIo = {
    ...io,
    realpathSync: (path) => (path === nodePath ? nodePath : io.realpathSync(path)),
  };
  const inspectTree = (path) => {
    const actual = map(path),
      names = fs.readdirSync(actual).sort();
    return {
      sha256: hash(
        JSON.stringify(names.map((name) => [name, fs.readFileSync(join(actual, name), 'utf8')])),
      ),
    };
  };
  const assertAcceptedPreparedSource = vi.fn(async () => undefined);
  const containmentPlan = {
    sha256: 'e'.repeat(64),
    facts: { canonicalRoot, archiveRoot, controls: OFFLINE_CONTAINMENT_TARGET.controls },
  };
  const deps = { io: nodeIo, inspectTree, nodePath, observePhysicalScope: vi.fn(() => true) };
  const verifyContainment = vi.fn(async () => ({ receiptSha256: 'f'.repeat(64) }));
  const continuation = {
    assertOwnedGuard: vi.fn(),
    bindOrdinaryGuard: vi.fn(),
    completeOrdinaryGuard: vi.fn(),
  };
  const run = vi.fn((program, args) => {
    if (program === '/bin/launchctl' && args[0] === 'print')
      return {
        status: 113,
        stdout: '',
        stderr: `Could not find service "com.mitzo.staging" in domain for user gui: ${process.getuid()}`,
      };
    return { status: 0, stdout: '', stderr: '' };
  });
  return {
    canonicalRoot,
    archiveRoot,
    release,
    sourceCommit,
    temporary,
    map,
    io: nodeIo,
    inspectTree,
    containmentPlan,
    deps,
    assertAcceptedPreparedSource,
    verifyContainment,
    continuation,
    run,
  };
}
it('collects bound opaque preservation and accepted literal installation bytes without predicting a receipt', async () => {
  const f = fixture();
  const facts = await collectOfflineOrdinaryRestorationFacts(
    {
      containmentPlan: f.containmentPlan,
      sourceCommit: f.sourceCommit,
      assertAcceptedPreparedSource: f.assertAcceptedPreparedSource,
    },
    f.deps,
  );
  const plan = createOfflineOrdinaryRestorationPlan(facts);
  expect(plan.facts.containment.receiptSha256).toBeUndefined();
  expect(plan.facts.preservation).toHaveLength(4);
  expect(
    plan.facts.installation.controlFiles.find((file) => file.path.endsWith('/topology.json'))
      .nextSha256,
  ).toBe('derived_containment_topology');
  expect(
    plan.facts.installation.controlFiles.find((file) =>
      file.path.endsWith('/com.mitzo.staging.plist'),
    ).prior,
  ).toEqual({ state: 'absent' });
  expect(f.assertAcceptedPreparedSource).toHaveBeenCalled();
  expect(fs.readFileSync(f.map(join(f.canonicalRoot, 'home/retained.txt')), 'utf8')).toBe(
    'opaque prior home',
  );
});
it('moves opaque directories, snapshots only bound controls and installs fresh ordinary files while guard capability owns control', async () => {
  const f = fixture(),
    facts = await collectOfflineOrdinaryRestorationFacts(
      {
        containmentPlan: f.containmentPlan,
        sourceCommit: f.sourceCommit,
        assertAcceptedPreparedSource: f.assertAcceptedPreparedSource,
      },
      f.deps,
    ),
    plan = createOfflineOrdinaryRestorationPlan(facts);
  const effects = createOfflineOrdinaryEffects(
    {
      plan,
      verifySource: f.assertAcceptedPreparedSource,
      verifyContainment: f.verifyContainment,
      continuation: f.continuation,
      assertAuthorityCurrent: () => true,
    },
    { ...f.deps, run: f.run },
  );
  const context = { assertCurrent: vi.fn() };
  await effects.assertAcceptedPreparedSource(plan, context);
  await effects.assertNativeContained(plan, context);
  for (const file of plan.facts.installation.controlFiles) {
    await effects.snapshotControl(file, plan, context);
    await effects.assertControlSnapshot(file, plan, context);
  }
  for (const unit of plan.facts.preservation) {
    await effects.preserveUnit(unit, plan, context);
    await effects.assertPreservedUnit(unit, plan, context);
    await effects.createFreshDirectory(
      { path: unit.path, mode: 0o700, empty: true },
      plan,
      context,
    );
  }
  await effects.writeFreshSettings(
    {
      operator: { AUTH_PASSPHRASE: 'a'.repeat(64), AUTH_SECRET: 'b'.repeat(128) },
      accountProfiles: [],
      mode: 0o600,
    },
    plan,
    context,
  );
  await effects.installOrdinaryController(plan, context);
  await effects.assertInstalledOrdinary(plan, context);
  expect(
    fs.readFileSync(f.map(join(f.archiveRoot, 'ordinary-prior/home/retained.txt')), 'utf8'),
  ).toBe('opaque prior home');
  expect(fs.readdirSync(f.map(join(f.canonicalRoot, 'home')))).toEqual([]);
  expect(
    JSON.parse(
      fs.readFileSync(f.map(join(f.canonicalRoot, 'settings/account-profiles.json')), 'utf8'),
    ),
  ).toEqual([]);
  expect(fs.readFileSync(f.map(join(f.canonicalRoot, 'service/start.mjs')), 'utf8')).toContain(
    'MITZO_CODEX_ENABLED',
  );
  const topology = JSON.parse(
    fs.readFileSync(f.map(join(f.canonicalRoot, 'service/topology.json')), 'utf8'),
  );
  expect(topology).toMatchObject({ mode: 'ordinary', containmentReceiptSha256: 'f'.repeat(64) });
  expect(effects.getReplacementProof().nodeArgs).toEqual([
    '/virtual/node',
    join(f.canonicalRoot, 'service/start.mjs'),
  ]);
  const plist = fs.readFileSync(
    f.map(join(f.canonicalRoot, 'service/com.mitzo.staging.plist')),
    'utf8',
  );
  expect(plist).toContain('<key>HOME</key><string>' + homedir() + '</string>');
  expect(plist).not.toContain('/usr/bin/env');
  expect(f.continuation.assertOwnedGuard).toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
it('refuses changed prior bytes, aliases and overwritten archive destinations without any launch', async () => {
  const f = fixture(),
    facts = await collectOfflineOrdinaryRestorationFacts(
      {
        containmentPlan: f.containmentPlan,
        sourceCommit: f.sourceCommit,
        assertAcceptedPreparedSource: f.assertAcceptedPreparedSource,
      },
      f.deps,
    ),
    plan = createOfflineOrdinaryRestorationPlan(facts);
  const effects = createOfflineOrdinaryEffects(
    {
      plan,
      verifySource: f.assertAcceptedPreparedSource,
      verifyContainment: f.verifyContainment,
      continuation: f.continuation,
      assertAuthorityCurrent: () => true,
    },
    { ...f.deps, run: f.run },
  );
  fs.writeFileSync(f.map(join(f.canonicalRoot, 'service/start.mjs')), 'changed');
  await expect(
    effects.snapshotControl(
      plan.facts.installation.controlFiles.find((file) => file.path.endsWith('/start.mjs')),
      plan,
      { assertCurrent() {} },
    ),
  ).rejects.toThrow();
  const unit = plan.facts.preservation[0];
  fs.mkdirSync(f.map(unit.archivePath), { recursive: true, mode: 0o700 });
  await expect(effects.preserveUnit(unit, plan, { assertCurrent() {} })).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it('waits for the original process source and HTTP readiness without repeating startup', async () => {
  const f = fixture(),
    facts = await collectOfflineOrdinaryRestorationFacts(
      {
        containmentPlan: f.containmentPlan,
        sourceCommit: f.sourceCommit,
        assertAcceptedPreparedSource: f.assertAcceptedPreparedSource,
      },
      f.deps,
    ),
    plan = createOfflineOrdinaryRestorationPlan(facts);
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(Error('not listening'))
    .mockResolvedValueOnce({ status: 503 })
    .mockResolvedValue({ status: 200 });
  const wait = vi.fn(async () => {});
  const run = vi.fn((program, args) => {
    if (program === '/bin/launchctl' && args[0] === 'print')
      return { status: 0, stdout: 'path = ' + plan.registration.path + '\npid = 456\n' };
    if (program === '/bin/ps')
      return {
        status: 0,
        stdout:
          args.at(-1) === 'lstart='
            ? 'Sun Oct 11 12:00:00 2026\n'
            : '/virtual/node ' + join(f.release, 'dist/index.js') + '\n',
      };
    if (program === '/usr/sbin/lsof' && args.includes('cwd'))
      return { status: 0, stdout: 'p456\nn' + f.release + '\n' };
    if (program === '/usr/sbin/lsof')
      return args.includes('-iTCP:3190')
        ? { status: 0, stdout: '456\n' }
        : { status: 1, stdout: '' };
    return { status: 0, stdout: '' };
  });
  const effects = createOfflineOrdinaryEffects(
    {
      plan,
      verifySource: f.assertAcceptedPreparedSource,
      verifyContainment: f.verifyContainment,
      continuation: f.continuation,
      assertAuthorityCurrent: () => true,
    },
    { ...f.deps, run, fetch, wait },
  );
  await effects.assertNativeContained(plan);
  for (const file of plan.facts.installation.controlFiles)
    await effects.snapshotControl(file, plan);
  for (const unit of plan.facts.preservation) {
    await effects.preserveUnit(unit, plan);
    await effects.createFreshDirectory({ path: unit.path, mode: 0o700, empty: true }, plan);
  }
  await effects.writeFreshSettings(
    {
      operator: { AUTH_PASSPHRASE: 'a'.repeat(64), AUTH_SECRET: 'b'.repeat(128) },
      accountProfiles: [],
      mode: 0o600,
    },
    plan,
  );
  await effects.installOrdinaryController(plan);
  const operation = f.archiveRoot.split('/').at(-1);
  const intent = { version: 1, operation, planSha256: plan.sha256, target: f.sourceCommit };
  const write = (path, value) =>
    fs.writeFileSync(f.map(path), JSON.stringify(value) + '\n', { mode: 0o600 });
  write(join(f.canonicalRoot, 'service/deployment.lock'), {
    operation,
    mode: 'offline-native-containment',
    planSha256: f.containmentPlan.sha256,
    id: operation,
    target: f.sourceCommit,
  });
  write(join(f.archiveRoot, 'ordinary-restore-intent.json'), intent);
  write(join(f.archiveRoot, 'ordinary-start-attempt.json'), intent);
  await effects.kickstartCanonical({ label: 'com.mitzo.staging', force: false }, plan);
  expect(effects.getReplacementProof().originalJob).toBeUndefined();
  const proof = await effects.verifyCanonical(plan);
  expect(proof).toMatchObject({ pid: 456, httpStatus: 200, portPids: [456] });
  expect(effects.getReplacementProof().originalJob).toMatchObject({ pid: 456, cwd: f.release });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(wait).toHaveBeenCalledTimes(2);
  await expect(
    effects.kickstartCanonical({ label: 'com.mitzo.staging', force: false }, plan),
  ).rejects.toThrow();
  expect(run.mock.calls.filter(([, args]) => args[0] === 'kickstart')).toHaveLength(1);
});
it('holds the original guard through preservation, one start and byte-bound durable completion', async () => {
  const f = fixture(),
    facts = await collectOfflineOrdinaryRestorationFacts(
      {
        containmentPlan: f.containmentPlan,
        sourceCommit: f.sourceCommit,
        assertAcceptedPreparedSource: f.assertAcceptedPreparedSource,
      },
      f.deps,
    ),
    plan = createOfflineOrdinaryRestorationPlan(facts);
  const operation = f.archiveRoot.split('/').at(-1),
    guardPath = join(f.canonicalRoot, 'service/deployment.lock');
  const write = (path, value) =>
    fs.writeFileSync(f.map(path), JSON.stringify(value) + '\n', { mode: 0o600 });
  const nativeIntent = { version: 1, operation, planSha256: f.containmentPlan.sha256 };
  write(f.archiveRoot + '.intent.json', nativeIntent);
  write(join(f.archiveRoot, 'containment-receipt.json'), {
    classification: 'contained_offline_native_cleanup_unconfirmed',
  });
  const receiptSha256 = hash(
    fs.readFileSync(f.map(join(f.archiveRoot, 'containment-receipt.json'))),
  );
  write(guardPath, {
    version: 1,
    mode: 'offline-native-containment',
    operation,
    planSha256: f.containmentPlan.sha256,
    intentPath: f.archiveRoot + '.intent.json',
    intentSha256: offlineContainmentDigest(nativeIntent),
  });
  let active = false,
    effects,
    complete = false;
  let clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  f.deps.observePhysicalScope.mockImplementation(() => {
    if (!active && fs.existsSync(f.map(plan.registration.path))) clock += 2000;
    return true;
  });
  const cap = {
    assertOwnedGuard(ordinaryPlan) {
      expect(fs.existsSync(f.map(guardPath))).toBe(true);
      expect(effects.assertGuardContinuation(f.containmentPlan, ordinaryPlan, 'owned')).toBe(true);
      if (fs.existsSync(f.map(plan.registration.path))) {
        expect(effects.getReplacementProof()).toBeDefined();
        expect(
          effects.assertGuardContinuation(
            f.containmentPlan,
            ordinaryPlan,
            'replacement',
            JSON.parse(fs.readFileSync(f.map(guardPath))),
          ),
        ).toBe(true);
      }
    },
    bindOrdinaryGuard(binding, ordinaryPlan) {
      expect(
        effects.assertGuardContinuation(f.containmentPlan, ordinaryPlan, 'bind', binding),
      ).toBe(true);
      const held = JSON.parse(fs.readFileSync(f.map(guardPath)));
      write(guardPath, {
        ...held,
        id: operation,
        target: binding.target,
        continuationPlanSha256: binding.planSha256,
        continuationIntentPath: binding.intentPath,
        continuationIntentSha256: binding.intentSha256,
        containmentReceiptSha256: receiptSha256,
      });
    },
    async completeOrdinaryGuard(receipt, ordinaryPlan) {
      expect(
        await effects.assertGuardContinuation(f.containmentPlan, ordinaryPlan, 'complete', receipt),
      ).toBe(true);
      expect(
        JSON.parse(fs.readFileSync(f.map(join(f.archiveRoot, 'ordinary-completed.json')))),
      ).toEqual(receipt);
      const assertFinal = (witness = receipt) =>
        effects.assertGuardContinuation(
          f.containmentPlan,
          ordinaryPlan,
          'final-preservation',
          witness,
        );
      expect(assertFinal()).toBe(true); // A synchronous result, never a Promise.
      expect(() => assertFinal({ ...receipt, pid: 999 })).toThrow();
      const retainedPath = f.map(join(plan.facts.preservation[0].archivePath, 'retained.txt'));
      const priorBytes = fs.readFileSync(retainedPath),
        fd = fs.openSync(retainedPath, 'r+');
      try {
        fs.writeSync(fd, Buffer.from('late mutation'), 0, 13, 0);
      } finally {
        fs.closeSync(fd);
      }
      expect(() => assertFinal()).toThrow();
      expect(fs.existsSync(f.map(guardPath))).toBe(true);
      fs.writeFileSync(retainedPath, priorBytes);
      expect(assertFinal()).toBe(true);
      fs.unlinkSync(f.map(guardPath));
      complete = true;
    },
  };
  const run = vi.fn((program, args) => {
    if (program === '/bin/launchctl' && args[0] === 'bootstrap')
      expect(fs.existsSync(f.map(join(f.canonicalRoot, 'service/launch-permit.json')))).toBe(false);
    if (program === '/bin/launchctl' && args[0] === 'kickstart') {
      const permit = JSON.parse(
        fs.readFileSync(f.map(join(f.canonicalRoot, 'service/launch-permit.json'))),
      );
      expect(permit.expiresAt).toBeGreaterThan(Date.now());
      expect(permit.expiresAt - Date.now()).toBe(15000);
      active = true;
      return { status: 0, stdout: '' };
    }
    if (program === '/bin/launchctl' && args[0] === 'print')
      return active
        ? { status: 0, stdout: 'path = ' + plan.registration.path + '\npid = 456\n' }
        : {
            status: 113,
            stdout: '',
            stderr: `Could not find service "com.mitzo.staging" in domain for user gui: ${process.getuid()}`,
          };
    if (program === '/bin/ps')
      return {
        status: 0,
        stdout:
          args.at(-1) === 'lstart='
            ? 'Sun Oct 11 12:00:00 2026\n'
            : '/virtual/node ' + join(f.release, 'dist/index.js') + '\n',
      };
    if (program === '/usr/sbin/lsof' && args.includes('cwd'))
      return { status: 0, stdout: 'p456\nn' + f.release + '\n' };
    if (program === '/usr/sbin/lsof')
      return active && args.includes('-iTCP:3190')
        ? { status: 0, stdout: '456\n' }
        : { status: 1, stdout: '' };
    return { status: 0, stdout: '' };
  });
  effects = createOfflineOrdinaryEffects(
    {
      plan,
      verifySource: f.assertAcceptedPreparedSource,
      initialContainmentReceiptSha256: receiptSha256,
      verifyContainment: async () => {
        cap.assertOwnedGuard(plan);
        return { receiptSha256 };
      },
      guardCapability: () => cap,
      assertAuthorityCurrent: () => true,
    },
    { ...f.deps, run, fetch: vi.fn(async () => ({ status: 200 })) },
  );
  // Receipt JSON cannot substitute for the original transaction's byte binding.
  const nativeReceiptPath = join(f.archiveRoot, 'containment-receipt.json');
  const originalReceiptBytes = fs.readFileSync(f.map(nativeReceiptPath));
  write(nativeReceiptPath, { classification: 'retired' });
  expect(() => effects.assertGuardContinuation(f.containmentPlan, plan, 'owned')).toThrow();
  fs.writeFileSync(f.map(nativeReceiptPath), originalReceiptBytes);
  const close = vi.fn(),
    current = vi.fn();
  const restore = createOfflineOrdinaryRestoration({
    plan,
    consumeAuthority: async () => ({ assertCurrent: current, close }),
    effects,
  });
  const receipt = await restore.apply({});
  expect(receipt).toMatchObject({
    mode: 'ordinary',
    containmentSha256: receiptSha256,
    pid: 456,
    nativeCleanupConfirmed: false,
  });
  expect(complete).toBe(true);
  expect(close).toHaveBeenCalledOnce();
  expect(current).toHaveBeenCalled();
  expect(run.mock.calls.filter(([, args]) => args[0] === 'bootstrap')).toHaveLength(1);
  expect(run.mock.calls.filter(([, args]) => args[0] === 'kickstart')).toHaveLength(1);
  expect(
    fs.readFileSync(
      f.map(join(f.archiveRoot, 'ordinary-prior-controls/service/start.mjs')),
      'utf8',
    ),
  ).toBe('prior launcher');
  expect(fs.existsSync(f.map(guardPath))).toBe(false);
});

it('uses the real neutral filesystem inventory for ordinary data without requiring VM files', async () => {
  const f = fixture();
  inspectionMapping.map = f.map;
  const deps = { ...f.deps, inspectTree: undefined };
  const facts = await collectOfflineOrdinaryRestorationFacts(
    {
      containmentPlan: f.containmentPlan,
      sourceCommit: f.sourceCommit,
      assertAcceptedPreparedSource: f.assertAcceptedPreparedSource,
    },
    deps,
  );
  const plan = createOfflineOrdinaryRestorationPlan(facts);
  const effects = createOfflineOrdinaryEffects(
    {
      plan,
      verifySource: f.assertAcceptedPreparedSource,
      verifyContainment: f.verifyContainment,
      guardCapability: f.continuation,
      assertAuthorityCurrent: () => true,
    },
    deps,
  );
  const unit = plan.facts.preservation[0];
  await effects.assertOriginalUnit(unit, plan);
  await effects.preserveUnit(unit, plan);
  await effects.assertPreservedUnit(unit, plan);
  expect(fs.readFileSync(f.map(join(unit.archivePath, 'retained.txt')), 'utf8')).toBe(
    'opaque prior home',
  );
});

it('refuses a positively observed real writable descriptor before preserving a legacy directory', async () => {
  const f = fixture(),
    facts = await collectOfflineOrdinaryRestorationFacts(
      {
        containmentPlan: f.containmentPlan,
        sourceCommit: f.sourceCommit,
        assertAcceptedPreparedSource: f.assertAcceptedPreparedSource,
      },
      f.deps,
    ),
    plan = createOfflineOrdinaryRestorationPlan(facts),
    unit = plan.facts.preservation[0];
  const fd = fs.openSync(f.map(join(unit.path, 'retained.txt')), 'r+');
  const observePhysicalScope = vi.fn(() => {
    expect(fs.fstatSync(fd).isFile()).toBe(true);
    throw Error('Scoped writable descriptor present');
  });
  const effects = createOfflineOrdinaryEffects(
    {
      plan,
      verifySource: f.assertAcceptedPreparedSource,
      verifyContainment: f.verifyContainment,
      guardCapability: f.continuation,
      assertAuthorityCurrent: () => true,
    },
    { ...f.deps, observePhysicalScope },
  );
  try {
    await expect(effects.preserveUnit(unit, plan)).rejects.toThrow(/descriptor/);
    expect(fs.existsSync(f.map(unit.path))).toBe(true);
    expect(fs.existsSync(f.map(unit.archivePath))).toBe(false);
  } finally {
    fs.closeSync(fd);
  }
});
it('rechecks every preserved ordinary body before startup even when a previous preservation proof passed', async () => {
  const f = fixture(),
    facts = await collectOfflineOrdinaryRestorationFacts(
      {
        containmentPlan: f.containmentPlan,
        sourceCommit: f.sourceCommit,
        assertAcceptedPreparedSource: f.assertAcceptedPreparedSource,
      },
      f.deps,
    ),
    plan = createOfflineOrdinaryRestorationPlan(facts);
  const effects = createOfflineOrdinaryEffects(
    {
      plan,
      verifySource: f.assertAcceptedPreparedSource,
      verifyContainment: f.verifyContainment,
      guardCapability: f.continuation,
      assertAuthorityCurrent: () => true,
    },
    { ...f.deps, run: f.run },
  );
  await effects.assertNativeContained(plan);
  for (const file of plan.facts.installation.controlFiles)
    await effects.snapshotControl(file, plan);
  for (const unit of plan.facts.preservation) {
    await effects.preserveUnit(unit, plan);
    await effects.assertPreservedUnit(unit, plan);
    await effects.createFreshDirectory({ path: unit.path, mode: 0o700, empty: true }, plan);
  }
  await effects.writeFreshSettings(
    {
      operator: { AUTH_PASSPHRASE: 'a'.repeat(64), AUTH_SECRET: 'b'.repeat(128) },
      accountProfiles: [],
      mode: 0o600,
    },
    plan,
  );
  await effects.installOrdinaryController(plan);
  const archivedFile = f.map(join(plan.facts.preservation[0].archivePath, 'retained.txt')),
    fd = fs.openSync(archivedFile, 'r+');
  try {
    fs.writeSync(fd, Buffer.from('changed bytes'), 0, 13, 0);
  } finally {
    fs.closeSync(fd);
  }
  await expect(effects.assertInstalledOrdinary(plan)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});

it('bounds exact scope commands and rejects mounted source ancestors or unknown handle evidence', () => {
  const f = fixture(),
    path = join(f.canonicalRoot, 'home');
  const run = vi.fn((program) =>
    program === '/usr/sbin/lsof'
      ? { status: 1, stdout: '', stderr: '' }
      : { status: 0, stdout: '/dev/disk3 on / (apfs, local)\n', stderr: '' },
  );
  expect(
    observeOfflineOrdinaryPhysicalScope(
      { path, canonicalRoot: f.canonicalRoot, archived: false },
      { run },
    ),
  ).toBe(true);
  expect(run.mock.calls[0]).toEqual([
    '/usr/sbin/lsof',
    ['-nP', '-Fpn', '+D', path],
    expect.objectContaining({ timeout: 10000, shell: false }),
  ]);
  expect(run.mock.calls[0][1]).not.toContain('-X');
  run.mockImplementation((program) =>
    program === '/usr/sbin/lsof'
      ? { status: 1, stdout: '', stderr: '' }
      : { status: 0, stdout: f.canonicalRoot + ' on /external-alias (bind, local)\n', stderr: '' },
  );
  expect(() =>
    observeOfflineOrdinaryPhysicalScope(
      { path, canonicalRoot: f.canonicalRoot, archived: false },
      { run },
    ),
  ).toThrow(/alias/);
  expect(() =>
    observeOfflineOrdinaryPhysicalScope(
      { path, canonicalRoot: f.canonicalRoot, archived: true },
      { run },
    ),
  ).toThrow();
  for (const evidence of [
    { status: 0, stdout: 'p123\nf12\n', stderr: '' },
    { status: 1, stdout: '', stderr: 'unavailable' },
    { status: 1, stdout: '', stderr: '', signal: 'SIGTERM' },
  ]) {
    run.mockReturnValue(evidence);
    expect(() =>
      observeOfflineOrdinaryPhysicalScope(
        { path, canonicalRoot: f.canonicalRoot, archived: false },
        { run },
      ),
    ).toThrow();
  }
});
it('requires current positive physical scope observations during collection and after rename', async () => {
  const f = fixture();
  await expect(
    collectOfflineOrdinaryRestorationFacts(
      {
        containmentPlan: f.containmentPlan,
        sourceCommit: f.sourceCommit,
        assertAcceptedPreparedSource: f.assertAcceptedPreparedSource,
      },
      { ...f.deps, observePhysicalScope: () => undefined },
    ),
  ).rejects.toThrow();
  const facts = await collectOfflineOrdinaryRestorationFacts(
      {
        containmentPlan: f.containmentPlan,
        sourceCommit: f.sourceCommit,
        assertAcceptedPreparedSource: f.assertAcceptedPreparedSource,
      },
      f.deps,
    ),
    plan = createOfflineOrdinaryRestorationPlan(facts),
    unit = plan.facts.preservation[0];
  const observer = vi.fn(({ archived }) => !archived);
  const effects = createOfflineOrdinaryEffects(
    {
      plan,
      verifySource: f.assertAcceptedPreparedSource,
      verifyContainment: f.verifyContainment,
      guardCapability: f.continuation,
      assertAuthorityCurrent: () => true,
    },
    { ...f.deps, observePhysicalScope: observer },
  );
  await expect(effects.preserveUnit(unit, plan)).rejects.toThrow();
  expect(fs.existsSync(f.map(unit.path))).toBe(false);
  expect(fs.readFileSync(f.map(join(unit.archivePath, 'retained.txt')), 'utf8')).toBe(
    'opaque prior home',
  );
  expect(observer.mock.calls.at(-1)[0]).toEqual({
    path: unit.archivePath,
    canonicalRoot: f.canonicalRoot,
    archived: true,
  });
});
