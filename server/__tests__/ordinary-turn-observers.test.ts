import { expect, it, vi } from 'vitest';
import { createOrdinaryTurnObservers } from '../ordinary-turn-observers.js';

const observer = () => ({ beforeDispatch: vi.fn(), accepted: vi.fn(), terminal: vi.fn() });

it('retains each exact command observer through admission and removes only its terminal receipt', () => {
  const owner = createOrdinaryTurnObservers();
  const first = observer(),
    second = observer();
  owner.retain('first', first);
  owner.retain('second', second);
  owner.retain('first', first);
  expect(() => owner.retain('first', observer())).toThrow('requires recovery');
  owner.get('first')!.beforeDispatch('first');
  owner.get('second')!.accepted('second', 'thread', 'turn');
  expect(first.beforeDispatch).toHaveBeenCalledWith('first');
  expect(second.accepted).toHaveBeenCalledWith('second', 'thread', 'turn');
  owner.get('first')!.terminal('first', 'first-turn', 'completed');
  expect(first.terminal).toHaveBeenCalledWith('first', 'first-turn', 'completed');
  expect(owner.get('first')).toBeUndefined();
  expect(owner.get('second')).toBeDefined();
  owner.clear();
  expect(owner.get('second')).toBeUndefined();
});

it('forgets a rejected admission without erasing another retained command', () => {
  const owner = createOrdinaryTurnObservers();
  owner.retain('rejected', observer());
  owner.retain('accepted', observer());
  owner.forget('rejected');
  expect(owner.get('rejected')).toBeUndefined();
  expect(owner.get('accepted')).toBeDefined();
});
