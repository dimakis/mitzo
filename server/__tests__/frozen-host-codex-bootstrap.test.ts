import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';
import { EventStore } from '../event-store.js';
import {
  FrozenHostCodexBootstrapAuthority,
  type FrozenHostQualifiedWorkspaceReadOwner,
} from '../frozen-host-codex-bootstrap.js';
import { FrozenHostCodexLogin } from '../frozen-host-codex-login.js';
import { FrozenHostCodexExecutable } from '../frozen-host-codex-executable.js';
import type { OrdinaryLocalCodexAdmissionExpectation } from '../ordinary-local-codex-admission.js';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { capturePreparedRepositoryReader } from '../local-repository-native-read.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { assertPreparedRepositoryTaskTopology } from '../prepared-repository-workspace-owner.js';
import { snapshotRepositoryTaskCheckout } from '../repository-task-checkout.js';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';
import { withPreparedRepositoryBarrierReadScope } from '../prepared-repository-barrier-read.js';
import { repositoryObservationProgram } from '../native-repository-observation.js';
import * as topologyTransport from '../sandboxed-command.js';
const roots: string[] = [];
const deployment = vi.hoisted(() => ({ controller: false }));
const apiKeys = vi.hoisted(() => ({
  assertReady: vi.fn(async () => {}),
  resolveKey: vi.fn(async () => 'synthetic-api-key'),
}));
vi.mock('../openai-account-key-authority.js', () => ({ openAIAccountKeyAuthority: () => apiKeys }));
vi.mock('../symposium-custodian-mode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../symposium-custodian-mode.js')>()),
  get custodianControllerMode() {
    return deployment.controller;
  },
}));
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
afterEach(() => {
  deployment.controller = false;
});

it.runIf(process.platform === 'darwin').each(['current', 'account', 'credential'] as const)(
  'composes one topology phase with the real bootstrap credential owner (%s)',
  async (change) => {
    const f = fixture(),
      task = join(f.root, 'topology-task');
    mkdirSync(task);
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: '/nonexistent',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const git = (...args: string[]) =>
      execFileSync(
        '/usr/bin/git',
        ['-C', task, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
        { env },
      );
    git('init', '--template=', '-q', '-b', 'mitzo/fixture');
    git(
      '-c',
      'user.name=Offline',
      '-c',
      'user.email=offline@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'offline',
    );
    git('read-tree', 'HEAD');
    const original = await snapshotRepositoryTaskCheckout(task, 'mitzo/fixture');
    const identity = {
      ...original,
      localSource: {
        repositoryId: 'offline',
        path: task,
        root: original.root,
        commonDirectory: join(task, '.git'),
        commonRoot: original.git,
      },
    };
    f.expected.workspace.cwd = task;
    const rpc = f.rpc.request.getMockImplementation()!;
    let changed = false;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (changed && change === 'account' && method === 'account/read')
        return {
          account: { type: 'chatgpt', email: 'revoked@example.invalid', planType: 'plus' },
        } as never;
      return rpc(method, params);
    });
    const helper = vi
      .spyOn(topologyTransport, 'executePrivateRepositoryObservation')
      .mockImplementation(async (options) => {
        await options.beforeSpawnAsync?.();
        options.beforeSpawn?.();
        const pending = promisify(execFile)(
          '/usr/bin/python3',
          ['-I', '-c', repositoryObservationProgram],
          {
            env: { PATH: '/usr/bin:/bin' },
            signal: options.signal,
            maxBuffer: options.maxOutputBytes,
          },
        );
        pending.child.stdin?.end(options.requestJson);
        const stdout = (await pending).stdout;
        changed = true;
        if (change === 'credential')
          writeFileSync(
            join(f.configuration[0].credentialRef, 'auth.json'),
            'revoked fixture credential',
          );
        return { content: '', stdout, stderr: '', isError: false };
      });
    try {
      await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
        const physical = () =>
          lease.withQualifiedWorkspaceReadOwner!(f.options.signal, async (owner) => {
            const policy = codexNativeExecutionPolicy({
              bindingRevision: 'fixture',
              mode: 'agent',
              cwd: task,
              readableRoots: ['/'],
              writableRoots: [task],
              deniedRoots: [f.privateRoot, f.configuration[0].credentialRef],
              writeProtectedRoots: [],
            });
            await withPreparedRepositoryBarrierReadScope(
              policy,
              'command',
              {
                signal: owner.signal,
                selectedPolicy: () => policy,
                assertCurrentSync: () => owner.assertCurrentSync(),
                revalidate: () => owner.revalidate(),
              },
              async (scope) => {
                const reader = await capturePreparedRepositoryReader(scope, {
                  deadline: Date.now() + 30000,
                });
                try {
                  await assertPreparedRepositoryTaskTopology(
                    new LocalRepositoryReadAccess(reader),
                    identity,
                    join(task, '.git'),
                  );
                } finally {
                  try {
                    await reader.dispose();
                  } finally {
                    await scope.revalidate();
                  }
                }
              },
            );
          });
        if (change === 'current') {
          const samples = process.env.MITZO_CUSTODY_COST_BENCHMARK === '1' ? 5 : 1;
          const rounds: number[] = [],
            accountReads: number[] = [];
          for (let sample = 0; sample < samples; sample++) {
            const before = f.rpc.request.mock.calls.filter(
              ([method]) => method === 'account/read',
            ).length;
            const started = performance.now();
            await physical();
            rounds.push(performance.now() - started);
            accountReads.push(
              f.rpc.request.mock.calls.filter(([method]) => method === 'account/read').length -
                before,
            );
          }
          if (process.env.MITZO_CUSTODY_COST_BENCHMARK === '1')
            process.stdout.write(
              JSON.stringify({
                workload: 'bootstrap-barrier-topology',
                samples,
                rounds,
                accountReads,
                helperSpawns: helper.mock.calls.length,
              }) + '\n',
            );
          expect(accountReads).toEqual(Array(samples).fill(6));
          expect(helper).toHaveBeenCalledTimes(samples);
        } else {
          await expect(physical()).rejects.toThrow();
          expect(f.rpc.close).toHaveBeenCalled();
          expect(helper).toHaveBeenCalledTimes(1);
        }
      });
    } catch (error) {
      throw new Error(
        `Topology composition failed after RPC methods ${f.rpc.request.mock.calls.map(([method]) => method).join(',')}`,
        { cause: error },
      );
    } finally {
      helper.mockRestore();
      f.authority.currentLease()?.close();
      f.store.close();
    }
  },
);
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-bootstrap-')));
  roots.push(root);
  const source = join(root, 'source'),
    privateRoot = join(root, 'private'),
    executablePath = join(root, 'codex');
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(privateRoot, { mode: 0o700 });
  writeFileSync(
    join(source, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: 'fixture',
        refresh_token: 'fixture',
        id_token: 'fixture',
        account_id: 'fixture',
      },
    }),
    { mode: 0o600 },
  );
  const binary = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  writeFileSync(executablePath, binary, { mode: 0o755 });
  const configuration = [
    {
      id: 'personal',
      label: 'Personal',
      provider: 'openai-codex',
      credentialRef: source,
      email: 'person@example.test',
      planType: 'plus',
      models: [{ id: 'fixture-model', label: 'Fixture', reasoningEfforts: ['low'] }],
    },
  ];
  const loadProfiles = () => new AccountProfiles(configuration, { codexEnabled: true });
  const accountBinding = loadProfiles().resolve('personal', 'fixture-model');
  const binding = {
    version: 2 as const,
    account: {
      accountId: accountBinding.accountId,
      provider: accountBinding.provider,
      profileRevision: accountBinding.profileRevision,
    },
    harness: { implementation: 'codex' as const },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target-1' },
  };
  const selection = {
    version: 1 as const,
    agent: { profileId: 'agent', revision: 1 },
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'agent' as const, revision: 1 },
    model: 'fixture-model',
    thinking: 'low',
  };
  const expected = {
    binding,
    selection,
    hostId: 'host',
    runtimeContractRevision: 'runtime-1',
    capabilityRevision: 'cap-1',
    workspace: { workspaceId: 'workspace', cwd: '/offline/workspace' },
    bootstrapId: 'a'.repeat(64),
  } as OrdinaryLocalCodexAdmissionExpectation & { bootstrapId: string };
  const store = new EventStore(':memory:');
  const claim = () => {
    store.admitOrdinaryLocalCommand(
      {
        sessionId: 'session',
        accountBinding,
        repositoryWorkspaceId: 'workspace',
        cwd: expected.workspace.cwd,
      },
      binding,
      {
        clientMsgId: 'command',
        requestFingerprint: 'fingerprint',
        selection,
        payload: { text: 'offline' },
      },
    );
    return store.claimOrdinaryLocalCommandDispatch('command');
  };
  const runtime = {
    hostId: 'host',
    runtimeContractRevision: 'runtime-1',
    targetId: 'mac',
    targetRevision: 'target-1',
    executablePath,
    executableSha256: createHash('sha256').update(binary).digest('hex'),
  };
  const rpc = {
    initialize: vi.fn(async () => {}),
    request: vi.fn(async (method: string, _params: Record<string, unknown>) => {
      if (method === 'account/read')
        return { account: { type: 'chatgpt', email: configuration[0].email, planType: 'plus' } };
      if (method === 'config/read') return { config: {} };
      if (method === 'model/list')
        return {
          data: [
            {
              model: 'fixture-model',
              displayName: 'Fixture',
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
            },
          ],
          nextCursor: null,
        };
      throw new Error('Unexpected provider effect');
    }),
    close: vi.fn(),
  };
  const launch = vi.fn(() => {
    expect(store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('uncertain');
    return rpc;
  });
  const options = {
    loadProfiles,
    observeRuntime: vi.fn(async () => runtime),
    assertRuntimeCurrentSync: vi.fn(() => {}),
    assertSelectionCurrent: vi.fn(async () => {}),
    assertSelectionCurrentSync: vi.fn(() => {}),
    privateRoot,
    launch,
    signal: new AbortController().signal,
  };
  const authority = new FrozenHostCodexBootstrapAuthority(options);
  return {
    root,
    privateRoot,
    store,
    expected,
    claim,
    authority,
    options,
    configuration,
    rpc,
    launch,
    runtime,
  };
}
it('reuses code across bootstrap owners while login custody and native clients stay independent', async () => {
  const a = fixture(),
    b = fixture();
  b.options.privateRoot = a.privateRoot;
  b.runtime.executablePath = a.runtime.executablePath;
  b.expected.bootstrapId = 'b'.repeat(64);
  try {
    await a.authority.withBootstrap(a.expected, a.claim, async (first) => {
      const one = first.custodySnapshot!();
      expect(one.executable.sharedPlacement?.privateRoot).toBe(a.privateRoot);
      await b.authority.withBootstrap(b.expected, b.claim, async (second) => {
        const two = second.custodySnapshot!();
        expect(two.executable).toEqual(one.executable);
        expect(two.login.privateHome).not.toBe(one.login.privateHome);
        expect(first.client).not.toBe(second.client);
        await first.assertCurrent();
        await second.assertCurrent();
      });
      b.authority.currentLease()!.close();
      await first.assertCurrent();
    });
  } finally {
    a.authority.currentLease()?.close();
    b.authority.currentLease()?.close();
    a.store.close();
    b.store.close();
  }
});
it('qualifies config/models once and keeps repeated current-authority checks free of discovery', async () => {
  const f = fixture();
  try {
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      const before = f.rpc.request.mock.calls.map(([method]) => method);
      await lease.assertCurrent();
      await lease.assertCurrent();
      const after = f.rpc.request.mock.calls.map(([method]) => method);
      expect(after.filter((method) => method === 'model/list')).toHaveLength(1);
      expect(after.filter((method) => method === 'config/read')).toHaveLength(1);
      expect(after.filter((method) => method === 'model/list').length).toBe(
        before.filter((method) => method === 'model/list').length,
      );
      await lease.qualifyModelSelection!('fixture-model', 'low');
      expect(f.rpc.request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(
        2,
      );
      f.rpc.request.mockImplementation(async () => ({ data: [], nextCursor: null }) as never);
      await expect(lease.qualifyModelSelection!('fixture-model', 'low')).rejects.toThrow();
    });
  } finally {
    f.authority.currentLease()?.close();
    f.store.close();
  }
});

