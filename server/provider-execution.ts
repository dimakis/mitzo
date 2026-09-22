import { createHash } from 'node:crypto';
import type { ExecutionToken } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';

export interface ProviderDispatchRequest {
  sessionId: string;
  clientMsgId: string;
  effectivePrompt: string;
  fingerprintSource?: string;
  model?: string;
  reasoningEffort?: string | null;
}

export interface ProviderDispatchAdmission {
  token: ExecutionToken;
  providerAttemptId: string;
  requestFingerprint: string;
  duplicate: boolean;
}

function fingerprintProviderDispatch(request: ProviderDispatchRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        effectivePrompt: request.fingerprintSource ?? request.effectivePrompt,
        model: request.model ?? null,
        reasoningEffort: request.reasoningEffort ?? null,
      }),
    )
    .digest('base64url');
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
  const admission = options.store.beginExecution(
    options.request.sessionId,
    undefined,
    options.request.clientMsgId,
    requestFingerprint,
  );
  const result = {
    token: admission.token,
    providerAttemptId: `provider-${admission.token.executionId}`,
    requestFingerprint,
    duplicate: admission.duplicate,
  };
  if (admission.duplicate) {
    const current = options.store.getSession(admission.token.sessionId);
    const isStillDispatchable =
      current?.executionId === admission.token.executionId &&
      current.executionGeneration === admission.token.generation &&
      current.executionPhase === 'RUNNING';
    if (!isStillDispatchable && options.store.getProviderAttempts(admission.token).length === 0) {
      throw new Error(
        'Admitted command failed before provider dispatch; retry with a new command ID',
      );
    }
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
