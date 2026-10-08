import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadAccountProfiles } from '../account-profiles.js';
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const operationId = '890456d2-8b5d-43d6-b8b8-48c1c99837c0';
it.each(['account-id', 'provider-name', 'keychain-reference'] as const)(
  'refuses a static %s alias after the enrollment registry configuration is removed',
  (coordinate) => {
    const directory = mkdtempSync(join(tmpdir(), 'openai-enrollment-fence-review-'));
    directories.push(directory);
    const profile = {
      id: coordinate === 'account-id' ? `openai-${operationId}` : 'static-alias',
      label: 'Synthetic review account',
      provider: 'openai',
      credentialRef: {
        provider: 'keychain',
        service:
          coordinate === 'keychain-reference'
            ? `mitzo.openai.enrollment.${operationId}`
            : 'synthetic-review-key',
        account: 'api-key',
      },
      sandboxProvider:
        coordinate === 'provider-name'
          ? `mitzo-openai-${operationId}`
          : 'synthetic-review-provider',
      sandboxProviderId: 'adbac7b3-6d87-4bd4-bb38-3f2c7939bebc',
      models: [{ id: 'gpt-6-luna', label: 'Luna 6' }],
    };
    const path = join(directory, 'profiles.json');
    writeFileSync(path, JSON.stringify([profile]), { mode: 0o600 });
    vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', path);
    vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', '');
    expect(() => loadAccountProfiles()).toThrow();
  },
);
