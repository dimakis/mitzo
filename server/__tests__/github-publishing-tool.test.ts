import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
const mocks = vi.hoisted(() => ({
  runtime: null as unknown,
  approve: vi.fn(),
  captureAuthorization: vi.fn(),
}));
vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: mocks.captureAuthorization,
}));
vi.mock('../connections-runtime.js', () => ({ getConnectionsRuntime: () => mocks.runtime }));
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => mocks.approve,
}));
import {
  captureGithubPublicationReviewOwner,
  createGithubPublishingTool,
  requestOperatorGithubPublication,
} from '../github-publishing-tool.js';
import {
  getLiveCapabilityConversationBinding,
  clearLiveCapabilityConversationBinding,
} from '../capability-conversation-binding.js';
import {
  authenticateToken,
  isAuthSessionCurrent,
  login,
  revokeAuthSession,
  type AuthSession,
} from '../auth.js';
const signedSessions: AuthSession[] = [];
afterEach(() => signedSessions.splice(0).forEach(revokeAuthSession));
beforeEach(() => {
  mocks.approve.mockReset();
  mocks.captureAuthorization.mockReset();
  clearLiveCapabilityConversationBinding('conversation');
});
const input = {
  repositoryPath: '/workspace',
  baseBranch: 'main',
  title: 'Publish work',
  body: 'Change',
  draft: true,
};
it('captures only the original authenticated live publisher and pins its inference selection', async () => {
  const f = fixture('openai');
  f.session.ownerConnectionId = 'signed-operator';
  f.session.ownedLocalAuthSessionId = 'auth';
  f.session.model = 'selected-model';
  const assertAuthorization = vi.fn();
  mocks.captureAuthorization.mockReturnValue({
    auth: { id: 'auth' },
    assertCurrent: assertAuthorization,
  });
  const owner = captureGithubPublicationReviewOwner('conversation');
  expect(owner).toMatchObject({
    authSessionId: 'auth',
    operatorConnectionId: 'signed-operator',
    model: 'selected-model',
    binding: f.session.accountBinding,
  });
  await expect(owner.assertCurrent()).resolves.toBeUndefined();
  f.session.model = 'replacement-model';
  await expect(owner.assertCurrent()).rejects.toThrow();
  f.execute.close();
});
it('captures the exact active native publication selection and refuses a different turn or expired callback', async () => {
  const f = fixture('openai');
  f.session.ownerConnectionId = 'signed-operator';
  f.session.model = 'startup-model';
  mocks.captureAuthorization.mockReturnValue({ auth: { id: 'auth' }, assertCurrent: vi.fn() });
  let current = true;
  const assertCurrentSync = () => {
    if (!current) throw Error('Original command expired');
  };
  const call = { turnId: 'current-turn', callId: 'publish' };
  Object.defineProperty(call, 'captureInferenceSelection', {
    value: () => {
      assertCurrentSync();
      return Object.freeze({
        commandId: 'current-command',
        model: 'active-model',
        reasoningEffort: 'high',
        assertCurrentSync,
      });
    },
  });
  let captured: ReturnType<typeof captureGithubPublicationReviewOwner> | undefined;
  f.invoke.mockImplementation(async () => {
    expect(() => captureGithubPublicationReviewOwner('conversation', 'future-turn')).toThrow();
    captured = captureGithubPublicationReviewOwner('conversation', 'current-turn');
    expect(captured).toMatchObject({ model: 'active-model', reasoningEffort: 'high' });
    f.session.model = 'queued-future-model';
    await expect(captured.assertCurrent()).resolves.toBeUndefined();
    current = false;
    expect(() => captured!.assertCurrentSync()).toThrow('expired');
    return { id: 'operation', status: 'succeeded' };
  });
  try {
    expect(await f.execute(input, new AbortController().signal, call)).toMatchObject({
      isError: false,
    });
    expect(captured).toBeDefined();
    expect(() => captureGithubPublicationReviewOwner('conversation', 'current-turn')).toThrow();
  } finally {
    f.execute.close();
  }
});
it('requires a private native selection while explicit operator requests use their separately selected current settings', async () => {
  const settings = { model: 'operator-current-model', reasoningEffort: 'high' };
  const f = fixture('openai', {
    requireNativeSelection: true,
    explicitSelection: () => ({ ...settings }),
  });
  f.session.ownerConnectionId = 'signed-operator';
  mocks.captureAuthorization.mockReturnValue({ auth: { id: 'auth' }, assertCurrent: vi.fn() });
  try {
    const refused = await f.execute(input, new AbortController().signal, {
      turnId: 'native-without-selection',
      callId: 'native',
    });
    expect(refused).toMatchObject({ isError: true });
    expect(JSON.parse(refused.content)).toMatchObject({
      code: 'PUBLICATION_REVIEW_UNAVAILABLE',
      operationRecorded: false,
    });
    expect(f.invoke).not.toHaveBeenCalled();
    f.invoke.mockImplementation(async (operation) => {
      const owner = captureGithubPublicationReviewOwner('conversation', operation.turnId);
      expect(owner).toMatchObject(settings);
      settings.model = 'changed-manual-selection';
      expect(() => owner.assertCurrentSync()).toThrow('changed');
      return { id: 'operator-operation', status: 'succeeded' };
    });
    expect(
      await requestOperatorGithubPublication(
        'conversation',
        f.registry,
        input,
        new AbortController().signal,
      ),
    ).toMatchObject({ isError: false });
    expect(f.invoke).toHaveBeenCalledOnce();
  } finally {
    f.execute.close();
  }
});
it('returns a bounded unavailable result when explicit operator selection is unavailable', async () => {
  const f = fixture('openai', {
    requireNativeSelection: true,
    explicitSelection: () => {
      throw Error('Private settings unavailable');
    },
  });
  try {
    const result = await requestOperatorGithubPublication(
      'conversation',
      f.registry,
      input,
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      code: 'PUBLICATION_REVIEW_UNAVAILABLE',
      operationRecorded: false,
    });
    expect(result.content).not.toContain('Private settings');
    expect(f.invoke).not.toHaveBeenCalled();
  } finally {
    f.execute.close();
  }
});
it('refuses another operator and expires review ownership with the publishing runtime', async () => {
  const f = fixture('openai');
  f.session.ownerConnectionId = 'signed-operator';
  f.session.ownedLocalAuthSessionId = 'original-auth';
  mocks.captureAuthorization.mockReturnValue({
    auth: { id: 'other-auth' },
    assertCurrent: vi.fn(),
  });
  expect(() => captureGithubPublicationReviewOwner('conversation')).toThrow();
  mocks.captureAuthorization.mockReturnValue({
    auth: { id: 'original-auth' },
    assertCurrent: vi.fn(),
  });
  const owner = captureGithubPublicationReviewOwner('conversation');
  f.execute.close();
  await expect(owner.assertCurrent()).rejects.toThrow();
});
it('accepts a renewed verified operator without rewriting creator provenance and fences review revocation', async () => {
  const signedIn = async () => {
    const token = await login(process.env.AUTH_PASSPHRASE!);
    const session = await authenticateToken(token!);
    if (!session) throw Error('Offline signed operator required');
    signedSessions.push(session);
    return session;
  };
  const original = await signedIn(),
    renewed = await signedIn();
  expect(renewed.id).not.toBe(original.id);
  const f = fixture('openai');
  try {
    f.session.ownerConnectionId = 'renewed-signed-operator';
    f.session.ownedLocalAuthSessionId = original.id;
    mocks.captureAuthorization.mockReturnValue({
      auth: renewed,
      assertCurrent: () => {
        if (!isAuthSessionCurrent(renewed)) throw Error('Original reviewer login revoked');
      },
    });
    const owner = captureGithubPublicationReviewOwner('conversation');
    expect(owner.authSessionId).toBe(renewed.id);
    expect(f.session.ownedLocalAuthSessionId).toBe(original.id);
    await expect(owner.assertCurrent()).resolves.toBeUndefined();
    revokeAuthSession(renewed);
    expect(() => owner.assertCurrentSync()).toThrow('revoked');
    await expect(owner.assertCurrent()).rejects.toThrow('revoked');
  } finally {
    f.execute.close();
  }
});
it('explains rejected publishing fields and accepts a corrected retry without weakening bounds', async () => {
  const f = fixture('openai');
  const result = await f.execute(
    { ...input, body: 'x'.repeat(513) },
    new AbortController().signal,
    { turnId: 'turn', callId: 'invalid' },
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain('body');
  expect(result.content).toContain('512');
  expect(f.invoke).not.toHaveBeenCalled();
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(
    await f.execute({ ...input, body: 'x'.repeat(512) }, new AbortController().signal, {
      turnId: 'turn',
      callId: 'corrected',
    }),
  ).toMatchObject({ isError: false });
});
function fixture(provider: string, inference?: Parameters<typeof createGithubPublishingTool>[5]) {
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
    resolveGithubPublishingRepository: vi.fn().mockResolvedValue('example/repo'),
    store: { list: () => [connection], get: () => connection },
    capabilityStore: {
      getGrant: () => grant,
      hasGithubRepositoryAccess: vi.fn().mockReturnValue(true),
      approveGithubRepository: vi.fn(),
    },
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
    execute: createGithubPublishingTool(
      'conversation',
      registry,
      () => ({
        runtime: 'host',
        workspace: '/workspace',
        gitStorageRoots: [],
      }),
      undefined,
      undefined,
      inference,
    ),
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
    rememberSessionGrant: false,
    approvalScope: 'session',
    sessionGrantDescription: expect.stringContaining('example/repo'),
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

it('selects the connection matching the actual repository among multiple repo-scoped connections', async () => {
  const f = fixture('openai');
  const runtime = mocks.runtime as { store: { list: () => unknown[] } };
  runtime.store.list = () => [
    { ...f.connection, id: 'other', publicConfig: { allowedRepositories: ['example/other'] } },
    f.connection,
  ];
  expect(
    await f.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' }),
  ).toMatchObject({ isError: false });
  expect(f.invoke.mock.calls[0][0].connectionId).toBe('github');
});
it('asks for exactly one repository even when the connection already grants other repositories', async () => {
  const f = fixture('openai');
  f.connection.publicConfig.allowedRepositories.push('example/other');
  const runtime = mocks.runtime as {
    capabilityStore: {
      hasGithubRepositoryAccess: ReturnType<typeof vi.fn>;
      approveGithubRepository: ReturnType<typeof vi.fn>;
    };
  };
  runtime.capabilityStore.hasGithubRepositoryAccess.mockReturnValue(false);
  runtime.capabilityStore.approveGithubRepository.mockImplementation(() =>
    runtime.capabilityStore.hasGithubRepositoryAccess.mockReturnValue(true),
  );
  mocks.approve.mockImplementation(async (_name, value) => ({
    behavior: 'allow',
    updatedInput: value,
  }));
  expect(
    await f.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' }),
  ).toMatchObject({ isError: false });
  expect(mocks.approve.mock.calls[0][1]).toMatchObject({
    repository: 'example/repo',
    accountId: 'selected',
  });
  expect(mocks.approve.mock.calls[0][1]).not.toHaveProperty('allowedRepositories');
  expect(runtime.capabilityStore.approveGithubRepository).toHaveBeenCalledWith({
    connectionId: 'github',
    connectionRevision: 1,
    accountId: 'selected',
    repository: 'example/repo',
  });
});
it('rejects a changed repository after access approval without recording consent or publishing', async () => {
  const f = fixture('openai');
  const runtime = mocks.runtime as {
    resolveGithubPublishingRepository: ReturnType<typeof vi.fn>;
    capabilityStore: {
      hasGithubRepositoryAccess: ReturnType<typeof vi.fn>;
      approveGithubRepository: ReturnType<typeof vi.fn>;
    };
  };
  runtime.capabilityStore.hasGithubRepositoryAccess.mockReturnValue(false);
  mocks.approve.mockImplementation(async (_name, value) => {
    runtime.resolveGithubPublishingRepository.mockResolvedValue('example/other');
    return { behavior: 'allow', updatedInput: value };
  });
  expect(
    await f.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' }),
  ).toMatchObject({ isError: true });
  expect(f.invoke).not.toHaveBeenCalled();
  expect(runtime.capabilityStore.approveGithubRepository).not.toHaveBeenCalled();
});
it('reports a safe source-resolution failure without inventing a recorded operation', async () => {
  const { GithubSeedPublicationError } = await import('../github-seeded-source.js');
  const f = fixture('openai-codex');
  const runtime = mocks.runtime as { resolveGithubPublishingRepository: ReturnType<typeof vi.fn> };
  runtime.resolveGithubPublishingRepository.mockRejectedValue(
    new GithubSeedPublicationError('SEEDED_BASELINE_REQUIRED', 'Bearer SECRET_TOKEN'),
  );
  const result = await f.execute(input, new AbortController().signal, {
    turnId: 'turn',
    callId: 'call',
  });
  const detail = JSON.parse(result.content);
  expect(detail).toMatchObject({
    stage: 'repository_resolution',
    code: 'SEEDED_BASELINE_REQUIRED',
    operationRecorded: false,
  });
  expect(result.content).not.toContain('SECRET_TOKEN');
  expect(f.invoke).not.toHaveBeenCalled();
});
it('operator publication uses the existing live tool and forced approval, and closes with its runtime', async () => {
  const { requestOperatorGithubPublication } = await import('../github-publishing-tool.js');
  const f = fixture('openai-codex');
  expect(
    await requestOperatorGithubPublication(
      'conversation',
      f.registry,
      input,
      new AbortController().signal,
    ),
  ).toMatchObject({ isError: false });
  expect(f.invoke).toHaveBeenCalled();
  f.execute.close();
  await expect(
    requestOperatorGithubPublication(
      'conversation',
      f.registry,
      input,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/live/);
});
it('does not let an operator use a superseded account or a closed runtime', async () => {
  const { requestOperatorGithubPublication } = await import('../github-publishing-tool.js');
  const f = fixture('openai-codex');
  const binding = f.session.accountBinding!;
  f.session.accountBinding = { ...binding, accountId: 'replacement' };
  await expect(
    requestOperatorGithubPublication(
      'conversation',
      f.registry,
      input,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/changed/);
  f.session.accountBinding = binding;
  f.execute.close();
  expect(
    await f.execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' }),
  ).toMatchObject({ isError: true });
  expect(f.invoke).not.toHaveBeenCalled();
});
it('follows a newly assigned SDK conversation ID while retaining its original session and account', async () => {
  const { requestOperatorGithubPublication } = await import('../github-publishing-tool.js');
  const f = fixture('anthropic-vertex');
  f.execute.close();
  let conversationId = '';
  f.session.sessionId = undefined;
  f.registry.findBySessionId = ((id: string) =>
    conversationId && id === conversationId
      ? { clientId: 'owner', session: f.session }
      : undefined) as SessionRegistry['findBySessionId'];
  const execute = createGithubPublishingTool(
    () => conversationId,
    f.registry,
    () => ({ runtime: 'host', workspace: '/workspace', gitStorageRoots: [] }),
    f.session,
  );
  await expect(
    requestOperatorGithubPublication(
      'resolved-sdk',
      f.registry,
      input,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/live/);
  conversationId = 'resolved-sdk';
  f.session.sessionId = conversationId;
  expect(
    await requestOperatorGithubPublication(
      conversationId,
      f.registry,
      input,
      new AbortController().signal,
    ),
  ).toMatchObject({ isError: false });
  expect(f.invoke).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId }),
    expect.any(AbortSignal),
    expect.any(Function),
  );
  f.session.accountBinding = { ...f.session.accountBinding!, accountId: 'replacement' };
  await expect(
    requestOperatorGithubPublication(
      conversationId,
      f.registry,
      input,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/changed/);
  execute.close();
  await expect(
    requestOperatorGithubPublication(
      conversationId,
      f.registry,
      input,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/live/);
});
it('does not restore a superseded publisher when its replacement closes', async () => {
  const { requestOperatorGithubPublication } = await import('../github-publishing-tool.js');
  const f = fixture('openai');
  const replacement = createGithubPublishingTool(
    'conversation',
    f.registry,
    () => ({ runtime: 'host', workspace: '/workspace', gitStorageRoots: [] }),
    f.session,
  );
  replacement.close();
  await expect(
    requestOperatorGithubPublication(
      'conversation',
      f.registry,
      input,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/live/);
  f.execute.close();
});

it('refuses account grant and publication after owned authority changes during approval', async () => {
  const f = fixture('openai-codex');
  f.grant.accountIds = ['other'];
  let revoked = false;
  const assertCurrent = vi.fn(async () => {
    if (revoked) throw Error('Owned authority revoked');
  });
  mocks.approve.mockImplementation(async (_name, value) => {
    revoked = true;
    return { behavior: 'allow', updatedInput: value };
  });
  const source = { runtime: 'host' as const, workspace: '/workspace', gitStorageRoots: [] };
  const execute = createGithubPublishingTool(
    'conversation',
    f.registry,
    () => source,
    undefined,
    assertCurrent,
  );
  expect(
    await execute(input, new AbortController().signal, { turnId: 'turn', callId: 'call' }),
  ).toMatchObject({ isError: true });
  expect(f.invoke).not.toHaveBeenCalled();
  expect(
    (mocks.runtime as { capabilities: { setGrant: ReturnType<typeof vi.fn> } }).capabilities
      .setGrant,
  ).not.toHaveBeenCalled();
  expect(source.workspace).toBe(f.session.cwd);
  execute.close();
});
