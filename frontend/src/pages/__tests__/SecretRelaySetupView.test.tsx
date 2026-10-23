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
  provideSecretRelayCode: vi.fn(),
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

it('reviews browser and MQTT scopes on the private capture page', async () => {
  const relay = {
    id: 'adapters',
    sessionId: 'chat',
    revision: 1,
    status: 'pending' as const,
    expiresAt: Date.now() + 60000,
    label: 'Service password',
    setupUrl: '/connections/secrets/adapters',
    outcomes: [],
    targets: [
      {
        adapter: 'mqtt' as const,
        broker: 'mqtts://broker.example:8883',
        username: 'device',
        operation: 'publish' as const,
        topic: 'home/device/set',
        payload: 'on',
        retain: false,
        allowPrivateNetwork: false,
        endpoint: 'mqtts://broker.example:8883',
        label: 'Broker',
      },
      {
        adapter: 'browser' as const,
        origin: 'https://service.example',
        allowPrivateNetwork: false,
        endpoint: 'https://service.example',
        label: 'Service',
        requests: [{ path: '/login', methods: ['GET', 'POST'] as Array<'GET' | 'POST'> }],
        login: { path: '/login', passwordSelector: '#password', submitSelector: '#login' },
        verification: { path: '/whoami', pointer: '/authenticated', equals: true },
        actions: [
          { label: 'Save setting', path: '/settings', fields: [], submitSelector: '#save' },
        ],
      },
    ],
  };
  vi.mocked(api.getSecretRelay).mockResolvedValue(relay);
  render(
    <MemoryRouter initialEntries={['/connections/secrets/adapters']}>
      <Routes>
        <Route path="/connections/secrets/:setupId" element={<ConnectionSetupView secretRelay />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('mqtts://broker.example:8883');
  expect(screen.getByText('home/device/set')).toBeTruthy();
  expect(screen.getByText(/Browser sign-in/)).toBeTruthy();
  expect(screen.getByText(/Save setting/, { selector: 'dd' })).toBeTruthy();
});
it('submits a masked one-time code privately and clears it before the request settles', async () => {
  const relay = {
    id: 'mfa',
    sessionId: 'chat',
    revision: 4,
    status: 'ready' as const,
    expiresAt: Date.now() + 60000,
    label: 'Service password',
    setupUrl: '/connections/secrets/mfa',
    outcomes: [{ outcome: 'challenge_required' as const, challenge: 'awaiting_code' as const }],
    targets: [],
  };
  vi.mocked(api.getSecretRelay).mockResolvedValue(relay);
  let finish!: (value: typeof relay) => void;
  vi.mocked(api.provideSecretRelayCode).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <MemoryRouter initialEntries={['/connections/secrets/mfa']}>
      <Routes>
        <Route path="/connections/secrets/:setupId" element={<ConnectionSetupView secretRelay />} />
      </Routes>
    </MemoryRouter>,
  );
  const input = (await screen.findByLabelText('Verification code')) as HTMLInputElement;
  expect(input.type).toBe('password');
  fireEvent.change(input, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue private sign-in' }));
  await waitFor(() =>
    expect(api.provideSecretRelayCode).toHaveBeenCalledWith('mfa', 4, 0, '123456', 'csrf'),
  );
  expect(input.value).toBe('');
  expect(document.body.textContent).not.toContain('123456');
  finish({
    ...relay,
    revision: 5,
    outcomes: [{ outcome: 'challenge_required', challenge: 'code_ready' }],
  } as never);
  await screen.findByText(/Verification code is ready/);
});
