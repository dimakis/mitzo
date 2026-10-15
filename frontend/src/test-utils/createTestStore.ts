import { vi } from 'vitest';
import { createMitzoStore, type MitzoStoreOptions } from '@mitzo/client';

/** Real store state with inert network adapters for component tests. */
export function createTestStore(options: Partial<MitzoStoreOptions> = {}) {
  return createMitzoStore({
    transport: {
      fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tasks: [] }) }),
      connectWs: vi.fn(),
    },
    wsConfig: {
      buildUrl: () => 'ws://localhost/ws',
      createWebSocket: () => ({
        readyState: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: vi.fn(),
        close: vi.fn(),
      }),
    },
    ...options,
  });
}
