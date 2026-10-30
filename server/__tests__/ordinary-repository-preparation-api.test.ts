import { afterEach, expect, it, vi } from 'vitest';
import { lstatSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
const state = vi.hoisted(() => ({
  runtime: undefined as unknown,
  key: vi.fn(async () => 'offline-existing-key'),
  target: {
    target: {
      targetId: 'shell',
      targetRevision: 'shell-r1',
      location: 'openshell',
      ownership: 'dedicated-ordinary',
      openaiApi: 'enabled',
    },
    config: {},
  },
}));
vi.mock('../credentials.js', async (original) => ({
  ...(await original<object>()),
  credentials: { resolve: state.key },
}));
vi.mock('../connections-runtime.js', () => ({ getConnectionsRuntime: () => state.runtime }));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}), getMcpConfigPaths: () => [] }));
vi.mock('../ordinary-openshell-codex-entry-owner.js', () => ({
  loadOrdinaryOpenShellCodexTarget: () => state.target,
}));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  state.runtime = undefined;
  state.key.mockReset().mockResolvedValue('offline-existing-key');
});
async function fixture(runOn: 'local' | 'openshell') {
  const { ownedResponsesRuntimeFixture } =
    await import('./fixtures/owned-local-responses-runtime.js');
  const f = await ownedResponsesRuntimeFixture(cleanup, {
    chatRoute: true,
    dual: true,
    ordinaryPreparation: true,
  });
  const codexTargetPath = join(f.root, 'ordinary-codex-target.json');
  writeFileSync(
    codexTargetPath,
    JSON.stringify({
      version: 1,
      targetId: 'api-codex',
      label: 'Local Codex',
      hostId: hostname(),
      runtimeContractRevision: 'offline-contract',
    }),
    { mode: 0o600 },
  );
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE', codexTargetPath);
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
  vi.stubEnv('MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED', '1');
  const { loadAccountProfiles } = await import('../account-profiles.js');
  const binding = loadAccountProfiles().resolve('personal', 'fixture-model');
  expect(loadAccountProfiles().isEnrolledOpenAIAccount(binding.accountId)).toBe(false);
  const selection = {
    runOn,
    runtime: {
      account: f.request.runtime.account,
      harness: 'codex' as const,
      targetId: runOn === 'local' ? 'api-codex' : 'shell',
    },
  };
  const authority = await import('../ordinary-repository-preparation-authority.js');
  return { f, binding, selection, authority };
}
it.each(['local', 'openshell'] as const)(
  'prepares the existing API key on %s without re-enrollment and rejects later key drift',
  async (runOn) => {
    const { f, binding, selection, authority } = await fixture(runOn);
    state.key.mockClear();
    const proof = await authority.captureOrdinaryRepositoryPreparation(
      binding,
      selection,
      f.signal.signal,
    );
    expect(proof.runtimeBinding.execution.location).toBe(runOn);
    expect(state.key).toHaveBeenCalledWith(f.configuration[0].credentialRef);
    expect(state.key).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(proof)).not.toContain('offline-existing-key');
    await expect(
      authority.assertOrdinaryRepositoryPreparation(proof, binding, f.signal.signal),
    ).resolves.toBeUndefined();
    state.key.mockResolvedValue('offline-replaced-key');
    await expect(
      authority.assertOrdinaryRepositoryPreparation(proof, binding, f.signal.signal),
    ).rejects.toThrow(/preparation authority unavailable/);
  },
);
it('keeps a managed legacy account inside its existing credential and mutation owners', async () => {
  const { f, binding, selection, authority } = await fixture('local');
  const ready = vi.fn(async () => {}),
    resolveKey = vi.fn();
  const mutate = vi.fn(async (work: () => Promise<unknown>) => work());
  const resolveHostKey = vi.fn(async (_account: string, signal: AbortSignal) =>
    mutate(async () => {
      signal.throwIfAborted();
      return 'offline-managed-key';
    }),
  );
  state.runtime = {
    openAIKeys: { manages: () => true, resolveKey, resolveHostKey },
    assertOpenAIKeyReady: ready,
    service: { withCredentialMutation: mutate },
  };
  await authority.captureOrdinaryRepositoryPreparation(binding, selection, f.signal.signal);
  expect(ready).not.toHaveBeenCalled();
  expect(mutate).toHaveBeenCalled();
  expect(resolveHostKey).toHaveBeenCalledWith(binding.accountId, f.signal.signal);
  expect(resolveHostKey).toHaveBeenCalledTimes(1);
  expect(resolveKey).not.toHaveBeenCalled();
  expect(state.key).not.toHaveBeenCalled();
  resolveHostKey.mockRejectedValueOnce(Error('managed credential unavailable'));
  await expect(
    authority.captureOrdinaryRepositoryPreparation(binding, selection, f.signal.signal),
  ).rejects.toThrow('managed credential unavailable');
  expect(state.key).not.toHaveBeenCalled();
});
it('uses the gateway resolver readiness check and retains a fresh final preparation fence', async () => {
  const { f, binding, selection, authority } = await fixture('openshell');
  const order: string[] = [];
  const resolveKey = vi.fn(async () => {
    order.push('resolve');
    return 'offline-managed-key';
  });
  const ready = vi.fn(async () => {
    order.push('ready');
  });
  state.runtime = {
    openAIKeys: { manages: () => true, resolveKey },
    assertOpenAIKeyReady: ready,
    service: { assertAccountCredentialReady: ready },
  };
  const proof = await authority.captureOrdinaryRepositoryPreparation(
    binding,
    selection,
    f.signal.signal,
  );
  expect(proof.runtimeBinding.execution.location).toBe('openshell');
  expect(order).toEqual(['resolve', 'ready']);
  expect(resolveKey).toHaveBeenCalledWith(binding.accountId, f.signal.signal);
  expect(state.key).not.toHaveBeenCalled();
  ready.mockRejectedValueOnce(Error('gateway changed after credential resolution'));
  await expect(
    authority.captureOrdinaryRepositoryPreparation(binding, selection, f.signal.signal),
  ).rejects.toThrow('gateway changed');
  resolveKey.mockRejectedValueOnce(Error('credential controller unavailable'));
  ready.mockClear();
  await expect(
    authority.captureOrdinaryRepositoryPreparation(binding, selection, f.signal.signal),
  ).rejects.toThrow('credential controller unavailable');
  expect(ready).not.toHaveBeenCalled();
  expect(state.key).not.toHaveBeenCalled();
});
it('retains an immutable legacy workspace proof while refusing retired Responses execution', async () => {
  const { f, binding, selection, authority } = await fixture('local');
  const fresh = await authority.captureOrdinaryRepositoryPreparation(
    binding,
    selection,
    f.signal.signal,
  );
  const legacySelection = {
    runOn: 'local' as const,
    runtime: {
      account: f.request.runtime.account,
      harness: 'responses' as const,
      targetId: 'local-mac',
    },
  };
  const { OrdinaryLocalResponsesTarget } =
    await import('../ordinary-local-responses-capabilities.js');
  const { loadAccountProfiles } = await import('../account-profiles.js');
  // Historical evidence is seeded as saved data. A retired catalog cannot mint
  // an execution binding for a new command, including through a test fixture.
  const target = new OrdinaryLocalResponsesTarget(f.dependencies.env).descriptor();
  const historicalRuntime = {
    version: 2 as const,
    account: legacySelection.runtime.account,
    harness: { implementation: 'responses' as const },
    execution: {
      location: 'local' as const,
      targetId: target.targetId,
      targetRevision: target.targetRevision,
    },
  };
  const source = lstatSync(join(f.root, 'repositories', f.reservation.id, 'mgmt'));
  // Seed the existing private owner row as a historical preparation. The same
  // account/key custody was captured above; no new Responses capture is used.
  const proof = {
    ...fresh,
    runtimeBinding: historicalRuntime,
    sourceIdentity: { dev: source.dev, ino: source.ino },
  };
  const database = new Database(join(f.root, 'repositories', 'workspaces.db'));
  const row = database
    .prepare('SELECT record FROM repository_workspaces WHERE id=?')
    .get(f.reservation.id) as { record: string };
  database
    .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
    .run(
      JSON.stringify({ ...JSON.parse(row.record), ordinaryPreparation: proof }),
      f.reservation.id,
    );
  database.close();
  state.key.mockClear();
  await expect(
    authority.captureOrdinaryRepositoryPreparation(binding, legacySelection, f.signal.signal),
  ).rejects.toThrow('preparation authority unavailable');
  expect(state.key).not.toHaveBeenCalled();
  await expect(f.workspace.qualifiedStatus(f.reservation.id, binding)).rejects.toThrow(
    'preparation authority unavailable',
  );
  expect(state.key).not.toHaveBeenCalled();
  expect(f.workspace.get(f.reservation.id).ordinaryPreparation).toEqual(proof);
  await expect(
    f.workspace.qualifiedStatus(f.reservation.id, { ...binding, accountId: 'foreign' }),
  ).rejects.toThrow();
  const originalProviderId = f.configuration[0].sandboxProviderId;
  f.configuration[0].sandboxProviderId = 'rotated-offline-provider-id';
  f.writeProfiles();
  expect(loadAccountProfiles().resolve('personal', 'fixture-model').profileRevision).not.toBe(
    binding.profileRevision,
  );
  state.key.mockClear();
  await expect(f.workspace.qualifiedStatus(f.reservation.id, binding)).rejects.toThrow();
  expect(state.key).not.toHaveBeenCalled();
  expect(f.workspace.get(f.reservation.id).ordinaryPreparation).toEqual(proof);
  f.configuration[0].sandboxProviderId = originalProviderId;
  f.writeProfiles();
  state.key.mockResolvedValue('offline-changed-key');
  await expect(f.workspace.qualifiedStatus(f.reservation.id, binding)).rejects.toThrow(
    'preparation authority unavailable',
  );
  expect(f.workspace.get(f.reservation.id).ordinaryPreparation).toEqual(proof);
  state.key.mockResolvedValue('offline-existing-key');
  state.key.mockClear();
  writeFileSync(f.targetPath, JSON.stringify({ ...f.target, label: 'Rotated target revision' }), {
    mode: 0o600,
  });
  await expect(f.workspace.qualifiedStatus(f.reservation.id, binding)).rejects.toThrow(
    'preparation authority unavailable',
  );
  expect(state.key).not.toHaveBeenCalled();
  expect(f.workspace.get(f.reservation.id).ordinaryPreparation).toEqual(proof);
});
it('does not downgrade an enrolled account after controller loss', async () => {
  const { f, binding, selection, authority } = await fixture('local');
  const { AccountProfiles } = await import('../account-profiles.js');
  vi.spyOn(AccountProfiles.prototype, 'isEnrolledOpenAIAccount').mockReturnValue(true);
  await expect(
    authority.captureOrdinaryRepositoryPreparation(binding, selection, f.signal.signal),
  ).rejects.toThrow('controller unavailable');
  expect(state.key).not.toHaveBeenCalled();
});

