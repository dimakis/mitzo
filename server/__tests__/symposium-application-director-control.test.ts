import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { SymposiumConfig } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import {
  SymposiumOrchestrator,
  type SymposiumSeatExecutor,
  type SymposiumSeatExecution,
} from '../symposium-orchestrator.js';
import { createSymposiumDirectorRouter } from '../symposium-director-routes.js';

const config: SymposiumConfig = {
  version: 1,
  revision: 1,
  state: 'active',
  seats: [
    {
      id: 'writer',
      name: 'Writer',
      role: 'primary',
      model: 'test',
      systemPrompt: 'Write.',
      color: '#123456',
      accountBinding: {
        accountId: 'test',
        accountLabel: 'Test',
        provider: 'openai-codex',
        model: 'test',
        profileRevision: 'one',
      },
      profileBinding: { profileId: 'writer', profileRevision: 'one' },
      contextGrant: {
        grantId: 'context',
        revision: 1,
        classification: 'work',
        sourceRefs: ['repo:test'],
      },
      authorityGrant: {
        grantId: 'authority',
        revision: 1,
        filesystem: 'write',
        tools: 'write',
        network: 'restricted',
      },
      isolationRequest: { trustDomainId: 'test', revision: 1, placement: 'reuse-compatible' },
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      model: 'test',
      systemPrompt: 'Review.',
      color: '#654321',
      accountBinding: {
        accountId: 'test',
        accountLabel: 'Test',
        provider: 'openai-codex',
        model: 'test',
        profileRevision: 'one',
      },
      profileBinding: { profileId: 'reviewer', profileRevision: 'one' },
      contextGrant: {
        grantId: 'context-reviewer',
        revision: 1,
        classification: 'work',
        sourceRefs: ['repo:test'],
      },
      authorityGrant: {
        grantId: 'authority-reviewer',
        revision: 1,
        filesystem: 'read',
        tools: 'read',
        network: 'restricted',
      },
      isolationRequest: { trustDomainId: 'test', revision: 1, placement: 'reuse-compatible' },
    },
  ],
  turnRules: { mode: 'directed', maxTurns: 2 },
  interceptMode: 'manual',
};

