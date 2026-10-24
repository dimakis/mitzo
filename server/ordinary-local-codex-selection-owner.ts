import {
  OrdinaryLocalWorkspaceOwner,
  type LocalWorkspaceKind,
  type LocalWorkspaceCustodyOwner,
} from './ordinary-local-workspace-owner.js';
import { assertAgentToolRoute } from './agent-tool-selection.js';
import { assertOrdinaryCodexContextIdentity } from './ordinary-codex-agent-context.js';
import { resolveChatAgentContext } from './agent-context-binding.js';
import {
  PreparedRepositoryTransitionSchema,
  type PreparedRepositoryTransition,
  type AgentContextSnapshot,
} from '@mitzo/protocol';
import { createHash } from 'node:crypto';
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

interface PreparedPrimaryDelegation {
  childCommandId: string;
  transition: PreparedRepositoryTransition;
  workspace: LocalWorkspaceCustodyOwner<'repository'>;
  originalAdmission: ReturnType<EventStore['observePreparedRepositoryBootstrapAdmission']>;
  owners: { assertCurrentSync(): void; assertAdoptedSync(): void };
  assertBoundary: () => void;
  assertAdopted: () => void;
  previous?: PreparedPrimaryDelegation;
}

/** Current selection fence backed by the existing operator, published Library,
 * permission and repository owners. It does not confer host/login readiness.
 * Supported recipes retain the existing compiler's exact snapshot after the
 * original checkout is claimed; source grants never originate in a profile.
 */
