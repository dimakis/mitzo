import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildPermissionHandler,
  checkSkillPolicy,
  effectivePermissionMode,
  throwIfApprovalExpired,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from './event-store.js';
import {
  localRepositoryToolSchemas,
  localRepositoryToolDefinitions,
} from './session-local-repository-tools.js';
import {
  inputSchema,
  parseLocalRepositoryPreparationInput,
} from './local-repository-preparation-input.js';
import { discoverLocalRepository, inspectLocalRepository } from './local-repository-discovery.js';
import { configuredLocalRepositoryDiscovery } from './repository-workspace-runtime.js';
import {
  assertSdkRepositoryReadOwner,
  type SdkRepositoryReadOwner,
} from './ordinary-local-vertex-sdk-authority.js';
import {
  prepareSdkSecondaryRepository,
  retainSdkSecondaryRepositoryTask,
} from './sdk-secondary-repository.js';
import {
  copyCallbackOutcome,
  retainCallbackOutcome,
  type TurnCallbackRunner,
} from './turn-callbacks.js';
import { qualifyToolResult, reportToolFailure } from './tool-failure-reporting.js';
import { CodexToolFailure, withCodexToolCleanup } from './codex-tool-failure.js';
import { agentToolAllowed } from './agent-tool-selection.js';

export const SDK_REPOSITORY_INSTRUCTIONS = `
For a code task in another existing Mac repository, use DiscoverLocalRepository, InspectLocalRepository, then PrepareLocalRepository with path (or source.kind existing). Preparation attaches an isolated linked worktree to this same chat using the existing Vertex lifecycle. Use its returned directory with Bash cwd or git -C and absolute file paths. For local commits use TaskExecution operation commit with that directory as cwd and selected files; shared Git administration stays outside native Bash's write scope. Authorize or refresh a task grant after attaching the repository, because its registered roots have changed. The primary SDK cwd and chat history remain intact. Keep the assigned branch. A command grant's repositories list authorizes GitHub reads; it does not acquire local code. For clone/new, use native Git setup in an admitted directory; this Claude preparation adapter currently accepts existing local sources. Do not require a new chat or a workspace ID to develop another repository. The outer host sandbox remains enforced when a Bash request asks to disable the SDK sandbox; that option cannot expand task or credential access.
`;
const prepareDefinition = {
  name: 'PrepareLocalRepository',
  description:
    'Prepare an isolated task from an existing Mac repository in this Claude chat. Supply path or source {kind:"existing",path:"..."}. Omit base for the refreshed default branch, or use base {kind:"ref",ref:"HEAD"} for an unremoted repository. Returns the directory for subsequent code operations; preserves the primary SDK cwd/history. Clone/new use native Git setup in an admitted directory. Explicit approval is required.',
};
export interface SdkRepositoryToolsBoundary {
  events: EventStore;
  runCallback?: TurnCallbackRunner;
  captureRepositoryReadOwner(
    name: string,
    input: unknown,
    requestId: unknown,
    signal: AbortSignal,
  ): SdkRepositoryReadOwner;
}
/** Only the actual SDK query supplies callback/read provenance. Filesystem and
 * Git operations reuse the shared readers and Vertex materializer. */