it('uses one fresh profile view per synchronous fence after both selection observers', async () => {
  const f = fixture();
  const observed: string[] = [];
  const load = f.options.loadProfiles;
  const profiles = vi.spyOn(f.options, 'loadProfiles').mockImplementation(() => {
    observed.push('profiles');
    return load();
  });
  const pending = vi.fn(() => {
    observed.push('pending-status');
    return true;
  });
  const selections = vi.fn(() => {
    observed.push('pending-selections');
    return [];
  });
  Object.assign(f.options, { isSelectionPending: pending, pendingSelections: selections });
  let measured: unknown;
  try {
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      observed.length = 0;
      profiles.mockClear();
      pending.mockClear();
      selections.mockClear();
      lease.assertCurrentSync!();
      measured = {
        loads: profiles.mock.calls.length,
        pending: pending.mock.calls.length,
        selections: selections.mock.calls.length,
        order: [...observed],
      };
      f.configuration[0].email = 'changed@example.test';
      expect(() => lease.assertCurrentSync!()).toThrow('Host Codex bootstrap unavailable');
    });
    expect(measured).toEqual({
      loads: 1,
      pending: 2,
      selections: 1,
      order: ['pending-status', 'pending-status', 'pending-selections', 'profiles'],
    });
    expect(profiles).toHaveBeenCalledTimes(2);
  } finally {
    f.authority.currentLease()?.close();
    f.store.close();
  }
});

it.each(['isSelectionPending', 'pendingSelections'] as const)(
  'observes profile mutations made synchronously by %s before validating the fresh view',
  async (observer) => {
    const f = fixture();
    let mutate = false;
    let rejected = false;
    const change = () => {
      if (mutate) {
        mutate = false;
        f.configuration[0].email = 'changed@example.test';
      }
    };
    Object.assign(f.options, {
      isSelectionPending: () => {
        if (observer === 'isSelectionPending') change();
        return true;
      },
      pendingSelections: () => {
        if (observer === 'pendingSelections') change();
        return [];
      },
    });
    try {
      await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
        mutate = true;
        try {
          lease.assertCurrentSync!();
        } catch {
          rejected = true;
        }
      });
      expect(rejected).toBe(true);
      expect(f.rpc.close).toHaveBeenCalled();
    } finally {
      f.authority.currentLease()?.close();
      f.store.close();
    }
  },
);

it('loads a new profile view after an awaited workspace check and rejects changes before returning authority', async () => {
  const f = fixture();
  let mutate = false;
  f.options.assertSelectionCurrent.mockImplementation(async () => {
    if (mutate) {
      mutate = false;
      f.configuration[0].email = 'changed@example.test';
    }
  });
  try {
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      mutate = true;
      await expect(lease.assertCurrent()).rejects.toThrow('Host Codex bootstrap unavailable');
      expect(f.rpc.close).toHaveBeenCalled();
    });
  } finally {
    f.authority.currentLease()?.close();
    f.store.close();
  }
});

