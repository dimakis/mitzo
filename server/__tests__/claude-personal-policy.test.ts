import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudePersonalToolPermission, claudePersonalSandbox } from '../claude-personal-policy.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('keeps credential files and aliases out of native tools while permitting ordinary workspace files', () => {
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
    ['Grep', { path: root, pattern: 'accessToken', glob: '**/.credentials.json' }],
    ['Grep', { path: join(root, 'workspace'), pattern: 'accessToken' }],
    ['Glob', { path: root, pattern: join(config, '**/*') }],
    ['Glob', { pattern: '**/*' }],
  ] as const) {
    const result = claudePersonalToolPermission(name, input, root, config);
    expect(result?.behavior).toBe('deny');
    expect(result?.message).toContain('sandboxed Bash');
  }
  expect(claudePersonalSandbox(config)).toMatchObject({ enabled: true, failIfUnavailable: true });
  expect(
    claudePersonalToolPermission(
      'Bash',
      { command: 'pwd', dangerouslyDisableSandbox: true },
      root,
      config,
    )?.behavior,
  ).toBe('deny');
});
