import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import {
  fixture as githubFixture,
  pins as basePins,
  merge,
} from './fixtures/github-main-publication.js';
import { reviewTelosWorkRoleContext } from '../telos-work-role-review.js';
import { retainTelosWorkRoleContext } from '../telos-work-role-context.js';
import { TelosMainPublication } from '../telos-main-publication.js';
import {
  createTelosMainPublicationHost,
  type NativeMainPublicationCall,
} from '../telos-main-publication-host.js';
import type { MainPublicationPins } from '../telos-main-publication-contract.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
const signal = () => new AbortController().signal;

/** Host component boundary only. Actual canonical work, event/role custody,
 * registry, permission handler and GitHub adapter are exercised. Core's native
 * capture/selected-custodian ports remain external component inputs here, not
 * fabricated count/custody/admission or actual Core/App qualification.
 */
function fixture(retainRole = true) {
  const canonical = createTelosCanonicalData();
  cleanups.push(() => canonical.close());
  const command = (operation: object) =>
    canonical.work.execute(
      {
        requestId: randomUUID(),
        itemId: 'studio',
        expectedRevision: canonical.work.read('studio', canonical.actor).revision,
        ...operation,
      },
      canonical.actor,
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
  canonical.events.upsertSession({
    sessionId: 'planning',
    conversationSource: 'mitzo',
    accountBinding: account,
  });
  const selectedRole = retainRole
    ? reviewTelosWorkRoleContext({
        work: canonical.work,
        actor: canonical.actor,
        itemId: 'studio',
        role: 'lead',
        selectedSourceSnapshotIds: [],
        selectedArtifactRefs: [],
      })
    : undefined;
  if (selectedRole) retainTelosWorkRoleContext(canonical.events, 'planning', account, selectedRole);
  const requests: Record<string, unknown>[] = [];
  let reply = (event: Record<string, unknown>) => {
    resolvePending(event.permId as string, 'once', undefined, 'planning');
  };
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
        queueMicrotask(() => reply(event));
      },
    },
  });
  const nativeSignal = new AbortController(),
    selectedSignal = new AbortController();
  const state = {
    nativeCurrent: true,
    selectedCurrent: true,
    selects: 0,
    afterSelect: async () => {},
  };
  const session = registry.get('client')!;
  const context: NativeMainPublicationCall = {
    operatorId: canonical.actor.id,
    conversationId: 'planning',
    clientId: 'client',
    session,
    accountBinding: account,
    runtimeId: 'original-component-native',
    selectedRole,
    signal: nativeSignal.signal,
    assertCurrentSync() {
      if (!state.nativeCurrent) throw Error('Original native capture changed');
    },
  };
  const pins: MainPublicationPins = {
    ...structuredClone(basePins),
    input: {
      ...basePins.input,
      itemId: 'studio',
      workRevision: canonical.work.read('studio', canonical.actor).revision,
    },
    authority: {
      ...basePins.authority,
      operatorId: canonical.actor.id,
      conversationId: 'planning',
      runtimeId: context.runtimeId,
      accountBinding: { ...basePins.authority.accountBinding },
      assignmentRevision: 1,
      attemptId: null,
    },
  };
  const gh = githubFixture(pins);
  const makeHost = (native = context) =>
    createTelosMainPublicationHost({
      registry,
      events: canonical.events,
      work: canonical.work,
      context: native,
      select: async () => {
        state.selects++;
        await state.afterSelect();
        return {
          capability: gh.adapter,
          signal: selectedSignal.signal,
          assertCurrentSync() {
            if (!state.selectedCurrent) throw Error('Original selected capability changed');
          },
        };
      },
    });
  const host = makeHost();
  const owner = new TelosMainPublication(canonical.work, host);
  const changeWork = () =>
    command({
      operation: 'link',
      role: 'advisor',
      conversation: { namespace: 'mitzo', conversationId: 'planning' },
    });
  return {
    canonical,
    command,
    account,
    context,
    selectedRole,
    registry,
    session,
    requests,
    state,
    pins,
    gh,
    host,
    owner,
    makeHost,
    changeWork,
    nativeSignal,
    selectedSignal,
    setReply(next: typeof reply) {
      reply = next;
    },
  };
}

