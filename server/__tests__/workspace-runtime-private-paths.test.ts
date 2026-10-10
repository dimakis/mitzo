import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexPathProtection, isPrivateCodexPath } from '../codex-private-path.js';
import {
  configuredWorkspaceRuntimePrivatePaths,
  isWorkspaceRuntimeAuthorityWritePath,
} from '../workspace-runtime-private-paths.js';

let root: string;
let enrollment: string;
let config: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-runtime-authority-')));
  enrollment = join(root, 'enrollment.json');
  config = join(root, 'config.json');
  mkdirSync(join(root, 'environment', 'bin'), { recursive: true });
  writeFileSync(join(root, 'environment', 'pyvenv.cfg'), 'synthetic environment');
  writeFileSync(join(root, 'environment', 'bin', 'python'), 'synthetic interpreter');
  writeFileSync(
    config,
    JSON.stringify({ gwsExecutable: join(root, 'gws'), jiraLibPath: join(root, 'jira') }),
    { mode: 0o600 },
  );
  writeFileSync(
    enrollment,
    JSON.stringify({
      kind: 'workspace-runtime-v1',
      config,
      release: join(root, 'release'),
      python: join(root, 'environment', 'bin', 'python'),
    }),
    { mode: 0o600 },
  );
  vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', enrollment);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('protects enrollment, selected executables and interpreter dependencies before initialization without protecting reports', () => {
  expect(configuredWorkspaceRuntimePrivatePaths()).toContain(join(root, 'environment'));
  const check = createCodexPathProtection(() => [])();
  for (const path of [enrollment, config]) expect(check(path)).toBe(true);
  for (const path of [
    join(root, 'release', 'run-runtime.py'),
    join(root, 'gws'),
    join(root, 'jira', 'jira_client.py'),
    join(root, 'environment', 'lib', 'site-packages', 'provider.py'),
  ]) {
    expect(check(path)).toBe(false);
    expect(isWorkspaceRuntimeAuthorityWritePath(path)).toBe(true);
  }
  expect(check(join(root, 'briefings', 'report.md'))).toBe(false);
});
it('protects aliases and retains known authority across configuration removal', () => {
  symlinkSync(config, join(root, 'alias.json'));
  expect(isPrivateCodexPath(join(root, 'alias.json'))).toBe(true);
  vi.unstubAllEnvs();
  expect(isPrivateCodexPath(config)).toBe(true);
  expect(isPrivateCodexPath(join(root, 'report.md'))).toBe(false);
});
it('fails closed on unreadable or malformed authority before a first successful snapshot', () => {
  writeFileSync(enrollment, '{malformed');
  expect(createCodexPathProtection(() => [])()(join(root, 'any-write'))).toBe(true);
});
