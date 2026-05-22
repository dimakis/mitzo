/**
 * Global test setup for Vitest
 *
 * Mocks browser APIs that don't exist in Node/jsdom test environment
 */

import { vi } from 'vitest';

// Mock EventSource (used by SSE event bus)
globalThis.EventSource = vi.fn(() => ({
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  close: vi.fn(),
  readyState: 0,
  url: '',
  withCredentials: false,
  CONNECTING: 0,
  OPEN: 1,
  CLOSED: 2,
  onopen: null,
  onmessage: null,
  onerror: null,
})) as unknown as typeof EventSource;
