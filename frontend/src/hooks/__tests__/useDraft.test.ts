// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useDraft } from '../useDraft';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('useDraft', () => {
  it.each(['', 'Existing B draft'])(
    'preserves ordinary A across A → B → A when B initially contains %j',
    (draftB) => {
      vi.useFakeTimers();
      if (draftB) localStorage.setItem('mitzo-draft-b', draftB);
      const { result, rerender } = renderHook(({ id }) => useDraft(id), {
        initialProps: { id: 'a' },
      });
      const draftA = 'Unsent A\n  exact spacing  ';
      act(() => result.current[1](draftA));
      rerender({ id: 'b' });
      expect(result.current[0]).toBe(draftB);
      expect(localStorage.getItem('mitzo-draft-a')).toBe(draftA);
      act(() => result.current[1]('Edited B'));
      rerender({ id: 'a' });
      expect(result.current[0]).toBe(draftA);
      expect(localStorage.getItem('mitzo-draft-b')).toBe('Edited B');
      act(() => vi.advanceTimersByTime(500));
      expect(localStorage.getItem('mitzo-draft-a')).toBe(draftA);
      expect(localStorage.getItem('mitzo-draft-b')).toBe('Edited B');
    },
  );

  it('loads the unassigned draft without migrating an assigned conversation into it', () => {
    localStorage.setItem('mitzo-draft-a', 'A draft');
    localStorage.setItem('mitzo-draft-new', 'Separate new draft');
    const { result, rerender } = renderHook(({ id }: { id?: string }) => useDraft(id), {
      initialProps: { id: 'a' as string | undefined },
    });
    rerender({ id: undefined });
    expect(result.current[0]).toBe('Separate new draft');
    expect(localStorage.getItem('mitzo-draft-a')).toBe('A draft');
    expect(localStorage.getItem('mitzo-draft-new')).toBe('Separate new draft');
  });

  it.each(['switch', 'unmount'] as const)(
    'flushes the dirty ordinary owner on immediate %s before a preparation opens',
    (transition) => {
      vi.useFakeTimers();
      localStorage.setItem('mitzo-draft-new', 'Older ordinary draft');
      const initialProps: { scope?: string } = {};
      const ordinary = renderHook(
        ({ scope }: { scope?: string }) => useDraft(undefined, undefined, scope),
        { initialProps },
      );
      const edited = 'Fresh ordinary draft\n  exact spacing  ';
      act(() => ordinary.result.current[1](edited));
      if (transition === 'switch') ordinary.rerender({ scope: 'mitzo-repository-prompt:prep-a' });
      else ordinary.unmount();
      expect(localStorage.getItem('mitzo-draft-new')).toBe(edited);
      expect(localStorage.getItem('mitzo-repository-prompt:prep-a')).toBeNull();
      act(() => vi.advanceTimersByTime(500));
      expect(localStorage.getItem('mitzo-draft-new')).toBe(edited);
    },
  );
  it.each(['switch', 'unmount'] as const)(
    'removes a user-emptied ordinary owner on immediate %s',
    (transition) => {
      vi.useFakeTimers();
      localStorage.setItem('mitzo-draft-new', 'Older ordinary draft');
      const initialProps: { scope?: string } = {};
      const ordinary = renderHook(
        ({ scope }: { scope?: string }) => useDraft(undefined, undefined, scope),
        { initialProps },
      );
      act(() => ordinary.result.current[1](''));
      if (transition === 'switch') ordinary.rerender({ scope: 'mitzo-repository-prompt:prep-a' });
      else ordinary.unmount();
      expect(localStorage.getItem('mitzo-draft-new')).toBeNull();
      act(() => vi.advanceTimersByTime(500));
      expect(localStorage.getItem('mitzo-draft-new')).toBeNull();
    },
  );

  it('flushes a preparation edit before confirmation and cancels a pending dirty flush on confirmed clear', () => {
    vi.useFakeTimers();
    const draft = renderHook(() =>
      useDraft(undefined, 'Server task', 'mitzo-repository-prompt:prep-a'),
    );
    act(() => draft.result.current[1]('Edited immediately before Send'));
    act(() => draft.result.current[3]());
    expect(localStorage.getItem('mitzo-repository-prompt:prep-a')).toBe(
      'Edited immediately before Send',
    );
    act(() => draft.result.current[1]('Edited while Send is pending'));
    act(() => draft.result.current[2]());
    draft.unmount();
    act(() => vi.advanceTimersByTime(500));
    expect(localStorage.getItem('mitzo-repository-prompt:prep-a')).toBeNull();
  });
  it('restores an explicitly empty preparation draft after a debounced user edit and reload', () => {
    vi.useFakeTimers();
    const first = renderHook(() =>
      useDraft(undefined, 'Server task', 'mitzo-repository-prompt:prep-a'),
    );
    act(() => first.result.current[1](''));
    act(() => vi.advanceTimersByTime(500));
    expect(localStorage.getItem('mitzo-repository-prompt:prep-a')).toBe('');
    first.unmount();
    const reopened = renderHook(() =>
      useDraft(undefined, 'Server task', 'mitzo-repository-prompt:prep-a'),
    );
    expect(reopened.result.current[0]).toBe('');
    act(() => reopened.result.current[2]());
    expect(localStorage.getItem('mitzo-repository-prompt:prep-a')).toBeNull();
  });
  it.each(['unmount', 'switch'] as const)(
    'flushes an empty preparation edit on immediate %s without resurrecting the server task',
    (transition) => {
      vi.useFakeTimers();
      localStorage.setItem('mitzo-draft-new', 'ordinary draft');
      const first = renderHook(({ scope }) => useDraft(undefined, 'Server task', scope), {
        initialProps: { scope: 'mitzo-repository-prompt:prep-a' },
      });
      act(() => first.result.current[1](''));
      if (transition === 'unmount') first.unmount();
      else first.rerender({ scope: 'mitzo-repository-prompt:prep-b' });
      expect(localStorage.getItem('mitzo-repository-prompt:prep-a')).toBe('');
      const reopened = renderHook(() =>
        useDraft(undefined, 'Server task', 'mitzo-repository-prompt:prep-a'),
      );
      expect(reopened.result.current[0]).toBe('');
      act(() => vi.advanceTimersByTime(500));
      expect(localStorage.getItem('mitzo-repository-prompt:prep-a')).toBe('');
      expect(localStorage.getItem('mitzo-draft-new')).toBe('ordinary draft');
    },
  );
  it('edits and clears only a preparation-owned key while preserving the ordinary draft bytes', () => {
    vi.useFakeTimers();
    localStorage.setItem('mitzo-draft-new', 'ordinary draft\n  with spacing');
    const { result } = renderHook(() =>
      useDraft(undefined, 'Prepared task', 'mitzo-repository-prompt:prep-a'),
    );
    act(() => result.current[1]('Edited preparation task'));
    act(() => vi.advanceTimersByTime(500));
    expect(localStorage.getItem('mitzo-draft-new')).toBe('ordinary draft\n  with spacing');
    expect(localStorage.getItem('mitzo-repository-prompt:prep-a')).toBe('Edited preparation task');
    act(() => result.current[2]());
    expect(localStorage.getItem('mitzo-repository-prompt:prep-a')).toBeNull();
    expect(localStorage.getItem('mitzo-draft-new')).toBe('ordinary draft\n  with spacing');
  });
  it('recovers preparation edits on reload instead of replacing them with the server draft', () => {
    localStorage.setItem('mitzo-repository-prompt:prep-a', 'Reviewed edit');
    const { result } = renderHook(() =>
      useDraft(undefined, 'Original server task', 'mitzo-repository-prompt:prep-a'),
    );
    expect(result.current[0]).toBe('Reviewed edit');
  });
  it('keeps preparation keys isolated across immediate route changes and late debounces', () => {
    vi.useFakeTimers();
    localStorage.setItem('mitzo-draft-new', 'ordinary draft');
    const { result, rerender } = renderHook(
      ({ scope, initial }) => useDraft(undefined, initial, scope),
      { initialProps: { scope: 'mitzo-repository-prompt:prep-a', initial: 'Task A' } },
    );
    act(() => result.current[1]('Edit A'));
    rerender({ scope: 'mitzo-repository-prompt:prep-b', initial: 'Task B' });
    expect(result.current[0]).toBe('Task B');
    act(() => result.current[1]('Edit B'));
    act(() => vi.advanceTimersByTime(500));
    expect(localStorage.getItem('mitzo-repository-prompt:prep-a')).toBe('Edit A');
    expect(localStorage.getItem('mitzo-repository-prompt:prep-b')).toBe('Edit B');
    expect(localStorage.getItem('mitzo-draft-new')).toBe('ordinary draft');
  });
  it('does not migrate an ordinary draft into the assigned repository conversation', () => {
    localStorage.setItem('mitzo-draft-new', 'ordinary unsent task');
    const initialProps: { sessionId?: string; scope?: string } = {
      sessionId: undefined,
      scope: 'mitzo-repository-prompt:prep-a',
    };
    const { result, rerender } = renderHook(
      ({ sessionId, scope }: { sessionId?: string; scope?: string }) =>
        useDraft(sessionId, 'Prepared task', scope),
      { initialProps },
    );
    act(() => result.current[2]());
    rerender({ sessionId: 'repository-chat', scope: undefined });
    expect(localStorage.getItem('mitzo-draft-new')).toBe('ordinary unsent task');
    expect(localStorage.getItem('mitzo-draft-repository-chat')).toBeNull();
    expect(result.current[0]).not.toBe('ordinary unsent task');
  });
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
    act(() => result.current[1]('Edited just before assignment'));

    // Simulate the session getting assigned a real ID
    rerender({ id: 'sess-real' });

    // Draft should have migrated to the new key
    expect(localStorage.getItem('mitzo-draft-sess-real')).toBe('Edited just before assignment');
    expect(result.current[0]).toBe('Edited just before assignment');
    // Old key should be removed
    expect(localStorage.getItem('mitzo-draft-new')).toBeNull();

    vi.useRealTimers();
  });
});
