import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSymposiumDirectorRouter } from '../symposium-director-routes.js';

const config = {
  version: 2 as const,
  revision: 4,
  state: 'active' as const,
  anchorSeatId: 'architect',
  activeSeatCap: 3,
  seats: [
    {
      id: 'architect',
      name: 'Architect',
      role: 'architect',
      model: 'frontier',
      systemPrompt: '',
      color: '#335577',
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      model: 'workhorse',
      systemPrompt: '',
      color: '#557733',
    },
  ],
  turnRules: { mode: 'directed' as const, maxTurns: 4 },
  interceptMode: 'manual' as const,
};

function fixture(runtimeAvailable = false) {
  const membership = {
    sessionId: 'chat',
    seatId: 'reviewer',
    generation: 2,
    state: 'active',
    action: 'admit',
    configRevision: 4,
    reconciliation: 'pending',
  };
  const store = {
    getSession: vi.fn((id: string) =>
      id === 'chat'
        ? {
            sessionId: id,
            sessionType: 'symposium',
            symposiumConfig: JSON.stringify({ ...config, state: 'draft' }),
            symposiumRevision: 4,
          }
        : null,
    ),
    getActiveSymposiumConfig: vi.fn(() => config),
    getSymposiumInitialProfileSelections: vi.fn(() => ({})),
    getSymposiumMembershipHistory: vi.fn(() => [membership]),
    getSymposiumAdmissions: vi.fn(() => []),
    getSymposiumDeliveries: vi.fn(() => []),
    getSymposiumDelivery: vi.fn((id: string) =>
      id === 'delivery-1'
        ? { deliveryId: id, sessionId: 'chat', status: 'awaiting_intervention' }
        : id === 'foreign'
          ? { deliveryId: id, sessionId: 'other', status: 'awaiting_intervention' }
          : undefined,
    ),
    getSymposiumSourceMessage: vi.fn(() => ({
      messageId: 'review-1',
      seatId: 'reviewer',
      content: 'The durable snapshot should be restored first.',
      provenance: null,
    })),
    setSymposiumConfig: vi.fn((_id: string, next: unknown) => next),
  };
  const orchestrator = {
    transitionMembership: vi.fn(async () => ({
      ...membership,
      state: 'suspended',
      reconciliation: 'recovery_required',
    })),
    stageDelivery: vi.fn(() => ({ deliveryId: 'delivery-1', status: 'awaiting_intervention' })),
    intervene: vi.fn(() => ({ deliveryId: 'delivery-1', status: 'ready' })),
    deliver: vi.fn(async () => ({ deliveryId: 'delivery-1', status: 'delivered' })),
    cancel: vi.fn(async () => ({ deliveryId: 'delivery-1', status: 'cancelled' })),
  };
  const validateSelection = vi.fn();
  const validateActiveConfig = vi.fn();
  const activateDraft = vi.fn(() => ({ ...config, revision: 5, state: 'active' as const }));
  const reviseSeat = vi.fn((_input?: unknown) => ({ ...config, revision: 5 }));
  const getPerspective = vi.fn(() => ({
    items: [
      {
        kind: 'authored' as const,
        eventSeq: 1,
        messageId: 'turn-1',
        seatId: 'reviewer',
        content: 'Review',
        provenance: null,
      },
    ],
    nextSeq: null,
  }));
  const getQueuedInputs = vi.fn(() => []);
  const resolveSelection = vi.fn(() => ({
    accountId: 'claude-work',
    accountLabel: 'Claude work',
    provider: 'anthropic-vertex' as const,
    model: 'claude-sonnet',
    profileRevision: 'rev-1',
  }));
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authSession = { id: 'operator-1' };
    next();
  });
  app.use(
    '/api/sessions/:id/symposium',
    createSymposiumDirectorRouter({
      store: store as never,
      getRuntime: () => (runtimeAvailable ? (orchestrator as never) : null),
      getSafetyOrchestrator: () => orchestrator as never,
      validateSelection,
      validateActiveConfig,
      activateDraft,
      reviseSeat,
      getPerspective,
      getQueuedInputs,
      resolveSelection,
    }),
  );
  return {
    app,
    store,
    orchestrator,
    validateSelection,
    validateActiveConfig,
    activateDraft,
    reviseSeat,
    getPerspective,
    getQueuedInputs,
    resolveSelection,
  };
}

