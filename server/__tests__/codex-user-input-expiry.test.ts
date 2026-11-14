import { expect, it, vi } from 'vitest';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { requestCodexUserInput } from '../codex-user-input.js';

it('reports native question timeout separately without fabricating an answer or cancelling the chat', async () => {
  vi.useFakeTimers();
  const registry = new SessionRegistry();
  const abort = new AbortController();
  const sent: Record<string, unknown>[] = [];
  registry.register('client', {
    sessionId: 'session',
    mode: 'agent',
    sessionAllowList: new Set(),
    abortController: abort,
    transport: { isOpen: () => true, send: (event) => sent.push(event) },
  });
  const params = {
    threadId: 'thread',
    turnId: 'turn',
    itemId: 'question',
    questions: [
      {
        id: 'choice',
        header: 'Continue',
        question: 'Continue the task?',
        isOther: true,
        isSecret: false,
        options: [{ label: 'Continue', description: 'Resume work' }],
      },
    ],
  };
  const observe = vi.fn();
  try {
    const first = requestCodexUserInput(params, abort.signal, 'client', registry, observe);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await first).toEqual({ answers: {} });
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        code: 'approval_expired',
        phase: 'approval',
        effectStatus: 'not_started',
      }),
    );
    expect(abort.signal.aborted).toBe(false);
    const next = requestCodexUserInput(
      { ...params, itemId: 'question-2' },
      abort.signal,
      'client',
      registry,
      observe,
    );
    await vi.advanceTimersByTimeAsync(0);
    const card = sent.filter((event) => event.type === 'permission_request').at(-1)!;
    resolvePending(String(card.permId), 'once', { choice: ['Continue'] }, 'session');
    expect(await next).toEqual({ answers: { choice: { answers: ['Continue'] } } });
  } finally {
    abort.abort();
    registry.dispose();
    vi.useRealTimers();
  }
});
