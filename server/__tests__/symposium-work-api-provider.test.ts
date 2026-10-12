import { afterEach, describe, expect, it, vi } from 'vitest';
import type { spawnSync } from 'node:child_process';
import type { OwnedSymposiumGateway } from '../symposium-owned-gateway.js';
import {
  createSymposiumWorkApiProvider,
  captureSymposiumWorkApiProvider,
  captureSymposiumWorkApiCatalog,
  captureSymposiumWorkApiAccount,
  refreshSymposiumWorkApiCatalog,
  type SymposiumWorkApiProfile,
} from '../symposium-work-api-provider.js';
afterEach(() => vi.restoreAllMocks());
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
    const receipt = captureSymposiumWorkApiProvider(
      f.gateway as unknown as OwnedSymposiumGateway,
      result.sandboxProviderId,
    );
    expect(receipt.identity).toEqual({
      accountId: 'work',
      provider: 'openai',
      providerName: result.sandboxProvider,
      providerId: 'new-id',
      workspace: 'new-workspace',
    });
    receipt.assertCurrent();
    expect(() =>
      captureSymposiumWorkApiProvider(
        { ...f.gateway } as unknown as OwnedSymposiumGateway,
        'new-id',
      ),
    ).toThrow(/Original/);
    f.gateway.verifyCustody.mockImplementation(() => {
      throw Error('lost');
    });
    expect(() => receipt.assertCurrent()).toThrow();
    f.gateway.verifyCustody.mockReset();
    expect(() => receipt.assertCurrent()).toThrow(/Original/);
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

