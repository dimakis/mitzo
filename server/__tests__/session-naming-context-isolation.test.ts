import { expect, it, vi } from 'vitest';

// Restart children disable the model naming adapter with this minimal surface.
// Local title projection must still load and operate without that adapter.
vi.mock('../auto-rename.js', () => ({
  shouldAutoRename: () => false,
  generateSessionName: () => {
    throw Error('Model naming disabled');
  },
}));

import { sessionDisplayName } from '../session-naming-context.js';

it('projects local task names when the model naming adapter is disabled', () => {
  expect(
    sessionDisplayName(
      { sessionId: 's', summary: 'Merge it', initialPrompt: 'Fix calendar sync' },
      [],
    ),
  ).toBe('Fix calendar sync');
});
