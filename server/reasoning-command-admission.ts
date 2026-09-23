import {
  deliberateSessionId,
  isDeliberationSessionId,
  parseDeliberationInput,
} from './deliberate-admission.js';
import { fusionSessionId, isFusionSessionId, parseFusionInput } from './fusion-admission.js';

/** Usage-only commands must not enter paid admission. */
export function paidReasoningCommand(name: string, args: string): boolean {
  return name === 'deliberate'
    ? !!parseDeliberationInput(args).task
    : name === 'fuse' && !!parseFusionInput(args).task;
}

export function reasoningSessionId(name: string, clientMsgId: string): string {
  return name === 'fuse' ? fusionSessionId(clientMsgId) : deliberateSessionId(clientMsgId);
}

export function isReasoningSessionId(sessionId: string): boolean {
  return isDeliberationSessionId(sessionId) || isFusionSessionId(sessionId);
}
