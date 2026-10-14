import type { EventStore } from './event-store.js';
import type { ExecutionToken } from '@mitzo/protocol';
import type { OrdinaryLocalCommandAdmission } from '@mitzo/protocol';

/** A FIFO controller for one existing SDK query. The durable queue is the existing
 * ordinary/send ledger; this object only tracks the live query's active command. */
export class OrdinaryLocalVertexCommandOwner {
  #active?: { commandId: string; execution: ExecutionToken };
  #pending: string[] = [];
  #serial: Promise<void> = Promise.resolve();
  #failed = false;
  #inputUuid?: string;
  #inputDispatched?: string;
  #dispatchingCommandId?: string;
  #paused = false;
  constructor(
    private readonly owners: {
      store: EventStore;
      sessionId: string;
      assertCurrent(): Promise<void> | void;
      ownsClaim?(commandId: string): boolean;
      onTerminal?(commandId: string): void;
      query: {
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
  complete(commandId: string, failed = false): Promise<void> {
    return this.#serialize(async () => {
      await this.#fence();
      if (this.#active?.commandId !== commandId)
        throw Error('SDK result does not match active command');
      const stopping =
        this.owners.store.getSession(this.owners.sessionId)?.executionPhase === 'STOPPING';
      this.owners.store.transitionExecution(
        this.#active.execution,
        'TERMINAL',
        stopping ? 'stopped' : failed ? 'failed' : 'completed',
      );
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
  }
  resultObserved(inputUuid: string | undefined, failed = false): Promise<void> {
    if (!this.#active || !inputUuid || this.#inputUuid !== inputUuid) {
      this.#failed = true;
      this.owners.query.abort();
      return Promise.reject(Error('Original SDK result identity unavailable'));
    }
    const commandId = this.#active.commandId;
    this.#inputUuid = undefined;
    return this.complete(commandId, failed);
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
