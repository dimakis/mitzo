import { afterEach, expect, it, vi } from 'vitest';
import { deliberateRouteRevision } from '../deliberate-route.js';
afterEach(() => vi.unstubAllEnvs());
it('fingerprints explicit selected account/model/target data without ambient host credential inheritance', () => {
  const selection = {
    accountId: 'work',
    profileRevision: 'pinned',
    model: 'chosen',
    targetId: 'mac',
  };
  const original = deliberateRouteRevision(selection);
  vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-host-credential-never-read');
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/unselected/private/credential.json');
  expect(deliberateRouteRevision(selection)).toBe(original);
  for (const change of [
    { accountId: 'other' },
    { profileRevision: 'new' },
    { model: 'new-model' },
    { targetId: 'other-host' },
  ])
    expect(deliberateRouteRevision({ ...selection, ...change })).not.toBe(original);
  expect(original).not.toContain('work');
});
