import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';
import {
  parseSupplementalShardArgs,
  selectSupplementalShard,
} from '../../tests/integration/telos-s9/integrated-candidate/supplemental-shards.mjs';
const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<
    string,
    {
      needs?: string[];
      if?: string;
      strategy?: { 'fail-fast': boolean; matrix: { shard: number[] } };
      steps: Array<{ name?: string; run?: string; if?: string }>;
    }
  >;
};
const selection = JSON.parse(
  readFileSync(
    'tests/integration/telos-s9/integrated-candidate/closed-supplemental-selection.json',
    'utf8',
  ),
);
function fixture(native = 'true', prepared = 'true') {
  return Object.fromEntries(
    [
      'changes',
      'preflight',
      'core',
      'unit-validation',
      'ordinary-journey',
      'joined-validation',
      'ordinary-supplemental',
      'browser-validation',
      'native',
      'prepared-consumer-validation',
    ].map((name) => [
      name,
      {
        result: name === 'native' && native === 'false' ? 'skipped' : 'success',
        ...(name === 'changes' ? { outputs: { native, prepared } } : {}),
      },
    ]),
  );
}
function run(needs: unknown) {
  return spawnSync(process.execPath, ['scripts/ci-required-gate.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, CI_REQUIRED_NEEDS: JSON.stringify(needs) },
  });
}
it('waits for preflight and keeps ci required across every selected owner result', () => {
  expect(workflow.jobs.core.needs).toBe('preflight');
  expect(workflow.jobs.ci.if).toBe('always()');
  expect(workflow.jobs.ci.needs).toEqual([
    'changes',
    'preflight',
    'core',
    'ordinary-journey',
    'joined-validation',
    'ordinary-supplemental',
    'browser-validation',
    'native',
    'unit-validation',
    'prepared-consumer-validation',
  ]);
  expect(workflow.jobs.ci.steps.some((s) => s.run === 'node scripts/ci-required-gate.mjs')).toBe(
    true,
  );
  expect(workflow.jobs['ordinary-supplemental'].strategy?.['fail-fast']).toBe(false);
  expect(workflow.jobs['ordinary-supplemental'].strategy?.matrix.shard).toEqual([1, 2]);
  expect(
    workflow.jobs['ordinary-joined'].steps.some(
      (s) =>
        s.run ===
        'node tests/integration/telos-s9/integrated-candidate/run-joined-ci.mjs --shard=${{ matrix.shard }}/3',
    ),
  ).toBe(true);
});
it('accepts successful mandatory owners with either explicit native selection', () => {
  expect(run(fixture('true')).status).toBe(0);
  expect(run(fixture('false')).status).toBe(0);
});
it.each(['failure', 'cancelled', 'skipped', ''])(
  'rejects any missing or unsuccessful required owner: %s',
  (result) => {
    for (const name of [
      'changes',
      'preflight',
      'core',
      'unit-validation',
      'ordinary-journey',
      'joined-validation',
      'ordinary-supplemental',
      'browser-validation',
    ]) {
      const needs = fixture();
      needs[name].result = result;
      expect(run(needs).status).toBe(1);
    }
  },
);
it('rejects unknown selections and native outcomes that contradict the selected coverage', () => {
  for (const selected of ['true', 'false', '', 'unknown'])
    for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
      const needs = fixture(selected);
      needs.native.result = result;
      expect(run(needs).status).toBe(
        (selected === 'true' && result === 'success') ||
          (selected === 'false' && result === 'skipped')
          ? 0
          : 1,
      );
    }
  expect(run({}).status).toBe(1);
});
it('executes the unchanged full selection or an exact once-only 8+9 partition', () => {
  expect(selectSupplementalShard(selection.cases, undefined)).toBe(selection.cases);
  const first = selectSupplementalShard(selection.cases, '1/2'),
    second = selectSupplementalShard(selection.cases, '2/2');
  expect([first.length, second.length]).toEqual([8, 9]);
  expect([...first, ...second].map((c) => c.name).sort()).toEqual(
    selection.cases.map((c: { name: string }) => c.name).sort(),
  );
  expect(new Set([...first, ...second]).size).toBe(17);
  expect(() => selectSupplementalShard(selection.cases.slice(1), '1/2')).toThrow(/exactly one/);
  expect(() =>
    selectSupplementalShard([...selection.cases.slice(1), selection.cases[1]], '1/2'),
  ).toThrow(/exactly one/);
  expect(() => selectSupplementalShard(selection.cases, '1/3')).toThrow();
});
it('cannot silently skip coverage using invalid shard arguments', () => {
  expect(parseSupplementalShardArgs([])).toBeUndefined();
  expect(parseSupplementalShardArgs(['--shard=1/2'])).toBe('1/2');
  expect(parseSupplementalShardArgs(['--shard=2/2'])).toBe('2/2');
  for (const args of [
    ['--shard=1/3'],
    ['--shard=0/2'],
    ['--shard=3/2'],
    ['--shard=1/2', 'extra'],
    ['--skip'],
  ])
    expect(() => parseSupplementalShardArgs(args)).toThrow();
});

it('rejects omitted unit completeness even when every upstream owner succeeds', () => {
  const needs = fixture();
  delete needs['unit-validation'];
  expect(run(needs).status).toBe(1);
});

it('requires the selected prepared consumer owner and rejects unknown or contradictory selection', () => {
  for (const selected of ['true', 'false', '', 'unknown'])
    for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
      const needs = fixture('true', selected);
      needs['prepared-consumer-validation'].result = result;
      expect(run(needs).status).toBe(
        (selected === 'true' && result === 'success') ||
          (selected === 'false' && result === 'success')
          ? 0
          : 1,
      );
    }
  const needs = fixture();
  delete needs['prepared-consumer-validation'];
  expect(run(needs).status).toBe(1);
});
it('runs the transferred owner offline on macOS with retained structured proof and a finite job bound', () => {
  const job = workflow.jobs['prepared-consumers'];
  expect(job).toBeDefined();
  const value = job as typeof job & {
    'runs-on': string;
    'timeout-minutes': number;
    env: Record<string, string>;
  };
  expect(value['runs-on']).toBe('macos-26');
  expect(value['timeout-minutes']).toBe(40);
  expect(value.env.NODE_OPTIONS).toBe('--max-old-space-size=1024');
  expect(job.if).toContain("needs.changes.outputs.prepared == 'true'");
  expect(
    job.steps.some((s) => s.run === 'node scripts/ci-prepared-consumers.mjs ${{ matrix.group }}'),
  ).toBe(true);
  const units = workflow.jobs.unit as typeof job & { env: Record<string, string> };
  expect(units.env.MITZO_CI_PREPARED_CONSUMERS).toBe('1');
  const uploads = job.steps as Array<{ uses?: string; if?: string; with?: Record<string, string> }>;
  expect(uploads.find((s) => s.uses === 'actions/upload-artifact@v7')).toMatchObject({
    if: '${{ always() }}',
    with: { path: 'test-results/prepared-consumers/', 'if-no-files-found': 'error' },
  });
});
