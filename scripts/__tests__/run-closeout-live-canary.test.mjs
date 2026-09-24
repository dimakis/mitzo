import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCloseoutTracker,
  liveCanaryConfig,
  parseSseChunk,
  runCloseoutLiveCanary,
} from '../run-closeout-live-canary.mjs';

const validEnv = {
  MITZO_PROBE_PASSPHRASE: 'secret',
  MITZO_PROBE_ACCOUNT_ID: 'work-openai',
  MITZO_PROBE_MODEL: 'gpt-5.6-luna',
  MITZO_PROBE_REASONING_EFFORT: 'medium',
  MITZO_PROBE_ACKNOWLEDGE_NON_PRODUCTION: '1',
  MITZO_PROBE_ACKNOWLEDGE_CHARGE: 'work-openai:gpt-5.6-luna',
};

describe('closeout live canary', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requires an exact Luna account/model charge acknowledgement', () => {
    expect(liveCanaryConfig(validEnv)).toMatchObject({
      accountId: 'work-openai',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
    });
    expect(() => liveCanaryConfig({ ...validEnv, MITZO_PROBE_MODEL: 'gpt-5.6-sol' })).toThrow(
      'Luna',
    );
    expect(() =>
      liveCanaryConfig({ ...validEnv, MITZO_PROBE_ACKNOWLEDGE_CHARGE: 'work-openai:other' }),
    ).toThrow('work-openai:gpt-5.6-luna');
    expect(() =>
      liveCanaryConfig({ ...validEnv, MITZO_PROBE_ACKNOWLEDGE_NON_PRODUCTION: '0' }),
    ).toThrow('NON_PRODUCTION');
  });

  it('retains partial SSE frames', () => {
    const first = parseSseChunk('', 'data: {"type":"wel');
    expect(first.messages).toEqual([]);
    const second = parseSseChunk(first.buffer, 'come"}\n\ndata: {"type":"heartbeat"}\n\n');
    expect(second.buffer).toBe('');
    expect(second.messages).toEqual([{ type: 'welcome' }, { type: 'heartbeat' }]);
  });

  it('requires one completed provider attempt and an ended session', () => {
    const tracker = createCloseoutTracker('session-1');
    for (const message of [
      { type: 'session_close_ack', sessionId: 'session-1', accepted: true },
      {
        type: 'user_message',
        sessionId: 'session-1',
        text: 'The user has closed this session.\nPlease perform session closeout:',
      },
      {
        type: 'provider_attempt_state_changed',
        sessionId: 'session-1',
        executionId: 'execution-1',
        generation: 1,
        providerAttemptId: 'attempt-1',
        attempt: 1,
        phase: 'RUNNING',
      },
      {
        type: 'provider_attempt_state_changed',
        sessionId: 'session-1',
        executionId: 'execution-1',
        generation: 1,
        providerAttemptId: 'attempt-1',
        attempt: 1,
        phase: 'TERMINAL',
        terminalReason: 'completed',
      },
      {
        type: 'execution_state_changed',
        sessionId: 'session-1',
        executionId: 'execution-1',
        generation: 1,
        phase: 'TERMINAL',
        terminalReason: 'completed',
      },
    ])
      tracker.accept(message);
    tracker.acceptDurableSession({ sessionId: 'session-1', state: 'ENDED', isActive: false });

    expect(tracker.complete()).toBe(true);
    expect(tracker.evidence()).toEqual({
      sessionId: 'session-1',
      executionId: 'execution-1',
      generation: 1,
      providerAttemptId: 'attempt-1',
      terminalReason: 'completed',
      providerAttemptCount: 1,
      finalState: 'ENDED',
    });
  });

  it('rejects duplicate provider dispatch', () => {
    const tracker = createCloseoutTracker('session-1');
    for (const providerAttemptId of ['attempt-1', 'attempt-2']) {
      tracker.accept({
        type: 'provider_attempt_state_changed',
        sessionId: 'session-1',
        executionId: 'execution-1',
        generation: 1,
        providerAttemptId,
        attempt: providerAttemptId === 'attempt-1' ? 1 : 2,
        phase: 'RUNNING',
      });
      tracker.accept({
        type: 'provider_attempt_state_changed',
        sessionId: 'session-1',
        executionId: 'execution-1',
        generation: 1,
        providerAttemptId,
        attempt: providerAttemptId === 'attempt-1' ? 1 : 2,
        phase: 'TERMINAL',
        terminalReason: 'completed',
      });
    }
    tracker.accept({ type: 'session_close_ack', sessionId: 'session-1', accepted: true });
    tracker.accept({
      type: 'user_message',
      sessionId: 'session-1',
      text: 'The user has closed this session.',
    });
    tracker.accept({
      type: 'execution_state_changed',
      sessionId: 'session-1',
      executionId: 'execution-1',
      generation: 1,
      phase: 'TERMINAL',
      terminalReason: 'completed',
    });
    tracker.acceptDurableSession({ sessionId: 'session-1', state: 'ENDED', isActive: false });

    expect(() => tracker.evidence()).toThrow('exactly one provider attempt');
  });

  it('rejects provider evidence from another execution generation', () => {
    const tracker = createCloseoutTracker('session-1');
    tracker.accept({ type: 'session_close_ack', sessionId: 'session-1', accepted: true });
    tracker.accept({
      type: 'user_message',
      sessionId: 'session-1',
      text: 'The user has closed this session.',
    });
    for (const phase of ['RUNNING', 'TERMINAL'])
      tracker.accept({
        type: 'provider_attempt_state_changed',
        sessionId: 'session-1',
        executionId: 'execution-old',
        generation: 1,
        providerAttemptId: 'attempt-1',
        attempt: 1,
        phase,
        ...(phase === 'TERMINAL' ? { terminalReason: 'completed' } : {}),
      });
    tracker.accept({
      type: 'execution_state_changed',
      sessionId: 'session-1',
      executionId: 'execution-new',
      generation: 2,
      phase: 'TERMINAL',
      terminalReason: 'completed',
    });
    tracker.acceptDurableSession({ sessionId: 'session-1', state: 'ENDED', isActive: false });

    expect(() => tracker.evidence()).toThrow('does not match the terminal execution');
  });

  it('uses SSE for setup and durable events for closeout evidence', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const messages = [
      { type: 'welcome', connectionId: 'connection-1' },
      {
        type: 'block_delta',
        sessionId: 'session-1',
        blockType: 'text',
        delta: 'CLOSEOUT_CANARY_READY_123',
      },
      { type: 'session_end', sessionId: 'session-1' },
    ];
    const durableEvents = [
      {
        type: 'user_message',
        sessionId: 'session-1',
        text: 'The user has closed this session.',
        seq: 10,
      },
      {
        type: 'provider_attempt_state_changed',
        sessionId: 'session-1',
        executionId: 'execution-1',
        generation: 1,
        providerAttemptId: 'attempt-1',
        attempt: 1,
        phase: 'RUNNING',
        seq: 11,
      },
      {
        type: 'provider_attempt_state_changed',
        sessionId: 'session-1',
        executionId: 'execution-1',
        generation: 1,
        providerAttemptId: 'attempt-1',
        attempt: 1,
        phase: 'TERMINAL',
        terminalReason: 'completed',
        seq: 12,
      },
      {
        type: 'execution_state_changed',
        sessionId: 'session-1',
        executionId: 'execution-1',
        generation: 1,
        phase: 'TERMINAL',
        terminalReason: 'completed',
        seq: 13,
      },
    ];
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join(''),
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/api/auth/login')) return Response.json({ token: 'token' });
      if (url.includes('/api/chat/events')) return new Response(stream);
      if (url.endsWith('/api/chat/reconnect')) return Response.json({ ok: true });
      if (url.endsWith('/api/chat/send')) return Response.json({ sessionId: 'session-1' });
      if (url.endsWith('/api/chat/close')) return Response.json({ ok: true });
      if (url.endsWith('/api/sessions/session-1/events?after=0'))
        return Response.json(durableEvents);
      if (url.endsWith('/api/sessions/session-1/meta'))
        return Response.json({ sessionId: 'session-1', state: 'ENDED', isActive: false });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runCloseoutLiveCanary({
        baseUrl: 'http://localhost:4311',
        passphrase: 'secret',
        accountId: 'work-openai',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'medium',
        timeoutMs: 130_000,
      }),
    ).resolves.toMatchObject({
      sessionId: 'session-1',
      executionId: 'execution-1',
      providerAttemptCount: 1,
      finalState: 'ENDED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    for (const [, init] of fetchMock.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('clears the deadline when SSE setup fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/api/auth/login')) return Response.json({ token: 'token' });
      throw new Error('SSE unavailable');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runCloseoutLiveCanary({
        baseUrl: 'http://localhost:4311',
        passphrase: 'secret',
        accountId: 'work-openai',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'medium',
        timeoutMs: 130_000,
      }),
    ).rejects.toThrow('SSE unavailable');
    expect(vi.getTimerCount()).toBe(0);
    for (const [, init] of fetchMock.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
