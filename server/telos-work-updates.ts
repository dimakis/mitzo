import { createLogger } from './logger.js';
import {
  describeTelosOperationFailure,
  retainTelosDiagnosticFailure,
} from './telos-operation-failure.js';

const listeners = new Set<() => void>();

/** A post-commit invalidation carries no work identity, content or authority. */
export function publishTelosWorkUpdate(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (cause) {
      try {
        createLogger('telos-work-updates').warn('Canonical work refresh unavailable', {
          code: 'telos_work_refresh_unavailable',
          stage: 'post_commit_notification',
          ...describeTelosOperationFailure(cause),
        });
      } catch (diagnosticCause) {
        retainTelosDiagnosticFailure(cause, diagnosticCause, { stage: 'post_commit_notification' });
      }
    }
  }
}

export function bindTelosWorkUpdateBroadcast(registry: {
  broadcast(event: string, data: Record<string, unknown>): void;
}): () => void {
  const refresh = () => registry.broadcast('todo_update', { action: 'refresh' });
  listeners.add(refresh);
  return () => {
    listeners.delete(refresh);
  };
}
