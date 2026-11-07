import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { NativeBaseReadScope } from './native-base-read-scope.js';
import type { CodexNativeTurnTarget } from './codex-conversation-store.js';
import type { ToolDefinition } from '@mitzo/harness';
import {
  NativeSubagentControlSchema,
  type NativeSubagentBlock,
  type NativeSubagentControl,
  type NativeSubagentControlStatus,
  type NativeSubagentSnapshot,
} from '@mitzo/protocol';
import type { CodexServerRequestContext } from './codex-app-server-client.js';
import { CodexRequestError, CodexHostToolRequestError } from './codex-app-server-client.js';
import { CodexNativeFileChange } from './codex-native-file-change.js';
import { createLogger } from './logger.js';
import {
  codexNativeExecutionParams,
  type CodexNativeExecutionPolicy,
} from './codex-native-execution-policy.js';
import {
  codexToolResultContentItems,
  normalizeCodexToolResult,
  type CodexToolResult,
} from './codex-tool-result.js';
import {
  CodexSubagentStore,
  type RetainedSubagent,
  type SubagentScope,
  subagentSnapshot,
} from './codex-subagent-store.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const id = z.string().min(1).max(200).regex(/^\S+$/);
const ObservedThread = z.object({ id, parentThreadId: id.nullable() });
class ChildIdentityError extends Error {
  constructor(
    readonly reason:
      | 'child_identity_mismatch'
      | 'session_mismatch'
      | 'model_unavailable'
      | 'retained_identity_mismatch'
      | 'binding_changed',
  ) {
    super(reason);
  }
}
const Thread = z.object({
  id,
  parentThreadId: id.nullable(),
  sessionId: id,
  cwd: z.string(),
  model: z.string().nullable(),
  modelProvider: z.string(),
  agentNickname: z.string().nullable().optional(),
  preview: z.string().optional(),
});
const ToolCall = z.object({
  threadId: id,
  turnId: id,
  callId: id,
  tool: id,
  arguments: z.record(z.string(), z.unknown()),
});
export interface SubagentRoot {
  threadId: string;
  commandId: string;
  model: string;
  modelProvider: string;
  policy: CodexNativeExecutionPolicy;
}
interface Options {
  scope: SubagentScope;
  store: CodexSubagentStore;
  root(): SubagentRoot | undefined;
  assertCurrent(child: RetainedSubagent, cancelling?: boolean): void;
  nativeOrigin?(
    child: RetainedSubagent,
    cancelling?: boolean,
  ): Pick<CodexNativeTurnTarget, 'commandId' | 'attempt' | 'generation'>;
  request(method: string, params: ObjectValue, beforeDispatch?: () => void): Promise<unknown>;
  tools: ToolDefinition[];
  executeTool(
    name: string,
    input: ObjectValue,
    signal: AbortSignal,
    context: Readonly<{
      turnId: string;
      callId: string;
      assertCurrentSync?(): void;
      registerResponseFence?(assertCurrent: () => void): void;
      captureNativeBaseReadScope?(): NativeBaseReadScope;
    }>,
  ): Promise<CodexToolResult>;
  requestNativeApproval?(
    method: string,
    params: ObjectValue,
    signal: AbortSignal,
    context: CodexServerRequestContext & {
      commandId: string;
      threadId: string;
      turnId: string;
      subagentName?: string;
      fileChangePaths?: readonly string[];
      assertCurrentSync(): void;
    },
  ): Promise<ObjectValue>;
  requestUserInput?(params: ObjectValue, signal: AbortSignal): Promise<ObjectValue>;
  validateModel?(model: string): void;
  onChild(child: NativeSubagentSnapshot): void;
}
interface LiveChild {
  child: RetainedSubagent;
  policy: CodexNativeExecutionPolicy;
  abort: AbortController;
  turnAbort: AbortController;
  terminal: Set<string>;
  files: Map<string, readonly string[] | null>;
  fileRevisions: Map<string, string>;
  lifecycleRevision: number;
  controlRevision: number;
  approval?: symbol;
  cancelBeforeRun: boolean;
  parentStop?: { epoch: number; turnId: string };
}

/** One native process/account/tree, with independent child turns. This owner has
 * no scheduler and never inserts child requests in the parent's command queue. */
