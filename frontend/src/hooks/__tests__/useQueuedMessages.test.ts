// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useQueuedMessages, type QueuedMessage } from '../useQueuedMessages';

function msg(text: string): QueuedMessage {
  return { text, images: [], contextBlocks: [] };
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('useQueuedMessages', () => {
  it('initializes with empty queue when nothing is stored', () => {
    const { result } = renderHook(() => useQueuedMessages('sess-1'));
    expect(result.current.queue).toEqual([]);
  });

  it('loads queue from localStorage on init', () => {
    localStorage.setItem(
      'mitzo-queue-sess-2',
      JSON.stringify([{ text: 'hello', contextBlocks: [] }]),
    );
    const { result } = renderHook(() => useQueuedMessages('sess-2'));
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0].text).toBe('hello');
    // images should be reconstructed as empty array
    expect(result.current.queue[0].images).toEqual([]);
  });

  it('enqueues a message and persists it', () => {
    const { result } = renderHook(() => useQueuedMessages('sess-3'));

    act(() => {
      const added = result.current.enqueue(msg('first'));
      expect(added).toBe(true);
    });

    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0].text).toBe('first');

    const stored = JSON.parse(localStorage.getItem('mitzo-queue-sess-3')!);
    expect(stored).toEqual([{ text: 'first', contextBlocks: [] }]);
  });

  it('respects maxQueued limit', () => {
    const { result } = renderHook(() => useQueuedMessages('sess-4', 2));

    act(() => result.current.enqueue(msg('one')));
    act(() => result.current.enqueue(msg('two')));

    let added: boolean = false;
    act(() => {
      added = result.current.enqueue(msg('three'));
    });

    expect(added).toBe(false);
    expect(result.current.queue).toHaveLength(2);
  });

  it('dequeues the first message', () => {
    const { result } = renderHook(() => useQueuedMessages('sess-5'));

    act(() => result.current.enqueue(msg('first')));
    act(() => result.current.enqueue(msg('second')));

    let item: QueuedMessage | undefined;
    act(() => {
      item = result.current.dequeue();
    });

    expect(item?.text).toBe('first');
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0].text).toBe('second');
  });

  it('dequeue returns undefined for empty queue', () => {
    const { result } = renderHook(() => useQueuedMessages('sess-6'));

    let item: QueuedMessage | undefined;
    act(() => {
      item = result.current.dequeue();
    });

    expect(item).toBeUndefined();
  });

  it('removes a message by index', () => {
    const { result } = renderHook(() => useQueuedMessages('sess-7'));

    act(() => result.current.enqueue(msg('a')));
    act(() => result.current.enqueue(msg('b')));
    act(() => result.current.enqueue(msg('c')));
    act(() => result.current.remove(1));

    expect(result.current.queue.map((q) => q.text)).toEqual(['a', 'c']);
  });

  it('edits (removes and returns) a message by index', () => {
    const { result } = renderHook(() => useQueuedMessages('sess-8'));

    act(() => result.current.enqueue(msg('x')));
    act(() => result.current.enqueue(msg('y')));

    let item: QueuedMessage | undefined;
    act(() => {
      item = result.current.edit(0);
    });

    expect(item?.text).toBe('x');
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0].text).toBe('y');
  });

  it('edit returns undefined for invalid index', () => {
    const { result } = renderHook(() => useQueuedMessages('sess-9'));

    let item: QueuedMessage | undefined;
    act(() => {
      item = result.current.edit(5);
    });

    expect(item).toBeUndefined();
  });

  it('uses "new" key when sessionId is undefined', () => {
    localStorage.setItem(
      'mitzo-queue-new',
      JSON.stringify([{ text: 'pending', contextBlocks: [] }]),
    );
    const { result } = renderHook(() => useQueuedMessages(undefined));
    expect(result.current.queue[0].text).toBe('pending');
  });

  it('migrates queue when sessionId changes from undefined to real ID', () => {
    localStorage.setItem(
      'mitzo-queue-new',
      JSON.stringify([{ text: 'queued', contextBlocks: ['ctx'] }]),
    );
    const { rerender } = renderHook(({ id }: { id: string | undefined }) => useQueuedMessages(id), {
      initialProps: { id: undefined as string | undefined },
    });

    rerender({ id: 'sess-real' });

    expect(localStorage.getItem('mitzo-queue-sess-real')).toContain('queued');
    expect(localStorage.getItem('mitzo-queue-new')).toBeNull();
  });

  it('loads existing queue for new sessionId during migration', () => {
    localStorage.setItem('mitzo-queue-new', JSON.stringify([{ text: 'old', contextBlocks: [] }]));
    localStorage.setItem(
      'mitzo-queue-sess-existing',
      JSON.stringify([{ text: 'existing', contextBlocks: [] }]),
    );

    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useQueuedMessages(id),
      { initialProps: { id: undefined as string | undefined } },
    );

    rerender({ id: 'sess-existing' });

    // Should load the existing queue, not migrate the old one
    expect(result.current.queue[0].text).toBe('existing');
    expect(localStorage.getItem('mitzo-queue-new')).toBeNull();
  });

  it('removes localStorage entry when queue becomes empty', () => {
    const { result } = renderHook(() => useQueuedMessages('sess-10'));

    act(() => result.current.enqueue(msg('only')));
    expect(localStorage.getItem('mitzo-queue-sess-10')).not.toBeNull();

    act(() => result.current.remove(0));
    expect(localStorage.getItem('mitzo-queue-sess-10')).toBeNull();
  });

  it('does not persist image data to localStorage', () => {
    const { result } = renderHook(() => useQueuedMessages('sess-11'));

    act(() => {
      result.current.enqueue({
        text: 'with image',
        images: [
          { data: 'base64data...', mediaType: 'image/png', preview: 'data:image/png;base64,...' },
        ],
        contextBlocks: [],
      });
    });

    const stored = localStorage.getItem('mitzo-queue-sess-11')!;
    expect(stored).not.toContain('base64data');
    expect(stored).not.toContain('preview');

    // But the in-memory queue still has the images
    expect(result.current.queue[0].images).toHaveLength(1);
  });
});
