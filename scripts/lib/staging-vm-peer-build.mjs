import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  constants,
  lstatSync,
  realpathSync,
  readFileSync,
  mkdirSync,
  chmodSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';

const sourcePath = 'scripts/native/staging-vm-peer.c';
const artifactDirectory = 'dist/staging-vm-peer';
const compiledPath = artifactDirectory + '/helper';
const environment = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C' });
const hash = (value) => createHash('sha256').update(value).digest('hex');
function requireBuild(condition) {
  if (!condition) throw Error('Qualified staging kernel peer helper build required');
}
function ownedDirectory(path) {
  const stat = lstatSync(path);
  requireBuild(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      !(stat.mode & 0o022) &&
      realpathSync(path) === path,
  );
}
function ownedFile(path, privateExecutable = false) {
  const stat = lstatSync(path);
  requireBuild(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.uid === process.getuid() &&
      !(stat.mode & (privateExecutable ? 0o077 : 0o022)) &&
      (!privateExecutable || stat.mode & 0o100) &&
      stat.size > 0 &&
      stat.size < 16 * 1024 ** 2 &&
      realpathSync(path) === path,
  );
  return stat;
}

/** Preparation-only compilation. `assertQualifiedSource` is the controller's
 * trusted accepted-main/source/dependency verifier, never a JSON assertion.
 * Build these dist artifacts BEFORE freezing staging-release.compiledArtifacts.
 * The returned metadata is measured build evidence, not a source signature or
 * authentication capability. This function never executes the built helper or grants native ownership. */
export function buildStagingVmPeerHelper(
  { controllerRoot, sourceCommit, assertQualifiedSource },
  { run = spawnSync } = {},
) {
  requireBuild(
    typeof controllerRoot === 'string' &&
      isAbsolute(controllerRoot) &&
      /^[a-f0-9]{40}$/.test(sourceCommit ?? '') &&
      typeof assertQualifiedSource === 'function',
  );
  ownedDirectory(controllerRoot);
  const command = (executable, args) => {
    const result = run(executable, args, {
      cwd: controllerRoot,
      env: environment,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 128 * 1024,
      shell: false,
    });
    requireBuild(
      result?.status === 0 && !result.signal && !result.error && typeof result.stdout === 'string',
    );
    return result.stdout;
  };
  const qualify = () => {
    requireBuild(assertQualifiedSource(controllerRoot, sourceCommit) === undefined);
    requireBuild(command('/usr/bin/git', ['rev-parse', 'HEAD']).trim() === sourceCommit);
    requireBuild(
      command('/usr/bin/git', ['status', '--porcelain', '--untracked-files=normal']).trim() === '',
    );
  };
  qualify();
  const source = join(controllerRoot, sourcePath);
  ownedFile(source);
  const sourceBytes = readFileSync(source);
  requireBuild(
    hash(sourceBytes) === hash(command('/usr/bin/git', ['show', `${sourceCommit}:${sourcePath}`])),
  );
  const version = command('/usr/bin/clang', ['--version']).trim();
  requireBuild(
    version.length <= 1024 &&
      /^Apple clang version [0-9]/.test(version) &&
      /^[\x20-\x7e\n]+$/.test(version),
  );
  const dist = join(controllerRoot, 'dist');
  try {
    mkdirSync(dist, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  ownedDirectory(dist);
  const destination = join(controllerRoot, artifactDirectory);
  // Exclusive fresh directory: no overwrite or requalification of an old helper.
  mkdirSync(destination, { mode: 0o700 });
  const compiled = join(controllerRoot, compiledPath);
  command('/usr/bin/clang', [
    '-Wall',
    '-Wextra',
    '-Werror',
    '-O2',
    '-o',
    compiled,
    source,
    '-lproc',
  ]);
  chmodSync(compiled, 0o500);
  const stat = ownedFile(compiled, true);
  qualify();
  requireBuild(hash(readFileSync(source)) === hash(sourceBytes));
  const receipt = {
    version: 1,
    sourceCommit,
    sourcePath,
    sourceSha256: hash(sourceBytes),
    compiledPath,
    compiledSha256: hash(readFileSync(compiled)),
    clangVersion: version,
    platform: process.platform,
    architecture: process.arch,
    fileIdentity: {
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      mode: stat.mode & 0o777,
      size: stat.size,
    },
  };
  const fd = openSync(
    join(destination, 'build.json'),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  return Object.freeze(receipt);
}
