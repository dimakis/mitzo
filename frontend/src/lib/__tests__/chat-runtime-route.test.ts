import { expect, it } from 'vitest';
import { multiRuntimeInventoryFixture } from '../../test-utils/multi-runtime-inventory-fixture';
import { createChatRuntimeSelection } from '../chat-runtime-selection';
import {
  resolveRuntimeTarget,
  runtimeModelAccounts,
  selectedRuntimeRoute,
} from '../chat-runtime-route';
it('chooses local Codex for a fresh API chat while retaining the Responses target of saved history', () => {
  const data = multiRuntimeInventoryFixture();
  const api = data.accounts.find((entry) => entry.account.accountId === 'api')!;
  data.targets.push({
    targetId: 'api-codex',
    targetRevision: 'native-r1',
    location: 'local',
    harness: 'codex',
    label: 'Local Codex',
  });
  data.routes.push({
    account: api.account,
    targetId: 'api-codex',
    harness: 'codex',
    modes: ['agent'],
    models: [{ id: 'native-model', label: 'Native model' }],
  });
  const fresh = {
    ...createChatRuntimeSelection(),
    account: { accountId: 'api', model: 'native-model' },
    accountReference: api.account,
    execution: { location: 'local' as const, targetId: null },
  };
  expect(resolveRuntimeTarget(fresh, data)).toBe('api-codex');
  expect(
    selectedRuntimeRoute(
      { ...fresh, execution: { location: 'local', targetId: 'responses' } },
      data,
    )?.harness,
  ).toBe('responses');
  const anotherAccount = { ...fresh, account: { accountId: 'personal', model: 'luna-fixture' } };
  expect(
    runtimeModelAccounts(anotherAccount, data)
      .find((entry) => entry.id === 'api')
      ?.models.map((model) => model.id),
  ).toEqual(['native-model']);
  data.targets.push({ ...data.targets.at(-1)!, targetId: 'ambiguous-native' });
  data.routes.push({ ...data.routes.at(-1)!, targetId: 'ambiguous-native' });
  expect(resolveRuntimeTarget(fresh, data)).toBeNull();
});
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

it('rejects an unlocated route shared across environments while explicit location disambiguates', () => {
  const data = multiRuntimeInventoryFixture();
  const route = data.routes.find((entry) => entry.targetId === 'responses')!;
  const target = data.targets.find((entry) => entry.targetId === 'responses')!;
  data.targets.push({ ...target, location: 'openshell' });
  const intent = {
    ...createChatRuntimeSelection(),
    account: { accountId: 'api', model: 'local-model', reasoningEffort: 'high' },
    accountReference: route.account,
    execution: { location: 'local' as const, targetId: 'responses' },
  };
  route.location = undefined;
  expect(selectedRuntimeRoute(intent, data)).toBeUndefined();
  expect(resolveRuntimeTarget(intent, data)).toBeNull();
  expect(runtimeModelAccounts(intent, data).find((entry) => entry.id === 'api')?.models).toEqual(
    [],
  );
  route.location = 'local';
  expect(selectedRuntimeRoute(intent, data)?.harness).toBe('responses');
  expect(resolveRuntimeTarget(intent, data)).toBe('responses');
  expect(intent.account).toEqual({
    accountId: 'api',
    model: 'local-model',
    reasoningEffort: 'high',
  });
});
