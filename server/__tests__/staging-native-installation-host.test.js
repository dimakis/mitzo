import { expect, it, vi } from 'vitest';
const probes = vi.hoisted(() => ({
  inputs: vi.fn(),
  preflight: vi.fn(),
  run: vi.fn(),
  qualified: vi.fn(),
  receipt: undefined,
  archive: undefined,
  homedir: undefined,
}));
vi.mock('../../scripts/lib/staging-contained-native-controller.mjs', () => ({
  containedNativeInstallationInputs: probes.inputs,
  preflightContainedNativeReplica: probes.preflight,
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal()),
  userInfo: () => ({ homedir: probes.homedir }),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawnSync: (...args) => probes.run(...args),
}));
vi.mock(
  '../../scripts/lib/staging-offline-containment-observation.mjs',
  async (importOriginal) => ({
    ...(await importOriginal()),
    qualifyOfflineContainmentController: (...args) => probes.qualified(...args),
  }),
);
vi.mock('../../scripts/lib/staging-cold-control.mjs', () => ({
  verifyPreparedController: () => probes.receipt,
}));
vi.mock('../../scripts/lib/staging-contained-archive.mjs', () => ({
  createCompletedOfflineContainmentInspector: ({
    verifyExecutingController,
    verifyReplacementBoundary,
  }) => ({
    async verify() {
      await verifyExecutingController();
      await verifyReplacementBoundary();
      return probes.archive;
    },
  }),
}));
vi.mock('../../scripts/lib/staging-source-acceptance-witness.mjs', () => ({
  SOURCE_HISTORY_SCRATCH_BYTES: 64 * 1024 ** 2,
  createStagingSourceAcceptanceWitness: ({ verifyFresh }) => ({
    admit: verifyFresh,
    assertCurrent: verifyFresh,
    close() {},
  }),
}));
import process from 'node:process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { offlineContainmentDigest as digest } from '../../scripts/lib/staging-offline-containment-contract.mjs';
import { createContainedNativeLauncherPlist } from '../../scripts/lib/staging-contained-native-launcher-observation.mjs';
import { createContainedNativeInstallationHost } from '../../scripts/lib/staging-native-installation-host.mjs';
it('requires original private bootstrap inspection before any installer host observation or mutation', async () => {
  probes.inputs.mockImplementation(() => {
    throw Error('original inspection required');
  });
  await expect(
    createContainedNativeInstallationHost({ inspection: JSON.parse('{}') }),
  ).rejects.toThrow('original inspection');
  expect(probes.preflight).not.toHaveBeenCalled();
});
it('refuses missing native implementation before ordinary host control', async () => {
  probes.inputs.mockReturnValue({ root: '/unqualified/root', sourceRoot: '/unqualified/source' });
  probes.preflight.mockRejectedValue(Error('actual model protocol missing'));
  await expect(createContainedNativeInstallationHost({ inspection: {} })).rejects.toThrow(
    'actual model protocol missing',
  );
});

