import type { CapabilityService } from './service.js';
import type { CapabilityRequest } from './types.js';

/** Bind Codex tools to trusted startup lifecycle state; tools cannot select another identity. */
export function bindCapabilityExecution(
  service: CapabilityService,
  binding: { accountId: string; conversationId: string },
  approve?: Parameters<CapabilityService['invoke']>[2],
) {
  return (request: Omit<CapabilityRequest, 'accountId' | 'conversationId'>, signal: AbortSignal) =>
    service.invoke({ ...request, ...binding }, signal, approve);
}
