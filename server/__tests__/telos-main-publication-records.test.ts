import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { TelosMainPublication } from '../telos-main-publication.js';
import type { MainPublicationHost } from '../telos-main-publication.js';
import {
  fixture as githubFixture,
  head,
  main,
  merge,
  approved,
} from './fixtures/github-main-publication.js';
import { TelosWorkStore } from '../telos-work-store.js';
import { TelosMainPublicationRecords } from '../telos-main-publication-records.js';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { approveGithubMainPublication } from '../github-main-publication-permission.js';
import type { MainPublicationPins } from '../telos-main-publication-contract.js';
import { projectMainPublicationResult } from '../telos-main-publication-contract.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
/** Component checks use the actual canonical fixture/store, controls and ordinary
 * permission owner. Approval receipts come from real once-only permission
 * responses; no accepted receipt/remote result is manufactured. These are not
 * native installation or runtime/account qualification tests. */
function fixture() {
  const canonical = createTelosCanonicalData();
  cleanups.push(() => canonical.close());
  const command = (itemId: string, operation: object) =>
    canonical.work.execute(
      {
        requestId: randomUUID(),
        itemId,
        expectedRevision: canonical.work.read(itemId, canonical.actor).revision,
        ...operation,
      },
      canonical.actor,
    );
  const add = (id: string, kind: string) => {
    canonical.db
      .prepare(
        "INSERT INTO items(id,summary,profile,first_seen,last_seen,created_at,updated_at) VALUES(?,?,'manual',?,?,?,?)",
      )
      .run(id, id, canonical.stamp, canonical.stamp, canonical.stamp, canonical.stamp);
    command(id, { operation: 'classify', kind });
  };
  const assign = (id: string) => {
    command(id, {
      operation: 'link',
      role: 'lead',
      conversation: { namespace: 'mitzo', conversationId: 'planning' },
    });
    command(id, {
      operation: 'assign',
      role: 'lead',
      conversationId: 'planning',
      expectedAssignmentRevision: 0,
    });
  };
  command('studio', { operation: 'classify', kind: 'outcome' });
  assign('studio');
  add('coordinator', 'coordinator');
  assign('coordinator');
  add('priority', 'outcome');
  canonical.db
    .prepare("UPDATE items SET parent_id='coordinator' WHERE id IN ('studio','priority')")
    .run();
  const pins: MainPublicationPins = {
    contract: 'normal-pr-rules-v1',
    input: {
      requestId: 'publish',
      itemId: 'studio',
      pullRequest: 9,
      sourceHead: 'a'.repeat(40),
      workRevision: canonical.work.read('studio', canonical.actor).revision,
    },
    authority: {
      operatorId: canonical.actor.id,
      conversationId: 'planning',
      accountBinding: {
        accountId: 'offline-component-account',
        provider: 'openai-codex',
        model: 'offline-fixture',
        profileRevision: 'profile-1',
      },
      runtimeId: 'offline-component-runtime',
      connectionId: 'configured-connection',
      capabilityId: 'configured-merge',
      repository: 'owner/project',
      assignmentRevision: 1,
      attemptId: null,
    },
    resource: {
      repositoryId: 101,
      repositoryNodeId: 'R_original',
      pullRequestId: 901,
      pullRequestNodeId: 'PR_original',
    },
    baseBranch: 'main',
    method: 'squash',
  };
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  const requests: Record<string, unknown>[] = [];
  let reply = (event: Record<string, unknown>) =>
    resolvePending(event.permId as string, 'once', undefined, 'planning');
  registry.register('client', {
    sessionId: 'planning',
    mode: 'agent',
    sessionAllowList: new Set(),
    abortController: new AbortController(),
    transport: {
      isOpen: () => true,
      send: (event) => {
        if (event.type !== 'permission_request') return;
        requests.push(event);
        queueMicrotask(() => reply(event));
      },
    },
  });
  const assertCurrent = () => {
    canonical.work.mainPublicationsForHost().assertWorkCurrent(pins);
    canonical.work.assertControlAction('studio', 'publication', 'b'.repeat(40));
  };
  const approve = (selected = pins) =>
    approveGithubMainPublication(
      registry,
      'client',
      {
        toolName: 'RequestGithubMainPublication',
        pins: selected,
      },
      new AbortController().signal,
      () => canonical.work.mainPublicationsForHost().assertWorkCurrent(selected),
    );
  const hold = () =>
    canonical.work.requestControl(
      {
        requestId: randomUUID(),
        coordinatorItemId: 'coordinator',
        priorityItemId: 'priority',
        targetItemIds: ['studio'],
        scope: 'publication',
      },
      canonical.actor,
    );
  return {
    canonical,
    registry,
    setReply: (action: typeof reply) => {
      reply = action;
    },
    command,
    pins,
    requests,
    approve,
    hold,
    assertCurrent,
    records: () => canonical.work.mainPublicationsForHost(),
  };
}

