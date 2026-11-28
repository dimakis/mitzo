import { CollaborationContractError } from '@mitzo/protocol';

const SOURCE_DIAGNOSTICS = {
  source_history_overlap_invalid:
    'The source history contains overlapping messages without valid steering provenance. Joining context cannot be verified. Keep the original request and report this diagnostic for source-history repair.',
  source_initial_command_unverified:
    "The source conversation's first command could not be matched to its first visible message, so its history cannot be verified and was not shared. Keep the original request and report this diagnostic for source-history repair.",
} as const;

/** Fixed public explanation shared by joining review, capture and consultation.
 * Retained history and arbitrary exception messages never cross this boundary. */
export function collaborationSourceDiagnostic(cause: unknown) {
  if (
    !(cause instanceof CollaborationContractError) ||
    !Object.hasOwn(SOURCE_DIAGNOSTICS, cause.code)
  )
    return undefined;
  const code = cause.code as keyof typeof SOURCE_DIAGNOSTICS;
  return { code, message: SOURCE_DIAGNOSTICS[code] };
}
