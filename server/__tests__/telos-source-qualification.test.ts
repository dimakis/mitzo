import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { SymposiumProvenanceSchema } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { replayEventsToMessages, replayEventsToTranscript } from '../chat.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import { createTelosConversationSource } from '../telos-conversation-source.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture(initialPrompt?: string) {
  const root = mkdtempSync(join(tmpdir(), 'telos-source-qualification-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const events = new EventStore(join(root, 'events.db'));
  cleanup.push(() => events.close());
  events.upsertSession({ sessionId: 'origin', conversationSource: 'mitzo', initialPrompt });
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.exec(
    "CREATE TABLE items(id TEXT PRIMARY KEY); INSERT INTO items VALUES('item'); CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT)",
  );
  db.close();
  const artifacts = new TelosArtifactStore(path);
  cleanup.push(() => artifacts.close());
  const source = createTelosConversationSource({ events, artifacts, authorize: () => true });
  const append = (type: string, payload: Record<string, unknown>) =>
    events.append('origin', type, payload);
  const assistant = (id: string, close = true) => {
    append('message_start', { messageId: id });
    append('block_start', { messageId: id, blockId: id + '-text', blockType: 'text' });
    append('block_delta', { messageId: id, blockId: id + '-text', delta: 'Visible answer' });
    if (close) append('block_end', { messageId: id, blockId: id + '-text', blockType: 'text' });
    return append('message_end', { messageId: id });
  };
  const selection = (
    sequence: number,
    messageId: string,
    mode: 'selected' | 'conversation_so_far' = 'selected',
  ) => ({
    requestId: randomUUID(),
    expectedMembershipRevision: 0,
    sourceConversationId: 'origin',
    boundary: { sequence, messageId },
    mode,
    messageIds: mode === 'selected' ? [messageId] : [],
    artifacts: [],
    purpose: 'Save reviewed source',
    joiningBrief: '',
  });
  const replay = () => replayEventsToTranscript(events.getSessionEvents('origin'), initialPrompt);
  const provenance = (sequence: number, raw: unknown) => {
    const parsed = SymposiumProvenanceSchema.parse(raw);
    const db = new Database(join(root, 'events.db'));
    try {
      db.prepare('UPDATE events SET seat_id=?,symposium_provenance=? WHERE seq=?').run(
        parsed.seatId,
        JSON.stringify(parsed),
        sequence,
      );
    } finally {
      db.close();
    }
  };
  return { events, source, append, assistant, selection, replay, provenance };
}

const markers = [
  { seatId: null },
  { seatId: 'unverified' },
  { symposiumProvenance: null },
  { symposiumProvenance: { seatId: 'unverified' } },
];
it.each(
  markers.flatMap((marker) =>
    (['selected', 'conversation_so_far'] as const).map((mode) => ({ marker, mode })),
  ),
)('refuses unverified payload attribution $marker in $mode mode', async ({ marker, mode }) => {
  const f = fixture();
  const sequence = f.append('user_message', {
    messageId: 'marked',
    text: 'Not qualified as ordinary text',
    ...marker,
  });
  expect(f.replay).toThrow('unverifiable Symposium attribution');
  await expect(f.source.openConversation(f.selection(sequence, 'marked', mode))).rejects.toThrow();
});
it('preserves host recipient bookkeeping without inventing transcript authors', async () => {
  const f = fixture();
  f.append('symposium_delivery_dispatched', { seatId: 'recipient' });
  f.append('symposium_thread_migrated', { seatId: 'recipient' });
  const sequence = f.append('user_message', { messageId: 'user', text: 'Ordinary text' });
  const opened = await f.source.openConversation(f.selection(sequence, 'user'));
  expect((await opened.readSelected(['user'])).map((message) => message.messageId)).toEqual(
    f.replay().messages.map((message) => message.messageId),
  );
});
it('fences changed initial-prompt metadata even when selected text remains byte-identical', async () => {
  const f = fixture();
  const sequence = f.append('user_message', { messageId: 'user', text: 'Question' });
  const opened = await f.source.openConversation(f.selection(sequence, 'user'));
  f.events.upsertSession({ sessionId: 'origin', initialPrompt: 'Question' });
  await expect(opened.assertCurrent()).rejects.toThrow();
});
it.each(['message_start', 'block_start', 'block_delta', 'block_end', 'message_end'])(
  'qualifies attribution before filtering an assistant %s event',
  async (markedType) => {
    const f = fixture();
    const user = f.append('user_message', { messageId: 'user', text: 'Selected ordinary text' });
    for (const [type, fields] of [
      ['message_start', {}],
      ['block_start', { blockId: 'text', blockType: 'text' }],
      ['block_delta', { blockId: 'text', delta: 'Ambiguous answer' }],
      ['block_end', { blockId: 'text', blockType: 'text' }],
      ['message_end', {}],
    ] as const)
      f.append(type, {
        messageId: 'assistant',
        ...fields,
        ...(type === markedType ? { seatId: null } : {}),
      });
    const sequence = f.append('user_message', { messageId: 'last', text: 'Later ordinary text' });
    expect(f.replay).toThrow('unverifiable Symposium attribution');
    await expect(
      f.source.openConversation({ ...f.selection(sequence, 'last'), messageIds: ['user'] }),
    ).rejects.toThrow();
    // Attribution added after the selected boundary must not invalidate that earlier prefix.
    const earlier = await f.source.openConversation(f.selection(user, 'user'));
    expect((await earlier.readSelected(['user']))[0].blocks[0].content).toBe(
      'Selected ordinary text',
    );
  },
);
it.each([undefined, 'Question'])(
  'preserves normal chat operator block identity with initialPrompt=%s',
  async (initialPrompt) => {
    const f = fixture(initialPrompt);
    const sequence = f.append('user_message', { messageId: 'user', text: 'Question' });
    const opened = await f.source.openConversation(f.selection(sequence, 'user'));
    expect((await opened.readSelected(['user']))[0].blocks.map((block) => block.blockId)).toEqual(
      f.replay().messages[0].blocks.map((block) => block.blockId),
    );
  },
);
it.each(['selected', 'conversation_so_far'] as const)(
  'refuses a metadata-only initial prompt that has no durable boundary in %s mode',
  async (mode) => {
    const f = fixture('Original visible prompt');
    const sequence = f.assistant('answer');
    expect(f.replay().messages[0]).toMatchObject({ messageId: 'umsg-initial', role: 'user' });
    await expect(
      f.source.openConversation(f.selection(sequence, 'answer', mode)),
    ).rejects.toThrow();
  },
);
it.each(['selected', 'conversation_so_far'] as const)(
  'refuses a delayed initial prompt whose canonical display order differs in %s mode',
  async (mode) => {
    const f = fixture();
    f.append('message_start', { messageId: 'answer' });
    f.append('block_start', { messageId: 'answer', blockId: 'text', blockType: 'text' });
    f.append('block_delta', { messageId: 'answer', blockId: 'text', delta: 'Answer' });
    f.append('user_message', { messageId: 'delayed', text: 'Legacy initial prompt' });
    f.append('block_end', { messageId: 'answer', blockId: 'text', blockType: 'text' });
    const sequence = f.append('message_end', { messageId: 'answer' });
    expect(f.replay().messages.map((message) => message.messageId)).toEqual(['delayed', 'answer']);
    await expect(
      f.source.openConversation(f.selection(sequence, 'answer', mode)),
    ).rejects.toThrow();
  },
);
it.each(['selected', 'conversation_so_far'] as const)(
  'refuses an unclosed block that the accepted bounded source cannot qualify in %s mode',
  async (mode) => {
    const f = fixture();
    const sequence = f.assistant('incomplete', false);
    // Reconnect preserves readable legacy text, but REST and the bounded
    // source owner cannot qualify it as one completed public source block.
    expect(f.replay().messages[0].blocks[0].content).toBe('Visible answer');
    expect(replayEventsToMessages(f.events.getSessionEvents('origin'))).toEqual([]);
    expect(() =>
      f.events
        .openCollaborationVisibleSource('origin', { sequence, messageId: 'incomplete' })
        .readSelected(['incomplete']),
    ).toThrow('snapshot_changed');
    await expect(
      f.source.openConversation(f.selection(sequence, 'incomplete', mode)),
    ).rejects.toThrow();
  },
);
it('keeps closed public blocks in the exact normal-chat order', async () => {
  const f = fixture();
  f.append('message_start', { messageId: 'answer' });
  for (const blockId of ['first', 'second']) {
    f.append('block_start', { messageId: 'answer', blockId, blockType: 'text' });
    f.append('block_delta', { messageId: 'answer', blockId, delta: blockId });
  }
  for (const blockId of ['second', 'first'])
    f.append('block_end', { messageId: 'answer', blockId, blockType: 'text' });
  const sequence = f.append('message_end', { messageId: 'answer' });
  const opened = await f.source.openConversation(f.selection(sequence, 'answer'));
  expect((await opened.readSelected(['answer']))[0].blocks.map((block) => block.blockId)).toEqual(
    f.replay().messages[0].blocks.map((block) => block.blockId),
  );
});

const native = {
  seatId: 'builder',
  membershipGeneration: 1,
  configRevision: 1,
  accountProfileRevision: 'account-1',
  seatProfileRevision: 'profile-1',
  contextGrantRevision: 1,
  authorityGrantRevision: 1,
  isolationDomainId: 'shared',
  isolationDomainRevision: 1,
};
it.each(
  ['block_start', 'block_delta', 'block_end', 'message_end'].flatMap((type) =>
    ['configRevision', 'accountProfileRevision', 'contextGrantRevision'].map((field) => ({
      type,
      field,
    })),
  ),
)(
  'refuses a native $field snapshot change at $type before selected-message filtering',
  async ({ type, field }) => {
    const f = fixture();
    const earlier = f.append('user_message', {
      messageId: 'earlier',
      text: 'Earlier ordinary text',
    });
    const sequence = f.assistant('native');
    const rows = f.events
      .getSessionEvents('origin')
      .filter((event) => event.payload.messageId === 'native');
    for (const row of rows) f.provenance(row.seq, native);
    const opened = await f.source.openConversation(f.selection(sequence, 'native'));
    expect((await opened.readSelected(['native']))[0].blocks[0].content).toBe('Visible answer');
    const changed = { ...native, [field]: field === 'accountProfileRevision' ? 'account-2' : 2 };
    f.provenance(rows.find((event) => event.type === type)!.seq, changed);
    expect(f.replay).toThrow(/snapshot|provenance|seat/);
    await expect(opened.assertCurrent()).rejects.toThrow();
    const last = f.append('user_message', { messageId: 'later', text: 'Later ordinary text' });
    for (const mode of ['selected', 'conversation_so_far'] as const)
      await expect(
        f.source.openConversation({
          ...f.selection(last, 'later', mode),
          messageIds: mode === 'selected' ? ['earlier'] : [],
        }),
      ).rejects.toThrow();
    const preserved = await f.source.openConversation(f.selection(earlier, 'earlier'));
    expect((await preserved.readSelected(['earlier']))[0].blocks[0].content).toBe(
      'Earlier ordinary text',
    );
  },
);
it.each(['thinking', 'tool_use'])(
  'refuses a public block ID reused for %s without copying private deltas',
  async (blockType) => {
    const f = fixture();
    f.append('message_start', { messageId: 'mixed' });
    f.append('block_start', { messageId: 'mixed', blockId: 'reused', blockType: 'text' });
    f.append('block_delta', { messageId: 'mixed', blockId: 'reused', delta: 'Public text' });
    f.append('block_start', { messageId: 'mixed', blockId: 'reused', blockType });
    f.append('block_delta', {
      messageId: 'mixed',
      blockId: 'reused',
      delta: 'PRIVATE REUSED DELTA',
    });
    f.append('block_end', { messageId: 'mixed', blockId: 'reused', blockType });
    const sequence = f.append('message_end', { messageId: 'mixed' });
    expect(f.replay().messages[0].blocks[0].blockType).toBe(blockType);
    expect(() =>
      f.events
        .openCollaborationVisibleSource('origin', { sequence, messageId: 'mixed' })
        .readSelected(['mixed']),
    ).toThrow('snapshot_changed');
    for (const mode of ['selected', 'conversation_so_far'] as const)
      await expect(
        f.source.openConversation(f.selection(sequence, 'mixed', mode)),
      ).rejects.toThrow();
  },
);