it('retains exact requested pins across real store restart and rejects changed input/account/connection', () => {
  const f = fixture();
  const requested = f.records().prepare(f.pins);
  expect(projectMainPublicationResult(requested)).toEqual({ ...f.pins.input, state: 'requested' });
  f.canonical.restartOwners();
  expect(f.records().prepare(f.pins)).toEqual(requested);
  for (const modified of [
    { ...f.pins, input: { ...f.pins.input, sourceHead: 'c'.repeat(40) } },
    {
      ...f.pins,
      authority: {
        ...f.pins.authority,
        accountBinding: { ...f.pins.authority.accountBinding, accountId: 'changed' },
      },
    },
    { ...f.pins, authority: { ...f.pins.authority, connectionId: 'changed' } },
    { ...f.pins, resource: { ...f.pins.resource, repositoryId: 999 } },
    {
      ...f.pins,
      authority: {
        ...f.pins.authority,
        accountBinding: { ...f.pins.authority.accountBinding, provider: 'openai' as const },
      },
    },
    {
      ...f.pins,
      authority: {
        ...f.pins.authority,
        accountBinding: { ...f.pins.authority.accountBinding, model: 'changed' },
      },
    },
    {
      ...f.pins,
      authority: {
        ...f.pins.authority,
        accountBinding: { ...f.pins.authority.accountBinding, profileRevision: 'changed' },
      },
    },
  ])
    expect(() => f.records().prepare(modified)).toThrow(/identity|authority|account binding/);
});
it('records uncertainty with a genuine one-use approval before effects and never resets it on denial/restart', async () => {
  const f = fixture();
  f.records().prepare(f.pins);
  const approval = (await f.approve())!;
  expect(f.requests).toHaveLength(1);
  f.records().admit(f.pins, approval.receiptId, f.assertCurrent, {
    inspectedMainHead: 'b'.repeat(40),
    admittedMainHead: 'b'.repeat(40),
  });
  expect(f.records().deny(f.pins)).toMatchObject({
    state: 'uncertain',
    approvalReceiptId: approval.receiptId,
  });
  f.canonical.restartOwners();
  expect(f.records().prepare(f.pins)).toMatchObject({
    state: 'uncertain',
    approvalReceiptId: approval.receiptId,
  });
  expect(() =>
    f.records().admit(f.pins, approval.receiptId, f.assertCurrent, {
      inspectedMainHead: 'b'.repeat(40),
      admittedMainHead: 'b'.repeat(40),
    }),
  ).toThrow(/already admitted/);
});
it('an actual requested hold after approval defeats later effect admission', async () => {
  const f = fixture();
  f.records().prepare(f.pins);
  const approval = (await f.approve())!;
  const control = f.hold();
  expect(() =>
    f.records().admit(f.pins, approval.receiptId, f.assertCurrent, {
      inspectedMainHead: 'b'.repeat(40),
      admittedMainHead: 'b'.repeat(40),
    }),
  ).toThrow(/hold/);
  expect(f.records().prepare(f.pins).state).toBe('requested');
  expect(f.canonical.work.readControl(control.controlId, f.canonical.actor).stage).toBe(
    'requested',
  );
});
it('a hold after admission retains requested/in-flight uncertainty without claiming the effect was prevented', async () => {
  const f = fixture();
  f.records().prepare(f.pins);
  const approval = (await f.approve())!;
  f.records().admit(f.pins, approval.receiptId, f.assertCurrent, {
    inspectedMainHead: 'b'.repeat(40),
    admittedMainHead: 'b'.repeat(40),
  });
  const control = f.hold();
  expect(f.records().hasUncertainForItems(['studio'])).toBe(true);
  f.canonical.restartOwners();
  expect(f.records().prepare(f.pins).state).toBe('uncertain');
  expect(f.canonical.work.readControl(control.controlId, f.canonical.actor).stage).toBe(
    'requested',
  );
});
it('a new request cannot remerge another original uncertain PR operation', async () => {
  const f = fixture();
  f.records().prepare(f.pins);
  const approval = (await f.approve())!;
  f.records().admit(f.pins, approval.receiptId, f.assertCurrent, {
    inspectedMainHead: 'b'.repeat(40),
    admittedMainHead: 'b'.repeat(40),
  });
  const other = { ...f.pins, input: { ...f.pins.input, requestId: 'second-request' } };
  f.records().prepare(other);
  const second = (await f.approve(other))!;
  expect(() =>
    f.records().admit(other, second.receiptId, f.assertCurrent, {
      inspectedMainHead: 'b'.repeat(40),
      admittedMainHead: 'b'.repeat(40),
    }),
  ).toThrow(/original publication/);
  expect(f.records().prepare(other).state).toBe('requested');
});
it('PUB-2: rotating the configured connection does not readmit the same unresolved remote PR', async () => {
  const f = fixture();
  f.records().prepare(f.pins);
  const approval = (await f.approve())!;
  f.records().admit(f.pins, approval.receiptId, f.assertCurrent, {
    inspectedMainHead: 'b'.repeat(40),
    admittedMainHead: 'b'.repeat(40),
  });
  const rotated = {
    ...f.pins,
    input: { ...f.pins.input, requestId: 'rotated-request' },
    authority: {
      ...f.pins.authority,
      connectionId: 'rotated-connection',
      capabilityId: 'rotated-capability',
    },
  };
  f.records().prepare(rotated);
  const second = (await f.approve(rotated))!;
  expect(() =>
    f.records().admit(rotated, second.receiptId, f.assertCurrent, {
      inspectedMainHead: 'b'.repeat(40),
      admittedMainHead: 'b'.repeat(40),
    }),
  ).toThrow(/original publication/);
  expect(f.records().prepare(f.pins).state).toBe('uncertain');
});
it('PUB-3: two actual SQLite owners cannot project a new hold applied across an in-flight admission', async () => {
  const f = fixture();
  f.records().prepare(f.pins);
  f.records().deny(f.pins);
  const other = new TelosWorkStore(f.canonical.dbPath, {
    ordinaryConversation: (id) => id === 'planning',
  });
  cleanups.push(() => other.close());
  (other as unknown as { db: Database.Database }).db.pragma('busy_timeout = 0');
  const otherPins = { ...f.pins, input: { ...f.pins.input, requestId: 'other-owner' } };
  other.mainPublicationsForHost().prepare(otherPins);
  const approval = (await f.approve(otherPins))!;
  let secondHold: ReturnType<typeof f.hold> | undefined;
  let blocked = false;
  const interleave = () => {
    other.mainPublicationsForHost().admit(
      otherPins,
      approval.receiptId,
      () => {
        other.assertControlAction('studio', 'publication', 'b'.repeat(40));
      },
      { inspectedMainHead: 'b'.repeat(40), admittedMainHead: 'b'.repeat(40) },
    );
    secondHold = other.requestControl(
      {
        requestId: 'second-hold',
        coordinatorItemId: 'coordinator',
        priorityItemId: 'priority',
        targetItemIds: ['studio'],
        scope: 'publication',
      },
      f.canonical.actor,
    );
  };
  // Observe the actual result, then attempt a real second SQLite owner's writes
  // at this phase. No fabricated uncertainty/count or enforcement result.
  const original = TelosMainPublicationRecords.prototype.hasUncertainForItems;
  let once = false;
  vi.spyOn(TelosMainPublicationRecords.prototype, 'hasUncertainForItems').mockImplementation(
    function (this: TelosMainPublicationRecords, items) {
      const actual = original.call(this, items);
      if (!once) {
        once = true;
        try {
          interleave();
        } catch (error) {
          if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
          blocked = true;
        }
      }
      return actual;
    },
  );
  try {
    f.canonical.work.recordMainPublicationDenialForHost(f.pins, () =>
      f.records().assertWorkCurrent(f.pins),
    );
  } catch (error) {
    if (!/hold/i.test(String(error))) throw error;
  }
  if (blocked) interleave();
  expect(secondHold).toBeDefined();
  expect(other.mainPublicationsForHost().prepare(otherPins).state).toBe('uncertain');
  expect(other.readControl(secondHold!.controlId, f.canonical.actor).stage).toBe('requested');
  expect(blocked).toBe(true);
});
it('current work changes after approval deny effect admission', async () => {
  const f = fixture();
  f.records().prepare(f.pins);
  const approval = (await f.approve())!;
  f.command('studio', {
    operation: 'link',
    role: 'reviewer',
    conversation: { namespace: 'mitzo', conversationId: 'planning' },
  });
  expect(() =>
    f.records().admit(f.pins, approval.receiptId, f.assertCurrent, {
      inspectedMainHead: 'b'.repeat(40),
      admittedMainHead: 'b'.repeat(40),
    }),
  ).toThrow(/Current publication/);
});
it('SQL custody rejects pin rewrites, deletes and uncertainty resets', async () => {
  const f = fixture();
  f.records().prepare(f.pins);
  expect(() =>
    f.canonical.db
      .prepare(
        "UPDATE telos_work_main_publications SET data=json_set(data,'$.pins.input.sourceHead',?,'$.state','denied')",
      )
      .run('c'.repeat(40)),
  ).toThrow(/pins are immutable/);
  const approval = (await f.approve())!;
  f.records().admit(f.pins, approval.receiptId, f.assertCurrent, {
    inspectedMainHead: 'b'.repeat(40),
    admittedMainHead: 'b'.repeat(40),
  });
  expect(() => f.canonical.db.prepare('DELETE FROM telos_work_main_publications').run()).toThrow(
    /retained/,
  );
  expect(() =>
    f.canonical.db
      .prepare("UPDATE telos_work_main_publications SET data=json_set(data,'$.state','requested')")
      .run(),
  ).toThrow(/cannot be reset/);
  expect(f.records().prepare(f.pins).state).toBe('uncertain');
});

