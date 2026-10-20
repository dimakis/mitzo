// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  parseItemHistory,
  readTelosItemHistory,
  readTelosHomeReturn,
  telosHomeItemState,
} from '../telos-item-navigation';

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
