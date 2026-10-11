import { afterEach, expect, it, vi } from 'vitest';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectOpaquePreservationTree } from '../../scripts/lib/staging-offline-containment-observation.mjs';
import {
  collectOfflineOrdinaryRestorationFacts,
  createOfflineOrdinaryEffects,
} from '../../scripts/lib/staging-offline-ordinary-effects.mjs';
import {
  createOfflineOrdinaryRestoration,
  createOfflineOrdinaryRestorationPlan,
  createOfflineRecoveryProposal,
  createOfflineRecoveryAuthority,
} from '../../scripts/lib/staging-offline-ordinary-restore.mjs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  createOfflineContainmentPlan,
  OFFLINE_CONTAINMENT_TARGET,
} from '../../scripts/lib/staging-offline-containment-contract.mjs';
import { createOfflineContainmentEffects } from '../../scripts/lib/staging-offline-containment-effects.mjs';
import { createOfflineContainmentTransaction } from '../../scripts/lib/staging-offline-containment-transaction.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable = (value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, stable(value[key])]),
      )
    : Array.isArray(value)
      ? value.map(stable)
      : value;
const hash = (value) => digest(stable(value));
const dispos = 'contained_offline_native_cleanup_unconfirmed';
const close = [];
const temporary = [];
const temporaryHandles = [];
afterEach(() => temporaryHandles.splice(0).forEach((close) => close()));
afterEach(() =>
  temporary.splice(0).forEach((path) => fs.rmSync(path, { recursive: true, force: true })),
);
afterEach(() => close.splice(0).forEach((db) => db.close()));
function fixture() {
  const uid = process.getuid(),
    root = OFFLINE_CONTAINMENT_TARGET.canonicalRoot;
  const archive = root + '-quarantine/33333333-3333-4333-8333-333333333333';
  const nodes = new Map(),
    handles = new Map(),
    order = [];
  let ino = 1,
    fd = 10;
  const add = (path, bytes, mode = 0o600) =>
    nodes.set(path, {
      ino: ino++,
      bytes: bytes === undefined ? undefined : Buffer.from(bytes),
      mode,
    });
  const parent = (p) => p.slice(0, p.lastIndexOf('/'));
  const missing = () => Object.assign(Error('absent'), { code: 'ENOENT' });
  for (const path of [
    root,
    root + '/service',
    root + '/registry',
    root + '/symposium',
    root + '/symposium/service',
    root + '/symposium/state',
    parent(archive),
    '/operator',
    '/operator/LaunchAgents',
  ])
    add(path, undefined, 0o700);
  add(root + '/symposium/service/launch.intent', 'original launch intent');
  add(root + '/symposium/state/private-native-data', 'opaque provider bytes');
  const controls = OFFLINE_CONTAINMENT_TARGET.controls.map((control) => ({
    ...control,
    archivePath: archive + '/controls/' + control.path.split('/').at(-1),
    uid,
    mode: 0o600,
  }));
  controls.forEach((c) => {
    let dir = parent(c.path);
    const pending = [];
    while (dir && !nodes.has(dir)) {
      pending.push(dir);
      dir = parent(dir);
    }
    pending.reverse().forEach((path) => add(path, undefined, 0o700));
    add(c.path, c.kind === 'app' ? 'app plist' : 'vm plist');
  });
  // Physical collector owns exact external control selection; these injected fixtures never touch host paths.
  const tree = (path) => ({
    sha256: hash(
      [...nodes]
        .filter(([p]) => p === path || p.startsWith(path + '/'))
        .map(([p, n]) => [p.slice(path.length), n.ino, n.mode, n.bytes?.toString()])
        .sort(),
    ),
    components: Object.fromEntries(
      ['machine', 'diskChain', 'home', 'workspace', 'gateway', 'settings', 'service'].map((k) => [
        k,
        'e'.repeat(64),
      ]),
    ),
  });
  const row = {
    ...OFFLINE_CONTAINMENT_TARGET.original,
    planDirectory: root + '/symposium/service',
    ownerChat: 'retained',
    purpose: 'original stage',
    retentionReason: 'preserve custody',
    reviewAfter: 1792000000000,
    state: 'retirement_uncertain',
    retirementStateParent: null,
    completedAt: null,
  };
  for (const k of ['sourceTree', 'inputsSha256', 'capturedAt']) delete row[k];
  const db = new Database(':memory:');
  close.push(db);
  db.exec(
    'CREATE TABLE policy(id INTEGER PRIMARY KEY,capacity INTEGER);INSERT INTO policy VALUES(1,1);CREATE TABLE launches(' +
      Object.keys(row)
        .map((k) => k + ' ' + (typeof row[k] === 'number' ? 'INTEGER' : 'TEXT'))
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
  const facts = {
    version: 1,
    operatorUid: uid,
    canonicalRoot: root,
    archiveRoot: archive,
    futureRoots: [root],
    original: { ...OFFLINE_CONTAINMENT_TARGET.original, ownerBirthAt: 1791596390000 },
    currentBoot: { ...OFFLINE_CONTAINMENT_TARGET.currentBoot },
    retained: {
      state: 'retirement_uncertain',
      rowSha256: hash(row),
      intentSha256: createHash('sha256').update('original launch intent').digest('hex'),
      retirementReceipt: 'absent',
    },
    scope: {
      nativeExecution: 'selected_vm_only',
      hostOperations: 'none',
      inventory: 'configured_unit_manifest',
    },
    units: [
      {
        kind: 'opaque_symposium',
        path: root + '/symposium',
        archivePath: archive + '/symposium',
        manifestSha256: tree(root + '/symposium').sha256,
        uid,
        mode: 0o700,
        components: tree(root + '/symposium').components,
      },
    ],
    controls,
    nativeHelpers: [...OFFLINE_CONTAINMENT_TARGET.nativeHelpers],
    proofs: Object.fromEntries(
      [
        'dispatchClosure',
        'vmStopped',
        'noOpenHandles',
        'noMountedAliases',
        'autostartDisabled',
        'archiveExcluded',
        'completeOpaqueState',
        'noStateAliases',
      ].map((k) => [k, { status: 'confirmed', evidenceSha256: 'f'.repeat(64) }]),
    ),
  };
  // Existing pure proposal gets the same control binding once contract support lands.
  const plan = createOfflineContainmentPlan(facts);
  const io = {
    constants: { O_CREAT: 64, O_EXCL: 128, O_WRONLY: 1, O_NOFOLLOW: 256 },
    lstatSync(p) {
      const n = nodes.get(p);
      if (!n) throw missing();
      return {
        uid,
        dev: 1,
        ino: n.ino,
        nlink: 1,
        mode: n.mode,
        size: n.bytes?.length ?? 0,
        mtimeMs: 1,
        isDirectory: () => n.bytes === undefined,
        isFile: () => n.bytes !== undefined,
        isSymbolicLink: () => false,
      };
    },
    realpathSync(p) {
      if (!nodes.has(p)) throw missing();
      return p;
    },
    mkdirSync(p) {
      if (nodes.has(p)) throw Error('exists');
      if (!nodes.has(parent(p))) throw missing();
      add(p, undefined, 0o700);
    },
    openSync(p, flags, mode) {
      if (typeof flags === 'number' && flags & 64) {
        if (nodes.has(p)) throw Error('exists');
        add(p, '', mode);
      }
      if (!nodes.has(p)) throw missing();
      handles.set(++fd, p);
      return fd;
    },
    fstatSync(f) {
      return this.lstatSync(handles.get(f));
    },
    writeFileSync(f, b) {
      nodes.get(typeof f === 'number' ? handles.get(f) : f).bytes = Buffer.from(b);
    },
    readFileSync(p) {
      const n = nodes.get(typeof p === 'number' ? handles.get(p) : p);
      if (!n) throw missing();
      return n.bytes;
    },
    closeSync() {},
    fsyncSync() {},
    chmodSync(p, mode) {
      nodes.get(p).mode = mode;
    },
    renameSync(a, b) {
      order.push('move:' + a);
      if (
        !nodes.has(a) ||
        (nodes.has(b) && (nodes.get(a).bytes === undefined || nodes.get(b).bytes === undefined))
      )
        throw Error('rename refused');
      nodes.delete(b);
      for (const [p, n] of [...nodes])
        if (p === a || p.startsWith(a + '/')) {
          nodes.delete(p);
          nodes.set(b + p.slice(a.length), n);
        }
    },
    unlinkSync(p) {
      order.push('unlink:' + p);
      nodes.delete(p);
    },
  };
  const known = new WeakSet();
  let leaseAlive = true;
  const authorize = () => {
    leaseAlive = true;
    const a = {};
    known.add(a);
    return a;
  };
  const consumeAuthority = (a, sha) => {
    if (!known.has(a) || sha !== plan.sha256) throw Error('fresh auth required');
    known.delete(a);
    return {
      assertCurrent(s) {
        if (!leaseAlive || s !== plan.sha256) throw Error('expired auth');
      },
      close() {
        leaseAlive = false;
      },
    };
  };
  const effects = {
    io,
    inspectTree: tree,
    openRegistry: () => db,
    closeRegistry: () => {},
    hashFile: (path) => {
      const content = io.readFileSync(path);
      const c = controls.find((c) => path === c.path || path === c.archivePath);
      return c && content.toString() === (c.kind === 'app' ? 'app plist' : 'vm plist')
        ? c.sha256
        : createHash('sha256').update(content).digest('hex');
    },
    backupRegistry: async (_db, path) => add(path, 'original SQLite snapshot'),
    verifyRegistryBackup: () => {},
    assertBeforeMove: vi.fn(async () => {
      order.push('physical-before');
    }),
    assertContained: vi.fn(async () => {
      order.push('physical-contained');
    }),
    invalidateControl: vi.fn(async (c) => {
      order.push('unregister:' + c.kind);
    }),
    assertControlAbsent: vi.fn(async () => {}),
  };
  const transaction = (options = {}) =>
    createOfflineContainmentTransaction({ plan, consumeAuthority, effects, ...options });
  return {
    root,
    archive,
    plan,
    row,
    db,
    nodes,
    order,
    io,
    effects,
    authorize,
    transaction,
    expire: () => {
      leaseAlive = false;
    },
  };
}
// Back one ordinary unit with real temporary files so an existing writable FD
// demonstrably survives the actual directory rename. All native state stays in
// the mapped fixture; process/physical observers remain explicit synthetic seams.
function realOrdinaryHome(io, f) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ordinary-fd-')));
  temporary.push(root);
  fs.mkdirSync(join(root, 'home'), { mode: 0o700 });
  fs.mkdirSync(join(root, 'prior'), { mode: 0o700 });
  fs.writeFileSync(join(root, 'home/retained.txt'), 'opaque legacy home', { mode: 0o600 });
  const map = (path) =>
    typeof path === 'string' &&
    (path === f.root + '/home' || path.startsWith(f.root + '/home/')
      ? join(root, 'home') + path.slice((f.root + '/home').length)
      : path === f.archive + '/ordinary-prior/home' ||
          path.startsWith(f.archive + '/ordinary-prior/home/')
        ? join(root, 'prior/home') + path.slice((f.archive + '/ordinary-prior/home').length)
        : undefined);
  const original = { ...io },
    fds = new Map(),
    writers = new Set();
  let next = 100000;
  temporaryHandles.push(() => {
    for (const fd of [...fds.values(), ...writers]) fs.closeSync(fd);
    fds.clear();
    writers.clear();
  });
  io.lstatSync = (path) => {
    const p = map(path);
    if (!p) return original.lstatSync(path);
    const st = fs.lstatSync(p);
    return {
      ...st,
      dev: 1,
      isFile: () => st.isFile(),
      isDirectory: () => st.isDirectory(),
      isSymbolicLink: () => st.isSymbolicLink(),
    };
  };
  io.realpathSync = (path) => {
    const p = map(path);
    if (!p) return original.realpathSync(path);
    if (fs.realpathSync(p) !== p) throw Error('realtestalias');
    return path;
  };
  io.readdirSync = (path) => (map(path) ? fs.readdirSync(map(path)) : original.readdirSync(path));
  io.mkdirSync = (path, options) => {
    if (map(path)) fs.mkdirSync(map(path), options);
    return original.mkdirSync(path, options);
  };
  io.renameSync = (a, b) => {
    if (map(a) || map(b)) {
      if (!map(a) || !map(b)) throw Error('testscope');
      fs.renameSync(map(a), map(b));
    }
    return original.renameSync(a, b);
  };
  io.openSync = (path, flags, mode) => {
    const p = map(path);
    if (!p) return original.openSync(path, flags, mode);
    const translated =
      typeof flags === 'string'
        ? flags
        : (flags & 64 ? fs.constants.O_CREAT : 0) |
          (flags & 128 ? fs.constants.O_EXCL : 0) |
          (flags & 1 ? fs.constants.O_WRONLY : 0) |
          (flags & 256 ? fs.constants.O_NOFOLLOW : 0);
    const fd = fs.openSync(p, translated, mode);
    fds.set(++next, fd);
    return next;
  };
  for (const name of ['fstatSync', 'readFileSync', 'writeFileSync', 'fsyncSync', 'closeSync'])
    io[name] = (...args) => {
      if (fds.has(args[0])) {
        const fd = fds.get(args[0]);
        if (name === 'closeSync') fds.delete(args[0]);
        return fs[name](fd, ...args.slice(1));
      }
      if (name === 'readFileSync' && map(args[0]))
        return fs.readFileSync(map(args[0]), ...args.slice(1));
      return original[name](...args);
    };
  return {
    inspect: (path) => (map(path) ? inspectOpaquePreservationTree(map(path)) : undefined),
    openWriter: () => {
      const fd = fs.openSync(join(root, 'home/retained.txt'), 'r+');
      writers.add(fd);
      return fd;
    },
    mutate(fd) {
      fs.writeSync(fd, Buffer.from('changed legacy home'), 0, 18, 0);
      fs.closeSync(fd);
      writers.delete(fd);
    },
    archived: () => fs.readFileSync(join(root, 'prior/home/retained.txt'), 'utf8'),
  };
}
it('preserves opaque bytes and raw uncertain ownership, then grants distinct contained disposition', async () => {
  const f = fixture();
  const original = f.nodes.get(f.root + '/symposium/state/private-native-data').bytes;
  const result = await f.transaction().apply(f.authorize());
  expect(result.disposition).toBe(dispos);
  expect(result.nativeCleanupConfirmed).toBe(false);
  expect(f.nodes.get(f.archive + '/symposium/state/private-native-data').bytes).toEqual(original);
  expect(f.nodes.has(f.root + '/symposium')).toBe(false);
  expect(f.db.prepare('SELECT * FROM launches').all()).toEqual([f.row]);
  expect(
    JSON.parse(f.db.prepare('SELECT recordJson FROM contained_owned_launches').get().recordJson),
  ).toEqual(f.row);
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
  expect([...f.nodes.keys()].some((p) => p.endsWith('custodian-retirement.json'))).toBe(false);
});
it('refuses JSON authority and retains existing deployment guards without changing any resource', async () => {
  const f = fixture();
  await expect(f.transaction().apply({ planSha256: f.plan.sha256 })).rejects.toThrow('fresh auth');
  f.nodes.set(f.root + '/service/deployment.lock', {
    bytes: Buffer.from('old guard'),
    mode: 0o600,
    ino: 99,
  });
  await expect(f.transaction().apply(f.authorize())).rejects.toThrow();
  expect(f.nodes.get(f.root + '/service/deployment.lock').bytes.toString()).toBe('old guard');
  expect(f.order).toEqual([]);
});
it.each(['invalidateControl', 'assertBeforeMove', 'assertContained'])(
  'retains the guard and never disposes capacity after uncertain %s',
  async (method) => {
    const f = fixture();
    f.effects[method].mockRejectedValue(Error('uncertain effect'));
    await expect(f.transaction().apply(f.authorize())).rejects.toThrow('uncertain effect');
    if (method !== 'assertBeforeMove')
      expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
    expect(f.db.prepare('SELECT * FROM launches').all()).toHaveLength(1);
  },
);
it('refuses stale authentication between physical inspection and source mutation', async () => {
  const f = fixture();
  f.effects.assertBeforeMove.mockImplementation(async () => {
    f.expire();
  });
  await expect(f.transaction().apply(f.authorize())).rejects.toThrow('expired auth');
  expect(f.nodes.has(f.root + '/symposium')).toBe(true);
  expect(f.effects.invalidateControl).not.toHaveBeenCalled();
});
it('verification uses fresh authority and physical proof without replaying any completed move or unload', async () => {
  const f = fixture();
  f.effects.assertContained.mockRejectedValueOnce(Error('lost acknowledgement'));
  await expect(f.transaction().apply(f.authorize())).rejects.toThrow('lost acknowledgement');
  const moves = f.order.filter((s) => s.startsWith('move:')).length;
  const unregistrations = f.effects.invalidateControl.mock.calls.length;
  const result = await f.transaction().verify(f.authorize());
  expect(result.disposition).toBe(dispos);
  expect(f.order.filter((s) => s.startsWith('move:'))).toHaveLength(moves);
  expect(f.effects.invalidateControl).toHaveBeenCalledTimes(unregistrations);
  expect(f.db.prepare('SELECT * FROM launches').all()).toEqual([f.row]);
});
it('verification refuses incomplete preservation or changed held row', async () => {
  const f = fixture();
  f.effects.invalidateControl.mockRejectedValue(Error('uncertain unload'));
  await expect(f.transaction().apply(f.authorize())).rejects.toThrow();
  await expect(f.transaction().verify(f.authorize())).rejects.toThrow();
  expect(f.db.prepare('SELECT * FROM launches').all()).toHaveLength(1);
});
it('refuses capacity disposition when complete archive content changes', async () => {
  const f = fixture();
  f.effects.assertContained.mockImplementation(async () => {
    f.nodes.get(f.archive + '/symposium/state/private-native-data').bytes = Buffer.from('changed');
  });
  await expect(f.transaction().apply(f.authorize())).rejects.toThrow(/manifest/);
  expect(f.db.prepare('SELECT * FROM launches').all()).toHaveLength(1);
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
});
it('retains uncertainty when authentication expires during normal control invalidation', async () => {
  const f = fixture();
  f.effects.invalidateControl.mockImplementation(async () => {
    f.expire();
  });
  await expect(f.transaction().apply(f.authorize())).rejects.toThrow('expired auth');
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
  expect(f.nodes.has(f.root + '/symposium')).toBe(true);
  expect(f.db.prepare('SELECT * FROM launches').all()).toHaveLength(1);
});
it('compares every original reservation column inside the disposition transaction', async () => {
  const f = fixture();
  f.effects.assertContained.mockImplementation(async () => {
    f.db.prepare('UPDATE launches SET ownerChat=?').run('changed owner');
  });
  await expect(f.transaction().apply(f.authorize())).rejects.toThrow(/reservation changed/);
  expect(f.db.prepare('SELECT * FROM launches').all()).toHaveLength(1);
  expect(
    f.db.prepare("SELECT name FROM sqlite_master WHERE name='contained_owned_launches'").get(),
  ).toBeUndefined();
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
});
it('never replays apply using the same original transaction even with another authority', async () => {
  const f = fixture();
  const t = f.transaction();
  await t.apply(f.authorize());
  await expect(t.apply(f.authorize())).rejects.toThrow(/cannot be replayed/);
  expect(f.effects.invalidateControl).toHaveBeenCalledTimes(2);
});
it('hands off one continuous guard and releases only after trusted ordinary completion', async () => {
  const f = fixture();
  let cap;
  const ordinary = { sha256: 'a'.repeat(64) };
  f.effects.assertGuardContinuation = vi.fn(() => true);
  await f
    .transaction({
      continueGuard: (value) => {
        cap = value;
      },
    })
    .apply(f.authorize());
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
  const binding = {
    planSha256: ordinary.sha256,
    intentPath: f.archive + '/ordinary.intent',
    intentSha256: 'b'.repeat(64),
    target: 'accepted-source',
  };
  cap.bindOrdinaryGuard(binding, ordinary);
  const guard = JSON.parse(f.nodes.get(f.root + '/service/deployment.lock').bytes);
  expect(guard).toMatchObject({
    id: '33333333-3333-4333-8333-333333333333',
    target: 'accepted-source',
    continuationPlanSha256: ordinary.sha256,
  });
  expect(f.order.filter((v) => v.startsWith('unlink:'))).toEqual([]);
  f.effects.assertGuardContinuation.mockImplementation(() => {
    throw Error('expired combined auth');
  });
  await expect(cap.completeOrdinaryGuard({ pid: 1 }, ordinary)).rejects.toThrow(
    'expired combined auth',
  );
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
  f.effects.assertGuardContinuation.mockImplementation(() => true);
  await expect(cap.completeOrdinaryGuard({ pid: 1, birth: 'verified' }, ordinary)).rejects.toThrow(
    'cannot be replayed',
  );
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
});
it('refuses a foreign guard and restores its own guard on uncertain final unlock', async () => {
  const f = fixture();
  let cap;
  f.effects.assertGuardContinuation = () => true;
  await f
    .transaction({
      continueGuard: (value) => {
        cap = value;
      },
    })
    .apply(f.authorize());
  const ordinary = { sha256: 'a'.repeat(64) };
  cap.bindOrdinaryGuard(
    {
      planSha256: ordinary.sha256,
      intentPath: f.archive + '/ordinary.intent',
      intentSha256: 'b'.repeat(64),
      target: 'accepted-source',
    },
    ordinary,
  );
  const original = f.nodes.get(f.root + '/service/deployment.lock').bytes;
  f.nodes.get(f.root + '/service/deployment.lock').bytes = Buffer.from('{}');
  expect(() => cap.assertOwnedGuard(ordinary)).toThrow();
  f.nodes.get(f.root + '/service/deployment.lock').bytes = original;
  const remove = f.io.unlinkSync.bind(f.io);
  f.io.unlinkSync = (path) => {
    remove(path);
    throw Error('lost unlock acknowledgement');
  };
  await expect(cap.completeOrdinaryGuard({}, ordinary)).rejects.toThrow(
    'lost unlock acknowledgement',
  );
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
});
it('checks auth again after a long original manifest read before moving the opaque unit', async () => {
  const f = fixture();
  const inspect = f.effects.inspectTree;
  f.effects.inspectTree = (path) => {
    const result = inspect(path);
    if (path === f.root + '/symposium') f.expire();
    return result;
  };
  await expect(f.transaction().apply(f.authorize())).rejects.toThrow('expired auth');
  expect(f.nodes.has(f.root + '/symposium')).toBe(true);
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
  expect(f.db.prepare('SELECT * FROM launches').all()).toHaveLength(1);
});
it('refuses a cross-volume unit before durable intent or control disposition', async () => {
  const f = fixture();
  const stat = f.io.lstatSync.bind(f.io);
  f.io.lstatSync = (path) => ({ ...stat(path), dev: path === f.root + '/symposium' ? 2 : 1 });
  await expect(f.transaction().apply(f.authorize())).rejects.toThrow(/same-volume/);
  expect(f.effects.invalidateControl).not.toHaveBeenCalled();
  expect(f.nodes.has(f.root + '/symposium')).toBe(true);
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(false);
});
it('refuses verification of an altered original SQLite backup', async () => {
  const f = fixture();
  f.effects.assertContained.mockRejectedValueOnce(Error('lost verification'));
  await expect(f.transaction().apply(f.authorize())).rejects.toThrow('lost verification');
  f.nodes.get(f.archive + '/original-registry.db').bytes = Buffer.from('changed backup');
  await expect(f.transaction().verify(f.authorize())).rejects.toThrow(/backup proof changed/);
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
  expect(f.db.prepare('SELECT * FROM launches').all()).toHaveLength(1);
});
it('keeps partial control preservation fenced and never replays it during verification', async () => {
  const f = fixture();
  f.effects.invalidateControl.mockImplementation(async (control) => {
    if (control.kind === 'vm_supervisor') throw Error('uncertain VM unload');
  });
  await expect(f.transaction().apply(f.authorize())).rejects.toThrow('uncertain VM unload');
  expect(f.nodes.has(f.plan.facts.controls[0].archivePath)).toBe(true);
  expect(f.nodes.has(f.plan.facts.controls[1].path)).toBe(true);
  const count = f.effects.invalidateControl.mock.calls.length;
  await expect(f.transaction().verify(f.authorize())).rejects.toThrow(/paths remain available/);
  expect(f.effects.invalidateControl).toHaveBeenCalledTimes(count);
  expect(f.db.prepare('SELECT * FROM launches').all()).toHaveLength(1);
});

