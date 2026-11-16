import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { CodexRecoveryEffectsError } from '../codex-recovery-effects-error.js';
import { codexRuntimeErrorTelemetry } from '../codex-runtime-diagnostics.js';
import { reportRetainedRuntimeFailure } from '../retained-runtime-failure.js';
import { RuntimeFailureSchema } from '@mitzo/protocol';
import { trace } from '@opentelemetry/api';

const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: () => log }));
afterEach(() => vi.restoreAllMocks());

it('keeps the failed receipt check through wrappers, reporting and strict history replay', () => {
  const store = new EventStore(':memory:');
  try {
    store.upsertSession({ sessionId: 'chat', cwd: '/offline/task' });
    const error = new CodexRecoveryEffectsError('result_missing', {
      commandId: 'command',
      turnId: 'turn',
      callId: 'call',
      observedCalls: 2,
      retainedReceipts: 2,
    });
    const wrapper = new Error('private upstream contents', { cause: error });
    const addEvent = vi.fn();
    const span = vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ addEvent } as never);
    expect(codexRuntimeErrorTelemetry(wrapper)).toMatchObject({
      runtimeFailureCode: 'recovery_effects_unverified',
      recoveryStage: 'host_receipts',
      recoveryFailedCheck: 'result_missing',
      commandId: 'command',
      turnId: 'turn',
      callId: 'call',
    });
    reportRetainedRuntimeFailure({ store, sessionId: 'chat', error: wrapper });
    expect(addEvent).toHaveBeenCalledWith(
      'runtime.failure',
      expect.objectContaining({
        recoveryFailedCheck: 'result_missing',
        callId: 'call',
      }),
    );
    span.mockRestore();
    expect(log.warn).toHaveBeenCalledWith(
      'Saved runtime work requires attention',
      expect.objectContaining({
        recoveryStage: 'host_receipts',
        recoveryFailedCheck: 'result_missing',
        callId: 'call',
      }),
    );
    const event = store.getLatestEvent('chat', 'error')!;
    expect(RuntimeFailureSchema.parse(event.payload.runtimeFailure)).toEqual(error.telemetry());
    expect(JSON.stringify(event)).not.toContain('private upstream');
    expect(event.payload).not.toHaveProperty('callId');
  } finally {
    store.close();
  }
});

it('retains and delivers the original failure when trace reporting fails', () => {
  const store = new EventStore(':memory:');
  try {
    store.upsertSession({ sessionId: 'chat', cwd: '/offline/task' });
    const failure = new CodexRecoveryEffectsError('effect_unsettled', {
      commandId: 'command',
      turnId: 'turn',
      callId: 'call',
      observedCalls: 1,
      retainedReceipts: 1,
    });
    const send = vi.fn();
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({
      addEvent() {
        throw Error('private exporter failure');
      },
    } as never);
    expect(() =>
      reportRetainedRuntimeFailure({
        store,
        sessionId: 'chat',
        error: failure,
        transport: { isOpen: () => true, send },
      }),
    ).not.toThrow();
    expect(store.getLatestEvent('chat', 'error')!.payload.runtimeFailure).toEqual(
      failure.telemetry(),
    );
    expect(send).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      'Runtime diagnostic trace delivery failed',
      expect.objectContaining({
        code: 'runtime_diagnostic_trace_failed',
        diagnosticId: failure.diagnosticId,
      }),
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private exporter');
  } finally {
    store.close();
  }
});
