import {
  OrdinaryLocalWorkspaceOwner,
  type LocalWorkspaceKind,
} from './ordinary-local-workspace-owner.js';
import { assertAgentToolRoute } from './agent-tool-selection.js';
import { assertOrdinaryCodexContextIdentity } from './ordinary-codex-agent-context.js';
import { resolveChatAgentContext } from './agent-context-binding.js';
import type { AgentContextSnapshot } from '@mitzo/protocol';
import { readOrdinaryCodexAgentProfile } from './ordinary-codex-agent-profile.js';
import { isDeepStrictEqual } from 'node:util';
import type { AgentLibraryStore } from './agent-library-store.js';
import type { EventStore } from './event-store.js';
import type {
  HostRepositoryReservationInput,
  RepositoryWorkspaces,
} from './repository-workspaces.js';
import { permissionRevision } from './session-permission-revision.js';
import {
  ordinaryLocalCodexBootstrapId,
  type OrdinaryLocalCodexAdmissionExpectation,
} from './ordinary-local-codex-admission.js';

const unavailable = () => new Error('Ordinary local Codex selection unavailable');

/** Current selection fence backed by the existing operator, published Library,
 * permission and repository owners. It does not confer host/login readiness.
 * Supported recipes retain the existing compiler's exact snapshot after the
 * original checkout is claimed; source grants never originate in a profile.
 */