describe('Symposium director routes', () => {
  it('returns only the requested seat perspective and bounded queued inputs', async () => {
    const { app, getPerspective, getQueuedInputs } = fixture();
    const response = await request(app).get(
      '/api/sessions/chat/symposium/perspectives?kind=seat&seatId=reviewer&afterSeq=0&limit=20',
    );
    expect(response.status).toBe(200);
    expect(response.body.items).toMatchObject([{ messageId: 'turn-1', seatId: 'reviewer' }]);
    expect(getPerspective).toHaveBeenCalledWith(
      'chat',
      { kind: 'seat', seatId: 'reviewer' },
      { afterSeq: 0, limit: 20 },
    );
    expect(getQueuedInputs).toHaveBeenCalledWith('chat', { kind: 'seat', seatId: 'reviewer' });
    expect(
      (await request(app).get('/api/sessions/chat/symposium/perspectives?kind=seat&seatId=unknown'))
        .status,
    ).toBe(404);
  });
  it('creates a revision-guarded draft from the existing session account binding', async () => {
    const { app, store } = fixture();
    store.getSession.mockReturnValue({
      sessionId: 'chat',
      sessionType: 'chat',
      symposiumConfig: null,
      symposiumRevision: 0,
      accountBinding: {
        accountId: 'claude-work',
        accountLabel: 'Claude work',
        provider: 'anthropic-vertex',
        model: 'claude-sonnet',
        profileRevision: 'rev-1',
      },
    } as never);
    const response = await request(app).post('/api/sessions/chat/symposium/draft').send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      version: 2,
      revision: 1,
      state: 'draft',
      anchorSeatId: 'architect',
      seats: [{ id: 'architect', accountBinding: { accountId: 'claude-work' } }],
    });
    expect(store.setSymposiumConfig).toHaveBeenCalledWith('chat', expect.any(Object), 0);
  });

  it('activates a draft through host grants only after shared and cross-account confirmation', async () => {
    const { app, store, activateDraft } = fixture(true);
    store.getSession.mockReturnValue({
      sessionId: 'chat',
      sessionType: 'symposium',
      symposiumRevision: 4,
      symposiumConfig: JSON.stringify({
        ...config,
        state: 'draft',
        seats: config.seats.map((seat, index) => ({
          ...seat,
          accountBinding: {
            accountId: index ? 'openai-work' : 'claude-work',
            accountLabel: index ? 'OpenAI' : 'Claude',
            provider: index ? 'openai' : 'anthropic-vertex',
            model: seat.model,
            profileRevision: 'rev-1',
          },
        })),
      }),
    } as never);
    const body = { expectedRevision: 4 };
    expect(
      (await request(app).post('/api/sessions/chat/symposium/activate').send(body)).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .post('/api/sessions/chat/symposium/activate')
          .send({ ...body, sharedBoundaryAcknowledged: true })
      ).status,
    ).toBe(409);
    expect(activateDraft).not.toHaveBeenCalled();
    const accepted = await request(app)
      .post('/api/sessions/chat/symposium/activate')
      .send({
        ...body,
        sharedBoundaryAcknowledged: true,
        crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT',
        profileSelections: { reviewer: { profileId: 'owner-review', revision: 2 } },
      });
    expect(accepted.status).toBe(200);
    expect(activateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'chat',
        expectedRevision: 4,
        actor: 'operator:operator-1',
        profileSelections: { reviewer: { profileId: 'owner-review', revision: 2 } },
      }),
    );
  });
  it('does not issue grants or persist activation without a verified runtime', async () => {
    const { app, store, activateDraft } = fixture();
    const response = await request(app)
      .post('/api/sessions/chat/symposium/activate')
      .send({ expectedRevision: 4, sharedBoundaryAcknowledged: true });
    expect(response.status).toBe(503);
    expect(activateDraft).not.toHaveBeenCalled();
    expect(store.setSymposiumConfig).not.toHaveBeenCalled();
  });
  it('reissues a nonactive seat from server-resolved selection without client grant claims', async () => {
    const { app, store, resolveSelection, reviseSeat } = fixture(true);
    const bound = {
      ...config,
      seats: config.seats.map((seat) => ({
        ...seat,
        accountBinding: {
          accountId: 'claude-work',
          accountLabel: 'Claude',
          provider: 'anthropic-vertex',
          model: seat.model,
          profileRevision: 'rev-1',
        },
      })),
    };
    store.getActiveSymposiumConfig.mockReturnValue(bound as never);
    resolveSelection.mockReturnValue({
      accountId: 'openai-work',
      accountLabel: 'OpenAI',
      provider: 'openai',
      model: 'gpt',
      profileRevision: 'rev-2',
    } as never);
    const body = {
      expectedRevision: 4,
      seatId: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      systemPrompt: 'Review only',
      color: '#557733',
      accountId: 'openai-work',
      model: 'gpt',
      sharedBoundaryAcknowledged: true,
    };
    const missing = await request(app).post('/api/sessions/chat/symposium/seats/revise').send(body);
    expect(missing.status).toBe(409);
    const spoof = await request(app)
      .post('/api/sessions/chat/symposium/seats/revise')
      .send({
        ...body,
        authorityGrant: { grantId: 'spoof' },
        crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT',
      });
    expect(spoof.status).toBe(400);
    const accepted = await request(app)
      .post('/api/sessions/chat/symposium/seats/revise')
      .send({
        ...body,
        crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT',
        profileSelection: { profileId: 'owner-review', revision: 2 },
      });
    expect(accepted.status).toBe(200);
    expect(reviseSeat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'chat',
        expectedRevision: 4,
        actor: 'operator:operator-1',
        profileSelection: { profileId: 'owner-review', revision: 2 },
        seat: expect.objectContaining({
          id: 'reviewer',
          model: 'gpt',
          accountBinding: expect.objectContaining({ accountId: 'openai-work' }),
        }),
      }),
    );
    expect(reviseSeat.mock.calls[0]?.[0]).not.toHaveProperty('seat.profileSelection');
  });
  it.each(['reviewer', 'new-seat'])(
    'does not mint or reissue %s grants without a runtime',
    async (seatId) => {
      const { app, store, resolveSelection, reviseSeat } = fixture();
      const before = JSON.stringify(store.getActiveSymposiumConfig());
      const response = await request(app).post('/api/sessions/chat/symposium/seats/revise').send({
        expectedRevision: 4,
        seatId,
        name: 'Reviewer',
        role: 'reviewer',
        systemPrompt: 'Review only',
        color: '#557733',
        accountId: 'claude-work',
        model: 'claude-sonnet',
        sharedBoundaryAcknowledged: true,
      });
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('Symposium provider runtime is unavailable');
      expect(resolveSelection).not.toHaveBeenCalled();
      expect(reviseSeat).not.toHaveBeenCalled();
      expect(store.setSymposiumConfig).not.toHaveBeenCalled();
      expect(JSON.stringify(store.getActiveSymposiumConfig())).toBe(before);
    },
  );
  it('resolves a seat account binding server-side without exposing credentials', async () => {
    const { app, resolveSelection } = fixture();
    const response = await request(app)
      .post('/api/sessions/chat/symposium/selection')
      .send({ accountId: 'claude-work', model: 'claude-sonnet', reasoningEffort: 'high' });
    expect(response.status).toBe(200);
    expect(response.body.binding).toEqual({
      accountId: 'claude-work',
      accountLabel: 'Claude work',
      provider: 'anthropic-vertex',
      model: 'claude-sonnet',
      profileRevision: 'rev-1',
    });
    expect(resolveSelection).toHaveBeenCalledWith('claude-work', 'claude-sonnet', 'high');
    expect(JSON.stringify(response.body)).not.toMatch(/credential|token|secret/i);
  });
  it('shows reserved capacity and pending runtime without presenting a seat as admitted', async () => {
    const { app } = fixture();
    const response = await request(app).get('/api/sessions/chat/symposium');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      sessionId: 'chat',
      config: { revision: 4, activeSeatCap: 3 },
      reservedSeats: 1,
      capacityRemaining: 2,
      runtimeAvailable: false,
      seats: [
        { seatId: 'architect', admitted: false },
        { seatId: 'reviewer', admitted: false },
      ],
    });
    expect(response.body.seats[1].membership.reconciliation).toBe('pending');
  });

  it('shows a draft roster without requiring active provider admission', async () => {
    const { app, store } = fixture();
    store.getSession.mockReturnValue({
      sessionId: 'chat',
      sessionType: 'symposium',
      symposiumConfig: JSON.stringify({ ...config, state: 'draft' }),
      symposiumRevision: 4,
    } as never);
    const response = await request(app).get('/api/sessions/chat/symposium');
    expect(response.status).toBe(200);
    expect(response.body.config.state).toBe('draft');
    expect(response.body.seats).toHaveLength(2);
    expect(response.body.seats.every((seat: { admitted: boolean }) => !seat.admitted)).toBe(true);
  });

  it('fences revocation while runtime is unavailable and derives the actor from auth', async () => {
    const { app, orchestrator } = fixture();
    const body = {
      seatId: 'reviewer',
      action: 'suspend',
      expectedGeneration: 2,
      configRevision: 4,
      reason: 'Pause review',
      idempotencyKey: 'suspend-reviewer-2',
    };
    const spoofed = await request(app)
      .post('/api/sessions/chat/symposium/membership')
      .send({ ...body, actor: 'spoofed' });
    expect(spoofed.status).toBe(400);
    const response = await request(app).post('/api/sessions/chat/symposium/membership').send(body);
    expect(response.status).toBe(200);
    expect(orchestrator.transitionMembership).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'operator:operator-1', action: 'suspend' }),
    );
    expect(response.body.reconciliation).toBe('recovery_required');
  });

  it('requires verified runtime and explicit shared-boundary acknowledgement before admission', async () => {
    const { app, orchestrator } = fixture();
    const response = await request(app).post('/api/sessions/chat/symposium/membership').send({
      seatId: 'reviewer',
      action: 'restore',
      expectedGeneration: 2,
      configRevision: 4,
      reason: 'Resume review',
      idempotencyKey: 'restore-reviewer-2',
    });
    expect(response.status).toBe(503);
    expect(orchestrator.transitionMembership).not.toHaveBeenCalled();
  });

  it('returns a guarded conflict when admission is requested for an unactivated draft', async () => {
    const { app, store, orchestrator } = fixture(true);
    store.getActiveSymposiumConfig.mockImplementation(() => {
      throw new Error('Symposium is not active');
    });
    const response = await request(app).post('/api/sessions/chat/symposium/membership').send({
      seatId: 'reviewer',
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 4,
      reason: 'Admit reviewer',
      idempotencyKey: 'admit-draft',
      sharedBoundaryAcknowledged: true,
    });
    expect(response.status).toBe(409);
    expect(orchestrator.transitionMembership).not.toHaveBeenCalled();
  });

  it('requires typed confirmation when restoring a seat bound to another account', async () => {
    const { app, store, orchestrator } = fixture(true);
    store.getActiveSymposiumConfig.mockReturnValue({
      ...config,
      seats: config.seats.map((seat, index) => ({
        ...seat,
        accountBinding: { accountId: index === 0 ? 'architect-account' : 'reviewer-account' },
      })),
    } as never);
    const body = {
      seatId: 'reviewer',
      action: 'restore',
      expectedGeneration: 2,
      configRevision: 4,
      reason: 'Resume review',
      idempotencyKey: 'restore-reviewer-2',
      sharedBoundaryAcknowledged: true,
    };
    const missing = await request(app).post('/api/sessions/chat/symposium/membership').send(body);
    expect(missing.status).toBe(409);
    expect(orchestrator.transitionMembership).not.toHaveBeenCalled();
    const accepted = await request(app)
      .post('/api/sessions/chat/symposium/membership')
      .send({ ...body, crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT' });
    expect(accepted.status).toBe(200);
  });

  it('updates draft configuration only at the expected revision', async () => {
    const { app, store } = fixture();
    const next = { ...config, revision: 5, state: 'draft' };
    const stale = await request(app)
      .put('/api/sessions/chat/symposium/config')
      .send({ expectedRevision: 3, config: next });
    expect(stale.status).toBe(409);
    expect(store.setSymposiumConfig).not.toHaveBeenCalled();
    const accepted = await request(app)
      .put('/api/sessions/chat/symposium/config')
      .send({ expectedRevision: 4, config: next });
    expect(accepted.status).toBe(200);
    expect(store.setSymposiumConfig).toHaveBeenCalledWith('chat', next, 4);
  });

  it('requires the discovered account catalog to support each selected model and effort', async () => {
    const { app, store, validateSelection } = fixture();
    validateSelection.mockImplementation(() => {
      throw new Error('Model unavailable for selected account');
    });
    const next = {
      ...config,
      revision: 5,
      state: 'draft',
      seats: [
        {
          ...config.seats[0],
          reasoningEffort: 'high',
          accountBinding: {
            accountId: 'work-frontier',
            accountLabel: 'Frontier account',
            provider: 'openai-codex',
            model: 'frontier',
            profileRevision: 'account-1',
          },
        },
        config.seats[1],
      ],
    };
    const response = await request(app)
      .put('/api/sessions/chat/symposium/config')
      .send({ expectedRevision: 4, config: next });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/model unavailable/i);
    expect(store.setSymposiumConfig).not.toHaveBeenCalled();
  });

  it('requires typed cross-account confirmation before activating a shared seat', async () => {
    const { app, store, validateActiveConfig } = fixture(true);
    const activeSeat = (seat: (typeof config.seats)[number], accountId: string) => ({
      ...seat,
      accountBinding: {
        accountId,
        accountLabel: accountId,
        provider: 'openai-codex',
        model: seat.model,
        profileRevision: 'profile-1',
      },
      profileBinding: { profileId: seat.id, profileRevision: 'seat-1' },
      contextGrant: { grantId: 'context-1', revision: 1, classification: 'work', sourceRefs: [] },
      authorityGrant: {
        grantId: 'authority-1',
        revision: 1,
        filesystem: 'read',
        tools: 'read',
        network: 'restricted',
      },
      isolationRequest: { trustDomainId: 'shared', revision: 1, placement: 'reuse-compatible' },
    });
    const next = {
      ...config,
      revision: 5,
      seats: [
        activeSeat(config.seats[0], 'planner-account'),
        activeSeat(config.seats[1], 'reviewer-account'),
      ],
    };
    const missing = await request(app)
      .put('/api/sessions/chat/symposium/config')
      .send({ expectedRevision: 4, config: next, sharedBoundaryAcknowledged: true });
    expect(missing.status).toBe(409);
    expect(store.setSymposiumConfig).not.toHaveBeenCalled();
    const accepted = await request(app).put('/api/sessions/chat/symposium/config').send({
      expectedRevision: 4,
      config: next,
      sharedBoundaryAcknowledged: true,
      crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT',
    });
    expect(accepted.status).toBe(200);
    expect(validateActiveConfig).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ revision: 5 }),
    );
  });

  it('rejects active configuration without verified runtime grants and draft grant fabrication', async () => {
    const { app, store, validateActiveConfig } = fixture();
    const active = {
      ...config,
      revision: 5,
      state: 'active',
      seats: config.seats.map((seat) => ({
        ...seat,
        accountBinding: {
          accountId: 'same-account',
          accountLabel: 'Same account',
          provider: 'openai-codex',
          model: seat.model,
          profileRevision: 'rev-1',
        },
        profileBinding: { profileId: seat.id, profileRevision: 'seat-1' },
        contextGrant: { grantId: 'context-1', revision: 1, classification: 'work', sourceRefs: [] },
        authorityGrant: {
          grantId: 'authority-1',
          revision: 1,
          filesystem: 'read',
          tools: 'read',
          network: 'restricted',
        },
        isolationRequest: { trustDomainId: 'shared', revision: 1, placement: 'reuse-compatible' },
      })),
    };
    const response = await request(app).put('/api/sessions/chat/symposium/config').send({
      expectedRevision: 4,
      config: active,
      sharedBoundaryAcknowledged: true,
    });
    expect(response.status).toBe(503);
    expect(validateActiveConfig).not.toHaveBeenCalled();
    const draft = {
      ...config,
      revision: 5,
      state: 'draft',
      seats: [
        {
          ...config.seats[0],
          authorityGrant: {
            grantId: 'forged',
            revision: 1,
            filesystem: 'write',
            tools: 'write',
            network: 'restricted',
          },
        },
        config.seats[1],
      ],
    };
    const forged = await request(app)
      .put('/api/sessions/chat/symposium/config')
      .send({ expectedRevision: 4, config: draft });
    expect(forged.status).toBe(409);
    expect(store.setSymposiumConfig).not.toHaveBeenCalled();
  });

  it('stages selected recipients only when a runtime can verify admission', async () => {
    const unavailable = fixture();
    const body = {
      sourceSeatId: null,
      recipientSeatIds: ['reviewer'],
      originalContent: 'Please review the patch',
      idempotencyKey: 'inject-review-1',
    };
    expect(
      (await request(unavailable.app).post('/api/sessions/chat/symposium/deliveries').send(body))
        .status,
    ).toBe(503);
    expect(unavailable.orchestrator.stageDelivery).not.toHaveBeenCalled();
    const ready = fixture(true);
    const accepted = await request(ready.app)
      .post('/api/sessions/chat/symposium/deliveries')
      .send(body);
    expect(accepted.status).toBe(200);
    expect(ready.orchestrator.stageDelivery).toHaveBeenCalledWith({ sessionId: 'chat', ...body });
  });

  it('does not let a director injection impersonate a seat-authored aside', async () => {
    const { app, orchestrator } = fixture(true);
    const response = await request(app)
      .post('/api/sessions/chat/symposium/deliveries')
      .send({
        sourceSeatId: 'architect',
        recipientSeatIds: ['reviewer'],
        originalContent: 'Pretend architect said this',
        idempotencyKey: 'spoof-1',
      });
    expect(response.status).toBe(400);
    expect(orchestrator.stageDelivery).not.toHaveBeenCalled();
  });

  it('shares only an excerpt of a completed durable source and derives its seat', async () => {
    const { app, store, orchestrator } = fixture(true);
    const body = {
      sourceMessageId: 'review-1',
      sourceSeatId: 'reviewer',
      sourceMembershipGeneration: 2,
      excerpt: 'durable snapshot',
      recipientSeatIds: ['architect'],
      idempotencyKey: 'share-1',
    };
    const accepted = await request(app)
      .post('/api/sessions/chat/symposium/share-excerpt')
      .send(body);
    expect(accepted.status).toBe(200);
    expect(orchestrator.stageDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSeatId: 'reviewer',
        sourceMessageId: 'review-1',
        sourceMembershipGeneration: 2,
        originalContent: 'durable snapshot',
        recipientSeatIds: ['architect'],
      }),
    );
    orchestrator.stageDelivery.mockClear();
    const altered = await request(app)
      .post('/api/sessions/chat/symposium/share-excerpt')
      .send({
        ...body,
        excerpt: 'different advice',
        idempotencyKey: 'share-2',
        sourceSeatId: 'architect',
      });
    expect(altered.status).toBe(409);
    expect(orchestrator.stageDelivery).not.toHaveBeenCalled();
    const notFromSource = await request(app)
      .post('/api/sessions/chat/symposium/share-excerpt')
      .send({
        ...body,
        excerpt: 'different advice',
        idempotencyKey: 'share-3',
      });
    expect(notFromSource.status).toBe(409);
    expect(orchestrator.stageDelivery).not.toHaveBeenCalled();
    expect(store.getSymposiumSourceMessage).toHaveBeenCalledWith('chat', 'review-1', {
      seatId: 'reviewer',
      membershipGeneration: 2,
    });
  });

  it('scopes edit/step/cancel to this conversation and fences cancellation without runtime', async () => {
    const { app, orchestrator } = fixture();
    const foreign = await request(app)
      .post('/api/sessions/chat/symposium/deliveries/foreign/interventions')
      .send({ action: 'edit', content: 'new text', idempotencyKey: 'edit-1' });
    expect(foreign.status).toBe(404);
    expect(orchestrator.intervene).not.toHaveBeenCalled();
    const edited = await request(app)
      .post('/api/sessions/chat/symposium/deliveries/delivery-1/interventions')
      .send({ action: 'edit', content: 'new text', idempotencyKey: 'edit-1' });
    expect(edited.status).toBe(200);
    expect(orchestrator.intervene).toHaveBeenCalledWith({
      deliveryId: 'delivery-1',
      action: 'edit',
      content: 'new text',
      idempotencyKey: 'edit-1',
    });
    const step = await request(app).post(
      '/api/sessions/chat/symposium/deliveries/delivery-1/dispatch',
    );
    expect(step.status).toBe(503);
    const cancelled = await request(app)
      .post('/api/sessions/chat/symposium/deliveries/delivery-1/cancel')
      .send({ reason: 'Director stopped work', idempotencyKey: 'cancel-1' });
    expect(cancelled.status).toBe(200);
    expect(orchestrator.cancel).toHaveBeenCalledWith({
      deliveryId: 'delivery-1',
      reason: 'Director stopped work',
      idempotencyKey: 'cancel-1',
    });
  });
});

it('refuses converting an active ordinary conversation into a draft', async () => {
  const { app, store } = fixture();
  store.getSession.mockReturnValue({
    sessionId: 'chat',
    symposiumConfig: null,
    isActive: true,
    accountBinding: {
      accountId: 'work',
      accountLabel: 'Work',
      provider: 'openai',
      model: 'gpt-5.6-luna',
      profileRevision: 'revision',
    },
  } as never);
  const response = await request(app).post('/api/sessions/chat/symposium/draft').send({});
  expect(response.status).toBe(409);
  expect(response.body.error).toContain('Stop the ordinary conversation');
  expect(store.setSymposiumConfig).not.toHaveBeenCalled();
});
