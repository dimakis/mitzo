import { storedEventToClientMessage } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { SymposiumSeatExecution } from './symposium-orchestrator.js';

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};

interface NativeBlock {
  blockId: string;
  blockType: string;
  toolId?: string;
  toolName?: string;
  input: string;
  streamedInput: boolean;
}
interface NativeTurn {
  messageId: string;
  blocks: Map<number, NativeBlock>;
  seenBlocks: Set<string>;
}
interface AttemptStream {
  turn?: NativeTurn;
  seenMessages: Set<string>;
  toolOwners: Map<string, string[]>;
  terminal: boolean;
  pending: Json[];
  pendingBytes: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

/** Maps provider notifications onto one immutable, accepted seat attempt. */
export class SymposiumNativeEventSink {
  private streams = new Map<string, AttemptStream>();
  private pendingBytes = 0;

  constructor(
    private readonly store: EventStore,
    private readonly broadcast: (sessionId: string, event: Json) => void,
  ) {}

  /** Called after the native attempt has completed or confirmed remote cleanup. */
  release(claimToken: string): void {
    const stream: AttemptStream = this.streams.get(claimToken) ?? {
      seenMessages: new Set<string>(),
      toolOwners: new Map<string, string[]>(),
      terminal: true,
      pending: [],
      pendingBytes: 0,
    };
    // Confirmed cleanup closes transcript structure, not a fabricated provider result.
    for (const event of this.store.closeSymposiumAttemptTranscript(claimToken))
      this.broadcast(
        event.sessionId,
        storedEventToClientMessage({
          ...event,
          prevSessionSeq: this.store.getSessionPredecessorSeq(event.sessionId, event.seq),
        }),
      );
    this.pendingBytes -= stream.pendingBytes;
    stream.pending = [];
    stream.pendingBytes = 0;
    stream.terminal = true;
    stream.turn = undefined;
    stream.seenMessages.clear();
    if (stream.cleanupTimer) clearTimeout(stream.cleanupTimer);
    stream.cleanupTimer = setTimeout(() => {
      if (this.streams.get(claimToken) === stream) this.streams.delete(claimToken);
    }, 30_000);
    stream.cleanupTimer.unref?.();
    this.streams.set(claimToken, stream);
  }

  record(execution: SymposiumSeatExecution, native: Json): void {
    const claim = execution.claimToken;
    const attempt = this.store.getSymposiumRecipientAttemptByClaimToken(claim);
    if (
      !attempt ||
      attempt.deliveryId !== execution.deliveryId ||
      attempt.seatId !== execution.seat.id ||
      this.store.getSymposiumDelivery(attempt.deliveryId)?.sessionId !== execution.sessionId ||
      !attempt.provenance ||
      JSON.stringify(attempt.provenance) !== JSON.stringify(execution.provenance)
    )
      return;
    if (native.type === 'symposium_attempt_released') {
      this.release(claim);
      return;
    }
    let stream = this.streams.get(claim);
    const lateToolResult = native.type === 'user' && stream?.terminal === true;
    if (attempt.status !== 'executing' && !lateToolResult) return;
    if (!stream) {
      stream = {
        seenMessages: new Set(),
        toolOwners: new Map(),
        terminal: false,
        pending: [],
        pendingBytes: 0,
      };
      this.streams.set(claim, stream);
    }
    if (stream.terminal && !lateToolResult) return;
    if (attempt.acceptedAt === null) {
      if (stream.terminal || native.type === 'symposium_attempt_accepted') return;
      const serialized = JSON.stringify(native);
      const bytes = Buffer.byteLength(serialized);
      if (stream.pending.length >= 512 || this.pendingBytes + bytes > 1_048_576) {
        this.release(claim);
        throw new Error('Native Symposium pre-acceptance event buffer exceeded');
      }
      // Copy notifications so provider-owned mutable objects cannot change attribution/order.
      stream.pending.push(JSON.parse(serialized) as Json);
      stream.pendingBytes += bytes;
      this.pendingBytes += bytes;
      return;
    }
    if (stream.pending.length) {
      const pending = stream.pending;
      this.pendingBytes -= stream.pendingBytes;
      stream.pending = [];
      stream.pendingBytes = 0;
      for (const event of pending) this.record(execution, event);
    }
    if (native.type === 'symposium_attempt_accepted' || (stream.terminal && native.type !== 'user'))
      return;
    const append = (type: string, payload: Json) => {
      const seq = this.store.appendSymposium(
        execution.sessionId,
        type,
        { ...payload, nativeClaimToken: claim },
        execution.provenance,
      );
      this.broadcast(
        execution.sessionId,
        storedEventToClientMessage({
          sessionId: execution.sessionId,
          type,
          payload,
          seq,
          seatId: execution.seat.id,
          symposiumProvenance: execution.provenance,
          prevSessionSeq: this.store.getSessionPredecessorSeq(execution.sessionId, seq),
        }),
      );
    };
    const toolInput = (block: NativeBlock) => {
      if (!block.input) return {};
      let rawInput: unknown;
      try {
        rawInput = JSON.parse(block.input);
      } catch {
        /* retain the raw JSON fragment */
      }
      return {
        input: block.input,
        ...(rawInput && typeof rawInput === 'object' ? { rawInput } : {}),
      };
    };
    const closeTurn = () => {
      const turn = stream!.turn;
      if (!turn) return;
      for (const block of turn.blocks.values())
        append('block_end', {
          messageId: turn.messageId,
          blockId: block.blockId,
          blockType: block.blockType,
          ...(block.toolId ? { toolId: block.toolId } : {}),
          ...(block.toolName ? { toolName: block.toolName } : {}),
          ...toolInput(block),
        });
      append('message_end', { messageId: turn.messageId });
      stream!.turn = undefined;
    };

