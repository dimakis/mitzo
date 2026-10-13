import { assertOrdinaryCodexContextIdentity } from './ordinary-codex-agent-context.js';
import { resolveChatAgentContext } from './agent-context-binding.js';
import type { AgentContextSnapshot } from '@mitzo/protocol';
import { readOrdinaryCodexAgentProfile } from './ordinary-codex-agent-profile.js';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
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
  readonly #permission: symbol | undefined;
  #snapshot?: OrdinaryLocalCodexAdmissionExpectation;
  #context?: AgentContextSnapshot;
  constructor(
    private readonly owners: {
      events: EventStore;
      library: AgentLibraryStore;
      workspace: RepositoryWorkspaces;
      reservation: Omit<HostRepositoryReservationInput, 'signal'>;
      /** Captured from authenticated transport by captureAgentLibraryAuthorization. */
      operator: { assertCurrent(): void };
      signal: AbortSignal;
      commandId: string;
      /** Cold owner independently verified original native custody before construction. */
      continuation?: boolean;
      responses?: boolean;
    },
  ) {
    this.#reservation = structuredClone(owners.reservation);
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
      const descriptor = this.owners.workspace.getHostReservation(reservation);
      if (
        !isDeepStrictEqual(descriptor.binding, reservation.binding) ||
        descriptor.conversationId !== reservation.conversationId ||
        descriptor.id !== reservation.id ||
        descriptor.directory !== expected.workspace.cwd ||
        descriptor.hostReservation.taskRoot !== reservation.taskRoot ||
        !['reserved', 'claimed'].includes(descriptor.state)
      )
        throw unavailable();
      const root = lstatSync(reservation.taskRoot);
      if (
        !root.isDirectory() ||
        root.isSymbolicLink() ||
        realpathSync(reservation.taskRoot) !== reservation.taskRoot ||
        root.dev !== descriptor.hostReservation.rootIdentity.dev ||
        root.ino !== descriptor.hostReservation.rootIdentity.ino
      )
        throw unavailable();
      if (descriptor.state === 'claimed') {
        // The existing repository ledger owns the materialized checkout identity.
        // Do not accept another directory merely because its reservation path matches.
        const claimed = this.owners.workspace.getForConversation(reservation.conversationId);
        const identity = claimed?.taskIdentity;
        if (
          !claimed ||
          claimed.id !== descriptor.id ||
          claimed.conversationId !== descriptor.conversationId ||
          claimed.directory !== descriptor.directory ||
          claimed.sandbox ||
          !isDeepStrictEqual(claimed.binding, reservation.binding) ||
          claimed.featureBranch !== descriptor.featureBranch ||
          !identity ||
          identity.directory !== descriptor.directory ||
          identity.featureBranch !== claimed.featureBranch
        )
          throw unavailable();
        for (const [path, retained] of [
          [identity.directory, identity.root],
          [join(identity.directory, '.git'), identity.git],
        ] as const) {
          const current = lstatSync(path);
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            realpathSync(path) !== path ||
            current.dev !== retained.dev ||
            current.ino !== retained.ino
          )
            throw unavailable();
        }
      }
      const session = this.owners.events.getSession(reservation.conversationId);
      if (session) {
        const admission = this.owners.responses
          ? this.owners.events.getOrdinaryLocalResponsesCommandAdmission(this.owners.commandId)
          : this.owners.events.getOrdinaryLocalCommandAdmission(this.owners.commandId);
        if (
          (!admission && !this.owners.continuation) ||
          admission?.state === 'reserved' ||
          (admission &&
            (!isDeepStrictEqual(admission.binding, expected.binding) ||
              !isDeepStrictEqual(admission.selection, expected.selection) ||
              !isDeepStrictEqual(admission.workspace, expected.workspace) ||
              (!this.owners.responses &&
                expected.bootstrapId !==
                  ordinaryLocalCodexBootstrapId(
                    reservation.conversationId,
                    admission.requestFingerprint,
                  )))) ||
          session.mode !== expected.selection.permission.mode ||
          !isDeepStrictEqual(session.accountBinding, reservation.binding) ||
          !isDeepStrictEqual(session.agentProfile, expected.agentProfile) ||
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
      // Revalidate the existing reservation's account/GitHub/source authority;
      // the precheck forbids this method from making a new reservation.
      await this.owners.workspace.reserveHostTask({
        ...structuredClone(this.#reservation),
        signal: this.owners.signal,
      });
      this.assertCurrentSync(expected);
      if (this.owners.workspace.getHostReservation(this.#reservation).state === 'claimed') {
        await this.owners.workspace.validateHostTask(
          this.#reservation.conversationId,
          expected.workspace.cwd,
        );
        this.assertCurrentSync(expected);
      }
    } catch {
      throw unavailable();
    }
  }
}
