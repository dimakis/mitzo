import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenAIKeyManagement, type ManagedOpenAIAccount } from '../openai-key-management.js';
import { OpenAIKeyOperationStore } from '../openai-key-operation-store.js';

const signal = () => AbortSignal.timeout(5000);
const account: ManagedOpenAIAccount = {
  id: 'work',
  label: 'Work OpenAI API',
  credentialRef: { provider: 'keychain', service: 'test-openai', account: 'work' },
  providerName: 'work-api',
  providerId: 'provider-id',
};
const directories: string[] = [];
const stores: OpenAIKeyOperationStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openai-key-management-'));
  directories.push(directory);
  const path = join(directory, 'operations.db');
  const store = new OpenAIKeyOperationStore(path);
  stores.push(store);
  let saved: { value: string; version: string | null; managed?: boolean } = {
    value: 'old-key',
    version: null,
  };
  let gatewayVersion = '10';
  let gatewayKey = 'old-key';
  let accounts = [structuredClone(account)];
  const calls: string[] = [];
  const keychain = {
    read: vi.fn(async () => ({ ...saved })),
    write: vi.fn(async (_ref, value: string, version: string) => {
      calls.push('keychain');
      saved = { value, version };
    }),
  };
  const gateway = {
    inspect: vi.fn(async () => ({ version: gatewayVersion })),
    pause: vi.fn(async () => {
      calls.push('pause');
    }),
    replace: vi.fn(async (_account, value: string) => {
      calls.push('gateway');
      gatewayKey = value;
      gatewayVersion = String(Number(gatewayVersion) + 1);
      return { version: gatewayVersion };
    }),
  };
  const validateKey = vi.fn(async () => {
    calls.push('validate');
  });
  const options = {
    accounts: () => accounts,
    store,
    keychain,
    gateway,
    validateKey,
    gatewayBinding: 'test-gateway',
    workspace: 'default',
  };
  const manager = new OpenAIKeyManagement(options);
  const revision = async () => (await manager.list(signal()))[0]!.revision;
  const replace = async (key = 'new-key') =>
    manager.replace(
      {
        accountId: 'work',
        revision: await revision(),
        apiKey: key,
        sameProject: true,
      },
      signal(),
    );
  return {
    manager,
    store,
    path,
    directory,
    options,
    keychain,
    gateway,
    validateKey,
    calls,
    revision,
    replace,
    saved: () => saved,
    gatewayKey: () => gatewayKey,
    setAccounts: (value: ManagedOpenAIAccount[]) => {
      accounts = value;
    },
    driftGateway: () => {
      gatewayVersion = '99';
    },
    driftKeychain: () => {
      saved = { value: 'changed-externally', version: null, managed: true };
    },
  };
}
describe('OpenAI key replacement and recovery', () => {
  it('does not mistake an invalidated Keychain receipt for an untouched legacy key after a write interruption', async () => {
    const f = fixture();
    const update = f.store.update.bind(f.store);
    let interrupted = false;
    vi.spyOn(f.store, 'update').mockImplementation((id, fields) => {
      if (!interrupted && fields.phase === 'keychain_written') {
        interrupted = true;
        throw new Error('interrupted');
      }
      return update(id, fields);
    });
    await f.replace();
    f.driftKeychain();
    await f.manager.recover(signal());
    expect(f.store.pending()).toHaveLength(1);
    expect(f.gateway.replace).not.toHaveBeenCalled();
    await expect(f.manager.resolveKey('work', signal())).rejects.toThrow('need attention');
  });
  it('revalidates the account after draining and never writes into a changed credential binding', async () => {
    const f = fixture();
    f.gateway.pause.mockImplementationOnce(async () => {
      f.setAccounts([
        { ...account, credentialRef: { ...account.credentialRef, account: 'different' } },
      ]);
    });
    const result = await f.replace();
    expect(f.keychain.write).not.toHaveBeenCalled();
    expect(f.gateway.replace).not.toHaveBeenCalled();
    expect(result.health).toBe('needs_attention');
    expect(result.canSynchronize).toBe(false);
  });
  it('returns the same verified Keychain snapshot for host requests without a second unchecked read', async () => {
    const f = fixture();
    await f.replace();
    f.keychain.read.mockClear();
    expect(await f.manager.resolveKey('work', signal())).toBe('new-key');
    expect(f.keychain.read).toHaveBeenCalledTimes(1);
  });
  it('keeps the previous blocking intent if a superseding replacement fails before installation', async () => {
    const f = fixture();
    f.gateway.replace.mockRejectedValueOnce(new Error('offline'));
    await f.replace();
    const pendingId = f.store.pending()[0]!.id;
    f.validateKey.mockImplementationOnce(async () => {
      f.gateway.inspect.mockRejectedValueOnce(new Error('offline'));
    });
    await expect(f.replace('second-key')).rejects.toThrow();
    expect(f.store.pending().map((operation) => operation.id)).toEqual([pendingId]);
    await expect(f.manager.assertReady('work', signal())).rejects.toThrow('need attention');
  });
  it('keeps admission blocked when a superseding write aborts over an already unsynchronized key', async () => {
    const f = fixture();
    f.gateway.replace.mockRejectedValueOnce(new Error('offline'));
    await f.replace();
    f.keychain.write.mockRejectedValueOnce(new Error('locked'));
    await f.replace('second-key');
    await f.manager.recover(signal());
    expect((await f.manager.list(signal()))[0]!.health).toBe('needs_attention');
    await expect(f.manager.assertReady('work', signal())).rejects.toThrow('need attention');
  });
  it('can supersede a partial update with an explicitly entered replacement when the saved key changed', async () => {
    const f = fixture();
    f.gateway.replace.mockRejectedValueOnce(new Error('offline'));
    await f.replace();
    f.driftKeychain();
    expect((await f.manager.list(signal()))[0]!.canSynchronize).toBe(false);
    expect((await f.replace('explicit-replacement')).health).toBe('ready');
    expect(f.gatewayKey()).toBe('explicit-replacement');
  });
  it('restores committed intent from SQLite after closing and reopening the process-local store', async () => {
    const f = fixture();
    f.gateway.replace.mockRejectedValueOnce(new Error('offline'));
    await f.replace();
    f.store.close();
    const reopened = new OpenAIKeyOperationStore(f.path);
    stores.push(reopened);
    const restarted = new OpenAIKeyManagement({ ...f.options, store: reopened });
    expect((await restarted.list(signal()))[0]!.health).toBe('needs_attention');
    await expect(restarted.resolveKey('work', signal())).rejects.toThrow('need attention');
    await restarted.synchronize(
      {
        accountId: 'work',
        revision: (await restarted.list(signal()))[0]!.revision,
        sameProject: true,
      },
      signal(),
    );
    expect(await restarted.resolveKey('work', signal())).toBe('new-key');
  });
  it('validates before either write, pauses affected chats, and confirms both copies', async () => {
    const f = fixture();
    expect((await f.manager.list(signal()))[0]!.health).toBe('not_verified');
    const result = await f.replace();
    expect(result.health).toBe('ready');
    expect(f.calls).toEqual(['validate', 'pause', 'keychain', 'gateway']);
    expect(f.saved().value).toBe('new-key');
    expect(f.gatewayKey()).toBe('new-key');
    expect(result).not.toHaveProperty('credentialRef');
    expect(JSON.stringify(result)).not.toContain('new-key');
    expect(readFileSync(f.path).includes(Buffer.from('new-key'))).toBe(false);
    expect(f.store.pending()).toEqual([]);
  });
  it('leaves both credentials untouched when validation fails and redacts upstream errors', async () => {
    const f = fixture();
    f.validateKey.mockRejectedValueOnce(new Error('bad-key secret in response'));
    await expect(f.replace('bad-key')).rejects.toThrow('OpenAI key validation failed');
    expect(f.keychain.write).not.toHaveBeenCalled();
    expect(f.gateway.replace).not.toHaveBeenCalled();
    expect(f.store.pending()).toEqual([]);
  });
  it('requires the explicit same-project confirmation and rejects a stale form', async () => {
    const f = fixture();
    await expect(
      f.manager.replace(
        { accountId: 'work', revision: await f.revision(), apiKey: 'key', sameProject: false },
        signal(),
      ),
    ).rejects.toThrow('Confirm the same work project');
    const revision = await f.revision();
    f.driftGateway();
    await expect(
      f.manager.replace(
        { accountId: 'work', revision, apiKey: 'key', sameProject: true },
        signal(),
      ),
    ).rejects.toThrow('Connection changed');
    expect(f.validateKey).not.toHaveBeenCalled();
  });
  it('does not manage a shared Keychain item or provider without affecting other accounts', async () => {
    const f = fixture();
    f.setAccounts([
      account,
      { ...account, id: 'other', providerName: 'other-api', providerId: 'other-id' },
    ]);
    await expect(
      f.manager.replace(
        { accountId: 'work', revision: 'any', apiKey: 'key', sameProject: true },
        signal(),
      ),
    ).rejects.toThrow('Shared credentials require separate configuration');
    expect(f.keychain.write).not.toHaveBeenCalled();
  });
  it('makes a partial gateway failure visible and needs attended synchronization after restart', async () => {
    const f = fixture();
    f.gateway.replace.mockRejectedValueOnce(new Error('new-key leaked by CLI'));
    const result = await f.replace();
    expect(result.health).toBe('needs_attention');
    expect(result.canSynchronize).toBe(true);
    expect(result.errorCode).toBe('SYNC_PENDING');
    expect(f.saved().value).toBe('new-key');
    expect(f.gatewayKey()).toBe('old-key');
    const restarted = new OpenAIKeyManagement(f.options);
    await restarted.recover(signal());
    expect(f.gateway.replace).toHaveBeenCalledTimes(1);
    await expect(restarted.assertReady('work', signal())).rejects.toThrow(
      'OpenAI credentials need attention',
    );
    const repaired = await restarted.synchronize(
      {
        accountId: 'work',
        revision: (await restarted.list(signal()))[0]!.revision,
        sameProject: true,
      },
      signal(),
    );
    expect(repaired.health).toBe('ready');
    expect(f.gatewayKey()).toBe('new-key');
    expect(f.keychain.write).toHaveBeenCalledTimes(1);
  });
  it('recovers a crash after the atomic Keychain write without persisting a raw key', async () => {
    const f = fixture();
    const update = f.store.update.bind(f.store);
    let crashed = false;
    vi.spyOn(f.store, 'update').mockImplementation((id, fields) => {
      if (!crashed && fields.phase === 'keychain_written') {
        crashed = true;
        throw new Error('crash');
      }
      return update(id, fields);
    });
    expect((await f.replace()).health).toBe('needs_attention');
    expect(f.gateway.replace).not.toHaveBeenCalled();
    const restarted = new OpenAIKeyManagement(f.options);
    await restarted.recover(signal());
    expect((await restarted.list(signal()))[0]!.health).toBe('ready');
    expect(f.gatewayKey()).toBe('new-key');
  });
  it('does not replay a pending operation into changed account, gateway, or Keychain bindings', async () => {
    const f = fixture();
    f.gateway.replace.mockRejectedValueOnce(new Error('offline'));
    await f.replace();
    f.setAccounts([{ ...account, providerId: 'replacement-provider' }]);
    const restarted = new OpenAIKeyManagement(f.options);
    await restarted.recover(signal());
    expect(f.gateway.replace).toHaveBeenCalledTimes(1);
    expect((await restarted.list(signal()))[0]!.health).toBe('needs_attention');
    expect((await restarted.list(signal()))[0]!.canSynchronize).toBe(false);
  });
  it('does not report ready when the gateway drifts after a completed replacement', async () => {
    const f = fixture();
    await f.replace();
    f.driftGateway();
    expect((await f.manager.list(signal()))[0]!.health).toBe('needs_attention');
    await expect(f.manager.assertReady('work', signal())).rejects.toThrow(
      'OpenAI credentials need attention',
    );
  });
  it('aborts an uncommitted operation after Keychain failure, permitting a fresh replacement', async () => {
    const f = fixture();
    f.keychain.write.mockRejectedValueOnce(new Error('locked'));
    expect((await f.replace()).health).toBe('needs_attention');
    await f.manager.recover(signal());
    expect(f.store.pending()).toEqual([]);
    expect(f.gateway.replace).not.toHaveBeenCalled();
    expect((await f.replace()).health).toBe('ready');
  });
});

it('requires fresh key entry after a completed receipt is invalidated by an external Keychain edit', async () => {
  const f = fixture();
  await f.replace();
  f.driftKeychain();
  const state = (await f.manager.list(signal()))[0]!;
  expect(state.health).toBe('needs_attention');
  expect(state.canSynchronize).toBe(false);
  const writes = f.gateway.replace.mock.calls.length;
  await expect(
    f.manager.synchronize(
      { accountId: 'work', revision: state.revision, sameProject: true },
      signal(),
    ),
  ).rejects.toThrow('Replacement key must be entered again');
  expect(f.gateway.replace).toHaveBeenCalledTimes(writes);
  expect((await f.replace('attended-key')).health).toBe('ready');
});
