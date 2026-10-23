import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { checkSkillPolicy, type ManagedSession, type SessionRegistry } from '@mitzo/harness';
import type { AccountBinding, AgentContextSnapshot, AgentLibraryVersion } from '@mitzo/protocol';
import {
  captureAgentLibraryAuthorization,
  captureAgentLibraryOperation,
} from './agent-library-transport.js';
import { hasPersistentRevocationAuthority } from './auth.js';
import { agentToolAllowed } from './agent-tool-selection.js';
import {
  CodexConversation,
  type CodexConversationOptions,
  type NativeBaseReadScope,
} from './codex-conversation.js';
import type { CodexConversationStore, CodexNativeTurnTarget } from './codex-conversation-store.js';
import type { EventStore } from './event-store.js';
import { OwnedLocalCodexChatAdmission } from './owned-local-codex-chat-admission.js';
import { isAvailableTelosWorkConversation } from './telos-work-conversation.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import type { NativeMainPublicationCall } from './telos-main-publication-host.js';
import { MainPublicationAccountSchema } from './telos-main-publication-contract.js';

type NativeCall = Parameters<CodexConversationOptions['executeTool']>[3];
export interface NativeHostToolContext extends NativeMainPublicationCall {
  readonly callId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly requestHash: string;
  /** Original acknowledged target data; current authority still requires the pending proof. */
  readonly nativeTarget: Readonly<CodexNativeTurnTarget>;
  /** Private original base-read facts; never a grant or a byte/identity witness. */
  readonly nativeBaseReadScope?: NativeBaseReadScope;
  readonly profile: AgentLibraryVersion | undefined;
  readonly agentContext: AgentContextSnapshot | undefined;
  /** Original admitted root data. A file read still needs its own byte/identity witness. */
  readonly workspace: Readonly<{ kind: 'ordinary' | 'repository'; id: string; directory: string }>;
  assertCurrent(): Promise<void>;
  dispose(): void;
}

function unavailable(): never {
  throw Error('Original signed native host tool scope is unavailable');
}
/** A void TypeScript annotation cannot exclude async or value-returning callbacks. */
function assertSynchronous(assertion: () => unknown): void {
  const result = assertion();
  if (result === undefined) return;
  // Drain a rejected async assertion without treating its eventual value as proof.
  void Promise.resolve(result).catch(() => {});
  unavailable();
}
function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeData(item);
    Object.freeze(value);
  }
  return value;
}

/** Read only immutable data descriptors; malformed facets must not execute getters. */
function frozenProperty(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor || !('value' in descriptor) || descriptor.configurable || descriptor.writable)
    unavailable();
  return descriptor.value;
}
function frozenRecord(value: unknown): asserts value is object {
  if (
    !value ||
    typeof value !== 'object' ||
    !Object.isFrozen(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    unavailable();
}
function boundedString(source: object, key: string): string {
  const value = frozenProperty(source, key);
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    Buffer.byteLength(value) > 4096 ||
    value.includes('\0')
  )
    unavailable();
  return value;
}
function frozenRoots(source: object, key: string): readonly string[] {
  const value = frozenProperty(source, key);
  if (!Array.isArray(value) || !Object.isFrozen(value) || value.length === 0 || value.length > 256)
    unavailable();
  const result: string[] = [];
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const root = boundedString(value, String(index));
    if (!isAbsolute(root) || resolve(root) !== root || (bytes += Buffer.byteLength(root)) > 65536)
      unavailable();
    result.push(root);
  }
  return Object.freeze(result);
}
function originalReadScope(
  value: unknown,
  target: Readonly<CodexNativeTurnTarget>,
  identity: { callId: string; toolName: string; requestHash: string },
  assertCurrentSync: () => void,
): { scope: NativeBaseReadScope; assertOriginal: () => unknown } {
  if (value instanceof Promise) {
    void value.catch(() => {});
    unavailable();
  }
  frozenRecord(value);
  const originalTarget = frozenProperty(value, 'nativeTarget');
  frozenRecord(originalTarget);
  const copiedTarget = Object.fromEntries(
    ['commandId', 'attempt', 'threadId', 'turnId', 'generation'].map((key) => [
      key,
      frozenProperty(originalTarget, key),
    ]),
  );
  if (!isDeepStrictEqual(copiedTarget, target)) unavailable();
  for (const key of ['callId', 'toolName', 'requestHash'] as const)
    if (boundedString(value, key) !== identity[key]) unavailable();
  const assertion = frozenProperty(value, 'assertCurrentSync');
  if (typeof assertion !== 'function' || !Object.isFrozen(assertion)) unavailable();
  return {
    scope: Object.freeze({
      nativeTarget: freezeData(structuredClone(target)),
      ...identity,
      bindingRevision: boundedString(value, 'bindingRevision'),
      profileRevision: boundedString(value, 'profileRevision'),
      policyRevision: boundedString(value, 'policyRevision'),
      readableRoots: frozenRoots(value, 'readableRoots'),
      workspaceRoots: frozenRoots(value, 'workspaceRoots'),
      deniedRoots: frozenRoots(value, 'deniedRoots'),
      assertCurrentSync: Object.freeze(assertCurrentSync),
    }),
    assertOriginal: () => Reflect.apply(assertion, value, []),
  };
}