describe('controlled application delivery versus stale director routes', () => {
  let dir: string;
  let store: EventStore;
  let orchestrator: SymposiumOrchestrator;
  let app: ReturnType<typeof express>;
  let nativeCalls: SymposiumSeatExecution[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mitzo-controlled-director-'));
    store = new EventStore(join(dir, 'events.db'));
    store.upsertSession({ sessionId: 'chat', accountBinding: config.seats[0].accountBinding });
    store.setSymposiumConfig('chat', config);
    nativeCalls = [];
    const executor: SymposiumSeatExecutor = {
      execute: async (input) => {
        nativeCalls.push(input);
        return { providerThreadId: 'test-thread', content: 'done', costUsd: 0 };
      },
    };
    orchestrator = new SymposiumOrchestrator({
      store,
      executors: { writer: executor },
      idFactory: () => 'controlled-delivery',
      claimIdFactory: () => 'test-claim',
    });
    orchestrator.recordProviderAdmission({
      sessionId: 'chat',
      seatId: 'writer',
      decision: 'admitted',
      reason: 'Test admission',
      idempotencyKey: 'admit-writer',
    });
    app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authSession = { id: 'owner' };
      next();
    });
    app.use(
      '/api/sessions/:id/symposium',
      createSymposiumDirectorRouter({
        store,
        getRuntime: () => orchestrator,
        getSafetyOrchestrator: () => orchestrator,
      } as never),
    );
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects stale approve and dispatch across hold, arm, and revoked permit, then dispatches once with the current permit', async () => {
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: null,
      recipientSeatIds: ['writer'],
      originalContent: 'write a change',
      idempotencyKey: 'stage-application',
    });
    const deliveryId = staged.deliveryId;
    store.registerSymposiumApplicationDeliveryControl({
      deliveryId,
      workflowId: 'workflow',
      attemptId: 'attempt',
      policyReservationId: 'reservation',
    });
    const path = `/api/sessions/chat/symposium/deliveries/${deliveryId}`;
    const approve = () =>
      request(app).post(`${path}/interventions`).send({
        action: 'approve',
        idempotencyKey: 'stale-director-approval',
      });
    const dispatch = () => request(app).post(`${path}/dispatch`).send({});

    expect((await approve()).status).toBe(409);
    expect((await dispatch()).body.status).toBe('awaiting_intervention');
    store.armSymposiumApplicationDelivery({ deliveryId, expectedEpoch: 0, permit: 'first-permit' });
    expect((await approve()).status).toBe(409);
    expect((await dispatch()).body.status).toBe('awaiting_intervention');

    const epoch = store.pauseSymposiumApplicationDelivery({ deliveryId, expectedEpoch: 0 });
    expect(epoch).toBe(1);
    expect(() =>
      orchestrator.intervene({
        deliveryId,
        action: 'approve',
        idempotencyKey: 'revoked-approval',
        applicationPermit: 'first-permit',
      }),
    ).toThrow(/permit/i);
    expect((await approve()).status).toBe(409);
    expect((await dispatch()).body.status).toBe('awaiting_intervention');
    expect(nativeCalls).toHaveLength(0);
    expect(store.getSymposiumDelivery(deliveryId)?.status).toBe('awaiting_intervention');

    store.armSymposiumApplicationDelivery({
      deliveryId,
      expectedEpoch: epoch,
      permit: 'second-permit',
    });
    expect(() =>
      orchestrator.intervene({
        deliveryId,
        action: 'approve',
        idempotencyKey: 'old-approval',
        applicationPermit: 'first-permit',
      }),
    ).toThrow(/permit/i);
    orchestrator.intervene({
      deliveryId,
      action: 'approve',
      idempotencyKey: 'trusted-approval',
      applicationPermit: 'second-permit',
    });
    expect((await dispatch()).status).toBe(409);
    expect(nativeCalls).toHaveLength(0);
    expect(
      (await orchestrator.deliver(deliveryId, { applicationPermit: 'second-permit' })).status,
    ).toBe('delivered');
    expect(nativeCalls).toHaveLength(1);
  });

  it('refuses a competing pause when authorized approval won the SQLite transition', async () => {
    const staged = orchestrator.stageDelivery({
      sessionId: 'chat',
      sourceSeatId: null,
      recipientSeatIds: ['writer'],
      originalContent: 'write a change',
      idempotencyKey: 'stage-application',
    });
    store.registerSymposiumApplicationDeliveryControl({
      deliveryId: staged.deliveryId,
      workflowId: 'workflow',
      attemptId: 'attempt',
      policyReservationId: 'reservation',
    });
    store.armSymposiumApplicationDelivery({
      deliveryId: staged.deliveryId,
      expectedEpoch: 0,
      permit: 'current-permit',
    });
    const competingStore = new EventStore(join(dir, 'events.db'));
    try {
      expect(
        orchestrator.intervene({
          deliveryId: staged.deliveryId,
          action: 'approve',
          idempotencyKey: 'trusted-approval',
          applicationPermit: 'current-permit',
        }).status,
      ).toBe('ready');
      expect(() =>
        competingStore.pauseSymposiumApplicationDelivery({
          deliveryId: staged.deliveryId,
          expectedEpoch: 0,
        }),
      ).toThrow(/safely staged/i);
      expect(nativeCalls).toHaveLength(0);
      const path = `/api/sessions/chat/symposium/deliveries/${staged.deliveryId}/dispatch`;
      expect((await request(app).post(path).send({})).status).toBe(409);
      expect(nativeCalls).toHaveLength(0);
    } finally {
      competingStore.close();
    }
  });
});
