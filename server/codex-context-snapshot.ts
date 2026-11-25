import {
  ContextSnapshotScopeSchema,
  contextSnapshotScopeKey,
  type ContextSnapshotOwner,
  type ContextSnapshotReason,
  type ContextSnapshotScope,
} from '@mitzo/protocol';
import type { ManagedSession } from './session-registry.js';
import type { ContextSnapshotLifecycle } from './context-snapshot-lifecycle.js';
import { normalizeCodexContext } from './context-measurement-adapters.js';
import { observedCodexUsage } from './codex-turn-usage.js';
import { createLogger } from './logger.js';

const log = createLogger('codex-context-snapshot');
/** Host callbacks on the existing native owner. No collection or allocation port. */
export interface CodexContextSnapshotEvents {
  turnStarted(): void;
  usage(params: Record<string, unknown>): void;
  invalidate(reason: ContextSnapshotReason): void;
}

export function createCodexContextSnapshotAdapter(options: {
  session: ManagedSession;
  lifecycle: ContextSnapshotLifecycle;
  /** Passive exact ACK-bound scope from the existing conversation. */
  current(): ContextSnapshotScope | undefined;
  /** Read-only retained authority check; never account/runtime acquisition. */
  assertCurrent(): void;
}): CodexContextSnapshotEvents {
  let owner: ContextSnapshotOwner | undefined;
  let latestTotal: number | undefined;
  const current = () => {
    options.session.abortController.signal.throwIfAborted();
    options.assertCurrent();
    return options.current();
  };
  const matches = (scope: ContextSnapshotScope) => {
    const active = current();
    return !!active && contextSnapshotScopeKey(active) === contextSnapshotScopeKey(scope);
  };
  const invalidate = (reason: ContextSnapshotReason) => {
    // A retired conversation must not invalidate its successor's evidence.
    if (!owner || options.session.contextSnapshotOwner !== owner) return;
    try {
      options.lifecycle.invalidate(owner.scope.identity.sessionId, reason);
    } catch (error) {
      log.warn('Codex context snapshot invalidation failed', {
        sessionId: owner.scope.identity.sessionId,
        stage: 'snapshot_invalidate',
        reason: 'storage_failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  };
  return {
    turnStarted() {
      let scope: ContextSnapshotScope | undefined;
      try {
        scope = current();
      } catch {
        invalidate('authority_expired');
        return;
      }
      if (!scope || scope.binding.engine !== 'codex' || scope.binding.placement !== 'local') return;
      const parsed = ContextSnapshotScopeSchema.safeParse(scope);
      if (!parsed.success || parsed.data.identity.sessionId !== options.session.sessionId) return;
      invalidate('scope_changed');
      const captured = parsed.data;
      owner = {
        scope: captured,
        get state() {
          try {
            return matches(captured) ? 'active' : 'retired';
          } catch {
            return 'retired';
          }
        },
        // Event-only adapter deliberately omits collect: refresh_unsupported.
      };
      latestTotal = undefined;
      options.session.contextSnapshotOwner = owner;
    },
    invalidate,
    usage(params) {
      if (!owner || options.session.contextSnapshotOwner !== owner) return;
      try {
        if (!matches(owner.scope)) return;
      } catch {
        invalidate('authority_expired');
        return;
      }
      const usage = observedCodexUsage(params);
      if (!usage || (latestTotal !== undefined && usage.sessionTotal <= latestTotal)) return;
      let snapshot;
      try {
        snapshot = normalizeCodexContext(params, { ...owner.scope, observedAt: Date.now() });
      } catch {
        // Untrusted malformed/mismatched events are not measurements.
        return;
      }
      // Keep the watermark across compaction and detach, so replay cannot make
      // an old request current. A new native turn installs a new owner/watermark.
      latestTotal = usage.sessionTotal;
      options.lifecycle.observe(owner, snapshot);
    },
  };
}
