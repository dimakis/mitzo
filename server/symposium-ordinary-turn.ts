import type { OrdinaryContributorExecution } from './ordinary-contributor-execution.js';
import { randomUUID } from 'node:crypto';
import type { AccountBinding, MitzoMode } from '@mitzo/protocol';
import type { SessionTransport } from '@mitzo/harness';
import type { AccountProfiles } from './account-profiles.js';
import type { OrdinaryTurnLifecycle } from './ordinary-turn-lifecycle.js';
import type { SymposiumSeatExecutionResult } from './symposium-orchestrator.js';
import type { OrdinarySymposiumTurn } from './symposium-shared-execution.js';

export interface OrdinaryChatPort {
  startChat(
    transport: SessionTransport,
    clientId: string,
    prompt: string,
    options: {
      resume?: string;
      initialSessionId?: string;
      cwd?: string;
      mode?: MitzoMode;
      accountId?: string;
      model?: string;
      reasoningEffort?: string | null;
      accountProfiles?: AccountProfiles;
      contextBlocks?: string[];
      contributorGuidance?: string;
      retainWorkspace?: boolean;
      contributorExecution?: OrdinaryContributorExecution;
      clientMsgId?: string;
      operatorConnectionId?: string;
      telosTaskId?: string;
      ordinaryTurnLifecycle?: OrdinaryTurnLifecycle;
      onQueryReady?: (query: { interrupt(): Promise<void> }) => void;
      onTurnResult?: (result: { is_error?: boolean }, inputUuid?: string) => void;
    },
  ): Promise<void>;
  stopChat(clientId: string): void;
}

