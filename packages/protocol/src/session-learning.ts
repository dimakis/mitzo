import { z } from 'zod';

export const SessionLearningModeSchema = z.enum(['auto', 'deep', 'off']);
export type SessionLearningMode = z.infer<typeof SessionLearningModeSchema>;
const sequence = z.number().int().nonnegative().safe();
export const SessionLearningPolicySchema = z.strictObject({
  version: z.literal(1),
  mode: SessionLearningModeSchema,
  revision: sequence,
  /** Off revokes queued evidence through this watermark permanently. */
  excludedThroughSeq: sequence,
  historyRequest: z
    .strictObject({
      afterSeq: sequence,
      throughSeq: sequence,
      status: z.enum(['pending_worker', 'cancelled']),
    })
    .optional(),
});
export type SessionLearningPolicy = z.infer<typeof SessionLearningPolicySchema>;
export function parseSessionLearningPolicy(serialized?: string | null): SessionLearningPolicy {
  return SessionLearningPolicySchema.parse(
    serialized
      ? JSON.parse(serialized)
      : {
          version: 1,
          mode: 'auto',
          revision: 0,
          excludedThroughSeq: 0,
        },
  );
}
export const MemoryCandidateSourceSchema = z.strictObject({
  messageId: z.string().min(1).max(512),
  eventSeq: sequence.positive(),
});
export const MemoryCandidateInputSchema = z.strictObject({
  requestId: z.string().uuid(),
  sources: z.array(MemoryCandidateSourceSchema).min(1).max(20),
  kind: z.enum(['decision', 'correction', 'discovery', 'question']),
  attribution: z.enum(['user_statement', 'agent_interpretation', 'proposal', 'outcome']),
  text: z.string().trim().min(1).max(6000),
  rationale: z.string().trim().min(1).max(2000).optional(),
});
export interface MemoryCandidateReceipt {
  version: 1;
  requestId: string;
  sessionId: string;
  eventSeq: number;
  status: 'stored';
  knowledgeStatus: 'provisional';
  policyRevision: number;
}

/** Advisory only; the controller checks policy and source eligibility on capture. */
export function sessionLearningGuidance(policy: SessionLearningPolicy): string {
  if (policy.mode === 'off') return '';
  return `\n<session_learning mode="${policy.mode}">
At meaningful milestones, preserve significant decisions with rationale, explicit corrections, reusable discoveries and important unresolved questions using CaptureMemoryCandidate. Zero candidates is normal. After compaction, use the same sourced capture path; do not reconstruct missing source identifiers or rely on a clean closeout.
Use action "sources" for eligible public conversation message identifiers, then action "capture" with those exact identifiers and a stable requestId. Distinguish user statements, agent interpretations, proposals and outcomes. Candidates are provisional; plans are not completed outcomes. Never capture hidden reasoning, credentials or private tool payloads. Propose inferred profiles for discussion.
An explicit "remember this" needs a durable stored receipt before acknowledgment. Reuse the exact requestId and payload after interruption. A promise to remember is not storage. Capture does not enroll a source, account, processing model or audience and does not accept or publish knowledge. If the tool is unavailable or learning has been turned Off, explain that no capture was confirmed; do not enable it yourself. Ordinary capture needs no repetitive narration.
${policy.mode === 'deep' ? 'Deep learning records a pending request for earlier eligible history; the full analysis worker is not implemented by this foundation. Excluded history stays excluded.\n' : ''}</session_learning>\n`;
}
