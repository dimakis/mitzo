import { z } from 'zod';
const id = z.string().min(1).max(200).regex(/^\S+$/);
/** Host-private SDK evidence. These identities never grant access or execution. */
export const OrdinarySdkTurnAcceptedSchema = z.strictObject({
  version: z.literal(1),
  commandId: id,
  providerThreadId: id,
  providerTurnId: id,
  executionFingerprint: z.string().min(1).max(256),
});
export const OrdinarySdkTurnSettledSchema = OrdinarySdkTurnAcceptedSchema.extend({
  status: z.enum(['completed', 'failed', 'interrupted']),
});
export const OrdinarySdkInterruptTargetSchema = OrdinarySdkTurnAcceptedSchema.extend({
  execution: z.strictObject({
    sessionId: id,
    executionId: id,
    generation: z.number().int().nonnegative(),
  }),
});
export const OrdinarySdkInterruptReceiptSchema = z.strictObject({
  version: z.literal(1),
  requestId: id,
  target: OrdinarySdkInterruptTargetSchema,
});
export type OrdinarySdkInterruptTarget = z.infer<typeof OrdinarySdkInterruptTargetSchema>;
/** Trusted in-process observers only. Never decoded from HTTP or WebSocket. */
export interface OrdinaryTurnLifecycle {
  beforeDispatch(commandId: string): void;
  accepted(commandId: string, providerThreadId: string, providerTurnId: string): void;
  terminal(
    commandId: string,
    providerTurnId: string,
    status: 'completed' | 'interrupted' | 'failed',
  ): void;
  environmentPending?(commandId: string, providerTurnId: string): void;
  terminalConflict?(commandId: string, providerTurnId: string): void;
}
