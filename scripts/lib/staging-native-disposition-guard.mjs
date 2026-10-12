import process from 'node:process';
import { Buffer } from 'node:buffer';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readSync,
  writeFileSync,
  fsyncSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { offlineContainmentDigest as digest } from './staging-offline-containment-contract.mjs';
const refuse = () => Error('Original new native disposition guard unavailable; preserve evidence');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sync = (path) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
/** Original new accepted launcher only. Existing guard/recovery JSON is never
 * adopted. Constructor verification is accepted source, not a JSON callback. */
export function createContainedNativeGuard({
  root,
  allocation,
  planSha256,
  sourceCommit,
  sourceRoot,
  verifyRegisteredLauncher,
}) {
  if (
    root !== join(homedir(), '.local/share/mitzo-staging') ||
    !uuid.test(allocation) ||
    !/^[a-f0-9]{64}$/.test(planSha256) ||
    !/^[a-f0-9]{40}$/.test(sourceCommit) ||
    sourceRoot !== join(root, 'releases', sourceCommit.slice(0, 12)) ||
    typeof verifyRegisteredLauncher !== 'function'
  )
    throw refuse();
  const path = join(root, 'service/deployment.lock');
  let fd,
    captured,
    body,
    used = false,
    closed = false,
    completionAttempted = false;
  const observed = () => {
    const v = verifyRegisteredLauncher();
    if (
      !v ||
      v instanceof Promise ||
      v.pid !== process.pid ||
      typeof v.birth !== 'string' ||
      !v.birth.trim() ||
      v.sourceRoot !== sourceRoot ||
      !/^[a-f0-9]{64}$/.test(v.registrationSha256 ?? '')
    )
      throw refuse();
    return v;
  };
  const identity = (s) => ({
    dev: s.dev,
    ino: s.ino,
    uid: s.uid,
    mode: s.mode & 0o777,
    nlink: s.nlink,
  });
  const current = () => {
    if (fd === undefined || closed || digest(observed()) !== digest(captured.launcher))
      throw refuse();
    const s = lstatSync(path),
      original = fstatSync(fd);
    const currentBytes = Buffer.alloc(body.length);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1 ||
      s.uid !== process.getuid() ||
      (s.mode & 0o777) !== 0o600 ||
      realpathSync(path) !== path ||
      digest(identity(s)) !== digest(identity(original)) ||
      original.size !== body.length ||
      readSync(fd, currentBytes, 0, currentBytes.length, 0) !== currentBytes.length ||
      !currentBytes.equals(body)
    )
      throw refuse();
  };
  const owner = {
    acquire() {
      if (used || closed) throw refuse();
      used = true;
      const launcher = observed();
      const parent = lstatSync(dirname(path));
      if (
        !parent.isDirectory() ||
        parent.uid !== process.getuid() ||
        (parent.mode & 0o777) !== 0o700 ||
        realpathSync(dirname(path)) !== dirname(path)
      )
        throw refuse();
      captured = {
        version: 1,
        mode: 'contained-native-allocation',
        allocation,
        planSha256,
        sourceCommit,
        launcher,
      };
      body = Buffer.from(JSON.stringify(captured) + '\n');
      fd = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, body);
      fsyncSync(fd);
      sync(dirname(path));
      current();
      return owner;
    },
    assertCurrent: current,
    observation() {
      current();
      return Object.freeze({ ...captured, launcher: Object.freeze({ ...captured.launcher }) });
    },
    async completeNative(verifyOriginalNative) {
      if (completionAttempted || typeof verifyOriginalNative !== 'function') throw refuse();
      completionAttempted = true;
      current();
      const proof = await verifyOriginalNative();
      current();
      if (
        !proof ||
        proof.allocation !== allocation ||
        proof.sourceCommit !== sourceCommit ||
        proof.parentPid !== process.pid ||
        proof.parentBirth !== captured.launcher.birth ||
        !uuid.test(proof.instanceId ?? '') ||
        !Number.isSafeInteger(proof.epoch) ||
        proof.epoch < 1 ||
        !Number.isSafeInteger(proof.appPid) ||
        proof.appPid < 2 ||
        proof.appPid === process.pid ||
        typeof proof.appBirth !== 'string' ||
        !proof.appBirth.trim() ||
        !/^[a-f0-9]{64}$/.test(proof.vmObservationSha256 ?? '') ||
        !/^[a-f0-9]{64}$/.test(proof.archiveProofSha256 ?? '')
      )
        throw refuse();
      const evidence = join(root, 'service/native-dispositions', allocation);
      mkdirSync(evidence, { recursive: true, mode: 0o700 });
      const s = lstatSync(evidence);
      if (
        !s.isDirectory() ||
        s.uid !== process.getuid() ||
        (s.mode & 0o777) !== 0o700 ||
        realpathSync(evidence) !== evidence
      )
        throw refuse();
      const completed = join(evidence, 'launcher-completed.json');
      const record = openSync(
        completed,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(
          record,
          JSON.stringify({
            version: 1,
            allocation,
            planSha256,
            sourceCommit,
            proof,
            nativeCleanupConfirmed: false,
          }) + '\n',
        );
        fsyncSync(record);
      } finally {
        closeSync(record);
      }
      sync(evidence);
      current();
      // Only matching original new guard can be removed after fresh full proof.
      unlinkSync(path);
      sync(dirname(path));
      closed = true;
      closeSync(fd);
      fd = undefined;
    },
    retain() {
      if (closed) return;
      closed = true;
      if (fd !== undefined) {
        closeSync(fd);
        fd = undefined;
      }
    },
  };
  return Object.freeze(owner);
}
