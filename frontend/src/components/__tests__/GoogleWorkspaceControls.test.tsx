// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleWorkspaceControls } from '../GoogleWorkspaceControls';
import * as api from '../../lib/connections-api';
vi.mock('../../lib/connections-api', () => ({
  getGoogleWorkspaceStatus: vi.fn(async () => ({
    health: 'needs_sign_in',
    expiresAt: null,
    slidesEditing: true,
  })),
  previewGoogleWorkspace: vi.fn(async () => ({ email: 'me@example.com' })),
  reconnectGoogleWorkspace: vi.fn(async () => ({
    health: 'ready',
    expiresAt: Date.now() + 3600000,
    slidesEditing: true,
  })),
  refreshGoogleWorkspace: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.mocked(api.getGoogleWorkspaceStatus).mockReset().mockResolvedValue({
    health: 'needs_sign_in',
    expiresAt: null,
    slidesEditing: true,
  });
});
describe('Google Workspace controls', () => {
  it('stops displaying ready at expiry even while the status check is pending', async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
    vi.mocked(api.getGoogleWorkspaceStatus)
      .mockResolvedValueOnce({ health: 'ready', expiresAt: Date.now() + 1000, slidesEditing: true })
      .mockImplementationOnce(() => new Promise(() => {}));
    const node = document.createElement('div');
    const root = createRoot(node);
    try {
      await act(async () =>
        root.render(
          <GoogleWorkspaceControls csrf="csrf" authorized onReauthorizationNeeded={vi.fn()} />,
        ),
      );
      expect(node.textContent).toContain('Google connection is ready');
      await act(async () => vi.advanceTimersByTimeAsync(999));
      expect(node.textContent).toContain('Google connection is ready');
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(node.textContent).not.toContain('Google connection is ready');
      expect(api.getGoogleWorkspaceStatus).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      expect(vi.getTimerCount()).toBe(0);
    }
  });
  it('rechecks a pending refresh and cancels polling when readiness is confirmed', async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.mocked(api.getGoogleWorkspaceStatus)
      .mockResolvedValueOnce({
        health: 'unavailable',
        expiresAt: Date.now() + 3600000,
        slidesEditing: true,
      })
      .mockResolvedValueOnce({
        health: 'ready',
        expiresAt: Date.now() + 3600000,
        slidesEditing: true,
      });
    const node = document.createElement('div');
    const root = createRoot(node);
    try {
      await act(async () =>
        root.render(
          <GoogleWorkspaceControls csrf="csrf" authorized onReauthorizationNeeded={vi.fn()} />,
        ),
      );
      expect(node.textContent).not.toContain('Google connection is ready');
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(node.textContent).toContain('Google connection is ready');
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(api.getGoogleWorkspaceStatus).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      expect(vi.getTimerCount()).toBe(0);
    }
  });
  it('does not overlap pending status requests when the gateway is slow', async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.mocked(api.getGoogleWorkspaceStatus)
      .mockResolvedValueOnce({ health: 'unavailable', expiresAt: 1, slidesEditing: true })
      .mockImplementation(() => new Promise(() => {}));
    const node = document.createElement('div');
    const root = createRoot(node);
    try {
      await act(async () =>
        root.render(
          <GoogleWorkspaceControls csrf="csrf" authorized onReauthorizationNeeded={vi.fn()} />,
        ),
      );
      await act(async () => vi.advanceTimersByTimeAsync(15000));
      expect(api.getGoogleWorkspaceStatus).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      expect(vi.getTimerCount()).toBe(0);
    }
  });
  it('requires fresh reauthorization and confirms the account before restoring credentials', async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node),
      reauthorize = vi.fn();
    try {
      await act(async () =>
        root.render(
          <GoogleWorkspaceControls
            csrf="csrf"
            authorized={false}
            onReauthorizationNeeded={reauthorize}
          />,
        ),
      );
      expect(node.textContent).toContain('Google sign-in needs attention');
      const button = () =>
        Array.from(node.querySelectorAll('button')).find(
          (x) => x.textContent === 'Review Google account',
        )!;
      await act(async () => fireEvent.click(button()));
      expect(reauthorize).toHaveBeenCalled();
      expect(api.previewGoogleWorkspace).not.toHaveBeenCalled();
      await act(async () =>
        root.render(
          <GoogleWorkspaceControls csrf="csrf" authorized onReauthorizationNeeded={reauthorize} />,
        ),
      );
      await act(async () => fireEvent.click(button()));
      expect(node.textContent).toContain('me@example.com');
      expect(api.reconnectGoogleWorkspace).not.toHaveBeenCalled();
      const connect = Array.from(node.querySelectorAll('button')).find(
        (x) => x.textContent === 'Reconnect Google',
      )!;
      await act(async () => fireEvent.click(connect));
      expect(api.reconnectGoogleWorkspace).toHaveBeenCalledWith('csrf', 'me@example.com');
      expect(node.textContent).toContain('Google connection is ready');
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  });
});