it.each(['owner/renamed', 'new-owner/transferred'])(
  'IDENTITY: %s plus connection rotation cannot readmit the original remote PR',
  async (repository) => {
    const f = fixture();
    f.records().prepare(f.pins);
    const first = (await f.approve())!;
    f.records().admit(f.pins, first.receiptId, f.assertCurrent, {
      inspectedMainHead: 'b'.repeat(40),
      admittedMainHead: 'b'.repeat(40),
    });
    const renamed = {
      ...f.pins,
      input: { ...f.pins.input, requestId: 'new-resource-name' },
      authority: {
        ...f.pins.authority,
        repository,
        connectionId: 'rotated',
        capabilityId: 'rotated-capability',
      },
    };
    f.records().prepare(renamed);
    const second = (await f.approve(renamed))!;
    expect(() =>
      f.records().admit(renamed, second.receiptId, f.assertCurrent, {
        inspectedMainHead: 'b'.repeat(40),
        admittedMainHead: 'b'.repeat(40),
      }),
    ).toThrow(/original publication/);
    expect(f.records().prepare(f.pins).state).toBe('uncertain');
    expect(f.records().prepare(f.pins).pins.authority.repository).toBe('owner/project');
  },
);
it('IDENTITY: unidentified original uncertainty blocks new alias admission without retagging legacy custody', async () => {
  const f = fixture();
  const artifact = JSON.parse(
    readFileSync(new URL('./fixtures/telos-main-publication-legacy.json', import.meta.url), 'utf8'),
  );
  expect(artifact.producerSource).toBe('cc26595099ac4d0c2d585cc7894072bfd6df22b3');
  const legacy = artifact.receipt;
  // Byte-retained synthetic historical row produced by the original reviewed
  // source and actual ordinary permission owner; not a new approval/effect claim.
  const encoded = JSON.stringify(legacy);
  f.canonical.db
    .prepare('INSERT INTO telos_work_main_publications VALUES(?,?,?,?,?)')
    .run(
      JSON.stringify([legacy.pins.authority.operatorId, legacy.pins.authority.conversationId]),
      legacy.pins.input.requestId,
      legacy.pins.input.itemId,
      createHash('sha256').update(JSON.stringify(legacy.pins)).digest('hex'),
      encoded,
    );
  const next = {
    ...f.pins,
    input: { ...f.pins.input, requestId: 'after-legacy' },
    authority: {
      ...f.pins.authority,
      repository: 'new-owner/renamed',
      connectionId: 'new-connection',
    },
  };
  f.records().prepare(next);
  expect(() => f.records().existingForHost(legacy.pins.input, legacy.pins.authority)).toThrow(
    /identity|legacy/,
  );
  const approval = (await f.approve(next))!;
  expect(() =>
    f.records().admit(next, approval.receiptId, f.assertCurrent, {
      inspectedMainHead: 'b'.repeat(40),
      admittedMainHead: 'b'.repeat(40),
    }),
  ).toThrow(/identity|unidentified|legacy/i);
  const retained = f.canonical.db
    .prepare('SELECT data FROM telos_work_main_publications WHERE request_id=?')
    .get(legacy.pins.input.requestId) as { data: string };
  expect(retained.data).toBe(encoded);
});

