import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';
import { EventStore } from '../event-store.js';
import { FrozenHostCodexBootstrapAuthority } from '../frozen-host-codex-bootstrap.js';
import type { OrdinaryLocalCodexAdmissionExpectation } from '../ordinary-local-codex-admission.js';
const roots: string[] = [];
const deployment = vi.hoisted(() => ({ controller: false }));
const apiKeys = vi.hoisted(() => ({
  assertReady: vi.fn(async () => {}),
  resolveKey: vi.fn(async () => 'synthetic-api-key'),
}));
vi.mock('../openai-account-key-authority.js', () => ({ openAIAccountKeyAuthority: () => apiKeys }));
vi.mock('../symposium-custodian-mode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../symposium-custodian-mode.js')>()),
  get custodianControllerMode() {
    return deployment.controller;
  },
}));
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
afterEach(() => {
  deployment.controller = false;
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-bootstrap-')));
  roots.push(root);
  const source = join(root, 'source'),
    privateRoot = join(root, 'private'),
    executablePath = join(root, 'codex');
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(privateRoot, { mode: 0o700 });
  writeFileSync(
    join(source, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: 'fixture',
        refresh_token: 'fixture',
        id_token: 'fixture',
        account_id: 'fixture',
      },
    }),
    { mode: 0o600 },
  );
  const binary = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  writeFileSync(executablePath, binary, { mode: 0o755 });
  const configuration = [
    {
      id: 'personal',
      label: 'Personal',
      provider: 'openai-codex',
      credentialRef: source,
      email: 'person@example.test',
      planType: 'plus',
      models: [{ id: 'fixture-model', label: 'Fixture', reasoningEfforts: ['low'] }],
    },
  ];
  const loadProfiles = () => new AccountProfiles(configuration, { codexEnabled: true });
  const accountBinding = loadProfiles().resolve('personal', 'fixture-model');
  const binding = {
    version: 2 as const,
    account: {
      accountId: accountBinding.accountId,
      provider: accountBinding.provider,
      profileRevision: accountBinding.profileRevision,
    },
    harness: { implementation: 'codex' as const },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target-1' },
  };
  const selection = {
    version: 1 as const,
    agent: { profileId: 'agent', revision: 1 },
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'agent' as const, revision: 1 },
    model: 'fixture-model',
    thinking: 'low',
  };
  const expected = {
    binding,
    selection,
    hostId: 'host',
    runtimeContractRevision: 'runtime-1',
    capabilityRevision: 'cap-1',
    workspace: { workspaceId: 'workspace', cwd: '/offline/workspace' },
    bootstrapId: 'a'.repeat(64),
  } as OrdinaryLocalCodexAdmissionExpectation & { bootstrapId: string };
  const store = new EventStore(':memory:');
  const claim = () => {
    store.admitOrdinaryLocalCommand(
      {
        sessionId: 'session',
        accountBinding,
        repositoryWorkspaceId: 'workspace',
        cwd: expected.workspace.cwd,
      },
      binding,
      {
        clientMsgId: 'command',
        requestFingerprint: 'fingerprint',
        selection,
        payload: { text: 'offline' },
      },
    );
    return store.claimOrdinaryLocalCommandDispatch('command');
  };
  const runtime = {
    hostId: 'host',
    runtimeContractRevision: 'runtime-1',
    targetId: 'mac',
    targetRevision: 'target-1',
    executablePath,
    executableSha256: createHash('sha256').update(binary).digest('hex'),
  };
  const rpc = {
    initialize: vi.fn(async () => {}),
    request: vi.fn(async (method: string, _params: Record<string, unknown>) => {
      if (method === 'account/read')
        return { account: { type: 'chatgpt', email: configuration[0].email, planType: 'plus' } };
      if (method === 'config/read') return { config: {} };
      if (method === 'model/list')
        return {
          data: [
            {
              model: 'fixture-model',
              displayName: 'Fixture',
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
            },
          ],
          nextCursor: null,
        };
      throw new Error('Unexpected provider effect');
    }),
    close: vi.fn(),
  };
  const launch = vi.fn(() => {
    expect(store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('uncertain');
    return rpc;
  });
  const options = {
    loadProfiles,
    observeRuntime: vi.fn(async () => runtime),
    assertRuntimeCurrentSync: vi.fn(() => {}),
    assertSelectionCurrent: vi.fn(async () => {}),
    assertSelectionCurrentSync: vi.fn(() => {}),
    privateRoot,
    launch,
    signal: new AbortController().signal,
  };
  const authority = new FrozenHostCodexBootstrapAuthority(options);
  return {
    root,
    privateRoot,
    store,
    expected,
    claim,
    authority,
    options,
    configuration,
    rpc,
    launch,
    runtime,
  };
}
it('qualifies config/models once and keeps repeated current-authority checks free of discovery', async () => {
  const f = fixture();
  try {
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      const before = f.rpc.request.mock.calls.map(([method]) => method);
      await lease.assertCurrent();
      await lease.assertCurrent();
      const after = f.rpc.request.mock.calls.map(([method]) => method);
      expect(after.filter((method) => method === 'model/list')).toHaveLength(1);
      expect(after.filter((method) => method === 'config/read')).toHaveLength(1);
      expect(after.filter((method) => method === 'model/list').length).toBe(
        before.filter((method) => method === 'model/list').length,
      );
      await lease.qualifyModelSelection!('fixture-model', 'low');
      expect(f.rpc.request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(
        2,
      );
      f.rpc.request.mockImplementation(async () => ({ data: [], nextCursor: null }) as never);
      await expect(lease.qualifyModelSelection!('fixture-model', 'low')).rejects.toThrow();
    });
  } finally {
    f.authority.currentLease()?.close();
    f.store.close();
  }
});
it('claims SQLite uncertainty before custody/launch and supplies the same verified native client', async () => {
  const f = fixture();
  try {
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      expect(lease.client).toBe(f.rpc);
      expect(f.authority.currentLease()).toBe(lease);
      const exposedProfile = lease.profile;
      exposedProfile.credentialRef = '/mutated/public-profile';
      const exposedBinding = lease.binding;
      exposedBinding.profileRevision = 'mutated-public-binding';
      expect(lease.profile.credentialRef).toBe(f.configuration[0].credentialRef);
      expect(lease.binding.profileRevision).toBe(f.expected.binding.account.profileRevision);
      await lease.assertCurrent();
      for (const [method, params] of f.rpc.request.mock.calls) {
        if (method === 'config/read') expect(params.cwd).toBe(lease.privateHome);
      }
      lease.assertCurrentSync();
      f.store.completeOrdinaryLocalCommand('command');
    });
    expect(f.store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('consumed');
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'model/list').length).toBe(1);
    expect(f.rpc.close).not.toHaveBeenCalled();
    f.authority.currentLease()?.close();
  } finally {
    f.store.close();
  }
});
it.each([
  undefined,
  {
    endpoint: 'https://gateway.example.test/v1',
    protocol: 'responses' as const,
    qualification: {
      source: 'operator' as const,
      streaming: true,
      toolCalls: true,
      continuation: true,
      cancellation: true,
    },
  },
])(
  'bootstraps an API billing account with connection %j through Codex and retains its API home',
  async (connection) => {
    const f = fixture();
    const profiles = new AccountProfiles(
      [
        {
          id: 'work',
          label: 'Work API',
          provider: 'openai',
          ...(connection ? { connection } : {}),
          credentialRef: { provider: 'keychain', service: 'offline-test', account: 'work' },
          models: [{ id: 'fixture-model', label: 'Fixture', reasoningEfforts: ['low'] }],
        },
      ],
      { codexEnabled: true },
    );
    const binding = profiles.resolve('work', 'fixture-model');
    const expected = {
      ...f.expected,
      binding: {
        ...f.expected.binding,
        account: {
          accountId: binding.accountId,
          provider: binding.provider as 'openai',
          profileRevision: binding.profileRevision,
        },
      },
    };
    const request = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) =>
      method === 'account/read'
        ? ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true } as never)
        : request(method, params),
    );
    const claim = vi.fn(() => {
      f.store.admitOrdinaryLocalCommand(
        {
          sessionId: 'api-session',
          accountBinding: binding,
          repositoryWorkspaceId: 'workspace',
          cwd: expected.workspace.cwd,
        },
        expected.binding,
        {
          clientMsgId: 'api-command',
          requestFingerprint: 'api-fingerprint',
          selection: expected.selection,
          payload: { text: 'offline' },
        },
      );
      return f.store.claimOrdinaryLocalCommandDispatch('api-command');
    });
    const launchApi = vi.fn(
      async (
        home: string,
        _executable: unknown,
        _binding: unknown,
        _retained: boolean,
        _connection?: unknown,
      ) => {
        expect(f.store.getOrdinaryLocalCommandAdmission('api-command')?.state).toBe('uncertain');
        writeFileSync(
          join(home, 'auth.json'),
          JSON.stringify({ OPENAI_API_KEY: 'synthetic-api-key' }),
          { mode: 0o600, flag: 'wx' },
        );
        return f.rpc;
      },
    );
    const owner = new FrozenHostCodexBootstrapAuthority({
      ...f.options,
      loadProfiles: () => profiles,
      launchApi,
    });
    try {
      await owner.withBootstrap(expected, claim, async (lease) => {
        expect(lease.binding).toEqual(binding);
        expect(lease.profile.planType).toBe('api');
        expect(lease.custodySnapshot!().login).toMatchObject({ kind: 'api-key', binding });
        await lease.assertCurrent();
        lease.assertCurrentSync();
      });
      expect(launchApi).toHaveBeenCalledTimes(1);
      expect(launchApi.mock.calls[0][4]).toEqual(connection);
      if (connection)
        expect(f.rpc.request.mock.calls.some(([method]) => method === 'model/list')).toBe(false);
      expect(f.launch).not.toHaveBeenCalled();
      expect(apiKeys.resolveKey).toHaveBeenCalledWith('work', expect.any(AbortSignal));
    } finally {
      owner.currentLease()?.close();
      f.store.close();
    }
  },
);
it('a consumed/uncertain claim creates no private home or native connection', async () => {
  const f = fixture();
  try {
    const operation = vi.fn();
    expect(await f.authority.withBootstrap(f.expected, () => false, operation)).toBeUndefined();
    expect(readdirSync(f.privateRoot)).toEqual([]);
    expect(f.launch).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  } finally {
    f.store.close();
  }
});
it('refuses custodian controller bootstrap before claim, observations or custody effects', async () => {
  const f = fixture();
  deployment.controller = true;
  try {
    const claim = vi.fn(f.claim),
      operation = vi.fn();
    await expect(f.authority.withBootstrap(f.expected, claim, operation)).rejects.toThrow(
      'Host Codex bootstrap unavailable',
    );
    expect(claim).not.toHaveBeenCalled();
    expect(f.options.observeRuntime).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(readdirSync(f.privateRoot)).toEqual([]);
  } finally {
    f.store.close();
  }
});
it.each(['host', 'runtime', 'account', 'selection', 'executable'] as const)(
  'rejects %s drift and preserves claimed uncertainty when effects began',
  async (kind) => {
    const f = fixture();
    try {
      if (kind === 'host') f.runtime.hostId = 'other';
      if (kind === 'runtime') f.runtime.runtimeContractRevision = 'other';
      if (kind === 'account') f.configuration[0].email = 'other@example.test';
      if (kind === 'selection')
        f.options.assertSelectionCurrent.mockRejectedValue(new Error('private-owner-secret'));
      if (kind === 'executable') f.runtime.executableSha256 = '0'.repeat(64);
      const operation = vi.fn();
      await expect(f.authority.withBootstrap(f.expected, f.claim, operation)).rejects.toThrow(
        'Host Codex bootstrap unavailable',
      );
      expect(operation).not.toHaveBeenCalled();
      if (kind === 'executable')
        expect(f.store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('uncertain');
      else expect(f.store.getOrdinaryLocalCommandAdmission('command')).toBeUndefined();
    } finally {
      f.store.close();
    }
  },
);
it('fresh provider model/thinking refusal blocks workspace/dispatch and retains login custody', async () => {
  const f = fixture();
  try {
    f.rpc.request.mockImplementation(async (method) =>
      method === 'account/read'
        ? { account: { type: 'chatgpt', email: 'person@example.test', planType: 'plus' } }
        : method === 'config/read'
          ? { config: {} }
          : {
              data: [
                { model: 'different', displayName: 'Different', supportedReasoningEfforts: [] },
              ],
              nextCursor: null,
            },
    );
    const operation = vi.fn();
    await expect(f.authority.withBootstrap(f.expected, f.claim, operation)).rejects.toThrow(
      'Host Codex bootstrap unavailable',
    );
    expect(operation).not.toHaveBeenCalled();
    expect(f.rpc.close).toHaveBeenCalledTimes(1);
    expect(f.store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('uncertain');
    expect(readdirSync(f.privateRoot)).toEqual([`host-login-${f.expected.bootstrapId}`]);
  } finally {
    f.store.close();
  }
});

it('revocation while provider discovery awaits blocks the next effect boundary', async () => {
  const f = fixture();
  try {
    const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method) => {
      const response = await original(method, {});
      if (method === 'model/list')
        f.options.assertSelectionCurrentSync.mockImplementation(() => {
          throw new Error('owner-revoked');
        });
      return response;
    });
    const operation = vi.fn();
    await expect(f.authority.withBootstrap(f.expected, f.claim, operation)).rejects.toThrow(
      'Host Codex bootstrap unavailable',
    );
    expect(operation).not.toHaveBeenCalled();
    expect(f.rpc.close).toHaveBeenCalledTimes(1);
    expect(f.store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('uncertain');
  } finally {
    f.store.close();
  }
});

it('rechecks actual runtime configuration drift at the final synchronous effect fence', async () => {
  const f = fixture();
  f.options.assertRuntimeCurrentSync.mockImplementation(() => {
    if (f.runtime.targetRevision !== f.expected.binding.execution.targetRevision)
      throw new Error('actual-target-config-changed');
  });
  let dispatched = false;
  try {
    await expect(
      f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
        const observations = f.options.observeRuntime.mock.calls.length;
        f.runtime.targetRevision = 'changed-after-async-qualification';
        lease.assertCurrentSync();
        // This represents an existing native effect callback after async admission.
        dispatched = true;
        expect(f.options.observeRuntime).toHaveBeenCalledTimes(observations);
      }),
    ).rejects.toThrow('Host Codex bootstrap unavailable');
    expect(dispatched).toBe(false);
    expect(f.rpc.close).toHaveBeenCalledTimes(1);
    expect(f.store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('uncertain');
  } finally {
    f.store.close();
  }
});
