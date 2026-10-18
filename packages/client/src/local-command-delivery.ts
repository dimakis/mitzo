import { z } from 'zod';
import {
  OrdinaryRuntimeFirstCommandSchema,
  OrdinaryRuntimeContinuationCommandSchema,
  OrdinaryWorkspaceFirstCommandSchema,
} from '@mitzo/protocol';

/** Local delivery metadata, never a wire grant. A prepared first command already has a session. */
export const OrdinaryCommandDeliverySchema = z.strictObject({
  version: z.literal(2),
  phase: z.enum(['first', 'continue']),
});
export type OrdinaryCommandDelivery = z.infer<typeof OrdinaryCommandDeliverySchema>;
export type OrdinaryCommandPhase = OrdinaryCommandDelivery['phase'];
const legacy = OrdinaryRuntimeFirstCommandSchema.or(OrdinaryRuntimeContinuationCommandSchema);
export type LocalCommandRequest =
  z.infer<typeof legacy> | z.infer<typeof OrdinaryWorkspaceFirstCommandSchema>;
export function parseLocalCommandDelivery(
  body: unknown,
  ordinaryDelivery?: unknown,
): LocalCommandRequest {
  if (ordinaryDelivery !== undefined) {
    OrdinaryCommandDeliverySchema.parse(ordinaryDelivery);
    return OrdinaryWorkspaceFirstCommandSchema.parse(body);
  }
  return legacy.parse(body);
}
