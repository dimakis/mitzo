import { expect, it } from 'vitest';
import { parseLoginRecoveryArguments } from '../reauthorize-host-codex-login.js';

it('selects read-only discovery separately from the exact reviewed apply file', () => {
  const source = ['--database', '/offline/native.db', '--profiles', '/offline/accounts.json'];
  expect(
    parseLoginRecoveryArguments([...source, '--all-legacy', '--plan-file', '/offline/review.json']),
  ).toMatchObject({ allLegacy: true, conversations: [], planFile: '/offline/review.json' });
  expect(
    parseLoginRecoveryArguments([...source, '--apply-plan', '/offline/review.json']),
  ).toMatchObject({ allLegacy: false, conversations: [], applyPlan: '/offline/review.json' });
  for (const suffix of [
    ['--all-legacy', '--apply-plan', '/offline/review.json'],
    ['--all-legacy', '--conversation', 'old-chat'],
    ['--conversation', 'old-chat', '--conversation', 'old-chat'],
    ['--plan-file', 'relative.json'],
    ['--unknown', 'value'],
    ['--all-legacy', '--all-legacy'],
  ])
    expect(() => parseLoginRecoveryArguments([...source, ...suffix])).toThrow();
});
