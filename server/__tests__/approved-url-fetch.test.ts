import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import {
  canonicalApprovalUrl,
  fetchApprovedUrl,
  resolveApprovedUrl,
} from '../approved-url-fetch.js';
it('reads an explicitly approved local HTTP origin and custom port without credentials', async () => {
  const headers: unknown[] = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server unavailable');
    const url = `http://127.0.0.1:${address.port}/state`;
    const target = await resolveApprovedUrl(url);
    expect(await fetchApprovedUrl(url, target, new AbortController().signal)).toContain(
      '{"ok":true}',
    );
    expect(headers[0]).not.toHaveProperty('authorization');
    expect(headers[0]).not.toHaveProperty('cookie');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
it('rejects DNS rebinding and cross-origin redirects before contacting the new destination', async () => {
  const target = {
    url: 'https://example.com/',
    origin: 'https://example.com',
    addresses: [{ address: '203.0.113.1', family: 4 }],
  };
  const read = vi
    .fn()
    .mockResolvedValue({
      status: 302,
      location: 'http://127.0.0.1/',
      type: 'text/plain',
      body: '',
    });
  await expect(
    fetchApprovedUrl(target.url, target, new AbortController().signal, {
      resolve: async () => target,
      read,
    }),
  ).rejects.toThrow('separate URL approval');
  expect(read).toHaveBeenCalledOnce();
  read.mockClear();
  await expect(
    fetchApprovedUrl(target.url, target, new AbortController().signal, {
      resolve: async () => ({ ...target, addresses: [{ address: '127.0.0.1', family: 4 }] }),
      read,
    }),
  ).rejects.toThrow('addresses changed');
  expect(read).not.toHaveBeenCalled();
});
it('rejects URL credentials and non-HTTP schemes', () => {
  for (const value of [
    'file:///etc/passwd',
    'https://user:secret@example.com/',
    'ftp://example.com/',
  ])
    expect(() => canonicalApprovalUrl(value)).toThrow();
});
