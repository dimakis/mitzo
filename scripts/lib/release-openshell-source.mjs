import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

/** Read data from accepted Git blobs, never import or execute a previous release.
 * The private selector identifies its declaring release; its receipt identifies
 * an accepted ancestor. The old contract must still match the measured binary,
 * image and stack before any source-only renewal is permitted.
 */
export function readAcceptedOpenShellSource(root, selector) {
  assert.equal(realpathSync(selector), selector);
  let directory = dirname(selector);
  while (basename(directory) !== '.runtime-targets') {
    const parent = dirname(directory);
    assert.notEqual(parent, directory);
    directory = parent;
  }
  const receipt = join(dirname(directory), 'release.txt');
  const stat = lstatSync(receipt);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid());
  assert(stat.size <= 65536);
  const contents = readFileSync(receipt, 'utf8');
  const commits = [...contents.matchAll(/^source_commit=([a-f0-9]{40})$/gm)];
  const trees = [...contents.matchAll(/^source_tree=([a-f0-9]{40})$/gm)];
  assert.equal(commits.length, 1);
  assert.equal(trees.length, 1);
  const commit = commits[0][1];
  const git = (...args) =>
    execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main');
  assert.equal(git('rev-parse', `${commit}^{tree}`), trees[0][1]);
  const source = git('show', `${commit}:server/connections/reviewed-handler-artifacts.ts`);
  const revision = source.match(
    /export const reviewedConnectionsRuntimeImplementationRevision\s*=\s*'([^'\r\n]+)';/,
  );
  const entries = source.match(
    /export const reviewedHandlerSourceArtifacts = Object\.freeze\(\{([\s\S]*?)\}\);/,
  );
  assert(revision && entries);
  const pair = /'([^'\r\n]+)'\s*:\s*'([a-f0-9]{64})'/g;
  const artifacts = [...entries[1].matchAll(pair)].map((match) => [match[1], match[2]]);
  assert(artifacts.length > 0 && artifacts.length <= 10000);
  assert.equal(new Set(artifacts.map(([name]) => name)).size, artifacts.length);
  assert.equal(entries[1].replace(pair, '').replace(/[\s,]/g, ''), '');
  const codexVersion = git('show', `${commit}:docs/spikes/openshell-codex/runtime-codex-version`);
  assert(/^\d+\.\d+\.\d+$/.test(codexVersion));
  return { revision: revision[1], artifacts, codexVersion };
}

export function previousOpenShellContract(config, cliSha256, source) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'ordinary-openshell-codex-owner-v1',
        source.revision,
        [...source.artifacts].sort(([a], [b]) => a.localeCompare(b)),
        source.codexVersion,
        cliSha256,
        config.image,
        config.seedStackManifest,
      ]),
    )
    .digest('hex');
}
