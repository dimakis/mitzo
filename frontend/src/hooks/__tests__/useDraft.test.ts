// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDraft } from '../useDraft';

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('useDraft', () => {
  it('initializes with empty string when no draft exists', () => {
    const { result } = renderHook(() => useDraft('sess-1'));
    expect(result.current[0]).toBe('');
  });

  it('uses initialText when provided', () => {
    const { result } = renderHook(() => useDraft('sess-1', 'hello'));
    expect(result.current[0]).toBe('hello');
  });

  it('restores draft from localStorage', () => {
    localStorage.setItem('mitzo-draft-sess-2', 'saved draft');
    const { result } = renderHook(() => useDraft('sess-2'));
    expect(result.current[0]).toBe('saved draft');
  });

  it('prefers initialText over saved draft', () => {
    localStorage.setItem('mitzo-draft-sess-3', 'old draft');
    const { result } = renderHook(() => useDraft('sess-3', 'new text'));
    expect(result.current[0]).toBe('new text');
  });

  it('persists text to localStorage after debounce', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDraft('sess-4'));

    act(() => result.current[1]('work in progress'));
    // Not yet saved
    expect(localStorage.getItem('mitzo-draft-sess-4')).toBeNull();

    // Advance past debounce
    act(() => vi.advanceTimersByTime(500));
    expect(localStorage.getItem('mitzo-draft-sess-4')).toBe('work in progress');

    vi.useRealTimers();
  });

  it('clears draft from state and localStorage', async () => {
    vi.useFakeTimers();
    localStorage.setItem('mitzo-draft-sess-5', 'draft');
    const { result } = renderHook(() => useDraft('sess-5'));

    expect(result.current[0]).toBe('draft');

    act(() => result.current[2]()); // clearDraft
    expect(result.current[0]).toBe('');
    expect(localStorage.getItem('mitzo-draft-sess-5')).toBeNull();

    vi.useRealTimers();
  });

  it('removes localStorage entry when text is emptied', async () => {
    vi.useFakeTimers();
    localStorage.setItem('mitzo-draft-sess-6', 'old');
    const { result } = renderHook(() => useDraft('sess-6'));

    act(() => result.current[1](''));
    act(() => vi.advanceTimersByTime(500));
    expect(localStorage.getItem('mitzo-draft-sess-6')).toBeNull();

    vi.useRealTimers();
  });

  it('uses "new" key when sessionId is undefined', () => {
    localStorage.setItem('mitzo-draft-new', 'unsent prompt');
    const { result } = renderHook(() => useDraft(undefined));
    expect(result.current[0]).toBe('unsent prompt');
  });

  it('migrates draft when sessionId changes from undefined to a real ID', () => {
    vi.useFakeTimers();
    localStorage.setItem('mitzo-draft-new', 'draft in progress');
    const { result, rerender } = renderHook(({ id }: { id: string | undefined }) => useDraft(id), {
      initialProps: { id: undefined as string | undefined },
    });

    expect(result.current[0]).toBe('draft in progress');

    // Simulate the session getting assigned a real ID
    rerender({ id: 'sess-real' });

    // Draft should have migrated to the new key
    expect(localStorage.getItem('mitzo-draft-sess-real')).toBe('draft in progress');
    // Old key should be removed
    expect(localStorage.getItem('mitzo-draft-new')).toBeNull();

    vi.useRealTimers();
  });
});