describe('original authenticated staging API billing scope and catalog', () => {
  const scope = { organizationId: 'org-isolated', projectId: 'proj_isolated' };
  const response = (headers: Record<string, string> = {}) =>
    new Response(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'gpt-5.6-luna', object: 'model', created: 1, owned_by: 'openai' }],
      }),
      { headers: { 'content-type': 'application/json', ...headers } },
    );
  const provision = (f: ReturnType<typeof fixture>, request: typeof fetch) =>
    createSymposiumWorkApiProvider(f.gateway as unknown as OwnedSymposiumGateway, f.profile, {
      resolver: f.resolver,
      run: f.run as unknown as typeof spawnSync,
      stagingCatalogScope: scope,
      request,
    });
  it('resolves exactly the original account creation and fresh catalog objects', async () => {
    const f = fixture();
    await provision(f, vi.fn().mockResolvedValue(response()));
    const captured = captureSymposiumWorkApiAccount(f.gateway as never, 'work');
    expect(captured.provider).toBe(captureSymposiumWorkApiProvider(f.gateway as never, 'new-id'));
    expect(captured.catalog).toBe(captureSymposiumWorkApiCatalog(f.gateway as never, 'new-id'));
    expect(() => captureSymposiumWorkApiAccount(f.gateway as never, 'Work API')).toThrow('Unique');
    expect(() => captureSymposiumWorkApiAccount({ ...f.gateway } as never, 'work')).toThrow(
      'Unique',
    );
    vi.spyOn(Date, 'now').mockReturnValue(captured.catalog.observation.expiresAt + 1);
    expect(() => captureSymposiumWorkApiAccount(f.gateway as never, 'work')).toThrow('catalog');
  });
  it('refuses an ambiguous account with multiple independently created original providers', async () => {
    const f = fixture();
    let count = 0,
      name = '';
    f.run.mockImplementation((_file, args) => {
      if (args.includes('create')) {
        count++;
        name = args[args.indexOf('--name') + 1];
        return { status: 0, stdout: 'Created provider' };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          providers: [
            { name, id: `original-${count}`, workspace: 'new-workspace', type: 'openai' },
          ],
          next_page_token: '',
        }),
      };
    });
    await provision(f, vi.fn().mockResolvedValue(response()));
    await provision(f, vi.fn().mockResolvedValue(response()));
    expect(() => captureSymposiumWorkApiAccount(f.gateway as never, 'work')).toThrow('Unique');
  });
  it('refreshes an expired catalog on the same original provider and credential, invalidating the old capability', async () => {
    const f = fixture(),
      request = vi.fn().mockImplementation(async () => response());
    const result = await provision(f, request);
    const old = captureSymposiumWorkApiCatalog(f.gateway as never, result.sandboxProviderId);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(old.observation.expiresAt + 1);
    expect(() => old.assertCurrent()).toThrow();
    const fresh = await refreshSymposiumWorkApiCatalog(f.gateway as never, 'new-id');
    expect(fresh.observation.providerId).toBe(old.observation.providerId);
    expect(fresh.observation.credentialSha256).toBe(old.observation.credentialSha256);
    expect(fresh.observation.accountHeaders).toEqual(old.observation.accountHeaders);
    expect(fresh.observation.observedAt).toBe(clock());
    expect(fresh).not.toBe(old);
    expect(fresh.observation.observationRevision).not.toBe(old.observation.observationRevision);
    expect(() => old.assertCurrent()).toThrow();
    fresh.assertCurrent();
    expect(f.run.mock.calls.filter((call) => call[1].includes('create'))).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('refuses changed credentials before a catalog request and invalidates prior catalog evidence', async () => {
    const f = fixture(),
      request = vi.fn().mockImplementation(async () => response());
    await provision(f, request);
    const old = captureSymposiumWorkApiCatalog(f.gateway as never, 'new-id');
    f.resolver.resolve.mockResolvedValue('different-fake-secret');
    await expect(refreshSymposiumWorkApiCatalog(f.gateway as never, 'new-id')).rejects.toThrow(
      /unavailable/,
    );
    expect(request).toHaveBeenCalledOnce();
    expect(() => old.assertCurrent()).toThrow();
    await expect(
      refreshSymposiumWorkApiCatalog({ ...f.gateway } as never, 'new-id'),
    ).rejects.toThrow();
  });

  it('refuses parallel refreshes and never restores a prior capability after failed authentication', async () => {
    const f = fixture(),
      request = vi.fn().mockImplementation(async () => response());
    await provision(f, request);
    const old = captureSymposiumWorkApiCatalog(f.gateway as never, 'new-id');
    let resolve!: (response: Response) => void;
    request.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const pending = refreshSymposiumWorkApiCatalog(f.gateway as never, 'new-id');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    expect(() => old.assertCurrent()).toThrow();
    await expect(refreshSymposiumWorkApiCatalog(f.gateway as never, 'new-id')).rejects.toThrow(
      /unavailable/,
    );
    resolve(new Response('denied', { status: 401 }));
    await expect(pending).rejects.toThrow(/unavailable/);
    expect(() => captureSymposiumWorkApiCatalog(f.gateway as never, 'new-id')).toThrow();
    expect(request).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls.filter((call) => call[1].includes('create'))).toHaveLength(1);
  });
  it('captures only an accepted authenticated catalog from the original fresh credential and exact billing headers', async () => {
    const f = fixture();
    const request = vi.fn().mockResolvedValue(response());
    const result = await provision(f, request);
    expect(request).toHaveBeenCalledExactlyOnceWith('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        authorization: 'Bearer fake-work-secret',
        'OpenAI-Organization': scope.organizationId,
        'OpenAI-Project': scope.projectId,
      },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    const cap = captureSymposiumWorkApiCatalog(
      f.gateway as unknown as OwnedSymposiumGateway,
      result.sandboxProviderId,
    );
    expect(cap.observation).toMatchObject({
      version: 1,
      providerId: 'new-id',
      providerName: result.sandboxProvider,
      workspace: 'new-workspace',
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      selectedModel: 'gpt-5.6-luna',
      credentialSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      catalogSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      observedAt: expect.any(Number),
    });
    expect(JSON.stringify(cap.observation)).not.toContain('fake-work-secret');
    cap.assertCurrent();
    expect(() => captureSymposiumWorkApiCatalog({ ...f.gateway } as never, 'new-id')).toThrow();
    f.gateway.verifyCustody.mockImplementation(() => {
      throw Error('owner lost');
    });
    expect(() => cap.assertCurrent()).toThrow();
  });
  it.each(['unauthorized', 'foreign-org', 'missing-luna', 'oversized'])(
    'refuses %s catalog without publishing a profile or account capability',
    async (failure) => {
      const f = fixture();
      const request = vi
        .fn()
        .mockResolvedValue(
          failure === 'unauthorized'
            ? new Response('denied', { status: 401 })
            : failure === 'foreign-org'
              ? response({ 'openai-organization': 'org-other' })
              : failure === 'missing-luna'
                ? new Response(JSON.stringify({ object: 'list', data: [] }))
                : new Response('x'.repeat(131073)),
        );
      await expect(provision(f, request)).rejects.toThrow('no new account profile');
      expect(() => captureSymposiumWorkApiCatalog(f.gateway as never, 'new-id')).toThrow();
      expect(f.run).not.toHaveBeenCalled();
    },
  );
  it('keeps ordinary provider creation free of network catalog discovery and staging authority', async () => {
    const f = fixture();
    const result = await f.provision();
    expect(() =>
      captureSymposiumWorkApiCatalog(f.gateway as never, result.sandboxProviderId),
    ).toThrow();
  });
});
