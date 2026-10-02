import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  responseBytes: 0,
}));
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));
vi.mock('node:https', () => ({
  request: (_url: URL, options: Record<string, unknown>, callback: (res: EventEmitter) => void) => {
    wire.options = options;
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(error: Error): void };
    req.end = () => {
      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
      });
      callback(res);
      res.emit('data', Buffer.alloc(wire.responseBytes, 'x'));
      res.emit('end');
    };
    req.destroy = (error) => {
      req.emit('error', error);
    };
    return req;
  },
}));
import { fetchPublicPage } from '../public-web-fetch.js';
describe('public website HTTPS transport', () => {
  it('pins one address family and does not pass cookies, credentials, proxies or pooled sockets', async () => {
    wire.responseBytes = 2;
    await fetchPublicPage('https://example.com/', new AbortController().signal);
    expect(wire.options).toMatchObject({
      method: 'GET',
      family: 4,
      agent: false,
      rejectUnauthorized: true,
    });
    const headers = wire.options!.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(['Accept', 'Accept-Encoding', 'User-Agent']);
    expect(headers['Accept-Encoding']).toBe('identity');
    const callback = vi.fn();
    (wire.options!.lookup as (host: string, options: unknown, done: typeof callback) => void)(
      'example.com',
      {},
      callback,
    );
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });
  it('destroys the wire request when the streaming body exceeds the bound', async () => {
    wire.responseBytes = 131073;
    await expect(
      fetchPublicPage('https://example.com/', new AbortController().signal),
    ).rejects.toThrow();
  });
});
