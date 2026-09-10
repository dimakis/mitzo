// @vitest-environment jsdom
import { expect, it } from 'vitest';
import '../network';

it('returns an array for the desktop inbox consumer on a fresh preview load', async () => {
  const response = await window.fetch('/api/inbox');
  expect(await response.json()).toEqual([]);
});
