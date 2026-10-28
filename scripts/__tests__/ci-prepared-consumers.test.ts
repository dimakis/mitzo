import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { preparedConsumerCases, runPreparedConsumers } from '../ci-prepared-consumers.mjs';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prepared-ci-'));
  roots.push(root);
  for (const c of preparedConsumerCases) {
    const directory = join(root, 'test-results/prepared-consumers', c.name);
    mkdirSync(directory, { recursive: true });
    for (const file of ['run.json', 'exit.json']) writeFileSync(join(directory, file), 'stale');
  }
  return root;
}
function report(c: (typeof preparedConsumerCases)[number]) {
  return {
    success: true,
    numTotalTests: c.cases.length,
    numPassedTests: c.cases.length,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: '/repo/' + c.file,
        status: 'passed',
        assertionResults: c.cases.map((fullName: string) => ({ fullName, status: 'passed' })),
      },
    ],
  };
}
it('runs exactly delivery4 + publication1 serially in fresh one-worker commands with actual reports', async () => {
  const root = fixture();
  let calls = 0;
  const summary = await runPreparedConsumers({
    root,
    runner: async (o: {
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      directory: string;
    }) => {
      const c = preparedConsumerCases[calls++];
      expect(o.cwd).toBe(root);
      expect(o.args).toContain(c.file);
      expect(o.args).toContain('--maxWorkers=1');
      expect(o.args).toContain('--no-file-parallelism');
      expect(o.env.NODE_OPTIONS).toBe(process.env.NODE_OPTIONS);
      expect(o.env.MITZO_CI_PREPARED_CONSUMERS).toBe('0');
      expect(existsSync(join(o.directory, 'run.json'))).toBe(false);
      writeFileSync(join(o.directory, 'run.json'), JSON.stringify(report(c)));
      writeFileSync(join(o.directory, 'exit.json'), JSON.stringify({ code: 0, signal: null }));
      return 0;
    },
  });
  expect(calls).toBe(2);
  expect(summary.map((r: { cases: number }) => r.cases)).toEqual([4, 1]);
});
it.each([
  'skip',
  'todo',
  'duplicate',
  'wrong-file',
  'wrong-case',
  'extra-file',
  'failed-assertion',
  'nonzero',
  'signal',
  'missing-report',
  'missing-exit',
])('keeps %s red and runs the other required file', async (failure) => {
  const root = fixture();
  let calls = 0;
  await expect(
    runPreparedConsumers({
      root,
      runner: async (o: { directory: string }) => {
        const c = preparedConsumerCases[calls++];
        const r = report(c);
        if (calls === 1) {
          if (failure === 'skip') r.numPendingTests = 1;
          if (failure === 'todo') r.numTodoTests = 1;
          if (failure === 'duplicate')
            r.testResults[0].assertionResults[1] = r.testResults[0].assertionResults[0];
          if (failure === 'wrong-file') r.testResults[0].name = '/repo/other.test.ts';
          if (failure === 'wrong-case')
            r.testResults[0].assertionResults[0].fullName = 'foreign case';
          if (failure === 'extra-file') r.testResults.push(r.testResults[0]);
          if (failure === 'failed-assertion')
            r.testResults[0].assertionResults[0].status = 'failed';
        }
        if (!(calls === 1 && failure === 'missing-report'))
          writeFileSync(join(o.directory, 'run.json'), JSON.stringify(r));
        if (!(calls === 1 && failure === 'missing-exit'))
          writeFileSync(
            join(o.directory, 'exit.json'),
            JSON.stringify({
              code: 0,
              signal: calls === 1 && failure === 'signal' ? 'SIGKILL' : null,
            }),
          );
        return calls === 1 && failure === 'nonzero' ? 7 : 0;
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(2);
});
it('cancellation stops further admission and cannot reuse stale passing evidence', async () => {
  const root = fixture();
  let calls = 0;
  await expect(
    runPreparedConsumers({
      root,
      runner: async (o: { directory: string }) => {
        calls++;
        writeFileSync(
          join(o.directory, 'exit.json'),
          JSON.stringify({ code: null, signal: 'SIGTERM', interruptedBy: 'SIGTERM' }),
        );
        return 143;
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  expect(existsSync(join(root, 'test-results/prepared-consumers/publication/run.json'))).toBe(
    false,
  );
  expect(
    JSON.parse(readFileSync(join(root, 'test-results/prepared-consumers/summary.json'), 'utf8')),
  ).toHaveLength(1);
});
