import { afterEach, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { TelosWorkApiClient } from '@mitzo/client';
import { TelosWorkRoleSetupInputSchema } from '@mitzo/protocol';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { createJoiningFixture, cleanupJoiningFixtures } from './fixtures/collaboration-joining.js';
import { createTelosWorkRoleHost } from '../telos-work-role-host.js';
import { createTelosWorkRouter } from '../telos-work-routes.js';
import { isAvailableTelosWorkConversation } from '../telos-work-conversation.js';
import { resolveTelosWorkRoleContext } from '../telos-work-role-context.js';
import { resolveTelosWorkRolePresentation } from '../telos-work-role-presentation.js';
import { resolveOrdinaryContributorGuidance } from '../ordinary-contributor-guidance.js';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
  await cleanupJoiningFixtures();
});
it('CT04/05: lost actual HTTP commit recovers the same ordinary session and exact display projection after every owner reopens', async () => {
  const f = createTelosCanonicalData();
  cleanups.push(() => f.close());
  const ordinary = await createJoiningFixture();
  const available = (id: string) => isAvailableTelosWorkConversation(ordinary.store.getSession(id));
  const host = () =>
    createTelosWorkRoleHost({
      dbPath: () => f.dbPath,
      events: ordinary.store,
      ordinaryConversation: available,
      workspaces: () => ordinary.workspaces,
      resolvePreparation: ordinary.resolvePreparation,
      authorizeSettings: async () => {},
    });
  const app = express();
  app.use(express.json());
  const expiresAt = Date.now() + 120_000;
  app.use(
    createTelosWorkRouter({
      dbPath: () => f.dbPath,
      operatorAuth: (_req, res, next) => {
        res.locals.authSession = { id: f.actor.id, expiresAt };
        next();
      },
      verifyInternal: () => false,
      sessionId: () => undefined,
      ordinaryConversation: available,
      roleReview: (req) => host().review(req),
      roleSetupReviewed: (req) => host().setupReviewed(req),
      roleContext: (req) => host().context(req),
      roleSetup: (req) => host().setup(req),
    }),
  );
  let dropCommittedResponse = true;
  const api = new TelosWorkApiClient(async (url, init) => {
    const call = init?.method === 'POST' ? request(app).post(url) : request(app).get(url);
    for (const [key, value] of new Headers(init?.headers)) call.set(key, value);
    if (init?.body) call.send(JSON.parse(String(init.body)));
    const response = await call;
    if (url.endsWith('/roles/setup-reviewed') && response.status === 200 && dropCommittedResponse) {
      dropCommittedResponse = false;
      throw Error('Offline response lost after actual durable commit');
    }
    return new Response(JSON.stringify(response.body), { status: response.status });
  });
  const review = await api.reviewRoleContext({
    itemId: 'studio',
    role: 'lead',
    sourceSnapshotIds: [],
    artifactRefs: [
      { artifactId: f.material.id, revision: f.material.revision, sha256: f.material.sha256 },
    ],
  });
  const input = TelosWorkRoleSetupInputSchema.parse({
    itemId: 'studio',
    role: 'lead',
    requestId: randomUUID(),
    expectedRevision: review.selection.brief.revision,
    expectedAssignmentRevision: 0,
    settings: ordinary.input.settings,
    contextSelection: review.selection,
  });
  const body = { version: 1 as const, input, presentationRef: review.presentationRef };
  await expect(api.setupReviewedRole(body)).rejects.toThrow(
    'Offline response lost after actual durable commit',
  );
  const retained = f.work.prepareRoleSetup(input, f.actor);
  expect(retained.receipt).not.toBeNull();
  const id = retained.receipt!.work.assignments[0].conversation.conversationId;
  const binding = ordinary.store.getSession(id)!.accountBinding!;
  const firstProjection = resolveTelosWorkRolePresentation(ordinary.store, id, binding);
  const firstGuidance = resolveOrdinaryContributorGuidance(ordinary.store, id, binding);
  expect(firstProjection).toEqual({
    presentation: review.presentation,
    presentationRef: review.presentationRef,
  });
  expect(ordinary.store.getOrdinaryInitialCommandId(id)).toBeUndefined();
  expect(ordinary.store.listSessions()).toHaveLength(2);
  expect(ordinary.resolvePreparation).toHaveBeenCalledOnce();
  const originalPreparation = ordinary.store.getOrdinarySessionPreparation(
    retained.setup.allocationOperationId,
  );
  expect(originalPreparation?.firstCommandId).toBeNull();
  f.db
    .prepare(
      "UPDATE items SET summary='New current title',intent='New current goal',updated_at='2026-10-18T12:00:00' WHERE id='studio'",
    )
    .run();
  f.artifacts.save({
    itemId: 'studio',
    filename: f.material.filename,
    title: 'New current material',
    bytes: Buffer.from('A later version.'),
    sessionId: 'planning',
  });
  f.restartOwners();
  ordinary.reopen();
  expect(await api.setupReviewedRole(body)).toEqual(retained.receipt);
  expect(f.work.prepareRoleSetup(input, f.actor).setup).toEqual(retained.setup);
  expect(
    ordinary.store.getOrdinarySessionPreparation(retained.setup.allocationOperationId),
  ).toEqual(originalPreparation);
  expect(ordinary.store.listSessions()).toHaveLength(2);
  expect(ordinary.resolvePreparation).toHaveBeenCalledOnce();
  expect(resolveTelosWorkRoleContext(ordinary.store, id, binding)).toEqual(review.selection);
  expect(resolveTelosWorkRolePresentation(ordinary.store, id, binding)).toEqual(firstProjection);
  expect(resolveOrdinaryContributorGuidance(ordinary.store, id, binding)).toBe(firstGuidance);
  expect(ordinary.store.getOrdinaryInitialCommandId(id)).toBeUndefined();
  expect(
    ordinary.store
      .getSessionEvents(id)
      .filter((event) => event.type === 'telos_work_role_presentation'),
  ).toHaveLength(1);
  expect(f.work.read('studio', f.actor).assignments).toHaveLength(1);
}, 15_000);
