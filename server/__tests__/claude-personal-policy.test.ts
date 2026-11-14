import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudePersonalToolPermission } from '../claude-personal-policy.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('denies explicit private paths while allowing workspace tools through shared permissions', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-policy-')));
  roots.push(root);
  const config = join(root, 'personal');
  mkdirSync(config, { mode: 0o700 });
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  symlinkSync(config, join(root, 'alias'));
  for (const path of [
    join(config, '.credentials.json'),
    join(root, 'alias', '.credentials.json'),
  ]) {
    expect(claudePersonalToolPermission('Read', { file_path: path }, root, config)?.behavior).toBe(
      'deny',
    );
    expect(claudePersonalToolPermission('Edit', { file_path: path }, root, config)?.behavior).toBe(
      'deny',
    );
  }
  expect(
    claudePersonalToolPermission('Read', { file_path: join(root, 'code.ts') }, root, config),
  ).toBeUndefined();
  for (const [name, input] of [
    ['Grep', { path: join(root, 'workspace'), pattern: 'accessToken' }],
    ['Glob', { pattern: '**/*' }],
    ['Bash', { command: 'git status --short' }],
    ['Bash', { command: 'pwd', dangerouslyDisableSandbox: true }],
  ] as const) {
    expect(claudePersonalToolPermission(name, input, root, config)).toBeUndefined();
  }
  for (const name of ['Grep', 'Glob'])
    expect(
      claudePersonalToolPermission(name, { path: config, pattern: '*' }, root, config),
    ).toMatchObject({ behavior: 'deny' });
  for (const input of [
    { pattern: join(config, '**/*') },
    { pattern: join(config, '.credentials.json') },
    { pattern: join(root, 'alias', '*.json') },
    { pattern: 'personal/**/*' },
    { pattern: '../personal/*.json', path: join(root, 'workspace') },
    { pattern: join(config, '{*.json,*.txt}'), path: join(root, 'workspace') },
  ])
    expect(claudePersonalToolPermission('Glob', input, root, config)).toMatchObject({
      behavior: 'deny',
    });
  for (const input of [
    { pattern: '**/*' },
    { pattern: 'src/**/*.{ts,tsx}' },
    { pattern: join(root, 'workspace', '*.json') },
    { pattern: '*.ts', path: join(root, 'workspace') },
  ])
    expect(claudePersonalToolPermission('Glob', input, root, config)).toBeUndefined();
  // Grep's pattern is content, not a filesystem target.
  expect(claudePersonalToolPermission('Grep', { pattern: config }, root, config)).toBeUndefined();
});
