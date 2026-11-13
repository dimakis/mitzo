import { expect, it, vi } from 'vitest';
import {
  readCodexModels,
  refreshModels,
  cachedModels,
  ModelDiscoveryError,
} from '../model-catalog.js';
it('retains only an approved sign-in diagnostic and clears it after recovery', async () => {
  const key = 'sign-in-diagnostic';
  const diagnosticId = '566e4644-cd56-4b29-938b-586d69c850ef';
  const discover = vi
    .fn()
    .mockRejectedValue(new ModelDiscoveryError(diagnosticId, { cause: Error('private-token') }));
  await refreshModels(key, discover, true);
  expect(cachedModels(key)?.failure).toEqual({ code: 'claude_sign_in_unavailable', diagnosticId });
  expect(JSON.stringify(cachedModels(key))).not.toContain('private-token');
  discover.mockResolvedValueOnce([{ id: 'sonnet', label: 'Sonnet' }]);
  await refreshModels(key, discover, true);
  expect(cachedModels(key)?.failure).toBeUndefined();
  discover.mockRejectedValueOnce({
    code: 'claude_sign_in_unavailable',
    diagnosticId: 'private-token',
  });
  await refreshModels(key, discover, true);
  expect(cachedModels(key)?.failure).toBeUndefined();
});
it('reads every page and preserves per-model reasoning choices', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      data: [
        {
          model: 'new-model',
          displayName: 'New model',
          supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Thorough' }],
          defaultReasoningEffort: 'high',
        },
      ],
      nextCursor: 'page2',
    })
    .mockResolvedValueOnce({
      data: [
        {
          model: 'another',
          displayName: 'Another',
          supportedReasoningEfforts: [],
          defaultReasoningEffort: 'low',
        },
      ],
      nextCursor: null,
    });
  const models = await readCodexModels({ request });
  expect(models.map((m) => m.id)).toEqual(['new-model', 'another']);
  expect(models[0].reasoningEfforts).toEqual(['high']);
  expect(request).toHaveBeenLastCalledWith('model/list', {
    limit: 100,
    includeHidden: true,
    cursor: 'page2',
  });
});

it('refreshes expired catalogs, supports forced refresh, and retains the last successful result on failure', async () => {
  const key = 'cache-test';
  const discover = vi.fn().mockResolvedValue([{ id: 'one', label: 'One' }]);
  await refreshModels(key, discover);
  await refreshModels(key, discover);
  expect(discover).toHaveBeenCalledTimes(1);
  discover.mockResolvedValueOnce([{ id: 'two', label: 'Two' }]);
  await refreshModels(key, discover, true);
  expect(cachedModels(key)?.models?.[0].id).toBe('two');
  discover.mockRejectedValueOnce(new Error('offline'));
  await refreshModels(key, discover, true);
  expect(cachedModels(key)?.error).toBe(true);
  expect(cachedModels(key)?.models?.[0].id).toBe('two');
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001);
  await refreshModels(key, discover);
  expect(discover).toHaveBeenCalledTimes(4);
  now.mockRestore();
});
it('does not share model lists between accounts', async () => {
  await refreshModels('account-one', async () => [{ id: 'one', label: 'One' }]);
  expect(cachedModels('account-two')).toBeUndefined();
});
