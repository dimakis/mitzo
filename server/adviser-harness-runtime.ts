import type { ModelSession, ModelSessionConfig } from '@mitzo/harness';
import type { AccountBinding } from '@mitzo/protocol';
import type { AdviserRequest } from './terminal-adviser.js';
import { AdviserTaskScope, type AdviserTaskSnapshot } from './adviser-task-scope.js';
export interface AdviserFeatureOwner {
  authSessionId: string;
  operatorConnectionId: string;
  feature: AdviserTaskSnapshot['feature'];
}
interface TaskObservation {
  scope: AdviserTaskScope;
  onQueryEvent(event: Readonly<Record<string, unknown>>): void;
  onTerminalOutcome(error?: Error): void;
}
type TaskDispatch = (input: TaskObservation) => Promise<{ close(): Promise<void> | void }>;
/** Projects exact live query events. The existing query owns inference, tools,
 * command receipts and cancellation; this feature never retries a dispatch. */
export async function runScopedAdviser(scope: AdviserTaskScope, dispatch: TaskDispatch) {
  scope.assertCurrent();
  let text = '',
    settled = false;
  let messageId: string | undefined;
  const blocks = new Set<string>();
  let usage: { inputTokens: number; outputTokens: number; totalCostUsd?: number } | undefined;
  let resolve!: () => void, reject!: (error: unknown) => void;
  const terminal = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Dispatch may fail before this observer is awaited.
  void terminal.catch(() => {});
  const abort = () => {
    if (!settled) {
      settled = true;
      reject(scope.signal.reason ?? Error('Adviser cancelled'));
    }
  };
  scope.signal.addEventListener('abort', abort, { once: true });
  let handle: Awaited<ReturnType<TaskDispatch>> | undefined;
  try {
    handle = await dispatch({
      scope,
      onQueryEvent(event) {
        try {
          scope.assertCurrent();
          if (typeof event.sessionId !== 'string')
            throw Error('Adviser event session identity unavailable');
          scope.assertCommand(event.sessionId);
          if (event.type === 'message_start') {
            if (typeof event.messageId !== 'string')
              throw Error('Adviser message identity unavailable');
            messageId = event.messageId;
            blocks.clear();
          }
          if (event.type === 'block_start' && event.blockType === 'text') {
            if (event.messageId !== messageId || typeof event.blockId !== 'string')
              throw Error('Adviser text block identity differs');
            blocks.add(event.blockId);
          }
          if (event.type === 'block_delta' && event.blockType === 'text') {
            if (
              event.messageId !== messageId ||
              typeof event.blockId !== 'string' ||
              !blocks.has(event.blockId) ||
              typeof event.delta !== 'string'
            )
              throw Error('Adviser text block identity differs');
            text += event.delta;
            if (text.length > 32768) throw Error('Adviser response exceeded limit');
          }
          if (event.type === 'session_end' && !settled) {
            const measured = event.usage as Record<string, unknown> | undefined;
            if (
              measured &&
              typeof measured.inputTokens === 'number' &&
              Number.isSafeInteger(measured.inputTokens) &&
              measured.inputTokens > 0 &&
              typeof measured.outputTokens === 'number' &&
              Number.isSafeInteger(measured.outputTokens) &&
              measured.outputTokens > 0
            )
              usage = {
                inputTokens: measured.inputTokens,
                outputTokens: measured.outputTokens,
                ...(typeof measured.totalCostUsd === 'number' &&
                Number.isFinite(measured.totalCostUsd) &&
                measured.totalCostUsd >= 0
                  ? { totalCostUsd: measured.totalCostUsd }
                  : {}),
              };
            settled = true;
            if (event.terminalReason) reject(Error('Adviser provider turn failed'));
            else resolve();
          }
        } catch (error) {
          if (!settled) {
            settled = true;
            reject(error);
          }
        }
      },
      onTerminalOutcome(error) {
        if (settled) return;
        settled = true;
        reject(error ?? Error('Adviser provider terminal was not observed'));
      },
    });
    scope.assertCurrent();
    await terminal;
    return { ...scope.result(text), ...(usage ? { usage } : {}) };
  } finally {
    scope.signal.removeEventListener('abort', abort);
    await handle?.close();
  }
}

/** Real production composition, using the same ordinary workspace/admission,
 * native query, event and account owners as chat. Imports are lazy to avoid a
 * second application bootstrap and preserve the chat module's existing owner. */
