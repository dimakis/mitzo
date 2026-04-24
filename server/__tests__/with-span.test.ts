import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import pino from 'pino';
import { trace, context } from '@opentelemetry/api';
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { _buildLogger } from '../logger.js';

let provider: NodeTracerProvider;
let exporter: InMemorySpanExporter;
let tmpDir: string;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
  tmpDir = mkdtempSync(join(tmpdir(), 'withspan-test-'));
});

function syncDest(logFile: string) {
  return pino.destination({ dest: logFile, sync: true, mkdir: true });
}

function readLogLines(logFile: string): Record<string, unknown>[] {
  const raw = readFileSync(logFile, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
}

function makeLogger(module: string, dest: pino.DestinationStream) {
  const root = _buildLogger(dest);
  const child = root.child({ module });
  return {
    info: (message: string, ctx?: Record<string, unknown>) => child.info(ctx ?? {}, message),
  };
}

describe('withSpan', () => {
  it('sets the span as active context so logger gets trace_id', async () => {
    const { withSpan } = await import('../tracing.js');
    const logFile = join(tmpDir, 'test.log');
    const log = makeLogger('span-test', syncDest(logFile));

    withSpan('test.op', { 'test.key': 'val' }, () => {
      log.info('inside withSpan');
    });

    const lines = readLogLines(logFile);
    const entry = lines.find((l) => l.msg === 'inside withSpan');
    expect(entry).toBeDefined();
    expect(entry!.trace_id).toBeDefined();
    expect(typeof entry!.trace_id).toBe('string');
    expect((entry!.trace_id as string).length).toBe(32);
    expect(entry!.span_id).toBeDefined();
  });

  it('exports a span with correct name and attributes', async () => {
    const { withSpan } = await import('../tracing.js');

    withSpan('test.export', { 'ws.connectionId': 'conn-42' }, () => {
      // work
    });

    const spans = exporter.getFinishedSpans();
    const span = spans.find((s) => s.name === 'test.export');
    expect(span).toBeDefined();
    expect(span!.attributes['ws.connectionId']).toBe('conn-42');
    expect(span!.status.code).toBe(1); // SpanStatusCode.OK
  });

  it('returns the value from the callback', async () => {
    const { withSpan } = await import('../tracing.js');
    const result = withSpan('test.return', {}, () => 42);
    expect(result).toBe(42);
  });

  it('records error status and re-throws on sync exception', async () => {
    const { withSpan } = await import('../tracing.js');

    expect(() =>
      withSpan('test.error', {}, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');

    const spans = exporter.getFinishedSpans();
    const span = spans.find((s) => s.name === 'test.error');
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(2); // ERROR
    expect(span!.status.message).toBe('boom');
  });

  it('does not leak span context after completion', async () => {
    const { withSpan } = await import('../tracing.js');

    withSpan('test.noleak', {}, () => {
      // inside
    });

    const activeSpan = trace.getSpan(context.active());
    expect(activeSpan).toBeUndefined();
  });
});

describe('withSpanAsync', () => {
  it('sets active context for async functions', async () => {
    const { withSpanAsync } = await import('../tracing.js');
    const logFile = join(tmpDir, 'async.log');
    const log = makeLogger('async-test', syncDest(logFile));

    await withSpanAsync('test.async', { 'test.mode': 'async' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      log.info('inside async span');
    });

    const lines = readLogLines(logFile);
    const entry = lines.find((l) => l.msg === 'inside async span');
    expect(entry).toBeDefined();
    expect(entry!.trace_id).toBeDefined();
    expect((entry!.trace_id as string).length).toBe(32);
  });

  it('records error on async rejection', async () => {
    const { withSpanAsync } = await import('../tracing.js');

    await expect(
      withSpanAsync('test.async.error', {}, async () => {
        throw new Error('async boom');
      }),
    ).rejects.toThrow('async boom');

    const spans = exporter.getFinishedSpans();
    const span = spans.find((s) => s.name === 'test.async.error');
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(2);
  });

  it('returns the resolved value', async () => {
    const { withSpanAsync } = await import('../tracing.js');
    const result = await withSpanAsync('test.async.return', {}, async () => 'hello');
    expect(result).toBe('hello');
  });

  it('inherits parent span context', async () => {
    const { withSpan } = await import('../tracing.js');

    let parentTraceId: string | undefined;
    let childTraceId: string | undefined;

    withSpan('parent', {}, (parentSpan) => {
      parentTraceId = parentSpan.spanContext().traceId;
      withSpan('child', {}, (childSpan) => {
        childTraceId = childSpan.spanContext().traceId;
      });
    });

    expect(parentTraceId).toBeDefined();
    expect(childTraceId).toBe(parentTraceId);
  });
});

describe('span hierarchy pattern', () => {
  /** SDK stores parent as parentSpanContext, not parentSpanId. */
  function parentId(span: { parentSpanContext?: { spanId?: string } }): string | undefined {
    return span.parentSpanContext?.spanId;
  }

  it('tool spans parent to turn spans via explicit setSpan', async () => {
    const { withSpan } = await import('../tracing.js');
    exporter.reset();

    // Mirrors query-loop: session span wraps turn, turn wraps tool
    withSpan('session', { 'session.clientId': 'test' }, () => {
      const tracer = trace.getTracer('mitzo', '1.0.0');

      // Turn span created with context.active() (session is active)
      const turnSpan = tracer.startSpan('turn', {}, context.active());

      // Fix pattern: explicitly parent tool to turn via setSpan
      const toolParent = trace.setSpan(context.active(), turnSpan);
      const toolSpan = tracer.startSpan('tool.Read', {}, toolParent);
      toolSpan.end();
      turnSpan.end();
    });

    const spans = exporter.getFinishedSpans();
    const session = spans.find((s) => s.name === 'session')!;
    const turn = spans.find((s) => s.name === 'turn')!;
    const tool = spans.find((s) => s.name === 'tool.Read')!;

    expect(session).toBeDefined();
    expect(turn).toBeDefined();
    expect(tool).toBeDefined();

    // session → turn → tool
    expect(parentId(turn)).toBe(session.spanContext().spanId);
    expect(parentId(tool)).toBe(turn.spanContext().spanId);
  });

  it('tool spans incorrectly parent to session without setSpan', async () => {
    const { withSpan } = await import('../tracing.js');
    exporter.reset();

    withSpan('session', { 'session.clientId': 'test' }, () => {
      const tracer = trace.getTracer('mitzo', '1.0.0');

      // Turn created but NOT set as active context
      const turnSpan = tracer.startSpan('turn', {}, context.active());
      turnSpan.end();

      // Without setSpan fix, context.active() still has session
      const toolSpan = tracer.startSpan('tool.Read', {}, context.active());
      toolSpan.end();
    });

    const spans = exporter.getFinishedSpans();
    const session = spans.find((s) => s.name === 'session')!;
    const tool = spans.find((s) => s.name === 'tool.Read')!;

    // Bug case: tool lands under session, not turn
    expect(parentId(tool)).toBe(session.spanContext().spanId);
  });
});
