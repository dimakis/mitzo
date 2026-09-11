import { GeminiSession, type GeminiOptions } from './gemini-session.js';
import type { AccountBinding } from '@mitzo/protocol';
import {
  ResponsesSession,
  runAgenticLoop,
  type ContentBlock,
  type ModelSessionConfig,
  type ToolUseBlock,
  type ToolResultBlock,
} from '@mitzo/harness';
import { NativeResponsesStore, type NativeResponsesState } from './native-responses-store.js';
import { createLogger } from './logger.js';
const log = createLogger('native-responses');

interface NativeResponsesOptions extends Omit<
  ModelSessionConfig,
  'model' | 'signal' | 'thinking' | 'reasoningEffort'
> {
  conversationId: string;
  binding: AccountBinding;
  apiKey?: string;
  gemini?: GeminiOptions;
  store: NativeResponsesStore;
  maxTurns?: number;
  selectedModel?: string;
  reasoningEffort?: string | null;
  executeTool: (block: ToolUseBlock, signal: AbortSignal) => Promise<ToolResultBlock>;
}

/** Mutates state.history to fill unresolved calls with uncertainty; never replays tools. */
function recoverToolResults(state: NativeResponsesState) {
  const lastAssistant = state.history.map((message) => message.role).lastIndexOf('assistant');
  if (lastAssistant < 0) return;
  const content = state.history[lastAssistant].content;
  if (typeof content === 'string') return;
  const results = state.history
    .slice(lastAssistant + 1)
    .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
    .filter((block) => block.type === 'tool_result');
  const missing: ContentBlock[] = content
    .filter(
      (block) =>
        block.type === 'tool_use' && !results.some((result) => result.tool_use_id === block.id),
    )
    .map((block) => ({
      type: 'tool_result',
      tool_use_id: (block as ToolUseBlock).id,
      content:
        'Execution interrupted. Outcome unknown; inspect current state before attempting this action again.',
      is_error: true,
    }));
  if (missing.length) state.history.push({ role: 'user', content: missing });
}

/** One explicit user turn at a time. The server retains ownership of queues and transport.
 * Uses application conversation IDs only; provider response IDs stay in provider events.
 */
