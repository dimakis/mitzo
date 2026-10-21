import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { CredentialResolver } from '../credentials.js';
import { PublicationCredentialCustodian } from '../symposium-publication-credentials.js';
import {
  GithubMainMergeSelection,
  GithubMainMergeSelectionError,
  type GithubMainMergeRegistration,
} from '../github-main-merge-selection.js';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import {
  fixture as github,
  pins as basePins,
  config,
  merge,
} from './fixtures/github-main-publication.js';
import { reviewTelosWorkRoleContext } from '../telos-work-role-review.js';
import { retainTelosWorkRoleContext } from '../telos-work-role-context.js';
import {
  createTelosMainPublicationHost,
  type NativeMainPublicationCall,
} from '../telos-main-publication-host.js';
import { TelosMainPublication } from '../telos-main-publication.js';
import type { MainPublicationPins } from '../telos-main-publication-contract.js';

const external = vi.hoisted(() => ({
  execute: undefined as
    | undefined
    | ((
        command: string,
        args: readonly string[],
        options: { cwd: string; env: NodeJS.ProcessEnv },
      ) => Promise<{ stdout: string; stderr: string }>),
}));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(
    () => {
      throw Error('Only isolated external execution is expected');
    },
    {
      [Symbol.for('nodejs.util.promisify.custom')]: (
        command: string,
        args: readonly string[],
        options: { cwd: string; env: NodeJS.ProcessEnv },
      ) => {
        if (!external.execute) throw Error('External effect fixture is not installed');
        return external.execute(command, args, options);
      },
    },
  ),
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  external.execute = undefined;
  vi.unstubAllEnvs();
});
const signal = () => new AbortController().signal;

/** Actual custodian/resolver/default isolated cwd/runner/selector/adapter plus
 * canonical work, retained role, registry, real permission and ACK ledger.
 * Only external credential/process and operator UI replies are controlled.
 * NativeMainPublicationCall is the declared Core component port, not a forged
 * native/count/custody/admission row or an actual installed-native/App claim.
 */
