// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Login } from '../Login';
import { apiFetch, restoreCookieAuthentication, AUTH_RESTORED_EVENT } from '../../lib/api-fetch';
import { biometricLogin, isBiometricAvailable } from '../../lib/biometric';
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  restoreCookieAuthentication: vi.fn(),
  AUTH_RESTORED_EVENT: 'auth-restored',
  isCrossTabAuthEvent: () => true,
  getApiBaseUrl: () => '',
  loginSucceeded: vi.fn(),
  markAuthLost: vi.fn(),
}));
vi.mock('../../lib/biometric', () => ({
  biometricLogin: vi.fn(),
  isBiometricAvailable: vi.fn(),
  getBiometricLabel: async () => 'Face ID',
  saveCredentials: vi.fn(),
}));
vi.mock('../../lib/watch-auth', () => ({ saveTokenToWatch: vi.fn() }));
vi.mock('../../lib/haptics', () => ({ notifySuccess: vi.fn() }));
const destination = '/sessions/s/review-records/review-hash?view=history#decision';
function Location() {
  const location = useLocation();
  return <output>{location.pathname + location.search + location.hash}</output>;
}
function setup(target = destination) {
  render(
    <MemoryRouter initialEntries={['/login?returnTo=' + encodeURIComponent(target)]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Location />} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.mocked(isBiometricAvailable).mockResolvedValue(false);
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ token: 'test-token' }),
  } as Response);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('returns to the complete record URL after password login', async () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Login' }));
  await screen.findByText(destination);
});
it('returns after preserved cookie recovery', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: false } as Response);
  vi.mocked(restoreCookieAuthentication).mockResolvedValue(true);
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Login' }));
  await screen.findByText(destination);
});
it('returns after automatic biometric login', async () => {
  vi.mocked(isBiometricAvailable).mockResolvedValue(true);
  vi.mocked(biometricLogin).mockResolvedValue('token');
  setup();
  await screen.findByText(destination);
});
it('returns after manually retried biometric login', async () => {
  vi.mocked(isBiometricAvailable).mockResolvedValue(true);
  vi.mocked(biometricLogin).mockResolvedValueOnce(null).mockResolvedValueOnce('token');
  setup();
  await waitFor(() => expect(biometricLogin).toHaveBeenCalledTimes(1));
  fireEvent.click(await screen.findByRole('button', { name: 'Unlock with Face ID' }));
  await screen.findByText(destination);
});
it('returns after another tab restores authentication', async () => {
  setup();
  act(() => window.dispatchEvent(new Event(AUTH_RESTORED_EVENT)));
  await screen.findByText(destination);
});
it.each([
  'https://evil.test/',
  '//evil.test/',
  '/\\evil.test/',
  '/%2f%2fevil.test/',
  'javascript:alert(1)',
  '/login?returnTo=/login',
  '/\nevil.test',
])('rejects unsafe return target %s', async (target) => {
  setup(target);
  fireEvent.click(screen.getByRole('button', { name: 'Login' }));
  await screen.findByText('/');
});
