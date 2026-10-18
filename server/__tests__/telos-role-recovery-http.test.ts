import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { TelosWorkRoleSetupInputSchema } from '@mitzo/protocol';
import { createTelosWorkRoleHost } from '../telos-work-role-host.js';
import { createTelosWorkRouter } from '../telos-work-routes.js';
import { createCanonicalAdvisorFixture } from './fixtures/telos-canonical-advisor.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
async function fixture(parent = false) {
  const f = createCanonicalAdvisorFixture('fresh', 'refine');
  cleanups.push(() => f.close());
  if (parent) {
    f.db
      .prepare(
        `INSERT INTO items(id,summary,intent,profile,first_seen,last_seen,created_at,updated_at)
      VALUES('goal','Overall goal','Keep the original goal','manual',?,?,?,?)`,
      )
      .run(f.stamp, f.stamp, f.stamp, f.stamp);
    f.db.prepare("UPDATE items SET parent_id='goal' WHERE id='studio'").run();
  }
  const workspaces = vi.fn(() => {
    throw Error('Allocator must not be touched');
  });
  const resolvePreparation = vi.fn(async () => {
    throw Error('Preparation must not be resolved');
  });
  const authorizeSettings = vi.fn(async () => {});
  const host = () =>
    createTelosWorkRoleHost({
      dbPath: () => f.dbPath,
      events: f.events,
      ordinaryConversation: (id) => id === 'planning',
      workspaces,
      resolvePreparation,
      authorizeSettings,
    });
  const contextSelection = await host().context({
    actor: f.actor,
    raw: { itemId: 'studio', role: 'lead', sourceSnapshotIds: [], artifactRefs: [] },
    signal: new AbortController().signal,
    assertAuthorized: () => {},
  });
  const input = TelosWorkRoleSetupInputSchema.parse({
    itemId: 'studio',
    role: 'lead',
    requestId: randomUUID(),
    expectedRevision: contextSelection.brief.revision,
    expectedAssignmentRevision: 0,
    contextSelection,
    settings: {
      binding: {
        version: 2,
        account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
        harness: { implementation: 'codex' },
        execution: { location: 'local', targetId: 'offline-target', targetRevision: 'r1' },
      },
      repositoryWorkspaceId: randomUUID(),
      selection: {
        version: 1,
        agent: { profileId: 'offline-agent', revision: 1 },
        context: { source: 'none', revision: null },
        permission: { mode: 'agent', revision: 0 },
        model: 'offline-fixture',
        thinking: null,
      },
    },
  });
  const original = f.db.prepare("SELECT summary,updated_at FROM items WHERE id='studio'").get() as {
    summary: string;
    updated_at: string;
  };
  const stale = () =>
    f.db
      .prepare(
        "UPDATE items SET summary='Changed after review',updated_at='2026-10-17T11:00:00' WHERE id='studio'",
      )
      .run();
  const restore = () =>
    f.db
      .prepare("UPDATE items SET summary=?,updated_at=? WHERE id='studio'")
      .run(original.summary, original.updated_at);
  const app = express();
  app.use(express.json());
  const expiresAt = Date.now() + 60_000;
  app.use(
    createTelosWorkRouter({
      dbPath: () => f.dbPath,
      operatorAuth: (req, res, next) => {
        res.locals.authSession = { id: req.get('x-fixture-operator') ?? f.actor.id, expiresAt };
        next();
      },
      verifyInternal: () => false,
      sessionId: () => undefined,
      ordinaryConversation: (id) => id === 'planning',
      roleSetup: (req) => host().setup(req),
    }),
  );
  const post = (body = input, operator = f.actor.id) =>
    request(app).post('/api/telos/work/roles/setup').set('x-fixture-operator', operator).send(body);
  const noAllocation = () => {
    expect(workspaces).not.toHaveBeenCalled();
    expect(resolvePreparation).not.toHaveBeenCalled();
  };
  const proof = { version: 1, requestId: input.requestId, outcome: 'rejected_before_allocation' };
  return {
    f,
    input,
    post,
    stale,
    restore,
    noAllocation,
    proof,
    workspaces,
    resolvePreparation,
    authorizeSettings,
  };
}

