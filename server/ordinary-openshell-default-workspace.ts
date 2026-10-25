import { isDeepStrictEqual } from 'node:util';
import {
  OrdinaryCodexFirstCommandSchema,
  OrdinaryWorkspaceFirstCommandSchema,
  type OrdinaryCodexFirstCommand,
  type AccountBinding,
  type AgentLibraryVersion,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import { nativeStartupSessionId, reserveRepositoryStartup } from './ordinary-repository-startup.js';

/** The existing workspace owner reserves logical custody. Only the existing
 * OpenShell runtime manager later builds the configured mgmt sandbox. No Git
 * source, sandbox resource or native turn is created by this normalization. */
export async function prepareDefaultOpenShellCommand(options: {
  input: OrdinaryCodexFirstCommand;
  authSessionId: string;
  workspaces: RepositoryWorkspaces;
  events: EventStore;
  taskRoot(): string;
  qualify(): { binding: AccountBinding; agentProfile: AgentLibraryVersion };
  signal: AbortSignal;
}) {
  const input = OrdinaryCodexFirstCommandSchema.parse(structuredClone(options.input));
  if (input.runOn !== 'openshell' || input.repositoryWorkspaceId || !options.authSessionId)
    throw Error('Default OpenShell intent required');
  const operationId = nativeStartupSessionId(
    JSON.stringify([
      'default-openshell-mgmt-v1',
      options.authSessionId,
      input.runtime.account,
      input.clientMsgId,
    ]),
  );
  const release = reserveRepositoryStartup(`default-openshell:${operationId}`);
  try {
    options.signal.throwIfAborted();
    let record = options.workspaces.getOrdinaryWorkspaceForOperation(operationId);
    if (!record) {
      const { binding, agentProfile } = options.qualify();
      const prepared = await options.workspaces.prepareOrdinaryWorkspace({
        binding,
        selection: {
          runOn: 'openshell',
          runtime: {
            account: input.runtime.account,
            harness: 'codex',
            targetId: input.runtime.targetId,
          },
        },
        signal: options.signal,
      });
      options.signal.throwIfAborted();
      record = await options.workspaces.reserveOrdinaryWorkspace({
        preparationId: prepared.preparationId,
        allocationOperationId: operationId,
        binding,
        agentProfile,
        taskRoot: options.taskRoot(),
        settings: {
          version: 2,
          binding: prepared.runtimeBinding,
          selection: input.selection,
          workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
        },
        signal: options.signal,
      });
    }
    if (
      !record.sandbox ||
      record.settings.binding.execution.location !== 'openshell' ||
      record.settings.binding.execution.targetId !== input.runtime.targetId ||
      !isDeepStrictEqual(record.settings.binding.account, input.runtime.account) ||
      !isDeepStrictEqual(record.settings.selection, input.selection)
    )
      throw Error('Original default OpenShell settings required');
    options.signal.throwIfAborted();
    // Recover only the exact interrupted allocation. Existing metadata/command
    // receipts are validated by public admission; never rewrite a retained chat.
    if (!options.events.getOrdinaryWorkspaceSessionPreparation(operationId)) {
      options.events.prepareOrdinaryWorkspaceSession(
        {
          sessionId: record.conversationId,
          ordinaryWorkspaceId: record.id,
          cwd: record.directory,
          accountBinding: record.binding,
          agentProfile: record.agentProfile,
          selectedModel: record.settings.selection.model,
          reasoningEffort: record.settings.selection.thinking,
          mode: record.settings.selection.permission.mode,
        },
        {
          allocationOperationId: operationId,
          preparationFingerprint: record.preparationFingerprint,
          settings: record.settings,
        },
      );
    }
    return OrdinaryWorkspaceFirstCommandSchema.parse({
      version: 2,
      runOn: 'openshell',
      sessionId: record.conversationId,
      workspace: { kind: 'ordinary', workspaceId: record.id },
      clientMsgId: input.clientMsgId,
      capabilityRevision: input.capabilityRevision,
      runtime: input.runtime,
      selection: input.selection,
      payload: input.payload,
    });
  } finally {
    release();
  }
}
