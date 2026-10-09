import { expect, it, vi } from 'vitest';
import { createKnowledgeLibraryLoader } from '../knowledge-library-loader.js';

it('shares initialization and retries a transient failure without a server restart', async () => {
  const runtime = { store: 'durable owner' };
  const initialize = vi
    .fn()
    .mockRejectedValueOnce(new Error('Temporary failure'))
    .mockResolvedValue(runtime);
  const load = createKnowledgeLibraryLoader(initialize);
  const first = load();
  expect(load()).toBe(first);
  await expect(first).rejects.toThrow('Temporary failure');
  expect(initialize).toHaveBeenCalledTimes(1);
  await expect(load()).resolves.toBe(runtime);
  await expect(load()).resolves.toBe(runtime);
  expect(initialize).toHaveBeenCalledTimes(2);
});

it('turns synchronous initialization errors into retryable failures', async () => {
  const initialize = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('Private path unavailable');
    })
    .mockResolvedValue(undefined);
  const load = createKnowledgeLibraryLoader(initialize);
  await expect(load()).rejects.toThrow('Private path unavailable');
  await expect(load()).resolves.toBeUndefined();
  expect(initialize).toHaveBeenCalledTimes(2);
});
