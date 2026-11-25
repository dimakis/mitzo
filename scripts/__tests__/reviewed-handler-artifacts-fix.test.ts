import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { rewriteReviewedHandlerArtifacts } from '../lib/reviewed-handler-artifacts-fix.mjs';

const a = 'a'.repeat(64),
  b = 'b'.repeat(64),
  c = 'c'.repeat(64);
const manifest = (entries: string) =>
  `export const reviewedConnectionsRuntimeImplementationRevision =\n  'v1.0.1-marker';\n` +
  `export const reviewedHandlerSourceArtifacts = Object.freeze({\n${entries}\n});\n`;

it('rewrites only stale registered fingerprints and leaves the revision marker alone', () => {
  const source = manifest(
    `  'one.ts': '${a}',\n  '../../a/very/long/registered/path/that/prettier/wraps.test.ts':\n    '${a}',\n  'new.ts': 'pending',`,
  );
  const result = rewriteReviewedHandlerArtifacts(source, {
    'one.ts': a,
    '../../a/very/long/registered/path/that/prettier/wraps.test.ts': b,
    'new.ts': c,
  });
  expect(result.updated).toEqual([
    '../../a/very/long/registered/path/that/prettier/wraps.test.ts',
    'new.ts',
  ]);
  expect(result.source).toBe(
    manifest(
      `  'one.ts': '${a}',\n  '../../a/very/long/registered/path/that/prettier/wraps.test.ts':\n    '${b}',\n  'new.ts': '${c}',`,
    ),
  );
  expect(result.source).toContain("'v1.0.1-marker'");
  expect(
    rewriteReviewedHandlerArtifacts(result.source, {
      'one.ts': a,
      '../../a/very/long/registered/path/that/prettier/wraps.test.ts': b,
      'new.ts': c,
    }).updated,
  ).toEqual([]);
});

it('never invents, drops or duplicates a registration', () => {
  const source = manifest(`  'one.ts': '${a}',`);
  expect(() => rewriteReviewedHandlerArtifacts(source, {})).toThrow(/No current fingerprint/);
  expect(() => rewriteReviewedHandlerArtifacts(source, { 'one.ts': a, 'two.ts': b })).toThrow(
    /not rewritten: two.ts/,
  );
  expect(() =>
    rewriteReviewedHandlerArtifacts(manifest(`  'one.ts': '${a}',\n  'one.ts': '${b}',`), {
      'one.ts': a,
    }),
  ).toThrow(/Duplicate/);
  expect(() => rewriteReviewedHandlerArtifacts(source, { 'one.ts': 'not-a-hash' })).toThrow();
  expect(() => rewriteReviewedHandlerArtifacts('const x = 1;', {})).toThrow(/block not found/);
});

it('fix mode regenerates the manifest from current files so a conflict can take main and rerun', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewed-artifacts-fix-'));
  try {
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    mkdirSync(join(root, 'server/connections'), { recursive: true });
    for (const file of [
      'scripts/check-reviewed-handler-artifacts.mjs',
      'scripts/lib/reviewed-handler-artifacts-fix.mjs',
      '.prettierrc',
    ])
      copyFileSync(file, join(root, file));
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    writeFileSync(join(root, 'server/connections/fixture.ts'), 'changed source\n');
    const path = join(root, 'server/connections/reviewed-handler-artifacts.ts');
    writeFileSync(
      path,
      [
        "import { createHash } from 'node:crypto';",
        "export const reviewedHandlerImplementationRevision = 'handler';",
        "export const reviewedConnectionsRuntimeImplementationRevision = 'runtime';",
        'export function reviewedHandlerSourceFingerprint(source: string) {',
        "  return createHash('sha256').update(source.replace(/\\r\\n/g, '\\n')).digest('hex');",
        '}',
        'export const reviewedHandlerSourceArtifacts = Object.freeze({',
        `  'fixture.ts': '${hash('main source\n')}',`,
        '});',
        '',
      ].join('\n'),
    );
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [join(root, 'scripts/check-reviewed-handler-artifacts.mjs'), ...args],
        { encoding: 'utf8' },
      );
    const stale = run('--source');
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain('npm run fix:reviewed-handler-artifacts');
    const fixed = run('--fix');
    expect(fixed.status, fixed.stderr).toBe(0);
    expect(fixed.stdout).toContain('Updated 1 reviewed source fingerprint(s)');
    expect(readFileSync(path, 'utf8')).toContain(`'fixture.ts': '${hash('changed source\n')}'`);
    expect(readFileSync(path, 'utf8')).toContain("= 'runtime';");
    expect(run('--source').status).toBe(0);
    expect(run('--fix').stdout).toContain('already current');
    rmSync(join(root, 'server/connections/fixture.ts'));
    const missing = run('--fix');
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('Registered reviewed source is missing: fixture.ts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('prints complete fingerprints through a pipe beyond 64 KiB', () => {
  const printed = spawnSync(
    process.execPath,
    ['scripts/check-reviewed-handler-artifacts.mjs', '--source', '--print'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  expect(printed.status, printed.stderr).toBe(0);
  expect(printed.stdout.length).toBeGreaterThan(64 * 1024);
  expect(Object.keys(JSON.parse(printed.stdout)).length).toBeGreaterThan(100);
});
