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
export { NativeResponsesStore } from './native-responses-store.js';

interface NativeResponsesOptions extends Omit<ModelSessionConfig, 'model' | 'signal' | 'thinking'> {
  conversationId: string;
  binding: AccountBinding;
  apiKey: string;
  store: NativeResponsesStore;
  maxTurns?: number;
  executeTool: (block: ToolUseBlock, signal: AbortSignal) => Promise<ToolResultBlock>;
}

/** Fill unresolved calls with explicit uncertainty; never replay tools following a crash. */
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
  constructor(private options: NativeResponsesOptions) {
    if (options.binding.provider !== 'openai')
      throw new Error('Native Responses requires an explicit OpenAI API account');
    if (!options.apiKey.trim()) throw new Error('OpenAI API key is required');
    if (!options.conversationId) throw new Error('Application conversation ID is required');
    if (
      options.maxTurns !== undefined &&
      (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)
    )
      throw new Error('Invalid native turn limit');
  }
  interrupt() {
    this.active?.abort();
  }
  async *run(prompt: string, signal?: AbortSignal) {
    if (this.active) throw new Error('Native Responses conversation already running');
    signal?.throwIfAborted();
    const opts = this.options;
    const state = opts.store.begin(opts.conversationId, opts.binding);
    const abort = new AbortController();
    this.active = abort;
    const onAbort = () => abort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const save = () => opts.store.save(opts.conversationId, opts.binding, state);
    let completed = false;
    try {
      recoverToolResults(state);
      state.history.push({ role: 'user', content: prompt });
      save();
      const session = new ResponsesSession(
        {
          model: opts.binding.model,
          systemPrompt: opts.systemPrompt,
          maxTokens: opts.maxTokens,
          tools: opts.tools,
          signal: abort.signal,
        },
        { accountId: opts.binding.accountId, apiKey: opts.apiKey, checkpoint: state.checkpoint },
      );
      for await (const event of runAgenticLoop(session, state.history, {
        sessionId: opts.conversationId,
        maxTurns: opts.maxTurns ?? 50,
        signal: abort.signal,
        executeTool: async (block) => {
          try {
            return await opts.executeTool(block, abort.signal);
          } catch {
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
      if (abort.signal.aborted) throw new Error('Native Responses turn interrupted');
      throw err;
    } finally {
      abort.abort();
      signal?.removeEventListener('abort', onAbort);
      this.active = undefined;
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
