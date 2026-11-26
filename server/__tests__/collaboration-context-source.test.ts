import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { compileCollaborationContext } from '../collaboration-context-compiler.js';
import { createCollaborationContextSource } from '../collaboration-context-source.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const settings = {
  binding: {
    version: 2,
    account: { accountId: 'fixture', provider: 'openai-codex', profileRevision: 'r1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
  },
  selection: {
    version: 1,
    agent: { profileId: 'default-mitzo', revision: 1, kind: 'builtin' },
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
    model: 'offline-fixture',
    thinking: null,
  },
  repositoryWorkspaceId: 'workspace',
} as const;
let store: EventStore;
type Authorize = (sessionId: string) => Promise<void>;
let authorize: ReturnType<typeof vi.fn<Authorize>>;
beforeEach(() => {
  store = new EventStore(':memory:');
  store.upsertSession({ sessionId: 'one', conversationSource: 'mitzo' });
  authorize = vi.fn<Authorize>(async () => {});
});
afterEach(() => store.close());
function assistant(messageId: string, text = 'Visible answer', toolId?: string) {
  store.append('one', 'message_start', { messageId });
  store.append('one', 'block_start', { messageId, blockId: 'private', blockType: 'thinking' });
  store.append('one', 'block_delta', { messageId, blockId: 'private', delta: 'PRIVATE' });
  store.append('one', 'block_end', { messageId, blockId: 'private', blockType: 'thinking' });
  store.append('one', 'block_start', {
    messageId,
    blockId: `${messageId}-text`,
    blockType: 'text',
  });
  store.append('one', 'block_delta', { messageId, blockId: `${messageId}-text`, delta: text });
  store.append('one', 'block_end', { messageId, blockId: `${messageId}-text`, blockType: 'text' });
  if (toolId) {
    store.append('one', 'block_start', { messageId, blockId: toolId, blockType: 'tool_use' });
    store.append('one', 'block_end', {
      messageId,
      blockId: toolId,
      blockType: 'tool_use',
      toolId,
      toolName: 'Read',
      input: {},
    });
  }
  return store.append('one', 'message_end', { messageId });
}
function selection(
  sequence: number,
  messageId: string | null,
  mode: 'selected' | 'conversation_so_far' = 'conversation_so_far',
) {
  return {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    sourceConversationId: 'one',
    boundary: { sequence, messageId },
    mode,
    messageIds: [] as string[],
    artifacts: [] as { artifactId: string; revision: number; sha256: string }[],
    purpose: 'Review',
    joiningBrief: 'Please review',
  };
}
const source = () => createCollaborationContextSource({ store, authorizeConversation: authorize });

it('compiles current context without withdrawn output and preserves a pre-receipt compiled prefix', async () => {
  store.append('one', 'user_message', { messageId: 'question', text: 'Question' });
  const end = assistant('withdrawn', 'WITHDRAWN OUTPUT');
  const frozen = await compileCollaborationContext(
    selection(end, 'withdrawn'),
    [settings],
    source(),
  );
  store.append('one', 'message_retracted', { sessionId: 'one', messageId: 'withdrawn' });
  const current = store.getDurableSessionTranscript('one');
  const draft = await compileCollaborationContext(
    selection(current.boundary.sequence, current.boundary.messageId),
    [settings],
    source(),
  );
  expect(draft.messages.map((m) => m.messageId)).toEqual(['question']);
  expect(JSON.stringify(draft)).not.toContain('WITHDRAWN OUTPUT');
  expect(JSON.stringify(frozen.messages)).toContain('WITHDRAWN OUTPUT');
});

