import type { EventStore } from './event-store.js';
import {
  OrdinarySdkInterruptTargetSchema,
  type OrdinarySdkInterruptTarget,
  type ExecutionToken,
} from '@mitzo/protocol';
import type { OrdinaryLocalCommandAdmission } from '@mitzo/protocol';
import {
  assertOrdinarySynchronousFence,
  type OrdinaryTurnLifecycle,
} from './ordinary-turn-lifecycle.js';
import type { OrdinarySdkTurnEvidence } from './ordinary-sdk-turn-evidence.js';
import type { OrdinarySdkQueryControl } from './ordinary-local-vertex-sdk-query.js';

/** A FIFO controller for one existing SDK query. The durable queue is the existing
 * ordinary/send ledger; this object only tracks the live query's active command. */
type ActiveSdkCommand = { commandId: string; execution: ExecutionToken };
export class OrdinaryLocalVertexCommandOwner {
  #active?: ActiveSdkCommand;
  #pending: string[] = [];
  #serial: Promise<void> = Promise.resolve();
  #failed = false;
  #inputUuid?: string;
  #inputDispatched?: string;
  #dispatchingCommandId?: string;
  #paused = false;
  #interruptTargets = new WeakMap<object, { active: ActiveSdkCommand; native: object }>();
  constructor(
    private readonly owners: {
      store: EventStore;
      sessionId: string;
      assertCurrent(): Promise<void> | void;
      assertCurrentSync?(): void;
      turnLifecycle?(commandId: string): OrdinaryTurnLifecycle | undefined;
      turnEvidence?: OrdinarySdkTurnEvidence;
      ownsClaim?(commandId: string): boolean;
      onTerminal?(commandId: string): void;
      query: Partial<OrdinarySdkQueryControl> & {
        applySettings?(selection: OrdinaryLocalCommandAdmission['selection']): Promise<void>;
        setModel(model: string): Promise<void>;
        setMaxThinkingTokens(tokens: number | null): Promise<void>;
        push(
          commandId: string,
          admission: Readonly<OrdinaryLocalCommandAdmission>,
          payload: Readonly<Record<string, unknown>>,
        ): Promise<void> | void;
        abort(): void;
      };
      /** Exact configured model/thinking mapping; unknown snapshots must throw. */
      settings(selection: OrdinaryLocalCommandAdmission['selection']): {
        model: string;
        thinkingTokens: number | null;
      };
    },
  ) {}
  activeCommandId(): string | undefined {
    return this.#active?.commandId ?? this.#dispatchingCommandId;
  }
  #turnLifecycle(commandId: string): OrdinaryTurnLifecycle | undefined {
    const lifecycle = this.owners.turnLifecycle?.(commandId);
    // Shared commands use this owner-issued namespace. A durable queue entry
    // preserves content and identity, but cannot recreate its source grant.
    if (commandId.startsWith('collaboration:') && !lifecycle)
      throw Error('Original shared SDK source authority unavailable; review the queued command');
    return lifecycle;
  }
  captureInterruptTarget(): OrdinarySdkInterruptTarget | undefined {
    if (
      this.#failed ||
      this.#paused ||
      !this.#active ||
      !this.#inputUuid ||
      !this.owners.turnEvidence
    )
      return;
    const native = this.owners.query.captureInterruptTarget?.();
    if (!native) return;
    const captured = this.owners.turnEvidence.interruptTarget(
      this.#active.commandId,
      this.#inputUuid,
      this.#active.execution,
    );
    Object.freeze(captured.execution);
    const target = Object.freeze(captured);
    this.#interruptTargets.set(target, { active: this.#active, native });
    return target;
  }
  async interruptIfCurrent(requestId: string, target: OrdinarySdkInterruptTarget) {
    const witness = this.#interruptTargets.get(target);
    if (
      !witness ||
      this.#failed ||
      !this.owners.assertCurrentSync ||
      this.#active !== witness.active ||
      this.#inputUuid !== target.providerTurnId ||
      !this.owners.query.interruptIfCurrent
    )
      return 'stale_target' as const;
    assertOrdinarySynchronousFence(target.commandId, () => this.owners.assertCurrentSync!());
    const claim = this.owners.store.claimOrdinarySdkInterrupt(
      this.owners.sessionId,
      requestId,
      OrdinarySdkInterruptTargetSchema.parse(target),
    );
    if (!claim) return 'stale_target' as const;
    if (!claim.fresh) return 'uncertain' as const;
    this.#paused = true;
    if (this.#active !== witness.active || this.#inputUuid !== target.providerTurnId)
      throw Error('Original SDK interruption claim remains uncertain');
    return (await this.owners.query.interruptIfCurrent(witness.native))
      ? ('requested' as const)
      : ('uncertain' as const);
  }
  /** The SDK may await credential/account renewal after queue insertion. This
   * exact active command fence runs at the final user-input yield instead. */
  assertInputCurrent(commandId: string): void {
    if (
      this.#failed ||
      !this.owners.assertCurrentSync ||
      this.#active?.commandId !== commandId ||
      this.#inputDispatched !== commandId ||
      this.#inputUuid !== undefined
    )
      throw Error('Original SDK input command identity unavailable');
    assertOrdinarySynchronousFence(commandId, () => this.owners.assertCurrentSync!());
    assertOrdinarySynchronousFence(commandId, () =>
      this.#turnLifecycle(commandId)?.beforeDispatch(commandId),
    );
  }
  acceptsPeerMessages(): boolean {
    return !this.#paused && !this.#failed;
  }
  /** A preparing command is not yet a provider-acknowledged steering target. */
  peerTurnTarget(): string | undefined {
    return this.#active && this.#inputUuid && this.#inputDispatched === this.#active.commandId
      ? this.#active.commandId
      : undefined;
  }
  enqueue(commandId: string, preparationSignal?: AbortSignal): Promise<void> {
    return this.#serialize(
      async () => {
        preparationSignal?.throwIfAborted();
        await this.#fence();
        preparationSignal?.throwIfAborted();
        const command = this.owners.store.getSendCommand(commandId);
        const admission = this.owners.store.getOrdinaryLocalVertexCommandAdmission(commandId);
        if (command?.sessionId !== this.owners.sessionId || !admission)
          throw Error('Original SDK command unavailable');
        if (this.#active?.commandId === commandId || this.#pending.includes(commandId)) return;
        if (
          admission.state !== 'reserved' &&
          !(
            this.owners.ownsClaim?.(commandId) &&
            !this.owners.store.getExecutionAdmission(this.owners.sessionId, commandId)
          )
        )
          throw Error('Original SDK command cannot be replayed');
        this.#pending = this.owners.store.getPendingOrdinaryLocalVertexCommandIds(
          this.owners.sessionId,
        );
        if (
          (admission.state === 'reserved' ||
            (admission.state === 'uncertain' && this.owners.ownsClaim?.(commandId))) &&
          !this.#pending.includes(commandId)
        )
          this.#pending.push(commandId);
        this.#paused = false;
        await this.#dispatch(preparationSignal, commandId);
      },
      preparationSignal,
      commandId,
    );
  }
  complete(commandId: string, failed = false, inputUuid?: string): Promise<void> {
    return this.#serialize(async () => {
      await this.#fence();
      if (this.#active?.commandId !== commandId)
        throw Error('SDK result does not match active command');
      if (this.owners.turnEvidence && !inputUuid)
        throw Error('Original SDK result input acknowledgment unavailable');
      const stopping =
        this.owners.store.getSession(this.owners.sessionId)?.executionPhase === 'STOPPING';
      const transition = this.owners.store.transitionExecution(
        this.#active.execution,
        'TERMINAL',
        stopping ? 'stopped' : failed ? 'failed' : 'completed',
      );
      if (!transition.applied) throw Error('Original SDK terminal execution unavailable');
      // The owned query exposes a result only after sealing and settling its
      // original callbacks. Generic cleanup/abort never calls this path.
      if (inputUuid) {
        this.owners.turnEvidence?.settled(commandId, inputUuid, failed ? 'failed' : 'completed');
        this.owners
          .turnLifecycle?.(commandId)
          ?.terminal(commandId, inputUuid, failed ? 'failed' : 'completed');
      }
      this.#paused = stopping;
      this.#active = undefined;
      this.#inputDispatched = undefined;
      this.owners.onTerminal?.(commandId);
      await this.#dispatch();
    });
  }
  inputObserved(inputUuid: string): void {
    if (!this.#active || !inputUuid || (this.#inputUuid && this.#inputUuid !== inputUuid)) {
      this.#failed = true;
      this.owners.query.abort();
      throw Error('Original SDK input identity unavailable');
    }
    this.#inputUuid = inputUuid;
    const commandId = this.#active.commandId;
    const accepted = this.owners.turnEvidence?.accepted(commandId, inputUuid);
    const lifecycle = this.owners.turnLifecycle?.(commandId);
    if (lifecycle && !accepted) throw Error('Original SDK turn evidence unavailable');
    if (accepted)
      lifecycle?.accepted(commandId, accepted.providerThreadId, accepted.providerTurnId);
  }
  /** Parent renderer identities only; the query loop excludes subagent starts. */
  messageStarted(messageId: string): void {
    if (!this.owners.turnEvidence) return;
    if (!this.#active || !this.#inputUuid || this.#failed)
      throw Error('Original SDK reply input acknowledgment unavailable');
    this.owners.turnEvidence.message(this.#active.commandId, messageId);
  }
  resultObserved(inputUuid: string | undefined, failed = false): Promise<void> {
    if (!this.#active || !inputUuid || this.#inputUuid !== inputUuid) {
      this.#failed = true;
      this.owners.query.abort();
      return Promise.reject(Error('Original SDK result identity unavailable'));
    }
    const commandId = this.#active.commandId;
    this.#inputUuid = undefined;
    return this.complete(commandId, failed, inputUuid);
  }
  async #fence() {
    if (this.#failed) throw Error('Original SDK owner unavailable');
    await this.owners.assertCurrent();
  }
  #serialize(
    effect: () => Promise<void>,
    preparationSignal?: AbortSignal,
    incomingCommandId?: string,
  ): Promise<void> {
    const next = this.#serial.then(effect).catch(async (error) => {
      if (preparationSignal?.aborted && error === preparationSignal.reason) {
        try {
          await this.owners.assertCurrent();
        } catch (authorityError) {
          this.#failed = true;
          this.owners.query.abort();
          throw authorityError;
        }
        // Settings allocation is not provider input. A known pre-input deadline
        // can settle its execution without awaiting an SDK result that cannot exist.
        if (
          incomingCommandId &&
          this.#active?.commandId === incomingCommandId &&
          this.#inputDispatched !== incomingCommandId
        ) {
          try {
            this.owners.store.transitionExecution(this.#active.execution, 'TERMINAL', 'abandoned');
            this.owners.store.completeOrdinaryLocalVertexCommand(incomingCommandId);
            this.owners.store.failSendCommand(incomingCommandId, 'Cancelled before SDK dispatch');
            this.#active = undefined;
            this.#pending = this.#pending.filter((id) => id !== incomingCommandId);
            this.owners.onTerminal?.(incomingCommandId);
            await this.#dispatch();
          } catch (settlementError) {
            this.#failed = true;
            this.owners.query.abort();
            throw settlementError;
          }
        } else if (
          incomingCommandId &&
          !this.owners.store.getExecutionAdmission(this.owners.sessionId, incomingCommandId)
        ) {
          this.#pending = this.#pending.filter((id) => id !== incomingCommandId);
          if (this.#dispatchingCommandId === incomingCommandId)
            this.#dispatchingCommandId = undefined;
        }
      } else {
        this.#failed = true;
        this.owners.query.abort();
      }
      throw error;
    });
    this.#serial = next.catch(() => {});
    return next;
  }
  async #dispatch(preparationSignal?: AbortSignal, admittingCommandId?: string): Promise<void> {
    if (!this.owners.store.deployment.canDispatch(this.owners.sessionId)) return;
    while (this.#pending.length && this.owners.store.getSendCommand(this.#pending[0]!)?.error)
      this.#pending.shift();
    if (this.#active || this.#paused || !this.#pending.length) return;
    const commandId = this.#pending[0]!;
    const assertPreparation = () => {
      if (commandId === admittingCommandId) preparationSignal?.throwIfAborted();
    };
    assertPreparation();
    this.#dispatchingCommandId = commandId;
    const admission = this.owners.store.getOrdinaryLocalVertexCommandAdmission(commandId)!;
    const settings = this.owners.settings(structuredClone(admission.selection));
    await this.#fence();
    assertPreparation();
    this.#turnLifecycle(commandId);
    // A signed queue control may cancel this consumed head during authority I/O.
    // Observe that exact cancellation before allocating an execution generation.
    if (
      this.owners.store.getSendCommand(commandId)?.error === 'Cancelled before SDK dispatch' &&
      admission.state === 'consumed' &&
      !this.owners.store.getExecutionAdmission(this.owners.sessionId, commandId)
    ) {
      this.#pending.shift();
      this.#dispatchingCommandId = undefined;
      this.owners.onTerminal?.(commandId);
      return this.#dispatch(preparationSignal, admittingCommandId);
    }
    if (
      admission.state === 'reserved'
        ? !this.owners.store.claimOrdinaryLocalVertexCommandDispatch(commandId)
        : !this.owners.ownsClaim?.(commandId) ||
          !!this.owners.store.getExecutionAdmission(this.owners.sessionId, commandId)
    )
      throw Error('SDK dispatch cannot be replayed');
    if (!this.owners.store.deployment.canDispatch(this.owners.sessionId)) return;
    const execution = this.owners.store.beginOrdinaryLocalVertexCommandExecution(
      this.owners.sessionId,
      commandId,
    ).token;
    this.#active = { commandId, execution };
    this.#dispatchingCommandId = undefined;
    // No running turn exists here. SDK control calls are acknowledged before
    // yielding the next frozen user input; tool-result continuations bypass this.
    if (this.owners.query.applySettings) {
      await this.owners.query.applySettings(structuredClone(admission.selection));
      await this.#fence();
      assertPreparation();
    } else {
      await this.owners.query.setModel(settings.model);
      await this.#fence();
      assertPreparation();
      await this.owners.query.setMaxThinkingTokens(settings.thinkingTokens);
      await this.#fence();
      assertPreparation();
    }
    const payload = this.owners.store.getSendCommand(commandId)!.payload;
    this.#inputDispatched = commandId;
    await this.owners.query.push(commandId, structuredClone(admission), structuredClone(payload));
    await this.#fence();
    assertPreparation();
    this.owners.store.completeOrdinaryLocalVertexCommand(commandId);
    this.#pending.shift();
  }
}
