import { CollaborationContractError } from '@mitzo/protocol';

/** Fixed public explanation shared by joining review, capture and consultation.
 * Retained history and arbitrary exception messages never cross this boundary. */
export function collaborationSourceDiagnostic(cause: unknown) {
  if (
    cause instanceof CollaborationContractError &&
    cause.code === 'source_history_overlap_invalid'
  )
    return {
      code: cause.code,
      message:
        'The source history contains overlapping messages without valid steering provenance. Joining context cannot be verified. Keep the original request and report this diagnostic for source-history repair.',
    };
}
