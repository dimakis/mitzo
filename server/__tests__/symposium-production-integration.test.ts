import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { AccountBindingSchema, type SymposiumConfig } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { CodexSessionEvents } from '../codex-session-events.js';
import { AccountProfiles } from '../account-profiles.js';
import { createSymposiumSessionRuntime } from '../symposium-session-runtime.js';
import { createSymposiumDirectorRouter } from '../symposium-director-routes.js';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';
import { SymposiumNativeEventSink } from '../symposium-native-event-sink.js';
import { getSymposiumPerspective, getSymposiumQueuedInputs } from '../symposium-perspectives.js';
import { SymposiumAttemptRegistry } from '../symposium-attempt-registry.js';
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
const seat = {
  id: 'builder',
  name: 'Builder',
  role: 'implementer',
  model: 'gpt-test',
  systemPrompt: 'Build only the requested patch.',
  expectedOutput: 'A focused patch and test result',
  acceptanceCriteria: ['The focused tests pass', 'Explain remaining risks'],
  color: '#224466',
  accountBinding: AccountBindingSchema.parse(profiles.resolve('work-api', 'gpt-test')),
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
  anchorSeatId: 'builder',
  activeSeatCap: 2,
  seats: [seat],
  turnRules: { mode: 'directed', maxTurns: 4 },
  interceptMode: 'manual',
};
const runtimeConfig = {
  cli: 'openshell',
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
    const runtime = createSymposiumSessionRuntime({
      sessionId: 'symposium',
      store,
      profiles,
      hostGrants: { verifySeat },
      codexStore: {} as never,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig,
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
        ensure: async () => ({ sandboxName: 'shared', workdir: runtimeConfig.workdir }),
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
          onEvent?.({ type: 'result', is_error: false });
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
        resolveSelection: () => seat.accountBinding,
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
    const suspended = await request(app).post(`${base}/membership`).send({
      seatId: 'builder',
      action: 'suspend',
      expectedGeneration: 1,
      configRevision: 1,
      reason: 'Stop',
      idempotencyKey: 'suspend-builder',
    });
    expect(suspended.status).toBe(409);
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
    store.close();
  });

  it('closes only the recovered claim transcript after reopening both durable stores', async () => {
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
    store.upsertSession({ sessionId: 'symposium', accountBinding: seat.accountBinding });
    store.setSymposiumConfig('symposium', config);
    let dispatched: SymposiumSeatExecution | undefined;
    const broadcast = vi.fn();
    const makeRuntime = () =>
      createSymposiumSessionRuntime({
        sessionId: 'symposium',
        store,
        profiles,
        attemptRegistry: registry,
        hostGrants: { verifySeat: vi.fn() },
        codexStore: {} as never,
        resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
        runtimeConfig,
        readOnlyEnforced: { openaiApi: false, claudeVertex: false },
        recordAccepted: (receipt) => store.markSymposiumRecipientAccepted(receipt),
        broadcastEvent: broadcast,
        managerFactory: () => ({
          ensure: async () => ({ sandboxName: 'shared', workdir: runtimeConfig.workdir }),
        }),
        openNative: async ({ execution, onEvent }) => ({
          run: async (_input, callbacks) => {
            callbacks.beforeDispatch();
            registry.reserve({
              ...execution,
              sandbox: { sandboxName: 'shared', workdir: runtimeConfig.workdir },
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
                content_block: { type: 'tool_use', id: 'restart-tool', name: 'Read', input: {} },
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
        }),
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
    store.appendSymposium(
      'symposium',
      'message_start',
      { messageId: 'different-claim', nativeClaimToken: 'another-claim' },
      execution.provenance,
    );
    store.close();
    registry.close();
    store = new EventStore(path);
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
    store.setSymposiumConfig('symposium', { ...config, revision: 2 });
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
  });

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
