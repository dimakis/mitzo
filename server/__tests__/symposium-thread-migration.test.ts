import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConversation } from '../codex-conversation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { createOpenAiCodexSeat } from '../symposium-codex-native.js';
import { symposiumSeatRuntimeId } from '../symposium-seat-runtime.js';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
function fixture(emptyHistory = false) {
  const root = mkdtempSync(join(tmpdir(), 'symposium-migration-'));
  const path = join(root, 'codex.db');
  let store = new CodexConversationStore(path);
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const binding = {
    accountId: 'work',
    accountLabel: 'Work',
    provider: 'openai' as const,
    model: 'mock-model',
    profileRevision: 'work-v1',
  };
  const execution = {
    sessionId: 'discussion',
    deliveryId: 'delivery',
    idempotencyKey: 'delivery-key',
    claimToken: 'claim',
    content: 'Continue approved work.',
    providerThreadId: 'old-thread',
    seat: {
      id: 'writer',
      name: 'Writer',
      role: 'implementer',
      model: 'mock-model',
      accountBinding: binding,
      systemPrompt: 'Implement approved changes.',
    },
    provenance: { membershipGeneration: 1 },
    signal: new AbortController().signal,
  } as SymposiumSeatExecution;
  const id = symposiumSeatRuntimeId(execution);
  store.create(id, binding, '/workspace', 'old-surface');
  store.bindThread(id, binding, 'old-thread', 'old-surface');
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let failAfterMigration = false;
  const open = (current = execution, arbitrary = false) =>
    createOpenAiCodexSeat({
      execution: current,
      route: {
        kind: 'openai-api',
        provider: 'work',
        providerId: 'work-object',
        model: 'mock-model',
        effort: null,
        readOnly: false,
      },
      sandbox: { sandboxName: 'mock-only', workdir: '/workspace' },
      store,
      loadConversationHistory: () =>
        emptyHistory
          ? []
          : [
              { role: 'user', text: 'Approved writer-only request.' },
              { role: 'assistant', text: 'Completed writer response.' },
            ],
      createConversation: (options) => {
        let callbacks: CodexLifecycleTransport;
        const conversation = new CodexConversation({
          ...options,
          createClient: (lifecycle) => {
            callbacks = lifecycle;
            return {
              initialize: async () => {},
              close: () => {},
              request: async (method, params) => {
                requests.push({ method, params: params ?? {} });
                if (method === 'config/read') return { config: {} };
                if (method === 'thread/start' || method === 'thread/resume')
                  return {
                    thread: { id: arbitrary ? 'unrelated-thread' : 'new-thread' },
                    model: 'mock-model',
                    modelProvider: 'openshell',
                  };
                if (method === 'turn/start') {
                  setTimeout(
                    () =>
                      callbacks.onNotification('turn/completed', {
                        threadId: 'new-thread',
                        turn: { id: 'turn-1', status: 'completed' },
                      }),
                    0,
                  );
                  return { turn: { id: 'turn-1' } };
                }
                return {};
              },
            };
          },
        });
        return {
          initialize: async () => {
            await conversation.initialize();
            if (failAfterMigration) throw new Error('simulated initialization interruption');
          },
          getThreadId: () => conversation.getThreadId(),
          send: (input) => conversation.send(input),
          interrupt: () => conversation.interrupt(),
          close: () => conversation.close(),
        };
      },
    });
  return {
    execution,
    binding,
    id,
    requests,
    open,
    get store() {
      return store;
    },
    failInitialization: () => {
      failAfterMigration = true;
    },
    restart: () => {
      store.close();
      store = new CodexConversationStore(path);
      failAfterMigration = false;
    },
  };
}
it('migrates an existing seat through durable lineage and sends its prior text as untrusted context', async () => {
  const f = fixture();
  const native = await f.open();
  const before = vi.fn((thread?: string) =>
    native.verifyThreadMigration!(f.execution.providerThreadId!, thread!),
  );
  const result = await native.run(f.execution, { beforeDispatch: before, accepted: vi.fn() });
  expect(result.providerThreadId).toBe('new-thread');
  expect(before).toHaveBeenCalledWith('new-thread');
  expect(f.requests.find((r) => r.method === 'turn/start')?.params.additionalContext).toEqual({
    'mitzo.tool-surface-rollover': {
      kind: 'untrusted',
      value: expect.stringContaining('Completed writer response.'),
    },
  });
  expect(f.store.read(f.id, f.binding).threadGeneration).toBe(1);
});
it('recovers a persisted predispatch migration after failed initialization and restart without duplicate turns', async () => {
  const f = fixture();
  f.failInitialization();
  await expect(f.open()).rejects.toThrow('interruption');
  expect(f.requests.some((r) => r.method === 'turn/start')).toBe(false);
  f.restart();
  const native = await f.open();
  await native.run(f.execution, {
    beforeDispatch: (thread) => native.verifyThreadMigration!('old-thread', thread!),
    accepted: () => {},
  });
  expect(f.requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
  expect(f.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
});
it('rejects arbitrary IDs, foreign bindings and other membership generations', async () => {
  const f = fixture();
  const native = await f.open();
  expect(() => native.verifyThreadMigration!('someone-elses-thread', 'new-thread')).toThrow();
  expect(() =>
    f.store.assertToolSurfaceReplacement(
      f.id,
      { ...f.binding, accountId: 'other' },
      'old-thread',
      'new-thread',
    ),
  ).toThrow();
  await native.cancel();
  await expect(
    f.open({ ...f.execution, provenance: { ...f.execution.provenance, membershipGeneration: 2 } }),
  ).rejects.toThrow();
  expect(f.requests.some((r) => r.method === 'turn/start')).toBe(false);
});

it('persists the seat CAS before provider completion consumes continuity, surviving restart', async () => {
  const f = fixture();
  const { EventStore } = await import('../event-store.js');
  const { default: Database } = await import('better-sqlite3');
  const root = mkdtempSync(join(tmpdir(), 'symposium-seat-cas-'));
  const path = join(root, 'events.db');
  let facts = new EventStore(path);
  cleanup.push(() => {
    facts.close();
    rmSync(root, { recursive: true, force: true });
  });
  facts.upsertSession({ sessionId: 'discussion' });
  const db = new Database(path);
  // Seed the exact predispatch durable claim boundary, not provider output.
  db.prepare(
    `INSERT INTO symposium_deliveries(delivery_id,session_id,recipient_seat_ids,original_content,status,idempotency_key,config_revision,created_at,updated_at) VALUES('delivery','discussion','["writer"]','Continue','delivering','key',1,1,1)`,
  ).run();
  db.prepare(
    `INSERT INTO symposium_seat_threads VALUES('discussion','writer','bound-generation-1','old-thread',1,1,1)`,
  ).run();
  db.prepare(
    `INSERT INTO symposium_seat_execution_claims VALUES('discussion','writer','bound-generation-1','delivery','recipient-key','claim',1)`,
  ).run();
  db.prepare(
    `INSERT INTO symposium_recipient_attempts(delivery_id,seat_id,attempt_number,idempotency_key,claim_token,status,provider_thread_id,started_at,updated_at) VALUES('delivery','writer',1,'recipient-key','claim','executing','old-thread',1,1)`,
  ).run();
  db.close();
  const native = await f.open();
  await native.run(f.execution, {
    beforeDispatch: (thread) => {
      native.verifyThreadMigration!('old-thread', thread!);
      expect(() => facts.migrateSymposiumSeatThread('claim', 'wrong-old-thread', thread!)).toThrow(
        /predecessor/,
      );
      facts.migrateSymposiumSeatThread('claim', 'old-thread', thread!);
      expect(f.requests.some((r) => r.method === 'turn/start')).toBe(false);
    },
    accepted: (providerThreadId, providerTurnId) => {
      expect(
        facts.markSymposiumRecipientAccepted({
          deliveryId: 'delivery',
          seatId: 'writer',
          claimToken: 'claim',
          providerThreadId,
          providerTurnId,
          acceptedAt: Date.now(),
        }),
      ).toBe(true);
    },
  });
  expect(f.store.read(f.id, f.binding).rolloverContext).toBeNull();
  // Simulate loss before the orchestrator's recipient completion writes.
  facts.close();
  facts = new EventStore(path);
  f.restart();
  const migrated = facts.getSymposiumSeatThreads('discussion')[0];
  expect(migrated.providerThreadId).toBe('new-thread');
  const resumed = await f.open({ ...f.execution, providerThreadId: migrated.providerThreadId });
  await resumed.cancel();
  expect(f.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  expect(() => facts.migrateSymposiumSeatThread('claim', 'old-thread', 'another-thread')).toThrow(
    /claim/,
  );
  expect(() =>
    facts.migrateSymposiumSeatThread('foreign-claim', 'new-thread', 'another-thread'),
  ).toThrow(/claim/);
});

it('allows a verified empty completed-history snapshot without fabricating prior dialogue', async () => {
  const f = fixture(true);
  const native = await f.open();
  await native.run(f.execution, {
    beforeDispatch: (thread) => native.verifyThreadMigration!('old-thread', thread!),
    accepted: () => {},
  });
  const context = JSON.stringify(
    f.requests.find((r) => r.method === 'turn/start')?.params.additionalContext,
  );
  expect(context).toContain('no completed conversation text');
  expect(context).not.toContain('Approved writer-only request');
});

it('retains only completed text for the same session, seat, account and grant generation', async () => {
  const { symposiumSeatRolloverHistory } = await import('../symposium-session-runtime.js');
  const f = fixture();
  const provenance = {
    version: 2,
    seatId: 'writer',
    membershipGeneration: 1,
    accountBinding: f.binding,
    profileBinding: { profileId: 'writer', profileRevision: '1' },
    contextGrant: { grantId: 'context', revision: 1 },
    authorityGrant: { grantId: 'authority', revision: 1 },
    capturedAt: 10,
    configRevision: 1,
  };
  const execution = { ...f.execution, provenance } as unknown as SymposiumSeatExecution;
  const completed = {
    attemptId: 1,
    seatId: 'writer',
    status: 'delivered',
    provenance: { ...provenance, capturedAt: 9, configRevision: 0 },
    dispatchedContent: 'Approved edited writer prompt',
    resultContent: 'Completed writer text',
  };
  const candidates = [
    completed,
    { ...completed, attemptId: 2, status: 'executing', dispatchedContent: 'PENDING' },
    { ...completed, attemptId: 3, status: 'failed', dispatchedContent: 'FAILED' },
    {
      ...completed,
      attemptId: 4,
      provenance: { ...provenance, membershipGeneration: 2 },
      dispatchedContent: 'OTHER GENERATION',
    },
    {
      ...completed,
      attemptId: 5,
      provenance: { ...provenance, accountBinding: { ...f.binding, accountId: 'other' } },
      dispatchedContent: 'OTHER ACCOUNT',
    },
    {
      ...completed,
      attemptId: 6,
      provenance: { ...provenance, contextGrant: { grantId: 'other', revision: 1 } },
      dispatchedContent: 'OTHER GRANT',
    },
    {
      ...completed,
      attemptId: 7,
      seatId: 'reviewer',
      provenance: { ...provenance, seatId: 'reviewer' },
      dispatchedContent: 'OTHER SEAT',
    },
  ];
  const source = {
    getSymposiumDeliveries: vi.fn(() => [{ deliveryId: 'own-delivery' }]),
    getSymposiumRecipientAttempts: vi.fn(() => candidates),
  };
  const history = symposiumSeatRolloverHistory(
    source as unknown as Parameters<typeof symposiumSeatRolloverHistory>[0],
    execution,
  );
  expect(source.getSymposiumDeliveries).toHaveBeenCalledWith('discussion');
  expect(source.getSymposiumRecipientAttempts).toHaveBeenCalledWith('own-delivery', 'writer');
  expect(history).toEqual([
    { role: 'user', text: 'Approved edited writer prompt' },
    { role: 'assistant', text: 'Completed writer text' },
  ]);
});