export function registerSdkLocalRepositoryTools(
  server: McpServer,
  sessionId: () => string | undefined,
  session: ManagedSession,
  registry: SessionRegistry,
  boundary: SdkRepositoryToolsBoundary,
) {
  const definitions = [...localRepositoryToolDefinitions, prepareDefinition];
  for (const definition of definitions) {
    const name = definition.name;
    if (!agentToolAllowed(session, name)) continue;
    const wire = `mcp__mitzo-connections__${name}`;
    server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema:
          name === 'PrepareLocalRepository'
            ? inputSchema
            : localRepositoryToolSchemas[name as keyof typeof localRepositoryToolSchemas],
      },
      async (
        input: Record<string, unknown>,
        extra: { signal: AbortSignal; requestId?: string | number },
      ) => {
        const signal = AbortSignal.any([session.abortController.signal, extra.signal]);
        return (boundary.runCallback ?? ((work) => work()))(async () => {
          let effectStarted = false;
          let reader: Awaited<ReturnType<SdkRepositoryReadOwner['captureReader']>> | undefined;
          try {
            const owner = boundary.captureRepositoryReadOwner(wire, input, extra.requestId, signal);
            assertSdkRepositoryReadOwner(owner);
            const current = async () => {
              assertSdkRepositoryReadOwner(owner);
              const id = sessionId();
              const live = id && registry.findBySessionId(id);
              if (
                !live ||
                live.session !== session ||
                id !== owner.conversationId ||
                session.cwd !== owner.cwd ||
                !agentToolAllowed(session, name) ||
                checkSkillPolicy(registry, live.clientId, wire) === 'deny'
              )
                throw Error('Original Claude repository owner changed');
              await owner.assertCurrent();
              assertSdkRepositoryReadOwner(owner);
            };
            await current();
            reader = await owner.captureReader({ deadline: Date.now() + 30000 });
            const heldReader = reader;
            return await withCodexToolCleanup(async () => {
              const request = {
                accessScope: { kind: 'host-wide' as const, deniedRoots: heldReader.deniedRoots },
                signal,
                revalidateReadAccess: current,
                assertReadAccess: async () => assertSdkRepositoryReadOwner(owner),
              };
              const native = <T extends object>(value: T) =>
                Object.defineProperty(value, 'nativeReader', { value: heldReader });
              let value: unknown;
              if (name === 'DiscoverLocalRepository') {
                const parsed = localRepositoryToolSchemas.DiscoverLocalRepository.parse(input);
                value = await discoverLocalRepository(
                  native({
                    ...request,
                    ...configuredLocalRepositoryDiscovery(owner.cwd),
                    query: parsed.query,
                    explicitPath: parsed.path,
                  }),
                );
              } else {
                const parsed =
                  name === 'PrepareLocalRepository'
                    ? parseLocalRepositoryPreparationInput(input)
                    : undefined;
                const source =
                  parsed?.source ??
                  (parsed ? { kind: 'existing' as const, path: parsed.path! } : undefined);
                if (source && source.kind !== 'existing')
                  return retainCallbackOutcome(
                    {
                      content: [
                        {
                          type: 'text' as const,
                          text: 'This Claude adapter prepares existing local repositories. Use native git clone or git init inside the admitted task directory, then operate there with explicit cwd.',
                        },
                      ],
                      isError: true,
                    },
                    'settled',
                  );
                const path =
                  source?.path ??
                  localRepositoryToolSchemas.InspectLocalRepository.parse(input).path;
                const inspected = await inspectLocalRepository(native({ ...request, path }));
                if (!parsed) value = inspected;
                else {
                  if (
                    !inspected.instructions.complete ||
                    effectivePermissionMode(session) === 'ask'
                  )
                    throw new CodexToolFailure('permission_denied');
                  const live = registry.findBySessionId(owner.conversationId)!;
                  const decision = await buildPermissionHandler(live.clientId, registry)(
                    wire,
                    input as Record<string, unknown>,
                    {
                      signal,
                      toolUseID: owner.callback.toolUseId,
                      forcePrompt: true,
                      title: 'Prepare this repository for Claude development?',
                      description: `Create an isolated worktree from ${path} inside ${owner.cwd}. Continue in this chat with its returned task directory.`,
                    },
                  );
                  await current();
                  throwIfApprovalExpired(decision);
                  if (
                    decision.behavior !== 'allow' ||
                    !isDeepStrictEqual(decision.updatedInput ?? input, input)
                  )
                    throw new CodexToolFailure('permission_denied');
                  effectStarted = true;
                  const task = await prepareSdkSecondaryRepository({
                    sourcePath: path,
                    workspaceDirectory: owner.cwd,
                    conversationId: owner.conversationId,
                    wtId: owner.sdkSessionId,
                    base: parsed.base,
                    events: boundary.events,
                    signal,
                    assertCurrent: current,
                    ...(parsed.newCheckout ? { generation: owner.commandId } : {}),
                  });
                  await current();
                  session.worktreePaths.set(task.repoName, {
                    path: task.directory,
                    wtId: owner.sdkSessionId,
                  });
                  await retainSdkSecondaryRepositoryTask(
                    session,
                    boundary.events,
                    owner.conversationId,
                    task.directory,
                  );
                  await current();
                  value = task;
                }
              }
              await current();
              const result = { content: JSON.stringify(value), isError: false };
              qualifyToolResult(name, input as Record<string, unknown>, signal, result);
              return copyCallbackOutcome(result, {
                content: [{ type: 'text' as const, text: result.content }],
                isError: false,
              });
            }, [() => heldReader.dispose(), current]);
          } catch (cause) {
            const result = reportToolFailure(cause, {
              sessionId: sessionId() ?? 'unavailable',
              tool: name,
              signal,
            });
            if (!effectStarted && !signal.aborted) retainCallbackOutcome(result, 'settled');
            return copyCallbackOutcome(result, {
              content: [{ type: 'text' as const, text: result.content }],
              isError: true,
            });
          }
        });
      },
    );
  }
}
