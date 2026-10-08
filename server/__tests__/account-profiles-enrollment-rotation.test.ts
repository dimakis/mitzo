import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadAccountProfiles } from '../account-profiles.js';
import { OpenAIAccountEnrollmentStore } from '../openai-account-enrollment.js';
import { OpenAIKeyManagement } from '../openai-key-management.js';
import { OpenAIKeyOperationStore } from '../openai-key-operation-store.js';
import { REVIEWED_OPENAI_ENROLLMENT_MODELS } from '../openai-enrollment-models.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  cleanups.splice(0).forEach((cleanup) => cleanup());
});
it('keeps authoritative enrolled custody out of rotation even when the operator explicitly selects its ID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-rotation-authority-'));
  const enrollment = new OpenAIAccountEnrollmentStore(join(root, 'accounts.db'));
  const rotations = new OpenAIKeyOperationStore(join(root, 'rotation.db'));
  cleanups.push(() => {
    enrollment.close();
    rotations.close();
    rmSync(root, { recursive: true, force: true });
  });
  const reservation = enrollment.reserve(
    {
      requestId: 'ccabaf58-cc0e-47e2-8cde-750fbb289846',
      label: 'Enrolled synthetic Work',
      projectLabel: 'Synthetic project',
      controllerBinding: createHash('sha256')
        .update(JSON.stringify(['test-gateway', 'default']))
        .digest('hex'),
    },
    ['legacy-work'],
  );
  const enrolledId = reservation.row.accountId;
  enrollment.update(reservation.row, {
    phase: 'ready',
    errorCode: null,
    provider: {
      name: 'mitzo-openai-' + reservation.row.operationId,
      id: '7c7710d0-af53-430b-9ce4-d130eb7c67a5',
      type: 'mitzo-openai-keychain-spike',
      workspace: 'default',
      version: '1',
    },
    models: REVIEWED_OPENAI_ENROLLMENT_MODELS.filter((model) => model.id === 'gpt-6-luna'),
  });
  const profilePath = join(root, 'profiles.json');
  writeFileSync(
    profilePath,
    JSON.stringify([
      {
        id: 'legacy-work',
        label: 'Legacy synthetic Work',
        provider: 'openai',
        credentialRef: {
          provider: 'keychain',
          service: 'synthetic-review-legacy',
          account: 'api-key',
        },
        sandboxProvider: 'synthetic-legacy-provider',
        sandboxProviderId: '785c20f9-a3a6-4dd7-b230-af21bba932ce',
        models: [{ id: 'gpt-6-luna', label: 'Luna 6' }],
      },
    ]),
    { mode: 0o600 },
  );
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', profilePath);
  vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', join(root, 'accounts.db'));
  vi.stubEnv('MITZO_OPENAI_KEY_MANAGEMENT_ACCOUNT_IDS', `legacy-work,${enrolledId}`);
  const profiles = loadAccountProfiles();
  expect(profiles.isEnrolledOpenAIAccount(enrolledId)).toBe(true);
  expect(profiles.openAIKeyManagementAccounts().map((account) => account.id)).toEqual([
    'legacy-work',
  ]);
  expect(profiles.configuredAccountIds()).toEqual(['legacy-work', enrolledId]);
  const keychain = {
    read: vi.fn(async () => ({ value: 'SYNTHETIC_LEGACY_KEY', version: null, managed: false })),
    write: vi.fn(async () => {}),
  };
  const gateway = {
    inspect: vi.fn(async () => ({ version: '1' })),
    pause: vi.fn(async () => {}),
    replace: vi.fn(async () => ({ version: '2' })),
  };
  const validateKey = vi.fn(async () => {});
  const manager = new OpenAIKeyManagement({
    accounts: () => profiles.openAIKeyManagementAccounts(),
    store: rotations,
    keychain,
    gateway,
    validateKey,
    managedAccountIds: process.env.MITZO_OPENAI_KEY_MANAGEMENT_ACCOUNT_IDS!.split(','),
    gatewayBinding: 'test-gateway',
    workspace: 'default',
  });
  await expect(
    manager.replace(
      {
        accountId: enrolledId,
        revision: 'stale-browser-form',
        sameProject: true,
        apiKey: 'SYNTHETIC_REPLACEMENT',
      },
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('not configured for key replacement');
  expect(keychain.read).not.toHaveBeenCalled();
  expect(keychain.write).not.toHaveBeenCalled();
  expect(gateway.inspect).not.toHaveBeenCalled();
  expect(gateway.pause).not.toHaveBeenCalled();
  expect(gateway.replace).not.toHaveBeenCalled();
  expect(validateKey).not.toHaveBeenCalled();
  expect(await manager.list(AbortSignal.timeout(1000))).toEqual([
    expect.objectContaining({ accountId: 'legacy-work', health: 'not_verified' }),
  ]);
});
