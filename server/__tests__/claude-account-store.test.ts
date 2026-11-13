import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAccountStore, readManagedClaudeProfiles } from '../claude-account-store.js';
import { loadAccountProfiles } from '../account-profiles.js';
import { workspaceRuntimeAuthorityPaths } from '../workspace-runtime-private-paths.js';

beforeEach(resetOfflineUserEnvironment);

it('keeps configured Vertex profiles available before the managed journal is initialized', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-empty-')));
  const accounts = join(root, 'accounts');
  mkdirSync(accounts, { mode: 0o700 });
  const profiles = join(root, 'profiles.json');
  writeFileSync(
    profiles,
    JSON.stringify([
      {
        id: 'vertex',
        label: 'Vertex',
        provider: 'anthropic-vertex',
        projectId: 'offline',
        region: 'offline',
        credentialRef: join(root, 'adc.json'),
        models: [{ id: 'sonnet', label: 'Sonnet' }],
      },
    ]),
  );
  vi.stubEnv('MITZO_CLAUDE_ACCOUNTS_DIR', accounts);
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', profiles);
  vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', '');
  try {
    expect(readManagedClaudeProfiles(accounts)).toEqual([]);
    expect(loadAccountProfiles().resolve('vertex', 'sonnet').provider).toBe('anthropic-vertex');
    const store = new ClaudeAccountStore(accounts);
    try {
      const row = store.reserve('operator', Date.now() + 60000, {
        requestId: crypto.randomUUID(),
        label: 'Personal',
      });
      store.connected(row, { email: 'person@example.test', planType: 'max' });
      expect(readManagedClaudeProfiles(accounts)).toHaveLength(1);
      const protectedPaths = workspaceRuntimeAuthorityPaths();
      expect(protectedPaths).toEqual(
        expect.arrayContaining(
          ['', '-wal', '-shm', '-journal'].map((suffix) => join(accounts, 'accounts.db') + suffix),
        ),
      );
      expect(protectedPaths).not.toContain(accounts);
      expect(protectedPaths).not.toContain(store.config(row.accountId));
    } finally {
      store.close();
    }
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['unsafe-root', 'dangling-journal', 'corrupt-journal'])(
  'rejects %s instead of treating it as an empty catalog',
  (kind) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-invalid-')));
    try {
      if (kind === 'unsafe-root') chmodSync(root, 0o755);
      if (kind === 'dangling-journal')
        symlinkSync(join(root, 'missing'), join(root, 'accounts.db'));
      if (kind === 'corrupt-journal')
        writeFileSync(join(root, 'accounts.db'), 'not sqlite', { mode: 0o600 });
      expect(() => readManagedClaudeProfiles(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it('keeps independent accounts and accepts new logins after 500 historical attempts', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-many-')));
  const store = new ClaudeAccountStore(join(root, 'accounts'));
  try {
    let first = '';
    for (let index = 0; index < 70; index++) {
      const row = store.reserve('operator', Date.now() + 60_000, {
        requestId: crypto.randomUUID(),
        label: `Claude ${index}`,
      });
      first ||= row.accountId;
      store.connected(row, {
        email: `person-${index}@example.test`,
        planType: index % 2 ? 'pro' : 'max',
      });
    }
    for (let index = 0; index < 440; index++) {
      const row = store.reserve('operator', Date.now() + 60_000, {
        requestId: crypto.randomUUID(),
        accountId: first,
        label: 'Claude 0',
      });
      store.update({ ...row, state: 'cancelled' });
    }
    expect(store.accounts()).toHaveLength(70);
    expect(new Set(store.accounts().map((row) => store.config(row.id))).size).toBe(70);
    expect(store.accounts()[69].email).toBe('person-69@example.test');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