it('omits withdrawn inline output pins and refuses explicit selection at the same current prefix', async () => {
  store.append('one', 'user_message', { messageId: 'question', text: 'Question' });
  const end = assistant('withdrawn', 'WITHDRAWN INLINE OUTPUT');
  const output = store.registerSessionOutput('one', {
    requestId: 'withdrawn-inline',
    title: 'Original answer',
    source: {
      messageId: 'withdrawn',
      blockId: 'withdrawn-text',
      messageEndSeq: end,
      sha256: hash('WITHDRAWN INLINE OUTPUT'),
    },
  });
  const pin = { artifactId: output.outputId, revision: 1, sha256: output.source.sha256 };
  store.append('one', 'message_retracted', { sessionId: 'one', messageId: 'withdrawn' });
  const current = store.getDurableSessionTranscript('one');
  const currentSelection = selection(current.boundary.sequence, current.boundary.messageId);
  const draft = await compileCollaborationContext(currentSelection, [settings], source());
  expect(draft.messages.map((message) => message.messageId)).toEqual(['question']);
  expect(draft.artifacts).toEqual([]);
  for (const mode of ['selected', 'conversation_so_far'] as const)
    await expect(
      compileCollaborationContext(
        { ...currentSelection, mode, artifacts: [pin] },
        [settings],
        source(),
      ),
    ).rejects.toMatchObject({ code: 'snapshot_changed' });

  // Retained output bytes and the explicitly older boundary remain available.
  // Retraction changes current context eligibility, never the original audit.
  expect(store.readSessionOutput('one', output.outputId).content).toBe('WITHDRAWN INLINE OUTPUT');
  for (const mode of ['selected', 'conversation_so_far'] as const) {
    const frozen = await compileCollaborationContext(
      { ...selection(end, 'withdrawn', mode), artifacts: [pin] },
      [settings],
      source(),
    );
    expect(frozen.artifacts[0].contentBase64).toBe(
      Buffer.from('WITHDRAWN INLINE OUTPUT').toString('base64'),
    );
  }
});

it('filters pins on earlier pages using the full selected receipt boundary', async () => {
  store.append('one', 'user_message', { messageId: 'question', text: 'Question' });
  const end = assistant('withdrawn', 'EARLY INLINE OUTPUT');
  store.registerSessionOutput('one', {
    requestId: 'early-inline',
    title: 'Early answer',
    source: {
      messageId: 'withdrawn',
      blockId: 'withdrawn-text',
      messageEndSeq: end,
      sha256: hash('EARLY INLINE OUTPUT'),
    },
  });
  for (let n = 0; n < 55; n++)
    store.append('one', 'user_message', { messageId: `later-${n}`, text: `Later ${n}` });
  store.append('one', 'message_retracted', { sessionId: 'one', messageId: 'withdrawn' });
  const current = store.getDurableSessionTranscript('one');
  const draft = await compileCollaborationContext(
    selection(current.boundary.sequence, current.boundary.messageId),
    [settings],
    source(),
  );
  expect(draft.messages).toHaveLength(56);
  expect(draft.artifacts).toEqual([]);
});

it.each(['selected', 'conversation_so_far'] as const)(
  'refuses an explicitly selected withdrawn inline output in %s context',
  async (mode) => {
    store.append('one', 'user_message', { messageId: 'question', text: 'Question' });
    const end = assistant('withdrawn', 'WITHDRAWN EXPLICIT OUTPUT');
    const output = store.registerSessionOutput('one', {
      requestId: 'explicit-inline',
      title: 'Original answer',
      source: {
        messageId: 'withdrawn',
        blockId: 'withdrawn-text',
        messageEndSeq: end,
        sha256: hash('WITHDRAWN EXPLICIT OUTPUT'),
      },
    });
    store.append('one', 'message_retracted', { sessionId: 'one', messageId: 'withdrawn' });
    const current = store.getDurableSessionTranscript('one');
    const read = vi.spyOn(store, 'readSessionOutput');
    await expect(
      compileCollaborationContext(
        {
          ...selection(current.boundary.sequence, current.boundary.messageId, mode),
          artifacts: [{ artifactId: output.outputId, revision: 1, sha256: output.source.sha256 }],
        },
        [settings],
        source(),
      ),
    ).rejects.toMatchObject({ code: 'snapshot_changed' });
    expect(read).not.toHaveBeenCalled();
  },
);

