import type { EventStore } from '../../event-store.js';
import { vi } from 'vitest';

type RoutesRuntimeLedger = Pick<
  EventStore,
  'getSessionRuntimeBinding' | 'getSendCommand' | 'getOrdinaryLocalCommandAdmission'
>;

/** Legacy route fixtures start without a retained runtime or command receipt. */
export function createRoutesRuntimeLedgerFixture() {
  return {
    getSessionRuntimeBinding: vi.fn<EventStore['getSessionRuntimeBinding']>().mockReturnValue(null),
    getSendCommand: vi.fn<EventStore['getSendCommand']>().mockReturnValue(undefined),
    getOrdinaryLocalCommandAdmission: vi
      .fn<EventStore['getOrdinaryLocalCommandAdmission']>()
      .mockReturnValue(undefined),
  } satisfies RoutesRuntimeLedger;
}
