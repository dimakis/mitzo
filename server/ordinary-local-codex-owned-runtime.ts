import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { AgentLibraryStore } from './agent-library-store.js';
import type { EventStore } from './event-store.js';
import type {
  HostRepositoryReservationInput,
  RepositoryWorkspace,
  RepositoryWorkspaces,
} from './repository-workspaces.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { retainAgentContextAuthority } from './agent-context-authority.js';
import { buildAgentProfilePrompt } from './agent-library-prompt.js';
import { loadAccountProfiles } from './account-profiles.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';
import { OrdinaryLocalCodexCapabilityCatalog } from './ordinary-local-codex-capabilities.js';
import { OrdinaryLocalCodexHostRuntime } from './ordinary-local-codex-host-runtime.js';
import { OrdinaryLocalCodexSelectionOwner } from './ordinary-local-codex-selection-owner.js';
import {
  OrdinaryLocalCodexAdmissionCoordinator,
  OrdinaryLocalCodexCommandRequestSchema,
  type OrdinaryLocalCodexAdmissionExpectation,
} from './ordinary-local-codex-admission.js';
import {
  FrozenHostCodexBootstrapAuthority,
  type FrozenHostCodexBootstrapLease,
} from './frozen-host-codex-bootstrap.js';
import { OwnedCodexLifecycleBridge } from './owned-codex-lifecycle-bridge.js';
import { OwnedLocalCodexChatAdmission } from './owned-local-codex-chat-admission.js';
import type { FrozenHostCodexClient } from './frozen-host-codex-login.js';
import type { FrozenHostCodexExecutable } from './frozen-host-codex-executable.js';

const unavailable = () => new Error('Owned local Codex runtime unavailable');
const RawPayload = z.strictObject({
  text: z.string().min(1).max(1_000_000),
  intent: z.string().max(1_000_000).optional(),
  images: z
    .array(z.strictObject({ data: z.string().min(1), mediaType: z.string().min(1).max(128) }))
    .max(16)
    .optional(),
});
type Payload = z.infer<typeof RawPayload> & { systemPrompt: string };
export interface OrdinaryLocalCodexOwnedDispatch {
  admission: OwnedLocalCodexChatAdmission;
  lease: FrozenHostCodexBootstrapLease;
  profile: FrozenHostCodexBootstrapLease['profile'];
  expected: Readonly<OrdinaryLocalCodexAdmissionExpectation>;
  workspace: RepositoryWorkspace;
  payload: Payload;
  sessionId: string;
  commandId: string;
}
interface Owners {
  enabled: boolean;
  eventStore: EventStore;
  library: AgentLibraryStore;
  workspace: RepositoryWorkspaces;
  reservation: Omit<HostRepositoryReservationInput, 'signal'>;
  commandId: string;
  /** Middleware-authenticated connection captured once, never supplied by request JSON. */
  operatorConnectionId: string;
  signal: AbortSignal;
  env?: Readonly<NodeJS.ProcessEnv>;
  privateRoot?: string;
  /** Only native transport creation is replaceable for offline qualification. */
  launch?: (privateHome: string, executable: FrozenHostCodexExecutable) => FrozenHostCodexClient;
  /** Existing chat/conversation owner opens/enqueues the exact first command
   * while the receipt is uncertain. Retain its prepared event-loop handle here;
   * pump that handle only after admit returns dispatched:true (consumed), so
   * fast turn completion cannot dispose the lease before coordinator completion.
   */
  dispatch(input: OrdinaryLocalCodexOwnedDispatch): Promise<void>;
}

/** Server-internal composition for one reserved local first command. No endpoint,
 * automatic enrollment, provider loop or second ledger is introduced. The exact
 * interactive subject survives transport detach and remains revocation-bound.
 */
export class OrdinaryLocalCodexOwnedRuntime {
  readonly #reservation: Owners['reservation'];
  readonly #runtime: OrdinaryLocalCodexHostRuntime;
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  readonly #operator: ReturnType<typeof retainAgentContextAuthority>;
  #lease?: FrozenHostCodexBootstrapLease;
  #closed = false;
  readonly #onAbort = () => this.close();

  constructor(private readonly owners: Owners) {
    try {
      if (!owners.enabled || custodianControllerMode || custodianOwnerMode) throw unavailable();
      this.owners = {
        ...owners,
        reservation: structuredClone(owners.reservation),
        env: owners.env ? { ...owners.env } : undefined,
        dispatch: owners.dispatch.bind(owners),
      };
      owners = this.owners;
      owners.signal.throwIfAborted();
      const captured = captureAgentLibraryAuthorization(owners.operatorConnectionId);
      captured.assertCurrent();
      this.#reservation = structuredClone(owners.reservation);
      this.#runtime = new OrdinaryLocalCodexHostRuntime(owners.env);
      this.#signal = AbortSignal.any([owners.signal, this.#controller.signal]);
      // registerAuthSession belongs to this retained authority rather than the
      // browser connection map. Its abort also closes any owned native lease.
      this.#operator = retainAgentContextAuthority({ ...captured.auth }, this.#controller);
      this.#signal.addEventListener('abort', this.#onAbort, { once: true });
      this.#operator.assertCurrent();
    } catch {
      this.close();
      throw unavailable();
    }
  }

