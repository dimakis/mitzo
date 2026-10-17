import { z } from 'zod';
import {
  AgentTaskDefinitionSchema,
  AgentTaskIdSchema,
  AgentTaskRecordSchema,
  SaveAgentTaskSchema,
} from '@mitzo/protocol';
import type { ToolBlock } from './tool-status';
import { apiFetch } from './api-fetch';
const Id = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());
export const AgentTaskProposalIdentitySchema = z.strictObject({
  proposalId: Id,
  sessionId: Id,
  taskId: AgentTaskIdSchema,
  expectedRevision: SaveAgentTaskSchema.shape.expectedRevision,
});
export type AgentTaskProposalIdentity = z.infer<typeof AgentTaskProposalIdentitySchema>;
const Receipt = AgentTaskProposalIdentitySchema.omit({ sessionId: true }).extend({
  status: z.literal('awaiting_user_review'),
});
export const AgentTaskProposalSchema = AgentTaskProposalIdentitySchema.extend({
  kind: z.literal('task'),
  definition: AgentTaskDefinitionSchema,
  state: z.enum(['pending', 'saved', 'discarded']),
  createdAt: z.number().int().nonnegative(),
  savedTask: AgentTaskRecordSchema.nullable(),
});
export type TaskProposal = z.infer<typeof AgentTaskProposalSchema>;
/** A pointer from actual ordinary tool output; canonical owner reads remain authoritative. */
export function agentTaskProposalLink(
  block: ToolBlock,
  sessionId?: string,
): { identity: AgentTaskProposalIdentity; url: string } | null {
  if (
    !sessionId ||
    block.blockType !== 'tool_use' ||
    block.toolName !== 'AgentProposeTask' ||
    block.toolError ||
    !block.toolResult
  )
    return null;
  try {
    const receipt = Receipt.parse(JSON.parse(block.toolResult));
    const identity = AgentTaskProposalIdentitySchema.parse({
      proposalId: receipt.proposalId,
      sessionId,
      taskId: receipt.taskId,
      expectedRevision: receipt.expectedRevision,
    });
    const query = new URLSearchParams({
      proposal: identity.proposalId,
      session: identity.sessionId,
      task: identity.taskId,
      revision: String(identity.expectedRevision),
    });
    return { identity, url: `/agent-library?${query}` };
  } catch {
    return null;
  }
}
export function parseAgentTaskProposalLocation(
  query: URLSearchParams,
): AgentTaskProposalIdentity | null {
  const keys = ['proposal', 'session', 'task', 'revision'];
  if (keys.some((key) => query.getAll(key).length !== 1)) return null;
  const revision = query.get('revision')!;
  if (!/^(0|[1-9]\d*)$/.test(revision)) return null;
  const parsed = AgentTaskProposalIdentitySchema.safeParse({
    proposalId: query.get('proposal'),
    sessionId: query.get('session'),
    taskId: query.get('task'),
    expectedRevision: Number(revision),
  });
  return parsed.success ? parsed.data : null;
}
export async function loadAgentTaskProposal(
  identity: AgentTaskProposalIdentity,
  signal: AbortSignal,
): Promise<TaskProposal> {
  const selected = AgentTaskProposalIdentitySchema.parse(identity);
  const response = await apiFetch(
    `/api/symposium/profile-proposals?sessionId=${encodeURIComponent(selected.sessionId)}`,
    { signal },
  );
  signal.throwIfAborted();
  const body: unknown = await response.json();
  signal.throwIfAborted();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    throw Error(
      error.success
        ? error.data.error
        : 'Task review unavailable. Retry to load the original proposal.',
    );
  }
  const rows = z.array(z.unknown()).parse(body);
  const matching = rows.filter(
    (row) =>
      !!row &&
      typeof row === 'object' &&
      'proposalId' in row &&
      row.proposalId === selected.proposalId,
  );
  if (matching.length !== 1)
    throw Error('The original task proposal is unavailable. Your retained review is unchanged.');
  const proposal = AgentTaskProposalSchema.parse(matching[0]);
  if (
    proposal.sessionId !== selected.sessionId ||
    proposal.taskId !== selected.taskId ||
    proposal.expectedRevision !== selected.expectedRevision
  )
    throw Error(
      'Task proposal identity does not match this review. Your retained input is unchanged.',
    );
  return proposal;
}
