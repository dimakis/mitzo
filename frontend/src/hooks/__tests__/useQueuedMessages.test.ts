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
  it('saves an enqueue batched with navigation under its original conversation', () => {
    localStorage.setItem('mitzo-queue-b', JSON.stringify([msg('Existing B')]));
    const { result, rerender } = renderHook(({ id }) => useQueuedMessages(id), {
      initialProps: { id: 'a' },
    });
    act(() => {
      result.current.enqueue(msg('Immediate A'));
      rerender({ id: 'b' });
    });
    expect(result.current.queue).toEqual([msg('Existing B')]);
    expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([
      { text: 'Immediate A', contextBlocks: [] },
    ]);
    rerender({ id: 'a' });
    expect(result.current.queue).toEqual([msg('Immediate A')]);
  });

  it.each(['empty', 'existing'] as const)(
    'retains ordinary A and its retry fence across A → %s B → A',
    (destination) => {
      if (destination === 'existing')
        localStorage.setItem('mitzo-queue-b', JSON.stringify([msg('Existing B')]));
      const { result, rerender } = renderHook(({ id }) => useQueuedMessages(id), {
        initialProps: { id: 'a' },
      });
      const refused = { ...msg('Refused A'), contextBlocks: ['Exact A'], requiresRetry: true };
      act(() => result.current.enqueue(refused));
      rerender({ id: 'b' });
      expect(result.current.queue).toEqual(destination === 'existing' ? [msg('Existing B')] : []);
      expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([
        { text: 'Refused A', contextBlocks: ['Exact A'], requiresRetry: true },
      ]);
      act(() => result.current.enqueue(msg('Later B')));
      rerender({ id: 'a' });
      expect(result.current.queue).toEqual([refused]);
      let next: QueuedMessage | undefined;
      act(() => {
        next = result.current.dequeue();
      });
      expect(next).toBeUndefined();
      expect(
        JSON.parse(localStorage.getItem('mitzo-queue-b')!).map((item: QueuedMessage) => item.text),
      ).toEqual(destination === 'existing' ? ['Existing B', 'Later B'] : ['Later B']);
    },
  );

  it('loads the separate unassigned queue without moving or deleting an assigned queue', () => {
    localStorage.setItem('mitzo-queue-a', JSON.stringify([msg('A')]));
    localStorage.setItem('mitzo-queue-new', JSON.stringify([msg('New')]));
    const { result, rerender } = renderHook(({ id }: { id?: string }) => useQueuedMessages(id), {
      initialProps: { id: 'a' as string | undefined },
    });
    rerender({ id: undefined });
    expect(result.current.queue).toEqual([msg('New')]);
    expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([
      { text: 'A', contextBlocks: [] },
    ]);
  });

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
      JSON.stringify([{ text: 'queued', contextBlocks: ['ctx'], requiresRetry: true }]),
    );
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useQueuedMessages(id),
      {
        initialProps: { id: undefined as string | undefined },
      },
    );

    rerender({ id: 'sess-real' });

    expect(localStorage.getItem('mitzo-queue-sess-real')).toContain('queued');
    expect(localStorage.getItem('mitzo-queue-new')).toBeNull();
    expect(result.current.queue).toEqual([
      { text: 'queued', contextBlocks: ['ctx'], requiresRetry: true, images: [] },
    ]);
    let next: QueuedMessage | undefined;
    act(() => {
      next = result.current.dequeue();
    });
    expect(next).toBeUndefined();
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

it('retains definitive refusal ownership across remount without persisting image data', () => {
  const payload = {
    text: 'Exact refused input',
    contextBlocks: ['exact context'],
    images: [
      {
        data: 'private-image-data',
        mediaType: 'image/png',
        preview: 'data:image/png;base64,private-image-data',
      },
    ],
  };
  const first = renderHook(() => useQueuedMessages('child'));
  act(() => first.result.current.restoreRejected(payload));
  expect(first.result.current.queue[0].images).toEqual(payload.images);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-child')!)).toEqual([
    { text: payload.text, contextBlocks: payload.contextBlocks, requiresRetry: true },
  ]);
  expect(localStorage.getItem('mitzo-queue-child')).not.toContain('private-image-data');
  first.unmount();
  const hydrated = renderHook(() => useQueuedMessages('child'));
  expect(hydrated.result.current.queue).toEqual([
    { text: payload.text, contextBlocks: payload.contextBlocks, requiresRetry: true, images: [] },
  ]);
  let next: QueuedMessage | undefined;
  act(() => {
    next = hydrated.result.current.dequeue();
  });
  expect(next).toBeUndefined();
  expect(hydrated.result.current.queue).toHaveLength(1);
  act(() => {
    next = hydrated.result.current.edit(0);
  });
  expect(next).toEqual({
    text: payload.text,
    contextBlocks: payload.contextBlocks,
    requiresRetry: true,
    images: [],
  });
  expect(hydrated.result.current.queue).toEqual([]);
});

it('preserves the retry fence when switching to a stored queue while legacy independent input still drains', () => {
  localStorage.setItem(
    'mitzo-queue-child',
    JSON.stringify([
      { text: 'Legacy independent', contextBlocks: [] },
      { text: 'Refused input', contextBlocks: ['exact'], requiresRetry: true },
    ]),
  );
  const { result, rerender } = renderHook(({ id }) => useQueuedMessages(id), {
    initialProps: { id: 'other' },
  });
  rerender({ id: 'child' });
  let next: QueuedMessage | undefined;
  act(() => {
    next = result.current.dequeue();
  });
  expect(next?.text).toBe('Legacy independent');
  act(() => {
    next = result.current.dequeue();
  });
  expect(next).toBeUndefined();
  expect(result.current.queue).toEqual([
    { text: 'Refused input', contextBlocks: ['exact'], requiresRetry: true, images: [] },
  ]);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-child')!)).toEqual([
    { text: 'Refused input', contextBlocks: ['exact'], requiresRetry: true },
  ]);
});
