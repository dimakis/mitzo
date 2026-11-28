import { SessionLaunchError } from './session-launch-store.js';
import { TelosAdoptionRefusal } from './telos-existing-chat-adoption.js';
import { TelosWorkError } from './telos-work-store.js';
import { createLogger } from './logger.js';

const log = createLogger('telos-session-proposal');

export type TelosSessionRefusalCode = TelosWorkError['code'];

/** A definite TelosCreateSession refusal raised by a read-only proposal check,
 * before any review presentation or proposal record is written. Only this type
 * may be reported with `effectStatus: not_started`; every other failure keeps
 * its uncertain recovery path. */
export class TelosSessionProposalRefusal extends SessionLaunchError {
  override readonly name = 'TelosSessionProposalRefusal';
  readonly stage = 'proposal_scope';
  readonly effectStatus = 'not_started';
  constructor(
    readonly code: TelosSessionRefusalCode,
    message: string,
    status: number,
    /** Named existing-chat adoption refusal, such as `existing_chat_busy`. */
    readonly reason?: string,
    options?: ErrorOptions,
  ) {
    super(message, status, options);
  }

  /** Classifies a known pre-write refusal. Unknown failures are returned as-is. */
  static from(error: unknown): unknown {
    if (error instanceof TelosSessionProposalRefusal || !(error instanceof SessionLaunchError))
      return error;
    const work = error.cause instanceof TelosWorkError ? error.cause : undefined;
    const code: TelosSessionRefusalCode =
      work?.code ??
      (error.status === 403 ? 'unauthorized' : error.status === 400 ? 'invalid' : 'conflict');
    const adoption = work instanceof TelosAdoptionRefusal ? work.startupBlocker : undefined;
    return new TelosSessionProposalRefusal(code, error.message, error.status, adoption, {
      cause: error,
    });
  }
}

const MAX_MESSAGE = 500;
/** Host-authored refusal text, bounded and stripped of control characters. */
function sanitized(message: string) {
  // eslint-disable-next-line no-control-regex
  const text = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

export function telosSessionRefusalPayload(
  refusal: TelosSessionProposalRefusal,
  identity: { requestId: string; sourceSessionId: string },
) {
  return {
    code: refusal.code,
    ...(refusal.reason ? { reason: refusal.reason } : {}),
    stage: refusal.stage,
    requestId: identity.requestId,
    sourceSessionId: identity.sourceSessionId,
    effectStatus: refusal.effectStatus,
    message: sanitized(refusal.message),
    recovery:
      'No proposal was saved. Resolve the reported condition before proposing again; retrying the same arguments will be refused again.',
  };
}

/** One observable refusal record per transport, then a model-visible result. */
export function reportTelosSessionRefusal(
  refusal: TelosSessionProposalRefusal,
  identity: { requestId: string; sourceSessionId: string },
) {
  const payload = telosSessionRefusalPayload(refusal, identity);
  log.warn('Telos session proposal refused', {
    stage: payload.stage,
    code: payload.code,
    ...(payload.reason ? { reason: payload.reason } : {}),
    requestId: payload.requestId,
    sourceSessionId: payload.sourceSessionId,
    effectStatus: payload.effectStatus,
    message: payload.message,
  });
  return payload;
}