it('keeps narrow explicit artifact selection independent of the full-prefix message limit', async () => {
  for (let n = 0; n < 510; n++)
    store.append('one', 'user_message', { messageId: `prior-${n}`, text: `Prior ${n}` });
  const end = assistant('answer');
  const output = store.registerSessionOutput('one', {
    requestId: 'narrow-inline',
    title: 'Answer',
    source: {
      messageId: 'answer',
      blockId: 'answer-text',
      messageEndSeq: end,
      sha256: hash('Visible answer'),
    },
  });
  const draft = await compileCollaborationContext(
    {
      ...selection(end, 'answer', 'selected'),
      artifacts: [{ artifactId: output.outputId, revision: 1, sha256: output.source.sha256 }],
    },
    [settings],
    source(),
  );
  expect(draft.messages).toEqual([]);
  expect(draft.artifacts[0].contentBase64).toBe(Buffer.from('Visible answer').toString('base64'));
});

it('keeps a text output pin when only its separate tool result was withdrawn', async () => {
  const end = assistant('answer', 'Visible answer', 'read');
  const output = store.registerSessionOutput('one', {
    requestId: 'text-inline',
    title: 'Text answer',
    source: {
      messageId: 'answer',
      blockId: 'answer-text',
      messageEndSeq: end,
      sha256: hash('Visible answer'),
    },
  });
  const through = store.append('one', 'message_retracted', {
    sessionId: 'one',
    messageId: 'answer',
    toolId: 'read',
  });
  const draft = await compileCollaborationContext(
    selection(through, 'answer'),
    [settings],
    source(),
  );
  expect(draft.artifacts[0].artifactId).toBe(output.outputId);
  expect(draft.artifacts[0].contentBase64).toBe(Buffer.from('Visible answer').toString('base64'));
});

it('reviews a selected completed reply through the real captured prefix while a later reply streams', async () => {
  assistant('prior');
  store.append('one', 'message_start', { messageId: 'active' });
  store.append('one', 'block_start', { messageId: 'active', blockId: 'stream', blockType: 'text' });
  store.append('one', 'block_delta', {
    messageId: 'active',
    blockId: 'stream',
    delta: 'Unfinished',
  });
  const captured = store.getDurableSessionTranscript('one');
  const selected = {
    ...selection(captured.boundary.sequence, captured.boundary.messageId, 'selected'),
    messageIds: ['prior'],
  };
  const owner = createCollaborationContextSource({
    store,
    authorizeConversation: authorize,
    assertConversationCurrent: () => {},
  });
  const draft = await compileCollaborationContext(selected, [settings], owner);
  store.append('one', 'block_delta', {
    messageId: 'active',
    blockId: 'stream',
    delta: ' continuation',
  });
  expect(() => owner.assertCurrentAtSave()).not.toThrow();
  expect(draft.messages.map((message) => message.messageId)).toEqual(['prior']);
  expect(JSON.stringify(draft.messages)).not.toMatch(/PRIVATE|Unfinished|continuation/);
  expect(authorize).toHaveBeenCalledWith('one');
  store.hideSession('one');
  expect(() => owner.assertCurrentAtSave()).toThrow();
});

it('compiles the complete real visible prefix across pages while excluding private payloads', async () => {
  let end = 0;
  for (let n = 0; n < 61; n++) {
    store.append('one', 'user_message', {
      messageId: `u${n}`,
      text: `Question ${n}`,
      providerSecret: 'PRIVATE',
    });
    end = assistant(`m${n}`);
  }
  const draft = await compileCollaborationContext(selection(end, 'm60'), [settings], source());
  expect(draft.messages).toHaveLength(122);
  expect(draft.messages.at(-1)).toMatchObject({
    messageId: 'm60',
    sequence: end,
    blocks: [{ blockId: 'm60-text', content: 'Visible answer', sha256: hash('Visible answer') }],
  });
  expect(JSON.stringify(draft)).not.toContain('PRIVATE');
  expect(draft.capacity.status).toBe('unverified');
  expect(store.listSessions()).toHaveLength(1);
  expect(store.getOrdinaryInitialCommandId('one')).toBeUndefined();
});

