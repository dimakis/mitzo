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
  jobs: Record<string, { outputs?: Record<string, string>; steps: Step[] }>;
};

it('builds and verifies the combined candidate once, publishing an immutable artifact ID', () => {
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
  expect(runs).toContain('ci-build-output.py pack');
  const upload = steps.find((step) => step.id === 'compiled-output')!;
  expect(upload.uses).toBe('actions/upload-artifact@v7');
  expect(upload.with?.name).toBe('ci-compiled-${{ github.sha }}-${{ github.run_attempt }}');
  expect(upload.with?.overwrite).toBeUndefined();
  expect(jobs.preflight.outputs?.build_artifact_id).toBe(
    '${{ steps.compiled-output.outputs.artifact-id }}',
  );
  expect(steps.findIndex((step) => step.run?.includes('ci-build-output.py pack'))).toBeLessThan(
    steps.indexOf(upload),
  );
  expect(
    steps.find((step) => step.run === 'node scripts/retain-production-bundle.mjs')?.env
      ?.MITZO_PR_BASE,
  ).toBe('${{ github.event.pull_request.base.sha }}');
});

it.each(['core', 'unit', 'offline'])(
  '%s requires same-run artifact restoration before checks without recompiling',
  (name) => {
    const steps = jobs[name].steps;
    const guard = steps.find((step) => step.env?.CI_COMPILED_ARTIFACT_ID)!;
    expect(guard.env?.CI_COMPILED_ARTIFACT_ID).toBe(
      '${{ needs.preflight.outputs.build_artifact_id }}',
    );
    expect(guard.run).toContain('^[0-9]+$');
    const download = steps.find((step) => step.uses === 'actions/download-artifact@v8')!;
    expect(steps.indexOf(guard)).toBeLessThan(steps.indexOf(download));
    expect(download.with?.['artifact-ids']).toBe(
      '${{ needs.preflight.outputs.build_artifact_id }}',
    );
    expect(download.with?.['merge-multiple']).toBe(true);
    expect(download.with?.name).toBeUndefined();
    const restore = steps.find((step) => step.id === 'compiled-prerequisites')!;
    expect(restore.run).toContain('ci-build-output.py restore');
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