/** Real backend/store/permission/adapter composition with a captured component
 * scope at the genuine-host port; no mocked approval or publication operation.
 * This is NOT Core selected-native/account/runtime qualification or App proof. */
function backend(
  f: ReturnType<typeof fixture>,
  gh = githubFixture(f.pins),
  work = f.canonical.work,
) {
  const original = f.registry.get('client')!;
  const host: MainPublicationHost = {
    resolve: async () => ({ authority: structuredClone(f.pins.authority), capability: gh.adapter }),
    assertCurrent: (pins) => {
      if (
        f.registry.get('client') !== original ||
        original.abortController.signal.aborted ||
        !isDeepStrictEqual(pins.authority, f.pins.authority)
      )
        throw new Error('Original component scope changed');
      f.records().assertWorkCurrent(pins);
    },
    approve: (presentation, signal) =>
      approveGithubMainPublication(f.registry, 'client', presentation, signal, () =>
        host.assertCurrent(presentation.pins),
      ),
  };
  return { owner: new TelosMainPublication(work, host), gh };
}
const requestSignal = () => new AbortController().signal;
it('normal backend: real permission, released hold and changed current main yield one verified squash with distinct observations', async () => {
  const f = fixture();
  const h = f.hold();
  f.canonical.work.releaseControl(
    { requestId: 'release', controlId: h.controlId },
    f.canonical.actor,
  );
  const b = backend(f);
  const changed = 'd'.repeat(40);
  let beforeEffect: unknown;
  f.setReply((event) => {
    resolvePending(event.permId as string, 'once', undefined, 'planning');
    b.gh.state.currentMain = changed;
    b.gh.state.base = changed;
    return true;
  });
  b.gh.state.beforePut = () => {
    beforeEffect = f.records().prepare(f.pins);
  };
  const result = await b.owner.request(f.pins.input, requestSignal());
  expect(result).toMatchObject({
    state: 'accepted',
    inspectedMainHead: main,
    admittedMainHead: changed,
    acceptedBaseHead: changed,
    acceptedMainHead: merge,
    mergeCommit: merge,
    verification: 'acknowledged_squash',
  });
  expect(beforeEffect).toMatchObject({
    state: 'uncertain',
    inspectedMainHead: main,
    admittedMainHead: changed,
    approvalReceiptId: expect.any(String),
  });
  expect(b.gh.state.mutations).toBe(1);
  expect(f.requests).toHaveLength(1);
  expect(() =>
    f.canonical.work.assertControlAction('studio', 'publication', changed),
  ).not.toThrow();
  expect(result).not.toHaveProperty('mainHead');
  expect(result).not.toHaveProperty('resource');
});
it('normal backend: changed source after approval denies; new source requires a new actual permission', async () => {
  const f = fixture();
  const b = backend(f);
  const next = 'd'.repeat(40);
  f.setReply((event) => {
    resolvePending(event.permId as string, 'once', undefined, 'planning');
    b.gh.state.sourceHead = next;
    return true;
  });
  expect((await b.owner.request(f.pins.input, requestSignal())).state).toBe('denied');
  expect(b.gh.state.mutations).toBe(0);
  expect(f.requests).toHaveLength(1);
  b.gh.state.reportBody = approved.replaceAll(head, next);
  f.setReply((event) => resolvePending(event.permId as string, 'once', undefined, 'planning'));
  const result = await b.owner.request(
    { ...f.pins.input, requestId: 'new-source', sourceHead: next },
    requestSignal(),
  );
  expect(result.state).toBe('accepted');
  expect(f.requests).toHaveLength(2);
  expect(b.gh.state.mutations).toBe(1);
});
it('normal backend: actual hold after permission prevents remote admission and retains genuine denial evidence', async () => {
  const f = fixture();
  const b = backend(f);
  let hold: ReturnType<typeof f.hold>;
  f.setReply((event) => {
    resolvePending(event.permId as string, 'once', undefined, 'planning');
    hold = f.hold();
    return true;
  });
  expect((await b.owner.request(f.pins.input, requestSignal())).state).toBe('denied');
  expect(b.gh.state.mutations).toBe(0);
  expect(f.canonical.work.readControl(hold!.controlId, f.canonical.actor).stage).toBe('applied');
});
it('normal backend: a hold after admitted uncertainty cannot claim to have prevented the in-flight call', async () => {
  const f = fixture();
  const b = backend(f);
  let hold: ReturnType<typeof f.hold>;
  b.gh.state.beforePut = () => {
    hold = f.hold();
  };
  expect((await b.owner.request(f.pins.input, requestSignal())).state).toBe('accepted');
  expect(b.gh.state.mutations).toBe(1);
  expect(f.canonical.work.readControl(hold!.controlId, f.canonical.actor).stage).toBe('requested');
});
it.each(['work', 'original session'])(
  'normal backend: %s currentness change after permission denies before effects',
  async (kind) => {
    const f = fixture();
    const b = backend(f);
    f.setReply((event) => {
      resolvePending(event.permId as string, 'once', undefined, 'planning');
      if (kind === 'work')
        f.command('studio', {
          operation: 'link',
          role: 'reviewer',
          conversation: { namespace: 'mitzo', conversationId: 'planning' },
        });
      else f.registry.get('client')!.abortController.abort();
      return true;
    });
    expect((await b.owner.request(f.pins.input, requestSignal())).state).toBe('denied');
    expect(b.gh.state.mutations).toBe(0);
  },
);
it('normal backend: lost reply survives actual store/owner restart, observes the original merged fact and never repeats mutation', async () => {
  const f = fixture();
  const b = backend(f);
  b.gh.state.loseReply = true;
  expect((await b.owner.request(f.pins.input, requestSignal())).state).toBe('uncertain');
  expect(f.records().prepare(f.pins)).not.toHaveProperty('remoteMergeCommit');
  f.canonical.restartOwners();
  const restarted = backend(f, b.gh);
  const result = await restarted.owner.request(f.pins.input, requestSignal());
  expect(result).toMatchObject({
    state: 'accepted',
    mergeCommit: merge,
    verification: 'observed_merged',
  });
  expect(b.gh.state.mutations).toBe(1);
  expect(f.requests).toHaveLength(1);
});
it('normal backend: a retained server acknowledgement survives failed post-inspection and restart', async () => {
  const f = fixture();
  const b = backend(f);
  let fail = true;
  b.gh.state.afterRead = (path) => {
    if (b.gh.state.merged && path.endsWith('/pulls/9') && fail) {
      fail = false;
      throw new Error('Post-inspection unavailable');
    }
  };
  expect((await b.owner.request(f.pins.input, requestSignal())).state).toBe('uncertain');
  expect(f.records().prepare(f.pins)).toMatchObject({
    remoteMergeCommit: merge,
    admittedMainHead: main,
  });
  f.canonical.restartOwners();
  expect(await backend(f, b.gh).owner.request(f.pins.input, requestSignal())).toMatchObject({
    state: 'accepted',
    verification: 'acknowledged_squash',
  });
  expect(b.gh.state.mutations).toBe(1);
});
it('normal backend: rejected/unconfirmed result remains uncertain across reads, not safe to repeat', async () => {
  const f = fixture();
  const b = backend(f);
  b.gh.state.refuse = true;
  expect((await b.owner.request(f.pins.input, requestSignal())).state).toBe('uncertain');
  expect((await b.owner.request(f.pins.input, requestSignal())).state).toBe('uncertain');
  expect(b.gh.state.mutations).toBe(1);
  expect(f.requests).toHaveLength(1);
});
it('normal backend: historical exact-main receipt keeps its original pins/base and cannot acquire normal-rules effect authority', async () => {
  const f = fixture();
  const legacy = JSON.parse(
    readFileSync(
      new URL('./fixtures/telos-main-publication-exact-main-legacy.json', import.meta.url),
      'utf8',
    ),
  ).receipt;
  const bytes = JSON.stringify(legacy.pins);
  f.canonical.db
    .prepare('INSERT INTO telos_work_main_publications VALUES(?,?,?,?,?)')
    .run(
      JSON.stringify([legacy.pins.authority.operatorId, legacy.pins.authority.conversationId]),
      legacy.pins.input.requestId,
      legacy.pins.input.itemId,
      createHash('sha256').update(bytes).digest('hex'),
      JSON.stringify(legacy),
    );
  const { mainHead: oldBase, ...intent } = legacy.pins.input;
  const b = backend(f);
  b.gh.state.merged = true;
  b.gh.state.parent = 'd'.repeat(40);
  expect((await b.owner.request(intent, requestSignal())).state).toBe('uncertain');
  b.gh.state.parent = oldBase;
  expect((await b.owner.request(intent, requestSignal())).state).toBe('accepted');
  const row = f.canonical.db
    .prepare('SELECT data FROM telos_work_main_publications WHERE request_id=?')
    .get(intent.requestId) as { data: string };
  expect(JSON.stringify(JSON.parse(row.data).pins)).toBe(bytes);
  expect(b.gh.state.mutations).toBe(0);
  expect(f.requests).toHaveLength(0);
  expect(() =>
    f.records().admit(legacy.pins, legacy.approvalReceiptId, () => {}, {
      inspectedMainHead: main,
      admittedMainHead: main,
    }),
  ).toThrow(/Historical exact-main/);
});

