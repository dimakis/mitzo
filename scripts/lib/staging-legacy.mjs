import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { artifacts, fingerprintDirectory, assertVisibleTrackedIndex } from './staging-files.mjs';

// Historical algorithm is retained only to verify prior evidence, never to qualify a new release.
export function fingerprintLegacyDirectory(root, directory) {
  root = realpathSync(root);
  const hash = createHash('sha256');
  function walk(path) {
    const stat = lstatSync(path);
    hash.update(JSON.stringify([relative(root, path), stat.mode & 0o777]) + '\n');
    if (stat.isSymbolicLink()) {
      const target = relative(root, realpathSync(path));
      if (target === '..' || target.startsWith('../') || target.startsWith('/'))
        throw Error('Legacy dependency escaped release');
      hash.update('link:' + readlinkSync(path) + '\n');
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else if (stat.isFile())
      hash.update(createHash('sha256').update(readFileSync(path)).digest('hex') + '\n');
    else throw Error('Unsupported legacy dependency');
  }
  walk(join(root, directory));
  return hash.digest('hex');
}

/** Prove every omitted workspace payload against existing source/artifact evidence.
 * Never bless an arbitrary current directory merely by calculating its v2 hash. */
export function auditLegacyClosure(root, receipt) {
  if (realpathSync(root) !== root) throw Error('Legacy release alias refused');
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
      },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  assertVisibleTrackedIndex(git('ls-files', '-v'));
  if (
    git('rev-parse', 'HEAD') !== receipt.sourceCommit ||
    git('rev-parse', 'HEAD^{tree}') !== receipt.sourceTree ||
    git('status', '--porcelain', '--untracked-files=no')
  )
    throw Error('Legacy source drift');
  const canonical = (value) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
    );
  if (canonical(artifacts(root)) !== canonical(receipt.compiledArtifacts))
    throw Error('Legacy artifact inventory drift');
  const legacyFingerprint = fingerprintLegacyDirectory(root, 'node_modules');
  if (legacyFingerprint !== receipt.dependencyFingerprint)
    throw Error('Legacy dependencies drifted');
  const closureFingerprint = fingerprintDirectory(root, 'node_modules');
  const targets = new Set();
  function links(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = relative(root, realpathSync(path));
      if (!target.startsWith('node_modules/')) {
        if (
          !['frontend', 'packages/client', 'packages/harness', 'packages/protocol'].includes(target)
        )
          throw Error('Unrecorded legacy workspace target');
        targets.add(target);
      }
    } else if (stat.isDirectory())
      for (const name of readdirSync(path).sort()) links(join(path, name));
  }
  links(join(root, 'node_modules'));
  const tracked = new Map();
  if (targets.size) {
    const entries = git('ls-tree', '-r', receipt.sourceCommit, '--', ...targets);
    for (const line of entries.split('\n').filter(Boolean)) {
      const [head, name] = line.split('\t'),
        [mode, type, blob] = head.split(' ');
      tracked.set(name, { mode, type, blob });
    }
  }
  const coverage = { tracked: 0, artifacts: 0 };
  const payloads = [];
  function check(path) {
    const stat = lstatSync(path),
      name = relative(root, path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const child of readdirSync(path).sort()) check(join(path, child));
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o022)
      throw Error('Unqualified workspace payload');
    const data = readFileSync(path),
      sha256 = createHash('sha256').update(data).digest('hex');
    const source = tracked.get(name);
    if (source) {
      const blob = createHash('sha1')
        .update('blob ' + data.length + '\0')
        .update(data)
        .digest('hex');
      if (
        source.type !== 'blob' ||
        blob !== source.blob ||
        Boolean(stat.mode & 0o111) !== (source.mode === '100755')
      )
        throw Error('Legacy linked source drift');
      coverage.tracked++;
    } else {
      if (receipt.compiledArtifacts[name] !== sha256)
        throw Error('Workspace payload lacks prior evidence');
      coverage.artifacts++;
    }
    payloads.push([name, sha256]);
  }
  for (const target of [...targets].sort()) check(join(root, target));
  if (
    coverage.tracked !== tracked.size ||
    fingerprintLegacyDirectory(root, 'node_modules') !== legacyFingerprint ||
    fingerprintDirectory(root, 'node_modules') !== closureFingerprint
  )
    throw Error('Legacy audit changed while reading');
  return {
    legacyFingerprint,
    closureFingerprint,
    coverage,
    payloadSha256: createHash('sha256').update(JSON.stringify(payloads)).digest('hex'),
  };
}
import process from 'node:process';