    if (native.type === 'stream_event') {
      const event = object(native.event);
      if (event.type === 'message_start') {
        const messageId = object(event.message).id;
        if (typeof messageId !== 'string' || !messageId) return;
        if (stream.turn) {
          if (stream.turn.messageId === messageId) return;
          throw new Error('Interleaved native Symposium messages cannot be attributed');
        }
        if (stream.seenMessages.has(messageId)) return;
        stream.seenMessages.add(messageId);
        stream.turn = { messageId, blocks: new Map(), seenBlocks: new Set() };
        append('message_start', { messageId, ts: Date.now() });
        return;
      }
      if (event.type === 'message_stop') {
        const messageId = object(event.message).id;
        if (messageId !== undefined && messageId !== stream.turn?.messageId) return;
        closeTurn();
        return;
      }
      const turn = stream.turn;
      const index = event.index;
      if (!turn || !Number.isSafeInteger(index) || (index as number) < 0) return;
      if (event.type === 'content_block_start') {
        const block = object(event.content_block);
        const blockType = block.type;
        if (
          !['text', 'thinking', 'tool_use'].includes(String(blockType)) ||
          turn.blocks.has(index as number)
        )
          return;
        const blockId = `${turn.messageId}:${index}`;
        const toolId = typeof block.id === 'string' ? block.id : undefined;
        const toolName = typeof block.name === 'string' ? block.name : undefined;
        const entry: NativeBlock = {
          blockId,
          blockType: blockType as string,
          toolId,
          toolName,
          input: '',
          streamedInput: false,
        };
        turn.blocks.set(index as number, entry);
        turn.seenBlocks.add(blockId);
        if (toolId)
          stream.toolOwners.set(toolId, [...(stream.toolOwners.get(toolId) ?? []), turn.messageId]);
        if (blockType === 'tool_use' && block.input !== undefined)
          entry.input = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
        append('block_start', {
          messageId: turn.messageId,
          blockId,
          blockType,
          ...(toolId ? { toolId } : {}),
          ...(toolName ? { toolName } : {}),
          ...toolInput(entry),
        });
        const initial = block.text ?? block.thinking;
        if (typeof initial === 'string' && initial)
          append('block_delta', { messageId: turn.messageId, blockId, delta: initial });
      } else if (event.type === 'content_block_delta') {
        const block = turn.blocks.get(index as number);
        const delta = object(event.delta);
        const text = delta.text ?? delta.thinking ?? delta.partial_json;
        if (block && typeof text === 'string') {
          if (delta.type === 'input_json_delta') {
            block.input = block.streamedInput ? block.input + text : text;
            block.streamedInput = true;
            // Preserve the exact tool input snapshot durably while maintaining
            // the same live/replay event sequence. Empty delta adds no text.
            append('block_delta', {
              messageId: turn.messageId,
              blockId: block.blockId,
              blockType: block.blockType,
              delta: '',
              input: block.input,
            });
          } else
            append('block_delta', {
              messageId: turn.messageId,
              blockId: block.blockId,
              delta: text,
            });
        }
      } else if (event.type === 'content_block_stop') {
        const block = turn.blocks.get(index as number);
        if (!block) return;
        append('block_end', {
          messageId: turn.messageId,
          blockId: block.blockId,
          blockType: block.blockType,
          ...(block.toolId ? { toolId: block.toolId } : {}),
          ...(block.toolName ? { toolName: block.toolName } : {}),
          ...toolInput(block),
        });
        turn.blocks.delete(index as number);
      }
      return;
    }
    if (native.type === 'assistant') {
      const messageId = object(native.message).id;
      if (messageId !== undefined && messageId !== stream.turn?.messageId) return;
      // CodexSessionEvents emits id-less summaries immediately after block stop.
      closeTurn();
      return;
    }
    if (native.type === 'result') {
      closeTurn();
      append('provider_turn_end', {
        isError: native.is_error === true,
        ...(native.usage && typeof native.usage === 'object' ? { usage: native.usage } : {}),
      });
      stream.terminal = true;
      return;
    }
    if (native.type === 'user') {
      const blocks = object(native.message).content;
      for (const value of Array.isArray(blocks) ? blocks : []) {
        const result = object(value);
        if (result.type !== 'tool_result' || typeof result.tool_use_id !== 'string') continue;
        const messageId = stream.toolOwners.get(result.tool_use_id)?.shift();
        if (!messageId) continue;
        const content = result.content;
        const resultText = typeof content === 'string' ? content : JSON.stringify(content ?? '');
        append('tool_result', {
          messageId,
          toolId: result.tool_use_id,
          result: resultText,
          isError: result.is_error === true,
        });
      }
      return;
    }
    if (
      typeof native.type === 'string' &&
      (native.type.startsWith('subagent_') ||
        native.type === 'progress' ||
        native.type === 'progress_update')
    ) {
      const turn = stream.turn;
      if (!turn) return;
      const parentBlockId = native.parentBlockId;
      if (
        native.type.startsWith('subagent_') &&
        (typeof parentBlockId !== 'string' || !turn.seenBlocks.has(parentBlockId))
      )
        return;
      append(native.type, { ...native, messageId: turn.messageId });
    }
  }
}
