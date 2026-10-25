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
function fixture(native = 'true') {
  return Object.fromEntries(
    [
      'changes',
      'core',
      'unit-validation',
      'ordinary-journey',
      'ordinary-supplemental',
      'browser-validation',
      'native',
    ].map((name) => [
      name,
      {
        result: name === 'native' && native === 'false' ? 'skipped' : 'success',
        ...(name === 'changes' ? { outputs: { native } } : {}),
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
it('runs core concurrently and keeps ci required across every selected owner result', () => {
  expect(workflow.jobs.core.needs).toBeUndefined();
  expect(workflow.jobs.ci.if).toBe('always()');
  expect(workflow.jobs.ci.needs).toEqual([
    'changes',
    'core',
    'ordinary-journey',
    'ordinary-supplemental',
    'browser-validation',
    'native',
    'unit-validation',
  ]);
  expect(workflow.jobs.ci.steps.some((s) => s.run === 'node scripts/ci-required-gate.mjs')).toBe(
    true,
  );
  expect(workflow.jobs['ordinary-supplemental'].strategy?.['fail-fast']).toBe(false);
  expect(workflow.jobs['ordinary-supplemental'].strategy?.matrix.shard).toEqual([1, 2]);
  expect(
    workflow.jobs['ordinary-journey'].steps.some(
      (s) => s.run === 'node tests/integration/telos-s9/integrated-candidate/run-joined-ci.mjs',
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
      'core',
      'unit-validation',
      'ordinary-journey',
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
