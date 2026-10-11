// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useQueuedMessages, type QueuedMessage } from '../useQueuedMessages';
import type { DraftSessionAssignment } from '../useDraft';

function msg(text: string): QueuedMessage {
  return { text, images: [], contextBlocks: [] };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('useQueuedMessages', () => {
  it.each(['empty', 'stale'] as const)(
    'removes only the accepted live ID when readable %s storage rejects quota writes',
    (storage) => {
      const owner = renderHook(() => useQueuedMessages('a'));
      let accepted!: QueuedMessage;
      if (storage === 'stale')
        act(() => {
          accepted = owner.result.current.restoreRejected(msg('Accepted'));
        });
      const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      });
      if (storage === 'empty')
        act(() => {
          accepted = owner.result.current.restoreRejected(msg('Accepted'));
        });
      const payload = {
        ...msg('Unsent café 雪'),
        contextBlocks: ['Exact unsent context'],
        requiresRetry: true,
        images: [{ data: 'private-image', mediaType: 'image/png', preview: 'private-preview' }],
      };
      act(() => owner.result.current.enqueue(payload));
      const unsent = owner.result.current.queue[1];
      expect(unsent.queueEntryId).not.toBe(accepted.queueEntryId);
      expect(write).toHaveBeenCalled();
      expect(localStorage.getItem('mitzo-queue-a') ?? '').not.toContain('Unsent');
      act(() => owner.result.current.removeSubmitted(accepted));
      expect(owner.result.current.queue).toEqual([unsent]);
      expect(owner.result.current.queue[0].images).toBe(payload.images);
      expect(owner.result.current.dequeue()).toBeUndefined();
      // Once a live edit persists, fresh owner storage is authoritative again.
      write.mockRestore();
      act(() => owner.result.current.enqueue(msg('Later')));
      let next!: QueuedMessage;
      act(() => {
        next = owner.result.current.restoreRejected(msg('Next accepted'));
      });
      const later = owner.result.current.queue[1];
      const fresh = { ...later, text: 'Fresh stored edit', contextBlocks: ['Fresh context'] };
      localStorage.setItem('mitzo-queue-a', JSON.stringify([fresh, next]));
      act(() => owner.result.current.removeSubmitted(next));
      expect(owner.result.current.queue).toEqual([{ ...fresh, images: [] }]);
      expect(
        owner.result.current.queue.some((entry) => entry.queueEntryId === unsent.queueEntryId),
      ).toBe(false);
    },
  );

  it('preserves a dirty active queue on key-only cleanup while failed cleanup does not announce stale storage', () => {
    const origin = renderHook(({ id }) => useQueuedMessages(id, 5, null), {
      initialProps: { id: 'a' },
    });
    let accepted!: QueuedMessage;
    act(() => {
      accepted = origin.result.current.restoreRejected(msg('Accepted A'));
    });
    origin.rerender({ id: 'b' });
    const active = renderHook(() => useQueuedMessages('a'));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (value.includes('Unsent')) throw new DOMException('Quota', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    const payload = {
      ...msg('Unsent A'),
      contextBlocks: ['Exact context'],
      requiresRetry: true,
      images: [{ data: 'private-image', mediaType: 'image/png', preview: 'private-preview' }],
    };
    act(() => active.result.current.enqueue(payload));
    const unsent = active.result.current.queue[1];
    act(() => origin.result.current.removeSubmitted(accepted));
    expect(active.result.current.queue).toEqual([unsent]);
    expect(active.result.current.dequeue()).toBeUndefined();
    expect(origin.result.current.queue).toEqual([]);
    // The active hook has unsaved input, so its next accepted entry must not
    // announce a readable stale snapshot as successful cleanup.
    let next!: QueuedMessage;
    act(() => {
      next = active.result.current.restoreRejected(msg('Next accepted'));
    });
    const notify = vi.fn();
    window.addEventListener('mitzo-queue-changed', notify);
    try {
      act(() => active.result.current.removeSubmitted(next));
      expect(active.result.current.queue).toEqual([unsent]);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('mitzo-queue-changed', notify);
    }
    expect(localStorage.getItem('mitzo-queue-a') ?? '').not.toContain('private-image');
  });

  it('keeps fresh persisted fields and deletions while retaining only failed-write new live entries', () => {
    const owner = renderHook(() => useQueuedMessages('a'));
    let accepted!: QueuedMessage;
    act(() => {
      accepted = owner.result.current.restoreRejected(msg('Accepted'));
    });
    const image = { data: 'private-image', mediaType: 'image/png', preview: 'private-preview' };
    act(() => owner.result.current.enqueue({ ...msg('Stored B'), images: [image] }));
    const b = owner.result.current.queue[1];
    act(() => owner.result.current.enqueue(msg('Deleted C')));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (value.includes('Unsent')) throw new DOMException('Quota', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    act(() => owner.result.current.enqueue(msg('Unsent D')));
    const unsent = owner.result.current.queue[3];
    const freshB = {
      text: 'Fresh B',
      contextBlocks: ['Fresh context'],
      queueEntryId: b.queueEntryId,
    };
    localStorage.setItem('mitzo-queue-a', JSON.stringify([accepted, freshB]));
    act(() => owner.result.current.removeSubmitted(accepted));
    expect(owner.result.current.queue).toEqual([{ ...freshB, images: [image] }, unsent]);
    expect(owner.result.current.queue[0].images).toBe(b.images);
  });

  it('does not turn a fresh peer snapshot into unsaved local input when its incidental save fails', () => {
    const origin = renderHook(() => useQueuedMessages('a'));
    const peer = renderHook(() => useQueuedMessages('a'));
    let a!: QueuedMessage;
    let b!: QueuedMessage;
    act(() => {
      a = origin.result.current.restoreRejected(msg('Accepted A'));
    });
    act(() => {
      b = origin.result.current.restoreRejected(msg('Accepted B'));
    });
    const setItem = Storage.prototype.setItem;
    let successfulWrites = 1;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (successfulWrites-- <= 0) throw new DOMException('Quota', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    act(() => origin.result.current.removeSubmitted(b));
    expect(peer.result.current.queue).toEqual([{ ...a, images: [] }]);
    // Peer saw persisted A before its own redundant save failed; A remains
    // storage-owned and must disappear after the origin's exact acceptance.
    act(() => origin.result.current.removeSubmitted(a));
    expect(peer.result.current.queue).toEqual([]);
    expect(localStorage.getItem('mitzo-queue-a')).toBeNull();
  });

  it('does not resurrect an unmounted dirty origin over fresh successful remount storage', () => {
    const origin = renderHook(() => useQueuedMessages('a'));
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota', 'QuotaExceededError');
    });
    let accepted!: QueuedMessage;
    act(() => {
      accepted = origin.result.current.restoreRejected(msg('Accepted A'));
    });
    act(() => origin.result.current.enqueue(msg('Removed B')));
    const accept = origin.result.current.removeSubmitted;
    origin.unmount();
    write.mockRestore();
    const reopened = renderHook(() => useQueuedMessages('a'));
    act(() => reopened.result.current.enqueue(msg('Fresh C')));
    const fresh = reopened.result.current.queue[0];
    act(() => accept(accepted));
    expect(reopened.result.current.queue).toEqual([fresh]);
    expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([
      { text: fresh.text, contextBlocks: fresh.contextBlocks, queueEntryId: fresh.queueEntryId },
    ]);
  });

  it.each(['distinct', 'duplicate'] as const)(
    'does not resurrect an accepted edited legacy row when quota rejects writes (%s text)',
    (text) => {
      const legacy = [
        msg('Legacy input'),
        msg(text === 'duplicate' ? 'Legacy input' : 'Other legacy'),
      ];
      localStorage.setItem('mitzo-queue-a', JSON.stringify(legacy));
      const owner = renderHook(() => useQueuedMessages('a'));
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('Quota', 'QuotaExceededError');
      });
      let edited!: QueuedMessage;
      act(() => {
        edited = owner.result.current.edit(0)!;
      });
      const sibling = owner.result.current.queue[0];
      let accepted!: QueuedMessage;
      act(() => {
        accepted = owner.result.current.restoreRejected(edited);
      });
      expect(accepted.queueEntryId).toEqual(expect.any(String));
      act(() => owner.result.current.removeSubmitted(accepted));
      expect(owner.result.current.queue).toEqual([sibling]);
    },
  );

  it('does not subtract an already persisted legacy removal again from fresh duplicate rows', () => {
    const legacy = [msg('Identical legacy'), msg('Identical legacy')];
    localStorage.setItem('mitzo-queue-a', JSON.stringify(legacy));
    const owner = renderHook(() => useQueuedMessages('a'));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota', 'QuotaExceededError');
    });
    let edited!: QueuedMessage;
    act(() => {
      edited = owner.result.current.edit(0)!;
    });
    const sibling = owner.result.current.queue[0];
    let accepted!: QueuedMessage;
    act(() => {
      accepted = owner.result.current.restoreRejected(edited);
    });
    // Another successful writer has already retained just the sibling.
    setItem.call(localStorage, 'mitzo-queue-a', JSON.stringify([legacy[1]]));
    act(() => owner.result.current.removeSubmitted(accepted));
    expect(owner.result.current.queue).toEqual([sibling]);
  });

  it('does not resurrect an accepted ID on a later key notification after its cleanup write failed', () => {
    const owner = renderHook(() => useQueuedMessages('a'));
    let accepted!: QueuedMessage;
    act(() => {
      accepted = owner.result.current.restoreRejected(msg('Accepted'));
    });
    act(() => owner.result.current.enqueue(msg('Other')));
    const other = owner.result.current.queue[1];
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota', 'QuotaExceededError');
    });
    act(() => owner.result.current.removeSubmitted(accepted));
    expect(owner.result.current.queue).toEqual([other]);
    expect(localStorage.getItem('mitzo-queue-a')).toContain(accepted.queueEntryId!);
    act(() =>
      window.dispatchEvent(
        new CustomEvent('mitzo-queue-changed', {
          detail: { key: 'mitzo-queue-a' },
        }),
      ),
    );
    expect(owner.result.current.queue).toEqual([other]);
  });

  it('keeps distinct exact queue identities on supported remote HTTP without crypto.randomUUID', () => {
    let nonce = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: vi.fn((bytes: Uint8Array) => bytes.fill(++nonce)),
    });
    const owner = renderHook(() => useQueuedMessages('a'));
    const payload = { ...msg('Same input'), contextBlocks: ['Exact context'] };
    act(() => owner.result.current.enqueue(payload));
    const queued = owner.result.current.queue[0];
    let retained: QueuedMessage;
    act(() => {
      retained = owner.result.current.restoreRejected(queued);
    });
    act(() => owner.result.current.enqueue(payload));
    const later = owner.result.current.queue[1];
    expect(retained!.queueEntryId).toMatch(/^[a-f0-9-]{36}$/);
    expect(later.queueEntryId).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Set([queued.queueEntryId, retained!.queueEntryId, later.queueEntryId]).size).toBe(3);
    expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([
      {
        text: payload.text,
        contextBlocks: payload.contextBlocks,
        requiresRetry: true,
        queueEntryId: retained!.queueEntryId,
      },
      {
        text: payload.text,
        contextBlocks: payload.contextBlocks,
        queueEntryId: later.queueEntryId,
      },
    ]);
    act(() => owner.result.current.removeSubmitted(retained!));
    expect(owner.result.current.queue).toEqual([later]);
  });

  it('keeps exact queue identities and late image cleanup on remote HTTP without randomUUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const origin = renderHook(({ id }) => useQueuedMessages(id, 5, null), {
      initialProps: { id: 'a' },
    });
    const image = {
      data: 'private-image',
      mediaType: 'image/png',
      preview: 'data:image/png;base64,private-image',
    };
    const payload = {
      ...msg('Identical input'),
      contextBlocks: ['exact context'],
      images: [image],
    };
    act(() => origin.result.current.enqueue(payload));
    const queued = origin.result.current.queue[0];
    let retained!: QueuedMessage;
    act(() => {
      retained = origin.result.current.restoreRejected(queued);
    });
    expect(retained.queueEntryId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(retained.queueEntryId).not.toBe(queued.queueEntryId);
    expect(retained.images).toBe(payload.images);
    expect(origin.result.current.dequeue()).toBeUndefined();
    origin.rerender({ id: 'b' });
    act(() => origin.result.current.enqueue(msg('Other conversation')));
    const reopened = renderHook(() => useQueuedMessages('a'));
    act(() => reopened.result.current.enqueue(payload));
    const later = reopened.result.current.queue.at(-1)!;
    expect(later.queueEntryId).not.toBe(retained.queueEntryId);
    act(() => origin.result.current.removeSubmitted(retained));
    expect(reopened.result.current.queue).toEqual([later]);
    expect(reopened.result.current.queue[0].images).toBe(payload.images);
    expect(origin.result.current.queue).toMatchObject([msg('Other conversation')]);
    const stored = localStorage.getItem('mitzo-queue-a')!;
    expect(stored).not.toContain('private-image');
    expect(JSON.parse(stored)).toEqual([
      {
        text: payload.text,
        contextBlocks: payload.contextBlocks,
        queueEntryId: later.queueEntryId,
      },
    ]);
  });

  it('preserves a later active A image entry when an offscreen A receipt emits its key-only cleanup event', () => {
    const origin = renderHook(({ id }) => useQueuedMessages(id, 5, null), {
      initialProps: { id: 'a' },
    });
    let accepted: QueuedMessage;
    act(() => {
      accepted = origin.result.current.restoreRejected(msg('Old A'));
    });
    origin.rerender({ id: 'b' });
    act(() => origin.result.current.enqueue(msg('B work')));
    const activeA = renderHook(() => useQueuedMessages('a'));
    const image = {
      data: 'private-later-image',
      mediaType: 'image/png',
      preview: 'data:image/png;base64,private-later-image',
    };
    act(() => activeA.result.current.enqueue({ ...msg('Later A'), images: [image] }));
    const later = activeA.result.current.queue.at(-1)!;
    expect(later.queueEntryId).not.toBe(accepted!.queueEntryId);
    const stored = JSON.parse(localStorage.getItem('mitzo-queue-a')!) as QueuedMessage[];
    const freshLater = {
      text: 'Fresh later A',
      contextBlocks: ['fresh context'],
      requiresRetry: true,
      queueEntryId: later.queueEntryId,
    };
    localStorage.setItem(
      'mitzo-queue-a',
      JSON.stringify(
        stored.map((entry) => (entry.queueEntryId === later.queueEntryId ? freshLater : entry)),
      ),
    );
    act(() => origin.result.current.removeSubmitted(accepted!));
    expect(activeA.result.current.queue).toEqual([{ ...freshLater, images: [image] }]);
    expect(activeA.result.current.queue[0].images).toBe(later.images);
    expect(origin.result.current.queue).toMatchObject([msg('B work')]);
    expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([freshLater]);
    expect(localStorage.getItem('mitzo-queue-a')).not.toContain('private-later-image');
  });

  it.each(['navigate', 'active', 'unmount'] as const)(
    'cleans only an exact ID from fresh owner storage after %s and notifies reopened A using only its key',
    (transition) => {
      const original = renderHook(({ id }) => useQueuedMessages(id, 5, null), {
        initialProps: { id: 'a' },
      });
      let first: QueuedMessage;
      let other: QueuedMessage;
      act(() => {
        first = original.result.current.restoreRejected(msg('Identical text'));
      });
      act(() => {
        other = original.result.current.restoreRejected(msg('Identical text'));
      });
      expect(first!.queueEntryId).toMatch(/^[a-f0-9-]{36}$/);
      expect(other!.queueEntryId).not.toBe(first!.queueEntryId);
      const accept = original.result.current.removeSubmitted;
      if (transition === 'navigate') {
        original.rerender({ id: 'b' });
        act(() => original.result.current.enqueue(msg('B work')));
      } else if (transition === 'unmount') original.unmount();
      const reopened = renderHook(() => useQueuedMessages('a'));
      act(() => reopened.result.current.enqueue(msg('Later A')));
      const laterId = reopened.result.current.queue.at(-1)!.queueEntryId;
      const events: unknown[] = [];
      const listener = (event: Event) => events.push((event as CustomEvent).detail);
      window.addEventListener('mitzo-queue-changed', listener);
      try {
        act(() => accept(first!));
      } finally {
        window.removeEventListener('mitzo-queue-changed', listener);
      }
      expect(events).toEqual([{ key: 'mitzo-queue-a' }]);
      expect(reopened.result.current.queue).toMatchObject([
        { ...other!, images: [] },
        msg('Later A'),
      ]);
      if (transition === 'navigate')
        expect(original.result.current.queue).toMatchObject([msg('B work')]);
      else if (transition === 'active')
        expect(original.result.current.queue).toMatchObject([
          { ...other!, images: [] },
          msg('Later A'),
        ]);
      expect(
        JSON.parse(localStorage.getItem('mitzo-queue-a')!).map(
          (row: QueuedMessage) => row.queueEntryId,
        ),
      ).toEqual([other!.queueEntryId, laterId]);
    },
  );

  it('preserves live images on another exact entry while cleaning the active owner from fresh storage', () => {
    const owner = renderHook(() => useQueuedMessages('a'));
    const image = {
      data: 'other-image',
      mediaType: 'image/png',
      preview: 'data:image/png;base64,other-image',
    };
    act(() => owner.result.current.enqueue({ ...msg('Other image'), images: [image] }));
    let retained: QueuedMessage;
    act(() => {
      retained = owner.result.current.restoreRejected(msg('Accepted'));
    });
    act(() => owner.result.current.removeSubmitted(retained!));
    expect(owner.result.current.queue).toMatchObject([{ ...msg('Other image'), images: [image] }]);
    expect(localStorage.getItem('mitzo-queue-a')).not.toContain('other-image');
  });

  it.each(['empty', 'existing'] as const)(
    'promotes the exact assigned queue into an %s destination with images and retry fences intact',
    (destination) => {
      const existing = destination === 'existing' ? [msg('Existing B')] : [];
      if (existing.length) localStorage.setItem('mitzo-queue-b', JSON.stringify(existing));
      const { result, rerender } = renderHook(
        ({ id, assignment }: { id: string; assignment?: DraftSessionAssignment }) =>
          useQueuedMessages(id, 5, assignment),
        { initialProps: { id: 'a', assignment: undefined as DraftSessionAssignment | undefined } },
      );
      const payload = {
        ...msg('Pending A'),
        images: [{ data: 'image', mediaType: 'image/png', preview: 'data:image/png;base64,image' }],
        contextBlocks: ['Exact context'],
      };
      let retained: QueuedMessage;
      act(() => {
        retained = result.current.restoreRejected(payload);
      });
      rerender({ id: 'b', assignment: { fromSessionId: 'a', toSessionId: 'b' } });
      expect(result.current.queue).toMatchObject([
        ...existing,
        { ...payload, requiresRetry: true },
      ]);
      expect(result.current.queue.at(-1)).toBe(retained!);
      expect(localStorage.getItem('mitzo-queue-a')).toBeNull();
      expect(JSON.parse(localStorage.getItem('mitzo-queue-b')!)).toMatchObject([
        ...existing.map(({ text, contextBlocks }) => ({ text, contextBlocks })),
        { text: payload.text, contextBlocks: payload.contextBlocks, requiresRetry: true },
      ]);
      if (existing.length)
        act(() => {
          result.current.dequeue();
        });
      let next: QueuedMessage | undefined;
      act(() => {
        next = result.current.dequeue();
      });
      expect(next).toBeUndefined();
      act(() => result.current.removeSubmitted(retained!));
      expect(result.current.queue).toEqual([]);
      expect(localStorage.getItem('mitzo-queue-b')).toBeNull();
    },
  );

  it('does not promote an ordinary queue for a mismatched assignment source', () => {
    const { result, rerender } = renderHook(
      ({ id }) => useQueuedMessages(id, 5, { fromSessionId: 'different', toSessionId: 'b' }),
      { initialProps: { id: 'a' } },
    );
    act(() => result.current.enqueue(msg('A')));
    rerender({ id: 'b' });
    expect(result.current.queue).toEqual([]);
    expect(localStorage.getItem('mitzo-queue-a')).toContain('A');
  });

  it('saves an enqueue batched with navigation under its original conversation', () => {
    localStorage.setItem('mitzo-queue-b', JSON.stringify([msg('Existing B')]));
    const { result, rerender } = renderHook(({ id }) => useQueuedMessages(id), {
      initialProps: { id: 'a' },
    });
    act(() => {
      result.current.enqueue(msg('Immediate A'));
      rerender({ id: 'b' });
    });
    expect(result.current.queue).toMatchObject([msg('Existing B')]);
    expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toMatchObject([
      { text: 'Immediate A', contextBlocks: [] },
    ]);
    rerender({ id: 'a' });
    expect(result.current.queue).toMatchObject([msg('Immediate A')]);
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
      expect(result.current.queue).toMatchObject(
        destination === 'existing' ? [msg('Existing B')] : [],
      );
      expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toMatchObject([
        { text: 'Refused A', contextBlocks: ['Exact A'], requiresRetry: true },
      ]);
      act(() => result.current.enqueue(msg('Later B')));
      rerender({ id: 'a' });
      expect(result.current.queue).toMatchObject([refused]);
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
    expect(result.current.queue).toMatchObject([msg('New')]);
    expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toMatchObject([
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
    expect(stored).toMatchObject([{ text: 'first', contextBlocks: [] }]);
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
    expect(result.current.queue).toMatchObject([
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
  expect(JSON.parse(localStorage.getItem('mitzo-queue-child')!)).toMatchObject([
    { text: payload.text, contextBlocks: payload.contextBlocks, requiresRetry: true },
  ]);
  expect(localStorage.getItem('mitzo-queue-child')).not.toContain('private-image-data');
  first.unmount();
  const hydrated = renderHook(() => useQueuedMessages('child'));
  expect(hydrated.result.current.queue).toMatchObject([
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
  expect(next).toMatchObject({
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
  expect(result.current.queue).toMatchObject([
    { text: 'Refused input', contextBlocks: ['exact'], requiresRetry: true, images: [] },
  ]);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-child')!)).toMatchObject([
    { text: 'Refused input', contextBlocks: ['exact'], requiresRetry: true },
  ]);
});

it('removes only the accepted live ID when quota denied every nonempty save but reads/removals work', () => {
  const owner = renderHook(() => useQueuedMessages('a'));
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  let accepted!: QueuedMessage;
  act(() => {
    accepted = owner.result.current.restoreRejected(msg('Accepted A'));
  });
  const image = { data: 'private-later-image', mediaType: 'image/png', preview: 'private-preview' };
  act(() =>
    owner.result.current.enqueue({
      ...msg('Unsent A'),
      contextBlocks: ['Exact later context'],
      images: [image],
    }),
  );
  const later = owner.result.current.queue[1];
  expect(localStorage.getItem('mitzo-queue-a')).toBeNull();
  act(() => owner.result.current.removeSubmitted(accepted));
  expect(owner.result.current.queue).toEqual([later]);
  expect(owner.result.current.queue[0].images).toBe(later.images);
  write.mockRestore();
});
it('reconciles prior failed saves with readable stale storage when acceptance persistence can succeed', () => {
  const owner = renderHook(() => useQueuedMessages('a'));
  act(() => owner.result.current.enqueue(msg('Submitted draft')));
  const original = owner.result.current.queue[0];
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  let accepted!: QueuedMessage;
  act(() => {
    accepted = owner.result.current.restoreRejected(original);
  });
  const later = {
    ...msg('Unsent A'),
    contextBlocks: ['Later exact context'],
    images: [{ data: 'image', mediaType: 'image/png', preview: 'private' }],
  };
  act(() => owner.result.current.enqueue(later));
  const queuedLater = owner.result.current.queue[1];
  expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)[0].queueEntryId).toBe(
    original.queueEntryId,
  );
  write.mockRestore();
  act(() => owner.result.current.removeSubmitted(accepted));
  expect(owner.result.current.queue).toEqual([queuedLater]);
  expect(owner.result.current.queue[0].images).toBe(later.images);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([
    {
      text: later.text,
      contextBlocks: later.contextBlocks,
      queueEntryId: queuedLater.queueEntryId,
    },
  ]);
});
it('keeps the original live payload and emits no stale sibling refresh when acknowledgement storage is unreadable and writes fail', () => {
  const owner = renderHook(() => useQueuedMessages('a'));
  let accepted!: QueuedMessage;
  act(() => {
    accepted = owner.result.current.restoreRejected(msg('Accepted A'));
  });
  const image = { data: 'private', mediaType: 'image/png', preview: 'private' };
  act(() =>
    owner.result.current.enqueue({
      ...msg('Unsent A'),
      contextBlocks: ['Exact context'],
      images: [image],
    }),
  );
  const later = owner.result.current.queue[1];
  const sibling = renderHook(() => useQueuedMessages('a'));
  const stale = JSON.parse(localStorage.getItem('mitzo-queue-a')!);
  localStorage.setItem('mitzo-queue-a', JSON.stringify([stale[0]]));
  const events: unknown[] = [];
  const listener = (event: Event) => events.push((event as CustomEvent).detail);
  window.addEventListener('mitzo-queue-changed', listener);
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Read unavailable', 'SecurityError');
  });
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('Unavailable', 'SecurityError');
  });
  try {
    act(() => owner.result.current.removeSubmitted(accepted));
    expect(owner.result.current.queue).toEqual([later]);
    expect(owner.result.current.queue[0].images).toBe(later.images);
    expect(sibling.result.current.queue).toHaveLength(2);
    expect(events).toEqual([]);
  } finally {
    window.removeEventListener('mitzo-queue-changed', listener);
    read.mockRestore();
    write.mockRestore();
    remove.mockRestore();
  }
  // Restore the complete saved snapshot once storage becomes usable.
  localStorage.setItem('mitzo-queue-a', JSON.stringify(stale));
  act(() => owner.result.current.removeSubmitted(accepted));
  expect(owner.result.current.queue).toEqual([later]);
});
it('preserves a live-only later A payload when offscreen cleanup successfully removes its readable old key', () => {
  const origin = renderHook(({ id }) => useQueuedMessages(id, 5, null), {
    initialProps: { id: 'a' },
  });
  let accepted!: QueuedMessage;
  act(() => {
    accepted = origin.result.current.restoreRejected(msg('Accepted A'));
  });
  origin.rerender({ id: 'b' });
  act(() => origin.result.current.enqueue(msg('B work')));
  const activeA = renderHook(() => useQueuedMessages('a'));
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  const payload = {
    ...msg('Later A'),
    contextBlocks: ['Exact later A'],
    images: [{ data: 'private-image', mediaType: 'image/png', preview: 'private' }],
  };
  act(() => activeA.result.current.enqueue(payload));
  const later = activeA.result.current.queue[1];
  act(() => origin.result.current.removeSubmitted(accepted));
  expect(activeA.result.current.queue).toEqual([later]);
  expect(activeA.result.current.queue[0].images).toBe(payload.images);
  expect(origin.result.current.queue).toMatchObject([msg('B work')]);
  write.mockRestore();
});

