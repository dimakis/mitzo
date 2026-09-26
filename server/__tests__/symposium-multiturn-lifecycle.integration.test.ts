import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { AccountBindingSchema, type SymposiumConfig } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { AccountProfiles } from '../account-profiles.js';
import { SymposiumOrchestrator, type SymposiumSeatExecution } from '../symposium-orchestrator.js';
import { SymposiumHostGrants } from '../symposium-host-grants.js';
import { SymposiumProfileStore } from '../symposium-profiles.js';
import { SymposiumProfileProposalStore } from '../symposium-profile-proposals.js';
import {
  proposeProfileFromTool,
  SYMPOSIUM_PROPOSE_PROFILE_TOOL,
} from '../symposium-profile-tool.js';
import {
  createSymposiumNativeProfileTools,
  SYMPOSIUM_READ_PROFILE_TOOL,
} from '../symposium-native-profile-tools.js';
import { createOpenAiCodexSeat } from '../symposium-codex-native.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { createSymposiumProfileProposalRouter } from '../symposium-profile-proposal-routes.js';
import { createSymposiumDirectorRouter } from '../symposium-director-routes.js';
import { getSymposiumPerspective, getSymposiumQueuedInputs } from '../symposium-perspectives.js';
import { admitSymposiumSeatDispatch } from '../symposium-seat-runtime.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real SQLite, profile tool/proposal save, host grants and HTTP director routes.
 * Provider execution and physical stop are explicitly mocked: no live capability,
 * credentials, native sandbox, model invocation or billing is asserted here. */
