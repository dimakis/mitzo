import { TelosWorkError } from './telos-work-store.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CollaborationSnapshotSelectionSchema,
  CollaborationSnapshotMessageSchema,
  type StoredEvent,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { TelosArtifactStore } from './telos-artifact-store.js';

type Message = z.infer<typeof CollaborationSnapshotMessageSchema>;
type Pin = z.infer<typeof CollaborationSnapshotSelectionSchema>['artifacts'][number];
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function refuse(): never {
  throw new Error('Source selection is unavailable or changed');
}
const MAX_BYTES = 512 * 1024;
const identity = (event: StoredEvent) =>
  JSON.stringify([
    event.payload.messageId,
    event.seatId ?? null,
    event.symposiumProvenance?.membershipGeneration ?? null,
  ]);

/** Application-event/retained-artifact adapter for the shared context compiler.
 * Reads no provider history and performs no allocation, settings change or turn.
 * Authority is a host capability, not an actor or access flag from request JSON.
 */
export function createTelosConversationSource(options: {
  events: EventStore;
  artifacts: TelosArtifactStore;
  authorize(conversationId: string): boolean;
  authorizeArtifact?(pin: Pin, itemId: string): boolean;
}) {
  const authorize = (id: string) => {
    const session = options.events.getSession(id);
    if (
      !options.authorize(id) ||
      !session ||
      session.isHidden ||
      session.conversationSource === 'external_import'
    )
      refuse();
    return session;
  };
  const artifact = (pin: Pin) => {
    const saved = options.artifacts.read(pin.artifactId, pin.revision);
    if (options.authorizeArtifact) {
      if (!options.authorizeArtifact(pin, saved.itemId)) refuse();
    } else authorize(saved.sessionId);
    if (saved.sha256 !== pin.sha256 || sha(saved.bytes) !== pin.sha256) refuse();
    return saved;
  };
  return {
    async openConversation(raw: unknown, inspection = false) {
      const selection = CollaborationSnapshotSelectionSchema.parse(raw);
      const sessionId = selection.sourceConversationId;
      const wanted = new Set(selection.messageIds);
      if (wanted.size !== selection.messageIds.length) refuse();
      if (selection.mode === 'conversation_so_far' && wanted.size) refuse();
      const read = () => {
        authorize(sessionId);
        const boundary = selection.boundary.sequence;
        const completed: Message[] = [];
        const attributions: Record<
          string,
          {
            seatId: string | null;
            provenance: StoredEvent['symposiumProvenance'] | null;
            createdAt: number;
          }
        > = {};
        const active = new Map<string, { messageId: string; blocks: Map<string, string> }>();
        const seen = new Set<string>();
        const references = new Map<number, Pin[]>();
        const unavailable: Record<string, string> = {};
        let after = 0,
          found = boundary === 0 && selection.boundary.messageId === null,
          bytes = 0,
          textBytes = 0;
        const keep = (event: StoredEvent) =>
          selection.mode === 'conversation_so_far' ||
          wanted.has(String(event.payload.messageId)) ||
          event.payload.messageId === selection.boundary.messageId;
        const add = (event: StoredEvent, message: Message) => {
          if (seen.has(message.messageId)) refuse();
          seen.add(message.messageId);
          completed.push(CollaborationSnapshotMessageSchema.parse(message));
          const pins = new Map<string, Pin>();
          for (const block of message.blocks) {
            for (const match of block.content.matchAll(
              /\]\(\/api\/telos\/artifacts\/([a-f0-9]{32})(?:\?revision=([1-9]\d*))?\)/g,
            )) {
              if (!match[2]) {
                if (selection.mode === 'conversation_so_far') refuse();
                continue;
              }
              const saved = options.artifacts.read(match[1], Number(match[2]));
              const pin = { artifactId: saved.id, revision: saved.revision, sha256: saved.sha256 };
              artifact(pin);
              pins.set(`${pin.artifactId}:${pin.revision}`, pin);
            }
          }
          references.set(event.seq, [...pins.values()]);
          attributions[message.messageId] = {
            seatId: event.seatId ?? null,
            provenance: event.symposiumProvenance ?? null,
            createdAt: event.createdAt,
          };
          bytes += Buffer.byteLength(JSON.stringify(message));
          if (bytes > MAX_BYTES || completed.length > 500) refuse();
        };
        // The event owner supplies bounded pages, not an unbounded replay dump.
        for (let page = 0; boundary > 0; page++) {
          if (page === 1000) refuse();
          const events = options.events.getEventsAfter(sessionId, after, 128);
          if (!events.length) break;
          let finished = false;
          for (const event of events) {
            if (event.seq > boundary) {
              finished = true;
              break;
            }
            after = event.seq;
            const id = event.payload.messageId;
            if (event.seq === boundary) {
              found =
                (event.type === 'user_message' || event.type === 'message_end') &&
                id === selection.boundary.messageId;
              finished = true;
            }
            if (typeof id !== 'string' || !keep(event)) continue;
            const key = identity(event);
            if (event.type === 'user_message') {
              if (
                (selection.mode === 'conversation_so_far' || wanted.has(id)) &&
                event.payload.images !== undefined &&
                (!Array.isArray(event.payload.images) || event.payload.images.length > 0)
              )
                if (inspection)
                  unavailable[id] =
                    'Save inline images as retained materials before capturing this message.';
                else
                  throw new TelosWorkError(
                    'invalid',
                    'Select text messages and save inline images as retained materials before capturing.',
                  );
              if (
                (selection.mode === 'conversation_so_far' || wanted.has(id)) &&
                event.payload.sourceSnapshots !== undefined &&
                (!Array.isArray(event.payload.sourceSnapshots) ||
                  event.payload.sourceSnapshots.length > 0)
              )
                if (inspection)
                  unavailable[id] =
                    'Save attached source snapshots as retained materials before capturing this message.';
                else
                  throw new TelosWorkError(
                    'invalid',
                    'Select text messages and save attached source snapshots as retained materials before capturing.',
                  );
              if (typeof event.payload.text !== 'string') refuse();
              textBytes += Buffer.byteLength(event.payload.text);
              if (textBytes > MAX_BYTES) refuse();
              // User text has a message anchor, not an invented persisted block.
              add(event, {
                conversationId: sessionId,
                messageId: id,
                sequence: event.seq,
                author: 'operator',
                source: null,
                blocks: [
                  { blockId: id, content: event.payload.text, sha256: sha(event.payload.text) },
                ],
              });
            } else if (event.type === 'message_start') {
              if (active.has(key) || seen.has(id)) refuse();
              active.set(key, { messageId: id, blocks: new Map() });
            } else {
              const message = active.get(key);
              if (!message) continue;
              const blockId = event.payload.blockId;
              if (
                event.type === 'block_start' &&
                event.payload.blockType === 'text' &&
                typeof blockId === 'string'
              ) {
                if (message.blocks.has(blockId)) refuse();
                message.blocks.set(blockId, '');
              } else if (
                event.type === 'block_delta' &&
                typeof blockId === 'string' &&
                message.blocks.has(blockId) &&
                typeof event.payload.delta === 'string'
              ) {
                textBytes += Buffer.byteLength(event.payload.delta);
                if (textBytes > MAX_BYTES) refuse();
                const text = message.blocks.get(blockId)! + event.payload.delta;
                if (Buffer.byteLength(text) > MAX_BYTES) refuse();
                message.blocks.set(blockId, text);
              } else if (event.type === 'message_end') {
                const blocks = [...message.blocks].map(([blockId, content]) => ({
                  blockId,
                  content,
                  sha256: sha(content),
                }));
                if (blocks.length)
                  add(event, {
                    conversationId: sessionId,
                    messageId: id,
                    sequence: event.seq,
                    author: { sessionId },
                    source: null,
                    blocks,
                  });
                active.delete(key);
              }
            }
          }
          if (finished) break;
        }
        if (
          !found ||
          (!inspection &&
            boundary > 0 &&
            !completed.some(
              (message) =>
                message.sequence === boundary && message.messageId === selection.boundary.messageId,
            )) ||
          (!inspection && [...wanted].some((id) => !seen.has(id)))
        )
          refuse();
        return { messages: completed, attributions, references: [...references], unavailable };
      };
      const retained = read();
      const pinsFor = (messages: Message[]) => [
        ...new Map(
          messages
            .flatMap(
              (message) =>
                retained.references.find(([sequence]) => sequence === message.sequence)?.[1] ?? [],
            )
            .map((pin) => [`${pin.artifactId}:${pin.revision}`, pin]),
        ).values(),
      ];
      const sourceIdentity = sha(JSON.stringify([sessionId, selection.boundary, retained]));
      const current = () => {
        if (sha(JSON.stringify([sessionId, selection.boundary, read()])) !== sourceIdentity)
          refuse();
      };
      return {
        sourceIdentity,
        sourceConversationId: sessionId,
        boundary: structuredClone(selection.boundary),
        attributions: structuredClone(retained.attributions),
        unavailable: structuredClone(retained.unavailable),
        publicMessages: structuredClone(retained.messages),
        async readPrefixWitness() {
          current();
          if (selection.mode !== 'conversation_so_far') refuse();
          return {
            messageCount: retained.messages.length,
            messagesSha256: sha(JSON.stringify(retained.messages)),
            artifactPins: pinsFor(retained.messages),
          };
        },
        async readPage(afterSequence: number, limit: number) {
          current();
          if (
            selection.mode !== 'conversation_so_far' ||
            !Number.isSafeInteger(afterSequence) ||
            afterSequence < 0 ||
            afterSequence > selection.boundary.sequence ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 50
          )
            refuse();
          const remaining = retained.messages.filter((message) => message.sequence > afterSequence);
          const messages = remaining.slice(0, limit);
          const hasMore = remaining.length > messages.length;
          const throughSequence = hasMore ? messages.at(-1)!.sequence : selection.boundary.sequence;
          return {
            sourceIdentity,
            afterSequence,
            throughSequence,
            hasMore,
            messages: structuredClone(messages),
            artifacts: pinsFor(messages),
          };
        },
        async readSelected(ids: string[]) {
          current();
          if (
            selection.mode !== 'selected' ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => !wanted.has(id))
          )
            refuse();
          return ids.map((id) => {
            const message = retained.messages.find((message) => message.messageId === id);
            if (!message) return refuse();
            return structuredClone(message);
          });
        },
        async assertCurrent() {
          current();
        },
      };
    },
    async authorizeArtifact(pin: Pin) {
      artifact(pin);
    },
    async readArtifact(pin: Pin) {
      const saved = artifact(pin);
      return {
        ...pin,
        sourceConversationId: saved.sessionId,
        mediaType: 'application/octet-stream',
        bytes: saved.bytes,
      };
    },
  };
}
