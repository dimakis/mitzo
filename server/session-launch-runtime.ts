import { isDeepStrictEqual } from 'node:util';
import { createOrdinaryFreshPermission, type SessionLaunchConfig } from '@mitzo/protocol';
import type { SessionLaunchAuthority, SessionLaunchPort } from './session-launch-service.js';
import { SessionLaunchError, type RetainedSessionLaunch } from './session-launch-store.js';
import type { EventStore } from './event-store.js';

function assertLaunchChildAdmissible(events: EventStore, id: string) {
  if (events.getSession(id)?.isHidden)
    throw new SessionLaunchError(
      'This child chat is hidden. Preserve its original startup instead of reopening it.',
    );
  events.removals.assertAdmissible(id);
}

/** Reuse the same owned ordinary Local Mac Codex admission as New chat and
 * native advisers. No model/provider client or permission grant is created here. */
export function createSessionLaunchPort(): SessionLaunchPort {
  async function qualify(config: SessionLaunchConfig, authority: SessionLaunchAuthority) {
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    if (config.runtime.execution.location !== 'local')
      throw new SessionLaunchError('Agent-created sessions currently require Local Mac.');
    if (!config.isolation || config.repositoryWorkspaceId !== null)
      throw new SessionLaunchError(
        'Choose an independent ordinary workspace. Repository session launching is not available yet.',
      );
    if (config.contextBlocks.length || config.extraTools.length)
      throw new SessionLaunchError(
        'Selected context blocks or additional tools are not supported for agent-created sessions yet.',
      );
    const account = config.runtime.account;
    const agent = config.runtime.agentProfile;
    const targetId = config.runtime.execution.targetId;
    if (!account || !agent || !targetId)
      throw new SessionLaunchError(
        'Choose an account, agent profile and Local Mac host before starting.',
      );
    const { captureAgentLibraryAuthorization } = await import('./agent-library-transport.js');
    const captured = captureAgentLibraryAuthorization(authority.operatorConnectionId);
    captured.assertCurrent();
    if (captured.auth.id !== authority.authSessionId)
      throw new SessionLaunchError('Original operator required.', 403);
    const { loadAccountProfiles } = await import('./account-profiles.js');
    const profiles = loadAccountProfiles();
    const binding = profiles.resolve(account.accountId, account.model);
    if (binding.provider !== 'openai-codex')
      throw new SessionLaunchError('Choose a Local Mac Codex account.');
    const reference = {
      accountId: binding.accountId,
      provider: 'openai-codex' as const,
      profileRevision: binding.profileRevision,
    };
    if (
      !config.runtime.accountReference ||
      !isDeepStrictEqual(reference, config.runtime.accountReference)
    )
      throw new SessionLaunchError(
        'The saved account identity changed or is missing. Review and save the account again.',
      );
    profiles.validateModelSelection(binding, account.model, account.reasoningEffort ?? undefined);
    const { ordinaryRepositoryRuntimeInventory } = await import('./ordinary-local-codex-entry.js');
    const inventory = ordinaryRepositoryRuntimeInventory('local', 'codex');
    const runtime = { account: reference, harness: 'codex' as const, targetId, mode: config.mode };
    const resolution = inventory.catalog.resolve(runtime);
    const route = inventory.result.routes.find(
      (candidate) =>
        candidate.targetId === targetId &&
        candidate.harness === 'codex' &&
        isDeepStrictEqual(candidate.account, reference) &&
        candidate.modes.some((mode) => mode === config.mode),
    );
    const selectedAccount = inventory.result.accounts.find((candidate) =>
      isDeepStrictEqual(candidate.account, reference),
    );
    const model = selectedAccount?.models.find((candidate) => candidate.id === account.model);
    if (
      resolution.status !== 'compatible' ||
      !route ||
      !selectedAccount ||
      selectedAccount.modelDiscovery.stale ||
      !model ||
      (account.reasoningEffort == null
        ? !!model.reasoningEfforts?.length
        : !model.reasoningEfforts?.includes(account.reasoningEffort))
    )
      throw new SessionLaunchError(
        'The selected account, host, model, thinking or permission mode is unavailable.',
      );
    const { getAgentLibrary } = await import('./agent-library-runtime.js');
    const { readOrdinaryCodexAgentProfile, ordinaryCodexAgentProfileRouteProjection } =
      await import('./ordinary-codex-agent-profile.js');
    const profile = readOrdinaryCodexAgentProfile(getAgentLibrary(), agent);
    if (
      !profile ||
      profile.definition.contextRecipe ||
      ordinaryCodexAgentProfileRouteProjection([profile], binding.provider, 'local', undefined, {
        contextRecipes: 'none',
        toolSelection: true,
        toolRoute: 'codex-owned-local',
      }).agentProfileRejections.length
    )
      throw new SessionLaunchError(
        'The selected agent revision or its context is unavailable for an ordinary Local Mac session.',
      );
    const selection = {
      version: 1 as const,
      agent,
      context: { source: 'none' as const, revision: null },
      permission: createOrdinaryFreshPermission(config.mode),
      model: account.model,
      thinking: account.reasoningEffort ?? null,
    };
    authority.assertCurrent();
    captured.assertCurrent();
    return { binding, runtime, selection, profile, inventory, runtimeBinding: resolution.binding };
  }
  async function assertResumeAbsent(
    record: RetainedSessionLaunch,
    authority: SessionLaunchAuthority,
  ) {
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    if (!record.allocationId || !record.commandId)
      throw new SessionLaunchError('Original startup operation required.');
    const { eventStore, registry } = await import('./chat.js');
    const { getOrdinaryWorkspaces } = await import('./repository-workspace-runtime.js');
    const workspace = getOrdinaryWorkspaces(true).getOrdinaryWorkspaceForOperation(
      record.allocationId,
    );
    const preparation = eventStore.getOrdinaryWorkspaceSessionPreparation(record.allocationId);
    if (!workspace && (preparation || record.childSessionId))
      throw new SessionLaunchError(
        'Original workspace ownership is unavailable. Preserve this startup and recover its existing child.',
      );
    if (workspace && preparation && workspace.conversationId !== preparation.sessionId)
      throw new SessionLaunchError('Original workspace identity changed.');
    const child = workspace?.conversationId ?? preparation?.sessionId ?? record.childSessionId;
    if (child) {
      assertLaunchChildAdmissible(eventStore, child);
      if (registry.findBySessionId(child))
        throw new SessionLaunchError('The child startup is still active. Open its chat.');
      const { getCodexConversationStore } = await import('./codex-chat-session.js');
      // Presence is intentionally stricter than a missing ACK: even an empty
      // retained native conversation belongs to ordinary runtime recovery.
      if (getCodexConversationStore().hasConversation(child))
        throw new SessionLaunchError(
          'This child already has native execution history. Open its existing chat to recover it.',
        );
    }
    if (eventStore.getSendCommand(record.commandId))
      throw new SessionLaunchError(
        'An admitted command already exists. Open the existing child chat to recover it.',
      );
    authority.assertCurrent();
    authority.signal.throwIfAborted();
  }
  async function launch(
    record: RetainedSessionLaunch,
    authority: SessionLaunchAuthority,
    onPrepared: (childSessionId: string, preparationId: string) => void,
    recover = false,
  ) {
    if (!record.allocationId || !record.commandId)
      throw new SessionLaunchError('Frozen launch operation required.');
    const selected = await qualify(record.configuration, authority);
    const { getOrdinaryWorkspaces } = await import('./repository-workspace-runtime.js');
    const { ordinaryWorkspaceTaskRoot } = await import('./ordinary-workspace-runtime.js');
    const { eventStore } = await import('./chat.js');
    const retainedPreparation = eventStore.getOrdinaryWorkspaceSessionPreparation(
      record.allocationId,
    );
    const retainedChild = record.childSessionId ?? retainedPreparation?.sessionId;
    if (retainedChild) assertLaunchChildAdmissible(eventStore, retainedChild);
    const workspaces = getOrdinaryWorkspaces();
    let workspace = recover
      ? workspaces.getOrdinaryWorkspaceForOperation(record.allocationId)
      : undefined;
    if (
      recover &&
      !workspace &&
      (record.childSessionId ||
        eventStore.getOrdinaryWorkspaceSessionPreparation(record.allocationId))
    )
      throw new SessionLaunchError(
        'Original workspace ownership is unavailable. A replacement workspace cannot be allocated.',
      );
    if (workspace) {
      assertLaunchChildAdmissible(eventStore, workspace.conversationId);
      if (
        !isDeepStrictEqual(workspace.binding, selected.binding) ||
        !isDeepStrictEqual(workspace.settings.binding, selected.runtimeBinding) ||
        !isDeepStrictEqual(workspace.settings.selection, selected.selection) ||
        !isDeepStrictEqual(workspace.agentProfile, selected.profile)
      )
        throw new SessionLaunchError('Original approved workspace settings changed.');
      await workspaces.revalidateOrdinaryWorkspace({
        id: workspace.id,
        conversationId: workspace.conversationId,
        binding: selected.binding,
        taskRoot: workspace.hostReservation.taskRoot,
        signal: authority.signal,
      });
    } else {
      const prepared = await workspaces.prepareOrdinaryWorkspace({
        binding: selected.binding,
        selection: {
          runOn: 'local',
          runtime: {
            account: selected.runtime.account,
            harness: 'codex',
            targetId: selected.runtime.targetId,
          },
        },
        signal: authority.signal,
      });
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      if (!isDeepStrictEqual(prepared.runtimeBinding, selected.runtimeBinding))
        throw new SessionLaunchError('Selected runtime changed.');
      workspace = await workspaces.reserveOrdinaryWorkspace({
        preparationId: prepared.preparationId,
        allocationOperationId: record.allocationId,
        binding: selected.binding,
        agentProfile: selected.profile,
        taskRoot: ordinaryWorkspaceTaskRoot(true),
        settings: {
          version: 2,
          binding: prepared.runtimeBinding,
          selection: selected.selection,
          workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
        },
        signal: authority.signal,
      });
    }
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    assertLaunchChildAdmissible(eventStore, workspace.conversationId);
    eventStore.prepareOrdinaryWorkspaceSession(
      {
        sessionId: workspace.conversationId,
        ordinaryWorkspaceId: workspace.id,
        cwd: workspace.directory,
        accountBinding: selected.binding,
        agentProfile: selected.profile,
        selectedModel: selected.selection.model,
        reasoningEffort: selected.selection.thinking,
        mode: record.configuration.mode,
      },
      {
        allocationOperationId: record.allocationId,
        preparationFingerprint: workspace.preparationFingerprint,
        settings: workspace.settings,
      },
    );
    eventStore.upsertSession({ sessionId: workspace.conversationId, summary: record.title });
    eventStore.markManuallyRenamed(workspace.conversationId);
    onPrepared(workspace.conversationId, workspace.preparationId);
    const { dispatchOwnedOrdinaryCommand } = await import('./ordinary-scoped-command.js');
    const { NullTransport } = await import('./null-transport.js');
    const { retainedNativeHostToolOperator } = await import('./native-host-tool-operator.js');
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    await dispatchOwnedOrdinaryCommand({
      transport: new NullTransport(),
      clientId: `session-launch:${record.proposalId}`,
      sessionId: workspace.conversationId,
      commandId: record.commandId,
      command: {
        clientMsgId: record.commandId,
        capabilityRevision: selected.inventory.result.capabilityRevision,
        runtime: selected.runtime,
        selection: selected.selection,
        payload: { text: record.prompt },
      },
      reservation: {
        id: workspace.id,
        binding: selected.binding,
        conversationId: workspace.conversationId,
        taskRoot: workspace.hostReservation.taskRoot,
        runtimeBinding: workspace.settings.binding,
        commandFingerprint: workspace.preparationFingerprint,
      },
      operatorConnectionId: authority.operatorConnectionId,
      ownerAuthSessionId: authority.authSessionId,
      signal: authority.signal,
      continuation: false,
      existingOwner: false,
      workspaceKind: 'ordinary',
      preparationOperationId: record.allocationId,
      onSessionPrepared(session) {
        // chat's owning startup has already retained this login separately
        // from the one-request UI binding. Every ordinary tool adapter needs
        // that same durable identity after the approve response finishes.
        const retainedOperator = retainedNativeHostToolOperator(session);
        if (!retainedOperator)
          throw new SessionLaunchError('Retained session operator unavailable.');
        session.ownerConnectionId = retainedOperator;
      },
    });
  }
  return {
    async validate(config, authority) {
      await qualify(config, authority);
    },
    start: launch,
    canResume: assertResumeAbsent,
    async resume(record, authority, onPrepared) {
      await assertResumeAbsent(record, authority);
      return launch(record, authority, onPrepared, true);
    },
    async inspect(record, authority) {
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      const { eventStore, registry } = await import('./chat.js');
      if (!record.allocationId || !record.commandId) return { accepted: false };
      const prepared = eventStore.getOrdinaryWorkspaceSessionPreparation(record.allocationId);
      if (!prepared) {
        const { getOrdinaryWorkspaces } = await import('./repository-workspace-runtime.js');
        // Workspace reservation may have committed before the session metadata.
        // Reading that owner never allocates/retries or grants a provider turn.
        const reservation = getOrdinaryWorkspaces(true).getOrdinaryWorkspaceForOperation(
          record.allocationId,
        );
        authority.assertCurrent();
        authority.signal.throwIfAborted();
        return { accepted: false, uncertain: Boolean(reservation) || record.state === 'starting' };
      }
      const command = eventStore.getSendCommand(record.commandId);
      const admission = eventStore.getOrdinaryCommandAdmission(record.commandId);
      const { getCodexConversationStore } = await import('./codex-chat-session.js');
      const meta = eventStore.getSession(prepared.sessionId);
      const native = getCodexConversationStore();
      const retainedCommand =
        meta?.accountBinding && native.hasConversation(prepared.sessionId)
          ? native
              .commands(prepared.sessionId, meta.accountBinding)
              .find((candidate) => candidate.id === record.commandId)
          : undefined;
      // Ordinary assembly may expand a /skill into provider prompt text. Its
      // original intent and exact command ID still fence the reviewed launch.
      const acknowledged =
        meta?.accountBinding &&
        retainedCommand &&
        (retainedCommand.intent ?? retainedCommand.prompt) === record.prompt &&
        retainedCommand.model === record.configuration.runtime.account?.model &&
        (retainedCommand.reasoningEffort ?? null) ===
          (record.configuration.runtime.account?.reasoningEffort ?? null)
          ? native.acceptedProviderTurnForCommand(
              prepared.sessionId,
              meta.accountBinding,
              record.commandId,
            )
          : undefined;
      return {
        accepted:
          command?.sessionId === prepared.sessionId &&
          admission?.state === 'consumed' &&
          Boolean(acknowledged),
        uncertain: !acknowledged && !registry.findBySessionId(prepared.sessionId),
        childSessionId: prepared.sessionId,
        preparationId: prepared.settings.workspace.preparationId,
      };
    },
  };
}