async function effectsFixture() {
  const f = fixture();
  let alive = true,
    loaded = true;
  const vm = f.plan.facts.controls.find((c) => c.kind === 'vm_supervisor');
  const command = vi.fn((_program, args) => {
    const isVm = args[1].endsWith('/' + vm.label);
    if (args[0] === 'bootout') {
      loaded = false;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (isVm && loaded)
      return {
        status: 0,
        stderr: '',
        stdout: `path = ${vm.path}\nstate = not running\nruns = 0\n`,
      };
    const label = args[1].split('/').at(-1);
    return {
      status: 113,
      stdout: '',
      stderr: `Could not find service "${label}" in domain for user gui: ${f.plan.facts.operatorUid}`,
    };
  });
  const qualify = vi.fn(async () => {}),
    before = vi.fn(async () => {});
  const options = {
    plan: f.plan,
    sourceRoot: '/reviewed-source',
    assertAuthorityCurrent: () => {
      if (!alive) throw Error('expired original authority');
      return true;
    },
  };
  const deps = {
    io: f.io,
    hashFile: f.effects.hashFile,
    qualify,
    command,
    assertBeforeMove: before,
    assertContained: vi.fn(async () => {}),
  };
  const effects = await createOfflineContainmentEffects(options, deps);
  return {
    ...f,
    effects,
    command,
    qualify,
    before,
    vm,
    expire: () => {
      alive = false;
    },
  };
}
it('uses only normal bootout for exact stopped original supervisor and verifies absence', async () => {
  const f = await effectsFixture();
  await f.effects.invalidateControl(f.vm);
  expect(f.command.mock.calls.filter(([, args]) => args[0] === 'bootout')).toEqual([
    ['/bin/launchctl', ['bootout', `gui/${f.plan.facts.operatorUid}/${f.vm.label}`]],
  ]);
  expect(f.qualify).toHaveBeenCalledTimes(3);
});
it('never unloads an absent app registration or operates a caller-selected control', async () => {
  const f = await effectsFixture();
  await f.effects.invalidateControl(f.plan.facts.controls.find((c) => c.kind === 'app'));
  await expect(f.effects.invalidateControl({ ...f.vm, label: 'foreign' })).rejects.toThrow(
    'Exact original control',
  );
  expect(f.command.mock.calls.some(([, args]) => args[0] === 'bootout')).toBe(false);
});
it('refuses supervisor unload if original auth expires during source qualification', async () => {
  const f = await effectsFixture();
  f.qualify.mockImplementationOnce(async () => f.expire());
  await expect(f.effects.invalidateControl(f.vm)).rejects.toThrow('expired original authority');
  expect(f.command).not.toHaveBeenCalled();
});
it('refuses supervisor unload if its stopped state or control bytes changed', async () => {
  const f = await effectsFixture();
  f.command.mockReturnValueOnce({
    status: 0,
    stderr: '',
    stdout: `path = ${f.vm.path}\nstate = running\nruns = 1\npid = 42\n`,
  });
  await expect(f.effects.invalidateControl(f.vm)).rejects.toThrow('Exact stopped original VM');
  expect(f.command.mock.calls.some(([, args]) => args[0] === 'bootout')).toBe(false);
});
it('refuses success when normal bootout has uncertain acknowledgement', async () => {
  const f = await effectsFixture();
  f.command.mockImplementation((_program, args) =>
    args[0] === 'bootout'
      ? { status: 0, signal: 'SIGTERM' }
      : { status: 0, stderr: '', stdout: `path = ${f.vm.path}\nstate = not running\nruns = 0\n` },
  );
  await expect(f.effects.invalidateControl(f.vm)).rejects.toThrow('unload unconfirmed');
});

it('continuation refuses changed native receipt bytes even with a current live lease', async () => {
  const f = fixture();
  let cap;
  f.effects.assertGuardContinuation = () => true;
  await f
    .transaction({
      continueGuard: (value) => {
        cap = value;
      },
    })
    .apply(f.authorize());
  f.nodes.get(f.archive + '/containment-receipt.json').bytes = Buffer.from('{}');
  expect(() => cap.assertOwnedGuard({ sha256: 'a'.repeat(64) })).toThrow(
    'completion evidence changed',
  );
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
});

it('releases the continuous bound guard once after verified ordinary completion', async () => {
  const f = fixture();
  let cap;
  f.effects.assertGuardContinuation = () => true;
  await f
    .transaction({
      continueGuard: (value) => {
        cap = value;
      },
    })
    .apply(f.authorize());
  const ordinary = { sha256: 'a'.repeat(64) };
  const binding = {
    planSha256: ordinary.sha256,
    intentPath: f.archive + '/ordinary.intent',
    intentSha256: 'b'.repeat(64),
    target: 'accepted-source',
  };
  cap.bindOrdinaryGuard(binding, ordinary);
  expect(() => cap.bindOrdinaryGuard(binding, ordinary)).toThrow('cannot be replayed');
  await cap.completeOrdinaryGuard({ pid: 42, birth: 'verified' }, ordinary);
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(false);
  await expect(cap.completeOrdinaryGuard({ pid: 42 }, ordinary)).rejects.toThrow(
    'cannot be replayed',
  );
  expect(f.db.prepare('SELECT * FROM launches').all()).toEqual([f.row]);
});

it.each([
  'normal',
  'native-after-install',
  'ordinary-after-preserved',
  'ordinary-last-native-await',
])(
  'integrates actual native custody with mandatory full ordinary boundary proofs (%s)',
  async (scenario) => {
    const mutateAfterInstall = scenario === 'native-after-install';
    const mutateOrdinary = scenario === 'ordinary-after-preserved';
    const mutateDuringLastAwait = scenario === 'ordinary-last-native-await';
    const f = fixture();
    let ino = 1000;
    const add = (path, bytes, mode = 0o600) =>
      f.nodes.set(path, {
        ino: ino++,
        mode,
        bytes: bytes === undefined ? undefined : Buffer.from(bytes),
      });
    const mkdir = (path) => {
      if (f.nodes.has(path)) return;
      mkdir(path.slice(0, path.lastIndexOf('/')));
      add(path, undefined, 0o700);
    };
    const sourceCommit = 'a'.repeat(40),
      release = f.root + '/releases/' + sourceCommit.slice(0, 12),
      nodePath = '/virtual/node';
    mkdir(release + '/scripts/lib');
    for (const name of [
      'staging-launcher-template.mjs',
      'staging-files.mjs',
      'staging-operations.mjs',
    ])
      add(release + '/scripts/lib/' + name, readFileSync(process.cwd() + '/scripts/lib/' + name));
    add(
      release + '/staging-release.json',
      JSON.stringify({
        sourceCommit,
        sourceTree: 'b'.repeat(40),
        compiledArtifacts: { 'dist/index.js': 'c'.repeat(64) },
        dependencyFingerprint: 'd'.repeat(64),
      }) + '\n',
    );
    mkdir(f.root + '/service/control-lib');
    mkdir(f.root + '/bin');
    add(f.root + '/service/start.mjs', 'prior launcher');
    for (const kind of ['home', 'workspace', 'state', 'settings']) {
      mkdir(f.root + '/' + kind);
      add(f.root + '/' + kind + '/retained.txt', 'opaque legacy ' + kind);
    }
    const io = {
      ...f.io,
      readdirSync(path) {
        if (!f.nodes.has(path)) throw Error('missingdirectory');
        return [...f.nodes.keys()]
          .filter((p) => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/'))
          .map((p) => p.slice(path.length + 1));
      },
    };
    const backedHome =
      mutateOrdinary || mutateDuringLastAwait ? realOrdinaryHome(io, f) : undefined;
    const inspectTree = (path) =>
      backedHome?.inspect(path) ?? {
        sha256: hash(
          [...f.nodes]
            .filter(([p]) => p === path || p.startsWith(path + '/'))
            .map(([p, n]) => [p.slice(path.length), n.ino, n.mode, n.bytes?.toString()])
            .sort(),
        ),
      };
    const verifySource = vi.fn(async () => true);
    const facts = await collectOfflineOrdinaryRestorationFacts(
      { containmentPlan: f.plan, sourceCommit, assertAcceptedPreparedSource: verifySource },
      { io, inspectTree, nodePath, observePhysicalScope: () => true },
    );
    let writer = backedHome?.openWriter();
    const ordinaryPlan = createOfflineOrdinaryRestorationPlan(facts);
    const proposal = createOfflineRecoveryProposal({ containmentPlan: f.plan, ordinaryPlan });
    const alive = true;
    let baseClosed = false,
      nativeClosed = false,
      cap,
      nativeReceipt,
      ordinaryEffects;
    const token = {};
    const phases = createOfflineRecoveryAuthority({
      proposal,
      consumeAuthority: (auth, sha) => {
        expect(auth).toBe(token);
        expect(sha).toBe(proposal.sha256);
        return {
          assertCurrent(expected) {
            if (!alive || baseClosed || expected !== proposal.sha256)
              throw Error('expiredcombined');
            return true;
          },
          close() {
            baseClosed = true;
          },
        };
      },
      assertContainmentReady: async () => {
        expect(nativeClosed).toBe(true);
        expect(baseClosed).toBe(false);
        expect(cap.assertOwnedGuard(ordinaryPlan)).toBe(nativeReceipt.receiptSha256);
        await nativeEffects.assertContained(f.plan, { planSha256: f.plan.sha256 });
      },
    });
    let active = false;
    const physicalProofs = [];
    const nativeEffects = {
      ...f.effects,
      assertContained: vi.fn(async () => {
        const full = f.effects.inspectTree(f.archive + '/symposium');
        if (full.sha256 !== f.plan.facts.units[0].manifestSha256)
          throw Error('Actual full physical content proof failed');
        physicalProofs.push({ appInstalled: f.nodes.has(ordinaryPlan.registration.path), active });
        if (mutateDuringLastAwait && physicalProofs.length === 12) {
          await Promise.resolve();
          backedHome.mutate(writer);
          writer = undefined;
          expect(backedHome.archived()).not.toBe('opaque legacy home');
        }
      }),
      io,
      assertGuardContinuation(...args) {
        return ordinaryEffects.assertGuardContinuation(...args);
      },
    };
    const native = createOfflineContainmentTransaction({
      plan: f.plan,
      consumeAuthority: phases.consumeContainment,
      effects: nativeEffects,
      continueGuard(value, receipt) {
        cap = value;
        nativeReceipt = receipt;
      },
    });
    await native.apply(token);
    nativeClosed = true;
    expect(baseClosed).toBe(false);
    expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
    const run = vi.fn((program, args) => {
      if (program === '/bin/launchctl' && args[0] === 'bootstrap') {
        expect(physicalProofs.some((proof) => proof.appInstalled && !proof.active)).toBe(true);
      }
      if (program === '/bin/launchctl' && args[0] === 'kickstart') {
        active = true;
        return { status: 0, stdout: '' };
      }
      if (program === '/bin/launchctl' && args[0] === 'print')
        return active
          ? { status: 0, stdout: 'path = ' + ordinaryPlan.registration.path + '\npid = 456\n' }
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
              : nodePath + ' ' + release + '/dist/index.js\n',
        };
      if (program === '/usr/sbin/lsof' && args.includes('cwd'))
        return { status: 0, stdout: 'p456\nn' + release + '\n' };
      if (program === '/usr/sbin/lsof')
        return active && args.includes('-iTCP:3190')
          ? { status: 0, stdout: '456\n' }
          : { status: 1, stdout: '' };
      return { status: 0, stdout: '' };
    });
    ordinaryEffects = createOfflineOrdinaryEffects(
      {
        plan: ordinaryPlan,
        initialContainmentReceiptSha256: nativeReceipt.receiptSha256,
        verifySource,
        verifyContainment: async () => {
          const receiptSha256 = cap.assertOwnedGuard(ordinaryPlan);
          await nativeEffects.assertContained(f.plan, { planSha256: f.plan.sha256 });
          return { receiptSha256 };
        },
        guardCapability: cap,
        assertAuthorityCurrent: () => phases.assertCurrent(),
      },
      {
        io,
        inspectTree,
        nodePath,
        run,
        fetch: vi.fn(async () => ({ status: 200 })),
        observePhysicalScope: () => true,
      },
    );
    // This ownership check precedes assertNativeContained, exercising the bootstrap
    // cycle that isolated mocks of the capsule did not detect.
    expect(cap.assertOwnedGuard(ordinaryPlan)).toBe(nativeReceipt.receiptSha256);
    const restore = createOfflineOrdinaryRestoration({
      plan: ordinaryPlan,
      consumeAuthority: phases.consumeOrdinary,
      effects: mutateOrdinary
        ? {
            ...ordinaryEffects,
            async assertPreservedUnit(unit, ...args) {
              await ordinaryEffects.assertPreservedUnit(unit, ...args);
              if (unit.kind === 'home' && writer !== undefined) {
                backedHome.mutate(writer);
                writer = undefined;
                expect(backedHome.archived()).not.toBe('opaque legacy home');
              }
            },
          }
        : mutateAfterInstall
          ? {
              ...ordinaryEffects,
              async installOrdinaryController(...args) {
                await ordinaryEffects.installOrdinaryController(...args);
                const node = f.nodes.get(f.archive + '/symposium/state/private-native-data');
                node.bytes = Buffer.alloc(node.bytes.length, 120);
                node.mtimeMs = 1;
                // Ownership can remain valid while the next full proof must reject bytes.
                expect(cap.assertOwnedGuard(ordinaryPlan)).toBe(nativeReceipt.receiptSha256);
              },
            }
          : ordinaryEffects,
    });
    if (mutateAfterInstall || mutateOrdinary) {
      await expect(restore.apply(token)).rejects.toThrow(
        mutateOrdinary
          ? /Ordinary restoration evidence changed/
          : 'Actual full physical content proof failed',
      );
      expect(run.mock.calls.some(([, args]) => ['bootstrap', 'kickstart'].includes(args[0]))).toBe(
        false,
      );
      expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
      expect(f.db.prepare('SELECT * FROM launches').all()).toEqual([f.row]);
      phases.close();
      return;
    }
    if (mutateDuringLastAwait) {
      await expect(restore.apply(token)).rejects.toThrow(/Ordinary restoration evidence changed/);
      expect(run.mock.calls.filter(([, args]) => args[0] === 'bootstrap')).toHaveLength(1);
      expect(run.mock.calls.filter(([, args]) => args[0] === 'kickstart')).toHaveLength(1);
      expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
      expect(f.db.prepare('SELECT * FROM launches').all()).toEqual([f.row]);
      phases.close();
      return;
    }
    const result = await restore.apply(token);
    expect(result).toMatchObject({
      containmentSha256: nativeReceipt.receiptSha256,
      pid: 456,
      nativeCleanupConfirmed: false,
    });
    expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(false);
    expect(f.db.prepare('SELECT * FROM launches').all()).toEqual([f.row]);
    const history = f.db.prepare('SELECT * FROM contained_owned_launches').get();
    expect(history.receiptSha256).toBe(nativeReceipt.receiptSha256);
    expect(JSON.parse(history.recordJson)).toEqual(f.row);
    const installations = f.order.filter(
      (value) => value.startsWith('move:') && value.includes('.ordinary-'),
    );
    expect(installations.at(-1)).toContain('/com.mitzo.staging.plist.ordinary-');
    expect(ordinaryEffects.getReplacementProof().originalJob.pid).toBe(456);
    expect(run.mock.calls.filter(([, args]) => args[0] === 'bootstrap')).toHaveLength(1);
    expect(run.mock.calls.filter(([, args]) => args[0] === 'kickstart')).toHaveLength(1);
    expect(f.nodes.get(f.archive + '/ordinary-prior/home/retained.txt').bytes.toString()).toBe(
      'opaque legacy home',
    );
    expect(physicalProofs).toHaveLength(12); // Two native completion plus ten ordinary/release proofs.
    expect(physicalProofs.some((proof) => proof.appInstalled && proof.active)).toBe(true);
    expect(baseClosed).toBe(false);
    phases.close();
    expect(baseClosed).toBe(true);
    await expect(ordinaryEffects.assertGuardOwnership(ordinaryPlan)).rejects.toThrow(
      'retain staging guard',
    );
  },
);
it('checks hot custody ownership without reading native body bytes while independent boundaries retain full proofs', async () => {
  const f = fixture();
  let cap;
  const inspect = vi.fn(f.effects.inspectTree);
  f.effects.inspectTree = inspect;
  f.effects.assertGuardContinuation = () => true;
  f.effects.assertContained = vi.fn(async () => {
    const full = inspect(f.archive + '/symposium');
    if (full.sha256 !== f.plan.facts.units[0].manifestSha256)
      throw Error('Actual full physical content proof failed');
  });
  await f
    .transaction({
      continueGuard: (value) => {
        cap = value;
      },
    })
    .apply(f.authorize());
  expect(inspect.mock.calls.filter(([path]) => path === f.archive + '/symposium')).toHaveLength(7);
  inspect.mockClear();
  const ordinary = { sha256: 'a'.repeat(64) };
  for (let i = 0; i < 12; i++) cap.assertOwnedGuard(ordinary);
  expect(inspect).not.toHaveBeenCalled();
  cap.bindOrdinaryGuard(
    {
      planSha256: ordinary.sha256,
      intentPath: f.archive + '/ordinary.intent',
      intentSha256: 'b'.repeat(64),
      target: 'accepted-source',
    },
    ordinary,
  );
  await cap.completeOrdinaryGuard({ pid: 42, birth: 'verified' }, ordinary);
  expect(inspect).toHaveBeenCalledTimes(1); // Independent release proof, not ownership.
});
it('does not mistake ownership for byte containment when same-size native content changes', async () => {
  const f = fixture();
  let cap;
  const inspect = vi.fn(f.effects.inspectTree);
  f.effects.inspectTree = inspect;
  f.effects.assertGuardContinuation = () => true;
  f.effects.assertContained = vi.fn(async () => {
    if (inspect(f.archive + '/symposium').sha256 !== f.plan.facts.units[0].manifestSha256)
      throw Error('Actual full physical content proof failed');
  });
  await f
    .transaction({
      continueGuard: (value) => {
        cap = value;
      },
    })
    .apply(f.authorize());
  const ordinary = { sha256: 'a'.repeat(64) };
  cap.bindOrdinaryGuard(
    {
      planSha256: ordinary.sha256,
      intentPath: f.archive + '/ordinary.intent',
      intentSha256: 'b'.repeat(64),
      target: 'accepted-source',
    },
    ordinary,
  );
  inspect.mockClear();
  const node = f.nodes.get(f.archive + '/symposium/state/private-native-data');
  node.bytes = Buffer.alloc(node.bytes.length, 120);
  node.mtimeMs = 1;
  expect(cap.assertOwnedGuard(ordinary)).toMatch(/^[a-f0-9]{64}$/);
  expect(inspect).not.toHaveBeenCalled();
  await expect(cap.completeOrdinaryGuard({ pid: 42, birth: 'verified' }, ordinary)).rejects.toThrow(
    'Actual full physical content proof failed',
  );
  expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
  expect(f.db.prepare('SELECT * FROM launches').all()).toEqual([f.row]);
  await expect(f.transaction().verify(f.authorize())).rejects.toThrow(
    'Archived full manifest changed',
  );
});

it.each([false, undefined, {}, Promise.resolve(true)])(
  'requires synchronous positive final-preservation before releasing custody (%j)',
  async (result) => {
    const f = fixture();
    let cap;
    f.effects.assertGuardContinuation = (_native, _ordinary, phase) =>
      phase === 'final-preservation' ? result : true;
    await f
      .transaction({
        continueGuard: (value) => {
          cap = value;
        },
      })
      .apply(f.authorize());
    const ordinary = { sha256: 'a'.repeat(64) };
    cap.bindOrdinaryGuard(
      {
        planSha256: ordinary.sha256,
        intentPath: f.archive + '/ordinary.intent',
        intentSha256: 'b'.repeat(64),
        target: 'accepted-source',
      },
      ordinary,
    );
    await expect(
      cap.completeOrdinaryGuard({ pid: 42, birth: 'verified' }, ordinary),
    ).rejects.toThrow('Final preserved ordinary verification refused');
    expect(f.nodes.has(f.root + '/service/deployment.lock')).toBe(true);
    expect(f.db.prepare('SELECT * FROM launches').all()).toEqual([f.row]);
  },
);
