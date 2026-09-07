import { expect, it, vi } from 'vitest';
vi.mock('../auto-rename.js', () => ({
  generateSessionName: vi.fn(async () => 'remote name'),
  generateSessionNameFallback: vi.fn(() => 'local name'),
}));
import { generateSessionName } from '../auto-rename.js';
import { accountSessionName } from '../account-session-name.js';
it('names explicitly bound conversations locally without sending prompts to another provider', async () => {
  expect(
    await accountSessionName(['work prompt'], {
      accountId: 'work',
      accountLabel: 'Work',
      provider: 'openai',
      model: 'model',
      profileRevision: 'revision',
    }),
  ).toBe('local name');
  expect(generateSessionName).not.toHaveBeenCalled();
});
