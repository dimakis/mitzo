import { beforeEach, expect, it, vi } from 'vitest';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
const mocks = vi.hoisted(() => ({ runtime: null as unknown, approve: vi.fn() }));
vi.mock('../connections-runtime.js', () => ({ getConnectionsRuntime: () => mocks.runtime }));
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => mocks.approve,
}));
import { createGithubPublishingTool } from '../github-publishing-tool.js';
import {
  getLiveCapabilityConversationBinding,
  clearLiveCapabilityConversationBinding,
} from '../capability-conversation-binding.js';
beforeEach(() => {
  mocks.approve.mockReset();
  clearLiveCapabilityConversationBinding('conversation');
});
const input = {
  repositoryPath: '/workspace',
  baseBranch: 'main',
  title: 'Publish work',
  body: 'Change',
  draft: true,
};
function fixture(provider: string) {
  const session = {
    sessionId: 'conversation',
    cwd: '/workspace',
    mode: 'auto',
    accountBinding: { accountId: 'selected', provider, model: 'test', profileRevision: '1' },
    activeSkillPolicy: null,
  } as unknown as ManagedSession;
  const registry = {
    findBySessionId: () => ({ clientId: 'owner', session }),
    get: () => session,
  } as unknown as SessionRegistry;
  const connection = {
    id: 'github',
    revision: 1,
    templateId: 'github-readonly',
    status: 'active',
    desiredAccountIds: ['selected'],
    publicConfig: { allowedRepositories: ['example/repo'] },
  };
  const grant = { status: 'active', accountIds: ['selected'] };
  const invoke = vi.fn().mockResolvedValue({
    id: 'operation',
    status: 'succeeded',
    result: { url: 'https://github.com/example/repo/pull/1' },
  });
  mocks.runtime = {
    verifyGithubPublishingIdentity: vi.fn().mockResolvedValue(true),
    store: { list: () => [connection], get: () => connection },
    capabilityStore: { getGrant: () => grant },
    capabilities: {
      invoke,
      setGrant: vi.fn(),
      recoverPendingForConversation: vi.fn().mockResolvedValue([]),
    },
  };
  return {
    session,
    registry,
    grant,
    connection,
    invoke,
    execute: createGithubPublishingTool('conversation', registry, () => ({
      runtime: 'host',
      workspace: '/workspace',
      gitStorageRoots: [],
    })),
  };
}
it.each(['openai-codex', 'openai', 'google-vertex', 'anthropic-vertex'])(
  'binds publishing to the selected %s account and forces the shared approval pipeline',
  async (provider) => {
    const f = fixture(provider);
    expect(
      await f.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' }),
    ).toMatchObject({ isError: false });
    expect(f.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'selected',
        conversationId: 'conversation',
        connectionId: 'github',
        input: { ...input, connectionId: 'github' },
      }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(getLiveCapabilityConversationBinding('conversation')).toMatchObject({
      runtime: 'host',
      workspace: '/workspace',
    });
  },
);
it('requests a missing account grant before invoking the publisher and stops on denial', async () => {
  const f = fixture('openai');
  f.grant.accountIds = [];
  mocks.approve.mockResolvedValue({ behavior: 'deny' });
  expect(
    await f.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' }),
  ).toMatchObject({ isError: true });
  expect(mocks.approve.mock.calls[0][2]).toMatchObject({
    forcePrompt: true,
    allowSessionGrant: false,
  });
  expect(f.invoke).not.toHaveBeenCalled();
});
it('rejects an account changed during access approval', async () => {
  const f = fixture('openai');
  f.grant.accountIds = [];
  mocks.approve.mockImplementation(async (_name, value) => {
    f.session.accountBinding!.accountId = 'other';
    return { behavior: 'allow', updatedInput: value };
  });
  expect(
    await f.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' }),
  ).toMatchObject({ isError: true });
  expect(f.invoke).not.toHaveBeenCalled();
});
it('never accepts model-supplied connection or account selectors', async () => {
  const f = fixture('openai');
  expect(
    await f.execute(
      { ...input, connectionId: 'other', accountId: 'other' },
      new AbortController().signal,
      { turnId: 'turn', callId: 'call' },
    ),
  ).toMatchObject({ isError: true });
  expect(f.invoke).not.toHaveBeenCalled();
});

