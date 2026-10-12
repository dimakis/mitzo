// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { markAuthLost } from '../lib/api-fetch';
import { hideSplash } from '../lib/splash';

vi.mock('../lib/splash', () => ({ hideSplash: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/watch-auth', () => ({ saveTokenToWatch: vi.fn() }));
const fetchMock = vi.fn();

function LoginDestination() {
  return <div>Login {useLocation().search}</div>;
}

function mountRoute() {
  return render(
    <MemoryRouter initialEntries={['/sessions?filter=active#recent']}>
      <Routes>
        <Route
          path="/sessions"
          element={
            <ProtectedRoute>
              <div>Chats ready</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<LoginDestination />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.mocked(hideSplash).mockClear();
  localStorage.clear();
  markAuthLost();
  localStorage.setItem('mitzo_auth_token', 'valid-token');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ProtectedRoute authentication recovery', () => {
  it('releases the native splash and lets Retry recover a stalled check without changing tabs', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    mountRoute();
    expect(screen.getByText('Checking authentication…')).toBeTruthy();
    expect(hideSplash).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByRole('alert').textContent).toContain('Mitzo could not be reached');
    expect(screen.queryByText('Checking authentication…')).toBeNull();
    expect(hideSplash).toHaveBeenCalled();
    expect(localStorage.getItem('mitzo_auth_token')).toBe('valid-token');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(screen.getByText('Chats ready')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a stalled check after the route is left and opened again', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    const first = mountRoute();
    first.unmount();
    mountRoute();
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(screen.getByText('Chats ready')).toBeTruthy();
  });

  it('retains the exact return destination for an actually denied login', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    mountRoute();
    await act(async () => {});
    expect(screen.getByText(/Login/).textContent).toContain(
      '?returnTo=%2Fsessions%3Ffilter%3Dactive%23recent',
    );
    expect(screen.queryByText('Chats ready')).toBeNull();
  });

  it('rechecks when another tab changes the authentication credential', async () => {
    mountRoute();
    await act(async () => {});
    expect(screen.getByText('Chats ready')).toBeTruthy();
    await act(async () => {
      localStorage.setItem('mitzo_auth_token', 'other-tab-token');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'mitzo_auth_token',
          newValue: 'other-tab-token',
          storageArea: localStorage,
        }),
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Chats ready')).toBeTruthy();
  });
});
