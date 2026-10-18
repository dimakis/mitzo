import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { retainTelosWorkRolePresentation } from './telos-work-role-presentation.js';
import {
  CollaborationSettingsSchema,
  TelosWorkDelegationInputSchema,
  type CollaborationSettings,
  type TelosWorkDelegationIntent,
  type TelosWorkDelegationReceipt,
  type TelosWorkRolePresentation,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import type { TaskStore, TelosExecutionTaskBinding } from './task-store.js';
import { TelosWorkError, type TelosWorkActor, type TelosWorkStore } from './telos-work-store.js';
import {
  renderTelosWorkRoleContext,
  retainTelosWorkRoleContext,
  resolveTelosWorkRoleContext,
  TelosWorkRoleContextSelectionSchema,
} from './telos-work-role-context.js';

export interface TelosWorkDelegationScope {
  actor: TelosWorkActor;
  intent: TelosWorkDelegationIntent;
  /** Original lead selection or its exact independent worker workspace. */
  settings: CollaborationSettings;
}
type Preparation = Omit<
  Parameters<RepositoryWorkspaces['prepareOrdinarySession']>[0],
  'allocationOperationId' | 'id' | 'settings' | 'signal'
>;

/** Provision one exact ordinary worker and its pending Task Board mapping.
 * Durable ordinary preparation owns allocation/recovery. This owner has no
 * provider, command admission, queue, dispatch or assignment-changing port.
 */
export class TelosWorkDelegation {
  constructor(
    private readonly deps: {
      work: TelosWorkStore;
      events: EventStore;
      tasks: TaskStore;
      workspaces: RepositoryWorkspaces;
      authorize(scope: TelosWorkDelegationScope, signal: AbortSignal): Promise<void>;
      resolvePreparation(
        scope: TelosWorkDelegationScope,
        signal: AbortSignal,
      ): Promise<Preparation>;
      /** Optional retained display capture; legacy direct owners keep their original behavior. */
      capturePresentation?(scope: TelosWorkDelegationScope): TelosWorkRolePresentation;
      /** Synchronous authority/material denial fence, including final work commit. */
      assertBeforeApply(scope: TelosWorkDelegationScope): void;
    },
  ) {}

  async delegate(
    rawActor: TelosWorkActor,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<TelosWorkDelegationReceipt> {
    const actor = structuredClone(rawActor);
    const input = TelosWorkDelegationInputSchema.parse(structuredClone(raw));
    input.contextSelection = TelosWorkRoleContextSelectionSchema.parse(input.contextSelection);
    renderTelosWorkRoleContext(input.contextSelection);
    signal.throwIfAborted();
    let intent: TelosWorkDelegationIntent | undefined;
    try {
      const retained = this.deps.work.prepareDelegation(
        input,
        actor,
        (selected) => {
          signal.throwIfAborted();
          this.deps.assertBeforeApply(
            structuredClone({ actor, intent: selected, settings: selected.input.settings }),
          );
        },
        this.deps.capturePresentation
          ? (selected) =>
              this.deps.capturePresentation!(
                structuredClone({ actor, intent: selected, settings: selected.input.settings }),
              )
          : undefined,
      );
      intent = structuredClone(retained.intent);
      // A different default-start request may resolve to the existing attempt.
      // Every subsequent decision uses its canonical original selections.
      const selected = intent;
      const sourceSettings = CollaborationSettingsSchema.parse(selected.input.settings);
      const workerSettings = CollaborationSettingsSchema.parse({
        ...structuredClone(sourceSettings),
        repositoryWorkspaceId: selected.allocationOperationId,
      });
      const scope = (settings: CollaborationSettings): TelosWorkDelegationScope =>
        structuredClone({ actor, intent: selected, settings });
      const assertCurrent = (settings: CollaborationSettings) => {
        signal.throwIfAborted();
        this.deps.work.assertDelegationAuthority(selected, actor);
        const attempt = this.deps.work.attemptForHost(selected.attemptId);
        if (
          !attempt ||
          attempt.childItemId !== selected.input.childItemId ||
          attempt.leadConversationId !== selected.input.leadConversationId ||
          attempt.contextSnapshotId !== selected.contextSnapshotId ||
          attempt.predecessorAttemptId !== selected.input.predecessorAttemptId ||
          attempt.requestId !== selected.input.requestId
        )
          throw new TelosWorkError('conflict', 'Retained delegation attempt changed');
        this.deps.assertBeforeApply(scope(settings));
      };
      const authorize = async (settings: CollaborationSettings) => {
        assertCurrent(settings);
        await this.deps.authorize(scope(settings), signal);
        assertCurrent(settings);
      };
      await authorize(sourceSettings);

      // The ordinary ledger is consulted before a resolver or workspace owner:
      // a lost response must recover its original session, even after restart.
      let receipt = this.deps.events.getOrdinarySessionPreparation(selected.allocationOperationId);
      if (!receipt) {
        if (retained.receipt)
          throw new TelosWorkError('conflict', 'Retained ordinary worker allocation unavailable');
        const sourcePreparation = structuredClone(
          await this.deps.resolvePreparation(scope(sourceSettings), signal),
        );
        await authorize(sourceSettings);
        await this.deps.workspaces.prepareDelegatedWorkspace({
          allocationOperationId: selected.allocationOperationId,
          sourceConversationId: selected.input.leadConversationId,
          settings: structuredClone(sourceSettings),
          binding: structuredClone(sourcePreparation.binding),
          signal,
        });
        await authorize(sourceSettings);
        await authorize(workerSettings);
        const preparation = structuredClone(
          await this.deps.resolvePreparation(scope(workerSettings), signal),
        );
        await authorize(workerSettings);
        receipt = (
          await this.deps.workspaces.prepareOrdinarySession(
            {
              ...preparation,
              allocationOperationId: selected.allocationOperationId,
              delegationAttemptId: selected.attemptId,
              id: workerSettings.repositoryWorkspaceId,
              settings: structuredClone(workerSettings),
              signal,
            },
            this.deps.events,
          )
        ).receipt;
        await authorize(workerSettings);
      } else {
        await authorize(workerSettings);
      }

      const workerConversationId = receipt.sessionId;
      const assertPreparation = () => {
        const current = this.deps.events.getOrdinarySessionPreparation(
          selected.allocationOperationId,
        );
        const session = this.deps.events.getSession(workerConversationId);
        if (
          !current ||
          !session?.accountBinding ||
          current.allocationOperationId !== selected.allocationOperationId ||
          current.sessionId !== workerConversationId ||
          current.delegationAttemptId !== selected.attemptId ||
          current.workspaceId !== workerSettings.repositoryWorkspaceId ||
          workerConversationId === selected.input.leadConversationId ||
          !isDeepStrictEqual(current.settings, workerSettings) ||
          session.accountBinding.accountId !== workerSettings.binding.account.accountId ||
          session.accountBinding.provider !== workerSettings.binding.account.provider ||
          session.accountBinding.profileRevision !==
            workerSettings.binding.account.profileRevision ||
          session.accountBinding.model !== workerSettings.selection.model
        )
          throw new TelosWorkError('conflict', 'Exact ordinary worker preparation required');
        if (retained.receipt && current.firstCommandId !== null) {
          // A committed allocation remains the same allocation after ordinary
          // future commands are queued, uncertain or failed. Navigation recovers
          // the original allocation identity independently of command outcomes
          // and the current model/thinking display; it grants no execution.
          const first = this.deps.events.getOrdinaryInitialCommandId(workerConversationId);
          const initial = this.deps.events.getOrdinaryCommandAdmission(current.firstCommandId);
          const send = this.deps.events.getSendCommand(current.firstCommandId);
          const latest = this.deps.events.getLatestOrdinaryCommandAdmission(workerConversationId);
          const profile = session.agentProfile;
          if (
            first !== current.firstCommandId ||
            !initial ||
            !send ||
            send.sessionId !== workerConversationId ||
            !isDeepStrictEqual(initial.binding, workerSettings.binding) ||
            !isDeepStrictEqual(initial.selection, workerSettings.selection) ||
            initial.workspace.workspaceId !== workerSettings.repositoryWorkspaceId ||
            initial.workspace.cwd !== session.cwd ||
            !isDeepStrictEqual(
              this.deps.events.getSessionRuntimeBinding(workerConversationId),
              workerSettings.binding,
            ) ||
            !latest ||
            !isDeepStrictEqual(latest.binding, initial.binding) ||
            !isDeepStrictEqual(latest.workspace, initial.workspace) ||
            !isDeepStrictEqual(latest.selection.agent, initial.selection.agent) ||
            !isDeepStrictEqual(latest.selection.context, initial.selection.context) ||
            !isDeepStrictEqual(latest.selection.permission, initial.selection.permission) ||
            session.mode !== initial.selection.permission.mode ||
            !profile ||
            profile.profileId !== initial.selection.agent.profileId ||
            profile.revision !== initial.selection.agent.revision ||
            profile.kind !== initial.selection.agent.kind ||
            profile.contentHash !==
              createHash('sha256').update(JSON.stringify(profile.definition)).digest('hex') ||
            profile.definition.contextRecipe !== undefined ||
            session.agentContext != null
          )
            throw new TelosWorkError(
              'conflict',
              'Original ordinary worker admission proof required',
            );
        } else {
          // An unfinished linkage cannot adopt metadata changed by another
          // command, and a zero-command receipt still requires exact startup.
          this.deps.events.assertPreparedOrdinarySession(
            selected.allocationOperationId,
            session,
            workerSettings.binding,
            workerSettings.selection,
          );
        }
        return session.accountBinding;
      };
      assertCurrent(workerSettings);
      const account = assertPreparation();
      retainTelosWorkRoleContext(
        this.deps.events,
        workerConversationId,
        account,
        selected.input.contextSelection,
      );
      const display = this.deps.work.rolePresentationForDelegation(selected, actor);
      if (display)
        retainTelosWorkRolePresentation(this.deps.events, workerConversationId, account, display);
      assertCurrent(workerSettings);
      await authorize(workerSettings);
      assertPreparation();
      if (
        !isDeepStrictEqual(
          resolveTelosWorkRoleContext(this.deps.events, workerConversationId, account),
          selected.input.contextSelection,
        )
      )
        throw new TelosWorkError('conflict', 'Retained worker context changed');

      const binding: TelosExecutionTaskBinding = {
        attemptId: selected.attemptId,
        childItemId: selected.input.childItemId,
        leadConversationId: selected.input.leadConversationId,
        workerConversationId,
        contextSnapshotId: selected.contextSnapshotId,
        contextHash: createHash('sha256')
          .update(JSON.stringify(selected.input.contextSelection))
          .digest('hex'),
      };
      const brief = selected.input.contextSelection.brief.text;
      let title = brief.trim().split('\n', 1)[0].slice(0, 200);
      try {
        const parsed: unknown = JSON.parse(brief);
        if (
          parsed &&
          typeof parsed === 'object' &&
          'summary' in parsed &&
          typeof parsed.summary === 'string' &&
          parsed.summary.trim()
        )
          title = parsed.summary.trim().slice(0, 200);
      } catch {
        // A retained plain-text brief is valid; its first line supplies the title.
      }
      assertCurrent(workerSettings);
      const task = this.deps.tasks.createOrRecoverTelosExecutionTask(
        { title: title || 'Work item', description: brief },
        binding,
      );
      const verify = () => {
        assertPreparation();
        const currentContext = resolveTelosWorkRoleContext(
          this.deps.events,
          workerConversationId,
          this.deps.events.getSession(workerConversationId)?.accountBinding ?? undefined,
        );
        return (
          isDeepStrictEqual(this.deps.tasks.getTelosExecutionBinding(task.id), binding) &&
          isDeepStrictEqual(currentContext, selected.input.contextSelection)
        );
      };
      return this.deps.work.completeDelegation(
        selected,
        actor,
        {
          workerConversationId,
          executionTaskId: task.id,
          workerDisplay: {
            title: title || 'Work item',
            profile:
              this.deps.events.getSession(workerConversationId)?.agentProfile?.definition.name ??
              'Worker',
            account: account.accountLabel,
            model: workerSettings.selection.model,
            thinking: workerSettings.selection.thinking,
            target:
              workerSettings.binding.execution.location === 'local' ? 'This Mac' : 'OpenShell',
          },
        },
        verify,
        () => assertCurrent(workerSettings),
      );
    } catch (error) {
      if (intent) this.deps.work.markDelegationUncertain(intent.attemptId);
      throw error;
    }
  }
}
