import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { AccountProfiles } from '../account-profiles.js';
import { OwnedLocalCodexChatAdmission } from '../owned-local-codex-chat-admission.js';
import { OwnedCodexLifecycleBridge } from '../owned-codex-lifecycle-bridge.js';
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
  const binding = accounts.resolve('personal', 'fixture-model'),
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
  return { store, input, options, lease };
}
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
