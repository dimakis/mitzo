import {
  AgentCompiledBootContextSchema,
  AgentContextSnapshotSchema,
  AgentContextReceiptSchema,
  type AgentContextSnapshot,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';

export function bootContextWithReceipt(
  snapshot: AgentContextSnapshot,
  status: 'prepared' | 'accepted' = 'prepared',
) {
  const selected = AgentContextSnapshotSchema.parse(snapshot);
  return {
    ...selected.context,
    receipt: AgentContextReceiptSchema.parse({
      recipeHash: selected.recipeHash,
      compilerRevision: selected.compilerRevision,
      payloadHash: selected.payloadHash,
      provenance: selected.provenance,
      status,
      profileId: selected.profileId,
      profileRevision: selected.revision,
    }),
  };
}
/** Historical acceptance survives refresh only for the exact validated durable payload. */
export function bootContextWithRetainedReceipt(
  snapshot: AgentContextSnapshot,
  retainedBootContext?: string,
) {
  const prepared = bootContextWithReceipt(snapshot);
  if (!retainedBootContext) return prepared;
  try {
    const retained: unknown = JSON.parse(retainedBootContext);
    if (!retained || typeof retained !== 'object' || Array.isArray(retained)) return prepared;
    const { receipt, ...context } = retained as Record<string, unknown>;
    delete context.scope;
    const previousReceipt = AgentContextReceiptSchema.safeParse(receipt);
    const previousContext = AgentCompiledBootContextSchema.safeParse(context);
    const accepted = bootContextWithReceipt(snapshot, 'accepted');
    if (
      previousReceipt.success &&
      previousContext.success &&
      JSON.stringify(previousReceipt.data) === JSON.stringify(accepted.receipt) &&
      JSON.stringify(previousContext.data) ===
        JSON.stringify(AgentContextSnapshotSchema.parse(snapshot).context)
    )
      return accepted;
  } catch {
    // Invalid legacy metadata cannot establish acceptance of the current payload.
  }
  return prepared;
}

/** Provider-confirmed acknowledgement is distinct from compilation or selecting a publication. */
export function recordAgentContextAcceptance(input: {
  store: Pick<EventStore, 'getSession' | 'append' | 'upsertSession'>;
  sessionId: string;
  snapshot: AgentContextSnapshot;
  commandId: string;
  providerThreadId: string;
  providerTurnId: string;
  contextSha256: string;
}) {
  if (
    !input.commandId ||
    !input.providerThreadId ||
    !input.providerTurnId ||
    !/^[a-f0-9]{64}$/.test(input.contextSha256)
  )
    throw Error('Exact provider context acknowledgement is required');
  const stored = input.store.getSession(input.sessionId)?.agentContext;
  if (
    !stored ||
    JSON.stringify(AgentContextSnapshotSchema.parse(stored)) !==
      JSON.stringify(AgentContextSnapshotSchema.parse(input.snapshot))
  )
    throw Error('Provider context acknowledgement does not match the retained snapshot');
  const context = bootContextWithReceipt(input.snapshot, 'accepted');
  input.store.append(input.sessionId, 'agent_context_accepted', {
    commandId: input.commandId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    contextSha256: input.contextSha256,
    ...context.receipt,
  });
  input.store.upsertSession({ sessionId: input.sessionId, bootContext: JSON.stringify(context) });
  return context;
}
