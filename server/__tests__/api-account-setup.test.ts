import { expect, it, vi } from 'vitest';
import { discoverApiAccountModels } from '../api-account-setup.js';
import type { ConnectionSender } from '../credential-connections.js';

it('discovers gateway models at the exact selected endpoint without making an inference call', async () => {
  const send = vi.fn<ConnectionSender>(async () => ({
    status: 200,
    body: JSON.stringify({ data: [{ id: 'vendor/model', name: 'Hosted model' }], has_more: true }),
  }));
  const result = await discoverApiAccountModels(
    'https://gateway.example/v1/',
    'synthetic-key',
    AbortSignal.timeout(1000),
    send,
  );
  expect(result).toEqual({
    models: [{ id: 'vendor/model', label: 'Hosted model' }],
    partial: true,
  });
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0]).toMatchObject({
    url: new URL('https://gateway.example/v1/models'),
    method: 'GET',
    headers: { Authorization: 'Bearer synthetic-key' },
    allowPrivateNetwork: false,
  });
});

it.each([
  'http://gateway.example/v1',
  'https://user:secret@gateway.example/v1',
  'https://127.0.0.1/v1',
  'https://localhost/v1',
  'https://localhost./v1',
  'https://private.localhost./v1',
  'https://./v1',
  'https://gateway.example/' + '界'.repeat(500),
  'https://gateway.example/v1?token=secret',
])('rejects unsafe provider endpoints before sending a key: %s', async (endpoint) => {
  const send = vi.fn();
  await expect(
    discoverApiAccountModels(endpoint, 'synthetic-key', AbortSignal.timeout(1000), send),
  ).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

it.each([401, 403, 302, 500])(
  'retains a safe diagnostic for a failed catalog read (%s)',
  async (status) => {
    const send = vi.fn(async () => ({ status, body: 'PRIVATE_KEY private provider response' }));
    await expect(
      discoverApiAccountModels(
        'https://gateway.example/v1',
        'synthetic-key',
        AbortSignal.timeout(1000),
        send,
      ),
    ).rejects.toMatchObject({ code: expect.any(String) });
    try {
      await discoverApiAccountModels(
        'https://gateway.example/v1',
        'synthetic-key',
        AbortSignal.timeout(1000),
        send,
      );
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE_KEY');
    }
  },
);

it('does not mistake malformed catalogs or an aborted read for an empty model list', async () => {
  const send = vi.fn(async () => ({ status: 200, body: '{"wrong":[]}' }));
  await expect(
    discoverApiAccountModels('https://gateway.example/v1', 'key', AbortSignal.timeout(1000), send),
  ).rejects.toThrow();
  send.mockClear();
  await expect(
    discoverApiAccountModels('https://gateway.example/v1', 'key', AbortSignal.abort(), send),
  ).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
