import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => {
  const callback = vi.fn(
    async () => new Response(JSON.stringify({ error: 'owned endpoint reached' }), { status: 400 }),
  );
  vi.stubGlobal('fetch', callback);
  return callback;
});
import { allowNativeCompleteCallbacks } from './native-complete-support.js';
import { executeTelosWorkTool } from '../../../../server/telos-work-tools.js';
import { localHttpBaseUrl } from '../../../../server/local-server-url.js';
const port = 52345;
const origin = `http://127.0.0.1:${port}`;
beforeEach(() => {
  wire.mockClear();
  allowNativeCompleteCallbacks(origin);
});
afterEach(() => vi.unstubAllGlobals());
it('admits the real native callback resolver to the same owned listener', async () => {
  const result = await executeTelosWorkTool(
    localHttpBaseUrl(port, false),
    'client',
    'lead',
    'synthetic-token',
    'TelosStartSlice',
    {
      requestId: '7bdf5caf-86c5-4c10-8b34-01cba5f6682c',
      childItemId: 'offline-child',
      mode: 'start',
      predecessorAttemptId: null,
      sourceSnapshotIds: ['a'.repeat(64)],
      artifactRefs: [],
    },
  );
  expect(wire).toHaveBeenCalledOnce();
  expect(result.content).toBe('owned endpoint reached');
  expect(wire).toHaveBeenCalledWith(
    `http://localhost:${port}/api/internal/telos/work/delegate`,
    expect.objectContaining({ method: 'POST', redirect: 'error' }),
  );
});
it.each(['/api/internal/telos/work/delegate', '/api/internal/telos/source/execute'])(
  'allows only the two loopback spellings of this listener for %s',
  async (path) => {
    await fetch(origin + path, { method: 'POST' });
    await fetch(`http://localhost:${port}` + path, { method: 'POST' });
    expect(wire).toHaveBeenCalledTimes(2);
  },
);
it.each([
  [`http://127.0.0.1:${port + 1}/api/internal/telos/work/delegate`, 'POST'],
  [`http://localhost:${port + 1}/api/internal/telos/work/delegate`, 'POST'],
  [`http://localhost.attacker:${port}/api/internal/telos/work/delegate`, 'POST'],
  [`http://[::1]:${port}/api/internal/telos/work/delegate`, 'POST'],
  [`https://localhost:${port}/api/internal/telos/work/delegate`, 'POST'],
  [`http://user:pass@localhost:${port}/api/internal/telos/work/delegate`, 'POST'],
  [`http://localhost:${port}/api/internal/telos/work/delegate#other`, 'POST'],
  [`http://localhost:${port}/api/other`, 'POST'],
  [origin + '/api/internal/telos/work/delegate', 'GET'],
])('refuses a callback outside the exact listener/method/path: %s %s', (url, method) => {
  expect(() => fetch(url, { method })).toThrow(
    'Only reviewed private native callbacks are permitted',
  );
  expect(wire).not.toHaveBeenCalled();
});
