// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ORDINARY_COMMAND_RECEIPT_TIMEOUT_MS } from '@mitzo/protocol';
import { apiFetch } from '../../lib/api-fetch';
import { CodexQueueStatus } from '../CodexQueueStatus';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: unknown) => unknown) =>
    select({ getTransportConnectionId: () => 'current-signed-sse', queueRevision: 0 }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  sessionStorage.clear();
});

it.each([false, true])(
  'continues an eligible local Codex command with current signed connection (connected=%s)',
  async (connected) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        ({
          ok: true,
          json: async () =>
            String(path).endsWith('/meta')
              ? {
                  codexQueue: {
                    paused: false,
                    connected,
                    canContinue: true,
                    queued: 0,
                    interrupted: 0,
                    failed: 1,
                    retryable: false,
                  },
                }
              : { ok: true },
        }) as Response,
    );
    render(<CodexQueueStatus sessionId="retained-local" />);
    await act(async () => {});
    expect(screen.getByRole('status').textContent).toContain('Your message is saved.');
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect and continue' }));
    await act(async () => {});
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/retained-local/codex-queue/continue', {
      method: 'POST',
      signal: expect.any(AbortSignal),
      headers: { 'X-Connection-ID': 'current-signed-sse' },
    });
    expect(timeout).toHaveBeenCalledWith(ORDINARY_COMMAND_RECEIPT_TIMEOUT_MS);
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => String(path).endsWith('/retry'))).toBe(
      false,
    );
  },
);

it('does not offer recovery for failed work without an authoritative safe continuation', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      codexQueue: {
        paused: false,
        connected: true,
        canContinue: false,
        queued: 0,
        interrupted: 0,
        failed: 1,
        retryable: false,
      },
    }),
  } as Response);
  render(<CodexQueueStatus sessionId="uncertain-local" />);
  await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Reconnect and continue' })).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('cannot be retried');
});

it('keeps eligible saved local recovery explicit instead of starting legacy background reattachment', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_path, options) => {
    if (options?.method === 'POST') return new Promise<Response>(() => {});
    return {
      ok: true,
      json: async () => ({
        codexQueue: {
          paused: true,
          connected: false,
          canContinue: true,
          queued: 0,
          interrupted: 0,
          failed: 1,
          retryable: true,
        },
      }),
    } as Response;
  });
  render(<CodexQueueStatus sessionId="explicit-saved-recovery" />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Reconnect and continue' })).toBeTruthy();
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
});
