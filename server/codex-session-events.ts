import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StreamEvent } from '@mitzo/harness';
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
  private commandTools = new Map<string, string>();
  private turnFinished = false;
  private usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  };
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
    this.emit({
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
  notification(method: string, params: ObjectValue) {
    if (params.threadId !== this.threadId) return;
    if (method === 'turn/started') {
      this.turnFinished = false;
      return;
    }
    const commandItem = object(params.item);
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
      const output = typeof commandItem.aggregatedOutput === 'string' ? commandItem.aggregatedOutput : '';
      this.toolResult(
        toolId,
        output || (exitCode === undefined ? String(commandItem.status ?? '') : `exit code ${exitCode}`),
        commandItem.status !== 'completed' || (exitCode !== undefined && exitCode !== 0),
      );
      return;
    }
    // Provider events may be delivered late. Never create renderer blocks after
    // the terminal result for a turn; the next turn/started reopens the mapper.
    if (this.turnFinished && method.startsWith('item/')) return;
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
      const item = this.start(`reasoning:${params.itemId}:${params.summaryIndex}`, 'thinking');
      if (item.closed) return;
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
          const item = this.start(id, 'thinking');
          if (item.closed) return;
          if (!item.text) {
            item.text = text;
            this.stream({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: text },
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
      this.flush();
      this.emit({
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
