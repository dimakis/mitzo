// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiFetch } from '../../lib/api-fetch';
import { CodexQueueStatus } from '../CodexQueueStatus';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
const queueSignal = vi.hoisted(() => ({ revision: 0 }));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: unknown) => unknown) =>
    select({ getTransportConnectionId: () => 'owned-sse', queueRevision: queueSignal.revision }),
}));

const meta = (queue: Record<string, unknown>) =>
  ({ ok: true, json: async () => ({ codexQueue: queue }) }) as Response;
const commands = (queued: Array<{ id: string; preview: string }>) =>
  ({ ok: true, json: async () => ({ queued, cancelledIds: [] }) }) as Response;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
  queueSignal.revision = 0;
});

const idleQueue = { paused: false, connected: true, queued: 0, interrupted: 0 };

it('loads and cancels queue previews without AbortSignal.any on older WebKit', async () => {
  const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
  Object.defineProperty(AbortSignal, 'any', { ...any, value: undefined });
  try {
    let queued = 1;
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (String(path).endsWith('/meta')) return meta({ ...idleQueue, queued });
      if (String(path).endsWith('/cancel')) {
        queued = 0;
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      return commands([{ id: 'waiting', preview: 'Synthetic legacy preview' }]);
    });
    render(<CodexQueueStatus sessionId="legacy-webkit" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Review queue' }));
    expect(screen.getByText('Synthetic legacy preview')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {});
    expect(screen.queryByRole('status')).toBeNull();
  } finally {
    Object.defineProperty(AbortSignal, 'any', any);
  }
});

it('aborts stalled preview reads at the deadline and permits a subsequent polling retry', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, options) => {
    if (String(path).endsWith('/meta')) return meta({ ...idleQueue, queued: 1 });
    const signal = options!.signal!;
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    });
  });
  render(<CodexQueueStatus sessionId="preview-deadline" />);
  await act(async () => {});
  expect(signals).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(signals[0].aborted).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(signals).toHaveLength(2);
  expect(signals[1].aborted).toBe(false);
});

it.each(['failed', 'stalled'])(
  'clears invalidated populated previews when the next details read is %s',
  async (outcome) => {
    let queued = 2;
    let firstDetails = true;
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (String(path).endsWith('/meta')) return meta({ ...idleQueue, queued });
      if (firstDetails) {
        firstDetails = false;
        return commands([
          { id: 'started', preview: 'Synthetic first preview' },
          { id: 'waiting', preview: 'Synthetic second preview' },
        ]);
      }
      return outcome === 'failed'
        ? ({ ok: false, status: 503 } as Response)
        : new Promise<Response>(() => {});
    });
    const view = render(<CodexQueueStatus sessionId="invalidated-details" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Review queue' }));
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(2);
    queued = 1;
    queueSignal.revision++;
    view.rerender(<CodexQueueStatus sessionId="invalidated-details" />);
    await act(async () => {});
    expect(screen.getByText('1 message queued')).toBeTruthy();
    expect(screen.queryByText('Synthetic first preview')).toBeNull();
    expect(screen.queryByText('Synthetic second preview')).toBeNull();
    expect(screen.queryAllByRole('button', { name: 'Cancel' })).toHaveLength(0);
  },
);

it('clears populated previews when an unchanged fallback details read fails', async () => {
  vi.useFakeTimers();
  let firstDetails = true;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path).endsWith('/meta')) return meta({ ...idleQueue, queued: 1 });
    if (firstDetails) {
      firstDetails = false;
      return commands([{ id: 'waiting', preview: 'Synthetic preview' }]);
    }
    return { ok: false, status: 503 } as Response;
  });
  render(<CodexQueueStatus sessionId="failed-fallback-details" />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Review queue' }));
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.queryByText('Synthetic preview')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  expect(screen.getByText('1 message queued')).toBeTruthy();
});

