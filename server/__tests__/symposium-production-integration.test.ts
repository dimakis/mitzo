import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { SymposiumNativeEventSink } from '../symposium-native-event-sink.js';
import { getSymposiumPerspective, getSymposiumQueuedInputs } from '../symposium-perspectives.js';
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

  it('admits one verified seat, persists exact receipts and rich blocks, and fences revocation', async () => {
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
      recordEvent: (execution, event) => events.record(execution, event),
      managerFactory: () => ({
        ensure: async () => ({ sandboxName: 'shared', workdir: runtimeConfig.workdir }),
      }),
      openNative: async ({ execution, onEvent }) => ({
        run: async (_input, callbacks) => {
          callbacks.beforeDispatch();
          callbacks.accepted('thread-1', 'turn-1');
          sent.push(execution.content);
          if (execution.content === 'Hold until cancelled')
            await new Promise<never>((_resolve, reject) => {
              rejectHeld = reject;
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
    store.close();
  });

  it('puts only the portable profile contract into native system context', () => {
    expect(symposiumSeatSystemPrompt(seat)).toBe(
      'Build only the requested patch.\n\nExpected output:\nA focused patch and test result\n\nAcceptance criteria:\n- The focused tests pass\n- Explain remaining risks',
    );
    expect(symposiumSeatSystemPrompt(seat)).not.toContain('session:symposium');
  });
});
