import { afterEach, expect, it, vi } from 'vitest';
import { createMitzoStore } from '../store.js';
import { SendOutbox } from '../send-outbox.js';
import { WS_READY_STATE } from '../types.js';
import type { WebSocketLike } from '../ws-connection.js';

const source = {
  kind: 'agent-library' as const,
  revision: 'a'.repeat(64),
  content: JSON.stringify({
    version: 1,
    source: {
      kind: 'draft',
      profileId: 'trace',
      baseRevision: 2,
      draftVersion: null,
      expectedVersion: 3,
    },
    definition: {
      name: '',
      role: 'agent',
      instructions: 'Diagnose with evidence.',
      expectedOutput: 'Diagnosis',
      acceptanceCriteria: ['Cite evidence'],
      modelPolicyRole: 'agent',
    },
  }),
};
class Socket implements WebSocketLike {
  readyState: number = WS_READY_STATE.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = WS_READY_STATE.CLOSED;
    this.onclose?.();
  }
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('recovers an ordinary Builder draft through the same reviewed HTTP command after a lost acknowledgement', async () => {
  vi.useFakeTimers();
  let disk: string | null = null;
  const storage = {
    getItem: () => disk,
    setItem: (_key: string, value: string) => {
      disk = value;
    },
  };
  const admitted = new Set<string>();
  const assignments = vi.fn();
  const commands: Record<string, unknown>[] = [];
  let recover = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/reviewed/send') {
      const command = JSON.parse(String(init?.body));
      commands.push(command);
      admitted.add(command.clientMsgId);
      if (!recover) throw Error('Accepted acknowledgement lost');
      return Response.json({
        accepted: true,
        clientMsgId: command.clientMsgId,
        sessionId: 'builder-chat',
      });
    }
    return Response.json(url.endsWith('/meta') ? {} : []);
  });
  function cold() {
    const socket = new Socket();
    const store = createMitzoStore({
      transport: { fetch },
      wsConfig: { buildUrl: () => 'ws://fixture', createWebSocket: () => socket },
      reviewedSendConfig: { url: '/reviewed/send', storage },
      sendHandoff: { prepare: () => true, assign: assignments, reject: () => {} },
      initiallyAuthenticated: false,
    });
    return { socket, store };
  }
  const first = cold();
  first.store.getState().restoreAuthentication();
  first.store.getState().sendMessage('Improve the diagnosis criteria.', {
    accountId: 'selected-account',
    model: 'offline-fixture',
    agentProfile: { kind: 'builtin', profileId: 'mitzo-profile-builder', revision: 1 },
    sourceSnapshots: [source],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(commands).toHaveLength(1);
  expect(first.socket.sent.filter((value) => value.type === 'send')).toEqual([]);
  expect(JSON.parse(disk!)[0]).toMatchObject({
    uncertain: true,
    body: { sourceSnapshots: [source] },
  });
  first.store.getState().invalidateAuthentication();
  recover = true;
  const restored = cold();
  try {
    restored.store.getState().restoreAuthentication();
    await vi.advanceTimersByTimeAsync(0);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(admitted.size).toBe(1);
    expect(assignments).toHaveBeenCalledWith(commands[0].clientMsgId, 'builder-chat', {
      kind: 'agent-library',
      revision: source.revision,
    });
    expect(JSON.parse(disk!)).toEqual([]);
  } finally {
    restored.store.getState().invalidateAuthentication();
  }
});

it('refuses an initial reviewed Library source when durable storage fails', () => {
  const outbox = new SendOutbox({
    url: '/send',
    fetch: vi.fn(),
    notify: vi.fn(),
    requireDurableBriefings: true,
    storage: {
      getItem: () => null,
      setItem: () => {
        throw Error('Quota exceeded');
      },
    },
  });
  expect(
    outbox.enqueue(
      {
        type: 'send',
        sessionId: null,
        clientMsgId: 'one',
        prompt: 'Improve criteria',
        sourceSnapshots: [source],
      },
      0,
    ),
  ).toBe(false);
});

it.each(['success', 'failure'] as const)(
  'finishes opening history when an accepted receipt replaces it with a %s restore',
  async (outcome) => {
    vi.useFakeTimers();
    let accept!: (response: Response) => void;
    const reads: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void }> =
      [];
    const fetch = vi.fn((url: string) => {
      if (url === '/reviewed/send')
        return new Promise<Response>((resolve) => {
          accept = resolve;
        });
      if (url.includes('/messages'))
        return new Promise<Response>((resolve, reject) => {
          reads.push({ resolve, reject });
        });
      return Promise.resolve(Response.json(url.endsWith('/meta') ? {} : []));
    });
    const socket = new Socket();
    const store = createMitzoStore({
      transport: { fetch },
      wsConfig: { buildUrl: () => 'ws://fixture', createWebSocket: () => socket },
      reviewedSendConfig: {
        url: '/reviewed/send',
        storage: { getItem: () => null, setItem: () => {} },
      },
    });
    try {
      store.getState().sendMessage('Continue the reviewed work.', {
        clientMsgId: 'reviewed-command',
        sourceSnapshots: [source],
      });
      await vi.advanceTimersByTimeAsync(0);
      const opening = store.getState().switchSession('builder-chat');
      expect(store.getState().historyLoading).toBe(true);
      accept(
        Response.json({
          accepted: true,
          clientMsgId: 'reviewed-command',
          sessionId: 'builder-chat',
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toHaveLength(2);
      if (outcome === 'success')
        reads[1].resolve(
          Response.json({
            messages: [{ messageId: 'saved', role: 'assistant', blocks: [] }],
            current: null,
            cursor: 12,
          }),
        );
      else reads[1].reject(Error('Disconnected during restore'));
      await vi.advanceTimersByTimeAsync(0);
      // The superseded opening response cannot replace the receipt's history.
      reads[0].resolve(
        Response.json({
          messages: [{ messageId: 'stale', role: 'assistant', blocks: [] }],
          current: null,
          cursor: 1,
        }),
      );
      await opening;
      expect(store.getState().historyLoading).toBe(false);
      expect(store.getState().historyError).toBe(
        outcome === 'failure' ? 'Could not restore this conversation. Please retry.' : null,
      );
      expect(store.getState().messages.messages.map((message) => message.messageId)).toEqual(
        outcome === 'success' ? ['saved'] : [],
      );
    } finally {
      store.getState().invalidateAuthentication();
    }
  },
);
