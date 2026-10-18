import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TelosWorkRoleSetupInputSchema } from '@mitzo/protocol';
import express from 'express';
import request from 'supertest';
import { createTelosWorkRoleHost } from '../telos-work-role-host.js';
import { createTelosWorkRouter, type TelosWorkRoleRequest } from '../telos-work-routes.js';
import { createCanonicalAdvisorFixture } from './fixtures/telos-canonical-advisor.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
async function fixture() {
  const f = createCanonicalAdvisorFixture('fresh', 'refine');
  cleanups.push(() => f.close());
  const preview = await f.owner().preview(f.input, f.actor);
  const saved = await f.owner().save({ ...f.input, previewSha256: preview.sha256 }, f.actor);
  for (const [id, parentId, title, intent] of [
    ['goal', null, 'Home recording album', 'Retain the reviewed album'],
    ['parent', 'goal', 'First recording session', 'Keep the agreed recording plan'],
  ])
    f.db
      .prepare(
        `INSERT INTO items(id,parent_id,summary,intent,profile,first_seen,last_seen,created_at,updated_at)
    VALUES(?,?,?,?,'manual',?,?,?,?)`,
      )
      .run(id, parentId, title, intent, f.stamp, f.stamp, f.stamp, f.stamp);
  f.db.prepare("UPDATE items SET parent_id='parent' WHERE id='studio'").run();
  const workspaces = vi.fn(() => {
    throw Error('Review must never allocate');
  });
  const resolvePreparation = vi.fn(async () => {
    throw Error('Review must never prepare');
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
  const app = express();
  app.use(express.json());
  const expiresAt = Date.now() + 120_000;
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
      roleContext: (req) => host().context(req),
      roleSetup: (req) => host().setup(req),
      ...{
        roleReview: (req: TelosWorkRoleRequest) => host().review(req),
        roleSetupReviewed: (req: TelosWorkRoleRequest) => host().setupReviewed(req),
      },
    }),
  );
  const reviewInput = {
    itemId: 'studio',
    role: 'lead',
    sourceSnapshotIds: saved.work.sources.map((source) => source.snapshotId),
    artifactRefs: [
      { artifactId: f.material.id, revision: f.material.revision, sha256: f.material.sha256 },
    ],
  };
  const post = (path: string, body: object, operator = f.actor.id) =>
    request(app)
      .post('/api/telos/work/' + path)
      .set('x-fixture-operator', operator)
      .send(body);
  return { f, post, reviewInput, saved, workspaces, resolvePreparation, authorizeSettings };
}
it('CT05: actual canonical review returns pinned names, retained source date/title and exact material revision metadata without allocation', async () => {
  const r = await fixture();
  const response = await r.post('roles/review', r.reviewInput);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    version: 1,
    selection: {
      itemId: 'studio',
      role: 'lead',
      parentCriteria: [{ itemId: 'parent' }, { itemId: 'goal' }],
    },
    presentationRef: { id: expect.any(String), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    presentation: {
      version: 1,
      contextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      reviewedAt: expect.any(String),
      item: { itemId: 'studio', title: 'Reviewed plan' },
      overallGoal: { itemId: 'goal', title: 'Home recording album' },
      parents: [
        { itemId: 'parent', title: 'First recording session' },
        { itemId: 'goal', title: 'Home recording album' },
      ],
      sources: [
        {
          snapshotId: r.saved.work.sources[0].snapshotId,
          title: 'Studio planning',
          createdAt: r.saved.work.sources[0].sourceCreatedAt,
        },
      ],
      artifacts: expect.arrayContaining([
        {
          artifactId: r.f.material.id,
          revision: 1,
          sha256: r.f.material.sha256,
          filename: 'acoustic-plan.md',
          title: 'Acoustic plan',
          createdAt: r.f.material.createdAt,
          sourceKind: 'session_artifact',
        },
      ]),
    },
  });
  expect(r.saved.work.sources[0].sourceCreatedAt).not.toBeNull();
  r.f.events.upsertSession({ sessionId: 'planning', summary: 'Renamed current chat' });
  const newer = r.f.artifacts.save({
    itemId: 'studio',
    filename: 'acoustic-plan.md',
    title: 'Newer material title',
    bytes: Buffer.from('A newer unrelated revision.'),
    sessionId: 'planning',
  });
  expect(newer.revision).toBe(2);
  r.f.restartOwners();
  const again = await r.post('roles/review', r.reviewInput);
  expect(again.status).toBe(200);
  expect(again.body.presentation.sources).toEqual(response.body.presentation.sources);
  expect(again.body.presentation.artifacts).toEqual(response.body.presentation.artifacts);
  expect(r.workspaces).not.toHaveBeenCalled();
  expect(r.resolvePreparation).not.toHaveBeenCalled();
  expect(r.authorizeSettings).not.toHaveBeenCalled();
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toEqual([]);
});

