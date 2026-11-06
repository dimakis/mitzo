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
  expect(
    claudePersonalToolPermission(
      'Bash',
      { command: 'pwd', dangerouslyDisableSandbox: true },
      root,
      config,
    )?.behavior,
  ).toBe('deny');
});