export class CodexSubagents {
  private live = new Map<string, LiveChild>();
  private pending = new Map<string, Promise<void>>();
  private buffered = new Map<string, { method: string; params: ObjectValue }[]>();
  private overflowed = new Set<string>();
  private assignedTasks = new Map<string, string>();
  // One failed inspection per owner; native event traffic must not create a retry loop.
  private failedAdmissions = new Set<string>();
  private parentStopping = false;
  private parentCancellationEpoch = 0;
  private parentStops = new Set<Promise<unknown>>();
  private invocations = new WeakMap<
    object,
    () => Readonly<
      CodexNativeTurnTarget & {
        callId: string;
        toolName: string;
        requestHash: string;
      }
    >
  >();
  private listeners = new Set<(child: NativeSubagentSnapshot) => void>();
  private closed = false;
  constructor(private readonly opts: Options) {}
  private snapshot(child: RetainedSubagent): NativeSubagentSnapshot {
    let available = this.live.has(child.threadId);
    if (
      !available &&
      !this.closed &&
      child.admissionVerified !== false &&
      !child.inspectionFailure &&
      ['completed', 'stopped', 'failed'].includes(child.state)
    ) {
      try {
        if (this.retained(child.threadId)) {
          this.opts.assertCurrent(child, this.parentStopping);
          this.opts.nativeOrigin?.(child);
          available = true; // Cold terminal children revalidate native identity before control.
        }
      } catch {
        /* Original ownership is unavailable. */
      }
    }
    return { ...subagentSnapshot(child, available), available: available && !this.parentStopping };
  }
  subscribe(listener: (child: NativeSubagentSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  list(): NativeSubagentSnapshot[] {
    for (const live of [...this.live.values()]) {
      try {
        this.current(live);
      } catch {
        this.invalidate(live);
      }
    }
    return this.opts.store.list(this.opts.scope).map((child) => this.snapshot(child));
  }
  owns(threadId: unknown): boolean {
    return (
      typeof threadId === 'string' &&
      (this.live.has(threadId) || this.pending.has(threadId) || !!this.retained(threadId))
    );
  }
  private retained(threadId: string): RetainedSubagent | undefined {
    const child = this.opts.store.get(this.opts.scope, threadId);
    const root = this.opts.root();
    return child &&
      root &&
      child.rootThreadId === root.threadId &&
      child.policyRevision === root.policy.policyRevision
      ? child
      : undefined;
  }
  private restoreChild(threadId: string): void {
    if (this.live.has(threadId) || this.pending.has(threadId)) return;
    const child = this.retained(threadId),
      root = this.opts.root();
    if (child && root) this.admit(threadId, child.parentThreadId, root);
  }
  pendingHostTool(
    call: object,
    identity: { turnId: string; toolName: string; requestHash: string },
  ) {
    const pending = this.invocations.get(call)?.();
    if (
      pending &&
      pending.turnId === identity.turnId &&
      pending.toolName === identity.toolName &&
      pending.requestHash === identity.requestHash
    )
      return pending;
  }
  async settled(): Promise<void> {
    await Promise.all([...this.pending.values()]);
  }
  private publish(live: LiveChild): void {
    live.child.revision++;
    this.opts.store.save(this.opts.scope, live.child);
    for (const listener of this.listeners) listener(this.snapshot(live.child));
  }
  private inspectionFailed(
    child: RetainedSubagent,
    stage: NonNullable<NativeSubagentSnapshot['inspectionFailure']>['stage'],
    error: unknown,
  ): void {
    const { threadId, parentThreadId } = child;
    this.failedAdmissions.add(threadId);
    const failure = {
      code: 'native_subagent_inspection_failed' as const,
      stage,
      reference: randomUUID(),
    };
    child.inspectionFailure = failure;
    if (['starting', 'working', 'needs_permission', 'stopping'].includes(child.state))
      child.state = 'unknown';
    child.revision++;
    const live = this.live.get(threadId);
    if (live) {
      live.abort.abort();
      this.live.delete(threadId);
    }
    // Exclude native error text/data, task input and transcript payloads. Retain
    // the safe cause category and the same reference exposed to the operator.
    const log = createLogger('codex-subagents');
    log.warn('Native subagent inspection failed', {
      ...failure,
      conversationId: this.opts.scope.conversationId,
      commandId: child.commandId,
      threadId,
      parentThreadId,
      cause:
        error instanceof CodexRequestError
          ? error.category
          : error instanceof z.ZodError
            ? 'protocol'
            : error instanceof ChildIdentityError
              ? error.reason
              : 'internal',
      ...(error instanceof z.ZodError
        ? {
            invalidFields: [
              ...new Set(
                error.issues.flatMap((issue) =>
                  typeof issue.path[0] === 'string' && Object.hasOwn(Thread.shape, issue.path[0])
                    ? [issue.path[0]]
                    : [],
                ),
              ),
            ],
          }
        : {}),
    });
    try {
      this.opts.store.save(this.opts.scope, child);
    } catch {
      log.warn('Subagent inspection diagnostic could not be retained', {
        reference: failure.reference,
        threadId,
      });
    }
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot(child));
      } catch {
        log.warn('Subagent inspection diagnostic could not be delivered', {
          reference: failure.reference,
          threadId,
        });
      }
    }
  }
  private current(live: LiveChild, turnId?: string): void {
    const root = this.opts.root();
    if (
      this.closed ||
      live.abort.signal.aborted ||
      this.live.get(live.child.threadId) !== live ||
      !root ||
      root.threadId !== live.child.rootThreadId ||
      root.policy.policyRevision !== live.child.policyRevision
    )
      throw Error('Original child owner unavailable');
    if (
      turnId &&
      (live.child.turnId !== turnId ||
        !['working', 'needs_permission'].includes(live.child.state) ||
        live.terminal.has(turnId) ||
        live.turnAbort.signal.aborted)
    )
      throw Error('Child turn identity is no longer current');
    this.opts.assertCurrent(live.child, this.parentStopping);
  }
  notification(method: string, params: ObjectValue): boolean {
    if (this.closed) return false;
    const root = this.opts.root();
    const started =
      method === 'thread/started' ? ObservedThread.safeParse(params.thread) : undefined;
    if (root && started?.success) {
      const thread = started.data;
      if (
        thread.parentThreadId === root.threadId ||
        (thread.parentThreadId && this.owns(thread.parentThreadId))
      ) {
        this.admit(thread.id, thread.parentThreadId!, root);
        return true;
      }
    }
    const item = object(params.item);
    if (
      root &&
      (params.threadId === root.threadId || this.owns(params.threadId)) &&
      item.type === 'collabAgentToolCall' &&
      item.tool === 'spawnAgent' &&
      item.senderThreadId === params.threadId &&
      Array.isArray(item.receiverThreadIds)
    ) {
      for (const receiver of item.receiverThreadIds)
        if (typeof receiver === 'string')
          this.admit(
            receiver,
            String(params.threadId),
            root,
            typeof item.prompt === 'string' ? item.prompt : undefined,
          );
    }
    if (typeof params.threadId !== 'string') return false;
    this.restoreChild(params.threadId);
    if (this.pending.has(params.threadId)) {
      const buffer = this.buffered.get(params.threadId)!;
      if (buffer.length < 256 && Buffer.byteLength(JSON.stringify(params)) <= 65536)
        buffer.push({ method, params: structuredClone(params) });
      else {
        this.overflowed.add(params.threadId);
        if (method === 'turn/started' || method === 'turn/completed') {
          const disposable = buffer.findIndex(
            (event) => event.method !== 'turn/started' && event.method !== 'turn/completed',
          );
          buffer.splice(disposable < 0 ? 0 : disposable, 1);
          const turn = object(params.turn);
          buffer.push({
            method,
            params: { threadId: params.threadId, turn: { id: turn.id, status: turn.status } },
          });
        }
      }
      return true;
    }
    const live = this.live.get(params.threadId);
    if (!live) return false;
    try {
      this.current(live);
    } catch {
      // Expected loss of the original owner fences execution, retaining output.
      this.invalidate(live);
      return true;
    }
    try {
      this.apply(live, method, params);
    } catch (error) {
      this.inspectionFailed(live.child, 'events', error);
    }
    return true;
  }
  private admit(threadId: string, parentThreadId: string, root: SubagentRoot, task?: string): void {
    if (task) {
      this.assignedTasks.set(threadId, task.slice(0, 8192));
      const live = this.live.get(threadId);
      if (live) {
        live.child.task = task.slice(0, 8192);
        this.publish(live);
        this.assignedTasks.delete(threadId);
      }
    }
    if (!this.live.has(threadId) && !this.pending.has(threadId)) {
      for (const live of this.live.values()) {
        if (this.live.size + this.pending.size < 32) break;
        if (
          !this.pending.has(live.child.threadId) &&
          ['completed', 'stopped', 'failed'].includes(live.child.state)
        )
          this.invalidate(live);
      }
    }
    if (
      this.live.has(threadId) ||
      this.pending.has(threadId) ||
      this.failedAdmissions.has(threadId) ||
      threadId === root.threadId
    )
      return;
    const previous = this.opts.store.get(this.opts.scope, threadId);
    // The owning transport observed parentage. Persist only that observation;
    // no native metadata, output, host tools or control authority is trusted yet.
    const observed: RetainedSubagent = previous ?? {
      threadId,
      parentThreadId,
      rootThreadId: root.threadId,
      commandId:
        this.live.get(parentThreadId)?.child.commandId ??
        this.opts.store.get(this.opts.scope, parentThreadId)?.commandId ??
        root.commandId,
      policyRevision: root.policy.policyRevision,
      name: 'Subagent',
      task: this.assignedTasks.get(threadId) ?? '',
      model: '',
      state: 'starting',
      revision: 1,
      blocks: [],
      admissionVerified: false,
    };
    if (
      observed.rootThreadId !== root.threadId ||
      observed.parentThreadId !== parentThreadId ||
      observed.policyRevision !== root.policy.policyRevision
    )
      return;
    this.opts.store.save(this.opts.scope, observed);
    this.opts.onChild(this.snapshot(observed));
    for (const listener of this.listeners) listener(this.snapshot(observed));
    let stage: NonNullable<NativeSubagentSnapshot['inspectionFailure']>['stage'] = 'inspect_child';
    const failed = (error: unknown) =>
      this.inspectionFailed(this.live.get(threadId)?.child ?? observed, stage, error);
    if (this.live.size + this.pending.size >= 32) {
      stage = 'capacity';
      failed(Error('Child inspection capacity reached'));
      return;
    }
    this.buffered.set(threadId, []);
    const admissionEpoch = this.parentCancellationEpoch;
    const admittedDuringStop = this.parentStopping;
    // Start after registering the pending identity, before any awaited native I/O.
    const operation = Promise.resolve()
      .then(async () => {
        const checked = Thread.parse(
          object(await this.opts.request('thread/read', { threadId, includeTurns: false })).thread,
        );
        stage = 'validate_identity';
        if (
          checked.id !== threadId ||
          checked.parentThreadId !== parentThreadId ||
          checked.cwd !== root.policy.cwd ||
          checked.modelProvider !== root.modelProvider ||
          !checked.model
        )
          throw new ChildIdentityError('child_identity_mismatch');
        stage = 'inspect_parent';
        const rootMetadata = object(
          await this.opts.request('thread/read', { threadId: root.threadId, includeTurns: false }),
        );
        stage = 'validate_identity';
        if (
          object(rootMetadata.thread).id !== root.threadId ||
          object(rootMetadata.thread).sessionId !== checked.sessionId
        )
          throw new ChildIdentityError('session_mismatch');
        try {
          this.opts.validateModel?.(checked.model);
        } catch {
          throw new ChildIdentityError('model_unavailable');
        }
        const child = observed;
        if (
          child.rootThreadId !== root.threadId ||
          child.parentThreadId !== parentThreadId ||
          child.policyRevision !== root.policy.policyRevision
        )
          throw new ChildIdentityError('retained_identity_mismatch');
        child.name = (checked.agentNickname || child.name).slice(0, 200);
        child.model = checked.model;
        child.task = (
          this.assignedTasks.get(threadId) ??
          (child.task || checked.preview) ??
          ''
        ).slice(0, 8192);
        child.admissionVerified = true;
        child.revision++;
        if (
          previous &&
          ['working', 'starting', 'needs_permission', 'stopping'].includes(previous.state)
        ) {
          child.state = 'unknown';
          child.revision++;
        }
        const live: LiveChild = {
          child,
          policy: root.policy,
          abort: new AbortController(),
          turnAbort: new AbortController(),
          terminal: new Set(),
          files: new Map(),
          fileRevisions: new Map(),
          lifecycleRevision: 0,
          controlRevision: 0,
          cancelBeforeRun:
            admittedDuringStop ||
            admissionEpoch !== this.parentCancellationEpoch ||
            this.parentStopping,
        };
        // Recovery forbids execution, but an exact native child still needs
        // identity-checked cancellation admission after its parent was stopped.
        const origin = this.opts.nativeOrigin?.(child, live.cancelBeforeRun || this.parentStopping);
        if (origin) {
          if (
            previous &&
            (child.commandAttempt === undefined || child.threadGeneration === undefined)
          )
            child.revision++;
          child.commandAttempt ??= origin.attempt;
          child.threadGeneration ??= origin.generation;
        }
        this.live.set(threadId, live);
        this.current(live);
        this.opts.store.save(this.opts.scope, child);
        stage = 'subscribe';
        const resumed = object(
          await this.opts.request(
            'thread/resume',
            {
              threadId,
              excludeTurns: true,
              ...codexNativeExecutionParams(root.policy),
            },
            () => this.current(live),
          ),
        );
        this.current(live);
        if (
          object(resumed.thread).id !== threadId ||
          resumed.model !== child.model ||
          resumed.modelProvider !== root.modelProvider
        )
          throw new ChildIdentityError('binding_changed');
        // New subscriptions can start after a child has produced output. Hydrate
        // paginated public items only; never replay tool calls from native history.
        stage = 'history';
        await this.hydrate(live);
        this.current(live);
        stage = 'events';
        if (this.assignedTasks.has(threadId)) child.task = this.assignedTasks.get(threadId)!;
        if (this.overflowed.has(threadId)) child.outputTruncated = true;
        for (const event of this.buffered.get(threadId) ?? [])
          this.apply(live, event.method, event.params);
        delete child.inspectionFailure;
        this.publish(live);
        if (live.cancelBeforeRun || this.parentStopping) this.cancelForParent(live);
      })
      .catch(failed)
      .finally(() => {
        this.pending.delete(threadId);
        this.buffered.delete(threadId);
        this.overflowed.delete(threadId);
        this.assignedTasks.delete(threadId);
      });
    this.pending.set(threadId, operation);
  }
  async restore(): Promise<void> {
    const root = this.opts.root();
    if (!root || this.closed) return;
    for (const child of this.opts.store.list(this.opts.scope))
      if (
        child.rootThreadId === root.threadId &&
        child.policyRevision === root.policy.policyRevision
      )
        this.admit(child.threadId, child.parentThreadId, root);
    await this.settled();
  }
  private async hydrate(live: LiveChild): Promise<void> {
    const page = object(
      await this.opts.request('thread/turns/list', {
        threadId: live.child.threadId,
        limit: 32,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      }),
    );
    this.current(live);
    if (!Array.isArray(page.data)) throw Error('Child turn history unavailable');
    // Retained older public blocks remain intact. Hydrate the latest bounded
    // turn, then consume the subscribed native events buffered during admission.
    const turn = object(page.data[0]);
    if (typeof turn.id !== 'string') return;
    this.apply(live, 'turn/started', { turn });
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const items = object(
        await this.opts.request('thread/items/list', {
          threadId: live.child.threadId,
          turnId: turn.id,
          limit: 64,
          sortDirection: 'asc',
          ...(cursor ? { cursor } : {}),
        }),
      );
      this.current(live);
      if (!Array.isArray(items.data)) throw Error('Child items unavailable');
      for (const raw of items.data) {
        const entry = z
          .object({
            turnId: id,
            item: z.record(z.string(), z.unknown()),
            completedAtMs: z.number().nullable(),
          })
          .parse(raw);
        if (entry.turnId !== turn.id) throw Error('Child history crossed turns');
        this.apply(live, entry.completedAtMs === null ? 'item/started' : 'item/completed', {
          turnId: turn.id,
          item: entry.item,
        });
      }
      if (typeof items.nextCursor !== 'string') break;
      if (cursors.has(items.nextCursor) || live.child.blocks.length >= 2000)
        throw Error('Child history exceeds supported bounds');
      cursors.add(items.nextCursor);
      cursor = items.nextCursor;
    }
    if (turn.status !== 'inProgress') this.apply(live, 'turn/completed', { turn });
  }
  private block(live: LiveChild, block: NativeSubagentBlock, append = false): void {
    const previous = live.child.blocks.find((candidate) => candidate.id === block.id);
    if (previous)
      Object.assign(previous, block, {
        content: (append ? previous.content + block.content : block.content).slice(0, 65536),
      });
    else if (live.child.blocks.length < 2000)
      live.child.blocks.push({ ...block, content: block.content.slice(0, 65536) });
    else {
      live.child.blocks.shift();
      live.child.blocks.push({ ...block, content: block.content.slice(0, 65536) });
      live.child.outputTruncated = true;
    }
    while (Buffer.byteLength(JSON.stringify(live.child)) > 256 * 1024 && live.child.blocks.length) {
      live.child.outputTruncated = true;
      if (live.child.blocks.length > 1) live.child.blocks.shift();
      else
        live.child.blocks[0].content = live.child.blocks[0].content.slice(
          Math.ceil(live.child.blocks[0].content.length / 2),
        );
    }
  }
  private apply(live: LiveChild, method: string, params: ObjectValue): void {
    const child = live.child;
    const turn = object(params.turn);
    if (method === 'turn/started' && typeof turn.id === 'string') {
      if (live.terminal.has(turn.id)) return;
      if (
        child.turnId === turn.id &&
        ['working', 'needs_permission', 'stopping'].includes(child.state)
      )
        return;
      live.lifecycleRevision++;
      if (child.turnId !== turn.id) {
        live.turnAbort.abort();
        live.turnAbort = new AbortController();
        live.files.clear();
        live.fileRevisions.clear();
      }
      child.turnId = turn.id;
      child.state = 'working';
      this.publish(live);
      if (this.parentStopping || live.cancelBeforeRun) this.cancelForParent(live);
      return;
    }
    if (method === 'turn/completed' && turn.id === child.turnId && typeof turn.id === 'string') {
      live.lifecycleRevision++;
      live.terminal.add(turn.id);
      live.turnAbort.abort();
      live.cancelBeforeRun = false;
      child.state =
        turn.status === 'completed'
          ? 'completed'
          : turn.status === 'interrupted'
            ? 'stopped'
            : 'failed';
      for (const block of child.blocks) if (block.status === 'running') block.status = 'unknown';
      this.publish(live);
      return;
    }
    if (
      !child.turnId ||
      params.turnId !== child.turnId ||
      live.terminal.has(child.turnId) ||
      !['working', 'needs_permission', 'stopping'].includes(child.state)
    )
      return;
    if (
      method === 'item/agentMessage/delta' &&
      typeof params.itemId === 'string' &&
      typeof params.delta === 'string'
    ) {
      this.block(live, { id: params.itemId, type: 'text', content: params.delta }, true);
      this.publish(live);
      return;
    }
    const item = object(params.item);
    if ((method === 'item/started' || method === 'item/completed') && typeof item.id === 'string') {
      if (item.type === 'agentMessage' && typeof item.text === 'string')
        this.block(live, { id: item.id, type: 'text', content: item.text });
      else if (
        ['commandExecution', 'fileChange', 'dynamicToolCall', 'webSearch', 'mcpToolCall'].includes(
          String(item.type),
        )
      ) {
        const completed = method === 'item/completed';
        const failed =
          item.status === 'failed' || item.status === 'declined' || item.success === false;
        const retained = child.blocks.find((block) => block.id === item.id);
        const nativeResult = Array.isArray(item.contentItems)
          ? item.contentItems
              .map((value) => object(value))
              .filter((value) => value.type === 'inputText' && typeof value.text === 'string')
              .map((value) => value.text)
              .join('\n')
          : '';
        const content =
          item.type === 'commandExecution'
            ? `${typeof item.command === 'string' ? item.command : ''}${typeof item.aggregatedOutput === 'string' ? '\n' + item.aggregatedOutput : ''}`
            : item.type === 'fileChange'
              ? 'File changes'
              : item.type === 'dynamicToolCall'
                ? (retained?.status && retained.status !== 'running'
                    ? retained.content
                    : nativeResult || retained?.content) || JSON.stringify(item.arguments ?? {})
                : typeof item.tool === 'string'
                  ? item.tool
                  : String(item.type);
        this.block(live, {
          id: item.id,
          type: 'tool',
          name: retained?.name ?? (typeof item.tool === 'string' ? item.tool : String(item.type)),
          content,
          status: completed ? (failed ? 'failed' : 'completed') : 'running',
        });
        if (item.type === 'fileChange' && method === 'item/started') {
          const changes = z.array(CodexNativeFileChange).safeParse(item.changes);
          live.files.set(
            item.id,
            changes.success
              ? changes.data.flatMap((change) => [
                  change.path,
                  ...(change.kind.type === 'update' && change.kind.move_path
                    ? [change.kind.move_path]
                    : []),
                ])
              : null,
          );
          live.fileRevisions.set(
            item.id,
            createHash('sha256').update(JSON.stringify(item.changes)).digest('hex'),
          );
        }
      } else return;
      this.publish(live);
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = z
        .object({
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
        })
        .safeParse(object(params.tokenUsage).total);
      if (usage.success) {
        child.usage = usage.data;
        this.publish(live);
      }
    }
  }
  async request(
    method: string,
    params: ObjectValue,
    signal: AbortSignal,
    context?: CodexServerRequestContext,
  ): Promise<ObjectValue> {
    if (this.parentStopping) throw Error('Parent cancellation is in progress');
    if (typeof params.threadId === 'string') this.restoreChild(params.threadId);
    if (typeof params.threadId === 'string') await this.pending.get(params.threadId);
    if (this.parentStopping) throw Error('Parent cancellation is in progress');
    const live = this.live.get(String(params.threadId));
    if (!live || typeof params.turnId !== 'string') throw Error('Unadmitted child request');
    const turnId = params.turnId;
    const currentSignal = AbortSignal.any([signal, live.abort.signal, live.turnAbort.signal]);
    const fileId = method === 'item/fileChange/requestApproval' ? String(params.itemId) : undefined;
    const fileRevision = fileId ? live.fileRevisions.get(fileId) : undefined;
    const current = () => {
      currentSignal.throwIfAborted();
      this.current(live, turnId);
      if (fileId && (!fileRevision || live.fileRevisions.get(fileId) !== fileRevision))
        throw Error('Child file proposal changed during approval');
    };
    current();
    context?.registerResponseFence?.(current);
    if (method === 'item/tool/requestUserInput') {
      if (!this.opts.requestUserInput) throw Error('Child questions unavailable');
      const response = await this.opts.requestUserInput(params, currentSignal);
      current();
      return response;
    }
    if (
      [
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
      ].includes(method)
    ) {
      if (!this.opts.requestNativeApproval || !context) throw Error('Child approvals unavailable');
      const paths =
        method === 'item/fileChange/requestApproval'
          ? live.files.get(String(params.itemId))
          : undefined;
      if (method === 'item/fileChange/requestApproval' && !paths)
        throw Error('Child file approval is not attributable');
      live.child.state = 'needs_permission';
      const approval = Symbol('approval');
      live.approval = approval;
      const approvalLifecycle = live.lifecycleRevision;
      this.publish(live);
      try {
        const response = await this.opts.requestNativeApproval(method, params, currentSignal, {
          ...context,
          commandId: live.child.commandId,
          threadId: live.child.threadId,
          turnId,
          subagentName: live.child.name,
          assertCurrentSync: current,
          ...(paths ? { fileChangePaths: paths } : {}),
        });
        current();
        return response;
      } finally {
        if (
          !currentSignal.aborted &&
          live.approval === approval &&
          live.child.state === 'needs_permission' &&
          live.child.turnId === turnId &&
          live.lifecycleRevision === approvalLifecycle
        ) {
          live.child.state = 'working';
          this.publish(live);
        }
        if (live.approval === approval) live.approval = undefined;
      }
    }
    if (method !== 'item/tool/call') throw Error('Unsupported child host request');
    const refuse = (category: 'invalid_tool_request' | 'tool_unavailable'): never => {
      const error = new CodexHostToolRequestError(category);
      // The child and its original turn passed current(); no claim or executor
      // was entered. Qualify only this exact RPC for the owned bridge.
      context?.registerPreExecutionRefusal?.(error);
      throw error;
    };
    const parsed = ToolCall.safeParse(params);
    if (!parsed.success) return refuse('invalid_tool_request');
    const call = parsed.data;
    if (!this.opts.tools.some((tool) => tool.name === call.tool)) return refuse('tool_unavailable');
    // Workspace/environment changes belong to the parent admission owner.
    if (['PrepareLocalRepository', 'RequestGithubPublish'].includes(call.tool))
      return {
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: 'Ask the parent agent to perform this conversation-level operation.',
          },
        ],
      };
    const identity = {
      threadId: call.threadId,
      turnId,
      callId: call.callId,
      tool: call.tool,
      requestHash: createHash('sha256').update(JSON.stringify(call.arguments)).digest('hex'),
    };
    const claimed = this.opts.store.claimTool(this.opts.scope, identity);
    if (!claimed) {
      const previous = this.opts.store.toolResult(this.opts.scope, identity);
      return previous
        ? { success: !previous.isError, contentItems: codexToolResultContentItems(previous) }
        : {
            success: false,
            contentItems: [
              {
                type: 'inputText',
                text: 'Previously attempted child tool. Its outcome is unknown; inspect current state before retrying.',
              },
            ],
          };
    }
    this.block(live, {
      id: call.callId,
      type: 'tool',
      name: call.tool,
      content: JSON.stringify(call.arguments).slice(0, 65536),
      status: 'running',
    });
    this.publish(live);
    let callbackOpen = true;
    const original = () => {
      current();
      if (!callbackOpen) throw Error('Child callback expired');
      if (
        createHash('sha256').update(JSON.stringify(call.arguments)).digest('hex') !==
          identity.requestHash ||
        !this.opts.store.pendingTool(this.opts.scope, identity)
      )
        throw Error('Child claim changed');
    };
    const invocation: Parameters<Options['executeTool']>[3] = { turnId, callId: call.callId };
    Object.defineProperty(invocation, 'assertCurrentSync', { value: original });
    if (context?.registerResponseFence)
      Object.defineProperty(invocation, 'registerResponseFence', {
        value: (fence: () => void) => {
          original();
          context.registerResponseFence!(fence);
        },
      });
    if (this.opts.nativeOrigin) {
      const origin = Object.freeze({ ...this.opts.nativeOrigin(live.child) });
      const pending = Object.freeze({
        ...origin,
        threadId: call.threadId,
        turnId,
        callId: call.callId,
        toolName: call.tool,
        requestHash: identity.requestHash,
      });
      const capture = () => {
        original();
        if (!isDeepStrictEqual(this.opts.nativeOrigin!(live.child), origin))
          throw Error('Child native origin changed');
        return pending;
      };
      this.invocations.set(invocation, capture);
      const policy = live.policy;
      const assertBase = Object.freeze(() => {
        capture();
        if (
          this.opts.root()?.policy !== policy ||
          !Object.isFrozen(policy) ||
          ![policy.readableRoots, policy.workspaceRoots, policy.deniedRoots].every(Object.isFrozen)
        )
          throw Error('Original child base policy changed');
      });
      Object.defineProperty(invocation, 'captureNativeBaseReadScope', {
        value: Object.freeze((): NativeBaseReadScope => {
          assertBase();
          return Object.freeze({
            nativeTarget: Object.freeze({ ...origin, threadId: call.threadId, turnId }),
            callId: call.callId,
            toolName: call.tool,
            requestHash: identity.requestHash,
            bindingRevision: policy.bindingRevision,
            profileRevision: policy.profileRevision,
            policyRevision: policy.policyRevision,
            readableRoots: Object.freeze([...policy.readableRoots]),
            workspaceRoots: Object.freeze([...policy.workspaceRoots]),
            deniedRoots: Object.freeze([...policy.deniedRoots]),
            assertCurrentSync: assertBase,
          });
        }),
      });
    }
    let result;
    try {
      result = normalizeCodexToolResult(
        await this.opts.executeTool(
          call.tool,
          call.arguments,
          currentSignal,
          Object.freeze(invocation),
        ),
      );
    } catch {
      result = {
        content:
          'Child tool did not finish successfully. Inspect its state before retrying; its effects may be unknown.',
        isError: true,
      };
    } finally {
      callbackOpen = false;
    }
    this.opts.store.finishTool(this.opts.scope, identity, result);
    this.block(live, {
      id: call.callId,
      type: 'tool',
      name: call.tool,
      content: result.content.slice(0, 65536),
      status: result.isError ? 'failed' : 'completed',
    });
    this.publish(live);
    return { success: !result.isError, contentItems: codexToolResultContentItems(result) };
  }
  async control(
    raw: NativeSubagentControl,
    authorize: () => void = () => {},
    parentStop = false,
  ): Promise<NativeSubagentControlStatus> {
    const input = NativeSubagentControlSchema.parse(raw);
    const parentEpoch = this.parentCancellationEpoch;
    authorize();
    const receipt = this.opts.store.controlResult(this.opts.scope, input);
    if (receipt) return receipt;
    if (this.parentStopping && !(parentStop && input.action === 'stop')) return 'rejected';
    this.restoreChild(input.threadId);
    const admission = this.pending.get(input.threadId);
    if (admission) await admission;
    if (parentEpoch !== this.parentCancellationEpoch && !(parentStop && input.action === 'stop'))
      return 'rejected';
    const live = this.live.get(input.threadId);
    if (!live || this.closed) return 'rejected';
    try {
      this.current(live);
    } catch {
      return 'rejected';
    }
    const previous = this.opts.store.claimControl(this.opts.scope, input);
    if (previous) return previous;
    let attempted = false;
    const previousState = live.child.state;
    let optimistic:
      | { lifecycle: number; control: number; turnId?: string; state: RetainedSubagent['state'] }
      | undefined;
    const rememberTransition = () => {
      optimistic = {
        lifecycle: live.lifecycleRevision,
        control: ++live.controlRevision,
        turnId: live.child.turnId,
        state: live.child.state,
      };
    };
    const dispatch = async (
      method: string,
      params: ObjectValue,
      state: RetainedSubagent['state'],
    ) => {
      const turnId = live.child.turnId;
      return this.opts.request(method, params, () => {
        authorize();
        if (
          (this.parentStopping || parentEpoch !== this.parentCancellationEpoch) &&
          !(parentStop && input.action === 'stop')
        )
          throw Error('Parent cancellation preceded control dispatch');
        this.current(live);
        if (live.child.state !== state || live.child.turnId !== turnId)
          throw Error('Child changed before control dispatch');
        attempted = true;
      });
    };
    let status: NativeSubagentControlStatus;
    try {
      authorize();
      this.current(live);
      const active =
        (['working', 'needs_permission'].includes(live.child.state) ||
          (parentStop && live.child.state === 'stopping')) &&
        !!live.child.turnId;
      if (input.action === 'stop') {
        if (!active) throw Error('Child is not working');
        live.child.state = 'stopping';
        this.publish(live);
        rememberTransition();
        await dispatch(
          'turn/interrupt',
          {
            threadId: input.threadId,
            turnId: live.child.turnId,
          },
          'stopping',
        );
        status = 'accepted';
      } else if (active) {
        const target = live.child.turnId;
        const response = object(
          await dispatch(
            'turn/steer',
            {
              threadId: input.threadId,
              expectedTurnId: target,
              input: [{ type: 'text', text: input.text }],
            },
            live.child.state,
          ),
        );
        if (response.turnId === target) status = 'accepted';
        else status = 'uncertain';
      } else {
        if (!['completed', 'stopped'].includes(live.child.state)) throw Error('Child unavailable');
        live.child.state = 'starting';
        this.publish(live);
        rememberTransition();
        const response = object(
          await dispatch(
            'turn/start',
            {
              threadId: input.threadId,
              clientUserMessageId: input.requestId,
              model: live.child.model,
              input: [{ type: 'text', text: input.text }],
              ...codexNativeExecutionParams(live.policy),
            },
            'starting',
          ),
        );
        const turn = object(response.turn);
        if (typeof turn.id === 'string') {
          this.apply(live, 'turn/started', { turn });
          status = 'accepted';
        } else status = 'uncertain';
      }
      authorize();
      this.current(live);
      if (status === 'accepted' && input.action === 'message') {
        this.block(live, { id: input.requestId, type: 'user', content: input.text });
        this.publish(live);
      }
    } catch (error) {
      status = attempted && !(error instanceof CodexRequestError) ? 'uncertain' : 'rejected';
      if (
        status === 'rejected' &&
        optimistic &&
        optimistic.lifecycle === live.lifecycleRevision &&
        optimistic.control === live.controlRevision &&
        optimistic.turnId === live.child.turnId &&
        optimistic.state === live.child.state
      ) {
        live.child.state = previousState;
        this.publish(live);
      }
    }
    this.opts.store.finishControl(this.opts.scope, input, status);
    return status;
  }
  private cancelForParent(live: LiveChild): void {
    if (['completed', 'stopped', 'failed'].includes(live.child.state)) {
      live.cancelBeforeRun = false;
      return;
    }
    live.cancelBeforeRun = true;
    live.turnAbort.abort();
    if (
      !['working', 'needs_permission', 'stopping'].includes(live.child.state) ||
      !live.child.turnId
    )
      return;
    if (
      live.parentStop?.epoch === this.parentCancellationEpoch &&
      live.parentStop.turnId === live.child.turnId
    )
      return;
    live.parentStop = { epoch: this.parentCancellationEpoch, turnId: live.child.turnId };
    const operation = this.control(
      { requestId: randomUUID(), threadId: live.child.threadId, action: 'stop' },
      undefined,
      true,
    )
      .catch(() => {
        this.invalidate(live);
      })
      .finally(() => {
        this.parentStops.delete(operation);
      });
    this.parentStops.add(operation);
  }
  async interruptAll(): Promise<void> {
    this.parentCancellationEpoch++;
    this.parentStopping = true;
    for (const live of this.live.values()) {
      live.turnAbort.abort();
      live.cancelBeforeRun = !['completed', 'stopped', 'failed'].includes(live.child.state);
      this.publish(live);
    }
    await this.settled();
    for (const live of this.live.values()) this.cancelForParent(live);
    while (this.pending.size || this.parentStops.size)
      await Promise.all([...this.pending.values(), ...this.parentStops]);
  }
  parentResumed(): void {
    if (!this.parentStopping) return;
    this.parentStopping = false;
    for (const live of this.live.values()) this.publish(live);
  }
  private invalidate(live: LiveChild): void {
    live.abort.abort();
    this.live.delete(live.child.threadId);
    if (['starting', 'working', 'needs_permission', 'stopping'].includes(live.child.state)) {
      live.child.state = 'unknown';
      this.publish(live);
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const live of [...this.live.values()]) this.invalidate(live);
  }
}
