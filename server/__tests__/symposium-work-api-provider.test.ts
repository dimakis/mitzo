import { describe, expect, it, vi } from 'vitest';
import type { spawnSync } from 'node:child_process';
import type { OwnedSymposiumGateway } from '../symposium-owned-gateway.js';
import {
  createSymposiumWorkApiProvider,
  type SymposiumWorkApiProfile,
} from '../symposium-work-api-provider.js';
function fixture() {
  const gateway = {
    gateway: 'new-gateway',
    workspace: 'new-workspace',
    cli: '/private/pinned-cli',
    managementEnvironment: {
      HOME: '/private/home',
      XDG_CONFIG_HOME: '/private/config',
      PATH: '/usr/bin',
    },
    verifyCustody: vi.fn(),
  };
  const profile: SymposiumWorkApiProfile = {
    id: 'work',
    label: 'Work API',
    provider: 'openai',
    credentialRef: { provider: 'keychain', service: 'work-service', account: 'work-account' },
    models: [{ id: 'gpt-5.6-luna', label: 'Luna' }],
    sandboxProvider: 'legacy-provider',
    sandboxProviderId: 'legacy-id',
  };
  let name = '';
  const run = vi.fn(
    (_file: string, args: string[], _options?: { env?: Record<string, string> }) => {
      if (args.includes('create')) {
        name = args[args.indexOf('--name') + 1];
        return { status: 0, stdout: 'Created provider' };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          providers: [{ name, id: 'new-id', workspace: 'new-workspace', type: 'openai' }],
          next_page_token: '',
        }),
      };
    },
  );
  const resolver = { resolve: vi.fn().mockResolvedValue('fake-work-secret') };
  return {
    gateway,
    profile,
    run,
    resolver,
    provision: () =>
      createSymposiumWorkApiProvider(gateway as unknown as OwnedSymposiumGateway, profile, {
        resolver,
        run: run as unknown as typeof spawnSync,
      }),
  };
}
describe('owned work API provisioning', () => {
  it('uses only the explicit secret reference and returns a new isolated binding', async () => {
    const f = fixture();
    const original = structuredClone(f.profile);
    const result = await f.provision();
    expect(f.resolver.resolve).toHaveBeenCalledExactlyOnceWith(f.profile.credentialRef);
    expect(result).toEqual({
      ...original,
      sandboxProvider: expect.stringMatching(/^symposium-work-/),
      sandboxProviderId: 'new-id',
    });
    expect(f.profile).toEqual(original);
    const calls = f.run.mock.calls;
    expect(calls[0][0]).toBe('/private/pinned-cli');
    expect(calls[0][2]?.env?.OPENAI_API_KEY).toBe('fake-work-secret');
    expect(calls[1][2]?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(calls[0][1].slice(0, 5)).toEqual([
      'provider',
      '--gateway',
      'new-gateway',
      '--workspace',
      'new-workspace',
    ]);
    expect(JSON.stringify(calls.map((call) => call[1]))).not.toMatch(
      /fake-work-secret|legacy-provider|legacy-id/,
    );
  });
  it('rejects credential failure without provider mutations or fallback', async () => {
    const f = fixture();
    f.resolver.resolve.mockRejectedValue(new Error('fake-work-secret'));
    await expect(f.provision()).rejects.toThrow('no new account profile');
    expect(f.run).not.toHaveBeenCalled();
    expect(f.resolver.resolve).toHaveBeenCalledTimes(1);
  });
  it('redacts provider errors and rejects the wrong physical provider identity', async () => {
    const f = fixture();
    f.run.mockReturnValue({ status: 1, stdout: 'fake-work-secret' });
    await expect(f.provision()).rejects.toThrow(
      'Work API provisioning failed; no new account profile was published',
    );
    const g = fixture();
    g.run.mockImplementation((_file, args) =>
      args.includes('create')
        ? { status: 0, stdout: 'Created' }
        : {
            status: 0,
            stdout: JSON.stringify({
              providers: [
                {
                  name: 'legacy-provider',
                  id: 'legacy-id',
                  type: 'openai',
                  workspace: 'new-workspace',
                },
              ],
              next_page_token: '',
            }),
          },
    );
    await expect(g.provision()).rejects.toThrow('no new account profile');
  });
  it('checks custody again after asynchronous credential resolution', async () => {
    const f = fixture();
    f.resolver.resolve.mockImplementation(async () => {
      f.gateway.verifyCustody.mockImplementation(() => {
        throw new Error('lost');
      });
      return 'fake-work-secret';
    });
    await expect(f.provision()).rejects.toThrow('no new account profile');
    expect(f.run).not.toHaveBeenCalled();
  });
});
