import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HomeStore } from '../home-store.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-home-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('shares durable names and ordered pins between device requests without changing TELOS', () => {
  const first = new HomeStore(join(root, 'home.json'));
  const other = new HomeStore(join(root, 'home.json'));
  expect(first.preferences()).toMatchObject({
    revision: 0,
    names: { briefing: 'Minion', terminal: 'Minion' },
    pins: [],
  });
  first.update(0, {
    names: { briefing: 'Jeeves', terminal: '' },
    pins: [{ kind: 'telos', id: 'goal-1', title: 'Recover Symposium' }],
  });
  expect(other.preferences()).toMatchObject({
    revision: 1,
    names: { briefing: 'Jeeves', terminal: 'Minion' },
  });
  expect(() => other.update(0, { pins: [] })).toThrow(/changed/);
  other.update(1, { pins: [] });
  expect(first.preferences().pins).toEqual([]);
  expect(first.preferences().names.briefing).toBe('Jeeves');
});

it('rejects malformed or duplicate pins and leaves saved preferences intact', () => {
  const store = new HomeStore(join(root, 'home.json'));
  store.update(0, { names: { briefing: 'Jeeves' } });
  expect(() =>
    store.update(1, {
      pins: [
        { kind: 'session', id: 'a', title: 'A' },
        { kind: 'session', id: 'a', title: 'B' },
      ],
    }),
  ).toThrow();
  expect(() => store.update(1, { names: { briefing: 'x'.repeat(81) } })).toThrow();
  expect(store.preferences().revision).toBe(1);
});

it('refuses corrupt state instead of silently resetting it', () => {
  writeFileSync(join(root, 'home.json'), '{broken');
  expect(() => new HomeStore(join(root, 'home.json')).preferences()).toThrow();
});

it('preserves earlier home files that predate briefing conversation bindings', () => {
  const path = join(root, 'home.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      revision: 7,
      names: { briefing: 'Jeeves', terminal: 'Alfred' },
      pins: [{ kind: 'telos', id: 'one', title: 'Saved task' }],
      quotes: [],
      remaining: [],
    }),
  );
  const store = new HomeStore(path);
  expect(store.briefingChats('2026-10-10', 'a'.repeat(64))).toEqual([]);
  expect(store.preferences()).toMatchObject({
    revision: 7,
    names: { briefing: 'Jeeves', terminal: 'Alfred' },
    pins: [{ id: 'one' }],
  });
  store.update(7, { names: { terminal: '' } });
  expect(store.preferences().names).toEqual({ briefing: 'Jeeves', terminal: 'Minion' });
});

it.each([
  { remaining: ['', 'quote'] },
  { remaining: ['quote', 'quote'] },
  { remaining: ['x'.repeat(101)] },
  {
    quotes: [
      {
        date: '2026-02-30',
        quote: {
          id: 'q',
          text: 'Quote',
          author: 'Author',
          work: 'Work',
          translation: 'Original',
          explanation: 'Meaning',
          example: 'Example',
          biography: 'Life',
          sourceUrl: 'https://example.org/',
          explainerUrl: 'https://example.org/',
          authorUrl: 'https://example.org/',
        },
      },
    ],
  },
])('rejects corrupt cached quote identities without resetting saved preferences: %j', (patch) => {
  const path = join(root, 'home.json');
  const original = JSON.stringify({
    version: 1,
    revision: 2,
    names: { briefing: 'Jeeves', terminal: 'Minion' },
    pins: [],
    remaining: [],
    quotes: [],
    ...patch,
  });
  writeFileSync(path, original);
  const store = new HomeStore(path);
  expect(() => store.preferences()).toThrow();
  expect(() => store.update(2, { pins: [] })).toThrow();
  expect(readFileSync(path, 'utf8')).toBe(original);
});

it('refuses a write beyond the byte limit before replacing the readable saved state', () => {
  const quote = {
    id: 'quote',
    text: '文'.repeat(2000),
    author: '文'.repeat(200),
    work: '文'.repeat(300),
    translation: '文'.repeat(200),
    explanation: '文'.repeat(5000),
    example: '文'.repeat(2000),
    biography: '文'.repeat(2000),
    sourceUrl: 'https://example.org/' + '文'.repeat(1980),
    explainerUrl: 'https://example.org/' + '文'.repeat(1980),
    authorUrl: 'https://example.org/' + '文'.repeat(1980),
  };
  const state = {
    version: 1,
    revision: 0,
    names: { briefing: 'Minion', terminal: 'Minion' },
    pins: [],
    briefingChats: [],
    quotes: Array.from({ length: 24 }, (_, i) => ({
      date: `2026-10-${String(i + 1).padStart(2, '0')}`,
      quote,
    })),
    remaining: [] as string[],
  };
  let size = Buffer.byteLength(JSON.stringify(state));
  for (let i = 0; size < 4 * 1024 * 1024 - 50000 && i < 10000; i++) {
    const id = '文'.repeat(92) + `id-${i}`;
    state.remaining.push(id);
    size += Buffer.byteLength(JSON.stringify(id)) + 1;
  }
  const path = join(root, 'home.json');
  const original = JSON.stringify(state);
  expect(Buffer.byteLength(original)).toBeLessThan(4 * 1024 * 1024);
  writeFileSync(path, original);
  const store = new HomeStore(path);
  expect(store.preferences().revision).toBe(0);
  expect(() =>
    store.update(0, {
      pins: Array.from({ length: 100 }, (_, i) => ({
        kind: 'telos',
        id: String(i),
        title: '文'.repeat(500),
      })),
    }),
  ).toThrow(/too large/);
  expect(readFileSync(path, 'utf8')).toBe(original);
  expect(store.preferences().revision).toBe(0);
});

