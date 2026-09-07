import { z } from 'zod';
import type { AccountBinding } from '@mitzo/protocol';
import type { ToolDefinition } from '@mitzo/harness';
import type { CodexLifecycleTransport } from './codex-app-server-client.js';
import { verifyCodexAccount, type CodexAccountProfile } from './codex-account.js';
import {
  CodexConversationStore,
  type CodexCommand,
  type CodexCommandInput,
} from './codex-conversation-store.js';
import { codexRuntimeOverrides } from './codex-runtime-policy.js';
import { CodexSessionEvents } from './codex-session-events.js';
type ObjectValue = Record<string, unknown>;
interface Rpc {
  initialize(): Promise<void>;
  request(method: string, params: ObjectValue): Promise<unknown>;
  close(): void;
}
interface Options {
  conversationId: string;
  cwd: string;
  profile: CodexAccountProfile;
  storedBinding?: AccountBinding;
  store: CodexConversationStore;
  systemPrompt: string;
  tools: ToolDefinition[];
  /** The owner must supply a transport with a verified, constrained tool surface. */
  createClient(callbacks: CodexLifecycleTransport): Rpc;
  emit(event: ObjectValue): void;
  executeTool(
    name: string,
    input: ObjectValue,
    signal: AbortSignal,
  ): Promise<{ content: string; isError: boolean }>;
  validateModel?: (model: string) => void;
  onQueueChange?: () => void;
  onClosed?: () => void;
  onError?: (error: Error) => void;
}
const ToolCall = z.object({
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string().min(1),
  namespace: z.null().optional(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
/** Owns one application conversation. The process, private store and public event sink are supplied by the server. */
export class CodexConversation {
  private client: Rpc;
  private binding?: AccountBinding;
  private threadId?: string;
  private mapper?: CodexSessionEvents;
  private active?: {
    command: CodexCommand;
    turnId?: string;
    completion?: ObjectValue;
    abort: AbortController;
  };
  private paused = false;
  private closed = false;
  private ready = false;
  private pumping?: Promise<void>;
  constructor(private opts: Options) {
    this.client = opts.createClient({
      onNotification: (m, p) => this.notification(m, p),
      onRequest: (m, p, s) => this.request(m, p, s),
      onClose: () => this.close(),
    });
  }
  async initialize() {
    if (this.ready) throw new Error('Codex conversation already initialized');
    await this.client.initialize();
    this.binding = await verifyCodexAccount(
      this.client,
      this.opts.profile,
      this.opts.storedBinding,
    );
    this.opts.store.create(this.opts.conversationId, this.binding, this.opts.cwd);
    const state = this.opts.store.read(this.opts.conversationId, this.binding);
    this.paused = !!state.recovery;
    const configResponse = z
      .object({ config: z.unknown() })
      .parse(
        await this.client.request('config/read', { cwd: this.opts.cwd, includeLayers: false }),
      );
    const runtimeConfig = codexRuntimeOverrides(configResponse.config);
    const method = state.threadId ? 'thread/resume' : 'thread/start';
    const result = z
      .object({
        thread: z.object({ id: z.string().min(1) }),
        model: z.string(),
        modelProvider: z.string(),
      })
      .parse(
        await this.client.request(method, {
          ...(state.threadId ? { threadId: state.threadId } : {}),
          model: this.binding.model,
          modelProvider: 'openai',
          allowProviderModelFallback: false,
          cwd: this.opts.cwd,
          config: runtimeConfig,
          environments: [],
          approvalPolicy: 'never',
          sandbox: 'read-only',
          developerInstructions: this.opts.systemPrompt,
          dynamicTools: this.opts.tools.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            inputSchema: t.input_schema,
          })),
        }),
      );
    if (
      result.model !== this.binding.model ||
      result.modelProvider !== 'openai' ||
      (state.threadId && result.thread.id !== state.threadId)
    )
      throw new Error('Codex execution binding changed');
    this.threadId = result.thread.id;
    this.opts.store.bindThread(this.opts.conversationId, this.binding, this.threadId);
    this.mapper = new CodexSessionEvents(
      this.opts.conversationId,
      this.threadId,
      this.binding.model,
      this.opts.emit,
    );
    this.ready = true;
    this.opts.emit({ type: 'system', subtype: 'init', session_id: this.opts.conversationId });
    this.opts.onQueueChange?.();
  }
  isPaused() {
    return this.paused;
  }
  queue() {
    if (!this.binding) return [];
    return this.opts.store.commands(this.opts.conversationId, this.binding);
  }
  validateModel(model: string) {
    if (this.opts.validateModel) this.opts.validateModel(model);
    else if (model !== this.opts.profile.model) throw new Error('Model unavailable');
  }
  enqueue(input: CodexCommandInput) {
    if (!this.ready || this.closed) throw new Error('Codex conversation unavailable');
    // Built-in Codex skill readers cannot yet be mediated; do not silently weaken a ceiling.
    if (input.allowedTools)
      throw new Error('Codex execution does not yet support restricted skill tool ceilings');
    const commands = this.queue();
    const model =
      input.model ??
      commands.find((c) => c.id === input.id)?.model ??
      commands.at(-1)?.model ??
      this.binding!.model;
    this.validateModel(model);
    this.opts.store.enqueue(this.opts.conversationId, this.binding!, { ...input, model });
    this.opts.onQueueChange?.();
  }
  async send(input: CodexCommandInput) {
    this.enqueue(input);
    await this.startQueued();
  }
  async startQueued() {
    if (!this.ready || this.closed) throw new Error('Codex conversation unavailable');
    if (this.paused) return;
    await this.pump();
  }
  async acknowledgeRecovery() {
    if (!this.ready || this.closed) throw new Error('Codex conversation unavailable');
    this.opts.store.acknowledgeRecovery(this.opts.conversationId, this.binding!);
    this.paused = false;
    await this.pump();
  }
  private pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    if (this.active || this.paused || this.closed) return Promise.resolve();
    this.pumping = this.beginNext().finally(() => {
      this.pumping = undefined;
    });
    return this.pumping;
  }
  private async beginNext() {
    const command = this.opts.store.claimNext(this.opts.conversationId, this.binding!);
    if (!command) return;
    const active = {
      command,
      abort: new AbortController(),
      turnId: undefined as string | undefined,
      completion: undefined as ObjectValue | undefined,
    };
    this.active = active;
    this.opts.onQueueChange?.();
    try {
      const model = command.model ?? this.binding!.model;
      this.validateModel(model);
      this.mapper?.setModel(model);
      await verifyCodexAccount(this.client, this.opts.profile, this.binding);
      active.abort.signal.throwIfAborted();
      const result = z.object({ turn: z.object({ id: z.string() }) }).parse(
        await this.client.request('turn/start', {
          threadId: this.threadId,
          clientUserMessageId: command.id,
          model,
          input: [{ type: 'text', text: command.prompt }],
          environments: [],
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly' },
          effort: 'low',
        }),
      );
      if (this.active === active) {
        if (active.turnId && active.turnId !== result.turn.id)
          throw new Error('Codex turn identity changed');
        active.turnId = result.turn.id;
        if (active.completion) this.notification('turn/completed', active.completion);
      }
    } catch (error: unknown) {
      this.paused = true;
      active.abort.abort();
      this.opts.store.finish(this.opts.conversationId, this.binding!, command.id, 'failed');
      if (this.active === active) this.active = undefined;
      this.opts.onQueueChange?.();
      throw error;
    }
  }
  private notification(method: string, params: ObjectValue) {
    if (this.closed || params.threadId !== this.threadId) return;
    const turn = z.object({ id: z.string(), status: z.string().optional() }).safeParse(params.turn);
    if (method === 'turn/started' && turn.success && this.active) {
      if (this.active.turnId && this.active.turnId !== turn.data.id) {
        this.close();
        return;
      }
      this.active.turnId = turn.data.id;
    }
    if (method === 'turn/completed') {
      if (!turn.success || !this.active) return;
      if (!this.active.turnId) {
        // Wait for the start response to confirm identity; do not accept a stale turn.
        this.active.completion = params;
        return;
      }
      if (this.active.turnId !== turn.data.id) return;
      const status =
        turn.data.status === 'completed'
          ? 'completed'
          : turn.data.status === 'interrupted'
            ? 'interrupted'
            : 'failed';
      this.active.abort.abort();
      this.opts.store.finish(
        this.opts.conversationId,
        this.binding!,
        this.active.command.id,
        status,
      );
      this.active = undefined;
      this.paused ||= status !== 'completed';
      this.mapper?.notification(method, params);
      this.opts.onQueueChange?.();
      // Completion can arrive before turn/start resolves. Wait for that request to settle.
      Promise.resolve(this.pumping)
        .then(() => this.pump())
        .catch((e) => this.opts.onError?.(e instanceof Error ? e : new Error('Codex turn failed')));
      return;
    }
    this.mapper?.notification(method, params);
  }
  private async request(
    method: string,
    params: ObjectValue,
    signal: AbortSignal,
  ): Promise<ObjectValue> {
    if (method !== 'item/tool/call') throw new Error('Unsupported Codex host request');
    const call = ToolCall.parse(params);
    const active = this.active;
    if (this.closed || !active || call.threadId !== this.threadId || call.turnId !== active.turnId)
      throw new Error('Codex tool identity mismatch');
    if (!this.opts.tools.some((t) => t.name === call.tool))
      throw new Error('Unsupported Codex tool');
    const toolSignal = AbortSignal.any([signal, active.abort.signal]);
    toolSignal.throwIfAborted();
    if (
      !this.opts.store.claimTool(
        this.opts.conversationId,
        this.binding!,
        active.command.id,
        call.callId,
      )
    )
      return {
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: 'Previously attempted tool call. Outcome may be unknown; inspect current state before retrying.',
          },
        ],
      };
    const publicId = this.mapper!.toolStart(call.callId, call.tool, call.arguments);
    let result: { content: string; isError: boolean };
    try {
      result = await this.opts.executeTool(call.tool, call.arguments, toolSignal);
    } catch {
      result = {
        content: 'Tool failed or was interrupted. Inspect current state before retrying.',
        isError: true,
      };
    }
    this.mapper!.toolResult(publicId, result.content, result.isError);
    return {
      success: !result.isError,
      contentItems: [{ type: 'inputText', text: result.content }],
    };
  }
  async interrupt() {
    if (this.closed) return;
    this.paused = true;
    const active = this.active;
    if (!active) return;
    active.abort.abort();
    if (active.turnId) {
      try {
        await this.client.request('turn/interrupt', {
          threadId: this.threadId,
          turnId: active.turnId,
        });
      } catch (error) {
        if (!this.closed) throw error;
      }
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.paused = true;
    this.active?.abort.abort();
    if (this.binding && this.active)
      this.opts.store.finish(
        this.opts.conversationId,
        this.binding,
        this.active.command.id,
        'interrupted',
      );
    this.active = undefined;
    this.mapper?.flush();
    this.client.close();
    this.opts.onQueueChange?.();
    this.opts.onClosed?.();
  }
}