it('executes one normal ordinary drain, preserves exact settled bytes and independently starts only one fresh actor', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'native-install-test-'))),
    root = join(home, '.local/share/mitzo-staging'),
    sourceCommit = 'b'.repeat(40),
    oldCommit = 'a'.repeat(40),
    sourceRoot = join(root, 'releases', sourceCommit.slice(0, 12)),
    oldSource = join(root, 'releases', oldCommit.slice(0, 12)),
    allocation = '22222222-2222-4222-8222-222222222222',
    evidence = join(root, 'service/native-dispositions', allocation),
    nativeRoot = join(root, 'symposium/allocations', allocation);
  const directory = (p) => mkdirSync(p, { recursive: true, mode: 0o700 }),
    file = (p, value, mode = 0o600) => {
      directory(dirname(p));
      writeFileSync(p, value, { mode });
    };
  const oldPid = 190001,
    newPid = 190002;
  let phase = 'ordinary',
    stops = 0,
    starts = 0,
    boots = 0;
  const ok = (stdout) => ({ status: 0, stdout, stderr: '' }),
    none = () => ({ status: 1, stdout: '', stderr: '' });
  const cwd = process.cwd(),
    platform = Object.getOwnPropertyDescriptor(process, 'platform'),
    send = Object.getOwnPropertyDescriptor(process, 'send');
  try {
    probes.homedir = home;
    directory(sourceRoot);
    directory(oldSource);
    for (const name of [
      'home',
      'workspace',
      'state',
      'settings',
      'bin',
      'service/control-lib',
      'registry',
    ])
      directory(join(root, name));
    file(join(root, 'state/event'), 'retained ordinary data');
    file(join(root, 'settings/operator'), 'synthetic fixture credential');
    file(join(root, 'bin/mitzo-staging'), 'old exact wrapper', 0o700);
    file(join(root, 'service/start.mjs'), 'old exact launcher');
    file(join(root, 'service/control-lib/control.mjs'), 'old exact support');
    const oldPlist = {
      Label: 'com.mitzo.staging',
      ProgramArguments: [process.execPath, join(root, 'service/start.mjs')],
      WorkingDirectory: oldSource,
      RunAtLoad: false,
      KeepAlive: false,
      StandardOutPath: join(root, 'state/server.stdout.log'),
      StandardErrorPath: join(root, 'state/server.stderr.log'),
    };
    file(join(root, 'service/com.mitzo.staging.plist'), JSON.stringify(oldPlist));
    file(
      join(root, 'service/topology.json'),
      JSON.stringify({ mode: 'ordinary', sourceCommit: oldCommit }),
    );
    file(
      join(root, 'service/release-receipt.json'),
      JSON.stringify({
        sourceCommit: oldCommit,
        label: 'com.mitzo.staging',
        port: 3190,
        bind: '127.0.0.1',
        workspace: join(root, 'workspace'),
        release: oldSource,
      }),
    );
    const original = { launchId: 'synthetic-original', state: 'retirement_uncertain' },
      dbPath = join(root, 'registry/staging.db');
    file(dbPath, '');
    const db = new Database(dbPath);
    db.exec(
      'CREATE TABLE policy(id INTEGER,capacity INTEGER);INSERT INTO policy VALUES(1,1);CREATE TABLE launches(launchId TEXT,state TEXT)',
    );
    db.prepare('INSERT INTO launches VALUES(?,?)').run(original.launchId, original.state);
    db.close();
    file(join(evidence, 'bootstrap.json'), 'synthetic private bootstrap');
    directory(join(nativeRoot, 'service'));
    directory(join(nativeRoot, 'home'));
    directory(join(nativeRoot, 'workspace'));
    const sha = 'c'.repeat(64),
      bootstrapPath = join(evidence, 'bootstrap.json');
    const { createHash } = await import('node:crypto'),
      bootstrapSha256 = createHash('sha256').update(readFileSync(bootstrapPath)).digest('hex');
    probes.receipt = { sourceCommit };
    probes.archive = { syntheticCompleteArchive: true };
    const bundle = {
      allocation,
      sourceCommit,
      recoveryPlanPath: '/synthetic/private/combined-proposal',
      recoveryPlanSha256: sha,
      disposition: {
        sha256: sha,
        facts: {
          original,
          controllerInventorySha256: digest(probes.receipt),
          physicalEvidenceSha256: digest(probes.archive),
        },
      },
      provisioning: {
        sha256: sha,
        plan: {
          budget: {
            additionalGrowthGiB: 1,
            inflightGiB: 0,
            releaseGrowthGiB: 0,
            scratchGrowthGiB: 0,
          },
        },
      },
    };
    probes.inputs.mockReturnValue({
      root,
      sourceRoot,
      bundle,
      plan: {},
      allocation: { nativeRoot },
      bootstrapPath,
      bootstrapSha256,
    });
    probes.preflight.mockResolvedValue({});
    probes.qualified.mockResolvedValue({});
    const native = createContainedNativeLauncherPlist({
      root,
      allocation,
      sourceCommit,
      sourceRoot,
      node: process.execPath,
      bootstrapSha256,
    });
    probes.run.mockImplementation((program, args) => {
      if (program === '/bin/launchctl') {
        if (args[0] === 'print') {
          if (args[1].endsWith('.vm') || phase === 'unregistered')
            return { status: 113, stdout: '', stderr: 'Could not find service' };
          return ok(
            `path = ${join(root, 'service/com.mitzo.staging.plist')}\nstate = ${phase === 'ordinary' || phase === 'running' ? 'running' : 'not running'}\nruns = ${phase === 'installed' ? 0 : 1}\n${phase === 'ordinary' || phase === 'running' ? 'pid = ' + (phase === 'ordinary' ? oldPid : newPid) : ''}`,
          );
        }
        if (args[0] === 'kill') {
          expect(args[1]).toBe('SIGTERM');
          expect(phase).toBe('ordinary');
          stops++;
          phase = 'stopped';
          return ok('');
        }
        if (args[0] === 'bootout') {
          expect(phase).toBe('stopped');
          phase = 'unregistered';
          return ok('');
        }
        if (args[0] === 'bootstrap') {
          expect(phase).toBe('unregistered');
          phase = 'installed';
          boots++;
          return ok('');
        }
        if (args[0] === 'kickstart') {
          expect(phase).toBe('installed');
          expect(
            lstatSync(join(root, 'service/deployment.lock'), { throwIfNoEntry: false }),
          ).toBeUndefined();
          phase = 'running';
          starts++;
          return ok('');
        }
      }
      if (program === '/bin/ps') {
        if (args[0] === '-axo') return ok('/usr/bin/node');
        const pid = Number(args[1]);
        if (pid === oldPid && phase !== 'ordinary') return none();
        if (args.at(-1) === 'pid=') return ok(String(pid));
        return ok(
          args.at(-1) === 'lstart=' ? 'synthetic-birth-' + pid : pid === process.pid ? '5000' : '1',
        );
      }
      if (program === '/usr/sbin/lsof') {
        if (args[0] === '-t')
          return args[1] === '-iTCP:3190' && phase === 'ordinary' ? ok(String(oldPid)) : none();
        if (args.includes('cwd'))
          return ok('p' + args[2] + '\nn' + (Number(args[2]) === oldPid ? oldSource : sourceRoot));
        return none();
      }
      if (program === '/usr/bin/plutil')
        return ok(
          JSON.stringify(phase === 'installed' || phase === 'running' ? native.fields : oldPlist),
        );
      if (program === '/sbin/mount') return ok('/dev/disk on / (apfs, local)');
      if (program === '/usr/sbin/sysctl')
        return ok(args[0] === '-n' ? '1' : 'vm.swapusage: total = 0.00M used = 0.00M free = 0.00M');
      if (program === '/usr/bin/memory_pressure')
        return ok('System-wide memory free percentage: 60%');
      if (program === '/bin/df')
        return ok(
          'Filesystem 1024-blocks Used Available Capacity Mounted on\nfake 100000000 10000000 80000000 10% /',
        );
      if (program === '/usr/bin/du') return ok('29360128\t' + root);
      throw Error('Unexpected synthetic command ' + program + ' ' + args.join(' '));
    });
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'send', { value: undefined, configurable: true });
    process.chdir(sourceRoot);
    const actor = await createContainedNativeInstallationHost({
      inspection: { syntheticOriginal: true },
    });
    const result = await actor.apply(actor.proposal.sha256);
    expect([stops, boots, starts]).toEqual([1, 1, 1]);
    expect(result.nativeReady).toBe(false);
    expect(result.nativeAuthority).toBe(false);
    expect(readFileSync(join(evidence, 'ordinary-installation/state/event'), 'utf8')).toBe(
      'retained ordinary data',
    );
    expect(readFileSync(join(evidence, 'ordinary-installation/settings/operator'), 'utf8')).toBe(
      'synthetic fixture credential',
    );
    expect(JSON.parse(readFileSync(join(root, 'service/topology.json'), 'utf8'))).toEqual({
      mode: 'owned-custodian',
      sourceCommit,
      allocation,
    });
    const observed = JSON.parse(
      readFileSync(join(evidence, 'installation-launcher-observed.json'), 'utf8'),
    );
    expect(observed.launcher.pid).toBe(newPid);
    expect(observed.nativeReady).toBe(false);
    await expect(actor.apply(actor.proposal.sha256)).rejects.toThrow();
    const reopened = new Database(dbPath, { readonly: true });
    expect(reopened.prepare('SELECT * FROM launches').all()).toEqual([original]);
    reopened.close();
  } finally {
    process.chdir(cwd);
    Object.defineProperty(process, 'platform', platform);
    if (send) Object.defineProperty(process, 'send', send);
    else delete process.send;
    rmSync(home, { recursive: true, force: true });
  }
});
