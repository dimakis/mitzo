import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { createCollaborationContextSource } from '../collaboration-context-source.js';
import {
  prepareCollaborationForward,
  collaborationForwardFingerprint,
} from '../collaboration-forwarding.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
let store: EventStore;
let root: string;
let path: string;
let authorizeSource: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
let authorizeTarget: ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forwarding-'));
  path = join(root, 'events.db');
  store = new EventStore(path);
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  store.upsertSession({ sessionId: 'target', conversationSource: 'mitzo' });
  authorizeSource = vi.fn(async () => {});
  authorizeTarget = vi.fn(async () => {});
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function selection() {
  store.append('source', 'user_message', { messageId: 'earlier', text: 'UNSELECTED PROMPT' });
  store.append('source', 'message_start', {
    messageId: 'answer',
    privateHistory: 'PRIVATE HISTORY',
  });
  for (const [blockId, blockType, text] of [
    ['reasoning', 'thinking', 'PRIVATE REASONING'],
    ['chosen', 'text', '  Exact\r\nπ answer  '],
    ['other', 'text', 'UNSELECTED BLOCK'],
  ]) {
    store.append('source', 'block_start', { messageId: 'answer', blockId, blockType });
    store.append('source', 'block_delta', { messageId: 'answer', blockId, delta: text });
    store.append('source', 'block_end', { messageId: 'answer', blockId, blockType });
  }
  const sequence = store.append('source', 'message_end', { messageId: 'answer' });
  return {
    requestId: randomUUID(),
    target: {
      collaborationId: randomUUID(),
      expectedMembershipRevision: 1,
      sessionIds: ['target'],
    },
    sourceConversationId: 'source',
    boundary: { sequence, messageId: 'answer' },
    messages: [
      {
        messageId: 'answer',
        sequence,
        blocks: [{ blockId: 'chosen', sha256: sha('  Exact\r\nπ answer  ') }],
      },
    ],
    artifacts: [],
  };
}
function deps() {
  return {
    source: createCollaborationContextSource({ store, authorizeConversation: authorizeSource }),
    authorizeTarget,
  };
}
it('hands off only exact selected public blocks with source identity and explicit target, without effects', async () => {
  const input = selection();
  const sessions = store.listSessions();
  const result = await prepareCollaborationForward(input, deps());
  expect(result.packet).toMatchObject({
    version: 1,
    requestId: input.requestId,
    mode: 'context_only',
    target: input.target,
    sourceConversationId: 'source',
    boundary: input.boundary,
    messages: [
      {
        conversationId: 'source',
        messageId: 'answer',
        sequence: input.boundary.sequence,
        author: { sessionId: 'source' },
        blocks: [
          {
            blockId: 'chosen',
            content: '  Exact\r\nπ answer  ',
            sha256: sha('  Exact\r\nπ answer  '),
          },
        ],
      },
    ],
    artifacts: [],
  });
  expect(result.serialized).toBe(JSON.stringify(result.packet));
  expect(result.sha256).toBe(sha(result.serialized));
  for (const secret of ['PRIVATE', 'UNSELECTED']) expect(result.serialized).not.toContain(secret);
  expect(authorizeSource).toHaveBeenCalledWith('source');
  expect(authorizeTarget).toHaveBeenCalledWith(input.target);
  expect(store.listSessions()).toEqual(sessions);
  expect(store.getOrdinaryInitialCommandId('target')).toBeUndefined();
  await result.assertCurrent();
});
it('gives the existing receipt owner a canonical request fingerprint including source, target and selected hashes', async () => {
  const input = selection();
  const { target, ...rest } = input;
  expect(collaborationForwardFingerprint({ ...rest, target })).toBe(
    collaborationForwardFingerprint(input),
  );
  expect(
    collaborationForwardFingerprint({ ...input, target: { ...target, sessionIds: ['different'] } }),
  ).not.toBe(collaborationForwardFingerprint(input));
  const first = await prepareCollaborationForward(input, deps());
  store.append('source', 'user_message', { messageId: 'later', text: 'LATER MATERIAL' });
  const retry = await prepareCollaborationForward(input, deps());
  expect(retry.serialized).toBe(first.serialized);
});
it.each([
  'private',
  'wrong-hash',
  'wrong-sequence',
  'duplicate-block',
  'duplicate-message',
  'empty-blocks',
  'implicit-target',
  'reply-mode',
  'unretained-link',
])('refuses an invalid or unsupported %s selection', async (shape) => {
  const input = selection();
  const raw: {
    messages: {
      messageId: string;
      sequence: number;
      blocks: { blockId: string; sha256: string }[];
    }[];
    target: typeof input.target;
    mode?: string;
    artifacts: unknown[];
  } & Omit<typeof input, 'artifacts'> = structuredClone(input);
  if (shape === 'private')
    raw.messages[0].blocks = [{ blockId: 'reasoning', sha256: sha('PRIVATE REASONING') }];
  if (shape === 'wrong-hash') raw.messages[0].blocks[0].sha256 = '0'.repeat(64);
  if (shape === 'wrong-sequence') raw.messages[0].sequence++;
  if (shape === 'duplicate-block') raw.messages[0].blocks.push(raw.messages[0].blocks[0]);
  if (shape === 'duplicate-message') raw.messages.push(raw.messages[0]);
  if (shape === 'empty-blocks') raw.messages[0].blocks = [];
  if (shape === 'implicit-target') raw.target.sessionIds = [];
  if (shape === 'reply-mode') raw.mode = 'request_reply';
  if (shape === 'unretained-link')
    raw.artifacts = [
      {
        kind: 'retained_artifact',
        url: 'https://example.invalid/file',
        revision: 1,
        sha256: '0'.repeat(64),
      },
    ];
  await expect(prepareCollaborationForward(raw, deps())).rejects.toThrow();
});
it('refuses unavailable sources and changed source or target access at renewal', async () => {
  const input = selection();
  const result = await prepareCollaborationForward(input, deps());
  authorizeSource.mockRejectedValueOnce(Error('Access revoked'));
  await expect(result.assertCurrent()).rejects.toThrow('Access revoked');
  authorizeTarget.mockRejectedValueOnce(Error('Target revoked'));
  await expect(result.assertCurrent()).rejects.toThrow('Target revoked');
  store.hideSession('source');
  await expect(prepareCollaborationForward(input, deps())).rejects.toThrow();
  await expect(result.assertCurrent()).rejects.toThrow();
});
it('checks source integrity after awaiting target authority and refuses a changed finalized block', async () => {
  const input = selection();
  const capability = createCollaborationContextSource({
    store,
    authorizeConversation: authorizeSource,
  });
  const open = capability.openConversation.bind(capability);
  capability.openConversation = async (s) => {
    const source = await open(s);
    const read = source.readSelected.bind(source);
    source.readSelected = async (ids) => {
      const messages = await read(ids);
      return messages.map((m) => ({
        ...m,
        blocks: m.blocks.map((b) => ({ ...b, content: b.content + 'changed' })),
      }));
    };
    return source;
  };
  await expect(
    prepareCollaborationForward(input, { source: capability, authorizeTarget }),
  ).rejects.toThrow();
});
it('forwards explicit transcript references honestly without claiming independent retention', async () => {
  const input = selection();
  const output = store.registerSessionOutput('source', {
    requestId: 'register',
    title: 'Selected',
    source: {
      messageId: 'answer',
      blockId: 'chosen',
      messageEndSeq: input.boundary.sequence,
      sha256: input.messages[0].blocks[0].sha256,
    },
  });
  const raw = {
    ...input,
    artifacts: [
      {
        kind: 'transcript_reference',
        artifactId: output.outputId,
        revision: 1,
        sha256: output.source.sha256,
      },
    ],
  };
  const result = await prepareCollaborationForward(raw, deps());
  expect(result.packet.artifacts).toEqual([
    expect.objectContaining({
      kind: 'transcript_reference',
      retention: 'source_dependent',
      revision: 1,
      contentBase64: Buffer.from('  Exact\r\nπ answer  ').toString('base64'),
    }),
  ]);
  // Fault injection: remove retained source-reference metadata in the owner-created database.
  const fault = new Database(path);
  fault
    .prepare('DELETE FROM session_output_references WHERE session_id=? AND output_id=?')
    .run('source', output.outputId);
  fault.close();
  await expect(result.assertCurrent()).rejects.toThrow();
});
it('refuses an over-budget handoff without truncating selected content', async () => {
  const input = selection();
  const sequence = store.append('source', 'user_message', {
    messageId: 'large',
    text: 'a'.repeat(512 * 1024),
  });
  const raw = {
    ...input,
    boundary: { sequence, messageId: 'large' },
    messages: [
      {
        messageId: 'large',
        sequence,
        blocks: [{ blockId: 'user-large', sha256: sha('a'.repeat(512 * 1024)) }],
      },
    ],
  };
  await expect(prepareCollaborationForward(raw, deps())).rejects.toMatchObject({
    code: 'capacity_refused',
  });
});

