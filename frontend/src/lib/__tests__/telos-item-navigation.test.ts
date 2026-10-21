// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  parseItemHistory,
  readTelosItemHistory,
  readTelosHomeReturn,
  telosHomeItemState,
  appendTelosItemHistory,
  popTelosItemHistory,
} from '../telos-item-navigation';
import type { TodoItem } from '../../types/todo';

afterEach(() => sessionStorage.clear());
it('retains Home location and opaque state while explicitly starting a fresh item trail', () => {
  const state = { homeTab: 'home', scrollTop: 88, filesReturnState: { path: '/files?a=1' } };
  const entry = telosHomeItemState({
    pathname: '/',
    search: '?section=pins',
    hash: '#work',
    state,
  });
  expect(entry.telosHistory).toEqual([]);
  expect(readTelosHomeReturn(entry)).toEqual({ path: '/?section=pins#work', state });
  expect(state).toEqual({
    homeTab: 'home',
    scrollTop: 88,
    filesReturnState: { path: '/files?a=1' },
  });
});

function snapshot(id: string, priority = 4): TodoItem {
  return {
    id,
    priority,
    summary: id,
    profile: 'manual',
    urgency: 0,
    starred: false,
    status: 'active',
    ageDays: 0,
    parentId: null,
    children: [],
    childCount: 0,
    completedChildCount: 0,
    sources: [],
    goalId: null,
    contextHints: {
      repos: [],
      paths: [],
      issues: [],
      docIds: [],
      people: [],
      jiraKeys: [],
      keywords: [],
      taskHint: '',
    },
  };
}

it('retains snapshots by explicit trail position, including repeated IDs and opaque return context', () => {
  const original = {
    filesReturnState: { unchanged: true },
    telosItemReturn: { path: '/?pins=1', state: { scrollTop: 40 } },
  };
  const first = appendTelosItemHistory(original, [], 'parent', snapshot('parent'));
  const second = appendTelosItemHistory(first, first.telosHistory, 'parent', snapshot('parent', 8));
  const popped = popTelosItemHistory(second, second.telosHistory);
  expect(popped.item).toEqual(snapshot('parent', 8));
  expect(popped.telosHistory).toEqual(['parent']);
  expect(popTelosItemHistory(popped, ['parent'])).toEqual({
    ...original,
    item: snapshot('parent'),
    telosHistory: [],
  });
  expect(original).toEqual({
    filesReturnState: { unchanged: true },
    telosItemReturn: { path: '/?pins=1', state: { scrollTop: 40 } },
  });
});

it('keeps legacy ID-only trail slots through serialization without substituting the current child', () => {
  const child = snapshot('child');
  const next = appendTelosItemHistory(
    { item: child },
    ['legacy/parent'],
    'current-parent',
    snapshot('current-parent'),
  );
  const retained = JSON.parse(JSON.stringify(next));
  const back = popTelosItemHistory(retained, ['legacy/parent', 'current-parent']);
  expect(back.item).toEqual(snapshot('current-parent'));
  expect(back.telosHistory).toEqual(['legacy/parent']);
  expect(popTelosItemHistory(back, ['legacy/parent']).item).toBeUndefined();
});

it.each([
  { snapshots: [snapshot('child')] },
  { snapshots: [snapshot('stale-other-item')] },
  { snapshots: { parent: snapshot('parent') } },
  { snapshots: null },
])(
  'rejects malformed or wrong-ID parent snapshots instead of reusing child state (%j)',
  ({ snapshots: telosHistorySnapshots }) => {
    const state = {
      item: snapshot('child'),
      telosHistorySnapshots,
      filesReturnState: { retained: true },
    };
    const back = popTelosItemHistory(state, ['parent']);
    expect(back.item).toBeUndefined();
    expect(back.telosHistory).toEqual([]);
    expect(back).not.toHaveProperty('telosHistorySnapshots');
    expect(back.filesReturnState).toEqual({ retained: true });
  },
);

it('does not retain a snapshot supplied for another current item ID', () => {
  const next = appendTelosItemHistory(null, [], 'parent', snapshot('child'));
  expect(next.telosHistory).toEqual(['parent']);
  expect(popTelosItemHistory(next, next.telosHistory).item).toBeUndefined();
});
it('returns Home without requiring state and normalizes non-object state to null', () => {
  for (const state of [null, undefined, [], 'untrusted', 42]) {
    const entry = telosHomeItemState({ pathname: '/', search: '', hash: '', state });
    expect(readTelosHomeReturn(entry)).toEqual({ path: '/', state: null });
  }
});
it('does not infer Home return intent from absent or malformed route state', () => {
  for (const state of [
    null,
    undefined,
    [],
    'bad',
    {},
    { telosItemReturn: [] },
    { telosItemReturn: { path: 1 } },
  ])
    expect(readTelosHomeReturn(state)).toBeNull();
});
it('validates Home-only canonical paths without decoding query/hash content into a destination', () => {
  const path = '/?q=https%3A%2F%2Foutside.invalid%2F#%2Fchat%2Fother';
  expect(readTelosHomeReturn({ telosItemReturn: { path } })).toEqual({ path, state: null });
  for (const path of [
    'https://mitzo.invalid/',
    '//mitzo.invalid/',
    '/\\mitzo.invalid/',
    'javascript:alert(1)',
    '/todos/a',
    '/chat/a',
    '/other/..',
    '/%2f%2foutside.invalid',
    '/\n',
    '/?q=a\tb',
    '/#a\nb',
  ])
    expect(readTelosHomeReturn({ telosItemReturn: { path, state: {} } })).toBeNull();
});
it('preserves item-keyed history storage and explicit route-trail precedence', () => {
  sessionStorage.setItem('telos.item.history.one', JSON.stringify(['parent-one']));
  sessionStorage.setItem('telos.item.history.two', JSON.stringify(['parent-two']));
  expect(readTelosItemHistory('one', undefined)).toEqual(['parent-one']);
  expect(readTelosItemHistory('two', undefined)).toEqual(['parent-two']);
  expect(readTelosItemHistory('one', [])).toEqual([]);
  expect(readTelosItemHistory('one', ['current-parent'])).toEqual(['current-parent']);
  expect(readTelosItemHistory('one', ['bad', 1])).toEqual([]);
  expect(parseItemHistory(null)).toEqual([]);
  sessionStorage.setItem('telos.item.history.one', 'malformed');
  expect(readTelosItemHistory('one', undefined)).toEqual([]);
  expect(readTelosItemHistory('two', undefined)).toEqual(['parent-two']);
});
