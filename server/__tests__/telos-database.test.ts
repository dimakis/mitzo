import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { telosDatabasePath } from '../telos-database.js';
import { selectedTelosDatabaseFiles } from '@mitzo/protocol/telos-sqlite-owners';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
it('selects the same native database for APIs, execution and retained file owners', () => {
  const root = mkdtempSync(join(tmpdir(), 'telos-selection-'));
  roots.push(root);
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('TELOS_DB_PATH', '');
  expect(telosDatabasePath(root)).toBe(join(root, '.mitzo', 'telos.db'));
  expect(selectedTelosDatabaseFiles().canonical).toBe(telosDatabasePath(root));
  const legacy = join(root, 'command_center', 'data', 'smart_todo.db');
  mkdirSync(join(root, 'command_center', 'data'), { recursive: true });
  writeFileSync(legacy, 'legacy');
  expect(telosDatabasePath(root)).toBe(legacy);
  expect(selectedTelosDatabaseFiles().canonical).toBe(legacy);
  vi.stubEnv('TELOS_DB_PATH', join(root, 'explicit.db'));
  expect(telosDatabasePath(root)).toBe(join(root, 'explicit.db'));
  expect(selectedTelosDatabaseFiles().canonical).toBe(telosDatabasePath(root));
});