/** Called inside the original CodexChat verified native callback, before parsing
 * tool intent. No request route accepts these owners or manufactures this scope.
 * The existing native callback/claim and admitted host remain the authority.
 */
export function captureNativeHostToolContext(owners: {
  events: EventStore;
  native: CodexConversationStore;
  registry: SessionRegistry;
  session: ManagedSession;
  conversationId: string;
  binding: AccountBinding;
  runtime: CodexConversation;
  runtimeId: string;
  currentRuntime(): CodexConversation | undefined;
  admission: OwnedLocalCodexChatAdmission;
  assertAgentContextAuthorization(): void;
  profile: AgentLibraryVersion | undefined;
  agentContext: AgentContextSnapshot | undefined;
  workspace: NativeHostToolContext['workspace'];
  toolName: string;
  input: Parameters<CodexConversationOptions['executeTool']>[1];
  call: NativeCall;
  signal: AbortSignal;
}): NativeHostToolContext {
  if (
    !(owners.runtime instanceof CodexConversation) ||
    !(owners.admission instanceof OwnedLocalCodexChatAdmission) ||
    !owners.runtimeId.trim() ||
    !Object.isFrozen(owners.call) ||
    typeof owners.call.assertCurrentSync !== 'function'
  )
    unavailable();
  const assertNativeCallCurrent = owners.call.assertCurrentSync.bind(owners.call);
  assertSynchronous(assertNativeCallCurrent);
  const readFacet = Object.getOwnPropertyDescriptor(owners.call, 'captureNativeBaseReadScope');
  if (
    readFacet &&
    (!('value' in readFacet) ||
      typeof readFacet.value !== 'function' ||
      !Object.isFrozen(readFacet.value) ||
      readFacet.enumerable ||
      readFacet.configurable ||
      readFacet.writable)
  )
    unavailable();
  if (!readFacet && 'captureNativeBaseReadScope' in owners.call) unavailable();
  const original = owners.registry.findBySessionId(owners.conversationId);
  if (!original || original.session !== owners.session) unavailable();
  const driver = original.session.ordinaryRuntimeOwner;
  const connectionId = original.session.ownerConnectionId ?? original.clientId.split(':')[0];
  const authorization = captureAgentLibraryAuthorization(connectionId);
  const operation = captureAgentLibraryOperation(connectionId);
  const lifetime = new AbortController();
  let closed = false;
  try {
    const signal = AbortSignal.any([
      lifetime.signal,
      owners.signal,
      operation.signal,
      owners.session.abortController.signal,
    ]);
    const binding = freezeData(structuredClone(owners.binding));
    const accountBinding = freezeData(
      MainPublicationAccountSchema.parse({
        accountId: binding.accountId,
        provider: binding.provider,
        model: binding.model,
        profileRevision: binding.profileRevision,
      }),
    );
    const profile = freezeData(structuredClone(owners.profile));
    const agentContext = freezeData(structuredClone(owners.agentContext));
    const workspace = freezeData(structuredClone(owners.workspace));
    const role = freezeData(
      structuredClone(resolveTelosWorkRoleContext(owners.events, owners.conversationId, binding)),
    );
    const requestHash = createHash('sha256').update(JSON.stringify(owners.input)).digest('hex');
    const identity = { turnId: owners.call.turnId, toolName: owners.toolName, requestHash };
    const custody = owners.native.readHostCustody(owners.conversationId, binding);
    const pending = owners.native.pendingNativeHostTool(
      owners.conversationId,
      binding,
      owners.call.callId,
      identity,
    );
    if (!custody || custody.authSessionId !== authorization.auth.id || !pending) unavailable();
    const nativeTarget: Readonly<CodexNativeTurnTarget> = freezeData({
      commandId: pending.commandId,
      attempt: pending.attempt,
      threadId: pending.threadId,
      turnId: pending.turnId,
      generation: pending.generation,
    });
    let assertNativeReadCurrent: (() => unknown) | undefined;
    const assertContextCurrentSync = () => {
      if (closed) unavailable();
      signal.throwIfAborted();
      authorization.assertCurrent();
      operation.assertCurrent();
      assertSynchronous(assertNativeCallCurrent);
      assertSynchronous(() => owners.admission.assertCurrentSync());
      assertSynchronous(owners.assertAgentContextAuthorization);
      const current = owners.registry.findBySessionId(owners.conversationId);
      const meta = owners.events.getSession(owners.conversationId);
      const route = owners.events.getSessionRuntimeBinding(owners.conversationId);

      if (
        !hasPersistentRevocationAuthority() ||
        owners.currentRuntime() !== owners.runtime ||
        current?.clientId !== original.clientId ||
        current.session !== original.session ||
        current.session.ordinaryRuntimeOwner !== driver ||
        driver?.authSessionId !== authorization.auth.id ||
        owners.registry.isClosingOut(current.clientId) ||
        owners.registry.isUserClose(current.clientId) ||
        !meta ||
        !isAvailableTelosWorkConversation(meta) ||
        route?.version !== 2 ||
        route.harness.implementation !== 'codex' ||
        route.execution.location !== 'local' ||
        !isDeepStrictEqual(current.session.accountBinding, binding) ||
        !isDeepStrictEqual(meta?.accountBinding, binding) ||
        !isDeepStrictEqual(meta?.agentProfile ?? undefined, profile) ||
        !isDeepStrictEqual(meta?.agentContext ?? undefined, agentContext) ||
        current.session.cwd !== workspace.directory ||
        (workspace.kind === 'ordinary'
          ? meta.ordinaryWorkspaceId !== workspace.id || meta.repositoryWorkspaceId != null
          : meta.repositoryWorkspaceId !== workspace.id || meta.ordinaryWorkspaceId != null) ||
        !agentToolAllowed(current.session, owners.toolName) ||
        checkSkillPolicy(owners.registry, current.clientId, owners.toolName) === 'deny' ||
        createHash('sha256').update(JSON.stringify(owners.input)).digest('hex') !== requestHash ||
        !isDeepStrictEqual(
          owners.native.readHostCustody(owners.conversationId, binding),
          custody,
        ) ||
        !isDeepStrictEqual(
          owners.native.pendingNativeHostTool(
            owners.conversationId,
            binding,
            owners.call.callId,
            identity,
          ),
          pending,
        ) ||
        !isDeepStrictEqual(
          resolveTelosWorkRoleContext(owners.events, owners.conversationId, binding),
          role,
        )
      )
        unavailable();
    };
    const assertCurrentSync = () => {
      assertContextCurrentSync();
      if (assertNativeReadCurrent) {
        assertSynchronous(assertNativeReadCurrent);
        assertContextCurrentSync();
      }
    };
    assertCurrentSync();
    let nativeBaseReadScope: NativeBaseReadScope | undefined;
    if (readFacet) {
      const captured = originalReadScope(
        Reflect.apply(readFacet.value, owners.call, []),
        nativeTarget,
        { callId: owners.call.callId, toolName: owners.toolName, requestHash },
        assertCurrentSync,
      );
      assertNativeReadCurrent = captured.assertOriginal;
      nativeBaseReadScope = captured.scope;
      assertCurrentSync();
    }
    const context = {
      operatorId: authorization.auth.id,
      conversationId: owners.conversationId,
      clientId: original.clientId,
      session: original.session,
      accountBinding,
      runtimeId: owners.runtimeId,
      selectedRole: role,
      callId: owners.call.callId,
      turnId: owners.call.turnId,
      toolName: owners.toolName,
      requestHash,
      nativeTarget,
      profile,
      agentContext,
      workspace,
      signal,
      assertCurrentSync,
      async assertCurrent() {
        assertCurrentSync();
        await owners.admission.assertCurrent();
        assertCurrentSync();
      },
      dispose() {
        if (closed) return;
        closed = true;
        lifetime.abort(Error('Native host tool scope ended'));
        operation.dispose();
      },
    };
    if (nativeBaseReadScope)
      Object.defineProperty(context, 'nativeBaseReadScope', { value: nativeBaseReadScope });
    return Object.freeze(context);
  } catch (error) {
    lifetime.abort();
    operation.dispose();
    throw error;
  }
}
