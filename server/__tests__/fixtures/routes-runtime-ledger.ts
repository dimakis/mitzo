import type { EventStore } from '../../event-store.js';
import { vi } from 'vitest';

type RoutesRuntimeLedger = Pick<
  EventStore,
  | 'getSessionRuntimeBinding'
  | 'getSendCommand'
  | 'getOrdinaryLocalCommandAdmission'
  | 'getOrdinaryWorkspaceSessionPreparationForConversation'
> & { deployment: { maintenance: Pick<EventStore['deployment']['maintenance'], 'assertControl'> } };

/** Legacy route fixtures start without a retained runtime or command receipt. */
export function createRoutesRuntimeLedgerFixture() {
  return {
    deployment: {
      maintenance: {
        assertControl: vi.fn<EventStore['deployment']['maintenance']['assertControl']>(),
      },
    },
    getOrdinaryWorkspaceSessionPreparationForConversation: vi
      .fn<EventStore['getOrdinaryWorkspaceSessionPreparationForConversation']>()
      .mockReturnValue(undefined),
    getSessionRuntimeBinding: vi.fn<EventStore['getSessionRuntimeBinding']>().mockReturnValue(null),
    getSendCommand: vi.fn<EventStore['getSendCommand']>().mockReturnValue(undefined),
    getOrdinaryLocalCommandAdmission: vi
      .fn<EventStore['getOrdinaryLocalCommandAdmission']>()
      .mockReturnValue(undefined),
  } satisfies RoutesRuntimeLedger;
}