it('continues to validate every pending model against the same fresh profile view', async () => {
  const f = fixture();
  let extra = false;
  Object.assign(f.options, {
    pendingSelections: () => (extra ? [{ model: 'not-configured', thinking: null }] : []),
  });
  try {
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      extra = true;
      expect(() => lease.assertCurrentSync!()).toThrow('Host Codex bootstrap unavailable');
    });
  } finally {
    f.authority.currentLease()?.close();
    f.store.close();
  }
});
it('claims SQLite uncertainty before custody/launch and supplies the same verified native client', async () => {
  const f = fixture();
  try {
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      expect(lease.client).toBe(f.rpc);
      expect(f.authority.currentLease()).toBe(lease);
      const exposedProfile = lease.profile;
      exposedProfile.credentialRef = '/mutated/public-profile';
      const exposedBinding = lease.binding;
      exposedBinding.profileRevision = 'mutated-public-binding';
      expect(lease.profile.credentialRef).toBe(f.configuration[0].credentialRef);
      expect(lease.binding.profileRevision).toBe(f.expected.binding.account.profileRevision);
      await lease.assertCurrent();
      for (const [method, params] of f.rpc.request.mock.calls) {
        if (method === 'config/read') expect(params.cwd).toBe(lease.privateHome);
      }
      lease.assertCurrentSync();
      f.store.completeOrdinaryLocalCommand('command');
    });
    expect(f.store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('consumed');
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'model/list').length).toBe(1);
    expect(f.rpc.close).not.toHaveBeenCalled();
    f.authority.currentLease()?.close();
  } finally {
    f.store.close();
  }
});
it.each([
  undefined,
  {
    endpoint: 'https://gateway.example.test/v1',
    protocol: 'responses' as const,
    qualification: {
      source: 'operator' as const,
      streaming: true,
      toolCalls: true,
      continuation: true,
      cancellation: true,
    },
  },
])(
  'bootstraps an API billing account with connection %j through Codex and retains its API home',
  async (connection) => {
    const f = fixture();
    const profiles = new AccountProfiles(
      [
        {
          id: 'work',
          label: 'Work API',
          provider: 'openai',
          ...(connection ? { connection } : {}),
          credentialRef: { provider: 'keychain', service: 'offline-test', account: 'work' },
          models: [{ id: 'fixture-model', label: 'Fixture', reasoningEfforts: ['low'] }],
        },
      ],
      { codexEnabled: true },
    );
    const binding = profiles.resolve('work', 'fixture-model');
    const expected = {
      ...f.expected,
      binding: {
        ...f.expected.binding,
        account: {
          accountId: binding.accountId,
          provider: binding.provider as 'openai',
          profileRevision: binding.profileRevision,
        },
      },
    };
    const request = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) =>
      method === 'account/read'
        ? ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true } as never)
        : request(method, params),
    );
    const claim = vi.fn(() => {
      f.store.admitOrdinaryLocalCommand(
        {
          sessionId: 'api-session',
          accountBinding: binding,
          repositoryWorkspaceId: 'workspace',
          cwd: expected.workspace.cwd,
        },
        expected.binding,
        {
          clientMsgId: 'api-command',
          requestFingerprint: 'api-fingerprint',
          selection: expected.selection,
          payload: { text: 'offline' },
        },
      );
      return f.store.claimOrdinaryLocalCommandDispatch('api-command');
    });
    const launchApi = vi.fn(
      async (
        home: string,
        _executable: unknown,
        _binding: unknown,
        _retained: boolean,
        _connection?: unknown,
      ) => {
        expect(f.store.getOrdinaryLocalCommandAdmission('api-command')?.state).toBe('uncertain');
        writeFileSync(
          join(home, 'auth.json'),
          JSON.stringify({ OPENAI_API_KEY: 'synthetic-api-key' }),
          { mode: 0o600, flag: 'wx' },
        );
        return f.rpc;
      },
    );
    const owner = new FrozenHostCodexBootstrapAuthority({
      ...f.options,
      loadProfiles: () => profiles,
      launchApi,
    });
    try {
      await owner.withBootstrap(expected, claim, async (lease) => {
        expect(lease.binding).toEqual(binding);
        expect(lease.profile.planType).toBe('api');
        expect(lease.custodySnapshot!().login).toMatchObject({ kind: 'api-key', binding });
        await lease.assertCurrent();
        lease.assertCurrentSync();
      });
      expect(launchApi).toHaveBeenCalledTimes(1);
      expect(launchApi.mock.calls[0][4]).toEqual(connection);
      if (connection)
        expect(f.rpc.request.mock.calls.some(([method]) => method === 'model/list')).toBe(false);
      expect(f.launch).not.toHaveBeenCalled();
      expect(apiKeys.resolveKey).toHaveBeenCalledWith('work', expect.any(AbortSignal));
    } finally {
      owner.currentLease()?.close();
      f.store.close();
    }
  },
);
it('a consumed/uncertain claim creates no private home or native connection', async () => {
  const f = fixture();
  try {
    const operation = vi.fn();
    expect(await f.authority.withBootstrap(f.expected, () => false, operation)).toBeUndefined();
    expect(readdirSync(f.privateRoot)).toEqual([]);
    expect(f.launch).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  } finally {
    f.store.close();
  }
});
it('refuses custodian controller bootstrap before claim, observations or custody effects', async () => {
  const f = fixture();
  deployment.controller = true;
  try {
    const claim = vi.fn(f.claim),
      operation = vi.fn();
    await expect(f.authority.withBootstrap(f.expected, claim, operation)).rejects.toThrow(
      'Host Codex bootstrap unavailable',
    );
    expect(claim).not.toHaveBeenCalled();
    expect(f.options.observeRuntime).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(readdirSync(f.privateRoot)).toEqual([]);
  } finally {
    f.store.close();
  }
});
it.each(['host', 'runtime', 'account', 'selection', 'executable'] as const)(
  'rejects %s drift and preserves claimed uncertainty when effects began',
  async (kind) => {
    const f = fixture();
    try {
      if (kind === 'host') f.runtime.hostId = 'other';
      if (kind === 'runtime') f.runtime.runtimeContractRevision = 'other';
      if (kind === 'account') f.configuration[0].email = 'other@example.test';
      if (kind === 'selection')
        f.options.assertSelectionCurrent.mockRejectedValue(new Error('private-owner-secret'));
      if (kind === 'executable') f.runtime.executableSha256 = '0'.repeat(64);
      const operation = vi.fn();
      await expect(f.authority.withBootstrap(f.expected, f.claim, operation)).rejects.toThrow(
        'Host Codex bootstrap unavailable',
      );
      expect(operation).not.toHaveBeenCalled();
      if (kind === 'executable')
        expect(f.store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('uncertain');
      else expect(f.store.getOrdinaryLocalCommandAdmission('command')).toBeUndefined();
    } finally {
      f.store.close();
    }
  },
);
it('fresh provider model/thinking refusal blocks workspace/dispatch and retains login custody', async () => {
  const f = fixture();
  try {
    f.rpc.request.mockImplementation(async (method) =>
      method === 'account/read'
        ? { account: { type: 'chatgpt', email: 'person@example.test', planType: 'plus' } }
        : method === 'config/read'
          ? { config: {} }
          : {
              data: [
                { model: 'different', displayName: 'Different', supportedReasoningEfforts: [] },
              ],
              nextCursor: null,
            },
    );
    const operation = vi.fn();
    await expect(f.authority.withBootstrap(f.expected, f.claim, operation)).rejects.toThrow(
      'Host Codex bootstrap unavailable',
    );
    expect(operation).not.toHaveBeenCalled();
    expect(f.rpc.close).toHaveBeenCalledTimes(1);
    expect(f.store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('uncertain');
    expect(readdirSync(f.privateRoot).sort()).toEqual([
      `host-login-${f.expected.bootstrapId}`,
      expect.stringMatching(/^host-runtime-[A-Za-z0-9]{6}$/),
    ]);
  } finally {
    f.store.close();
  }
});

it('revocation while provider discovery awaits blocks the next effect boundary', async () => {
  const f = fixture();
  try {
    const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method) => {
      const response = await original(method, {});
      if (method === 'model/list')
        f.options.assertSelectionCurrentSync.mockImplementation(() => {
          throw new Error('owner-revoked');
        });
      return response;
    });
    const operation = vi.fn();
    await expect(f.authority.withBootstrap(f.expected, f.claim, operation)).rejects.toThrow(
      'Host Codex bootstrap unavailable',
    );
    expect(operation).not.toHaveBeenCalled();
    expect(f.rpc.close).toHaveBeenCalledTimes(1);
    expect(f.store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('uncertain');
  } finally {
    f.store.close();
  }
});

it('rechecks actual runtime configuration drift at the final synchronous effect fence', async () => {
  const f = fixture();
  f.options.assertRuntimeCurrentSync.mockImplementation(() => {
    if (f.runtime.targetRevision !== f.expected.binding.execution.targetRevision)
      throw new Error('actual-target-config-changed');
  });
  let dispatched = false;
  try {
    await expect(
      f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
        const observations = f.options.observeRuntime.mock.calls.length;
        f.runtime.targetRevision = 'changed-after-async-qualification';
        lease.assertCurrentSync();
        // This represents an existing native effect callback after async admission.
        dispatched = true;
        expect(f.options.observeRuntime).toHaveBeenCalledTimes(observations);
      }),
    ).rejects.toThrow('Host Codex bootstrap unavailable');
    expect(dispatched).toBe(false);
    expect(f.rpc.close).toHaveBeenCalledTimes(1);
    expect(f.store.getOrdinaryLocalCommandAdmission('command')?.state).toBe('uncertain');
  } finally {
    f.store.close();
  }
});

