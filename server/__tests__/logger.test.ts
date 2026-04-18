import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import pino from 'pino';
import { _buildLogger, createLogger } from '../logger.js';

let tmpDir: string;
let savedLogLevel: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'logger-test-'));
  savedLogLevel = process.env.LOG_LEVEL;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (savedLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = savedLogLevel;
  }
});

function syncDest(logFile: string) {
  return pino.destination({ dest: logFile, sync: true, mkdir: true });
}

function readLogLines(logFile: string): Record<string, unknown>[] {
  try {
    const raw = readFileSync(logFile, 'utf-8').trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function makeLogger(module: string, dest: pino.DestinationStream) {
  const root = _buildLogger(dest);
  const child = root.child({ module });
  return {
    debug: (message: string, ctx?: Record<string, unknown>) => child.debug(ctx ?? {}, message),
    info: (message: string, ctx?: Record<string, unknown>) => child.info(ctx ?? {}, message),
    warn: (message: string, ctx?: Record<string, unknown>) => child.warn(ctx ?? {}, message),
    error: (message: string, ctx?: Record<string, unknown>) => child.error(ctx ?? {}, message),
  };
}

describe('createLogger', () => {
  it('returns an object with debug, info, warn, error methods', () => {
    const log = createLogger('test-mod');

    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('includes the module name in log output', () => {
    const logFile = join(tmpDir, 'test.log');
    const log = makeLogger('my-module', syncDest(logFile));
    log.info('hello world');

    const lines = readLogLines(logFile);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toMatchObject({ module: 'my-module', msg: 'hello world' });
  });

  it('filters log entries below the configured level', () => {
    const logFile = join(tmpDir, 'test.log');
    const dest = syncDest(logFile);
    process.env.LOG_LEVEL = 'error';
    const root = _buildLogger(dest);
    const child = root.child({ module: 'filter-test' });

    const log = {
      debug: (msg: string) => child.debug(msg),
      info: (msg: string) => child.info(msg),
      warn: (msg: string) => child.warn(msg),
      error: (msg: string) => child.error(msg),
    };

    log.debug('should not appear');
    log.info('should not appear');
    log.warn('should not appear');
    log.error('should appear');

    const lines = readLogLines(logFile);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'should appear' });
  });

  it('merges context object into the log entry', () => {
    const logFile = join(tmpDir, 'test.log');
    process.env.LOG_LEVEL = 'debug';
    const log = makeLogger('ctx-test', syncDest(logFile));
    log.info('session started', { sessionId: 'abc-123', mode: 'agent' });

    const lines = readLogLines(logFile);
    expect(lines[0]).toMatchObject({
      msg: 'session started',
      sessionId: 'abc-123',
      mode: 'agent',
    });
  });

  it('injects trace_id and span_id when an OTel span is active', async () => {
    const { trace } = await import('@opentelemetry/api');
    const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');

    const provider = new NodeTracerProvider();
    provider.register();

    const logFile = join(tmpDir, 'test.log');
    process.env.LOG_LEVEL = 'debug';
    const log = makeLogger('otel-test', syncDest(logFile));

    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('test-span', (span) => {
      const spanCtx = span.spanContext();
      log.info('inside span');
      span.end();

      const lines = readLogLines(logFile);
      const entry = lines.find((l) => l.msg === 'inside span');
      expect(entry).toBeDefined();
      expect(entry!.trace_id).toBe(spanCtx.traceId);
      expect(entry!.span_id).toBe(spanCtx.spanId);
    });

    await provider.shutdown();
  });

  it('omits trace_id and span_id when no OTel span is active', () => {
    const logFile = join(tmpDir, 'test.log');
    process.env.LOG_LEVEL = 'debug';
    const log = makeLogger('no-otel', syncDest(logFile));
    log.info('no span');

    const lines = readLogLines(logFile);
    expect(lines[0]).toMatchObject({ msg: 'no span' });
    expect(lines[0]).not.toHaveProperty('trace_id');
    expect(lines[0]).not.toHaveProperty('span_id');
  });

  it('serializes Error objects with stack traces', () => {
    const logFile = join(tmpDir, 'test.log');
    process.env.LOG_LEVEL = 'debug';
    const log = makeLogger('err-test', syncDest(logFile));
    const testError = new Error('boom');
    log.error('something failed', { err: testError });

    const lines = readLogLines(logFile);
    expect(lines[0]).toMatchObject({ msg: 'something failed' });
    const err = lines[0].err as Record<string, unknown>;
    expect(err).toBeDefined();
    expect(err.message).toBe('boom');
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe('string');
  });

  it('defaults to info level when LOG_LEVEL is unset', () => {
    delete process.env.LOG_LEVEL;
    const logFile = join(tmpDir, 'test.log');
    const root = _buildLogger(syncDest(logFile));
    const child = root.child({ module: 'default-level' });

    child.debug({}, 'should be filtered');
    child.info({}, 'should appear');

    const lines = readLogLines(logFile);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'should appear' });
  });
});
