import type { CollaborationMessageInput } from '@mitzo/protocol';
import type { AuthSession } from './auth.js';
import type { OrdinaryCollaborationDeliveryAuthority } from './collaboration-ordinary-delivery.js';

/** Server-only request scope. Auth comes from operator middleware; the connection
 * ID is correlation that the resolver must bind to that same live signed login.
 * Message JSON supplies intent, never operator, account, membership or permission.
 */
export type CollaborationApplicationDeliveryScope = Readonly<{
  auth: AuthSession;
  operatorConnectionId: string;
  collaborationId: string;
  input: CollaborationMessageInput;
}>;

/** Composition result, not a new grant or dispatch permit. The existing authority
 * still renews the actual command/sample and exact native ACK at ordinary barriers.
 */
export type CollaborationApplicationDeliveryResolution = Readonly<{
  authority: OrdinaryCollaborationDeliveryAuthority;
  /** Synchronous final request/source/settings fence immediately before staging.
   * Throws on cancellation, expiry, revocation or any captured ownership change.
   * Calling this does not allocate, append, admit, enqueue or start a provider.
   */
  assertRequestCurrent(): void;
}>;

/** Core owns the production resolver; S6 owns its router/ordinary-adapter consumer.
 * Undefined means unavailable and must become execution_unavailable/503 BEFORE
 * message, snapshot, receipt, allocation, command, queue or provider mutation.
 * An absent resolver has the same behavior. No success/default resolver exists.
 *
 * A real resolver must derive recipients/policy/settings from existing owners and
 * require genuine prepared ordinary-native support for the selected route. Returning
 * this result alone does not prove fit for an unwritten or incomplete command.
 * Exact request/count/consume must remain with ordinary admission before enqueue;
 * late context/ACK hooks cannot substitute for that earlier native barrier.
 */
export type ResolveCollaborationApplicationDeliveryAuthority = (
  scope: CollaborationApplicationDeliveryScope,
  signal: AbortSignal,
) => Promise<CollaborationApplicationDeliveryResolution | undefined>;
