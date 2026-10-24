import { afterEach, expect, it, vi } from 'vitest';
import { ROOT_CONTEXT, type Span } from '@opentelemetry/api';
import { tracer } from '../tracing.js';
import { startCommandTimingSpan, finishCommandTimingSpan } from '../command-timing-trace.js';
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
