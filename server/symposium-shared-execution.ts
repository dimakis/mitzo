import type { AccountBinding } from '@mitzo/protocol';
import type { AccountProfiles } from './account-profiles.js';
import type {
  SymposiumSeatExecution,
  SymposiumSeatExecutionResult,
  SymposiumSeatExecutor,
} from './symposium-orchestrator.js';
import {
  assertSymposiumSeatDispatchCurrent,
  type SymposiumDispatchFacts,
  type SymposiumHostGrantVerifier,
} from './symposium-seat-runtime.js';

export interface OrdinarySymposiumTurn {
  /** Resolve only after the exact ordinary turn has completed and its query is closed. */
  run(
    input: SymposiumSeatExecution,
    callbacks: {
      beforeDispatch(): void;
      accepted(providerThreadId: string, providerTurnId: string): void;
    },
  ): Promise<SymposiumSeatExecutionResult>;
  /** A close request is insufficient: observe the exact query/provider termination. */
  cancelAndDrain(): Promise<void>;
}

interface SharedAdmissionDependencies {
  facts: SymposiumDispatchFacts;
  currentProfiles(): AccountProfiles;
  hostGrants: SymposiumHostGrantVerifier;
  assertArtifactCurrent(input: SymposiumSeatExecution): void;
}

export interface SymposiumSharedSeatExecutorDependencies extends SharedAdmissionDependencies {
  openOrdinary(input: {
    execution: SymposiumSeatExecution;
    binding: AccountBinding;
  }): Promise<OrdinarySymposiumTurn>;
  recordAccepted(input: {
    deliveryId: string;
    seatId: string;
    claimToken: string;
    providerThreadId: string;
    providerTurnId: string;
    acceptedAt: number;
  }): boolean;
  /** Unknown or live retained work must reject, preserving the orchestrator's reservation. */
  recoverCancelled(input: {
    claimToken: string;
    idempotencyKey?: string;
    providerThreadId?: string;
  }): Promise<void>;
}

/** Ordinary collaboration cannot make native read-only, review or publication claims.
 * Grants are authority ceilings. The ordinary mode/provider owners enforce their
 * existing policies; these checks attest neither a physical network boundary nor
 * an artifact-only filesystem. */
export function admitSymposiumSharedDispatch(
  deps: SharedAdmissionDependencies,
  input: SymposiumSeatExecution,
): AccountBinding {
  const seat = assertSymposiumSeatDispatchCurrent(deps.facts, input, deps.hostGrants);
  if (
    !['coder', 'implementer'].includes(seat.role) ||
    seat.authorityGrant?.filesystem !== 'write' ||
    seat.authorityGrant.tools !== 'write' ||
    seat.authorityGrant.network !== 'restricted'
  )
    throw new Error('Ordinary collaboration does not provide physical reviewer isolation');
  if (seat.isolationRequest?.placement !== 'reuse-compatible')
    throw new Error('Ordinary collaboration cannot attest dedicated physical isolation');
  deps.assertArtifactCurrent(input);
  const binding = seat.accountBinding!;
  const profiles = deps.currentProfiles();
  profiles.resume(binding);
  profiles.validateModelSelection(binding, binding.model, seat.reasoningEffort);
  return binding;
}

interface SharedAttempt {
  input: SymposiumSeatExecution;
  opening: Promise<OrdinarySymposiumTurn>;
  cancelled: boolean;
  cancellation?: Promise<void>;
}

/** Reuses Symposium claims and ordinary execution; owns no scheduler or account persistence. */
export class SymposiumSharedSeatExecutor implements SymposiumSeatExecutor {
  private readonly attempts = new Map<string, SharedAttempt>();
  constructor(private readonly deps: SymposiumSharedSeatExecutorDependencies) {}

  async execute(input: SymposiumSeatExecution): Promise<SymposiumSeatExecutionResult> {
    if (this.attempts.has(input.claimToken))
      throw new Error('Symposium claim is already executing');
    const binding = admitSymposiumSharedDispatch(this.deps, input);
    const attempt: SharedAttempt = {
      input,
      cancelled: false,
      opening: this.deps.openOrdinary({ execution: input, binding }),
    };
    this.attempts.set(input.claimToken, attempt);
    const requestCancellation = () => {
      void this.cancel({
        claimToken: input.claimToken,
        idempotencyKey: input.idempotencyKey,
      }).catch(() => {});
    };
    input.signal.addEventListener('abort', requestCancellation, { once: true });
    let accepted: { thread: string; turn: string } | undefined;
    try {
      const ordinary = await attempt.opening;
      if (attempt.cancelled || input.signal.aborted)
        throw new Error('Symposium ordinary attempt cancelled during startup');
      const result = await ordinary.run(input, {
        beforeDispatch: () => {
          if (attempt.cancelled) throw new Error('Symposium ordinary attempt cancelled');
          admitSymposiumSharedDispatch(this.deps, input);
        },
        accepted: (thread, turn) => {
          if (
            !thread ||
            !turn ||
            (input.providerThreadId && input.providerThreadId !== thread) ||
            (accepted && (accepted.thread !== thread || accepted.turn !== turn))
          )
            throw new Error('Symposium ordinary provider thread or turn identity changed');
          if (
            !this.deps.recordAccepted({
              deliveryId: input.deliveryId,
              seatId: input.seat.id,
              claimToken: input.claimToken,
              providerThreadId: thread,
              providerTurnId: turn,
              acceptedAt: Date.now(),
            })
          )
            throw new Error('Symposium ordinary acceptance claim is no longer valid');
          accepted = { thread, turn };
        },
      });
      if (attempt.cancelled || input.signal.aborted)
        throw new Error('Symposium ordinary attempt cancelled');
      if (!accepted) throw new Error('Symposium ordinary completion requires exact acceptance');
      if (accepted.thread !== result.providerThreadId)
        throw new Error('Symposium ordinary result thread identity changed');
      this.attempts.delete(input.claimToken);
      return result;
    } finally {
      input.signal.removeEventListener('abort', requestCancellation);
    }
  }

  async cancel(input: {
    claimToken?: string;
    idempotencyKey?: string;
    providerThreadId?: string;
  }): Promise<void> {
    if (!input.claimToken) throw new Error('Symposium ordinary attempt cleanup is unknown');
    const attempt = this.attempts.get(input.claimToken);
    if (!attempt) return this.deps.recoverCancelled({ ...input, claimToken: input.claimToken });
    if (
      (input.idempotencyKey && input.idempotencyKey !== attempt.input.idempotencyKey) ||
      (input.providerThreadId && input.providerThreadId !== attempt.input.providerThreadId)
    )
      throw new Error('Symposium cancellation identity does not match the exact attempt');
    attempt.cancelled = true;
    attempt.cancellation ??= attempt.opening.then((ordinary) => ordinary.cancelAndDrain());
    await attempt.cancellation;
    this.attempts.delete(input.claimToken);
  }
}
