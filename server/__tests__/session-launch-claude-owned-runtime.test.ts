import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue } from '../async-queue.js';
import { sdkFixtureBoundary, sdkQueryPeer } from './fixtures/sdk-query-peer.js';

vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: vi.fn(),
  getSessionInfo: vi.fn(async (sessionId: string, options: { dir: string }) => ({
    sessionId,
    cwd: options.dir,
  })),
  getSessionMessages: vi.fn(async () => []),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../prompt-compare.js', () => ({ capturePromptComparison: vi.fn(async () => {}) }));
vi.mock('../auto-rename.js', async (original) => ({
  ...(await original<object>()),
  shouldAutoRename: () => false,
}));
vi.mock('../hook-bridge.js', async (original) => ({
  ...(await original<object>()),
  loadProjectHooks: vi.fn(),
}));

const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  resetOfflineUserEnvironment();
  vi.resetModules();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Offline Local Mac Claude ownership: the real launch service, launcher,
 * repository preparation, ordinary dispatcher, Claude SDK owner and chat
 * startup. Only the SDK process boundary is a protocol peer; no model runs. */
async function claudeLaunchFixture() {
  const { ownedVertexRuntimeFixture } = await import('./fixtures/owned-local-vertex-runtime.js');
  const f = await ownedVertexRuntimeFixture(cleanups, {
    chatRoute: true,
    ordinaryPreparation: true,
  });
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('External network forbidden');
    }),
  );
  const repositories = await import('../repository-workspace-runtime.js');
  vi.spyOn(repositories, 'getRepositoryWorkspaces').mockReturnValue(f.workspace);
  vi.spyOn(repositories, 'getLocalRepositoryWorkspaces').mockReturnValue(f.workspace);
  const library = await import('../agent-library-runtime.js');
  vi.spyOn(library, 'getAgentLibrary').mockReturnValue(f.library);
  const boundary = await import('../credential-sdk-boundary.js');
  vi.spyOn(boundary, 'credentialSdkBoundary').mockReturnValue({
    ...sdkFixtureBoundary(),
    credentialIsolation: true,
  } as never);
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const calls: Options[] = [];
  const inputs: unknown[] = [];
  const inputFailures: unknown[] = [];
  vi.mocked(query).mockImplementation((request) => {
    calls.push(request.options!);
    const events = new AsyncQueue<Record<string, unknown>>();
    const peer = sdkQueryPeer(
      request,
      (async function* () {
        for await (const event of events) yield event;
      })(),
    );
    const close = peer.close;
    peer.close = () => {
      events.close();
      close();
    };
    if (typeof request.prompt === 'string') throw Error('Expected guarded SDK input');
    void request.prompt[Symbol.asyncIterator]()
      .next()
      .then(
        (result) => {
          if (!result.done) inputs.push(result.value);
        },
        (error: unknown) => {
          inputFailures.push(error);
          events.close();
        },
      );
    return peer;
  });
  const chat = await import('../chat.js');
  const { SessionLaunchStore } = await import('../session-launch-store.js');
  const { SessionLaunchService } = await import('../session-launch-service.js');
  const runtime = await import('../session-launch-runtime.js');
  const store = new SessionLaunchStore(join(f.root, '.mitzo', 'events.db'));
  const port = runtime.createSessionLaunchPort();
  const service = new SessionLaunchService(store, port);
  cleanups.push(async () => {
    chat.registry.dispose();
    store.close();
    chat.eventStore.close();
  });
  const authority = {
    operatorConnectionId: f.dependencies.operatorConnectionId,
    authSessionId: f.auth.id,
    signal: f.signal.signal,
    assertCurrent: () => f.signal.signal.throwIfAborted(),
  };
  const account = f.request.runtime.account;
  const propose = (prompt = 'Write the reviewed Claude report.') => {
    const proposal = store.propose({
      operatorId: 'user',
      sourceSessionId: randomUUID(),
      requestId: randomUUID(),
      title: 'Reviewed Claude launch',
      prompt,
      configuration: {
        version: 1,
        runtime: {
          version: 1,
          account: { accountId: account.accountId, model: 'fixture-model', reasoningEffort: 'low' },
          accountReference: account,
          agentProfile: { profileId: f.agentProfile.profileId, revision: f.agentProfile.revision },
          execution: { location: 'local', targetId: 'local-mac' },
        },
        mode: 'agent',
        isolation: true,
        repositoryWorkspaceId: null,
        contextBlocks: [],
        extraTools: [],
      },
    });
    return {
      proposal,
      edits: {
        title: proposal.title,
        prompt: proposal.prompt,
        configuration: proposal.configuration,
      },
    };
  };
  return {
    f,
    chat,
    store,
    service,
    port,
    runtime,
    authority,
    calls,
    inputs,
    inputFailures,
    propose,
  };
}

