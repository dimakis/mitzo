import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { effectivePermissionMode, type ManagedSession } from '@mitzo/harness';
import {
  AccountBindingSchema,
  RuntimeCapabilityObservationSchema,
  RuntimeReadinessSchema,
  SessionRuntimeBindingSchema,
  type RuntimeReadiness,
} from '@mitzo/protocol';

export interface RuntimeReadinessInput {
  sessionId: string;
  session?: ManagedSession;
  /** Existing persisted routing description; configuration only. */
  binding?: unknown;
  /** Current generation from the existing runtime owner, not request parameters. */
  ownerRevision?: string;
  /** Already acquired, credential-free evidence from that same owner. No probes here. */
  observation?: unknown;
}

/** Pure projection, with no provider, filesystem or permission effects. The
 * authenticated composition supplies existing owners; this is not an authority
 * registry. Slice-two adapters will supply measured capability observations.
 */
export function projectRuntimeReadiness(
  input: RuntimeReadinessInput,
  now = Date.now(),
): RuntimeReadiness {
  const { sessionId, session } = input;
  const snapshot: Omit<RuntimeReadiness, 'revision'> = {
    version: 1,
    sessionId,
    observedAt: now,
    session: { state: 'unknown', reason: 'session_unavailable' },
    execution: { state: 'unknown', reason: 'not_observed' },
    capabilities: { state: 'unknown', reason: 'not_observed' },
  };
  const selected = AccountBindingSchema.safeParse(session?.accountBinding);
  if (
    session?.sessionId !== sessionId ||
    session?.abortController?.signal.aborted ||
    !selected.success
  ) {
    snapshot.execution = { state: 'unknown', reason: 'session_unavailable' };
    snapshot.capabilities = { state: 'unknown', reason: 'session_unavailable' };
    return finish(snapshot);
  }
  const { model, ...account } = selected.data;
  snapshot.session = {
    state: 'observed',
    account,
    model: session.model ?? model,
    mode: effectivePermissionMode(session),
    grants: [...session.sessionAllowList].sort(),
    skillCeiling: session.activeSkillPolicy ? [...session.activeSkillPolicy].sort() : null,
  };
  const configured = SessionRuntimeBindingSchema.safeParse(input.binding);
  if (input.binding != null) {
    if (!configured.success) snapshot.execution = { state: 'unknown', reason: 'invalid_evidence' };
    else if (
      configured.data.account.accountId !== account.accountId ||
      configured.data.account.provider !== account.provider ||
      configured.data.account.profileRevision !== account.profileRevision ||
      (session.ordinaryRuntimeOwner &&
        session.ordinaryRuntimeOwner.location !== configured.data.execution.location)
    )
      snapshot.execution = { state: 'unknown', reason: 'scope_mismatch' };
    else snapshot.execution = { state: 'configured', binding: configured.data };
  }
  if (input.observation === undefined) return finish(snapshot);
  const measured = RuntimeCapabilityObservationSchema.safeParse(input.observation);
  if (
    !measured.success ||
    measured.data.observedAt > now ||
    measured.data.services.some((service) =>
      service.operations.some(
        (operation) =>
          operation.verification.state !== 'unknown' && operation.verification.observedAt > now,
      ),
    )
  ) {
    snapshot.capabilities = { state: 'unknown', reason: 'invalid_evidence' };
    return finish(snapshot);
  }
  if (!input.ownerRevision) {
    snapshot.capabilities = { state: 'unknown', reason: 'owner_unavailable' };
    return finish(snapshot);
  }
  const evidence = measured.data;
  const scope = evidence.scope;
  if (
    snapshot.execution.state !== 'configured' ||
    !isDeepStrictEqual(scope.binding, snapshot.execution.binding) ||
    scope.sessionId !== sessionId ||
    scope.accountId !== account.accountId ||
    scope.profileRevision !== account.profileRevision ||
    scope.model !== snapshot.session.model ||
    scope.ownerRevision !== input.ownerRevision ||
    evidence.roots.task !== session.cwd
  ) {
    snapshot.capabilities = { state: 'unknown', reason: 'scope_mismatch' };
    return finish(snapshot);
  }
  for (const service of evidence.services) {
    for (const operation of service.operations) {
      const verification = operation.verification;
      if (verification.state !== 'unknown' && verification.expiresAt <= now)
        verification.state = 'stale';
    }
    service.operations.sort((a, b) => a.operation.localeCompare(b.operation));
  }
  evidence.tools.sort((a, b) => a.name.localeCompare(b.name));
  evidence.executables.sort((a, b) => a.command.localeCompare(b.command));
  evidence.services.sort((a, b) => a.id.localeCompare(b.id));
  snapshot.capabilities = { state: evidence.expiresAt <= now ? 'stale' : 'observed', evidence };
  return finish(snapshot);
}

function finish(snapshot: Omit<RuntimeReadiness, 'revision'>): RuntimeReadiness {
  // Read time is not a capability change. Expiration and permission changes are.
  const content = { ...snapshot, observedAt: undefined };
  const revision = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return RuntimeReadinessSchema.parse({ ...snapshot, revision });
}
