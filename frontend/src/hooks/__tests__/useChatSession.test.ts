// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../../lib/model-preference', () => ({
  getPreferredModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
  setPreferredModel: vi.fn(),
}));

import { setPreferredModel } from '../../lib/model-preference';
import { useChatSession } from '../useChatSession';

beforeEach(() => {
  localStorage.clear();
  vi.mocked(setPreferredModel).mockClear();
});

describe('useChatSession', () => {
  it('returns stable poolKey for new sessions across re-renders', () => {
    const { result, rerender } = renderHook(() => useChatSession(undefined, 'agent'));
    const firstKey = result.current[2];
    expect(firstKey).toMatch(/^new:/);
    rerender();
    expect(result.current[2]).toBe(firstKey);
  });

  it('uses session:id poolKey when sessionId provided', () => {
    const { result } = renderHook(() => useChatSession('abc', 'agent'));
    expect(result.current[2]).toBe('session:abc');
  });

  it('persists currentSessionId to localStorage', () => {
    const { result } = renderHook(() => useChatSession(undefined, 'agent'));
    act(() => {
      result.current[1].setCurrentSessionId('test-session');
    });
    expect(localStorage.getItem('mitzo-last-session')).toBe('test-session');
  });

  it('setModel calls setPreferredModel', () => {
    const { result } = renderHook(() => useChatSession(undefined, 'agent'));
    act(() => {
      result.current[1].setModel('claude-opus-4-6');
    });
    expect(setPreferredModel).toHaveBeenCalledWith('claude-opus-4-6');
    expect(result.current[0].model).toBe('claude-opus-4-6');
  });
});
