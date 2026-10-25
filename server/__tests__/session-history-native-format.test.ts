import { expect, it, vi } from 'vitest';
import type { SymposiumConfig } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { sessionHistoryTools, type HistoryAccess } from '../session-history-tools.js';
import { SymposiumNativeEventSink } from '../symposium-native-event-sink.js';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';

const unsupported =
  'Session history format is unsupported for this bounded read; no page or continuation cursor was delivered.';
const call = { turnId: 'offline-turn', callId: 'offline-call' };
function reader(store: EventStore) {
  const current = vi.fn();
  const access: HistoryAccess = {
    signal: new AbortController().signal,
    assertCurrent: current,
    assertCurrentAsync: vi.fn(async () => current()),
    authorizeSearch: vi.fn(async () => {}),
    authorizeRead: vi.fn(async () => ({ assertCurrent: current })),
    readBoundary: vi.fn((id) => store.captureReconnectState(id, 0, false).cursor),
    dispose: vi.fn(),
  };
  const project = vi.fn((text: string) => text);
  const tools = sessionHistoryTools({ store, capture: () => access, projectPublicText: project });
  const read = (request: Record<string, unknown> = {}) =>
    tools.execute(
      'ReadPastSession',
      { conversationId: 'past-native', ...request },
      new AbortController().signal,
      call,
    );
  return { access, project, read };
}

// The actual sink and EventStore persist the producer's exact format. Only its
// accepted-attempt lookups are fixture receipts; no provider or executor runs.
function persistNativeFormat(store: EventStore) {
  const seat = (id: string, role: 'primary' | 'reviewer') => ({
    id,
    role,
    name: id,
    model: 'offline-model',
    systemPrompt: 'Offline fixture',
    color: '#334455',
    accountBinding: {
      accountId: id,
      accountLabel: 'Offline',
      provider: 'openai' as const,
      model: 'offline-model',
      profileRevision: 'account-1',
    },
    profileBinding: { profileId: id, profileRevision: 'profile-1' },
    contextGrant: {
      grantId: 'context',
      revision: 1,
      classification: 'work' as const,
      sourceRefs: [],
    },
    authorityGrant: {
      grantId: 'authority',
      revision: 1,
      filesystem: 'read' as const,
      tools: 'read' as const,
      network: 'restricted' as const,
    },
    isolationRequest: {
      trustDomainId: 'offline',
      revision: 1,
      placement: 'reuse-compatible' as const,
    },
  });
  const config: SymposiumConfig = {
    version: 1,
    revision: 1,
    state: 'active',
    seats: [seat('primary', 'primary'), seat('reviewer', 'reviewer')],
    turnRules: { mode: 'directed', maxTurns: 2 },
    interceptMode: 'manual',
  };
  store.upsertSession({ sessionId: 'past-native', accountBinding: config.seats[0].accountBinding });
  store.setSymposiumConfig('past-native', config);
  const provenance = {
    seatId: 'primary',
    configRevision: 1,
    accountProfileRevision: 'account-1',
    seatProfileRevision: 'profile-1',
    contextGrantRevision: 1,
    authorityGrantRevision: 1,
    isolationDomainId: 'offline',
    isolationDomainRevision: 1,
  };
  const execution = {
    sessionId: 'past-native',
    deliveryId: 'offline-delivery',
    claimToken: 'offline-claim',
    seat: config.seats[0],
    provenance,
  } as SymposiumSeatExecution;
  const attempt = vi.spyOn(store, 'getSymposiumRecipientAttemptByClaimToken').mockReturnValue({
    deliveryId: execution.deliveryId,
    seatId: 'primary',
    acceptedAt: 1,
    status: 'executing',
    provenance,
  } as never);
  const delivery = vi
    .spyOn(store, 'getSymposiumDelivery')
    .mockReturnValue({ sessionId: 'past-native' } as never);
  const sink = new SymposiumNativeEventSink(store, () => {});
  const emit = (event: Record<string, unknown>) =>
    sink.record(execution, { type: 'stream_event', event });
  emit({ type: 'message_start', message: { id: 'native-message' } });
  for (const [index, type, initial, delta] of [
    [0, 'thinking', 'PRIVATE initial reasoning', 'PRIVATE later reasoning'],
    [1, 'text', 'Visible initial answer', 'Visible later answer'],
  ] as const) {
    emit({
      type: 'content_block_start',
      index,
      content_block: { type, ...(type === 'thinking' ? { thinking: initial } : { text: initial }) },
    });
    emit({
      type: 'content_block_delta',
      index,
      delta: {
        type: type === 'thinking' ? 'thinking_delta' : 'text_delta',
        ...(type === 'thinking' ? { thinking: delta } : { text: delta }),
      },
    });
    emit({ type: 'content_block_stop', index });
  }
  emit({ type: 'message_stop', message: { id: 'native-message' } });
  attempt.mockRestore();
  delivery.mockRestore();
}

