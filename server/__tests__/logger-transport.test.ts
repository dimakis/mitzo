import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { resilientLogDestination } from '../logger-transport.js';
import pino from 'pino';
import { fileURLToPath } from 'node:url';

function setup() {
  const transport = Object.assign(new EventEmitter(), { write: vi.fn() });
  const fallback = vi.fn((_line: string, done: () => void) => done());
  return { transport, fallback, dest: resilientLogDestination(transport, fallback) };
}

describe('operational logging transport failure', () => {
  it.each(['error', 'partial', 'throw'])(
    'reports %s fallback loss after recovery without recursively retrying',
    (mode) => {
      const transport = Object.assign(new EventEmitter(), { write: vi.fn() });
      const fallback = vi.fn(
        (_line: string, done: (error?: Error | null, bytesWritten?: number) => void) => done(),
      );
      fallback.mockImplementationOnce((line, done) => {
        if (mode === 'throw') throw new Error('private stderr path');
        done(
          mode === 'error' ? new Error('private stderr path') : null,
          mode === 'partial' ? 2 : 0,
        );
      });
      const dest = resilientLogDestination(transport, fallback);
      expect(() => transport.emit('error', new Error('worker failed'))).not.toThrow();
      expect(fallback).toHaveBeenCalledOnce();
      dest.write('{"msg":"recovered"}\n');
      expect(fallback).toHaveBeenCalledTimes(2);
      const summary = JSON.parse(fallback.mock.calls[1][0].split('\n')[0]);
      expect(summary).toMatchObject({ module: 'logger', failedWrites: 1 });
      expect(summary.lostBytes).toBeGreaterThan(0);
      expect(fallback.mock.calls[1][0]).toContain('recovered');
      expect(fallback.mock.calls[1][0]).not.toContain('private stderr path');
    },
  );

  it('contains an actual Pino worker destination failure and continues logging', async () => {
    const transport = pino.transport({
      target: fileURLToPath(new URL('./fixtures/failing-log-transport.cjs', import.meta.url)),
    });
    const lines: string[] = [];
    const destination = resilientLogDestination(transport, (line, done) => {
      lines.push(line);
      done();
    });
    const logger = pino({}, destination);
    const failed = new Promise<Error>((resolve) => transport.once('error', resolve));
    logger.info('trigger isolated worker failure');
    expect((await failed).message).toContain('private fixture path');
    logger.info('still responsive');
    expect(lines.join('')).toContain('still responsive');
    expect(lines.join('')).toContain('Operational log transport failed');
    expect(lines.join('')).not.toContain('private fixture path');
  });

  it('does not let disk-full transport errors terminate request processing', () => {
    const { transport, fallback, dest } = setup();
    dest.write('{"msg":"before"}\n');
    expect(transport.write).toHaveBeenCalledOnce();
    expect(() =>
      transport.emit('error', Object.assign(new Error('private path'), { code: 'ENOSPC' })),
    ).not.toThrow();
    dest.write('{"msg":"after"}\n');
    expect(transport.write).toHaveBeenCalledOnce();
    expect(fallback.mock.calls.map(([line]) => line).join('')).toContain('after');
    expect(fallback.mock.calls[0][0]).toContain('ENOSPC');
    expect(fallback.mock.calls[0][0]).not.toContain('private path');
  });
  it('handles a synchronous write failure and preserves that log on fallback', () => {
    const { transport, fallback, dest } = setup();
    transport.write.mockImplementationOnce(() => {
      throw new Error('stream destroyed');
    });
    expect(() => dest.write('{"msg":"request finished"}\n')).not.toThrow();
    expect(fallback.mock.calls.map(([line]) => line).join('')).toContain('request finished');
  });
  it('bounds fallback writes when stderr is also stalled', () => {
    const transport = Object.assign(new EventEmitter(), { write: vi.fn() });
    let complete!: () => void;
    const fallback = vi.fn((_line: string, done: () => void) => {
      complete = done;
    });
    const dest = resilientLogDestination(transport, fallback);
    transport.emit('error', new Error('failed'));
    for (let n = 0; n < 10000; n++) dest.write('a'.repeat(1024));
    expect(fallback).toHaveBeenCalledOnce();
    complete();
    dest.write('{"msg":"writable again"}\n');
    expect(fallback).toHaveBeenCalledTimes(2);
  });
  it('never recursively fails when fallback itself throws', () => {
    const transport = Object.assign(new EventEmitter(), { write: vi.fn() });
    const dest = resilientLogDestination(transport, () => {
      throw new Error('stderr full');
    });
    expect(() => transport.emit('error', new Error('full'))).not.toThrow();
    expect(() => dest.write('{}\n')).not.toThrow();
  });
});
