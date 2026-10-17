import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { replayEventsToMessages, replayEventsToTranscript } from '../chat.js';
import { createTelosConversationSource } from '../telos-conversation-source.js';
import { compileCollaborationSourceContext } from '../collaboration-context-compiler.js';
import { nativeSourceWriter } from './fixtures/telos-native-source.js';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const f = createTelosSourceApprovalData();
  cleanup.push(() => f.close());
  const source = createTelosConversationSource({
    events: f.events,
    artifacts: f.artifacts,
    authorize: () => true,
  });
  const selection = (
    sequence: number,
    messageId: string,
    mode: 'selected' | 'conversation_so_far' = 'conversation_so_far',
    sessionId = 'planning',
  ) => ({
    requestId: randomUUID(),
    expectedMembershipRevision: 0,
    sourceConversationId: sessionId,
    mode,
    boundary: { sequence, messageId },
    messageIds: mode === 'selected' ? [messageId] : [],
    artifacts: [],
    purpose: 'Retain reviewed source',
    joiningBrief: '',
  });
  const replays = (sessionId = 'planning', initialPrompt?: string) => {
    const rows = f.events.getSessionEvents(sessionId);
    return [
      replayEventsToMessages(rows, initialPrompt),
      replayEventsToTranscript(rows, initialPrompt).messages,
    ];
  };
  const append = (type: string, payload: Record<string, unknown>) =>
    f.events.append('planning', type, payload);
  return { ...f, source, selection, replays, append };
}
const runtime = { v: 2, type: 'error', sessionId: 'planning', error: 'Public runtime failure' };
const provider = {
  providerFailure: { category: 'transport', message: 'PRIVATE_UPSTREAM_DIAGNOSTIC' },
  error: 'PRIVATE_UPSTREAM_DIAGNOSTIC',
};
const publicCases = [
  { name: 'ordinary provider', native: false, payload: provider, prefix: 'provider-error' },
  {
    name: 'ordinary malformed truthy provider',
    native: false,
    payload: { providerFailure: 'PRIVATE_UPSTREAM_DIAGNOSTIC' },
    prefix: 'provider-error',
  },
  { name: 'ordinary accepted runtime', native: false, payload: runtime, prefix: 'runtime-error' },
  {
    name: 'native provider without accepted echo',
    native: true,
    payload: provider,
    prefix: 'provider-error',
  },
  {
    name: 'native malformed truthy provider',
    native: true,
    payload: { providerFailure: {} },
    prefix: 'provider-error',
  },
  { name: 'native accepted runtime', native: true, payload: runtime, prefix: 'runtime-error' },
];

it.each(publicCases)(
  'refuses the canonically public $name inside a complete prefix while preserving selected messages',
  async ({ native, payload, prefix }) => {
    const f = fixture();
    const earlier = f.events.getSessionEvents('planning').at(-1)!;
    let errorSequence: number;
    if (native) {
      const writer = nativeSourceWriter(f.events, 'planning');
      if (prefix === 'runtime-error')
        f.events.appendSymposium(
          'planning',
          'user_message',
          { messageId: 'seat-user', text: '' },
          writer.provenance[0],
        );
      writer.start(0, 'native-answer', 'Closed native public answer');
      writer.end(0, 'native-answer');
      errorSequence = f.events.appendSymposium('planning', 'error', payload, writer.provenance[0]);
    } else errorSequence = f.append('error', payload);
    const boundary = f.append('user_message', { messageId: 'after-error', text: 'Try again.' });
    for (const replay of f.replays()) {
      const error = replay.find((message) => message.messageId === `${prefix}-${errorSequence}`)!;
      expect(error).toMatchObject({
        role: 'assistant',
        startedSeq: errorSequence,
        blocks: [{ blockId: `${prefix}-text-${errorSequence}`, blockType: 'text' }],
      });
      expect(error.blocks[0].content).toMatch(/^\*\*Error:\*\* /);
      expect(JSON.stringify(error)).not.toContain('PRIVATE_UPSTREAM_DIAGNOSTIC');
      expect(replay.at(-1)?.messageId).toBe('after-error');
    }
    const before = f.retainedOwnerCounts();
    await expect(
      compileCollaborationSourceContext(f.selection(boundary, 'after-error'), f.source),
    ).rejects.toThrow(/public error/i);
    expect(f.retainedOwnerCounts()).toEqual(before);
    const selected = await compileCollaborationSourceContext(
      f.selection(boundary, 'after-error', 'selected'),
      f.source,
    );
    expect(selected.messages.map((message) => message.messageId)).toEqual(['after-error']);
    expect(JSON.stringify(selected)).not.toMatch(
      /PRIVATE_UPSTREAM_DIAGNOSTIC|Public runtime failure/,
    );
    const earlierPrefix = await compileCollaborationSourceContext(
      f.selection(earlier.seq, String(earlier.payload.messageId)),
      f.source,
    );
    expect(earlierPrefix.messages.map((message) => message.messageId)).toEqual([
      'before',
      'approved',
      'after',
    ]);
    await expect(
      f.source.openConversation({
        ...f.selection(boundary, 'after-error', 'selected'),
        messageIds: [`${prefix}-${errorSequence}`],
      }),
    ).rejects.toThrow();
  },
);

