import { expect, it } from 'vitest';
import { previewSessionState } from '../session-state';

it('clears the previous workspace and account metadata when starting a new preview chat', () => {
  const selected = previewSessionState('preview-1');
  expect(selected.isWorktree).toBe(true);
  expect(selected.messages.length).toBeGreaterThan(0);
  const fresh = { ...selected, ...previewSessionState(null) };
  expect(fresh.messages).toEqual([]);
  expect(fresh.branch).toBeNull();
  expect(fresh.wtId).toBeNull();
  expect(fresh.isWorktree).toBe(false);
  expect(fresh.accountBinding).toBeNull();
});
