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
function fixture(state = 'refreshed', expires = Date.now() + 3600000) {
  const run = vi.fn(
    async (
      args: readonly string[],
      _options: { env: Record<string, string>; signal: AbortSignal; timeoutMs: number },
    ) => {
      if (args[1] === 'list')
        return JSON.stringify([{ name: 'google-workspace', type: 'mitzo-google-workspace-spike' }]);
      if (args[1] === 'profile')
        return JSON.stringify({
          endpoints: [
            {
              host: 'slides.googleapis.com',
              rules: [{ allow: { method: 'POST', path: '/v1/presentations' } }],
            },
          ],
        });
      if (args[2] === 'status')
        return JSON.stringify({
          credentials: [
            { credential_key: 'GOOGLE_WORKSPACE_CLI_TOKEN', status: state, expires_at_ms: expires },
          ],
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
