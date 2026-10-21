import { isDeepStrictEqual } from 'node:util';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
import type { TelosWorkRoleContextSelection } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { TelosWorkStore } from './telos-work-store.js';
import type { MainPublicationHost } from './telos-main-publication.js';
import {
  MainPublicationAccountSchema,
  RequestGithubMainPublicationSchema,
  type GithubMainMergeCapability,
  type MainPublicationAuthority,
  type MainPublicationInput,
  type MainPublicationPins,
} from './telos-main-publication-contract.js';
import { approveGithubMainPublication } from './github-main-publication-permission.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';

/** Core captures this ONLY inside the verified original native tool callback.
 * Values are labels plus real retained owner/currentness fences, never JSON
 * authority. Each host belongs to that one native call, not a runtime factory.
 */
export interface NativeMainPublicationCall {
  readonly operatorId: string;
  readonly conversationId: string;
  readonly clientId: string;
  readonly session: ManagedSession;
  readonly accountBinding: MainPublicationAuthority['accountBinding'];
  readonly runtimeId: string;
  readonly selectedRole: TelosWorkRoleContextSelection | undefined;
  readonly signal: AbortSignal;
  assertCurrentSync(): void;
}
/** Core owns actual selected connection/account/custodian/credential generation
 * and pointer currentness. This port neither selects ambient credentials nor
 * turns read-only/branch-export/sealed-artifact grants into merge authority. */
export interface SelectedGithubMainMerge {
  readonly capability: GithubMainMergeCapability;
  readonly signal: AbortSignal;
  assertCurrentSync(): void;
}
export type SelectGithubMainMerge = (
  input: MainPublicationInput,
  signal: AbortSignal,
) => Promise<SelectedGithubMainMerge>;

export interface MainPublicationHostOwners {
  readonly registry: SessionRegistry;
  readonly events: EventStore;
  readonly work: TelosWorkStore;
  readonly context: NativeMainPublicationCall;
  readonly select: SelectGithubMainMerge;
}
function unavailable(): never {
  throw new Error('Original native publication owner or selected merge authority unavailable');
}

const accountScope = (binding: {
  accountId: string;
  provider: string;
  model: string;
  profileRevision: string;
}) =>
  MainPublicationAccountSchema.parse({
    accountId: binding.accountId,
    provider: binding.provider,
    model: binding.model,
    profileRevision: binding.profileRevision,
  });

/** Composes existing backend + real ordinary permission, not native registration,
 * credential installation, a model-count owner or a replacement admission queue.
 */
