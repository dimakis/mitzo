import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { vi } from 'vitest';
import { setConnectionsRuntime } from '../../connections-runtime.js';
import {
  getRepositoryWorkspaces,
  closeIdleRepositoryWorkspaces,
} from '../../repository-workspace-runtime.js';
import type { GithubRepositoryCommand } from '../../github-repository-source.js';
import type { enrolledResponsesOwnerFixture } from './enrolled-responses-owner.js';

const exec = promisify(execFile);

/** Actual canonical repository owner and importer. Only remote metadata and the
 * clone's remote endpoint are replaced; all Git inspection/checkout runs locally.
 */
export async function enrolledRepositorySourceFixture(
  f: Awaited<ReturnType<typeof enrolledResponsesOwnerFixture>>,
  cleanups: Array<() => void | Promise<void>>,
) {
  const upstream = join(f.root, 'offline-upstream');
  await mkdir(upstream);
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: f.root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'credential.helper',
    GIT_CONFIG_VALUE_2: '',
  };
  const git = (args: readonly string[], signal: AbortSignal) =>
    exec('git', [...args], { env, signal, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  const signal = AbortSignal.timeout(15000);
  await git(['init', '--initial-branch=main', '--template=', upstream], signal);
  await writeFile(join(upstream, 'README.md'), '# Offline source\nActual imported bytes.\n');
  await git(['-C', upstream, 'add', 'README.md'], signal);
  await git(
    [
      '-C',
      upstream,
      '-c',
      'user.name=Offline fixture',
      '-c',
      'user.email=fixture@invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Offline source',
    ],
    signal,
  );
  const baseOid = (await git(['-C', upstream, 'rev-parse', 'HEAD'], signal)).stdout.trim();
  const connection = await f.runtime.service.createAndProvision(
    {
      ownerId: 'operator',
      templateId: 'github-readonly',
      templateVersion: 1,
      label: 'Offline repository source',
      fields: { allowedRepositories: ['example/source'], allowedBaseBranches: ['main'] },
      desiredAccountIds: [f.binding.accountId],
      gateway: f.runtime.gateway,
      workspace: f.runtime.workspace,
    },
    { token: 'SYNTHETIC_OFFLINE_GITHUB_TOKEN' },
    signal,
  );
  const commands: string[][] = [];
  const externalCommand: GithubRepositoryCommand = async (command, args, requestSignal) => {
    requestSignal.throwIfAborted();
    commands.push([command, ...args]);
    if (command === 'gh') {
      const prefix = ['api', '--hostname', 'github.com', '--method', 'GET'];
      if (JSON.stringify(args.slice(0, 5)) !== JSON.stringify(prefix) || args.length !== 6)
        throw Error('Unexpected offline repository metadata request');
      if (args[5] === 'repos/example/source')
        return {
          stdout: JSON.stringify({
            full_name: 'example/source',
            default_branch: 'main',
            size: 1,
            archived: false,
          }),
          stderr: '',
        };
      if (args[5] === 'repos/example/source/branches/main')
        return { stdout: JSON.stringify({ name: 'main', commit: { sha: baseOid } }), stderr: '' };
      throw Error('Unexpected offline repository metadata endpoint');
    }
    if (command !== 'git') throw Error('Unexpected offline repository command');
    if (args[0] === 'clone') {
      if (
        JSON.stringify(args.slice(0, 7)) !==
          JSON.stringify([
            'clone',
            '--bare',
            '--no-hardlinks',
            '--single-branch',
            '--template=',
            '--branch=main',
            'https://github.com/example/source.git',
          ]) ||
        args.length !== 8 ||
        !args[7]!.startsWith(join(f.root, 'private', 'repository-sources') + '/')
      )
        throw Error('Unexpected offline repository clone');
      return git([...args.slice(0, 6), upstream, args[7]!], requestSignal);
    }
    if (!args[0]?.startsWith('--git-dir=' + join(f.root, 'private', 'repository-sources') + '/'))
      throw Error('Unexpected offline repository Git owner');
    return git(args, requestSignal);
  };
  vi.stubEnv('MITZO_REPOSITORY_WORKSPACES_ENABLED', '1');
  setConnectionsRuntime(f.runtime);
  cleanups.push(() => setConnectionsRuntime(null));
  const owner = getRepositoryWorkspaces(false, externalCommand);
  cleanups.push(() => closeIdleRepositoryWorkspaces());
  const preview = await owner.preview(f.binding, connection.id, 'example/source', signal);
  const workspace = await owner.prepare(preview.id, f.binding, signal);
  return { owner, workspace, preview, connection, baseOid, commands };
}
