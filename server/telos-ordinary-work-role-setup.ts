import { assertAgentToolRoute } from './agent-tool-selection.js';
import { isDeepStrictEqual } from 'node:util';
import {
  TelosOrdinaryWorkRoleSetupInputSchema,
  type TelosOrdinaryWorkRoleSetupInput,
  type TelosOrdinaryWorkRoleSetupIntent,
  type AccountBinding,
  type AgentLibraryVersion,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import { TelosWorkError, type TelosWorkActor, type TelosWorkStore } from './telos-work-store.js';
import {
  TelosWorkRoleContextSelectionSchema,
  renderTelosWorkRoleContext,
} from './telos-work-role-context.js';
import { runTelosWorkRoleSetup } from './telos-work-role-setup.js';
export type TelosOrdinaryWorkRoleScope = {
  actor: TelosWorkActor;
  setup: TelosOrdinaryWorkRoleSetupIntent;
};
export interface TelosOrdinaryWorkSelection {
  binding: AccountBinding;
  agentProfile: AgentLibraryVersion;
  taskRoot: string;
  requiredCapabilities?: readonly string[];
}
/** V2 composition reuses the same role workflow and existing allocation owners. */
export class TelosOrdinaryWorkRoleSetup {
  constructor(
    private deps: {
      work: TelosWorkStore;
      events: EventStore;
      workspaces: RepositoryWorkspaces;
      resolveSelection(
        scope: { actor: TelosWorkActor; input: TelosOrdinaryWorkRoleSetupInput },
        signal: AbortSignal,
      ): Promise<TelosOrdinaryWorkSelection>;
      authorize(scope: TelosOrdinaryWorkRoleScope, signal: AbortSignal): Promise<void>;
      assertBeforeApply(scope: TelosOrdinaryWorkRoleScope & { conversationId: string }): void;
      retainContext(
        scope: TelosOrdinaryWorkRoleScope & { conversationId: string },
        signal: AbortSignal,
      ): Promise<void>;
    },
  ) {}
  async setup(rawActor: TelosWorkActor, raw: unknown, signal: AbortSignal) {
    const actor = structuredClone(rawActor),
      input = TelosOrdinaryWorkRoleSetupInputSchema.parse(structuredClone(raw));
    input.contextSelection = TelosWorkRoleContextSelectionSchema.parse(input.contextSelection);
    if (
      input.contextSelection.itemId !== input.itemId ||
      input.contextSelection.role !== input.role
    )
      throw new TelosWorkError('invalid', 'Role context selection scope mismatch');
    renderTelosWorkRoleContext(input.contextSelection);
    const qualify = async () => {
      signal.throwIfAborted();
      const selected = structuredClone(
        await this.deps.resolveSelection(structuredClone({ actor, input }), signal),
      );
      assertAgentToolRoute(selected.agentProfile.definition, 'codex-owned-local');
      await this.deps.workspaces.qualifyOrdinaryWorkspace({
        ...selected,
        preparationId: input.settings.workspace.preparationId,
        settings: input.settings,
        signal,
      });
      signal.throwIfAborted();
      return selected;
    };
    // Unsupported settings/readiness fail before a role or allocation intent exists.
    const qualified = await qualify();
    return runTelosWorkRoleSetup(actor, input, signal, {
      prepare: () => this.deps.work.prepareOrdinaryRoleSetup(input, actor),
      authorize: (scope, signal) => this.deps.authorize(scope, signal),
      verifyRetained: async (scope) => {
        const receipt = this.deps.events.getOrdinaryWorkspaceSessionPreparation(
          scope.setup.allocationOperationId,
        );
        const original =
          receipt && this.deps.workspaces.getOrdinaryWorkspaceForConversation(receipt.sessionId);
        if (!receipt || !original)
          throw new TelosWorkError('conflict', 'Original ordinary role custody required');
        await this.deps.workspaces.revalidateOrdinaryWorkspace({
          id: original.id,
          conversationId: receipt.sessionId,
          binding: qualified.binding,
          taskRoot: qualified.taskRoot,
          signal,
        });
        signal.throwIfAborted();
        this.deps.assertBeforeApply({ ...scope, conversationId: receipt.sessionId });
        const session = this.deps.events.getSession(receipt.sessionId);
        const workspace = this.deps.workspaces.validateRetainedOrdinaryWorkspace(receipt.sessionId);
        if (
          !receipt ||
          !session ||
          session.isHidden ||
          session.sessionType === 'symposium' ||
          session.conversationSource === 'external_import' ||
          session.ordinaryWorkspaceId !== receipt.workspaceId ||
          session.repositoryWorkspaceId != null ||
          !workspace ||
          workspace.id !== receipt.workspaceId ||
          workspace.allocationOperationId !== receipt.allocationOperationId ||
          workspace.preparationFingerprint !== receipt.preparationFingerprint ||
          workspace.directory !== session.cwd ||
          !isDeepStrictEqual(receipt.settings, scope.setup.input.settings) ||
          !isDeepStrictEqual(workspace.settings, receipt.settings)
        )
          throw new TelosWorkError('conflict', 'Original available ordinary role session required');
        const settings = this.deps.events.getOrdinaryWorkspaceConversationSettings(
          receipt.sessionId,
        );
        if (
          !settings ||
          !isDeepStrictEqual(settings.binding, receipt.settings.binding) ||
          !isDeepStrictEqual(settings.selection.agent, receipt.settings.selection.agent) ||
          !isDeepStrictEqual(settings.selection.context, receipt.settings.selection.context) ||
          !isDeepStrictEqual(settings.selection.permission, receipt.settings.selection.permission)
        )
          throw new TelosWorkError('conflict', 'Original ordinary role selection required');
        if (receipt.firstCommandId === null)
          this.deps.events.assertPreparedOrdinaryWorkspaceSession(
            scope.setup.allocationOperationId,
            session,
            receipt.settings.binding,
            receipt.settings.selection,
          );
      },
      getReceipt: (id) => this.deps.events.getOrdinaryWorkspaceSessionPreparation(id),
      allocate: async (scope, authorize) => {
        const selected = await qualify();
        await authorize();
        const reserved = await this.deps.workspaces.reserveOrdinaryWorkspace({
          ...selected,
          preparationId: input.settings.workspace.preparationId,
          allocationOperationId: scope.setup.allocationOperationId,
          settings: input.settings,
          signal,
        });
        await authorize();
        if (!isDeepStrictEqual(reserved.settings, input.settings))
          throw new TelosWorkError('conflict', 'Original ordinary role settings required');
        return this.deps.events.prepareOrdinaryWorkspaceSession(
          {
            sessionId: reserved.conversationId,
            ordinaryWorkspaceId: reserved.id,
            cwd: reserved.directory,
            accountBinding: selected.binding,
            agentProfile: selected.agentProfile,
            selectedModel: input.settings.selection.model,
            reasoningEffort: input.settings.selection.thinking,
            mode: input.settings.selection.permission.mode,
          },
          {
            allocationOperationId: scope.setup.allocationOperationId,
            preparationFingerprint: reserved.preparationFingerprint,
            settings: input.settings,
          },
        );
      },
      retainContext: (scope, signal) => this.deps.retainContext(scope, signal),
      assertBeforeApply: (scope) => this.deps.assertBeforeApply(scope),
      complete: (setup, id, assert) =>
        this.deps.work.completeOrdinaryRoleSetup(setup, id, actor, assert),
    });
  }
}
