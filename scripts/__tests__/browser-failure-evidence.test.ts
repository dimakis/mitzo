import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';

// Inspect config metadata without admitting a browser run. Host admission has
// separate tests; this file never launches a browser or changes sandbox markers.
vi.mock('../../tests/support/playwright-host', () => ({ assertPlaywrightHost: vi.fn() }));
import browser from '../../playwright.config.js';
import offline from '../../playwright.offline.config.js';

type Step = {
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
};
const workflow = load(
  readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as {
  jobs: Record<
    string,
    {
      steps: Step[];
      permissions: Record<string, string>;
      needs: string | string[];
      if?: string;
      strategy?: { matrix: { project: string[] }; 'fail-fast': boolean };
    }
  >;
};

describe('browser failure evidence', () => {
  it('isolates suite output and HTML reports so a later run cannot erase earlier failure evidence', () => {
    expect(browser.outputDir).toBe('test-results/browser');
    expect(offline.outputDir).toBe('test-results/offline');
    for (const [config, directory] of [
      [browser, 'browser'],
      [offline, 'offline'],
    ] as const) {
      expect(config.use?.trace).toBe('retain-on-failure');
      expect(config.use?.screenshot).toBe('only-on-failure');
      expect(config.reporter).toContainEqual([
        'html',
        { outputFolder: `playwright-report/${directory}`, open: 'never' },
      ]);
      expect(config.retries ?? 0).toBe(0);
    }
  });

  it.each([
    ['browser', 'browser-tests', 'npm run test:browser'],
    ['offline', 'offline-tests', 'npm run test:ui -- --project=${{ matrix.project }}'],
  ])(
    'uploads %s failure evidence immediately after its suite and keeps rerun attempts separate',
    (suite, id, command) => {
      const steps = workflow.jobs[suite].steps;
      const index = steps.findIndex((step) => step.run === command);
      expect(index).toBeGreaterThan(-1);
      expect(steps[index].id).toBe(id);
      const upload = steps[index + 1];
      expect(upload.uses).toMatch(/^actions\/upload-artifact@/);
      expect(upload.if).toBe(`\${{ always() && steps.${id}.outcome == 'failure' }}`);
      expect(String(upload.with?.path).trim().split(/\s+/)).toEqual([
        `test-results/${suite}/`,
        `playwright-report/${suite}/`,
      ]);
      expect(upload.with?.name).toBe(
        `playwright-${suite}-failure-${suite === 'offline' ? '${{ matrix.project }}-' : ''}\${{ github.run_id }}-\${{ github.run_attempt }}`,
      );
      expect(upload.with?.['retention-days']).toBe(7);
      expect(upload.with?.['if-no-files-found']).toBe('warn');
      expect(upload.with?.['include-hidden-files']).not.toBe(true);
      expect(steps[index]['continue-on-error' as keyof Step]).toBeUndefined();
    },
  );

  it('runs suites independently and keeps every configured layout project', () => {
    expect(workflow.jobs.browser.needs).toBe('changes');
    expect(workflow.jobs.offline.needs).toBe('changes');
    expect(workflow.jobs.offline.if).toBe(workflow.jobs.browser.if);
    expect(workflow.jobs.offline.strategy?.['fail-fast']).toBe(false);
    const projects = offline.projects!.filter((p) => !p.name!.startsWith('browser-startup-'));
    expect(workflow.jobs.offline.strategy?.matrix.project).toEqual(projects.map((p) => p.name));
    for (const job of ['browser', 'offline', 'browser-validation']) {
      expect(workflow.jobs[job].permissions).toEqual({ contents: 'read' });
    }
    const gate = workflow.jobs['browser-validation'];
    expect(gate.needs).toEqual(['changes', 'browser', 'offline']);
    expect(gate.if).toBe('always()');
    expect(gate.steps.some((step) => step.run === 'node scripts/ci-browser-gate.mjs')).toBe(true);
    for (const step of workflow.jobs.offline.steps.filter((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    )) {
      expect(step.with?.name).toContain('${{ matrix.project }}');
    }
  });
});
