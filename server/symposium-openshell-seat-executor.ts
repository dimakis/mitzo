import type { SymposiumAttemptRegistry } from './symposium-attempt-registry.js';
import type { AccountProfiles } from './account-profiles.js';
import type { SymposiumSeatExecution, SymposiumSeatExecutor } from './symposium-orchestrator.js';
import {
  admitSymposiumSeatDispatch,
  type SymposiumDispatchFacts,
  type SymposiumHostGrantVerifier,
  type SymposiumSeatRoute,
} from './symposium-seat-runtime.js';

export interface SymposiumNativeSeat {
  run(
    input: SymposiumSeatExecution,
    callbacks: {
      /** Called immediately before native provider dispatch, after all async setup. */
      beforeDispatch(): void;
      /** Only a provider-confirmed turn ID is an accepted receipt. */
      accepted(providerThreadId: string, providerTurnId: string): void;
    },
  ): Promise<{ providerThreadId: string; content: string; costUsd?: number }>;
  /** Resolve only after this exact attempt can no longer perform native work. */
  cancel(): Promise<void>;
}

export interface SymposiumOpenShellSeatExecutorDeps {
  facts: SymposiumDispatchFacts;
  attemptRegistry?: SymposiumAttemptRegistry;
  profiles: AccountProfiles;
  currentProfiles?: () => AccountProfiles;
  hostGrants: SymposiumHostGrantVerifier;
  /** Re-probe selected gateway, policy, controller and exact profile at dispatch. */
  verifyHostCapability?: () => { attestedProviderProfiles: ReadonlySet<string> };
  /** A session-owned manager reconciles the exact provider for this seat. */
  owner: {
    ensure(
      sessionId: string,
      seatId: string,
      signal: AbortSignal,
    ): Promise<{ sandboxName: string; workdir: string }>;
    readOnlyEnforced: { openaiApi: boolean; claudeVertex: boolean };
  };
  recordAccepted(input: {
    deliveryId: string;
    seatId: string;
    claimToken: string;
    providerThreadId: string;
    providerTurnId: string;
    acceptedAt: number;
  }): boolean;
  recordEvent?: (execution: SymposiumSeatExecution, event: Record<string, unknown>) => void;
  /** Trusted factory: when a registry is supplied, all native launches must use it. */
  openNative(input: {
    sandbox: { sandboxName: string; workdir: string };
    route: SymposiumSeatRoute;
    execution: SymposiumSeatExecution;
    onEvent?: (event: Record<string, unknown>) => void;
  }): Promise<SymposiumNativeSeat>;
}

/** Dispatches a seat only through a session-owned, exact-provider sandbox. */
export class SymposiumOpenShellSeatExecutor implements SymposiumSeatExecutor {
  private attempts = new Map<
    string,
    { native?: SymposiumNativeSeat; execution: SymposiumSeatExecution; opening: boolean }
  >();

  constructor(private deps: SymposiumOpenShellSeatExecutorDeps) {}

  prepare(input: { sessionId: string; claimToken: string }) {
    this.deps.attemptRegistry?.prepare(input);
  }

  async execute(input: SymposiumSeatExecution) {
    this.prepare(input);
    const attempt: {
      native?: SymposiumNativeSeat;
      execution: SymposiumSeatExecution;
      opening: boolean;
    } = { execution: input, opening: false };
    this.attempts.set(input.claimToken, attempt);
    const admission = () =>
      admitSymposiumSeatDispatch(
        this.deps.facts,
        this.deps.currentProfiles?.() ?? this.deps.profiles,
        input,
        this.deps.hostGrants,
      );
    let route = admission();
    if (
      route.readOnly &&
      !(route.kind === 'openai-api'
        ? this.deps.owner.readOnlyEnforced.openaiApi
        : this.deps.owner.readOnlyEnforced.claudeVertex)
    )
      throw new Error('Reviewer native read-only policy is not verified on this sandbox');
    const sandbox = await this.deps.owner.ensure(input.sessionId, input.seat.id, input.signal);
    route = admission();
    if (this.attempts.get(input.claimToken) !== attempt || input.signal.aborted)
      throw new Error('Symposium native attempt was cancelled before initialization');
    attempt.opening = true;
    const native = await this.deps.openNative({
      sandbox,
      route,
      execution: input,
      onEvent: this.deps.recordEvent ? (event) => this.deps.recordEvent!(input, event) : undefined,
    });
    attempt.native = native;
    if (this.attempts.get(input.claimToken) !== attempt || input.signal.aborted)
      throw new Error('Symposium native attempt was cancelled during initialization');
    // If admission changed during native initialization, orchestrator cleanup
    // can now target the created process by its exact durable claim.
    admission();
    const result = await native.run(input, {
      beforeDispatch: () => {
        const current = admission();
        if (current.providerId !== route.providerId || current.provider !== route.provider)
          throw new Error('Symposium account provider changed before native turn');
        const capability = this.deps.verifyHostCapability?.();
        if (capability && !capability.attestedProviderProfiles.has(current.provider))
          throw new Error('Seat provider profile is outside the host attestation');
      },
      accepted: (providerThreadId, providerTurnId) => {
        const recorded = this.deps.recordAccepted({
          deliveryId: input.deliveryId,
          seatId: input.seat.id,
          claimToken: input.claimToken,
          providerThreadId,
          providerTurnId,
          acceptedAt: Date.now(),
        });
        if (!recorded) throw new Error('Symposium provider receipt claim is no longer valid');
      },
    });
    if (input.providerThreadId && result.providerThreadId !== input.providerThreadId)
      throw new Error('Symposium native thread identity changed');
    this.deps.recordEvent?.(input, { type: 'symposium_attempt_released' });
    this.attempts.delete(input.claimToken);
    return result;
  }

  async cancel(input: { claimToken?: string }) {
    const token = input.claimToken;
    if (!token) throw new Error('Symposium native attempt cleanup is unknown');
    const active = this.attempts.get(token);
    if (active?.native) {
      await active.native.cancel();
      await this.deps.attemptRegistry?.recover(token);
    } else if (this.deps.attemptRegistry) {
      await this.deps.attemptRegistry.recover(token);
    } else if (!active || active.opening) {
      throw new Error('Symposium native attempt cleanup is unknown');
    }
    if (active) this.deps.recordEvent?.(active.execution, { type: 'symposium_attempt_released' });
    this.attempts.delete(token);
  }
}
