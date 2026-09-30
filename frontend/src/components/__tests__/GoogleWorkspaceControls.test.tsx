// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
describe('Google Workspace controls', () => {
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
