import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { GoogleWorkspaceManagement } from '../google-workspace-management.js';

const credentials = {
  type: 'authorized_user',
  client_id: 'client',
  client_secret: 'SECRET_CLIENT',
  refresh_token: 'SECRET_REFRESH',
};
const scopes = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar.readonly',
];
const credentialKey = 'GOOGLE_WORKSPACE_CLI_TOKEN';
const providerRow = (expiry: number) => ({
  id: 'google-id',
  name: 'google-workspace',
  workspace: 'default',
  type: 'mitzo-google-workspace-spike',
  resource_version: 8,
  credential_keys: [credentialKey],
  credential_expires_at_ms: { [credentialKey]: expiry },
});
const refreshRow = (status: string, expiry: number) => ({
  provider_name: 'google-workspace',
  provider_id: 'google-id',
  credential_key: credentialKey,
  status,
  expires_at_ms: expiry,
  refresh_generation_id: 'generation',
  last_refresh_at_ms: Date.now() - 1000,
});
function reviewedProfile() {
  return load(
    readFileSync(
      new URL(
        '../../docs/spikes/openshell-codex/google-workspace-spike-profile.yaml',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    id: string;
    resource_version: number;
    source?: string;
    scope?: string;
    inference_capable: boolean;
    endpoints: Array<{
      host: string;
      port: number;
      protocol: string;
      access?: string;
      enforcement: string;
      tls: string;
      rules?: Array<{ allow: { method: string; path: string } }>;
    }>;
    credentials: Array<{
      auth_style: string;
      header_name: string;
      env_vars: string[];
      query_param?: string | null;
    }>;
    binaries: string[];
  };
}
function fixture(state = 'refreshed', expires = Date.now() + 3600000, allowUpdates = true) {
  const refreshedAt = Date.now() - 1000;
  const run = vi.fn(
    async (
      args: readonly string[],
      _options: { env: Record<string, string>; signal: AbortSignal; timeoutMs: number },
    ) => {
      if (args[1] === 'list') return JSON.stringify([providerRow(expires)]);
      if (args[1] === 'profile') {
        const profile = reviewedProfile();
        if (!allowUpdates) profile.endpoints[4].rules!.pop();
        return JSON.stringify(profile);
      }
      if (args[2] === 'status')
        return JSON.stringify({
          credentials: [{ ...refreshRow(state, expires), last_refresh_at_ms: refreshedAt }],
        });
      return '';
    },
  );
  const exportCredentials = vi.fn(async () => JSON.stringify(credentials));
  const request = vi.fn(async (url: string, _init: RequestInit): Promise<unknown> =>
    url.includes('/token')
      ? { access_token: 'SECRET_ACCESS', scope: scopes.join(' '), expires_in: 3600 }
      : { user: { emailAddress: 'user@example.com' } },
  );
  const service = new GoogleWorkspaceManagement({ run, exportCredentials, request });
  return { service, run, request, exportCredentials };
}
describe('Google Workspace management', () => {
  const drifts: Array<[string, (profile: ReturnType<typeof reviewedProfile>) => void]> = [
    [
      'Drive writes',
      (profile) => {
        profile.endpoints[0].access = 'read-write';
      },
    ],
    [
      'unenforced Docs',
      (profile) => {
        profile.endpoints[1].enforcement = 'audit';
      },
    ],
    [
      'uninspected TLS',
      (profile) => {
        profile.endpoints[2].tls = 'passthrough';
      },
    ],
    [
      'unexpected endpoint',
      (profile) => {
        profile.endpoints.push({ ...profile.endpoints[0], host: 'evil.example' });
      },
    ],
    [
      'duplicate endpoint',
      (profile) => {
        profile.endpoints.push({ ...profile.endpoints[0] });
      },
    ],
    [
      'missing read boundary',
      (profile) => {
        profile.endpoints.splice(3, 1);
      },
    ],
    [
      'broad Slides writes',
      (profile) => {
        profile.endpoints[4].rules!.push({ allow: { method: 'POST', path: '/**' } });
      },
    ],
    [
      'Drive POST rule',
      (profile) => {
        profile.endpoints[0].rules = [{ allow: { method: 'POST', path: '/drive/**' } }];
      },
    ],
    [
      'unexpected port',
      (profile) => {
        profile.endpoints[0].port = 80;
      },
    ],
    [
      'wrong authorization header',
      (profile) => {
        profile.credentials[0].header_name = 'cookie';
      },
    ],
    [
      'query token',
      (profile) => {
        profile.credentials[0].query_param = 'access_token';
      },
    ],
    [
      'wrong credential variable',
      (profile) => {
        profile.credentials[0].env_vars = ['OTHER_TOKEN'];
      },
    ],
    [
      'inference capability',
      (profile) => {
        profile.inference_capable = true;
      },
    ],
    [
      'unexpected binary',
      (profile) => {
        profile.binaries.push('/usr/bin/sh');
      },
    ],
  ];
  it.each(drifts)(
    'blocks reconnect before credentials or OAuth requests on %s drift',
    async (_name, mutate) => {
      const { service, run, request, exportCredentials } = fixture();
      const original = run.getMockImplementation()!;
      run.mockImplementation(async (args, options) => {
        if (args[1] === 'profile') {
          const profile = reviewedProfile();
          mutate(profile);
          return JSON.stringify(profile);
        }
        return original(args, options);
      });
      await expect(
        service.reconnect('user@example.com', AbortSignal.timeout(1000)),
      ).rejects.toThrow('reviewed policy');
      expect(exportCredentials).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(
        run.mock.calls.some(([args]) => args.includes('configure') || args.includes('rotate')),
      ).toBe(false);
      expect(await service.status(AbortSignal.timeout(1000))).toEqual({
        health: 'unavailable',
        expiresAt: null,
        slidesEditing: false,
      });
    },
  );
  it('accepts reviewed policy with normal export metadata and reordered semantic sets', async () => {
    const { service, run } = fixture();
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (args, options) => {
      if (args[1] === 'profile') {
        const profile = reviewedProfile();
        profile.source = 'imported';
        profile.scope = 'workspace';
        profile.resource_version++;
        profile.credentials[0].query_param = null;
        profile.endpoints.reverse();
        profile.binaries.reverse();
        return JSON.stringify(profile);
      }
      return original(args, options);
    });
    expect(await service.status(AbortSignal.timeout(1000))).toMatchObject({
      health: 'ready',
      slidesEditing: true,
    });
    await service.reconnect('user@example.com', AbortSignal.timeout(1000));
    expect(run.mock.calls.some(([args]) => args.includes('configure'))).toBe(true);
  });
  it('does not advertise readiness if policy changes between credential observations', async () => {
    const { service, run } = fixture();
    const original = run.getMockImplementation()!;
    let exports = 0;
    run.mockImplementation(async (args, options) => {
      if (args[1] === 'profile' && ++exports > 1) {
        const profile = reviewedProfile();
        profile.endpoints[0].access = 'read-write';
        return JSON.stringify(profile);
      }
      return original(args, options);
    });
    expect(await service.status(AbortSignal.timeout(1000))).toEqual({
      health: 'unavailable',
      expiresAt: null,
      slidesEditing: false,
    });
  });
  it('blocks account preview before requesting a host grant under unsafe policy', async () => {
    const { service, run, exportCredentials, request } = fixture();
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (args, options) => {
      if (args[1] === 'profile') {
        const profile = reviewedProfile();
        profile.endpoints[0].access = 'read-write';
        return JSON.stringify(profile);
      }
      return original(args, options);
    });
    await expect(service.preview(AbortSignal.timeout(1000))).rejects.toThrow('reviewed policy');
    expect(exportCredentials).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['reconnect', 'rotate'])(
    'rechecks %s policy after refresh status before its mutation',
    async (action) => {
      const { service, run } = fixture();
      const original = run.getMockImplementation()!;
      let drift = false;
      run.mockImplementation(async (args, options) => {
        if (args[2] === 'status') drift = true;
        if (args[1] === 'profile' && drift) {
          const profile = reviewedProfile();
          profile.endpoints[0].access = 'read-write';
          return JSON.stringify(profile);
        }
        return original(args, options);
      });
      const signal = AbortSignal.timeout(1000);
      await expect(
        action === 'reconnect'
          ? service.reconnect('user@example.com', signal)
          : service.rotate(signal),
      ).rejects.toThrow('reviewed policy');
      expect(
        run.mock.calls.some(([args]) => args.includes('configure') || args.includes('rotate')),
      ).toBe(false);
    },
  );
  it('does not rotate an imported grant when policy drifts during configuration', async () => {
    const { service, run } = fixture();
    const original = run.getMockImplementation()!;
    let configured = false;
    run.mockImplementation(async (args, options) => {
      if (args[2] === 'configure') configured = true;
      if (args[1] === 'profile' && configured) {
        const profile = reviewedProfile();
        profile.endpoints[0].access = 'read-write';
        return JSON.stringify(profile);
      }
      return original(args, options);
    });
    await expect(service.reconnect('user@example.com', AbortSignal.timeout(1000))).rejects.toThrow(
      'reviewed policy',
    );
    expect(run.mock.calls.some(([args]) => args.includes('configure'))).toBe(true);
    expect(run.mock.calls.some(([args]) => args.includes('rotate'))).toBe(false);
  });
  it('rechecks policy after host identity verification before installing refresh material', async () => {
    const { service, run } = fixture();
    const original = run.getMockImplementation()!;
    let exports = 0;
    run.mockImplementation(async (args, options) => {
      if (args[1] === 'profile' && ++exports > 1) {
        const profile = reviewedProfile();
        profile.endpoints[0].access = 'read-write';
        return JSON.stringify(profile);
      }
      return original(args, options);
    });
    await expect(service.reconnect('user@example.com', AbortSignal.timeout(1000))).rejects.toThrow(
      'reviewed policy',
    );
    expect(run.mock.calls.some(([args]) => args.includes('configure'))).toBe(false);
  });

  it('keeps a newly configured refresh pending rather than demanding sign-in again', async () => {
    const { service } = fixture('scheduled', 1);
    expect((await service.status(AbortSignal.timeout(1000))).health).toBe('unavailable');
  });
  it.each(['scheduled', 'active', 'refreshing', 'error'])(
    'does not report %s as ready while an old credential is unexpired',
    async (state) => {
      const { service } = fixture(state);
      expect((await service.status(AbortSignal.timeout(1000))).health).toBe('unavailable');
    },
  );
  it.each(['not_installed', 'wrong_expiry', 'replaced', 'changed_revision', 'no_refresh_proof'])(
    'requires stable installed credential proof: %s',
    async (failure) => {
      const expiry = Date.now() + 3600000;
      const { service, run } = fixture('refreshed', expiry);
      let census = 0;
      const original = run.getMockImplementation()!;
      run.mockImplementation(async (args, options) => {
        if (args[1] === 'list') {
          const row = providerRow(expiry);
          census++;
          if (failure === 'not_installed') row.credential_keys = [];
          if (failure === 'wrong_expiry')
            row.credential_expires_at_ms[credentialKey] = expiry - 1000;
          if (census > 1 && failure === 'replaced') row.id = 'replacement';
          if (census > 1 && failure === 'changed_revision') row.resource_version++;
          return JSON.stringify([row]);
        }
        if (args[2] === 'status' && failure === 'no_refresh_proof')
          return JSON.stringify({
            credentials: [{ ...refreshRow('refreshed', expiry), last_refresh_at_ms: 0 }],
          });
        return original(args, options);
      });
      expect((await service.status(AbortSignal.timeout(1000))).health).toBe('unavailable');
    },
  );
  it.each(['rotate', 'reconnect'])(
    'does not confirm %s from a previously successful refresh',
    async (action) => {
      const { service } = fixture();
      const signal = AbortSignal.timeout(1000);
      const result =
        action === 'rotate'
          ? await service.rotate(signal)
          : await service.reconnect('user@example.com', signal);
      expect(result.health).toBe('unavailable');
    },
  );
  it.each(['rotate', 'reconnect', 'failed_rotation'])(
    'keeps the refresh fence across status polls after %s',
    async (action) => {
      const expiry = Date.now() + 3600000;
      const { service, run } = fixture('refreshed', expiry);
      const original = run.getMockImplementation()!;
      let installedNew = false;
      const previousRefreshAt = Date.now() - 1000;
      run.mockImplementation(async (args, options) => {
        if (args[2] === 'rotate' && action === 'failed_rotation') throw new Error('Gateway failed');
        if (args[2] === 'status')
          return JSON.stringify({
            credentials: [
              {
                ...refreshRow('refreshed', expiry),
                last_refresh_at_ms: previousRefreshAt + (installedNew ? 500 : 0),
              },
            ],
          });
        return original(args, options);
      });
      const signal = AbortSignal.timeout(1000);
      if (action === 'failed_rotation')
        await expect(service.rotate(signal)).rejects.toThrow('could not be confirmed');
      else {
        const result =
          action === 'rotate'
            ? await service.rotate(signal)
            : await service.reconnect('user@example.com', signal);
        expect(result.health).toBe('unavailable');
      }
      expect((await service.status(signal)).health).toBe('unavailable');
      expect((await service.status(signal)).health).toBe('unavailable');
      installedNew = true;
      expect((await service.status(signal)).health).toBe('ready');
      expect((await service.status(signal)).health).toBe('ready');
    },
  );
  it('confirms rotation only once a newer refresh is installed', async () => {
    const expiry = Date.now() + 3600000;
    const { service, run } = fixture('refreshed', expiry);
    const original = run.getMockImplementation()!;
    let rotated = false;
    run.mockImplementation(async (args, options) => {
      if (args[2] === 'rotate') rotated = true;
      if (args[2] === 'status')
        return JSON.stringify({
          credentials: [
            {
              ...refreshRow('refreshed', expiry),
              last_refresh_at_ms: Date.now() - (rotated ? 500 : 1000),
            },
          ],
        });
      return original(args, options);
    });
    expect((await service.rotate(AbortSignal.timeout(1000))).health).toBe('ready');
  });
  it('does not advertise editing when only blank presentation creation is allowed', async () => {
    const { service } = fixture('refreshed', Date.now() + 3600000, false);
    expect((await service.status(AbortSignal.timeout(1000))).slidesEditing).toBe(false);
  });
  it.each([
    ['reauthorization_required', Date.now() + 3600000],
    ['refreshed', Date.now() - 1],
  ])('does not treat attached but %s credentials as healthy', async (state, expiry) => {
    const { service } = fixture(state as string, expiry as number);
    expect((await service.status(AbortSignal.timeout(1000))).health).toBe('needs_sign_in');
  });
  it('reports refresh health and Slides access without secret material', async () => {
    const { service } = fixture();
    const result = await service.status(AbortSignal.timeout(1000));
    expect(result).toMatchObject({ health: 'ready', slidesEditing: true });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('rejects an account switch before updating the gateway', async () => {
    const { service, run } = fixture();
    await expect(service.reconnect('other@example.com', AbortSignal.timeout(1000))).rejects.toThrow(
      'Google account changed',
    );
    expect(
      run.mock.calls.some(([args]) => args.includes('configure') || args.includes('rotate')),
    ).toBe(false);
  });
  it('uses encrypted gateway refresh, never secrets in command arguments, and omits Gmail scopes', async () => {
    const { service, run, request } = fixture();
    await service.reconnect('user@example.com', AbortSignal.timeout(1000));
    const call = run.mock.calls.find(([args]) => args.includes('configure'))!;
    expect(JSON.stringify(call[0])).not.toContain('SECRET_CLIENT');
    expect(JSON.stringify(call[0])).not.toContain('SECRET_REFRESH');
    expect(JSON.stringify(call[0])).not.toContain('gmail.');
    expect(call[1].env).toMatchObject({
      MITZO_GWS_CLIENT_SECRET: 'SECRET_CLIENT',
      MITZO_GWS_REFRESH_TOKEN: 'SECRET_REFRESH',
    });
    expect(String(request.mock.calls[0][1].body)).toContain('scope=');
  });
  it('redacts failures from gws and the gateway', async () => {
    const { service, run } = fixture();
    run.mockRejectedValueOnce(new Error('SECRET_REFRESH'));
    expect(await service.status(AbortSignal.timeout(1000))).toMatchObject({
      health: 'unavailable',
    });
  });
  it('refuses a broader token than requested before persistence', async () => {
    const { service, request, run } = fixture();
    request.mockResolvedValueOnce({
      access_token: 'SECRET_ACCESS',
      scope: scopes.join(' ') + ' https://www.googleapis.com/auth/gmail.modify',
      expires_in: 3600,
    });
    await expect(service.reconnect('user@example.com', AbortSignal.timeout(1000))).rejects.toThrow(
      'Google scope mismatch',
    );
    expect(
      run.mock.calls.some(([args]) => args.includes('configure') || args.includes('rotate')),
    ).toBe(false);
  });
});
