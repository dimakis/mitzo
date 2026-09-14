import { describe, it, expect, vi } from 'vitest';
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
    const dispatch = vi.fn();
    try {
      const first = acceptSendCommand(store, message, dispatch);
      const retry = acceptSendCommand(store, message, dispatch);
      expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(retry).toEqual(first);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(message, first.sessionId);
      expect(store.getSendCommand(message.clientMsgId)?.payload).toEqual(message);
    } finally {
      store.close();
    }
  });

  it('rejects reuse of a command ID for a different prompt', () => {
    const store = new EventStore(':memory:');
    try {
      acceptSendCommand(store, message, vi.fn());
      expect(() => acceptSendCommand(store, { ...message, prompt: 'different' }, vi.fn())).toThrow(
        /different/i,
      );
    } finally {
      store.close();
    }
  });

  it('retains the target session for resumed prompts', () => {
    const store = new EventStore(':memory:');
    try {
      expect(
        acceptSendCommand(store, { ...message, sessionId: 'existing' }, vi.fn()).sessionId,
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
      expect(() => acceptSendCommand(store, message, vi.fn())).toThrow('cannot start');
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
      expect(acceptSendCommand(store, native, vi.fn())).toEqual(result);
    } finally {
      store.close();
    }
  });

  it('reports an interrupted acceptance after restart instead of silently suppressing it', () => {
    const store = new EventStore(':memory:');
    try {
      acceptSendCommand(store, message, vi.fn());
      store.recoverPendingSendCommands();
      expect(() => acceptSendCommand(store, message, vi.fn())).toThrow(/restart/i);
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
});
