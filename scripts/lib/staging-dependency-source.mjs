import process from 'node:process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { assertVisibleTrackedIndex, fingerprintDirectory } from './staging-files.mjs';

/** Separately provisioned, explicitly pinned dependencies. This never installs
 * packages, runs lifecycle scripts or chooses a replacement lock/version. */
export function verifyDependencySource(source, target, lockSha256, expectedFingerprint) {
  if (
    !isAbsolute(source) ||
    realpathSync(source) !== source ||
    !/^[a-f0-9]{40}$/.test(target ?? '') ||
    !/^[a-f0-9]{64}$/.test(expectedFingerprint ?? '')
  )
    throw Error('Exact audited dependency source required');
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: source,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
      },
    }).trim();
  assertVisibleTrackedIndex(git('ls-files', '-v'));
  if (
    realpathSync(git('rev-parse', '--show-toplevel')) !== source ||
    git('rev-parse', 'HEAD') !== target ||
    git('status', '--porcelain', '--untracked-files=no') ||
    git('remote', 'get-url', 'origin') !== 'https://github.com/dimakis/mitzo.git' ||
    createHash('sha256')
      .update(readFileSync(join(source, 'package-lock.json')))
      .digest('hex') !== lockSha256 ||
    fingerprintDirectory(source, 'node_modules') !== expectedFingerprint
  )
    throw Error('Audited dependency source, lock or closure changed');
  return expectedFingerprint;
}
