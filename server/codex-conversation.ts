import { z } from 'zod';
import { CodexUserInput } from './codex-user-input.js';
import type { AccountBinding } from '@mitzo/protocol';
import type { ToolDefinition } from '@mitzo/harness';
import { CodexRequestError, type CodexLifecycleTransport } from './codex-app-server-client.js';
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
  requestUserInput?: (params: ObjectValue, signal: AbortSignal) => Promise<ObjectValue>;
  validateModel?: (model: string, reasoningEffort?: string) => void;
  displayToolName?: (name: string) => string;
  /** Resolve control-plane prerequisites before the prompt reaches the provider. */
  prepareTurn?: (
    turn: { providerPrompt: string; userIntent?: string; turnId: string },
    signal: AbortSignal,
  ) => Promise<string | void>;
  beforeComplete?: (signal: AbortSignal) => Promise<void>;
  beforeReconnect?: () => Promise<void>;
  reconnectGuard?: (work: () => Promise<void>) => Promise<void>;
  completionHookTimeoutMs?: number;
  runtimeCwd?: string;
  modelProvider?: string;
  runtimeConfig?: Record<string, unknown>;
  turnSandboxPolicy?: Record<string, unknown>;
  verifyBinding?: (client: Rpc, stored?: AccountBinding) => Promise<AccountBinding>;
  onQueueChange?: () => void;
  onActivity?: () => boolean | void;
  onThreadChanged?: (threadId: string) => void | Promise<void>;
  onClosed?: () => void;
  onError?: (error: Error) => void;
}

function sendCancelledError(): Error {
  const error = new Error('Send cancelled');
  error.name = 'AbortError';
  return error;
}

function raceWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(sendCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(sendCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

const ToolCall = z.object({
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string().min(1),
  namespace: z.null().optional(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

/**
 * The app server can carry provider diagnostics in a failed turn. Never relay
 * that payload verbatim: it can contain provider URLs, headers, or credentials.
 * These stable messages retain the actionable failure class without exposing
 * any provider-controlled text.
 */
export function codexTurnFailureDiagnostic(value: unknown): string {
  const message =
    typeof value === 'string'
      ? value
      : z.object({ message: z.string().optional() }).passthrough().safeParse(value).data?.message;
  if (typeof message !== 'string') return 'The provider did not complete the turn.';
  if (/(?:credential.*traffic.*denied|credential[ -]bearing.*cannot be inspected)/i.test(message))
    return 'OpenShell denied the provider request because its credential-bearing body could not be inspected.';
  if (/stream disconnected before completion/i.test(message))
    return 'The provider stream disconnected before completion.';
  if (/context[_ -]length[_ -]exceeded/i.test(message))
    return 'The provider rejected the turn because its context is too large.';
  if (/timed? out/i.test(message)) return 'The provider request timed out.';
  return 'The provider did not complete the turn.';
}

function isRecoverableProviderTransportFailure(value: unknown): boolean {
  const message =
    typeof value === 'string'
      ? value
      : z.object({ message: z.string().optional() }).passthrough().safeParse(value).data?.message;
  return typeof message === 'string' && /stream disconnected before completion/i.test(message);
}

function requiresProviderThreadReplacement(error: unknown): boolean {
  return (
    error instanceof CodexRequestError &&
    error.method === 'turn/start' &&
    !['rate_limit', 'authentication', 'context_limit', 'invalid_request'].includes(error.category)
  );
}
/** Owns one application conversation. The process, private store and public event sink are supplied by the server. */
export class CodexConversation {
  private client: Rpc;
  private transportGeneration = 0;
  private binding?: AccountBinding;
  private threadId?: string;
  private mapper?: CodexSessionEvents;
  private active?: {
    command: CodexCommand;
    turnId?: string;
    completion?: ObjectValue;
    completionHook?: 'pending' | 'done';
    interruptRequested?: boolean;
    abort: AbortController;
  };
  private paused = false;
  private closed = false;
  private ready = false;
  private pumping?: Promise<void>;
  private recovery?: Promise<void>;
  private automaticTransportRecoveryAttempted = false;
  private explicitEnqueue: Promise<unknown> = Promise.resolve();
  private recoveryPhase?: 'starting_workspace' | 'reconnecting';
  constructor(private opts: Options) {
    this.client = this.createClient();
  }
  private createClient() {
    const generation = ++this.transportGeneration;
    return this.opts.createClient({
      onNotification: (m, p) => this.notification(m, p),
      onRequest: (m, p, s) => this.request(m, p, s),
      onClose: (error) => this.transportClosed(generation, error),
    });
  }
  private transportClosed(generation: number, _error: Error) {
    if (this.closed || generation !== this.transportGeneration) return;
    // Invalidate every in-flight request owned by this transport. Its rejection
    // is recovery fallout, not a second fatal send failure.
    this.transportGeneration += 1;
    this.ready = false;
    const commandId = this.active?.command.id;
    this.active?.abort.abort();
    this.active = undefined;
    try {
      if (this.binding)
        this.opts.store.pauseForRecovery(
          this.opts.conversationId,
          this.binding,
          commandId,
          'interrupted',
        );
    } catch (persistenceError) {
      this.opts.onError?.(
        persistenceError instanceof Error
          ? persistenceError
          : new Error('Codex recovery persistence failed'),
      );
    }
    this.paused = true;
    this.opts.onQueueChange?.();
    this.opts.onError?.(new Error('Codex transport disconnected; recovery is available'));
  }
  private verifyCurrentBinding(stored?: AccountBinding) {
    return this.opts.verifyBinding
      ? this.opts.verifyBinding(this.client, stored)
      : verifyCodexAccount(this.client, this.opts.profile, stored);
  }
  async initialize() {
    if (this.ready) throw new Error('Codex conversation already initialized');
    await this.client.initialize();
    this.binding = await this.verifyCurrentBinding(this.opts.storedBinding);
    this.opts.store.create(this.opts.conversationId, this.binding, this.opts.cwd);
    const state = this.opts.store.read(this.opts.conversationId, this.binding);
    this.paused = !!state.recovery;
    const configResponse = z.object({ config: z.unknown() }).parse(
      await this.client.request('config/read', {
        cwd: this.opts.runtimeCwd ?? this.opts.cwd,
        includeLayers: false,
      }),
    );
    const runtimeConfig =
      this.opts.runtimeConfig ??
      codexRuntimeOverrides(configResponse.config, this.opts.profile.workspaceId);
    const modelProvider = this.opts.modelProvider ?? 'openai';
    const threadOptions = this.threadOptions(runtimeConfig, modelProvider);
    const replacingFailedThread = !!state.threadId && state.recoveryStrategy === 'fork';
    const result = replacingFailedThread
      ? await this.replaceFailedProviderThread(this.client, state, threadOptions)
      : z
          .object({
            thread: z.object({ id: z.string().min(1) }),
            model: z.string(),
            modelProvider: z.string(),
          })
          .parse(
            await this.client.request(state.threadId ? 'thread/resume' : 'thread/start', {
              ...(state.threadId ? { threadId: state.threadId } : {}),
              ...threadOptions,
              allowProviderModelFallback: false,
              ...this.dynamicToolsOption(),
            }),
          );
    if (
      result.model !== this.binding.model ||
      result.modelProvider !== modelProvider ||
      (!replacingFailedThread && state.threadId && result.thread.id !== state.threadId)
    )
      throw new Error('Codex execution binding changed');
    this.threadId = result.thread.id;
    if (!replacingFailedThread)
      this.opts.store.bindThread(this.opts.conversationId, this.binding, this.threadId);
    this.resetMapper(this.threadId);
    this.ready = true;
    this.opts.emit({ type: 'system', subtype: 'init', session_id: this.opts.conversationId });
    this.opts.onQueueChange?.();
  }
  isPaused() {
    return this.paused;
  }
  isRecovering() {
    return !!this.recoveryPhase;
  }
  getRecoveryPhase() {
    return this.recoveryPhase;
  }
  /** Exposed only to the server lifecycle bridge after initialize has bound the
   * provider thread. Undefined means no checkpoint/deletion record may exist. */
  getThreadId() {
    return this.threadId;
  }
  queue() {
    if (!this.binding) return [];
    return this.opts.store.commands(this.opts.conversationId, this.binding);
  }
  validateModel(model: string, reasoningEffort?: string | null) {
    if (this.opts.validateModel) this.opts.validateModel(model, reasoningEffort ?? undefined);
    else if (model !== this.opts.profile.model) throw new Error('Model unavailable');
  }
  enqueue(input: CodexCommandInput) {
    // A transport loss keeps the durable binding. Accept an explicit new user
    // message before reconnecting so it cannot be lost between recovery and send.
    if (this.closed || (!this.ready && !this.paused) || !this.binding)
      throw new Error('Codex conversation unavailable');
    // Built-in Codex skill readers cannot yet be mediated; do not silently weaken a ceiling.
    if (input.allowedTools)
      throw new Error('Codex execution does not yet support restricted skill tool ceilings');
    if (this.opts.onActivity?.() === false)
      throw new Error('OpenShell lifecycle mutation is in progress');
    const commands = this.queue();
    const previousModel =
      commands.find((c) => c.id === input.id)?.model ??
      commands.at(-1)?.model ??
      this.binding!.model;
    const model = input.model ?? previousModel;
    const reasoningEffort =
      input.model && input.model !== previousModel && input.reasoningEffort === undefined
        ? null
        : input.reasoningEffort;
    this.validateModel(model, reasoningEffort);
    this.opts.store.enqueue(this.opts.conversationId, this.binding!, {
      ...input,
      model,
      reasoningEffort,
    });
    this.opts.onQueueChange?.();
    return { model, reasoningEffort };
  }
  async admitExplicitSend(input: CodexCommandInput, signal?: AbortSignal) {
    const admission = this.explicitEnqueue.then(async () => {
      if (signal?.aborted) throw sendCancelledError();
      await this.probeOpenShellTransport(signal);
      if (signal?.aborted) throw sendCancelledError();
      return this.enqueue(input);
    });
    this.explicitEnqueue = admission.then(
      () => undefined,
      () => undefined,
    );
    return admission;
  }
  async send(
    input: CodexCommandInput,
    onEnqueued?: (selection: { model: string; reasoningEffort?: string | null }) => void,
  ) {
    const selection = await this.admitExplicitSend(input);
    onEnqueued?.(selection);
    await this.resumeAfterExplicitSend();
  }
  /**
   * An idle SSH relay can look healthy until its next write. Probe it before
   * persisting a new user command so transport recovery cannot turn that
   * command into an ambiguous interrupted turn.
   */
  private async probeOpenShellTransport(signal?: AbortSignal) {
    if (!this.opts.beforeReconnect || this.paused || !this.ready || this.closed) return;
    const generation = this.transportGeneration;
    try {
      await raceWithAbort(
        this.client.request('config/read', {
          cwd: this.opts.runtimeCwd ?? this.opts.cwd,
          includeLayers: false,
        }),
        signal,
      );
    } catch (error) {
      // The transport close callback owns recovery persistence. If it ran,
      // continue so this explicit send can acknowledge recovery and reconnect.
      if (generation !== this.transportGeneration && this.paused) return;
      throw error;
    }
  }
  /** A new user message explicitly resumes saved FIFO work. Interrupted work
   * stays interrupted and is never replayed by this path. */
  async resumeAfterExplicitSend() {
    if (this.paused) await this.acknowledgeRecovery();
    else await this.startQueued();
  }
  cancelQueued(commandId: string) {
    if (!this.binding) throw new Error('Codex account binding unavailable');
    const result = this.opts.store.cancelQueued(this.opts.conversationId, this.binding, commandId);
    if (result === 'cancelled') this.opts.onQueueChange?.();
    return result;
  }
  async startQueued() {
    if (!this.ready || this.closed) throw new Error('Codex conversation unavailable');
    if (this.paused) return;
    await this.pump();
  }
  async acknowledgeRecovery() {
    if (this.recovery) return this.recovery;
    const operation = this.continueRecovery();
    const shared = operation.finally(() => {
      if (this.recovery === shared) {
        this.recovery = undefined;
        this.recoveryPhase = undefined;
        this.opts.onQueueChange?.();
      }
    });
    this.recovery = shared;
    return shared;
  }
  private async continueRecovery() {
    if (this.closed) throw new Error('Codex conversation unavailable');
    if (!this.ready) await this.reconnect();
    // A provider turn may continue after turn/start returns. Recovery progress
    // is only for workspace startup and transport reattachment, not generation.
    if (this.recoveryPhase) {
      this.recoveryPhase = undefined;
      this.opts.onQueueChange?.();
    }
    this.opts.store.acknowledgeRecovery(this.opts.conversationId, this.binding!);
    this.paused = false;
    await this.pump();
  }
  private async reconnect() {
    this.recoveryPhase = 'reconnecting';
    this.opts.onQueueChange?.();
    if (this.opts.reconnectGuard) return this.opts.reconnectGuard(() => this.reconnectBound());
    return this.reconnectBound();
  }
  private async reconnectBound() {
    if (!this.binding || !this.threadId) throw new Error('Codex recovery state is unavailable');
    if (this.opts.beforeReconnect) {
      this.recoveryPhase = 'starting_workspace';
      this.opts.onQueueChange?.();
      await this.opts.beforeReconnect();
    }
    this.recoveryPhase = 'reconnecting';
    this.opts.onQueueChange?.();
    const client = this.createClient();
    this.client = client;
    try {
      await client.initialize();
      const binding = await this.verifyCurrentBinding(this.binding);
      if (binding.profileRevision !== this.binding.profileRevision)
        throw new Error('Codex execution binding changed');
      const configResponse = z.object({ config: z.unknown() }).parse(
        await client.request('config/read', {
          cwd: this.opts.runtimeCwd ?? this.opts.cwd,
          includeLayers: false,
        }),
      );
      const runtimeConfig =
        this.opts.runtimeConfig ??
        codexRuntimeOverrides(configResponse.config, this.opts.profile.workspaceId);
      const modelProvider = this.opts.modelProvider ?? 'openai';
      const state = this.opts.store.read(this.opts.conversationId, this.binding);
      const threadOptions = this.threadOptions(runtimeConfig, modelProvider);
      const result =
        state.recoveryStrategy === 'fork'
          ? await this.replaceFailedProviderThread(client, state, threadOptions)
          : z
              .object({
                thread: z.object({ id: z.string().min(1) }),
                model: z.string(),
                modelProvider: z.string(),
              })
              .parse(
                await client.request('thread/resume', {
                  threadId: this.threadId,
                  ...threadOptions,
                  allowProviderModelFallback: false,
                  ...this.dynamicToolsOption(),
                }),
              );
      if (
        (state.recoveryStrategy !== 'fork' && result.thread.id !== this.threadId) ||
        result.model !== this.binding.model ||
        result.modelProvider !== modelProvider
      )
        throw new Error('Codex execution binding changed');
      this.threadId = result.thread.id;
      this.resetMapper(this.threadId);
      this.ready = true;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private threadOptions(runtimeConfig: Record<string, unknown>, modelProvider: string) {
    return {
      model: this.binding!.model,
      modelProvider,
      cwd: this.opts.runtimeCwd ?? this.opts.cwd,
      config: runtimeConfig,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: this.opts.systemPrompt,
    };
  }

  private dynamicToolsOption() {
    return this.opts.tools.length
      ? {
          dynamicTools: this.opts.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            inputSchema: tool.input_schema,
          })),
        }
      : {};
  }

  /**
   * A terminal provider stream failure can leave the provider thread with an
   * incomplete trailing turn. A new process resuming that same thread is not a
   * new recovery boundary. Fork through the last completed turn instead, or
   * start clean when the thread never completed a turn. The failed user command
   * remains an acknowledged tombstone and is never replayed.
   */
  private async replaceFailedProviderThread(
    client: Rpc,
    state: ReturnType<CodexConversationStore['read']>,
    threadOptions: ReturnType<CodexConversation['threadOptions']>,
  ) {
    if (!state.threadId) throw new Error('Codex provider thread is unavailable');
    const lastCompletedTurnId = await this.latestCompletedProviderTurn(
      client,
      state.threadId,
      state.lastCompletedTurnId,
    );
    const result = z
      .object({
        thread: z.object({ id: z.string().min(1) }),
        model: z.string(),
        modelProvider: z.string(),
      })
      .parse(
        lastCompletedTurnId
          ? await client.request('thread/fork', {
              threadId: state.threadId,
              lastTurnId: lastCompletedTurnId,
              excludeTurns: true,
              ...threadOptions,
            })
          : await client.request('thread/start', {
              ...threadOptions,
              allowProviderModelFallback: false,
              ...this.dynamicToolsOption(),
            }),
      );
    if (
      result.model !== this.binding!.model ||
      result.modelProvider !== (this.opts.modelProvider ?? 'openai')
    )
      throw new Error('Codex execution binding changed');
    this.opts.store.replaceThread(
      this.opts.conversationId,
      this.binding!,
      state.threadId,
      result.thread.id,
      'provider_transport_failure',
      lastCompletedTurnId,
    );
    await this.opts.onThreadChanged?.(result.thread.id);
    return result;
  }

  /**
   * Walk bounded, metadata-only pages newest-first. Old conversations can be
   * arbitrarily large, so recovery must never hydrate their complete history
   * into one app-server frame. The first completed turn encountered is the
   * provider's authoritative recovery boundary; the durable ledger is only a
   * fallback when the provider has no retained completed turn.
   */
  private async latestCompletedProviderTurn(
    client: Rpc,
    threadId: string,
    fallback: string | null,
  ): Promise<string | undefined> {
    const response = z.object({
      data: z.array(z.object({ id: z.string().min(1), status: z.string() })),
      nextCursor: z.string().nullable().optional(),
    });
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = response.parse(
        await client.request('thread/turns/list', {
          threadId,
          limit: 64,
          sortDirection: 'desc',
          itemsView: 'notLoaded',
          ...(cursor ? { cursor } : {}),
        }),
      );
      const completed = page.data.find((turn) => turn.status === 'completed');
      if (completed) return completed.id;
      if (!page.nextCursor) return fallback ?? undefined;
      if (seenCursors.has(page.nextCursor))
        throw new Error('Codex turn pagination repeated a cursor');
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  private resetMapper(threadId: string) {
    this.mapper = new CodexSessionEvents(
      this.opts.conversationId,
      threadId,
      this.binding!.model,
      this.opts.emit,
    );
  }

  /**
   * A provider can report a terminal stream failure immediately before its
   * app-server transport exits. Retire that transport proactively so queued
   * follow-up work always resumes through a fresh, verified client instead of
   * racing one more request against a dying process.
   */
  private retireTransportForRecovery() {
    this.transportGeneration += 1;
    this.ready = false;
    this.client.close();
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
      interruptRequested: false,
    };
    this.active = active;
    const transportGeneration = this.transportGeneration;
    this.opts.onQueueChange?.();
    try {
      const model = command.model ?? this.binding!.model;
      this.validateModel(model, command.reasoningEffort);
      this.mapper?.setModel(model);
      await this.verifyCurrentBinding(this.binding);
      active.abort.signal.throwIfAborted();
      const preparedPrompt =
        (await this.opts.prepareTurn?.(
          { providerPrompt: command.prompt, userIntent: command.intent, turnId: command.id },
          active.abort.signal,
        )) ?? command.prompt;
      active.abort.signal.throwIfAborted();
      const result = z.object({ turn: z.object({ id: z.string() }) }).parse(
        await this.client.request('turn/start', {
          threadId: this.threadId,
          clientUserMessageId: command.id,
          model,
          input: [
            { type: 'text', text: preparedPrompt },
            ...(command.images ?? []).map((image) => ({
              type: 'image',
              url: `data:${image.mediaType};base64,${image.data}`,
            })),
          ],
          approvalPolicy: 'never',
          sandboxPolicy: this.opts.turnSandboxPolicy ?? { type: 'readOnly' },
          ...(command.reasoningEffort ? { effort: command.reasoningEffort } : {}),
        }),
      );
      if (this.active === active) {
        if (active.turnId && active.turnId !== result.turn.id)
          throw new Error('Codex turn identity changed');
        active.turnId = result.turn.id;
        if (active.completion) {
          const completedTurn = z.object({ id: z.string() }).safeParse(active.completion.turn);
          if (!completedTurn.success || completedTurn.data.id !== active.turnId)
            throw new Error('Codex buffered completion identity mismatch');
          this.notification('turn/completed', active.completion);
          return;
        }
        if (active.interruptRequested || active.abort.signal.aborted) {
          await this.client.request('turn/interrupt', {
            threadId: this.threadId,
            turnId: active.turnId,
          });
          return;
        }
      }
    } catch (error: unknown) {
      // close() already persisted recovery and intentionally owns shutdown errors.
      if (this.closed) return;
      // transportClosed() already paused and persisted this command. Do not
      // propagate the old RPC rejection into the adapter's close path.
      if (transportGeneration !== this.transportGeneration) return;
      const replaceProviderThread = requiresProviderThreadReplacement(error);
      this.paused = true;
      active.abort.abort();
      this.opts.store.pauseForRecovery(
        this.opts.conversationId,
        this.binding!,
        command.id,
        active.interruptRequested ? 'interrupted' : 'failed',
        replaceProviderThread ? 'fork' : 'resume',
      );
      if (this.active === active) this.active = undefined;
      if (replaceProviderThread) this.retireTransportForRecovery();
      this.opts.onQueueChange?.();
      throw error;
    }
  }
  private notification(method: string, params: ObjectValue) {
    if (this.closed || params.threadId !== this.threadId) return;
    const turn = z
      .object({
        id: z.string(),
        status: z.string().optional(),
        error: z.object({ message: z.string().optional() }).optional().nullable(),
      })
      .safeParse(params.turn);
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
      if (
        this.opts.beforeComplete &&
        turn.data.status === 'completed' &&
        this.active.completionHook !== 'done'
      ) {
        if (this.active.completionHook === 'pending') return;
        const active = this.active;
        active.completionHook = 'pending';
        const hookAbort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            hookAbort.abort();
            reject(new Error('Project completion hook timed out'));
          }, this.opts.completionHookTimeoutMs ?? 30_000);
        });
        Promise.race([
          this.opts.beforeComplete(AbortSignal.any([active.abort.signal, hookAbort.signal])),
          timeout,
        ])
          .finally(() => {
            if (timer) clearTimeout(timer);
          })
          .then(() => {
            if (this.active !== active || this.closed) return;
            active.completionHook = 'done';
            this.notification(method, params);
          })
          .catch(() => {
            if (this.active !== active || this.closed) return;
            this.opts.onError?.(new Error('Project completion hook failed or blocked the turn.'));
            this.close();
          });
        return;
      }
      const status =
        turn.data.status === 'completed'
          ? 'completed'
          : turn.data.status === 'interrupted'
            ? 'interrupted'
            : 'failed';
      const providerTransportFailed =
        status === 'failed' && isRecoverableProviderTransportFailure(turn.data.error);
      const recoverQueuedFollowUp =
        providerTransportFailed &&
        !this.automaticTransportRecoveryAttempted &&
        this.queue().some((command) => command.status === 'queued');
      this.active.abort.abort();
      if (status === 'completed')
        this.opts.store.finish(
          this.opts.conversationId,
          this.binding!,
          this.active.command.id,
          status,
          turn.data.id,
        );
      else
        this.opts.store.pauseForRecovery(
          this.opts.conversationId,
          this.binding!,
          this.active.command.id,
          status,
          providerTransportFailed ? 'fork' : 'resume',
        );
      this.active = undefined;
      this.paused ||= status !== 'completed';
      if (status === 'completed') this.automaticTransportRecoveryAttempted = false;
      if (recoverQueuedFollowUp) this.automaticTransportRecoveryAttempted = true;
      if (providerTransportFailed) this.retireTransportForRecovery();
      this.mapper?.notification(method, params);
      if (status === 'failed')
        this.opts.onError?.(new Error(codexTurnFailureDiagnostic(turn.data.error)));
      this.opts.onQueueChange?.();
      // Completion can arrive before turn/start resolves. Wait for that request to settle.
      Promise.resolve(this.pumping)
        .then(() => (recoverQueuedFollowUp ? this.acknowledgeRecovery() : this.pump()))
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
    if (method === 'item/tool/requestUserInput') {
      const input = CodexUserInput.parse(params);
      const active = this.active;
      if (
        this.closed ||
        !active ||
        input.threadId !== this.threadId ||
        input.turnId !== active.turnId
      )
        throw new Error('Codex question identity mismatch');
      const questionSignal = AbortSignal.any([signal, active.abort.signal]);
      questionSignal.throwIfAborted();
      if (!this.opts.requestUserInput) throw new Error('Codex questions are unavailable');
      return this.opts.requestUserInput(params, questionSignal);
    }
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
    const publicId = this.mapper!.toolStart(
      call.callId,
      this.opts.displayToolName?.(call.tool) ?? call.tool,
      call.arguments,
    );
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
    if (this.binding)
      this.opts.store.pauseForRecovery(this.opts.conversationId, this.binding, active?.command.id);
    if (!active) return;
    active.interruptRequested = true;
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
    try {
      if (this.binding)
        this.opts.store.pauseForRecovery(
          this.opts.conversationId,
          this.binding,
          this.active?.command.id,
        );
    } catch (error) {
      this.opts.onError?.(
        error instanceof Error ? error : new Error('Codex recovery state could not be saved'),
      );
    }
    this.active = undefined;
    try {
      this.mapper?.flush();
    } finally {
      try {
        this.client.close();
      } finally {
        this.opts.onQueueChange?.();
        this.opts.onClosed?.();
      }
    }
  }
}
