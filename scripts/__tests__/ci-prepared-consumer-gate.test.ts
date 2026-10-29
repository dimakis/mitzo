import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { preparedConsumerCases } from '../ci-prepared-consumers.mjs';
import { requirePreparedConsumerEvidence } from '../ci-prepared-consumer-gate.mjs';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prepared-gate-'));
  roots.push(root);
  for (const selected of preparedConsumerCases) {
    mkdirSync(join(root, selected.name));
    writeFileSync(
      join(root, `summary-${selected.name}.json`),
      JSON.stringify([
        {
          name: selected.name,
          file: selected.file,
          cases: selected.cases.length,
          status: 'passed',
        },
      ]),
    );
    writeFileSync(
      join(root, selected.name, 'exit.json'),
      JSON.stringify({ code: 0, signal: null }),
    );
    writeFileSync(
      join(root, selected.name, 'run.json'),
      JSON.stringify({
        success: true,
        numTotalTests: selected.cases.length,
        numPassedTests: selected.cases.length,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        numFailedTestSuites: 0,
        testResults: [
          {
            name: '/repo/' + selected.file,
            status: 'passed',
            assertionResults: selected.cases.map((fullName) => ({ fullName, status: 'passed' })),
          },
        ],
      }),
    );
  }
  return root;
}
const needs = {
  changes: { result: 'success', outputs: { prepared: 'true' } },
  'prepared-consumers': { result: 'success' },
};
it('accepts only an explicit unselected skipped owner without artifacts', () => {
  expect(() =>
    requirePreparedConsumerEvidence('/missing', {
      changes: { result: 'success', outputs: { prepared: 'false' } },
      'prepared-consumers': { result: 'skipped' },
    }),
  ).not.toThrow();
});
it.each([
  {},
  { result: 'failure', outputs: { prepared: 'false' } },
  { result: 'success', outputs: {} },
])('rejects an unproven selection with a skipped owner', (changes) => {
  expect(() =>
    requirePreparedConsumerEvidence('/missing', {
      changes,
      'prepared-consumers': { result: 'skipped' },
    }),
  ).toThrow();
});
it('requires both exact actual reports, exits and group summaries', () => {
  expect(() => requirePreparedConsumerEvidence(fixture(), needs)).not.toThrow();
});
it.each([
  'missing-report',
  'missing-summary',
  'wrong-summary',
  'duplicate-summary',
  'nonzero',
  'signal',
  'interrupted',
  'failed-report',
  'wrong-case',
  'skipped-job',
])('rejects %s despite other passing evidence', (failure) => {
  const root = fixture();
  if (failure === 'missing-report') rmSync(join(root, 'publication/run.json'));
  if (failure === 'missing-summary') rmSync(join(root, 'summary-publication.json'));
  if (failure === 'wrong-summary')
    writeFileSync(
      join(root, 'summary-publication.json'),
      JSON.stringify([{ name: 'publication', status: 'passed', cases: 4 }]),
    );
  if (failure === 'duplicate-summary')
    writeFileSync(
      join(root, 'summary-publication.json'),
      JSON.stringify([
        { name: 'publication', status: 'passed' },
        { name: 'publication', status: 'passed' },
      ]),
    );
  if (['nonzero', 'signal', 'interrupted'].includes(failure))
    writeFileSync(
      join(root, 'publication/exit.json'),
      JSON.stringify({
        code: failure === 'nonzero' ? 1 : 0,
        signal: failure === 'signal' ? 'SIGTERM' : null,
        interruptedBy: failure === 'interrupted' ? 'SIGTERM' : null,
      }),
    );
  if (['failed-report', 'wrong-case'].includes(failure))
    writeFileSync(
      join(root, 'publication/run.json'),
      JSON.stringify({ success: failure !== 'failed-report', testResults: [] }),
    );
  expect(() =>
    requirePreparedConsumerEvidence(
      root,
      failure === 'skipped-job' ? { 'prepared-consumers': { result: 'skipped' } } : needs,
    ),
  ).toThrow();
});
