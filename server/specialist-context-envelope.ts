import { z } from 'zod';
import {
  CollaborationSnapshotDraftSchema,
  type CollaborationSnapshotSelection,
} from '@mitzo/protocol';
import type { ConsultationInput } from './specialist-consultation-contract.js';
import { snapshotMaterial } from './collaboration-context-input.js';

export const SpecialistContextEnvelopeSchema = z
  .strictObject({
    version: z.literal(1),
    draft: CollaborationSnapshotDraftSchema,
    assignment: z.string(),
    reviewContribution: z.string(),
    text: z.string(),
  })
  .refine(
    (value) => value.text === value.assignment + value.reviewContribution,
    'Context text changed',
  );
export type SpecialistContextEnvelope = z.infer<typeof SpecialistContextEnvelopeSchema>;

/** Only generated assignment copies are removed. Source text, pins, attribution
 * and review evidence are never searched, shortened or rewritten. Joining alone
 * starts no inference; the complete assignment arrives with the explicit reply. */
export function specialistContextSelection(
  input: ConsultationInput,
  sourceConversationId: string,
  boundary: CollaborationSnapshotSelection['boundary'],
  expectedMembershipRevision: number,
): CollaborationSnapshotSelection {
  return {
    requestId: input.requestId,
    expectedMembershipRevision,
    sourceConversationId,
    boundary,
    mode: 'selected',
    messageIds: input.messageIds,
    artifacts: input.artifacts,
    purpose: `Specialist consultation: ${input.role}`,
    joiningBrief: 'Use this selected evidence for the assignment in the explicit requested reply.',
  };
}

export function buildSpecialistContextEnvelope(
  draft: SpecialistContextEnvelope['draft'],
  input: ConsultationInput,
  contributions?: readonly unknown[],
): SpecialistContextEnvelope {
  if (input.reviewOf && !contributions?.length)
    throw Error('Independent review requires a completed attributed contribution');
  const reviewContribution = input.reviewOf
    ? '\n\nIndependent review of attributed contribution:\n' +
      JSON.stringify({ requestId: input.reviewOf, contributions })
    : '';
  return {
    version: 1,
    draft: structuredClone(draft),
    assignment: input.assignment,
    reviewContribution,
    text: input.assignment + reviewContribution,
  };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const stringBytes = (value: string) => bytes(value) - 2;
/** Exact UTF-8 accounting of the complete selected-context envelope, including
 * JSON escaping, encoded artifact content, attribution and framing. This is the
 * policy's selected-context ceiling, not native model/token capacity: ordinary
 * boot instructions, tools and delivery framing retain their separate owners. */
export function measureSpecialistContextEnvelope(
  envelope: SpecialistContextEnvelope,
  limitBytes: number,
) {
  const context = snapshotMaterial(envelope.draft);
  const totalBytes = bytes({ context, text: envelope.text });
  const material = {
    sourceMetadata:
      bytes(context.sourceConversationId) + bytes(context.boundary) + bytes(context.summary),
    purpose: stringBytes(context.purpose),
    joiningBrief: stringBytes(context.joiningBrief),
    messages: bytes(context.messages),
    artifacts: bytes(context.artifacts),
    assignment: stringBytes(envelope.assignment),
    reviewContribution: stringBytes(envelope.reviewContribution),
  };
  return {
    version: 1 as const,
    encoding: 'utf8' as const,
    scope: 'specialist_selected_context' as const,
    limitBytes,
    totalBytes,
    excessBytes: Math.max(0, totalBytes - limitBytes),
    components: {
      ...material,
      framing: totalBytes - Object.values(material).reduce((sum, n) => sum + n, 0),
    },
    messages: context.messages.map((m) => ({ messageId: m.messageId, bytes: bytes(m) })),
    artifacts: context.artifacts.map((a) => ({
      artifactId: a.artifactId,
      revision: a.revision,
      bytes: bytes(a),
      contentBytes: a.sizeBytes,
    })),
  };
}
export type SpecialistContextReport = ReturnType<typeof measureSpecialistContextEnvelope>;

export class SpecialistContextLimitError extends Error {
  readonly code = 'context_limit';
  readonly outcome: 'not_started' | 'existing_request';
  constructor(
    readonly report: SpecialistContextReport,
    noStart: boolean,
  ) {
    super(
      `Selected context is ${report.totalBytes} bytes, exceeding the approved ${report.limitBytes}-byte limit by ${report.excessBytes} bytes. Narrow the assignment or explicitly select less evidence; nothing was truncated.`,
    );
    this.outcome = noStart ? 'not_started' : 'existing_request';
  }
}
export function assertSpecialistContextLimit(
  envelope: SpecialistContextEnvelope,
  limit: number,
  noStart: boolean,
) {
  const report = measureSpecialistContextEnvelope(envelope, limit);
  if (report.excessBytes) throw new SpecialistContextLimitError(report, noStart);
  return report;
}