it('merges only unsaved local work while preserving fresh same-ID fields and authoritative external deletions', () => {
  const owner = renderHook(() => useQueuedMessages('a'));
  let accepted!: QueuedMessage;
  act(() => {
    accepted = owner.result.current.restoreRejected(msg('Accepted'));
  });
  const image = { data: 'private-existing-image', mediaType: 'image/png', preview: 'private' };
  act(() =>
    owner.result.current.enqueue({
      ...msg('Old existing'),
      contextBlocks: ['old context'],
      images: [image],
    }),
  );
  act(() => owner.result.current.enqueue(msg('Externally removed')));
  const existing = owner.result.current.queue[1];
  const removed = owner.result.current.queue[2];
  const stored = JSON.parse(localStorage.getItem('mitzo-queue-a')!);
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  const extra = {
    ...msg('Unsaved extra'),
    contextBlocks: ['Exact unsaved context'],
    images: [{ data: 'private-extra-image', mediaType: 'image/png', preview: 'private' }],
  };
  act(() => owner.result.current.enqueue(extra));
  const unsaved = owner.result.current.queue[3];
  write.mockRestore();
  const fresh = {
    ...stored[1],
    text: 'Fresh existing',
    contextBlocks: ['fresh context'],
    requiresRetry: true,
  };
  localStorage.setItem('mitzo-queue-a', JSON.stringify([stored[0], fresh]));
  act(() => owner.result.current.removeSubmitted(accepted));
  expect(owner.result.current.queue).toEqual([{ ...fresh, images: existing.images }, unsaved]);
  expect(
    owner.result.current.queue.some((entry) => entry.queueEntryId === removed.queueEntryId),
  ).toBe(false);
  expect(owner.result.current.queue[0].images).toBe(existing.images);
  expect(owner.result.current.queue[1].images).toBe(extra.images);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([
    fresh,
    {
      text: unsaved.text,
      contextBlocks: unsaved.contextBlocks,
      queueEntryId: unsaved.queueEntryId,
    },
  ]);
  expect(localStorage.getItem('mitzo-queue-a')).not.toContain('private-');
});
it('does not publish stale A cleanup or touch B when offscreen acknowledgement persistence fails, then reconciles the exact retry', () => {
  const origin = renderHook(({ id }) => useQueuedMessages(id, 5, null), {
    initialProps: { id: 'a' },
  });
  let accepted!: QueuedMessage;
  act(() => {
    accepted = origin.result.current.restoreRejected(msg('Accepted A'));
  });
  act(() => origin.result.current.enqueue(msg('Other A')));
  origin.rerender({ id: 'b' });
  act(() => origin.result.current.enqueue({ ...msg('B work'), contextBlocks: ['B context'] }));
  const activeA = renderHook(() => useQueuedMessages('a'));
  const image = { data: 'private-later-image', mediaType: 'image/png', preview: 'private' };
  act(() =>
    activeA.result.current.enqueue({
      ...msg('Later A'),
      contextBlocks: ['Later A context'],
      images: [image],
    }),
  );
  const beforeA = activeA.result.current.queue;
  const beforeB = origin.result.current.queue;
  const beforeStorage = localStorage.getItem('mitzo-queue-a');
  const events: unknown[] = [];
  const listener = (event: Event) => events.push((event as CustomEvent).detail);
  window.addEventListener('mitzo-queue-changed', listener);
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  try {
    act(() => origin.result.current.removeSubmitted(accepted));
    expect(activeA.result.current.queue).toEqual(beforeA);
    expect(origin.result.current.queue).toEqual(beforeB);
    expect(localStorage.getItem('mitzo-queue-a')).toBe(beforeStorage);
    expect(events).toEqual([]);
    write.mockRestore();
    act(() => origin.result.current.removeSubmitted(accepted));
    expect(events).toEqual([{ key: 'mitzo-queue-a' }]);
    expect(activeA.result.current.queue).toEqual(
      beforeA.filter((entry) => entry.queueEntryId !== accepted.queueEntryId),
    );
    expect(activeA.result.current.queue.at(-1)!.images).toBe(beforeA.at(-1)!.images);
    expect(origin.result.current.queue).toEqual(beforeB);
  } finally {
    window.removeEventListener('mitzo-queue-changed', listener);
    write.mockRestore();
  }
});
it('retains unsaved assigned queue work and its exact receipt owner when promotion writes fail', () => {
  const owner = renderHook(({ id, assignment }) => useQueuedMessages(id, 5, assignment), {
    initialProps: {
      id: undefined as string | undefined,
      assignment: null as DraftSessionAssignment | null,
    },
  });
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  let accepted!: QueuedMessage;
  act(() => {
    accepted = owner.result.current.restoreRejected(msg('Assigned input'));
  });
  const later = {
    ...msg('Unsent assigned work'),
    contextBlocks: ['exact assigned context'],
    images: [{ data: 'private-image', mediaType: 'image/png', preview: 'private' }],
  };
  act(() => owner.result.current.enqueue(later));
  const queuedLater = owner.result.current.queue[1];
  owner.rerender({
    id: 'assigned',
    assignment: { fromSessionId: undefined, toSessionId: 'assigned' },
  });
  act(() => owner.result.current.removeSubmitted(accepted));
  expect(owner.result.current.queue).toEqual([queuedLater]);
  write.mockRestore();
  act(() => owner.result.current.removeSubmitted(accepted));
  expect(owner.result.current.queue).toEqual([queuedLater]);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-assigned')!)).toEqual([
    {
      text: later.text,
      contextBlocks: later.contextBlocks,
      queueEntryId: queuedLater.queueEntryId,
    },
  ]);
});

