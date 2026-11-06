import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionRequest, QuestionAnswers } from '@mitzo/protocol';
import type { ToolTier } from './tool-tiers.js';
import { isDeepStrictEqual } from 'node:util';
import { recordPermissionAudit } from './permission-audit.js';
import { createLogger } from './logger.js';
const log = createLogger('permissions');

export interface PendingTelosSourceReview {
  permId: string;
  sessionId: string;
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  expiresAt: number;
}

// A policy-aware resolver can return the final SDK result. Legacy callbacks may
// return nothing (or incidental values), in which case the input is authoritative.
type PermissionResolver = (result: PermissionResult) => unknown;

interface PendingEntry {
  createdAt: number;
  audit?: { toolUseID: string; scopeHash: string };
  resolver: PermissionResolver;
  toolName: string;
  toolInput: Record<string, unknown>;
  tier?: ToolTier;
  sessionId?: string;
  request?: PermissionRequest;
  review?: { toolUseId: string; operatorId?: string; canApprove?(): boolean };
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
    } catch (error) {
      log.warn('Permission lifecycle observer failed; decision authority is unchanged', {
        phase: event.type,
        errorType: error instanceof Error ? error.name : 'non-Error',
      });
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
  review?: { toolUseId: string; operatorId?: string; canApprove?(): boolean },
  audit?: { toolUseID: string; scopeHash: string },
) {
  pending.set(permId, {
    createdAt: Date.now(),
    audit,
    resolver,
    toolName,
    toolInput: structuredClone(toolInput),
    tier,
    sessionId,
    request,
    review,
  });
  recordPermissionAudit({
    phase: 'requested',
    time: Date.now(),
    sessionId,
    permId,
    toolName,
    ...audit,
    approvalScope: request?.approvalScope,
  });
  if (request) notifyLifecycle({ type: 'requested', request });
}

/** Verify the display covers every parameter of the live Bash execution. */
export function isCompletePendingBashCommand(request: PermissionRequest): boolean {
  const entry = pending.get(request.permId);
  return (
    !!entry &&
    entry.toolName === 'Bash' &&
    entry.sessionId === request.sessionId &&
    Object.keys(entry.toolInput).length === 1 &&
    Object.hasOwn(entry.toolInput, 'command') &&
    entry.toolInput.command === request.toolInput
  );
}

export function resolvePending(
  permId: string,
  decision: 'once' | 'always' | 'deny',
  answers?: QuestionAnswers,
  sessionId?: string,
  /** Internal policy denial; never supplied by a transport response. */
  denialReason?: string,
  /** Host-only retained source receipt, never accepted by generic transports. */
  reviewedReceiptId?: string,
): boolean {
  const entry = pending.get(permId);
  if (!entry || (sessionId && entry.sessionId && entry.sessionId !== sessionId)) return false;
  if (entry.request?.reviewKind === 'telos_source' && decision !== 'deny' && !reviewedReceiptId)
    return false;

  // Timer callbacks can be delayed while transports reconnect or the event loop
  // is busy. The advertised absolute deadline remains authoritative.
  if (entry.request?.expiresAt !== undefined && entry.request.expiresAt <= Date.now()) {
    pending.delete(permId);
    applyPendingResult(
      entry,
      permId,
      {
        behavior: 'deny',
        message: 'Tool approval expired without a response; request approval again',
      },
      decision,
      'expired',
    );
    return false;
  }

  let toolInput = entry.toolInput;
  if (reviewedReceiptId) toolInput = { ...toolInput, __mitzoTelosApproval: reviewedReceiptId };
  // Questions never grant session-wide tool permission. Treat a legacy/malformed
  // "always" response as a one-shot answer instead of leaving it pending forever.
  const effectiveDecision = entry.request?.questions && decision === 'always' ? 'once' : decision;
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
      message: denialReason ?? 'User denied',
      ...(denialReason ? {} : { decisionClassification: 'user_reject' as const }),
    };
  }
  applyPendingResult(entry, permId, requestedResult, effectiveDecision);
  return true;
}

/** Every terminal resolver path shares the same failure and decision reporting. */
function applyPendingResult(
  entry: PendingEntry,
  permId: string,
  requestedResult: PermissionResult,
  decision?: 'once' | 'always' | 'deny',
  fixedOutcome?: 'denied' | 'expired' | 'cancelled',
) {
  let appliedResult: unknown;
  try {
    appliedResult = entry.resolver(requestedResult);
  } catch (error) {
    auditResolution(entry, permId, 'failed', decision);
    notifyLifecycle({ type: 'resolved', permId, resolution: 'denied' });
    log.error('Permission resolver failed; no allow receipt was recorded', {
      permId,
      sessionId: entry.sessionId,
      errorType: error instanceof Error ? error.name : 'non-Error',
    });
    throw error;
  }
  const behavior =
    appliedResult &&
    typeof appliedResult === 'object' &&
    'behavior' in appliedResult &&
    (appliedResult.behavior === 'allow' || appliedResult.behavior === 'deny')
      ? appliedResult.behavior
      : requestedResult.behavior;

  const outcome =
    fixedOutcome ??
    (entry.request?.expiresAt !== undefined && entry.request.expiresAt <= Date.now()
      ? 'expired'
      : behavior === 'deny'
        ? 'denied'
        : 'allowed');
  notifyLifecycle({
    type: 'resolved',
    permId,
    resolution: outcome === 'cancelled' ? 'expired' : outcome,
  });
  auditResolution(entry, permId, outcome, decision);
}

