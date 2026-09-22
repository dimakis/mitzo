import { createHash } from 'node:crypto';
import type { AccountBinding, ExecutionToken } from '@mitzo/protocol';
import { ExecutionAdmissionError } from '@mitzo/protocol/event-store';
import type { EventStore } from './event-store.js';

export interface ProviderDispatchRequest {
  sessionId: string;
  clientMsgId: string;
  effectivePrompt: string;
  fingerprintSource?: string;
  model?: string;
  reasoningEffort?: string | null;
  accountBinding?: Pick<AccountBinding, 'accountId' | 'provider' | 'profileRevision'>;
}

export interface ProviderDispatchAdmission {
  token: ExecutionToken;
  providerAttemptId: string;
  requestFingerprint: string;
  duplicate: boolean;
}

const PROVIDER_FINGERPRINT_VERSION = 'v2:';

function hashFingerprint(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
}

function legacyProviderDispatchFingerprint(request: ProviderDispatchRequest): string {
  return hashFingerprint({
    effectivePrompt: request.fingerprintSource ?? request.effectivePrompt,
    model: request.model ?? null,
    reasoningEffort: {
      specified: request.reasoningEffort !== undefined,
      value: request.reasoningEffort ?? null,
    },
  });
}

function accountBoundProviderDispatchFingerprint(request: ProviderDispatchRequest): string {
  return hashFingerprint({
    effectivePrompt: request.fingerprintSource ?? request.effectivePrompt,
    model: request.model ?? null,
    reasoningEffort: {
      specified: request.reasoningEffort !== undefined,
      value: request.reasoningEffort ?? null,
    },
    accountBinding: request.accountBinding
      ? {
          accountId: request.accountBinding.accountId,
          provider: request.accountBinding.provider,
          profileRevision: request.accountBinding.profileRevision,
        }
      : null,
  });
}

function fingerprintProviderDispatch(request: ProviderDispatchRequest): string {
  return PROVIDER_FINGERPRINT_VERSION + accountBoundProviderDispatchFingerprint(request);
}

function sameAccountBinding(
  left: ProviderDispatchRequest['accountBinding'],
  right: ProviderDispatchRequest['accountBinding'],
): boolean {
  return (
    !!left &&
    !!right &&
    left.accountId === right.accountId &&
    left.provider === right.provider &&
    left.profileRevision === right.profileRevision
  );
}

function assertMatchingFingerprint(
  store: EventStore,
  request: ProviderDispatchRequest,
  existingFingerprint: string,
): void {
  if (existingFingerprint === fingerprintProviderDispatch(request)) return;
  const durableBinding = store.getSession(request.sessionId)?.accountBinding ?? undefined;
  const matchesSafeLegacyAdmission =
    !existingFingerprint.startsWith(PROVIDER_FINGERPRINT_VERSION) &&
    sameAccountBinding(durableBinding ?? undefined, request.accountBinding) &&
    (existingFingerprint === legacyProviderDispatchFingerprint(request) ||
      existingFingerprint === accountBoundProviderDispatchFingerprint(request));
  if (matchesSafeLegacyAdmission) return;
  throw new ExecutionAdmissionError(
    'fingerprint_conflict',
    'clientMsgId is already admitted for a different request fingerprint',
  );
}

function assertDispatchableAdmission(
  store: EventStore,
  admission: { token: ExecutionToken },
): void {
  const current = store.getSession(admission.token.sessionId);
  const isStillDispatchable =
    current?.executionId === admission.token.executionId &&
    current.executionGeneration === admission.token.generation &&
    current.executionPhase === 'RUNNING';
  if (!isStillDispatchable && store.getProviderAttempts(admission.token).length === 0) {
    throw new Error(
      'Admitted command failed before provider dispatch; retry with a new command ID',
    );
  }
}

/** Reject a conflicting retry before any runtime side effects occur. */
export function preflightProviderDispatch(
  store: EventStore,
  request: ProviderDispatchRequest,
): boolean {
  const existing = store.getExecutionAdmission(request.sessionId, request.clientMsgId);
  if (!existing) return false;
  assertMatchingFingerprint(store, request, existing.requestFingerprint);
  assertDispatchableAdmission(store, existing);
  return true;
}

/**
 * Durably admit one provider-bound command before preparing its runtime dispatch.
 * Exact retries reuse the original token and never invoke prepare again.
 */
export function admitProviderDispatch(options: {
  store: EventStore;
  request: ProviderDispatchRequest;
  prepare: () => void;
}): ProviderDispatchAdmission {
  const requestFingerprint = fingerprintProviderDispatch(options.request);
  const existing = options.store.getExecutionAdmission(
    options.request.sessionId,
    options.request.clientMsgId,
  );
  if (existing) {
    assertMatchingFingerprint(options.store, options.request, existing.requestFingerprint);
    assertDispatchableAdmission(options.store, existing);
    return {
      token: existing.token,
      providerAttemptId: `provider-${existing.token.executionId}`,
      requestFingerprint: existing.requestFingerprint,
      duplicate: true,
    };
  }
  let admission;
  try {
    admission = options.store.beginExecution(
      options.request.sessionId,
      undefined,
      options.request.clientMsgId,
      requestFingerprint,
    );
  } catch (error) {
    if (!(error instanceof ExecutionAdmissionError) || error.code !== 'fingerprint_conflict') {
      throw error;
    }
    const racedAdmission = options.store.getExecutionAdmission(
      options.request.sessionId,
      options.request.clientMsgId,
    );
    if (!racedAdmission) throw error;
    assertMatchingFingerprint(options.store, options.request, racedAdmission.requestFingerprint);
    assertDispatchableAdmission(options.store, racedAdmission);
    return {
      token: racedAdmission.token,
      providerAttemptId: `provider-${racedAdmission.token.executionId}`,
      requestFingerprint: racedAdmission.requestFingerprint,
      duplicate: true,
    };
  }
  const result = {
    token: admission.token,
    providerAttemptId: `provider-${admission.token.executionId}`,
    requestFingerprint,
    duplicate: admission.duplicate,
  };
  if (admission.duplicate) {
    assertDispatchableAdmission(options.store, admission);
    return result;
  }

  try {
    options.prepare();
  } catch (error) {
    options.store.transitionExecution(admission.token, 'TERMINAL', 'startup_failed');
    throw error;
  }
  return result;
}
