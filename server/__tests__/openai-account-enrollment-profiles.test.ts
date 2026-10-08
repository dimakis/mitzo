import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const registry = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../openai-account-enrollment.js', () => ({
  readReadyOpenAIAccountProfiles: registry.read,
}));
import { loadAccountProfiles } from '../account-profiles.js';
import { createCodexPathProtection } from '../codex-private-path.js';
const work = {
  id: 'original-work',
  label: 'Original Work',
  provider: 'openai',
  credentialRef: { provider: 'keychain', service: 'original', account: 'work' },
  models: [{ id: 'gpt-6-luna', label: 'Luna' }],
};
const added = {
  ...work,
  id: 'openai-new',
  label: 'New Work',
  credentialRef: { provider: 'keychain', service: 'new-service', account: 'new-work' },
  sandboxProvider: 'new-provider',
  sandboxProviderId: 'new-id',
};
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function configure() {
  const root = mkdtempSync(join(tmpdir(), 'enrollment-profiles-'));
  roots.push(root);
  const path = join(root, 'accounts.json');
  writeFileSync(path, JSON.stringify([work]));
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', path);
  vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', join(root, 'enrollment', 'accounts.db'));
  return root;
}
describe('enrolled OpenAI account catalog', () => {
  it('merges ready new accounts without changing original conversation bindings', () => {
    configure();
    registry.read.mockReturnValue([]);
    const old = loadAccountProfiles().resolve('original-work', 'gpt-6-luna');
    registry.read.mockReturnValue([added]);
    const next = loadAccountProfiles();
    expect(next.catalog().map((a) => a.id)).toEqual(['original-work', 'openai-new']);
    expect(next.resume(old)).toEqual(old);
    expect(next.resolve('openai-new', 'gpt-6-luna').accountId).toBe('openai-new');
  });
  it('rejects collisions and unreadable configured registries without falling back', () => {
    configure();
    registry.read.mockReturnValue([{ ...added, id: 'original-work' }]);
    expect(() => loadAccountProfiles()).toThrow();
    registry.read.mockImplementation(() => {
      throw Error('PRIVATE registry error');
    });
    expect(() => loadAccountProfiles()).toThrow('Cannot load account profiles');
    expect(() => loadAccountProfiles()).not.toThrow('PRIVATE');
  });
  it('keeps registry and its SQLite sidecars private across configuration removal', () => {
    const root = configure();
    const snapshot = createCodexPathProtection(() => {
      loadAccountProfiles();
      return [];
    });
    registry.read.mockReturnValue([]);
    const check = snapshot();
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      expect(check(join(root, 'enrollment', 'accounts.db' + suffix))).toBe(true);
    vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', '');
    expect(snapshot()(join(root, 'enrollment', 'accounts.db'))).toBe(true);
  });
  it('refuses reserved enrollment resources after all enrollment configuration is removed', () => {
    const root = configure();
    vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', '');
    const id = '692cc62a-f36b-430c-9853-984fc20dbd79';
    for (const profile of [
      { ...work, id: 'openai-' + id },
      { ...work, sandboxProvider: 'mitzo-openai-' + id },
      {
        ...work,
        credentialRef: {
          provider: 'keychain',
          service: 'mitzo.openai.enrollment.' + id,
          account: 'api-key',
        },
      },
    ]) {
      writeFileSync(join(root, 'accounts.json'), JSON.stringify([profile]));
      expect(() => loadAccountProfiles()).toThrow('Cannot load account profiles');
    }
  });
});
