import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  }),
}));
import { AccountAliases } from '../account-aliases.js';
it('handles an alias file disappearing before the read', () => {
  expect(new AccountAliases('/missing').label('work', 'Work')).toBe('Work');
});
