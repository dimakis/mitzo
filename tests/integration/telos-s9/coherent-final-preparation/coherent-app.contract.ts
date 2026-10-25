import { it } from 'vitest';
import { executeCoherentCase } from './execute-case.js';

// Explicit runner selects these two concrete App compositions. No runIf/skip,
// guessed future contract or isolated-router authority stands in for acceptance.
it('S9 CT06: real repository App composition from reviewed origin through canonical completion', async () => {
  await executeCoherentCase('repository');
}, 120_000);

it('S9 CT09: real non-Git App composition from reviewed origin through canonical completion', async () => {
  await executeCoherentCase('non-git');
}, 120_000);