it('starts an approved Claude child through the real launch path until its reviewed input reaches the SDK', async () => {
  const x = await claudeLaunchFixture();
  const { proposal, edits } = x.propose();
  const created = await x.service.approve(
    proposal.proposalId,
    'user',
    edits,
    proposal.revision,
    x.authority,
  );
  expect(created.state, created.error ?? undefined).toMatch(/created|running/);
  const childId = created.childSessionId!;
  expect(childId).toBeTruthy();
  // SDK dispatch: exactly one query, and the reviewed handover is its first input.
  await vi.waitFor(() =>
    expect({ inputs: x.inputs.length, failures: x.inputFailures }).toEqual({
      inputs: 1,
      failures: [],
    }),
  );
  expect(x.calls).toHaveLength(1);
  expect(JSON.stringify(x.inputs[0])).toContain('Write the reviewed Claude report.');
  // Repository custody, version-1 prepared receipt and SDK custody agree.
  const workspaceId = x.runtime.sessionLaunchRepositoryWorkspaceId(created.allocationId!);
  const meta = x.chat.eventStore.getSession(childId)!;
  expect(meta.repositoryWorkspaceId).toBe(workspaceId);
  expect(meta.ordinaryWorkspaceId ?? null).toBeNull();
  const receipt = x.chat.eventStore.getOrdinarySessionPreparation(created.allocationId!);
  expect(receipt).toMatchObject({
    version: 1,
    sessionId: childId,
    workspaceId,
    firstCommandId: created.commandId,
  });
  expect(x.chat.eventStore.getOrdinaryLocalVertexCustody(childId)).toMatchObject({
    sessionId: childId,
    repositoryWorkspaceId: workspaceId,
    initialCommandId: created.commandId,
  });
  expect(x.f.workspace.getForConversation(childId)).toMatchObject({
    id: workspaceId,
    state: 'claimed',
  });
  const running = await x.service.refresh(proposal.proposalId, 'user', x.authority);
  expect(running.state, running.error ?? undefined).toBe('running');
  // An exact retry is a read: no second workspace, command or SDK process.
  expect(
    await x.service.approve(proposal.proposalId, 'user', edits, proposal.revision, x.authority),
  ).toEqual(running);
  expect(x.calls).toHaveLength(1);
}, 30_000);

it('recovers an interrupted Claude startup on its original repository preparation without a replacement', async () => {
  const x = await claudeLaunchFixture();
  const { proposal, edits } = x.propose();
  const dispatcher = await import('../ordinary-scoped-command.js');
  const interruption = vi
    .spyOn(dispatcher, 'dispatchOwnedOrdinaryCommand')
    .mockRejectedValueOnce(Error('Offline interruption before dispatch'));
  const prepare = vi.spyOn(x.f.workspace, 'prepareOrdinarySession');
  const created = await x.service.approve(
    proposal.proposalId,
    'user',
    edits,
    proposal.revision,
    x.authority,
  );
  interruption.mockRestore();
  expect(created.state).toBe('uncertain');
  expect(created.childSessionId).toBeTruthy();
  expect(prepare).toHaveBeenCalledOnce();
  expect(x.calls).toHaveLength(0);
  const resumed = await x.service.resume(
    proposal.proposalId,
    'user',
    created.revision,
    x.authority,
  );
  expect(resumed.allocationId).toBe(created.allocationId);
  expect(resumed.commandId).toBe(created.commandId);
  expect(resumed.childSessionId).toBe(created.childSessionId);
  expect(prepare).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(x.inputs).toHaveLength(1));
  expect(x.calls).toHaveLength(1);
}, 30_000);
