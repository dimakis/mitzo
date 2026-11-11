import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('collects the real collaboration fixture without starting an unowned bundle in the runner', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'collaboration-collection-')));
  try {
    const preload = join(root, 'forbid-runner-build.cjs');
    writeFileSync(
      preload,
      `require('node:module').registerHooks({resolve(name,context,next){
  if(name==='esbuild')return {url:'data:text/javascript,'+encodeURIComponent("export function build(){throw Error('Fixture bundling belongs to the test worker');}"),shortCircuit:true};
  return next(name,context);
}});`,
    );
    const config = join(root, 'playwright.config.cjs');
    writeFileSync(
      config,
      `module.exports={testDir:${JSON.stringify(resolve('tests/offline'))},testMatch:'ordinary-collaboration-status.spec.ts',reporter:'list',projects:[{name:'mobile-webkit'}]};`,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--require',
        preload,
        resolve('node_modules/playwright/cli.js'),
        'test',
        '--config',
        config,
        '--list',
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Total: 6 tests in 1 file');
    // The same real fixture must still await the build and report its failure
    // in the worker, before page setup or any browser launch is needed.
    const execution = spawnSync(
      process.execPath,
      [
        '--require',
        preload,
        resolve('node_modules/playwright/cli.js'),
        'test',
        '--config',
        config,
        '--workers=1',
        '--retries=0',
        '--grep',
        'recovers fresh \\(dark\\)',
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(execution.error).toBeUndefined();
    expect(execution.status, execution.stdout + execution.stderr).toBe(1);
    expect(execution.stdout).toContain('Running 1 test');
    expect(execution.stdout + execution.stderr).toContain(
      'Fixture bundling belongs to the test worker',
    );
    expect(execution.stdout).toContain('1 failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
