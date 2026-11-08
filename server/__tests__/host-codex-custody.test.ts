import './fixtures/offline-user-home.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConversationStore } from '../codex-conversation-store.js';
import type { HostCodexCustody } from '../host-codex-custody.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const binding = {
  accountId: 'personal',
  accountLabel: 'Personal',
  provider: 'openai-codex' as const,
  profileRevision: 'profile',
  model: 'fixture-model',
};
function snapshot(): HostCodexCustody {
  const identity = { dev: 1, ino: 2 },
    auth = { ...identity, sha256: 'a'.repeat(64) };
  const directory = { dev: '1', ino: '2', uid: '1', mode: '448' };
  const metadata = {
    ...directory,
    size: '7',
    mtimeNs: '1',
    ctimeNs: '1',
    nlink: '1',
    sha256: 'b'.repeat(64),
  };
  return {
    version: 1,
    authSessionId: 'original-login',
    bootstrapId: 'c'.repeat(64),
    login: {
      privateHome: '/private/home',
      sourcePath: '/private/source',
      sourceRoot: identity,
      sourceAuth: auth,
      homeRoot: identity,
      homeAuth: auth,
    },
    executable: {
      path: '/private/home/codex-runtime',
      source: '/private/codex',
      sha256: metadata.sha256,
      sourceIdentity: metadata,
      ownedIdentity: metadata,
      sourceDirectory: directory,
      ownedDirectory: directory,
    },
  };
}
it('retains original operator and physical custody across reopened competing native stores', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-custody-store-'));
  roots.push(root);
  const path = join(root, 'native.db'),
    first = new CodexConversationStore(path),
    second = new CodexConversationStore(path);
  try {
    first.create('session', binding, '/task');
    first.setHostCustody('session', binding, snapshot());
    first.bindThread('session', binding, 'original-thread');
    expect(second.readHostCustody('session', binding)).toEqual(snapshot());
    second.setHostCustody('session', binding, snapshot());
    expect(() =>
      second.setHostCustody('session', binding, { ...snapshot(), authSessionId: 'other-login' }),
    ).toThrow();
    expect(() => second.readHostCustody('session', { ...binding, model: 'other' })).toThrow();
    expect(first.read('session', binding).threadId).toBe('original-thread');
  } finally {
    first.close();
    second.close();
  }
  const reopened = new CodexConversationStore(path);
  try {
    expect(reopened.readHostCustody('session', binding)?.authSessionId).toBe('original-login');
  } finally {
    reopened.close();
  }
});
it('persists shared code custody across restart without allowing retained conversations to rebind it', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-shared-custody-store-'));
  roots.push(root);
  const path = join(root, 'native.db');
  const original = snapshot();
  original.login.privateHome = '/private/runtime/host-login-original';
  original.executable.path = '/private/runtime/host-runtime-ABC123/codex-runtime';
  original.executable.sharedPlacement = {
    kind: 'shared-runtime-v1',
    privateRoot: '/private/runtime',
    rootIdentity: { dev: '1', ino: '3', uid: '1', mode: '448' },
  };
  const first = new CodexConversationStore(path);
  first.create('session', binding, '/task');
  first.setHostCustody('session', binding, original);
  first.bindThread('session', binding, 'same-thread');
  first.close();
  const reopened = new CodexConversationStore(path);
  try {
    expect(reopened.readHostCustody('session', binding)).toEqual(original);
    expect(() => reopened.setHostCustody('session', binding, original)).not.toThrow();
    const replacement = structuredClone(original);
    replacement.executable.path = '/private/runtime/host-runtime-DEF456/codex-runtime';
    expect(() => reopened.setHostCustody('session', binding, replacement)).toThrow(
      'cannot be replaced',
    );
    const relabelled = structuredClone(original);
    delete relabelled.executable.sharedPlacement;
    expect(() => reopened.setHostCustody('session', binding, relabelled)).toThrow(
      'cannot be replaced',
    );
    expect(reopened.readHostCustody('session', binding)).toEqual(original);
    expect(reopened.read('session', binding).threadId).toBe('same-thread');
  } finally {
    reopened.close();
  }
});
it('refuses unjournaled companion custody and preserves existing conversation custody', () => {
  const store = new CodexConversationStore(':memory:');
  try {
    store.create('retained', binding, '/task');
    const original = snapshot();
    store.setHostCustody('retained', binding, original);
    store.bindThread('retained', binding, 'same-thread');
    const helper = {
      ...original.executable,
      path: '/private/home/codex-code-mode-host',
      source: '/private/codex-code-mode-host',
    };
    const upgraded = { ...original, executable: { ...original.executable, codeModeHost: helper } };
    expect(() => store.setHostCustody('retained', binding, upgraded)).toThrow();
    expect(store.readHostCustody('retained', binding)).toEqual(original);
    expect(store.read('retained', binding).threadId).toBe('same-thread');
    expect(() => store.setHostCustody('retained', binding, original)).not.toThrow();
    expect(() =>
      store.setHostCustody('retained', binding, { ...upgraded, authSessionId: 'other' }),
    ).toThrow();
    expect(() =>
      store.setHostCustody('retained', binding, {
        ...upgraded,
        executable: {
          ...upgraded.executable,
          codeModeHost: { ...helper, sha256: 'f'.repeat(64) },
        },
      }),
    ).toThrow();
  } finally {
    store.close();
  }
});
it('refuses to invent custody for legacy native history or queued commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-custody-legacy-'));
  roots.push(root);
  const store = new CodexConversationStore(join(root, 'native.db'));
  try {
    store.create('history', binding, '/task');
    store.bindThread('history', binding, 'legacy-thread');
    expect(store.readHostCustody('history', binding)).toBeNull();
    expect(() => store.setHostCustody('history', binding, snapshot())).toThrow();
    store.create('queue', binding, '/task');
    store.enqueue('queue', binding, { id: 'queued', prompt: 'Original', model: binding.model });
    expect(() => store.setHostCustody('queue', binding, snapshot())).toThrow();
  } finally {
    store.close();
  }
});

