// @vitest-environment node-compatible-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const native = vi.hoisted(() => ({
  enabled: false,
  available: true,
  authorize: vi.fn(),
  saveToken: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => native.enabled,
    getPlatform: () => 'ios',
    isPluginAvailable: () => native.available,
  },
  registerPlugin: (name: string) =>
    name === 'AppleSignInBridge'
      ? { authorize: native.authorize }
      : { saveToken: native.saveToken },
}));
vi.mock('../../lib/biometric', () => ({
  isBiometricAvailable: async () => false,
  getBiometricLabel: async () => 'Face ID',
  biometricLogin: vi.fn(),
  saveCredentials: vi.fn(),
  saveBiometricPassphrase: vi.fn(),
}));
vi.mock('../../lib/haptics', () => ({ notifySuccess: vi.fn() }));
import { Login } from '../Login';
import { loginSucceeded } from '../../lib/api-fetch';

const fetcher = vi.fn();
let enrolled = true;
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function renderLogin(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/login?returnTo=/done${search}`]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/done" element={<p>Authenticated destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  localStorage.clear();
  native.enabled = false;
  native.available = true;
  enrolled = true;
  native.authorize
    .mockReset()
    .mockImplementation(async ({ state }) => ({ state, code: 'synthetic-code' }));
  native.saveToken.mockReset().mockResolvedValue(undefined);
  fetcher.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith('/status')) return response({ enabled: true, enrolled, native: true });
    if (url.endsWith('/start'))
      return response({ state: 'synthetic-state', nonce: 'nonce', verifier: 'verifier' });
    if (url.endsWith('/native')) return response({ token: 'synthetic-mitzo-token' });
    if (url.endsWith('/login')) return response({ token: 'passphrase-token' });
    return response({ error: 'No session' }, 401);
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Apple login consumer with the real client adapter', () => {
  it('returns to the destination when another tab restores authentication', async () => {
    renderLogin();
    await screen.findByRole('button', { name: 'Sign in with Apple' });
    act(() => {
      window.dispatchEvent(
        new window.StorageEvent('storage', {
          key: 'mitzo_auth_token',
          newValue: 'other-tab-token',
          storageArea: localStorage,
        }),
      );
    });
    await screen.findByText('Authenticated destination');
  });
  it('leaves local authentication completion to the active login flow', async () => {
    renderLogin();
    await screen.findByRole('button', { name: 'Sign in with Apple' });
    act(() => loginSucceeded('local-token'));
    expect(screen.queryByText('Authenticated destination')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in with Apple' })).toBeEnabled();
  });
  it('discards a pending Apple authorization after another tab restores authentication', async () => {
    native.enabled = true;
    let finish!: (result: { state: string; code: string }) => void;
    native.authorize.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderLogin();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Apple' }));
    await waitFor(() => expect(native.authorize).toHaveBeenCalled());
    act(() => {
      window.dispatchEvent(
        new window.StorageEvent('storage', {
          key: 'mitzo_auth_token',
          newValue: 'other-tab-token',
          storageArea: localStorage,
        }),
      );
    });
    await screen.findByText('Authenticated destination');
    await act(async () => finish({ state: 'synthetic-state', code: 'late-code' }));
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/native'))).toBe(false);
    expect(localStorage.getItem('mitzo_auth_token')).toBeNull();
    expect(native.saveToken).not.toHaveBeenCalled();
  });
  it('requires explicit passphrase enrollment and completes native authentication', async () => {
    enrolled = false;
    native.enabled = true;
    renderLogin();
    const connect = await screen.findByRole('button', { name: 'Connect Apple account' });
    expect(connect).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'owner-proof' } });
    fireEvent.click(connect);
    await screen.findByText('Authenticated destination');
    expect(JSON.parse(fetcher.mock.calls.find(([url]) => url.endsWith('/start'))![1].body)).toEqual(
      { client: 'native', enrollPassphrase: 'owner-proof' },
    );
    expect(localStorage.getItem('mitzo_auth_token')).toBe('synthetic-mitzo-token');
  });
  it('does not accept a success URL as proof of a browser session', async () => {
    renderLogin('&apple=success');
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed');
    expect(screen.queryByText('Authenticated destination')).toBeNull();
    expect(localStorage.getItem('mitzo_auth_token')).toBeNull();
  });
  it('restores a verified cookie without retaining an old bearer token', async () => {
    localStorage.setItem('mitzo_auth_token', 'old-token');
    fetcher.mockImplementation(async (url: string) =>
      response(
        url.endsWith('/check') ? { ok: true, authSessionId: 'cookie-session' } : { enabled: false },
      ),
    );
    renderLogin('&apple=success');
    await screen.findByText('Authenticated destination');
    expect(localStorage.getItem('mitzo_auth_token')).toBeNull();
    expect(fetcher.mock.calls.find(([url]) => url.endsWith('/check'))![1].headers).toBeUndefined();
  });
  it('shows cancellation and leaves passphrase recovery usable', async () => {
    native.enabled = true;
    native.authorize.mockRejectedValueOnce({ code: 'APPLE_CANCELLED' });
    renderLogin();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Apple' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('was cancelled');
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'recovery' } });
    fireEvent.click(screen.getByRole('button', { name: /^Login$/ }));
    await screen.findByText('Authenticated destination');
  });
  it('requires an updated native plugin and never falls back to an embedded web login', async () => {
    native.enabled = true;
    native.available = false;
    renderLogin();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Apple' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Update the Mitzo iPhone app');
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/start'))).toHaveLength(0);
  });
  it('discards native completion after logout, without saving a Watch token', async () => {
    native.enabled = true;
    let finish!: (result: { state: string; code: string }) => void;
    native.authorize.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderLogin();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Apple' }));
    await waitFor(() => expect(native.authorize).toHaveBeenCalled());
    await act(async () => {
      localStorage.setItem('mitzo_logout_pending', '1');
      window.dispatchEvent(new Event('mitzo:auth-lost'));
      finish({ state: 'synthetic-state', code: 'late-code' });
    });
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/native'))).toBe(false);
    expect(localStorage.getItem('mitzo_auth_token')).toBeNull();
    expect(native.saveToken).not.toHaveBeenCalled();
    expect(screen.queryByText('Authenticated destination')).toBeNull();
  });
  it('keeps availability failure visible and retries without hiding passphrase login', async () => {
    fetcher.mockResolvedValueOnce(response({}, 503));
    renderLogin();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry Apple sign-in' }));
    expect(await screen.findByRole('button', { name: 'Sign in with Apple' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Login$/ })).toBeEnabled();
  });
  it('reports a wrong Apple account without exposing provider response details', async () => {
    native.enabled = true;
    const defaultFetch = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url: string, init: RequestInit) =>
      url.endsWith('/native')
        ? response({ code: 'owner_mismatch', error: 'secret upstream detail' }, 403)
        : defaultFetch(url, init),
    );
    renderLogin();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Apple' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not connected to Mitzo');
    expect(screen.queryByText(/secret upstream detail/)).toBeNull();
  });
});