it.each([false, true])(
  'retains frozen custody across handoffs (prequeued: %s)',
  async (prequeued) => {
    const f = fixture();
    const { AgentLibraryStore } = await import('../agent-library-store.js');
    const { OrdinaryLocalCodexSelectionOwner } =
      await import('../ordinary-local-codex-selection-owner.js');
    const { OrdinaryLocalWorkspaceOwner } = await import('../ordinary-local-workspace-owner.js');
    const { ordinaryLocalCodexBootstrapId } = await import('../ordinary-local-codex-admission.js');
    const { statSync } = await import('node:fs');
    const library = new AgentLibraryStore(':memory:');
    library.saveDraft('user', {
      profileId: 'agent',
      expectedVersion: 0,
      expectedRevision: 0,
      idempotencyKey: 'draft',
      definition: {
        name: 'Agent',
        descriptor: 'Assistant',
        role: 'agent',
        instructions: 'Offline',
        expectedOutput: 'Evidence',
        acceptanceCriteria: ['Keep custody'],
        modelPolicyRole: 'agent',
      },
    });
    const profile = library.publish('user', {
      profileId: 'agent',
      expectedVersion: 1,
      idempotencyKey: 'publish',
    });
    const taskRoot = join(f.root, 'tasks');
    mkdirSync(taskRoot, { mode: 0o700 });
    for (const name of ['old', 'new', 'newer'])
      mkdirSync(join(taskRoot, name, '.git'), { recursive: true });
    const root = statSync(taskRoot);
    const account = f.options.loadProfiles().resolve('personal', 'fixture-model');
    const reservation = { id: 'old', binding: account, conversationId: 'session', taskRoot };
    const record = (id: string) => {
      const directory = join(taskRoot, id),
        info = statSync(directory),
        git = statSync(join(directory, '.git'));
      return {
        ...reservation,
        id,
        directory,
        state: 'claimed' as const,
        sandbox: false,
        featureBranch: `task/${id}`,
        hostReservation: {
          version: 1 as const,
          taskRoot,
          rootIdentity: { dev: root.dev, ino: root.ino },
        },
        taskIdentity: {
          directory,
          featureBranch: `task/${id}`,
          root: { dev: info.dev, ino: info.ino },
          git: { dev: git.dev, ino: git.ino },
        },
      };
    };
    let primary = 'old',
      adopted = false,
      current = true;
    const workspace = {
      getHostReservation: (input: { id: string }) => record(input.id),
      getForConversation: () => record(primary),
      reserveHostTask: async (input: { id: string }) => record(input.id),
      validateHostTask: async () => {},
    } as unknown as import('../repository-workspaces.js').RepositoryWorkspaces;
    f.expected.workspace = { workspaceId: 'old', cwd: join(taskRoot, 'old') };
    f.expected.selection.permission.revision = 0;
    f.expected.agentProfile = profile;
    f.expected.bootstrapId = ordinaryLocalCodexBootstrapId('session', 'fingerprint');
    const selection = new OrdinaryLocalCodexSelectionOwner({
      events: f.store,
      library,
      workspace,
      reservation,
      commandId: 'command',
      signal: f.options.signal,
      operator: {
        assertCurrent() {
          if (!current) throw Error('revoked');
        },
      },
    });
    const authority = new FrozenHostCodexBootstrapAuthority({
      ...f.options,
      assertSelectionCurrent: (expected) => selection.assertCurrent(expected),
      assertSelectionCurrentSync: (expected) => selection.assertCurrentSync(expected),
      assertToolSelectionCurrent: (expected) => selection.assertToolCurrent(expected),
    });
    let phase = 'bootstrap';
    try {
      await authority.withBootstrap(
        f.expected,
        () => {
          f.store.admitOrdinaryLocalCommand(
            {
              sessionId: 'session',
              accountBinding: account,
              repositoryWorkspaceId: 'old',
              cwd: f.expected.workspace.cwd,
              mode: 'agent',
              agentProfile: profile,
            },
            f.expected.binding,
            {
              clientMsgId: 'command',
              requestFingerprint: 'fingerprint',
              selection: f.expected.selection,
              payload: { text: 'Original task', systemPrompt: 'Original instructions' },
            },
          );
          return f.store.claimOrdinaryLocalCommandDispatch('command');
        },
        async (lease) => {
          phase = 'operation entered';
          f.store.completeOrdinaryLocalCommand('command');
          const oldBootstrap = f.store.getOrdinaryLocalCommandAdmission('command');
          const queuedOriginals = new Map<string, unknown>();
          if (prequeued)
            for (const commandId of ['queued-second', 'queued-third']) {
              f.store.admitOrdinaryLocalContinuation(
                {
                  sessionId: 'session',
                  accountBinding: account,
                  repositoryWorkspaceId: 'old',
                  cwd: f.expected.workspace.cwd,
                  mode: 'agent',
                  agentProfile: profile,
                },
                f.expected.binding,
                {
                  clientMsgId: commandId,
                  requestFingerprint: commandId,
                  selection: f.expected.selection,
                  payload: { text: commandId, systemPrompt: 'Original instructions' },
                },
              );
              // Admission is consumed when native FIFO accepts the held explicit input.
              f.store.claimOrdinaryLocalCommandDispatch(commandId);
              f.store.completeOrdinaryLocalCommand(commandId);
              queuedOriginals.set(commandId, structuredClone(f.store.getSendCommand(commandId)));
            }

          const privateHome = lease.privateHome,
            custody = lease.custodySnapshot!();
          const transition = {
            version: 1 as const,
            preparationId: '34af2bdf-5fb4-4de0-b083-cf188163d891',
            runtimeId: 'runtime',
            source: {
              commandId: 'command',
              attempt: 1,
              threadId: 'thread',
              turnId: 'turn',
              generation: 0,
              callId: 'prepare',
              requestHash: 'a'.repeat(64),
              resultSha256: 'b'.repeat(64),
            },
            oldWorkspace: {
              kind: 'repository' as const,
              id: 'old',
              directory: join(taskRoot, 'old'),
            },
            newWorkspace: {
              kind: 'repository' as const,
              id: 'new',
              directory: join(taskRoot, 'new'),
              featureBranch: 'task/new',
              baseOid: 'c'.repeat(40),
              taskIdentitySha256: createHash('sha256')
                .update(JSON.stringify(record('new').taskIdentity))
                .digest('hex'),
            },
            consumedScopeSha256: 'd'.repeat(64),
            materializedRecordSha256: 'e'.repeat(64),
          };
          const child = f.store.reservePreparedRepositoryContinuation('session', transition);
          const next = new OrdinaryLocalWorkspaceOwner(workspace, 'repository', {
            ...reservation,
            id: 'new',
          });
          phase = 'selection delegation';
          let boundaryCurrent = true;
          let boundaryValue: unknown, adoptedValue: unknown;
          const firstOwners = {
            assertCurrentSync() {
              expect(this).toBe(firstOwners);
              if (!current || !boundaryCurrent) throw Error('boundary revoked');
              return boundaryValue;
            },
            assertAdoptedSync() {
              expect(this).toBe(firstOwners);
              if (!adopted) throw Error('actual repository witness absent');
              return adoptedValue;
            },
          };
          const firstBoundary = firstOwners.assertCurrentSync;
          const firstWitness = firstOwners.assertAdoptedSync;
          firstOwners.assertCurrentSync = function () {
            this.assertAdoptedSync = () => undefined;
          };
          expect(() =>
            selection.preparePreparedRepositoryPrimary(
              f.expected,
              child.childCommandId,
              transition,
              next,
              firstOwners,
            ),
          ).toThrow();
          firstOwners.assertCurrentSync = firstBoundary;
          firstOwners.assertAdoptedSync = firstWitness;
          selection.preparePreparedRepositoryPrimary(
            f.expected,
            child.childCommandId,
            transition,
            next,
            firstOwners,
          );
          lease.assertCurrentSync();
          phase = 'old metadata with new physical';
          primary = 'new';
          expect(() => selection.assertCurrentSync(f.expected)).toThrow();
          adopted = true;
          phase = 'old metadata adopted';
          // Real FrozenHost calls the original selection with its original bootstrap
          // and old workspace. Exact private custody permits only this transition.
          lease.assertCurrentSync();
          await lease.assertCurrent();
          for (const invalid of [false, Promise.resolve(undefined)]) {
            adoptedValue = invalid;
            expect(() => selection.assertCurrentSync(f.expected)).toThrow();
            adoptedValue = undefined;
            boundaryValue = invalid;
            expect(() => selection.assertCurrentSync(f.expected)).toThrow();
            boundaryValue = undefined;
          }
          const originalWitness = firstOwners.assertAdoptedSync;
          firstOwners.assertAdoptedSync = () => undefined;
          expect(() => selection.assertCurrentSync(f.expected)).toThrow();
          firstOwners.assertAdoptedSync = originalWitness;
          phase = 'metadata commit';
          f.store.commitPreparedRepositoryContinuation('session', child.childCommandId, transition);
          lease.assertCurrentSync();
          await lease.assertToolCurrent!(f.options.signal);
          f.store.finalizePreparedRepositoryContinuation(
            'session',
            child.childCommandId,
            transition,
            () => {},
          );
          if (prequeued)
            f.store.rebindPreparedRepositoryQueuedCommands(
              'session',
              child.childCommandId,
              transition,
              ['queued-second', 'queued-third'],
            );
          boundaryCurrent = false; // completed preclaim owner may expire; it never grants future reads.
          lease.assertCurrentSync();
          expect(lease.client).toBe(f.rpc);
          expect(lease.privateHome).toBe(privateHome);
          expect(lease.custodySnapshot!()).toEqual(custody);
          expect(
            f.store.observePreparedRepositoryBootstrapAdmission(child.childCommandId, 'command'),
          ).toEqual(oldBootstrap);
          expect(() =>
            selection.assertCurrentSync({
              ...f.expected,
              workspace: { workspaceId: 'new', cwd: join(taskRoot, 'new') },
            }),
          ).toThrow();
          const second = {
            ...transition,
            priorPrimaryCommandId: child.childCommandId,
            preparationId: '3dbdc62d-20ab-4144-b210-c55bc7f39cda',
            source: {
              ...transition.source,
              commandId: prequeued ? 'queued-second' : child.childCommandId,
              turnId: 'second-turn',
              callId: 'second-prepare',
            },
            oldWorkspace: {
              kind: 'repository' as const,
              id: 'new',
              directory: join(taskRoot, 'new'),
            },
            newWorkspace: {
              ...transition.newWorkspace,
              id: 'old',
              directory: join(taskRoot, 'old'),
              featureBranch: 'task/old',
              taskIdentitySha256: createHash('sha256')
                .update(JSON.stringify(record('old').taskIdentity))
                .digest('hex'),
            },
          };
          if (prequeued) {
            const db = (f.store as unknown as { db: import('better-sqlite3').Database }).db;
            const saved = db
              .prepare('SELECT * FROM ordinary_execution_admissions WHERE command_id=?')
              .get('queued-second') as {
              revision: number;
              transition_id: string;
              original_admission: string;
              execution_admission: string;
            };
            const execution = JSON.parse(saved.execution_admission);
            for (const changed of [
              { ...execution, preparedRepositoryPrimaryCommandId: 'wrong-primary' },
              { ...execution, workspace: { ...execution.workspace, cwd: '/foreign/workspace' } },
              {
                ...execution,
                binding: {
                  ...execution.binding,
                  execution: { ...execution.binding.execution, targetRevision: 'changed' },
                },
              },
              { ...execution, selection: { ...execution.selection, model: 'changed-model' } },
              { ...execution, state: 'uncertain' },
              { ...execution, requestFingerprint: 'tampered' },
            ]) {
              db.prepare(
                'UPDATE ordinary_execution_admissions SET execution_admission=? WHERE revision=?',
              ).run(JSON.stringify(changed), saved.revision);
              expect(() =>
                f.store.reservePreparedRepositoryContinuation('session', second),
              ).toThrow();
            }
            db.prepare(
              'UPDATE ordinary_execution_admissions SET execution_admission=? WHERE revision=?',
            ).run(saved.execution_admission, saved.revision);
            db.prepare(
              'UPDATE ordinary_execution_admissions SET transition_id=? WHERE revision=?',
            ).run('foreign-primary', saved.revision);
            expect(() =>
              f.store.reservePreparedRepositoryContinuation('session', second),
            ).toThrow();
            db.prepare(
              'UPDATE ordinary_execution_admissions SET transition_id=? WHERE revision=?',
            ).run(saved.transition_id, saved.revision);
            db.prepare(
              'UPDATE ordinary_execution_admissions SET original_admission=? WHERE revision=?',
            ).run(
              JSON.stringify({
                ...JSON.parse(saved.original_admission),
                requestFingerprint: 'rewritten-original',
              }),
              saved.revision,
            );
            expect(() =>
              f.store.reservePreparedRepositoryContinuation('session', second),
            ).toThrow();
            db.prepare(
              'UPDATE ordinary_execution_admissions SET original_admission=? WHERE revision=?',
            ).run(saved.original_admission, saved.revision);
          }
          if (prequeued) {
            const db = (f.store as unknown as { db: import('better-sqlite3').Database }).db;
            const original = db
              .prepare('SELECT ordinary_admission FROM send_commands WHERE client_msg_id=?')
              .get('queued-second') as { ordinary_admission: string };
            const revision = db
              .prepare(
                'SELECT revision,original_admission,execution_admission FROM ordinary_execution_admissions WHERE command_id=?',
              )
              .get('queued-second') as {
              revision: number;
              original_admission: string;
              execution_admission: string;
            };
            // A forged original receipt must not make an earlier send row look as if it
            // was admitted under a primary which did not yet exist. Only revisions bridge that order.
            const forgedOriginal = JSON.parse(revision.execution_admission);
            // Keep the forged projection internally canonical so this case still
            // reaches the independent insertion-order fence. Earlier cases above
            // already prove that inconsistent execution lineage is refused.
            const forgedExecution = {
              ...forgedOriginal,
              requestFingerprint: `prepared-execution:${createHash('sha256')
                .update(
                  JSON.stringify([
                    forgedOriginal.requestFingerprint,
                    child.childCommandId,
                    forgedOriginal.workspace,
                  ]),
                )
                .digest('hex')}`,
            };
            db.prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?').run(
              revision.execution_admission,
              'queued-second',
            );
            db.prepare(
              'UPDATE ordinary_execution_admissions SET original_admission=?,execution_admission=? WHERE revision=?',
            ).run(revision.execution_admission, JSON.stringify(forgedExecution), revision.revision);
            expect(() =>
              f.store.getOrdinaryLocalCommandExecutionAdmission('queued-second'),
            ).toThrow(/insertion order/i);
            expect(() =>
              f.store.observePreparedRepositoryColdBootstrapAdmission(
                child.childCommandId,
                'queued-second',
                child.childCommandId,
              ),
            ).toThrow(/insertion order/i);
            expect(() => f.store.reservePreparedRepositoryContinuation('session', second)).toThrow(
              /insertion order/i,
            );
            db.prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?').run(
              original.ordinary_admission,
              'queued-second',
            );
            db.prepare(
              'UPDATE ordinary_execution_admissions SET original_admission=?,execution_admission=? WHERE revision=?',
            ).run(revision.original_admission, revision.execution_admission, revision.revision);
          }
          const nextChild = f.store.reservePreparedRepositoryContinuation('session', second);
          let secondAdopted = false;
          const secondOwners = {
            assertCurrentSync() {
              if (!current) throw Error('second boundary revoked');
            },
            assertAdoptedSync() {
              if (!secondAdopted) throw Error('second actual witness absent');
            },
          };
          phase = 'second delegation before custody CAS';
          selection.preparePreparedRepositoryPrimary(
            f.expected,
            nextChild.childCommandId,
            second,
            new OrdinaryLocalWorkspaceOwner(workspace, 'repository', { ...reservation, id: 'old' }),
            secondOwners,
          );
          lease.assertCurrentSync();
          primary = 'old';
          secondAdopted = true;
          lease.assertCurrentSync();
          await lease.assertCurrent();
          f.store.commitPreparedRepositoryContinuation('session', nextChild.childCommandId, second);
          lease.assertCurrentSync();
          f.store.finalizePreparedRepositoryContinuation(
            'session',
            nextChild.childCommandId,
            second,
            () => {},
          );
          expect(
            f.store.observePreparedRepositoryBootstrapAdmission(
              nextChild.childCommandId,
              'command',
            ),
          ).toEqual(oldBootstrap);
          expect(lease.custodySnapshot!()).toEqual(custody);
          await lease.assertToolCurrent!(f.options.signal);
          if (prequeued)
            f.store.rebindPreparedRepositoryQueuedCommands(
              'session',
              nextChild.childCommandId,
              second,
              ['queued-third'],
            );
          f.store.admitPreparedRepositoryPrimaryContinuation(
            {
              sessionId: 'session',
              accountBinding: account,
              repositoryWorkspaceId: 'old',
              cwd: join(taskRoot, 'old'),
              mode: 'agent',
              agentProfile: profile,
            },
            f.expected.binding,
            {
              clientMsgId: 'revisit',
              requestFingerprint: 'revisit',
              selection: f.expected.selection,
              payload: {
                text: 'Return to the next repository',
                systemPrompt: 'Original instructions',
              },
            },
            nextChild.childCommandId,
          );
          f.store.claimOrdinaryLocalCommandDispatch('revisit');
          f.store.completeOrdinaryLocalCommand('revisit');
          const third = {
            ...transition,
            preparationId: '48345612-504a-4158-ae53-531484ec0fb4',
            priorPrimaryCommandId: nextChild.childCommandId,
            source: {
              ...transition.source,
              commandId: prequeued ? 'queued-third' : 'revisit',
              turnId: 'third-turn',
              callId: 'third-prepare',
            },
          };
          const thirdChild = f.store.reservePreparedRepositoryContinuation('session', third);
          let thirdAdopted = false;
          selection.preparePreparedRepositoryPrimary(
            f.expected,
            thirdChild.childCommandId,
            third,
            new OrdinaryLocalWorkspaceOwner(workspace, 'repository', { ...reservation, id: 'new' }),
            {
              assertCurrentSync() {
                if (!current) throw Error('third boundary revoked');
              },
              assertAdoptedSync() {
                if (!thirdAdopted) throw Error('third actual witness absent');
              },
            },
          );
          lease.assertCurrentSync();
          primary = 'new';
          thirdAdopted = true;
          lease.assertCurrentSync();
          f.store.commitPreparedRepositoryContinuation('session', thirdChild.childCommandId, third);
          f.store.finalizePreparedRepositoryContinuation(
            'session',
            thirdChild.childCommandId,
            third,
            () => {},
          );
          await lease.assertToolCurrent!(f.options.signal);
          expect(lease.client).toBe(f.rpc);
          expect(lease.custodySnapshot!()).toEqual(custody);
          expect(
            f.store.observePreparedRepositoryBootstrapAdmission(
              thirdChild.childCommandId,
              'command',
            ),
          ).toEqual(oldBootstrap);
          for (const [id, original] of queuedOriginals) {
            expect(f.store.getSendCommand(id)).toEqual(original);
          }
          current = false;
          expect(() => lease.assertCurrentSync()).toThrow();
        },
      );
    } catch (error) {
      throw new Error(`Transition fixture failed at ${phase}`, { cause: error });
    } finally {
      authority.currentLease()?.close();
      library.close();
      f.store.close();
    }
  },
);