export async function createNativeAdviserSession(
  config: ModelSessionConfig,
  request: AdviserRequest,
  owner: AdviserFeatureOwner,
  binding: AccountBinding,
): Promise<ModelSession> {
  if (
    config.model !== request.model ||
    (config.reasoningEffort ?? null) !== (request.reasoningEffort ?? null)
  )
    throw Error('Adviser inference selection differs from the reviewed task');
  const { captureAgentLibraryAuthorization } = await import('./agent-library-transport.js');
  const authorization = captureAgentLibraryAuthorization(owner.operatorConnectionId);
  if (authorization.auth.id !== owner.authSessionId)
    throw Error('Original adviser operator required');
  const { loadAccountProfiles } = await import('./account-profiles.js');
  const { sessionHarnessForProvider } = await import('./session-harness-routing.js');
  const { ordinaryRepositoryRuntimeInventory } = await import('./ordinary-local-codex-entry.js');
  const harness = sessionHarnessForProvider(binding.provider);
  if (harness === 'gemini') throw Error('Gemini adviser uses its retained engine');
  const inventory = ordinaryRepositoryRuntimeInventory('local', harness);
  const targets = inventory.result.targets.filter(
    (target) => target.location === 'local' && target.harness === harness,
  );
  if (targets.length !== 1) throw Error('Explicit adviser execution target unavailable');
  const target = targets[0];
  const candidate = {
    account: {
      accountId: binding.accountId,
      provider: binding.provider,
      profileRevision: binding.profileRevision,
    },
    harness,
    targetId: target.targetId,
    mode: 'ask' as const,
  };
  const resolved = inventory.catalog.resolve(candidate);
  if (resolved.status !== 'compatible')
    throw Error('Selected adviser account and execution target unavailable');
  const runtime = { ...candidate, account: resolved.binding.account };
  const vertexCredential =
    harness === 'claude-sdk'
      ? (await import('./ordinary-local-vertex-custody.js')).VertexAdcCustody.capture(
          loadAccountProfiles().sdkEnv(binding, {}),
        )
      : undefined;
  const current = () => {
    authorization.assertCurrent();
    const profiles = loadAccountProfiles();
    const now = profiles.resolve(binding.accountId, request.model);
    if (now.profileRevision !== binding.profileRevision || now.provider !== binding.provider)
      throw Error('Original adviser account changed');
    profiles.validateModelSelection(now, request.model, request.reasoningEffort);
    vertexCredential?.assertCurrent(profiles.sdkEnv(now, {}));
    const fresh = ordinaryRepositoryRuntimeInventory('local', harness).catalog.resolve(runtime);
    if (
      fresh.status !== 'compatible' ||
      JSON.stringify(fresh.binding) !== JSON.stringify(resolved.binding)
    )
      throw Error('Original adviser execution target changed');
  };
  current();
  return {
    provider: harness,
    async *turn(messages) {
      const scope = new AdviserTaskScope(
        {
          authSessionId: owner.authSessionId,
          feature: owner.feature,
          accountId: binding.accountId,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          instructions: config.systemPrompt,
          messages: messages.map((message) => {
            if (
              !['user', 'assistant'].includes(message.role) ||
              typeof message.content !== 'string'
            )
              throw Error('Reviewed adviser text required');
            return { role: message.role as 'user' | 'assistant', content: message.content };
          }),
        },
        current,
        config.signal ?? AbortSignal.timeout(120000),
      );
      scope.assertSelection(binding, request.reasoningEffort);
      const result = await runScopedAdviser(scope, async (observation) => {
        const { randomUUID } = await import('node:crypto');
        const { DEFAULT_MITZO_PROFILE_ID, DEFAULT_MITZO_PROFILE_REVISION } =
          await import('@mitzo/protocol');
        const { readBuiltinAgentLibraryProfile } = await import('./agent-library-transport.js');
        const { ordinaryWorkspaceTaskRoot } = await import('./ordinary-workspace-runtime.js');
        const { getOrdinaryWorkspaces } = await import('./repository-workspace-runtime.js');
        const { NullTransport } = await import('./null-transport.js');
        const chat = await import('./chat.js');
        const workspaces = getOrdinaryWorkspaces();
        const prepared = await workspaces.prepareOrdinaryWorkspace({
          binding,
          selection: {
            runOn: 'local',
            runtime: { account: runtime.account, harness, targetId: runtime.targetId },
          },
          signal: scope.signal,
        });
        const agent = {
          kind: 'builtin' as const,
          profileId: DEFAULT_MITZO_PROFILE_ID,
          revision: DEFAULT_MITZO_PROFILE_REVISION,
        };
        const profile = readBuiltinAgentLibraryProfile(agent)!;
        const selection = {
          version: 1 as const,
          agent,
          context: { source: 'none' as const, revision: null },
          permission: { mode: 'ask' as const, revision: 0 },
          model: request.model,
          thinking: request.reasoningEffort ?? null,
        };
        const operationId = randomUUID();
        const record = await workspaces.reserveOrdinaryWorkspace({
          preparationId: prepared.preparationId,
          allocationOperationId: operationId,
          binding,
          agentProfile: profile,
          taskRoot: ordinaryWorkspaceTaskRoot(true),
          settings: {
            version: 2,
            binding: prepared.runtimeBinding,
            selection,
            workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
          },
          signal: scope.signal,
        });
        const sessionId = record.conversationId,
          commandId = randomUUID(),
          clientId = `adviser:${randomUUID()}`;
        scope.bindCommand(sessionId, commandId);
        let ended!: () => void;
        const cleanup = new Promise<void>((resolve) => {
          ended = resolve;
        });
        const close = () => {
          const live = chat.registry.findBySessionId(sessionId);
          if (live) {
            live.session.abortController.abort();
            live.session.ordinaryRuntimeOwner?.close();
          }
        };
        scope.assertCurrent();
        await config.beforeDispatch?.();
        scope.assertCurrent();
        try {
          if (harness === 'codex') {
            chat.eventStore.prepareOrdinaryWorkspaceSession(
              {
                sessionId,
                ordinaryWorkspaceId: record.id,
                cwd: record.directory,
                accountBinding: binding,
                agentProfile: profile,
                selectedModel: request.model,
                reasoningEffort: selection.thinking,
                mode: 'ask',
              },
              {
                allocationOperationId: operationId,
                preparationFingerprint: record.preparationFingerprint,
                settings: record.settings,
              },
            );
            const { dispatchOwnedOrdinaryCommand } = await import('./ordinary-scoped-command.js');
            await dispatchOwnedOrdinaryCommand({
              transport: new NullTransport(),
              clientId,
              sessionId,
              commandId,
              command: {
                clientMsgId: commandId,
                capabilityRevision: inventory.result.capabilityRevision,
                runtime,
                selection,
                payload: { text: scope.prompt() },
              },
              reservation: {
                id: record.id,
                binding,
                conversationId: sessionId,
                taskRoot: record.hostReservation.taskRoot,
                runtimeBinding: prepared.runtimeBinding,
                commandFingerprint: record.preparationFingerprint,
              },
              operatorConnectionId: owner.operatorConnectionId,
              signal: scope.signal,
              continuation: false,
              existingOwner: false,
              workspaceKind: 'ordinary',
              preparationOperationId: operationId,
              adviserScope: scope,
              onQueryEvent: observation.onQueryEvent,
              onTerminalOutcome: observation.onTerminalOutcome,
              onEnded: ended,
            });
          } else {
            await workspaces.claimOrdinaryWorkspace({
              id: record.id,
              binding,
              conversationId: sessionId,
              taskRoot: record.hostReservation.taskRoot,
              signal: scope.signal,
            });
            const pending = chat.startChat(new NullTransport(), clientId, scope.prompt(), {
              initialSessionId: sessionId,
              clientMsgId: commandId,
              cwd: record.directory,
              accountId: binding.accountId,
              model: request.model,
              reasoningEffort: request.reasoningEffort,
              mode: 'ask',
              operatorConnectionId: owner.operatorConnectionId,
              adviserScope: scope,
              onQueryEvent: observation.onQueryEvent,
              onTerminalOutcome: observation.onTerminalOutcome,
            });
            void pending
              .finally(ended)
              .catch((error) =>
                observation.onTerminalOutcome(
                  error instanceof Error ? error : Error('Adviser harness failed'),
                ),
              );
          }
          return {
            close: async () => {
              close();
              await cleanup;
            },
          };
        } catch (error) {
          close();
          throw error;
        }
      });
      if (result.usage)
        yield {
          type: 'message_start',
          message: {
            id: scope.contextSha256,
            model: request.model,
            role: 'assistant',
            usage: {
              input_tokens: result.usage.inputTokens,
              output_tokens: result.usage.outputTokens,
            },
          },
        };
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: result.text },
      };
      if (result.usage)
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: {
            input_tokens: result.usage.inputTokens,
            output_tokens: result.usage.outputTokens,
          },
        };
    },
  };
}

/** Configuration projection only; every task revalidates the selected account,
 * endpoint, target and actual runtime before any provider dispatch. */
export async function adviserExecutionProjection() {
  const { ordinaryRepositoryRuntimeInventory } = await import('./ordinary-local-codex-entry.js');
  const targets = await Promise.all(
    (['codex', 'claude-sdk'] as const).map(async (harness) => {
      try {
        const inventory = ordinaryRepositoryRuntimeInventory('local', harness);
        const entries = inventory.result.targets.filter(
          (target) => target.location === 'local' && target.harness === harness,
        );
        if (entries.length !== 1) throw Error('Explicit feature target unavailable');
        return { harness, targetId: entries[0].targetId, label: entries[0].label, available: true };
      } catch {
        return { harness, available: false };
      }
    }),
  );
  return {
    location: 'local' as const,
    policy: 'reviewed-context-only' as const,
    available: targets.some((target) => target.available),
    targets,
  };
}
