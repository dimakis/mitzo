import type { SessionTransport } from '@mitzo/harness';
import {
  SessionControlRejected,
  assertOrdinaryContributorControlAllowed,
} from './ordinary-contributor-execution.js';

/** The existing legacy router chooses the active driver first, then its explicit resume. */
export function routeLegacyChatSend<T>(
  store: Parameters<typeof assertOrdinaryContributorControlAllowed>[0],
  sessionId: string | undefined,
  route: () => T,
): T {
  if (sessionId) assertOrdinaryContributorControlAllowed(store, sessionId, 'send');
  return route();
}

/** Preserve the legacy asynchronous Send error contract without booting the server. */
export async function deliverLegacyChatMessage(
  transport: SessionTransport,
  send: () => boolean | Promise<boolean>,
  clientMsgId: string | undefined,
  report: (error: unknown) => void,
  reportDeliveryError: (error: unknown) => void = report,
): Promise<boolean | undefined> {
  try {
    return await send();
  } catch (error) {
    report(error);
    try {
      transport.send(
        error instanceof SessionControlRejected
          ? error.toMessage(clientMsgId)
          : { type: 'error', error: error instanceof Error ? error.message : 'Send failed' },
      );
    } catch (deliveryError) {
      reportDeliveryError(deliveryError);
    }
  }
}
