import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';
import {
  completeNativeAuthorityReport as completeReport,
  type NativeAuthorityReport as Report,
} from './fixtures/native-authorization-report.js';

function qualify(report: Report) {
  const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const step = workflow.jobs['ordinary-journey'].steps.find(
    (candidate) => candidate.name === 'Verify signed native operator lifetime and repository tools',
  );
  const source = step?.run?.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/);
  if (!source) throw Error('Required native operator qualification is missing');
  runInNewContext(source[1].replace(/import .* from 'node:fs';\n/, ''), {
    readFileSync: () => JSON.stringify(report),
  });
}

it('accepts complete signed Mac coverage with only the retained opt-in Inspect diagnostic skipped', () => {
  const report = completeReport();
  report.testResults[2].assertionResults.push({
    fullName: 'source-mode signed Inspect positive diagnostic',
    status: 'pending',
  });
  expect(() => qualify(report)).not.toThrow();
});

it.each([5, 7])(
  'refuses an earlier %i-case report that omits required lifetime regressions',
  (count) => {
    const report = completeReport();
    report.testResults[0].assertionResults.splice(count);
    expect(() => qualify(report)).toThrow();
  },
);

it.each([
  [
    'missing native reader suite',
    (r: Report): void => {
      r.testResults.splice(3, 1);
    },
  ],
  [
    'missing materializer suite',
    (r: Report): void => {
      r.testResults.pop();
    },
  ],
  [
    'skipped materializer case',
    (r: Report): void => {
      r.testResults[4].assertionResults[0].status = 'pending';
    },
  ],
  [
    'failed materializer case',
    (r: Report): void => {
      r.testResults[4].assertionResults[0].status = 'failed';
    },
  ],
  [
    'skipped native reader case',
    (r: Report): void => {
      r.testResults[3].assertionResults[0].status = 'pending';
    },
  ],
  [
    'missing lifetime case',
    (r: Report): void => {
      r.testResults[0].assertionResults.pop();
    },
  ],
  [
    'skipped lifetime suite',
    (r: Report): void => {
      r.testResults[0].assertionResults.forEach((a) => {
        a.status = 'pending';
      });
    },
  ],
  [
    'failed preparation',
    (r: Report): void => {
      r.testResults[1].assertionResults[0].status = 'failed';
    },
  ],
  [
    'skipped required read',
    (r: Report): void => {
      r.testResults[2].assertionResults[0].status = 'pending';
    },
  ],
] as const)('refuses %s even when the enclosing report claims success', (_name, change) => {
  const report = completeReport();
  change(report);
  expect(() => qualify(report)).toThrow();
});