it('does not revive unmounted dirty memory over a reopened owner with fresh persisted work', () => {
  const old = renderHook(() => useQueuedMessages('a'));
  let accepted!: QueuedMessage;
  act(() => {
    accepted = old.result.current.restoreRejected(msg('Accepted A'));
  });
  const cleanupAccepted = old.result.current.removeSubmitted;
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  act(() =>
    old.result.current.enqueue({
      ...msg('Obsolete unsaved old work'),
      contextBlocks: ['Old context'],
      images: [{ data: 'old-private-image', mediaType: 'image/png', preview: 'old' }],
    }),
  );
  old.unmount();
  write.mockRestore();
  const reopened = renderHook(() => useQueuedMessages('a'));
  const image = { data: 'fresh-private-image', mediaType: 'image/png', preview: 'fresh' };
  act(() =>
    reopened.result.current.enqueue({
      ...msg('Fresh reopened work'),
      contextBlocks: ['Fresh context'],
      images: [image],
    }),
  );
  const fresh = reopened.result.current.queue[1];
  act(() => cleanupAccepted(accepted));
  expect(reopened.result.current.queue).toEqual([fresh]);
  expect(reopened.result.current.queue[0].images).toBe(fresh.images);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([
    { text: fresh.text, contextBlocks: fresh.contextBlocks, queueEntryId: fresh.queueEntryId },
  ]);
});
it('uses the successful legacy migration baseline so a later quota failure cannot resurrect the replaced original input', () => {
  const owner = renderHook(({ id }) => useQueuedMessages(id), {
    initialProps: { id: undefined as string | undefined },
  });
  act(() => owner.result.current.enqueue(msg('Original input')));
  const original = owner.result.current.queue[0];
  const image = { data: 'private-other-image', mediaType: 'image/png', preview: 'private' };
  act(() =>
    owner.result.current.enqueue({
      ...msg('Other work'),
      contextBlocks: ['Exact other context'],
      images: [image],
    }),
  );
  const other = owner.result.current.queue[1];
  owner.rerender({ id: 'assigned' });
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  let accepted!: QueuedMessage;
  act(() => {
    accepted = owner.result.current.restoreRejected(original);
  });
  write.mockRestore();
  act(() => owner.result.current.removeSubmitted(accepted));
  expect(owner.result.current.queue).toEqual([other]);
  expect(owner.result.current.queue[0].images).toBe(other.images);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-assigned')!)).toEqual([
    { text: other.text, contextBlocks: other.contextBlocks, queueEntryId: other.queueEntryId },
  ]);
  expect(localStorage.getItem('mitzo-queue-new')).toBeNull();
});

