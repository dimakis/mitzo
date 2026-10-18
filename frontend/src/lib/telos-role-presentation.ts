import {
  TelosWorkRoleContextReviewSchema,
  type TelosWorkRoleContextSelection,
} from '@mitzo/protocol';
import { sha256Hex } from './browser-crypto';

/** Verify exact full selection and retained display bytes; never fetch replacements. */
export function readTelosRolePresentation(
  selection: TelosWorkRoleContextSelection,
  presentation: unknown,
  presentationRef: unknown,
) {
  const value = TelosWorkRoleContextReviewSchema.parse({
    version: 1,
    selection,
    presentation,
    presentationRef,
  });
  if (
    value.presentation.contextSha256 !== sha256Hex(JSON.stringify(value.selection)) ||
    value.presentationRef.sha256 !== sha256Hex(JSON.stringify(value.presentation))
  )
    throw new Error('Reviewed context labels unavailable');
  return value.presentation;
}