it('shows and clears waiting work on queue notifications without advancing the polling clock', async () => {
  vi.useFakeTimers();
  let queued = 0;
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path).endsWith('/meta') ? meta({ ...idleQueue, queued }) : commands([]),
  );
  const view = render(<CodexQueueStatus sessionId="live" />);
  await act(async () => {});
  expect(screen.queryByRole('status')).toBeNull();

  queued = 1;
  queueSignal.revision++;
  view.rerender(<CodexQueueStatus sessionId="live" />);
  await act(async () => {});
  expect(screen.getByText('1 message queued')).toBeTruthy();

  queued = 0;
  queueSignal.revision++;
  view.rerender(<CodexQueueStatus sessionId="live" />);
  await act(async () => {});
  expect(screen.queryByRole('status')).toBeNull();
});

it('refreshes again when queue notifications arrive during a metadata read', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch)
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(meta({ ...idleQueue, queued: 0 }));
  const view = render(<CodexQueueStatus sessionId="in-flight" />);
  queueSignal.revision++;
  view.rerender(<CodexQueueStatus sessionId="in-flight" />);
  queueSignal.revision++;
  view.rerender(<CodexQueueStatus sessionId="in-flight" />);
  await act(async () => {
    finish(meta({ ...idleQueue, queued: 1 }));
  });
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(apiFetch).mock.calls.every(([path]) => String(path).endsWith('/meta'))).toBe(
    true,
  );
  expect(screen.queryByRole('status')).toBeNull();
});

it('updates the count while queue preview details are stalled and ignores late details', async () => {
  let finishDetails!: (response: Response) => void;
  let queued = 1;
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path).endsWith('/meta')
      ? meta({ ...idleQueue, queued })
      : new Promise<Response>((resolve) => {
          finishDetails = resolve;
        }),
  );
  const view = render(<CodexQueueStatus sessionId="slow-details" />);
  await act(async () => {});
  expect(screen.getByText('1 message queued')).toBeTruthy();
  queued = 0;
  queueSignal.revision++;
  view.rerender(<CodexQueueStatus sessionId="slow-details" />);
  await act(async () => {});
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => {
    finishDetails(commands([{ id: 'old', preview: 'Synthetic preview' }]));
  });
  expect(screen.queryByRole('status')).toBeNull();
});

it('does not let an earlier chat metadata response replace the current chat status', async () => {
  let finishOld!: (response: Response) => void;
  vi.mocked(apiFetch)
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValue(meta(idleQueue));
  const view = render(<CodexQueueStatus sessionId="old" />);
  view.rerender(<CodexQueueStatus sessionId="new" />);
  await act(async () => {
    finishOld(meta({ ...idleQueue, queued: 1 }));
  });
  expect(screen.queryByRole('status')).toBeNull();
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('shares a slow preview request across unchanged fallback metadata polls', async () => {
  vi.useFakeTimers();
  let finishDetails!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path).endsWith('/meta')
      ? meta({ ...idleQueue, queued: 1 })
      : new Promise<Response>((resolve) => {
          finishDetails = resolve;
        }),
  );
  render(<CodexQueueStatus sessionId="shared-details" />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Review queue' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).endsWith('/codex-queue')),
  ).toHaveLength(1);
  await act(async () => {
    finishDetails(commands([{ id: 'saved', preview: 'Synthetic preview' }]));
  });
  expect(screen.getByText('Synthetic preview')).toBeTruthy();
});

const capacity = (overrides: Record<string, unknown> = {}) => ({
  paused: true,
  connected: true,
  queued: 0,
  interrupted: 0,
  failed: 1,
  retryable: false,
  capacityRecovery: {
    id: 'recovery-one',
    sourceCommandId: 'failed-one',
    status: 'waiting',
    attempts: 0,
    maxAttempts: 5,
    nextRetryAt: Date.now() + 30_000,
    ...overrides,
  },
});

it('counts down server-owned capacity recovery without sending a retry from a UI timer', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
  const state = capacity();
  vi.mocked(apiFetch).mockResolvedValue(meta(state));
  await act(async () => {
    render(<CodexQueueStatus sessionId="capacity" />);
  });
  expect(screen.getByText(/Trying again in 30s.*1 of 5/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(screen.getByText(/Trying again in 29s.*1 of 5/)).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(vi.mocked(apiFetch).mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(
    true,
  );
});

it('tries saved capacity work immediately using exact recovery identity, with a rapid-click latch', async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path).endsWith('/capacity-retry') ? pending : meta(capacity()),
  );
  render(<CodexQueueStatus sessionId="capacity" />);
  const button = await screen.findByRole('button', { name: 'Try again' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/sessions/capacity/codex-queue/capacity-retry',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ recoveryId: 'recovery-one', sourceCommandId: 'failed-one' }),
    }),
  );
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).endsWith('/capacity-retry')),
  ).toHaveLength(1);
  await act(async () => {
    resolve({ ok: true, json: async () => ({ ok: true, status: 'queued' }) } as Response);
  });
});

