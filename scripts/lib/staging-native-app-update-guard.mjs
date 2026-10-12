import process from 'node:process';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
  unlinkSync,
  mkdirSync,
} from 'node:fs';
const refuse = () =>
  Error('Original app update guard unavailable; preserve deployment lock and owner');
const syncDirectory = (path) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
/** A distinct original operation guard. This never opens or adopts the released
 * allocation/recovery guard and cannot change a native capacity/registry row. */
export function acquireOriginalNativeAppUpdateGuard({
  root,
  allocation,
  planSha256,
  observeRegisteredOriginal,
  assertOperationCurrent,
}) {
  if (
    root !== join(homedir(), '.local/share/mitzo-staging') ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(allocation) ||
    !/^[a-f0-9]{64}$/.test(planSha256) ||
    typeof observeRegisteredOriginal !== 'function' ||
    typeof assertOperationCurrent !== 'function'
  )
    throw refuse();
  const service = join(root, 'service'),
    path = join(service, 'deployment.lock');
  const parent = lstatSync(service);
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o777) !== 0o700 ||
    realpathSync(service) !== service
  )
    throw refuse();
  const observed = () => {
    const value = observeRegisteredOriginal();
    if (
      !value ||
      value.pid !== process.pid ||
      typeof value.birth !== 'string' ||
      !value.birth.trim() ||
      !/^[a-f0-9]{64}$/.test(value.registrationSha256 ?? '')
    )
      throw refuse();
    const result = assertOperationCurrent();
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(() => {});
      throw refuse();
    }
    return JSON.stringify(value);
  };
  const original = observed(),
    body = Buffer.from(
      JSON.stringify({
        version: 1,
        mode: 'original-native-app-child-update',
        allocation,
        planSha256,
        launcher: JSON.parse(original),
      }) + '\n',
    );
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  let closed = false,
    completionAttempted = false;
  writeFileSync(fd, body);
  fsyncSync(fd);
  syncDirectory(service);
  const current = () => {
    if (closed || observed() !== original) throw refuse();
    const named = lstatSync(path),
      held = fstatSync(fd),
      bytes = Buffer.alloc(body.length);
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.uid !== process.getuid() ||
      named.nlink !== 1 ||
      (named.mode & 0o777) !== 0o600 ||
      realpathSync(path) !== path ||
      named.dev !== held.dev ||
      named.ino !== held.ino ||
      held.size !== body.length ||
      readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length ||
      !bytes.equals(body)
    )
      throw refuse();
  };
  current();
  return Object.freeze({
    assertCurrent: current,
    complete(verifyOriginalChild) {
      if (completionAttempted || typeof verifyOriginalChild !== 'function') throw refuse();
      completionAttempted = true;
      current();
      const child = verifyOriginalChild();
      current();
      if (
        !child ||
        child instanceof Promise ||
        child.custodianPid !== process.pid ||
        !/^[a-f0-9]{40}$/.test(child.acceptedAppCommit ?? '') ||
        !/^[a-f0-9]{64}$/.test(child.compatibilitySha256 ?? '') ||
        !Number.isSafeInteger(child.controllerPid) ||
        child.controllerPid < 2 ||
        child.controllerPid === process.pid ||
        !Number.isSafeInteger(child.epoch) ||
        child.epoch < 1
      )
        throw refuse();
      const directory = join(root, 'service/native-app-updates');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const s = lstatSync(directory);
      if (
        !s.isDirectory() ||
        s.uid !== process.getuid() ||
        (s.mode & 0o777) !== 0o700 ||
        realpathSync(directory) !== directory
      )
        throw refuse();
      const record = openSync(
        join(directory, planSha256 + '.json'),
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
            original: JSON.parse(original),
            child,
            nativeAllocationChanged: false,
            nativeRetirementClaim: false,
          }) + '\n',
        );
        fsyncSync(record);
      } finally {
        closeSync(record);
      }
      syncDirectory(directory);
      current();
      unlinkSync(path);
      syncDirectory(service);
      closed = true;
      closeSync(fd);
    },
  });
}
