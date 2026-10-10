import type { EventStore } from '@mitzo/protocol/event-store';
import type { SessionOutputReference, SessionOutputCandidate } from '@mitzo/protocol';

/** Existing session authorization applies to every call; billing accounts never confer ownership.
 * This reference-only service does not copy content into Telos or grant contributor access. */
export class SessionOutputReferences {
  constructor(private readonly store: EventStore) {}
  list(sessionId: string): {
    outputs: SessionOutputReference[];
    candidates: SessionOutputCandidate[];
  } {
    return {
      outputs: this.store.listSessionOutputs(sessionId),
      candidates: this.store.listSessionOutputCandidates(sessionId),
    };
  }
  register(sessionId: string, input: unknown): SessionOutputReference {
    return this.store.registerSessionOutput(sessionId, input);
  }
  read(sessionId: string, outputId: string): { output: SessionOutputReference; content: string } {
    return this.store.readSessionOutput(sessionId, outputId);
  }
}
