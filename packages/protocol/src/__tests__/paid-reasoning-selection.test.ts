import { expect, it } from 'vitest';
import { PaidReasoningPhaseSelectionsSchema } from '../paid-reasoning-selection.js';
const phase = {
  role: 'proposer',
  binding: {
    version: 2,
    account: { accountId: 'work', provider: 'openai', profileRevision: 'pinned' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'target-v1' },
  },
  model: 'selected-model',
  thinking: null,
  outputPolicy: { kind: 'native-default', acknowledgeProviderDefaults: true },
};
it('preserves explicitly reviewed separate roles even when their models match', () => {
  const selection = [
    phase,
    {
      ...phase,
      role: 'challenger',
      binding: { ...phase.binding, account: { ...phase.binding.account, accountId: 'other' } },
    },
  ];
  expect(PaidReasoningPhaseSelectionsSchema.parse(selection)).toEqual(selection);
});
it('rejects duplicate roles, missing output policy acknowledgement, credentials and obsolete harness substitution', () => {
  const second = { ...phase, role: 'challenger' };
  for (const selection of [
    [phase, phase],
    [{ ...phase, outputPolicy: { kind: 'native-default' } }, second],
    [{ ...phase, apiKey: 'Never accepted in phase selection' }, second],
    [{ ...phase, binding: { ...phase.binding, harness: { implementation: 'responses' } } }, second],
  ]) {
    expect(PaidReasoningPhaseSelectionsSchema.safeParse(selection).success).toBe(false);
  }
});
