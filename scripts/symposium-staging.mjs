#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
import { userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  writeFileSync,
  fsyncSync,
  unlinkSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import Database from 'better-sqlite3';
import {
  readOwnedReleasePlan,
  verifyRetainedOwnedRelease,
} from '../dist/symposium-owned-release.js';
import {
  assertCanonicalStagingService,
  canonicalStagingRoot,
} from '../dist/symposium-staging-service.js';
import {
  CanonicalOwnerSchema,
  assertCanonicalOwnerRuntime,
  assertCanonicalOwnerRetired,
  drainCanonicalOwner,
} from '../dist/symposium-canonical-control.js';
import {
  readCanonicalPrivateJson,
  observeCanonicalProcess,
} from '../dist/symposium-canonical-owner-record.js';
import { readOwnedSymposiumHostConfig } from '../dist/symposium-owned-config-schema.js';
import { readCustodianRetirementReceipt } from '../dist/symposium-custodian-retirement.js';
// Operator metadata is never reconstructed into a native owner capability.
const root = canonicalStagingRoot(),
  service = join(root, 'symposium/service');
const job = 'gui/' + process.getuid() + '/com.mitzo.staging';
const lockPath = join(root, 'service/deployment.lock');
function syncParent(path) {
  const f = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(f);
  } finally {
    closeSync(f);
  }
}
const command = process.argv[2],
  args = process.argv.slice(3),
  flags = {};
