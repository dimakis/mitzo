import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EventStore } from '../../server/event-store';
import { TelosArtifactStore } from '../../server/telos-artifact-store';
import { TelosWorkStore } from '../../server/telos-work-store';
import { TelosSourceCapture } from '../../server/telos-source-capture';

/** Actual temporary source/artifact owners, synthetic public messages only. */
export async function telosSourceBrowserData({ assistantBoundary = false } = {}) {
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
    const messages = Array.from({ length: 61 }, (_, i) => ({
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
            i === 30
              ? 'Use the approved acoustic plan.'
              : 'Studio discussion ' +
                i +
                ': keep the microphone setup and room treatment in the agreed plan.',
        },
      ],
    }));
    let boundary = 0;
    let cursor = 0;
    for (const message of messages) {
      if (message.role === 'assistant') {
        events.append('planning', 'message_start', { messageId: message.messageId });
        for (const block of message.blocks) {
          const identity = { messageId: message.messageId, blockId: block.blockId };
          events.append('planning', 'block_start', { ...identity, blockType: 'text' });
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
    const preview = await capture.preview(input, actor);
    const receipt = await capture.adopt(
      {
        ...input,
        requestId: 'fixture-adopt',
        expectedRevision: preview.packet.workRevision,
        previewSha256: preview.sha256,
      },
      actor,
    );
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