export class OrdinaryLocalCodexSelectionOwner {
  readonly #reservation: Omit<HostRepositoryReservationInput, 'signal'>;
  readonly #workspace: LocalWorkspaceCustodyOwner;
  readonly #coldPrimary?: string;
  readonly #permission: symbol | undefined;
  #snapshot?: OrdinaryLocalCodexAdmissionExpectation;
  #context?: AgentContextSnapshot;
  #preparedPrimary?: PreparedPrimaryDelegation;
  /** Private delegation on this original selection owner, installed only after
   * native persisted the exact uncertain child and before repository custody CAS.
   * The repository callback must assert its actual persisted adoption witness;
   * neither a receipt nor a path is physical authority by itself. */
  preparePreparedRepositoryPrimary(
    expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
    childCommandId: string,
    raw: PreparedRepositoryTransition,
    workspace: LocalWorkspaceCustodyOwner<'repository'>,
    owners: { assertCurrentSync(): void; assertAdoptedSync(): void },
  ): void {
    this.assertCurrentSync(expected);
    const transition = PreparedRepositoryTransitionSchema.parse(raw);
    const child = this.owners.events.observePreparedRepositoryContinuation(childCommandId);
    if (
      this.owners.responses ||
      this.owners.vertex ||
      child.state !== 'uncertain' ||
      transition.priorPrimaryCommandId !==
        (this.#preparedPrimary?.childCommandId ?? this.#coldPrimary) ||
      !isDeepStrictEqual(child.preparedRepositoryTransition, transition) ||
      (this.#preparedPrimary
        ? !isDeepStrictEqual(
            this.#preparedPrimary.transition.newWorkspace.id,
            transition.oldWorkspace.id,
          ) ||
          this.#preparedPrimary.transition.newWorkspace.directory !==
            transition.oldWorkspace.directory ||
          this.owners.events.observePreparedRepositoryContinuation(
            this.#preparedPrimary.childCommandId,
          ).state !== 'consumed'
        : expected.workspace.workspaceId !== transition.oldWorkspace.id ||
          expected.workspace.cwd !== transition.oldWorkspace.directory)
    )
      throw unavailable();
    const assertBoundary = owners.assertCurrentSync,
      assertAdopted = owners.assertAdoptedSync;
    this.sync(Reflect.apply(assertBoundary, owners, []));
    if (owners.assertCurrentSync !== assertBoundary || owners.assertAdoptedSync !== assertAdopted)
      throw unavailable();
    const originalAdmission = this.observeBootstrap(childCommandId, this.owners.commandId);
    this.#preparedPrimary = {
      childCommandId,
      transition,
      workspace,
      originalAdmission,
      owners,
      assertBoundary,
      assertAdopted,
      previous: this.#preparedPrimary && { ...this.#preparedPrimary, previous: undefined },
    };
  }
  private observeBootstrap(childId: string, bootstrapId: string) {
    return this.#coldPrimary
      ? this.owners.events.observePreparedRepositoryColdBootstrapAdmission(
          childId,
          bootstrapId,
          this.#coldPrimary,
        )
      : this.owners.events.observePreparedRepositoryBootstrapAdmission(childId, bootstrapId);
  }
  private sync(result: unknown): void {
    if (result === undefined) return;
    void Promise.resolve(result).catch(() => {});
    throw unavailable();
  }
  private preparedPrimary(): PreparedPrimaryDelegation | undefined {
    const primary = this.#preparedPrimary;
    if (!primary) return undefined;
    if (
      primary.owners.assertCurrentSync !== primary.assertBoundary ||
      primary.owners.assertAdoptedSync !== primary.assertAdopted
    )
      throw unavailable();
    const child = this.owners.events.observePreparedRepositoryContinuation(primary.childCommandId);
    if (
      !isDeepStrictEqual(child.preparedRepositoryTransition, primary.transition) ||
      !isDeepStrictEqual(
        this.observeBootstrap(primary.childCommandId, this.owners.commandId),
        primary.originalAdmission,
      ) ||
      !['uncertain', 'consumed'].includes(child.state)
    )
      throw unavailable();
    const current = this.owners.workspace.getForConversation(this.#reservation.conversationId);
    if (
      current?.id === primary.transition.newWorkspace.id &&
      current.directory === primary.transition.newWorkspace.directory
    )
      return primary;
    if (child.state !== 'uncertain') throw unavailable();
    this.sync(Reflect.apply(primary.assertBoundary, primary.owners, []));
    if (
      primary.previous &&
      current?.id === primary.transition.oldWorkspace.id &&
      current.directory === primary.transition.oldWorkspace.directory
    )
      return primary.previous;
    if (
      !primary.previous &&
      (primary.transition.oldWorkspace.kind === 'ordinary'
        ? !current
        : current?.id === primary.transition.oldWorkspace.id &&
          current.directory === primary.transition.oldWorkspace.directory)
    )
      return undefined;
    throw unavailable();
  }
  private assertPreparedPrimary(
    expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
    p: PreparedPrimaryDelegation,
  ): void {
    if (
      p.owners.assertCurrentSync !== p.assertBoundary ||
      p.owners.assertAdoptedSync !== p.assertAdopted
    )
      throw unavailable();
    const child = this.owners.events.observePreparedRepositoryContinuation(p.childCommandId);
    const origin = this.observeBootstrap(p.childCommandId, this.owners.commandId);
    if (
      !isDeepStrictEqual(child.preparedRepositoryTransition, p.transition) ||
      !isDeepStrictEqual(origin, p.originalAdmission) ||
      expected.bootstrapId !==
        ordinaryLocalCodexBootstrapId(
          this.#reservation.conversationId,
          origin.requestFingerprint,
        ) ||
      !isDeepStrictEqual(origin.binding, expected.binding) ||
      !isDeepStrictEqual(origin.selection, expected.selection) ||
      !isDeepStrictEqual(origin.workspace, expected.workspace)
    )
      throw unavailable();
    this.sync(Reflect.apply(p.assertAdopted, p.owners, []));
    const session = this.owners.events.getSession(this.#reservation.conversationId);
    const old = p.transition.oldWorkspace,
      next = p.transition.newWorkspace;
    const oldMeta =
      session?.cwd === old.directory &&
      (old.kind === 'ordinary'
        ? session.ordinaryWorkspaceId === old.id && session.repositoryWorkspaceId == null
        : session.repositoryWorkspaceId === old.id && session.ordinaryWorkspaceId == null);
    const newMeta =
      session?.cwd === next.directory &&
      session.repositoryWorkspaceId === next.id &&
      session.ordinaryWorkspaceId == null;
    if (
      !session ||
      (!oldMeta && !newMeta) ||
      !['uncertain', 'consumed'].includes(child.state) ||
      (child.state === 'consumed' && !newMeta) ||
      session.mode !== expected.selection.permission.mode ||
      !isDeepStrictEqual(session.accountBinding, this.#reservation.binding) ||
      !isDeepStrictEqual(session.agentProfile, expected.agentProfile) ||
      !isDeepStrictEqual(session.agentContext ?? undefined, expected.agentContext ?? this.#context)
    )
      throw unavailable();
    if (child.state === 'uncertain') this.sync(Reflect.apply(p.assertBoundary, p.owners, []));
    p.workspace.assertCurrentSync(next.directory);
    const record = p.workspace.get();
    if (
      record.state !== 'claimed' ||
      record.featureBranch !== next.featureBranch ||
      createHash('sha256').update(JSON.stringify(record.taskIdentity)).digest('hex') !==
        next.taskIdentitySha256
    )
      throw unavailable();
  }

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
      /** Actual private cold runtime owner, independently joined to persisted
       * adoption/native custody. No receipt alone creates this workspace owner. */
      qualifiedColdPrimary?: Readonly<{
        commandId: string;
        workspace: LocalWorkspaceCustodyOwner<'repository'>;
      }>;
      preparationOperationId?: string;
      responses?: boolean;
      vertex?: boolean;
    },
  ) {
    this.#reservation = structuredClone(owners.reservation);
    if (
      owners.qualifiedColdPrimary &&
      (!owners.continuation ||
        owners.responses ||
        owners.vertex ||
        owners.workspaceKind === 'ordinary')
    )
      throw unavailable();
    this.#coldPrimary = owners.qualifiedColdPrimary?.commandId;
    this.#workspace =
      owners.qualifiedColdPrimary?.workspace ??
      new OrdinaryLocalWorkspaceOwner(
        owners.workspace,
        owners.workspaceKind ?? 'repository',
        this.#reservation,
      );
    this.#permission = permissionRevision(owners.events, this.#reservation.conversationId);
  }
  assertCurrentSync(input: Readonly<OrdinaryLocalCodexAdmissionExpectation>): void {
    try {
      this.owners.signal.throwIfAborted();
      if (
        this.owners.qualifiedColdPrimary?.commandId !== this.#coldPrimary ||
        (this.#coldPrimary && this.owners.qualifiedColdPrimary?.workspace !== this.#workspace)
      )
        throw unavailable();
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
      const primary = this.preparedPrimary();
      if (primary) {
        this.assertPreparedPrimary(expected, primary);
        return;
      }
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
      await (this.preparedPrimary()?.workspace ?? this.#workspace).revalidate(this.owners.signal);
      this.assertCurrentSync(expected);
    } catch {
      throw unavailable();
    }
  }
  async assertToolCurrent(
    expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>,
  ): Promise<void> {
    this.assertCurrentSync(expected);
    const primary = this.preparedPrimary();
    const workspace = primary?.workspace ?? this.#workspace;
    if (workspace.get().state === 'claimed')
      await workspace.validate(
        primary ? primary.transition.newWorkspace.directory : expected.workspace.cwd,
      );
    this.assertCurrentSync(expected);
  }
}
