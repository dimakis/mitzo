import { randomUUID } from 'node:crypto';
import type { StreamEvent } from '@mitzo/harness';
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
}
/** Converts Codex text/host-tool events into the existing query-loop event contract. */
export class CodexSessionEvents {
  private texts = new Map<string, { text: string; closed: boolean; messageId: string }>();
  private finishedTurns = new Set<string>();
  constructor(
    private conversationId: string,
    private threadId: string,
    private model: string,
    private emit: (event: ObjectValue) => void,
  ) {}
  setModel(model: string) {
    this.model = model;
  }
  private stream(event: StreamEvent) {
    this.emit({ type: 'stream_event', event, parent_tool_use_id: null });
  }
  private start(id: string) {
    let item = this.texts.get(id);
    if (item) return item;
    // The existing renderer has one active assistant message. Finish it before another begins.
    this.flush();
    item = { text: '', closed: false, messageId: randomUUID() };
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
      content_block: { type: 'text', text: '' },
    });
    return item;
  }
  private complete(id: string) {
    const item = this.texts.get(id);
    if (!item || item.closed) return;
    item.closed = true;
    this.stream({ type: 'content_block_stop', index: 0 });
    this.emit({
      type: 'assistant',
      session_id: this.conversationId,
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: item.text }] },
    });
  }
  flush() {
    for (const [id] of this.texts) this.complete(id);
  }
  notification(method: string, params: ObjectValue) {
    if (params.threadId !== this.threadId) return;
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
      this.flush();
      this.emit({ type: 'result', session_id: this.conversationId });
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
    this.emit({
      type: 'assistant',
      session_id: this.conversationId,
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
    return id;
  }
  toolResult(id: string, content: string, isError: boolean) {
    this.emit({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
    });
  }
}
