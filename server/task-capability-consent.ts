import type { SessionRegistry } from '@mitzo/harness';
import { captureSessionCapability, type CapabilityReceipt } from './session-capability-grants.js';
import type { TaskExecutionScope } from './task-execution-store.js';

/** Persist only locators. A child task must never outlive or replace its parent consent. */
export function captureTaskCapabilityConsent(registry: SessionRegistry, scope: TaskExecutionScope) {
  const inheritedGrants: NonNullable<TaskExecutionScope['inheritedGrants']> = [];
  const receipts: CapabilityReceipt[] = [];
  for (const member of scope.members) {
    const session = registry.findBySessionId(member.sessionId)?.session;
    if (!session) return;
    for (const capability of [
      { kind: 'development' } as const,
      ...scope.repositories.map((repository) => ({ kind: 'github-read' as const, repository })),
    ]) {
      const receipt = captureSessionCapability(session, capability);
      if (!receipt) return;
      receipt();
      inheritedGrants.push({ sessionId: member.sessionId, grantId: receipt.grantId, capability });
      receipts.push(receipt);
    }
  }
  return {
    inheritedGrants,
    expiresAt: Math.min(scope.expiresAt, ...receipts.map((r) => r.expiresAt)),
    assertCurrent: () => receipts.forEach((r) => r()),
  };
}
export function currentTaskCapabilityConsent(
  registry: SessionRegistry,
  scope: TaskExecutionScope,
  sessionId?: string,
) {
  const receipts = (scope.inheritedGrants ?? [])
    .filter((entry) => !sessionId || entry.sessionId === sessionId)
    .map((entry) => {
      const session = registry.findBySessionId(entry.sessionId)?.session;
      const receipt = session && captureSessionCapability(session, entry.capability, entry.grantId);
      if (!receipt) throw Error('Inherited task consent expired, revoked or changed');
      receipt();
      return receipt;
    });
  return {
    signal: AbortSignal.any(receipts.map((r) => r.signal)),
    assertCurrent: () => receipts.forEach((r) => r()),
  };
}
