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
let authorize: ReturnType<typeof vi.fn>;
beforeEach(() => {
  store = new EventStore(':memory:');
  store.upsertSession({ sessionId: 'one', conversationSource: 'mitzo' });
  authorize = vi.fn(async () => {});
});
afterEach(() => store.close());
function assistant(messageId: string, text = 'Visible answer') {
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
