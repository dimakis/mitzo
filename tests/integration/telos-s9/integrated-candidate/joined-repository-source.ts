import { vi, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { GithubRepositoryCommand } from '../../../../server/github-repository-source.js';

/** Replace only remote GitHub metadata/source and identity process effects.
 * Repository inspection/import, connection scope, authentication, private copy,
 * immutable preparation, runtime admission and native custody stay production.
 */
export async function createJoinedRepositoryEffects(root: string, accountId: string) {
  const upstream = join(root, 'synthetic-upstream');
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (...args: string[]) => execFileSync('git', args, { env, encoding: 'utf8' }).trim();
  await mkdir(upstream, { mode: 0o700 });
  git('init', '-q', '-b', 'main', upstream);
  await writeFile(join(upstream, 'task.txt'), 'Accepted synthetic repository source.\n');
  await writeFile(
    join(upstream, 'AGENTS.md'),
    '# Synthetic repository\nRetain reviewed sources.\n',
  );
  git('-C', upstream, 'add', 'task.txt', 'AGENTS.md');
  git(
    '-C',
    upstream,
    '-c',
    'user.name=Offline fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'Synthetic accepted source',
  );
  const baseOid = git('-C', upstream, 'rev-parse', 'HEAD');
  const externalCalls: Array<{ command: string; args: readonly string[] }> = [];
  const run: GithubRepositoryCommand = async (command, args, signal) => {
    signal.throwIfAborted();
    if (command === 'gh') {
      externalCalls.push({ command, args });
      expect(args.slice(0, 5)).toEqual(['api', '--hostname', 'github.com', '--method', 'GET']);
      const endpoint = args.at(-1);
      if (endpoint === 'repos/example/acceptance')
        return {
          stdout: JSON.stringify({
            full_name: 'example/acceptance',
            default_branch: 'main',
            size: 1,
            archived: false,
          }),
          stderr: '',
        };
      if (endpoint === 'repos/example/acceptance/branches/main')
        return { stdout: JSON.stringify({ name: 'main', commit: { sha: baseOid } }), stderr: '' };
      throw Error('Unexpected remote GitHub operation');
    }
    if (command !== 'git') throw Error('Only actual local Git operations are allowed');
    const actual = args.map((arg) => {
      if (args[0] === 'clone' && arg === 'https://github.com/example/acceptance.git') {
        externalCalls.push({
          command: 'remote-source-copy',
          args: ['example/acceptance', baseOid],
        });
        return upstream;
      }
      // The real importer records its canonical remote URL as local metadata.
      if (
        /https?:\/\//.test(arg) &&
        !(
          args.includes('config') &&
          args.includes('remote.origin.url') &&
          arg === 'https://github.com/example/acceptance.git'
        )
      )
        throw Error('External Git transport forbidden');
      return arg;
    });
    return { stdout: execFileSync('git', actual, { env, encoding: 'utf8' }), stderr: '' };
  };
  const { createConnectionsRuntime } = await import('../../../../server/connections-runtime.js');
  const { GitHubCliHostPublisher } =
    await import('../../../../server/connections/capabilities/github-publish-pr-transport.js');
  const identity = vi
    .spyOn(GitHubCliHostPublisher.prototype, 'identity')
    .mockImplementation(async (signal) => {
      signal.throwIfAborted();
      externalCalls.push({ command: 'github-identity', args: [] });
      return 'offline-operator';
    });
  const runtime = createConnectionsRuntime({
    directory: join(root, 'synthetic-connections'),
    eligibleAccountIds: () => [accountId],
    cli: '/nonexistent/offline-gateway-must-not-run',
    workspace: 's9-offline-repository',
    githubPublishEnabled: false,
  });
  const created = runtime.store.create({
    ownerId: 'operator',
    templateId: 'github-readonly',
    templateVersion: 1,
    label: 'Synthetic GitHub',
    endpoint: 'https://api.github.com',
    gatewayProviderName: 's9-offline-github',
    desiredAccountIds: [accountId],
    publicConfig: { allowedRepositories: ['example/acceptance'], allowedBaseBranches: ['main'] },
  });
  const connection = runtime.store.transition(
    created.id,
    created.revision,
    {
      status: 'active',
      gatewayProviderId: 'synthetic-provider',
      identity: 'offline-operator',
      verifiedAt: Date.now(),
    },
    { actor: 'operator', operation: 'provision', outcome: 'success' },
  );
  return {
    run,
    upstream,
    baseOid,
    connectionId: connection.id,
    runtime,
    externalCalls,
    async close() {
      const { closeIdleRepositoryWorkspaces } =
        await import('../../../../server/repository-workspace-runtime.js');
      closeIdleRepositoryWorkspaces();
      const { setConnectionsRuntime } = await import('../../../../server/connections-runtime.js');
      setConnectionsRuntime(null);
      runtime.closeOpenAIKeyManagement?.();
      const { closeCapabilityOperationStores } =
        await import('../../../../server/capability-operation-owner.js');
      await closeCapabilityOperationStores(new AbortController().signal);
      runtime.store.close();
      identity.mockRestore();
    },
  };
}
