import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAccountStore } from '../claude-account-store.js';
import { loadAccountProfiles } from '../account-profiles.js';
import { isPrivateCodexPath } from '../codex-private-path.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
it('adds verified Claude accounts without editing or replacing operator profiles and protects pending credential roots', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-profiles-')));
  roots.push(root);
  const managed = join(root, 'managed');
  vi.stubEnv('MITZO_CLAUDE_ACCOUNTS_DIR', managed);
  expect(isPrivateCodexPath(join(managed, 'future-login', 'credentials'))).toBe(true);
  const store = new ClaudeAccountStore(managed);
  const attempt = store.reserve('browser', Date.now() + 60_000, { requestId: crypto.randomUUID() });
  store.connected(attempt, { email: 'person@example.test', planType: 'max' });
  store.close();
  const path = join(root, 'profiles.json');
  const configured = JSON.stringify([
    {
      id: 'work',
      label: 'Work Vertex',
      provider: 'anthropic-vertex',
      projectId: 'work-project',
      region: 'us-east5',
      credentialRef: '/work/adc.json',
      models: [{ id: 'work-model', label: 'Work model' }],
    },
  ]);
  writeFileSync(path, configured);
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', path);
  const profiles = loadAccountProfiles();
  expect(profiles.catalog().map((row) => row.id)).toEqual(['work', attempt.accountId]);
  expect(readFileSync(path, 'utf8')).toBe(configured);
  expect(profiles.ordinaryLocalVertexInventory().map((row) => row.account.accountId)).toContain(
    attempt.accountId,
  );
});
