// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectionSetupView } from '../ConnectionSetupView';
import * as api from '../../lib/credential-connections-api';
import type { ConnectionSetup } from '../../types/credential-connections';
vi.mock('../../lib/credential-connections-api', () => ({
  getConnectionSetup: vi.fn(),
  getCachedCredentialAuthorization: vi.fn(),
  reauthorizeKeychain: vi.fn(),
  completeConnectionSetup: vi.fn(),
  cancelConnectionSetup: vi.fn(),
}));
const setup: ConnectionSetup = {
  id: 'draft-a',
  sessionId: 'chat/a',
  revision: 1,
  status: 'pending',
  expiresAt: Date.now() + 1_800_000,
  profile: 'home-assistant',
  setupUrl: '/connections/setup/draft-a',
  connection: {
    label: 'Home Assistant',
    endpoint: 'https://ha.example.com',
    auth: { kind: 'bearer' },
    paths: ['/api/'],
    methods: ['GET', 'HEAD', 'POST'],
    allowPrivateNetwork: false,
  },
  credential: {
    label: 'Home Assistant key',
    helpUrl: 'https://www.home-assistant.io/docs/authentication/',
    instructions: 'Create a long-lived access token in your Home Assistant profile.',
  },
};
function open(id = 'draft-a') {
  return render(
    <MemoryRouter initialEntries={['/connections/setup/' + id]}>
      <Routes>
        <Route path="/connections/setup/:setupId" element={<ConnectionSetupView />} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getConnectionSetup).mockResolvedValue(setup);
  vi.mocked(api.reauthorizeKeychain).mockResolvedValue({
    csrf: 'csrf',
    expiresAt: Date.now() + 60_000,
  });
  vi.mocked(api.completeConnectionSetup).mockResolvedValue({
    ...setup,
    status: 'ready',
    revision: 2,
    connectionId: 'ha',
  });
});
afterEach(cleanup);
it('presents only the prepared credential and plain access scope, then returns to the original chat', async () => {
  open();
  await screen.findByLabelText('Home Assistant key');
  expect(screen.getByText('https://ha.example.com')).toBeTruthy();
  expect(screen.getByText('Read and make changes')).toBeTruthy();
  expect(screen.queryByLabelText('Authentication')).toBeNull();
  expect(screen.queryByLabelText(/WebSocket/)).toBeNull();
  fireEvent.change(screen.getByLabelText('Mitzo passphrase'), {
    target: { value: 'fixture-passphrase' },
  });
  fireEvent.change(screen.getByLabelText('Home Assistant key'), {
    target: { value: 'fixture-only-secret' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect Home Assistant' }));
  await screen.findByRole('heading', { name: 'Home Assistant is connected' });
  expect(api.completeConnectionSetup).toHaveBeenCalledWith(
    'draft-a',
    1,
    'fixture-only-secret',
    'csrf',
  );
  expect(screen.getByRole('link', { name: 'Return to chat' }).getAttribute('href')).toBe(
    '/chat/chat%2Fa',
  );
  expect(screen.queryByLabelText('Home Assistant key')).toBeNull();
});
it('keeps required reauthorization inline and clears both secrets before completion settles', async () => {
  vi.mocked(api.reauthorizeKeychain).mockResolvedValue({
    csrf: 'new-csrf',
    expiresAt: Date.now() + 60_000,
  });
  let finish!: (value: ConnectionSetup) => void;
  vi.mocked(api.completeConnectionSetup).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  open();
  await screen.findByLabelText('Mitzo passphrase');
  fireEvent.change(screen.getByLabelText('Home Assistant key'), {
    target: { value: 'fixture-key' },
  });
  fireEvent.change(screen.getByLabelText('Mitzo passphrase'), {
    target: { value: 'fixture-passphrase' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect Home Assistant' }));
  await waitFor(() => expect(api.completeConnectionSetup).toHaveBeenCalled());
  expect((screen.getByLabelText('Home Assistant key') as HTMLInputElement).value).toBe('');
  expect(
    (screen.queryByLabelText('Mitzo passphrase') as HTMLInputElement | null)?.value ?? '',
  ).toBe('');
  finish({
    ...setup,
    status: 'pending',
    revision: 2,
    error: 'The key could not be verified. Try a new key.',
  });
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('could not be verified');
});
it('disables expired setup and preserves a route back to the original task', async () => {
  vi.mocked(api.getConnectionSetup).mockResolvedValue({ ...setup, status: 'expired' });
  open();
  await screen.findByRole('heading', { name: 'This setup has expired' });
  expect(screen.queryByLabelText('Home Assistant key')).toBeNull();
  expect(screen.getByRole('link', { name: 'Return to chat' })).toBeTruthy();
});
it('cancels a prepared connection without enrolling it', async () => {
  vi.mocked(api.cancelConnectionSetup).mockResolvedValue({
    ...setup,
    status: 'cancelled',
    revision: 2,
  });
  open();
  await screen.findByLabelText('Home Assistant key');
  fireEvent.change(screen.getByLabelText('Mitzo passphrase'), {
    target: { value: 'fixture-passphrase' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel setup' }));
  await screen.findByRole('heading', { name: 'Setup cancelled' });
  expect(api.cancelConnectionSetup).toHaveBeenCalledWith('draft-a', 1, 'csrf');
  expect(api.completeConnectionSetup).not.toHaveBeenCalled();
});
it('reloads status after an uncertain completion without blindly resending a credential', async () => {
  vi.mocked(api.completeConnectionSetup).mockRejectedValue(new Error('Network interrupted'));
  open();
  await screen.findByLabelText('Home Assistant key');
  fireEvent.change(screen.getByLabelText('Home Assistant key'), {
    target: { value: 'fixture-key' },
  });
  fireEvent.change(screen.getByLabelText('Mitzo passphrase'), {
    target: { value: 'fixture-passphrase' },
  });
  vi.mocked(api.getConnectionSetup).mockResolvedValue({ ...setup, status: 'ready', revision: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'Connect Home Assistant' }));
  await screen.findByRole('heading', { name: 'Home Assistant is connected' });
  expect(api.completeConnectionSetup).toHaveBeenCalledTimes(1);
});
it('asks only for the service key when secure storage is already authorized in this browser', async () => {
  vi.mocked(api.getCachedCredentialAuthorization).mockReturnValue({
    csrf: 'cached-csrf',
    expiresAt: Date.now() + 60_000,
  });
  open();
  await screen.findByLabelText('Home Assistant key');
  expect(screen.queryByLabelText('Mitzo passphrase')).toBeNull();
  fireEvent.change(screen.getByLabelText('Home Assistant key'), {
    target: { value: 'fixture-key' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect Home Assistant' }));
  await screen.findByRole('heading', { name: 'Home Assistant is connected' });
  expect(api.reauthorizeKeychain).not.toHaveBeenCalled();
  expect(api.completeConnectionSetup).toHaveBeenCalledWith(
    'draft-a',
    1,
    'fixture-key',
    'cached-csrf',
  );
});
it('drops view authorization after a refused completion and asks for the passphrase again', async () => {
  vi.mocked(api.getCachedCredentialAuthorization).mockReturnValue({
    csrf: 'revoked-csrf',
    expiresAt: Date.now() + 60_000,
  });
  vi.mocked(api.completeConnectionSetup).mockRejectedValue(new Error('Authorize again'));
  open();
  await screen.findByLabelText('Home Assistant key');
  fireEvent.change(screen.getByLabelText('Home Assistant key'), {
    target: { value: 'fixture-key' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect Home Assistant' }));
  await screen.findByLabelText('Mitzo passphrase');
  expect((screen.getByLabelText('Home Assistant key') as HTMLInputElement).value).toBe('');
});
it('explains how to continue when the verified connection has not reached the assistant yet', async () => {
  vi.mocked(api.getConnectionSetup).mockResolvedValue({
    ...setup,
    status: 'ready',
    delivery: 'pending',
  });
  open();
  await screen.findByRole('heading', { name: 'Home Assistant is connected' });
  expect(screen.getByText(/tell your assistant the connection is ready/)).toBeTruthy();
});
