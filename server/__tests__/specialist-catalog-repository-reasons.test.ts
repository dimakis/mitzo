import { expect, it } from 'vitest';
import { repositorySourceRefusals } from '../specialist-consultations.js';

/** The catalog is consumed as a JSON tool result, so the refusal entry keeps a
 * stable harness/code pair and adds only the account it belongs to. */
it('names an account with no repository source and leaves assigned accounts out', () => {
  expect(
    repositorySourceRefusals([
      {
        harness: 'claude-sdk',
        accountId: 'claude-account',
        inventory: { available: true, repositories: [], reason: 'repository_scope_not_assigned' },
      },
      // The same account can appear on more than one ask route; one refusal is enough.
      {
        harness: 'claude-sdk',
        accountId: 'claude-account',
        inventory: { available: true, repositories: [], reason: 'repository_scope_not_assigned' },
      },
      {
        harness: 'codex',
        accountId: 'codex-account',
        inventory: {
          available: true,
          repositories: [{ connectionId: 'github', label: 'GitHub', repository: 'dimakis/mitzo' }],
        },
      },
    ]),
  ).toEqual([
    {
      harness: 'claude-sdk',
      accountId: 'claude-account',
      code: 'repository_scope_not_assigned',
    },
  ]);
  expect(JSON.parse(JSON.stringify(repositorySourceRefusals([])))).toEqual([]);
});
