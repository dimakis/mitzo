import { z } from 'zod';

/** Display/telemetry evidence only. Never a receipt or permission to dispatch. */
export const CommandDeliveryDiagnosticSchema = z.strictObject({
  operation: z.enum(['submit', 'receipt']),
  stage: z.enum(['storage', 'request', 'response', 'handoff', 'cleanup']),
  code: z.enum([
    'storage_failed',
    'storage_timeout',
    'transport_failed',
    'timeout',
    'cancelled',
    'invalid_receipt',
    'receipt_pending',
    'http_rejected',
    'runtime_failed',
    'handoff_failed',
    'cleanup_failed',
  ]),
  httpStatus: z.number().int().min(100).max(599).optional(),
  startedAt: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  persistenceFailed: z.literal(true).optional(),
});
export type CommandDeliveryDiagnostic = z.infer<typeof CommandDeliveryDiagnosticSchema>;
export type CommandDeliveryDiagnosticEvent = {
  clientMsgId: string;
  sessionId?: string;
  diagnostic: CommandDeliveryDiagnostic;
};
export type CommandDeliveryObserver = (
  event: CommandDeliveryDiagnosticEvent,
  cause?: unknown,
) => void;

export function commandDeliveryMessage(diagnostic: CommandDeliveryDiagnostic): string {
  switch (diagnostic.code) {
    case 'storage_failed':
      return 'Could not finish saving this message. Keep this chat open and retry.';
    case 'storage_timeout':
      return 'Saving this message timed out. Keep this chat open and retry.';
    case 'handoff_failed':
      return 'Could not finish local delivery recovery. Keep this chat open and retry.';
    case 'timeout':
      return 'Delivery confirmation timed out. Retry checks the same message.';
    case 'transport_failed':
      return 'Could not confirm delivery over the connection. Retry checks the same message.';
    case 'cancelled':
      return 'Delivery confirmation was interrupted. Retry checks the same message.';
    case 'receipt_pending':
      return 'Delivery is still unconfirmed. Retry uses the same message.';
    case 'http_rejected':
      return 'The delivery request was refused. Check the connection and retry the same message.';
    default:
      return 'Delivery confirmation is unavailable. Retry checks the same message.';
  }
}

/** Shared composer copy for every durable outgoing-command state. */
export function localCommandStatusMessage(state: string): string | undefined {
  switch (state) {
    case 'consumed':
      return undefined;
    case 'pending':
      return 'Sending…';
    case 'blocked':
      return 'Saved outgoing messages are unavailable. Your drafts are kept. Retry checks device storage.';
    case 'uncertain':
    case 'reserved':
    case 'retained':
      return 'Delivery not confirmed.';
    default:
      return 'Message recovery is unavailable. Your draft is kept.';
  }
}
