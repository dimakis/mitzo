import { afterEach, expect, it, vi } from 'vitest';
import {
  executeTelosWorkControlTool,
  telosWorkControlDefinitions,
} from '../telos-work-control-tools.js';
import { TelosWorkControlToolInputSchema } from '@mitzo/protocol';
afterEach(() => vi.unstubAllGlobals());
it('CT12: transports an exact current-session control command and refuses authority/application fields', async () => {
  expect(telosWorkControlDefinitions.map((d) => d.name)).toEqual(['TelosWorkControl']);
  const input = { command: { operation: 'inbox', itemId: 'feature' } };
  const fetch = vi.fn().mockResolvedValue(new Response('[]'));
  vi.stubGlobal('fetch', fetch);
  expect(
    (await executeTelosWorkControlTool('http://host', 'client', 'lead', 'token', input)).isError,
  ).toBe(false);
  expect(fetch).toHaveBeenCalledWith(
    'http://host/api/internal/telos/work/control',
    expect.objectContaining({
      body: JSON.stringify({ clientId: 'client', sessionId: 'lead', input: input.command }),
    }),
  );
  fetch.mockClear();
  for (const invalid of [
    { ...input, actor: 'operator' },
    { command: { operation: 'applied', controlId: 'hold' } },
    { command: { operation: 'release', controlId: 'hold', requestId: 'r', evidenceRef: 'forged' } },
  ]) {
    expect(TelosWorkControlToolInputSchema.safeParse(invalid).success).toBe(false);
    expect(
      (await executeTelosWorkControlTool('http://host', 'client', 'lead', 'token', invalid))
        .isError,
    ).toBe(true);
  }
  expect(fetch).not.toHaveBeenCalled();
});
it('CT12: uncertainty stays an error and returned receipts must match the selected operation', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('Disconnected'));
  vi.stubGlobal('fetch', fetch);
  const input = { command: { operation: 'read', controlId: 'selected' } };
  expect(
    (await executeTelosWorkControlTool('http://host', 'client', 'lead', 'token', input)).isError,
  ).toBe(true);
  fetch.mockResolvedValue(new Response('[]'));
  expect(
    (await executeTelosWorkControlTool('http://host', 'client', 'lead', 'token', input)).isError,
  ).toBe(true);
});
