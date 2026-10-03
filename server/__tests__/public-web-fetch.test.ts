import { describe, expect, it, vi } from 'vitest';
import { fetchPublicPage } from '../public-web-fetch.js';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const page = { status: 200, headers: { 'content-type': 'text/html' }, body: '<h1>Revenue</h1>' };
describe('approved credential-free public website reads', () => {
  it.each([
    'http://example.com/',
    'https://user:pass@example.com/',
    'https://example.com:8443/',
    'https://127.0.0.1/',
    'https://[::1]/',
  ])('rejects unsafe URLs before connecting: %s', async (url) => {
    const send = vi.fn();
    await expect(
      fetchPublicPage(url, new AbortController().signal, { resolve: publicDns, send }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects mixed public/private DNS answers before connecting', async () => {
    const send = vi.fn();
    await expect(
      fetchPublicPage('https://example.com/', new AbortController().signal, {
        resolve: async () => [...(await publicDns()), { address: '169.254.169.254', family: 4 }],
        send,
      }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it('pins the approved public DNS answer and returns bounded source material', async () => {
    const send = vi.fn().mockResolvedValue(page);
    const output = await fetchPublicPage('https://example.com/', new AbortController().signal, {
      resolve: publicDns,
      send,
    });
    expect(send.mock.calls[0][1]).toEqual({ address: '93.184.216.34', family: 4 });
    expect(output).toContain('https://example.com/');
    expect(output).toContain('<h1>Revenue</h1>');
  });
  it('requires a new approval for a redirect to another origin', async () => {
    const send = vi.fn().mockResolvedValue({
      status: 302,
      headers: { location: 'https://other.example/' },
      body: '',
    });
    await expect(
      fetchPublicPage('https://example.com/', new AbortController().signal, {
        resolve: publicDns,
        send,
      }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rechecks and pins DNS on same-origin redirects', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(await publicDns())
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    const send = vi
      .fn()
      .mockResolvedValue({ status: 302, headers: { location: '/next' }, body: '' });
    await expect(
      fetchPublicPage('https://example.com/', new AbortController().signal, { resolve, send }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...page, body: 'x'.repeat(131073) },
    { ...page, headers: { 'content-type': 'application/octet-stream' } },
    { ...page, status: 403 },
  ])('does not relay oversized, binary or failed responses', async (response) => {
    await expect(
      fetchPublicPage('https://example.com/', new AbortController().signal, {
        resolve: publicDns,
        send: async () => response,
      }),
    ).rejects.toThrow();
  });
  it('does not connect after cancellation during DNS resolution', async () => {
    const abort = new AbortController();
    const send = vi.fn();
    await expect(
      fetchPublicPage('https://example.com/', abort.signal, {
        resolve: async () => {
          abort.abort();
          return publicDns();
        },
        send,
      }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