it('copies only authorized exact registered inline output bytes with their source pins', async () => {
  const end = assistant('answer');
  const output = store.registerSessionOutput('one', {
    requestId: 'register',
    title: 'Answer',
    source: {
      messageId: 'answer',
      blockId: 'answer-text',
      messageEndSeq: end,
      sha256: hash('Visible answer'),
    },
  });
  const draft = await compileCollaborationContext(selection(end, 'answer'), [settings], source());
  expect(draft.artifacts).toEqual([
    expect.objectContaining({
      artifactId: output.outputId,
      revision: 1,
      sha256: hash('Visible answer'),
      contentBase64: Buffer.from('Visible answer').toString('base64'),
    }),
  ]);
  expect(authorize).toHaveBeenCalledWith('one');
  const bad = {
    ...selection(end, 'answer', 'selected'),
    artifacts: [{ artifactId: output.outputId, revision: 2, sha256: hash('Visible answer') }],
  };
  await expect(compileCollaborationContext(bad, [settings], source())).rejects.toMatchObject({
    code: 'snapshot_changed',
  });
});

it('permits narrow and brief-only review beyond the full prefix count limit', async () => {
  let end = 0;
  for (let n = 0; n < 510; n++)
    end = store.append('one', 'user_message', { messageId: `u${n}`, text: `Question ${n}` });
  const input = selection(end, 'u509', 'selected');
  expect((await compileCollaborationContext(input, [settings], source())).messages).toEqual([]);
  expect(
    (
      await compileCollaborationContext({ ...input, messageIds: ['u1'] }, [settings], source())
    ).messages.map((m) => m.messageId),
  ).toEqual(['u1']);
  await expect(
    compileCollaborationContext({ ...input, mode: 'conversation_so_far' }, [settings], source()),
  ).rejects.toMatchObject({ code: 'capacity_refused' });
});

it('refuses invented boundaries, ambiguous message identities and incomplete assistant turns', async () => {
  const end = assistant('answer');
  await expect(
    compileCollaborationContext(selection(end, 'wrong'), [settings], source()),
  ).rejects.toMatchObject({ code: 'snapshot_changed' });
  await expect(
    compileCollaborationContext(selection(end + 1, 'answer'), [settings], source()),
  ).rejects.toMatchObject({ code: 'snapshot_changed' });
  const duplicate = store.append('one', 'user_message', { messageId: 'answer', text: 'collision' });
  await expect(
    compileCollaborationContext(selection(duplicate, 'answer'), [settings], source()),
  ).rejects.toMatchObject({ code: 'snapshot_changed' });
  store.append('one', 'message_start', { messageId: 'open' });
  const cursor = store.append('one', 'block_start', {
    messageId: 'open',
    blockId: 'b',
    blockType: 'text',
  });
  await expect(
    compileCollaborationContext(selection(cursor, 'answer'), [settings], source()),
  ).rejects.toMatchObject({ code: 'snapshot_changed' });
});

it('reauthorizes at the final fence and refuses hidden/native source conversations', async () => {
  const end = assistant('answer');
  const original = store.getSession('one')!;
  const meta = vi
    .spyOn(store, 'getSession')
    .mockReturnValue({ ...original, sessionType: 'symposium' });
  await expect(source().openConversation(selection(end, 'answer'))).rejects.toMatchObject({
    code: 'unavailable_recipient',
  });
  meta.mockRestore();
  const opened = await source().openConversation(selection(end, 'answer'));
  await opened.readPrefixWitness();
  store.hideSession('one');
  await expect(opened.assertCurrent()).rejects.toMatchObject({ code: 'unavailable_recipient' });
  authorize.mockRejectedValueOnce(Error('revoked'));
  await expect(source().openConversation(selection(end, 'answer'))).rejects.toThrow('revoked');
});