it('CT03: actual stale HTTP rejection proves the same request was durably rejected before allocation', async () => {
  const r = await fixture();
  r.stale();
  const response = await r.post();
  expect(response.status).toBe(409);
  r.noAllocation();
  expect(r.authorizeSettings).not.toHaveBeenCalled();
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toEqual([]);
  expect(response.body.recovery).toEqual(r.proof);
});
it('CT03: rejected UUID stays rejected after reopen even when its original reviewed state is restored', async () => {
  const r = await fixture();
  r.stale();
  const first = await r.post();
  expect(first.status).toBe(409);
  r.restore();
  r.f.restartOwners();
  expect(r.f.work.read('studio', r.f.actor).revision).toBe(r.input.expectedRevision);
  const replay = await r.post();
  expect(replay.status).toBe(409);
  expect(first.body.recovery).toEqual(r.proof);
  expect(replay.body.recovery).toEqual(r.proof);
  r.noAllocation();
  expect(r.authorizeSettings).not.toHaveBeenCalled();
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toEqual([]);
});
it.each(['changed-input', 'other-operator'] as const)(
  'CT04: %s cannot borrow a rejected request proof',
  async (kind) => {
    const r = await fixture();
    r.stale();
    await r.post();
    const body = structuredClone(r.input);
    if (kind === 'changed-input') body.settings.selection.model = 'changed-fixture';
    const response = await r.post(
      body,
      kind === 'other-operator' ? 'different-offline-operator' : r.f.actor.id,
    );
    expect(response.status).toBe(409);
    expect(response.body).not.toMatchObject({
      recovery: expect.objectContaining({ outcome: 'rejected_before_allocation' }),
    });
    r.noAllocation();
    expect(r.authorizeSettings).not.toHaveBeenCalled();
  },
);
it('CT04: an already retained allocation-capable intent cannot emit a positive rejection proof', async () => {
  const r = await fixture();
  r.f.work.prepareRoleSetup(r.input, r.f.actor);
  r.stale();
  const response = await r.post();
  expect(response.status).toBe(409);
  expect(response.body).not.toMatchObject({
    recovery: expect.objectContaining({ outcome: 'rejected_before_allocation' }),
  });
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toHaveLength(1);
  r.noAllocation();
});
it('CT04: concurrent late conflict while original admission awaits settings never unlocks its UUID', async () => {
  const r = await fixture();
  let release!: () => void;
  let arrived!: () => void;
  const entered = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  r.authorizeSettings.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        arrived();
      }),
  );
  const pending = r.post().then((response) => response);
  await entered;
  let second;
  try {
    r.stale();
    second = await r.post();
  } finally {
    release();
  }
  const first = await pending;
  for (const response of [first, second!]) {
    expect(response.status).toBe(409);
    expect(response.body).not.toMatchObject({
      recovery: expect.objectContaining({ outcome: 'rejected_before_allocation' }),
    });
  }
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toHaveLength(1);
  r.noAllocation();
});
it('CT03: concurrent identical stale requests share a terminal rejection without an allocation intent', async () => {
  const r = await fixture();
  r.stale();
  const responses = await Promise.all([r.post(), r.post()]);
  for (const response of responses) {
    expect(response.status).toBe(409);
    expect(response.body.recovery).toEqual(r.proof);
  }
  r.noAllocation();
  expect(r.authorizeSettings).not.toHaveBeenCalled();
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toEqual([]);
});
it('CT03: stale ancestor context is rejected before an intent even when the item revision is unchanged', async () => {
  const r = await fixture(true);
  r.f.db
    .prepare(
      "UPDATE items SET intent='Changed overall goal',updated_at='2026-10-17T11:00:00' WHERE id='goal'",
    )
    .run();
  expect(r.f.work.read('studio', r.f.actor).revision).toBe(r.input.expectedRevision);
  const response = await r.post();
  expect(response.status).toBe(409);
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toEqual([]);
  expect(response.body.recovery).toEqual(r.proof);
  r.noAllocation();
  expect(r.authorizeSettings).not.toHaveBeenCalled();
});
it('CT04: failure to commit terminal evidence cannot emit a positive proof or silently replace admission', async () => {
  const r = await fixture();
  r.stale();
  r.f.db
    .exec(`CREATE TRIGGER fixture_rejection_write_failure BEFORE INSERT ON telos_work_role_setup_rejections
    BEGIN SELECT RAISE(ABORT,'offline disk-write failure'); END;`);
  const failed = await r.post();
  expect(failed.status).toBe(503);
  expect(failed.body.recovery).toBeUndefined();
  r.noAllocation();
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toEqual([]);
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setup_rejections').all()).toEqual([]);
  r.f.db.exec('DROP TRIGGER fixture_rejection_write_failure');
  r.restore();
  // The failed write never claimed terminality. Exact retry reaches the existing
  // fake allocator, whose intentional failure keeps this entirely offline.
  const replay = await r.post();
  expect(replay.status).toBe(503);
  expect(replay.body.recovery).toBeUndefined();
  expect(r.workspaces).toHaveBeenCalledOnce();
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toHaveLength(1);
});
it('CT04: unavailable private reviewed ancestor cannot prove a terminal rejection', async () => {
  const r = await fixture(true);
  r.f.db.prepare("UPDATE items SET profile='life-ops' WHERE id='goal'").run();
  const response = await r.post();
  // The accepted review reader reports unavailable material as 503. Its status
  // alone grants no terminality or replacement authority.
  expect(response.status).toBe(503);
  expect(response.body.recovery).toBeUndefined();
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toEqual([]);
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setup_rejections').all()).toEqual([]);
  r.noAllocation();
});
it('CT04: an outer rolled-back completion cannot expose proof from an uncommitted nested admission', async () => {
  const r = await fixture();
  r.stale();
  let cause: unknown;
  try {
    r.f.work.completeRoleSetup(
      { actorId: `operator:${r.f.actor.id}`, input: r.input, allocationOperationId: randomUUID() },
      'unallocated-fixture-chat',
      r.f.actor,
      () => {},
    );
  } catch (error) {
    cause = error;
  }
  expect(cause).toMatchObject({ code: 'conflict' });
  expect(cause).not.toMatchObject({
    recovery: expect.objectContaining({ outcome: 'rejected_before_allocation' }),
  });
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toEqual([]);
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setup_rejections').all()).toEqual([]);
  r.noAllocation();
});
