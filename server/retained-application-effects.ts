import { z } from 'zod';
import {
  AgentMessageSendSchema,
  TelosManageItemInputSchema,
  type AccountBinding,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { getTelosMainPublicationRuntime } from './telos-main-publication-runtime.js';
import { historicalFailureEvidenceHash } from './historical-task-failure-evidence.js';
import {
  reviewedHistoricalTelosEdits,
  reviewedHistoricalTelosSources,
} from './historical-telos-edit-manifest.js';
import {
  retainedNativeEffectEvidence,
  type RetainedHostResultObserver,
} from './retained-native-effect-evidence.js';
const Send = AgentMessageSendSchema.extend({ operation: z.literal('send') });
const telosIncidents = new Set(reviewedHistoricalTelosEdits);
/** An original send reserves durably before every steering/admission effect.
 * Missing reservation is no dispatch, never proof of delivery or permission to retry. */
export function hasUnsentRetainedAgentMessage(
  events: EventStore,
  id: string,
  raw: unknown,
  current: () => void,
): boolean {
  current();
  const input = Send.safeParse(raw);
  if (!input.success) return false;
  const absent = !events.agentCommunication.findRequest(id, input.data.requestId);
  current();
  return absent;
}
export function retainedApplicationEffectObserver(
  events: EventStore,
  id: string,
  binding: AccountBinding,
  current: () => void,
): RetainedHostResultObserver {
  return (call, result, evidence) => {
    current();
    if (!result.isError) return false;
    if (call.toolName === 'AgentCommunication')
      return hasUnsentRetainedAgentMessage(events, id, call.arguments, current);
    if (call.toolName !== 'TelosManageItem') return false;
    const parsed = TelosManageItemInputSchema.safeParse(call.arguments);
    if (!parsed.success || parsed.data.operation !== 'edit') return false;
    const input = parsed.data;
    const runtime = getTelosMainPublicationRuntime();
    if (!runtime) return false;
    const observed = runtime.observeRetainedEdit(
      events,
      input.itemId,
      id,
      input.requestId,
      current,
    );
    if (!observed.itemExists || observed.updateReceipt !== null) return false;
    const payload = {
      version: 'mitzo-historical-telos-edit-failure-v1',
      kind: 'no_committed_telos_edit',
      ...retainedNativeEffectEvidence(
        id,
        binding,
        evidence(),
        call.toolName,
        result,
        reviewedHistoricalTelosSources,
      ),
      canonicalDatabaseIdentity: observed.canonicalDatabaseIdentity,
      updateObservation: {
        sessionId: id,
        requestId: input.requestId,
        itemId: input.itemId,
        updateReceipt: null,
        itemExists: true,
      },
    };
    current();
    return telosIncidents.has(historicalFailureEvidenceHash(payload));
  };
}