const unverifiedMarkers = [
  { seatId: null },
  { seatId: 'retained-seat' },
  { symposiumProvenance: null },
  { symposiumProvenance: {} },
];
it.each(unverifiedMarkers)(
  'refuses unverified payload marker %j in user sources',
  async (marker) => {
    const end = store.append('one', 'user_message', {
      messageId: 'ambiguous',
      text: 'Private seat text',
      ...marker,
    });
    for (const mode of ['selected', 'conversation_so_far'] as const)
      await expect(
        compileCollaborationContext(
          {
            ...selection(end, 'ambiguous', mode),
            messageIds: mode === 'selected' ? ['ambiguous'] : [],
          },
          [settings],
          source(),
        ),
      ).rejects.toMatchObject({ code: 'snapshot_changed' });
    const trailing = store.append('one', 'user_message', {
      messageId: 'ordinary',
      text: 'Ordinary after ambiguous source',
    });
    for (const mode of ['selected', 'conversation_so_far'] as const)
      await expect(
        compileCollaborationContext(
          {
            ...selection(trailing, 'ordinary', mode),
            messageIds: mode === 'selected' ? ['ordinary'] : [],
          },
          [settings],
          source(),
        ),
      ).rejects.toMatchObject({ code: 'snapshot_changed' });
  },
);
it.each(
  ['message_start', 'block_start', 'block_delta', 'block_end', 'message_end'].flatMap((type) =>
    unverifiedMarkers.map((marker) => ({ type, marker })),
  ),
)(
  'refuses assistant payload attribution $type $marker without omitting or sharing it',
  async ({ type: markedType, marker }) => {
    let end = 0;
    for (const [type, payload] of [
      ['message_start', {}],
      ['block_start', { blockId: 'text', blockType: 'text' }],
      ['block_delta', { blockId: 'text', delta: 'Private assistant text' }],
      ['block_end', { blockId: 'text', blockType: 'text' }],
      ['message_end', {}],
    ] as const)
      end = store.append('one', type, {
        messageId: 'ambiguous',
        ...payload,
        ...(type === markedType ? marker : {}),
      });
    for (const mode of ['selected', 'conversation_so_far'] as const)
      await expect(
        compileCollaborationContext(
          {
            ...selection(end, 'ambiguous', mode),
            messageIds: mode === 'selected' ? ['ambiguous'] : [],
          },
          [settings],
          source(),
        ),
      ).rejects.toMatchObject({ code: 'snapshot_changed' });
    const trailing = store.append('one', 'user_message', {
      messageId: 'ordinary',
      text: 'Ordinary after ambiguous source',
    });
    for (const mode of ['selected', 'conversation_so_far'] as const)
      await expect(
        compileCollaborationContext(
          {
            ...selection(trailing, 'ordinary', mode),
            messageIds: mode === 'selected' ? ['ordinary'] : [],
          },
          [settings],
          source(),
        ),
      ).rejects.toMatchObject({ code: 'snapshot_changed' });
  },
);
it('refuses delayed legacy initial prompts whose canonical displayed order differs from durable sequence', async () => {
  store.upsertSession({ sessionId: 'one', initialPrompt: 'Question' });
  assistant('answer');
  const end = store.append('one', 'user_message', { messageId: 'initial', text: 'Question' });
  for (const mode of ['selected', 'conversation_so_far'] as const)
    await expect(
      compileCollaborationContext(
        { ...selection(end, 'initial', mode), messageIds: mode === 'selected' ? ['answer'] : [] },
        [settings],
        source(),
      ),
    ).rejects.toMatchObject({ code: 'snapshot_changed' });
});

