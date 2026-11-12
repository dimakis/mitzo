// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionAccess } from '../SessionAccess';
import {
  runtimeReadinessFixture,
  readinessScopeMutations,
} from '../../../../tests/support/runtime-readiness-fixture';
const { apiFetch, getConnectionsAccess } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  getConnectionsAccess: vi.fn(),
}));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch,
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
  AUTH_RESTORED_EVENT: 'mitzo:auth-restored',
}));
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
  vi.resetAllMocks();
});
describe('ordinary Access', () => {
  it('never renders success on an initial response with another session nested inside valid outer IDs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const readiness = runtimeReadinessFixture();
    readiness.capabilities.evidence.scope.sessionId = 'another-chat';
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: 'one', state: 'current', observedAt: Date.now(), readiness }),
    });
    render(<SessionAccess sessionId="one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Links & access' }));
    await screen.findByText('Could not check access. Refresh to try again.');
    expect(screen.queryByText('Succeeded')).toBeNull();
    warn.mockRestore();
  });
  it.each(readinessScopeMutations)(
    'retains prior verified evidence after a mismatched nested %s refresh',
    async (_name, mutate) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const readiness = runtimeReadinessFixture();
      const invalid = structuredClone(readiness);
      mutate(invalid);
      const response = {
        sessionId: 'one',
        state: 'current',
        observedAt: readiness.observedAt,
        account: { accountId: 'a', provider: 'anthropic-claude', accountLabel: 'Account' },
        model: 'actual',
        readiness,
      };
      apiFetch
        .mockResolvedValueOnce({ ok: true, json: async () => structuredClone(response) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ...response, readiness: invalid }),
        });
      render(<SessionAccess sessionId="one" />);
      fireEvent.click(screen.getByRole('button', { name: 'Links & access' }));
      await screen.findByText('Succeeded');
      fireEvent.click(screen.getByRole('button', { name: 'Refresh Access' }));
      await screen.findByText(/Stale — refresh failed/);
      expect(screen.getByText('Earlier result: succeeded')).toBeTruthy();
      expect(screen.queryByText('Succeeded')).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          code: 'session_access_read_failed',
          stage: 'read',
          sessionId: 'one',
        }),
      );
      warn.mockRestore();
    },
  );
  it.each(['account', 'model'])(
    'rejects readiness that disagrees with the outer Access %s',
    async (field) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      apiFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionId: 'one',
          state: 'current',
          observedAt: Date.now(),
          readiness: runtimeReadinessFixture(),
          account: {
            accountId: field === 'account' ? 'different' : 'a',
            provider: 'anthropic-claude',
            accountLabel: 'Account',
          },
          model: field === 'model' ? 'different' : 'actual',
        }),
      });
      render(<SessionAccess sessionId="one" />);
      fireEvent.click(screen.getByRole('button', { name: 'Links & access' }));
      await screen.findByText('Could not check access. Refresh to try again.');
      expect(screen.queryByText('Succeeded')).toBeNull();
      warn.mockRestore();
    },
  );
  it.each([
    { helperSupport: { state: 'configured', tools: 'invalid' } },
    {
      readiness: {
        version: 1,
        sessionId: 'another-chat',
        observedAt: Date.now(),
        revision: 'a'.repeat(64),
        session: { state: 'unknown', reason: 'not_observed' },
        execution: { state: 'unknown', reason: 'not_observed' },
        capabilities: { state: 'unknown', reason: 'not_observed' },
      },
    },
  ])(
    'retains prior support and reports invalid runtime evidence on refresh: %j',
    async (invalid) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      apiFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            sessionId: 'one',
            state: 'current',
            observedAt: Date.now(),
            helperSupport: {
              state: 'configured',
              tools: [
                {
                  name: 'ListConnections',
                  source: 'Connections',
                  requirement: 'Permissions still apply.',
                  state: 'supported',
                },
              ],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            sessionId: 'one',
            state: 'current',
            observedAt: Date.now(),
            ...invalid,
          }),
        });
      render(<SessionAccess sessionId="one" />);
      fireEvent.click(screen.getByRole('button', { name: 'Links & access' }));
      await screen.findByText('ListConnections');
      fireEvent.click(screen.getByRole('button', { name: 'Refresh Access' }));
      await screen.findByText(/Stale — refresh failed/);
      expect(screen.getByText('ListConnections')).toBeTruthy();
      expect(screen.getByText(/Earlier capability observation/)).toBeTruthy();
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          code: 'session_access_read_failed',
          stage: 'read',
          sessionId: 'one',
        }),
      );
      warn.mockRestore();
    },
  );
  it('opens before session/output exists and returns from Connections without replacing the composer', async () => {
    getConnectionsAccess.mockResolvedValue({ generatedAt: Date.now(), resources: [], sources: [] });
    render(
      <>
        <textarea defaultValue="draft" />
        <SessionAccess selection={{ accountId: 'account', model: 'selected-model' }} />
      </>,
    );
    const composer = screen.getByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: 'Links & access' }));
    expect(screen.getByText('selected-model')).toBeTruthy();
    expect(screen.getByText(/No session has started/)).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    await screen.findByText('No configured connections reported.');
    fireEvent.click(screen.getByRole('button', { name: 'Back to Links & access' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Links & access' }));
    await screen.findByText('Bash · request');
    fireEvent.click(screen.getByRole('button', { name: /^Permissions/ }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Links & access' }));
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
