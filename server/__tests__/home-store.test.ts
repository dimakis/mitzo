import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