it('bounds the qualified workspace physical read owner to the same real lease without recursive physical validation', async () => {
  const f = fixture();
  const physical = vi.fn(async () => {});
  f.options.assertSelectionCurrent.mockImplementation(physical);
  try {
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      let retained: FrozenHostQualifiedWorkspaceReadOwner | undefined;
      const before = physical.mock.calls.length;
      const body = vi.fn(async (owner: FrozenHostQualifiedWorkspaceReadOwner) => {
        retained = owner;
        expect(Object.isFrozen(owner)).toBe(true);
        expect(owner.client).toBe(lease.client);
        expect(owner.binding).toEqual(lease.binding);
        owner.assertCurrentSync();
        await owner.revalidate();
        owner.assertCurrentSync();
      });
      await lease.withQualifiedWorkspaceReadOwner!(f.options.signal, body);
      expect(body).toHaveBeenCalledOnce();
      expect(physical).toHaveBeenCalledTimes(before);
      expect(() => retained!.assertCurrentSync()).toThrow();
      await expect(retained!.revalidate()).rejects.toThrow();
      lease.assertCurrentSync();
      await lease.assertCurrent();
      expect(physical).toHaveBeenCalledTimes(before + 1);
    });
  } finally {
    f.authority.currentLease()?.close();
    f.store.close();
  }
});

