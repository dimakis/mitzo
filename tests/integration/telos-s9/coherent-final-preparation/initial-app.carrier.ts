import { it } from 'vitest';
import { coherentJourney } from './coherent-journey.js';
// Internal process carrier for one outer acceptance case. It is not a third CT
// row or separate campaign. The outer runner waits for the whole OS process to
// exit, then reconstructs the original files in the cold App process.
it('S9 internal single-App composition carrier', async () => {
  const kind = process.env.S9_COHERENT_KIND,
    path = process.env.S9_COHERENT_HANDOFF;
  if ((kind !== 'repository' && kind !== 'non-git') || !path)
    throw Error('Explicit private carrier selection required');
  await coherentJourney(kind, path);
}, 70_000);