it('stops only the identified capacity recovery while preserving the unrelated queue affordance', async () => {
  let stopped = false;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path).endsWith('/capacity-stop')) {
      stopped = true;
      return { ok: true, json: async () => ({ ok: true, status: 'stopped' }) } as Response;
    }
    if (String(path).endsWith('/codex-queue'))
      return commands([{ id: 'unrelated', preview: 'Saved follow-up' }]);
    return meta({
      ...capacity({ status: stopped ? 'stopped' : 'running', attempts: 1 }),
      queued: 1,
    });
  });
  render(<CodexQueueStatus sessionId="capacity" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/sessions/capacity/codex-queue/capacity-stop',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ recoveryId: 'recovery-one', sourceCommandId: 'failed-one' }),
    }),
  );
  await screen.findByText(/Automatic attempts stopped/);
  expect(screen.queryByRole('button', { name: 'Reconnect and continue' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Review queue' }));
  expect(screen.getByText('Saved follow-up')).toBeTruthy();
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([, options]) => options?.method === 'POST'),
  ).toHaveLength(1);
});

it('requires inspection after Stop interrupts a running continuation and sends no retry', async () => {
  let stopped = false;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path).endsWith('/capacity-stop')) {
      stopped = true;
      return { ok: true, json: async () => ({ ok: true, status: 'stopped' }) } as Response;
    }
    return meta(
      capacity({
        status: stopped ? 'stopped' : 'running',
        attempts: 1,
        requiresInspection: stopped,
      }),
    );
  });
  render(<CodexQueueStatus sessionId="capacity" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
  await screen.findByText(
    'Inspect saved progress before continuing. This attempt cannot be retried safely.',
  );
  const retry = screen.getByRole('button', { name: 'Try again' });
  expect(retry.hasAttribute('disabled')).toBe(true);
  fireEvent.click(retry);
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).endsWith('/capacity-retry')),
  ).toHaveLength(0);
});

it('allows an authoritative safe stopped backoff to start a manual retry cycle', async () => {
  let stopped = false;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path).endsWith('/capacity-stop')) {
      stopped = true;
      return { ok: true, json: async () => ({ ok: true, status: 'stopped' }) } as Response;
    }
    if (String(path).endsWith('/capacity-retry'))
      return { ok: true, json: async () => ({ ok: true, status: 'queued' }) } as Response;
    return meta(capacity({ status: stopped ? 'stopped' : 'waiting', requiresInspection: false }));
  });
  render(<CodexQueueStatus sessionId="capacity" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
  await screen.findByText(/Automatic attempts stopped/);
  expect(screen.getByRole('button', { name: 'Try again' }).hasAttribute('disabled')).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/sessions/capacity/codex-queue/capacity-retry',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ recoveryId: 'recovery-one', sourceCommandId: 'failed-one' }),
    }),
  );
});

it('shows exhausted capacity attempts with an explicit manual new cycle and no automatic reattach', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    meta({ ...capacity({ status: 'exhausted', attempts: 5 }), connected: false }),
  );
  render(<CodexQueueStatus sessionId="capacity" />);
  await screen.findByText(/Automatic retries finished.*5 of 5/);
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(
    true,
  );
});

it('refreshes a stale recovery card after conflict instead of retrying a newer episode', async () => {
  let changed = false;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path).endsWith('/capacity-retry')) {
      changed = true;
      return { ok: false, status: 409, json: async () => ({ error: 'stale' }) } as Response;
    }
    return meta(capacity(changed ? { id: 'recovery-two', sourceCommandId: 'failed-two' } : {}));
  });
  render(<CodexQueueStatus sessionId="capacity" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  await screen.findByText('Recovery changed. Check its current status.');
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).endsWith('/capacity-retry')),
  ).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(apiFetch).toHaveBeenLastCalledWith('/api/sessions/capacity/meta', expect.anything());
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(([path]) => String(path).endsWith('/capacity-retry'))[1][1]?.body,
  ).toBe(JSON.stringify({ recoveryId: 'recovery-two', sourceCommandId: 'failed-two' }));
});

