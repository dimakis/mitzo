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