it('reconciles fresh stored fields and deletions when only the first acknowledgement write fails', () => {
  const owner = renderHook(() => useQueuedMessages('a'));
  let accepted!: QueuedMessage;
  act(() => {
    accepted = owner.result.current.restoreRejected(msg('Accepted A'));
  });
  const image = { data: 'private-existing', mediaType: 'image/png', preview: 'private' };
  act(() =>
    owner.result.current.enqueue({
      ...msg('Old existing'),
      contextBlocks: ['old context'],
      images: [image],
    }),
  );
  act(() => owner.result.current.enqueue(msg('Externally deleted')));
  const existing = owner.result.current.queue[1];
  const stored = JSON.parse(localStorage.getItem('mitzo-queue-a')!);
  const fresh = {
    ...stored[1],
    text: 'Fresh existing',
    contextBlocks: ['fresh context'],
    requiresRetry: true,
  };
  const external = {
    text: 'Fresh external',
    contextBlocks: ['external context'],
    queueEntryId: '8bdf6d2f-f2fa-424d-8c31-70da1b499a31',
  };
  localStorage.setItem('mitzo-queue-a', JSON.stringify([stored[0], fresh, external]));
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  act(() => owner.result.current.removeSubmitted(accepted));
  expect(write).toHaveBeenCalledTimes(2);
  expect(owner.result.current.queue).toEqual([
    { ...fresh, images: existing.images },
    { ...external, images: [] },
  ]);
  expect(owner.result.current.queue[0].images).toBe(existing.images);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([fresh, external]);
});
it('preserves anonymous legacy entry occurrences when quota clears before exact acceptance', () => {
  const anonymous = { text: 'Same legacy input', contextBlocks: ['same context'] };
  localStorage.setItem('mitzo-queue-a', JSON.stringify([anonymous, anonymous]));
  const owner = renderHook(() => useQueuedMessages('a'));
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  let accepted!: QueuedMessage;
  act(() => {
    accepted = owner.result.current.restoreRejected(owner.result.current.dequeue()!);
  });
  expect(owner.result.current.queue).toHaveLength(2);
  write.mockRestore();
  act(() => owner.result.current.removeSubmitted(accepted));
  expect(owner.result.current.queue).toEqual([{ ...anonymous, images: [] }]);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([anonymous]);
});