const privateCases = [
  { name: 'borrowed message-only diagnostic', payload: { message: 'Visible provider failure' } },
  { name: 'wrong version', payload: { ...runtime, v: 1 } },
  { name: 'wrong type', payload: { ...runtime, type: 'other' } },
  { name: 'missing session', payload: { ...runtime, sessionId: undefined } },
  { name: 'foreign session', payload: { ...runtime, sessionId: 'foreign' } },
  { name: 'unaccepted client command', payload: { ...runtime, clientMsgId: 'unaccepted' } },
  { name: 'null client command', payload: { ...runtime, clientMsgId: null } },
  { name: 'blank runtime', payload: { ...runtime, error: ' \n ' } },
  { name: 'nonstring runtime', payload: { ...runtime, error: { message: 'PRIVATE_RUNTIME' } } },
];
it.each(privateCases)(
  'keeps $name private without ending the real completed turn',
  async ({ payload }) => {
    const f = fixture();
    f.append('message_start', { messageId: 'answer' });
    f.append('block_start', { messageId: 'answer', blockId: 'public', blockType: 'text' });
    f.append('block_delta', { messageId: 'answer', blockId: 'public', delta: 'Public answer' });
    f.append('error', payload);
    f.append('block_end', { messageId: 'answer', blockId: 'public', blockType: 'text' });
    const boundary = f.append('message_end', { messageId: 'answer' });
    for (const replay of f.replays())
      expect(replay.map((message) => message.messageId)).toEqual([
        'before',
        'approved',
        'after',
        'answer',
      ]);
    const context = await compileCollaborationSourceContext(
      f.selection(boundary, 'answer'),
      f.source,
    );
    expect(context.messages.map((message) => message.messageId)).toEqual([
      'before',
      'approved',
      'after',
      'answer',
    ]);
    expect(context.messages.at(-1)?.blocks[0].content).toBe('Public answer');
    expect(JSON.stringify(context)).not.toMatch(
      /Visible provider failure|Public runtime failure|PRIVATE_RUNTIME/,
    );
  },
);

it.each(['none', 'metadata-only', 'foreign-user-payload'] as const)(
  'does not authorize runtime feedback from %s accepted-user evidence',
  async (kind) => {
    const f = fixture();
    const sessionId = 'unaccepted';
    const initialPrompt = kind === 'metadata-only' ? 'Metadata prompt' : undefined;
    f.events.upsertSession({ sessionId, conversationSource: 'mitzo', initialPrompt });
    if (kind === 'foreign-user-payload')
      f.events.append(sessionId, 'user_message', {
        messageId: 'foreign-user',
        text: 'Rendered but not accepted proof',
        sessionId: 'foreign',
      });
    f.events.append(sessionId, 'error', { ...runtime, sessionId });
    const boundary = f.events.append(sessionId, 'user_message', {
      messageId: 'later',
      text: initialPrompt ?? 'Later accepted input',
    });
    for (const replay of f.replays(sessionId, initialPrompt))
      expect(replay.some((message) => message.messageId.startsWith('runtime-error-'))).toBe(false);
    const context = await compileCollaborationSourceContext(
      f.selection(boundary, 'later', 'conversation_so_far', sessionId),
      f.source,
    );
    expect(context.messages.at(-1)?.messageId).toBe('later');
    expect(JSON.stringify(context)).not.toContain('Public runtime failure');
  },
);

it.each(['ordinary', 'other-seat', 'changed-full-snapshot'] as const)(
  'keeps native runtime acceptance separate from %s echoes',
  async (origin) => {
    const f = fixture();
    const writer = nativeSourceWriter(f.events, 'planning');
    if (origin !== 'ordinary')
      f.events.appendSymposium(
        'planning',
        'user_message',
        { messageId: 'native-user', text: 'Seat input' },
        writer.provenance[origin === 'other-seat' ? 1 : 0],
      );
    const seq = f.events.appendSymposium('planning', 'error', runtime, writer.provenance[0]);
    if (origin === 'changed-full-snapshot') {
      const db = new Database(join(dirname(f.dbPath), 'events.db'));
      try {
        db.prepare('UPDATE events SET symposium_provenance=? WHERE seq=?').run(
          JSON.stringify({ ...writer.provenance[0], configRevision: 2 }),
          seq,
        );
      } finally {
        db.close();
      }
    }
    const boundary = f.append('user_message', { messageId: 'later', text: 'Later ordinary input' });
    for (const replay of f.replays())
      expect(replay.some((message) => message.messageId === `runtime-error-${seq}`)).toBe(false);
    const context = await compileCollaborationSourceContext(
      f.selection(boundary, 'later'),
      f.source,
    );
    expect(JSON.stringify(context)).not.toContain('Public runtime failure');
  },
);