it.each([
  'physical',
  'value',
  'cancel',
  'close',
  'runtime-owner',
  'initial-runtime-owner',
  'initial-selection-owner',
  'selection-owner',
  'lease-owner',
  'account',
] as const)(
  'refuses qualified workspace physical validation after %s invalidates its original owner',
  async (change) => {
    const f = fixture();
    const abort = new AbortController();
    try {
      await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
        if (change === 'initial-runtime-owner')
          f.options.assertRuntimeCurrentSync = vi.fn(() => {});
        if (change === 'initial-selection-owner')
          f.options.assertSelectionCurrentSync = vi.fn(() => {});
        const originalRpc = f.rpc.request.getMockImplementation()!;
        let armed = false;
        f.rpc.request.mockImplementation(async (method, params) => {
          if (armed && change === 'account' && method === 'account/read') {
            await Promise.resolve();
            return {
              account: { type: 'chatgpt', email: 'changed@example.invalid', planType: 'plus' },
            } as never;
          }
          return originalRpc(method, params);
        });
        await expect(
          lease.withQualifiedWorkspaceReadOwner!(abort.signal, async (owner) => {
            if (change === 'physical') throw Error('Physical identity changed');
            if (change === 'value') return false as never;
            if (change === 'cancel') abort.abort();
            if (change === 'close') lease.close();
            if (change === 'runtime-owner') f.options.assertRuntimeCurrentSync = vi.fn(() => {});
            if (change === 'selection-owner')
              f.options.assertSelectionCurrentSync = vi.fn(() => {});
            if (change === 'lease-owner') lease.assertCurrentSync = () => {};
            armed = true;
            await owner.revalidate();
          }),
        ).rejects.toThrow();
        expect(f.rpc.close).toHaveBeenCalled();
      });
    } finally {
      f.authority.currentLease()?.close();
      f.store.close();
    }
  },
);

