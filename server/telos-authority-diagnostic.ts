import { createLogger } from './logger.js';
import { SessionRuntimeError } from './session-runtime-error.js';

/** Invalid async callbacks never grant authority. Drain their late rejection
 * with a correlated, sanitized diagnostic while retaining the upstream cause. */
export function drainRejectedTelosAuthority(
  result: unknown,
  stage: 'item-authority' | 'backlog-authority',
  context: { conversationId?: string; requestHash?: string } = {},
): void {
  void Promise.resolve(result).catch((cause: unknown) => {
    const failure = new SessionRuntimeError('runtime_unavailable', { cause });
    createLogger('telos-authority').warn('Rejected asynchronous Telos authority callback', {
      ...context,
      stage,
      code: 'ASYNC_AUTHORITY_REJECTED',
      ...failure.telemetry(),
    });
  });
}
