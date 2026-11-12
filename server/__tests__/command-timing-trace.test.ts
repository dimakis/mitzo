import { ROOT_CONTEXT, type Span } from '@opentelemetry/api';
import { afterEach, expect, it, vi } from 'vitest';
import { tracer } from '../tracing.js';
import {
  startCommandTimingSpan,
  finishCommandTimingSpan,
  recordCommandQueueReason,
} from '../command-timing-trace.js';

afterEach(() => vi.restoreAllMocks());

it('telemetry startup and cleanup faults are observational and never expose an unbounded identifier', () => {
  const start = vi.spyOn(tracer, 'startSpan').mockImplementation(() => {
    throw Error('Broken telemetry');
  });
  expect(
    startCommandTimingSpan('codex.command.http', 'private prompt with spaces', ROOT_CONTEXT),
  ).toBeUndefined();
  expect(start.mock.calls[0][1]?.attributes).toEqual({});
  const span = {
    setAttribute: vi.fn(() => {
      throw Error('Broken attribute');
    }),
    end: vi.fn(() => {
      throw Error('Broken exporter');
    }),
  };
  expect(() => finishCommandTimingSpan(span as unknown as Span, 'closed')).not.toThrow();
  expect(span.end).toHaveBeenCalledOnce();
});

it('pins the timing helper and real entry/controller instrumentation in the reviewed source closure', async () => {
  const { readFile } = await import('node:fs/promises');
  const { reviewedHandlerSourceArtifacts, reviewedHandlerSourceFingerprint } =
    await import('../connections/reviewed-handler-artifacts.js');
  const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const file of [
    '../command-timing-trace.ts',
    '../codex-output-timing.ts',
    '../ordinary-local-codex-entry.ts',
    '../codex-conversation.ts',
  ]) {
    const source = await readFile(
      new URL(file, new URL('../connections/', import.meta.url)),
      'utf8',
    );
    expect(artifacts[file], file).toBe(reviewedHandlerSourceFingerprint(source));
  }
});

it.each(['ordinary-id', 'session-prompt:123-abc', 'collaboration:123-abc'])(
  'retains correlation for internal command %s',
  (id) => {
    const start = vi.spyOn(tracer, 'startSpan');
    startCommandTimingSpan('codex.command.queue_wait', id, ROOT_CONTEXT);
    expect(start).toHaveBeenCalledWith(
      'codex.command.queue_wait',
      {
        attributes: { 'mitzo.command.id': id },
      },
      ROOT_CONTEXT,
    );
  },
);

it('records reason transitions once without exporting input or inventing durations', () => {
  const span = { addEvent: vi.fn(), setAttribute: vi.fn() };
  for (const reason of [
    'active_turn',
    'active_turn',
    'deployment',
    'admission',
    'eligible',
  ] as const)
    recordCommandQueueReason(span as unknown as Span, reason);
  expect(span.addEvent.mock.calls).toEqual(
    ['active_turn', 'deployment', 'admission', 'eligible'].map((reason) => [
      'queue.reason_changed',
      { 'mitzo.queue.reason': reason },
    ]),
  );
  expect(span.setAttribute).toHaveBeenLastCalledWith('mitzo.queue.reason', 'eligible');
});
