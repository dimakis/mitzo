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
  jobs: { browser: { steps: Step[]; permissions: Record<string, string> } };
};
const steps = workflow.jobs.browser.steps;

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
    ['offline', 'offline-tests', 'npm run test:ui'],
  ])(
    'uploads %s failure evidence immediately after its suite and keeps rerun attempts separate',
    (suite, id, command) => {
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
        `playwright-${suite}-failure-\${{ github.run_id }}-\${{ github.run_attempt }}`,
      );
      expect(upload.with?.['retention-days']).toBe(7);
      expect(upload.with?.['if-no-files-found']).toBe('warn');
      expect(upload.with?.['include-hidden-files']).not.toBe(true);
      expect(steps[index]['continue-on-error' as keyof Step]).toBeUndefined();
    },
  );

  it('preserves offline execution after a browser failure and read-only repository permissions', () => {
    expect(steps.find((step) => step.run === 'npm run test:ui')?.if).toBe('always()');
    expect(workflow.jobs.browser.permissions).toEqual({ contents: 'read' });
  });
});
