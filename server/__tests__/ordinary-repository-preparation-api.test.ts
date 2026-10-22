import { afterEach, expect, it, vi } from 'vitest';
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
  const f = await ownedResponsesRuntimeFixture(cleanup, { chatRoute: true, dual: true });
  vi.stubEnv('MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED', '1');
  const { loadAccountProfiles } = await import('../account-profiles.js');
  const binding = loadAccountProfiles().resolve('personal', 'fixture-model');
  expect(loadAccountProfiles().isEnrolledOpenAIAccount(binding.accountId)).toBe(false);
  const selection = {
    runOn,
    runtime: {
      account: f.request.runtime.account,
      harness: runOn === 'local' ? ('responses' as const) : ('codex' as const),
      targetId: runOn === 'local' ? 'local-mac' : 'shell',
    },
  };
  const authority = await import('../ordinary-repository-preparation-authority.js');
  return { f, binding, selection, authority };
}
it.each(['local', 'openshell'] as const)(
  'prepares the existing API key on %s without re-enrollment and rejects later key drift',
  async (runOn) => {
    const { f, binding, selection, authority } = await fixture(runOn);
    const proof = await authority.captureOrdinaryRepositoryPreparation(
      binding,
      selection,
      f.signal.signal,
    );
    expect(proof.runtimeBinding.execution.location).toBe(runOn);
    expect(state.key).toHaveBeenCalledWith(f.configuration[0].credentialRef);
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
    resolveKey = vi.fn(async () => 'offline-managed-key');
  const mutate = vi.fn(async (work: () => Promise<unknown>) => work());
  state.runtime = {
    openAIKeys: { manages: () => true, resolveKey },
    assertOpenAIKeyReady: ready,
    service: { withCredentialMutation: mutate },
  };
  await authority.captureOrdinaryRepositoryPreparation(binding, selection, f.signal.signal);
  expect(ready).toHaveBeenCalledWith(binding.accountId, f.signal.signal);
  expect(mutate).toHaveBeenCalled();
  expect(resolveKey).toHaveBeenCalledWith(binding.accountId, f.signal.signal);
  expect(state.key).not.toHaveBeenCalled();
  resolveKey.mockRejectedValueOnce(Error('managed credential unavailable'));
  await expect(
    authority.captureOrdinaryRepositoryPreparation(binding, selection, f.signal.signal),
  ).rejects.toThrow('managed credential unavailable');
  expect(state.key).not.toHaveBeenCalled();
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
