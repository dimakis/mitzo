import { assertAgentToolRoute } from './agent-tool-selection.js';
import {
  OrdinaryWorkspaceSettingsSchema,
  TelosOrdinaryWorkDelegationInputSchema,
  type OrdinaryWorkspaceSettings,
  type TelosOrdinaryWorkDelegationInput,
  type TelosOrdinaryWorkDelegationIntent,
  type TelosWorkDelegationInput,
  type TelosWorkDelegationRequestIntent,
} from '@mitzo/protocol';
import type { LocalWorkspaceKind } from './ordinary-local-workspace-owner.js';
import type { TelosOrdinaryWorkSelection } from './telos-ordinary-work-role-setup.js';
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

type DelegationIntent<K extends LocalWorkspaceKind> = K extends 'ordinary'
  ? TelosOrdinaryWorkDelegationIntent
  : TelosWorkDelegationIntent;
type DelegationInput<K extends LocalWorkspaceKind> = K extends 'ordinary'
  ? TelosOrdinaryWorkDelegationInput
  : TelosWorkDelegationInput;
type DelegationSettings<K extends LocalWorkspaceKind> = K extends 'ordinary'
  ? OrdinaryWorkspaceSettings
  : CollaborationSettings;
export interface TelosWorkDelegationScope<K extends LocalWorkspaceKind = 'repository'> {
  actor: TelosWorkActor;
  intent: DelegationIntent<K>;
  /** Original lead selection or its exact independent worker workspace. */
  settings: DelegationSettings<K>;
}
type Preparation = Omit<
  Parameters<RepositoryWorkspaces['prepareOrdinarySession']>[0],
  'allocationOperationId' | 'id' | 'settings' | 'signal'
>;

/** Provision one exact ordinary worker and its pending Task Board mapping.
 * Durable ordinary preparation owns allocation/recovery. This owner has no
 * provider, command admission, queue, dispatch or assignment-changing port.
 */
export class TelosWorkDelegation<K extends LocalWorkspaceKind = 'repository'> {
  constructor(
    private readonly deps: {
      workspaceKind?: K;
      qualifyOrdinarySettings?(
        scope: { actor: TelosWorkActor; input: DelegationInput<K> },
        signal: AbortSignal,
      ): Promise<TelosOrdinaryWorkSelection>;
      work: TelosWorkStore;
      events: EventStore;
      tasks: TaskStore;
      workspaces: RepositoryWorkspaces;
      authorize(scope: TelosWorkDelegationScope<K>, signal: AbortSignal): Promise<void>;
      resolvePreparation(
        scope: TelosWorkDelegationScope<K>,
        signal: AbortSignal,
      ): Promise<Preparation>;
      /** Optional retained display capture; legacy direct owners keep their original behavior. */
      capturePresentation?(scope: TelosWorkDelegationScope<K>): TelosWorkRolePresentation;
      /** Synchronous authority/material denial fence, including final work commit. */
      assertBeforeApply(scope: TelosWorkDelegationScope<K>): void;
    },
  ) {}

