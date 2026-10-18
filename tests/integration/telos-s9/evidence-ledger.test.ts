import { expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

it('keeps all 44 approved rows traceable without upgrading partial, red, planned or unauthorised evidence into acceptance', () => {
  const ledger = read('docs/evidence/telos-s9/requirements-evidence.json');
  const matrix = read('docs/evidence/telos-s9/approved-corrective-contracts.json');
  expect(ledger.ux.map((row: { id: string }) => row.id)).toEqual(
    Array.from({ length: 24 }, (_, index) => `UX${String(index + 1).padStart(2, '0')}`),
  );
  expect(ledger.corrective.map((row: { id: string }) => row.id)).toEqual(
    matrix.tests.map((row: { id: string }) => row.id),
  );
  for (const row of ledger.corrective) {
    const approved = matrix.tests.find((candidate: { id: string }) => candidate.id === row.id);
    expect(row.owner).toBe(approved.owner);
    expect(row.assertions).toBe(approved.assertions);
  }
  for (const row of [...ledger.ux, ...ledger.corrective]) {
    expect(row.source.commit).toBe(ledger.acceptedMain);
    expect(row.approvedReference.mock).toEqual(ledger.approvedMock);
    expect(row.outstandingException.length).toBeGreaterThan(20);
    if (row.states.uxAccepted === 'verified') {
      expect(row.visualEvidence.desktop).toBeTruthy();
      expect(row.visualEvidence.mobile).toBeTruthy();
    }
    if (row.states.offlineIntegration === 'verified') {
      expect(row.tests.length).toBeGreaterThan(0);
      expect(
        row.tests.every((test: { result: string }) => test.result === 'passed_complete_contract'),
      ).toBe(true);
    }
    if (row.states.liveRuntimeQualified === 'verified')
      expect(ledger.authorizedLiveWindow).toBeTruthy();
    for (const test of row.tests) expect(existsSync(resolve(root, test.file))).toBe(true);
  }
  if (!ledger.authorizedLiveWindow) {
    expect(ledger.parentStatus).toBe('active');
    expect(ledger.sliceStatus).toBe('active');
    expect(
      ledger.corrective.find((row: { id: string }) => row.id === 'CT19').states
        .liveRuntimeQualified,
    ).toBe('pending');
  }
  const baseline = read('docs/design/telos-workspaces/acceptance-coverage.json');
  expect(baseline.every((row: { status: string }) => row.status === 'planned')).toBe(true);
});
