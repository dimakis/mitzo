import {
  assertSymposiumAttestedProvider,
  type SymposiumProviderCapability,
} from './symposium-production-gate.js';
import type { ControlledAttemptSandbox } from './symposium-attempt-transport.js';
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
  /** Trusted adapter checks durable same-seat lineage and retained continuity. */
  verifyThreadMigration?(previous: string, next: string): void;
  run(
    input: SymposiumSeatExecution,
    callbacks: {
      /** Called immediately before native provider dispatch, after all async setup. */
      beforeDispatch(providerThreadId?: string): void;
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
  verifyHostCapability?: () => SymposiumProviderCapability;
  /** A session-owned manager reconciles the exact provider for this seat. */
  owner: {
    ensure(
      sessionId: string,
      seatId: string,
      signal: AbortSignal,
    ): Promise<ControlledAttemptSandbox>;
    readOnlyEnforced: { openaiApi: boolean; claudeVertex: boolean; chatgptSubscription?: boolean };
  };
  migrateThread?(claimToken: string, previous: string, next: string): void;
  recordAccepted(input: {
    deliveryId: string;
    seatId: string;
    claimToken: string;
    providerThreadId: string;
    providerTurnId: string;
    acceptedAt: number;
  }): boolean;
  /** Called only after exact native cleanup, including recovery without process-local state. */
  releaseAttempt?: (claimToken: string) => void;
  recordEvent?: (execution: SymposiumSeatExecution, event: Record<string, unknown>) => void;
  /** Trusted factory: when a registry is supplied, all native launches must use it. */
  openNative(input: {
    sandbox: ControlledAttemptSandbox;
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
      !(route.kind === 'chatgpt-subscription-native'
        ? this.deps.owner.readOnlyEnforced.chatgptSubscription
        : route.kind === 'openai-api'
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
    let approvedThread: string | undefined;
    const result = await native.run(input, {
      beforeDispatch: (providerThreadId) => {
        const current = admission();
        if (JSON.stringify(current) !== JSON.stringify(route))
          throw new Error('Symposium account provider changed before native turn');
        const capability = this.deps.verifyHostCapability?.();
        if (capability)
          assertSymposiumAttestedProvider(capability, {
            name: current.provider,
            id: current.providerId,
            type:
              current.kind === 'chatgpt-subscription-native'
                ? 'codex'
                : current.kind === 'openai-api'
                  ? 'openai'
                  : 'google-vertex-ai',
          });
        if (
          input.providerThreadId &&
          providerThreadId &&
          providerThreadId !== input.providerThreadId
        ) {
          if (!native.verifyThreadMigration)
            throw new Error('Symposium native thread migration is unavailable');
          native.verifyThreadMigration(input.providerThreadId, providerThreadId);
          if (!this.deps.migrateThread)
            throw new Error('Symposium durable thread migration is unavailable');
          this.deps.migrateThread(input.claimToken, input.providerThreadId, providerThreadId);
          approvedThread = providerThreadId;
        }
      },
      accepted: (providerThreadId, providerTurnId) => {
        if (
          input.providerThreadId &&
          providerThreadId !== input.providerThreadId &&
          providerThreadId !== approvedThread
        )
          throw new Error('Symposium unapproved provider thread receipt');
        const recorded = this.deps.recordAccepted({
          deliveryId: input.deliveryId,
          seatId: input.seat.id,
          claimToken: input.claimToken,
          providerThreadId,
          providerTurnId,
          acceptedAt: Date.now(),
        });
        if (!recorded) throw new Error('Symposium provider receipt claim is no longer valid');
        this.deps.recordEvent?.(input, { type: 'symposium_attempt_accepted' });
      },
    });
    if (
      input.providerThreadId &&
      result.providerThreadId !== input.providerThreadId &&
      result.providerThreadId !== approvedThread
    )
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
    this.deps.releaseAttempt?.(token);
    this.attempts.delete(token);
  }
}