it('ignores an old recovery response after switching chats', async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path).endsWith('/capacity-retry')) return pending;
    if (String(path).includes('/new-chat/'))
      return meta(
        capacity({ id: 'new-recovery', sourceCommandId: 'new-command', status: 'stopped' }),
      );
    return meta(capacity());
  });
  const view = render(<CodexQueueStatus sessionId="old-chat" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  view.rerender(<CodexQueueStatus sessionId="new-chat" />);
  await screen.findByText(/Automatic attempts stopped/);
  await act(async () => {
    resolve({ ok: false, status: 409, json: async () => ({}) } as Response);
  });
  expect(screen.queryByText('Recovery changed. Check its current status.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Try again' }).hasAttribute('disabled')).toBe(false);
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(
        ([path]) => String(path).includes('old-chat') && String(path).endsWith('/meta'),
      ),
  ).toHaveLength(1);
});

it.each(['queued', 'running'])(
  'does not allow duplicate continuation or generic queue recovery while capacity is %s',
  async (status) => {
    vi.mocked(apiFetch).mockImplementation(async (path) =>
      String(path).endsWith('/codex-queue')
        ? commands([{ id: 'unrelated', preview: 'Saved follow-up' }])
        : meta({
            ...capacity({ status, attempts: 1, requiresInspection: status === 'running' }),
            queued: 1,
          }),
    );
    render(<CodexQueueStatus sessionId="capacity" />);
    const button = await screen.findByRole('button', { name: 'Try again' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.queryByText(/Inspect saved progress before continuing/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect and continue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry saved turn' })).toBeNull();
    expect(vi.mocked(apiFetch).mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(
      true,
    );
  },
);

it('shows waiting work with a drawer that cancels only an identified queued message', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 2, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(
      commands([
        { id: 'one', preview: 'First saved message' },
        { id: 'two', preview: 'Second saved message' },
      ]),
    )
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, status: 'cancelled' }),
    } as Response)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'two', preview: 'Second saved message' }]));

  render(<CodexQueueStatus sessionId="task" />);
  await screen.findByText('2 messages queued');
  await userEvent.click(screen.getByRole('button', { name: 'Review queue' }));
  expect(screen.getByText('First saved message')).toBeTruthy();
  expect(screen.getByText('Second saved message')).toBeTruthy();

  await userEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(5));
  expect(apiFetch).toHaveBeenNthCalledWith(
    3,
    '/api/sessions/task/codex-queue/one/cancel',
    expect.objectContaining({ method: 'POST' }),
  );
  expect(screen.queryByText('First saved message')).toBeNull();
  expect(screen.getByText('Second saved message')).toBeTruthy();
});

it.each([
  [
    { paused: false, connected: true, queued: 1, interrupted: 0, recovering: false },
    '1 message queued',
  ],
  [
    {
      paused: true,
      connected: false,
      queued: 0,
      interrupted: 1,
      recovering: true,
      recoveryPhase: 'reconnecting',
    },
    'Reconnecting…',
  ],
  [
    {
      paused: true,
      connected: true,
      queued: 0,
      interrupted: 0,
      recovering: true,
      recoveryPhase: 'reconnecting',
    },
    'Reconnecting…',
  ],
])('uses compact, accurate status text', async (queue, label) => {
  vi.mocked(apiFetch).mockResolvedValue(meta(queue));
  render(<CodexQueueStatus sessionId="status" />);
  await screen.findByText(label);
  expect(screen.queryByRole('button', { name: /continue|reconnect/i })).toBeNull();
});

it('lets a paused connected chat explicitly reconnect and continue saved work', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({ paused: true, connected: true, queued: 1, interrupted: 1, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Saved follow-up' }]))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 0, interrupted: 1, recovering: false }),
    );

  render(<CodexQueueStatus sessionId="paused" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Reconnect and continue' }));

  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/paused/codex-queue/continue', {
      method: 'POST',
      signal: expect.any(AbortSignal),
    }),
  );
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
});

