import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { captureDeliveredInput } from './symposium-completion-checkpoints.js';
import type { SymposiumRecipientAttemptRecord } from '@mitzo/protocol';
import {
  createSubscriptionIdentityClient,
  subscriptionIdentityFrame,
  type SubscriptionLaunchIdentity,
} from './symposium-subscription-identity.js';
import { controllerClaimDigest } from './symposium-attempt-transport.js';
import { CodexAppServerClient } from './codex-app-server-client.js';
import type { SymposiumAttemptRegistry } from './symposium-attempt-registry.js';
import type {
  ControlledAttemptProcess,
  ControlledAttemptSandbox,
} from './symposium-attempt-transport.js';
import { CodexConversation, type CodexConversationOptions } from './codex-conversation.js';
import type { CodexConversationStore, CodexCommandInput } from './codex-conversation-store.js';
import type { SymposiumSeatExecution } from './symposium-orchestrator.js';
import type { SymposiumNativeSeat } from './symposium-openshell-seat-executor.js';
import { symposiumSeatRuntimeId, type SymposiumSeatRoute } from './symposium-seat-runtime.js';
import type { SymposiumNativeProfileTools } from './symposium-native-profile-tools.js';
import { symposiumSeatSystemPrompt } from './symposium-seat-prompt.js';

interface NativeCodexConversation {
  initialize(): Promise<void>;
  getThreadId(): string | undefined;
  send(input: CodexCommandInput): Promise<void>;
  interrupt(): Promise<void>;
  close(): void;
}

/** Direct /usr binary: Landlock deliberately denies the old /sandbox launcher. */
export const SYMPOSIUM_CODEX_CONTROLLER_COMMAND = [
  '/usr/bin/codex',
  'app-server',
  '--stdio',
  '-c',
  'model_provider="openshell"',
  '-c',
  'features.enable_request_compression=false',
  '-c',
  'model_providers.openshell={ name = "OpenShell", base_url = "https://api.openai.com/v1", env_key = "OPENAI_API_KEY", wire_api = "responses" }',
] as const;

export function assertCodexControllerCommand(command: readonly string[]): void {
  if (
    command.length !== SYMPOSIUM_CODEX_CONTROLLER_COMMAND.length ||
    command.some((part, index) => part !== SYMPOSIUM_CODEX_CONTROLLER_COMMAND[index])
  )
    throw new Error('Codex controller command differs from the reviewed API launcher');
}

/** Trusted constructor observation; never a provider-supplied authority object. */
export interface DurableSymposiumReviewToolObservation {
  readonly sessionId: string;
  readonly claimToken: string;
  readonly deliveryId: string;
  readonly seatId: string;
  readonly membershipGeneration: number;
  readonly providerThreadId: string;
  readonly providerTurnId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly result: Readonly<{ content: string; isError: boolean }>;
}
function freezeObservation<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeObservation(child);
    Object.freeze(value);
  }
  return value;
}

export interface OpenAiCodexSeatInput {
  /** Trusted constructor-only startup inspection, never a public configuration field. */
  observeStartupConfig?: (
    event: Readonly<{
      sessionId: string;
      claimToken: string;
      deliveryId: string;
      seatId: string;
      membershipGeneration: number;
      controllerClaimDigest: string;
      cwd: string;
      config: unknown;
    }>,
    signal: AbortSignal,
  ) => Promise<void> | void;
  assertStartupCurrent?: () => void;
  sandbox: ControlledAttemptSandbox;
  route: SymposiumSeatRoute;
  execution: SymposiumSeatExecution;
  store: CodexConversationStore;
  profileTools?: SymposiumNativeProfileTools;
  /** Same live source-owner currentness used by the actual reader tool. */
  assertDurableReviewToolCurrent?: () => void;
  /** Constructor-only observer after exact native/store tool-result verification. */
  observeDurableReviewToolResult?: (
    event: DurableSymposiumReviewToolObservation,
  ) => Promise<void> | void;
  attemptRegistry?: SymposiumAttemptRegistry;
  /** Resolves an immutable execution claim from the retained host EventStore. */
  resolveAttempt?: (claimToken: string) => SymposiumRecipientAttemptRecord | undefined;
  /** Exact argv from a host-verified image capability; absent means no real launch. */
  verifiedControllerCommand?: readonly string[];
  createConversation?: (options: CodexConversationOptions) => NativeCodexConversation;
  loadConversationHistory?: CodexConversationOptions['loadConversationHistory'];
  onEvent?: (event: Record<string, unknown>) => void;
  /** Fake conversation hook for no-model controller-proof tests only. */
  testConfirmStopped?: () => Promise<void>;
}

