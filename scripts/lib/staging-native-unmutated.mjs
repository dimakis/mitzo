import process from 'node:process';
import { join } from 'node:path';
import {
  constants,
  lstatSync,
  realpathSync,
  readdirSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { offlineContainmentDigest as digest } from './staging-offline-containment-contract.mjs';
const refuse = () =>
  Error('Unmutated fresh native allocation cannot be proven; retain original guard and evidence');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const absent = (path) => {
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw refuse();
};
/** Read-only actual physical inspector. Source code constructs this before any
 * native preparation attempt. No serialized snapshot can reopen the original
 * inspector, authorize cleanup or release native capacity. */
export function createUnmutatedNativeAllocationInspector({
  allocation,
  canonicalRoot,
  nativeRoot,
}) {
  if (
    !uuid.test(allocation) ||
    nativeRoot !== join(canonicalRoot, 'symposium/allocations', allocation)
  )
    throw refuse();
  const inspect = () => {
    for (const name of ['home', 'workspace']) {
      const path = join(nativeRoot, name),
        s = lstatSync(path);
      if (
        !s.isDirectory() ||
        s.uid !== process.getuid() ||
        (s.mode & 0o777) !== 0o700 ||
        realpathSync(path) !== path ||
        readdirSync(path).length
      )
        throw refuse();
    }
    for (const path of [
      join(nativeRoot, 'service/fresh-vm-init-attempt.json'),
      join(nativeRoot, 'service/fresh-vm-plan.json'),
      join(nativeRoot, 'service/com.mitzo.staging.vm.plist'),
      join(nativeRoot, 'settings/containers.conf'),
      `/private/tmp/mitzo-vm-${allocation}.sock`,
    ])
      absent(path);
    const rows = [];
    let count = 0,
      bytes = 0;
    const walk = (path) => {
      if (++count > 256) throw refuse();
      const s = lstatSync(path);
      if (s.uid !== process.getuid() || realpathSync(path) !== path || s.isSymbolicLink())
        throw refuse();
      const identity = {
        path,
        dev: s.dev,
        ino: s.ino,
        uid: s.uid,
        mode: s.mode & 0o777,
        nlink: s.nlink,
        mtimeMs: s.mtimeMs,
        ctimeMs: s.ctimeMs,
      };
      if (s.isDirectory()) {
        if ((s.mode & 0o777) !== 0o700) throw refuse();
        rows.push(identity);
        for (const name of readdirSync(path).sort()) walk(join(path, name));
      } else {
        bytes += s.size;
        if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || bytes > 64 * 1024 * 1024)
          throw refuse();
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = fstatSync(fd);
          if (opened.dev !== s.dev || opened.ino !== s.ino || opened.size !== s.size)
            throw refuse();
          const body = readFileSync(fd),
            after = fstatSync(fd);
          if (
            body.length !== s.size ||
            after.mtimeMs !== opened.mtimeMs ||
            after.ctimeMs !== opened.ctimeMs
          )
            throw refuse();
          rows.push({
            ...identity,
            size: s.size,
            bytesSha256: createHash('sha256').update(body).digest('hex'),
          });
        } finally {
          closeSync(fd);
        }
      }
    };
    walk(nativeRoot);
    return digest(rows);
  };
  const vmAbsent = () => {
    const result = spawnSync(
      '/bin/launchctl',
      ['print', `gui/${process.getuid()}/com.mitzo.staging.vm`],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 },
    );
    if (
      result.error ||
      result.signal ||
      result.status === 0 ||
      !/Could not find service/.test(result.stderr ?? '')
    )
      throw refuse();
  };
  const captured = inspect();
  vmAbsent();
  if (inspect() !== captured) throw refuse();
  return Object.freeze({
    assertUnchanged() {
      if (inspect() !== captured) throw refuse();
      vmAbsent();
      if (inspect() !== captured) throw refuse();
      return Object.freeze({ preallocationSnapshotSha256: captured });
    },
  });
}
