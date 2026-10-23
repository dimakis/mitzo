import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const rawKey = vi.hoisted(() => vi.fn(async () => 'offline-selected-key'));
vi.mock('../credentials.js', async (original) => ({
  ...(await original<object>()),
  credentials: { resolve: rawKey },
}));
import { loadAccountProfiles } from '../account-profiles.js';
import { openAIAccountKeyAuthority } from '../openai-account-key-authority.js';
import { createConnectionsRuntime, setConnectionsRuntime } from '../connections-runtime.js';
import {
  OpenAIKeyOperationStore,
  openAIKeyResourceBindings,
} from '../openai-key-operation-store.js';

afterEach(() => {
  setConnectionsRuntime(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rawKey.mockClear();
});
const endpoint = 'https://qualified.example.test/v1';
const ownedReference = {
  provider: 'keychain',
  service: 'offline-resource',
  account: 'owner',
} as const;
const signal = () => new AbortController().signal;

function fixture(
  phase: 'complete' | 'prepared',
  alias: boolean,
  controller = true,
  resourceCallback = true,
) {
  const root = mkdtempSync(join(tmpdir(), 'openai-resource-custody-'));
  const directory = join(root, '.mitzo');
  mkdirSync(directory);
  const reference = alias ? ownedReference : { ...ownedReference, account: 'independent' };
  const configuration = [
    {
      id: 'custom',
      label: 'Selected custom account',
      provider: 'openai',
      credentialRef: reference,
      models: [{ id: 'offline-luna-fixture', label: 'Offline Luna' }],
      connection: {
        endpoint,
        protocol: 'responses',
        qualification: {
          source: 'operator',
          streaming: true,
          toolCalls: true,
          continuation: true,
          cancellation: true,
        },
      },
    },
  ];
  const profilePath = join(root, 'profiles.json');
  writeFileSync(profilePath, JSON.stringify(configuration), { mode: 0o600 });
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', profilePath);
  vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', '');
  const store = new OpenAIKeyOperationStore(join(directory, 'openai-key-operations.db'));
  const retained = store.begin({
    accountId: 'removed-owner',
    binding: 'retained-owner-binding',
    gatewayVersion: 'offline-version',
    keychainBeforeVersion: null,
    ...openAIKeyResourceBindings({
      credentialRef: ownedReference,
      providerName: 'original-provider',
      providerId: 'original-id',
    }),
  });
  if (phase === 'complete') store.update(retained.id, { phase: 'complete', verifiedAt: 1 });
  const receipt = store.latest('removed-owner');
  store.close();
  const profiles = loadAccountProfiles();
  const binding = profiles.resolve('custom', 'offline-luna-fixture');
  let resourceProjection = () => loadAccountProfiles().openAIKeyResourceAccounts();
  const runtime = controller
    ? createConnectionsRuntime({
        directory,
        cli: 'not-executed-offline',
        workspace: 'offline',
        eligibleAccountIds: () => [],
        openAIKeyAccounts: () => loadAccountProfiles().openAIKeyManagementAccounts(),
        ...(resourceCallback ? { openAIKeyResourceAccounts: () => resourceProjection() } : {}),
        managedOpenAIAccountIds: [],
      })
    : null;
  setConnectionsRuntime(runtime);
  return {
    binding,
    profiles,
    reference,
    receipt,
    runtime,
    replaceReference(next: typeof reference) {
      configuration[0].credentialRef = next;
      writeFileSync(profilePath, JSON.stringify(configuration), { mode: 0o600 });
    },
    replaceProjection(projection: typeof resourceProjection) {
      resourceProjection = projection;
    },
    readReceipt() {
      const reopened = new OpenAIKeyOperationStore(join(directory, 'openai-key-operations.db'));
      try {
        return reopened.latest('removed-owner');
      } finally {
        reopened.close();
      }
    },
    close() {
      setConnectionsRuntime(null);
      runtime?.closeOpenAIKeyManagement?.();
      runtime?.store.close();
      runtime?.capabilityStore.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it.each([
  { phase: 'complete', resourceCallback: true },
  { phase: 'prepared', resourceCallback: true },
  { phase: 'complete', resourceCallback: false },
  { phase: 'prepared', resourceCallback: false },
] as const)(
  'blocks a custom alias of a removed account with $phase retained ownership and callback $resourceCallback before reading credentials',
  async ({ phase, resourceCallback }) => {
    const f = fixture(phase, true, true, resourceCallback);
    try {
      expect(f.profiles.openAIKeyManagementAccounts()).toEqual([]);
      const authority = openAIAccountKeyAuthority(f.binding, f.profiles, {
        consumer: 'host',
        endpoint,
      });
      await expect(authority.resolveKey('custom', signal())).rejects.toThrow(
        /recorded|reconciliation/,
      );
      expect(rawKey).not.toHaveBeenCalled();
      expect(f.readReceipt()).toEqual(f.receipt);
    } finally {
      f.close();
    }
  },
);
it('revalidates the selected source after readiness before any raw credential access', async () => {
  const f = fixture('prepared', false);
  try {
    const ready = f.runtime!.assertOpenAIKeyReady!.bind(f.runtime);
    vi.spyOn(f.runtime!, 'assertOpenAIKeyReady').mockImplementation(async (...args) => {
      await ready(...args);
      f.replaceReference({ ...ownedReference, account: 'changed-during-readiness' });
    });
    const authority = openAIAccountKeyAuthority(f.binding, f.profiles, {
      consumer: 'host',
      endpoint,
    });
    await expect(authority.resolveKey('custom', signal())).rejects.toThrow();
    expect(rawKey).not.toHaveBeenCalled();
    expect(f.readReceipt()).toEqual(f.receipt);
  } finally {
    f.close();
  }
});
it('checks the original selected resource when account configuration changes and returns during projection', async () => {
  const f = fixture('complete', true);
  try {
    f.replaceProjection(() => {
      f.replaceReference({ ...ownedReference, account: 'temporary-other-key' });
      const projected = loadAccountProfiles().openAIKeyResourceAccounts();
      f.replaceReference(ownedReference);
      return projected;
    });
    const authority = openAIAccountKeyAuthority(f.binding, f.profiles, {
      consumer: 'host',
      endpoint,
    });
    await expect(authority.resolveKey('custom', signal())).rejects.toThrow();
    expect(rawKey).not.toHaveBeenCalled();
    expect(f.readReceipt()).toEqual(f.receipt);
  } finally {
    f.close();
  }
});
it('allows a separately selected custom key without enrolling it or changing retained ownership', async () => {
  const f = fixture('prepared', false);
  try {
    expect(f.profiles.openAIKeyManagementAccounts()).toEqual([]);
    expect(f.profiles.isEnrolledOpenAIAccount('custom')).toBe(false);
    const authority = openAIAccountKeyAuthority(f.binding, f.profiles, {
      consumer: 'host',
      endpoint,
    });
    await expect(authority.resolveKey('custom', signal())).resolves.toBe('offline-selected-key');
    expect(rawKey).toHaveBeenCalledExactlyOnceWith(f.reference);
    expect(f.readReceipt()).toEqual(f.receipt);
  } finally {
    f.close();
  }
});
it('retains the durable alias fence when the entire controller is absent', () => {
  const f = fixture('prepared', true, false);
  try {
    expect(() =>
      openAIAccountKeyAuthority(f.binding, f.profiles, { consumer: 'host', endpoint }),
    ).toThrow('must be restored');
    expect(rawKey).not.toHaveBeenCalled();
    expect(f.readReceipt()).toEqual(f.receipt);
  } finally {
    f.close();
  }
});