it('retains separate briefing chats by exact report revision and selection without changing preferences', () => {
  const store = new HomeStore(join(root, 'home.json'));
  store.update(0, { names: { briefing: 'Jeeves' } });
  const binding = {
    date: '2026-10-10',
    revision: 'a'.repeat(64),
    sessionId: 'session-1',
    accountId: 'work',
    model: 'luna',
  };
  const first = store.registerBriefingChat(binding);
  expect(store.registerBriefingChat(binding)).toEqual(first);
  store.registerBriefingChat({ ...binding, sessionId: 'session-2', model: 'other-model' });
  store.registerBriefingChat({ ...binding, sessionId: 'session-3', revision: 'b'.repeat(64) });
  const reopened = new HomeStore(join(root, 'home.json'));
  expect(
    reopened.briefingChats(binding.date, binding.revision).map((item) => item.sessionId),
  ).toEqual(['session-1', 'session-2']);
  expect(reopened.preferences()).toMatchObject({ revision: 1, names: { briefing: 'Jeeves' } });
  expect(() => store.registerBriefingChat({ ...binding, date: '2026-02-30' })).toThrow();
  expect(() => store.registerBriefingChat({ ...binding, revision: '../escape' })).toThrow();
  expect(() => store.registerBriefingChat({ ...binding, accountId: 'personal' })).toThrow(
    /already/,
  );
});

it('pins a daily quote snapshot across reloads and catalogue updates and avoids immediate repeats', () => {
  const store = new HomeStore(join(root, 'home.json'));
  const entry = (id: string) => ({
    id,
    author: 'Epictetus',
    text: id,
    work: 'Enchiridion 5',
    translation: 'Elizabeth Carter',
    explanation: 'Inspect a judgement.',
    example: 'Pause before reacting.',
    biography: 'A Stoic teacher.',
    sourceUrl: 'https://classics.mit.edu/Epictetus/epicench.html',
    explainerUrl: 'https://dcc.dickinson.edu/epictetus-encheiridion/chapter-5',
    authorUrl: 'https://plato.stanford.edu/entries/epictetus/',
  });
  const catalog = [entry('a'), entry('b'), entry('c')];
  const first = store.dailyQuote('2026-10-09', catalog);
  expect(
    new HomeStore(join(root, 'home.json')).dailyQuote('2026-10-09', [entry('different')]),
  ).toEqual(first);
  const cycle = [
    first.quote.id,
    store.dailyQuote('2026-10-10', catalog).quote.id,
    store.dailyQuote('2026-10-11', catalog).quote.id,
  ];
  expect(new Set(cycle).size).toBe(3);
  expect(store.dailyQuote('2026-10-12', catalog).quote.id).not.toBe(cycle[2]);
  expect(() => store.dailyQuote('2026-02-30', catalog)).toThrow();
});

it('defaults legacy home state to showing the quote without rewriting its cache', () => {
  const path = join(root, 'home.json');
  const legacy = {
    version: 1,
    revision: 3,
    names: { briefing: 'Jeeves', terminal: 'Alfred' },
    pins: [{ kind: 'session', id: 'one', title: 'Saved' }],
    quotes: [],
    remaining: ['next'],
  };
  const original = JSON.stringify(legacy);
  writeFileSync(path, original);
  const store = new HomeStore(path);
  expect(store.preferences()).toMatchObject({ revision: 3, showDailyQuote: true });
  expect(readFileSync(path, 'utf8')).toBe(original);
  expect(store.update(3, { showDailyQuote: false })).toMatchObject({
    revision: 4,
    showDailyQuote: false,
  });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    ...legacy,
    revision: 4,
    showDailyQuote: false,
    briefingChats: [],
  });
  expect(new HomeStore(path).preferences().showDailyQuote).toBe(false);
  expect(() => store.update(3, { showDailyQuote: true })).toThrow(/changed/);
  expect(store.preferences().showDailyQuote).toBe(false);
  expect(store.update(4, { names: { briefing: 'Brew' } }).showDailyQuote).toBe(false);
});
it.each(['false', null, 0])(
  'rejects a nonboolean quote setting without changing saved state: %j',
  (showDailyQuote) => {
    const path = join(root, 'home.json');
    const store = new HomeStore(path);
    store.update(0, { names: { briefing: 'Jeeves' } });
    const original = readFileSync(path, 'utf8');
    expect(() => store.update(1, { showDailyQuote } as never)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(original);
  },
);
