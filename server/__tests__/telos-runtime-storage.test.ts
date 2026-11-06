import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { selectedTelosDatabaseFiles } from '@mitzo/protocol/telos-sqlite-owners';
import { ensureTelosRuntimeStorage } from '../telos-runtime-storage.js';
import { TelosRuntimeStore } from '../telos-runtime-store.js';
import { isPrivateCodexPath } from '../codex-private-path.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function root() {
  const path = mkdtempSync(join(tmpdir(), 'telos-storage-'));
  roots.push(path);
  return path;
}
it('selects private application storage independently of the management checkout', () => {
  vi.stubEnv('REPO_PATH', root());
  vi.stubEnv('TELOS_DB_PATH', '');
  vi.stubEnv('MITZO_TELOS_DATA_DIR', '');
  vi.stubEnv('XDG_DATA_HOME', '');
  expect(selectedTelosDatabaseFiles().canonical).toBe(
    join(homedir(), '.mitzo/private/telos/telos.db'),
  );
  const custom = join(root(), 'custom');
  vi.stubEnv('MITZO_TELOS_DATA_DIR', custom);
  expect(selectedTelosDatabaseFiles().canonical).toBe(join(custom, 'telos.db'));
  expect(isPrivateCodexPath(join(custom, 'telos.db'))).toBe(true);
  vi.stubEnv('MITZO_TELOS_DATA_DIR', '');
  expect(isPrivateCodexPath(join(custom, 'telos.db'))).toBe(true);
});
it('initializes a private fresh installation and refuses a silent empty replacement for legacy data', () => {
  const repo = root(),
    data = root();
  vi.stubEnv('TELOS_DB_PATH', '');
  vi.stubEnv('MITZO_TELOS_DATA_DIR', join(data, 'runtime'));
  const legacy = join(repo, 'command_center/data');
  mkdirSync(legacy, { recursive: true });
  TelosRuntimeStore.initialize(join(legacy, 'smart_todo.db'));
  expect(() => ensureTelosRuntimeStorage(repo)).toThrow(/migration/);
  expect(existsSync(join(data, 'runtime/telos.db'))).toBe(false);
  rmSync(join(legacy, 'smart_todo.db'));
  ensureTelosRuntimeStorage(repo);
  expect(statSync(join(data, 'runtime')).mode & 0o777).toBe(0o700);
  expect(statSync(join(data, 'runtime/telos.db')).mode & 0o777).toBe(0o600);
});