it('reconciles the old key before navigating when quota clears after acknowledgement and effect writes failed', () => {
  const owner = renderHook(({ id }) => useQueuedMessages(id, 5, null), {
    initialProps: { id: 'a' },
  });
  let accepted!: QueuedMessage;
  act(() => {
    accepted = owner.result.current.restoreRejected(msg('Accepted A'));
  });
  act(() => owner.result.current.enqueue({ ...msg('Old A'), contextBlocks: ['old context'] }));
  act(() => owner.result.current.enqueue(msg('Externally deleted A')));
  const stored = JSON.parse(localStorage.getItem('mitzo-queue-a')!);
  const fresh = {
    ...stored[1],
    text: 'Fresh A',
    contextBlocks: ['fresh context'],
    requiresRetry: true,
  };
  localStorage.setItem('mitzo-queue-a', JSON.stringify([stored[0], fresh]));
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  act(() => owner.result.current.removeSubmitted(accepted));
  expect(owner.result.current.queue.map((entry) => entry.text)).toEqual(['Fresh A']);
  write.mockRestore();
  owner.rerender({ id: 'b' });
  expect(owner.result.current.queue).toEqual([]);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([fresh]);
  act(() => owner.result.current.enqueue({ ...msg('B work'), contextBlocks: ['B context'] }));
  expect(owner.result.current.queue).toMatchObject([
    { ...msg('B work'), contextBlocks: ['B context'] },
  ]);
  const reopened = renderHook(() => useQueuedMessages('a'));
  expect(reopened.result.current.queue).toEqual([{ ...fresh, images: [] }]);
});
it('excludes the exact accepted ID when writes succeeded but verification reads previously failed', () => {
  const owner = renderHook(() => useQueuedMessages('a'));
  const set = Storage.prototype.setItem;
  const get = Storage.prototype.getItem;
  let verificationPending = false;
  let failVerification = true;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    set.call(this, key, value);
    if (failVerification) verificationPending = true;
  });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
    if (verificationPending) {
      verificationPending = false;
      throw new DOMException('Read unavailable', 'SecurityError');
    }
    return get.call(this, key);
  });
  let accepted!: QueuedMessage;
  act(() => {
    accepted = owner.result.current.restoreRejected(msg('Accepted A'));
  });
  const image = { data: 'private-later-image', mediaType: 'image/png', preview: 'private' };
  act(() =>
    owner.result.current.enqueue({
      ...msg('Other A'),
      contextBlocks: ['Exact other context'],
      images: [image],
    }),
  );
  const other = owner.result.current.queue[1];
  const stored = JSON.parse(get.call(localStorage, 'mitzo-queue-a')!);
  expect(stored).toHaveLength(2);
  // An exact accepted ID must also beat fresh edits to that same stored row.
  set.call(
    localStorage,
    'mitzo-queue-a',
    JSON.stringify([
      {
        ...stored[0],
        text: 'Fresh edit of the accepted row',
        contextBlocks: ['fresh accepted context'],
      },
      stored[1],
    ]),
  );
  failVerification = false;
  act(() => owner.result.current.removeSubmitted(accepted));
  expect(owner.result.current.queue).toEqual([other]);
  expect(owner.result.current.queue[0].images).toBe(other.images);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([
    { text: other.text, contextBlocks: other.contextBlocks, queueEntryId: other.queueEntryId },
  ]);
});

