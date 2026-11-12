import { expect, it } from 'vitest';
import { hasSkillWatcher, setSkillWatcher } from '../skill-registry-runtime.js';
import { SkillWatcher } from '../skill-watcher.js';

it('retains the active watcher guard after registry extraction', () => {
  expect(hasSkillWatcher()).toBe(false);
  const watcher = new SkillWatcher([], () => {});
  try {
    setSkillWatcher(watcher);
    expect(hasSkillWatcher()).toBe(true);
  } finally {
    watcher.destroy();
  }
});
