// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CredentialConnectionsPanel } from '../CredentialConnectionsPanel';
import * as api from '../../lib/credential-connections-api';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../../lib/credential-connections-api', () => ({
  getCredentialConnections: vi.fn(),
  reauthorizeKeychain: vi.fn(),
  createCredentialConnection: vi.fn(),
  rotateCredentialConnection: vi.fn(),
  testCredentialConnection: vi.fn(),
  disableCredentialConnection: vi.fn(),
  getConnectionSessions: vi.fn(),
  revokeConnectionSession: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getCredentialConnections).mockResolvedValue([]);
  vi.mocked(api.reauthorizeKeychain).mockResolvedValue({
    csrf: 'csrf',
    expiresAt: Date.now() + 60_000,
  });
  vi.mocked(api.getConnectionSessions).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function authorize() {
  fireEvent.change(screen.getByLabelText('Keychain setup passphrase'), {
    target: { value: 'password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize Keychain changes' }));
  await waitFor(() => expect(api.reauthorizeKeychain).toHaveBeenCalledWith('password'));
  await screen.findByText('Keychain changes authorized.');
}
it('saves a Home Assistant connection securely and clears secret fields on failure', async () => {
  vi.mocked(api.createCredentialConnection).mockRejectedValue(
    new Error('Unlock Apple Keychain on the Mac, then retry'),
  );
  render(<CredentialConnectionsPanel />);
  await screen.findByLabelText('Service address');
  await authorize();
  fireEvent.change(screen.getByLabelText('Service address'), {
    target: { value: 'https://ha.example.com' },
  });
  fireEvent.change(screen.getByLabelText('Token or password'), {
    target: { value: 'private-token' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText('Unlock Apple Keychain on the Mac, then retry');
  expect(api.createCredentialConnection).toHaveBeenCalledWith(
    expect.objectContaining({
      secret: 'private-token',
      connection: expect.objectContaining({
        auth: { kind: 'bearer' },
        paths: ['/api/'],
        methods: ['GET', 'HEAD'],
      }),
    }),
    'csrf',
  );
  expect((screen.getByLabelText('Token or password') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Keychain setup passphrase') as HTMLInputElement).value).toBe('');
});
it('links a specific existing generic Keychain item without requesting its password', async () => {
  render(<CredentialConnectionsPanel />);
  await screen.findByLabelText('Service address');
  await authorize();
  fireEvent.change(screen.getByLabelText('Service address'), {
    target: { value: 'https://ha.example.com' },
  });
  fireEvent.change(screen.getByLabelText('Credential source'), { target: { value: 'existing' } });
  fireEvent.change(screen.getByLabelText('Keychain service'), {
    target: { value: 'existing-service' },
  });
  fireEvent.change(screen.getByLabelText('Keychain account'), { target: { value: 'alice' } });
  expect(screen.queryByLabelText('Token or password')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await waitFor(() =>
    expect(api.createCredentialConnection).toHaveBeenCalledWith(
      expect.objectContaining({ existing: { service: 'existing-service', account: 'alice' } }),
      'csrf',
    ),
  );
});
it('requires reauthorization before enrollment and shows setup errors without hiding Jira connections', async () => {
  render(<CredentialConnectionsPanel />);
  await screen.findByLabelText('Service address');
  fireEvent.change(screen.getByLabelText('Service address'), {
    target: { value: 'https://ha.example.com' },
  });
  fireEvent.change(screen.getByLabelText('Token or password'), {
    target: { value: 'private-token' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText('Authorize Keychain changes before continuing.');
  expect(api.createCredentialConnection).not.toHaveBeenCalled();
});
it('shows session access and revokes the selected session only', async () => {
  vi.mocked(api.getCredentialConnections).mockResolvedValue([
    {
      id: 'ha',
      label: 'Home Assistant',
      endpoint: 'https://ha.example.com',
      auth: { kind: 'bearer' },
      paths: ['/api/'],
      methods: ['GET'],
      allowPrivateNetwork: false,
      status: 'active',
      revision: 1,
      verifiedAt: null,
    },
  ]);
  vi.mocked(api.getConnectionSessions).mockResolvedValue([{ sessionId: 'session-a', revision: 1 }]);
  render(<CredentialConnectionsPanel />);
  await screen.findByRole('button', { name: 'Session access' });
  await authorize();
  fireEvent.click(screen.getByRole('button', { name: 'Session access' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke session-a' }));
  await waitFor(() =>
    expect(api.revokeConnectionSession).toHaveBeenCalledWith('ha', 'session-a', 1, 'csrf'),
  );
});

const homeAssistant = {
  id: 'ha',
  label: 'Home Assistant',
  endpoint: 'https://ha.example.com',
  auth: { kind: 'bearer' as const },
  paths: ['/api/'],
  methods: ['GET' as const],
  allowPrivateNetwork: false,
  status: 'active' as const,
  revision: 1,
  verifiedAt: null,
};
it('clears a submitted credential when authorization has expired', async () => {
  render(<CredentialConnectionsPanel />);
  await screen.findByLabelText('Service address');
  await authorize();
  fireEvent.change(screen.getByLabelText('Service address'), {
    target: { value: 'https://ha.example.com' },
  });
  fireEvent.change(screen.getByLabelText('Token or password'), {
    target: { value: 'private-token' },
  });
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText('Authorize Keychain changes before continuing.');
  expect(api.createCredentialConnection).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Token or password') as HTMLInputElement).value).toBe('');
});
it('clears credentials when changing authentication, template or credential source', async () => {
  render(<CredentialConnectionsPanel />);
  await screen.findByLabelText('Token or password');
  const enterSecret = () =>
    fireEvent.change(screen.getByLabelText('Token or password'), {
      target: { value: 'private-token' },
    });
  enterSecret();
  fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'basic' } });
  expect((screen.getByLabelText('Token or password') as HTMLInputElement).value).toBe('');
  expect(screen.getByLabelText('Token or password').getAttribute('autocomplete')).toBe(
    'current-password',
  );
  enterSecret();
  fireEvent.change(screen.getByLabelText('Service template'), { target: { value: 'custom' } });
  expect((screen.getByLabelText('Token or password') as HTMLInputElement).value).toBe('');
  enterSecret();
  fireEvent.change(screen.getByLabelText('Credential source'), { target: { value: 'existing' } });
  fireEvent.change(screen.getByLabelText('Credential source'), { target: { value: 'new' } });
  expect((screen.getByLabelText('Token or password') as HTMLInputElement).value).toBe('');
});
it('refreshes status and drops cached grants even when rotation fails after revoking access', async () => {
  vi.mocked(api.getCredentialConnections).mockResolvedValue([homeAssistant]);
  vi.mocked(api.getConnectionSessions).mockResolvedValue([{ sessionId: 'session-a', revision: 1 }]);
  vi.mocked(api.rotateCredentialConnection).mockImplementation(async () => {
    vi.mocked(api.getCredentialConnections).mockResolvedValue([
      { ...homeAssistant, status: 'disabled', revision: 2 },
    ]);
    throw new Error('Unlock Apple Keychain on the Mac, then retry');
  });
  render(<CredentialConnectionsPanel />);
  await screen.findByRole('button', { name: 'Session access' });
  await authorize();
  fireEvent.click(screen.getByRole('button', { name: 'Session access' }));
  await screen.findByRole('button', { name: 'Revoke session-a' });
  fireEvent.click(screen.getByRole('button', { name: 'Update credential' }));
  fireEvent.change(screen.getByLabelText('New credential for Home Assistant'), {
    target: { value: 'replacement' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save updated credential' }));
  await screen.findByText('Unlock Apple Keychain on the Mac, then retry');
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull());
  expect(screen.queryByRole('button', { name: 'Revoke session-a' })).toBeNull();
  expect(api.rotateCredentialConnection).toHaveBeenCalledWith('ha', 1, 'replacement', 'csrf');
});
it('clears replacement credentials on a denied submission and allows canceling rotation', async () => {
  vi.mocked(api.getCredentialConnections).mockResolvedValue([homeAssistant]);
  render(<CredentialConnectionsPanel />);
  await screen.findByRole('button', { name: 'Update credential' });
  fireEvent.click(screen.getByRole('button', { name: 'Update credential' }));
  fireEvent.change(screen.getByLabelText('New credential for Home Assistant'), {
    target: { value: 'replacement' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save updated credential' }));
  await screen.findByText('Authorize Keychain changes before continuing.');
  expect(api.rotateCredentialConnection).not.toHaveBeenCalled();
  expect(
    (screen.getByLabelText('New credential for Home Assistant') as HTMLInputElement).value,
  ).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByLabelText('New credential for Home Assistant')).toBeNull();
});
it('surfaces session-list errors and retries without requiring a credential', async () => {
  vi.mocked(api.getCredentialConnections).mockResolvedValue([homeAssistant]);
  vi.mocked(api.getConnectionSessions).mockRejectedValueOnce(new Error('Unable to load access'));
  render(<CredentialConnectionsPanel />);
  await screen.findByRole('button', { name: 'Session access' });
  fireEvent.click(screen.getByRole('button', { name: 'Session access' }));
  await screen.findByText('Unable to load access');
  fireEvent.click(screen.getByRole('button', { name: 'Session access' }));
  await screen.findByText('No sessions have access.');
});

it('shows when authorization expires without waiting for another action', async () => {
  vi.mocked(api.reauthorizeKeychain).mockImplementation(async () => ({
    csrf: 'csrf',
    expiresAt: Date.now() + 100,
  }));
  render(<CredentialConnectionsPanel />);
  await screen.findByLabelText('Service address');
  await authorize();
  await screen.findByText('Keychain authorization expired. Authorize changes again to continue.');
});
it('uses the returned expiry for the authorization status', async () => {
  const expiry = Date.now() + 60_000;
  vi.mocked(api.reauthorizeKeychain).mockResolvedValue({ csrf: 'csrf', expiresAt: expiry });
  render(<CredentialConnectionsPanel />);
  await screen.findByLabelText('Service address');
  await authorize();
  expect(
    screen.getByText(`Changes authorized until ${new Date(expiry).toLocaleTimeString()}.`),
  ).toBeTruthy();
});
it('rotates successfully, clearing the replacement secret and previously listed sessions', async () => {
  vi.mocked(api.getCredentialConnections).mockResolvedValue([homeAssistant]);
  vi.mocked(api.getConnectionSessions).mockResolvedValue([{ sessionId: 'session-a', revision: 1 }]);
  render(<CredentialConnectionsPanel />);
  await screen.findByRole('button', { name: 'Update credential' });
  await authorize();
  fireEvent.click(screen.getByRole('button', { name: 'Session access' }));
  await screen.findByRole('button', { name: 'Revoke session-a' });
  fireEvent.click(screen.getByRole('button', { name: 'Update credential' }));
  fireEvent.change(screen.getByLabelText('New credential for Home Assistant'), {
    target: { value: 'replacement' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save updated credential' }));
  await screen.findByText('Credential updated. Each chat needs fresh approval.');
  expect(screen.queryByLabelText('New credential for Home Assistant')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Revoke session-a' })).toBeNull();
});
it('clears the old authorization when a reauthorization attempt fails', async () => {
  render(<CredentialConnectionsPanel />);
  await screen.findByLabelText('Service address');
  await authorize();
  vi.mocked(api.reauthorizeKeychain).mockRejectedValue(new Error('Incorrect passphrase'));
  fireEvent.change(screen.getByLabelText('Keychain setup passphrase'), {
    target: { value: 'wrong' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize Keychain changes' }));
  await screen.findByText('Incorrect passphrase');
  fireEvent.change(screen.getByLabelText('Service address'), {
    target: { value: 'https://ha.example.com' },
  });
  fireEvent.change(screen.getByLabelText('Token or password'), {
    target: { value: 'private-token' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText('Authorize Keychain changes before continuing.');
  expect(api.createCredentialConnection).not.toHaveBeenCalled();
});
it('handles non-JSON and malformed error responses with a useful API error', async () => {
  const actual = await vi.importActual<typeof api>('../../lib/credential-connections-api');
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('Service unavailable', { status: 503 }));
  await expect(actual.getCredentialConnections()).rejects.toThrow('Connection request failed');
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('null', { status: 403 }));
  await expect(actual.getCredentialConnections()).rejects.toThrow('Connection request failed');
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { internal: true } }), { status: 500 }),
  );
  await expect(actual.getCredentialConnections()).rejects.toThrow('Connection request failed');
});
it('sends mutations with explicit CSRF, encoded identifiers and no caching', async () => {
  const actual = await vi.importActual<typeof api>('../../lib/credential-connections-api');
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
  await actual.revokeConnectionSession('service/id', 'session/id', 2, 'csrf');
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/credential-connections/service%2Fid/sessions/session%2Fid',
    expect.objectContaining({
      method: 'DELETE',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'csrf' },
      body: JSON.stringify({ revision: 2 }),
    }),
  );
});

it('requires an explicit replacement to enable a disabled connection', async () => {
  vi.mocked(api.getCredentialConnections).mockResolvedValue([
    { ...homeAssistant, status: 'disabled', revision: 2 },
  ]);
  render(<CredentialConnectionsPanel />);
  await screen.findByRole('button', { name: 'Replace credential and enable' });
  expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
  await authorize();
  fireEvent.click(screen.getByRole('button', { name: 'Replace credential and enable' }));
  fireEvent.change(screen.getByLabelText('New credential for Home Assistant'), {
    target: { value: 'replacement' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save replacement and enable' }));
  await screen.findByText(
    'Credential replaced and connection enabled. Each chat needs fresh approval.',
  );
  expect(api.rotateCredentialConnection).toHaveBeenCalledWith('ha', 2, 'replacement', 'csrf');
});

it('disables a connection and revokes all access without retaining cached session rows', async () => {
  vi.mocked(api.getCredentialConnections).mockResolvedValue([homeAssistant]);
  vi.mocked(api.getConnectionSessions).mockResolvedValue([{ sessionId: 'session-a', revision: 1 }]);
  vi.mocked(api.disableCredentialConnection).mockImplementation(async () => {
    vi.mocked(api.getCredentialConnections).mockResolvedValue([
      { ...homeAssistant, status: 'disabled', revision: 2 },
    ]);
  });
  render(<CredentialConnectionsPanel />);
  await screen.findByRole('button', { name: 'Session access' });
  await authorize();
  fireEvent.click(screen.getByRole('button', { name: 'Session access' }));
  await screen.findByRole('button', { name: 'Revoke session-a' });
  fireEvent.click(screen.getByRole('button', { name: 'Disable and revoke all access' }));
  await screen.findByText(
    'Connection disabled and all session access revoked. The Keychain item is retained.',
  );
  await screen.findByRole('button', { name: 'Replace credential and enable' });
  expect(screen.queryByRole('button', { name: 'Revoke session-a' })).toBeNull();
  expect(api.disableCredentialConnection).toHaveBeenCalledWith('ha', 1, 'csrf');
});
