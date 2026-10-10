import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';

vi.mock('../../components/OutputContributorPanel', () => {
  throw new Error('output rendering must not load when importing contributor state');
});

it('owns output contributor contracts outside the rendering dependency', async () => {
  const source = await readFile(new URL('../useOutputContributors.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/from ['"]\.\.\/components\//);
  const hook = await import('../useOutputContributors');
  expect(hook.useOutputContributors).toBeTypeOf('function');
});
