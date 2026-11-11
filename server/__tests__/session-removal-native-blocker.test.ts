import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { createSessionRemovalRuntime } from '../session-removal-runtime.js';
import { createSessionRemovalRouter } from '../session-removal.js';
import { SessionResourceRemovalService } from '../session-resource-removal.js';
import { SessionRemovalStore } from '../../packages/protocol/src/session-removal-store.js';

it('delivers the native blocker through runtime, durable removal and HTTP review, then keeps the same chat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-removal-blocker-'));
  const native = new CodexConversationStore(join(root, 'native.db'));
  const db = new Database(':memory:');
  const binding = {
    accountId: 'offline',
    accountLabel: 'Offline',
    provider: 'openai-codex',
    model: 'offline',
    profileRevision: 'test',
  };
  const store = new SessionRemovalStore(db);
  const hide = vi.fn();
  const releaseLocal = vi.fn();
  try {
    native.create('c', binding, '/task');
    native.enqueue('c', binding, { id: 'command', prompt: 'Offline fixture' });
    native.claimNext('c', binding);
    native.claimTool('c', binding, 'command', 'unfinished-tool');
    native.finish('c', binding, 'command', 'completed');
    const before = native.read('c', binding);
    const runtime = createSessionRemovalRuntime({
      events: {
        deployment: { maintenance: { assertControl: () => {} } },
        getSession: () => ({
          sessionId: 'c',
          cwd: '/task',
          accountBinding: binding,
          executionPhase: 'TERMINAL',
        }),
        getSessionRuntimeBinding: () => ({
          version: 2,
          harness: { implementation: 'codex' },
          execution: { location: 'local' },
        }),
        getEventsOfType: () => [],
        hasUncertainOrdinaryCommand: () => false,
        upsertSession: vi.fn(),
      },
      registry: {
        findBySessionId: () => undefined,
        entries: () => [][Symbol.iterator](),
        abortStartup: () => false,
      },
      tasks: { getTree: () => [], getTelosExecutionBinding: () => null },
      native: () => native,
      stop: vi.fn(),
    } as never);
    const service = new SessionResourceRemovalService({
      store,
      ...runtime,
      cancelPrompts: async () => {},
    });
    const app = express();
    app.use(express.json());
    app.use(
      '/api/sessions',
      createSessionRemovalRouter({
        authorize: (_req, _res, next) => next(),
        lifecycle: () => null,
        hasSandbox: () => false,
        hide,
        changed: vi.fn(),
        removal: {
          service,
          authority: () => () => {},
          localPreview: () => ({ action: 'retain', reason: 'Workspace retained.' }),
          releaseLocal,
        },
      }),
    );
    const failed = await request(app).post('/api/sessions/c/prepare-deletion').send({}).expect(409);
    expect(failed.body.error).toMatch(/tool call has no verified result/);
    const preview = await request(app).get('/api/sessions/c/deletion-preview').expect(200);
    expect(preview.body).toMatchObject({
      needsPreparation: true,
      removal: { phase: 'failed', canKeep: true, error: failed.body.error },
    });
    const operationId = preview.body.removal.operationId;
    await request(app)
      .delete('/api/sessions/c')
      .send({ removalOperationId: operationId })
      .expect(409);
    expect(hide).not.toHaveBeenCalled();
    expect(releaseLocal).not.toHaveBeenCalled();
    expect(native.read('c', binding)).toEqual(before);
    await request(app)
      .post('/api/sessions/c/keep-chat')
      .send({ removalOperationId: operationId })
      .expect(200);
    expect(store.read('c')).toBeUndefined();
    expect(native.read('c', binding)).toEqual(before);
  } finally {
    native.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