  async delegate(
    rawActor: TelosWorkActor,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<TelosWorkDelegationReceipt> {
    const actor = structuredClone(rawActor);
    const ordinary = this.deps.workspaceKind === 'ordinary';
    const input = (
      ordinary ? TelosOrdinaryWorkDelegationInputSchema : TelosWorkDelegationInputSchema
    ).parse(structuredClone(raw)) as DelegationInput<K>;
    input.contextSelection = TelosWorkRoleContextSelectionSchema.parse(input.contextSelection);
    renderTelosWorkRoleContext(input.contextSelection);
    signal.throwIfAborted();
    if (ordinary) {
      if (!this.deps.qualifyOrdinarySettings)
        throw new TelosWorkError(
          'invalid',
          'Ordinary workspace selection qualification is unavailable',
        );
      const selected = structuredClone(
        await this.deps.qualifyOrdinarySettings(structuredClone({ actor, input }), signal),
      );
      assertAgentToolRoute(selected.agentProfile.definition, 'codex-owned-local');
      await this.deps.workspaces.qualifyOrdinaryWorkspace({
        ...selected,
        preparationId: OrdinaryWorkspaceSettingsSchema.parse(input.settings).workspace
          .preparationId,
        settings: OrdinaryWorkspaceSettingsSchema.parse(input.settings),
        signal,
      });
      signal.throwIfAborted();
    }
    let intent: DelegationIntent<K> | undefined;
    try {
      const prepare = ordinary
        ? this.deps.work.prepareOrdinaryDelegation.bind(this.deps.work)
        : this.deps.work.prepareDelegation.bind(this.deps.work);
      const retained = prepare(
        input,
        actor,
        (selected: TelosWorkDelegationRequestIntent) => {
          signal.throwIfAborted();
          this.deps.assertBeforeApply(
            structuredClone({
              actor,
              intent: selected,
              settings: selected.input.settings,
            }) as TelosWorkDelegationScope<K>,
          );
        },
        this.deps.capturePresentation
          ? (selected) =>
              this.deps.capturePresentation!(
                structuredClone({
                  actor,
                  intent: selected,
                  settings: selected.input.settings,
                }) as TelosWorkDelegationScope<K>,
              )
          : undefined,
      );
      intent = structuredClone(retained.intent) as DelegationIntent<K>;
      // A different default-start request may resolve to the existing attempt.
      // Every subsequent decision uses its canonical original selections.
      const selected = intent;
      const sourceSettings = (
        ordinary ? OrdinaryWorkspaceSettingsSchema : CollaborationSettingsSchema
      ).parse(selected.input.settings) as DelegationSettings<K>;
      const workerSettings = (
        ordinary
          ? OrdinaryWorkspaceSettingsSchema.parse(sourceSettings)
          : CollaborationSettingsSchema.parse({
              ...structuredClone(sourceSettings),
              repositoryWorkspaceId: selected.allocationOperationId,
            })
      ) as DelegationSettings<K>;
      const scope = (settings: DelegationSettings<K>): TelosWorkDelegationScope<K> =>
        structuredClone({ actor, intent: selected, settings });
      const assertCurrent = (settings: DelegationSettings<K>) => {
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
      const authorize = async (settings: DelegationSettings<K>) => {
        assertCurrent(settings);
        await this.deps.authorize(scope(settings), signal);
        assertCurrent(settings);
      };
      await authorize(sourceSettings);

      // The ordinary ledger is consulted before a resolver or workspace owner:
      // a lost response must recover its original session, even after restart.
      const getReceipt = () =>
        ordinary
          ? this.deps.events.getOrdinaryWorkspaceSessionPreparation(selected.allocationOperationId)
          : this.deps.events.getOrdinarySessionPreparation(selected.allocationOperationId);
      let receipt = getReceipt();
      if (!receipt) {
        if (retained.receipt)
          throw new TelosWorkError('conflict', 'Retained ordinary worker allocation unavailable');
        const sourcePreparation = structuredClone(
          await this.deps.resolvePreparation(scope(sourceSettings), signal),
        );
        await authorize(sourceSettings);
        if (ordinary) {
          const settings = OrdinaryWorkspaceSettingsSchema.parse(workerSettings);
          const reserved = await this.deps.workspaces.reserveOrdinaryWorkspace({
            ...sourcePreparation,
            allocationOperationId: selected.allocationOperationId,
            preparationId: settings.workspace.preparationId,
            settings,
            signal,
          });
          await authorize(workerSettings);
          receipt = this.deps.events.prepareOrdinaryWorkspaceSession(
            {
              sessionId: reserved.conversationId,
              ordinaryWorkspaceId: reserved.id,
              cwd: reserved.directory,
              accountBinding: sourcePreparation.binding,
              agentProfile: sourcePreparation.agentProfile,
              selectedModel: settings.selection.model,
              reasoningEffort: settings.selection.thinking,
              mode: settings.selection.permission.mode,
            },
            {
              allocationOperationId: selected.allocationOperationId,
              delegationAttemptId: selected.attemptId,
              preparationFingerprint: reserved.preparationFingerprint,
              settings,
            },
          );
        } else {
          await this.deps.workspaces.prepareDelegatedWorkspace({
            allocationOperationId: selected.allocationOperationId,
            sourceConversationId: selected.input.leadConversationId,
            settings: CollaborationSettingsSchema.parse(sourceSettings),
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
                id: CollaborationSettingsSchema.parse(workerSettings).repositoryWorkspaceId,
                settings: CollaborationSettingsSchema.parse(workerSettings),
                signal,
              },
              this.deps.events,
            )
          ).receipt;
        }
        await authorize(workerSettings);
      } else {
        await authorize(workerSettings);
      }

      const workerConversationId = receipt.sessionId;
      const workerWorkspaceId = ordinary
        ? receipt.workspaceId
        : CollaborationSettingsSchema.parse(workerSettings).repositoryWorkspaceId;
      const assertPreparation = () => {
        const current = getReceipt();
        const session = this.deps.events.getSession(workerConversationId);
        if (
          !current ||
          !session?.accountBinding ||
          current.allocationOperationId !== selected.allocationOperationId ||
          current.sessionId !== workerConversationId ||
          current.delegationAttemptId !== selected.attemptId ||
          current.workspaceId !== workerWorkspaceId ||
          workerConversationId === selected.input.leadConversationId ||
          !isDeepStrictEqual(current.settings, workerSettings) ||
          session.accountBinding.accountId !== workerSettings.binding.account.accountId ||
          session.accountBinding.provider !== workerSettings.binding.account.provider ||
          session.accountBinding.profileRevision !==
            workerSettings.binding.account.profileRevision ||
          session.accountBinding.model !== workerSettings.selection.model
        )
          throw new TelosWorkError('conflict', 'Exact ordinary worker preparation required');
        if (ordinary) {
          const record =
            this.deps.workspaces.getOrdinaryWorkspaceForConversation(workerConversationId);
          if (
            session.isHidden ||
            session.sessionType === 'symposium' ||
            session.conversationSource === 'external_import' ||
            session.ordinaryWorkspaceId !== workerWorkspaceId ||
            session.repositoryWorkspaceId != null ||
            !record ||
            record.id !== workerWorkspaceId ||
            record.allocationOperationId !== selected.allocationOperationId ||
            record.preparationFingerprint !== current.preparationFingerprint ||
            record.directory !== session.cwd ||
            !isDeepStrictEqual(record.settings, current.settings)
          )
            throw new TelosWorkError(
              'conflict',
              'Original available ordinary worker custody required',
            );
          if (record.state === 'claimed')
            this.deps.workspaces.validateOrdinaryWorkspace(workerConversationId, record.directory);
          else if (record.state !== 'reserved')
            throw new TelosWorkError('conflict', 'Ordinary worker workspace claim is uncertain');
        }
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
            initial.workspace.workspaceId !== workerWorkspaceId ||
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
          const assertPrepared = ordinary
            ? this.deps.events.assertPreparedOrdinaryWorkspaceSession.bind(this.deps.events)
            : this.deps.events.assertPreparedOrdinarySession.bind(this.deps.events);
          assertPrepared(
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
