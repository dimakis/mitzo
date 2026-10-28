import { execFile } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { resolvePending, type ModelSession } from '@mitzo/harness';
import { preparedRepositoryDeliveryFlow } from './fixtures/prepared-repository-delivery-flow.js';
import { cleanups, git } from './fixtures/prepared-repository-native-consumer.js';
import { createConnectionsRuntime, setConnectionsRuntime } from '../connections-runtime.js';
import { closeCapabilityOperationStores } from '../capability-operation-owner.js';
import type { AdviserSessionFactory } from '../terminal-adviser.js';
import type { GithubHostCommandRunner } from '../connections/capabilities/github-publish-pr-transport.js';

const offline = vi.hoisted(() => ({ host: vi.fn(), adviser: vi.fn() }));
vi.mock('../terminal-adviser-model.js', async (original) => ({
  ...(await original<typeof import('../terminal-adviser-model.js')>()),
  createTerminalAdviserSession: offline.adviser,
}));
vi.mock('../connections/capabilities/github-publish-pr-transport.js', async (original) => {
  const actual =
    await original<typeof import('../connections/capabilities/github-publish-pr-transport.js')>();
  return {
    ...actual,
    // Keep the real safe bundle reconstruction and GitHub response validation.
    // Only the command transport can see this offline GitHub substitute.
    GitHubCliHostPublisher: class extends actual.GitHubCliHostPublisher {
      constructor() {
        super(offline.host as GithubHostCommandRunner);
      }
    },
  };
});
// Retain the individual 120-second production admission/review deadlines.
// CI custody reads took 7–12 seconds versus about 2 seconds locally; this
// envelope covers four admissions, two reviews and commit/verification work.
vi.setConfig({ testTimeout: process.env.CI ? 900_000 : 420_000 });
const execute = promisify(execFile);
const localGit = async (args: readonly string[], signal: AbortSignal) =>
  execute('/usr/bin/git', [...args], {
    signal,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/nonexistent',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });

it('commits through native host tools, reviews the exact artifact twice before publication approval, verifies the PR and accepts another prompt', async () => {
  const flow = await preparedRepositoryDeliveryFlow({ publicationFlow: true });
  // A deployed tool description changes the persisted surface of an existing
  // chat. Exercise that cold replacement in the same native publication flow.
  flow.f.native.bindThread(flow.sessionId, flow.binding, 'thread', 'pre-deploy-tools');
  const beforeColdRpc = flow.f.rpc.request.getMockImplementation()!;
  flow.f.rpc.request.mockImplementation(async (method, params?: Record<string, unknown>) => {
    if (method === 'thread/start')
      return {
        thread: { id: 'publication-after-deploy' },
        model: 'fixture-model',
        modelProvider: 'openai',
      };
    if (method === 'turn/start')
      flow.launch.mock.calls.at(-1)![2]!.onNotification('turn/started', {
        threadId: params?.threadId,
        turn: { id: `turn-${String(params?.clientUserMessageId)}` },
      });
    return beforeColdRpc(method, params);
  });
  const source = join(flow.f.root, 'source');
  const target = flow.adopted.directory;
  const base = git(source, 'rev-parse', 'main');
  const remote = join(flow.f.root, 'offline-github.git');
  // The configured hub is a Git repository in production. This fixture's hub
  // starts empty; establish its storage explicitly without adding task files.
  await localGit(
    ['init', '--quiet', '--template=', '--initial-branch=main', flow.f.root],
    flow.f.signal.signal,
  );
  expect(await realpath(join(flow.f.root, '.git'))).toBe(join(flow.f.root, '.git'));
  expect(await realpath(join(source, '.git'))).toBe(join(source, '.git'));
  await localGit(['clone', '--bare', source, remote], flow.f.signal.signal);
  // These are fixture setup references, not mutations performed by the agent.
  git(source, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
  git(source, 'update-ref', 'refs/remotes/origin/main', base);
  expect(git(target, 'remote', 'get-url', 'origin')).toBe('https://github.com/example/repo.git');
  expect(git(target, 'rev-parse', 'origin/main')).toBe(base);
  const sourceDirty = join(source, 'user-owned-unfinished.txt');
  await writeFile(sourceDirty, 'Preserve the user unfinished source work');
  await writeFile(join(target, 'task.txt'), 'Reviewed selected task change');
  await writeFile(join(target, 'user-note.txt'), 'Explicitly selected second commit');

  const order: string[] = [];
  const approvals: Array<{ toolName: unknown; toolInput: unknown; reviewCount: number }> = [];
  const reviewContexts: string[] = [];
  const reviewConfigurations: Parameters<AdviserSessionFactory>[] = [];
  offline.adviser.mockImplementation((async (config, request, owner) => {
    reviewConfigurations.push([config, request, owner]);
    expect(config.tools).toEqual([]);
    expect(request.accountId).toBe(flow.binding.accountId);
    expect(request.model).toBe('publication-model');
    expect(request.reasoningEffort).toBe('high');
    expect(config.model).toBe('publication-model');
    expect(config.reasoningEffort).toBe('high');
    expect(owner).toMatchObject({
      authSessionId: flow.f.auth.id,
      operatorConnectionId: flow.f.dependencies.operatorConnectionId,
      feature: { kind: 'github-publication' },
    });
    await config.beforeDispatch?.();
    return {
      provider: 'codex',
      async *turn(messages: Array<{ role: string; content: string }>) {
        const context = messages.map((message) => message.content).join('');
        reviewContexts.push(context);
        order.push(`review-${reviewContexts.length}`);
        expect(context).toContain('Reviewed selected task change');
        expect(context).toContain('Explicitly selected second commit');
        expect(context).not.toContain('Preserve the user unfinished source work');
        const evidence = /Evidence SHA-256: ([a-f0-9]{64})/.exec(context)!;
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
              coverageSummary: 'Offline review fixture inspected the complete supplied artifact.',
            }),
          },
        };
      },
    } as ModelSession;
  }) satisfies AdviserSessionFactory);

  let publishedHead: string | undefined;
  let createdPull: Record<string, unknown> | undefined;
  offline.host.mockImplementation((async (command, args, signal) => {
    signal.throwIfAborted();
    if (command === 'git') {
      if (args[0] === 'clone') {
        order.push('reconstruct');
        expect(args).toEqual([
          'clone',
          '--no-checkout',
          'https://github.com/example/repo.git',
          expect.any(String),
        ]);
        return localGit(
          args.map((arg) => (arg === 'https://github.com/example/repo.git' ? remote : arg)),
          signal,
        );
      }
      if (args.includes('push')) {
        order.push('push');
        expect(order).toContain('publication-approval');
        expect(reviewContexts).toHaveLength(2);
        publishedHead = git(args[1], 'rev-parse', 'HEAD');
        expect(args.slice(2)).toEqual([
          'push',
          'origin',
          `HEAD:refs/heads/${flow.adopted.featureBranch}`,
        ]);
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'ls-remote') {
        order.push('read-branch');
        return {
          stdout: `${publishedHead}\trefs/heads/${flow.adopted.featureBranch}\n`,
          stderr: '',
        };
      }
      // All remaining commands operate only on the private reconstructed clone.
      expect(args[0]).toBe('-C');
      expect(args[1]).toContain('mitzo-github-publish-');
      expect(['fetch', 'rev-parse', 'symbolic-ref']).toContain(args[2]);
      return localGit(args, signal);
    }
    expect(command).toBe('gh');
    if (args.join(' ') === 'api user')
      return { stdout: JSON.stringify({ login: 'offline-publisher' }), stderr: '' };
    const endpoint = args[3];
    const method = args[2];
    if (endpoint === 'repos/example/repo')
      return {
        stdout: JSON.stringify({ full_name: 'example/repo', default_branch: 'main' }),
        stderr: '',
      };
    if (endpoint?.startsWith('repos/example/repo/branches/'))
      return { stdout: JSON.stringify({ protected: false }), stderr: '' };
    if (endpoint === 'repos/example/repo/pulls' && method === 'GET')
      return { stdout: '[]', stderr: '' };
    if (endpoint === 'repos/example/repo/pulls' && method === 'POST') {
      order.push('create');
      expect(publishedHead).toBeDefined();
      createdPull = {
        html_url: 'https://github.com/example/repo/pull/42',
        number: 42,
        title: 'Reviewed prepared task',
        body: 'Offline complete publication flow.',
        draft: true,
        state: 'open',
        head: { ref: flow.adopted.featureBranch },
        base: { ref: 'main', repo: { full_name: 'example/repo' } },
      };
      return { stdout: JSON.stringify(createdPull), stderr: '' };
    }
    if (endpoint === 'repos/example/repo/pulls/42' && method === 'GET') {
      order.push('read-pr');
      expect(createdPull).toBeDefined();
      return { stdout: JSON.stringify(createdPull), stderr: '' };
    }
    throw Error(`Offline transport refuses unexpected GitHub operation ${JSON.stringify(args)}`);
  }) satisfies GithubHostCommandRunner);
  const runtime = createConnectionsRuntime({
    directory: join(flow.f.root, 'publication-connections'),
    cli: '/unavailable-offline-openshell',
    workspace: 'offline',
    eligibleAccountIds: () => [flow.binding.accountId],
    resolveConversationBinding: (id) => (id === flow.sessionId ? flow.binding : undefined),
    githubPublishEnabled: true,
  });
  setConnectionsRuntime(runtime);
  cleanups.push(async () => {
    // Retire an interrupted test tool call before draining its tracked service
    // operation; a failing assertion must not strand a permission wait.
    const live = flow.chat.registry.findBySessionId(flow.sessionId);
    if (live) flow.chat.registry.abort(live.clientId);
    await vi.waitFor(() => expect(flow.chat.registry.findBySessionId(flow.sessionId)).toBeFalsy());
    setConnectionsRuntime(null);
    runtime.store.close();
    await closeCapabilityOperationStores(AbortSignal.timeout(15000));
  });
  const created = runtime.store.create({
    ownerId: 'operator',
    templateId: 'github-readonly',
    templateVersion: 1,
    label: 'Offline GitHub publisher',
    endpoint: 'https://api.github.com',
    gatewayProviderName: 'offline-github-provider',
    desiredAccountIds: [flow.binding.accountId],
    publicConfig: { allowedRepositories: ['example/repo'], allowedBaseBranches: ['main'] },
  });
  const connection = runtime.store.transition(
    created.id,
    created.revision,
    {
      status: 'active',
      identity: 'offline-publisher',
      gatewayProviderId: 'offline-provider-id',
      verifiedAt: Date.now(),
    },
    { operation: 'provision', outcome: 'success', actor: 'operator' },
  );
  runtime.capabilities.setGrant({
    connectionId: connection.id,
    connectionRevision: connection.revision,
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    accountIds: [flow.binding.accountId],
    status: 'active',
  });
  runtime.capabilityStore.approveGithubRepository({
    connectionId: connection.id,
    connectionRevision: connection.revision,
    accountId: flow.binding.accountId,
    repository: 'example/repo',
  });

  flow.store.getState().selectLocalCommandSession(flow.sessionId);
  await vi.waitFor(() => expect(flow.saved()).toEqual([]));
  const warmup = 'cold-after-deploy-model-a';
  expect(
    flow.store.getState().sendLocalFirstCommand({
      ...flow.originalBody,
      sessionId: flow.sessionId,
      repositoryWorkspaceId: flow.adopted.id,
      clientMsgId: warmup,
      payload: { text: 'Continue the retained task after deployment.' },
    }),
  ).toBe(true);
  await flow.complete(warmup);
  const commandId = 'commit-review-publish';
  const followup = 'continue-after-reviewed-publication';
  const rpcErrors: string[] = [];
  const originalRpc = flow.f.rpc.request.getMockImplementation()!;
  flow.f.rpc.request.mockImplementation(
    async (method: string, params?: Record<string, unknown>) => {
      try {
        return await Reflect.apply(originalRpc, flow.f.rpc, [method, params]);
      } catch (error) {
        rpcErrors.push(
          `${method}: ${error instanceof Error ? error.message : 'offline RPC failed'}`,
        );
        throw error;
      }
    },
  );
  expect(
    flow.store.getState().sendLocalFirstCommand({
      ...flow.originalBody,
      sessionId: flow.sessionId,
      repositoryWorkspaceId: flow.adopted.id,
      clientMsgId: commandId,
      selection: { ...flow.originalBody.selection, model: 'publication-model', thinking: 'high' },
      payload: {
        text: 'Commit task.txt first, then explicitly commit user-note.txt separately. Review and publish a draft PR.',
      },
    }),
  ).toBe(true);
  await flow.waitForDispatch(commandId);
  const accepted = () =>
    flow.f.native.readNativeExecution(flow.sessionId, flow.binding, {
      id: commandId,
      attempt: 1,
    })?.phase === 'accepted';
  await vi.waitFor(
    () => {
      const terminal = ['failed', 'interrupted'].includes(
        flow.f.native.commandStatus(flow.sessionId, flow.binding, commandId) ?? '',
      );
      expect(
        accepted() ||
          terminal ||
          rpcErrors.length > 0 ||
          flow.requests.some(
            (request) => request.body.clientMsgId === commandId && request.status >= 400,
          ),
      ).toBe(true);
    },
    { timeout: 120000 },
  );
  expect(
    accepted(),
    JSON.stringify({
      rpcErrors,
      methods: flow.f.rpc.request.mock.calls.map(([method]) => method),
      requests: flow.requests.map(({ path, status }) => ({ path, status })),
      error: flow.f.events.getLatestEvent(flow.sessionId, 'error')?.payload,
    }),
  ).toBe(true);
  await flow.complete(commandId, async () => {
    const session = flow.chat.registry.findBySessionId(flow.sessionId)!.session;
    const approvalTransport = {
      isOpen: () => true,
      send(event: Record<string, unknown>) {
        if (event.type !== 'permission_request') return;
        // Assertions in a transport callback would be swallowed by its delivery
        // boundary. Retain observations and check them after actual resolution.
        approvals.push({
          toolName: event.toolName,
          toolInput: event.toolInput,
          reviewCount: reviewContexts.length,
        });
        if (event.toolName === 'ExecuteProviderCapability') {
          order.push('publication-approval');
        } else {
          order.push('commit-approval');
        }
        resolvePending(String(event.permId), 'once', undefined, flow.sessionId);
      },
    };
    session.observers.add(approvalTransport);
    cleanups.push(() => {
      session.observers.delete(approvalTransport);
    });
    const lifecycle = flow.launch.mock.calls.at(-1)![2]!;
    const call = async (name: string, callId: string, args: Record<string, unknown>) => {
      const response = (await lifecycle.onRequest(
        'item/tool/call',
        {
          threadId: flow.f.native.read(flow.sessionId, flow.binding).threadId,
          turnId: `turn-${commandId}`,
          callId,
          namespace: null,
          tool: name,
          arguments: args,
        },
        flow.f.signal.signal,
      )) as { success: boolean; contentItems: Array<{ text?: string }> };
      expect(response, JSON.stringify(response)).toMatchObject({ success: true });
      return response.contentItems.map((item) => item.text ?? '').join('');
    };
    await call('GitCommit', 'commit-selected', {
      files: ['task.txt'],
      message: 'fix: selected prepared task',
    });
    expect(git(target, 'show', '--format=', '--name-only', 'HEAD')).toBe('task.txt');
    expect(git(target, 'status', '--porcelain')).toBe('?? user-note.txt');
    expect(await readFile(join(target, 'user-note.txt'), 'utf8')).toBe(
      'Explicitly selected second commit',
    );
    await call('GitCommit', 'commit-note', {
      files: ['user-note.txt'],
      message: 'docs: explicitly include user note',
    });
    expect(git(target, 'status', '--porcelain')).toBe('');
    // A future explicit command projects A/low as the latest settings. The
    // currently invoking B/high native callback remains the review authority.
    expect(
      flow.store.getState().sendLocalFirstCommand({
        ...flow.originalBody,
        sessionId: flow.sessionId,
        repositoryWorkspaceId: flow.adopted.id,
        clientMsgId: followup,
        payload: { text: 'Continue the same task after the verified draft PR.' },
      }),
    ).toBe(true);
    const followupAdmission = await flow.waitForDispatch(followup);
    expect(followupAdmission.status, JSON.stringify(followupAdmission.body)).toBe(202);
    expect(flow.f.native.commandStatus(flow.sessionId, flow.binding, followup)).toBe('queued');
    expect(flow.chat.eventStore.getSession(flow.sessionId)).toMatchObject({
      selectedModel: flow.originalBody.selection.model,
      reasoningEffort: flow.originalBody.selection.thinking,
    });
    expect(
      flow.chat.eventStore.getOrdinaryConversationSettings(flow.sessionId)?.selection,
    ).toMatchObject({
      model: flow.originalBody.selection.model,
      thinking: flow.originalBody.selection.thinking,
    });
    expect(
      flow.f.native
        .commands(flow.sessionId, flow.binding)
        .find((command) => command.id === commandId),
    ).toMatchObject({
      status: 'running',
      model: 'publication-model',
      reasoningEffort: 'high',
    });
    const content = await call('RequestGithubPublish', 'publish-reviewed', {
      repositoryPath: target,
      baseBranch: 'main',
      title: 'Reviewed prepared task',
      body: 'Offline complete publication flow.',
      draft: true,
    });
    const receipt = JSON.parse(content);
    order.push('receipt');
    expect(receipt).toMatchObject({
      status: 'succeeded',
      result: {
        pullRequestUrl: 'https://github.com/example/repo/pull/42',
        draft: true,
        review: {
          receiptId: expect.any(String),
          evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          reports: [
            { verdict: 'approve', model: 'publication-model' },
            { verdict: 'approve', model: 'publication-model' },
          ],
        },
      },
    });
    expect(runtime.capabilityStore.get(receipt.operationId)).toMatchObject({
      status: 'succeeded',
      externalResultId: 'https://github.com/example/repo/pull/42',
    });
    expect(publishedHead).toBe(git(target, 'rev-parse', 'HEAD'));
  });
  expect(reviewConfigurations).toHaveLength(2);
  expect(flow.f.native.read(flow.sessionId, flow.binding)).toMatchObject({
    threadId: 'publication-after-deploy',
    threadGeneration: 1,
  });
  expect(
    flow.f.rpc.request.mock.calls.filter(([method]) => method === 'thread/start'),
  ).toHaveLength(1);
  expect(approvals.map((approval) => approval.toolName)).toEqual([
    'GitCommit',
    'GitCommit',
    'ExecuteProviderCapability',
  ]);
  expect(approvals[2].reviewCount).toBe(2);
  expect(approvals[2].toolInput).toContain('reviewReceiptId');
  expect(reviewConfigurations[0][0].systemPrompt).not.toBe(reviewConfigurations[1][0].systemPrompt);
  expect(order.filter((event) => event.startsWith('review-'))).toEqual(['review-1', 'review-2']);
  const approvalIndex = order.indexOf('publication-approval');
  expect(approvalIndex).toBeGreaterThan(order.indexOf('review-2'));
  for (const event of ['push', 'create', 'read-pr', 'read-branch', 'receipt'])
    expect(order.indexOf(event)).toBeGreaterThan(approvalIndex);
  expect(order.indexOf('receipt')).toBeGreaterThan(order.indexOf('read-branch'));
  expect(await readFile(sourceDirty, 'utf8')).toBe('Preserve the user unfinished source work');
  expect(git(source, 'status', '--porcelain')).toContain('user-owned-unfinished.txt');
  await flow.complete(followup);
  expect(
    flow.f.native
      .commands(flow.sessionId, flow.binding)
      .filter((command) => command.id === followup),
  ).toHaveLength(1);
  expect(await readFile(sourceDirty, 'utf8')).toBe('Preserve the user unfinished source work');
});
