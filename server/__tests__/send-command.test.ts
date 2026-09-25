import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { acceptSendCommand, acceptSendCommandAsync } from '../send-command.js';

const message = {
  type: 'send' as const,
  sessionId: null,
  clientMsgId: 'stable-id',
  prompt: 'first prompt',
};

describe('durable send acceptance', () => {
  it('accepts without a stream and dispatches a lost-response retry only once', () => {
    const store = new EventStore(':memory:');
    const dispatch = vi.fn<() => void>();
    try {
      const first = acceptSendCommand(store, message, dispatch);
      const retry = acceptSendCommand(store, message, dispatch);
      expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(retry).toEqual(first);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(message, first.sessionId);
      expect(store.getSendCommand(message.clientMsgId)).toMatchObject({
        payload: {},
        requestFingerprint: expect.any(String),
      });
    } finally {
      store.close();
    }
  });

  it('rejects reuse of a command ID for a different prompt', () => {
    const store = new EventStore(':memory:');
    try {
      acceptSendCommand(store, message, vi.fn<() => void>());
      expect(() =>
        acceptSendCommand(store, { ...message, prompt: 'different' }, vi.fn<() => void>()),
      ).toThrow(/different/i);
    } finally {
      store.close();
    }
  });

  it('rejects request changes beyond the prompt while preserving the original receipt', () => {
    const store = new EventStore(':memory:');
    try {
      acceptSendCommand(store, { ...message, model: 'model-a' }, vi.fn<() => void>());
      expect(() =>
        acceptSendCommand(store, { ...message, model: 'model-b' }, vi.fn<() => void>()),
      ).toThrow('different request');
      expect(store.getSendCommand(message.clientMsgId)?.payload).toEqual({});
    } finally {
      store.close();
    }
  });

  it('retains the target session for resumed prompts', () => {
    const store = new EventStore(':memory:');
    try {
      expect(
        acceptSendCommand(store, { ...message, sessionId: 'existing' }, vi.fn<() => void>())
          .sessionId,
      ).toBe('existing');
    } finally {
      store.close();
    }
  });

  it('records a dispatch failure durably instead of acknowledging a lost prompt', () => {
    const store = new EventStore(':memory:');
    try {
      expect(() =>
        acceptSendCommand(store, message, () => {
          throw new Error('cannot start');
        }),
      ).toThrow('cannot start');
      expect(store.getSendCommand(message.clientMsgId)?.error).toBe('cannot start');
      expect(() => acceptSendCommand(store, message, vi.fn<() => void>())).toThrow('cannot start');
    } finally {
      store.close();
    }
  });
  it('does not manufacture an agent session for a native command', () => {
    const store = new EventStore(':memory:');
    try {
      const native = { ...message, prompt: '/skills' };
      const result = acceptSendCommand(store, native, () => false);
      expect(result.sessionId).toBeNull();
      expect(acceptSendCommand(store, native, vi.fn<() => void>())).toEqual(result);
    } finally {
      store.close();
    }
  });

  it('reports an interrupted acceptance after restart instead of silently suppressing it', () => {
    const store = new EventStore(':memory:');
    try {
      acceptSendCommand(store, message, vi.fn<() => void>());
      store.recoverPendingSendCommands();
      expect(() => acceptSendCommand(store, message, vi.fn<() => void>())).toThrow(/restart/i);
    } finally {
      store.close();
    }
  });

  it('does not acknowledge async dispatch until admission completes', async () => {
    const store = new EventStore(':memory:');
    let admit!: () => void;
    try {
      const accepted = acceptSendCommandAsync(
        store,
        message,
        () =>
          new Promise((resolve) => {
            admit = () => resolve();
          }),
      );
      let settled = false;
      void accepted.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      admit();
      await expect(accepted).resolves.toMatchObject({ accepted: true });
    } finally {
      store.close();
    }
  });

  it('records an async dispatch rejection before returning a receipt', async () => {
    const store = new EventStore(':memory:');
    try {
      await expect(
        acceptSendCommandAsync(store, message, async () => {
          throw new Error('admission failed');
        }),
      ).rejects.toThrow('admission failed');
      expect(store.getSendCommand(message.clientMsgId)?.error).toBe('admission failed');
    } finally {
      store.close();
    }
  });

  it('coalesces a concurrent retry until the original admission settles', async () => {
    const store = new EventStore(':memory:');
    let rejectAdmission!: (reason: Error) => void;
    const dispatch = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAdmission = reject;
        }),
    );
    try {
      const original = acceptSendCommandAsync(store, message, dispatch);
      const retry = acceptSendCommandAsync(store, message, dispatch);

      await expect(retry).resolves.toMatchObject({ accepted: true, pending: true });
      expect(dispatch).toHaveBeenCalledOnce();
      rejectAdmission(new Error('probe failed'));
      await expect(original).rejects.toThrow('probe failed');
      expect(store.getSendCommand(message.clientMsgId)?.error).toBe('probe failed');
    } finally {
      store.close();
    }
  });

  it('returns durable pending receipts immediately for queued originals and exact retries', async () => {
    const store = new EventStore(':memory:');
    let activate!: () => void;
    const completion = new Promise<void>((resolve) => {
      activate = resolve;
    });
    const dispatch = vi.fn(async () => ({ queued: true as const, completion }));
    try {
      const original = acceptSendCommandAsync(store, message, dispatch);
      const retry = acceptSendCommandAsync(store, message, dispatch);

      await expect(original).resolves.toMatchObject({ accepted: true, pending: true });
      await expect(retry).resolves.toMatchObject({ accepted: true, pending: true });
      expect(dispatch).toHaveBeenCalledOnce();
      expect(store.getSendCommand(message.clientMsgId)).toMatchObject({ error: null });

      activate();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const afterActivation = await acceptSendCommandAsync(store, message, dispatch);
      expect(afterActivation).toMatchObject({ accepted: true });
      expect(afterActivation).not.toHaveProperty('pending');
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      store.close();
    }
  });

  it('adopts an exact legacy payload receipt once, then fingerprints it across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mitzo-send-command-adoption-'));
    const path = join(root, 'receipts.sqlite');
    const store = new EventStore(path);
    try {
      store.insertSendCommand(message.clientMsgId, 'legacy-session', message);
      const first = acceptSendCommand(store, message, vi.fn<() => void>());
      expect(first.sessionId).toBe('legacy-session');
      expect(store.getSendCommand(message.clientMsgId)).toMatchObject({
        payload: {},
        requestFingerprint: expect.any(String),
      });
      expect(acceptSendCommand(store, message, vi.fn<() => void>())).toEqual(first);
    } finally {
      store.close();
    }
    const reopened = new EventStore(path);
    try {
      expect(acceptSendCommand(reopened, message, vi.fn<() => void>())).toMatchObject({
        sessionId: 'legacy-session',
      });
      expect(() =>
        acceptSendCommand(
          reopened,
          { ...message, prompt: 'different legacy prompt' },
          vi.fn<() => void>(),
        ),
      ).toThrow('different request');
    } finally {
      reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('coalesces concurrent retries while adopting a legacy receipt', async () => {
    const store = new EventStore(':memory:');
    const dispatch = vi.fn<() => void>();
    try {
      store.insertSendCommand(message.clientMsgId, 'legacy-session', message);
      const [first, second] = await Promise.all([
        Promise.resolve().then(() => acceptSendCommand(store, message, dispatch)),
        Promise.resolve().then(() => acceptSendCommand(store, message, dispatch)),
      ]);
      expect(first).toEqual(second);
      expect(dispatch).not.toHaveBeenCalled();
      expect(store.getSendCommand(message.clientMsgId)).toMatchObject({
        payload: {},
        requestFingerprint: expect.any(String),
      });
    } finally {
      store.close();
    }
  });

  it('does not mutate a legacy receipt when its canonical command differs', () => {
    const store = new EventStore(':memory:');
    try {
      store.insertSendCommand(message.clientMsgId, 'legacy-session', message);
      expect(() =>
        acceptSendCommand(
          store,
          { ...message, prompt: 'different legacy prompt' },
          vi.fn<() => void>(),
        ),
      ).toThrow('different request');
      expect(store.getSendCommand(message.clientMsgId)).toMatchObject({
        payload: message,
        requestFingerprint: null,
      });
    } finally {
      store.close();
    }
  });

  it('isolates receipt identity across client message IDs and target sessions', () => {
    const store = new EventStore(':memory:');
    try {
      acceptSendCommand(store, { ...message, sessionId: 'session-a' }, vi.fn<() => void>());
      acceptSendCommand(
        store,
        { ...message, clientMsgId: 'other-client-message', sessionId: 'session-b' },
        vi.fn<() => void>(),
      );
      expect(() =>
        acceptSendCommand(store, { ...message, sessionId: 'session-b' }, vi.fn<() => void>()),
      ).toThrow('different request');
    } finally {
      store.close();
    }
  });

  it('migrates a previous send_commands table with a nullable fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mitzo-send-command-migration-'));
    const path = join(root, 'legacy.sqlite');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE send_commands (
        client_msg_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        payload TEXT NOT NULL, error TEXT,
        created_at INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'agent',
        is_active INTEGER NOT NULL DEFAULT 1, is_hidden INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 1
      );
    `);
    legacy
      .prepare(`INSERT INTO send_commands (client_msg_id, session_id, payload) VALUES (?, ?, ?)`)
      .run(message.clientMsgId, 'legacy-session', JSON.stringify(message));
    legacy.close();
    const migrated = new EventStore(path);
    try {
      expect(migrated.getSendCommand(message.clientMsgId)?.requestFingerprint).toBeNull();
      expect(acceptSendCommand(migrated, message, vi.fn<() => void>())).toMatchObject({
        sessionId: 'legacy-session',
      });
    } finally {
      migrated.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
