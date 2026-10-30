import { randomUUID } from 'node:crypto';
import { CodexTurnUsage, observedCodexUsage } from './codex-turn-usage.js';
import { CodexTextProjection } from './codex-text-projection.js';
import type { StreamEvent } from '@mitzo/harness';
import type { ProviderFailure } from '@mitzo/protocol';
import { normalizeCodexToolResult, type CodexToolContentItem } from './codex-tool-result.js';
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
}
/** Converts Codex text/host-tool events into the existing query-loop event contract. */
export class CodexSessionEvents {
  private readonly texts: CodexTextProjection;
  private finishedTurns = new Set<string>();
  private startedTurns = new Set<string>();
  private compacted = new Set<string>();
  private lastAnonymousCompaction?: string;
  private lastCompactionId?: string;
  private commandTools = new Map<string, string>();
  private fileTools = new Map<string, string>();
  private finishedFiles = new Set<string>();
  private runtimeTools = new Map<string, string>();
  private turnFinished = false;
  private activeTurnId?: string;
  private usage: CodexTurnUsage;
  constructor(
    private conversationId: string,
    private threadId: string,
    private model: string,
    private emit: (event: ObjectValue) => void,
    options: {
      freshThread?: boolean;
      /** Owned provenance binds every item observation to one immutable turn and kind. */
      requireExactTurnIdentity?: boolean;
      /** Trusted generated visible text identity; never thinking or tool messages. */
      onTextMessageStarted?: (messageId: string, providerTurnId: string) => void;
    } = {},
  ) {
    this.usage = new CodexTurnUsage(options.freshThread);
    this.texts = new CodexTextProjection(
      {
        start: (kind, providerTurnId) => {
          const messageId = randomUUID();
          if (kind === 'text' && providerTurnId)
            options.onTextMessageStarted?.(messageId, providerTurnId);
          this.stream(
            {
              type: 'message_start',
              message: {
                id: messageId,
                model: this.model,
                role: 'assistant',
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            },
            true,
          );
          this.stream({
            type: 'content_block_start',
            index: 0,
            content_block:
              kind === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' },
          });
        },
        delta: (kind, text) =>
          this.stream({
            type: 'content_block_delta',
            index: 0,
            delta:
              kind === 'thinking'
                ? { type: 'thinking_delta', thinking: text }
                : { type: 'text_delta', text },
          }),
        complete: (kind, text) => {
          this.stream({ type: 'content_block_stop', index: 0 });
          this.emit({
            type: 'assistant',
            session_id: this.conversationId,
            parent_tool_use_id: null,
            message: {
              content: [
                kind === 'thinking' ? { type: 'thinking', thinking: text } : { type: 'text', text },
              ],
            },
          });
        },
      },
      options.requireExactTurnIdentity,
    );
  }
  setModel(model: string) {
    this.model = model;
  }
  beginReconnectReplay() {
    this.usage.invalidate();
    this.texts.beginReconnectReplay();
  }
  private stream(event: StreamEvent, rendererOnly = false) {
    this.emit({
      type: 'stream_event',
      event,
      parent_tool_use_id: null,
      ...(rendererOnly ? { renderer_only: true } : {}),
    });
  }
  flush() {
    this.texts.flush();
  }
  private compaction(method: string, params: ObjectValue, item?: ObjectValue, started = false) {
    const privateId =
      typeof item?.id === 'string'
        ? item.id
        : typeof params.compactionId === 'string'
          ? params.compactionId
          : typeof params.id === 'string'
            ? params.id
            : this.lastCompactionId;
    if (privateId) {
      this.lastCompactionId = privateId;
      const key = `${privateId}:${started ? 'started' : 'completed'}`;
      if (this.compacted.has(key)) return;
      this.compacted.add(key);
    } else {
      if (this.lastAnonymousCompaction === method) return;
      this.lastAnonymousCompaction = method;
    }
    this.emit({
      type: 'system',
      subtype: 'status',
      session_id: this.conversationId,
      status: started ? 'compacting' : 'Context compacted',
      ...(!started ? { compact_result: 'success' } : {}),
      ...(privateId ? { compaction_id: privateId } : {}),
    });
  }
  notification(method: string, params: ObjectValue, providerFailure?: ProviderFailure) {
    if (params.threadId !== this.threadId) return;
    const isCompactionNotification =
      method === 'thread/compacted' ||
      method === 'contextCompaction' ||
      ((method === 'item/started' || method === 'item/completed') &&
        object(params.item).type === 'contextCompaction');
    if (!isCompactionNotification) {
      this.lastAnonymousCompaction = undefined;
      this.lastCompactionId = undefined;
    }
    if (method === 'turn/started') {
      this.turnFinished = false;
      const turnId = object(params.turn).id;
      if (typeof turnId === 'string' && !this.startedTurns.has(turnId)) {
        this.activeTurnId = turnId;
        this.startedTurns.add(turnId);
        this.usage.start(turnId);
        this.emit({
          type: 'provider_turn_start',
          session_id: this.conversationId,
          turn_id: turnId,
          model: this.model,
        });
      }
      return;
    }
    // Provider events may be delivered late. Never create renderer blocks after
    // the terminal result for a turn; the next turn/started reopens the mapper.
    if (this.turnFinished && method.startsWith('item/')) return;
    const commandItem = object(params.item);
    if (
      (method === 'item/started' || method === 'item/completed') &&
      commandItem.type === 'fileChange' &&
      typeof commandItem.id === 'string' &&
      Array.isArray(commandItem.changes)
    ) {
      if (this.finishedFiles.has(commandItem.id)) return;
      let toolId = this.fileTools.get(commandItem.id);
      if (!toolId) {
        toolId = this.toolStart(commandItem.id, 'ApplyPatch', { changes: commandItem.changes });
        this.fileTools.set(commandItem.id, toolId);
      }
      if (
        method === 'item/completed' &&
        ['completed', 'failed', 'declined'].includes(String(commandItem.status))
      ) {
        this.fileTools.delete(commandItem.id);
        this.finishedFiles.add(commandItem.id);
        const completed = commandItem.status === 'completed';
        this.toolResult(
          toolId,
          completed
            ? `Applied ${commandItem.changes.length} file change(s).`
            : `File changes ${String(commandItem.status)}.`,
          !completed,
        );
      }
      return;
    }
    if (method === 'thread/compacted' || method === 'contextCompaction') {
      this.compaction(method, params);
      return;
    }
    if (
      (method === 'item/started' || method === 'item/completed') &&
      commandItem.type === 'contextCompaction'
    ) {
      this.compaction('contextCompaction', params, commandItem, method === 'item/started');
      return;
    }
    if (
      method === 'item/started' &&
      commandItem.type === 'reasoning' &&
      typeof commandItem.id === 'string'
    ) {
      this.texts.beginReasoningReplay(commandItem.id);
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
      const action = object(commandItem.action);
      const page = action.type === 'openPage' || action.type === 'findInPage';
      const queries = Array.isArray(action.queries)
        ? action.queries.filter((query): query is string => typeof query === 'string').join('; ')
        : undefined;
      this.runtimeTools.set(
        commandItem.id,
        this.toolStart(
          commandItem.id,
          page ? 'WebFetch' : 'WebSearch',
          page
            ? {
                url: typeof action.url === 'string' ? action.url : '',
                ...(typeof action.pattern === 'string' ? { pattern: action.pattern } : {}),
              }
            : {
                search_term:
                  typeof commandItem.query === 'string'
                    ? commandItem.query
                    : typeof action.query === 'string'
                      ? action.query
                      : (queries ?? ''),
              },
        ),
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
      if (this.activeTurnId && params.turnId !== this.activeTurnId) return;
      this.usage.update(params);
      const usage = observedCodexUsage(params);
      if (usage) this.emit({ type: 'provider_usage', model: this.model, ...usage });
      return;
    }
    if (
      method === 'item/reasoning/summaryTextDelta' &&
      typeof params.itemId === 'string' &&
      typeof params.delta === 'string' &&
      Number.isInteger(params.summaryIndex)
    ) {
      const id = `reasoning:${params.itemId}:${params.summaryIndex}`;
      this.texts.delta(id, 'thinking', params.delta, params.turnId);
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
          this.texts.complete(id, 'thinking', text, params.turnId);
        });
        return;
      }
    }
    if (
      method === 'item/agentMessage/delta' &&
      typeof params.itemId === 'string' &&
      typeof params.delta === 'string'
    ) {
      this.texts.delta(params.itemId, 'text', params.delta, params.turnId);
    } else if (method === 'item/completed') {
      const final = object(params.item);
      if (
        final.type !== 'agentMessage' ||
        typeof final.id !== 'string' ||
        typeof final.text !== 'string'
      )
        return;
      this.texts.complete(final.id, 'text', final.text, params.turnId);
    } else if (method === 'turn/completed') {
      const turn = object(params.turn);
      if (typeof turn.id !== 'string' || this.finishedTurns.has(turn.id)) return;
      // turn/completed carries no final usage watermark. The most recent
      // cumulative update may cover only an earlier request; the final update
      // can arrive after this result is durably sealed. Do not certify that
      // observed prefix, or use it as the next turn's accounting baseline.
      this.usage.invalidate();
      this.finishedTurns.add(turn.id);
      this.turnFinished = true;
      this.texts.endTurn();
      for (const [id, toolId] of this.fileTools) {
        this.finishedFiles.add(id);
        this.toolResult(toolId, 'File change interrupted before completion.', true);
      }
      this.fileTools.clear();
      this.emit({
        type: 'result',
        session_id: this.conversationId,
        is_error: turn.status !== 'completed',
        ...(providerFailure ? { provider_failure: providerFailure } : {}),
        usage_status: 'unknown',
      });
    }
  }
  toolStart(_providerCallId: string, name: string, input: ObjectValue): string {
    this.flush();
    const id = randomUUID();
    this.stream(
      {
        type: 'message_start',
        message: {
          id: randomUUID(),
          model: this.model,
          role: 'assistant',
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      true,
    );
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
  toolResult(id: string, content: string, isError: boolean, contentItems?: CodexToolContentItem[]) {
    const result = normalizeCodexToolResult({
      content,
      isError,
      ...(contentItems ? { contentItems } : {}),
    });
    let precedingText = false;
    const blocks = result.contentItems?.map((item) => {
      if (item.type === 'inputText') {
        // The public extractor concatenates SDK text blocks. Preserve the
        // authoritative receipt's separators without changing image order.
        const text = (precedingText ? '\n' : '') + item.text;
        precedingText = true;
        return { type: 'text', text };
      }
      const split = item.imageUrl.indexOf(';base64,');
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: item.imageUrl.slice(5, split),
          data: item.imageUrl.slice(split + 8),
        },
      };
    });
    this.emit({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: id, content: blocks ?? content, is_error: isError },
        ],
      },
    });
  }
}