it('invalidates an existing prefix witness when a previously private retained error becomes public', async () => {
  const f = fixture();
  const seq = f.append('error', { message: 'Private diagnostic' });
  const boundary = f.append('user_message', { messageId: 'later', text: 'Later input' });
  const opened = await f.source.openConversation(f.selection(boundary, 'later'));
  expect((await opened.readPrefixWitness()).messageCount).toBe(4);
  const db = new Database(join(dirname(f.dbPath), 'events.db'));
  try {
    db.prepare('UPDATE events SET payload=? WHERE seq=?').run(JSON.stringify(provider), seq);
  } finally {
    db.close();
  }
  await expect(opened.readPrefixWitness()).rejects.toThrow(/public error/i);
  await expect(opened.assertCurrent()).rejects.toThrow(/public error/i);
});

it.each(
  [provider, runtime].flatMap((payload) =>
    (['create', 'adopt'] as const).map((kind) => ({ payload, kind })),
  ),
)(
  'refuses public-error $kind before any retained or canonical mutation',
  async ({ payload, kind }) => {
    const f = fixture();
    f.append('error', payload);
    const sequence = f.append('user_message', { messageId: 'later', text: 'Try again' });
    const permission = await f.request({ kind, marker: 'sdk' });
    const permId = String(permission.permId);
    const review = await f.service.review(permId, 'planning', f.actor);
    const input = {
      sessionId: 'planning',
      requestId: randomUUID(),
      proposalSha256: review.proposalSha256,
      selection: {
        mode: 'conversation_so_far',
        boundary: { sequence, messageId: 'later' },
        messageIds: [],
        artifacts: [],
      },
    };
    const before = f.retainedOwnerCounts();
    await expect(f.service.preview(permId, input, f.actor)).rejects.toThrow(/public error/i);
    await expect(
      f.service.approve(permId, { ...input, previewSha256: '0'.repeat(64) }, f.actor),
    ).rejects.toThrow(/public error/i);
    expect(f.retainedOwnerCounts()).toEqual(before);
    const selected = {
      ...input,
      selection: { ...input.selection, mode: 'selected', messageIds: ['later'] },
    };
    const preview = await f.service.preview(permId, selected, f.actor);
    const receipt = await f.service.approve(
      permId,
      { ...selected, previewSha256: preview.preview.sha256 },
      f.actor,
    );
    expect(receipt.canonicalCreation?.created).toBe(kind === 'create' ? true : undefined);
    expect(f.counts().canonicalCreates).toBe(kind === 'create' ? 1 : 0);
    expect(
      f.receiptSource(receipt).packet.context.messages.map((message) => message.messageId),
    ).toEqual(['later']);
    expect(JSON.stringify(f.receiptSource(receipt).packet)).not.toMatch(
      /PRIVATE_UPSTREAM_DIAGNOSTIC|Public runtime failure/,
    );
  },
);

it.each([provider, runtime])(
  'preserves bounded refusal for selected history interrupted by a public error without a terminal',
  async (payload) => {
    const f = fixture();
    f.append('message_start', { messageId: 'interrupted' });
    f.append('block_start', { messageId: 'interrupted', blockId: 'unfinished', blockType: 'text' });
    f.append('block_delta', {
      messageId: 'interrupted',
      blockId: 'unfinished',
      delta: 'Partial public reply',
    });
    const sequence = f.append('error', payload);
    const boundary = f.append('user_message', { messageId: 'later', text: 'Try again.' });
    const modern = replayEventsToTranscript(f.events.getSessionEvents('planning'));
    expect(modern.current).toBeNull();
    expect(
      modern.messages.find((message) => message.messageId === 'interrupted')?.blocks[0].content,
    ).toBe('Partial public reply');
    const prefix = 'providerFailure' in payload ? 'provider-error' : 'runtime-error';
    expect(modern.messages.slice(-2).map((message) => message.messageId)).toEqual([
      `${prefix}-${sequence}`,
      'later',
    ]);
    // Legacy REST may hoist the later user echo as its initial prompt when no
    // message_end was ever retained; both replay paths still expose this error.
    for (const replay of f.replays()) {
      expect(replay.some((message) => message.messageId === `${prefix}-${sequence}`)).toBe(true);
      expect(replay.some((message) => message.messageId === 'later')).toBe(true);
    }
    const before = f.retainedOwnerCounts();
    await expect(f.source.openConversation(f.selection(boundary, 'later'))).rejects.toThrow(
      /before the error/,
    );
    // Canonical replay can display the interrupted partial turn. The bounded
    // capture contract still requires its retained message/block terminals.
    await expect(
      f.source.openConversation(f.selection(boundary, 'later', 'selected')),
    ).rejects.toThrow('Source selection is unavailable or changed');
    expect(f.retainedOwnerCounts()).toEqual(before);
  },
);
