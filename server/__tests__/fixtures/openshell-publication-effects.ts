import { execFile, execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, type Mock } from 'vitest';
import type { ModelSession } from '@mitzo/harness';
import type { AccountBinding } from '@mitzo/protocol';
import type { AdviserSessionFactory } from '../../terminal-adviser.js';
import type { GithubHostCommandRunner } from '../../connections/capabilities/github-publish-pr-transport.js';
import { createConnectionsRuntime, setConnectionsRuntime } from '../../connections-runtime.js';
import { closeCapabilityOperationStores } from '../../capability-operation-owner.js';

const execute = promisify(execFile);
export async function openshellPublicationEffects(input: {
  root: string;
  directory: string;
  source: string;
  account: AccountBinding;
  branch: string;
  host: Mock<GithubHostCommandRunner>;
  adviser: Mock<AdviserSessionFactory>;
}) {
  const env = {
    PATH: process.env.PATH,
    HOME: input.root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (...args: string[]) =>
    execFileSync(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      { env, encoding: 'utf8' },
    ).trim();
  const remote = join(input.root, 'github.git');
  git('clone', '--bare', input.source, remote);
  const cli = join(input.root, 'offline-openshell.mjs');
  // Replay the production transport's trusted argv against a synthetic remote
  // filesystem. Mac fixtures adapt GNU realpath spelling for the existing path;
  // physical Linux/OpenShell isolation is qualified separately.
  await writeFile(
    cli,
    `#!${process.execPath}
import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2); const split=args.indexOf('--');
if(args[0]!=='sandbox'||!args.includes('exec')||split<0) throw Error('Unexpected offline control operation');
const call=args.slice(split+1).map(value=>value==='/sandbox/workspaces/task'?${JSON.stringify(input.directory)}:value);
if(process.platform==='darwin') call[2]=call[2].replaceAll('realpath -e', 'realpath');
process.stdout.write(execFileSync(call[0],call.slice(1),{env:{PATH:process.env.PATH,HOME:${JSON.stringify(input.root)},GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'},maxBuffer:32*1024*1024}));
`,
    { mode: 0o755 },
  );
  const reviews: string[] = [];
  const order: string[] = [];
  input.adviser.mockImplementation((async (config, request) => {
    expect(request.accountId).toBe(input.account.accountId);
    expect(request.model).toBe('first');
    expect(config.tools).toEqual([]);
    await config.beforeDispatch?.();
    return {
      provider: 'codex',
      async *turn(messages) {
        const content = messages.map((message) => message.content).join('');
        expect(content).toContain('Edited inside the synthetic OpenShell task');
        reviews.push(content);
        order.push('review');
        const evidence = /Evidence SHA-256: ([a-f0-9]{64})/.exec(content)!;
        expect(evidence).not.toBeNull();
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: JSON.stringify({
              evidenceSha256: evidence[1],
              reviewedAllEvidence: true,
              verdict: 'approve',
              findings: [],
              requests: [],
              unresolvedNeeds: [],
              coverageSummary: 'Complete offline artifact evidence inspected.',
            }),
          },
        };
      },
    } as ModelSession;
  }) satisfies AdviserSessionFactory);
  let publishedHead: string | undefined;
  let pull: Record<string, unknown> | undefined;
  input.host.mockImplementation((async (command, args, signal) => {
    signal.throwIfAborted();
    if (command === 'git') {
      if (args[0] === 'clone')
        return execute(
          '/usr/bin/git',
          args.map((arg) => (arg === 'https://github.com/example/repo.git' ? remote : arg)),
          { env, signal, encoding: 'utf8' },
        );
      if (args.includes('push')) {
        expect(order).toContain('approval');
        expect(reviews).toHaveLength(2);
        publishedHead = git('-C', args[1], 'rev-parse', 'HEAD');
        order.push('push');
        return execute('/usr/bin/git', [...args], { env, signal, encoding: 'utf8' });
      }
      if (args[0] === 'ls-remote')
        return { stdout: `${publishedHead}\trefs/heads/${input.branch}\n`, stderr: '' };
      expect(args[0]).toBe('-C');
      return execute('/usr/bin/git', [...args], { env, signal, encoding: 'utf8' });
    }
    expect(command).toBe('gh');
    if (args.join(' ') === 'api user')
      return { stdout: '{"login":"offline-publisher"}', stderr: '' };
    const endpoint = args[3],
      method = args[2];
    if (endpoint === 'repos/example/repo')
      return { stdout: '{"full_name":"example/repo","default_branch":"main"}', stderr: '' };
    if (endpoint?.startsWith('repos/example/repo/branches/'))
      return { stdout: '{"protected":false}', stderr: '' };
    if (endpoint === 'repos/example/repo/pulls' && method === 'GET')
      return { stdout: '[]', stderr: '' };
    if (endpoint === 'repos/example/repo/pulls' && method === 'POST') {
      order.push('create');
      pull = {
        html_url: 'https://github.com/example/repo/pull/42',
        number: 42,
        title: 'OpenShell reviewed task',
        body: 'Offline OpenShell publication.',
        draft: true,
        state: 'open',
        head: { ref: input.branch },
        base: { ref: 'main', repo: { full_name: 'example/repo' } },
      };
      return { stdout: JSON.stringify(pull), stderr: '' };
    }
    if (endpoint === 'repos/example/repo/pulls/42' && method === 'GET')
      return { stdout: JSON.stringify(pull), stderr: '' };
    throw Error('Unexpected offline GitHub effect');
  }) satisfies GithubHostCommandRunner);
  const runtime = createConnectionsRuntime({
    directory: join(input.root, 'connections'),
    cli,
    workspace: 'workspace',
    eligibleAccountIds: () => [input.account.accountId],
    resolveConversationBinding: (id) => (id === 'session' ? input.account : undefined),
    githubPublishEnabled: true,
  });
  setConnectionsRuntime(runtime);
  const created = runtime.store.create({
    ownerId: 'operator',
    templateId: 'github-readonly',
    templateVersion: 1,
    label: 'Offline',
    endpoint: 'https://api.github.com',
    gatewayProviderName: 'offline-github',
    desiredAccountIds: [input.account.accountId],
    publicConfig: { allowedRepositories: ['example/repo'], allowedBaseBranches: ['main'] },
  });
  const connection = runtime.store.transition(
    created.id,
    created.revision,
    {
      status: 'active',
      identity: 'offline-publisher',
      gatewayProviderId: 'offline-provider',
      verifiedAt: Date.now(),
    },
    { operation: 'provision', outcome: 'success', actor: 'operator' },
  );
  runtime.capabilities.setGrant({
    connectionId: connection.id,
    connectionRevision: connection.revision,
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    accountIds: [input.account.accountId],
    status: 'active',
  });
  runtime.capabilityStore.approveGithubRepository({
    connectionId: connection.id,
    connectionRevision: connection.revision,
    accountId: input.account.accountId,
    repository: 'example/repo',
  });
  return {
    runtime,
    reviews,
    order,
    cli,
    git,
    remote,
    publishedHead: () => publishedHead,
    async close() {
      setConnectionsRuntime(null);
      runtime.store.close();
      await closeCapabilityOperationStores(AbortSignal.timeout(15000));
    },
  };
}
