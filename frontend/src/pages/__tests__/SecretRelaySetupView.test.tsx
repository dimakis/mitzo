// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionSetupView } from '../ConnectionSetupView';
import * as api from '../../lib/credential-connections-api';
vi.mock('../../lib/credential-connections-api', () => ({
  getSecretRelay: vi.fn(),
  completeSecretRelay: vi.fn(),
  cancelSecretRelay: vi.fn(),
  getCachedCredentialAuthorization: vi.fn(() => ({ csrf: 'csrf', expiresAt: Date.now() + 60000 })),
  reauthorizeKeychain: vi.fn(),
}));
afterEach(cleanup);
it('reviews exact destinations, submits privately and clears the input before continuing to the original chat', async () => {
  const relay = {
    id: 'relay',
    sessionId: 'chat',
    revision: 1,
    status: 'pending' as const,
    expiresAt: Date.now() + 60000,
    label: 'MQTT password',
    setupUrl: '/connections/secrets/relay',
    outcomes: [],
    targets: [
      {
        connectionId: 'ha',
        revision: 1,
        endpoint: 'https://ha.test',
        label: 'Home Assistant',
        path: '/api/set',
        method: 'POST' as const,
        encoding: 'json' as const,
        body: '{"password":null}',
        fields: ['/password'],
      },
    ],
  };
  vi.mocked(api.getSecretRelay).mockResolvedValue(relay);
  vi.mocked(api.completeSecretRelay).mockResolvedValue({
    ...relay,
    status: 'ready',
    revision: 3,
    delivery: 'delivered',
  });
  render(
    <MemoryRouter initialEntries={['/connections/secrets/relay']}>
      <Routes>
        <Route path="/connections/secrets/:setupId" element={<ConnectionSetupView secretRelay />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('https://ha.test');
  expect(screen.getByText('POST /api/set')).toBeTruthy();
  const input = screen.getByLabelText('Password or token') as HTMLInputElement;
  expect(input.type).toBe('password');
  fireEvent.change(input, { target: { value: 'private-fixture' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save securely and continue' }));
  await waitFor(() =>
    expect(api.completeSecretRelay).toHaveBeenCalledWith('relay', 1, 'private-fixture', 'csrf'),
  );
  expect(document.body.textContent).not.toContain('private-fixture');
  const back = await screen.findByRole('link', { name: 'Return to chat' });
  expect(back.getAttribute('href')).toBe('/chat/chat');
});

it('allows revoking ready relay access without re-entering the value', async () => {
  const relay = {
    id: 'ready',
    sessionId: 'chat',
    revision: 3,
    status: 'ready' as const,
    delivery: 'delivered' as const,
    expiresAt: Date.now() + 60000,
    label: 'MQTT password',
    setupUrl: '/connections/secrets/ready',
    outcomes: [],
    targets: [],
  };
  vi.mocked(api.getSecretRelay).mockResolvedValue(relay);
  vi.mocked(api.cancelSecretRelay).mockResolvedValue({
    ...relay,
    status: 'cancelled',
    revision: 4,
  });
  render(
    <MemoryRouter initialEntries={['/connections/secrets/ready']}>
      <Routes>
        <Route path="/connections/secrets/:setupId" element={<ConnectionSetupView secretRelay />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke relay access' }));
  await waitFor(() => expect(api.cancelSecretRelay).toHaveBeenCalledWith('ready', 3, 'csrf'));
  expect(screen.queryByLabelText('Password or token')).toBeNull();
});
