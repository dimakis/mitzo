import { createHash } from 'node:crypto';
import { AccountBindingSchema } from '@mitzo/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { AccountProfiles } from '../account-profiles.js';
import { OwnedLocalCodexChatAdmission } from '../owned-local-codex-chat-admission.js';
import { OwnedCodexLifecycleBridge } from '../owned-codex-lifecycle-bridge.js';
import { performPreparedRepositoryPrimaryTransition } from '../owned-prepared-repository-transition.js';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';
import { preparedRepositoryResultSha256 } from '../codex-conversation-store.js';
import type { FrozenHostCodexBootstrapLease } from '../frozen-host-codex-bootstrap.js';
import type { OrdinaryLocalCodexAdmissionExpectation } from '../ordinary-local-codex-admission.js';
function fixture() {
  const store = new EventStore(':memory:');
  const accounts = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal',
        provider: 'openai-codex',
        credentialRef: '/offline/login',
        email: 'person@example.test',
        planType: 'plus',
        models: [{ id: 'fixture-model', label: 'Fixture' }],
      },
    ],
    { codexEnabled: true },
  );
  const binding = AccountBindingSchema.parse(accounts.resolve('personal', 'fixture-model')),
    profile = accounts.codexProfile(binding);
  const runtime = {
    version: 2 as const,
    account: {
      accountId: binding.accountId,
      provider: binding.provider,
      profileRevision: binding.profileRevision,
    },
    harness: { implementation: 'codex' as const },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target' },
  };
  const selection = {
    version: 1 as const,
    agent: { profileId: 'agent', revision: 1 },
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'agent' as const, revision: 0 },
    model: 'fixture-model',
    thinking: null,
  };
  const definition = {
    name: 'Agent',
    descriptor: 'Test',
    role: 'agent' as const,
    instructions: 'Offline',
    expectedOutput: 'Evidence',
    acceptanceCriteria: ['Use evidence'],
    modelPolicyRole: 'agent' as const,
  };
  const agentProfile = {
    profileId: 'agent',
    revision: 1,
    definition,
    contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
  };
  const expected = {
    binding: runtime,
    hostId: 'host',
    runtimeContractRevision: 'runtime',
    capabilityRevision: 'cap',
    workspace: { workspaceId: 'workspace', cwd: '/offline/workspace' },
    selection,
    agentProfile,
  } as OrdinaryLocalCodexAdmissionExpectation;
  store.admitOrdinaryLocalCommand(
    {
      sessionId: 'session',
      accountBinding: binding,
      cwd: '/offline/workspace',
      repositoryWorkspaceId: 'workspace',
      selectedModel: 'fixture-model',
      reasoningEffort: null,
      mode: 'agent',
      agentProfile,
    },
    runtime,
    {
      clientMsgId: 'command',
      requestFingerprint: 'fingerprint',
      selection,
      payload: {
        text: 'Frozen prepared prompt',
        systemPrompt: 'Frozen developer instructions',
        intent: 'Original intent',
        images: [{ data: 'fixture', mediaType: 'image/png' }],
      },
    },
  );
  const lease = {
    client: { initialize: vi.fn(), request: vi.fn(), close: vi.fn() },
    binding,
    profile,
    privateHome: '/private/fixture-home',
    executableSha256: 'a'.repeat(64),
    assertCurrent: vi.fn(async () => {}),
    assertCurrentSync: vi.fn(),
    close: vi.fn(),
  } as FrozenHostCodexBootstrapLease;
  const bridge = new OwnedCodexLifecycleBridge(() => lease);
  const input = {
    eventStore: store,
    sessionId: 'session',
    commandId: 'command',
    expected,
    lease,
    bridge,
  };
  const options = {
    conversationId: 'session',
    messageId: 'command',
    binding,
    profile,
    session: { cwd: '/offline/workspace', mode: 'agent' as const },
    model: 'fixture-model',
    reasoningEffort: null,
    prompt: 'Frozen prepared prompt',
    systemPrompt: 'Frozen developer instructions',
    intent: 'Original intent',
    images: [{ data: 'fixture', mediaType: 'image/png' }],
    agentProfile,
    repositoryWorkspace: { id: 'workspace', directory: '/offline/workspace', sandbox: false },
  };
  return { store, input, options, lease, runtime, binding, selection, agentProfile };
}

