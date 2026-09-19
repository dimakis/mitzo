import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StreamEvent } from '@mitzo/harness';
import type { ExecutionToken } from '@mitzo/protocol';
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
}
/** Converts Codex text/host-tool events into the existing query-loop event contract. */
export class CodexSessionEvents {
  private texts = new Map<
    string,
    { text: string; closed: boolean; messageId: string; kind: 'text' | 'thinking' }
  >();
  private finishedTurns = new Set<string>();
  /** A reconnect can repeat lifecycle frames. Their provider IDs are private,
   * but are stable enough to suppress duplicate public compaction notices. */
  private compacted = new Set<string>();
  /**
   * Older app-server versions can replay a bare `thread/compacted` frame with
   * no provider identity. Suppress only its immediately repeated form: an
   * unrelated provider notification is evidence that a later bare frame is a
   * distinct compaction rather than transport replay.
   */
  private lastAnonymousCompaction?: string;
  private commandTools = new Map<string, string>();
  private runtimeTools = new Map<string, string>();
  /**
   * A resumed app-server can replay an open reasoning item from byte zero.
   * Store a cursor into the already rendered public summary only after the
   * replayed item's lifecycle start confirms that this is such a replay. This
   * deliberately does not suppress equal live deltas in the ordinary stream.
   */
  private replayingReasoning = false;
  private reasoningReplayOffsets = new Map<string, number>();
  private turnFinished = false;
  private usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  };
  private executionToken?: ExecutionToken;
  constructor(
    private conversationId: string,
    private threadId: string,
    private model: string,
    private emit: (event: ObjectValue) => void,
  ) {}
  private emitEvent(event: ObjectValue) {
    this.emit({
      ...event,
      ...(this.executionToken ? { mitzoExecutionToken: this.executionToken } : {}),
    });
  }
  setModel(model: string) {
    this.model = model;
  }
  /** Mark the existing in-progress reasoning blocks as eligible for a resumed
   * transport replay. `item/started` supplies the final, per-item proof before
   * any delta is deduplicated. */
  beginReconnectReplay() {
    this.replayingReasoning = true;
  }
  private beginReasoningReplay(itemId: string) {
    if (!this.replayingReasoning) return;
    const prefix = `reasoning:${itemId}:`;
    for (const [id, item] of this.texts) {
      if (id.startsWith(prefix) && !item.closed) this.reasoningReplayOffsets.set(id, 0);
    }
  }
  private replayedReasoningDelta(id: string, item: { text: string }, delta: string) {
    const offset = this.reasoningReplayOffsets.get(id);
    if (offset === undefined) return false;
    // The replay must be a byte-for-byte prefix of the rendered summary. A
    // mismatch is new provider output, even if it happens to repeat a word.
    if (item.text.slice(offset, offset + delta.length) !== delta) {
      this.reasoningReplayOffsets.delete(id);
      return false;
    }
    const next = offset + delta.length;
    if (next >= item.text.length) this.reasoningReplayOffsets.delete(id);
    else this.reasoningReplayOffsets.set(id, next);
    return true;
  }
  /**
   * The terminal summary is the public, provider-approved representation of a
   * reasoning item. Streaming deltas can stop at a reconnect boundary, so add
   * only the portion of that representation which has not already reached the
   * client. Do not substitute any other item fields here: they may contain
   * private chain-of-thought.
   */
  private finalReasoningSuffix(rendered: string, summary: string) {
    if (summary.startsWith(rendered)) return summary.slice(rendered.length);
    // We cannot revise a streaming block after it has reached a client. If a
    // provider repeats an older or rewritten final frame, appending it would
    // duplicate a public block (or join incompatible summaries), so retain the
    // rendered text rather than guessing at a boundary.
    return '';
  }
  private stream(event: StreamEvent) {
    this.emitEvent({ type: 'stream_event', event, parent_tool_use_id: null });
  }
  private start(id: string, kind: 'text' | 'thinking' = 'text') {
    let item = this.texts.get(id);
    if (item) return item;
    // The existing renderer has one active assistant message. Finish it before another begins.
    this.flush();
    item = { text: '', closed: false, messageId: randomUUID(), kind };
    this.texts.set(id, item);
    this.stream({
      type: 'message_start',
      message: {
        id: item.messageId,
        model: this.model,
        role: 'assistant',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    this.stream({
      type: 'content_block_start',
      index: 0,
      content_block:
        kind === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' },
    });
    return item;
  }
  private complete(id: string) {
    const item = this.texts.get(id);
    if (!item || item.closed) return;
    item.closed = true;
    this.stream({ type: 'content_block_stop', index: 0 });
    this.emitEvent({
      type: 'assistant',
      session_id: this.conversationId,
      parent_tool_use_id: null,
      message: {
        content: [
          item.kind === 'thinking'
            ? { type: 'thinking', thinking: item.text }
            : { type: 'text', text: item.text },
        ],
      },
    });
  }
  flush() {
    for (const [id] of this.texts) this.complete(id);
  }
  private compaction(method: string, params: ObjectValue, item?: ObjectValue) {
    const privateId =
      typeof item?.id === 'string'
        ? item.id
        : typeof params.compactionId === 'string'
          ? params.compactionId
          : typeof params.id === 'string'
            ? params.id
            : undefined;
    // Do not invent a durable identity for an anonymous event: separate real
    // compactions are allowed to have identical payloads. The only safe
    // id-less dedupe is the immediately repeated replay frame.
    if (privateId) {
      const key = `${method}:${privateId}`;
      if (this.compacted.has(key)) return;
      this.compacted.add(key);
    } else {
      if (this.lastAnonymousCompaction === method) return;
      this.lastAnonymousCompaction = method;
    }
    this.emitEvent({
      type: 'system',
      subtype: 'status',
      session_id: this.conversationId,
      status: 'Context compacted',
      compact_result: 'success',
    });
  }
  notification(method: string, params: ObjectValue, executionToken?: ExecutionToken) {
    this.executionToken = executionToken;
    if (params.threadId !== this.threadId) return;
    const isCompactionNotification =
      method === 'thread/compacted' ||
      method === 'contextCompaction' ||
      ((method === 'item/started' || method === 'item/completed') &&
        object(params.item).type === 'contextCompaction');
    if (!isCompactionNotification) this.lastAnonymousCompaction = undefined;
    if (method === 'turn/started') {
      this.turnFinished = false;
      return;
    }
    // Provider events may be delivered late. Never create renderer blocks after
    // the terminal result for a turn; the next turn/started reopens the mapper.
    if (this.turnFinished && method.startsWith('item/')) return;
    const commandItem = object(params.item);
    // Both forms are emitted by supported Codex app-server versions. A
    // compaction is user-visible only when the provider explicitly reports it.
    if (method === 'thread/compacted' || method === 'contextCompaction') {
      this.compaction(method, params);
      return;
    }
    if (
      (method === 'item/started' || method === 'item/completed') &&
      commandItem.type === 'contextCompaction'
    ) {
      this.compaction('contextCompaction', params, commandItem);
      return;
    }
    if (
      method === 'item/started' &&
      commandItem.type === 'reasoning' &&
      typeof commandItem.id === 'string'
    ) {
      this.beginReasoningReplay(commandItem.id);
      return;
    }
    if (
      method === 'item/started' &&
      commandItem.type === 'commandExecution' &&
      typeof commandItem.id === 'string' &&
      typeof commandItem.command === 'string'
    ) {
      const toolId = this.toolStart(commandItem.id, 'Bash', {
        command: commandItem.command,
        ...(typeof commandItem.cwd === 'string' ? { cwd: commandItem.cwd } : {}),
      });
      this.commandTools.set(commandItem.id, toolId);
      return;
    }
    if (
      method === 'item/completed' &&
      commandItem.type === 'commandExecution' &&
      typeof commandItem.id === 'string'
    ) {
      const toolId = this.commandTools.get(commandItem.id);
      if (!toolId) return;
      this.commandTools.delete(commandItem.id);
      const exitCode = typeof commandItem.exitCode === 'number' ? commandItem.exitCode : undefined;
      const output =
        typeof commandItem.aggregatedOutput === 'string' ? commandItem.aggregatedOutput : '';
      this.toolResult(
        toolId,
        output ||
          (exitCode === undefined ? String(commandItem.status ?? '') : `exit code ${exitCode}`),
        commandItem.status !== 'completed' || (exitCode !== undefined && exitCode !== 0),
      );
      return;
    }
    if (
      method === 'item/started' &&
      commandItem.type === 'mcpToolCall' &&
      typeof commandItem.id === 'string' &&
      typeof commandItem.server === 'string' &&
      typeof commandItem.tool === 'string'
    ) {
      this.runtimeTools.set(
        commandItem.id,
        this.toolStart(commandItem.id, `mcp__${commandItem.server}__${commandItem.tool}`, {
          ...(object(commandItem.arguments) as ObjectValue),
        }),
      );
      return;
    }
    if (
      method === 'item/started' &&
      commandItem.type === 'webSearch' &&
      typeof commandItem.id === 'string'
    ) {
      this.runtimeTools.set(
        commandItem.id,
        this.toolStart(commandItem.id, 'WebSearch', {
          ...(typeof commandItem.query === 'string' ? { search_term: commandItem.query } : {}),
        }),
      );
      return;
    }
    if (
      method === 'item/completed' &&
      (commandItem.type === 'mcpToolCall' || commandItem.type === 'webSearch') &&
      typeof commandItem.id === 'string'
    ) {
      const toolId = this.runtimeTools.get(commandItem.id);
      if (!toolId) return;
      this.runtimeTools.delete(commandItem.id);
      const failed = commandItem.status === 'failed' || !!commandItem.error;
      const output =
        commandItem.type === 'mcpToolCall'
          ? (commandItem.error ?? commandItem.result ?? commandItem.status ?? 'completed')
          : (commandItem.action ?? commandItem.query ?? 'completed');
      this.toolResult(toolId, typeof output === 'string' ? output : JSON.stringify(output), failed);
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const parsed = z
        .object({
          tokenUsage: z.object({
            last: z.object({
              inputTokens: z.number().int().nonnegative(),
              cachedInputTokens: z.number().int().nonnegative(),
              outputTokens: z.number().int().nonnegative(),
            }),
          }),
        })
        .safeParse(params);
      if (parsed.success) {
        const last = parsed.data.tokenUsage.last;
        this.usage = {
          input_tokens: Math.max(0, last.inputTokens - last.cachedInputTokens),
          output_tokens: last.outputTokens,
          cache_read_input_tokens: last.cachedInputTokens,
        };
      }
      return;
    }
    if (
      method === 'item/reasoning/summaryTextDelta' &&
      typeof params.itemId === 'string' &&
      typeof params.delta === 'string' &&
      Number.isInteger(params.summaryIndex)
    ) {
      const id = `reasoning:${params.itemId}:${params.summaryIndex}`;
      const item = this.start(id, 'thinking');
      if (item.closed) return;
      if (this.replayedReasoningDelta(id, item, params.delta)) return;
      item.text += params.delta;
      this.stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: params.delta },
      });
      return;
    }
    if (method === 'item/completed') {
      const final = object(params.item);
      if (
        final.type === 'reasoning' &&
        typeof final.id === 'string' &&
        Array.isArray(final.summary)
      ) {
        final.summary.forEach((text, index) => {
          if (typeof text !== 'string' || !text) return;
          const id = `reasoning:${final.id}:${index}`;
          this.reasoningReplayOffsets.delete(id);
          const item = this.start(id, 'thinking');
          if (item.closed) return;
          const suffix = this.finalReasoningSuffix(item.text, text);
          if (suffix) {
            item.text += suffix;
            this.stream({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: suffix },
            });
          }
          this.complete(id);
        });
        return;
      }
    }
    if (
      method === 'item/agentMessage/delta' &&
      typeof params.itemId === 'string' &&
      typeof params.delta === 'string'
    ) {
      const item = this.start(params.itemId);
      if (item.closed) return;
      item.text += params.delta;
      this.stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: params.delta },
      });
    } else if (method === 'item/completed') {
      const final = object(params.item);
      if (
        final.type !== 'agentMessage' ||
        typeof final.id !== 'string' ||
        typeof final.text !== 'string'
      )
        return;
      const item = this.start(final.id);
      if (item.closed) return;
      if (!item.text && final.text) {
        item.text = final.text;
        this.stream({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: final.text },
        });
      }
      this.complete(final.id);
    } else if (method === 'turn/completed') {
      const turn = object(params.turn);
      if (typeof turn.id !== 'string' || this.finishedTurns.has(turn.id)) return;
      this.finishedTurns.add(turn.id);
      this.turnFinished = true;
      this.replayingReasoning = false;
      this.reasoningReplayOffsets.clear();
      this.flush();
      this.emitEvent({
        type: 'result',
        session_id: this.conversationId,
        is_error: turn.status !== 'completed',
        ...(this.usage ? { usage: this.usage } : {}),
      });
      this.usage = undefined;
    }
  }
  toolStart(_providerCallId: string, name: string, input: ObjectValue): string {
    this.flush();
    const id = randomUUID();
    this.stream({
      type: 'message_start',
      message: {
        id: randomUUID(),
        model: this.model,
        role: 'assistant',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    this.stream({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name, input: {} },
    });
    this.stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    });
    this.stream({ type: 'content_block_stop', index: 0 });
    this.emitEvent({
      type: 'assistant',
      session_id: this.conversationId,
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
    return id;
  }
  toolResult(id: string, content: string, isError: boolean) {
    this.emitEvent({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
    });
  }
}