it('normal backend: inconsistent acknowledged and observed results remain visibly conflicted after restart', async () => {
  const f = fixture();
  const b = backend(f);
  const reported = 'd'.repeat(40);
  b.gh.state.acknowledgementSha = reported;
  expect(await b.owner.request(f.pins.input, requestSignal())).toMatchObject({
    state: 'conflicted',
    verification: 'conflicting_evidence',
    mergeCommit: merge,
    acknowledgedMergeCommits: [reported],
  });
  f.canonical.restartOwners();
  expect((await backend(f, b.gh).owner.request(f.pins.input, requestSignal())).state).toBe(
    'conflicted',
  );
  expect(b.gh.state.mutations).toBe(1);
  expect(f.records().hasUncertainForItems([f.pins.input.itemId])).toBe(true);
});
it('normal backend: admission and append-only acknowledgements retain conflicting replies without rewriting custody', async () => {
  const f = fixture();
  const b = backend(f);
  b.gh.state.afterRead = (path) => {
    if (b.gh.state.merged && path.endsWith('/pulls/9')) throw new Error('Read unavailable');
  };
  expect((await b.owner.request(f.pins.input, requestSignal())).state).toBe('uncertain');
  const before = (
    f.canonical.db.prepare('SELECT data FROM telos_work_main_publications').get() as {
      data: string;
    }
  ).data;
  f.records().recordRemoteAcknowledgement(f.pins, 'd'.repeat(40));
  const after = (
    f.canonical.db.prepare('SELECT data FROM telos_work_main_publications').get() as {
      data: string;
    }
  ).data;
  expect(after).toBe(before);
  for (const sql of [
    "UPDATE telos_work_main_publication_acknowledgements SET merge_commit='changed'",
    'DELETE FROM telos_work_main_publication_acknowledgements',
    "UPDATE telos_work_main_publication_acknowledgements SET approval_receipt_id='changed'",
    "UPDATE telos_work_main_publications SET data=json_set(data,'$.admittedMainHead','changed')",
  ])
    expect(() => f.canonical.db.exec(sql)).toThrow(/immutable|retained|cannot be reset/);
  expect(f.records().prepare(f.pins)).toMatchObject({
    state: 'conflicted',
    verification: 'conflicting_evidence',
    acknowledgedMergeCommits: [merge, 'd'.repeat(40)],
    admittedMainHead: main,
    inspectedMainHead: main,
  });
});