it('allows the qualified original cold Responses queue to reconnect without adding or cancelling accepted work', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({
        paused: true,
        connected: false,
        canContinue: true,
        queued: 32,
        interrupted: 1,
        recovering: false,
      }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Accepted FIFO work' }]))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 0, interrupted: 1, recovering: false }),
    );
  render(<CodexQueueStatus sessionId="cold-full" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Reconnect and continue' }));
  expect(apiFetch).toHaveBeenCalledWith('/api/sessions/cold-full/codex-queue/continue', {
    method: 'POST',
    headers: { 'X-Connection-ID': 'owned-sse' },
    signal: expect.any(AbortSignal),
  });
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
});

it('does not offer a cold queue effect without the server original-owner qualification', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({ paused: true, connected: false, queued: 32, interrupted: 1, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Retained work' }]));
  render(<CodexQueueStatus sessionId="cold-unqualified" />);
  await screen.findByRole('button', { name: 'Review queue' });
  expect(screen.queryByRole('button', { name: 'Reconnect and continue' })).toBeNull();
});

it('keeps the reconnect fallback available when recovery fails', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({ paused: true, connected: true, queued: 1, interrupted: 1, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Saved follow-up' }]))
    .mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Provider is still unavailable.' }),
    } as Response);

  render(<CodexQueueStatus sessionId="paused-failure" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Reconnect and continue' }));

  expect(await screen.findByText('Provider is still unavailable.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Reconnect and continue' })).toBeTruthy();
});

it('offers an explicit retry for the saved failed turn without queued follow-ups', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({
        paused: true,
        connected: true,
        queued: 0,
        interrupted: 0,
        failed: 1,
        recovering: false,
      }),
    )
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response)
    .mockResolvedValueOnce(
      meta({
        paused: false,
        connected: true,
        queued: 0,
        interrupted: 0,
        failed: 0,
        recovering: false,
      }),
    );

  render(<CodexQueueStatus sessionId="failed" />);
  expect(await screen.findByText('Previous turn failed. Retry when available.')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Retry saved turn' }));

  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/failed/codex-queue/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmAmbiguous: false }),
      signal: expect.any(AbortSignal),
    }),
  );
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
});

it('honors the provider retry window before enabling the saved turn', async () => {
  const retryAvailableAt = Date.now() + 9_000;
  vi.mocked(apiFetch).mockResolvedValue(
    meta({
      paused: true,
      connected: true,
      queued: 0,
      interrupted: 0,
      failed: 1,
      retryAvailableAt,
      recovering: false,
    }),
  );

  render(<CodexQueueStatus sessionId="delayed" />);
  expect(await screen.findByText(/OpenAI asked us to wait/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /Retry in/ }).hasAttribute('disabled')).toBe(true);
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('does not offer retry for a saved non-retryable failure', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    meta({
      paused: true,
      connected: true,
      queued: 0,
      interrupted: 0,
      failed: 1,
      retryable: false,
      recovering: false,
    }),
  );

  render(<CodexQueueStatus sessionId="non-retryable" />);
  expect(
    await screen.findByText('This failed turn needs attention and cannot be retried.'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Retry saved turn/ })).toBeNull();
});

it('reattaches a disconnected provider in the background while preserving the failed turn', async () => {
  const disconnected = meta({
    paused: true,
    connected: false,
    queued: 0,
    interrupted: 0,
    failed: 1,
    retryable: true,
    recovering: false,
  });
  const connected = meta({
    paused: true,
    connected: true,
    queued: 0,
    interrupted: 0,
    failed: 1,
    retryable: true,
    recovering: false,
  });
  let metadataReads = 0;
  let reattachRequests = 0;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/codex-queue/reattach')) {
      reattachRequests += 1;
      return {
        ok: true,
        status: reattachRequests === 1 ? 202 : 200,
        json: async () => ({ ok: true }),
      } as Response;
    }
    metadataReads += 1;
    // The first asynchronous startup has not connected yet. The component
    // must keep polling and allow another idempotent reattach request.
    return metadataReads < 3 ? disconnected : connected;
  });

  render(<CodexQueueStatus sessionId="detached" />);
  expect(
    await screen.findByText('Restarting provider… The failed turn remains saved.'),
  ).toBeTruthy();
  await waitFor(
    () =>
      expect(
        vi
          .mocked(apiFetch)
          .mock.calls.filter(([url]) => url === '/api/sessions/detached/codex-queue/reattach'),
      ).toHaveLength(2),
    { timeout: 5000 },
  );
  expect(await screen.findByRole('button', { name: 'Retry saved turn' })).toBeTruthy();
  expect(screen.getByText('Previous turn failed. Retry when available.')).toBeTruthy();
  expect(screen.queryByText('Provider restarted. The failed turn is ready for review.')).toBeNull();
});

