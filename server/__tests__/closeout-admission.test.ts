import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { admitCloseout, closeoutMessageId } from '../closeout-admission.js';

const binding = {
  accountId: 'work',
  accountLabel: 'Work OpenAI',
  provider: 'openai',
  model: 'gpt-test',
  profileRevision: 'route-revision-1',
};

function request(episodeId = 'episode-1') {
  return {
    sessionId: 'session-1',
    episode: { id: episodeId, source: 'automatic' as const },
    prompt: 'close the session',
    promptRevision: 'automatic-v1',
    task: 'commit-push-summarize',
    model: 'gpt-test',
    accountBinding: binding,
  };
}

describe('closeout admission', () => {
  it('uses one stable internal command identity per episode', () => {
    expect(closeoutMessageId('session-1', 'episode-1')).toBe(
      closeoutMessageId('session-1', 'episode-1'),
    );
    expect(closeoutMessageId('session-1', 'episode-2')).not.toBe(
      closeoutMessageId('session-1', 'episode-1'),
    );
  });

  it('prepares and echoes one exact episode only once', () => {
    const store = new EventStore(':memory:');
    store.upsertSession({ sessionId: 'session-1', accountBinding: binding });
    const prepare = vi.fn();
    try {
      const first = admitCloseout({ store, request: request(), prepare });
      const retry = admitCloseout({ store, request: request(), prepare });

      expect(first.duplicate).toBe(false);
      expect(retry).toEqual({ ...first, duplicate: true });
      expect(prepare).toHaveBeenCalledOnce();
      expect(first.messageId).toBe(closeoutMessageId('session-1', 'episode-1'));
    } finally {
      store.close();
    }
  });

  it('rejects changed source, template, task, model, or route before preparation', () => {
    const variants = [
      { episode: { id: 'episode-1', source: 'user' as const } },
      { promptRevision: 'automatic-v2' },
      { task: 'summarize-only' },
      { model: 'gpt-other' },
      { accountBinding: { ...binding, profileRevision: 'route-revision-2' } },
    ];
    for (const changed of variants) {
      const store = new EventStore(':memory:');
      store.upsertSession({ sessionId: 'session-1', accountBinding: binding });
      const prepare = vi.fn();
      try {
        admitCloseout({ store, request: request(), prepare });
        expect(() =>
          admitCloseout({ store, request: { ...request(), ...changed }, prepare }),
        ).toThrow(/fingerprint/i);
        expect(prepare).toHaveBeenCalledOnce();
      } finally {
        store.close();
      }
    }
  });

  it('retains the episode receipt across a disk-backed reopen without replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mitzo-closeout-admission-'));
    const path = join(root, 'events.db');
    const firstStore = new EventStore(path);
    firstStore.upsertSession({ sessionId: 'session-1', accountBinding: binding });
    const first = admitCloseout({ store: firstStore, request: request(), prepare: () => {} });
    firstStore.close();

    const reopened = new EventStore(path);
    const prepare = vi.fn();
    try {
      const retry = admitCloseout({ store: reopened, request: request(), prepare });
      expect(retry).toEqual({ ...first, duplicate: true });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not replay an undispatched episode after restart recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mitzo-closeout-undispatched-'));
    const path = join(root, 'events.db');
    const firstStore = new EventStore(path);
    firstStore.upsertSession({ sessionId: 'session-1', accountBinding: binding });
    admitCloseout({ store: firstStore, request: request(), prepare: () => {} });
    firstStore.close();

    const reopened = new EventStore(path);
    const prepare = vi.fn();
    try {
      expect(reopened.recoverOrphanedExecutions()).toBe(1);
      expect(() => admitCloseout({ store: reopened, request: request(), prepare })).toThrow(
        /failed before provider dispatch/i,
      );
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not replay an ambiguous provider attempt after restart recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mitzo-closeout-ambiguous-'));
    const path = join(root, 'events.db');
    const firstStore = new EventStore(path);
    firstStore.upsertSession({ sessionId: 'session-1', accountBinding: binding });
    const first = admitCloseout({ store: firstStore, request: request(), prepare: () => {} });
    firstStore.beginProviderAttempt(first.token, first.providerAttemptId);
    firstStore.close();

    const reopened = new EventStore(path);
    const prepare = vi.fn();
    try {
      expect(reopened.recoverOrphanedExecutions()).toBe(1);
      const retry = admitCloseout({ store: reopened, request: request(), prepare });
      expect(retry).toEqual({ ...first, duplicate: true });
      expect(prepare).not.toHaveBeenCalled();
      expect(reopened.getProviderAttempts(first.token)).toMatchObject([
        { phase: 'TERMINAL', terminalReason: 'ambiguous' },
      ]);
    } finally {
      reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fences closeout instead of overwriting an active user execution', () => {
    const store = new EventStore(':memory:');
    store.upsertSession({ sessionId: 'session-1', accountBinding: binding });
    store.beginExecution('session-1', 'user-turn');
    const prepare = vi.fn();
    try {
      expect(() => admitCloseout({ store, request: request(), prepare })).toThrow(
        /active execution/i,
      );
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
});
