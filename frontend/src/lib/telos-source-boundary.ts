import type { TelosSourcePacket } from '@mitzo/protocol';
import type { FinishedMessage } from '../types/chat';
/** Same exact message/provenance fence used by retained-source anchoring. */
export function matchesTelosSourceBoundary(message: FinishedMessage, packet: TelosSourcePacket) {
  const id = packet.context.boundary.messageId;
  if (!id || message.messageId !== id) return false;
  const attribution = packet.attributions[id];
  return (
    !!attribution &&
    (attribution.provenance === null
      ? !message.symposiumProvenance
      : message.symposiumProvenance?.seatId === attribution.provenance.seatId &&
        message.symposiumProvenance?.membershipGeneration ===
          attribution.provenance.membershipGeneration &&
        message.symposiumProvenance?.configRevision === attribution.provenance.configRevision)
  );
}
