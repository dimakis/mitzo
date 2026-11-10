import { afterEach, expect, it, vi } from 'vitest';
const span = vi.hoisted(() => ({ end: vi.fn(), setStatus: vi.fn() }));
const startSpan = vi.hoisted(() => vi.fn(() => span));
const initialization = vi.hoisted(() => ({ ready: undefined as Promise<void> | undefined }));
vi.mock('../tracing', () => ({
  tracer: { startSpan },
  get tracingReady() {
    return initialization.ready;
  },
}));
import { recordCommandDeliveryDiagnostic } from '../command-delivery-tracing';
afterEach(() => {
  vi.restoreAllMocks();
  initialization.ready = undefined;
  startSpan.mockClear();
});

it('exports only bounded delivery evidence and preserves cold failures without another send', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let ready!: () => void;
  initialization.ready = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const event = {
    clientMsgId: 'original-command',
    sessionId: 'chat',
    diagnostic: {
      operation: 'submit' as const,
      stage: 'request' as const,
      code: 'transport_failed' as const,
      startedAt: 1000,
      elapsedMs: 50,
    },
  };
  recordCommandDeliveryDiagnostic(event, new TypeError('secret token, URL and user text'));
  expect(startSpan).not.toHaveBeenCalled();
  expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  ready();
  await initialization.ready;
  expect(startSpan).toHaveBeenCalledExactlyOnceWith(
    'command.delivery.failure',
    expect.objectContaining({
      startTime: 1000,
      attributes: expect.objectContaining({
        'mitzo.command.id': 'original-command',
        'mitzo.delivery.code': 'transport_failed',
        'mitzo.delivery.stage': 'request',
      }),
    }),
  );
  expect(span.end).toHaveBeenLastCalledWith(1050);
  expect(JSON.stringify(startSpan.mock.calls)).not.toContain('secret');
});
