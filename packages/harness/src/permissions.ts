import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionRequest, QuestionAnswers } from '@mitzo/protocol';
import type { ToolTier } from './tool-tiers.js';

// A policy-aware resolver can return the final SDK result. Legacy callbacks may
// return nothing (or incidental values), in which case the input is authoritative.
type PermissionResolver = (result: PermissionResult) => unknown;

interface PendingEntry {
  resolver: PermissionResolver;
  toolName: string;
  toolInput: Record<string, unknown>;
  tier?: ToolTier;
  sessionId?: string;
  request?: PermissionRequest;
}

const pending = new Map<string, PendingEntry>();

export type PermissionLifecycleEvent =
  | { type: 'requested'; request: PermissionRequest }
  | { type: 'resolved'; permId: string; resolution: 'allowed' | 'denied' | 'expired' };
const lifecycleListeners = new Set<(event: PermissionLifecycleEvent) => void>();
export function onPermissionLifecycle(
  listener: (event: PermissionLifecycleEvent) => void,
): () => void {
  lifecycleListeners.add(listener);
  return () => {
    lifecycleListeners.delete(listener);
  };
}
function notifyLifecycle(event: PermissionLifecycleEvent): void {
  for (const listener of lifecycleListeners) {
    try {
      listener(structuredClone(event));
    } catch {
      /* Notification failures cannot change authority. */
    }
  }
}

export function registerPending(
  permId: string,
  toolName: string,
  resolver: PermissionResolver,
  toolInput: Record<string, unknown>,
  tier?: ToolTier,
  sessionId?: string,
  request?: PermissionRequest,
) {
  pending.set(permId, { resolver, toolName, toolInput, tier, sessionId, request });
  if (request) notifyLifecycle({ type: 'requested', request });
}

export function resolvePending(
  permId: string,
  decision: 'once' | 'always' | 'deny',
  answers?: QuestionAnswers,
  sessionId?: string,
): boolean {
  const entry = pending.get(permId);
  if (!entry || (sessionId && entry.sessionId && entry.sessionId !== sessionId)) return false;

  let toolInput = entry.toolInput;
  // Questions never grant session-wide tool permission. Treat a legacy/malformed
  // "always" response as a one-shot answer instead of leaving it pending forever.
  const effectiveDecision =
    (entry.request?.questions || entry.request?.approvalScope === 'request') &&
    decision === 'always'
      ? 'once'
      : decision;
  if (entry.request?.questions && effectiveDecision !== 'deny') {
    if (!answers || Object.keys(answers).length !== entry.request.questions.length) return false;
    for (const question of entry.request.questions) {
      const answer = answers[question.id];
      if (
        !Array.isArray(answer) ||
        !answer.length ||
        answer.length > 9 ||
        (!question.multiSelect && answer.length !== 1) ||
        answer.some((value) => typeof value !== 'string' || !value.trim() || value.length > 4000) ||
        (question.allowFreeform === false &&
          answer.some((value) => !question.options.some((option) => option.label === value)))
      )
        return false;
    }
    toolInput = {
      ...toolInput,
      answers: Object.fromEntries(
        entry.request.questions.map((question) => [
          question.question,
          answers[question.id].length === 1
            ? answers[question.id][0]
            : JSON.stringify(answers[question.id]),
        ]),
      ),
    };
  }
  pending.delete(permId);
  const { resolver } = entry;

  let requestedResult: PermissionResult;
  if (effectiveDecision === 'always') {
    requestedResult = {
      behavior: 'allow',
      decisionClassification: 'user_permanent',
      updatedInput: toolInput,
    };
  } else if (effectiveDecision === 'once') {
    requestedResult = {
      behavior: 'allow',
      decisionClassification: 'user_temporary',
      updatedInput: toolInput,
    };
  } else {
    requestedResult = {
      behavior: 'deny',
      message: 'User denied',
      decisionClassification: 'user_reject',
    };
  }
  const appliedResult = resolver(requestedResult);
  const behavior =
    appliedResult &&
    typeof appliedResult === 'object' &&
    'behavior' in appliedResult &&
    (appliedResult.behavior === 'allow' || appliedResult.behavior === 'deny')
      ? appliedResult.behavior
      : requestedResult.behavior;

  notifyLifecycle({
    type: 'resolved',
    permId,
    resolution:
      entry.request?.expiresAt !== undefined && entry.request.expiresAt <= Date.now()
        ? 'expired'
        : behavior === 'deny'
          ? 'denied'
          : 'allowed',
  });
  return true;
}

export function removePending(permId: string) {
  if (pending.delete(permId)) notifyLifecycle({ type: 'resolved', permId, resolution: 'expired' });
}

export function hasPending(permId: string): boolean {
  return pending.has(permId);
}

/** Session owning a live approval, used to authenticate reconnect responses. */
export function getPendingSessionId(permId: string): string | undefined {
  return pending.get(permId)?.sessionId;
}

/**
 * Count pending permission requests for a specific session.
 */
export function getPendingCountBySession(sessionId: string): number {
  let count = 0;
  for (const entry of pending.values()) {
    if (entry.sessionId === sessionId) count++;
  }
  return count;
}

/**
 * Deny all pending permission requests associated with a session.
 */
export function denyPendingBySession(sessionId: string): number {
  let denied = 0;
  for (const [permId, entry] of pending) {
    if (entry.sessionId === sessionId) {
      pending.delete(permId);
      entry.resolver({
        behavior: 'deny',
        message: 'Session taken over by another device',
        decisionClassification: 'user_reject',
      });
      notifyLifecycle({ type: 'resolved', permId, resolution: 'expired' });
      denied++;
    }
  }
  return denied;
}

/** Live interaction replay; never replay resolved requests or side effects. */
export function getPendingRequestsBySession(sessionId: string): PermissionRequest[] {
  return [...pending.values()]
    .filter((entry) => entry.sessionId === sessionId && entry.request)
    .map((entry) => structuredClone(entry.request!));
}
