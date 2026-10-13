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
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
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
    request: vi.fn(async (method: string) => {
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
it('claims SQLite uncertainty before custody/launch and supplies the same verified native client', async () => {
  const f = fixture();
  try {
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      expect(lease.client).toBe(f.rpc);
      expect(f.authority.currentLease()).toBe(lease);
      await lease.assertCurrent();
      lease.assertCurrentSync();
      f.store.completeOrdinaryLocalCommand('command');
    });
    expect(f.store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('consumed');
    expect(
      f.rpc.request.mock.calls.filter(([method]) => method === 'model/list').length,
    ).toBeGreaterThan(1);
    expect(f.rpc.close).not.toHaveBeenCalled();
    f.authority.currentLease()?.close();
  } finally {
    f.store.close();
  }
});
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
      const response = await original(method);
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
