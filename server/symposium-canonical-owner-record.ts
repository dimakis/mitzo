import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { OwnedReleasePlan } from './symposium-owned-release.js';
import type { OriginalSymposiumControllerIdentity } from './symposium-custodian-main.js';
import { CanonicalOwnerSchema, type CanonicalOwner } from './symposium-canonical-control.js';
export function readCanonicalPrivateJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o777) !== 0o600 ||
      s.nlink !== 1 ||
      s.size > 128 * 1024
    )
      throw Error('Private canonical record required');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}
export function observeCanonicalProcess(pid: number): CanonicalOwner['app'] {
  if (!Number.isSafeInteger(pid) || pid < 2) throw Error('Invalid original process');
  const run = (program: string, args: string[]) =>
    execFileSync(program, args, {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 32768,
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const birth = run('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
  const parentPid = Number(run('/bin/ps', ['-p', String(pid), '-o', 'ppid=']));
  const names = run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n')
    .filter((x) => x.startsWith('n'));
  if (!birth || names.length !== 1 || !Number.isSafeInteger(parentPid) || parentPid < 1)
    throw Error('Original process observation unavailable');
  return { pid, birth, cwd: names[0].slice(1), parentPid };
}
/** This closure is created by the fresh registered launcher, not reopened from a
 * file. The live custodian callback proves its original child before and after capture. */
export function createCanonicalOwnerRecorder(
  plan: OwnedReleasePlan,
  observe = observeCanonicalProcess,
) {
  const directory = plan.planDirectory;
  const s = lstatSync(directory);
  if (
    realpathSync(directory) !== directory ||
    !s.isDirectory() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o777) !== 0o700
  )
    throw Error('Private owner plan required');
  const path = join(directory, 'original-owner.json');
  if (lstatSync(path, { throwIfNoEntry: false }))
    throw Error('Existing original owner record must be preserved');
  let previous: CanonicalOwner | undefined;
  return (identity: Readonly<OriginalSymposiumControllerIdentity>, current: () => void) => {
    current();
    if (
      identity.custodianPid !== process.pid ||
      identity.state !== 'active' ||
      identity.scope !== 'fresh-retained-sessions'
    )
      throw Error('Original launcher identity required');
    const parent = observe(identity.custodianPid),
      app = observe(identity.controllerPid);
    if (
      app.parentPid !== parent.pid ||
      parent.cwd !== plan.releaseRoot ||
      app.cwd !== plan.releaseRoot
    )
      throw Error('Original process topology changed');
    const owner = CanonicalOwnerSchema.parse({
      version: 1,
      sourceCommit: plan.sourceCommit,
      configSha256: plan.configSha256,
      buildSha256: plan.buildSha256,
      instanceId: identity.instanceId,
      epoch: identity.epoch,
      capturedAt: Date.now(),
      parent: { pid: parent.pid, birth: parent.birth, cwd: parent.cwd },
      app,
    });
    if (
      previous &&
      (owner.instanceId !== previous.instanceId ||
        owner.epoch <= previous.epoch ||
        JSON.stringify(owner.parent) !== JSON.stringify(previous.parent) ||
        JSON.stringify(readCanonicalPrivateJson(path)) !== JSON.stringify(previous))
    )
      throw Error('Original owner record changed');
    current();
    const target = previous ? path + '.' + randomUUID() : path;
    const fd = openSync(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(owner) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (previous) renameSync(target, path);
    const parentFd = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
    current();
    previous = owner;
  };
}
