import { expect, it } from 'vitest';
import { multiRuntimeInventoryFixture } from '../../test-utils/multi-runtime-inventory-fixture';
import { createChatRuntimeSelection } from '../chat-runtime-selection';
import {
  resolveRuntimeTarget,
  runtimeModelAccounts,
  selectedRuntimeRoute,
} from '../chat-runtime-route';
it('rejects mismatched target harness and ambiguous account routes rather than choosing first', () => {
  const data = multiRuntimeInventoryFixture();
  const intent = {
    ...createChatRuntimeSelection(),
    account: { accountId: 'api', model: 'local-model', reasoningEffort: null },
    accountReference: data.accounts[1].account,
    execution: { location: 'local' as const, targetId: 'responses' },
  };
  expect(selectedRuntimeRoute(intent, data)?.harness).toBe('responses');
  expect(
    runtimeModelAccounts(intent, data)
      .find((account) => account.id === 'api')
      ?.models.map((model) => model.id),
  ).toEqual(['local-model']);
  const mismatch = {
    ...data,
    targets: data.targets.map((target) =>
      target.targetId === 'responses' ? { ...target, harness: 'codex' as const } : target,
    ),
  };
  expect(selectedRuntimeRoute(intent, mismatch)).toBeUndefined();
  expect(resolveRuntimeTarget(intent, mismatch)).toBeNull();
  const ambiguous = { ...data, routes: [...data.routes, data.routes[2]] };
  expect(resolveRuntimeTarget(intent, ambiguous)).toBeNull();
  expect(selectedRuntimeRoute(intent, ambiguous)).toBeUndefined();
  const drift = {
    ...intent,
    accountReference: { ...intent.accountReference, profileRevision: 'old' },
  };
  expect(resolveRuntimeTarget(drift, data)).toBeNull();
  expect(runtimeModelAccounts(drift, data).find((account) => account.id === 'api')?.models).toEqual(
    [],
  );
});