export class OrdinaryLocalCodexSelectionOwner {
  readonly #reservation: Omit<HostRepositoryReservationInput, 'signal'>;
  readonly #workspace: OrdinaryLocalWorkspaceOwner<LocalWorkspaceKind>;
  readonly #permission: symbol | undefined;
  #snapshot?: OrdinaryLocalCodexAdmissionExpectation;
  #context?: AgentContextSnapshot;
  constructor(
    private readonly owners: {
      events: EventStore;
      library: AgentLibraryStore;
      workspace: RepositoryWorkspaces;
      workspaceKind?: LocalWorkspaceKind;
      reservation: Omit<HostRepositoryReservationInput, 'signal'>;
      /** Captured from authenticated transport by captureAgentLibraryAuthorization. */
      operator: { assertCurrent(): void };
      signal: AbortSignal;
      commandId: string;
      /** Cold owner independently verified original native custody before construction. */
      continuation?: boolean;
      preparationOperationId?: string;
      responses?: boolean;
      vertex?: boolean;
    },
  ) {
    this.#reservation = structuredClone(owners.reservation);
    this.#workspace = new OrdinaryLocalWorkspaceOwner(
      owners.workspace,
      owners.workspaceKind ?? 'repository',
      this.#reservation,
    );
    this.#permission = permissionRevision(owners.events, this.#reservation.conversationId);
  }
  assertCurrentSync(input: Readonly<OrdinaryLocalCodexAdmissionExpectation>): void {
    try {
      this.owners.signal.throwIfAborted();
      this.owners.operator.assertCurrent();
      const expected = structuredClone(input),
        reservation = this.#reservation;
      const identity = { ...expected, agentContext: undefined };
      if (this.#snapshot && !isDeepStrictEqual(identity, this.#snapshot)) throw unavailable();
      assertAgentToolRoute(
        expected.agentProfile?.definition,
        this.owners.responses
          ? 'local-api'
          : this.owners.vertex
            ? 'claude-sdk'
            : 'codex-owned-local',
      );
      assertOrdinaryCodexContextIdentity(
        expected.agentProfile,
        expected.selection,
        expected.agentContext ?? this.#context,
      );
      if (
        expected.agentContext &&
        this.#context &&
        !isDeepStrictEqual(expected.agentContext, this.#context)
      )
        throw unavailable();
      if (
        expected.selection.permission.revision !== 0 ||
        permissionRevision(this.owners.events, reservation.conversationId) !== this.#permission ||
        expected.workspace.workspaceId !== reservation.id ||
        expected.binding.account.accountId !== reservation.binding.accountId ||
        expected.binding.account.provider !== reservation.binding.provider ||
        expected.binding.account.profileRevision !== reservation.binding.profileRevision ||
        (!this.owners.continuation && expected.selection.model !== reservation.binding.model)
      )
        throw unavailable();
      const published = readOrdinaryCodexAgentProfile(
        this.owners.library,
        expected.selection.agent,
      );
      if (!published || !isDeepStrictEqual(published, expected.agentProfile)) throw unavailable();
      this.#workspace.assertCurrentSync(expected.workspace.cwd);
      const session = this.owners.events.getSession(reservation.conversationId);
      if (session) {
        const admission = this.owners.vertex
          ? this.owners.events.getOrdinaryLocalVertexCommandAdmission(this.owners.commandId)
          : this.owners.responses
            ? this.owners.events.getOrdinaryLocalResponsesCommandAdmission(this.owners.commandId)
            : this.owners.events.getOrdinaryLocalCommandAdmission(this.owners.commandId);
        let prepared = false;
        if (!admission && this.owners.preparationOperationId) {
          const receipt = (
            this.owners.workspaceKind === 'ordinary'
              ? this.owners.events.assertPreparedOrdinaryWorkspaceSession.bind(this.owners.events)
              : this.owners.events.assertPreparedOrdinarySession.bind(this.owners.events)
          )(
            this.owners.preparationOperationId,
            {
              sessionId: reservation.conversationId,
              ...(this.owners.workspaceKind === 'ordinary'
                ? { ordinaryWorkspaceId: reservation.id }
                : { repositoryWorkspaceId: reservation.id }),
              cwd: expected.workspace.cwd,
              accountBinding: reservation.binding,
              agentProfile: expected.agentProfile,
              agentContext: expected.agentContext,
              selectedModel: expected.selection.model,
              reasoningEffort: expected.selection.thinking,
              mode: expected.selection.permission.mode,
            },
            expected.binding,
            expected.selection,
          );
          prepared =
            receipt.firstCommandId === null &&
            receipt.preparationFingerprint === reservation.commandFingerprint;
        }
        if (
          (!admission && !this.owners.continuation && !prepared) ||
          admission?.state === 'reserved' ||
          (admission &&
            (!isDeepStrictEqual(admission.binding, expected.binding) ||
              !isDeepStrictEqual(admission.selection, expected.selection) ||
              !isDeepStrictEqual(admission.workspace, expected.workspace) ||
              (!this.owners.responses &&
                !this.owners.vertex &&
                expected.bootstrapId !==
                  ordinaryLocalCodexBootstrapId(
                    reservation.conversationId,
                    admission.requestFingerprint,
                  )))) ||
          session.mode !== expected.selection.permission.mode ||
          !isDeepStrictEqual(session.accountBinding, reservation.binding) ||
          !isDeepStrictEqual(session.agentProfile, expected.agentProfile)
        )
          throw unavailable();
        // An exact first-command retry keeps its original unprepared fingerprint.
        // Adopt only the saved compiler snapshot under the already verified
        // original receipt, profile, operator and claimed workspace authority.
        if (
          !expected.agentContext &&
          !this.#context &&
          session.agentContext &&
          admission &&
          ['uncertain', 'consumed'].includes(admission.state)
        ) {
          assertOrdinaryCodexContextIdentity(
            expected.agentProfile,
            expected.selection,
            session.agentContext,
          );
          this.#context = structuredClone(session.agentContext);
        }
        if (
          !isDeepStrictEqual(
            session.agentContext ?? undefined,
            expected.agentContext ?? this.#context,
          )
        )
          throw unavailable();
      }
      this.#snapshot ??= identity;
    } catch {
      throw unavailable();
    }
  }
  /** Only after the original checkout is claimed, under the uncertain command's lease. */
  async prepareContext(
    expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
    resume: boolean,
  ): Promise<AgentContextSnapshot | undefined> {
    this.#context ??= expected.agentContext && structuredClone(expected.agentContext);
    this.assertCurrentSync(expected);
    const saved = this.owners.events.getSession(this.#reservation.conversationId)?.agentContext;
    if (resume && expected.agentProfile?.definition.contextRecipe && !saved) throw unavailable();
    const context = await resolveChatAgentContext({
      profile: expected.agentProfile,
      stored: saved,
      workspaceRoot: expected.workspace.cwd,
      signal: this.owners.signal,
    });
    this.assertCurrentSync(expected);
    if (context) {
      assertOrdinaryCodexContextIdentity(expected.agentProfile, expected.selection, context);
      if (this.#context && !isDeepStrictEqual(this.#context, context)) throw unavailable();
      this.#context = structuredClone(context);
      this.owners.events.upsertSession({
        sessionId: this.#reservation.conversationId,
        agentContext: context,
      });
    }
    this.assertCurrentSync({ ...expected, agentContext: context });
    return context;
  }
  async assertCurrent(expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>): Promise<void> {
    this.assertCurrentSync(expected);
    try {
      await this.#workspace.revalidate(this.owners.signal);
      this.assertCurrentSync(expected);
    } catch {
      throw unavailable();
    }
  }
  async assertToolCurrent(
    expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
  ): Promise<void> {
    this.assertCurrentSync(expected);
    if (this.#workspace.get().state === 'claimed')
      await this.#workspace.validate(expected.workspace.cwd);
    this.assertCurrentSync(expected);
  }
}