it.each(unverifiedMarkers)(
  'refuses brief-only artifact bytes from an unverified assistant source %j',
  async (marker) => {
    const messageId = 'artifact-source',
      blockId = 'text';
    store.append('one', 'message_start', { messageId });
    store.append('one', 'block_start', { messageId, blockId, blockType: 'text' });
    store.append('one', 'block_delta', {
      messageId,
      blockId,
      delta: 'Private saved output',
      ...marker,
    });
    store.append('one', 'block_end', { messageId, blockId, blockType: 'text' });
    const end = store.append('one', 'message_end', { messageId });
    // The retained output owner accepts these legacy bytes; it is not sufficient visibility proof.
    const output = store.registerSessionOutput('one', {
      requestId: 'unverified-artifact',
      title: 'Private output',
      source: { messageId, blockId, messageEndSeq: end, sha256: hash('Private saved output') },
    });
    const input = {
      ...selection(end, messageId, 'selected'),
      artifacts: [{ artifactId: output.outputId, revision: 1, sha256: output.source.sha256 }],
    };
    await expect(compileCollaborationContext(input, [settings], source())).rejects.toMatchObject({
      code: 'snapshot_changed',
    });
  },
);

it('refuses changed canonical initial-prompt metadata at the final visible-source fence', async () => {
  store.upsertSession({ sessionId: 'one', initialPrompt: 'Question' });
  store.append('one', 'user_message', { messageId: 'initial', text: 'Question' });
  const end = assistant('answer');
  const selected = await source().openConversation(selection(end, 'answer', 'selected'));
  await selected.readSelected(['answer']);
  const full = await source().openConversation(selection(end, 'answer'));
  await full.readPrefixWitness();
  store.upsertSession({ sessionId: 'one', initialPrompt: 'Changed' });
  await expect(selected.assertCurrent()).rejects.toMatchObject({ code: 'snapshot_changed' });
  await expect(full.assertCurrent()).rejects.toMatchObject({ code: 'snapshot_changed' });
});

it('preserves canonical recipient-only bookkeeping exceptions without granting authorship', async () => {
  store.append('one', 'user_message', { messageId: 'visible', text: 'Visible' });
  store.append('one', 'symposium_delivery_dispatched', { seatId: 'recipient-only' });
  const end = store.append('one', 'symposium_thread_migrated', { seatId: 'recipient-only' });
  const draft = await compileCollaborationContext(selection(end, 'visible'), [settings], source());
  expect(draft.messages.map((message) => message.messageId)).toEqual(['visible']);
});

it('refuses canonical interleaving even for an empty selection with an explicit registered artifact', async () => {
  store.append('one', 'user_message', { messageId: 'u1', text: 'First question' });
  store.append('one', 'message_start', { messageId: 'answer' });
  store.append('one', 'block_start', { messageId: 'answer', blockId: 'text', blockType: 'text' });
  store.append('one', 'block_delta', { messageId: 'answer', blockId: 'text', delta: 'Answer' });
  store.append('one', 'user_message', { messageId: 'u2', text: 'Second question' });
  store.append('one', 'block_end', { messageId: 'answer', blockId: 'text', blockType: 'text' });
  const end = store.append('one', 'message_end', { messageId: 'answer' });
  const output = store.registerSessionOutput('one', {
    requestId: 'interleaved-artifact',
    title: 'Answer',
    source: { messageId: 'answer', blockId: 'text', messageEndSeq: end, sha256: hash('Answer') },
  });
  for (const messageId of ['answer', 'u2'])
    for (const mode of ['selected', 'conversation_so_far'] as const)
      await expect(
        compileCollaborationContext(
          {
            ...selection(end, messageId, mode),
            artifacts: [{ artifactId: output.outputId, revision: 1, sha256: output.source.sha256 }],
          },
          [settings],
          source(),
        ),
      ).rejects.toMatchObject({ code: 'source_history_overlap_invalid' });
});
