import { expect, it } from 'vitest';
import { assertCompletedContainmentBindings } from '../../scripts/lib/staging-contained-archive.mjs';
import { offlineContainmentDigest as digest } from '../../scripts/lib/staging-offline-containment-contract.mjs';

function fixture() {
  const row = { launchId: 'original', state: 'retirement_uncertain' };
  const b = {
    operation: 'operation',
    nativePlanSha256: 'a'.repeat(64),
    ordinaryPlanSha256: 'b'.repeat(64),
    sourceCommit: 'c'.repeat(40),
    rowSha256: digest(row),
    manifestSha256: 'd'.repeat(64),
    archiveRoot: '/private/archive',
    backupSha256: 'e'.repeat(64),
    receiptSha256: 'f'.repeat(64),
  };
  const records = {
    intent: {
      version: 1,
      operation: b.operation,
      planSha256: b.nativePlanSha256,
      originalRowSha256: b.rowSha256,
      row,
    },
    receipt: {
      version: 1,
      operation: b.operation,
      proposalSha256: b.nativePlanSha256,
      disposition: 'contained_offline_native_cleanup_unconfirmed',
      nativeCleanupConfirmed: false,
      originalRowSha256: b.rowSha256,
      registryBackupSha256: b.backupSha256,
      archiveRoot: b.archiveRoot,
      unitManifestSha256: b.manifestSha256,
    },
    backup: {
      version: 1,
      operation: b.operation,
      planSha256: b.nativePlanSha256,
      rowSha256: b.rowSha256,
      sha256: b.backupSha256,
    },
    nativeCompleted: {
      version: 1,
      operation: b.operation,
      planSha256: b.nativePlanSha256,
      receiptSha256: b.receiptSha256,
    },
    ordinaryIntent: {
      version: 1,
      mode: 'offline-ordinary-restoration',
      operation: b.operation,
      planSha256: b.ordinaryPlanSha256,
      containmentSha256: b.receiptSha256,
      target: b.sourceCommit,
    },
    ordinaryCompleted: {
      version: 1,
      mode: 'ordinary',
      planSha256: b.ordinaryPlanSha256,
      containmentSha256: b.receiptSha256,
      sourceCommit: b.sourceCommit,
      label: 'com.mitzo.staging',
      port: 3190,
      providerProfiles: 0,
      nativeCleanupConfirmed: false,
      pid: 2345,
      birth: 'exact original ordinary birth',
    },
  };
  return { b, records };
}
it('binds completed native and ordinary metadata without minting a capability', () => {
  const { b, records } = fixture();
  expect(assertCompletedContainmentBindings(b, records)).toBeUndefined();
});
it.each([
  ['intent', 'originalRowSha256', 'changed'],
  ['receipt', 'nativeCleanupConfirmed', true],
  ['receipt', 'disposition', 'retired'],
  ['backup', 'sha256', 'changed'],
  ['nativeCompleted', 'receiptSha256', 'changed'],
  ['ordinaryIntent', 'operation', 'other'],
  ['ordinaryCompleted', 'sourceCommit', 'changed'],
  ['ordinaryCompleted', 'planSha256', 'changed'],
  ['ordinaryCompleted', 'port', 3100],
  ['ordinaryCompleted', 'pid', 0],
])('refuses mismatched completed %s.%s', (record, field, value) => {
  const { b, records } = fixture();
  records[record][field] = value;
  expect(() => assertCompletedContainmentBindings(b, records)).toThrow();
});
it('refuses changed original row, absent completion and unavailable whole-record evidence', () => {
  const { b, records } = fixture();
  records.intent.row.state = 'retired';
  expect(() => assertCompletedContainmentBindings(b, records)).toThrow();
  expect(() => assertCompletedContainmentBindings(b, {})).toThrow();
});
