import { expect, it } from 'vitest';
import { canonicalStagingRoot } from '../symposium-staging-identity.js';
import { resolveStagingRecordInputs } from '../symposium-staging-registry.js';
import { CONTAINED_NATIVE_INCIDENT } from '../staging-contained-native-disposition.js';
const operation = '33333333-3333-4333-8333-333333333333';
it('resolves disposed historical inputs only to the exact quarantine archive and never to new live descendants', () => {
  const root = canonicalStagingRoot(),
    row = {
      ...CONTAINED_NATIVE_INCIDENT,
      state: 'retirement_uncertain' as const,
      planDirectory: root + '/symposium/service',
    };
  const history = {
    recordJson: JSON.stringify(row),
    classification: 'contained_offline_native_cleanup_unconfirmed',
    archive: root + '-quarantine/' + operation,
    operationId: operation,
    receiptSha256: 'a'.repeat(64),
  };
  expect(resolveStagingRecordInputs(row, history)).toEqual({
    kind: 'archived_evidence',
    planDirectory: history.archive + '/symposium/service',
    nativeAuthority: false,
  });
  expect(() => resolveStagingRecordInputs(row)).toThrow();
  expect(() =>
    resolveStagingRecordInputs(row, {
      ...history,
      archive: root + '/symposium/allocations/' + operation,
    }),
  ).toThrow();
});
