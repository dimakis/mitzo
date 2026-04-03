// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockSubscribe = vi.fn().mockReturnValue(vi.fn());
const mockIsOpen = vi.fn().mockReturnValue(false);
const mockDrainBuffer = vi.fn().mockReturnValue([]);

vi.mock('../../lib/ws-pool', () => ({
  wsSubscribe: (...args: unknown[]) => mockSubscribe(...args),
  wsIsOpen: (...args: unknown[]) => mockIsOpen(...args),
  wsDrainBuffer: (...args: unknown[]) => mockDrainBuffer(...args),
}));

import { useChatConnection } from '../useChatConnection';

beforeEach(() => {
  mockSubscribe.mockClear().mockReturnValue(vi.fn());
  mockIsOpen.mockClear().mockReturnValue(false);
  mockDrainBuffer.mockClear().mockReturnValue([]);
});

describe('useChatConnection', () => {
  it('reports connected true on _open message', () => {
    let capturedHandler: ((msg: Record<string, unknown>) => void) | null = null;
    mockSubscribe.mockImplementation(
      (_key: string, handler: (msg: Record<string, unknown>) => void) => {
        capturedHandler = handler;
        return vi.fn();
      },
    );

    const onMessage = vi.fn();
    const { result } = renderHook(() => useChatConnection('key1', onMessage));

    expect(result.current.connected).toBe(false);
    capturedHandler!({ type: '_open' });
    expect(onMessage).toHaveBeenCalledWith({ type: '_open' });
  });

  it('reports connected false on _close message', () => {
    let capturedHandler: ((msg: Record<string, unknown>) => void) | null = null;
    mockSubscribe.mockImplementation(
      (_key: string, handler: (msg: Record<string, unknown>) => void) => {
        capturedHandler = handler;
        return vi.fn();
      },
    );
    mockIsOpen.mockReturnValue(true);

    const onMessage = vi.fn();
    renderHook(() => useChatConnection('key1', onMessage));
    capturedHandler!({ type: '_close' });
    expect(onMessage).toHaveBeenCalledWith({ type: '_close' });
  });

  it('drains buffer on mount', () => {
    mockDrainBuffer.mockReturnValue([{ type: '_open' }, { type: 'session_id', sessionId: 's1' }]);
    const onMessage = vi.fn();
    renderHook(() => useChatConnection('key1', onMessage));
    expect(mockDrainBuffer).toHaveBeenCalledWith('key1');
    expect(onMessage).toHaveBeenCalledTimes(2);
  });
});
