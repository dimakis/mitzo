import { z } from 'zod';
import {
  OrdinaryRuntimeFirstCommandSchema,
  OrdinaryRuntimeContinuationCommandSchema,
  OrdinaryWorkspaceFirstCommandSchema,
  LocalCodexFirstCommandSchema,
} from '@mitzo/protocol';

/** Local delivery metadata, never a wire grant. A prepared first command already has a session. */
export const OrdinaryCommandDeliverySchema = z
  .strictObject({
    version: z.literal(2),
    phase: z.enum(['first', 'continue']),
  })
  .or(
    z.strictObject({
      version: z.literal(1),
      phase: z.literal('first'),
      sessionId: z.string().min(1).max(200).regex(/^\S+$/),
    }),
  );
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
    const delivery = OrdinaryCommandDeliverySchema.parse(ordinaryDelivery);
    return delivery.version === 2
      ? OrdinaryWorkspaceFirstCommandSchema.parse(body)
      : LocalCodexFirstCommandSchema.parse(body);
  }
  return legacy.parse(body);
}

/** Conversation ownership survives prepared first commands and later receipt assignment. */
export function localCommandSessionId(
  body: unknown,
  preparedSessionId?: string,
): string | undefined {
  return body &&
    typeof body === 'object' &&
    'sessionId' in body &&
    typeof body.sessionId === 'string'
    ? body.sessionId
    : preparedSessionId;
}