function preparedOperationFixture() {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'mitzo-prepared-operation-'));
  const native = new CodexConversationStore(join(root, 'native.db'));
  f.store.claimOrdinaryLocalCommandDispatch('command');
  const admission = OwnedLocalCodexChatAdmission.capture(f.input);
  admission.assertOptions(f.options);
  f.store.completeOrdinaryLocalCommand('command');
  native.create('session', f.binding, f.options.session.cwd);
  native.bindThread('session', f.binding, 'thread');
  native.enqueue('session', f.binding, {
    id: 'command',
    prompt: f.options.prompt,
    intent: f.options.intent,
  });
  const command = native.claimNext('session', f.binding)!;
  native.prepareNativeExecution(
    'session',
    f.binding,
    command,
    'thread',
    codexNativeExecutionPolicy({
      bindingRevision: 'selected',
      mode: 'agent',
      cwd: f.options.session.cwd,
      readableRoots: ['/offline'],
      writableRoots: [f.options.session.cwd],
      deniedRoots: ['/credentials'],
      writeProtectedRoots: [],
    }),
  );
  native.recordNativeTurnAck('session', f.binding, command, 'thread', 'turn');
  native.acceptNativeExecution('session', f.binding, command, 'thread', 'turn');
  const identity = {
    turnId: 'turn',
    toolName: 'PrepareLocalRepository',
    requestHash: 'a'.repeat(64),
  };
  const result = { content: 'Prepared original task', isError: false };
  native.claimTool('session', f.binding, 'command', 'prepare', identity);
  native.recordToolResult('session', f.binding, 'command', 'prepare', identity, result);
  native.finish('session', f.binding, 'command', 'completed', 'turn');
  const freeze = <T>(value: T): T => {
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) freeze(item);
      Object.freeze(value);
    }
    return value;
  };
  const facts = freeze({
    version: 'prepared-repository-transition-v1' as const,
    request: {
      id: '34af2bdf-5fb4-4de0-b083-cf188163d891',
      binding: f.binding,
      conversationId: 'session',
      runtimeId: 'runtime',
      runtimeBinding: f.runtime,
      nativeTarget: {
        commandId: 'command',
        attempt: 1,
        threadId: 'thread',
        turnId: 'turn',
        generation: 0,
      },
      prepareCallId: 'prepare',
      requestHash: identity.requestHash,
      taskRoot: '/offline',
    },
    oldWorkspace: { kind: 'repository' as const, id: 'workspace', directory: '/offline/workspace' },
    newWorkspace: {
      kind: 'repository' as const,
      id: 'prepared',
      directory: '/offline/prepared',
      featureBranch: 'task/branch',
      baseOid: 'b'.repeat(40),
      taskIdentity: {
        directory: '/offline/prepared',
        featureBranch: 'task/branch',
        root: { dev: 1, ino: 2 },
        git: { dev: 1, ino: 3 },
      },
    },
    consumedScopeSha256: 'c'.repeat(64),
    materializedRecordSha256: 'd'.repeat(64),
    resultSha256: preparedRepositoryResultSha256(result),
  });
  let oldOwner = true;
  const proof = {
    facts,
    assertCurrentSync: vi.fn(() => {
      if (!oldOwner) throw Error('Old workspace expired');
    }),
    revalidate: vi.fn(async () => {}),
    adopt: vi.fn(async () => {
      oldOwner = false;
    }),
  };
  const handoff = { assertCurrentSync: vi.fn(), commit: vi.fn() };
  const owners = {
    events: f.store,
    native,
    admission,
    conversationId: 'session',
    binding: f.binding,
    expected: f.input.expected,
    assertCurrentSync: () => {
      if (!oldOwner) throw Error('Old owner must not be called after CAS');
      admission.assertCurrentSync();
    },
    assertOperatorAndLeaseCurrentSync: () => f.lease.assertCurrentSync(),
    prepareWorkspaceHandoff: () => handoff,
  };
  return {
    ...f,
    native,
    proof,
    owners,
    admission,
    handoff,
    close: () => {
      native.close();
      f.store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('completes one operation-specific original-task continuation without reusing expired old custody', async () => {
  const f = preparedOperationFixture();
  try {
    const result = await performPreparedRepositoryPrimaryTransition(f.proof, f.owners);
    expect(f.proof.adopt).toHaveBeenCalledOnce();
    expect(f.handoff.assertCurrentSync).toHaveBeenCalledOnce();
    expect(f.handoff.commit).toHaveBeenCalledOnce();
    expect(f.options.session.cwd).toBe('/offline/prepared');
    expect(f.admission.canClaimCommand(result.childCommandId)).toBe(true);
    expect(f.native.commands('session', f.binding)).toMatchObject([
      { id: 'command', status: 'completed', intent: 'Original intent' },
      { id: result.childCommandId, status: 'queued', intent: 'Original intent' },
    ]);
    expect(f.native.read('session', f.binding)).toMatchObject({
      cwd: '/offline/prepared',
      threadId: 'thread',
      threadGeneration: 0,
    });
    expect(f.lease.client.request).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it.each(['after custody', 'after metadata', 'after queued row'] as const)(
  'retains uncertain non-replay after failure %s',
  async (phase) => {
    const f = preparedOperationFixture();
    try {
      if (phase === 'after custody')
        vi.spyOn(f.store, 'commitPreparedRepositoryContinuation').mockImplementation(() => {
          throw Error('Injected');
        });
      if (phase === 'after metadata')
        vi.spyOn(f.native, 'adoptPreparedRepositoryWorkspace').mockImplementation(() => {
          throw Error('Injected');
        });
      if (phase === 'after queued row') {
        const enqueue = f.native.enqueuePreparedRepositoryContinuation.bind(f.native);
        vi.spyOn(f.native, 'enqueuePreparedRepositoryContinuation').mockImplementation(
          (...args) => {
            enqueue(...args);
            throw Error('Injected');
          },
        );
      }
      await expect(performPreparedRepositoryPrimaryTransition(f.proof, f.owners)).rejects.toThrow(
        'Injected',
      );
      expect(f.store.hasUncertainOrdinaryCommand('session')).toBe(true);
      expect(f.proof.adopt).toHaveBeenCalledOnce();
      const child = f.native
        .commands('session', f.binding)
        .find((command) => command.id !== 'command');
      if (child) expect(f.admission.canClaimCommand(child.id)).toBe(false);
      await expect(performPreparedRepositoryPrimaryTransition(f.proof, f.owners)).rejects.toThrow();
      expect(f.proof.adopt).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  },
);

it('refuses an old queued command introduced during async proof validation before uncertainty or custody effects', async () => {
  const f = preparedOperationFixture();
  try {
    f.proof.revalidate.mockImplementation(async () => {
      f.native.enqueue('session', f.binding, { id: 'old-followup', prompt: 'Later task' });
    });
    await expect(performPreparedRepositoryPrimaryTransition(f.proof, f.owners)).rejects.toThrow();
    expect(f.proof.adopt).not.toHaveBeenCalled();
    expect(f.store.hasUncertainOrdinaryCommand('session')).toBe(false);
    expect(f.native.commands('session', f.binding).at(-1)).toMatchObject({
      id: 'old-followup',
      status: 'queued',
    });
  } finally {
    f.close();
  }
});

it('refuses mutable nested materialization identity instead of diverging from the persisted projection', async () => {
  const f = preparedOperationFixture();
  try {
    const taskIdentity = structuredClone(f.proof.facts.newWorkspace.taskIdentity);
    const facts = Object.freeze({
      ...f.proof.facts,
      newWorkspace: Object.freeze({ ...f.proof.facts.newWorkspace, taskIdentity }),
    });
    const proof = {
      ...f.proof,
      facts,
      revalidate: async () => {
        taskIdentity.root.ino++;
      },
    };
    await expect(performPreparedRepositoryPrimaryTransition(proof, f.owners)).rejects.toThrow();
    expect(f.proof.adopt).not.toHaveBeenCalled();
    expect(f.store.hasUncertainOrdinaryCommand('session')).toBe(false);
  } finally {
    f.close();
  }
});
it('adopts only its exact committed prepared child under the same lease and preserves original payload/receipt', () => {
  const f = fixture();
  try {
    f.store.claimOrdinaryLocalCommandDispatch('command');
    const owner = OwnedLocalCodexChatAdmission.capture(f.input);
    owner.assertOptions(f.options);
    f.store.completeOrdinaryLocalCommand('command');
    const original = f.store.getOrdinaryLocalCommandAdmission('command');
    const transition = {
      version: 1 as const,
      preparationId: '34af2bdf-5fb4-4de0-b083-cf188163d891',
      runtimeId: 'runtime',
      source: {
        commandId: 'command',
        attempt: 1,
        threadId: 'thread',
        turnId: 'turn',
        generation: 0,
        callId: 'prepare',
        requestHash: 'a'.repeat(64),
        resultSha256: 'b'.repeat(64),
      },
      oldWorkspace: {
        kind: 'repository' as const,
        id: 'workspace',
        directory: '/offline/workspace',
      },
      newWorkspace: {
        kind: 'repository' as const,
        id: 'prepared',
        directory: '/offline/prepared',
        featureBranch: 'task/branch',
        baseOid: 'c'.repeat(40),
        taskIdentitySha256: 'd'.repeat(64),
      },
      consumedScopeSha256: 'e'.repeat(64),
      materializedRecordSha256: 'f'.repeat(64),
    };
    const reserved = f.store.reservePreparedRepositoryContinuation('session', transition);
    const expected = { ...f.input.expected, workspace: reserved.admission.workspace };
    const commit = owner.preparePreparedRepositoryPrimary(
      reserved.childCommandId,
      expected,
      transition,
    );
    expect(() => commit()).toThrow();
    expect(f.options.session.cwd).toBe('/offline/workspace');
    f.store.commitPreparedRepositoryContinuation('session', reserved.childCommandId, transition);
    commit();
    expect(f.options.session.cwd).toBe('/offline/prepared');
    expect(owner.canClaimCommand(reserved.childCommandId)).toBe(false);
    const input = {
      id: reserved.childCommandId,
      prompt: reserved.payload.text,
      intent: reserved.payload.intent,
      model: f.options.model,
      reasoningEffort: null,
    };
    owner.assertBeforeEnqueue(input);
    f.store.finalizePreparedRepositoryContinuation(
      'session',
      reserved.childCommandId,
      transition,
      () => {},
    );
    expect(owner.canClaimCommand(reserved.childCommandId)).toBe(true);
    expect(() => owner.assertBeforeEnqueue(input)).toThrow();
    owner.assertBeforeDispatch(reserved.childCommandId);
    expect(() => owner.assertBeforeDispatch(reserved.childCommandId)).toThrow();
    expect(() => commit()).toThrow();
    expect(f.store.getPreparedRepositorySourceAdmission(reserved.childCommandId)).toEqual(original);
    expect(f.store.getSendCommand('command')?.payload).toMatchObject({
      text: f.options.prompt,
      images: f.options.images,
    });
    expect(f.lease.client.request).not.toHaveBeenCalled();
    const selection = { ...f.selection, model: 'future-model', thinking: 'low' };
    const payload = { text: 'Follow-up after adoption', systemPrompt: f.options.systemPrompt };
    const nextExpected = { ...expected, selection };
    f.store.admitPreparedRepositoryPrimaryContinuation(
      {
        sessionId: 'session',
        repositoryWorkspaceId: 'prepared',
        cwd: '/offline/prepared',
        accountBinding: { ...f.binding, model: selection.model },
        agentProfile: f.agentProfile,
        mode: 'agent',
        selectedModel: selection.model,
        reasoningEffort: selection.thinking,
      },
      f.runtime,
      { clientMsgId: 'followup', requestFingerprint: 'followup-fingerprint', selection, payload },
      reserved.childCommandId,
    );
    f.store.claimOrdinaryLocalCommandDispatch('followup');
    owner.admitContinuation('followup', nextExpected);
    owner.assertBeforeEnqueue({
      id: 'followup',
      prompt: payload.text,
      model: selection.model,
      reasoningEffort: selection.thinking,
    });
    f.store.completeOrdinaryLocalCommand('followup');
    expect(() => owner.assertModelSelection(selection.model, selection.thinking)).not.toThrow();
    owner.close();
    expect(() => owner.canClaimCommand(reserved.childCommandId)).toThrow();
    expect(() => owner.assertBeforeEnqueue(input)).toThrow();
  } finally {
    f.store.close();
  }
});

it('supplies the physical native artifact digest only through the current owned lease', () => {
  const f = fixture();
  try {
    f.lease.executableSha256 = '1'.repeat(64);
    f.store.claimOrdinaryLocalCommandDispatch('command');
    const owner = OwnedLocalCodexChatAdmission.capture(f.input);
    expect(owner.nativeExecutionArtifactSha256()).toBe('1'.repeat(64));
    vi.mocked(f.lease.assertCurrentSync).mockImplementation(() => {
      throw Error('Revoked');
    });
    expect(() => owner.nativeExecutionArtifactSha256()).toThrow();
  } finally {
    f.store.close();
  }
});
it('requires the exact durable uncertain receipt before creating a trusted chat admission', () => {
  const f = fixture();
  try {
    expect(() => OwnedLocalCodexChatAdmission.capture(f.input)).toThrow(
      'Owned local Codex chat unavailable',
    );
    f.store.claimOrdinaryLocalCommandDispatch('command');
    const owner = OwnedLocalCodexChatAdmission.capture(f.input);
    expect(() => owner.assertOptions(f.options)).not.toThrow();
    owner.assertBeforeEnqueue({
      id: 'command',
      prompt: f.options.prompt,
      intent: f.options.intent,
      model: f.options.model,
      reasoningEffort: null,
      images: f.options.images,
    });
    expect(() => owner.assertBeforeEnqueue({ id: 'future', prompt: 'Future' })).toThrow(
      'Owned local Codex chat unavailable',
    );
  } finally {
    f.store.close();
  }
});

it('enqueues the first command under uncertainty but dispatches it only after the coordinator records consumed', () => {
  const f = fixture();
  try {
    f.store.claimOrdinaryLocalCommandDispatch('command');
    const owner = OwnedLocalCodexChatAdmission.capture(f.input);
    owner.assertOptions(f.options);
    owner.assertBeforeEnqueue({
      id: 'command',
      prompt: f.options.prompt,
      intent: f.options.intent,
      images: f.options.images,
      model: f.options.model,
      reasoningEffort: f.options.reasoningEffort,
    });
    expect(owner.canClaimCommand('command')).toBe(false);
    expect(() => owner.assertBeforeDispatch('command')).toThrow();
    f.store.completeOrdinaryLocalCommand('command');
    expect(owner.canClaimCommand('command')).toBe(true);
    expect(() => owner.assertBeforeDispatch('command')).not.toThrow();
  } finally {
    f.store.close();
  }
});
it.each([
  'prompt',
  'systemPrompt',
  'intent',
  'images',
  'account',
  'model',
  'thinking',
  'mode',
  'workspace',
  'agent',
  'resume',
  'reattach',
] as const)('rejects %s substitution before native effects', (kind) => {
  const f = fixture();
  try {
    f.store.claimOrdinaryLocalCommandDispatch('command');
    const owner = OwnedLocalCodexChatAdmission.capture(f.input),
      options = structuredClone(f.options);
    if (kind === 'prompt') options.prompt = 'Changed';
    if (kind === 'intent') options.intent = 'Changed';
    if (kind === 'systemPrompt') options.systemPrompt = 'Changed developer instructions';
    if (kind === 'images') options.images[0].data = 'Changed';
    if (kind === 'account') options.binding.accountId = 'other';
    if (kind === 'model') options.model = 'other';
    if (kind === 'thinking') Object.assign(options, { reasoningEffort: 'high' });
    if (kind === 'mode') Object.assign(options.session, { mode: 'auto' });
    if (kind === 'workspace') options.session.cwd = '/other';
    if (kind === 'agent') options.agentProfile.revision = 2;
    if (kind === 'resume') Object.assign(options, { resume: true });
    if (kind === 'reattach') Object.assign(options, { reattachOnly: true });
    expect(() => owner.assertOptions(options)).toThrow('Owned local Codex chat unavailable');
    expect(f.lease.client.request).not.toHaveBeenCalled();
  } finally {
    f.store.close();
  }
});
it('permits retained completion observation but refuses first-command replay after consumption', async () => {
  const f = fixture();
  try {
    f.store.claimOrdinaryLocalCommandDispatch('command');
    const owner = OwnedLocalCodexChatAdmission.capture(f.input);
    f.store.completeOrdinaryLocalCommand('command');
    await owner.assertCurrent();
    expect(() => owner.assertBeforeEnqueue({ id: 'command', prompt: f.options.prompt })).toThrow(
      'Owned local Codex chat unavailable',
    );
    expect(() => OwnedLocalCodexChatAdmission.capture(f.input)).toThrow(
      'Owned local Codex chat unavailable',
    );
  } finally {
    f.store.close();
  }
});

it('does not treat a mutated public lease profile as the original login routing authority', () => {
  const f = fixture();
  try {
    f.store.claimOrdinaryLocalCommandDispatch('command');
    const owner = OwnedLocalCodexChatAdmission.capture(f.input);
    f.input.lease.profile.credentialRef = '/other/login';
    f.options.profile.credentialRef = '/other/login';
    expect(() => owner.assertOptions(f.options)).toThrow('Owned local Codex chat unavailable');
  } finally {
    f.store.close();
  }
});

it('admits a frozen future selection only through an uncertain child receipt and preserves queued settings', () => {
  const f = fixture();
  try {
    f.store.claimOrdinaryLocalCommandDispatch('command');
    const owner = OwnedLocalCodexChatAdmission.capture(f.input);
    owner.assertOptions(f.options);
    f.store.completeOrdinaryLocalCommand('command');
    const selected = { ...f.selection, model: 'future-model', thinking: 'low' };
    const payload = { text: 'Next message', systemPrompt: f.options.systemPrompt };
    f.store.admitOrdinaryLocalContinuation(
      {
        sessionId: 'session',
        accountBinding: { ...f.binding, model: selected.model },
        cwd: f.options.session.cwd,
        repositoryWorkspaceId: 'workspace',
        selectedModel: selected.model,
        reasoningEffort: selected.thinking,
        mode: 'agent',
        agentProfile: f.agentProfile,
      },
      f.runtime,
      {
        clientMsgId: 'next',
        requestFingerprint: 'next-fingerprint',
        selection: selected,
        payload,
      },
    );
    const expected = { ...f.input.expected, selection: selected };
    expect(() => owner.admitContinuation('next', expected)).toThrow();
    f.store.claimOrdinaryLocalCommandDispatch('next');
    owner.admitContinuation('next', expected);
    expect(() =>
      owner.assertBeforeEnqueue({
        id: 'next',
        prompt: 'Changed',
        model: selected.model,
        reasoningEffort: selected.thinking,
      }),
    ).toThrow();
    owner.assertBeforeEnqueue({
      id: 'next',
      prompt: payload.text,
      model: selected.model,
      reasoningEffort: selected.thinking,
    });
    expect(owner.canClaimCommand('next')).toBe(false);
    expect(() => owner.assertBeforeDispatch('next')).toThrow();
    f.store.completeOrdinaryLocalCommand('next');
    expect(owner.canClaimCommand('next')).toBe(true);
    owner.assertModelSelection(selected.model, selected.thinking);
    owner.assertBeforeDispatch('next');
    expect(() => owner.assertBeforeDispatch('next')).toThrow();
    expect(() =>
      owner.assertBeforeEnqueue({
        id: 'next',
        prompt: payload.text,
        model: selected.model,
        reasoningEffort: selected.thinking,
      }),
    ).toThrow();
    expect(f.store.getSession('session')?.selectedModel).toBe('fixture-model');
  } finally {
    f.store.close();
  }
});

it('drops completed command authority without hydrating terminal history or deleting durable receipts', () => {
  const f = fixture(),
    root = mkdtempSync(join(tmpdir(), 'mitzo-local-terminal-'));
  const native = new CodexConversationStore(join(root, 'native.db'));
  try {
    native.create('session', f.binding, f.options.session.cwd);
    f.store.claimOrdinaryLocalCommandDispatch('command');
    const owner = OwnedLocalCodexChatAdmission.capture({ ...f.input, nativeStore: native });
    owner.assertOptions(f.options);
    f.store.completeOrdinaryLocalCommand('command');
    const selection = { ...f.selection, model: 'future-model' };
    const payload = {
      text: 'Completed payload remains in history',
      systemPrompt: f.options.systemPrompt,
    };
    f.store.admitOrdinaryLocalContinuation(
      {
        sessionId: 'session',
        accountBinding: { ...f.binding, model: selection.model },
        cwd: f.options.session.cwd,
        repositoryWorkspaceId: 'workspace',
        mode: 'agent',
        agentProfile: f.agentProfile,
        selectedModel: selection.model,
        reasoningEffort: null,
      },
      f.runtime,
      { clientMsgId: 'terminal', requestFingerprint: 'terminal-fingerprint', selection, payload },
    );
    f.store.claimOrdinaryLocalCommandDispatch('terminal');
    owner.admitContinuation('terminal', { ...f.input.expected, selection });
    owner.assertBeforeEnqueue({
      id: 'terminal',
      prompt: payload.text,
      model: selection.model,
      reasoningEffort: null,
    });
    native.enqueue('session', f.binding, {
      id: 'terminal',
      prompt: payload.text,
      model: selection.model,
      reasoningEffort: null,
    });
    f.store.completeOrdinaryLocalCommand('terminal');
    owner.assertModelSelection(selection.model, null);
    native.claimNext('session', f.binding);
    owner.assertBeforeDispatch('terminal');
    native.finish('session', f.binding, 'terminal', 'completed');
    const history = vi.spyOn(native, 'commands').mockImplementation(() => {
      throw new Error('Historical payload hydration');
    });
    for (let boundary = 0; boundary < 20; boundary++) owner.assertCurrentSync();
    expect(history).not.toHaveBeenCalled();
    expect(() => owner.assertModelSelection(selection.model, null)).toThrow();
    expect(owner.canClaimCommand('terminal')).toBe(false);
    expect(() => owner.assertBeforeDispatch('terminal')).toThrow();
    expect(f.store.getOrdinaryLocalCommandAdmission('terminal')?.state).toBe('consumed');
    expect(f.store.getSendCommand('terminal')?.payload).toEqual(payload);
    history.mockRestore();
    expect(native.commands('session', f.binding)[0].prompt).toBe(payload.text);
  } finally {
    native.close();
    f.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('denies retained role corruption arriving during awaited final Local admission validation', async () => {
  const f = fixture();
  try {
    f.store.claimOrdinaryLocalCommandDispatch('command');
    const admission = OwnedLocalCodexChatAdmission.capture(f.input);
    f.lease.assertCurrent = vi.fn(async () => {
      f.store.append('session', 'telos_work_role_context', {
        version: 1,
        selection: { role: 'lead' },
      });
    });
    await expect(admission.assertCurrent()).rejects.toThrow();
  } finally {
    f.store.close();
  }
});
