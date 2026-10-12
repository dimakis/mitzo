import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = fileURLToPath(
  new URL('./fixtures/playwright-project-selection/playwright.config.ts', import.meta.url),
);

// Exercise Playwright's actual selection/dependency scheduler with synthetic
// startup tests. No browsers, servers, installed engines or model calls needed.
describe('browser-specific startup dependencies', () => {
  it.each([
    ['--project=desktop-chromium'],
    ['--project', '*chromium'],
    ['--project', 'mobile-chromium', 'desktop-chromium'],
  ])('runs selected Chromium projects with WebKit unavailable: %j', (...args) => {
    const run = spawnSync(
      process.execPath,
      [
        require.resolve('@playwright/test/cli'),
        'test',
        '--config',
        config,
        '--workers=1',
        '--reporter=line',
        ...args,
      ],
      {
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('startup chromium');
    expect(run.stdout).not.toContain('startup webkit');
  });

  it('blocks selected WebKit tests after one failed startup', () => {
    const run = spawnSync(
      process.execPath,
      [
        require.resolve('@playwright/test/cli'),
        'test',
        '--config',
        config,
        '--project=mobile-webkit',
        '--workers=1',
        '--reporter=line',
      ],
      {
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(run.stdout).toContain('WebKit installation unavailable');
    expect(run.stdout).toContain('1 failed');
    expect(run.stdout).toContain('1 did not run');
    expect(run.stdout).not.toContain('selected application test executed');
  });
});
