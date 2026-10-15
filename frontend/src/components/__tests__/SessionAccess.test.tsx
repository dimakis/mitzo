// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionAccess } from '../SessionAccess';
const { apiFetch, getConnectionsAccess } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  getConnectionsAccess: vi.fn(),
}));
vi.mock('../../lib/api-fetch', () => ({ apiFetch }));
vi.mock('../../lib/connections-access-api', () => ({ getConnectionsAccess }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('ordinary Access', () => {
  it('opens before session/output exists and returns from Connections without replacing the composer', async () => {
    getConnectionsAccess.mockResolvedValue({ generatedAt: Date.now(), resources: [], sources: [] });
    render(
      <>
        <textarea defaultValue="draft" />
        <SessionAccess selection={{ accountId: 'account', model: 'selected-model' }} />
      </>,
    );
    const composer = screen.getByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: 'Access' }));
    expect(screen.getByText('selected-model')).toBeTruthy();
    expect(screen.getByText(/No session has started/)).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    await screen.findByText('No configured connections reported.');
    fireEvent.click(screen.getByRole('button', { name: 'Back to Access' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('textbox')).toBe(composer);
    expect((composer as HTMLTextAreaElement).value).toBe('draft');
  });
  it('shows request-scoped pending approvals, unknown limits and stale evidence after a failed refresh', async () => {
    const evidence = {
      sessionId: 'one',
      state: 'current',
      observedAt: Date.now(),
      account: { accountId: 'a', accountLabel: 'Account', provider: 'anthropic-vertex' },
      model: 'actual',
      mode: 'agent',
      grants: ['Bash'],
      skillCeiling: null,
      pending: [{ permId: 'p', toolName: 'Bash', scope: 'request' }],
      attachments: null,
      tools: null,
      limits: null,
    };
    apiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => evidence })
      .mockRejectedValueOnce(new Error('offline'));
    render(<SessionAccess sessionId="one" onShowApproval={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Access' }));
    await screen.findByText('Bash · request');
    expect(screen.getByRole('button', { name: 'View pending approvals' })).toBeTruthy();
    expect(screen.getByText('Unknown — runtime limits have not been reported here.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Access' }));
    await screen.findByText(/Stale — refresh failed/);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'View pending approvals' })).toBeNull(),
    );
  });
  it('cannot show a late response for a different selected session', async () => {
    let release!: (value: unknown) => void;
    apiFetch
      .mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessionId: 'two', state: 'unknown', observedAt: Date.now() }),
      });
    const { rerender } = render(<SessionAccess sessionId="one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Access' }));
    rerender(<SessionAccess sessionId="two" />);
    release({
      ok: true,
      json: async () => ({
        sessionId: 'one',
        state: 'current',
        account: { accountLabel: 'Wrong account' },
      }),
    });
    await screen.findByText(/Unknown — live evidence is unavailable/);
    expect(screen.getByText(/This runtime has not supplied current session evidence/)).toBeTruthy();
    expect(screen.queryByText(/currently reports live Claude/)).toBeNull();
    expect(screen.queryByText('Wrong account')).toBeNull();
  });
});
