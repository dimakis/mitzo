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

export interface OpenAiCodexSeatInput {
  sandbox: ControlledAttemptSandbox;
  route: SymposiumSeatRoute;
  execution: SymposiumSeatExecution;
  store: CodexConversationStore;
  profileTools?: SymposiumNativeProfileTools;
  attemptRegistry?: SymposiumAttemptRegistry;
  /** Exact argv from a host-verified image capability; absent means no real launch. */
  verifiedControllerCommand?: readonly string[];
  createConversation?: (options: CodexConversationOptions) => NativeCodexConversation;
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
    runtimeConfig?: Record<string, unknown>;
  },
): Promise<SymposiumNativeSeat> {
  const { route, execution, sandbox } = input;
  const binding = execution.seat.accountBinding;
  if (!binding) throw new Error('Codex native seat lacks account binding');
  let callbacks:
    | {
        beforeDispatch(): void;
        accepted(providerThreadId: string, providerTurnId: string): void;
      }
    | undefined;
  let terminal: { resolve: (value: string) => void } | undefined;
  let terminalPromise: Promise<string> | undefined;
  let confirmedTerminal: Promise<string> | undefined;
  let resolveConfirmedTerminal: ((status: string) => void) | undefined;
  let confirmedStatus: string | undefined;
  let acceptedTurnId: string | undefined;
  let rejectTerminal: ((error: Error) => void) | undefined;
  let dispatched = false;
  let controlled: ControlledAttemptProcess | undefined;
  const content: string[] = [];
  const options: CodexConversationOptions = {
    conversationId: symposiumSeatRuntimeId(execution),
    cwd: sandbox.workdir,
    runtimeCwd: sandbox.workdir,
    profile: auth.profile,
    storedBinding: binding,
    store: input.store,
    systemPrompt: [symposiumSeatSystemPrompt(execution.seat), input.profileTools?.instructions]
      .filter(Boolean)
      .join('\n\n'),
    tools: input.profileTools?.tools ?? [],
    createClient: (lifecycle) => {
      if (!input.attemptRegistry || !input.verifiedControllerCommand)
        throw new Error('Verified Codex native controller capability is unavailable');
      auth.assertCommand(input.verifiedControllerCommand);
      controlled = input.attemptRegistry.launch({
        sandbox,
        sessionId: execution.sessionId,
        claimToken: execution.claimToken,
        access: route.readOnly ? 'read' : 'write',
        command: input.verifiedControllerCommand,
      });
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
    validateModel: (model, effort) => {
      if (model !== route.model || (effort ?? null) !== route.effort)
        throw new Error('Symposium model or effort changed before native turn');
    },
    modelProvider: auth.modelProvider,
    runtimeConfig: {
      web_search: 'disabled',
      ...auth.runtimeConfig,
      ...(route.readOnly ? { 'features.use_legacy_landlock': true } : {}),
    },
    turnSandboxPolicy: route.readOnly
      ? { type: 'readOnly' }
      : { type: 'externalSandbox', networkAccess: 'restricted' },
    verifyBinding: auth.verifyBinding,
    onProviderDispatch: (commandId) => {
      if (commandId !== execution.claimToken) throw new Error('Symposium command identity changed');
      auth.beforeDispatch?.();
      callbacks?.beforeDispatch();
      dispatched = true;
    },
    onProviderAccepted: (commandId, providerThreadId, providerTurnId) => {
      if (commandId !== execution.claimToken) throw new Error('Symposium receipt identity changed');
      acceptedTurnId = providerTurnId;
      callbacks?.accepted(providerThreadId, providerTurnId);
    },
    onProviderTerminal: (commandId, turnId, status) => {
      if (commandId !== execution.claimToken || turnId !== acceptedTurnId) return;
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
    conversation.close();
    if (controlled) await controlled.confirmStopped();
    else if (input.createConversation) await input.testConfirmStopped?.();
  };
  const conversation = input.createConversation?.(options) ?? new CodexConversation(options);
  try {
    await conversation.initialize();
  } catch (error) {
    await closeAndConfirm(conversation);
    throw error;
  }
  const providerThreadId = conversation.getThreadId();
  if (!providerThreadId) {
    await closeAndConfirm(conversation);
    throw new Error('Codex seat did not establish a provider thread');
  }
  if (execution.providerThreadId && execution.providerThreadId !== providerThreadId) {
    await closeAndConfirm(conversation);
    throw new Error('Codex seat resumed a different provider thread');
  }
  return {
    async run(currentExecution, currentCallbacks) {
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
      await conversation.send({
        id: execution.claimToken,
        prompt: execution.content,
        model: route.model,
        reasoningEffort: route.effort,
      });
      const status = await completed;
      if (status !== 'completed') throw new Error('Codex native turn did not complete');
      await closeAndConfirm(conversation);
      return { providerThreadId, content: content.join('\n\n') };
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
