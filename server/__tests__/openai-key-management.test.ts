import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  OpenAIKeyManagement,
  OpenAIKeychainAuthorizationRequired,
  type ManagedOpenAIAccount,
} from '../openai-key-management.js';
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
    inspect: vi.fn(async (_account: ManagedOpenAIAccount, _signal: AbortSignal) => ({
      version: gatewayVersion,
    })),
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
  it.each(['credential', 'provider id', 'provider name'])(
    'blocks an unjournaled account reusing a recorded %s after the owning account is removed',
    async (shared) => {
      const f = fixture();
      f.gateway.replace.mockRejectedValueOnce(new Error('interrupted'));
      await f.replace();
      const alias = {
        ...account,
        id: 'alias',
        credentialRef:
          shared === 'credential'
            ? account.credentialRef
            : { ...account.credentialRef, account: 'other' },
        providerId: shared === 'provider id' ? account.providerId : 'other-id',
        providerName: shared === 'provider name' ? account.providerName : 'other-api',
      };
      f.setAccounts([alias]);
      const reopened = new OpenAIKeyOperationStore(f.path);
      stores.push(reopened);
      const restarted = new OpenAIKeyManagement({
        ...f.options,
        store: reopened,
        managedAccountIds: [],
      });
      f.keychain.read.mockClear();
      f.gateway.inspect.mockClear();
      await expect(restarted.assertReady('alias', signal())).rejects.toThrow('recorded');
      expect(f.keychain.read).not.toHaveBeenCalled();
      expect(f.gateway.inspect).not.toHaveBeenCalled();
      const enrolled = new OpenAIKeyManagement({ ...f.options, managedAccountIds: ['alias'] });
      await expect(enrolled.resolveKey('alias', signal())).rejects.toThrow('recorded');
    },
  );
  it('does not authorize a new account ID after a completed credential receipt drifts', async () => {
    const f = fixture();
    await f.replace();
    f.driftKeychain();
    f.setAccounts([{ ...account, id: 'alias' }]);
    await expect(f.manager.assertReady('alias', signal())).rejects.toThrow('recorded');
  });
  it('preserves an older journal and refuses unproven aliases without deleting its intent', async () => {
    const f = fixture();
    const oldPath = join(f.directory, 'old.db');
    const old = new Database(oldPath);
    old.exec(`CREATE TABLE openai_key_operations (
      id TEXT PRIMARY KEY, accountId TEXT NOT NULL, binding TEXT NOT NULL,
      phase TEXT NOT NULL, gatewayVersion TEXT NOT NULL, keychainBeforeVersion TEXT,
      errorCode TEXT, verifiedAt INTEGER, revision INTEGER NOT NULL, createdAt INTEGER NOT NULL
    ); INSERT INTO openai_key_operations VALUES ('old-operation','removed','old-binding','gateway_started','10',NULL,'SYNC_PENDING',NULL,1,0);`);
    old.close();
    const migrated = new OpenAIKeyOperationStore(oldPath);
    stores.push(migrated);
    const manager = new OpenAIKeyManagement({ ...f.options, store: migrated });
    await expect(manager.assertReady('work', signal())).rejects.toThrow('recorded');
    expect(migrated.pending()).toMatchObject([
      {
        id: 'old-operation',
        accountId: 'removed',
        phase: 'gateway_started',
        gatewayVersion: '10',
        credentialBinding: null,
      },
    ]);
    expect(f.keychain.read).not.toHaveBeenCalled();
    expect(f.gateway.inspect).not.toHaveBeenCalled();
  });
  it('preserves admission for unrelated legacy accounts alongside recorded rotation intent', async () => {
    const f = fixture();
    f.gateway.replace.mockRejectedValueOnce(new Error('interrupted'));
    await f.replace();
    f.setAccounts([
      {
        ...account,
        id: 'other',
        credentialRef: { ...account.credentialRef, account: 'other' },
        providerId: 'other-id',
        providerName: 'other-api',
      },
    ]);
    f.keychain.read.mockClear();
    await expect(f.manager.assertReady('other', signal())).resolves.toBeUndefined();
    expect(f.keychain.read).not.toHaveBeenCalled();
  });
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
    expect(f.store.latest('work')).toMatchObject({
      phase: 'aborted',
      errorCode: 'ACCOUNT_CHANGED',
    });
    await expect(f.manager.resolveKey('work', signal())).rejects.toThrow('need attention');
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
    await expect(f.replace('bad-key')).rejects.toThrow('KEY_VALIDATION_FAILED');
    expect(f.keychain.write).not.toHaveBeenCalled();
    expect(f.gateway.replace).not.toHaveBeenCalled();
    expect(f.store.pending()).toEqual([]);
  });
  it('accepts a validated replacement without a project assertion and still rejects a stale form', async () => {
    const f = fixture();
    await expect(
      f.manager.replace(
        { accountId: 'work', revision: await f.revision(), apiKey: 'key' },
        signal(),
      ),
    ).resolves.toMatchObject({ health: 'ready' });
    f.validateKey.mockClear();
    const revision = await f.revision();
    f.driftGateway();
    await expect(
      f.manager.replace(
        { accountId: 'work', revision, apiKey: 'key', sameProject: true },
        signal(),
      ),
    ).rejects.toThrow('ACCOUNT_CHANGED');
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
    expect(result.errorCode).toBe('CHAT_UPDATE_UNCONFIRMED');
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

it('only advertises key management for configured rotation accounts, even when an enrolled ID is selected', async () => {
  const f = fixture();
  const manager = new OpenAIKeyManagement({
    ...f.options,
    managedAccountIds: ['work', 'enrolled'],
  });
  expect(manager.manages('work')).toBe(true);
  expect(manager.manages('enrolled')).toBe(false);
  expect((await manager.list(signal())).map((account) => account.accountId)).toEqual(['work']);
  f.setAccounts([]);
  expect(manager.manages('work')).toBe(false);
});

it('lists an authorization-needed account without invoking interactive Keychain access, and fences stale authorization', async () => {
  const f = fixture();
  let authorized = false;
  const authorize = vi.fn(async () => {
    authorized = true;
  });
  f.keychain.read.mockImplementation(async () => {
    if (!authorized) throw new OpenAIKeychainAuthorizationRequired();
    return { value: 'old-key', version: null };
  });
  const manager = new OpenAIKeyManagement({ ...f.options, keychain: { ...f.keychain, authorize } });
  const [status] = await manager.list(signal());
  expect(status).toMatchObject({
    health: 'unavailable',
    errorCode: 'KEYCHAIN_AUTHORIZATION_REQUIRED',
    canSynchronize: false,
  });
  expect(status!.revision).not.toBe('');
  expect(authorize).not.toHaveBeenCalled();
  await expect(
    manager.authorize({ accountId: 'work', revision: 'stale' }, signal()),
  ).rejects.toThrow('ACCOUNT_CHANGED');
  expect(authorize).not.toHaveBeenCalled();
  const result = await manager.authorize(
    { accountId: 'work', revision: status!.revision },
    signal(),
  );
  expect(result.health).toBe('not_verified');
  expect(authorize).toHaveBeenCalledExactlyOnceWith(account.credentialRef, expect.any(AbortSignal));
  expect(f.validateKey).not.toHaveBeenCalled();
  expect(f.keychain.write).not.toHaveBeenCalled();
  expect(f.gateway.pause).not.toHaveBeenCalled();
});

it('reports an unsafe chat drain without writing credentials or offering saved-key recovery', async () => {
  const f = fixture();
  f.gateway.pause.mockRejectedValueOnce(new Error('PRIVATE_NATIVE_FAILURE'));
  const result = await f.replace();
  expect(result).toMatchObject({ health: 'not_verified', errorCode: 'CHAT_PAUSE_FAILED' });
  expect(f.keychain.write).not.toHaveBeenCalled();
  expect(f.gateway.replace).not.toHaveBeenCalled();
  expect(f.store.pending()).toHaveLength(0);
  await f.manager.recover(signal());
  expect((await f.manager.list(signal()))[0]!.errorCode).toBe('CHAT_PAUSE_FAILED');
});

it('preserves the previous verified key when a later replacement cannot drain chats', async () => {
  const f = fixture();
  await f.replace();
  f.keychain.write.mockClear();
  f.gateway.replace.mockClear();
  f.gateway.pause.mockRejectedValueOnce(new Error('unsafe drain'));
  const result = await f.replace('second-key');
  expect(result).toMatchObject({ health: 'ready', errorCode: 'CHAT_PAUSE_FAILED' });
  expect(f.keychain.write).not.toHaveBeenCalled();
  expect(f.gateway.replace).not.toHaveBeenCalled();
  expect(await f.manager.resolveKey('work', signal())).toBe('new-key');
});

it('returns the journaled not-saved result when the deadline expires during chat drain', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.gateway.inspect.mockImplementation(async (_account, signal) => {
    signal.throwIfAborted();
    return { version: '10' };
  });
  f.gateway.pause.mockImplementationOnce(async () => {
    controller.abort();
    controller.signal.throwIfAborted();
  });
  const result = await f.manager.replace(
    { accountId: 'work', revision: await f.revision(), apiKey: 'new-key' },
    controller.signal,
  );
  expect(result).toMatchObject({
    health: 'not_verified',
    errorCode: 'CHAT_PAUSE_FAILED',
    revision: '',
    canSynchronize: false,
  });
  expect(f.keychain.write).not.toHaveBeenCalled();
  expect(f.gateway.replace).not.toHaveBeenCalled();
  expect(f.store.latest('work')).toMatchObject({
    phase: 'aborted',
    errorCode: 'CHAT_PAUSE_FAILED',
  });
});

it('returns a definite not-saved result if the deadline expires in the Keychain read after drain', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.gateway.pause.mockImplementationOnce(async () => {
    f.keychain.read.mockImplementationOnce(async () => {
      controller.abort();
      controller.signal.throwIfAborted();
      return f.saved();
    });
  });
  f.gateway.inspect.mockImplementation(async (_account, signal) => {
    signal.throwIfAborted();
    return { version: '10' };
  });
  const result = await f.manager.replace(
    { accountId: 'work', revision: await f.revision(), apiKey: 'new-key' },
    controller.signal,
  );
  expect(result).toMatchObject({
    errorCode: 'ACCOUNT_CHANGED',
    revision: '',
    canSynchronize: false,
  });
  expect(f.store.latest('work')).toMatchObject({ phase: 'aborted', errorCode: 'ACCOUNT_CHANGED' });
  expect(f.store.pending()).toHaveLength(0);
  expect(f.keychain.write).not.toHaveBeenCalled();
  expect(f.gateway.replace).not.toHaveBeenCalled();
});

