import process from 'node:process';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  classifyColdRefusal,
  quarantineColdReservation,
  prepareColdRefusal,
} from '../../scripts/lib/staging-cold-refusal.mjs';
const row = {
  launchId: '12345678-1234-1234-1234-123456789abc',
  planDirectory: '/stage/symposium/service',
  sourceCommit: 'a'.repeat(40),
  buildSha256: 'b'.repeat(64),
  configSha256: 'c'.repeat(64),
  state: 'retirement_uncertain',
  instanceId: null,
  controllerGeneration: 0,
  retirementStateParent: null,
  completedAt: null,
};
function snapshot() {
  return {
    contract: 'sealed-macos-restricted-path-lsof-v1',
    operation: '22345678-1234-1234-1234-123456789abc',
    lock: {
      id: '22345678-1234-1234-1234-123456789abc',
      mode: 'ordinary-to-owned',
      target: row.sourceCommit,
    },
    transition: { id: '22345678-1234-1234-1234-123456789abc', target: row.sourceCommit },
    row: { ...row },
    plan: {
      planDirectory: row.planDirectory,
      sourceCommit: row.sourceCommit,
      buildSha256: row.buildSha256,
      configSha256: row.configSha256,
    },
    sourceContractVerified: true,
    sealedSystem: true,
    lookupPathsAbsent: true,
    restrictedProbeError: 'ENOENT',
    job: { pid: null, state: 'not running', runs: 1, lastExitCode: 1 },
    originalOwnerAbsent: true,
    gatewayDirectories: [],
    attestationAbsent: true,
    sessionArtifactLedgerAbsent: true,
    eventCounts: [0, 0, 0, 0],
    artifactSchemaEmpty: true,
    containers: [],
    volumes: [],
  };
}
function registry() {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE launches(' +
      Object.keys(row)
        .map((k) => k + ' ' + (k === 'controllerGeneration' ? 'INTEGER' : 'TEXT'))
        .join(',') +
      ')',
  );
  db.prepare(
    'INSERT INTO launches VALUES(' +
      Object.keys(row)
        .map(() => '?')
        .join(',') +
      ')',
  ).run(...Object.values(row));
  return db;
}
describe('qualified pre-native refusal', () => {
  it('classifies the precise mandatory-gate contradiction without native retirement or adoption', () => {
    expect(classifyColdRefusal(snapshot())).toMatchObject({
      classification: 'pre_native_refused',
      nativeRetirement: false,
      adoption: false,
    });
  });
  it.each([
    'sourceContractVerified',
    'sealedSystem',
    'lookupPathsAbsent',
    'originalOwnerAbsent',
    'attestationAbsent',
    'sessionArtifactLedgerAbsent',
    'artifactSchemaEmpty',
  ])('refuses missing %s proof despite empty native inventory', (key) => {
    const s = snapshot();
    s[key] = false;
    expect(() => classifyColdRefusal(s)).toThrow();
  });
  it.each(['controllerGeneration', 'instanceId', 'state'])(
    'refuses a record that could have acquired custody: %s',
    (key) => {
      const s = snapshot();
      s.row[key] = key === 'controllerGeneration' ? 1 : key === 'instanceId' ? 'owned' : 'active';
      expect(() => classifyColdRefusal(s)).toThrow();
    },
  );
  it.each(['gatewayDirectories', 'containers', 'volumes', 'eventCounts'])(
    'refuses retained or nonzero %s',
    (key) => {
      const s = snapshot();
      s[key] = [1];
      expect(() => classifyColdRefusal(s)).toThrow();
    },
  );
  it('refuses another operation, job run, or startup error', () => {
    for (const change of [
      (s) => (s.lock.id = 'other'),
      (s) => (s.job.runs = 2),
      (s) => (s.restrictedProbeError = 'EACCES'),
    ]) {
      const s = snapshot();
      change(s);
      expect(() => classifyColdRefusal(s)).toThrow();
    }
  });
  it('preserves the entire original reservation in an audited separate disposition, without marking native retirement', () => {
    const db = registry();
    quarantineColdReservation(db, snapshot(), '/private/archive', 'd'.repeat(64));
    expect(db.prepare('SELECT COUNT(*) AS n FROM launches').get().n).toBe(0);
    const q = db.prepare('SELECT * FROM qualified_cold_refusals').get();
    expect(JSON.parse(q.recordJson)).toEqual(row);
    expect(q.classification).toBe('pre_native_refused');
    db.close();
  });
  it('a registry transaction failure rolls back disposition and preserves the exact held row', () => {
    const db = registry();
    db.exec(
      "CREATE TRIGGER refuse_delete BEFORE DELETE ON launches BEGIN SELECT RAISE(ABORT,'retain'); END",
    );
    expect(() =>
      quarantineColdReservation(db, snapshot(), '/private/archive', 'd'.repeat(64)),
    ).toThrow();
    expect(db.prepare('SELECT * FROM launches').get()).toEqual(row);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='qualified_cold_refusals'").get(),
    ).toBeUndefined();
    db.close();
  });
  it('partial preservation never classifies or unlocks the failed original operation', async () => {
    const calls = [];
    await expect(
      prepareColdRefusal({
        validate: async () => calls.push('validate'),
        archive: async () => {
          calls.push('archive');
          throw Error('partial');
        },
        classify: async () => calls.push('classify'),
        vacate: async () => calls.push('vacate'),
        record: async () => calls.push('record'),
        audit: async () => calls.push('audit'),
      }),
    ).rejects.toThrow('partial');
    expect(calls).toEqual(['validate', 'archive', 'audit']);
  });
});

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareColdMetadata, displaced } from '../../scripts/lib/staging-cold-prepare.mjs';
import { inventory, hash } from '../../scripts/lib/staging-cold-audit.mjs';
function filesystem() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cold-refusal-')));
  const owned = join(root, 'symposium/service'),
    workspace = join(root, 'symposium/workspace'),
    gateway = join(root, 'symposium/state/gateway');
  for (const p of [
    'service',
    'registry',
    'symposium/service',
    'symposium/workspace',
    'symposium/state/gateway',
  ])
    mkdirSync(join(root, p), { recursive: true, mode: 0o700 });
  const s = snapshot();
  s.row.planDirectory = owned;
  s.plan.planDirectory = owned;
  s.plan.repositoryPath = workspace;
  for (const n of [...displaced, 'transition-' + s.operation + '-uncertain.json'])
    writeFileSync(join(owned, n), 'old ' + n, { mode: 0o600 });
  for (const n of ['deployment.lock', 'topology.json', 'com.mitzo.staging.plist'])
    writeFileSync(join(root, 'service', n), 'original ' + n, { mode: 0o600 });
  writeFileSync(join(workspace, 'retained'), 'task data', { mode: 0o600 });
  writeFileSync(join(gateway, 'empty-ledger'), 'original', { mode: 0o600 });
  const db = new Database(join(root, 'registry/staging.db'));
  db.exec(
    'CREATE TABLE launches(' +
      Object.keys(s.row)
        .map((k) => k + ' ' + (k === 'controllerGeneration' ? 'INTEGER' : 'TEXT'))
        .join(',') +
      ')',
  );
  db.prepare(
    'INSERT INTO launches VALUES(' +
      Object.keys(s.row)
        .map(() => '?')
        .join(',') +
      ')',
  ).run(...Object.values(s.row));
  db.close();
  const audit = () => {
    const value = {
      ...s,
      serviceFiles: inventory(owned),
      workspaceFiles: inventory(workspace),
      gatewayFiles: inventory(gateway),
      registryFiles: inventory(join(root, 'registry')),
    };
    return {
      snapshot: value,
      auditSha256: hash(JSON.stringify(value)),
      config: { gateway: { stateParent: gateway } },
    };
  };
  return { root, owned, workspace, gateway, s, audit, sha: audit().auditSha256 };
}
it('actual metadata recovery archives original files and reservation while retaining the exact original lock', async () => {
  const f = filesystem();
  try {
    const lock = readFileSync(join(f.root, 'service/deployment.lock'));
    const result = await prepareColdMetadata(f.root, f.sha, f.audit);
    expect(result.lockRetained).toBe(true);
    expect(readFileSync(join(f.root, 'service/deployment.lock'))).toEqual(lock);
    expect(readFileSync(join(result.archive, 'original-workspace/retained'), 'utf8')).toBe(
      'task data',
    );
    expect(readdirSync(f.workspace)).toEqual([]);
    expect(readdirSync(f.gateway)).toEqual([]);
    expect(existsSync(join(f.owned, 'launch.intent'))).toBe(false);
    const db = new Database(join(f.root, 'registry/staging.db'), { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM launches').get().n).toBe(0);
    expect(
      JSON.parse(db.prepare('SELECT recordJson FROM qualified_cold_refusals').get().recordJson),
    ).toEqual(f.s.row);
    db.close();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
it('an archive collision does not modify unrelated preserved evidence or release capacity', async () => {
  const f = filesystem();
  try {
    const archive = join(f.root, 'service/cold-refusals', f.s.operation);
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    writeFileSync(join(archive, 'keep'), 'unrelated', { mode: 0o600 });
    await expect(prepareColdMetadata(f.root, f.sha, f.audit)).rejects.toThrow();
    expect(readdirSync(archive)).toEqual(['keep']);
    expect(existsSync(join(f.owned, 'launch.intent'))).toBe(true);
    const db = new Database(join(f.root, 'registry/staging.db'), { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM launches').get().n).toBe(1);
    db.close();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

import { vi } from 'vitest';
import { prepareFreshRecovery } from '../../scripts/lib/staging-cold-control.mjs';
import {
  validateRecoveryPlist,
  validateHistoricalColdPlist,
} from '../../scripts/lib/staging-cold-plist.mjs';
const osCalls = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original()),
  spawnSync: osCalls.run,
}));
function freshFixture(f) {
  const current = 'd'.repeat(40),
    source = join(f.root, 'releases', current.slice(0, 12));
  mkdirSync(source, { recursive: true, mode: 0o700 });
  const configPath = join(f.root, 'host.json');
  writeFileSync(configPath, JSON.stringify({ gateway: { port: 18990 } }), { mode: 0o600 });
  f.s.plan.configPath = configPath;
  f.s.configSha256 = hash(readFileSync(configPath));
  // The archived audit binds this config; update its digest and database disposition consistently.
  const archive = join(f.root, 'service/cold-refusals', f.s.operation),
    saved = JSON.parse(readFileSync(join(archive, 'audit.json')));
  saved.plan.configPath = configPath;
  saved.configSha256 = f.s.configSha256;
  const digest = hash(JSON.stringify(saved));
  writeFileSync(join(archive, 'audit.json'), JSON.stringify(saved), { mode: 0o600 });
  const record = JSON.parse(readFileSync(join(f.root, 'service/cold-recovery.json')));
  record.auditSha256 = digest;
  writeFileSync(join(f.root, 'service/cold-recovery.json'), JSON.stringify(record), {
    mode: 0o600,
  });
  writeFileSync(join(f.root, 'service/deployment.lock'), JSON.stringify(saved.lock), {
    mode: 0o600,
  });
  const db = new Database(join(f.root, 'registry/staging.db'));
  db.exec('CREATE TABLE policy(id INTEGER,capacity INTEGER);INSERT INTO policy VALUES(1,1)');
  db.prepare('UPDATE qualified_cold_refusals SET auditSha256=?').run(digest);
  db.close();
  const plan = {
    releaseRoot: source,
    sourceCommit: current,
    acceptedMainBaseline: current,
    planDirectory: f.owned,
    configPath,
    configSha256: f.s.configSha256,
  };
  const plist = {
    Label: 'com.mitzo.staging',
    ProgramArguments: [
      process.execPath,
      join(source, 'scripts/start-staging-custodian.mjs'),
      join(f.owned, 'owned-release.json'),
      join(f.root, 'symposium/settings/staging-registration.json'),
      join(f.owned, 'staging-operator.json'),
      '--canonical',
    ],
    EnvironmentVariables: { NODE_OPTIONS: '', NODE_PATH: '', DOTENV_CONFIG_PATH: '/dev/null' },
    WorkingDirectory: source,
    StandardOutPath: join(f.owned, 'owner.stdout.log'),
    StandardErrorPath: join(f.owned, 'owner.stderr.log'),
    KeepAlive: false,
    RunAtLoad: false,
    ExitTimeOut: 180,
  };
  mkdirSync(join(f.root, 'symposium/settings'), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.root, 'symposium/settings/staging-registration.json'), '{}', {
    mode: 0o600,
  });
  for (const [name, value] of [
    ['owned-release.json', plan],
    ['staging-custodian.plist', plist],
    ['staging-operator.json', {}],
    ['empty-accounts.json', []],
  ])
    writeFileSync(join(f.owned, name), JSON.stringify(value), { mode: 0o600 });
  saved.registrationSha256 = hash(readFileSync(join(f.root, 'service/com.mitzo.staging.plist')));
  const d2 = hash(JSON.stringify(saved));
  writeFileSync(join(archive, 'audit.json'), JSON.stringify(saved), { mode: 0o600 });
  record.auditSha256 = d2;
  writeFileSync(join(f.root, 'service/cold-recovery.json'), JSON.stringify(record), {
    mode: 0o600,
  });
  const ddb = new Database(join(f.root, 'registry/staging.db'));
  ddb.prepare('UPDATE qualified_cold_refusals SET auditSha256=?').run(d2);
  ddb.close();
  osCalls.run.mockImplementation((program, args) => {
    if (program === '/bin/launchctl' && args[0] === 'print')
      return {
        status: 0,
        stdout:
          'path = ' +
          join(f.root, 'service/com.mitzo.staging.plist') +
          '\nstate = not running\nruns = 1\nlast exit code = 1',
      };
    if (program === '/usr/sbin/lsof') return { status: 1, stdout: '' };
    if (program === '/usr/bin/plutil')
      return { status: 0, stdout: readFileSync(args.at(-1), 'utf8') };
    if (program === 'git') return { status: 0, stdout: current + ' refs/heads/main' };
    return { status: 0, stdout: '' };
  });
  return {
    current,
    source,
    plan,
    plist,
    tools: {
      release: {
        readOwnedReleasePlan: (p) => JSON.parse(readFileSync(p)),
        verifyOwnedRelease: () => {},
      },
      service: {
        assertCanonicalStagingService: () => {},
        readStagingOperatorEnvironment: () => {},
      },
      verify: async () => ({ verified: true }),
    },
  };
}
it('actual cold recovery planning makes no control call and activation starts the same label once', async () => {
  const f = filesystem();
  try {
    await prepareColdMetadata(f.root, f.sha, f.audit);
    const t = freshFixture(f);
    const result = await prepareFreshRecovery(f.root, t.source, t.current, false, t.tools);
    expect(result.planned).toBe(true);
    expect(
      osCalls.run.mock.calls.filter(([p, a]) => p === '/bin/launchctl' && a[0] !== 'print'),
    ).toEqual([]);
    await prepareFreshRecovery(f.root, t.source, t.current, true, t.tools);
    expect(
      osCalls.run.mock.calls
        .filter(([p, a]) => p === '/bin/launchctl' && a[0] !== 'print')
        .map(([, a]) => a[0]),
    ).toEqual(['bootout', 'bootstrap', 'kickstart']);
    expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true); // Only the separately tested owner verifier releases it.
  } finally {
    osCalls.run.mockReset();
    rmSync(f.root, { recursive: true, force: true });
  }
});
it('prepared plist drift refuses before bootout and preserves the lock', async () => {
  const f = filesystem();
  try {
    await prepareColdMetadata(f.root, f.sha, f.audit);
    const t = freshFixture(f);
    t.plist.EnvironmentVariables.NODE_OPTIONS = '--import unreviewed';
    writeFileSync(join(f.owned, 'staging-custodian.plist'), JSON.stringify(t.plist), {
      mode: 0o600,
    });
    await expect(prepareFreshRecovery(f.root, t.source, t.current, false, t.tools)).rejects.toThrow(
      'service changed',
    );
    expect(
      osCalls.run.mock.calls.filter(([p, a]) => p === '/bin/launchctl' && a[0] !== 'print'),
    ).toEqual([]);
    expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
  } finally {
    osCalls.run.mockReset();
    rmSync(f.root, { recursive: true, force: true });
  }
});
it('plist validation preserves exact environment, one service and two-stage command binding', () => {
  const f = filesystem();
  try {
    const p = { releaseRoot: '/release' };
    expect(() =>
      validateRecoveryPlist(f.root, p, { Label: 'different' }, process.execPath),
    ).toThrow();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

import { openStagingRegistry } from '../symposium-staging-registry.js';
it('the real capacity-one registry preserves qualified refusal history and reserves a distinct fresh owner', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cold-singleton-')));
  try {
    const registry = openStagingRegistry(root, 1),
      input = {
        ownerChat: 'test',
        purpose: 'test',
        retentionReason: 'test',
        reviewAfter: Date.now() + 86400000,
        planDirectory: '/stage/symposium/service',
        sourceCommit: 'a'.repeat(40),
        buildSha256: 'b'.repeat(64),
        configSha256: 'c'.repeat(64),
      };
    const original = registry.reserve(input);
    original.uncertain();
    const s = snapshot();
    s.row = registry.list()[0];
    registry.close();
    const db = new Database(join(root, 'staging.db'));
    quarantineColdReservation(db, s, '/private/archive', 'd'.repeat(64));
    db.close();
    const fresh = openStagingRegistry(root, 1);
    expect(fresh.qualifiedRefusals()).toHaveLength(1);
    expect(JSON.parse(fresh.qualifiedRefusals()[0].recordJson).launchId).toBe(original.launchId);
    const next = fresh.reserve(input);
    expect(next.launchId).not.toBe(original.launchId);
    expect(fresh.list()).toHaveLength(1);
    fresh.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('unknown truthy proof values cannot qualify a cold refusal', () => {
  const s = snapshot();
  s.sealedSystem = 'unknown';
  expect(() => classifyColdRefusal(s)).toThrow();
});
it('an input changed after the activation plan refuses without service control', async () => {
  const f = filesystem();
  try {
    await prepareColdMetadata(f.root, f.sha, f.audit);
    const t = freshFixture(f);
    await prepareFreshRecovery(f.root, t.source, t.current, false, t.tools);
    writeFileSync(join(f.owned, 'staging-operator.json'), '{"changed":true}', { mode: 0o600 });
    await expect(prepareFreshRecovery(f.root, t.source, t.current, true, t.tools)).rejects.toThrow(
      'plan changed',
    );
    expect(
      osCalls.run.mock.calls.filter(([p, a]) => p === '/bin/launchctl' && a[0] !== 'print'),
    ).toEqual([]);
    expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
  } finally {
    osCalls.run.mockReset();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it('an uncertain fresh start keeps the original lock and never issues a second start', async () => {
  const f = filesystem();
  let clock;
  try {
    await prepareColdMetadata(f.root, f.sha, f.audit);
    const t = freshFixture(f);
    await prepareFreshRecovery(f.root, t.source, t.current, false, t.tools);
    let now = Date.now();
    clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 130000));
    await expect(
      prepareFreshRecovery(f.root, t.source, t.current, true, {
        ...t.tools,
        verify: async () => {
          throw Error('unconfirmed');
        },
      }),
    ).rejects.toThrow('readiness uncertain');
    expect(
      osCalls.run.mock.calls.filter(([p, a]) => p === '/bin/launchctl' && a[0] === 'kickstart'),
    ).toHaveLength(1);
    expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
    expect(
      existsSync(join(f.root, 'service/cold-refusals', f.s.operation, 'activation-attempt.json')),
    ).toBe(true);
  } finally {
    clock?.mockRestore();
    osCalls.run.mockReset();
    rmSync(f.root, { recursive: true, force: true });
  }
});

import { recordOrVerifyFreshOwnerReceipt } from '../../scripts/lib/staging-cold-receipt.mjs';
it('a verified receipt can resume the same owner after interruption without rewriting evidence', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owner-receipt-')));
  try {
    const path = join(root, 'receipt.json'),
      value = {
        operation: 'original',
        target: 'd'.repeat(40),
        owner: {
          instanceId: 'fresh',
          epoch: 1,
          parent: { pid: 10, birth: 'parent' },
          app: { pid: 11, birth: 'app' },
        },
      };
    recordOrVerifyFreshOwnerReceipt(path, value);
    const before = readFileSync(path);
    recordOrVerifyFreshOwnerReceipt(path, value);
    expect(readFileSync(path)).toEqual(before);
    expect(() =>
      recordOrVerifyFreshOwnerReceipt(path, { ...value, owner: { ...value.owner, epoch: 2 } }),
    ).toThrow();
    expect(readFileSync(path)).toEqual(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('the actual copied registry bytes are verified before reservation classification', async () => {
  const f = filesystem();
  try {
    const audit = () => {
      const v = f.audit();
      v.snapshot.registryFiles = {
        ...inventory(join(f.root, 'registry')),
        'unaccounted-wal': { sha256: 'f'.repeat(64), mode: 0o600 },
      };
      v.auditSha256 = hash(JSON.stringify(v.snapshot));
      return v;
    };
    await expect(prepareColdMetadata(f.root, audit().auditSha256, audit)).rejects.toThrow(
      'Preserved original evidence changed',
    );
    const db = new Database(join(f.root, 'registry/staging.db'), { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM launches').get().n).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='qualified_cold_refusals'").get(),
    ).toBeUndefined();
    db.close();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

it('historical refusal proof rejects a preload environment before considering the mandatory gate', async () => {
  const f = filesystem();
  try {
    await prepareColdMetadata(f.root, f.sha, f.audit);
    const t = freshFixture(f);
    validateHistoricalColdPlist(f.root, t.plan, t.plist, process.execPath);
    t.plist.EnvironmentVariables.NODE_OPTIONS = '--import hidden';
    expect(() => validateHistoricalColdPlist(f.root, t.plan, t.plist, process.execPath)).toThrow();
  } finally {
    osCalls.run.mockReset();
    rmSync(f.root, { recursive: true, force: true });
  }
});
