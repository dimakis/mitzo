import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { TelosSourcePacketSchema } from '@mitzo/protocol';
import type { FinishedMessage } from '../../frontend/src/types/chat';
import { EventStore } from '../../server/event-store';
import { TelosArtifactStore } from '../../server/telos-artifact-store';
import { TelosWorkStore } from '../../server/telos-work-store';
import { TelosSourceCapture } from '../../server/telos-source-capture';

/** Actual temporary source/artifact owners, synthetic public messages only. */
export async function telosSourceBrowserData({
  assistantBoundary = false,
  historicalBlankActivity = false,
} = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-browser-'));
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,summary TEXT,intent TEXT,rationale TEXT,acceptance_criteria TEXT,profile TEXT,status TEXT,starred INTEGER,context_hints TEXT,created_at TEXT,updated_at TEXT);
 INSERT INTO items VALUES('studio',NULL,'Home studio','Record clearly','Make music','["Ready"]','personal','active',0,'{}','2026-10-16','original');
 CREATE TABLE sources(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,raw_snippet TEXT,timestamp TEXT);
 CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);`);
  const events = new EventStore(join(root, 'events.db'));
  const artifacts = new TelosArtifactStore(path);
  const work = new TelosWorkStore(path, { ordinaryConversation: (id) => id === 'planning' });
  try {
    events.upsertSession({
      sessionId: 'planning',
      conversationSource: 'mitzo',
      summary: 'Studio planning',
    });
    const messages: FinishedMessage[] = Array.from({ length: 61 }, (_, i) => ({
      messageId: i === 30 ? 'approved' : 'message-' + i,
      role: i === 30 && assistantBoundary ? ('assistant' as const) : ('user' as const),
      blocks: [
        ...(i === 30 && assistantBoundary
          ? [
              { blockId: 'empty', blockType: 'text' as const, content: '' },
              { blockId: 'whitespace', blockType: 'text' as const, content: ' \n\t' },
            ]
          : []),
        {
          blockId: 'text-' + i,
          blockType: 'text' as const,
          content:
            i === 30 && historicalBlankActivity
              ? ' \n\t'
              : i === 30
                ? 'Use the approved acoustic plan.'
                : 'Studio discussion ' +
                  i +
                  ': keep the microphone setup and room treatment in the agreed plan.',
        },
      ],
    }));
    if (historicalBlankActivity)
      messages[30].blocks.push({
        blockId: 'historical-tool',
        blockType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolInput: '{}',
      });
    let boundary = 0;
    let precedingBoundary = 0;
    let cursor = 0;
    for (const message of messages) {
      if (message.role === 'assistant') {
        events.append('planning', 'message_start', { messageId: message.messageId });
        for (const block of message.blocks) {
          const identity = { messageId: message.messageId, blockId: block.blockId };
          events.append('planning', 'block_start', {
            ...identity,
            blockType: block.blockType,
            ...(block.blockType === 'tool_use'
              ? { toolName: block.toolName, toolInput: block.toolInput }
              : {}),
          });
          if (block.blockType === 'text')
            events.append('planning', 'block_delta', { ...identity, delta: block.content });
          events.append('planning', 'block_end', identity);
        }
        cursor = events.append('planning', 'message_end', { messageId: message.messageId });
      } else {
        cursor = events.append('planning', 'user_message', {
          messageId: message.messageId,
          text: message.blocks[0].content,
        });
      }
      if (message.messageId === 'approved') boundary = cursor;
      if (message.messageId === 'message-29') precedingBoundary = cursor;
    }
    const capture = new TelosSourceCapture({
      events,
      artifacts,
      work,
      authorizeSource: () => true,
      authorizeArtifact: () => true,
    });
    const actor = { kind: 'operator' as const, id: 'fixture-operator' };
    const input = {
      itemId: 'studio',
      selection: {
        requestId: '00000000-0000-4000-8000-000000000001',
        expectedMembershipRevision: 0,
        sourceConversationId: 'planning',
        boundary: { sequence: boundary, messageId: 'approved' },
        mode: 'selected' as const,
        messageIds: ['approved'],
        artifacts: [],
        purpose: 'Save the agreed studio plan',
        joiningBrief: '',
      },
    };
    let receipt: Awaited<ReturnType<typeof capture.adopt>>;
    if (historicalBlankActivity) {
      // Explicit v1 pre-fix retained packet. Current capture must reject this
      // boundary; seed its valid historical bytes/links through existing owners
      // and inspect them with the real retained-source reader, never new capture.
      const earlier = await capture.preview(
        {
          ...input,
          selection: {
            ...input.selection,
            boundary: { sequence: precedingBoundary, messageId: 'message-29' },
            messageIds: ['message-29'],
          },
        },
        actor,
      );
      const sha = (value: string) => createHash('sha256').update(value).digest('hex');
      const packet = TelosSourcePacketSchema.parse({
        ...earlier.packet,
        selection: input.selection,
        context: {
          ...earlier.packet.context,
          boundary: input.selection.boundary,
          messages: [
            {
              conversationId: 'planning',
              messageId: 'approved',
              sequence: boundary,
              author: { sessionId: 'planning' },
              source: null,
              blocks: messages[30].blocks
                .filter((block) => block.blockType === 'text')
                .map((block) => ({
                  blockId: block.blockId,
                  content: block.content,
                  sha256: sha(block.content),
                })),
            },
          ],
        },
        attributions: {
          approved: {
            seatId: null,
            provenance: null,
            createdAt: events.getEventsAfter('planning', boundary - 1, 1)[0].createdAt,
          },
        },
      });
      const bytes = JSON.stringify(packet);
      const artifact = artifacts.save({
        itemId: 'studio',
        filename: `origin-${sha(bytes)}.json`,
        title: 'Historical v1 original discussion with blank public text',
        bytes: Buffer.from(bytes),
        sessionId: 'source-capture:historical-fixture-v1',
      });
      receipt = work.execute(
        {
          operation: 'source',
          itemId: 'studio',
          requestId: 'historical-fixture-v1',
          expectedRevision: packet.workRevision,
          snapshot: {
            version: 1,
            snapshotId: 'historical-fixture-v1',
            itemId: 'studio',
            source: { namespace: 'mitzo', conversationId: 'planning' },
            selection: {
              kind: 'selected',
              messageIds: ['approved'],
              blockIds: packet.context.messages[0].blocks.map((block) => block.blockId),
              throughSequence: boundary,
            },
            adoptedBrief: { revision: packet.brief.sha256, sha256: packet.brief.sha256 },
            artifacts: [
              { artifactId: artifact.id, revision: artifact.revision, sha256: artifact.sha256 },
            ],
            author: null,
            sourceCreatedAt: packet.sourceCreatedAt,
            adoptedAt: artifact.createdAt,
          },
        },
        actor,
      );
    } else {
      const preview = await capture.preview(input, actor);
      receipt = await capture.adopt(
        {
          ...input,
          requestId: 'fixture-adopt',
          expectedRevision: preview.packet.workRevision,
          previewSha256: preview.sha256,
        },
        actor,
      );
    }
    const source = capture.read('studio', receipt.work.sources[0].snapshotId, actor);
    const outputs = artifacts.list({ itemId: 'studio' });
    return { work: receipt.work, source, messages, outputs, cursor };
  } finally {
    work.close();
    artifacts.close();
    events.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
