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
  vi.restoreAllMocks();
});

describe('ProtectedRoute authentication recovery', () => {
  it('renders a verified route immediately when navigating back within the existing proof lifetime', async () => {
    const first = mountRoute();
    await act(async () => {});
    expect(screen.getByText('Chats ready')).toBeTruthy();
    first.unmount();
    mountRoute();
    expect(screen.getByText('Chats ready')).toBeTruthy();
    expect(screen.queryByText('Connecting to Mitzo…')).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('requires a fresh check after the existing proof expires', async () => {
    const first = mountRoute();
    await act(async () => {});
    first.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    mountRoute();
    expect(screen.getByText('Connecting to Mitzo…')).toBeTruthy();
    expect(screen.queryByText('Chats ready')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not render from a cached proof once logout is pending', async () => {
    const first = mountRoute();
    await act(async () => {});
    first.unmount();
    localStorage.setItem('mitzo_logout_pending', '1');
    mountRoute();
    expect(screen.queryByText('Chats ready')).toBeNull();
    expect(screen.getByText(/Login/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('automatically recovers a transient server failure without a Retry click', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    mountRoute();
    await act(async () => {});
    expect(screen.getByRole('alert')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText('Chats ready')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('mitzo_auth_token')).toBe('valid-token');
  });

  it('bounds automatic retries and recovers on native foreground after they are exhausted', async () => {
    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    mountRoute();
    await act(async () => {});
    for (const delay of [1_000, 2_000, 4_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await act(async () => {
      window.dispatchEvent(new Event('mitzo:app-foreground'));
    });
    expect(screen.getByText('Chats ready')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each(['online', 'visibilitychange'])(
    'recovers after %s without changing routes',
    async (event) => {
      fetchMock.mockRejectedValueOnce(new TypeError('Load failed'));
      mountRoute();
      await act(async () => {});
      await act(async () => {
        (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
      });
      expect(screen.getByText('Chats ready')).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('coalesces foreground/network notifications and removes retry work on unmount', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Load failed'));
    const route = mountRoute();
    await act(async () => {});
    await act(async () => {
      window.dispatchEvent(new Event('mitzo:app-foreground'));
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Chats ready')).toBeTruthy();
    route.unmount();
    markAuthLost();
    localStorage.setItem('mitzo_auth_token', 'valid-token');
    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    const failed = mountRoute();
    await act(async () => {});
    failed.unmount();
    await act(async () => {
      window.dispatchEvent(new Event('mitzo:app-foreground'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('waits for the foreground instead of retrying while the app is hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('visible');
    fetchMock.mockRejectedValueOnce(new TypeError('Load failed'));
    mountRoute();
    await act(async () => {});
    visibility.mockReturnValue('hidden');
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Chats ready')).toBeTruthy();
  });

  it('trusts the native foreground signal while browser visibility is still catching up', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Load failed'));
    mountRoute();
    await act(async () => {});
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      window.dispatchEvent(new Event('mitzo:app-foreground'));
    });
    expect(screen.getByText('Chats ready')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry denied authorization or disturb an already verified route on foreground', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const denied = mountRoute();
    await act(async () => {});
    await act(async () => {
      window.dispatchEvent(new Event('mitzo:app-foreground'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    denied.unmount();
    markAuthLost();
    localStorage.setItem('mitzo_auth_token', 'valid-token');
    mountRoute();
    await act(async () => {});
    await act(async () => {
      window.dispatchEvent(new Event('mitzo:app-foreground'));
    });
    expect(screen.getByText('Chats ready')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('releases the native splash and lets Retry recover a stalled check without changing tabs', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    mountRoute();
    expect(screen.getByText('Connecting to Mitzo…')).toBeTruthy();
    expect(hideSplash).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByRole('alert').textContent).toContain('Mitzo could not be reached');
    expect(screen.queryByText('Connecting to Mitzo…')).toBeNull();
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