function auditResolution(
  entry: PendingEntry,
  permId: string,
  outcome: 'allowed' | 'denied' | 'expired' | 'cancelled' | 'failed',
  decision?: 'once' | 'always' | 'deny',
) {
  recordPermissionAudit({
    phase: 'resolved',
    time: Date.now(),
    sessionId: entry.sessionId,
    permId,
    toolName: entry.toolName,
    ...entry.audit,
    approvalScope: entry.request?.approvalScope,
    outcome,
    decision,
    waitMs: Math.max(0, Date.now() - entry.createdAt),
  });
}

/** Exact host invocation metadata. Request JSON and display text are not proof. */
export function getPendingTelosSourceReview(
  permId: string,
  sessionId: string,
): PendingTelosSourceReview | undefined {
  const entry = pending.get(permId);
  if (
    !entry ||
    entry.sessionId !== sessionId ||
    entry.request?.reviewKind !== 'telos_source' ||
    !entry.review?.toolUseId ||
    !entry.request.expiresAt ||
    entry.request.expiresAt <= Date.now() ||
    entry.review.canApprove?.() === false
  )
    return;
  return {
    permId,
    sessionId,
    toolUseId: entry.review.toolUseId,
    toolName: entry.toolName,
    toolInput: structuredClone(entry.toolInput),
    expiresAt: entry.request.expiresAt,
  };
}

/** Private renewal of the ORIGINAL permission entry, not authority from public
 * proof fields. Native-bound entries also retain their original signed operator.
 * Completed receipts use their existing read/recovery paths instead of this fence.
 */
export function capturePendingTelosSourceReviewCurrent(
  proof: PendingTelosSourceReview,
  operatorId: string,
): ((() => void) & Readonly<{ requiresLiveNativeCall: boolean }>) | undefined {
  if (typeof operatorId !== 'string' || !operatorId.trim()) return;
  const original = pending.get(proof.permId);
  const expected = structuredClone(proof);
  const current = () => {
    try {
      return (
        !!original &&
        pending.get(expected.permId) === original &&
        (original.review?.operatorId === undefined || original.review.operatorId === operatorId) &&
        isDeepStrictEqual(
          getPendingTelosSourceReview(expected.permId, expected.sessionId),
          expected,
        )
      );
    } catch {
      return false;
    }
  };
  if (!current()) return;
  return Object.freeze(
    Object.assign(
      () => {
        if (!current()) throw Error('Original reviewed source invocation is no longer current');
      },
      { requiresLiveNativeCall: original!.review?.operatorId !== undefined },
    ),
  );
}

/** Called only after the source owner has durably retained the exact approval. */
export function resolveReviewedTelosSourcePermission(
  proof: PendingTelosSourceReview,
  receiptId: string,
): boolean {
  const current = getPendingTelosSourceReview(proof.permId, proof.sessionId);
  if (!current || !isDeepStrictEqual(current, proof)) return false;
  return resolvePending(proof.permId, 'once', undefined, proof.sessionId, undefined, receiptId);
}

/** Denial only: dismiss retained consent without orphaning the same live tool.
 * Expiry and policy changes cannot grant authority here; they need not block denial.
 */
export function dismissReviewedTelosSourcePermission(proof: PendingTelosSourceReview): boolean {
  const entry = pending.get(proof.permId);
  if (
    !entry ||
    entry.sessionId !== proof.sessionId ||
    entry.request?.reviewKind !== 'telos_source' ||
    entry.review?.toolUseId !== proof.toolUseId ||
    entry.toolName !== proof.toolName ||
    !isDeepStrictEqual(entry.toolInput, proof.toolInput)
  )
    return false;
  // This exact retained-save denial is independent of the old approval
  // deadline. Generic expiry guidance must not invite a duplicate save.
  pending.delete(proof.permId);
  applyPendingResult(
    entry,
    proof.permId,
    {
      behavior: 'deny',
      message: 'Reviewed save dismissed; retained save results remain recoverable',
    },
    undefined,
    'denied',
  );
  return true;
}

export function removePending(permId: string, outcome: 'expired' | 'cancelled' = 'expired') {
  const entry = pending.get(permId);
  if (entry && pending.delete(permId)) {
    notifyLifecycle({ type: 'resolved', permId, resolution: 'expired' });
    auditResolution(entry, permId, outcome);
  }
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
      applyPendingResult(
        entry,
        permId,
        {
          behavior: 'deny',
          message: 'Session taken over by another device',
          decisionClassification: 'user_reject',
        },
        undefined,
        'cancelled',
      );
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