it('warns before retrying an ambiguous turn that already invoked tools', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({
        paused: true,
        connected: true,
        queued: 0,
        interrupted: 0,
        failed: 1,
        retryable: true,
        requiresRetryConfirmation: true,
        recovering: false,
      }),
    )
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response)
    .mockResolvedValueOnce(
      meta({
        paused: false,
        connected: true,
        queued: 0,
        interrupted: 0,
        failed: 0,
        recovering: false,
      }),
    );

  render(<CodexQueueStatus sessionId="ambiguous" />);
  expect(await screen.findByText(/may repeat tool actions/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Retry despite possible repeats' }));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/sessions/ambiguous/codex-queue/retry',
    expect.objectContaining({ body: JSON.stringify({ confirmAmbiguous: true }) }),
  );
});

it('hides to an edge control outside the status layout and stays hidden through polling', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockResolvedValue(
    meta({
      paused: true,
      connected: true,
      queued: 0,
      interrupted: 1,
      recovering: true,
      recoveryPhase: 'reconnecting',
    }),
  );
  render(<CodexQueueStatus sessionId="paused" />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Hide status' }));
  const tab = screen.getByRole('button', { name: 'Chat status' });
  expect(screen.queryByRole('status')).toBeNull();
  expect(tab.className).toBe('codex-queue-status-tab');

  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(screen.getByRole('button', { name: 'Chat status' })).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});

it('does not fast-poll a paused inactive chat with no queued or recovering work', async () => {
  vi.useFakeTimers();
  vi.mocked(apiFetch).mockResolvedValue(
    meta({ paused: true, connected: false, queued: 0, interrupted: 1, recovering: false }),
  );
  render(<CodexQueueStatus sessionId="inactive" />);
  await act(async () => {});

  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('allows a horizontal swipe to hide and restores focus when the edge control opens', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    meta({
      paused: true,
      connected: true,
      queued: 0,
      interrupted: 1,
      recovering: true,
      recoveryPhase: 'reconnecting',
    }),
  );
  render(<CodexQueueStatus sessionId="swipe" />);
  const status = await screen.findByRole('status');
  fireEvent.pointerDown(status, { clientX: 8, clientY: 12 });
  fireEvent.pointerUp(status, { clientX: 72, clientY: 14 });
  const tab = screen.getByRole('button', { name: 'Chat status' });
  expect(document.activeElement).toBe(tab);
  await userEvent.click(tab);
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Hide status' })),
  );
});

it('consumes a follow-up cancel click after a cancel-originated horizontal gesture', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Saved prompt' }]));
  render(<CodexQueueStatus sessionId="gesture" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Review queue' }));

  const cancel = screen.getByRole('button', { name: 'Cancel' });
  fireEvent.pointerDown(cancel, { clientX: 8, clientY: 12 });
  fireEvent.pointerUp(cancel, { clientX: 72, clientY: 14 });
  fireEvent.click(cancel, { detail: 1 });

  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('allows the next deliberate pointer or keyboard cancellation when a swipe click is suppressed', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Saved prompt' }]))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Saved prompt' }]));
  render(<CodexQueueStatus sessionId="suppressed-gesture" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Review queue' }));

  const cancel = screen.getByRole('button', { name: 'Cancel' });
  fireEvent.pointerDown(cancel, { clientX: 8, clientY: 12 });
  fireEvent.pointerUp(cancel, { clientX: 72, clientY: 14 });
  // No click follows: some touch browsers suppress it after a gesture.
  fireEvent.pointerDown(cancel, { clientX: 8, clientY: 12 });
  fireEvent.pointerUp(cancel, { clientX: 8, clientY: 12 });
  fireEvent.click(cancel, { detail: 1 });

  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(5));
  expect(apiFetch).toHaveBeenNthCalledWith(
    3,
    '/api/sessions/suppressed-gesture/codex-queue/saved/cancel',
    expect.objectContaining({ method: 'POST' }),
  );
});