it('persists three directed turns across profile revision, seat removal/addition and restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'symposium-multiturn-'));
  roots.push(root);
  const db = join(root, 'events.db');
  const conversations = new CodexConversationStore(join(root, 'conversations.db'));
  let nativeProposalId: string | undefined;
  let store = new EventStore(db);
  let catalog = new SymposiumProfileStore(db);
  let proposals = new SymposiumProfileProposalStore(db);
  const accounts = new AccountProfiles(
    ['work', 'second'].map((id) => ({
      id,
      label: id,
      provider: 'openai',
      credentialRef: { provider: 'keychain', service: 'fixture', account: id },
      sandboxProvider: `provider-${id}`,
      sandboxProviderId: `object-${id}`,
      models: [{ id: 'fixture-model', label: 'Fixture' }],
    })),
  );
  const binding = AccountBindingSchema.parse(accounts.resolve('work', 'fixture-model'));
  const seats = ['writer', 'reviewer'].map((id) => ({
    id,
    name: id,
    role: id === 'writer' ? 'implementer' : 'reviewer',
    model: 'fixture-model',
    accountBinding: binding,
    systemPrompt: id === 'writer' ? 'Implement the approved patch.' : 'Review for correctness.',
    color: '#123456',
  }));
  const draft: SymposiumConfig = {
    version: 2,
    revision: 1,
    state: 'draft',
    anchorSeatId: 'writer',
    activeSeatCap: 3,
    seats,
    turnRules: { mode: 'directed', maxTurns: 20 },
    interceptMode: 'manual',
  };
  store.upsertSession({ sessionId: 'discussion', accountBinding: binding });
  store.setSymposiumConfig('discussion', draft);
  const makeGrants = () =>
    new SymposiumHostGrants(db, {
      getConfig: () => JSON.parse(store.getSession('discussion')!.symposiumConfig!),
      commitConfig: (id, next, revision) => store.setSymposiumConfig(id, next, revision),
      getMembership: (id, seat) => store.getLatestSymposiumMembership(id, seat) ?? null,
      validateSelection: (seat) =>
        accounts.validateModel(seat.accountBinding!, seat.model, seat.reasoningEffort),
      resolveProfile: (selection) => catalog.get('user', selection.profileId, selection.revision),
      authorizeSeat: ({ seat, contextSourceRefs }) => ({
        classification: 'mixed',
        sourceRefs: contextSourceRefs,
        authority: {
          filesystem: seat.role === 'implementer' ? 'write' : 'read',
          tools: seat.role === 'implementer' ? 'write' : 'read',
          network: 'restricted',
        },
      }),
    });
  let grants = makeGrants();
  const calls: SymposiumSeatExecution[] = [];
  const stop = vi.fn(async () => {});
  let runtime: SymposiumOrchestrator;
  const makeRuntime = () =>
    new SymposiumOrchestrator({
      store,
      executors: Object.fromEntries(
        ['writer', 'reviewer', 'auditor'].map((id) => [
          id,
          {
            execute: async (input: SymposiumSeatExecution) => {
              // Use the production synchronous dispatch fence even though provider output is fake.
              const route = admitSymposiumSeatDispatch(store, accounts, input, grants);
              calls.push(input);
              const shouldPropose = id === 'writer' && calls.length === 1;
              const providerThreadId =
                input.providerThreadId ?? `fake-${id}-${input.provenance.membershipGeneration}`;
              const native = await createOpenAiCodexSeat({
                execution: input,
                route,
                store: conversations,
                sandbox: { sandboxName: 'mock-only', workdir: '/workspace' },
                profileTools: createSymposiumNativeProfileTools({
                  store: proposals,
                  catalogStore: catalog,
                  owner: 'user',
                  execution: input,
                  verifyCurrent: () => {
                    admitSymposiumSeatDispatch(store, accounts, input, grants);
                  },
                }),
                createConversation: (options) => ({
                  initialize: async () => {
                    expect(options.tools.map((tool) => tool.name)).toContain(
                      SYMPOSIUM_PROPOSE_PROFILE_TOOL,
                    );
                  },
                  getThreadId: () => providerThreadId,
                  send: async () => {
                    options.onProviderDispatch?.(input.claimToken);
                    options.onProviderAccepted?.(input.claimToken, providerThreadId, 'mock-turn');
                    if (shouldPropose) {
                      const read = await options.executeTool(
                        SYMPOSIUM_READ_PROFILE_TOOL,
                        { action: 'get', profileId: 'evidence-reviewer', revision: 1 },
                        input.signal,
                        { turnId: 'mock-turn', callId: 'profile-read' },
                      );
                      expect(read.isError).toBe(false);
                      expect(JSON.parse(read.content).definition.instructions).toBe(
                        definition.instructions,
                      );
                      const result = await options.executeTool(
                        SYMPOSIUM_PROPOSE_PROFILE_TOOL,
                        {
                          suggestedProfileId: 'evidence-reviewer',
                          definition: {
                            ...definition,
                            instructions:
                              'Review correctness, regression tests, and security boundaries.',
                          },
                        },
                        input.signal,
                        { turnId: 'mock-turn', callId: 'profile-call' },
                      );
                      expect(result.isError).toBe(false);
                      nativeProposalId = JSON.parse(result.content).proposalId;
                      expect(catalog.get('user', 'evidence-reviewer')?.revision).toBe(1);
                    }
                    options.emit({
                      type: 'assistant',
                      message: { content: [{ type: 'text', text: `${id}: ${input.content}` }] },
                    });
                    options.onProviderTerminal?.(input.claimToken, 'mock-turn', 'completed');
                    options.onProviderComplete?.(input.claimToken, 'completed');
                  },
                  interrupt: async () => {},
                  close: () => {},
                }),
              });
              return native.run(input, {
                beforeDispatch: () => {
                  admitSymposiumSeatDispatch(store, accounts, input, grants);
                },
                accepted: () => {},
              });
            },
          },
        ]),
      ),
      stopSeat: stop,
      reconcileProviders: async () => {},
      admitSeat: ({ seatId, generation }) => {
        runtime.recordProviderAdmission({
          sessionId: 'discussion',
          seatId,
          decision: 'admitted',
          reason: 'Mock provider boundary only',
          idempotencyKey: `fake-admit-${seatId}-${generation}-${store.getActiveSymposiumConfig('discussion').revision}`,
        });
      },
    });
  runtime = makeRuntime();
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authSession = { id: 'owner' };
    next();
  });
  app.use(
    '/proposals',
    createSymposiumProfileProposalRouter(proposals, (id) => !!store.getSession(id)),
  );
  app.use(
    '/api/sessions/:id/symposium',
    createSymposiumDirectorRouter({
      store,
      getRuntime: () => runtime,
      getSafetyOrchestrator: () => runtime,
      validateSelection: (seat) =>
        accounts.validateModel(seat.accountBinding!, seat.model, seat.reasoningEffort),
      validateActiveConfig: () => {},
      activateDraft: (input) => grants.activate(input),
      reviseSeat: (input) => grants.reviseSeat(input),
      resolveSelection: (id, model) => AccountBindingSchema.parse(accounts.resolve(id, model)),
      getPerspective: (id, perspective, options) =>
        getSymposiumPerspective(store, id, perspective, options),
      getQueuedInputs: (id, perspective) => getSymposiumQueuedInputs(store, id, perspective),
    }),
  );
  const base = '/api/sessions/discussion/symposium';
  const definition = {
    name: 'Evidence Reviewer',
    role: 'reviewer' as const,
    instructions: 'Review correctness and cite evidence.',
    expectedOutput: 'Findings with evidence',
    acceptanceCriteria: ['Cite the changed lines'],
    modelPolicyRole: 'reviewer',
  };
  async function saveProfile(revision: number, instructions: string, existingProposalId?: string) {
    const proposal = existingProposalId
      ? { proposalId: existingProposalId }
      : proposeProfileFromTool({
          store: proposals,
          owner: 'user',
          sessionId: 'discussion',
          turnId: `profile-turn-${revision}`,
          callId: `profile-call-${revision}`,
          arguments: {
            suggestedProfileId: 'evidence-reviewer',
            definition: { ...definition, instructions },
          },
        });
    const before = catalog.get('user', 'evidence-reviewer');
    expect(before?.revision ?? 0).toBe(revision);
    const saved = await request(app)
      .post(`/proposals/${proposal.proposalId}/save`)
      .send({
        sessionId: 'discussion',
        profileId: 'evidence-reviewer',
        expectedRevision: revision,
        definition: { ...definition, instructions },
      });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.revision).toBe(revision + 1);
  }
  const revision = () => store.getActiveSymposiumConfig('discussion').revision;
  async function membership(seatId: string, action: string) {
    const result = await request(app)
      .post(`${base}/membership`)
      .send({
        seatId,
        action,
        expectedGeneration:
          store.getLatestSymposiumMembership('discussion', seatId)?.generation ?? 0,
        configRevision: revision(),
        reason: 'Explicit fixture operator action',
        idempotencyKey: `${action}-${seatId}-${revision()}-${calls.length}`,
        sharedBoundaryAcknowledged: true,
        crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT',
      });
    expect(result.status, result.text).toBe(200);
    expect(result.body.reconciliation).toBe('confirmed');
    return result.body;
  }
  function refreshAdmissions() {
    for (const seat of store.getActiveSymposiumConfig('discussion').seats) {
      if (store.getLatestSymposiumMembership('discussion', seat.id)?.state === 'active')
        runtime.recordProviderAdmission({
          sessionId: 'discussion',
          seatId: seat.id,
          decision: 'admitted',
          reason: 'Mock provider revalidation',
          idempotencyKey: `revalidate-${seat.id}-${revision()}`,
        });
    }
  }
  async function turn(key: string, recipients: string[], content: string, edited?: string) {
    const beforeCalls = calls.length;
    const staged = await request(app).post(`${base}/deliveries`).send({
      sourceSeatId: null,
      recipientSeatIds: recipients,
      originalContent: content,
      idempotencyKey: key,
    });
    expect(staged.status, staged.text).toBe(200);
    const delivery = staged.body.deliveryId;
    if (edited) {
      const edit = await request(app)
        .post(`${base}/deliveries/${delivery}/interventions`)
        .send({ action: 'edit', content: edited, idempotencyKey: `edit-${key}` });
      expect(edit.status, edit.text).toBe(200);
      expect(calls).toHaveLength(beforeCalls);
    }
    if (!edited) {
      expect(
        (
          await request(app)
            .post(`${base}/deliveries/${delivery}/interventions`)
            .send({ action: 'approve', idempotencyKey: `approve-${key}` })
        ).status,
      ).toBe(200);
    }
    const sent = await request(app).post(`${base}/deliveries/${delivery}/dispatch`).send({});
    expect(sent.status, sent.text).toBe(200);
    expect(store.getSymposiumDelivery(delivery)?.status).toBe('delivered');
    expect(calls.slice(beforeCalls).map((call) => call.content)).toEqual(
      recipients.map(() => edited ?? content),
    );
    return delivery;
  }
  try {
    await saveProfile(0, definition.instructions);
    const activated = await request(app)
      .post(`${base}/activate`)
      .send({
        expectedRevision: 1,
        sharedBoundaryAcknowledged: true,
        profileSelections: { reviewer: { profileId: 'evidence-reviewer', revision: 1 } },
      });
    expect(activated.status, activated.text).toBe(200);
    await membership('writer', 'admit');
    await membership('reviewer', 'admit');
    const first = await turn(
      'turn-1',
      ['writer', 'reviewer'],
      'Implement and review the approved parser change. Describe the saved reviewer profile and propose stronger reusable guidance.',
    );
    expect(calls.map((call) => call.seat.id)).toEqual(['writer', 'reviewer']);
    const oldReviewer = calls[1];
    // Updating portable catalog guidance does not mutate an active seat snapshot.
    expect(nativeProposalId).toBeTruthy();
    await saveProfile(
      1,
      'Review correctness, regression tests, and security boundaries.',
      nativeProposalId,
    );
    expect(store.getActiveSymposiumConfig('discussion').seats[1].systemPrompt).toBe(
      definition.instructions,
    );
    const revisionBody = {
      expectedRevision: revision(),
      seatId: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      systemPrompt: 'ignored in favor of saved profile',
      color: '#123456',
      accountId: 'work',
      model: 'fixture-model',
      profileSelection: { profileId: 'evidence-reviewer', revision: 2 },
      sharedBoundaryAcknowledged: true,
    };
    expect((await request(app).post(`${base}/seats/revise`).send(revisionBody)).status).toBe(409);
    await membership('reviewer', 'suspend');
    const revised = await request(app).post(`${base}/seats/revise`).send(revisionBody);
    expect(revised.status, revised.text).toBe(200);
    const restored = await membership('reviewer', 'restore');
    expect(restored.generation).toBeGreaterThan(oldReviewer.provenance.membershipGeneration!);
    refreshAdmissions();
    await turn(
      'turn-2',
      ['writer', 'reviewer'],
      'Check everything and ship immediately.',
      'Review the parser change and regression tests. Report evidence; do not deploy.',
    );
    expect(calls[3].seat.systemPrompt).toContain('security boundaries');
    expect(calls[3].seat.profileBinding).not.toEqual(oldReviewer.seat.profileBinding);
    await membership('reviewer', 'remove');
    const count = calls.length;
    const denied = await request(app)
      .post(`${base}/deliveries`)
      .send({
        sourceSeatId: null,
        recipientSeatIds: ['reviewer'],
        originalContent: 'removed must not receive',
        idempotencyKey: 'removed',
      });
    expect(denied.status).toBe(409);
    expect(calls).toHaveLength(count);
    const added = await request(app)
      .post(`${base}/seats/revise`)
      .send({
        ...revisionBody,
        expectedRevision: revision(),
        seatId: 'auditor',
        name: 'Auditor',
        accountId: 'second',
        crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT',
      });
    expect(added.status, added.text).toBe(200);
    const newMember = await membership('auditor', 'admit');
    expect(newMember.generation).toBe(1);
    refreshAdmissions();
    const third = await turn(
      'turn-3',
      ['writer', 'auditor'],
      'Confirm the revised parser meets the saved acceptance criteria and identify remaining risks.',
    );
    expect(calls.at(-1)?.seat.accountBinding?.accountId).toBe('second');
    expect(calls.filter((call) => call.seat.id === 'reviewer')).toHaveLength(2);
    const aside =
      'Auditor only: independently inspect the input validation boundary and report missing evidence.';
    const asideId = await turn('auditor-aside', ['auditor'], aside);
    expect(calls.at(-1)?.seat.id).toBe('auditor');
    expect(calls.filter((call) => call.seat.id === 'writer')).toHaveLength(3);
    expect(
      getSymposiumPerspective(store, 'discussion', { kind: 'seat', seatId: 'writer' }).items.some(
        (item) => item.kind === 'recipient-input' && item.deliveryId === asideId,
      ),
    ).toBe(false);
    const transcript = store.getSessionEvents('discussion');
    const perspective = getSymposiumPerspective(
      store,
      'discussion',
      { kind: 'all' },
      { afterSeq: 0, limit: 200 },
    );
    expect(perspective.items.filter((item) => item.kind === 'recipient-input')).toHaveLength(7);
    grants.close();
    catalog.close();
    proposals.close();
    store.close();
    store = new EventStore(db);
    catalog = new SymposiumProfileStore(db);
    proposals = new SymposiumProfileProposalStore(db);
    grants = makeGrants();
    runtime = makeRuntime();
    expect(runtime.recover()).toEqual([]);
    expect(store.getSessionEvents('discussion')).toEqual(transcript);
    expect(
      getSymposiumPerspective(store, 'discussion', { kind: 'all' }, { afterSeq: 0, limit: 200 }),
    ).toEqual(perspective);
    expect(catalog.get('user', 'evidence-reviewer', 2)?.definition.instructions).toContain(
      'security boundaries',
    );
    expect(catalog.get('user', 'evidence-reviewer', 1)?.definition.instructions).toBe(
      definition.instructions,
    );
    expect(store.getLatestSymposiumMembership('discussion', 'reviewer')?.state).toBe('removed');
    expect(store.getSymposiumDelivery(first)?.status).toBe('delivered');
    expect(store.getSymposiumDelivery(third)?.status).toBe('delivered');
    expect(calls).toHaveLength(7);
  } finally {
    conversations.close();
    grants.close();
    catalog.close();
    proposals.close();
    store.close();
  }
});