export function createTelosMainPublicationHost(
  owners: MainPublicationHostOwners,
): MainPublicationHost {
  const { registry, events, work } = owners;
  const native = owners.context;
  const context = {
    operatorId: native.operatorId,
    conversationId: native.conversationId,
    clientId: native.clientId,
    runtimeId: native.runtimeId,
    session: native.session,
    accountBinding: structuredClone(accountScope(native.accountBinding)),
    selectedRole: native.selectedRole ? structuredClone(native.selectedRole) : undefined,
    signal: native.signal,
    assertCurrentSync: native.assertCurrentSync.bind(native),
  };
  const select = owners.select;
  let resolved:
    | {
        input: MainPublicationInput;
        authority: MainPublicationAuthority;
        capability: GithubMainMergeCapability;
        signal: AbortSignal;
        assertSelectedCurrent(): void;
      }
    | undefined;

  let resolving = false;

  const assertNative = () => {
    context.signal.throwIfAborted();
    context.assertCurrentSync();
    const owner = registry.findBySessionId(context.conversationId);
    const account = context.session.accountBinding;
    if (
      !context.operatorId.trim() ||
      !context.runtimeId.trim() ||
      registry.get(context.clientId) !== context.session ||
      owner?.clientId !== context.clientId ||
      owner.session !== context.session ||
      context.session.sessionId !== context.conversationId ||
      context.session.abortController.signal.aborted ||
      !account ||
      !isDeepStrictEqual(accountScope(account), context.accountBinding) ||
      !isDeepStrictEqual(
        resolveTelosWorkRoleContext(
          events,
          context.conversationId,
          context.session.accountBinding ?? undefined,
        ),
        context.selectedRole,
      )
    )
      unavailable();
  };
  const assertSelection = () => {
    assertNative();
    if (!resolved) unavailable();
    resolved.signal.throwIfAborted();
    resolved.assertSelectedCurrent();
    const capability = resolved.capability;
    if (
      capability.kind !== 'github-main-merge' ||
      capability.connectionId !== resolved.authority.connectionId ||
      capability.capabilityId !== resolved.authority.capabilityId ||
      capability.repository !== resolved.authority.repository
    )
      unavailable();
  };

  const host: MainPublicationHost = {
    async resolve(raw, signal) {
      const input = RequestGithubMainPublicationSchema.parse(raw);
      signal.throwIfAborted();
      assertNative();
      if (resolved) {
        if (!isDeepStrictEqual(input, resolved.input)) unavailable();
        assertSelection();
        return { authority: structuredClone(resolved.authority), capability: resolved.capability };
      }
      if (resolving) unavailable();
      resolving = true;
      const lease = await select(
        input,
        AbortSignal.any([signal, context.signal, context.session.abortController.signal]),
      );
      signal.throwIfAborted();
      assertNative();
      lease.signal.throwIfAborted();
      lease.assertCurrentSync();
      const capability = lease.capability;
      if (
        capability.kind !== 'github-main-merge' ||
        ![capability.connectionId, capability.capabilityId, capability.repository].every(
          (value) => typeof value === 'string' && value.trim(),
        )
      )
        unavailable();
      const authority: MainPublicationAuthority = {
        operatorId: context.operatorId,
        conversationId: context.conversationId,
        accountBinding: structuredClone(context.accountBinding),
        runtimeId: context.runtimeId,
        connectionId: capability.connectionId,
        capabilityId: capability.capabilityId,
        repository: capability.repository,
        assignmentRevision: 0,
        attemptId: null,
      };
      // Historical custody is checked before requiring current work assignment.
      // Retained facts grant no fresh role/permission/effect authority.
      const previous = work.mainPublicationsForHost().existingForHost(input, authority);
      if (previous) {
        authority.assignmentRevision = previous.pins.authority.assignmentRevision;
        authority.attemptId = previous.pins.authority.attemptId;
      } else {
        const current = work.read(input.itemId, {
          kind: 'conversation',
          id: context.conversationId,
        });
        const role = current.kind === 'work_item' ? 'worker' : 'lead';
        authority.assignmentRevision =
          current.assignments.find((assignment) => assignment.role === role)?.revision ?? 0;
        authority.attemptId = current.attempts.at(-1)?.attemptId ?? null;
      }
      resolved = {
        input: structuredClone(input),
        authority: structuredClone(authority),
        capability,
        signal: AbortSignal.any([
          context.signal,
          context.session.abortController.signal,
          lease.signal,
        ]),
        assertSelectedCurrent: lease.assertCurrentSync.bind(lease),
      };
      assertSelection();
      return { authority: structuredClone(authority), capability };
    },
    assertCurrent(pins: MainPublicationPins) {
      assertSelection();
      if (
        !resolved ||
        !isDeepStrictEqual(pins.input, resolved.input) ||
        !isDeepStrictEqual(pins.authority, resolved.authority) ||
        pins.baseBranch !== 'main' ||
        pins.method !== 'squash'
      )
        unavailable();
      const role = context.selectedRole;
      if (!role || role.itemId !== pins.input.itemId || !['lead', 'worker'].includes(role.role))
        unavailable();
      const current = work.read(pins.input.itemId, {
        kind: 'conversation',
        id: context.conversationId,
      });
      const expectedRole = current.kind === 'work_item' ? 'worker' : 'lead';
      if (
        role.role !== expectedRole ||
        (role.itemKind !== undefined && role.itemKind !== current.kind)
      )
        unavailable();
      work.mainPublicationsForHost().assertWorkCurrent(pins);
    },
    approve(presentation, signal) {
      host.assertCurrent(presentation.pins);
      if (!resolved) unavailable();
      return approveGithubMainPublication(
        registry,
        context.clientId,
        presentation,
        AbortSignal.any([signal, resolved.signal]),
        () => host.assertCurrent(presentation.pins),
      );
    },
  };
  return host;
}