it('reauthorizes only the exact reviewed legacy login while preserving native history and queued work', async () => {
  const { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } =
    await import('node:fs');
  const { vi } = await import('vitest');
  const { refreshedAuth, signingKey } = await import('./fixtures/codex-refresh-auth.js');
  const { FrozenHostCodexLogin } = await import('../frozen-host-codex-login.js');
  const { HostCodexLoginReauthorization } = await import('../host-codex-login-reauthorization.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-login-reauthorize-')));
  roots.push(root);
  const source = join(root, 'source'),
    privateRoot = join(root, 'private');
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(privateRoot, { mode: 0o700 });
  const epoch = Math.floor(Date.now() / 1000) - 60;
  writeFileSync(join(source, 'auth.json'), refreshedAuth(epoch), { mode: 0o600 });
  const profile = {
    accountId: binding.accountId,
    accountLabel: binding.accountLabel,
    credentialRef: source,
    email: 'person@example.test',
    planType: 'plus',
    model: binding.model,
  };
  const { codexAccountBinding } = await import('../codex-account.js');
  const realBinding = codexAccountBinding(profile);
  const captured = FrozenHostCodexLogin.capture(profile, { privateRoot });
  expect(captured.custodySnapshot().refreshProof).toBeDefined();
  const legacy = captured.custodySnapshot();
  delete legacy.refreshProof;
  const original = { ...snapshot(), login: legacy };
  writeFileSync(join(source, 'auth.json'), refreshedAuth(epoch + 30));
  writeFileSync(join(legacy.privateHome, 'auth.json'), refreshedAuth(epoch + 20));
  const privateBefore = readFileSync(join(legacy.privateHome, 'auth.json'), 'utf8');
  const keys = [
    {
      ...signingKey.publicKey.export({ format: 'jwk' }),
      kid: 'fixture-key',
      alg: 'RS256',
      use: 'sig',
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: URL) =>
        new Response(
          JSON.stringify(
            String(url).endsWith('openid-configuration')
              ? { issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/test-keys' }
              : { keys },
          ),
        ),
    ),
  );
  const store = new CodexConversationStore(join(root, 'native.db'));
  try {
    store.create('retained', realBinding, '/task');
    store.setHostCustody('retained', realBinding, original);
    store.bindThread('retained', realBinding, 'original-thread');
    store.enqueue('retained', realBinding, {
      id: 'saved',
      prompt: 'Original input',
      model: binding.model,
    });
    let interruptAfterArtifact = false;
    let authorizationCurrent = true;
    let artifact = '';
    const operator = {
      assertOffline: vi.fn(),
      assertCurrent: vi.fn(() => {
        if (!authorizationCurrent || (interruptAfterArtifact && existsSync(artifact)))
          throw Error('operator authority unavailable');
      }),
    };
    const prepare = () =>
      HostCodexLoginReauthorization.prepare(
        profile,
        original,
        operator,
        new AbortController().signal,
      );
    // Historical identity does not grant live account authority. The current
    // source must remain usable even when the retained private login expired.
    writeFileSync(join(legacy.privateHome, 'auth.json'), refreshedAuth(epoch - 7200));
    await expect(prepare()).resolves.toBeDefined();
    writeFileSync(join(source, 'auth.json'), refreshedAuth(epoch - 7200));
    await expect(prepare()).rejects.toThrow();
    writeFileSync(join(source, 'auth.json'), refreshedAuth(epoch + 30));
    keys.push({ ...keys[0], kid: 'later-key' });
    writeFileSync(
      join(legacy.privateHome, 'auth.json'),
      refreshedAuth(epoch - 7200, {}, signingKey, 'later-key'),
    );
    await expect(prepare()).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(4);
    writeFileSync(join(legacy.privateHome, 'auth.json'), privateBefore);
    const operation = await HostCodexLoginReauthorization.prepare(
      profile,
      original,
      operator,
      new AbortController().signal,
    );
    artifact = join(legacy.privateHome, `login-refresh-${operation.operationId}.json`);
    const profilePath = join(root, 'profiles.json');
    writeFileSync(
      profilePath,
      JSON.stringify([
        {
          id: profile.accountId,
          label: profile.accountLabel,
          provider: 'openai-codex',
          credentialRef: source,
          email: profile.email,
          planType: profile.planType,
          models: [{ id: profile.model, label: 'Fixture' }],
        },
      ]),
    );
    const { reauthorizeHostLogins, planLegacyHostLogins, applyLegacyHostLoginPlan } =
      await import('../host-codex-login-recovery-command.js');
    store.create('blocked-legacy', realBinding, '/task');
    store.setHostCustody('blocked-legacy', realBinding, {
      ...original,
      login: { ...legacy, sourceAuth: { ...legacy.sourceAuth, ino: legacy.sourceAuth.ino + 1 } },
    });
    store.create('no-login-custody', realBinding, '/task');
    const secondLogin = FrozenHostCodexLogin.capture(profile, { privateRoot }).custodySnapshot();
    delete secondLogin.refreshProof;
    store.create('second-retained', realBinding, '/second-task');
    store.setHostCustody('second-retained', realBinding, { ...original, login: secondLogin });
    store.bindThread('second-retained', realBinding, 'second-original-thread');
    store.enqueue('second-retained', realBinding, {
      id: 'second-queued',
      prompt: 'Keep this input',
      model: binding.model,
    });
    const secondCommands = store.commands('second-retained', realBinding);
    const beforeBatch = store.commands('retained', realBinding);
    const batch = await planLegacyHostLogins({
      database: join(root, 'native.db'),
      profiles: profilePath,
    });
    expect(batch.plan).toMatchObject([
      { conversationId: 'retained', operationId: operation.operationId, status: 'review_required' },
      { conversationId: 'second-retained', status: 'review_required' },
    ]);
    expect(batch.blocked).toEqual([
      { conversationId: 'blocked-legacy', code: 'login_reauthorization_refused' },
    ]);
    expect(batch.scanned).toBe(4);
    expect(batch.eligible).toBe(2);
    expect(store.commands('retained', realBinding)).toEqual(beforeBatch);
    expect(store.readHostCustody('retained', realBinding)).toEqual(original);
    expect(existsSync(artifact)).toBe(false);
    const refusedBatch = await applyLegacyHostLoginPlan({
      database: join(root, 'native.db'),
      profiles: profilePath,
      approvedPlan: batch,
      assertOffline: () => {
        throw Error('live database');
      },
    });
    expect(refusedBatch).toMatchObject({
      status: 'incomplete',
      results: [],
      stoppedAt: 'retained',
      remaining: 2,
    });
    expect(existsSync(artifact)).toBe(false);
    const gate = vi.fn();
    const preview = await reauthorizeHostLogins({
      database: join(root, 'native.db'),
      profiles: profilePath,
      conversations: ['retained'],
      assertOffline: gate,
    });
    expect(preview[0]).toMatchObject({
      conversationId: 'retained',
      operationId: operation.operationId,
      status: 'review_required',
    });
    expect(gate).not.toHaveBeenCalled();
    expect(existsSync(artifact)).toBe(false);
    const { default: Database } = await import('better-sqlite3');
    const inspect = new Database(join(root, 'native.db'), { readonly: true });
    const schemaBefore = inspect.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
    await expect(
      reauthorizeHostLogins({
        database: join(root, 'native.db'),
        profiles: profilePath,
        conversations: ['retained'],
        approvedPlan: preview,
        assertOffline: () => {
          throw Error('selected runtime still owns database');
        },
      }),
    ).rejects.toThrow();
    expect(inspect.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(
      schemaBefore,
    );
    inspect.close();
    expect(existsSync(artifact)).toBe(false);
    expect(operation.summary()).toMatchObject({
      accountId: binding.accountId,
      email: profile.email,
      planType: 'plus',
    });
    expect(JSON.stringify(operation.summary())).not.toMatch(
      /synthetic-access|synthetic-refresh|id_token/,
    );
    expect(() =>
      store.reauthorizeHostLogin('retained', realBinding, operation, 'not-the-reviewed-plan'),
    ).toThrow();
    expect(store.readHostCustody('retained', realBinding)).toEqual(original);
    authorizationCurrent = false;
    expect(() =>
      store.reauthorizeHostLogin('retained', realBinding, operation, operation.operationId),
    ).toThrow();
    authorizationCurrent = true;
    store.claimNext('retained', realBinding);
    expect(() =>
      store.reauthorizeHostLogin('retained', realBinding, operation, operation.operationId),
    ).toThrow();
    store.finish('retained', realBinding, 'saved', 'interrupted', undefined, true);
    store.enqueue('retained', realBinding, {
      id: 'later',
      prompt: 'Queued input',
      model: binding.model,
    });
    const commands = store.commands('retained', realBinding);
    const recovery = store.read('retained', realBinding).recovery;
    interruptAfterArtifact = true;
    expect(() =>
      store.reauthorizeHostLogin('retained', realBinding, operation, operation.operationId),
    ).toThrow();
    expect(existsSync(artifact)).toBe(true);
    expect(store.readHostCustody('retained', realBinding)).toEqual(original);
    expect(store.hostLoginReauthorizations('retained', realBinding)).toMatchObject([
      { completedAt: null },
    ]);
    interruptAfterArtifact = false;
    const completeArtifact = readFileSync(artifact);
    writeFileSync(artifact, 'unrelated artifact');
    expect(() =>
      store.reauthorizeHostLogin('retained', realBinding, operation, operation.operationId),
    ).toThrow();
    expect(readFileSync(artifact, 'utf8')).toBe('unrelated artifact');
    // Model interruption during the unreferenced file write while the exact
    // intent remains pending; completing this owned prefix must be retryable.
    writeFileSync(artifact, completeArtifact.subarray(0, 64));
    const [result] = await reauthorizeHostLogins({
      database: join(root, 'native.db'),
      profiles: profilePath,
      conversations: ['retained'],
      approvedPlan: preview,
      assertOffline: gate,
    });
    expect(result.status).toBe('completed');
    expect(gate).toHaveBeenCalled();
    const updated = store.readHostCustody('retained', realBinding)!;
    expect(updated).toEqual({
      ...original,
      login: { ...legacy, refreshProof: expect.any(Object) },
    });
    expect(store.commands('retained', realBinding)).toEqual(commands);
    expect(store.read('retained', realBinding).recovery).toBe(recovery);
    expect(store.commands('retained', realBinding).map(({ status }) => status)).toEqual([
      'interrupted',
      'queued',
    ]);
    expect(store.read('retained', realBinding).threadId).toBe('original-thread');
    expect(readFileSync(join(legacy.privateHome, 'auth.json'), 'utf8')).toBe(privateBefore);
    expect(() => FrozenHostCodexLogin.reopen(profile, updated.login)).not.toThrow();
    expect(
      store.reauthorizeHostLogin('retained', realBinding, operation, operation.operationId).status,
    ).toBe('already_completed');
    expect(store.hostLoginReauthorizations('retained', realBinding)).toHaveLength(1);
    expect(operator.assertCurrent).toHaveBeenCalled();
    expect(
      await applyLegacyHostLoginPlan({
        database: join(root, 'native.db'),
        profiles: profilePath,
        approvedPlan: batch,
        assertOffline: gate,
      }),
    ).toMatchObject({
      status: 'completed',
      results: [
        { conversationId: 'retained', status: 'already_completed' },
        { conversationId: 'second-retained', status: 'completed' },
      ],
      blocked: batch.blocked,
    });
    expect(store.readHostCustody('blocked-legacy', realBinding)?.login).not.toHaveProperty(
      'refreshProof',
    );
    expect(store.commands('second-retained', realBinding)).toEqual(secondCommands);
    expect(store.read('second-retained', realBinding).threadId).toBe('second-original-thread');
    const remainingLegacy = await planLegacyHostLogins({
      database: join(root, 'native.db'),
      profiles: profilePath,
    });
    expect(remainingLegacy.plan).toEqual([]);
    expect(remainingLegacy.blocked).toEqual(batch.blocked);
    expect(
      await reauthorizeHostLogins({
        database: join(root, 'native.db'),
        profiles: profilePath,
        conversations: ['retained'],
        approvedPlan: preview,
        assertOffline: gate,
      }),
    ).toMatchObject([{ status: 'already_completed' }]);
    const client = {
      initialize: vi.fn(async () => {}),
      request: vi.fn(async () => ({
        account: { type: 'chatgpt', email: profile.email, planType: profile.planType },
      })),
      close: vi.fn(),
    };
    const recoveredLease = await FrozenHostCodexLogin.reopen(profile, updated.login).connect(
      () => client,
    );
    for (const offset of [40, 50]) {
      writeFileSync(join(legacy.privateHome, 'auth.json'), refreshedAuth(epoch + offset));
      await recoveredLease.assertCurrent();
    }
    recoveredLease.close();
    const restartedLease = await FrozenHostCodexLogin.reopen(profile, updated.login).connect(
      () => client,
    );
    await restartedLease.assertCurrent();
    restartedLease.close();
    expect(store.commands('retained', realBinding)).toEqual(commands);
    expect(store.read('retained', realBinding).threadId).toBe('original-thread');
  } finally {
    store.close();
    vi.unstubAllGlobals();
  }
});