it('accepts exactly 512 KiB serialized content and refuses the next byte', async () => {
  const input = selection();
  const sequence = store.append('source', 'user_message', { messageId: 'budget', text: 'x' });
  const raw = {
    ...input,
    boundary: { sequence, messageId: 'budget' },
    messages: [
      { messageId: 'budget', sequence, blocks: [{ blockId: 'user-budget', sha256: sha('x') }] },
    ],
  };
  const sample = await prepareCollaborationForward(raw, deps());
  const maximum = 512 * 1024 - Buffer.byteLength(sample.serialized) + 1;
  const fault = new Database(path);
  for (const length of [maximum, maximum + 1]) {
    const text = 'π'.repeat(Math.floor(length / 2)) + (length % 2 ? 'x' : '');
    fault
      .prepare('UPDATE events SET payload=? WHERE session_id=? AND seq=?')
      .run(JSON.stringify({ messageId: 'budget', text }), 'source', sequence);
    const selected = {
      ...raw,
      messages: [{ ...raw.messages[0], blocks: [{ blockId: 'user-budget', sha256: sha(text) }] }],
    };
    if (length === maximum)
      expect(
        Buffer.byteLength((await prepareCollaborationForward(selected, deps())).serialized),
      ).toBe(512 * 1024);
    else
      await expect(prepareCollaborationForward(selected, deps())).rejects.toMatchObject({
        code: 'capacity_refused',
      });
  }
  fault.close();
});

it('detects a finalized source edit during the final target authorization await', async () => {
  const input = selection();
  let calls = 0;
  authorizeTarget.mockImplementation(async () => {
    if (++calls !== 3) return;
    const fault = new Database(path);
    fault
      .prepare(
        "UPDATE events SET payload=json_set(payload,'$.delta',?) WHERE session_id=? AND type='block_delta' AND json_extract(payload,'$.blockId')=?",
      )
      .run('CHANGED WHILE AUTHORIZING TARGET', 'source', 'chosen');
    fault.close();
  });
  await expect(prepareCollaborationForward(input, deps())).rejects.toMatchObject({
    code: 'snapshot_changed',
  });
});
