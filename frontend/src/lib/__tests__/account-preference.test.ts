// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  getDefaultAccountModel,
  getDefaultAccountReference,
  setDefaultAccountModel,
} from '../account-preference';
afterEach(() => localStorage.clear());
const selection = { accountId: 'work', model: 'luna-fixture', reasoningEffort: 'low' };
const reference = { accountId: 'work', provider: 'openai' as const, profileRevision: 'r1' };
it('saves the exact public account identity without adding runtime fields to model selection', () => {
  setDefaultAccountModel(selection, reference);
  expect(getDefaultAccountModel()).toEqual(selection);
  expect(getDefaultAccountReference()).toEqual(reference);
  setDefaultAccountModel({ ...selection, model: 'another-fixture' });
  expect(getDefaultAccountReference()).toEqual(reference);
  setDefaultAccountModel({ ...selection, accountId: 'other' });
  expect(getDefaultAccountReference()).toBeNull();
});
it('does not accept mismatched or malformed public account references', () => {
  localStorage.setItem(
    'mitzo-default-account-model',
    JSON.stringify({ ...selection, accountReference: { ...reference, accountId: 'other' } }),
  );
  expect(getDefaultAccountReference()).toBeNull();
  localStorage.setItem(
    'mitzo-default-account-model',
    JSON.stringify({
      ...selection,
      accountReference: { ...reference, credential: 'never-a-public-field' },
    }),
  );
  expect(getDefaultAccountReference()).toBeNull();
});
