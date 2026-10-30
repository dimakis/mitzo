import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, expect, it } from 'vitest';
import {
  joinedCases,
  joinedShards,
  parseJoinedShardArgs,
  selectJoinedShard,
} from '../../tests/integration/telos-s9/integrated-candidate/joined-shards.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const requiredNames = [
  'non-git',
  'repository',
  'lost-response-recovery',
  'tree-priority',
  's8-chooser',
  'stop-isolation',
  's6-app-owners',
  'native-lead-worker-workflow',
  'worker-first-completion',
  'native-complete-non-git',
  'native-complete-repository',
  'selected-model-readiness',
];
it('partitions all twelve original acceptance groups exactly once, retaining fourteen file cases', () => {
  expect(joinedCases.map((c) => c.name)).toEqual(requiredNames);
  expect(joinedCases.flatMap((c) => c.files).length).toBe(14);
  expect(selectJoinedShard(undefined)).toEqual(joinedCases);
  const selected = Object.keys(joinedShards).flatMap((shard) => selectJoinedShard(shard));
  expect(selected.map((c) => c.name).sort()).toEqual([...requiredNames].sort());
  expect(new Set(selected.map((c) => c.name)).size).toBe(12);
});
it('refuses unknown, partial or multiple shard selectors', () => {
  expect(parseJoinedShardArgs([])).toBeUndefined();
  for (const shard of Object.keys(joinedShards))
    expect(parseJoinedShardArgs(['--shard=' + shard])).toBe(shard);
  for (const args of [
    ['--shard=0/3'],
    ['--shard=1/2'],
    ['--shard=4/3'],
    ['--skip'],
    ['--shard=1/3', '--shard=2/3'],
  ])
    expect(() => parseJoinedShardArgs(args)).toThrow();
  expect(() => selectJoinedShard('1/2')).toThrow();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-joined-'));
  roots.push(root);
  for (const [shard] of Object.entries(joinedShards)) {
    const cases = selectJoinedShard(shard);
    writeFileSync(
      join(root, `required-summary-${shard.replace('/', '-of-')}.json`),
      JSON.stringify(cases.map((c) => ({ name: c.name, status: 'passed' }))),
    );
    for (const c of cases) {
      mkdirSync(join(root, c.name));
      writeFileSync(
        join(root, c.name, 'run.json'),
        JSON.stringify({
          success: true,
          numTotalTests: c.files.length,
          numPassedTests: c.files.length,
          numFailedTests: 0,
          numPendingTests: 0,
          testResults: c.files.map((file) => ({
            name: '/checkout/' + file,
            status: 'passed',
            assertionResults: [{ status: 'passed' }],
          })),
        }),
      );
    }
  }
  const run = (result = 'success') =>
    spawnSync(process.execPath, ['scripts/ci-joined-gate.mjs', root], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CI_JOINED_NEEDS: JSON.stringify({
          changes: { result: 'success', outputs: { ordinary: 'true' } },
          'ordinary-joined': { result },
        }),
      },
    });
  return { root, run };
}
it('accepts complete evidence and rejects an unsuccessful matrix even with complete reports', () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  for (const result of ['failure', 'cancelled', 'skipped', ''])
    expect(f.run(result).status).toBe(1);
});
it('rejects missing or duplicated shard coverage and absent evidence', () => {
  const f = fixture();
  const path = join(f.root, 'required-summary-3-of-3.json');
  const content = readFileSync(path, 'utf8');
  rmSync(path);
  expect(f.run().status).toBe(1);
  writeFileSync(path, readFileSync(join(f.root, 'required-summary-1-of-3.json')));
  expect(f.run().status).toBe(1);
  writeFileSync(path, content);
  rmSync(join(f.root, joinedCases[0].name, 'run.json'));
  expect(f.run().status).toBe(1);
});
it.each(['skipped', 'failed', 'omitted', 'duplicate', 'unsuccessful', 'malformed'])(
  'rejects %s acceptance evidence even if the runner summary claims success',
  (change) => {
    const f = fixture();
    const path = join(f.root, 's6-app-owners', 'run.json');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    if (change === 'skipped') report.testResults[0].assertionResults[0].status = 'pending';
    if (change === 'failed') report.testResults[0].assertionResults[0].status = 'failed';
    if (change === 'omitted') report.testResults.pop();
    if (change === 'duplicate') report.testResults[1] = report.testResults[0];
    if (change === 'unsuccessful') report.success = false;
    writeFileSync(path, change === 'malformed' ? '{}' : JSON.stringify(report));
    expect(f.run().status).toBe(1);
  },
);
it('requires every macOS shard and aggregate without changing the native authorization owner', () => {
  const { jobs } = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: Record<
      string,
      {
        needs?: string[];
        strategy?: { 'fail-fast': boolean; matrix: { shard: number[] } };
        steps: Array<{ name?: string; run?: string }>;
      }
    >;
  };
  expect(jobs['ordinary-joined'].strategy).toEqual({
    'fail-fast': false,
    matrix: { shard: [1, 2, 3] },
  });
  expect(
    jobs['ordinary-joined'].steps.some((s) =>
      s.run?.endsWith('run-joined-ci.mjs --shard=${{ matrix.shard }}/3'),
    ),
  ).toBe(true);
  expect(jobs['joined-validation'].needs).toEqual(['changes', 'ordinary-joined']);
  expect(jobs.ci.needs).toContain('joined-validation');
  expect(
    jobs['ordinary-journey'].steps.some(
      (s) => s.name === 'Verify signed native operator lifetime and repository tools',
    ),
  ).toBe(true);
});

function selectionGate(changes: unknown, result = 'skipped') {
  return spawnSync(process.execPath, ['scripts/ci-joined-gate.mjs', '/missing'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CI_JOINED_NEEDS: JSON.stringify({
        changes,
        'ordinary-joined': { result },
      }),
    },
  });
}
it('allows no joined artifacts only when the full-PR selector explicitly unselects the skipped matrix', () => {
  expect(selectionGate({ result: 'success', outputs: { ordinary: 'false' } }).status).toBe(0);
  for (const result of ['success', 'failure', 'cancelled', ''])
    expect(
      selectionGate({ result: 'success', outputs: { ordinary: 'false' } }, result).status,
    ).toBe(1);
});
it('rejects an absent, failed or malformed selector before considering skipped joined work', () => {
  for (const changes of [
    undefined,
    {},
    { result: 'failure', outputs: { ordinary: 'false' } },
    { result: 'cancelled', outputs: { ordinary: 'false' } },
    { result: 'success', outputs: {} },
    { result: 'success', outputs: { ordinary: 'unknown' } },
    { result: 'success', outputs: { ordinary: false } },
    { result: 'success', outputs: { ordinary: 'true' } },
  ])
    expect(selectionGate(changes).status).toBe(1);
});
