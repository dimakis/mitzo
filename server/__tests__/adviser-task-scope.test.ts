import { expect, it, vi } from 'vitest';
import { AdviserTaskScope } from '../adviser-task-scope.js';

const input = () => ({
  authSessionId: 'operator',
  feature: { kind: 'terminal' as const, terminalId: 'terminal' },
  accountId: 'work',
  model: 'gpt-6-luna',
  reasoningEffort: 'low',
  instructions: 'Explain the reviewed text.',
  messages: [{ role: 'user' as const, content: 'Reviewed only' }],
});
it('freezes the complete reviewed snapshot and binds exact account, model and feature', () => {
  const raw = input();
  const current = vi.fn();
  const scope = new AdviserTaskScope(raw, current, new AbortController().signal);
  raw.messages[0].content = 'mutated';
  expect(scope.prompt()).toContain('Reviewed only');
  expect(scope.prompt()).not.toContain('mutated');
  expect(scope.instructions()).toBe(raw.instructions);
  scope.assertSelection({ accountId: 'work', model: 'gpt-6-luna' }, 'low');
  expect(() => scope.assertSelection({ accountId: 'other', model: 'gpt-6-luna' }, 'low')).toThrow();
  expect(() => scope.assertSelection({ accountId: 'work', model: 'other' }, 'low')).toThrow();
  expect(() => scope.assertSelection({ accountId: 'work', model: 'gpt-6-luna' }, 'high')).toThrow();
  expect(current).toHaveBeenCalled();
});
it('suppresses cancelled and revoked output and refuses oversized context', () => {
  const controller = new AbortController();
  const current = vi.fn();
  const scope = new AdviserTaskScope(input(), current, controller.signal);
  current.mockImplementation(() => {
    throw Error('revoked');
  });
  expect(() => scope.assertCurrent()).toThrow('revoked');
  controller.abort();
  expect(() => scope.assertCurrent()).toThrow();
  expect(
    () =>
      new AdviserTaskScope(
        {
          ...input(),
          messages: Array.from({ length: 13 }, () => ({ role: 'user' as const, content: 'x' })),
        },
        () => {},
        new AbortController().signal,
      ),
  ).toThrow();
});
it('bounds accumulated text and requires a nonempty successful response', () => {
  const scope = new AdviserTaskScope(input(), () => {}, new AbortController().signal);
  expect(() => scope.result('')).toThrow();
  expect(() => scope.result('x'.repeat(32769))).toThrow();
  expect(scope.result('Advice')).toEqual({ text: 'Advice' });
});
