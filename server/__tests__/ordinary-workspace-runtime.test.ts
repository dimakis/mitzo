import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  lstatSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ordinaryWorkspaceTaskRoot } from '../ordinary-workspace-runtime.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordinary-task-root-')));
  roots.push(root);
  vi.stubEnv('MITZO_ORDINARY_TASK_ROOT', join(root, 'ordinary-files'));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'controller-private'));
  vi.stubEnv('MITZO_KNOWLEDGE_LIBRARY_CONFIG', undefined);
  vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', undefined);
  return root;
}
it('uses a separate server-owned non-Git root and preserves its identity and legitimate files on reentry', () => {
  const root = fixture(),
    selected = ordinaryWorkspaceTaskRoot();
  expect(selected).toBe(join(root, 'ordinary-files'));
  expect(existsSync(selected)).toBe(false);
  expect(ordinaryWorkspaceTaskRoot(true)).toBe(selected);
  const original = lstatSync(selected);
  expect(original.mode & 0o077).toBe(0);
  expect(existsSync(join(selected, '.git'))).toBe(false);
  writeFileSync(join(selected, 'plan.md'), 'Retained work');
  expect(ordinaryWorkspaceTaskRoot(true)).toBe(selected);
  expect(lstatSync(selected).ino).toBe(original.ino);
  expect(readFileSync(join(selected, 'plan.md'), 'utf8')).toBe('Retained work');
});
it('refuses relative, symlinked and non-private existing roots without adopting them or changing permissions', () => {
  const root = fixture();
  vi.stubEnv('MITZO_ORDINARY_TASK_ROOT', 'relative');
  expect(() => ordinaryWorkspaceTaskRoot(true)).toThrow();
  const target = join(root, 'target');
  mkdirSync(target, { mode: 0o700 });
  const alias = join(root, 'alias');
  symlinkSync(target, alias);
  vi.stubEnv('MITZO_ORDINARY_TASK_ROOT', alias);
  expect(() => ordinaryWorkspaceTaskRoot(true)).toThrow();
  expect(readdirSync(target)).toEqual([]);
  const shared = join(root, 'shared');
  mkdirSync(shared, { mode: 0o755 });
  vi.stubEnv('MITZO_ORDINARY_TASK_ROOT', shared);
  expect(() => ordinaryWorkspaceTaskRoot(true)).toThrow();
  expect(lstatSync(shared).mode & 0o777).toBe(0o755);
});
it('refuses configuration and credential storage as a writable ordinary task root', () => {
  const root = fixture();
  const selected = join(root, 'controller-private', 'tasks');
  vi.stubEnv('MITZO_ORDINARY_TASK_ROOT', selected);
  expect(() => ordinaryWorkspaceTaskRoot(true)).toThrow();
  expect(existsSync(selected)).toBe(false);
});
