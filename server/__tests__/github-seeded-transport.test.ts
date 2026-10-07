import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { OpenShellGithubSandboxTransport } from '../connections/capabilities/github-publish-pr-transport.js';
let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it('reads and exports an origin-free seeded task without altering its Git repository', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-seed-transport-')));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  git('init', '-q', '-b', 'task');
  await writeFile(join(root, 'note.txt'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'seed');
  const tree = git('rev-parse', 'HEAD^{tree}');
  await writeFile(join(root, 'note.txt'), 'change\n');
  git('commit', '-qam', 'change');
  const original = git('rev-parse', 'HEAD');
  const transport = new OpenShellGithubSandboxTransport(
    async (args) => {
      const start = args.indexOf('/bin/sh');
      const values = args
        .slice(start + 1)
        .map((v) => (v === '/sandbox/workspaces/mgmt' ? root : v));
      return execFileSync('/bin/sh', values, { encoding: 'utf8' });
    },
    'default',
    '/sandbox/workspaces/mgmt',
  );
  const input = {
    sandboxName: 'retained',
    repositoryPath: '/sandbox/workspaces/mgmt',
    signal: new AbortController().signal,
  };
  expect(await transport.origin({ ...input, allowMissing: true })).toBe('');
  const state = await transport.inspectSeed(input);
  expect(state.seedTreeOid).toBe(tree);
  expect(state.originalSourceOid).toBe(original);
  expect(state.commitsAhead).toBe(1);
  const patch = await transport.exportSeedPatch({ ...input, ...state });
  expect(patch.toString()).toContain('+change');
  expect(git('rev-parse', 'HEAD')).toBe(original);
  expect(git('status', '--short')).toBe('');
});
