import { describe, it, expect } from 'vitest';
import { NullTransport } from '../null-transport.js';

describe('NullTransport', () => {
  it('implements SessionTransport interface', () => {
    const transport = new NullTransport();
    expect(typeof transport.send).toBe('function');
    expect(typeof transport.isOpen).toBe('function');
  });

  it('isOpen() always returns true', () => {
    const transport = new NullTransport();
    expect(transport.isOpen()).toBe(true);
  });

  it('send() accepts data without throwing', () => {
    const transport = new NullTransport();
    expect(() => transport.send({ type: 'test', data: 'hello' })).not.toThrow();
    expect(() => transport.send({})).not.toThrow();
  });
});