it('keeps a legacy key changed outside Mitzo blocked after a definite pre-write abort', async () => {
  const f = fixture();
  f.gateway.pause.mockImplementationOnce(async () => {
    f.keychain.read.mockResolvedValue({
      value: 'externally-changed',
      version: null,
      managed: false,
    });
  });
  const result = await f.replace();
  expect(result).toMatchObject({
    health: 'needs_attention',
    errorCode: 'ACCOUNT_CHANGED',
    canSynchronize: false,
  });
  expect(f.store.latest('work')).toMatchObject({ phase: 'aborted' });
  expect(f.keychain.write).not.toHaveBeenCalled();
  expect(f.gateway.replace).not.toHaveBeenCalled();
  await expect(f.manager.resolveKey('work', signal())).rejects.toThrow('need attention');
});

it('preserves unresolved legacy drift across failed retries and restart until replacement completes', async () => {
  const f = fixture();
  let external = true;
  f.gateway.pause.mockImplementationOnce(async () => {
    f.keychain.read.mockImplementation(async () =>
      external ? { value: 'externally-changed', version: null, managed: false } : f.saved(),
    );
  });
  await f.replace();
  for (let attempt = 0; attempt < 2; attempt++) {
    f.gateway.pause.mockRejectedValueOnce(new Error('unsafe drain'));
    expect(await f.replace()).toMatchObject({
      health: 'needs_attention',
      canSynchronize: false,
    });
    expect(f.store.latest('work')).toMatchObject({
      phase: 'aborted',
      errorCode: 'CHAT_PAUSE_FAILED',
    });
    await expect(f.manager.resolveKey('work', signal())).rejects.toThrow('need attention');
  }
  const reopened = new OpenAIKeyOperationStore(f.path);
  stores.push(reopened);
  const restarted = new OpenAIKeyManagement({ ...f.options, store: reopened });
  expect((await restarted.list(signal()))[0]).toMatchObject({
    health: 'needs_attention',
    canSynchronize: false,
  });
  await expect(restarted.assertReady('work', signal())).rejects.toThrow('need attention');
  await expect(
    restarted.synchronize({ accountId: 'work', revision: await f.revision() }, signal()),
  ).rejects.toThrow('Replacement key must be entered again');
  expect(f.keychain.write).not.toHaveBeenCalled();
  const write = f.keychain.write.getMockImplementation()!;
  f.keychain.write.mockImplementationOnce(async (_ref, value, version) => {
    external = false;
    await write(_ref, value, version);
  });
  f.gateway.replace.mockRejectedValueOnce(new Error('interrupted gateway update'));
  expect(await f.replace('verified-replacement')).toMatchObject({
    health: 'needs_attention',
    canSynchronize: true,
  });
  await expect(restarted.assertReady('work', signal())).rejects.toThrow('need attention');
  expect(
    await restarted.synchronize({ accountId: 'work', revision: await f.revision() }, signal()),
  ).toMatchObject({ health: 'ready' });
  expect(await restarted.resolveKey('work', signal())).toBe('verified-replacement');
});
