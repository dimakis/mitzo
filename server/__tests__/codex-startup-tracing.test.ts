import { afterEach, expect, it, vi } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { tracer } from '../tracing.js';
import { CodexStartupError, duringCodexStartup } from '../codex-startup-error.js';

afterEach(() => vi.restoreAllMocks());
it.each(['success', 'failure'] as const)(
  'measures complete startup phase until %s with status only',
  async (outcome) => {
    const span = {
      setStatus: vi.fn(),
      end: vi.fn(),
      setAttribute: vi.fn(),
      recordException: vi.fn(),
    };
    const starting = vi
      .spyOn(tracer, 'startSpan')
      .mockReturnValue(span as unknown as ReturnType<typeof tracer.startSpan>);
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cause = new Error('PRIVATE /account/path?token=secret');
    const operation = duringCodexStartup('sandbox_preparation', async () => {
      await waiting;
      if (outcome === 'failure') throw cause;
      return 'ready';
    });
    expect(starting).toHaveBeenCalledWith('codex.startup.sandbox_preparation');
    expect(span.end).not.toHaveBeenCalled();
    finish();
    if (outcome === 'failure') {
      await expect(operation).rejects.toBeInstanceOf(CodexStartupError);
      await expect(operation).rejects.toHaveProperty('cause', cause);
    } else await expect(operation).resolves.toBe('ready');
    expect(span.end).toHaveBeenCalledOnce();
    expect(span.setStatus).toHaveBeenCalledExactlyOnceWith({
      code: outcome === 'failure' ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    });
    expect(span.setAttribute).not.toHaveBeenCalled();
    expect(span.recordException).not.toHaveBeenCalled();
  },
);
