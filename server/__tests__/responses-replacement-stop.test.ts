import { expect, it, vi } from 'vitest';
import type { ManagedSession } from '@mitzo/harness';
import { ExecutionController } from '../execution-controller.js';

const responses = vi.hoisted(() => ({
  prepare: vi.fn(),
}));

vi.mock('../responses-chat-session.js', () => ({
  getResponsesRuntime: () => responses,
  openResponsesChat: vi.fn(),
}));

const chat = await import('../chat.js');

it('does not prepare or push a Responses replacement after stop wins during interrupt idle wait', async () => {
  const clientId = `responses-stop-race-${Date.now()}`;
  const sessionId = `responses-stop-race-session-${Date.now()}`;
  const transport = { send: vi.fn(), isOpen: () => true };
  const push = vi.fn();
  let releaseInterrupt!: () => void;
  const interrupt = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releaseInterrupt = resolve;
      }),
  );
  responses.prepare.mockReset();
  chat.registry.register(clientId, {
    transport,
    abortController: new AbortController(),
    mode: 'agent',
    sessionId,
    sessionAllowList: new Set(),
  });
  try {
    const session = chat.registry.get(clientId)!;
    session.inputQueue = { push, close: vi.fn() } as unknown as ManagedSession['inputQueue'];
    session.queryInstance = { interrupt, close: vi.fn(), stopTask: vi.fn() };
    chat.eventStore.upsertSession({ sessionId });
    session.currentExecution = chat.eventStore.beginExecution(
      sessionId,
      'responses-old-turn',
    ).token;

    const replacement = chat.interruptChat(
      clientId,
      'replacement prompt',
      undefined,
      undefined,
      'responses-stop-race-message',
    );
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce());

    const lease = chat.registry.getRuntimeLease(clientId)!;
    const replacementToken = chat.registry.get(clientId)!.currentExecution!;
    await expect(
      new ExecutionController({
        registry: chat.registry,
        eventStore: chat.eventStore,
      }).stopExecution(lease, replacementToken),
    ).resolves.toMatchObject({ transition: { applied: true } });
    releaseInterrupt();

    // The durable admission remains the acknowledgement; dispatch is fenced
    // by the exact current token after the provider's interrupt/idle wait.
    await expect(replacement).resolves.toEqual({ kind: 'accepted' });
    expect(responses.prepare).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(chat.eventStore.getSession(sessionId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionGeneration: 2,
      executionTerminalReason: 'stopped',
    });
  } finally {
    chat.registry.abort(clientId);
  }
});
