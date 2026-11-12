import { createLogger } from './logger.js';
const log = createLogger('ordinary-turn-lifecycle');

/** TypeScript's void callbacks also accept async functions. An effect fence
 * must finish synchronously; retain an unexpected rejection without releasing
 * the provider input or turning it into an unhandled promise. */
export function assertOrdinarySynchronousFence(commandId: string, fence: () => void): void {
  const result: unknown = fence();
  if (result !== undefined) {
    void Promise.resolve(result).catch((err) =>
      log.error('Ordinary turn fence rejected after its synchronous boundary', {
        err,
        commandId,
        code: 'ordinary_turn_fence_rejected',
        stage: 'before_provider_input',
      }),
    );
    throw Error('Synchronous ordinary turn authority required');
  }
}

export type { OrdinaryTurnLifecycle } from '@mitzo/protocol';
