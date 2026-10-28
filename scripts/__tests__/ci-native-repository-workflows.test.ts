import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  nativeRepositoryCases,
  runNativeRepositoryWorkflows,
} from '../ci-native-repository-workflows.mjs';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-ci-'));
  roots.push(root);
  mkdirSync(join(root, 'test-results/native-repository-workflows'), { recursive: true });
  for (const c of nativeRepositoryCases) {
    const directory = join(root, 'test-results/native-repository-workflows-processes', c.account);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'run.json'), 'stale');
    writeFileSync(join(directory, 'exit.json'), 'stale');
    writeFileSync(
      join(root, 'test-results/native-repository-workflows', c.account + '.json'),
      JSON.stringify(evidence(c.account)),
    );
  }
  return root;
}
function report(selected: { file: string; account: string }) {
  return {
    success: true,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: '/repo/' + selected.file,
        status: 'passed',
        assertionResults: [
          {
            status: 'passed',
            fullName: `registered owned repository workflow survives cold login and viewer detach on ${selected.account} with actual OS fences`,
          },
        ],
      },
    ],
  };
}
function evidence(account: string) {
  return {
    account,
    phase: 'completed',
    wholeCaseBudgetMs: process.env.CI ? 480000 : 240000,
    coldResume: true,
    viewerDetached: true,
    outcomes: {
      DiscoverLocalRepository: { state: 'selected' },
      InspectLocalRepository: { success: true },
      PrepareLocalRepository: { state: 'materialized' },
      denied: { success: false },
      revoked: { success: false },
      custody: { scratchRemoved: true },
      handoff: {
        sameConversation: true,
        sameThread: true,
        taskCwdSelected: true,
        toolsUsable: true,
      },
    },
  };
}
it('runs each unchanged account file in a fresh command and retains both actual reporters and native evidence', async () => {
  const root = fixture();
  const admitted: string[] = [];
  for (const c of nativeRepositoryCases)
    writeFileSync(
      join(root, 'test-results/native-repository-workflows', c.account + '.json'),
      'stale',
    );
  writeFileSync(join(root, 'test-results/native-repository-workflows.json'), 'stale');
  await runNativeRepositoryWorkflows({
    root,
    runner: async (options: {
      args: string[];
      directory: string;
      cwd: string;
      env: NodeJS.ProcessEnv;
    }) => {
      const c = nativeRepositoryCases[admitted.length];
      admitted.push(c.account);
      expect(options.cwd).toBe(root);
      expect(options.args).toContain(c.file);
      expect(options.args).toContain('--maxWorkers=1');
      expect(options.args).toContain('--no-file-parallelism');
      expect(options.env.NODE_OPTIONS).toBe(process.env.NODE_OPTIONS);
      expect(options.env.MITZO_RUN_NATIVE_READ_TOOLS_MECHANICAL).toBe('1');
      expect(existsSync(join(options.directory, 'run.json'))).toBe(false);
      expect(
        existsSync(join(root, 'test-results/native-repository-workflows', c.account + '.json')),
      ).toBe(false);
      writeFileSync(join(options.directory, 'run.json'), JSON.stringify(report(c)));
      writeFileSync(
        join(options.directory, 'exit.json'),
        JSON.stringify({ code: 0, signal: null, interruptedBy: null }),
      );
      writeFileSync(
        join(root, 'test-results/native-repository-workflows', c.account + '.json'),
        JSON.stringify(evidence(c.account)),
      );
      return 0;
    },
  });
  expect(admitted).toEqual(['subscription', 'api']);
  expect(existsSync(join(root, 'test-results/native-repository-workflows.json'))).toBe(false);
});
it.each([
  'skip',
  'wrong-file',
  'wrong-account',
  'nonzero',
  'signal',
  'missing-evidence',
  'incomplete-evidence',
  'stale-report',
  'wrong-outer-budget',
  'timeout',
])('keeps %s red and still admits the other required account', async (failure) => {
  const root = fixture();
  let calls = 0;
  await expect(
    runNativeRepositoryWorkflows({
      root,
      runner: async (o: { directory: string }) => {
        const c = nativeRepositoryCases[calls++];
        const r = report(c);
        const e = evidence(c.account);
        if (calls === 1) {
          if (failure === 'skip') r.numPendingTests = 1;
          if (failure === 'wrong-outer-budget') e.wholeCaseBudgetMs = 1;
          if (failure === 'timeout') {
            r.success = false;
            r.numFailedTests = 1;
            r.numPassedTests = 0;
          }
          if (failure === 'wrong-file') r.testResults[0].name = '/repo/other.test.ts';
          if (failure === 'wrong-account')
            r.testResults[0].assertionResults[0].fullName = 'other account';
          if (failure === 'incomplete-evidence') e.outcomes.handoff.sameThread = false;
        }
        if (!(calls === 1 && failure === 'stale-report'))
          writeFileSync(join(o.directory, 'run.json'), JSON.stringify(r));
        writeFileSync(
          join(o.directory, 'exit.json'),
          JSON.stringify({
            code: 0,
            signal: calls === 1 && failure === 'signal' ? 'SIGKILL' : null,
            interruptedBy: null,
          }),
        );
        if (!(calls === 1 && failure === 'missing-evidence'))
          writeFileSync(
            join(root, 'test-results/native-repository-workflows', c.account + '.json'),
            JSON.stringify(e),
          );
        return calls === 1 && failure === 'nonzero' ? 7 : 0;
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(2);
});
it('stops account admission on cancellation and leaves incomplete qualification red', async () => {
  const root = fixture();
  let calls = 0;
  await expect(
    runNativeRepositoryWorkflows({
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
  expect(existsSync(join(root, 'test-results/native-repository-workflows/api.json'))).toBe(false);
  expect(
    existsSync(join(root, 'test-results/native-repository-workflows-processes/api/run.json')),
  ).toBe(false);
  expect(
    JSON.parse(
      readFileSync(
        join(root, 'test-results/native-repository-workflows-processes/summary.json'),
        'utf8',
      ),
    ),
  ).toHaveLength(1);
});

it('applies only a CI outer envelope while preserving local and per-operation bounds', async () => {
  const { createSourceFile, ScriptTarget, isFunctionDeclaration, transpile } =
    await import('typescript');
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(
    'server/__tests__/fixtures/native-repository-registered-workflow.ts',
    'utf8',
  );
  const ast = createSourceFile('fixture.ts', source, ScriptTarget.Latest, true);
  const registration = ast.statements.find(
    (node) => isFunctionDeclaration(node) && node.name?.text === 'registerNativeRepositoryWorkflow',
  )!;
  for (const [CI, expected] of [
    [undefined, 240000],
    ['true', 480000],
  ] as const) {
    let observed: unknown[] = [];
    runInNewContext(
      transpile(
        registration
          .getText()
          .replace('export ', '')
          .replaceAll('import.meta', '({url:"file:///unused"})'),
      ) + '\nregisterNativeRepositoryWorkflow("subscription");',
      {
        process: { platform: 'darwin', env: { CI, MITZO_RUN_NATIVE_READ_TOOLS_MECHANICAL: '1' } },
        it: {
          skipIf:
            () =>
            (...args: unknown[]) => {
              observed = args;
            },
        },
      },
    );
    expect(observed[0]).toContain('subscription');
    expect(observed[1]).toBeTypeOf('function');
    expect(observed[2]).toBe(expected);
  }
  // The expanded whole-case budget cannot alter helper, handoff or revocation fences.
  expect(source).toContain('expect(args[0].timeoutMs).toBeLessThanOrEqual(30000)');
  expect(source).toContain('{ timeout: 120000, interval: 100 }');
  expect(source).toContain("phase = 'revoked'");
  expect(source).toContain('expect(factsBudgets).toHaveLength(factsBeforeRevoke)');
  expect(source).toMatch(/wholeCaseBudgetMs[,\n]/);
});