it('prepares a qualified local Responses endpoint through its selected host key authority', async () => {
  const { ownedRuntimeFixture } = await import('./fixtures/owned-local-codex-runtime.js');
  const f = await ownedRuntimeFixture(cleanup, { api: true, chatRoute: true });
  const connection = {
    endpoint: 'https://gateway.example.test/v1',
    protocol: 'responses',
    qualification: {
      source: 'operator',
      streaming: true,
      toolCalls: true,
      continuation: true,
      cancellation: true,
    },
  };
  Object.assign(f.configuration[0], { connection });
  f.writeProfiles();
  const { loadAccountProfiles } = await import('../account-profiles.js');
  const binding = loadAccountProfiles().resolve('work', 'fixture-model');
  const selection = {
    runOn: 'local' as const,
    runtime: {
      account: {
        accountId: binding.accountId,
        provider: binding.provider as 'openai',
        profileRevision: binding.profileRevision,
      },
      harness: 'codex' as const,
      targetId: 'local-mac',
    },
  };
  const authority = await import('../ordinary-repository-preparation-authority.js');
  const proof = await authority.captureOrdinaryRepositoryPreparation(
    binding,
    selection,
    f.signal.signal,
  );
  expect(proof.runtimeBinding.harness.implementation).toBe('codex');
  expect(state.key).toHaveBeenCalledWith(f.configuration[0].credentialRef);
  await expect(
    authority.assertOrdinaryRepositoryPreparation(proof, binding, f.signal.signal),
  ).resolves.toBeUndefined();
  Object.assign(f.configuration[0], {
    connection: { ...connection, endpoint: 'https://other.example.test/v1' },
  });
  f.writeProfiles();
  state.key.mockClear();
  await expect(
    authority.assertOrdinaryRepositoryPreparation(proof, binding, f.signal.signal),
  ).rejects.toThrow();
  expect(state.key).not.toHaveBeenCalled();
});