it('retains the real login refresh receiver and refuses async credential-function substitution', async () => {
  const f = fixture();
  const connect = FrozenHostCodexLogin.prototype.connect;
  let login: Awaited<ReturnType<typeof connect>> | undefined;
  let receivers = 0;
  const capture = vi
    .spyOn(FrozenHostCodexLogin.prototype, 'connect')
    .mockImplementation(async function (this: FrozenHostCodexLogin, ...args) {
      login = await Reflect.apply(connect, this, args);
      const original = login.assertCurrent;
      login.assertCurrent = async function () {
        expect(this).toBe(login);
        receivers++;
        return Reflect.apply(original, this, []);
      };
      return login;
    });
  try {
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      await lease.withQualifiedWorkspaceReadOwner!(f.options.signal, async (owner) => {
        await owner.revalidate();
      });
      expect(receivers).toBeGreaterThan(0);
      const originalRpc = f.rpc.request.getMockImplementation()!;
      let armed = false;
      f.rpc.request.mockImplementation(async (method, params) => {
        const result = await originalRpc(method, params);
        if (armed && method === 'account/read') login!.assertCurrent = async () => {};
        return result;
      });
      await expect(
        lease.withQualifiedWorkspaceReadOwner!(f.options.signal, async (owner) => {
          armed = true;
          await owner.revalidate();
        }),
      ).rejects.toThrow();
      expect(f.rpc.close).toHaveBeenCalled();
    });
  } finally {
    capture.mockRestore();
    f.authority.currentLease()?.close();
    f.store.close();
  }
});

it.each([
  { legacy: false, failPhysical: false },
  { legacy: false, failPhysical: true },
  { legacy: true, failPhysical: false },
  { legacy: true, failPhysical: true },
])(
  'qualifies exact retained cold custody after the new uncertain claim and real lease exists: %j',
  async ({ legacy, failPhysical }) => {
    const f = fixture();
    let custody: import('../host-codex-custody.js').HostCodexCustody | undefined;
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      custody = {
        version: 1,
        authSessionId: 'offline',
        bootstrapId: f.expected.bootstrapId,
        ...lease.custodySnapshot!(),
      };
    });
    f.authority.currentLease()!.close();
    if (legacy)
      custody!.executable = FrozenHostCodexExecutable.capture(
        f.runtime.executablePath,
        custody!.login.privateHome,
      ).custodySnapshot();
    const phases: string[] = [];
    const options = {
      ...f.options,
      retainedCustody: custody,
      assertQualifiedColdSelectionBeforeBootstrapSync(
        expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
      ) {
        expect(this).toBe(options);
        expect(expected.bootstrapId).toBe('b'.repeat(64));
        expect(cold.currentLease()).toBeUndefined();
        expect(phases).toEqual([]);
        phases.push('independent');
      },
      assertSelectionCurrent: vi.fn(async () => {
        throw Error('recursive physical pre-bootstrap forbidden');
      }),
      assertToolSelectionCurrent: vi.fn(async () => {
        expect(phases).toContain('claimed');
        expect(cold.currentLease()).toBeDefined();
        await cold.currentLease()!.withQualifiedWorkspaceReadOwner!(
          options.signal,
          async (owner) => {
            await owner.revalidate();
            phases.push('physical');
            if (failPhysical) throw Error('physical unavailable');
          },
        );
      }),
      launch: () => {
        expect(phases).toContain('claimed');
        phases.push('launch');
        return f.rpc;
      },
    };
    const cold = new FrozenHostCodexBootstrapAuthority(options);
    const methods: string[] = [];
    const request = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (...args) => {
      methods.push(args[0]);
      if (args[0] === 'config/read' || args[0] === 'model/list')
        expect(phases).toContain('physical');
      return request(...args);
    });
    const run = cold.withBootstrap(
      { ...f.expected, bootstrapId: 'b'.repeat(64) },
      () => {
        expect(phases).toEqual(['independent']);
        phases.push('claimed');
        return true;
      },
      async (lease) => {
        await lease.assertCurrent();
        expect(lease.custodySnapshot!().executable).toEqual(custody!.executable);
        phases.push('dispatch');
      },
    );
    try {
      if (failPhysical) {
        await expect(run).rejects.toThrow();
        expect(methods).not.toContain('config/read');
        expect(methods).not.toContain('model/list');
        expect(phases).not.toContain('dispatch');
      } else {
        await expect(run).resolves.toBeUndefined();
        expect(phases).toEqual([
          'independent',
          'claimed',
          'launch',
          'physical',
          'physical',
          'dispatch',
        ]);
      }
      expect(options.assertSelectionCurrent).not.toHaveBeenCalled();
    } finally {
      cold.currentLease()?.close();
      f.store.close();
    }
  },
);

it.each(['value', 'async', 'replace', 'physical-owner', 'abort'] as const)(
  'refuses malformed or substituted original cold pre-bootstrap owner: %s',
  async (change) => {
    const f = fixture();
    let custody: import('../host-codex-custody.js').HostCodexCustody | undefined;
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      custody = {
        version: 1,
        authSessionId: 'offline',
        bootstrapId: f.expected.bootstrapId,
        ...lease.custodySnapshot!(),
      };
    });
    f.authority.currentLease()!.close();
    const signal = new AbortController();
    const options = {
      ...f.options,
      signal: signal.signal,
      retainedCustody: custody,
      assertToolSelectionCurrent: async () => {},
      assertQualifiedColdSelectionBeforeBootstrapSync() {
        if (change === 'value') return false;
        if (change === 'async') return Promise.resolve(undefined);
        if (change === 'replace')
          this.assertQualifiedColdSelectionBeforeBootstrapSync = () => undefined;
        if (change === 'physical-owner') this.assertToolSelectionCurrent = async () => {};
        if (change === 'abort') signal.abort();
      },
    };
    const cold = new FrozenHostCodexBootstrapAuthority(options);
    const claim = vi.fn(() => true);
    f.launch.mockClear();
    f.rpc.request.mockClear();
    try {
      await expect(
        cold.withBootstrap({ ...f.expected, bootstrapId: 'b'.repeat(64) }, claim, async () => {}),
      ).rejects.toThrow();
      expect(claim).not.toHaveBeenCalled();
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.rpc.request).not.toHaveBeenCalled();
    } finally {
      f.store.close();
      cold.currentLease()?.close();
    }
  },
);