try {
  if (process.platform !== 'darwin' || !['check', 'drain'].includes(command)) throw Error();
  for (let i = 0; i < args.length; i++) {
    if (['--offline', '--apply'].includes(args[i])) {
      if (flags[args[i]]) throw Error();
      flags[args[i]] = true;
    } else if (
      ['--instance', '--epoch', '--source'].includes(args[i]) &&
      args[i + 1] &&
      !flags[args[i]]
    )
      flags[args[i]] = args[++i];
    else throw Error();
  }
  if (
    (command === 'check' && Object.keys(flags).some((x) => x !== '--offline')) ||
    (command === 'drain' && flags['--offline'])
  )
    throw Error();
  const plan = readOwnedReleasePlan(join(service, 'owned-release.json'));
  if (plan.releaseRoot !== dirname(dirname(fileURLToPath(import.meta.url))))
    throw Error('Selected original release controller required');
  const registration = assertCanonicalStagingService(
    plan,
    join(root, 'symposium/settings/staging-registration.json'),
    root,
  );
  const config = readOwnedSymposiumHostConfig(plan.configPath);
  const ownerPath = join(service, 'original-owner.json');
  const owner = CanonicalOwnerSchema.parse(readCanonicalPrivateJson(ownerPath));
  function run(program, argv) {
    return execFileSync(program, argv, {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 65536,
      env: { PATH: '/usr/bin:/bin', HOME: userInfo().homedir },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  function jobPid() {
    const text = run('/bin/launchctl', ['print', job]);
    const registration = text.match(/^\s*path = (.+)$/m)?.[1]?.trim();
    if (registration !== join(root, 'service/com.mitzo.staging.plist'))
      throw Error('Canonical registration changed');
    const m = text.match(/^\s*pid = (\d+)$/m);
    return m ? Number(m[1]) : null;
  }
  function portPids(port) {
    const p = spawnSync('/usr/sbin/lsof', ['-t', '-iTCP:' + port, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    if (p.status === 1) return [];
    if (p.status !== 0) throw Error('Listener inventory unavailable');
    return [...new Set(p.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
  }
  function registry() {
    const path = join(registration.registryDirectory, 'staging.db');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1)
        throw Error('Private original registry required');
    } finally {
      closeSync(fd);
    }
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      if (db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity !== 1)
        throw Error('Singleton registry changed');
      const rows = db
        .prepare('SELECT * FROM launches WHERE planDirectory=?')
        .all(plan.planDirectory);
      if (rows.length !== 1) throw Error('Original registered launch required');
      return rows[0];
    } finally {
      db.close();
    }
  }
  function validate() {
    verifyRetainedOwnedRelease(plan);
    assertCanonicalStagingService(
      plan,
      join(root, 'symposium/settings/staging-registration.json'),
      root,
    );
    if (JSON.stringify(readCanonicalPrivateJson(ownerPath)) !== JSON.stringify(owner))
      throw Error('Original controller changed; re-plan');
    assertCanonicalOwnerRuntime(plan, owner, registry(), {
      jobPid: jobPid(),
      parent: observeCanonicalProcess(owner.parent.pid),
      app: observeCanonicalProcess(owner.app.pid),
      portPids: portPids(3190),
      protectedPids: [...portPids(3100), ...portPids(3101)],
    });
  }
  validate();
  if (lstatSync(lockPath, { throwIfNoEntry: false }))
    throw Error('Retained deployment lock requires investigation');
  if (command === 'check') {
    let main = null;
    if (!flags['--offline']) {
      const p = spawnSync(
        'git',
        ['ls-remote', 'https://github.com/dimakis/mitzo.git', 'refs/heads/main'],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: {
            PATH: '/opt/homebrew/bin:/usr/bin:/bin',
            HOME: userInfo().homedir,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
          },
        },
      );
      if (p.status !== 0) throw Error('Main freshness unavailable');
      main = p.stdout.trim().split(/\s+/)[0];
      if (!/^[a-f0-9]{40}$/.test(main)) throw Error();
    }
    console.log(
      JSON.stringify({
        safe: true,
        mode: 'owned-custodian',
        source: plan.sourceCommit,
        main,
        mainChecked: !flags['--offline'],
        stale: main === null ? null : main !== plan.sourceCommit,
        instanceId: owner.instanceId,
        epoch: owner.epoch,
        parentPid: owner.parent.pid,
        appPid: owner.app.pid,
        url: 'http://mitzo-staging.localhost:3190',
        productionActions: [],
      }),
    );
  } else {
    if (
      flags['--instance'] !== owner.instanceId ||
      Number(flags['--epoch']) !== owner.epoch ||
      flags['--source'] !== owner.sourceCommit
    )
      throw Error('Exact original instance, epoch and source required');
    if (!flags['--apply'])
      console.log(
        JSON.stringify({
          planned: true,
          apply: false,
          instanceId: owner.instanceId,
          epoch: owner.epoch,
          source: owner.sourceCommit,
          control: 'original com.mitzo.staging SIGTERM',
          requires: 'original native retirement receipt and absent parent/app/listener',
          productionActions: [],
        }),
      );
    else {
      const id = randomUUID(),
        requestedAt = Date.now();
      let fd;
      const lock = {
        id,
        mode: 'owned-custodian-drain',
        source: owner.sourceCommit,
        instanceId: owner.instanceId,
        epoch: owner.epoch,
        requestedAt,
      };
      await drainCanonicalOwner({
        async lock() {
          fd = openSync(
            lockPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          );
          writeFileSync(fd, JSON.stringify(lock) + '\n');
          fsyncSync(fd);
          syncParent(lockPath);
        },
        async validate() {
          validate();
        },
        async stop() {
          validate();
          run('/bin/launchctl', ['kill', 'SIGTERM', job]);
        },
        async verifyRetired() {
          const deadline = Date.now() + 180000;
          while (Date.now() < deadline) {
            const alive = (pid) => {
              const p = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], {
                encoding: 'utf8',
                timeout: 3000,
              });
              if (p.status === 1) return false;
              if (p.status !== 0) throw Error('Process inventory unavailable');
              return true;
            };
            if (
              !jobPid() &&
              !alive(owner.parent.pid) &&
              !alive(owner.app.pid) &&
              portPids(3190).length === 0
            ) {
              const row = registry();
              if (row.retirementStateParent !== config.gateway.stateParent)
                throw Error('Original state parent mismatch');
              assertCanonicalOwnerRetired(
                owner,
                row,
                readCustodianRetirementReceipt(config.gateway.stateParent),
                requestedAt,
              );
              return;
            }
            await setTimeout(250);
          }
          throw Error('Original retirement remains uncertain');
        },
        async audit(state) {
          const path = join(service, 'drain-' + id + '.json');
          const f = openSync(
            path,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            writeFileSync(
              f,
              JSON.stringify({ ...lock, state, at: Date.now(), productionActions: [] }) + '\n',
            );
            fsyncSync(f);
          } finally {
            closeSync(f);
          }
          syncParent(path);
        },
        async unlock() {
          if (JSON.stringify(readCanonicalPrivateJson(lockPath)) !== JSON.stringify(lock))
            throw Error('Original lock changed');
          closeSync(fd);
          unlinkSync(lockPath);
          syncParent(lockPath);
        },
      });
      console.log(
        JSON.stringify({
          retired: true,
          id,
          source: owner.sourceCommit,
          instanceId: owner.instanceId,
          epoch: owner.epoch,
          replacementStarted: false,
          productionActions: [],
        }),
      );
    }
  }
} catch {
  console.error(
    'Canonical custodian check/drain refused or uncertain. Preserve original registry, owner evidence, intent and any deployment lock; no replacement is started.',
  );
  process.exitCode = 1;
}