  async admit(raw: unknown): Promise<{ dispatched: boolean }> {
    let bootstrap: FrozenHostCodexBootstrapAuthority | undefined;
    const retainedLease = this.#lease;
    try {
      this.assertCurrent();
      if (custodianControllerMode || custodianOwnerMode) throw unavailable();
      const request = OrdinaryLocalCodexCommandRequestSchema.parse(raw);
      if (request.clientMsgId !== this.owners.commandId) throw unavailable();
      const rawPayload = RawPayload.parse(request.payload);
      const profiles = loadAccountProfiles();
      const binding = profiles.resolve(request.runtime.account.accountId, request.selection.model);
      if (!isDeepStrictEqual(binding, this.#reservation.binding)) throw unavailable();
      const profile = profiles.codexProfile(binding);
      if (profile.workspaceId !== undefined) throw unavailable();
      const descriptor = this.owners.workspace.getHostReservation(this.#reservation);
      // A retained checkout is usable only with its original command receipt.
      // The workspace and EventStore remain separate owners; never heal a
      // cross-store orphan by admitting a new command over existing task files.
      if (descriptor.state === 'claimed') {
        const receipt = this.owners.eventStore.getOrdinaryLocalCommandAdmission(
          this.owners.commandId,
        );
        if (!receipt || !['uncertain', 'consumed'].includes(receipt.state)) throw unavailable();
      }
      const agentProfile = this.owners.library.version(
        'user',
        request.selection.agent.profileId,
        request.selection.agent.revision,
      );
      if (
        !agentProfile ||
        agentProfile.definition.contextRecipe !== undefined ||
        request.selection.context.source !== 'none' ||
        request.selection.context.revision !== null ||
        request.selection.permission.revision !== 0
      )
        throw unavailable();
      const payload: Payload = {
        ...rawPayload,
        systemPrompt: buildAgentProfilePrompt(agentProfile.definition),
      };
      const target = this.#runtime.target();
      const catalog = new OrdinaryLocalCodexCapabilityCatalog(profiles, target, 'ordinary');
      const selection = new OrdinaryLocalCodexSelectionOwner({
        events: this.owners.eventStore,
        library: this.owners.library,
        workspace: this.owners.workspace,
        reservation: this.#reservation,
        operator: { assertCurrent: () => this.assertCurrent() },
        signal: this.#signal,
        commandId: this.owners.commandId,
      });
      const bridge = new OwnedCodexLifecycleBridge(() => bootstrap?.currentLease());
      bootstrap = new FrozenHostCodexBootstrapAuthority({
        loadProfiles: loadAccountProfiles,
        observeRuntime: () => this.#runtime.observe(),
        assertRuntimeCurrentSync: () => this.#runtime.assertCurrentSync(),
        assertSelectionCurrent: (expected) => selection.assertCurrent(expected),
        assertSelectionCurrentSync: (expected) => selection.assertCurrentSync(expected),
        signal: this.#signal,
        privateRoot: this.owners.privateRoot,
        baseEnv: this.owners.env,
        lifecycle: bridge.lifecycle,
        launch: this.owners.launch,
      });
      const coordinator = new OrdinaryLocalCodexAdmissionCoordinator({
        enabled: this.owners.enabled,
        store: this.owners.eventStore,
        catalog,
        declaration: target.admissionDeclaration(),
        bootstrapAuthority: bootstrap,
      });
      let claimedWorkspace: RepositoryWorkspace | undefined;
      const result = await coordinator.admit(
        {
          sessionId: this.#reservation.conversationId,
          repositoryWorkspaceId: descriptor.id,
          cwd: descriptor.directory,
          accountBinding: binding,
          agentProfile,
          mode: request.selection.permission.mode,
          selectedModel: request.selection.model,
          reasoningEffort: request.selection.thinking,
        },
        { ...request, payload },
        {
          prepareWorkspace: async (expected) => {
            this.assertCurrent();
            if (
              expected.workspace.workspaceId !== descriptor.id ||
              expected.workspace.cwd !== descriptor.directory
            )
              throw unavailable();
            claimedWorkspace = await this.owners.workspace.claimReservedHostTask({
              ...structuredClone(this.#reservation),
              signal: this.#signal,
            });
            this.assertCurrent();
            if (
              claimedWorkspace.id !== expected.workspace.workspaceId ||
              claimedWorkspace.directory !== expected.workspace.cwd ||
              claimedWorkspace.state !== 'claimed' ||
              claimedWorkspace.sandbox === true
            )
              throw unavailable();
          },
          dispatch: async (expected, clientMsgId) => {
            this.assertCurrent();
            const lease = bootstrap!.currentLease();
            if (
              !lease ||
              !claimedWorkspace ||
              clientMsgId !== this.owners.commandId ||
              (this.#lease && this.#lease !== lease)
            )
              throw unavailable();
            lease.assertCurrentSync();
            const admission = OwnedLocalCodexChatAdmission.capture({
              eventStore: this.owners.eventStore,
              sessionId: this.#reservation.conversationId,
              commandId: this.owners.commandId,
              expected,
              lease,
              bridge,
            });
            this.#lease = lease;
            await this.owners.dispatch({
              admission,
              lease,
              profile: lease.profile,
              expected: structuredClone(expected),
              workspace: structuredClone(claimedWorkspace),
              payload: structuredClone(payload),
              sessionId: this.#reservation.conversationId,
              commandId: this.owners.commandId,
            });
            this.assertCurrent();
            lease.assertCurrentSync();
          },
        },
      );
      return result;
    } catch {
      // A rejected later retry must not dispose the original live conversation.
      // Nor may a losing concurrent call abort the shared operator lifetime.
      // Failed native attempts retain uncertainty and close only their own client;
      // explicit close, operator invalidation and task cancellation own this driver.
      const lease = bootstrap?.currentLease();
      if (lease && lease !== retainedLease) lease.close();
      throw unavailable();
    }
  }

  private assertCurrent(): void {
    if (this.#closed) throw unavailable();
    this.#signal.throwIfAborted();
    this.#operator.assertCurrent();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort(unavailable());
    this.#signal?.removeEventListener('abort', this.#onAbort);
    this.#operator?.release();
    this.#lease?.close();
  }
}
