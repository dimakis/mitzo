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
  // The forthcoming enMaaS key belongs to its own account route. Ambient key
  // coordinates must not leak into either existing Claude billing route.
  const ambient = {
    HOME: root,
    PATH: '/usr/bin:/bin',
    ANTHROPIC_API_KEY: 'future-enmaas-key',
    ANTHROPIC_BASE_URL: 'https://enmaas.example.test',
    CLAUDE_CODE_USE_VERTEX: '1',
    GOOGLE_APPLICATION_CREDENTIALS: '/work/adc.json',
  };
  const personal = profiles.sdkEnv(profiles.resolve(attempt.accountId, 'sonnet'), ambient);
  expect(personal).toMatchObject({
    CLAUDE_CONFIG_DIR: store.config(attempt.accountId),
    MITZO_CLAUDE_EXPECTED_EMAIL: 'person@example.test',
  });
  expect(personal.ANTHROPIC_API_KEY).toBeUndefined();
  expect(personal.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(personal.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
  expect(personal.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  const vertex = profiles.sdkEnv(profiles.resolve('work', 'work-model'), personal);
  expect(vertex).toMatchObject({
    CLAUDE_CODE_USE_VERTEX: '1',
    GOOGLE_APPLICATION_CREDENTIALS: '/work/adc.json',
    ANTHROPIC_VERTEX_PROJECT_ID: 'work-project',
  });
  expect(vertex.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(vertex.MITZO_CLAUDE_EXPECTED_EMAIL).toBeUndefined();
  expect(ambient.ANTHROPIC_API_KEY).toBe('future-enmaas-key');
});