it('does not swallow keyboard cancellation after a cancel-originated swipe', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Saved prompt' }]))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Saved prompt' }]));
  render(<CodexQueueStatus sessionId="keyboard-gesture" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Review queue' }));

  const cancel = screen.getByRole('button', { name: 'Cancel' });
  fireEvent.pointerDown(cancel, { clientX: 8, clientY: 12 });
  fireEvent.pointerUp(cancel, { clientX: 72, clientY: 14 });
  fireEvent.click(cancel, { detail: 0 });

  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(5));
  expect(apiFetch).toHaveBeenNthCalledWith(
    3,
    '/api/sessions/keyboard-gesture/codex-queue/saved/cancel',
    expect.objectContaining({ method: 'POST' }),
  );
});

it('allows an attention status to be dismissed and reports a cancel race honestly', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 1, interrupted: 0, recovering: false }),
    )
    .mockResolvedValueOnce(commands([{ id: 'started', preview: 'Saved prompt' }]))
    .mockResolvedValueOnce({ ok: false, status: 409 } as Response)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 0, interrupted: 0, recovering: false }),
    );
  render(<CodexQueueStatus sessionId="race" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Review queue' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(
    await screen.findByText('Could not cancel this message. It may have started; check the queue.'),
  ).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Attention' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Hide status' }));
  expect(screen.getByRole('button', { name: 'Chat status' })).toBeTruthy();
});

it('has no row or edge control when the session is not a Codex chat', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  render(<CodexQueueStatus sessionId="regular" />);
  await act(async () => {});
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Chat status' })).toBeNull();
});

it('does not resurrect a status row for historical interrupted work with nothing waiting', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    meta({ paused: true, connected: false, queued: 0, interrupted: 3, recovering: false }),
  );
  render(<CodexQueueStatus sessionId="completed" />);
  await act(async () => {});
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Chat status' })).toBeNull();
});

it('clears a successful reconnect notice when fresh metadata reports no pending work', async () => {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(meta({ paused: true, connected: true, queued: 1, interrupted: 1 }))
    .mockResolvedValueOnce(commands([{ id: 'saved', preview: 'Synthetic saved work' }]))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response)
    .mockResolvedValueOnce(
      meta({ paused: false, connected: true, queued: 0, interrupted: 0, failed: 0 }),
    );
  render(<CodexQueueStatus sessionId="cleared" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Reconnect and continue' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByText('An earlier step may be incomplete.')).toBeNull();
  expect(screen.queryByText('Reconnected. Continuing saved messages.')).toBeNull();
});

it('uses delivery progress without an attention panel when no saved work needs action', async () => {
  vi.mocked(apiFetch).mockResolvedValue(meta(idleQueue));
  const view = render(<CodexQueueStatus sessionId="quiet" deliveryStatus="Preparing response…" />);
  expect((await screen.findByRole('status')).textContent).toContain('Preparing response…');
  expect(screen.queryByRole('img', { name: 'Attention' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Hide status' })).toBeNull();
  view.rerender(<CodexQueueStatus sessionId="quiet" deliveryStatus={null} />);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
});

it('prioritizes queue recovery over duplicate delivery progress', async () => {
  vi.mocked(apiFetch).mockResolvedValue(meta({ ...idleQueue, recovering: true }));
  render(<CodexQueueStatus sessionId="one-status" deliveryStatus="Preparing response…" />);
  await screen.findByText('Reconnecting…');
  expect(screen.queryByText('Preparing response…')).toBeNull();
  expect(screen.getAllByRole('status')).toHaveLength(1);
});

it('does not preserve a failed background reattach notice after healthy metadata arrives', async () => {
  vi.useFakeTimers();
  let healthy = false;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path).endsWith('/reattach'))
      return { ok: false, json: async () => ({ error: 'Temporary restart failure' }) } as Response;
    return meta(
      healthy ? idleQueue : { ...idleQueue, connected: false, failed: 1, retryable: true },
    );
  });
  render(<CodexQueueStatus sessionId="background-recovered" />);
  await act(async () => {});
  expect(screen.queryByText('Temporary restart failure')).toBeNull();
  expect(screen.queryByRole('img', { name: 'Attention' })).toBeNull();
  healthy = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.queryByRole('status')).toBeNull();
});