it.each(['matching', 'conflicting'])(
  'NR-PUB-2: a real second owner observation before the original %s ACK retains both facts without terminal reset',
  async (kind) => {
    const f = fixture();
    const b = backend(f);
    const observer = new TelosWorkStore(f.canonical.dbPath, {
      ordinaryConversation: (id) => id === 'planning',
    });
    cleanups.push(() => observer.close());
    if (kind === 'conflicting') b.gh.state.acknowledgementSha = 'd'.repeat(40);
    let originalObservedBytes = '';
    b.gh.state.afterMutation = async () => {
      const observation = await backend(f, b.gh, observer).owner.request(
        f.pins.input,
        requestSignal(),
      );
      expect(observation).toMatchObject({ state: 'accepted', verification: 'observed_merged' });
      originalObservedBytes = (
        f.canonical.db
          .prepare('SELECT data FROM telos_work_main_publications WHERE request_id=?')
          .get(f.pins.input.requestId) as { data: string }
      ).data;
    };
    const result = await b.owner.request(f.pins.input, requestSignal());
    const acknowledgements = f.canonical.db
      .prepare(
        'SELECT merge_commit,approval_receipt_id FROM telos_work_main_publication_acknowledgements',
      )
      .all() as { merge_commit: string; approval_receipt_id: string }[];
    expect(acknowledgements).toEqual([
      {
        merge_commit: kind === 'matching' ? merge : 'd'.repeat(40),
        approval_receipt_id: expect.any(String),
      },
    ]);
    f.records().recordRemoteAcknowledgement(f.pins, acknowledgements[0]!.merge_commit);
    expect(
      f.canonical.db.prepare('SELECT 1 FROM telos_work_main_publication_acknowledgements').all(),
    ).toHaveLength(1);
    expect(() =>
      f
        .records()
        .recordRemoteAcknowledgement(
          { ...f.pins, authority: { ...f.pins.authority, runtimeId: 'another-runtime' } },
          merge,
        ),
    ).toThrow(/Only this admitted/);
    expect(() =>
      f.canonical.db
        .prepare(
          'INSERT INTO telos_work_main_publication_acknowledgements(actor_id,request_id,merge_commit,approval_receipt_id) SELECT actor_id,request_id,?,? FROM telos_work_main_publications',
        )
        .run('e'.repeat(40), 'different-approval'),
    ).toThrow(/admitted approval/);
    expect(result).toMatchObject(
      kind === 'matching'
        ? { state: 'accepted', verification: 'acknowledged_squash' }
        : { state: 'conflicted', verification: 'conflicting_evidence' },
    );
    expect(
      (
        f.canonical.db
          .prepare('SELECT data FROM telos_work_main_publications WHERE request_id=?')
          .get(f.pins.input.requestId) as { data: string }
      ).data,
    ).toBe(originalObservedBytes);
    f.canonical.restartOwners();
    const recovered = await backend(f, b.gh).owner.request(f.pins.input, requestSignal());
    expect(recovered).toMatchObject(
      kind === 'matching'
        ? { state: 'accepted', verification: 'acknowledged_squash' }
        : { state: 'conflicted', verification: 'conflicting_evidence' },
    );
    expect(f.records().hasUncertainForItems([f.pins.input.itemId])).toBe(kind === 'conflicting');
    expect(b.gh.state.mutations).toBe(1);
    expect(f.requests).toHaveLength(1);
  },
);

it('DISPATCH: a real hold during async runner preparation is denied before admission and any remote effect', async () => {
  const f = fixture();
  const b = backend(f);
  b.gh.state.prepareDispatch = async () => {
    await Promise.resolve();
    f.hold();
  };
  const result = await b.owner.request(f.pins.input, requestSignal());
  expect(b.gh.state.mutations).toBe(0);
  expect(result.state).toBe('denied');
  expect(f.records().prepare(f.pins)).not.toHaveProperty('approvalReceiptId');
  expect(f.requests).toHaveLength(1);
});
