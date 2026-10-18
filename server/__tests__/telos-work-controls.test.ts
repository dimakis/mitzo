import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TelosWorkStore } from '../telos-work-store.js';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';

const closes: Array<() => void> = [];
afterEach(() =>
  closes
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const canonical = createTelosCanonicalData();
  closes.push(() => canonical.close());
  let work = new TelosWorkStore(canonical.dbPath, { ordinaryConversation: () => true });
  closes.push(() => work.close());
  const actor = canonical.actor;
  const command = (itemId: string, input: object) =>
    work.execute(
      {
        itemId,
        requestId: randomUUID(),
        expectedRevision: work.read(itemId, actor).revision,
        ...input,
      },
      actor,
    );
  const add = (id: string, parent: string | null, kind: string) => {
    canonical.db
      .prepare(
        "INSERT INTO items(id,parent_id,summary,profile,first_seen,last_seen,created_at,updated_at) VALUES(?,?,?,'manual',?,?,?,?)",
      )
      .run(id, parent, id, canonical.stamp, canonical.stamp, canonical.stamp, canonical.stamp);
    command(id, { operation: 'classify', kind });
  };
  const assign = (itemId: string, role: 'lead' | 'worker', id: string) => {
    command(itemId, {
      operation: 'link',
      role,
      conversation: { namespace: 'mitzo', conversationId: id },
    });
    command(itemId, {
      operation: 'assign',
      role,
      conversationId: id,
      expectedAssignmentRevision:
        work.read(itemId, actor).assignments.find((a) => a.role === role)?.revision ?? 0,
    });
  };
  add('coordinator', null, 'coordinator');
  assign('coordinator', 'lead', 'coordinator-chat');
  for (let i = 0; i < 6; i++) {
    add(`feature-${i}`, 'coordinator', 'outcome');
    assign(`feature-${i}`, 'lead', `lead-${i}`);
    add(`slice-${i}`, `feature-${i}`, 'work_item');
    assign(`slice-${i}`, 'worker', `worker-${i}`);
  }
  add('job', null, 'outcome');
  assign('job', 'lead', 'job-lead');
  add('job-slice', 'job', 'work_item');
  assign('job-slice', 'worker', 'job-worker');
  const request = (scope = 'publication') =>
    work.requestControl(
      {
        requestId: 'hold',
        coordinatorItemId: 'coordinator',
        targetItemIds: ['feature-1', 'feature-2', 'feature-3', 'feature-4', 'feature-5'],
        priorityItemId: 'feature-0',
        scope,
      },
      actor,
    );
  return {
    canonical,
    get work() {
      return work;
    },
    actor,
    add,
    assign,
    command,
    request,
    restart() {
      work.close();
      work = new TelosWorkStore(canonical.dbPath, { ordinaryConversation: () => true });
    },
  };
}
it('CT12: holds only five selected attached outcomes, keeps requested distinct from applied, and retains release across restart', () => {
  const f = fixture();
  const control = f.request();
  expect(control.targets).toHaveLength(5);
  expect(control.targets.every((t) => t.stage === 'requested')).toBe(true);
  expect(f.request()).toEqual(control);
  expect(() => f.work.assertControlAction('slice-0', 'publication')).not.toThrow();
  expect(() => f.work.assertControlAction('job-slice', 'publication')).not.toThrow();
  expect(() => f.work.assertControlAction('slice-1', 'safe_point')).not.toThrow();
  expect(() => f.work.assertControlAction('slice-1', 'publication')).toThrow(/hold/i);
  const ack = {
    requestId: 'ack',
    controlId: control.controlId,
    itemId: 'feature-1',
    assignmentRevision: 1,
  };
  f.work.acknowledgeControl(ack, { kind: 'conversation', id: 'lead-1' });
  expect(f.work.readControl(control.controlId, f.actor).targets[0].stage).toBe('acknowledged');
  expect(f.work.readControl(control.controlId, f.actor).targets[0].workers[0].stage).toBe(
    'requested',
  );
  f.restart();
  expect(
    f.work.acknowledgeControl(ack, { kind: 'conversation', id: 'lead-1' }).targets[0].stage,
  ).toBe('acknowledged');
  f.work.releaseControl({ requestId: 'release', controlId: control.controlId }, f.actor);
  f.restart();
  expect(f.work.readControl(control.controlId, f.actor).stage).toBe('released');
  expect(() => f.work.assertControlAction('slice-1', 'publication')).toThrow(/revalidat/i);
  expect(() =>
    f.work.acknowledgeControl(
      { ...ack, requestId: 'late' },
      { kind: 'conversation', id: 'lead-1' },
    ),
  ).toThrow(/released/i);
});
it('CT11/CT12: lead replacement reroutes pending evidence, rejects retired holders and preserves historical acknowledgements', () => {
  const f = fixture();
  const control = f.request('new_worker_dispatch');
  const ack = {
    requestId: 'ack',
    controlId: control.controlId,
    itemId: 'feature-1',
    assignmentRevision: 1,
  };
  f.work.acknowledgeControl(ack, { kind: 'conversation', id: 'lead-1' });
  f.assign('feature-1', 'lead', 'replacement-lead');
  f.restart();
  const target = f.work.readControl(control.controlId, f.actor).targets[0];
  expect(target.leadConversationId).toBe('replacement-lead');
  expect(target.stage).toBe('requested');
  expect(() =>
    f.work.acknowledgeControl(
      { ...ack, requestId: 'stale' },
      { kind: 'conversation', id: 'lead-1' },
    ),
  ).toThrow(/current/i);
  expect(() =>
    f.work.acknowledgeControl(
      { ...ack, requestId: 'wrong-revision' },
      { kind: 'conversation', id: 'replacement-lead' },
    ),
  ).toThrow(/revision/i);
  f.work.acknowledgeControl(
    { ...ack, requestId: 'current', assignmentRevision: 2 },
    { kind: 'conversation', id: 'replacement-lead' },
  );
  expect(f.work.readControl(control.controlId, f.actor).history).toHaveLength(2);
  f.work.releaseControl({ requestId: 'release', controlId: control.controlId }, f.actor);
  expect(() => f.work.assertControlAction('feature-1', 'new_worker_dispatch')).not.toThrow();
});
it('CT12: nested coordinators cannot select siblings, unrelated work or broaden/reuse a control identity', () => {
  const f = fixture();
  f.add('nested', 'coordinator', 'coordinator');
  f.assign('nested', 'lead', 'nested-chat');
  f.add('nested-outcome', 'nested', 'outcome');
  f.assign('nested-outcome', 'lead', 'nested-lead');
  const request = {
    requestId: 'scoped',
    coordinatorItemId: 'nested',
    priorityItemId: 'nested-outcome',
    targetItemIds: ['feature-1'],
    scope: 'safe_point',
  };
  expect(() => f.work.requestControl(request, { kind: 'conversation', id: 'nested-chat' })).toThrow(
    /attached/i,
  );
  expect(() => f.work.requestControl({ ...request, targetItemIds: ['job'] }, f.actor)).toThrow(
    /attached/i,
  );
  expect(() =>
    f.work.requestControl(
      { ...request, coordinatorItemId: 'coordinator', priorityItemId: 'feature-0' },
      { kind: 'conversation', id: 'lead-0' },
    ),
  ).toThrow(/coordinator/i);
  const control = f.request('safe_point');
  expect(() =>
    f.work.requestControl(
      {
        requestId: 'hold',
        coordinatorItemId: 'coordinator',
        priorityItemId: 'feature-0',
        targetItemIds: ['feature-1'],
        scope: 'publication',
      },
      f.actor,
    ),
  ).toThrow(/identity/i);
  expect(() =>
    f.work.readControl(control.controlId, { kind: 'conversation', id: 'job-lead' }),
  ).toThrow(/authorized/i);
});
it('CT12: only verified host evidence applies a worker hold, duplicates stay monotonic, and release requires exact current-main validation', () => {
  const f = fixture();
  const control = f.request();
  const proof = {
    controlId: control.controlId,
    itemId: 'slice-1',
    conversationId: 'worker-1',
    assignmentRevision: 1,
    evidenceRef: 'host-publication-fence',
  };
  expect(() => f.work.recordControlAppliedForHost(proof, () => false)).toThrow(/verified/i);
  f.work.recordControlAppliedForHost(proof, () => true);
  const ack = {
    requestId: 'delayed-worker-ack',
    controlId: control.controlId,
    itemId: 'slice-1',
    assignmentRevision: 1,
  };
  f.work.acknowledgeControl(ack, { kind: 'conversation', id: 'worker-1' });
  expect(f.work.readControl(control.controlId, f.actor).targets[0].workers[0].stage).toBe(
    'applied',
  );
  f.assign('slice-1', 'worker', 'new-worker');
  expect(f.work.readControl(control.controlId, f.actor).targets[0].workers[0].stage).toBe(
    'requested',
  );
  expect(() => f.work.recordControlAppliedForHost(proof, () => true)).toThrow(/current/i);
  f.work.releaseControl({ requestId: 'release', controlId: control.controlId }, f.actor);
  const validation = {
    controlId: control.controlId,
    itemId: 'slice-1',
    mainCommit: 'a'.repeat(40),
    evidenceRef: 'validation-run-1',
  };
  expect(() => f.work.recordControlRevalidationForHost(validation, () => false)).toThrow(
    /verified/i,
  );
  f.work.recordControlRevalidationForHost(validation, () => true);
  f.restart();
  expect(() => f.work.assertControlAction('slice-1', 'publication', 'a'.repeat(40))).not.toThrow();
  expect(() => f.work.assertControlAction('slice-1', 'publication', 'b'.repeat(40))).toThrow(
    /revalidat/i,
  );
  expect(() => f.work.assertControlAction('slice-2', 'publication', 'a'.repeat(40))).toThrow(
    /revalidat/i,
  );
});

