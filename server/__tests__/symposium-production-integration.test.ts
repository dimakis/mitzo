import { installedVertexStatus } from './fixtures/vertex-policy-status.js';
import { createClaudeVertexSeat } from '../symposium-claude-native.js';
import { SqliteArtifactLeaseHost } from '../symposium-artifact-host.js';
import Database from 'better-sqlite3';
import { OpenShellRuntimeManager } from '../openshell-runtime.js';
import { createOwnedSeatPolicySelector } from '../symposium-owned-seat-policy.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  AccountBindingSchema,
  storedEventToClientMessage,
  type SymposiumConfig,
} from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { CodexSessionEvents } from '../codex-session-events.js';
import { AccountProfiles } from '../account-profiles.js';
import { createSymposiumSessionRuntime } from '../symposium-session-runtime.js';
import { createSymposiumDirectorRouter } from '../symposium-director-routes.js';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';
import { SymposiumNativeEventSink } from '../symposium-native-event-sink.js';
import { getSymposiumPerspective, getSymposiumQueuedInputs } from '../symposium-perspectives.js';
import { SymposiumAttemptRegistry } from '../symposium-attempt-registry.js';
import {
  createChatGptSubscriptionSeat,
  SYMPOSIUM_SUBSCRIPTION_CONTROLLER_COMMAND,
} from '../symposium-subscription-native.js';
import { symposiumSeatSystemPrompt } from '../symposium-seat-prompt.js';

const profiles = new AccountProfiles([
  {
    id: 'work-api',
    label: 'Work API',
    provider: 'openai',
    credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
    sandboxProvider: 'openai-work',
    sandboxProviderId: 'object-1',
    models: [{ id: 'gpt-test', label: 'Test' }],
  },
]);
const accountBinding = AccountBindingSchema.parse(profiles.resolve('work-api', 'gpt-test'));
const seat = {
  id: 'builder',
  name: 'Builder',
  role: 'implementer',
  model: 'gpt-test',
  systemPrompt: 'Build only the requested patch.',
  expectedOutput: 'A focused patch and test result',
  acceptanceCriteria: ['The focused tests pass', 'Explain remaining risks'],
  color: '#224466',
  accountBinding,
  profileBinding: { profileId: 'builder', profileRevision: '1' },
  contextGrant: {
    grantId: 'context',
    revision: 1,
    classification: 'work' as const,
    sourceRefs: ['session:symposium'],
  },
  authorityGrant: {
    grantId: 'authority',
    revision: 1,
    filesystem: 'write' as const,
    tools: 'write' as const,
    network: 'restricted' as const,
  },
  isolationRequest: {
    trustDomainId: 'shared',
    revision: 1,
    placement: 'reuse-compatible' as const,
  },
} satisfies SymposiumConfig['seats'][number];
const config: SymposiumConfig = {
  version: 2,
  revision: 1,
  state: 'active',
  anchorSeatId: 'anchor',
  activeSeatCap: 2,
  seats: [{ ...seat, id: 'anchor', name: 'Anchor' }, seat],
  turnRules: { mode: 'directed', maxTurns: 4 },
  interceptMode: 'manual',
};
const runtimeConfig = {
  cli: 'openshell',
  cliContract: 'v0.1' as const,
  image: 'test-image',
  policy: '/policy',
  seed: '/seed',
  serviceProviders: [],
  grantableServiceProviders: [],
  workspace: 'default',
  gateway: 'openshell',
  gatewayInsecure: false,
  createDetached: true,
  sandboxIdLength: 13,
  workdir: '/sandbox/workspaces/mgmt',
  webSearch: 'disabled' as const,
};