function fixture(
  registrations?: (entry: GithubMainMergeRegistration) => GithubMainMergeRegistration[],
) {
  const data = createTelosCanonicalData();
  cleanups.push(() => data.close());
  const command = (operation: object) =>
    data.work.execute(
      {
        requestId: randomUUID(),
        itemId: 'studio',
        expectedRevision: data.work.read('studio', data.actor).revision,
        ...operation,
      },
      data.actor,
    );
  command({ operation: 'classify', kind: 'outcome' });
  command({
    operation: 'link',
    role: 'lead',
    conversation: { namespace: 'mitzo', conversationId: 'planning' },
  });
  command({
    operation: 'assign',
    role: 'lead',
    conversationId: 'planning',
    expectedAssignmentRevision: 0,
  });
  const account = {
    ...basePins.authority.accountBinding,
    accountLabel: 'Offline component account',
  };
  data.events.upsertSession({
    sessionId: 'planning',
    conversationSource: 'mitzo',
    accountBinding: account,
  });
  const role = reviewTelosWorkRoleContext({
    work: data.work,
    actor: data.actor,
    itemId: 'studio',
    role: 'lead',
    selectedSourceSnapshotIds: [],
    selectedArtifactRefs: [],
  });
  retainTelosWorkRoleContext(data.events, 'planning', account, role);
  const requests: Record<string, unknown>[] = [];
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  registry.register('client', {
    sessionId: 'planning',
    accountBinding: account,
    mode: 'agent',
    sessionAllowList: new Set(),
    abortController: new AbortController(),
    transport: {
      isOpen: () => true,
      send(event) {
        if (event.type !== 'permission_request') return;
        requests.push(event);
        queueMicrotask(() => resolvePending(event.permId as string, 'once', undefined, 'planning'));
      },
    },
  });
  const session = registry.get('client')!,
    native = new AbortController();
  const state = {
    credential: 's6-selection-synthetic-credential',
    resolves: 0,
    assertion: (): unknown => undefined,
    beforeCredential: async (_number: number) => {},
    afterReply: () => {},
  };
  const context: NativeMainPublicationCall = {
    operatorId: data.actor.id,
    conversationId: 'planning',
    clientId: 'client',
    session,
    runtimeId: 'original-component-native',
    accountBinding: { ...basePins.authority.accountBinding },
    selectedRole: role,
    signal: native.signal,
    assertCurrentSync() {
      if (registry.get('client') !== session || !isDeepStrictEqual(session.accountBinding, account))
        throw Error('Original native component scope changed');
      return state.assertion();
    },
  };
  const pins: MainPublicationPins = {
    ...structuredClone(basePins),
    input: {
      ...basePins.input,
      itemId: 'studio',
      workRevision: data.work.read('studio', data.actor).revision,
    },
    authority: {
      ...basePins.authority,
      operatorId: data.actor.id,
      conversationId: 'planning',
      runtimeId: context.runtimeId,
      assignmentRevision: 1,
      attemptId: null,
    },
  };
  const remote = github(pins);
  const executed: Array<{ cwd: string; args: readonly string[] }> = [];
  external.execute = async (program, args, options) => {
    expect(program).toBe('gh');
    expect(existsSync(options.cwd)).toBe(true);
    expect(options.env.HOME).toBe(options.cwd);
    expect(options.env.GH_CONFIG_DIR).toBe(options.cwd);
    expect(options.env.GH_TOKEN).toBe('s6-selection-synthetic-credential');
    executed.push({ cwd: options.cwd, args });
    const response = await remote.run(program, args);
    if (args.some((arg) => arg.includes('mergePullRequest('))) state.afterReply();
    return response;
  };
  const custodian = new PublicationCredentialCustodian(
    new CredentialResolver({
      test: {
        resolve: async (reference) => {
          expect(reference).toEqual({
            provider: 'test',
            service: 'github-main',
            account: 'selected-operator',
          });
          state.resolves++;
          await state.beforeCredential(state.resolves);
          return state.credential;
        },
      },
    }),
  );
  const registration: GithubMainMergeRegistration = {
    ...config,
    accountId: account.accountId,
    label: 'Explicit main merge',
    credentialRef: { provider: 'test', service: 'github-main', account: 'selected-operator' },
    repositoryId: pins.resource.repositoryId,
    repositoryNodeId: pins.resource.repositoryNodeId,
    requiredChecks: [...config.requiredChecks],
  };
  const selection = new GithubMainMergeSelection({
    custodian,
    registrations: registrations ? registrations(registration) : [registration],
  });
  cleanups.push(() => selection.close());
  const makeOwner = (selected = selection) =>
    new TelosMainPublication(
      data.work,
      createTelosMainPublicationHost({
        registry,
        events: data.events,
        work: data.work,
        context,
        select: selected.bind(context),
      }),
    );
  const afterCwdBeforeDispatch = (action: () => void) => {
    let mainReads = 0,
      phase = 0;
    remote.state.afterRead = (path) => {
      if (
        !remote.state.merged &&
        requests.length === 1 &&
        path.endsWith('/git/ref/heads/main') &&
        ++mainReads === 2
      )
        phase = 1;
    };
    state.beforeCredential = async () => {
      if (phase === 1)
        phase = 2; // existing final-read post-response verification
      else if (phase === 2)
        phase = 3; // mutation runner's initial credential verification
      else if (phase === 3) {
        phase = 4;
        action();
      } // actual default runner after mkdtemp, before final callback
    };
    return () => phase;
  };
  return {
    data,
    registry,
    session,
    context,
    pins,
    remote,
    state,
    custodian,
    registration,
    selection,
    requests,
    executed,
    native,
    makeOwner,
    afterCwdBeforeDispatch,
  };
}
it('selects the unique explicit captured-account entry without ambient credentials and performs one real-owner approved merge', async () => {
  vi.stubEnv('GH_TOKEN', 'unrelated-ambient-fixture-token');
  vi.stubEnv('GITHUB_TOKEN', 'another-ambient-fixture-token');
  const f = fixture();
  expect(f.selection.supportsAccount(f.context.accountBinding.accountId)).toBe(true);
  expect(f.state.resolves).toBe(0);
  expect(await f.makeOwner().request(f.pins.input, signal())).toMatchObject({
    state: 'accepted',
    verification: 'acknowledged_squash',
    mergeCommit: merge,
  });
  expect(f.requests).toHaveLength(1);
  expect(f.remote.state.mutations).toBe(1);
  expect(
    f.data.work.mainPublicationsForHost().existingForHost(f.pins.input, f.pins.authority)!
      .approvalReceiptId,
  ).toEqual(expect.any(String));
  expect(
    f.data.db
      .prepare('SELECT merge_commit FROM telos_work_main_publication_acknowledgements')
      .all(),
  ).toEqual([{ merge_commit: merge }]);
  expect(f.executed.length).toBeGreaterThan(1);
  expect(f.executed.every((call) => !existsSync(call.cwd))).toBe(true);
  expect(JSON.stringify(f.requests)).not.toContain('credentialRef');
  expect(JSON.stringify(f.requests)).not.toContain('synthetic-credential');
});
it.each(['missing', 'ambiguous'] as const)(
  'configuration-only eligibility refuses %s account selection without credential reads',
  async (kind) => {
    const f = fixture((entry) =>
      kind === 'missing'
        ? []
        : [
            entry,
            { ...entry, connectionId: 'another-explicit-connection', capabilityId: 'another-main' },
          ],
    );
    expect(f.selection.supportsAccount(f.context.accountBinding.accountId)).toBe(false);
    expect(f.state.resolves).toBe(0);
    await expect(f.selection.bind(f.context)(f.pins.input, signal())).rejects.toMatchObject({
      code: 'main_merge_unavailable',
      reason: kind === 'missing' ? 'missing_configuration' : 'ambiguous_configuration',
    });
    expect(f.state.resolves).toBe(0);
    expect(f.executed).toHaveLength(0);
  },
);
it('account isolation chooses no entry for an unrelated captured account', async () => {
  const f = fixture((entry) => [{ ...entry, accountId: 'unrelated-account' }]);
  expect(f.selection.supportsAccount(f.context.accountBinding.accountId)).toBe(false);
  await expect(f.selection.bind(f.context)(f.pins.input, signal())).rejects.toMatchObject({
    reason: 'missing_configuration',
  });
  expect(f.state.resolves).toBe(0);
});
it('configuration snapshots cannot be rebound through later mutation of the registration object', async () => {
  const f = fixture();
  f.registration.accountId = 'replacement-account';
  f.registration.repository = 'other/project';
  f.registration.repositoryId = 999;
  f.registration.requiredChecks.length = 0;
  f.registration.credentialRef.account = 'replacement-ref';
  expect(f.selection.supportsAccount(f.context.accountBinding.accountId)).toBe(true);
  expect(f.selection.supportsAccount('replacement-account')).toBe(false);
  expect((await f.makeOwner().request(f.pins.input, signal())).state).toBe('accepted');
  expect(f.remote.state.mutations).toBe(1);
});
it('native input cannot choose connection/repository/account authority', async () => {
  const f = fixture();
  await expect(
    f.selection.bind(f.context)(
      { ...f.pins.input, connectionId: 'forged' } as typeof f.pins.input,
      signal(),
    ),
  ).rejects.toMatchObject({ reason: 'invalid_intent' });
  expect(f.state.resolves).toBe(0);
  expect(f.executed).toHaveLength(0);
});
it('immutable configured repository identity refuses reused name resolution before approval', async () => {
  const f = fixture();
  f.remote.state.repositoryId = 999;
  await expect(f.makeOwner().request(f.pins.input, signal())).rejects.toMatchObject({
    reason: 'repository_changed',
  });
  expect(f.requests).toHaveLength(0);
  expect(f.remote.state.mutations).toBe(0);
});
it('pinned original repository identity cannot be rebound for inspection', async () => {
  const f = fixture();
  const lease = await f.selection.bind(f.context)(f.pins.input, signal());
  await expect(
    lease.capability.inspect(
      { ...f.pins, resource: { ...f.pins.resource, repositoryNodeId: 'R_reused' } },
      signal(),
    ),
  ).rejects.toMatchObject({ reason: 'repository_changed' });
  expect(f.executed).toHaveLength(0);
});
it.each([
  'registry-close',
  'native-abort',
  'native-replacement',
  'credential-replacement',
  'async-currentness',
] as const)(
  'real default runner refuses %s after cwd preparation before final admission/effect',
  async (kind) => {
    const f = fixture();
    const phase = f.afterCwdBeforeDispatch(() => {
      if (kind === 'registry-close') f.selection.close();
      if (kind === 'native-abort') f.native.abort();
      if (kind === 'native-replacement') f.registry.register('client', { ...f.session });
      if (kind === 'credential-replacement') f.state.credential = 'changed-external-credential';
      if (kind === 'async-currentness') f.state.assertion = async () => {};
    });
    expect((await f.makeOwner().request(f.pins.input, signal())).state).toBe('denied');
    expect(phase()).toBe(4);
    expect(f.requests).toHaveLength(1);
    expect(f.remote.state.mutations).toBe(0);
    expect(
      f.data.work.mainPublicationsForHost().existingForHost(f.pins.input, f.pins.authority),
    ).not.toHaveProperty('approvalReceiptId');
    expect(
      f.data.db.prepare('SELECT 1 FROM telos_work_main_publication_acknowledgements').all(),
    ).toHaveLength(0);
    expect(f.executed.every((call) => !existsSync(call.cwd))).toBe(true);
  },
);
it.each(['close', 'native-abort'] as const)(
  'received successful merge reply survives %s for actual immutable validation/append-only ACK',
  async (kind) => {
    const f = fixture();
    f.state.afterReply = () => {
      if (kind === 'close') f.selection.close();
      else f.native.abort();
    };
    expect(await f.makeOwner().request(f.pins.input, signal())).toMatchObject({
      state: 'uncertain',
      acknowledgedMergeCommits: [merge],
    });
    expect(f.remote.state.mutations).toBe(1);
    expect(f.requests).toHaveLength(1);
    expect(
      f.data.db
        .prepare('SELECT merge_commit FROM telos_work_main_publication_acknowledgements')
        .all(),
    ).toEqual([{ merge_commit: merge }]);
  },
);
it.each(['async-reject', 'nonvoid'] as const)(
  'rejects and drains %s native-currentness callbacks before selecting a credential',
  async (kind) => {
    const f = fixture();
    f.state.assertion =
      kind === 'async-reject'
        ? async () => {
            throw Error('Synthetic failed assertion');
          }
        : () => true;
    expect(() => f.selection.bind(f.context)).toThrow(GithubMainMergeSelectionError);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.state.resolves).toBe(0);
    expect(f.executed).toHaveLength(0);
  },
);
it.each(['registry', 'native'] as const)(
  'selection aborted by %s while actual credential provider awaits grants no lease/effect',
  async (kind) => {
    const f = fixture();
    f.state.beforeCredential = async (number) => {
      if (number === 1) {
        await Promise.resolve();
        if (kind === 'registry') f.selection.close();
        else f.native.abort();
      }
    };
    await expect(f.selection.bind(f.context)(f.pins.input, signal())).rejects.toThrow();
    expect(f.executed).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  },
);
it('disconnect/close invalidate original leases idempotently without adopting successor credentials', async () => {
  const f = fixture();
  const lease = await f.selection.bind(f.context)(f.pins.input, signal());
  expect(lease.assertCurrentSync()).toBeUndefined();
  f.selection.disconnect(f.registration.connectionId);
  expect(lease.signal.aborted).toBe(true);
  expect(() => lease.assertCurrentSync()).toThrow();
  expect(f.selection.supportsAccount(f.context.accountBinding.accountId)).toBe(false);
  const revision = f.custodian.list()[0]!.revision;
  f.selection.close();
  f.selection.close();
  expect(f.custodian.list()[0]!.revision).toBe(revision);
  expect(f.executed).toHaveLength(0);
});
it('cannot adopt a pre-existing credential registration from another purpose', () => {
  const f = fixture(() => []);
  f.custodian.register(
    f.registration.connectionId,
    'Other existing grant',
    f.registration.credentialRef,
  );
  expect(
    () => new GithubMainMergeSelection({ custodian: f.custodian, registrations: [f.registration] }),
  ).toThrow(GithubMainMergeSelectionError);
  expect(f.custodian.list()).toHaveLength(1);
  expect(f.state.resolves).toBe(0);
});
it('rejects handle-shaped/unknown or invalid registry configuration without selecting credentials', () => {
  const f = fixture(() => []);
  for (const config of [
    { ...f.registration, handle: {} },
    { ...f.registration, repositoryId: Number.MAX_SAFE_INTEGER + 1 },
    { ...f.registration, requiredChecks: ['CI'] },
    {
      ...f.registration,
      credentialRef: { ...f.registration.credentialRef, token: 'not-a-reference' },
    },
  ])
    expect(
      () => new GithubMainMergeSelection({ custodian: f.custodian, registrations: [config] }),
    ).toThrow(GithubMainMergeSelectionError);
  expect(f.custodian.list()).toHaveLength(0);
  expect(f.state.resolves).toBe(0);
});
