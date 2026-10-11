import process from 'node:process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateJson } from './staging-files.mjs';
const helperName = 'dist/staging-offline-operator-auth/helper';
const buildName = 'dist/staging-offline-operator-auth/build.json';
const sourceName = 'scripts/native/staging-operator-auth.swift';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireQualified = (value) => {
  if (!value) throw Error('Frozen qualified operator helper required');
};
/** Qualification is a trusted original controller callback. A build.json hash alone
 * is not provenance. The helper and its complete build metadata must be contained
 * in the accepted controller's independently verified compiled artifact inventory. */
export async function enrollPreparedOfflineOperatorHelper(sourceRoot, qualify) {
  requireQualified(typeof qualify === 'function' && realpathSync(sourceRoot) === sourceRoot);
  const receipt = await qualify();
  const buildPath = join(sourceRoot, buildName),
    helperPath = join(sourceRoot, helperName);
  const build = privateJson(buildPath);
  requireQualified(
    Object.keys(build).sort().join() ===
      [
        'version',
        'sourceCommit',
        'sourcePath',
        'sourceSha256',
        'compiledPath',
        'compiledSha256',
        'swiftVersion',
        'fileIdentity',
      ]
        .sort()
        .join() &&
      build.version === 1 &&
      build.sourceCommit === receipt.sourceCommit &&
      build.sourcePath === sourceName &&
      build.compiledPath === helperName &&
      receipt.compiledArtifacts[helperName] === build.compiledSha256 &&
      receipt.compiledArtifacts[buildName] === hash(readFileSync(buildPath)) &&
      build.sourceSha256 === hash(readFileSync(join(sourceRoot, sourceName))) &&
      typeof build.swiftVersion === 'string' &&
      /^(Apple )?Swift version [0-9]/.test(build.swiftVersion),
  );
  const parent = lstatSync(join(sourceRoot, 'dist/staging-offline-operator-auth'));
  const stat = lstatSync(helperPath);
  requireQualified(
    parent.isDirectory() &&
      parent.uid === process.getuid() &&
      !(parent.mode & 0o077) &&
      stat.isFile() &&
      stat.uid === process.getuid() &&
      stat.nlink === 1 &&
      (stat.mode & 0o777) === 0o500 &&
      realpathSync(helperPath) === helperPath &&
      Object.keys(build.fileIdentity).sort().join() ===
        ['dev', 'ino', 'uid', 'mode', 'size'].sort().join() &&
      ['dev', 'ino', 'uid', 'size'].every((key) => build.fileIdentity[key] === stat[key]) &&
      build.fileIdentity.mode === (stat.mode & 0o777) &&
      hash(readFileSync(helperPath)) === build.compiledSha256,
  );
  const after = await qualify();
  requireQualified(JSON.stringify(after) === JSON.stringify(receipt));
  return Object.freeze({ helperPath, expectedSha256: build.compiledSha256 });
}
