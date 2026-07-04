/**
 * Provider-agnostic agentic session types.
 *
 * ModelSession is the abstraction that replaces the Agent SDK's query() function.
 * It handles a single LLM call (one turn of the agentic loop), streaming back
 * normalized events. Mitzo owns the agentic loop and calls ModelSession.turn()
 * repeatedly until the model produces no tool_use blocks.
 *
 * The event types map closely to the Anthropic Messages API streaming format
 * because praxis-proxy normalizes all providers to that wire format.
 */

// ── Tool definitions (sent to the model) ─────────────────────────

/** A tool the model can invoke. Provider-agnostic schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ── Conversation messages ────────────────────────────────────────

/** A content block in a message. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/** A message in the conversation history. */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

// ── Streaming events (from model) ────────────────────────────────

/** Fired when the model starts a new message. */
export interface MessageStartEvent {
  type: 'message_start';
  message: {
    id: string;
    model: string;
    role: 'assistant';
    usage: { input_tokens: number; output_tokens: number };
  };
}

/** Fired when a content block begins. */
export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block:
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
}

/** Incremental content within a block. */
export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'thinking_delta'; thinking: string }
    | { type: 'input_json_delta'; partial_json: string };
}

/** Fired when a content block ends. */
export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

/** Fired when the message is complete. */
export interface MessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
    stop_sequence?: string | null;
  };
  usage: { output_tokens: number };
}

/** Union of all streaming events from a single turn. */
export type StreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent;

// ── Session configuration ────────────────────────────────────────

/** Configuration for a model session. */
export interface ModelSessionConfig {
  /** Model identifier (e.g. 'claude-opus-4-6', 'gpt-5.5'). */
  model: string;
  /** System prompt text. */
  systemPrompt: string;
  /** Maximum output tokens per turn. */
  maxTokens: number;
  /** Available tools. */
  tools?: ToolDefinition[];
  /** Enable extended thinking. */
  thinking?: { type: 'enabled'; budget_tokens: number };
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

// ── ModelSession interface ───────────────────────────────────────

/**
 * A provider-agnostic streaming model session.
 *
 * Each call to turn() sends the conversation history to the model and
 * streams back events. The caller (Mitzo's agentic loop) inspects the
 * response for tool_use blocks, executes them, appends tool_result
 * messages, and calls turn() again.
 *
 * Implementations:
 *   - AnthropicSession: calls Anthropic Messages API (direct or via praxis-proxy)
 *   - (future) ResponsesSession: calls OpenAI Responses API with server-side state
 */
export interface ModelSession {
  /** Provider name for logging/tracing. */
  readonly provider: string;

  /**
   * Execute one turn of the conversation.
   *
   * @param messages - Full conversation history (client-owned state).
   * @returns An async iterable of streaming events for this turn.
   */
  turn(messages: ConversationMessage[]): AsyncIterable<StreamEvent>;
}

/**
 * Factory function to create a ModelSession from config.
 * Different providers have different construction needs.
 */
export type ModelSessionFactory = (config: ModelSessionConfig) => ModelSession;
