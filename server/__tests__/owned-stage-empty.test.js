import { it, expect } from 'vitest';
import { assertInitialStagingFacts } from '../../scripts/lib/owned-stage-empty.mjs';
const row = { id: 'personal', label: 'Personal', revision: 1, state: 'disconnected' };
it('admits only zero conversation/events/tasks and parsed fully disconnected slots', () =>
  expect(() => assertInitialStagingFacts([0, 0, 0, 0, 0, 0], [0], [row])).not.toThrow());
it.each([0, 1, 2, 3, 4, 5])(
  'existing event/session/seat state at %s prevents fresh replacement',
  (index) => {
    const counts = [0, 0, 0, 0, 0, 0];
    counts[index] = 1;
    expect(() => assertInitialStagingFacts(counts, [0], [row])).toThrow();
  },
);
it.each([
  'connecting',
  'connected',
  'reauth_required',
  'disconnecting',
  'recovery_required',
  'unknown',
])('refuses %s state before retirement', (state) =>
  expect(() => assertInitialStagingFacts([0, 0, 0, 0, 0, 0], [0], [{ ...row, state }])).toThrow(),
);
it('rejects discovery, identity metadata, malformed and duplicate disconnected rows', () => {
  for (const rows of [
    [{ ...row, modelDiscovery: 'pending' }],
    [{ ...row, account: { email: 'prior@example.invalid', planType: 'pro' } }],
    [row, row],
    [{ ...row, revision: 0 }],
    {},
    [{ ...row, extra: 'ignored' }],
  ])
    expect(() => assertInitialStagingFacts([0, 0, 0, 0, 0, 0], [0], rows)).toThrow();
});
