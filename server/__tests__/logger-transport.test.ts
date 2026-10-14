import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { resilientLogDestination } from '../logger-transport.js';

function setup() {
  const transport = Object.assign(new EventEmitter(), { write: vi.fn() });
  const fallback = vi.fn((_line: string, done: () => void) => done());
  return { transport, fallback, dest: resilientLogDestination(transport, fallback) };
}

describe('operational logging transport failure', () => {
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
