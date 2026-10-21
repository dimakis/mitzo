import { describe, expect, it, vi } from 'vitest';
import { OpenShellSecretVault, type SecretOperatorRpc } from '../openshell-secret-vault.js';

const profile = {
  id: 'mitzo-secret-relay',
  resource_version: '1',
  credentials: [{ name: 'value', env_vars: ['MITZO_SECRET_VALUE'], required: true }],
};
function fixture() {
  let provider: Record<string, unknown>;
  const rpc = vi.fn<SecretOperatorRpc>(async (method, request) => {
    const input = request as { provider: { metadata: Record<string, unknown> } };
    if (method === 'GetProviderProfile') return { profile };
    if (method === 'CreateProvider') {
      provider = {
        ...input.provider,
        metadata: { ...input.provider.metadata, id: 'gateway-id', resource_version: '1' },
        credentials: { MITZO_SECRET_VALUE: '[REDACTED]' },
      };
      return { provider };
    }
    if (method === 'GetProvider') return { provider };
    if (method === 'GetProviderCredentials')
      return { credentials: { MITZO_SECRET_VALUE: { value: 'fixture-only-password' } } };
    throw new Error('Unexpected RPC');
  });
  return { rpc, vault: new OpenShellSecretVault('gateway', 'workspace', rpc) };
}
describe('OpenShell private relay vault', () => {
  it('stores in a dedicated unattached provider and returns only a pinned reference', async () => {
    const { vault, rpc } = fixture();
    const ref = await vault.save(
      '11111111-1111-4111-8111-111111111111',
      'fixture-only-password',
      AbortSignal.timeout(1000),
    );
    expect(JSON.stringify(ref)).not.toContain('fixture-only-password');
    expect(ref).toMatchObject({
      gateway: 'gateway',
      workspace: 'workspace',
      providerId: 'gateway-id',
      version: '1',
    });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['GetProviderProfile', 'CreateProvider']);
    expect(await vault.read(ref, AbortSignal.timeout(1000))).toBe('fixture-only-password');
    expect(rpc.mock.calls.find((c) => c[0] === 'GetProviderCredentials')?.[1]).toEqual({
      workspace_scope: { workspace: 'workspace' },
      name: ref.name,
      credential_keys: ['MITZO_SECRET_VALUE'],
    });
  });
  it('rejects a reference from another gateway before RPC', async () => {
    const { vault, rpc } = fixture();
    const ref = await vault.save(
      '11111111-1111-4111-8111-111111111111',
      'fixture',
      AbortSignal.timeout(1000),
    );
    rpc.mockClear();
    await expect(
      vault.read({ ...ref, gateway: 'other' }, AbortSignal.timeout(1000)),
    ).rejects.toThrow('Secret unavailable');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('refuses profiles that could inject into a sandbox', async () => {
    const { vault, rpc } = fixture();
    rpc.mockResolvedValueOnce({
      profile: { ...profile, endpoints: [Buffer.from('injection')] },
    });
    await expect(
      vault.save('11111111-1111-4111-8111-111111111111', 'fixture', AbortSignal.timeout(1000)),
    ).rejects.toThrow('Secret storage unavailable');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects replaced providers and never exposes Gateway errors', async () => {
    const { vault, rpc } = fixture();
    const ref = await vault.save(
      '11111111-1111-4111-8111-111111111111',
      'fixture',
      AbortSignal.timeout(1000),
    );
    rpc
      .mockResolvedValueOnce({ profile })
      .mockResolvedValueOnce({ provider: { metadata: { id: 'replacement' } } });
    await expect(vault.read(ref, AbortSignal.timeout(1000))).rejects.toThrow('Secret unavailable');
    rpc.mockRejectedValueOnce(new Error('fixture-only-password'));
    await expect(vault.read(ref, AbortSignal.timeout(1000))).rejects.toThrow(
      /^Secret unavailable$/,
    );
  });
});
