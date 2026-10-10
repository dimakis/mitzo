import { it, expect } from 'vitest';
import { CommandHistory } from './terminal-history';
it('recalls commands without running them, restores unfinished input, bounds history', () => {
  const history = new CommandHistory(['pwd', 'git status']);
  expect(history.previous('unfinished')).toBe('git status');
  expect(history.previous('ignored')).toBe('pwd');
  expect(history.previous('ignored')).toBe('pwd');
  expect(history.next()).toBe('git status');
  expect(history.next()).toBe('unfinished');
  history.add('git status');
  expect(history.entries).toEqual(['pwd', 'git status']);
  for (let i = 0; i < 200; i++) history.add(`echo ${i}`);
  expect(history.entries.length).toBe(100);
});
