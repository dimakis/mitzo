// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { ListCache, SupersededListRequest } from '../list-cache';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../api-fetch';

it('publishes snapshots by key and stops notifying after unsubscribe', async () => {
  const cache = new ListCache<string>();
  const seen: (string | undefined)[] = [];
  const other = vi.fn();
  const unsubscribe = cache.subscribe('all', () => seen.push(cache.get('all')));
  cache.subscribe('profile', other);
  cache.set('all', 'first');
  cache.update((value) => `${value} updated`);
  expect(seen).toEqual(['first', 'first updated']);
  expect(other).not.toHaveBeenCalled();
  cache.clear();
  expect(seen).toEqual(['first', 'first updated', undefined]);
  expect(other).toHaveBeenCalledOnce();
  await cache.load('all', async () => 'loaded');
  expect(seen.at(-1)).toBe('loaded');
  unsubscribe();
  cache.set('all', 'later');
  expect(seen).toHaveLength(4);
});

it('shares concurrent reads, retains a snapshot, and revalidates later reads', async () => {
  const cache = new ListCache<string>();
  let finish!: (value: string) => void;
  const loader = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const first = cache.load('all', loader);
  const second = cache.load('all', loader);
  expect(loader).toHaveBeenCalledOnce();
  finish('old');
  expect(await first).toBe('old');
  expect(await second).toBe('old');
  expect(cache.get('all')).toBe('old');
  expect(await cache.load('all', async () => 'new')).toBe('new');
  expect(cache.get('all')).toBe('new');
});

it.each([AUTH_LOST_EVENT, AUTH_RESTORED_EVENT])(
  'clears snapshots and fences old reads on %s',
  async (event) => {
    const cache = new ListCache<string>();
    cache.set('other', 'private');
    const snapshots: (string | undefined)[] = [];
    cache.subscribe('other', () => snapshots.push(cache.get('other')));
    let finish!: (value: string) => void;
    const stale = cache.load(
      'all',
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const rejected = expect(stale).rejects.toBeInstanceOf(SupersededListRequest);
    window.dispatchEvent(new Event(event));
    expect(cache.get('other')).toBeUndefined();
    expect(snapshots).toEqual([undefined]);
    expect(await cache.load('all', async () => 'new-account')).toBe('new-account');
    finish('old-account');
    await rejected;
    expect(cache.get('all')).toBe('new-account');
  },
);

it('keeps successful data when a refresh fails', async () => {
  const cache = new ListCache<string>();
  cache.set('all', 'last successful');
  await expect(
    cache.load('all', async () => {
      throw new Error('offline');
    }),
  ).rejects.toThrow('offline');
  expect(cache.get('all')).toBe('last successful');
});

it('updates retained snapshots after a mutation and rejects older reads', async () => {
  const cache = new ListCache<string[]>();
  cache.set('all', ['deleted', 'retained']);
  cache.set('profile', ['deleted']);
  let finish!: (value: string[]) => void;
  const stale = cache.load(
    'all',
    () =>
      new Promise<string[]>((resolve) => {
        finish = resolve;
      }),
  );
  const rejected = expect(stale).rejects.toBeInstanceOf(SupersededListRequest);
  cache.update((items) => items.filter((item) => item !== 'deleted'));
  expect(cache.get('all')).toEqual(['retained']);
  expect(cache.get('profile')).toEqual([]);
  finish(['deleted']);
  await rejected;
  expect(cache.get('all')).toEqual(['retained']);
});