it('keeps a new delivery failure visible when queue details were previously hidden', async () => {
  sessionStorage.setItem('mitzo-codex-status-hidden:hidden-error', '1');
  vi.mocked(apiFetch).mockResolvedValue(meta({ ...idleQueue, queued: 1 }));
  render(
    <CodexQueueStatus sessionId="hidden-error" deliveryError="Message delivery needs review" />,
  );
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText('Message delivery needs review')).toBeTruthy();
});

it('shows exact native reconciliation action while preserving queued work and the existing explicit reconnect control', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path).endsWith('/meta')
      ? meta({
          ...idleQueue,
          paused: true,
          canContinue: true,
          queued: 1,
          interrupted: 1,
          operation: {
            commandId: 'interrupted',
            attempt: 2,
            state: 'ambiguous_effect',
            nextAction: 'reconcile_native_outcome',
          },
        })
      : commands([{ id: 'queued', preview: 'Retained next command' }]),
  );
  render(<CodexQueueStatus sessionId="native-exact-outcome" />);
  await act(async () => {});
  expect(screen.getByRole('status').textContent).toContain(
    'Check the interrupted turn before continuing. Saved work is preserved.',
  );
  expect(screen.getByRole('button', { name: 'Reconnect and continue' })).toBeTruthy();
  expect(
    vi.mocked(apiFetch).mock.calls.every(([path]) => !String(path).includes('/continue')),
  ).toBe(true);
});

it('clears old native uncertainty when the current command completed', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    meta({
      ...idleQueue,
      operation: {
        commandId: 'done',
        attempt: 1,
        state: 'completed',
        nextAction: 'inspect_retained_work',
      },
    }),
  );
  render(<CodexQueueStatus sessionId="native-completed" />);
  await act(async () => {});
  expect(screen.queryByRole('status')).toBeNull();
});

it('ignores malformed optional operation diagnostics without hiding the legacy queue', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    meta({ ...idleQueue, queued: 1, operation: { state: 'unsupported', raw: 'not displayable' } }),
  );
  render(<CodexQueueStatus sessionId="native-optional-metadata" />);
  await act(async () => {});
  expect(screen.getByText('1 message queued')).toBeTruthy();
  expect(screen.queryByText('not displayable')).toBeNull();
});

it('keeps completed responses distinct from an unfinished follow-up with unknown effects', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    meta({
      ...idleQueue,
      paused: true,
      canContinue: true,
      queued: 1,
      operation: {
        commandId: 'completed-response',
        attempt: 1,
        state: 'completed',
        effectStatus: 'unknown',
        nextAction: 'inspect_retained_work',
      },
    }),
  );
  render(<CodexQueueStatus sessionId="completed-response-unknown-effects" />);
  await act(async () => {});
  expect(screen.getByRole('status').textContent).toContain(
    'The response completed. Check unfinished work before continuing.',
  );
  expect(screen.queryByText('Previous turn failed. Retry when available.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reconnect and continue' })).toBeNull();
  expect(
    vi.mocked(apiFetch).mock.calls.every(([path]) => !String(path).includes('/continue')),
  ).toBe(true);
});

it('offers explicit reconciliation when the original completion owner observed success', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    meta({
      ...idleQueue,
      paused: true,
      canContinue: true,
      queued: 1,
      operation: {
        commandId: 'completed-response',
        attempt: 1,
        state: 'completed',
        effectStatus: 'unknown',
        nextAction: 'reconcile_completion_phase',
      },
    }),
  );
  render(<CodexQueueStatus sessionId="observed-completion" />);
  await act(async () => {});
  expect(screen.getByRole('status').textContent).toContain(
    'The response completed. Reconnect to check its follow-up.',
  );
  expect(screen.getByRole('button', { name: 'Reconnect and continue' })).toBeTruthy();
  expect(
    vi.mocked(apiFetch).mock.calls.every(([path]) => !String(path).includes('/continue')),
  ).toBe(true);
});
