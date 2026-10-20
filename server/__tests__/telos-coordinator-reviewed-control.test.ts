import { afterEach, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { createJoiningFixture, cleanupJoiningFixtures } from './fixtures/collaboration-joining.js';
import { createTelosWorkRoleHost } from '../telos-work-role-host.js';
import { createTelosWorkRouter } from '../telos-work-routes.js';
import { executeTelosWorkControlTool } from '../telos-work-control-tools.js';
import { isAvailableTelosWorkConversation } from '../telos-work-conversation.js';
import { resolveTelosWorkRoleContext } from '../telos-work-role-context.js';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  await cleanupJoiningFixtures();
});

it('uses reviewed ordinary setup before scoped control, preserves additional/replaced lead history and denies their authority', async () => {
  const canonical = createTelosCanonicalData();
  cleanups.push(() => canonical.close());
  const ordinary = await createJoiningFixture();
  const available = (id: string) => isAvailableTelosWorkConversation(ordinary.store.getSession(id));
  const request = (raw: unknown) => ({
    actor: canonical.actor,
    raw,
    signal: ordinary.signal,
    assertAuthorized: () => {},
  });
  const host = () =>
    createTelosWorkRoleHost({
      dbPath: () => canonical.dbPath,
      events: ordinary.store,
      ordinaryConversation: available,
      workspaces: () => ordinary.workspaces,
      resolvePreparation: ordinary.resolvePreparation,
      authorizeSettings: async () => {},
    });
  const classify = (itemId: string, kind: 'coordinator' | 'outcome') =>
    canonical.work.execute(
      {
        operation: 'classify',
        itemId,
        kind,
        requestId: `kind-${itemId}`,
        expectedRevision: canonical.work.read(itemId, canonical.actor).revision,
      },
      canonical.actor,
    );
  classify('studio', 'coordinator');
  for (const itemId of ['priority', 'target', 'unrelated']) {
    canonical.db
      .prepare(
        `INSERT INTO items
      (id,summary,profile,parent_id,first_seen,last_seen,created_at,updated_at)
      VALUES(?,?,'manual',?,?,?,?,?)`,
      )
      .run(
        itemId,
        itemId,
        itemId === 'unrelated' ? null : 'studio',
        canonical.stamp,
        canonical.stamp,
        canonical.stamp,
        canonical.stamp,
      );
    classify(itemId, 'outcome');
  }
  async function setup(
    itemId: string,
    requestId: string,
    expectedAssignmentRevision: number | null,
  ) {
    const { binding } = await ordinary.resolvePreparation();
    const runtime = ordinary.input.settings.binding;
    const preview = await ordinary.workspaces.preview(
      binding,
      'connection',
      'example/repo',
      ordinary.signal,
      {
        runOn: 'local',
        runtime: { account: runtime.account, harness: 'codex', targetId: 'mac' },
      },
    );
    const workspace = await ordinary.workspaces.prepare(preview.id, binding, ordinary.signal);
    const review = await host().review(
      request({ itemId, role: 'lead', sourceSnapshotIds: [], artifactRefs: [] }),
    );
    const body = {
      version: 1,
      presentationRef: review.presentationRef,
      input: {
        itemId,
        requestId,
        role: 'lead',
        expectedRevision: review.selection.brief.revision,
        expectedAssignmentRevision,
        settings: { ...ordinary.input.settings, repositoryWorkspaceId: workspace.id },
        contextSelection: review.selection,
      },
    };
    const receipt = await host().setupReviewed(request(body));
    return { body, receipt };
  }
  const first = await setup('studio', 'coordinator-first', 0);
  const firstId = first.receipt.work.assignments[0].conversation.conversationId;
  const firstSession = ordinary.store.getSession(firstId)!;
  expect(
    resolveTelosWorkRoleContext(ordinary.store, firstId, firstSession.accountBinding!),
  ).toMatchObject({
    itemId: 'studio',
    itemKind: 'coordinator',
    role: 'lead',
  });
  await setup('target', 'target-lead', 0);
  await setup('priority', 'priority-lead', 0);
  const additional = await setup('studio', 'coordinator-additional', null);
  const additionalId = additional.receipt.work.links.find(
    (link) => link.conversation.conversationId !== firstId,
  )!.conversation.conversationId;
  expect(additional.receipt.work.assignments).toEqual(first.receipt.work.assignments);
  expect(additionalId).not.toBe(firstId);

  const app = express();
  app.use(express.json());
  app.use(
    createTelosWorkRouter({
      dbPath: () => canonical.dbPath,
      operatorAuth: (_req, _res, next) => next(),
      verifyInternal: (req) => req.headers['x-internal-token'] === 'offline-internal-token',
      sessionId: (clientId) => ordinary.store.getSession(clientId)?.sessionId,
      ordinaryConversation: available,
    }),
  );
  const server = await listenOnLoopback(app);
  cleanups.push(() => closeTestServer(server));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (id: string, command: unknown) =>
    executeTelosWorkControlTool(
      base,
      id,
      id,
      'offline-internal-token',
      { command },
      ordinary.signal,
    );
  const hold = {
    operation: 'request',
    requestId: 'coordinator-hold',
    coordinatorItemId: 'studio',
    priorityItemId: 'priority',
    targetItemIds: ['target'],
    scope: 'new_worker_dispatch',
  };
  expect((await call(additionalId, hold)).isError).toBe(true);
  const created = await call(firstId, hold);
  expect(created.isError, created.content).toBe(false);
  const control = JSON.parse(created.content);
  expect(control.coordinatorConversationId).toBe(firstId);
  expect(control.targets).toHaveLength(1);
  expect(control.targets[0].stage).toBe('requested');
  expect(() => canonical.work.assertControlAction('target', 'new_worker_dispatch')).toThrow(
    /hold/i,
  );
  expect(() =>
    canonical.work.assertControlAction('unrelated', 'new_worker_dispatch'),
  ).not.toThrow();

  const replacement = await setup('studio', 'coordinator-replacement', 1);
  const replacementId = replacement.receipt.work.assignments[0].conversation.conversationId;
  expect(replacementId).not.toBe(firstId);
  expect(replacement.receipt.work.assignments[0].revision).toBe(2);
  ordinary.reopen();
  expect(await host().setupReviewed(request(first.body))).toEqual(first.receipt);
  expect(canonical.work.read('studio', canonical.actor).assignments).toEqual(
    replacement.receipt.work.assignments,
  );
  expect((await call(firstId, { ...hold, requestId: 'retired-hold' })).isError).toBe(true);
  expect(
    (
      await call(firstId, {
        operation: 'release',
        requestId: 'retired-release',
        controlId: control.controlId,
      })
    ).isError,
  ).toBe(true);
  expect(
    (
      await call(additionalId, {
        operation: 'release',
        requestId: 'additional-release',
        controlId: control.controlId,
      })
    ).isError,
  ).toBe(true);
  const released = await call(replacementId, {
    operation: 'release',
    requestId: 'current-release',
    controlId: control.controlId,
  });
  expect(released.isError, released.content).toBe(false);
  expect(JSON.parse(released.content).stage).toBe('released');
  expect(() => canonical.work.assertControlAction('target', 'new_worker_dispatch')).not.toThrow();
  expect(ordinary.store.getSession(firstId)).toEqual(firstSession);
  for (const id of [firstId, additionalId, replacementId])
    expect(ordinary.store.getOrdinaryInitialCommandId(id)).toBeUndefined();
});
