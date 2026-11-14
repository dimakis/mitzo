// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ORDINARY_COMMAND_RECEIPT_TIMEOUT_MS } from '@mitzo/protocol';
import { apiFetch } from '../../lib/api-fetch';
import { CodexQueueStatus } from '../CodexQueueStatus';

vi.mock('../../lib/api-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api-fetch')>()),
  apiFetch: vi.fn(),
}));
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

it.each([
  { connected: false, paused: false, queued: 0, failed: 1 },
  { connected: true, paused: false, queued: 0, failed: 1 },
  { connected: true, paused: true, queued: 1, failed: 0 },
])(
  'continues an eligible local queue with current signed connection (connected=$connected paused=$paused)',
  async ({ connected, paused, queued, failed }) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        ({
          ok: true,
          json: async () =>
            String(path).endsWith('/meta')
              ? {
                  codexQueue: {
                    paused,
                    connected,
                    canContinue: true,
                    queued,
                    interrupted: 0,
                    failed,
                    retryable: false,
                  },
                }
              : { ok: true },
        }) as Response,
    );
    render(<CodexQueueStatus sessionId="retained-local" />);
    await act(async () => {});
    expect(screen.getByRole('status').textContent).toContain('Your work is saved.');
    fireEvent.click(screen.getByRole('button', { name: 'Continue chat' }));
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
  expect(screen.queryByRole('button', { name: 'Continue chat' })).toBeNull();
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
  expect(screen.getByRole('button', { name: 'Continue chat' })).toBeTruthy();
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
    false,
  );
});
