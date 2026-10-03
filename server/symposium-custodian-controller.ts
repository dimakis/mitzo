import type { CapabilityApproval } from './connections/capabilities/types.js';
import { decodeCustodianRequest, type CustodianRequest } from './symposium-custodian-protocol.js';
export interface CustodianResponse {
  status: number;
  body: unknown;
}
interface Owner {
  pause(): void;
  drain(signal: AbortSignal): Promise<void>;
  resume(): void;
  invalidate(jti: string): void;
  dispatch(
    request: CustodianRequest,
    assertCurrent: () => void,
    approval?: CapabilityApproval,
    signal?: AbortSignal,
  ): Promise<CustodianResponse>;
}
/** Process-local authority. There is deliberately no deserialize/adopt operation. */
export class SymposiumCustodianController {
  private epoch = 0;
  private state: 'ready' | 'active' | 'draining' | 'uncertain' = 'ready';
  constructor(
    private readonly owner: Owner,
    private readonly cleanupTimeoutMs = 120_000,
  ) {}
  attach() {
    if (this.state !== 'ready')
      throw Error(
        this.state === 'active'
          ? 'A controller is already active'
          : 'Controller cleanup is incomplete',
      );
    this.owner.resume();
    const epoch = ++this.epoch;
    this.state = 'active';
    const sessions = new Set<string>();
    const revoked = new Set<string>();
    const pending = new Set<Promise<unknown>>();
    let loss: Promise<void> | undefined;
    const assertCurrent = () => {
      if (this.state !== 'active' || this.epoch !== epoch)
        throw Error('Custodian controller is unavailable');
    };
    const request = async (input: unknown, approval?: CapabilityApproval, signal?: AbortSignal) => {
      assertCurrent();
      const command = decodeCustodianRequest(input);
      if (command.epoch !== epoch) throw Error('Custodian epoch changed');
      const authorize = () => {
        assertCurrent();
        if (command.authorization.expiresAt <= Date.now() || revoked.has(command.authorization.id))
          throw Error('Operator authorization expired or revoked');
      };
      authorize();
      if (pending.size >= 64) throw Error('Custodian request capacity unavailable');
      sessions.add(command.authorization.id);
      const inventoryRead = ['personal.list', 'account.catalog'].includes(command.operation);
      if (inventoryRead) signal?.throwIfAborted();
      const dispatched = this.owner.dispatch(
        command,
        authorize,
        approval &&
          (async (request, signal) => {
            authorize();
            const result = await approval(request, signal);
            authorize();
            return result;
          }),
        signal,
      );
      let onAbort: (() => void) | undefined;
      // Only metadata reads may release capacity before an uncooperative handler settles.
      // Side-effecting operations retain their reconciliation/drain contract.
      const work =
        inventoryRead && signal
          ? Promise.race([
              dispatched,
              new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(Error('Custodian read cancelled'));
                signal.addEventListener('abort', onAbort, { once: true });
                if (signal.aborted) onAbort();
              }),
            ])
          : dispatched;
      pending.add(work);
      try {
        const result = await work;
        authorize();
        if (inventoryRead) signal?.throwIfAborted();
        return result;
      } finally {
        pending.delete(work);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
      }
    };
    return {
      epoch,
      request,
      invalidate: (jti: string) => {
        assertCurrent();
        revoked.add(jti);
        this.owner.invalidate(jti);
      },
      lost: () => {
        if (loss) return loss;
        assertCurrent();
        this.state = 'draining';
        this.owner.pause();
        for (const jti of sessions) this.owner.invalidate(jti);
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = (async () => {
          await this.owner.drain(abort.signal);
          await Promise.allSettled([...pending]);
          abort.signal.throwIfAborted();
        })();
        loss = Promise.race([
          cleanup,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = Error('Controller cleanup timed out; outcome uncertain');
              abort.abort(error);
              reject(error);
            }, this.cleanupTimeoutMs);
          }),
        ])
          .then(
            () => {
              this.state = 'ready';
            },
            (error: unknown) => {
              this.state = 'uncertain';
              throw error;
            },
          )
          .finally(() => clearTimeout(timer));
        return loss;
      },
    };
  }
}