it('requalifies an upgraded OpenShell preparation only through the exact retained native conversation and namespace', async () => {
  const { f, binding, selection, authority } = await fixture('openshell');
  const config = {
    cli: '/offline/openshell',
    image: 'old-image',
    seed: '/release/old/seed',
    policy: '/release/old/policy',
    workspace: 'work',
    gateway: 'gateway',
    gatewayInsecure: false,
    workdir: '/sandbox/workspaces/task',
    serviceProviders: [],
    grantableServiceProviders: [],
    createDetached: true,
    sandboxIdLength: 13,
    webSearch: 'disabled',
  };
  state.target.config = config;
  const proof = await authority.captureOrdinaryRepositoryPreparation(
    binding,
    selection,
    f.signal.signal,
  );
  const sessionId = 'retained-native-chat';
  const workspaceId = 'retained-workspace';
  const artifact = {
    runtime: {
      sandboxName: 'original',
      sandboxId: 'original-physical',
      cli: config.cli,
      workspace: config.workspace,
      gateway: config.gateway,
      gatewayInsecure: false,
      workdir: config.workdir,
      appServerCommand: '/sandbox/run-mitzo-app-server',
    },
    route: { kind: 'api', provider: 'same-api-provider', model: binding.model },
  };
  const { openShellPhysicalCustodyFingerprint } = await import('../openshell-codex-custody.js');
  const custody = {
    version: 1,
    authSessionId: 'original-login',
    binding: proof.runtimeBinding,
    workspace: { workspaceId, cwd: config.workdir },
    physicalIdentitySha256: openShellPhysicalCustodyFingerprint(artifact as never),
  };
  const { eventStore } = await import('../chat.js');
  eventStore.createSessionWithRuntimeBinding(
    { sessionId, accountBinding: binding, cwd: config.workdir, repositoryWorkspaceId: workspaceId },
    proof.runtimeBinding,
  );
  const native = await import('../codex-chat-session.js');
  vi.spyOn(native, 'getCodexConversationStore').mockReturnValue({
    readOpenShellCustody: () => custody,
    readArtifactRuntime: () => artifact,
  } as never);
  const before = structuredClone(proof);
  state.target.target.targetRevision = 'upgraded-code';
  state.target.config = { ...config, seed: '/release/new/seed', policy: '/release/new/policy' };
  try {
    await expect(
      authority.assertOrdinaryRepositoryPreparation(proof, binding, f.signal.signal),
    ).rejects.toThrow();
    await expect(
      authority.assertOrdinaryRepositoryPreparation(
        proof,
        binding,
        f.signal.signal,
        false,
        undefined,
        { conversationId: sessionId, workspaceId },
      ),
    ).resolves.toBeUndefined();
    expect(proof).toEqual(before);
    await expect(
      authority.assertOrdinaryRepositoryPreparation(
        proof,
        binding,
        f.signal.signal,
        false,
        undefined,
        { conversationId: sessionId, workspaceId: 'foreign-workspace' },
      ),
    ).rejects.toThrow();
    state.target.config = { ...config, gateway: 'other-gateway' };
    await expect(
      authority.assertOrdinaryRepositoryPreparation(
        proof,
        binding,
        f.signal.signal,
        false,
        undefined,
        { conversationId: sessionId, workspaceId },
      ),
    ).rejects.toThrow();
  } finally {
    state.target.target.targetRevision = 'shell-r1';
    state.target.config = {};
  }
});