async function reviewedInput(r: Awaited<ReturnType<typeof fixture>>) {
  const response = await r.post('roles/review', r.reviewInput);
  expect(response.status).toBe(200);
  const review = response.body;
  const input = TelosWorkRoleSetupInputSchema.parse({
    itemId: 'studio',
    role: 'lead',
    requestId: randomUUID(),
    expectedRevision: review.selection.brief.revision,
    expectedAssignmentRevision: 0,
    contextSelection: review.selection,
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
  return { version: 1, input, presentationRef: review.presentationRef };
}
it('CT03/05: reviewed wrapper preserves terminal rejection and cannot borrow another presentation reference', async () => {
  const r = await fixture();
  const body = await reviewedInput(r);
  const original = r.f.db.prepare("SELECT intent,updated_at FROM items WHERE id='goal'").get() as {
    intent: string;
    updated_at: string;
  };
  r.f.db
    .prepare(
      "UPDATE items SET intent='Changed goal',updated_at='2026-10-18T11:00:00' WHERE id='goal'",
    )
    .run();
  expect(r.f.work.read('studio', r.f.actor).revision).toBe(body.input.expectedRevision);
  const first = await r.post('roles/setup-reviewed', body);
  expect(first.status).toBe(409);
  const proof = {
    version: 1,
    requestId: body.input.requestId,
    outcome: 'rejected_before_allocation',
  };
  expect(first.body.recovery).toEqual(proof);
  r.f.db
    .prepare("UPDATE items SET intent=?,updated_at=? WHERE id='goal'")
    .run(original.intent, original.updated_at);
  r.f.restartOwners();
  const replay = await r.post('roles/setup-reviewed', body);
  expect(replay.status).toBe(409);
  expect(replay.body.recovery).toEqual(proof);
  const newer = await r.post('roles/review', r.reviewInput);
  expect(newer.status).toBe(200);
  expect(newer.body.presentationRef.id).not.toBe(body.presentationRef.id);
  const changed = await r.post('roles/setup-reviewed', {
    ...body,
    presentationRef: newer.body.presentationRef,
  });
  expect(changed.status).toBe(409);
  expect(changed.body.recovery).toBeUndefined();
  const omitted = await r.post('roles/setup', body.input);
  expect(omitted.status).toBe(409);
  expect(omitted.body.recovery).toBeUndefined();
  expect(r.workspaces).not.toHaveBeenCalled();
  expect(r.resolvePreparation).not.toHaveBeenCalled();
  expect(r.authorizeSettings).not.toHaveBeenCalled();
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toEqual([]);
}, 15_000);
it.each(['parent', 'goal', 'material', 'hash'] as const)(
  'CT05: %s mismatch cannot bind labels under the same reviewed brief hash',
  async (kind) => {
    const r = await fixture();
    const body = await reviewedInput(r);
    const brief = structuredClone(body.input.contextSelection.brief);
    if (kind === 'parent') body.input.contextSelection.parentCriteria[0].revision = 'later-parent';
    if (kind === 'goal') body.input.contextSelection.overallGoal.text = 'Different goal';
    if (kind === 'material') body.input.contextSelection.artifacts[0].revision++;
    if (kind === 'hash') body.presentationRef.sha256 = 'f'.repeat(64);
    expect(body.input.contextSelection.brief).toEqual(brief);
    const response = await r.post('roles/setup-reviewed', body);
    expect(response.status).toBe(409);
    expect(response.body.recovery).toBeUndefined();
    expect(r.workspaces).not.toHaveBeenCalled();
    expect(r.resolvePreparation).not.toHaveBeenCalled();
    expect(r.authorizeSettings).not.toHaveBeenCalled();
    expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toEqual([]);
  },
);
it('CT05: another operator cannot borrow an otherwise exact reviewed projection', async () => {
  const r = await fixture();
  const body = await reviewedInput(r);
  const response = await r.post('roles/setup-reviewed', body, 'other-fixture-operator');
  expect(response.status).toBe(403);
  expect(response.body.recovery).toBeUndefined();
  expect(r.workspaces).not.toHaveBeenCalled();
  expect(r.resolvePreparation).not.toHaveBeenCalled();
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toEqual([]);
});
it('CT05: a reviewed projection cannot attach retroactively to an allocation-capable legacy intent', async () => {
  const r = await fixture();
  const body = await reviewedInput(r);
  const first = await r.post('roles/setup', body.input);
  expect(first.status).toBe(503);
  expect(first.body.recovery).toBeUndefined();
  const original = r.f.db.prepare('SELECT * FROM telos_work_role_setups').all();
  expect(original).toHaveLength(1);
  expect(r.workspaces).toHaveBeenCalledOnce();
  const attaching = await r.post('roles/setup-reviewed', body);
  expect(attaching.status).toBe(409);
  expect(attaching.body.recovery).toBeUndefined();
  expect(r.f.db.prepare('SELECT * FROM telos_work_role_setups').all()).toEqual(original);
  expect(r.workspaces).toHaveBeenCalledOnce();
});
