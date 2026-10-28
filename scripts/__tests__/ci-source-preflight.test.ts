import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('checks source pins without compiled output and rejects drift; default mode still requires compiled artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-source-preflight-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'server/connections'), { recursive: true });
    copyFileSync(
      'scripts/check-reviewed-handler-artifacts.mjs',
      join(root, 'scripts/check-reviewed-handler-artifacts.mjs'),
    );
    const content = 'retained source\n';
    const hash = createHash('sha256').update(content).digest('hex');
    writeFileSync(join(root, 'server/connections/fixture.ts'), content);
    writeFileSync(
      join(root, 'server/connections/reviewed-handler-artifacts.ts'),
      `
      import {createHash} from 'node:crypto';
      export const reviewedHandlerImplementationRevision='handler';
      export const reviewedConnectionsRuntimeImplementationRevision='runtime';
      export const reviewedHandlerSourceArtifacts={'fixture.ts':'${hash}'};
      export const reviewedHandlerSourceFingerprint=(source)=>createHash('sha256').update(source.replace(/\\r\\n/g,'\\n')).digest('hex');
    `,
    );
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [join(root, 'scripts/check-reviewed-handler-artifacts.mjs'), ...args],
        { encoding: 'utf8' },
      );
    expect(run().status).not.toBe(0);
    const clean = run('--source');
    expect(clean.status, clean.stderr).toBe(0);
    writeFileSync(join(root, 'server/connections/fixture.ts'), 'changed source\n');
    const drift = run('--source');
    expect(drift.status).not.toBe(0);
    expect(drift.stderr).toContain('Reviewed handler source artifact mismatch: fixture.ts');
    const printed = run('--source', '--print');
    expect(printed.status).toBe(0);
    expect(JSON.parse(printed.stdout)['fixture.ts']).not.toBe(hash);
    expect(
      readFileSync(join(root, 'server/connections/reviewed-handler-artifacts.ts'), 'utf8'),
    ).toContain(hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
