import { createLogger } from './logger.js';
import type { RetainedSessionLaunch } from './session-launch-store.js';

const log = createLogger('session-launch');
// Bounded internal causes for controller diagnostics. Never serialize these in
// receipts or logs: provider/storage exceptions may contain private payloads.
const causes = new Map<string, Error>();
export function sessionLaunchFailureCause(proposalId: string): Error | undefined {
  return causes.get(proposalId);
}
export function recordSessionLaunchFailure(
  record: RetainedSessionLaunch,
  stage: 'preflight' | 'start' | 'resume',
  cause: unknown,
) {
  const code = `session_launch_${stage}_failed`;
  causes.delete(record.proposalId);
  causes.set(record.proposalId, new Error(code, { cause }));
  while (causes.size > 32) causes.delete(causes.keys().next().value!);
  log.error('Session launch failed', {
    code,
    stage,
    proposalId: record.proposalId,
    requestId: record.requestId,
    sourceSessionId: record.sourceSessionId,
    childSessionId: record.childSessionId,
    commandId: record.commandId,
  });
}
