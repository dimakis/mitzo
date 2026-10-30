import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { preparedConsumerCases } from '../ci-prepared-consumers.mjs';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../ci-unit-gate.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-unit-gate-'));
  roots.push(root);
  const files = [1, 2, 3, 4].map((shard) => ({ file: `/checkout/test-${shard}.test.ts` }));
  const transferred = preparedConsumerCases.map((c) => ({ file: '/checkout/' + c.file }));
  const reports = files.map(({ file }) => ({
    success: true,
    numPassedTests: 100,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    testResults: [{ name: file, status: 'passed' }],
  }));
  const needs: Record<string, { result: string }> = {
    core: { result: 'success' },
    unit: { result: 'success' },
  };
  function write() {
    reports.forEach((report, index) => {
      writeFileSync(join(root, `report-${index + 1}.json`), JSON.stringify(report));
      writeFileSync(
        join(root, `files-${index + 1}.json`),
        JSON.stringify([...files, ...transferred]),
      );
    });
  }
  function run() {
    return spawnSync(process.execPath, [script, root], {
      encoding: 'utf8',
      env: { ...process.env, CI_CORE_NEEDS: JSON.stringify(needs) },
    });
  }
  write();
  return { root, files, reports, needs, write, run, transferred };
}

describe('required core CI gate', () => {
  it('accepts all four successful shards and reports the combined count', () => {
    const result = fixture().run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('400 passed tests across 4 files');
  });

  it.each(['failure', 'cancelled', 'skipped', ''])('rejects job result %j', (result) => {
    for (const job of ['core', 'unit']) {
      const f = fixture();
      f.needs[job].result = result;
      expect(f.run().status).toBe(1);
    }
  });

  it('rejects a missing job or missing shard even if the matrix reports success', () => {
    const f = fixture();
    delete f.needs.unit;
    expect(f.run().status).toBe(1);
    f.needs.unit = { result: 'success' };
    rmSync(join(f.root, 'report-4.json'));
    expect(f.run().status).toBe(1);
  });

  it('rejects duplicated, missing and unexpected test file coverage', () => {
    const f = fixture();
    f.reports[3].testResults[0].name = f.files[0].file;
    f.write();
    expect(f.run().status).toBe(1);
    f.reports[3].testResults[0].name = '/checkout/unexpected.test.ts';
    f.write();
    expect(f.run().status).toBe(1);
  });

  it('rejects inconsistent full-suite discovery and malformed evidence', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'files-4.json'), JSON.stringify(f.files.slice(1)));
    expect(f.run().status).toBe(1);
    f.write();
    writeFileSync(join(f.root, 'report-4.json'), '{}');
    expect(f.run().status).toBe(1);
  });

  it.each(['success', 'numFailedTests', 'numFailedTestSuites', 'numPassedTests', 'testResults'])(
    'rejects unsuccessful or invalid report %s',
    (field) => {
      const f = fixture();
      const report = f.reports[2] as Record<string, unknown>;
      report[field] = field === 'success' ? false : field === 'testResults' ? [] : -1;
      f.write();
      expect(f.run().status).toBe(1);
    },
  );

  it('accepts real Vitest discovery and four JSON shard reports, including skipped files', () => {
    const f = fixture();
    const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));
    symlinkSync(
      fileURLToPath(new URL('../../node_modules', import.meta.url)),
      join(f.root, 'node_modules'),
    );
    writeFileSync(
      join(f.root, 'vitest.config.mjs'),
      `import Sequencer from ${JSON.stringify(new URL('../ci-unit-sequencer.ts', import.meta.url).href)};
export default {test:{include:['**/*.test.js','**/*.test.ts'],sequence:{sequencer:Sequencer}}};`,
    );
    for (let file = 1; file <= 4; file++)
      writeFileSync(
        join(f.root, `test-${file}.test.js`),
        "import { test, expect } from 'vitest'; for (let i=0; i<70; i++) test('case '+i, () => expect(i).toBe(i));\n",
      );
    for (const c of preparedConsumerCases) {
      mkdirSync(dirname(join(f.root, c.file)), { recursive: true });
      writeFileSync(
        join(f.root, c.file),
        "import {test} from 'vitest';test('dedicated owner',()=>{throw Error('must never run in Linux shards')});",
      );
    }
    writeFileSync(
      join(f.root, 'skipped.test.js'),
      "import { test } from 'vitest'; test.skip('intentional skip', () => {});\n",
    );
    function vitestRun(args: string[]) {
      const result = spawnSync(process.execPath, [vitest, ...args, '--maxWorkers=1'], {
        cwd: f.root,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '--max-old-space-size=1024',
          MITZO_CI_PREPARED_CONSUMERS: '1',
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
    vitestRun(['list', '--filesOnly', '--json=files-1.json']);
    for (let shard = 1; shard <= 4; shard++) {
      if (shard !== 1)
        copyFileSync(join(f.root, 'files-1.json'), join(f.root, `files-${shard}.json`));
      vitestRun([
        'run',
        `--shard=${shard}/4`,
        '--reporter=json',
        `--outputFile=report-${shard}.json`,
      ]);
    }
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('280 passed tests across 5 files');
  }, 20000);

  it('preserves the combined passed-test count floor', () => {
    const f = fixture();
    f.reports.forEach((report) => (report.numPassedTests = 50));
    f.write();
    expect(f.run().status).toBe(1);
  });
});

type Job = {
  needs?: string[];
  if?: string;
  strategy?: { 'fail-fast': boolean; matrix: { shard: number[] } };
  steps: { run?: string; uses?: string; with?: Record<string, unknown> }[];
};
const { jobs } = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, Job>;
};
it('runs four complete unit shards after compile preflight and alongside remaining core validation', () => {
  expect(jobs.unit?.needs).toBe('preflight');
  expect(jobs.unit?.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3, 4] } });
  const commands = jobs.unit?.steps.map((step) => step.run).join('\n');
  expect(commands).toContain('ci-build-output.py restore');
  expect(commands).not.toContain('npm run build');
  expect(commands!.indexOf('ci-build-output.py restore')).toBeLessThan(
    commands!.indexOf('--shard='),
  );
  expect(commands).toContain('vitest list --filesOnly');
  expect(commands).toContain('--shard=${{ matrix.shard }}/4');
  expect(commands).toContain('--reporter=json');
  expect(jobs['unit-validation'].needs).toEqual(['core', 'unit']);
  expect(jobs['unit-validation'].if).toBe('always()');
  expect(
    jobs['unit-validation'].steps.some(
      (step) => step.run === 'node scripts/ci-unit-gate.mjs unit-results',
    ),
  ).toBe(true);
});

it('rejects missing transferred discovery and any duplicate execution in Linux', () => {
  const f = fixture();
  f.reports[0].testResults.push({ name: f.transferred[0].file, status: 'passed' });
  f.write();
  expect(f.run().status).toBe(1);
  f.reports[0].testResults.pop();
  f.write();
  for (let i = 1; i <= 4; i++)
    writeFileSync(join(f.root, `files-${i}.json`), JSON.stringify(f.files));
  expect(f.run().status).toBe(1);
});