/** Opens a private Codex thread in the session's already reconciled sandbox. */
export async function createOpenAiCodexSeat(
  input: OpenAiCodexSeatInput,
): Promise<SymposiumNativeSeat> {
  const { route, execution } = input;
  if (route.kind !== 'openai-api')
    throw new Error('Codex native seat requires an OpenAI API route');
  const binding = execution.seat.accountBinding;
  if (!binding) throw new Error('Codex native seat lacks account binding');
  return createCodexNativeSeat(input, {
    profile: {
      accountId: binding.accountId,
      accountLabel: binding.accountLabel,
      email: 'sandbox-api@invalid.local',
      planType: 'api',
      model: binding.model,
      sandboxProvider: route.provider,
      sandboxProviderId: route.providerId,
    },
    modelProvider: 'openshell',
    verifyBinding: async () => binding,
    assertCommand: assertCodexControllerCommand,
  });
}

/** Shared durable conversation, streaming, receipt and exact-stop lifecycle. */
export async function createCodexNativeSeat(
  input: OpenAiCodexSeatInput,
  auth: Pick<CodexConversationOptions, 'profile' | 'modelProvider' | 'verifyBinding'> & {
    assertCommand(command: readonly string[]): void;
    beforeDispatch?(): void;
    launchIdentity?: SubscriptionLaunchIdentity;
    runtimeConfig?: Record<string, unknown>;
  },
): Promise<SymposiumNativeSeat> {
  const { route, execution, sandbox } = input;
  if (
    input.observeDurableReviewToolResult &&
    (typeof input.observeDurableReviewToolResult !== 'function' ||
      typeof input.assertDurableReviewToolCurrent !== 'function' ||
      typeof input.profileTools?.onToolResultDurable !== 'function')
  )
    throw new Error('Durable review observer requires paired current owner capability');
  if (
    input.observeStartupConfig &&
    (typeof input.observeStartupConfig !== 'function' ||
      typeof input.assertStartupCurrent !== 'function' ||
      !input.attemptRegistry ||
      !input.resolveAttempt)
  )
    throw new Error('Startup observer requires paired original owner capability');
  const binding = execution.seat.accountBinding;
  if (!binding) throw new Error('Codex native seat lacks account binding');
  const startupIdentity = structuredClone({
    claimToken: execution.claimToken,
    sessionId: execution.sessionId,
    seatId: execution.seat.id,
    deliveryId: execution.deliveryId,
    provenance: execution.provenance,
    accountBinding: binding,
    sandboxName: sandbox.sandboxName,
    workdir: sandbox.workdir,
  });
  let startupVetoed = false;
  let callbacks:
    | {
        beforeDispatch(providerThreadId?: string): void;
        accepted(providerThreadId: string, providerTurnId: string): void;
      }
    | undefined;
  let terminal: { resolve: (value: string) => void } | undefined;
  let terminalPromise: Promise<string> | undefined;
  let confirmedTerminal: Promise<string> | undefined;
  let resolveConfirmedTerminal: ((status: string) => void) | undefined;
  let confirmedStatus: string | undefined;
  let acceptedTurnId: string | undefined;
  let acceptedThreadId: string | undefined;
  const observationContext = input.attemptRegistry
    ? structuredClone({
        claimToken: execution.claimToken,
        sessionId: execution.sessionId,
        seatId: execution.seat.id,
        membershipGeneration: execution.provenance.membershipGeneration,
        accountBinding: binding,
        provenance: execution.provenance,
      })
    : undefined;
  if (
    observationContext &&
    (!Number.isSafeInteger(observationContext.membershipGeneration) ||
      Number(observationContext.membershipGeneration) < 0)
  )
    throw new Error('Native observation requires exact membership generation');
  let rejectTerminal: ((error: Error) => void) | undefined;
  let dispatched = false;
  let observerVetoed = false;
  let observerCompletionClosing = false;
  const pendingReviewObservers = new Set<Promise<void>>();
  let controlled: ControlledAttemptProcess | undefined;
  const content: string[] = [];
  const captureInput = () => {
    if (!input.resolveAttempt) return; // Explicit fake conversation seam; real launch requires resolver.
    if (!input.attemptRegistry) throw new Error('Completion checkpoint registry unavailable');
    input.attemptRegistry.checkpoints.capture(
      captureDeliveredInput(input.resolveAttempt(execution.claimToken), execution),
    );
  };
  const options: CodexConversationOptions = {
    ownerKind: 'symposium',
    conversationId: symposiumSeatRuntimeId(execution),
    cwd: sandbox.workdir,
    runtimeCwd: sandbox.workdir,
    profile: auth.profile,
    storedBinding: binding,
    store: input.store,
    loadConversationHistory: input.loadConversationHistory,
    ...(input.route.kind === 'chatgpt-subscription-native'
      ? { providerThreadLifecycle: 'attempt' as const }
      : {}),
    systemPrompt: [symposiumSeatSystemPrompt(execution.seat), input.profileTools?.instructions]
      .filter(Boolean)
      .join('\n\n'),
    tools: input.profileTools?.tools ?? [],
    createClient: (lifecycle) => {
      if (!input.attemptRegistry || !input.verifiedControllerCommand || !input.resolveAttempt)
        throw new Error('Verified Codex native controller capability is unavailable');
      auth.assertCommand(input.verifiedControllerCommand);
      auth.launchIdentity?.assertCurrent();
      if (auth.launchIdentity)
        subscriptionIdentityFrame(auth.launchIdentity, controllerClaimDigest(execution.claimToken));
      execution.signal.throwIfAborted();
      controlled = input.attemptRegistry.launch({
        sandbox,
        sessionId: execution.sessionId,
        claimToken: execution.claimToken,
        ...('version' in execution.provenance && execution.provenance.version === 3
          ? { artifact: execution.provenance.artifact }
          : {}),
        access: route.readOnly ? 'read' : 'write',
        command: input.verifiedControllerCommand,
      });
      if (auth.launchIdentity) {
        const process = controlled;
        return createSubscriptionIdentityClient(
          process.child,
          auth.launchIdentity,
          controllerClaimDigest(execution.claimToken),
          process.confirmStopped,
          { lifecycle, signal: execution.signal },
        );
      }
      return new CodexAppServerClient(controlled.child, { lifecycle });
    },
    emit: (event) => {
      input.onEvent?.(event);
      if (event.type !== 'assistant') return;
      const message = event.message;
      if (!message || typeof message !== 'object') return;
      const blocks = (message as { content?: unknown }).content;
      if (!Array.isArray(blocks)) return;
      for (const block of blocks) {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
          const text = (block as { text?: unknown }).text;
          if (typeof text === 'string' && text) content.push(text);
        }
      }
    },
    executeTool:
      input.profileTools?.executeTool ??
      (async () => ({
        content: 'Symposium native host tools are unavailable',
        isError: true,
      })),
    onToolResultDurable: input.observeDurableReviewToolResult
      ? (name, arguments_, result, context) => {
          if (observerCompletionClosing) {
            observerVetoed = true;
            return Promise.reject(new Error('Durable review observation after completion fence'));
          }
          const pending = (async () => {
            const original = input.profileTools?.onToolResultDurable;
            if (!original) throw new Error('Durable review owner callback unavailable');
            const captured = structuredClone({ name, arguments_, result, context });
            const assertCurrent = () => {
              execution.signal.throwIfAborted();
              if (observerVetoed) throw new Error('Durable review observer permanently vetoed');
              input.assertDurableReviewToolCurrent!();
              const attempt = input.resolveAttempt?.(execution.claimToken);
              const controller = input.attemptRegistry?.get(execution.claimToken);
              const observation = input.attemptRegistry?.observations.get(execution.claimToken);
              const identity = observation?.identity;
              if (
                execution.seat.role !== 'reviewer' ||
                name !== 'SymposiumReadSealedReviewPage' ||
                !('version' in execution.provenance) ||
                execution.provenance.version !== 3 ||
                !('kind' in execution.provenance.artifact) ||
                execution.provenance.artifact.kind !== 'sealed_reader' ||
                controller?.state !== 'reserved' ||
                controller.sessionId !== execution.sessionId ||
                controller.sandboxName !== sandbox.sandboxName ||
                controller.workdir !== sandbox.workdir ||
                !isDeepStrictEqual(controller.artifact, execution.provenance.artifact) ||
                attempt?.status !== 'executing' ||
                attempt.claimToken !== execution.claimToken ||
                attempt.deliveryId !== execution.deliveryId ||
                attempt.seatId !== execution.seat.id ||
                attempt.providerThreadId !== acceptedThreadId ||
                attempt.providerTurnId !== acceptedTurnId ||
                !isDeepStrictEqual(attempt.provenance, execution.provenance) ||
                !identity ||
                observation.status !== 'accepted' ||
                observation.terminalConflict ||
                identity.claimToken !== execution.claimToken ||
                identity.sessionId !== execution.sessionId ||
                identity.seatId !== execution.seat.id ||
                identity.membershipGeneration !== execution.provenance.membershipGeneration ||
                !isDeepStrictEqual(identity.accountBinding, binding) ||
                !isDeepStrictEqual(identity.provenance, execution.provenance) ||
                identity.providerThreadId !== acceptedThreadId ||
                identity.providerTurnId !== acceptedTurnId ||
                captured.context.turnId !== acceptedTurnId ||
                !acceptedThreadId ||
                !acceptedTurnId ||
                captured.result.isError
              )
                throw new Error('Durable native review identity is no longer current');
              const replay = input.store.replayToolResult(
                symposiumSeatRuntimeId(execution),
                binding,
                execution.claimToken,
                captured.context.callId,
                {
                  turnId: captured.context.turnId,
                  toolName: captured.name,
                  requestHash: createHash('sha256')
                    .update(JSON.stringify(captured.arguments_))
                    .digest('hex'),
                },
              );
              if (
                !replay ||
                replay.content !== captured.result.content ||
                replay.isError !== captured.result.isError
              )
                throw new Error('Durable native review result differs from retained replay');
            };
            try {
              assertCurrent();
              // Original owner validation must finish before observation, including replay.
              await original(captured.name, captured.arguments_, captured.result, captured.context);
              assertCurrent();
              await input.observeDurableReviewToolResult!(
                freezeObservation({
                  sessionId: execution.sessionId,
                  claimToken: execution.claimToken,
                  deliveryId: execution.deliveryId,
                  seatId: execution.seat.id,
                  membershipGeneration: execution.provenance.membershipGeneration!,
                  providerThreadId: acceptedThreadId!,
                  providerTurnId: acceptedTurnId!,
                  callId: captured.context.callId,
                  toolName: captured.name,
                  arguments: captured.arguments_,
                  result: captured.result,
                }),
              );
              assertCurrent();
            } catch (error) {
              observerVetoed = true;
              throw error;
            }
          })();
          pendingReviewObservers.add(pending);
          const settled = () => pendingReviewObservers.delete(pending);
          void pending.then(settled, settled);
          return pending;
        }
      : input.profileTools?.onToolResultDurable,
    startupSignal: execution.signal,
    observeStartupConfig: input.observeStartupConfig
      ? async (event, startupSignal = execution.signal) => {
          const assertCurrent = () => {
            if (startupVetoed) throw new Error('Native startup observer permanently vetoed');
            startupSignal.throwIfAborted();
            execution.signal.throwIfAborted();
            input.assertStartupCurrent!();
            auth.launchIdentity?.assertCurrent();
            const controller = input.attemptRegistry!.get(startupIdentity.claimToken);
            const attempt = input.resolveAttempt!(startupIdentity.claimToken);
            if (
              !controlled ||
              controller?.state !== 'reserved' ||
              controller.claimToken !== startupIdentity.claimToken ||
              controller.sessionId !== startupIdentity.sessionId ||
              controller.sandboxName !== startupIdentity.sandboxName ||
              controller.workdir !== startupIdentity.workdir ||
              !isDeepStrictEqual(
                controller.artifact ?? null,
                'version' in startupIdentity.provenance && startupIdentity.provenance.version === 3
                  ? startupIdentity.provenance.artifact
                  : null,
              ) ||
              attempt?.status !== 'executing' ||
              attempt.claimToken !== startupIdentity.claimToken ||
              attempt.deliveryId !== startupIdentity.deliveryId ||
              attempt.seatId !== startupIdentity.seatId ||
              !isDeepStrictEqual(attempt.provenance, startupIdentity.provenance) ||
              !isDeepStrictEqual(execution.seat.accountBinding, startupIdentity.accountBinding) ||
              execution.claimToken !== startupIdentity.claimToken ||
              execution.sessionId !== startupIdentity.sessionId ||
              execution.deliveryId !== startupIdentity.deliveryId ||
              execution.seat.id !== startupIdentity.seatId ||
              !isDeepStrictEqual(execution.provenance, startupIdentity.provenance) ||
              sandbox.sandboxName !== startupIdentity.sandboxName ||
              sandbox.workdir !== startupIdentity.workdir ||
              event.cwd !== startupIdentity.workdir
            )
              throw new Error('Original native startup binding changed');
          };
          try {
            assertCurrent();
            await input.observeStartupConfig!(
              freezeObservation({
                sessionId: startupIdentity.sessionId,
                claimToken: startupIdentity.claimToken,
                deliveryId: startupIdentity.deliveryId,
                seatId: startupIdentity.seatId,
                membershipGeneration: startupIdentity.provenance.membershipGeneration!,
                controllerClaimDigest: controllerClaimDigest(startupIdentity.claimToken),
                cwd: event.cwd,
                config: event.config,
              }),
              startupSignal,
            );
            assertCurrent();
          } catch (error) {
            startupVetoed = true;
            throw error;
          }
        }
      : undefined,
    validateModel: (model, effort) => {
      if (model !== route.model || (effort ?? null) !== route.effort)
        throw new Error('Symposium model or effort changed before native turn');
    },
    modelProvider: auth.modelProvider,
    runtimeConfig: {
      web_search: 'disabled',
      ...auth.runtimeConfig,
      ...(route.readOnly
        ? {
            'features.use_legacy_landlock': true,
            'features.shell_tool': false,
            'features.unified_exec': false,
            'features.code_mode': false,
            'features.code_mode_host': false,
          }
        : {}),
    },
    turnSandboxPolicy: route.readOnly
      ? { type: 'readOnly' }
      : { type: 'externalSandbox', networkAccess: 'restricted' },
    verifyBinding: auth.verifyBinding,
    onProviderDispatch: (commandId) => {
      if (observerVetoed) throw new Error('Durable review observer permanently vetoed');
      if (commandId !== execution.claimToken) throw new Error('Symposium command identity changed');
      captureInput();
      auth.beforeDispatch?.();
      callbacks?.beforeDispatch(conversation.getThreadId());
      dispatched = true;
    },
    onProviderAccepted: (commandId, providerThreadId, providerTurnId) => {
      if (commandId !== execution.claimToken || providerThreadId !== conversation.getThreadId())
        throw new Error('Symposium receipt identity changed');
      if (observationContext)
        input.attemptRegistry!.observations.accept({
          ...observationContext,
          membershipGeneration: observationContext.membershipGeneration!,
          providerThreadId,
          providerTurnId,
        });
      acceptedThreadId = providerThreadId;
      acceptedTurnId = providerTurnId;
      callbacks?.accepted(providerThreadId, providerTurnId);
    },
    onProviderTerminalConflict: (commandId, threadId, turnId, status, previousStatus) => {
      if (
        commandId !== execution.claimToken ||
        threadId !== acceptedThreadId ||
        turnId !== acceptedTurnId
      )
        return;
      if (observationContext)
        input.attemptRegistry!.observations.conflict({
          claimToken: commandId,
          providerThreadId: threadId,
          providerTurnId: turnId,
          status,
          previousStatus,
        });
    },
    onProviderTerminal: (commandId, turnId, status) => {
      if (commandId !== execution.claimToken || turnId !== acceptedTurnId) return;
      if (observationContext && acceptedThreadId)
        input.attemptRegistry!.observations.terminal({
          claimToken: commandId,
          providerThreadId: acceptedThreadId,
          providerTurnId: turnId,
          status,
        });
      confirmedStatus = status;
      resolveConfirmedTerminal?.(status);
    },
    onProviderComplete: (commandId, status) => {
      if (commandId !== execution.claimToken || !terminal) return;
      // CodexConversation emits the final assistant item after this callback.
      queueMicrotask(() => terminal?.resolve(status));
    },
    onError: (error) => rejectTerminal?.(error),
  };
  const closeAndConfirm = async (conversation: NativeCodexConversation) => {
    observerCompletionClosing = true;
    conversation.close();
    if (controlled) await controlled.confirmStopped();
    else if (input.createConversation) await input.testConfirmStopped?.();
  };
  const awaitReviewObservers = async () => {
    execution.signal.throwIfAborted();
    if (pendingReviewObservers.size) {
      let onAbort: (() => void) | undefined;
      try {
        await Promise.race([
          Promise.all([...pendingReviewObservers]),
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(execution.signal.reason ?? new Error('Native review aborted'));
            execution.signal.addEventListener('abort', onAbort, { once: true });
            if (execution.signal.aborted) onAbort();
          }),
        ]);
      } finally {
        if (onAbort) execution.signal.removeEventListener('abort', onAbort);
      }
    }
    execution.signal.throwIfAborted();
    input.assertDurableReviewToolCurrent!();
    if (observerVetoed) throw new Error('Durable review observer permanently vetoed');
  };
  let conversation!: NativeCodexConversation;
  try {
    conversation = input.createConversation?.(options) ?? new CodexConversation(options);
    await conversation.initialize();
  } catch (error) {
    if (conversation) await closeAndConfirm(conversation);
    else if (controlled) {
      controlled.child.kill();
      await controlled.confirmStopped();
    } else if (input.createConversation) await input.testConfirmStopped?.();
    throw error;
  }
  const providerThreadId = conversation.getThreadId();
  if (!providerThreadId) {
    await closeAndConfirm(conversation);
    throw new Error('Codex seat did not establish a provider thread');
  }
  let migratedFrom: string | undefined;
  if (execution.providerThreadId && execution.providerThreadId !== providerThreadId) {
    try {
      input.store[
        input.route.kind === 'chatgpt-subscription-native'
          ? 'assertAttemptHomeReplacement'
          : 'assertToolSurfaceReplacement'
      ](symposiumSeatRuntimeId(execution), binding, execution.providerThreadId, providerThreadId);
      migratedFrom = execution.providerThreadId;
    } catch (error) {
      await closeAndConfirm(conversation);
      throw new Error('Codex seat resumed a different provider thread without verified migration', {
        cause: error,
      });
    }
  }
  return {
    verifyThreadMigration(previous, next) {
      if (previous !== migratedFrom || next !== providerThreadId)
        throw new Error('Codex seat thread migration identity changed');
      // Revalidate before dispatch while the one-shot continuity fragment is durable.
      input.store[
        input.route.kind === 'chatgpt-subscription-native'
          ? 'assertAttemptHomeReplacement'
          : 'assertToolSurfaceReplacement'
      ](symposiumSeatRuntimeId(execution), binding, previous, next);
    },
    async run(currentExecution, currentCallbacks) {
      if (input.observeDurableReviewToolResult && (observerVetoed || observerCompletionClosing))
        throw new Error('Durable review observer permanently vetoed or completed');
      if (currentExecution.claimToken !== execution.claimToken)
        throw new Error('Codex native attempt identity changed');
      callbacks = currentCallbacks;
      const completed = new Promise<string>((resolve, reject) => {
        terminal = { resolve };
        rejectTerminal = reject;
      });
      terminalPromise = completed;
      confirmedTerminal = new Promise<string>((resolve) => {
        resolveConfirmedTerminal = resolve;
      });
      captureInput();
      await conversation.send({
        id: execution.claimToken,
        prompt: execution.content,
        model: route.model,
        reasoningEffort: route.effort,
      });
      const status = await completed;
      if (status !== 'completed') throw new Error('Codex native turn did not complete');
      await closeAndConfirm(conversation);
      if (input.observeDurableReviewToolResult) {
        try {
          await awaitReviewObservers();
        } catch (error) {
          observerVetoed = true;
          throw error;
        }
      }
      const output = content.join('\n\n');
      if (input.resolveAttempt) {
        if (!acceptedThreadId || !acceptedTurnId)
          throw new Error('Native completion identity unavailable');
        captureInput();
        input.attemptRegistry!.checkpoints.complete({
          claimToken: execution.claimToken,
          providerThreadId: acceptedThreadId,
          providerTurnId: acceptedTurnId,
          output,
        });
      }
      return { providerThreadId, content: output };
    },
    async cancel() {
      if (!dispatched) {
        await closeAndConfirm(conversation);
        return;
      }
      if (!terminalPromise) throw new Error('Codex native cleanup is unconfirmed');
      if (!confirmedStatus) await conversation.interrupt();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const status = await Promise.race([
        confirmedTerminal!,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Codex native cleanup is unconfirmed')),
            15_000,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (!['completed', 'interrupted', 'failed'].includes(status))
        throw new Error('Codex native cleanup is unconfirmed');
      await closeAndConfirm(conversation);
    },
  };
}