it('clears a host publishing binding when its runtime closes', async () => {
  const f = fixture('google-vertex');
  await f.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' });
  expect(getLiveCapabilityConversationBinding('conversation')).toBeDefined();
  f.execute.close();
  expect(getLiveCapabilityConversationBinding('conversation')).toBeUndefined();
});
it('preserves distinct native turns in operation idempotency', async () => {
  const f = fixture('openai');
  await f.execute(input, new AbortController().signal, { turnId: 'first', callId: 'same-call' });
  await f.execute(input, new AbortController().signal, { turnId: 'second', callId: 'same-call' });
  expect(f.invoke.mock.calls[0][0].idempotencyKey).not.toBe(
    f.invoke.mock.calls[1][0].idempotencyKey,
  );
});

it('reports a disabled controller publisher before requesting access or invoking it', async () => {
  const f = fixture('openai');
  (mocks.runtime as { githubPublishEnabled: boolean }).githubPublishEnabled = false;
  expect(
    await f.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' }),
  ).toMatchObject({ isError: true });
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
});

it('does not let a retired runtime clear its successor publishing binding', async () => {
  const first = fixture('openai');
  await first.execute(input, new AbortController().signal, { turnId: 'old', callId: 'call' });
  const successor = fixture('openai');
  await successor.execute(input, new AbortController().signal, { turnId: 'new', callId: 'call' });
  const current = getLiveCapabilityConversationBinding('conversation');
  first.execute.close();
  expect(getLiveCapabilityConversationBinding('conversation')).toBe(current);
  successor.execute.close();
  expect(getLiveCapabilityConversationBinding('conversation')).toBeUndefined();
});

it('does not start another publication while an earlier outcome is ambiguous', async () => {
  const f = fixture('openai');
  const capabilities = (
    mocks.runtime as { capabilities: { recoverPendingForConversation: ReturnType<typeof vi.fn> } }
  ).capabilities;
  capabilities.recoverPendingForConversation.mockResolvedValue([
    { id: 'pending-operation', status: 'verification_pending' },
  ]);
  expect(
    await f.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' }),
  ).toMatchObject({ isError: true });
  expect(f.invoke).not.toHaveBeenCalled();
});
it('rejects a different controller publishing identity before creating a grant', async () => {
  const f = fixture('google-vertex');
  f.grant.accountIds = [];
  (
    mocks.runtime as { verifyGithubPublishingIdentity: ReturnType<typeof vi.fn> }
  ).verifyGithubPublishingIdentity.mockResolvedValue(false);
  expect(
    await f.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' }),
  ).toMatchObject({ isError: true });
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
});

it.each(['revoked', 'accounts_removed'])(
  'does not restore a grant changed during approval: %s',
  async (change) => {
    const f = fixture('openai');
    f.grant.accountIds = ['other'];
    mocks.approve.mockImplementation(async (_name, value) => {
      if (change === 'revoked') f.grant.status = 'revoked';
      else f.grant.accountIds = [];
      return { behavior: 'allow', updatedInput: value };
    });
    expect(
      await f.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' }),
    ).toMatchObject({ isError: true });
    expect(
      (mocks.runtime as { capabilities: { setGrant: ReturnType<typeof vi.fn> } }).capabilities
        .setGrant,
    ).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  },
);

it('serializes recovery and publication admission across runtime instances of one conversation', async () => {
  const f = fixture('openai');
  const capabilities = (
    mocks.runtime as { capabilities: { recoverPendingForConversation: ReturnType<typeof vi.fn> } }
  ).capabilities;
  let finish!: (value: unknown[]) => void;
  capabilities.recoverPendingForConversation.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const successor = createGithubPublishingTool('conversation', f.registry, () => ({
    runtime: 'host',
    workspace: '/workspace',
    gitStorageRoots: [],
  }));
  const first = f.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'first' });
  await vi.waitFor(() => expect(capabilities.recoverPendingForConversation).toHaveBeenCalledOnce());
  try {
    expect(
      await successor(input, new AbortController().signal, { turnId: 'turn', callId: 'second' }),
    ).toMatchObject({ isError: true });
    expect(capabilities.recoverPendingForConversation).toHaveBeenCalledOnce();
    expect(f.invoke).not.toHaveBeenCalled();
  } finally {
    finish([]);
  }
  expect(await first).toMatchObject({ isError: false });
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(
    await successor(input, new AbortController().signal, { turnId: 'later', callId: 'third' }),
  ).toMatchObject({ isError: false });
});