it('retains the ORIGINAL cold physical owner across credential/client reopening before the first physical check', async () => {
  const f = fixture();
  let custody: import('../host-codex-custody.js').HostCodexCustody | undefined;
  await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
    custody = {
      version: 1,
      authSessionId: 'offline',
      bootstrapId: f.expected.bootstrapId,
      ...lease.custodySnapshot!(),
    };
  });
  f.authority.currentLease()!.close();
  const original = f.rpc.request.getMockImplementation()!;
  const physical = vi.fn(async (): Promise<void> => {
    throw Error('Original physical authority refuses');
  });
  const options = {
    ...f.options,
    retainedCustody: custody,
    assertQualifiedColdSelectionBeforeBootstrapSync: () => {},
    assertToolSelectionCurrent: physical,
    launch: () => f.rpc,
  };
  f.rpc.request.mockClear();
  f.rpc.request.mockImplementation(async (method) => {
    if (method === 'account/read') options.assertToolSelectionCurrent = vi.fn(async () => {});
    return original(method, {});
  });
  const cold = new FrozenHostCodexBootstrapAuthority(options);
  try {
    await expect(
      cold.withBootstrap(
        { ...f.expected, bootstrapId: 'b'.repeat(64) },
        () => true,
        async () => {},
      ),
    ).rejects.toThrow();
    expect(f.rpc.request.mock.calls.map(([method]) => method)).not.toContain('config/read');
    expect(f.rpc.request.mock.calls.map(([method]) => method)).not.toContain('model/list');
    expect(f.rpc.close).toHaveBeenCalled();
  } finally {
    cold.currentLease()?.close();
    f.store.close();
  }
});
it('publishes the genuine physical read facet immutably at actual lease creation', async () => {
  const f = fixture();
  try {
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      expect(
        Object.getOwnPropertyDescriptor(lease, 'withQualifiedWorkspaceReadOwner'),
      ).toMatchObject({ writable: false, configurable: false });
    });
  } finally {
    f.authority.currentLease()?.close();
    f.store.close();
  }
});

it.each([
  'physical-false',
  'physical-object',
  'credential-false',
  'credential-fallback-object',
] as const)(
  'refuses an unchanged original cold full-current callback resolving a malformed result: %s',
  async (change) => {
    const f = fixture();
    let custody: import('../host-codex-custody.js').HostCodexCustody | undefined;
    await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
      custody = {
        version: 1,
        authSessionId: 'offline',
        bootstrapId: f.expected.bootstrapId,
        ...lease.custodySnapshot!(),
      };
    });
    f.authority.currentLease()!.close();
    f.store.completeOrdinaryLocalCommand('command');
    const dispatch = vi.fn(async () => {});
    const malformed = change.endsWith('false') ? false : { current: true };
    const physicalReceivers: unknown[] = [];
    const physical = vi.fn(async function (this: unknown) {
      physicalReceivers.push(this);
      if (change.startsWith('physical')) return malformed as never;
    });
    const options = {
      ...f.options,
      retainedCustody: custody,
      assertQualifiedColdSelectionBeforeBootstrapSync() {},
      assertToolSelectionCurrent: physical,
      launch: () => {
        expect(f.store.getOrdinaryLocalCommandAdmission('cold-command')?.state).toBe('uncertain');
        return f.rpc;
      },
    };
    const connect = FrozenHostCodexLogin.prototype.connect;
    let credential: import('vitest').Mock<() => Promise<void>> | undefined;
    const capture = vi
      .spyOn(FrozenHostCodexLogin.prototype, 'connect')
      .mockImplementation(async function (this: FrozenHostCodexLogin, ...args) {
        const login = await Reflect.apply(connect, this, args);
        if (change.startsWith('credential')) {
          const original = login.assertCurrent;
          credential = vi.fn(async function (this: typeof login) {
            expect(this).toBe(login);
            await Reflect.apply(original, this, []);
            return malformed as never;
          });
          if (change === 'credential-false') login.assertCredentialCurrent = credential;
          else login.assertCurrent = credential;
        }
        return login;
      });
    const cold = new FrozenHostCodexBootstrapAuthority(options);
    f.rpc.request.mockClear();
    f.rpc.close.mockClear();
    const claim = () => {
      const retained = f.store.getSession('session')!;
      f.store.admitOrdinaryLocalContinuation(
        {
          sessionId: 'session',
          accountBinding: retained.accountBinding,
          repositoryWorkspaceId: 'workspace',
          cwd: f.expected.workspace.cwd,
          agentProfile: retained.agentProfile,
          agentContext: retained.agentContext,
        },
        f.expected.binding,
        {
          clientMsgId: 'cold-command',
          requestFingerprint: 'cold-fingerprint',
          selection: f.expected.selection,
          payload: { text: 'cold' },
        },
      );
      return f.store.claimOrdinaryLocalCommandDispatch('cold-command');
    };
    try {
      await expect(
        cold.withBootstrap({ ...f.expected, bootstrapId: 'b'.repeat(64) }, claim, dispatch),
      ).rejects.toThrow();
      expect(physical).toHaveBeenCalledOnce();
      expect(physicalReceivers).toHaveLength(1);
      expect(physicalReceivers[0]).toBe(options);
      if (credential) expect(credential).toHaveBeenCalledOnce();
      expect(f.rpc.request.mock.calls.map(([method]) => method)).not.toEqual(
        expect.arrayContaining(['config/read']),
      );
      expect(f.rpc.request.mock.calls.map(([method]) => method)).not.toEqual(
        expect.arrayContaining(['model/list']),
      );
      expect(f.rpc.request.mock.calls.map(([method]) => method)).not.toContain('thread/start');
      expect(dispatch).not.toHaveBeenCalled();
      expect(f.rpc.close).toHaveBeenCalled();
      expect(f.store.getOrdinaryLocalCommandAdmission('cold-command')?.state).toBe('uncertain');
    } finally {
      capture.mockRestore();
      cold.currentLease()?.close();
      f.store.close();
    }
  },
);

it('invokes the genuine original cold prebootstrap owner despite its poisoned call property', async () => {
  const f = fixture();
  let custody: import('../host-codex-custody.js').HostCodexCustody | undefined;
  await f.authority.withBootstrap(f.expected, f.claim, async (lease) => {
    custody = {
      version: 1,
      authSessionId: 'offline',
      bootstrapId: f.expected.bootstrapId,
      ...lease.custodySnapshot!(),
    };
  });
  f.authority.currentLease()!.close();
  const poisoned = vi.fn(() => undefined);
  const genuine = Object.assign(
    function (this: unknown) {
      expect(this).toBe(options);
      throw Error('Original cold authority revoked');
    },
    { call: poisoned },
  );
  const options = {
    ...f.options,
    retainedCustody: custody,
    assertQualifiedColdSelectionBeforeBootstrapSync: genuine,
    assertToolSelectionCurrent: async () => {},
  };
  const cold = new FrozenHostCodexBootstrapAuthority(options);
  const claim = vi.fn(() => true),
    dispatch = vi.fn(async () => {});
  f.rpc.request.mockClear();
  try {
    await expect(
      cold.withBootstrap({ ...f.expected, bootstrapId: 'b'.repeat(64) }, claim, dispatch),
    ).rejects.toThrow();
    expect(poisoned).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(f.rpc.request).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    cold.currentLease()?.close();
    f.store.close();
  }
});

it('refuses a malformed original ordinary async full-current result before claiming or reopening', async () => {
  const f = fixture();
  f.options.assertSelectionCurrent.mockResolvedValue(false as never);
  const claim = vi.fn(f.claim),
    dispatch = vi.fn(async () => {});
  try {
    await expect(f.authority.withBootstrap(f.expected, claim, dispatch)).rejects.toThrow();
    expect(claim).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.rpc.request).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    f.authority.currentLease()?.close();
    f.store.close();
  }
});