it('CT12: real HTTP control commands derive the current conversation and reject forged actors, host proof and unrelated inbox reads', async () => {
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { createTelosWorkRouter } = await import('../telos-work-routes.js');
  const { listenOnLoopback, closeTestServer } = await import('./loopback-test-server.js');
  const f = fixture();
  const app = express();
  app.use(express.json());
  const clients: Record<string, string> = {
    coordinator: 'coordinator-chat',
    lead: 'lead-1',
    unrelated: 'job-lead',
  };
  app.use(
    createTelosWorkRouter({
      dbPath: () => f.canonical.dbPath,
      operatorAuth: (_req, res, next) => {
        res.locals.authSession = { id: 'offline-operator' };
        next();
      },
      verifyInternal: (req) => req.headers['x-internal-token'] === 'offline-token',
      sessionId: (client) => clients[client],
      ordinaryConversation: () => true,
    }),
  );
  const server = await listenOnLoopback(app);
  const call = (client: string, input: object, sessionId = clients[client]) =>
    request(server)
      .post('/api/internal/telos/work/control')
      .set('x-internal-token', 'offline-token')
      .set('x-client-id', client)
      .send({ clientId: client, sessionId, input });
  try {
    const input = {
      operation: 'request',
      requestId: 'http-hold',
      coordinatorItemId: 'coordinator',
      priorityItemId: 'feature-0',
      targetItemIds: ['feature-1'],
      scope: 'new_worker_dispatch',
    };
    const created = await call('coordinator', input);
    expect(created.status).toBe(200);
    expect(created.body.targets).toHaveLength(1);
    const controlId = created.body.controlId;
    expect((await call('unrelated', { operation: 'read', controlId })).status).toBe(403);
    expect((await call('lead', { operation: 'read', controlId }, 'coordinator-chat')).status).toBe(
      403,
    );
    expect(
      (await call('coordinator', { ...input, actor: { kind: 'operator', id: 'forged' } })).status,
    ).toBe(400);
    expect(
      (await call('lead', { operation: 'applied', controlId, evidenceRef: 'forged' })).status,
    ).toBe(400);
    const inbox = await call('lead', { operation: 'inbox', itemId: 'feature-1' });
    expect(inbox.status).toBe(200);
    expect(inbox.body).toHaveLength(1);
    expect((await call('unrelated', { operation: 'inbox', itemId: 'feature-1' })).status).toBe(403);
    const acknowledged = await call('lead', {
      operation: 'acknowledge',
      requestId: 'http-ack',
      controlId,
      itemId: 'feature-1',
      assignmentRevision: 1,
    });
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body.targets[0].stage).toBe('acknowledged');
    clients.lead = 'job-lead';
    expect((await call('lead', { operation: 'read', controlId }, 'lead-1')).status).toBe(403);
  } finally {
    await closeTestServer(server);
  }
});