/** One ordinary Codex query per delivery, resumed against the retained seat's child session. */
export function createOrdinarySymposiumTurn(deps: {
  port: OrdinaryChatPort;
  binding: AccountBinding;
  cwd: string;
  mode: MitzoMode;
  accountProfiles?: AccountProfiles;
  operatorConnectionId?: string;
  additionalGuidance?: string;
  newSessionId?: () => string;
  cancellationTimeoutMs?: number;
}): OrdinarySymposiumTurn {
  if (deps.binding.provider !== 'openai-codex')
    throw new Error('Exact ordinary turn lifecycle is available only for Codex accounts');
  let started = false;
  let cancelled = false;
  let dispatched = false;
  let terminal: { turn: string; status: 'completed' | 'interrupted' | 'failed' } | undefined;
  let acceptedTurn: string | undefined;
  let terminalConflict = false;
  let query: { interrupt(): Promise<void> } | undefined;
  let queryClosed: Promise<void> | undefined;
  let queryEnded = false;
  let interrupting: Promise<void> | undefined;
  let failure: Error | undefined;
  let sessionId = '';
  const clientId = `symposium-ordinary:${randomUUID()}`;
  let notifyTerminal!: () => void;
  const terminalObserved = new Promise<void>((resolve) => {
    notifyTerminal = resolve;
  });
  const requestInterrupt = () => {
    if (query && !terminal && !interrupting) {
      interrupting = query.interrupt();
      void interrupting.catch(() => {});
    }
  };
  return {
    async run(input, callbacks): Promise<SymposiumSeatExecutionResult> {
      if (started) throw new Error('Ordinary Symposium turn already started');
      started = true;
      if (cancelled) throw new Error('Ordinary Symposium turn cancelled before dispatch');
      input.signal.throwIfAborted();
      if (
        input.seat.accountBinding?.accountId !== deps.binding.accountId ||
        input.seat.accountBinding?.profileRevision !== deps.binding.profileRevision ||
        input.seat.accountBinding?.provider !== deps.binding.provider ||
        input.seat.accountBinding?.model !== deps.binding.model ||
        input.seat.model !== deps.binding.model
      )
        throw new Error('Ordinary Symposium account selection changed');
      sessionId = input.providerThreadId ?? deps.newSessionId?.() ?? randomUUID();
      if (sessionId === input.sessionId)
        throw new Error('Contributor must use an independent ordinary session');
      const textBlocks = new Map<string, string>();
      const transport: SessionTransport = {
        isOpen: () => true,
        send(event) {
          if (event.type === 'error' && typeof event.error === 'string')
            failure ??= new Error(event.error);
          if (
            event.type === 'block_start' &&
            event.blockType === 'text' &&
            typeof event.blockId === 'string'
          )
            textBlocks.set(event.blockId, '');
          if (
            event.type === 'block_delta' &&
            typeof event.blockId === 'string' &&
            textBlocks.has(event.blockId) &&
            typeof event.delta === 'string'
          )
            textBlocks.set(event.blockId, textBlocks.get(event.blockId)! + event.delta);
        },
      };
      const exactCommand = (commandId: string) => {
        if (commandId !== input.idempotencyKey)
          throw new Error('Ordinary Symposium command identity changed');
      };
      // Capture synchronous mock failures as a settled startup promise as well.
      queryClosed = Promise.resolve()
        .then(() =>
          deps.port.startChat(transport, clientId, input.content, {
            ...(input.providerThreadId ? { resume: sessionId } : { initialSessionId: sessionId }),
            cwd: deps.cwd,
            mode: deps.mode,
            accountId: deps.binding.accountId,
            model: deps.binding.model,
            reasoningEffort: input.seat.reasoningEffort,
            accountProfiles: deps.accountProfiles,
            operatorConnectionId: deps.operatorConnectionId,
            contributorGuidance:
              input.seat.systemPrompt +
              (deps.additionalGuidance
                ? `\n\nAdditional user guidance for this contributor session:\n${deps.additionalGuidance}`
                : ''),
            retainWorkspace: true,
            contributorExecution: {
              coordinatorSessionId: input.sessionId,
              deliveryId: input.deliveryId,
              seatId: input.seat.id,
              claimToken: input.claimToken,
              idempotencyKey: input.idempotencyKey,
            },
            clientMsgId: input.idempotencyKey,
            ordinaryTurnLifecycle: {
              beforeDispatch(commandId) {
                exactCommand(commandId);
                if (cancelled) throw new Error('Ordinary Symposium turn cancelled');
                callbacks.beforeDispatch();
                dispatched = true;
              },
              accepted(commandId, _rawThread, rawTurn) {
                exactCommand(commandId);
                if (!dispatched || !rawTurn || (acceptedTurn && acceptedTurn !== rawTurn))
                  throw new Error('Ordinary Symposium acceptance identity changed');
                acceptedTurn = rawTurn;
                callbacks.accepted(sessionId, rawTurn);
                if (cancelled) requestInterrupt();
              },
              terminal(commandId, rawTurn, status) {
                exactCommand(commandId);
                if (
                  !acceptedTurn ||
                  acceptedTurn !== rawTurn ||
                  (terminal && (terminal.turn !== rawTurn || terminal.status !== status))
                )
                  throw new Error('Ordinary Symposium terminal identity changed');
                terminal = { turn: rawTurn, status };
                notifyTerminal();
              },
              terminalConflict(commandId, rawTurn) {
                exactCommand(commandId);
                if (rawTurn !== acceptedTurn)
                  throw new Error('Ordinary Symposium terminal identity changed');
                terminalConflict = true;
              },
            },
            onQueryReady(ready) {
              query = ready;
              if (cancelled) requestInterrupt();
            },
            onTurnResult() {
              if (terminal) deps.port.stopChat(clientId);
            },
          }),
        )
        .finally(() => {
          queryEnded = true;
        });
      await queryClosed;
      if (!terminal || terminalConflict)
        throw failure ?? new Error('Ordinary Symposium provider termination is unconfirmed');
      if (cancelled || input.signal.aborted || terminal.status === 'interrupted')
        throw new Error('Ordinary Symposium turn cancelled');
      if (terminal.status !== 'completed')
        throw failure ?? new Error('Ordinary Symposium provider turn failed');
      return { providerThreadId: sessionId, content: [...textBlocks.values()].join('\n\n') };
    },
    async cancelAndDrain() {
      cancelled = true;
      if (!started) return;
      requestInterrupt();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          terminalObserved,
          queryClosed ?? Promise.resolve(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Ordinary Symposium provider termination is unconfirmed')),
              deps.cancellationTimeoutMs ?? 30_000,
            );
          }),
        ]);
        if ((!terminal && dispatched) || terminalConflict)
          throw new Error('Ordinary Symposium provider termination is unconfirmed');
        if (terminal) deps.port.stopChat(clientId);
        await queryClosed;
        // An interrupt ACK/error is no longer relevant once the exact terminal
        // notification and query closure prove that this attempt has stopped.
      } catch (error) {
        if (dispatched || !queryEnded) throw error;
        // The trusted pre-dispatch hook did not release a provider send. Startup
        // rejection cannot be cleaned up by interrupting someone else's query.
        await queryClosed?.catch(() => {});
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