it('promotes the reconciled source after quota clears without copying stale fields into the assigned destination', () => {
  const owner = renderHook(({ id, assignment }) => useQueuedMessages(id, 5, assignment), {
    initialProps: { id: 'a', assignment: null as DraftSessionAssignment | null },
  });
  let accepted!: QueuedMessage;
  act(() => {
    accepted = owner.result.current.restoreRejected(msg('Accepted A'));
  });
  const image = { data: 'private-other-image', mediaType: 'image/png', preview: 'private' };
  act(() =>
    owner.result.current.enqueue({
      ...msg('Old A'),
      contextBlocks: ['old context'],
      images: [image],
    }),
  );
  act(() => owner.result.current.enqueue(msg('Externally deleted A')));
  const other = owner.result.current.queue[1];
  const stored = JSON.parse(localStorage.getItem('mitzo-queue-a')!);
  const fresh = {
    ...stored[1],
    text: 'Fresh A',
    contextBlocks: ['fresh context'],
    requiresRetry: true,
  };
  localStorage.setItem('mitzo-queue-a', JSON.stringify([stored[0], fresh]));
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  act(() => owner.result.current.removeSubmitted(accepted));
  write.mockRestore();
  owner.rerender({ id: 'assigned', assignment: { fromSessionId: 'a', toSessionId: 'assigned' } });
  expect(owner.result.current.queue).toEqual([{ ...fresh, images: other.images }]);
  expect(owner.result.current.queue[0].images).toBe(other.images);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-assigned')!)).toEqual([fresh]);
  expect(localStorage.getItem('mitzo-queue-a')).toBeNull();
});