describe('production Symposium route to native runtime', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('does not admit a seat whose physical provider is absent from the host attestation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-symposium-unattested-provider-'));
    roots.push(root);
    const store = new EventStore(join(root, 'events.db'));
    store.upsertSession({ sessionId: 'symposium', accountBinding: seat.accountBinding });
    store.setSymposiumConfig('symposium', config);
    const managerFactory = vi.fn(() => ({
      ensure: async () => {
        throw new Error('Sandbox must not be created');
      },
    }));
    const runtime = createSymposiumSessionRuntime({
      sessionId: 'symposium',
      store,
      profiles,
      hostGrants: { verifySeat: vi.fn() },
      codexStore: {} as never,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig,
      perSeatSandboxVerified: true,
      allowedSeatRoles: new Set(['implementer']),
      allowedAccountProviders: new Set(['openai']),
      verifyHostCapability: () => ({ attestedProviderInstances: new Map() }),
      readOnlyEnforced: { openaiApi: false, claudeVertex: false },
      recordAccepted: vi.fn(() => true),
      managerFactory,
    });
    const membership = await runtime.orchestrator.transitionMembership({
      sessionId: 'symposium',
      seatId: 'builder',
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 1,
      actor: 'owner',
      reason: 'Approved',
      idempotencyKey: 'unattested-provider',
    });
    expect(membership.reconciliation).toBe('recovery_required');
    expect(store.getLatestSymposiumAdmission('symposium', 'builder', 1)).toBeUndefined();
    expect(managerFactory).not.toHaveBeenCalled();
  });

  it('quarantines an API seat when its pinned physical provider is codex typed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-symposium-provider-type-'));
    roots.push(root);
    const store = new EventStore(join(root, 'events.db'));
    store.upsertSession({ sessionId: 'symposium', accountBinding: seat.accountBinding });
    store.setSymposiumConfig('symposium', config);
    const runtime = createSymposiumSessionRuntime({
      sessionId: 'symposium',
      store,
      profiles,
      hostGrants: { verifySeat: vi.fn() },
      codexStore: {} as never,
      resolveProviderIdentity: (name, id) => ({
        name,
        id,
        type: 'codex',
        workspace: 'default',
      }),
      runtimeConfig,
      perSeatSandboxVerified: true,
      readOnlyEnforced: { openaiApi: false, claudeVertex: false },
      recordAccepted: vi.fn(() => true),
      managerFactory: () => ({
        ensure: async () => {
          throw new Error('Provider mismatch must not attach a sandbox');
        },
      }),
    });
    const membership = await runtime.orchestrator.transitionMembership({
      sessionId: 'symposium',
      seatId: 'builder',
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 1,
      actor: 'owner',
      reason: 'Approved',
      idempotencyKey: 'wrong-provider-type',
    });
    expect(membership.reconciliation).toBe('recovery_required');
    expect(store.getLatestSymposiumAdmission('symposium', 'builder', 1)).toBeUndefined();
  });

  const sinkModes = ['explicit', 'default', 'durable-only'] as const;
  it.each(sinkModes)('persists with %s sink', async (sinkMode) => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-symposium-native-'));
    roots.push(root);
    const store = new EventStore(join(root, 'events.db'));
    store.upsertSession({ sessionId: 'symposium', accountBinding: seat.accountBinding });
    store.setSymposiumConfig('symposium', config);
    const verifySeat = vi.fn();
    const broadcast = vi.fn();
    const events = new SymposiumNativeEventSink(store, broadcast);
    const accepted = vi.fn((receipt: Parameters<EventStore['markSymposiumRecipientAccepted']>[0]) =>
      store.markSymposiumRecipientAccepted(receipt),
    );
    const sent: string[] = [];
    let emitLateToolResult: (() => void) | undefined;
    let emitLateMessage: (() => void) | undefined;
    let rejectHeld: ((error: Error) => void) | undefined;
    const cancellations = vi.fn(async () => {
      rejectHeld?.(new Error('native turn stopped'));
    });
    const sandboxName = 'symposium-builder-generation-1';
    const physicalId = 'physical-sandbox-builder-1';
    let sandboxPhase = 'Ready';
    const ensure = vi.fn(async () => ({
      sandboxName,
      sandboxId: physicalId,
      workdir: runtimeConfig.workdir,
    }));
    const stop = vi.fn(async (_runtimeId: string, observedPhysicalId: string) => {
      expect(observedPhysicalId).toBe(physicalId);
      sandboxPhase = 'Stopped';
    });
    const runtime = createSymposiumSessionRuntime({
      sessionId: 'symposium',
      store,
      profiles,
      hostGrants: { verifySeat },
      verifyHostCapability: () => ({
        attestedProviderInstances: new Map([
          [
            'openai-work',
            { id: 'object-1', type: 'openai', profileName: 'openai', workspace: 'default' },
          ],
        ]),
      }),
      codexStore: {} as never,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig,
      perSeatSandboxVerified: true,
      readOnlyEnforced: { openaiApi: false, claudeVertex: false },
      recordAccepted: accepted,
      ...(sinkMode === 'explicit'
        ? {
            recordEvent: (execution: SymposiumSeatExecution, event: Record<string, unknown>) =>
              events.record(execution, event),
          }
        : sinkMode === 'default'
          ? { broadcastEvent: broadcast }
          : {}),
      managerFactory: () => ({
        ensure,
        inspectReserved: async () => ({ id: physicalId, name: sandboxName, phase: sandboxPhase }),
        inspect: async (_runtimeId: string, observedPhysicalId: string) => {
          expect(observedPhysicalId).toBe(physicalId);
          return { id: physicalId, phase: sandboxPhase };
        },
        stop,
      }),
      openNative: async ({ execution, onEvent }) => ({
        run: async (_input, callbacks) => {
          callbacks.beforeDispatch();
          if (execution.content.startsWith('Fail ')) {
            const acceptedFailure = execution.content === 'Fail after accepted';
            if (acceptedFailure) callbacks.accepted('thread-1', 'turn-failed');
            const messageId = acceptedFailure ? 'failed-message' : 'unaccepted-message';
            const start = {
              type: 'stream_event',
              event: { type: 'message_start', message: { id: messageId } },
            };
            onEvent?.(start);
            onEvent?.({
              type: 'stream_event',
              event: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: 'Incomplete output' },
              },
            });
            emitLateMessage = () => onEvent?.(start);
            throw new Error('Native transport failed');
          }
          if (execution.content === 'Hold until cancelled') {
            callbacks.accepted('thread-1', 'turn-held');
            onEvent?.({
              type: 'stream_event',
              event: { type: 'message_start', message: { id: 'cancelled-message' } },
            });
            onEvent?.({
              type: 'stream_event',
              event: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: 'Partial output' },
              },
            });
            onEvent?.({
              type: 'stream_event',
              event: {
                type: 'content_block_start',
                index: 1,
                content_block: {
                  type: 'tool_use',
                  id: 'cancelled-tool',
                  name: 'Read',
                  input: { path: 'README.md' },
                },
              },
            });
            await new Promise<never>((_resolve, reject) => {
              rejectHeld = reject;
            });
          }
          for (const invalid of [
            { ...execution, claimToken: 'wrong-claim' },
            { ...execution, sessionId: 'wrong-session' },
            { ...execution, deliveryId: 'wrong-delivery' },
            { ...execution, seat: { ...execution.seat, id: 'wrong-seat' } },
            { ...execution, provenance: { ...execution.provenance, membershipGeneration: 999 } },
          ])
            events.record(invalid, {
              type: 'stream_event',
              event: { type: 'message_start', message: { id: 'wrong-identity' } },
            });
          onEvent?.({
            type: 'stream_event',
            event: { type: 'message_start', message: { id: 'provider-message' } },
          });
          onEvent?.({
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: 'Consider tests' },
            },
          });
          onEvent?.({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
          onEvent?.({
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'text', text: 'Patch ' },
            },
          });
          onEvent?.({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'text_delta', text: 'complete' },
            },
          });
          onEvent?.({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
          onEvent?.({ type: 'stream_event', event: { type: 'message_stop' } });
          onEvent?.({ type: 'stream_event', event: { type: 'message_stop' } });
          expect(
            store.getSessionEvents('symposium').some((event) => event.type === 'message_start'),
          ).toBe(false);
          expect(broadcast).not.toHaveBeenCalled();
          callbacks.accepted('thread-1', 'turn-1');
          const replayed = store
            .getSessionEvents('symposium')
            .filter((event) =>
              ['message_start', 'block_start', 'block_delta', 'block_end', 'message_end'].includes(
                event.type,
              ),
            );
          expect(replayed.map((event) => event.type)).toEqual([
            'message_start',
            'block_start',
            'block_delta',
            'block_end',
            'block_start',
            'block_delta',
            'block_delta',
            'block_end',
            'message_end',
          ]);
          expect(replayed.every((event) => event.payload.messageId === 'provider-message')).toBe(
            true,
          );
          sent.push(execution.content);
          onEvent?.({
            type: 'stream_event',
            event: { type: 'message_start', message: { id: 'tool-message' } },
          });
          onEvent?.({
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Read',
                input: { path: 'README.md' },
              },
            },
          });
          events.record(
            { ...execution, deliveryId: 'wrong-delivery' },
            { type: 'symposium_attempt_released' },
          );
          onEvent?.({
            type: 'progress',
            parentBlockId: 'tool-message:0',
            items: [{ title: 'Read file' }],
          });
          onEvent?.({
            type: 'subagent_start',
            parentBlockId: 'tool-message:0',
            subagentMessageId: 'child-1',
          });
          onEvent?.({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
          onEvent?.({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 'tool-1' }] },
          });
          onEvent?.({
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-1',
                  content: [{ type: 'text', text: 'file contents' }],
                  is_error: false,
                },
              ],
            },
          });
          let mappedMessageId = '';
          const mapper = new CodexSessionEvents('private-seat', 'thread-1', 'gpt-test', (event) => {
            if (event.type === 'stream_event') {
              const mapped = event.event as { type?: string; message?: { id?: string } };
              if (mapped.type === 'message_start') mappedMessageId = mapped.message?.id ?? '';
            }
            onEvent?.(event);
          });
          // The actual mapper emits input:{} followed by input_json_delta.
          const mappedToolId = mapper.toolStart('provider-call', 'Read', { path: 'README.md' });
          onEvent?.({
            type: 'stream_event',
            event: { type: 'message_start', message: { id: 'new-after-tool' } },
          });
          // A delayed identity-bearing summary for the prior message must not end this one.
          onEvent?.({ type: 'assistant', message: { id: mappedMessageId, content: [] } });
          onEvent?.({
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: 'Current survives' },
            },
          });
          onEvent?.({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
          onEvent?.({ type: 'assistant', message: { id: 'new-after-tool', content: [] } });
          emitLateToolResult = () => mapper.toolResult(mappedToolId, 'late file contents', false);
          emitLateMessage = () =>
            onEvent?.({
              type: 'stream_event',
              event: { type: 'message_start', message: { id: 'too-late' } },
            });
          // A completed early request is not proof of this turn's final usage.
          const usageMapper = new CodexSessionEvents(
            'private-seat',
            'thread-1',
            'gpt-test',
            (event) => onEvent?.(event),
            { freshThread: true },
          );
          usageMapper.notification('turn/started', {
            threadId: 'thread-1',
            turn: { id: 'turn-1' },
          });
          const usageUpdate = (inputTokens: number) =>
            usageMapper.notification('thread/tokenUsage/updated', {
              threadId: 'thread-1',
              turnId: 'turn-1',
              tokenUsage: {
                total: {
                  inputTokens,
                  cachedInputTokens: 0,
                  outputTokens: 10,
                  reasoningOutputTokens: 0,
                  totalTokens: inputTokens + 10,
                },
              },
            });
          usageUpdate(100);
          usageMapper.notification('turn/completed', {
            threadId: 'thread-1',
            turn: { id: 'turn-1', status: 'completed' },
          });
          usageUpdate(200); // final provider update arrives after the durable end
          return { providerThreadId: 'thread-1', content: 'Patch complete' };
        },
        cancel: cancellations,
      }),
    });
    const app = express();
    app.use(express.json());
    app.use(
      '/api/sessions/:id/symposium',
      createSymposiumDirectorRouter({
        store,
        getRuntime: () => runtime.orchestrator,
        getSafetyOrchestrator: () => runtime.orchestrator,
        profileBindingEnforced: true,
        validateSelection: () => undefined,
        validateActiveConfig: () => undefined,
        activateDraft: () => {
          throw new Error('not used');
        },
        reviseSeat: () => {
          throw new Error('not used');
        },
        getPerspective: (id, perspective, options) =>
          getSymposiumPerspective(store, id, perspective, options),
        getQueuedInputs: (id, perspective) => getSymposiumQueuedInputs(store, id, perspective),
        resolveSelection: () => accountBinding,
      }),
    );
    const base = '/api/sessions/symposium/symposium';
    const admission = await request(app).post(`${base}/membership`).send({
      seatId: 'builder',
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 1,
      reason: 'Approved',
      idempotencyKey: 'admit-builder',
      sharedBoundaryAcknowledged: true,
    });
    expect(admission.status).toBe(200);
    expect(admission.body.reconciliation).toBe('confirmed');
    expect(store.getLatestSymposiumAdmission('symposium', 'builder', 1)?.decision).toBe('admitted');
    expect(ensure).toHaveBeenCalledTimes(1);
    const reserved = store.getSymposiumSeatSandbox('symposium', 'builder', 1);
    expect(reserved).toMatchObject({ sandboxName, physicalId, state: 'ready' });
    // Exercise the production admission callback after adding a roster entry:
    // confirmed retained members must be admitted at the new revision without
    // changing their generation or weakening candidate membership validation.
    const retained = store.getLatestSymposiumMembership('symposium', 'builder');
    store.setSymposiumConfig('symposium', {
      ...config,
      revision: 2,
      seats: [...config.seats, { ...seat, id: 'new-reviewer' }],
    });
    expect(store.getLatestSymposiumAdmission('symposium', 'builder', 2)).toBeUndefined();
    const refreshed = await request(app)
      .post(`${base}/admissions/refresh`)
      .send({ expectedRevision: 2 });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.seatIds).toEqual(['builder']);
    expect(store.getLatestSymposiumMembership('symposium', 'builder')).toEqual(retained);
    expect(store.getLatestSymposiumAdmission('symposium', 'builder', 2)?.decision).toBe('admitted');
    expect(ensure).toHaveBeenCalledTimes(1);
    const staged = await request(app)
      .post(`${base}/deliveries`)
      .send({
        sourceSeatId: null,
        recipientSeatIds: ['builder'],
        originalContent: 'Implement the patch',
        idempotencyKey: 'dispatch-one',
      });
    expect(staged.status).toBe(200);
    const id = staged.body.deliveryId as string;
    const approval = await request(app).post(`${base}/deliveries/${id}/interventions`).send({
      action: 'approve',
      idempotencyKey: 'approve-one',
    });
    expect(approval.status).toBe(200);
    const dispatched = await request(app).post(`${base}/deliveries/${id}/dispatch`).send({});
    expect(dispatched.status).toBe(200);
    await vi.waitFor(() => expect(sent).toEqual(['Implement the patch']));
    emitLateToolResult?.();
    emitLateMessage?.();
    expect(sent).toEqual(['Implement the patch']);
    expect(accepted).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: id,
        seatId: 'builder',
        providerThreadId: 'thread-1',
        providerTurnId: 'turn-1',
      }),
    );
    const attempt = store.getSymposiumRecipientAttemptByClaimToken(
      accepted.mock.calls[0][0].claimToken,
    );
    expect(attempt?.acceptedAt).not.toBeNull();
    const authored = store
      .getSessionEvents('symposium')
      .filter((event) => ['message_start', 'block_delta', 'message_end'].includes(event.type));
    expect(authored.filter((event) => event.type === 'message_start')).toHaveLength(4);
    expect(authored.filter((event) => event.type === 'message_end')).toHaveLength(4);
    expect(authored.some((event) => event.payload.messageId === 'too-late')).toBe(false);
    expect(
      authored.some(
        (event) => event.type === 'block_delta' && event.payload.delta === 'Current survives',
      ),
    ).toBe(true);
    expect(
      authored.every(
        (event) =>
          event.seatId === 'builder' && event.symposiumProvenance?.membershipGeneration === 1,
      ),
    ).toBe(true);
    if (sinkMode === 'durable-only') expect(broadcast).not.toHaveBeenCalled();
    else
      expect(broadcast).toHaveBeenCalledWith(
        'symposium',
        expect.objectContaining({ type: 'block_delta', delta: 'complete', seatId: 'builder' }),
      );
    const rich = store.getSessionEvents('symposium');
    expect(
      rich.some(
        (event) =>
          event.type === 'block_end' &&
          event.payload.toolId === 'tool-1' &&
          event.payload.input === '{"path":"README.md"}',
      ),
    ).toBe(true);
    expect(
      rich.some(
        (event) =>
          event.type === 'tool_result' && String(event.payload.result).includes('file contents'),
      ),
    ).toBe(true);
    expect(
      rich.some(
        (event) =>
          event.type === 'block_end' &&
          event.payload.toolId !== 'tool-1' &&
          event.payload.input === '{"path":"README.md"}' &&
          (event.payload.rawInput as { path?: string })?.path === 'README.md',
      ),
    ).toBe(true);
    expect(
      rich.some(
        (event) => event.type === 'tool_result' && event.payload.result === 'late file contents',
      ),
    ).toBe(true);
    expect(
      rich.some(
        (event) =>
          event.type === 'subagent_start' && event.payload.parentBlockId === 'tool-message:0',
      ),
    ).toBe(true);
    expect(rich.some((event) => event.type === 'progress')).toBe(true);
    expect(store.getLatestSymposiumMembership('symposium', 'builder')?.state).toBe('active');
    expect(cancellations).not.toHaveBeenCalled();
    const held = await request(app)
      .post(`${base}/deliveries`)
      .send({
        sourceSeatId: null,
        recipientSeatIds: ['builder'],
        originalContent: 'Hold until cancelled',
        idempotencyKey: 'dispatch-held',
      });
    const heldId = held.body.deliveryId as string;
    expect(
      (
        await request(app).post(`${base}/deliveries/${heldId}/interventions`).send({
          action: 'approve',
          idempotencyKey: 'approve-held',
        })
      ).status,
    ).toBe(200);
    const pendingDispatch = request(app)
      .post(`${base}/deliveries/${heldId}/dispatch`)
      .send({})
      .then((response) => response);
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(2));
    const cancellation = await request(app).post(`${base}/deliveries/${heldId}/cancel`).send({
      reason: 'Director stopped this input',
      idempotencyKey: 'cancel-held',
    });
    expect(cancellation.status).toBe(200);
    expect(cancellations).toHaveBeenCalledTimes(1);
    await pendingDispatch;
    expect(store.getUnsettledSymposiumExecutions(heldId)).toEqual([]);
    const cancelledEvents = store
      .getSessionEvents('symposium')
      .filter((event) => event.payload.messageId === 'cancelled-message');
    expect(cancelledEvents.filter((event) => event.type === 'block_end')).toHaveLength(2);
    expect(cancelledEvents.filter((event) => event.type === 'message_end')).toHaveLength(1);
    expect(
      cancelledEvents.find(
        (event) => event.type === 'block_end' && event.payload.toolId === 'cancelled-tool',
      )?.payload.input,
    ).toBe('{"path":"README.md"}');
    expect(store.getSymposiumDelivery(heldId)?.status).toBe('cancelled');
    expect(
      store
        .getSessionEvents('symposium')
        .filter((event) => event.type === 'provider_turn_end' && event.payload.isError === false),
    ).toHaveLength(1);
    expect(
      store
        .getSessionEvents('symposium')
        .some((event) => event.payload.messageId === 'wrong-identity'),
    ).toBe(false);
    const terminalUsage = store
      .getSessionEvents('symposium')
      .find((event) => event.type === 'provider_turn_end' && event.payload.isError === false)!;
    expect(terminalUsage.payload.usage_status).toBe('unknown');
    expect(terminalUsage.payload).not.toHaveProperty('usage');
    expect(storedEventToClientMessage(terminalUsage)).toMatchObject({
      type: 'provider_turn_end',
      usage_status: 'unknown',
      seatId: 'builder',
    });
    expect(storedEventToClientMessage(terminalUsage)).not.toHaveProperty('usage');
    for (const content of ['Fail before accepted', 'Fail after accepted']) {
      const failed = runtime.orchestrator.stageDelivery({
        sessionId: 'symposium',
        sourceSeatId: null,
        recipientSeatIds: ['builder'],
        originalContent: content,
        idempotencyKey: content,
      });
      runtime.orchestrator.intervene({
        deliveryId: failed.deliveryId,
        action: 'approve',
        idempotencyKey: `approve-${content}`,
      });
      const result = await runtime.orchestrator.deliver(failed.deliveryId);
      expect(result.status).toBe('failed');
      emitLateMessage?.();
    }
    const failureEvents = store.getSessionEvents('symposium');
    expect(failureEvents.some((event) => event.payload.messageId === 'unaccepted-message')).toBe(
      false,
    );
    expect(
      failureEvents.filter(
        (event) => event.type === 'message_start' && event.payload.messageId === 'failed-message',
      ),
    ).toHaveLength(1);
    expect(
      failureEvents.filter(
        (event) => event.type === 'block_end' && event.payload.messageId === 'failed-message',
      ),
    ).toHaveLength(1);
    expect(
      failureEvents.filter(
        (event) => event.type === 'message_end' && event.payload.messageId === 'failed-message',
      ),
    ).toHaveLength(1);
    expect(
      failureEvents.filter(
        (event) => event.type === 'provider_turn_end' && event.payload.isError === false,
      ),
    ).toHaveLength(1);
    const revoked = await request(app).post(`${base}/membership`).send({
      seatId: 'builder',
      action: 'suspend',
      expectedGeneration: 1,
      configRevision: 2,
      reason: 'Stop after cancellation',
      idempotencyKey: 'suspend-builder-after-cancel',
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.reconciliation).toBe('confirmed');
    expect(stop).toHaveBeenCalledExactlyOnceWith(
      reserved!.runtimeId,
      physicalId,
      expect.any(AbortSignal),
    );
    expect(store.getSymposiumSeatSandbox('symposium', 'builder', 1)?.state).toBe('stopped');
    store.close();
  });

  it.each(['api', 'subscription'] as const)(
    'closes only the recovered %s claim transcript after reopening both durable stores',
    async (accountKind) => {
      const nativeSubscription = accountKind === 'subscription';
      const restartProfiles = nativeSubscription
        ? new AccountProfiles(
            [
              {
                id: 'personal',
                label: 'Personal',
                provider: 'openai-codex',
                email: 'personal@example.test',
                planType: 'plus',
                nativeAuth: 'sandbox-chatgpt',
                sandboxProvider: 'personal-codex',
                sandboxProviderId: 'personal-provider',
                sandboxProviderType: 'codex',
                models: [{ id: 'gpt-6-luna', label: 'Luna' }],
              },
            ],
            { codexEnabled: true },
          )
        : profiles;
      const restartBinding = nativeSubscription
        ? AccountBindingSchema.parse(restartProfiles.resolve('personal', 'gpt-6-luna'))
        : seat.accountBinding;
      const restartConfig = {
        ...config,
        seats: config.seats.map((entry) => ({
          ...entry,
          accountBinding: restartBinding,
          model: restartBinding.model,
        })),
      };
      const root = mkdtempSync(join(tmpdir(), 'mitzo-restart-transcript-'));
      chmodSync(root, 0o700);
      roots.push(root);
      const path = join(root, 'events.db');
      const claimsPath = join(root, 'claims.db');
      let store = new EventStore(path);
      const confirm = vi
        .fn()
        .mockRejectedValueOnce(new Error('remote still running'))
        .mockResolvedValue(undefined);
      const transport = { launch: vi.fn() as never, confirm };
      let registry = new SymposiumAttemptRegistry(claimsPath, transport);
      store.upsertSession({ sessionId: 'symposium', accountBinding: restartBinding });
      store.setSymposiumConfig('symposium', restartConfig);
      let dispatched: SymposiumSeatExecution | undefined;
      const broadcast = vi.fn();
      const makeRuntime = () =>
        createSymposiumSessionRuntime({
          sessionId: 'symposium',
          store,
          profiles: restartProfiles,
          verifiedSubscriptionControllerCommand: SYMPOSIUM_SUBSCRIPTION_CONTROLLER_COMMAND,
          verifySubscriptionPrivateAuth: async () => undefined,
          attemptRegistry: registry,
          hostGrants: { verifySeat: vi.fn() },
          codexStore: {} as never,
          resolveProviderIdentity: (name, id) => ({
            name,
            id,
            type: nativeSubscription ? 'codex' : 'openai',
            workspace: 'default',
          }),
          runtimeConfig,
          perSeatSandboxVerified: true,
          readOnlyEnforced: { openaiApi: false, claudeVertex: false },
          recordAccepted: (receipt) => store.markSymposiumRecipientAccepted(receipt),
          broadcastEvent: broadcast,
          managerFactory: () => ({
            ensure: async () => ({
              sandboxName: 'seat-builder',
              sandboxId: 'physical-builder',
              workdir: runtimeConfig.workdir,
            }),
            inspect: async (_runtimeId, physicalId) => ({ id: physicalId, phase: 'Ready' }),
            inspectReserved: async () => ({
              name: 'seat-builder',
              id: 'physical-builder',
              phase: 'Ready',
            }),
          }),
          openNative: async (input) => {
            const { execution, onEvent } = input;
            if (nativeSubscription)
              return createChatGptSubscriptionSeat({
                ...input,
                store: {} as never,
                verifyPrivateAuth: async () => undefined,
                createConversation: (opts) => ({
                  initialize: async () => {
                    await opts.verifyBinding!(
                      {
                        initialize: async () => undefined,
                        close: () => undefined,
                        request: async (method) =>
                          method === 'model/list'
                            ? { data: [{ model: 'gpt-6-luna', displayName: 'Luna' }] }
                            : { account: { type: 'chatgpt' } },
                      },
                      execution.seat.accountBinding,
                    );
                  },
                  getThreadId: () => 'thread-1',
                  send: async (command) => {
                    opts.onProviderDispatch!(command.id);
                    registry.reserve({ ...execution, sandbox: input.sandbox });
                    opts.onProviderAccepted!(command.id, 'thread-1', 'turn-restart');
                    for (const event of [
                      { type: 'message_start', message: { id: 'restart-message' } },
                      {
                        type: 'content_block_start',
                        index: 0,
                        content_block: {
                          type: 'tool_use',
                          id: 'restart-tool',
                          name: 'Read',
                          input: {},
                        },
                      },
                      {
                        type: 'content_block_delta',
                        index: 0,
                        delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' },
                      },
                      {
                        type: 'content_block_start',
                        index: 1,
                        content_block: { type: 'text', text: 'Partial' },
                      },
                    ])
                      opts.emit({ type: 'stream_event', event });
                    dispatched = execution;
                  },
                  interrupt: async () => {
                    throw new Error('Old in-memory native must not be used');
                  },
                  close: () => undefined,
                }),
              });
            return {
              run: async (_input, callbacks) => {
                callbacks.beforeDispatch();
                registry.reserve({
                  ...execution,
                  sandbox: {
                    sandboxName: 'seat-builder',
                    workdir: runtimeConfig.workdir,
                    cli: runtimeConfig.cli,
                    gateway: runtimeConfig.gateway,
                    workspace: runtimeConfig.workspace,
                    gatewayInsecure: runtimeConfig.gatewayInsecure,
                  },
                });
                callbacks.accepted('thread-1', 'turn-restart');
                onEvent?.({
                  type: 'stream_event',
                  event: { type: 'message_start', message: { id: 'restart-message' } },
                });
                onEvent?.({
                  type: 'stream_event',
                  event: {
                    type: 'content_block_start',
                    index: 0,
                    content_block: {
                      type: 'tool_use',
                      id: 'restart-tool',
                      name: 'Read',
                      input: {},
                    },
                  },
                });
                onEvent?.({
                  type: 'stream_event',
                  event: {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' },
                  },
                });
                onEvent?.({
                  type: 'stream_event',
                  event: {
                    type: 'content_block_start',
                    index: 1,
                    content_block: { type: 'text', text: 'Partial' },
                  },
                });
                dispatched = execution;
                return new Promise(() => {});
              },
              cancel: async () => {
                throw new Error('Old in-memory native must not be used');
              },
            };
          },
        });
      const runtime = makeRuntime();
      await runtime.orchestrator.transitionMembership({
        sessionId: 'symposium',
        seatId: 'builder',
        action: 'admit',
        expectedGeneration: 0,
        configRevision: 1,
        actor: 'owner',
        reason: 'Approved',
        idempotencyKey: 'admit-restart',
      });
      const delivery = runtime.orchestrator.stageDelivery({
        sessionId: 'symposium',
        sourceSeatId: null,
        recipientSeatIds: ['builder'],
        originalContent: 'Hold',
        idempotencyKey: 'stage-restart',
      });
      runtime.orchestrator.intervene({
        deliveryId: delivery.deliveryId,
        action: 'approve',
        idempotencyKey: 'approve-restart',
      });
      void runtime.orchestrator.deliver(delivery.deliveryId);
      await vi.waitFor(() => expect(dispatched).toBeDefined());
      const execution = dispatched!;
      expect(execution.seat.accountBinding?.provider).toBe(
        nativeSubscription ? 'openai-codex' : 'openai',
      );
      store.appendSymposium(
        'symposium',
        'message_start',
        { messageId: 'different-claim', nativeClaimToken: 'another-claim' },
        execution.provenance,
      );
      const durableBeforeRestart = store.getSessionEvents('symposium');
      expect(durableBeforeRestart.some((event) => event.type === 'block_start')).toBe(true);
      expect(broadcast).toHaveBeenCalled();
      store.close();
      registry.close();
      store = new EventStore(path);
      expect(store.getSessionEvents('symposium')).toEqual(durableBeforeRestart);
      registry = new SymposiumAttemptRegistry(claimsPath, transport);
      const restarted = makeRuntime();
      const cancel = () =>
        restarted.orchestrator.cancel({
          deliveryId: delivery.deliveryId,
          reason: 'stop',
          idempotencyKey: 'cancel-restart',
        });
      await cancel();
      expect(
        store.getSessionEvents('symposium').filter((event) => event.type === 'message_end'),
      ).toHaveLength(0);
      // A previous cleanup may have persisted one block end before the host died.
      store.appendSymposium(
        'symposium',
        'block_end',
        {
          messageId: 'restart-message',
          blockId: 'restart-message:1',
          blockType: 'text',
          nativeClaimToken: execution.claimToken,
        },
        execution.provenance,
      );
      // Recovery must use the accepted historical snapshot, not today's configuration.
      store.setSymposiumConfig('symposium', { ...restartConfig, revision: 2 });
      await cancel();
      const endings = store
        .getSessionEvents('symposium')
        .filter((event) => ['block_end', 'message_end'].includes(event.type));
      expect(endings.map((event) => event.type)).toEqual(['block_end', 'block_end', 'message_end']);
      expect(endings[1].payload).toMatchObject({
        nativeClaimToken: execution.claimToken,
        messageId: 'restart-message',
        blockId: 'restart-message:0',
        toolId: 'restart-tool',
        toolName: 'Read',
        input: '{"path":"README.md"}',
        rawInput: { path: 'README.md' },
      });
      expect(
        endings.every(
          (event) =>
            JSON.stringify(event.symposiumProvenance) === JSON.stringify(execution.provenance),
        ),
      ).toBe(true);
      expect(
        store.getSessionEvents('symposium').some((event) => event.type === 'provider_turn_end'),
      ).toBe(false);
      const count = store.getSessionEvents('symposium').length;
      await cancel();
      expect(store.getSessionEvents('symposium')).toHaveLength(count);
      expect(store.getUnsettledSymposiumExecutions(delivery.deliveryId)).toEqual([]);
      store.close();
      registry.close();
    },
  );

  it.each(['count', 'bytes'])(
    'bounds pre-acceptance buffering by %s and discards overflowed output',
    (limit) => {
      const execution = {
        sessionId: 'symposium',
        deliveryId: 'delivery',
        claimToken: 'claim',
        seat,
        provenance: { membershipGeneration: 1 },
      } as SymposiumSeatExecution;
      const attempt = {
        deliveryId: 'delivery',
        seatId: seat.id,
        acceptedAt: null as number | null,
        status: 'executing',
        provenance: execution.provenance,
      };
      const append = vi.fn();
      const broadcast = vi.fn();
      const sink = new SymposiumNativeEventSink(
        {
          getSymposiumRecipientAttemptByClaimToken: () => attempt,
          getSymposiumDelivery: () => ({ sessionId: 'symposium' }),
          appendSymposium: append,
          closeSymposiumAttemptTranscript: () => [],
        } as unknown as EventStore,
        broadcast,
      );
      const start = {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'buffered-message' } },
      };
      sink.record(execution, start);
      if (limit === 'count') {
        for (let i = 1; i < 512; i++) sink.record(execution, { type: 'progress', value: i });
      }
      expect(() =>
        sink.record(execution, {
          type: 'progress',
          value: limit === 'bytes' ? 'x'.repeat(1_048_576) : 'overflow',
        }),
      ).toThrow('buffer exceeded');
      attempt.acceptedAt = Date.now();
      sink.record(execution, { type: 'symposium_attempt_accepted' });
      sink.record(execution, start);
      expect(append).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it('puts only the portable profile contract into native system context', () => {
    expect(symposiumSeatSystemPrompt(seat)).toBe(
      'Build only the requested patch.\n\nExpected output:\nA focused patch and test result\n\nAcceptance criteria:\n- The focused tests pass\n- Explain remaining risks',
    );
    expect(symposiumSeatSystemPrompt(seat)).not.toContain('session:symposium');
  });
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME } from '../symposium-owned-runtime-contract.js';
it.each([
  'valid',
  'effective-policy-mismatch',
  'policy-mutated-at-launch',
  'provider-mutated-at-launch',
])('runs real Claude manager and adapter through EventStore with %s policy', async (policyCase) => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-claude-runtime-'));
  chmodSync(root, 0o700);
  const model = 'claude-haiku-4-5@20251001';
  const vertexProfiles = new AccountProfiles([
    {
      id: 'work-vertex',
      label: 'Work Vertex',
      provider: 'anthropic-vertex',
      credentialRef: '/never-read-adc',
      projectId: 'project-1',
      region: 'global',
      sandboxProvider: 'vertex-work',
      sandboxProviderId: 'vertex-id',
      models: [{ id: model, label: 'Haiku' }],
    },
  ]);
  const binding = AccountBindingSchema.parse(vertexProfiles.resolve('work-vertex', model));
  const currentSeat = { ...seat, accountBinding: binding, model };
  const currentConfig = {
    ...config,
    turnRules: { ...config.turnRules, maxTurns: 8 },
    seats: [{ ...currentSeat, id: 'anchor' }, currentSeat],
  };
  const store = new EventStore(join(root, 'events.db'));
  store.upsertSession({ sessionId: 'symposium', accountBinding: binding });
  store.setSymposiumConfig('symposium', currentConfig);
  const commands: readonly string[][] = [];
  const prompts: string[] = [];
  let failModel = false;
  let failAssistant = false;
  let omitInit = false;
  let installedPolicyChanged = false;
  const registry = new SymposiumAttemptRegistry(join(root, 'attempts.db'), {
    launch: (_sandbox, _claim, _access, command) => {
      (commands as string[][]).push([...command]);
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      let prompt = '';
      child.stdin.on('data', (x) => (prompt += x.toString()));
      child.stdin.on('finish', () =>
        queueMicrotask(() => {
          prompts.push(prompt);
          const thread = command[command.indexOf('--session-id') + 1];
          const emit = (data: Record<string, unknown>) =>
            child.stdout.write(JSON.stringify({ session_id: thread, ...data }) + '\n');
          if (!omitInit)
            emit({ type: 'system', subtype: 'init', model: failModel ? 'wrong-model' : model });
          emit({
            type: 'stream_event',
            event: {
              type: 'message_start',
              message: { id: `turn-${prompts.length}`, model: 'claude-haiku-4-5-20251001' },
            },
          });
          emit({
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          });
          emit({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: `Reply ${prompts.length}` },
            },
          });
          emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
          emit({
            type: 'assistant',
            message: {
              id: `turn-${prompts.length}`,
              model: failAssistant ? 'wrong-model' : 'claude-haiku-4-5-20251001',
              content: [{ type: 'text', text: `Reply ${prompts.length}` }],
            },
          });
          emit({ type: 'result', is_error: false });
          child.emit('close', 0);
        }),
      );
      return { child: child as never, confirmStopped: async () => {} };
    },
    confirm: async () => {},
  });
  const receipt = {
    principal: 'work@example.test',
    accountId: 'work-vertex',
    provider: 'vertex-work',
    providerId: 'vertex-id',
    projectId: 'project-1',
    region: 'global' as const,
    model: 'claude-haiku-4-5@20251001' as const,
    workspace: 'default',
  };
  let providerCurrent = true;
  const basePolicy = join(root, 'base-policy.json');
  const baseBytes = JSON.stringify({
    version: 1,
    filesystem_policy: { include_workdir: true, read_only: ['/usr'], read_write: ['/sandbox'] },
    landlock: { compatibility: 'best_effort' },
    network_policies: { codex: {} },
  });
  writeFileSync(basePolicy, baseBytes, { mode: 0o600 });
  let derivedPath = '';
  let created:
    | {
        name: string;
        id: string;
        workspace: string;
        phase: string;
        labels: Record<string, string>;
      }
    | undefined;
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  const boxes = new Map<string, NonNullable<typeof created>>();
  const policies = new Map<string, string>();
  const managerCommands: readonly string[][] = [];
  const resolveSeatPolicy = createOwnedSeatPolicySelector({
    gateway: {
      stateDirectory: root,
      workspace: 'default',
      gateway: 'owned',
      verifyCustody: () => {},
    } as never,
    basePolicy,
    baseDigest: createHash('sha256').update(baseBytes).digest('hex'),
    facts: store,
    currentProfiles: () => vertexProfiles,
    hostGrants: { verifySeat: () => {} },
    capture: () => receipt,
    invoke: (args) =>
      JSON.stringify(
        args[0] === 'policy'
          ? {
              scope: 'sandbox',
              sandbox: args[args.indexOf('get') + 1],
              version: 1,
              active_version: 1,
              status: 'effective',
              policy_source: 'sandbox',
              config_revision: 1,
              hash: 'a'.repeat(64),
              policy:
                policyCase === 'effective-policy-mismatch' || installedPolicyChanged
                  ? {}
                  : JSON.parse(readFileSync(policies.get(args[args.indexOf('get') + 1])!, 'utf8')),
            }
          : args.includes('status')
            ? installedVertexStatus({
                name: args[args.indexOf('status') + 1],
                id: 'physical-claude',
                workspace: 'default',
                provider: 'vertex-work',
                providerId: 'vertex-id',
                hash: 'a'.repeat(64),
                revision: '1',
              })
            : {
                ...boxes.get(args[args.indexOf('get') + 1]),
              },
      ),
  });
  const artifactPath = join(root, 'leases.db');
  const artifactRequest = {
    sessionId: 'symposium',
    seatId: 'builder',
    workspaceId: 'default',
    volumeName: 'test-artifact',
    volumeGeneration: 'generation-1',
    driver: 'podman' as const,
    access: 'writer' as const,
  };
  const artifactLeaseHost = new SqliteArtifactLeaseHost(
    artifactPath,
    {
      verifyGateway: async () => {},
      verifyMount: async () => {},
      verifyDeleted: async () => {
        expect(boxes.size).toBe(0);
      },
    },
    async () => [
      {
        Name: 'test-artifact',
        Driver: 'local',
        Options: {},
        Labels: {
          'openshell.ai/sandbox-attachable': 'true',
          'openshell.ai/sandbox-attachable-workspace': 'default',
          'mitzo.symposium.purpose': 'artifacts',
          'mitzo.symposium.session': 'symposium',
          'mitzo.symposium.workspace': 'default',
          'mitzo.symposium.generation': 'generation-1',
        },
      },
    ],
  );
  const broadcast = vi.fn();
  const runtime = createSymposiumSessionRuntime({
    artifactLeaseHost,
    ...(policyCase.endsWith('-at-launch')
      ? {
          openNative: async (input: Parameters<typeof createClaudeVertexSeat>[0]) => {
            const native = await createClaudeVertexSeat({
              ...input,
              attemptRegistry: registry,
              requireModelReceipts: true,
              verifiedLauncher: true,
            });
            if (policyCase === 'policy-mutated-at-launch') installedPolicyChanged = true;
            if (policyCase === 'provider-mutated-at-launch') providerCurrent = false;
            return native;
          },
        }
      : {}),
    artifactRequest: () => artifactRequest,
    sessionId: 'symposium',
    store,
    profiles: vertexProfiles,
    resolveSeatPolicy,
    currentProfiles: () => vertexProfiles,
    hostGrants: { verifySeat: vi.fn() },
    codexStore: {} as never,
    attemptRegistry: registry,
    runtimeConfig: { ...runtimeConfig, image: REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME.build.image },
    perSeatSandboxVerified: true,
    readOnlyEnforced: { openaiApi: false, claudeVertex: true },
    verifyHostCapability: () => ({
      attestedProviderInstances: new Map([
        [
          'vertex-work',
          {
            id: 'vertex-id',
            type: 'google-vertex-ai',
            profileName: 'google-vertex-ai',
            workspace: 'default',
          },
        ],
      ]),
      claudeProviders: new Map(providerCurrent ? [['vertex-work', receipt]] : []),
    }),
    resolveProviderIdentity: (name, id) => ({
      name,
      id,
      type: 'google-vertex-ai',
      workspace: 'default',
    }),
    recordAccepted: (r) => store.markSymposiumRecipientAccepted(r),
    broadcastEvent: broadcast,
    runSandboxCreation: async (verify, operation) => {
      verify();
      return operation(
        () => {},
        () => {},
      );
    },
    managerFactory: (configuration) => {
      derivedPath = configuration.policy;
      return new OpenShellRuntimeManager(configuration, async (args) => {
        (managerCommands as string[][]).push([...args]);
        if (args.includes('list'))
          return JSON.stringify({
            providers: [
              {
                name: 'vertex-work',
                id: 'vertex-id',
                type: 'google-vertex-ai',
                workspace: 'default',
              },
            ],
            next_page_token: '',
          });
        if (args.includes('create')) {
          expect(args[args.indexOf('--policy') + 1]).toBe(derivedPath);
          expect(args).not.toContain('--upload');
          const labels = Object.fromEntries(
            args.flatMap((arg, i) => (arg === '--label' ? [args[i + 1].split('=')] : [])),
          );
          created = {
            name: args[args.indexOf('--name') + 1],
            id: 'physical-claude',
            workspace: 'default',
            phase: 'Ready',
            labels,
          };
          boxes.set(created.name, created);
          policies.set(created.name, configuration.policy);
          return JSON.stringify(created);
        }
        if (args.includes('stop')) {
          const found = boxes.get(args[args.indexOf('stop') + 1]);
          if (found) found.phase = 'Stopped';
          return '{}';
        }
        if (args.includes('delete')) {
          boxes.delete(args[args.indexOf('delete') + 1]);
          return '{}';
        }
        if (args.includes('get')) {
          const found = boxes.get(args[args.indexOf('get') + 1]);
          if (!found) throw Error('sandbox not found');
          return JSON.stringify(found);
        }
        if (args.includes('upload')) {
          expect(
            store
              .listSymposiumSessionSandboxes('symposium')
              .some(
                (row) =>
                  row.sandboxName === args[args.indexOf('upload') + 1] &&
                  row.physicalId === 'physical-claude',
              ),
          ).toBe(true);
          return '{}';
        }
        return '{}';
      });
    },
  });
  try {
    const member = await runtime.orchestrator.transitionMembership({
      sessionId: 'symposium',
      seatId: 'builder',
      action: 'admit',
      expectedGeneration: 0,
      configRevision: 1,
      actor: 'owner',
      reason: 'Approved',
      idempotencyKey: 'claude-admit',
    });
    if (policyCase === 'effective-policy-mismatch') {
      expect(member.reconciliation).toBe('recovery_required');
      expect(
        store.getSymposiumSeatSandbox('symposium', 'builder', member.generation),
      ).toMatchObject({
        physicalId: 'physical-claude',
        state: 'reserved',
      });
      await expect(
        runtime.owner.ensure('symposium', 'builder', new AbortController().signal),
      ).rejects.toThrow('membership is not confirmed');
      expect(managerCommands.filter((args) => args.includes('create'))).toHaveLength(1);
      expect(commands).toHaveLength(0);
      const db = new Database(artifactPath);
      try {
        expect(db.prepare('SELECT sandbox_id FROM symposium_artifact_leases').get()).toEqual({
          sandbox_id: 'physical-claude',
        });
        await runtime.owner.stop(
          'symposium',
          'builder',
          member.generation,
          new AbortController().signal,
        );
        expect(db.prepare('SELECT count(*) AS n FROM symposium_artifact_leases').get()).toEqual({
          n: 0,
        });
        expect(
          store.getSymposiumSeatSandbox('symposium', 'builder', member.generation)?.state,
        ).toBe('stopped');
      } finally {
        db.close();
      }
      return;
    }
    expect(member.reconciliation).toBe('confirmed');
    const deliver = async (text: string) => {
      const d = runtime.orchestrator.stageDelivery({
        sessionId: 'symposium',
        sourceSeatId: null,
        recipientSeatIds: ['builder'],
        originalContent: text,
        idempotencyKey: text,
      });
      runtime.orchestrator.intervene({
        deliveryId: d.deliveryId,
        action: 'approve',
        idempotencyKey: 'approve-' + text,
      });
      return runtime.orchestrator.deliver(d.deliveryId);
    };
    if (policyCase.endsWith('-at-launch')) {
      expect((await deliver('First')).status).toBe('failed');
      expect(prompts).toHaveLength(0);
      expect(broadcast.mock.calls.some(([, e]) => e.type === 'message_start')).toBe(false);
      return;
    }
    expect((await deliver('First')).status).toBe('delivered');
    expect((await deliver('Second')).status).toBe('delivered');
    expect((await deliver('Third')).status).toBe('delivered');
    expect(prompts[1]).toContain('Reply 1');
    expect(prompts[2]).toContain('Reply 1');
    expect(prompts[2]).toContain('Reply 2');
    expect(commands[0].slice(0, 4)).toEqual([
      '/usr/local/bin/symposium-claude-vertex',
      'project-1',
      'global',
      '--print',
    ]);
    expect(commands[0]).not.toContain('/usr/local/bin/claude');
    expect(new Set(commands.map((c) => c[c.indexOf('--session-id') + 1])).size).toBe(3);
    expect(
      commands.every(
        (c) => c[0] === '/usr/local/bin/symposium-claude-vertex' && !c.includes('--resume'),
      ),
    ).toBe(true);
    expect(
      store.getSessionEvents('symposium').filter((e) => e.type === 'symposium_thread_migrated'),
    ).toHaveLength(2);
    const authored = store.getSessionEvents('symposium').filter((e) => e.type === 'message_start');
    expect(authored).toHaveLength(3);
    expect(
      authored.every(
        (e) =>
          e.seatId === 'builder' &&
          !!e.symposiumProvenance &&
          'accountBinding' in e.symposiumProvenance &&
          e.symposiumProvenance.accountBinding.accountId === 'work-vertex',
      ),
    ).toBe(true);
    const before = broadcast.mock.calls.length;
    failModel = true;
    expect((await deliver('Wrong model')).status).toBe('failed');
    expect(broadcast.mock.calls.slice(before).some(([, e]) => e.type === 'message_start')).toBe(
      false,
    );
    failModel = false;
    failAssistant = true;
    const beforeAssistantFailure = broadcast.mock.calls.length;
    expect((await deliver('Late wrong model')).status).toBe('failed');
    expect(
      broadcast.mock.calls
        .slice(beforeAssistantFailure)
        .some(([, e]) => e.type === 'message_start'),
    ).toBe(false);
    failAssistant = false;
    omitInit = true;
    const beforeMissingInit = broadcast.mock.calls.length;
    expect((await deliver('Missing init')).status).toBe('failed');
    expect(
      broadcast.mock.calls.slice(beforeMissingInit).some(([, e]) => e.type === 'message_start'),
    ).toBe(false);
    providerCurrent = false;
    const starts = commands.length;
    expect((await deliver('Revoked provider')).status).toBe('failed');
    expect(commands).toHaveLength(starts);
  } finally {
    vi.unstubAllEnvs();
    artifactLeaseHost.close();
    registry.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
