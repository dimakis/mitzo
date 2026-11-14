import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '@mitzo/protocol/event-store';
import { begin, joinParticipant } from './fixtures/collaboration-navigation.js';
import { sessionConversationPage } from '../session-conversation-list.js';
import { SessionOverviewEmitter, type SessionOverviewDeps } from '../session-overview.js';
import { registerPending, removePending } from '@mitzo/harness';
import { conversationActivities } from '@mitzo/protocol';

let store: EventStore, directory: string, path: string;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-conversation-list-')));
  path = join(directory, 'events.db');
  store = new EventStore(path);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

it('lists one source after silent joins/first reply/restart and groups before pagination', () => {
  const group = begin(store);
  for (let i = 0; i < 4; i++) {
    joinParticipant(store, group, `peer-${i}`);
    store.upsertSession({ sessionId: `peer-${i}`, updatedAt: 3000 + i, numTurns: 1 });
  }
  store.upsertSession({ sessionId: 'source', updatedAt: 1000 });
  store.upsertSession({
    sessionId: 'standalone',
    conversationSource: 'mitzo',
    summary: 'Independent',
    updatedAt: 2000,
    numTurns: 1,
  });
  store.close();
  store = new EventStore(path);
  const page = sessionConversationPage(store, 0, 1);
  expect(page.hasMore).toBe(true);
  expect(page.sessions).toEqual([
    expect.objectContaining({
      id: 'source',
      summary: 'Original conversation',
      lastModified: 3003,
      participantSessionIds: ['peer-0', 'peer-1', 'peer-2', 'peer-3'],
    }),
  ]);
  expect(sessionConversationPage(store, 1, 1)).toMatchObject({
    sessions: [{ id: 'standalone' }],
    hasMore: false,
  });
  expect(store.getSession('peer-0')?.isHidden).toBe(false);
  expect(store.getEventsAfter('peer-0', 0)).toEqual([]);
});

it('preserves failed allocations, removed members and hidden/missing-source participants', () => {
  const group = begin(store);
  joinParticipant(store, group, 'failed', 'allocated');
  joinParticipant(store, group);
  expect(sessionConversationPage(store).sessions.map((s) => s.id)).toContain('failed');
  store.hideSession('source');
  expect(sessionConversationPage(store).sessions.map((s) => s.id)).toEqual(
    expect.arrayContaining(['peer', 'failed']),
  );
});

it('delivers actual permission attention through the emitter and Chats consumer without changing its owner', () => {
  const group = begin(store);
  joinParticipant(store, group);
  const emitter = new SessionOverviewEmitter({
    registry: {
      getActiveSessions: () => [
        {
          sessionId: 'peer',
          clientId: 'peer-client',
          mode: 'agent',
          attached: true,
          hasSnapshot: true,
          taskContext: null,
        },
      ],
    },
    sseRegistry: { broadcast: vi.fn(), sendTo: vi.fn() },
    taskStore: { getTree: () => [] },
    eventStore: store,
    getLoopStatus: () => ({
      state: 'idle',
      goalId: null,
      activeTaskId: null,
      progress: null,
      specMode: false,
      awaitingApproval: false,
      spawnEnabled: false,
    }),
    getSessionTitle: (id: string) => store.getSession(id)?.summary ?? undefined,
    isSessionHidden: (id: string) => store.isSessionHidden(id),
  } as unknown as SessionOverviewDeps);
  registerPending('navigation-permission', 'Read', vi.fn(), {}, undefined, 'peer');
  try {
    const raw = emitter.getSnapshot();
    expect(raw).toEqual([
      expect.objectContaining({
        sessionId: 'peer',
        state: 'waiting',
        waitReason: 'permission',
        presentationConversation: { id: 'source', title: 'Original conversation' },
      }),
    ]);
    expect(conversationActivities(raw)).toEqual([
      expect.objectContaining({
        sessionId: 'source',
        state: 'waiting',
        waitReason: 'permission',
        participantActivities: raw,
      }),
    ]);
    expect(raw[0].sessionId).toBe('peer');
  } finally {
    removePending('navigation-permission');
    emitter.destroy();
  }
});
