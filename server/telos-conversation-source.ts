import { telosMaterialDestinations } from './telos-source-materials.js';
import { TelosWorkError } from './telos-work-store.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CollaborationSnapshotSelectionSchema,
  CollaborationSnapshotMessageSchema,
  SymposiumProvenanceSchema,
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
    async openConversation(raw: unknown) {
      const selection = CollaborationSnapshotSelectionSchema.parse(raw);
      const sessionId = selection.sourceConversationId;
      const wanted = new Set(selection.messageIds);
      if (wanted.size !== selection.messageIds.length) refuse();
      if (selection.mode === 'conversation_so_far' && wanted.size) refuse();
      const read = () => {
        const initialPrompt = authorize(sessionId).initialPrompt || null;
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
        const active = new Map<
          string,
          {
            messageId: string;
            startedSequence: number;
            blockIds: Set<string>;
            blocks: Map<string, { content: string; closed: boolean }>;
          }
        >();
        const nativeTurns = new Map<
          string,
          { messageId: string; snapshot: string; blockIds: Set<string> }
        >();
        const nativeCompleted = new Set<string>();
        let ordinaryActive: string | undefined;
        let firstOrdinaryMessage: number | undefined;
        let initialPromptSequence: number | undefined;
        const seen = new Set<string>();
        const displayedStarts = new Map<string, number>();
        const references = new Map<number, Pin[]>();
        let after = 0,
          found = boundary === 0 && selection.boundary.messageId === null,
          bytes = 0,
          textBytes = 0;
        const keep = (event: StoredEvent) =>
          selection.mode === 'conversation_so_far' ||
          wanted.has(String(event.payload.messageId)) ||
          event.payload.messageId === selection.boundary.messageId;
        const add = (event: StoredEvent, message: Message, startedSequence = event.seq) => {
          if (seen.has(message.messageId)) refuse();
          seen.add(message.messageId);
          displayedStarts.set(message.messageId, startedSequence);
          completed.push(CollaborationSnapshotMessageSchema.parse(message));
          const pins = new Map<string, Pin>();
          for (const block of message.blocks) {
            for (const destination of telosMaterialDestinations(block.content)) {
              const [path, query] = destination.split('?');
              if (!query) {
                if (selection.mode === 'conversation_so_far') refuse();
                continue;
              }
              const saved = options.artifacts.read(
                path.slice(path.lastIndexOf('/') + 1),
                Number(query.slice('revision='.length)),
              );
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
            // Match normal transcript attribution before selection can hide an
            // ambiguous event. These two host records name recipients, not authors.
            if (event.seatId === undefined && event.symposiumProvenance === undefined) {
              if (
                !('symposiumProvenance' in event.payload) &&
                ['symposium_delivery_dispatched', 'symposium_thread_migrated'].includes(event.type)
              )
                continue;
              if ('seatId' in event.payload || 'symposiumProvenance' in event.payload) refuse();
              if (event.type === 'session_end') {
                for (const turn of nativeTurns.values())
                  nativeCompleted.add(JSON.stringify([turn.snapshot, turn.messageId]));
                nativeTurns.clear();
              }
              if (event.type === 'user_message' || event.type === 'message_start') {
                firstOrdinaryMessage ??= event.seq;
                if (ordinaryActive !== undefined) refuse();
                if (event.type === 'message_start') {
                  if (typeof event.payload.messageId !== 'string') refuse();
                  ordinaryActive = event.payload.messageId;
                } else if (initialPrompt && event.payload.text === initialPrompt) {
                  if (initialPromptSequence !== undefined || event.seq !== firstOrdinaryMessage)
                    refuse();
                  initialPromptSequence = event.seq;
                }
              } else if (
                event.type === 'message_end' &&
                event.payload.messageId === ordinaryActive
              ) {
                ordinaryActive = undefined;
              }
            } else {
              const provenance = SymposiumProvenanceSchema.safeParse(event.symposiumProvenance);
              if (!provenance.success || event.seatId !== provenance.data.seatId) refuse();
              // A valid row shape does not qualify a whole native turn. Match
              // modern replay's immutable snapshot/seat ownership before filtering.
              const snapshot = JSON.stringify(provenance.data);
              const seat = JSON.stringify([
                provenance.data.seatId,
                provenance.data.membershipGeneration ?? null,
              ]);
              const turn = nativeTurns.get(seat);
              const messageId = event.payload.messageId;
              if (event.type === 'message_start') {
                if (turn || typeof messageId !== 'string' || !messageId) refuse();
                nativeTurns.set(seat, { messageId, snapshot, blockIds: new Set() });
              } else if (event.type === 'message_end') {
                const completed = JSON.stringify([snapshot, messageId]);
                if (turn && turn.messageId === messageId && turn.snapshot === snapshot) {
                  nativeCompleted.add(completed);
                  nativeTurns.delete(seat);
                } else if (!nativeCompleted.has(completed)) refuse();
              } else if (event.type === 'session_end') {
                if (turn && turn.snapshot !== snapshot) refuse();
                if (turn) nativeCompleted.add(JSON.stringify([snapshot, turn.messageId]));
                nativeTurns.delete(seat);
              } else if (['block_start', 'block_delta', 'block_end'].includes(event.type)) {
                const blockId = event.payload.blockId;
                if (
                  !turn ||
                  turn.snapshot !== snapshot ||
                  turn.messageId !== messageId ||
                  typeof blockId !== 'string' ||
                  !blockId
                )
                  refuse();
                if (event.type === 'block_start') {
                  if (turn.blockIds.has(blockId)) refuse();
                  turn.blockIds.add(blockId);
                } else if (!turn.blockIds.has(blockId)) refuse();
              } else if (event.type.startsWith('subagent_')) {
                if (
                  !turn ||
                  turn.snapshot !== snapshot ||
                  typeof event.payload.parentBlockId !== 'string' ||
                  !turn.blockIds.has(event.payload.parentBlockId)
                )
                  refuse();
              }
            }
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
                throw new TelosWorkError(
                  'invalid',
                  'Select text messages and save attached source snapshots as retained materials before capturing.',
                );
              if (typeof event.payload.text !== 'string') refuse();
              textBytes += Buffer.byteLength(event.payload.text);
              if (textBytes > MAX_BYTES) refuse();
              // Preserve the modern normal-chat block identity for a real user row.
              add(event, {
                conversationId: sessionId,
                messageId: id,
                sequence: event.seq,
                author: 'operator',
                source: null,
                blocks: [
                  {
                    blockId: `user-${id}`,
                    content: event.payload.text,
                    sha256: sha(event.payload.text),
                  },
                ],
              });
            } else if (event.type === 'message_start') {
              if (active.has(key) || seen.has(id)) refuse();
              active.set(key, {
                messageId: id,
                startedSequence: event.seq,
                blockIds: new Set(),
                blocks: new Map(),
              });
            } else {
              const message = active.get(key);
              if (!message) continue;
              const blockId = event.payload.blockId;
              if (event.type === 'block_start' && typeof blockId === 'string') {
                if (message.blockIds.has(blockId) || typeof event.payload.blockType !== 'string')
                  refuse();
                message.blockIds.add(blockId);
                if (event.payload.blockType === 'text')
                  message.blocks.set(blockId, { content: '', closed: false });
              } else if (
                event.type === 'block_delta' &&
                typeof blockId === 'string' &&
                message.blocks.has(blockId) &&
                typeof event.payload.delta === 'string'
              ) {
                textBytes += Buffer.byteLength(event.payload.delta);
                if (textBytes > MAX_BYTES) refuse();
                const block = message.blocks.get(blockId)!;
                if (block.closed) refuse();
                const text = block.content + event.payload.delta;
                if (Buffer.byteLength(text) > MAX_BYTES) refuse();
                block.content = text;
              } else if (
                event.type === 'block_end' &&
                typeof blockId === 'string' &&
                message.blocks.has(blockId)
              ) {
                const block = message.blocks.get(blockId)!;
                if (block.closed) refuse();
                block.closed = true;
              } else if (event.type === 'message_end') {
                const blocks = [...message.blocks].map(([blockId, block]) => {
                  // Existing replay paths differ for unfinished text; the
                  // accepted bounded source contract cannot qualify it for capture.
                  if (!block.closed) refuse();
                  return { blockId, content: block.content, sha256: sha(block.content) };
                });
                if (
                  event.seq === boundary &&
                  id === selection.boundary.messageId &&
                  !blocks.some((block) => block.content.trim())
                )
                  throw new TelosWorkError(
                    'invalid',
                    'Select a completed message with visible public text as the source boundary.',
                  );
                if (blocks.length)
                  add(
                    event,
                    {
                      conversationId: sessionId,
                      messageId: id,
                      sequence: event.seq,
                      author: { sessionId },
                      source: null,
                      blocks,
                    },
                    message.startedSequence,
                  );
                active.delete(key);
              }
            }
          }
          if (finished) break;
        }
        // Normal replay displays native replies at message_start. The shared
        // compiler retains terminal cursors, so refuse an inverted selected set
        // rather than silently reorder it or invent another sequence contract.
        let previousStart = -1;
        for (const message of completed) {
          if (selection.mode === 'selected' && !wanted.has(message.messageId)) continue;
          const start = displayedStarts.get(message.messageId)!;
          if (start < previousStart)
            throw new TelosWorkError(
              'invalid',
              'Selected messages finish in a different display order. Select one completed message or a range whose display and completion order agree.',
            );
          previousStart = start;
        }
        if (
          !found ||
          ordinaryActive !== undefined ||
          (initialPrompt !== null && initialPromptSequence === undefined) ||
          (boundary > 0 &&
            !completed.some(
              (message) =>
                message.sequence === boundary && message.messageId === selection.boundary.messageId,
            )) ||
          [...wanted].some((id) => !seen.has(id))
        )
          refuse();
        return { messages: completed, attributions, references: [...references], initialPrompt };
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