it('HOST: derives actual work/assignment and scoped selected identity, then uses real one-use permission and one verified merge', async () => {
  const f = fixture();
  const result = await f.owner.request(f.pins.input, signal());
  expect(result).toMatchObject({
    state: 'accepted',
    mergeCommit: merge,
    verification: 'acknowledged_squash',
  });
  const retained = f.canonical.work
    .mainPublicationsForHost()
    .existingForHost(f.pins.input, f.pins.authority)!;
  expect(retained.pins.authority).toEqual(f.pins.authority);
  expect(retained.approvalReceiptId).toEqual(expect.any(String));
  expect(f.requests).toHaveLength(1);
  expect(f.gh.state.mutations).toBe(1);
  expect(result).not.toHaveProperty('authority');
});
it('HOST: rejects authority in native input before selecting any capability or prompting', async () => {
  const f = fixture();
  await expect(
    f.owner.request({ ...f.pins.input, operatorId: 'forged' }, signal()),
  ).rejects.toThrow();
  expect(f.state.selects).toBe(0);
  expect(f.requests).toHaveLength(0);
  expect(f.gh.state.mutations).toBe(0);
});
it.each(['account', 'registry', 'native capture', 'retained role'] as const)(
  'HOST: refuses changed %s around asynchronous selection',
  async (kind) => {
    const f = fixture();
    f.state.afterSelect = async () => {
      if (kind === 'account')
        f.session.accountBinding = { ...f.account, profileRevision: 'changed' };
      if (kind === 'registry')
        f.registry.register('client', { ...f.session, sessionId: 'planning' });
      if (kind === 'native capture') f.state.nativeCurrent = false;
      if (kind === 'retained role')
        f.canonical.events.append('planning', 'telos_work_role_context', { version: 0 });
    };
    await expect(f.owner.request(f.pins.input, signal())).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
    expect(f.gh.state.mutations).toBe(0);
  },
);
it.each(['native', 'selected'] as const)(
  'HOST: %s cancellation during selection cannot create a publication receipt',
  async (kind) => {
    const f = fixture();
    f.state.afterSelect = async () => {
      (kind === 'native' ? f.nativeSignal : f.selectedSignal).abort();
    };
    await expect(f.owner.request(f.pins.input, signal())).rejects.toThrow();
    expect(f.canonical.db.prepare('SELECT 1 FROM telos_work_main_publications').all()).toHaveLength(
      0,
    );
    expect(f.requests).toHaveLength(0);
    expect(f.gh.state.mutations).toBe(0);
  },
);
it.each(['native', 'selected', 'work'] as const)(
  'HOST: changed %s during real permission cannot authorize dispatch',
  async (kind) => {
    const f = fixture();
    f.setReply((event) => {
      if (kind === 'native') f.state.nativeCurrent = false;
      if (kind === 'selected') f.state.selectedCurrent = false;
      if (kind === 'work') f.changeWork();
      resolvePending(event.permId as string, 'once', undefined, 'planning');
    });
    expect((await f.owner.request(f.pins.input, signal())).state).toBe('denied');
    expect(f.requests).toHaveLength(1);
    expect(f.gh.state.mutations).toBe(0);
  },
);
it('HOST: selected publisher replacement during real dispatch preparation is denied before any effect/admission', async () => {
  const f = fixture();
  f.gh.state.prepareDispatch = async () => {
    await Promise.resolve();
    f.state.selectedCurrent = false;
  };
  expect((await f.owner.request(f.pins.input, signal())).state).toBe('denied');
  expect(f.gh.state.mutations).toBe(0);
  expect(
    f.canonical.work.mainPublicationsForHost().existingForHost(f.pins.input, f.pins.authority),
  ).not.toHaveProperty('approvalReceiptId');
});
it('HOST: a context without a retained role cannot gain fresh merge authority from assignment alone', async () => {
  const f = fixture(false);
  expect((await f.owner.request(f.pins.input, signal())).state).toBe('denied');
  expect(f.requests).toHaveLength(0);
  expect(f.gh.state.mutations).toBe(0);
});
it('HOST: original uncertainty remains observational after work/runtime changes without fresh permission or effect', async () => {
  const f = fixture();
  f.gh.state.loseReply = true;
  expect((await f.owner.request(f.pins.input, signal())).state).toBe('uncertain');
  f.changeWork();
  const recovered = new TelosMainPublication(
    f.canonical.work,
    f.makeHost({ ...f.context, runtimeId: 'replacement-component-native' }),
  );
  expect(await recovered.request(f.pins.input, signal())).toMatchObject({
    state: 'accepted',
    verification: 'observed_merged',
  });
  expect(f.requests).toHaveLength(1);
  expect(f.gh.state.mutations).toBe(1);
  expect(
    f.canonical.work.mainPublicationsForHost().existingForHost(f.pins.input, f.pins.authority)!.pins
      .authority.runtimeId,
  ).toBe(f.context.runtimeId);
});
it('HOST: one captured native call cannot select another input, and returned authority cannot mutate its custody', async () => {
  const f = fixture();
  const resolved = await f.host.resolve(f.pins.input, signal());
  resolved.authority.runtimeId = 'caller rewrite';
  await expect(
    f.host.resolve({ ...f.pins.input, requestId: 'different' }, signal()),
  ).rejects.toThrow();
  const again = await f.host.resolve(f.pins.input, signal());
  expect(again.authority.runtimeId).toBe(f.context.runtimeId);
  expect(f.state.selects).toBe(1);
  expect(f.requests).toHaveLength(0);
});

it('HOST: a newly changed work kind cannot use the old retained role context even with a fresh work revision', async () => {
  const f = fixture();
  f.command({ operation: 'classify', kind: 'coordinator' });
  const input = {
    ...f.pins.input,
    workRevision: f.canonical.work.read('studio', f.canonical.actor).revision,
  };
  expect((await f.owner.request(input, signal())).state).toBe('denied');
  expect(f.requests).toHaveLength(0);
  expect(f.gh.state.mutations).toBe(0);
});
