import { describe, expect, it, vi } from 'vitest';
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
function fixture(state = 'refreshed', expires = Date.now() + 3600000, allowUpdates = true) {
  const refreshedAt = Date.now() - 1000;
  const run = vi.fn(
    async (
      args: readonly string[],
      _options: { env: Record<string, string>; signal: AbortSignal; timeoutMs: number },
    ) => {
      if (args[1] === 'list') return JSON.stringify([providerRow(expires)]);
      if (args[1] === 'profile')
        return JSON.stringify({
          endpoints: [
            {
              host: 'slides.googleapis.com',
              rules: [
                { allow: { method: 'POST', path: '/v1/presentations' } },
                ...(allowUpdates
                  ? [{ allow: { method: 'POST', path: '/v1/presentations/*:batchUpdate' } }]
                  : []),
              ],
            },
          ],
        });
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
  return { service, run, request };
}
describe('Google Workspace management', () => {
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
    expect(run).not.toHaveBeenCalled();
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
    expect(run).not.toHaveBeenCalled();
  });
});