it('explicitly refuses actual persisted native Symposium text/reasoning across first, one-event and midstream pages', async () => {
  const store = new EventStore(':memory:');
  try {
    store.upsertSession({ sessionId: 'past-native', conversationSource: 'mitzo' });
    persistNativeFormat(store);
    const persisted = store.getEventsAfter('past-native', 0, 100);
    const untyped = persisted.filter((event) => event.type === 'block_delta');
    expect(untyped).toHaveLength(4);
    expect(untyped.every((event) => event.payload.blockType === undefined)).toBe(true);
    expect(untyped.map((event) => event.payload.delta)).toContain('Visible later answer');
    const f = reader(store);
    const queries = vi.spyOn(store, 'getEventsAfter');
    for (const afterSeq of [
      0,
      ...untyped.map((event) => store.getSessionPredecessorSeq('past-native', event.seq)),
    ]) {
      const result = await f.read({ afterSeq, limit: 1 });
      expect(result).toEqual({ content: unsupported, isError: true });
      expect(result!.content).not.toMatch(/PRIVATE|Visible|nextAfterSeq/);
    }
    expect(await f.read()).toEqual({ content: unsupported, isError: true });
    expect(queries.mock.calls.every(([, , limit]) => limit === 2 || limit === 101)).toBe(true);
    expect(f.project).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

it.each([undefined, null, 'unknown'])(
  'refuses unresolved/unrecognized block type %s within the bounded page without partial entries or advancing a cursor',
  async (blockType) => {
    const store = new EventStore(':memory:');
    try {
      store.upsertSession({ sessionId: 'past-native', conversationSource: 'mitzo' });
      const prefix = store.append('past-native', 'user_message', {
        text: 'Public prefix that must not be partially delivered',
      });
      const unresolved = store.append('past-native', 'block_delta', {
        messageId: 'm',
        blockId: 'b',
        ...(blockType === undefined ? {} : { blockType }),
        delta: 'PRIVATE unclassified reasoning or text',
      });
      const f = reader(store);
      const queries = vi.spyOn(store, 'getEventsAfter');
      const all = vi.spyOn(store, 'getSessionEvents').mockImplementation(() => {
        throw Error('Unbounded history scan forbidden');
      });
      expect(await f.read()).toEqual({ content: unsupported, isError: true });
      expect(await f.read({ afterSeq: prefix, limit: 1, throughSeq: unresolved })).toEqual({
        content: unsupported,
        isError: true,
      });
      expect(queries).toHaveBeenCalledWith('past-native', prefix, 2);
      expect(all).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  },
);

it('requires target authorization before any native transcript/format query', async () => {
  const store = new EventStore(':memory:');
  try {
    store.upsertSession({ sessionId: 'past-native', conversationSource: 'mitzo' });
    persistNativeFormat(store);
    const f = reader(store);
    vi.mocked(f.access.authorizeRead).mockRejectedValue(Error('Denied'));
    const queries = vi.spyOn(store, 'getEventsAfter');
    const result = await f.read();
    expect(result?.isError).toBe(true);
    expect(result?.content).not.toBe(unsupported);
    expect(queries).not.toHaveBeenCalled();
    expect(f.access.readBoundary).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

it('rechecks the current target before disclosing an unsupported-format result', async () => {
  const store = new EventStore(':memory:');
  try {
    store.upsertSession({ sessionId: 'past-native', conversationSource: 'mitzo' });
    persistNativeFormat(store);
    const f = reader(store);
    let refreshed = 0;
    vi.mocked(f.access.assertCurrentAsync).mockImplementation(async () => {
      if (++refreshed === 4) throw Error('Current owner revoked');
    });
    const result = await f.read();
    expect(result?.isError).toBe(true);
    expect(result?.content).not.toBe(unsupported);
    expect(result?.content).not.toMatch(/PRIVATE|Visible|nextAfterSeq/);
    expect(refreshed).toBe(4);
  } finally {
    store.close();
  }
});

it('retains supported ordinary typed text/exclusions and ignores unsupported future rows beyond throughSeq', async () => {
  const store = new EventStore(':memory:');
  try {
    store.upsertSession({ sessionId: 'past-native', conversationSource: 'mitzo' });
    store.append('past-native', 'block_delta', {
      blockType: 'redacted_thinking',
      delta: 'PRIVATE typed redacted reasoning',
    });
    store.append('past-native', 'block_delta', {
      blockType: 'thinking',
      delta: 'PRIVATE typed reasoning',
    });
    store.append('past-native', 'block_delta', {
      blockType: 'tool_use',
      delta: 'PRIVATE tool input',
    });
    const boundary = store.append('past-native', 'block_delta', {
      blockType: 'text',
      delta: 'Public supported answer',
    });
    store.append('past-native', 'block_delta', { delta: 'PRIVATE future unknown type' });
    const f = reader(store);
    const result = await f.read({ throughSeq: boundary });
    expect(result?.isError).toBe(false);
    expect(JSON.parse(result!.content)).toEqual({
      conversationId: 'past-native',
      throughSeq: boundary,
      entries: [{ seq: boundary, kind: 'assistant', text: 'Public supported answer' }],
      nextAfterSeq: null,
    });
    expect(f.project).toHaveBeenCalledExactlyOnceWith('Public supported answer');
  } finally {
    store.close();
  }
});
