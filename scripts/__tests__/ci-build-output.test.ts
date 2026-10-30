import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

type Step = {
  id?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string | boolean>;
  env?: Record<string, string>;
};
const { jobs } = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<
    string,
    { needs?: string | string[]; outputs?: Record<string, string>; steps: Step[] }
  >;
};

it('builds server and frontend in parallel, publishing separate immutable artifact IDs', () => {
  const steps = jobs.preflight.steps;
  const runs = steps.map((step) => step.run ?? '').join('\n');
  for (const check of [
    'npm run build:server',
    'npx tsc --noEmit',
    'cd frontend && npx tsc -b',
    'npm run check:source-artifacts',
  ])
    expect(runs).toContain(check);
  expect(runs).toContain('python3 scripts/test-ci-build-output.py');
  expect(runs).not.toMatch(/^npm run build$/m);
  expect(jobs['frontend-build']?.needs).toBeUndefined();
  for (const [owner, scope] of [
    ['preflight', 'server'],
    ['frontend-build', 'frontend'],
  ]) {
    const producer = jobs[owner];
    const commands = producer.steps.map((step) => step.run ?? '').join('\n');
    expect(commands).toContain(`ci-build-output.py pack ${scope} "$RUNNER_TEMP/ci-${scope}.zip"`);
    if (scope === 'frontend') {
      expect(commands).toContain('npx tsc -b packages/protocol packages/harness packages/client');
      expect(commands).toContain('npm run build');
      expect(commands).not.toContain('npm run build:server');
    }
    const upload = producer.steps.find((step) => step.id === 'compiled-output')!;
    expect(upload.uses).toBe('actions/upload-artifact@v7');
    expect(upload.with?.name).toBe(`ci-${scope}-` + '${{ github.sha }}-${{ github.run_attempt }}');
    expect(upload.with?.path).toBe('${{ runner.temp }}/ci-' + scope + '.zip');
    expect(upload.with?.overwrite).toBeUndefined();
    expect(producer.outputs?.build_artifact_id).toBe(
      '${{ steps.compiled-output.outputs.artifact-id }}',
    );
    expect(
      producer.steps.findIndex((step) => step.run?.includes(`ci-build-output.py pack ${scope}`)),
    ).toBeLessThan(producer.steps.indexOf(upload));
  }
  expect(
    jobs['frontend-build'].steps.find(
      (step) => step.run === 'node scripts/retain-production-bundle.mjs',
    )?.env?.MITZO_PR_BASE,
  ).toBe('${{ github.event.pull_request.base.sha }}');
  expect([jobs.ci.needs].flat()).toContain('frontend-build');
});

it.each(['core', 'unit', 'offline'])(
  '%s requires both same-run artifact scopes before checks without recompiling',
  (name) => {
    const consumer = jobs[name];
    expect([consumer.needs].flat()).toContain('preflight');
    expect([consumer.needs].flat()).toContain('frontend-build');
    const steps = consumer.steps;
    const guard = steps.find((step) => step.env?.CI_SERVER_ARTIFACT_ID)!;
    expect(guard.env?.CI_SERVER_ARTIFACT_ID).toBe(
      '${{ needs.preflight.outputs.build_artifact_id }}',
    );
    expect(guard.env?.CI_FRONTEND_ARTIFACT_ID).toBe(
      "${{ needs['frontend-build'].outputs.build_artifact_id }}",
    );
    for (const key of ['CI_SERVER_ARTIFACT_ID', 'CI_FRONTEND_ARTIFACT_ID']) {
      expect(guard.run).toContain(`"$${key}" =~ ^[0-9]+$`);
    }
    const download = steps.find((step) => step.uses === 'actions/download-artifact@v8')!;
    expect(steps.indexOf(guard)).toBeLessThan(steps.indexOf(download));
    expect(download.with?.['artifact-ids']).toBe(
      "${{ needs.preflight.outputs.build_artifact_id }},${{ needs['frontend-build'].outputs.build_artifact_id }}",
    );
    expect(download.with?.['merge-multiple']).toBe(true);
    expect(download.with?.name).toBeUndefined();
    const restore = steps.find((step) => step.id === 'compiled-prerequisites')!;
    expect(restore.run).toBe(
      'python3 scripts/ci-build-output.py restore server "$RUNNER_TEMP/ci-compiled/ci-server.zip"\npython3 scripts/ci-build-output.py restore frontend "$RUNNER_TEMP/ci-compiled/ci-frontend.zip"\n',
    );
    expect(steps.indexOf(download)).toBeLessThan(steps.indexOf(restore));
    const runs = steps.map((step) => step.run ?? '').join('\n');
    expect(runs).not.toMatch(/^npm run build(?::server)?$/m);
    const test = steps.find(
      (step) => step.id === 'test' || step.id === 'offline-tests' || step.id === 'design',
    )!;
    expect(steps.indexOf(restore)).toBeLessThan(steps.indexOf(test));
  },
);

it('keeps ordinary local builds while CI layout shards use verified prebuilt assets', () => {
  const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(scripts['test:ui:ci']).toContain('npm run build');
  expect(scripts['test:ui:ci:prebuilt']).toBe('node scripts/ci-browser-batches.mjs');
  expect(jobs.offline.steps.find((step) => step.id === 'offline-tests')?.run).toContain(
    'test:ui:ci:prebuilt',
  );
});

it('does not collide with retained producer artifacts on a failed-only retry', () => {
  for (const owner of ['preflight', 'frontend-build']) {
    for (const upload of jobs[owner].steps.filter(
      (step) => step.uses === 'actions/upload-artifact@v7',
    )) {
      const name = upload.with?.name as string;
      const render = (attempt: number) =>
        name
          .replace('${{ github.sha }}', 'combined-candidate')
          .replace('${{ github.run_attempt }}', String(attempt));
      expect(render(1), name).not.toBe(render(2));
    }
  }
});