export class NativeResponsesRunner {
  private active?: AbortController;
  private prepared = new Map<
    string,
    {
      prompt: string;
      state: NativeResponsesState;
      selection?: { model?: string; reasoningEffort?: string | null };
    }
  >();
  private idleWaiters: (() => void)[] = [];
  constructor(private options: NativeResponsesOptions) {
    if (options.binding.provider === 'openai') {
      if (!options.apiKey?.trim() || options.gemini) throw new Error('OpenAI API key is required');
    } else if (options.binding.provider === 'google-vertex') {
      if (
        !options.gemini ||
        options.apiKey ||
        options.gemini.accountId !== options.binding.accountId
      )
        throw new Error('Explicit Google Vertex account is required');
    } else throw new Error('Native runtime requires an explicit API account');
    if (!options.conversationId) throw new Error('Application conversation ID is required');
    if (
      options.maxTurns !== undefined &&
      (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)
    )
      throw new Error('Invalid native turn limit');
  }
  interrupt() {
    this.active?.abort();
    for (const { state } of this.prepared.values()) {
      state.status = 'interrupted';
      try {
        this.options.store.save(this.options.conversationId, this.options.binding, state);
      } catch {
        log.warn('could not persist prepared interruption; startup recovery required', {
          conversationId: this.options.conversationId,
        });
      }
    }
    this.prepared.clear();
  }
  isRunning() {
    return !!this.active || this.prepared.size > 0;
  }
  waitUntilIdle() {
    if (!this.active) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }
  /** Durably claim a follow-up before the public transcript acknowledges it. */
  prepare(
    messageId: string,
    prompt: string,
    selection?: { model?: string; reasoningEffort?: string | null },
  ) {
    if (this.active || this.prepared.size)
      throw new Error('Native Responses conversation already running');
    const state = this.options.store.begin(this.options.conversationId, this.options.binding);
    recoverToolResults(state);
    state.history.push({ role: 'user', content: prompt });
    this.options.store.save(this.options.conversationId, this.options.binding, state);
    this.prepared.set(messageId, { prompt, state, selection });
  }
  // Lazy generator: merely constructing it starts no work and holds no lease.
  // At first next(), both guards run synchronously before any await/yield.
  async *run(prompt: string, signal?: AbortSignal, messageId?: string) {
    if (this.active) throw new Error('Native Responses conversation already running');
    signal?.throwIfAborted();
    const opts = this.options;
    const prepared = messageId ? this.prepared.get(messageId) : undefined;
    if (messageId && (!prepared || prepared.prompt !== prompt))
      throw new Error('Native Responses prepared message identity changed');
    if (messageId) this.prepared.delete(messageId);
    const state = prepared?.state ?? opts.store.begin(opts.conversationId, opts.binding);
    const abort = new AbortController();
    this.active = abort;
    const onAbort = () => abort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const save = () => opts.store.save(opts.conversationId, opts.binding, state);
    let completed = false;
    try {
      if (!prepared) {
        recoverToolResults(state);
        state.history.push({ role: 'user', content: prompt });
        save();
      }
      const selectedModel = prepared?.selection?.model ?? opts.selectedModel ?? opts.binding.model;
      const checkpoint =
        state.checkpoint && state.checkpoint.model !== selectedModel
          ? {
              ...state.checkpoint,
              model: selectedModel,
              input: state.checkpoint.input.filter((item) => item.type !== 'reasoning'),
            }
          : state.checkpoint;
      const selectedReasoningEffort =
        prepared?.selection && 'reasoningEffort' in prepared.selection
          ? prepared.selection.reasoningEffort
          : opts.reasoningEffort;
      const config = {
        model: selectedModel,
        systemPrompt: opts.systemPrompt,
        maxTokens: opts.maxTokens,
        tools: opts.tools,
        reasoningEffort: selectedReasoningEffort ?? undefined,
        signal: abort.signal,
      };
      const session = opts.gemini
        ? new GeminiSession(config, { ...opts.gemini, checkpoint })
        : new ResponsesSession(config, {
            accountId: opts.binding.accountId,
            apiKey: opts.apiKey!,
            checkpoint,
          });
      for await (const event of runAgenticLoop(session, state.history, {
        sessionId: opts.conversationId,
        maxTurns: opts.maxTurns ?? 50,
        signal: abort.signal,
        executeTool: async (block) => {
          try {
            return await opts.executeTool(block, abort.signal);
          } catch {
            // Redact native failures here; the generic loop catch remains for other callers.
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              content: abort.signal.aborted
                ? 'Execution interrupted. Outcome unknown; inspect current state before retrying.'
                : 'Native tool execution failed; inspect current state before retrying.',
              is_error: true,
            };
          }
        },
        onHistory: (history) => {
          state.history = history;
          state.checkpoint = session.checkpoint();
          save();
        },
      })) {
        abort.signal.throwIfAborted();
        if (event.type === 'result') {
          if (state.history.at(-1)?.role !== 'assistant')
            throw new Error('Native Responses tool loop limit reached');
          state.status = 'idle';
          save();
          completed = true;
        }
        yield event;
      }
    } catch (err: unknown) {
      if (abort.signal.aborted)
        throw new Error('Native Responses turn interrupted', { cause: err });
      throw err;
    } finally {
      abort.abort();
      signal?.removeEventListener('abort', onAbort);
      this.active = undefined;
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
      if (!completed) {
        state.status = 'interrupted';
        try {
          save();
        } catch {
          // A failed durable write cannot be repaired in memory. Leave startup recovery
          // to mark the persisted running row interrupted, preserving the original error.
          log.warn('could not persist interruption; startup recovery required', {
            conversationId: opts.conversationId,
          });
        }
      }
    }
  }
}
