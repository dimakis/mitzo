import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { lstatSync, openSync, fstatSync, closeSync, readFileSync, constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bytes, hash, inventory } from './staging-cold-audit.mjs';
import { deriveRetainedNativeImportClosure } from './staging-native-import-closure.mjs';

const refuse = () => Error('Bounded original loaded native source continuity unavailable');
const CAP = 512;
const HEADROOM = 256;
/** Pin the loader implementation before evaluating it. The named path and held
 * descriptor must retain their exact nanosecond identity across the await. */
export async function loadOriginalHeldFileCapture(sourceRoot, expectedSha256, assertCurrent) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw refuse();
  const path = join(sourceRoot, 'dist/native-held-file-custody.js');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = fstatSync(fd, { bigint: true });
  const fields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
  const current = () => {
    if (
      assertCurrent() !== undefined ||
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.uid !== BigInt(process.getuid()) ||
      stat.mode & 0o022n ||
      stat.size < 1n ||
      stat.size > 1024n ** 2n ||
      fields.some(
        (key) =>
          fstatSync(fd, { bigint: true })[key] !== stat[key] ||
          lstatSync(path, { bigint: true })[key] !== stat[key],
      )
    )
      throw refuse();
  };
  try {
    current();
    if (hash(readFileSync(fd)) !== expectedSha256) throw refuse();
    current();
    const module = await import(pathToFileURL(path));
    current();
    return Object.freeze({ module, assertCurrent: current });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function descriptorBudget(additional) {
  // This non-login child inherits this actual process's descriptor limit. No
  // limit is raised and no shell text originates in a request or manifest.
  const limit = spawnSync('/bin/sh', ['-c', 'ulimit -n'], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 1024,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  });
  const listed = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(process.pid), '-Ff'], {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 256 * 1024,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  });
  if (
    limit.error ||
    limit.status ||
    limit.signal ||
    limit.stderr ||
    listed.error ||
    listed.status ||
    listed.signal ||
    listed.stderr ||
    !/^[0-9]+\s*$/.test(limit.stdout)
  )
    throw refuse();
  const soft = Number(limit.stdout.trim());
  const descriptors = new Set(
    listed.stdout
      .split('\n')
      .filter((line) => /^f[0-9]+(?:[rwu])?$/.test(line))
      .map((line) => Number(line.slice(1).replace(/[rwu]$/, ''))),
  );
  if (
    !Number.isSafeInteger(soft) ||
    descriptors.size < 3 ||
    additional > CAP ||
    soft < descriptors.size + additional + HEADROOM
  )
    throw refuse();
}

/** Source-only capture after full prepared/dependency admission. The original
 * custodian keeps its already loaded functions and native import closure; new
 * wire/candidate authority still requires the complete physical inspector.
 * There is no JSON reopening, dependency tree polling or remote source lookup.
 */
export async function captureOriginalNativeSourceContinuity({
  sourceRoot,
  sourceCommit,
  heldFileModuleSha256,
  assertRegisteredOriginalCurrent,
}) {
  if (
    process.platform !== 'darwin' ||
    process.cwd() !== sourceRoot ||
    !/^[a-f0-9]{40}$/.test(sourceCommit) ||
    typeof assertRegisteredOriginalCurrent !== 'function'
  )
    throw refuse();
  const current = () => {
    const result = assertRegisteredOriginalCurrent();
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(() => {});
      throw refuse();
    }
    if (process.cwd() !== sourceRoot) throw refuse();
  };
  current();
  const originalPid = process.pid;
  const selfCurrent = () => {
    if (process.pid !== originalPid || process.ppid !== 1 || process.cwd() !== sourceRoot)
      throw refuse();
  };
  const loaded = await loadOriginalHeldFileCapture(sourceRoot, heldFileModuleSha256, selfCurrent);
  const compiled = loaded.module;
  current();
  const graph = deriveRetainedNativeImportClosure({
    readModule: (path) => bytes(join(sourceRoot, path)).toString('utf8'),
  });
  const files = new Map(graph.modules.map((value) => [value.path, value.sha256]));
  for (const [path, value] of Object.entries(inventory(join(sourceRoot, 'scripts'))))
    files.set('scripts/' + path, value.sha256);
  for (const path of [
    'package.json',
    'package-lock.json',
    'frontend/package.json',
    'staging-release.json',
  ])
    files.set(path, hash(bytes(join(sourceRoot, path))));
  // Include the registered launcher's three held pins, both old/new child
  // anchors during positive handoff, and this retained compiled/source set.
  descriptorBudget(files.size + 13);
  const held = [];
  const capture = (root, path, sha256) =>
    compiled.captureOriginalImmutableFile({
      path: join(root, path),
      sha256,
      maximumBytes: 32 * 1024 ** 2,
      uid: lstatSync(join(root, path)).uid,
      assertCurrent: selfCurrent,
    });
  try {
    for (const [path, sha256] of files) held.push(capture(sourceRoot, path, sha256));
    current();
  } catch (error) {
    for (const file of held) file.close();
    throw error;
  }
  const original = () => {
    current();
    loaded.assertCurrent();
    for (const file of held) file.assertCurrent();
    current();
  };
  return Object.freeze({
    assertCurrent: original,
    captureChild(snapshot) {
      original();
      if (
        !/^[a-f0-9]{40}$/.test(snapshot?.sourceCommit) ||
        snapshot.sourceRoot !== sourceRoot.slice(0, -12) + snapshot.sourceCommit.slice(0, 12)
      )
        throw refuse();
      descriptorBudget(4);
      const anchors = [];
      try {
        // The app child was admitted in full and is the actual loaded original
        // ChildProcess retained by main. These pins bind its source entry/receipt;
        // they do not turn a receipt or an unchanged path into owner authority.
        for (const path of [
          'dist/index.js',
          'staging-release.json',
          'package.json',
          'package-lock.json',
        ])
          anchors.push(
            capture(snapshot.sourceRoot, path, hash(bytes(join(snapshot.sourceRoot, path)))),
          );
        original();
      } catch (error) {
        for (const file of anchors) file.close();
        throw error;
      }
      let closed = false;
      return Object.freeze({
        assertCurrent() {
          if (closed) throw refuse();
          original();
          for (const file of anchors) file.assertCurrent();
        },
        closeAfterReplacement() {
          if (closed) throw refuse();
          original();
          closed = true;
          for (const file of anchors) file.close();
        },
      });
    },
  });
}