it('keeps the durable source snapshot when explicit assignment cannot save its destination queue', () => {
  const owner = renderHook(({ id, assignment }) => useQueuedMessages(id, 5, assignment), {
    initialProps: { id: 'a', assignment: null as DraftSessionAssignment | null },
  });
  const image = { data: 'private-source-image', mediaType: 'image/png', preview: 'private' };
  act(() =>
    owner.result.current.enqueue({
      ...msg('Saved unrelated A'),
      contextBlocks: ['Exact source context'],
      images: [image],
    }),
  );
  const savedEntry = owner.result.current.queue[0];
  const sourceSnapshot = localStorage.getItem('mitzo-queue-a');
  expect(sourceSnapshot).not.toBeNull();
  expect(sourceSnapshot).not.toContain(image.data);
  const set = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === 'mitzo-queue-b') throw new DOMException('Destination quota', 'QuotaExceededError');
    set.call(this, key, value);
  });
  owner.rerender({ id: 'b', assignment: { fromSessionId: 'a', toSessionId: 'b' } });
  expect(localStorage.getItem('mitzo-queue-a')).toBe(sourceSnapshot);
  expect(localStorage.getItem('mitzo-queue-b')).toBeNull();
  expect(owner.result.current.queue).toEqual([savedEntry]);
  expect(owner.result.current.queue[0].images).toBe(savedEntry.images);
});

