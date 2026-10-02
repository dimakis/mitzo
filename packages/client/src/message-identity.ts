import type { SymposiumProvenance } from '@mitzo/protocol';

/** Provider message IDs are local to a seat's membership generation. */
export function messageIdentity(messageId: string, provenance?: SymposiumProvenance): string {
  return provenance
    ? JSON.stringify([provenance.seatId, provenance.membershipGeneration ?? null, messageId])
    : JSON.stringify([null, null, messageId]);
}
