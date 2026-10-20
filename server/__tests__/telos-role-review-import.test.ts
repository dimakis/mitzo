import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

it('reviews canonical role context without loading execution authentication or host configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'telos-review-import-'));
  try {
    const script = join(root, 'review.mjs');
    writeFileSync(
      script,
      `
      import net from 'node:net';
      net.Socket.prototype.connect = function () { throw Error('No network in review'); };
      net.Server.prototype.listen = function () { throw Error('No backend in review'); };
      globalThis.fetch = () => { throw Error('No provider in review'); };
      const { reviewedContextBrowserData } = await import(${JSON.stringify(new URL('../../tests/fixtures/telos-reviewed-context-data.ts', import.meta.url).href)});
      const data = await reviewedContextBrowserData();
      if (!data.review.presentationRef || !data.material.sha256) throw Error('Actual review missing');
      console.log('CANONICAL_REVIEW_READY');
    `,
    );
    const result = spawnSync(
      process.execPath,
      ['--import', createRequire(import.meta.url).resolve('tsx'), script],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: tmpdir(),
          NODE_ENV: 'test',
          NODE_OPTIONS: '--max-old-space-size=1024',
        },
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('CANONICAL_REVIEW_READY');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