it('rereads fresh peer work after only the first acceptance cleanup read fails', () => {
  const owner = renderHook(() => useQueuedMessages('a'));
  let accepted!: QueuedMessage;
  act(() => {
    accepted = owner.result.current.restoreRejected(msg('Accepted A'));
  });
  const image = { data: 'private-B-image', mediaType: 'image/png', preview: 'private' };
  act(() => owner.result.current.enqueue({ ...msg('Old B'), images: [image] }));
  const b = owner.result.current.queue[1];
  const freshB = {
    text: 'Fresh B',
    contextBlocks: ['Fresh B context'],
    queueEntryId: b.queueEntryId,
  };
  localStorage.setItem('mitzo-queue-a', JSON.stringify([accepted, freshB]));
  const peer = renderHook(() => useQueuedMessages('a'));
  act(() =>
    peer.result.current.enqueue({ ...msg('New peer C'), contextBlocks: ['Exact C context'] }),
  );
  const c = peer.result.current.queue[2];
  const get = Storage.prototype.getItem;
  let failedReads = 0;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
    if (key === 'mitzo-queue-a' && failedReads++ === 0)
      throw new DOMException('Transient read failure', 'SecurityError');
    return get.call(this, key);
  });
  act(() => owner.result.current.removeSubmitted(accepted));
  expect(owner.result.current.queue).toEqual([{ ...freshB, images: b.images }, c]);
  expect(owner.result.current.queue[0].images).toBe(b.images);
  expect(JSON.parse(localStorage.getItem('mitzo-queue-a')!)).toEqual([
    freshB,
    { text: c.text, contextBlocks: c.contextBlocks, queueEntryId: c.queueEntryId },
  ]);
  expect(localStorage.getItem('mitzo-queue-a')).not.toContain(image.data);
});
