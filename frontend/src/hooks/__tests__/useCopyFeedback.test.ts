// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCopyFeedback } from '../useCopyFeedback';

vi.mock('../../lib/clipboard', () => ({
  copyToClipboard: vi.fn(),
}));

import { copyToClipboard } from '../../lib/clipboard';
const mockCopy = copyToClipboard as ReturnType<typeof vi.fn>;

describe('useCopyFeedback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockCopy.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with copied = false', () => {
    const { result } = renderHook(() => useCopyFeedback());
    expect(result.current.copied).toBe(false);
  });

  it('sets copied = true after successful copy', async () => {
    const { result } = renderHook(() => useCopyFeedback());
    await act(async () => {
      await result.current.copy('hello');
    });
    expect(result.current.copied).toBe(true);
    expect(mockCopy).toHaveBeenCalledWith('hello');
  });

  it('resets copied after duration', async () => {
    const { result } = renderHook(() => useCopyFeedback(1000));
    await act(async () => {
      await result.current.copy('hello');
    });
    expect(result.current.copied).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.copied).toBe(false);
  });

  it('does not set copied when copy fails', async () => {
    mockCopy.mockResolvedValue(false);
    const { result } = renderHook(() => useCopyFeedback());
    await act(async () => {
      await result.current.copy('hello');
    });
    expect(result.current.copied).toBe(false);
  });
});
